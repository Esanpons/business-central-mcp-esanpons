# Cómo se elige SaaS o Docker (y cómo se lo indicas a la IA)

> TL;DR: **la IA no elige el entorno en tiempo de ejecución.** Cada registro MCP apunta a UN
> entorno fijo, decidido por sus variables de entorno (sobre todo `BC_AUTH` y `BC_BASE_URL`).
> Para tener ambos disponibles a la vez, **registras dos servidores MCP con nombres distintos**
> (p. ej. `bc-docker` y `bc-saas`) y la IA elige por el nombre del servidor.

## El concepto clave

El servidor bc-ws (`dist/stdio-server.js`) **no tiene lógica para “ir a SaaS” o “ir a Docker”**.
Al arrancar lee su configuración del entorno una sola vez (`src/core/config.ts`) y se queda fijo
apuntando a ese BC concreto durante toda su vida. Lo que decide el destino es el **bloque `env`
del registro MCP**, no una decisión de la IA ni un parámetro de las tools.

Por eso, la forma de “tener los dos” es tener **dos procesos** (dos registros MCP), cada uno con
su `env`:

| Servidor MCP (nombre) | `BC_AUTH` | `BC_BASE_URL` | Apunta a |
|---|---|---|---|
| `bc-docker` (o `bc-ws`) | *(sin definir)* = `UserPassword` | `https://devel1/BC` | Docker on-prem `devel1` |
| `bc-saas` | `AAD` | `https://businesscentral.dynamics.com/{aadTenantId}/{environment}` | Sandbox BC Online |

## Cómo lo distingue la IA (y cómo se lo indicas tú)

Cuando registras dos servidores MCP, la IA ve **dos juegos de herramientas separados**, con el
nombre del servidor como prefijo. En Claude Code las tools aparecen como
`mcp__<servidor>__<tool>`, por ejemplo:

```
mcp__bc-docker__bc_open_page      mcp__bc-saas__bc_open_page
mcp__bc-docker__bc_read_data      mcp__bc-saas__bc_read_data
mcp__bc-docker__bc_list_companies mcp__bc-saas__bc_list_companies
...
```

Así que **basta con que tú digas el destino en lenguaje natural** y la IA usa el juego de tools
correcto por su nombre:

- “mírame los clientes **en SaaS**” / “**en el sandbox**” / “**en Dev**” → tools `bc-saas`
- “y ahora **en el Docker**” / “**en devel1**” / “**on-prem**” → tools `bc-docker`

La regla la haces fácil poniendo **nombres claros** a los servidores. Recomendado:
`bc-docker` para el contenedor y `bc-saas` para BC Online (o `bc-devel1` / `bc-cloud`, lo que te
resulte natural de decir). Si un día tienes varios sandboxes, nómbralos por entorno: `bc-saas-dev`,
`bc-saas-dev-es`.

## Autocomprobación: `bc_health` dice contra qué entorno habla

Cualquier tool `bc_health` devuelve el destino real, para que la IA (o tú) confirméis sin dudas
a qué BC está conectada esa instancia:

```jsonc
{
  "status": "connected",
  "bc": {
    "baseUrl": "https://businesscentral.dynamics.com/2c43eb40-.../Dev",
    "authMode": "AAD",
    "environmentKind": "saas",        // "saas" | "on-prem"
    "serverMajor": 28
  },
  "session": { "company": "CRONUS ES", ... }
}
```

En el Docker daría `authMode: "UserPassword"`, `environmentKind: "on-prem"`,
`baseUrl: "https://devel1/BC"`. Si alguna vez hay duda de “¿esto es SaaS o Docker?”, la IA solo
tiene que llamar a `bc_health` de ese servidor.

## Registro de los dos servidores (ejemplo)

### `.mcp.json` de proyecto (o el mismo bloque con `claude mcp add ... --scope user`)

```json
{
  "mcpServers": {
    "bc-docker": {
      "command": "node",
      "args": ["D:/Proyectos/Aesva/business-central-mcp-esanpons/dist/stdio-server.js"],
      "env": {
        "BC_BASE_URL": "https://devel1/BC",
        "BC_USERNAME": "admin",
        "BC_PASSWORD": "<password>",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0",
        "BC_TENANT_ID": "default",
        "BC_SERVER_MAJOR": "27",
        "LOG_LEVEL": "warn"
      }
    },
    "bc-saas": {
      "command": "node",
      "args": ["D:/Proyectos/Aesva/business-central-mcp-esanpons/dist/stdio-server.js"],
      "env": {
        "BC_AUTH": "AAD",
        "BC_BASE_URL": "https://businesscentral.dynamics.com/2c43eb40-4e62-4039-8a43-8a75f7323032/Dev",
        "BC_SERVER_MAJOR": "28",
        "BC_AAD_PROFILE_DIR": "D:/Proyectos/Aesva/business-central-mcp-esanpons/.state/aad-profile",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

Notas:
- **El mismo `dist/stdio-server.js` sirve para ambos**; solo cambia el `env`. Cada uno es un
  proceso independiente, así que las sesiones no se pisan.
- `bc-saas` necesita el perfil de Entra caliente una vez: `npm run login:aad` (ver
  [`SETUP-GLOBAL.md`](../SETUP-GLOBAL.md#bc-online-saas--bc_authaad)). Usa una ruta **absoluta**
  en `BC_AAD_PROFILE_DIR`.
- En SaaS **no** pongas `NODE_TLS_REJECT_UNAUTHORIZED=0` (el certificado es válido); en el Docker
  self-signed sí.
- `BC_APPLICATION_ID` se ajusta solo por modo (`NAV` on-prem, `FIN` en SaaS); solo lo pones si un
  build concreto pide otra cosa.

## Restablecer, re-login y cambiar de tenant (SaaS)

La sesión de SaaS se sostiene sobre un **perfil de navegador persistente** (la carpeta
`BC_AAD_PROFILE_DIR`, por defecto `./.state/aad-profile`). Ahí viven las cookies SSO de Entra.
Todo lo de abajo gira alrededor de ese perfil.

### A. Volver a iniciar sesión (la sesión de Entra caducó)

Síntoma: una operación falla y `bc_health`/el log dice algo tipo *“interaction required”* o
*“AAD login did not complete … run `npm run login:aad`”*.

```bash
npm run login:aad     # abre un navegador visible; vuelve a hacer login + MFA; el perfil se refresca
```

No hace falta borrar nada: el perfil se conserva y solo se renueva el ticket. Tras esto, reinicia
el cliente MCP (o simplemente vuelve a pedirle a la IA la operación; el servidor re-autentica solo
en la siguiente conexión). El servidor **ya intenta re-autenticar solo** cuando la sesión cae
(recovery con backoff); `npm run login:aad` solo es necesario cuando Entra exige interacción
humana (MFA/consent) que no se puede hacer headless.

### B. Iniciar sesión en OTRO tenant o con OTRA cuenta

Importante: si reutilizas el mismo perfil, Entra hará **SSO automático con la cuenta anterior** y
no te dejará cambiar. Para cambiar de tenant/cuenta hay dos opciones:

**Opción 1 (recomendada) — un perfil por tenant/cuenta.** Aísla cada uno en su carpeta y regístralo
como un servidor MCP distinto:

```bash
# Tenant/entorno nuevo -> su propio BC_BASE_URL + su propio BC_AAD_PROFILE_DIR
set BC_AUTH=AAD
set BC_BASE_URL=https://businesscentral.dynamics.com/<otroAadTenantId>/<environment>
set BC_AAD_PROFILE_DIR=D:\...\.state\aad-profile-<alias>
npm run login:aad
```

Luego registra un MCP `bc-saas-<alias>` con esos mismos `BC_BASE_URL` + `BC_AAD_PROFILE_DIR`.
Así conviven varios sandboxes/tenants sin pisarse (`bc-saas-dev`, `bc-saas-dev-es`, `bc-saas-cliente2`…).

**Opción 2 — reutilizar la misma carpeta pero forzando login nuevo.** Borra el perfil y vuelve a
entrar (ver C); entonces `npm run login:aad` te pedirá cuenta desde cero.

### C. Restablecer un perfil roto / cerrar sesión del todo

Si el perfil se corrompe, quieres “cerrar sesión”, o vas a cambiar de cuenta en la misma carpeta:

```bash
# 1. Para el cliente MCP (para liberar la carpeta del perfil).
# 2. Borra el perfil persistente:
rmdir /s /q D:\Proyectos\Aesva\business-central-mcp-esanpons\.state\aad-profile   # Windows (cmd)
#   o en PowerShell:  Remove-Item -Recurse -Force .\.state\aad-profile
# 3. Vuelve a iniciar sesión desde cero:
npm run login:aad
# 4. Reinicia el cliente MCP.
```

Borrar la carpeta = cerrar sesión: se van todas las cookies SSO y el siguiente `login:aad` empieza
limpio (útil para cambiar de cuenta, o si Entra dejó el perfil en un estado raro).

### D. Login desatendido (sin abrir navegador cada vez)

Si el usuario tiene MFA con app de autenticación (TOTP), puedes evitar el paso manual:

```
BC_USERNAME=<upn>
BC_PASSWORD=<password>
BC_AAD_TOTP_SECRET=<secreto base32 del authenticator>
```

Con esas tres, el servidor completa el login de Entra headless por sí solo (incluida la MFA) y no
necesitas `npm run login:aad` salvo la primera vez o si Conditional Access lo bloquea. `otpauth`
ya es dependencia del proyecto. Sin `BC_AAD_TOTP_SECRET`, el floor honesto es el bootstrap
interactivo (`login:aad`) cada vez que Entra caduque la sesión (semanas/meses con “mantener sesión
iniciada”).

### Resumen rápido

| Quiero… | Qué hago |
|---|---|
| Re-login (sesión caducó) | `npm run login:aad` (mismo perfil) |
| Cambiar de tenant/cuenta | nuevo `BC_AAD_PROFILE_DIR` + nuevo `BC_BASE_URL` → `npm run login:aad` → registrar `bc-saas-<alias>` |
| Cerrar sesión / perfil roto | borrar la carpeta `BC_AAD_PROFILE_DIR` → `npm run login:aad` |
| Login sin navegador | `BC_USERNAME` + `BC_PASSWORD` + `BC_AAD_TOTP_SECRET` |
| Cambiar de compañía (mismo tenant) | tool `bc_switch_company` (en caliente, sin re-login) |

## Preguntas frecuentes

**¿Puede un solo servidor cambiar de SaaS a Docker a mitad de conversación?**
No. Un registro = un destino. Para cambiar de destino en el MISMO servidor tendrías que cambiar su
`env` y reiniciar el cliente MCP. Por eso se registran dos.

**¿Y si solo registro uno?**
Funciona igual, pero solo contra ese destino. La IA usará ese sin ambigüedad. Cambiar de destino =
editar el `env` y reiniciar.

**¿Cómo cambio de compañía dentro de un mismo entorno?**
Eso sí es en tiempo de ejecución: la tool `bc_switch_company`. La compañía es independiente del
entorno (SaaS/Docker); el destino BC no.

**¿Nombres recomendados?** Los que digas de forma natural. La IA mapea “SaaS/sandbox/Dev/cloud” y
“Docker/devel1/on-prem/local” al servidor cuyo nombre encaje. Mantén los nombres estables.
