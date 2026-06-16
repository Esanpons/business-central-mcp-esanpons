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
