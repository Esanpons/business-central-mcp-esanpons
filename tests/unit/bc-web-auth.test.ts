// tests/unit/bc-web-auth.test.ts
import { describe, it, expect } from 'vitest';
import {
  deepLinkPage, deepLinkReport, parseSetCookie, waitReady, detectErrorPage,
  detectLoginWall, looksLikeBusinessCentral, detectModalDialog,
} from '../../src/services/bc-web-auth.js';
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

describe('detectLoginWall', () => {
  // F-10: only BC's own /SignIn was recognised, so an expired SaaS browser session
  // landed on Microsoft Entra, was judged "not a login page", and the capture came
  // back successful — with `authenticated: true` — showing Microsoft's login form.
  const page = (url: string, dom: 'entra' | 'bc-forms' | null = null) => ({
    url: () => url,
    evaluate: () => Promise.resolve(dom),
  });

  it('recognises the Microsoft Entra sign-in host', async () => {
    const p = page('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=...');
    expect(await detectLoginWall(p)).toBe('entra');
  });

  it('recognises Entra by its account field when the URL says nothing', async () => {
    expect(await detectLoginWall(page('https://businesscentral.dynamics.com/', 'entra'))).toBe('entra');
  });

  it('still recognises BC on-prem forms login', async () => {
    expect(await detectLoginWall(page('https://devel1/BC/SignIn?ReturnUrl=%2FBC'))).toBe('bc-forms');
    expect(await detectLoginWall(page('https://devel1/BC/', 'bc-forms'))).toBe('bc-forms');
  });

  it('reads Entra first when a BC ReturnUrl carrying "SignIn" is inside the Entra URL', async () => {
    const p = page('https://login.microsoftonline.com/x/oauth2/authorize?redirect_uri=https%3A%2F%2Fdevel1%2FBC%2FSignIn');
    expect(await detectLoginWall(p)).toBe('entra');
  });

  it('is quiet on a real BC page', async () => {
    expect(await detectLoginWall(page('https://devel1/BC/?page=21&tenant=default'))).toBeUndefined();
  });
});

describe('looksLikeBusinessCentral', () => {
  const framePage = (frames: boolean[]) => ({
    frames: () => frames.map(hit => ({ evaluate: () => Promise.resolve(hit) })),
  });

  it('is true when any frame carries the client chrome classes', async () => {
    expect(await looksLikeBusinessCentral(framePage([false, true]))).toBe(true);
  });

  it('is false when no frame does (a login form, an error host page)', async () => {
    expect(await looksLikeBusinessCentral(framePage([false, false]))).toBe(false);
  });
});

describe('detectModalDialog', () => {
  // F-9: a bookmark from another table makes BC answer with a modal explaining the
  // refusal. The capture photographed that modal and reported success.
  const framePage = (frames: Array<string | null>) => ({
    frames: () => frames.map(text => ({ evaluate: () => Promise.resolve(text) })),
  });

  it('returns the dialog text', async () => {
    const msg = "No se puede utilizar un RecordID de la tabla 'Histórico cab. albarán venta'...";
    expect(await detectModalDialog(framePage([null, msg]))).toBe(msg);
  });

  it('is quiet when no dialog is on screen', async () => {
    expect(await detectModalDialog(framePage([null, null]))).toBeUndefined();
  });

  it('truncates a very long dialog', async () => {
    const long = 'x'.repeat(500);
    const r = await detectModalDialog(framePage([long]));
    expect(r).toHaveLength(303);
    expect(r?.endsWith('...')).toBe(true);
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
