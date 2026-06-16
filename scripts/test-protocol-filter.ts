// Throwaway: does the OpenForm WebSocket query honor a `filter=` (filter-at-open)?
// We abuse the pageId param to inject `&filter=...` into the OpenForm query string,
// then read the returned rows to see if they are filtered to Object ID >= 50000.
// Run: tsx scripts/test-protocol-filter.ts
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { unwrap } from '../src/core/result.js';

const ac = loadConfig();
const logger = createLogger({ ...ac.logging, level: 'warn' });
const auth = new NTLMAuthProvider({ baseUrl: ac.bc.baseUrl, username: ac.bc.username, password: ac.bc.password, tenantId: ac.bc.tenantId }, logger);
const cf = new ConnectionFactory(auth, ac.bc, logger);
const sf = new SessionFactory(cf, new EventDecoder(), new InteractionEncoder(ac.bc.clientVersionString, ac.bc.applicationId), logger, ac.bc.tenantId, ac.bc.invokeTimeoutMs, ac.bc.profile);
const session = unwrap(await sf.create());
const op = new OpenPageOperation(new PageService(session, new PageContextRepository(), logger));

// Inject the filter into the OpenForm query via the pageId param (test-only hack).
const filterEnc = `%27Object%20ID%27%20IS%20%2750000..99999%27`; // 'Object ID' IS '50000..99999'
const pageId = `9174&filter=${filterEnc}`;

const r = await op.execute({ pageId });
if (!r.ok) {
  console.log('OPEN FAILED:', r.error.message);
} else {
  const rows = r.value.sections.flatMap((s) => s.rows ?? []);
  const ids = rows.map((row: any) => Number(row.cells?.['Object ID'])).filter((n) => !isNaN(n));
  console.log('rows returned:', rows.length);
  console.log('Object ID range:', ids.length ? `${Math.min(...ids)} .. ${Math.max(...ids)}` : 'none');
  console.log('all >= 50000?', ids.length > 0 && ids.every((n) => n >= 50000));
  console.log('first 5:', rows.slice(0, 5).map((row: any) => `${row.cells?.['Object ID']} ${row.cells?.['Object Type']} ${row.cells?.['Object Name']}`));
}
await session.closeGracefully().catch(() => {});
process.exit(0);
