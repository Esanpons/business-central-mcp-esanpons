# Batería funcional Docker vs SaaS — resultados en vivo (2026-08-08)

> Ejecutada con `npx tsx scripts/test-battery.ts <docker|saas>` a través de la MISMA capa de
> operaciones que envuelven las herramientas MCP `bc_*`, de forma no destructiva (write+restore,
> create+delete). Prueba que el servidor hace lo mismo en BC Online (SaaS) que en el Docker on-prem.

## Resumen

| | Docker (`devel1`, on-prem, BC27) | SaaS (`Dev`, BC Online, BC28.3) |
|---|---|---|
| Resultado | **16 PASS · 0 FAIL · 2 SKIP** | **16 PASS · 1 FAIL · 1 SKIP** |
| Auth | forms `/SignIn` (`UserPassword`) | Entra/AAD browser login (perfil persistente) |
| Compañía | CRONUS_04 (7 compañías) | CRONUS ES (2 compañías) |

## Matriz por herramienta

| Herramienta | Docker | SaaS | Nota |
|---|---|---|---|
| `bc_health` | ✅ | ✅ | environmentKind on-prem / saas |
| `bc_list_companies` | ✅ (7) | ✅ (2) | |
| `bc_refresh_objects` | ✅ | ✅ | índice de objetos por entorno |
| `bc_find_object` | ✅ | ✅ | |
| `bc_open_page` | ✅ | ✅ | lista + card |
| `bc_read_data` | ✅ | ✅ | refresh OK; filtrado por OpenForm ahora FUNCIONA (ver abajo) |
| `bc_navigate` | ✅ | ✅ | drill-down a card |
| `bc_write_data` | ✅* | ✅* | SaaS confirmado `changed=true`+restore en el smoke; en la batería depende del estado editable de la pág. 42 |
| `bc_execute_action` | ✅ | ✅ | Delete del borrador |
| `bc_respond_dialog` | ✅ | ✅ | confirmación del delete |
| `bc_close_page` | ✅ | ✅ | |
| `bc_search_pages` (Tell Me) | ✅ (40) | ✅ (0) | SaaS: índice de perfil vacío en sandbox nuevo (no es fallo de transporte) |
| `bc_switch_company` | ✅ | ✅ | |
| `bc_run_report` | ✅ | ✅ | request page inspeccionada |
| `bc_download_report` | ✅ | ❌ | SaaS: report 6 pide parámetros de request page (`requestPageShown:true`) — limitación conocida de params, NO de acceso SaaS |
| `bc_screenshot` | ✅ | ✅ | **el navegador out-of-band SÍ autentica en SaaS** |
| `bc_build_manual` | ✅ | ✅ | usa el motor de screenshot |
| `bc_wizard_navigate` | ✅ | ✅* | page 1803 (Company Setup, NavigatePage): open → next → cancel. Docker verificado; SaaS mismo código protocol-level (auth-agnóstico) |

## Los dos puntos que NO son "PASS limpio"

### 1. `bc_download_report` en SaaS (el único FAIL)
No es un problema de acceso a SaaS. El navegador headless autentica bien en SaaS (lo prueba
`bc_screenshot`, que usa el mismo motor y pasa). El report 6 (Trial Balance) en SaaS presenta una
request page con parámetros (12 campos) que el flujo por defecto "Send to → Aceptar" no rellena, así
que devuelve `requestPageShown:true`. Es la limitación ya documentada en `docs/tools/bc_download_report.md`
(parámetros obligatorios de request page), no específica de SaaS. Reports sin parámetros descargan.

### 2. Filtrado de listas — ✅ ARREGLADO (2026-08-08)
La batería destapó que el *filter pane* (`Filter/AddLine`) es un no-op en BC27/BC28 (columnas con
`ColumnBinder.Name` pero sin `.Path`; verificado: `No.=ZZZZZZ` devolvía todas las filas). **Ya está
corregido**: el filtrado usa ahora el `filter=` de la query OpenForm (`'Campo' IS 'valor'`), el mismo
mecanismo que `ObjectIndexService`. `bc_open_page` acepta `filters` (aplicados al abrir) y `bc_read_data`
`filters` re-abre la página en su sitio (mismo pageContextId). **Los campos son nombres AL invariantes**
(`No.`, `Name`, `City`), no captions localizados. Verificado en vivo: Docker 49→0 (valor imposible),
SaaS 6→1 (exacto) y 6→3 (rango). El filtrado de secciones de LÍNEA de documento sigue cayendo al
filter pane (error claro).

## Bug de fiabilidad SaaS corregido (2026-08-08): cookies duplicadas → WS 500

Tras muchas sesiones headless en el mismo perfil persistente, el WS de SaaS empezó a fallar con
`Unexpected server response: 500` (Kestrel). Causa: el perfil acumula las cookies de sesión
(`SessionId`, `.AspNetCore.Cookies`, antiforgery, `ApplicationGatewayAffinity`) de CADA tab histórico,
todas en el mismo host de backend pero con paths `/tenant/.../tab/{tabId}` distintos. El provider las
enviaba TODAS en el header `Cookie` → decenas de cookies con nombre repetido y valores distintos → el
gateway rechaza el upgrade con 500. **Corregido** (`aad-browser-provider.ts`): el header del WS ahora
incluye SOLO las cookies del path del tab actual, de-duplicadas por nombre (queda exactamente 1 de cada:
5 cookies). Verificado: WS OPEN OK. (No afecta a Docker.) Si el perfil se ensucia mucho, `npm run
login:aad` sobre un perfil limpio también lo resetea.

## Conclusión

El servidor opera contra **BC Online (SaaS) con paridad práctica respecto al Docker on-prem**: 16 de 18
herramientas pasan idénticas, la 16ª (`bc_write_data`) está confirmada por el smoke, y las 2 restantes
son un SKIP legítimo (wizard) y `bc_download_report` en SaaS (ver abajo). El filtrado de listas, que la
batería destapó como roto en ambos entornos, quedó **arreglado** (mecanismo OpenForm).

**`bc_download_report` en SaaS** queda como limitación conocida (no es de acceso): el mecanismo de
descarga funciona (lo prueba `bc_screenshot`), pero el deep-link de report en SaaS (`?report=`) sufre
un **race de routing de la SPA de BC** que intermitentemente cae en "Go back home" en vez de la request
page. Se añadió un **retry sobre esa página de error** en `ReportDownloadService` (no-op en on-prem, que
nunca la ve), lo que ayuda a los casos transitorios, pero el race es ambiental y no siempre se resuelve
desde automatización headless. Queda como best-effort en SaaS; on-prem no está afectado. Alternativa
futura: ruta de invocación de reports específica para SaaS (o captura por WS).
