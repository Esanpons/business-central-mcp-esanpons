import { isErr, type Result, ok, err } from '../core/result.js';
import { ConnectionError } from '../core/errors.js';
import type { ConnectionFactory } from '../connection/connection-factory.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder } from '../protocol/interaction-encoder.js';
import { BCSession } from './bc-session.js';
import type { Logger } from '../core/logger.js';

export class SessionFactory {
  constructor(
    private readonly connectionFactory: ConnectionFactory,
    private readonly decoder: EventDecoder,
    private readonly encoder: InteractionEncoder,
    private readonly logger: Logger,
    private readonly tenantId: string,
    private readonly timeoutMs: number = 30000,
    private readonly profile: string = '',
  ) {}

  async create(): Promise<Result<BCSession, ConnectionError>> {
    const wsResult = await this.connectionFactory.create();
    if (isErr(wsResult)) return wsResult;

    // SaaS binds a server-assigned backend tenant (discovered from the WS URL);
    // on-prem uses the configured tenant. The provider decides.
    const tenantId = this.connectionFactory.provider.getTenantIdOverride() ?? this.tenantId;

    const session = new BCSession(
      wsResult.value,
      this.decoder,
      this.encoder,
      this.logger,
      tenantId,
      this.timeoutMs,
      this.profile,
    );

    const initResult = await session.initialize(tenantId);
    if (isErr(initResult)) {
      session.close();
      return err(new ConnectionError(`Session initialization failed: ${initResult.error.message}`));
    }

    return ok(session);
  }
}
