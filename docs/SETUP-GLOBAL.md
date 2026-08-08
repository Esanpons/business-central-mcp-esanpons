# Global setup — make `bc-ws` available to every project

This registers the MCP **once at user scope** so any project you open in Claude Code (any
folder) can use it, without adding a `.mcp.json` per project. The server itself lives in **one**
fixed location — you do not copy it per project; you only point each client (or, here, the global
config) at its compiled entry point.

## Prerequisites

1. Build the server once (produces `dist/`):
   ```powershell
   cd "D:\Proyectos\Aesva\business-central-mcp-esanpons"
   npm install
   npm run build
   ```
2. Note the absolute path to the compiled entry point:
   ```
   D:\Proyectos\Aesva\business-central-mcp-esanpons\dist\stdio-server.js
   ```
   The folder must keep its `node_modules/` and `dist/`. If you move the folder, re-run the
   register command with the new path.

## Register globally (user scope)

`-s user` writes to your user-level config (`~/.claude.json`), so it applies in **every** folder.
`--` separates Claude's flags from the command Claude will spawn.

### PowerShell

```powershell
claude mcp add bc-ws -s user `
  -e BC_BASE_URL=https://devel1/BC `
  -e BC_USERNAME=admin `
  -e BC_PASSWORD=<password> `
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 `
  -e BC_TENANT_ID=default `
  -e BC_SERVER_MAJOR=27 `
  -e BC_APPLICATION_ID=NAV `
  -- node "D:\Proyectos\Aesva\business-central-mcp-esanpons\dist\stdio-server.js"
```

### bash / macOS / Linux

```bash
claude mcp add bc-ws -s user \
  -e BC_BASE_URL=https://devel1/BC \
  -e BC_USERNAME=admin \
  -e BC_PASSWORD='<password>' \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  -e BC_TENANT_ID=default \
  -e BC_SERVER_MAJOR=27 \
  -e BC_APPLICATION_ID=NAV \
  -- node "/d/Proyectos/Aesva/business-central-mcp-esanpons/dist/stdio-server.js"
```

> `NODE_TLS_REJECT_UNAUTHORIZED=0` is needed only for self-signed certs (e.g. the `devel1`
> container). Drop it for a server with a trusted certificate.
> `BC_APPLICATION_ID=NAV` is the default; shown here for clarity.

## Verify

```powershell
claude mcp list          # bc-ws should appear with scope "user"
claude mcp get bc-ws     # shows command, args and env
```

Then **restart Claude Code** (close and reopen) so it loads the server. In any project, ask:
"use bc-ws to call bc_list_companies" — it should return the BC companies.

## Where do the credentials / target server live?

**Not in the code.** The server (`dist/stdio-server.js`) reads everything from environment
variables at startup (`src/core/config.ts`: `requireEnv('BC_BASE_URL')`, etc.). It has **no
hardcoded URL, user, password, tenant or company**. The same compiled server can talk to any BC.

What decides *which* BC / Docker / user / tenant is the **`env` block of the MCP registration**,
stored in your personal config file:

```
~/.claude.json   (Windows: C:\Users\<you>\.claude.json)
```

So: **the GitHub repo never contains your password** — only this local file does. Inspect the
active values any time with `claude mcp get bc-ws`.

| Env var | Controls | Example |
|---|---|---|
| `BC_AUTH` | auth mode: `UserPassword` (default, on-prem forms) or `AAD` (BC Online) | `AAD` |
| `BC_BASE_URL` | **which BC server / Docker / SaaS env** | `https://devel1/BC` |
| `BC_USERNAME` | user (required on-prem; optional in AAD) | `admin` |
| `BC_PASSWORD` | password (plain text in `~/.claude.json`; optional in AAD) | — |
| `BC_TENANT_ID` | **which tenant / database** inside BC | `default` |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` to accept a self-signed cert (on-prem only) | `0` |
| `BC_SERVER_MAJOR` | BC major version | `27` |
| `BC_APPLICATION_ID` | OpenSession applicationId (the fix) | `NAV` |
| `BC_AAD_PROFILE_DIR` | AAD: persistent Entra profile dir (use absolute) | `...\.state\aad-profile` |
| `BC_AAD_TOTP_SECRET` | AAD: base32 TOTP for unattended MFA | — |
| `BC_AAD_LOGIN_TIMEOUT` | AAD: ms budget for the OIDC login | `120000` |
| `BC_REPORT_DIR` | where `bc_download_report` writes files (default `.arxius/reports`, relative to the server's cwd — set an absolute path to control it) | `D:\BCReports` |
| `BC_SCREENSHOT_DIR` / `BC_MANUAL_DIR` | where `bc_screenshot` / `bc_build_manual` write (defaults `./screenshots` / `./manuals`) | — |

### Pointing at a DIFFERENT Docker / server

Two options:

1. **Replace the existing registration** (one BC at a time) — remove and re-add with the new env
   (see *Update or remove* below).
2. **Register a SECOND server under a different name** (several BCs side by side). Reuse the same
   `dist/stdio-server.js`, just change the name and the env. Example for a second container:
   ```powershell
   claude mcp add bc-ws-otrodocker -s user `
     -e BC_BASE_URL=https://otrodocker/BC `
     -e BC_USERNAME=admin `
     -e BC_PASSWORD=<password> `
     -e NODE_TLS_REJECT_UNAUTHORIZED=0 `
     -e BC_TENANT_ID=default `
     -e BC_SERVER_MAJOR=27 `
     -e BC_APPLICATION_ID=NAV `
     -- node "D:\Proyectos\Aesva\business-central-mcp-esanpons\dist\stdio-server.js"
   ```
   The same code base serves both; only the env differs. Each appears as its own MCP
   (`bc-ws`, `bc-ws-otrodocker`).

### BC Online (SaaS) — `BC_AUTH=AAD`

The same server also talks to a **BC Online sandbox** via an Entra (Azure AD) browser login.
On-prem is unaffected: without `BC_AUTH`, everything behaves exactly as above.

1. **Bootstrap the Entra profile once** (interactive, handles MFA). From the repo:
   ```powershell
   $env:BC_AUTH="AAD"
   $env:BC_BASE_URL="https://businesscentral.dynamics.com/<aadTenantId>/<environment>"
   npm run login:aad     # opens a visible browser; sign in + MFA; the profile persists
   ```
2. **Register the SaaS MCP** (separate name, alongside `bc-ws`):
   ```powershell
   claude mcp add bc-saas -s user `
     -e BC_AUTH=AAD `
     -e BC_BASE_URL=https://businesscentral.dynamics.com/<aadTenantId>/<environment> `
     -e BC_SERVER_MAJOR=28 `
     -e BC_AAD_PROFILE_DIR=D:\Proyectos\Aesva\business-central-mcp-esanpons\.state\aad-profile `
     -- node "D:\Proyectos\Aesva\business-central-mcp-esanpons\dist\stdio-server.js"
   ```
   Use an **absolute** `BC_AAD_PROFILE_DIR` so the server finds the same warm profile regardless
   of its working directory. Unattended MFA instead of the bootstrap: add
   `-e BC_AAD_TOTP_SECRET=<base32>` (needs `otpauth`, already a dependency). `BC_USERNAME`/
   `BC_PASSWORD` are optional in AAD mode (only used for headless login).
3. `BC_TENANT_ID` / `BC_APPLICATION_ID` in AAD mode take the values the F2 spike confirms
   (`npm run capture:saas`); see [`SAAS-EVIDENCE.md`](SAAS-EVIDENCE.md).

If a headless reconnect ever fails with an "interaction required" style error (Entra expired the
persisted session), just re-run `npm run login:aad`.

**Running Docker AND SaaS at once, re-login, switching tenant, resetting the profile:** see the
dedicated guide [`guides/saas-vs-docker.md`](guides/saas-vs-docker.md). Short version: register two
MCP servers with clear names (`bc-docker` + `bc-saas`); the model routes by name from what you say
("in SaaS" / "in devel1"). To switch tenant/account use a fresh `BC_AAD_PROFILE_DIR`; to reset,
delete that folder and re-run `npm run login:aad`. `bc_health` reports `environmentKind`
(`saas` | `on-prem`) so you can always confirm which BC an instance talks to.

### Which company does it open?

There is **no company env var** — the server opens the **default company of `BC_USERNAME`** on the
target server (currently `CRONUS_03` for `admin`). To work in another company at runtime, switch
with the `bc_switch_company` tool. Convention in the JBC workspace: pick the CRONUS with the
highest number; note that non-CRONUS companies (e.g. `JBC JAPAN`) must be named explicitly.

## Update or remove

```powershell
# Change config: remove then re-add with new values
claude mcp remove bc-ws -s user
claude mcp add bc-ws -s user -e ... -- node "...\dist\stdio-server.js"
```

## Scope cheat-sheet

| Scope | Flag | Stored in | Applies to |
|---|---|---|---|
| local | (default) | per-folder local state | only the current folder, only you |
| **user** | `-s user` | `~/.claude.json` | **every folder you open (recommended here)** |
| project | `-s project` | `.mcp.json` committed in the repo | anyone who clones that repo |

## Notes

- **Path stability:** the global registration stores an absolute path. Moving/renaming the
  `business-central-mcp-esanpons` folder breaks it — re-register with the new path.
- **The folder is not a single file:** if you relocate it, copy it whole (it needs
  `node_modules/` and `dist/`), or clone the fork again and `npm install && npm run build`.
- **Secrets:** at user scope the password lives in `~/.claude.json` (outside any repo), which is
  safer than a committed project `.mcp.json`. Never commit a real password.
- **One server, many projects:** you register once; every project shares the same running config
  and the same BC connection target.
```
