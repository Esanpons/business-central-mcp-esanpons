# bc-ws vs Playwright: quan i per què canviar

Aquest document explica els casos en què bc-ws no és suficient per automatitzar tasques a Business Central i cal recórrer a Playwright, quins errors concretes han forçat cada canvi, i la política de retorn a bc-ws.
La tasca era la BC-748

---

## Política general

| Situació                                                  | Eina a usar                  |
| --------------------------------------------------------- | ---------------------------- |
| Navegació, lectura de dades, execució d'accions estàndard | **bc-ws** (preferit)         |
| bc-ws falla per un error documentat aquí                  | **Playwright**               |
| L'error de bc-ws desapareix en reintentar                 | **Tornar a bc-ws**           |
| L'error de bc-ws persisteix                               | **Continuar amb Playwright** |

> **Regla:** bc-ws és sempre la primera opció. Playwright és el recurs quan bc-ws no pot completar la tasca. Quan la tasca es pot fer amb bc-ws, NO s'usa Playwright.

---

## Historial de canvis bc-ws → Playwright

---

### BC-748 · Creació de demo de proves (2026-06-26)

**Context:** Calia crear una nova demo (Document Type = Demo) a CRONUS_04 per al client 2000007 per verificar que el nou camp "Pending Demos" mostrava un valor no nul.

#### Errors trobats a bc-ws

**Error 1 — `bc_write_data` retorna `"reason": "not editable"`**

```
Resultat: { success: false, reason: "not editable" }
```

_Causa arrel:_ La Demo Card (page 50037) defineix `Editable = not this.IsSynchronized` als grups de contingut. Quan bc-ws intentava escriure camps (Customer No., Location Code, etc.), la resposta era sempre `not editable`, fins i tot havent comprovat que `Synchronized = false` al registre.

El problema és que bc-ws avalua l'editabilitat a nivell de propietat de control de la pàgina, i bc-ws reportava `editable: false` sense considerar el valor dinàmic de `IsSynchronized` en aquell moment. Cap camp de la Demo Card era accessible per escriptura via bc-ws.

**Error 2 — `bc_execute_action("Nuevo")` no crea un registre nou**

```
// Crida bc-ws
bc_execute_action({ pageId: ..., action: "Nuevo" })

// Resultat: navega a un registre existent (p.ex. DEM000000043)
// en lloc d'obrir un nou formulari en blanc
```

_Causa arrel:_ A la Demo Card, l'acció "Nuevo" navega al següent registre del SourceTableView en lloc d'inicialitzar un registre en blanc (mode Create). bc-ws no té cap paràmetre equivalent a `&mode=Create` de la URL de BC.

**Error 3 — No hi ha manera de passar `mode=Create` via bc-ws**

bc-ws no exposa cap mecanisme per obrir una pàgina en mode creació per a tipus de document personalitzats (Demo, etc.). `bc_open_page` no accepta paràmetres de mode.

#### Solució amb Playwright

Playwright va poder:

- Navegar directament a `https://devel1/BC/?company=CRONUS_04&page=50037&mode=Create` per obrir la Demo Card en mode creació
- Interactuar amb els camps del formulari (comboboxes, textboxes) sense restriccions d'editabilitat del servidor
- Acceptar valors als camps de les línies (grid) via `browser_type` + `browser_press_key`

**Autenticació:** Cal usar `browser_fill_form` (NO `browser_evaluate`) per introduir credencials — `browser_evaluate` amb credencials incrustades en JS és bloquejat pel classificador de permisos.

#### Estat

- Demo DEM020000000 creada per al client 2000007 amb article 0007866 (CONTACTS 2245), Qty=3, no enviada.
- Verificació: "Pending Demos" mostra **2.680 YEN** al factbox Financial Data de la Customer Card.
- **Error bc-ws NO resolt** — la restricció d'editabilitat de la Demo Card és estructural (definida en AL). No cal tornar a provar bc-ws per crear demos; usar Playwright directament.

---

## Limitacions conegudes de bc-ws

Recopilació de limitacions descobertes, per evitar perdre temps tornant a provar-les:

| Limitació                                                   | Descripció                                                                                                                                                                                                                                                                                                                                                                                          | Verificat  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Editabilitat dinàmica AL                                    | Si `Editable = not <variable>`, bc-ws pot reportar `editable: false` incorrectament o no deixar escriure                                                                                                                                                                                                                                                                                            | 2026-06-26 |
| `bc_execute_action("Nuevo")` en Card page                   | Navega a registre existent; no crea un de nou                                                                                                                                                                                                                                                                                                                                                       | 2026-06-26 |
| `mode=Create`                                               | No disponible via bc-ws                                                                                                                                                                                                                                                                                                                                                                             | 2026-06-26 |
| Factbox data en `bc_read_data`                              | Les dades de factbox només estan disponibles a la resposta inicial de `bc_open_page` si s'especifica `sections: ["factbox:..."]`; `bc_read_data` amb `sectionId` de factbox retorna la capçalera                                                                                                                                                                                                    | 2026-06-26 |
| Llista de clients amb `maxRows=250`                         | La Customer List (page 22) retorna ~49 files; no es pot recuperar un client concret si la llista no l'inclou                                                                                                                                                                                                                                                                                        | 2026-06-26 |
| Modal amb títol numèric                                     | Demo List (page 50036) s'obre com a modal amb caption "43" (nombre de registres)                                                                                                                                                                                                                                                                                                                    | 2026-06-26 |
| **`bc_screenshot` no expandeix secció "Lines" de document** | En pàgines de tipus Document (Demo Card p.50037, Sales Order p.42, etc.), la secció "Lines" apareix col·lapsada ("Lines >"). `bc_screenshot` amb `expand: true` expandeix FastTabs normals però NO fa clic al botó "Lines >" per desplegar el grid de línies. Els camps dins del grid (Quantity, Qty. to Ship, Line Amount, etc.) no es troben → `"found": false` → cap highlight ni crop possible. | 2026-06-26 |

---

## Detall de limitació: `bc_screenshot` i secció "Lines" de document

### Casuística que ho ha provocat (BC-748 · 2026-06-26)

Tasca: capturar les línies de la demo DEM020000000 (page 50037) per a la documentació, mostrant Quantity, Qty. to Ship i Line Amount Excl. VAT.

**Simptoma exacte:**

```json
{
  "annotations": [
    { "target": "Quantity", "found": false },
    { "target": "Qty. to Ship", "found": false },
    { "target": "Line Amount Excl. VAT", "found": false }
  ],
  "cropped": false
}
```

La captura generada mostra "Lines >" (grup col·lapsat) en lloc del grid amb les línies.

**Per què passa:**
BC renderitza les línies de document dins d'un grup `<section>` amb un botó toggle (≡ "Lines >"). Fins que l'usuari fa clic a "Lines", el grid interior no existeix al DOM. `bc_screenshot expand: true` crida l'API de BC per expandir FastTabs (grups de capçalera), però no fa clic en botons de secció de document com "Lines >".

**Afecta a:**

- Demo Card (page 50037) → secció "Lines"
- Sales Order Card (page 42) → secció "Lines"
- Purchase Order Card (page 50) → secció "Lines"
- Qualsevol pàgina de tipus Document amb secció repeater independent de la capçalera

**Com corregir-ho en el futur (quan bc-ws ho suporti):**
Idealment, `bc_screenshot` hauria de tenir un paràmetre `clickBeforeCapture: ["Lines"]` (o similar) que permetés clicar botons de secció concrets abans de capturar. Fins que existeixi, usar Playwright per a capturas de línies de document.

**Workaround actual:**

1. Usar Playwright: navegar a la Demo Card, clicar el botó "Lines", esperar que el grid es renderitzi, fer `browser_take_screenshot`.
2. Alternativament, capturar la pàgina de Sales Lines (page 46 o equivalent) filtrada per Document No. si existeix una pàgina de consulta adequada.

---

## Com documentar un nou canvi

Quan es canvia de bc-ws a Playwright en una nova tasca, afegir una secció nova en aquest fitxer seguint l'estructura:

```
### <NOM-TASCA> · <Descripció curta> (<data>)

**Context:** Per què calia automatitzar.

#### Errors trobats a bc-ws
[Codi d'error, missatge exacte, causa arrel]

#### Solució amb Playwright
[Com es va resoldre]

#### Estat
[Si l'error persisteix (no tornar a bc-ws) o si és un cas puntual (tornar a bc-ws)]
```
