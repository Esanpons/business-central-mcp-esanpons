import { ok, err, isErr, type Result } from '../../core/result.js';
import { AuthenticationError } from '../../core/errors.js';
import type { IBCAuthProvider, AuthResult } from './auth-provider.js';
import type { RawCookie } from './cookies.js';
import type { Logger } from '../../core/logger.js';
import { launchPersistent } from '../../services/browser.js';

export interface AADProviderConfig {
  /** Full SaaS env URL: https://businesscentral.dynamics.com/{aadTenantId}/{environment} */
  baseUrl: string;
  /** UPN for headless Entra login (optional — empty relies on the persisted profile). */
  username: string;
  /** Password for headless Entra login (optional). */
  password: string;
  /** Persistent browser profile dir holding the Entra SSO session. */
  profileDir: string;
  /** Base32 TOTP secret for unattended MFA (optional). */
  totpSecret: string;
  /** ms budget for the OIDC login dance. */
  loginTimeoutMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// CDP cookie shape (Network.getAllCookies).
interface CdpCookie { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: string; }

/** CDP cookies -> the attributed jar the headless browser injection expects. */
function toRawCookies(cookies: CdpCookie[]): RawCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.replace(/^\./, ''),
    path: c.path || '/',
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite === 'None' ? 'None' : c.sameSite === 'Strict' ? 'Strict' : 'Lax',
  }));
}

/** All cookies BC's front door and its backend hosts issued. */
function bcCookies(cookies: CdpCookie[]): CdpCookie[] {
  return cookies.filter((c) => c.domain.replace(/^\./, '').endsWith('businesscentral.dynamics.com'));
}

/**
 * BC Online (SaaS) auth via a real Entra (Azure AD) browser login.
 *
 * OAuth tokens do NOT authenticate the web client — it needs an ASP.NET session
 * created by an interactive user login. And (verified by the F2 spike) the SaaS
 * WebSocket is NOT `{baseUrl}/csh`: the server assigns a per-tab backend endpoint
 *   wss://{backendHost}/tenant/{backendTenant}/tab/{tabId}/csh
 *        ?ackseqnb=-1&aadTenantId={aad}&csrftoken={CfDJ8...}&traceId={...}
 * on a regional app-service host, with the session cookies (SessionId,
 * .AspNetCore.Cookies, .AspNetCore.Antiforgery.*) scoped to that host + tab path.
 * None of that is derivable from baseUrl — it must be DISCOVERED from the browser.
 *
 * So this provider drives a headless browser with a PERSISTENT profile: the OIDC
 * dance runs once (interactive `npm run login:aad`, or headless with
 * username/password[/TOTP]), the SPA opens its WS in a Web Worker, and we capture —
 * via CDP (Target.setAutoAttach + Network on each target) — the exact WS URL plus
 * the backend-host cookies. The connection layer then opens its own Node WS to that
 * URL (reconnect semantics: `ackseqnb=-1` = fresh client attach to the tab). The
 * OpenSession tenantId is the backend tenant parsed from the URL path; applicationId
 * is `FIN` on SaaS (config default in AAD mode).
 *
 * Spike reference: docs/SAAS-EVIDENCE.md,
 * src/protocol/captures/saas-handshake-2026-08-08.json.
 */
export class AADBrowserAuthProvider implements IBCAuthProvider {
  private wsCookieHeader = '';
  private wsUrl: string | null = null;
  private backendTenant: string | null = null;
  private csrfToken = '';
  private cookieJar: RawCookie[] = [];
  private userAgent = '';
  private authenticated = false;
  // The headless browser that discovered the WS tab is KEPT ALIVE for the session
  // lifetime: closing it makes BC tear down the per-tab session server-side, so a
  // Node WS reconnect to that tab races into an "Unexpected server response: 500".
  // Keeping the browser (and thus the tab) alive makes the WS upgrade reliable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private browser: any = null;
  /**
   * In-flight close() of a previously kept-alive browser. `invalidate()` is
   * synchronous, so it can only START the close; launching a new persistent
   * browser before that finishes races on the profile-dir lock and fails with
   * "profile appears to be in use". `authenticateHeadless` awaits this first.
   */
  private closing: Promise<void> | null = null;

  constructor(
    private readonly config: AADProviderConfig,
    private readonly logger: Logger,
  ) {}

  async authenticate(): Promise<Result<AuthResult, AuthenticationError>> {
    return this.authenticateHeadless(true, true);
  }

  /**
   * Interactive bootstrap: launch headed so a human completes login + MFA once,
   * warming the persistent profile. Called by `npm run login:aad`. One-shot — the
   * browser is closed at the end (it only warms the on-disk profile).
   */
  async bootstrap(): Promise<Result<AuthResult, AuthenticationError>> {
    return this.authenticateHeadless(false, false);
  }

  private async authenticateHeadless(headless: boolean, keepAlive: boolean): Promise<Result<AuthResult, AuthenticationError>> {
    // Close any browser kept from a previous authenticate() before opening a new one
    // (recovery re-auth) so we never leak headless browsers.
    if (this.browser) { await this.browser.close().catch(() => undefined); this.browser = null; }
    // A close() started by invalidate() may still be running; launching on the same
    // profile dir before it completes fails on the profile lock.
    if (this.closing) { await this.closing.catch(() => undefined); this.closing = null; }
    // puppeteer Browser is typed `any` throughout this codebase (browser.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let browser: any;
    // Set only on the success path that intentionally keeps the browser open; the
    // finally below closes the browser in EVERY other case. Without it the three
    // mid-function `return err(...)` paths leaked a headless Chrome that kept the
    // profile-dir lock, so the NEXT launchPersistent failed too -- turning a
    // recoverable auth error into a permanent failure across all backoff retries.
    let keptAlive = false;
    try {
      browser = await launchPersistent(this.config.profileDir, { headless });
      const pages = await browser.pages();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = pages[0] ?? (await browser.newPage());
      const cdp = await page.target().createCDPSession();

      // Capture the SaaS WS URL the SPA opens. Today's BC client creates it inside
      // a Web Worker, so we attach to every target and enable Network there. But
      // relying ONLY on auto-attached targets means a build that opens /csh from
      // the MAIN thread is never seen, and auth fails with "WebSocket URL was not
      // observed" despite a perfectly good login. So the page's own CDP session
      // listens too — whichever fires first wins.
      let capturedWsUrl: string | null = null;
      const noteWsUrl = (url: string): void => {
        if (!capturedWsUrl && /\/csh(\?|$)/.test(url)) capturedWsUrl = url;
      };
      const conn = cdp.connection();
      await cdp.send('Network.enable').catch(() => undefined);
      cdp.on('Network.webSocketCreated', (w: { url: string }) => noteWsUrl(w.url));
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      cdp.on('Target.attachedToTarget', async (e: { sessionId: string }) => {
        try {
          const s = conn.session(e.sessionId);
          if (!s) return;
          await s.send('Network.enable').catch(() => undefined);
          s.on('Network.webSocketCreated', (w: { url: string }) => noteWsUrl(w.url));
          await s.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
        } catch { /* target gone */ }
      });

      this.logger.info(`[aad] navigating to ${this.config.baseUrl} (headless=${headless})`);
      await page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);

      const reached = await this.driveLogin(page, headless, () => capturedWsUrl !== null);
      if (!reached) {
        return err(new AuthenticationError(
          headless
            ? 'AAD login did not complete. If this environment requires MFA/interaction, run `npm run login:aad` (headed) once to bootstrap the profile, or set BC_AAD_TOTP_SECRET.'
            : 'AAD login did not complete within the timeout. Finish the login in the opened window.',
          { baseUrl: this.config.baseUrl, username: this.config.username },
        ));
      }

      // Give the worker a moment to open its WS if the SPA settled first.
      for (let i = 0; i < 20 && !capturedWsUrl; i++) await sleep(500);
      if (!capturedWsUrl) {
        return err(new AuthenticationError('AAD login succeeded but the BC WebSocket URL was not observed. The SPA may not have finished loading.', { baseUrl: this.config.baseUrl }));
      }
      this.wsUrl = capturedWsUrl;

      // Parse backend host + tenant + tab path from
      // wss://{host}/tenant/{backendTenant}/tab/{tabId}/csh
      const parsed = new URL(this.wsUrl);
      const backendHost = parsed.host;
      const tenantMatch = parsed.pathname.match(/\/tenant\/([^/]+)\//);
      this.backendTenant = tenantMatch ? tenantMatch[1]! : null;
      this.csrfToken = parsed.searchParams.get('csrftoken') ?? '';
      // The tab-scoped cookie path, e.g. /tenant/{tenant}/tab/{tabId} (strip the /csh).
      const tabPath = parsed.pathname.replace(/\/csh$/, '');

      // Cookies: the WS header needs ONLY the CURRENT tab's backend cookies
      // (SessionId, .AspNetCore.Cookies, antiforgery, affinity — scoped to
      // /tenant/.../tab/{tabId}). A persistent profile accumulates these for EVERY
      // historical tab, all on the same backend host; sending all of them makes the
      // Cookie header carry dozens of duplicate-named cookies with different values,
      // which the gateway (Kestrel) rejects with a 500 on the WS upgrade. So filter
      // by the tab path and de-dupe by name. The attributed jar (browser injection
      // for screenshots/reports) keeps the whole BC set (front door + backend).
      const all = await cdp.send('Network.getAllCookies') as { cookies: CdpCookie[] };
      const bcAll = bcCookies(all.cookies);
      const tabCookies = bcAll.filter((c) =>
        c.domain.replace(/^\./, '') === backendHost &&
        (c.path === tabPath || tabPath.startsWith(c.path.replace(/\/$/, '') + '/') || c.path === '/'),
      );
      // De-dupe by name, preferring the most specific (longest) path match.
      const byName = new Map<string, CdpCookie>();
      for (const c of tabCookies.sort((a, b) => a.path.length - b.path.length)) byName.set(c.name, c);
      const backendCookies = [...byName.values()];
      if (backendCookies.length === 0) {
        return err(new AuthenticationError(`AAD login succeeded but no backend-host cookies were found for ${backendHost} (tab ${tabPath}).`, { baseUrl: this.config.baseUrl }));
      }
      this.wsCookieHeader = backendCookies.map((c) => `${c.name}=${c.value}`).join('; ');
      this.cookieJar = toRawCookies(bcAll);

      // Match the browser's User-Agent on the WS upgrade — the backend gateway
      // 500s on a non-browser UA / missing Origin (it enforces NAVAllowedAncestor).
      this.userAgent = await browser.userAgent().catch(() => '') || '';

      this.authenticated = true;
      this.logger.info(`[aad] authenticated: backend=${backendHost} tenant=${this.backendTenant} (${backendCookies.length} tab cookies)`);
      if (keepAlive) {
        // Keep the browser (and its tab session) alive so the Node WS upgrade to
        // that tab succeeds. Closed on invalidate()/recovery.
        this.browser = browser;
        keptAlive = true;
      }
      return ok({ cookies: this.wsCookieHeader, csrfToken: this.csrfToken, cookieJar: this.cookieJar });
    } catch (e) {
      return err(new AuthenticationError(
        `AAD authentication failed: ${e instanceof Error ? e.message : String(e)}`,
        { baseUrl: this.config.baseUrl, username: this.config.username },
      ));
    } finally {
      if (!keptAlive) await browser?.close().catch(() => undefined);
    }
  }

  /**
   * Poll-driven Entra login. Idempotent per iteration: fills whatever field is
   * currently visible, so it walks email -> password -> TOTP -> "stay signed in"
   * across Entra's multi-page flow without hard-coding the transitions.
   *
   * `done` is the CALLER's definition of success, because the two callers need
   * different ones: opening a session waits for the SPA's WebSocket URL, while
   * refreshing the cookie jar only needs BC's front-door session ticket (the SPA
   * readiness probe never trips in that second tab). It may be async so the check
   * can query the browser.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async driveLogin(page: any, headless: boolean, done: () => boolean | Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + (headless ? this.config.loginTimeoutMs : Math.max(this.config.loginTimeoutMs, 300000));
    let totp: ((secret: string) => string) | null = null;

    while (Date.now() < deadline) {
      if (await done()) return true;
      const url: string = page.url();
      const onBC = /businesscentral\.dynamics\.com/i.test(url);
      const onEntra = /login\.(microsoftonline|live|windows)\.(com|net)/i.test(url) || /microsoftonline/i.test(url);

      if (onBC && await this.spaReady(page)) return true;

      if (onEntra && headless) {
        await this.typeIfEmpty(page, 'input[type=email],input[name=loginfmt]', this.config.username);
        await this.typeIfEmpty(page, 'input[type=password],input[name=passwd]', this.config.password);
        if (this.config.totpSecret) {
          const otcSel = 'input[name=otc],input#idTxtBx_SAOTCC_OTC';
          if (await this.visible(page, otcSel)) {
            if (!totp) totp = await this.loadTotp();
            if (totp) await this.typeIfEmpty(page, otcSel, totp(this.config.totpSecret));
          }
        }
        await this.clickIfPresent(page, 'input[type=submit],#idSIButton9,button[type=submit]');
      }

      await sleep(1500);
    }
    return done();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async spaReady(page: any): Promise<boolean> {
    return page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      const title = (doc.title || '').trim();
      const generic = /^(Dynamics 365 Business Central|Welcome.*|)$/i.test(title);
      const sp = doc.querySelector('[class*="spinner"],[class*="Spinner"]');
      const spinning = !!sp && sp.offsetParent !== null;
      return !generic && !spinning;
    }).catch(() => false);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async visible(page: any, sel: string): Promise<boolean> {
    return page.evaluate((s: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = (globalThis as any).document.querySelector(s);
      return !!el && el.offsetParent !== null;
    }, sel).catch(() => false);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async typeIfEmpty(page: any, sel: string, value: string): Promise<void> {
    if (!value) return;
    const doIt = await page.evaluate((s: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = (globalThis as any).document.querySelector(s);
      return !!el && el.offsetParent !== null && !el.value;
    }, sel).catch(() => false);
    if (doIt) {
      await page.type(sel, value, { delay: 20 }).catch(() => undefined);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async clickIfPresent(page: any, sel: string): Promise<void> {
    if (await this.visible(page, sel)) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => undefined),
        page.click(sel).catch(() => undefined),
      ]);
    }
  }

  /** Lazy-load otpauth for TOTP. Returns null with a clear log if unavailable. */
  private async loadTotp(): Promise<((secret: string) => string) | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import('otpauth');
      return (secret: string) => {
        const t = new mod.TOTP({ secret: mod.Secret.fromBase32(secret.replace(/\s/g, '')) });
        return t.generate();
      };
    } catch {
      this.logger.error('[aad] BC_AAD_TOTP_SECRET is set but the `otpauth` package is not installed. Run `npm install otpauth`.');
      return null;
    }
  }

  getWebSocketHeaders(): Record<string, string> {
    // The backend gateway enforces the WS Origin (see the NAVAllowedAncestor
    // cookie) and expects a browser User-Agent — a bare `ws` upgrade 500s.
    const headers: Record<string, string> = {
      Cookie: this.wsCookieHeader,
      Origin: new URL(this.config.baseUrl).origin,
    };
    if (this.userAgent) headers['User-Agent'] = this.userAgent;
    return headers;
  }

  getWebSocketQueryParams(): Record<string, string> {
    // Unused in AAD mode — getWebSocketUrl() returns the full URL (csrftoken included).
    return this.csrfToken ? { csrftoken: this.csrfToken } : {};
  }

  getWebSocketUrl(): string | null {
    return this.wsUrl;
  }

  getTenantIdOverride(): string | null {
    return this.backendTenant;
  }

  /** SaaS binds the tenant at session open; `&tenant=` in a query is rejected. */
  omitsTenantInQueries(): boolean {
    return true;
  }

  getCookieJar(): RawCookie[] {
    return this.cookieJar;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Mint a fresh browser cookie jar WITHOUT disturbing the WebSocket.
   *
   * The two sessions expire independently: the injected jar a capture uses is a
   * set of cookies with their own lifetime, while the WS is an already-established
   * socket attached to a specific BC tab. When the jar expires, captures bounce to
   * Entra while every WS tool keeps working (bc-saas F-10) — so the repair must be
   * equally independent.
   *
   * The obvious repair, `invalidate()` + `authenticate()`, is exactly the wrong
   * one: it closes the kept-alive browser, BC tears down that tab's session
   * server-side, and the live WS dies. So this opens a SEPARATE tab in the same
   * browser instead. The Entra SSO state lives in the on-disk profile, shared by
   * every tab, so the new tab re-authenticates silently and its cookies are the
   * fresh front-door ones a capture needs. The tab is closed afterwards; the tab
   * holding the WS is never touched.
   */
  async refreshCookieJar(): Promise<RawCookie[]> {
    if (!this.browser) {
      // Nothing kept alive (bootstrap-only run, or never authenticated): a full
      // authenticate() is fine precisely because there is no live tab to lose.
      const r = await this.authenticate();
      if (isErr(r)) throw new Error(`Could not renew the BC browser session: ${r.error.message}`);
      return this.cookieJar;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any;
    try {
      page = await this.browser.newPage();
      const cdp = await page.target().createCDPSession();
      await cdp.send('Network.enable').catch(() => undefined);
      this.logger.info('[aad] refreshing the browser cookie jar in a separate tab (WS tab untouched)');
      await page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);

      // Success here is "we are through BC's front door and it has issued a session
      // ticket" — NOT the SPA being fully up. `spaReady` is the wrong bar for this
      // tab: measured on the live sandbox, a second tab never tripped it and the
      // refresh burned the whole 120s login budget and then failed, on an
      // environment that was perfectly healthy. The ticket is also exactly what the
      // capture browser needs, since it opens its own deep link afterwards.
      let jar: RawCookie[] = [];
      // Two CONSECUTIVE good polls, not one. A dead ticket usually redirects to Entra
      // during the goto, but the SPA can also decide to bounce a moment later — and a
      // single poll landing in that window would accept the stale cookies and hand
      // back a jar that fails exactly the same way it did before. The polls are
      // 1.5s apart (driveLogin's own cadence), which is enough to see the bounce.
      let goodPolls = 0;
      const reached = await this.driveLogin(page, true, async () => {
        if (!/businesscentral\.dynamics\.com/i.test(String(page.url()))) { goodPolls = 0; return false; }
        const all = await cdp.send('Network.getAllCookies').catch(() => null) as { cookies: CdpCookie[] } | null;
        if (!all) { goodPolls = 0; return false; }
        const bc = bcCookies(all.cookies);
        if (!bc.some((c) => c.name === '.AspNetCore.Cookies')) { goodPolls = 0; return false; }
        jar = toRawCookies(bc);
        return ++goodPolls >= 2;
      });
      if (!reached || jar.length === 0) {
        throw new Error(
          'the Entra sign-in did not complete unattended. Run `npm run login:aad` once (it opens a real window '
          + 'so you can pass MFA) to warm the persistent profile, then retry.',
        );
      }
      this.cookieJar = jar;
      this.logger.info(`[aad] cookie jar refreshed (${jar.length} cookies)`);
      return jar;
    } catch (e) {
      throw new Error(`Could not renew the BC browser session: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  invalidate(): void {
    // Drop the in-memory session so the next connect re-discovers a fresh tab/WS.
    // The persistent profile on disk is kept, so re-auth is usually silent.
    this.authenticated = false;
    this.wsCookieHeader = '';
    this.wsUrl = null;
    this.backendTenant = null;
    this.csrfToken = '';
    this.cookieJar = [];
    // Tear down the kept-alive browser (and its tab session). authenticate() will
    // open a fresh one. invalidate() must stay synchronous, so RETAIN the close
    // promise instead of dropping it: the next authenticate() awaits it before
    // calling launchPersistent, otherwise both processes fight over the same
    // profile-dir lock and the relaunch fails.
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      this.closing = Promise.resolve(b.close()).then(() => undefined, () => undefined);
    }
    this.logger.info('[aad] auth state invalidated; next connection will re-discover (persistent profile retained)');
  }
}
