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

      await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      if (await onSignIn(p)) {
        this.logger.warn('[report] cookie injection landed on SignIn — logging in in-page');
        await inPageLogin(this.config, p);
        await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => undefined);
      }
      await waitReady(p, this.logger);

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
        return {
          reportId, url, authenticated,
          downloaded: false, requestPageShown: true, pageTitle,
          note: 'No file was captured. The report likely needs a specific parameter or output-format '
            + 'selection that the default "Send to -> Aceptar" flow did not satisfy. Inspect/fill the request '
            + 'page with bc_run_report, or run scripts/capture-report-requestpage.ts <id> so the flow can be extended.',
        };
      }

      const dest = this.resolveOut(input.out, reportId, extname(file));
      copyFileSync(join(dlDir, file), dest);
      return {
        reportId, url, authenticated,
        downloaded: true, path: dest, fileName: file,
        requestPageShown: false, pageTitle,
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

  /** Resolve the newest completed (non-.crdownload) file in dir, polling up to timeoutMs. */
  private async waitForDownload(dir: string, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const files = readdirSync(dir).filter((f) => !f.endsWith('.crdownload'));
      if (files.length > 0) {
        // newest by mtime
        return files
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
