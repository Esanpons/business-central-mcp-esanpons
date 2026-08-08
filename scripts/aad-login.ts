// scripts/aad-login.ts  (npm run login:aad)
//
// Interactive one-shot bootstrap for BC Online (SaaS) auth. Opens a VISIBLE
// browser bound to the persistent AAD profile (BC_AAD_PROFILE_DIR); you complete
// the Entra login + MFA by hand. The SSO cookies then persist in the profile so
// the server's AADBrowserAuthProvider re-authenticates headless and silently.
//
// Run when: first-time setup, or after Entra expires the persisted session and a
// headless re-auth fails with an "interaction required" style error.
//
// Usage:
//   set BC_AUTH=AAD
//   set BC_BASE_URL=https://businesscentral.dynamics.com/<aadTenantId>/<environment>
//   npm run login:aad

import { config as dotenv } from 'dotenv';
import { existsSync } from 'node:fs';

if (existsSync('.secrets/saas.env')) dotenv({ path: '.secrets/saas.env' });
else dotenv();

process.env.BC_AUTH = 'AAD';

import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { AADBrowserAuthProvider } from '../src/connection/auth/aad-browser-provider.js';
import { isErr } from '../src/core/result.js';

const cfg = loadConfig();
const logger = createLogger({ ...cfg.logging, level: 'info' });

const provider = new AADBrowserAuthProvider({
  baseUrl: cfg.bc.baseUrl,
  username: cfg.bc.username,
  password: cfg.bc.password,
  profileDir: cfg.bc.aadProfileDir,
  totpSecret: cfg.bc.aadTotpSecret,
  loginTimeoutMs: Math.max(cfg.bc.aadLoginTimeoutMs, 300000),
}, logger);

console.log('[login:aad] target :', cfg.bc.baseUrl);
console.log('[login:aad] profile:', cfg.bc.aadProfileDir);
console.log('[login:aad] A browser window will open. Sign in + complete MFA. It closes on success.\n');

const result = await provider.bootstrap();
if (isErr(result)) {
  console.error('\n[login:aad] FAILED:', result.error.message);
  process.exit(1);
}
console.log(`\n[login:aad] OK — captured ${result.value.cookieJar.length} BC cookies; profile is warm.`);
console.log('[login:aad] You can now run the server with BC_AUTH=AAD (headless re-auth will reuse this profile).');
process.exit(0);
