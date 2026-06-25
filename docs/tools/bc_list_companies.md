# bc_list_companies

> List every company available in the current Business Central environment, together with the currently active company.

## What it does
Returns the set of companies defined in the connected Business Central environment plus the name of the company the session is currently working in. Internally it opens the BC **Companies** system page (page `357`), reads every row, then immediately closes the page again in a `finally` block so it leaves no page open and does not alter session state. Each row's company name is extracted as the first string-valued cell found on the row, and is reported as both `name` and `displayName`. The active company comes from the session's current-company accessor, not from the page data.

## When to use / when NOT to use
- **Use it** before `bc_switch_company` to discover the exact company names available and to confirm a target company exists (the switch requires an exact-match name). Also use it to find out which company you are currently connected to.
- **Do NOT use it** if you already know the company name — call `bc_switch_company` directly. It is not a data-reading tool for business records; to work with data in a specific company, call `bc_switch_company` and then `bc_open_page`.

## Parameters
This tool takes no parameters. Its Zod schema is `ListCompaniesSchema = z.object({})` (an empty object), and the registry wires `execute: () => ops.listCompanies.execute()` with no input.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. Pass an empty object `{}` (or nothing). |

## Output
On success the operation resolves to a `ListCompaniesOutput`:

| Field | Type | Description |
|-------|------|-------------|
| `currentCompany` | `string` | The name of the company the session is currently active in (from the session's current-company getter). |
| `companies` | `Array<{ name: string; displayName: string }>` | One entry per company defined in the environment. `name` is the company name read from the Companies page row; `displayName` is currently set to the same value as `name`. |

Notes on the shape, taken from the operation source:
- `companies` is built by mapping each read row to `{ name, displayName }` where the name is the first cell whose value is a `string`; if no string cell is found the name falls back to an empty string (`''`).
- The result is wrapped in the project's `Result` type; on failure it returns the `ProtocolError` from the underlying `openPage` or `readRows` step instead of the output above.

## Examples

Call (no arguments):
```json
{
  "name": "bc_list_companies",
  "arguments": {}
}
```

Expected response shape:
```json
{
  "currentCompany": "CRONUS International Ltd.",
  "companies": [
    { "name": "CRONUS International Ltd.", "displayName": "CRONUS International Ltd." },
    { "name": "My Company", "displayName": "My Company" }
  ]
}
```

Typical use before switching company:
```json
{
  "name": "bc_list_companies",
  "arguments": {}
}
```
Then, using a `name` from the returned `companies` array, call `bc_switch_company` with that exact value:
```json
{
  "name": "bc_switch_company",
  "arguments": { "companyName": "My Company" }
}
```

## Notes & limitations
- **No side effects on your session.** The Companies page is opened and closed internally; the close is in a `finally` (and its errors are swallowed via `.catch(() => {})`), so it does not affect your currently open pages or session state.
- **`displayName` duplicates `name`.** The operation does not currently read a separate display-name column — it sets `displayName` equal to `name`.
- **Name extraction is heuristic.** The company name is taken as the first string-valued cell in each row rather than a specifically-keyed column; rows with no string cell yield an empty name (`''`).
- **Active company source.** `currentCompany` is read from the session, not from the page, so it reflects the live session company even though it is reported alongside the page-derived list.
- **Failure propagation.** If opening page `357` or reading its rows fails, the original `ProtocolError` is returned and no `companies` list is produced.

## Related tools
- [bc_switch_company](./bc_switch_company.md) — switch the session to one of the listed companies (exact name match).
- [bc_open_page](./bc_open_page.md) — open a page to work with data after selecting a company.
- [bc_health](./bc_health.md) — reports the active company (among other session diagnostics) without opening any page.
