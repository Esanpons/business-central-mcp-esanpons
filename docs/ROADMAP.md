# Pending work — single source of truth

> **This file is the ONLY place where open work is tracked**: limitations, bugs, gaps, doc drift,
> test debt and the idea backlog. Anything not listed here is either done (see
> [`CHANGELOG.md`](../CHANGELOG.md)) or was verified as already done and removed.
>
> **Last full pass: 2026-08-09 (second pass, "revisió a fons").** A five-subsystem code review read
> every file in `src/` and produced ~60 verified findings; the bug and quality items were FIXED in
> that pass (see [`CHANGELOG.md`](../CHANGELOG.md)) and are therefore NOT listed here. What remains
> below is everything that was deliberately *not* built: capability gaps, ports from upstream,
> ecosystem adoption, and the idea backlog.
>
> **Companion documents (read these before planning anything):**
> - [`BASE-CONEIXEMENT-IA-BC.md`](BASE-CONEIXEMENT-IA-BC.md) — inventory of every external MCP /
>   agent / skill / toolchain in the BC+AI ecosystem, with URLs. The "what exists out there" map.
> - [`Plans/page-scripting.md`](Plans/page-scripting.md) — the full, exact plan for the Page
>   Scripting integration (§6 here is only the summary).
> - [`SAAS-EVIDENCE.md`](SAAS-EVIDENCE.md) — frozen record of the SaaS WebSocket discovery and the
>   Docker-vs-SaaS parity matrix. Holds **results**, never pending items.
>
> **Reading this without the protocol context?** [§12 "En clar"](#12-en-clar--què-vol-dir-cada-punt)
> explains every item in plain Catalan.

## 0. Verification snapshot

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` (unit + protocol) | **721 passed / 77 files** (263 added in the review pass) |
| `npm run test:integration` vs `devel1` (BC27) | **110 passed · 0 failed · 6 skipped** (19 files passed, 1 skipped). The skips are the BC28-only suites (§1) |
| `npm run verify:features docker` | **5 PASS · 0 FAIL · 1 SKIP** — the skip is B4, which now explains itself: this database has no sellable item to build the fixture from (§3) |
| `npm run verify:features saas` | **6 PASS · 0 FAIL · 0 SKIP** — fully green, including a line write and a confirmed line delete end to end. Also confirms the SaaS/AAD path re-worked in this pass (browser-leak fix, page-level WS capture, profile close sequencing, tenant-less report queries) |

Test counts are deliberately NOT frozen here — run the command.

---

## 1. Blocking gate — none

Two suites (`bc28.test.ts`, the second half of `multi-section.test.ts`) need a **second BC** and
skip cleanly unless `BC28_BASE_URL` (+ `BC28_USERNAME` / `BC28_PASSWORD`) is set. See **E3**.

---

## 2. Tool capability gaps (what an agent still cannot do)

| # | Gap | Evidence | Effort | Workaround today |
|---|-----|----------|--------|------------------|
| **G5** | **`bc_download_report` on SaaS.** The engine authenticates fine (`bc_screenshot` proves it), but the report deep-link (`?report=`) intermittently lands on BC's "Go back home" page and the SaaS request-page toolbar differs from the on-prem "Send to -> Aceptar" flow. On-prem unaffected. | SaaS battery | M | Use on-prem for downloads, or `bc_run_report` on SaaS. **Better fix: port the WS-side download capture — see F2, which bypasses the browser entirely.** |
| **G6** | **Document Lines screenshots — implemented, not verified live.** `revealAll` expands every collapsed section header and `clickBeforeCapture: ["Lines"]` names a toggle explicitly. Missing: a live capture proving a line caption (Quantity / Line Amount) is found and cropped on a real Sales Order. | [screenshot-service.ts](../src/services/screenshot-service.ts) | S | Run `bc_screenshot` on page 42 with `highlight: ["Quantity"]` and confirm `found:true`. |
| **G10** | **FactBox content read through the parent page can come back empty**, even though the section id is listed. | reported live (BC-748) | M | Open the FactBox by its own `pageId`, or request `sections:["factbox:<id>"]`. |
| **G11** | **`bc_screenshot` captures saved state only.** The out-of-band browser opens its own session on the stored record, so unsaved on-screen state cannot be documented. | by design | L | Save before capturing. Deferred idea: render `FormState` to HTML/PNG. |
| **G12** | **No file upload.** The headless browser never drives `<input type="file">`, and the WS-side `InvokeFileUploadAction` path is not implemented. | no upload path in `src/services/` | M | — (upstream has a spec for it: see F7) |
| **G13** | **AssistEdit (`SystemAction.AssistEdit=100`) is not reachable.** Distinct from field lookup (F1 covers lookup): AssistEdit opens the "..." helper form on fields like No. Series. Upstream notes `isLookup` currently conflates AssistEditAction with LookupAction. | `NavigateSchema` action enum | M | Write the value directly and check `changed`. |
| **G14** | **No cancellation of a long-running operation.** A posting routine that runs past `BC_INVOKE_TIMEOUT` kills the session instead of being waited on or cancelled. Upstream proved the mechanism (F8). | `composeWithTimeout` accepts an `externalSignal` nothing passes | M | Raise `BC_INVOKE_TIMEOUT`. |

---

## 3. Bugs and robustness gaps

The 2026-08-09 deep review found ~60 defects across the five subsystems (protocol decoding,
form-tree projection, page/section state, browser services, session/connection and the MCP
surface); all were fixed in that pass and written up in `CHANGELOG.md`. **One live check is still
red — B4, below** — plus the four deliberately-deferred items R1-R4. New findings go here with the
file/line that proves them — see §13.

### Behaviour changes from that pass worth re-checking live

None of these is a bug; they are deliberate corrections that change what a caller sees, so an
integration test or a stored recipe written against the old behaviour may need updating:

- **A part containing a repeater is now `subpage:<caption>`, not `lines`** (and no longer flips the
  page to `pageType: 'Document'`). Anything hard-coding `section: "lines"` for a *part* must use the
  subpage id. Real document line grids are unaffected.
- **`bc_execute_action` errors on a system action the page does not publish** instead of invoking
  `server:c[0]` and reporting success.
- **`FilterService.clearFilters` now errors on BC27/BC28**, matching `applyFilters`: the read-time
  filter pane is inert on these builds, so silently "succeeding" was a lie.
- **`bc_read_data` errors on an unmatched `tab`/`group`**; `bc_open_page` returns `warnings[]`
  instead (erroring would strand the page it just opened).
- **`bc_close_page` reports `success: false` when a save-changes dialog blocked the close.**
- **Disabled actions are listed** with `enabled: false` instead of being filtered out.
- **`bc_write_data` has two new `reason` values**, `already set` (idempotent write — counts as
  success) and `unverified` (BC confirmed nothing; `changed` is undefined).

Four items were **found during that review and deliberately left open**, because each changes
behaviour widely enough to deserve its own task rather than riding in as a side effect:

| # | Finding | Why it was left | What it needs |
|---|---|---|---|
| **R1** | **Repeater row-cell templates (`{repeater}/cr/c[N]`) are not in the tree.** `buildRepeater` never parses `rc.CurrentRow.Children`, yet the live captures show BC sending `PropertyChanged` on exactly those paths (e.g. `server:c[1]/cr/c[8]` in `captures/tell-me-result-2026-04-28.json`) — they no-op silently today. | Adding them would introduce nodes into `fields(root)` for **every list page**, materially shifting MCP output size and content. | Decide the DTO policy first (are row templates fields?), then parse + test against the captures. |
| **R2** | **`buildPathIndex` still has no caller in `src/`.** `buildSection` got a one-pass per-root index (memoised in a WeakMap) so it is no longer O(n²), but `isEffectivelyVisible` / `nearestGroupCaption` in `visibility.ts` / `form-tree-walk.ts` still walk the tree themselves. | Cross-file ownership during a parallel fix pass. | Thread the index through those two functions; the equivalence guard test added in `section-dto.test.ts` protects the refactor. |
| **R3** | **`bc_screenshot` still defaults `inline: true` at scale 2**, i.e. a multi-MB base64 block per capture even though the PNG is always written to disk. | Flipping the default is a visible contract change for anyone relying on the inline image. The new `RESPONSE_TOO_LARGE` / inline-image cap removes the *failure*, not the cost. | Decide whether to flip the default (recommended) or size-gate it automatically. |
| **R4** | **`BC_MAX_RESPONSE_CHARS` / `BC_MAX_INLINE_IMAGE_CHARS` are read straight from `process.env`** in the MCP handler instead of going through `AppConfig`. | Tidiness only; behaviour is correct. | Fold into `src/core/config.ts` with the other knobs. |

### B4 — line delete and line writes: solved on Docker, two SaaS follow-ups

The wire was traced live on `devel1` (2026-08-09) and the picture is fully understood:

1. **A real line delete WORKS (fixed in this pass, verified live).** On page 42 opened with
   `mode: "Edit"`, `Delete` on a populated line returns `InvokeCompleted + DialogOpened`
   ("Confirmar"). The post-delete re-sync used to fire immediately — and because the re-sync is
   itself an `InvokeAction`, it tore that modal down, so the caller's `bc_respond_dialog` died with
   `FormNotFoundException` and the line was never deleted. The re-sync now waits when a dialog is
   pending. Verified end to end: rows 18 → 17, the bookmark is gone in the original context **and**
   in a freshly reopened one.
2. **The battery's fixture was the other half.** Its scenario is a document opened with
   `mode: "Create"` whose line write never stuck, so there was no real line to delete and the check
   fell back to a row that merely *looks* populated (a BC blank placeholder carries defaults such
   as `Type`). BC ignores a delete on a placeholder: the trace shows `InvokeAction(20)` answered
   with a bare `InvokeCompleted` — no dialog, no change, no error. The line write itself was being
   **rejected by a business rule** that BC explained and this server discarded (see below).

**B4a–B4e are all closed** (see `CHANGELOG.md`). The investigation ended up disproving the premise:
the line-write and line-delete paths were never broken. What was broken was everything around
them — BC's explanation was discarded, a successful write could not be distinguished from an
ignored one, and the projection was not re-read after a confirmed delete.

- **B4a** — BC's `ValidationResults` are surfaced (`reason: "validation error"` + the message).
  `devel1` simply has no sellable item among the first 15 (*"Sale must be equal to 'Yes' in
  Item"*), which is exactly what the tool now says.
- **B4b** — the battery tries 15 candidate items, identifies placeholder rows by their
  `DraftRecord*` bookmark, and SKIPs with BC's own words instead of reporting a dataset fact as a
  code failure.
- **B4c** — a delete BC ignores reports `deleted: false` + a `note`.
- **B4d** — was never a caption problem: the battery wrote **two** keys (`No.` and `Nº`) and
  reported the missing one's `control not found`, masking the real key's outcome. It now reads the
  column caption the environment actually publishes.
- **B4e** — BC *was* deleting the row; `bc_respond_dialog` simply never re-read the repeater, so
  the projection kept listing it (proved by a fresh context showing 15 rows against the stale
  context's 16). Answering a dialog now re-syncs repeater-bearing sections
  ([repeater-sync.ts](../src/services/repeater-sync.ts), shared with the post-delete path).

**`verify:features saas` is now 6 PASS · 0 FAIL · 0 SKIP** — the first fully green SaaS run. Docker
is 5 PASS · 0 FAIL · 1 SKIP, the skip being the unsellable-items dataset above.

One more behaviour was investigated and deliberately left as-is:
- **Report request-page captions are matched by text** (ES/CA/EN dictionaries). A German or French
  BC would not match. Mitigated: an unmatched caption returns an explicit note plus
  `availableFilterLabels` / `availableFormats` instead of a misleading success. Real fix needs a
  non-Spanish BC to test against — match by role/position as well as caption.

---

## 4. Test coverage debt

| # | Gap | Detail |
|---|-----|--------|
| **T1** | **`bc_find_object` / `bc_refresh_objects` operations have no test.** The locale-resolution logic that broke them is covered ([object-index-columns.test.ts](../tests/unit/object-index-columns.test.ts)); the operations and the seek/merge loop are not. | highest-value remaining gap |
| **T2** | **Operations with no unit test**: `switch-company`, `wizard-navigate`, `health`, `list-companies`, `navigate`, `respond-dialog`, `run-report`, `close-page`, `find-object`, `refresh-objects`. | |
| **T3** | **Tools with no integration test**: `bc_find_object`, `bc_refresh_objects`, `bc_build_manual`, `bc_switch_company`, `bc_list_companies`, `bc_wizard_navigate`. | use the skip-guard pattern from [screenshot.test.ts](../tests/integration/screenshot.test.ts) |
| **T6** | **Report format/parameter selection has no automated cover** — it drives a real browser against a real request page, so it is only exercisable live. | needs a recorded request page or a DOM fixture |
| **T7** | **The browser-driving services are structurally untestable today.** `ScreenshotService` / `ReportDownloadService` take a live `puppeteer` page; there is no seam for a fake. Introducing a minimal page interface would make the caption-matching, reveal and crop logic unit-testable. | M |

CI runs typecheck + build + unit/protocol on Node 20/22/24. The integration gate exists as a
`workflow_dispatch` / `run-integration`-labelled job on a self-hosted runner
(`.github/workflows/ci.yml`) — it needs a runner that can reach BC before it will actually run.

---

## 5. Upstream parity — what to port from `SShadowS/business-central-mcp`

> **Why this section exists.** This repo forked just before upstream's v1.1.0 (~June 2026).
> Upstream is now at **v1.5.0 (2026-07-25)** and shipped a lot of capability on the SAME protocol.
> Nothing here is speculative: it is running code with live-verified protocol notes.
> Repo: https://github.com/SShadowS/business-central-mcp ·
> [CHANGELOG](https://github.com/SShadowS/business-central-mcp/blob/master/CHANGELOG.md) ·
> [gap-analysis spec set](https://github.com/SShadowS/business-central-mcp/tree/master/docs/superpowers/specs)
>
> **Porting caveat:** upstream went through a CQRS/god-file refactor in June 2026 (tool definitions
> colocated as `*.tool.ts`, `PageContextRepository` split), so these are re-implementations against
> this tree, not clean cherry-picks. Our fork additionally has SaaS/AAD, screenshots, manuals,
> object index and payload control that upstream lacks — do not "sync" wholesale.

| # | What | Why it matters here | Effort |
|---|---|---|---|
| **F1** | **`bc_lookup`** — enumerate FK candidate values via the BC Lookup protocol. | Closes the single biggest functional hole: fields that only accept values from a related table currently must be written blind. | M |
| **F2** | **WS-side file capture** — report bytes inline plus a generic `downloads[]` on `bc_execute_action` / `bc_respond_dialog` / `bc_wizard_navigate` / `bc_run_report`. | Captures "Open in Excel", Print and any export; and **very likely fixes G5 (SaaS report download)** because it never touches the flaky deep-link. Also retires the "Report Output Capture — WS path missing" limitation in CLAUDE.md. | L |
| **F3** | **Multi-row selection** — `bc_execute_action { bookmarks: string[] }`. | Bulk actions/deletes in one invoke, with an honest `MULTI_ROW_ACTION_UNAVAILABLE` when the page disables them. | M |
| **F4** | **`options` / `selectedOption` on option/enum/boolean fields.** | Agents stop guessing valid option values. Cheap, high value. | S |
| **F5** | **`bc_read_data` `sort`** (and `clearFilters`). | Rounds out read shaping next to our `filters`. | S |
| **F6** | **`bc_query`** — OData API v2.0 bulk reads (`$filter/$select/$orderby/$top/$expand`, `hasMore` + `@odata.nextLink`). | The web-client repeater is the wrong vehicle for thousands of rows; directly attacks the token-budget problem. Out-of-band, like `bc_screenshot`. | L |
| **F7** | **File upload** (`InvokeFileUploadAction`) — closes **G12**. Upstream has a spec, gated on a live capture. | Attachments, incoming documents, pictures. | M |
| **F8** | **`IsExecuting` polling for long-running operations** — closes **G14**. Upstream's "Gate A" probe proved `/csh` answers a concurrent `IsExecuting` in **1-4 ms**, so polling can replace the absolute invoke timeout and makes a `bc_cancel_operation` cheap. | Posting routines currently die on a timeout instead of being awaited. | M |
| **F9** | **MCP prompt workflows** — 9 templates (`bc_find_page`, `bc_read_list`, `bc_edit_record`, `bc_create_document`, `bc_post_document`, `bc_set_dimensions`, `bc_report`, `bc_bulk_read`, `bc_run_wizard`). | Our `prompts/list` is stubbed empty. Low-risk polish; adapt to our extra tools. | S |
| **F10** | **`stateVersion` / `expectedStateVersion` staleness guard** (`STALE_CONTEXT` error). | Lets a caller detect that a page context moved under it. | M |

### Protocol details already verified by upstream (do not re-derive)

These save real time when implementing the above. All are upstream's live findings:

- **Lookup flow** (verified BC28, Customer Card page 21, Salesperson Code): validate
  `hasLookup` -> ensure edit mode (`InvokeAction Edit=40` if read-only) -> `InvokeAction(Lookup=110)`
  on the field controlPath -> the `LookupFormReady` event is decoded as a `FormCreated` -> **rows
  arrive INLINE in the control tree** under `rc.Data.Rows.LoadedRows` (array of
  `{ bookmark, cells: { "<binderName>": { stringValue } } }`), NOT via separate `DataLoaded`
  events -> optionally filter -> **always** `InvokeAction(LookupCancel=340)` in a finally block so
  the flow is non-mutating. Note: `LoadForm(loadData:true)` on a lookup form returns only
  `InvokeCompleted` — do not wait for `DataLoaded`.
- **Sorting** uses **`SystemAction 470` (SortColumn)**; the `rcc` column node is resolved by caption
  match (same pattern as our FilterService). A successful sort resets the BC viewport to the top,
  so scroll ranges must be re-materialized afterwards.
- **Multi-row selection** encodes `SetCurrentRowAndRowsSelection` with
  `{ key, selectAll:false, rowsToSelect:[...], unselectAll:true, rowsToUnselect:[] }` and sends it
  **atomically with the action** via an `invokeSequence` (two interactions, one invoke). A
  page-disabled multi-row action shows up as `Enabled=false` on the SELECT half.
- **Downloads** must sanitize the server-supplied filename before it touches the filesystem (strip
  both separator styles, collapse `..`, drop control characters, fall back to a synthetic name),
  cap total bytes, and enforce a same-origin guard against SSRF.
- **BC 28.3 `/csh` 403**: the NST added a `RequestOriginValidationMiddleware`; the WS upgrade must
  send an `Origin` header on-prem too, not only on SaaS. (Fixed here in the 2026-08-09 pass.)

---

## 6. Page Scripting — record/replay integration (WANTED, not started)

> **Full plan: [`Plans/page-scripting.md`](Plans/page-scripting.md).** That document holds the
> format details, the exact `bc-replay` invocation, the three proposed tools, the implementation
> order and the known risks. This is the summary only.

Microsoft's **Page Scripting** (built into the BC web client: Settings -> Page Scripting) records
UI interactions **at AL semantics level** — `page:` + `field:` targets, not CSS selectors — into an
editable, documented **YAML** with parameters, validation steps, conditionals and sub-script
includes. **`@microsoft/bc-replay`** is Microsoft's official Playwright-based replayer, usable from
CI and from AL-Go pipelines, with `-Authentication Windows|AAD|UserPassword`.

Why it is the highest-leverage idea in this file: this MCP already performs exactly those
interactions. Exporting them to that YAML turns **every agent session into a durable, first-party
UAT regression test** that a human can edit in BC's own recorder. Nobody in the ecosystem connects
the two (the alguidelines catalog has no entry in this niche).

Proposed tools: **`bc_export_page_script`** (emit YAML from a recorded interaction trace),
**`bc_run_page_script`** (replay and report pass/fail per step — wrap `bc-replay` first, native WS
interpreter later), **`bc_validate`** (assert a control value; maps 1:1 to YAML validation steps).

- Docs: https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting
- Replayer: https://www.npmjs.com/package/@microsoft/bc-replay
- CI/pipelines: https://learn.microsoft.com/en-us/dynamics365/release-plan/2024wave2/smb/dynamics365-business-central/run-page-scripts-pipelines-automated-testing
- Community precedent (MIT — variant generation, TOTP MFA, AI-authored YAML): https://github.com/andywingate/D365BC-vibe-page-scripting

**Step 0 before any code:** record 3 real flows on `devel1` and keep the `.yml` as fixtures under
`tests/recordings/page-script-*.yml`. Without the verified schema, the exporter is speculation.

---

## 7. A specialised testing agent for AL / Business Central (WANTED, not started)

Microsoft published **`code-testing-generator`**, an open-source agent specialised in generating
and validating unit tests. It is **not a new model**: it is an agent that follows a workflow —
analyse the project, identify the testing framework, generate tests, **run them**, read the
failures, fix them. Microsoft's internal numbers: **92.1% of tasks completed** vs **78.9%** for
plain GitHub Copilot, and roughly **63% fewer failures**; it was tested across several models, so
most of the gain comes from the agent's *specialisation*, not the model.

- Announcement: https://devblogs.microsoft.com/dotnet/polyglot-unit-testing-agent/
- Repo: https://github.com/dotnet/skills

**What we want to build from it.** The same generate -> run -> read failures -> fix loop, but
producing artefacts that validate Business Central:

1. **AL test codeunits** — the classic path: generate `[Test]` procedures in the customer's test
   app, run them (via the AL MCP's `al_run_tests`, or `bc-dev-mcp` which drives the development
   endpoint with coverage), read the failures, fix. This repo is not the executor, but it *is* the
   thing that can verify the resulting behaviour through the UI.
2. **Page Scripting YAML** (§6) — the UI/UAT half of the same idea: this MCP drives the flow, the
   agent asserts the outcome, and the export becomes the regression test. `bc_validate` is the
   shared primitive between both halves.
3. **The closed loop** — generate, execute against `devel1` or a sandbox, read what actually
   happened (`changed`, dialogs, `bc_validate` results), and correct. That last step is exactly
   what this MCP provides and what a code-only agent cannot do.

Related prior art worth reading before designing it: ALDC's TDD "Conductor" agent
(https://github.com/javiarmesto/ALDC-AL-Development-Collection) and FBakkensen's `al-agentic-dev`
plugin (https://github.com/FBakkensen/bc-agentic-dev-tools-marketplace).

---

## 8. Ecosystem adoption — ideas proven elsewhere

> Sourced from the 2026-08-09 survey of every open-source BC MCP / agent / skill.
> Full inventory with URLs: [`BASE-CONEIXEMENT-IA-BC.md`](BASE-CONEIXEMENT-IA-BC.md).

| # | Idea | Proof it works | Effort |
|---|---|---|---|
| **A1** | **Safety tiers + two-phase destructive confirmation.** `BC_MCP_MODE=read\|write`; destructive invocations (Delete=20, posting) return a preview plus a confirmation token that must be echoed back. Plus an append-only audit log of every write. | user-vik's server does exactly this (read/write/destructive env gates, dry-run then token apply, stderr audit log); Microsoft's in-product MCP is read-only by default with per-page Allow flags. https://github.com/user-vik/business-central-mcp-server | S-M |
| **A2** | **`bc_knowledge` — ship the operating knowledge as a searchable tool.** Our hard-won rules (AL field names vs captions in filters, duplicate-caption targeting via controlPath, always branch on `changed`, document multi-repeater caveats, the screenshot/manual decision table) live in `CLAUDE.md` and `docs/guides/`, where only THIS repo's agent sees them. As a tool over layered markdown, any MCP client benefits. | bc-code-intelligence-mcp's layered knowledge base (embedded base layer + company/project overrides). https://github.com/JeremyVyska/bc-code-intelligence-mcp | M |
| **A3** | **Admin plane as a second server (`bc-admin`).** Environments, apps, update windows, storage, feature flags, PTE upload — and **kill hung sessions**, which would even help our own session recovery. Our AAD browser profile already authenticates to Entra; it needs an Admin API token minted from it. | YAMPI (MIT, Node, 34 tools) https://github.com/demiliani/D365BCAdminMCP · Microsoft's preview server validates the endpoint list https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/administration-center-api-mcp | M |
| **A4** | **`bc_list_open_pages`.** `PageContextRepository.listPageContextSummaries()` already exists but is only used inside error messages — the model must FAIL a call to discover what is open. | internal; trivial | S |
| **A5** | **Join `bc_search_pages` results against the object index.** Tell Me returns AL names; `ObjectIndexService` maps name -> id one constructor away. Returning `pageId` directly removes a whole model round-trip. | internal | S |
| **A6** | **Report data as rows, not files.** BC's API exposes report entities (aged AR/AP, trial balance, balance sheet) as queryable data. Agents usually want the numbers, not a PDF. Rides on F6. | MS-Cloud-Experts ships 11 such tools https://github.com/MS-Cloud-Experts/mcp-business-central | M |
| **A7** | **Entity/field schema introspection.** Extend `bc_find_object` with field-level metadata (types, key fields) so an agent can plan a write before opening a page. | knowall-ai `get_schema`, olederkach `get_resource_schema` | M |
| **A8** | **Secrets from the OS credential store** instead of plaintext `.secrets/*.env`. | BC-Agent-Manager's design (Windows Credential Manager via `keyring`) | S-M |
| **A9** | **Publish as a Claude Code plugin / marketplace entry, and list on alguidelines.dev.** The UI-automation slot in the community catalog is empty. | FBakkensen's marketplace repo is a working template; ALDC ships `.github/` + `.claude/` + plugin projections | S |
| **A10** | **A "which BC MCP for what" positioning doc** so agents route correctly when several are registered (this UI server vs Microsoft's API MCP vs symbol-level servers vs bc-dev-mcp). | — (a draft table already exists at the end of `BASE-CONEIXEMENT-IA-BC.md`) | S |
| **A11** | **`bc_query_telemetry`** — KQL against Application Insights (event catalog discovery, per-event schema, results as file references). Lower priority: waldo's MIT tool already does this well; recommending it alongside may be smarter than absorbing it. | https://github.com/waldo1001/waldo.BCTelemetryBuddy | M |

---

## 9. Environment reach (not started)

- **E1 — Windows authentication** — for domain-joined on-prem where NavUserPassword is off.
- **E2 — S2S / OAuth client-credentials REST mode** (`api/v2.0`) — unattended complement; covers
  API entities only, not arbitrary pages, actions, Tell Me, screenshots or manuals. See F6.
- **E3 — BC29+ wire-compat verification** — re-verify each new BC version as it ships (BC27/BC28
  are byte-identical today; BC 28.3 already needed the Origin header — see §5).
- **E4 — Multi-environment in one process** — today one server process = one BC (env-selected).
  Register two MCP servers (`bc-docker` + `bc-saas`) to have both. NOTE: the object index is now
  environment-stamped, so a shared cwd no longer serves the wrong environment's objects.

## 10. Distribution & install ergonomics (not started)

- **P1** — Cursor support (install badge + `~/.cursor/mcp.json` snippet).
- **P2** — Interactive `npx business-central-mcp-esanpons init` wizard.
- **P3** — Sign the `.dxt` once Claude Desktop signing stabilises.
- **P4** — MCP marketplace publication (see also A9).
- **P5** — VSCode one-click `inputs` (prompt for `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD`).

---

## 11. Non-bugs — do not re-file

- **`ApplicationArea`-gated fields are server-filtered.** Page-extension fields behind a non-`#All`
  Application Area are never sent by BC, so `bc_write_data` says "Field not found". Activate the
  area (page 9178) first.
- **`editable: "unknown"` is not read-only.** BC emitted no flag; attempt the write and branch on
  `changed`.
- **Tell Me is profile-scoped.** An empty result set usually means the connected `BC_PROFILE` has
  no index — not a transport failure. A brand-new sandbox commonly returns 0; use `bc_find_object`.
- **Collapsed FastTabs / "Show more" affect screenshots only.** `bc_open_page` / `bc_read_data` /
  `bc_navigate` return every field regardless of the visual collapse state.
- **Main-list filters use AL field NAMES** (`No.`, `Name`, `City`), never localized captions.
  Line/subpage filters are the opposite — they match the column CAPTION, because they run
  client-side over the rows you can see.
- **Page 9174's columns are localized.** Anything reading them must resolve columns per locale.
- **BC does not reliably announce a deleted row.** Re-sync the repeater instead of waiting for a
  removal event.
- **`isLookup` / `showMandatory` are not populated on BC27 (`devel1`).** Presentational hints; no
  tool behaviour depends on them. The plumbing that reads them is intact, so a build that emits
  them still surfaces them. (Note: upstream reports `isLookup` conflates AssistEdit with Lookup —
  relevant when implementing F1/G13.)
- **`bc_run_report` cannot return the rendered binary** *today* — BC streams it on a separate
  channel. That is what `bc_download_report` is for, and **F2 is the proper fix**.
- **The AAD Chrome profile cannot be shared by two live processes.** `BC_AAD_PROFILE_DIR` is a
  persistent Chrome profile and Chrome locks it to one instance: if Claude and Codex both hold a
  running server wanting a screenshot, the second fails. Use one at a time, or separate profile
  dirs per client.
- **stdio request handling is concurrent by design.** Responses interleave; JSON-RPC allows it and
  each write is atomic. Do not "fix" it into an await-chain that would serialize behind slow BC
  calls.

---

## 12. En clar — què vol dir cada punt

> Explicació en llenguatge planer, per poder decidir sense llegir codi. Les taules manen.

**Els errors s'han arreglat.** La revisió del 09/08/2026 va llegir tot el codi per subsistemes i va
trobar una seixantena de defectes reals — des de missatges d'error de BC que es descartaven en
silenci fins a filtres amb apòstrof que destruïen la pàgina oberta. Tots estan corregits i escrits
al `CHANGELOG.md`. El que queda en aquest fitxer és **el que no s'ha construït mai**.

**El cas B4, resolt i explicat.** Semblava que "no es poden escriure ni esborrar línies". Traçant
el cable contra `devel1` van sortir dues coses molt diferents:

1. **Esborrar una línia real fallava per culpa nostra.** BC obre un diàleg de confirmació, i el
   refresc automàtic que fem després de l'esborrat el destruïa abans que ningú el pogués respondre.
   Arreglat i comprovat: files 18 → 17, i la fila ja no hi és ni tornant a obrir la pàgina de zero.
2. **Escriure línies SÍ que funciona.** El que passava és que **BC les rebutjava i nosaltres ens
   menjàvem el motiu**: BC no dóna error, adjunta l'explicació al costat del camp
   (*"Sale ha de ser 'Sí' a Item: No.=0000001"* — o sigui, aquell article no és vendible). Cap dels
   15 primers articles d'aquesta base de dades ho és. Ara aquest missatge arriba al qui crida
   (`reason: "validation error"` + el text literal de BC), i la bateria prova diversos articles i,
   si cap no serveix, ho diu amb les paraules de BC en comptes de fer veure que el codi està
   trencat. `verify:features docker` ja és **5 PASS · 0 FAIL · 1 SKIP**.

3. **I a SaaS la fila esborrada seguia sortint** perquè, després de respondre el diàleg de
   confirmació, ningú tornava a llegir la graella. BC sí que havia esborrat (obrint la pàgina de
   nou només hi havia 15 files, no 16). Ara respondre un diàleg torna a sincronitzar les graelles.

També s'ha afegit que un esborrat que BC ignora ho digui (`deleted: false` + explicació) en comptes
de retornar només "correcte", i que una escriptura de línia confirmi el seu efecte — abans **mai**
deia si havia funcionat, així que ni la nostra pròpia bateria ho podia saber.

Resultat: `verify:features saas` és **6 PASS · 0 FAIL** per primer cop, i Docker 5 PASS · 0 FAIL amb
un SKIP que s'explica sol (aquesta base de dades no té cap article vendible per muntar la prova).

Quatre coses més que van sortir a la revisió es van deixar obertes a posta (R1-R4 a §3), perquè
canviarien massa coses de cop: afegir les cel·les plantilla de les graelles a l'arbre (faria créixer
la sortida de TOTES les llistes), acabar d'endollar l'índex de camins a les dues funcions que encara
recorren l'arbre senceres, i decidir si les captures han de continuar tornant la imatge incrustada
per defecte. També hi ha una llista de **canvis de comportament** a §3 que val la pena repassar en
viu: el més notable és que una part amb graella ja no es diu `lines` sinó `subpage`.

**§2 — el que encara no es pot fer.** Descarregar informes al núvol (G5, però F2 probablement ho
resol de rebot), fotografiar línies de document sense verificar en viu (G6), llegir requadres
laterals des de la pàgina mare (G10), fotografiar el que no s'ha desat (G11, per disseny), pujar
fitxers (G12), prémer el botó "..." d'ajuda d'un camp (G13) i cancel·lar una operació llarga (G14).

**§5 — el fork va endarrerit respecte de l'original.** Aquest repo es va bifurcar just abans que
l'original (SShadowS) publiqués cinc versions de funcionalitat nova sobre el MATEIX protocol. Val
molt la pena portar-ne: la lupa dels camps (F1), la captura de fitxers per WebSocket (F2 — que a
més arregla el problema d'informes al núvol), accions sobre diverses files alhora (F3), els valors
vàlids dels camps d'opció (F4), ordenar llistes (F5), lectures massives per OData (F6), pujar
fitxers (F7) i esperar operacions llargues en comptes de matar-les (F8). La secció inclou els
detalls de protocol que ells ja han verificat en viu, per no haver-los de tornar a descobrir.

**§6 — Page Scripting: el que més m'interessa i encara no toca.** BC porta un gravador integrat que
desa el que fas en un YAML editable, i Microsoft manté un reproductor oficial que l'executa en CI.
Com que aquest MCP fa exactament aquestes mateixes accions, es poden EXPORTAR: cada sessió d'agent
es convertiria en un test de regressió de veritat, editable per una persona dins del mateix BC.
Ningú ho fa. El pla exacte és a `Plans/page-scripting.md`; el primer pas no és programar, és gravar
tres fluxos reals per saber el format exacte.

**§7 — un agent que escrigui proves.** Microsoft ha publicat un agent open source que genera tests,
els EXECUTA, llegeix què ha fallat i ho corregeix — i guanya un 13% al Copilot normal amb els
mateixos models, o sigui que el mèrit és de l'especialització, no del model. La idea és fer-ne
l'equivalent per a BC: que generi test codeunits AL i/o scripts de Page Scripting, els executi
contra `devel1` i es corregeixi sol. Aquest MCP és la peça que li permet COMPROVAR què ha passat de
debò a la interfície, cosa que un agent només de codi no pot fer.

**§8 — idees que ja funcionen a altres llocs.** Les dues més valuoses: nivells de permís amb
confirmació en dos passos per a les accions destructives (A1), i convertir el coneixement operatiu
que avui està tancat al `CLAUDE.md` en una eina consultable (A2). Després, el pla d'administració
com a segon servidor (A3), i dues coses barates i immediates: dir quines pàgines hi ha obertes (A4)
i que la cerca retorni directament l'ID de pàgina (A5).

**§9 i §10 — abast i distribució.** Entrar amb usuari de Windows (E1), una via desatesa per API
(E2), comprovar cada versió nova de BC (E3 — BC 28.3 ja va necessitar un canvi), i les feines de
facilitar la instal·lació a tercers (P1-P5), que **només importen el dia que es doni a gent de
fora**.

---

## 13. How to keep this file honest

1. New finding → add a row here with the file/line that proves it, never in a new plan document.
2. Item done → delete the row and add a `CHANGELOG.md` entry. Do not leave "DONE" rows behind.
3. Before trusting any row older than a release, re-check the cited file/line — the code moves.
4. Adding, closing or renaming an item → update its entry in [§12](#12-en-clar--què-vol-dir-cada-punt)
   in the same edit. A plain-language section that lags behind the tables is worse than none.
5. External tools/URLs belong in [`BASE-CONEIXEMENT-IA-BC.md`](BASE-CONEIXEMENT-IA-BC.md), not here.
   This file references them; it does not duplicate them.
