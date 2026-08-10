import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';
import { launchHeadless } from './browser.js';
import {
  ensureAuthJar, deepLinkPage, onSignIn, waitReady,
  fallbackFormsProvider, recoverIfOnSignIn,
} from './bc-web-auth.js';
import type { Metrics } from './metrics.js';

/**
 * ScreenshotService — captures a REAL screenshot of the BC web client.
 *
 * This is additive and OUT-OF-BAND: it does NOT touch the WebSocket protocol path
 * or the invoke queue, so normal bc-mcp operations keep their full speed. A headless
 * browser (system Chrome/Edge via puppeteer-core, no bundled download) is launched
 * on demand only when a screenshot is requested, then torn down.
 *
 * Engine = "cookie injection" (the most stable, fully-unattended method, verified
 * live against BC27/devel1): bc-mcp authenticates to BC's forms login (/SignIn),
 * exports the resulting cookie jar WITH its real attributes (path=/BC; secure;
 * samesite=none; httponly), injects it into the browser, and opens a deep-link URL
 * built from the page id + bookmark + company. If injection ever lands on the login
 * page, it falls back to performing the /SignIn form once in-page.
 *
 * IMPORTANT: never send runinframe=1 in the URL — it makes a top-level load hang on
 * "Getting ready..." waiting for an iframe-parent handshake that never arrives.
 */

/** One annotation drawn over a located control (by its visible caption). */
export interface Annotation {
  /** Caption / aria-label text of the control to locate. */
  target: string;
  /** Optional label/number shown on the callout (e.g. "1", "2"). */
  label?: string;
  /** 'box' (red border, default), 'badge' (numbered circle + box), 'arrow' (pointer + label), 'blur' (redact). */
  style?: 'box' | 'arrow' | 'badge' | 'blur';
}

export interface CaptureInput {
  pageId: string;
  bookmark?: string;
  company?: string;
  /** Normalized annotations to draw (the operation converts the flexible schema input into this). */
  annotations?: Annotation[];
  /** Captions to redact (opaque box) — shorthand for { target, style:'blur' }. */
  redact?: string[];
  /** Caption(s) to crop the screenshot to (clip = union bbox of the located captions + padding). */
  crop?: string[];
  /**
   * Reveal hidden content before capturing: expand every collapsed FastTab/group and
   * click every "Show more" toggle so additional fields become visible. When false
   * (default) the page is captured in whatever collapse/Show-more state BC restores,
   * but a reveal pass still runs automatically if a requested highlight/crop target
   * turns out to be hidden (reveal-when-needed).
   */
  expand?: boolean;
  /**
   * G6: captions of controls to CLICK before capturing, in order — the deterministic
   * companion to `expand`. Use it when a section only reveals its content on an
   * explicit toggle (a document's "Lines", a collapsed part, a tab) and you want to
   * name it rather than rely on the generic reveal pass. Matching is by visible text
   * or aria-label, exact first then prefix, across every frame.
   */
  clickBeforeCapture?: string[];
  out?: string;
  width?: number;
  height?: number;
  scale?: number;
  fullPage?: boolean;
  inline?: boolean;
}

export interface CaptureResult {
  path: string;
  url: string;
  pageTitle: string;
  authenticated: boolean;
  spaReady: boolean;
  annotations?: Array<{ target: string; found: boolean }>;
  /**
   * Per-`redact` outcome. A redaction that was NOT found means the PNG on disk
   * still SHOWS that value — this must never be silently dropped, which is why it
   * is reported separately from `annotations` and also raised in `warning`.
   */
  redactions?: Array<{ target: string; found: boolean }>;
  /** Loud, human-readable alert when something is wrong with the capture (redaction misses first). */
  warning?: string;
  cropped?: boolean;
  width: number;
  height: number;
  base64?: string;
}

/**
 * A capture session holds ONE authenticated browser open across many captures.
 *
 * A manual with 10 steps used to pay a full browser launch + auth + SPA boot per
 * step (~5s each, before BC even started rendering). `bc_screenshot` keeps using
 * the single-shot `capture()`, which is this same path opened and closed around
 * one capture.
 */
export interface ScreenshotSession {
  capture(input: CaptureInput): Promise<CaptureResult>;
  close(): Promise<void>;
}

interface Rect { x: number; y: number; w: number; h: number; }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ScreenshotService {
  private _auth?: IBCAuthProvider;

  constructor(
    private readonly config: BCConfig,
    private readonly screenshotDir: string,
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

  /**
   * Open a reusable capture session: ONE browser, ONE login, many captures.
   * The caller MUST close it (try/finally). `bc_build_manual` uses this so a
   * 10-step manual pays a single browser launch instead of ten.
   */
  async openSession(): Promise<ScreenshotSession> {
    const browser = await launchHeadless();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any;
    return {
      capture: async (input: CaptureInput): Promise<CaptureResult> => {
        // Cheap when the provider is already authenticated (no network); after an
        // in-page SignIn recovery it re-authenticates and hands back a fresh jar.
        const cookies = await ensureAuthJar(this.auth());
        if (!page) page = await browser.newPage();
        return this.captureOn(page, cookies, input);
      },
      close: async (): Promise<void> => {
        await browser.close().catch(() => undefined);
      },
    };
  }

  /** Single capture: a session opened and closed around one shot. */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    const session = await this.openSession();
    try {
      return await session.capture(input);
    } finally {
      await session.close();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async captureOn(p: any, cookies: unknown[], input: CaptureInput): Promise<CaptureResult> {
    const started = Date.now();
    try {
      const r = await this.captureInner(p, cookies, input);
      this.metrics?.recordScreenshot(true, Date.now() - started);
      return r;
    } catch (e) {
      this.metrics?.recordScreenshot(false, Date.now() - started);
      throw e;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async captureInner(p: any, cookies: unknown[], input: CaptureInput): Promise<CaptureResult> {
    const pageId = String(input.pageId).trim();
    const company = input.company || this.getCompany();
    const url = deepLinkPage(this.config, pageId, input.bookmark, company);
    this.logger.info(`[screenshot] capturing ${url}`);

    const width = input.width ?? 1600;
    const height = input.height ?? 1000;
    await p.setViewport({ width, height, deviceScaleFactor: input.scale ?? 2 });
    await p.setCookie(...cookies);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Fallback: if cookie injection didn't take, log in once via the bounced
    // SignIn form (its ReturnUrl is our deep link, so BC redirects right back).
    await recoverIfOnSignIn(p, this.auth(), this.config, this.logger, { tag: 'screenshot' });

    const spaReady = await waitReady(p);

    // Explicit reveal: expand all collapsed FastTabs + click all "Show more" up front.
    if (input.expand) {
      await this.revealAll(p);
      await sleep(800); // let the relayout settle before locating controls
    }

    // G6: explicit toggles. They run after the `expand` reveal pass (so a caption
    // that pass already opened is not toggled shut again) but BEFORE the automatic
    // reveal-when-needed retry below, which only fires if a target is still missing.
    if (input.clickBeforeCapture?.length) {
      for (const caption of input.clickBeforeCapture) {
        const hit = await this.clickByCaption(p, caption);
        this.logger.info(`[screenshot] clickBeforeCapture "${caption}" -> ${hit ? 'clicked' : 'NOT FOUND'}`);
        await sleep(600);
      }
    }

    // Redacted captions are just blur-style annotations, appended AFTER the
    // requested ones — the split below relies on that order.
    const requested = input.annotations ?? [];
    const redactTargets = input.redact ?? [];
    const annos: Annotation[] = [
      ...requested,
      ...redactTargets.map((t) => ({ target: t, style: 'blur' as const })),
    ];
    const cropTargets = input.crop ?? [];

    let annotations: CaptureResult['annotations'];
    let redactions: CaptureResult['redactions'];
    let clip: Rect | undefined;
    if (annos.length || cropTargets.length) {
      // BC content scrolls INSIDE an iframe, so a control below the fold (common once a
      // FastTab/Show-more is revealed) is off-screen in the capture. Scroll the primary
      // target into view so its callout/crop actually lands in the screenshot.
      const scrollTarget = input.annotations?.[0]?.target ?? cropTargets[0];
      let res = await this.annotate(p, annos, cropTargets, width, height, scrollTarget);
      // Reveal-when-needed: a requested callout/crop target that wasn't found may be
      // hidden behind a collapsed FastTab or a "Show more" toggle. Expand once and retry.
      const missing = res.annotations.some((a) => !a.found) || (cropTargets.length > 0 && !res.clip);
      if (missing && !input.expand) {
        this.logger.info('[screenshot] target(s) not found — expanding groups / Show more and retrying');
        await this.revealAll(p);
        await sleep(800);
        res = await this.annotate(p, annos, cropTargets, width, height, scrollTarget);
      }
      if (requested.length) annotations = res.annotations.slice(0, requested.length);
      // The redaction outcomes used to be sliced off and thrown away, so a caption
      // that matched nothing shipped a PNG with the sensitive value still visible
      // and a result that looked perfectly clean.
      if (redactTargets.length) redactions = res.annotations.slice(requested.length);
      clip = res.clip;
      await sleep(300); // let any scroll-into-view settle before the capture
    }

    const file = this.resolveOut(input.out, pageId);
    const buf: Uint8Array = await p.screenshot({
      path: file,
      ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h } } : { fullPage: input.fullPage ?? false }),
    });
    const pageTitle = await p.title();
    const authenticated = !(await onSignIn(p));

    const missedRedactions = (redactions ?? []).filter((r) => !r.found).map((r) => r.target);
    let warning: string | undefined;
    if (missedRedactions.length) {
      warning = `REDACTION FAILED: [${missedRedactions.join(', ')}] matched no control, so ${file} may still `
        + 'SHOW those values. Do not share this image. Check the caption exactly as the page renders it '
        + '(locale-dependent), or crop the area out.';
      this.logger.error(`[screenshot] ${warning}`);
    }

    return {
      path: file,
      url,
      pageTitle,
      authenticated,
      spaReady,
      annotations,
      redactions,
      ...(warning ? { warning } : {}),
      cropped: !!clip,
      width,
      height,
      base64: input.inline ? Buffer.from(buf).toString('base64') : undefined,
    };
  }

  // BC renders page content inside an iframe — search every frame for each control
  // (by aria-label, then exact text), draw its callout, and collect bounding boxes
  // (for crop). All caption-geometry based; no dependency on BC exposing DOM ids.
  private async annotate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p: any,
    annotations: Annotation[],
    cropTargets: string[],
    width: number,
    height: number,
    scrollTarget?: string,
  ): Promise<{ annotations: Array<{ target: string; found: boolean }>; clip?: Rect }> {
    // Runs inside each frame: draws annotations, returns found-rects + crop-rects.
    // NOTE: must contain NO named nested functions (no `const f = () => {}`) — under
    // tsx/esbuild those get wrapped with a `__name` helper that is undefined in the
    // browser. Only anonymous arrows passed inline to .map are safe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inFrame = (spec: { annotations: Annotation[]; cropTargets: string[]; scrollTarget?: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // Clear annotations drawn by a previous pass so a retry never double-draws.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Array.prototype.slice.call(doc.querySelectorAll('[data-bcmcp]')).forEach((n: any) => n.remove());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all: any[] = Array.prototype.slice.call(doc.querySelectorAll('*'));
      // Scroll the primary target into view BEFORE measuring, so a revealed control below
      // the (iframe) fold lands inside the captured viewport. position:fixed callouts use
      // viewport-relative rects, so they stay aligned after the scroll.
      if (spec.scrollTarget) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let st: any = null;
        for (let i = 0; i < all.length; i++) {
          const ar = all[i].getAttribute('aria-label');
          if (ar && ar.trim() === spec.scrollTarget) { st = all[i]; break; }
        }
        if (!st) for (let i = 0; i < all.length; i++) {
          const tc = all[i].textContent;
          if (all[i].childElementCount === 0 && tc && tc.trim() === spec.scrollTarget) { st = all[i].closest('[class]') || all[i]; break; }
        }
        if (st && st.scrollIntoView) st.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      const Z = 2147483647;
      const pad = 6;

      const drawn = spec.annotations.map((a) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let el: any = null;
        for (let i = 0; i < all.length; i++) {
          const ar = all[i].getAttribute('aria-label');
          if (ar && ar.trim() === a.target) { el = all[i]; break; }
        }
        if (!el) for (let i = 0; i < all.length; i++) {
          const tc = all[i].textContent;
          if (all[i].childElementCount === 0 && tc && tc.trim() === a.target) { el = all[i].closest('[class]') || all[i]; break; }
        }
        if (!el) return { found: false, rect: null };
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return { found: false, rect: null };
        const style = a.style || 'box';
        if (style === 'blur') {
          const b = doc.createElement('div');
          b.setAttribute('data-bcmcp', '1');
          b.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:#cfd3da;border-radius:3px;z-index:${Z};pointer-events:none;`;
          doc.body.appendChild(b);
          return { found: true, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
        }
        const box = doc.createElement('div');
        box.setAttribute('data-bcmcp', '1');
        box.style.cssText = `position:fixed;left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;border:3px solid #e11;border-radius:4px;z-index:${Z};pointer-events:none;`;
        doc.body.appendChild(box);
        if (style === 'badge' && a.label) {
          const badge = doc.createElement('div');
          badge.setAttribute('data-bcmcp', '1');
          badge.textContent = a.label;
          badge.style.cssText = `position:fixed;left:${r.left - pad - 13}px;top:${r.top - pad - 13}px;width:24px;height:24px;border-radius:50%;background:#e11;color:#fff;font:bold 14px sans-serif;display:flex;align-items:center;justify-content:center;z-index:${Z};pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.4);`;
          doc.body.appendChild(badge);
        } else if (a.label) {
          const chip = doc.createElement('div');
          chip.setAttribute('data-bcmcp', '1');
          chip.textContent = a.label;
          chip.style.cssText = `position:fixed;left:${r.left - pad}px;top:${r.top - pad - 22}px;background:#e11;color:#fff;font:bold 12px sans-serif;padding:1px 6px;border-radius:3px;z-index:${Z};pointer-events:none;white-space:nowrap;`;
          doc.body.appendChild(chip);
        }
        if (style === 'arrow') {
          const line = doc.createElement('div');
          line.setAttribute('data-bcmcp', '1');
          line.style.cssText = `position:fixed;left:${r.left - pad - 50}px;top:${r.top + r.height / 2 - 1}px;width:50px;height:3px;background:#e11;z-index:${Z};pointer-events:none;`;
          doc.body.appendChild(line);
          const head = doc.createElement('div');
          head.setAttribute('data-bcmcp', '1');
          head.style.cssText = `position:fixed;left:${r.left - pad - 9}px;top:${r.top + r.height / 2 - 6}px;width:0;height:0;border-top:6px solid transparent;border-bottom:6px solid transparent;border-left:9px solid #e11;z-index:${Z};pointer-events:none;`;
          doc.body.appendChild(head);
        }
        return { found: true, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
      });

      const crops = spec.cropTargets.map((t) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let el: any = null;
        for (let i = 0; i < all.length; i++) {
          const ar = all[i].getAttribute('aria-label');
          if (ar && ar.trim() === t) { el = all[i]; break; }
        }
        if (!el) for (let i = 0; i < all.length; i++) {
          const tc = all[i].textContent;
          if (all[i].childElementCount === 0 && tc && tc.trim() === t) { el = all[i].closest('[class]') || all[i]; break; }
        }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width && r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      });

      return { drawn, crops };
    };

    const perFrame: Array<{ drawn: Array<{ found: boolean; rect: Rect | null }>; crops: Array<Rect | null> }> = [];
    for (const f of p.frames()) {
      try {
        perFrame.push(await f.evaluate(inFrame, { annotations, cropTargets, scrollTarget }));
      } catch (e) {
        // Cross-origin / empty frames are expected — keep this at debug level.
        this.logger.debug('screenshot', `annotate frame skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const annResults = annotations.map((a, i) => ({
      target: a.target,
      found: perFrame.some((fr) => fr.drawn[i]?.found),
    }));

    const cropRects: Rect[] = [];
    cropTargets.forEach((_, i) => {
      const rect = perFrame.map((fr) => fr.crops[i]).find((r): r is Rect => !!r);
      if (rect) cropRects.push(rect);
    });

    let clip: Rect | undefined;
    if (cropRects.length) {
      const pad = 16;
      const minX = Math.max(0, Math.min(...cropRects.map((r) => r.x)) - pad);
      const minY = Math.max(0, Math.min(...cropRects.map((r) => r.y)) - pad);
      const maxX = Math.min(width, Math.max(...cropRects.map((r) => r.x + r.w)) + pad);
      const maxY = Math.min(height, Math.max(...cropRects.map((r) => r.y + r.h)) + pad);
      if (maxX > minX && maxY > minY) clip = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return { annotations: annResults, clip };
  }

  // ---------- reveal hidden content (collapsed FastTabs + "Show more") ----------
  // Verified live against BC27 (devel1):
  //  - A collapsible FastTab/group header is `span.ms-nav-columns-caption[aria-expanded]`
  //    (sub-groups use `.ms-nav-group-caption[aria-expanded]`). aria-expanded is a clean
  //    state signal, so expanding = clicking the ones currently "false".
  //  - The "Show more"/"Show less" toggle is `button.show-more-fields-button`. It carries
  //    NO state attribute and its class is identical in both states; only the locale-bound
  //    caption/title flips. So state is detected by EFFECT: clicking it while collapsed
  //    reveals fields (visible-node count rises); if the count drops we just collapsed an
  //    already-expanded tab and click again to undo. This stays locale-independent.
  // Both steps are independent: expanding a FastTab shows its standard fields, while the
  // additional ("Importance = Additional") fields stay hidden until Show more is clicked.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /**
   * G6: click the first VISIBLE control whose visible text or aria-label matches
   * `caption` (exact, then prefix), across every frame. Returns true when something
   * was clicked. The in-browser callback holds NO named nested functions — tsx/esbuild
   * wraps those in a `__name` helper that does not exist in the page.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async clickByCaption(p: any, caption: string): Promise<boolean> {
    for (const f of p.frames()) {
      try {
        const hit: boolean = await f.evaluate((want: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = (globalThis as any).document;
          const els = doc.querySelectorAll('button,[role="button"],a,[aria-expanded],[class*="caption"],[class*="header"],summary');
          const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const target = norm(want);
          let prefixHit: { click: () => void } | null = null;
          for (let i = 0; i < els.length; i++) {
            const el = els[i];
            const visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
            if (!visible) continue;
            const text = norm(el.textContent || '');
            const label = norm(el.getAttribute('aria-label') || '');
            if (text === target || label === target) { el.click(); return true; }
            if (!prefixHit && (text.indexOf(target) === 0 || label.indexOf(target) === 0)) prefixHit = el;
          }
          if (prefixHit) { prefixHit.click(); return true; }
          return false;
        }, caption);
        if (hit) return true;
      } catch {
        // cross-origin / detached frame
      }
    }
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async revealAll(p: any): Promise<void> {
    for (const f of p.frames()) {
      try {
        // 1. Expand every collapsed section header. Loop because expanding one can
        //    surface nested collapsibles; bounded so a pathological page can't spin.
        //
        //    G6: this used to match ONLY `.ms-nav-columns-caption` /
        //    `.ms-nav-group-caption`, i.e. FastTabs and sub-groups. A document's
        //    LINES part ("Lines >") is a different header, so line-grid captions
        //    (Quantity, Line Amount, ...) were never revealed and every highlight or
        //    crop that named one came back found:false. Any caption-ish header that
        //    declares itself collapsed is now expanded, which covers the lines part
        //    and any future part header, while menus/dropdowns/dialogs are excluded
        //    so this never opens an unrelated popup.
        for (let pass = 0; pass < 6; pass++) {
          const clicked: number = await f.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc = (globalThis as any).document;
            const all = doc.querySelectorAll('[aria-expanded="false"]');
            let n = 0;
            for (let i = 0; i < all.length; i++) {
              const el = all[i];
              const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '');
              const looksLikeHeader = /caption|header|part|group|section|expander/i.test(cls);
              if (!looksLikeHeader) continue;
              // Never touch menus, dropdowns, comboboxes or anything inside a dialog:
              // "expanding" those opens a popup that covers the page we are capturing.
              const role = el.getAttribute('role') || '';
              if (/menuitem|menu|combobox|listbox|tab$/i.test(role)) continue;
              if (el.closest('[role="menu"],[role="dialog"],[role="listbox"],[class*="dropdown"],[class*="menu"]')) continue;
              const visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
              if (!visible) continue;
              el.click();
              n++;
            }
            return n;
          });
          if (!clicked) break;
          await sleep(300);
        }
        // 2. Click each "Show more" that is currently collapsed (detected by effect).
        //    The button list is re-queried after EVERY click: clicking one re-renders
        //    that part of the page, so a snapshotted count + index would drift onto a
        //    different button (or onto undefined, silently skipping it). Buttons are
        //    marked as handled with a private attribute instead of by position; the
        //    loop ends when no unmarked button is left. `data-bcmcp-more` deliberately
        //    does NOT match the `[data-bcmcp]` selector the annotator cleans up.
        await f.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = (globalThis as any).document;
          let prevPending = -1;
          let stale = 0;
          for (let guard = 0; guard < 40; guard++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const btns: any[] = Array.prototype.slice.call(doc.querySelectorAll('button.show-more-fields-button'));
            const pending = btns.filter((x) => !x.hasAttribute('data-bcmcp-more'));
            if (!pending.length) break;
            // If BC re-created the buttons, our marks are gone and the pending count
            // never falls: stop rather than toggling the same button forever.
            if (prevPending !== -1 && pending.length >= prevPending) {
              if (++stale >= 2) break;
            } else {
              stale = 0;
            }
            prevPending = pending.length;
            const b = pending[0];
            b.setAttribute('data-bcmcp-more', '1');
            const all1 = doc.querySelectorAll('*');
            let before = 0;
            for (let k = 0; k < all1.length; k++) if (all1[k].offsetParent !== null) before++;
            b.click();
            await new Promise((r) => setTimeout(r, 400));
            const all2 = doc.querySelectorAll('*');
            let after = 0;
            for (let k = 0; k < all2.length; k++) if (all2[k].offsetParent !== null) after++;
            // Fewer visible nodes -> that click COLLAPSED an already-expanded tab; undo it.
            if (after < before) {
              b.click();
              await new Promise((r) => setTimeout(r, 250));
            }
          }
        });
      } catch (e) {
        // Cross-origin / empty frames are expected — keep this at debug level.
        this.logger.debug('screenshot', `reveal frame skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ---------- output path ----------
  private resolveOut(out: string | undefined, pageId: string): string {
    const dir = isAbsolute(this.screenshotDir) ? this.screenshotDir : resolve(process.cwd(), this.screenshotDir);
    let file: string;
    if (out) {
      file = isAbsolute(out) ? out : resolve(dir, out);
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      file = resolve(dir, `page-${pageId}-${stamp}.png`);
    }
    mkdirSync(resolve(file, '..'), { recursive: true });
    return file;
  }
}
