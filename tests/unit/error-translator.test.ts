import { describe, it, expect } from 'vitest';
import { translateBcError } from '../../src/core/error-translator.js';

describe('translateBcError', () => {
  it('maps modal violation to a clear MODAL_STUCK message', () => {
    const t = translateBcError('JSON-RPC error: {"message":"Microsoft.Dynamics.Framework.UI.LogicalModalityViolationException ..."}');
    expect(t.code).toBe('MODAL_STUCK');
    expect(t.message).toMatch(/dialog/i);
    expect(t.message).toMatch(/re-open/i);
  });

  it('maps InvalidSessionException to SESSION_LOST', () => {
    expect(translateBcError('... InvalidSessionException ...').code).toBe('SESSION_LOST');
  });

  it('maps JSON-RPC code 1 to SESSION_LOST', () => {
    expect(translateBcError('JSON-RPC error: {"code":1,"message":"x"}').code).toBe('SESSION_LOST');
  });

  it('maps NavCancelCredentialPromptException with an applicationId hint', () => {
    const t = translateBcError('Microsoft.Dynamics.Nav.Types.NavCancelCredentialPromptException');
    expect(t.code).toBe('AUTH_APPLICATION_ID');
    expect(t.message).toMatch(/BC_APPLICATION_ID/);
  });

  it('maps connection refused to CONNECTION with a reachability hint', () => {
    const t = translateBcError('connect ECONNREFUSED 127.0.0.1:443');
    expect(t.code).toBe('CONNECTION');
    expect(t.message).toMatch(/reachable|running/i);
  });

  it('maps self-signed cert errors to TLS', () => {
    expect(translateBcError('DEPTH_ZERO_SELF_SIGNED_CERT').code).toBe('TLS');
  });

  it('maps timeouts to TIMEOUT', () => {
    expect(translateBcError('Invoke timed out after 30000ms').code).toBe('TIMEOUT');
  });

  it('extracts the inner exception message for unknown errors', () => {
    const t = translateBcError('JSON-RPC error: {"code":7,"message":"env","data":{"exceptionMessage":"Page 99999 does not exist"}}');
    expect(t.code).toBe('BC_ERROR');
    expect(t.message).toBe('Page 99999 does not exist');
  });

  it('falls back to the raw string when nothing matches', () => {
    expect(translateBcError('some plain text').message).toBe('some plain text');
  });
});
