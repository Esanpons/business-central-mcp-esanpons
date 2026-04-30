#!/usr/bin/env -S tsx

import { readFileSync, writeFileSync, mkdirSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import archiver from 'archiver';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repoRoot, 'manifest.json');
const packageJsonPath = resolve(repoRoot, 'package.json');
const iconPath = resolve(repoRoot, 'icon.png');
const readmePath = resolve(repoRoot, 'README.md');
const licensePath = resolve(repoRoot, 'LICENSE');
const outDir = resolve(repoRoot, 'dist-dxt');
const outPath = resolve(outDir, 'business-central-mcp.dxt');

function syncManifestVersion(): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`[build-dxt] synced manifest.json version -> ${pkg.version}`);
  }
  return pkg.version;
}

function validateManifest(): void {
  try {
    execSync('npx -y @anthropic-ai/dxt validate manifest.json', {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('[build-dxt] manifest validation failed');
    throw err;
  }
}

function ensurePrereqs(): void {
  for (const path of [manifestPath, iconPath, readmePath, licensePath]) {
    if (!existsSync(path)) {
      throw new Error(`[build-dxt] missing required file: ${path}`);
    }
  }
}

async function buildZip(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await new Promise<void>((resolveZip, rejectZip) => {
    const output = createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolveZip());
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') console.warn(err);
      else rejectZip(err);
    });
    archive.on('error', rejectZip);
    archive.pipe(output);
    archive.file(manifestPath, { name: 'manifest.json' });
    archive.file(iconPath, { name: 'icon.png' });
    archive.file(readmePath, { name: 'README.md' });
    archive.file(licensePath, { name: 'LICENSE' });
    archive.finalize();
  });
}

async function main(): Promise<void> {
  ensurePrereqs();
  const version = syncManifestVersion();
  validateManifest();
  await buildZip();
  const sizeKb = (statSync(outPath).size / 1024).toFixed(1);
  console.log(`[build-dxt] wrote ${outPath} (${sizeKb} KB) for version ${version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
