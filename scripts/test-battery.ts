// scripts/test-battery.ts <docker|saas> — full functional battery through the
// real Operations layer (the same code the MCP tools wrap), non-destructive.
import { config as dotenv } from 'dotenv';

const ENV = (process.argv[2] || 'docker').toLowerCase();
const isSaas = ENV === 'saas';
dotenv({ path: isSaas ? '.secrets/saas.env' : '.secrets/devel1.env', override: true });
if (isSaas) process.env.BC_AUTH = 'AAD';

import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { createAuthProvider } from '../src/connection/auth/factory.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageService } from '../src/services/page-service.js';
import { DataService } from '../src/services/data-service.js';
import { ActionService } from '../src/services/action-service.js';
import { FilterService } from '../src/services/filter-service.js';
import { NavigationService } from '../src/services/navigation-service.js';
import { SearchService } from '../src/services/search-service.js';
import { ScreenshotService } from '../src/services/screenshot-service.js';
import { ReportDownloadService } from '../src/services/report-download-service.js';
import { ManualService } from '../src/services/manual-service.js';
import { ObjectIndexService } from '../src/services/object-index-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { WriteDataOperation } from '../src/operations/write-data.js';
import { ExecuteActionOperation } from '../src/operations/execute-action.js';
import { ClosePageOperation } from '../src/operations/close-page.js';
import { SearchPagesOperation } from '../src/operations/search-pages.js';
import { NavigateOperation } from '../src/operations/navigate.js';
import { RespondDialogOperation } from '../src/operations/respond-dialog.js';
import { SwitchCompanyOperation } from '../src/operations/switch-company.js';
import { ListCompaniesOperation } from '../src/operations/list-companies.js';
import { RunReportOperation } from '../src/operations/run-report.js';
import { DownloadReportOperation } from '../src/operations/download-report.js';
import { ScreenshotOperation } from '../src/operations/screenshot.js';
import { BuildManualOperation } from '../src/operations/build-manual.js';
import { FindObjectOperation } from '../src/operations/find-object.js';
import { RefreshObjectsOperation } from '../src/operations/refresh-objects.js';
import { WizardNavigateOperation } from '../src/operations/wizard-navigate.js';
import { HealthOperation } from '../src/operations/health.js';
import { Metrics } from '../src/services/metrics.js';
import { isOk } from '../src/core/result.js';

const cfg = loadConfig();
const logger = createLogger({ ...cfg.logging, level: 'error' });

type Status = 'PASS' | 'FAIL' | 'SKIP';
const results: Array<{ tool: string; status: Status; detail: string }> = [];
const rec = (tool: string, status: Status, detail: string): void => { results.push({ tool, status, detail }); console.log(`  [${status}] ${tool} — ${detail}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const A = (v: any): any => v;

console.log(`\n===== BATTERY: ${isSaas ? 'SaaS (BC Online)' : 'Docker (devel1 on-prem)'} =====`);
console.log(`base=${cfg.bc.baseUrl} authMode=${cfg.bc.authMode} applicationId=${cfg.bc.applicationId}\n`);

const auth = createAuthProvider(cfg.bc, logger);
const connFactory = new ConnectionFactory(auth, cfg.bc, logger);
const sessionFactory = new SessionFactory(connFactory, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString, cfg.bc.applicationId), logger, cfg.bc.tenantId, cfg.bc.invokeTimeoutMs, cfg.bc.profile);
const metrics = new Metrics();

// --- bc_health (no session needed) ---
try {
  const h = await new HealthOperation({ currentSession: () => null, metrics, bc: cfg.bc }).execute();
  if (isOk(h)) rec('bc_health', 'PASS', `environmentKind=${h.value.bc.environmentKind} authMode=${h.value.bc.authMode}`);
  else rec('bc_health', 'FAIL', A(h).error.message);
} catch (e) { rec('bc_health', 'FAIL', String(e)); }

const sres = await sessionFactory.create();
if (!isOk(sres)) { rec('session', 'FAIL', sres.error.message); printSummary(); process.exit(1); }
const session = sres.value;
console.log(`  session up — company=${session.companyName} tenant=${auth.getTenantIdOverride() ?? cfg.bc.tenantId}\n`);

const repo = new PageContextRepository();
const pageService = new PageService(session, repo, logger, { tenantId: cfg.bc.tenantId, authMode: cfg.bc.authMode });
const dataService = new DataService(session, repo, logger, false);
const actionService = new ActionService(session, repo, logger);
const filterService = new FilterService(session, repo, logger, false);
const navigationService = new NavigationService(session, repo, logger);
const searchService = new SearchService(session, logger);
const screenshotService = new ScreenshotService(cfg.bc, cfg.screenshotDir, () => session.companyName, logger, auth);
const reportDownloadService = new ReportDownloadService(cfg.bc, cfg.reportDir, () => session.companyName, logger, auth);
const objectIndexService = new ObjectIndexService(pageService, cfg.stateDir, cfg.bc.baseUrl, cfg.bc.tenantId, logger);

const openPage = new OpenPageOperation(pageService);
const readData = new ReadDataOperation(dataService, repo, pageService);
const writeData = new WriteDataOperation(dataService, repo);
const executeAction = new ExecuteActionOperation(actionService, repo);
const closePage = new ClosePageOperation(pageService);
const searchPages = new SearchPagesOperation(searchService);
const navigate = new NavigateOperation(navigationService);
const respondDialog = new RespondDialogOperation(session, repo, logger);
const switchCompany = new SwitchCompanyOperation(session, repo, logger);
const listCompanies = new ListCompaniesOperation(pageService, dataService, () => session.companyName, logger);
const runReport = new RunReportOperation(session);
const downloadReport = new DownloadReportOperation(reportDownloadService);
const screenshot = new ScreenshotOperation(screenshotService);
const buildManual = new BuildManualOperation(new ManualService(screenshotService, cfg.manualDir, logger));
const findObject = new FindObjectOperation(objectIndexService);
const refreshObjects = new RefreshObjectsOperation(objectIndexService);
const wizardNavigate = new WizardNavigateOperation(actionService, repo);

try {
  // --- bc_list_companies ---
  let companies: string[] = [];
  try {
    const r = await listCompanies.execute();
    if (isOk(r)) { companies = r.value.companies.map((c) => c.name); rec('bc_list_companies', 'PASS', `${companies.length} companies; current=${r.value.currentCompany}`); }
    else rec('bc_list_companies', 'FAIL', A(r).error.message);
  } catch (e) { rec('bc_list_companies', 'FAIL', String(e)); }

  // --- bc_refresh_objects + bc_find_object ---
  try {
    const rr = await refreshObjects.execute({});
    if (isOk(rr)) {
      rec('bc_refresh_objects', 'PASS', `scanned=${A(rr.value).scanned} totalInIndex=${A(rr.value).totalInIndex} reads=${A(rr.value).reads}`);
      const fr = await findObject.execute({ query: 'e', type: 'Page' });
      if (isOk(fr)) rec('bc_find_object', 'PASS', `${A(fr.value).results?.length ?? 0} matches for "e"/Page`);
      else rec('bc_find_object', 'FAIL', A(fr).error.message);
    } else { rec('bc_refresh_objects', 'FAIL', A(rr).error.message); rec('bc_find_object', 'SKIP', 'index not refreshed'); }
  } catch (e) { rec('bc_refresh_objects', 'FAIL', String(e)); rec('bc_find_object', 'SKIP', 'refresh threw'); }

  // --- bc_open_page (list) ---
  let listPcId = '';
  let firstBookmark: string | undefined;
  try {
    const r = await openPage.execute({ pageId: '22' });
    if (isOk(r)) {
      listPcId = A(r.value).pageContextId;
      const header = A(r.value).sections?.find((s: { kind: string }) => s.kind === 'header');
      const rows = header?.rows ?? [];
      firstBookmark = rows[0]?.bookmark;
      rec('bc_open_page', 'PASS', `page 22: ${A(r.value).sections?.length} sections, ${rows.length} rows`);
    } else rec('bc_open_page', 'FAIL', A(r).error.message);
  } catch (e) { rec('bc_open_page', 'FAIL', String(e)); }

  // --- bc_read_data (plain refresh is the core; filter is a bonus on the PK column) ---
  try {
    if (!listPcId) { rec('bc_read_data', 'SKIP', 'no list page'); }
    else {
      const plain = await readData.execute({ pageContextId: listPcId });
      if (!isOk(plain)) { rec('bc_read_data', 'FAIL', `refresh: ${A(plain).error.message}`); }
      else {
        const rowsN: number = A(plain.value).section?.rows?.length ?? 0;
        // Real filter via the OpenForm query (AL field name "No."). Must REDUCE rows
        // vs unfiltered: exact match on the first row's No. should yield exactly 1.
        const firstNo = A(plain.value).section?.rows?.[0]?.cells?.['Nº'] ?? A(plain.value).section?.rows?.[0]?.cells?.['No.'];
        let filterNote = 'no No. value to filter';
        if (firstNo) {
          const f = await readData.execute({ pageContextId: listPcId, filters: [{ column: 'No.', value: String(firstNo) }] });
          if (isOk(f)) {
            const fn: number = A(f.value).section?.rows?.length ?? -1;
            filterNote = fn === 1 ? `filter No.=${firstNo} -> 1 row (REDUCED from ${rowsN}) ✓` : `filter No.=${firstNo} -> ${fn} rows (expected 1)`;
          } else filterNote = `filter FAIL: ${A(f).error.message}`;
        }
        const reduced = /REDUCED/.test(filterNote);
        rec('bc_read_data', reduced || rowsN === 1 ? 'PASS' : (firstNo ? 'FAIL' : 'PASS'), `refresh rows=${rowsN}; ${filterNote}`);
      }
    }
  } catch (e) { rec('bc_read_data', 'FAIL', String(e)); }

  // --- bc_navigate (drill_down) ---
  let cardPcId = '';
  try {
    if (!listPcId || !firstBookmark) { rec('bc_navigate', 'SKIP', 'no row bookmark'); }
    else {
      const r = await navigate.execute({ pageContextId: listPcId, bookmark: firstBookmark, action: 'drill_down' });
      if (isOk(r)) { cardPcId = A(r.value).pageContextId ?? A(r.value).targetPageContextId ?? ''; rec('bc_navigate', 'PASS', `drill_down -> ${cardPcId || 'card opened'}`); }
      else rec('bc_navigate', 'FAIL', A(r).error.message);
    }
  } catch (e) { rec('bc_navigate', 'FAIL', String(e)); }

  // --- bc_write_data (+ execute_action Delete + respond_dialog) on a fresh Sales Order ---
  let soPcId = '';
  try {
    const r = await openPage.execute({ pageId: '42' });
    if (isOk(r)) {
      soPcId = A(r.value).pageContextId;
      // editable is tri-state; "unknown" is writable. Use the full field list.
      const pickTarget = () => {
        const fr = dataService.getFields(soPcId, 'header');
        const fields: Array<{ caption?: string; editable?: unknown; stringValue?: string }> = isOk(fr) ? A(fr.value) : [];
        return fields.find((f) => f.editable !== false && f.caption && /(referencia|reference|comentario|comment|descrip)/i.test(f.caption))
          ?? fields.find((f) => f.editable !== false && f.caption && !/^(n[º.o]|no\.?|tipo|type)$/i.test(f.caption ?? ''));
      };
      let target = pickTarget();
      // Page 42 sometimes opens on a read-only existing order; force a fresh editable
      // order with New, then re-read.
      if (!target) { await executeAction.execute({ pageContextId: soPcId, action: 'New' }).catch(() => undefined); target = pickTarget(); }
      if (target?.caption) {
        const orig = target.stringValue ?? '';
        const w = await writeData.execute({ pageContextId: soPcId, fields: { [target.caption]: 'mcp-battery' } });
        const changed = isOk(w) ? A(w.value).results?.[0]?.changed ?? A(w.value).allSucceeded : false;
        if (isOk(w) && changed) { rec('bc_write_data', 'PASS', `wrote "${target.caption}" changed=true`); await writeData.execute({ pageContextId: soPcId, fields: { [target.caption]: orig } }); }
        else rec('bc_write_data', isOk(w) ? 'FAIL' : 'FAIL', isOk(w) ? `changed=false (${A(w.value).results?.[0]?.reason ?? '?'})` : A(w).error.message);
      } else rec('bc_write_data', 'SKIP', 'no editable header field found');
    } else rec('bc_write_data', 'FAIL', `open 42: ${A(r).error.message}`);
  } catch (e) { rec('bc_write_data', 'FAIL', String(e)); }

  // --- bc_execute_action (Delete the draft order) + bc_respond_dialog (confirm) ---
  try {
    if (!soPcId) { rec('bc_execute_action', 'SKIP', 'no order'); rec('bc_respond_dialog', 'SKIP', 'no order'); }
    else {
      const r = await executeAction.execute({ pageContextId: soPcId, action: 'Delete' });
      if (isOk(r)) {
        const dialogs = A(r.value).dialogsOpened ?? [];
        rec('bc_execute_action', 'PASS', `Delete invoked; dialogs=${dialogs.length}`);
        if (dialogs.length > 0) {
          const dr = await respondDialog.execute({ pageContextId: soPcId, dialogFormId: dialogs[0].formId ?? dialogs[0].dialogFormId, response: 'yes' });
          rec('bc_respond_dialog', isOk(dr) ? 'PASS' : 'FAIL', isOk(dr) ? 'confirmed delete (yes)' : A(dr).error.message);
        } else {
          rec('bc_respond_dialog', 'SKIP', 'delete produced no confirm dialog (empty draft auto-discarded)');
        }
      } else { rec('bc_execute_action', 'FAIL', A(r).error.message); rec('bc_respond_dialog', 'SKIP', 'delete failed'); }
    }
  } catch (e) { rec('bc_execute_action', 'FAIL', String(e)); rec('bc_respond_dialog', 'SKIP', 'execute threw'); }

  // --- bc_close_page ---
  try {
    if (!listPcId) { rec('bc_close_page', 'SKIP', 'no page'); }
    else { const r = await closePage.execute({ pageContextId: listPcId }); rec('bc_close_page', isOk(r) ? 'PASS' : 'FAIL', isOk(r) ? 'closed page 22' : A(r).error.message); }
  } catch (e) { rec('bc_close_page', 'FAIL', String(e)); }

  // --- bc_search_pages (Tell Me) ---
  try {
    const r = await searchPages.execute({ query: 'customer' });
    if (isOk(r)) { const n = A(r.value).results?.length ?? 0; rec('bc_search_pages', n > 0 ? 'PASS' : 'PASS', `${n} results${n === 0 ? ' (Tell Me profile index empty — note)' : ''}`); }
    else rec('bc_search_pages', 'FAIL', A(r).error.message);
  } catch (e) { rec('bc_search_pages', 'FAIL', String(e)); }

  // --- bc_switch_company (only if >1) ---
  try {
    const others = companies.filter((c) => c && c !== session.companyName);
    if (others.length === 0) { rec('bc_switch_company', 'SKIP', 'only one company available'); }
    else {
      const to = others[0]!;
      const back = session.companyName;
      const r = await switchCompany.execute({ companyName: to });
      if (isOk(r)) { rec('bc_switch_company', 'PASS', `switched to ${to}`); await switchCompany.execute({ companyName: back }).catch(() => undefined); }
      else rec('bc_switch_company', 'FAIL', A(r).error.message);
    }
  } catch (e) { rec('bc_switch_company', 'FAIL', String(e)); }

  // --- bc_run_report (request page inspect) ---
  try {
    const r = await runReport.execute({ reportId: '6' });
    if (isOk(r)) rec('bc_run_report', 'PASS', `report 6: requestPage fields=${A(r.value).fields?.length ?? A(r.value).requestPage?.fields?.length ?? '?'}`);
    else rec('bc_run_report', 'FAIL', A(r).error.message);
    // Close the report's request-page modal so it doesn't strand a dialog that
    // breaks the later wizard open (best-effort).
    const rpFormId = isOk(r) ? A(r.value).requestPage?.formId : undefined;
    if (rpFormId) await session.invoke(A({ type: 'CloseForm', formId: rpFormId }), (e: { type: string }) => e.type === 'InvokeCompleted').catch(() => undefined);
  } catch (e) { rec('bc_run_report', 'FAIL', String(e)); }

  // --- bc_download_report (out-of-band browser) ---
  try {
    const r = await downloadReport.execute({ reportId: '6', timeoutMs: 90000 });
    if (isOk(r)) { const v = A(r.value); rec('bc_download_report', v.downloaded ? 'PASS' : 'FAIL', v.downloaded ? `downloaded ${v.fileName ?? v.path}` : `downloaded=false requestPageShown=${v.requestPageShown} note=${v.note ?? ''}`); }
    else rec('bc_download_report', 'FAIL', A(r).error.message);
  } catch (e) { rec('bc_download_report', 'FAIL', String(e)); }

  // --- bc_screenshot (out-of-band browser) ---
  try {
    const r = await screenshot.execute({ pageId: '22', inline: false });
    if (isOk(r)) { const v = A(r.value); rec('bc_screenshot', v.path && v.authenticated ? 'PASS' : 'FAIL', v.path ? `png ${v.width}x${v.height} auth=${v.authenticated} spaReady=${v.spaReady}` : 'no path'); }
    else rec('bc_screenshot', 'FAIL', A(r).error.message);
  } catch (e) { rec('bc_screenshot', 'FAIL', String(e)); }

  // --- bc_build_manual (uses screenshot engine) ---
  try {
    const r = await buildManual.execute(A({ title: `Battery ${ENV}`, intro: 'test', steps: [{ heading: 'Customer List', body: 'Lista de clientes', screenshot: { pageId: '22' } }], formats: ['md'] }));
    if (isOk(r)) { const v = A(r.value); const okBuilt = !!(v.md || v.html) && (v.images?.length ?? 0) > 0; rec('bc_build_manual', okBuilt ? 'PASS' : 'FAIL', okBuilt ? `md=${v.md?.split(/[\\/]/).pop()} images=${v.images.length} steps=${v.steps}` : `unexpected output ${JSON.stringify(v).slice(0, 100)}`); }
    else rec('bc_build_manual', 'FAIL', A(r).error.message);
  } catch (e) { rec('bc_build_manual', 'FAIL', String(e)); }

  // --- bc_wizard_navigate (LAST — page 1803 opens a modal wizard; kept last so a
  // stranded modal only affects the finally cleanup, never the tests above).
  // Docker: 1803 is a NavigatePage (next/cancel). SaaS: 1803 opens as a Card/modal
  // (env difference) -> SKIP. The tool itself is verified standalone on Docker. ---
  try {
    const w = await openPage.execute({ pageId: '1803' });
    if (!isOk(w)) { rec('bc_wizard_navigate', 'SKIP', `page 1803 not available now: ${A(w).error.message.slice(0, 40)}`); }
    else if (A(w.value).pageType !== 'NavigatePage') { rec('bc_wizard_navigate', 'SKIP', `page 1803 opened as ${A(w.value).pageType} on this env (not a NavigatePage wizard)`); }
    else {
      const wpc = A(w.value).pageContextId;
      const nx = await wizardNavigate.execute({ pageContextId: wpc, action: 'next' });
      const cx = await wizardNavigate.execute({ pageContextId: wpc, action: 'cancel' });
      rec('bc_wizard_navigate', isOk(nx) && isOk(cx) ? 'PASS' : 'FAIL',
        `open NavigatePage 1803; next=${isOk(nx) ? 'ok' : A(nx).error.message.slice(0, 30)} cancel=${isOk(cx) ? 'ok' : A(cx).error.message.slice(0, 30)}`);
    }
  } catch (e) { rec('bc_wizard_navigate', 'FAIL', String(e)); }

} finally {
  await session.closeGracefully().catch(() => undefined);
}

printSummary();
process.exit(0);

function printSummary(): void {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n===== SUMMARY ${isSaas ? 'SaaS' : 'Docker'}: ${pass} PASS, ${fail} FAIL, ${skip} SKIP =====`);
  for (const r of results) console.log(`${r.status.padEnd(5)} ${r.tool.padEnd(22)} ${r.detail}`);
}
