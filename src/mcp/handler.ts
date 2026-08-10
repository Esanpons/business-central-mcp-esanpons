import type { ToolDefinition } from './tool-registry.js';
import type { Logger } from '../core/logger.js';
import { SessionLostError } from '../core/errors.js';
import { translateBcError } from '../core/error-translator.js';
import type { Metrics } from '../services/metrics.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export interface JsonRpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC / MCP error codes used by this server. */
export const JsonRpcErrorCode = {
  /** Malformed JSON on the wire. Only a transport can raise this (the body never parsed). */
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP: the method exists but the requested resource does not. */
  ResourceNotFound: -32002,
} as const;

/**
 * Protocol versions this server can speak, newest first. `initialize` echoes the
 * client's version when it is one of these (the spec's negotiation rule), otherwise
 * it answers with the newest one it supports and lets the client decide.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * Default cap on the serialized JSON of ONE tool result, in characters.
 *
 * ~250k chars is roughly 60k tokens of JSON: far above any narrowed read (a 100-row
 * list with 10 columns is ~30k chars) and below the point where one un-narrowed
 * bc_open_page on a document page eats the client's whole budget. Past the cap the
 * client would truncate the response ANYWAY, silently and mid-JSON; an explicit
 * RESPONSE_TOO_LARGE that names the narrowing parameter is strictly more useful.
 * Override with BC_MAX_RESPONSE_CHARS.
 */
const DEFAULT_MAX_RESPONSE_CHARS = 250_000;

/**
 * Default cap on an inline base64 image, in characters. A 1600x1000 capture at
 * scale 2 is typically 300KB-1.2MB of base64. Over the cap the image block is
 * DROPPED (never the whole response — the PNG is on disk either way) and the text
 * says how to ask for less.
 */
const DEFAULT_MAX_INLINE_IMAGE_CHARS = 1_500_000;

/**
 * Per-tool narrowing knobs, named verbatim in the RESPONSE_TOO_LARGE error so the
 * model can retry correctly on the next turn instead of guessing which parameter
 * shrinks the payload.
 */
const NARROWING_HINTS: Record<string, string> = {
  bc_open_page: 'summary:true (sections identity only), sections:["header"], tab, columns, range:{offset,limit}',
  bc_read_data: 'columns, range:{offset,limit}, filters, tab, group, or one section at a time',
  bc_execute_action: 'quiet:true (suppresses the updatedFields dump), then read what you need with bc_read_data',
  bc_screenshot: 'inline:false (the PNG is written to disk regardless), a lower scale, or crop',
  bc_build_manual: 'fewer steps per call, or assets:"files" instead of inline',
  bc_find_object: 'limit, and type to restrict the object type',
  bc_search_pages: 'a narrower query',
  bc_refresh_objects: 'a smaller { from, to } range instead of all:true',
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface MCPHandlerOptions {
  /** Cap on the serialized JSON of a single tool result. Default BC_MAX_RESPONSE_CHARS or 400000. */
  maxResponseChars?: number;
  /** Cap on an inline base64 image. Default BC_MAX_INLINE_IMAGE_CHARS or 1500000. */
  maxInlineImageChars?: number;
}

export class MCPHandler {
  /** The version agreed at `initialize`; null until the client initializes. */
  private negotiatedProtocolVersion: string | null = null;
  private readonly maxResponseChars: number;
  private readonly maxInlineImageChars: number;

  /** The protocol version in force, for diagnostics and for transports that care. */
  get protocolVersion(): string {
    return this.negotiatedProtocolVersion ?? LATEST_PROTOCOL_VERSION;
  }

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
    options?: MCPHandlerOptions,
  ) {
    this.maxResponseChars = options?.maxResponseChars ?? envInt('BC_MAX_RESPONSE_CHARS', DEFAULT_MAX_RESPONSE_CHARS);
    this.maxInlineImageChars = options?.maxInlineImageChars ?? envInt('BC_MAX_INLINE_IMAGE_CHARS', DEFAULT_MAX_INLINE_IMAGE_CHARS);
  }

  /**
   * Handle one JSON-RPC request.
   *
   * Returns `null` for a NOTIFICATION (a request with no id) — per JSON-RPC 2.0 a
   * notification gets no response at all, not even an empty one. Emitting
   * `{"jsonrpc":"2.0","result":{}}` (no id, no error) as this used to do for
   * `notifications/initialized` is an invalid frame; stdio happened to hide it,
   * HTTP wrote it to the wire. Both transports must skip a null.
   */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = request.id === undefined || request.id === null;

    try {
      switch (request.method) {
        case 'initialize':
          return this.respond(isNotification, this.handleInitialize(request));
        case 'notifications/initialized':
        case 'notifications/cancelled':
          // Notifications carry no id, so this returns null. Kept as explicit cases
          // (instead of falling through to "method not found") for clients that
          // wrongly send them WITH an id.
          return this.respond(isNotification, { jsonrpc: '2.0', id: request.id, result: {} });
        case 'tools/list':
          return this.respond(isNotification, this.handleToolsList(request));
        case 'tools/call':
          return this.respond(isNotification, await this.handleToolsCall(request));
        case 'resources/list':
          return this.respond(isNotification, { jsonrpc: '2.0', id: request.id, result: { resources: [] } });
        case 'resources/read':
          // The METHOD exists — it is the requested resource that does not. -32601
          // ("Method not found") told the client the server cannot do resources/read
          // at all, which is a different bug for it to route around.
          return this.respond(isNotification, {
            jsonrpc: '2.0', id: request.id,
            error: { code: JsonRpcErrorCode.ResourceNotFound, message: 'Resource not found: this server exposes no resources.' },
          });
        case 'prompts/list':
          return this.respond(isNotification, { jsonrpc: '2.0', id: request.id, result: { prompts: [] } });
        case 'prompts/get':
          // Same distinction: prompts/get is implemented, the prompt NAME is unknown,
          // which is an invalid-params condition.
          return this.respond(isNotification, {
            jsonrpc: '2.0', id: request.id,
            error: { code: JsonRpcErrorCode.InvalidParams, message: 'Unknown prompt: this server exposes no prompts.' },
          });
        default:
          // Unknown notifications (notifications/initialized, notifications/cancelled,
          // ...) land here and correctly produce nothing.
          return this.respond(isNotification, {
            jsonrpc: '2.0', id: request.id,
            error: { code: JsonRpcErrorCode.MethodNotFound, message: `Method not found: ${request.method}` },
          });
      }
    } catch (e) {
      return this.respond(isNotification, {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: JsonRpcErrorCode.InternalError, message: e instanceof Error ? e.message : 'Internal error' },
      });
    }
  }

  /** Build the -32700 frame a transport must send when the request body was not JSON. */
  static parseErrorResponse(detail?: string): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: JsonRpcErrorCode.ParseError, message: detail ? `Parse error: ${detail}` : 'Parse error' },
    };
  }

  private respond(isNotification: boolean, response: JsonRpcResponse): JsonRpcResponse | null {
    return isNotification ? null : response;
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    const requested = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    // Spec: echo the client's version when we support it; otherwise answer with our
    // latest and let the client decide whether it can live with it. Answering
    // 2025-06-18 unconditionally (as before) silently mis-declares the wire contract
    // to an older client.
    const agreed = typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    if (typeof requested === 'string' && requested !== agreed) {
      this.logger.warn(`Client requested MCP protocol ${requested}; answering with ${agreed}.`);
    }
    this.negotiatedProtocolVersion = agreed;
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: agreed,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
      },
    };
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: this.tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as { name?: string; arguments?: unknown } | undefined;
    if (!params?.name) {
      return { jsonrpc: '2.0', id: request.id, error: { code: JsonRpcErrorCode.InvalidParams, message: 'Missing tool name' } };
    }

    const tool = this.tools.find(t => t.name === params.name);
    if (!tool) {
      return { jsonrpc: '2.0', id: request.id, error: { code: JsonRpcErrorCode.InvalidParams, message: `Unknown tool: ${params.name}` } };
    }

    this.metrics?.recordInvoke();

    // Validate input via Zod
    const parseResult = tool.zodSchema.safeParse(params.arguments ?? {});
    if (!parseResult.success) {
      // Bad input is the single most common agent-visible failure; without this it
      // never reached errorsByCode and bc_health under-reported reality.
      this.metrics?.recordError('INPUT_VALIDATION', `${params.name}: ${parseResult.error.message}`);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `Input validation error: ${parseResult.error.message}` }],
          isError: true,
        },
      };
    }

    // Execute the tool
    try {
      const result = await tool.execute(parseResult.data);
      // Result is a Result<T, ProtocolError>
      const r = result as { ok: boolean; value?: unknown; error?: { message?: string; code?: string; context?: Record<string, unknown> } };
      if (r.ok) {
        return this.buildSuccessResult(request.id, params.name, r.value);
      } else {
        // Preserve the tool's own typed error code (CARDPART_STUB,
        // PAGE_NOT_MATERIALIZED, ...) and its diagnostic context
        // (availableActions / availableSections / availableFields / hostHint,
        // ...) so the caller can self-correct in one turn instead of making
        // extra discovery calls.
        return this.buildErrorResult(request.id, r.error?.message ?? 'Unknown error', r.error?.code, r.error?.context);
      }
    } catch (e) {
      // Session recovery: return a clear message so the LLM knows to re-open pages
      if (e instanceof SessionLostError) {
        this.logger.info(`Session recovered during ${params.name}. Impacted contexts: ${e.impactedPageContextIds.join(', ') || 'none'}`);
        // Counted like any other failure — a reconnect storm is exactly what someone
        // reads bc_health to discover.
        this.metrics?.recordError('SESSION_LOST', e.message);
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: e.message }],
            isError: true,
          },
        };
      }

      const raw = e instanceof Error ? e.message : String(e);
      this.logger.error(`Tool ${params.name} failed: ${raw}`);
      const code = (e as { code?: string }).code;
      const context = (e as { context?: Record<string, unknown> }).context;
      return this.buildErrorResult(request.id, raw, code, context);
    }
  }

  /**
   * Serialize a successful tool result, enforcing the response-size budget.
   *
   * Nothing used to bound this: an un-narrowed bc_open_page on a document page
   * serializes every section, field, row and action, and bc_screenshot defaults to
   * inline:true at scale 2. Every mitigation (summary / columns / range / quiet /
   * inline:false) is opt-in, so the model blew the client's budget BEFORE it could
   * learn which knob to turn. Now it is told, by name, which knob.
   */
  private buildSuccessResult(id: unknown, toolName: string, value: unknown): JsonRpcResponse {
    // A tool may attach an inline image via a `__image` field ({ data, mimeType }).
    // Surface it as an MCP image content block alongside the JSON text.
    // JSON is emitted compact (no pretty-print) to keep responses token-light.
    const record = value as Record<string, unknown> | undefined;
    const image = record && (record.__image as { data?: string; mimeType?: string } | undefined);
    let payload: unknown = value;
    if (record && image && image.data) {
      const { __image: _omit, ...rest } = record;
      payload = rest;
    }

    const text = JSON.stringify(payload);
    if (text.length > this.maxResponseChars) {
      const hint = NARROWING_HINTS[toolName];
      this.metrics?.recordError('RESPONSE_TOO_LARGE', `${toolName}: ${text.length} chars`);
      this.logger.warn(`${toolName} response of ${text.length} chars exceeds the ${this.maxResponseChars}-char budget; refused.`);
      const message = hint
        ? `${toolName} produced ${text.length} characters of JSON, over the ${this.maxResponseChars}-character response budget. Nothing was returned. Re-run it narrowed with: ${hint}.`
        : `${toolName} produced ${text.length} characters of JSON, over the ${this.maxResponseChars}-character response budget. Nothing was returned. Ask for less data (fewer rows/fields per call).`;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{
            type: 'text',
            text: `Error [RESPONSE_TOO_LARGE]: ${message}\n${JSON.stringify({ context: { tool: toolName, chars: text.length, limit: this.maxResponseChars, narrowWith: hint ?? null } })}`,
          }],
          isError: true,
        },
      };
    }

    const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
    if (image && image.data) {
      if (image.data.length > this.maxInlineImageChars) {
        // Drop only the image: the file itself was already written to disk, so the
        // caller keeps the useful part of the result instead of losing the call.
        this.logger.warn(`Inline image from ${toolName} is ${image.data.length} chars, over the ${this.maxInlineImageChars}-char inline budget; omitted.`);
        content.push({
          type: 'text',
          text: `[inline image omitted: ${image.data.length} base64 chars exceeds the ${this.maxInlineImageChars}-char inline budget. The PNG was still written to disk — see the "path" above. Re-run with inline:false, a lower scale, or a crop to get a smaller image.]`,
        });
      } else {
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType ?? 'image/png' });
      }
    }
    return { jsonrpc: '2.0', id, result: { content } };
  }

  /**
   * Build an MCP error response. Prefers the error object's own typed code over
   * the message-derived one, and appends the structured diagnostic context (if
   * any) on a second line as JSON so the model can retry without a round-trip.
   */
  private buildErrorResult(
    id: unknown,
    rawMessage: string,
    typedCode?: string,
    context?: Record<string, unknown>,
  ): JsonRpcResponse {
    const translated = translateBcError(rawMessage);
    const code = typedCode && typedCode !== 'PROTOCOL_ERROR' ? typedCode : translated.code;
    this.metrics?.recordError(code, rawMessage);
    const hasContext = context && Object.keys(context).length > 0;
    const text = hasContext
      ? `Error [${code}]: ${translated.message}\n${JSON.stringify({ context })}`
      : `Error [${code}]: ${translated.message}`;
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
  }
}
