// src/services/repeater-sync.ts
//
// Re-read a page's repeater rows from the server and fold them into the projection.
//
// Why this exists as its own module: BC does not reliably announce that a row is
// gone. A row Delete answered "yes" on a confirmation dialog removes the record
// server-side and sends NOTHING that identifies the removed row — verified live on
// SaaS (2026-08-09): after confirming, the same context still listed the line while a
// freshly opened context did not. Trusting the event stream therefore leaves stale
// rows that a later bookmark action turns into an InvalidBookmarkException.
//
// The recipe is the same one PageService uses when it first loads a subpage, and both
// halves are required:
//   - `LoadForm { openForm: true, loadData: true }` — a plain `loadData` is a NO-OP on a
//     form that already loaded (`LoadFormInteraction.CanLoadData()` returns false once
//     DataLoaded is true), so the form must be reset first.
//   - `InvokeAction(Refresh)` ON THE REPEATER — a subpage repeater does not re-emit
//     DataLoaded for a LoadForm alone.
//
// A RE-SYNC CAN OPEN A DIALOG, and that dialog used to vanish. Measured live on devel1
// (2026-10-03): on a page holding an unsaved change the Refresh comes back with
// `DialogToShow { MappingHint: 'ConfirmDialog', Message: "La página contiene cambios no
// guardados. ¿Desea descartar estos cambios?" }`. Its events were applied and thrown
// away — the operation reported `dialogsOpened: []` while BC held a modal the caller had
// never heard of. The next call then died with LogicalModalityViolation, and an action
// that had failed showed nothing but that question (bc-saas F-44 / F-45). So every
// dialog a re-sync raises is now SETTLED here: the side effect is ours, so it is undone
// with the answer that changes nothing (`No` to a confirm — verified live: the page stays
// open with its changes; `Ok` to an error/message box). A dialog of any other kind is
// not ours to answer and is returned for the caller to see.

import { isErr } from '../core/result.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';
import { SystemAction } from '../protocol/types.js';
import type { BCEvent, DialogOpenedEvent, InvokeActionInteraction } from '../protocol/types.js';
import { classifyDialog } from '../protocol/mutation-result.js';

export interface ResyncOutcome {
  /** False when BC refused either half, or a dialog stopped it; the projection is then no fresher than it was. */
  refreshed: boolean;
  /** Dialogs the re-sync raised and could NOT settle: they are open, and the caller must report them. */
  openDialogs: DialogOpenedEvent[];
  /** Every event the re-sync produced (messages included), for the caller's reporting. */
  events: BCEvent[];
}

/** Housekeeping invokes never adopt a dialog BC pushed for the caller. */
const NO_CARRY = { carryUnsolicited: false } as const;
const MAX_SETTLE_DEPTH = 3;

/**
 * Answer the dialogs a housekeeping invoke raised, with the answer that changes
 * nothing. Returns the ones that are not ours to answer (still open).
 */
async function settleSideEffectDialogs(
  session: BCSession,
  repo: PageContextRepository,
  pageContextId: string,
  events: readonly BCEvent[],
  collected: BCEvent[],
  logger?: Logger,
  depth = 0,
): Promise<DialogOpenedEvent[]> {
  const unresolved: DialogOpenedEvent[] = [];
  for (const e of events) {
    if (e.type !== 'DialogOpened') continue;
    const kind = classifyDialog(e.controlTree);
    const answer = kind === 'confirm' ? SystemAction.No
      : (kind === 'error' || kind === 'message') ? SystemAction.Ok
        : undefined;
    if (answer === undefined || depth >= MAX_SETTLE_DEPTH) {
      unresolved.push(e);
      continue;
    }
    const res = await session.invoke(
      { type: 'InvokeAction', formId: e.formId, controlPath: 'server:c[0]', systemAction: answer } as InvokeActionInteraction,
      (ev) => ev.type === 'InvokeCompleted',
      undefined,
      NO_CARRY,
    );
    if (isErr(res)) {
      logger?.warn(`[resync] could not settle the ${kind} dialog ${e.formId} a re-sync raised: ${res.error.message}`);
      unresolved.push(e);
      continue;
    }
    logger?.info(`[resync] the re-sync raised a ${kind} dialog (formId=${e.formId}); answered ${answer === SystemAction.No ? 'No' : 'Ok'} so nothing changes`);
    // BC never announces that an answered dialog closed: untrack it on both sides.
    session.removeOpenForm(e.formId);
    repo.removeDialog(pageContextId, e.formId);
    repo.applyToPage(pageContextId, res.value);
    collected.push(...res.value);
    unresolved.push(...await settleSideEffectDialogs(session, repo, pageContextId, res.value, collected, logger, depth + 1));
  }
  return unresolved;
}

/** Re-sync ONE form's repeater. */
export async function resyncRepeater(
  session: BCSession,
  repo: PageContextRepository,
  pageContextId: string,
  formId: string,
  repeaterControlPath: string,
  logger?: Logger,
): Promise<ResyncOutcome> {
  const events: BCEvent[] = [];
  const openDialogs: DialogOpenedEvent[] = [];

  const load = await session.invoke(
    { type: 'LoadForm', formId, loadData: true, delayed: false, openForm: true },
    (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    undefined,
    NO_CARRY,
  );
  if (isErr(load)) {
    logger?.warn(`[resync] LoadForm failed for form ${formId}: ${load.error.message}`);
    return { refreshed: false, openDialogs, events };
  }
  repo.applyToPage(pageContextId, load.value);
  events.push(...load.value);
  openDialogs.push(...await settleSideEffectDialogs(session, repo, pageContextId, load.value, events, logger));
  // A dialog we could not settle is now the top modal: anything else sent to this
  // form would violate modality. Stop and let the caller deal with it.
  if (openDialogs.length > 0) return { refreshed: false, openDialogs, events };

  const refresh = await session.invoke(
    { type: 'InvokeAction', formId, controlPath: repeaterControlPath, systemAction: SystemAction.Refresh } as InvokeActionInteraction,
    (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    undefined,
    NO_CARRY,
  );
  if (isErr(refresh)) {
    logger?.warn(`[resync] repeater Refresh failed for form ${formId}: ${refresh.error.message}`);
    return { refreshed: false, openDialogs, events };
  }
  repo.applyToPage(pageContextId, refresh.value);
  events.push(...refresh.value);
  const settled = await settleSideEffectDialogs(session, repo, pageContextId, refresh.value, events, logger);
  openDialogs.push(...settled);
  // A confirm we answered "No" cancelled the Refresh: the rows were NOT re-read.
  const refreshCancelled = refresh.value.some(e => e.type === 'DialogOpened');
  return { refreshed: !refreshCancelled && openDialogs.length === 0, openDialogs, events };
}

/**
 * The part of a re-sync the CALLER must hear about: messages BC raised and the
 * dialogs that are still open. Data events are already folded into the projection,
 * and a dialog the re-sync settled is closed — reporting it would ask the caller to
 * answer a dialog that no longer exists.
 */
export function reportableResyncEvents(outcome: Pick<ResyncOutcome, 'openDialogs' | 'events'>): BCEvent[] {
  return [...outcome.events.filter(e => e.type === 'MessageToShow'), ...outcome.openDialogs];
}

/**
 * Re-sync every repeater-bearing section of a page.
 *
 * Used after a dialog answer, where the answer may have committed a destructive
 * change (the "Confirmar" prompt of a line delete) without saying which row went.
 * Wizard pages are skipped: a NavigatePage has no repeater worth reloading and a
 * Refresh mid-wizard is a needless poke at a modal flow.
 */
export async function resyncPageRepeaters(
  session: BCSession,
  repo: PageContextRepository,
  pageContextId: string,
  logger?: Logger,
): Promise<Omit<ResyncOutcome, 'refreshed'>> {
  const outcome: Omit<ResyncOutcome, 'refreshed'> = { openDialogs: [], events: [] };
  const ctx = repo.get(pageContextId);
  if (!ctx || ctx.wizardState) return outcome;

  const targets = [...ctx.sections.values()]
    .filter(s => s.valid && s.repeaterControlPath && ctx.forms.has(s.formId))
    .map(s => ({ formId: s.formId, path: s.repeaterControlPath! }));

  // De-dupe: several sections can share one form.
  const seen = new Set<string>();
  for (const t of targets) {
    const key = `${t.formId}|${t.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await resyncRepeater(session, repo, pageContextId, t.formId, t.path, logger);
    outcome.events.push(...r.events);
    outcome.openDialogs.push(...r.openDialogs);
    // A dialog is up: sending more to the page now would violate modality. And one
    // we settled means the page holds unsaved changes: every other repeater would
    // ask the same question, so stop asking.
    if (r.openDialogs.length > 0 || r.events.some(e => e.type === 'DialogOpened')) break;
  }
  return outcome;
}
