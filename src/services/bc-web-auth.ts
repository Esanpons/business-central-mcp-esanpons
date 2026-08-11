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
 * Shared SignIn-bounce recovery: when cookie injection lands on the login page,
 * the injected jar is stale server-side. Drop it (so the next capture AND the
 * next WS reconnect, if the provider is shared, re-authenticate), log in once
 * in-page, and optionally re-navigate to the original deep link. Returns true
 * when a bounce was detected and recovered.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recoverIfOnSignIn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: any,
  provider: IBCAuthProvider,
  config: BCConfig,
  logger: Logger,
  opts?: { tag?: string; returnTo?: string },
): Promise<boolean> {
  if (!(await onSignIn(p))) return false;
  logger.warn(`[${opts?.tag ?? 'bc-web'}] cookie injection landed on SignIn — logging in in-page`);
  provider.invalidate();
  await inPageLogin(config, p);
  if (opts?.returnTo) {
    await p.goto(opts.returnTo, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function onSignIn(p: any): Promise<boolean> {
  if (p.url().includes('SignIn')) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return p.evaluate(() => !!(globalThis as any).document.querySelector('#UserName,#Password')).catch(() => false);
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
