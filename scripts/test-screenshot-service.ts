// Functional test of the PRODUCTION ScreenshotService (not the PoC).
// Run: tsx scripts/test-screenshot-service.ts
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { ScreenshotService } from '../src/services/screenshot-service.js';

const config = loadConfig();
const logger = createLogger(config.logging);
const svc = new ScreenshotService(config.bc, config.screenshotDir, () => 'CRONUS_01', logger);

const r = await svc.capture({
  pageId: '21',
  bookmark: '1B_EgAAAAJ7CDAAMQAxADIAMQAyADEAMg',
  company: 'CRONUS_01',
  highlight: 'Name',
  out: 'tool-test-customer-card.png',
  inline: true,
});

const { base64, ...rest } = r;
console.log(JSON.stringify(rest, null, 2));
console.log('inline base64 length:', base64?.length ?? 0);
