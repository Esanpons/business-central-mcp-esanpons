// tests/unit/schema-object-ids.test.ts
//
// pageId / reportId / tenantId end up VERBATIM in BC's OpenForm WS query and in the
// browser deep-links. bc_run_report validated its reportId; bc_open_page's pageId was
// only trimmed, so "22&mode=Edit&filter=..." smuggled extra OpenForm parameters.

import { describe, it, expect } from 'vitest';
import {
  OpenPageSchema, RunReportSchema, DownloadReportSchema, ScreenshotSchema, BuildManualSchema,
  toMcpJsonSchema,
} from '../../src/mcp/schemas.js';

describe('pageId is a plain numeric object id', () => {
  it('accepts a number and a numeric string, coerced to a trimmed string', () => {
    expect(OpenPageSchema.parse({ pageId: 22 }).pageId).toBe('22');
    expect(OpenPageSchema.parse({ pageId: ' 22 ' }).pageId).toBe('22');
  });

  it('rejects a pageId carrying extra OpenForm query parameters', () => {
    const r = OpenPageSchema.safeParse({ pageId: "22&mode=Edit&filter='No.' IS '10000'" });
    expect(r.success).toBe(false);
  });

  it('rejects names, ranges, negatives and objects', () => {
    for (const pageId of ['Customer List', '22..30', '-1', '2 2', '', { $gt: 1 }]) {
      expect(OpenPageSchema.safeParse({ pageId }).success, JSON.stringify(pageId)).toBe(false);
    }
  });

  it('applies to the screenshot / manual page ids too', () => {
    expect(ScreenshotSchema.safeParse({ pageId: 21 }).success).toBe(true);
    expect(ScreenshotSchema.safeParse({ pageId: '21&x=1' }).success).toBe(false);
    expect(BuildManualSchema.safeParse({
      title: 't', steps: [{ heading: 'h', screenshot: { pageId: '21&x=1' } }],
    }).success).toBe(false);
  });

  it('the published JSON schema advertises the same constraint', () => {
    const json = toMcpJsonSchema(OpenPageSchema) as { properties: Record<string, { anyOf?: Array<Record<string, unknown>> }> };
    const pageId = JSON.stringify(json.properties.pageId);
    expect(pageId).toContain('pattern');
  });
});

describe('reportId is a plain numeric object id', () => {
  it('accepts numbers and numeric strings', () => {
    expect(RunReportSchema.parse({ reportId: 6 }).reportId).toBe('6');
    expect(DownloadReportSchema.parse({ reportId: '1306' }).reportId).toBe('1306');
  });
  it('rejects anything else', () => {
    expect(RunReportSchema.safeParse({ reportId: '6&tenant=other' }).success).toBe(false);
    expect(DownloadReportSchema.safeParse({ reportId: 'Trial Balance' }).success).toBe(false);
  });
});

describe('tenantId cannot smuggle query parameters', () => {
  it('accepts a GUID or a simple name', () => {
    expect(OpenPageSchema.safeParse({ pageId: '22', tenantId: 'default' }).success).toBe(true);
    expect(OpenPageSchema.safeParse({ pageId: '22', tenantId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427' }).success).toBe(true);
  });
  it('rejects separators used by the OpenForm query and the deep-link URL', () => {
    for (const tenantId of ['default&page=9999', 'a b', 'x?y', 'x=y', 'x/y']) {
      expect(OpenPageSchema.safeParse({ pageId: '22', tenantId }).success, tenantId).toBe(false);
    }
  });
});
