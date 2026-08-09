import { v4 as uuid } from 'uuid';
import { ok, err, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError, TimeoutError, ModalReconcileError } from '../core/errors.js';
import type { BCWebSocket } from '../connection/bc-websocket.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../protocol/types.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder, type EncodeContext } from '../protocol/interaction-encoder.js';
import { decompressPayload } from '../protocol/decompression.js';
import type { Logger } from '../core/logger.js';
import { ModalStack } from './modal-stack.js';

const DEFAULT_TIMEOUT_MS = 30000;
const QUIESCENCE_MS = 150; // Trailing window for async Message bursts

export class BCSession {
  private queue: Promise<void> = Promise.resolve();
  private readonly _openFormIds = new Set<string>();
  private readonly modalStack = new ModalStack();
  private dead = false;

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

  async initialize(tenantId: string): Promise<Result<BCEvent[], ProtocolError>> {
    const openSessionCall = this.encoder.encodeOpenSession(tenantId, this.ws.spaInstanceId, this.profile);

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
        try {
          await this.invoke(
            { type: 'InvokeAction', formId: licenseDialog.formId, controlPath: 'server:', systemAction: 300 }, // Ok=300
            (e) => e.type === 'InvokeCompleted',
          );
          // Clear from BOTH openFormIds and the modal stack. Using the raw Set
          // delete alone leaves a stale modalStack entry (the dialog was pushed
          // there by updateFormTracking), which the next modal reconcile would try
          // to Abort even though the form is gone.
          this.removeOpenForm(licenseDialog.formId);
        } catch {
          this.logger.warn('Failed to auto-dismiss license dialog, continuing anyway');
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
      try {
        return await this.withTimeout(
          this.invokeUnqueued(interaction, expect, effectiveTimeout),
          effectiveTimeout + 5000, // Session-level timeout is 5s longer than RPC timeout
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

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logger.error(`${label} timed out after ${ms}ms, killing session`);
        this.markDead();
        this.ws.close();
        reject(new TimeoutError(`BC did not respond within ${ms / 1000}s. Session has been killed and will reconnect on next request.`));
      }, ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (rejection) => { clearTimeout(timer); reject(rejection); },
      );
    });
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
    return this.ws.onMessage((raw) => {
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
  }

  private async invokeUnqueued(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs: number,
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
      if (isErr(rpcResult)) {
        const msg = rpcResult.error.message;
        // Match the fatal JSON-RPC code 1 exactly. A naive `includes('"code":1')`
        // substring also matches code 10, 12, 19, 100... -- non-fatal errors that
        // would then wrongly tear down the whole session. The word boundary is
        // the same guard error-translator.ts already uses.
        if (msg.includes('InvalidSessionException') || /"code"\s*:\s*1\b/.test(msg)) {
          this.markDead();
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
          const reconcile = await this.reconcileModalStack();
          if (isErr(reconcile)) {
            this.markDead();
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
          if (isErr(retryRpc)) {
            this.markDead();
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
      await new Promise<void>(resolve => setTimeout(resolve, QUIESCENCE_MS));

      // Collect async events
      allEvents.push(...asyncEvents);

      // Update form tracking
      this.updateFormTracking(allEvents);

      // Check completion gates for logging
      let invokeCompletedSeen = false;
      let expectMatched = false;
      for (const event of allEvents) {
        if (event.type === 'InvokeCompleted') {
          if (event.completedInteractions.some(ci => ci.invocationId === callbackId)) {
            invokeCompletedSeen = true;
          }
        }
        if (!expectMatched && expect(event, { callbackId, interactionFormId: interaction.formId, invokeCompletedSeen })) {
          expectMatched = true;
        }
      }

      this.logger.debug('protocol', `Invoke complete: ${interaction.type}`, {
        callbackId,
        eventCount: allEvents.length,
        types: allEvents.map(e => e.type),
        invokeCompletedSeen,
        expectMatched,
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
  async reconcileModalStack(): Promise<Result<BCEvent[], ProtocolError>> {
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
    if (this.dead) { this.ws.close(); return; }

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
   * Switch the session's company (SystemAction.ChangeCompany = 500) and reflect the
   * result on this session, so `companyName` — and everything derived from it
   * (bc_health, screenshot/report deep-links) — stops reporting the old company.
   *
   * Lives here rather than in the operation because SessionManager must replay it
   * after a reconnect (B2: a recovered session came back on the server-default
   * company and nothing re-applied the user's choice).
   */
  async changeCompany(companyName: string): Promise<Result<BCEvent[], ProtocolError>> {
    const result = await this.invoke(
      {
        type: 'SessionAction',
        actionName: 'InvokeSessionAction',
        namedParameters: { systemAction: 500, company: companyName },
      },
      (e) => e.type === 'InvokeCompleted',
    );
    if (!isOk(result)) return result;
    this.setCompany(companyName);
    // Refine with the server-confirmed company when the response carried a
    // SessionSettingsChanged handler.
    this.applySessionInfo(result.value);
    return result;
  }

  async runReport(reportId: number): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    // RunReport is dispatched via OpenForm with query "report=<id>".
    // The BC web client uses FormPropertyBag with COMMAND=report, ID=<id>.
    // Verified from decompiled NavRunReportPropertyBagInvokedAction.cs:
    //   FormPropertyBag maps "report" key to COMMAND=report, ID=reportId
    //   InvokePropertyBagAction calls IService.RunReport(reportId)
    return this.invoke(
      {
        type: 'OpenForm',
        query: `report=${reportId}&tenant=${this.tenantId}`,
      },
      (e) => e.type === 'InvokeCompleted' || e.type === 'DialogOpened' || e.type === 'FormCreated',
    );
  }

  close(): void {
    this.dead = true;
    this.ws.close();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
