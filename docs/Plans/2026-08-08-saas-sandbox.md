# Plan: soporte SaaS sandbox (BC Online) — 2026-08-08

> Objetivo: que bc-ws haga contra un **sandbox de Business Central Online** exactamente lo mismo
> que hoy hace contra el Docker on-prem (`devel1`), **sin tocar ni degradar nada del camino
> Docker/on-prem**. Todo el soporte SaaS vive detrás de una variable nueva `BC_AUTH=AAD`;
> sin ella, el comportamiento es byte a byte el actual.
>
> Este plan concreta y sustituye el §7 de
> [`2026-07-04-auditoria-completa-millores.md`](2026-07-04-auditoria-completa-millores.md)
> ahora que ya existe un tenant real con sandboxes.

## Estado (2026-08-08)

- **F1 refactor de auth** — HECHO. `NTLMAuthProvider`→`FormsAuthProvider`, `RawCookie`/`parseSetCookie`
  movidos a `src/connection/auth/cookies.ts`, `AuthResult.cookieJar` + `getCookieJar()`, factory
  `createAuthProvider` por `BC_AUTH`, login del navegador unificado (`ensureAuthJar`), config `BC_AUTH`
  con credenciales por modo. tsc + 403 tests verdes.
- **F3 provider AAD** — HECHO (código). `AADBrowserAuthProvider` (login Entra headless con perfil
  persistente + TOTP opcional), `npm run login:aad` (bootstrap interactivo), `tenant=` omitido en modo
  AAD en deep links y OpenForm.
- **F4 expiración de cookies** — HECHO. Reusa el recovery existente (`invalidate`+re-auth); el error
  accionable se propaga en `SessionLostError`.
- **F2 spike** — código listo (`npm run capture:saas`); **PENDIENTE de ejecutar** (requiere tu login MFA).
  Resultados a [`saas-spike.md`](saas-spike.md).
- **F5 docs** — HECHO (.env.example, README, SETUP-GLOBAL, CLAUDE.md, ROADMAP).
- **PENDIENTE (bloqueado por ti)**: ejecutar F2 live y el smoke de tools contra el sandbox `Dev`.

---

## 0. Regla de oro (innegociable)

1. `BC_AUTH` con valores `UserPassword` (**default**) | `AAD`. Sin `BC_AUTH`: mismas env vars
   obligatorias, mismo `/SignIn`, misma URL WS, mismos deep links con `?tenant=`. Idéntico a hoy.
2. `BC_USERNAME`/`BC_PASSWORD` obligatorios **solo** en modo `UserPassword`
   (hoy son `requireEnv` incondicionales en [config.ts:82-83](../../src/core/config.ts#L82-L83)).
3. Ningún cambio en `protocol/` condicionado al modo de auth, salvo los puntos de URL/tenant
   listados en F3.3, todos detrás de **un único predicado central** (`config.bc.authMode === 'AAD'`).
4. Gate de regresión tras **cada** fase: `npx tsc --noEmit` + `npx vitest run` verdes, y la suite
   de integración contra `devel1` verde con `BC_AUTH` sin definir.

---

## 1. Contexto: qué hay hoy y qué falta

**Hay** (todo verificado contra `devel1`, BC27 on-prem, forms auth):

- Un solo auth provider: [`ntlm-provider.ts`](../../src/connection/auth/ntlm-provider.ts)
  (mal llamado NTLM; es forms auth ASP.NET contra `/SignIn`), instanciado a pelo en
  [server.ts:54](../../src/server.ts#L54) y [stdio-server.ts:53](../../src/stdio-server.ts#L53).
- Un segundo login duplicado para el navegador headless:
  [`bc-web-auth.ts::authCookies()`](../../src/services/bc-web-auth.ts#L81) (screenshots + descarga
  de reports) reimplementa el mismo `/SignIn`.
- Deep links con `?tenant=` cableado:
  [`deepLinkPage`/`deepLinkReport`](../../src/services/bc-web-auth.ts#L34-L54) y el query de
  `OpenForm` en [page-service.ts:82](../../src/services/page-service.ts#L82).
- Fallback de login in-page con selectores on-prem (`#UserName`/`#Password`/`#submitButton`) en
  [`bc-web-auth.ts::inPageLogin`](../../src/services/bc-web-auth.ts#L118) — **no existe en SaaS**.

**No hay**: nada de OAuth/Entra/AAD, ni `BC_AUTH`, ni factory de providers. Cero líneas SaaS.

**Conclusiones de la investigación previa** (§7.0 de la auditoría, siguen vigentes):

- **El protocolo es el mismo.** BC Online es el mismo web client hospedado; el tráfico va por el
  mismo WebSocket JSON-RPC en `/csh`. La capa `protocol/` no necesita cambios. La evidencia
  BC27/BC28 = wire idéntico (compat 15041) juega a favor: el sandbox está en 28.x y ya soportamos
  BC28 (`BC_SERVER_MAJOR=28`, suite `tests/integration/bc28.test.ts`).
- **Lo único que cambia es la autenticación.** SaaS no tiene `/SignIn` de formulario: redirección
  OpenID Connect a `login.microsoftonline.com`; el callback deja las cookies de sesión ASP.NET en
  `businesscentral.dynamics.com`.
- **Los tokens OAuth NO sirven para el web client.** Device code, auth code + PKCE, client
  credentials (S2S), ROPC: todos emiten tokens para `api.businesscentral.dynamics.com`, no cookies
  del web client. No existe intercambio token→cookie documentado. El único camino probado es un
  **login de navegador con perfil persistente** (una vez interactivo, o automatizado con TOTP) que
  se reutiliza headless.
- El modo API REST (`api/v2.0` + S2S) es 100% soportado y unattended, pero solo cubre entidades
  API — ni páginas arbitrarias, ni acciones, ni Tell Me, ni screenshots/manuales. Complemento
  futuro (ROADMAP), no sustituto.

---

## 2. Datos del tenant (ya disponibles)

Confirmado en el admin center (captura 2026-08-08):

| Dato | Valor |
|---|---|
| AAD tenant id | `2c43eb40-4e62-4039-8a43-8a75f7323032` |
| Admin center | `https://businesscentral.dynamics.com/2c43eb40-4e62-4039-8a43-8a75f7323032/admin` |
| Environment 1 | `Dev` — Sandbox, Active, ES, **28.3** (28.4 "scheduled upon release") |
| Environment 2 | `Dev ES` — Sandbox, Active, ES, **28.3** (28.4 programado 28-ago-2026) |

URLs derivadas (a verificar en F2):

- Web client: `https://businesscentral.dynamics.com/2c43eb40-4e62-4039-8a43-8a75f7323032/Dev`
- WS esperado: `wss://businesscentral.dynamics.com/2c43eb40-4e62-4039-8a43-8a75f7323032/Dev/csh?...`

Notas:

- El nombre de environment con espacio (`Dev ES`) se URL-encodea (`Dev%20ES`). Recomendado usar
  `Dev` como entorno de trabajo del MCP para evitar ese frente.
- TLS es válido (certificado real): **no** hace falta `NODE_TLS_REJECT_UNAUTHORIZED=0` en SaaS.
- Ambos sandboxes saltarán a 28.4 pronto. El wire 27↔28 es idéntico; si 28.4 regresara algo, el
  síntoma más probable es `NavCancelCredentialPromptException` (ver "OpenSession applicationId"
  en CLAUDE.md) y la mitigación es re-capturar con el spike (F2 es re-ejecutable).

---

## 3. Qué necesito del usuario (bloqueantes de F2/F3)

1. **Environment elegido**: propongo `Dev`. (Cambiable; solo afecta a `BC_BASE_URL`.)
2. **Un usuario del tenant** con licencia y permisos (SUPER en el sandbox): su UPN
   (`usuario@dominio`) y contraseña.
3. **Situación MFA / Conditional Access** de ese usuario. Tres escenarios, de mejor a peor:
   - **Sin MFA obligatorio** → login headless completo con user+password. Ideal para un usuario
     de servicio dedicado al sandbox.
   - **MFA con TOTP (authenticator)** → registrar TOTP para ese usuario y guardar el secreto
     (`BC_AAD_TOTP_SECRET`); login headless completo con `otpauth`.
   - **MFA sin TOTP exportable / Conditional Access estricta** → bootstrap interactivo one-shot:
     un comando abre navegador visible, el usuario hace login+MFA una vez, y el perfil persistente
     queda en disco para reuso headless. Habrá que repetirlo cuando Entra caduque la sesión
     (típicamente semanas/meses con "keep me signed in").
4. **Credenciales en `.secrets/saas.env`** (el directorio `.secrets/` ya está gitignored; mismo
   patrón que `devel1.env`). Nunca en `.mcp.json` versionado ni en el plan.
5. **Consentimiento explícito del riesgo ToS**: esto automatiza el web client (protocolo
   reverse-engineered) contra un servicio hospedado por Microsoft. En un sandbox de desarrollo el
   riesgo práctico es bajo, pero la decisión es del propietario del tenant.

Requisitos de máquina ya cubiertos: Chrome/Edge instalado (ya lo exige `bc_screenshot`),
`puppeteer-core` ya es dependencia runtime.

---

## 4. Decisiones de diseño

- **Un solo lugar hace login; todos consumen el mismo jar.** El `IBCAuthProvider` activo produce
  el cookie jar con atributos (`RawCookie[]`); tanto la cabecera `Cookie` del WS como la inyección
  de cookies de puppeteer (screenshots/reports) salen de ahí. Esto elimina la duplicación actual
  ANTES de añadir el segundo modo — así el modo AAD no tiene que implementarse dos veces.
- **El provider AAD es un navegador, no un cliente OAuth.** `authenticate()` = abrir el web client
  con perfil persistente, dejar que la danza OIDC ocurra (silenciosa si el perfil vale), exportar
  cookies vía CDP (`Network.getAllCookies`, captura httpOnly), derivar el CSRF según lo que diga
  el spike, cerrar la página. El WS después es idéntico al de hoy.
- **`BC_BASE_URL` lleva la ruta completa** (`https://businesscentral.dynamics.com/{aadTenant}/{env}`).
  El builder de la URL WS ([connection-factory.ts:37-47](../../src/connection/connection-factory.ts#L37-L47))
  hace `{baseUrl}/csh` y funciona por construcción. No se introducen variables nuevas de
  tenant/environment para URLs.
- **Predicado central de modo**, no sniffing de URL: `authMode: 'UserPassword' | 'AAD'` en
  `BCConfig`; los 3 puntos que emiten `tenant=` consultan eso.

---

## 5. Fases

### F1 — Refactor de auth (1-2 días; SIN tenant; cero cambio de comportamiento)

Deuda técnica que paga por sí sola aunque el SaaS se aplazara. Solo renombres y unificación:

1. Renombrar `NTLMAuthProvider` → `FormsAuthProvider`
   (`src/connection/auth/ntlm-provider.ts` → `forms-provider.ts`). No es NTLM; el nombre induce a
   error. Actualizar los ~12 imports (src, tests de integración, scripts).
2. Extender `AuthResult` ([auth-provider.ts](../../src/connection/auth/auth-provider.ts)) con
   `cookieJar: RawCookie[]` (tipo ya existente en
   [bc-web-auth.ts:20](../../src/services/bc-web-auth.ts#L20)), manteniendo `cookies: string`
   para la cabecera WS. `FormsAuthProvider` ya ve los `Set-Cookie` crudos: construir el jar ahí.
3. `bc-web-auth.ts::authCookies()` desaparece como login independiente: `ScreenshotService`
   ([screenshot-service.ts](../../src/services/screenshot-service.ts)) y `ReportDownloadService`
   ([report-download-service.ts](../../src/services/report-download-service.ts)) piden el jar al
   provider activo (inyectado), con `invalidate()` + re-auth si la inyección aterriza en login.
4. Factory `createAuthProvider(config, logger): IBCAuthProvider` en
   `src/connection/auth/factory.ts`, seleccionado por `config.bc.authMode`. Usado por
   `server.ts`/`stdio-server.ts` y por los scripts. En F1 solo existe la rama `UserPassword`.
5. Config: añadir `authMode` a `BCConfig` (`BC_AUTH`, default `UserPassword`, valores validados);
   mover `BC_USERNAME`/`BC_PASSWORD` a obligatorios-por-modo.
6. Tests: unitarios del factory y del jar en `AuthResult`; renombrar los existentes del provider.

**Gate**: unit + integración `devel1` verdes; smoke manual de `bc_screenshot` (consume el jar
unificado).

### F2 — Spike de captura contra el sandbox (1-2 días; NECESITA §3; sin cambios de producto)

Sin esto, F3 es fe. Reutilizar la técnica ya probada contra `devel1` (ver "OpenSession
applicationId" en CLAUDE.md): el web client crea el WebSocket **dentro de un Web Worker**, así
que se captura con Playwright `page.on('websocket')` + `framesent` (devDependency solo para el
script; probado) — o puppeteer-core con CDP `Target.setAutoAttach` a workers si preferimos no
añadir Playwright.

Script nuevo `scripts/capture-saas-handshake.ts` (headed, login manual del usuario durante la
captura). Capturar y documentar:

- **(a)** URL `wss://` exacta y query params (¿`csrftoken`? ¿`ackseqnb=-1`? ¿otros?).
- **(b)** Payload completo de `OpenSession`: **`applicationId` (¿FIN? ¿NAV? ¿otro?)** — en SaaS
  podría volver a ser `FIN`; el fork lo tiene configurable justo para esto —, `tenantId` (¿GUID
  AAD? ¿nombre de environment? ¿vacío?), `features`, `supportedExtensions`, versión de
  protocolo/compat (¿sigue 15041 en 28.3?).
- **(c)** Cookie jar completo (nombres, atributos, dominio/path): qué cookie lleva el CSRF
  (probablemente el mismo patrón antiforgery `CfDJ8...`, es la misma app ASP.NET) y cuáles son de
  Entra vs de BC.
- **(d)** Flujo OIDC completo: redirects, qué queda en `businesscentral.dynamics.com` vs
  `login.microsoftonline.com`, y si "stay signed in" produce cookie persistente de Entra.
- **(e)** El query de un deep link real en SaaS (abrir la Customer List a mano y mirar la URL
  normalizada): ¿existe `tenant=`? ¿solo `company=`+`page=`?

Entregables: `docs/Plans/saas-spike.md` con los resultados + captura redactada en
`src/protocol/captures/saas-handshake-2026-08.json`. **Criterio de go/no-go**: si el frame
`OpenSession` y los handlers de respuesta son estructuralmente los de BC28, F3 procede sin tocar
`protocol/`. Si no, parar y re-evaluar (riesgo R2).

### F3 — `AADBrowserAuthProvider` + modo AAD (3-5 días; necesita F1 + F2)

1. Nuevo `src/connection/auth/aad-browser-provider.ts` implementando `IBCAuthProvider`:
   - `authenticate()`: lanza el navegador compartido ([browser.ts](../../src/services/browser.ts),
     puppeteer-core) con **perfil persistente** (`BC_AAD_PROFILE_DIR`, default
     `./.state/aad-profile`), navega a `{baseUrl}`:
     - Perfil con SSO válido → OIDC silencioso → SPA carga → exportar jar y salir.
     - Login necesario y hay `BC_USERNAME`+`BC_PASSWORD` (+`BC_AAD_TOTP_SECRET` si MFA) →
       rellenar el formulario de Entra headless (`input[name=loginfmt]` → `passwd` → TOTP vía
       paquete `otpauth` → "Stay signed in?" = Yes).
     - Si no puede → error accionable: `Run "npm run login:aad" (headed) to bootstrap the AAD
       profile`.
   - Exportar jar con CDP `Network.getAllCookies()` (incluye httpOnly), filtrar al dominio BC,
     derivar `csrftoken` según (c) del spike, cerrar página (no el perfil).
   - `getWebSocketHeaders()`/`getWebSocketQueryParams()`: idénticos en forma al provider forms.
   - `invalidate()`: borra jar/flag en memoria; el perfil en disco se conserva → re-auth
     normalmente silenciosa. El flujo de recuperación de `SessionManager` funciona sin tocarlo.
2. **Bootstrap interactivo**: `scripts/aad-login.ts` (`npm run login:aad`) — navegador headed
   sobre el mismo perfil, el usuario hace login+MFA, el script verifica que la SPA carga y sale.
3. **URLs y tenant** (únicos puntos fuera de auth, todos tras `authMode === 'AAD'`):
   - [`deepLinkPage`/`deepLinkReport`](../../src/services/bc-web-auth.ts#L34-L54): no emitir
     `tenant=` en modo AAD (según (e) del spike).
   - [page-service.ts:82](../../src/services/page-service.ts#L82) (query de `OpenForm`) y el campo
     `tenantId` de cada `Invoke`: el valor que dicte (b) del spike.
   - `BC_APPLICATION_ID`: default por modo si el spike demuestra que SaaS espera otro valor
     (p. ej. `FIN`); la env var sigue mandando si está definida.
   - [`inPageLogin`](../../src/services/bc-web-auth.ts#L118) (selectores on-prem): en modo AAD se
     sustituye por re-auth del provider o error claro.
4. Config nueva (solo leída en modo AAD): `BC_AAD_PROFILE_DIR`, `BC_AAD_TOTP_SECRET?`,
   `BC_AAD_LOGIN_TIMEOUT?`. Documentar en `.env.example`, README y `docs/SETUP-GLOBAL.md`.
5. Dependencia nueva: `otpauth` (solo si hay escenario TOTP; es pura, sin nativos).

**Gate**: contra el sandbox `Dev`: `bc_health`, `bc_search_pages`, `bc_open_page` (Customer
List), `bc_read_data`, `bc_write_data`, `bc_execute_action`, `bc_run_report`,
`bc_download_report`, `bc_screenshot`, `bc_build_manual`, `bc_switch_company` (los sandboxes
traen CRONUS + posible segunda compañía), `bc_find_object`/`bc_refresh_objects`. Y OBLIGATORIO:
suite `devel1` verde con `BC_AUTH` sin definir.

### F4 — Vida de sesión SaaS (2-3 días)

- Las cookies BC/Entra expiran por su cuenta: detectar expiración (upgrade WS → 302/401, u
  `OpenSession` rechazado) y cablearla al camino de recuperación existente de `SessionManager`
  (invalidate → re-auth → reconnect con backoff; ya existe). Con perfil persistente válido la
  re-auth es silenciosa; si Entra exige interacción, error accionable pidiendo `npm run login:aad`.
- Re-auth proactiva opcional si el provider conoce la expiración aproximada del ticket.
- Tests: simular expiración invalidando el jar y comprobar recuperación transparente.

### F5 — Tests, docs y cierre (1-2 días)

- **Suite de integración SaaS opt-in**: `vitest.saas.config.ts` + `tests/integration-saas/` con
  un smoke corto (open/read/write/action/report), gated por `BC_SAAS_TEST=1` + `.secrets/saas.env`.
  No entra en el gate normal (SaaS es un blanco móvil; no debe romper CI local).
- Actualizar: `.env.example`, README, `docs/SETUP-GLOBAL.md` (bloque `bc-saas` además de `bc-ws`),
  CLAUDE.md (sección nueva "SaaS / AAD"), `docs/ROADMAP.md` (marcar OAuth/AAD como hecho).
- Registrar en el admin center la fecha de update 28.4 como evento a vigilar (re-ejecutar smoke
  SaaS después).

---

## 6. Configuración resultante

| Variable | Modo | Default | Notas |
|---|---|---|---|
| `BC_AUTH` | ambos | `UserPassword` | `AAD` activa todo lo nuevo |
| `BC_BASE_URL` | AAD | — | `https://businesscentral.dynamics.com/{aadTenantId}/{environment}` |
| `BC_USERNAME` / `BC_PASSWORD` | AAD | opcional | UPN + password para login headless de Entra |
| `BC_AAD_TOTP_SECRET` | AAD | opcional | secreto TOTP base32 si el usuario tiene MFA-authenticator |
| `BC_AAD_PROFILE_DIR` | AAD | `./.state/aad-profile` | perfil persistente del navegador |
| `BC_AAD_LOGIN_TIMEOUT` | AAD | `120000` | ms para completar la danza OIDC |
| `BC_SERVER_MAJOR` | AAD | — | `28` para el sandbox actual |
| `BC_APPLICATION_ID` | ambos | por modo | on-prem `NAV`; SaaS: lo que diga el spike |
| `BC_TENANT_ID` | UserPassword | `default` | ignorada en modo AAD (URLs path-based) |

Ejemplo `.mcp.json` (junto al `bc-ws` actual, sin sustituirlo):

```json
{
  "mcpServers": {
    "bc-saas": {
      "command": "node",
      "args": ["D:/Proyectos/Aesva/business-central-mcp-esanpons/dist/stdio-server.js"],
      "env": {
        "BC_AUTH": "AAD",
        "BC_BASE_URL": "https://businesscentral.dynamics.com/2c43eb40-4e62-4039-8a43-8a75f7323032/Dev",
        "BC_SERVER_MAJOR": "28",
        "BC_USERNAME": "<upn>",
        "BC_PASSWORD": "<en .secrets/saas.env, no aquí>",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

---

## 7. Riesgos honestos y mitigaciones

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | **ToS / anti-automatización**: protocolo reverse-engineered contra servicio hospedado; Microsoft podría gatear `/csh` | Solo sandbox de desarrollo; volumen bajo; decisión informada del propietario del tenant (§3.5). Plan B parcial: modo API REST (ROADMAP) |
| R2 | **SaaS es un blanco móvil**: siempre corre la última minor (28.3→28.4 ya programado) | Evidencia 27↔28 wire-idéntico; spike re-ejecutable como herramienta de diagnóstico; smoke SaaS tras cada update del sandbox; `BC_APPLICATION_ID`/`BC_CLIENT_VERSION` ya configurables |
| R3 | **Conditional Access / MFA** puede vetar el login headless e incluso caducar el perfil persistente | Escalera de §3.3: sin-MFA → TOTP → bootstrap headed periódico. El floor honesto es re-login humano ocasional |
| R4 | **Mecánica cookies/CSRF SaaS asumida** hasta que el spike la verifique | F2 es bloqueante de F3 por diseño; go/no-go explícito |
| R5 | Expiración de cookies a mitad de sesión | F4: cableado al recovery existente de `SessionManager` |

---

## 8. Criterios de aceptación

1. Con `BC_AUTH` sin definir: `npx vitest run` + integración `devel1` verdes, sin ningún cambio
   observable (diff de comportamiento cero).
2. Con `BC_AUTH=AAD` contra el sandbox `Dev`: las 14 tools del gate F3 funcionan; `bc_write_data`
   confirma `changed:true` en un registro de prueba; `bc_screenshot` y `bc_download_report`
   producen binarios reales.
3. Matar las cookies (invalidate forzado) y ver la sesión recuperarse sola sin reiniciar el MCP.
4. Documentación completa (§F5) y `docs/Plans/saas-spike.md` con las capturas redactadas.

## 9. Estimación

| Fase | Duración | Bloqueada por |
|---|---|---|
| F1 refactor auth | 1-2 días | nada — se puede empezar YA |
| F2 spike captura | 1-2 días | §3 (usuario + entorno + MFA) |
| F3 provider AAD | 3-5 días | F1 + F2 |
| F4 vida de sesión | 2-3 días | F3 |
| F5 tests + docs | 1-2 días | F3 |

**Total ~2-3 semanas** de trabajo focalizado, condicionado a que F2 confirme paridad de protocolo
(la evidencia disponible dice que sí).
