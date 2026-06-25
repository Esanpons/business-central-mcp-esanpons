# bc_run_report

> Execute a BC report by numeric ID and return its request-page dialog (parameters/filters) so you can fill them in over the WebSocket session.

## What it does
Runs a Business Central report server-side by issuing an `OpenForm` with the deep-link query `report=<id>&tenant=<tenantId>` (the same `FormPropertyBag` / `COMMAND=report` mechanism the BC web client uses, verified against decompiled `NavRunReportPropertyBagInvokedAction.cs`). It collects the resulting events and, if the report defines a request page, surfaces it as an opened dialog together with its structured fields. It does **not** render or capture the report output binary (PDF/Excel/Word) — that is delivered over a separate streaming channel and is handled by `bc_download_report`.

## When to use / when NOT to use
- **Use** to launch reports that perform server-side processing (e.g. batch posting via Report 295, inventory adjustments, data processing).
- **Use** to inspect and fill a report's request-page parameters/filters: this tool returns the request-page `formId` and fields, which you then fill with `bc_write_data` and execute via `bc_respond_dialog` (`response: "ok"`).
- **Do NOT** use it to capture the rendered report file — use `bc_download_report`, which runs out-of-band in an authenticated headless browser and intercepts the download.
- **Do NOT** use it to view or read data — use `bc_open_page` / `bc_read_data`. Reports are processing/printing objects, not UI views; do not confuse a report ID with a page ID.

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `reportId` | string or number (coerced to a trimmed string, then parsed as base-10 int) | Yes | Numeric BC report ID to execute (e.g., 1306 for Customer Statement, 6 for Trial Balance). |

The Zod schema (`RunReportSchema` in `src/mcp/schemas.ts`) declares `reportId` via `StringOrNumber`, a `z.union([z.string(), z.number()])` that `.transform()`s to `String(v).trim()`. The operation then does `parseInt(input.reportId, 10)` before dispatching.

## Output
Returns a `RunReportOutput` object (`src/operations/run-report.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Always `true` when the invoke completed without a protocol error (errors are returned as a `Result` error, not in this shape). |
| `reportId` | `number` | The parsed numeric report ID that was executed. |
| `requestPage` | `{ formId: string; fields?: ControlField[]; message?: string }` (optional) | The first dialog opened, interpreted as the report's request page. Present only when at least one dialog opened. |
| `dialogsOpened` | `Array<{ formId: string; message?: string; fields?: ControlField[] }>` | All `DialogOpened` events detected, in order (via `detectDialogs`). `requestPage` is `dialogsOpened[0]`. |
| `requiresDialogResponse` | `boolean` | `true` when `dialogsOpened.length > 0` — i.e. the report is waiting on a request page you must respond to. |

Each `fields` entry is a `ControlField` (`src/protocol/types.ts`): `controlPath` (string), `caption` (string), `type` (string), `editable` (`boolean | "unknown"`), `visible` (boolean), and optionally `value`, `stringValue`, `columnBinderName`, `isLookup`, `showMandatory`, plus ancestor-group path metadata. `message` comes from the dialog control tree's `Caption` (falling back to `Message`).

## Examples

Run a report that has no required parameters (or just to open its request page):
```json
{ "reportId": 6 }
```
Expected response shape (Trial Balance, request page shown):
```json
{
  "success": true,
  "reportId": 6,
  "requestPage": {
    "formId": "<dialog-form-id>",
    "message": "Trial Balance",
    "fields": [
      { "controlPath": "server:c[0]/...", "caption": "Show Closing Entries", "type": "...", "editable": true, "visible": true }
    ]
  },
  "dialogsOpened": [
    { "formId": "<dialog-form-id>", "message": "Trial Balance", "fields": [ /* ... */ ] }
  ],
  "requiresDialogResponse": true
}
```

Launch a server-side processing report (string ID is accepted and coerced):
```json
{ "reportId": "295" }
```

Typical multi-step workflow when a request page is returned:
1. `bc_run_report { "reportId": 1306 }` → note `requestPage.formId` and `fields`.
2. `bc_write_data` to fill the request-page parameters/filters.
3. `bc_respond_dialog { "dialogFormId": "<formId>", "response": "ok" }` to execute the report.

A report that opens with no request page returns:
```json
{ "success": true, "reportId": 6, "dialogsOpened": [], "requiresDialogResponse": false }
```

## Notes & limitations
- **No output capture.** This tool fills request-page parameters over the WebSocket but cannot retrieve the rendered PDF/Excel/Word; BC streams the report binary over a separate channel (`StreamTransfer`). Use `bc_download_report` to get the file.
- The `OpenForm` invoke resolves on the first of `InvokeCompleted`, `DialogOpened`, or `FormCreated` (`BCSession.runReport`). When the report shows a request page it arrives as a `DialogOpened` event with `MappingHint: "RequestPage"`; only `DialogOpened` events feed `dialogsOpened`, so a report whose UI surfaces as a non-dialog `FormCreated` will report `requiresDialogResponse: false`.
- `requestPage` is purely `dialogsOpened[0]`; if a report opens multiple dialogs, inspect the full `dialogsOpened` array.
- Returns `success: true` only after the invoke completes without a `ProtocolError`. A dead session yields a `ProtocolError('Session is dead')` returned as the `Result` error, not this output shape.
- The `tenantId` in the deep link is taken from the session, not from a parameter (unlike `bc_open_page`'s optional `tenantId`).
- Request-page field extraction is best-effort: malformed dialog control trees yield a dialog entry with no `fields` rather than failing the call.

## Related tools
- [bc_download_report](./bc_download_report.md) — render a report and download its output file (PDF/Excel/Word).
- [bc_respond_dialog](./bc_respond_dialog.md) — confirm (`ok`) / cancel the report request page to execute or abort.
- [bc_write_data](./bc_write_data.md) — fill request-page parameter and filter fields before responding.
- [bc_find_object](./bc_find_object.md) — look up a report's numeric ID by name/type.
