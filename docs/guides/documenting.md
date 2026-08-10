# Documenting Business Central — which tool, which format

The one page to read before producing **any** documentation, screenshot or manual with `bc-ws`.
It answers "I need X, what do I call?" first, then the details.

## Start here

| I need… | Call | Notes |
|---|---|---|
| **One** image of a page or record | `bc_screenshot` | Highlight / crop / redact in the same call. |
| A process explained step by step, for someone to **read or print** | `bc_build_manual` with `formats: ["html"]` | Real A4 sheets, cover + index, Ctrl+P prints it. |
| …the same, to live in a **repo or wiki** | `bc_build_manual` with `formats: ["md"]` (the default) | Markdown + relatively linked PNGs. |
| …the same, for someone to **edit or restyle** | `bc_build_manual` with `formats: ["docx"]` | Editable Word, same page breaks as the HTML, real Word styles. |
| …several at once | `bc_build_manual` with `formats: ["md", "html", "docx"]` | One capture pass, several files. |
| A **PDF** of a manual | `formats: ["html"]`, then open it and press **Ctrl+P** | There is no PDF output and no PDF tool. The HTML *is* the print path. |
| Text **under** a screenshot | The step's `after` field | `body` goes above the figure, `after` below it. |
| A manual that **already exists** as `.md` | `bc_build_manual` with `source: "ruta/manual.md"` | Turns it into A4 HTML / Word without retyping. Validate it first with `validate: true`. See the [source format](manual-source-format.md). |
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

`formats` defaults to `["md"]`, so **anything else must be asked for explicitly**.

Choose by what the reader *does* with the file, not by which looks nicest:

- **Pick `html`** whenever a human is going to read or print the result: end users, training,
  onboarding, handovers, anything that may be emailed. It produces 210×297mm sheets with a cover,
  an index with real page numbers, running headers and `N / total` footers — the screen preview is
  literally the printed page.
- **Pick `docx`** when the reader must **edit** it: a client who will adapt the text, a colleague
  who has to drop it into a corporate template, or simply when the user asked for "un Word". It
  carries the **same page breaks as the HTML** (they are measured in the browser and replayed into
  Word), real Word paragraph styles — open the Styles pane and restyle every step at once — a live
  index and live page numbers. One caveat: inside a step, a table or a code listing longer than a
  page is re-flowed by Word itself, so that step can end up one page longer or shorter and the
  index's cached numbers drift after it (F9 fixes them; the footers are always right).
- **Pick `md`** when the target is a repository, a wiki, or further editing by an agent or a human.
- **Pick several** when it has to be readable *and* editable *and* versioned. One capture pass
  serves them all.

If the user says "fes-me un manual" without qualifying, default to `["html"]` and say so.

Two things worth knowing about `docx`:

- It needs Chrome/Edge, like the captures do — the page breaks come from paginating the real HTML
  in the headless browser. Without a browser the manual is still written, but Word chooses its own
  breaks and a **warning says so**. Read `warnings`.
- Word cannot embed a figure whose format or size it cannot read. PNG, JPEG, GIF and BMP are fine;
  anything else is dropped from the Word output *with a warning* (the HTML and Markdown still show
  it).

### HTML-only options

| Option | Default | Pick the other value when… |
|---|---|---|
| `assets` | `inline` | …the CSS must be tweaked by hand afterwards → `files` (writes `.html` + `.css` + `.js` + linked PNGs). `inline` is one self-contained file you can email as-is; it is ~4/3 the size of the captures. |
| `lang` | `ca` | …the manual is written in Spanish (`es`) or English (`en`). This only switches the generated chrome (cover kicker, index title, print button) — your headings and prose are whatever you write. Match it to the language of the text. |
| `cover` | `true` | …the manual is a fragment meant to be pasted into a bigger document → `false`. |
| `toc` | auto (from 4 steps) | …you want to force or suppress the index regardless of length. |

## Writing the prose

`intro`, every step `body` (**above** the figure) and every step `after` (**below** it) accept a
small Markdown subset, rendered the same in all three outputs (everything is escaped first, so
prose can never inject markup):

| Syntax | Result |
|---|---|
| blank line | new paragraph (single newlines are soft wraps) |
| `- item` / `* item` | bullet list |
| `1. item` | numbered list |
| `> text` | highlighted note box — use it for warnings and prerequisites, it stands out on paper |
| `### text` | sub-heading inside the step — `##` is the step itself |
| header + `\|---\|---\|` + rows | table — the delimiter row is mandatory and sets the alignment |
| ``` … ``` or `~~~ … ~~~` | code block — verbatim, indentation and blank lines kept |
| `**text**` | bold |
| `*text*` / `_text_` | italic |
| `` `text` `` | inline code |
| `[label](https://…)` | link (http/https only) |

A table or a listing longer than a page is **cut across pages** rather than clipped (the table
repeats its header row), so a configuration summary does not have to be split by hand. Full rules:
[the source format guide](manual-source-format.md).

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

- **Page breaks.** Every step starts on a new page. A step heading is never left alone at the foot of a page; a step that fits moves
  whole to the next sheet rather than being split. A step LONGER than a sheet flows across sheets at
  its paragraph boundaries instead of overflowing, and a figure that does not fit under its text
  moves to the next page with its `after` prose following it. Captures are capped at 180mm so any
  screenshot fits one page.
- **Figures that almost fit.** Rather than pushing a screenshot to the next page and leaving a gap,
  the layout scales it down slightly (never below 75%) when that is enough to keep it with its text.
  Below that it moves, because a capture reduced further stops being readable in print.
- **Index page numbers.** They are resolved after pagination, from where each step actually landed.
- **Image sizing.** PNG dimensions are read from the file and emitted as the intrinsic size.
- **The reader's window.** Pagination always happens at true A4; a narrow window only scales the
  preview. What prints never depends on the screen.
- **JavaScript.** Without it the page still renders as a plain readable, printable flow.

## Where the files land

Under `BC_MANUAL_DIR` (default `./manuals`), or `outDir` if given (absolute, else relative to
`BC_MANUAL_DIR`). Files are `<slug>.{md,html,docx,css,js}` from `name` or `title`; per-step captures go
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
| The A4 layout itself looks broken | Run `npm run verify:manual` — it paginates a synthetic manual in a real browser and asserts no sheet overflows, every step is placed, the index resolves and printing yields exactly one page per sheet. It leaves a PNG per sheet under `manuals/_verify/`. |
| The Word file breaks pages differently from the HTML | The break measurement failed — check `warnings` for it. `npm run verify:manual` also builds a .docx and, when LibreOffice is installed, re-flows it and compares its page count against the HTML. |
| The Word index shows no page numbers | The measurement was unavailable, so the `PAGEREF` fields shipped without a cached value. Select all in Word and press F9 to resolve them. |

## Building from a Markdown file you already have

If the manual is already written as Markdown with its screenshots, you do not author it again — pass
the path:

```json
{ "source": "D:/manuals/gestio-clients.md", "formats": ["html", "docx"] }
```

Images resolve relative to that file, so leave the PNGs where they are. Outputs land next to the
source unless `outDir` says otherwise.

The accepted format is **exactly what this tool's own `md` output writes** — the generator is the
specification, which is what stops it drifting. The full spec is in
[the source format guide](manual-source-format.md).

When the `.md` was NOT produced by this tool, **validate it first**:

```json
{ "source": "D:/manuals/gestio-clients.md", "validate": true }
```

Nothing is written; you get every problem in one pass with its line number, so one round of fixes is
enough. A normal build also returns `sourceDiagnostics`, so a table missing its delimiter row or a
dropped second figure is never silent.

## Related

- [tools/bc_build_manual.md](../tools/bc_build_manual.md) — full parameter reference and the
  internals of the A4 layout.
- [tools/bc_screenshot.md](../tools/bc_screenshot.md) — the single-capture tool and its engine.
- [tools/bc_download_report.md](../tools/bc_download_report.md) — BC's own report output, not manuals.
- The `bc-manual` skill (`~/.claude/skills/bc-manual/SKILL.md`) drives all of this from a plain
  request like "documenta com crear un client".
