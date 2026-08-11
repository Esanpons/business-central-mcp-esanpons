// tests/unit/bc-web-auth.test.ts
import { describe, it, expect } from 'vitest';
import { deepLinkPage, deepLinkReport, parseSetCookie, waitReady, detectErrorPage } from '../../src/services/bc-web-auth.js';
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

  // BC reads the query value literally: a company encoded the form way ("CRONUS+ES")
  // is looked up as a company whose name contains a '+', and every capture came back
  // as BC's "Could not open the company" page. Nearly every install has a space in a
  // company name (CRONUS ES, My Company), so this broke captures and manuals wholesale.
  it('encodes a space in the company name as %20, never as +', () => {
    const url = deepLinkPage(config, '50002', undefined, 'CRONUS ES');
    expect(url).toContain('company=CRONUS%20ES');
    expect(url).not.toContain('+');
  });

  it('percent-encodes a bookmark without turning its characters into a space', () => {
    const url = deepLinkPage(config, '132', 'a+b/c=d', 'My Company');
    expect(url).toContain('bookmark=a%2Bb%2Fc%3Dd');
    expect(url).toContain('company=My%20Company');
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
  it('encodes a space in the company name as %20, never as +', () => {
    expect(deepLinkReport(config, '6', 'CRONUS ES')).toContain('company=CRONUS%20ES');
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

describe('detectErrorPage', () => {
  // Body classes and text captured live from devel1 (page 21 opened with a company
  // BC cannot resolve): the host frame gets `has-error-in-child`, the frame that
  // renders the message gets `has-error`.
  const framePage = (frames: Array<{ cls: string; text: string }>) => ({
    frames: () => frames.map(f => ({ evaluate: () => Promise.resolve(f) })),
  });

  it('returns the CHILD frame message, not the host frame placeholder', async () => {
    const p = framePage([
      { cls: 'has-error-in-child', text: "We had trouble completing the request. Let's try again.\nRetry" },
      { cls: 'ms-dyn365-fin chrome mouse has-error', text: "Could not open the company.\nNo se pudo abrir la empresa 'CRONUS ES'.\nGo back home" },
    ]);
    expect(await detectErrorPage(p)).toMatch(/Could not open the company/);
  });

  it('falls back to the host frame when only it reports an error', async () => {
    const p = framePage([{ cls: 'has-error-in-child', text: 'We had trouble completing the request.' }]);
    expect(await detectErrorPage(p)).toMatch(/trouble completing/);
  });

  it('is quiet on a healthy page', async () => {
    const p = framePage([{ cls: 'ms-dyn365-fin chrome mouse', text: 'Customer Card\nNo.\nName' }]);
    expect(await detectErrorPage(p)).toBeUndefined();
  });

  it('does not flag a long page that merely contains the words "go back home"', async () => {
    const p = framePage([{ cls: 'ms-dyn365-fin', text: `Notes\n${'go back home '.repeat(80)}` }]);
    expect(await detectErrorPage(p)).toBeUndefined();
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
