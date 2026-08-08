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
import type { RawCookie } from '../connection/auth/cookies.js';

export { parseSetCookie } from '../connection/auth/cookies.js';
export type { RawCookie } from '../connection/auth/cookies.js';

const GENERIC_TITLE = /^(Dynamics 365 Business Central|Welcome to Dynamics 365 Business Central\.?|)$/i;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Deep link to a page/record. */
export function deepLinkPage(config: BCConfig, pageId: string, bookmark?: string, company?: string): string {
  const qs = new URLSearchParams();
  qs.set('page', pageId);
  // SaaS is tenant-path-based (baseUrl already carries {aadTenantId}/{environment});
  // appending ?tenant= there is wrong. On-prem uses the query tenant.
  if (config.authMode !== 'AAD') qs.set('tenant', config.tenantId);
  if (company) qs.set('company', company);
  if (bookmark) qs.set('bookmark', bookmark);
  return `${config.baseUrl}/?${qs.toString()}`;
}

/**
 * Deep link to a report. BC opens the report's request page in the web client.
 * Same query convention as the WebSocket runReport (`report=<id>&tenant=<t>`),
 * plus optional company for cross-company consistency.
 */
export function deepLinkReport(config: BCConfig, reportId: string, company?: string): string {
  const qs = new URLSearchParams();
  qs.set('report', reportId);
  if (config.authMode !== 'AAD') qs.set('tenant', config.tenantId);
  if (company) qs.set('company', company);
  return `${config.baseUrl}/?${qs.toString()}`;
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
export async function waitReady(p: any, _logger?: Logger, opts?: { timeoutMs?: number; settleMs?: number }): Promise<boolean> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 60000);
  let ready = false;
  while (Date.now() < deadline) {
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
  await sleep(opts?.settleMs ?? 3500); // settle final layout / data binding
  return ready;
}
