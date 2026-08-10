// Regression cover for the connection layer hardening:
//   - parseSetCookie edge cases (nameless cookie, '=' inside an attribute value)
//   - the WS upgrade always carrying Origin + a browser User-Agent (BC 28.3)
//   - BCWebSocket.forceClose failing pending requests immediately
//   - FormsAuthProvider refusing a sign-in that produced no auth ticket
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSetCookie } from '../../src/connection/auth/cookies.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { FormsAuthProvider } from '../../src/connection/auth/forms-provider.js';
import { createNullLogger } from '../../src/core/logger.js';
import { isErr, isOk } from '../../src/core/result.js';
import type { BCConfig } from '../../src/core/config.js';

describe('parseSetCookie', () => {
  it('keeps the whole value when it contains "="', () => {
    const c = parseSetCookie('.AspNetCore.Cookies=CfDJ8a=b=c; path=/BC; secure; httponly', 'devel1');
    expect(c.name).toBe('.AspNetCore.Cookies');
    expect(c.value).toBe('CfDJ8a=b=c');
    expect(c.path).toBe('/BC');
    expect(c.secure).toBe(true);
    expect(c.httpOnly).toBe(true);
  });

  it('does not truncate a Path attribute containing "="', () => {
    const c = parseSetCookie('SessionId=abc; Path=/tenant/x=y/tab/7', 'host');
    expect(c.path).toBe('/tenant/x=y/tab/7');
  });

  it('handles a nameless cookie without corrupting name/value', () => {
    // No '=' at all: the old slice(0, -1)/slice(0) produced a truncated name AND
    // the full token as value.
    const c = parseSetCookie('justavalue; path=/', 'host');
    expect(c.name).toBe('');
    expect(c.value).toBe('justavalue');
  });

  it('reads sameSite regardless of case and defaults to Lax', () => {
    expect(parseSetCookie('a=b; SameSite=None', 'h').sameSite).toBe('None');
    expect(parseSetCookie('a=b; samesite=strict', 'h').sameSite).toBe('Strict');
    expect(parseSetCookie('a=b', 'h').sameSite).toBe('Lax');
  });
});

function bcConfig(overrides: Partial<BCConfig> = {}): BCConfig {
  return {
    baseUrl: 'https://devel1/BC',
    authMode: 'UserPassword',
    username: 'admin',
    password: 'pw',
    tenantId: 'default',
    profile: '',
    clientVersionString: '27.0.0.0',
    serverMajor: 27,
    applicationId: 'NAV',
    timeoutMs: 1000,
    invokeTimeoutMs: 1000,
    reconnectMaxRetries: 0,
    reconnectBaseDelayMs: 1,
    aadProfileDir: './.state/aad-profile',
    aadTotpSecret: '',
    aadLoginTimeoutMs: 1000,
    tlsInsecure: false,
    ...overrides,
  };
}

function stubProvider(headers: Record<string, string>) {
  return {
    authenticate: vi.fn(),
    getWebSocketHeaders: () => headers,
    getWebSocketQueryParams: () => ({ csrftoken: 'tok' }),
    getCookieJar: () => [],
    getWebSocketUrl: () => null,
    getTenantIdOverride: () => null,
    isAuthenticated: () => true,
    invalidate: () => undefined,
  };
}

describe('ConnectionFactory upgrade headers', () => {
  it('adds Origin (from baseUrl) and a browser User-Agent on-prem', () => {
    const f = new ConnectionFactory(stubProvider({ Cookie: 'a=b' }) as never, bcConfig(), createNullLogger());
    const headers = (f as unknown as { upgradeHeaders(): Record<string, string> }).upgradeHeaders();
    // BC 28.3 RequestOriginValidationMiddleware 403s an upgrade with no Origin.
    expect(headers['Origin']).toBe('https://devel1');
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
    expect(headers['Cookie']).toBe('a=b');
  });

  it('strips the path and keeps a non-default port', () => {
    const f = new ConnectionFactory(
      stubProvider({}) as never,
      bcConfig({ baseUrl: 'http://cronus28:8080/BC' }),
      createNullLogger(),
    );
    const headers = (f as unknown as { upgradeHeaders(): Record<string, string> }).upgradeHeaders();
    expect(headers['Origin']).toBe('http://cronus28:8080');
  });

  it('never overrides an Origin/User-Agent the provider already set (SaaS)', () => {
    const f = new ConnectionFactory(
      stubProvider({ Origin: 'https://businesscentral.dynamics.com', 'User-Agent': 'RealChrome' }) as never,
      bcConfig(),
      createNullLogger(),
    );
    const headers = (f as unknown as { upgradeHeaders(): Record<string, string> }).upgradeHeaders();
    expect(headers['Origin']).toBe('https://businesscentral.dynamics.com');
    expect(headers['User-Agent']).toBe('RealChrome');
  });
});

describe('BCWebSocket.forceClose', () => {
  it('fails pending requests immediately and reports disconnected', async () => {
    const ws = new BCWebSocket(createNullLogger());
    const fake = { readyState: 1, send: vi.fn(), close: vi.fn(), terminate: vi.fn() };
    (ws as unknown as { ws: unknown }).ws = fake;

    const pending = ws.sendRpc('Invoke', [{}], 60000);
    expect(ws.isConnected).toBe(true);

    ws.forceClose();

    const result = await pending;
    // The pending RPC does NOT wait for a 'close' event that a half-open socket
    // may never deliver.
    expect(isErr(result)).toBe(true);
    expect(ws.isConnected).toBe(false);
    expect(fake.close).toHaveBeenCalled();
  });
});

describe('FormsAuthProvider sign-in', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function loginPage(): string {
    return '<html><form><input name="__RequestVerificationToken" value="VTOKEN"/></form></html>';
  }

  function response(opts: { status: number; body?: string; setCookie?: string[]; location?: string }): Response {
    const headers = new Headers();
    if (opts.location) headers.set('location', opts.location);
    return {
      status: opts.status,
      headers: {
        getSetCookie: () => opts.setCookie ?? [],
        get: (n: string) => headers.get(n),
      },
      text: async () => opts.body ?? '',
    } as unknown as Response;
  }

  it('authenticates when BC sets the .AspNetCore.Cookies auth ticket', async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
      (init?.method === 'POST'
        ? response({
            status: 302,
            location: '/BC/',
            setCookie: ['.AspNetCore.Cookies=CfDJ8ticket; path=/BC; secure; httponly'],
          })
        : response({
            status: 200,
            body: loginPage(),
            setCookie: ['.AspNetCore.Antiforgery.abc=CfDJ8csrf; path=/BC'],
          }))) as unknown as typeof fetch;

    const p = new FormsAuthProvider(
      { baseUrl: 'https://devel1/BC', username: 'admin', password: 'pw', tenantId: 'default' },
      createNullLogger(),
    );
    const r = await p.authenticate();
    expect(isOk(r)).toBe(true);
    expect(p.isAuthenticated()).toBe(true);
    if (isOk(r)) expect(r.value.csrfToken).toBe('CfDJ8csrf');
  });

  it('rejects a 302 that carries no auth ticket instead of reporting success', async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
      (init?.method === 'POST'
        ? response({ status: 302, location: '/BC/SignIn?error=1' })
        : response({
            status: 200,
            body: loginPage(),
            setCookie: ['.AspNetCore.Antiforgery.abc=CfDJ8csrf; path=/BC'],
          }))) as unknown as typeof fetch;

    const p = new FormsAuthProvider(
      { baseUrl: 'https://devel1/BC', username: 'admin', password: 'bad', tenantId: 'default' },
      createNullLogger(),
    );
    const r = await p.authenticate();
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.message).toContain('without establishing a session');
      expect(r.error.message).toContain('/BC/SignIn?error=1');
    }
    expect(p.isAuthenticated()).toBe(false);
  });

  it('rejects a 200 re-render of the login page (wrong password)', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        status: 200,
        body: loginPage(),
        setCookie: ['.AspNetCore.Antiforgery.abc=CfDJ8csrf; path=/BC'],
      })) as unknown as typeof fetch;

    const p = new FormsAuthProvider(
      { baseUrl: 'https://devel1/BC', username: 'admin', password: 'bad', tenantId: 'default' },
      createNullLogger(),
    );
    const r = await p.authenticate();
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toContain('Invalid username or password');
  });
});
