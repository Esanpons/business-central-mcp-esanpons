import { isOk, ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { SearchService, SearchResult } from '../services/search-service.js';

export interface SearchPagesInput {
  query: string;
}

export interface SearchPagesOutput {
  results: SearchResult[];
  /**
   * Populated only when `results` is empty. Explains the most likely cause
   * (typically: BC's Tell Me index is profile-scoped — set BC_PROFILE).
   * Absent when results were returned.
   */
  note?: string;
}

export class SearchPagesOperation {
  constructor(private readonly searchService: SearchService) {}

  async execute(input: SearchPagesInput): Promise<Result<SearchPagesOutput, ProtocolError>> {
    const result = await this.searchService.search(input.query);
    if (!isOk(result)) return result;
    if (result.value.length === 0) {
      return ok({
        results: [],
        note: 'No results. Tell Me is profile-scoped — set BC_PROFILE to a profile that includes the searched objects (e.g. BUSINESS MANAGER) and reconnect, or open known page IDs directly via bc_open_page.',
      });
    }
    return ok({ results: result.value });
  }
}
