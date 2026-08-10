// scripts/lib/harness.ts — one bootstrap for every live script/check, on EITHER
// environment. Scripts pick the target with `docker` | `saas` as argv[2]; the rest
// of the graph is identical, which is the whole point: a feature that works here
// works through the MCP tools too, because these are the same Operations the tools
// wrap.
//
// Order matters: loadEnvFile() must run BEFORE createHarness(), because loadConfig()
// reads process.env. (ESM hoists imports, not calls — so this holds.)
import { config as dotenv } from 'dotenv';

export type EnvName = 'docker' | 'saas';

/** Resolve argv[2] (or an explicit value) to an environment name. Defaults to docker. */
export function parseEnvName(value: string | undefined): EnvName {
  const v = (value || 'docker').toLowerCase();
  if (v !== 'docker' && v !== 'saas') {
    throw new Error(`Unknown environment "${value}". Use "docker" (devel1 on-prem) or "saas" (BC Online).`);
  }
  return v;
}

/** Load .secrets/<env>.env and force the matching auth mode. */
export function loadEnvFile(env: EnvName): void {
  dotenv({ path: env === 'saas' ? '.secrets/saas.env' : '.secrets/devel1.env', override: true });
  if (env === 'saas') process.env.BC_AUTH = 'AAD';
}

import { loadConfig, type AppConfig } from '../../src/core/config.js';
import { createLogger, type Logger } from '../../src/core/logger.js';
import { createAuthProvider } from '../../src/connection/auth/factory.js';
import type { AuthProvider } from '../../src/connection/auth/auth-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { FilterService } from '../../src/services/filter-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { SearchService } from '../../src/services/search-service.js';
import { ScreenshotService } from '../../src/services/screenshot-service.js';
import { ReportDownloadService } from '../../src/services/report-download-service.js';
import { ManualService } from '../../src/services/manual-service.js';
import { ObjectIndexService } from '../../src/services/object-index-service.js';
import { Metrics } from '../../src/services/metrics.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { ClosePageOperation } from '../../src/operations/close-page.js';
import { SearchPagesOperation } from '../../src/operations/search-pages.js';
import { NavigateOperation } from '../../src/operations/navigate.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { SwitchCompanyOperation } from '../../src/operations/switch-company.js';
import { ListCompaniesOperation } from '../../src/operations/list-companies.js';
import { RunReportOperation } from '../../src/operations/run-report.js';
import { DownloadReportOperation } from '../../src/operations/download-report.js';
import { ScreenshotOperation } from '../../src/operations/screenshot.js';
import { BuildManualOperation } from '../../src/operations/build-manual.js';
import { FindObjectOperation } from '../../src/operations/find-object.js';
import { RefreshObjectsOperation } from '../../src/operations/refresh-objects.js';
import { WizardNavigateOperation } from '../../src/operations/wizard-navigate.js';
import { HealthOperation } from '../../src/operations/health.js';
import { isOk } from '../../src/core/result.js';

export interface Harness {
  env: EnvName;
  cfg: AppConfig;
  logger: Logger;
  auth: AuthProvider;
  session: BCSession;
  metrics: Metrics;
  repo: PageContextRepository;
  services: {
    page: PageService;
    data: DataService;
    action: ActionService;
    filter: FilterService;
    navigation: NavigationService;
    search: SearchService;
    screenshot: ScreenshotService;
    reportDownload: ReportDownloadService;
    manual: ManualService;
    objectIndex: ObjectIndexService;
  };
  ops: {
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
    screenshot: ScreenshotOperation;
    buildManual: BuildManualOperation;
    findObject: FindObjectOperation;
    refreshObjects: RefreshObjectsOperation;
    wizardNavigate: WizardNavigateOperation;
    health: HealthOperation;
  };
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  /** Log level for the run (default 'error' — scripts print their own progress). */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Build the full service+operation graph against a live session. Throws with the
 * BC error message if the session can't be opened (for SaaS that usually means the
 * AAD profile needs `npm run login:aad`).
 */
export async function createHarness(env: EnvName, options: HarnessOptions = {}): Promise<Harness> {
  const cfg = loadConfig();
  const logger = createLogger({ ...cfg.logging, level: options.logLevel ?? 'error' });

  const auth = createAuthProvider(cfg.bc, logger);
  const connFactory = new ConnectionFactory(auth, cfg.bc, logger);
  const sessionFactory = new SessionFactory(
    connFactory,
    new EventDecoder(),
    new InteractionEncoder(cfg.bc.clientVersionString, cfg.bc.applicationId),
    logger,
    cfg.bc.tenantId,
    cfg.bc.invokeTimeoutMs,
    cfg.bc.profile,
  );

  const sres = await sessionFactory.create();
  if (!isOk(sres)) throw new Error(`session: ${sres.error.message}`);
  const session = sres.value;

  const metrics = new Metrics();
  const repo = new PageContextRepository();
  const page = new PageService(session, repo, logger, { tenantId: cfg.bc.tenantId, authMode: cfg.bc.authMode });
  const data = new DataService(session, repo, logger, false);
  const action = new ActionService(session, repo, logger);
  const filter = new FilterService(session, repo, logger, false);
  const navigation = new NavigationService(session, repo, logger);
  const search = new SearchService(session, logger);
  const screenshot = new ScreenshotService(cfg.bc, cfg.screenshotDir, () => session.companyName, logger, auth);
  const reportDownload = new ReportDownloadService(cfg.bc, cfg.reportDir, () => session.companyName, logger, auth);
  const manual = new ManualService(screenshot, cfg.manualDir, logger);
  const objectIndex = new ObjectIndexService(page, cfg.stateDir, cfg.bc.baseUrl, cfg.bc.tenantId, logger);

  return {
    env,
    cfg,
    logger,
    auth,
    session,
    metrics,
    repo,
    services: { page, data, action, filter, navigation, search, screenshot, reportDownload, manual, objectIndex },
    ops: {
      openPage: new OpenPageOperation(page),
      readData: new ReadDataOperation(data, repo, page),
      writeData: new WriteDataOperation(data, repo),
      executeAction: new ExecuteActionOperation(action, repo),
      closePage: new ClosePageOperation(page),
      searchPages: new SearchPagesOperation(search),
      navigate: new NavigateOperation(navigation),
      respondDialog: new RespondDialogOperation(session, repo, logger),
      switchCompany: new SwitchCompanyOperation(session, repo, logger),
      listCompanies: new ListCompaniesOperation(page, data, () => session.companyName, logger),
      runReport: new RunReportOperation(session),
      downloadReport: new DownloadReportOperation(reportDownload),
      screenshot: new ScreenshotOperation(screenshot),
      buildManual: new BuildManualOperation(manual),
      findObject: new FindObjectOperation(objectIndex),
      refreshObjects: new RefreshObjectsOperation(objectIndex),
      wizardNavigate: new WizardNavigateOperation(action, repo),
      health: new HealthOperation({ currentSession: () => session, metrics, bc: cfg.bc }),
    },
    dispose: async () => {
      await session.closeGracefully().catch(() => undefined);
    },
  };
}
