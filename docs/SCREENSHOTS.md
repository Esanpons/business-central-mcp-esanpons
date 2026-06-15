# `bc_screenshot` — real screenshots of the BC web client

`bc_screenshot` is the 13th tool of this MCP server. It captures a **real PNG of the
Business Central web client** for a given page/record, with an optional **highlight
callout box** around a named field or action. It is built for producing **user manuals
and documentation**, bug reports, or visually confirming what a page looks like.

Unlike every other `bc_` tool (which speaks BC's WebSocket protocol and returns
structured data), `bc_screenshot` renders the actual BC UI in a headless browser.

## Key property: additive and non-blocking

The screenshot path is **out-of-band**. It does NOT touch the WebSocket session or the
invoke queue that the other tools use, so normal bc-mcp operations keep their full speed:

- A headless **system Chrome/Edge** (via `puppeteer-core`, no bundled browser download) is
  launched **on demand** only when a screenshot is requested, then torn down.
- It authenticates **by itself** (reusing the configured BC credentials) in its own browser
  session — it does not depend on, or disturb, the protocol session.
- If you never call `bc_screenshot`, there is zero cost.

## Parameters

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `pageId` | Yes | — | Numeric BC page ID (e.g. 21 Customer Card, 22 Customer List). Use `bc_search_pages` to find IDs. |
| `bookmark` | No | — | Open a specific record's Card. Bookmarks come from list rows in `bc_open_page` / `bc_read_data`. Omit for list / Role Center pages. |
| `company` | No | session's current company | Pin a company explicitly for consistent manuals across runs. |
| `highlight` | No | — | Draw a **red callout box** around the field/action whose caption matches this text (e.g. `"Name"`, `"Credit Limit (LCY)"`, `"Post"`). |
| `out` | No | `page-<id>-<timestamp>.png` | Output file. Absolute path is used as-is; a relative name goes under `BC_SCREENSHOT_DIR`. |
| `width` | No | `1600` | Viewport width (px). |
| `height` | No | `1000` | Viewport height (px). |
| `scale` | No | `2` | Device scale factor. `2` = retina-sharp for crisp manual images; `1` = smaller files. |
| `fullPage` | No | `false` | Capture the full scrollable page instead of just the viewport. |
| `inline` | No | `true` | Also return the PNG inline in the response so the assistant can see it. `false` = only write the file. |

## Output

- The PNG is **written to disk**: to `out` if given, otherwise auto-named under
  `BC_SCREENSHOT_DIR`.
- Unless `inline: false`, the PNG is **also returned inline** in the MCP response (as an
  image content block) so the assistant can view it immediately.
- The response also reports `path`, `url`, `pageTitle`, `authenticated`, `spaReady`, and
  `highlight: { requested, found }`.

## Examples

```jsonc
// Whole Customer Card for one record
{ "pageId": 21, "bookmark": "1B_Eg…", "company": "CRONUS_01" }

// With a callout on a field (ideal for a "fill this in" manual step)
{ "pageId": 21, "bookmark": "1B_Eg…", "highlight": "Credit Limit (LCY)" }

// A list page
{ "pageId": 22 }

// Save to a specific file, do not return the image inline
{ "pageId": 21, "out": "C:/manuals/customer-card.png", "inline": false }
```

Typical manual flow: `bc_open_page` a list → take a row's `bookmark` → `bc_screenshot`
the Card page id with that bookmark and a `highlight`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BC_SCREENSHOT_DIR` | `./screenshots` | Folder for PNGs (relative paths resolve against the server's working dir). **Set an absolute path** for predictable output. |
| `BC_SCREENSHOT_CHROME` | auto-detect | Path to a Chrome/Edge executable. Auto-detected on Windows/macOS/Linux if omitted. |

Reuses the standard `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` / `BC_TENANT_ID` and, for
self-signed on-prem TLS, `NODE_TLS_REJECT_UNAUTHORIZED=0` (same as the rest of bc-mcp).

## Requirements

- **Chrome or Edge** installed on the machine running the MCP server (or `BC_SCREENSHOT_CHROME`
  pointing at a browser). No browser is downloaded — `puppeteer-core` drives the system one.
- `puppeteer-core` (a runtime dependency; installed with the package).

## How the engine was chosen (the analysis)

Four capture strategies were prototyped and **tested live against the BC27 `devel1`
container**. The throwaway comparison harness is `scripts/screenshot-poc.ts`
(`npm run screenshot:poc`).

| # | Method | Result | Notes |
|---|--------|--------|-------|
| **1** | **Cookie injection** (bc-mcp authenticates, injects the cookie jar into headless Chrome, opens the deep-link) | ✅ Works, fully unattended | **Chosen engine.** No login UI, no profile to manage. |
| 2 | One-time real `/SignIn` login into a persistent browser profile | ✅ Works | Robust auth, but needs a profile + a one-time login. Kept as the in-page fallback. |
| 3 | Method 1/2 + **highlight callout** | ✅ Works | This is `bc_screenshot` with `highlight`. |
| 4 | Zero-dependency system Chrome `--headless=new --screenshot` CLI | ⚠️ Not viable for auth | BC's session cookies are **in-memory**, so copying an on-disk profile does NOT carry the login → it lands on the sign-in page. |

`bc_screenshot` ships **Method 1** with an automatic **in-page login fallback** (Method 2):
if cookie injection ever lands on `/SignIn`, it fills the form once and continues.

## Key empirical findings (BC27 / on-prem)

These were verified live and drive the implementation:

- **Deep-link works in the browser.** `…/?page=<id>&tenant=<t>&company=<c>&bookmark=<bm>`
  lands on the exact record. BC normalizes it to `?company=…&page=…&dc=0&bookmark=…`.
- **`company=` is honored** — the screenshot shows the same company you targeted (no
  cross-session "wrong company" surprise).
- **The internal bookmark IS the URL bookmark** — the token from `bc_read_data` rows drops
  straight into `bookmark=`.
- **NEVER send `runinframe=1`.** It makes a top-level load hang forever on "Getting ready…"
  waiting for an iframe-parent handshake that never arrives.
- **BC auth is forms/cookie (ASP.NET Core), not NTLM.** `POST /SignIn` → `302`. The real
  cookies are `.AspNetCore.Antiforgery.*`, `SessionId`, `.AspNetCore.Cookies`, all scoped
  `path=/BC; secure; samesite=none; httponly` — reproduced faithfully on injection.
- **Page content lives in an iframe**, so the "rendered" signal is the document **title**
  flipping to the page's own title, and highlight lookup searches **all frames**.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Response shows `authenticated: false` | Wrong `BC_USERNAME` / `BC_PASSWORD`, or BC not reachable. The probe `node scripts/auth-probe.mjs` (with env set) prints the live sign-in result. |
| `No Chrome/Edge found` | Install Chrome/Edge or set `BC_SCREENSHOT_CHROME`. |
| Screenshot shows "Getting ready…" | A cold BC session is still compiling; retry. (The tool already waits up to ~60s and never sends `runinframe`.) |
| `highlight.found: false` | The caption text didn't match a visible control. Use the exact caption as shown on the page (e.g. `"Credit Limit (LCY)"`), or omit `highlight`. |
| `puppeteer-core is not installed` | `npm install puppeteer-core`. |

## Source

- `src/services/screenshot-service.ts` — capture engine (auth, deep-link, wait, highlight)
- `src/operations/screenshot.ts` — MCP operation
- `src/mcp/schemas.ts` (`ScreenshotSchema`), `src/mcp/tool-registry.ts` (`bc_screenshot`)
- `src/mcp/handler.ts` — inline image content block
- `scripts/screenshot-poc.ts` — the 4-method comparison harness (`npm run screenshot:poc`)
