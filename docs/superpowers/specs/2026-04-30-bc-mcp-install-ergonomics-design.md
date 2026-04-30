# BC MCP Install Ergonomics — Design

**Date:** 2026-04-30
**Status:** Draft (awaiting user review)
**Owner:** Torben Leth

## Goal

Make installing `business-central-mcp` effortless across the three primary MCP hosts: VSCode (with GitHub Copilot), Claude Code, and Claude Desktop. Today the README shows only a Claude Desktop JSON paste. The replacement gives each host a one-click or one-line path with a manual fallback.

## Non-goals

- OAuth / AAD authentication. Tracked in `ROADMAP.md`. The install flow assumes the existing `NavUserPassword` model.
- Cursor support. Tracked in `ROADMAP.md`. Adding it later is a small README + badge addition.
- Interactive `npx ... init` setup wizard. Tracked in `ROADMAP.md`.
- Auto-detecting installed hosts. Tracked in `ROADMAP.md`.
- npm publish automation. Stays manual for this body of work.
- Signing the `.dxt` artifact. Tracked in `ROADMAP.md`; revisit once Claude Desktop's signing requirements are stable.

## Deliverables

Four artifacts in this repo:

1. **`README.md` rewrite** following the readme-design guidelines: badges, overview table, three-host Install section, configuration table, features table (existing, reformatted), ASCII protocol-flow diagram, key-files table, author/license footer, link to `ROADMAP.md`.
2. **`manifest.json`** — Claude Desktop Extension manifest. Wraps `npx -y business-central-mcp` and declares `user_config` for the four prompted env vars.
3. **`scripts/build-dxt.ts`** + **`.github/workflows/release.yml`** — script that produces `business-central-mcp.dxt` and a release workflow that builds the artifact on `v*` tag pushes and attaches it to a GitHub Release.
4. **`ROADMAP.md`** — captures the deferred work above.

## Design

### README structure

Top to bottom:

```
<center title block>           # current title + tagline (kept)
<badges row>                   # npm version, downloads, license,
                               # NEW: Install in VSCode, NEW: Download .dxt

## Overview                    # NEW table:
                               # Language, npm, BC versions, Auth, Tools,
                               # Tests, License

## Install                     # REWRITTEN
  ### VSCode                   # one-click badge + manual fallback
  ### Claude Code              # one-line `claude mcp add` snippet
  ### Claude Desktop           # .dxt download + manual fallback

## Configuration               # NEW table from .env.example:
                               # Variable | Required | Default | Description

## What can it do?             # KEEP existing tools table

## How it works                # KEEP, ADD ASCII protocol-flow diagram

  <details>Page output shape</details>
  <details>Session resilience</details>
  <details>Architecture invariants (if present)</details>

## Key files                   # NEW table — orient contributors

## Development                 # KEEP

## Roadmap                     # NEW — short list, link to ROADMAP.md

---
**Author:** Torben Leth (sshadows@sshadows.dk)
**License:** MIT (see LICENSE)
```

Install ordering is **VSCode → Claude Code → Claude Desktop** by ease (one-click → one-liner → download-and-double-click). Reader picks the path they care about and stops.

### Install snippets

#### VSCode

A shields-style "Install in VSCode" badge whose link uses the `vscode:mcp/install?{json}` URI scheme, with the JSON URL-encoded. The JSON describes the server (`name`, `command`, `args`). Clicking the badge opens VSCode and prompts the user to add the entry to their user `mcp.json`.

The user must still supply env vars (`BC_BASE_URL`, `BC_USERNAME`, `BC_PASSWORD`) — VSCode opens the file for them to edit, but the URI scheme cannot pre-prompt for arbitrary env values.

A `<details>` block under the badge shows a manual workspace install: paste a `.vscode/mcp.json` snippet.

> **Implementation note:** the exact `vscode:mcp/install` URI scheme must be re-verified against current VSCode docs at implementation time. The scheme evolved during 2025. If it does not work, fall back to a manual-only Install section for VSCode and document the fallback in the implementation plan.

#### Claude Code

A single-line `claude mcp add` command with env vars inlined via the shell `env` prefix:

```bash
claude mcp add business-central -- env BC_BASE_URL=http://your-bc-server/BC BC_USERNAME=you BC_PASSWORD=secret npx -y business-central-mcp
```

Followed by one sentence on `--scope project` for project-scoped installs and a pointer to `claude mcp --help`.

#### Claude Desktop

Three numbered steps:

1. Download the latest `.dxt` from `Releases`.
2. Double-click. Claude Desktop opens Settings → Extensions and prompts for BC URL, username, and password (per the manifest's `user_config`).
3. Restart Claude Desktop.

A `<details>` block shows the manual JSON config flow with the per-OS config-file paths (macOS, Windows, Linux).

### Desktop Extension (`manifest.json`)

The `.dxt` is a thin wrapper around `npx -y business-central-mcp`, not a bundled dist. Rationale:

- The npm package is the canonical distribution. The `.dxt` is a discovery and install shim.
- Tracks the latest npm version automatically — manifest only needs rebuilding when `manifest.json` itself changes, not on every code change.
- Artifact is on the order of KB, not MB.
- Trade-off: requires Node installed and a network call on first launch. Acceptable — `business-central-mcp` requires Node anyway.

Manifest shape (illustrative; exact schema validated against the `@anthropic-ai/dxt` CLI at build time):

```json
{
  "dxt_version": "0.1",
  "name": "business-central-mcp",
  "display_name": "Business Central",
  "version": "1.0.1",
  "description": "Direct access to Microsoft Dynamics 365 Business Central via its native WebSocket protocol.",
  "author": { "name": "Torben Leth", "email": "sshadows@sshadows.dk" },
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
        "BC_PROFILE":  "${user_config.bc_profile}"
      }
    }
  },

  "user_config": {
    "bc_base_url": { "type": "string", "title": "BC base URL", "description": "e.g. http://your-bc-server/BC", "required": true },
    "bc_username": { "type": "string", "title": "BC username", "required": true },
    "bc_password": { "type": "string", "title": "BC password", "sensitive": true, "required": true },
    "bc_profile":  { "type": "string", "title": "BC profile",  "description": "Optional. e.g. BUSINESS MANAGER", "required": false }
  },

  "compatibility": {
    "platforms": ["darwin", "win32", "linux"],
    "runtimes": { "node": ">=20" }
  }
}
```

`user_config` deliberately covers only the four user-facing env vars. The advanced env vars (`BC_TENANT_ID`, `BC_CLIENT_VERSION`, `PORT`, `LOG_LEVEL`, `LOG_DIR`, `STATE_DIR`) are omitted from the prompt to keep the install short. Users who need them edit the host's resulting config file directly.

**Icon:** a 512×512 PNG. Generated separately during implementation (e.g., via the existing `blog-drafts/generate-cover.ts` style) and committed to the repo root as `icon.png`.

### Build script (`scripts/build-dxt.ts`)

Steps:

1. Read `package.json`. Sync its `version` into `manifest.json` so `package.json` is the single source of truth for version numbers.
2. Validate the manifest. Primary path: `npx -y @anthropic-ai/dxt validate manifest.json`. If the CLI is unavailable or fails on this manifest, fall back to a minimal hand-rolled JSON-schema check covering the required fields documented above.
3. Stage files into a temp directory: `manifest.json`, `icon.png`, `README.md`, `LICENSE`.
4. Zip the staged directory to `dist-dxt/business-central-mcp.dxt`.
5. Print the artifact path and size.

Added to `package.json`:

```json
"build:dxt": "tsx scripts/build-dxt.ts",
"validate:dxt": "npx -y @anthropic-ai/dxt validate manifest.json"
```

### Release workflow (`.github/workflows/release.yml`)

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
      - uses: actions/setup-node@v4
        with: { node-version: 22.x, cache: npm }
      - run: npm ci
      - run: npm run build:dxt
      - uses: softprops/action-gh-release@v2
        with:
          files: dist-dxt/business-central-mcp.dxt
          generate_release_notes: true
```

Triggered on `v*` tag push. Existing CI (`ci.yml`) on push/PR is unchanged. npm publish stays manual.

### `ROADMAP.md`

Sections:

- **Auth** — OAuth / AAD; Windows authentication.
- **Install ergonomics** — Cursor support; interactive `init` wizard; host auto-detection.
- **Protocol** — more tools beyond the current 12; BC29+ wire-compat verification.
- **Distribution** — sign the `.dxt`; publish to MCP marketplaces if/when an official one emerges.

Each entry one short paragraph: what it is, what it unlocks. README links to `ROADMAP.md` from a short "## Roadmap" section.

## Risks and mitigations

- **`vscode:mcp/install` URI scheme could be wrong.** Verify against current VSCode docs before publishing the README. Fallback: drop the badge, keep manual `.vscode/mcp.json` only.
- **`@anthropic-ai/dxt` CLI schema may have evolved past `dxt_version: "0.1"`.** Build script runs `validate` and surfaces the actual error. Manifest is updated to whatever schema the CLI accepts.
- **`.dxt` install on Claude Desktop might require signing on some platforms.** If unsigned `.dxt` files are blocked, document the override (Settings → Extensions → trust developer) and add signing to the roadmap.
- **`npx -y` first-run latency on the wrapped `.dxt`.** First call downloads the package; subsequent calls are cached. Documented in the README.

## Verification

Per artifact:

- **README:** `markdownlint` clean (or whatever the repo currently uses); badges render on GitHub; all internal links resolve.
- **manifest.json:** `npm run validate:dxt` passes.
- **Build script:** `npm run build:dxt` produces `dist-dxt/business-central-mcp.dxt`. Manual smoke test: open the artifact in Claude Desktop on a dev machine, walk through the user-config prompt, confirm the server connects.
- **Release workflow:** tag a pre-release (`v1.0.1-rc.1`) and confirm the workflow runs end-to-end and attaches the `.dxt` to the resulting GitHub Release.
- **ROADMAP.md:** rendered links resolve; cross-link from README works.

## Out-of-band follow-ups

- A blog post on `sshadows.dk` covering the BC MCP polish + adoption story. Tracked separately in the website repo. The post will reference the install ergonomics shipped here as the call to action.
