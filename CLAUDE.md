# BC MCP Server v2

> **Fork (AESVA / Esanpons).** This is a fork of `SShadowS/business-central-mcp`. It adds one fix
> required to connect to a BC 27 (ltsc2025) on-prem container using `NavUserPassword`: the
> `navigationContext.applicationId` sent in `OpenSession` must be **`NAV`**, not `FIN`. With `FIN`,
> the server throws `NavCancelCredentialPromptException` on the first `OpenSession` even though HTTP
> auth and the WebSocket handshake both succeed. Made configurable via `BC_APPLICATION_ID` (default
> `NAV`). See **OpenSession applicationId** under BC Protocol Patterns. Verified against the live
> `devel1` container (see BC Test Environments).

## Development Philosophy

This project is NOT released and in active development:
- Always choose the best solution, not the quickest compromise
- Refactor aggressively when architecture is flawed
- Fix problems properly, not with workarounds
- No stubs, mocks, or skeleton implementations -- everything must be fully functional
- No backwards compatibility concerns -- make breaking changes freely

## Quick Start

### Project Location
- **This fork (the working copy)**: `D:/Proyectos/Aesva/business-central-mcp-esanpons/`
- **Upstream reference paths** (`U:/git/bc-mcp/`, `C:\bc4ubuntu\Decompiled\...`) belong to the
  upstream author's machine and **do not exist here**. The decompiled BC assemblies are NOT
  vendored in this repo: there is no `reference/` directory. Any protocol claim that cites a
  decompiled file is inherited from upstream — re-verify it live (see Protocol Verification
  Procedure) rather than assuming the source is on disk.

### BC Test Environments

Upstream's environments (`cronus27` / `cronus28`, user `sshadows`) are **not reachable from this
fork**. The two environments this fork is actually verified against are below; credentials live in
`.secrets/devel1.env` and `.secrets/saas.env` (gitignored), which every live script loads.

| | Docker (`devel1`) | SaaS (BC Online) |
|---|---|---|
| Base URL | `https://devel1/BC` (HTTPS, self-signed) | `https://businesscentral.dynamics.com/{aadTenantId}/{environment}` |
| Auth | NavUserPassword (`BC_AUTH` unset) | Entra/AAD browser profile (`BC_AUTH=AAD`) |
| applicationId | `NAV` | `FIN` (mode default) |
| Env file | `.secrets/devel1.env` | `.secrets/saas.env` |
| Live check | `npm run test-battery docker` | `npm run test-battery saas` |

Both are exercised by the same harness (`scripts/lib/harness.ts`), so any live script takes
`docker` | `saas` as its first argument and needs no other change.

**A second BC (BC28) is optional.** Two integration suites (`bc28.test.ts` and the BC28 half of
`multi-section.test.ts`) re-check BC27-vs-BC28 wire compatibility. They are skipped unless you
point them at a real BC28 with `BC28_BASE_URL` (+ `BC28_USERNAME` / `BC28_PASSWORD`). Upstream
hardcoded `http://cronus28/BC`, which made them fail on every run here for no useful reason.

### Fork environment (AESVA `devel1`)

Local Docker container `devel1` (`mcr.microsoft.com/businesscentral:ltsc2025`, BC 27):

| | devel1 |
|---|---|
| Base URL | `https://devel1/BC` (HTTPS, self-signed) |
| Username | `admin` |
| Auth | NavUserPassword |
| applicationId | **`NAV`** (see OpenSession applicationId) |
| TLS | self-signed — set `BC_TLS_INSECURE=1` (scoped to this server's BC connections: WebSocket, `/SignIn`, headless browser). `NODE_TLS_REJECT_UNAUTHORIZED=0` still works but disables TLS verification for the WHOLE process, Entra logins included |

Server config read from the container: `ClientServicesCredentialType=NavUserPassword`,
`PublicWebBaseUrl=https://devel1/BC/`. The WebSocket is `wss://devel1/BC/csh`.

### Essential Commands
```bash
npx tsc --noEmit                     # Type check
npx vitest run                       # Unit + protocol tests
npm run test:integration             # Integration tests against real BC (devel1 must be up)
npm start                            # HTTP server on port 3000
npm run start:stdio-direct           # Direct stdio for Claude Desktop

npm run test-battery docker          # Full 19-tool functional battery vs devel1
npm run test-battery saas            # Same battery vs BC Online (needs the AAD profile)
npm run objects:refresh -- saas --all # Rebuild .state/object-index.json (bc_find_object's index)
npm run login:aad                    # One-time interactive Entra sign-in for SaaS
```

Test counts move with every change, so they are deliberately NOT written here — run the command.
`docs/ROADMAP.md` §0 carries the last measured snapshot with its date.

### Rules
- Use Windows paths with forward slashes in bash
- NEVER use `2>nul` (creates undeletable files on Windows)
- NEVER use emojis -- Windows rendering issues
- Always run `npx tsc --noEmit` after changes
- Run integration tests after any protocol-level change
- ESM project -- use `.js` extensions in all imports
- NEVER commit generated output -- see "What is generated vs versioned" below

### What is generated vs versioned

Running the tools and scripts writes real files into the working tree. Almost all of it is
reproducible and must stay OUT of git; `.gitignore` is the enforcement point and every rule
there carries the comment explaining WHY. Before adding a file to git, ask which bucket it is in:

| Bucket | Examples | Rule |
|---|---|---|
| Reproducible output | `screenshots/`, `.arxius/` (reports), `manuals/battery-*`, `manuals/e2e-smoke*`, `manuals/_verify/`, `.poc/`, `.report-capture/`, `logs/`, `tests/recordings/page*.json` | Never commit. Regenerate by re-running the tool |
| Credentials / live session | `.secrets/`, `.state/aad-profile/` | Never commit, ever |
| Regenerable cache | `.state/object-index.json` | Never commit (`bc_refresh_objects` rebuilds it) |
| Fixture a test READS | `tests/recordings/cdo-wizard-*.json`, `manuals/crear-client-img/*.png` (input to `npm run verify:manual`), `src/protocol/captures/*` | Commit, and keep the consumer discoverable |

Two dirs are versioned but receive test output, so they use an explicit allow-list in
`.gitignore` (`manuals/*` + `!` exceptions, and `tests/recordings/page*.json`). Adding a `!`
exception means asserting the file is documentation or a fixture -- not the output of a run.

`scripts/` is for repeatable tooling, not for one-off probes. A script that answered a question
once has served its purpose: fold the finding into code, a test, or a doc, then delete the
script. Everything under `scripts/` should be either wired into `package.json` or documented
here as a live diagnostic.

Two gotchas that have already bitten this repo:
- In `.gitignore`, git only treats `#` as a comment at the START of a line. A trailing comment
  becomes part of the pattern and silently disables it.
- `package.json` `"files": ["dist/"]` is what bounds the npm tarball. There is no `.npmignore`
  (it was inert and stale); do not reintroduce one -- change `files` instead.

## Protocol Verification Procedure

**CRITICAL: Always verify protocol behavior against decompiled BC source, not v1 code.**

V1 had several incorrect assumptions (per-page connections, SaveValue not echoing, etc.). When implementing or debugging any BC protocol interaction:

1. **Check the decompiled BC source first** if you have a copy (NOT vendored in this repo — see Project Location). Otherwise verify live against `devel1`/SaaS and record the evidence.
2. Use v1 (`C:\bc4ubuntu\Decompiled\bc-poc\src\`) as a secondary reference only
3. If v1 and decompiled code disagree, trust the decompiled code
4. Document which decompiled file/class confirmed the behavior

Key decompiled assemblies:
- `Microsoft.Dynamics.Framework.UI/` -- Core UI framework (controls, forms, interactions, observers)
- `Microsoft.Dynamics.Framework.UI.Web/` -- Web serialization (ResponseManager, handler types, change serializers)
- `Microsoft.Dynamics.Nav.Service.ClientService/` -- WebSocket server-side handler
- `Microsoft.Dynamics.Nav.Types/` -- BC type system, VersionCompatibility

## Architecture Overview

```
connection/ -> protocol/ -> session/ -> services/ -> operations/ -> mcp/ + api/
```

### Single Connection Per Session
BC supports multiple forms on one WebSocket connection, tracked by `formId` in each interaction and `openFormIds` in each request. Verified from decompiled `UISession.openedForms` dictionary.

The v1 "per-page connection" was a workaround for an `openFormIds` tracking bug, not a BC requirement.

### Event-Driven Protocol
BC sends handler arrays as responses. The EventDecoder transforms these into typed `BCEvent[]`. State is derived from events via `FormProjection` into per-form `FormState`, coordinated by `PageContext`.

### Invoke Queue
All invokes are serialized via a promise queue in `BCSession`. BC's protocol is stateful -- concurrent sends corrupt sequence numbers.

### Session Lifecycle
`SessionManager` (`src/session/session-manager.ts`) owns lazy session creation and dead-session recovery with exponential backoff (1s, 2s, 4s, 8s). Server entry points (`server.ts`, `stdio-server.ts`) use it instead of managing sessions directly. When a dead session is detected, all page contexts are cleared and `SessionLostError` is thrown. `LogicalModalityViolationException` (stale modal state from crashed sessions) is handled with the same retry logic. License/evaluation dialogs are auto-dismissed during session init.

Configurable via env vars: `BC_INVOKE_TIMEOUT` (default 30s), `BC_RECONNECT_MAX_RETRIES` (default 6), `BC_RECONNECT_BASE_DELAY` (default 2000ms), `BC_PROFILE` (BC profile id e.g. `BUSINESS MANAGER`; empty = server default — see Tell Me Search section).

## BC Protocol Patterns (Verified from Decompiled Source)

### OpenSession Handshake (Required)
Every session starts with an `OpenSession` RPC that returns `ServerSessionId`, `SessionKey`, `CompanyName`. All subsequent `Invoke` calls must include these fields plus `tenantId`, `navigationContext`, `features`, `supportedExtensions`.

Reference: `BCSessionManager.ts` (v1), `NsServiceJsonRpcHostFactory.cs` (decompiled)

### OpenSession applicationId (Fork fix — NAV vs FIN)

`navigationContext.applicationId` in the `OpenSession` (and every subsequent `Invoke`) payload must
match what the NST expects for the target build. The real BC 27 web client sends **`NAV`**. Sending
`FIN` makes the server reject the session with
`Microsoft.Dynamics.Nav.Types.NavCancelCredentialPromptException` (code 3) on the **first
`OpenSession`** — even though `POST /SignIn` returns 302 with valid cookies AND the
`wss://.../BC/csh?csrftoken=...&ackseqnb=-1` socket opens cleanly. The failure is at the application
layer, not the transport.

This was diagnosed empirically (not from decompiled source): the real web client's `OpenSession`
frame was captured via Playwright (`page.on('websocket')` + `framesent`; note the BC web client
creates its WebSocket inside a Web Worker, so a `window.WebSocket` hook on the main page sees
nothing). A 3-variant isolation test against `devel1` then confirmed it — only `applicationId`
matters:

| OpenSession variant | Result |
|---|---|
| code as-shipped (`applicationId: "FIN"`) | ❌ `NavCancelCredentialPromptException` |
| same payload, only `applicationId: "NAV"` | ✅ session opens |
| exact captured browser payload (NAV) | ✅ session opens |

The other browser/MCP payload differences (modern `features` list, extra `supportedExtensions`,
non-null `telemetryClientSessionId`) are NOT required.

Implementation: `InteractionEncoder` takes an `applicationId` constructor arg (default `'NAV'`),
used in both `encode()` and `encodeOpenSession()`. Wired from `BCConfig.applicationId` =
`BC_APPLICATION_ID` env (default `'NAV'`) in `stdio-server.ts` / `server.ts`. Override
`BC_APPLICATION_ID` for builds that expect a different value; if a new BC version regresses with
`NavCancelCredentialPromptException`, re-capture the real web client's `applicationId` and set it.

Files: `src/protocol/interaction-encoder.ts`, `src/core/config.ts`, `src/stdio-server.ts`,
`src/server.ts`. Tests: `tests/protocol/interaction-encoder.test.ts` (default NAV + override).

### Parameter Case Sensitivity
BC uses case-INSENSITIVE parameter matching. Verified from decompiled `InteractionParameterHelper.TryGetValueIgnoreCase` which uses `StringComparison.OrdinalIgnoreCase`. Both camelCase and PascalCase work.

### Control Paths
Control paths use the format `server:c[N]/c[M]/...` where `c` is the standard child collection accessor. Special segments:
- `cr` -- RepeaterControl's CurrentRowViewport (for addressing the selected row)
- `co[N]` -- RepeaterControl's column at index N
- `ha[N]` -- RepeaterControl's header actions
- `filc` -- NOT a path segment (only a TypeAlias for serialization)

Reference: `LogicalControl.ResolvePathName` (decompiled)

### Row-Targeting Actions (Drill-Down, Delete, etc.)
For system actions that operate on list rows (Edit=40, Delete=20, View=60, DrillDown=120, New=10), the `controlPath` must point to a cell in the current repeater row via `cr` segment:
```
{repeaterPath}/cr/c[0]
```
Do NOT use action button paths from `state.actions` -- they are structurally fragile and shift when BC rearranges actions.

Reference: `InvokeActionInteraction.GetContextActionToExecute` uses `DefaultAction` on the resolved control, which traverses up to find the row action. `RepeaterControl.ResolvePathName("cr")` returns `CurrentRowViewport`.

### Tell Me Search
Uses `InvokeSessionAction` with `SystemAction: 220` (PageSearch). NOT `sessionAction: "InvokeTellMe"`.

The form opens as a regular `FormCreated` (not `DialogToShow` — Tell Me is non-modal on BC28). The search input is at `server:c[0]/c[0]` (the sc inside a gc container at `server:c[0]`); SaveValue against the gc container alone returns no DataLoaded events. Two result repeaters at `server:c[1]` (pages/lists) and `server:c[2]` (reports/extras) emit DataLoaded streams with NAMED cells (`Name`, `Source`, `DepartmentPath`, `DepartmentCategory`, `SearchScore`). `cells.Source.stringValue` is JSON-encoded `[{"page": "<AL name>"}]` or `[{"report": "<AL name>"}]` — BC identifies pages by AL name, not numeric id.

Tell Me is profile-scoped on the BC server. `BC_PROFILE` env var (e.g. `BUSINESS MANAGER`) is plumbed into OpenSession's `profile` field to select an indexed profile. Server uppercases/trims; unknown ids silently fall back to user default.

Reference: `InvokeSessionActionExecutionStrategy.cs`, `SystemAction.cs` (PageSearch=220), `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs` (Profile field), `Microsoft.Dynamics.Nav.Service/NSService.cs:OpenConnection`. Live wire fixture: `src/protocol/captures/tell-me-result-2026-04-28.json`.

### Cuegroups (Role-Center cue tiles)

Cuegroups are AL `cuegroup` containers that compile to a `stackgc` wire type (NOT a generic `gc` with a mapping hint, despite older docs). Children are `stackc` cue tiles inside an inner `gc { MappingHint: 'STACKGROUP' }`. Cue values (`StringValue`) arrive via `PropertyChanged` events AFTER `LoadForm(loadData:true)` — not in the initial FormCreated. `PageService.discoverAndLoadChildForms` sends `LoadForm { openForm:true }` plus `InvokeAction(Refresh=30)` for Role Center hosted CardParts to trigger cue computation.

`StackGroupNode` and `CueFieldNode` are first-class FormNode variants. `cues(root)` is a memoised view; `Section.cues` is the MCP DTO field. `bc_execute_action { section, cue }` sends `SystemAction.DrillDown=120` against the cue's controlPath; the resulting ownerless FormCreated is registered as a fresh `session:page:cue:*` pcId returned in `openedPages`.

Role Center hosted CardParts arrive on the wire as `IsSubForm=false / IsPart=true`, which `SectionResolver.deriveFactboxSection` classifies as `kind: 'factbox'` (not `'subpage'`). The auto-load path treats both as Role Center children when `pageType === 'RoleCenter'`.

CardParts opened standalone may return a placeholder shell on some envs (Continia/CDO is a known case; default BC28 returns full content). `OpenPageOperation` detects this — pageType=CardPart with zero captioned fields AND zero cues — and returns `CardPartStubError` (code `CARDPART_STUB`) with a `hostHint` telling the caller to reach the part via its host page.

Reference: `src/protocol/captures/cuegroup-rolecenter-2026-04-28.json` (619 KB, 16 hosted CardParts, 50 cue tiles); `src/protocol/cue-detection.ts`; `src/protocol/form-node.ts` (StackGroupNode, CueFieldNode); decompiled `Microsoft.Dynamics.Framework.UI.Client.LogicalControlSerializer.cs` for the wire-property names.

### Filter Protocol
Single-step: `Filter(AddLine)` with `FilterValue` in namedParameters. Two-step (AddLine + SaveValue) also works but is unnecessary.

After AddLine, the filter line control structure is:
```
{filcPath}/c[0]     -- FilterLineControl
  c[0]              -- SelectionControl (column selector)
  c[1]              -- FilterValueControl (value input)
```

Reference: `FilterLogicalControl.AddFilterLine`, `FilterLineControl` constructor

### Card Page Data Loading
After drill-down opens a card page (FormCreated event), field values are empty. Must send `LoadForm(loadData:true)` to populate StringValue properties. Data arrives as `PropertyChanged` events.

Reference: `EditLogicalControl.ObjectValue` reads from `ColumnBinder[RowEntry]` -- empty until `LoadData()` fills the BindingManager.

### SaveValue Echo Behavior
BC DOES echo back validated/formatted field values as `PropertyChanged` events after `SaveValue`. No client-intent patches needed.

Reference: `LogicalControlObserver.BeforeGetChanges` registers changed StringValue/ObjectValue.

### Report Execution Protocol
Reports are opened via `OpenForm` with `query: "report=<id>&tenant=<tenantId>"`. NOT a standalone `RunReport` RPC method or `InvokeSessionAction`. BC opens the report's request page as a `DialogOpened` event with `MappingHint: "RequestPage"`. Fill parameters with `SaveValue`, execute with `InvokeAction(OK)`.

Reference: `NavRunReportPropertyBagInvokedAction.cs`, `RunReportAction.cs` (decompiled). Verified against live BC28: report 6 (Trial Balance) returns request page dialog.

### Company Switching — a session is BOUND to its company at OpenSession

**`InvokeSessionAction { SystemAction: 500 }` on a live session does nothing you can rely on.**
Measured on `devel1` (BC27): the response is a bare `InvokeCompleted` plus a few unrelated
`PropertyChanged` — **no `SessionSettingsChanged`, no `CompanyName`** — and the data keeps coming
from the previous company. The old code sent it, then wrote the REQUESTED name into
`BCSession.company`, so `bc_switch_company`, `bc_health` and every deep link reported a switch that
had not happened and later reads silently came from the wrong company (bc-saas F-11).

The mechanism that works is the one the web client uses: **re-enter on the company**. `OpenSession`
takes `company` and its `OpenForm` query takes `company=<encodeURIComponent(name)>`
(`encodeOpenSession`); the company BC grants comes back as `CompanyName` in the response and is the
ONLY server-side statement about a session's company this protocol offers.

So `SessionManager.switchCompany()` closes the session, opens a new one on the target company, and
compares what BC granted with what was asked (case/space-insensitive) — throwing when they differ
instead of returning a success-shaped result. Page contexts die with the old session (they always
did) and `servicesInvalidated` makes the entry points rebuild the graph. `desiredCompany` is also
passed to `SessionFactory.create()` on every reconnect, so a recovered session comes back on the
right company by construction rather than by replaying an action that is ignored.

Verified live on `devel1`: Company Information `Name` goes `CRONUS_04` -> `JBC SOLDERING JAPAN CO.,
LTD.` across the switch (the customer list could NOT show it — every company in that container is a
copy of the same data, which is exactly how a broken switch passes a careless check). Also verified
on SaaS (`test-battery saas`).

Files: `src/session/session-manager.ts` (`switchCompany`), `src/session/session-factory.ts`,
`src/session/bc-session.ts` (`initialize`, `changeCompany` — now reports `confirmed` and never
writes the company optimistically), `src/protocol/interaction-encoder.ts`,
`src/operations/switch-company.ts`, `src/mcp/build-operations.ts` (`switchSessionCompany`).

Reference: `ChangeCompanyAction.cs`, `NavSystemCodeunitSystemActionTriggers.cs` (decompiled, upstream).

### BC27 vs BC28 Wire Compatibility
Wire format is identical: same handler types, type abbreviations (~50 aliases), compatibility version (15041). Only addition in BC28: `CopilotSettingsChanged` event (ignorable). A single codec handles both.

Reference: `ResponseManager.cs`, `VersionCompatibility.cs`, `BrowserLogicalChangeTypeIds.cs` compared between versions.

### Reactive control tree (FormState shape)

`FormState.root` is the canonical tree representation of a BC form, built once
from the `lf` JSON via `buildFormTree` and mutated in place by `PropertyChanged`
events via `applyPropertyChange` (`src/protocol/form-tree-mutator.ts`). Off-path
nodes are reused by reference (structural sharing); on-path nodes get a fresh
copy with merged properties.

Repeater rows live separately in `FormState.rows: Map<repeaterPath, RepeaterRow[]>`
because `DataLoaded` events don't fit the publish-then-mutate model.

Derived views (`fields`, `actions`, `tabs`, `repeaters`, `groupVisibility`,
`filterControlPath`) are memoised pure functions over the root via WeakMap
(`src/protocol/form-views.ts`). Same root reference returns the same array
reference; tree mutation produces a new root and invalidates the cache
automatically.

`ControlField` and `ActionInfo` (`src/protocol/types.ts`) are now MCP output
DTOs only -- internal code reads `FieldNode`/`ActionNode` from `form-node.ts`
via the views. Adapters (`fieldNodeToControlField`) translate at the MCP
boundary for output JSON stability.

Reference: `Microsoft.Dynamics.Framework.UI.Client.LogicalControlSerializer.cs`
for wire-format property names; `Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs`
for the PageType enum.

## SystemAction Enum (Complete)

```
None=0, New=10, Delete=20, Refresh=30, Edit=40,
EditList=50, View=60, ViewList=70, OpenFullList=80,
AssistEdit=100, Lookup=110, DrillDown=120,
Ok=300, Cancel=310, Abort=320,
LookupOk=330, LookupCancel=340, CloseOk=350,
Yes=380, No=390,
PageSearch=220, RunReport=210, ChangeCompany=500
```

Reference: `SystemAction.cs` (decompiled, identical BC27/BC28)

## Handler Types (Complete)

12 handler type strings used in BC protocol:
```
DN.LogicalClientChangeHandler       -- Form data/property changes (most common)
DN.LogicalClientEventRaisingHandler -- Session events (FormToShow, DialogToShow, etc.)
DN.CallbackResponseProperties       -- Invoke metadata (sequenceNumber, completedInteractions)
DN.CachedSessionInitHandler         -- Session credentials (ServerSessionId, SessionKey, CompanyName)
DN.SessionInitHandler               -- Session init data
DN.LogicalClientInitHandler         -- Logical client state
DN.LogicalSessionChangeHandler      -- Session property changes
DN.SessionSettingsChangedHandler    -- Company/timezone/locale changes
DN.NavigationServiceInitHandler     -- Navigation tree init
DN.NavigationServiceChangeHandler   -- Navigation tree updates
DN.EmptyPageStackHandler            -- No pages open signal
DN.IsExecutingHandler               -- Server busy polling
DN.ExtensionObjectChangeHandler     -- Control add-in changes
```

## Testing Strategy

### Integration-First
Verify against real BC first. Codify verified behavior as unit tests second. Never mock what you don't understand.

### Test Tiers
1. **Unit tests** (`tests/unit/`, `tests/protocol/`): Pure logic, no BC needed. Run with `npx vitest run`.
2. **Integration tests** (`tests/integration/`): Against real BC27/BC28. Run with `npx vitest run --config vitest.integration.config.ts`.
3. **Workflow smoke tests**: Exercise every MCP tool in realistic multi-step workflows. The live end-to-end equivalent is `npm run test-battery <docker|saas>`, which runs the same Operations the tools wrap against BOTH environments.
4. **Edge case tests**: Protocol edge cases, error handling, cross-version compatibility.

### Stale Server Process
The MCP endpoint test spawns an HTTP server on port 3456. If it doesn't shut down properly, subsequent test runs fail because they connect to the stale server (with old code). Kill it:
```bash
netstat -ano | grep 3456 | grep LISTEN
taskkill //F //PID <pid>
```

### Session Death Cascading
A single protocol error (InvalidSessionException, ArgumentOutOfRangeException) can kill the BC session, causing all subsequent tests to fail. The test suite has `recreateSession()` helpers, but BC holds the NTLM auth slot for ~15 seconds after a crash, preventing immediate reconnection.

## Tool Descriptions (2026 Best Practices)

Following Anthropic's official guidance:
- Minimum 3-4 sentences per tool description
- Include when to use / when NOT to use
- Document inter-tool relationships (pageContextId flow)
- `bc_` namespace prefix for Tool Search discovery
- Keyword-rich for MCP Tool Search matching
- Consider `input_examples` for complex tools

Source: https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools

## Where the documentation lives

Four files carry everything that is not code. Read the relevant one BEFORE planning work:

| File | What it holds |
|---|---|
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | **The only place open work is tracked.** Capability gaps, what to port from upstream (with the protocol details upstream already verified live), Page Scripting, a specialised AL/BC testing agent, ecosystem ideas. §12 explains every item in plain Catalan |
| [`docs/BASE-CONEIXEMENT-IA-BC.md`](docs/BASE-CONEIXEMENT-IA-BC.md) | Inventory of the external BC+AI ecosystem with URLs: Microsoft's MCP servers, community data/admin MCPs, AL development MCPs, agent/skill frameworks, Page Scripting tooling. Ends with a routing table for when several BC MCP servers are registered at once |
| [`docs/Plans/page-scripting.md`](docs/Plans/page-scripting.md) | The exact plan for exporting agent sessions to Microsoft's Page Scripting YAML and replaying them with `@microsoft/bc-replay`. Wanted, not started |
| [`docs/SAAS-EVIDENCE.md`](docs/SAAS-EVIDENCE.md) | Frozen record of the SaaS WebSocket discovery and the Docker-vs-SaaS parity matrix. Results only, never pending items |

## Field targeting, write verification & payload control (Fork additions — BC744)

Hardening derived from task BC744 (full reference: [`docs/guides/conventions.md`](docs/guides/conventions.md);
pending items in [`docs/ROADMAP.md`](docs/ROADMAP.md) — the single place open work is tracked).
Agent rules of thumb:

- **Duplicate captions (P1/P8).** Document headers repeat captions across groups (Sell-to / Bill-to /
  Ship-to all have `Name`, `Address`, `City`, …). `bc_open_page` / `bc_read_data` now return, per field,
  a stable `controlPath` and the enclosing `group` caption. To target one unambiguously, EITHER pass the
  `controlPath` as the `fields` key in `bc_write_data` (`{ "server:c[4]/c[1]/c[1]/c[0]": "2000008" }`),
  OR pass `group: "Bill-to"` alongside caption-keyed fields. `bc_read_data` also accepts `group` to filter.
- **Never trust `success` alone (P6).** `bc_write_data` results carry `requested` / `changed` / `reason`.
  `success:true` only means the SaveValue interaction completed; a no-op (rejected / reverted / not editable)
  returns `changed:false` + a `reason`. `allSucceeded` is false unless every write actually changed. Always
  branch on `changed`, not `success`.
- **`editable` is tri-state (P2).** A field may report `editable: true | false | "unknown"`. `"unknown"`
  (BC emitted no flag — common for page-variable option controls like Ship-to/Bill-to) is NOT read-only:
  attempt the write and confirm via `changed`.
- **Acotar big pages (P7/N3).** `bc_open_page` accepts `summary:true` (sections identity only),
  `sections:["header"]`, `tab`, `columns`, `range`. `bc_execute_action` accepts `quiet:true` to suppress
  the 100+ field `updatedFields` dump. Use these to avoid token-limit overflows on documents/lists.
- **`bc_open_page` failures are explicit (N1).** When BC can't materialize a usable page it returns a
  `PAGE_NOT_MATERIALIZED` error with a `reason` (Unknown / no sections / opened a dialog) instead of a silent
  empty shell.
- **Report output (P9).** `bc_download_report { reportId }` renders and downloads a report's PDF/Excel/Word
  out-of-band via the headless browser (does not touch the WS session). Check `downloaded`; if
  `requestPageShown:true` the report needs parameters — fill them via `bc_run_report` (WS request page).

## Screenshot Capture (`bc_screenshot`) — Fork addition

`bc_screenshot` captures a REAL PNG of the BC web client for a page/record,
with an optional `highlight` callout box around a named field/action. Built for manuals/docs.
It is **additive and out-of-band**: a headless system Chrome/Edge (via `puppeteer-core`, no
bundled download) is launched on demand and torn down — it does NOT touch the WebSocket
session or invoke queue, so normal tools keep full speed.

Engine = **cookie injection** (verified live against `devel1`): bc-mcp does its own forms
`/SignIn`, exports the cookie jar with real attributes, injects into the browser, opens a
deep-link URL, waits for the SPA, optionally annotates, captures. Auto-falls-back to an
in-page login if injection ever lands on `/SignIn`. Output: PNG to disk
(`out` or `BC_SCREENSHOT_DIR`, default `./screenshots`) + inline image in the MCP response.

Key empirical findings (all verified live, BC27):
- Deep-link `?page=<id>&tenant=<t>&company=<c>&bookmark=<bm>` lands on the exact record; BC
  normalizes to `?company=…&page=…&dc=0&bookmark=…`. The internal `bc_read_data` bookmark IS
  the URL `bookmark=`. `company=` is honored (no cross-session wrong-company surprise).
- **NEVER send `runinframe=1`** — it hangs a top-level load on "Getting ready…" forever.
- **The deep link is built with `encodeURIComponent`, NEVER `URLSearchParams.toString()`.** That is
  form encoding: it writes a space as `+`, and BC reads the query value LITERALLY, so a company named
  `CRONUS ES` was looked up as `CRONUS+ES` and every capture came back as BC's "Could not open the
  company" screen. Nearly every install has a space in a company name, so this broke captures and
  manuals wholesale (bc-saas F-1). `deepLinkQuery()` in `bc-web-auth.ts`; both `deepLinkPage` and
  `deepLinkReport` go through it.
- **BC's error screen is detected by BODY CLASS, and a capture that lands on it FAILS.** The frame
  rendering the message carries `has-error`, its host carries `has-error-in-child` (captured live on
  devel1); the message itself is half-localised ("Could not open the company." + a Spanish body) and
  cannot be matched reliably. `detectErrorPage()` (`bc-web-auth.ts`) returns BC's own words, shared by
  `bc_screenshot` (throws, writes nothing) and `bc_download_report` (retries, then reports). Before
  this, a failed capture returned `succeeded` plus the path of a PNG of the error page — a failure
  that ships a file is a failure nobody notices. `waitReady({ bailOnErrorPage: true })` stops the
  60s readiness poll on that page, since it never becomes "ready".
- Auth is ASP.NET forms/cookie (POST `/SignIn` → 302). Real cookies `.AspNetCore.Antiforgery.*`,
  `SessionId`, `.AspNetCore.Cookies`, all `path=/BC; secure; samesite=none; httponly`.
- Page content is inside an iframe — readiness is detected via the document title; highlight
  lookup scans all frames.
- The zero-dep `chrome.exe --headless --screenshot` path is NOT auth-viable (BC session
  cookies are in-memory, a copied on-disk profile loses them).
- **The PNG is written from memory, only after the capture has been judged good.**
  `p.screenshot({ path })` writes straight to the destination, so an expired browser session
  replaced a good figure of a manual with a picture of Microsoft's login form — in a folder outside
  git — and reported success (F-10). Capture to the buffer, validate, `writeFileSync` last. A
  failure now leaves whatever was there untouched.
- **There are TWO login walls and only one used to be recognised.** `onSignIn` matched BC's on-prem
  `/SignIn` (`#UserName`/`#Password`); a SaaS capture whose injected cookie jar expired bounces to
  `login.microsoftonline.com` (`input[name=loginfmt]`), which matched nothing — so `authenticated`,
  computed as `!(await onSignIn(p))`, answered TRUE for a photograph of Microsoft's login form.
  `detectLoginWall()` returns `'bc-forms' | 'entra' | undefined` and is what `authenticated` and the
  recovery both read. `looksLikeBusinessCentral()` (client chrome classes `ms-dyn365*` / `ms-nav-*`
  in any frame) adds a positive check, but only as a WARNING — a BC restyle must not block captures.
- **In AAD mode the browser session is renewed WITHOUT touching the WebSocket.** The two expire
  independently (bc_health said "connected" while every capture came back as the login form), so the
  repair must be independent too — and `provider.invalidate()` is the wrong tool: it closes the
  kept-alive persistent browser, and BC tears down the per-tab session the WS is attached to.
  `IBCAuthProvider.refreshCookieJar()` (optional) mints a fresh jar instead: the AAD provider opens a
  SEPARATE tab in the same browser (Entra SSO lives in the on-disk profile, shared by every tab),
  reads the cookies and closes it; the forms provider just re-runs `/SignIn`. When renewal needs a
  human, it throws with `npm run login:aad` in the message and NOTHING is written.
- **A crop rect measured inside the iframe must be translated to page coordinates.** This was the
  real cause of "crop returns a 3 KB sliver" (F-8): `getBoundingClientRect` is frame-relative,
  `page.screenshot({ clip })` clips in top-level coordinates, and the two differ by the whole BC
  chrome above the iframe. `frameOffset()` (`frame.frameElement().boundingBox()`, already
  page-absolute) is added to every crop rect. `highlight` was never affected because its callouts
  are drawn INSIDE the frame — which is exactly why "use highlight without crop" worked as a
  workaround. A crop target also climbs from the caption to the nearest field-sized ancestor that
  actually contains a value control (`div.ms-nav-edit-control-container` on BC27), and a crop that
  still comes out tiny is reported in `warning`.
- **A click that did nothing is reported, not logged.** `clickBeforeCapture` results come back as
  `clicks: [{ target, clicked, reason }]` with `reason: 'disabled' | 'not found'`, plus a `warning`.
  BC greys out an action that does not apply to the SELECTED row and `.click()` on it is a silent
  no-op, so a capture came out looking like the step had been taken (F-6). In a list, position the
  row with `bookmark` first — that is not a workaround, it is the only way to choose the row.
- **A dialog that opened BY ITSELF is reported** (`unexpectedDialog` + `warning`), detected by ARIA
  role (`dialog` / `alertdialog`), and only when the call carried no `clickBeforeCapture` — a manual
  documenting a dialog asks for one, BC refusing a bookmark from another table does not (F-9).
- **`dismissTeachingTips` (default true)** closes BC's "About this page" callouts before capturing:
  they pop on first visit and a capture browser is ALWAYS a first visit, so the bubble covered the
  bottom-left corner of every image in a manual (F-7). The close button is found structurally (a
  close control INSIDE a teaching/callout container), never by caption — the cross has no accessible
  text, which is why `clickBeforeCapture: ["Cerrar"]` could not reach it.

Config: `BC_SCREENSHOT_DIR` (default `./screenshots`), `BC_SCREENSHOT_CHROME` (browser path
override; auto-detected otherwise). Requires Chrome/Edge installed. `puppeteer-core` is a
runtime dependency, lazy-imported so it never affects startup.

Files: `src/services/screenshot-service.ts`, `src/operations/screenshot.ts`,
`src/mcp/schemas.ts` (`ScreenshotSchema`), `src/mcp/tool-registry.ts`, `src/mcp/handler.ts`
(inline image block), `src/core/config.ts`. Comparison harness: `scripts/screenshot-poc.ts`
(`npm run screenshot:poc`). Full reference: `docs/tools/bc_screenshot.md`.

**Revealing collapsed FastTabs & "Show more" (screenshot-only).** Card/document pages hide
fields two ways in the web client: collapsed FastTabs/groups, and per-tab "Show more"
(`Importance = Additional`) toggles. This affects ONLY screenshots — `bc_read_data` /
`bc_open_page` / `bc_navigate` already return ALL fields regardless of collapse/Show-more state
(verified: a Sales Order drill-down returns every Invoice Details + Shipping/Billing field).
`bc_screenshot` (and each `bc_build_manual` step) takes an `expand?: boolean`. When `true` it
expands every collapsed FastTab and clicks every "Show more" before capture. Even when `false`,
a reveal pass fires AUTOMATICALLY when a requested `highlight`/`crop` caption isn't found
(reveal-when-needed), then the target is `scrollIntoView`-ed (BC content scrolls inside an
iframe, so below-fold revealed fields would otherwise miss the viewport). Empirical selectors
(BC27 `devel1`): FastTab header = `span.ms-nav-columns-caption[aria-expanded]`
(`.ms-nav-group-caption` for sub-groups), expand = click the `="false"` ones; "Show more" =
`button.show-more-fields-button` which has NO state attribute and an invariant class (only the
locale-bound caption flips más/menos), so its state is detected BY EFFECT (visible-node count
delta) to stay locale-independent. Files: `src/services/screenshot-service.ts` (`revealAll`,
`annotate` scroll-into-view), `src/operations/screenshot.ts`, `src/mcp/schemas.ts`,
`src/services/manual-service.ts`. Live check: `scripts/verify-expand.ts`; integration tests in
`tests/integration/screenshot.test.ts`.

**Annotations & crop (caption-geometry).** `highlight` accepts a caption (one box), a list of
captions (auto-numbered badges for ordered steps), or `{target,label,style}` objects
(style: box / badge / arrow / blur). `redact` blacks out fields; `crop` clips to the bounding
box of the given caption(s). All locate controls by visible caption (no dependency on BC DOM
ids). The in-browser annotate function must contain NO named nested functions — under tsx/esbuild
those get a `__name` wrapper that is undefined in the browser (`drawn`/`crops` use inline `.map`).

**Producing documentation? Read [`docs/guides/documenting.md`](docs/guides/documenting.md) first.**
It is the decision table any agent should follow: one image -> `bc_screenshot`; a process ->
`bc_build_manual`; `md` for repos/wikis, `html` for anything a human reads or prints, `docx` when
the reader must edit or restyle it; a PDF is the HTML plus Ctrl+P (there is no PDF output); page
data -> `bc_open_page`/`bc_read_data`, never a screenshot. The rest of this section is the
implementation.

**`bc_build_manual`** (`src/services/manual-service.ts`, `operations/build-manual.ts`) builds a
step-by-step manual from ONE authoring model (`ManualModel` in `manual-render.ts`) to three outputs
selected by `formats` (default `["md"]`):

- **`md`** -- `renderMarkdown` (`manual-render.ts`): text + relative image links.
- **`html`** -- `renderHtmlDocument` (`manual-html.ts`): a **printable A4 web page**. There is no
  PDF renderer -- the HTML is the print path, so Ctrl+P on it yields the paged PDF.
- **`docx`** -- `renderDocx` (`manual-docx.ts`): an **editable Word document**, derived FROM the
  HTML (see "Word export" below). Real Word paragraph styles, a live index, live page numbers.

Prose (`intro`, step `body`) is parsed ONCE by `markdown-inline.ts` into a tiny AST (`parseBlocks`
-> `Block[]` / `InlineSpan[]`) that both the HTML and the Word renderer walk, which is what keeps a
body reading identically in all three outputs. Escaping happens in the HTML renderer only, so the
AST holds plain text and prose can never inject markup anywhere.

The subset is paragraphs, `-`/`1.` lists, `>` notes, `###` sub-headings, **GFM tables**,
**``` fenced code**, and the inline marks. `## ` never reaches this parser -- it is the step
boundary, consumed by `manual-source.ts` / the authoring model -- so `###` is unambiguously a
sub-section INSIDE a step (`ManualSubheading`, outline level 1: it shows in Word's navigation pane
but not in the manual's own index, which is built from per-step bookmarks). Two load-bearing
details behind tables and code:

- `parseBlocks` scans LINE BY LINE, not by splitting on blank lines first. A code block owns its
  blank lines, and splitting first tears one into pieces no later pass can reassemble.
- A table and a code block are the only blocks that can outgrow a sheet and cannot be shrunk like a
  figure, so both render as a CONTAINER OF CHILD ELEMENTS (`<tbody><tr>`, `<pre><code><span
  class="cl">` one per line). That is what lets the paginator cut them; text nodes could not be
  moved. Change that shape and long tables/listings start being clipped by `overflow:hidden`.

Output under `BC_MANUAL_DIR` (default `./manuals`). The authoring recipe an agent should follow
lives in [`docs/guides/documenting.md`](docs/guides/documenting.md) — there is no `bc-manual`
skill (an earlier note here claimed a user-scope `~/.claude/skills/bc-manual/SKILL.md`; it does
not exist).

**Building from an existing `.md` (`source`).** `bc_build_manual` also reads a manual back in:
`{ source: "path/manual.md" }` parses it into a `ManualModel` and renders the requested formats. The
accepted format is **exactly what `renderMarkdown` emits** -- the generator IS the specification, and
`tests/unit/manual-source.test.ts` asserts a byte-identical round trip so the two cannot drift. This
is deliberate: parsing "whatever an assistant wrote this time" is unwinnable, so the format is fixed,
documented in [`docs/guides/manual-source-format.md`](docs/guides/manual-source-format.md) AND in the
tool description (so any MCP client sees the spec before writing a line), and enforced by a
validator. Load-bearing details:

- `parseManualSource` (`manual-source.ts`) returns `{ model?, options, diagnostics }`. A hard error
  (no `# `, no `## `, a missing/remote image) yields no model; a warning (`###`, a second figure in
  one step, a table missing its `|---|---|` delimiter row, an unclosed fence) degrades and is
  reported. `validate: true` checks without building.
- The source scan tracks the FENCE STATE, so a `## `, an `![](…)` or an italic caption line inside a
  listing is content, not structure. Without it a manual that documents this format cuts itself into
  steps the author never wrote.
- Every collected prose line carries its own file line number (`SourceLine`), not a per-block offset
  -- blocks are checked when their step is flushed, so a single offset drifts by one at every
  boundary and an almost-right line number is worse than none.
- Diagnostics are sorted by line before returning: an author must be able to fix everything in ONE
  pass, never rebuild to discover the next problem.
- Optional front matter (`lang`/`cover`/`toc`/`name`/`assets`, flat `key: value`, not YAML) lets the
  document carry its own build settings; an explicit argument still wins.
- Output defaults to the SOURCE's directory (that is what keeps its relative image links valid), and
  requesting `md` when it would overwrite the source is refused rather than silently skipped.
- `BuildManualSchema` makes `title`/`steps` optional and enforces "source XOR title+steps" with a
  `.refine()` -- NEVER a root-level `oneOf`/`anyOf`, which makes Claude Code drop the whole tool.

**Printable A4 HTML — how it holds together.** The renderer does NOT emit a flowing document. It
emits a flat list of measurable units in a hidden `#flow`, an empty `#doc`, and a `<template>` for
one sheet; a bundled paginator (`manual-html-paginator.ts`, a plain JS **string**) measures each
unit against the real `clientHeight` of a `.sheet-body` and distributes them into 210x297mm
`.sheet` elements, then numbers pages and resolves the index. Load-bearing details:

- **Every step opens a sheet of its own** (`data-break="before"` on its first unit, mirrored by an
  unconditional `pageBreakBefore` in the Word renderer). A numbered heading halfway down a page
  reads as a subsection of what precedes it, not as a new step.
- **A table or a code block too tall for a sheet is CUT, not moved.** `splitUnit` moves the
  overflowing tail into a clone of the unit -- cloning is what carries the `<thead>` along, so the
  continuation keeps its column titles -- and the clone gets a `-cN` uid so the measured break map
  never has two units claiming the same key. It is tried BEFORE moving the block whole (leaving at
  least `MIN_SLICE` = 3 rows/lines behind, or a gap reads tidier than a stray), which is why a long
  table starts on the sheet its heading is on instead of leaving most of it blank.
- **A figure that misses its sheet by a little is scaled down instead of moved.** The paginator
  computes the overflow and shrinks the `<img>` to close it, but only down to `MIN_FIG_SCALE`
  (0.75) -- past that the capture stops being readable in print and moving it whole is the better
  answer. The original height is stashed in `data-h0` on first touch: without it a figure that is
  shrunk, rejected and shrunk again on the next sheet compounds the reductions and slips past the
  floor. The measured result travels to Word in `PageBreakMap.figures` (CSS px = 96 DPI = exactly
  what `ImageRun.transformation` wants), so the two outputs cannot drift.
- A step is emitted as MANY units sharing one `data-group`: `step-N-head` (heading + the FIRST
  prose block), `step-N-b2..bn` (the remaining blocks of `body`), `step-N-fig`, `step-N-a1..an`
  (the blocks of `after`, printed below the figure). A group that doesn't fit moves whole to the
  next sheet, and only a group too tall for an empty sheet is split unit by unit.
- Prose is one unit PER MARKDOWN BLOCK (`renderBlockList`) so a step longer than a sheet flows
  instead of overflowing -- a whole body in one unit is indivisible and the paginator's unit-by-unit
  fallback cannot help it. The first block rides WITH the heading on purpose: units are placed one
  by one, so a lone heading unit would be left at the foot of a sheet.
  `data-break="after"` on a group's last unit closes the sheet (used by the index).
- Sheet geometry is a CSS grid `head / 1fr / foot`; `.sheet-body { min-height: 0 }` is what keeps
  `clientHeight` equal to the real usable space -- without it the grid stretches and pagination
  silently overflows.
- Print: `@page { size: A4; margin: 0 }` + one break per sheet, and the sheet is
  `calc(297mm - 0.2mm)` when printing -- that hair is what stops Chrome interleaving blank pages.
- `--fig-max-h: 180mm` guarantees any capture fits one sheet; `<img>` carries the intrinsic
  width/height from `pngSize` so the measured layout is stable before decode.
- The paginator is kept as a string (never a serialized TS function) for the same reason as the
  screenshot annotator: tsx/esbuild wraps nested named functions in an undefined `__name` helper.
- Narrow windows scale the whole doc AFTER pagination (measurement always happens at true A4), so
  the print result never depends on the reader's window size. No JS -> `#flow` is the readable
  fallback.
- `assets: 'inline'` (default) embeds CSS/JS/PNGs in one file; `'files'` writes `.html`+`.css`+`.js`
  and links the PNGs. `lang` (ca/es/en) only switches the generated chrome. Every colour/metric is a
  `:root` CSS variable in `manual-html-theme.ts`.
- Prose goes through the shared Markdown AST described above -- a deliberately tiny subset
  (paragraphs, lists, `>` notes, bold/italic/code/links).

**A table or a listing is moved whole before it is cut.** `placeUnit` tries a fresh sheet FIRST and
only cuts a unit that is taller than an empty sheet -- half a table read against a header that is no
longer in front of you is not a table, and a gap at the foot of the previous page is the cheaper
price. Word is told the same rule declaratively, since it re-flows on its own: `keepNext` on every
table row but the last chains them so Word moves the whole table, and `cantSplit` per row stops a
single row straddling the boundary. Both are best-effort by construction -- a table taller than a
page has to break somewhere and Word then ignores the chain, which is the only sensible outcome.

**Word page parity has ONE limit.** Every step opens its own page in both outputs, but a table or a
code block longer than a sheet is cut by the paginator at a row/line the browser measured, while
Word re-flows it on its own -- so that step can come out a page longer or shorter and the index's
cached numbers drift after it. The footers are live fields and stay correct, and F9 re-resolves the
index. `verify:manual` catches a divergence by re-flowing the .docx with LibreOffice (skipped, and
reported as skipped, when it is not installed).

**Word export — measured breaks, replayed declaratively.** The two outputs paginate in
fundamentally different ways: the HTML paginates by MEASUREMENT (the browser measures each unit
against a real sheet), while Word re-flows the document itself and honours only RULES. So a .docx
built from rules alone breaks in different places than the printed HTML. The fix is to run the real
HTML in the real headless browser, read back which sheet each unit landed on, and turn that map
into explicit `pageBreakBefore` flags. Load-bearing details:

- Every HTML unit carries a stable `data-uid` (`step-3-head`, `step-3-fig`, `toc-row-2`,
  `head-title`) -- the join key between the two renderers. Changing one means changing both.
- `measurePageBreaks` (`manual-paginate.ts`) writes the HTML to a temp file, waits for
  `#doc[data-paginated="1"]`, and returns `{ uid -> sheet number, totalPages }`. This is the ONLY
  reason a .docx build needs a browser; `ManualService.measureBreaks` degrades to the declarative
  layout (a step per page) with a warning rather than throwing when Chrome is missing.
- The cover is always sheet 1 and carries no measurable unit, so `pageBefore()` answers it directly
  -- otherwise a cover-only manual compares step 1 against nothing and emits no break.
- The index uses real `PAGEREF` fields against per-step bookmarks, seeded with the MEASURED page
  number as the field's cached value: correct the moment the file opens, and self-correcting on F9
  after the reader edits it.
- Bookmarks are emitted as explicit `BookmarkStart`/`BookmarkEnd` pairs with a document-wide
  counter. docx's `Bookmark` class builds its numeric id from a generator it creates PER INSTANCE,
  so every bookmark comes out as id 1 and Word resolves every PAGEREF to the first one.
- Bullets use our own `manual-ul` numbering definition, not docx's `bullet` shorthand -- the
  shorthand injects Word's built-in `ListParagraph` style, landing a second `w:pStyle` in the
  paragraph that silently overrides `ManualBody`. Each `ol` block gets its own numbering `instance`
  so counters restart.
- Image sizes are floored, never rounded: Word stores EMU at 9525 per pixel, and rounding a scaled
  width up puts the figure a fraction of a millimetre past the printable area, which is enough for
  Word to reflow it onto its own page.
- A Markdown table becomes a REAL Word table (`w:tbl`), so `blocksToChildren` returns
  `(Paragraph | Table)[]` -- a table is not a paragraph. Its first row carries `tableHeader`
  (Word's "repeat as header row"), matching the HTML's cloned `<thead>`. Every table is followed by
  a `ManualAfterTable` paragraph: two adjacent Word tables MERGE into one, and a table as the last
  element of the body is not a valid document.
- A code block is one shaded paragraph PER LINE (`ManualCode`), never one paragraph with breaks
  inside: that would be indivisible and a long listing could not break across pages. An empty line
  still gets a run, or Word drops the shading and the block comes out with a white gap through it.
- Word re-flows a table and a listing by itself, so neither carries a measured break. Page counts
  can therefore drift from the HTML by a page when a table lands exactly on a boundary -- the same
  tolerance the rest of a step's content already has (only STEPS get explicit breaks).
- Geometry (`G`) and palette (`C`) in `manual-docx.ts` mirror the `:root` variables of
  `manual-html-theme.ts` by hand. Change one, change the other.

Layout regressions: `npm run verify:manual` (`scripts/verify-manual.ts`) builds a synthetic
multi-page manual from PNGs on disk, paginates it in a real browser and asserts no sheet overflows,
every step is placed, the index resolves, and `page.pdf()` yields exactly one page per sheet. It
also carries a 46-row table and a 60-line listing and COUNTS the rows/lines across every sheet
afterwards: the numbers must match what was authored, which is what proves the cut moves content
instead of clipping it. It
then renders the .docx from the same measured layout. The final claim -- that the Word pages match
the HTML -- needs something that re-flows a Word file, so it converts with LibreOffice and compares
page counts when `soffice` is installed, and reports the check as SKIPPED when it is not. It writes
`manuals/_verify/` (gitignored) with a PNG per sheet for eyeballing.

**`bc_health`** (`src/operations/health.ts`, `src/services/metrics.ts`) reports connection,
company, open forms, modal depth, and metrics (invokes / errors-by-code / reconnects / uptime).
It is registered to BYPASS the `ensureSession()` gate so it answers even when BC is down; the
HTTP `/health` endpoint returns the same shape. `MCPHandler` translates raw BC errors to clear,
actionable messages via `src/core/error-translator.ts` and records error codes in `Metrics`.

## Authentication modes: on-prem forms vs BC Online (SaaS / AAD)

Auth is selected by `BC_AUTH` (default `UserPassword`). **Unset = exact on-prem behavior.**
The provider is chosen by `createAuthProvider()` (`src/connection/auth/factory.ts`); the rest of
the stack (protocol, session, services) is auth-agnostic. Discovery details + live evidence:
[`docs/SAAS-EVIDENCE.md`](docs/SAAS-EVIDENCE.md) (handshake spike + Docker-vs-SaaS battery).

**Target is fixed per MCP registration, not chosen at runtime.** One server process = one BC
(env-selected). To have both, register two MCP servers with clear names (e.g. `bc-docker` +
`bc-saas`); the model routes by server name from what the user says ("in SaaS" / "in devel1").
`bc_health` returns `bc.authMode` + `bc.environmentKind` (`saas` | `on-prem`) + `baseUrl` so the
model can confirm which environment an instance talks to. Guide:
[`docs/guides/saas-vs-docker.md`](docs/guides/saas-vs-docker.md).

- **`UserPassword` (default)** — `FormsAuthProvider` (`src/connection/auth/forms-provider.ts`,
  the artist formerly known as `NTLMAuthProvider`; there is no NTLM — it's ASP.NET forms
  `/SignIn`). GET antiforgery token + POST credentials → `.AspNetCore.Cookies` ticket +
  antiforgery CSRF. Produces BOTH the WS `Cookie` header AND the attributed cookie jar
  (`RawCookie[]`, `src/connection/auth/cookies.ts`) consumed by the headless browser.
- **`AAD` (BC Online / SaaS)** — `AADBrowserAuthProvider`
  (`src/connection/auth/aad-browser-provider.ts`). **Verified live against the sandbox `Dev`
  (2026-08-08): auth, WS, OpenSession, openPage, readRows/readField, writeField (changed=true).**
  OAuth tokens do NOT authenticate the web client — it needs a real user browser session. So
  this drives a headless browser with a **persistent profile** (`BC_AAD_PROFILE_DIR`, default
  `./.state/aad-profile`): the OIDC dance runs once (interactive `npm run login:aad`, or headless
  with `BC_USERNAME`/`BC_PASSWORD` [+`BC_AAD_TOTP_SECRET` for MFA]), Entra SSO cookies persist,
  later reconnects re-auth silently.

  **SaaS is NOT `{baseUrl}/csh`** (the spike's key finding). The server assigns a per-tab backend
  endpoint `wss://{backendHost}/tenant/{backendTenant}/tab/{tabId}/csh?ackseqnb=-1&aadTenantId=..&csrftoken=CfDJ8..`
  on a regional app-service host, with the session cookies (`SessionId`, `.AspNetCore.Cookies`,
  `.AspNetCore.Antiforgery.*`, `NAVAllowedAncestor`, `ApplicationGatewayAffinity`) scoped to that
  host + tab path. None of it is derivable from `baseUrl`, so the provider **discovers** it from
  the browser: it captures the WS URL via CDP (`Target.setAutoAttach` + `Network` per target,
  because the SPA opens its WS inside a Web Worker), parses the backend host/tenant from the path,
  and collects the backend-host cookies. The connection layer then opens a Node WS to that exact
  URL (`getWebSocketUrl()`), OpenSession uses the discovered backend tenant
  (`getTenantIdOverride()`), and `applicationId` defaults to **`FIN`** in AAD mode. Crucially, the
  WS upgrade must send `Origin: https://businesscentral.dynamics.com` + a browser `User-Agent` —
  the gateway enforces `NAVAllowedAncestor` and 500s a bare `ws` upgrade. **Also: the WS `Cookie`
  header must carry ONLY the current tab's backend cookies, de-duped by name.** A persistent profile
  accumulates `SessionId`/`.AspNetCore.Cookies`/antiforgery for every historical tab (same backend
  host, different `/tenant/.../tab/{tabId}` paths); sending all of them makes the header carry dozens
  of duplicate-named cookies and the gateway 500s. The provider filters cookies by the tab path and
  de-dupes (result: 5 cookies). Full details:
  [`docs/SAAS-EVIDENCE.md`](docs/SAAS-EVIDENCE.md). Live check: `npm run test-battery saas`.

**One login, shared everywhere.** `ScreenshotService` / `ReportDownloadService` no longer do
their own `/SignIn` — they call `ensureAuthJar(provider)` (`src/services/bc-web-auth.ts`) and
inject the ACTIVE provider's jar. Standalone scripts that don't inject a provider fall back to a
self-contained `FormsAuthProvider`.

**Mode-conditional URL/tenant points (the only non-auth places the mode leaks):**
- `ConnectionFactory` uses `provider.getWebSocketUrl()` when non-null (SaaS backend URL) instead
  of building `{baseUrl}/csh`.
- `SessionFactory` uses `provider.getTenantIdOverride()` when non-null (SaaS backend tenant) for
  BCSession + OpenSession.
- `deepLinkPage`/`deepLinkReport` (`bc-web-auth.ts`) omit `?tenant=` in AAD mode (SaaS is
  tenant-path-based: `baseUrl` = `https://businesscentral.dynamics.com/{aadTenantId}/{environment}`).
- `PageService` omits `&tenant=` from the `OpenForm` WS query in AAD mode (SaaS binds the tenant
  at session open).
- `BC_APPLICATION_ID` defaults to `FIN` in AAD mode (else `NAV`); `BC_TENANT_ID` is superseded by
  the discovered backend tenant in AAD. Both stay env-overridable.

**SaaS session expiry** reuses the existing recovery path: WS drop → `isAlive=false` →
`SessionManager` calls `provider.invalidate()` (keeps the disk profile) → `authenticate()`
re-discovers a fresh tab + re-auths from the warm profile. If Entra needs interaction, the
actionable error (run `npm run login:aad`) is surfaced in the `SessionLostError` detail.

**Scripts.** `npm run capture:saas` (headed spike, re-runnable diagnostic — captures WS URL,
OpenSession frame, cookies, OIDC chain to `src/protocol/captures/`), `npm run login:aad`
(interactive profile bootstrap), `npm run test-battery <docker|saas>` (full 19-tool functional
battery — the live end-to-end check for either environment).

**SaaS verified live (2026-08-08), battery 15/18 PASS — parity with Docker**
([`docs/SAAS-EVIDENCE.md`](docs/SAAS-EVIDENCE.md)). `bc_screenshot` / `bc_build_manual`
DO work in AAD mode (the out-of-band browser authenticates on SaaS too).

**List filtering (`bc_open_page` / `bc_read_data` `filters`) — the WORKING mechanism.** The read-time
"filter pane" (`Filter/AddLine`) is a no-op on BC27/BC28: list columns carry a `ColumnBinder.Name` but
no `.Path`, so BC silently ignores the AddLine (a no-match value still returns every row). The mechanism
that works is the **OpenForm `filter=` query** (`src/protocol/filter-query.ts`, format `'Field' IS 'value'`
AND-joined; the same path `ObjectIndexService` uses for page 9174). `bc_open_page` now takes `filters`
(applied at open) and `bc_read_data` `filters` re-opens the page's form IN PLACE via
`PageService.reopenWithFilters` (same pageContextId). **Filter fields are AL field NAMES (invariant) —
`No.`, `Name`, `City` — NOT localized captions** (`Nº`/`Nombre` raise a BC "token not found" error).
Values support exact / range (`a..b`) / wildcard (`*x*`) / expression (`>n`). Verified live on both
Docker (49→0 on an impossible value) and SaaS (6→1 exact, 6→3 range). Document LINE-section filtering
still falls back to the filter pane (errors clearly). The FilterService AddLine path is kept only for
that fallback.

**`bc_download_report` on SaaS — known limitation (NOT a SaaS-access problem).** The download mechanism
itself works on SaaS (same out-of-band browser as `bc_screenshot`, which passes). But the report
deep-link (`?report=<id>`) is flaky on SaaS (intermittently lands on a "Go back home" error page) and,
when the request page does render, its toolbar buttons aren't matched by the on-prem "Send to → OK"
flow. So report download is not yet reliable on SaaS — needs a SaaS-specific report-invocation path
(deep-link retry + toolbar reverse-engineering, or WS-side capture). On-prem `bc_download_report` is
unaffected.

## Known Limitations

### Document Pages (Multi-Repeater)
Document pages (Sales Order=42/43, Purchase Order=50/51) have both a header repeater and a lines subpage repeater. The sections ARE distinguishable (`header` / `lines`, verified live on both environments), so always pass `section` explicitly; omitting it resolves whichever repeater comes first. Note that a plain part containing a repeater is now `subpage:<caption>`, NOT `lines` — only a real subform is `lines`.

### An OpenForm BC refuses comes back as an ERROR DIALOG, not as a form

BC answers an `OpenForm` it will not honour with a `DialogOpened` whose control tree is
`{ t: 'lmd', Caption: 'Error', ExceptionType: 1, DialogType: 3, Message: '<the reason>' }` — a
logical message dialog, not a page. Treating it as the page root produced an unreadable shell
(`pageType: "Unknown"`, `isModal: true`, no fields, a caption that changed on every call because it
was the raw formId) and discarded the only thing that explained the refusal (bc-saas F-3).

`materializePage` now detects it, dismisses the dialog (Ok=300, else CloseForm — otherwise it sits on
the session's modal stack and the NEXT invoke pays a full modal reconcile: four extra round-trips,
observed live) and returns `PageOpenRejectedError` (`PAGE_OPEN_REJECTED`) carrying BC's message plus
a hint. A normal `DialogOpened` — a wizard, a request page, a confirmation — is still THE page and is
kept; only `lmd` + `ExceptionType` means "refused".

The case that produced it: **a bookmark only addresses the table its list is bound to.** Feeding page
132 (Posted Sales Invoice) a bookmark from a Posted Sales Shipments row yields *"No se puede utilizar
un RecordID de la tabla 'Sales Shipment Header' con un registro de la tabla 'Sales Invoice
Header'."* Open the card filtered instead (`filters: [{ field: 'No.', value: '<doc no>' }]`, verified
working on the same page) or drill in from the row's own list with `bc_execute_action { action:
'View' }`.

### A modal dialog IS a section (`dialog`) — read it, write it, then answer it

BC gates plenty of actions behind a modal that carries its own fields (`PageType =
StandardDialog`: a reason, a comment, a posting date). That dialog is a DIFFERENT FORM from the
page. It used to be kept only as a raw entry in `PageContext.dialogs` — no FormState, no section —
so `bc_write_data`, which resolves everything through sections, answered `Field not found:
server:c[1]/c[2]` for a controlPath the SAME response had just handed the caller. Anything behind
such a dialog could be opened and cancelled but never completed, which is what forced a person to
take over mid-workflow (bc-saas F-4/F-5).

`addDialog` now builds the dialog's control tree into a FormState and mints a section for it
(`SectionResolver.deriveDialogSection`). The first open dialog is plainly `dialog`; a second
concurrent one is `dialog#2`. Everything section-shaped works on it — `bc_read_data { section:
"dialog" }`, `bc_write_data { section: "dialog", fields }` (with the full `changed` / `reason` /
`validationMessage` verification), `bc_execute_action { section: "dialog" }` — and a write that
names a dialog field WITHOUT a section now gets an error naming the section to use instead of a
bare "not found". Verified live on devel1: a report request page opened from a list action came
back as `dialog`, `Number of Customers` wrote with `changed:true`.

**BC does NOT announce that a dialog closed.** Verified live: dismissing one (Cancel = 310) comes
back as `InvokeCompleted` + a few PropertyChanged, with NO `FormClosed`, so nothing in the event
path can prune it. `PageContextRepository.removeDialog()` is called by the operations that answer a
dialog, which also frees the plain `dialog` id for the next one. `markFormClosed` DELETES a dialog
section rather than marking it invalid, for the same reason.

**`bc_respond_dialog` fills the dialog itself (`fields`), and REFUSES to answer one it could
not fill.** The schema had no `fields` key at all, so a caller that sent them had them stripped by
Zod and BC ran the dialog on its DEFAULT values while the result said `success: true`. On a "Copy
document lines" dialog that copied the wrong document and put ~50 wrong lines into an order
(bc-saas F-39 §5) — the F-36/F-38 pattern: success reported for work nobody asked for. Now
`fields` is a real parameter, written through `DataService.writeFields` — the SAME verified path
`bc_write_data` uses, so echo, `changed` and `validationMessage` all apply — and:

- The dialog is located by its **formId**, never by section name: the first open dialog is
  `dialog`, a second concurrent one `dialog#2`, so a hardcoded name fills the wrong one.
- **A field that did not change aborts the whole call.** The dialog stays open, untouched and
  still answerable, and the error carries the per-field reasons. Answering anyway and reporting
  the failures alongside is what made the original bug destructive: by the time anyone reads
  `fieldResults` the wrong lines are already in the document. `changed: undefined` (unverified)
  is NOT a failure and passes through.
- `fields` with `cancel` / `abort` / `close` is an error — a dialog being dismissed takes no values.

Writing them separately with `bc_write_data { section: "dialog", fields }` and then answering
still works; it is the same code underneath.

Note `bc_respond_dialog` still only answers (`ok` / `cancel` / `yes` / `no` / `abort` / `close`) —
it cannot press an arbitrary named button. The dialogs measured here (request pages) publish no
action nodes in their control tree, so there is nothing to name; if a build does publish them,
`bc_execute_action { section: "dialog", action }` is the path.

### `bc_reset_session` — the only way back to a clean session

Open forms and the modal stack are **per-SESSION** state, so nothing sent over a live session
clears them. `bc_close_page` closes ONE page, takes no `all`, and cannot lower `modalDepth` — it was
measured RAISING it (2 -> 3) while closing pages, because closing a page with unsaved changes makes
BC put up another modal. So a session that accumulated modals got progressively less usable and the
only remedy was a PERSON restarting the server process (bc-saas F-39 §4 ter), which also made every
doubtful failure unanswerable: "maybe it is the session" could not be tested.

`bc_reset_session` closes the session (gracefully, falling back to abrupt — a wedged session must
not be able to refuse) and opens a fresh one, so `openForms` and `modalDepth` are zero by
construction. Every page context dies and is reported in `invalidatedPageContextIds`; the result
also carries `droppedOpenForms` / `droppedModalDepth` so the caller can see what it discarded. The
**pinned company is preserved** — a reset is never a silent company change; `bc_switch_company` is
that, and it is the same mechanism minus the company.

It is registered OUTSIDE the `ensureSession()` gate, exactly like `bc_health`: the gate calls
`SessionManager.getSession()`, which THROWS `SessionLostError` on a dead session, so routing the
reset through it would make the tool unavailable in precisely the situation it exists for.

Files: `src/session/session-manager.ts` (`resetSession`), `src/operations/reset-session.ts`,
`src/mcp/tool-registry.ts` (`buildResetSessionTool`), `src/stdio-server.ts` / `src/server.ts`.
Tests: `tests/unit/session-reset.test.ts`.

### Writes and deletes never report success blindly
Two rules that the whole write path depends on, both verified live:
- **BC refuses a value without raising an error.** It completes the interaction and puts the reason in `ValidationResults` on the control. `bc_write_data` surfaces that as `reason: "validation error"` + `validationMessage` (e.g. *"Sale must be equal to 'Yes' in Item: No.=0000001"*). If a write "does not stick", read that message before assuming the code is broken — on `devel1` none of the first 15 items is sellable, which is exactly what it says.
- **BC can complete a Delete and keep the row** (an uncommitted placeholder line, or a page not opened for editing). `bc_execute_action` re-reads the repeater from the server and reports `deleted: true|false` + a `note`. When the delete opens a confirmation dialog, `deleted` is absent until you answer it — and the post-delete re-sync deliberately waits, because firing it while the modal is open destroys the dialog (`FormNotFoundException` on the answer).
- **A LINE write is judged on BC's ECHO, not on the row projection** (bc-saas F-2). Two things made
  `changed:false, reason:"validation reverted", newValue:""` the answer for line writes that had
  plainly worked: (1) `FormState.rows` holds cells keyed by the column's BINDER NAME
  (`1165569367_c2`), never by caption — only `readRows` remaps them — so a caption lookup found
  nothing, and a miss returned `''` instead of undefined, making every comparison `'' -> ''`; (2) the
  row projection is rebuilt from `DataLoaded` batches BC sends AFTER the SaveValue response the
  invoke waits for. `writeLineCell` now reads `lastEchoedStringValue(events, cellPath)` first (same
  ground truth the header path uses), falls back to the row, reports `already set` for an idempotent
  cell write, and when there is NO echo attaches a `hint` saying the verdict came from the row alone
  (a list not in edit mode silently ignores line writes — verified on devel1, where a Sales Order
  line and a setup list both refused the write and BC echoed nothing at all).

### Session Recovery
After a session-killing error, BC holds the NTLM slot for ~15 seconds. The SessionManager handles this with exponential backoff (up to `BC_RECONNECT_MAX_RETRIES` = 6 by default). If an invoke hangs indefinitely (confirmed BC bug), the session-level timeout (default 30s) kills the connection and triggers auto-recovery on the next request.

### Report Output Capture — only the WS-side path is missing
Report output **is** captured today: `bc_download_report` renders and downloads the PDF/Excel/Word
out-of-band through the headless browser (the same engine as `bc_screenshot`), and returns the file
path. What is still not possible is capturing the binary **over the WebSocket session itself**:
`bc_run_report` can execute a report and fill its request page, but BC delivers the rendered file via
`FileActionDialog` / `BrowserDownloadFileRequest` on a separate streaming channel (WCF
`StreamTransfer`), never inline in the WS response. So: to get a file, use `bc_download_report`; to
drive a request page interactively, use `bc_run_report`.

Reference: `ReportResultSetDownloadDecorator.SendReportStreamToClient()`, `NSClientCallback.DownloadFileAction()`, `Connection.DownloadStream` (decompiled, upstream)

### Async Message Timing
The invoke quiescence window (150ms) is a best-effort wait for trailing async `Message` notifications. In rare cases, late-arriving messages may be missed.

## Claude Desktop Configuration

Run from source (this repo) with `tsx`:

```json
{
  "mcpServers": {
    "business-central": {
      "command": "node",
      "args": [
        "D:/Proyectos/Aesva/business-central-mcp-esanpons/node_modules/tsx/dist/cli.mjs",
        "D:/Proyectos/Aesva/business-central-mcp-esanpons/src/stdio-server.ts"
      ],
      "cwd": "D:/Proyectos/Aesva/business-central-mcp-esanpons",
      "env": {
        "BC_BASE_URL": "https://devel1/BC",
        "BC_USERNAME": "admin",
        "BC_PASSWORD": "<password>",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0",
        "BC_TENANT_ID": "default",
        "LOG_LEVEL": "info",
        "LOG_DIR": "D:/Proyectos/Aesva/business-central-mcp-esanpons/logs"
      }
    }
  }
}
```

Note: `tsx` via `npx` pollutes stdout with `◇ injecting...` which breaks JSON-RPC. Use the direct path `node_modules/tsx/dist/cli.mjs` instead. For day-to-day use prefer the compiled `dist/` config below (no tsx in the loop).

### Fork config (AESVA `devel1`, compiled `dist`)

Run the compiled server (`npm run build` first) and point at the `devel1` container. `BC_APPLICATION_ID=NAV`
is the default, shown here for clarity:

```json
{
  "mcpServers": {
    "bc-ws": {
      "command": "node",
      "args": ["D:/Proyectos/Aesva/business-central-mcp-esanpons/dist/stdio-server.js"],
      "env": {
        "BC_BASE_URL": "https://devel1/BC",
        "BC_USERNAME": "admin",
        "BC_PASSWORD": "<password>",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0",
        "BC_TENANT_ID": "default",
        "BC_SERVER_MAJOR": "27",
        "BC_APPLICATION_ID": "NAV",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

The same block works in a project `.mcp.json` (Claude Code) or registered globally via
`claude mcp add bc-ws --scope user ... -- node <path>/dist/stdio-server.js`. After editing, restart
the client so it reloads the MCP.

To make the server available to **every** project once at user scope (recommended), follow the
step-by-step guide in [`docs/SETUP-GLOBAL.md`](docs/SETUP-GLOBAL.md).

## AI Assistant Guidelines

- When dispatching parallel worktree agents, group by file overlap (not by feature). Files like `types.ts`, `schemas.ts`, `page-context-repo.ts` are touched by many features -- put them in one agent to avoid merge conflicts.
- If stuck on a protocol issue, use the decompiled BC source (`bc-decompiled-analyzer` agent)
- Use `gpt5 high` or `zen` for second opinions on complex issues
- Use `Gemini 2.5 pro` for large file analysis
- Read files before writing them
- Check all protocol assumptions against decompiled source, not v1
