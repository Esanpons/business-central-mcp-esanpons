# bc_read_data
> Refresh one section of an already-open Business Central page and return its current fields or rows.

## What it does
Re-reads a single named section of a page that was previously opened with `bc_open_page`, projecting the live form state into one `Section` DTO. Card-shape sections (`header`, `factbox`, `subpage`, `requestPage`) come back with a `fields[]` array; list-shape sections (`lines`, list-bodied subpages) come back with `rows[]` plus `totalRowCount`. Before projecting, it can apply server-side filters (list sections only) and materialize repeater rows up to the requested range by scrolling. The returned section can be further narrowed in-process by `tab`, `group`, `columns`, and `range`.

## When to use / when NOT to use
Use it to pull fresh data for one section after a write/action changed it, to filter a list down, to paginate through a large repeater, or to read a FactBox that wasn't fully loaded. It is the read step of the typical loop `bc_open_page -> bc_read_data -> bc_write_data -> bc_execute_action -> bc_close_page`.

Do NOT use it to open a page (use `bc_open_page`), to write values (use `bc_write_data`), to trigger actions like Post/Delete/Release (use `bc_execute_action`), or to navigate to / drill into a record (use `bc_navigate`). Filters are ignored for card-shape sections — they only apply to list-shape sections.

## Parameters
| Name | Type | Required | Description |
|---|---|---|---|
| `pageContextId` | `string` (min length 1) | Yes | Page context ID returned by bc_open_page. |
| `section` | `string` | No | sectionId to refresh. Defaults to "header". Examples: "lines" (document line items), "factbox:Customer Statistics" (FactBox). Listed in the bc_open_page sections array. |
| `tab` | `string` | No | Tab name to filter header fields by (e.g., "General", "Invoice Details", "Shipping and Billing"). Omit to return all header fields. |
| `group` | `string` | No | Restrict returned card fields to those inside the group with this caption (e.g. "Bill-to", "Ship-to"). Use to disambiguate documents whose Sell-to/Bill-to/Ship-to groups repeat captions like "Name"/"Address"/"City". Each returned field also carries its own "group" and "controlPath". |
| `filters` | `Array<{ column: string; value: string }>` | No | Server-side filters to apply before reading. Multiple filters combine with AND logic. (`column`: Column caption name to filter on, e.g. "City", "No."; `value`: Filter value — supports exact match "London", ranges "10000..20000", wildcards "\*consulting\*", expressions ">1000".) |
| `columns` | `string[]` | No | Column caption names to include in results. Omit to return all columns. Reduces output size. |
| `range` | `{ offset: number; limit: number }` | No | Slice a subset of repeater rows. Returns rows[offset..offset+limit]. Use with totalRowCount for pagination. (`offset`: 0-based starting row index; `limit`: maximum number of rows to return.) |

## Output
On success the operation returns a `ReadDataOutput`:

```
{ section: Section }
```

`Section` (from `src/protocol/section-dto.ts`):

| Field | Type | Notes |
|---|---|---|
| `sectionId` | `string` | The resolved section id (e.g. `"header"`, `"lines"`, `"factbox:Customer Statistics"`). |
| `kind` | `'header' \| 'lines' \| 'factbox' \| 'requestPage' \| 'subpage'` | Section shape classification. |
| `caption` | `string` | Section caption. |
| `fields?` | `SectionField[]` | Present on card-shape sections; visible, captioned fields only. |
| `rows?` | `SectionRow[]` | Present on list-shape sections (sections backed by a repeater). |
| `totalRowCount?` | `number \| null` | BC's TotalRowCount for the repeater; `null` when unknown. Present only with `rows`. |
| `actions?` | `SectionAction[]` | Populated only for `header` sections (actions are reachable only from the root form). |
| `cues?` | `SectionCue[]` | Present when the section's form contains cuegroup tiles. |

`SectionField`:
- `name: string` — field caption (display label).
- `controlPath: string` — stable control path (e.g. `"server:c[4]/c[1]/c[1]/c[0]"`); unique even when captions collide. Can be passed back as the field key to `bc_write_data` / `bc_read_data`.
- `group?: string` — caption of the innermost enclosing group (e.g. "Bill-to"); present only when the field sits inside one.
- `value?: string` — display string; undefined when the field has no string projection.
- `editable: boolean | 'unknown'` — tri-state editability; `"unknown"` means BC has not emitted an Editable flag (do not treat as read-only).
- `type: FieldType` — wire-level BC field type: `'sc' | 'dc' | 'bc' | 'dtc' | 'i32c' | 'sec' | 'pc' | 'ssc'`.
- `showMandatory?: true` — present only when BC marked the field mandatory.
- `isLookup?: true` — present only when the field has an AssistEdit/Lookup action.

`SectionRow` (`= RepeaterRow`):
- `bookmark: string` — stable row identifier; pass to `bc_write_data` / `bc_execute_action` / `bc_navigate` to target the row.
- `cells: Record<string, unknown>` — one entry per column. In this output path keys are the **column display captions** (duplicate captions get an ordinal suffix like `"Name#2"`), and each value is flattened to the cell's `stringValue`, else `objectValue`, else `null` (not the raw BC cell object).

`SectionAction` (header only): `{ name: string; systemAction: number; enabled: boolean; wizardNav?: 'back' | 'next' | 'finish' | 'cancel' }` — `systemAction` is the SystemAction ordinal (0 = custom AL action).

`SectionCue`: `{ name: string; value: string; groupCaption?: string; synopsis?: string; hasAction: boolean }` — `name` is the cue identifier for `bc_execute_action`; `value` may be empty until LoadForm populates it.

On failure the operation returns a `ProtocolError`:
- `Page context not found: <id>` — the `pageContextId` is unknown (checked before any service call, and re-checked after filtering/scrolling).
- `Section '<id>' not found.` — with `availableSections` listing the valid section ids in the context.

## Examples

Refresh the header of an open page:
```json
{ "pageContextId": "session:page:1" }
```
Response shape:
```json
{
  "section": {
    "sectionId": "header",
    "kind": "header",
    "caption": "Customer Card",
    "fields": [
      { "name": "No.", "controlPath": "server:c[4]/c[0]/c[0]", "value": "10000", "editable": false, "type": "sc" },
      { "name": "Name", "controlPath": "server:c[4]/c[0]/c[1]", "value": "Adatum Corporation", "editable": true, "type": "sc", "showMandatory": true }
    ],
    "actions": [
      { "name": "Post", "systemAction": 0, "enabled": true }
    ]
  }
}
```

Filter and paginate a list-shape section:
```json
{
  "pageContextId": "session:page:1",
  "filters": [{ "column": "City", "value": "London" }],
  "columns": ["No.", "Name", "City"],
  "range": { "offset": 0, "limit": 20 }
}
```
Response shape:
```json
{
  "section": {
    "sectionId": "header",
    "kind": "header",
    "caption": "Customer List",
    "rows": [
      { "bookmark": "1B_Eg...", "cells": { "No.": "20000", "Name": "Selangorian Ltd.", "City": "London" } }
    ],
    "totalRowCount": 3
  }
}
```

Read document lines (list section on a Document page):
```json
{ "pageContextId": "session:page:1", "section": "lines" }
```

Read one FactBox card and restrict the fields to disambiguate a repeating group:
```json
{ "pageContextId": "session:page:1", "section": "header", "group": "Bill-to", "tab": "Shipping and Billing" }
```

## Notes & limitations
- `section` defaults to `"header"` when omitted.
- `filters` are applied server-side via the filter service before the section is projected; they only affect list-shape sections. Multiple filters combine with AND.
- `range` triggers actual row materialization: the operation scrolls the repeater one page at a time until `offset + limit` rows are loaded or `totalRowCount` is reached, then slices `rows[offset .. offset+limit]`. `columns`, `tab`, and `group` narrowing happen in-process after projection and do not fetch data.
- After applying filters / scrolling, the page context is re-fetched from the repository before `buildSection`, because the repo replaces the context entry on every event-induced update (immutable updates with structural sharing) — using a stale context would project pre-filter/pre-scroll state.
- `tab` filtering matches header fields against the named tab's field captions (case-insensitive); if the tab can't be resolved, all fields are returned unchanged.
- `group` filtering keeps only card fields whose nearest enclosing group caption matches (case-insensitive, trimmed).
- `columns` matches card fields by caption OR by exact `controlPath`, and list cells by caption key (case-insensitive).
- Row `cells` are keyed by display caption and the value is the flattened display string (or raw value, or `null`) — not BC's full cell object. The `SectionRow`/`RepeaterRow` type comment describing binder-name keys reflects the internal representation, not this tool's emitted output.

## Related tools
- [bc_open_page](./bc_open_page.md)
- [bc_write_data](./bc_write_data.md)
- [bc_execute_action](./bc_execute_action.md)
- [bc_navigate](./bc_navigate.md)
- [bc_close_page](./bc_close_page.md)
