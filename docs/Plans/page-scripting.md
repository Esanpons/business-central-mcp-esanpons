# Page Scripting ↔ bc-mcp — pla detallat (NO implementat)

> **Estat: idea documentada, res construït.** Aquest document existeix perquè quan s'implementi no
> calgui refer la investigació. Tot el que hi ha aquí està verificat contra documentació pública de
> Microsoft i repos open source (URL a cada punt), però **cap línia de codi d'aquest repo hi
> participa encara**, i el format YAML NO s'ha validat en viu des d'aquest fork.
>
> Data de la investigació: 2026-08-09.

---

## 1. Per què això val la pena

Aquest MCP condueix el web client de BC amb semàntica de pàgina/camp/acció. Microsoft ha
estandarditzat **exactament la mateixa semàntica** en un format d'artefacte: **Page Scripting**.
La conseqüència és que una sessió d'agent i un test de regressió són la mateixa cosa escrita de
dues maneres.

Ningú de l'ecosistema connecta les dues coses (verificat al catàleg d'alguidelines.dev, on el
nínxol d'automatització de web client és buit). La proposta:

```
Agent condueix BC via bc-mcp  ──►  bc_export_page_script  ──►  fitxer .yml
                                                                   │
                                             ┌─────────────────────┴─────────────────────┐
                                             ▼                                           ▼
                             gravador de BC (editable a mà)              @microsoft/bc-replay (CI)
```

Valor concret:
- Cada flux que un agent executa correctament es converteix en **test UAT reproduïble** sense
  escriure'l a mà.
- L'artefacte és **de Microsoft, no nostre**: sobreviu a canvis d'aquest MCP, l'obre el client web,
  el corre AL-Go, i el pot editar un consultor funcional sense saber què és un MCP.
- Tanca el cicle de documentació: `bc_build_manual` genera el manual per a humans; el mateix flux
  genera el test per a la màquina.

## 2. Què és Page Scripting exactament

**Doc oficial:** https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting

- Gravador **integrat al web client** (Settings → Page Scripting). No cal instal·lar res.
- Grava **a nivell de semàntica AL**, no d'HTML: la documentació ho diu explícitament ("not a
  generic HTML automation tool"). Els targets són `page: Sales Order` + `field: Document Date`,
  amb un `runtimeRef` per desambiguar.
- Produeix **YAML documentat i editable**, no un binari opac.
- Es pot compartir com a enllaç de replay dins del propi client.

### Elements del format (els que importen per a l'exportador)

| Element | Què és |
|---|---|
| `input` | Escriure un valor en un control (equivalent al nostre `bc_write_data`) |
| `wait` | Espera explícita |
| `include` | Composició: incrusta un altre script per camí relatiu (sub-fluxos reutilitzables) |
| targets | `page:` + `field:` + `runtimeRef` — semàntics, no selectors CSS |
| `parameters` | Bloc tipat amb defaults i prompts: el mateix script serveix per a N jocs de dades |
| validacions | Passos d'assert de valors de control (i comparació amb clipboard) |
| condicionals | Branques del tipus "quan el nombre de files és 0" |
| pàgines opcionals | Diàlegs de confirmació que poden aparèixer o no sense trencar el replay |
| Power Fx | Expressions dins dels passos |

> **Pendent de verificar en viu abans d'implementar:** l'esquema YAML exacte (noms de claus,
> anidament, versionat del format). La manera barata de fer-ho: gravar a mà 3 fluxos al `devel1`
> (obrir llista → filtrar → drill-down → editar camp → acció; un amb diàleg de confirmació; un amb
> paràmetres) i desar els `.yml` com a fixtures a `tests/recordings/page-script-*.yml`. Aquests
> fitxers passen a ser el contracte de l'exportador.

## 3. El replayer oficial — `@microsoft/bc-replay`

**npm:** https://www.npmjs.com/package/@microsoft/bc-replay

```bash
npx replay ./recordings/*.yml \
  -StartAddress https://devel1/BC \
  -Authentication UserPassword \
  -UserNameKey BC_USERNAME -PasswordKey BC_PASSWORD \
  -ResultDir ./.replay-results \
  -Headed
```

- Basat en **Playwright**; emet un informe HTML estàndard de Playwright.
- `-Authentication`: `Windows` | `AAD` | `UserPassword` → **encaixa amb els dos entorns d'aquest
  repo** (`devel1` amb NavUserPassword, SaaS amb AAD).
- `-UserNameKey`/`-PasswordKey` llegeixen **variables d'entorn**, no valors literals → encaixa amb
  el model `.secrets/*.env` d'aquest repo sense filtrar credencials a cap fitxer.
- Funciona contra on-prem, SaaS i Docker.
- AL-Go el suporta en pipelines (page scripts versionats al repo executats en CI):
  https://learn.microsoft.com/en-us/dynamics365/release-plan/2024wave2/smb/dynamics365-business-central/run-page-scripts-pipelines-automated-testing

**Precedent comunitari** (MIT): https://github.com/andywingate/D365BC-vibe-page-scripting
- Generació de variants: 1 gravació × 1 fitxer de dades → N tests YAML.
- Solució MFA per TOTP per a comptes SaaS (el mateix problema que aquest repo resol amb
  `BC_AAD_TOTP_SECRET` — es pot reaprofitar el secret).
- Instruccions Copilot perquè una IA **escrigui** el YAML: prova que la generació per LLM funciona.

## 4. Les tres eines proposades

### 4.1 `bc_export_page_script` — la peça central

**Què fa:** converteix una seqüència d'interaccions d'aquest MCP en un `.yml` de Page Scripting.

**Com obtenir la seqüència.** Cal un registre d'interaccions que avui no existeix. Disseny mínim:

1. Un `InteractionRecorder` (nou, `src/services/interaction-recorder.ts`) que rep un event per cada
   operació d'escriptura/navegació reeixida: `openPage`, `writeField`, `executeAction`,
   `navigate/drillDown`, `respondDialog`, `closePage`, i els asserts de `bc_validate` (§4.3).
2. S'activa amb `BC_RECORD_SESSION=1` o, millor, amb un parell d'eines
   `bc_start_recording` / `bc_export_page_script` perquè l'agent decideixi l'abast.
3. Cada entrada guarda el que fa falta per al YAML: caption de pàgina, pageId, caption del camp
   (NO el controlPath — Page Scripting és semàntic), valor, caption d'acció, i el `changed` real.
   Les escriptures amb `changed:false` **no s'exporten** (no van passar).

**Punts delicats ja identificats:**

- **Captions vs noms AL.** Page Scripting usa el caption visible (localitzat). Aquest MCP treballa
  amb captions per a camps però amb **noms AL per als filtres** (regla verificada del repo). En
  exportar, els filtres s'han de traduir a la forma que el gravador produeix (probablement passos
  d'interacció sobre el control de filtre, no una expressió). **Verificar amb una gravació real.**
- **Idioma.** Un YAML gravat en castellà no reprodueix en un BC en anglès. L'exportador ha de
  registrar l'idioma de la sessió al fitxer i avisar-ne.
- **`runtimeRef`.** No sabem generar-lo sense el gravador. Opció A: ometre'l i confiar en
  `page`+`field` (verificar que el replayer ho accepta). Opció B: exportar només fluxos que després
  es "normalitzen" obrint-los una vegada al gravador de BC.
- **Bookmarks.** Els nostres bookmarks són opacs i de sessió; Page Scripting selecciona files per
  contingut/filtre. La traducció fila→pas ha de basar-se en el filtre o el valor de la primera
  cel·la, no en el bookmark.

**Sortida:** fitxer a `BC_PAGESCRIPT_DIR` (default `./page-scripts`, gitignored com la resta de
sortides reproduïbles) + el YAML inline a la resposta MCP si és petit.

### 4.2 `bc_run_page_script` — reproduir

**Fase 1 (barata, recomanada per començar):** embolcallar `@microsoft/bc-replay` com a procés fill,
igual que ja es fa amb el navegador headless (fora de banda, sense tocar la sessió WS).
- Mapejar `BC_AUTH`/`.secrets` → flags `-Authentication`/`-UserNameKey`/`-PasswordKey`.
- Parsejar l'informe de Playwright del `-ResultDir` i retornar **pass/fail per pas**, no només el
  codi de sortida.
- Dependència opcional i lazy-import (mateix patró que `puppeteer-core`), perquè no afecti
  l'arrencada ni obligui ningú a instal·lar-la.

**Fase 2 (ambiciosa):** interpretar el YAML **sobre la sessió WS pròpia**, sense navegador. Guanys:
molt més ràpid, feedback per pas natiu, i funciona on no hi ha Chrome. Cost: reimplementar la
semàntica de Page Scripting (Power Fx inclòs) — només val la pena si la fase 1 demostra ús real.

### 4.3 `bc_validate` — asserts com a eina de primera classe

Avui un agent llegeix dades i decideix; no hi ha una eina que digui "això ha de valer X".
`bc_validate { pageContextId, section?, field, operator, expected }` retorna pass/fail (no dades).

Dos motius:
1. Fa que les comprovacions d'acceptació siguin explícites i auditables.
2. **Mapeja 1:1 amb els passos de validació del YAML** → és la peça que fa que l'exportació generi
   tests amb assercions, no només seqüències de clics.

## 5. Ordre d'implementació suggerit

| Pas | Feina | Per què primer |
|---|---|---|
| 0 | Gravar 3 fluxos reals al `devel1` i desar els `.yml` com a fixtures | Sense l'esquema real verificat, tot l'exportador és especulació |
| 1 | `bc_validate` | Independent, útil per si sol, i necessari per exportar asserts |
| 2 | `InteractionRecorder` + `bc_start_recording` | Infraestructura; sense això no hi ha què exportar |
| 3 | `bc_export_page_script` contra els fixtures del pas 0 | El nucli; testejable comparant amb les gravacions reals |
| 4 | `bc_run_page_script` (embolcall de bc-replay) | Tanca el cicle: exportar → reproduir → informe |
| 5 | Skill d'autoria de YAML (opcional) | Perquè l'agent també sàpiga ESCRIURE scripts a mà, no només exportar-los |

## 6. Riscos coneguts

- **El format pot canviar.** És una funcionalitat relativament nova de Microsoft; l'exportador ha
  de generar una versió d'esquema i fallar clarament si el replayer en vol una altra.
- **Dependència de captions localitzats** (§4.1). Un canvi d'idioma trenca els scripts exportats.
- **bc-replay no és codi obert del tot** (paquet npm de Microsoft, ús lliure): es pot invocar, no
  modificar. Per això la fase 2 (intèrpret propi) es manté com a opció.
- **No confondre-ho amb els tests AL.** Page Scripting és UI/UAT; els test codeunits AL són una
  altra capa (i els cobreix `bc-dev-mcp` o l'AL MCP oficial).
