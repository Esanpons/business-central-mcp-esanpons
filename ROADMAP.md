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
- **`manifest.json` `entry_point` consistency.** The current `manifest.json` declares `entry_point: "dist/stdio-server.js"` because the `@anthropic-ai/dxt` CLI schema requires the field, but the `.dxt` archive intentionally does not bundle `dist/`. Claude Desktop's runtime reads only `mcp_config` (verified against the `@anthropic-ai/dxt` SDK source), so `entry_point` is effectively unused. Verify this empirically during the next manual smoke test, and revisit if a future schema or runtime starts honoring `entry_point`.
- **VSCode one-click `inputs`.** The `vscode:mcp/install?{json}` URI in the README installs the server with no env vars, leaving the user to edit `mcp.json` manually for credentials. VSCode's MCP install URI supports an `inputs` array that can prompt for `BC_BASE_URL`, `BC_USERNAME`, `BC_PASSWORD` at install time. Adopt once we can verify the resulting URI against current VSCode releases.

## Output & files

Now feasible because the headless browser (added for `bc_screenshot` / `bc_build_manual`) is in the stack, so these no longer require reverse-engineering BC's WCF `StreamTransfer` channel.

- **Capture report output (PDF / Excel / Word).** Today `bc_run_report` can run a report and fill its request page but cannot download the rendered file. Drive the report in the headless browser (the request page renders there) and capture the resulting download (`FileActionDialog` / `BrowserDownloadFileRequest`). The big remaining win for finance reports, invoices, statements.
- **File upload.** Attach documents / import data by driving a browser `<input type="file">` for the BC upload flow. Symmetric to the download channel above.

## Reach & robustness

- **OAuth / AAD** — see Auth (BC Online / SaaS). The single biggest reach unlock.
- **Document pages multi-repeater.** `PageState` tracks one repeater; document pages (Sales Order 42/43, Purchase Order 50/51) have a header repeater AND a lines subpage repeater, so drilling down can use the wrong repeater's bookmarks. Track header vs lines repeaters separately (the `DataLoaded` event's `controlPath` identifies which one).
- **Page name -> id resolution.** `bc_search_pages` returns AL names (`runTarget: "Customer List"`) but `bc_open_page` needs the numeric id. Add a resolver (or let `bc_open_page` accept a name) so a search result can be opened directly.
- **FactBox content via the parent page.** Reading a `factbox:*` section from the parent page returns empty (limits.md #2). Either flatten the attached part's content into the parent response, or have `bc_read_data` fetch from the underlying part. Workaround today: open the FactBox page by its own id.
- **`BC_BASE_URL` normalization** (limits.md #6). Trim, append a trailing slash if missing, validate early, and fail with a clear message instead of a silent hang at WS upgrade.

## Testing & CI

- **CI that spins up a BC container and runs the integration tests.** A GitHub Actions workflow that: (1) starts a BC container (`mcr.microsoft.com/businesscentral` directly, or via bccontainerhelper) and waits for it to report healthy; (2) injects `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` (and `NODE_TLS_REJECT_UNAUTHORIZED=0`) as secrets; (3) installs Chrome/Edge on the runner (needed by the `bc_screenshot` / `bc_build_manual` integration tests); (4) runs `npm run test:integration`. Real constraints to design around: the BC image is large (~GB) and slow to start (minutes), licensing must be handled, secrets must be scoped, and a browser must be present — so this likely wants a **self-hosted / Windows runner** or a **scheduled (nightly) job** rather than running on every PR. The unit/protocol suite (`npm test`, no BC needed) stays the per-PR gate.
- **Broaden integration coverage.** The `tests/integration/screenshot.test.ts` skip-guard pattern (skip when BC env / Chrome absent) is the template for keeping the integration suite CI-safe.

---

# Expansion ideas (brainstorm backlog)

Ideas captured 2026-06, grouped by theme, with rough effort (S/M/L) and feasibility notes.
Some overlap with the sections above (e.g. page name→id, report output, file upload, OAuth)
— those are cross-referenced, not repeated. Two lenses drove this list: make the server a
better tool for the **LLM agent** that drives it, and accelerate **AL development / BC
consulting** work.

## Agent ergonomics (MCP usability)

Make the server faster, cheaper, and more reliable to drive — especially for an LLM client.

- **`bc_describe_page` — compact page summary.** Return a short summary (page type, caption,
  key fields+values, section list, row count, available actions) instead of the full JSON.
  `bc_open_page` on large lists/Role Centers can blow an LLM's token budget (observed: page 22
  = 71 KB / 2299 lines, exceeded the limit and spilled to a file). ~300 tokens vs 70 KB. Highest
  everyday ROI. (S)
- **Cap large outputs by default.** `bc_open_page` / `bc_read_data` return the first N rows +
  `totalRowCount` + a hint to use `range`/`filters`, instead of dumping every row. (S–M)
- **Open by page name.** Let `bc_open_page` accept an AL name (resolve via the navigation tree
  / a name→id map). Closes the loop with the `bc_search_pages` name→id item under *Reach &
  robustness* so a search result can be opened directly. (S–M)
- **Self-correcting field/action errors.** When a write/action targets a missing caption,
  include the available captions (and the closest match) in the error so the caller can retry
  in one turn. Builds on `src/core/error-translator.ts`. (S)
- **Address records by primary key.** Target a record by its PK value (e.g. customer "10000")
  instead of an opaque, session-scoped bookmark — robust across sessions, human-readable. (M)
- **`bc_help` / capability index.** A tool that lists what the server can do and common task
  recipes, so the client discovers capabilities without trial-and-error. (S)
- **Task recipes as skills.** A library of verified multi-step recipes (create customer, post
  sales order, …) as skills like `bc-manual`, so the agent follows a known-good path. (S each)
- **Dry-run / preview for writes.** Preview what a write/post would change without committing
  — safer automation. (M)
- **Read cache.** Cache read-heavy queries to avoid re-hitting BC for repeated lookups. (M)

## Data & productivity

- **`bc_query` — OData/API hybrid read engine.** BC exposes OData/API endpoints; use them for
  fast, paginated bulk reads/exports while keeping the WebSocket for UI-faithful operations.
  Big speed win for data extraction. (L)
- **Export a list to CSV / Excel / JSON.** One-shot export of any list section. (S–M)
- **Bulk edit.** Apply a value to all rows matching a filter. (M)
- **Templated record creation.** Create N records from a spec / CSV. (M)
- **Cross-company reporting.** Read the same page across all companies and aggregate. (M)

## Screenshots & visual (browser-powered)

Now feasible because the headless browser is in the stack (for `bc_screenshot`/`bc_build_manual`).

- **Record a workflow to video / GIF.** Animated tutorials (CDP screencast → GIF/MP4); extends
  `bc_build_manual`. (M)
- **Visual regression.** Screenshot a page before/after a change and diff the images — verify
  AL changes visually. (M)
- **Print a page to PDF** (a card/list, not a report). (S)
- **Accessibility / UX audit** of a page (axe-core in the browser). (M)

## Manuals & training

- **Templates & branding.** Company logo, cover page, header/footer in the PDF/DOCX. (S–M)
- **Multi-language manuals.** Generate the same manual in several languages (switch BC user
  language + translate prose). (M)
- **HTML output / interactive walkthrough.** A navigable doc site, and clickable hotspots over
  screenshots. (M)
- **Field dictionary.** List every field of a page (caption, type, description) as a quick
  reference. (S)
- **Role-based manual bundles.** Generate all manuals for a given role at once. (M)
- **Checklists / quizzes** from a process. (S)
- **Animated GIFs in manuals** (depends on the screencast item). (M)

## Analytics & dashboards

- **Charts from list data**, rendered in the browser and embedded in the PDF. (M)
- **KPI trends from Role Center cues** over time. (M)
- **Daily dashboard snapshot** of the Role Center. (S)

## AI-native helpers

- **Fill forms from a document / email.** Extract data from a PDF/email and create the BC
  record (invoice → order). (M–L)
- **Natural-language queries → filters.** "customers in Barcelona with balance > 1000" compiles
  to BC filters. (M)
- **Anomaly detection** in a list (outliers, blanks, duplicates). (M)
- **Reconciliation assistant** (match invoices to payments / statements). (L)

## QA & upgrade safety

- **Smoke-test a set of pages.** Open N pages and assert they load — catch what an AL deploy /
  BC upgrade broke before the customer does. Reuses the existing session stack. (M)
- **Synthetic monitoring.** Run a workflow on a schedule and alert on failure. (M)
- **Page-open timing** to surface slow pages. (S)

## AL developer toolkit

For AL development. Some need a data source beyond the UI WebSocket protocol (the dev/symbol
endpoint, OData metadata, the test toolkit, the event log).

- **AL object & metadata explorer.** Resolve page/table/report/field IDs and structure by name.
  Page-level info is reachable today (navigation tree / Tell Me); deep metadata (table
  relations, symbols) needs the dev/metadata endpoint. (M)
- **Run AL test codeunits and capture results.** Drive the Test Tool (page 130401) / test
  toolkit; return pass/fail. (M–L)
- **Telemetry / event-log reader.** Pull recent BC service events / Application Insights to
  debug an extension or a customer incident. Needs access to that source. (M)
- **AL test scaffolding generator.** Generate a page-object / test stub from a page. (M)
- **Permission set inspection.** Report what a user/role can do. (M)
- **RapidStart configuration packages.** Import/export setup data. (M–L)

## Migration & data hygiene

- **Environment diff.** Compare config + master data between environments (dev vs prod). (M–L)
- **Duplicate / blank detection** in master data. (M)
- **Anonymization** for test copies (mask sensitive fields). (M)
- **Mass create from CSV.** (M)
- **Configuration / setup documentation.** Document a customer's configuration (like manuals,
  but of the setup pages). (M)

## Integrations & delivery

- **Email / Teams a manual or screenshot.** Distribute documentation directly. (S–M)
- **Upload to SharePoint / OneDrive.** (M)
- **Push data to Google Sheets / Excel Online.** (M)
- **Webhooks for BC events.** React to changes (new order → notify). (L)

## Safety & multi-environment

- **Multi-environment.** Connect to several BC environments and switch between them. (M)
- **Audit log of writes.** Record who changed what for traceability/compliance. (S–M)
- **Dry-run mode.** See *Agent ergonomics* — preview writes before committing.
