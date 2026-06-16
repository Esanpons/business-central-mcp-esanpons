import { ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { ObjectIndexService, FindResult } from '../services/object-index-service.js';

export interface FindObjectInput {
  query: string;
  type?: string;
  limit?: number;
}

export class FindObjectOperation {
  constructor(private readonly service: ObjectIndexService) {}

  execute(input: FindObjectInput): Promise<Result<FindResult, ProtocolError>> {
    return Promise.resolve(ok(this.service.find(input.query, { type: input.type, limit: input.limit })));
  }
}
