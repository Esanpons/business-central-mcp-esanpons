import { isOk, isErr, ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { DataService } from '../services/data-service.js';
import type { FilterService } from '../services/filter-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { buildSection, type Section } from '../protocol/section-dto.js';

export interface ReadDataInput {
  pageContextId: string;
  section?: string;
  tab?: string;
  filters?: Array<{ column: string; value: string }>;
  columns?: string[];
  range?: { offset: number; limit: number };
}

export interface ReadDataOutput {
  section: Section;
}

export class ReadDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly filterService: FilterService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: ReadDataInput): Promise<Result<ReadDataOutput, ProtocolError>> {
    const sectionId = input.section ?? 'header';

    const ctx = this.repo.get(input.pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));

    if (input.filters && input.filters.length > 0) {
      const filterResult = await this.filterService.applyFilters(input.pageContextId, input.filters, input.section);
      if (isErr(filterResult)) return filterResult;
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

    const section = buildSection(ctx, sectionId);
    if (!section) {
      return err(new ProtocolError(`Section '${sectionId}' not found.`, {
        availableSections: Array.from(ctx.sections.keys()),
      }));
    }

    let materialized: Section = section;

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

    if (input.columns && input.columns.length > 0) {
      const wanted = new Set(input.columns.map(c => c.toLowerCase()));
      if (materialized.rows) {
        materialized = {
          ...materialized,
          rows: materialized.rows.map(r => ({
            bookmark: r.bookmark,
            cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => wanted.has(k.toLowerCase()))),
          })),
        };
      }
      if (materialized.fields) {
        materialized = {
          ...materialized,
          fields: materialized.fields.filter(f => wanted.has(f.name.toLowerCase())),
        };
      }
    }

    if (input.range && materialized.rows) {
      materialized = {
        ...materialized,
        rows: materialized.rows.slice(input.range.offset, input.range.offset + input.range.limit),
      };
    }

    return ok({ section: materialized });
  }
}
