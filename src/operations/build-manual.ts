import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { ManualService, BuildManualInput, BuildManualOutput } from '../services/manual-service.js';

/**
 * Builds the manual. Note that a successful result may still carry `warnings`:
 * steps whose callout/redaction captions matched nothing, pages that never
 * finished loading, or referenced images that do not exist. The document is
 * written either way, so the caller must read `warnings` to know which steps
 * need re-shooting.
 */
export class BuildManualOperation {
  constructor(private readonly service: ManualService) {}

  async execute(input: BuildManualInput): Promise<Result<BuildManualOutput, ProtocolError>> {
    try {
      return ok(await this.service.build(input));
    } catch (e) {
      return err(new ProtocolError(e instanceof Error ? e.message : String(e), undefined, 'MANUAL_ERROR'));
    }
  }
}
