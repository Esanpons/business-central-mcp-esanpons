/**
 * Minimal in-memory metrics for diagnostics (surfaced by bc_health and /health).
 * No external deps; counters reset on process restart. Incremented at the MCP
 * handler boundary (invokes/errors) and the session manager (reconnects/sessions).
 */
export interface MetricsSnapshot {
  invokes: number;
  errors: number;
  errorsByCode: Record<string, number>;
  reconnects: number;
  sessionsCreated: number;
  /** Epoch ms when the current session was established, or null. */
  sessionCreatedAt: number | null;
  /** Seconds since the current session was established, or null. */
  sessionUptimeSeconds: number | null;
  lastError: string | null;
}

export class Metrics {
  private invokes = 0;
  private errors = 0;
  private readonly errorsByCode = new Map<string, number>();
  private reconnects = 0;
  private sessionsCreated = 0;
  private sessionCreatedAt: number | null = null;
  private lastError: string | null = null;

  recordInvoke(): void {
    this.invokes++;
  }

  recordError(code: string, message?: string): void {
    this.errors++;
    this.errorsByCode.set(code, (this.errorsByCode.get(code) ?? 0) + 1);
    if (message) this.lastError = message;
  }

  recordReconnect(): void {
    this.reconnects++;
  }

  recordSessionCreated(): void {
    this.sessionsCreated++;
    this.sessionCreatedAt = Date.now();
  }

  snapshot(): MetricsSnapshot {
    return {
      invokes: this.invokes,
      errors: this.errors,
      errorsByCode: Object.fromEntries(this.errorsByCode),
      reconnects: this.reconnects,
      sessionsCreated: this.sessionsCreated,
      sessionCreatedAt: this.sessionCreatedAt,
      sessionUptimeSeconds: this.sessionCreatedAt === null ? null : Math.round((Date.now() - this.sessionCreatedAt) / 1000),
      lastError: this.lastError,
    };
  }
}
