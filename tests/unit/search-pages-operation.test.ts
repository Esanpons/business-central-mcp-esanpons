import { describe, it, expect } from 'vitest';
import { SearchPagesOperation } from '../../src/operations/search-pages.js';
import { ok } from '../../src/core/result.js';
import type { SearchResult } from '../../src/services/search-service.js';

describe('SearchPagesOperation', () => {
  it('returns results without a note when search yields hits', async () => {
    const fakeSearch = {
      search: async () => ok([
        { name: 'Customers', objectType: 'page', runTarget: 'Customer List' } as SearchResult,
      ]),
    };
    const op = new SearchPagesOperation(fakeSearch as never);
    const result = await op.execute({ query: 'customer' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results).toHaveLength(1);
      expect(result.value.note).toBeUndefined();
    }
  });

  it('returns empty results with a profile-hint note when search yields nothing', async () => {
    const fakeSearch = {
      search: async () => ok([] as SearchResult[]),
    };
    const op = new SearchPagesOperation(fakeSearch as never);
    const result = await op.execute({ query: 'asdf' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results).toEqual([]);
      expect(result.value.note).toBeTruthy();
      expect(result.value.note).toMatch(/profile/i);
    }
  });

  it('propagates underlying errors unchanged', async () => {
    const fakeSearch = {
      search: async () => ({ ok: false as const, error: { message: 'BC down', code: 'CONNECTION_ERROR' } as never }),
    };
    const op = new SearchPagesOperation(fakeSearch as never);
    const result = await op.execute({ query: 'customer' });
    expect(result.ok).toBe(false);
  });
});
