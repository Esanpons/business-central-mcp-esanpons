// tests/unit/download-report.test.ts
//
// P9: bc_download_report operation contract. The browser/CDP download itself is
// verified by integration against devel1; here we lock the operation's mapping
// of service results and error translation.

import { describe, it, expect } from 'vitest';
import { DownloadReportOperation } from '../../src/operations/download-report.js';
import type { ReportDownloadService, DownloadReportResult } from '../../src/services/report-download-service.js';

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

  it('translates a thrown service error to REPORT_DOWNLOAD_ERROR', async () => {
    const r = await opWith(async () => { throw new Error('No Chrome/Edge found'); }).execute({ reportId: 6 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('REPORT_DOWNLOAD_ERROR');
    expect(r.error.message).toMatch(/Chrome/);
  });
});
