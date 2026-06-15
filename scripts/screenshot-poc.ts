/**
 * Screenshot PoC — capture REAL screenshots of the BC web client four ways.
 *
 * This is a throwaway experiment to compare the four capture strategies designed
 * in the feasibility analysis and learn each one's real-world limitations:
 *
 *   1  cookie-inject   bc-mcp authenticates via /SignIn, exports the cookie jar
 *                      (with real attributes), injects it into headless Chrome, opens
 *                      the deep-link URL, screenshots. Fully unattended, no UI login.
 *   2  persist-login   Headless Chrome with a persistent profile logs in ONCE via the
 *                      real /SignIn form, then opens the deep-link. Browser mints its
 *                      own correctly-scoped cookies.
 *   3  annotate        Like method 1/2 but draws a highlight box around a named field
 *                      before capture (the "auto-annotation for manuals" feature).
 *   4  chrome-cli      Zero-npm-dep: system Chrome `--headless=new --screenshot` against
 *                      a pre-authenticated user-data-dir (reuses method 2's profile).
 *
 * Nothing here touches the running MCP server or its WebSocket path — it is additive.
 *
 * Usage:
 *   tsx scripts/screenshot-poc.ts --method=all --page=21 \
 *       --bookmark=1B_EgAAAAJ7CDAAMQAxADIAMQAyADEAMg --company=CRONUS_01 \
 *       --expect="Spotsmeyer" --highlight=Name
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, cpSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import puppeteer from 'puppeteer-core';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ---------- config / args ----------
function arg(name: string, fallback = ''): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = (process.env.BC_BASE_URL || '').replace(/\/+$/, '');
const USER = process.env.BC_USERNAME || '';
const PASS = process.env.BC_PASSWORD || '';
const TENANT = process.env.BC_TENANT_ID || 'default';
if (!BASE || !USER || !PASS) { console.error('Set BC_BASE_URL, BC_USERNAME, BC_PASSWORD env vars.'); process.exit(1); }
const HOST = new URL(BASE).host; // devel1
const BASE_PATH = new URL(BASE).pathname.replace(/\/+$/, ''); // /BC

const method = arg('method', 'all');
const page = arg('page', '21');
const bookmark = arg('bookmark', '');
const company = arg('company', '');
const expect = arg('expect', ''); // text expected on the rendered page (verifies right record/company)
const highlight = arg('highlight', 'Name'); // field caption to box in method 3
const extra = arg('extra', ''); // extra URL params (NOTE: runinframe=1 hangs a top-level load)

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p))!;

const OUT = resolve('.poc/shots');
const PROFILE_MAIN = resolve('.poc/profile-main');
const PROFILE_CLI = resolve('.poc/profile-cli');
mkdirSync(OUT, { recursive: true });

// ---------- deep link ----------
function deepLink(): string {
  const qs = new URLSearchParams();
  qs.set('page', page);
  qs.set('tenant', TENANT);
  if (company) qs.set('company', company);
  if (bookmark) qs.set('bookmark', bookmark);
  let url = `${BASE}/?${qs.toString()}`;
  if (extra) url += `&${extra}`;
  return url;
}

// ---------- auth (for cookie injection) ----------
interface RawCookie { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: 'None' | 'Lax' | 'Strict'; }

function parseSetCookie(line: string): RawCookie {
  const parts = line.split(';').map((s) => s.trim());
  const [nv, ...attrs] = parts;
  const eq = nv.indexOf('=');
  const name = nv.slice(0, eq);
  const value = nv.slice(eq + 1);
  const lower = attrs.map((a) => a.toLowerCase());
  const pathAttr = attrs.find((a) => a.toLowerCase().startsWith('path='));
  let sameSite: RawCookie['sameSite'] = 'Lax';
  const ss = attrs.find((a) => a.toLowerCase().startsWith('samesite='));
  if (ss) {
    const v = ss.split('=')[1].toLowerCase();
    sameSite = v === 'none' ? 'None' : v === 'strict' ? 'Strict' : 'Lax';
  }
  return {
    name,
    value,
    domain: HOST,
    path: pathAttr ? pathAttr.split('=')[1] : '/',
    secure: lower.includes('secure'),
    httpOnly: lower.includes('httponly'),
    sameSite,
  };
}

async function authCookies(): Promise<RawCookie[]> {
  const signInUrl = `${BASE}/SignIn?tenant=${encodeURIComponent(TENANT)}`;
  const get = await fetch(signInUrl, { redirect: 'manual', headers: { 'User-Agent': 'bc-mcp-poc' } });
  const getCk = get.headers.getSetCookie();
  const $ = load(await get.text());
  const token = $('input[name="__RequestVerificationToken"]').attr('value') || '';
  const body = new URLSearchParams({ UserName: USER, Password: PASS, __RequestVerificationToken: token });
  const post = await fetch(signInUrl, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'bc-mcp-poc',
      Cookie: getCk.map((c) => c.split(';')[0]).join('; '),
    },
    body: body.toString(),
  });
  if (post.status !== 302) throw new Error(`auth failed: POST /SignIn returned ${post.status} (expected 302)`);
  // de-dup by name, last wins
  const all = [...getCk, ...post.headers.getSetCookie()].map(parseSetCookie);
  const map = new Map<string, RawCookie>();
  for (const c of all) map.set(c.name, c);
  return [...map.values()];
}

// ---------- shared browser helpers ----------
const VIEWPORT = { width: 1600, height: 1000, deviceScaleFactor: 2 };
const LAUNCH_ARGS = ['--ignore-certificate-errors', '--disable-gpu', '--no-sandbox', '--hide-scrollbars'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GENERIC_TITLES = /^(Dynamics 365 Business Central|Welcome to Dynamics 365 Business Central\.?|)$/i;

async function waitForBcReady(p: any): Promise<{ loadedMs: number; everReady: boolean }> {
  // BC is a heavy SPA whose page content renders inside an iframe. The reliable
  // "rendered" signal is the document TITLE flipping from the generic boot title to
  // the page's own title ("Customer Card | ... - 01121212 · Spotsmeyer's") AND the
  // "Getting ready" spinner being gone. NEVER use runinframe=1 (it hangs top-level).
  const start = Date.now();
  const deadline = start + 60000;
  let everReady = false;
  while (Date.now() < deadline) {
    const st = await p.evaluate((generic: string) => {
      const title = (document.title || '').trim();
      const sp = document.querySelector('[class*="spinner"],[class*="Spinner"]') as HTMLElement | null;
      const spinnerVisible = !!sp && sp.offsetParent !== null;
      return { title, spinnerVisible, generic: new RegExp(generic, 'i').test(title) };
    }, GENERIC_TITLES.source).catch(() => ({ title: '', spinnerVisible: true, generic: true }));
    if (!st.spinnerVisible && !st.generic) { everReady = true; break; }
    await sleep(1000);
  }
  await sleep(3500); // settle final layout/data binding
  return { loadedMs: Date.now() - start, everReady };
}

async function pageReport(p: any): Promise<{ url: string; bounced: boolean; mentionsExpect: boolean; title: string; frames: number }> {
  const url = p.url();
  const info = await p.evaluate((expectText: string) => {
    const body = document.body?.innerText || '';
    return {
      title: document.title,
      hasSignIn: /user name|password/i.test(body) && !!document.querySelector('#UserName,#Password'),
      mentions: expectText ? body.includes(expectText) || document.title.includes(expectText) : false,
    };
  }, expect);
  // BC renders content in an iframe — also scan child frames for the expected text.
  let mentions = info.mentions;
  if (expect && !mentions) {
    for (const f of p.frames()) {
      try { if (await f.evaluate((t: string) => (document.body?.innerText || '').includes(t), expect)) { mentions = true; break; } } catch { /* cross-origin */ }
    }
  }
  return { url, bounced: url.includes('SignIn') || info.hasSignIn, mentionsExpect: mentions, title: info.title, frames: p.frames().length };
}

// ---------- methods ----------
type Result = { method: string; ok: boolean; file?: string; notes: string[]; report?: any; error?: string };

async function method1Cookie(url: string): Promise<Result> {
  const notes: string[] = [];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: LAUNCH_ARGS, acceptInsecureCerts: true });
  try {
    const cookies = await authCookies();
    notes.push(`injected ${cookies.length} cookies: ${cookies.map((c) => `${c.name}[path=${c.path};ss=${c.sameSite};sec=${c.secure}]`).join(', ')}`);
    const p = await browser.newPage();
    await p.setViewport(VIEWPORT);
    // @ts-ignore - page.setCookie still works
    await p.setCookie(...cookies.map((c) => ({ ...c })));
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForBcReady(p);
    const file = resolve(OUT, 'm1-cookie.png');
    await p.screenshot({ path: file, fullPage: false });
    const report = await pageReport(p);
    return { method: '1 cookie-inject', ok: !report.bounced, file, notes, report };
  } finally {
    await browser.close();
  }
}

async function method2Persist(url: string): Promise<Result> {
  const notes: string[] = [];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: PROFILE_MAIN, args: LAUNCH_ARGS, acceptInsecureCerts: true });
  try {
    const p = await browser.newPage();
    await p.setViewport(VIEWPORT);
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let rep = await pageReport(p);
    if (rep.bounced) {
      // The bounce landed us on the SignIn page whose ReturnUrl IS our deep link.
      // Fill it and submit — BC authenticates and redirects straight to the deep link.
      notes.push('not authenticated — logging in via the bounced SignIn page (ReturnUrl -> deep link)');
      await p.waitForSelector('#UserName', { timeout: 15000 });
      await p.type('#UserName', USER);
      await p.type('#Password', PASS);
      await Promise.all([
        p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
        p.click('#submitButton'),
      ]);
    } else {
      notes.push('profile already authenticated — skipped login');
    }
    const ready = await waitForBcReady(p);
    notes.push(`spa ready=${ready.everReady} after ${ready.loadedMs}ms`);
    const file = resolve(OUT, 'm2-persist.png');
    await p.screenshot({ path: file, fullPage: false });
    rep = await pageReport(p);
    return { method: '2 persist-login', ok: !rep.bounced && ready.everReady, file, notes, report: rep };
  } finally {
    await browser.close();
  }
}

async function method3Annotate(url: string): Promise<Result> {
  const notes: string[] = [];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: LAUNCH_ARGS, acceptInsecureCerts: true });
  try {
    const cookies = await authCookies();
    const p = await browser.newPage();
    await p.setViewport(VIEWPORT);
    // @ts-ignore
    await p.setCookie(...cookies.map((c) => ({ ...c })));
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForBcReady(p);
    // Content is inside a BC iframe — search every frame for a control matching the
    // caption (aria-label first, then exact text), draw a highlight box in that frame.
    const locator = (caption: string) => {
      const els = Array.from(document.querySelectorAll('*')) as HTMLElement[];
      let target: HTMLElement | null = null;
      for (const el of els) {
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim() === caption) { target = el; break; }
      }
      if (!target) {
        for (const el of els) {
          if (el.childElementCount === 0 && el.textContent?.trim() === caption) { target = (el.closest('[class]') as HTMLElement) || el; break; }
        }
      }
      if (!target) return null;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border:3px solid #e11;border-radius:4px;box-shadow:0 0 0 9999px rgba(0,0,0,.08);z-index:2147483647;pointer-events:none;`;
      document.body.appendChild(box);
      return { tag: target.tagName, cls: (target.className?.toString() || '').slice(0, 80), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    let located: any = null;
    for (const f of p.frames()) {
      try { located = await f.evaluate(locator, highlight); } catch { /* cross-origin */ }
      if (located) break;
    }
    if (located) notes.push(`highlighted "${highlight}" at ${JSON.stringify(located)}`);
    else notes.push(`could NOT locate caption "${highlight}" in any frame (annotation limitation)`);
    const file = resolve(OUT, 'm3-annotate.png');
    await p.screenshot({ path: file, fullPage: false });
    const report = await pageReport(p);
    return { method: '3 annotate', ok: !report.bounced && !!located, file, notes, report };
  } finally {
    await browser.close();
  }
}

async function method4ChromeCli(url: string): Promise<Result> {
  const notes: string[] = [];
  if (!existsSync(PROFILE_MAIN)) return { method: '4 chrome-cli', ok: false, notes: ['needs method 2 profile first (run --method=all or --method=2)'], error: 'no authenticated profile' };
  // Chrome locks a profile dir while running, so copy the authenticated profile.
  rmSync(PROFILE_CLI, { recursive: true, force: true });
  cpSync(PROFILE_MAIN, PROFILE_CLI, { recursive: true });
  notes.push('copied authenticated profile-main -> profile-cli');
  const file = resolve(OUT, 'm4-cli.png');
  const args = [
    '--headless=new', '--disable-gpu', '--ignore-certificate-errors', '--hide-scrollbars',
    `--user-data-dir=${PROFILE_CLI}`, '--window-size=1600,1000', '--virtual-time-budget=10000',
    `--screenshot=${file}`, url,
  ];
  const code: number = await new Promise((res) => {
    const c = spawn(CHROME, args, { stdio: 'ignore' });
    c.on('exit', (x) => res(x ?? -1));
  });
  notes.push(`chrome exited code ${code}; --virtual-time-budget is a blunt timer (no content-ready signal)`);
  return { method: '4 chrome-cli', ok: code === 0 && existsSync(file), file, notes };
}

// ---------- run ----------
async function main() {
  const url = deepLink();
  console.log('Chrome   :', CHROME);
  console.log('Deep link:', url);
  console.log('');

  const results: Result[] = [];
  const want = (m: string) => method === 'all' || method === m || method === `m${m}`;

  // order: 2 (creates profile) -> 4 (reuses it) -> 1 -> 3
  if (want('2')) results.push(await safe('2', () => method2Persist(url)));
  if (want('4')) results.push(await safe('4', () => method4ChromeCli(url)));
  if (want('1')) results.push(await safe('1', () => method1Cookie(url)));
  if (want('3')) results.push(await safe('3', () => method3Annotate(url)));

  console.log('\n================ SUMMARY ================');
  for (const r of results) {
    console.log(`\n[${r.ok ? 'OK ' : 'XX '}] Method ${r.method}`);
    if (r.file) console.log(`      file : ${r.file}`);
    if (r.report) console.log(`      page : url=${r.report.url}\n             bounced=${r.report.bounced} mentionsExpect=${r.report.mentionsExpect} title="${r.report.title}"`);
    for (const n of r.notes) console.log(`      note : ${n}`);
    if (r.error) console.log(`      ERR  : ${r.error}`);
  }
  writeFileSync(resolve(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} result(s) + PNGs under ${OUT}`);
}

async function safe(label: string, fn: () => Promise<Result>): Promise<Result> {
  try { return await fn(); }
  catch (e) { return { method: label, ok: false, notes: [], error: e instanceof Error ? e.stack || e.message : String(e) }; }
}

main().catch((e) => { console.error(e); process.exit(1); });
