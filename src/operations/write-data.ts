import { isOk, ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { DataService, FieldWriteResult } from '../services/data-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';

export interface WriteDataInput {
  pageContextId: string;
  /** Values may arrive as string | number | boolean; coerced to text before writing. */
  fields: Record<string, string | number | boolean>;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
  /**
   * Disambiguates duplicate captions on document headers (e.g. the three `Name`
   * controls in Sell-to / Bill-to / Ship-to groups). When set, each field key is
   * resolved inside the group with this caption. Ignored for keys that are an
   * exact controlPath (those are already unambiguous).
   */
  group?: string;
}

export interface WriteDataOutput {
  results: FieldWriteResult[];
  allSucceeded: boolean;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class WriteDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: WriteDataInput): Promise<Result<WriteDataOutput, ProtocolError>> {
    // Coerce number/boolean values to their string form; BC SaveValue is text-based.
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.fields)) {
      fields[k] = typeof v === 'string' ? v : String(v);
    }
    const result = await this.dataService.writeFields(input.pageContextId, fields, {
      sectionId: input.section,
      rowIndex: input.rowIndex,
      bookmark: input.bookmark,
      group: input.group,
    });
    if (!isOk(result)) return result;

    const { results, events } = result.value;
    const ctx = this.repo.get(input.pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, events) : [];
    const dialogsOpened = detectDialogs(events);

    return ok({
      results,
      // A write only "succeeds" if the interaction completed AND the value
      // actually moved. `changed === false` is a no-op (rejected/reverted/not
      // editable) and must not be reported as success (P6). `changed`
      // undefined (line cells) is treated as success-by-interaction.
      allSucceeded: results.every(r => r.success && r.changed !== false),
      changedSections,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
    });
  }
}
