import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dxtPath = resolve(repoRoot, 'dist-dxt/business-central-mcp.dxt');
const manifestPath = resolve(repoRoot, 'manifest.json');
const packageJsonPath = resolve(repoRoot, 'package.json');

describe('build-dxt', () => {
  beforeAll(() => {
    execSync('npm run build:dxt', { cwd: repoRoot, stdio: 'inherit' });
  }, 60_000);

  it('produces dist-dxt/business-central-mcp.dxt', () => {
    expect(existsSync(dxtPath)).toBe(true);
  });

  it('produces a non-trivial artifact (>1KB)', () => {
    expect(statSync(dxtPath).size).toBeGreaterThan(1024);
  });

  it('syncs manifest.json version to package.json version', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.version).toBe(pkg.version);
  });
});
