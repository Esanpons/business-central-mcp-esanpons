import type { BCConfig } from '../../core/config.js';
import type { Logger } from '../../core/logger.js';
import type { IBCAuthProvider } from './auth-provider.js';
import { FormsAuthProvider } from './forms-provider.js';
import { AADBrowserAuthProvider } from './aad-browser-provider.js';

/**
 * Selects the auth provider for `BC_AUTH`. `UserPassword` (default) is the
 * on-prem/Docker forms login — behavior identical to before this factory
 * existed. `AAD` (BC Online / SaaS) drives an Entra browser login.
 * See docs/SAAS-EVIDENCE.md (discovery) and CLAUDE.md "Authentication modes".
 */
export function createAuthProvider(bc: BCConfig, logger: Logger): IBCAuthProvider {
  if (bc.authMode === 'AAD') {
    return new AADBrowserAuthProvider({
      baseUrl: bc.baseUrl,
      username: bc.username,
      password: bc.password,
      profileDir: bc.aadProfileDir,
      totpSecret: bc.aadTotpSecret,
      loginTimeoutMs: bc.aadLoginTimeoutMs,
    }, logger);
  }
  return new FormsAuthProvider({
    baseUrl: bc.baseUrl,
    username: bc.username,
    password: bc.password,
    tenantId: bc.tenantId,
    tlsInsecure: bc.tlsInsecure,
  }, logger);
}
