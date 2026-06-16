import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { ObjectIndexService, RefreshResult } from '../services/object-index-service.js';

export interface RefreshObjectsInput {
  from?: number;
  to?: number;
  all?: boolean;
}

export class RefreshObjectsOperation {
  constructor(private readonly service: ObjectIndexService) {}

  async execute(input: RefreshObjectsInput): Promise<Result<RefreshResult, ProtocolError>> {
    try {
      return ok(await this.service.refresh(input));
    } catch (e) {
      return err(new ProtocolError(e instanceof Error ? e.message : String(e), undefined, 'OBJECT_INDEX_ERROR'));
    }
  }
}
