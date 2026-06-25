# bc_wizard_navigate
> Drive a Business Central NavigatePage / multi-step wizard one semantic step at a time.

## What it does
Advances, rewinds, completes, or aborts a Business Central wizard (`pageType: "NavigatePage"`, `isModal: true`) by invoking its built-in navigation button. The tool locates the back/next/finish/cancel button by the icon resource BC's own web client uses (`Actions/PreviousRecord`, `Actions/NextRecord` / `Action_Start`, `Actions/Approve`, and `SystemAction.Cancel`/`Abort`/`CloseOk`), not by caption or SystemAction id, so localized wizards work unchanged. After the navigation completes it re-resolves the page's `header` section and returns the fields visible on the new step, the wizard-nav actions still available, and a `closed` flag. Because the BC web client owns the step counter client-side (it emits no `PropertyChanged` events on next/back), bc-mcp mirrors the step transition internally on `next`/`back` so the subsequent read sees the correct step's fields.

## When to use / when NOT to use
Use it after `bc_open_page` on a page whose response reports `isModal: true` and `pageType: "NavigatePage"` (Continia activation wizards, BC setup/assisted-setup wizards, multi-step request pages). Drive each step with `next`/`back`, fill inputs in between with `bc_write_data`, and complete with `finish` (or abort with `cancel`).

Do NOT use it for ordinary (non-wizard) pages or for regular header/line/system actions like Post, Release, Delete, or New — use `bc_execute_action` instead. Do NOT call `next` past the last step; switch to `finish` once `availableNav` lists it. If the page is not a wizard, the underlying action lookup returns a "No wizard action of type ... on this page" error (it includes the page's `pageType` and `isModal` for diagnosis).

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageContextId` | `string` (min length 1) | Yes | Page context ID returned by bc_open_page for a NavigatePage / wizard. |
| `action` | `enum`: `"back"` \| `"next"` \| `"finish"` \| `"cancel"` | Yes | Wizard step navigation. "next" advances, "back" returns to previous step, "finish" completes the wizard, "cancel" aborts. |

## Output
Returns the `WizardNavigateOutput` shape (`src/operations/wizard-navigate.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the underlying action invocation completed successfully. |
| `caption` | `string` | Step caption / page caption after the navigation completes. |
| `fields` | `Array<{ name: string; value?: string; editable: boolean }>` | Fields visible on the new step. `name` is the field caption, `value` is its current string value (omitted when unset), `editable` is whether the field can be written. Only effectively-visible, captioned fields are included. |
| `availableNav` | `WizardNav[]` (subset of `"back"` \| `"next"` \| `"finish"` \| `"cancel"`) | Wizard navigation actions still available on the new step (a step may not expose all four — e.g. step 0 has no `back`, the last step has `finish` instead of `next`). |
| `closed` | `boolean` | True when the wizard closed. Set when `action` was `finish` or `cancel` and no nav actions remain (or when the page context no longer exists). Treat the page as done; its `pageContextId` is then invalid. |
| `changedSections` | `string[]` | sectionIds that changed as a result of the navigation, derived from the resulting events. |
| `dialogsOpened` | `Array<{ formId: string; message?: string; fields?: ControlField[] }>` | Dialogs/modal pages opened during the navigation (e.g. a confirmation triggered by `finish`). Respond to each with `bc_respond_dialog` using its `formId`. |

## Examples

Advance to the next step:
```json
{ "pageContextId": "session:page:wizard:1", "action": "next" }
```
Expected response shape:
```json
{
  "success": true,
  "caption": "Set up bank account",
  "fields": [
    { "name": "Bank Account No.", "value": "", "editable": true },
    { "name": "IBAN", "value": "", "editable": true }
  ],
  "availableNav": ["back", "next", "cancel"],
  "closed": false,
  "changedSections": ["header"],
  "dialogsOpened": []
}
```

Complete the wizard on the last step:
```json
{ "pageContextId": "session:page:wizard:1", "action": "finish" }
```
Expected response shape (wizard closes itself; `pageContextId` becomes invalid afterward):
```json
{
  "success": true,
  "caption": "That's it!",
  "fields": [],
  "availableNav": [],
  "closed": true,
  "changedSections": [],
  "dialogsOpened": []
}
```

Abort the wizard:
```json
{ "pageContextId": "session:page:wizard:1", "action": "cancel" }
```

## Notes & limitations
- Button identification is icon-based (`PreviousRecord`→back, `NextRecord`/`Action_Start`→next, `Approve`→finish, `SystemAction.Cancel`/`Abort`/`CloseOk`→cancel), so localized captions need no special handling.
- The BC web client emits no `PropertyChanged` events when next/back fires; bc-mcp mirrors the step index internally (only on `next`/`back`, and only within `[0, stepPaths.length)`) so the next read returns the correct step's fields. `finish` and `cancel` are handled server-side and close the wizard.
- `closed` becoming `true` invalidates the `pageContextId`; do not reuse it. If the context was already gone when the operation ran, `closed` is forced to `true`.
- The action lookup fails with a descriptive `ProtocolError` if the requested nav type does not exist on the current step (it lists the available wizard-nav types), or if the matching button is present but disabled at that step.
- `success` reflects only that the invocation completed — always inspect `availableNav`, `fields`, and `dialogsOpened` to decide the next move; a `finish` that surfaces a confirmation dialog will not be `closed` until you answer it via `bc_respond_dialog`.

## Related tools
- [bc_open_page](./bc_open_page.md) — opens the wizard and provides the `pageContextId` (check `isModal`/`pageType`).
- [bc_write_data](./bc_write_data.md) — fill the input fields on each wizard step between navigations.
- [bc_respond_dialog](./bc_respond_dialog.md) — answer any dialog surfaced in `dialogsOpened` (e.g. a finish confirmation).
- [bc_execute_action](./bc_execute_action.md) — the tool to use for non-wizard pages and ordinary actions.
- [bc_read_data](./bc_read_data.md) — re-read a section after navigation if you need more than the returned `fields`.
- [bc_close_page](./bc_close_page.md) — close the page if you abandon the wizard without finishing/cancelling.
