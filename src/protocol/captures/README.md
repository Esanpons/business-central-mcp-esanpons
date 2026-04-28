# Wire-format captures

Frozen wire payloads used as test fixtures. Each file is sanitised: any session
keys / IDs replaced with `"REDACTED"`. Captured via `scripts/capture-tell-me.ts`.

## Files

| File | Source | Date |
|---|---|---|
| `tell-me-result-2026-04-28.json` | BC28, `BC_PROFILE="BUSINESS MANAGER"`, Tell Me query `customer` | 2026-04-28 |

## Tell Me wire shape (verified 2026-04-28 against BC28 BUSINESS MANAGER profile)

### Form structure

`SystemAction.PageSearch=220` opens the Tell Me search form as a regular
`FormCreated` event (NOT a `DialogToShow` — Tell Me is non-modal on BC28). The
form caption is `"Tell me what you want to do"`, with `MappingHint:
"PageSearchForm"` and `Name: "PageSearchForm"`.

The search form's children are:

```
server:c[0]   gc (container)
server:c[0]/c[0]   sc (text input, the actual search field)   <-- SaveValue here
server:c[1]   rc (primary results repeater — pages and lists)
server:c[2]   rc (secondary results repeater — reports and other run-targets)
```

**Critical:** the search input is at `server:c[0]/c[0]`, NOT `server:c[0]`.
SaveValue against the gc container at `server:c[0]` returns `InvokeCompleted`
only — no `DataLoaded`, no rows. This is the limits.md #5 root cause for the
default-profile env: the SearchService was sending against the wrong path.

### Result row shape

After SaveValue with the actual query, BC emits TWO DataLoaded streams (one
per repeater) plus surrounding PropertyChanged events:

1. `PropertyChanged { controlPath: server:c[0]/c[0], changes: { StringValue: <query> } }` — echoes the search input.
2. `PropertyChanged { controlPath: server:c[1], changes: { 'Data.CurrentBookmark': <uuid> } }` — selects the first hit in the primary list.
3. `DataLoaded { controlPath: server:c[1], rows: [...] }` — primary results (typically pages/lists).
4. `DataLoaded { controlPath: server:c[2], rows: [...] }` — secondary results (reports and other categories).

Both DataLoaded events use the same row schema (named cells, see below). The
extractor walks every DataLoaded in the response and merges results — the
caller doesn't need to know about the two-stream split. In the captured
fixture, c[1] yields 23 rows and c[2] yields 32 rows for query `customer`,
totaling 55 results.

Each row follows the standard wire shape (`DataRowInserted: [index, payload]`)
with these named cells:

```json
{
  "Icon":                       { "type": "image", "source": "Resources/Images/static/transparentIcon.gif" },
  "Name":                       { "stringValue": "Customer List", "canInvoke": true },
  "DepartmentPath":             { "stringValue": "Departments/Financial Management/Receivables" },
  "DepartmentCategory":         { "stringValue": "Lists" },
  "SearchScore":                { "stringValue": "9" },
  "AdditionalSearchTermMatched": { "stringValue": "False" },
  "IsBookmarked":               { "stringValue": "False", "canInvoke": true },
  "CacheKey":                   {},
  "Source":                     { "stringValue": "[{ \"page\": \"Customer List\"}]" },
  "Description":                {}
}
```

Cells are KEYED by name (not positional binders like generic repeaters). The
column-header schema is published in `FormCreated.controlTree.Children[1].Columns`
under `Name` (e.g. `"Name"`, `"DepartmentPath"`, `"Source"`).

### Source format and run-target extraction

The `Source.stringValue` is a JSON-encoded string with one element shaped as
`[{ <objectType>: <objectName> }]`. Observed object types in this capture:

| Object type | Examples |
|---|---|
| `page` | `Customer List`, `Customer Card`, `Cash Receipt Journal`, ... |
| `report` | `Create Customer Journal Lines`, `Shpfy Sync Customers` |

BC's Tell Me identifies pages by **name** (the AL `name` property of the page
object), not by the numeric page ID. So a Tell Me result for "Customer List"
produces `Source: '[{"page": "Customer List"}]'`, not `'[{"page": "22"}]'`.

The extractor (`src/services/tell-me-extractor.ts`) parses this JSON and
returns:

```ts
{
  name: cells.Name.stringValue,           // "Customer List"
  objectType: 'page' | 'report' | ...,    // from Source key
  runTarget: '<objectName>',              // from Source value, e.g. "Customer List"
  departmentPath: cells.DepartmentPath.stringValue,
  category: cells.DepartmentCategory.stringValue,  // "Lists" / "Tasks" / ...
  score: parseInt(cells.SearchScore.stringValue, 10),
}
```

### How callers use the result

`bc_open_page` currently takes a numeric `pageId`. To open a Tell Me hit,
callers need to map name → id. Options:

1. The user already knows the page id (most common case, hardcoded reference tables).
2. A future enhancement to `bc_open_page` could accept either a numeric id or a
   page name and resolve via BC's metadata service. Out of scope for Plan D.
3. The `bc_search_pages` result documents the run-target name; the LLM can
   often infer the numeric id from the name + context, or open the page via
   the role center / navigation.

Plan D's contract: `SearchResult` carries `name` (display) and `runTarget`
(BC page/report name). The MCP user gets enough information to either know
which page to open by id or to ask BC for the metadata.
