// scripts/refresh-objects.ts <docker|saas> [--all] [--from N] [--to N]
//
// Builds/updates the cached BC object index (.state/object-index.json) OUTSIDE an MCP
// client — the same thing `bc_refresh_objects` does, runnable from a terminal.
//
//   npm run objects:refresh -- saas --all     # full range incl. standard objects (minutes)
//   npm run objects:refresh -- saas           # fast: custom + add-ins (>= 50000)
//   npm run objects:refresh -- docker --from 50000 --to 99999
//
// The index is a CACHE (gitignored): it is what `bc_find_object` searches to resolve a
// name/keyword to a numeric page id. Refresh it after an AL deployment or a BC upgrade.
import { parseEnvName, loadEnvFile, createHarness } from './lib/harness.js';
import { isOk } from '../src/core/result.js';

const env = parseEnvName(process.argv[2]);
const argv = process.argv.slice(3);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const num = (name: string): number | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number`);
  return v;
};

const all = flag('all');
const from = num('from');
const to = num('to');

loadEnvFile(env);

const started = Date.now();
const h = await createHarness(env);
console.log(`\n===== OBJECT INDEX REFRESH: ${env} =====`);
console.log(`base=${h.cfg.bc.baseUrl} auth=${h.cfg.bc.authMode} company=${h.session.companyName}`);
console.log(`range=${all ? 'ALL (standard included — this takes minutes)' : `${from ?? 50000}..${to ?? 'default max'}`}\n`);

try {
  const r = await h.ops.refreshObjects.execute({ all: all || undefined, from, to });
  if (!isOk(r)) {
    console.error(`FAILED: ${r.error.message}`);
    process.exitCode = 1;
  } else {
    const v = r.value;
    console.log(`scanned=${v.scanned} totalInIndex=${v.totalInIndex} reads=${v.reads}`);
    console.log(`range=${v.range.from}..${v.range.to} updatedAt=${v.updatedAt}`);
    console.log(`elapsed=${Math.round((Date.now() - started) / 1000)}s`);

    // Prove the index is queryable end to end (this is what bc_find_object does).
    const probe = await h.ops.findObject.execute({ query: 'Customer List', type: 'Page', limit: 3 });
    if (isOk(probe)) {
      console.log(`\nprobe find_object("Customer List", Page) -> ${probe.value.count} matches`);
      for (const o of probe.value.results) console.log(`  ${o.type} ${o.id} — ${o.name} (${o.app})`);
    }
  }
} finally {
  await h.dispose();
}

process.exit(process.exitCode ?? 0);
