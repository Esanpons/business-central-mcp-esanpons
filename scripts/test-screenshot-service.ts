// Functional test of the PRODUCTION ScreenshotService (not the PoC).
// Run: tsx scripts/test-screenshot-service.ts
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { ScreenshotService } from '../src/services/screenshot-service.js';

const config = loadConfig();
const logger = createLogger(config.logging);
const svc = new ScreenshotService(config.bc, config.screenshotDir, () => 'CRONUS_01', logger);
const BOOKMARK = '1B_EgAAAAJ7CDAAMQAxADIAMQAyADEAMg';

// 1) numbered badges (string[]) + redaction
const a = await svc.capture({
  pageId: '21', bookmark: BOOKMARK, company: 'CRONUS_01',
  annotations: [
    { target: 'No.', label: '1', style: 'badge' },
    { target: 'Name', label: '2', style: 'badge' },
    { target: 'Credit Limit (LCY)', label: '3', style: 'badge' },
  ],
  redact: ['Balance (LCY)'],
  out: 'ws1-badges-redact.png', inline: false,
});
console.log('badges/redact:', JSON.stringify({ authenticated: a.authenticated, spaReady: a.spaReady, pageTitle: a.pageTitle, annotations: a.annotations, cropped: a.cropped, path: a.path }));

// 2) crop to a field area
const b = await svc.capture({
  pageId: '21', bookmark: BOOKMARK, company: 'CRONUS_01',
  annotations: [{ target: 'Credit Limit (LCY)', style: 'arrow', label: 'set this' }],
  crop: ['No.', 'Credit Limit (LCY)'],
  out: 'ws1-crop-arrow.png', inline: false,
});
console.log('crop/arrow:', JSON.stringify({ annotations: b.annotations, cropped: b.cropped, path: b.path }));
