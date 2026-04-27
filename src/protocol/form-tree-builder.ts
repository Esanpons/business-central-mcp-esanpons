// src/protocol/form-tree-builder.ts
//
// Builds a FormNode tree from a raw BC `lf` JSON node. Replaces parseControlTree.
//
// Wire-level PageType ordinals come from decompiled
// Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs. Field type strings
// (sc/dc/bc/...) are emitted by Microsoft.Dynamics.Framework.UI.Client.LogicalControlSerializer.

import type {
  FormNode, LogicalFormNode, GroupNode, UnknownNode, NodeProperties,
} from './form-node.js';
import type { PageType } from './types.js';

const PAGE_TYPE_MAP: Record<number, PageType> = {
  0: 'Card', 1: 'List', 2: 'RoleCenter', 3: 'CardPart', 4: 'ListPart',
  5: 'Document', 6: 'Worksheet', 7: 'ListPlus', 8: 'ConfirmationDialog',
  9: 'NavigatePage', 10: 'StandardDialog', 11: 'API', 12: 'HeadlinePart',
  13: 'ReportPreview', 14: 'ReportProcessingOnly', 15: 'XmlPort',
  16: 'ReportViewer', 17: 'FilterPage', 18: 'ListQuery', 19: 'BannerPart',
  20: 'PromptDialog', 21: 'ConfigurationDialog', 22: 'UserControlHost',
};

export function buildFormTree(raw: unknown): FormNode {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`buildFormTree: expected an lf object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const t = obj.t as string | undefined;
  if (t !== 'lf') {
    throw new Error(`buildFormTree: expected lf root, got t=${JSON.stringify(t)}`);
  }
  return buildLogicalForm(obj);
}

function buildLogicalForm(obj: Record<string, unknown>): LogicalFormNode {
  const props = readProperties(obj);
  const children = buildChildren(obj.Children, 'server:', false);
  const metadata = metadataOf(obj);
  return {
    type: 'lf',
    controlPath: 'server:',
    serverId: (obj.ServerId as string) ?? '',
    pageType: pageTypeOf(obj),
    properties: props,
    children,
    ...(metadata ? { metadata } : {}),
  };
}

function pageTypeOf(obj: Record<string, unknown>): PageType {
  const n = obj.PageType as number | undefined;
  if (typeof n === 'number' && n in PAGE_TYPE_MAP) return PAGE_TYPE_MAP[n]!;
  return 'Unknown';
}

function metadataOf(obj: Record<string, unknown>): { id: number; sourceTableId: number } | undefined {
  const m = obj.Metadata as Record<string, unknown> | undefined;
  if (!m) return undefined;
  return {
    id: (m.id as number) ?? 0,
    sourceTableId: (m.sourceTableId as number) ?? 0,
  };
}

function buildChildren(rawChildren: unknown, parentPath: string, insideRepeater: boolean): FormNode[] {
  if (!Array.isArray(rawChildren)) return [];
  const result: FormNode[] = [];
  for (let i = 0; i < rawChildren.length; i++) {
    const child = rawChildren[i];
    if (!child || typeof child !== 'object') continue;
    const sep = parentPath === 'server:' ? '' : '/';
    const path = `${parentPath}${sep}c[${i}]`;
    result.push(buildNode(child as Record<string, unknown>, path, insideRepeater));
  }
  return result;
}

function buildNode(obj: Record<string, unknown>, controlPath: string, insideRepeater: boolean): FormNode {
  const t = obj.t as string | undefined;
  if (!t) return makeUnknown(controlPath, '', readProperties(obj));

  if (t === 'gc') return buildGroup(obj, controlPath, insideRepeater);
  // Other types implemented in later tasks.
  return makeUnknown(controlPath, t, readProperties(obj), buildChildren(obj.Children, controlPath, insideRepeater));
}

function buildGroup(obj: Record<string, unknown>, controlPath: string, insideRepeater: boolean): GroupNode {
  return {
    type: 'gc',
    controlPath,
    properties: readProperties(obj),
    children: buildChildren(obj.Children, controlPath, insideRepeater),
  };
}

function makeUnknown(controlPath: string, type: string, properties: NodeProperties, children: FormNode[] = []): UnknownNode {
  return { __unknown: true, type, controlPath, properties, children };
}

function readProperties(obj: Record<string, unknown>): NodeProperties {
  const p: Record<string, unknown> = {};
  if (typeof obj.Caption === 'string') p.caption = obj.Caption;
  if (typeof obj.Visible === 'boolean') p.visible = obj.Visible;
  if (typeof obj.Editable === 'boolean') p.editable = obj.Editable;
  if (typeof obj.Enabled === 'boolean') p.enabled = obj.Enabled;
  if (obj.StringValue != null) p.stringValue = String(obj.StringValue);
  if ('ObjectValue' in obj) p.objectValue = obj.ObjectValue;
  if (typeof obj.ShowCaption === 'boolean') p.showCaption = obj.ShowCaption;
  if (obj.ShowMandatory === true) p.showMandatory = true;
  if (typeof obj.MappingHint === 'string') p.mappingHint = obj.MappingHint;
  if (typeof obj.DesignName === 'string') p.designName = obj.DesignName;
  if (typeof obj.ControlIdentifier === 'string') p.controlIdentifier = obj.ControlIdentifier;
  if (typeof obj.TotalRowCount === 'number') p.totalRowCount = obj.TotalRowCount;
  if (typeof obj.Bookmark === 'string') p.bookmark = obj.Bookmark;
  if (typeof obj.HasFiltersApplied === 'boolean') p.hasFiltersApplied = obj.HasFiltersApplied;
  return p as NodeProperties;
}
