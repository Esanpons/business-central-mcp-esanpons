import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { ReportDownloadService, DownloadReportInput, DownloadReportResult, ReportOutputFormat } from '../services/report-download-service.js';

export interface DownloadReportOperationInput {
  reportId: string | number;
  company?: string;
  out?: string;
  timeoutMs?: number;
  filters?: Record<string, string | number | boolean>;
  /** G4: Options-area request-page parameters (dates, booleans, option pickers). */
  parameters?: Record<string, string | number | boolean>;
  /** G3: force the output format instead of BC's default (PDF). */
  format?: ReportOutputFormat;
}

export type DownloadReportOutput = DownloadReportResult;

export class DownloadReportOperation {
  constructor(private readonly service: ReportDownloadService) {}

  async execute(input: DownloadReportOperationInput): Promise<Result<DownloadReportOutput, ProtocolError>> {
    // Coerce filter values to text (BC request-page fields are text-based).
    const filters = input.filters
      ? Object.fromEntries(Object.entries(input.filters).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]))
      : undefined;
    const dlInput: DownloadReportInput = {
      reportId: String(input.reportId),
      company: input.company,
      out: input.out,
      timeoutMs: input.timeoutMs,
      filters,
      // Parameters keep their type: a boolean must stay a boolean so the service can
      // recognise it as a checkbox rather than typing the word "true" into a field.
      parameters: input.parameters,
      format: input.format,
    };
    try {
      // A result with downloaded:false is NOT an error: BC is waiting for parameters
      // or the requested format is not on offer. The service explains it in `note`
      // (plus filtersApplied / parametersApplied / availableFormats), so the caller
      // gets an actionable success rather than an opaque failure.
      return ok(await this.service.download(dlInput));
    } catch (e) {
      return err(new ProtocolError(e instanceof Error ? e.message : String(e), undefined, 'REPORT_DOWNLOAD_ERROR'));
    }
  }
}
