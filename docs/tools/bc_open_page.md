# bc_open_page

> Opens a Business Central page by its numeric ID and returns its complete state as an ordered list of sections, together with the `pageContextId` that every other `bc_` tool needs.

## What it does

Opens a BC page over the WebSocket client protocol and materializes its current server-side state into a flat, ordered list of `Section` DTOs (header, lines, subpages, factboxes, requestPage). It returns a `pageContextId` that identifies the open page and is the required input for `bc_read_data`, `bc_write_data`, `bc_execute_action`, `bc_close_page`, etc. The header section adapts to the page type — card-shape (with `fields[]`) on Card/Document pages, list-shape (with `rows[]`) on List pages — but its `kind` stays `"header"` for path stability. Optional payload controls (`sections`, `summary`, `tab`, `columns`, `range`) let the caller narrow the response at open time so large documents do not overflow the token budget.

## When to use / when NOT to use

Use it as the entry point for every BC operation: it is the only tool that produces a `pageContextId`. Use it when you know (or have looked up via `bc_search_pages`) the numeric page ID of the entity you want, optionally with a `bookmark` to land on a specific record. For a large page (e.g. Sales Quote = 41), call it first with `summary: true` to discover the sections, then pull each one with `bc_read_data`.

Do NOT call it if the page is already open — reuse the existing `pageContextId` instead. Do NOT use it to refresh, filter, or paginate a section of an already-open page (use `bc_read_data`). It will reject IDs that are not directly openable standalone pages: a part / sub-object (e.g. a list-part) raises `PageNotMaterializedError`, and a standalone `CardPart` that BC returns as a placeholder shell raises `CardPartStubError` — open the host page instead.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `pageId` | string \| number (coerced to trimmed string) | Yes | Numeric BC page ID (e.g., 22 for Customer List, 21 for Customer Card). Use bc_search_pages to find IDs. |
| `bookmark` | string | No | Open the page to a specific record. Bookmarks come from list row results in bc_open_page or bc_read_data. |
| `tenantId` | string | No | BC tenant ID. Defaults to the server-configured tenant. Only needed in multi-tenant deployments. |
| `sections` | string[] | No | Only return these sectionIds (e.g. ["header"]). Use to avoid pulling every line and factbox of a big document. Omit for all sections. |
| `summary` | boolean | No | Return only sectionId/kind/caption (+totalRowCount) per section, with no fields/rows. Best first call on a large page (e.g. page 41 Sales Quote): discover the sections, then pull each with bc_read_data. Avoids token-limit overflows. |
| `tab` | string | No | Filter header fields to a tab (e.g. "General", "Shipping and Billing"). Applies to the header section only. |
| `columns` | string[] | No | Keep only these fields/columns (by caption or controlPath) across all returned sections. Reduces output size. |
| `range` | `{ offset: number; limit: number }` | No | Slice already-loaded repeater rows. `offset` is the 0-based starting row index; `limit` is the maximum number of rows to return. For deep pagination use bc_read_data (which scrolls to load more). |

Note: `pageId` accepts a string or a number; the schema coerces it to a trimmed string before use.

## Output

Returns `OpenPageOutput` (`src/operations/open-page.ts`):

| Field | Type | Description |
|---|---|---|
| `pageContextId` | string | Identifier for the open page; required input for every other `bc_` tool. |
| `pageType` | string | BC PageType enum string (e.g. `Card`, `List`, `Document`, `RoleCenter`, `CardPart`). |
| `caption` | string | Page caption; falls back to the root form id when BC reports no caption. |
| `isModal` | boolean | True when the page opened as a modal (wizard, request page, confirmation). |
| `sections` | `Section[]` | Every visible page section in canonical order: header, lines, subpages, factboxes, requestPage. |

Each `Section` (`src/protocol/section-dto.ts`):

| Field | Type | Description |
|---|---|---|
| `sectionId` | string | Stable section identifier (e.g. `"header"`, `"lines"`, `"factbox:Customer Statistics"`). Pass to `bc_read_data` / `bc_write_data` as `section`. |
| `kind` | `'header' \| 'lines' \| 'factbox' \| 'requestPage' \| 'subpage'` | Section role (`SectionKind`). |
| `caption` | string | Section caption. |
| `fields?` | `SectionField[]` | Present on card-shape sections (header, factbox, requestPage, most subpages). Only visible, captioned fields are included. |
| `rows?` | `SectionRow[]` | Present on list-shape sections (lines, list-bodied headers, repeater subpages). |
| `totalRowCount?` | number \| null | BC's TotalRowCount for the repeater; `null` when unknown. |
| `actions?` | `SectionAction[]` | Present on header sections only (actions are reachable only from the root form). |
| `cues?` | `SectionCue[]` | Present when the section's form contains cuegroup tiles. |

`SectionField`:

| Field | Type | Description |
|---|---|---|
| `name` | string | Field caption (display label only). |
| `controlPath` | string | Stable control path (e.g. `"server:c[4]/c[1]/c[1]/c[0]"`), unique even when captions collide. Pass it back as the field key to `bc_write_data` / `bc_read_data` to target this exact control. |
| `group?` | string | Caption of the innermost enclosing group (e.g. `"Bill-to"`, `"Ship-to"`); disambiguates duplicate captions. |
| `value?` | string | Display string. Undefined for fields with no string projection (e.g. boolean tristate). |
| `editable` | `boolean \| 'unknown'` | Tri-state editability. `"unknown"` means BC has not (yet) emitted an Editable flag — do NOT treat it as read-only; option controls (Ship-to / Bill-to) frequently arrive `"unknown"` yet are writable. After a write, trust `bc_write_data`'s `changed` flag over this hint. |
| `type` | `FieldType` | Wire-level BC field type. |
| `showMandatory?` | true | Present only when BC marked the field mandatory. |
| `isLookup?` | true | Present only when the field has an AssistEdit/Lookup action attached. |

`SectionAction`: `name` (string caption), `systemAction` (number; SystemAction ordinal, 0 = custom AL action), `enabled` (boolean), `wizardNav?` (`'back' | 'next' | 'finish' | 'cancel'`).

`SectionRow` (alias of internal `RepeaterRow`): `bookmark` (string) plus `cells` keyed by the column binder name (e.g. `"1165569367_c2"`), not by caption. When `columns` is applied, row cells are filtered by their caption key.

`SectionCue`: `name` (cue caption, used as the cue id for `bc_execute_action`), `value` (count, may be empty before LoadForm populates it), `groupCaption?`, `synopsis?` (AL tooltip), `hasAction` (boolean drill-down support).

In `summary` mode, every section is reduced to `{ sectionId, kind, caption }` plus `totalRowCount` when known — no `fields`/`rows`/`actions`/`cues`.

## Examples

Open a List page:

```json
{ "pageId": 22 }
```

Response shape (Customer List — list-shape header, no `fields[]`):

```json
{
  "pageContextId": "session:page:1",
  "pageType": "List",
  "caption": "Customers",
  "isModal": false,
  "sections": [
    {
      "sectionId": "header",
      "kind": "header",
      "caption": "Customers",
      "rows": [
        { "bookmark": "...", "cells": { "No.": "10000", "Name": "Adatum Corporation", "City": "Atlanta" } }
      ],
      "totalRowCount": 22,
      "actions": [ { "name": "New", "systemAction": 10, "enabled": true } ]
    }
  ]
}
```

Open a Card page to a specific record:

```json
{ "pageId": 21, "bookmark": "21;GoQAAAJ7..." }
```

Response shape (Customer Card — card-shape header plus a FactBox):

```json
{
  "pageContextId": "session:page:2",
  "pageType": "Card",
  "caption": "Adatum Corporation",
  "isModal": false,
  "sections": [
    {
      "sectionId": "header",
      "kind": "header",
      "caption": "Adatum Corporation",
      "fields": [
        { "name": "No.", "controlPath": "server:c[0]/c[1]/c[0]", "value": "10000", "editable": false, "type": "code" },
        { "name": "Name", "controlPath": "server:c[0]/c[1]/c[1]", "value": "Adatum Corporation", "editable": true, "type": "text", "showMandatory": true }
      ],
      "actions": [ { "name": "Edit", "systemAction": 40, "enabled": true } ]
    },
    {
      "sectionId": "factbox:Customer Statistics",
      "kind": "factbox",
      "caption": "Customer Statistics",
      "fields": [ { "name": "Balance (LCY)", "controlPath": "server:c[1]/c[0]", "value": "1,234.00", "editable": false, "type": "decimal" } ]
    }
  ]
}
```

Discover the sections of a large document without pulling field/row data:

```json
{ "pageId": 41, "summary": true }
```

Response shape (identity only):

```json
{
  "pageContextId": "session:page:3",
  "pageType": "Document",
  "caption": "Sales Quote",
  "isModal": false,
  "sections": [
    { "sectionId": "header", "kind": "header", "caption": "General" },
    { "sectionId": "lines", "kind": "lines", "caption": "Lines", "totalRowCount": 12 },
    { "sectionId": "factbox:Sell-to Customer Sales History", "kind": "factbox", "caption": "Sell-to Customer Sales History" }
  ]
}
```

## Notes & limitations

- Sections are always returned in canonical order: `header`, `lines`, `subpage`, `factbox`, `requestPage`.
- Payload-narrowing controls compose. `sections` filters which sections survive (case-insensitive on `sectionId`). `summary` short-circuits all per-field work and is mutually superseding: when `summary: true`, `tab`/`columns`/`range` are NOT applied. When `summary` is falsy, `tab` (header card fields only), then `columns`, then `range` are applied in that order.
- `tab` filters the header (root form) card fields by tab caption (case-insensitive); it has no effect on list-shape headers or other sections, and is silently ignored if no tab matches.
- `range` only slices rows already loaded for the page — it does not scroll BC to fetch more. Use `bc_read_data` for deep pagination (it scrolls to load additional rows).
- `columns` matches card fields by caption OR by `controlPath` (so a duplicate-caption field can be pinned exactly) and matches list row cells by caption key; all matching is case-insensitive.
- Error — `PageNotMaterializedError` (code `PAGE_NOT_MATERIALIZED`): the page opened but exposed no usable sections, BC returned an `Unknown` pageType, or BC opened a dialog/modal instead of a standalone page. Context carries `pageId`, `pageType`, `caption`, `isModal`, and a human-readable `reason`. Common cause: the id is a part / sub-object rather than a directly openable standalone page, or opening it triggered a modal to be handled with `bc_respond_dialog`.
- Error — `CardPartStubError` (code `CARDPART_STUB`): the id is a `CardPart` and BC returned a placeholder shell (detection: `pageType === 'CardPart'` AND zero captioned root fields AND zero cue tiles — cue-only CardParts like Activities are NOT stubs and pass through). Context carries `pageId` and a `hostHint` telling the caller to open the Role Center or host page that embeds the part and read the corresponding subpage section.
- Field/value caveats: `editable: "unknown"` does not mean read-only; trust `bc_write_data`'s `changed` flag after a write. `value` may be absent for fields with no string projection. Cue `value` may be empty until BC's `LoadForm` populates it.
- Document pages with both a header and a lines repeater are a known architectural limitation — drilling down from document list pages may target the wrong repeater's bookmarks (see CLAUDE.md "Document Pages (Multi-Repeater)").

## Related tools

- [bc_search_pages](./bc_search_pages.md) — find the numeric page ID before opening.
- [bc_read_data](./bc_read_data.md) — refresh / filter / paginate a single section on an already-open page.
- [bc_write_data](./bc_write_data.md) — edit fields in a section using caption or `controlPath` keys.
- [bc_execute_action](./bc_execute_action.md) — invoke actions and cue drill-downs.
- [bc_respond_dialog](./bc_respond_dialog.md) — handle modal dialogs surfaced by `PageNotMaterializedError`.
- [bc_close_page](./bc_close_page.md) — release the `pageContextId` when done.
