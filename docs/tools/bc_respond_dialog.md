# bc_respond_dialog

> Respond to an open Business Central dialog or confirmation prompt (ok / cancel / yes / no / abort / close) to continue a workflow.

## What it does
Sends a response to a modal dialog that BC raised on a page — typically a confirmation ("Do you want to post?"), a yes/no question, a validation warning, or a modal information page. For `ok`, `cancel`, `yes`, `no`, and `abort` it invokes the matching BC `SystemAction` against the dialog form's `server:c[0]` control; for `close` it sends a `CloseForm` against the dialog form id instead. After the dialog clears, it applies the resulting events back to the originating page context, reports which page sections changed, surfaces any chained dialogs that opened in response, and lists any new pages BC created (e.g. a Posted Invoice produced by posting).

## When to use / when NOT to use
Use it when `bc_execute_action` or `bc_write_data` returned a `dialogsOpened` array with `requiresDialogResponse: true` — you must respond before the workflow can continue. If the response triggers another dialog (chained confirmations), call this tool again for each dialog in sequence using the new `dialogFormId`. Do NOT call it when no dialog is pending — there is nothing to respond to unless a prior tool returned `dialogsOpened`. Do NOT guess `dialogFormId`; always pass the exact value from the triggering tool's `dialogsOpened` entry.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageContextId` | `string` (min length 1) | Yes | Page context ID of the page that triggered the dialog. |
| `dialogFormId` | `string` (min length 1) | Yes | Dialog form ID from the `dialogsOpened` array returned by `bc_execute_action` or `bc_write_data`. |
| `response` | `enum`: `"ok"` \| `"cancel"` \| `"yes"` \| `"no"` \| `"abort"` \| `"close"` | Yes | `"ok"` confirms, `"cancel"` dismisses, `"yes"`/`"no"` answers a question, `"abort"` force-closes, `"close"` closes a modal info page. |

## Output
Returns a `RespondDialogOutput` object:

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Always `true` when the operation completes without error (failures return an error result instead). |
| `changedSections` | `string[]` | Section IDs of the originating page whose form was touched by the response events (empty for the `close` path when the page context is gone). |
| `dialogsOpened` | `Array<{ formId: string; message?: string; fields?: ControlField[] }>` | Any new dialogs raised by responding (chained confirmations). `message` is the dialog Caption/Message; `fields` are the dialog's structured controls (`ControlField`: `controlPath`, `caption`, `type`, `editable`, `visible`, optional `value`, `stringValue`, `columnBinderName`). |
| `requiresDialogResponse` | `boolean` | `true` when `dialogsOpened` is non-empty — another `bc_respond_dialog` call is required. |
| `openedPages` | `Array<{ pageContextId: string; caption: string }>` | New pages BC created in response (e.g. a Posted Sales Invoice after posting). Each carries a fresh `pageContextId` you can read with `bc_read_data`. Always empty on the `close` path. |

## Examples

Confirm a posting question:
```json
{ "pageContextId": "so1", "dialogFormId": "dialog-123", "response": "yes" }
```
Expected response shape:
```json
{
  "success": true,
  "changedSections": ["header", "lines"],
  "dialogsOpened": [],
  "requiresDialogResponse": false,
  "openedPages": [
    { "pageContextId": "session:page:7", "caption": "Posted Sales Invoice" }
  ]
}
```

Dismiss a validation warning:
```json
{ "pageContextId": "cust1", "dialogFormId": "dialog-450", "response": "cancel" }
```

Close a modal information page:
```json
{ "pageContextId": "list1", "dialogFormId": "dialog-880", "response": "close" }
```
Expected (a chained confirmation appeared and must be answered next):
```json
{
  "success": true,
  "changedSections": [],
  "dialogsOpened": [
    { "formId": "dialog-881", "message": "The operation completed successfully." }
  ],
  "requiresDialogResponse": true,
  "openedPages": []
}
```

## Notes & limitations
- The five action responses (`ok`/`cancel`/`yes`/`no`/`abort`) map to BC `SystemAction` values `Ok=300`, `Cancel=310`, `Yes=380`, `No=390`, `Abort=320` and are invoked at the dialog's `server:c[0]` control. `close` is special-cased: it sends a `CloseForm` to `dialogFormId` rather than an `InvokeAction`.
- On the `close` path, `openedPages` is always empty and `changedSections` is only computed if the originating page context still exists; new-page detection runs solely on the action-response path.
- Returns a `ProtocolError` if `pageContextId` is not found in the page context repository, or (defensively, since the enum is validated upstream) if `response` is not one of the supported values.
- Respond to chained dialogs one at a time — each call handles a single dialog; loop while `requiresDialogResponse` is `true`, using the latest `dialogsOpened[].formId`.

## Related tools
- [./bc_execute_action.md](./bc_execute_action.md) — runs page/row actions (Post, Delete, New, etc.) that raise the dialogs this tool answers.
- [./bc_write_data.md](./bc_write_data.md) — writing field values can trigger validation dialogs handled here.
- [./bc_read_data.md](./bc_read_data.md) — read the originating page or any `openedPages` returned after responding.
- [./bc_run_report.md](./bc_run_report.md) — request-page parameters are confirmed with this tool using `response: "ok"`.
