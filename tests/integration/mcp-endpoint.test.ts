import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const PORT = '3456'; // Use a non-default port to avoid conflicts
const BASE_URL = `http://127.0.0.1:${PORT}`;

describe('MCP Endpoint (integration)', () => {
  let serverProcess: ChildProcess;
  let serverStderr = '';

  beforeAll(async () => {
    // Start the server as a child process
    serverProcess = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
      cwd: 'U:/git/bc-mcp',
      env: { ...process.env, PORT },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    // Capture stderr for debugging
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      serverStderr += chunk.toString();
    });
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      serverStderr += chunk.toString(); // capture stdout too for logs
    });

    // Wait for server to be ready (poll /health)
    const maxWait = 30_000;
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < maxWait) {
      try {
        const resp = await fetch(`${BASE_URL}/health`);
        if (resp.ok) {
          ready = true;
          break;
        }
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!ready) {
      console.error('Server stderr:\n', serverStderr);
      throw new Error('Server did not become ready within 30s');
    }
  }, 60_000);

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  async function mcpCall(method: string, params?: unknown): Promise<unknown> {
    const response = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    return response.json();
  }

  it('initializes MCP protocol', async () => {
    const result = await mcpCall('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'test', version: '1.0' },
      capabilities: {},
    }) as any;

    console.error('initialize response:', JSON.stringify(result, null, 2));

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.result.protocolVersion).toBe('2025-06-18');
    expect(result.result.serverInfo.name).toBe('bc-mcp');
    expect(result.result.capabilities.tools).toBeDefined();
  }, 60_000);

  it('lists all registered tools', async () => {
    const result = await mcpCall('tools/list') as any;
    const tools = result.result.tools;
    const names: string[] = tools.map((t: any) => t.name);

    // Assert the known surface is present rather than a brittle exact count.
    const expected = [
      'bc_open_page', 'bc_read_data', 'bc_write_data', 'bc_execute_action',
      'bc_close_page', 'bc_search_pages', 'bc_navigate', 'bc_respond_dialog',
      'bc_switch_company', 'bc_list_companies', 'bc_run_report', 'bc_wizard_navigate',
      'bc_find_object', 'bc_refresh_objects', 'bc_download_report', 'bc_screenshot',
      'bc_build_manual', 'bc_health',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
    expect(tools.length).toBeGreaterThanOrEqual(expected.length);

    console.error('Tools:', names.join(', '));
  });

  it('opens Customer List (page 22) via tools/call', async () => {
    const result = await mcpCall('tools/call', {
      name: 'bc_open_page',
      arguments: { pageId: '22' },
    }) as any;

    // Should not be an error
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.result.isError).toBeUndefined();

    // Parse the text content
    const content = result.result.content[0].text;
    const data = JSON.parse(content);

    console.error('open_page keys:', Object.keys(data));
    console.error('pageContextId:', data.pageContextId);

    // Verify core shape
    expect(data.pageContextId).toBeTruthy();
    expect(data.pageContextId).toContain('page:22');

    // Should have sections array with a header section
    expect(Array.isArray(data.sections)).toBe(true);
    const header = data.sections.find((s: any) => s.kind === 'header');
    expect(header).toBeDefined();

    // Customer List is a list page -- header section carries rows
    expect(Array.isArray(header.rows)).toBe(true);
    expect(header.rows.length).toBeGreaterThan(0);
    console.error(`Got ${header.rows.length} rows`);
  }, 60_000);
});
