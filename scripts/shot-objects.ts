// One-off: screenshot the "All Objects with Caption" page (9174) to inspect its columns,
// even when the WebSocket session is down (the screenshot path uses HTTP auth only).
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { ScreenshotService } from '../src/services/screenshot-service.js';

const config = loadConfig();
const logger = createLogger(config.logging);
const ss = new ScreenshotService(config.bc, config.screenshotDir, () => undefined, logger);

const r = await ss.capture({ pageId: '9174', width: 1900, height: 1100, out: 'objects-9174.png', inline: false });
console.log(JSON.stringify({ authenticated: r.authenticated, spaReady: r.spaReady, pageTitle: r.pageTitle, path: r.path }, null, 2));
