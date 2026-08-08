// scripts/capture-saas-handshake.ts
//
// SaaS handshake spike (results: docs/SAAS-EVIDENCE.md): capture the BC Online (SaaS)
// WebSocket handshake so the AAD provider (F3) can reproduce it. The BC web client
// opens its WebSocket INSIDE a Web Worker, so a page-level hook sees nothing — we
// attach to every target via CDP (Target.setAutoAttach, flatten) and enable the
// Network domain on each, capturing webSocketCreated / frameSent / frameReceived.
//
// It runs HEADED with a PERSISTENT profile (the same dir the AAD provider reuses),
// so you log in + do MFA once by hand; the Entra SSO cookies then persist for F3.
//
// Usage:
//   set BC_BASE_URL=https://businesscentral.dynamics.com/<aadTenantId>/<environment>
//   npx tsx scripts/capture-saas-handshake.ts
// Optional: BC_AAD_PROFILE_DIR (default ./.state/aad-profile), CAPTURE_TIMEOUT_MS.
//
// Output: docs/SAAS-EVIDENCE.md is written by hand from the console summary;
// the raw redacted capture goes to src/protocol/captures/saas-handshake-<date>.json.

import { config as dotenv } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync('.secrets/saas.env')) dotenv({ path: '.secrets/saas.env' });
else dotenv();

import { launchPersistent } from '../src/services/browser.js';

const baseUrl = (process.env.BC_BASE_URL || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('Set BC_BASE_URL to the SaaS environment URL, e.g.\n  https://businesscentral.dynamics.com/<aadTenantId>/<environment>');
  process.exit(1);
}
const profileDir = resolve(process.env.BC_AAD_PROFILE_DIR || './.state/aad-profile');
const timeoutMs = parseInt(process.env.CAPTURE_TIMEOUT_MS || '300000', 10); // 5 min for MFA
mkdirSync(profileDir, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Redact secret-looking values but keep structure/prefix so the shape is legible.
function redact(v: string): string {
  if (!v) return v;
  if (v.length <= 12) return v.length <= 4 ? '***' : v.slice(0, 2) + '***';
  return `${v.slice(0, 6)}...<redacted ${v.length} chars>`;
}
function redactUrlSecrets(u: string): string {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (/token|code|secret|csrf|id_token|access_token|session/i.test(k)) {
        url.searchParams.set(k, redact(url.searchParams.get(k) || ''));
      }
    }
    return url.toString();
  } catch { return u; }
}

interface WsFrame { dir: 'sent' | 'recv'; opcode: number; len: number; preview: unknown; }
interface WsRecord { url: string; frames: WsFrame[]; }

const wsByReqId = new Map<string, WsRecord>();
const navChain: Array<{ method: string; url: string; status?: number; type?: string }> = [];
let openSessionFrame: unknown = null;
let openSessionRawLen = 0;

function noteFrame(reqId: string, dir: 'sent' | 'recv', opcode: number, payload: string): void {
  const rec = wsByReqId.get(reqId);
  if (!rec) return;
  let parsed: unknown = payload.slice(0, 400);
  let isOpenSession = false;
  try {
    const j = JSON.parse(payload);
    // BC JSON-RPC frames: look for the OpenSession method anywhere in the frame.
    const s = JSON.stringify(j);
    if (/OpenSession/i.test(s) && dir === 'sent') { isOpenSession = true; }
    parsed = j;
  } catch { /* binary or partial frame */ }
  // Keep only a bounded number of frame previews per socket to stay readable.
  if (rec.frames.length < 40) rec.frames.push({ dir, opcode, len: payload.length, preview: summarize(parsed) });
  if (isOpenSession && !openSessionFrame) {
    openSessionFrame = extractOpenSession(parsed);
    openSessionRawLen = payload.length;
    console.log(`\n*** Captured OpenSession frame (${payload.length} bytes) on ${rec.url} ***`);
  }
}

// Trim big frames to the fields we care about for the spike write-up.
function summarize(v: unknown): unknown {
  const s = JSON.stringify(v);
  if (s.length <= 600) return v;
  return s.slice(0, 600) + `...<+${s.length - 600} chars>`;
}

// Pull the interesting OpenSession fields (applicationId, tenantId, features, ...)
// wherever they sit in the frame, without assuming the exact envelope shape.
function extractOpenSession(v: unknown): unknown {
  const found: Record<string, unknown> = {};
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, val] of Object.entries(o as Record<string, unknown>)) {
      if (/^(applicationId|tenantId|company|companyName|profile|clientVersion|version|compatibilityVersion|features|supportedExtensions|culture|locale|timeZone|telemetryClientSessionId)$/i.test(k)) {
        found[k] = typeof val === 'string' && /token|secret/i.test(k) ? redact(val) : val;
      }
      if (val && typeof val === 'object') walk(val);
    }
  };
  walk(v);
  return { extractedFields: found, rawEnvelope: summarize(v) };
}

async function main(): Promise<void> {
  console.log('[capture] launching HEADED browser with persistent profile:', profileDir);
  console.log('[capture] target:', baseUrl);
  const browser = await launchPersistent(profileDir, { headless: false });
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());

  const cdp = await page.target().createCDPSession();
  const conn = cdp.connection();

  // Enable Network on the top page for the OIDC redirect chain.
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e: { request: { method: string; url: string }; type?: string }) => {
    if (e.type === 'Document') navChain.push({ method: e.request.method, url: redactUrlSecrets(e.request.url), type: e.type });
  });
  cdp.on('Network.responseReceived', (e: { response: { url: string; status: number }; type?: string }) => {
    if (e.type === 'Document') {
      const last = navChain[navChain.length - 1];
      if (last && last.url.split('?')[0] === redactUrlSecrets(e.response.url).split('?')[0]) last.status = e.response.status;
      else navChain.push({ method: 'GET', url: redactUrlSecrets(e.response.url), status: e.response.status, type: e.type });
    }
  });

  // Auto-attach to workers (where BC opens the WS) and enable Network on each.
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  cdp.on('Target.attachedToTarget', async (e: { sessionId: string; targetInfo: { type: string; url: string } }) => {
    try {
      const s = conn.session(e.sessionId);
      if (!s) return;
      await s.send('Network.enable').catch(() => undefined);
      s.on('Network.webSocketCreated', (w: { requestId: string; url: string }) => {
        wsByReqId.set(w.requestId, { url: w.url, frames: [] });
        console.log(`\n[capture] WebSocket created (${e.targetInfo.type}): ${redactUrlSecrets(w.url)}`);
      });
      s.on('Network.webSocketFrameSent', (w: { requestId: string; response: { opcode: number; payloadData: string } }) =>
        noteFrame(w.requestId, 'sent', w.response.opcode, w.response.payloadData));
      s.on('Network.webSocketFrameReceived', (w: { requestId: string; response: { opcode: number; payloadData: string } }) =>
        noteFrame(w.requestId, 'recv', w.response.opcode, w.response.payloadData));
      await s.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
    } catch (err) {
      console.warn('[capture] attach error:', err instanceof Error ? err.message : String(err));
    }
  });

  console.log('\n=== Navigating. LOG IN + complete MFA in the opened window. ===\n');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e: Error) => {
    console.warn('[capture] initial goto:', e.message, '(continue — login may redirect)');
  });

  // Wait until we captured an OpenSession frame, or timeout.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !openSessionFrame) {
    await sleep(2000);
  }

  if (!openSessionFrame) {
    console.warn('\n[capture] No OpenSession frame captured before timeout. Saving whatever was seen.');
  }
  // Let a few trailing frames land.
  await sleep(2000);

  // Cookie jar (includes httpOnly) for the BC domain.
  let cookies: Array<{ name: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: string; value: string }> = [];
  try {
    const all = await cdp.send('Network.getAllCookies') as { cookies: typeof cookies };
    cookies = all.cookies.map((c) => ({ ...c, value: redact(c.value) }));
  } catch (e) {
    console.warn('[capture] getAllCookies failed:', e instanceof Error ? e.message : String(e));
  }

  const host = (() => { try { return new URL(baseUrl).host; } catch { return ''; } })();
  const bcCookies = cookies.filter((c) => c.domain.includes('businesscentral') || c.domain.includes(host));
  const entraCookies = cookies.filter((c) => c.domain.includes('microsoftonline') || c.domain.includes('microsoft.com'));

  const wsList = [...wsByReqId.values()].map((w) => ({ url: redactUrlSecrets(w.url), frameCount: w.frames.length, frames: w.frames }));

  const out = {
    capturedAt: new Date().toISOString(),
    baseUrl,
    openSession: { captured: !!openSessionFrame, rawLen: openSessionRawLen, fields: openSessionFrame },
    webSockets: wsList,
    oidcRedirectChain: navChain,
    cookies: {
      bc: bcCookies,
      entra: entraCookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite })),
    },
  };

  const dir = resolve('src/protocol/captures');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = resolve(dir, `saas-handshake-${stamp}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));

  console.log('\n===================== SPIKE SUMMARY =====================');
  console.log('WebSocket URL(s):');
  for (const w of wsList) console.log('  -', w.url);
  console.log('OpenSession captured:', !!openSessionFrame);
  if (openSessionFrame) console.log('OpenSession fields:', JSON.stringify((openSessionFrame as { extractedFields?: unknown }).extractedFields, null, 2));
  console.log('BC cookies:', bcCookies.map((c) => `${c.name} (path=${c.path} secure=${c.secure} httpOnly=${c.httpOnly} sameSite=${c.sameSite ?? '-'})`).join('\n  '));
  console.log('OIDC redirect chain:');
  for (const n of navChain) console.log(`  ${n.status ?? '...'} ${n.method} ${n.url}`);
  console.log('\nRaw capture written to:', file);
  console.log('=========================================================\n');
  console.log('Leave the browser open to inspect, or press Ctrl+C to exit.');

  // Keep the process alive so the user can inspect; they Ctrl+C when done.
  await new Promise(() => undefined);
}

main().catch((e) => {
  console.error('[capture] FATAL:', e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
