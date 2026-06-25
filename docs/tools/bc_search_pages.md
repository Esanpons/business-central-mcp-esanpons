# bc_search_pages

> Searches BC's Tell Me index for pages, reports, codeunits, and other run-targets matching a keyword.

## What it does
Runs Business Central's built-in Tell Me search (SystemAction 220, PageSearch) for the given keyword and returns the matching run-targets. Each hit carries its display name, object kind, AL run-target name, and optional department path, category, and relevance score. Internally the `SearchService` opens the Tell Me form, primes it with an empty `SaveValue`, then submits the query against the search input (`server:c[0]/c[0]`) and extracts results from the resulting `DataLoaded` events. Because the Tell Me index is profile-scoped on the BC server, an empty result set comes back with an explanatory `note` instead of an error.

## When to use / when NOT to use
- Use when you do not know the page ID (or report ID) for an entity and want to discover it by keyword — search first, then resolve and open.
- Use to enumerate which pages/reports BC surfaces for a term (e.g. "customer", "sales order", "chart of accounts").
- Do NOT use to actually open a result: results are AL names, not numeric IDs. Open the target with `bc_open_page` using the known numeric page ID.
- Do NOT rely on it when the connected `BC_PROFILE` has an empty Tell Me index — it returns no rows (see Notes & limitations).

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` (min length 1) | Yes | Search term matching BC page names and keywords (e.g., "customer", "sales order", "chart of accounts"). Fuzzy matching supported. |

## Output
`SearchPagesOutput`:

| Field | Type | Description |
|-------|------|-------------|
| `results` | `SearchResult[]` | Matching run-targets from the Tell Me index. Empty array when nothing matched. |
| `note` | `string` (optional) | Present ONLY when `results` is empty. Explains the most likely cause (Tell Me is profile-scoped) and suggests setting `BC_PROFILE` or opening known page IDs directly. Absent when results were returned. |

Each `SearchResult` (from `src/services/search-service.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Display name of the page/report/etc. — what the BC web client shows. |
| `objectType` | `string` | Object kind: `'page'` \| `'report'` \| `'codeunit'` \| etc. Lowercase, per BC's wire format. |
| `runTarget` | `string` | AL object name BC uses to run the target (e.g. `"Customer List"`). |
| `departmentPath` | `string` (optional) | Department path, e.g. `"Departments/Financial Management/Receivables"`. |
| `category` | `string` (optional) | Category label, e.g. `"Lists"`, `"Tasks"`, `"Reports"`. |
| `score` | `number` (optional) | Search relevance score from BC. Higher = better match. |

## Examples

Search for customer-related objects:
```json
{ "query": "customer" }
```
Expected response shape:
```json
{
  "results": [
    {
      "name": "Customers",
      "objectType": "page",
      "runTarget": "Customer List",
      "departmentPath": "Departments/Sales & Marketing/Sales",
      "category": "Lists",
      "score": 9
    }
  ]
}
```

Search for a report:
```json
{ "query": "trial balance" }
```
Expected response shape:
```json
{
  "results": [
    {
      "name": "Trial Balance",
      "objectType": "report",
      "runTarget": "Trial Balance",
      "category": "Reports",
      "score": 7
    }
  ]
}
```

Empty result (profile-scoped index has no match):
```json
{ "query": "obscure entity" }
```
Response:
```json
{
  "results": [],
  "note": "No results. Tell Me is profile-scoped — set BC_PROFILE to a profile that includes the searched objects (e.g. BUSINESS MANAGER) and reconnect, or open known page IDs directly via bc_open_page."
}
```

## Notes & limitations
- **AL names, not numeric IDs.** BC's Tell Me identifies pages by AL object name (`runTarget` like `"Customer List"`), not by numeric ID. To open a result you still need the numeric page ID — pass it to `bc_open_page`, or resolve it via the role center / navigation tree.
- **Profile-scoped index.** Tell Me is scoped to the BC server profile. If the BC web client finds matches but this tool returns none, set the `BC_PROFILE` environment variable on bc-mcp's startup config to a profile that indexes the relevant objects (e.g. `BUSINESS MANAGER`, `ACCOUNTANT`, `SALES ORDER PROCESSOR`) and reconnect. The default profile may have an empty Tell Me index.
- **Empty-result handling is not an error.** When nothing matches, the call succeeds with `results: []` and a populated `note`; it does not raise a `ProtocolError`.
- **Failure modes.** If the Tell Me search form fails to open, the underlying service returns a `ProtocolError` ("Tell Me search form did not open"). Errors from the WebSocket invokes are propagated as `ProtocolError`.
- **Optional fields may be absent.** `departmentPath`, `category`, and `score` depend on what BC's Tell Me stream supplies for each row and may be omitted.

## Related tools
- [bc_open_page](./bc_open_page.md) — open a page by its numeric ID once you have resolved a search hit.
- [bc_navigate](./bc_navigate.md) — drill into a specific record on an open list/document page.
- [bc_run_report](./bc_run_report.md) — execute a report discovered via search.
- [bc_find_object](./bc_find_object.md) — resolve an object by id/name from the local object index.
