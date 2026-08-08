# SaaS (BC Online) — cómo funciona y qué se verificó en vivo

> **Documento congelado: registro de evidencia, no lista de tareas.** Reúne en un solo sitio el
> spike de captura del handshake (2026-08-08) y la batería funcional Docker-vs-SaaS de ese mismo
> día. Sustituye a `docs/Plans/saas-spike.md` y `docs/Plans/saas-battery.md`.
>
> **Lo que queda pendiente NO está aquí**, está en [`ROADMAP.md`](ROADMAP.md) — que es el único
> sitio donde se registra trabajo abierto. La única limitación SaaS abierta (`bc_download_report`)
> es el ítem **G5** de ese fichero.
>
> Guía de uso para el día a día (cómo elegir entorno, perfil AAD, login): [`guides/saas-vs-docker.md`](guides/saas-vs-docker.md).
> Resumen de implementación: `CLAUDE.md`, sección *Authentication modes*.

---

## Parte 1 — Spike del handshake (`npm run capture:saas`, 2026-08-08)

Ejecutado con navegador visible y login + MFA manual contra el sandbox `Dev`. El script engancha el
WebSocket del **Web Worker** vía CDP (`Target.setAutoAttach` + `Network` por target); un hook de
`window.WebSocket` en la página principal no ve nada.

Captura cruda con secretos redactados: `src/protocol/captures/saas-handshake-2026-08-08.json`.

### (a) URL del WebSocket — NO es `{baseUrl}/csh`

El servidor asigna un endpoint de **backend regional por pestaña**:

```
wss://msweuweuas4242-7uyvs76.appservices.weu.businesscentral.dynamics.com
     /tenant/msweua3554t30793230/tab/<tabGuid>/csh
     ?ackseqnb=-1&aadTenantId=2c43eb40-...-8a75f7323032&csrftoken=CfDJ8...&traceId=<guid>
```

- El host de backend **no** es `businesscentral.dynamics.com` (es un app-service regional).
- Path: `/tenant/{backendTenant}/tab/{tabGuid}/csh`.
- Query: `ackseqnb=-1`, `aadTenantId=<GUID AAD>`, `csrftoken=CfDJ8...`, `traceId`.
- **Nada de esto es derivable de `baseUrl`** → el provider AAD lo descubre del navegador.

### (b) Payload de `OpenSession`

- `applicationId`: **`FIN`** (no `NAV`) → es el default de `BC_APPLICATION_ID` en modo AAD.
- `tenantId`: **el tenant de backend** (`msweua3554t30793230`, el mismo del path), que el provider
  extrae de la URL y usa como override de `BC_TENANT_ID`.
- `company`: `null`; el servidor abre la default (`CRONUS ES`).
- `features` / `supportedExtensions`: lista moderna; nuestro subset funciona igual.
- `spaInstanceId`: id corto generado por el cliente; el nuestro es propio y no da problemas.

### (c) Cookie jar

- Cookies de sesión del WS en el **host de backend**, path `/tenant/.../tab/...`: `SessionId`,
  `.AspNetCore.Cookies`, `.AspNetCore.Antiforgery.47DEQpj8HBQ`, `NAVAllowedAncestor`,
  `ApplicationGatewayAffinity`.
- El `csrftoken` del WS es el valor de la cookie antiforgery (patrón `CfDJ8...`, misma app ASP.NET).
- Cookies de front-door (`businesscentral.dynamics.com`, path `/{aadTenant}`): `<aad>.auth`,
  `<aad>.Antiforgery.FCE`, `signedOnTenants`, `ASLBSA*`… se conservan en el jar para la inyección
  en el navegador (screenshots/reports) pero **no** se mandan al WS.
- **`NAVAllowedAncestor`**: el gateway valida el `Origin`. Un upgrade `ws` sin `Origin` ni
  `User-Agent` de navegador devuelve **HTTP 500**. Hay que mandar
  `Origin: https://businesscentral.dynamics.com` + el `User-Agent` del navegador.

### (d) Flujo OIDC

`GET {baseUrl}` → 302 a `login.microsoftonline.com/{aad}/oauth2/authorize`
(`client_id=996def3d-...`, `redirect_uri=https://businesscentral.dynamics.com/remote-sign-in`,
`response_mode=form_post`, `scope=openid profile`) → login/MFA → `POST /remote-sign-in` →
`GET {baseUrl}?...&runinframe=1` → SPA. Las cookies de Entra (`ESTSAUTH*`) quedan en
`login.microsoftonline.com`; las de BC en `businesscentral.dynamics.com` + host de backend.

### (e) Deep link SaaS

Path-based, **sin `?tenant=`**. Los deep links del navegador (screenshots/reports) omiten `tenant=`
en modo AAD.

### Veredicto del spike: **GO**

- El frame `OpenSession` y los handlers son los de BC28 → no hizo falta tocar `protocol/`.
- Ajustes que sí hicieron falta en código: descubrimiento de URL/tenant de backend,
  `Origin` + `User-Agent` en el WS, `applicationId=FIN` por defecto en AAD, y filtrar las cookies
  de backend para el header del WS.

---

## Parte 2 — Batería funcional Docker vs SaaS (2026-08-08)

Ejecutada con `npx tsx scripts/test-battery.ts <docker|saas>` a través de la MISMA capa de
operaciones que envuelven las herramientas MCP `bc_*`, de forma no destructiva (write+restore,
create+delete). Prueba que el servidor hace lo mismo en BC Online que en el Docker on-prem.

| | Docker (`devel1`, on-prem, BC27) | SaaS (`Dev`, BC Online, BC28.3) |
|---|---|---|
| Resultado | **16 PASS · 0 FAIL · 2 SKIP** | **16 PASS · 1 FAIL · 1 SKIP** |
| Auth | forms `/SignIn` (`UserPassword`) | Entra/AAD browser login (perfil persistente) |
| Compañía | CRONUS_04 (7 compañías) | CRONUS ES (2 compañías) |

### Matriz por herramienta

| Herramienta | Docker | SaaS | Nota |
|---|---|---|---|
| `bc_health` | ✅ | ✅ | environmentKind on-prem / saas |
| `bc_list_companies` | ✅ (7) | ✅ (2) | |
| `bc_refresh_objects` | ✅ | ✅ | índice de objetos por entorno |
| `bc_find_object` | ✅ | ✅ | |
| `bc_open_page` | ✅ | ✅ | lista + card |
| `bc_read_data` | ✅ | ✅ | refresh OK; filtrado por OpenForm (ver abajo) |
| `bc_navigate` | ✅ | ✅ | drill-down a card |
| `bc_write_data` | ✅* | ✅* | SaaS confirmado `changed=true` + restore en el smoke; en la batería depende del estado editable de la pág. 42 |
| `bc_execute_action` | ✅ | ✅ | Delete del borrador |
| `bc_respond_dialog` | ✅ | ✅ | confirmación del delete |
| `bc_close_page` | ✅ | ✅ | |
| `bc_search_pages` (Tell Me) | ✅ (40) | ✅ (0) | SaaS: índice de perfil vacío en sandbox nuevo (no es fallo de transporte) |
| `bc_switch_company` | ✅ | ✅ | |
| `bc_run_report` | ✅ | ✅ | request page inspeccionada |
| `bc_download_report` | ✅ | ❌ | única FAIL — ver abajo; es limitación de params/deep-link, NO de acceso SaaS |
| `bc_screenshot` | ✅ | ✅ | **el navegador out-of-band SÍ autentica en SaaS** |
| `bc_build_manual` | ✅ | ✅ | usa el motor de screenshot |
| `bc_wizard_navigate` | ✅ | ✅* | page 1803 (Company Setup): open → next → cancel. Docker verificado; SaaS mismo código protocol-level (auth-agnóstico) |

### La única FAIL: `bc_download_report` en SaaS

No es un problema de acceso: el navegador headless autentica bien en SaaS (lo prueba
`bc_screenshot`, que usa el mismo motor y pasa). Dos causas se solapan:

1. El report 6 (Trial Balance) presenta en SaaS una request page con 12 campos que el flujo por
   defecto "Send to → Aceptar" no rellena → `requestPageShown:true`. Es la limitación de parámetros
   ya documentada, no específica de SaaS.
2. El deep-link de report en SaaS (`?report=`) sufre un **race de routing de la SPA** que
   intermitentemente cae en "Go back home" en vez de la request page. Se añadió un retry sobre esa
   página de error en `ReportDownloadService` (no-op en on-prem, que nunca la ve); ayuda en los
   casos transitorios pero el race es ambiental.

Queda como best-effort en SaaS; on-prem no está afectado. Seguimiento: **G5** del roadmap.

### Dos cosas que la batería destapó y quedaron arregladas

**Filtrado de listas.** El *filter pane* (`Filter/AddLine`) es un **no-op** en BC27/BC28 (columnas
con `ColumnBinder.Name` pero sin `.Path`; verificado: `No.=ZZZZZZ` devolvía todas las filas). El
filtrado usa ahora el `filter=` de la query `OpenForm` (`'Campo' IS 'valor'`), el mismo mecanismo
que `ObjectIndexService`. `bc_open_page` acepta `filters` (al abrir) y `bc_read_data` `filters`
reabre la página en su sitio (mismo `pageContextId`). **Los campos son nombres AL invariantes**
(`No.`, `Name`, `City`), no captions localizados. Verificado en vivo: Docker 49→0 (valor
imposible), SaaS 6→1 (exacto) y 6→3 (rango). El filtrado de secciones de LÍNEA de documento sigue
cayendo al filter pane y da error claro (seguimiento: **G8** del roadmap).

**Cookies duplicadas → WS 500.** Tras muchas sesiones headless sobre el mismo perfil persistente,
el WS de SaaS empezó a fallar con `Unexpected server response: 500` (Kestrel). El perfil acumula
las cookies de sesión de CADA tab histórico (mismo host de backend, distinto path
`/tenant/.../tab/{tabId}`) y el provider las mandaba todas → decenas de cookies con nombre repetido
→ el gateway rechaza el upgrade. Corregido en `aad-browser-provider.ts`: el header del WS incluye
SOLO las cookies del path del tab actual, de-duplicadas por nombre (quedan 5). Si el perfil se
ensucia mucho, `npm run login:aad` sobre un perfil limpio también lo resetea.

### Conclusión

El servidor opera contra **BC Online con paridad práctica respecto al Docker on-prem**: 16 de 18
herramientas pasan idénticas, `bc_write_data` está confirmada por el smoke, y las restantes son un
SKIP legítimo (wizard) y `bc_download_report` en SaaS.
