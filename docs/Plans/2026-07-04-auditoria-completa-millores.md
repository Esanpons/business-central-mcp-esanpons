# Auditoria completa 2026-07-04 — Bugs, millores i pla SaaS

> **ESTAT D'IMPLEMENTACIÓ (2026-07-04).** Fets al working tree i verificats amb `tsc` +
> `vitest` (370 tests verds) + `npm run build`: **tots** els bugs crítics (B1–B4), **tots** els
> mitjans (M1–M19) i la majoria dels baixos (L1, L3, L4, L7, L8, L9, L10, L11, L13, L14, L16,
> L17, L18), més la neteja de tests/docs/metadata (T1, T5–T9). Vegeu el detall a
> [`CHANGELOG.md`](../../CHANGELOG.md) secció *Fixed (2026-07-04 audit)*.
>
> **Diferits conscientment** (amb motiu): **L2** (race de recuperació de sessió — baix, i el
> camí de recovery és crític per al mode Docker: no tocar sense test concurrent live); **L5**
> (regles DST hardcodejades — complex, impacte baix); **L6** (acking de seqüència síncrona —
> latent, ja mitigat per `disableResponseSequencing`); **L12** (resposta a
> `notifications/initialized` per HTTP — canvi de contracte arriscat; l'stdio, transport
> principal, ja ho fa bé); **L15** (captions de la request-page de reports només ES/CA/EN —
> cal BC no-castellà per verificar); **L19** (`buildServices({} as BCSession)` a stdio — no
> disparat per cap constructor actual). **M10** (events d'eliminació de fila) s'ha implementat
> *best-effort/defensiu* (no-op si el format del wire no coincideix) perquè les fonts
> decompiled no eren accessibles per verificar-lo.
>
> **PENDENT (regla d'or §1):** executar la suite d'integració contra `devel1`
> (`npx vitest run --config vitest.integration.config.ts`) com a gate de regressió del mode
> Docker — no s'ha pogut executar aquí (cal el contenidor viu). El SaaS (§7) NO s'ha començat.
>
> **⚠️ DESACTUALITZAT (2026-08-08): el SaaS JA ESTÀ FET I VERIFICAT EN VIU.** Aquesta auditoria és
> de 2026-07-04. El suport SaaS (§7) es va implementar i verificar contra el sandbox `Dev` el
> 2026-08-08 — vegeu [`2026-08-08-saas-sandbox.md`](2026-08-08-saas-sandbox.md) (estat + bateria
> 15/18 PASS), [`saas-spike.md`](saas-spike.md) i [`saas-battery.md`](saas-battery.md). Ignoreu el
> "SaaS NO s'ha començat" d'aquest document històric.



> **Propòsit d'aquest document.** És l'ordre de treball completa perquè una IA (o un
> desenvolupador) pugui arreglar tots els bugs trobats i implementar les millores, **sense
> necessitar cap altre context**. Cada troballa porta: fitxer i línia, defecte, causa arrel,
> escenari concret de fallada, severitat, proposta de fix i com verificar-ho.
>
> **Origen.** Auditoria feta el 2026-07-04 amb 4 agents en paral·lel: (1) nucli
> protocol/sessió/connexió, (2) capa MCP/operations/services, (3) viabilitat SaaS/OAuth,
> (4) tests/docs/DX. Estat del repo en el moment de l'auditoria: commit `33318cb`, branca
> `master`, `npx tsc --noEmit` net, `npx vitest run` 355/355 verd.

---

## 0. Context del projecte (per a qui no el conegui)

Aquest repo és un **servidor MCP per a Microsoft Dynamics 365 Business Central** que parla el
**protocol WebSocket del web client de BC** (reverse-engineered): fa un login de formulari
ASP.NET (`POST /SignIn` → cookies), obre `wss://<host>/BC/csh?csrftoken=...&ackseqnb=-1` i
intercanvia frames JSON-RPC (`OpenSession`, `Invoke` amb interaccions, respostes com a arrays
de handlers). Sobre això exposa ~18 tools MCP (`bc_open_page`, `bc_read_data`, `bc_write_data`,
`bc_execute_action`, `bc_navigate`, `bc_search_pages`, `bc_find_object`, `bc_refresh_objects`,
`bc_run_report`, `bc_download_report`, `bc_screenshot`, `bc_build_manual`, `bc_health`,
`bc_switch_company`, `bc_list_companies`, `bc_respond_dialog`, `bc_close_page`,
`bc_wizard_navigate`).

Arquitectura per capes: `connection/ -> protocol/ -> session/ -> services/ -> operations/ ->
mcp/ + api/`. Detalls de protocol verificats contra el codi decompiled de BC — vegeu
`CLAUDE.md` (seccions "BC Protocol Patterns" i "Architecture Overview") abans de tocar res del
protocol.

**Entorn de proves viu**: contenidor Docker local `devel1`
(`mcr.microsoft.com/businesscentral:ltsc2025`, BC 27), `https://devel1/BC`, usuari `admin`,
auth `NavUserPassword`, TLS self-signed (`NODE_TLS_REJECT_UNAUTHORIZED=0`),
`BC_APPLICATION_ID=NAV`. Les credencials d'integració són a `.secrets/devel1.env` (mai
scraping de `~/.claude.json`).

**Comandes essencials** (des de l'arrel del repo):

```bash
npx tsc --noEmit                                        # typecheck (obligatori després de cada canvi)
npx vitest run                                          # tests unitaris + protocol
npx vitest run --config vitest.integration.config.ts    # integració contra devel1 (cal el contenidor viu)
npm run build                                           # compila a dist/
```

**Regles del projecte** (de `CLAUDE.md`, resumides):
- Projecte no publicat: refactoritza agressivament, no facis workarounds, no deixis stubs.
- ESM: extensions `.js` a tots els imports.
- Mai `2>nul`, mai emojis (Windows).
- Verifica supòsits de protocol contra el codi decompiled, no contra v1.
- **Cap acció de git per iniciativa pròpia** (ni branques, ni commits, ni push): tot el
  treball al working tree; l'usuari gestiona git.

---

## 1. REGLA D'OR: no trencar el que ja funciona (Docker / on-prem)

Tot el que es faci en aquest pla — especialment la part SaaS (§7) — ha de complir:

1. **El mode actual (NavUserPassword contra contenidor Docker) és el mode per defecte i no
   canvia de comportament.** Cap variable d'entorn existent (`BC_BASE_URL`, `BC_USERNAME`,
   `BC_PASSWORD`, `BC_TENANT_ID`, `BC_APPLICATION_ID`, `BC_SERVER_MAJOR`, ...) canvia de
   semàntica ni esdevé obligatòria/opcional de manera diferent **quan no s'activa el mode
   nou**.
2. Tota funcionalitat SaaS s'activa **només** amb una variable nova explícita
   (`BC_AUTH=AAD`). Si `BC_AUTH` no està definida o és `UserPassword`, el flux ha de ser
   byte-per-byte l'actual (mateix `/SignIn`, mateixes cookies, mateixa URL WS amb
   `?tenant=`).
3. Després de cada milestone: `npx tsc --noEmit` + `npx vitest run` verds, i **la suite
   d'integració contra `devel1` verda** (és la xarxa de seguretat de regressió del mode
   Docker). Si `devel1` no està disponible, deixar-ho anotat i no donar el milestone per
   tancat.
4. Els tests unitaris existents no es "readapten" per fer-los passar: si un test falla per un
   canvi, primer entendre si el canvi és correcte.

---

## 2. BUGS GREUS (arreglar primer, per aquest ordre)

### B1 — `bc_execute_action` ignora `bookmark`/`rowIndex`: pot actuar sobre la fila equivocada (DESTRUCTIU)

- **On**: `src/operations/execute-action.ts:43-56` + `src/services/action-service.ts:206-224`.
- **Defecte**: l'esquema i la descripció de la tool (`src/mcp/tool-registry.ts:140,147` —
  exemple literal: "Delete a row: { action: 'Delete', bookmark: '...' }") prometen targeting
  de fila, però l'operation **mai llegeix `input.bookmark` ni `input.rowIndex`**, i
  `ActionService` no fa cap pas de selecció de fila abans d'executar la system action. Les
  accions de fila (Delete=20, Edit=40, View=60, DrillDown=120) resolen a
  `{repeaterPath}/cr/c[0]`, és a dir la fila **actualment seleccionada al servidor**.
- **Escenari de fallada**: l'agent crida `{ action: "Delete", bookmark: "rowX" }` sobre una
  llista on el cursor del servidor és en una altra fila → **s'esborra el registre equivocat**
  i la resposta diu `success: true`. Silenciós i destructiu.
- **Fix proposat**: abans d'executar una system action de fila quan arriba `bookmark` o
  `rowIndex`, fer el mateix pas de selecció que ja fa `NavigationService` per a
  `selectRow`/`drill_down` (interacció `SelectRow` / `ActivateRow` amb el bookmark contra el
  repeater; mireu `src/services/navigation-service.ts` com resol bookmark → fila). Si el
  bookmark no existeix a `FormState.rows`, retornar error clar amb els bookmarks disponibles
  (no executar res). Si no arriba ni `bookmark` ni `rowIndex` i l'acció és de fila, mantenir
  el comportament actual (fila seleccionada) però documentar-ho.
- **Verificació**: test d'integració contra `devel1`: obrir Customer List (p. 22), llegir 3
  bookmarks, executar `DrillDown` amb el bookmark de la fila 3 mentre la selecció és a la
  fila 1, comprovar que la card oberta és el client de la fila 3. Per a Delete, fer-ho amb un
  registre de prova creat pel mateix test.

### B2 — El timeout d'invoke inclou el temps d'espera a la cua: crides concurrents maten una sessió sana

- **On**: `src/session/bc-session.ts:125-129` (i el handler de timeout a `140-145`).
- **Defecte**: `withTimeout(this.enqueue(...), effectiveTimeout + 5000)` embolcalla la
  promesa **encuada**, així que el temporitzador comença abans que la interacció s'enviï a
  BC. El handler del timeout fa `markDead()` + `ws.close()`.
- **Escenari**: 3 tool calls concurrents (real: el servidor HTTP atén peticions concurrents,
  i l'stdio fa `rl.on('line', async)` sense await — reconegut a
  `src/session/session-manager.ts:136-139`). Cada invoke triga ~15 s a BC; el tercer espera
  ~30 s a la cua, el seu timer de 35 s salta mentre encara és a la cua → es mata el WebSocket
  amb l'invoke d'un ALTRE caller en vol → recreació completa de sessió, pèrdua de tots els
  page contexts i `SessionLostError`, amb BC perfectament sa.
- **Fix proposat**: moure el `withTimeout` DINS del cos encuat, de manera que el rellotge
  comenci quan la interacció s'envia realment (just abans del `send`). El temps d'espera a la
  cua no ha de comptar. Opcionalment un segon timeout més llarg "de cua" que NO mati la
  sessió, només rebutgi la crida amb un error retriable.
- **Verificació**: test unitari amb un fake WebSocket que triga X ms per invoke: encuar 3
  invokes amb timeout < 2X i comprovar que cap mata la sessió i tots completen.

### B3 — Els filtres de `bc_read_data` s'acumulen per sempre (`clearFilters` és codi mort)

- **On**: `src/operations/read-data.ts:39-42` + `src/services/filter-service.ts:91`.
- **Defecte**: cada `bc_read_data` amb `filters` fa `Filter(AddLine)` SOBRE les línies de
  filtre anteriors del mateix page context. `FilterService.clearFilters` existeix però ningú
  no el crida i cap tool/paràmetre l'exposa.
- **Escenari**: llegir amb `{ City: "London" }` i després amb `{ City: "Paris" }` → BC fa AND
  dels dos → 0 files, sense cap pista del perquè. L'única recuperació és tancar i reobrir la
  pàgina. Dades errònies silencioses. (Probablement explica també observacions passades tipus
  "no trobo un client concret a la llista".)
- **Fix proposat**: per defecte, quan `bc_read_data` rep `filters`, **netejar primer** els
  filtres previs (cridar `clearFilters` o `Filter(RemoveLine)` per línia) i aplicar els nous.
  Afegir paràmetre opcional `appendFilters: true` per al comportament acumulatiu conscient.
  Guardar al page context quins filtres hi ha aplicats i retornar-los a la resposta
  (`activeFilters`) perquè l'agent sàpiga sempre l'estat.
- **Verificació**: integració: Customer List, filtrar per una ciutat, després per una altra;
  comprovar que la segona lectura retorna files (no 0) i que `activeFilters` reflecteix només
  el segon filtre.

### B4 — Detecció de mort de sessió per substring `'"code":1'`

- **On**: `src/session/bc-session.ts:214`.
- **Defecte**: `msg.includes('"code":1')` sobre l'error serialitzat amb
  `JSON.stringify(msg['error'])` (`src/connection/bc-websocket.ts:131`). Qualsevol codi que
  COMENCI per 1 (`"code":10`, `"code":12`, `"code":100`, `"code":19`, ...) conté el
  substring → `markDead()` i teardown complet per un error no fatal.
- **Fix proposat**: usar la mateixa regex amb word-boundary que ja usa (correctament)
  `src/core/error-translator.ts:33`: `/"code"\s*:\s*1\b/`. Idealment extreure la comprovació
  a una funció compartida per no tornar a divergir.
- **Verificació**: test unitari: injectar un error amb `"code":12` i comprovar que la sessió
  NO es marca morta; amb `"code":1` sí.

---

## 3. BUGS MITJANS

### M1 — El `context` i el `code` dels errors es descarten a la frontera MCP (la millora d'ergonomia més rendible)

- **On**: `src/mcp/handler.ts:144-153`. (El path REST, `src/api/routes.ts:63`, conserva
  `code` però també perd `context`.)
- **Defecte**: només se serialitza `r.error.message`. `ProtocolError.context`
  (`availableActions`, `availableSections`, `availableColumns`, `availableFields`,
  `availableCues`, `availableGroups`, `hostHint`...) mai arriba al model. A més
  `translateBcError()` re-deriva el codi del text del missatge, així que els codis tipats
  documentats (`PAGE_NOT_MATERIALIZED`, `CARDPART_STUB`, `SCREENSHOT_ERROR`...) degraden a
  `BC_ERROR` genèric.
- **Impacte**: tota la inversió en errors auto-correctius (roadmap "Self-correcting
  field/action errors") ja està FETA a les capes de sota i es perd a l'última milla. L'agent
  ha de fer crides extra de descobriment per saber què hi havia disponible.
- **Fix**: al handler, si `r.error` té `code` propi, usar-lo (no re-derivar); serialitzar
  `context` dins del JSON d'error de la resposta MCP. Mateixa cosa al path REST.
- **Verificació**: unitari: forçar un "Action not found" i comprovar que la resposta MCP
  inclou `availableActions`; forçar un `CARDPART_STUB` i comprovar que `code` es conserva.

### M2 — `bc_navigate` amb `action: "lookup"` no implementat; `field` mai es llegeix

- **On**: `src/operations/navigate.ts:29-52`; `NavigationService.drillDown` no té paràmetre
  de camp.
- **Defecte**: només `drill_down` té branch; `lookup` cau al camí de `selectRow` i es reporta
  èxit. El paràmetre `field` (present a l'esquema) no es referencia enlloc.
- **Escenari**: l'agent crida `{ action: "lookup", field: "No." }` → s'executa un moviment de
  cursor, resposta success amb seccions → l'agent creu que el lookup s'ha obert.
- **Fix**: implementar `lookup` amb `SystemAction.Lookup=110` contra el controlPath del camp
  indicat (resoldre `field` per caption/controlPath com fa `bc_write_data`), o — si es
  decideix no implementar-ho encara — treure `lookup` i `field` de l'esquema i la descripció
  perquè la tool no menteixi.

### M3 — `bc_switch_company` no verifica ni propaga el canvi de companyia

- **On**: `src/operations/switch-company.ts:44-52` + `src/session/bc-session.ts:69,96`.
- **Defecte**: `extractSessionCredentials` (únic que escriu `this.company`) només corre a
  `initialize()`. L'operation retorna `newCompany: input.companyName` davant de qualsevol
  `InvokeCompleted` sense confirmar el canvi (el `SessionSettingsChangedHandler` de la
  resposta porta la companyia real — vegeu CLAUDE.md "Company Switching").
- **Escenari**: canvies a companyia B; després `bc_screenshot`/`bc_download_report` sense
  `company` explícit generen el deep link amb `company=<A antiga>`
  (`src/services/screenshot-service.ts:90`, `src/services/report-download-service.ts:84`, via
  `() => s.companyName`) → **captures dades de la companyia equivocada**. `bc_health` també
  reporta la companyia antiga.
- **Fix**: parsejar el `SessionSettingsChangedHandler` de la resposta del
  `InvokeSessionAction(ChangeCompany=500)`, actualitzar `session.company` amb el valor REAL,
  i retornar aquest valor. Si el handler no arriba, retornar error (no success especulatiu).

### M4 — `tenantId` hardcodejat a `'default'` a PageService

- **On**: `src/services/page-service.ts:78`.
- **Defecte**: el `query` d'`OpenForm` usa el literal `'default'` en lloc de
  `config.bc.tenantId`. L'esquema (`src/mcp/schemas.ts:12`) diu "Defaults to the
  server-configured tenant". Compareu amb `ObjectIndexService`, que sí que el rep
  (`src/services/object-index-service.ts:111`).
- **Fix**: injectar el tenant configurat a `PageService` (mateix patró que
  ObjectIndexService).

### M5 — Tancar una pàgina bruta encalla la sessió (diàleg "voleu desar?" orfe)

- **On**: `src/operations/close-page.ts` + `src/services/page-service.ts:347-383`.
- **Defecte**: `closePage` mai passa `discardChanges`; `repo.remove(pageContextId)` s'executa
  incondicionalment i el resultat retorna `requiresDialogResponse: true` — però
  `bc_respond_dialog` (`src/operations/respond-dialog.ts:37-38`) exigeix un `pageContextId`
  viu, que acabem d'esborrar.
- **Escenari**: tancar una card modificada → el diàleg queda obert server-side → el següent
  invoke mor amb `LogicalModalityViolationException` (MODAL_STUCK) i reset de sessió.
- **Fix**: NO esborrar el context si la resposta al close conté un `DialogToShow`; mantenir el
  context viu fins que el diàleg es respongui (i esborrar-lo llavors). Afegir paràmetre
  `discardChanges?: boolean` a `bc_close_page` que respongui automàticament el diàleg amb
  No/Yes segons pertoqui.

### M6 — Pàgines obertes per una acció normal no obtenen pageContextId (`openedPages` sempre buit)

- **On**: `src/services/action-service.ts:227-264` (el registre d'ownerless-`FormCreated`
  només existeix a `executeOnCue`, línies 138-147); `src/operations/execute-action.ts:76-85`
  confia en `repo.getByFormId`, que mai indexa aquests forms.
- **Escenari**: `{ action: "New" }` sobre una llista (exemple documentat) obre una card →
  `openedPages: []` → la pàgina nova és inassolible i intancable via MCP; a més el
  `updateRootForm` mal-atribuït pol·lueix el map de forms del context origen
  (`src/protocol/page-context-repo.ts:139-145`).
- **Fix**: replicar a `execute()` el mateix registre d'ownerless FormCreated que ja fa
  `executeOnCue` (registrar el form nou com a page context fresc i retornar-lo a
  `openedPages`).

### M7 — El workflow documentat de `bc_run_report` és impossible

- **On**: `src/operations/run-report.ts` + descripció a `src/mcp/tool-registry.ts:245`.
- **Defecte**: la descripció diu "fill in parameters using bc_write_data and then execute
  with bc_respond_dialog", però `bc_run_report` no crea cap page context i `bc_write_data`
  només pot escriure dins de forms d'un page context — la request page (`dialogFormId`) no és
  adreçable per cap tool.
- **Fix (opció recomanada)**: fer que `bc_run_report` registri la request page com a page
  context (com el fix M6) perquè `bc_write_data`/`bc_respond_dialog` hi funcionin de debò.
  Opció mínima: corregir la descripció perquè apunti a `bc_download_report` amb `filters`.

### M8 — Cada `bc_search_pages` filtra un formulari Tell Me que mai es tanca

- **On**: `src/services/search-service.ts:29-92`.
- **Defecte**: el Tell Me s'obre com a `FormCreated` i es queda a `session.openFormIds` per
  sempre; es re-envia a cada request posterior i l'estat server-side creix a cada cerca.
- **Fix**: enviar `CloseForm` del formId de Tell Me al final de la cerca (en `finally`), i
  treure'l del tracking.

### M9 — Login amb password incorrecte no es detecta

- **On**: `src/connection/auth/ntlm-provider.ts:52-101`.
- **Defecte**: mai es comprova l'estatus del `POST /SignIn` (èxit real = 302; password
  dolent = 200 amb la pàgina de login re-renderitzada). Com que la cookie antiforgery del GET
  ja és al jar, l'extracció de CSRF "funciona" i `authenticated = true`. L'error apareix
  després com a fallada críptica de WebSocket/OpenSession i cada reconnexió crema el cicle
  complet de backoff.
- **Fix**: si el POST no retorna 302 (o no arriba cap cookie `.AspNetCore.Cookies`), retornar
  `AuthenticationError` clar ("Invalid username or password for <baseUrl>") sense reintents.

### M10 — El decoder ignora els esdeveniments d'esborrat/inserció de fila

- **On**: `src/protocol/event-decoder.ts:50-67`; els tipus són coneguts a
  `src/protocol/wire-types.ts:9-24` (`DataRowRemoved`/`drrch`, `DataRowPropertyChange`,
  `ChildInserted`/`ChildRemoved`) però cauen del switch sense decodificar.
- **Escenari**: després d'esborrar una fila, si BC publica `DataRowRemoved` en lloc d'un
  refresh complet, `FormState.rows` conserva la fila esborrada → una acció posterior per
  bookmark falla amb `InvalidBookmarkException`.
- **Fix**: decodificar aquests tipus a `BCEvent`s i aplicar-los a `FormState.rows`
  (eliminar/actualitzar la fila per bookmark). Verificar el format del payload contra el codi
  decompiled (`BrowserLogicalChangeTypeIds.cs`) abans d'implementar.

### M11 — El merge de `DataLoaded` amb `currentRowOnly` perd files noves

- **On**: `src/protocol/form-state.ts:57-60` (i `extractRows` a 96-111 ignora l'índex de fila
  `rowData[0]`, perdent l'ordre).
- **Defecte**: `existing.map(r => extractedRows.find(x => x.bookmark === r.bookmark) ?? r)`
  només actualitza bookmarks ja existents: una fila inserida (p. ex. després de `New` en un
  grid de línies) o amb bookmark canviat es descarta; si `existing` és buit, es descarta tot.
- **Fix**: fer un merge que afegeixi bookmarks nous (respectant l'índex de `rowData[0]` per a
  l'ordre) a més d'actualitzar els existents.

### M12 — Bookkeeping append-only al PageContext: creixement de memòria i estat estancat

- **On**: `src/protocol/page-context-repo.ts:331-342` (`addDialog` guarda el `controlTree`
  cru sencer i mai s'elimina cap entrada — `markFormClosed` a la línia 313 només invalida
  seccions); `ownedFormIds` (línies 262, 338, 398), `page.forms` i `formIdIndex` també només
  creixen; el map `pages` no té cap límit ni evicció (només `bc_close_page` via
  `page-service.ts:380` o mort de sessió).
- **Escenari**: un role center obert mentre un agent fa drill-downs/diàlegs repetits acumula
  cada control tree de cada diàleg per a tota la vida del procés.
- **Fix**: a `markFormClosed`, eliminar el diàleg de `page.dialogs`, l'entrada de
  `formIdIndex` i el formId d'`ownedFormIds`. Considerar no guardar el `controlTree` cru al
  diàleg (només el derivat necessari).

### M13 — Els events del reconcile del modal-stack no arriben mai al PageContextRepository

- **On**: `src/session/bc-session.ts:230-257` (el comentari a 226-228 promet el contrari);
  `reconcileModalStack()` (línia 374) retorna `Result<void>` i els events dels seus
  sub-invokes no es fusionen amb `allEvents` (només la resposta del retry, línia 256).
- **Escenari**: BC emet `FormClosed` per un diàleg estancat abortat; `_openFormIds` i
  `modalStack` interns s'actualitzen, però el repo de page contexts no ho veu →
  `page.dialogs` i la validesa de seccions queden estancades i `derivePageState` segueix
  reportant un diàleg que ja no existeix.
- **Fix**: fer que `reconcileModalStack` retorni els events decodificats dels sub-invokes i
  concatenar-los a `allEvents` abans de retornar-los al caller.

### M14 — `deriveSection` pot llençar amb control trees no-`lf` (camí germà sí protegit)

- **On**: `src/protocol/page-context-repo.ts:235` (usa el tolerant
  `tryBuildFormTree(...) ?? childForm.root`) però la línia 242 crida
  `sectionResolver.deriveSection(...)` que fa `buildFormTree` SENSE protecció
  (`src/protocol/section-resolver.ts:40`), i `buildFormTree` llença si `t !== 'lf'`
  (`src/protocol/form-tree-builder.ts:32-34`). Mateix patró a
  `registerDiscoveredChildForm` (`page-context-repo.ts:373` vs `381`).
- **Escenari**: un `FormCreated` amb `parentFormId` el controlTree del qual no és un `lf`
  correcte (exactament el cas que `tryBuildFormTree` tolera) fa que `applyEvents` llenci un
  `Error` no traduït a mig lot, avortant els events restants i deixant el context a mitges.
- **Fix**: passar el root ja tolerant a `deriveSection` (o fer que `SectionResolver` usi
  `tryBuildFormTree` i retorni null si no pot).

### M15 — `initialize()` no captura els Messages asíncrons durant la inicialització

- **On**: `src/session/bc-session.ts:52-94`.
- **Defecte**: a diferència d'`invokeUnqueued` (que registra `ws.onMessage` abans d'enviar,
  línia 172), `initialize` envia `OpenSession` i simplement dorm 150 ms (línia 66) sense cap
  handler: els handler arrays lliurats com a notificacions `Message` asíncrones durant l'init
  (incloent-hi un diàleg de llicència tardà) no es decodifiquen mai.
- **Fix**: registrar el mateix col·lector de missatges que `invokeUnqueued` durant la
  finestra d'init i passar els events a `findLicenseDialog`/`updateFormTracking`.

### M16 — `respond_dialog` amb `response: "close"` no aplica els events al context

- **On**: `src/operations/respond-dialog.ts:41-57` — al branch `CloseForm` li falta el
  `this.repo.applyToPage(...)` que el branch de systemAction sí que té (línia 78).
- **Conseqüència**: `detectChangedSections` corre contra l'estat pre-close i el context
  segueix tracking el form del diàleg tancat.
- **Fix**: afegir el mateix `applyToPage` al branch de close.

### M17 — `LOG_REDACT_VALUES` és un no-op i es loguegen valors de negoci a nivell info

- **On**: `src/core/config.ts:93` (ningú llegeix `logging.redactValues`);
  `src/services/data-service.ts:306` (`writeLineCell: ${fieldName} = ${value}` a info);
  `src/services/filter-service.ts:74` (valors de filtre a info).
- **Conseqüència**: valors escrits (potencialment dades personals/financeres) acaben a
  `logs/server.log` sense cap interruptor funcional de redacció.
- **Fix**: implementar la redacció (si `redactValues`, loguejar `<redacted>` en lloc del
  valor) o com a mínim baixar aquests logs a `debug`.

### M18 — `bc_write_data.fields` rebutja valors no-string (fallada previsible al primer intent)

- **On**: `src/mcp/schemas.ts:41` — `z.record(z.string(), z.string())`.
- **Defecte**: `{ "Quantity": 5 }` falla amb un dump JSON cru de Zod
  (`src/mcp/handler.ts:118`). Sense coerció (a diferència de `pageId`/`reportId` que accepten
  number). El mateix passa a `bc_download_report.filters`.
- **Fix**: `z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String))`
  (o `z.coerce.string()`), i fer el missatge d'error de validació Zod llegible (camp + motiu,
  no el dump sencer).

### M19 — `page-context-validator.ts` és codi mort: el bon error de "unknown pageContextId" mai s'usa

- **On**: `src/mcp/page-context-validator.ts:5`; les operations retornen el pelat
  `Page context not found: X` (`src/operations/read-data.ts:36`,
  `src/services/action-service.ts:47`, etc.).
- **Fix**: cablejar el validator (o la seva lògica) a totes les operations que reben
  `pageContextId`, incloent al missatge la llista de contexts oberts (id + pàgina + caption).

---

## 4. BUGS BAIXOS (arreglar quan es toqui la zona; cap és urgent)

| # | On | Defecte | Fix suggerit |
|---|----|---------|--------------|
| L1 | `src/session/bc-session.ts:85` | La dismissió del diàleg de llicència només esborra d'`_openFormIds`, no del `modalStack` (el patró correcte és `removeOpenForm`, línia 340). Si BC no emet `FormClosed`, queda una entrada estancada i el següent reconcile aborta un form inexistent. | Usar `removeOpenForm`. |
| L2 | `src/session/session-manager.ts:75-129` | Un caller concurrent durant la recuperació veu `session === null`, pren el branch de primera creació i NO rep el `SessionLostError` → falla després amb "page context not found" confús. També es duplica `recordSessionCreated` a mètriques. | Distingir "recuperant" de "mai creat" amb un flag; ambdós callers han de rebre `SessionLostError` si hi havia contexts. |
| L3 | `src/connection/auth/ntlm-provider.ts:83-93` | El token CSRF s'identifica pel prefix de VALOR `CfDJ8` (comú a totes les cookies protegides d'ASP.NET Core); la correcció depèn de l'ordre d'inserció. | Matxejar pel NOM de cookie `.AspNetCore.Antiforgery.*`. |
| L4 | `src/core/logger.ts:20-21` | Els WriteStreams no tenen handler `'error'` (un error d'escriptura tomba el procés Node) i mai es tanquen/flushegen. | Afegir `stream.on('error', ...)` + flush a shutdown. |
| L5 | `src/protocol/interaction-encoder.ts:127-146` | El timezone hardcodeja regles DST europees (`dstOffset: 60`, últims diumenges de març/octubre) i barreja semàntica local/UTC (`lastSunday` local + `toISOString()`). | Derivar del host amb `Intl`/offsets reals, o com a mínim fer-ho configurable. |
| L6 | `src/connection/bc-websocket.ts:139-150` | `lastServerSequence` només avança amb Messages asíncrons; el `SequenceNumber` de les respostes síncrones (decodificat a `event-decoder.ts:95`) mai es realimenta. Mitigat perquè `encodeOpenSession` envia `disableResponseSequencing: true` (`interaction-encoder.ts:122`) — trampa latent. | Alimentar també el sequence de respostes síncrones, o deixar un comentari-guàrdia al costat del flag. |
| L7 | `src/connection/bc-websocket.ts:116-121` | `catch {}` silenciós als handlers de missatge: un bug en un consumer d'`onMessage` desapareix sense rastre. | Loguejar l'excepció a error. |
| L8 | `src/core/config.ts:52-58` | Els ints d'env no validen rang: `BC_INVOKE_TIMEOUT=0` o negatiu fa que tots els timeouts saltin immediatament. També doc-drift: CLAUDE.md diu reconnect 4 retries/1 s; el codi té 6/2000 ms (`config.ts:86-87`). | Validar > 0 amb error clar; alinear CLAUDE.md amb el codi. |
| L9 | `src/server.ts:162` | Qualsevol URL desconeguda dispara `ensureReady()` → un port-scan o un browser probe força login BC + sessió WS abans del 404. A més `GET /health?query` esquiva el short-circuit exacte (línia 144) i respon `{status:"healthy"}` estàtic havent forçat sessió. | Fer el 404 abans d'`ensureReady`; matxejar `/health` per pathname. |
| L10 | `src/server.ts:182` | Sense `server.on('error')`: un EADDRINUSE peta amb unhandled event. | Handler amb missatge clar i exit code. |
| L11 | `src/api/middleware.ts:18-20,3` | HTTP sense auth per defecte (mitigat pel bind loopback + guard de `config.ts:70`), comparació de token no constant-time, `parseJsonBody` sense límit de mida. | `crypto.timingSafeEqual`, límit de body (p. ex. 1 MB), documentar l'exposició local. |
| L12 | `src/mcp/handler.ts:41-42` | `notifications/initialized` rep objecte de resposta; per HTTP se serialitza com a resposta JSON-RPC sense `id` (frame invàlid). L'stdio la suprimeix bé. | No respondre les notificacions també al path HTTP. |
| L13 | `src/services/manual-render.ts:49-51` | `esc()` no escapa `"` → un heading amb cometes dobles trenca l'atribut `alt="..."` a l'HTML del PDF. | Escapar `"` (i `'`). |
| L14 | `src/operations/run-report.ts:29` | `parseInt` sense check de NaN: `{ reportId: "abc" }` passa l'esquema i envia `report=NaN` a BC. | Validar NaN i retornar error clar. |
| L15 | `src/services/report-download-service.ts:192-201` | El drive de la request page només coneix captions ES/CA/EN ("Enviar a", "Send to", "Aceptar", "OK"); en un BC alemany/francès falla silenciosament reportant `requestPageShown: true` enganyós. | Matxejar per rol/posició del botó a més del caption, o ampliar el diccionari i reportar "caption no reconegut". |
| L16 | `src/operations/list-companies.ts:36` | El nom de companyia és "la primera cel·la string" de cada fila: si la primera columna string no és el nom, retorna noms equivocats. `name`/`displayName` sempre idèntics (promesa buida de l'output). | Resoldre la columna pel caption/name de columna, no per posició. |
| L17 | `src/core/config.ts:92-104` | Els dirs relatius per defecte (`./logs`, `./.state`, `./screenshots`, `.arxius/reports`) resolen contra el cwd del launcher en mode stdio: `createLogger` fa `mkdirSync` a l'arrencada (`logger.ts:19`) i peta si el cwd no és escrivible (Claude Desktop sovint llança des d'un dir de sistema); l'object index "desapareix" si el client canvia de cwd. | Resoldre per defecte contra el dir del paquet o `os.homedir()`; documentar. |
| L18 | `src/operations/screenshot.ts:51` | `inline: true` per defecte amb `scale: 2`: un PNG retina de 1600x1000 són MB de base64 a la resposta MCP, sense guard de mida; a més `handler.ts:137-140` fa `JSON.stringify(..., null, 2)` (pretty-print) inflant totes les respostes. | Guard de mida per a inline (p. ex. > 1 MB → només path), i treure el pretty-print. |
| L19 | `src/stdio-server.ts:131` | `buildServices({} as BCSession)` construeix el graf real de serveis contra un objecte buit només per collir metadata de tools; petarà si algun constructor futur toca la sessió. | Separar la metadata de tools de la construcció de serveis. |

---

## 5. TESTS, DOCS i DX

| # | Severitat | Troballa | Acció |
|---|-----------|----------|-------|
| T1 | **Alta** | `tests/integration/mcp-endpoint.test.ts:85-88` asserta `toHaveLength(12)` però el servidor registra 18 tools (17 + `bc_health`). Vermell garantit a la propera run d'integració. | Actualitzar l'asserció (idealment derivar el nombre del registry, no hardcodejar). |
| T2 | Alta | `bc_find_object`, `bc_refresh_objects` i `object-index-service.ts`: ZERO tests de cap tipus (són les tools més noves). | Afegir unitaris del servei (parse/persistència de l'índex) + integració mínima. |
| T3 | Mitjana | Operations sense cap test unitari: `switch-company`, `wizard-navigate`, `health`, `build-manual`, `find-object`, `refresh-objects`, `close-page`, `navigate`, `respond-dialog`, `run-report`, `list-companies`. Services sense unitari: `metrics`, `manual-service`, `object-index-service`, `filter-service`, `navigation-service`, `browser`, `screenshot-service`. | Prioritzar els que toquin els fixos d'aquest pla (cada fix porta el seu test). |
| T4 | Mitjana | Tools sense test d'integració: `bc_health`, `bc_find_object`, `bc_refresh_objects`, `bc_build_manual`, `bc_wizard_navigate`, `bc_switch_company` (i `bc_list_companies`/`bc_run_report` només a nivell servei/sessió). | Ampliar amb el patró skip-guard de `tests/integration/screenshot.test.ts`. |
| T5 | Mitjana | `docs/tools/bc_download_report.md` estancat: no documenta el paràmetre `filters` ni `availableFilterLabels` (afegits al commit `db78c03`), i encara afirma que "no pot omplir paràmetres de request page" — ara fals. | Actualitzar el doc. |
| T6 | Mitjana | `package.json` amb metadades de l'upstream: `author: Torben Leth`, `repository: SShadowS/business-central-mcp`, nom `business-central-mcp` v1.1.0 (col·lisió npm si es publica). | Decidir el nom del fork i actualitzar. |
| T7 | Mitjana | `README.md`: "Tools: 16" (real 18), "Tests: 343" (real 355), badges i link del `.dxt` apunten a releases de l'upstream. | Refrescar comptadors i links. |
| T8 | Baixa/Mitjana | `zod-to-json-schema` dependència morta (el codi usa `z.toJSONSchema()` de Zod v4 a `src/mcp/schemas.ts:183-224`). | `npm uninstall zod-to-json-schema`. |
| T9 | Baixa/Mitjana | CHANGELOG no recull el commit substantiu `db78c03` (filters de download_report + fix d'esquema pla BC745). | Afegir entrada a `[Unreleased]`. |
| T10 | Baixa | CLAUDE.md: "Essential Commands" citen rutes upstream `U:/git/bc-mcp` i comptadors estancats (128 unit / 103 integració / "11 MCP tools"); defaults de reconnect desalineats amb el codi (L8). | Refrescar. |
| T11 | Baixa | Un test dispara `npm run build:dxt` que emet el warning Node `DEP0205` (`module.register()` deprecated) a stderr. Inofensiu. | Ignorar o silenciar. |

---

## 6. MILLORES D'ERGONOMIA MCP (més enllà dels bugs)

Aquestes provenen de l'auditoria; el backlog general ja és a `docs/ROADMAP.md` §3 (no es
duplica aquí). Per ordre de valor/esforç:

1. **(= M1)** Propagar `context` + `code` a les respostes d'error MCP. Desbloqueja
   l'auto-correcció en un torn.
2. **(= B3)** `activeFilters` a les respostes de `bc_read_data` + reset per defecte.
3. **(= M18)** Coerció de tipus a tots els records de valors (`fields`, `filters`) i errors
   de validació Zod llegibles.
4. **(= M19)** Errors de `pageContextId` desconegut amb la llista de contexts oberts.
5. Respostes JSON compactes (sense `null, 2`) i guard de mida per a imatges inline (L18).
6. En arreglar M6/M7: tota acció/report que obri un form nou retorna sempre un
   `pageContextId` usable — invariant de la API: "si s'obre alguna cosa, la pots adreçar".

---

## 7. SUPORT SaaS (BC Online) — pla complet SENSE trencar Docker/on-prem

### 7.0 Conclusions de la recerca (context per a l'implementador)

- **El protocol és el mateix.** BC Online és el mateix producte web client hostatjat per
  Microsoft; el trànsit passa al mateix WebSocket JSON-RPC al path `/csh`
  (confirmat per anàlisis públiques: frycos.github.io/vulns4free/2024/07/10 i fils de la
  comunitat Cloudflare sobre `wss://.../csh?ackseqnb=-1`). La capa `protocol/` NO necessita
  canvis. La URL SaaS té forma
  `https://businesscentral.dynamics.com/{aadTenantId}/{environment}/` (path-based, no
  `?tenant=`).
- **L'autenticació és l'únic que canvia.** SaaS no té `/SignIn` de formulari: fa una
  redirecció OpenID Connect a `login.microsoftonline.com` i el callback estableix les cookies
  de sessió ASP.NET al domini de BC.
- **Els tokens OAuth per si sols NO serveixen per al web client.** Device code, auth code +
  PKCE, client credentials (S2S), ROPC: tots produeixen TOKENS per a
  `api.businesscentral.dynamics.com`, no cookies de navegador del web client. No hi ha cap
  intercanvi token→cookie documentat. El web client requereix context d'USUARI amb cookies.
  Per tant: **l'únic camí provat és un login de navegador (una vegada, interactiu o
  automatitzat amb TOTP) amb perfil persistent que es reutilitza headless**.
- **Pista complementària (fora d'abast d'aquest pla, apuntada al ROADMAP)**: un mode API REST
  (`api/v2.0`, S2S client credentials, scope
  `https://api.businesscentral.dynamics.com/.default`) és 100% suportat i unattended, però
  només cobreix entitats API exposades — no pàgines arbitràries, ni accions, ni Tell Me, ni
  screenshots/manuals. És un complement, no un substitut.
- **Riscos honests** (per ordre): (1) Microsoft pot tenir gating/anti-automatització al
  `/csh` de SaaS + exposició ToS d'un protocol reverse-engineered contra servei hostatjat;
  (2) SaaS corre sempre la minor més nova — el wire pot canviar abans que cap contenidor
  (l'evidència BC27/BC28-idèntic és encoratjadora però SaaS és un blanc mòbil); (3)
  Conditional Access/MFA d'un tenant pot vetar el perfil persistent (el floor és un re-login
  humà periòdic); (4) la mecànica exacta de cookies/CSRF a SaaS és assumida fins que l'spike
  la verifiqui.

### 7.1 Requisits de compatibilitat (INNEGOCIABLES)

1. Variable nova `BC_AUTH` amb valors `UserPassword` (DEFAULT) | `AAD`. Sense `BC_AUTH` o amb
   `UserPassword`: comportament EXACTE d'avui (mateixes env vars obligatòries, mateix
   `/SignIn`, mateixa URL WS `{baseUrl}/csh` amb `?tenant=` als deep links).
2. `BC_USERNAME`/`BC_PASSWORD` passen a ser obligatoris NOMÉS en mode `UserPassword` (avui
   `requireEnv` a `src/core/config.ts` — moure la validació darrere del mode).
3. Cap canvi al protocol (`interaction-encoder`, `event-decoder`, `bc-session`...) condicionat
   per mode d'auth, EXCEPTE els punts d'URL/tenant explícitament llistats a 7.4.
4. Gate de regressió després de CADA milestone: unitaris verds + integració contra `devel1`
   verda.

### 7.2 Milestone S0 — Spike de captura (1-2 dies; CAL un tenant SaaS; cap canvi de producte)

Sense això, res del que segueix és verificable. Reutilitzar la tècnica ja provada contra
`devel1` (vegeu CLAUDE.md "OpenSession applicationId"): Playwright amb `page.on('websocket')`
+ `framesent` (el web client crea el WS dins d'un Web Worker; un hook de `window.WebSocket` no
veu res). Amb un sandbox SaaS, capturar:

- (a) la URL wss exacta i els query params (`csrftoken`? `ackseqnb`? altres?);
- (b) el payload complet d'`OpenSession`: **`applicationId` (FIN? NAV? altre?)**, `tenantId`,
  `features`, `supportedExtensions`, versió de protocol/compat;
- (c) el cookie jar (noms, atributs, quin porta el CSRF — probablement el mateix patró
  antiforgery `CfDJ8...` perquè el web server és la mateixa app ASP.NET);
- (d) el flux OIDC complet (URLs de redirect, cookies que queden a
  `businesscentral.dynamics.com` vs `login.microsoftonline.com`).

Guardar les captures a `src/protocol/captures/` (redactant secrets) i documentar els resultats
en aquest fitxer o en un `docs/Plans/saas-spike.md`.

### 7.3 Milestone S1 — Refactor d'auth (1-2 dies; NO cal tenant; valor immediat)

Aquest milestone és pur deute tècnic i es pot fer JA. No canvia cap comportament extern.

1. **Renombrar `NTLMAuthProvider` → `FormsAuthProvider`** (`src/connection/auth/ntlm-provider.ts`
   → `forms-provider.ts`): no és NTLM, és forms auth ASP.NET; el nom actual indueix a error.
   (Projecte no publicat: refactor lliure.)
2. **Estendre `AuthResult`** (`src/connection/auth/auth-provider.ts`) amb
   `cookieJar: RawCookie[]` (el tipus amb atributs path/secure/samesite/httponly que ja usa
   `src/services/bc-web-auth.ts`), a més del `cookies: string` actual per al header WS.
3. **Eliminar la duplicació d'auth**: `bc-web-auth.ts::authCookies()` reimplementa el mateix
   `/SignIn` pel navegador headless. Ha de passar a demanar el jar a l'`IBCAuthProvider`
   actiu. Un sol lloc fa login; WS i puppeteer consumeixen el mateix jar.
   (`ScreenshotService` — `src/services/screenshot-service.ts:96` — i `ReportDownloadService`
   — `src/services/report-download-service.ts:94` — són els consumidors.)
4. **Factory de providers**: `createAuthProvider(config): IBCAuthProvider` seleccionat per
   `BC_AUTH`, usat per `src/server.ts:54` i `src/stdio-server.ts:53` (avui fan
   `new NTLMAuthProvider({...})` a pèl). `SessionManager` ja rep l'`IBCAuthProvider` i crida
   `invalidate()` en recuperació — cap canvi allà.
5. Aprofitar per arreglar M9 (detecció de password incorrecte) i L3 (CSRF pel nom de cookie)
   dins del provider renombrat.
6. **Verificació**: unitaris verds; integració `devel1` verda; smoke manual d'una
   `bc_screenshot` (consumeix el jar unificat).

### 7.4 Milestone S2 — `AADBrowserAuthProvider` (3-5 dies; cal tenant + resultats de S0)

1. Nou `src/connection/auth/aad-browser-provider.ts` implementant `IBCAuthProvider`:
   - `authenticate()` llança el navegador headless compartit (`src/services/browser.ts`,
     puppeteer-core) amb **perfil persistent** (`BC_AAD_PROFILE_DIR`, default
     `./.state/aad-profile`), navega a `{baseUrl}`:
     - Si les cookies SSO del perfil són vàlides → la dansa OIDC completa sola → SPA carrega.
     - Si cal login i hi ha `BC_USERNAME`+`BC_PASSWORD`+`BC_AAD_TOTP_SECRET` → omplir el
       formulari AAD headless (`input[name=loginfmt]`, `passwd`, TOTP via el paquet
       `otpauth`).
     - Si no → error accionable: "Run `node dist/cli.js login` (headed) to bootstrap the AAD
       profile" — un bootstrap interactiu one-shot amb navegador visible on l'usuari fa
       login+MFA i el perfil queda persistit. (Conditional Access pot vetar tota
       automatització; aquest és el floor honest.)
   - Exportar el jar amb CDP `Network.getAllCookies()` (captura httpOnly), derivar el CSRF
     segons el que digui l'spike S0, tancar la pàgina, i servir
     `getWebSocketHeaders()`/`getWebSocketQueryParams()` idèntic al provider de forms.
   - `invalidate()` esborra el jar en memòria (el perfil de disc es conserva → re-auth
     normalment silenciosa). El flux de recuperació de `SessionManager` funciona sense tocar.
2. **URLs i tenant** (els únics punts on el mode toca fora d'auth):
   - `BC_BASE_URL=https://businesscentral.dynamics.com/{aadTenantId}/{environment}` — el
     builder de la URL WS (`{baseUrl}/csh`) ja funciona per construcció.
   - En mode AAD: `deepLinkPage`/`deepLinkReport` (screenshot/report services) NO han
     d'afegir `?tenant={BC_TENANT_ID}`; el camp `tenantId` de cada `Invoke` i el
     `BC_APPLICATION_ID` prenen el valor que hagi capturat l'spike S0. Fer-ho amb un únic
     predicat central (p. ex. `config.bc.authMode === 'AAD'`), NO amb sniffing d'URL.
   - El fallback `inPageLogin()` del navegador (selectors on-prem `#UserName`/`#Password`/
     `#submitButton`, `src/services/screenshot-service.ts`) no existeix a SaaS: en mode AAD,
     substituir-lo per la re-auth del provider o un error clar.
3. **Config nova** (tota opcional, només llegida en mode AAD): `BC_AUTH`,
   `BC_AAD_PROFILE_DIR`, `BC_AAD_TOTP_SECRET?`, `BC_AAD_LOGIN_TIMEOUT?`. Documentar a
   `.env.example`, README i `docs/SETUP-GLOBAL.md`.
4. **Verificació**: contra el tenant SaaS: `bc_health`, `bc_open_page` (Customer List),
   `bc_read_data`, `bc_write_data` en un sandbox, `bc_screenshot`. I OBLIGATORI: la suite
   d'integració `devel1` segueix verda amb `BC_AUTH` sense definir.

### 7.5 Milestone S3 — Enduriment de vida de sessió SaaS (2-3 dies)

- Les cookies SaaS expiren pel seu compte: detectar l'expiració (upgrade WS que retorna
  302/401, o OpenSession rebutjat) i cablejar-ho al camí de recuperació existent de
  `SessionManager` (invalidate → re-auth → reconnect amb backoff, ja existeix).
- Re-auth proactiva opcional si el provider sap l'expiració aproximada del ticket.
- Tests: simular expiració invalidant el jar i comprovar recuperació transparent.

### 7.6 Estimació total

~2-3 setmanes de treball focalitzat incloent l'spike, condicionat que S0 confirmi paritat de
protocol. **S1 val la pena fer-lo ja encara que el SaaS s'ajorni** — arregla duplicació i
naming enganyós existents.

---

## 8. ORDRE D'EXECUCIÓ RECOMANAT

Cada fase acaba amb `npx tsc --noEmit` + `npx vitest run` verds; les que toquen protocol,
també integració contra `devel1`. Cada fix porta el seu test (unitari sempre que la lògica ho
permeti; integració per a comportament de protocol).

**Fase 1 — Correctesa crítica (1-2 dies)**
1. B4 (regex `"code":1` — trivial) → 2. B2 (timeout fora de la cua) → 3. B3 (reset de
filtres + `activeFilters`) → 4. B1 (bookmark a execute_action; el més delicat, fer-lo amb
integració a `devel1`).

**Fase 2 — Ergonomia d'alt impacte (1-2 dies)**
M1 (context+code al handler i al REST) → M18 (coerció de valors) → M19 (validator de
pageContextId) → M9 (password incorrecte) → L18 (mida de resposta).

**Fase 3 — Correctesa d'estat (2-3 dies)**
M5 (close amb diàleg pendent) → M6 (openedPages per accions) → M3 (switch_company real) →
M4 (tenantId) → M8 (tancar Tell Me) → M16 (applyToPage al close) → M13 (events del
reconcile) → M14 (deriveSection tolerant) → M10/M11 (events de fila; verificar format contra
decompiled abans) → M12 (poda de bookkeeping) → M15 (messages a init).

**Fase 4 — Neteja tests/docs/DX (1 dia)**
T1 (asserció 12→derivada del registry) → T5 (doc download_report) → T8 (dep morta) → T9
(CHANGELOG) → T6/T7 (metadades fork/README) → T10 (CLAUDE.md) → M7 (descripció o fix real de
run_report) → M2 (lookup: implementar o retirar de l'esquema) → M17 (redacció de logs) →
resta de L segons es toqui cada zona.

**Fase 5 — SaaS**
S1 (ja!) → S0 (quan hi hagi tenant) → S2 → S3. Regla d'or de §1 a cada pas.

---

## 9. CHECKLIST DE VERIFICACIÓ FINAL (quan tot estigui fet)

- [ ] `npx tsc --noEmit` net.
- [ ] `npx vitest run` verd (el recompte haurà crescut; actualitzar README/CLAUDE.md).
- [ ] `npx vitest run --config vitest.integration.config.ts` verd contra `devel1`
      (mode Docker intacte — regla d'or).
- [ ] Smoke manual: `bc_health`, obrir Customer List, filtrar dues vegades seguides (B3),
      executar DrillDown amb bookmark de fila no seleccionada (B1), `bc_switch_company` +
      `bc_screenshot` sense `company` (M3), tancar una card modificada (M5).
- [ ] Errors MCP inclouen `code` + `context` (M1) — comprovar amb un "Action not found".
- [ ] Cap credencial ni valor de negoci a `logs/` amb `LOG_REDACT_VALUES=true` (M17).
- [ ] Docs: ROADMAP actualitzat (moure el que s'ha fet), CHANGELOG amb totes les entrades,
      docs/tools/ alineats amb els esquemes.
- [ ] Sense accions de git: informar l'usuari del que hi ha al working tree.

---

## 10. QUÈ QUEDA PENDENT (després de la implementació del 2026-07-04)

L'implementació del 2026-07-04 va tancar tots els bugs crítics i mitjans i la majoria dels
baixos (vegeu la nota d'estat al capdamunt d'aquest fitxer i el CHANGELOG). El que queda:

### A. Verificació bloquejant (fer-ho abans de donar per tancada la feina)

- [ ] **Executar la suite d'integració contra `devel1`**:
      `npx vitest run --config vitest.integration.config.ts`. És el **gate de regressió del
      mode Docker** (regla d'or §1). No s'ha pogut executar durant la implementació (cal el
      contenidor viu). Si alguna cosa peta, mirar si és una regressió real d'aquests canvis o
      un test que assumeix el comportament antic.
- [ ] **Smoke manual** dels fixos amb efecte de protocol (idealment via l'MCP contra `devel1`):
      B1 (DrillDown/Delete amb bookmark de fila NO seleccionada → toca la fila correcta),
      B3 (filtrar dues ciutats seguides → la segona retorna files, no 0),
      M3 (`bc_switch_company` B → `bc_screenshot` sense `company` → captura la companyia B),
      M5 (tancar una card modificada → diàleg de desar surt amb `pageContextId` viu; i amb
      `discardChanges:true` es tanca), M6 (`New` en una llista → `openedPages` no buit).

### B. Bugs baixos diferits conscientment (6) + 1 a re-verificar

Cap és urgent; cadascun porta el motiu pel qual NO s'ha tocat encara:

| # | On | Per què s'ha diferit | Què caldria per fer-lo |
|---|----|----------------------|------------------------|
| **L2** | `src/session/session-manager.ts:75-129` | Race de recuperació de sessió (un caller concurrent durant el recovery no rep `SessionLostError`). Baix impacte (missatge d'error confús en una finestra rara). El camí de recovery és **crític per al mode Docker** — tocar-lo sense un test concurrent live és arriscat. | Test que dispari dues `getSession()` concurrents amb sessió morta; distingir "recovering" de "first-create" amb un flag i fer que ambdós callers rebin `SessionLostError`. |
| **L5** | `src/protocol/interaction-encoder.ts:127-146` | Regles DST hardcodejades a Europa (`dstOffset:60`, últims diumenges març/octubre). Impacte baix (offset enviat a BC); complex de fer bé i sense test fàcil. | Derivar l'offset real del host amb `Intl.DateTimeFormat`/`getTimezoneOffset` o fer-ho configurable via env. |
| **L6** | `src/connection/bc-websocket.ts:139-150` | L'ack de seqüència de respostes SÍNCRONES no es realimenta. **Ja mitigat** per `disableResponseSequencing:true` a `encodeOpenSession`. Trampa latent, no bug actiu. | Si algun dia es treu el flag: alimentar `lastServerSequence` des del `SequenceNumber` de les respostes síncrones. |
| **L12** | `src/mcp/handler.ts:41-42` | `notifications/initialized` respon un objecte JSON-RPC; per HTTP surt un frame sense `id`. Canviar-ho és un canvi de contracte HTTP arriscat; l'**stdio (transport principal) ja ho fa bé**. | Al path `/mcp` d'HTTP, respondre 204 (sense cos) per notificacions (mètode `notifications/*` o sense `id`). |
| **L15** | `src/services/report-download-service.ts:192-201` | El drive de la request-page de reports coneix captions només ES/CA/EN ("Enviar a", "Aceptar"…). En un BC alemany/francès fallaria silenciosament. Cal un **BC no-castellà per verificar** els nous captions. | Matxejar el botó per rol/posició a més del caption, o ampliar el diccionari; reportar "caption no reconegut" en lloc de `requestPageShown:true` enganyós. |
| **L19** | `src/stdio-server.ts:131` | `buildServices({} as BCSession)` construeix serveis contra una sessió falsa per collir metadata. **No disparat** avui (cap constructor toca la sessió). Latent. | Separar l'extracció de metadata de tools de la construcció real de serveis. |
| **M10** (re-verificar) | `src/protocol/form-state.ts` | Els events d'eliminació de fila (`DataRowRemoved`) s'han implementat **best-effort/defensiu** (no-op si el format del wire no coincideix) perquè les fonts decompiled NO eren accessibles des d'aquesta màquina. No pot corrompre estat, però potser no fa res en algunes rutes. | Capturar un `DataRowRemoved` real (delete d'una fila via MCP contra `devel1`) o consultar el decompiled (`BrowserLogicalChangeTypeIds.cs`) i ajustar `extractRowChanges` al format exacte. |

### C. Cobertura de tests que encara falta (de T2/T3/T4)

S'han afegit 15 tests nous (B4, M10/M11, M18, M2, B3, M5). Segueix sense cobertura:

- **`bc_find_object` / `bc_refresh_objects` / `object-index-service`**: ZERO tests de cap tipus
  (les tools més noves). Prioritat alta — afegir unitaris del parse/persistència de l'índex.
- **Operations sense unitari**: `switch-company`, `wizard-navigate`, `health`, `build-manual`,
  `find-object`, `refresh-objects`, `list-companies`. (Alguns ara tenen fixos nous sense test
  dedicat: M3 switch-company, M6/B1 execute-action row-targeting — afegir-ne.)
- **Tools sense test d'integració**: `bc_health`, `bc_find_object`, `bc_refresh_objects`,
  `bc_build_manual`, `bc_wizard_navigate`, `bc_switch_company`.

### D. SaaS (§7) — ✅ FET I VERIFICAT EN VIU (2026-08-08)

**Aquesta secció ja no aplica.** Tots els milestones (S1 refactor, S0/F2 spike, S2 `AADBrowserAuthProvider`,
S3 expiració) es van fer i verificar contra el sandbox `Dev` el 2026-08-08. Bateria funcional 15/18 PASS,
paritat amb Docker. Vegeu [`2026-08-08-saas-sandbox.md`](2026-08-08-saas-sandbox.md) i
[`saas-battery.md`](saas-battery.md). El text de sota és el pla original (històric):

Cap milestone del §7 s'ha tocat. Ordre recomanat (repetit aquí per comoditat):

1. **S1 — Refactor d'auth** (1-2 dies, **NO cal tenant, valor immediat**): renombrar
   `NTLMAuthProvider`→`FormsAuthProvider`, factory `BC_AUTH`, unificar `bc-web-auth.ts`. És deute
   tècnic que es pot fer JA. (M9 i L3 ja s'han arreglat dins l'actual provider, així que aquest
   pas hereta la feina feta.)
2. **S0 — Spike de captura** (cal un sandbox SaaS): URL wss, payload `OpenSession`, cookie jar.
3. **S2 — `AADBrowserAuthProvider`** (cal tenant + S0).
4. **S3 — Enduriment d'expiració de cookies**.

Detall complet a §7. Regla d'or §1 a cada pas: `BC_AUTH` sense definir = comportament Docker
idèntic.

### E. ROADMAP anterior (fora de l'abast d'aquesta auditoria)

Segueixen oberts a [`docs/ROADMAP.md`](../ROADMAP.md), no els va tocar aquesta auditoria:
name→id per obrir pàgines per nom, document multi-repeater (L4 del ROADMAP), `mode=Create` per a
Document Types personalitzats, expansió de la secció "Lines" a `bc_screenshot`, paràmetres
Options/format a `bc_download_report`, file upload, i el backlog d'idees d'expansió (§3 del
ROADMAP).
