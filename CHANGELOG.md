# Changelog

All notable changes to `business-central-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (2026-08-10) — `bc_build_manual` understands tables and code blocks

- **GFM tables are real tables.** A header row, a `|---|---|` delimiter row (which also sets the
  column alignment via `:---` / `:---:` / `---:`) and the data rows. In `html` they render as a
  styled `<table>`; in `docx` as a genuine Word table (`w:tbl`) whose first row is flagged *repeat
  as header row*. Cells carry the usual inline formatting, a pipe that is content is written `\|`
  or wrapped in `` `code` ``, and a short row is padded to the header width. Previously a table
  printed as literal pipe characters.
- **``` fenced code blocks are verbatim blocks.** Nothing inside is formatted and indentation and
  blank lines are preserved, so ASCII diagrams and multi-line commands survive. `~~~` is accepted
  too, for content that itself contains backticks. In `docx` a listing is one shaded `ManualCode`
  paragraph per line — never one paragraph with breaks inside, which could not break across pages.
  Previously the fence markers printed as text.
- **Either one can now be longer than a page.** The paginator cuts a table by rows and a listing by
  lines across as many sheets as they need, cloning the `<thead>` so every part of a table keeps
  its column titles. It cuts to FILL the current sheet before moving the block whole, leaving at
  least 3 rows/lines behind so a remainder never reads as a stray. `scripts/verify-manual.ts` now
  carries a 46-row table and a 60-line listing and counts the rows/lines across every sheet, so a
  regression that clips content fails the check instead of passing quietly.
- **`###` is a sub-heading inside a step.** `## ` is still the step boundary; `###` and deeper now
  render as a sub-section title (`.md-sub` in HTML, the `ManualSubheading` Word style, outline
  level 1 so it reaches Word's navigation pane without polluting the manual's index). Previously
  they printed as a paragraph beginning with `#`, which is why long steps had to be faked with
  bold paragraphs.
- **A code fence hides structure from the source parser.** A `## `, an `![](…)` or an italic
  caption line inside a listing is content now, not a step, a figure or a caption — which is what
  lets a manual document this very format without cutting itself into pieces.
- **The diagnostics moved with the model.** The "Markdown table" and "fenced code block" warnings
  are gone, and so is the `###` one (all three are supported); two took their place: a table
  without its delimiter row, and a code fence that is never closed. The dropped-second-figure
  warning and every error case are unchanged.
- Spec, guide and tool description updated together: `docs/guides/manual-source-format.md`,
  `docs/tools/bc_build_manual.md`, `docs/guides/documenting.md` and the `bc_build_manual`
  description an MCP client sees.


### Added (2026-08-10) — `bc_build_manual` exports to Word, with the HTML's page breaks

- **`formats: ["docx"]` writes an editable Word document.** Third renderer over the same
  `ManualModel` (`src/services/manual-docx.ts`), so a manual is still authored once. It emits real
  Word paragraph styles (`ManualHeading`, `ManualBody`, `ManualNote`, `ManualCaption`, …) rather
  than hard formatting — the reader restyles the whole manual from the Styles pane — plus a running
  header, live `PAGE`/`NUMPAGES` footers, and an index of `PAGEREF` fields pointing at per-step
  bookmarks. `lang`, `cover` and `toc` now apply to HTML **and** DOCX; `assets` stays HTML-only.
- **The Word pages match the printed HTML.** The two outputs paginate incompatibly: the HTML by
  MEASUREMENT (the browser measures each unit against a real sheet), Word DECLARATIVELY (it
  re-flows and honours only rules). So the .docx is not built from rules alone —
  `measurePageBreaks` (`src/services/manual-paginate.ts`) renders the real HTML in the headless
  browser, reads back which sheet each unit landed on, and that map is replayed into Word as
  explicit `pageBreakBefore` flags. Every HTML unit gained a stable `data-uid` as the join key.
  The measured page number is also cached into each index field, so the index reads correctly
  before any F9.
- **A missing browser costs the breaks, not the manual.** `ManualService.measureBreaks` degrades to
  the declarative layout (a step per page, headings kept with their figure) and says so in
  `warnings` instead of throwing.
- **Prose is parsed once for all outputs.** `markdown-inline.ts` now exposes `parseBlocks` /
  `parseInline` returning a tiny AST that the HTML and Word renderers both walk; `renderBlocks` /
  `renderInline` became HTML renderers over it. Escaping stays in the HTML renderer, so the AST
  holds plain text and prose still cannot inject markup.
- **`imageInfo` reads PNG, JPEG, GIF and BMP headers** (`manual-render.ts`). The HTML can let the
  browser measure a figure; Word stores an absolute size, so an unreadable size means the figure
  cannot be placed at all. Anything still unreadable is dropped from the .docx **with a warning**,
  never silently.
- **`npm run verify:manual-html` is now `npm run verify:manual`** (`scripts/verify-manual.ts`). It
  keeps every HTML assertion and adds the Word export, built from the same measured layout. The
  claim that the Word pages match needs something that re-flows a .docx, so it converts with
  LibreOffice and compares page counts when `soffice` is installed — and reports the check as
  SKIPPED when it is not, rather than passing silently.
- Three library traps are documented in `CLAUDE.md` because each produced a file that opened but
  was subtly wrong: docx's `Bookmark` class gives every bookmark numeric id 1 (so all PAGEREFs
  resolve to the first step), its `bullet` shorthand injects a second `w:pStyle` that overrides the
  manual's body style, and rounding a scaled image width up pushes the figure past the printable
  area at 9525 EMU/px.
### Fixed (2026-08-10) — review of the tables / code / sub-heading pass

- **A cut step no longer reprints its heading.** The step-head unit carries the heading plus the
  FIRST prose block, so a step whose body opens straight onto a long table or listing was cloned
  heading and all — the step title printed again on every sheet the block spanned, and its
  `data-anchor` was duplicated with it. A continuation is the rest of a unit, never a new one, so
  the clone now drops both. The `verify:manual` fixture gained a step that opens on the big table
  and an assertion that each heading is printed exactly once; without the fix it reports
  `15 headings printed for 14 steps`.
- **The two parsers now close a code fence by the same rule.** `manual-source.ts` treated any line
  starting with the marker as a close, while the renderer (correctly) requires a bare run with no
  info string. A listing that shows Markdown (` ```markdown … ```markdown `) therefore ended early
  for the reader and ran on for the renderer: the reader began seeing `## ` inside the listing as
  real structure, the renderer swallowed the following prose into the code block, and **neither
  reported anything** — exactly the silent mangling this module exists to prevent. Both now call
  `isFenceClose`, and such a document is reported as an unclosed fence.
- The page-parity claim is now stated with its limit: a table or listing longer than a sheet is cut
  by the paginator where the browser measured, while Word re-flows it itself, so that step can come
  out a page longer or shorter and the index's cached numbers drift after it (footers stay right; F9
  re-resolves the index). `verify:manual` catches it via LibreOffice when installed.
- Dropped a redundant `isDivider` alias in `markdown-inline.ts`.

### Added (2026-08-10) — build from an existing Markdown file

- **`bc_build_manual` can build from an existing Markdown file** (`source`), so a manual someone
  already wrote becomes the printable A4 page or the Word document without being retyped. Images
  resolve relative to the `.md`; outputs land next to it. The accepted format is **exactly what the
  tool's own `md` output writes** — the generator is the specification, pinned by a byte-identical
  round-trip test. The alternative (parse whatever Markdown shows up) is unwinnable: "however the
  author wrote it this time" is not a contract.
- **`validate: true` checks a source document without building it**, returning `sourceDiagnostics`
  as `line N: severity: message`, sorted by line, with EVERY problem in one pass — an author must
  never have to rebuild to discover the next one. Errors (no title, no steps, a missing or remote
  image, unterminated front matter) build nothing; warnings (a table, a code fence, a `###`, a second
  figure in a step) build with that part degraded and are returned on a normal build too, so nothing
  is lost silently.
- Optional front matter (`lang` / `cover` / `toc` / `name` / `assets`) lets a source document carry
  its own build settings; an explicit argument still wins.
- Requesting the `md` output when it would overwrite the source document is refused with a clear
  error. The input is never destroyed.
- The format is published in the **tool description**, so any MCP client sees the spec before writing
  a line, and in [`docs/guides/manual-source-format.md`](docs/guides/manual-source-format.md).
- **Every step now starts on a new page**, in the HTML and in Word. A numbered heading halfway down
  a page reads as a subsection of what precedes it rather than as a new step.
- **A figure that misses its page by a little is scaled down instead of moved.** The paginator
  closes the overflow by shrinking the image, but only down to 75% of its natural size — past that
  a capture stops being readable in print and moving it whole is the better answer. The measured
  size travels to Word in `PageBreakMap.figures`, so both outputs embed the same figure. Verified in
  `verify:manual`: the fixture step lands in the window and saves a page (`step-5-fig=93%`).
- **Steps gained an `after` field: prose printed BELOW the figure.** `body` says what to do, `after`
  says what to notice in the image or what comes next. Rendered in all three outputs.
- **A step longer than a sheet no longer overflows the paper.** Prose used to be emitted as ONE
  unit per step (heading + the whole body), and the paginator's unit-by-unit fallback cannot split
  a single unit — so a long body ran off the bottom of the page. Prose is now measured one unit per
  Markdown block (`renderBlockList`), with the first block riding WITH the heading so a lone heading
  is never left at the foot of a sheet. Verified: a 9-paragraph step now flows across two sheets
  with `overflowing: []`, and the verify fixture covers the case.
- The Word break calculation takes a step's LAST unit, not its figure. With prose below the image
  the figure is no longer what closes a step, and comparing against it emitted spurious breaks.
- `docx` is a runtime dependency again. It was removed when the PDF/DOCX renderers were dropped in
  favour of print-to-PDF; the goal now is different — an **editable** deliverable, which the HTML
  print path cannot be.

### Fixed (2026-08-09, second pass) — full-codebase review

A five-subsystem review read every file in `src/` and produced ~60 verified findings; all of them
are fixed below. Verification: `npx tsc --noEmit` clean, `npx vitest run` **721 passed / 77 files**
(was 458 / 58 — 263 new tests). Everything not fixed is now tracked in
[`docs/ROADMAP.md`](docs/ROADMAP.md), which was restructured in the same pass.

**Protocol decoding and form state**

- **Every change is now routed to the form it actually targets.** The decoder stamped an entire
  handler batch with the handler-level formId, discarding each change's own
  `ControlReference.formId`. A single live batch mixes forms (the SaaS capture has handler 392
  carrying changes for 389), and because control paths are form-relative, a subform's
  `PropertyChanged` was applied to the wrong form's identically-pathed node — or dropped. The
  heuristic re-routing in the page-context repository existed to paper over this.
- **BC's non-modal messages are no longer discarded.** `MessageToShow` (AL `Message()`, licence
  warnings) is decoded into a typed event instead of vanishing, so a tool call that "succeeded"
  with a server message no longer looks silent. Unhandled session events are logged at debug, and a
  malformed handler now logs at warn with its type rather than being swallowed.
- **Abbreviated row-change keys no longer drop the whole rowset.** `extractRowChanges` matched only
  the long wire names although the codec declares abbreviations and the decoder honours them.
- **Repeater header actions (`ha[N]`) are parsed.** They were absent from the tree entirely, so
  those actions were invisible to `bc_execute_action` and property changes on their paths could
  never resolve. They surface with `isLineScoped: true` (a row must be selected first).
- **Option/enum fields publish their valid values** (`options`, `selectedOption`), on both DTOs, so
  an agent stops guessing an option's accepted text and discovering the rejection via
  `changed:false`. Ported from upstream v1.2.0.
- Also: `Data.CurrentBookmark` is mapped (the current-row bookmark never populated); a tagless wire
  node no longer loses its entire subtree; a `PropertyChanged` carrying nothing this projection
  tracks no longer rebuilds the root and discards every memoised view; distinct bookmark-less rows
  no longer collapse into duplicates; the `ExpressionProperties.Visible` fallback applies to
  containers, not only fields.
- **Timezone is derived, not hardcoded to Europe.** The OpenSession payload conflated the base
  offset with DST (Madrid in August effectively told BC +180) and shipped EU transition dates to
  every host. It now probes January/July for the standard offset and the DST delta, sends no window
  when the zone has no DST, and handles the southern hemisphere.

**Page contexts, sections and filters**

- **Drill-down no longer corrupts the source page.** Events for the newly opened form were applied
  to the originating context, overwriting its caption and pageType and leaving an immortal stray
  form that could steal later row data. (The same class of bug was found and fixed for parented
  forms.)
- **Filtering can no longer destroy the page you were on.** `reopenWithFilters` closed and removed
  the context *before* attempting the filtered reopen, so the most likely failure — a localized
  caption instead of an AL field name — left a dangling `pageContextId` and lost the list. It is
  now transactional, and it replays the original `tenantId`/`mode` instead of silently reverting to
  defaults.
- **Filter values with quotes or `&` work.** `L'Oreal` terminated the filter expression and
  `Foo & Bar` split the whole OpenForm query; quotes are escaped and the value is encoded.
- **Filtering an empty list returns no rows instead of throwing** "column not found" — the column
  vocabulary comes from the repeater's columns, not from the cells of whatever rows happen to be
  loaded. Wildcard patterns containing the literal text of the old sentinels no longer false-match.
- **"Cancel" on a wizard can no longer commit.** `CloseOk` (a commit terminator) was classified as
  cancel and the first match won, so document order decided whether cancelling confirmed. The
  wizard step index also no longer advances when a validation dialog blocked the step.
- **Writes tell the truth.** Writing the value a field already holds is reported as
  `reason: "already set"` and counted as success instead of a failed write agents would retry
  forever; when neither BC's echo nor the projection confirms anything, the result is `unverified`
  rather than claiming `changed:true` from the requested value. A line write whose caption resolves
  to a row template is refused unless a row is named, instead of silently writing to whichever row
  BC had current.
- **Narrowing parameters that match nothing are errors, not silence.** An unknown `tab` or `group`
  used to return the full field dump — precisely the payload blow-up they exist to prevent.
- Also: a closed subform's state is pruned so it cannot steal the live one's row data; a dialog is
  no longer registered in two contexts at once; a part containing a repeater is a `subpage` instead
  of being mistaken for document lines (which also stopped mislabelling the page as a `Document`);
  a system action the page does not publish errors with the available ones instead of invoking
  `server:c[0]` blind; a stale action path is never invoked after row positioning; the post-delete
  repeater re-sync uses the recipe that actually reloads rows; `filters` on a bookmark-opened card
  no longer silently repositions to another record; the Tell Me form is closed on error paths too;
  disabled actions are listed with `enabled:false` rather than hidden.

- **BC's reason for refusing a value is no longer thrown away.** When BC rejects a write it does
  not raise an error: the interaction completes and the reason rides along in `ValidationResults`
  on the control. Nothing read that array, so a perfectly explicable rejection surfaced as an
  unexplained no-op — and on line cells as nothing at all. `bc_write_data` results now carry
  `reason: "validation error"` plus `validationMessage` with BC's own text (e.g. *"Sale must be
  equal to 'Yes' in Item: No.=0000001"*). This is what turned an apparent "line writes do not work"
  into "this database has no sellable items"; see the note under Known issues below.
- **A line write now confirms its own effect.** It used to return `changed: undefined` on every
  success, so a write that filled a line in was indistinguishable from one BC silently ignored —
  nothing, including this project's own live battery, could tell them apart. The cell is re-read
  from the projection afterwards. Writing into a blank placeholder line COMMITS it and BC re-keys
  the row (`DraftRecord6250` -> a real bookmark) with the data arriving in a later batch, so when
  the row cannot be re-identified the result says `reason: "unverified"` with a hint to re-read —
  never a fabricated verdict.
- **Answering a dialog re-syncs the page's repeaters.** Confirming a line delete removes the record
  server-side and BC sends nothing that identifies the removed row, so the projection kept listing
  it — verified live on SaaS, where a freshly opened context showed 15 rows against the stale
  context's 16. `bc_respond_dialog` now re-reads repeater-bearing sections once the dialog chain is
  finished (new [repeater-sync.ts](src/services/repeater-sync.ts), shared with the post-delete
  path, which drops a duplicated copy of the same recipe). This is what took the SaaS live battery
  to **6 PASS / 0 FAIL** for the first time.
- **A Delete that BC quietly ignores is now reported as such.** A bookmark-targeted delete
  re-reads the repeater from the server and returns `deleted: true|false` plus a `note` when the
  row survived (an uncommitted placeholder row, or a page not opened for editing) instead of a bare
  `success: true`.
- **Deleting a document line no longer destroys its own confirmation dialog.** BC answers a row
  Delete on an editable document with a "Confirmar" modal. The post-delete repeater re-sync — itself
  an `InvokeAction` — fired immediately and tore that modal down, so the caller's
  `bc_respond_dialog` failed with `FormNotFoundException` and the line was never deleted. The
  re-sync now waits until no dialog is pending. Traced and verified live on `devel1` (page 42,
  `mode:"Edit"`): rows 18 → 17, and the row is gone in a freshly reopened context too.

**Session, connection and auth**

- **A hung BC now actually kills the session.** The RPC timeout fired before the session-level
  watchdog and returned an error without marking the session dead, leaving client and server state
  desynced (a form BC opened late was never tracked). The watchdog became a no-progress timer, so a
  legitimate multi-dialog recovery is no longer killed mid-way while a genuinely hung call still is.
- **The AAD headless browser no longer leaks on auth failure.** Three error paths returned without
  closing it; the leaked Chrome held the profile lock, so the next attempt could not launch — a
  recoverable failure became permanent. Profile close/relaunch is now sequenced.
- **The SaaS WebSocket is captured even if BC stops using a Web Worker** (the page's own CDP session
  is instrumented too), and `runReport` honours the SaaS rule of omitting `&tenant=`.
- **A failed licence-dialog dismissal is no longer invisible**, and no longer drops the dialog from
  local state while BC still holds it open.
- **Async events are no longer delivered twice** during modal reconciliation (duplicate row data).
- **Forced teardown terminates the socket** instead of waiting on a graceful close that a half-open
  connection may never complete, so `bc_health` stops reporting a zombie as connected. Queued
  invokes re-check for death instead of burning a full timeout.
- **BC 28.3 compatibility:** the WebSocket upgrade sends `Origin` (and a browser `User-Agent`) for
  on-prem too. BC 28.3 added an origin-validation middleware that 403s a bare upgrade.
- **Sign-in rejects bad credentials up front** (a redirect without an auth ticket was accepted as
  success), and a first-connect failure reports the real cause instead of a generic message.
- **`BC_TLS_INSECURE=1`** scopes certificate skipping to this server's BC connections (WebSocket,
  `/SignIn`, headless browser) instead of requiring `NODE_TLS_REJECT_UNAUTHORIZED=0`, which
  disables TLS verification for the entire process. The global variable still works.
- Also: `BC_BASE_URL` is validated at load; the company is pinned before the session is published
  (a concurrent call could read the wrong company after a reconnect); cookie parsing no longer
  corrupts nameless cookies or truncates paths containing `=`; `LOG_LEVEL=debug` reaches stderr and
  logs are flushed on shutdown.

**Browser services**

- **A report that ran is no longer reported as a failure.** With a format requested on a
  confirm-only request page, the OK was clicked (running the report) and only then was the format
  checked — the produced file was deleted with the temp directory while the caller was told the
  download failed.
- **A failed redaction is loud.** `redact` captions that were not found were silently discarded, so
  a screenshot shipped WITH the sensitive value visible and a clean-looking result. Outcomes are
  now reported per target with a top-level warning; the same diagnostics propagate to
  `bc_build_manual`, which discarded every capture result and could produce a manual full of
  un-annotated or half-loaded screenshots while reporting success.
- **A partial object-index refresh can no longer delete good entries.** A failed sub-range was
  merged as if complete, silently dropping those objects; the save now aborts naming the gaps. The
  cached index is also environment-stamped, so a Docker and a SaaS registration sharing a directory
  no longer answer with each other's object IDs.
- **A manual builds with one browser instead of one per step** (a 10-step manual paid ten launches
  plus SPA boots), and reports `warnings[]` per step. Figures accept a `caption`.
- Also: report results carry the parameter/format diagnostics they declared; an unmatched request
  page caption is flagged even on a successful download; a slow-rendering report is no longer
  misreported as "waiting for parameters" with its file deleted; a download completing during
  polling no longer throws; an invalid `lang` no longer fails the build after all captures; image
  paths with spaces work in Markdown; non-PNG files no longer yield garbage dimensions; "Show more"
  is clicked against a re-queried DOM; per-user Chrome and 64-bit Edge are found.

**MCP surface, transports and REST**

- **The REST API works on a cold server.** Every request — including ones that should have 404'd —
  returned HTTP 500 until an MCP call happened to build the route table first.
- **Oversized responses fail usefully.** A tool result over the limit returns `RESPONSE_TOO_LARGE`
  naming that tool's narrowing parameters instead of blowing the client's token budget, and an
  oversized inline screenshot drops only the image block (the PNG is on disk).
- **JSON-RPC correctness:** notifications no longer receive a response (over HTTP that response was
  an id-less, invalid frame); invalid JSON returns `-32700`, not HTTP 500; unknown resources and
  prompts use their proper codes; the client's `protocolVersion` is echoed when supported.
- **The stdio adapter no longer writes non-JSON-RPC frames to stdout** (notification replies, 401
  and 500 bodies) and supports `API_TOKEN`.
- **REST validates with the same schemas as MCP**, returning 400 with the issues instead of a deep
  `TypeError` as a 500 — and it validates before forcing a BC session, so a bad body fails fast.
  `pageId`/`reportId` are constrained to digits, closing an OpenForm parameter-injection vector.
- **Tool descriptions match the implementation:** `bc_navigate` no longer documents a `lookup`
  action and a `field` parameter that do not exist, `bc_write_data` describes the real
  requested/changed/reason contract instead of claiming read-only fields error, and
  `bc_close_page`'s description states that success does not mean closed.
- **Tool metadata no longer builds the service graph against a forged session**, so `tools/list`
  works with BC unreachable; the ~60 duplicated wiring lines between the two entrypoints are one
  shared builder; the version is read from `package.json` instead of being hardcoded in three
  places; `bc_list_companies` scrolls instead of silently truncating; browser operations now appear
  in `bc_health` metrics, as do validation and session-loss errors.
- Removed dead code: `src/mcp/page-context-validator.ts` (no callers), `src/index.ts` (a stub
  nothing imported), the unreachable always-`healthy` REST `/health` route.

### Added (2026-08-09) — documentation

- **[`docs/BASE-CONEIXEMENT-IA-BC.md`](docs/BASE-CONEIXEMENT-IA-BC.md)** — inventory of the external
  BC+AI ecosystem with URLs: Microsoft's MCP servers, community data/admin MCPs, AL development
  MCPs, agent/skill frameworks, Page Scripting tooling, and a routing table for when several BC MCP
  servers are registered at once.
- **[`docs/Plans/page-scripting.md`](docs/Plans/page-scripting.md)** — the exact plan for exporting
  agent sessions to Microsoft's Page Scripting YAML and replaying them with `@microsoft/bc-replay`.
- **[`docs/ROADMAP.md`](docs/ROADMAP.md)** restructured: capability gaps, the upstream parity list
  (with the protocol details upstream already verified live), Page Scripting, a specialised
  AL/BC testing agent, and ecosystem adoption ideas — each with the evidence that it works.

Fork (AESVA / Esanpons): real screenshots of the BC web client, a manual generator,
server health/diagnostics, report output capture, and the BC744 hardening (field
disambiguation, write verification, payload control). Additive and out-of-band where
relevant — none of the browser tooling touches the WebSocket protocol path, so the
existing data tools keep their full speed.

### Added (2026-08-09) — verified live on BOTH devel1 (on-prem) and the SaaS sandbox

Every item below was checked end to end with `npm run verify:features <docker|saas>`,
which drives the same Operations the MCP tools wrap. Remaining work: [`docs/ROADMAP.md`](docs/ROADMAP.md).

- **Create records (`bc_open_page { mode: "Create" }`).** Opens a BLANK, initialised record
  (BC runs OnNewRecord and the No. Series) that `bc_write_data` can fill — previously the only
  way to create anything was to fall back to browser automation, because
  `bc_execute_action { action: "New" }` merely navigates. `Edit`/`View` are accepted too.
- **Filter a document's lines (`bc_read_data { section: "lines", filters }`).** The OpenForm
  `filter=` query can only target a page's main list and BC's filter pane is a no-op on
  BC27/BC28, so line filtering was impossible. Lines are now matched client-side over every
  materialized row, and the response says so: `rowFilter { mode: "client", scanned, matched,
  truncated }`. Full BC value syntax (exact / `a..b` / `*x*` / `>n` / `<>x` / `a|b|c`).
- **Reads report their filters (`activeFilters`).** `bc_open_page` and `bc_read_data` now echo
  the server-side filters actually in force, so a caller no longer has to track them itself.
- **`bc_download_report` picks the output format** (`format: "pdf" | "excel" | "word" | "xml"`).
  If the report does not offer the requested format the download is ABORTED rather than
  silently returning a PDF, with `availableFormats` listing what its Send-to dialog offered.
- **`bc_download_report` fills Options-area request-page parameters** (`parameters`): dates,
  numbers, option pickers and booleans that map to checkboxes (a checkbox is only clicked when
  its state differs). Previously only RequestFilterFields could be set.
- **`bc_screenshot` reveals a document's Lines grid.** The reveal pass now expands every
  collapsed section header, not just FastTabs and sub-groups, so line captions (Quantity, Line
  Amount) can be highlighted or cropped. New `clickBeforeCapture: ["Lines"]` names a toggle
  explicitly when the sweep is not wanted.
- **`npm run objects:refresh -- <docker|saas> [--all]`** rebuilds the `bc_find_object` index
  from a terminal, and **`npm run verify:features <docker|saas>`** is the live cross-environment
  check for everything above. Both share one bootstrap (`scripts/lib/harness.ts`).

### Removed (2026-08-09)

- **Field-metadata assertions on the Customer Card** (`isLookup` on `No.`, `showMandatory` on
  `Name`). BC27 does not populate either flag for those controls; they are presentational hints
  that no tool behaviour depends on, so the expectations were dropped by decision instead of being
  left permanently red. The code that reads them is untouched — a build that emits them still
  surfaces them. Recorded in ROADMAP §11 (Non-bugs) so it is not re-filed as a bug.
- **The "dynamic AL editability" bug entry.** Its symptom (a write reported as `changed:false,
  reason:"not editable"` on a writable field) was the same false negative fixed below by trusting
  BC's wire echo. Re-file with the page and the raw `events` if it ever reappears.

### Fixed (2026-08-09)

- **`bc_write_data` no longer reports a successful write as failed.** The change check read the
  projected control tree, which stays empty on some page shapes (a document opened with
  `mode=Create`, pages whose groups use `Editable = <expression>`), so a write BC had accepted —
  the order was created, the customer resolved — came back `changed:false, reason:"validation
  reverted"`. It now trusts the value BC echoes on the wire for that control.
- **The object index no longer wipes itself on a non-English tenant.** Page 9174's columns are
  localized (`Id. objeto`, `Tipo objeto`), the English captions were hardcoded, so a refresh on
  the Spanish SaaS tenant parsed zero rows AND merged that empty result over the cache,
  destroying a 14k-object index. Columns are now resolved per locale, and a scan that finds
  nothing refuses to overwrite anything.
- **A sticky confirm dialog no longer resets the whole session.** Modal reconciliation sent only
  `Abort=320`, which BC ignores for confirm dialogs; the local stack was force-popped, BC kept
  the dialog, and the next interaction degraded into a full session reset that lost every open
  page. It now escalates `No=390` → `Cancel=310` → `Abort=320` → `CloseForm`, stopping at the
  first answer BC honours.
- **The selected company survives a reconnect.** After a session death (or an `al_publish`) the
  recreated session returned to the server-default company; the last `bc_switch_company` is now
  replayed on the new session.
- **Session-recovery race.** A tool call arriving while another was recovering took the
  "first connect" path, received a session with no warning, and failed later with a baffling
  "page context not found". Concurrent callers now join the same recovery and all receive
  `SessionLostError`.
- **A deleted repeater row no longer lingers.** BC does not reliably announce a row removal
  (verified live: a row Delete produced `InvokeCompleted` + `PropertyChanged` and no row-change
  payload at all), so the repeater is re-synced from the server after a Delete instead of
  trusting an incremental event.
- **`bc_open_page`'s `filters` parameter was invisible to MCP clients** — the JSON-Schema-safe
  variant of the schema had drifted from the runtime one and omitted it. Both are now generated
  from one shared field set, so they cannot drift again.
- **Integration suites are runnable again**: they load `.secrets/devel1.env` (with an actionable
  error when it is missing), run one file at a time so BC does not refuse a burst of concurrent
  sign-ins, and the MCP-endpoint suite no longer looks for the repo at the upstream author's
  hardcoded path — its three tests had never executed in this fork. The two suites that need a
  second BC (BC28) no longer fail against upstream's hardcoded `cronus28` host: they read
  `BC28_BASE_URL` and skip when it is unset.
- **Documentation drift**: CLAUDE.md, README and `manifest.json` no longer point at upstream
  paths, upstream releases or stale counters.

### Fixed (2026-07-04 audit)

Remaining work from that audit (re-verified 2026-08-09) lives in [`docs/ROADMAP.md`](docs/ROADMAP.md); the audit order-of-work document itself was consolidated into it and removed.

- **`bc_execute_action` now honours `bookmark`/`rowIndex` for row-scoped actions** (Delete/Edit/View/DrillDown/New). Previously these were silently ignored and the action hit whatever row BC had selected — a Delete could remove the wrong record while reporting success. The cursor is now positioned on the requested row first.
- **Concurrent tool calls no longer kill a healthy session.** The invoke timeout clock started when a call was *enqueued*, so time spent waiting behind other queued invokes counted against it; a queued call could time out and tear down a live session. The timeout now starts when the interaction is actually sent.
- **`bc_read_data` filters no longer accumulate.** Filters passed to a page context now REPLACE the previous ones by default (BC ANDs filter lines, so a second read used to intersect with the first and return zero rows). New `appendFilters: true` opts back into accumulation.
- **Non-fatal errors no longer tear down the session.** A substring match on `"code":1` also matched codes 10/12/19/100…; now matched exactly (word boundary), as the error translator already did.
- **Error diagnostics reach the caller.** `bc_*` errors now surface their typed `code` and diagnostic `context` (availableActions / availableSections / availableFields / hostHint / availablePageContexts …) so an agent can self-correct in one turn instead of extra discovery calls (MCP + REST paths).
- **`bc_write_data` / `bc_download_report` accept numbers & booleans** in `fields`/`filters` (coerced to text) instead of failing Zod validation on `{ "Quantity": 5 }`.
- **`bc_switch_company` reflects the switch** on the session, so `bc_health` and the screenshot/report deep-links stop targeting the previous company.
- **`bc_close_page` on a page with unsaved changes** no longer strands the save-changes dialog (which caused `MODAL_STUCK` on the next invoke). The dialog is surfaced with a live `pageContextId`, or auto-discarded with the new `discardChanges: true`.
- **Actions that open a page** (e.g. `New` on a list, cue drill-downs) now always return a usable `pageContextId` in `openedPages`.
- **Wrong-password sign-in is detected** up front (clear `AuthenticationError`) instead of surfacing later as an opaque WebSocket error; CSRF cookie identified by name (`.AspNetCore.Antiforgery.*`).
- Other correctness fixes: modal-reconcile events reach the page context; `bc_search_pages` closes its Tell Me form; closed dialogs are pruned from page-context bookkeeping; tolerant child-form parsing; async messages captured during session init; `bc_run_report` NaN guard; `PageService` uses the configured tenant; log value redaction (`LOG_REDACT_VALUES`) now works; HTTP token compared in constant time + request body size cap; logger stream error handling; unknown URLs 404 without forcing a BC session; `EADDRINUSE` reported clearly.

### Changed

- **`bc_build_manual` now renders a printable A4 web page, and no longer renders PDF or DOCX.**
  One authoring model, two outputs selected by `formats` (default `["md"]`): `md` as before, and
  the new `html` — real 210x297mm sheets with a cover, an index with resolved page numbers,
  running headers and `N / total` footers. The on-screen page IS the printed page, so Ctrl+P
  produces the paged PDF; a bundled paginator measures each block against the sheet and keeps a
  step heading with its screenshot. New HTML-only options: `assets` (`inline` single file /
  `files` separate css+js+png), `lang` (ca/es/en chrome), `cover`, `toc`. Prose (`intro`, step
  `body`) now accepts a small Markdown subset (lists, `>` notes, bold/italic/code/links) rendered
  in both outputs. The `docx` dependency and both the PDF and DOCX renderers are gone.
  Layout is guarded by `npm run verify:manual-html` (paginates in a real browser and asserts no
  sheet overflows and one printed page per sheet). See [`docs/tools/bc_build_manual.md`](docs/tools/bc_build_manual.md).
- `bc_navigate` dropped the unimplemented `lookup` action and the unused `field` parameter (kept `select` / `drill_down`).
- Package renamed to `business-central-mcp-esanpons` with fork author/repository metadata; removed the unused `zod-to-json-schema` dependency.
- Incorporates the request-page `filters` map + BC745 flat-schema fix from commit `db78c03` into this changelog.

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
