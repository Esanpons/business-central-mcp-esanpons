// tests/unit/page-service-error-dialog.test.ts
//
// bc-saas F-3: BC answers an OpenForm it refuses with an ERROR DIALOG (`lmd` +
// ExceptionType + Message) instead of a form. Registering that dialog as the page
// produced an unreadable shell — pageType "Unknown", isModal true, no fields and a
// caption that changed on every call (it was the raw formId) — and threw away the
// only thing that explained the refusal: BC's own message.
//
// The wire shape below is a live capture from devel1 (page 132 opened with a
// bookmark taken from a list bound to another table).

import { describe, it, expect, vi } from 'vitest';
import { PageService } from '../../src/services/page-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

const BC_MESSAGE = "No se puede utilizar un RecordID de la tabla 'Sales Shipment Header' "
  + "con un registro de la tabla 'Sales Invoice Header'.";

function makeService(events: BCEvent[], sent: BCInteraction[] = []) {
  const session = {
    invoke: async (interaction: BCInteraction) => {
      sent.push(interaction);
      return ok(interaction.type === 'OpenForm' ? events : ([{ type: 'InvokeCompleted' }] as BCEvent[]));
    },
    removeOpenForm: vi.fn(),
    addOpenForm: vi.fn(),
  } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  return new PageService(session, new PageContextRepository(), logger);
}

const errorDialog = (over: Record<string, unknown> = {}): BCEvent => ({
  type: 'DialogOpened',
  formId: '6F',
  controlTree: {
    t: 'lmd', ServerId: '6F', Caption: 'Error', IsModal: true,
    DialogType: 3, ExceptionType: 1, Message: BC_MESSAGE, Children: [],
    ...over,
  },
} as BCEvent);

describe('PageService: BC refuses the open with an error dialog', () => {
  it('returns PAGE_OPEN_REJECTED carrying BC\'s message instead of an Unknown shell', async () => {
    const svc = makeService([{ type: 'InvokeCompleted' } as BCEvent, errorDialog()]);
    const r = await svc.openPage('132', { bookmark: '1F_bgAAAAJ7' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PAGE_OPEN_REJECTED');
    expect(r.error.message).toContain(BC_MESSAGE);
    expect(r.error.context).toMatchObject({ pageId: '132', bcMessage: BC_MESSAGE });
    // The caller is told what to do instead, since a bookmark was involved.
    expect(String((r.error.context as { hint: string }).hint)).toMatch(/filters|bc_execute_action/);
  });

  it('dismisses the dialog so it does not sit on the session modal stack', async () => {
    const sent: BCInteraction[] = [];
    const svc = makeService([errorDialog()], sent);
    await svc.openPage('132', { bookmark: 'x' });
    expect(sent.map(s => s.type)).toEqual(['OpenForm', 'InvokeAction']);
    expect(sent[1]).toMatchObject({ formId: '6F', systemAction: 300 });  // Ok
  });

  it('still treats a NON-error dialog (wizard / request page) as the page itself', async () => {
    // A NavigatePage or a report request page legitimately arrives as DialogOpened.
    // Only `lmd` + ExceptionType means "refused".
    const svc = makeService([{
      type: 'DialogOpened', formId: 'D1',
      controlTree: {
        t: 'lf', ServerId: 'D1', Caption: 'Trial Balance', PageType: 6, IsModal: true,
        MappingHint: 'RequestPage',
        Children: [{ t: 'sc', Caption: 'Show', StringValue: 'Net Change', Visible: true }],
      },
    } as BCEvent]);
    const r = await svc.openPage('6');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.isModal).toBe(true);
    expect(r.value.caption).toBe('Trial Balance');
  });
});
