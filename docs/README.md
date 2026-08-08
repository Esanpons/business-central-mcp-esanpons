# bc-ws documentation index

`bc-ws` is an MCP server that drives **Microsoft Dynamics 365 Business Central** by speaking
BC's internal WebSocket client protocol — the same protocol the web client uses. This is the
**catalog of everything the server can do**: every tool has its own reference page, plus
cross-cutting conventions, setup, and the roadmap.

> New here? Read the [conventions guide](guides/conventions.md) first — it explains the
> `pageContextId` lifecycle, the Section model, field targeting, write verification, and the
> payload-narrowing options that apply across all tools.

## Tools

### Pages & data (core)
| Tool | What it does | Doc |
|------|--------------|-----|
| `bc_open_page` | Open a page by numeric ID; returns its full state as `sections[]` + a `pageContextId`. The entry point for everything else. | [tools/bc_open_page.md](tools/bc_open_page.md) |
| `bc_read_data` | Refresh/return one section, with filtering, tab/group narrowing, column selection, and row pagination. | [tools/bc_read_data.md](tools/bc_read_data.md) |
| `bc_write_data` | Write field values (header / card / FactBox / line); reports per-field whether the value actually **changed**. | [tools/bc_write_data.md](tools/bc_write_data.md) |
| `bc_execute_action` | Invoke a named action or drill down on a Role Center cue tile. | [tools/bc_execute_action.md](tools/bc_execute_action.md) |
| `bc_navigate` | Select a row by bookmark, or drill down into the record's detail page. | [tools/bc_navigate.md](tools/bc_navigate.md) |
| `bc_respond_dialog` | Confirm / cancel / close a dialog raised by an action or write. | [tools/bc_respond_dialog.md](tools/bc_respond_dialog.md) |
| `bc_close_page` | Close a page and free its server-side resources. | [tools/bc_close_page.md](tools/bc_close_page.md) |

### Discovery
| Tool | What it does | Doc |
|------|--------------|-----|
| `bc_search_pages` | Tell Me keyword search; returns AL object names (profile-scoped). | [tools/bc_search_pages.md](tools/bc_search_pages.md) |
| `bc_find_object` | Resolve a page/report/table/codeunit by name/keyword to its numeric ID (cached index). | [tools/bc_find_object.md](tools/bc_find_object.md) |
| `bc_refresh_objects` | Rebuild the cached object index used by `bc_find_object`. | [tools/bc_refresh_objects.md](tools/bc_refresh_objects.md) |

### Session & companies
| Tool | What it does | Doc |
|------|--------------|-----|
| `bc_switch_company` | Switch the active company (invalidates open page contexts). | [tools/bc_switch_company.md](tools/bc_switch_company.md) |
| `bc_list_companies` | List available companies + the active one. | [tools/bc_list_companies.md](tools/bc_list_companies.md) |
| `bc_health` | Connection/session diagnostics + metrics; answers even when BC is down. | [tools/bc_health.md](tools/bc_health.md) |

### Reports
| Tool | What it does | Doc |
|------|--------------|-----|
| `bc_run_report` | Run a report over the WebSocket and fill its request-page parameters. | [tools/bc_run_report.md](tools/bc_run_report.md) |
| `bc_download_report` | Render a report and **download** its output (PDF/Excel/Word) via the headless browser. | [tools/bc_download_report.md](tools/bc_download_report.md) |

### Wizards
| Tool | What it does | Doc |
|------|--------------|-----|
| `bc_wizard_navigate` | Drive a NavigatePage/wizard by step (back/next/finish/cancel). | [tools/bc_wizard_navigate.md](tools/bc_wizard_navigate.md) |

### Visual & documentation (out-of-band, headless browser)
> Producing docs, screenshots or a manual? Read the **[documentation guide](guides/documenting.md)**
> first — it is the decision table for which tool and which output format to use.

| Tool | What it does | Doc |
|------|--------------|-----|
| `bc_screenshot` | Capture a real PNG of the BC web client, with highlight/redact/crop and FastTab reveal. | [tools/bc_screenshot.md](tools/bc_screenshot.md) |
| `bc_build_manual` | Assemble annotated screenshots + prose into a Markdown and/or printable A4 (Ctrl+P) user manual. | [tools/bc_build_manual.md](tools/bc_build_manual.md) |

## Guides & reference
- **[Documenting BC](guides/documenting.md)** — which tool and which output format for screenshots,
  manuals and printable A4 docs; the standard recipe, the Markdown subset allowed in prose, and
  what to do when a capture or a highlight fails.
- **[Conventions](guides/conventions.md)** — `pageContextId` lifecycle, the Section model, field
  targeting (`controlPath`/`group`), write verification (`changed`/`reason`), the `editable`
  tri-state, payload control (`summary`/`sections`/`columns`/`range`/`quiet`), and error codes.
- **[Setup (global / per-project install)](SETUP-GLOBAL.md)** — register the server with Claude
  Code / Desktop / VSCode.
- **[Pending work](ROADMAP.md)** — the SINGLE source of truth for everything not yet done:
  limitations, open bugs, doc drift, test debt and the idea backlog. Every item is re-verified
  against the code; nothing pending is tracked anywhere else.
- **[CHANGELOG](../CHANGELOG.md)** — released and unreleased changes.
- **Protocol & dev reference** — [`CLAUDE.md`](../CLAUDE.md) (BC wire-protocol patterns,
  development rules, decompiled-source verification procedure).
- **[SaaS evidence (frozen)](SAAS-EVIDENCE.md)** — how SaaS's per-tab backend WebSocket was
  discovered, plus the 18-tool Docker-vs-SaaS parity matrix. Results only — pending work goes in
  the roadmap.

## Configuration

All tools share the same env-var configuration (`BC_BASE_URL`, `BC_USERNAME`, `BC_PASSWORD`,
`BC_TENANT_ID`, `BC_PROFILE`, `BC_APPLICATION_ID`, the screenshot/manual/report output dirs,
etc.). The full table lives in the repo [`README.md`](../README.md#configuration).
