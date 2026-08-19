import { describe, it, expect } from 'vitest';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { RespondDialogSchema } from '../../src/mcp/schemas.js';
import { ok } from '../../src/core/result.js';

const logger = { info(){}, warn(){}, error(){}, debug(){} } as never;

/**
 * bc-saas F-39 §5: the dialog accepted `fields`, dropped them, ran on BC's DEFAULT
 * values and answered success:true — copying the wrong document and putting ~50 wrong
 * lines into an order. The rule these tests pin down is that BC never gets to run a
 * dialog on values other than the ones the caller asked for.
 */
function makeCtx(dialogFormId = 'dlg1') {
  return {
    pageContextId: 'pc1',
    rootFormId: 'root',
    sections: new Map([
      ['header', { sectionId: 'header', kind: 'header', caption: 'H', formId: 'root', valid: true }],
      ['dialog', { sectionId: 'dialog', kind: 'dialog', caption: 'D', formId: dialogFormId, valid: true }],
    ]),
  };
}

function makeRepo(ctx: unknown) {
  return {
    get: () => ctx,
    notFoundError: () => new Error('nf'),
    applyToPage: () => {},
    removeDialog: () => {},
    getByFormId: () => undefined,
  } as never;
}

const session = {
  invoke: async () => ok([{ type: 'InvokeCompleted' }]),
} as never;

describe('bc_respond_dialog applies the fields it is given', () => {
  it('advertises `fields` in its schema at all (it silently did not)', () => {
    const shape = (RespondDialogSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toContain('fields');
  });

  it('writes the fields into the DIALOG section before answering', async () => {
    const written: Array<{ pcId: string; fields: Record<string, string>; sectionId?: string }> = [];
    const dataService = {
      writeFields: async (pcId: string, fields: Record<string, string>, opts?: { sectionId?: string }) => {
        written.push({ pcId, fields, sectionId: opts?.sectionId });
        return ok({
          results: Object.keys(fields).map(f => ({ fieldName: f, controlPath: 'p', success: true, changed: true })),
          events: [],
        });
      },
    } as never;

    const op = new RespondDialogOperation(session, makeRepo(makeCtx()), logger, dataService);
    const r = await op.execute({
      pageContextId: 'pc1', dialogFormId: 'dlg1', response: 'ok',
      fields: { 'Nº documento': '101004', 'Incluir cabecera': 'No' },
    });

    expect(r.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]?.sectionId).toBe('dialog');
    expect(written[0]?.fields).toEqual({ 'Nº documento': '101004', 'Incluir cabecera': 'No' });
    if (r.ok) expect(r.value.fieldResults).toHaveLength(2);
  });

  it('does NOT answer the dialog when a field did not take', async () => {
    let answered = false;
    const spySession = {
      invoke: async () => { answered = true; return ok([{ type: 'InvokeCompleted' }]); },
    } as never;
    const dataService = {
      writeFields: async () => ok({
        results: [
          { fieldName: 'Nº documento', controlPath: 'p', success: true, changed: true },
          { fieldName: 'Recalcular líneas', controlPath: 'q', success: true, changed: false, reason: 'validation reverted' },
        ],
        events: [],
      }),
    } as never;

    const op = new RespondDialogOperation(spySession, makeRepo(makeCtx()), logger, dataService);
    const r = await op.execute({
      pageContextId: 'pc1', dialogFormId: 'dlg1', response: 'ok',
      fields: { 'Nº documento': '101004', 'Recalcular líneas': 'Sí' },
    });

    expect(r.ok).toBe(false);
    expect(answered).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('was NOT answered');
      expect(r.error.message).toContain('Recalcular líneas');
    }
  });

  it('treats an UNVERIFIED field as acceptable, not as a failure', async () => {
    const dataService = {
      writeFields: async () => ok({
        results: [{ fieldName: 'F', controlPath: 'p', success: true, changed: undefined, reason: 'unverified' }],
        events: [],
      }),
    } as never;
    const op = new RespondDialogOperation(session, makeRepo(makeCtx()), logger, dataService);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'dlg1', response: 'ok', fields: { F: '1' } });
    expect(r.ok).toBe(true);
  });

  it('refuses fields on a dialog that is being dismissed', async () => {
    const op = new RespondDialogOperation(session, makeRepo(makeCtx()), logger, {} as never);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'dlg1', response: 'cancel', fields: { F: '1' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('does not take values');
  });

  it('matches the dialog by formId, not by section name', async () => {
    // The open dialog is `dialog#2`; a name-based lookup would fill the wrong one.
    const ctx = {
      pageContextId: 'pc1', rootFormId: 'root',
      sections: new Map([
        ['dialog', { sectionId: 'dialog', kind: 'dialog', caption: 'other', formId: 'OTHER', valid: true }],
        ['dialog#2', { sectionId: 'dialog#2', kind: 'dialog', caption: 'D', formId: 'dlg1', valid: true }],
      ]),
    };
    let usedSection: string | undefined;
    const dataService = {
      writeFields: async (_p: string, f: Record<string, string>, o?: { sectionId?: string }) => {
        usedSection = o?.sectionId;
        return ok({ results: Object.keys(f).map(n => ({ fieldName: n, controlPath: 'p', success: true, changed: true })), events: [] });
      },
    } as never;
    const op = new RespondDialogOperation(session, makeRepo(ctx), logger, dataService);
    await op.execute({ pageContextId: 'pc1', dialogFormId: 'dlg1', response: 'ok', fields: { F: '1' } });
    expect(usedSection).toBe('dialog#2');
  });

  it('errors clearly when the dialogFormId names no open dialog', async () => {
    const op = new RespondDialogOperation(session, makeRepo(makeCtx('dlgX')), logger, { writeFields: async () => ok({ results: [], events: [] }) } as never);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'nope', response: 'ok', fields: { F: '1' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('No open dialog section');
  });

  it('leaves the no-fields path exactly as it was', async () => {
    const op = new RespondDialogOperation(session, makeRepo(makeCtx()), logger, undefined);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'dlg1', response: 'yes' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fieldResults).toBeUndefined();
  });
});
