import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { PageService } from '../services/page-service.js';
import { DataService } from '../services/data-service.js';
import { ActionService } from '../services/action-service.js';
import { NavigationService } from '../services/navigation-service.js';
import { SearchService } from '../services/search-service.js';
import { ScreenshotService } from '../services/screenshot-service.js';
import { ReportDownloadService } from '../services/report-download-service.js';
import { ManualService } from '../services/manual-service.js';
import { ObjectIndexService } from '../services/object-index-service.js';
import { OpenPageOperation } from '../operations/open-page.js';
import { ReadDataOperation } from '../operations/read-data.js';
import { WriteDataOperation } from '../operations/write-data.js';
import { ExecuteActionOperation } from '../operations/execute-action.js';
import { ClosePageOperation } from '../operations/close-page.js';
import { SearchPagesOperation } from '../operations/search-pages.js';
import { NavigateOperation } from '../operations/navigate.js';
import { RespondDialogOperation } from '../operations/respond-dialog.js';
import { SwitchCompanyOperation } from '../operations/switch-company.js';
import { ListCompaniesOperation } from '../operations/list-companies.js';
import { RunReportOperation } from '../operations/run-report.js';
import { DownloadReportOperation } from '../operations/download-report.js';
import { WizardNavigateOperation } from '../operations/wizard-navigate.js';
import { ScreenshotOperation } from '../operations/screenshot.js';
import { BuildManualOperation } from '../operations/build-manual.js';
import { FindObjectOperation } from '../operations/find-object.js';
import { RefreshObjectsOperation } from '../operations/refresh-objects.js';
import type { Operations } from './tool-registry.js';
import type { Metrics } from '../services/metrics.js';

/**
 * Everything the service graph needs besides the session itself. Stable across
 * session recreations — only the BCSession is rebuilt.
 */
export interface OperationsDeps {
  config: AppConfig;
  logger: Logger;
  authProvider: IBCAuthProvider;
  pageContextRepo: PageContextRepository;
  /**
   * Called with the company a bc_switch_company asked for, so the session manager can
   * re-apply it after a reconnect (otherwise a recreated session silently returns to
   * the server-default company).
   */
  onCompanySelected: (companyName: string) => void;
  /**
   * Perform a company switch at SESSION level (tear down, re-open on that company,
   * confirm from BC's OpenSession response). It lives on the SessionManager because
   * BC binds a session to its company at OpenSession — no interaction on a live
   * session moves it — so a switch necessarily replaces the session the whole
   * service graph is built on.
   */
  switchSessionCompany: (companyName: string) => Promise<{
    previousCompany: string;
    newCompany: string;
    invalidatedPageContextIds: string[];
  }>;
  /**
   * The same Metrics instance bc_health reports from. The browser-driven services
   * (screenshots, report downloads, manuals) are the slowest and flakiest things this
   * server does, and without this they stay invisible in bc_health: the counters exist
   * on the services but nothing was passing the collector in.
   */
  metrics?: Metrics;
}

/**
 * Build the whole service + operation graph for one BC session.
 *
 * This lived DUPLICATED, ~60 lines verbatim, in server.ts and stdio-server.ts; the
 * only difference between the copies was that the HTTP server also built the REST
 * route map from the result. Adding an operation meant editing both, and they had
 * already started to drift. It is one function now: wire a new operation here and
 * both entrypoints get it.
 */
export function buildOperations(session: BCSession, deps: OperationsDeps): Operations {
  const { config, logger, authProvider, pageContextRepo, onCompanySelected, switchSessionCompany, metrics } = deps;

  const pageService = new PageService(session, pageContextRepo, logger, { tenantId: config.bc.tenantId, authMode: config.bc.authMode });
  const dataService = new DataService(session, pageContextRepo, logger, config.logging.redactValues);
  const actionService = new ActionService(session, pageContextRepo, logger);
  const navigationService = new NavigationService(session, pageContextRepo, logger);
  const searchService = new SearchService(session, logger);
  const screenshotService = new ScreenshotService(config.bc, config.screenshotDir, () => session.companyName, logger, authProvider, metrics);
  const reportDownloadService = new ReportDownloadService(config.bc, config.reportDir, () => session.companyName, logger, authProvider, metrics);
  const objectIndexService = new ObjectIndexService(pageService, config.stateDir, config.bc.baseUrl, config.bc.tenantId, logger);

  return {
    openPage: new OpenPageOperation(pageService),
    readData: new ReadDataOperation(dataService, pageContextRepo, pageService),
    writeData: new WriteDataOperation(dataService, pageContextRepo),
    executeAction: new ExecuteActionOperation(actionService, pageContextRepo),
    closePage: new ClosePageOperation(pageService),
    searchPages: new SearchPagesOperation(searchService),
    navigate: new NavigateOperation(navigationService),
    respondDialog: new RespondDialogOperation(session, pageContextRepo, logger),
    switchCompany: new SwitchCompanyOperation(switchSessionCompany, logger, onCompanySelected),
    listCompanies: new ListCompaniesOperation(pageService, dataService, () => session.companyName, logger),
    runReport: new RunReportOperation(session),
    downloadReport: new DownloadReportOperation(reportDownloadService),
    wizardNavigate: new WizardNavigateOperation(actionService, pageContextRepo),
    screenshot: new ScreenshotOperation(screenshotService),
    buildManual: new BuildManualOperation(new ManualService(screenshotService, config.manualDir, logger, metrics)),
    findObject: new FindObjectOperation(objectIndexService),
    refreshObjects: new RefreshObjectsOperation(objectIndexService),
  };
}
