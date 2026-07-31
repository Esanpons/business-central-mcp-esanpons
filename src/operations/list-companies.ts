import { ok, isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import type { DataService } from '../services/data-service.js';
import type { Logger } from '../core/logger.js';

export interface ListCompaniesOutput {
  currentCompany: string;
  companies: Array<{ name: string; displayName: string }>;
}

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
      const readResult = this.dataService.readRows(pageContextId);
      if (!isOk(readResult)) return readResult;

      // Extract company names from rows. Prefer an explicit Name / Display Name
      // column over "the first string cell", which returns the wrong value when
      // the first string column is a badge/evaluation flag rather than the name.
      const companies = readResult.value.map(row => {
        const cells = row.cells as Record<string, unknown>;
        const entries = Object.entries(cells).filter(([, v]) => typeof v === 'string' && v) as Array<[string, string]>;
        const byKey = (re: RegExp) => entries.find(([k]) => re.test(k))?.[1];
        const name = byKey(/^(company\s*)?name$/i) ?? byKey(/name/i) ?? entries[0]?.[1] ?? '';
        const displayName = byKey(/display\s*name/i) ?? name;
        return { name, displayName };
      });

      this.logger.info(`Listed ${companies.length} companies (current: ${this.getCurrentCompany()})`);

      return ok({
        currentCompany: this.getCurrentCompany(),
        companies,
      });
    } finally {
      // Always close the page to free resources
      await this.pageService.closePage(pageContextId).catch(() => {});
    }
  }
}
