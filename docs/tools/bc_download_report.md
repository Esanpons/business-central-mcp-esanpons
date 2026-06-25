# bc_download_report

> Render a BC report and capture its rendered output file (PDF/Excel/Word) to disk, returning the saved path.

## What it does
Renders a Business Central report by its numeric report ID and downloads the rendered binary (PDF / Excel / Word) to a file on disk, returning the saved path. It is the output-capture companion to `bc_run_report`: like `bc_screenshot` it runs entirely out-of-band in an authenticated headless browser (system Chrome/Edge driven via CDP) and does NOT touch the WebSocket session or invoke queue that the other `bc_` tools use. The browser authenticates itself by reusing the configured BC credentials (forms `/SignIn` cookie injection — see `authCookies` / `deepLinkReport` in `src/services/bc-web-auth.ts`), opens the report's deep link, waits for the SPA to settle, and intercepts the resulting browser download into a private temp dir via `Page.setDownloadBehavior`. Reports with no required parameters download immediately; reports that need parameters return `downloaded: false` with `requestPageShown: true`.

## When to use / when NOT to use
- USE it when you need the rendered report **file** (PDF/Excel/Word) saved to disk — statements, trial balances, customer statements (e.g. report 6 Trial Balance, 1306 Customer Statement).
- USE it as the binary-capture step after exploring/filling a request page with `bc_run_report`.
- Do NOT use it for server-side **processing** reports (batch posting, inventory adjustment, data processing such as report 295) — those have no downloadable output; use `bc_run_report`.
- Do NOT use it to read or extract data — use `bc_open_page` / `bc_read_data`.
- Do NOT use it for reports that require parameters expecting an immediate file: it cannot fill request-page parameters over the browser path (it only best-effort clicks a default output trigger). Fill parameters with `bc_run_report` first.
- Requires Chrome or Edge installed on the host running the server (or `BC_SCREENSHOT_CHROME` set to a browser path).

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `reportId` | string \| number | Yes | Numeric BC report ID to render and download (e.g., 6 Trial Balance, 1306 Customer Statement). |
| `company` | string | No | Company to run in. Defaults to the session company. |
| `out` | string | No | Output file path. Absolute is used as-is; a relative name goes under `BC_REPORT_DIR`. Omit to auto-name `report-<id>-<timestamp>.<ext>`. |
| `timeoutMs` | number | No | How long to wait for the download to complete after the report runs (ms, default 60000). |

`reportId` is accepted as a string or a number; internally it is coerced to a trimmed string before building the deep link.

## Output
The operation returns the `DownloadReportResult` shape (`src/services/report-download-service.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `reportId` | string | The (trimmed, stringified) report ID that was run. |
| `url` | string | The resolved report deep-link URL (`<baseUrl>/?report=<id>&tenant=<t>[&company=<c>]`). |
| `authenticated` | boolean | True when the final page is NOT the BC sign-in page (i.e. auth succeeded). |
| `downloaded` | boolean | True when a file was captured and saved. Always check this first. |
| `path` | string (optional) | Absolute path of the saved file. Present only when `downloaded` is true. |
| `fileName` | string (optional) | Original download filename as Chrome named it. Present only when `downloaded` is true. |
| `requestPageShown` | boolean | True when BC showed a request page (parameters needed) instead of downloading. Set when no file was captured AND no output trigger was clicked. |
| `pageTitle` | string | The document title of the loaded page after the SPA settled. |

On failure the operation returns an error with code `REPORT_DOWNLOAD_ERROR`. Note: a `downloaded: false` / `requestPageShown: true` result is NOT treated as an error — it is returned as a successful result describing that BC needs parameters, so the caller can fall back to `bc_run_report`.

## Examples

Download a parameter-less report (auto-named under `BC_REPORT_DIR`):
```json
{ "reportId": 6 }
```
Expected response:
```json
{
  "reportId": "6",
  "url": "https://devel1/BC/?report=6&tenant=default",
  "authenticated": true,
  "downloaded": true,
  "path": "D:/Proyectos/Aesva/business-central-mcp-esanpons/reports/report-6-2026-06-25T10-15-03-123Z.pdf",
  "fileName": "Trial Balance.pdf",
  "requestPageShown": false,
  "pageTitle": "Trial Balance"
}
```

Download to a specific file in a specific company with a longer wait:
```json
{ "reportId": 1306, "company": "CRONUS ES", "out": "C:/exports/customer-statement.pdf", "timeoutMs": 120000 }
```
Expected response (success): `downloaded: true` with `path: "C:/exports/customer-statement.pdf"` and the Chrome-supplied `fileName`.

A report that requires parameters (no file produced):
```json
{ "reportId": 120 }
```
Expected response:
```json
{
  "reportId": "120",
  "url": "https://devel1/BC/?report=120&tenant=default",
  "authenticated": true,
  "downloaded": false,
  "requestPageShown": true,
  "pageTitle": "Aged Accounts Receivable"
}
```
In this case, fill the request page parameters via `bc_run_report` and re-run.

## Notes & limitations
- **Out-of-band by design.** A headless Chrome/Edge is launched on demand (`launchHeadless`) and torn down in a `finally` block; it never touches the WebSocket session, so normal tools keep full speed. Auth reuses the same cookie-injection engine as `bc_screenshot`, with an automatic in-page `/SignIn` fallback if cookie injection lands on the login page.
- **Output path resolution.** Downloads are first captured into a private temp dir (`mkdtemp` under the OS temp dir) so the new file is unambiguous, then copied to the destination. `out` absolute → used as-is; `out` relative → resolved under `BC_REPORT_DIR`; omitted → `report-<id>-<ISO-timestamp>.<ext>` (extension taken from the captured file, defaulting to `.pdf`). The destination directory is created if missing. `BC_REPORT_DIR` defaults to `.arxius/reports` (relative to cwd).
- **Completion polling.** After navigation it polls the temp dir every 500ms until `timeoutMs` (default 60000) for a completed file, ignoring in-flight Chrome `*.crdownload` files, and picks the newest by mtime.
- **Request-page handling (verified live on `devel1`, report 6 Trial Balance).** Reports that show a request page ARE downloaded end-to-end: the tool clicks the toolbar's "Enviar a…" / "Send to…" (located by visible text — the buttons carry empty aria-labels / GUID titles), waits for the format dialog, then clicks "Aceptar" / "OK", and captures the resulting download (e.g. `Trial Balance.pdf`). Parameter-free reports download directly.
- **When `downloaded: false`.** If a report needs a specific parameter or a non-default output-format selection that the default "Send to → Aceptar" flow doesn't satisfy, the result is `downloaded: false` + `requestPageShown: true` + a `note`. Inspect/fill the request page with `bc_run_report`, or capture it with `scripts/capture-report-requestpage.ts <id>` so the flow can be extended (explicit format selection is a possible follow-up — see [../ROADMAP.md](../ROADMAP.md)).
- **Output location.** The file is written to `BC_REPORT_DIR` (default `.arxius/reports`, resolved against the **MCP server's working directory** — set `BC_REPORT_DIR` to an absolute path to control exactly where), or to `out` when given.
- **Deep link.** The URL convention matches the WebSocket `runReport` (`report=<id>&tenant=<t>`) plus optional `company`. `runinframe=1` is deliberately never added (it hangs a top-level load on "Getting ready...").
- **Browser requirement.** Chrome or Edge must be installed (or `BC_SCREENSHOT_CHROME` set). `puppeteer-core` is used with no bundled browser download.
- **Self-signed TLS.** Against environments like `devel1`, set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Related tools
- [bc_run_report](./bc_run_report.md) — execute a report and fill its request page over the WebSocket (no binary capture).
- [bc_screenshot](./bc_screenshot.md) — sibling out-of-band browser tool; captures a page/record PNG.
- [bc_open_page](./bc_open_page.md) — open a page over the WebSocket to read data.
- [bc_read_data](./bc_read_data.md) — read rows/fields from an open page.
