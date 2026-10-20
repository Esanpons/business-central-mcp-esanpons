import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { RecordingService, RecordInput as ServiceInput, RecordResult } from '../services/recording-service.js';
import type { ScreenshotStep } from '../services/screenshot-service.js';

export interface RecordInput {
  pageId: string | number;
  bookmark?: string;
  company?: string;
  steps: ScreenshotStep[];
  title?: string;
  captions?: boolean;
  cursor?: boolean;
  pace?: number;
  typingDelay?: number;
  glide?: number;
  speed?: number;
  settle?: number;
  intro?: number;
  outro?: number;
  out?: string;
  width?: number;
  height?: number;
  fps?: number;
  format?: 'mp4' | 'webm';
  expand?: boolean;
  dismissTeachingTips?: boolean;
}

export type RecordOutput = RecordResult;

/**
 * bc_record: a video of a circuit performed in the real web client. Thin: the
 * service does the work, this maps the schema input and turns a thrown error into
 * a RECORDING_ERROR result (no video, no sidecar -- the service never writes a
 * file for a run it could not finish).
 */
export class RecordOperation {
  constructor(private readonly service: RecordingService) {}

  async execute(input: RecordInput): Promise<Result<RecordOutput, ProtocolError>> {
    const serviceInput: ServiceInput = {
      ...input,
      pageId: String(input.pageId),
    };
    try {
      return ok(await this.service.record(serviceInput));
    } catch (e) {
      return err(new ProtocolError(e instanceof Error ? e.message : String(e), undefined, 'RECORDING_ERROR'));
    }
  }
}
