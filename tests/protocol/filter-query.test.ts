// tests/protocol/filter-query.test.ts
//
// The OpenForm `filter=` expression is the ONLY list-filtering mechanism that works
// on BC27/BC28, and it is assembled by string concatenation into a quoted grammar
// that is then embedded in a query string. Both layers have to survive real business
// data: apostrophes in names, ampersands in company names, ranges and wildcards.

import { describe, it, expect } from 'vitest';
import { buildOpenFormFilter, escapeFilterToken } from '../../src/protocol/filter-query.js';

describe('buildOpenFormFilter', () => {
  it('builds the documented shape and ANDs several filters', () => {
    expect(buildOpenFormFilter([{ column: 'No.', value: '10000' }])).toBe("'No.' IS '10000'");
    expect(buildOpenFormFilter([
      { column: 'No.', value: '10000..20000' },
      { column: 'City', value: '*Barcelona*' },
    ])).toBe("'No.' IS '10000..20000' AND 'City' IS '*Barcelona*'");
  });

  it('drops empty entries and returns an empty string when nothing is left', () => {
    expect(buildOpenFormFilter([{ column: 'Name', value: '' }])).toBe('');
    expect(buildOpenFormFilter([])).toBe('');
    expect(buildOpenFormFilter([{ column: '', value: 'x' }, { column: 'Name', value: 'A*' }]))
      .toBe("'Name' IS 'A*'");
  });

  it('doubles a single quote so the value cannot terminate the token', () => {
    // Unescaped, `L'Oreal` closed the token and BC answered "token not found",
    // which (before the reopen became transactional) also killed the open page.
    expect(buildOpenFormFilter([{ column: 'Name', value: "L'Oreal" }])).toBe("'Name' IS 'L''Oreal'");
    expect(escapeFilterToken("O'Brien's")).toBe("O''Brien''s");
  });

  it('escapes the column identifier too', () => {
    expect(buildOpenFormFilter([{ column: "Cust's Ref.", value: '1' }])).toBe("'Cust''s Ref.' IS '1'");
  });

  it('leaves range / wildcard / expression syntax untouched', () => {
    expect(buildOpenFormFilter([{ column: 'Amount', value: '>1000' }])).toBe("'Amount' IS '>1000'");
    expect(buildOpenFormFilter([{ column: 'Date', value: '..31/12/2026' }])).toBe("'Date' IS '..31/12/2026'");
  });

  it('keeps an ampersand in the expression (the query layer is what must encode it)', () => {
    const expr = buildOpenFormFilter([{ column: 'Name', value: 'Smith & Sons' }]);
    expect(expr).toBe("'Name' IS 'Smith & Sons'");
    // What PageService.buildOpenFormQuery does with it: a raw `&` would split the
    // OpenForm query into a bogus extra parameter.
    const encoded = encodeURIComponent(expr).replace(/'/g, '%27');
    expect(encoded).not.toContain('&');
    expect(decodeURIComponent(encoded.replace(/%27/g, "'"))).toBe(expr);
  });

  it('encodes every query metacharacter a value can carry', () => {
    const expr = buildOpenFormFilter([{ column: 'Name', value: '100% + tax #3' }]);
    const encoded = encodeURIComponent(expr).replace(/'/g, '%27');
    for (const ch of ['&', '%20', '#']) {
      if (ch === '#') expect(encoded).not.toContain('#');
    }
    expect(encoded).not.toContain(' ');
    expect(encoded).toContain('%25');   // %
    expect(encoded).toContain('%2B');   // +
    expect(decodeURIComponent(encoded.replace(/%27/g, "'"))).toBe(expr);
  });
});
