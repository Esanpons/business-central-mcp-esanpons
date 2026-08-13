// src/services/bc-web-auth.ts
//
// Shared, out-of-band BC web-client navigation helpers used by both
// ScreenshotService (capture) and ReportDownloadService (report binary). These
// do NOT touch the WebSocket protocol path or the invoke queue.
//
// Engine = "cookie injection" (verified live against BC27/devel1): the ACTIVE
// IBCAuthProvider performs the login (one login for WS + browser) and exposes
// the attributed cookie jar (path=/BC; secure; samesite=none; httponly), which
// is injected into the browser before opening a deep-link URL. If injection
// ever lands on the login page, fall back to performing the /SignIn form once
// in-page (forms mode only — AAD has no in-page form).
//
// IMPORTANT: never add runinframe=1 to a deep link — it makes a top-level load
// hang on "Getting ready..." waiting for an iframe-parent handshake.

import { isErr } from '../core/result.js';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';
import { FormsAuthProvider } from '../connection/auth/forms-provider.js';
import type { RawCookie } from '../connection/auth/cookies.js';

export { parseSetCookie } from '../connection/auth/cookies.js';
export type { RawCookie } from '../connection/auth/cookies.js';

const GENERIC_TITLE = /^(Dynamics 365 Business Central|Welcome to Dynamics 365 Business Central\.?|)$/i;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a deep-link query string.
 *
 * NOT `URLSearchParams.toString()`: that is `application/x-www-form-urlencoded`,
 * which writes a space as `+`. BC reads a query value LITERALLY, so a company
 * named `CRONUS ES` arrived as `CRONUS+ES` and every capture came back as BC's
 * "Could not open the company" error page — with a perfectly successful-looking
 * result carrying the path of a PNG of that error. Almost every BC install has a
 * space in a company name (`CRONUS ES`, `My Company`), so this hit nearly
 * everyone. `encodeURIComponent` is the query-VALUE encoding BC expects: space
 * becomes `%20`, and a literal `+` in a value stays encoded as `%2B`.
 */
function deepLinkQuery(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** Deep link to a page/record. */
export function deepLinkPage(config: BCConfig, pageId: string, bookmark?: string, company?: string): string {
  const params: Array<[string, string]> = [['page', pageId]];
  // SaaS is tenant-path-based (baseUrl already carries {aadTenantId}/{environment});
  // appending ?tenant= there is wrong. On-prem uses the query tenant.
  if (config.authMode !== 'AAD') params.push(['tenant', config.tenantId]);
  if (company) params.push(['company', company]);
  if (bookmark) params.push(['bookmark', bookmark]);
  return `${config.baseUrl}/?${deepLinkQuery(params)}`;
}

/**
 * Deep link to a report. BC opens the report's request page in the web client.
 * Same query convention as the WebSocket runReport (`report=<id>&tenant=<t>`),
 * plus optional company for cross-company consistency.
 */
export function deepLinkReport(config: BCConfig, reportId: string, company?: string): string {
  const params: Array<[string, string]> = [['report', reportId]];
  if (config.authMode !== 'AAD') params.push(['tenant', config.tenantId]);
  if (company) params.push(['company', company]);
  return `${config.baseUrl}/?${deepLinkQuery(params)}`;
}

/**
 * Ensure the provider is authenticated and return its attributed cookie jar.
 * This is THE auth path for the headless browser: one login (the provider's),
 * shared by the WebSocket and puppeteer. Throws with the provider's actionable
 * message (wrong password, unreachable host, ...) on failure.
 */
export async function ensureAuthJar(provider: IBCAuthProvider): Promise<RawCookie[]> {
  if (!provider.isAuthenticated()) {
    const r = await provider.authenticate();
    if (isErr(r)) throw new Error(`BC sign-in failed: ${r.error.message}`);
  }
  return provider.getCookieJar();
}

/**
 * Fallback auth provider for standalone use: when no ACTIVE provider is injected
 * (scripts, tests), build a self-contained forms provider from config. Shared by
 * ScreenshotService and ReportDownloadService so the construction lives in one
 * place.
 */
export function fallbackFormsProvider(config: BCConfig, logger: Logger): IBCAuthProvider {
  return new FormsAuthProvider({
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
    tenantId: config.tenantId,
    tlsInsecure: config.tlsInsecure,
  }, logger);
}

/**
 * Which login wall the browser is sitting on, or undefined when it is past them.
 *
 * TWO walls exist and only one used to be recognised. `bc-forms` is BC's own
 * on-prem `/SignIn` page; `entra` is Microsoft's `login.microsoftonline.com`,
 * which is what a SaaS capture bounces to when the injected cookie jar has
 * expired. Matching only the first one is what made an expired SaaS session
 * capture a PNG of Microsoft's login form and report it as a success, with
 * `authenticated: true`, on top of the good image (bc-saas F-10).
 */
export type LoginWall = 'bc-forms' | 'entra';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function detectLoginWall(p: any): Promise<LoginWall | undefined> {
  const url = String(p.url?.() ?? '');
  // Entra's hosts and its OAuth/OIDC endpoints. Checked BEFORE the BC one because
  // an Entra return URL can carry the BC deep link (SignIn included) inside it.
  if (/login\.(microsoftonline|live|windows|microsoft)\.(com|net)|\/oauth2\/|\/common\/login/i.test(url)) return 'entra';
  if (url.includes('SignIn')) return 'bc-forms';
  const inDom = await p
    .evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // `loginfmt` is the Entra account field; `#idSIButton9` its Next/Sign-in
      // button. Both survive Entra's redesigns and neither exists on a BC page.
      if (doc.querySelector('input[name=loginfmt],#idSIButton9,#idA_PWD_ForgotPassword')) return 'entra';
      if (doc.querySelector('#UserName,#Password')) return 'bc-forms';
      return null;
    })
    .catch(() => null);
  return inDom === 'entra' || inDom === 'bc-forms' ? inDom : undefined;
}

/**
 * True when the page is past every login wall. Kept under its old name because
 * both callers use it for their `authenticated` field — which is exactly why it
 * had to learn about Entra: it was computed as `!(await onSignIn(p))` and so
 * answered "authenticated" for a page that was Microsoft's login form.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function onSignIn(p: any): Promise<boolean> {
  return (await detectLoginWall(p)) !== undefined;
}

/**
 * Positive check that what is on screen is the BC web client, rather than the
 * absence of a login form. Looks for the client's own root classes (`ms-dyn365-*`
 * on the body, `ms-nav-*` on its chrome) in ANY frame, since page content lives
 * in an iframe. Captured live from devel1: `class="ms-dyn365-fin chrome mouse"`.
 *
 * Used to WARN, never to fail: a future BC restyle would otherwise block every
 * capture. The certain signal (a login wall) is what fails a capture.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function looksLikeBusinessCentral(p: any): Promise<boolean> {
  for (const f of p.frames()) {
    try {
      const hit = await f.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        const cls = String(doc.body?.className || '');
        return /ms-dyn365|ms-nav-/.test(cls) || !!doc.querySelector('[class*="ms-nav-"]');
      });
      if (hit) return true;
    } catch { /* cross-origin / detached frame */ }
  }
  return false;
}

/**
 * Shared logged-out recovery, for BOTH walls.
 *
 * `bc-forms` (on-prem): the injected jar is stale server-side. Drop it (so the
 * next capture AND the next WS reconnect re-authenticate) and log in once
 * in-page — BC's SignIn carries our deep link as its ReturnUrl.
 *
 * `entra` (SaaS): there is no in-page form to fill, and the fix must NOT be
 * `provider.invalidate()`. That tears down the kept-alive persistent browser,
 * and with it the BC tab the WebSocket session is attached to — repairing the
 * capture path by killing the working one. Instead ask the provider for a FRESH
 * cookie jar, which it mints from the warm Entra profile without touching the
 * tab, re-inject it and re-navigate.
 *
 * When neither can be recovered this THROWS with what the operator has to do,
 * instead of letting the caller photograph the login form (F-10).
 *
 * Returns true when a wall was detected and recovered, false when there was none.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recoverIfLoggedOut(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: any,
  provider: IBCAuthProvider,
  config: BCConfig,
  logger: Logger,
  opts?: {
    tag?: string;
    returnTo?: string;
    /** Re-inject a refreshed jar into the browser (the caller owns the page). */
    applyCookies?: (cookies: RawCookie[]) => Promise<void>;
  },
): Promise<boolean> {
  const wall = await detectLoginWall(p);
  if (!wall) return false;
  const tag = opts?.tag ?? 'bc-web';

  if (wall === 'bc-forms' && config.authMode !== 'AAD') {
    logger.warn(`[${tag}] cookie injection landed on BC SignIn — logging in in-page`);
    provider.invalidate();
    await inPageLogin(config, p);
  } else {
    logger.warn(`[${tag}] the browser session expired (${wall}) — refreshing the cookie jar`);
    if (!provider.refreshCookieJar) {
      throw new Error(
        `The browser session expired and landed on the ${wall === 'entra' ? 'Microsoft Entra' : 'BC'} sign-in page, `
        + 'and this auth provider cannot refresh it. Nothing was written. Restart the MCP server to start a fresh browser session.',
      );
    }
    const jar = await provider.refreshCookieJar();
    if (opts?.applyCookies && jar.length) await opts.applyCookies(jar);
  }

  if (opts?.returnTo) {
    await p.goto(opts.returnTo, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => undefined);
  }

  const still = await detectLoginWall(p);
  if (still) {
    throw new Error(
      `The browser session has expired and could not be renewed unattended: the page is still on the `
      + `${still === 'entra' ? 'Microsoft Entra sign-in form' : 'Business Central sign-in form'}. Nothing was written. `
      + (still === 'entra'
        ? 'Sign in once interactively with `npm run login:aad` (it warms the persistent profile), then retry. '
          + 'This is a browser-session failure only — the WebSocket tools keep working, which is why bc_health still reports "connected".'
        : 'Check BC_USERNAME / BC_PASSWORD, then retry.'),
    );
  }
  logger.info(`[${tag}] browser session recovered`);
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function inPageLogin(config: BCConfig, p: any): Promise<void> {
  await p.waitForSelector('#UserName', { timeout: 15000 });
  await p.type('#UserName', config.username);
  await p.type('#Password', config.password);
  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => undefined),
    p.click('#submitButton'),
  ]);
}

/**
 * BC's client error surface, or undefined when the page is fine. Returns the
 * error text as BC rendered it (whitespace-collapsed, truncated), so the caller
 * can put BC's own words in front of the user.
 *
 * Detection is on the BODY CLASS, not on text: the client marks the frame that
 * renders the message with `has-error` and its host frame with
 * `has-error-in-child`. Verified live on devel1 with a bad company name — the
 * message itself ("Could not open the company." / "No se pudo abrir la empresa
 * 'X'.") is half-localised and cannot be matched reliably. The "Go back home"
 * text is kept as a second signal because the SaaS report deep-link race is
 * detected by it, and returning the message is the whole point.
 *
 * WHY this exists: a capture that landed on this page still produced a perfectly
 * successful-looking result carrying the path to a PNG of BC's error screen. A
 * failure that ships a file is a failure nobody notices.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function detectErrorPage(p: any): Promise<string | undefined> {
  const summarize = (t: string): string => {
    const s = t.replace(/\s+/g, ' ').trim();
    return s.length > 300 ? `${s.slice(0, 300)}...` : s;
  };
  // The host frame knows something failed but only the CHILD frame carries the
  // message, so the host is kept as a fallback and the scan continues.
  let hostOnly: string | undefined;
  for (const f of p.frames()) {
    try {
      const st = await f.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        return { cls: String(doc.body?.className || ''), text: String(doc.body?.innerText || '') };
      });
      const inChild = /has-error-in-child/.test(st.cls);
      const own = /(^|\s)has-error(\s|$)/.test(st.cls);
      // A short page offering only "go back home" is BC's not-found screen. The
      // length guard keeps a real page that happens to contain the phrase out of it.
      const textual = st.text.trim().length < 800
        && /go back home|volver al inicio|torna a l'inici|zur(ü|u)ck zur startseite/i.test(st.text);
      if (own || (textual && !inChild)) return summarize(st.text) || 'BC returned an error page (no text).';
      if (inChild) hostOnly = summarize(st.text) || 'BC returned an error page (no text).';
    } catch { /* cross-origin / detached frame */ }
  }
  return hostOnly;
}

/**
 * The text of a modal dialog currently on screen, or undefined when there is none.
 *
 * A capture that lands on an in-app dialog is not necessarily wrong — a manual may
 * be documenting that very dialog. What makes it a problem is a dialog NOBODY
 * ASKED FOR: BC refusing a bookmark from another table, for instance, returns its
 * explanation in a modal, and the capture came back as a "successful" PNG of an
 * error message (bc-saas F-9). The caller decides: it knows whether it requested
 * one (via clickBeforeCapture) and can raise the unrequested case as a warning.
 *
 * Matching is on the ARIA role, not on BC classes: `dialog` / `alertdialog` are
 * what BC's client publishes for its modals, and they do not shift between
 * versions or locales the way class names do.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function detectModalDialog(p: any): Promise<string | undefined> {
  for (const f of p.frames()) {
    try {
      const text: string | null = await f.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        const nodes = doc.querySelectorAll('[role="dialog"],[role="alertdialog"]');
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i];
          const visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
          if (!visible) continue;
          const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
          if (t) return t;
        }
        return null;
      });
      if (text) return text.length > 300 ? `${text.slice(0, 300)}...` : text;
    } catch { /* cross-origin / detached frame */ }
  }
  return undefined;
}

/**
 * Poll until the SPA settles (no spinner, non-generic title), then a final settle
 * wait. `opts.timeoutMs`/`opts.settleMs` bound the poll and the trailing settle.
 *
 * Reports must pass a SHORT timeoutMs: a report request page keeps the generic
 * "Dynamics 365 Business Central" title forever (it never gets a page caption), so
 * the readiness probe never trips and otherwise burns the full default 60s for
 * nothing (BC745: that single wait was the bulk of a ~97s download). The caller
 * (report download) drives the request page right after regardless of the return.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function waitReady(
  p: any,
  opts?: { timeoutMs?: number; settleMs?: number; bailOnErrorPage?: boolean },
): Promise<boolean> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 60000);
  let ready = false;
  while (Date.now() < deadline) {
    // BC's error screen keeps the generic title forever, so without this the poll
    // burns its whole budget (60s per capture, times every step of a manual) on a
    // page that will never become ready. The caller re-runs detectErrorPage to get
    // the message; this only stops the waiting.
    if (opts?.bailOnErrorPage && await detectErrorPage(p)) return false;
    const st = await p
      .evaluate((generic: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        const title = (doc.title || '').trim();
        const sp = doc.querySelector('[class*="spinner"],[class*="Spinner"]');
        return { spinnerVisible: !!sp && sp.offsetParent !== null, generic: new RegExp(generic, 'i').test(title) };
      }, GENERIC_TITLE.source)
      .catch(() => ({ spinnerVisible: true, generic: true }));
    if (!st.spinnerVisible && !st.generic) { ready = true; break; }
    await sleep(1000);
  }
  // Settle final layout / data binding — but only when the page actually became
  // ready: after a timed-out poll there is nothing to settle, and the extra sleep
  // just made every not-ready path slower.
  if (ready) await sleep(opts?.settleMs ?? 3500);
  return ready;
}
