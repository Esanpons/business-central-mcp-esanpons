# bc_navigate

> Navigate to a record on an open List or Document page by bookmark — position the cursor on a row, drill down into the record's detail page, or trigger a field lookup.

## What it does

Operates on a page that is already open (identified by a `pageContextId` from `bc_open_page`) and a row `bookmark` taken from that page's row data. It supports three actions: `select` moves the server-side cursor onto the row without opening anything; `drill_down` opens the record's Card/Document detail page and returns a brand-new `pageContextId` for that opened page; `lookup` triggers the lookup action on a field. The operation delegates to `NavigationService.drillDown` (for `drill_down`) or `NavigationService.selectRow` (for `select`/`lookup`), then projects the resulting page context into `Section[]` DTOs. The original List/Document page stays open after a drill-down.

## When to use / when NOT to use

Use it to:
- Position the cursor on a specific list row before invoking a row-scoped action — though note `bc_execute_action` also accepts `bookmark`/`rowIndex` directly.
- Open ("drill into") a record from a list, e.g. Customer List → Customer Card, or Sales Orders → Sales Order. This is the canonical way to go from a list to a detail page.
- Drill down / look up from a specific column on a document line (`section: "lines"`, `field: "No."`).

Do NOT use it:
- On Card pages with no repeater rows — `bc_navigate` only works on pages that have repeater rows (List/Document pages). Use `bc_open_page` to open a card directly.
- To open a record by its page ID rather than from a list — use `bc_open_page`.
- To trigger named actions like Post/Delete/Release — use `bc_execute_action`.
- To write field values — use `bc_write_data`.

Do not confuse `select` with `drill_down`: `select` only moves the cursor and returns no new page; `drill_down` opens a new page and returns a new `pageContextId`.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `pageContextId` | `string` (min length 1) | Yes | Page context ID of the List or Document page containing the row to navigate to. |
| `bookmark` | `string` (min length 1) | Yes | Row bookmark from `bc_open_page` or `bc_read_data` results identifying which record to navigate to. |
| `action` | `enum('drill_down' \| 'select' \| 'lookup')` | No | `"select"` moves cursor to row (default). `"drill_down"` opens the record detail page (returns new pageContextId). `"lookup"` triggers field lookup. |
| `section` | `string` | No | Section containing the row (e.g., `"lines"` for document line items). Omit for header/default repeater. |
| `field` | `string` | No | Column caption to drill down or look up from (e.g., `"No."` to drill down on item number). Omit to use the default drill-down column. |

Note: although the `action` description states `"select"` is the default, `action` is optional in the schema and the operation treats any non-`drill_down` value (including an absent `action`, `select`, and `lookup`) as the select-row path.

## Output

Returned shape is `NavigateOutput` (`src/operations/navigate.ts`):

| Field | Type | Description |
|---|---|---|
| `targetPageContextId` | `string?` | Set only when `action='drill_down'` lands on a new page — the new page context ID of the opened Card/Document page. Absent for `select`/`lookup`. |
| `pageType` | `string?` | Page type of the drilled-down target page (e.g. `"Card"`, `"Document"`). Set only for `drill_down`. |
| `sections` | `Section[]?` | For `drill_down`: all sections of the target page (`buildAllSections`). For `select`/`lookup`: the single resolved section (`buildSection` for `section ?? 'header'`), or an empty array if that section can't be built. |
| `changedSections` | `string[]` | Always present. Currently always `[]` for this operation. |
| `dialogsOpened` | `Array<{ formId: string; message?: string; fields?: ControlField[] }>` | Always present. Currently always `[]` for this operation. |
| `requiresDialogResponse` | `boolean` | Always present. Currently always `false` for this operation. |

### `Section` shape (`src/protocol/section-dto.ts`)

| Field | Type | Description |
|---|---|---|
| `sectionId` | `string` | Section identifier (e.g. `"header"`, `"lines"`, `"factbox:…"`, `"subpage:…"`). |
| `kind` | `SectionKind` | Section kind (header / lines / factbox / subpage / requestPage, etc.). |
| `caption` | `string` | Section caption as shown in BC. |
| `fields` | `SectionField[]?` | Card-shape sections carry visible captioned fields. Each `SectionField` has `name`, `controlPath`, optional `group`, optional `value`, and a tri-state `editable` (`true`/`false`/`"unknown"`). |
| `rows` | `SectionRow[]?` | List-shape sections carry rows; cells are keyed by `columnBinderName` (e.g. `"1165569367_c2"`), not by caption. |
| `totalRowCount` | `number \| null?` | BC's TotalRowCount for list-shape sections; `null` when unknown. |
| `actions` | `SectionAction[]?` | Section actions (`name`, `systemAction` ordinal, `enabled`, optional `wizardNav`). |
| `cues` | `SectionCue[]?` | Populated when the section's form contains cuegroup tiles. |

Errors are returned as a `Result` failure carrying a `ProtocolError` (e.g. an invalid/closed `pageContextId`, an unknown `bookmark`, or a target row that cannot be resolved within the requested `section`).

## Examples

Select a row (move the cursor, no new page):

```json
{ "pageContextId": "session:page:customer-list-1", "bookmark": "21;GAAAAAJ7BACA...", "action": "select" }
```

Expected response (single resolved header section, no new page):

```json
{
  "sections": [
    { "sectionId": "header", "kind": "list", "caption": "Customers", "rows": [ /* ... */ ], "totalRowCount": 12 }
  ],
  "changedSections": [],
  "dialogsOpened": [],
  "requiresDialogResponse": false
}
```

Drill down from a list into the record's Card/Document page:

```json
{ "pageContextId": "session:page:customer-list-1", "bookmark": "21;GAAAAAJ7BACA...", "action": "drill_down" }
```

Expected response (new page context + full sections of the opened page):

```json
{
  "targetPageContextId": "session:page:customer-card-2",
  "pageType": "Card",
  "sections": [
    { "sectionId": "header", "kind": "card", "caption": "Customer Card", "fields": [ /* ... */ ], "actions": [ /* ... */ ] }
  ],
  "changedSections": [],
  "dialogsOpened": [],
  "requiresDialogResponse": false
}
```

Drill down from a specific line-item column on a Document page:

```json
{ "pageContextId": "session:page:sales-order-9", "bookmark": "37;...", "action": "drill_down", "section": "lines", "field": "No." }
```

## Notes & limitations

- After `drill_down`, BOTH the original List/Document page and the newly opened page remain open. Call `bc_close_page` on both when finished to free server-side WebSocket form sessions.
- The returned `targetPageContextId` (and `pageType`) are populated ONLY for `drill_down`. For `select`/`lookup` the cursor moves but no new page context exists.
- `changedSections`, `dialogsOpened`, and `requiresDialogResponse` are always present in the output but are currently fixed to empty/`false` by this operation — it does not surface dialogs itself. If a navigation could raise a confirmation dialog, that surfaces through other tools.
- For `select`/`lookup`, sections are limited to the single resolved section (`section ?? 'header'`); only `drill_down` returns the target page's full section set.
- This tool only works on pages with repeater rows (List/Document). It is not for Card pages.

## Related tools

- [bc_open_page](./bc_open_page.md) — open a page by ID and obtain a `pageContextId` and row bookmarks.
- [bc_read_data](./bc_read_data.md) — read/scroll page data; another source of row bookmarks.
- [bc_execute_action](./bc_execute_action.md) — run named/system actions (Post, Delete, New); accepts `bookmark`/`rowIndex` for row-scoped actions.
- [bc_write_data](./bc_write_data.md) — set field values on an open page.
- [bc_close_page](./bc_close_page.md) — close a page (including drill-down pages) and free resources.
- [bc_respond_dialog](./bc_respond_dialog.md) — respond to dialogs raised by actions/writes.
