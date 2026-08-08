// scripts/read-page-saas.ts <pageId> — live dump of any SaaS list page.
import { config as dotenv } from 'dotenv';
import { existsSync } from 'node:fs';
if (existsSync('.secrets/saas.env')) dotenv({ path: '.secrets/saas.env' });
else dotenv();
process.env.BC_AUTH = 'AAD';

import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { createAuthProvider } from '../src/connection/auth/factory.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { derivePageState } from '../src/protocol/types.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageService } from '../src/services/page-service.js';
import { DataService } from '../src/services/data-service.js';
import { isOk } from '../src/core/result.js';

const pageId = (process.argv[2] || '22').trim();
const cfg = loadConfig();
const logger = createLogger({ ...cfg.logging, level: 'warn' });

const auth = createAuthProvider(cfg.bc, logger);
const connFactory = new ConnectionFactory(auth, cfg.bc, logger);
const sessionFactory = new SessionFactory(connFactory, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString, cfg.bc.applicationId), logger, cfg.bc.tenantId, cfg.bc.invokeTimeoutMs, cfg.bc.profile);

const sres = await sessionFactory.create();
if (!isOk(sres)) { console.error('SESSION FAILED:', sres.error.message); process.exit(1); }
const session = sres.value;
console.log('Company:', session.companyName, '| tenant:', auth.getTenantIdOverride());

const repo = new PageContextRepository();
const pageService = new PageService(session, repo, logger, { tenantId: cfg.bc.tenantId, authMode: cfg.bc.authMode });
const dataService = new DataService(session, repo, logger, false);

try {
  const open = await pageService.openPage(pageId);
  if (!isOk(open)) { console.error(`openPage ${pageId} FAILED:`, open.error.message); process.exit(1); }
  const state = derivePageState(open.value);
  const pcId = state.pageContextId;
  console.log(`\nPage ${pageId}: type=${state.pageType} formId=${state.formId}`);
  const total = dataService.getRepeaterTotalRowCount(pcId);

  const seen = new Map<string, Record<string, unknown>>();
  const collect = (rows: Array<{ bookmark?: string; cells: Record<string, unknown> }>): void => {
    for (const r of rows) {
      const key = r.bookmark ?? JSON.stringify(r.cells);
      if (!seen.has(key)) seen.set(key, r.cells);
    }
  };
  const first = dataService.readRows(pcId);
  if (isOk(first)) collect(first.value);

  let guard = 0;
  while (guard++ < 60) {
    const before = seen.size;
    const scrolled = await dataService.scrollRepeater(pcId, 20);
    if (isOk(scrolled)) collect(scrolled.value);
    if (seen.size === before) break;
    if (total !== null && seen.size >= total) break;
  }

  const rows = [...seen.values()];
  console.log(`Filas: ${rows.length}${total !== null ? ` de ${total}` : ''}\n`);
  if (rows.length === 0) {
    console.log('(sin filas — la tabla está vacía)');
  } else {
    // Column set = union of non-empty keys across rows (skip image/GUID-only cols).
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
      .filter((k) => rows.some((r) => r[k] !== null && r[k] !== '' && k.toLowerCase() !== 'imagen'));
    console.log(JSON.stringify(cols));
    console.log('-'.repeat(80));
    for (const r of rows) {
      const line: Record<string, unknown> = {};
      for (const c of cols) if (r[c] !== null && r[c] !== '') line[c] = r[c];
      console.log(JSON.stringify(line));
    }
  }
} finally {
  await session.closeGracefully().catch(() => undefined);
}
process.exit(0);
