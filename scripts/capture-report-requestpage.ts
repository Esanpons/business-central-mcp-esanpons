// scripts/capture-report-requestpage.ts
//
// One-shot diagnostic for P9 (bc_download_report end-to-end). Opens a report's
// request page in the SAME authenticated headless browser bc_download_report
// uses, then dumps every interactive control (buttons / menu items / links) in
// every frame, and ALSO tries to open the "Send to…" menu and dumps the submenu
// (PDF / Excel / Word). The output tells us the exact selectors to drive so the
// tool can fill the request page and capture the download.
//
// Run:  npx tsx scripts/capture-report-requestpage.ts <reportId> [company]
//   e.g. npx tsx scripts/capture-report-requestpage.ts 6
//
// Credentials: loads .secrets/devel1.env if present, else .env, else the shell
// environment (BC_BASE_URL / BC_USERNAME / BC_PASSWORD / BC_TENANT_ID /
// NODE_TLS_REJECT_UNAUTHORIZED=0 for self-signed devel1).

import { config as dotenv } from 'dotenv';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync('.secrets/devel1.env')) dotenv({ path: '.secrets/devel1.env' });
else dotenv();

import { loadConfig } from '../src/core/config.js';
import { launchHeadless } from '../src/services/browser.js';
import { authCookies, deepLinkReport, onSignIn, inPageLogin, waitReady } from '../src/services/bc-web-auth.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Collect interactive controls in every frame. NOTE: the in-browser function
// must contain NO named nested functions (tsx/esbuild wraps them with a
// `__name` helper that is undefined in the browser) — only inline arrows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dumpFrames(p: any): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const f of p.frames()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = await f.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        const sel = 'button,[role="menuitem"],[role="button"],[role="menuitemcheckbox"],a[href],input[type="button"],input[type="submit"]';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const els: any[] = Array.prototype.slice.call(doc.querySelectorAll(sel));
        const items = els.slice(0, 300).map((el) => ({
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          role: el.getAttribute('role') || '',
          text: (el.textContent || '').trim().slice(0, 80),
          aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          cls: (el.getAttribute('class') || '').slice(0, 140),
          id: el.id || '',
          visible: el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0),
        })).filter((x) => x.text || x.aria || x.title);
        // Form FIELDS too (the "Send to" format dropdown + request-page parameters)
        // — these are NOT buttons, so they need their own selector. Captures
        // option lists where present so we can drive an explicit format/param.
        const fsel = 'input,select,textarea,[role="combobox"],[role="listbox"],[role="option"],[role="textbox"],[aria-haspopup="true"]';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fels: any[] = Array.prototype.slice.call(doc.querySelectorAll(fsel));
        const fields = fels.slice(0, 200).map((el) => ({
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          type: el.getAttribute('type') || '',
          role: el.getAttribute('role') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          aria: el.getAttribute('aria-label') || '',
          // Resolve a human label: <label for=id>, else the enclosing <label>,
          // else the aria-labelledby target. Inline (no nested named fn) to avoid
          // the tsx/esbuild __name wrapper that breaks page.evaluate.
          label: (el.id && doc.querySelector('label[for="' + el.id + '"]')
            ? (doc.querySelector('label[for="' + el.id + '"]').textContent || '').trim()
            : (el.closest && el.closest('label') ? (el.closest('label').textContent || '').trim()
              : (el.getAttribute('aria-labelledby') && doc.getElementById(el.getAttribute('aria-labelledby'))
                ? (doc.getElementById(el.getAttribute('aria-labelledby')).textContent || '').trim() : ''))).slice(0, 80),
          value: (el.value != null ? String(el.value) : (el.getAttribute('value') || '')).slice(0, 80),
          text: (el.textContent || '').trim().slice(0, 80),
          options: el.tagName && el.tagName.toLowerCase() === 'select'
            ? Array.prototype.slice.call(el.options || []).map((o: { textContent?: string }) => (o.textContent || '').trim()).slice(0, 25)
            : undefined,
          visible: el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0),
        })).filter((x) => x.visible && (x.aria || x.text || x.name || x.id || x.options));
        return { url: (globalThis as any).location ? (globalThis as any).location.href : '', title: doc.title || '', total: els.length, items, fields };
      });
      out.push(info);
    } catch (e) {
      out.push({ error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// Best-effort: click a "Send to" / Print / Preview control to reveal the output
// submenu, so a follow-up dump captures the PDF/Excel/Word menu items.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryOpenSendTo(p: any): Promise<string | null> {
  const labels = ['Send to…', 'Send to...', 'Send to', 'Enviar a…', 'Enviar a...', 'Enviar a', 'Imprimir', 'Print', 'Preview', 'Vista previa', 'Vista prèvia'];
  for (const f of p.frames()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clicked: string | null = await f.evaluate((wants: string[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const els: any[] = Array.prototype.slice.call(doc.querySelectorAll('button,[role="menuitem"],[role="button"],a'));
        for (const want of wants) {
          const hit = els.find((b) => ((b.getAttribute('aria-label') || '').trim() === want) || ((b.textContent || '').trim() === want));
          if (hit) { hit.click(); return want; }
        }
        return null;
      }, labels);
      if (clicked) return clicked;
    } catch { /* cross-origin / empty frame */ }
  }
  return null;
}

const reportId = (process.argv[2] || '6').trim();
const company = process.argv[3];
const cfg = loadConfig();
const url = deepLinkReport(cfg.bc, reportId, company);
console.log('[capture] report', reportId, '->', url);

const browser = await launchHeadless();
try {
  const cookies = await authCookies(cfg.bc);
  const p = await browser.newPage();
  await p.setViewport({ width: 1600, height: 1000 });
  await p.setCookie(...cookies);
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  if (await onSignIn(p)) {
    console.log('[capture] cookie injection bounced to SignIn — logging in in-page');
    await inPageLogin(cfg.bc, p);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => undefined);
  }
  await waitReady(p);
  await sleep(1000);

  const before = await dumpFrames(p);
  const clickedSendTo = await tryOpenSendTo(p);
  await sleep(1500);
  const after = clickedSendTo ? await dumpFrames(p) : null;

  const dump = {
    capturedFor: { reportId, company: company || '(session default)', url },
    pageTitle: await p.title(),
    authenticated: !(await onSignIn(p)),
    frameUrls: p.frames().map((f: { url: () => string }) => f.url()),
    clickedSendTo,
    before,
    after,
  };

  const dir = resolve(process.cwd(), '.report-capture');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `report-${reportId}-requestpage.json`);
  writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');

  console.log('\n[capture] WROTE', file);
  console.log('[capture] authenticated:', dump.authenticated, '| clickedSendTo:', clickedSendTo, '| frames:', dump.frameUrls.length);
  console.log('\n[capture] candidate OUTPUT controls (Send to / Print / Preview / PDF / Excel / Word / OK / Schedule):');
  const rx = /send|enviar|print|imprim|preview|previa|prèvia|pdf|excel|word|schedule|programar|ok|aceptar|d.acord|close|cerrar|tancar/i;
  for (const phase of [['before', before] as const, ['after', after ?? []] as const]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const fr of phase[1] as any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const it of (fr.items || []) as any[]) {
        if (rx.test(`${it.text} ${it.aria} ${it.title}`)) {
          console.log(`  [${phase[0]}] ${JSON.stringify(it)}`);
        }
      }
    }
  }
  console.log('\n[capture] visible FIELDS after opening "Send to" (format dropdown / request-page params):');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const fr of (after ?? before) as any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const fld of (fr.fields || []) as any[]) {
      console.log(`  ${JSON.stringify(fld)}`);
    }
  }
  console.log('\n[capture] Paste me the file above (or this console output) to continue.');
} finally {
  await browser.close();
}
