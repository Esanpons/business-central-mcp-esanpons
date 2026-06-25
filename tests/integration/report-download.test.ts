// Integration test for bc_download_report against a live BC server (e.g. devel1).
// Skips automatically when BC env vars are missing or no Chrome/Edge is installed,
// so it is safe to run without an environment.
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
import { ReportDownloadService } from '../../src/services/report-download-service.js';
import { DownloadReportOperation } from '../../src/operations/download-report.js';
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

describe.skipIf(!RUN)('bc_download_report live', () => {
  let session: BCSession;
  let downloadReport: DownloadReportOperation;

  beforeAll(async () => {
    const logger = createNullLogger();
    const ac = loadConfig();
    session = await buildSession();
    downloadReport = new DownloadReportOperation(
      new ReportDownloadService(ac.bc, ac.reportDir, () => session.companyName, logger),
    );
  }, 60_000);

  afterAll(async () => {
    await session?.closeGracefully().catch(() => { /* best effort */ });
  });

  // Trial Balance (report 6) is a stock report. Depending on the env it either
  // downloads directly or shows a request page; either is an acceptable outcome.
  it('either downloads a non-trivial file or reports requestPageShown', async () => {
    const r = await downloadReport.execute({ reportId: 6, timeoutMs: 90_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.authenticated).toBe(true);
    if (r.value.downloaded) {
      expect(r.value.path).toBeTruthy();
      expect(statSync(r.value.path!).size).toBeGreaterThan(1000);
    } else {
      expect(r.value.requestPageShown).toBe(true);
    }
  }, 120_000);
});
