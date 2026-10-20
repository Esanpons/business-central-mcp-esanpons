// bc-saas F-56: deleting a posted shipment that may not be deleted. BC raises no error
// dialog: after "yes" to "¿Eliminar ...?" it attaches the error to the record's card
// form as ValidationResults and then asks whether to discard the unsaved changes.
// Shapes below as measured live on devel1 (BC27, 2026-10-04, page 142 -> Delete).
import { describe, it, expect, vi } from 'vitest';
import { detectValidationErrors } from '../../src/protocol/mutation-result.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

const MSG = 'The date Allow Document Deletion Before must be set on the page Sales & Receivables Setup before deleting sales documents.';

const validationError: BCEvent = {
  type: 'PropertyChanged', formId: 'F2', controlPath: 'server:',
  changes: { ValidationResults: [{ Id: 1, Description: MSG, DescriptionShort: null, Severity: 'Error', IsLocal: true, OriginatingControl: { controlPath: 'server:', formId: 'F2' } }] },
} as BCEvent;

const discardConfirm: BCEvent = {
  type: 'DialogOpened', formId: 'F4',
  controlTree: { t: 'lmd', Caption: 'Confirmar', MappingHint: 'ConfirmDialog', DialogType: 5, ExceptionType: 0, Message: 'La página contiene cambios no guardados. ¿Desea descartar estos cambios?' },
} as BCEvent;

describe('detectValidationErrors', () => {
  it('returns the Error-severity entries with their text', () => {
    expect(detectValidationErrors([validationError, validationError])).toEqual([
      { message: MSG, severity: 'Error', formId: 'F2', controlPath: 'server:' },
    ]);
  });

  it('ignores cleared results and non-error severities', () => {
    const cleared = { type: 'PropertyChanged', formId: 'F2', controlPath: 'server:', changes: { ValidationResults: [] } } as BCEvent;
    const warning = { type: 'PropertyChanged', formId: 'F2', controlPath: 'server:c[1]', changes: { ValidationResults: [{ Description: 'Check it', Severity: 'Warning' }] } } as BCEvent;
    expect(detectValidationErrors([cleared, warning])).toEqual([]);
  });
});

describe('bc_respond_dialog reports the error of a refused delete (F-56)', () => {
  function setup() {
    const repo = new PageContextRepository();
    repo.create('pc', 'LIST');
    repo.applyToPage('pc', [
      { type: 'FormCreated', formId: 'LIST', controlTree: { t: 'lf', ServerId: 'LIST', PageType: 1, Caption: 'Posted Sales Shipments', Children: [] } } as BCEvent,
      { type: 'DialogOpened', formId: 'F3', controlTree: { t: 'lmd', MappingHint: 'ConfirmDialog', DialogType: 5, ExceptionType: 0, Message: '¿Eliminar NCV-000396?' } } as BCEvent,
    ]);
    const session = {
      invoke: async (i: BCInteraction) => ok([
        ...(i.type === 'InvokeAction' && i.formId === 'F3' ? [validationError, discardConfirm] : []),
        { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent,
      ]),
      removeOpenForm: vi.fn(),
    } as never;
    return { repo, op: new RespondDialogOperation(session, repo, { info() {}, warn() {}, error() {}, debug() {} } as never) };
  }

  it('success is false and errors carries BC\'s sentence', async () => {
    const { op } = setup();
    const r = await op.execute({ pageContextId: 'pc', dialogFormId: 'F3', response: 'yes' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.success).toBe(false);
    expect(r.value.errors?.[0]?.message).toBe(MSG);
    expect(r.value.dialogsOpened.map(d => d.kind)).toEqual(['confirm']);
  });

  it('the next dialog of the chain takes the plain "dialog" section id', async () => {
    const { op, repo } = setup();
    const r = await op.execute({ pageContextId: 'pc', dialogFormId: 'F3', response: 'yes' });
    expect(r.ok && r.value.dialogsOpened[0]?.sections).toEqual(['dialog']);
    expect(repo.get('pc')!.sections.get('dialog')?.formId).toBe('F4');
  });
});
