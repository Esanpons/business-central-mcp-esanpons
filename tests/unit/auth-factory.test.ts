import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuthProvider } from '../../src/connection/auth/factory.js';
import { FormsAuthProvider } from '../../src/connection/auth/forms-provider.js';
import { AADBrowserAuthProvider } from '../../src/connection/auth/aad-browser-provider.js';
import { createNullLogger } from '../../src/core/logger.js';
import { loadConfig, type BCConfig } from '../../src/core/config.js';

const bc = (over: Partial<BCConfig> = {}): BCConfig => ({
  baseUrl: 'https://devel1/BC',
  authMode: 'UserPassword',
  username: 'admin',
  password: 'x',
  tenantId: 'default',
  profile: '',
  clientVersionString: '27.0.0.0',
  serverMajor: 27,
  applicationId: 'NAV',
  timeoutMs: 1000,
  invokeTimeoutMs: 1000,
  reconnectMaxRetries: 0,
  reconnectBaseDelayMs: 1,
  ...over,
});

describe('createAuthProvider', () => {
  it('returns FormsAuthProvider for UserPassword (default) mode', () => {
    const p = createAuthProvider(bc(), createNullLogger());
    expect(p).toBeInstanceOf(FormsAuthProvider);
    expect(p.isAuthenticated()).toBe(false);
    expect(p.getCookieJar()).toEqual([]);
  });

  it('returns AADBrowserAuthProvider for AAD mode', () => {
    const p = createAuthProvider(bc({ authMode: 'AAD' }), createNullLogger());
    expect(p).toBeInstanceOf(AADBrowserAuthProvider);
    expect(p.isAuthenticated()).toBe(false);
    expect(p.getCookieJar()).toEqual([]);
  });
});

describe('loadConfig BC_AUTH', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['BC_AUTH', 'BC_BASE_URL', 'BC_USERNAME', 'BC_PASSWORD'];

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; }
    process.env.BC_BASE_URL = 'https://example/BC';
    process.env.BC_USERNAME = 'u';
    process.env.BC_PASSWORD = 'p';
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to UserPassword and keeps credentials mandatory', () => {
    delete process.env.BC_AUTH;
    expect(loadConfig().bc.authMode).toBe('UserPassword');
    delete process.env.BC_USERNAME;
    expect(() => loadConfig()).toThrow(/BC_USERNAME/);
  });

  it('rejects unknown BC_AUTH values', () => {
    process.env.BC_AUTH = 'OAuth';
    expect(() => loadConfig()).toThrow(/BC_AUTH must be/);
  });

  it('AAD mode makes credentials optional', () => {
    process.env.BC_AUTH = 'AAD';
    delete process.env.BC_USERNAME;
    delete process.env.BC_PASSWORD;
    const cfg = loadConfig();
    expect(cfg.bc.authMode).toBe('AAD');
    expect(cfg.bc.username).toBe('');
    expect(cfg.bc.password).toBe('');
  });
});
