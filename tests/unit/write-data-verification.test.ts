// tests/unit/write-data-verification.test.ts
//
// What bc_write_data reports about a write has to be grounded in evidence:
//  - `changed: true` requires BC to have echoed or projected a new value
//  - writing the value a field ALREADY holds is not a failure to retry
//  - a caption that resolves to a repeater CELL TEMPLATE is not a header field

import { describe, it, expect, vi } from 'vitest';
import { DataService } from '../../src/services/data-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeService(repo: PageContextRepository, respond: (controlPath: string) => BCEvent[]) {
  const session = {
    invoke: async (interaction: { type: string; controlPath?: string }) =>
      ok(interaction.type === 'SaveValue' ? respond(interaction.controlPath ?? '') : []),
    removeOpenForm: vi.fn(),
  } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  return new DataService(session, repo, logger);
}

function cardContext(repo: PageContextRepository, children: unknown[]) {
  repo.create('pc:1', 'f1');
  repo.applyToPage('pc:1', [{
    type: 'FormCreated', formId: 'f1',
    controlTree: { t: 'lf', ServerId: 'f1', PageType: 0, Caption: 'Customer', Children: children },
  } as BCEvent]);
}

const echo = (controlPath: string, value: string): BCEvent =>
  ({ type: 'PropertyChanged', formId: 'f1', controlPath, changes: { StringValue: value } } as BCEvent);

describe('DataService.writeField verification', () => {
  it('reports changed:true when BC echoes a new value', async () => {
    const repo = new PageContextRepository();
    cardContext(repo, [{ t: 'sc', Caption: 'Name', StringValue: 'OLD', Visible: true, Editable: true }]);
    const svc = makeService(repo, (p) => [echo(p, 'NEW')]);

    const r = await svc.writeField('pc:1', 'Name', 'NEW');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBe(true);
    expect(r.value.newValue).toBe('NEW');
    expect(r.value.reason).toBeUndefined();
  });

  it('reports "already set" (not "validation reverted") for an idempotent write', async () => {
    const repo = new PageContextRepository();
    cardContext(repo, [{ t: 'sc', Caption: 'Name', StringValue: 'SAME', Visible: true, Editable: true }]);
    const svc = makeService(repo, (p) => [echo(p, 'SAME')]);

    const r = await svc.writeField('pc:1', 'Name', 'SAME');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBe(false);
    expect(r.value.reason).toBe('already set');
    expect(r.value.newValue).toBe('SAME');
  });

  it('reports "unverified" — never a fabricated changed:true — when nothing confirms the write', async () => {
    const repo = new PageContextRepository();
    // BC published no StringValue for this control and echoes nothing back.
    cardContext(repo, [{ t: 'sc', Caption: 'Name', Visible: true, Editable: true }]);
    const svc = makeService(repo, () => []);

    const r = await svc.writeField('pc:1', 'Name', 'NEW');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBeUndefined();
    expect(r.value.reason).toBe('unverified');
    expect(r.value.newValue).toBeUndefined();   // NOT the requested value
    expect(r.value.requested).toBe('NEW');
  });

  it('reports "validation reverted" when BC echoes the old value back', async () => {
    const repo = new PageContextRepository();
    cardContext(repo, [{ t: 'sc', Caption: 'Name', StringValue: 'OLD', Visible: true, Editable: true }]);
    const svc = makeService(repo, (p) => [echo(p, 'OLD')]);

    const r = await svc.writeField('pc:1', 'Name', 'NEW');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBe(false);
    expect(r.value.reason).toBe('validation reverted');
  });

  it('reports "not editable" when BC had the control read-only and nothing moved', async () => {
    const repo = new PageContextRepository();
    cardContext(repo, [{ t: 'sc', Caption: 'No.', StringValue: 'C1', Visible: true, Editable: false }]);
    const svc = makeService(repo, (p) => [echo(p, 'C1')]);

    const r = await svc.writeField('pc:1', 'No.', 'C2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reason).toBe('not editable');
  });

  it('refuses a line-column caption without a row instead of writing to an arbitrary row', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:lines', 'sub');
    repo.applyToPage('pc:lines', [{
      type: 'FormCreated', formId: 'sub',
      controlTree: {
        t: 'lf', ServerId: 'sub', PageType: 4, Caption: 'Lines',
        Children: [{
          t: 'rc',
          Columns: [{ t: 'rcc', Caption: 'Quantity', ColumnBinder: { Name: 'c1' } }],
          // BC ships the row-cell prototypes as ordinary field children of the rc
          Children: [{ t: 'dc', Caption: 'Quantity', Visible: true, Editable: true }],
        }],
      },
    } as BCEvent]);
    let saves = 0;
    const svc = makeService(repo, () => { saves += 1; return []; });

    const r = await svc.writeField('pc:lines', 'Quantity', '5');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/line column/i);
    expect(r.error.message).toMatch(/bookmark|rowIndex/);
    expect(saves).toBe(0);   // nothing was written
  });
});
