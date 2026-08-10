export type BCAuthMode = 'UserPassword' | 'AAD';

export interface BCConfig {
  baseUrl: string;
  /** Auth mode: `UserPassword` = on-prem forms /SignIn (default); `AAD` = BC Online via Entra browser login. */
  authMode: BCAuthMode;
  username: string;
  password: string;
  tenantId: string;
  profile: string;
  clientVersionString: string;
  serverMajor: number;
  applicationId: string;
  timeoutMs: number;
  invokeTimeoutMs: number;
  reconnectMaxRetries: number;
  reconnectBaseDelayMs: number;
  /** AAD only: persistent browser-profile dir holding the Entra SSO session. */
  aadProfileDir: string;
  /** AAD only: base32 TOTP secret for unattended MFA (empty = interactive bootstrap). */
  aadTotpSecret: string;
  /** AAD only: ms budget for the OIDC login dance. */
  aadLoginTimeoutMs: number;
  /**
   * `BC_TLS_INSECURE=1` -- accept a self-signed / untrusted BC certificate for the
   * connections bc-mcp makes to the BC host ONLY (the WebSocket upgrade and the
   * auth provider's /SignIn fetches), instead of disabling certificate validation
   * for the whole Node process with `NODE_TLS_REJECT_UNAUTHORIZED=0`.
   * The global env var keeps working and still wins (it is process-wide).
   */
  tlsInsecure: boolean;
}

export interface LoggingConfig {
  level: string;
  channels: string;
  dir: string;
  redactValues: boolean;
}

export interface ServerConfig {
  bindAddress: string;
  diagnosticsEnabled: boolean;
  apiToken?: string;
}

export interface AppConfig {
  bc: BCConfig;
  logging: LoggingConfig;
  server: ServerConfig;
  port: number;
  stateDir: string;
  screenshotDir: string;
  manualDir: string;
  reportDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set. See .env.example for configuration.`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalEnvInt(name: string, fallback: number, opts?: { min?: number }): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`${name} must be an integer, got: ${raw}`);
  // Guard against nonsensical values: a zero/negative timeout would fire every
  // operation's deadline immediately; a negative retry count disables recovery.
  if (opts?.min !== undefined && parsed < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}, got: ${parsed}`);
  }
  return parsed;
}

function optionalEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === 'true' || raw === '1';
}

/**
 * BC_BASE_URL must be an absolute http(s) URL. Without this check a malformed
 * value (missing scheme, a stray quote, a Windows path) only fails much later --
 * at the WebSocket upgrade or inside `new URL()` in the screenshot/deep-link
 * paths -- with an opaque message that never names the env var.
 */
function requireUrlEnv(name: string): string {
  const raw = requireEnv(name).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL like https://host/BC, got: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http:// or https://, got: ${raw}`);
  }
  if (!parsed.host) {
    throw new Error(`${name} must include a host, got: ${raw}`);
  }
  return raw;
}

export function loadConfig(): AppConfig {
  const bindAddress = optionalEnv('BIND_ADDRESS', '127.0.0.1');
  const apiToken = process.env.API_TOKEN;

  if (bindAddress !== '127.0.0.1' && bindAddress !== 'localhost' && !apiToken) {
    throw new Error('API_TOKEN is required when BIND_ADDRESS is non-loopback');
  }

  const authMode = optionalEnv('BC_AUTH', 'UserPassword');
  if (authMode !== 'UserPassword' && authMode !== 'AAD') {
    throw new Error(`BC_AUTH must be "UserPassword" or "AAD", got: ${authMode}`);
  }

  return {
    bc: {
      baseUrl: requireUrlEnv('BC_BASE_URL'),
      authMode,
      // Credentials are mandatory only for the forms login. In AAD mode they are
      // optional (headless Entra login); without them the AAD provider falls back
      // to the persisted browser profile bootstrapped via `npm run login:aad`.
      username: authMode === 'UserPassword' ? requireEnv('BC_USERNAME') : optionalEnv('BC_USERNAME', ''),
      password: authMode === 'UserPassword' ? requireEnv('BC_PASSWORD') : optionalEnv('BC_PASSWORD', ''),
      tenantId: optionalEnv('BC_TENANT_ID', 'default'),
      profile: optionalEnv('BC_PROFILE', ''),
      clientVersionString: optionalEnv('BC_CLIENT_VERSION', '27.0.0.0'),
      serverMajor: optionalEnvInt('BC_SERVER_MAJOR', 27),
      // OpenSession applicationId. On-prem BC 27 expects NAV; BC Online (SaaS) sends
      // FIN (confirmed by the F2 spike). Explicit BC_APPLICATION_ID always wins.
      applicationId: optionalEnv('BC_APPLICATION_ID', authMode === 'AAD' ? 'FIN' : 'NAV'),
      timeoutMs: optionalEnvInt('BC_TIMEOUT', 120000, { min: 1 }),
      invokeTimeoutMs: optionalEnvInt('BC_INVOKE_TIMEOUT', 30000, { min: 1 }),
      reconnectMaxRetries: optionalEnvInt('BC_RECONNECT_MAX_RETRIES', 6, { min: 0 }),
      reconnectBaseDelayMs: optionalEnvInt('BC_RECONNECT_BASE_DELAY', 2000, { min: 1 }),
      aadProfileDir: optionalEnv('BC_AAD_PROFILE_DIR', './.state/aad-profile'),
      aadTotpSecret: optionalEnv('BC_AAD_TOTP_SECRET', ''),
      aadLoginTimeoutMs: optionalEnvInt('BC_AAD_LOGIN_TIMEOUT', 120000, { min: 1 }),
      // Per-connection TLS opt-out for a self-signed on-prem BC. Prefer this over
      // NODE_TLS_REJECT_UNAUTHORIZED=0, which turns certificate validation off for
      // every TLS socket the process opens (including unrelated HTTP clients).
      tlsInsecure: optionalEnvBool('BC_TLS_INSECURE', false),
    },
    logging: {
      level: optionalEnv('LOG_LEVEL', 'info'),
      channels: optionalEnv('LOG_CHANNELS', ''),
      dir: optionalEnv('LOG_DIR', './logs'),
      redactValues: optionalEnvBool('LOG_REDACT_VALUES', false),
    },
    server: {
      bindAddress,
      diagnosticsEnabled: optionalEnvBool('DIAGNOSTICS_ENABLED', false),
      apiToken,
    },
    port: optionalEnvInt('PORT', 3000),
    stateDir: optionalEnv('STATE_DIR', './.state'),
    screenshotDir: optionalEnv('BC_SCREENSHOT_DIR', './screenshots'),
    manualDir: optionalEnv('BC_MANUAL_DIR', './manuals'),
    reportDir: optionalEnv('BC_REPORT_DIR', '.arxius/reports'),
  };
}
