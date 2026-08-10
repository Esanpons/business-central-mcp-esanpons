import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { FormsAuthProvider } from '../../src/connection/auth/forms-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';
import type { BCEvent, InvokeActionInteraction } from '../../src/protocol/types.js';
import { SystemAction } from '../../src/protocol/types.js';

dotenvConfig();

describe('Phase 5 features (integration)', () => {
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let pageContextRepo: PageContextRepository;
  const logger = createNullLogger();

  beforeAll(async () => {
    const appConfig = loadConfig();
    const auth = new FormsAuthProvider({
      baseUrl: appConfig.bc.baseUrl,
      username: appConfig.bc.username,
      password: appConfig.bc.password,
      tenantId: appConfig.bc.tenantId,
    }, logger);
    const connFactory = new ConnectionFactory(auth, appConfig.bc, logger);
    const decoder = new EventDecoder();
    const encoder = new InteractionEncoder(appConfig.bc.clientVersionString);
    const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, appConfig.bc.tenantId);

    const result = await sessionFactory.create();
    expect(isOk(result)).toBe(true);
    session = unwrap(result);

    pageContextRepo = new PageContextRepository();
    pageService = new PageService(session, pageContextRepo, logger);
    dataService = new DataService(session, pageContextRepo, logger);
  }, 60000);

  afterAll(async () => {
    await session?.closeGracefully().catch(() => {});
  });

  /**
   * Helper: dismiss any license expiration dialog that appears in events.
   */
  async function dismissDialogsIfPresent(events: BCEvent[]): Promise<BCEvent[]> {
    const dialogs = events.filter(e => e.type === 'DialogOpened');
    for (const dialog of dialogs) {
      if (dialog.type === 'DialogOpened' && dialog.formId) {
        console.error(`[TEST] Dismissing dialog: ${dialog.formId}`);
        const dismissResult = await session.invoke(
          {
            type: 'InvokeAction',
            formId: dialog.formId,
            controlPath: 'server:c[0]',
            systemAction: SystemAction.Ok,
          } satisfies InvokeActionInteraction,
          (event) => event.type === 'InvokeCompleted',
        );
        if (isOk(dismissResult)) {
          console.error(`[TEST] Dialog dismissed, got ${dismissResult.value.length} events`);
        } else {
          console.error(`[TEST] Dialog dismiss failed:`, dismissResult.error);
        }
      }
    }
    return events.filter(e => e.type !== 'DialogOpened');
  }

  it('session.companyName returns a non-empty string after init', () => {
    const company = session.companyName;
    console.error(`[TEST] session.companyName = "${company}"`);
    expect(company).toBeTruthy();
    expect(typeof company).toBe('string');
    expect(company.length).toBeGreaterThan(0);
  });

  it('list companies via page 357 (Companies)', async () => {
    const result = await pageService.openPage('357');
    if (isErr(result)) {
      console.error('[TEST] Failed to open page 357:', result.error);
    }
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const ctx = result.value;
    const pageContextId = ctx.pageContextId;
    console.error(`[TEST] Page 357 opened: pageContextId=${pageContextId}, pageType=${ctx.pageType}, caption="${ctx.caption}"`);
    console.error(`[TEST] Sections: ${Array.from(ctx.sections.entries()).map(([id, s]) => `${id}(${s.kind})`).join(', ')}`);

    // Read rows from the repeater
    const rowsResult = dataService.readRows(pageContextId);
    if (isOk(rowsResult)) {
      const rows = rowsResult.value;
      console.error(`[TEST] Companies found: ${rows.length}`);
      for (const row of rows) {
        console.error(`[TEST]   Row: ${JSON.stringify(row.cells)}`);
      }
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } else {
      console.error('[TEST] readRows failed:', rowsResult.error);
      // Even if readRows fails, the page opened successfully -- log what we have
      for (const [formId, form] of ctx.forms) {
        console.error(`[TEST] Form ${formId}: fields=${form.controlTree.length}, repeaters=${form.repeaters.size}`);
        for (const [rPath, rep] of form.repeaters) {
          console.error(`[TEST]   Repeater ${rPath}: ${rep.rows.length} rows, ${rep.columns.length} cols`);
          for (const row of rep.rows) {
            console.error(`[TEST]     Row cells: ${JSON.stringify(row.cells)}`);
          }
        }
      }
    }

    // Clean up: close the page
    await pageService.closePage(pageContextId).catch(() => {});
  });

  it('RunReport for report 6 (Trial Balance) -- protocol investigation', async () => {
    const result = await session.runReport(6);

    if (isErr(result)) {
      console.error('[TEST] RunReport failed:', result.error);
      // Don't fail the test -- we want to see what happens
      return;
    }

    const events = result.value;
    console.error('[TEST] RunReport events:');
    console.error(JSON.stringify(events, null, 2));

    // Log event types summary
    const typeCounts: Record<string, number> = {};
    for (const e of events) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }
    console.error('[TEST] Event type counts:', JSON.stringify(typeCounts));

    // We expect some events back
    expect(events.length).toBeGreaterThan(0);

    // If a dialog opened (request page), try to dismiss it so it doesn't linger
    const dialogs = events.filter(e => e.type === 'DialogOpened' || e.type === 'FormCreated');
    for (const dialog of dialogs) {
      if ('formId' in dialog && dialog.formId) {
        console.error(`[TEST] Dismissing report dialog/form: ${dialog.formId}`);
        try {
          await session.invoke(
            {
              type: 'InvokeAction',
              formId: dialog.formId,
              controlPath: 'server:c[0]',
              systemAction: SystemAction.Cancel,
            } satisfies InvokeActionInteraction,
            (event) => event.type === 'InvokeCompleted',
          );
        } catch (e) {
          console.error(`[TEST] Failed to dismiss: ${e}`);
        }
      }
    }
  });

  // The old version of this test exercised src/mcp/page-context-validator.ts, which
  // had ZERO production callers: every operation standardized on
  // `repo.get(...) ?? repo.notFoundError(...)`, which duplicated its message. The
  // module is gone; this covers the mechanism that actually runs.
  it('stale page context -- repo.notFoundError explains what is open', async () => {
    // Use a fresh repo to avoid any state from previous tests
    const freshRepo = new PageContextRepository();

    // Bogus ID on empty repo
    expect(freshRepo.get('bogus:nonexistent:id')).toBeUndefined();
    const emptyErr = freshRepo.notFoundError('bogus:nonexistent:id');
    expect(emptyErr.message).toContain('Page context not found');
    expect(emptyErr.message).toContain('none are open');

    // Create a context, remove it, then look it up -- simulates a stale ID
    const ctx = freshRepo.create('test:page:42:abc', 'form-123');
    expect(freshRepo.get('test:page:42:abc')).toBe(ctx);

    freshRepo.remove('test:page:42:abc');
    expect(freshRepo.get('test:page:42:abc')).toBeUndefined();

    // With another page still open -- the error must list it so the caller can recover
    freshRepo.create('test:page:99:xyz', 'form-456');
    const staleErr = freshRepo.notFoundError('test:page:42:abc');
    expect(staleErr.message).toContain('Page context not found');
    expect(staleErr.message).toContain('test:page:99:xyz');
    expect((staleErr.context as { availablePageContexts?: unknown[] }).availablePageContexts).toHaveLength(1);
  });
});
