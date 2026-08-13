import { v4 as uuid } from 'uuid';
import { ok, err, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError, TimeoutError, ModalReconcileError } from '../core/errors.js';
import { RPC_TIMEOUT_CODE, type BCWebSocket } from '../connection/bc-websocket.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../protocol/types.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder, type EncodeContext } from '../protocol/interaction-encoder.js';
import { decompressPayload } from '../protocol/decompression.js';
import type { Logger } from '../core/logger.js';
import { ModalStack } from './modal-stack.js';

const DEFAULT_TIMEOUT_MS = 30000;
const QUIESCENCE_MS = 150; // Trailing window for async Message bursts

// Bounded extra wait when the caller's `expect` predicate has NOT matched by the
// end of the quiescence window. `expect` reads as a wait-contract, so honour it:
// keep listening in short slices while events are still arriving, and give up as
// soon as the stream goes idle. The common case (predicate already satisfied)
// never enters this loop; the anomalous case costs ~100ms before returning what
// it has.
const EXPECT_WAIT_MAX_MS = 500;
const EXPECT_WAIT_SLICE_MS = 50;
const EXPECT_WAIT_IDLE_SLICES = 2;

const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms));

export class BCSession {
  private queue: Promise<void> = Promise.resolve();
  private readonly _openFormIds = new Set<string>();
  private readonly modalStack = new ModalStack();
  private dead = false;
  /**
   * Stack of active async-event collectors, innermost last. Only the innermost
   * one receives frames: `invokeUnqueued` subscribes for its whole lifetime, and
   * the modal-violation retry path runs NESTED `invokeUnqueued` calls inside it,
   * so a single async `Message` frame used to be decoded by both collectors and
   * handed to the caller twice (duplicated DataLoaded => duplicated rows).
   */
  private readonly asyncSinks: BCEvent[][] = [];

  private sessionId = '';
  private sessionKey = '';
  private company = '';
  private _initialized = false;

  constructor(
    private readonly ws: BCWebSocket,
    private readonly decoder: EventDecoder,
    private readonly encoder: InteractionEncoder,
    private readonly logger: Logger,
    private readonly tenantId: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly profile: string = '',
    /**
     * SaaS (AAD) binds the tenant at session open and rejects `&tenant=` in an
     * OpenForm-style query -- the same rule `PageService.buildOpenFormQuery`
     * follows. Set by `SessionFactory` from the auth provider.
     */
    private readonly omitTenantInQueries: boolean = false,
  ) {}

  get openFormIds(): ReadonlySet<string> {
    return this._openFormIds;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get companyName(): string {
    return this.company;
  }

  /** Explicitly set the current company (e.g. after a confirmed ChangeCompany). */
  setCompany(company: string): void {
    if (company) this.company = company;
  }

  /**
   * Refresh cached session credentials (notably CompanyName) from decoded
   * SessionInfo events — emitted for SessionInit / CachedSessionInit and, after
   * a ChangeCompany, SessionSettingsChanged handlers. No-op if none carry a
   * company. Used by bc_switch_company to reflect the server-confirmed company.
   */
  applySessionInfo(events: BCEvent[]): void {
    for (const event of events) {
      if (event.type === 'SessionInfo') {
        this.extractSessionCredentials(event.sessionData);
      }
    }
  }

  get isAlive(): boolean {
    return !this.dead && this.ws.isConnected;
  }

  /**
   * @param company  Open the session ON this company (see encodeOpenSession). The
   *   company BC actually granted comes back in the response's `CompanyName` and is
   *   picked up by extractSessionCredentials below — which makes it the one piece of
   *   SERVER truth about the session's company that this protocol offers, and hence
   *   the only honest way to confirm a switch.
   */
  async initialize(tenantId: string, company?: string): Promise<Result<BCEvent[], ProtocolError>> {
    const openSessionCall = this.encoder.encodeOpenSession(tenantId, this.ws.spaInstanceId, this.profile, company);

    // Capture async Message bursts (e.g. a late license/evaluation dialog that
    // BC pushes as a notification rather than in the synchronous OpenSession
    // response) during the quiescence window below.
    const events: BCEvent[] = [];
    const unsubscribe = this.collectAsyncMessages(events);

    try {
      this.logger.debug('protocol', 'Sending OpenSession');
      const rpcResult = await this.ws.sendRpc(openSessionCall.method, openSessionCall.params, this.timeoutMs);
      if (isErr(rpcResult)) return rpcResult;

      const responseData = rpcResult.value;
      if (Array.isArray(responseData)) {
        events.push(...this.decoder.decode(responseData));
      }

      // Wait for async messages
      await new Promise(resolve => setTimeout(resolve, QUIESCENCE_MS));

      // Extract session credentials from response (recursively searches for fields)
      this.extractSessionCredentials(responseData);

      // Update form tracking (includes any async-delivered dialogs)
      this.updateFormTracking(events);

      this._initialized = true;

      // Auto-dismiss license notification dialogs (present on fresh/evaluation databases)
      const licenseDialog = this.findLicenseDialog(events);
      if (licenseDialog) {
        this.logger.info('Auto-dismissing license notification dialog');
        // `invoke` returns a Result -- it does NOT throw -- so the old try/catch
        // never fired and the error was discarded, after which removeOpenForm ran
        // unconditionally and dropped a dialog BC may well still hold open. Branch
        // on the Result instead, and KEEP the form tracked when the dismiss failed
        // so reconcileModalStack can abort it later.
        const dismissed = await this.invoke(
          { type: 'InvokeAction', formId: licenseDialog.formId, controlPath: 'server:', systemAction: 300 }, // Ok=300
          (e) => e.type === 'InvokeCompleted',
        ).catch((e: unknown) => err(new ProtocolError(e instanceof Error ? e.message : String(e))));
        if (isErr(dismissed)) {
          this.logger.warn(
            `Failed to auto-dismiss license dialog (formId=${licenseDialog.formId}): ${dismissed.error.message}. `
            + 'Keeping it in the modal stack so the next modal reconcile can close it.',
          );
        } else {
          // Clear from BOTH openFormIds and the modal stack. Using the raw Set
          // delete alone leaves a stale modalStack entry (the dialog was pushed
          // there by updateFormTracking), which the next modal reconcile would try
          // to Abort even though the form is gone.
          this.removeOpenForm(licenseDialog.formId);
        }
      }

      this.logger.info(`Session initialized: ${this.sessionId}, company: ${this.company}`);

      return ok(events);
    } finally {
      unsubscribe();
    }
  }

  private extractSessionCredentials(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data)) {
      for (const item of data) this.extractSessionCredentials(item);
      return;
    }
    const obj = data as Record<string, unknown>;
    if (typeof obj.ServerSessionId === 'string' && obj.ServerSessionId) {
      this.sessionId = obj.ServerSessionId;
    }
    if (typeof obj.SessionKey === 'string' && obj.SessionKey) {
      this.sessionKey = obj.SessionKey;
    }
    if (typeof obj.CompanyName === 'string' && obj.CompanyName) {
      this.company = obj.CompanyName;
    }
    for (const value of Object.values(obj)) {
      this.extractSessionCredentials(value);
    }
  }

  async invoke(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs?: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    // The timeout clock must start when the interaction is actually SENT, not
    // when it is enqueued. If withTimeout wraps the enqueued promise, time spent
    // waiting behind other queued invokes counts against this call's budget --
    // so under concurrent tool calls (HTTP handles requests concurrently; stdio
    // does not await line handlers) a call sitting in the queue can time out and
    // kill a perfectly healthy session. Wrapping withTimeout INSIDE the enqueued
    // task starts the clock only once this task reaches the head of the queue.
    return this.enqueue(async () => {
      // Re-check: this task may have been queued BEFORE another one killed the
      // session. Sending anyway means a guaranteed-useless RPC that still burns a
      // full timeout before failing.
      if (this.dead) return err(new ProtocolError('Session is dead'));
      try {
        return await this.withTimeout(
          (renew) => this.invokeUnqueued(interaction, expect, effectiveTimeout, renew),
          effectiveTimeout + 5000, // Session-level watchdog, 5s longer than one RPC
          `Invoke(${interaction.type})`,
        );
      } catch (e) {
        if (e instanceof TimeoutError) {
          return err(new ProtocolError(e.message));
        }
        throw e;
      }
    });
  }

  /**
   * Session-level watchdog around one invoke. It is a NO-PROGRESS timer, not a
   * total budget: `run` receives a `renew` callback that restarts the clock, and
   * calls it every time BC actually answers something.
   *
   * The fixed budget it replaces could not cover the modal-violation recovery
   * path, which legitimately runs up to 10 dialogs x 4 answers -- each a full
   * sendRpc -- plus the retry of the original interaction, all inside one invoke.
   * With a fixed `timeout + 5s` window that recovery was killed mid-way for
   * making progress too slowly. A hung BC still trips the timer, because nothing
   * renews it.
   */
  private withTimeout<T>(
    run: (renew: () => void) => Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const fire = () => {
        this.logger.error(`${label}: no response from BC for ${ms}ms, killing session`);
        this.kill();
        reject(new TimeoutError(`BC did not respond within ${ms / 1000}s. Session has been killed and will reconnect on next request.`));
      };
      let timer: ReturnType<typeof setTimeout> = setTimeout(fire, ms);
      const renew = () => {
        if (finished) return;
        clearTimeout(timer);
        timer = setTimeout(fire, ms);
      };
      run(renew).then(
        (val) => { finished = true; clearTimeout(timer); resolve(val); },
        (rejection) => { finished = true; clearTimeout(timer); reject(rejection); },
      );
    });
  }

  /**
   * Kill the session for good: mark it dead AND tear the socket down hard, so
   * `isConnected` stops reporting a zombie as alive and every pending request
   * fails immediately instead of hanging on a half-open TCP connection.
   * `forceClose` is optional-guarded so lightweight test doubles keep working.
   */
  private kill(): void {
    this.markDead();
    const ws = this.ws as unknown as { forceClose?: () => void; close: () => void };
    if (typeof ws.forceClose === 'function') ws.forceClose();
    else ws.close();
  }

  /**
   * Queue-bypassing invoke. Performs the actual encode -> sendRpc -> decode
   * -> QUIESCENCE wait -> async-event merge cycle without enqueuing onto
   * `this.queue`. This is intended for callers that already run inside an
   * enqueued task (e.g. `reconcileModalStack`, called from
   * `invokeUnqueued`'s own modal-violation retry path). Callers that are
   * NOT already serialized must use the public `invoke` instead -- BC's
   * protocol is stateful and concurrent sends corrupt sequence numbers.
   */
  /**
   * Subscribe to the WebSocket's async `Message` notifications and decode any
   * compressed handler arrays into `sink`. Returns the unsubscribe function.
   * Shared by `invokeUnqueued` and `initialize` so both capture trailing async
   * events during their quiescence window.
   */
  private collectAsyncMessages(sink: BCEvent[]): () => void {
    this.asyncSinks.push(sink);
    const off = this.ws.onMessage((raw) => {
      // Only the INNERMOST active collector consumes a frame. A nested invoke
      // (modal reconcile, or the license auto-dismiss during initialize) would
      // otherwise have its events decoded into both its own sink and the enclosing
      // one, so the caller saw every async event twice.
      if (this.asyncSinks[this.asyncSinks.length - 1] !== sink) return;
      if (!raw || typeof raw !== 'object') return;
      const msg = raw as Record<string, unknown>;
      // Only process async Message notifications (method: "Message", no id)
      if (msg['method'] === 'Message' && !('id' in msg) && Array.isArray(msg['params'])) {
        const messageData = (msg['params'] as unknown[])[0] as Record<string, unknown> | undefined;
        if (messageData?.['compressedData'] && typeof messageData['compressedData'] === 'string') {
          const decompResult = decompressPayload(messageData['compressedData'] as string);
          if (isOk(decompResult) && Array.isArray(decompResult.value)) {
            sink.push(...this.decoder.decode(decompResult.value as unknown[]));
          }
        }
      }
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      off();
      const ix = this.asyncSinks.lastIndexOf(sink);
      if (ix >= 0) this.asyncSinks.splice(ix, 1);
    };
  }

  private async invokeUnqueued(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs: number,
    /** Restarts the enclosing no-progress watchdog; called whenever BC answers. */
    renew?: () => void,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    const callbackId = uuid();
    const allEvents: BCEvent[] = [];
    const asyncEvents: BCEvent[] = [];

    // Register message handler to capture async Message notifications during this invoke
    const unsubscribe = this.collectAsyncMessages(asyncEvents);

    try {
      // Encode the interaction
      const context: EncodeContext = {
        callbackId,
        sequenceNo: this.ws.nextSequenceNo,
        lastClientAckSequenceNumber: this.ws.lastClientAckSequenceNumber,
        openFormIds: this._openFormIds,
        session: {
          sessionId: this.sessionId,
          sessionKey: this.sessionKey,
          company: this.company,
          tenantId: this.tenantId,
          spaInstanceId: this.ws.spaInstanceId,
        },
      };
      const encoded = this.encoder.encode(interaction, context);

      this.logger.debug('protocol', `Invoke: ${interaction.type}`, {
        callbackId,
        formId: interaction.formId,
      });

      // Send and wait for synchronous response
      const rpcResult = await this.ws.sendRpc(encoded.method, encoded.params, timeoutMs);
      renew?.();
      if (isErr(rpcResult)) {
        const msg = rpcResult.error.message;
        // An RPC that never got an answer is SESSION-FATAL. BC may still be
        // processing it, and any response that lands afterwards is dropped by
        // routeMessage (its pending entry is gone) -- so openFormIds and the modal
        // stack silently drift out of sync with the server. Previously this
        // returned a plain error and left the desynced session alive, because the
        // per-RPC deadline fires 5s BEFORE the session-level watchdog that would
        // have killed it.
        if (rpcResult.error.code === RPC_TIMEOUT_CODE) {
          this.logger.error(`Invoke(${interaction.type}) timed out after ${timeoutMs}ms; killing the session (client state can no longer be trusted)`);
          this.kill();
          return err(new ProtocolError(
            `RPC timed out after ${timeoutMs}ms: BC did not answer ${interaction.type}. Session has been killed and will reconnect on next request.`,
            { interaction: interaction.type },
            RPC_TIMEOUT_CODE,
          ));
        }
        // Match the fatal JSON-RPC code 1 exactly. A naive `includes('"code":1')`
        // substring also matches code 10, 12, 19, 100... -- non-fatal errors that
        // would then wrongly tear down the whole session. The word boundary is
        // the same guard error-translator.ts already uses.
        if (msg.includes('InvalidSessionException') || /"code"\s*:\s*1\b/.test(msg)) {
          // Close the socket too: marking the session dead without it left
          // `isConnected` true, so `isAlive` kept reporting a zombie as usable
          // until something else happened to notice.
          this.kill();
          return rpcResult;
        }
        if (msg.includes('LogicalModalityViolationException')) {
          // Stale modal state -- reconcile, then retry the original interaction
          // once. reconcileModalStack runs inside this enqueued task via
          // invokeUnqueued (queue-bypassing) to avoid a self-deadlock: the
          // outer enqueued task cannot resolve until reconcile finishes, and
          // a queued reconcile sub-invoke cannot start until the outer task
          // resolves. Each sub-invoke decodes its own response and updates
          // _openFormIds / modalStack via updateFormTracking. The retry's
          // events are merged into allEvents below so the caller's `expect`
          // predicate observes them alongside any FormClosed events emitted
          // by the reconcile sub-invokes.
          this.logger.warn(`LogicalModalityViolation detected, reconciling modal stack (size=${this.modalStack.size})`);
          const reconcile = await this.reconcileModalStack(renew);
          if (isErr(reconcile)) {
            this.kill();
            return err(new ModalReconcileError(`Modal reconciliation failed: ${reconcile.error.message}`, { originalError: msg }));
          }
          // Surface the reconcile sub-invokes' events (notably FormClosed for the
          // aborted stale dialogs) to the caller so the PageContextRepository can
          // prune those dialogs. Without this merge, page.dialogs / section
          // validity stay stale and derivePageState keeps reporting a dialog that
          // no longer exists.
          allEvents.push(...reconcile.value);
          // Re-encode -- sequence numbers / openFormIds may have advanced.
          const retryContext: EncodeContext = {
            callbackId,
            sequenceNo: this.ws.nextSequenceNo,
            lastClientAckSequenceNumber: this.ws.lastClientAckSequenceNumber,
            openFormIds: this._openFormIds,
            session: {
              sessionId: this.sessionId,
              sessionKey: this.sessionKey,
              company: this.company,
              tenantId: this.tenantId,
              spaInstanceId: this.ws.spaInstanceId,
            },
          };
          const retryEncoded = this.encoder.encode(interaction, retryContext);
          const retryRpc = await this.ws.sendRpc(retryEncoded.method, retryEncoded.params, timeoutMs);
          renew?.();
          if (isErr(retryRpc)) {
            this.kill();
            return err(new ModalReconcileError(`Retry after modal reconcile still failed: ${retryRpc.error.message}`, { originalError: msg }));
          }
          if (Array.isArray(retryRpc.value)) {
            allEvents.push(...this.decoder.decode(retryRpc.value));
          }
          // Fall through to the normal post-success path
        } else {
          return rpcResult;
        }
      } else {
        // Normal success path
        const responseData = rpcResult.value;
        if (Array.isArray(responseData)) {
          allEvents.push(...this.decoder.decode(responseData));
        }
      }

      // Quiescence window — wait for trailing async Messages
      await sleep(QUIESCENCE_MS);

      // Async events are drained incrementally: the expect-wait below may pull in
      // more of them, and each one must be merged exactly once.
      let drained = 0;
      const drain = (): BCEvent[] => {
        const fresh = asyncEvents.slice(drained);
        drained = asyncEvents.length;
        return fresh;
      };

      let invokeCompletedSeen = false;
      let expectMatched = false;
      const consume = (events: BCEvent[]): void => {
        allEvents.push(...events);
        this.updateFormTracking(events);
        for (const event of events) {
          if (event.type === 'InvokeCompleted') {
            if (event.completedInteractions.some(ci => ci.invocationId === callbackId)) {
              invokeCompletedSeen = true;
            }
          }
          if (!expectMatched && expect(event, { callbackId, interactionFormId: interaction.formId, invokeCompletedSeen })) {
            expectMatched = true;
          }
        }
      };

      // Fold in what the synchronous response already produced plus the async
      // burst, in one pass (allEvents currently holds only the decoded response).
      const initial = allEvents.splice(0, allEvents.length);
      consume(initial);
      consume(drain());

      // `expect` names a wait-contract, so honour it instead of merely logging
      // whether it matched: keep listening in short slices while events are still
      // arriving. Bounded twice over (total budget AND consecutive idle slices),
      // so a predicate BC will never satisfy costs ~100ms, not the full budget.
      let waitedMs = 0;
      let idleSlices = 0;
      while (!expectMatched && waitedMs < EXPECT_WAIT_MAX_MS && idleSlices < EXPECT_WAIT_IDLE_SLICES) {
        await sleep(EXPECT_WAIT_SLICE_MS);
        waitedMs += EXPECT_WAIT_SLICE_MS;
        const fresh = drain();
        if (fresh.length === 0) { idleSlices += 1; continue; }
        idleSlices = 0;
        consume(fresh);
      }

      this.logger.debug('protocol', `Invoke complete: ${interaction.type}`, {
        callbackId,
        eventCount: allEvents.length,
        types: allEvents.map(e => e.type),
        invokeCompletedSeen,
        expectMatched,
        expectWaitMs: waitedMs,
      });

      return ok(allEvents);
    } finally {
      unsubscribe();
    }
  }

  private findLicenseDialog(events: BCEvent[]): (BCEvent & { type: 'DialogOpened' }) | undefined {
    return events.find((e): e is BCEvent & { type: 'DialogOpened' } => {
      if (e.type !== 'DialogOpened') return false;
      const tree = e.controlTree as Record<string, unknown> | undefined;
      if (!tree) return false;
      const caption = ((tree.Caption ?? tree.caption ?? '') as string).toLowerCase();
      const message = ((tree.Message ?? tree.message ?? '') as string).toLowerCase();
      const text = caption + ' ' + message;
      return text.includes('license') || text.includes('evaluation') || text.includes('trial');
    });
  }

  private updateFormTracking(events: BCEvent[]): void {
    for (const event of events) {
      if (event.type === 'FormCreated' && event.formId) {
        this._openFormIds.add(event.formId);
        // Non-modal -- do not push onto modalStack
      }
      if (event.type === 'DialogOpened' && event.formId) {
        this._openFormIds.add(event.formId);
        this.modalStack.push(event.formId);
      }
      if (event.type === 'FormClosed' && event.formId) {
        this._openFormIds.delete(event.formId);
        this.modalStack.remove(event.formId);
      }
    }
  }

  addOpenForm(formId: string): void {
    this._openFormIds.add(formId);
  }

  removeOpenForm(formId: string): void {
    this._openFormIds.delete(formId);
    this.modalStack.remove(formId);
  }

  /** Test seam: snapshot of the current modal stack (top-most last). */
  modalStackSnapshot(): string[] {
    return this.modalStack.snapshot();
  }

  markDead(): void {
    this.dead = true;
  }

  /**
   * Walk the modal stack from top to bottom, sending Abort (SystemAction=320)
   * to each modal until the stack is empty or an Abort fails. After each
   * successful Abort, BC's FormClosed event normally pops the stack via
   * updateFormTracking. If FormClosed does not arrive, the loop force-pops
   * to make progress.
   *
   * Used to clear stale modal state that produced a
   * `LogicalModalityViolationException`. Calls `invokeUnqueued` directly
   * (queue-bypassing) so it works when triggered from inside the modal-violation
   * retry path in `invokeUnqueued` itself — calling `invoke` from there would
   * self-deadlock on the promise queue. External callers may invoke it
   * outside the queue; in that case behaviour is well-defined as long as no
   * other invoke is in flight on the same session (BC's wire protocol is
   * stateful and concurrent sends corrupt sequence numbers).
   *
   * Reference: decompiled `LogicalModalityVerifier.IsUnderModalForm`, which
   * inspects `LogicalDispatcher.Frames`. SystemAction.Abort=320 closes the
   * topmost frame's ModalForm.
   */
  async reconcileModalStack(renew?: () => void): Promise<Result<BCEvent[], ProtocolError>> {
    const collected: BCEvent[] = [];
    const MAX_ATTEMPTS = 10;
    for (let i = 0; i < MAX_ATTEMPTS && this.modalStack.size > 0; i++) {
      const top = this.modalStack.peek()!;
      // B1: Abort=320 alone does NOT close a confirm dialog server-side (live
      // observation, BC28) — the local stack was force-popped, BC kept the dialog,
      // the next invoke violated modality again and the whole session was reset,
      // losing every open page. So escalate through the answers a confirm dialog
      // actually accepts, stopping at the first one BC acknowledges with FormClosed.
      // No=390 is the same answer closeGracefully already uses successfully.
      const attempts: Array<{ label: string; interaction: BCInteraction }> = [
        { label: 'No=390', interaction: { type: 'InvokeAction', formId: top, controlPath: 'server:', systemAction: 390 } },
        { label: 'Cancel=310', interaction: { type: 'InvokeAction', formId: top, controlPath: 'server:', systemAction: 310 } },
        { label: 'Abort=320', interaction: { type: 'InvokeAction', formId: top, controlPath: 'server:', systemAction: 320 } },
        { label: 'CloseForm', interaction: { type: 'CloseForm', formId: top } },
      ];

      let lastError: ProtocolError | null = null;
      let closed = false;
      for (const attempt of attempts) {
        const result = await this.invokeUnqueued(
          attempt.interaction,
          (event) => event.type === 'InvokeCompleted',
          this.timeoutMs,
          renew,
        );
        if (isErr(result)) {
          // A rejected answer (BC may refuse No on a dialog with no No button) is
          // not fatal — try the next one. Only a dead session stops the walk.
          lastError = result.error;
          if (this.dead) {
            return err(new ProtocolError(`reconcileModalStack: session died while closing formId=${top}: ${result.error.message}`));
          }
          continue;
        }
        collected.push(...result.value);
        // updateFormTracking pops the stack when BC emits FormClosed for this form.
        if (this.modalStack.peek() !== top) {
          this.logger.info(`reconcileModalStack: dialog formId=${top} closed by ${attempt.label}`);
          closed = true;
          break;
        }
        this.logger.warn(`reconcileModalStack: ${attempt.label} did not close formId=${top} — escalating`);
      }

      if (!closed) {
        // Every answer was refused. Force-pop so the client state stays consistent,
        // but say so loudly: BC may still hold the dialog, and the next invoke will
        // fall back to the session reset.
        this.logger.warn(
          `reconcileModalStack: formId=${top} survived No/Cancel/Abort/CloseForm — force-popping local stack `
          + `(server-side dialog may still be open${lastError ? `; last error: ${lastError.message}` : ''})`,
        );
        this.modalStack.pop();
        this._openFormIds.delete(top);
      }
    }
    if (this.modalStack.size > 0) {
      return err(new ProtocolError(`reconcileModalStack: stack still has ${this.modalStack.size} entries after ${MAX_ATTEMPTS} attempts`));
    }
    return ok(collected);
  }

  /**
   * Gracefully close the session by closing all open forms (dialogs first),
   * then closing the WebSocket. Without this, BC keeps modal dialog state
   * alive server-side, blocking new sessions for the same user.
   * Verified from decompiled LogicalModalityVerifier.cs / LogicalDispatcher.cs.
   */
  async closeGracefully(): Promise<void> {
    // A dead session has nothing to close politely, and its socket is exactly the
    // one that may be half-open -- tear it down hard.
    if (this.dead) { this.kill(); return; }

    // Close forms iteratively. CloseForm may trigger save-changes dialogs that
    // become new modal forms in _openFormIds. Dismiss them before continuing.
    // Safety limit prevents infinite loops.
    for (let iteration = 0; iteration < 20 && this._openFormIds.size > 0; iteration++) {
      const formId = Array.from(this._openFormIds).pop()!;
      try {
        const result = await this.invoke(
          { type: 'CloseForm', formId },
          (event) => event.type === 'InvokeCompleted',
        );
        // Check if CloseForm spawned a dialog (save changes?) -- dismiss it
        if (isOk(result)) {
          for (const event of result.value) {
            if (event.type === 'DialogOpened' && event.formId) {
              // Respond "no" to discard changes and close the dialog
              try {
                await this.invoke(
                  { type: 'InvokeAction', formId: event.formId, controlPath: 'server:', systemAction: 390 }, // No=390
                  (e) => e.type === 'InvokeCompleted',
                );
              } catch { /* best effort */ }
              this._openFormIds.delete(event.formId);
            }
          }
        }
      } catch {
        // Best effort -- form may already be closed or session dead
      }
      this._openFormIds.delete(formId);
    }

    this.dead = true;
    this.ws.close();
  }

  /**
   * Ask a LIVE session to change company (SystemAction.ChangeCompany = 500).
   *
   * Kept as a best-effort attempt, NOT as the mechanism: verified live on devel1,
   * BC answers this with a bare `InvokeCompleted` (plus unrelated PropertyChanged)
   * — no SessionSettingsChanged, no CompanyName, nothing that says it did anything.
   * A session is bound to its company at OpenSession, which is why the web client
   * changes company by re-entering with `?company=`. `SessionManager.switchCompany`
   * does the same and is the real path; this one is only tried first because it is
   * cheap and, where a build does honour it, avoids a reconnect.
   *
   * IT NO LONGER WRITES THE REQUESTED COMPANY INTO THE SESSION. Doing that meant
   * `companyName`, bc_health and every deep link repeated back the company that had
   * been ASKED FOR while BC kept serving the old one's data — a silent wrong-company
   * read, which is worse than an error (bc-saas F-11). The company is now only ever
   * set from what BC itself reports.
   *
   * Returns whether BC confirmed, so the caller can decide what to do next.
   */
  async changeCompany(companyName: string): Promise<Result<{ events: BCEvent[]; confirmed: boolean }, ProtocolError>> {
    const before = this.company;
    const result = await this.invoke(
      {
        type: 'SessionAction',
        actionName: 'InvokeSessionAction',
        namedParameters: { systemAction: 500, company: companyName },
      },
      (e) => e.type === 'InvokeCompleted',
    );
    if (!isOk(result)) return result;
    // The ONLY thing that may move `company`: a SessionSettingsChanged / SessionInit
    // handler in BC's own response.
    this.applySessionInfo(result.value);
    const norm = (s: string): string => s.trim().toLowerCase();
    const confirmed = norm(this.company) === norm(companyName) && norm(before) !== norm(this.company);
    return ok({ events: result.value, confirmed });
  }

  async runReport(reportId: number): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    // RunReport is dispatched via OpenForm with query "report=<id>".
    // The BC web client uses FormPropertyBag with COMMAND=report, ID=<id>.
    // Verified from decompiled NavRunReportPropertyBagInvokedAction.cs:
    //   FormPropertyBag maps "report" key to COMMAND=report, ID=reportId
    //   InvokePropertyBagAction calls IService.RunReport(reportId)
    // SaaS (AAD) binds the tenant at session open and rejects `&tenant=` in the
    // query -- the same rule PageService.buildOpenFormQuery follows for pages.
    // Hard-coding it here made every report open on SaaS use a query on-prem
    // shape.
    const query = this.omitTenantInQueries
      ? `report=${reportId}`
      : `report=${reportId}&tenant=${this.tenantId}`;
    return this.invoke(
      {
        type: 'OpenForm',
        query,
      },
      (e) => e.type === 'InvokeCompleted' || e.type === 'DialogOpened' || e.type === 'FormCreated',
    );
  }

  /**
   * Abrupt teardown (signal handlers, discarding a dead session before recovery).
   * Uses the hard path: this is called precisely when the socket may be half-open,
   * and a polite close would leave pending requests hanging and `isConnected`
   * true for minutes.
   */
  close(): void {
    this.kill();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
