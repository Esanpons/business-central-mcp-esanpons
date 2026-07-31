// tests/unit/schema-fixes.test.ts
//
// Locks in the schema-level fixes from the 2026-07-04 audit:
//  - M18: bc_write_data / bc_download_report accept number & boolean values.
//  - M2:  bc_navigate dropped the unimplemented "lookup" action + "field" param.
//  - B3:  bc_read_data exposes appendFilters.
//  - M5:  bc_close_page exposes discardChanges.
// Also verifies the published JSON schemas stay flat (no root-level combinator),
// which Claude Code's MCP client requires.

import { describe, it, expect } from 'vitest';
import {
  WriteDataSchema, DownloadReportSchema, NavigateSchema, ReadDataSchema,
  ClosePageSchema, toMcpJsonSchema,
} from '../../src/mcp/schemas.js';

describe('M18: value coercion in write/filter maps', () => {
  it('bc_write_data accepts string, number and boolean field values', () => {
    const r = WriteDataSchema.safeParse({
      pageContextId: 'p', fields: { Name: 'Contoso', Quantity: 5, Blocked: true },
    });
    expect(r.success).toBe(true);
  });

  it('bc_download_report accepts non-string filter values', () => {
    const r = DownloadReportSchema.safeParse({ reportId: 6, filters: { 'No.': 2000052 } });
    expect(r.success).toBe(true);
  });

  it('bc_write_data still rejects nested-object values', () => {
    const r = WriteDataSchema.safeParse({ pageContextId: 'p', fields: { X: { a: 1 } } });
    expect(r.success).toBe(false);
  });
});

describe('M2: bc_navigate no longer advertises unimplemented options', () => {
  it('accepts select and drill_down', () => {
    expect(NavigateSchema.safeParse({ pageContextId: 'p', bookmark: 'b', action: 'select' }).success).toBe(true);
    expect(NavigateSchema.safeParse({ pageContextId: 'p', bookmark: 'b', action: 'drill_down' }).success).toBe(true);
  });
  it('rejects the removed "lookup" action', () => {
    expect(NavigateSchema.safeParse({ pageContextId: 'p', bookmark: 'b', action: 'lookup' }).success).toBe(false);
  });
});

describe('B3 / M5: new opt-in params', () => {
  it('bc_read_data accepts appendFilters', () => {
    const r = ReadDataSchema.safeParse({ pageContextId: 'p', filters: [{ column: 'City', value: 'London' }], appendFilters: true });
    expect(r.success).toBe(true);
  });
  it('bc_close_page accepts discardChanges', () => {
    const r = ClosePageSchema.safeParse({ pageContextId: 'p', discardChanges: true });
    expect(r.success).toBe(true);
  });
});

describe('published JSON schemas stay flat (no root combinator)', () => {
  for (const [name, schema] of [
    ['WriteDataSchema', WriteDataSchema],
    ['DownloadReportSchema', DownloadReportSchema],
    ['NavigateSchema', NavigateSchema],
    ['ReadDataSchema', ReadDataSchema],
  ] as const) {
    it(`${name} has no top-level oneOf/anyOf/allOf`, () => {
      const json = toMcpJsonSchema(schema) as Record<string, unknown>;
      expect(json.oneOf).toBeUndefined();
      expect(json.anyOf).toBeUndefined();
      expect(json.allOf).toBeUndefined();
      expect(json.type).toBe('object');
    });
  }
});
