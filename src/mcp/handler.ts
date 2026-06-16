import type { ToolDefinition } from './tool-registry.js';
import type { Logger } from '../core/logger.js';
import { SessionLostError } from '../core/errors.js';
import { translateBcError } from '../core/error-translator.js';
import type { Metrics } from '../services/metrics.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const MCP_PROTOCOL_VERSION = '2025-06-18';

export class MCPHandler {
  private initialized = false;

  get isInitialized(): boolean {
    return this.initialized;
  }

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
  ) {}

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);
        case 'notifications/initialized':
          return { jsonrpc: '2.0', id: request.id, result: {} };
        case 'tools/list':
          return this.handleToolsList(request);
        case 'tools/call':
          return await this.handleToolsCall(request);
        case 'resources/list':
          return { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        case 'resources/read':
          return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Resource not found' } };
        case 'prompts/list':
          return { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        case 'prompts/get':
          return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Prompt not found' } };
        default:
          return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
      }
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: e instanceof Error ? e.message : 'Internal error' },
      };
    }
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    this.initialized = true;
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'bc-mcp', version: '2.0.0' },
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
      return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Missing tool name' } };
    }

    const tool = this.tools.find(t => t.name === params.name);
    if (!tool) {
      return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
    }

    this.metrics?.recordInvoke();

    // Validate input via Zod
    const parseResult = tool.zodSchema.safeParse(params.arguments ?? {});
    if (!parseResult.success) {
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
      const r = result as { ok: boolean; value?: unknown; error?: { message: string } };
      if (r.ok) {
        // A tool may attach an inline image via a `__image` field ({ data, mimeType }).
        // Surface it as an MCP image content block alongside the JSON text.
        const value = r.value as Record<string, unknown> | undefined;
        const image = value && (value.__image as { data?: string; mimeType?: string } | undefined);
        const content: Array<Record<string, unknown>> = [];
        if (image && image.data) {
          const { __image: _omit, ...rest } = value as Record<string, unknown>;
          content.push({ type: 'text', text: JSON.stringify(rest, null, 2) });
          content.push({ type: 'image', data: image.data, mimeType: image.mimeType ?? 'image/png' });
        } else {
          content.push({ type: 'text', text: JSON.stringify(r.value, null, 2) });
        }
        return { jsonrpc: '2.0', id: request.id, result: { content } };
      } else {
        const t = translateBcError(r.error?.message ?? 'Unknown error');
        this.metrics?.recordError(t.code, r.error?.message);
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: `Error [${t.code}]: ${t.message}` }],
            isError: true,
          },
        };
      }
    } catch (e) {
      // Session recovery: return a clear message so the LLM knows to re-open pages
      if (e instanceof SessionLostError) {
        this.logger.info(`Session recovered during ${params.name}. Impacted contexts: ${e.impactedPageContextIds.join(', ') || 'none'}`);
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
      const t = translateBcError(raw);
      this.metrics?.recordError(t.code, raw);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `Error [${t.code}]: ${t.message}` }],
          isError: true,
        },
      };
    }
  }
}
