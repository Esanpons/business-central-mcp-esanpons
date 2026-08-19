import { z } from 'zod';
import type { Logger } from '../core/logger.js';
import {
  OpenPageSchema,
  ReadDataSchema,
  WriteDataSchema,
  ExecuteActionSchema,
  ClosePageSchema,
  SearchPagesSchema,
  NavigateSchema,
  RespondDialogSchema,
  SwitchCompanySchema,
  ListCompaniesSchema,
  RunReportSchema,
  DownloadReportSchema,
  WizardNavigateSchema,
  ScreenshotSchema,
  BuildManualSchema,
  HealthSchema,
  ResetSessionSchema,
  FindObjectSchema,
  RefreshObjectsSchema,
  toMcpJsonSchema,
} from './schemas.js';
import { HealthOperation, type HealthDeps } from '../operations/health.js';
import type { FindObjectOperation } from '../operations/find-object.js';
import type { RefreshObjectsOperation } from '../operations/refresh-objects.js';
import type { OpenPageOperation } from '../operations/open-page.js';
import type { ReadDataOperation } from '../operations/read-data.js';
import type { WriteDataOperation } from '../operations/write-data.js';
import type { ExecuteActionOperation } from '../operations/execute-action.js';
import type { ClosePageOperation } from '../operations/close-page.js';
import type { SearchPagesOperation } from '../operations/search-pages.js';
import type { NavigateOperation } from '../operations/navigate.js';
import type { RespondDialogOperation } from '../operations/respond-dialog.js';
import type { SwitchCompanyOperation } from '../operations/switch-company.js';
import { ResetSessionOperation } from '../operations/reset-session.js';
import type { ListCompaniesOperation } from '../operations/list-companies.js';
import type { RunReportOperation } from '../operations/run-report.js';
import type { DownloadReportOperation } from '../operations/download-report.js';
import type { WizardNavigateOperation } from '../operations/wizard-navigate.js';
import type { ScreenshotOperation } from '../operations/screenshot.js';
import type { BuildManualOperation } from '../operations/build-manual.js';

/**
 * The STATIC half of a tool: everything `initialize` / `tools/list` needs, with no
 * services, no session and no BC connection behind it. Split out from the executable
 * half because both server entrypoints must advertise the tool surface before any BC
 * login has happened — the old workaround built the entire service graph on a forged
 * `{} as BCSession` just to harvest these four fields, which only worked as long as no
 * constructor dereferenced the session.
 */
export interface ToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  zodSchema: z.ZodType;
}

export interface ToolDefinition extends ToolMetadata {
  execute: (input: unknown) => Promise<unknown>;
}

/** A tool's executable half: pure routing from validated input to an operation. */
type ToolExecutor = (ops: Operations, input: unknown) => Promise<unknown>;

interface ToolSpec extends ToolMetadata {
  execute: ToolExecutor;
}

export interface Operations {
  openPage: OpenPageOperation;
  readData: ReadDataOperation;
  writeData: WriteDataOperation;
  executeAction: ExecuteActionOperation;
  closePage: ClosePageOperation;
  searchPages: SearchPagesOperation;
  navigate: NavigateOperation;
  respondDialog: RespondDialogOperation;
  switchCompany: SwitchCompanyOperation;
  listCompanies: ListCompaniesOperation;
  runReport: RunReportOperation;
  downloadReport: DownloadReportOperation;
  wizardNavigate: WizardNavigateOperation;
  screenshot: ScreenshotOperation;
  buildManual: BuildManualOperation;
  findObject: FindObjectOperation;
  refreshObjects: RefreshObjectsOperation;
}

const TOOL_SPECS: ToolSpec[] = [
    {
      name: 'bc_open_page',
      description: `Opens a Business Central page by its numeric page ID and returns its complete state as a list of sections. Each section has a sectionId, kind (header / lines / factbox / subpage / requestPage), caption, and the appropriate content shape. Card-shape sections (most headers, factboxes, requestPages) carry fields[] (and headers also carry actions[]). List-shape sections (lines, list-bodied headers, repeater subpages) carry rows[] and totalRowCount. The header section adapts to its page: it is card-shape on Card pages and list-shape on List pages -- the kind stays "header" either way for path stability. This is the entry point for all Business Central operations -- it returns a pageContextId that every other bc_ tool requires as input. Use bc_search_pages first if you do not know the page ID for an entity.

Card pages (single-record views like Customer Card=21) return one header (card-shape) plus any FactBox sections attached to the page. List pages (Customer List=22) return a header (list-shape, rows[] populated). Document pages (Sales Order=42) return a header (card-shape), a "lines" list-shape section with the document lines, and any FactBoxes.

Typical workflow: bc_open_page -> bc_read_data (refresh / filter / paginate a section) -> bc_write_data (edit fields in any section) -> bc_execute_action (post / release / delete) -> bc_close_page. Always call bc_close_page when done. Do NOT call this if the page is already open -- reuse the existing pageContextId.

Optional bookmark parameter opens a Card page to a specific record. Bookmarks come from list rows in any prior section. A bookmark only addresses the TABLE the source list is bound to: passing one from a different list (e.g. a Posted Sales Shipments row into page 132) is refused by BC and comes back as PAGE_OPEN_REJECTED with BC's own message ("cannot use a RecordID from table X with a record from table Y") — not as an empty page. When that happens, either open the page filtered ({ pageId, filters: [{ field: "No.", value: "<doc no>" }] }) or drill into the row from its own list with bc_execute_action { action: "View" | "Edit", rowIndex }.

Large pages: an un-narrowed open of a document or a long list can serialize hundreds of fields and rows and blow the response budget (the server then refuses it with RESPONSE_TOO_LARGE). Narrow it up front: summary:true returns section identity only (best first call on an unfamiliar big page), then pull what you need with sections:["header"], tab, columns and range -- or with bc_read_data section by section.

Examples:
- { "pageId": 22 } opens Customer List. Sections: [{ "sectionId": "header", "kind": "header", "rows": [...], "actions": [...] }] (no fields[] on a list-shape header).
- { "pageId": 21, "bookmark": "..." } opens Customer Card. Sections include the header card plus FactBoxes (e.g. { "sectionId": "factbox:Customer Statistics", "kind": "factbox", "fields": [...] }).`,
      inputSchema: toMcpJsonSchema(OpenPageSchema),
      zodSchema: OpenPageSchema,
      execute: (ops, input) => ops.openPage.execute(input as Parameters<typeof ops.openPage.execute>[0]),
    },
    {
      name: 'bc_read_data',
      description: `Refreshes a single section on an already-open page. Returns one Section: { sectionId, kind, caption, fields?, rows?, actions?, totalRowCount? }. Card-shape sections (header, factbox, requestPage) refresh their fields[]; list-shape sections refresh rows[]. Requires a pageContextId from a prior bc_open_page call.

Pass section: "header" (default) to refresh the page's header. Pass section: "lines" to refresh document line items. Pass a factbox sectionId (e.g. "factbox:Customer Statistics", as listed in the bc_open_page response) to refresh the FactBox card. While a modal dialog is open over the page it appears as section "dialog" — read it to see the fields BC is waiting for, then fill them with bc_write_data { section: "dialog" } and answer with bc_respond_dialog.

Filtering applies to list-shape sections only. Pass an array of { column, value }; values use BC filter syntax (exact "10000", ranges "10000..20000", wildcards "*consulting*", expressions ">1000"). Multiple filters combine with AND.

Column selection: pass columns: ["No.", "Name"] to limit the cells in each row, or the fields[] entries on a card section.

Range slicing: { offset, limit } returns rows[offset..offset+limit] for list sections. Use with totalRowCount for pagination.

Examples:
- Refresh header: { "pageContextId": "abc" }
- Filter customer list: { "pageContextId": "abc", "filters": [{ "column": "City", "value": "London" }] }
- Read sales order lines: { "pageContextId": "abc", "section": "lines" }
- Refresh a FactBox: { "pageContextId": "abc", "section": "factbox:Customer Statistics" }`,
      inputSchema: toMcpJsonSchema(ReadDataSchema),
      zodSchema: ReadDataSchema,
      execute: (ops, input) => ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]),
    },
    {
      name: 'bc_write_data',
      description: `Writes one or more field values on an already-open Business Central page. Pass a fields object with caption-name keys and string values. BC validates each field and returns the server-confirmed value, which may differ from input due to formatting, auto-completion, or lookups (e.g., entering a partial customer name resolves to the full match). Requires a pageContextId from bc_open_page.

NEVER trust "success" alone. Each entry in the results array carries requested / changed / reason: "success" only means the SaveValue interaction completed without a protocol error, NOT that the value stuck. A write that BC rejected, reverted, or refused because the field is read-only comes back success:true with changed:false and a "reason" (e.g. "not editable") — it does NOT raise an error. Branch on "changed". The top-level "allSucceeded" is true only when EVERY requested field actually changed; when it is false, read the per-field reason to find out which one and why.

When BC REFUSES a value it does not raise an error — it completes the interaction and explains itself. That explanation now comes back as reason:"validation error" plus "validationMessage" carrying BC's own words (e.g. "Sale must be equal to 'Yes' in Item: No.=0000001"). Read it: it names the business rule that blocked the write, so you can pick a valid value instead of retrying the same one. Two other reasons are NOT failures: "already set" (the field already held that value) and "unverified" (BC echoed nothing, so the effect is unknown — re-read to confirm).

Editability is tri-state: a field reported as editable:"unknown" (BC emitted no flag — common for page-variable option controls like Ship-to/Bill-to) is NOT read-only. Attempt the write and confirm via "changed".

Write related fields together in one call (e.g., quantity and unit price), but avoid writing unrelated groups together because BC validation cascades may change dependent fields in unexpected order. Check the returned confirmed values to see what BC actually stored -- they may differ from the input due to formatting, auto-completion, or lookups.

Duplicate captions: document headers repeat captions across groups (Sell-to / Bill-to / Ship-to all have "Name", "Address", "City"). Target one unambiguously by using the field's controlPath as the fields key (e.g. { "server:c[4]/c[1]/c[1]/c[0]": "2000008" }), or by passing group: "Bill-to" alongside caption-keyed fields.

A DIALOG WITH FIELDS is written to like any other section: pass section: "dialog". BC opens a modal (PageType StandardDialog) for actions that need input — a reason, a comment, a posting date — and that dialog is a DIFFERENT form from the page, so a write aimed at the page cannot see its controls no matter which key you use. Its fields, with their controlPaths, are listed under the "dialog" section of bc_read_data / bc_open_page as long as it is open. Fill them, then answer with bc_respond_dialog ("ok" to accept). If you address a dialog field without naming the section, the error tells you the section to use.

For Document page line items (Sales Order lines, Purchase Order lines), specify section: "lines" to write to the lines repeater. Use rowIndex (0-based row position) or bookmark (stable row identifier from bc_read_data results) to target a specific line. Prefer bookmark over rowIndex when rows may have been reordered or inserted since the last read. A line write is judged on the value BC echoes back for that cell; when BC echoes nothing the verdict falls back to re-reading the row and says so in "hint" (a list that is not in edit mode silently ignores line writes).

Do NOT use this for triggering actions like Post, Delete, or Release -- use bc_execute_action instead. Do NOT use this for navigating to records -- use bc_navigate instead.

Examples:
- Write to Card header: { "pageContextId": "abc", "fields": { "Name": "Contoso Ltd", "Address": "123 Main St" } }
- Write to Sales Order line: { "pageContextId": "abc", "section": "lines", "rowIndex": 0, "fields": { "Quantity": "5", "Unit Price": "100" } }
- Write with bookmark targeting: { "pageContextId": "abc", "section": "lines", "bookmark": "XXXX", "fields": { "Description": "Consulting Services" } }`,
      inputSchema: toMcpJsonSchema(WriteDataSchema),
      zodSchema: WriteDataSchema,
      execute: (ops, input) => ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]),
    },
    {
      name: 'bc_execute_action',
      description: `Executes either a named action OR a cue-tile drill-down on an open page. Pass action for header / line / system actions (Post, Delete, New, Release). Pass cue for Role Center cue tiles to open the underlying list (e.g. cue: "Sales Quotes" with section: "subpage:Activities" opens the Sales Quotes list). Requires a pageContextId from bc_open_page.

For cue drill-down, also pass section pointing at the subpage that owns the cuegroup. The returned openedPages array contains the targetPageContextId of the newly-opened list page.

Otherwise behaves identically to the existing action flow: validates the action is enabled, sends the InvokeAction RPC, applies the resulting events, and returns updatedFields / changedSections / dialogsOpened / openedPages.

Use exactly one of "action" or "cue" — passing both is an error.

If the action triggers a confirmation dialog or modal page, the response includes a dialogsOpened array with the dialog's formId and details. When requiresDialogResponse is true, you must follow up with bc_respond_dialog to confirm or cancel.

Row-scoped actions (Delete, Edit on a list row) require targeting a specific row. Use rowIndex (0-based) or bookmark to specify which row the action applies to. For Document pages, use section to disambiguate between header and line actions (e.g., "Delete" on header deletes the whole document, "Delete" on "lines" deletes one line).

For a bookmark-targeted Delete, do NOT read "success" as "the row is gone": BC can complete the action and keep the row (an uncommitted blank placeholder line, or a page not opened for editing). The repeater is re-read from the server afterwards and the verdict comes back as "deleted" (true/false) plus a "note" explaining a false. When the delete opens a confirmation dialog, "deleted" is absent on purpose — the delete is not resolved until you answer with bc_respond_dialog.

Do NOT use this for writing field values -- use bc_write_data. Do NOT use this to open records from a list -- use bc_navigate with drill_down action instead.

Examples:
- Drill into a cue tile: { "pageContextId": "rc1", "section": "subpage:Activities", "cue": "Sales Quotes" }
- Post a sales order: { "pageContextId": "so1", "action": "Post" }
- Delete a row: { "pageContextId": "list1", "action": "Delete", "bookmark": "..." }
- Create new record: { "pageContextId": "abc", "action": "New" }
- Delete a document line: { "pageContextId": "abc", "action": "Delete", "section": "lines", "rowIndex": 2 }`,
      inputSchema: toMcpJsonSchema(ExecuteActionSchema),
      zodSchema: ExecuteActionSchema,
      execute: (ops, input) => ops.executeAction.execute(input as Parameters<typeof ops.executeAction.execute>[0]),
    },
    {
      name: 'bc_close_page',
      description: `Closes an open Business Central page and frees its server-side resources including the WebSocket form session. Always call this when you are finished working with a page to prevent resource leaks on the BC server. Requires a pageContextId from bc_open_page.

IMPORTANT -- "success" does NOT always mean the page closed. If the page has unsaved changes, BC intercepts the close with a "save changes?" dialog and the page STAYS OPEN; the response is success:true but with requiresDialogResponse:true, a dialogsOpened entry, the still-valid pageContextId and a "hint". In that case the page is not closed yet: either answer the dialog with bc_respond_dialog (yes = save and close, no = discard and close) or re-call bc_close_page with discardChanges:true. Treat the close as done only when requiresDialogResponse is false/absent.

After a real close, the pageContextId becomes invalid -- any subsequent bc_read_data, bc_write_data, bc_execute_action, or bc_navigate calls using it will fail. It is safe to call this even if prior operations on the page encountered errors. If you opened a drill-down page via bc_navigate (which returns a new pageContextId), close both the drill-down page and the original list page when done.

Do NOT call this in the middle of a multi-step workflow -- finish all reads, writes, and actions on the page first. Do NOT call this to "reset" a page; use bc_read_data to refresh data instead.`,
      inputSchema: toMcpJsonSchema(ClosePageSchema),
      zodSchema: ClosePageSchema,
      execute: (ops, input) => ops.closePage.execute(input as Parameters<typeof ops.closePage.execute>[0]),
    },
    {
      name: 'bc_search_pages',
      description: `Searches BC's Tell Me index for pages, reports, codeunits, and other run-targets matching the query. Each result is { name, objectType, runTarget, departmentPath?, category?, score? } where objectType is "page" / "report" / "codeunit" / etc., runTarget is the BC AL object name (e.g. "Customer List"), and category is the BC department (e.g. "Lists", "Tasks"). Use this when you do not know the page ID for an entity — search by keyword first, then resolve.

Tell Me is PROFILE-SCOPED on the BC server. If the search returns no rows in an env where the BC web client finds matches, set the BC_PROFILE environment variable on bc-mcp's startup config to a profile that indexes the relevant objects (BUSINESS MANAGER, ACCOUNTANT, SALES ORDER PROCESSOR, etc.). The default profile may have an empty Tell Me index.

Note that BC's Tell Me identifies pages by AL name, not by numeric ID. The runTarget is therefore a string like "Customer List" rather than "22". To open the result, the caller currently still needs the numeric page ID (use bc_open_page with the known page ID, or look it up via the role center / navigation tree).

Empty-result behavior: response includes a "note" string explaining the likely cause and suggesting BC_PROFILE remediation.

Examples:
- { "query": "customer" } returns rows like { "name": "Customers", "objectType": "page", "runTarget": "Customer List", "category": "Lists", "score": 9 }.
- Empty case: { "results": [], "note": "No results. Tell Me is profile-scoped..." }.`,
      inputSchema: toMcpJsonSchema(SearchPagesSchema),
      zodSchema: SearchPagesSchema,
      execute: (ops, input) => ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]),
    },
    {
      name: 'bc_navigate',
      description: `Navigates to a specific record on an open Business Central List or Document page using its bookmark. Supports exactly TWO actions: "select" positions the cursor on a row without opening it, and "drill_down" opens the record in its Card/Document page. Requires a pageContextId from bc_open_page and a bookmark from row data returned by bc_open_page or bc_read_data.

Action "select" (default): Positions the cursor on the specified row. Use this before bc_execute_action when you need to target a specific record for an action like Delete. Does NOT open the record or return new data -- it only moves the selection.

Action "drill_down": Opens the record's detail page (e.g., drilling down from Customer List opens Customer Card, drilling down from Sales Orders opens Sales Order). Returns a NEW pageContextId for the opened Card/Document page with its full state. The original List page remains open. Remember to bc_close_page both pages when done.

Row targeting is by bookmark only; there is no field/column parameter and no "lookup" action. The drill-down always uses the row's default action (BC's own row Edit), which is what the web client does when you click the row. To reach a related entity from a field, open its page with bc_open_page instead.

Section targeting: use section (e.g., "lines") to navigate within a Document page's subpage repeater. Omit it for the page's main/header repeater.

Do NOT use this for Card pages -- it only works on pages with repeater rows. Do NOT confuse "select" with "drill_down": select just moves the cursor, drill_down opens a new page.

Examples:
- Select a row: { "pageContextId": "abc", "bookmark": "XXXX", "action": "select" }
- Drill down to Card: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down" }
- Drill down on a document line: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down", "section": "lines" }`,
      inputSchema: toMcpJsonSchema(NavigateSchema),
      zodSchema: NavigateSchema,
      execute: (ops, input) => ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]),
    },
    {
      name: 'bc_respond_dialog',
      description: `Responds to an open Business Central dialog or confirmation prompt. Dialogs are triggered by bc_execute_action or bc_write_data when BC requires user confirmation (e.g., "Do you want to post?", "Delete this record?", validation warnings). When those tools return a dialogsOpened array with requiresDialogResponse: true, you MUST call this tool to continue the workflow.

The dialogFormId comes from the dialogsOpened array in the triggering tool's response. The response parameter accepts: "ok" (confirm/accept), "cancel" (dismiss/abort), "yes" or "no" (answer a yes/no question), "abort" (force-close), or "close" (close a modal information page). Choose the response that matches the dialog's intent -- confirmation dialogs typically need "yes", acceptance dialogs need "ok".

A dialog CARRYING FIELDS must be filled in BEFORE you answer it: write its values with bc_write_data using section: "dialog" (the dialog's fields and controlPaths are listed there while it is open), then respond "ok" here. Answering a dialog with mandatory fields before filling them just makes BC complain about the empty field.

This tool only answers a dialog; it cannot press an arbitrary named button. Use one of the six responses.

After responding, check the changedSections array in the result to see which page sections were affected. For example, posting a Sales Order may change all sections. If the dialog response triggers another dialog (chained confirmations), the response will include a new dialogsOpened array -- respond to each dialog in sequence.

Do NOT call this without a preceding dialog -- there is no dialog to respond to unless dialogsOpened was returned by bc_execute_action or bc_write_data. Do NOT guess the dialogFormId -- always use the exact value from the dialogsOpened response.

Example: { "pageContextId": "abc", "dialogFormId": "dialog-123", "response": "yes" }`,
      inputSchema: toMcpJsonSchema(RespondDialogSchema),
      zodSchema: RespondDialogSchema,
      execute: (ops, input) => ops.respondDialog.execute(input as Parameters<typeof ops.respondDialog.execute>[0]),
    },
    {
      name: 'bc_switch_company',
      description: `Switch to a different company in Business Central. The SESSION IS RE-OPENED on that company -- BC binds a session to its company when it opens, so no interaction on a live session can move it. Every open page dies with the old session: their pageContextIds become unusable and you must call bc_open_page again for anything you still need in the new company.

The result reports the company BUSINESS CENTRAL granted (newCompany), read back from its own OpenSession response -- not the one you asked for. If BC does not grant it, this tool FAILS with an error instead of returning a success-shaped result; a switch that is announced but has not happened means every later read silently comes from the wrong company.

Use bc_list_companies first to get the exact company NAME (the name, not the display name). Matching ignores case and surrounding spaces.

Do NOT switch companies in the middle of a multi-step workflow (e.g., between creating a Sales Order and posting it). Complete all operations in the current company first, then switch.

Example: { "companyName": "CRONUS International Ltd." }`,
      inputSchema: toMcpJsonSchema(SwitchCompanySchema),
      zodSchema: SwitchCompanySchema,
      execute: (ops, input) => ops.switchCompany.execute(input as Parameters<typeof ops.switchCompany.execute>[0]),
    },
    {
      name: 'bc_list_companies',
      description: `List all companies available in the current Business Central environment. Returns an array of company names along with the currently active company name. Use this before bc_switch_company to verify the target company exists and to discover available companies.

This tool opens the BC Companies system page internally, reads all entries, and closes it. It does not affect your currently open pages or session state. No parameters are required.

Do NOT use this if you already know the company name -- call bc_switch_company directly. If you need to work with data in a specific company, use bc_switch_company followed by bc_open_page.`,
      inputSchema: toMcpJsonSchema(ListCompaniesSchema),
      zodSchema: ListCompaniesSchema,
      execute: (ops) => ops.listCompanies.execute(),
    },
    {
      name: 'bc_run_report',
      description: `Execute a Business Central report by its numeric report ID. If the report has a request page (parameter/filter dialog), it is returned with its fields (formId + fields) so you can INSPECT the parameters it expects. The report runs server-side on the BC service tier.

IMPORTANT: this tool cannot fill the request page. The request page is a modal dialog that is not exposed as a writable page context, so bc_write_data / bc_respond_dialog cannot set its parameters. To actually run a PARAMETERIZED report and capture its output, use bc_download_report with its "filters" map (keyed by the request-page field caption, e.g. { "No.": "2000052" }). Use bc_run_report for reports that run with their defaults or that perform server-side actions (batch posting via Report 295, inventory adjustments, data processing), and to inspect what a request page asks for. Common reports: 1306 (Customer Statement), 120 (Aged Accounts Receivable), 6 (Trial Balance), 295 (Batch Post Sales Orders).

Do NOT use this for viewing data -- use bc_open_page and bc_read_data for data retrieval. Do NOT confuse reports with pages -- reports are processing/printing objects, pages are UI views.

Example: { "reportId": 6 }`,
      inputSchema: toMcpJsonSchema(RunReportSchema),
      zodSchema: RunReportSchema,
      execute: (ops, input) => ops.runReport.execute(input as Parameters<typeof ops.runReport.execute>[0]),
    },
    {
      name: 'bc_download_report',
      description: `Renders a Business Central report and DOWNLOADS its output file (PDF / Excel / Word) to disk, returning the saved path. This is the output-capture companion to bc_run_report. Like bc_screenshot it runs OUT-OF-BAND in an authenticated headless browser (system Chrome/Edge) and does NOT touch the WebSocket session your other bc_ tools use -- BC delivers the rendered report as a normal browser download, which this tool intercepts via CDP.

Pass reportId (required). Optionally company (defaults to the session company), out (file path; absolute used as-is, relative goes under BC_REPORT_DIR; omit to auto-name), and timeoutMs (how long to wait for the download, default 60000).

Fill the request page from here: "filters" sets the FILTER fields (RequestFilterFields, e.g. { "No.": "2000052" } to print one document) and "parameters" sets the OPTIONS area -- dates, numbers, option pickers, and booleans that map to checkboxes (e.g. { "Show Amounts in LCY": true }). Both are keyed by the caption exactly as the request page displays it (locale-dependent); anything that did not match comes back in filtersApplied/parametersApplied with matched:false plus availableFilterLabels so you can retry with the exact caption.

Choose the output with "format": "pdf" | "excel" | "word" | "xml". Omit it for BC's default (PDF). If the report does not offer the requested format the download is ABORTED (downloaded:false) and availableFormats lists what its "Send to" dialog really offered -- you never receive a PDF pretending to be an Excel.

Reports that still need something this call could not supply return downloaded:false with requestPageShown:true and a "note" explaining what was missing; you can then inspect the request page over the WebSocket with bc_run_report. Always check the downloaded flag; the saved file path is in "path" when downloaded is true.

Requires Chrome or Edge installed (or BC_SCREENSHOT_CHROME set). Do NOT use this for server-side processing reports (batch posting) -- use bc_run_report. Do NOT use it for reading data -- use bc_open_page / bc_read_data.

Example: { "reportId": 6 } -> { "downloaded": true, "path": "C:/.../report-6-....pdf", "fileName": "Trial Balance.pdf" }
Example: { "reportId": 6, "format": "excel" } -> an .xlsx, or downloaded:false + availableFormats when report 6 has no Excel option.`,
      inputSchema: toMcpJsonSchema(DownloadReportSchema),
      zodSchema: DownloadReportSchema,
      execute: (ops, input) => ops.downloadReport.execute(input as Parameters<typeof ops.downloadReport.execute>[0]),
    },
    {
      name: 'bc_wizard_navigate',
      description: `Drive a Business Central NavigatePage / wizard by semantic step. Use after bc_open_page on a page whose response has isModal: true and pageType: "NavigatePage" (Continia activation wizards, BC setup wizards, request pages with multi-step layouts). The action argument is one of: "next" (advance), "back" (return to previous step), "finish" (complete the wizard), "cancel" (abort).

bc-mcp identifies the navigation buttons by the icon resource BC's own client uses (Actions/PreviousRecord, Actions/NextRecord, Actions/Approve), not by SystemAction or caption -- so localised wizards work without changes. The response surfaces fields visible on the new step, the remaining wizardNav options, and a closed flag set when the wizard finished.

Typical workflow: bc_open_page (returns isModal=true, fields for step 0) -> bc_write_data (fill step 0 inputs) -> bc_wizard_navigate { action: "next" } -> bc_write_data (fill step 1) -> ... -> bc_wizard_navigate { action: "finish" }. The wizard closes itself on finish/cancel; the pageContextId becomes invalid afterwards.

Do NOT use this for non-wizard pages -- use bc_execute_action instead. Do NOT call "next" past the last step -- use "finish" once availableNav lists it.

Example: { "pageContextId": "abc", "action": "next" }`,
      inputSchema: toMcpJsonSchema(WizardNavigateSchema),
      zodSchema: WizardNavigateSchema,
      execute: (ops, input) => ops.wizardNavigate.execute(input as Parameters<typeof ops.wizardNavigate.execute>[0]),
    },
    {
      name: 'bc_screenshot',
      description: `Captures a REAL screenshot (PNG) of the Business Central web client for a given page, optionally pointing at a specific record and drawing a highlight callout box. Use this to produce images for user manuals, documentation, bug reports, or to visually confirm what a page looks like. Unlike every other bc_ tool, this renders the actual BC web UI in a headless browser -- it does NOT return structured data. For reading or editing data use bc_open_page / bc_read_data / bc_write_data instead.

Use this for ONE image. As soon as you need several images with prose around them -- documenting a process, a how-to, training material -- call bc_build_manual instead: it drives this same capture engine once per step and assembles the whole document, including a printable A4 layout when you pass formats:["html"]. Do NOT call this repeatedly and stitch a manual together by hand.

This is additive and out-of-band: it runs an independent headless browser session and does NOT disturb the WebSocket session your other bc_ tools use. It authenticates by itself (reusing the configured BC credentials), opens a deep-link URL, waits for the BC single-page app to finish rendering, optionally annotates, then captures.

Targeting: pass pageId (required). Add bookmark to open a specific record's Card (bookmarks come from list rows returned by bc_open_page / bc_read_data). Add company to pin a company (defaults to the session's current company). For a clean manual sequence, open a list, grab the row's bookmark, then bc_screenshot the Card page id with that bookmark.

Annotation (highlight): a single caption draws one red box; a list of captions draws auto-numbered badges (1,2,3...) for ordered steps; a list of { target, label, style } objects gives full control (style: box / badge / arrow / blur). Use redact to black out sensitive fields, and crop to clip the image to one section/field area (the bounding box of the given caption(s)). All target a control by its visible caption -- ideal for "click here" manual steps.

Hidden fields (collapsed FastTabs / "Show more"): the BC web client hides fields inside collapsed FastTabs and behind per-tab "Show more" (Additional-importance) toggles. You do NOT need to do anything special -- if you highlight/crop a caption that is hidden, the tool automatically expands the needed group and clicks "Show more", scrolls it into view, and retries (reveal-when-needed). Pass expand:true to force the whole page fully expanded (every FastTab open, every "Show more" clicked) for a complete section screenshot even without highlighting. (This affects screenshots only -- bc_read_data/bc_open_page already return all fields regardless of collapse state.)

Output: the PNG is written to disk (out path, or auto-named under BC_SCREENSHOT_DIR) and, unless inline:false, also returned inline in the response so it can be viewed immediately. The response also reports the resolved url, pageTitle, which annotations were found, and whether it was cropped.

Requires Chrome or Edge installed on the machine running the server (or BC_SCREENSHOT_CHROME set to a browser path). Do NOT use this for data extraction, posting, or navigation -- only for visual capture.

Examples:
- Whole Customer Card: { "pageId": 21, "bookmark": "1B_Eg...", "company": "CRONUS" }
- One callout: { "pageId": 21, "bookmark": "1B_Eg...", "highlight": "Credit Limit (LCY)" }
- Numbered steps: { "pageId": 21, "highlight": ["Name", "Credit Limit (LCY)", "Blocked"] }
- Arrow + redaction: { "pageId": 21, "highlight": [{ "target": "Post", "style": "arrow", "label": "Post here" }], "redact": ["Name"] }
- Crop to a field area: { "pageId": 21, "bookmark": "1B_Eg...", "crop": "Credit Limit (LCY)" }
- Highlight a field hidden behind "Show more" (auto-revealed): { "pageId": 42, "bookmark": "1D_J...", "highlight": "VAT Registration No." }
- Force the whole page expanded: { "pageId": 42, "bookmark": "1D_J...", "expand": true }
- Save to a file, no inline image: { "pageId": 21, "out": "C:/manuals/customer-card.png", "inline": false }`,
      inputSchema: toMcpJsonSchema(ScreenshotSchema),
      zodSchema: ScreenshotSchema,
      execute: (ops, input) => ops.screenshot.execute(input as Parameters<typeof ops.screenshot.execute>[0]),
    },
    {
      name: 'bc_build_manual',
      description: `Builds a step-by-step USER MANUAL of Business Central and writes it as Markdown, a printable A4 web page and/or an editable Word document. You provide the ordered steps (each a heading, optional prose, and an optional screenshot spec); the tool captures the annotated screenshots and assembles the document. This is the high-level companion to bc_screenshot -- use it to produce shareable documentation, training material, or onboarding guides.

Each step is heading + optional prose + optional figure. Prose splits in two: "body" is printed ABOVE the figure (what to do), "after" BELOW it (what to notice in the image, or what comes next) -- use both, a figure with no commentary under it reads as unfinished. Each step's screenshot spec is the same shape as bc_screenshot (pageId, bookmark, company, highlight, redact, crop, expand): highlight a list of captions to get auto-numbered "click here" callouts. Fields hidden in collapsed FastTabs or behind "Show more" are revealed automatically when you highlight/crop them; pass expand:true on a step to force its page fully expanded. Alternatively a step can reference an existing PNG via image, or carry only prose (no screenshot).

Output formats (formats, defaults to ["md"]): "md" is plain Markdown with the images linked relatively -- right for repos, wikis and further editing. "html" is a self-contained printable web page laid out as real A4 sheets with a cover, an index with page numbers, running headers and page footers; it looks on screen exactly like it prints, so the reader just opens it and presses Ctrl+P to print it or save it as a paged PDF. "docx" is an editable Word document that carries the SAME page breaks as the HTML: the page is paginated in the headless browser and the measured breaks are replayed into Word, so both print identically -- plus real Word paragraph styles (restyle the whole manual from the Styles pane), a live index and live page numbers. There is no PDF output: the HTML is the print path.

Layout you do not control and should author for: EVERY step starts on a new page, so size steps like pages -- a handful of substantial steps reads far better than twenty one-line ones, each burning a sheet. A figure that does not quite fit is scaled down slightly rather than pushed to the next page. A table or a code block longer than a page is CUT across pages instead of being clipped or shoved whole onto the next one -- the table repeats its header row on each -- so neither has to be kept artificially short.

Pick by what the reader does with it. Handed to an end user to READ or PRINT -> "html". The reader must EDIT it, restyle it to their own template, or you were asked for "a Word" -> "docx". Lives in a repo or wiki -> "md". Pass several to get several. Tune with assets (HTML only: inline single file vs separate css/js/png), lang (ca/es/en chrome), cover and toc.

BUILDING FROM AN EXISTING MARKDOWN FILE. Instead of authoring steps here, pass "source": the path of a .md manual that already exists. Its images are resolved relative to that file, so you pass the .md and leave the PNGs where they are; outputs land next to it unless outDir says otherwise. Use this to turn a manual someone already wrote into the printable A4 page or the Word document without retyping it, and to rebuild it later after edits.

The accepted document format IS this tool's own "md" output -- build one and read it, that is the specification. In full:

---
lang: ca        <- optional front matter: the document's own build settings
cover: true        (lang / cover / toc / name / assets). An argument you pass
toc: true          still wins over these.
---

# Manual title              <- exactly one; the first "# " line

Intro prose, everything up to the first step.

## 1. Step heading          <- one per step. The "1. " is optional (numbering is positional)

Prose printed ABOVE the figure.

![alt](img/step-1.png)      <- at most ONE figure per step, path relative to the .md
*Figure caption*            <- optional, an italic-only line right after the image

Prose printed BELOW the figure.

## 2. Next step

### A sub-section inside a step   <- ### (or deeper) is a sub-heading, NOT a step

| Setting | Value | Why |          <- GFM table: a header row, a |---|---| delimiter
|---|---|---:|                        row (:--- / :---: / ---: sets the alignment),
| TLS | 1.2 | Legal requirement |     then the data rows

\`\`\`bash                               <- fenced code: verbatim, indentation and blank
az group create --name rg               lines preserved, nothing formatted inside.
\`\`\`                                   \`\`\` or ~~~ (use ~~~ to show backticks)

Prose accepts this Markdown subset, the same in body, after and intro: paragraphs (a blank line starts a new one; wrapped lines join), - and 1. lists, > notes, GFM tables, \`\`\` code fences, **bold**, *italic*, \`code\` and [links](https://...). A pipe inside a cell must be written \\| or put inside \`code\`. Only ## starts a step; ### and deeper are sub-sections INSIDE the current step. What the model does NOT have: a second figure in one step (it is dropped -- split the step in two) and nested lists (they flatten).

VALIDATE FIRST when the .md was not produced by this tool: pass "validate": true with "source" to parse and check WITHOUT building. You get sourceDiagnostics as "line N: severity: message" -- every problem in one pass, so you can fix the file and build in a second call. Errors (no title, no steps, a missing image) mean nothing is built; warnings (a dropped second figure, a table missing its |---|---| delimiter row, an unclosed code fence) mean it builds but that part is not what you meant. A build also returns sourceDiagnostics, so warnings are never silent.

Files are written under BC_MANUAL_DIR (or outDir), named from the title (or name). The response returns the written file paths and the captured image paths. Runs out-of-band (its own headless browser for the captures) and does not disturb the WebSocket session.

Typical use: open a list with bc_open_page, grab the record bookmark, then call bc_build_manual with a few steps that screenshot the card and highlight the fields the reader must fill in. Requires Chrome/Edge installed (same as bc_screenshot).

Example:
{
  "title": "Com crear un client",
  "intro": "Aquesta guia mostra com donar d'alta un client nou.",
  "steps": [
    { "heading": "Obre la llista de clients", "body": "Busca **Clients** i obre la llista.", "screenshot": { "pageId": 22 } },
    { "heading": "Omple els camps clau", "body": "Introdueix el nom i el limit de credit.", "screenshot": { "pageId": 21, "bookmark": "1B_Eg...", "highlight": ["Name", "Credit Limit (LCY)"] } }
  ],
  "formats": ["html"]
}`,
      inputSchema: toMcpJsonSchema(BuildManualSchema),
      zodSchema: BuildManualSchema,
      execute: (ops, input) => ops.buildManual.execute(input as Parameters<typeof ops.buildManual.execute>[0]),
    },
    {
      name: 'bc_find_object',
      description: `Resolves a Business Central object (page, report, table, codeunit, ...) by NAME or keyword to its numeric ID, using a cached index of the environment's objects (standard + add-ins + custom). Use this BEFORE bc_open_page when you do not know the page ID: search by name/caption, get the id, then open by id. Opening by numeric id is robust (ids are stable); resolving a name to an id avoids guessing.

Each result is { type, id, name, caption, app }: type is "Page" / "Report" / "TableData" / "Codeunit" / etc., id is the numeric Object ID, name is the AL object name, caption is the localized caption (in the BC user's language), app is the owning app (e.g. "Base Application", or a custom/ISV app name). Filter to pages with type: "Page".

The index is populated by bc_refresh_objects (run it first if this returns empty or stale). It is read from a cached JSON, so it is fast and does not hit BC.

Examples:
- { "query": "customer", "type": "Page" } -> the Customer-related pages with their ids.
- { "query": "Customer List", "type": "Page" } -> { id: 22, name: "Customer List", ... }.
- { "query": "9174" } -> the object with id 9174.`,
      inputSchema: toMcpJsonSchema(FindObjectSchema),
      zodSchema: FindObjectSchema,
      execute: (ops, input) => ops.findObject.execute(input as Parameters<typeof ops.findObject.execute>[0]),
    },
    {
      name: 'bc_refresh_objects',
      description: `Refreshes the cached index of Business Central objects used by bc_find_object, by reading the "All Objects with Caption" system page (9174) for a range of Object IDs and storing id + name + caption + app to a local JSON. Run this once before using bc_find_object, and again whenever objects change.

Default (no args): refreshes the CUSTOM + add-in space (Object ID >= 50000) — fast, a handful of reads. Run it whenever you (or an ISV) deploy/update an app. Pass { from, to } to refresh a specific Object ID range (e.g. one add-in's range). Pass { all: true } for the FULL range including standard Microsoft objects — this is thousands of reads and takes minutes; only needed after a BC platform/app upgrade.

Returns { scanned, totalInIndex, range, reads, updatedAt }. Requires a live BC session (it reads from BC). Do NOT call this on every lookup — the index is cached; refresh only when objects may have changed.

Examples:
- { } -> refresh all custom + add-in objects (the daily driver).
- { "from": 6175000, "to": 6175999 } -> refresh one add-in's object range.
- { "all": true } -> full rebuild including standard (slow).`,
      inputSchema: toMcpJsonSchema(RefreshObjectsSchema),
      zodSchema: RefreshObjectsSchema,
      execute: (ops, input) => ops.refreshObjects.execute(input as Parameters<typeof ops.refreshObjects.execute>[0]),
    },
];

/**
 * Tool metadata only — safe to read at process start, before any BC connection.
 * (bc_health is NOT here: it is built separately by buildHealthTool because it
 * bypasses the session gate.)
 */
export const TOOL_METADATA: readonly ToolMetadata[] = TOOL_SPECS.map(({ execute: _execute, ...meta }) => meta);

/** Bind the static specs to a live set of operations. */
export function buildToolRegistry(ops: Operations): ToolDefinition[] {
  return TOOL_SPECS.map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    zodSchema: spec.zodSchema,
    execute: (input: unknown) => spec.execute(ops, input),
  }));
}

/**
 * Same tool surface, but the operations are resolved lazily on the FIRST tools/call.
 * `resolveOperations` is expected to open (or recover) the BC session and return the
 * freshly built Operations — it is awaited per call, so a session recreated between
 * calls is picked up without rebuilding the tool list. This is what both entrypoints
 * register, so initialize/tools/list answer instantly with BC still cold.
 */
export function buildLazyToolRegistry(resolveOperations: () => Promise<Operations>): ToolDefinition[] {
  return TOOL_SPECS.map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    zodSchema: spec.zodSchema,
    execute: async (input: unknown) => spec.execute(await resolveOperations(), input),
  }));
}

/**
 * The bc_health diagnostics tool is built separately from buildToolRegistry because
 * it must NOT be wrapped by the ensureSession() gate — it reports status even when
 * BC is unreachable. Both server entrypoints append it to the tool list directly.
 */
export function buildHealthTool(deps: HealthDeps): ToolDefinition {
  const op = new HealthOperation(deps);
  return {
    name: 'bc_health',
    description: `Reports the health and diagnostics of the Business Central MCP server itself: whether it is connected to BC, the active company, how many pages/forms are open, the modal-dialog depth, and lightweight metrics (tool invocations, errors by category, session reconnects, session uptime). Use this to check "are you connected to BC?", to diagnose why other tools are failing, or to confirm which company/tenant/version you are talking to.

Unlike every other bc_ tool, this does NOT open or require a BC page/session — it answers even when BC is down (status: "disconnected"). It takes no parameters and has no side effects.

Do NOT use this for business data — it returns server/session status only.`,
    inputSchema: toMcpJsonSchema(HealthSchema),
    zodSchema: HealthSchema,
    execute: () => op.execute(),
  };
}

/**
 * bc_reset_session is built OUTSIDE buildToolRegistry for the same reason bc_health is:
 * it must not go through the ensureSession() gate. The gate calls
 * SessionManager.getSession(), which THROWS SessionLostError when the session is dead —
 * so routing the reset through it would make the tool unavailable in exactly the
 * situation it exists for. It reaches the SessionManager directly instead.
 */
export function buildResetSessionTool(resetBCSession: () => Promise<{
  previousCompany: string;
  newCompany: string;
  invalidatedPageContextIds: string[];
  previousOpenForms: number;
  previousModalDepth: number;
}>, logger: Logger): ToolDefinition {
  const op = new ResetSessionOperation(resetBCSession, logger);
  return {
    name: 'bc_reset_session',
    description: `Throw the current Business Central session away and start a CLEAN one on the same company. Use this when the session has gone bad and you want a known-good starting point: pages you can no longer close, a modal dialog BC is still holding (bc_health shows modalDepth above 0 and it will not come down), a long session with many open forms, or any failure you want to re-test without the doubt of "maybe it is the session".

This is the ONLY way to clear open forms and modal depth. bc_close_page closes ONE page, does not accept "all", and cannot lower modalDepth -- closing a page with unsaved changes makes BC put up ANOTHER modal, so cleaning up page by page can leave you worse off than you started. Open forms and the modal stack are per-SESSION state, so they only reach zero when the session is replaced. Before this tool existed the only remedy was a person restarting the MCP server process.

EVERY open page dies. All existing pageContextIds become unusable and the result lists them in invalidatedPageContextIds -- re-open with bc_open_page anything you still need. Unsaved changes in open pages are LOST, exactly as if the client had been closed; commit or post anything you care about first. The company is preserved (a reset never doubles as a company change) -- use bc_switch_company for that.

Takes no parameters. Do NOT use it as a refresh: to re-read data use bc_read_data, and to reload one page close and re-open it. This is for recovering a wedged session, not for routine work.`,
    inputSchema: toMcpJsonSchema(ResetSessionSchema),
    zodSchema: ResetSessionSchema,
    execute: (input: unknown) => op.execute(input as Parameters<typeof op.execute>[0]),
  };
}
