// src/protocol/section-dto.ts
//
// MCP output DTO for a single page section. A page is a flat list of sections;
// each section is one of: header (the root form's primary content),
// lines (the document's lines repeater), factbox (a CardPart attached as a
// FactBox), subpage (any other embedded part), requestPage (a report's
// request-page modal). Internal code reads FieldNode/ActionNode via
// form-views.ts; this DTO is the shape exposed to MCP callers.

import type { SectionKind } from './section-resolver.js';
import type { FieldType } from './form-node.js';
import type { RepeaterRow } from './types.js';
import { resolveSection } from './section-resolver.js';
import {
  fields as treeFields,
  actions as treeActions,
  groupVisibility as treeGroupVisibility,
} from './form-views.js';
import { isEffectivelyVisible } from './visibility.js';
import { mapRowCellKeys } from '../services/data-service.js';
import type { ActionNode } from './form-node.js';
import type { PageContext } from './page-context.js';

export interface SectionField {
  /** Field caption as shown in the BC client. Display label only. */
  readonly name: string;
  /** Display string. Undefined for fields that have no string projection (e.g. boolean tristate). */
  readonly value?: string;
  readonly editable: boolean;
  /** Wire-level BC field type. See FieldType union in protocol/form-node.ts. */
  readonly type: FieldType;
  /** True if BC marked the field as mandatory. */
  readonly showMandatory?: boolean;
  /** True if the field has an AssistEdit/Lookup action attached. */
  readonly isLookup?: boolean;
}

export interface SectionAction {
  /** Action caption as shown in the BC client. */
  readonly name: string;
  /** SystemAction ordinal. See SystemAction enum in protocol/types.ts. 0 = no system role (custom AL action). */
  readonly systemAction: number;
  /** True if BC marks the action as currently invokable. */
  readonly enabled: boolean;
  /** Wizard role on a NavigatePage / StandardDialog. */
  readonly wizardNav?: 'back' | 'next' | 'finish' | 'cancel';
}

/**
 * Row inside a list-shape Section. Identical to the internal `RepeaterRow`
 * type — cells keyed by `columnBinderName` (e.g. "1165569367_c2"), not by
 * caption.
 */
export type SectionRow = RepeaterRow;

export interface Section {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  /**
   * Card-shape sections (header, factbox, requestPage, most subpages) carry
   * `fields[]` populated with visible, captioned fields.
   */
  readonly fields?: readonly SectionField[];
  /**
   * List-shape sections (lines, list-bodied subpages) carry `rows[]`.
   * `totalRowCount` reflects BC's TotalRowCount property; null when unknown.
   */
  readonly rows?: readonly SectionRow[];
  readonly totalRowCount?: number | null;
  readonly actions?: readonly SectionAction[];
}

function classifyWizardNav(a: ActionNode): 'back' | 'next' | 'finish' | 'cancel' | undefined {
  const id = a.iconIdentifier;
  if (id) {
    if (/PreviousRecord/i.test(id)) return 'back';
    if (/NextRecord|Action_Start/i.test(id)) return 'next';
    if (/Approve/i.test(id)) return 'finish';
  }
  if (a.systemAction === 310 || a.systemAction === 320 || a.systemAction === 350) return 'cancel';
  return undefined;
}

/**
 * Build the Section DTO for `sectionId` in `ctx`. Returns `null` when the
 * sectionId is unknown or the section has been invalidated.
 *
 * Card-shape sections emit `fields[]` (and `actions[]` for header sections);
 * list-shape sections emit `rows[]` and `totalRowCount`. Header sections
 * always include `actions[]` because actions are reachable only from the root
 * form.
 */
export function buildSection(ctx: PageContext, sectionId: string): Section | null {
  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved) return null;
  const { section, form, repeater, rows } = resolved;

  const isHeader = section.kind === 'header';
  const isList = !!repeater;

  const root = form.root;
  const groupVis = treeGroupVisibility(root);
  const ws = ctx.wizardState;

  const out: {
    sectionId: string;
    kind: typeof section.kind;
    caption: string;
    fields?: SectionField[];
    rows?: SectionRow[];
    totalRowCount?: number | null;
    actions?: SectionAction[];
  } = {
    sectionId: section.sectionId,
    kind: section.kind,
    caption: section.caption,
  };

  if (isList && repeater) {
    out.rows = mapRowCellKeys(
      [...rows],
      repeater.columns.map(c => ({
        controlPath: c.controlPath,
        caption: c.properties.caption ?? '',
        type: 'rcc' as const,
        columnBinderName: c.columnBinder?.name,
        columnBinderPath: c.columnBinder?.path,
      })),
    ).map(r => ({ bookmark: r.bookmark, cells: r.cells }));
    out.totalRowCount = repeater.properties.totalRowCount ?? null;
  } else {
    out.fields = treeFields(root)
      .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, ws))
      .map(f => ({
        name: f.properties.caption!,
        value: f.properties.stringValue,
        editable: f.properties.editable ?? false,
        type: f.type,
        ...(f.properties.showMandatory ? { showMandatory: true as const } : {}),
        ...(f.hasLookup ? { isLookup: true as const } : {}),
      }));
  }

  if (isHeader) {
    out.actions = treeActions(root)
      .filter(a => (a.properties.enabled ?? true) && a.properties.caption
        && isEffectivelyVisible(root, a.controlPath, groupVis, ws))
      .map(a => {
        const wn = classifyWizardNav(a);
        return {
          name: a.properties.caption!,
          systemAction: a.systemAction,
          enabled: a.properties.enabled ?? true,
          ...(wn ? { wizardNav: wn } : {}),
        };
      });
  }

  return out as Section;
}
