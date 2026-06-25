import { z } from 'zod';

// MCP delivers params as strings or typed values — coerce everything.
// Note: .transform() breaks z.toJSONSchema(), so we keep a separate
// JSON-schema-safe version (StringOrNumberInput) for schema generation.
const StringOrNumber = z.union([z.string(), z.number()]).transform(v => String(v).trim());
const StringOrNumberInput = z.union([z.string(), z.number()]);

export const OpenPageSchema = z.object({
  pageId: StringOrNumber.describe('Numeric BC page ID (e.g., 22 for Customer List, 21 for Customer Card). Use bc_search_pages to find IDs.'),
  bookmark: z.string().optional().describe('Open the page to a specific record. Bookmarks come from list row results in bc_open_page or bc_read_data.'),
  tenantId: z.string().optional().describe('BC tenant ID. Defaults to the server-configured tenant. Only needed in multi-tenant deployments.'),
  sections: z.array(z.string()).optional().describe('Only return these sectionIds (e.g. ["header"]). Use to avoid pulling every line and factbox of a big document. Omit for all sections.'),
  summary: z.boolean().optional().describe('Return only sectionId/kind/caption (+totalRowCount) per section, with no fields/rows. Best first call on a large page (e.g. page 41 Sales Quote): discover the sections, then pull each with bc_read_data. Avoids token-limit overflows.'),
  tab: z.string().optional().describe('Filter header fields to a tab (e.g. "General", "Shipping and Billing"). Applies to the header section only.'),
  columns: z.array(z.string()).optional().describe('Keep only these fields/columns (by caption or controlPath) across all returned sections. Reduces output size.'),
  range: z.object({
    offset: z.number().describe('0-based starting row index.'),
    limit: z.number().describe('Maximum number of rows to return.'),
  }).optional().describe('Slice already-loaded repeater rows. For deep pagination use bc_read_data (which scrolls to load more).'),
});

export const ReadDataSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  section: z.string().optional().describe('sectionId to refresh. Defaults to "header". Examples: "lines" (document line items), "factbox:Customer Statistics" (FactBox). Listed in the bc_open_page sections array.'),
  tab: z.string().optional().describe('Tab name to filter header fields by (e.g., "General", "Invoice Details", "Shipping and Billing"). Omit to return all header fields.'),
  group: z.string().optional().describe('Restrict returned card fields to those inside the group with this caption (e.g. "Bill-to", "Ship-to"). Use to disambiguate documents whose Sell-to/Bill-to/Ship-to groups repeat captions like "Name"/"Address"/"City". Each returned field also carries its own "group" and "controlPath".'),
  filters: z.array(z.object({
    column: z.string().describe('Column caption name to filter on (e.g., "City", "No.").'),
    value: z.string().describe('Filter value. Supports exact match ("London"), ranges ("10000..20000"), wildcards ("*consulting*"), expressions (">1000").'),
  })).optional().describe('Server-side filters to apply before reading. Multiple filters combine with AND logic.'),
  columns: z.array(z.string()).optional().describe('Column caption names to include in results. Omit to return all columns. Reduces output size.'),
  range: z.object({
    offset: z.number().describe('0-based starting row index.'),
    limit: z.number().describe('Maximum number of rows to return.'),
  }).optional().describe('Slice a subset of repeater rows. Returns rows[offset..offset+limit]. Use with totalRowCount for pagination.'),
});

export const WriteDataSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  fields: z.record(z.string(), z.string()).describe('Key-value pairs to write. Each key is a field caption (e.g., { "Name": "Contoso", "City": "London" }) OR a stable controlPath returned by bc_open_page/bc_read_data (e.g. "server:c[4]/c[1]/c[1]/c[0]"). Use the controlPath form (or the "group" param) when several controls share a caption (Sell-to/Bill-to/Ship-to).'),
  section: z.string().optional().describe('Section to write to (e.g., "lines" for document line items, "factbox:Sales Addresses" for a FactBox). Omit for header fields.'),
  group: z.string().optional().describe('Disambiguate duplicate captions: resolve every caption-keyed field inside the group with this caption (e.g. "Bill-to"). Ignored for keys given as an explicit controlPath. IMPORTANT: always check each result\'s "changed" flag — "success" only means the interaction completed, not that the value stuck.'),
  rowIndex: z.number().optional().describe('0-based row position in the repeater to write to. Use for line items. Prefer bookmark for stability.'),
  bookmark: z.string().optional().describe('Stable row identifier from bc_read_data results. Preferred over rowIndex when rows may be reordered.'),
});

export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  action: z.string().min(1).optional().describe('Action caption name to execute (case-insensitive). Use action OR cue, not both. Must match a visible, enabled action from bc_open_page response.'),
  cue: z.string().min(1).optional().describe('Cue tile name to drill down on (e.g. "Sales Quotes", "Pending Approvals"). Use with section pointing at the subpage that owns the cuegroup. Use action OR cue, not both.'),
  section: z.string().optional().describe('Section context. Required when using cue; optional for action. Examples: "lines", "subpage:Activities".'),
  rowIndex: z.number().optional().describe('0-based row position for row-scoped actions.'),
  bookmark: z.string().optional().describe('Stable row identifier for row-scoped actions.'),
  quiet: z.boolean().optional().describe('Suppress the full updatedFields dump. Document actions ("Editar"/"New") otherwise return 100+ header fields. With quiet, only success/changedSections/openedPages/dialog come back; read the fields you need afterwards with bc_read_data.'),
}).refine(d => !!d.action !== !!d.cue, { message: 'Provide exactly one of: action, cue' });

export const ClosePageSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page. Becomes invalid after closing.'),
});

export const SearchPagesSchema = z.object({
  query: z.string().min(1).describe('Search term matching BC page names and keywords (e.g., "customer", "sales order", "chart of accounts"). Fuzzy matching supported.'),
});

export const NavigateSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID of the List or Document page containing the row to navigate to.'),
  bookmark: z.string().min(1).describe('Row bookmark from bc_open_page or bc_read_data results identifying which record to navigate to.'),
  action: z.enum(['drill_down', 'select', 'lookup']).optional().describe('"select" moves cursor to row (default). "drill_down" opens the record detail page (returns new pageContextId). "lookup" triggers field lookup.'),
  section: z.string().optional().describe('Section containing the row (e.g., "lines" for document line items). Omit for header/default repeater.'),
  field: z.string().optional().describe('Column caption to drill down or look up from (e.g., "No." to drill down on item number). Omit to use the default drill-down column.'),
});

export const RespondDialogSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID of the page that triggered the dialog.'),
  dialogFormId: z.string().min(1).describe('Dialog form ID from the dialogsOpened array returned by bc_execute_action or bc_write_data.'),
  response: z.enum(['ok', 'cancel', 'yes', 'no', 'abort', 'close']).describe('"ok" confirms, "cancel" dismisses, "yes"/"no" answers a question, "abort" force-closes, "close" closes a modal info page.'),
});

export const SwitchCompanySchema = z.object({
  companyName: z.string().min(1).describe('Exact company name to switch to. Use bc_list_companies to see available company names.'),
});

export const RunReportSchema = z.object({
  reportId: StringOrNumber.describe('Numeric BC report ID to execute (e.g., 1306 for Customer Statement, 6 for Trial Balance).'),
});

export const DownloadReportSchema = z.object({
  reportId: StringOrNumber.describe('Numeric BC report ID to render and download (e.g., 6 Trial Balance, 1306 Customer Statement).'),
  company: z.string().optional().describe('Company to run in. Defaults to the session company.'),
  out: z.string().optional().describe('Output file path. Absolute is used as-is; a relative name goes under BC_REPORT_DIR. Omit to auto-name report-<id>-<timestamp>.<ext>.'),
  timeoutMs: z.number().optional().describe('How long to wait for the download to complete after the report runs (ms, default 60000).'),
});

export const ListCompaniesSchema = z.object({});

export const HealthSchema = z.object({});

export const FindObjectSchema = z.object({
  query: z.string().min(1).describe('Name/caption keyword or numeric ID to look up (e.g. "Customer List", "client", "22"). Matches Object Name and the localized Object Caption.'),
  type: z.string().optional().describe('Filter by object type: "Page", "Report", "Table"/"TableData", "Codeunit", "Query", "XMLport", etc. Omit for any type. Use "Page" to find a page id to open with bc_open_page.'),
  limit: z.number().optional().describe('Max results to return (default 25).'),
});

export const RefreshObjectsSchema = z.object({
  from: z.number().optional().describe('Start of the Object ID range to refresh (default 50000, i.e. custom + add-ins).'),
  to: z.number().optional().describe('End of the Object ID range to refresh (default a very high value covering PTE 50000-99999 and high ISV/Microsoft ranges).'),
  all: z.boolean().optional().describe('Refresh the FULL range including standard Microsoft objects (thousands of reads — slow, minutes). Use after a BC upgrade. Omit for the fast custom/add-in refresh.'),
});

const AnnotationSchema = z.object({
  target: z.string().describe('Caption / aria-label of the control to annotate (exact visible text).'),
  label: z.string().optional().describe('Text or number shown on the callout (e.g. "1").'),
  style: z.enum(['box', 'arrow', 'badge', 'blur']).optional().describe('"box" (red border, default), "badge" (numbered circle + box), "arrow" (pointer + label), "blur" (redact).'),
});

const HighlightSchema = z.union([z.string(), z.array(z.string()), z.array(AnnotationSchema)]);

export const ScreenshotSchema = z.object({
  pageId: StringOrNumberInput.describe('Numeric BC page ID to screenshot (e.g., 21 for Customer Card, 22 for Customer List). Use bc_search_pages to find IDs.'),
  bookmark: z.string().optional().describe('Open a specific record before capturing. Bookmarks come from list row results in bc_open_page / bc_read_data. Omit for list/role-center pages.'),
  company: z.string().optional().describe('Company to capture in. Defaults to the session\'s current company. Pin it explicitly for consistent manuals across runs.'),
  highlight: HighlightSchema.optional().describe('Draw callout(s) on the page. A single caption -> one red box. A list of captions -> auto-numbered badges (1,2,3...) for ordered manual steps. A list of {target,label,style} objects -> full control. Ideal for "click here" manual steps.'),
  redact: z.array(z.string()).optional().describe('Captions to black out for privacy (each drawn as an opaque box).'),
  crop: z.union([z.string(), z.array(z.string())]).optional().describe('Caption(s) to crop the screenshot to. The image is clipped to the bounding box enclosing the located caption(s) plus padding — use to capture just one section/FactBox/field area.'),
  expand: z.boolean().optional().describe('Reveal hidden content before capturing: expand every collapsed FastTab/group and click every "Show more" toggle so additional fields appear. Default false. Even when false, a reveal pass runs automatically if a requested highlight/crop caption turns out to be hidden behind a collapsed group or "Show more" (reveal-when-needed). Set true to force the fully-expanded view for a whole-section screenshot.'),
  out: z.string().optional().describe('Output file path. Absolute path is used as-is; a relative name is placed under BC_SCREENSHOT_DIR. Omit to auto-name as page-<id>-<timestamp>.png.'),
  width: z.number().optional().describe('Viewport width in pixels (default 1600).'),
  height: z.number().optional().describe('Viewport height in pixels (default 1000).'),
  scale: z.number().optional().describe('Device scale factor for crispness (default 2 = retina-sharp). Use 1 for smaller files.'),
  fullPage: z.boolean().optional().describe('Capture the full scrollable page instead of just the viewport (default false). Ignored when crop is set.'),
  inline: z.boolean().optional().describe('Also return the PNG inline in the response so the assistant can see it (default true). Set false to only write the file.'),
});

const ManualScreenshotSchema = z.object({
  pageId: StringOrNumberInput.describe('BC page ID to capture for this step.'),
  bookmark: z.string().optional().describe('Record bookmark (from bc_open_page / bc_read_data rows).'),
  company: z.string().optional().describe('Company to capture in (defaults to the session company).'),
  highlight: HighlightSchema.optional().describe('Callout(s): a caption, a list of captions (auto-numbered), or {target,label,style} objects.'),
  redact: z.array(z.string()).optional().describe('Captions to black out for privacy.'),
  crop: z.union([z.string(), z.array(z.string())]).optional().describe('Caption(s) to crop the image to.'),
  expand: z.boolean().optional().describe('Expand all collapsed FastTabs/groups and click every "Show more" before capturing, so additional fields are visible. Default false (a reveal pass still runs automatically when a highlight/crop caption is hidden).'),
  width: z.number().optional(),
  height: z.number().optional(),
  scale: z.number().optional(),
});

const ManualStepSchema = z.object({
  heading: z.string().describe('Step heading / title (e.g. "Open the Customer Card").'),
  body: z.string().optional().describe('Prose explaining the step.'),
  screenshot: ManualScreenshotSchema.optional().describe('Capture a fresh annotated screenshot for this step.'),
  image: z.string().optional().describe('Or reference an existing PNG (absolute path, or relative to the manual dir).'),
});

export const BuildManualSchema = z.object({
  title: z.string().describe('Manual title (also used to name the output files unless name is given).'),
  intro: z.string().optional().describe('Optional introduction paragraph.'),
  steps: z.array(ManualStepSchema).min(1).describe('Ordered steps. Each may capture a screenshot and/or carry prose.'),
  formats: z.array(z.enum(['md', 'pdf', 'docx'])).optional().describe('Which formats to generate. Defaults to all three (md, pdf, docx).'),
  outDir: z.string().optional().describe('Output directory (absolute, or relative to BC_MANUAL_DIR). Defaults to BC_MANUAL_DIR.'),
  name: z.string().optional().describe('Base file name (slugified). Defaults to the title.'),
});

export const WizardNavigateSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page for a NavigatePage / wizard.'),
  action: z.enum(['back', 'next', 'finish', 'cancel']).describe('Wizard step navigation. "next" advances, "back" returns to previous step, "finish" completes the wizard, "cancel" aborts.'),
});

/**
 * Generate MCP-compatible JSON schema from a Zod schema.
 * Handles the OpenPageSchema specially since it uses .transform() which
 * z.toJSONSchema() cannot represent. All other schemas pass through directly.
 */
export function toMcpJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // OpenPageSchema uses StringOrNumber with .transform() — use the safe variant
  if (schema === OpenPageSchema) {
    const safe = z.object({
      pageId: StringOrNumberInput.describe('Numeric BC page ID (e.g., 22 for Customer List, 21 for Customer Card). Use bc_search_pages to find IDs.'),
      bookmark: z.string().optional().describe('Open the page to a specific record. Bookmarks come from list row results in bc_open_page or bc_read_data.'),
      tenantId: z.string().optional().describe('BC tenant ID. Defaults to the server-configured tenant. Only needed in multi-tenant deployments.'),
      sections: z.array(z.string()).optional().describe('Only return these sectionIds (e.g. ["header"]). Use to avoid pulling every line and factbox of a big document. Omit for all sections.'),
      summary: z.boolean().optional().describe('Return only sectionId/kind/caption (+totalRowCount) per section, with no fields/rows. Best first call on a large page (e.g. page 41 Sales Quote): discover the sections, then pull each with bc_read_data. Avoids token-limit overflows.'),
      tab: z.string().optional().describe('Filter header fields to a tab (e.g. "General", "Shipping and Billing"). Applies to the header section only.'),
      columns: z.array(z.string()).optional().describe('Keep only these fields/columns (by caption or controlPath) across all returned sections. Reduces output size.'),
      range: z.object({
        offset: z.number().describe('0-based starting row index.'),
        limit: z.number().describe('Maximum number of rows to return.'),
      }).optional().describe('Slice already-loaded repeater rows. For deep pagination use bc_read_data (which scrolls to load more).'),
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  // RunReportSchema uses StringOrNumber with .transform() — use the safe variant
  if (schema === RunReportSchema) {
    const safe = z.object({
      reportId: StringOrNumberInput.describe('Numeric BC report ID to execute (e.g., 1306 for Customer Statement, 6 for Trial Balance).'),
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  // DownloadReportSchema uses StringOrNumber with .transform() — use the safe variant
  if (schema === DownloadReportSchema) {
    const safe = z.object({
      reportId: StringOrNumberInput.describe('Numeric BC report ID to render and download (e.g., 6 Trial Balance, 1306 Customer Statement).'),
      company: z.string().optional().describe('Company to run in. Defaults to the session company.'),
      out: z.string().optional().describe('Output file path. Absolute is used as-is; a relative name goes under BC_REPORT_DIR. Omit to auto-name report-<id>-<timestamp>.<ext>.'),
      timeoutMs: z.number().optional().describe('How long to wait for the download to complete after the report runs (ms, default 60000).'),
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
