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
