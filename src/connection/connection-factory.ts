import { ok, err, isErr, type Result } from '../core/result.js';
import { ConnectionError } from '../core/errors.js';
import { BCWebSocket } from './bc-websocket.js';
import type { IBCAuthProvider } from './auth/auth-provider.js';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

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
    const headers = this.authProvider.getWebSocketHeaders();

    const ws = new BCWebSocket(this.logger);
    const connectResult = await ws.connect({
      url: wsUrl,
      headers,
      timeoutMs: this.bcConfig.timeoutMs,
    });

    if (isErr(connectResult)) return connectResult;
    return ok(ws);
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
