import { describe, it, expect } from 'vitest';
import { MCPHandler } from '../../src/mcp/handler.js';
import { WriteDataSchema, BuildManualSchema, OpenPageSchema } from '../../src/mcp/schemas.js';

const logger = { info(){}, warn(){}, error(){}, debug(){} } as never;
const tool = (name: string, zodSchema: unknown, execute = async () => ({ ok: true, value: {} })) =>
  ({ name, description: '', inputSchema: {}, zodSchema, execute } as never);

async function call(h: MCPHandler, name: string, args: unknown) {
  const r = await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } as never);
  return (r as { result?: { content?: Array<{ text: string }>; isError?: boolean } }).result;
}

describe('unknown tool parameters', () => {
  it('rejects a fabricated parameter instead of silently dropping it', async () => {
    const h = new MCPHandler([tool('bc_write_data', WriteDataSchema)], logger);
    const res = await call(h, 'bc_write_data', { pageContextId: 'p', fields: { Cantidad: '2' }, section: 'lines', newRow: true });
    expect(res?.isError).toBe(true);
    expect(res?.content?.[0]?.text).toContain('"newRow"');
    expect(res?.content?.[0]?.text).toContain('rowIndex');
  });

  it('accepts a valid call unchanged', async () => {
    const h = new MCPHandler([tool('bc_write_data', WriteDataSchema)], logger);
    const res = await call(h, 'bc_write_data', { pageContextId: 'p', fields: { Cantidad: '2' }, section: 'lines', rowIndex: 0 });
    expect(res?.isError).toBeFalsy();
  });

  it('sees through a .refine()d schema (BuildManualSchema)', async () => {
    const h = new MCPHandler([tool('bc_build_manual', BuildManualSchema)], logger);
    const bad = await call(h, 'bc_build_manual', { title: 'T', steps: [{ heading: 'h' }], nonsense: 1 });
    expect(bad?.content?.[0]?.text).toContain('"nonsense"');
    const good = await call(h, 'bc_build_manual', { title: 'T', steps: [{ heading: 'h' }] });
    expect(good?.isError).toBeFalsy();
  });

  it('lists several unknown keys at once', async () => {
    const h = new MCPHandler([tool('bc_open_page', OpenPageSchema)], logger);
    const res = await call(h, 'bc_open_page', { pageId: 42, foo: 1, bar: 2 });
    expect(res?.content?.[0]?.text).toContain('"foo"');
    expect(res?.content?.[0]?.text).toContain('"bar"');
  });
});
