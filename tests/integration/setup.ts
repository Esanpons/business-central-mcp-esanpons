// Loaded by vitest.integration.config.ts before any integration suite.
//
// The suites each call loadConfig(), which requires BC_BASE_URL/BC_USERNAME/…
// Historically they relied on a bare `dotenv()` picking up a root `.env`, so on a
// machine that keeps its credentials in `.secrets/` (this fork does — see CLAUDE.md)
// every suite died in beforeAll with "Required environment variable ... is not set",
// which reads like a broken test and is really a missing file.
//
// Precedence: real environment > .env > .secrets/devel1.env. Nothing here overrides
// a variable that is already set, so CI (which exports them) is unaffected.
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const file of ['.env', '.secrets/devel1.env']) {
  const path = resolve(repoRoot, file);
  if (existsSync(path)) dotenv({ path });
}

if (!process.env.BC_BASE_URL) {
  // Fail with the fix, not with a bare variable name.
  throw new Error(
    'Integration tests need BC credentials. Create .secrets/devel1.env (BC_BASE_URL, BC_USERNAME, '
    + 'BC_PASSWORD, BC_TENANT_ID, NODE_TLS_REJECT_UNAUTHORIZED=0) or export those variables.',
  );
}
