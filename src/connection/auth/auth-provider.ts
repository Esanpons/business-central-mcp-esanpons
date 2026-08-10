import type { Result } from '../../core/result.js';
import type { AuthenticationError } from '../../core/errors.js';
import type { RawCookie } from './cookies.js';

export interface AuthResult {
  /** `Cookie` header string for the WebSocket upgrade. */
  cookies: string;
  csrfToken: string;
  /** Attributed jar (path/secure/samesite/httponly) for headless-browser injection. */
  cookieJar: RawCookie[];
}

export interface IBCAuthProvider {
  authenticate(): Promise<Result<AuthResult, AuthenticationError>>;
  getWebSocketHeaders(): Record<string, string>;
  getWebSocketQueryParams(): Record<string, string>;
  /** Attributed cookie jar from the last authenticate(); empty when not authenticated. */
  getCookieJar(): RawCookie[];
  /**
   * Full WebSocket URL to connect to, or null to let ConnectionFactory build the
   * default `{baseUrl}/csh?...`. On-prem returns null; BC Online (SaaS) returns the
   * server-assigned backend URL discovered during authenticate()
   * (`wss://{backendHost}/tenant/{backendTenant}/tab/{tabId}/csh?...`), which cannot
   * be derived from baseUrl.
   */
  getWebSocketUrl(): string | null;
  /**
   * OpenSession tenantId override, or null to use the configured BC_TENANT_ID.
   * SaaS returns the backend tenant id discovered from the WS URL path.
   */
  getTenantIdOverride(): string | null;
  /**
   * True when OpenForm-style WS queries must NOT carry `&tenant=` -- SaaS binds
   * the tenant at session open and rejects the parameter, on-prem requires it.
   * Optional so any provider that predates this stays valid (treated as false).
   * `SessionFactory` reads it to configure `BCSession.runReport`, mirroring how
   * `PageService` learns the mode from the config.
   */
  omitsTenantInQueries?(): boolean;
  isAuthenticated(): boolean;
  /** Descarta cookies/CSRF i el flag d'auth per forçar un /SignIn fresc al següent connect (recovery post-publish). */
  invalidate(): void;
}
