// scripts/capture-tell-me.ts
//
// One-shot capture: open Tell Me on live BC28, save the actual query, dump
// every event from the response to src/protocol/captures/tell-me-result-2026-04-28.json.
// Run with: npx tsx scripts/capture-tell-me.ts

import { config as dotenvConfig } from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { createNullLogger } from '../src/core/logger.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { isOk, unwrap } from '../src/core/result.js';
import type { SessionActionInteraction, SaveValueInteraction, BCEvent } from '../src/protocol/types.js';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runQuery(
  session: import('../src/session/bc-session.js').BCSession,
  query: string,
): Promise<{ events: BCEvent[]; formId: string } | null> {
  console.error(`\n=== Trying query "${query}" ===`);
  console.error('Step 1: opening Tell Me (SystemAction.PageSearch=220)...');
  const open: SessionActionInteraction = {
    type: 'SessionAction',
    actionName: 'InvokeSessionAction',
    namedParameters: { SystemAction: 220 },
  };
  const openResult = await session.invoke(
    open,
    (e) => e.type === 'InvokeCompleted' || e.type === 'FormCreated',
  );
  if (!isOk(openResult)) {
    console.error(`open failed: ${openResult.error.message}`);
    return null;
  }
  const tellMeForm = openResult.value.find((e) => e.type === 'FormCreated');
  if (!tellMeForm || tellMeForm.type !== 'FormCreated') {
    console.error('Tell Me form not opened. Events:', openResult.value.map((e) => e.type).join(','));
    writeFileSync('logs/tell-me-open-failed.json', JSON.stringify(openResult.value, null, 2));
    return null;
  }
  const formId = tellMeForm.formId;
  console.error(`Tell Me form opened: ${formId}`);

  console.error('Step 2: empty SaveValue (initialize)...');
  const initSave: SaveValueInteraction = {
    type: 'SaveValue',
    formId,
    controlPath: 'server:c[0]',
    newValue: '',
  };
  const initResult = await session.invoke(initSave, (e) => e.type === 'InvokeCompleted');
  if (!isOk(initResult)) {
    console.error(`init failed: ${initResult.error.message}`);
    return null;
  }

  console.error(`Step 3: query SaveValue ("${query}")...`);
  const querySave: SaveValueInteraction = {
    type: 'SaveValue',
    formId,
    controlPath: 'server:c[0]',
    newValue: query,
  };
  const queryResult = await session.invoke(
    querySave,
    (e) => e.type === 'DataLoaded' || e.type === 'InvokeCompleted',
  );
  if (!isOk(queryResult)) {
    console.error(`query failed: ${queryResult.error.message}`);
    return null;
  }
  const events: BCEvent[] = queryResult.value;
  console.error(
    `Query returned ${events.length} events: ${events.map((e) => e.type).join(', ')}`,
  );
  return { events, formId };
}

async function main() {
  const logger = createNullLogger();
  const appConfig = loadConfig();
  const auth = new NTLMAuthProvider(
    {
      baseUrl: appConfig.bc.baseUrl,
      username: appConfig.bc.username,
      password: appConfig.bc.password,
      tenantId: appConfig.bc.tenantId,
    },
    logger,
  );
  const connFactory = new ConnectionFactory(auth, appConfig.bc, logger);
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(appConfig.bc.clientVersionString);
  const sessionFactory = new SessionFactory(
    connFactory,
    decoder,
    encoder,
    logger,
    appConfig.bc.tenantId,
  );

  console.error('Connecting to BC...');
  const sessionResult = await sessionFactory.create();
  if (!isOk(sessionResult)) {
    console.error('Failed to create session:', sessionResult.error.message);
    process.exit(1);
  }
  const session = unwrap(sessionResult);
  console.error('Connected.');

  // Try several queries; first one to return DataLoaded with rows wins.
  const candidates = ['customer', 'items', 'sales', 'general'];
  let chosen: { query: string; events: BCEvent[]; formId: string } | null = null;
  let firstAttempt: { query: string; events: BCEvent[]; formId: string } | null = null;

  try {
    for (const q of candidates) {
      const result = await runQuery(session, q);
      if (!result) continue;
      const { events, formId } = result;
      if (!firstAttempt) firstAttempt = { query: q, events, formId };

      const dataLoaded = events.find((e) => e.type === 'DataLoaded');
      if (dataLoaded && dataLoaded.type === 'DataLoaded' && dataLoaded.rows.length > 0) {
        chosen = { query: q, events, formId };
        console.error(`Success: query "${q}" produced ${dataLoaded.rows.length} rows.`);
        break;
      } else {
        console.error(
          `Query "${q}" did not produce a DataLoaded with rows. Trying next candidate.`,
        );
      }
    }

    const final = chosen ?? firstAttempt;
    if (!final) {
      console.error('No query succeeded. Aborting.');
      process.exit(1);
    }

    const outDir = resolve(__dirname, '../src/protocol/captures');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, 'tell-me-result-2026-04-28.json');

    // Wrap with metadata (query, capture date) for fixture self-description.
    const dump = {
      capturedAt: new Date().toISOString(),
      query: final.query,
      formId: final.formId,
      events: final.events,
    };
    writeFileSync(outPath, JSON.stringify(dump, null, 2));
    console.error(`Saved ${outPath}`);

    const dataLoaded = final.events.find((e) => e.type === 'DataLoaded');
    if (dataLoaded && dataLoaded.type === 'DataLoaded') {
      console.error(`First DataLoaded: ${dataLoaded.rows.length} rows`);
      const firstRow = dataLoaded.rows[0];
      if (firstRow) {
        console.error('First row payload:', JSON.stringify(firstRow, null, 2));
      }
    } else {
      console.error('No DataLoaded event in response.');
    }
  } finally {
    await session.closeGracefully().catch(() => {});
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
