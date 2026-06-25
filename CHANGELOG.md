# Changelog

All notable changes to `business-central-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Fork (AESVA / Esanpons): real screenshots of the BC web client, a manual generator,
server health/diagnostics, report output capture, and the BC744 hardening (field
disambiguation, write verification, payload control). Additive and out-of-band where
relevant — none of the browser tooling touches the WebSocket protocol path, so the
existing data tools keep their full speed.

### Added

- **`bc_download_report` tool — download a report's rendered output (PDF/Excel/Word).** The
  output-capture companion to `bc_run_report`. Runs out-of-band in the authenticated headless
  browser (reusing the `bc_screenshot` cookie-injection auth, extracted to
  `src/services/bc-web-auth.ts`) and intercepts the browser download via CDP
  (`Page.setDownloadBehavior`). Drives the report's request page end-to-end — clicks the
  toolbar's "Send to…"/"Enviar a…" (located by visible text), waits for the format dialog, then
  clicks "Aceptar"/"OK" and captures the download. Verified live on `devel1`: report 6 →
  `Trial Balance.pdf`. Saves to `BC_REPORT_DIR` / `out`; returns `downloaded` + `path`, or
  `requestPageShown: true` + `note` when a report needs a non-default format/parameter selection.
  Files: `src/services/report-download-service.ts`, `src/operations/download-report.ts`,
  diagnostic `scripts/capture-report-requestpage.ts`.
- **`bc_find_object` + `bc_refresh_objects` tools — resolve BC objects by name to numeric ID.**
  `bc_refresh_objects` scans the "All Objects with Caption" system page (9174) for a range of
  Object IDs and caches `id` + `name` + `caption` + `app` to a local JSON; `bc_find_object`
  resolves a page/report/table/codeunit by name, caption, keyword, or numeric id against that
  cached index (no live BC call), so you can look up a page ID before `bc_open_page`. Files:
  `src/services/object-index-service.ts`, `src/operations/find-object.ts`,
  `src/operations/refresh-objects.ts`.
- **Field disambiguation for duplicate captions (P1/P8).** `bc_open_page` / `bc_read_data`
  now return a stable `controlPath` and the enclosing `group` caption per field;
  `bc_write_data` / `bc_read_data` accept a `group` (and `bc_write_data` accepts a
  `controlPath` as the field key) to target the right control among repeated captions
  (Sell-to / Bill-to / Ship-to). Files: `src/protocol/section-dto.ts`,
  `src/protocol/form-tree-walk.ts`, `src/services/data-service.ts`.
- **Write verification (P6).** `bc_write_data` results carry `requested` / `changed` /
  `reason`; `allSucceeded` only holds when the value actually changed (no more false
  positives on no-op writes).
- **`editable` tri-state (P2).** Fields report `true | false | "unknown"`; `"unknown"`
  (BC sent no flag, common for page-variable option controls) is not read-only.
- **Payload control (P7/N3).** `bc_open_page` accepts `summary` / `sections` / `tab` /
  `columns` / `range`; `bc_execute_action` accepts `quiet`. Avoids token-limit overflows on
  large documents/lists. Shared narrowing in `src/protocol/section-filters.ts`.
- **`PAGE_NOT_MATERIALIZED` error (N1).** `bc_open_page` returns an explicit reason when BC
  can't produce a usable page (Unknown type / no sections / opened a dialog).
- **New env var:** `BC_REPORT_DIR` (default `./reports`) for `bc_download_report`.
- **Documentation architecture.** A coherent `docs/` set: an index ([`docs/README.md`](docs/README.md)),
  one reference per tool under `docs/tools/`, a cross-cutting [conventions guide](docs/guides/conventions.md),
  and a consolidated [`docs/ROADMAP.md`](docs/ROADMAP.md) (limitations + backlog). Replaces the
  ad-hoc `limits.md`, root `ROADMAP.md`, `docs/SCREENSHOTS.md`, `docs/BC-WS-MEJORAS.md`,
  `docs/WHATS-NEW-BC744.md`, and `SESSION-HANDOFF.md`.

- **`bc_screenshot` tool — real PNG screenshots of the BC web client.** Captures the
  actual rendered web UI (not synthetic HTML) for a page/record. Engine = cookie
  injection (verified live against BC 27 / `devel1`): bc-mcp authenticates via the forms
  `/SignIn` flow, injects the cookie jar (with its real `path=/BC; secure; samesite=none;
  httponly` attributes) into a headless system Chrome/Edge (`puppeteer-core`, no bundled
  download), opens a deep-link URL (`?page=&tenant=&company=&bookmark=`), waits for the
  SPA, and captures. Auto-falls-back to an in-page `/SignIn` if injection lands on the
  login page. Writes the PNG to disk (`BC_SCREENSHOT_DIR` / `out`) and returns it inline
  in the MCP response. Files: `src/services/screenshot-service.ts`,
  `src/operations/screenshot.ts`, `src/services/browser.ts`, `src/mcp/handler.ts`
  (inline image content block). Reference: `docs/tools/bc_screenshot.md`.
- **Annotation & crop options on `bc_screenshot`.** `highlight` accepts a caption (one
  red box), a list of captions (auto-numbered badges 1,2,3… for ordered manual steps), or
  `{target,label,style}` objects (style `box` / `badge` / `arrow` / `blur`). `redact`
  blacks out fields; `crop` clips the image to the bounding box of the given caption(s).
  All locate controls by visible caption (no dependency on BC exposing DOM ids).
- **`bc_build_manual` tool — step-by-step user manuals in Markdown + PDF + DOCX.** You
  provide ordered steps (heading, prose, optional screenshot spec); the tool captures the
  annotated screenshots and renders the document. MD references images by relative path;
  PDF is rendered via the shared headless browser (`page.pdf()`); DOCX embeds images via
  the `docx` package (lazy-imported). Output under `BC_MANUAL_DIR` (default `./manuals`).
  Files: `src/services/manual-service.ts`, `src/services/manual-render.ts`,
  `src/operations/build-manual.ts`. A user-scope skill `bc-manual` guides Claude to gather
  steps and call it.
- **`bc_health` tool + richer `/health` endpoint.** Reports connection status, active
  company, open form count, modal-dialog depth, and lightweight metrics (tool invocations,
  errors by category, session reconnects, session uptime). Registered to BYPASS the
  `ensureSession()` gate so it answers even when BC is down. Files:
  `src/operations/health.ts`, `src/services/metrics.ts`.
- **New env vars:** `BC_SCREENSHOT_DIR` (default `./screenshots`), `BC_SCREENSHOT_CHROME`
  (browser path override; auto-detected otherwise), `BC_MANUAL_DIR` (default `./manuals`).
- **Integration tests for `bc_screenshot`** (`tests/integration/screenshot.test.ts`) with a
  skip-guard that skips when BC env vars or a browser are absent (CI-safe).
- **`scripts/screenshot-poc.ts`** — a throwaway 4-method comparison harness used to choose
  the capture engine (`npm run screenshot:poc`).

### Changed

- **Clearer, actionable error messages.** `MCPHandler` now translates raw BC/.NET/transport
  error strings into friendly messages with remediation hints (modal stuck → session reset,
  lost session, `NavCancelCredentialPrompt` → applicationId hint, connection refused, TLS,
  timeout, bookmark, …) via `src/core/error-translator.ts`. Translation happens only at the
  output boundary so upstream session-death / modal detection still sees the raw string.
- **`puppeteer-core` promoted to a runtime dependency** (lazy-imported so it never affects
  startup); **`docx` added** as a runtime dependency for DOCX manual output.

## [1.1.0] - 2026-06-09

Fork (AESVA / Esanpons): connect to BC 27 (ltsc2025) on-prem with NavUserPassword.

### Added

- **`BC_APPLICATION_ID` env var** (default `NAV`) to override the
  `navigationContext.applicationId` sent in `OpenSession` / `Invoke`.

### Changed

- **`OpenSession` now sends `applicationId: "NAV"` instead of `"FIN"`.** BC 27
  (ltsc2025) rejects `"FIN"` with `NavCancelCredentialPromptException` on the first
  `OpenSession` even though HTTP auth and the WebSocket handshake both succeed.
  Verified empirically by capturing the real web client and a 3-variant isolation
  test against a live BC 27 container. Configurable via `BC_APPLICATION_ID` for
  builds that expect a different value. Files: `src/protocol/interaction-encoder.ts`,
  `src/core/config.ts`, `src/stdio-server.ts`, `src/server.ts`.

### Fixed

- **`NavCancelCredentialPromptException` on connect against BC 27 + NavUserPassword**,
  caused by the wrong `applicationId` (see Changed).

## [1.0.2] - 2026-05-01

Install ergonomics across the three primary MCP hosts. Documentation, build
pipeline, and release automation only — no protocol or runtime changes.

### Added

- **Claude Desktop Extension (`.dxt`).** New `manifest.json` declaring the
  server with four prompted `user_config` fields (`bc_base_url`,
  `bc_username`, `bc_password` (sensitive), `bc_profile` (optional)). Manifest
  validates against `@anthropic-ai/dxt`. Wraps `npx -y business-central-mcp`
  rather than bundling `dist/`, so the `.dxt` tracks the latest npm version
  automatically.
- **`scripts/build-dxt.ts`** that produces `dist-dxt/business-central-mcp.dxt`:
  syncs `manifest.json` version from `package.json`, validates the manifest,
  zips manifest + icon + README + LICENSE via `archiver`. Three vitest tests
  cover artifact existence, size, and version sync.
- **`.github/workflows/release.yml`** triggered on `v*` tag pushes. Builds
  the `.dxt` and attaches it to the GitHub Release with auto-generated notes.
  Hardened with explicit artifact-existence check and
  `fail_on_unmatched_files`.
- **`ROADMAP.md`** capturing deferred work: OAuth/AAD auth, Windows auth,
  Cursor support, interactive `init` wizard, host auto-detection, more tools,
  BC29+ wire-compat verification, `.dxt` signing, MCP marketplace publication,
  the `manifest.json` `entry_point` schema/runtime gap, and the VSCode
  one-click `inputs` opportunity.
- **`icon.png`** (512×512, BC monogram on dark background) for the `.dxt`.
- **`build:dxt` and `validate:dxt` npm scripts.** `archiver` and
  `@types/archiver` added as devDependencies.

### Changed

- **`README.md` rewritten** following readme-design guidelines. New sections:
  Overview table (language, npm, BC versions, auth, tools, tests, license);
  Install with three host-specific subsections (VSCode one-click badge plus
  manual `.vscode/mcp.json`, Claude Code one-line `claude mcp add -e ...`,
  Claude Desktop `.dxt` download plus manual `claude_desktop_config.json`
  with per-OS paths); Configuration table covering 13 env vars
  (including `BC_INVOKE_TIMEOUT`, `BC_RECONNECT_MAX_RETRIES`,
  `BC_RECONNECT_BASE_DELAY` that previously had no documented home);
  ASCII protocol-flow diagram; Key files table; Roadmap section linking to
  `ROADMAP.md`; author/license footer. Old `## Quick start` JSON-paste
  section removed.

## [1.0.1] - 2026-04-28

First stable release of the v2 codebase. Declares the MCP tool output shapes
(`Section[]`) and env var contract as the public API surface — subsequent
breaking changes require a major version bump per semver.

(Note: version `1.0.0` was historically published on 2026-03-04 from the
prior codebase and unpublished; npm forbids version-number reuse, so the
v2 line starts at `1.0.1`.)

### Added

- `Section`-based MCP output shape: `bc_open_page` and `bc_navigate` now return
  a uniform `sections: Section[]` array. Each section carries its own
  `fields[]`, `rows[]`, `actions[]`, `cues[]`, `totalRowCount` as appropriate
  to its kind (header / lines / factbox / subpage / requestPage). FactBox
  contents are now first-class section entries, addressable by `sectionId`.
- `bc_read_data` returns a single refreshed `Section` for the requested
  section id (defaults to `"header"`).
- `BC_PROFILE` env var plumbed into BC's `OpenSession` `profile` field. Selects
  which profile (and therefore which Role Center / Tell Me index) the session
  loads. Verified against decompiled
  `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs`.
- Auto-recovery on `LogicalModalityViolationException` mid-session: the
  session walks an internal modal stack (DialogOpened-pushed,
  FormClosed-popped), sends `Abort=320` to each, then retries the original
  interaction once. Falls back to `ModalReconcileError` + session reset when
  reconciliation can't clear server-side state.
- Role Center cuegroup support: hosted CardParts surface as sections with
  `cues: SectionCue[]` populated from the new `stackgc`/`stackc` wire types.
  `bc_execute_action { section, cue }` drills down into the underlying list.
- `CardPartStubError` (code `CARDPART_STUB`): structured error when a
  CardPart opens standalone and BC returns a placeholder shell. Tells the
  caller to reach the part through its host page.
- Live wire fixtures committed under `src/protocol/captures/`: Tell Me
  results (`tell-me-result-2026-04-28.json`), Role Center cuegroups
  (`cuegroup-rolecenter-2026-04-28.json`), CardPart standalone
  (`cuegroup-cardpart-standalone-2026-04-28.json`).
- Capture utility scripts: `scripts/capture-tell-me.ts` and
  `scripts/capture-rolecenter.ts`.
- GitHub Actions CI: typecheck, build, and unit/protocol tests on Node 20,
  22, 24.

### Fixed

- **Tell Me search returned empty results.** The original `SearchService` sent
  `SaveValue` against `server:c[0]` (the `gc` container) instead of
  `server:c[0]/c[0]` (the actual `sc` text input). BC accepted the wrong
  path silently, returning `InvokeCompleted` with no `DataLoaded` events.
  Verified by live capture (BC28 BUSINESS MANAGER profile, query `customer`):
  the corrected path returns 23 page rows + 32 report rows. Root cause of
  limits.md #5.
- **Stale `ctx` in `bc_read_data` after filter / range operations.** The
  operation captured `PageContext` before invoking `applyFilters` /
  `scrollRepeater`, both of which produce immutable updates that replace the
  context entry. `buildSection` then projected pre-filter state. Range
  queries with `offset + limit` exceeding the initial viewport silently
  returned empty slices. Now re-fetches the context before building the
  output Section. Regression test added.
- **Promise-queue deadlock during modal recovery.** `reconcileModalStack`
  called `BCSession.invoke` recursively while running inside an
  already-enqueued task, blocking the queue. Split `invoke` into a public
  enqueueing entry point and a private `invokeUnqueued` work function;
  `reconcileModalStack` now uses the unqueued path. Race-against-deadlock
  regression test added.
- Architectural layering restored: `mapRowCellKeys` moved from
  `services/data-service.ts` to `protocol/row-mapping.ts` so `protocol/`
  no longer imports from `services/`.
- Deduplicated `classifyWizardNav` (was four byte-identical copies across
  `services/action-service.ts`, `operations/open-page.ts`,
  `operations/wizard-navigate.ts`, and `protocol/section-dto.ts`) into
  `protocol/wizard-classify.ts`.
- Empty FactBox sections (BC stub responses) are now invalidated after the
  factbox refresh pass so they don't pollute MCP output with empty content.

### Documentation

- `limits.md` items 1–5 updated with verified-fix status:
  - #1 (cuegroup placeholder) — resolved via Role Center cuegroup support.
  - #2 (FactBox invisible) — resolved via section-first-class output.
  - #3 (ApplicationArea filter) — documented as server-side BC behavior; no
    client override exists. Diagnosis and remediation flow via existing
    tools (page 9178 + `bc_open_page` + `bc_write_data`).
  - #4 (stuck modal) — partially resolved with two-stage recovery
    (transparent retry; degraded fallback to session reset).
  - #5 (Tell Me empty) — resolved (controlPath fix + structured extractor +
    optional `BC_PROFILE` for profile-scoped envs).
- `CLAUDE.md` adds protocol notes for Tell Me search (`server:c[0]/c[0]`
  controlPath, profile scoping), cuegroups (`stackgc`/`stackc` wire types),
  and `BC_PROFILE` env var.
- `README.md` documents the new sections-based output shape under "Page
  output shape".
- `.env.example` documents `BC_PROFILE`.
- `src/protocol/captures/README.md` records every empirical wire-format
  finding.

### Internals

- New `FormNode` variants: `StackGroupNode` (cuegroup container) and
  `CueFieldNode` (cue tile).
- New memoised view: `cues(root)` collects cuegroup tiles across the tree.
- New error class: `ModalReconcileError` (code `MODAL_RECONCILE_ERROR`,
  extends `ProtocolError`).
- New `SystemAction.CloseOk = 350` (verified against decompiled
  `Microsoft.Dynamics.Framework.UI.Client.SystemAction.cs`).
- 281 unit + protocol tests, 111 integration tests against BC28.

### Internal architecture (informational)

- 5 implementation plans under `docs/superpowers/plans/` documenting the
  design and execution of this body of work:
  - `2026-04-28-section-first-class.md` (Plan A)
  - `2026-04-28-modal-stack-reconciliation.md` (Plan B)
  - `2026-04-28-rolecenter-cuegroup.md` (Plan C)
  - `2026-04-28-tell-me-extraction.md` (Plan D)
  - `2026-04-28-application-area-diagnostics.md` (Plan E — superseded by
    docs-only resolution; kept for historical context).

## [0.1.0] — Initial development version

Pre-release, in active development. Tagged version in `package.json` but
not yet published to npm.
