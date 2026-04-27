import { isErr, mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { NavigationService } from '../services/navigation-service.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import { fields as treeFields, groupVisibility as treeGroupVisibility } from '../protocol/form-views.js';

export interface NavigateInput {
  pageContextId: string;
  bookmark: string;
  action?: 'drill_down' | 'select' | 'lookup';
  section?: string;
  field?: string;
}

export interface NavigateOutput {
  targetPageContextId?: string;
  pageType?: string;
  sections?: Array<{ sectionId: string; kind: string; caption: string }>;
  fields?: Array<{ name: string; value?: string; editable: boolean }>;
  rows?: Array<{ bookmark: string; cells: Record<string, unknown> }>;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class NavigateOperation {
  constructor(private readonly navigationService: NavigationService) {}

  async execute(input: NavigateInput): Promise<Result<NavigateOutput, ProtocolError>> {
    if (input.action === 'drill_down') {
      const result = await this.navigationService.drillDown(input.pageContextId, input.bookmark, input.section);
      return mapResult(result, (r) => {
        const resolved = resolveSection(r.targetPageContext, 'header');
        const form = 'error' in resolved ? undefined : resolved.form;

        // Collect section descriptors from the target page
        const sections = Array.from(r.targetPageContext.sections.entries()).map(([sectionId, s]) => ({
          sectionId,
          kind: s.kind,
          caption: s.caption,
        }));

        return {
          targetPageContextId: r.targetPageContext.pageContextId,
          pageType: r.targetPageContext.pageType,
          sections,
          fields: (() => {
            const root = form?.root;
            if (!root) return [];
            const groupVis = treeGroupVisibility(root);
            return treeFields(root)
              .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, r.targetPageContext.wizardState))
              .map(f => ({ name: f.properties.caption!, value: f.properties.stringValue, editable: f.properties.editable ?? false }));
          })(),
          changedSections: [],
          dialogsOpened: [],
          requiresDialogResponse: false,
        };
      });
    }

    // Default: select row
    const result = await this.navigationService.selectRow(input.pageContextId, input.bookmark, input.section);
    if (isErr(result)) return result;
    return mapResult(result, (ctx) => {
      const resolved = resolveSection(ctx);
      // TODO(tier-2/T25): replace adapter with direct tree-node reads
      const rows = 'error' in resolved ? [] : resolved.rows;
      return {
        rows: rows.map(r => ({ bookmark: r.bookmark, cells: r.cells })),
        changedSections: [],
        dialogsOpened: [],
        requiresDialogResponse: false,
      };
    });
  }
}
