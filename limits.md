# bc-mcp Known Limitations

Observed during real-use sessions against BC27 + BC28 DemoPortal envs (Continia Document Output, customer card + factbox + queue pages). Each item listed with concrete repro + suggested fix or workaround.

## 1. `cuegroup` Card pages return placeholder field only

**Symptom**

`bc_open_page` against a Card page whose layout is built with `cuegroup` containers (cue tiles) returns:

```json
{
  "pageType": "Card",
  "caption": "Document Output",
  "fields": [
    { "name": "Document Output", "editable": false, "type": "" }
  ],
  "actions": []
}
```

The single "field" is the page caption used as a placeholder. No tile values, no drill-down hooks, no actions.

**Repro**

Page 6175308 `CDO Document Output Queues` (CardPart with cuegroup `DocumentQueueCueGroup`, `PrintQueueCueGroup`, etc.). AL definition:

```
PageType = CardPart;
SourceTable = Integer;
layout {
  area(Content) {
    cuegroup(DocumentQueueCueGroup) {
      field(FailedDocumentQueue; FailedDocumentQueue) { ... }
      field(DocumentQueue;       DocumentQueue)       { ... }
    }
    cuegroup(PrintQueueCueGroup) { ... }
  }
}
```

**Status (resolved 2026-04-28)**

bc-mcp now models cuegroups as a section-level `cues[]` projection. Open the
host Role Center via `bc_open_page` and each hosted CardPart appears as a
`subpage` (or `factbox` — BC's `IsSubForm=false / IsPart=true` classification)
section, with any cuegroup tiles surfaced as `section.cues[]`. Drill down via
`bc_execute_action { section, cue }` which sends `SystemAction.DrillDown=120`
against the cue's controlPath and returns the new pageContextId in
`openedPages`.

**Wire format finding (verified live, BC28 BUSINESS MANAGER profile):**

Cuegroups arrive as a NEW wire type `stackgc` (NOT a generic `gc` with a
mapping hint). Children are `stackc` cue tiles inside an inner
`gc { MappingHint: 'STACKGROUP' }`. Cue values arrive via PropertyChanged
events AFTER `LoadForm(loadData:true)`, NOT in the initial FormCreated. BC's
default Role Center hosts 14 CardParts, 9 of which carry cues (50 tiles
total: Activities=22, User Tasks=1, Job Queue Tasks=3, Email Status=3,
Approvals=2, E-Document Activities=2, Intercompany=3, Self-Service=6,
Shopify Activities=8).

**Standalone CardPart symptom:**

Opening page 6175308 standalone (the original limits.md repro) was
**Continia/CDO-specific**. Live testing against default BC28 with pages 1310
(Activities), 9061, 9152 all returned full content when opened standalone —
the placeholder-shell stub is NOT a generic BC behavior. bc-mcp still detects
this case defensively: `OpenPageOperation` returns a structured
`CardPartStubError` (with `code: 'CARDPART_STUB'` and a `hostHint`) when a
CardPart opens with zero captioned fields AND zero cue tiles, telling the
caller to reach the part through its host page.

**References**
- `src/protocol/captures/cuegroup-rolecenter-2026-04-28.json` — frozen wire fixture (619 KB, 16 hosted CardParts)
- `src/protocol/form-node.ts` — `StackGroupNode` and `CueFieldNode` first-class variants
- `src/protocol/cue-detection.ts` — type-guard wrappers
- `src/protocol/form-views.ts` — `cues(root)` memoised view
- `src/protocol/section-dto.ts` — `SectionCue` DTO + `Section.cues`
- `src/services/page-service.ts` — auto-load Role Center hosted CardParts (LoadForm `openForm:true` + Refresh)
- `src/services/action-service.ts` — `executeOnCue` with new-pcId registration
- `src/operations/open-page.ts` — `CardPartStubError` emission
- `tests/integration/role-center.test.ts` — 4-test live verification

**Original repro (Continia/CDO-specific)**

Page 6175308 `CDO Document Output Queues`. Opening this standalone on a
Continia-installed env returns the placeholder shell. Now mitigated by
`CardPartStubError`; the caller is told to open the host page (Continia's
Document Output Role Center) instead.

## 2. FactBox parts on a parent page are invisible to `bc_open_page` / `bc_read_data`

**Symptom**

Opening Customer Card (page 21) returns `changedSections` including `factbox:CDO Customer FactBox` after an action, but `bc_open_page` does NOT include factbox part fields in the parent's `fields` array. Calling `bc_read_data` with `section: "factbox:CDO Customer FactBox"` returns `{ "rows": [], "totalCount": 0 }`.

**Repro**

```
bc_open_page { pageId: 21, bookmark: <customer 10000> }
  → fields[] omits CDO factbox controls (Output Profile, Email Recipients, Log)
bc_read_data { pageContextId: <ctx>, section: "factbox:CDO Customer FactBox" }
  → empty
```

**Workaround**

Open the factbox page directly with its own `pageId` (e.g. `bc_open_page { pageId: 6175324, bookmark: <same customer bookmark> }`). FactBox pages are real Card / CardPart pages and render normally when opened standalone — `Output Profile` etc. appear as regular fields. Write through that context.

**Fix candidate**

Either (a) flatten attached factbox part contents into the parent page's response under `sections[]`, or (b) make `bc_read_data` with a `factbox:*` section actually fetch from the underlying part. Today the section name appears in `changedSections` (so the protocol exposes it) but the read pathway is missing.

## 3. Page-extension fields gated by `ApplicationArea` are server-filtered

**Symptom**

A page extension adds a field with `ApplicationArea = CDOBasic` (or any non-`#All` area). `bc_open_page` does not return the field, and `bc_write_data` with the field's caption returns `Field not found: ...` even though the AL source clearly defines it.

**Repro**

Customer Card 21, page extension `CDOCustomerCardExt` adds:

```
addlast(General) {
  field("CDO Send on Posting"; Rec."CDO Send on Posting") {
    ApplicationArea = CDOBasic;
  }
}
```

Before activating Document Output in the company: field absent from `bc_open_page` response. After running the Document Output Setup Wizard (which flips Continia Online activation true): field appears with caption `Send on Posting`.

**Cause**

BC's web-client form binder honors the active user's Application Area and the company's app activation state when materializing the page metadata. bc-mcp receives only the controls BC chose to send. The filter is server-side.

**Workaround**

Activate any Continia app (or otherwise enable the relevant Application Area) in the target company before driving the page through bc-mcp. For Continia DemoPortal envs, activation runs from the Document Output Setup Wizard.

**Fix candidate**

- Add an env var (e.g. `BC_APPLICATION_AREA=#All`) that bc-mcp passes to BC during connect / page open so metadata returns under the broadest area.
- Or document the activation requirement loudly in the README so users do not chase a phantom "page-extension didn't deploy" bug.
- Verify whether BC accepts an Application Area override on the WS form-init message; if so, plumb it through.

## 4. Modal dialog left open server-side persists across MCP calls

**Symptom**

A page action triggers a modal (request page, send-document dialog) that bc-mcp partially handles. If the dialog chain is abandoned (cancel, error, network blip) without fully closing, the BC server retains the modal state for the user session. Every subsequent bc-mcp tool call returns:

```
JSON-RPC error: errorType "Microsoft.Dynamics.Framework.UI.LogicalModalityViolationException",
message "There is a dialog box open in another browser window. You must close that dialog box or sign out."
```

**Status (partially resolved 2026-04-28)**

bc-mcp now auto-recovers in a two-stage process. Behavior depends on whether
BC's server honors the close-modal request.

**Stage 1 — transparent recovery (when BC honors Abort).** On
`LogicalModalityViolationException` during an invoke, `BCSession.invokeUnqueued`
calls `reconcileModalStack`, which walks the session's `modalStack`
(DialogOpened-pushed, FormClosed-popped) top-down and sends
`InvokeAction { systemAction: 320 (Abort) }` to each modal. After reconcile
clears the stack, the original interaction is re-encoded with fresh sequence
numbers and retried once. On retry success, the caller never sees the error.

**Stage 2 — degraded recovery (when BC keeps the modal sticky).** Live
testing on BC28 shows that for confirm dialogs (e.g. the "Delete the
selected record?" confirm) BC does NOT emit `FormClosed` in response to
`Abort=320` against `controlPath: 'server:'`. The local stack force-pops to
maintain consistent client state, but the server-side dialog persists. When
that happens the retry hits another `LogicalModalityViolationException`,
`reconcileModalStack` returns `ModalReconcileError`, the session is marked
dead, and `SessionManager` recreates it. The caller sees `SessionLostError`
with the list of invalidated `pageContextId`s and re-opens any pages it
needs. This is still strictly better than the original behavior (where the
violation bubbled forever), but it is not "transparent" — page contexts are
lost.

**References**
- `src/session/bc-session.ts` — `invokeUnqueued`'s LogicalModalityViolation
  branch (queue-bypassing) and `reconcileModalStack`
- `src/session/modal-stack.ts` — ordered stack with `peek` / `pop` / `remove`
- `src/core/errors.ts` — `ModalReconcileError`
- `tests/integration/modal-recovery.test.ts` — live BC28 verification of
  tracking + reconcile-driven local cleanup
- Decompiled `Microsoft.Dynamics.Framework.UI.LogicalModalityVerifier` and
  `LogicalDispatcher.Frames` — server-side stack model that we mirror

**Open follow-up**

Closing a sticky confirm dialog server-side is non-trivial. Investigation
candidates: (a) target the dialog's child controlPath (e.g. the No/Cancel
button) instead of `server:` for `Abort`; (b) use `SystemAction.No=390`
which the dialog's own actions map to `MessageFormActions.Cancel` per
`LogicalDialog.cs`; (c) accept the degradation since session recreation is
a clean fallback.

**Repro of the original failure**

Click `Send/Print` on a posted Sales Invoice; bc-mcp surfaces the Send
Document dialog; user responds `ok`; BC chains another modal that bc-mcp
doesn't surface; cancel out. Next `bc_list_companies` call previously bubbled
`LogicalModalityViolation` forever; now it triggers stage-1 (transparent
retry if BC closes) or stage-2 (session reset, `SessionLostError`).

## 5. `bc_search_pages` (Tell Me) returns empty results in some envs

**Symptom**

`bc_search_pages { query: "customer" }` returns `{ "results": [] }` even though the BC web client's Tell Me box finds matches in the same env.

**Repro**

Continia DemoPortal BC28 env, super user. Searches that work in browser return empty from MCP.

**Status (resolved 2026-04-28)**

Two distinct issues, both fixed.

**Primary root cause: wrong controlPath in SearchService.** The Tell Me search
form has its sc input at `server:c[0]/c[0]` (inside a gc container at
`server:c[0]`). bc-mcp was sending `SaveValue` against `server:c[0]` — the gc
container itself — which BC accepts silently and returns `InvokeCompleted`
with no `DataLoaded` events. No rows ever reached the extractor. Fixed by
sending against the actual sc input path. Verified by live capture (BC28
default profile, query "customer"): 23 page rows + 32 report rows now arrive.

**Secondary issue: profile-scoped Tell Me index.** BC's Tell Me index is
populated based on the active session's profile (which Role Center,
which department menu). On envs where the default profile has a sparse
index, queries that work in the BC web client (signed in to a specific
profile like Business Manager) return empty from bc-mcp. Fixed by adding
`BC_PROFILE` env var that's plumbed into OpenSession's `profile` field
(verified against decompiled `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs`
and `Microsoft.Dynamics.Nav.Service/NSService.cs:OpenConnection`). Common
values: `BUSINESS MANAGER`, `ACCOUNTANT`, `SALES ORDER PROCESSOR`. Server
uppercases and trims; unknown ids silently fall back to user default.

**Result extractor rewrite.** The original extractor returned
`{ name, pageId, type }` with `pageId` always empty (the wire shape was
never reverse-engineered). Live capture revealed BC's Tell Me row format
uses NAMED cells (Name, Source, DepartmentPath, DepartmentCategory,
SearchScore) and identifies pages by AL name (string), not numeric id, in
`cells.Source.stringValue` JSON. The new shape:

```ts
SearchResult {
  name: string;             // display caption (e.g. "Customers")
  objectType: string;       // "page" | "report" | "codeunit" | ...
  runTarget: string;        // BC AL name (e.g. "Customer List")
  departmentPath?: string;  // e.g. "Departments/Financial Management/Receivables"
  category?: string;        // "Lists" | "Tasks" | "Reports" | ...
  score?: number;           // BC's relevance score
}
```

**Empty-result diagnostic.** When `bc_search_pages` returns zero rows,
`SearchPagesOutput.note` carries a hint string mentioning `BC_PROFILE` so
the caller can disambiguate "search wasn't issued correctly" from "search
ran but Tell Me index is empty for this profile".

**Open follow-up: name-to-id resolution.**
`bc_open_page` still takes a numeric `pageId`. Tell Me returns AL names
(`runTarget: "Customer List"`). To open a search result, callers either
have to know the numeric id by other means or invoke the page through a
future enhancement that accepts a name.

**References**
- `src/services/search-service.ts` — fixed controlPath (`server:c[0]/c[0]`)
- `src/services/tell-me-extractor.ts` — structured row decoding
- `src/protocol/captures/tell-me-result-2026-04-28.json` — frozen wire fixture
- `src/protocol/captures/README.md` — verified row shape
- `tests/integration/search-pages.test.ts` — live verification

**Continia / Document Output known page IDs (still useful for direct opens)**

| Page ID | Name |
|---|---|
| 6175277 | Document Output Log |
| 6175280 | CDO Customer Card |
| 6175286 | Unhandled Posted Sales Invoices |
| 6175295 | CDO Setup Wizard |
| 6175297 | CDO Queue Entry |
| 6175308 | CDO Document Output Queues (cuegroup, see #1) |
| 6175324 | CDO Customer FactBox |

## 6. URL parsing requires trailing slash

**Symptom**

`BC_BASE_URL=https://host/path` (no trailing slash) → bc-mcp's connect attempt fails before getting to NTLM. Sometimes manifests as silent hang, sometimes as `Session creation failed after all retry attempts`.

**Workaround**

Always end `BC_BASE_URL` with `/`. Verified working: `https://demoportaldev.continiaonline.com/<envGuid>/`.

**Fix candidate**

Normalize `BC_BASE_URL` in `src/connection/` — trim, then append `/` if missing, then validate. Surface a clear error early if the URL is malformed rather than letting it fail at WS upgrade.

## 7. Queue / Job-Queue dispatcher is a separate concern

**Symptom**

A successful `bc_execute_action { action: "Post" }` on a Sales Invoice with auto-send configured produces an entry in `CDO Queue Entry` (table 6175341 / page 6175297), but no Document Output Log entry. Tester expects "log entry exists right after posting" and reports a bug.

**Cause**

This is not bc-mcp behavior — it is the AL implementation. `OnAfterFinalizePosting` calls `EmailHandler.DocHandle(UseQueue := true, ...)` which enqueues. The BC Job Queue (or manual `Start Dispatcher`) then drains the queue, sends emails, writes the log row.

**Workaround / clarification**

When using bc-mcp to drive a posting flow that should result in a log entry, either (a) assert against `CDO Queue Entry` instead, (b) trigger `Start Dispatcher` after posting and respond to its dialog chain (one prompt per entry — tedious), or (c) ensure Job Queue is running in the env to process automatically.

Not a bc-mcp bug; documented here so it does not get filed against bc-mcp again.

## See also

- `BC28Repro.md` — initial session-death repro on BC28 DemoPortal (now fixed) plus the page-extension-fields-invisible follow-up bug.
- `ContiniaEnvSupport.md` — investigation list for first-class Continia DemoPortal support (URL routing, auth, profiles, license popups).
