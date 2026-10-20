// bc-saas F-73: writing "Token SAS" by caption on "Configuración DeCA" hit a HIDDEN
// control with the same caption (server:c[1]/c[6], in a collapsed warnings group) and
// answered "already set", while the field the user sees (server:c[5]/c[3]) kept its
// value. A caption-only write must target the visible control.
import { describe, it, expect, vi } from 'vitest';
import { DataService } from '../../src/services/data-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

const tree = {
  t: 'lf', ServerId: 'ROOT', PageType: 0, Caption: 'Configuración DeCA',
  Children: [
    { t: 'gc', Children: [] },
    { t: 'gc', Caption: 'Avisos', Visible: false, Children: [{ t: 'sc', Caption: 'Token SAS', ColumnBinder: { Name: 'hidden' } }] },
    { t: 'gc', Caption: 'Azure Blob Storage', Children: [{ t: 'sc', Caption: 'Token SAS', ColumnBinder: { Name: 'visible' }, Editable: true }] },
  ],
};

function setup() {
  const repo = new PageContextRepository();
  repo.create('pc', 'ROOT');
  repo.applyToPage('pc', [{ type: 'FormCreated', formId: 'ROOT', controlTree: tree } as BCEvent]);
  const sent: BCInteraction[] = [];
  const session = {
    invoke: async (i: BCInteraction) => {
      sent.push(i);
      const echo = i.type === 'SaveValue' ? [{ type: 'PropertyChanged', formId: 'ROOT', controlPath: i.controlPath, changes: { StringValue: i.newValue } } as BCEvent] : [];
      return ok([...echo, { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent]);
    },
    removeOpenForm: vi.fn(),
  } as never;
  return { sent, svc: new DataService(session, repo, { info() {}, warn() {}, error() {}, debug() {} } as never) };
}

describe('a caption-only write targets the visible control (F-73)', () => {
  it('writes the field in the visible group, not the hidden copy', async () => {
    const { svc, sent } = setup();
    const r = await svc.writeFields('pc', { 'Token SAS': '' }, {});
    expect(r.ok).toBe(true);
    const save = sent.find(i => i.type === 'SaveValue') as { controlPath: string };
    expect(save.controlPath).toBe('server:c[2]/c[0]');
  });

  it('an explicit controlPath still reaches the hidden one', async () => {
    const { svc, sent } = setup();
    await svc.writeFields('pc', { 'server:c[1]/c[0]': 'x' }, {});
    expect((sent.find(i => i.type === 'SaveValue') as { controlPath: string }).controlPath).toBe('server:c[1]/c[0]');
  });
});
