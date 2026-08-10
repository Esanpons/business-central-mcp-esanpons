# Base de coneixement — Ecosistema d'IA per a Business Central

> **Què és aquest document.** Inventari de tot el que existeix fora d'aquest repo relacionat amb
> IA + Business Central: servidors MCP, agents, skills, toolchain i fonts de coneixement. Serveix
> per saber què fan els altres, què es pot reaprofitar (només open source) i on vigilar novetats.
>
> Recopilat el 2026-08-09 a partir de: l'inventari personal d'Esteve
> (`DeCa-BC/docs/.Local/Documents Esanpons/eines-ia-bc-inventari-i-recomanacions.md`), les notes de
> `BC-Agent-Manager/docs/`, i una recerca web sobre cada repo (upstream inclòs). Les URL són la
> font primària; si un punt es contradiu amb el repo real, mana el repo.
>
> **On vigilar novetats:** [alguidelines.dev — Agentic Coding](https://alguidelines.dev/docs/agentic-coding/)
> (el catàleg comunitari, mantingut per Microsoft + comunitat) i les issues de
> [microsoft/alguidelines](https://github.com/microsoft/alguidelines). El nínxol
> "automatització del web client" hi és **buit** — aquest fork és l'únic ocupant conegut.

---

## 1. Servidors MCP — oficials de Microsoft

| Eina | Què fa | URL |
|---|---|---|
| **AL MCP Server** | Eines de desenvolupament AL sense VS Code: `al_compile`, `al_build`, `al_getdiagnostics`, `al_publish`, `al_run_tests`, `al_symbolsearch`, `al_searchtranslations`, `al_writetranslation`, `al_inspectpage`… (15 tools). S'instal·la amb `dotnet tool install --global Microsoft.Dynamics.BusinessCentral.Development.Tools` i s'arrenca amb `al launchmcpserver`. Compte: `al_publish` i `al_run_tests` ESCRIUEN al sandbox; la telemetria no es pot desactivar (l'argument variàdic `<projects>` s'empassa els flags) | [Learn](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/al-agent-tools/al-mcp-server) |
| **Business Central MCP Server (dins del producte, BC 2026w1, pàgina 8351)** | BC mateix publica un MCP a `https://mcp.businesscentral.dynamics.com` amb tools generats des de pàgines API: `List/Create/ListUpdate/Delete<nom>_PAG<id>` + bound actions (publicar documents, canviar estats). Read-only per defecte; escriptures per configuració. "Dynamic Tool Mode": 3 meta-tools `bc_actions_search` / `bc_actions_describe` / `bc_actions_invoke` (fet per al límit de 70 tools de Copilot Studio). Només entitats API — no té UI, ni informes, ni diàlegs, ni captures: valida el nínxol d'aquest fork, no el substitueix | [Overview](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/ai/mcp-overview) · [Configuració](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/ai/configure-mcp-server) |
| **Admin Center API MCP Server (preview)** | Hostatjat a `https://mcp.businesscentral.dynamics.com/admin/v1`. Exposa tota l'Admin Center API com a tools (entorns, actualitzacions, apps, sessions), excepte operacions destructives (delete/rename entorn…). Multi-tenant GDAP via el proxy d'exemple `BcAdminMcpProxy` | [Learn](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/administration-center-api-mcp) · [Proxy](https://github.com/microsoft/BCTech/tree/master/samples/BcAdminMcpProxy) |
| **Troubleshooting MCP Server for AL** | Diagnòstic d'errors AL DINS d'una sessió de depuració activa de VS Code (breakpoint aturat). No registrable en CLI | [Release plan](https://learn.microsoft.com/en-us/dynamics365/release-plan/2026wave1/smb/dynamics365-business-central/enable-troubleshooting-mcp-server-al) |
| **Microsoft Learn MCP Server** | Cerca/lectura de tota la documentació de Microsoft Learn. Remot HTTP, sense auth ni API key: `https://learn.microsoft.com/api/mcp` | [Referència](https://learn.microsoft.com/en-us/training/support/mcp-developer-reference) · [Repo](https://github.com/MicrosoftDocs/mcp) |
| **Azure MCP Server** | 40+ serveis d'Azure (Storage inclòs: llistar contenidors/blobs, propietats). `npx -y @azure/mcp@latest server start` | [Repo](https://github.com/microsoft/mcp/tree/main/servers/Azure.Mcp.Server) |
| **Azure DevOps MCP** | Work items, PR, builds, test plans, wiki | [Repo](https://github.com/microsoft/azure-devops-mcp) |
| **GitHub MCP** | Repos, issues, PR, Actions. Remot: `https://api.githubcopilot.com/mcp/` | [Repo](https://github.com/github/github-mcp-server) |

## 2. Servidors MCP — comunitat BC (web client i dades)

| Eina | Què fa | URL |
|---|---|---|
| **business-central-mcp (SShadowS)** — **l'upstream d'aquest fork** | Controla el web client de BC pel seu WebSocket intern. A la v1.5.0 (2026-07-25): 14 tools, incloent `bc_lookup` (candidats FK) i `bc_query` (OData bulk), captura de fitxers per WS (`downloads[]`, bytes de PDF d'informes), selecció multi-fila (`bookmarks[]`), `options`/`selectedOption` als camps, `sort`/`clearFilters`, 9 prompts MCP, fix del header `Origin` per a BC 28.3 on-prem. Roadmap públic ("7 capability gaps"): AssistEdit, filter-pane amb flowfilters, polling `IsExecuting` per a operacions llargues, pujada de fitxers, escriptures OData | [Repo](https://github.com/SShadowS/business-central-mcp) · [CHANGELOG](https://github.com/SShadowS/business-central-mcp/blob/master/CHANGELOG.md) · [Gap analysis](https://github.com/SShadowS/business-central-mcp/blob/master/docs/superpowers/specs/2026-07-24-mcp-gap-analysis.md) · [npm](https://www.npmjs.com/package/business-central-mcp) |
| **business-central-mcp-esanpons (aquest fork)** | Afegit sobre l'upstream: SaaS/AAD (`BC_AUTH=AAD`), `bc_screenshot` amb anotacions, `bc_build_manual` (MD + HTML A4 imprimible), `bc_download_report`, `bc_find_object`/`bc_refresh_objects`, `bc_health`, filtres `OpenForm filter=`, control de payload (`summary`/`quiet`/`group`), fix `BC_APPLICATION_ID=NAV` (adoptat per l'upstream a la PR #11) | `D:\Proyectos\Aesva\business-central-mcp-esanpons` |
| **bc-dev-mcp (SShadowS)** | MCP per a l'ENDPOINT DE DESENVOLUPAMENT de BC (els mateixos hubs SignalR que l'extensió AL de VS Code): tests AL amb cobertura, debugging interactiu (breakpoints, stepping), passthrough del MCP natiu de BC28, perfils `.alcpuprofile`. Complementari a aquest fork, no solapat | [Repo](https://github.com/SShadowS/bc-dev-mcp) |
| **user-vik/business-central-mcp-server** | API v2.0 + APIs AL custom. El millor dissenyat dels d'API: nivells lectura/escriptura/destructiu per env (`BC_MCP_MODE`), **delete en dues fases (dry-run → token)**, auth delegada Entra sense app registration (corre com l'usuari), etag, audit log d'escriptures a stderr, `invoke_bound_action` (publicar/enviar/cancel·lar documents) | [Repo](https://github.com/user-vik/business-central-mcp-server) |
| **knowall-ai/mcp-business-central** | CRUD genèric sobre API v2.0: `get_schema` (introspecció de metadades OData), `list_items` (filter/top/skip), `get_items_by_field`, create/update/delete | [Repo](https://github.com/knowall-ai/mcp-business-central) |
| **MS-Cloud-Experts/mcp-business-central** | 115 tools sobre 93 entitats (patró `{Op}{Entitat}_PAG{id}` com el de Microsoft). Destacat: **11 tools d'informes com a files** (aged AR/AP, balanç, trial balance — les entitats "report" de l'API retornades com a dades, no PDF) | [Repo](https://github.com/MS-Cloud-Experts/mcp-business-central) |
| **olederkach/business-central-mcp-server** | 14 tools; destacat: **canvi d'API en runtime** (estàndard v2.0 ↔ extensions Microsoft ↔ APIs ISV custom), `get_odata_metadata`, desplegament a Azure Container Apps | [Repo](https://github.com/olederkach/business-central-mcp-server) |
| **Bertverbeek4PS/BusinessCentralMCPserver** | No és un servidor amb tools propis: és un CLIENT Semantic Kernel del MCP de dins del producte (referència de com consumir-lo) | [Repo](https://github.com/Bertverbeek4PS/BusinessCentralMCPserver) |
| **YAMPI (Stefano Demiliani)** | MCP d'ADMINISTRACIÓ (Admin Center API), MIT, Node: 34 tools — entorns (crear/copiar/esborrar, finestres d'update, storage), apps (instal·lar/actualitzar), updates programats, **sessions actives + kill**, feature flags, pujada de PTEs. L'alternativa self-hosted al preview de Microsoft | [Repo](https://github.com/demiliani/D365BCAdminMCP) · [Article](https://demiliani.com/2025/11/11/introducing-yampi-the-mcp-server-for-dynamics-365-business-central-administration/) |
| **tant/mcp-business-central-server** | Python, OAuth2 Entra, tools habilitables per env; menor | [Repo](https://github.com/tant/mcp-business-central-server) |

## 3. Servidors MCP — desenvolupament AL (comunitat)

| Eina | Què fa | URL |
|---|---|---|
| **AL Dependency MCP (Stefan Maron)** | Símbols compilats (`.alpackages`/`.app`): `al_search_objects`, `al_get_object_definition` (camps, procediments), `al_find_references`, `al_search_object_members`, `al_get_object_summary`, `al_packages`. El mirall ESTÀTIC del `bc_find_object` runtime d'aquest fork | [Repo](https://github.com/StefanMaron/AL-Dependency-MCP-Server) |
| **BC Code Intelligence MCP (Jeremy Vyska)** | ~28 tools en 4 famílies: coneixement (`find_bc_knowledge`, `search_knowledge`…), 16 "persones" especialistes amb descobriment per confiança, handoffs entre persones, workflows. Base de coneixement en CAPES (markdown embedded + overrides d'empresa/projecte). El patró de capes és portable a qualsevol domini | [MCP](https://github.com/JeremyVyska/bc-code-intelligence-mcp) · [Coneixement](https://github.com/JeremyVyska/bc-code-intelligence) · [Wiki de tools](https://github.com/JeremyVyska/bc-code-intelligence-mcp/wiki/MCP-Tools-Reference) |
| **AL Object ID Ninja MCP (Vjeko)** | Reserva d'IDs d'objectes AL en equip (LITE individual / STANDARD pool compartit). El backend gratuït es va acabar el novembre 2025 | [npm](https://www.npmjs.com/package/@vjeko.com/al-object-id-ninja-mcp) · [Repo](https://github.com/vjekob/al-objid) |
| **NAB AL Tools MCP (Johannes Wikman)** | Flux XLIFF de traducció: inspeccionar/crear/refrescar/desar `.xlf` | [npm](https://www.npmjs.com/package/@nabsolutions/nab-al-tools-mcp) · [Docs](https://github.com/jwikman/nab-al-tools/blob/main/extension/MCP_SERVER.md) |
| **BC Telemetry Buddy (waldo)** | KQL contra Application Insights: execució amb cache, descobriment del catàleg d'events, esquema per event, base de coneixement KQL en dues capes (`get_knowledge`/`save_knowledge` — patró interessant per si mateix). Extensió VS Code + MCP standalone | [Repo](https://github.com/waldo1001/waldo.BCTelemetryBuddy) · [Variant empaquetada](https://github.com/MSdracanovic/BCTelemetry) |
| **al-lsp-for-agents (SShadowS)** | AL Language Server per a Claude Code (marketplace) | [Repo](https://github.com/SShadowS/al-lsp-for-agents) |
| **Serena (oraios)** | Edició semàntica multi-llenguatge basada en LSP; llistat a alguidelines amb suport AL | [Repo](https://github.com/oraios/serena) |

## 4. Agents, skills i frameworks

| Eina | Què és | URL |
|---|---|---|
| **ALDC — AL Development Collection (Javi Armesto)** | MIT. 16 skills (`skill-api`, `skill-copilot`, `skill-debug`, `skill-performance`, `skill-events`, `skill-permissions`, `skill-testing`, `skill-migrate`, `skill-pages`, `skill-translate`, `skill-estimation`…) + ~10 agents: 4 públics (Arquitectura, Implementació, Conductor TDD, Preventa), Triage, **Dredd** (auditor estàtic independent que cita regles BCQuality), 3 subagents interns. Tot orientat a codi AL; el valor reaprofitable és el MODEL DE DISTRIBUCIÓ multi-superfície (`.github/` Copilot + `.claude/` + plugin Claude Code + validador `aldc-validate`) | [Repo](https://github.com/javiarmesto/ALDC-AL-Development-Collection) · [Web](https://javiarmesto.github.io/ALDC-AL-Development-Collection/) |
| **bc-agentic-dev-tools-marketplace (FBakkensen)** | MIT. Marketplace de plugins de Claude Code per a BC — 5 plugins actuals: `al-agentic-dev` (workflow AL amb gates de verificació), `al-language-server`, `bc-standard-reference` ("què fa el BC estàndard a la pàgina X"), **`grill-me`** (interroga l'usuari sobre un pla fins a entendre'l — agnòstic de domini, útil abans de generar un manual), `release-notes`. Plantilla de com publicar un marketplace propi | [Repo](https://github.com/FBakkensen/bc-agentic-dev-tools-marketplace) |
| **AL Agentic Guidelines (skill)** | Mirall local de les AL Guidelines per cercar patrons offline | [Fitxa](https://mcpmarket.com/tools/skills/al-agentic-guidelines) |
| **DevOpsWorker (SShadowS)** | Pipeline multi-agent Azure DevOps + BC sobre el Claude Agent SDK | [Repo](https://github.com/SShadowS/DevOpsWorker) |
| **consultar-ia-externa (pròpia)** | Skill bi-agent (Codex ↔ Claude): la lògica viu en scripts Python, el SKILL.md és una capa fina. El cas de referència del patró de portabilitat | `~/.claude/skills/consultar-ia-externa` |
| **code-testing-generator (Microsoft, `dotnet/skills`)** | Agent open source ESPECIALITZAT a generar i validar tests unitaris. No és un model nou: és un agent que segueix un flux de treball (analitza el projecte → identifica el framework de testing → genera els tests → **els executa** → comprova errors → els corregeix). Resultats interns de Microsoft: **92,1% de tasques completades** vs 78,9% de GitHub Copilot normal, i ~63% menys de fallades; provat amb models diferents, o sigui que la millora ve en bona part de l'ESPECIALITZACIÓ de l'agent, no del model. **Per què ens importa:** és la plantilla de referència per construir un agent equivalent per a AL/Business Central (test codeunits) i/o per a Page Scripting. Vegeu `ROADMAP.md` §8 | [Article](https://devblogs.microsoft.com/dotnet/polyglot-unit-testing-agent/) · [Repo](https://github.com/dotnet/skills) |
| **BC-Agent-Manager (propi)** | Plataforma local d'orquestració d'agents neutral de proveïdor (organitzacions → projectes → repos → components; execucions pare-fill; MCP intern; FastAPI + React). Fase 1 amb base executable. Patrons reaprofitables: aprovacions humanes per a accions sensibles, secrets al Windows Credential Manager via `keyring`, redacció de secrets als logs, heartbeats/deteccio d'execucions orfes | `D:\Proyectos\Aesva\BC-Agent-Manager\docs` |

## 5. Page Scripting i testing E2E del web client

| Eina | Què és | URL |
|---|---|---|
| **Page Scripting (Microsoft, dins del web client)** | Gravador integrat (Settings → Page Scripting) que captura interaccions A NIVELL SEMÀNTIC AL (no HTML) en un **YAML documentat i editable**: passos `input`/`wait`/`include`, targets `page:` + `field:`, expressions Power Fx, blocs `parameters` amb defaults, passos de validació (asserts de valors), condicionals, pàgines opcionals (diàlegs que poden no aparèixer), composició via `include`, enllaços de replay compartibles | [Learn](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-page-scripting) |
| **@microsoft/bc-replay** | Replayer OFICIAL basat en Playwright: `npx replay ./recordings/*.yml -StartAddress <url> -Authentication Windows\|AAD\|UserPassword -Headed -ResultDir <dir>`. Funciona contra on-prem, SaaS i Docker; informe HTML Playwright estàndard. AL-Go el suporta en pipelines | [npm](https://www.npmjs.com/package/@microsoft/bc-replay) · [AL-Go](https://github.com/microsoft/AL-Go) · [Release plan](https://learn.microsoft.com/en-us/dynamics365/release-plan/2024wave2/smb/dynamics365-business-central/run-page-scripts-pipelines-automated-testing) |
| **D365BC-vibe-page-scripting (Andy Wingate)** | MIT. Generació de variants (1 gravació × fitxer de dades → N tests YAML), solució MFA via TOTP per a comptes SaaS, i instruccions Copilot per fer que **una IA escrigui el YAML directament** — prova que "LLM redacta Page Scripting" ja funciona | [Repo](https://github.com/andywingate/D365BC-vibe-page-scripting) |

> Vegeu `ROADMAP.md` per al pla d'integració Page Scripting ↔ aquest MCP (exportar sessions
> d'agent a YAML reproduïble en CI). És l'única combinació que ningú fa encara.

## 6. Toolchain AL i extensions VS Code (no IA, però ecosistema)

| Eina | Què fa | URL |
|---|---|---|
| **AL Language (Microsoft)** | Compilador + llenguatge; des de BC v28 amb Test Explorer integrat | [Learn](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-test-explorer-vscode) |
| **AL Extension Pack (waldo)** | Inclou la CRS AL Language Extension | [Marketplace](https://marketplace.visualstudio.com/items?itemName=waldo.al-extension-pack) |
| **BusinessCentral.LinterCop (Stefan Maron)** | Analitzador AL comunitari (la DLL ha de coincidir amb la versió del compilador) | [Repo](https://github.com/StefanMaron/BusinessCentral.LinterCop) |
| **AL Test Runner (James Pearson)** | Executar/depurar tests AL des de VS Code | [Marketplace](https://marketplace.visualstudio.com/items?itemName=jamespearson.al-test-runner) |
| **AL-Go for GitHub (Microsoft)** | CI/CD per a apps BC (PTE i AppSource) | [Repo](https://github.com/microsoft/AL-Go) |
| **BcContainerHelper** | Contenidors Docker de BC on-prem | [Repo](https://github.com/microsoft/navcontainerhelper) |
| Altres repos de SShadowS | CentralGauge, LethAL (mutation testing AL), al-sem, al-perf, tree-sitter-al, BC-Bench | [Perfil](https://github.com/SShadowS) |

## 7. Fonts de coneixement

| Font | Què hi ha | URL |
|---|---|---|
| **alguidelines.dev — Agentic Coding** | El catàleg d'MCP/agents/recursos per a AL. L'índex a vigilar | [Web](https://alguidelines.dev/docs/agentic-coding/) |
| **microsoft/alguidelines** | El repo del web; les issues són on apareixen les eines noves | [Repo](https://github.com/microsoft/alguidelines) |
| **Microsoft Learn — BC dev-itpro** | Documentació oficial | [Learn](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/) |
| **bc-code-intelligence** | 87+ temes atòmics en 24 dominis, format consumible per IA | [Repo](https://github.com/JeremyVyska/bc-code-intelligence) |
| Blogs | Stefano Demiliani, Stefan Maron, waldo, James Pearson, Vjeko, Freddy Kristiansen | — |

---

## 8. Lectura ràpida: què toca a quin servidor

Quan hi ha diversos MCP de BC registrats alhora, aquesta és la taula de routing:

| Necessitat | Servidor |
|---|---|
| Obrir pàgines, llegir/escriure camps, accions, diàlegs, Tell Me, captures, manuals, informes per UI | **Aquest fork** (bc-ws / bc-saas) |
| Lectures massives d'entitats API (milers de files, `$filter/$select`) | MCP de dades API v2.0 (o el `bc_query` de l'upstream quan es porti) |
| Compilar/publicar/testejar AL, cercar símbols | **AL MCP Server** (oficial) |
| Navegació de símbols compilats sense compilar | AL Dependency MCP |
| Administració de tenant (entorns, apps, sessions, updates) | Admin Center API MCP (preview) o YAMPI |
| Telemetria KQL | BC Telemetry Buddy |
| Documentació oficial | Microsoft Learn MCP |
| Debugging/tests via endpoint de desenvolupament | bc-dev-mcp |
