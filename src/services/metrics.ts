/**
 * Minimal in-memory metrics for diagnostics (surfaced by bc_health and /health).
 * No external deps; counters reset on process restart. Incremented at the MCP
 * handler boundary (invokes/errors) and the session manager (reconnects/sessions).
 *
 * `browser` covers the OUT-OF-BAND headless-browser work (screenshots, report
 * downloads, manual builds). Those never touch the WebSocket, so they were
 * invisible to bc_health even though they are by far the slowest and flakiest
 * operations the server performs. The block is purely additive: every existing
 * field keeps its name and meaning.
 */
export interface BrowserOpStats {
  ok: number;
  failed: number;
  /** Total wall-clock ms spent in this kind of operation (ok + failed). */
  totalMs: number;
  /** Duration of the last attempt, ms (null when none ran). */
  lastMs: number | null;
}

export interface BrowserMetrics {
  screenshots: BrowserOpStats;
  reports: BrowserOpStats;
  manuals: BrowserOpStats;
}

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
  /** Out-of-band headless-browser operations (screenshots / reports / manuals). */
  browser: BrowserMetrics;
}

function emptyOpStats(): BrowserOpStats {
  return { ok: 0, failed: 0, totalMs: 0, lastMs: null };
}

function record(s: BrowserOpStats, ok: boolean, ms: number): void {
  if (ok) s.ok++; else s.failed++;
  s.totalMs += Math.max(0, Math.round(ms));
  s.lastMs = Math.max(0, Math.round(ms));
}

export class Metrics {
  private invokes = 0;
  private errors = 0;
  private readonly errorsByCode = new Map<string, number>();
  private reconnects = 0;
  private sessionsCreated = 0;
  private sessionCreatedAt: number | null = null;
  private lastError: string | null = null;
  private readonly screenshots = emptyOpStats();
  private readonly reports = emptyOpStats();
  private readonly manuals = emptyOpStats();

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

  /** One bc_screenshot capture (browser-driven, out of band). */
  recordScreenshot(ok: boolean, ms: number): void {
    record(this.screenshots, ok, ms);
  }

  /** One bc_download_report attempt. `ok` = a file was actually captured. */
  recordReportDownload(ok: boolean, ms: number): void {
    record(this.reports, ok, ms);
  }

  /** One bc_build_manual run (its captures are also counted as screenshots). */
  recordManualBuild(ok: boolean, ms: number): void {
    record(this.manuals, ok, ms);
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
      browser: {
        screenshots: { ...this.screenshots },
        reports: { ...this.reports },
        manuals: { ...this.manuals },
      },
    };
  }
}
