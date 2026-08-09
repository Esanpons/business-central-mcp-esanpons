// tests/integration/modal-recovery.test.ts
//
// Live verification of modal-stack tracking and reconcileModalStack against real BC.
//
// Trigger choice — REPLACED 2026-08-09 (roadmap A2). The previous fixture deleted a
// row of the Customer List, and on `devel1` (BC27) that completes with
// InvokeCompleted + PropertyChanged and NO DialogToShow at all. So this suite claimed
// to cover reconcileModalStack while never once building a modal stack — a test that
// could not fail for the right reason. Two other candidates fail the same way:
//   - Deleting a freshly created (empty) Sales Order: BC auto-discards it, silently.
//   - Tell Me (PageSearch=220): emits FormToShow -> FormCreated, never DialogToShow.
//
// What DOES open a true modal, every time and without touching any data: a report's
// REQUEST PAGE. `OpenForm { query: "report=6" }` (Trial Balance) arrives as a
// DialogOpened with MappingHint RequestPage, which is exactly what lands on the modal
// stack. The report is never run — the test opens the request page and reconciles.
//
// Each test gets a fresh BC session because a modal can be sticky server-side, so
// leaking one across tests would trip LogicalModalityViolation on the next OpenForm.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { FormsAuthProvider } from '../../src/connection/auth/forms-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import { BCSession } from '../../src/session/bc-session.js';
import { isOk, unwrap } from '../../src/core/result.js';
import type { BCEvent, OpenFormInteraction, DialogOpenedEvent } from '../../src/protocol/types.js';

async function createSession(): Promise<BCSession> {
  const logger = createNullLogger();
  const appConfig = loadConfig();
  const auth = new FormsAuthProvider({
    baseUrl: appConfig.bc.baseUrl,
    username: appConfig.bc.username,
    password: appConfig.bc.password,
    tenantId: appConfig.bc.tenantId,
  }, logger);
  const connFactory = new ConnectionFactory(auth, appConfig.bc, logger);
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(appConfig.bc.clientVersionString, appConfig.bc.applicationId);
  const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, appConfig.bc.tenantId);
  const result = await sessionFactory.create();
  expect(isOk(result)).toBe(true);
  return unwrap(result);
}

/**
 * Open report 6's request page. It arrives as a DialogOpened (MappingHint
 * RequestPage) and therefore pushes onto the modal stack. The report is never run,
 * so this touches no data.
 */
async function openReportRequestPage(session: BCSession): Promise<DialogOpenedEvent> {
  const open: OpenFormInteraction = {
    type: 'OpenForm',
    query: `report=6&tenant=${loadConfig().bc.tenantId}`,
    controlPath: 'server:c[0]',
  };
  const result = await session.invoke(
    open,
    (e) => e.type === 'DialogOpened' || e.type === 'InvokeCompleted',
  );
  expect(isOk(result)).toBe(true);
  const events: BCEvent[] = unwrap(result);
  const dialog = events.find((e): e is DialogOpenedEvent => e.type === 'DialogOpened');
  expect(
    dialog,
    `Expected a DialogOpened for the report request page. Got: ${events.map(e => e.type).join(',')}`,
  ).toBeDefined();
  if (!dialog) throw new Error('no dialog');
  return dialog;
}

describe('Modal stack reconciliation (integration)', () => {
  let session: BCSession;

  beforeEach(async () => {
    session = await createSession();
  }, 60_000);

  afterEach(async () => {
    await session?.closeGracefully().catch(() => { /* best effort */ });
  });

  it('tracks a modal DialogOpened on modalStack', async () => {
    expect(session.modalStackSnapshot()).toEqual([]);

    const dialog = await openReportRequestPage(session);

    // The DialogOpened must have pushed onto modalStack and registered the formId
    // in openFormIds (both done by updateFormTracking).
    expect(session.modalStackSnapshot()).toContain(dialog.formId);
    expect(session.modalStackSnapshot()[session.modalStackSnapshot().length - 1]).toBe(dialog.formId);
    expect(session.openFormIds.has(dialog.formId)).toBe(true);
  }, 60_000);

  it('reconcileModalStack walks an open modal stack and clears it', async () => {
    expect(session.modalStackSnapshot()).toEqual([]);

    const dialog = await openReportRequestPage(session);
    expect(session.modalStackSnapshot()).toContain(dialog.formId);
    expect(session.modalStackSnapshot().length).toBeGreaterThan(0);

    // Reconcile answers each modal in turn (No -> Cancel -> Abort -> CloseForm; see
    // B1) and only force-pops when BC refuses every one. Either way the local stack
    // must end empty and the modal must be gone from openFormIds.
    const reconcile = await session.reconcileModalStack();
    expect(isOk(reconcile)).toBe(true);
    expect(session.modalStackSnapshot()).toEqual([]);
    expect(session.openFormIds.has(dialog.formId)).toBe(false);
  }, 60_000);

  it('leaves the session usable after reconciling — the real point of the fix', async () => {
    await openReportRequestPage(session);
    const reconcile = await session.reconcileModalStack();
    expect(isOk(reconcile)).toBe(true);

    // B1: before the fix, a modal BC kept open server-side made the NEXT interaction
    // raise LogicalModalityViolation, which degraded into a full session reset and
    // lost every open page. Opening a plain page here must simply work.
    const open: OpenFormInteraction = {
      type: 'OpenForm',
      query: `page=22&tenant=${loadConfig().bc.tenantId}`,
      controlPath: 'server:c[0]',
    };
    const after = await session.invoke(open, (e) => e.type === 'InvokeCompleted');
    expect(isOk(after), 'a page must still open after reconciling the modal stack').toBe(true);
    expect(session.isAlive).toBe(true);
  }, 60_000);
});
