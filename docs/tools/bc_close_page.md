# bc_close_page

> Close an open Business Central page and free its server-side WebSocket form resources.

## What it does
Closes a page previously opened with `bc_open_page` (or a drill-down page returned by `bc_navigate`) by sending a `CloseForm` interaction for every form owned by that page context, then removes the page context from the repository so the `pageContextId` becomes invalid. It iterates `ctx.ownedFormIds`, invoking `CloseForm` per form, and collects all resulting BC events. If closing triggers a "save changes?" dialog, that dialog is surfaced in the output (it is not auto-dismissed by this tool — see Notes). After all forms are closed, the page context is dropped and its WebSocket form sessions are released on the BC server.

## When to use / when NOT to use
- Use it when you have finished all reads, writes, and actions on a page, to prevent server-side resource leaks. Always close every page you open.
- Use it once per `pageContextId`: if `bc_navigate` opened a drill-down page (returning a new `pageContextId`), close both that drill-down page and the original list page.
- Do NOT call it in the middle of a multi-step workflow — finish all `bc_read_data` / `bc_write_data` / `bc_execute_action` / `bc_navigate` calls on the page first.
- Do NOT call it to "reset" or refresh a page; use `bc_read_data` to refresh data instead.
- Do NOT reuse the `pageContextId` afterward — any subsequent `bc_read_data`, `bc_write_data`, `bc_execute_action`, or `bc_navigate` call with it will fail (the context is removed from the repo). It is, however, safe to call this even if prior operations on the page errored.

## Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageContextId` | `string` (min length 1) | Yes | Page context ID returned by bc_open_page. Becomes invalid after closing. |

## Output
Returns a `ClosePageOutput` object (`src/operations/close-page.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Always `true` when the operation resolves successfully (the underlying `closePage` result is mapped to `success: true`). |
| `dialogsOpened` | `Array<{ formId: string; message?: string; fields?: ControlField[] }>` | Dialogs raised while closing (e.g. an unsaved-changes "save changes?" prompt). Each entry has the dialog's `formId`, an optional human-readable `message` (pulled from the dialog control tree's `Caption` or `Message`), and optional structured `fields`. Empty when no dialog opened. |
| `requiresDialogResponse` | `boolean` | `true` when `dialogsOpened.length > 0` — the caller must handle the dialog (via `bc_respond_dialog`) before the close is considered complete. `false` for a clean close. |

Each entry in `fields` is a `ControlField` (`src/protocol/types.ts`): `controlPath` (string), `caption` (string), `type` (string), `editable` (`boolean | 'unknown'`), `visible` (boolean), optional `value` (unknown), `stringValue` (string), `columnBinderName` (string), `isLookup` (boolean), and `showMandatory` (boolean).

If the page context does not exist, the underlying service returns a `ProtocolError` (`Page context not found: <pageContextId>`) and the tool surfaces it as an error result rather than a `ClosePageOutput`.

## Examples

Close a page after finishing work on it:
```json
{ "pageContextId": "session:page:abc123" }
```
Expected clean-close response:
```json
{
  "success": true,
  "dialogsOpened": [],
  "requiresDialogResponse": false
}
```

Close a page that has unsaved edits and triggers a save-changes prompt:
```json
{ "pageContextId": "session:page:def456" }
```
Expected response requiring a follow-up:
```json
{
  "success": true,
  "dialogsOpened": [
    { "formId": "dialog-789", "message": "Do you want to save the changes?" }
  ],
  "requiresDialogResponse": true
}
```
Then respond to the dialog before considering the page closed:
```json
{ "pageContextId": "session:page:def456", "dialogFormId": "dialog-789", "response": "no" }
```

Close both a drill-down page and its originating list page (two separate calls):
```json
{ "pageContextId": "session:page:drilldown-card" }
```
```json
{ "pageContextId": "session:page:list" }
```

## Notes & limitations
- The operation closes **all** forms owned by the page context (`ctx.ownedFormIds`), not just the root form, and calls `session.removeOpenForm(formId)` for each before removing the context from the repository.
- The page-service layer supports an internal `options.discardChanges` flag that auto-dismisses a close-triggered dialog by invoking `No` (SystemAction `390`). The `bc_close_page` tool does **not** expose this option — `ClosePageInput` carries only `pageContextId`. So if a save-changes dialog appears, it is returned in `dialogsOpened` with `requiresDialogResponse: true` for the caller to resolve via `bc_respond_dialog`.
- A successful close always reports `success: true`; the meaningful signal is whether `requiresDialogResponse` is `true`, indicating the close is pending a dialog response.
- After a successful close the `pageContextId` is gone from the repository; reusing it yields a "Page context not found" error from any page-bound tool.

## Related tools
- [bc_open_page](./bc_open_page.md)
- [bc_read_data](./bc_read_data.md)
- [bc_write_data](./bc_write_data.md)
- [bc_execute_action](./bc_execute_action.md)
- [bc_navigate](./bc_navigate.md)
- [bc_respond_dialog](./bc_respond_dialog.md)
