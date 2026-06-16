// Full object-index refresh ({ all: true }) — standard + add-ins + custom. Slow (minutes).
// Run: tsx scripts/refresh-all.ts
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
const logger = createLogger({ ...ac.logging, level: 'info' });
const auth = new NTLMAuthProvider({ baseUrl: ac.bc.baseUrl, username: ac.bc.username, password: ac.bc.password, tenantId: ac.bc.tenantId }, logger);
const cf = new ConnectionFactory(auth, ac.bc, logger);
const sf = new SessionFactory(cf, new EventDecoder(), new InteractionEncoder(ac.bc.clientVersionString, ac.bc.applicationId), logger, ac.bc.tenantId, ac.bc.invokeTimeoutMs, ac.bc.profile);
const session = unwrap(await sf.create());
const svc = new ObjectIndexService(new PageService(session, new PageContextRepository(), logger), ac.stateDir, ac.bc.baseUrl, ac.bc.tenantId, logger);

const t0 = Date.now();
console.log('FULL refresh starting (all: true)...');
const r = await svc.refresh({ all: true });
console.log('DONE in', Math.round((Date.now() - t0) / 1000), 's:', JSON.stringify(r));
await session.closeGracefully().catch(() => {});
process.exit(0);
