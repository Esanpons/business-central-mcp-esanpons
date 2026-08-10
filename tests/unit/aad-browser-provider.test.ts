import { describe, it, expect } from 'vitest';
import { AADBrowserAuthProvider } from '../../src/connection/auth/aad-browser-provider.js';
import { createNullLogger } from '../../src/core/logger.js';

const cfg = {
  baseUrl: 'https://businesscentral.dynamics.com/2c43eb40-4e62-4039-8a43-8a75f7323032/Dev',
  username: '',
  password: '',
  profileDir: './.state/aad-profile',
  totpSecret: '',
  loginTimeoutMs: 1000,
};

describe('AADBrowserAuthProvider (contract)', () => {
  it('starts unauthenticated with empty jar and no discovered URL/tenant', () => {
    const p = new AADBrowserAuthProvider(cfg, createNullLogger());
    expect(p.isAuthenticated()).toBe(false);
    expect(p.getCookieJar()).toEqual([]);
    expect(p.getWebSocketUrl()).toBeNull();
    expect(p.getTenantIdOverride()).toBeNull();
    // Origin is always set (backend gateway enforces it); csrf query params empty pre-auth.
    expect(p.getWebSocketHeaders()).toEqual({ Cookie: '', Origin: 'https://businesscentral.dynamics.com' });
    expect(p.getWebSocketQueryParams()).toEqual({});
  });

  it('invalidate() resets state (persistent profile is kept on disk)', () => {
    const p = new AADBrowserAuthProvider(cfg, createNullLogger());
    p.invalidate();
    expect(p.isAuthenticated()).toBe(false);
    expect(p.getCookieJar()).toEqual([]);
    expect(p.getWebSocketUrl()).toBeNull();
    expect(p.getTenantIdOverride()).toBeNull();
  });

  it('reports that SaaS queries must omit &tenant=', () => {
    const p = new AADBrowserAuthProvider(cfg, createNullLogger());
    expect(p.omitsTenantInQueries()).toBe(true);
  });

  it('invalidate() retains the browser-close promise so the next launch can await it', async () => {
    const p = new AADBrowserAuthProvider(cfg, createNullLogger());
    let closed = false;
    let release: (() => void) | null = null;
    // Stand in for the kept-alive puppeteer browser.
    (p as unknown as { browser: unknown }).browser = {
      close: () => new Promise<void>((r) => { release = () => { closed = true; r(); }; }),
    };

    p.invalidate();
    const closing = (p as unknown as { closing: Promise<void> | null }).closing;
    // Dropping this promise (the old fire-and-forget) let the next
    // launchPersistent race the still-open browser for the profile-dir lock.
    expect(closing).toBeInstanceOf(Promise);
    expect(closed).toBe(false);
    release!();
    await closing;
    expect(closed).toBe(true);
  });
});
