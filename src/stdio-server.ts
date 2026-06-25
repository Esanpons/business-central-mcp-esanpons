#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { NTLMAuthProvider } from './connection/auth/ntlm-provider.js';
import { ConnectionFactory } from './connection/connection-factory.js';
import { EventDecoder } from './protocol/event-decoder.js';
import { InteractionEncoder } from './protocol/interaction-encoder.js';
import { PageContextRepository } from './protocol/page-context-repo.js';
import { SessionFactory } from './session/session-factory.js';
import { SessionManager } from './session/session-manager.js';
import type { BCSession } from './session/bc-session.js';
import { PageService } from './services/page-service.js';
import { DataService } from './services/data-service.js';
import { ActionService } from './services/action-service.js';
import { FilterService } from './services/filter-service.js';
import { NavigationService } from './services/navigation-service.js';
import { SearchService } from './services/search-service.js';
import { ScreenshotService } from './services/screenshot-service.js';
import { ReportDownloadService } from './services/report-download-service.js';
import { ManualService } from './services/manual-service.js';
import { ObjectIndexService } from './services/object-index-service.js';
import { OpenPageOperation } from './operations/open-page.js';
import { ReadDataOperation } from './operations/read-data.js';
import { WriteDataOperation } from './operations/write-data.js';
import { ExecuteActionOperation } from './operations/execute-action.js';
import { ClosePageOperation } from './operations/close-page.js';
import { SearchPagesOperation } from './operations/search-pages.js';
import { NavigateOperation } from './operations/navigate.js';
import { RespondDialogOperation } from './operations/respond-dialog.js';
import { SwitchCompanyOperation } from './operations/switch-company.js';
import { ListCompaniesOperation } from './operations/list-companies.js';
import { RunReportOperation } from './operations/run-report.js';
import { DownloadReportOperation } from './operations/download-report.js';
import { WizardNavigateOperation } from './operations/wizard-navigate.js';
import { ScreenshotOperation } from './operations/screenshot.js';
import { BuildManualOperation } from './operations/build-manual.js';
import { FindObjectOperation } from './operations/find-object.js';
import { RefreshObjectsOperation } from './operations/refresh-objects.js';
import { buildToolRegistry, buildHealthTool, type Operations } from './mcp/tool-registry.js';
import { MCPHandler } from './mcp/handler.js';
import { Metrics } from './services/metrics.js';
// isErr no longer needed — SessionManager handles session creation errors internally

async function main() {
  const config = loadConfig();
  // Logger already writes to stderr (via writeStderr in logger.ts) — stdout is sacred (JSON-RPC only)
  const logger = createLogger(config.logging);

  logger.info('BC MCP Server v2 (stdio) starting...');

  // Infrastructure
  const authProvider = new NTLMAuthProvider({
    baseUrl: config.bc.baseUrl,
    username: config.bc.username,
    password: config.bc.password,
    tenantId: config.bc.tenantId,
  }, logger);
  const connectionFactory = new ConnectionFactory(authProvider, config.bc, logger);

  // Protocol
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(config.bc.clientVersionString, config.bc.applicationId);
  const pageContextRepo = new PageContextRepository();

  // Session — created lazily on first tools/call, with automatic recovery
  const sessionFactory = new SessionFactory(
    connectionFactory, decoder, encoder, logger, config.bc.tenantId, config.bc.invokeTimeoutMs, config.bc.profile,
  );
  const metrics = new Metrics();
  const sessionManager = new SessionManager(sessionFactory, pageContextRepo, logger, {
    maxRetries: config.bc.reconnectMaxRetries,
    baseDelayMs: config.bc.reconnectBaseDelayMs,
  }, metrics, authProvider);

  let realTools: ReturnType<typeof buildToolRegistry> | null = null;

  // Services — built once after session is available
  function buildServices(s: BCSession): ReturnType<typeof buildToolRegistry> {
    const pageService = new PageService(s, pageContextRepo, logger);
    const dataService = new DataService(s, pageContextRepo, logger);
    const actionService = new ActionService(s, pageContextRepo, logger);
    const filterService = new FilterService(s, pageContextRepo, logger);
    const navigationService = new NavigationService(s, pageContextRepo, logger);
    const searchService = new SearchService(s, logger);
    const screenshotService = new ScreenshotService(config.bc, config.screenshotDir, () => s.companyName, logger);
    const reportDownloadService = new ReportDownloadService(config.bc, config.reportDir, () => s.companyName, logger);
    const objectIndexService = new ObjectIndexService(pageService, config.stateDir, config.bc.baseUrl, config.bc.tenantId, logger);

    const operations: Operations = {
      openPage: new OpenPageOperation(pageService),
      readData: new ReadDataOperation(dataService, filterService, pageContextRepo),
      writeData: new WriteDataOperation(dataService, pageContextRepo),
      executeAction: new ExecuteActionOperation(actionService, pageContextRepo),
      closePage: new ClosePageOperation(pageService),
      searchPages: new SearchPagesOperation(searchService),
      navigate: new NavigateOperation(navigationService),
      respondDialog: new RespondDialogOperation(s, pageContextRepo),
      switchCompany: new SwitchCompanyOperation(s, pageContextRepo, logger),
      listCompanies: new ListCompaniesOperation(pageService, dataService, () => s.companyName, logger),
      runReport: new RunReportOperation(s),
      downloadReport: new DownloadReportOperation(reportDownloadService),
      wizardNavigate: new WizardNavigateOperation(actionService, pageContextRepo),
      screenshot: new ScreenshotOperation(screenshotService),
      buildManual: new BuildManualOperation(new ManualService(screenshotService, config.manualDir, logger)),
      findObject: new FindObjectOperation(objectIndexService),
      refreshObjects: new RefreshObjectsOperation(objectIndexService),
    };

    return buildToolRegistry(operations);
  }

  // Build MCPHandler eagerly with lazy-executing tool wrappers.
  // Tool definitions (name, description, inputSchema, zodSchema) are static and
  // available immediately so initialize/tools/list work before any BC connection.
  // The execute functions call ensureSession() on first invocation.
  // SessionManager throws SessionLostError on recovery — MCPHandler catches it.

  async function ensureSession(): Promise<ReturnType<typeof buildToolRegistry>> {
    const s = await sessionManager.getSession();
    // Rebuild services if session was recreated
    if (realTools === null || sessionManager.needsServiceRebuild) {
      realTools = buildServices(s);
      sessionManager.markServicesRebuilt();
    }
    return realTools;
  }

  // Produce a static set of tool definitions whose execute functions delegate
  // lazily to the real operations (created on first tools/call).
  const staticTools = buildServices({} as BCSession);  // Only used to extract metadata
  const lazyTools = staticTools.map(toolDef => ({
    ...toolDef,
    execute: async (input: unknown) => {
      const tools = await ensureSession();
      const resolved = tools.find(t => t.name === toolDef.name);
      if (!resolved) throw new Error(`Tool not found after session init: ${toolDef.name}`);
      return resolved.execute(input);
    },
  }));

  // bc_health bypasses the ensureSession gate — it reports status even when BC is down.
  const healthTool = buildHealthTool({ currentSession: () => sessionManager.currentSession, metrics, bc: config.bc });
  const mcpHandler = new MCPHandler([...lazyTools, healthTool], logger, metrics);

  // Read JSON-RPC from stdin, write responses to stdout
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line: string) => {
    if (!line.trim()) return;

    let id: unknown = undefined;
    try {
      const request = JSON.parse(line) as { jsonrpc: string; id: unknown; method: string; params?: unknown };
      id = request.id;

      const response = await mcpHandler.handleRequest(request);

      // Notifications (no id) don't get responses
      if (request.id !== undefined && request.id !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (e) {
      if (id !== undefined && id !== null) {
        const errorResponse = {
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: e instanceof Error ? e.message : 'Internal error' },
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    }
  });

  rl.on('close', () => {
    logger.info('stdin closed, shutting down');
    sessionManager.close();
    process.exit(0);
  });

  function shutdown(): void {
    logger.info('Shutting down...');
    sessionManager.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`[FATAL] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
