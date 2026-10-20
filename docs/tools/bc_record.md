# bc_record
> Record a VIDEO (MP4) of the Business Central web client while a circuit of real interactions is performed in it, the way a person would — a visible cursor, real clicks, human-paced typing, a caption per step — to show what was done, review a circuit, or feed a video tutorial.

## What it does
`bc_record` is `bc_screenshot` with a camera on. The same authenticated headless browser opens the same deep link (`pageId` + `bookmark` / `company`), waits for the page, and then — instead of taking one picture — starts a screencast and performs the `steps` you give it **as a person would**: a drawn cursor glides to each control along an eased path, the click shows a ripple, text is typed at ~70 ms per key, and a caption strip at the bottom names the step while it runs (`label`). A title card opens the video (`intro`), every step is followed by a pause so the viewer sees what it produced (`pace`), and the final state is held before the recording stops (`outro`).

The tab is captured through CDP (`Page.startScreencast`) and encoded by **ffmpeg in one pass** to H.264 MP4 (`yuv420p`, 1920×1080, 30 fps by default) — the one container everything plays: Windows' own player, Teams, PowerPoint, a browser. Frames are sampled at a fixed rate in wall-clock time, so the `.json` timeline written next to the video (which step started at which millisecond) matches the picture exactly. `format: "webm"` keeps VP9 instead (no libx264 needed).

It is fully **out-of-band**: nothing touches the WebSocket session your other `bc_` tools use.

## When to use / when NOT to use
Use it when someone must **watch** a circuit: to show what was done in BC, to review a sequence before documenting it, or as raw footage for a video tutorial (the timeline gives subtitles their timings; narration can be laid over it afterwards). A typical 6-step circuit is 20-40 s of video and takes about that long to record plus a few seconds of encoding.

Do NOT use it for a still image (`bc_screenshot`), for a written step-by-step document (`bc_build_manual`), or to read or edit data (`bc_open_page` / `bc_read_data` / `bc_write_data`): it returns a file, not data, and the video is NOT returned inline.

**It is the REAL client.** A step that posts, deletes or confirms DOES it. Typed values and selections are discarded with the browser unless a step presses the confirming button — which is exactly what makes a dialog recordable without executing it (fill it, then `{ click: "Cancelar" }`). A card opened by deep link may be in VIEW mode on SaaS: click its edit action before typing, or the `type` step reports `value did not change`.

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageId` | string \| number | Yes | Numeric BC page ID the circuit starts on (e.g. 22 for Customer List). |
| `bookmark` | string | No | Start on a specific record (bookmarks come from list rows in `bc_open_page` / `bc_read_data`). |
| `company` | string | No | Company to record in. Defaults to the session's current company. |
| `steps` | `Step[]` | Yes (≥ 1) | The circuit, in order. Same step kinds as `bc_screenshot`: `{ click }` (real pointer click by caption), `{ selector }` (by CSS selector), `{ hover }` (move the cursor onto a control without clicking — "look here"), `{ goto }` (open another page id in the same tab, same company: continue the circuit on another list), `{ type, into? }` (keyboard text), `{ press }` (`"Enter"`, `"Escape"`, `"Alt+Q"`), `{ selectRows: [tokens] }` (multi-row selection), `{ wait }` (ms). Each may carry **`label`**: the caption shown on screen while it runs, in the audience's language. Without a label the caption is the step's technical description; an unlabelled `wait` keeps the previous caption. |
| `title` | string | No | Title card shown over the opened page during `intro`. Default: none. A plain recording has no overlay besides the cursor. |
| `captions` | boolean | No | Show the per-step caption strip (default `false`). Set `true` for a narrated-tutorial look. |
| `cursor` | boolean | No | Draw the cursor overlay (default `true`). Headless Chrome paints no pointer, so without it the video shows clicks happening from nowhere. |
| `pace` | number | No | Pause after every step, ms (default 1200, max 10000). A `wait` step is its own pause. |
| `typingDelay` | number | No | Keyboard delay per typed character, ms (default 70). `0` types instantly. |
| `glide` | number | No | Longest a cursor move may take, ms (default 1100; short moves take about a third). `0` makes the cursor jump. |
| `speed` | number | No | Tempo multiplier (default 1) over `pace`, `glide`, `typingDelay` AND every `{ wait }` step: `2` is twice as fast, `0.5` half. |
| `settle` | number | No | After every step, wait until the page has stopped changing (no DOM mutation for 250 ms), at most this many ms (default 8000; `0` disables). The take follows BC at its own pace; `{ wait }` is then only for work BC does without touching the page. |
| `intro` | number | No | Hold on the opened page (with the title card) before the first step, ms (default 1500). |
| `outro` | number | No | Hold on the final state before stopping, ms (default 1500). |
| `out` | string | No | Output file. Absolute path used as-is; a relative name goes under `BC_RECORDING_DIR` (default `./recordings`). Omit to auto-name `page-<id>-<timestamp>.mp4`. The extension follows `format`. |
| `width` / `height` | number | No | Video size in pixels (default 1920 × 1080). |
| `fps` | number | No | Frames per second (default 30, 10-60). |
| `format` | `"mp4"` \| `"webm"` | No | `mp4` (default; H.264) or `webm` (VP9). |
| `expand` | boolean | No | Expand every collapsed FastTab and click every "Show more" on the opened page before recording starts (default `false`). |
| `dismissTeachingTips` | boolean | No | Close BC's "About this page" callouts before recording (default `true`). |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `path` | string | The video file written. |
| `timelinePath` | string | `<path>.json`: `{ video, pageId, url, company, recordedAt, width, height, fps, durationMs, steps[] }` — the same steps with their timestamps, for subtitles, narration or editing. |
| `url` / `pageTitle` | string | The deep link opened and the page title at the end. |
| `durationMs` | number | Length of the video. |
| `width` / `height` / `fps` / `format` | | As recorded. |
| `steps` | `{ index, label, atMs, step, ok, reason?, selected?, skipped? }[]` | One entry per step, in order. **Check it.** `atMs` is when the step began (ms from the start of the video); `ok: false` means the video shows the page WITHOUT that interaction and `reason` says why (`not found`, `disabled`, `no row matched: …`, `value did not change …`). |
| `warning` | string (optional) | Loud, human-readable: failed steps, a page that does not look like BC. Read it before using the file. |

A run that fails writes **nothing**: the encoder works on a `.part` file that is renamed into place only when the recording has been judged good, so a failed take never replaces a previous video at the same path.

## Examples
```jsonc
// Open a customer from the list, back to the list
{ "pageId": 22, "title": "Clientes: abrir una ficha",
  "steps": [
    { "hover": "Nuevo", "label": "Aquí se crea un cliente nuevo" },
    { "click": "Buscar Customers", "label": "Buscar en la lista" },
    { "type": "Adatum", "label": "Escribir el nombre" },
    { "wait": 1500 },
    { "click": "Adatum Corporation", "label": "Abrir la ficha del cliente" },
    { "wait": 2000 },
    { "press": "Escape", "label": "Volver a la lista" }
  ] }
// -> { "path": ".../recordings/page-22-2026-10-20T08-16-05-123Z.mp4",
//      "timelinePath": ".../page-22-....mp4.json", "durationMs": 24810, "fps": 30,
//      "steps": [ { "index": 1, "label": "Aquí se crea un cliente nuevo", "atMs": 1872, "step": "hover \"Nuevo\"", "ok": true }, … ] }

// Fill a dialog and cancel it: nothing is executed, the video shows how it is filled
{ "pageId": 42, "bookmark": "1D_J…", "out": "pedidos/publicar.mp4",
  "steps": [
    { "click": "Publicar", "label": "Publicar el pedido" },
    { "wait": 1500 },
    { "click": "Cancelar", "label": "Cancelar: solo mostramos el diálogo" }
  ] }
```

## Tempo: how fast can it go?
Measured on devel1 (company CRONUS International Ltd., 2026-10-20), the same 46-step sales circuit (order -> release -> ship -> new invoice -> Get Shipment Lines -> post -> posted invoice):

| Take | Settings | Duration |
|---|---|---|
| Default | `pace` 1200, `glide` 1100, `typingDelay` 70, waits 2.5-10 s | 140 s |
| Fastest practical | `pace` 0, `glide` 0, `typingDelay` 0, waits of what BC needs (1.5-2 s after opening a card, 6-7 s after a posting) | 62 s |
| Settle-paced | `pace` 0, `glide` 0, `typingDelay` 0, `intro` 500, `outro` 1000, NO `wait` steps (`settle` follows BC) | 33 s |
| Fast but human | `pace` 150, `glide` 650, `typingDelay` 45, `intro` 600, `outro` 1200, no `wait` steps | 52 s |

What is left at the fast end is Business Central's own processing time: a `wait` shorter than that makes the next step act on a page that is not there yet, and the step reports `not found`. `speed` scales every `wait` with the rest, so a guide written for the default tempo runs at `speed: 2` without edits as long as its waits had slack.

## Notes & limitations
- **Measured on devel1 (BC27, 2026-10-20):** a 7-step circuit on the Customer List produced a 19.9 s H.264 MP4 (598 frames, 351 repaints) in 26.6 s wall-clock; the caption of each step appears in the video within a frame of its `atMs`.
- **Why its own screencast and not puppeteer's.** `page.screencast()` duplicates each captured frame `round(fps × Δt)` times; a cursor moving at ~60 Hz hands it 16 ms gaps that round to zero and the file came out 24.4 s long for 20.5 s of real time — the timeline no longer matched the picture. It also encodes VP9 only. `src/services/screencast.ts` keeps the newest CDP frame and writes it to ffmpeg exactly `fps` times per second of elapsed time (sample-and-hold), straight to H.264.
- **The cursor is an overlay** in the top document (BC content lives in an iframe; a fixed element above it covers everything), moved in lockstep with the real mouse — so hover states in the page and the pointer in the picture agree. The overlay re-creates itself if BC replaces the document.
- **ffmpeg is required** and nothing is bundled: `ffmpeg` on PATH, or `BC_FFMPEG` to the executable, or one of the known installs (`pip install imageio-ffmpeg`, `winget install Gyan.FFmpeg`, `C:\ffmpeg\bin`, `/usr/bin`, Homebrew). A missing one fails BEFORE a browser is launched, with those instructions.
- **Caption matching is locale-dependent.** When a step comes back `not found`, run `bc_screenshot { pageId, debugCaptions: true }` on the same page and copy the exact text BC renders. Clicking a column header (`"Name"`) opens its menu rather than sorting; `press: "Escape"` with nothing open closes the page.
- Everything `bc_screenshot`'s `steps` documentation says about view mode, Escape, tiles vs lists and "nothing is committed" applies here unchanged — it is the same code.

## Related tools
- `bc_screenshot` — one still image of a page, same engine and same `steps`; use `debugCaptions` there to find captions.
- `bc_build_manual` — a written step-by-step document with annotated screenshots.
- `bc_open_page` / `bc_read_data` — to find page ids and record bookmarks before recording.
