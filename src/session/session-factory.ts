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

  /**
   * @param company  Open the session ON this company instead of BC's default. A BC
   *   session is bound to its company at OpenSession — asking a live one to move is
   *   not honoured (see BCSession.changeCompany) — so a company switch is a session
   *   re-open, exactly as the web client does it with `?company=`.
   */
  async create(company?: string): Promise<Result<BCSession, ConnectionError>> {
    const wsResult = await this.connectionFactory.create();
    if (isErr(wsResult)) return wsResult;

    // SaaS binds a server-assigned backend tenant (discovered from the WS URL);
    // on-prem uses the configured tenant. The provider decides.
    const provider = this.connectionFactory.provider;
    const tenantId = provider.getTenantIdOverride() ?? this.tenantId;
    // SaaS omits `&tenant=` from OpenForm-style queries (BCSession.runReport);
    // the provider is the single source of truth for the mode, exactly as
    // PageService is configured from the mode at construction time.
    const omitTenantInQueries = provider.omitsTenantInQueries?.() ?? false;

    const session = new BCSession(
      wsResult.value,
      this.decoder,
      this.encoder,
      this.logger,
      tenantId,
      this.timeoutMs,
      this.profile,
      omitTenantInQueries,
    );

    const initResult = await session.initialize(tenantId, company);
    if (isErr(initResult)) {
      session.close();
      return err(new ConnectionError(`Session initialization failed: ${initResult.error.message}`));
    }

    return ok(session);
  }
}
