import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { ReportDownloadService, DownloadReportInput, DownloadReportResult } from '../services/report-download-service.js';

export interface DownloadReportOperationInput {
  reportId: string | number;
  company?: string;
  out?: string;
  timeoutMs?: number;
  filters?: Record<string, string>;
}

export type DownloadReportOutput = DownloadReportResult;

export class DownloadReportOperation {
  constructor(private readonly service: ReportDownloadService) {}

  async execute(input: DownloadReportOperationInput): Promise<Result<DownloadReportOutput, ProtocolError>> {
    const dlInput: DownloadReportInput = {
      reportId: String(input.reportId),
      company: input.company,
      out: input.out,
      timeoutMs: input.timeoutMs,
      filters: input.filters,
    };
    try {
      const r = await this.service.download(dlInput);
      if (!r.downloaded && r.requestPageShown) {
        // Not an error: BC needs parameters. Tell the caller how to proceed.
        return ok(r);
      }
      return ok(r);
    } catch (e) {
      return err(new ProtocolError(e instanceof Error ? e.message : String(e), undefined, 'REPORT_DOWNLOAD_ERROR'));
    }
  }
}
