import { isErr, mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { NavigationService } from '../services/navigation-service.js';
import { buildAllSections, buildSection, type Section } from '../protocol/section-dto.js';

export interface NavigateInput {
  pageContextId: string;
  bookmark: string;
  action?: 'drill_down' | 'select' | 'lookup';
  section?: string;
  field?: string;
}

export interface NavigateOutput {
  /** Set when action='drill_down' lands on a new page. */
  targetPageContextId?: string;
  pageType?: string;
  /** Sections of the target page (drill_down) or the resolved section (select). */
  sections?: Section[];
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class NavigateOperation {
  constructor(private readonly navigationService: NavigationService) {}

  async execute(input: NavigateInput): Promise<Result<NavigateOutput, ProtocolError>> {
    if (input.action === 'drill_down') {
      const result = await this.navigationService.drillDown(input.pageContextId, input.bookmark, input.section);
      return mapResult(result, (r) => ({
        targetPageContextId: r.targetPageContext.pageContextId,
        pageType: r.targetPageContext.pageType,
        sections: buildAllSections(r.targetPageContext),
        changedSections: [],
        dialogsOpened: [],
        requiresDialogResponse: false,
      }));
    }

    const result = await this.navigationService.selectRow(input.pageContextId, input.bookmark, input.section);
    if (isErr(result)) return result;
    return mapResult(result, (ctx) => {
      const sectionId = input.section ?? 'header';
      const section = buildSection(ctx, sectionId);
      return {
        sections: section ? [section] : [],
        changedSections: [],
        dialogsOpened: [],
        requiresDialogResponse: false,
      };
    });
  }
}
