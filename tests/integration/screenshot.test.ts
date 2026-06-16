// Integration test for bc_screenshot against a live BC server (e.g. devel1).
// Skips automatically when BC env vars are missing or no Chrome/Edge is installed,
// so it is safe to run in CI/dev without an environment.
//
//   $env:BC_BASE_URL='https://devel1/BC'; $env:BC_USERNAME='Admin'; $env:BC_PASSWORD='...'
//   npm run test:integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { ScreenshotService } from '../../src/services/screenshot-service.js';
import { ScreenshotOperation } from '../../src/operations/screenshot.js';
import { isOk, unwrap } from '../../src/core/result.js';

dotenvConfig();

const CHROME_CANDIDATES = [
  process.env.BC_SCREENSHOT_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const hasChrome = CHROME_CANDIDATES.some((c) => c && existsSync(c));
const hasEnv = !!(process.env.BC_BASE_URL && process.env.BC_USERNAME && process.env.BC_PASSWORD);
const RUN = hasEnv && hasChrome;

async function buildSession(): Promise<BCSession> {
  const logger = createNullLogger();
  const ac = loadConfig();
  const auth = new NTLMAuthProvider(
    { baseUrl: ac.bc.baseUrl, username: ac.bc.username, password: ac.bc.password, tenantId: ac.bc.tenantId },
    logger,
  );
  const cf = new ConnectionFactory(auth, ac.bc, logger);
  const sf = new SessionFactory(cf, new EventDecoder(), new InteractionEncoder(ac.bc.clientVersionString, ac.bc.applicationId), logger, ac.bc.tenantId, ac.bc.invokeTimeoutMs, ac.bc.profile);
  const result = await sf.create();
  expect(isOk(result)).toBe(true);
  return unwrap(result);
}

describe.skipIf(!RUN)('bc_screenshot live', () => {
  let session: BCSession;
  let screenshot: ScreenshotOperation;
  let openPage: OpenPageOperation;

  beforeAll(async () => {
    const logger = createNullLogger();
    const ac = loadConfig();
    session = await buildSession();
    const repo = new PageContextRepository();
    openPage = new OpenPageOperation(new PageService(session, repo, logger));
    screenshot = new ScreenshotOperation(new ScreenshotService(ac.bc, ac.screenshotDir, () => session.companyName, logger));
  }, 60_000);

  afterAll(async () => {
    await session?.closeGracefully().catch(() => { /* best effort */ });
  });

  it('captures a list page (22) as a non-trivial PNG', async () => {
    const r = await screenshot.execute({ pageId: 22, inline: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.authenticated).toBe(true);
    expect(r.value.spaReady).toBe(true);
    expect(r.value.url).toContain('page=22');
    expect(existsSync(r.value.path)).toBe(true);
    expect(statSync(r.value.path).size).toBeGreaterThan(5000); // a real render, not a blank frame
  }, 90_000);

  it('captures a card (21) for a real record with a highlight', async () => {
    // Resolve a real bookmark from the customer list.
    const list = await openPage.execute({ pageId: 22 });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const rows = list.value.sections.flatMap((s) => s.rows ?? []);
    const bookmark = rows[0]?.bookmark;
    expect(bookmark).toBeTruthy();

    const r = await screenshot.execute({ pageId: 21, bookmark, highlight: 'Name', inline: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.authenticated).toBe(true);
    expect(r.value.url).toContain('page=21');
    expect(r.value.annotations?.[0]).toEqual({ target: 'Name', found: true });
  }, 90_000);

  it('crops to a field area', async () => {
    const r = await screenshot.execute({ pageId: 22, crop: 'No.', inline: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cropped).toBe(true);
  }, 90_000);

  // "VAT Registration No." is an Additional-importance field on the Sales Order
  // "Invoice Details" FastTab — hidden behind "Show more", and that tab is collapsed
  // by default. Highlighting it must trigger reveal-when-needed (expand + Show more).
  it('reveals a field hidden behind "Show more" when it is highlighted', async () => {
    const list = await openPage.execute({ pageId: 9305 }); // Sales Orders
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const bookmark = list.value.sections.flatMap((s) => s.rows ?? [])[0]?.bookmark;
    expect(bookmark).toBeTruthy();

    const r = await screenshot.execute({ pageId: 42, bookmark, highlight: 'VAT Registration No.', inline: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.annotations?.[0]).toEqual({ target: 'VAT Registration No.', found: true });
  }, 120_000);

  it('expand:true reveals all FastTabs + "Show more" up front', async () => {
    const list = await openPage.execute({ pageId: 9305 });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const bookmark = list.value.sections.flatMap((s) => s.rows ?? [])[0]?.bookmark;

    const r = await screenshot.execute({ pageId: 42, bookmark, expand: true, highlight: 'VAT Registration No.', inline: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.annotations?.[0]).toEqual({ target: 'VAT Registration No.', found: true });
  }, 120_000);
});
