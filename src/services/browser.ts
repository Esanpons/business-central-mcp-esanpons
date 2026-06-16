import { existsSync } from 'node:fs';

/**
 * Shared headless-browser launcher (system Chrome/Edge via puppeteer-core, no bundled
 * download). Used by both ScreenshotService (capture) and the manual PDF renderer.
 * Lazy-imports puppeteer-core so it never affects server startup.
 */

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

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
  const found = CHROME_CANDIDATES.find((c) => existsSync(c));
  if (!found) {
    throw new Error('No Chrome/Edge found. Install Chrome or set BC_SCREENSHOT_CHROME to the browser executable path.');
  }
  return found;
}

/** Launch a headless browser. Honors NODE_TLS_REJECT_UNAUTHORIZED=0 for self-signed on-prem BC. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function launchHeadless(): Promise<any> {
  const puppeteer = await loadPuppeteer();
  const ignoreTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
  return puppeteer.launch({
    executablePath: resolveChrome(),
    headless: true,
    acceptInsecureCerts: ignoreTls,
    args: ['--disable-gpu', '--no-sandbox', '--hide-scrollbars', ...(ignoreTls ? ['--ignore-certificate-errors'] : [])],
  });
}
