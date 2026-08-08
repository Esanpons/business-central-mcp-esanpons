import { ok, err, type Result } from '../../core/result.js';
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
 * Spike reference: docs/Plans/saas-spike.md,
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
    // puppeteer Browser is typed `any` throughout this codebase (browser.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let browser: any;
    try {
      browser = await launchPersistent(this.config.profileDir, { headless });
      const pages = await browser.pages();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = pages[0] ?? (await browser.newPage());
      const cdp = await page.target().createCDPSession();

      // Capture the SaaS WS URL the SPA opens (inside a Web Worker) — attach to
      // every target and enable Network so worker webSocketCreated is seen.
      let capturedWsUrl: string | null = null;
      const conn = cdp.connection();
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      cdp.on('Target.attachedToTarget', async (e: { sessionId: string }) => {
        try {
          const s = conn.session(e.sessionId);
          if (!s) return;
          await s.send('Network.enable').catch(() => undefined);
          s.on('Network.webSocketCreated', (w: { url: string }) => {
            if (!capturedWsUrl && /\/csh\?/.test(w.url)) capturedWsUrl = w.url;
          });
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
      const bcAll = all.cookies.filter((c) => c.domain.replace(/^\./, '').endsWith('businesscentral.dynamics.com'));
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
      this.cookieJar = bcAll.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain.replace(/^\./, ''),
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite === 'None' ? 'None' : c.sameSite === 'Strict' ? 'Strict' : 'Lax',
      }));

      // Match the browser's User-Agent on the WS upgrade — the backend gateway
      // 500s on a non-browser UA / missing Origin (it enforces NAVAllowedAncestor).
      this.userAgent = await browser.userAgent().catch(() => '') || '';

      this.authenticated = true;
      this.logger.info(`[aad] authenticated: backend=${backendHost} tenant=${this.backendTenant} (${backendCookies.length} tab cookies)`);
      if (keepAlive) {
        // Keep the browser (and its tab session) alive so the Node WS upgrade to
        // that tab succeeds. Closed on invalidate()/recovery.
        this.browser = browser;
      } else {
        await browser.close().catch(() => undefined);
      }
      return ok({ cookies: this.wsCookieHeader, csrfToken: this.csrfToken, cookieJar: this.cookieJar });
    } catch (e) {
      await browser?.close().catch(() => undefined);
      return err(new AuthenticationError(
        `AAD authentication failed: ${e instanceof Error ? e.message : String(e)}`,
        { baseUrl: this.config.baseUrl, username: this.config.username },
      ));
    }
  }

  /**
   * Poll-driven Entra login. Idempotent per iteration: fills whatever field is
   * currently visible, so it walks email -> password -> TOTP -> "stay signed in"
   * across Entra's multi-page flow without hard-coding the transitions. Returns
   * true once the BC SPA is loaded (or the WS was already observed).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async driveLogin(page: any, headless: boolean, wsSeen: () => boolean): Promise<boolean> {
    const deadline = Date.now() + (headless ? this.config.loginTimeoutMs : Math.max(this.config.loginTimeoutMs, 300000));
    let totp: ((secret: string) => string) | null = null;

    while (Date.now() < deadline) {
      if (wsSeen()) return true;
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
    return wsSeen();
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

  getCookieJar(): RawCookie[] {
    return this.cookieJar;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
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
    // open a fresh one. Fire-and-forget so invalidate() stays synchronous.
    if (this.browser) { const b = this.browser; this.browser = null; b.close().catch(() => undefined); }
    this.logger.info('[aad] auth state invalidated; next connection will re-discover (persistent profile retained)');
  }
}
