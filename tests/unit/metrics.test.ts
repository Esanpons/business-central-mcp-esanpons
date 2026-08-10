// tests/unit/metrics.test.ts
//
// bc_health / GET /health serialize this snapshot verbatim, so its SHAPE is the
// contract. The browser block was added because screenshots, report downloads and
// manual builds are the slowest and flakiest things the server does and none of
// them touched a counter — they were invisible in health output.

import { describe, it, expect } from 'vitest';
import { Metrics } from '../../src/services/metrics.js';

describe('Metrics -- existing counters (unchanged shape)', () => {
  it('counts invokes, errors by code, reconnects and sessions', () => {
    const m = new Metrics();
    m.recordInvoke();
    m.recordInvoke();
    m.recordError('SESSION_LOST', 'boom');
    m.recordError('SESSION_LOST');
    m.recordError('TIMEOUT');
    m.recordReconnect();
    m.recordSessionCreated();

    const s = m.snapshot();
    expect(s.invokes).toBe(2);
    expect(s.errors).toBe(3);
    expect(s.errorsByCode).toEqual({ SESSION_LOST: 2, TIMEOUT: 1 });
    expect(s.reconnects).toBe(1);
    expect(s.sessionsCreated).toBe(1);
    expect(s.lastError).toBe('boom');
    expect(s.sessionUptimeSeconds).not.toBeNull();
  });

  it('reports a null session uptime before any session exists', () => {
    const s = new Metrics().snapshot();
    expect(s.sessionCreatedAt).toBeNull();
    expect(s.sessionUptimeSeconds).toBeNull();
  });
});

describe('Metrics -- browser operations', () => {
  it('starts at zero for every browser-driven operation', () => {
    const b = new Metrics().snapshot().browser;
    for (const k of ['screenshots', 'reports', 'manuals'] as const) {
      expect(b[k]).toEqual({ ok: 0, failed: 0, totalMs: 0, lastMs: null });
    }
  });

  it('separates successes from failures and accumulates duration', () => {
    const m = new Metrics();
    m.recordScreenshot(true, 4200);
    m.recordScreenshot(false, 800);
    const s = m.snapshot().browser.screenshots;
    expect(s.ok).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.totalMs).toBe(5000);
    expect(s.lastMs).toBe(800);
  });

  it('keeps the three operation kinds independent', () => {
    const m = new Metrics();
    m.recordReportDownload(true, 30000);
    m.recordManualBuild(false, 12000);
    const b = m.snapshot().browser;
    expect(b.reports.ok).toBe(1);
    expect(b.manuals.failed).toBe(1);
    expect(b.screenshots.ok).toBe(0);
  });

  it('never lets a negative or fractional duration leak into the counters', () => {
    const m = new Metrics();
    m.recordScreenshot(true, -5);
    m.recordScreenshot(true, 10.6);
    const s = m.snapshot().browser.screenshots;
    expect(s.totalMs).toBe(11);
    expect(s.lastMs).toBe(11);
  });

  it('returns a snapshot COPY, so a later record cannot mutate one already handed out', () => {
    const m = new Metrics();
    const before = m.snapshot();
    m.recordScreenshot(true, 100);
    expect(before.browser.screenshots.ok).toBe(0);
    expect(m.snapshot().browser.screenshots.ok).toBe(1);
  });
});
