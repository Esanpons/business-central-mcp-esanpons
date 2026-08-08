// scripts/list-customers-saas.ts — live read of the SaaS sandbox customer list.
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
  const open = await pageService.openPage('22');
  if (!isOk(open)) { console.error('openPage 22 FAILED:', open.error.message); process.exit(1); }
  const state = derivePageState(open.value);
  const pcId = state.pageContextId;
  const total = dataService.getRepeaterTotalRowCount(pcId);

  // Collect rows, scrolling until no new bookmarks appear or we reach the total.
  const seen = new Map<string, { no: string; name: string; balance: string }>();
  const collect = (rows: Array<{ bookmark?: string; cells: Record<string, unknown> }>): void => {
    for (const r of rows) {
      const key = r.bookmark ?? JSON.stringify(r.cells);
      const c = r.cells as Record<string, unknown>;
      const no = String(c['Nº'] ?? c['No.'] ?? '');
      const name = String(c['Nombre'] ?? c['Name'] ?? '');
      const balance = String(c['Saldo (DL)'] ?? c['Balance (LCY)'] ?? c['Saldo'] ?? '');
      if (!seen.has(key)) seen.set(key, { no, name, balance });
    }
  };
  const first = dataService.readRows(pcId);
  if (isOk(first)) collect(first.value);

  let guard = 0;
  while (guard++ < 40) {
    const before = seen.size;
    const scrolled = await dataService.scrollRepeater(pcId, 10);
    if (isOk(scrolled)) collect(scrolled.value);
    if (seen.size === before) break;               // no new rows
    if (total !== null && seen.size >= total) break; // reached the known total
  }

  const list = [...seen.values()].sort((a, b) => a.no.localeCompare(b.no, undefined, { numeric: true }));
  console.log(`\nClientes en DEV (${list.length}${total !== null ? ` de ${total}` : ''}):\n`);
  console.log('Nº'.padEnd(10), 'Nombre'.padEnd(42), 'Saldo');
  console.log('-'.repeat(70));
  for (const c of list) console.log(c.no.padEnd(10), c.name.padEnd(42), c.balance);
} finally {
  await session.closeGracefully().catch(() => undefined);
}
process.exit(0);
