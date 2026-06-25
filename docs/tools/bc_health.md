# bc_health

> Reports the bc-ws MCP server's own health and diagnostics — connection status, active company/tenant/version, open forms, modal depth, and lightweight metrics — without requiring a live BC session.

## What it does

`bc_health` returns the operational status of the MCP server itself rather than any business data. It reads whatever session the `SessionManager` currently holds (which may be `null`), reporting `status: "connected"` only when a session exists and is alive, otherwise `"disconnected"`. It also surfaces the configured BC target (base URL, tenant, application id, server major, client version) and an in-memory metrics snapshot (invocations, errors by code, reconnects, session uptime). The operation has no side effects and never opens or touches a BC page.

## When to use / when NOT to use

Use it to answer "are you connected to BC?", to diagnose why other `bc_` tools are failing (e.g. confirm the session died or BC is unreachable), or to confirm which company/tenant/version/applicationId you are talking to. Because it bypasses the `ensureSession()` gate in both server entrypoints, it is the one tool that still answers when BC is down — making it the right first call when other tools time out or error.

Do NOT use it for business data: it returns server/session status and counters only, never records, fields, or page content. For business reads use `bc_open_page` / `bc_read_data`.

## Parameters

`HealthSchema` is `z.object({})` — the tool takes no parameters.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | The input schema is an empty object; pass `{}` (or no arguments). |

## Output

Returns `HealthOutput` (`src/operations/health.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `status` | `'connected' \| 'disconnected'` | `"connected"` only when a session exists and `isAlive`; otherwise `"disconnected"`. |
| `version` | `string` | MCP server version (currently the hard-coded `"2.0.0"`). |
| `bc` | object | Configured BC target (from `BCConfig`). |
| `bc.baseUrl` | `string` | Configured BC base URL (e.g. `https://devel1/BC`). |
| `bc.tenantId` | `string` | Configured tenant id (e.g. `default`). |
| `bc.applicationId` | `string` | OpenSession `applicationId` (e.g. `NAV`). |
| `bc.serverMajor` | `number` | Configured BC server major version (e.g. `27`). |
| `bc.clientVersion` | `string` | Configured client version string (`BCConfig.clientVersionString`, e.g. `27.0.0.0`). |
| `session` | `null \| object` | `null` when no session is held; otherwise the session snapshot below. |
| `session.alive` | `boolean` | `BCSession.isAlive`. |
| `session.initialized` | `boolean` | `BCSession.isInitialized` (OpenSession handshake completed). |
| `session.company` | `string` | Current company name (`BCSession.companyName`). |
| `session.openForms` | `number` | Count of open form ids (`openFormIds.size`). |
| `session.modalDepth` | `number` | Depth of the modal stack (`modalStackSnapshot().length`). |
| `metrics` | `MetricsSnapshot` | In-memory diagnostics snapshot below. |

`MetricsSnapshot` (`src/services/metrics.ts`) — counters are in-memory and reset on process restart:

| Field | Type | Description |
|-------|------|-------------|
| `invokes` | `number` | Total tool invocations recorded at the MCP handler boundary. |
| `errors` | `number` | Total errors recorded. |
| `errorsByCode` | `Record<string, number>` | Error counts keyed by error code. |
| `reconnects` | `number` | Number of session reconnects performed. |
| `sessionsCreated` | `number` | Number of sessions created. |
| `sessionCreatedAt` | `number \| null` | Epoch ms when the current session was established, or `null`. |
| `sessionUptimeSeconds` | `number \| null` | Seconds since the current session was established (rounded), or `null`. |
| `lastError` | `string \| null` | Message of the last recorded error, or `null`. |

## Examples

**Check connectivity (connected):**

```json
{ "name": "bc_health", "arguments": {} }
```

Expected response shape:

```json
{
  "status": "connected",
  "version": "2.0.0",
  "bc": {
    "baseUrl": "https://devel1/BC",
    "tenantId": "default",
    "applicationId": "NAV",
    "serverMajor": 27,
    "clientVersion": "27.0.0.0"
  },
  "session": {
    "alive": true,
    "initialized": true,
    "company": "CRONUS",
    "openForms": 2,
    "modalDepth": 0
  },
  "metrics": {
    "invokes": 14,
    "errors": 1,
    "errorsByCode": { "SESSION_LOST": 1 },
    "reconnects": 1,
    "sessionsCreated": 2,
    "sessionCreatedAt": 1750000000000,
    "sessionUptimeSeconds": 312,
    "lastError": "Session was lost; reconnecting"
  }
}
```

**Diagnose a failure when BC is unreachable (disconnected):**

```json
{ "name": "bc_health", "arguments": {} }
```

Expected response shape (note `session: null` and `status: "disconnected"`):

```json
{
  "status": "disconnected",
  "version": "2.0.0",
  "bc": {
    "baseUrl": "https://devel1/BC",
    "tenantId": "default",
    "applicationId": "NAV",
    "serverMajor": 27,
    "clientVersion": "27.0.0.0"
  },
  "session": null,
  "metrics": {
    "invokes": 0,
    "errors": 0,
    "errorsByCode": {},
    "reconnects": 0,
    "sessionsCreated": 0,
    "sessionCreatedAt": null,
    "sessionUptimeSeconds": null,
    "lastError": null
  }
}
```

## Notes & limitations

- **Bypasses the session gate.** Unlike every other `bc_` tool, `bc_health` is wired into both server entrypoints to skip `ensureSession()`, so it never tries to (re)connect and always returns — even mid-outage. This is what makes it safe to call as a first diagnostic.
- **No side effects.** It reads the current session reference and a metrics snapshot only; it never opens forms, invokes BC actions, or triggers reconnection.
- **Metrics are in-memory and process-scoped.** All counters (`invokes`, `errors`, `reconnects`, `sessionsCreated`, `lastError`, etc.) reset to zero/`null` on server restart and are not persisted.
- **`status` reflects liveness, not just presence.** A held-but-dead session still reports `status: "disconnected"` (the check is `s && s.isAlive`), while `session` is non-`null` whenever a session object exists regardless of its `alive` flag.
- **`version` is hard-coded** to `"2.0.0"` in the operation; `bc.clientVersion` comes from `BCConfig.clientVersionString` (env `BC_CLIENT_VERSION`, default `27.0.0.0`) and is distinct from the server version.
- **Same shape over HTTP.** The HTTP `/health` endpoint returns the same `HealthOutput` structure.

## Related tools

- [bc_list_companies](./bc_list_companies.md)
- [bc_open_page](./bc_open_page.md)
- [bc_read_data](./bc_read_data.md)
- [bc_find_object](./bc_find_object.md)
