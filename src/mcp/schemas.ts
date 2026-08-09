import { z } from 'zod';

// MCP delivers params as strings or typed values — coerce everything.
// Note: .transform() breaks z.toJSONSchema(), so we keep a separate
// JSON-schema-safe version (StringOrNumberInput) for schema generation.
const StringOrNumber = z.union([z.string(), z.number()]).transform(v => String(v).trim());
const StringOrNumberInput = z.union([z.string(), z.number()]);

// Field / filter values: an agent naturally sends { "Quantity": 5, "Blocked": true },
// not { "Quantity": "5" }. Accept string|number|boolean and coerce to string at the
// operation boundary. Kept WITHOUT .transform() so z.toJSONSchema() can represent it
// (a value-level union is fine; only a ROOT-level combinator breaks the MCP client).
const WriteValue = z.union([z.string(), z.number(), z.boolean()]);

// Every bc_open_page field EXCEPT pageId. Shared verbatim between the runtime schema
// (which coerces pageId via .transform()) and the JSON-Schema-safe variant below, so
// the two can never drift again — a missing key there means the tool silently stops
// advertising a real parameter (it already happened once: `filters` was invisible).
const openPageFields = {
  bookmark: z.string().optional().describe('Open the page to a specific record. Bookmarks come from list row results in bc_open_page or bc_read_data.'),
  tenantId: z.string().optional().describe('BC tenant ID. Defaults to the server-configured tenant. Only needed in multi-tenant deployments.'),
  mode: z.enum(['Create', 'Edit', 'View']).optional().describe('Record mode. "Create" opens a BLANK, initialised record (BC runs OnNewRecord and the No. Series) ready to fill with bc_write_data — this is how you CREATE a record; bc_execute_action {action:"New"} only navigates. "Edit"/"View" force editability of the record the page lands on. Omit for BC\'s default.'),
  filters: z.array(z.object({
    column: z.string().describe('AL field NAME (invariant), e.g. "No.", "Name", "City" — NOT the localized caption ("Nº"/"Nombre" fail).'),
    value: z.string().describe('BC filter value: exact ("10000"), range ("10000..30000"), wildcard ("A*", "*consulting*"), expression (">1000").'),
  })).optional().describe('Server-side filters applied when the page opens (via the OpenForm query — the filter mechanism that works on BC27/BC28; the read-time filter pane does not). Multiple filters combine with AND. Use AL field names, not localized captions. The response echoes them back as activeFilters.'),
  sections: z.array(z.string()).optional().describe('Only return these sectionIds (e.g. ["header"]). Use to avoid pulling every line and factbox of a big document. Omit for all sections.'),
  summary: z.boolean().optional().describe('Return only sectionId/kind/caption (+totalRowCount) per section, with no fields/rows. Best first call on a large page (e.g. page 41 Sales Quote): discover the sections, then pull each with bc_read_data. Avoids token-limit overflows.'),
  tab: z.string().optional().describe('Filter header fields to a tab (e.g. "General", "Shipping and Billing"). Applies to the header section only.'),
  columns: z.array(z.string()).optional().describe('Keep only these fields/columns (by caption or controlPath) across all returned sections. Reduces output size.'),
  range: z.object({
    offset: z.number().describe('0-based starting row index.'),
    limit: z.number().describe('Maximum number of rows to return.'),
  }).optional().describe('Slice already-loaded repeater rows. For deep pagination use bc_read_data (which scrolls to load more).'),
};

const PAGE_ID_DESC = 'Numeric BC page ID (e.g., 22 for Customer List, 21 for Customer Card). Use bc_search_pages to find IDs.';

export const OpenPageSchema = z.object({
  pageId: StringOrNumber.describe(PAGE_ID_DESC),
  ...openPageFields,
});

export const ReadDataSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  section: z.string().optional().describe('sectionId to refresh. Defaults to "header". Examples: "lines" (document line items), "factbox:Customer Statistics" (FactBox). Listed in the bc_open_page sections array.'),
  tab: z.string().optional().describe('Tab name to filter header fields by (e.g., "General", "Invoice Details", "Shipping and Billing"). Omit to return all header fields.'),
  group: z.string().optional().describe('Restrict returned card fields to those inside the group with this caption (e.g. "Bill-to", "Ship-to"). Use to disambiguate documents whose Sell-to/Bill-to/Ship-to groups repeat captions like "Name"/"Address"/"City". Each returned field also carries its own "group" and "controlPath".'),
  filters: z.array(z.object({
    column: z.string().describe('For the main list: the AL field NAME (invariant) — "No.", "Name", "City" — NOT the localized caption. For a lines/subpage section: the column CAPTION exactly as it appears in the returned rows (that filtering happens client-side, so it matches what you can see).'),
    value: z.string().describe('Filter value. Exact ("London"), range ("10000..20000"), wildcard ("*consulting*"), comparison (">1000", "<=5", "<>x"), or a set ("10|20|30").'),
  })).optional().describe('Filters the rows. Main list: server-side, by re-opening the page with the OpenForm query (the mechanism that works on BC27/BC28), REPLACING any prior filter — echoed back as activeFilters. Lines/subpage section: filtered client-side over every materialized row, reported as rowFilter {mode:"client", scanned, matched, truncated} so you always know which mechanism ran.'),
  appendFilters: z.boolean().optional().describe('Set true to AND the filters on top of the ones already applied to this page context, instead of replacing them. Default false (replace). Main-list filters only.'),
  columns: z.array(z.string()).optional().describe('Column caption names to include in results. Omit to return all columns. Reduces output size.'),
  range: z.object({
    offset: z.number().describe('0-based starting row index.'),
    limit: z.number().describe('Maximum number of rows to return.'),
  }).optional().describe('Slice a subset of repeater rows. Returns rows[offset..offset+limit]. Use with totalRowCount for pagination.'),
});

export const WriteDataSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  fields: z.record(z.string(), WriteValue).describe('Key-value pairs to write. Values may be strings, numbers or booleans (e.g. { "Name": "Contoso", "Quantity": 5, "Blocked": true }) — they are coerced to text. Each key is a field caption OR a stable controlPath returned by bc_open_page/bc_read_data (e.g. "server:c[4]/c[1]/c[1]/c[0]"). Use the controlPath form (or the "group" param) when several controls share a caption (Sell-to/Bill-to/Ship-to).'),
  section: z.string().optional().describe('Section to write to (e.g., "lines" for document line items, "factbox:Sales Addresses" for a FactBox). Omit for header fields.'),
  group: z.string().optional().describe('Disambiguate duplicate captions: resolve every caption-keyed field inside the group with this caption (e.g. "Bill-to"). Ignored for keys given as an explicit controlPath. IMPORTANT: always check each result\'s "changed" flag — "success" only means the interaction completed, not that the value stuck.'),
  rowIndex: z.number().optional().describe('0-based row position in the repeater to write to. Use for line items. Prefer bookmark for stability.'),
  bookmark: z.string().optional().describe('Stable row identifier from bc_read_data results. Preferred over rowIndex when rows may be reordered.'),
});

// action/cue are each individually optional; the .refine() enforces "exactly one".
// IMPORTANT: keep this a FLAT object schema. Do NOT express the exclusivity as a
// JSON Schema oneOf/anyOf/allOf in toMcpJsonSchema -- Claude Code's MCP client
// drops any tool whose inputSchema uses a top-level combinator, which made
// bc_execute_action disappear entirely (verified live, BC745). The constraint
// lives in the refine (runtime) + the field descriptions (for the model).
export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  action: z.string().min(1).optional().describe('Action caption name to execute (case-insensitive). Provide EXACTLY ONE of action or cue -- never both, never neither, and do NOT send a placeholder for the unused one (omit it). Must match a visible, enabled action from bc_open_page response.'),
  cue: z.string().min(1).optional().describe('Cue tile name to drill down on (e.g. "Sales Quotes", "Pending Approvals"). Use with section pointing at the subpage that owns the cuegroup. Provide EXACTLY ONE of action or cue -- never both, never neither, and do NOT send a placeholder for the unused one (omit it).'),
  section: z.string().optional().describe('Section context. Required when using cue; optional for action. Examples: "lines", "subpage:Activities".'),
  rowIndex: z.number().optional().describe('0-based row position for row-scoped actions.'),
  bookmark: z.string().optional().describe('Stable row identifier for row-scoped actions.'),
  quiet: z.boolean().optional().describe('Suppress the full updatedFields dump. Document actions ("Editar"/"New") otherwise return 100+ header fields. With quiet, only success/changedSections/openedPages/dialog come back; read the fields you need afterwards with bc_read_data.'),
}).refine(d => !!d.action !== !!d.cue, {
  message: 'Provide exactly one of action or cue (you passed both or neither). Pass ONLY one and omit the other -- do not send a placeholder.',
});

export const ClosePageSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page. Becomes invalid after closing.'),
  discardChanges: z.boolean().optional().describe('If the page has unsaved changes, BC shows a "save changes?" dialog on close. Set true to auto-discard (answer No) and complete the close. Omit to have the dialog surfaced (requiresDialogResponse:true) so you can answer it with bc_respond_dialog.'),
});

export const SearchPagesSchema = z.object({
  query: z.string().min(1).describe('Search term matching BC page names and keywords (e.g., "customer", "sales order", "chart of accounts"). Fuzzy matching supported.'),
});

export const NavigateSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID of the List or Document page containing the row to navigate to.'),
  bookmark: z.string().min(1).describe('Row bookmark from bc_open_page or bc_read_data results identifying which record to navigate to.'),
  action: z.enum(['drill_down', 'select']).optional().describe('"select" moves the cursor to the row (default). "drill_down" opens the record detail page (returns a new pageContextId).'),
  section: z.string().optional().describe('Section containing the row (e.g., "lines" for document line items). Omit for header/default repeater.'),
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

// Shared between the runtime schema and the JSON-Schema-safe variant (see toMcpJsonSchema).
const downloadReportFields = {
  company: z.string().optional().describe('Company to run in. Defaults to the session company.'),
  out: z.string().optional().describe('Output file path. Absolute is used as-is; a relative name goes under BC_REPORT_DIR. Omit to auto-name report-<id>-<timestamp>.<ext>.'),
  timeoutMs: z.number().optional().describe('How long to wait for the download to complete after the report runs (ms, default 60000).'),
  format: z.enum(['pdf', 'excel', 'word', 'xml']).optional().describe('Output format. Omit for BC\'s default (PDF). The format is chosen in the "Send to…" dialog; if this report does not offer it, NOTHING is downloaded and the result comes back downloaded:false with availableFormats listing what it does offer — you never get a PDF silently relabelled.'),
  filters: z.record(z.string(), WriteValue).optional().describe('Request-page FILTER fields (RequestFilterFields), keyed by the caption shown on the report request page (e.g. { "No.": "2000052" }). Needed to print ONE specific document. Pass the caption exactly as the request page displays it (locale-dependent, e.g. "Nº"); if it does not match, the result\'s availableFilterLabels lists the fields found so you can retry with the exact caption.'),
  parameters: z.record(z.string(), WriteValue).optional().describe('Request-page OPTIONS-area parameters: dates ("Starting Date": "01/01/2026"), booleans that map to checkboxes ("Show Amounts in LCY": true), option/dropdown values, numbers. Same caption matching as filters. Use this for reports that need parameters rather than filters (e.g. statements 116/1316) — a boolean toggles the checkbox only when its state differs.'),
};

export const DownloadReportSchema = z.object({
  reportId: StringOrNumber.describe('Numeric BC report ID to render and download (e.g., 6 Trial Balance, 1306 Customer Statement).'),
  ...downloadReportFields,
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
  clickBeforeCapture: z.array(z.string()).optional().describe('Captions of controls to CLICK before capturing, in order (e.g. ["Lines"] to open a document line grid, or a tab name). Use when a section only reveals its content on an explicit toggle and you want to name it instead of relying on expand. Matched by visible text or aria-label, exact then prefix.'),
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
  clickBeforeCapture: z.array(z.string()).optional().describe('Captions of controls to CLICK before capturing, in order (e.g. ["Lines"] to open a document line grid, or a tab name). Use when a section only reveals its content on an explicit toggle and you want to name it instead of relying on expand. Matched by visible text or aria-label, exact then prefix.'),
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
  formats: z.array(z.enum(['md', 'html'])).optional().describe('Output formats. "md" = plain Markdown (default). "html" = a printable A4 web page: paged on screen, Ctrl+P prints/saves it as a paged PDF. Pass both to get both.'),
  outDir: z.string().optional().describe('Output directory (absolute, or relative to BC_MANUAL_DIR). Defaults to BC_MANUAL_DIR.'),
  name: z.string().optional().describe('Base file name (slugified). Defaults to the title.'),
  assets: z.enum(['inline', 'files']).optional().describe('HTML only. "inline" (default): one self-contained .html with CSS, JS and images embedded -- portable, mail it as-is. "files": .html + .css + .js + linked PNGs -- easier to restyle by hand.'),
  lang: z.string().optional().describe('HTML only. Language of the generated chrome (cover kicker, index title, print button): ca (default), es or en. The step text itself is whatever you write.'),
  cover: z.boolean().optional().describe('HTML only. Emit a cover sheet with the title, intro and date. Default true.'),
  toc: z.boolean().optional().describe('HTML only. Emit an index sheet with the real page number of each step. Default: only when the manual has 4 or more steps.'),
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
      pageId: StringOrNumberInput.describe(PAGE_ID_DESC),
      ...openPageFields,
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
      ...downloadReportFields,
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  // NOTE: ExecuteActionSchema's action/cue exclusivity is intentionally NOT
  // emitted as JSON Schema oneOf/anyOf here -- a top-level combinator makes
  // Claude Code's MCP client drop the whole tool (verified live, BC745). The
  // refine enforces it at runtime; the field descriptions guide the model.
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
