import { isOk, isErr, ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { DataService } from '../services/data-service.js';
import type { PageService } from '../services/page-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { buildSection, type Section } from '../protocol/section-dto.js';
import { filterFieldsByGroup, filterColumns, sliceRows } from '../protocol/section-filters.js';
import type { OpenFormFilter } from '../protocol/filter-query.js';
import { filterRows, type RowFilter } from '../protocol/row-filter.js';

export interface ReadDataInput {
  pageContextId: string;
  section?: string;
  tab?: string;
  /** Restrict card fields to those whose nearest enclosing group caption matches (case-insensitive). */
  group?: string;
  filters?: Array<{ column: string; value: string }>;
  /**
   * By default, `filters` REPLACES any filters already applied to this page
   * context (the previous filter lines are reset first). Set `appendFilters:
   * true` to AND the new filters on top of the existing ones instead. Without
   * the reset, successive reads silently accumulate filters and eventually
   * return zero rows with no indication why.
   */
  appendFilters?: boolean;
  columns?: string[];
  range?: { offset: number; limit: number };
}

export interface ReadDataOutput {
  section: Section;
  /**
   * G9: the server-side filters this page context is under right now (the OpenForm
   * `filter=` query), echoed so the caller never has to remember them. Empty = the
   * page is unfiltered. Replaced, never accumulated.
   */
  activeFilters: OpenFormFilter[];
  /**
   * G8: present ONLY when the rows were filtered client-side — which is what happens
   * for a lines/subpage section, because the server-side filter can only target the
   * page's main list. Says so explicitly, with how many rows were examined, so the
   * result is never mistaken for a server-side filter.
   */
  rowFilter?: {
    mode: 'client';
    filters: RowFilter[];
    /** Rows examined (all rows that could be materialized, up to the cap). */
    scanned: number;
    /** Rows that matched. */
    matched: number;
    /** True when the row cap was hit, so rows beyond it were never examined. */
    truncated: boolean;
  };
}

/**
 * Safety cap for the client-side (G8) path: how many rows we are willing to pull
 * into memory before filtering. Documents have tens of lines; a runaway subpage
 * should not turn one read into thousands of scrolls.
 */
const MAX_CLIENT_FILTER_ROWS = 2000;

export class ReadDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly repo: PageContextRepository,
    private readonly pageService?: PageService,
  ) {}

  async execute(input: ReadDataInput): Promise<Result<ReadDataOutput, ProtocolError>> {
    const sectionId = input.section ?? 'header';

    // Fast-fail for unknown pageContextId before any service calls.
    if (!this.repo.get(input.pageContextId)) {
      return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));
    }

    const isMainList = !input.section || input.section === 'header';
    // G8: filters on a lines/subpage section can't go through the OpenForm query (it
    // targets the page, not the subpage form) and the filter pane is a no-op on
    // BC27/BC28. Those are filtered client-side below, over fully-materialized rows.
    const clientFilters = input.filters && input.filters.length > 0 && !(isMainList && this.pageService)
      ? input.filters
      : undefined;

    if (input.filters && input.filters.length > 0 && !clientFilters && this.pageService) {
      // Working server-side path: re-open the page's form with an OpenForm `filter=`
      // query. This REPLACES any prior filter (reopen from scratch); appendFilters does
      // not apply here. Filter columns are AL field names, not localized captions.
      const previous = this.repo.get(input.pageContextId)?.activeFilters ?? [];
      const effective = input.appendFilters ? [...previous, ...input.filters] : input.filters;
      const reopened = await this.pageService.reopenWithFilters(input.pageContextId, effective);
      if (isErr(reopened)) return reopened;
    }

    // G8: a client-side filter is only honest if it saw every row, so pull the whole
    // repeater (bounded) before filtering. `truncated` below reports when the cap won.
    let clientScanTruncated = false;
    if (clientFilters) {
      const totalRowCount = this.dataService.getRepeaterTotalRowCount(input.pageContextId, input.section);
      const loaded = this.dataService.readRows(input.pageContextId, input.section);
      if (isOk(loaded)) {
        let rowsLen = loaded.value.length;
        while (rowsLen < Math.min(totalRowCount ?? Infinity, MAX_CLIENT_FILTER_ROWS)) {
          const scrollResult = await this.dataService.scrollRepeater(input.pageContextId, 1, input.section);
          if (!isOk(scrollResult) || scrollResult.value.length <= rowsLen) break;
          rowsLen = scrollResult.value.length;
        }
        clientScanTruncated = rowsLen >= MAX_CLIENT_FILTER_ROWS && (totalRowCount ?? 0) > rowsLen;
      }
    }

    // For repeater-bearing sections, materialize rows up to the requested range
    // so the resulting Section.rows reflects the slice the caller asked for.
    if (input.range) {
      const totalRowCount = this.dataService.getRepeaterTotalRowCount(input.pageContextId, input.section);
      const needed = input.range.offset + input.range.limit;
      // readRows err is benign here -- buildSection below produces a clearer
      // "Section '<id>' not found" diagnostic for the same root causes.
      const loaded = this.dataService.readRows(input.pageContextId, input.section);
      if (isOk(loaded)) {
        let rowsLen = loaded.value.length;
        while (rowsLen < needed && rowsLen < (totalRowCount ?? Infinity)) {
          const scrollResult = await this.dataService.scrollRepeater(input.pageContextId, 1, input.section);
          if (!isOk(scrollResult)) break;
          if (scrollResult.value.length <= rowsLen) break;
          rowsLen = scrollResult.value.length;
        }
      }
    }

    // Re-fetch the context AFTER applyFilters / scrollRepeater. The repo
    // replaces the PageContext entry on every event-induced update (immutable
    // updates with structural sharing), so a context captured before those
    // calls is stale and would cause buildSection to project pre-filter /
    // pre-scroll state.
    const ctx = this.repo.get(input.pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));

    const section = buildSection(ctx, sectionId);
    if (!section) {
      return err(new ProtocolError(`Section '${sectionId}' not found.`, {
        availableSections: Array.from(ctx.sections.keys()),
      }));
    }

    let materialized: Section = section;
    let rowFilter: ReadDataOutput['rowFilter'];

    // G8: apply the client-side row filter before any column/range narrowing, so
    // `range` slices the FILTERED result (which is what a caller paging through
    // matches expects) rather than the raw rows.
    if (clientFilters) {
      if (!materialized.rows) {
        return err(new ProtocolError(
          `Section '${sectionId}' has no rows to filter (filters apply to list/lines sections only).`,
          { availableSections: Array.from(ctx.sections.keys()) },
        ));
      }
      try {
        const outcome = filterRows(materialized.rows, clientFilters);
        materialized = { ...materialized, rows: outcome.rows };
        rowFilter = {
          mode: 'client',
          filters: [...clientFilters],
          scanned: outcome.scanned,
          matched: outcome.rows.length,
          truncated: clientScanTruncated,
        };
      } catch (e) {
        return err(new ProtocolError(e instanceof Error ? e.message : String(e), {
          section: sectionId,
          hint: 'Line/subpage filters match the column CAPTION shown in the rows (client-side). Only the page main list accepts AL field names.',
        }));
      }
    }

    if (input.tab && materialized.fields) {
      const tabsResult = this.dataService.getTabs(input.pageContextId, input.section);
      if (isOk(tabsResult) && tabsResult.value) {
        const matchingTab = tabsResult.value.find(t => t.caption.toLowerCase() === input.tab!.toLowerCase());
        if (matchingTab) {
          const tabFieldCaptions = new Set(matchingTab.fields.map(f => f.caption.toLowerCase()));
          materialized = {
            ...materialized,
            fields: materialized.fields.filter(f => tabFieldCaptions.has(f.name.toLowerCase())),
          };
        }
      }
    }

    if (input.group) {
      materialized = filterFieldsByGroup(materialized, input.group);
    }

    if (input.columns && input.columns.length > 0) {
      materialized = filterColumns(materialized, input.columns);
    }

    if (input.range) {
      materialized = sliceRows(materialized, input.range);
    }

    return ok({
      section: materialized,
      activeFilters: [...ctx.activeFilters],
      ...(rowFilter ? { rowFilter } : {}),
    });
  }
}
