# The manual source format

The format `bc_build_manual` accepts in `source` — a Markdown file it can turn into the printable
A4 page and the Word document without you retyping anything.

> **The specification is the generator.** This is exactly what the tool's own `md` output writes.
> If you are ever unsure how something is written, build a manual with `formats:["md"]` and read it.
> A round-trip test asserts the two stay identical, so this page cannot quietly drift from reality.

## Why a format at all

An assistant asked to "write a manual in Markdown" writes it differently every time, and no parser
survives that. So the direction is reversed: the format is fixed and documented here, the tool
[validates](#validating-before-you-build) it and points at the exact line when something is off, and
the assistant writes to the spec instead of inventing one.

## The file

```markdown
---
lang: ca
cover: true
toc: true
---

# Gestió de clients

Prosa d'introducció. Tot el que hi ha entre el títol i el primer pas.

## 1. Obre la llista de clients

Prosa que va **a sobre** de la captura.

- pots fer llistes
- i tot el Markdown de la taula de sota

![Llista de clients](img/pas-1.png)
*Peu de figura*

Prosa que va **a sota** de la captura.

## 2. Obre la fitxa

Un pas pot no tenir captura.

| Ajust | Valor | Per que |
|---|---|---:|
| TLS minim | 1.2 | Requisit legal |

~~~bash
az group create --name rg-deca --location spaincentral
~~~
```

| Element | Regla |
|---|---|
| Front matter | Opcional. `key: value` plans entre `---`. Claus: `lang`, `cover`, `toc`, `name`, `assets`. |
| `# Títol` | **Obligatori**, exactament un. El primer `# ` del fitxer. |
| Introducció | Tot el que hi ha entre el títol i el primer `## `. |
| `## Encabezado` | **Obligatori**, com a mínim un. Un per pas. El `1. ` inicial és opcional — la numeració la posa la posició. |
| Prosa abans de la imatge | `body` — el que s'ha de fer. |
| `![alt](ruta.png)` | Com a màxim **una** per pas. Ruta relativa **al `.md`**. |
| `*Peu*` | Opcional. Línia només en cursiva, **just després** de la imatge. |
| Prosa després del peu | `after` — què s'ha de mirar a la captura, o què ve a continuació. |

El front matter viatja amb el document: el mateix fitxer sempre es construeix igual. Un argument
passat a la crida guanya igualment, així que pots reconstruir-lo en un altre idioma sense editar-lo.

## Markdown admès dins la prosa

El mateix subconjunt a `body`, a `after` i a la introducció.

| Sintaxi | Resultat |
|---|---|
| línia en blanc | paràgraf nou (les línies seguides s'ajunten en un de sol) |
| `- item` / `* item` | llista de pics |
| `1. item` | llista numerada |
| `> text` | caixa de nota destacada |
| `### text` | sub-apartat dins del pas (`##` és el pas) |
| capçalera + `\|---\|---\|` + files | **taula** (vegeu sota) |
| ``` … ``` o `~~~ … ~~~` | **bloc de codi** (vegeu sota) |
| `**text**` | negreta |
| `*text*` / `_text_` | cursiva |
| `` `text` `` | codi en línia |
| `[text](https://…)` | enllaç |

### Taules

Format GFM: una fila de capçalera, la fila delimitadora i les dades.

```markdown
| Ajust | Valor | Per que |
|:---|:---:|---:|
| TLS minim | 1.2 | Requisit legal |
```

- La **fila delimitadora és obligatòria**. Sense ella no hi ha taula: les barres surten
  com a text i el validador t'avisa.
- L'alineació de cada columna surt d'aquesta fila: `:---` esquerra, `:---:` centre, `---:` dreta.
- Dins d'una cel·la hi va el mateix format en línia que a la prosa (negreta, codi, enllaços).
- Una barra que és **contingut** s'escriu `\|`, o es posa dins de `` `codi` ``.
- Una fila més curta que la capçalera s'omple amb cel·les buides.
- Una taula **més llarga que un full es parteix**, i cada tros repeteix la capçalera.
  Al Word és una taula de debò, amb la primera fila marcada com a «repetir a cada pàgina».

### Sub-apartats

`##` és el **pas**; `###` (o més profund) és un **sub-apartat dins del pas**, no un pas nou.
Serveix per trencar un pas llarg: «Permisos», «Si alguna cosa falla». No surt a l'índex del
manual —l'índex llista passos— però sí al panell de navegació del Word.

### Blocs de codi

```markdown
~~~bash
az deployment group create   --resource-group rg-deca   --template-file template.json
~~~
```

- **Literal**: res del que hi ha dins es formata. La indentació i les línies en blanc
  es conserven, així que els diagrames ASCII surten bé.
- Amb ``` o amb `~~~`. Fes servir `~~~` quan el contingut porti cometes invertides.
- La paraula després de l'obertura (`bash`, `json`, …) es guarda, però **no** hi ha
  coloració de sintaxi.
- Un bloc més llarg que un full també es parteix per línies.

## El que el model NO té

Aquests casos no fan fallar la construcció, però **es degraden** i el validador te'ls diu:

| Al `.md` | Què passa |
|---|---|
| Segona imatge en un pas | Es descarta; parteix el pas en dos per conservar-la |
| Imatge abans del primer `## ` | Es descarta: la introducció no porta figura |
| Taula sense fila delimitadora | Surt com a text amb barres verticals |
| Bloc de codi que no es tanca | Tot el que ve a sota es tracta com a codi |
| Llista dins d'una llista | S'aplana a un sol nivell |

Dins d'un bloc de codi **res no és estructura**: un `## `, un `![](…)` o un `*peu*` en un
llistat són contingut i no parteixen el document. Això és el que permet que un manual
documenti aquest mateix format.

I aquests **sí** que aturen la construcció:

- No hi ha `# ` (títol)
- No hi ha cap `## ` (cap pas)
- Un encapçalament de pas buit
- Una imatge que no existeix al disc
- Una imatge que és una URL — només s'incrusten fitxers locals
- Front matter obert amb `---` i mai tancat

## Validant abans de construir

Quan el `.md` no l'ha generat aquesta eina, valida'l primer:

```json
{ "source": "D:/manuals/gestio-clients.md", "validate": true }
```

No escriu res. Retorna `sourceDiagnostics` amb **tots** els problemes d'una sola passada:

```
line 2: warning: unknown front matter key "color", ignored
line 9: warning: table without a delimiter row — add "|---|---|" under the header, …
line 12: warning: sub-heading — a manual has one heading level; …
line 19: error: image "captura.png" does not exist (resolved to D:/manuals/captura.png)
```

Corregeix-los tots i construeix. Una construcció normal també retorna `sourceDiagnostics`, així que
els avisos mai passen desapercebuts.

## Construint

```json
{ "source": "D:/manuals/gestio-clients.md", "formats": ["html", "docx"] }
```

Les imatges es resolen relatives al `.md` i **no cal moure-les**. Els fitxers surten al costat del
document original, tret que passis `outDir`.

Un detall: si demanes `md` i el resultat sobreescriuria el fitxer d'origen, la crida **falla** amb un
missatge que t'ho diu. No es destrueix mai l'entrada; passa `name` o `outDir` si vols una còpia.

## Relacionat

- [Documenting BC](documenting.md) — quina eina i quin format per a cada cas.
- [tools/bc_build_manual.md](../tools/bc_build_manual.md) — referència completa de paràmetres.
