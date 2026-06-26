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
import { launchHeadless } from './browser.js';
import { authCookies, deepLinkReport, onSignIn, inPageLogin, waitReady } from './bc-web-auth.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  /** Editable field labels discovered on the request page (for retrying a missed caption). */
  availableFilterLabels?: string[];
}

export class ReportDownloadService {
  constructor(
    private readonly config: BCConfig,
    private readonly reportDir: string,
    private readonly getCompany: () => string | undefined,
    private readonly logger: Logger,
  ) {}

  async download(input: DownloadReportInput): Promise<DownloadReportResult> {
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
      const cookies = await authCookies(this.config);
      const p = await browser.newPage();
      await p.setCookie(...cookies);

      // Route downloads to our temp dir via CDP.
      const client = await p.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

      // domcontentloaded (not networkidle2): the BC SPA holds long-lived
      // connections, so networkidle2 routinely waits the full timeout for no
      // benefit. waitReady below handles actual readiness.
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (await onSignIn(p)) {
        this.logger.warn('[report] cookie injection landed on SignIn — logging in in-page');
        await inPageLogin(this.config, p);
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
      }
      // Short readiness budget: a report request page keeps the generic title, so
      // waitReady never trips and would otherwise burn the full 60s default.
      await waitReady(p, this.logger, { timeoutMs: 12000, settleMs: 1500 });

      // Set request-page filters (e.g. No. = a document number) BEFORE running, so
      // a document report prints exactly one record instead of nothing usable.
      let filtersApplied: FilterApplied[] | undefined;
      let availableFilterLabels: string[] | undefined;
      if (input.filters && Object.keys(input.filters).length > 0) {
        const r = await this.applyFilters(p, input.filters);
        filtersApplied = r.applied;
        availableFilterLabels = r.availableLabels;
        this.logger.info(`[report] filters applied: ${JSON.stringify(r.applied)}`);
        await sleep(900); // let BC commit the filter before running
      }

      // Drive the request page to produce a download. Verified live on devel1
      // (report 6 Trial Balance): the toolbar's "Enviar a…" / "Send to…" opens a
      // format dialog, then "Aceptar" / "OK" generates the file. The buttons carry
      // empty aria-labels / GUID titles, so we locate them by VISIBLE TEXT and
      // only click visible ones. Falls back to a direct confirm for simpler pages.
      const drivenFlow = await this.driveRequestPage(p);
      this.logger.info(`[report] request-page flow: ${drivenFlow ?? 'none'}`);

      // Poll for a completed download (Chrome writes *.crdownload while in flight).
      const file = await this.waitForDownload(dlDir, timeoutMs);
      const pageTitle = await p.title();
      const authenticated = !(await onSignIn(p));

      if (!file) {
        // The report ran but no binary was captured. The default
        // "Send to -> Aceptar" flow downloads most reports (verified live on
        // devel1, report 6 Trial Balance), so reaching here means this report
        // needs a specific parameter or output-format selection the default flow
        // did not satisfy.
        const unmatched = filtersApplied?.filter(f => !f.matched).map(f => f.caption) ?? [];
        let note: string;
        if (unmatched.length > 0) {
          note = `Filter caption(s) [${unmatched.join(', ')}] did not match any request-page field. `
            + `Available editable field labels: [${(availableFilterLabels ?? []).join(' | ')}]. `
            + 'Retry with the caption exactly as the request page shows it (locale-dependent).';
        } else if (filtersApplied && filtersApplied.length > 0) {
          note = 'Filters were set but no file was captured. The report may need an output-format '
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
          note, filtersApplied, availableFilterLabels,
        };
      }

      const dest = this.resolveOut(input.out, reportId, extname(file));
      copyFileSync(join(dlDir, file), dest);
      return {
        reportId, url, authenticated,
        downloaded: true, path: dest, fileName: file,
        requestPageShown: false, pageTitle,
        filtersApplied,
      };
    } finally {
      await browser.close();
      try { rmSync(dlDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * Drive a report's request page to emit a download.
   * Flow (verified live on devel1, report 6): click "Enviar a…" / "Send to…"
   * (opens a format dialog) → wait → click the dialog's "Aceptar" / "OK". If no
   * Send-to control exists, fall back to a direct confirm. Returns a short
   * description of what it clicked, or null when nothing matched.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async driveRequestPage(p: any): Promise<string | null> {
    // "Enviar a..." / "Send to..." — match by prefix (the caption ends in "...").
    const sendTo = await this.clickByText(p, ['Enviar a', 'Envia a', 'Send to'], true);
    if (sendTo) {
      await sleep(1800); // let the format dialog render
      const ok = await this.clickByText(p, ['Aceptar', 'OK', "D'acord", 'Accept', 'Acceptar'], false);
      await sleep(500);
      return `sendTo:"${sendTo}" -> confirm:"${ok ?? 'none'}"`;
    }
    // Fallback: a request page that just needs a confirm (no Send-to split button).
    // Confirm-only (NOT Print/Preview, which open a print view rather than a download).
    const direct = await this.clickByText(p, ['Aceptar', 'OK', "D'acord", 'Accept', 'Acceptar'], false);
    return direct ? `direct:"${direct}"` : null;
  }

  /**
   * Set request-page filter fields by visible caption before the report runs.
   * Used so a document report (RequestFilterFields = "No.") prints one record.
   *
   * Locating the field is locale-fragile (BC may show "Nº" for "No."), so we
   * collect every editable text input across all frames WITH its label signals
   * (aria-label / placeholder / aria-labelledby / nearest short ancestor text),
   * match the requested caption against those signals in Node (normalised), and
   * type with real key events (BC's filter binding ignores a bare .value set).
   * `availableLabels` is returned so a missed caption can be retried exactly.
   *
   * The in-browser evaluate callbacks contain NO named nested functions — under
   * tsx/esbuild those get a `__name` wrapper that is undefined in the page.
   */
  private async applyFilters(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p: any,
    filters: Record<string, string>,
  ): Promise<{ applied: FilterApplied[]; availableLabels: string[] }> {
    // Normalise for locale-tolerant matching: lowercase, drop dots/spaces/colons,
    // and fold the ordinal indicator so the Spanish "Nº" matches the caption "No.".
    const norm = (s: string): string => s.toLowerCase().replace(/º/g, 'o').replace(/ª/g, 'a').replace(/[.\s:]/g, '').trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: Array<{ handle: any; signals: string[] }> = [];
    const labelSet = new Set<string>();

    for (const f of p.frames()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let handles: any[] = [];
      try {
        handles = await f.$$('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable="true"]');
      } catch {
        continue; // detached / cross-origin frame
      }
      for (const h of handles) {
        const info = await h
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .evaluate((el: any) => {
            const vis = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
            const ro = el.readOnly === true || el.getAttribute('aria-readonly') === 'true' || el.disabled === true;
            const sig: string[] = [];
            const a = el.getAttribute('aria-label'); if (a && a.trim()) sig.push(a.trim());
            const ph = el.getAttribute('placeholder'); if (ph && ph.trim()) sig.push(ph.trim());
            const lid = el.getAttribute('aria-labelledby');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docu = (globalThis as any).document;
            if (lid) { const l = docu.getElementById(lid); if (l && (l.textContent || '').trim()) sig.push((l.textContent || '').trim()); }
            let n = el.parentElement; let depth = 0;
            while (n && depth < 4) { const t = (n.textContent || '').trim(); if (t && t.length <= 50) { sig.push(t); break; } n = n.parentElement; depth++; }
            return { vis, ro, sig };
          })
          .catch(() => null);
        if (!info || !info.vis || info.ro) continue;
        for (const s of info.sig) labelSet.add(s);
        candidates.push({ handle: h, signals: info.sig });
      }
    }

    const applied: FilterApplied[] = [];
    for (const [caption, value] of Object.entries(filters)) {
      const want = norm(caption);
      // Prefer an exact normalised label, then prefix, then substring (>=2 chars).
      const exact = candidates.find(c => c.signals.some(s => norm(s) === want));
      const prefix = exact ?? candidates.find(c => c.signals.some(s => { const n = norm(s); return n.length > 0 && (n.startsWith(want) || want.startsWith(n)); }));
      const hit = prefix ?? (want.length >= 2 ? candidates.find(c => c.signals.some(s => { const n = norm(s); return n.length >= 2 && (n.includes(want) || want.includes(n)); })) : undefined);
      if (!hit) {
        applied.push({ caption, matched: false });
        this.logger.warn(`[report] filter caption "${caption}" matched no request-page field`);
        continue;
      }
      const matchedLabel = hit.signals[0];
      try {
        await hit.handle.click({ clickCount: 3 }); // select existing content
        await hit.handle.type(String(value));
        await hit.handle.press('Enter');
        applied.push({ caption, matched: true, matchedLabel });
      } catch (e) {
        applied.push({ caption, matched: false, matchedLabel });
        this.logger.warn(`[report] failed to type filter "${caption}": ${e instanceof Error ? e.message : String(e)}`);
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
   */
  private async waitForDownload(dir: string, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    const startDeadline = Date.now() + Math.min(timeoutMs, 15000);
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
      const done = all.filter((f) => !f.endsWith('.crdownload'));
      if (done.length > 0) {
        // newest by mtime
        return done
          .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)[0]!.f;
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
