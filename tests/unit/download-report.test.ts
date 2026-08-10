// tests/unit/download-report.test.ts
//
// P9: bc_download_report operation contract. The browser/CDP download itself is
// verified by integration against devel1; here we lock the operation's mapping
// of service results and error translation.

import { describe, it, expect } from 'vitest';
import { DownloadReportOperation } from '../../src/operations/download-report.js';
import {
  formatNeedsSendToDialog, unmatchedCaptions,
  type ReportDownloadService, type DownloadReportResult,
} from '../../src/services/report-download-service.js';

function opWith(impl: () => Promise<DownloadReportResult>): DownloadReportOperation {
  return new DownloadReportOperation({ download: impl } as unknown as ReportDownloadService);
}

describe('DownloadReportOperation (P9)', () => {
  it('returns the saved path when a file was downloaded', async () => {
    const r = await opWith(async () => ({
      reportId: '6', url: 'https://devel1/BC/?report=6&tenant=default',
      authenticated: true, downloaded: true, path: 'C:/reports/report-6.pdf',
      fileName: 'Trial Balance.pdf', requestPageShown: false, pageTitle: 'Trial Balance',
    })).execute({ reportId: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.downloaded).toBe(true);
    expect(r.value.path).toBe('C:/reports/report-6.pdf');
  });

  it('reports requestPageShown (not an error) when parameters are needed', async () => {
    const r = await opWith(async () => ({
      reportId: '1306', url: 'https://devel1/BC/?report=1306&tenant=default',
      authenticated: true, downloaded: false, requestPageShown: true, pageTitle: 'Customer Statement',
    })).execute({ reportId: 1306 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.downloaded).toBe(false);
    expect(r.value.requestPageShown).toBe(true);
  });

  it('forwards filters to the service (document report filtered by No.)', async () => {
    let seen: unknown;
    const op = new DownloadReportOperation({
      download: async (inp: unknown) => {
        seen = inp;
        return {
          reportId: '50002', url: 'u', authenticated: true, downloaded: false,
          requestPageShown: true, pageTitle: 't',
          filtersApplied: [{ caption: 'No.', matched: true, matchedLabel: 'Nº' }],
        } as DownloadReportResult;
      },
    } as unknown as ReportDownloadService);
    const r = await op.execute({ reportId: 50002, company: 'CRONUS_04', filters: { 'No.': '2000052' } });
    expect((seen as { filters?: Record<string, string> }).filters).toEqual({ 'No.': '2000052' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filtersApplied?.[0]).toMatchObject({ caption: 'No.', matched: true });
  });

  it('passes the request-page diagnostics through on the SUCCESS path', async () => {
    // A downloaded file is not proof the options were applied: an unmatched caption
    // leaves BC's default in place and the report renders regardless.
    const r = await opWith(async () => ({
      reportId: '116', url: 'u', authenticated: true, downloaded: true,
      path: 'C:/reports/r.pdf', fileName: 'r.pdf', requestPageShown: false, pageTitle: 't',
      note: 'WARNING: the file was produced with DEFAULT options',
      parametersApplied: [{ caption: 'Show Amounts in LCY', matched: false }],
      format: 'pdf' as const, formatSelected: true, availableFormats: [],
    })).execute({ reportId: 116 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.downloaded).toBe(true);
    expect(r.value.parametersApplied?.[0]?.matched).toBe(false);
    expect(r.value.note).toMatch(/DEFAULT options/);
    expect(r.value.formatSelected).toBe(true);
  });

  it('translates a thrown service error to REPORT_DOWNLOAD_ERROR', async () => {
    const r = await opWith(async () => { throw new Error('No Chrome/Edge found'); }).execute({ reportId: 6 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('REPORT_DOWNLOAD_ERROR');
    expect(r.error.message).toMatch(/Chrome/);
  });
});

describe('formatNeedsSendToDialog (G3 — decide BEFORE clicking)', () => {
  it('treats pdf as producible without a Send-to dialog (it is BC\'s default output)', () => {
    expect(formatNeedsSendToDialog('pdf')).toBe(false);
  });

  it('requires the dialog for every non-default format', () => {
    expect(formatNeedsSendToDialog('excel')).toBe(true);
    expect(formatNeedsSendToDialog('word')).toBe(true);
    expect(formatNeedsSendToDialog('xml')).toBe(true);
  });

  it('needs nothing when no format was requested', () => {
    expect(formatNeedsSendToDialog(undefined)).toBe(false);
  });
});

describe('unmatchedCaptions (P6 — never trust success alone)', () => {
  it('collects unmatched captions from BOTH filters and parameters', () => {
    expect(unmatchedCaptions(
      [{ caption: 'No.', matched: true, matchedLabel: 'Nº' }, { caption: 'City', matched: false }],
      [{ caption: 'Show Amounts in LCY', matched: false }],
    )).toEqual(['City', 'Show Amounts in LCY']);
  });

  it('is empty when everything matched, and tolerates absent groups', () => {
    expect(unmatchedCaptions([{ caption: 'No.', matched: true }], undefined)).toEqual([]);
    expect(unmatchedCaptions(undefined, undefined)).toEqual([]);
  });
});
