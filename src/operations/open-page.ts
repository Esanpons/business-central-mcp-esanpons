import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { mapRowCellKeys } from '../services/data-service.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';

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

      const groupVis = form?.groupVisibility ?? new Map();
      const ws = ctx.wizardState;
      return {
        pageContextId: ctx.pageContextId,
        pageType: ctx.pageType,
        caption: ctx.caption || ctx.rootFormId,
        isModal: ctx.isModal,
        fields: (form?.controlTree ?? [])
          .filter(f => f.caption && isEffectivelyVisible(f, groupVis, ws))
          .map(f => ({ name: f.caption, value: f.stringValue, editable: f.editable, type: f.type })),
        actions: (form?.actions ?? [])
          .filter(a => a.enabled && a.caption && isEffectivelyVisible(a, groupVis, ws))
          .map(a => ({
            name: a.caption,
            systemAction: a.systemAction,
            enabled: a.enabled,
            ...(a.wizardNav ? { wizardNav: a.wizardNav } : {}),
          })),
        rows: repeater ? mapRowCellKeys(repeater.rows, repeater.columns).map(r => ({ bookmark: r.bookmark, cells: r.cells })) : undefined,
      };
    });
  }
}
