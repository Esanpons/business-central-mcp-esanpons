// scripts/aad-unlock.ts — free the AAD browser profile when a stale process holds it.
//
// WHY THIS EXISTS
// The SaaS provider keeps its headless browser ALIVE on purpose: BC binds the
// WebSocket to a specific browser tab and tears that session down if the browser
// closes. Chrome, in turn, locks its profile directory. Put together, that means
// only ONE process can hold the AAD profile at a time — and when an MCP client
// leaves an old server process behind (a closed window, a reload, a crash), every
// new instance fails to open a session with:
//
//   AAD authentication failed: The browser is already running for <profileDir>
//
// The session-create backoff then retries and fails identically, so bc_health
// reports `disconnected` forever with no way out from inside the tool surface.
// This script is that way out: it shows who holds the profile and, when asked,
// stops them.
//
// Usage:
//   npm run aad:unlock            # show what holds the profile (changes nothing)
//   npm run aad:unlock -- --kill  # stop those processes and free the profile
//
// It only ever touches processes whose command line names THIS profile directory,
// so it cannot disturb your own Chrome or another project's server.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';

dotenv({ path: '.secrets/saas.env', override: false });

const profileDir = resolve(process.env.BC_AAD_PROFILE_DIR || './.state/aad-profile');
const kill = process.argv.includes('--kill');

interface Holder { pid: number; name: string; kind: 'browser' | 'server'; started: string; }

/** Processes whose command line mentions the profile dir, plus the servers that own them. */
function findHolders(): Holder[] {
  if (process.platform !== 'win32') {
    // Linux/macOS: pgrep against the profile path is enough (no PEB juggling).
    const out = run('pgrep', ['-af', profileDir.replace(/\\/g, '/')]);
    return out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ...rest] = line.trim().split(/\s+/);
      const cmd = rest.join(' ');
      return {
        pid: Number(pid),
        name: /chrome|chromium|msedge/i.test(cmd) ? 'chrome' : 'node',
        kind: /chrome|chromium|msedge/i.test(cmd) ? 'browser' as const : 'server' as const,
        started: '',
      };
    });
  }
  // Windows: one CIM query for the browsers, then their parents (the MCP servers).
  //
  // The path travels in an ENV VAR, never interpolated into the script text: a
  // Windows path is full of backslashes, and getting their escaping right through
  // two languages is exactly the kind of detail that silently matches nothing --
  // this function's first version reported "the profile is free" while Chrome was
  // demonstrably holding it. Matching is lower-cased on both sides because the
  // command line can spell the drive or a folder in a different case.
  const ps = `
$needle = $env:BCMCP_UNLOCK_PROFILE.ToLower()
$alt = $needle.Replace([char]92, '/')
$browsers = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
  Where-Object { $_.CommandLine -and (($_.CommandLine.ToLower().Contains($needle)) -or ($_.CommandLine.ToLower().Contains($alt))) }
$rows = @()
foreach ($b in $browsers) {
  $rows += [pscustomobject]@{ pid = [int]$b.ProcessId; name = $b.Name; kind = 'browser'; started = $b.CreationDate.ToString('HH:mm:ss') }
}
$parents = $browsers | ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique
foreach ($pp in $parents) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pp" -ErrorAction SilentlyContinue
  if ($p -and $p.Name -eq 'node.exe') {
    $rows += [pscustomobject]@{ pid = [int]$p.ProcessId; name = $p.Name; kind = 'server'; started = $p.CreationDate.ToString('HH:mm:ss') }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;
  const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { BCMCP_UNLOCK_PROFILE: profileDir }).trim();
  if (!out || out === '[]') return [];
  const parsed = JSON.parse(out) as Holder | Holder[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function run(cmd: string, args: string[], extraEnv?: Record<string, string>): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      // Capture the child's stderr instead of letting it through: taskkill reports
      // "process not found" for children its own /T sweep already took down, which
      // read like a failure in the middle of a successful run.
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
  } catch {
    return '';
  }
}

/** Does this pid still exist? `signal 0` is a pure existence check on every platform. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

type StopResult = 'stopped' | 'already gone' | 'still running';

/**
 * Kill one process and say what actually happened. A tree kill takes the children
 * with it, so by the time the loop reaches them they are already gone -- reporting
 * those as "stopped" would be claiming credit for work that did not happen, which
 * is the whole thing this tool exists to avoid elsewhere.
 */
function stop(pid: number): StopResult {
  if (!alive(pid)) return 'already gone';
  if (process.platform === 'win32') {
    run('taskkill', ['/F', '/T', '/PID', String(pid)]);
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* reported by the alive() check below */ }
  }
  return alive(pid) ? 'still running' : 'stopped';
}

/** Chrome's own lock files. Harmless to remove once nothing holds the profile. */
function clearLockFiles(): string[] {
  if (!existsSync(profileDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(profileDir)) {
    if (!/^Singleton/.test(name)) continue;
    try { unlinkSync(resolve(profileDir, name)); removed.push(name); } catch { /* in use */ }
  }
  return removed;
}

console.log(`AAD profile: ${profileDir}`);
if (!existsSync(profileDir)) {
  console.log('The profile directory does not exist yet — run `npm run login:aad` to create it.');
  process.exit(0);
}

const holders = findHolders();
if (holders.length === 0) {
  const removed = clearLockFiles();
  console.log('Nothing holds the profile. It is free.');
  if (removed.length) console.log(`Removed leftover lock file(s): ${removed.join(', ')}`);
  console.log('If a tool still reports "browser is already running", restart the MCP client so it respawns the server.');
  process.exit(0);
}

console.log(`\n${holders.length} process(es) hold it:\n`);
for (const h of holders) {
  const what = h.kind === 'server' ? 'MCP server (owns the browser)' : 'headless browser';
  console.log(`  pid ${String(h.pid).padEnd(7)} ${h.name.padEnd(11)} ${h.started.padEnd(9)} ${what}`);
}

if (!kill) {
  console.log('\nNothing was stopped. Re-run with --kill to free the profile:');
  console.log('  npm run aad:unlock -- --kill');
  console.log('\nBefore you do: if one of those servers is the instance you are actively using, stopping it');
  console.log('ends its BC session (your MCP client will start a fresh one on the next call).');
  process.exit(0);
}

// Browsers first, then their servers: killing the server alone can orphan the browser,
// which would keep the lock and leave exactly the state we are trying to clear.
let stopped = 0;
const browserFirst = (h: Holder): number => (h.kind === 'browser' ? 0 : 1);
for (const h of [...holders].sort((a, b) => browserFirst(a) - browserFirst(b))) {
  const r = stop(h.pid);
  if (r === 'stopped') stopped++;
  console.log(`  pid ${String(h.pid).padEnd(7)} ${h.name.padEnd(11)} ${r}`);
}
const removed = clearLockFiles();
if (removed.length) console.log(`removed lock file(s): ${removed.join(', ')}`);

const left = findHolders();
if (left.length === 0) {
  console.log(`\nProfile freed (${stopped} process(es) stopped). The next SaaS call will open a fresh session.`);
} else {
  console.log(`\nStill held by: ${left.map((h) => h.pid).join(', ')}. Try again, or stop them from the Task Manager.`);
  process.exit(1);
}
