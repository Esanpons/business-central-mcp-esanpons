# bc_execute_action

> Invokes either a named action or a Role Center cue-tile drill-down on an already-open BC page, then reports what changed (fields, sections, opened pages, dialogs).

## What it does
Executes exactly one of an `action` (a named header/line/system action such as Post, Release, New, Delete) or a `cue` (a Role Center cue-tile drill-down) against an open page identified by `pageContextId`. The operation resolves the target within the requested `section`, validates that it is visible and enabled, sends an `InvokeAction` RPC to BC, applies the resulting protocol events to the page context, and returns the post-invoke state. For named actions, well-known names (`new`, `delete`, `refresh`, `edit`, `view`) take a SystemAction fast path; on pages with a repeater the row-targeting actions (Delete, Edit, View, DrillDown, New) are routed to the current row via the `{repeaterPath}/cr/c[0]` control path. Cue drill-downs send `DrillDown` (SystemAction 120) against the cue's control path and register the ownerless `FormCreated` page that BC opens.

## When to use / when NOT to use
Use it to trigger header/line/system actions (Post, Release, Reopen, New, Delete, Refresh) and to drill into Role Center cue tiles to open the underlying list. For row-scoped actions on a list or document lines, pass `section` to disambiguate header vs. line actions, and (per the tool description) `rowIndex`/`bookmark` to pick the row.

Do NOT use it to write field values — use `bc_write_data`. Do NOT use it to open a record from a list row — use `bc_navigate` with `action: "drill_down"`. Passing both `action` and `cue`, or neither, is an error. Using `cue` without `section` is an error.

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageContextId` | `string` (min 1) | Yes | Page context ID returned by bc_open_page. |
| `action` | `string` (min 1), optional | One of action/cue | Action caption name to execute (case-insensitive). Use action OR cue, not both. Must match a visible, enabled action from bc_open_page response. |
| `cue` | `string` (min 1), optional | One of action/cue | Cue tile name to drill down on (e.g. "Sales Quotes", "Pending Approvals"). Use with section pointing at the subpage that owns the cuegroup. Use action OR cue, not both. |
| `section` | `string`, optional | Required when using cue | Section context. Required when using cue; optional for action. Examples: "lines", "subpage:Activities". |
| `rowIndex` | `number`, optional | No | 0-based row position for row-scoped actions. |
| `bookmark` | `string`, optional | No | Stable row identifier for row-scoped actions. |
| `quiet` | `boolean`, optional | No | Suppress the full updatedFields dump. Document actions ("Editar"/"New") otherwise return 100+ header fields. With quiet, only success/changedSections/openedPages/dialog come back; read the fields you need afterwards with bc_read_data. |

The schema is refined with `!!action !== !!cue` — exactly one of `action` or `cue` must be supplied.

Note: `rowIndex` and `bookmark` are accepted by the schema and documented in the tool description as the way to select a row for row-scoped actions, but the current `ExecuteActionOperation`/`ActionService` implementation does not read them — row targeting is resolved through the repeater's current row (`{repeaterPath}/cr/c[0]`) via the resolved `section`. Position the row beforehand (e.g. with `bc_navigate` `action: "select"`) when a specific row matters.

## Output
Returns an `ExecuteActionOutput` object:

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the InvokeAction RPC completed successfully. |
| `dialog` | `{ formId: string; message?: string; fields?: ControlField[] }`, optional | Present when the action opened a dialog; `message`/`fields` are merged from the matching `dialogsOpened` entry. |
| `updatedFields` | `Array<{ name: string; value?: string }>`, optional | Visible, captioned header fields after the action (`name` = caption, `value` = stringValue). Omitted when `quiet` is true or no updated header state is available. |
| `changedSections` | `string[]` | Section IDs whose data changed as a result of the action (from `detectChangedSections`). |
| `openedPages` | `Array<{ pageContextId: string; caption: string }>` | New pages opened by the action — derived from `FormCreated` events for forms other than the source page, including the page context created for a cue drill-down. |
| `dialogsOpened` | `Array<{ formId: string; message?: string; fields?: ControlField[] }>` | Dialogs/modal pages opened (from `detectDialogs`). |
| `requiresDialogResponse` | `boolean` | True when `dialogsOpened` is non-empty; the caller must follow up with `bc_respond_dialog`. |

`ControlField` (in `dialog.fields` / `dialogsOpened[].fields`) carries `controlPath`, `caption`, `type`, `editable` (`boolean | "unknown"`), `visible`, optional `value`, `stringValue`, `columnBinderName`, `isLookup`, and `showMandatory`.

## Examples

Post a sales order:
```json
{ "pageContextId": "so1", "action": "Post" }
```
Expected response shape:
```json
{
  "success": true,
  "updatedFields": [{ "name": "Status", "value": "Released" }],
  "changedSections": ["header"],
  "openedPages": [],
  "dialogsOpened": [
    { "formId": "f12", "message": "Do you want to post the order?" }
  ],
  "requiresDialogResponse": true
}
```

Create a new record, suppressing the field dump:
```json
{ "pageContextId": "abc", "action": "New", "quiet": true }
```
Expected response shape:
```json
{
  "success": true,
  "changedSections": ["header"],
  "openedPages": [],
  "dialogsOpened": [],
  "requiresDialogResponse": false
}
```

Drill into a Role Center cue tile:
```json
{ "pageContextId": "rc1", "section": "subpage:Activities", "cue": "Sales Quotes" }
```
Expected response shape:
```json
{
  "success": true,
  "changedSections": [],
  "openedPages": [
    { "pageContextId": "session:page:cue:1a2b3c4d", "caption": "Sales Quotes" }
  ],
  "dialogsOpened": [],
  "requiresDialogResponse": false
}
```

## Notes & limitations
- Exactly one of `action` / `cue` is required; the Zod refinement rejects "both" and "neither" with `Provide exactly one of: action, cue`.
- Action name matching is case-insensitive against the action caption. If not found, the error includes `availableActions` (visible + enabled captions); if the action exists in another section, the error names that section and tells you to retarget via `section`. A found-but-disabled action returns `Action is disabled: <name>`.
- `cue` requires `section`; the error otherwise is `cue requires a section (e.g. "subpage:Activities")`. An unknown cue returns `availableCues`; a non-drill-downable cue returns `Cue '<name>' is not drill-downable (HasAction=false)`.
- Cue drill-down opens an ownerless top-level `FormCreated`; the operation registers it under a fresh `session:page:cue:<8-hex>` page context so it appears in `openedPages`.
- `quiet` only suppresses `updatedFields`; `success`, `changedSections`, `openedPages`, `dialogsOpened`, and dialog info are always returned.
- `updatedFields` reflects only the `header` section and only effectively-visible, captioned controls (ancestor group visibility + wizard state are taken into account).
- `rowIndex`/`bookmark` are present in the schema but not consumed by the action operation today (see Parameters note).
- Wizard navigation (`back`/`next`/`finish`/`cancel`) exists in `ActionService.executeWizardNav` but is not exposed through this tool's schema.

## Related tools
- [bc_open_page](./bc_open_page.md) — open a page and obtain the `pageContextId`.
- [bc_read_data](./bc_read_data.md) — refresh/read a section's fields or rows (use after a `quiet` action).
- [bc_write_data](./bc_write_data.md) — set field values (use this instead of an action for editing).
- [bc_navigate](./bc_navigate.md) — select/drill-down/lookup a list or document row.
- [bc_respond_dialog](./bc_respond_dialog.md) — answer the dialog when `requiresDialogResponse` is true.
- [bc_close_page](./bc_close_page.md) — close the page when finished.
