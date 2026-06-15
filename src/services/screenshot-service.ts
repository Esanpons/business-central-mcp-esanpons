import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { load } from 'cheerio';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

/**
 * ScreenshotService — captures a REAL screenshot of the BC web client.
 *
 * This is additive and OUT-OF-BAND: it does NOT touch the WebSocket protocol path
 * or the invoke queue, so normal bc-mcp operations keep their full speed. A headless
 * browser (system Chrome/Edge via puppeteer-core, no bundled download) is launched
 * on demand only when a screenshot is requested, then torn down.
 *
 * Engine = "cookie injection" (the most stable, fully-unattended method, verified
 * live against BC27/devel1): bc-mcp authenticates to BC's forms login (/SignIn),
 * exports the resulting cookie jar WITH its real attributes (path=/BC; secure;
 * samesite=none; httponly), injects it into the browser, and opens a deep-link URL
 * built from the page id + bookmark + company. If injection ever lands on the login
 * page, it falls back to performing the /SignIn form once in-page.
 *
 * IMPORTANT: never send runinframe=1 in the URL — it makes a top-level load hang on
 * "Getting ready..." waiting for an iframe-parent handshake that never arrives.
 */

export interface CaptureInput {
  pageId: string;
  bookmark?: string;
  company?: string;
  highlight?: string;
  out?: string;
  width?: number;
  height?: number;
  scale?: number;
  fullPage?: boolean;
  inline?: boolean;
}

export interface CaptureResult {
  path: string;
  url: string;
  pageTitle: string;
  authenticated: boolean;
  spaReady: boolean;
  highlight?: { requested: string; found: boolean };
  width: number;
  height: number;
  base64?: string;
}

interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'None' | 'Lax' | 'Strict';
}

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const GENERIC_TITLE = /^(Dynamics 365 Business Central|Welcome to Dynamics 365 Business Central\.?|)$/i;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let puppeteerMod: any = null;

export class ScreenshotService {
  constructor(
    private readonly config: BCConfig,
    private readonly screenshotDir: string,
    private readonly getCompany: () => string | undefined,
    private readonly logger: Logger,
  ) {}

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const pageId = String(input.pageId).trim();
    const company = input.company || this.getCompany();
    const url = this.deepLink(pageId, input.bookmark, company);
    const ignoreTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';

    const puppeteer = await this.loadPuppeteer();
    const executablePath = this.resolveChrome();
    this.logger.info(`[screenshot] capturing ${url}`);

    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      acceptInsecureCerts: ignoreTls,
      args: ['--disable-gpu', '--no-sandbox', '--hide-scrollbars', ...(ignoreTls ? ['--ignore-certificate-errors'] : [])],
    });
    try {
      const cookies = await this.authCookies();
      const p = await browser.newPage();
      const width = input.width ?? 1600;
      const height = input.height ?? 1000;
      await p.setViewport({ width, height, deviceScaleFactor: input.scale ?? 2 });
      await p.setCookie(...cookies);
      await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // Fallback: if cookie injection didn't take, log in once via the bounced
      // SignIn form (its ReturnUrl is our deep link, so BC redirects right back).
      if (await this.onSignIn(p)) {
        this.logger.warn('[screenshot] cookie injection landed on SignIn — logging in in-page');
        await this.inPageLogin(p);
      }

      const spaReady = await this.waitReady(p);

      let highlight: CaptureResult['highlight'];
      if (input.highlight) {
        const found = await this.drawHighlight(p, input.highlight);
        highlight = { requested: input.highlight, found };
      }

      const file = this.resolveOut(input.out, pageId);
      const buf: Uint8Array = await p.screenshot({ path: file, fullPage: input.fullPage ?? false });
      const pageTitle = await p.title();
      const authenticated = !(await this.onSignIn(p));

      return {
        path: file,
        url,
        pageTitle,
        authenticated,
        spaReady,
        highlight,
        width,
        height,
        base64: input.inline ? Buffer.from(buf).toString('base64') : undefined,
      };
    } finally {
      await browser.close();
    }
  }

  // ---------- deep link ----------
  private deepLink(pageId: string, bookmark?: string, company?: string): string {
    const qs = new URLSearchParams();
    qs.set('page', pageId);
    qs.set('tenant', this.config.tenantId);
    if (company) qs.set('company', company);
    if (bookmark) qs.set('bookmark', bookmark);
    // NEVER add runinframe=1 — it hangs a top-level load.
    return `${this.config.baseUrl}/?${qs.toString()}`;
  }

  // ---------- auth (forms /SignIn -> attributed cookie jar) ----------
  private async authCookies(): Promise<RawCookie[]> {
    const host = new URL(this.config.baseUrl).host;
    const signInUrl = `${this.config.baseUrl}/SignIn?tenant=${encodeURIComponent(this.config.tenantId)}`;
    const get = await fetch(signInUrl, { redirect: 'manual', headers: { 'User-Agent': 'bc-mcp-screenshot' } });
    const getCk = get.headers.getSetCookie();
    const $ = load(await get.text());
    const token = $('input[name="__RequestVerificationToken"]').attr('value') || '';
    const body = new URLSearchParams({ UserName: this.config.username, Password: this.config.password, __RequestVerificationToken: token });
    const post = await fetch(signInUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'bc-mcp-screenshot',
        Cookie: getCk.map((c) => c.split(';')[0]).join('; '),
      },
      body: body.toString(),
    });
    if (post.status !== 302) {
      throw new Error(`BC sign-in failed: POST /SignIn returned ${post.status} (expected 302). Check BC_USERNAME / BC_PASSWORD.`);
    }
    const map = new Map<string, RawCookie>();
    for (const line of [...getCk, ...post.headers.getSetCookie()]) {
      const c = this.parseSetCookie(line, host);
      map.set(c.name, c);
    }
    return [...map.values()];
  }

  private parseSetCookie(line: string, host: string): RawCookie {
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

  // ---------- browser helpers ----------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onSignIn(p: any): Promise<boolean> {
    if (p.url().includes('SignIn')) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return p.evaluate(() => !!(globalThis as any).document.querySelector('#UserName,#Password')).catch(() => false);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async inPageLogin(p: any): Promise<void> {
    await p.waitForSelector('#UserName', { timeout: 15000 });
    await p.type('#UserName', this.config.username);
    await p.type('#Password', this.config.password);
    await Promise.all([
      p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => undefined),
      p.click('#submitButton'),
    ]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async waitReady(p: any): Promise<boolean> {
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
      const st = await p
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    await sleep(3500); // settle final layout / data binding
    return ready;
  }

  // BC renders page content inside an iframe — search every frame for a control
  // matching the caption (aria-label first, then exact text) and box it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async drawHighlight(p: any, caption: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const locator = (cap: string): boolean => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const els = Array.from(doc.querySelectorAll('*')) as any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let target: any = null;
      for (const el of els) {
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim() === cap) { target = el; break; }
      }
      if (!target) {
        for (const el of els) {
          if (el.childElementCount === 0 && el.textContent?.trim() === cap) { target = el.closest('[class]') || el; break; }
        }
      }
      if (!target) return false;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const box = doc.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border:3px solid #e11;border-radius:4px;box-shadow:0 0 0 9999px rgba(0,0,0,.08);z-index:2147483647;pointer-events:none;`;
      doc.body.appendChild(box);
      return true;
    };
    for (const f of p.frames()) {
      try {
        if (await f.evaluate(locator, caption)) return true;
      } catch {
        /* cross-origin frame — skip */
      }
    }
    return false;
  }

  // ---------- chrome / output paths ----------
  private resolveChrome(): string {
    const override = process.env.BC_SCREENSHOT_CHROME;
    if (override) {
      if (!existsSync(override)) throw new Error(`BC_SCREENSHOT_CHROME points to a missing file: ${override}`);
      return override;
    }
    const found = CHROME_CANDIDATES.find((c) => existsSync(c));
    if (!found) {
      throw new Error('No Chrome/Edge found for screenshots. Install Chrome or set BC_SCREENSHOT_CHROME to the browser executable path.');
    }
    return found;
  }

  private resolveOut(out: string | undefined, pageId: string): string {
    const dir = isAbsolute(this.screenshotDir) ? this.screenshotDir : resolve(process.cwd(), this.screenshotDir);
    let file: string;
    if (out) {
      file = isAbsolute(out) ? out : resolve(dir, out);
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      file = resolve(dir, `page-${pageId}-${stamp}.png`);
    }
    mkdirSync(resolve(file, '..'), { recursive: true });
    return file;
  }

  // ---------- lazy puppeteer ----------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadPuppeteer(): Promise<any> {
    if (!puppeteerMod) {
      try {
        puppeteerMod = (await import('puppeteer-core')).default;
      } catch {
        throw new Error('puppeteer-core is not installed. Run `npm install puppeteer-core` to enable bc_screenshot.');
      }
    }
    return puppeteerMod;
  }
}
