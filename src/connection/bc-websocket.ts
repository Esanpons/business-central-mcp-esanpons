import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import { ok, err, type Result } from '../core/result.js';
import { ConnectionError, ProtocolError, TimeoutError } from '../core/errors.js';
import { composeWithTimeout } from '../core/abort.js';
import { decompressIfNeeded } from '../protocol/decompression.js';
import type { Logger } from '../core/logger.js';

export interface BCWebSocketConfig {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /**
   * `false` accepts a self-signed / untrusted BC certificate for THIS socket
   * only (BC_TLS_INSECURE), instead of the process-wide
   * NODE_TLS_REJECT_UNAUTHORIZED=0. Omitted = Node's default (validate).
   */
  rejectUnauthorized?: boolean;
}

type MessageHandler = (data: unknown) => void;

/** Grace period between the polite close frame and a hard socket teardown. */
const FORCE_CLOSE_GRACE_MS = 500;

/**
 * `ProtocolError.code` for an RPC whose response never arrived. The session layer
 * treats it as fatal (see BCSession.invokeUnqueued): a request BC may still be
 * processing means the client's form/modal state can no longer be trusted.
 */
export const RPC_TIMEOUT_CODE = 'RPC_TIMEOUT';

export class BCWebSocket {
  private ws: WebSocket | null = null;
  private readonly pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private readonly messageHandlers: MessageHandler[] = [];
  private sequenceCounter = 0;
  private lastServerSequence = 0;
  readonly spaInstanceId: string;

  constructor(private readonly logger: Logger) {
    this.spaInstanceId = uuid().replace(/-/g, '').substring(0, 10);
  }

  get nextSequenceNo(): string {
    return `${this.spaInstanceId}#${++this.sequenceCounter}`;
  }

  get lastClientAckSequenceNumber(): number {
    return this.lastServerSequence;
  }

  async connect(config: BCWebSocketConfig): Promise<Result<void, ConnectionError>> {
    return new Promise((resolve) => {
      let settled = false;
      const { signal, cleanup } = composeWithTimeout(config.timeoutMs);

      const ws = new WebSocket(config.url, {
        headers: config.headers,
        ...(config.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
      });

      const settle = (result: Result<void, ConnectionError>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      ws.on('open', () => {
        // The connect promise may already have settled (timeout/abort raced the
        // handshake, and `signal`'s handler called ws.close() before the server's
        // 101 arrived). Adopting the socket now would install a live `this.ws`
        // that nobody is waiting on -- a zombie connection that makes isConnected
        // report true for a session the caller believes failed.
        if (settled) { ws.close(); return; }
        this.ws = ws;
        this.setupHandlers(ws);
        this.logger.info(`WebSocket connected to ${config.url.split('?')[0]}`);
        settle(ok(undefined));
      });

      ws.on('error', (e) => {
        settle(err(new ConnectionError(`WebSocket connection failed: ${e.message}`)));
      });

      signal.addEventListener(
        'abort',
        () => {
          ws.close();
          settle(
            err(
              new ConnectionError(
                signal.reason instanceof TimeoutError
                  ? `Connection timed out after ${config.timeoutMs}ms`
                  : 'Connection aborted',
              ),
            ),
          );
        },
        { once: true },
      );
    });
  }

  private setupHandlers(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const parsed: unknown = JSON.parse(data.toString());
        this.routeMessage(parsed);
      } catch (e) {
        this.logger.error(
          `Failed to parse WebSocket message: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });

    ws.on('close', (code, reason) => {
      this.logger.warn(`WebSocket closed: ${code} ${reason.toString()}`);
      this.rejectAllPending('WebSocket closed while waiting for response');
    });

    ws.on('error', (e) => {
      this.logger.error(`WebSocket error: ${e.message}`);
    });
  }

  private routeMessage(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object') return;
    const msg = parsed as Record<string, unknown>;

    // Forward to all message handlers (copy array to prevent mutation during iteration)
    const handlers = [...this.messageHandlers];
    for (const handler of handlers) {
      try {
        handler(parsed);
      } catch (e) {
        // A buggy consumer must not break routing, but swallowing silently hides
        // real decoder bugs -- log it.
        this.logger.error(`Message handler threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // JSON-RPC response (has id field)
    if ('id' in msg && msg['id'] !== null && msg['id'] !== undefined) {
      const id = String(msg['id']);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if ('error' in msg) {
          pending.reject(new ProtocolError(`JSON-RPC error: ${JSON.stringify(msg['error'])}`));
        } else {
          pending.resolve(msg);
        }
      }
      return;
    }

    // Async Message notification (method: "Message", no id)
    if (
      msg['method'] === 'Message' &&
      Array.isArray(msg['params']) &&
      (msg['params'] as unknown[]).length > 0
    ) {
      const messageData = (msg['params'] as unknown[])[0] as Record<string, unknown>;
      const seqNum = messageData['sequenceNumber'];
      if (typeof seqNum === 'number' && seqNum > this.lastServerSequence) {
        this.lastServerSequence = seqNum;
      }
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      const idx = this.messageHandlers.indexOf(handler);
      if (idx >= 0) this.messageHandlers.splice(idx, 1);
    };
  }

  /**
   * Send one JSON-RPC request and await its response.
   *
   * There is deliberately NO queue here. BC's protocol is stateful and needs a
   * single serialization point -- that point is `BCSession.enqueue`, which owns
   * the encode + send + decode + form-tracking cycle as one atomic unit. A second
   * queue at this layer only serialized the SEND, which never protected anything
   * the session queue didn't already protect, and made the true ordering harder
   * to reason about. Every caller of sendRpc runs inside a session-enqueued task.
   */
  async sendRpc(
    method: string,
    params: unknown[],
    timeoutMs: number,
  ): Promise<Result<unknown, ProtocolError>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return err(new ProtocolError('WebSocket is not connected'));
    }

    const id = uuid();
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<Result<unknown, ProtocolError>>((resolve) => {
      const { signal, cleanup } = composeWithTimeout(timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          cleanup();
          const decompressed = decompressIfNeeded(value);
          resolve(decompressed);
        },
        reject: (reason) => {
          cleanup();
          resolve(err(new ProtocolError(reason.message)));
        },
      });

      signal.addEventListener(
        'abort',
        () => {
          this.pendingRequests.delete(id);
          resolve(
            err(
              signal.reason instanceof TimeoutError
                // Coded so the session layer can recognise a timeout without
                // string-matching, and treat it as session-fatal: BC never
                // answered, so the client's idea of the server state (open forms,
                // modal stack) is no longer trustworthy.
                ? new ProtocolError(`RPC timed out after ${timeoutMs}ms`, { method, timeoutMs }, RPC_TIMEOUT_CODE)
                : new ProtocolError('RPC aborted', { method }),
            ),
          );
        },
        { once: true },
      );

      try {
        ws.send(payload);
      } catch (e) {
        this.pendingRequests.delete(id);
        cleanup();
        resolve(err(new ProtocolError(`WebSocket send failed: ${e instanceof Error ? e.message : String(e)}`)));
        return;
      }
      this.logger.debug('protocol', `Sent RPC: ${method} (id: ${id})`);
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Hard teardown for kill paths (invoke timeout, fatal session error).
   *
   * `close()` alone sends a close frame and then waits for the peer's answer. On
   * a half-open TCP connection -- exactly the situation a kill path is reacting
   * to -- that answer never comes, so the `close` event (the ONLY place pending
   * requests are rejected) can be minutes away while `isConnected` keeps
   * reporting true. This detaches the socket immediately, fails every pending
   * request, asks politely, and terminates if the peer does not answer quickly.
   */
  forceClose(): void {
    const ws = this.ws;
    this.ws = null;
    this.rejectAllPending('WebSocket was force-closed while waiting for a response');
    if (!ws) return;
    try { ws.close(); } catch { /* already gone */ }
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* already gone */ }
    }, FORCE_CLOSE_GRACE_MS);
    // Never hold the event loop open just to hard-kill a socket.
    if (typeof timer.unref === 'function') timer.unref();
  }

  private rejectAllPending(reason: string): void {
    if (this.pendingRequests.size === 0) return;
    const pending = [...this.pendingRequests.entries()];
    this.pendingRequests.clear();
    for (const [id, { reject }] of pending) {
      reject(new ConnectionError(`${reason} (${id})`));
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
