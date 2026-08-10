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

import { isErr } from '../core/result.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';
import { SystemAction } from '../protocol/types.js';
import type { InvokeActionInteraction } from '../protocol/types.js';

/**
 * Re-sync ONE form's repeater. Returns false when BC refused either half; the caller
 * decides whether that is fatal (it usually is not — the projection is simply no
 * fresher than it was).
 */
export async function resyncRepeater(
  session: BCSession,
  repo: PageContextRepository,
  pageContextId: string,
  formId: string,
  repeaterControlPath: string,
  logger?: Logger,
): Promise<boolean> {
  const load = await session.invoke(
    { type: 'LoadForm', formId, loadData: true, delayed: false, openForm: true },
    (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
  );
  if (isErr(load)) {
    logger?.warn(`[resync] LoadForm failed for form ${formId}: ${load.error.message}`);
    return false;
  }
  repo.applyToPage(pageContextId, load.value);

  const refresh = await session.invoke(
    { type: 'InvokeAction', formId, controlPath: repeaterControlPath, systemAction: SystemAction.Refresh } as InvokeActionInteraction,
    (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
  );
  if (isErr(refresh)) {
    logger?.warn(`[resync] repeater Refresh failed for form ${formId}: ${refresh.error.message}`);
    return false;
  }
  repo.applyToPage(pageContextId, refresh.value);
  return true;
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
): Promise<void> {
  const ctx = repo.get(pageContextId);
  if (!ctx || ctx.wizardState) return;

  const targets = [...ctx.sections.values()]
    .filter(s => s.valid && s.repeaterControlPath && ctx.forms.has(s.formId))
    .map(s => ({ formId: s.formId, path: s.repeaterControlPath! }));

  // De-dupe: several sections can share one form.
  const seen = new Set<string>();
  for (const t of targets) {
    const key = `${t.formId}|${t.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await resyncRepeater(session, repo, pageContextId, t.formId, t.path, logger);
  }
}
