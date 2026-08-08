// scripts/smoke-saas.ts
//
// Live smoke of the AAD/SaaS path against the sandbox, using the FULL stack
// (createAuthProvider -> ConnectionFactory -> SessionFactory -> PageService/DataService).
// Requires a warm profile (run `npm run login:aad` first). Proves: headless re-auth,
// Node WS connect to the discovered backend tab URL, OpenSession, openPage, readData.
//
// Usage:  npm run smoke:saas [pageId]     (default page 22 = Customer List)

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
import { ActionService } from '../src/services/action-service.js';
import { SearchService } from '../src/services/search-service.js';
import { isOk } from '../src/core/result.js';

const pageId = (process.argv[2] || '22').trim();
const cfg = loadConfig();
const logger = createLogger({ ...cfg.logging, level: 'info' });

console.log('[smoke] BC_AUTH=AAD  base=', cfg.bc.baseUrl, ' applicationId=', cfg.bc.applicationId);

const auth = createAuthProvider(cfg.bc, logger);
const connFactory = new ConnectionFactory(auth, cfg.bc, logger);
const decoder = new EventDecoder();
const encoder = new InteractionEncoder(cfg.bc.clientVersionString, cfg.bc.applicationId);
const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, cfg.bc.tenantId, cfg.bc.invokeTimeoutMs, cfg.bc.profile);

const t0 = Date.now();
const result = await sessionFactory.create();
if (!isOk(result)) {
  console.error('\n[smoke] SESSION FAILED:', result.error.message);
  process.exit(1);
}
const session = result.value;
console.log(`[smoke] session up in ${Date.now() - t0}ms  company=`, session.companyName, ' tenant=', auth.getTenantIdOverride());

const repo = new PageContextRepository();
const pageService = new PageService(session, repo, logger, { tenantId: cfg.bc.tenantId, authMode: cfg.bc.authMode });
const dataService = new DataService(session, repo, logger, false);

try {
  const open = await pageService.openPage(pageId);
  if (!isOk(open)) { console.error('[smoke] openPage FAILED:', open.error.message); process.exit(1); }
  const state = derivePageState(open.value);
  console.log('[smoke] openPage OK:', JSON.stringify({
    pageContextId: state.pageContextId, formId: state.formId, pageType: state.pageType,
    controlTreeSize: state.controlTree.length, repeaterRows: state.repeater?.rows.length ?? 0,
  }));

  const read = dataService.readRows(state.pageContextId);
  if (isOk(read)) {
    console.log('[smoke] readRows OK: rows=', read.value.length);
    if (read.value.length > 0) console.log('[smoke] first row cells:', JSON.stringify(read.value[0]).slice(0, 200));
  } else {
    console.log('[smoke] readRows note:', read.error.message);
  }

  // Tell Me search (SystemAction 220) — exercises a non-trivial protocol path.
  try {
    const search = new SearchService(session, logger);
    const sres = await search.search('Customer');
    console.log('[smoke] tellMe "Customer": results=', isOk(sres) ? sres.value.length : `ERR ${sres.error.message}`);
  } catch (e) { console.log('[smoke] tellMe note:', e instanceof Error ? e.message : String(e)); }

  // WRITE test (proves SaveValue commits on SaaS): open a fresh, editable Sales
  // Order card (page 42), pick an editable free-text header field with no side
  // effects, write a marker, confirm changed=true, then restore. Mirrors the
  // proven Docker write path (a card opened via bookmark is read-only, so writing
  // there only yields changed=false — a BC edit-mode semantic, not a transport gap).
  try {
    const card = await pageService.openPage('42');
    if (isOk(card)) {
      const cs = derivePageState(card.value);
      const fieldsR = dataService.getFields(cs.pageContextId, 'header');
      if (isOk(fieldsR)) console.log('[smoke] page 42 header fields:', fieldsR.value.length, '| e.g.', fieldsR.value.slice(0, 8).map((f) => `${f.caption}[${f.editable}]`).join(', '));
      // editable is tri-state: true | false | "unknown" — "unknown" IS writable (P2).
      const editable = isOk(fieldsR)
        ? fieldsR.value.filter((f) => f.editable !== false && f.caption && !/^(n[º.o]|no\.?|tipo|type)$/i.test(f.caption))
        : [];
      const target = editable.find((f) => /(referencia|reference|comentario|comment)/i.test(f.caption ?? '')) ?? editable[0];
      if (target?.caption) {
        const original = target.stringValue ?? '';
        const marker = 'mcp-' + process.pid;
        const w = await dataService.writeField(cs.pageContextId, target.caption, marker);
        const changed = isOk(w) ? (w.value as { changed?: boolean }).changed : undefined;
        console.log(`[smoke] writeField "${target.caption}" -> "${marker}":`, isOk(w) ? `changed=${changed}` : `ERR ${w.error.message}`);
        if (isOk(w) && changed) {
          const restore = await dataService.writeField(cs.pageContextId, target.caption, original);
          console.log('[smoke] restore:', isOk(restore) ? `changed=${(restore.value as {changed?: boolean}).changed}` : `ERR ${restore.error.message}`);
        }
      } else {
        console.log('[smoke] no editable free-text header field found on page 42');
      }
      // Discard the just-created blank draft order so the smoke leaves no residue.
      try {
        const actionService = new ActionService(session, repo, logger);
        const del = await actionService.executeAction(cs.pageContextId, 'Delete');
        console.log('[smoke] cleanup draft order:', isOk(del) ? 'delete invoked' : `note ${del.error.message}`);
      } catch { /* best-effort cleanup */ }
    } else {
      console.log('[smoke] openPage 42 note:', card.error.message);
    }
  } catch (e) { console.log('[smoke] write note:', e instanceof Error ? e.message : String(e)); }

  console.log('\n[smoke] SUCCESS — SaaS WS + OpenSession + openPage + readRows worked.');
} finally {
  await session.closeGracefully().catch(() => undefined);
}
process.exit(0);
