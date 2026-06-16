// Throwaway: test whether the BC web client honors a `filter=` URL param on page 9174,
// so we can decide if "filter at open" is a viable way to read only custom objects.
// Captures one screenshot per candidate filter syntax. Run: tsx scripts/test-filter-url.ts
import { load } from 'cheerio';
import { launchHeadless } from '../src/services/browser.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = (process.env.BC_BASE_URL || 'https://devel1/BC').replace(/\/+$/, '');
const USER = process.env.BC_USERNAME!, PASS = process.env.BC_PASSWORD!, TENANT = process.env.BC_TENANT_ID || 'default';
const HOST = new URL(BASE).host;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- auth: forms /SignIn -> attributed cookie jar (same as ScreenshotService) ---
async function authCookies() {
  const signIn = `${BASE}/SignIn?tenant=${TENANT}`;
  const get = await fetch(signIn, { redirect: 'manual', headers: { 'User-Agent': 'flt' } });
  const getCk = get.headers.getSetCookie();
  const token = load(await get.text())('input[name="__RequestVerificationToken"]').attr('value') || '';
  const post = await fetch(signIn, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'flt', Cookie: getCk.map((c) => c.split(';')[0]).join('; ') },
    body: new URLSearchParams({ UserName: USER, Password: PASS, __RequestVerificationToken: token }).toString(),
  });
  if (post.status !== 302) throw new Error(`auth ${post.status}`);
  const map = new Map<string, any>();
  for (const line of [...getCk, ...post.headers.getSetCookie()]) {
    const [nv, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = nv.indexOf('=');
    const ss = attrs.find((a) => a.toLowerCase().startsWith('samesite='));
    map.set(nv.slice(0, eq), {
      name: nv.slice(0, eq), value: nv.slice(eq + 1), domain: HOST,
      path: (attrs.find((a) => a.toLowerCase().startsWith('path=')) || 'path=/').split('=')[1],
      secure: attrs.some((a) => a.toLowerCase() === 'secure'),
      httpOnly: attrs.some((a) => a.toLowerCase() === 'httponly'),
      sameSite: ss && ss.split('=')[1].toLowerCase() === 'none' ? 'None' : 'Lax',
    });
  }
  return [...map.values()];
}

const CANDIDATES: Record<string, string> = {
  'A-objectid-range': `filter='Object ID' IS '50000..99999'`,
  'B-type-page': `filter='Object Type' IS 'Page'`,
  'C-combined': `filter='Object Type' IS 'Page'&'Object ID' IS '50000..99999'`,
};

const browser = await launchHeadless();
try {
  const cookies = await authCookies();
  for (const [name, flt] of Object.entries(CANDIDATES)) {
    const url = `${BASE}/?page=9174&tenant=${TENANT}&${flt.replace(/^filter=/, 'filter=')}`.replace(/ /g, '%20').replace(/'/g, '%27');
    const p = await browser.newPage();
    await p.setViewport({ width: 1700, height: 1000, deviceScaleFactor: 1 });
    // @ts-ignore
    await p.setCookie(...cookies);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(8000);
    const file = `screenshots/filter-${name}.png`;
    await p.screenshot({ path: file, fullPage: false });
    const title = await p.title();
    console.log(`[${name}] ${url}\n   title=${title}\n   -> ${file}`);
    await p.close();
  }
} finally {
  await browser.close();
}
