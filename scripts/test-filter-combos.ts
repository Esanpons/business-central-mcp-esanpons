// Test which OpenForm-query filter syntaxes work on page 9174: Object Type alone, and
// combined Type + Object ID (to decide how the index refresh must scope its reads).
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { buildAllSections } from '../src/protocol/section-dto.js';
import { isOk, unwrap } from '../src/core/result.js';

const ac = loadConfig();
const logger = createLogger({ ...ac.logging, level: 'warn' });
const auth = new NTLMAuthProvider({ baseUrl: ac.bc.baseUrl, username: ac.bc.username, password: ac.bc.password, tenantId: ac.bc.tenantId }, logger);
const cf = new ConnectionFactory(auth, ac.bc, logger);
const sf = new SessionFactory(cf, new EventDecoder(), new InteractionEncoder(ac.bc.clientVersionString, ac.bc.applicationId), logger, ac.bc.tenantId, ac.bc.invokeTimeoutMs, ac.bc.profile);
const session = unwrap(await sf.create());
const ps = new PageService(session, new PageContextRepository(), logger);

const FILTERS: Record<string, string> = {
  'type-page': `'Object Type' IS 'Page'`,
  'type-and-id': `'Object Type' IS 'Page' AND 'Object ID' IS '50000..99999'`,
  'type-page-id-range': `'Object Type' IS 'Page'&'Object ID' IS '21..50'`,
};

for (const [name, filter] of Object.entries(FILTERS)) {
  const r = await ps.openPage('9174', { filter, tenantId: ac.bc.tenantId });
  if (!isOk(r)) { console.log(`[${name}] OPEN FAILED: ${r.error.message}`); continue; }
  const rows = buildAllSections(r.value).flatMap((s) => s.rows ?? []);
  await ps.closePage(r.value.pageContextId).catch(() => {});
  const types = new Set(rows.map((row: any) => row.cells['Object Type']));
  const ids = rows.map((row: any) => Number(row.cells['Object ID'])).filter((n) => !isNaN(n));
  console.log(`[${name}] rows=${rows.length} types={${[...types].join(',')}} idRange=${ids.length ? Math.min(...ids) + '..' + Math.max(...ids) : '-'}`);
  console.log('   first 3:', rows.slice(0, 3).map((row: any) => `${row.cells['Object Type']}/${row.cells['Object ID']} ${row.cells['Object Name']}`));
}

await session.closeGracefully().catch(() => {});
process.exit(0);
