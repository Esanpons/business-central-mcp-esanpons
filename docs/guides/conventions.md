# Conventions (cross-cutting behavior)

Concepts and rules that apply across every `bc-ws` tool. Read this once; the per-tool pages in
[`../tools/`](../tools/) assume it.

## 1. The `pageContextId` lifecycle

Everything is anchored to a `pageContextId`:

1. **`bc_open_page`** opens a page and returns a `pageContextId` (plus the page's `sections`).
2. Every other data/action tool (`bc_read_data`, `bc_write_data`, `bc_execute_action`,
   `bc_navigate`, `bc_respond_dialog`, `bc_wizard_navigate`) takes that `pageContextId`.
3. **`bc_close_page`** frees it; afterwards the id is invalid.

A drill-down (`bc_navigate { action: "drill_down" }`) or a cue drill-down
(`bc_execute_action { cue }`) opens a **new** page and returns a **new** `pageContextId` in
`openedPages`; the original page stays open. Close both when done. `bc_switch_company` and a
session loss (`SESSION_LOST`) invalidate **all** open page contexts — re-open what you need.

## 2. The Section model

A page is a flat, ordered list of `Section`s. Each has `sectionId`, `kind`, `caption`:

- **`header`** — the page's primary content. Card-shape (carries `fields[]`) on Card/Document
  pages, list-shape (carries `rows[]`) on List pages. The `kind` stays `"header"` either way.
- **`lines`** — a document's line items (list-shape, `rows[]` + `totalRowCount`).
- **`factbox`** — a CardPart attached as a FactBox. `sectionId` is `factbox:<caption>`.
- **`subpage`** — any other embedded part. `sectionId` is `subpage:<caption>`.
- **`requestPage`** — a report's request-page modal.

Card-shape sections carry **`fields[]`**; list-shape sections carry **`rows[]`** (cells keyed by
the column binder name, not the caption). Header sections also carry **`actions[]`**. Sections
whose form has cuegroup tiles carry **`cues[]`**. Pass any `sectionId` as the `section` argument
to `bc_read_data` / `bc_write_data` to scope the operation.

## 3. Field targeting & duplicate captions

Document headers repeat captions across groups — a Sales Quote has `Name`, `Address`, `City`
under both Sell-to and Bill-to (and Ship-to). To target the right control there are **two
mechanisms**, in order of reliability:

### controlPath (always reliable — ground truth)
Every field in `fields[]` carries a stable **`controlPath`** (e.g. `server:c[4]/c[1]/c[1]/c[3]`),
unique even when captions collide. Pass it **as the `fields` key** in `bc_write_data`, or in
`columns` in `bc_read_data`:

```json
bc_write_data { "pageContextId": "...", "fields": { "server:c[4]/c[1]/c[1]/c[3]": "2000008" } }
```

This is the **guaranteed** disambiguator — when in doubt, read the field's `controlPath` from
`bc_open_page` / `bc_read_data` and use it.

### group (convenient, label-based)
Each field also carries a **`group`** label, and `bc_write_data` / `bc_read_data` accept a
`group` argument to scope by it:

```json
bc_write_data { "pageContextId": "...", "group": "Bill-to", "fields": { "Name": "2000008" } }
bc_read_data  { "pageContextId": "...", "group": "Bill-to" }
```

How `group` is derived: it is the caption of the nearest enclosing group container. BC labels
these inconsistently — Sell-to is a real captioned group, but the Bill-to / Ship-to **address
sub-blocks** are auto-named by BC (`Control41`, `Control49`, …). For those, `bc-ws` derives the
label from the sibling **option selector** that introduces the block (the `Bill-to` / `Ship-to`
dropdown), so `group: "Bill-to"` still resolves to the Bill-to address fields.

**Safety guarantee:** when you pass a `group` and no field with that caption exists in that
group, the write **fails explicitly** (`Field not found: <caption> (group "<g>")`, with
`availableGroups` and a hint in the error) — it will **never** silently fall back to a field in
a different group. If `group` ever surprises you, fall back to the `controlPath` form, which
cannot be ambiguous.

## 4. Write verification — `success` vs `changed`

`bc_write_data` returns, per field: `requested`, `newValue`, `changed`, and (on a no-op)
`reason`. **`success` only means the SaveValue interaction completed without a protocol error —
it does NOT mean the value stuck.** A write can complete yet be a no-op (BC rejected/reverted it,
or the control was not editable); that returns `changed: false` + a `reason`
(`"not editable" | "validation reverted" | "control not found"`). The operation's `allSucceeded`
is `true` only when every write actually changed.

**Rule: branch on `changed`, not on `success`.** (BC may legitimately reformat a value — e.g. a
customer number resolves to the customer name — so the final `newValue` can differ from
`requested` while still being a real change; that is `changed: true`.)

## 5. `editable` is tri-state

A field's `editable` is `true`, `false`, or **`"unknown"`**. `"unknown"` means BC has not emitted
an Editable flag for that control — common for **page-variable option controls** (the Ship-to /
Bill-to selectors). **`"unknown"` is NOT read-only:** attempt the write and confirm the effect
via the `changed` flag (§4). This tri-state applies to both `Section.fields[]` and the fields in
`dialogsOpened[].fields`.

## 6. Payload control (avoid token overflows)

Large documents/lists can overflow an LLM's token budget. Narrow the response:

- **`bc_open_page`** accepts `summary` (only `sectionId`/`kind`/`caption` per section — best first
  call on a big page, then pull each section with `bc_read_data`), `sections` (only these
  section ids), `tab` (header fields of one tab), `columns` (fields/columns by caption or
  controlPath), and `range` (`{offset,limit}` over already-loaded rows).
- **`bc_read_data`** accepts `tab`, `group`, `columns`, `range`, and server-side `filters`.
- **`bc_execute_action`** accepts `quiet: true` to suppress the full `updatedFields` dump that
  document actions (`Edit`, `New`) otherwise return; read back the fields you need afterwards.

## 7. Structured error codes

Errors carry a stable `code` (and usually a `context` with actionable detail):

- **`PAGE_NOT_MATERIALIZED`** — `bc_open_page` could not produce a usable page (Unknown type, no
  sections, or it opened a dialog). The `reason` says which; handle the dialog or open the host
  page.
- **`CARDPART_STUB`** — a CardPart opened standalone returned a placeholder shell; open its host
  page (the `hostHint` says how).
- **`SESSION_LOST`** — the session was lost/recreated; all page contexts are invalid, re-open
  what you need.
- **`MODAL_RECONCILE_ERROR`** — a stuck server-side modal forced a session reset.
- **`REPORT_DOWNLOAD_ERROR`** — `bc_download_report` failed (e.g. no Chrome/Edge present).

See [`../ROADMAP.md`](../ROADMAP.md) for current limitations and pending work.
