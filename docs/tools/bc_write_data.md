# bc_write_data

> Writes one or more field values on an already-open Business Central page and reports, per field, whether the write interaction completed and whether the value actually moved.

## What it does
Sends a `SaveValue` interaction for each entry in a `fields` object against an open page identified by `pageContextId`. BC validates each field server-side and echoes back the confirmed value, which may differ from the input due to formatting, auto-completion, or lookups (e.g. a partial customer number resolves to the full name). For document line items, it first selects the target row (`SetCurrentRow` by bookmark/rowIndex) and then writes the cell. The operation applies the resulting events to page state and returns which sections changed plus any dialogs BC opened in response.

## When to use / when NOT to use
- Use it to set editable header/card fields (`{ "Name": "Contoso", "City": "London" }`), FactBox fields (via `section`), or line-item cells (`section: "lines"` with `rowIndex` or `bookmark`).
- Use the `group` parameter (or pass a controlPath as the key) when several controls share a caption — e.g. the three `Name` fields in the Sell-to / Bill-to / Ship-to groups of a Sales document header (P1).
- Do NOT use it to trigger actions like Post, Delete, or Release — use `bc_execute_action`. Do NOT use it to navigate to / open records — use `bc_navigate`.
- Avoid bundling unrelated field groups in one call: BC validation cascades may reorder dependent field updates unexpectedly. Write related fields (e.g. quantity + unit price) together.
- Writing a read-only field is not an error in itself: the field is reported with `changed: false` and `reason: "not editable"`, so always check the per-field `changed` flag rather than relying on `success` alone (P6).

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageContextId` | `string` (min length 1) | Yes | Page context ID returned by bc_open_page. |
| `fields` | `Record<string, string>` | Yes | Key-value pairs to write. Each key is a field caption (e.g., `{ "Name": "Contoso", "City": "London" }`) OR a stable controlPath returned by bc_open_page/bc_read_data (e.g. `"server:c[4]/c[1]/c[1]/c[0]"`). Use the controlPath form (or the `group` param) when several controls share a caption (Sell-to/Bill-to/Ship-to). |
| `section` | `string` | No | Section to write to (e.g., `"lines"` for document line items, `"factbox:Sales Addresses"` for a FactBox). Omit for header fields. |
| `group` | `string` | No | Disambiguate duplicate captions: resolve every caption-keyed field inside the group with this caption (e.g. `"Bill-to"`). Ignored for keys given as an explicit controlPath. IMPORTANT: always check each result's `changed` flag — `success` only means the interaction completed, not that the value stuck. |
| `rowIndex` | `number` | No | 0-based row position in the repeater to write to. Use for line items. Prefer bookmark for stability. |
| `bookmark` | `string` | No | Stable row identifier from bc_read_data results. Preferred over rowIndex when rows may be reordered. |

## Output
Returns a `WriteDataOutput` object (`src/operations/write-data.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `results` | `FieldWriteResult[]` | One entry per field written, in input order. |
| `allSucceeded` | `boolean` | True only if every result has `success === true` AND `changed !== false`. A no-op write (`changed === false`) does NOT count as success (P6). `changed === undefined` (line-cell writes) is treated as success-by-interaction. |
| `changedSections` | `string[]` | Section IDs whose form received events. If the root form was touched, all sections are listed (root events cascade to lines). |
| `dialogsOpened` | `Array<{ formId: string; message?: string; fields?: ControlField[] }>` | Dialogs BC raised in response (e.g. confirmation prompts, validation warnings). `message` is pulled from the dialog's Caption/Message; `fields` are the dialog's structured controls when present. |
| `requiresDialogResponse` | `boolean` | True when `dialogsOpened` is non-empty — you must follow up with `bc_respond_dialog` before continuing. |

Each `FieldWriteResult` (`src/services/data-service.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `fieldName` | `string` | The field key as supplied in `fields` (caption or controlPath). |
| `controlPath` | `string` | Resolved control path the `SaveValue` targeted (empty string when the field was not found). |
| `success` | `boolean` | True when the `SaveValue` interaction completed without a protocol error. Does NOT mean the value stuck — check `changed`. |
| `requested` | `string?` | The value the caller asked to write. |
| `changed` | `boolean?` | True when the field value actually moved (compared against the PRE-write value, so a BC-reformatted value still counts). False = no-op (rejected/reverted or not editable). Undefined for line-cell writes (effect not re-read). |
| `reason` | `'not editable' \| 'validation reverted' \| 'control not found'` (optional) | Why a no-op happened. Set only when `changed === false`, or `'control not found'` on a not-found error. |
| `newValue` | `string?` | The server-confirmed value after the write (may differ from `requested`). |
| `error` | `string?` | Error message when `success` is false (e.g. field/column not found). |
| `events` | `BCEvent[]?` | Raw BC events produced by this write. |

## Examples

Write two header fields on a Customer Card:
```json
{
  "pageContextId": "session:page:abc",
  "fields": { "Name": "Contoso Ltd", "Address": "123 Main St" }
}
```
Expected response:
```json
{
  "results": [
    { "fieldName": "Name", "controlPath": "server:c[2]/c[0]", "success": true, "requested": "Contoso Ltd", "changed": true, "newValue": "Contoso Ltd" },
    { "fieldName": "Address", "controlPath": "server:c[2]/c[3]", "success": true, "requested": "123 Main St", "changed": true, "newValue": "123 Main St" }
  ],
  "allSucceeded": true,
  "changedSections": ["header"],
  "dialogsOpened": [],
  "requiresDialogResponse": false
}
```

Disambiguate a duplicate caption on a Sales Quote header — set the `Name` inside the `Bill-to` group only (P1):
```json
{
  "pageContextId": "session:page:so1",
  "group": "Bill-to",
  "fields": { "Name": "Adatum Corporation" }
}
```
The caption `Name` is resolved to the field whose nearest captioned ancestor group is `Bill-to`, leaving the Sell-to / Ship-to `Name` controls untouched.

Write a Sales Order line cell by row position:
```json
{
  "pageContextId": "session:page:so1",
  "section": "lines",
  "rowIndex": 0,
  "fields": { "Quantity": "5", "Unit Price": "100" }
}
```
Line-cell results echo the requested value and leave `changed` undefined:
```json
{
  "results": [
    { "fieldName": "Quantity", "controlPath": "server:c[6]/cr/c[7]", "success": true, "requested": "5", "newValue": "5" },
    { "fieldName": "Unit Price", "controlPath": "server:c[6]/cr/c[12]", "success": true, "requested": "100", "newValue": "100" }
  ],
  "allSucceeded": true,
  "changedSections": ["lines"],
  "dialogsOpened": [],
  "requiresDialogResponse": false
}
```

## Notes & limitations
- success vs changed (P6): `success` reflects only that the `SaveValue` interaction completed without a protocol error. The field-level `changed` flag is the real outcome — it is derived by snapshotting the field's value (and `editable`) BEFORE the write and comparing the trimmed pre-write value to the post-write value read back from the tree. If the value did not move, `changed` is `false` with `reason` = `'not editable'` (when the control was not editable before the write) or `'validation reverted'` (when BC accepted then reverted/rejected it). `allSucceeded` already folds this in: it requires `success === true` and `changed !== false` for every field.
- group / controlPath targeting for duplicate captions (P1): field resolution (`resolveFieldNode`) tries, in priority order, (1) an exact `controlPath` match — unambiguous, `group` ignored; (2) `group` + caption via `findFieldByGroupCaption`, which matches a field's caption AND its nearest captioned ancestor group (both case-insensitive); (3) caption alone — legacy behaviour, first match in tree order wins. So on document headers with repeated captions, either pass the field's controlPath as the key, or set `group` to pick the right control among the Sell-to / Bill-to / Ship-to copies.
- Line-cell writes (`section` pointing at a repeater with `rowIndex` or `bookmark`) take a different path: the row is selected with `SetCurrentRow` (using the CHILD subpage form's `formId` — root formId triggers `InvalidBookmarkException`), the column is located by caption, and the cell is written at `{repeaterPath}/cr/c[N]`. These return `changed: undefined` because the cell is not re-read to confirm the effect. `bookmark` is preferred over `rowIndex` since rows may be reordered/inserted since the last read.
- A field/column that cannot be resolved is reported as `success: false` with `reason: 'control not found'` and an `error` message; the operation still processes the remaining fields. The thrown `ProtocolError` for a missing header field carries `availableFields`; for a missing line column it carries `availableColumns`.
- Fields are written sequentially in input order (`writeFields` loops over `Object.entries`). BC validation can cascade across fields, so order can matter — write related fields together and inspect the returned `newValue`s.
- When `dialogsOpened` is non-empty / `requiresDialogResponse` is true, the write is not final until you call `bc_respond_dialog` with the dialog's `formId`.

## Related tools
- [./bc_open_page.md](./bc_open_page.md) — opens a page and returns the `pageContextId` plus sections/fields/controlPaths consumed here.
- [./bc_read_data.md](./bc_read_data.md) — refresh a section and read confirmed field/row values (and bookmarks) before/after writing.
- [./bc_execute_action.md](./bc_execute_action.md) — trigger actions (Post, Delete, New, Release); use instead of bc_write_data for non-field operations.
- [./bc_respond_dialog.md](./bc_respond_dialog.md) — respond to dialogs reported in `dialogsOpened` when `requiresDialogResponse` is true.
- [./bc_navigate.md](./bc_navigate.md) — select / drill down / look up rows; use instead of bc_write_data for record navigation.
- [./bc_close_page.md](./bc_close_page.md) — free the page's server-side resources when finished.
