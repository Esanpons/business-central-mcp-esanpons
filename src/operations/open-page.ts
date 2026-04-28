import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { buildAllSections } from '../protocol/section-dto.js';
import type { Section } from '../protocol/section-dto.js';

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
  sections: Section[];
}

export class OpenPageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: OpenPageInput): Promise<Result<OpenPageOutput, ProtocolError>> {
    const result = await this.pageService.openPage(input.pageId, {
      bookmark: input.bookmark,
      tenantId: input.tenantId,
    });

    return mapResult(result, (ctx) => ({
      pageContextId: ctx.pageContextId,
      pageType: ctx.pageType,
      caption: ctx.caption || ctx.rootFormId,
      isModal: ctx.isModal,
      sections: buildAllSections(ctx),
    }));
  }
}
