#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createAuthProvider } from './connection/auth/factory.js';
import { ConnectionFactory } from './connection/connection-factory.js';
import { EventDecoder } from './protocol/event-decoder.js';
import { InteractionEncoder } from './protocol/interaction-encoder.js';
import { PageContextRepository } from './protocol/page-context-repo.js';
import { SessionFactory } from './session/session-factory.js';
import { SessionManager } from './session/session-manager.js';
import { buildHealthTool, buildResetSessionTool, buildLazyToolRegistry, type Operations } from './mcp/tool-registry.js';
import { buildOperations } from './mcp/build-operations.js';
import { MCPHandler, type JsonRpcRequest } from './mcp/handler.js';
import { Metrics } from './services/metrics.js';
// isErr no longer needed — SessionManager handles session creation errors internally

async function main() {
  const config = loadConfig();
  // Logger already writes to stderr (via writeStderr in logger.ts) — stdout is sacred (JSON-RPC only)
  const logger = createLogger(config.logging);

  logger.info('BC MCP Server v2 (stdio) starting...');

  // Infrastructure
  const authProvider = createAuthProvider(config.bc, logger);
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

  const operationsDeps = {
    config,
    logger,
    authProvider,
    pageContextRepo,
    onCompanySelected: (c: string) => sessionManager.rememberCompany(c),
    switchSessionCompany: (c: string) => sessionManager.switchCompany(c),
    metrics,
  };

  let operations: Operations | null = null;
  /** In-flight guard so two concurrent first calls build the service graph once. */
  let readyPromise: Promise<Operations> | null = null;

  async function buildReady(): Promise<Operations> {
    // ALWAYS go through the session manager: dead-session detection and recovery
    // live there, so this must run on every call, not only the first.
    const s = await sessionManager.getSession();
    if (operations === null || sessionManager.needsServiceRebuild) {
      operations = buildOperations(s, operationsDeps);
      sessionManager.markServicesRebuilt();
    }
    return operations;
  }

  function ensureSession(): Promise<Operations> {
    // Calls that arrive while a build/recovery is in flight join it instead of
    // starting a second one. (The derived promise is what callers get, so a
    // rejection is always handled.)
    if (readyPromise) return readyPromise;
    readyPromise = buildReady().finally(() => { readyPromise = null; });
    return readyPromise;
  }

  // The tool DEFINITIONS (name, description, inputSchema, zodSchema) are static and
  // need no services at all, so initialize / tools/list answer immediately with BC
  // cold; only the execute half awaits ensureSession(). (This used to build the whole
  // service graph on a forged `{} as BCSession` just to read those four fields — it
  // worked solely because no constructor dereferenced the session.)
  // SessionManager throws SessionLostError on recovery — MCPHandler catches it.
  const healthTool = buildHealthTool({ currentSession: () => sessionManager.currentSession, metrics, bc: config.bc });
  // Registered OUTSIDE the ensureSession() gate, like bc_health: a reset must work
  // precisely when the session is wedged, and the gate would throw before reaching it.
  const resetTool = buildResetSessionTool(() => sessionManager.resetSession(), logger);
  const mcpHandler = new MCPHandler([...buildLazyToolRegistry(ensureSession), healthTool, resetTool], logger, metrics);

  // Read JSON-RPC from stdin, write responses to stdout
  const rl = createInterface({ input: process.stdin, terminal: false });

  // NOTE — this handler is deliberately async and NOT serialized: several requests
  // may be in flight at once and their responses may interleave. That is correct and
  // intentional. JSON-RPC explicitly allows out-of-order responses (the client
  // correlates by id), and each `process.stdout.write` of one complete line is
  // atomic, so frames never interleave mid-line. Do NOT "fix" this into an await
  // chain: that would serialize every request behind the slowest BC call (a 30s
  // invoke would block bc_health and every other tool behind it).
  rl.on('line', async (line: string) => {
    if (!line.trim()) return;

    let id: unknown = undefined;
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      id = request.id;

      const response = await mcpHandler.handleRequest(request);

      // Notifications (no id) get no response: handleRequest returns null for them.
      if (response !== null) {
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

  let shuttingDown = false;
  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(reason);
    sessionManager.close();
    // Drain buffered log lines before exiting — process.exit() would drop them.
    await logger.flush?.();
    process.exit(0);
  }

  rl.on('close', () => { void shutdown('stdin closed, shutting down'); });
  process.on('SIGINT', () => { void shutdown('Shutting down...'); });
  process.on('SIGTERM', () => { void shutdown('Shutting down...'); });
}

main().catch((e) => {
  process.stderr.write(`[FATAL] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
