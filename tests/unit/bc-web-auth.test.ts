// tests/unit/bc-web-auth.test.ts
import { describe, it, expect } from 'vitest';
import { deepLinkPage, deepLinkReport, parseSetCookie, waitReady } from '../../src/services/bc-web-auth.js';
import type { BCConfig } from '../../src/core/config.js';

const config = { baseUrl: 'https://devel1/BC', tenantId: 'default' } as BCConfig;

/** A puppeteer-ish page whose readiness probe answers with a canned state. */
function fakePage(state: { spinnerVisible: boolean; generic: boolean }): { evaluate: () => Promise<typeof state> } {
  return { evaluate: () => Promise.resolve(state) };
}

describe('deepLinkPage', () => {
  it('builds a page deep link with tenant, company and bookmark', () => {
    const url = deepLinkPage(config, '21', 'BM1', 'CRONUS');
    expect(url).toContain('https://devel1/BC/?');
    expect(url).toContain('page=21');
    expect(url).toContain('tenant=default');
    expect(url).toContain('company=CRONUS');
    expect(url).toContain('bookmark=BM1');
  });
  it('never includes runinframe (it hangs the load)', () => {
    expect(deepLinkPage(config, '21')).not.toContain('runinframe');
  });
});

describe('deepLinkReport', () => {
  it('uses report=<id> like the WebSocket runReport', () => {
    const url = deepLinkReport(config, '6', 'CRONUS');
    expect(url).toContain('report=6');
    expect(url).toContain('tenant=default');
    expect(url).toContain('company=CRONUS');
  });
  it('omits company when not given', () => {
    expect(deepLinkReport(config, '6')).not.toContain('company=');
  });
});

describe('waitReady', () => {
  it('reports ready and settles when the SPA has a real page title and no spinner', async () => {
    const r = await waitReady(fakePage({ spinnerVisible: false, generic: false }), { timeoutMs: 5000, settleMs: 10 });
    expect(r).toBe(true);
  });

  it('does NOT pay the settle wait after a timed-out poll', async () => {
    // A report request page keeps the generic title forever, so this path is the
    // common one; the trailing settle used to make every not-ready call slower for
    // nothing (it was the bulk of a ~97s report download).
    const t0 = Date.now();
    const r = await waitReady(fakePage({ spinnerVisible: false, generic: true }), { timeoutMs: 10, settleMs: 4000 });
    expect(r).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('treats a visible spinner as not-ready', async () => {
    const r = await waitReady(fakePage({ spinnerVisible: true, generic: false }), { timeoutMs: 10, settleMs: 4000 });
    expect(r).toBe(false);
  });
});

describe('parseSetCookie', () => {
  it('parses name, value and attributes', () => {
    const c = parseSetCookie('.AspNetCore.Cookies=abc123; path=/BC; secure; samesite=none; httponly', 'devel1');
    expect(c).toMatchObject({
      name: '.AspNetCore.Cookies', value: 'abc123', domain: 'devel1',
      path: '/BC', secure: true, httpOnly: true, sameSite: 'None',
    });
  });
  it('defaults path to / and sameSite to Lax', () => {
    const c = parseSetCookie('SessionId=xyz', 'devel1');
    expect(c).toMatchObject({ name: 'SessionId', value: 'xyz', path: '/', secure: false, httpOnly: false, sameSite: 'Lax' });
  });
});
