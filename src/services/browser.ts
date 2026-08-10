import { existsSync } from 'node:fs';

/**
 * Shared headless-browser launcher (system Chrome/Edge via puppeteer-core, no bundled
 * download). Used by ScreenshotService (capture), the report downloader and the
 * manual layout verifier. Lazy-imports puppeteer-core so it never affects server startup.
 */

/**
 * Browser executables to probe, in preference order. Exported for the unit test:
 * a missing candidate is invisible until a user's machine has no browser where we
 * looked, and the failure ("No Chrome/Edge found") gives no hint that the browser
 * IS installed, just somewhere else.
 */
export function chromeCandidates(): string[] {
  // Per-user Chrome installs (no admin rights) land under %LOCALAPPDATA%.
  const localAppData = process.env.LOCALAPPDATA;
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(localAppData ? [`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
}

/**
 * Whether the out-of-band browser should accept a self-signed BC certificate.
 *
 * `BC_TLS_INSECURE=1` is the scoped switch (it also drives the WebSocket upgrade and
 * the forms /SignIn fetches); `NODE_TLS_REJECT_UNAUTHORIZED=0` is the older global
 * one and still works, so an existing devel1 setup needs no change. Without this the
 * browser leg was the one place that ONLY honored the global variable, so switching
 * to the scoped flag silently broke screenshots and report downloads.
 */
function tlsIsInsecure(): boolean {
  return process.env.BC_TLS_INSECURE === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let puppeteerMod: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPuppeteer(): Promise<any> {
  if (!puppeteerMod) {
    try {
      puppeteerMod = (await import('puppeteer-core')).default;
    } catch {
      throw new Error('puppeteer-core is not installed. Run `npm install puppeteer-core` to enable screenshots / manuals.');
    }
  }
  return puppeteerMod;
}

export function resolveChrome(): string {
  const override = process.env.BC_SCREENSHOT_CHROME;
  if (override) {
    if (!existsSync(override)) throw new Error(`BC_SCREENSHOT_CHROME points to a missing file: ${override}`);
    return override;
  }
  const found = chromeCandidates().find((c) => existsSync(c));
  if (!found) {
    throw new Error('No Chrome/Edge found. Install Chrome or set BC_SCREENSHOT_CHROME to the browser executable path.');
  }
  return found;
}

/** Launch a headless browser. Honors NODE_TLS_REJECT_UNAUTHORIZED=0 for self-signed on-prem BC. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function launchHeadless(): Promise<any> {
  const puppeteer = await loadPuppeteer();
  const ignoreTls = tlsIsInsecure();
  return puppeteer.launch({
    executablePath: resolveChrome(),
    headless: true,
    acceptInsecureCerts: ignoreTls,
    args: ['--disable-gpu', '--no-sandbox', '--hide-scrollbars', ...(ignoreTls ? ['--ignore-certificate-errors'] : [])],
  });
}

/**
 * Launch a browser bound to a PERSISTENT profile directory. AAD/SaaS auth reuses
 * this so an interactive login (+MFA) done once survives headless reconnects: the
 * Entra SSO cookies live in `userDataDir`. `headless:false` is the bootstrap path
 * (`npm run login:aad`); `true` is the normal unattended path once the profile is
 * warm. Returns the puppeteer Browser (call `browser.pages()` for the first tab).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function launchPersistent(userDataDir: string, opts?: { headless?: boolean }): Promise<any> {
  const puppeteer = await loadPuppeteer();
  const ignoreTls = tlsIsInsecure();
  return puppeteer.launch({
    executablePath: resolveChrome(),
    headless: opts?.headless ?? true,
    userDataDir,
    acceptInsecureCerts: ignoreTls,
    args: ['--disable-gpu', '--no-sandbox', '--hide-scrollbars', ...(ignoreTls ? ['--ignore-certificate-errors'] : [])],
  });
}
