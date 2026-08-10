// tests/unit/api-routes.test.ts
//
// The REST surface used to (a) be unreachable on a cold process, because the route
// table only existed after a BC session had been created, and (b) cast the raw body
// straight into the operations, so `{}` produced a deep TypeError -> 500 and
// `{"pageId":{"$gt":1}}` reached BC as `page=[object Object]`.

import { describe, it, expect, vi } from 'vitest';
import { createApiRoutes, API_ROUTE_KEYS, validateRouteBody } from '../../src/api/routes.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

function fakeRes() {
  const state = { status: 0, body: '' };
  const res = {
    writeHead: (status: number) => { state.status = status; return res; },
    end: (body?: string) => { state.body = body ?? ''; },
  } as unknown as ServerResponse;
  return { res, state };
}

const req = {} as IncomingMessage;

describe('route keys are known before any session exists', () => {
  it('exposes every POST route statically', () => {
    for (const key of [
      'POST /api/v1/pages/open', 'POST /api/v1/pages/read', 'POST /api/v1/pages/write',
      'POST /api/v1/pages/action', 'POST /api/v1/pages/close', 'POST /api/v1/search',
      'POST /api/v1/navigate',
    ]) {
      expect(API_ROUTE_KEYS.has(key), key).toBe(true);
    }
  });

  it('no longer registers the unreachable, always-healthy GET /health', () => {
    expect(API_ROUTE_KEYS.has('GET /health')).toBe(false);
  });

  it('the built map has exactly the advertised keys', () => {
    const routes = createApiRoutes({} as Operations, createNullLogger());
    expect(new Set(routes.keys())).toEqual(new Set(API_ROUTE_KEYS));
  });
});

describe('validateRouteBody works with no operations at all', () => {
  // The server calls this BEFORE ensureReady(), so a bad body is rejected without
  // triggering a BC login + WebSocket connect.
  it('rejects an invalid body and returns the issues', () => {
    const v = validateRouteBody('POST /api/v1/pages/open', { pageId: 'Customer List' });
    expect(v.ok).toBe(false);
    expect((v.errorBody as { code: string }).code).toBe('INPUT_VALIDATION');
  });

  it('accepts a valid body', () => {
    expect(validateRouteBody('POST /api/v1/pages/open', { pageId: 22 }).ok).toBe(true);
  });

  it('is a no-op for an unknown route key', () => {
    expect(validateRouteBody('POST /api/v1/nope', { anything: true }).ok).toBe(true);
  });
});

describe('REST bodies go through the same Zod schemas as the MCP tools', () => {
  it('rejects an empty body with 400 + the Zod issues, without calling the operation', async () => {
    const readData = { execute: vi.fn() };
    const routes = createApiRoutes({ readData } as unknown as Operations, createNullLogger());
    const { res, state } = fakeRes();
    await routes.get('POST /api/v1/pages/read')!(req, res, {});
    expect(state.status).toBe(400);
    const body = JSON.parse(state.body) as { code: string; issues: Array<{ path: string }> };
    expect(body.code).toBe('INPUT_VALIDATION');
    expect(body.issues.some(i => i.path === 'pageContextId')).toBe(true);
    expect(readData.execute).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric / object pageId instead of forwarding it to BC', async () => {
    const openPage = { execute: vi.fn() };
    const routes = createApiRoutes({ openPage } as unknown as Operations, createNullLogger());
    for (const pageId of [{ $gt: 1 }, "22&mode=Edit", 'customers']) {
      const { res, state } = fakeRes();
      await routes.get('POST /api/v1/pages/open')!(req, res, { pageId });
      expect(state.status, JSON.stringify(pageId)).toBe(400);
    }
    expect(openPage.execute).not.toHaveBeenCalled();
  });

  it('passes a valid body through (coerced) and returns the operation value', async () => {
    const openPage = { execute: vi.fn(async () => ({ ok: true, value: { pageContextId: 'p1' } })) };
    const routes = createApiRoutes({ openPage } as unknown as Operations, createNullLogger());
    const { res, state } = fakeRes();
    await routes.get('POST /api/v1/pages/open')!(req, res, { pageId: 22 });
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ pageContextId: 'p1' });
    // StringOrNumber coercion still applies on the REST path.
    expect(openPage.execute).toHaveBeenCalledWith(expect.objectContaining({ pageId: '22' }));
  });

  it('surfaces an operation error as 400 with code + context', async () => {
    const openPage = { execute: async () => ({ ok: false, error: { message: 'boom', code: 'PAGE_NOT_MATERIALIZED', context: { reason: 'Unknown' } } }) };
    const routes = createApiRoutes({ openPage } as unknown as Operations, createNullLogger());
    const { res, state } = fakeRes();
    await routes.get('POST /api/v1/pages/open')!(req, res, { pageId: '22' });
    expect(state.status).toBe(400);
    expect(JSON.parse(state.body)).toEqual({ error: 'boom', code: 'PAGE_NOT_MATERIALIZED', context: { reason: 'Unknown' } });
  });

  it('enforces the action/cue exclusivity refine on the REST path too', async () => {
    const executeAction = { execute: vi.fn() };
    const routes = createApiRoutes({ executeAction } as unknown as Operations, createNullLogger());
    const { res, state } = fakeRes();
    await routes.get('POST /api/v1/pages/action')!(req, res, { pageContextId: 'p', action: 'Post', cue: 'Sales Quotes' });
    expect(state.status).toBe(400);
    expect(executeAction.execute).not.toHaveBeenCalled();
  });
});
