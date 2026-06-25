# bc_screenshot
> Capture a real PNG of the Business Central web client for a page or record, with optional callouts, redaction, cropping, and hidden-field reveal — for manuals, docs, and bug reports.

## What it does
`bc_screenshot` renders the actual BC web UI in a headless system browser and writes a PNG to disk (and, by default, returns it inline in the MCP response). Unlike every other `bc_` tool — which speaks BC's WebSocket protocol and returns structured data — this tool drives the real web client via a deep-link URL, so the output is a pixel-accurate image of the page. It can draw callout boxes/badges/arrows on named controls, black out fields for privacy, crop to a field/section area, and reveal fields hidden behind collapsed FastTabs or "Show more" toggles. The capture path is fully out-of-band: a headless Chrome/Edge is launched on demand and torn down, and it authenticates in its own browser session, so it never touches the WebSocket session or the invoke queue the other tools use.

## When to use / when NOT to use
Use it to produce screenshots for user manuals (typically together with `bc_build_manual`), to attach a visual to a bug report, or to visually confirm what a page/record looks like in the web client. It is ideal for "click here" manual steps via `highlight`, and for capturing a single field/section via `crop`.

Do NOT use it to read or extract data — `bc_open_page`, `bc_read_data`, and `bc_navigate` already return all fields as structured JSON (including fields hidden behind collapsed FastTabs and "Show more", which are a purely visual web-client concern). Do NOT use it on a machine without Chrome/Edge installed (or `BC_SCREENSHOT_CHROME` set) or without `puppeteer-core` installed. It is slower than the protocol tools (it launches a browser and waits up to ~60s for the SPA to settle), so prefer the data tools when you only need values.

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageId` | string \| number | Yes | Numeric BC page ID to screenshot (e.g., 21 for Customer Card, 22 for Customer List). Use bc_search_pages to find IDs. |
| `bookmark` | string | No | Open a specific record before capturing. Bookmarks come from list row results in bc_open_page / bc_read_data. Omit for list/role-center pages. |
| `company` | string | No | Company to capture in. Defaults to the session's current company. Pin it explicitly for consistent manuals across runs. |
| `highlight` | string \| string[] \| `{target, label?, style?}`[] | No | Draw callout(s) on the page. A single caption -> one red box. A list of captions -> auto-numbered badges (1,2,3...) for ordered manual steps. A list of {target,label,style} objects -> full control. Ideal for "click here" manual steps. |
| `redact` | string[] | No | Captions to black out for privacy (each drawn as an opaque box). |
| `crop` | string \| string[] | No | Caption(s) to crop the screenshot to. The image is clipped to the bounding box enclosing the located caption(s) plus padding — use to capture just one section/FactBox/field area. |
| `expand` | boolean | No | Reveal hidden content before capturing: expand every collapsed FastTab/group and click every "Show more" toggle so additional fields appear. Default false. Even when false, a reveal pass runs automatically if a requested highlight/crop caption turns out to be hidden behind a collapsed group or "Show more" (reveal-when-needed). Set true to force the fully-expanded view for a whole-section screenshot. |
| `out` | string | No | Output file path. Absolute path is used as-is; a relative name is placed under BC_SCREENSHOT_DIR. Omit to auto-name as page-`<id>`-`<timestamp>`.png. |
| `width` | number | No | Viewport width in pixels (default 1600). |
| `height` | number | No | Viewport height in pixels (default 1000). |
| `scale` | number | No | Device scale factor for crispness (default 2 = retina-sharp). Use 1 for smaller files. |
| `fullPage` | boolean | No | Capture the full scrollable page instead of just the viewport (default false). Ignored when crop is set. |
| `inline` | boolean | No | Also return the PNG inline in the response so the assistant can see it (default true). Set false to only write the file. |

### `highlight` annotation object
When `highlight` is a list of objects, each object is an `Annotation`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | Yes | Caption / aria-label of the control to annotate (exact visible text). |
| `label` | string | No | Text or number shown on the callout (e.g. "1"). |
| `style` | `"box"` \| `"badge"` \| `"arrow"` \| `"blur"` | No | `box` (red border, default), `badge` (numbered circle + box), `arrow` (pointer + label), `blur` (redact). |

The flexible `highlight` shape is normalized before capture: a single string becomes `[{ target, style: 'box' }]`; a string array becomes auto-numbered badges `[{ target, label: '1', style: 'badge' }, ...]`; an object array is passed through as given. `redact` entries are folded in as `{ target, style: 'blur' }` annotations.

## Output
The operation returns a `ScreenshotOutput` object (serialized as the JSON text content block; the `__image` field is stripped out and surfaced as a separate MCP image content block):

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Absolute path of the PNG written to disk. |
| `url` | string | The deep-link URL that was opened (`<baseUrl>/?page=<id>&tenant=<t>[&company=<c>][&bookmark=<bm>]`). |
| `pageTitle` | string | The browser document title after the SPA loaded. |
| `authenticated` | boolean | `true` if the final page is not the sign-in page (auth succeeded). |
| `spaReady` | boolean | `true` if the SPA settled (spinner gone, non-generic title) before the wait deadline; `false` means capture proceeded after the timeout. |
| `annotations` | `{ target: string; found: boolean }[]` (optional) | One entry per requested `highlight` annotation (redact entries are not reported here), reporting whether each caption was located. Present only when `highlight` was given. |
| `cropped` | boolean | `true` if a crop clip rectangle was computed and applied. |
| `width` | number | Viewport width used (px). |
| `height` | number | Viewport height used (px). |
| `__image` | `{ data: string; mimeType: 'image/png' }` (optional) | Base64 PNG, present only when `inline` is not `false`. The MCP handler removes this field from the JSON text and emits it as an `image` content block. |

On failure the operation returns a `ProtocolError` with code `SCREENSHOT_ERROR` and the underlying message (e.g. sign-in failed, no browser found, `puppeteer-core` not installed).

## Examples

```jsonc
// 1. Whole Customer Card for one record, in a pinned company
{ "pageId": 21, "bookmark": "1B_Eg…", "company": "CRONUS_01" }
// -> { "path": "…/screenshots/page-21-2026-06-25T…png", "url": "https://devel1/BC/?page=21&tenant=default&company=CRONUS_01&bookmark=1B_Eg…",
//      "pageTitle": "Customer Card - …", "authenticated": true, "spaReady": true, "cropped": false, "width": 1600, "height": 1000 }
//    plus an inline image content block (PNG)
```

```jsonc
// 2. Numbered "click here" steps (auto badges 1,2,3…) for a manual
{ "pageId": 21, "highlight": ["Name", "Credit Limit (LCY)", "Blocked"] }
// -> { …, "annotations": [ { "target": "Name", "found": true },
//                          { "target": "Credit Limit (LCY)", "found": true },
//                          { "target": "Blocked", "found": true } ], … }
```

```jsonc
// 3. Crop to a single field that may live behind "Show more" in a collapsed FastTab —
//    the reveal-when-needed pass fires automatically because the target isn't visible at first.
//    Also redact a sensitive field and skip returning the image inline.
{ "pageId": 42, "bookmark": "1D_J…", "crop": "VAT Registration No.", "redact": ["Name"], "inline": false }
// -> { …, "cropped": true } (no __image; PNG only on disk)
```

## Notes & limitations
- **Engine = cookie injection (chosen after a 4-method live comparison).** bc-mcp authenticates against BC's forms `/SignIn` (ASP.NET Core, `POST /SignIn` -> `302`, NOT NTLM), exports the resulting cookie jar with its real attributes (`path=/BC; secure; samesite=none; httponly`; cookies `.AspNetCore.Antiforgery.*`, `SessionId`, `.AspNetCore.Cookies`), injects it into headless Chrome, then opens the deep-link. If injection ever lands on `/SignIn`, it falls back to filling the sign-in form once in-page (the bounced `ReturnUrl` is the deep link, so BC redirects right back). The zero-dependency `chrome --headless --screenshot` CLI path is NOT auth-viable because BC session cookies are in-memory and a copied on-disk profile loses them.
- **Deep link.** `…/?page=<id>&tenant=<t>&company=<c>&bookmark=<bm>` lands on the exact record; BC normalizes it to `?company=…&page=…&dc=0&bookmark=…`. The internal `bc_read_data` bookmark IS the URL `bookmark=`. `company=` is honored (no cross-session wrong-company surprise).
- **NEVER send `runinframe=1`.** It makes a top-level load hang forever on "Getting ready…" waiting for an iframe-parent handshake that never arrives. The tool deliberately never adds it.
- **Page content lives in an iframe.** Readiness is detected by the document `title` flipping to the page's own title (no spinner visible), and highlight/crop lookup searches every frame. Caption matching is by `aria-label` first, then exact element `textContent` — no dependency on BC exposing DOM ids. The iframe scrolls independently of the outer page, so before capture the primary target is `scrollIntoView`-ed; otherwise a below-fold (often just-revealed) control would miss the captured viewport. `fullPage` and a tall viewport do not reveal below-fold iframe content.
- **Revealing collapsed FastTabs / "Show more" (screenshot-only).** The web client hides fields two ways: collapsed FastTabs/groups, and per-tab "Show more" toggles for `Importance = Additional` fields. This affects ONLY screenshots — the data tools return every field regardless. Reveal runs (1) automatically (reveal-when-needed) when a requested `highlight`/`crop` caption isn't found on the first pass — expand all, then retry once — or (2) eagerly when `expand: true`. Verified selectors (BC27 `devel1`): a collapsible FastTab header is `span.ms-nav-columns-caption[aria-expanded]` (sub-groups `.ms-nav-group-caption[aria-expanded]`), expanded by clicking the ones currently `"false"` (looped up to 6 passes since expanding one can surface nested collapsibles). The "Show more" toggle is `button.show-more-fields-button`, which has NO state attribute and an invariant class (only the locale-bound caption flips), so its state is detected BY EFFECT — click it, and if the visible-node count drops it was already expanded, so click again to undo. This keeps reveal locale-independent.
- **Annotation drawing.** Callouts are absolutely-positioned `div`s appended to the document with a `data-bcmcp` marker (cleared between passes so a retry never double-draws). The in-browser annotate function intentionally contains no named nested functions, because under tsx/esbuild those get a `__name` wrapper that is undefined in the browser; only inline anonymous arrows in `.map` are used. `crop` clips to the union bounding box of the located crop captions plus 16px padding; `highlight`/`redact` boxes use a 6px pad.
- **Defaults.** Viewport 1600x1000, `deviceScaleFactor` 2, `fullPage` false, `inline` true. `crop` overrides `fullPage`. Output dir is `BC_SCREENSHOT_DIR` (default `./screenshots`; relative paths resolve against the server working dir — set an absolute path for predictable output). Auto-name pattern: `page-<id>-<ISO-timestamp>.png`.
- **Environment.** Requires Chrome/Edge installed, auto-detected across Windows/macOS/Linux, or `BC_SCREENSHOT_CHROME` pointing at the executable. `puppeteer-core` is a runtime dependency, lazy-imported so it never affects server startup. Reuses the standard `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` / `BC_TENANT_ID`; for self-signed on-prem TLS, `NODE_TLS_REJECT_UNAUTHORIZED=0` is honored (the launcher passes `acceptInsecureCerts` and `--ignore-certificate-errors`).
- **Failure signals.** `authenticated: false` -> wrong credentials or BC unreachable. `highlight.found: false` (i.e. an `annotations[].found` of `false`) -> the caption didn't match a control even after the automatic reveal pass; use the exact visible caption, otherwise the field is genuinely absent for that record. A screenshot stuck on "Getting ready…" means a cold BC session is still compiling — retry (the tool waits up to ~60s and never sends `runinframe`).

## Related tools
- [bc_build_manual](./bc_build_manual.md) — assembles step-by-step manuals (Markdown + PDF + DOCX) reusing this exact capture engine for each step's screenshot.
- [bc_open_page](./bc_open_page.md) — open a page and get its structured fields/sections plus row bookmarks (the source of the `bookmark` parameter).
- [bc_read_data](./bc_read_data.md) — read repeater rows and their bookmarks; returns all fields regardless of collapse/"Show more" state.
- [bc_navigate](./bc_navigate.md) — navigate the page tree; also returns all fields without needing the visual reveal.
- [bc_search_pages](./bc_search_pages.md) — find the numeric `pageId` for a given page name.
