import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
import { HealthOperation } from './operations/health.js';
import { createApiRoutes, API_ROUTE_KEYS, validateRouteBody } from './api/routes.js';
import { parseJsonBody, checkApiToken } from './api/middleware.js';
// isErr no longer needed — SessionManager handles session creation errors internally

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logging);

  logger.info('Starting BC MCP Server v2...');

  // Infrastructure
  const authProvider = createAuthProvider(config.bc, logger);
  const connectionFactory = new ConnectionFactory(authProvider, config.bc, logger);

  // Protocol
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(config.bc.clientVersionString, config.bc.applicationId);
  const pageContextRepo = new PageContextRepository();

  // Session — created lazily on first request, with automatic recovery
  const sessionFactory = new SessionFactory(
    connectionFactory, decoder, encoder, logger, config.bc.tenantId, config.bc.invokeTimeoutMs, config.bc.profile,
  );
  const metrics = new Metrics();
  const sessionManager = new SessionManager(sessionFactory, pageContextRepo, logger, {
    maxRetries: config.bc.reconnectMaxRetries,
    baseDelayMs: config.bc.reconnectBaseDelayMs,
  }, metrics, authProvider);

  // bc_health bypasses the ensureSession gate — it reports status even when BC is down.
  const healthDeps = { currentSession: () => sessionManager.currentSession, metrics, bc: config.bc };
  const healthTool = buildHealthTool(healthDeps);
  const healthOp = new HealthOperation(healthDeps);

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
  let apiRoutes: ReturnType<typeof createApiRoutes> | null = null;
  /**
   * In-flight guard. Two concurrent first requests both used to see `null` here, both
   * built the entire service graph, and each overwrote the other's handler/route map.
   * Same pattern SessionManager uses for its own lazy session creation.
   */
  let readyPromise: Promise<Operations> | null = null;

  async function buildReady(): Promise<Operations> {
    // ALWAYS go through the session manager: this is where a dead session is
    // detected and recovered, so it must run on every request, not only the first.
    const s = await sessionManager.getSession();
    // Rebuild services if the session was recreated, or on the first call.
    if (operations === null || sessionManager.needsServiceRebuild) {
      operations = buildOperations(s, operationsDeps);
      apiRoutes = createApiRoutes(operations, logger);
      sessionManager.markServicesRebuilt();
    }
    return operations;
  }

  function ensureReady(): Promise<Operations> {
    // Requests that arrive while a build/recovery is in flight join it instead of
    // starting a second one. (The derived promise is what callers get, so a
    // rejection is always handled.)
    if (readyPromise) return readyPromise;
    readyPromise = buildReady().finally(() => { readyPromise = null; });
    return readyPromise;
  }

  // The tool surface is static (name/description/inputSchema/zodSchema need no
  // services), so initialize and tools/list answer with BC still cold; only the
  // first tools/call pays for the session.
  // Registered OUTSIDE the ensureSession() gate, like bc_health: a reset must work
  // precisely when the session is wedged, and the gate would throw before reaching it.
  const resetTool = buildResetSessionTool(() => sessionManager.resetSession(), logger);
  const mcpHandler = new MCPHandler([...buildLazyToolRegistry(ensureReady), healthTool, resetTool], logger, metrics);

  // HTTP Server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!checkApiToken(req, config.server.apiToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    try {
      // Health check (no session needed). Match by pathname so /health?foo also
      // hits the real health op instead of falling through to a static route.
      if (pathname === '/health' && method === 'GET') {
        const h = await healthOp.execute();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(h.ok ? h.value : { status: 'disconnected' }));
        return;
      }

      // MCP endpoint
      if (pathname === '/mcp' && method === 'POST') {
        let body: JsonRpcRequest;
        try {
          body = await parseJsonBody(req) as JsonRpcRequest;
        } catch (e) {
          // A malformed body is a JSON-RPC Parse error (-32700) with a null id, not a
          // 500 with a bare {"error":...} that no MCP client can interpret.
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(MCPHandler.parseErrorResponse(e instanceof Error ? e.message : undefined)));
          return;
        }
        const response = await mcpHandler.handleRequest(body);
        if (response === null) {
          // Notification (no id): JSON-RPC forbids a response. Acknowledge at the
          // transport level with an empty 202 instead of writing an id-less frame.
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      // REST API routes. The route KEY set is static, so an unknown URL (port scan,
      // browser probe) gets a real 404 without triggering a BC login + WebSocket
      // connect — and, unlike before, without dereferencing a still-null route map
      // and turning every cold-process request into a 500.
      const routeKey = `${method} ${pathname}`;
      if (API_ROUTE_KEYS.has(routeKey)) {
        let body: unknown = {};
        if (method === 'POST') {
          try {
            body = await parseJsonBody(req);
          } catch (e) {
            // A malformed body is the caller's mistake -> 400, not a 500.
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Invalid JSON body', code: 'INVALID_JSON' }));
            return;
          }
        }
        // Validate BEFORE forcing a session: a bad body should no more trigger a BC
        // login + WebSocket connect than an unknown URL should.
        const validation = validateRouteBody(routeKey, body);
        if (!validation.ok) {
          logger.warn(`400 ${routeKey}: input validation failed`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(validation.errorBody));
          return;
        }
        await ensureReady();
        const handler = apiRoutes?.get(routeKey);
        if (!handler) {
          // Only reachable if a spec key and the built map ever disagree.
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Route not available: services are not ready' }));
          return;
        }
        await handler(req, res, body);
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found: ${method} ${pathname}` }));

    } catch (e) {
      logger.error(`Request error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Internal error' }));
      } else {
        res.end();
      }
    }
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`[FATAL] Port ${config.port} is already in use on ${config.server.bindAddress}. Set PORT to a free port or stop the other process.\n`);
    } else {
      process.stderr.write(`[FATAL] HTTP server error: ${e.message}\n`);
    }
    process.exit(1);
  });

  server.listen(config.port, config.server.bindAddress, () => {
    logger.info(`BC MCP Server v2 listening on ${config.server.bindAddress}:${config.port}`);
    logger.info(`MCP endpoint: POST http://${config.server.bindAddress}:${config.port}/mcp`);
    logger.info(`REST API: POST http://${config.server.bindAddress}:${config.port}/api/v1/...`);
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    sessionManager.close();
    server.close();
    // Drain the buffered log lines before exiting: process.exit() drops whatever is
    // still sitting in the WriteStream buffer — typically the shutdown reason itself.
    await logger.flush?.();
    process.exit(0);
  }

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((e) => {
  process.stderr.write(`[FATAL] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
