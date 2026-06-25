// tests/unit/write-data-changed.test.ts
//
// P6 regression: bc_write_data must NOT report allSucceeded when a write was a
// no-op (changed === false). `success` only means the interaction completed.

import { describe, it, expect } from 'vitest';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import type { DataService, FieldWriteResult, WriteFieldsResult } from '../../src/services/data-service.js';
import type { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';

function opWith(results: FieldWriteResult[]): WriteDataOperation {
  const fakeData = {
    writeFields: async (): Promise<ReturnType<typeof ok<WriteFieldsResult>>> =>
      ok({ results, events: [] }),
  } as unknown as DataService;
  // repo.get returns undefined -> changedSections=[], no dialogs.
  const fakeRepo = { get: () => undefined } as unknown as PageContextRepository;
  return new WriteDataOperation(fakeData, fakeRepo);
}

describe('WriteDataOperation allSucceeded (P6)', () => {
  it('is false when a write completed but did not change the value', async () => {
    const op = opWith([
      { fieldName: 'Name', controlPath: 'server:c[1]/c[0]', success: true, requested: '2000008', changed: false, reason: 'validation reverted', newValue: 'FUKUI MURATA MANUFACTURING' },
    ]);
    const r = await op.execute({ pageContextId: 'pc:1', fields: { Name: '2000008' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.allSucceeded).toBe(false);
    expect(r.value.results[0].reason).toBe('validation reverted');
  });

  it('is true when the value actually changed', async () => {
    const op = opWith([
      { fieldName: 'Name', controlPath: 'server:c[2]/c[0]', success: true, requested: '2000008', changed: true, newValue: 'SAN-EI TECH LTD' },
    ]);
    const r = await op.execute({ pageContextId: 'pc:1', fields: { Name: '2000008' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.allSucceeded).toBe(true);
  });

  it('treats undefined changed (line cells) as success-by-interaction', async () => {
    const op = opWith([
      { fieldName: 'Quantity', controlPath: 'server:c[0]/cr/c[3]', success: true, requested: '5', newValue: '5' },
    ]);
    const r = await op.execute({ pageContextId: 'pc:1', fields: { Quantity: '5' }, section: 'lines', rowIndex: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.allSucceeded).toBe(true);
  });

  it('is false when the field was not found', async () => {
    const op = opWith([
      { fieldName: 'Bogus', controlPath: '', success: false, requested: 'x', changed: false, reason: 'control not found', error: 'Field not found: Bogus' },
    ]);
    const r = await op.execute({ pageContextId: 'pc:1', fields: { Bogus: 'x' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.allSucceeded).toBe(false);
    expect(r.value.results[0].reason).toBe('control not found');
  });
});
