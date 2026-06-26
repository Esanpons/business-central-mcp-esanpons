// src/services/bc-web-auth.ts
//
// Shared, out-of-band BC web-client auth + navigation helpers used by both
// ScreenshotService (capture) and ReportDownloadService (report binary). These
// do NOT touch the WebSocket protocol path or the invoke queue.
//
// Engine = "cookie injection" (verified live against BC27/devel1): authenticate
// to BC's forms login (/SignIn), export the resulting cookie jar WITH its real
// attributes (path=/BC; secure; samesite=none; httponly), inject it into the
// browser, then open a deep-link URL. If injection ever lands on the login page,
// fall back to performing the /SignIn form once in-page.
//
// IMPORTANT: never add runinframe=1 to a deep link — it makes a top-level load
// hang on "Getting ready..." waiting for an iframe-parent handshake.

import { load } from 'cheerio';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

export interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'None' | 'Lax' | 'Strict';
}

const GENERIC_TITLE = /^(Dynamics 365 Business Central|Welcome to Dynamics 365 Business Central\.?|)$/i;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Deep link to a page/record. */
export function deepLinkPage(config: BCConfig, pageId: string, bookmark?: string, company?: string): string {
  const qs = new URLSearchParams();
  qs.set('page', pageId);
  qs.set('tenant', config.tenantId);
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
  qs.set('tenant', config.tenantId);
  if (company) qs.set('company', company);
  return `${config.baseUrl}/?${qs.toString()}`;
}

export function parseSetCookie(line: string, host: string): RawCookie {
  const parts = line.split(';').map((s) => s.trim());
  const nv = parts[0] ?? '';
  const attrs = parts.slice(1);
  const eq = nv.indexOf('=');
  const lower = attrs.map((a) => a.toLowerCase());
  const pathAttr = attrs.find((a) => a.toLowerCase().startsWith('path='));
  let sameSite: RawCookie['sameSite'] = 'Lax';
  const ss = attrs.find((a) => a.toLowerCase().startsWith('samesite='));
  if (ss) {
    const v = (ss.split('=')[1] ?? '').toLowerCase();
    sameSite = v === 'none' ? 'None' : v === 'strict' ? 'Strict' : 'Lax';
  }
  return {
    name: nv.slice(0, eq),
    value: nv.slice(eq + 1),
    domain: host,
    path: pathAttr ? (pathAttr.split('=')[1] ?? '/') : '/',
    secure: lower.includes('secure'),
    httpOnly: lower.includes('httponly'),
    sameSite,
  };
}

/** Authenticate via forms /SignIn and return the attributed cookie jar. */
export async function authCookies(config: BCConfig): Promise<RawCookie[]> {
  const host = new URL(config.baseUrl).host;
  const signInUrl = `${config.baseUrl}/SignIn?tenant=${encodeURIComponent(config.tenantId)}`;
  const get = await fetch(signInUrl, { redirect: 'manual', headers: { 'User-Agent': 'bc-mcp-web' } });
  const getCk = get.headers.getSetCookie();
  const $ = load(await get.text());
  const token = $('input[name="__RequestVerificationToken"]').attr('value') || '';
  const body = new URLSearchParams({ UserName: config.username, Password: config.password, __RequestVerificationToken: token });
  const post = await fetch(signInUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'bc-mcp-web',
      Cookie: getCk.map((c) => c.split(';')[0]).join('; '),
    },
    body: body.toString(),
  });
  if (post.status !== 302) {
    throw new Error(`BC sign-in failed: POST /SignIn returned ${post.status} (expected 302). Check BC_USERNAME / BC_PASSWORD.`);
  }
  const map = new Map<string, RawCookie>();
  for (const line of [...getCk, ...post.headers.getSetCookie()]) {
    const c = parseSetCookie(line, host);
    map.set(c.name, c);
  }
  return [...map.values()];
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
