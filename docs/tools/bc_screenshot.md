# bc_screenshot
> Capture a real PNG of the Business Central web client for a page or record, with optional callouts, redaction, cropping, and hidden-field reveal — for manuals, docs, and bug reports.

## What it does
`bc_screenshot` renders the actual BC web UI in a headless system browser and writes a PNG to disk (and, by default, returns it inline in the MCP response). Unlike every other `bc_` tool — which speaks BC's WebSocket protocol and returns structured data — this tool drives the real web client via a deep-link URL, so the output is a pixel-accurate image of the page. It can draw callout boxes/badges/arrows on named controls, black out fields for privacy, crop to a field/section area, and reveal fields hidden behind collapsed FastTabs or "Show more" toggles. The capture path is fully out-of-band: a headless Chrome/Edge is launched on demand and torn down, and it authenticates in its own browser session, so it never touches the WebSocket session or the invoke queue the other tools use.

## When to use / when NOT to use
Use it to produce screenshots for user manuals (typically together with `bc_build_manual`), to attach a visual to a bug report, or to visually confirm what a page/record looks like in the web client. It is ideal for "click here" manual steps via `highlight`, and for capturing a single field/section via `crop`.

Use it for **one** image. The moment you need several images with prose around them -- a process, a how-to, training material -- call `bc_build_manual` instead: it drives this same capture engine per step and assembles the whole document (with an A4 printable layout if you ask for `formats: ["html"]`). Do NOT capture N screenshots here and stitch them together by hand.

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
| `clickBeforeCapture` | string[] | No | Captions of controls to CLICK before capturing, in order (e.g. `["Lines"]` to open a document line grid, or a tab name). The deterministic companion to `expand`: use it when a section only reveals its content on an explicit toggle. Matched by visible text or aria-label, exact then prefix, across every frame. **In a list the action applies to the row BC has selected, and this cannot choose one** -- pass `bookmark` to position the list first, or the click may land on a button BC has greyed out. Every click reports its outcome in `clicks`. |
| `dismissTeachingTips` | boolean | No | Close BC's "About this page" callouts before capturing (**default true**). Pages with `AboutTitle`/`AboutText` pop that blue bubble on first visit, and a capture browser is ALWAYS a first visit, so it otherwise covered the bottom-left corner of every image. Set `false` only when documenting the callout itself. |
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
| `authenticated` | boolean | `true` when the captured page is past **every** sign-in wall -- BC's own `/SignIn` **and** Microsoft Entra's form. A capture that ends on either one does not return at all (see below), so in practice this is always `true` on a returned result. |
| `spaReady` | boolean | `true` if the SPA settled (spinner gone, non-generic title) before the wait deadline; `false` means capture proceeded after the timeout. |
| `annotations` | `{ target: string; found: boolean }[]` (optional) | One entry per requested `highlight` annotation, reporting whether each caption was located. Present only when `highlight` was given. |
| `redactions` | `{ target: string; found: boolean }[]` (optional) | One entry per requested `redact` caption. **Always check this.** `found: false` means the caption was never located, so the PNG on disk STILL SHOWS that value — a silent redaction miss is the worst failure mode this tool has, which is why it is reported separately from `annotations`. |
| `clicks` | `{ target: string; clicked: boolean; reason?: "not found" \| "disabled" }[]` (optional) | One entry per `clickBeforeCapture` caption, in order. **Check it.** `clicked: false` means the image shows the page WITHOUT that step: `disabled` = BC greyed the action out (in a list, usually the wrong row is selected -- position it with `bookmark`), `not found` = the caption does not match what the page renders (captions are locale-dependent). |
| `unexpectedDialog` | string (optional) | Text of a modal that appeared **without being asked for** (i.e. the call carried no `clickBeforeCapture`), so the PNG shows that dialog instead of the page. Usually BC explaining why it refused the deep link -- a bookmark from another table is the classic case. |
| `warning` | string (optional) | Loud, human-readable alert when something is wrong with the capture: failed redactions first, then a click that did nothing, an unexpected dialog, an absurdly small crop, or a page that does not look like the BC web client. Also logged at error level. |
| `cropped` | boolean | `true` if a crop clip rectangle was computed and applied. |
| `width` | number | Viewport width used (px). |
| `height` | number | Viewport height used (px). |
| `__image` | `{ data: string; mimeType: 'image/png' }` (optional) | Base64 PNG, present only when `inline` is not `false`. The MCP handler removes this field from the JSON text and emits it as an `image` content block. |

On failure the operation returns a `ProtocolError` with code `SCREENSHOT_ERROR` and the underlying message (e.g. sign-in failed, no browser found, `puppeteer-core` not installed).

**A failed capture writes NOTHING.** The PNG is taken into memory and only written to `out` once the capture has been judged good, so a failure leaves whatever was already at that path untouched. This matters more than it sounds: the tool used to write straight to the destination, so an expired browser session replaced a good figure of a manual with a picture of Microsoft's login form -- and reported success. The cases that now fail loudly instead of shipping a file:

- The page ended on a **sign-in wall** (BC's or Microsoft Entra's). The message says which, and what to do (`npm run login:aad` for Entra).
- BC answered with its **error screen** (unknown company, page id, or a bookmark it refuses). The message carries BC's own words.

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
- **Revealing collapsed FastTabs / "Show more" (screenshot-only).** The web client hides fields two ways: collapsed FastTabs/groups, and per-tab "Show more" toggles for `Importance = Additional` fields. This affects ONLY screenshots — the data tools return every field regardless. Reveal runs (1) automatically (reveal-when-needed) when a requested `highlight`/`crop` caption isn't found on the first pass — expand all, then retry once — or (2) eagerly when `expand: true`. Reveal expands EVERY collapsed section header, not just FastTabs: any visible element with `aria-expanded="false"` whose class looks like a caption/header/part/group/section, excluding menus, dropdowns, listboxes and anything inside a dialog (so it can never open an unrelated popup). That generalisation is what finally reveals a **document's Lines grid** — previously only `.ms-nav-columns-caption` / `.ms-nav-group-caption` matched, so line captions (Quantity, Line Amount) were never found and every highlight/crop naming one came back `found:false`. It is looped up to 6 passes since expanding one header can surface nested collapsibles. When you would rather name the toggle than rely on the sweep, pass `clickBeforeCapture: ["Lines"]`. The "Show more" toggle is `button.show-more-fields-button`, which has NO state attribute and an invariant class (only the locale-bound caption flips), so its state is detected BY EFFECT — click it, and if the visible-node count drops it was already expanded, so click again to undo. This keeps reveal locale-independent.
- **Annotation drawing.** Callouts are absolutely-positioned `div`s appended to the document with a `data-bcmcp` marker (cleared between passes so a retry never double-draws). The in-browser annotate function intentionally contains no named nested functions, because under tsx/esbuild those get a `__name` wrapper that is undefined in the browser; only inline anonymous arrows in `.map` are used. `crop` clips to the union bounding box of the located crop captions plus 16px padding; `highlight`/`redact` boxes use a 6px pad.
- **Defaults.** Viewport 1600x1000, `deviceScaleFactor` 2, `fullPage` false, `inline` true. `crop` overrides `fullPage`. Output dir is `BC_SCREENSHOT_DIR` (default `./screenshots`; relative paths resolve against the server working dir — set an absolute path for predictable output). Auto-name pattern: `page-<id>-<ISO-timestamp>.png`.
- **Environment.** Requires Chrome/Edge installed, auto-detected across Windows/macOS/Linux, or `BC_SCREENSHOT_CHROME` pointing at the executable. `puppeteer-core` is a runtime dependency, lazy-imported so it never affects server startup. Reuses the standard `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` / `BC_TENANT_ID`; for self-signed on-prem TLS, `NODE_TLS_REJECT_UNAUTHORIZED=0` is honored (the launcher passes `acceptInsecureCerts` and `--ignore-certificate-errors`).
- **Two sessions expire independently, and only one of them is the WebSocket.** The capture browser has its own session, so it can be dead while every other `bc_` tool works and `bc_health` reports "connected" -- that is not a contradiction, it is two different logins. On SaaS the injected cookie jar simply ages out after about an hour and the deep link bounces to `login.microsoftonline.com`. The tool now recognises that wall (it used to match only BC's on-prem `/SignIn`, which is how a photo of Microsoft's login form came back with `authenticated: true`) and renews the jar by itself, from a SEPARATE browser tab so the tab the WebSocket is attached to is never disturbed. Only when renewal needs a human -- MFA, an expired password -- does the capture fail, telling you to run `npm run login:aad`.
- **`crop` measures inside the iframe, and the clip applies outside it.** BC renders page content in an iframe: `getBoundingClientRect` there is frame-relative, while the screenshot clips in top-level coordinates, and the two differ by the whole BC chrome above the iframe. The frame's offset is now added to every crop rect. Before that, a crop landed a strip too high and returned a 3 KB image of a caption with the data missing -- while `highlight` looked fine, because its callouts are drawn INSIDE the frame in the same coordinates it measured. A crop target also climbs from the caption to the nearest field-sized ancestor that actually contains a value control (`div.ms-nav-edit-control-container` on BC27), so the crop encloses the field ROW (label + value). A caption with no value beside it -- a list column header, a group title -- has no such ancestor: the crop falls back to the label's own box and a `warning` says the crop came out tiny.
- **Teaching tips are closed structurally, never by caption.** The close cross of BC's "About this page" bubble has no accessible text, which is why `clickBeforeCapture: ["Cerrar"]` could never reach it. The pass looks for a close control INSIDE a teaching/callout container, so it cannot close anything else on the page.
- **Failure signals.** `authenticated: false` -> wrong credentials or BC unreachable. `highlight.found: false` (i.e. an `annotations[].found` of `false`) -> the caption didn't match a control even after the automatic reveal pass; use the exact visible caption, otherwise the field is genuinely absent for that record. A screenshot stuck on "Getting ready…" means a cold BC session is still compiling — retry (the tool waits up to ~60s and never sends `runinframe`). `clicks[].clicked: false` -> the step in the image never happened. `unexpectedDialog` -> the image is of a dialog, not of the page.

## Related tools
- [bc_build_manual](./bc_build_manual.md) — assembles step-by-step manuals (Markdown and/or printable A4 HTML) reusing this exact capture engine for each step's screenshot. Reach for it as soon as you need **more than one** image with prose around it — see the [documentation guide](../guides/documenting.md).
- [bc_open_page](./bc_open_page.md) — open a page and get its structured fields/sections plus row bookmarks (the source of the `bookmark` parameter).
- [bc_read_data](./bc_read_data.md) — read repeater rows and their bookmarks; returns all fields regardless of collapse/"Show more" state.
- [bc_navigate](./bc_navigate.md) — navigate the page tree; also returns all fields without needing the visual reveal.
- [bc_search_pages](./bc_search_pages.md) — find the numeric `pageId` for a given page name.
