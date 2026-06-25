# bc_build_manual
> Builds a step-by-step Business Central USER MANUAL and writes it as Markdown, PDF, and/or DOCX, capturing an annotated screenshot per step.

## What it does
Takes an ordered list of steps -- each a heading, optional prose, and an optional screenshot spec -- and produces a shareable document. For every step that carries a `screenshot` spec it captures an annotated PNG by delegating to the same `ScreenshotService` engine that backs `bc_screenshot`, then renders the assembled document to the requested formats: Markdown (images linked by relative path), PDF (the HTML rendered via a headless browser), and DOCX (images embedded via the `docx` package). It is additive and out-of-band: a separate headless browser does the captures, so the BC WebSocket session and invoke queue are never touched.

## When to use / when NOT to use
Use it to produce shareable end-user documentation, training material, or onboarding guides for a BC process -- typically: open a list with `bc_open_page`, grab a record `bookmark`, then call `bc_build_manual` with a few steps that screenshot the card page and highlight the fields the reader must fill in. The user-scope skill `~/.claude/skills/bc-manual/SKILL.md` lets you simply ask "document how to create a customer" and have Claude drive the pages and call this tool.

Do NOT use it to read or extract field data (use `bc_open_page` / `bc_read_data`) or to capture a single image (use `bc_screenshot`). It requires Chrome or Edge installed on the server machine (no browser is downloaded); on a host without a browser it will fail with `MANUAL_ERROR`.

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | string | Yes | Manual title (also used to name the output files unless `name` is given). |
| `intro` | string | No | Optional introduction paragraph. |
| `steps` | array of ManualStep (min 1) | Yes | Ordered steps. Each may capture a screenshot and/or carry prose. |
| `formats` | array of `'md' \| 'pdf' \| 'docx'` | No | Which formats to generate. Defaults to all three (md, pdf, docx). |
| `outDir` | string | No | Output directory (absolute, or relative to `BC_MANUAL_DIR`). Defaults to `BC_MANUAL_DIR`. |
| `name` | string | No | Base file name (slugified). Defaults to the `title`. |

Each entry in `steps` (ManualStep) is:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `heading` | string | Yes | Step heading / title (e.g. "Open the Customer Card"). |
| `body` | string | No | Prose explaining the step. |
| `screenshot` | ManualScreenshot | No | Capture a fresh annotated screenshot for this step. |
| `image` | string | No | Or reference an existing PNG (absolute path, or relative to the manual dir). |

A step's `screenshot` (ManualScreenshot) -- the same shape as `bc_screenshot`, minus `out`/`inline`/`fullPage`:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageId` | string \| number | Yes | BC page ID to capture for this step. |
| `bookmark` | string | No | Record bookmark (from `bc_open_page` / `bc_read_data` rows). |
| `company` | string | No | Company to capture in (defaults to the session company). |
| `highlight` | string \| string[] \| Annotation[] | No | Callout(s): a caption, a list of captions (auto-numbered), or `{target,label,style}` objects. |
| `redact` | string[] | No | Captions to black out for privacy. |
| `crop` | string \| string[] | No | Caption(s) to crop the image to. |
| `expand` | boolean | No | Expand all collapsed FastTabs/groups and click every "Show more" before capturing, so additional fields are visible. Default false (a reveal pass still runs automatically when a highlight/crop caption is hidden). |
| `width` | number | No | Viewport width in pixels. |
| `height` | number | No | Viewport height in pixels. |
| `scale` | number | No | Device scale factor for crispness. |

An `Annotation` object (when `highlight` is a list of objects) is `{ target: string, label?: string, style?: 'box' | 'arrow' | 'badge' | 'blur' }` -- `target` is the exact visible caption/aria-label, `label` is the callout text/number, and `style` defaults to `box`.

## Output
On success the operation returns a `BuildManualOutput`:

| Field | Type | Description |
|-------|------|-------------|
| `md` | string (optional) | Absolute path of the generated Markdown file (present only if `md` was in `formats`). |
| `pdf` | string (optional) | Absolute path of the generated PDF file (present only if `pdf` was in `formats`). |
| `docx` | string (optional) | Absolute path of the generated DOCX file (present only if `docx` was in `formats`). |
| `images` | string[] | Absolute paths of every PNG captured during the build (one per step that had a `screenshot` spec; steps that only reference an existing `image` or are prose-only do not add entries here). |
| `steps` | number | Number of step models rendered into the document. |

On failure the operation returns an error with code `MANUAL_ERROR` and the underlying message.

Files are written under the resolved output directory: `outDir` if given (absolute, else relative to `BC_MANUAL_DIR`), otherwise `BC_MANUAL_DIR` itself (default `./manuals`, resolved against the server's working directory). The document files are named `<slug>.{md,pdf,docx}` where `<slug>` is the slugified `name` or `title`; per-step captures are written to a sibling `<slug>-img/` folder as `step-<n>.png`.

## Examples

Minimal -- two steps, default formats (md + pdf + docx):
```json
{
  "title": "How to create a customer",
  "intro": "This guide shows how to register a new customer.",
  "steps": [
    { "heading": "Open the customer list", "body": "Search for Customers.", "screenshot": { "pageId": 22 } },
    {
      "heading": "Fill in the key fields",
      "body": "Enter the name and credit limit.",
      "screenshot": { "pageId": 21, "bookmark": "1B_Eg...", "highlight": ["Name", "Credit Limit (LCY)"] }
    }
  ]
}
```
Expected response shape:
```json
{
  "md": "D:/.../manuals/how-to-create-a-customer.md",
  "pdf": "D:/.../manuals/how-to-create-a-customer.pdf",
  "docx": "D:/.../manuals/how-to-create-a-customer.docx",
  "images": [
    "D:/.../manuals/how-to-create-a-customer-img/step-1.png",
    "D:/.../manuals/how-to-create-a-customer-img/step-2.png"
  ],
  "steps": 2
}
```

Markdown only, custom name and output folder, mixing a prose-only step with an annotated capture:
```json
{
  "title": "Post a Sales Order",
  "name": "sales-order-posting",
  "outDir": "training/sales",
  "formats": ["md"],
  "steps": [
    { "heading": "Prerequisites", "body": "You need a released order and posting permissions." },
    {
      "heading": "Post the order",
      "body": "Choose Posting then Post.",
      "screenshot": { "pageId": 42, "bookmark": "27_xY...", "highlight": [{ "target": "Post", "label": "1", "style": "badge" }], "expand": true }
    }
  ]
}
```
Expected response shape (only `md` populated; one image captured for step 2):
```json
{
  "md": "D:/.../manuals/training/sales/sales-order-posting.md",
  "images": ["D:/.../manuals/training/sales/sales-order-posting-img/step-2.png"],
  "steps": 2
}
```

Reusing an existing PNG instead of capturing (no browser launch for that step):
```json
{
  "title": "Year-end checklist",
  "steps": [
    { "heading": "Overview diagram", "image": "diagrams/year-end.png" }
  ]
}
```

## Notes & limitations
- `formats` defaults to all three (`md`, `pdf`, `docx`) when omitted or empty. PDF generation launches and tears down its own headless browser per build (in addition to the per-step capture browser); DOCX is produced by the lazy-imported `docx` package.
- A step is rendered with an image only if `screenshot` captured one, or `image` points to a file that exists on disk; a missing `image` path is silently rendered as a step without an image.
- Step numbering in the rendered document (`## N. heading`) is derived from the step's position in the array; per-step capture filenames (`step-<n>.png`) use the same 1-based index.
- In DOCX, images wider than 600px are scaled down to fit; PNG dimensions are read directly from the file's IHDR chunk (no image library).
- The slug is lowercased, NFKD-normalized, stripped of non-word characters, spaced-to-hyphens, and truncated to 60 chars (falling back to `manual` if empty).
- Each step's `screenshot` follows `bc_screenshot` reveal-when-needed behavior: fields hidden in collapsed FastTabs or behind "Show more" are revealed automatically when a `highlight`/`crop` caption is not initially found; pass `expand: true` to force the page fully expanded. This reveal affects screenshots only -- it does not change what `bc_open_page` / `bc_read_data` return.
- Requires Chrome or Edge installed on the server (set `BC_SCREENSHOT_CHROME` to override the path). Output location is controlled by `BC_MANUAL_DIR` (default `./manuals`); set an absolute path for predictable output. Auth and TLS reuse the standard `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` / `BC_TENANT_ID` (and `NODE_TLS_REJECT_UNAUTHORIZED=0` for self-signed on-prem).

## Related tools
- [bc_screenshot](./bc_screenshot.md) -- captures a single annotated PNG; this tool's per-step `screenshot` spec is the same shape.
- [bc_open_page](./bc_open_page.md) -- open a page and obtain record `bookmark`s to feed into manual steps.
- [bc_read_data](./bc_read_data.md) -- read list rows (also a source of `bookmark`s).
