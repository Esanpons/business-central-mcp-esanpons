# bc_find_object

> Resolve a BC object name/caption/keyword (or numeric id) to its numeric Object ID by searching a cached local index — typically to obtain a page id before calling `bc_open_page`.

## What it does
Searches a cached, on-disk index of the environment's BC objects (standard + add-ins + custom) and returns matching objects with their numeric Object ID. The query is matched case-insensitively as a substring against each object's AL `name` and its localized `caption`, and also matches when the query equals an object's numeric id. Results are ranked (exact name/caption match first, then prefix match, then shortest name) and truncated to `limit`. It reads only from a cached JSON file (`object-index.json` in the server state dir) and does **not** hit the live BC session, so it is fast and side-effect free.

## When to use / when NOT to use
**Use it** when you need a page id (or any object id) before calling `bc_open_page` and you only know a name/caption/keyword — search by name, filter with `type: "Page"`, take the id, then open by id (ids are stable; resolving a name avoids guessing). Also use it to look up reports, tables, codeunits, etc., or to confirm which app owns an object.

**Do NOT use it** to read business data or page contents (use `bc_open_page` / `bc_read_data`). It cannot find an object that is not yet in the cached index — if it returns empty (or the index is stale after a deployment/upgrade), run `bc_refresh_objects` first. By default the index only covers custom/add-in objects (Object ID >= 50000); standard Microsoft objects require a full `bc_refresh_objects { all: true }`.

## Parameters
| Name | Type | Required | Description |
|---|---|---|---|
| `query` | `string` (min length 1) | Yes | Name/caption keyword or numeric ID to look up (e.g. "Customer List", "client", "22"). Matches Object Name and the localized Object Caption. |
| `type` | `string` | No | Filter by object type: "Page", "Report", "Table"/"TableData", "Codeunit", "Query", "XMLport", etc. Omit for any type. Use "Page" to find a page id to open with bc_open_page. |
| `limit` | `number` | No | Max results to return (default 25). |

Note on `type`: the filter is matched against a **canonicalized** English token, so `type: "Page"` works even in a non-English environment where the Object Type column renders as e.g. "Página". The canonicalizer (`canonType`) maps EN + ES spellings for page, pageextension, table, tabledata, tableextension, report, reportextension, codeunit, query, xmlport, enum, enumextension, permissionset(extension), profile, and controladdin; unknown tokens fall through unchanged (lowercased).

## Output
The operation always succeeds (returns `ok(...)`) and yields a `FindResult` object (from `src/services/object-index-service.ts`):

| Field | Type | Description |
|---|---|---|
| `query` | `string` | The original query string, echoed back verbatim. |
| `count` | `number` | Total number of matches found in the index (BEFORE the `limit` slice). |
| `results` | `BcObject[]` | The matched objects, ranked and truncated to `limit`. |
| `indexUpdatedAt` | `string \| null` | ISO timestamp of when the index was last refreshed, or `null` if the index has never been built. |
| `note` | `string` (optional) | Present only when the index is empty: advises running `bc_refresh_objects` first (default refreshes custom/add-in objects; `{ all: true }` for the full standard set). |

Each `BcObject` in `results` has:

| Field | Type | Description |
|---|---|---|
| `type` | `string` | Object type as stored from the index, e.g. "Page", "Report", "TableData", "Codeunit" (this is the value from page 9174's Object Type column, which may be localized). |
| `id` | `number` | The numeric Object ID. |
| `name` | `string` | The AL object name. |
| `caption` | `string` | The localized caption (in the BC user's language). |
| `app` | `string` | The owning app (e.g. "Base Application", or a custom/ISV app name). |

## Examples

Find pages related to "customer":
```json
{ "query": "customer", "type": "Page" }
```
Expected response shape:
```json
{
  "query": "customer",
  "count": 12,
  "results": [
    { "type": "Page", "id": 22, "name": "Customer List", "caption": "Customers", "app": "Base Application" },
    { "type": "Page", "id": 21, "name": "Customer Card", "caption": "Customer Card", "app": "Base Application" }
  ],
  "indexUpdatedAt": "2026-06-25T09:14:02.118Z"
}
```

Resolve a specific page name to its id (exact match ranks first):
```json
{ "query": "Customer List", "type": "Page" }
```
```json
{
  "query": "Customer List",
  "count": 1,
  "results": [
    { "type": "Page", "id": 22, "name": "Customer List", "caption": "Customers", "app": "Base Application" }
  ],
  "indexUpdatedAt": "2026-06-25T09:14:02.118Z"
}
```

Look up by numeric id (the query equals an object's id):
```json
{ "query": "9174" }
```
```json
{
  "query": "9174",
  "count": 1,
  "results": [
    { "type": "Page", "id": 9174, "name": "All Objects with Caption", "caption": "All Objects with Caption", "app": "Base Application" }
  ],
  "indexUpdatedAt": "2026-06-25T09:14:02.118Z"
}
```

Empty-index case (index never built):
```json
{
  "query": "customer",
  "count": 0,
  "results": [],
  "indexUpdatedAt": null,
  "note": "The object index is empty. Run bc_refresh_objects first (default refreshes custom/add-in objects; pass { all: true } for the full standard set)."
}
```

## Notes & limitations
- **Cache-only, no live BC read.** This tool reads from `object-index.json` (under the server's state directory). It never contacts BC, so freshness depends entirely on the last `bc_refresh_objects` run — check `indexUpdatedAt`.
- **Coverage depends on the refresh range.** The default `bc_refresh_objects` indexes only Object ID >= 50000 (custom + add-ins). Standard Microsoft objects are only present after `bc_refresh_objects { all: true }`. If a known standard page is missing, the index hasn't been fully built.
- **Matching is substring + case-insensitive** over `name` and `caption`, plus an exact numeric-id match. There is no fuzzy/typo tolerance and no wildcard syntax.
- **Ranking:** exact `name`/`caption` equality (rank 0) sorts before prefix match (rank 1) before everything else (rank 2); ties break by shorter `name`. `count` reflects all matches; `results` is sliced to `limit` (default 25).
- **`type` filtering is language-robust** via canonicalization, but only the EN/ES spellings enumerated in `canonType` are normalized; an unrecognized localized type token won't match `type: "Page"` and would need to be added to `TYPE_CANON`.
- The `BcObject.type` value returned in results is the raw (possibly localized) Object Type from page 9174, not the canonical token used internally for filtering.

## Related tools
- [bc_refresh_objects](./bc_refresh_objects.md) — builds/updates the cached index this tool searches; run it first (and after deployments/upgrades).
- [bc_open_page](./bc_open_page.md) — opens a page by numeric id; the typical consumer of the id returned here.
