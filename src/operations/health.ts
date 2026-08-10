import { ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { BCConfig } from '../core/config.js';
import type { Metrics, MetricsSnapshot } from '../services/metrics.js';
import { SERVER_VERSION } from '../mcp/version.js';

export interface HealthDeps {
  /** Reads the live session (may be null when BC is unreachable / not yet connected). */
  currentSession: () => BCSession | null;
  metrics: Metrics;
  bc: BCConfig;
}

export interface HealthOutput {
  status: 'connected' | 'disconnected';
  version: string;
  bc: {
    baseUrl: string;
    /** Auth mode: 'UserPassword' = on-prem forms; 'AAD' = BC Online (SaaS). */
    authMode: string;
    /** Human hint of the target kind, so a caller can tell SaaS from on-prem at a glance. */
    environmentKind: 'saas' | 'on-prem';
    tenantId: string;
    applicationId: string;
    serverMajor: number;
    clientVersion: string;
  };
  session: null | {
    alive: boolean;
    initialized: boolean;
    company: string;
    openForms: number;
    modalDepth: number;
  };
  /**
   * Whatever Metrics currently exposes, serialized as-is. Typed as the snapshot
   * interface rather than a hand-listed set of fields, so a counter added to
   * Metrics shows up in bc_health with no change here.
   */
  metrics: MetricsSnapshot;
}

/**
 * Reports server + session health and diagnostics. Unlike every other operation it
 * does NOT require a live BC session — it reads whatever the SessionManager currently
 * holds — so it answers even when BC is down. It must be wired to bypass the
 * ensureSession() gate in the server entrypoints.
 */
export class HealthOperation {
  constructor(private readonly deps: HealthDeps) {}

  execute(): Promise<Result<HealthOutput, ProtocolError>> {
    const s = this.deps.currentSession();
    const session = s
      ? {
          alive: s.isAlive,
          initialized: s.isInitialized,
          company: s.companyName,
          openForms: s.openFormIds.size,
          modalDepth: s.modalStackSnapshot().length,
        }
      : null;

    const out: HealthOutput = {
      status: s && s.isAlive ? 'connected' : 'disconnected',
      // Read from package.json (src/mcp/version.ts), never hardcoded: this string,
      // the MCP serverInfo and the REST surface had each drifted to their own
      // stale "2.0.0".
      version: SERVER_VERSION,
      bc: {
        baseUrl: this.deps.bc.baseUrl,
        authMode: this.deps.bc.authMode,
        environmentKind: this.deps.bc.authMode === 'AAD' ? 'saas' : 'on-prem',
        tenantId: this.deps.bc.tenantId,
        applicationId: this.deps.bc.applicationId,
        serverMajor: this.deps.bc.serverMajor,
        clientVersion: this.deps.bc.clientVersionString,
      },
      session,
      metrics: this.deps.metrics.snapshot(),
    };
    return Promise.resolve(ok(out));
  }
}
