// Live test: refresh the object index for the custom range, then resolve by name.
// Run: tsx scripts/test-object-index.ts
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { ObjectIndexService } from '../src/services/object-index-service.js';
import { unwrap } from '../src/core/result.js';

const ac = loadConfig();
const logger = createLogger({ ...ac.logging, level: 'warn' });
const auth = new NTLMAuthProvider({ baseUrl: ac.bc.baseUrl, username: ac.bc.username, password: ac.bc.password, tenantId: ac.bc.tenantId }, logger);
const cf = new ConnectionFactory(auth, ac.bc, logger);
const sf = new SessionFactory(cf, new EventDecoder(), new InteractionEncoder(ac.bc.clientVersionString, ac.bc.applicationId), logger, ac.bc.tenantId, ac.bc.invokeTimeoutMs, ac.bc.profile);
const session = unwrap(await sf.create());
const svc = new ObjectIndexService(new PageService(session, new PageContextRepository(), logger), ac.stateDir, ac.bc.baseUrl, ac.bc.tenantId, logger);

console.log('--- refresh custom range (>=50000) ---');
const ref = await svc.refresh({ from: 50000, to: 99999 });
console.log(JSON.stringify(ref, null, 2));

console.log('\n--- find custom PAGES (type=Page) ---');
const pages = svc.find('jbc', { type: 'Page', limit: 10 });
console.log('count:', pages.count, 'updatedAt:', pages.indexUpdatedAt);
for (const o of pages.results) console.log(`  ${o.type} ${o.id}  ${o.name}  | ${o.caption}  [${o.app}]`);

console.log('\n--- find by keyword "valid" (any type) ---');
const v = svc.find('valid', { limit: 8 });
for (const o of v.results) console.log(`  ${o.type} ${o.id}  ${o.name}  | ${o.caption}`);

await session.closeGracefully().catch(() => {});
process.exit(0);
