import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The server version, read ONCE from package.json.
 *
 * It used to be hardcoded as '2.0.0' in three unrelated places (MCP serverInfo,
 * bc_health, the REST /health route) and all three had drifted away from the real
 * published version. Reading the manifest is the only way they can never disagree
 * again.
 *
 * Path note: this module resolves to `src/mcp/version.ts` in dev (tsx) and
 * `dist/mcp/version.js` after `npm run build` — `../../package.json` is the repo
 * root in BOTH layouts, so no build-time codegen is needed.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0';
  } catch {
    // Never let a missing/unreadable manifest take the server down: the version is
    // diagnostic metadata, not load-bearing.
    return '0.0.0';
  }
}

export const SERVER_VERSION: string = readPackageVersion();

/** MCP server identity, shared by initialize's serverInfo and the health outputs. */
export const SERVER_NAME = 'bc-mcp';
