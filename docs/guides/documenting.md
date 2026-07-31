# Documenting Business Central — which tool, which format

The one page to read before producing **any** documentation, screenshot or manual with `bc-ws`.
It answers "I need X, what do I call?" first, then the details.

## Start here

| I need… | Call | Notes |
|---|---|---|
| **One** image of a page or record | `bc_screenshot` | Highlight / crop / redact in the same call. |
| A process explained step by step, for someone to **read or print** | `bc_build_manual` with `formats: ["html"]` | Real A4 sheets, cover + index, Ctrl+P prints it. |
| …the same, to live in a **repo or wiki** | `bc_build_manual` with `formats: ["md"]` (the default) | Markdown + relatively linked PNGs. |
| …both at once | `bc_build_manual` with `formats: ["md", "html"]` | One capture pass, two files. |
| A **PDF** of a manual | `formats: ["html"]`, then open it and press **Ctrl+P** | There is no PDF output and no PDF tool. The HTML *is* the print path. |
| A **Word/DOCX** manual | Not supported | Removed on purpose — it could never match the A4 layout. |
| The **data** behind a page (values, rows, fields) | `bc_open_page` / `bc_read_data` | Never screenshot a page to read it. |
| A **report's** rendered output (PDF/Excel/Word) | `bc_download_report` | Unrelated to manuals: that is BC rendering its own report. |
| To find the page id you need | `bc_find_object` (cached index) or `bc_search_pages` (Tell Me) | |

Anything visual here runs **out-of-band** in its own headless browser: it never touches the
WebSocket session, so the data tools keep their full speed.

## The standard recipe

Almost every manual is this shape. Copy it.

1. **Resolve the page id** — `bc_find_object { "query": "customer", "type": "Page" }` → e.g. list 22, card 21.
2. **Get a record bookmark** — `bc_open_page { "pageId": 22 }`, take a row's `bookmark` from the result.
3. **Build the whole document in ONE call** — `bc_build_manual`, one entry in `steps` per screen,
   the card steps carrying `{ "pageId": 21, "bookmark": "…" }`.
4. **Report the paths** back to the user; for HTML, tell them to open it and press Ctrl+P.

Do **not** call `bc_screenshot` once per step and assemble the document yourself — `bc_build_manual`
drives the same engine per step and handles naming, numbering, layout and pagination.

## Choosing the output format

`formats` defaults to `["md"]`, so **HTML must be asked for explicitly**.

- **Pick `html`** whenever a human is going to read the result: end users, training, onboarding,
  handovers, anything that may be printed or emailed. It produces 210×297mm sheets with a cover,
  an index with real page numbers, running headers and `N / total` footers — the screen preview is
  literally the printed page.
- **Pick `md`** when the target is a repository, a wiki, or further editing by an agent or a human.
- **Pick both** when it has to be readable *and* versioned.

If the user says "fes-me un manual" without qualifying, default to `["html"]` and say so.

### HTML-only options

| Option | Default | Pick the other value when… |
|---|---|---|
| `assets` | `inline` | …the CSS must be tweaked by hand afterwards → `files` (writes `.html` + `.css` + `.js` + linked PNGs). `inline` is one self-contained file you can email as-is; it is ~4/3 the size of the captures. |
| `lang` | `ca` | …the manual is written in Spanish (`es`) or English (`en`). This only switches the generated chrome (cover kicker, index title, print button) — your headings and prose are whatever you write. Match it to the language of the text. |
| `cover` | `true` | …the manual is a fragment meant to be pasted into a bigger document → `false`. |
| `toc` | auto (from 4 steps) | …you want to force or suppress the index regardless of length. |

## Writing the prose

`intro` and every step `body` accept a small Markdown subset, rendered the same in both outputs
(everything is escaped first, so prose can never inject markup):

| Syntax | Result |
|---|---|
| blank line | new paragraph (single newlines are soft wraps) |
| `- item` / `* item` | bullet list |
| `1. item` | numbered list |
| `> text` | highlighted note box — use it for warnings and prerequisites, it stands out on paper |
| `**text**` | bold |
| `*text*` / `_text_` | italic |
| `` `text` `` | inline code |
| `[label](https://…)` | link (http/https only) |

Write headings and prose in the **user's** language. The BC UI inside the screenshots comes out in
the BC user's own language automatically — you do not control that from here.

## Screenshots inside steps

Each step's `screenshot` is the same shape as `bc_screenshot`. What to reach for:

- `highlight: "Credit Limit (LCY)"` — one red box. For "look at this field".
- `highlight: ["Name", "Credit Limit (LCY)", "Blocked"]` — auto-numbered badges 1, 2, 3. For
  "fill in these fields, in this order". This is the workhorse for manuals.
- `highlight: [{ "target": "Post", "label": "Prem aquí", "style": "arrow" }]` — full control
  (`box` / `badge` / `arrow` / `blur`).
- `crop: "Credit Limit (LCY)"` — clip the image to that area. For a close-up when the full page
  would be unreadable at A4 width.
- `redact: ["Name"]` — black out sensitive values before the manual leaves the building.
- `expand: true` — force every FastTab open and every "Show more" clicked, for a complete-section
  capture.

**You do not need `expand` just to highlight a hidden field.** If a caption lives in a collapsed
FastTab or behind "Show more", the tool reveals it automatically and scrolls it into view
(reveal-when-needed). This affects screenshots only — `bc_open_page` / `bc_read_data` already
return every field regardless of collapse state.

## Things you do not have to worry about

- **Page breaks.** A step heading is never separated from its screenshot; a group that does not fit
  moves whole to the next sheet. Captures are capped at 180mm so any screenshot fits one page.
- **Index page numbers.** They are resolved after pagination, from where each step actually landed.
- **Image sizing.** PNG dimensions are read from the file and emitted as the intrinsic size.
- **The reader's window.** Pagination always happens at true A4; a narrow window only scales the
  preview. What prints never depends on the screen.
- **JavaScript.** Without it the page still renders as a plain readable, printable flow.

## Where the files land

Under `BC_MANUAL_DIR` (default `./manuals`), or `outDir` if given (absolute, else relative to
`BC_MANUAL_DIR`). Files are `<slug>.{md,html,css,js}` from `name` or `title`; per-step captures go
to a sibling `<slug>-img/` as `step-<n>.png`. Standalone `bc_screenshot` PNGs go to
`BC_SCREENSHOT_DIR` (default `./screenshots`) unless `out` says otherwise.

Always report the returned absolute paths back to the user — they are the deliverable.

## When something looks wrong

| Symptom | Cause / fix |
|---|---|
| `annotations[].found: false` | The caption did not match a control **even after** the automatic reveal pass. Use the exact visible caption; otherwise the field is genuinely absent for that record. Retry just that step. |
| Screenshot stuck on "Getting ready…" | A cold BC session is still compiling. Retry; the tool waits ~60s. |
| `MANUAL_ERROR` mentioning Chrome | Chrome/Edge is not installed on the server host, or `BC_SCREENSHOT_CHROME` points at the wrong path. Rendering the HTML itself needs no browser — only the captures do. |
| `authenticated: false` | Wrong credentials or BC unreachable. Check `bc_health`. |
| A CardPart page comes back empty | Known: open it through its host page instead (`CARDPART_STUB` carries a `hostHint`). |
| The A4 layout itself looks broken | Run `npm run verify:manual-html` — it paginates a synthetic manual in a real browser and asserts no sheet overflows, every step is placed, the index resolves and printing yields exactly one page per sheet. It leaves a PNG per sheet under `manuals/_verify/`. |

## Related

- [tools/bc_build_manual.md](../tools/bc_build_manual.md) — full parameter reference and the
  internals of the A4 layout.
- [tools/bc_screenshot.md](../tools/bc_screenshot.md) — the single-capture tool and its engine.
- [tools/bc_download_report.md](../tools/bc_download_report.md) — BC's own report output, not manuals.
- The `bc-manual` skill (`~/.claude/skills/bc-manual/SKILL.md`) drives all of this from a plain
  request like "documenta com crear un client".
