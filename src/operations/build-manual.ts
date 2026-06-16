import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { ManualService, BuildManualInput, BuildManualOutput } from '../services/manual-service.js';

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
