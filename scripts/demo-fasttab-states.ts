/**
 * Demo: capture the SAME FastTab ("Invoice Details" on Sales Order 101005) in three states,
 * to illustrate the screenshot reveal feature:
 *   1-collapsed  — group hidden (FastTab collapsed)
 *   2-expanded   — group shown (standard fields, "Show more" NOT clicked)
 *   3-showmore   — group fully expanded (standard + Additional fields revealed)
 *
 * Drives one authenticated browser session directly (reusing the cookie-injection auth),
 * manipulates the DOM into each state, scrolls the tab to the top, draws a red outline
 * around the "Invoice Details" header, and writes a PNG per state under .poc/demo.
 *
 * Usage:  npx tsx scripts/demo-fasttab-states.ts
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import puppeteer from 'puppeteer-core';

// ---- load .secrets/devel1.env ----
const envText = readFileSync(resolve('.secrets/devel1.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = (process.env.BC_BASE_URL || '').replace(/\/+$/, '');
const USER = process.env.BC_USERNAME!;
const PASS = process.env.BC_PASSWORD!;
const TENANT = process.env.BC_TENANT_ID || 'default';
const HOST = new URL(BASE).host;
const COMPANY = 'CRONUS_01';
const BOOKMARK = '1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMAA1'; // Sales Order 101005
const TAB = 'Invoice Details';

const CHROME = [
  process.env.BC_SCREENSHOT_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p) as string;

const OUT = resolve('.poc/demo');
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RawCookie { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: 'None' | 'Lax' | 'Strict'; }
function parseSetCookie(line: string): RawCookie {
  const parts = line.split(';').map((s) => s.trim());
  const nv = parts[0]; const attrs = parts.slice(1);
  const eq = nv.indexOf('='); const lower = attrs.map((a) => a.toLowerCase());
  const pathAttr = attrs.find((a) => a.toLowerCase().startsWith('path='));
  let sameSite: RawCookie['sameSite'] = 'Lax';
  const ss = attrs.find((a) => a.toLowerCase().startsWith('samesite='));
  if (ss) { const v = (ss.split('=')[1] || '').toLowerCase(); sameSite = v === 'none' ? 'None' : v === 'strict' ? 'Strict' : 'Lax'; }
  return { name: nv.slice(0, eq), value: nv.slice(eq + 1), domain: HOST, path: pathAttr ? pathAttr.split('=')[1] : '/', secure: lower.includes('secure'), httpOnly: lower.includes('httponly'), sameSite };
}
async function authCookies(): Promise<RawCookie[]> {
  const url = `${BASE}/SignIn?tenant=${encodeURIComponent(TENANT)}`;
  const get = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'bc-mcp-demo' } });
  const getCk = get.headers.getSetCookie();
  const $ = load(await get.text());
  const token = $('input[name="__RequestVerificationToken"]').attr('value') || '';
  const post = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'bc-mcp-demo', Cookie: getCk.map((c) => c.split(';')[0]).join('; ') }, body: new URLSearchParams({ UserName: USER, Password: PASS, __RequestVerificationToken: token }).toString() });
  if (post.status !== 302) throw new Error(`auth failed: ${post.status}`);
  const map = new Map<string, RawCookie>();
  for (const l of [...getCk, ...post.headers.getSetCookie()]) { const c = parseSetCookie(l); map.set(c.name, c); }
  return [...map.values()];
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--ignore-certificate-errors', '--disable-gpu', '--no-sandbox', '--hide-scrollbars'], acceptInsecureCerts: true });
  try {
    const cookies = await authCookies();
    const p = await browser.newPage();
    await p.setViewport({ width: 1500, height: 1150, deviceScaleFactor: 2 });
    // @ts-ignore
    await p.setCookie(...cookies);
    const url = `${BASE}/?page=42&tenant=${TENANT}&company=${COMPANY}&bookmark=${BOOKMARK}`;
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    // wait for SPA title
    for (let i = 0; i < 60; i++) {
      const t = await p.title();
      if (t && !/^(Dynamics 365 Business Central|Welcome.*|)$/i.test(t.trim())) break;
      await sleep(1000);
    }
    await sleep(3500);

    // locate the content frame holding the Invoice Details tab
    let frame: any = null;
    for (const f of p.frames()) {
      try {
        const has = await f.evaluate((tab: string) => {
          const doc = (globalThis as any).document;
          return Array.prototype.slice.call(doc.querySelectorAll('span.ms-nav-columns-caption .caption-text'))
            .some((e: any) => (e.textContent || '').trim() === tab);
        }, TAB);
        if (has) { frame = f; break; }
      } catch { /* cross-origin */ }
    }
    if (!frame) throw new Error('Invoice Details tab not found in any frame');

    // helper that puts the tab in a given state, frames it, and screenshots
    const shoot = async (file: string, state: 'collapsed' | 'expanded' | 'showmore') => {
      await frame.evaluate(async (args: { tab: string; state: string }) => {
        const doc = (globalThis as any).document;
        const caps = Array.prototype.slice.call(doc.querySelectorAll('span.ms-nav-columns-caption[aria-expanded]'));
        const cap = caps.find((c: any) => { const t = c.querySelector('.caption-text'); return t && t.textContent.trim() === args.tab; });
        if (!cap) return;
        const expanded = cap.getAttribute('aria-expanded') === 'true';
        if (args.state === 'collapsed' && expanded) cap.click();
        if ((args.state === 'expanded' || args.state === 'showmore') && !expanded) cap.click();
        await new Promise((r) => setTimeout(r, 700));

        // find this tab's "Show more" button (inside the same tab container) and set its state
        let container = cap; for (let i = 0; i < 8 && container; i++) { if (container.querySelector && container.querySelector('button.show-more-fields-button')) break; container = container.parentElement; }
        const sm = container && container.querySelector ? container.querySelector('button.show-more-fields-button') : null;
        if (sm) {
          // detect current state by effect: count visible nodes, click, compare (inline — no
          // nested const arrow, which tsx/esbuild would wrap with an undefined __name helper).
          let before = 0; let a = doc.querySelectorAll('*');
          for (let k = 0; k < a.length; k++) if (a[k].offsetParent !== null) before++;
          sm.click(); await new Promise((r) => setTimeout(r, 500));
          let after = 0; a = doc.querySelectorAll('*');
          for (let k = 0; k < a.length; k++) if (a[k].offsetParent !== null) after++;
          // showmore wants the count UP (revealed); expanded wants it unchanged (standard only)
          const wantUp = args.state === 'showmore';
          if ((wantUp && after < before) || (!wantUp && after > before)) { sm.click(); await new Promise((r) => setTimeout(r, 400)); }
        }
        // scroll the tab header near the top and outline it
        cap.scrollIntoView({ block: 'start' });
        await new Promise((r) => setTimeout(r, 300));
        Array.prototype.slice.call(doc.querySelectorAll('[data-demo]')).forEach((n: any) => n.remove());
        const r = cap.getBoundingClientRect();
        const box = doc.createElement('div');
        box.setAttribute('data-demo', '1');
        box.style.cssText = `position:fixed;left:${r.left - 6}px;top:${r.top - 4}px;width:${Math.max(r.width, 360)}px;height:${r.height + 8}px;border:3px solid #e11;border-radius:4px;z-index:2147483647;pointer-events:none;`;
        doc.body.appendChild(box);
      }, { tab: TAB, state });
      await sleep(500);
      await p.screenshot({ path: resolve(OUT, file), fullPage: false });
      console.log('wrote', file);
    };

    await shoot('1-collapsed.png', 'collapsed');
    await shoot('2-expanded.png', 'expanded');
    await shoot('3-showmore.png', 'showmore');
    console.log('\nDone. PNGs under', OUT);
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
