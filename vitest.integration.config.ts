import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60000,
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['tests/integration/phase4-destructive.test.ts'],
    // Loads .env / .secrets/devel1.env before any suite calls loadConfig(), so a
    // missing credentials file fails with an actionable message instead of every
    // suite dying in beforeAll on a bare "variable is not set".
    setupFiles: ['tests/integration/setup.ts'],
    // Integration files each open their OWN BC session. Running them in parallel fires a
    // burst of concurrent /SignIn requests at the same NST, which BC refuses — the suites
    // then fail in `beforeAll` with "Authentication failed: fetch failed", which reads like
    // a product bug and is not one. One file at a time keeps the auth path honest.
    // (Unit/protocol tests are unaffected: they have no BC and stay parallel.)
    fileParallelism: false,
  },
});
