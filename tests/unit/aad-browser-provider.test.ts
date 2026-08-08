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
});
