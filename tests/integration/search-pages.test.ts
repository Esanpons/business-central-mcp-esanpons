// tests/integration/search-pages.test.ts
//
// Plan D Task 7 — live verification of bc_search_pages output structure
// against BC28. Validates the new SearchResult shape (name, objectType,
// runTarget, ...) and the empty-result note remediation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import { BCSession } from '../../src/session/bc-session.js';
import { SearchService } from '../../src/services/search-service.js';
import { SearchPagesOperation } from '../../src/operations/search-pages.js';
import { isOk, unwrap } from '../../src/core/result.js';

dotenvConfig();

async function buildSession(profile: string): Promise<BCSession> {
  const logger = createNullLogger();
  const ac = loadConfig();
  const auth = new NTLMAuthProvider({
    baseUrl: ac.bc.baseUrl,
    username: ac.bc.username,
    password: ac.bc.password,
    tenantId: ac.bc.tenantId,
  }, logger);
  const cf = new ConnectionFactory(auth, ac.bc, logger);
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(ac.bc.clientVersionString);
  const sf = new SessionFactory(cf, decoder, encoder, logger, ac.bc.tenantId, ac.bc.invokeTimeoutMs, profile);
  const result = await sf.create();
  expect(isOk(result)).toBe(true);
  return unwrap(result);
}

describe('bc_search_pages live extraction (BC28)', () => {
  describe('with BUSINESS MANAGER profile (populated index)', () => {
    let session: BCSession;
    let op: SearchPagesOperation;

    beforeAll(async () => {
      session = await buildSession('BUSINESS MANAGER');
      const searchService = new SearchService(session, createNullLogger());
      op = new SearchPagesOperation(searchService);
    }, 60_000);

    afterAll(async () => {
      await session?.closeGracefully().catch(() => { /* best effort */ });
    });

    it('returns structured results for "customer"', async () => {
      const result = await op.execute({ query: 'customer' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results.length).toBeGreaterThan(0);
      expect(result.value.note).toBeUndefined();

      // Every result has name + objectType + runTarget
      for (const r of result.value.results) {
        expect(r.name).toBeTruthy();
        expect(r.objectType).toBeTruthy();
        expect(r.runTarget).toBeTruthy();
      }

      // At least one is objectType "page"
      const pageHit = result.value.results.find(r => r.objectType === 'page');
      expect(pageHit, 'expected at least one page-typed result').toBeDefined();
    }, 30_000);
  });

  describe('with default profile (potentially empty index)', () => {
    let session: BCSession;
    let op: SearchPagesOperation;

    beforeAll(async () => {
      session = await buildSession('');
      const searchService = new SearchService(session, createNullLogger());
      op = new SearchPagesOperation(searchService);
    }, 60_000);

    afterAll(async () => {
      await session?.closeGracefully().catch(() => { /* best effort */ });
    });

    it('returns either populated results OR a profile-hint note when empty', async () => {
      const result = await op.execute({ query: 'customer' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.results.length === 0) {
        // Empty path — note must mention BC_PROFILE
        expect(result.value.note).toBeTruthy();
        expect(result.value.note).toMatch(/BC_PROFILE/i);
      } else {
        // Hit path — note must be absent
        expect(result.value.note).toBeUndefined();
      }
    }, 30_000);
  });
});
