import { ok, err, isErr, type Result } from '../core/result.js';
import { ConnectionError } from '../core/errors.js';
import { BCWebSocket } from './bc-websocket.js';
import type { IBCAuthProvider } from './auth/auth-provider.js';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

/**
 * Browser-like UA for the WS upgrade. BC 28.x gateways (and the SaaS gateway)
 * inspect the upgrade like a browser request; a bare `ws` client identifies
 * itself with no User-Agent at all.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class ConnectionFactory {
  constructor(
    private readonly authProvider: IBCAuthProvider,
    private readonly bcConfig: BCConfig,
    private readonly logger: Logger,
  ) {}

  /** The active auth provider (SessionFactory reads its tenant override for SaaS). */
  get provider(): IBCAuthProvider {
    return this.authProvider;
  }

  async create(): Promise<Result<BCWebSocket, ConnectionError>> {
    if (!this.authProvider.isAuthenticated()) {
      const authResult = await this.authProvider.authenticate();
      if (isErr(authResult)) {
        return err(new ConnectionError(`Authentication failed: ${authResult.error.message}`));
      }
    }

    // SaaS: the provider discovered the full server-assigned WS URL (backend host +
    // tab). On-prem: build the default {baseUrl}/csh.
    const wsUrl = this.authProvider.getWebSocketUrl() ?? this.buildWebSocketUrl();
    const headers = this.upgradeHeaders();

    const ws = new BCWebSocket(this.logger);
    const connectResult = await ws.connect({
      url: wsUrl,
      headers,
      timeoutMs: this.bcConfig.timeoutMs,
      // BC_TLS_INSECURE: relax certificate validation for THIS socket instead of
      // the whole process (NODE_TLS_REJECT_UNAUTHORIZED=0 still works and is
      // still process-wide).
      ...(this.bcConfig.tlsInsecure ? { rejectUnauthorized: false } : {}),
    });

    if (isErr(connectResult)) return connectResult;
    return ok(ws);
  }

  /**
   * Upgrade headers = whatever the auth provider needs (cookies, and on SaaS its
   * own Origin/User-Agent) PLUS an Origin and a browser User-Agent for on-prem.
   *
   * BC 28.3's `RequestOriginValidationMiddleware` rejects a WebSocket upgrade
   * that carries no `Origin` with a bare 403 (empty body, before the app layer),
   * because `IsOriginAllowedForWebSocket` returns false for an empty origin and
   * `DisableWebSocketOriginValidation` defaults to false. The `ws` library sends
   * no Origin unless told to. `new URL(baseUrl).origin` is exactly what the
   * middleware's `IsSameOrigin` compares (scheme + host + non-default port), so a
   * same-origin upgrade is always allowed. No-op on BC 27 / 28.0, which do not
   * inspect the header -- verified against devel1.
   */
  private upgradeHeaders(): Record<string, string> {
    const headers = { ...this.authProvider.getWebSocketHeaders() };
    const has = (name: string): boolean =>
      Object.keys(headers).some((k) => k.toLowerCase() === name);
    if (!has('origin')) {
      try {
        headers['Origin'] = new URL(this.bcConfig.baseUrl).origin;
      } catch {
        // loadConfig validates BC_BASE_URL; a caller building BCConfig by hand
        // with a bad URL simply gets no Origin rather than a crash here.
        this.logger.warn(`Could not derive a WebSocket Origin from baseUrl "${this.bcConfig.baseUrl}"`);
      }
    }
    if (!has('user-agent')) headers['User-Agent'] = BROWSER_USER_AGENT;
    return headers;
  }

  private buildWebSocketUrl(): string {
    const base = this.bcConfig.baseUrl.replace(/^http/, 'ws');
    const queryParams = this.authProvider.getWebSocketQueryParams();
    queryParams['ackseqnb'] = '-1';

    const queryString = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    return `${base}/csh?${queryString}`;
  }
}
