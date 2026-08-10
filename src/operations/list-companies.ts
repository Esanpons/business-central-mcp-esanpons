import { ok, isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import type { DataService } from '../services/data-service.js';
import type { Logger } from '../core/logger.js';

export interface ListCompaniesOutput {
  currentCompany: string;
  companies: Array<{ name: string; displayName: string }>;
  /**
   * Rows BC says the Companies list holds, when it reports one. Compare it with
   * `companies.length`: they are equal on a complete read. Null when BC did not
   * report a count.
   */
  totalRowCount: number | null;
  /**
   * True when the list could NOT be fully materialized (scrolling stopped making
   * progress before reaching totalRowCount, or the safety cap was hit). The result
   * used to truncate SILENTLY at whatever the initial viewport happened to hold,
   * which quietly hid companies from bc_switch_company.
   */
  truncated: boolean;
}

/**
 * Safety cap. A BC environment with more companies than this is not a thing; the cap
 * only exists so a misbehaving repeater cannot spin forever.
 */
const MAX_COMPANY_ROWS = 500;

export class ListCompaniesOperation {
  constructor(
    private readonly pageService: PageService,
    private readonly dataService: DataService,
    private readonly getCurrentCompany: () => string,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<Result<ListCompaniesOutput, ProtocolError>> {
    // Open the Companies system page (page 357)
    const openResult = await this.pageService.openPage('357');
    if (!isOk(openResult)) return openResult;

    const pageContextId = openResult.value.pageContextId;

    try {
      // Read company names from the list
      let readResult = this.dataService.readRows(pageContextId);
      if (!isOk(readResult)) return readResult;

      // BC ships only the initially-loaded viewport of a repeater. Scroll until the
      // row count stops growing or matches what BC says the list holds — the same
      // approach bc_read_data uses for its `range` pagination. Without this, an
      // environment with more companies than one viewport silently lost the rest.
      const totalRowCount = this.dataService.getRepeaterTotalRowCount(pageContextId);
      const target = Math.min(totalRowCount ?? Infinity, MAX_COMPANY_ROWS);
      let rows = readResult.value;
      while (rows.length < target) {
        const scrolled = await this.dataService.scrollRepeater(pageContextId, 1);
        if (!isOk(scrolled) || scrolled.value.length <= rows.length) break;
        rows = scrolled.value;
      }
      // Re-read so `rows` reflects the final materialized state of the repeater.
      readResult = this.dataService.readRows(pageContextId);
      if (isOk(readResult) && readResult.value.length > rows.length) rows = readResult.value;

      const truncated = totalRowCount !== null && rows.length < totalRowCount;

      // Extract company names from rows. Prefer an explicit Name / Display Name
      // column over "the first string cell", which returns the wrong value when
      // the first string column is a badge/evaluation flag rather than the name.
      const companies = rows.map(row => {
        const cells = row.cells as Record<string, unknown>;
        const entries = Object.entries(cells).filter(([, v]) => typeof v === 'string' && v) as Array<[string, string]>;
        const byKey = (re: RegExp) => entries.find(([k]) => re.test(k))?.[1];
        const name = byKey(/^(company\s*)?name$/i) ?? byKey(/name/i) ?? entries[0]?.[1] ?? '';
        const displayName = byKey(/display\s*name/i) ?? name;
        return { name, displayName };
      });

      if (truncated) {
        this.logger.warn(`Companies list truncated: read ${companies.length} of ${totalRowCount} rows reported by BC.`);
      }
      this.logger.info(`Listed ${companies.length} companies (current: ${this.getCurrentCompany()})`);

      return ok({
        currentCompany: this.getCurrentCompany(),
        companies,
        totalRowCount,
        truncated,
      });
    } finally {
      // Always close the page to free resources
      await this.pageService.closePage(pageContextId).catch(() => {});
    }
  }
}
