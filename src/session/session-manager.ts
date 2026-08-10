import { isErr } from '../core/result.js';
import { SessionLostError } from '../core/errors.js';
import type { BCSession } from './bc-session.js';
import type { SessionFactory } from './session-factory.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';
import type { Metrics } from '../services/metrics.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';

export interface ReconnectOptions {
  maxRetries: number;
  baseDelayMs: number;
}

const DEFAULT_RECONNECT: ReconnectOptions = { maxRetries: 4, baseDelayMs: 1000 };

/**
 * Manages the BC session lifecycle including lazy creation and automatic recovery
 * after session death (InvalidSessionException, WebSocket disconnect).
 *
 * When a dead session is detected, the manager:
 * 1. Closes the old session
 * 2. Clears all page contexts (they reference the dead session's form IDs)
 * 3. Creates a fresh session with exponential backoff
 * 4. Throws SessionLostError so the caller can inform the LLM
 *
 * BC holds the NTLM auth slot for ~15 seconds after a session crash,
 * so immediate reconnect typically fails. The exponential backoff
 * (1s, 2s, 4s, 8s by default) covers this window.
 */
export class SessionManager {
  private session: BCSession | null = null;
  private servicesInvalidated = false;
  private readonly reconnectOptions: ReconnectOptions;
  /** Recovery en curs compartit: coalesça crides concurrents en un sol intent (un sol /SignIn). */
  private recovering: Promise<BCSession | null> | null = null;
  /**
   * B3: set for the whole duration of a RECOVERY (dead session -> new session), with
   * the page contexts that died with it. A concurrent getSession() that arrives while
   * `session` is momentarily null must join this and receive the same SessionLostError
   * — otherwise it took the "first create" branch, got a session back with no warning,
   * and failed later with a baffling "page context not found".
   */
  private recovery: { promise: Promise<BCSession | null>; impactedIds: string[] } | null = null;
  /**
   * The in-flight FIRST create (no previous session to lose). Concurrent callers
   * join it instead of starting a second create -- and, more importantly, none of
   * them sees `this.session` until the pinned company has been applied to it.
   */
  private firstCreate: Promise<BCSession | null> | null = null;
  /** Last session-create error message, surfaced in SessionLostError when all retries fail. */
  private lastCreateError: string | null = null;
  /**
   * B2: the company the caller last switched to, re-applied to every session created
   * from here on. Null = never switched, so BC's default stands.
   */
  private desiredCompany: string | null = null;

  /** Exposed for testing -- override to avoid real delays. */
  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  constructor(
    private readonly sessionFactory: SessionFactory,
    private readonly pageContextRepo: PageContextRepository,
    private readonly logger: Logger,
    reconnectOptions?: ReconnectOptions,
    private readonly metrics?: Metrics,
    private readonly authProvider?: IBCAuthProvider,
  ) {
    this.reconnectOptions = reconnectOptions ?? DEFAULT_RECONNECT;
  }

  get currentSession(): BCSession | null {
    return this.session;
  }

  get needsServiceRebuild(): boolean {
    return this.servicesInvalidated;
  }

  /** Mark services as rebuilt after the caller reconstructs them. */
  markServicesRebuilt(): void {
    this.servicesInvalidated = false;
  }

  /**
   * Returns an alive session, creating one if needed.
   * If the existing session is dead, performs recovery:
   * - Closes the dead session
   * - Clears all page contexts
   * - Creates a new session with exponential backoff
   * - Throws SessionLostError with the list of invalidated page context IDs
   */
  async getSession(): Promise<BCSession> {
    // Happy path: session exists and is alive
    if (this.session !== null && this.session.isAlive) {
      return this.session;
    }

    // B3: a recovery started by another concurrent caller is in flight. `session` is
    // null right now, but this is NOT a first connect — join the same attempt and
    // report the same loss, so this caller learns its page contexts are gone too.
    if (this.recovery !== null) {
      const { promise, impactedIds } = this.recovery;
      const joined = await promise;
      if (joined === null) throw this.reconnectFailedError(impactedIds);
      throw new SessionLostError(
        'Session was lost and has been recreated. Previous page contexts are no longer valid. Please re-open any pages you need.',
        impactedIds,
      );
    }

    // Session is dead -- recover
    if (this.session !== null) {
      this.logger.info('Session is dead, initiating recovery...');

      // Collect impacted page context IDs before clearing
      const impactedIds = this.pageContextRepo.listPageContextIds();

      // Tear down dead session
      this.session.close();
      this.session = null;

      // Clear all page contexts -- they reference the dead session's form IDs
      this.pageContextRepo.clearAll();
      this.servicesInvalidated = true;

      // Publish the in-flight recovery BEFORE awaiting it, so a concurrent caller
      // takes the branch above instead of the first-create branch. The promise
      // covers create AND company-pinning AND publication, so `this.recovery`
      // stays set for the whole window in which `this.session` is not yet usable.
      const promise = this.createAndPublish();
      this.recovery = { promise, impactedIds };
      let newSession: BCSession | null;
      try {
        newSession = await promise;
      } finally {
        this.recovery = null;
      }

      if (newSession === null) {
        throw this.reconnectFailedError(impactedIds);
      }

      this.metrics?.recordReconnect();
      this.logger.info('Session recovered successfully');

      // Throw SessionLostError so the MCP handler returns a clear message to the LLM
      throw new SessionLostError(
        'Session was lost and has been recreated. Previous page contexts are no longer valid. Please re-open any pages you need.',
        impactedIds,
      );
    }

    // No session yet -- create one (first call), also with backoff for
    // LogicalModalityViolation. A concurrent caller joins the same attempt.
    if (this.firstCreate !== null) {
      const joined = await this.firstCreate;
      if (joined === null) throw this.createFailedError();
      return joined;
    }

    const attempt = this.createAndPublish();
    this.firstCreate = attempt;
    let newSession: BCSession | null;
    try {
      newSession = await attempt;
    } finally {
      this.firstCreate = null;
    }
    if (newSession === null) throw this.createFailedError();

    this.logger.info('BC session established');
    return newSession;
  }

  /**
   * Create a session, put it on the pinned company, and only THEN publish it as
   * `this.session`.
   *
   * Publishing first was a race: `getSession()` returned as soon as the session
   * object existed, so a concurrent caller could enqueue an invoke ahead of the
   * ChangeCompany and read data from the wrong company. Both call sites keep a
   * fence (`recovery` / `firstCreate`) set for the whole duration of this call,
   * so no caller can observe the half-configured session.
   */
  private async createAndPublish(): Promise<BCSession | null> {
    const session = await this.createWithBackoff();
    if (session === null) return null;
    await this.applyDesiredCompany(session);
    this.session = session;
    this.metrics?.recordSessionCreated();
    return session;
  }

  /**
   * First-connect failure. This used to be a bare `Error` that threw away
   * `lastCreateError`, so the caller never learned WHY (wrong password, expired
   * Entra session needing `npm run login:aad`, unreachable host, self-signed TLS).
   * A SessionLostError carries the SESSION_LOST code the MCP handler and
   * error-translator already understand, plus the underlying reason.
   */
  private createFailedError(): SessionLostError {
    const detail = this.lastCreateError ? ` Last error: ${this.lastCreateError}` : '';
    return new SessionLostError(
      `Session creation failed after all retry attempts.${detail}`,
      [],
      { reconnectFailed: true },
    );
  }

  /**
   * B2: remember the company the caller switched to. Called by
   * `SwitchCompanyOperation` on success; re-applied to every session created after
   * a recovery so the user's choice survives a reconnect.
   */
  rememberCompany(companyName: string | null): void {
    this.desiredCompany = companyName;
  }

  /** The company that will be re-applied on the next reconnect (null = BC default). */
  get pinnedCompany(): string | null {
    return this.desiredCompany;
  }

  private async applyDesiredCompany(session: BCSession): Promise<void> {
    const want = this.desiredCompany;
    if (!want || session.companyName === want) return;
    this.logger.info(`Re-applying company "${want}" on the new session (was "${session.companyName}")`);
    const result = await session.changeCompany(want).catch((e: unknown) => {
      this.logger.warn(`Could not re-apply company "${want}": ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    if (result && isErr(result)) {
      this.logger.warn(`Could not re-apply company "${want}": ${result.error.message}`);
    }
  }

  private reconnectFailedError(impactedIds: string[]): SessionLostError {
    // Surface the underlying auth/connect reason (e.g. AAD needs an interactive
    // `npm run login:aad` because the persisted Entra session expired) instead
    // of a generic "cannot reach BC".
    const detail = this.lastCreateError ? ` Last error: ${this.lastCreateError}` : '';
    return new SessionLostError(
      `Session was lost and all reconnect attempts failed. The server cannot reach Business Central.${detail}`,
      impactedIds,
      { reconnectFailed: true },
    );
  }

  /**
   * Attempt to create a session with exponential backoff.
   * Returns the new BCSession on success, or null if all retries are exhausted.
   */
  private async createWithBackoff(): Promise<BCSession | null> {
    // Coalesça crides concurrents: stdio-server (rl.on('line', async)) no espera
    // el callback, així que dues tool calls simultànies post-publish entrarien
    // totes dues aquí. Compartir el mateix intent evita dos /SignIn i dos
    // OpenSession competint per l'slot NTLM (i sobreescriure this.session).
    if (this.recovering) {
      return this.recovering;
    }
    this.recovering = this.runBackoffLoop();
    try {
      return await this.recovering;
    } finally {
      this.recovering = null;
    }
  }

  private async runBackoffLoop(): Promise<BCSession | null> {
    const { maxRetries, baseDelayMs } = this.reconnectOptions;
    const MAX_BACKOFF_MS = 30000; // cap per evitar esperes desmesurades amb maxRetries alts

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
        this.logger.info(`Reconnect attempt ${attempt}/${maxRetries} after ${delayMs}ms delay...`);
        await this.delay(delayMs);
      }

      // Forçar re-login fresc en cada intent: després d'un publish el NST recicla
      // l'app domain i invalida les cookies/CSRF; reusar-les sempre falla. Invalidar
      // aquí fa que ConnectionFactory.create torni a executar authenticate() (/SignIn nou).
      this.authProvider?.invalidate();

      const result = await this.sessionFactory.create();

      if (!isErr(result)) {
        this.lastCreateError = null;
        return result.value;
      }

      const errorMsg = result.error.message;
      this.lastCreateError = errorMsg;

      if (errorMsg.includes('LogicalModalityViolation')) {
        // Mid-session violations are reconciled in BCSession.invokeUnqueued.
        // Reaching this branch means the violation surfaced during *initial*
        // connect (NTLM slot still held by a previous crashed session) or a
        // full session recreate after death. Backoff retry is the right
        // response there; nothing to abort because the new session has no
        // modals yet.
        this.logger.warn(`LogicalModalityViolation during initial connect (NTLM slot held by previous session?), attempt ${attempt + 1}: ${errorMsg}`);
      } else {
        this.logger.warn(`Session create failed on attempt ${attempt + 1}: ${errorMsg}`);
      }
    }

    return null;
  }

  /** Gracefully close the session, sending CloseForm for all open forms. */
  async closeGracefully(): Promise<void> {
    if (this.session !== null) {
      await this.session.closeGracefully();
      this.session = null;
    }
  }

  /** Abrupt close (for signal handlers that can't be async). */
  close(): void {
    if (this.session !== null) {
      this.session.close();
      this.session = null;
    }
  }
}
