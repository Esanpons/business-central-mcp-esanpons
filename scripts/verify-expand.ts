/**
 * Verify the screenshot "reveal" feature (expand collapsed FastTabs + click "Show more")
 * against the live devel1 BC27 container, using the REAL ScreenshotService code path.
 *
 * Loads credentials from .secrets/devel1.env (gitignored), then runs two captures of
 * Sales Order 101005:
 *   A) highlight an Additional field that is hidden behind "Show more" inside the
 *      collapsed "Invoice Details" FastTab, WITHOUT expand -> exercises reveal-when-needed.
 *   B) expand:true, cropped to "Invoice Details" -> exercises the explicit full reveal.
 *
 * Pass = both captures write a PNG and report the highlighted target as found:true.
 *
 * Usage:  npx tsx scripts/verify-expand.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { ScreenshotService } from '../src/services/screenshot-service.js';
import type { Logger } from '../src/core/logger.js';

// ---- load .secrets/devel1.env into process.env ----
const envText = readFileSync(resolve('.secrets/devel1.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const logger: Logger = {
  info: (m: string) => console.log('[info]', m),
  warn: (m: string) => console.log('[warn]', m),
  error: (m: string) => console.log('[error]', m),
  debug: (a: string, b?: string) => console.log('[debug]', a, b ?? ''),
};

const PAGE = '42';
const BOOKMARK = '1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMAA1'; // Sales Order 101005
const COMPANY = 'CRONUS_01';
const HIDDEN_FIELD = 'VAT Registration No.'; // Additional field behind "Show more" in Invoice Details

async function main() {
  const cfg = loadConfig();
  const svc = new ScreenshotService(cfg.bc, resolve('.poc/verify'), () => COMPANY, logger);

  console.log('\n=== A) reveal-when-needed (no expand, highlight a hidden field) ===');
  const a = await svc.capture({
    pageId: PAGE, bookmark: BOOKMARK, company: COMPANY,
    annotations: [{ target: HIDDEN_FIELD, style: 'box' }],
    out: 'A-reveal-when-needed.png', inline: false,
  });
  console.log('A result:', JSON.stringify({ path: a.path, authenticated: a.authenticated, spaReady: a.spaReady, annotations: a.annotations }, null, 2));

  console.log('\n=== B) explicit expand:true, cropped to Invoice Details ===');
  const b = await svc.capture({
    pageId: PAGE, bookmark: BOOKMARK, company: COMPANY,
    expand: true,
    annotations: [{ target: HIDDEN_FIELD, style: 'box' }],
    crop: ['Invoice Details'],
    out: 'B-expand-cropped.png', inline: false,
  });
  console.log('B result:', JSON.stringify({ path: b.path, authenticated: b.authenticated, cropped: b.cropped, annotations: b.annotations }, null, 2));

  console.log('\n=== C) explicit expand:true, fullPage (visual proof) ===');
  const c = await svc.capture({
    pageId: PAGE, bookmark: BOOKMARK, company: COMPANY,
    expand: true, fullPage: true,
    annotations: [{ target: HIDDEN_FIELD, style: 'box' }],
    out: 'C-expand-fullpage.png', inline: false,
  });
  console.log('C result:', JSON.stringify({ path: c.path, annotations: c.annotations }, null, 2));

  const aFound = a.annotations?.every((x) => x.found) ?? false;
  const bFound = b.annotations?.every((x) => x.found) ?? false;
  console.log(`\n=== VERDICT ===\nA reveal-when-needed found "${HIDDEN_FIELD}": ${aFound}\nB expand found "${HIDDEN_FIELD}": ${bFound} (cropped=${b.cropped})`);
  if (!aFound || !bFound) process.exit(2);
  console.log('PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
