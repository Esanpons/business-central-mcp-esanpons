import { z } from 'zod';
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
  WizardNavigateSchema,
  toMcpJsonSchema,
} from './schemas.js';
import type { OpenPageOperation } from '../operations/open-page.js';
import type { ReadDataOperation } from '../operations/read-data.js';
import type { WriteDataOperation } from '../operations/write-data.js';
import type { ExecuteActionOperation } from '../operations/execute-action.js';
import type { ClosePageOperation } from '../operations/close-page.js';
import type { SearchPagesOperation } from '../operations/search-pages.js';
import type { NavigateOperation } from '../operations/navigate.js';
import type { RespondDialogOperation } from '../operations/respond-dialog.js';
import type { SwitchCompanyOperation } from '../operations/switch-company.js';
import type { ListCompaniesOperation } from '../operations/list-companies.js';
import type { RunReportOperation } from '../operations/run-report.js';
import type { WizardNavigateOperation } from '../operations/wizard-navigate.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  zodSchema: z.ZodType;
  execute: (input: unknown) => Promise<unknown>;
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
  wizardNavigate: WizardNavigateOperation;
}

export function buildToolRegistry(ops: Operations): ToolDefinition[] {
  return [
    {
      name: 'bc_open_page',
      description: `Opens a Business Central page by its numeric page ID and returns its complete state as a list of sections. Each section has a sectionId, kind (header / lines / factbox / subpage / requestPage), caption, and the appropriate content shape. Card-shape sections (most headers, factboxes, requestPages) carry fields[] (and headers also carry actions[]). List-shape sections (lines, list-bodied headers, repeater subpages) carry rows[] and totalRowCount. The header section adapts to its page: it is card-shape on Card pages and list-shape on List pages -- the kind stays "header" either way for path stability. This is the entry point for all Business Central operations -- it returns a pageContextId that every other bc_ tool requires as input. Use bc_search_pages first if you do not know the page ID for an entity.

Card pages (single-record views like Customer Card=21) return one header (card-shape) plus any FactBox sections attached to the page. List pages (Customer List=22) return a header (list-shape, rows[] populated). Document pages (Sales Order=42) return a header (card-shape), a "lines" list-shape section with the document lines, and any FactBoxes.

Typical workflow: bc_open_page -> bc_read_data (refresh / filter / paginate a section) -> bc_write_data (edit fields in any section) -> bc_execute_action (post / release / delete) -> bc_close_page. Always call bc_close_page when done. Do NOT call this if the page is already open -- reuse the existing pageContextId.

Optional bookmark parameter opens a Card page to a specific record. Bookmarks come from list rows in any prior section.

Examples:
- { "pageId": 22 } opens Customer List. Sections: [{ "sectionId": "header", "kind": "header", "rows": [...], "actions": [...] }] (no fields[] on a list-shape header).
- { "pageId": 21, "bookmark": "..." } opens Customer Card. Sections include the header card plus FactBoxes (e.g. { "sectionId": "factbox:Customer Statistics", "kind": "factbox", "fields": [...] }).`,
      inputSchema: toMcpJsonSchema(OpenPageSchema),
      zodSchema: OpenPageSchema,
      execute: (input) => ops.openPage.execute(input as Parameters<typeof ops.openPage.execute>[0]),
    },
    {
      name: 'bc_read_data',
      description: `Refreshes a single section on an already-open page. Returns one Section: { sectionId, kind, caption, fields?, rows?, actions?, totalRowCount? }. Card-shape sections (header, factbox, requestPage) refresh their fields[]; list-shape sections refresh rows[]. Requires a pageContextId from a prior bc_open_page call.

Pass section: "header" (default) to refresh the page's header. Pass section: "lines" to refresh document line items. Pass a factbox sectionId (e.g. "factbox:Customer Statistics", as listed in the bc_open_page response) to refresh the FactBox card.

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
      execute: (input) => ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]),
    },
    {
      name: 'bc_write_data',
      description: `Writes one or more field values on an already-open Business Central page. Pass a fields object with caption-name keys and string values. BC validates each field and returns the server-confirmed value, which may differ from input due to formatting, auto-completion, or lookups (e.g., entering a partial customer name resolves to the full match). Requires a pageContextId from bc_open_page.

Fields must be editable -- writing to a read-only field returns an error. Write related fields together in one call (e.g., quantity and unit price), but avoid writing unrelated groups together because BC validation cascades may change dependent fields in unexpected order. Check the returned confirmed values to see what BC actually stored.

For Document page line items (Sales Order lines, Purchase Order lines), specify section: "lines" to write to the lines repeater. Use rowIndex (0-based row position) or bookmark (stable row identifier from bc_read_data results) to target a specific line. Prefer bookmark over rowIndex when rows may have been reordered or inserted since the last read.

Do NOT use this for triggering actions like Post, Delete, or Release -- use bc_execute_action instead. Do NOT use this for navigating to records -- use bc_navigate instead.

Examples:
- Write to Card header: { "pageContextId": "abc", "fields": { "Name": "Contoso Ltd", "Address": "123 Main St" } }
- Write to Sales Order line: { "pageContextId": "abc", "section": "lines", "rowIndex": 0, "fields": { "Quantity": "5", "Unit Price": "100" } }
- Write with bookmark targeting: { "pageContextId": "abc", "section": "lines", "bookmark": "XXXX", "fields": { "Description": "Consulting Services" } }`,
      inputSchema: toMcpJsonSchema(WriteDataSchema),
      zodSchema: WriteDataSchema,
      execute: (input) => ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]),
    },
    {
      name: 'bc_execute_action',
      description: `Executes a named action on an already-open Business Central page. Actions include standard operations (New, Delete, Refresh, Edit, Post, Release) and page-specific actions visible in the bc_open_page response under each section's actions array. Requires a pageContextId from bc_open_page. The action name is matched case-insensitively against the action caption.

If the action triggers a confirmation dialog or modal page, the response includes a dialogsOpened array with the dialog's formId and details. When requiresDialogResponse is true, you must follow up with bc_respond_dialog to confirm or cancel. Always check the response for dialogs before proceeding.

Row-scoped actions (Delete, Edit on a list row) require targeting a specific row. Use rowIndex (0-based) or bookmark to specify which row the action applies to. For Document pages, use section to disambiguate between header and line actions (e.g., "Delete" on header deletes the whole document, "Delete" on "lines" deletes one line).

Do NOT use this for writing field values -- use bc_write_data. Do NOT use this to open records from a list -- use bc_navigate with drill_down action instead.

Examples:
- Create new record: { "pageContextId": "abc", "action": "New" }
- Delete a specific row: { "pageContextId": "abc", "action": "Delete", "bookmark": "XXXX" }
- Post a Sales Order: { "pageContextId": "abc", "action": "Post" }
- Delete a document line: { "pageContextId": "abc", "action": "Delete", "section": "lines", "rowIndex": 2 }`,
      inputSchema: toMcpJsonSchema(ExecuteActionSchema),
      zodSchema: ExecuteActionSchema,
      execute: (input) => ops.executeAction.execute(input as Parameters<typeof ops.executeAction.execute>[0]),
    },
    {
      name: 'bc_close_page',
      description: `Closes an open Business Central page and frees its server-side resources including the WebSocket form session. Always call this when you are finished working with a page to prevent resource leaks on the BC server. Requires a pageContextId from bc_open_page.

After closing, the pageContextId becomes invalid -- any subsequent bc_read_data, bc_write_data, bc_execute_action, or bc_navigate calls using it will fail. It is safe to call this even if prior operations on the page encountered errors. If you opened a drill-down page via bc_navigate (which returns a new pageContextId), close both the drill-down page and the original list page when done.

Do NOT call this in the middle of a multi-step workflow -- finish all reads, writes, and actions on the page first. Do NOT call this to "reset" a page; use bc_read_data to refresh data instead.`,
      inputSchema: toMcpJsonSchema(ClosePageSchema),
      zodSchema: ClosePageSchema,
      execute: (input) => ops.closePage.execute(input as Parameters<typeof ops.closePage.execute>[0]),
    },
    {
      name: 'bc_search_pages',
      description: `Searches for Business Central pages by name using the built-in Tell Me search feature. Returns matching page names, types, and IDs that can be passed to bc_open_page. Use this when you know what business entity you need to work with (e.g., "customer", "sales order", "item", "vendor", "general ledger") but do not know the numeric page ID.

This is the only bc_ tool that does NOT require a pageContextId -- it works independently as a discovery step before bc_open_page. The search query matches against page captions and keywords using fuzzy matching, so partial names work (e.g., "cust" finds Customer List, Customer Card, etc.).

Do NOT use this if you already know the page ID -- call bc_open_page directly. Do NOT use this to search for data within a page -- use bc_read_data with filters instead.

Common pages for reference: Customer List (22), Customer Card (21), Item List (31), Item Card (30), Sales Order (42), Sales Orders (9305), Vendor Card (26), Vendor List (27), Chart of Accounts (16), General Ledger Entries (20), Purchase Order (50).

Example: { "query": "sales order" }`,
      inputSchema: toMcpJsonSchema(SearchPagesSchema),
      zodSchema: SearchPagesSchema,
      execute: (input) => ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]),
    },
    {
      name: 'bc_navigate',
      description: `Navigates to a specific record on an open Business Central List or Document page using its bookmark. Supports three actions: "select" positions the cursor on a row without opening it, "drill_down" opens the record in its Card/Document page, and "lookup" triggers the lookup action on a specific field. Requires a pageContextId from bc_open_page and a bookmark from row data returned by bc_open_page or bc_read_data.

Action "select" (default): Positions the cursor on the specified row. Use this before bc_execute_action when you need to target a specific record for an action like Delete. Does NOT open the record or return new data -- it only moves the selection.

Action "drill_down": Opens the record's detail page (e.g., drilling down from Customer List opens Customer Card, drilling down from Sales Orders opens Sales Order). Returns a NEW pageContextId for the opened Card/Document page with its full state. The original List page remains open. Remember to bc_close_page both pages when done.

Action "lookup": Triggers a lookup on a specific field (specified via the field parameter) to open the related entity's list for selection.

Section and field targeting: Use section (e.g., "lines") to navigate within a Document page's subpage repeater. Use field to specify which column to drill down or look up from (e.g., field: "No." to drill down on the item number column).

Do NOT use this for Card pages -- it only works on pages with repeater rows. Do NOT confuse "select" with "drill_down": select just moves the cursor, drill_down opens a new page.

Examples:
- Select a row: { "pageContextId": "abc", "bookmark": "XXXX", "action": "select" }
- Drill down to Card: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down" }
- Drill down on a line item field: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down", "section": "lines", "field": "No." }`,
      inputSchema: toMcpJsonSchema(NavigateSchema),
      zodSchema: NavigateSchema,
      execute: (input) => ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]),
    },
    {
      name: 'bc_respond_dialog',
      description: `Responds to an open Business Central dialog or confirmation prompt. Dialogs are triggered by bc_execute_action or bc_write_data when BC requires user confirmation (e.g., "Do you want to post?", "Delete this record?", validation warnings). When those tools return a dialogsOpened array with requiresDialogResponse: true, you MUST call this tool to continue the workflow.

The dialogFormId comes from the dialogsOpened array in the triggering tool's response. The response parameter accepts: "ok" (confirm/accept), "cancel" (dismiss/abort), "yes" or "no" (answer a yes/no question), "abort" (force-close), or "close" (close a modal information page). Choose the response that matches the dialog's intent -- confirmation dialogs typically need "yes", acceptance dialogs need "ok".

After responding, check the changedSections array in the result to see which page sections were affected. For example, posting a Sales Order may change all sections. If the dialog response triggers another dialog (chained confirmations), the response will include a new dialogsOpened array -- respond to each dialog in sequence.

Do NOT call this without a preceding dialog -- there is no dialog to respond to unless dialogsOpened was returned by bc_execute_action or bc_write_data. Do NOT guess the dialogFormId -- always use the exact value from the dialogsOpened response.

Example: { "pageContextId": "abc", "dialogFormId": "dialog-123", "response": "yes" }`,
      inputSchema: toMcpJsonSchema(RespondDialogSchema),
      zodSchema: RespondDialogSchema,
      execute: (input) => ops.respondDialog.execute(input as Parameters<typeof ops.respondDialog.execute>[0]),
    },
    {
      name: 'bc_switch_company',
      description: `Switch to a different company within the current Business Central session. All currently open pages will be invalidated and their pageContextIds will become unusable -- you must call bc_open_page to re-open any pages you need in the new company context.

Use bc_list_companies first to see the available company names and verify the target company exists. The companyName must be an exact match. After switching, all subsequent bc_open_page, bc_read_data, bc_write_data, and bc_execute_action calls will operate against the new company's data.

Do NOT switch companies in the middle of a multi-step workflow (e.g., between creating a Sales Order and posting it). Complete all operations in the current company first, then switch.

Example: { "companyName": "CRONUS International Ltd." }`,
      inputSchema: toMcpJsonSchema(SwitchCompanySchema),
      zodSchema: SwitchCompanySchema,
      execute: (input) => ops.switchCompany.execute(input as Parameters<typeof ops.switchCompany.execute>[0]),
    },
    {
      name: 'bc_list_companies',
      description: `List all companies available in the current Business Central environment. Returns an array of company names along with the currently active company name. Use this before bc_switch_company to verify the target company exists and to discover available companies.

This tool opens the BC Companies system page internally, reads all entries, and closes it. It does not affect your currently open pages or session state. No parameters are required.

Do NOT use this if you already know the company name -- call bc_switch_company directly. If you need to work with data in a specific company, use bc_switch_company followed by bc_open_page.`,
      inputSchema: toMcpJsonSchema(ListCompaniesSchema),
      zodSchema: ListCompaniesSchema,
      execute: () => ops.listCompanies.execute(),
    },
    {
      name: 'bc_run_report',
      description: `Execute a Business Central report by its numeric report ID. If the report has a request page (parameter/filter dialog), it will be returned with its fields so you can fill in parameters using bc_write_data and then execute the report by responding with bc_respond_dialog (response: "ok"). The report runs server-side on the BC service tier.

Output capture (downloading the rendered PDF, Excel, or Word document) is not yet supported. Use this tool for reports that perform server-side actions (batch posting via Report 295, inventory adjustments, data processing) or to inspect and fill request page parameters. Common reports: 1306 (Customer Statement), 120 (Aged Accounts Receivable), 6 (Trial Balance), 295 (Batch Post Sales Orders).

Do NOT use this for viewing data -- use bc_open_page and bc_read_data for data retrieval. Do NOT confuse reports with pages -- reports are processing/printing objects, pages are UI views.

Example: { "reportId": 6 }`,
      inputSchema: toMcpJsonSchema(RunReportSchema),
      zodSchema: RunReportSchema,
      execute: (input) => ops.runReport.execute(input as Parameters<typeof ops.runReport.execute>[0]),
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
      execute: (input) => ops.wizardNavigate.execute(input as Parameters<typeof ops.wizardNavigate.execute>[0]),
    },
  ];
}
