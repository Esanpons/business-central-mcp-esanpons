// scripts/list-companies-onprem.ts — list companies from the devel1 Docker (on-prem).
import { config as dotenv } from 'dotenv';
import { existsSync } from 'node:fs';
if (existsSync('.secrets/devel1.env')) dotenv({ path: '.secrets/devel1.env' });
else dotenv();

import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { createAuthProvider } from '../src/connection/auth/factory.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageService } from '../src/services/page-service.js';
import { DataService } from '../src/services/data-service.js';
import { ListCompaniesOperation } from '../src/operations/list-companies.js';
import { isOk } from '../src/core/result.js';

const cfg = loadConfig();
const logger = createLogger({ ...cfg.logging, level: 'warn' });
console.log('Auth mode:', cfg.bc.authMode, '| base:', cfg.bc.baseUrl);

const auth = createAuthProvider(cfg.bc, logger);
const connFactory = new ConnectionFactory(auth, cfg.bc, logger);
const sessionFactory = new SessionFactory(connFactory, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString, cfg.bc.applicationId), logger, cfg.bc.tenantId, cfg.bc.invokeTimeoutMs, cfg.bc.profile);

const sres = await sessionFactory.create();
if (!isOk(sres)) { console.error('SESSION FAILED:', sres.error.message); process.exit(1); }
const session = sres.value;

const repo = new PageContextRepository();
const pageService = new PageService(session, repo, logger, { tenantId: cfg.bc.tenantId, authMode: cfg.bc.authMode });
const dataService = new DataService(session, repo, logger, false);
const op = new ListCompaniesOperation(pageService, dataService, () => session.companyName, logger);

try {
  const r = await op.execute();
  if (!isOk(r)) { console.error('list companies FAILED:', r.error.message); process.exit(1); }
  console.log('\nCompañía actual:', r.value.currentCompany);
  console.log(`Compañías en devel1 (${r.value.companies.length}):\n`);
  for (const c of r.value.companies) {
    console.log(' -', c.name + (c.displayName && c.displayName !== c.name ? `  (${c.displayName})` : ''));
  }
} finally {
  await session.closeGracefully().catch(() => undefined);
}
process.exit(0);
