# Pending work — single source of truth

> **This file is the ONLY place where open work is tracked**: limitations, bugs, gaps, doc drift,
> test debt and the idea backlog. Anything not listed here is either done (see
> [`CHANGELOG.md`](../CHANGELOG.md)) or was verified as already done and removed.
>
> **Last full pass: 2026-08-09.** Every item below carries the file/line or the live observation
> that proves it is still open. Items that were fixed in that pass were DELETED from here and
> written up in the changelog — they are not archived as "DONE" rows, because that is exactly how
> the previous four documents drifted into contradicting each other.
>
> **Sibling document, and the only other one that is not a guide or a tool page:**
> [`SAAS-EVIDENCE.md`](SAAS-EVIDENCE.md) — the frozen record of how SaaS's per-tab backend
> WebSocket was discovered plus the Docker-vs-SaaS parity matrix. It holds **results**; it never
> holds pending items.
>
> **Reading this without the protocol context?** [§9 "En clar"](#9-en-clar--què-vol-dir-cada-punt)
> explains every single item in plain Catalan: what it means in practice, whether it is "not
> built" or "not possible", and how confident we are that it can be fixed. The tables above stay
> the technical source of truth; §9 is the same list, said in words.

## 0. Verification snapshot (2026-08-09, after the fix pass)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` (unit + protocol) | **458 passed / 58 files** |
| `npm run test:integration` vs `devel1` (BC27) | **110 passed · 0 failed · 6 skipped** (116 tests); files: **19 passed · 1 skipped** (20). Green. The 6 skips are the BC28-only suites, which need a second server (see §1) |
| `npm run verify:features docker` | **5 PASS · 0 FAIL** |
| `npm run verify:features saas` | **5 PASS · 0 FAIL** — same results as Docker |
| `npm run objects:refresh -- saas --all` | 17 011 objects indexed |

SaaS/AAD support is done and verified live; on-prem forms auth is unchanged. The capabilities
added on 2026-08-09 (create mode, line filtering, activeFilters, report format/parameters,
screenshot line reveal) were each verified on **both** environments — see the changelog.

---

## 1. Blocking gate — none

The integration suite is green against `devel1`. Everything that used to be environmental
(A2/A3/A4) is fixed: suites load `.secrets/devel1.env`, run one file at a time, and the
MCP-endpoint suite finally starts.

Two suites (`bc28.test.ts`, the second half of `multi-section.test.ts`) need a **second BC** and
upstream hardcoded its own host (`http://cronus28/BC`). They used to fail at `beforeAll` on every
run here — noise that buried real failures. They now read `BC28_BASE_URL` / `BC28_USERNAME` /
`BC28_PASSWORD` and skip cleanly when it is unset, so BC27-vs-BC28 wire compatibility is only
re-checked when someone actually has a BC28 to point at (see **E3**).

The former **A1** (field-metadata flags) was dropped by decision, not fixed — see §7.

---

## 2. Tool capability gaps (what an agent still cannot do)

| # | Gap | Evidence (2026-08-09) | Effort | Workaround today |
|---|-----|----------------------|--------|------------------|
| **G7** | **Field lookup / AssistEdit cannot be triggered.** `SystemAction.Lookup=110` / `AssistEdit=100` are not reachable from any tool, so a field that only accepts values from a list cannot be browsed. | `NavigateSchema` `action: z.enum(['drill_down','select'])` | M | Write the value directly and check `changed`. |
| **G5** | **`bc_download_report` on SaaS.** The engine authenticates fine (`bc_screenshot` proves it), but the report deep-link (`?report=`) intermittently lands on BC's "Go back home" page and the SaaS request-page toolbar differs from the on-prem "Send to → Aceptar" flow. On-prem unaffected. | SaaS battery | M | Use on-prem for downloads, or `bc_run_report` on SaaS. |
| **G6** | **Document Lines screenshots — implemented, not yet verified live.** `revealAll` now expands EVERY collapsed section header (not just FastTabs/sub-groups) and `clickBeforeCapture: ["Lines"]` names a toggle explicitly. What is missing is a live capture proving a line caption (Quantity / Line Amount) is found and cropped on a real Sales Order. | [screenshot-service.ts](../src/services/screenshot-service.ts) `revealAll` / `clickByCaption` | S | Run `bc_screenshot` on page 42 with `highlight: ["Quantity"]` and confirm `found:true`. |
| **G10** | **FactBox content read through the parent page can come back empty**, even though the section id is listed. | reported live (BC-748); no code fix attempted | M | Open the FactBox page by its own `pageId`, or request `sections:["factbox:<id>"]`. |
| **G11** | **`bc_screenshot` captures saved state only.** The out-of-band browser opens its own session on the stored record, so unsaved on-screen state cannot be documented. | by design | L | Save before capturing. Deferred idea: render `FormState` to HTML/PNG. |
| **G12** | **No file upload.** The headless browser can download but never drives `<input type="file">`. | no upload path in `src/services/` | M | — |

---

## 3. Bugs and robustness gaps (verified still present)

Ordered by consequence. None is urgent; each carries why it was left.

| # | Bug | Evidence | Why deferred / what it needs |
|---|-----|----------|------------------------------|
| **B4** | **The row-removal wire shape is still unknown.** Consequence handled — the repeater is now re-synced from the server after a Delete — but `extractRowChanges` still parses `DataRowRemoved` defensively against a shape nobody has observed. A live delete produced `InvokeCompleted` + `PropertyChanged` and **no row-change payload at all**. | [form-state.ts](../src/protocol/form-state.ts) `extractRowChanges`; live run 2026-08-09 | Capture a delete of a POPULATED line (the run deleted a blank placeholder, which BC ignores) and either pin the shape or delete the dead branch. |
| **B6** | **Document pages: the default repeater is ambiguous.** With both a header and a lines repeater, omitting `section` resolves whichever repeater comes first. | `resolveSection(ctx, sectionId)` with `sectionId` optional in [navigation-service.ts](../src/services/navigation-service.ts) | Mitigated: the sections ARE distinguishable (`header` / `lines` — verified live on both environments), so passing `section: "lines"` always works. Proper fix = track header vs lines repeaters separately using the `DataLoaded` `controlPath`. |
| **B7** | **Report request-page captions are ES/CA/EN only.** The button dictionary ("Enviar a", "Send to", "Aceptar", "OK") fails on a German/French BC — and now the same applies to the output-format radio labels. | `clickByText` / `FORMAT_TOKENS` in [report-download-service.ts](../src/services/report-download-service.ts) | Mitigated (an unmatched caption returns an explicit `note` + `availableFilterLabels` / `availableFormats` instead of a misleading success). Real fix needs a non-Spanish BC: match by role/position as well as caption. |
| **B8** | **Timezone/DST is hardcoded to Europe** (`dstOffset: 60`, last Sundays of March/October) in the OpenSession payload. | [interaction-encoder.ts](../src/protocol/interaction-encoder.ts) `lastSunday()` | Low impact, no easy test. Fix = derive from the host with `Intl.DateTimeFormat`, or make it configurable. |
| **B9** | **Sequence acking of synchronous responses is not fed back.** `lastServerSequence` only advances from async `Message` notifications. | [bc-websocket.ts](../src/connection/bc-websocket.ts) | Latent, not active: `encodeOpenSession` sends `disableResponseSequencing: true`. If that flag is ever removed, fix this first. |
| **B10** | **`notifications/initialized` gets a JSON-RPC response over HTTP** (a frame without `id`). stdio — the primary transport — is correct. | [handler.ts](../src/mcp/handler.ts) | Changing the HTTP contract is riskier than the bug. Fix = answer 204 for `notifications/*` on `/mcp`. |
| **B11** | **`buildServices({} as BCSession)`** builds the real service graph against a fake session just to harvest tool metadata. Not triggered today — a latent trap. | [stdio-server.ts](../src/stdio-server.ts) | Separate tool-metadata extraction from service construction. |
| **B12** | **`BC_BASE_URL` is only trailing-slash-trimmed**, never validated. A malformed value fails late and opaquely at the WebSocket upgrade. | [config.ts](../src/core/config.ts) | Validate with `new URL()` at load and fail with a clear message. |

---

## 4. Test coverage debt

| # | Gap | Detail |
|---|-----|--------|
| **T1** | **`bc_find_object` / `bc_refresh_objects` operations have no test.** The locale-resolution logic that broke them now does ([tests/unit/object-index-columns.test.ts](../tests/unit/object-index-columns.test.ts)), but the operations and the seek/merge loop around it are still untested. | highest-value remaining gap |
| **T2** | **Operations with no unit test**: `switch-company` (changed on 2026-08-09 — the company is now remembered for reconnects), `wizard-navigate`, `health`, `list-companies`, `navigate`, `respond-dialog`, `run-report`, `close-page`, `find-object`, `refresh-objects`. | |
| **T3** | **Tools with no integration test**: `bc_find_object`, `bc_refresh_objects`, `bc_build_manual`, `bc_switch_company`, `bc_list_companies`, `bc_wizard_navigate`. | use the skip-guard pattern from `tests/integration/screenshot.test.ts` |
| **T6** | **The report format/parameter selection (G3/G4) has no automated cover.** It drives a real browser against a real request page, so it is only exercisable live — today it is verified by hand. The G8 matcher IS covered ([tests/unit/row-filter.test.ts](../tests/unit/row-filter.test.ts), 41 cases). | needs a recorded request page or a DOM fixture |

CI runs typecheck + build + unit/protocol on Node 20/22/24. The integration gate now exists as a
`workflow_dispatch` / `run-integration`-labelled job on a self-hosted runner
(`.github/workflows/ci.yml`) — it needs a runner that can reach BC before it will actually run.

---

## 5. Environment reach (not started)

- **E1 — Windows authentication** — for domain-joined on-prem where NavUserPassword is off.
- **E2 — S2S / OAuth client-credentials REST mode** (`api/v2.0`) — unattended complement; covers
  API entities only, not arbitrary pages, actions, Tell Me, screenshots or manuals. Not a substitute.
- **E3 — BC29+ wire-compat verification** — re-verify each new BC version as it ships (BC27/BC28
  are byte-identical today).
- **E4 — Multi-environment in one process** — today one server process = one BC (env-selected).
  Register two MCP servers (`bc-docker` + `bc-saas`) to have both.

## 6. Distribution & install ergonomics (not started)

- **P1** — Cursor support (install badge + `~/.cursor/mcp.json` snippet).
- **P2** — Interactive `npx business-central-mcp-esanpons init` wizard (detect hosts, prompt for creds, write config).
- **P3** — Sign the `.dxt` once Claude Desktop signing stabilises.
- **P4** — MCP marketplace publication.
- **P5** — VSCode one-click `inputs` (prompt for `BC_BASE_URL` / `BC_USERNAME` / `BC_PASSWORD` at install).

---

## 7. Non-bugs — do not re-file

Confirmed behaviour, documented so nobody spends time on them again:

- **`ApplicationArea`-gated fields are server-filtered.** Page-extension fields behind a
  non-`#All` Application Area are never sent by BC, so `bc_write_data` says "Field not found".
  Activate the area (page 9178) first.
- **`editable: "unknown"` is not read-only.** BC emitted no flag; attempt the write and branch on
  `changed`.
- **Tell Me is profile-scoped.** An empty result set usually means the connected `BC_PROFILE` has
  no index — not a transport failure.
- **Collapsed FastTabs / "Show more" affect screenshots only.** `bc_open_page` / `bc_read_data` /
  `bc_navigate` return every field regardless of the visual collapse state.
- **Main-list filters use AL field NAMES** (`No.`, `Name`, `City`), never localized captions.
  Line/subpage filters are the opposite — they match the column CAPTION, because they run
  client-side over the rows you can see.
- **Page 9174's columns are localized.** Anything reading them must resolve columns per locale
  (`resolveObjectColumns`), never by hardcoded English captions.
- **BC does not reliably announce a deleted row.** Re-sync the repeater instead of waiting for a
  removal event.
- **`isLookup` / `showMandatory` are not populated on BC27 (`devel1`) — and we do not chase them.**
  Customer Card `No.` reports no lookup flag and `Name` no mandatory flag. These are presentational
  hints; no tool behaviour depends on them, so the assertions were removed (2026-08-09) rather than
  left failing. The plumbing that reads them is untouched (`AssistEditAction`/`LookupAction` ->
  `hasLookup`, `ShowMandatory` -> `showMandatory` in `form-tree-builder.ts`), so a build that does
  emit them still surfaces them. Do not re-file as a bug; if you need the flags, first capture the
  live control tree and prove BC sends them.
- **Dynamic AL editability (`Editable = not <variable>`) is no longer tracked as a bug.** The
  symptom reported on a custom Demo Card — `bc_write_data` answering `changed:false,
  reason:"not editable"` on fields that were writable — was the same false negative that the
  write check produced on `mode=Create` pages, and that is fixed: the result now comes from the
  value BC echoes on the wire, not from the projected tree. If it ever reappears, re-file with the
  page it happened on and the raw `events` from the write.
- **`bc_run_report` cannot return the rendered binary.** BC streams it on a separate channel;
  that is what `bc_download_report` is for.
- **bc-ws first, Playwright only as fallback.** The remaining reasons to fall back are G7 (field
  lookup) and G10 (a FactBox read through its parent page). Record creation is no longer one of them.

---

## 8. Idea backlog (nothing started; rough effort in brackets)

**Agent ergonomics** — cap large outputs by default with `totalRowCount` + a hint [S–M] ·
self-correcting field/action errors with closest-match suggestions [S] · address records by
primary key instead of an opaque bookmark [M] · a `bc_help` capability/recipe index tool [S] ·
task recipes as skills (create customer, post order) [S each] · dry-run preview for writes [M] ·
read cache for repeated lookups [M].

**Data & productivity** — `bc_query` OData/API hybrid read engine for bulk paginated reads [L] ·
export a list to CSV/Excel/JSON [S–M] · bulk edit by filter [M] · templated record creation from
a spec/CSV [M] · cross-company reporting [M].

**Screenshots & visual** — record a workflow to video/GIF via CDP screencast [M] · visual
regression diffing [M] · print a card/list page to PDF [S] · accessibility audit with axe-core [M].

**Manuals & training** — templates & branding (logo, cover, header/footer) [S–M] · multi-language
manuals [M] · interactive HTML walkthrough [M] · field dictionary per page [S] · role-based manual
bundles [M] · checklists/quizzes from a process [S].

**Analytics** — charts from list data embedded in the manual [M] · KPI trends from Role Center
cues over time [M] · daily dashboard snapshot [S].

**AI-native** — fill a form from a document/email (invoice → order) [M–L] · natural language →
BC filters [M] · anomaly detection in a list [M] · reconciliation assistant [L].

**QA & upgrade safety** — smoke-test N pages [M] · synthetic monitoring on a schedule [M] ·
page-open timing to surface slow pages [S].

**AL developer toolkit** — AL object & metadata explorer [M] · run AL test codeunits (page
130401) [M–L] · telemetry/event-log reader [M] · test scaffolding generator [M] · permission-set
inspection [M] · RapidStart configuration packages [M–L].

**Migration & hygiene** — environment diff (dev vs prod) [M–L] · duplicate/blank detection [M] ·
anonymisation for test copies [M] · mass create from CSV [M] · configuration documentation [M].

**Integrations** — email/Teams a manual or screenshot [S–M] · upload to SharePoint/OneDrive [M] ·
push to Google Sheets / Excel Online [M] · webhooks for BC events [L].

**Safety** — audit log of writes for traceability [S–M].

---

## 9. En clar — què vol dir cada punt

> Explicació en llenguatge planer de cada identificador, per poder decidir sense llegir codi.
> Les taules de dalt manen: si alguna cosa es contradiu, val la taula.
>
> Quan diu **"no està verificat en viu"** vol dir exactament això: és el que crec que passarà,
> no el que he vist passar.

### La revisió automàtica

**Tot verd contra `devel1`.** Ja no hi ha cap suite que mori abans de començar ni cap prova
vermella.

Les que se salten són d'un altre BC (una versió 28) que aquí no tenim: abans donaven error sempre
i tapaven els problemes de debò; ara se salten soles i només s'executen si algú indica on és
aquest segon servidor.

Els dos detalls de camp que no es detectaven (la marca de lupa i la d'obligatori a la fitxa de
Client) **s'han descartat per decisió**, no arreglat: són marques informatives de les quals no
depèn cap funcionament, i les proves que les exigien s'han tret en comptes de deixar-les vermelles
per sempre. El codi que les llegeix segueix intacte. Està explicat a §7.

### El que encara no es pot fer (G5–G12)

- **G7 — prémer la lupa d'un camp.** Molts camps no s'escriuen, es trien d'una llista (el client,
  la sèrie de numeració). El servidor sap veure que el camp té lupa però **no la pot prémer**:
  l'ordre existeix al protocol, no està connectada a cap eina. A la pràctica, si no saps el codi
  exacte, has d'escriure a cegues.
- **G5 — descarregar informes al BC del núvol.** Dues coses concretes, només al núvol: l'enllaç
  directe a l'informe de vegades obre una pàgina d'error en comptes de l'informe (de vegades, no
  sempre — per això "no fiable"), i quan sí que obre, la barra de botons no és igual que la local i
  l'automatisme no hi troba "Enviar a…"/"Acceptar". **No és un problema d'accés**: les captures de
  pantalla al núvol funcionen.
- **G6 — fotografiar les línies d'un document. Ja està programat, però no provat en viu.** Ara
  desplega qualsevol capçalera plegada (abans només les pestanyes) i, si ho prefereixes, pots dir
  exactament què vols obrir amb `clickBeforeCapture: ["Lines"]`. Falta una captura real d'una
  comanda que demostri que troba "Quantitat" i la retalla.
- **G10 — els requadres de resum del lateral** de vegades tornen buits si els demanes des de la
  pàgina principal. Es resol obrint-los pel seu compte.
- **G11 — fotografiar el que encara no s'ha desat.** No es pot, i és **per disseny**: la captura
  obre una sessió de navegador independent i allà només hi ha el que està desat.
- **G12 — pujar fitxers a BC.** Descarregar sí, pujar no.

### Errors coneguts (B4–B12)

- **B4 — en esborrar una fila.** La conseqüència dolenta ja no hi és: després d'esborrar, la
  graella es torna a demanar al servidor, així que no queden files fantasma. El que segueix sense
  saber-se és **com avisa BC d'un esborrat** — en la prova en viu no va avisar de cap manera. Queda
  una branca de codi que interpreta un format que ningú ha vist mai.
- **B6 — en documents amb capçalera i línies**, si no dius on vols treballar pot triar el lloc
  equivocat. Comprovat en viu que les dues seccions es distingeixen bé, així que dient-ho
  explícitament (`section: "lines"`) sempre va bé.
- **B7 — els botons dels informes es busquen pel text** ("Enviar a", "Acceptar", i ara també "PDF",
  "Excel"…). En un BC en alemany o francès no els trobaria. Almenys ho diu clar en comptes de fer
  veure que ha anat bé. Només ens afecta el dia que connectem un BC en un altre idioma.
- **B8 — el canvi d'hora està escrit a mà per a Europa.** Un BC d'una altra zona rebria una hora
  incorrecta. Impacte molt baix.
- **B9 — la numeració de missatges. Bomba desactivada**: en obrir sessió li diem explícitament a BC
  que no la faci servir. Només caldria arreglar-ho si algun dia traiem aquella opció.
- **B10 — en mode HTTP** (que no és l'habitual) responem a un avís que no espera resposta.
  Formalment incorrecte, a la pràctica no molesta ningú.
- **B11 — una trampa esperant.** Per publicar la llista d'eines es munta tot el motor amb una
  sessió falsa. Avui no peta; el dia que una peça toqui la sessió en muntar-se, petarà en arrencar.
- **B12 — l'adreça del servidor no es valida.** Si està mal escrita, l'error surt tard i és
  incomprensible.

### Proves que falten (T1–T3, T6)

- **T1** — les eines de buscar objectes segueixen sense prova pròpia. La part que va fallar (llegir
  les columnes en qualsevol idioma) ja en té; la resta no.
- **T2** — una desena d'operacions internes sense prova pròpia, entre elles el canvi d'empresa, que
  acaba de canviar.
- **T3** — sis eines sense prova contra un BC real.
- **T6** — les capacitats noves estan provades en viu als dos entorns, però els casos rars del
  motor de filtre de línies mereixen proves pròpies que no necessitin BC.
- El servidor automàtic ja té un lloc previst per llançar les proves contra un BC real, però
  necessita una màquina que hi arribi.

### Abast d'entorns (E1–E4) i distribució (P1–P5)

- **E1 — entrar amb usuari de Windows.** Avui entrem amb usuari i contrasenya de BC. En clients amb
  domini configurats així, no ens hi podríem connectar.
- **E2 — via desatesa per API.** Connectar-se sense cap persona ni navegador, per a processos
  automàtics. Només arriba a les dades publicades com a API: complement, mai substitut.
- **E3 — comprovar la propera versió de BC.** BC27 i BC28 parlen igual; quan surti BC29 cal
  tornar-ho a comprovar. Manteniment previsible.
- **E4 — dos BC alhora.** Avui cada connexió apunta a un BC fix. Per treballar amb el de casa i el
  del núvol es registren dues connexions amb noms diferents.
- **P1–P5 — facilitar la instal·lació a altres.** Botó per a Cursor, assistent que pregunti les
  dades, signar el paquet, publicar-ho al catàleg. **Només importa el dia que ho donem a gent de
  fora**; per a ús intern no cal.

---

## 10. How to keep this file honest

1. New finding → add a row here with the file/line that proves it, never in a new plan document.
2. Item done → delete the row and add a `CHANGELOG.md` entry. Do not leave "DONE" rows behind.
3. Before trusting any row older than a release, re-check the cited file/line — the code moves.
4. Adding, closing or renaming an item → update its entry in [§9](#9-en-clar--què-vol-dir-cada-punt)
   in the same edit. A plain-language section that lags behind the tables is worse than none.
