import { isOk, ok, err, type Result } from '../core/result.js';
import { CardPartStubError, PageNotMaterializedError, type ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { buildAllSections, type Section } from '../protocol/section-dto.js';
import { fields as treeFields, cues as treeCues, tabs as treeTabs } from '../protocol/form-views.js';
import { toSectionSummary, filterColumns, sliceRows } from '../protocol/section-filters.js';

export interface OpenPageInput {
  pageId: string;
  bookmark?: string;
  tenantId?: string;
  /**
   * P7 payload controls -- a document page can return 100+ header fields, every
   * line and every factbox at once, which overflows the token budget. These let
   * the caller acotar the response at open time, mirroring bc_read_data.
   */
  /** Only include these sectionIds (e.g. ["header"]). Case-insensitive. */
  sections?: string[];
  /** Return only sectionId/kind/caption (+totalRowCount) per section -- discover then read each with bc_read_data. */
  summary?: boolean;
  /** Filter header/card fields to the named tab (e.g. "Shipping and Billing"). */
  tab?: string;
  /** Keep only these columns/fields (caption or controlPath) across every section. */
  columns?: string[];
  /** Slice already-loaded repeater rows to [offset .. offset+limit] (no scroll; use bc_read_data for deep pagination). */
  range?: { offset: number; limit: number };
}

export interface OpenPageOutput {
  pageContextId: string;
  /** PageType enum string from BC; see PageType in protocol/types.ts. */
  pageType: string;
  caption: string;
  /** True when the page opened as a modal (wizard, request page, confirmation). */
  isModal: boolean;
  /**
   * Every visible page section in canonical order: header, lines, subpages,
   * factboxes, requestPage. See `Section` in protocol/section-dto.ts.
   */
  sections: Section[];
}

export class OpenPageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: OpenPageInput): Promise<Result<OpenPageOutput, ProtocolError>> {
    const result = await this.pageService.openPage(input.pageId, {
      bookmark: input.bookmark,
      tenantId: input.tenantId,
    });
    if (!isOk(result)) return result;

    const ctx = result.value;
    if (ctx.pageType === 'CardPart') {
      const rootForm = ctx.forms.get(ctx.rootFormId);
      const captionedFields = rootForm
        ? treeFields(rootForm.root).filter((f) => f.properties.caption)
        : [];
      const cueCount = rootForm ? treeCues(rootForm.root).length : 0;
      if (captionedFields.length === 0 && cueCount === 0) {
        return err(new CardPartStubError(
          `Page ${input.pageId} is a CardPart and BC returned a placeholder shell. CardParts are server stubs unless reached through a host page (Role Center or another page that embeds them). Open the host page instead.`,
          {
            pageId: input.pageId,
            hostHint: 'Open the Role Center or host page that embeds this CardPart, then read the corresponding subpage section from its sections[] array.',
          },
        ));
      }
    }

    const sections = buildAllSections(ctx);

    // N1: BC did not give us a usable page. Surface an explicit reason instead
    // of returning an empty, mysterious "Unknown" shell with no diagnostics.
    if (sections.length === 0) {
      const reason = ctx.pageType === 'Unknown'
        ? (ctx.isModal
          ? 'BC opened a dialog/modal instead of a standalone page. Handle it with bc_respond_dialog, or open the host page that triggers it.'
          : 'BC returned an Unknown page type with no sections. This id is likely not a directly openable standalone page (e.g. a part/sub-object).')
        : 'The page opened but exposed no usable sections.';
      return err(new PageNotMaterializedError(
        `Page ${input.pageId} could not be materialized: ${reason}`,
        {
          pageId: input.pageId,
          pageType: ctx.pageType,
          caption: ctx.caption || ctx.rootFormId,
          isModal: ctx.isModal,
          reason,
        },
      ));
    }

    let out = sections;

    // P7: narrow which sections to return.
    if (input.sections && input.sections.length > 0) {
      const want = new Set(input.sections.map(s => s.toLowerCase()));
      out = out.filter(s => want.has(s.sectionId.toLowerCase()));
    }

    // summary mode short-circuits all per-field work: identity only.
    if (input.summary) {
      out = out.map(toSectionSummary);
    } else {
      // tab filter applies to the header (root form) card fields only.
      if (input.tab) {
        const rootForm = ctx.forms.get(ctx.rootFormId);
        const tab = rootForm
          ? treeTabs(rootForm.root).find(t => t.caption.toLowerCase() === input.tab!.toLowerCase())
          : undefined;
        if (tab) {
          const tabCaptions = new Set(tab.fields.map(f => (f.properties.caption ?? '').toLowerCase()));
          out = out.map(s => (s.kind === 'header' && s.fields)
            ? { ...s, fields: s.fields.filter(f => tabCaptions.has(f.name.toLowerCase())) }
            : s);
        }
      }
      if (input.columns && input.columns.length > 0) {
        out = out.map(s => filterColumns(s, input.columns!));
      }
      if (input.range) {
        out = out.map(s => sliceRows(s, input.range!));
      }
    }

    return ok({
      pageContextId: ctx.pageContextId,
      pageType: ctx.pageType,
      caption: ctx.caption || ctx.rootFormId,
      isModal: ctx.isModal,
      sections: out,
    });
  }
}
