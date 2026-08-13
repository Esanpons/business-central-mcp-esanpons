# bc_switch_company
> Switch the current Business Central session to a different company, resetting all server-side page state.

## What it does
Switches the active company by **re-opening the BC session on it**, and confirms the result against what Business Central itself reports.

A BC session is BOUND to its company when it opens: `OpenSession` takes a `company`, and the company the server grants comes back as `CompanyName` in its response. Nothing you send to a live session moves it. So this tool closes the current session, opens a new one on the target company, and compares what BC granted with what you asked for. If they differ, the call FAILS -- it never returns a success-shaped result for a switch that did not happen.

That also means the session is genuinely new: every open page dies with the old one, so the tool returns the `pageContextId`s that were invalidated and you must re-open anything you still need. Expect the call to take a couple of seconds (it is a reconnect).

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
| `newCompany` | `string` | The company **BC granted**, read back from its `OpenSession` response -- NOT an echo of your input. |
| `invalidatedPageContextIds` | `string[]` | The `pageContextId`s that were open before the switch. They died with the old session; re-open what you need. |
| `sessionReopened` | `boolean` | Always `true`: the switch is a session re-open. Present so a caller can tell this apart from a cheaper mechanism if one is ever added. |

The operation returns a `Result<SwitchCompanyOutput, ProtocolError>`. Two failure modes, both of which throw rather than return a tidy-looking result:

- **BC granted a different company** (usually a misspelt name): a `SessionLostError` naming what BC gave you instead. The old session is gone either way -- re-open your pages.
- **The new session could not be created** (BC unreachable, credentials rejected, Entra session expired on SaaS): the underlying reason is carried in the error message.

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
  "invalidatedPageContextIds": [],
  "sessionReopened": true
}
```

An empty `invalidatedPageContextIds` means **no pages were open**, nothing more. It is not evidence about whether the switch worked -- `newCompany` is, because it comes from BC.

## Notes & limitations
- **Matching ignores case and surrounding spaces**, as BC resolves company names. `"  jbc japan "` matches `JBC JAPAN`. Everything else must be the company NAME, not its display name -- `bc_list_companies` returns both.
- **The live-session action does not work, and this is why the tool changed.** Measured on BC27: `InvokeSessionAction { systemAction: 500 }` on an open session is answered with a bare `InvokeCompleted` and a few unrelated `PropertyChanged` -- no `SessionSettingsChanged`, no company name -- and the data keeps coming from the previous company. The previous implementation sent it and then wrote the REQUESTED name into the session, so this tool, `bc_health` and every screenshot deep link reported a switch that had not happened, and later reads silently came from the wrong company. It is still tried once as a cheap fallback when BC opens a session on an unexpected company, but its outcome is now judged on BC's answer instead of assumed.
- **Verifying a switch needs a company-specific value.** A test database whose companies are copies of one another (`CRONUS_01`..`CRONUS_04`) returns identical customer lists in all of them, so a customer list cannot tell you whether the switch worked. Company Information (page 1) can: its `Name` is the company.
- **A switch costs a reconnect.** The session, its WebSocket and every page context are replaced. Do not switch mid-workflow.
- The company the caller asked for is remembered, so a session recreated later (after a crash, a publish, a dropped connection) is re-opened on that company rather than on the server default.

## Related tools
- [bc_list_companies](./bc_list_companies.md) -- discover available company names and the active company before switching.
- [bc_open_page](./bc_open_page.md) -- re-open pages in the new company after switching (returns fresh `pageContextId`s).
- [bc_close_page](./bc_close_page.md) -- close pages explicitly; note a company switch also invalidates open pages.
- [bc_health](./bc_health.md) -- confirm the currently connected company/tenant/session status.
