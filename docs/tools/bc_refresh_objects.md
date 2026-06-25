# bc_refresh_objects
> Rebuilds the local cached object index (id + name + caption + app) that powers `bc_find_object`, by reading BC's "All Objects with Caption" system page (9174).

## What it does
Scans the BC "All Objects with Caption" system page (page `9174`) for a range of Object IDs and writes each object's type, id, name, caption, and app name to a local JSON file (`object-index.json` in the server state dir). It opens page 9174 repeatedly with an `'Object ID' IS 'lo..hi'` OpenForm filter, adaptively splitting any window that returns a near-full (`>= 45`) row count so no object type group is silently truncated, and merges the freshly read set into the existing index (replacing everything in the scanned range, which also drops deleted objects). The result is consumed offline by `bc_find_object`, which reads the cached JSON without hitting BC. With no arguments it refreshes only the custom + add-in space (Object ID `>= 50000`), which costs a handful of reads.

## When to use / when NOT to use
Use it once before the first `bc_find_object` lookup, and again whenever objects may have changed — e.g. after you or an ISV deploy/update an app (default custom/add-in refresh), or after a BC platform/app upgrade (`{ all: true }` full rebuild). Use `{ from, to }` to refresh a single add-in's Object ID range cheaply.

Do NOT call it on every lookup — the index is cached, so `bc_find_object` is fast and offline; only refresh when objects may have changed. Avoid `{ all: true }` unless necessary: it issues thousands of reads against BC and takes minutes. It requires a live BC session because it reads from BC.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from` | `number` | No | Start of the Object ID range to refresh (default 50000, i.e. custom + add-ins). |
| `to` | `number` | No | End of the Object ID range to refresh (default a very high value covering PTE 50000-99999 and high ISV/Microsoft ranges). |
| `all` | `boolean` | No | Refresh the FULL range including standard Microsoft objects (thousands of reads — slow, minutes). Use after a BC upgrade. Omit for the fast custom/add-in refresh. |

Defaults applied in the service: `from` defaults to `50000` (or `1` when `all: true`); `to` defaults to `99999999`. `all: true` overrides `from` to start at `1`.

## Output
On success the operation returns a `RefreshResult` object (`src/services/object-index-service.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `scanned` | `number` | Count of distinct objects collected from BC in this refresh (keyed by `Object Type` + `Object ID`). |
| `totalInIndex` | `number` | Total objects in the merged index file after the refresh (kept out-of-range objects + freshly scanned). |
| `range` | `{ from: number; to: number }` | The effective Object ID range that was scanned (after defaults / `all` were applied). |
| `reads` | `number` | Number of page-9174 reads issued (adaptive splitting can make this larger than the number of windows). |
| `updatedAt` | `string` | ISO-8601 timestamp written into the index file for this refresh. |

On failure the operation returns an error `Result` wrapping a `ProtocolError` with code `OBJECT_INDEX_ERROR` and the underlying error message (`src/operations/refresh-objects.ts`).

## Examples

Refresh the custom + add-in space (the daily driver):
```json
{}
```
Expected response shape:
```json
{
  "scanned": 312,
  "totalInIndex": 312,
  "range": { "from": 50000, "to": 99999999 },
  "reads": 9,
  "updatedAt": "2026-06-25T10:14:02.123Z"
}
```

Refresh one add-in's Object ID range:
```json
{ "from": 6175000, "to": 6175999 }
```
Expected response shape:
```json
{
  "scanned": 47,
  "totalInIndex": 359,
  "range": { "from": 6175000, "to": 6175999 },
  "reads": 2,
  "updatedAt": "2026-06-25T10:16:40.880Z"
}
```

Full rebuild including standard Microsoft objects (slow — minutes):
```json
{ "all": true }
```
Expected response shape:
```json
{
  "scanned": 41872,
  "totalInIndex": 41872,
  "range": { "from": 1, "to": 99999999 },
  "reads": 2103,
  "updatedAt": "2026-06-25T10:41:55.004Z"
}
```

## Notes & limitations
- **Source page.** Reads page `9174` ("All Objects with Caption"). Each row's `Object ID`, `Object Type`, `Object Name`, `Object Caption`, and `App Name` cells are stored. Rows whose `Object ID` is not numeric are skipped.
- **Adaptive chunking.** Page 9174 is sorted by (Object Type, Object ID) and only Object ID is filterable (its filter pane has no `columnBinderPath`, and an Object Type filter is ignored). A read returning `>= 45` rows is treated as possibly truncated, discarded, and re-read as two halves — this is why dense ranges (standard objects) cost many reads while sparse custom ranges cost few.
- **Merge semantics.** Objects with ID inside `[from, to]` are fully replaced by the freshly scanned set; objects outside the range are kept. This means a refresh of a range also removes objects that were deleted from BC within that range.
- **Safety cap.** A hard limit of `SAFETY_MAX_READS = 30000` page reads bounds a runaway scan.
- **Storage.** The index is a single JSON file `object-index.json` under the server state directory (created if missing). It records `updatedAt`, `baseUrl`, `tenantId`, and the `objects` array. A corrupt file is silently discarded and rebuilt.
- **Requires a live BC session** — unlike `bc_find_object`, which reads only the cached file.
- **Localized types.** The stored `Object Type` is whatever BC renders in the session language (e.g. "Página"). `bc_find_object` canonicalizes it for type filtering; the raw localized string is what is stored here.

## Related tools
- [./bc_find_object.md](./bc_find_object.md) — searches the cached index this tool builds (resolve a page name/keyword/id to an object), reading the JSON offline.
