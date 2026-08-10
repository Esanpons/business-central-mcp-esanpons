import { isOk, isErr, ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { DataService } from '../services/data-service.js';
import type { PageService } from '../services/page-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import { buildSection, type Section } from '../protocol/section-dto.js';
import { filterFieldsByGroup, filterColumns, sliceRows } from '../protocol/section-filters.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { buildBinderToCaptionMap, repeaterColumnsToDto } from '../protocol/row-mapping.js';
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

    // Fast-fail for unknown pageContextId before any service calls. notFoundError
    // carries availablePageContexts so the caller can self-correct in one turn.
    const initialCtx = this.repo.get(input.pageContextId);
    if (!initialCtx) return err(this.repo.notFoundError(input.pageContextId));

    const hasFilters = !!input.filters && input.filters.length > 0;
    // The server-side route re-OPENS the page with an OpenForm `filter=` query, so it
    // is only correct for a LIST-SHAPED root: on a card/document context (opened by
    // bookmark or drill-down) it silently threw the record away and landed on the
    // first record of the filter. Requiring a repeater on the resolved section is
    // what distinguishes the two — the sectionId alone does not.
    const targetsDefaultSection = !input.section || input.section === 'header';
    const rootIsList = targetsDefaultSection && this.sectionHasRepeater(initialCtx, input.section);
    const useServerSide = hasFilters && !!this.pageService && rootIsList;

    if (hasFilters && targetsDefaultSection && !rootIsList) {
      const listSections = Array.from(initialCtx.sections.values())
        .filter(s => s.valid && s.repeaterControlPath)
        .map(s => s.sectionId);
      return err(new ProtocolError(
        `Filters cannot be applied to section '${sectionId}' of ${input.pageContextId}: it is not a list ` +
        `(page type ${initialCtx.pageType}, no repeater). Filtering here would re-open the page and move it off the current record.`,
        {
          pageType: initialCtx.pageType,
          listSections,
          hint: listSections.length > 0
            ? `Filter one of its list sections instead (section: "${listSections[0]}"), or open the list page with bc_open_page { pageId, filters }.`
            : 'Open the list page with bc_open_page { pageId, filters } and filter there.',
        },
      ));
    }

    // G8: filters on a lines/subpage section can't go through the OpenForm query (it
    // targets the page, not the subpage form) and the filter pane is a no-op on
    // BC27/BC28. Those are filtered client-side below, over fully-materialized rows.
    const clientFilters = hasFilters && !useServerSide ? input.filters : undefined;

    if (useServerSide && this.pageService) {
      // Working server-side path: re-open the page's form with an OpenForm `filter=`
      // query. This REPLACES any prior filter (reopen from scratch); appendFilters does
      // not apply here. Filter columns are AL field names, not localized captions.
      const previous = this.repo.get(input.pageContextId)?.activeFilters ?? [];
      const effective = input.appendFilters ? [...previous, ...input.filters!] : input.filters!;
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
        // An unknown totalRowCount (BC publishes it lazily) is NOT "zero more rows":
        // collapsing undefined to 0 reported a complete scan every time the 2000-row
        // cap was hit on a repeater whose count BC had not announced.
        clientScanTruncated = rowsLen >= MAX_CLIENT_FILTER_ROWS
          && (totalRowCount === null || totalRowCount === undefined || totalRowCount > rowsLen);
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
    if (!ctx) return err(this.repo.notFoundError(input.pageContextId));

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
        // Resolve column names against the repeater's COLUMNS (complete even with
        // zero rows loaded) and accept the binder name as an alias, so a caller can
        // use either the display caption or the AL/binder name on any section.
        const { columns, aliases } = this.columnVocabulary(ctx, input.section);
        const outcome = filterRows(materialized.rows, clientFilters, { columns, aliases });
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
      // A `tab` that matches nothing used to fall through and return the FULL field
      // set — the exact opposite of what the caller asked for, with no signal. Fail
      // with the tab list instead (contrast: a bad `section` already errors this way).
      const tabsResult = this.dataService.getTabs(input.pageContextId, input.section);
      const availableTabs = (isOk(tabsResult) && tabsResult.value ? tabsResult.value : []).map(t => t.caption);
      const matchingTab = (isOk(tabsResult) && tabsResult.value ? tabsResult.value : [])
        .find(t => t.caption.toLowerCase() === input.tab!.toLowerCase());
      if (!matchingTab) {
        return err(new ProtocolError(
          `Tab '${input.tab}' not found on section '${sectionId}'.` +
          (availableTabs.length > 0 ? ` Available tabs: ${availableTabs.join(', ')}.` : ' This section exposes no tabs.'),
          { availableTabs, section: sectionId },
        ));
      }
      const tabFieldCaptions = new Set(matchingTab.fields.map(f => f.caption.toLowerCase()));
      materialized = {
        ...materialized,
        fields: materialized.fields.filter(f => tabFieldCaptions.has(f.name.toLowerCase())),
      };
    }

    if (input.group) {
      const grouped = filterFieldsByGroup(materialized, input.group);
      if (grouped.matched === 0) {
        return err(new ProtocolError(
          `Group '${input.group}' matched no field on section '${sectionId}'.` +
          (grouped.availableGroups.length > 0
            ? ` Available groups: ${grouped.availableGroups.join(', ')}.`
            : ' This section exposes no field groups.'),
          { availableGroups: grouped.availableGroups, section: sectionId },
        ));
      }
      materialized = grouped.section;
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

  /** True when the named (or default) section resolves to a form with a repeater. */
  private sectionHasRepeater(ctx: PageContext, sectionId?: string): boolean {
    const resolved = resolveSection(ctx, sectionId, 'header');
    return !('error' in resolved) && !!resolved.repeater;
  }

  /**
   * The names a row filter may use for this section's columns: the display captions
   * the rows are keyed by, plus binder-name aliases. Derived from the repeater's
   * columns, so it is complete even when no rows are loaded.
   */
  private columnVocabulary(ctx: PageContext, sectionId?: string): { columns: string[]; aliases: Map<string, string> } {
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved || !resolved.repeater) return { columns: [], aliases: new Map() };
    const binderToCaption = buildBinderToCaptionMap(repeaterColumnsToDto(resolved.repeater));
    return { columns: [...binderToCaption.values()], aliases: binderToCaption };
  }
}
