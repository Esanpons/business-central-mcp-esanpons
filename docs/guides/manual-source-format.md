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

| Sintaxi | Resultat |
|---|---|
| línia en blanc | paràgraf nou |
| `- item` / `* item` | llista de pics |
| `1. item` | llista numerada |
| `> text` | caixa de nota destacada |
| `**text**` | negreta |
| `*text*` / `_text_` | cursiva |
| `` `text` `` | codi en línia |
| `[text](https://…)` | enllaç |

## El que el model NO té

Aquests casos no fan fallar la construcció, però **es degraden** i el validador te'ls diu:

| Al `.md` | Què passa |
|---|---|
| Taula Markdown | Surt com a text amb barres verticals |
| Bloc de codi amb ``` | Les marques de tanca s'imprimeixen com a text |
| `###` o més profund | Es renderitza com un paràgraf que comença amb `#` |
| Segona imatge en un pas | Es descarta; parteix el pas en dos per conservar-la |
| Imatge abans del primer `## ` | Es descarta: la introducció no porta figura |

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
line 9: warning: Markdown table — not supported by the manual model, …
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
