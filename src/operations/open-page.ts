import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { resolveSection, type ResolvedSection } from '../protocol/section-resolver.js';
import { mapRowCellKeys } from '../services/data-service.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import { fields as treeFields, actions as treeActions, groupVisibility as treeGroupVisibility } from '../protocol/form-views.js';
import { type ActionNode } from '../protocol/form-node.js';

export interface OpenPageInput {
  pageId: string;
  bookmark?: string;
  tenantId?: string;
}

export interface OpenPageOutput {
  pageContextId: string;
  pageType: string;
  caption: string;
  /** True when the page opened as a modal (wizard, request page, confirmation). */
  isModal: boolean;
  fields: Array<{ name: string; value?: string; editable: boolean; type: string }>;
  actions: Array<{
    name: string;
    systemAction: number;
    enabled: boolean;
    /** Set on NavigatePage actions; lets the caller drive the wizard without knowing controlPath. */
    wizardNav?: 'back' | 'next' | 'finish' | 'cancel';
  }>;
  rows?: Array<{ bookmark: string; cells: Record<string, unknown> }>;
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

export class OpenPageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: OpenPageInput): Promise<Result<OpenPageOutput, ProtocolError>> {
    const result = await this.pageService.openPage(input.pageId, {
      bookmark: input.bookmark,
      tenantId: input.tenantId,
    });

    return mapResult(result, (ctx) => {
      const resolved = resolveSection(ctx, 'header');
      const form = 'error' in resolved ? undefined : resolved.form;
      const repeater = 'error' in resolved ? null : resolved.repeater;

      const root = form?.root;
      const groupVis = root ? treeGroupVisibility(root) : new Map<string, boolean>();
      const ws = ctx.wizardState;
      const fieldList = root ? treeFields(root) : [];
      const actionList = root ? treeActions(root) : [];

      return {
        pageContextId: ctx.pageContextId,
        pageType: ctx.pageType,
        caption: ctx.caption || ctx.rootFormId,
        isModal: ctx.isModal,
        fields: fieldList
          .filter(f => f.properties.caption && root && isEffectivelyVisible(root, f.controlPath, groupVis, ws))
          .map(f => ({
            name: f.properties.caption!,
            value: f.properties.stringValue,
            editable: f.properties.editable ?? false,
            type: f.type,
          })),
        actions: actionList
          .filter(a => (a.properties.enabled ?? true) && a.properties.caption && root && isEffectivelyVisible(root, a.controlPath, groupVis, ws))
          .map(a => {
            const wn = classifyWizardNav(a);
            return {
              name: a.properties.caption!,
              systemAction: a.systemAction,
              enabled: a.properties.enabled ?? true,
              ...(wn ? { wizardNav: wn } : {}),
            };
          }),
        // TODO(tier-2/T25): replace adapter with direct tree-node reads
        rows: repeater ? mapRowCellKeys(
          [...(resolved as ResolvedSection).rows],
          repeater.columns.map(c => ({
            controlPath: c.controlPath,
            caption: c.properties.caption ?? '',
            type: 'rcc' as const,
            columnBinderName: c.columnBinder?.name,
            columnBinderPath: c.columnBinder?.path,
          })),
        ).map(r => ({ bookmark: r.bookmark, cells: r.cells })) : undefined,
      };
    });
  }
}
