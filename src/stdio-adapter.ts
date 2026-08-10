import { createInterface } from 'node:readline';

/**
 * stdio <-> HTTP bridge: forwards JSON-RPC lines from stdin to a RUNNING
 * `npm start` server's /mcp endpoint and writes the replies back to stdout.
 *
 * Everything it emits must be a valid JSON-RPC frame, because its stdout IS the
 * MCP client's transport. It used to echo `response.text()` verbatim with no status
 * check, so the client received, as if they were responses:
 *   - the id-less reply to a notification,
 *   - `{"error":"Unauthorized"}` whenever API_TOKEN was set (it never sent one),
 *   - `{"error":...}` 500 bodies.
 */
const PORT = process.env.PORT ?? '3000';
const BASE_URL = process.env.BC_MCP_URL ?? `http://127.0.0.1:${PORT}`;
/** Same token the server checks (api/middleware.checkApiToken). Unset = no header. */
const API_TOKEN = process.env.API_TOKEN;

interface JsonRpcLike { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown }

function write(frame: unknown): void {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

function errorFrame(id: unknown, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line: string) => {
  if (!line.trim()) return;

  // Parse locally first: we need the id both to decide whether a response is even
  // expected and to build a well-formed error frame if the hop fails.
  let id: unknown = null;
  let isNotification = false;
  try {
    const parsed = JSON.parse(line) as { id?: unknown };
    id = parsed.id ?? null;
    isNotification = parsed.id === undefined || parsed.id === null;
  } catch {
    errorFrame(null, -32700, 'Parse error: the line sent to the stdio adapter is not valid JSON.');
    return;
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

    const response = await fetch(`${BASE_URL}/mcp`, { method: 'POST', headers, body: line });
    const text = await response.text();

    // A notification gets no response, whatever the server said (the server answers
    // 202 with an empty body). Emitting anything here corrupts the client's stream.
    if (isNotification) return;

    if (!response.ok) {
      // Non-2xx bodies are plain `{"error":...}` objects (401 Unauthorized, 500,
      // 400 parse error). If the body already IS a JSON-RPC error frame, pass it
      // through; otherwise wrap it into one.
      const passthrough = asJsonRpcFrame(text);
      if (passthrough) { write(passthrough); return; }
      const detail = extractErrorText(text) ?? `HTTP ${response.status}`;
      const hint = response.status === 401
        ? ' The server requires a token: set API_TOKEN in this adapter\'s environment to the same value.'
        : '';
      errorFrame(id, response.status === 401 ? -32600 : -32603, `MCP HTTP transport error (${response.status}): ${detail}.${hint}`);
      return;
    }

    if (!text.trim()) {
      // 2xx with an empty body only happens for notifications, already handled.
      errorFrame(id, -32603, 'MCP HTTP transport returned an empty body for a request that expected a response.');
      return;
    }

    const frame = asJsonRpcFrame(text);
    if (!frame) {
      errorFrame(id, -32603, `MCP HTTP transport returned a non-JSON-RPC body: ${text.slice(0, 500)}`);
      return;
    }
    write(frame);
  } catch (e) {
    if (isNotification) return;
    const error = e instanceof Error ? e.message : String(e);
    errorFrame(id, -32603, `Server connection failed: ${error}`);
  }
});

/** Returns the parsed body when it is a usable JSON-RPC frame, else null. */
function asJsonRpcFrame(text: string): JsonRpcLike | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as JsonRpcLike;
  // A response must carry an id AND exactly one of result/error. Anything else
  // (notably `{"error":"Unauthorized"}`) is not a response frame.
  const hasId = frame.id !== undefined && frame.id !== null;
  const hasResult = frame.result !== undefined;
  const hasErrorObject = typeof frame.error === 'object' && frame.error !== null;
  if (!hasId || !(hasResult || hasErrorObject)) return null;
  return { ...frame, jsonrpc: '2.0' };
}

function extractErrorText(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.error === 'object' && parsed.error !== null) {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  } catch { /* not JSON */ }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

rl.on('close', () => {
  process.exit(0);
});
