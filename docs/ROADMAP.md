# Pending work — single source of truth

> **Consolidated on 2026-08-09.** This file is the ONLY place where open work is tracked:
> limitations, bugs, gaps, doc drift, test debt and the idea backlog. Anything not listed here
> is either done (see [`CHANGELOG.md`](../CHANGELOG.md)) or was verified as already done and
> removed.
>
> **Every item below was re-verified against the code on 2026-08-09** — not copied forward from
> an older plan. Each one carries the file/line that proves it is still open. Items from the
> previous documents that turned out to be already implemented were deleted, not archived.
>
> **Replaces and supersedes** (deleted; recoverable from git history):
> `docs/Plans/2026-07-04-auditoria-completa-millores.md` (the 2026-07-04 audit order of work),
> `docs/Plans/2026-08-08-saas-sandbox.md` (the SaaS plan, fully executed),
> `docs/Errores/Errores-bc-ws-vs-playwright.md` (bc-ws vs Playwright). The `docs/Plans/` directory
> is gone: plans that are finished are not documents, they are history.
>
> **Sibling document, and the only other one that is not a guide or a tool page:**
> [`SAAS-EVIDENCE.md`](SAAS-EVIDENCE.md) — the frozen record of how SaaS's per-tab backend
> WebSocket was discovered plus the 18-tool Docker-vs-SaaS parity matrix (merged from the old
> `saas-spike.md` + `saas-battery.md`). It holds **results**; it never holds pending items.

## 0. Verification snapshot (2026-08-09)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` (unit + protocol) | **403 passed / 55 files** |
| `npx vitest run --config vitest.integration.config.ts` vs `devel1` (BC27) | **104 passed · 4 failed · 9 skipped** (117 tests / 20 files) — 3 suites also failed at setup. See §1 |
| SaaS functional battery (`npm run test-battery saas`, 2026-08-08) | 16 PASS · 1 FAIL · 1 SKIP — the FAIL is G5 below |
| Docker functional battery (`npm run test-battery docker`, 2026-08-08) | 16 PASS · 0 FAIL · 2 SKIP |

SaaS/AAD support is **done and verified live**; on-prem forms auth is unchanged. Nothing about
SaaS is pending except G5.

### What the old documents still listed as pending but is actually DONE

Checked in the code on 2026-08-09 and therefore dropped from this file:

- **All four critical bugs of the 2026-07-04 audit.** Row-scoped actions honour
  `bookmark`/`rowIndex` (`ExecuteActionOperation` → `ActionService.positionRow` with
  `SetCurrentRow`); the invoke timeout starts on send, not on enqueue; `bc_read_data` filters
  reset by default with an `appendFilters` opt-in; session-death detection uses a word-boundary
  regex.
- **Error `code` + `context` reach the MCP caller** (`buildErrorResult` in `src/mcp/handler.ts`),
  which was the prerequisite for self-correcting errors.
- **`bc_switch_company` reflects the real company**, `bc_close_page` has `discardChanges`,
  actions that open a page return a usable `pageContextId`.
- **`bc_navigate`'s fake `lookup`** was removed from the schema (so the tool no longer lies) —
  the *capability* is still missing, tracked as G7.
- **The whole SaaS/AAD plan** (auth refactor, capture spike, `AADBrowserAuthProvider`, expiry
  handling, docs). Verified live against the `Dev` sandbox.
- **List filtering works** via the `OpenForm filter=` query, which also retired the old
  "a customer outside the first ~49 rows is unreachable" limitation.
- **Repo hygiene**: package renamed with fork metadata, `zod-to-json-schema` removed, the
  tool-count assertion derives from the registry, `BC_BASE_URL` trailing slashes trimmed
  (shape validation still open as B12).

Everything else the old documents listed as "low priority, deferred" was re-checked
individually and is still open — it is in §3 below with the proof.

---

## 1. Blocking gate — the on-prem integration suite is NOT green

The 2026-07-04 audit closed with "run the integration suite against `devel1`" as its one blocking
item, never executed. **It was executed on 2026-08-09** (`devel1` live, BC27): the suite is
mostly green but not clean. Triage below — nothing here is a proven regression of the audit
fixes, but none of it can be dismissed either.

| # | Failure | Reading |
|---|---------|---------|
| **A1** | `phase3-features.test.ts` — `isLookup` on Customer Card `No.` and `showMandatory` on `Name` are both `undefined` (expected `true`). | **Real product gap or a BC27/BC28 delta.** The plumbing exists (`ShowMandatory` in `form-tree-builder.ts`, `hasLookup` in `mcp-adapters.ts` / `section-dto.ts`), so either BC27 does not emit these properties for those controls or the builder misses the shape BC27 uses. Field metadata that silently never populates is worth a decompiled-source check. |
| **A2** | `modal-recovery.test.ts` (both tests) — deleting a customer on `devel1` produced `InvokeCompleted` + `PropertyChanged`, never a `DialogOpened`, so the test could not build a modal stack to reconcile. | The modal-stack recovery path is therefore **unverified on this environment**, not proven broken. Either BC27/this DB deletes without a confirm, or the test's fixture record doesn't trigger one. Fix the fixture so the reconcile path actually gets exercised. |
| **A3** | `bc28.test.ts` and `multi-section.test.ts` failed at `beforeAll` with `Authentication failed: fetch failed`. | **Environmental**: vitest runs files in parallel and several suites open their own session, so `devel1` refuses concurrent `/SignIn` bursts. Run those files serially (or add a retry/`--pool-options.threads.singleThread`) before reading anything into it. |
| **A4** | `mcp-endpoint.test.ts` — "Server did not become ready within 30s", caused by an unhandled `spawn cmd.exe ENOENT`. | **Harness bug**, see T5: the test spawns its server with the upstream author's hardcoded `cwd` and through a shell. Its 3 tests silently skipped — they have probably never run in this fork. |

Until A1 and A2 are triaged, treat the on-prem regression gate as *amber*: the 104 passing tests
cover the audit's protocol fixes, but the modal-recovery path has no live evidence.

---

## 2. Tool capability gaps (what an agent still cannot do)

| # | Gap | Evidence (2026-08-09) | Effort | Workaround today |
|---|-----|----------------------|--------|------------------|
| **G1** | **Open a page by AL name.** `bc_open_page` takes a numeric id only, but `bc_search_pages` (Tell Me) returns AL names — so a search result can't be opened directly. | `OpenPageSchema` in [src/mcp/schemas.ts](../src/mcp/schemas.ts) has `pageId` only | S–M | Resolve the id with `bc_find_object`, then open by id. |
| **G2** | **Create a record on a Card page (`mode=Create`).** No tool can open a page in creation mode; `bc_execute_action { action: "New" }` on a custom Document card navigates to the next existing record instead of initialising a blank one. Forces Playwright for record creation on custom document types. | no `mode=` in the `OpenForm` query, [src/services/page-service.ts](../src/services/page-service.ts) | M | Playwright with `?page=<id>&mode=Create`. |
| **G3** | **`bc_download_report` explicit output format** (`pdf` / `excel` / `word`). The "Send to…" dialog exposes a radio group (`name="b13"`, options `b13_0..b13_5`) that is captured but never driven, so the default (PDF) always wins. | no `format` in `DownloadReportSchema`; `driveRequestPage` in [src/services/report-download-service.ts](../src/services/report-download-service.ts) clicks OK directly | **S** | Accept PDF. Lead: `npm run capture:report <id>` resolves each control's label. |
| **G4** | **`bc_download_report` Options-area request-page parameters** (dates, booleans, option/dropdown inputs — e.g. per-customer statements 116 / 1316). Only `RequestFilterField` inputs are settable via `filters`. | `applyFilters` only targets filter fields, same file | M (per-report) | Reports return `downloaded:false` + `requestPageShown:true`; fill the request page over WS with `bc_run_report`. |
| **G5** | **`bc_download_report` on SaaS.** The download engine works on SaaS (`bc_screenshot` proves the browser authenticates), but the report deep-link (`?report=`) intermittently lands on BC's "Go back home" error page and the SaaS request-page toolbar differs from the on-prem "Send to → Aceptar" flow. On-prem is unaffected. | SaaS battery, 2026-08-08 | M | Use on-prem for report downloads, or `bc_run_report` on SaaS. |
| **G6** | **`bc_screenshot` cannot reveal a document's "Lines" grid.** `expand:true` opens FastTabs and "Show more", but never clicks the document section toggle ("Lines >"), so line-grid captions (Quantity, Qty. to Ship, Line Amount) are never found → `found:false`, no highlight, no crop. Affects Sales Order 42, Purchase Order 50, and custom document cards. | `revealAll()` handles only `.ms-nav-columns-caption` / `.ms-nav-group-caption` / `button.show-more-fields-button` in [src/services/screenshot-service.ts](../src/services/screenshot-service.ts) | S–M | Playwright for line screenshots. Proposed API: `clickBeforeCapture: ["Lines"]`. |
| **G7** | **Field lookup / AssistEdit cannot be triggered.** `SystemAction.Lookup=110` is not reachable from any tool (`bc_navigate`'s `lookup` action was removed rather than implemented). | `NavigateSchema` `action: z.enum(['drill_down','select'])` | M | None — pick values by writing the field directly. |
| **G8** | **Line/subpage section filtering does not work.** Only the main list uses the working `OpenForm filter=` mechanism; a `filters` on a line section still falls back to the filter pane, which is a no-op on BC27/BC28. | fallback branch in [src/operations/read-data.ts](../src/operations/read-data.ts) | M | Filter the underlying list page instead. |
| **G9** | **`bc_read_data` does not report which filters are active.** Filters now replace by default (fixed), but the response never echoes `activeFilters`, so an agent cannot tell what the current server-side filter is. | no `activeFilters` anywhere in `src/` | **S** | Track them caller-side. |
| **G10** | **FactBox content read through the parent page can come back empty**, even though the section id is listed. | reported live (BC-748); no code fix attempted | M | Open the FactBox page by its own `pageId`, or request `sections:["factbox:<id>"]` on `bc_open_page`. |
| **G11** | **`bc_screenshot` captures saved state only.** It opens an independent browser session on the stored record, so unsaved/transient on-screen state cannot be documented. | by design (out-of-band engine) | L | Save before capturing. Deferred idea: render the in-memory `FormState` to HTML/PNG. |
| **G12** | **No file upload.** The headless browser can download but never drives `<input type="file">`. | no upload path in `src/services/` | M | — |

---

## 3. Bugs and robustness gaps (verified still present)

Ordered by consequence, not by age. None is urgent; each carries why it was left.

| # | Bug | Evidence | Why deferred / what it needs |
|---|-----|----------|------------------------------|
| **B1** | **Sticky confirm dialogs reset the session.** `reconcileModalStack` sends `Abort=320` against `controlPath: 'server:'`; when BC keeps the dialog server-side the recovery degrades to a full session reset (`SessionLostError`, page contexts lost). | [src/session/bc-session.ts](../src/session/bc-session.ts) `systemAction: 320` in `reconcileModalStack` | Target the dialog's own No/Cancel child control (or `SystemAction.No=390`, already used in `closeGracefully`) so BC closes it server-side. |
| **B2** | **Company is not re-applied after a reconnect.** After session death / `al_publish`, the recreated session returns to the server-default company; nothing replays the last `bc_switch_company`. | no company state in [src/session/session-manager.ts](../src/session/session-manager.ts) / `session-factory.ts` | Remember the last requested company and re-issue `ChangeCompany` after recovery. |
| **B3** | **Session-recovery race.** During recovery `this.session` is set to `null`, so a concurrent `getSession()` takes the "first create" branch and never receives `SessionLostError` — it fails later with a confusing "page context not found". `recordSessionCreated` is also double-counted. | [src/session/session-manager.ts](../src/session/session-manager.ts) `getSession()` | The recovery path is critical for on-prem; needs a concurrent live test before touching. Fix = a "recovering" flag so both callers get `SessionLostError`. |
| **B4** | **Row-removal events are best-effort.** `DataRowRemoved` handling was written defensively (no-op when the wire shape doesn't match) because the decompiled sources weren't reachable; it may silently do nothing, leaving a deleted row in `FormState.rows` → a later bookmark action can hit `InvalidBookmarkException`. | comment + `extractRowChanges` in [src/protocol/form-state.ts](../src/protocol/form-state.ts) | Capture a real `DataRowRemoved` frame (delete a row against `devel1`) or check `BrowserLogicalChangeTypeIds.cs`, then pin the exact shape. |
| **B5** | **Dynamic AL editability reported wrong.** On a page whose groups use `Editable = not <variable>`, `bc_write_data` returns `changed:false, reason:"not editable"` for every field even when the condition is false (observed on a custom Demo Card, BC-748). | live report; root cause unconfirmed | Investigate whether the Editable flag is read from a stale property or never re-evaluated after `LoadForm`. |
| **B6** | **Document pages: the default repeater is ambiguous.** With both a header and a lines repeater, omitting `section` resolves whichever repeater comes first, so a drill-down from a document list can use the wrong bookmarks. | `resolveSection(ctx, sectionId)` with `sectionId` optional in [src/services/navigation-service.ts](../src/services/navigation-service.ts) | Mostly mitigated: passing `section: "lines"` works. Proper fix = track header vs lines repeaters separately using the `DataLoaded` `controlPath`. |
| **B7** | **Report request-page captions are ES/CA/EN only.** The button dictionary ("Enviar a", "Send to", "Aceptar", "OK", …) fails silently on a German/French BC. | `clickByText([...])` in [src/services/report-download-service.ts](../src/services/report-download-service.ts) | Mitigated (the failure now returns an explicit `note` + `availableFilterLabels` instead of a misleading success). Real fix needs a non-Spanish BC to verify: match by role/position as well as caption. |
| **B8** | **Timezone/DST is hardcoded to Europe** (`dstOffset: 60`, last Sundays of March/October) in the OpenSession payload. | [src/protocol/interaction-encoder.ts](../src/protocol/interaction-encoder.ts) `lastSunday()` | Low impact (only the offset sent to BC), no easy test. Fix = derive from the host with `Intl.DateTimeFormat`, or make it configurable. |
| **B9** | **Sequence acking of synchronous responses is not fed back.** `lastServerSequence` only advances from async `Message` notifications. | [src/connection/bc-websocket.ts](../src/connection/bc-websocket.ts) | Latent, not active: mitigated because `encodeOpenSession` sends `disableResponseSequencing: true`. If that flag is ever removed, this must be fixed first. |
| **B10** | **`notifications/initialized` gets a JSON-RPC response over HTTP** (a frame without `id`). stdio — the primary transport — handles it correctly. | [src/mcp/handler.ts](../src/mcp/handler.ts) | Changing the HTTP contract is riskier than the bug. Fix = answer 204 for `notifications/*` on the `/mcp` path. |
| **B11** | **`buildServices({} as BCSession)`** builds the real service graph against a fake session just to harvest tool metadata. Not triggered today (no constructor touches the session) — a latent trap. | [src/stdio-server.ts](../src/stdio-server.ts) | Separate tool-metadata extraction from service construction. |
| **B12** | **`BC_BASE_URL` is only trailing-slash-trimmed**, never validated. A malformed value still fails late and opaquely at the WebSocket upgrade. | [src/core/config.ts](../src/core/config.ts) `requireEnv('BC_BASE_URL').replace(...)` | Validate with `new URL()` at load and fail with a clear message. |

---

## 4. Documentation & metadata drift (verified today)

These are wrong *right now* — the code moved and the prose didn't. Cheap to fix, actively misleading to agents.

| # | Where | What's wrong |
|---|-------|--------------|
| **D1** | [CLAUDE.md](../CLAUDE.md) | "Quick Start" still points at the upstream paths (`U:/git/bc-mcp`, `C:\bc4ubuntu\...`) and stale counters: "128 tests", "103 integration tests", "11 MCP tools". Real: **403** unit/protocol, **117** integration, **18** tools. The `cd U:/git/bc-mcp` in "Essential Commands" is actively wrong on this machine. |
| **D2** | [CLAUDE.md](../CLAUDE.md) | States reconnect defaults "4 retries / 1s"; the code is **6 retries / 2000 ms** ([src/core/config.ts](../src/core/config.ts)). |
| **D3** | [CLAUDE.md](../CLAUDE.md) "Known Limitations → Report Output Capture (Phase 6)" | Says report output cannot be captured and "Phase 6 will investigate". `bc_download_report` captures it out-of-band today; only the WS-side capture remains unimplemented. Reword. |
| **D4** | [README.md](../README.md) | The Claude Desktop badge and the `.dxt` download link point at **upstream** releases (`SShadowS/business-central-mcp`), which never ship this fork's build. |
| **D5** | [manifest.json](../manifest.json) | `name: "business-central-mcp"` while the package is `business-central-mcp-esanpons`. Also verify `entry_point` is actually unused at runtime. |

*Fixed during this consolidation (2026-08-09), listed so they are not re-filed:*
`bc_execute_action.md` claimed `rowIndex`/`bookmark` were ignored (they are honoured — the doc was
describing the pre-fix behaviour of a **destructive** action); `bc_navigate.md` still documented the
removed `lookup` action and `field` parameter; CLAUDE.md linked a non-existent
`docs/Plans/bc-ws-mejoras-bc744.md` and promised a `~/.claude/skills/bc-manual/` skill that does not
exist. **Docs only — no code was touched.**

---

## 5. Test coverage debt (verified today)

| # | Gap | Detail |
|---|-----|--------|
| **T1** | **Zero tests of any kind** for `object-index-service`, `bc_find_object`, `bc_refresh_objects` — the newest tools. Highest-value gap. | no matching file under `tests/` |
| **T2** | **Operations with no unit test**: `switch-company`, `wizard-navigate`, `health`, `list-companies`, `navigate`, `respond-dialog`, `run-report`, `close-page`, `find-object`, `refresh-objects`. | |
| **T3** | **Tools with no integration test**: `bc_find_object`, `bc_refresh_objects`, `bc_build_manual`, `bc_switch_company`, `bc_list_companies`, `bc_wizard_navigate` (the last only appears in the tool-list assertion). | use the skip-guard pattern from `tests/integration/screenshot.test.ts` |
| **T4** | **CI runs unit/protocol only** (typecheck + build + `npm run test` on Node 20/22/24). No job spins up a BC container, so the on-prem regression gate is manual. | `.github/workflows/ci.yml` |
| **T5** | **`tests/integration/mcp-endpoint.test.ts` cannot start its server here.** It spawns with `cwd: 'U:/git/bc-mcp'` — the **upstream author's path**, which does not exist on this machine — and with `shell: true`, so the failure surfaces as an unhandled `spawn cmd.exe ENOENT` after the run instead of a test failure, and all 3 tests silently skip. Fix: derive the repo root from `import.meta.url`, drop `shell: true`, and attach an `error` handler so a failed spawn fails the suite. | `tests/integration/mcp-endpoint.test.ts` lines 16-21; observed 2026-08-09 |

---

## 6. Environment reach (not started)

- **Windows authentication** — for domain-joined on-prem where NavUserPassword is off.
- **S2S / OAuth client-credentials REST mode** (`api/v2.0`) — unattended complement; covers API
  entities only, not arbitrary pages, actions, Tell Me, screenshots or manuals. Not a substitute.
- **BC29+ wire-compat verification** — re-verify each new BC version as it ships (BC27/BC28 are
  byte-identical today).
- **Multi-environment in one process** — today one server process = one BC (env-selected).
  Register two MCP servers (`bc-docker` + `bc-saas`) to have both.

## 7. Distribution & install ergonomics (not started)

- Cursor support (install badge + `~/.cursor/mcp.json` snippet).
- Interactive `npx business-central-mcp-esanpons init` wizard (detect hosts, prompt for creds, write config).
- Sign the `.dxt` once Claude Desktop signing stabilises.
- MCP marketplace publication.
- VSCode one-click `inputs` (prompt for `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` at install).

---

## 8. Non-bugs — do not re-file

Confirmed behaviour, documented so nobody spends time on them again:

- **`ApplicationArea`-gated fields are server-filtered.** Page-extension fields behind a
  non-`#All` Application Area are never sent by BC, so `bc_write_data` says "Field not found".
  Activate the area (page 9178) first. No client-side override exists.
- **`editable: "unknown"` is not read-only.** BC simply emitted no flag; attempt the write and
  branch on `changed`.
- **Tell Me is profile-scoped.** An empty result set usually means the connected `BC_PROFILE`
  has no index — not a transport failure. Set `BC_PROFILE` and reconnect.
- **Collapsed FastTabs / "Show more" affect screenshots only.** `bc_open_page` / `bc_read_data` /
  `bc_navigate` return every field regardless of the visual collapse state.
- **List filtering uses AL field NAMES** (`No.`, `Name`, `City`), never localized captions
  (`Nº`, `Nombre` raise a BC "token not found").
- **`bc_run_report` cannot return the rendered binary.** BC streams it on a separate channel;
  that is what `bc_download_report` is for.
- **bc-ws first, Playwright only as fallback.** When bc-ws can do the task, use bc-ws. Today the
  known reasons to fall back are G2 (create mode), G6 (document line screenshots) and B5 (dynamic
  editability).

---

## 9. Idea backlog (nothing started; rough effort in brackets)

**Agent ergonomics** — cap large outputs by default with `totalRowCount` + a hint [S–M] ·
self-correcting field/action errors with closest-match suggestions [S] · address records by
primary key instead of an opaque bookmark [M] · a `bc_help` capability/recipe index tool [S] ·
task recipes as skills (create customer, post order) [S each] · dry-run preview for writes [M] ·
read cache for repeated lookups [M].

**Data & productivity** — `bc_query` OData/API hybrid read engine for bulk paginated reads [L] ·
export a list to CSV/Excel/JSON [S–M] · bulk edit by filter [M] · templated record creation from
a spec/CSV [M] · cross-company reporting [M].

**Screenshots & visual** — record a workflow to video/GIF via CDP screencast [M] · visual
regression diffing [M] · print a card/list page to PDF [S] · accessibility audit with axe-core [M].

**Manuals & training** — templates & branding (logo, cover, header/footer) [S–M] · multi-language
manuals [M] · interactive HTML walkthrough [M] · field dictionary per page [S] · role-based manual
bundles [M] · checklists/quizzes from a process [S].

**Analytics** — charts from list data embedded in the manual [M] · KPI trends from Role Center
cues over time [M] · daily dashboard snapshot [S].

**AI-native** — fill a form from a document/email (invoice → order) [M–L] · natural language →
BC filters [M] · anomaly detection in a list [M] · reconciliation assistant [L].

**QA & upgrade safety** — smoke-test N pages [M] · synthetic monitoring on a schedule [M] ·
page-open timing to surface slow pages [S].

**AL developer toolkit** — AL object & metadata explorer [M] · run AL test codeunits (page
130401) [M–L] · telemetry/event-log reader [M] · test scaffolding generator [M] · permission-set
inspection [M] · RapidStart configuration packages [M–L].

**Migration & hygiene** — environment diff (dev vs prod) [M–L] · duplicate/blank detection [M] ·
anonymisation for test copies [M] · mass create from CSV [M] · configuration documentation [M].

**Integrations** — email/Teams a manual or screenshot [S–M] · upload to SharePoint/OneDrive [M] ·
push to Google Sheets / Excel Online [M] · webhooks for BC events [L].

**Safety** — audit log of writes for traceability [S–M].

---

## 10. How to keep this file honest

1. New finding → add a row here with the file/line that proves it, never in a new plan document.
2. Item done → delete the row and add a `CHANGELOG.md` entry. Do not leave "DONE" rows behind:
   that is exactly how the previous four documents drifted into contradicting each other.
3. Before trusting any row older than a release, re-check the cited file/line — the code moves.
