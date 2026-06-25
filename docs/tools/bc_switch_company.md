# bc_switch_company
> Switch the current Business Central session to a different company, resetting all server-side page state.

## What it does
Switches the active company for the current BC session by issuing the `ChangeCompany` system action (`InvokeSessionAction` with `systemAction: 500`) over the existing WebSocket connection. A company switch resets all server-side page state, so the operation clears every tracked page context locally and returns the list of `pageContextId`s that were invalidated. After this call succeeds, all subsequent data tools operate against the new company's data. The session itself (connection, credentials) is preserved -- only the company context changes.

## When to use / when NOT to use
Use it to move between companies in the same environment, for example after `bc_list_companies` confirms the exact target company name. Call `bc_list_companies` first to discover available names and verify the target exists, because `companyName` must be an exact match.

Do NOT switch companies in the middle of a multi-step workflow (e.g. between creating a Sales Order and posting it) -- finish all operations in the current company first, because the switch invalidates every open page. Do NOT reuse any prior `pageContextId` after switching; re-open pages with `bc_open_page` in the new company context.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `companyName` | `string` (min length 1) | Yes | Exact company name to switch to. Use bc_list_companies to see available company names. |

## Output
On success the operation returns a `SwitchCompanyOutput` object (defined in `src/operations/switch-company.ts`):

| Field | Type | Description |
|---|---|---|
| `previousCompany` | `string` | The company that was active before the switch (read from `session.companyName` at call time). |
| `newCompany` | `string` | The company switched to -- echoes the `companyName` input. |
| `invalidatedPageContextIds` | `string[]` | The `pageContextId`s that were open and have now been cleared/invalidated by the switch. These can no longer be used; re-open pages as needed. |

The operation returns a `Result<SwitchCompanyOutput, ProtocolError>`. If the underlying `InvokeSessionAction` invoke fails, the error `Result` is returned unchanged and no page contexts are cleared.

## Examples

Switch to a named company:
```json
{ "companyName": "CRONUS International Ltd." }
```
Expected response shape:
```json
{
  "previousCompany": "CRONUS USA, Inc.",
  "newCompany": "CRONUS International Ltd.",
  "invalidatedPageContextIds": ["session:page:1", "session:page:2"]
}
```

Switch when no pages are currently open:
```json
{ "companyName": "My Company" }
```
```json
{
  "previousCompany": "CRONUS International Ltd.",
  "newCompany": "My Company",
  "invalidatedPageContextIds": []
}
```

## Notes & limitations
- The switch is implemented as `InvokeSessionAction` with `systemAction: 500` (ChangeCompany) and a `company` named parameter, waiting for the `InvokeCompleted` event. This matches the documented BC protocol pattern for company switching.
- All page contexts are cleared via `repo.clearAll()` only after the invoke succeeds, so a failed switch leaves your open pages intact.
- `previousCompany` reflects the session's company name as known to bc-mcp at the moment of the call.
- The `company` named parameter sent to BC is the raw `companyName` input; an invalid or misspelled name will be rejected by the BC server rather than validated client-side. Verify names with `bc_list_companies` first.

## Related tools
- [bc_list_companies](./bc_list_companies.md) -- discover available company names and the active company before switching.
- [bc_open_page](./bc_open_page.md) -- re-open pages in the new company after switching (returns fresh `pageContextId`s).
- [bc_close_page](./bc_close_page.md) -- close pages explicitly; note a company switch also invalidates open pages.
- [bc_health](./bc_health.md) -- confirm the currently connected company/tenant/session status.
