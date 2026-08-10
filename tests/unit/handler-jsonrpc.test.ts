// tests/unit/handler-jsonrpc.test.ts
//
// JSON-RPC / MCP correctness at the handler boundary:
//  - notifications (no id) get NO response frame at all;
//  - initialize negotiates the protocol version instead of always answering latest;
//  - resources/read and prompts/get use codes that mean what happened;
//  - the response-size guard refuses an oversized payload and names the knob;
//  - validation failures and SessionLostError are counted in metrics.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MCPHandler, LATEST_PROTOCOL_VERSION, JsonRpcErrorCode } from '../../src/mcp/handler.js';
import type { ToolDefinition } from '../../src/mcp/tool-registry.js';
import { createNullLogger } from '../../src/core/logger.js';
import { Metrics } from '../../src/services/metrics.js';
import { SessionLostError } from '../../src/core/errors.js';
import { SERVER_VERSION } from '../../src/mcp/version.js';

function tool(name: string, execute: (input: unknown) => Promise<unknown>, schema?: z.ZodType): ToolDefinition {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object' },
    zodSchema: schema ?? z.object({ q: z.string().min(1) }),
    execute,
  };
}

const logger = createNullLogger();

function handlerWith(tools: ToolDefinition[], metrics?: Metrics, options?: ConstructorParameters<typeof MCPHandler>[3]) {
  return new MCPHandler(tools, logger, metrics, options);
}

describe('notifications get no response', () => {
  it('returns null for notifications/initialized (no id)', async () => {
    const h = handlerWith([]);
    expect(await h.handleRequest({ jsonrpc: '2.0', id: undefined, method: 'notifications/initialized' })).toBeNull();
  });

  it('returns null for any id-less request, including unknown methods', async () => {
    const h = handlerWith([]);
    expect(await h.handleRequest({ jsonrpc: '2.0', id: undefined, method: 'notifications/cancelled' })).toBeNull();
    expect(await h.handleRequest({ jsonrpc: '2.0', id: null, method: 'tools/list' })).toBeNull();
    expect(await h.handleRequest({ jsonrpc: '2.0', id: undefined, method: 'does/not/exist' })).toBeNull();
  });

  it('still answers a request that carries an id', async () => {
    const h = handlerWith([]);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    expect(r).not.toBeNull();
    expect(r!.id).toBe(7);
  });
});

describe('initialize negotiates the protocol version', () => {
  it('echoes a supported client version', async () => {
    const h = handlerWith([]);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    expect((r!.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
    expect(h.protocolVersion).toBe('2024-11-05');
  });

  it('falls back to the latest supported version for an unknown one', async () => {
    const h = handlerWith([]);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((r!.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('reports the package.json version in serverInfo (never a hardcoded one)', async () => {
    const h = handlerWith([]);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const info = (r!.result as { serverInfo: { name: string; version: string } }).serverInfo;
    expect(info.name).toBe('bc-mcp');
    expect(info.version).toBe(SERVER_VERSION);
    expect(info.version).not.toBe('2.0.0');
  });
});

describe('error codes say what actually happened', () => {
  it('resources/read -> -32002 (resource not found), not method-not-found', async () => {
    const h = handlerWith([]);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'x' } });
    expect(r!.error?.code).toBe(JsonRpcErrorCode.ResourceNotFound);
  });

  it('prompts/get -> -32602 (invalid params)', async () => {
    const h = handlerWith([]);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'x' } });
    expect(r!.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('a genuinely unknown method still -> -32601', async () => {
    const h = handlerWith([]);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'nope' });
    expect(r!.error?.code).toBe(JsonRpcErrorCode.MethodNotFound);
  });

  it('parseErrorResponse builds a -32700 frame with a null id', () => {
    const frame = MCPHandler.parseErrorResponse('Invalid JSON body');
    expect(frame.id).toBeNull();
    expect(frame.error?.code).toBe(JsonRpcErrorCode.ParseError);
  });
});

describe('response size guard', () => {
  const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, pad: 'x'.repeat(100) })) };

  it('refuses an oversized result and names the narrowing parameters', async () => {
    const h = handlerWith(
      [tool('bc_open_page', async () => ({ ok: true, value: big }), z.object({}))],
      undefined,
      { maxResponseChars: 500 },
    );
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bc_open_page', arguments: {} } });
    const result = r!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('RESPONSE_TOO_LARGE');
    expect(result.content[0]!.text).toContain('summary:true');
    // The oversized payload itself must NOT be echoed back.
    expect(result.content[0]!.text.length).toBeLessThan(1500);
  });

  it('lets a normal-sized result through untouched', async () => {
    const h = handlerWith([tool('bc_open_page', async () => ({ ok: true, value: { a: 1 } }), z.object({}))], undefined, { maxResponseChars: 500 });
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bc_open_page', arguments: {} } });
    const result = r!.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ a: 1 });
  });

  it('drops an oversized inline image but keeps the rest of the result', async () => {
    const value = { path: 'C:/out.png', __image: { data: 'A'.repeat(5000), mimeType: 'image/png' } };
    const h = handlerWith([tool('bc_screenshot', async () => ({ ok: true, value }), z.object({}))], undefined, { maxInlineImageChars: 100 });
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bc_screenshot', arguments: {} } });
    const content = (r!.result as { content: Array<{ type: string; text?: string }> }).content;
    expect(content.some(c => c.type === 'image')).toBe(false);
    expect(JSON.parse(content[0]!.text!)).toEqual({ path: 'C:/out.png' });
    expect(content[1]!.text).toContain('inline image omitted');
  });

  it('keeps an inline image that fits', async () => {
    const value = { path: 'C:/out.png', __image: { data: 'A'.repeat(50), mimeType: 'image/png' } };
    const h = handlerWith([tool('bc_screenshot', async () => ({ ok: true, value }), z.object({}))], undefined, { maxInlineImageChars: 1000 });
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bc_screenshot', arguments: {} } });
    const content = (r!.result as { content: Array<{ type: string }> }).content;
    expect(content.some(c => c.type === 'image')).toBe(true);
  });
});

describe('metrics cover the two most agent-visible failures', () => {
  it('records INPUT_VALIDATION on a Zod failure', async () => {
    const metrics = new Metrics();
    const h = handlerWith([tool('bc_read_data', async () => ({ ok: true, value: {} }))], metrics);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bc_read_data', arguments: {} } });
    expect((r!.result as { isError: boolean }).isError).toBe(true);
    expect(metrics.snapshot().errorsByCode.INPUT_VALIDATION).toBe(1);
  });

  it('records SESSION_LOST when the session is recovered mid-call', async () => {
    const metrics = new Metrics();
    const h = handlerWith([
      tool('bc_read_data', async () => { throw new SessionLostError('session died', ['p1']); }, z.object({})),
    ], metrics);
    const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bc_read_data', arguments: {} } });
    expect((r!.result as { isError: boolean }).isError).toBe(true);
    expect(metrics.snapshot().errorsByCode.SESSION_LOST).toBe(1);
  });
});
