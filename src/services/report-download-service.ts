// src/services/report-download-service.ts
//
// P9 (Camí B): download a report's rendered output (PDF/Excel/Word) via the
// authenticated headless browser, WITHOUT touching the WebSocket session.
//
// Why a browser and not the WS: after a report runs, BC streams the binary over
// a separate StreamTransfer channel (FileActionDialog / BrowserDownloadFileRequest)
// that the WS codec does not listen to. The web client receives it as a normal
// browser download, so we drive that client and intercept the download via CDP
// (Page.setDownloadBehavior) -- reusing the exact same cookie-injection auth as
// bc_screenshot.
//
// The deep link opens the report's REQUEST PAGE. Reports that run with no
// required parameters download immediately; reports that need parameters show a
// request page (we surface requestPageShown so the caller can fall back to the
// WS bc_run_report path to fill parameters). Triggering the request page's
// "Send to..." / Print path across BC versions is the live-verification point
// (see docs/Plans) -- the auth + CDP capture + completion polling below are the
// stable, reusable core.

import { mkdirSync, mkdtempSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve, join, extname } from 'node:path';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';
import { launchHeadless } from './browser.js';
import {
  ensureAuthJar, deepLinkReport, onSignIn, waitReady,
  fallbackFormsProvider, recoverIfOnSignIn, detectErrorPage,
} from './bc-web-auth.js';
import type { Metrics } from './metrics.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * G3: the output format the "Send to…" dialog can produce. BC renders it as a radio
 * group whose labels are LOCALIZED ("Documento PDF", "Microsoft Excel Document", …),
 * so each format is matched by a token that survives translation.
 */
export type ReportOutputFormat = 'pdf' | 'excel' | 'word' | 'xml';

/** Token that identifies each format in the radio label, in any locale BC ships. */
const FORMAT_TOKENS: Record<ReportOutputFormat, RegExp> = {
  pdf: /pdf/i,
  excel: /excel|xlsx|hoja de c(á|a)lculo|full de c(à|a)lcul/i,
  word: /word|docx|documento de word|document de word/i,
  xml: /xml/i,
};

export interface DownloadReportInput {
  reportId: string;
  company?: string;
  /** Output file path (absolute, or relative to BC_REPORT_DIR). Omit to auto-name. */
  out?: string;
  /** How long to wait for a download to complete after navigation (ms, default 60000). */
  timeoutMs?: number;
  /**
   * Request-page filters to set before running, keyed by the filter field caption
   * as shown on the report's request page (e.g. `{ "No.": "2000052" }`). Lets a
   * document report (RequestFilterFields = "No.") print one specific record.
   */
  filters?: Record<string, string>;
  /**
   * G4: Options-area request-page parameters — everything that is NOT a filter field:
   * dates, booleans (checkboxes), option/dropdown selectors, numbers. Keyed by the
   * visible caption, same locale-tolerant matching as `filters`. Booleans set the
   * checkbox state; everything else is typed/selected.
   *
   * `filters` and `parameters` share one implementation (BC's DOM does not reliably
   * separate the two areas); they are applied filters-first, then parameters.
   */
  parameters?: Record<string, string | number | boolean>;
  /**
   * G3: force the output format instead of accepting BC's default (PDF). When the
   * requested format is NOT offered by this report, the download is ABORTED rather
   * than silently producing a PDF: the result comes back `downloaded:false` with
   * `availableFormats` listing what the dialog actually offered.
   */
  format?: ReportOutputFormat;
}

/**
 * True when the requested format can only come from the "Send to…" dialog.
 *
 * BC's default output IS pdf, so a confirm-only request page (no Send-to control)
 * satisfies `format:"pdf"` — it must run and be reported as a success. Any other
 * format cannot be produced there, and asking for it must abort BEFORE the confirm
 * click: running the report and only then declaring failure produced a file the
 * caller was told did not exist, in a temp dir that was deleted on the way out.
 */
export function formatNeedsSendToDialog(format?: ReportOutputFormat): boolean {
  return !!format && format !== 'pdf';
}

/**
 * Captions the caller asked for that matched NO request-page field — across both
 * filters and parameters. An unmatched caption is silent by nature: BC keeps its
 * default and renders the report anyway, so the file looks perfectly fine while
 * containing entirely different data.
 */
export function unmatchedCaptions(...groups: Array<FilterApplied[] | undefined>): string[] {
  return groups.flatMap((g) => g ?? []).filter((f) => !f.matched).map((f) => f.caption);
}

export interface FilterApplied {
  caption: string;
  matched: boolean;
  /** The actual field label the caption matched (may differ by locale, e.g. "Nº"). */
  matchedLabel?: string;
}

export interface DownloadReportResult {
  reportId: string;
  url: string;
  authenticated: boolean;
  /** True when a file was captured. */
  downloaded: boolean;
  /** Absolute path of the saved file (when downloaded). */
  path?: string;
  /** Original download filename as Chrome named it. */
  fileName?: string;
  /** True when nothing downloaded — the report is waiting for interaction (a request page with parameters). */
  requestPageShown: boolean;
  /** Human-readable explanation when `downloaded` is false. */
  note?: string;
  pageTitle: string;
  /** Per-requested-filter outcome (present when `filters` was passed). */
  filtersApplied?: FilterApplied[];
  /** G4: per-requested-parameter outcome (present when `parameters` was passed). */
  parametersApplied?: FilterApplied[];
  /** Editable field labels discovered on the request page (for retrying a missed caption). */
  availableFilterLabels?: string[];
  /** G3: the format that was requested, echoed back. */
  format?: ReportOutputFormat;
  /** G3: true when that format was actually selected in the Send-to dialog. */
  formatSelected?: boolean;
  /** G3: the format labels this report's Send-to dialog offered (verbatim, localized). */
  availableFormats?: string[];
}

export class ReportDownloadService {
  private _auth?: IBCAuthProvider;

  constructor(
    private readonly config: BCConfig,
    private readonly reportDir: string,
    private readonly getCompany: () => string | undefined,
    private readonly logger: Logger,
    authProvider?: IBCAuthProvider,
    private readonly metrics?: Metrics,
  ) {
    this._auth = authProvider;
  }

  /** Shared auth provider (one login for WS + browser). Standalone scripts that
   * don't inject one get a self-contained forms provider built from config. */
  private auth(): IBCAuthProvider {
    if (!this._auth) this._auth = fallbackFormsProvider(this.config, this.logger);
    return this._auth;
  }

  async download(input: DownloadReportInput): Promise<DownloadReportResult> {
    const started = Date.now();
    try {
      const r = await this.runDownload(input);
      this.metrics?.recordReportDownload(r.downloaded, Date.now() - started);
      return r;
    } catch (e) {
      this.metrics?.recordReportDownload(false, Date.now() - started);
      throw e;
    }
  }

  private async runDownload(input: DownloadReportInput): Promise<DownloadReportResult> {
    const reportId = String(input.reportId).trim();
    const company = input.company || this.getCompany();
    const url = deepLinkReport(this.config, reportId, company);
    const timeoutMs = input.timeoutMs ?? 60000;
    this.logger.info(`[report] downloading report ${reportId} via ${url}`);

    // Capture downloads into a private temp dir so we can unambiguously detect
    // the new file (the shared reportDir may already contain other reports).
    const dlDir = mkdtempSync(join(tmpdir(), 'bc-report-'));
    const browser = await launchHeadless();
    try {
      const cookies = await ensureAuthJar(this.auth());
      const p = await browser.newPage();
      await p.setCookie(...cookies);

      // Route downloads to our temp dir via CDP.
      const client = await p.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

      // domcontentloaded (not networkidle2): the BC SPA holds long-lived
      // connections, so networkidle2 routinely waits the full timeout for no
      // benefit. waitReady below handles actual readiness.
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await recoverIfOnSignIn(p, this.auth(), this.config, this.logger, { tag: 'report', returnTo: url });
      // Short readiness budget: a report request page keeps the generic title, so
      // waitReady never trips and would otherwise burn the full 60s default.
      await waitReady(p, { timeoutMs: 12000, settleMs: 1500 });

      // SaaS: the report deep-link races with BC's SPA routing and intermittently
      // lands on a "Go back home" error page instead of the request page. Detect it
      // and re-navigate a few times. Harmless on-prem (which never hits this page).
      let bcError = await detectErrorPage(p);
      for (let attempt = 0; attempt < 5 && bcError; attempt++) {
        this.logger.warn(`[report] deep-link landed on an error page ("${bcError}"); re-navigating (${attempt + 1}/5)`);
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
        await waitReady(p, { timeoutMs: 12000, settleMs: 2000 });
        // Re-check AFTER the last navigation too — otherwise a retry that worked
        // would still be reported as a failure.
        bcError = await detectErrorPage(p);
      }
      // Still BC's error screen after the retries: driving a request page that isn't
      // there produces a timed-out download and a mystified caller. Say what BC said.
      if (bcError) {
        return {
          reportId, url, authenticated: !(await onSignIn(p)),
          downloaded: false, requestPageShown: false, pageTitle: await p.title(),
          note: `BC returned an error page instead of report ${reportId}'s request page: "${bcError}". `
            + `Check the report id and the company (${company ?? 'session default'}).`,
        };
      }

      // Set request-page filters (e.g. No. = a document number) BEFORE running, so
      // a document report prints exactly one record instead of nothing usable.
      let filtersApplied: FilterApplied[] | undefined;
      let parametersApplied: FilterApplied[] | undefined;
      let availableFilterLabels: string[] | undefined;
      if (input.filters && Object.keys(input.filters).length > 0) {
        const r = await this.applyRequestPageValues(p, input.filters);
        filtersApplied = r.applied;
        availableFilterLabels = r.availableLabels;
        this.logger.info(`[report] filters applied: ${JSON.stringify(r.applied)}`);
        await sleep(900); // let BC commit the filter before running
      }
      // G4: Options-area parameters (dates, booleans, option pickers). Same matcher,
      // applied after the filters so a filter-driven request page is already settled.
      if (input.parameters && Object.keys(input.parameters).length > 0) {
        const r = await this.applyRequestPageValues(p, input.parameters);
        parametersApplied = r.applied;
        availableFilterLabels = [...new Set([...(availableFilterLabels ?? []), ...r.availableLabels])];
        this.logger.info(`[report] parameters applied: ${JSON.stringify(r.applied)}`);
        await sleep(900);
      }

      // Drive the request page to produce a download. Verified live on devel1
      // (report 6 Trial Balance): the toolbar's "Enviar a…" / "Send to…" opens a
      // format dialog, then "Aceptar" / "OK" generates the file. The buttons carry
      // empty aria-labels / GUID titles, so we locate them by VISIBLE TEXT and
      // only click visible ones. Falls back to a direct confirm for simpler pages.
      const driven = await this.driveRequestPage(p, input.format);
      this.logger.info(`[report] request-page flow: ${driven.flow ?? 'none'}`);

      // Every return path carries the same request-page diagnostics: which captions
      // matched, which format was used and what the dialog offered. Leaving them off
      // the success path is what let an unmatched `parameters` caption ship a
      // default-options report that looked completely clean.
      const diagnostics = {
        filtersApplied, parametersApplied, availableFilterLabels,
        format: input.format,
        ...(input.format ? { formatSelected: driven.formatSelected ?? false } : {}),
        ...(driven.availableFormats ? { availableFormats: driven.availableFormats } : {}),
      };

      // G3: the requested format is not on offer — do NOT fall through to the
      // default (which would hand back a PDF labelled as the requested format).
      // When the report has no Send-to dialog at all, driveRequestPage refuses to
      // click ANYTHING for a non-default format, so nothing has run at this point.
      if (input.format && driven.formatSelected === false) {
        return {
          reportId, url, authenticated: !(await onSignIn(p)),
          downloaded: false, requestPageShown: true, pageTitle: await p.title(),
          note: driven.noFormatDialog
            ? `Report ${reportId} offers no output-format dialog ("Send to…" is not on its request page), `
              + `so only BC's default output (PDF) can be produced. Nothing was run. `
              + 'Re-run with format:"pdf" or without `format`.'
            : `Output format "${input.format}" is not offered by report ${reportId}. `
              + `The Send to dialog offered: [${(driven.availableFormats ?? []).join(' | ')}]. `
              + 'Re-run without `format` to accept the default, or pick one of those.',
          ...diagnostics,
        };
      }

      // Poll for a completed download (Chrome writes *.crdownload while in flight).
      // Once a confirm/OK was actually clicked the report IS running server-side, so
      // the short start grace must not apply (heavy reports render well past 15s).
      const file = await this.waitForDownload(dlDir, timeoutMs, driven.confirmed);
      const pageTitle = await p.title();
      const authenticated = !(await onSignIn(p));
      const unmatched = unmatchedCaptions(filtersApplied, parametersApplied);

      if (!file) {
        // The report ran but no binary was captured. The default
        // "Send to -> Aceptar" flow downloads most reports (verified live on
        // devel1, report 6 Trial Balance), so reaching here means this report
        // needs a specific parameter or output-format selection the default flow
        // did not satisfy.
        let note: string;
        if (unmatched.length > 0) {
          note = `Filter/parameter caption(s) [${unmatched.join(', ')}] did not match any request-page field. `
            + `Available editable field labels: [${(availableFilterLabels ?? []).join(' | ')}]. `
            + 'Retry with the caption exactly as the request page shows it (locale-dependent).';
        } else if (!driven.confirmed) {
          note = 'Nothing on the request page could be clicked to run the report (no "Send to…" and no '
            + 'confirm/OK button matched). Drive the request page interactively with bc_run_report, or run '
            + 'scripts/capture-report-requestpage.ts <id> so the flow can be extended.';
        } else if ((filtersApplied?.length ?? 0) + (parametersApplied?.length ?? 0) > 0) {
          note = 'Filters/parameters were set but no file was captured. The report may need an output-format '
            + 'selection, or the "Send to -> Aceptar" flow did not complete on this report.';
        } else {
          note = 'No file was captured. The report likely needs a specific parameter or output-format '
            + 'selection that the default "Send to -> Aceptar" flow did not satisfy. For a document report, '
            + 'pass filters (e.g. { "No.": "<docno>" }). Inspect/fill the request page with bc_run_report, '
            + 'or run scripts/capture-report-requestpage.ts <id> so the flow can be extended.';
        }
        return {
          reportId, url, authenticated,
          downloaded: false, requestPageShown: true, pageTitle,
          note, ...diagnostics,
        };
      }

      const dest = this.resolveOut(input.out, reportId, extname(file));
      copyFileSync(join(dlDir, file), dest);
      // A file is NOT proof the request page was filled as asked: an unmatched
      // caption simply leaves BC's default in place and the report renders anyway.
      // Say so on the success path too (this project's "never trust success alone").
      const note = unmatched.length > 0
        ? `WARNING: the file was produced with DEFAULT options — caption(s) [${unmatched.join(', ')}] `
          + `matched no request-page field, so those values were NOT applied. `
          + `Available editable field labels: [${(availableFilterLabels ?? []).join(' | ')}]. `
          + 'Retry with the caption exactly as the request page shows it (locale-dependent).'
        : undefined;
      return {
        reportId, url, authenticated,
        downloaded: true, path: dest, fileName: file,
        requestPageShown: false, pageTitle,
        ...(note ? { note } : {}),
        ...diagnostics,
      };
    } finally {
      await browser.close();
      try { rmSync(dlDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * Drive a report's request page to emit a download.
   *
   * Flow (verified live on devel1, report 6): click "Enviar a…" / "Send to…"
   * (opens a format dialog) → wait → click the dialog's "Aceptar" / "OK". If no
   * Send-to control exists, fall back to a direct confirm.
   *
   * `confirmed` is the load-bearing part of the return value: it says whether an
   * OK/confirm was actually CLICKED, i.e. whether the report is now running
   * server-side. The caller needs it twice — to wait the full timeout for a slow
   * render, and to keep a confirm-only report from being reported as a failure.
   *
   * Format handling is decided BEFORE any confirm click. A report with no Send-to
   * dialog can only produce BC's default output (PDF): asking for `pdf` runs the
   * direct flow and counts as a success, while asking for excel/word/xml aborts
   * WITHOUT clicking, so a file is never produced-then-discarded.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async driveRequestPage(p: any, format?: ReportOutputFormat): Promise<{
    flow: string | null;
    /** An OK/confirm was clicked — the report is running. */
    confirmed: boolean;
    formatSelected?: boolean;
    availableFormats?: string[];
    /** This report has no "Send to…" dialog, so no format choice exists at all. */
    noFormatDialog?: boolean;
  }> {
    const CONFIRM = ['Aceptar', 'OK', "D'acord", 'Accept', 'Acceptar'];
    // "Enviar a..." / "Send to..." — match by prefix (the caption ends in "...").
    const sendTo = await this.clickByText(p, ['Enviar a', 'Envia a', 'Send to'], true);
    if (sendTo) {
      await sleep(1800); // let the format dialog render
      if (format) {
        // G3: the dialog is a radio group of output formats. Pick the requested one
        // BEFORE confirming; if it isn't there, stop — returning a PDF for a request
        // that asked for Excel would be worse than failing.
        const picked = await this.selectOutputFormat(p, format);
        if (!picked.selected) {
          return {
            flow: `sendTo:"${sendTo}" -> format "${format}" not offered (nothing confirmed)`,
            confirmed: false, formatSelected: false, availableFormats: picked.available,
          };
        }
        await sleep(400);
        const okF = await this.clickByText(p, CONFIRM, false);
        await sleep(500);
        return {
          flow: `sendTo:"${sendTo}" -> format:"${picked.matchedLabel}" -> confirm:"${okF ?? 'none'}"`,
          confirmed: !!okF,
          formatSelected: true,
          availableFormats: picked.available,
        };
      }
      const ok = await this.clickByText(p, CONFIRM, false);
      await sleep(500);
      return { flow: `sendTo:"${sendTo}" -> confirm:"${ok ?? 'none'}"`, confirmed: !!ok };
    }

    // No Send-to control -> this report has no format dialog, only BC's default (PDF).
    // Decide BEFORE clicking: running the report and THEN declaring the format
    // unavailable produced a file that the caller was told did not exist, and the
    // temp dir holding it was deleted on the way out.
    if (formatNeedsSendToDialog(format)) {
      return { flow: null, confirmed: false, formatSelected: false, availableFormats: [], noFormatDialog: true };
    }
    // Fallback: a request page that just needs a confirm (no Send-to split button).
    // Confirm-only (NOT Print/Preview, which open a print view rather than a download).
    const direct = await this.clickByText(p, CONFIRM, false);
    return {
      flow: direct ? `direct:"${direct}"` : null,
      confirmed: !!direct,
      // The default output IS pdf, so an explicit format:"pdf" is satisfied here.
      ...(format ? { formatSelected: true, availableFormats: [], noFormatDialog: true } : {}),
    };
  }

  /**
   * G3: pick an output format in the "Send to…" dialog.
   *
   * The dialog is a radio group (`name="b13"`, options `b13_0..b13_5` on BC27) whose
   * labels are localized, so each radio is matched by a locale-proof token from
   * FORMAT_TOKENS against every label signal we can see (aria-label, the <label> bound
   * by id/for, and the nearest short ancestor text). Returns the labels found either
   * way, so a caller that asked for something unavailable gets told what IS available.
   *
   * The in-browser callback contains NO named nested functions (tsx/esbuild wraps
   * those in a `__name` helper that does not exist in the page).
   */
  private async selectOutputFormat(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p: any,
    format: ReportOutputFormat,
  ): Promise<{ selected: boolean; matchedLabel?: string; available: string[] }> {
    const token = FORMAT_TOKENS[format];
    const available: string[] = [];

    for (const f of p.frames()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let radios: any[] = [];
      try {
        radios = await f.$$('input[type="radio"], [role="radio"]');
      } catch {
        continue; // detached / cross-origin frame
      }
      for (const h of radios) {
        const info = await h
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .evaluate((el: any) => {
            const visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docu = (globalThis as any).document;
            const sig: string[] = [];
            const a = el.getAttribute('aria-label'); if (a && a.trim()) sig.push(a.trim());
            if (el.id) {
              const lbl = docu.querySelector(`label[for="${el.id}"]`);
              if (lbl && (lbl.textContent || '').trim()) sig.push((lbl.textContent || '').trim());
            }
            const lid = el.getAttribute('aria-labelledby');
            if (lid) { const l = docu.getElementById(lid); if (l && (l.textContent || '').trim()) sig.push((l.textContent || '').trim()); }
            let n = el.parentElement; let depth = 0;
            while (n && depth < 3) { const t = (n.textContent || '').trim(); if (t && t.length <= 60) { sig.push(t); break; } n = n.parentElement; depth++; }
            return { visible, sig };
          })
          .catch(() => null);
        if (!info || !info.visible) continue;
        for (const s of info.sig) if (s && !available.includes(s)) available.push(s);
        const matchedLabel = info.sig.find((s: string) => token.test(s));
        if (matchedLabel) {
          try {
            await h.click();
            this.logger.info(`[report] output format "${format}" selected via "${matchedLabel}"`);
            return { selected: true, matchedLabel, available };
          } catch (e) {
            this.logger.warn(`[report] could not click the "${matchedLabel}" format radio: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    return { selected: false, available };
  }

  /**
   * Set request-page values by visible caption before the report runs — both the
   * FILTER fields (RequestFilterFields, e.g. "No." so a document report prints one
   * record) and, since G4, the OPTIONS area: dates, numbers, booleans (checkboxes)
   * and option pickers.
   *
   * Locating the field is locale-fragile (BC may show "Nº" for "No."), so we collect
   * every editable control across all frames WITH its label signals (aria-label /
   * placeholder / aria-labelledby / nearest short ancestor text), match the requested
   * caption against those signals in Node (normalised), and then set it according to
   * its KIND: a checkbox is clicked only when its state differs from the requested
   * boolean, a <select> gets its option chosen, everything else is typed with real key
   * events (BC's binding ignores a bare `.value` set). `availableLabels` is returned so
   * a missed caption can be retried exactly.
   *
   * The in-browser evaluate callbacks contain NO named nested functions — under
   * tsx/esbuild those get a `__name` wrapper that is undefined in the page.
   */
  private async applyRequestPageValues(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p: any,
    values: Record<string, string | number | boolean>,
  ): Promise<{ applied: FilterApplied[]; availableLabels: string[] }> {
    // Normalise for locale-tolerant matching: lowercase, drop dots/spaces/colons,
    // and fold the ordinal indicator so the Spanish "Nº" matches the caption "No.".
    const norm = (s: string): string => s.toLowerCase().replace(/º/g, 'o').replace(/ª/g, 'a').replace(/[.\s:]/g, '').trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: Array<{ handle: any; signals: string[]; kind: 'text' | 'checkbox' | 'select' }> = [];
    const labelSet = new Set<string>();

    for (const f of p.frames()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let handles: any[] = [];
      try {
        // G4 widened this: checkboxes (booleans) and selects (option fields) used to be
        // excluded, which is exactly why only RequestFilterFields could be set.
        handles = await f.$$('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=radio]), textarea, select, [contenteditable="true"]');
      } catch {
        continue; // detached / cross-origin frame
      }
      for (const h of handles) {
        const info = await h
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .evaluate((el: any) => {
            const vis = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
            const ro = el.readOnly === true || el.getAttribute('aria-readonly') === 'true' || el.disabled === true;
            const tag = (el.tagName || '').toLowerCase();
            const kind = tag === 'select' ? 'select' : (el.type === 'checkbox' ? 'checkbox' : 'text');
            const sig: string[] = [];
            const a = el.getAttribute('aria-label'); if (a && a.trim()) sig.push(a.trim());
            const ph = el.getAttribute('placeholder'); if (ph && ph.trim()) sig.push(ph.trim());
            const lid = el.getAttribute('aria-labelledby');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docu = (globalThis as any).document;
            if (lid) { const l = docu.getElementById(lid); if (l && (l.textContent || '').trim()) sig.push((l.textContent || '').trim()); }
            if (el.id) {
              const lbl = docu.querySelector(`label[for="${el.id}"]`);
              if (lbl && (lbl.textContent || '').trim()) sig.push((lbl.textContent || '').trim());
            }
            let n = el.parentElement; let depth = 0;
            while (n && depth < 4) { const t = (n.textContent || '').trim(); if (t && t.length <= 50) { sig.push(t); break; } n = n.parentElement; depth++; }
            return { vis, ro, sig, kind };
          })
          .catch(() => null);
        if (!info || !info.vis || info.ro) continue;
        for (const s of info.sig) labelSet.add(s);
        candidates.push({ handle: h, signals: info.sig, kind: info.kind as 'text' | 'checkbox' | 'select' });
      }
    }

    const applied: FilterApplied[] = [];
    for (const [caption, value] of Object.entries(values)) {
      const want = norm(caption);
      // A boolean can only mean a checkbox — never let it land on a text field that
      // happens to share a caption prefix.
      const pool = typeof value === 'boolean' ? candidates.filter(c => c.kind === 'checkbox') : candidates;
      // Prefer an exact normalised label, then prefix, then substring (>=2 chars).
      const exact = pool.find(c => c.signals.some(s => norm(s) === want));
      const prefix = exact ?? pool.find(c => c.signals.some(s => { const n = norm(s); return n.length > 0 && (n.startsWith(want) || want.startsWith(n)); }));
      const hit = prefix ?? (want.length >= 2 ? pool.find(c => c.signals.some(s => { const n = norm(s); return n.length >= 2 && (n.includes(want) || want.includes(n)); })) : undefined);
      if (!hit) {
        applied.push({ caption, matched: false });
        this.logger.warn(`[report] caption "${caption}" matched no request-page field`);
        continue;
      }
      const matchedLabel = hit.signals[0];
      try {
        if (hit.kind === 'checkbox') {
          // Click only when the current state differs — clicking a checkbox that is
          // already right would toggle it wrong.
          const wanted = value === true || value === 'true' || value === 1 || value === '1';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const current: boolean = await hit.handle.evaluate((el: any) => el.checked === true);
          if (current !== wanted) await hit.handle.click();
        } else if (hit.kind === 'select') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await hit.handle.evaluate((el: any, v: string) => {
            const opts = Array.prototype.slice.call(el.options || []);
            const match = opts.find((o: { text?: string; value?: string }) =>
              (o.text || '').trim().toLowerCase() === v.trim().toLowerCase()
              || (o.value || '').trim().toLowerCase() === v.trim().toLowerCase());
            if (match) {
              el.value = (match as { value: string }).value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, String(value));
        } else {
          await hit.handle.click({ clickCount: 3 }); // select existing content
          await hit.handle.type(String(value));
          await hit.handle.press('Enter');
        }
        applied.push({ caption, matched: true, matchedLabel });
      } catch (e) {
        applied.push({ caption, matched: false, matchedLabel });
        this.logger.warn(`[report] failed to set "${caption}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { applied, availableLabels: [...labelSet].slice(0, 40) };
  }

  /**
   * Click the first VISIBLE control whose visible text (or aria-label) matches a
   * candidate, across all frames. `prefix` matches by startsWith (for captions
   * like "Enviar a..."); otherwise exact match. Returns the matched text or null.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async clickByText(p: any, candidates: string[], prefix: boolean): Promise<string | null> {
    for (const f of p.frames()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const clicked: string | null = await f.evaluate((wants: string[], byPrefix: boolean) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = (globalThis as any).document;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const els: any[] = Array.prototype.slice.call(
            doc.querySelectorAll('button,[role="button"],[role="menuitem"],a,input[type="button"],input[type="submit"]'),
          );
          for (const el of els) {
            const visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
            if (!visible) continue;
            const t = (el.textContent || '').trim();
            const a = (el.getAttribute('aria-label') || '').trim();
            for (const w of wants) {
              const hit = byPrefix ? (t.indexOf(w) === 0 || a.indexOf(w) === 0) : (t === w || a === w);
              if (hit) { el.click(); return t || a || w; }
            }
          }
          return null;
        }, candidates, prefix);
        if (clicked) return clicked;
      } catch {
        // cross-origin / empty frame — ignore
      }
    }
    return null;
  }

  /**
   * Resolve the newest completed (non-.crdownload) file in dir.
   *
   * Two-phase wait so a report that is silently waiting for parameters (e.g. a
   * document-scoped report whose request page the default flow can't fill) does
   * NOT dead-hang the full timeoutMs. A full-length hang overruns the MCP client's
   * own request timeout and surfaces as "-32001 Request timed out" instead of the
   * clean requestPageShown result the caller needs.
   *
   * Phase 1 (start grace): if NOTHING begins downloading -- not even a *.crdownload
   * partial -- within a short window, bail early (the report is waiting for input).
   * Phase 2: once a download has started, wait up to the full timeoutMs for it to
   * finish writing.
   *
   * The start grace applies ONLY when the caller could not confirm the request page
   * (`confirmed:false`). Once an OK was clicked the report IS rendering server-side,
   * and a heavy report routinely takes far longer than 15s before Chrome sees the
   * first byte -- bailing there reported downloaded:false while the file landed
   * moments later into a temp dir that was then deleted.
   */
  private async waitForDownload(dir: string, timeoutMs: number, confirmed: boolean): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    const startDeadline = Date.now() + (confirmed ? timeoutMs : Math.min(timeoutMs, 15000));
    let started = false;
    while (Date.now() < deadline) {
      const all = readdirSync(dir);
      if (!started) {
        if (all.length > 0) {
          started = true; // a *.crdownload partial or a finished file appeared
        } else if (Date.now() >= startDeadline) {
          return undefined; // nothing began -> report is waiting for parameters
        }
      }
      // Chrome renames <name>.crdownload -> <name> while we are listing, so a file
      // present in readdirSync can be gone by the statSync a moment later. An ENOENT
      // here used to reject the whole download even though it had completed.
      const done = all
        .filter((f) => !f.endsWith('.crdownload'))
        .map((f) => {
          try {
            return { f, t: statSync(join(dir, f)).mtimeMs };
          } catch {
            return null; // renamed/removed mid-scan — it will show up next pass
          }
        })
        .filter((e): e is { f: string; t: number } => e !== null);
      if (done.length > 0) {
        // newest by mtime
        return done.sort((a, b) => b.t - a.t)[0]!.f;
      }
      await sleep(500);
    }
    return undefined;
  }

  private resolveOut(out: string | undefined, reportId: string, ext: string): string {
    const dir = isAbsolute(this.reportDir) ? this.reportDir : resolve(process.cwd(), this.reportDir);
    let file: string;
    if (out) {
      file = isAbsolute(out) ? out : resolve(dir, out);
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      file = resolve(dir, `report-${reportId}-${stamp}${ext || '.pdf'}`);
    }
    mkdirSync(resolve(file, '..'), { recursive: true });
    return file;
  }
}
