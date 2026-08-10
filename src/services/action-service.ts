import { v4 as uuid } from 'uuid';
import { ok, err, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type { BCEvent, InvokeActionInteraction, SetCurrentRowInteraction, RepeaterRow } from '../protocol/types.js';
import { SystemAction } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import type { FormState } from '../protocol/form-state.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import { actions as treeActions, groupVisibility as treeGroupVisibility, cues as treeCues } from '../protocol/form-views.js';
import { classifyWizardNav, pickWizardNavAction } from '../protocol/wizard-classify.js';
import type { Logger } from '../core/logger.js';
import { resyncRepeater } from './repeater-sync.js';

/** System actions that target a specific row via the repeater control. */
const ROW_TARGETING_ACTIONS: Set<number> = new Set([
  SystemAction.Delete, SystemAction.Edit, SystemAction.View,
  SystemAction.DrillDown, SystemAction.New,
]);

/** Map well-known action names to their system action codes. */
const SYSTEM_ACTION_NAMES: Map<string, number> = new Map([
  ['new', SystemAction.New],
  ['delete', SystemAction.Delete],
  ['refresh', SystemAction.Refresh],
  ['edit', SystemAction.Edit],
  ['view', SystemAction.View],
]);

export interface ActionResult {
  success: boolean;
  events: BCEvent[];
  dialog?: { formId: string; controlTree: unknown };
  updatedState?: PageContext;
  /**
   * Row-delete outcome, verified against the repeater re-read from the server:
   * `true` the row is gone, `false` BC completed the action and the row survived.
   * Absent when the action was not a bookmark-targeted Delete, or when a dialog is
   * pending (the delete is not resolved yet — answer it, then re-read).
   */
  deleted?: boolean;
  /** Human-readable explanation when an action completed without doing what it says. */
  note?: string;
}

export class ActionService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async executeAction(
    pageContextId: string,
    actionName: string,
    sectionId?: string,
    row?: { bookmark?: string; rowIndex?: number },
  ): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));

    // Resolve the section to find actions in that form
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form } = resolved;
    const allActions = treeActions(form.root);

    // Well-known SystemAction fast path
    const systemActionByName = SYSTEM_ACTION_NAMES.get(actionName.toLowerCase());
    if (systemActionByName !== undefined) {
      return this.executeSystemAction(pageContextId, systemActionByName, sectionId, row);
    }

    const lower = actionName.toLowerCase();
    const actionNode = allActions.find(a => (a.properties.caption ?? '').toLowerCase() === lower);
    if (!actionNode) {
      // Provide the cross-section hint
      for (const [otherId, otherSection] of ctx.sections) {
        if (otherId === (sectionId ?? 'header')) continue;
        const otherForm = ctx.forms.get(otherSection.formId);
        if (otherForm && treeActions(otherForm.root).some(a => (a.properties.caption ?? '').toLowerCase() === lower)) {
          return err(new ProtocolError(
            `Action '${actionName}' not found in section '${sectionId ?? 'header'}'. It exists in section '${otherId}'. Use section: '${otherId}' to target it.`,
            { availableSections: Array.from(ctx.sections.keys()) },
          ));
        }
      }
      const groupVis = treeGroupVisibility(form.root);
      return err(new ProtocolError(`Action not found: ${actionName}`, {
        availableActions: allActions
          .filter(a => (a.properties.enabled ?? true) && isEffectivelyVisible(form.root, a.controlPath, groupVis, ctx.wizardState))
          .map(a => a.properties.caption ?? '')
          .filter(Boolean),
      }));
    }
    if (actionNode.properties.enabled === false) {
      return err(new ProtocolError(`Action is disabled: ${actionName}`));
    }

    // If the caller named a specific row for this (row-scoped) action, position
    // the cursor there first, then re-find the action on the refreshed tree so
    // it operates on THAT row instead of whatever row BC currently has selected.
    if (row && (row.bookmark !== undefined || row.rowIndex !== undefined) && resolved.repeater) {
      const bm = this.resolveBookmark(resolved.rows, row.bookmark, row.rowIndex);
      if (isErr(bm)) return bm;
      const pos = await this.positionRow(pageContextId, form.formId, resolved.repeater.controlPath, bm.value);
      if (isErr(pos)) return pos;
      const ctx2 = this.repo.get(pageContextId);
      const re = ctx2 ? resolveSection(ctx2, sectionId, 'header') : undefined;
      if (!re || 'error' in re) {
        return err(new ProtocolError(
          `Section '${sectionId ?? 'header'}' became unavailable after selecting the row; the action was NOT executed. Re-read the page and retry.`,
        ));
      }
      const refreshed = treeActions(re.form.root).find(a => (a.properties.caption ?? '').toLowerCase() === lower);
      if (!refreshed) {
        // Do NOT fall back to the pre-positioning controlPath: BC rearranges action
        // paths after a row selection, so the stale path points at a DIFFERENT
        // action (or out of range) — exactly the fragility documented in
        // NavigationService.drillDown. Refuse instead of invoking something else.
        return err(new ProtocolError(
          `Action '${actionName}' disappeared after selecting the row, so its control path is no longer trustworthy; nothing was invoked. ` +
          `Re-read the page (bc_read_data) and retry — the action may only be available for other rows.`,
          {
            availableActions: treeActions(re.form.root)
              .filter(a => a.properties.enabled ?? true)
              .map(a => a.properties.caption ?? '')
              .filter(Boolean),
          },
        ));
      }
      return this.invokeAction(pageContextId, re.form, refreshed.controlPath, refreshed.systemAction);
    }

    return this.invokeAction(pageContextId, form, actionNode.controlPath, actionNode.systemAction);
  }

  /**
   * Drill down on a cue tile (stackc) inside a Role Center / CardPart cuegroup
   * (stackgc). Sends `InvokeAction(DrillDown=120)` against the cue's
   * controlPath; BC opens the underlying list page as a `FormCreated` event.
   *
   * Reference: `RepeaterControl` / cue tile drill-down protocol — cues use
   * the same DrillDown SystemAction as repeater rows.
   */
  async executeOnCue(
    pageContextId: string,
    sectionId: string,
    cueName: string,
  ): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));

    const section = ctx.sections.get(sectionId);
    if (!section || !section.valid) {
      return err(new ProtocolError(`Section '${sectionId}' not found.`, {
        availableSections: Array.from(ctx.sections.keys()),
      }));
    }

    const form = ctx.forms.get(section.formId);
    if (!form) return err(new ProtocolError(`Form for section '${sectionId}' not loaded.`));

    const want = cueName.toLowerCase();
    const cueList = treeCues(form.root);
    const cue = cueList.find((c) => c.caption.toLowerCase() === want);
    if (!cue) {
      return err(new ProtocolError(`Cue '${cueName}' not found in section '${sectionId}'.`, {
        availableCues: cueList.map((c) => c.caption),
      }));
    }
    if (!cue.hasAction) {
      return err(new ProtocolError(`Cue '${cueName}' is not drill-downable (HasAction=false).`));
    }

    // Cue drill-down opens an underlying list page as a top-level FormCreated
    // event (no parentFormId). invokeAction registers each ownerless FormCreated
    // as its own page context (prefix "cue"), so ExecuteActionOperation.openedPages
    // picks it up. Without that the new list page never gets a pageContextId.
    return this.invokeAction(pageContextId, form, cue.controlPath, SystemAction.DrillDown, 'cue');
  }

  /**
   * Drive a NavigatePage wizard by semantic step (`back` / `next` / `finish` / `cancel`).
   * The matching action's controlPath is resolved from the parser's `wizardNav` tag.
   *
   * Reference: `Microsoft.Dynamics.Framework.UI.NavigatePageActionControlHelper.cs`
   * — BC's own client classifies these by icon resource, not SystemAction.
   */
  async executeWizardNav(
    pageContextId: string,
    nav: 'back' | 'next' | 'finish' | 'cancel',
  ): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));

    const root = ctx.forms.get(ctx.rootFormId);
    if (!root) return err(new ProtocolError(`Root form not found for page ${pageContextId}`));

    const allActions = treeActions(root.root);
    // Document order must not decide which action a semantic role maps to: for
    // 'cancel' the true abort actions win (see pickWizardNavAction).
    const actionNode = pickWizardNavAction(allActions, nav);
    if (!actionNode) {
      const available = allActions.map(a => classifyWizardNav(a)).filter(Boolean);
      return err(new ProtocolError(
        `No wizard action of type '${nav}' on this page (page is ${ctx.pageType}, isModal=${ctx.isModal})`,
        { availableWizardNav: available },
      ));
    }
    if (actionNode.properties.enabled === false) {
      return err(new ProtocolError(`Wizard action '${nav}' is disabled at this step`));
    }

    const result = await this.invokeAction(pageContextId, root, actionNode.controlPath, actionNode.systemAction);

    // BC's web client owns the step variable client-side and emits no
    // PropertyChanged events when Next/Back fires. Mirror the step transition
    // ourselves so subsequent reads see the right step's fields. Only nudge on
    // forward/back; finish & cancel close the wizard server-side.
    //
    // A dialog in the response means BC BLOCKED the navigation (a validation
    // message on the step being left): the wizard did not move, so bumping the
    // mirrored index would desync it and make the active-step visibility override
    // describe the wrong step's subtree.
    if (isOk(result) && result.value.dialog) {
      this.logger.info(`[wizard] '${nav}' opened a dialog (formId=${result.value.dialog.formId}); step index NOT advanced.`);
    }
    if (isOk(result) && !result.value.dialog && (nav === 'next' || nav === 'back')) {
      const ws = this.repo.get(pageContextId)?.wizardState;
      if (ws) {
        const delta = nav === 'next' ? 1 : -1;
        const target = ws.currentStepIndex + delta;
        if (target >= 0 && target < ws.stepPaths.length) {
          this.repo.advanceWizardStep(pageContextId, target);
          // Refresh updatedState so the caller sees post-bump visibility.
          const refreshed = this.repo.get(pageContextId);
          if (refreshed) {
            return ok({ ...result.value, updatedState: refreshed });
          }
        }
      }
    }

    return result;
  }

  async executeSystemAction(
    pageContextId: string,
    systemAction: number,
    sectionId?: string,
    row?: { bookmark?: string; rowIndex?: number },
  ): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    let form = resolved.form;
    let repeater = resolved.repeater;

    // Row targeting: when the caller names a specific row (bookmark or rowIndex)
    // for a row-scoped action (Delete/Edit/View/DrillDown/New), position the
    // cursor on THAT row first. Without this the action hits whatever row BC
    // currently has selected -- e.g. Delete would remove the wrong record.
    let deletedBookmark: string | undefined;
    if (repeater && ROW_TARGETING_ACTIONS.has(systemAction) && row && (row.bookmark !== undefined || row.rowIndex !== undefined)) {
      const bm = this.resolveBookmark(resolved.rows, row.bookmark, row.rowIndex);
      if (isErr(bm)) return bm;
      // Remembered so the post-delete re-sync can check whether the row really went.
      deletedBookmark = bm.value;
      const pos = await this.positionRow(pageContextId, form.formId, repeater.controlPath, bm.value);
      if (isErr(pos)) return pos;
      // The repo replaced the context after SetCurrentRow -- re-resolve.
      const ctx2 = this.repo.get(pageContextId);
      if (!ctx2) return err(new ProtocolError('State lost after row selection'));
      const re = resolveSection(ctx2, sectionId);
      if ('error' in re) return err(new ProtocolError(re.error, { availableSections: re.availableSections }));
      form = re.form;
      repeater = re.repeater;
    }

    // For row-targeting actions on pages with a repeater, use the repeater's controlPath
    let controlPath: string;
    if (repeater && ROW_TARGETING_ACTIONS.has(systemAction)) {
      controlPath = repeater.controlPath + '/cr/c[0]';
    } else {
      const action = treeActions(form.root).find(a => a.systemAction === systemAction);
      if (!action) {
        // NEVER guess `server:c[0]`: that invokes whatever DefaultAction resolves at
        // the first control of the form — an arbitrary action — and reported success.
        const available = treeActions(form.root)
          .filter(a => a.systemAction !== 0)
          .map(a => ({ name: a.properties.caption ?? '', systemAction: a.systemAction, enabled: a.properties.enabled ?? true }));
        return err(new ProtocolError(
          `No action with systemAction=${systemAction} on section '${resolved.section.sectionId}' of ${pageContextId}` +
          (repeater ? '' : ' (and the section has no repeater, so it cannot be a row action)') + '.',
          { requestedSystemAction: systemAction, availableSystemActions: available },
        ));
      }
      controlPath = action.controlPath;
    }

    const result = await this.invokeAction(pageContextId, form, controlPath, systemAction);

    // B4: after deleting a repeater row, re-sync the repeater from the server instead
    // of trusting an incremental removal event. BC does NOT reliably announce the
    // removal (verified live on devel1: a row Delete produced InvokeCompleted and
    // PropertyChanged, and no row-change payload at all), so the deleted row stayed
    // in the projection and a later bookmark action on it would hit
    // InvalidBookmarkException. A full reload is cheap next to a destructive action
    // and makes the client state true regardless of the wire shape.
    // ...but ONLY once BC has actually finished the delete. A row delete on an
    // editable document opens a "Confirmar" dialog, and the re-sync is itself an
    // InvokeAction: firing it while that modal is pending tears the dialog down, so
    // the caller's bc_respond_dialog then dies with FormNotFoundException and the
    // row is never deleted (verified live on devel1, page 42 in Edit mode). When a
    // dialog is pending the row state is answered by RespondDialogOperation, which
    // re-syncs after the answer.
    if (isOk(result) && repeater && systemAction === SystemAction.Delete && !result.value.dialog) {
      const refreshed = await resyncRepeater(this.session, this.repo, pageContextId, form.formId, repeater.controlPath, this.logger);
      if (refreshed) {
        const ctx3 = this.repo.get(pageContextId);
        if (ctx3) {
          // BC can complete a Delete and change nothing — a row it will not delete
          // (a blank placeholder, a read-only document) answers with a bare
          // InvokeCompleted: no dialog, no row change, no error. Reporting plain
          // success there is the same lie `bc_write_data` was fixed for, so say it:
          // the re-synced rows are ground truth, so if the bookmark survived, the
          // delete did not happen.
          const targetBookmark = deletedBookmark;
          if (targetBookmark) {
            const re2 = resolveSection(ctx3, sectionId);
            const stillThere = !('error' in re2)
              && re2.rows.some(r => r.bookmark === targetBookmark);
            if (stillThere) {
              return ok({
                ...result.value,
                updatedState: ctx3,
                deleted: false,
                note: 'BC completed the Delete without removing the row: it is still present after re-reading the repeater from the server. '
                  + 'Common causes: the row is an uncommitted blank placeholder, or the page is not open for editing (open it with mode "Edit").',
              });
            }
          }
          return ok({ ...result.value, updatedState: ctx3, ...(targetBookmark ? { deleted: true } : {}) });
        }
      }
    }

    return result;
  }

  /** Resolve a bookmark from an explicit bookmark or a 0-based rowIndex into the loaded rows. */
  private resolveBookmark(rows: readonly RepeaterRow[], bookmark?: string, rowIndex?: number): Result<string, ProtocolError> {
    if (bookmark !== undefined) return ok(bookmark);
    if (rowIndex !== undefined) {
      const r = rows[rowIndex];
      if (!r) return err(new ProtocolError(`Row index ${rowIndex} out of range. Loaded rows: 0-${rows.length - 1}. Load more with bc_read_data range first.`));
      return ok(r.bookmark);
    }
    return err(new ProtocolError('No bookmark or rowIndex provided for row-scoped action'));
  }

  /** Position the repeater cursor on a row (SetCurrentRow) before a row-scoped action. */
  private async positionRow(pageContextId: string, formId: string, repeaterControlPath: string, bookmark: string): Promise<Result<void, ProtocolError>> {
    const interaction: SetCurrentRowInteraction = {
      type: 'SetCurrentRow', formId, controlPath: repeaterControlPath, key: bookmark,
    };
    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
    );
    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);
    return ok(undefined);
  }

  private async invokeAction(
    pageContextId: string,
    form: FormState,
    controlPath: string,
    systemAction: number,
    spawnPrefix: string = 'action',
  ): Promise<Result<ActionResult, ProtocolError>> {
    const interaction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: form.formId,
      controlPath,
      systemAction,
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted',
    );

    if (isErr(result)) return result;

    const events = result.value;
    this.repo.applyToPage(pageContextId, events);

    // Register any ownerless new form (New card, drill-down target, cue page) as
    // its own page context so callers get a usable pageContextId in openedPages.
    // BC delivers these as top-level FormCreated with no parentFormId; the repo's
    // applyEvent treats ownerless FormCreated as "update existing form", so
    // without this the new page never gets a pageContextId -- it is unreachable
    // and uncloseable via MCP, and the source context's form map gets polluted.
    for (const event of events) {
      if (event.type !== 'FormCreated') continue;
      if (event.parentFormId) continue;
      if (event.formId === form.formId) continue;
      if (this.repo.getByFormId(event.formId)) continue;
      const newPcId = `session:page:${spawnPrefix}:${uuid().substring(0, 8)}`;
      this.repo.create(newPcId, event.formId);
      this.repo.applyToPage(newPcId, events);
    }

    // Check for dialog
    const dialogEvent = events.find(e => e.type === 'DialogOpened');
    const dialog = dialogEvent?.type === 'DialogOpened'
      ? { formId: dialogEvent.formId, controlTree: dialogEvent.controlTree }
      : undefined;

    this.logger.info(`Action executed on ${pageContextId}: systemAction=${systemAction}, controlPath=${controlPath}`);

    return ok({
      success: true,
      events,
      dialog,
      updatedState: this.repo.get(pageContextId) ?? undefined,
    });
  }
}
