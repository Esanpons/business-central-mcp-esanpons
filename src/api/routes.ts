import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import type { Operations } from '../mcp/tool-registry.js';
import type { Logger } from '../core/logger.js';
import {
  OpenPageSchema,
  ReadDataSchema,
  WriteDataSchema,
  ExecuteActionSchema,
  ClosePageSchema,
  SearchPagesSchema,
  NavigateSchema,
} from '../mcp/schemas.js';

type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;

interface RouteSpec {
  method: 'POST';
  path: string;
  /**
   * The SAME Zod schema the MCP tool uses. The REST path used to cast the raw body
   * straight into the operation: no validation, no coercion, no .refine. A missing
   * key surfaced as a deep TypeError -> generic 500 (POST /api/v1/pages/read with {}
   * answered "Page context not found: undefined"), and `{"pageId":{"$gt":1}}` reached
   * BC as `page=[object Object]`.
   */
  schema: z.ZodType;
  run: (ops: Operations, input: never) => Promise<unknown>;
}

const ROUTE_SPECS: RouteSpec[] = [
  {
    method: 'POST', path: '/api/v1/pages/open', schema: OpenPageSchema,
    run: (ops, input) => ops.openPage.execute(input as Parameters<typeof ops.openPage.execute>[0]),
  },
  {
    method: 'POST', path: '/api/v1/pages/read', schema: ReadDataSchema,
    run: (ops, input) => ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]),
  },
  {
    method: 'POST', path: '/api/v1/pages/write', schema: WriteDataSchema,
    run: (ops, input) => ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]),
  },
  {
    method: 'POST', path: '/api/v1/pages/action', schema: ExecuteActionSchema,
    run: (ops, input) => ops.executeAction.execute(input as Parameters<typeof ops.executeAction.execute>[0]),
  },
  {
    method: 'POST', path: '/api/v1/pages/close', schema: ClosePageSchema,
    run: (ops, input) => ops.closePage.execute(input as Parameters<typeof ops.closePage.execute>[0]),
  },
  {
    method: 'POST', path: '/api/v1/search', schema: SearchPagesSchema,
    run: (ops, input) => ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]),
  },
  {
    method: 'POST', path: '/api/v1/navigate', schema: NavigateSchema,
    run: (ops, input) => ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]),
  },
];

/**
 * The route KEYS, known statically at import time.
 *
 * This exists because the HTTP server must decide "is this a known REST route?"
 * BEFORE it forces a BC session: the route MAP is session-gated (it needs the
 * operations), so looking a route up in it was impossible on a cold process — every
 * non-/mcp request threw on a null map and came back as a 500, including the 404s.
 * The paths are static, so the answer to "is this a route?" never needed the session.
 *
 * NOTE: GET /health is deliberately NOT here. server.ts intercepts /health before
 * any route lookup (it must answer with BC down), so the entry that used to live in
 * this map was unreachable AND returned a drifted, always-`healthy` shape.
 */
export const API_ROUTE_KEYS: ReadonlySet<string> = new Set(ROUTE_SPECS.map(r => `${r.method} ${r.path}`));

/** Route key -> the Zod schema its body must satisfy. Static, like the keys. */
export const API_ROUTE_SCHEMAS: ReadonlyMap<string, z.ZodType> =
  new Map(ROUTE_SPECS.map(r => [`${r.method} ${r.path}`, r.schema]));

export interface RouteValidation {
  ok: boolean;
  /** JSON body to answer with when ok is false. */
  errorBody?: Record<string, unknown>;
}

/**
 * Validate a REST body WITHOUT any operations — so a malformed request is rejected
 * before a BC login is forced, exactly like an unknown URL is. The route handler
 * validates again (it must stay correct when called directly); the check is cheap.
 */
export function validateRouteBody(routeKey: string, body: unknown): RouteValidation {
  const schema = API_ROUTE_SCHEMAS.get(routeKey);
  if (!schema) return { ok: true };
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    errorBody: {
      error: 'Input validation failed',
      code: 'INPUT_VALIDATION',
      issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    },
  };
}

export function createApiRoutes(ops: Operations, logger: Logger): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();

  for (const spec of ROUTE_SPECS) {
    routes.set(`${spec.method} ${spec.path}`, async (_req, res, body) => {
      const parsed = spec.schema.safeParse(body ?? {});
      if (!parsed.success) {
        logger.warn(`400 ${spec.method} ${spec.path}: input validation failed`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Input validation failed',
          code: 'INPUT_VALIDATION',
          issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message, code: i.code })),
        }));
        return;
      }
      const result = await spec.run(ops, parsed.data as never);
      sendResult(res, result);
    });
  }

  return routes;
}

function sendResult(res: ServerResponse, result: unknown): void {
  const r = result as { ok: boolean; value?: unknown; error?: { message?: string; code?: string; context?: Record<string, unknown> } };
  if (r.ok) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.value));
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    // Surface the diagnostic context (availableActions / availableSections / ...)
    // alongside message + code so REST callers get the same self-correction hints.
    res.end(JSON.stringify({ error: r.error?.message, code: r.error?.code, context: r.error?.context }));
  }
}
