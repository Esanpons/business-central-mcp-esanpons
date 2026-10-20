// tests/unit/write-data-output.test.ts
//
// bc-saas F-42: every bc_write_data result carried the raw BC events of the write —
// every PropertyChanged of the form, plus a 16-row DataLoaded on a new line: ~30 KB
// for a customer number, 59 KB for a line. They are the evidence `changed`/`reason`
// is computed from, not output. Now they are returned only when asked for.

import { describe, it, expect } from 'vitest';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import type { DataService, FieldWriteResult } from '../../src/services/data-service.js';
import type { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { ok } from '../../src/core/result.js';
import { MCPHandler } from '../../src/mcp/handler.js';
import { WriteDataSchema, toMcpJsonSchema } from '../../src/mcp/schemas.js';

const fieldEvents: BCEvent[] = Array.from({ length: 120 }, (_, i) => ({
  type: 'PropertyChanged', formId: 'root', controlPath: `server:c[${i}]`, changes: { StringValue: `v${i}` },
}));

function opWith(results: FieldWriteResult[], events: BCEvent[] = fieldEvents): WriteDataOperation {
  const fakeData = { writeFields: async () => ok({ results, events }) } as unknown as DataService;
  const fakeRepo = { get: () => undefined } as unknown as PageContextRepository;
  return new WriteDataOperation(fakeData, fakeRepo);
}

const written: FieldWriteResult = {
  fieldName: 'N.º de cliente', controlPath: 'server:c[1]/c[0]', success: true,
  requested: '10000', changed: true, newValue: '10000', events: fieldEvents,
};

describe('bc_write_data does not dump raw events by default (F-42)', () => {
  it('strips the per-field events and returns no top-level events', async () => {
    const r = await opWith([written]).execute({ pageContextId: 'pc', fields: { 'N.º de cliente': '10000' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results[0]).not.toHaveProperty('events');
    expect(r.value).not.toHaveProperty('events');
    expect(r.value.results[0]).toMatchObject({ fieldName: 'N.º de cliente', changed: true, newValue: '10000', requested: '10000' });
    // The whole answer is now small; it used to carry every event of the form.
    expect(JSON.stringify(r.value).length).toBeLessThan(600);
  });

  it('returns the raw events once, at top level, only with includeEvents', async () => {
    const r = await opWith([written]).execute({ pageContextId: 'pc', fields: { 'N.º de cliente': '10000' }, includeEvents: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.events).toHaveLength(fieldEvents.length);
    expect(r.value.results[0]).not.toHaveProperty('events');
  });

  it('quiet trims each result to the verdict, keeping what explains a failure', async () => {
    const refused: FieldWriteResult = {
      fieldName: 'Nº', controlPath: 'server:c[1]/cr/c[1]', success: true, requested: '0000001',
      changed: false, reason: 'validation error', validationMessage: "Sale debe ser igual a 'Sí'", hint: 'pick a sellable item',
      events: fieldEvents,
    };
    const r = await opWith([written, refused]).execute({ pageContextId: 'pc', fields: { a: '1', b: '2' }, quiet: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results[0]).toEqual({ fieldName: 'N.º de cliente', controlPath: 'server:c[1]/c[0]', success: true, changed: true, newValue: '10000' });
    expect(r.value.results[1]).toEqual({
      fieldName: 'Nº', controlPath: 'server:c[1]/cr/c[1]', success: true, changed: false,
      reason: 'validation error', validationMessage: "Sale debe ser igual a 'Sí'", hint: 'pick a sellable item',
    });
    expect(r.value.allSucceeded).toBe(false);
  });

  it('reports what BC said while validating (an AL Message) as messages', async () => {
    const msg: BCEvent = { type: 'MessageToShow', formId: '', text: 'El cliente tiene saldo vencido.', messageType: 'Warning', actions: ['Ok'], defaultAction: 'Ok' };
    const r = await opWith([written], [msg]).execute({ pageContextId: 'pc', fields: { a: '1' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.messages).toEqual([{ text: 'El cliente tiene saldo vencido.', type: 'Warning' }]);
  });

  it('quiet and includeEvents are real tool parameters (unknown ones are rejected)', async () => {
    const props = (toMcpJsonSchema(WriteDataSchema) as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['quiet', 'includeEvents']));
    const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
    const h = new MCPHandler([{ name: 'bc_write_data', description: '', inputSchema: {}, zodSchema: WriteDataSchema, execute: async () => ({ ok: true, value: {} }) } as never], logger);
    const res = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bc_write_data', arguments: { pageContextId: 'p', fields: { A: '1' }, quiet: true, includeEvents: false } } } as never);
    expect((res as { result?: { isError?: boolean } }).result?.isError).toBeFalsy();
  });
});
