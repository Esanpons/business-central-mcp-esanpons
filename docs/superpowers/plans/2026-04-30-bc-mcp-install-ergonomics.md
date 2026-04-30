# BC MCP Install Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make installing `business-central-mcp` effortless across VSCode (Copilot), Claude Code, and Claude Desktop by shipping a thin Desktop Extension (`.dxt`), automating its build on tag pushes, and rewriting the README around three host-specific install paths.

**Architecture:** Four artifacts in this repo: a rewritten `README.md` following readme-design guidelines; a `manifest.json` Desktop Extension wrapping `npx -y business-central-mcp`; a `scripts/build-dxt.ts` build script + `.github/workflows/release.yml` release workflow that produces and attaches the `.dxt` on `v*` tag pushes; and a `ROADMAP.md` capturing deferred work (OAuth, Cursor, init wizard, host detection).

**Tech Stack:** TypeScript / Node 20+, vitest, tsx, `archiver` (new devDep), `@anthropic-ai/dxt` CLI (via npx, no new dep). GitHub Actions on Ubuntu Node 22 for the release workflow.

**Spec:** `docs/superpowers/specs/2026-04-30-bc-mcp-install-ergonomics-design.md`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `ROADMAP.md` | Create | Deferred work: OAuth, Cursor, init wizard, host auto-detection, signing, marketplaces |
| `icon.png` | Create | 512×512 PNG referenced by `manifest.json` |
| `manifest.json` | Create | Claude Desktop Extension manifest |
| `scripts/build-dxt.ts` | Create | Builds `dist-dxt/business-central-mcp.dxt` |
| `tests/unit/build-dxt.test.ts` | Create | Verifies build script behavior |
| `.github/workflows/release.yml` | Create | Builds `.dxt` on `v*` tag, attaches to GitHub Release |
| `package.json` | Modify | Add `build:dxt` and `validate:dxt` scripts; add `archiver` devDep |
| `.gitignore` | Modify | Ignore `dist-dxt/` |
| `README.md` | Rewrite | Badges, overview table, three-host Install, Configuration table, Architecture ASCII, Key Files, Author/License footer, Roadmap link |

Each task below produces a self-contained change that is committed before the next task starts.

---

## Task 1: ROADMAP.md

Captures the deferred work named in the spec so it does not vanish.

**Files:**
- Create: `ROADMAP.md`

- [ ] **Step 1: Create `ROADMAP.md`**

```markdown
# Roadmap

Future work, ordered by priority within each section. Open an issue or PR if you want to push something up the list.

## Auth

- **OAuth / AAD authentication.** Currently NavUserPassword only. OAuth unlocks BC Online (SaaS) and modern on-prem deployments. Largest gap.
- **Windows authentication.** For domain-joined on-prem deployments where NavUserPassword is not enabled.

## Install ergonomics

- **Cursor support.** Add an "Install in Cursor" badge and a manual `~/.cursor/mcp.json` snippet to the README.
- **Interactive setup wizard.** `npx business-central-mcp init` that detects which host(s) are installed (Claude Desktop, Claude Code, VSCode, Cursor), prompts for BC URL/user/password, and writes the config files directly.
- **Host auto-detection inside the wizard.** Per-OS path detection for the four hosts above.

## Protocol

- **More tools.** Cover the remaining ~10% of the web client that the current 12 tools do not. Tracked via issues.
- **BC29+ wire-compat verification.** Verify each new BC version as it ships.

## Distribution

- **Sign the `.dxt`.** Once Claude Desktop's signing requirements stabilize, sign the artifact in the release workflow.
- **MCP marketplace.** Publish to whatever official extension index emerges (Claude's, VSCode's, generic MCP registry).
```

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: add ROADMAP.md for deferred work"
```

---

## Task 2: Icon

The build script stages `icon.png` into the `.dxt`. It must exist before Task 5's tests can pass.

**Files:**
- Create: `icon.png` (512×512 PNG, repo root)

- [ ] **Step 1: Create or generate `icon.png`**

Two acceptable paths:

**Path A — generate a placeholder programmatically.** Run this one-off in the shell (uses `sharp`, installed transiently):

```bash
npx -y -p sharp@0.33.5 -- node -e "
const sharp = require('sharp');
const svg = \`<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'>
  <rect width='512' height='512' fill='#0a0a0f'/>
  <text x='50%' y='50%' font-family='monospace' font-size='200' font-weight='700'
        fill='#4d9de6' text-anchor='middle' dominant-baseline='central'>BC</text>
</svg>\`;
sharp(Buffer.from(svg)).png().toFile('icon.png').then(() => console.log('icon.png written'));
"
```

**Path B — commission or hand-craft a real icon.** Replace the placeholder later via a follow-up commit. The `manifest.json` path stays the same.

- [ ] **Step 2: Verify the file**

Run: `file icon.png` (or any image viewer)
Expected: `icon.png: PNG image data, 512 x 512, 8-bit/color RGBA, non-interlaced`

- [ ] **Step 3: Commit**

```bash
git add icon.png
git commit -m "feat: add 512x512 icon for Desktop Extension"
```

---

## Task 3: manifest.json

Declares the Claude Desktop Extension and the four user-config fields prompted on install.

**Files:**
- Create: `manifest.json`

- [ ] **Step 1: Create `manifest.json`**

```json
{
  "dxt_version": "0.1",
  "name": "business-central-mcp",
  "display_name": "Business Central",
  "version": "1.0.1",
  "description": "Direct access to Microsoft Dynamics 365 Business Central via its native WebSocket protocol.",
  "author": {
    "name": "Torben Leth",
    "email": "sshadows@sshadows.dk"
  },
  "homepage": "https://github.com/SShadowS/business-central-mcp",
  "license": "MIT",
  "icon": "icon.png",
  "server": {
    "type": "node",
    "mcp_config": {
      "command": "npx",
      "args": ["-y", "business-central-mcp"],
      "env": {
        "BC_BASE_URL": "${user_config.bc_base_url}",
        "BC_USERNAME": "${user_config.bc_username}",
        "BC_PASSWORD": "${user_config.bc_password}",
        "BC_PROFILE": "${user_config.bc_profile}"
      }
    }
  },
  "user_config": {
    "bc_base_url": {
      "type": "string",
      "title": "BC base URL",
      "description": "e.g. http://your-bc-server/BC",
      "required": true
    },
    "bc_username": {
      "type": "string",
      "title": "BC username",
      "required": true
    },
    "bc_password": {
      "type": "string",
      "title": "BC password",
      "sensitive": true,
      "required": true
    },
    "bc_profile": {
      "type": "string",
      "title": "BC profile",
      "description": "Optional. e.g. BUSINESS MANAGER",
      "required": false
    }
  },
  "compatibility": {
    "platforms": ["darwin", "win32", "linux"],
    "runtimes": { "node": ">=20" }
  }
}
```

- [ ] **Step 2: Validate against the official `dxt` CLI**

Run: `npx -y @anthropic-ai/dxt validate manifest.json`
Expected: `Manifest is valid` (or equivalent zero-exit status).

If the CLI reports a schema error (e.g. `dxt_version` mismatch, unsupported field), reconcile the manifest against the CLI's reported schema. Common likely deltas:
- Newer `dxt_version` value (e.g. `"0.2"`).
- `server.type` may need to be `"binary"` if `"node"` requires a bundled entry-point file.
- `user_config` field key may be `"properties"` or different.

Make whatever edits the CLI requires. The structure (four prompted fields, npx wrapper) stays the same.

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: add Desktop Extension manifest for Claude Desktop install"
```

---

## Task 4: package.json scripts and devDep

Adds the `build:dxt` and `validate:dxt` scripts, plus the `archiver` devDep used by the build script.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `archiver`**

```bash
npm install --save-dev archiver @types/archiver
```

- [ ] **Step 2: Add scripts to `package.json`**

In the `"scripts"` object, add two new entries (place them after `"prepublishOnly"`):

```json
"validate:dxt": "npx -y @anthropic-ai/dxt validate manifest.json",
"build:dxt": "tsx scripts/build-dxt.ts"
```

- [ ] **Step 3: Verify scripts run**

Run: `npm run validate:dxt`
Expected: `Manifest is valid` (or equivalent). Confirms the script wiring is correct.

Run: `npm run build:dxt`
Expected: failure (`Cannot find module 'scripts/build-dxt.ts'` or "no such file") — the script is created in Task 5. This expected failure verifies the script is wired up.

- [ ] **Step 4: Add `dist-dxt/` to `.gitignore`**

Append to `.gitignore`:

```
dist-dxt/
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: add build:dxt + validate:dxt scripts and archiver devDep"
```

---

## Task 5: scripts/build-dxt.ts (TDD)

Builds `dist-dxt/business-central-mcp.dxt`. Test first, script second.

**Files:**
- Create: `tests/unit/build-dxt.test.ts`
- Create: `scripts/build-dxt.ts`
- Modify: `manifest.json` (only the `version` field is touched, indirectly, by the script)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/build-dxt.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit -- build-dxt`
Expected: FAIL with "Cannot find module" or "no such file `scripts/build-dxt.ts`".

- [ ] **Step 3: Implement `scripts/build-dxt.ts`**

Create `scripts/build-dxt.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit -- build-dxt`
Expected: 3 passing tests.

- [ ] **Step 5: Manual smoke test**

Run: `npm run build:dxt`
Expected: prints `wrote .../dist-dxt/business-central-mcp.dxt (~X KB) for version 1.0.1`. Artifact exists.

Optionally on a dev machine with Claude Desktop installed: double-click the `.dxt`, walk through the user-config prompt, confirm the server connects.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-dxt.ts tests/unit/build-dxt.test.ts
git commit -m "feat: add scripts/build-dxt.ts to package the Desktop Extension"
```

---

## Task 6: Release workflow

Triggers on `v*` tag pushes, builds the `.dxt`, attaches to a GitHub Release.

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  build-dxt:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22.x
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build .dxt artifact
        run: npm run build:dxt

      - name: Attach .dxt to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: dist-dxt/business-central-mcp.dxt
          generate_release_notes: true
```

- [ ] **Step 2: Verify YAML syntax**

Run: `npx -y js-yaml .github/workflows/release.yml > /dev/null`
Expected: zero exit status (no parse errors).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build and attach .dxt on v* tag pushes"
```

- [ ] **Step 4: End-to-end smoke (deferred)**

Defer to a real release: when shipping the next version, push a pre-release tag like `v1.0.2-rc.1`, observe the workflow run, and confirm the `.dxt` lands on the GitHub Release. Do not push a tag during plan execution.

---

## Task 7: README rewrite

Rewrites `README.md` per the readme-design guidelines and the spec's structure. Each step replaces or adds a top-level section.

**Files:**
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Replace the title block + badges**

Locate the existing centered title block at the top of `README.md`. Replace the badges row with the expanded set:

```markdown
<p align="center">
  <a href="https://www.npmjs.com/package/business-central-mcp"><img src="https://img.shields.io/npm/v/business-central-mcp" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/business-central-mcp"><img src="https://img.shields.io/npm/dm/business-central-mcp" alt="npm downloads"></a>
  <a href="https://github.com/SShadowS/business-central-mcp/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/business-central-mcp" alt="license"></a>
  <a href="vscode:mcp/install?%7B%22name%22%3A%22business-central%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22business-central-mcp%22%5D%7D"><img src="https://img.shields.io/badge/VSCode-Install-007ACC?logo=visualstudiocode" alt="Install in VSCode"></a>
  <a href="https://github.com/SShadowS/business-central-mcp/releases/latest"><img src="https://img.shields.io/badge/Claude%20Desktop-Download%20.dxt-d97757" alt="Download .dxt for Claude Desktop"></a>
</p>
```

Verify the `vscode:mcp/install` URI scheme against current VSCode docs at this point. If the scheme is wrong or unsupported, drop the VSCode badge and rely on the manual fallback in the Install section.

- [ ] **Step 2: Replace `## Quick start` with `## Overview` + `## Install`**

Delete the existing `## Quick start` section (the one with the JSON paste). Insert in its place:

```markdown
## Overview

| Property | Value |
|----------|-------|
| Language | TypeScript / Node 20+ |
| npm package | [`business-central-mcp`](https://www.npmjs.com/package/business-central-mcp) |
| BC versions | BC27, BC28 (wire-compatible) |
| Auth | NavUserPassword (OAuth on roadmap) |
| Tools | 12 |
| Tests | 281 unit/protocol + 111 integration |
| License | MIT |

## Install

### VSCode

[![Install in VSCode](https://img.shields.io/badge/VSCode-Install-007ACC?logo=visualstudiocode)](vscode:mcp/install?%7B%22name%22%3A%22business-central%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22business-central-mcp%22%5D%7D)

Click the badge. VSCode opens, prompts to add the server, and writes to your user `mcp.json`.

You will still need to set `BC_BASE_URL`, `BC_USERNAME`, and `BC_PASSWORD` in the entry's `env` block. VSCode opens the file for you to edit.

<details>
<summary><strong>Manual install</strong></summary>

Workspace: create `.vscode/mcp.json`:

```json
{
  "servers": {
    "business-central": {
      "command": "npx",
      "args": ["-y", "business-central-mcp"],
      "env": {
        "BC_BASE_URL": "http://your-bc-server/BC",
        "BC_USERNAME": "your-user",
        "BC_PASSWORD": "your-password"
      }
    }
  }
}
```

</details>

### Claude Code

```bash
claude mcp add business-central -- env BC_BASE_URL=http://your-bc-server/BC BC_USERNAME=you BC_PASSWORD=secret npx -y business-central-mcp
```

Scope it to the current project with `--scope project`. See `claude mcp --help` for scoping options.

### Claude Desktop

1. Download the latest `.dxt` from [Releases](https://github.com/SShadowS/business-central-mcp/releases/latest).
2. Double-click. Claude Desktop opens Settings → Extensions and prompts for BC URL, username, and password.
3. Restart Claude Desktop.

<details>
<summary><strong>Manual install</strong></summary>

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "business-central": {
      "command": "npx",
      "args": ["-y", "business-central-mcp"],
      "env": {
        "BC_BASE_URL": "http://your-bc-server/BC",
        "BC_USERNAME": "your-user",
        "BC_PASSWORD": "your-password"
      }
    }
  }
}
```

Restart Claude Desktop.

</details>
```

- [ ] **Step 3: Add `## Configuration` table after `## Install`**

Insert before the existing `## What can it do?` section:

```markdown
## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BC_BASE_URL` | Yes | — | BC server base URL, e.g. `http://your-bc-server/BC` |
| `BC_USERNAME` | Yes | — | NavUserPassword username |
| `BC_PASSWORD` | Yes | — | NavUserPassword password |
| `BC_PROFILE` | No | server default | Profile id, e.g. `BUSINESS MANAGER`. Affects which Role Center loads and which pages Tell Me indexes. |
| `BC_TENANT_ID` | No | `default` | Multi-tenant deployments only. |
| `BC_CLIENT_VERSION` | No | `27.0.0.0` | Version reported to BC during session open. |
| `PORT` | No | `3000` | HTTP transport port (stdio transport ignores this). |
| `LOG_LEVEL` | No | `info` | `debug` / `info` / `warn` / `error`. |
| `LOG_DIR` | No | `./logs` | Directory for log files. |
| `STATE_DIR` | No | `./.state` | Directory for session state. |
```

- [ ] **Step 4: Keep `## What can it do?` as-is**

No change. The current 12-row tools table is correct and matches the Overview's "Tools: 12" count.

- [ ] **Step 5: Add ASCII protocol diagram inside `## How it works`**

After the existing two paragraphs of `## How it works`, insert before any `<details>` blocks:

````markdown
```
LLM (Claude / Copilot / etc.)
   |
   v   MCP (stdio or HTTP)
business-central-mcp
   |
   v   WebSocket + JSON-RPC
BC Web Service Tier (BC27 / BC28)
   |
   v   internal calls
BC Server
```
````

- [ ] **Step 6: Add `## Key files` section before `## Development`**

```markdown
## Key files

| File | Purpose |
|------|---------|
| `src/stdio-server.ts` | npm `bin` entry — stdio MCP transport |
| `src/server.ts` | HTTP MCP transport entry |
| `src/protocol/` | WebSocket transport, wire types, captures |
| `src/services/` | Tool implementations (page, data, action, navigation, search) |
| `src/session/` | Session lifecycle, modal stack, reconnect |
| `manifest.json` | Claude Desktop Extension manifest |
| `scripts/build-dxt.ts` | Builds `.dxt` artifact for Claude Desktop |
| `.github/workflows/release.yml` | Builds + attaches `.dxt` on `v*` tag pushes |
| `ROADMAP.md` | Deferred work (OAuth, Cursor, init wizard) |
```

- [ ] **Step 7: Add `## Roadmap` + author/license footer**

After `## Development` (before any final notes), insert:

```markdown
## Roadmap

OAuth, Cursor support, an interactive `init` wizard, and a few protocol gaps.
See [ROADMAP.md](ROADMAP.md) for the full list and priorities.

---

**Author:** Torben Leth (sshadows@sshadows.dk)
**License:** MIT (see [LICENSE](LICENSE))
```

- [ ] **Step 8: Verify rendering**

Run: `git diff README.md | head -200`
Expected: large, coherent diff.

Open `README.md` in any markdown previewer (or `gh repo view -w` after pushing). Confirm:
- All badges render
- All internal links (`ROADMAP.md`, `LICENSE`) resolve
- No broken `<details>` tags
- Tables align

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README with three-host install, overview, configuration, key files"
```

---

## Verification (post-plan)

Run after all tasks land:

- [ ] `npm run typecheck` — passes
- [ ] `npm run test` — all 281+ existing tests + 3 new build-dxt tests pass
- [ ] `npm run validate:dxt` — manifest valid
- [ ] `npm run build:dxt` — produces `dist-dxt/business-central-mcp.dxt`
- [ ] Manual: open `.dxt` in Claude Desktop on a dev machine; user-config prompt appears with four fields; server connects after fill-in
- [ ] Manual: click VSCode badge in rendered README on github.com (in a private window if needed); VSCode opens the install prompt
- [ ] Manual: run the Claude Code one-liner against a test BC; server connects
- [ ] Defer to next release: push `v1.0.2-rc.1`; release workflow runs end-to-end; `.dxt` attached to GitHub Release

## Out-of-band follow-ups (do not do in this plan)

- Blog post on `sshadows.dk` covering the BC MCP polish + adoption story. Lives in the website repo.
- Real icon (replace placeholder `icon.png`).
- Sign the `.dxt` (tracked in ROADMAP.md).
- Cursor support, init wizard, host detection, OAuth (all tracked in ROADMAP.md).
