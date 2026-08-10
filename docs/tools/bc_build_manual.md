# bc_build_manual
> Builds a step-by-step Business Central USER MANUAL as Markdown, a printable A4 web page and/or an editable Word document, capturing an annotated screenshot per step.

> **Deciding what to produce?** Start with the [documentation guide](../guides/documenting.md) —
> it is the decision table for screenshot vs manual, `md` vs `html` vs `docx`, and how to get a PDF.
> This page is the full parameter reference.

## What it does
Takes an ordered list of steps -- each a heading, optional prose, and an optional screenshot spec -- and produces a shareable document. For every step that carries a `screenshot` spec it captures an annotated PNG by delegating to the same `ScreenshotService` engine that backs `bc_screenshot`, then renders the assembled document to the requested formats. It is additive and out-of-band: a separate headless browser does the captures, so the BC WebSocket session and invoke queue are never touched.

One authoring model, three outputs:

- **`md`** -- plain Markdown, images linked by relative path. Right for repos, wikis, and further editing.
- **`html`** -- a printable web page laid out as real 210x297mm sheets: cover, index with page numbers, running header, page footer with `N / total`. What you see on screen is what comes out of **Ctrl+P**, so the reader gets a paged PDF without any extra tooling.
- **`docx`** -- an editable Word document with the **same page breaks as the HTML** (with one caveat below), real Word paragraph styles, a live index and live page numbers. For a reader who has to edit the manual, restyle it into a corporate template, or simply asked for "a Word".

No PDF is produced. The HTML *is* the print path.

### How the Word output gets the HTML's page breaks

The two outputs paginate in fundamentally different ways. The HTML paginates by **measurement**: a bundled paginator measures each block against the real height of an A4 sheet and decides where to break. Word paginates **declaratively**: it re-flows the document itself and honours only the rules it is given. A `.docx` built from rules alone would therefore break in different places than the printed HTML.

So it is not built from rules alone. When `docx` is requested, the HTML is rendered and **paginated in the headless browser**, the finished layout is asked which sheet each block landed on, and that map is replayed into the Word document as explicit page breaks. The result matches the PDF page for page, while remaining a normal editable Word file.

Three consequences worth knowing:

- **It needs Chrome/Edge**, the same as the captures do. If the browser is unavailable the manual is still written -- Word simply chooses its own breaks -- and a `warning` says exactly that. Never assume the pages match without checking `warnings`.
- **A long table or code block is the one place the two can diverge.** Every step still starts on its own page in both outputs, but *inside* a step Word re-flows a table or a listing itself, and it may need one page more or fewer than the browser did. When that happens the index's cached page numbers drift for the steps after it — the running footers stay right (they are live fields) and Ctrl+A then F9 fixes the index. `npm run verify:manual` catches it by re-flowing the .docx with LibreOffice, when LibreOffice is installed.
- **The index numbers are cached, not baked.** Each index row is a real `PAGEREF` field pointing at a per-step bookmark, shipped with the measured page number as its cached value. It reads correctly the moment the file opens, and it re-resolves itself if the reader edits the document and presses F9.

### Building from an existing Markdown file

Instead of authoring `steps` here, pass `source`: the path of a `.md` manual that already exists.

```json
{ "source": "D:/manuals/gestio-clients.md", "formats": ["html", "docx"] }
```

Its images are resolved relative to that file, so you pass the `.md` and leave the PNGs where they are. Outputs land next to the source unless `outDir` says otherwise. `title`, `intro` and `steps` come from the document.

**The accepted format is this tool's own `md` output** — the generator is the specification, and a round-trip test pins the two together so it cannot drift. Full spec: [the source format guide](../guides/manual-source-format.md).

When the `.md` was not produced by this tool, **validate first**: `{ "source": "...", "validate": true }` parses and checks it without building, returning `sourceDiagnostics` as `line N: severity: message` — every problem in one pass, so one round of fixes is enough. Errors (no title, no steps, a missing image) mean nothing is built; warnings (a dropped second figure, a table missing its delimiter row, an unclosed code fence) mean it builds but that part is not what you meant. A normal build returns `sourceDiagnostics` too, so warnings are never silent.

Requesting `md` when the output would overwrite the source is refused with a clear error — the input document is never destroyed.

## When to use / when NOT to use
Use it to produce shareable end-user documentation, training material, or onboarding guides for a BC process -- typically: open a list with `bc_open_page`, grab a record `bookmark`, then call `bc_build_manual` with a few steps that screenshot the card page and highlight the fields the reader must fill in. The user-scope skill `~/.claude/skills/bc-manual/SKILL.md` lets you simply ask "document how to create a customer" and have Claude drive the pages and call this tool.

Choose by what the reader does with the file: `"html"` when the manual is meant to be *read* or *printed*, `"docx"` when it must be *edited* or restyled, `"md"` when it lives in a repo. Pass several to get several -- one capture pass serves them all.

Do NOT use it to read or extract field data (use `bc_open_page` / `bc_read_data`) or to capture a single image (use `bc_screenshot`). It requires Chrome or Edge installed on the server machine (no browser is downloaded); on a host without a browser the capture steps fail with `MANUAL_ERROR`.

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | string | No | Path of an existing `.md` manual to build from. When given, `title`/`intro`/`steps` are read from the document and ignored here. See [the source format](../guides/manual-source-format.md). |
| `validate` | boolean | No | With `source`: parse and check the document **without building**. Returns `sourceDiagnostics` only. |
| `title` | string | Required unless `source` | Manual title (also used to name the output files unless `name` is given). |
| `intro` | string | No | Introduction paragraph. In HTML it goes on the cover. Markdown formatting allowed. |
| `steps` | array of ManualStep (min 1) | Required unless `source` | Ordered steps. Each may capture a screenshot and/or carry prose. |
| `formats` | array of `'md' \| 'html' \| 'docx'` | No | Output formats. Defaults to `["md"]`. Pass several to get several. |
| `outDir` | string | No | Output directory (absolute, or relative to `BC_MANUAL_DIR`). Defaults to `BC_MANUAL_DIR`. |
| `name` | string | No | Base file name (slugified). Defaults to the `title`. |
| `assets` | `'inline' \| 'files'` | No | HTML only. `inline` (default) writes one self-contained `.html` with the CSS, JS and PNGs embedded. `files` writes `.html` + `.css` + `.js` and links the PNGs. |
| `lang` | string | No | HTML and DOCX. Language of the generated chrome (cover kicker, index title, print button, hint): `ca` (default), `es`, `en`. Anything else falls back to English. The step text is whatever you write. |
| `cover` | boolean | No | HTML and DOCX. Emit the cover sheet. Default `true`. |
| `toc` | boolean | No | HTML and DOCX. Emit the index sheet. Default: only when the manual has 4 or more steps. |

Each entry in `steps` (ManualStep) is:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `heading` | string | Yes | Step heading / title (e.g. "Open the Customer Card"). |
| `body` | string | No | Prose printed ABOVE the figure. Markdown subset -- see [Prose formatting](#prose-formatting). |
| `after` | string | No | Prose printed BELOW the figure: what the reader should notice in the image, or what comes next. Same Markdown subset. |
| `screenshot` | ManualScreenshot | No | Capture a fresh annotated screenshot for this step. |
| `image` | string | No | Or reference an existing PNG (absolute path, or relative to the manual dir). |
| `caption` | string | No | Caption printed under this step's figure (e.g. "Customer Card, General FastTab"). Rendered as a `<figcaption>` in HTML and an italic line in Markdown. |

A step's `screenshot` (ManualScreenshot) -- the same shape as `bc_screenshot`, minus `out`/`inline`/`fullPage`:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageId` | string \| number | Yes | BC page ID to capture for this step. |
| `bookmark` | string | No | Record bookmark (from `bc_open_page` / `bc_read_data` rows). |
| `company` | string | No | Company to capture in (defaults to the session company). |
| `highlight` | string \| string[] \| Annotation[] | No | Callout(s): a caption, a list of captions (auto-numbered), or `{target,label,style}` objects. |
| `redact` | string[] | No | Captions to black out for privacy. |
| `crop` | string \| string[] | No | Caption(s) to crop the image to. |
| `expand` | boolean | No | Expand all collapsed FastTabs/groups and click every "Show more" before capturing. Default false (a reveal pass still runs automatically when a highlight/crop caption is hidden). |
| `width` | number | No | Viewport width in pixels. |
| `height` | number | No | Viewport height in pixels. |
| `scale` | number | No | Device scale factor for crispness. |

An `Annotation` object (when `highlight` is a list of objects) is `{ target: string, label?: string, style?: 'box' | 'arrow' | 'badge' | 'blur' }` -- `target` is the exact visible caption/aria-label, `label` is the callout text/number, and `style` defaults to `box`.

## Prose formatting
`intro` and every step `body` are written in a small Markdown subset, rendered identically in every output: in `md` it is passed through verbatim, while `html` and `docx` render it from ONE shared parse (the source is parsed into a tiny AST that both renderers walk). Escaping happens in the HTML renderer, so prose can never inject markup into the page.

| Syntax | Result |
|--------|--------|
| blank line | new paragraph (single newlines are soft wraps) |
| `- item` / `* item` | bullet list |
| `1. item` | numbered list |
| `> text` | highlighted note box |
| `### text` | sub-heading INSIDE the step (`##` is the step itself) |
| header + `\|---\|---\|` + rows | GFM table (see below) |
| ``` … ``` or `~~~ … ~~~` | fenced code block (see below) |
| `**text**` | bold |
| `*text*` / `_text_` | italic |
| `` `text` `` | inline code |
| `[label](https://...)` | link (http/https only) |

**Tables** need the `|---|---|` delimiter row -- without it there is no table, only pipes. The
delimiter also sets the alignment (`:---` left, `:---:` centre, `---:` right). A pipe that is
content is written `\|` or put inside `` `code` ``; a short row is padded to the header width.
In `html` a table longer than a sheet is cut across sheets and each part repeats the header row;
in `docx` it is a real Word table whose first row is flagged *repeat as header row*.

**Code blocks** are verbatim: nothing inside is formatted, and indentation and blank lines are
preserved (so ASCII diagrams survive). Use `~~~` when the content itself contains backticks. The
info string (` ```bash `) is kept but there is no syntax colouring. In `html` a long listing is cut
line by line across sheets; in `docx` it is one shaded paragraph per line, which is what lets Word
break it anywhere.

Inside a fence **nothing is structure**: a `## `, an `![](…)` or an italic caption line in a
listing is content and does not cut the document -- which is what lets a manual document this very
format.

**Sub-headings**: only `## ` starts a step. `###` and deeper are sub-sections inside the current
step -- use them to break up a long one. They do not appear in the manual's index (which lists
steps) but do appear in Word's navigation pane, under their step.

Not in the model: a second figure in one step (dropped -- split the step) and nested lists
(flattened).

## Output
On success the operation returns a `BuildManualOutput`:

| Field | Type | Description |
|-------|------|-------------|
| `md` | string (optional) | Absolute path of the Markdown file (present only if `md` was in `formats`). |
| `html` | string (optional) | Absolute path of the A4 web page (present only if `html` was in `formats`). |
| `docx` | string (optional) | Absolute path of the Word document (present only if `docx` was in `formats`). |
| `css` | string (optional) | Absolute path of the stylesheet -- only when HTML was built with `assets: "files"`. |
| `js` | string (optional) | Absolute path of the paginator script -- only when HTML was built with `assets: "files"`. |
| `sourceDiagnostics` | string[] (optional) | Only with `source`. Problems found in the document, as `line N: severity: message`, in reading order. Present on a successful build too — read it. |
| `validated` | boolean (optional) | True when `validate` was requested: the document was checked and nothing was written. |
| `images` | string[] | Absolute paths of every image in the document: PNGs captured during the build plus any existing file referenced through a step's `image`. |
| `steps` | number | Number of step models rendered into the document. |
| `warnings` | string[] (optional) | Per-step problems that would otherwise be invisible in a finished document: a `redact` caption that was never located (the figure still shows the value), a `highlight` caption that matched nothing (the callout is missing), a capture taken before the SPA settled (`spaReady:false`), a referenced `image` that does not exist (the figure was dropped), or a capture that returned without writing its PNG. **A manual can be built successfully and still be wrong** — check this array and re-shoot the steps it names. |

On failure the operation returns an error with code `MANUAL_ERROR` and the underlying message.

Files are written under the resolved output directory: `outDir` if given (absolute, else relative to `BC_MANUAL_DIR`), otherwise `BC_MANUAL_DIR` itself (default `./manuals`, resolved against the server's working directory). The document files are named `<slug>.{md,html,docx,css,js}` where `<slug>` is the slugified `name` or `title`; per-step captures are written to a sibling `<slug>-img/` folder as `step-<n>.png`.

## How the A4 layout works
The page ships its content as a flat list of measurable units plus an empty `#doc` target and a `<template>` for one sheet. A bundled paginator measures each unit against the real height of a sheet body and distributes them across `.sheet` elements, then numbers the pages and fills the index with the page each step actually landed on.

- **Every step starts on a new page**, in both the HTML and the Word output.
- **A table or a code listing is never split when it could fit on a page of its own** -- it moves whole to the next page instead, in both outputs. Only one taller than a whole page is cut, because then there is no alternative; the continuation then repeats the column headers.
- **A figure that does not quite fit is scaled down rather than pushed to the next page** -- but only slightly (never below 75% of its natural size). If it would need more than that, it moves instead, because a capture reduced past that point is no longer readable in print. The Word output embeds whatever size the browser settled on, so both stay identical.
- Every unit of a step (heading, each prose block, the figure, each block below it) shares a `data-group`, so the step is kept whole when it fits and moves whole to the next sheet when it does not.
- Prose is measured **one unit per Markdown block**, so a step longer than a sheet flows across sheets instead of overflowing the paper. The first block rides with the heading, which is what stops a heading being left alone at the foot of a page.
- A figure that does not fit under its text moves to the next sheet, and the prose below it follows -- text and image never end up in the wrong order.
- Screenshots are capped at `--fig-max-h` (180mm), which guarantees any capture fits on a single sheet.
- The index closes its sheet, so the steps always start on a fresh page.
- Print CSS is `@page { size: A4; margin: 0 }` with one page break per sheet; the sheet is 0.2mm shorter when printing, which is what stops Chrome from interleaving blank pages.
- Without JavaScript the page still renders as a plain readable (and printable) flow -- the paginator is progressive enhancement.
- On a narrow window the whole document is scaled down to fit; pagination itself always happens at true A4 size, so the print result never depends on the reader's window.

To restyle: every colour, font and page metric is a CSS variable in `:root`. Build with `assets: "files"` to get the stylesheet as a separate editable `.css`.

## Examples

Printable manual, default single self-contained file:
```json
{
  "title": "Com crear un client",
  "intro": "Aquesta guia mostra com donar d'alta un client nou.",
  "steps": [
    { "heading": "Obre la llista de clients", "body": "Busca **Clients** i obre la llista.", "screenshot": { "pageId": 22 } },
    {
      "heading": "Omple els camps clau",
      "body": "Introdueix el nom i el limit de credit.\n\n> El limit de credit condiciona els avisos de bloqueig.",
      "screenshot": { "pageId": 21, "bookmark": "1B_Eg...", "highlight": ["Name", "Credit Limit (LCY)"] }
    }
  ],
  "formats": ["html"]
}
```
Expected response shape:
```json
{
  "html": "D:/.../manuals/com-crear-un-client.html",
  "images": [
    "D:/.../manuals/com-crear-un-client-img/step-1.png",
    "D:/.../manuals/com-crear-un-client-img/step-2.png"
  ],
  "steps": 2
}
```

Both outputs, Spanish chrome, separate assets so the CSS can be tweaked by hand:
```json
{
  "title": "Registrar un pedido de venta",
  "name": "pedido-venta",
  "outDir": "training/ventas",
  "formats": ["md", "html"],
  "assets": "files",
  "lang": "es",
  "steps": [
    { "heading": "Requisitos", "body": "Necesitas un pedido liberado y permisos de registro." },
    {
      "heading": "Registra el pedido",
      "body": "Elige Registrar y confirma.",
      "screenshot": { "pageId": 42, "bookmark": "27_xY...", "highlight": [{ "target": "Post", "label": "1", "style": "badge" }], "expand": true }
    }
  ]
}
```
Expected response shape:
```json
{
  "md": "D:/.../manuals/training/ventas/pedido-venta.md",
  "html": "D:/.../manuals/training/ventas/pedido-venta.html",
  "css": "D:/.../manuals/training/ventas/pedido-venta.css",
  "js": "D:/.../manuals/training/ventas/pedido-venta.js",
  "images": ["D:/.../manuals/training/ventas/pedido-venta-img/step-2.png"],
  "steps": 2
}
```

Markdown only (the default), reusing an existing PNG instead of capturing:
```json
{
  "title": "Year-end checklist",
  "steps": [
    { "heading": "Overview diagram", "image": "diagrams/year-end.png" }
  ]
}
```

## Notes & limitations
- `formats` defaults to `["md"]` when omitted or empty. Ask for `"html"` explicitly when the manual is meant to be printed or handed over, and `"docx"` when it must be edited.
- `assets` only affects the HTML output. `lang`, `cover` and `toc` affect HTML and DOCX. All four are ignored when only `md` is requested.
- The `docx` output needs Chrome/Edge to measure its page breaks. Without a browser it is still written, with Word choosing its own breaks and a `warning` saying so.
- Word can only embed PNG, JPEG, GIF and BMP figures, and only when their size is readable from the file header. Anything else is dropped from the `.docx` **with a warning**; the `md` and `html` outputs still show it.
- With `assets: "inline"` the PNGs are base64-embedded, so the `.html` is roughly 4/3 the size of the captures (a 10-screenshot manual lands around 3-5 MB). Use `assets: "files"` if that matters.
- A step is rendered with an image only if `screenshot` captured one, or `image` points to a file that exists on disk; a missing `image` path is silently rendered as a step without an image.
- Step numbering (`## N. heading` in Markdown, the teal badge in HTML) is derived from the step's position in the array; per-step capture filenames (`step-<n>.png`) use the same 1-based index.
- PNG dimensions are read directly from the file's IHDR chunk (no image library) and emitted as the `<img>` intrinsic size, which keeps the measured layout stable before the images decode.
- The slug is lowercased, NFKD-normalized, stripped of non-word characters, spaced-to-hyphens, and truncated to 60 chars (falling back to `manual` if empty).
- Each step's `screenshot` follows `bc_screenshot` reveal-when-needed behavior: fields hidden in collapsed FastTabs or behind "Show more" are revealed automatically when a `highlight`/`crop` caption is not initially found; pass `expand: true` to force the page fully expanded. This reveal affects screenshots only -- it does not change what `bc_open_page` / `bc_read_data` return.
- Requires Chrome or Edge installed on the server for the *captures* (set `BC_SCREENSHOT_CHROME` to override the path); rendering the HTML itself needs no browser. Output location is controlled by `BC_MANUAL_DIR` (default `./manuals`). Auth and TLS reuse the standard `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` / `BC_TENANT_ID` (and `NODE_TLS_REJECT_UNAUTHORIZED=0` for self-signed on-prem).
- Layout regressions are caught by `npm run verify:manual`, which builds a synthetic multi-page manual from PNGs on disk, paginates it in a real browser, and asserts no sheet overflows, every step is placed, the index resolves, and printing yields exactly one page per sheet. It then builds the `.docx` from the same measured layout and, when LibreOffice is installed, re-flows it and compares its page count against the HTML (reported as SKIPPED otherwise).

## Related tools
- [bc_screenshot](./bc_screenshot.md) -- captures a single annotated PNG; this tool's per-step `screenshot` spec is the same shape.
- [bc_open_page](./bc_open_page.md) -- open a page and obtain record `bookmark`s to feed into manual steps.
- [bc_read_data](./bc_read_data.md) -- read list rows (also a source of `bookmark`s).
