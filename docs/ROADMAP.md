# Roadmap, backlog & known limitations

This is the single home for **everything not yet done**: current limitations (with
workarounds), planned work, and the brainstorm backlog of ideas for future audits. For what
**is** done, see the [tool reference](./README.md) and [`CHANGELOG.md`](../CHANGELOG.md).
Execution records of completed work live under [`docs/Plans/`](./Plans/) and the historical
design specs under [`docs/superpowers/`](./superpowers/).

---

## 1. Current limitations (with workarounds)

Real limitations observed against live BC27/BC28. Most earlier issues are resolved (Tell Me
search, Role Center cuegroups, modal-stack recovery, field disambiguation, write
verification); what remains:

| # | Limitation | Workaround |
|---|-----------|------------|
| L1 | **FactBox content via the parent page can be empty.** Reading a `factbox:*` section from the parent page sometimes returns no rows even though the section id is listed. | Open the FactBox page by its own `pageId` (it renders fully standalone), or rely on the section appearing once auto-loaded. |
| L2 | **`ApplicationArea`-gated fields are server-filtered.** Page-extension fields gated by a non-`#All` Application Area are not sent by BC until the area is active in the company. `bc_write_data` returns `Field not found`. | Activate the area first (page 9178 Application Area Setup, or the vertical app's setup wizard via `bc_open_page` + `bc_wizard_navigate`), then re-open the page. Server-side behavior; no client override exists. |
| L3 | **Sticky confirm dialogs.** A confirm dialog that BC keeps server-side after `Abort=320` triggers degraded recovery: the session is reset and `SessionLostError` is returned (page contexts lost). | Re-open pages after a `SESSION_LOST`. Transparent recovery works when BC honors the close; only sticky confirms degrade. |
| L4 | **Document pages track a single repeater.** Document pages (Sales Order 42/43, Purchase Order 50/51) have both a header and a lines repeater; drilling down from the list can use the wrong repeater's bookmarks. | Use `section: "lines"` explicitly; prefer bookmarks read from the same section. |
| L5 | **`bc_download_report` request-page parameters / explicit format.** Reports runnable with their defaults download end-to-end via the default "Send to → Aceptar" flow (verified live: report 6 → `Trial Balance.pdf`, report 120 → `Aged Accounts Receivable.pdf`). What's NOT yet supported: (a) reports that need **mandatory parameters** (e.g. per-customer statements 116 / 1316 need a customer + period) — they return `downloaded:false` / `requestPageShown:true`; (b) forcing a **specific output format** (the Send-to dialog exposes a radio group, captured but not yet driven). Generic per-report parameter filling is a larger, report-specific feature. | Use reports runnable with defaults, accept the default format (PDF), or fill the request page via `bc_run_report`. The DOM is captured by `scripts/capture-report-requestpage.ts` for when the flow is extended. |
| L6 | **`bc_screenshot` captures saved state only.** It opens an independent browser session on the saved record, so it cannot capture unsaved/transient on-screen state. | Save before capturing; for transient-state evidence the only option today is an external browser. (Synthetic FormState render was considered and deferred — see P3 below.) |
| L7 | **Live company re-apply after reconnect.** After `al_publish` / session death, the recreated session returns to the server-default company. | Re-verify with `bc_health` / `bc_list_companies` and re-issue `bc_switch_company` after publishing. |
| L8 | **`bc_search_pages` returns AL names, not numeric ids.** Tell Me results carry `runTarget` (AL name) but `bc_open_page` needs a numeric id. | Resolve the id with `bc_find_object`, then open by id. |

Non-bugs (documented so they are not re-filed): `ApplicationArea` filtering is server-side;
the Job-Queue dispatcher draining `CDO Queue Entry` is AL behavior, not bc-ws.

---

## 2. Planned work (prioritized)

### Auth & reach
- **OAuth / AAD authentication** — currently NavUserPassword only. Unlocks BC Online (SaaS)
  and modern on-prem. Largest single gap.
- **Windows authentication** — for domain-joined on-prem where NavUserPassword is off.

### Protocol & robustness
- **Document-pages multi-repeater** (L4) — track header vs lines repeaters separately using
  the `DataLoaded` event's `controlPath`.
- **Page name → id resolution** (L8) — let `bc_open_page` accept an AL name (resolve via the
  navigation tree / object index) so a `bc_search_pages` result can be opened directly.
- **FactBox content via the parent page** (L1) — flatten the attached part's content into the
  parent response, or have `bc_read_data` fetch from the underlying part.
- **`BC_BASE_URL` normalization** — trim, append a trailing slash if missing, validate early,
  fail with a clear message instead of a silent hang at WS upgrade.
- **Sticky-confirm close** (L3) — target the dialog's No/Cancel child control (or
  `SystemAction.No=390`) instead of `server:` for `Abort`, to close server-side without a
  session reset.
- **Re-apply last company on reconnect** (L7).
- **BC29+ wire-compat verification** — verify each new BC version as it ships.

### Report / output & files
The headless browser (added for `bc_screenshot`) is in the stack, so these no longer require
reverse-engineering BC's WCF `StreamTransfer` channel.
  `bc_download_report` already downloads request-page reports via the default "Send to → Aceptar"
  flow (DONE, verified live: reports 6 and 120). Two distinct follow-ups remain:
- **TODO — `bc_download_report` explicit output format** (`format: "pdf" | "excel" | "word"`). *Small.*
  The "Send to…" dialog exposes a radio group (`name="b13"`, options `b13_0..b13_5`) + an "Aceptar"
  confirm. Lead: run `scripts/capture-report-requestpage.ts <id>` (it resolves each field's `label`),
  map format → radio index, then select that radio before clicking Aceptar in
  `ReportDownloadService.driveRequestPage`. Today the default format (PDF) is used.
- **TODO — `bc_download_report` mandatory request-page parameters** (e.g. per-customer statements
  116 / 1316 need a customer + period). *Large / per-report.* Each report's parameters differ, so this
  needs a real design (accept a `parameters` map keyed by request-page caption and set each field in
  the browser before running). Until then these reports correctly return `requestPageShown:true`; fill
  them via `bc_run_report`.
- **File upload** — drive `<input type="file">` for BC's upload flow (symmetric to download).
- **P3 — capture live/transient state.** Render the in-memory `FormState` (which holds unsaved
  changes) to HTML/PNG so unsaved fields/dialogs can be documented without an external browser.
  Deferred by decision; recorded here so it is not lost.

### Distribution & install ergonomics
- **Cursor support** (install badge + `~/.cursor/mcp.json` snippet).
- **Interactive `npx business-central-mcp init` wizard** (detect hosts, prompt for creds, write
  config) + per-OS host auto-detection.
- **Sign the `.dxt`** once Claude Desktop signing stabilizes.
- **MCP marketplace** publication.
- **`manifest.json` `entry_point` consistency** — verify the field is unused at runtime.
- **VSCode one-click `inputs`** — prompt for `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` at
  install time.

### Testing & CI
- **CI that spins up a BC container and runs the integration tests** (self-hosted / nightly:
  the BC image is large and slow, needs a browser for screenshot tests). The unit/protocol
  suite stays the per-PR gate.
- **Broaden integration coverage** using the skip-guard pattern in
  `tests/integration/screenshot.test.ts`.

---

## 3. Expansion ideas (brainstorm backlog)

Ideas for future audits, grouped by theme with rough effort (S/M/L). Some overlap with §2 —
cross-referenced, not repeated.

### Agent ergonomics (MCP usability)
- **Cap large outputs by default** — first N rows + `totalRowCount` + a hint to use
  `range`/`filters`. (S–M) *(partially covered by `bc_open_page` `summary`/`sections`.)*
- **Open by page name** — see §2 name→id. (S–M)
- **Self-correcting field/action errors** — include available captions + closest match in the
  error so the caller retries in one turn. (S)
- **Address records by primary key** instead of an opaque bookmark. (M)
- **`bc_help` / capability index** — a tool that lists capabilities + common recipes. (S)
  *(This roadmap + the [tool index](./README.md) partly cover it; a tool form would close it.)*
- **Task recipes as skills** — verified multi-step recipes (create customer, post order) as
  skills like `bc-manual`. (S each)
- **Dry-run / preview for writes** — preview what a write/post would change. (M)
- **Read cache** for repeated lookups. (M)

### Data & productivity
- **`bc_query` — OData/API hybrid read engine** for fast paginated bulk reads/exports. (L)
- **Export a list to CSV / Excel / JSON.** (S–M)
- **Bulk edit** (value to all rows matching a filter). (M)
- **Templated record creation** from a spec/CSV. (M)
- **Cross-company reporting** (same page across all companies, aggregated). (M)

### Screenshots & visual (browser-powered)
- **Record a workflow to video / GIF** (CDP screencast → GIF/MP4). (M)
- **Visual regression** (screenshot before/after, diff). (M)
- **Print a page (card/list, not a report) to PDF.** (S)
- **Accessibility / UX audit** (axe-core in the browser). (M)

### Manuals & training
- **Templates & branding** (logo, cover, header/footer). (S–M)
- **Multi-language manuals.** (M)
- **HTML output / interactive walkthrough.** (M)
- **Field dictionary** (every field of a page: caption, type, description). (S)
- **Role-based manual bundles.** (M)
- **Checklists / quizzes** from a process. (S)

### Analytics & dashboards
- **Charts from list data**, embedded in PDF. (M)
- **KPI trends from Role Center cues** over time. (M)
- **Daily dashboard snapshot.** (S)

### AI-native helpers
- **Fill forms from a document / email** (invoice → order). (M–L)
- **Natural-language queries → BC filters.** (M)
- **Anomaly detection** in a list. (M)
- **Reconciliation assistant** (invoices ↔ payments/statements). (L)

### QA & upgrade safety
- **Smoke-test a set of pages** (open N pages, assert they load). (M)
- **Synthetic monitoring** (run a workflow on a schedule, alert on failure). (M)
- **Page-open timing** to surface slow pages. (S)

### AL developer toolkit
- **AL object & metadata explorer** (deep metadata needs the dev/symbol endpoint). (M)
- **Run AL test codeunits** (Test Tool page 130401) and capture pass/fail. (M–L)
- **Telemetry / event-log reader.** (M)
- **AL test scaffolding generator.** (M)
- **Permission set inspection.** (M)
- **RapidStart configuration packages** (import/export setup data). (M–L)

### Migration & data hygiene
- **Environment diff** (config + master data, dev vs prod). (M–L)
- **Duplicate / blank detection** in master data. (M)
- **Anonymization** for test copies. (M)
- **Mass create from CSV.** (M)
- **Configuration documentation** (document a customer's setup pages, like manuals). (M)

### Integrations & delivery
- **Email / Teams a manual or screenshot.** (S–M)
- **Upload to SharePoint / OneDrive.** (M)
- **Push data to Google Sheets / Excel Online.** (M)
- **Webhooks for BC events.** (L)

### Safety & multi-environment
- **Multi-environment** (connect to several BC environments, switch between them). (M)
- **Audit log of writes** for traceability/compliance. (S–M)

---

## 4. Future audits

When auditing the MCP for new gaps, focus areas in rough priority: OAuth/SaaS reach, the
remaining ~10% of the web client not covered by the current tools, report request-page
parameterisation (L5), and the live/transient capture (P3). Capture findings as new entries
here, and graduate them to §2 when scheduled.
