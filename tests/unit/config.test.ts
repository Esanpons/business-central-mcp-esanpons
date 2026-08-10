import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/core/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BC_BASE_URL = 'http://test/BC';
    process.env.BC_USERNAME = 'testuser';
    process.env.BC_PASSWORD = 'testpass';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads required values from env', () => {
    const config = loadConfig();
    expect(config.bc.baseUrl).toBe('http://test/BC');
    expect(config.bc.username).toBe('testuser');
    expect(config.bc.password).toBe('testpass');
  });

  it('throws on missing BC_BASE_URL', () => {
    delete process.env.BC_BASE_URL;
    expect(() => loadConfig()).toThrow('BC_BASE_URL');
  });

  it('throws on missing BC_USERNAME', () => {
    delete process.env.BC_USERNAME;
    expect(() => loadConfig()).toThrow('BC_USERNAME');
  });

  it('throws on missing BC_PASSWORD', () => {
    delete process.env.BC_PASSWORD;
    expect(() => loadConfig()).toThrow('BC_PASSWORD');
  });

  it('uses defaults for optional values', () => {
    const config = loadConfig();
    expect(config.bc.tenantId).toBe('default');
    expect(config.bc.clientVersionString).toBe('27.0.0.0');
    expect(config.port).toBe(3000);
    expect(config.logging.level).toBe('info');
  });

  it('strips trailing slashes from BC_BASE_URL', () => {
    process.env.BC_BASE_URL = 'https://demoportaldev.continiaonline.com/eae32d34-6603-4490-b967-0e064de52c3f/';
    expect(loadConfig().bc.baseUrl).toBe('https://demoportaldev.continiaonline.com/eae32d34-6603-4490-b967-0e064de52c3f');
  });

  it('strips multiple trailing slashes from BC_BASE_URL', () => {
    process.env.BC_BASE_URL = 'http://test/BC///';
    expect(loadConfig().bc.baseUrl).toBe('http://test/BC');
  });

  it('rejects a BC_BASE_URL that is not an absolute URL', () => {
    // Without this check the value only fails much later, at the WebSocket
    // upgrade, with a message that never names the env var.
    process.env.BC_BASE_URL = 'devel1/BC';
    expect(() => loadConfig()).toThrow('BC_BASE_URL must be an absolute URL');
  });

  it('rejects a non-http(s) BC_BASE_URL', () => {
    process.env.BC_BASE_URL = 'ftp://devel1/BC';
    expect(() => loadConfig()).toThrow('BC_BASE_URL must use http:// or https://');
  });

  it('accepts https with a non-default port', () => {
    process.env.BC_BASE_URL = 'https://devel1:8443/BC';
    expect(loadConfig().bc.baseUrl).toBe('https://devel1:8443/BC');
  });

  it('BC_TLS_INSECURE defaults to false and is opt-in', () => {
    expect(loadConfig().bc.tlsInsecure).toBe(false);
    process.env.BC_TLS_INSECURE = '1';
    expect(loadConfig().bc.tlsInsecure).toBe(true);
  });

  it('overrides optional values from env', () => {
    process.env.BC_TENANT_ID = 'custom';
    process.env.PORT = '4000';
    process.env.LOG_LEVEL = 'debug';
    const config = loadConfig();
    expect(config.bc.tenantId).toBe('custom');
    expect(config.port).toBe(4000);
    expect(config.logging.level).toBe('debug');
  });
});
