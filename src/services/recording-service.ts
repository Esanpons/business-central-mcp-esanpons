import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';
import { launchHeadless } from './browser.js';
import { ensureAuthJar, detectLoginWall, looksLikeBusinessCentral } from './bc-web-auth.js';
import {
  ScreenshotService, stepWarnings,
  type ScreenshotStep, type StepOutcome, type StepModifier,
} from './screenshot-service.js';
import { resolveFfmpeg } from './ffmpeg.js';
import { Screencast } from './screencast.js';
import type { Metrics } from './metrics.js';

/**
 * RecordingService — records a VIDEO (MP4) of the BC web client while a sequence
 * of real browser interactions is performed, the way a person would do them.
 *
 * It is the screenshot engine with a camera on: same authenticated headless
 * browser, same deep link, same `steps` (so a circuit that photographs well
 * records well), but every step is performed through a VISIBLE cursor that
 * glides to its target, clicks with a ripple, types at a human pace, and a
 * caption strip names what is happening. The tab is captured through CDP and
 * encoded by ffmpeg in one pass (`Screencast`), H.264 MP4 by default -- the one
 * container everything plays (Windows' own player, Teams, PowerPoint, a browser).
 *
 * Out-of-band like bc_screenshot: nothing here touches the WebSocket session.
 *
 * Two deliberate consequences of "it is a real browser":
 * - A step that changes data CHANGES it (the recording is of the real client);
 *   the browser is discarded afterwards, so unsaved edits are not committed
 *   unless a step presses the confirming button.
 * - Headless Chrome paints no pointer. The cursor in the video is an overlay in
 *   the top document, moved in lockstep with the real mouse so hover states and
 *   the picture agree.
 */

export interface RecordInput {
  pageId: string;
  bookmark?: string;
  company?: string;
  /** The circuit. Each step may carry `label` for the on-screen caption. */
  steps: ScreenshotStep[];
  /** Title card shown during `intro`. Default: none (a plain recording). */
  title?: string;
  /** Show the per-step caption strip (default false: a plain recording). */
  captions?: boolean;
  /** Draw the cursor overlay (default true). */
  cursor?: boolean;
  /** Pause after every step, ms (default 1200). A `wait` step is its own pause. */
  pace?: number;
  /** Keyboard delay per typed character, ms (default 70). 0 pastes. */
  typingDelay?: number;
  /** Longest a cursor move may take, ms (default 1100; the shortest is a third of it). 0 jumps. */
  glide?: number;
  /** Multiplier applied to every timing above AND to `wait` steps: 2 = twice as fast, 0.5 = half (default 1). */
  speed?: number;
  /** After each step, wait until the page has been quiet (no DOM change) for 250 ms, up to this many ms (default 8000). 0 disables. */
  settle?: number;
  /** Hold on the opened page before the first step, ms (default 1500). */
  intro?: number;
  /** Hold on the final state before stopping, ms (default 1500). */
  outro?: number;
  out?: string;
  width?: number;
  height?: number;
  fps?: number;
  format?: 'mp4' | 'webm';
  expand?: boolean;
  dismissTeachingTips?: boolean;
}

/** One step as it went into the video: outcome plus WHEN (ms from the start). */
export interface RecordedStep extends StepOutcome {
  index: number;
  /** The caption shown (the step's `label`, else its description). */
  label: string;
  /** Milliseconds from the start of the video at which the step began. */
  atMs: number;
}

export interface RecordResult {
  path: string;
  /** JSON sidecar: the same steps with their timestamps, for subtitles / narration / editing. */
  timelinePath: string;
  url: string;
  pageTitle: string;
  authenticated: true;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  format: 'mp4' | 'webm';
  steps: RecordedStep[];
  /** Same contract as bc_screenshot: a step that did nothing is named here, never dropped. */
  warning?: string;
}

/** Timeline written next to the video (`<video>.json`). */
export interface RecordingTimeline {
  video: string;
  pageId: string;
  url: string;
  company?: string;
  recordedAt: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  steps: RecordedStep[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Ease-in-out cubic: a hand accelerates, then settles on the target. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * The points a cursor passes through from (x0,y0) to (x1,y1): one per animation
 * frame, eased, with a slight arc so the path does not read as a ruler line.
 * Duration grows with distance but stays within what a viewer can follow.
 * Pure, so the unit test can assert it.
 */
export function glidePath(
  x0: number, y0: number, x1: number, y1: number, frameMs = 16, maxMs = 1100,
): Array<{ x: number; y: number; dt: number }> {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1 || maxMs <= 0) return [];
  // 350..1100 ms at the default cap; a smaller cap scales the whole range down.
  const durationMs = clamp((280 + dist * 0.8) * (maxMs / 1100), maxMs / 3, maxMs);
  const frames = Math.max(2, Math.round(durationMs / frameMs));
  // Perpendicular bow: 6% of the distance, capped, so a long move curves gently.
  // Its side depends on the direction of travel, so successive moves do not all
  // bend the same way (that uniformity is what reads as mechanical).
  const side = (dx >= 0) === (dy >= 0) ? 1 : -1;
  const bow = Math.min(dist * 0.06, 40) * side;
  const nx = -dy / dist;
  const ny = dx / dist;
  const out: Array<{ x: number; y: number; dt: number }> = [];
  for (let i = 1; i <= frames; i++) {
    const t = easeInOut(i / frames);
    const arc = Math.sin(Math.PI * t) * bow;
    out.push({ x: x0 + dx * t + nx * arc, y: y0 + dy * t + ny * arc, dt: frameMs });
  }
  // A hand overshoots a little and comes back: 2% of the distance (at most 10 px)
  // past the target over four frames, then the last frame lands exactly on it.
  const over = Math.min(dist * 0.02, 10);
  if (over >= 1 && frames >= 8) {
    const ux = dx / dist;
    const uy = dy / dist;
    for (const k of [0.6, 1, 0.5]) out.push({ x: x1 + ux * over * k, y: y1 + uy * over * k, dt: frameMs });
    out.push({ x: x1, y: y1, dt: frameMs });
  }
  return out;
}

/**
 * The overlay lives in the TOP document (BC content is in an iframe; a fixed
 * element above it covers everything). Plain JS strings, never serialized
 * functions: under tsx/esbuild a nested named function gets a `__name` wrapper
 * that does not exist in the browser (same lesson as the annotator).
 */
const OVERLAY_ENSURE = `
(function () {
  var d = document;
  if (d.getElementById('__bcrec')) return;
  var root = d.createElement('div');
  root.id = '__bcrec';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:"Segoe UI",system-ui,sans-serif;';
  root.innerHTML =
    '<div id="__bcrec_cur" style="position:absolute;left:0;top:0;width:30px;height:30px;display:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))">'
    + '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2 L4 20 L9 15.5 L12.5 22 L15.5 20.5 L12 14 L19 14 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg></div>'
    + '<div id="__bcrec_rip" style="position:absolute;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:3px solid #e3342f;opacity:0"></div>'
    + '<div id="__bcrec_ban" style="position:absolute;left:50%;bottom:34px;transform:translateX(-50%);max-width:72%;padding:12px 24px;border-radius:10px;background:rgba(18,18,18,.86);color:#fff;font-size:24px;line-height:1.3;opacity:0;transition:opacity .25s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>'
    + '<div id="__bcrec_ttl" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);opacity:0;transition:opacity .3s">'
    + '<div style="padding:28px 48px;border-radius:14px;background:rgba(255,255,255,.96);color:#1b1b1b;font-size:40px;font-weight:600;max-width:80%;text-align:center"></div></div>';
  d.body.appendChild(root);
})();
`;

export class RecordingService extends ScreenshotService {
  /** A person types at roughly this pace; 15 ms (the screenshot default) is a paste. */
  protected override typingDelayMs = 70;
  protected override logTag = 'record';

  private pointer = { x: 0, y: 0 };
  private run?: {
    cast: Screencast;
    pace: number;
    glide: number;
    speed: number;
    settle: number;
    captions: boolean;
    cursor: boolean;
    marks: Array<{ index: number; label: string; atMs: number }>;
  };

  constructor(
    config: BCConfig,
    private readonly recordingDir: string,
    getCompany: () => string | undefined,
    logger: Logger,
    authProvider?: IBCAuthProvider,
    metrics?: Metrics,
  ) {
    super(config, recordingDir, getCompany, logger, authProvider, metrics);
  }

  async record(input: RecordInput): Promise<RecordResult> {
    const started = Date.now();
    try {
      const r = await this.recordInner(input);
      this.metrics?.recordRecording(true, Date.now() - started);
      return r;
    } catch (e) {
      this.metrics?.recordRecording(false, Date.now() - started);
      throw e;
    }
  }

  private async recordInner(input: RecordInput): Promise<RecordResult> {
    // Fail on a missing encoder BEFORE a browser is launched and a page opened.
    const ffmpeg = resolveFfmpeg();
    const width = Math.round(input.width ?? 1920);
    const height = Math.round(input.height ?? 1080);
    const fps = clamp(Math.round(input.fps ?? 30), 10, 60);
    const format = input.format ?? 'mp4';
    const speed = clamp(input.speed ?? 1, 0.1, 20);
    const pace = clamp(input.pace ?? 1200, 0, 10000) / speed;
    const glide = clamp(input.glide ?? 1100, 0, 5000) / speed;
    this.typingDelayMs = Math.round(clamp(input.typingDelay ?? 70, 0, 1000) / speed);
    this.waitScale = speed;
    const settle = clamp(input.settle ?? 8000, 0, 60000);
    const intro = clamp(input.intro ?? 1500, 0, 10000);
    const outro = clamp(input.outro ?? 1500, 0, 10000);
    const file = this.resolveRecordingOut(input.out, input.pageId, format);
    // The encoder writes to a sibling temp name and the file is moved into place
    // only when the run has been judged good, so a failed recording never
    // replaces a previous video at the same path (the bc_screenshot F-10 lesson).
    const partial = `${file}.part.${format}`;

    const browser = await launchHeadless();
    let cast: Screencast | undefined;
    let done = false;
    try {
      const p = await browser.newPage();
      const cookies = await ensureAuthJar(this.auth());
      const opened = await this.openPage(p, cookies, {
        pageId: input.pageId, bookmark: input.bookmark, company: input.company,
        width, height, scale: 1,
        dismissTeachingTips: input.dismissTeachingTips, expand: input.expand,
      }, 'record');

      await p.evaluate(OVERLAY_ENSURE);
      // Park the pointer somewhere neutral, visible from the first frame.
      this.pointer = { x: Math.round(width * 0.5), y: Math.round(height * 0.6) };
      await p.mouse.move(this.pointer.x, this.pointer.y);
      const wantCursor = input.cursor !== false;
      if (wantCursor) await this.drawCursorNow(p, this.pointer.x, this.pointer.y);

      this.logger.info(`[record] recording ${opened.url} -> ${file} (${width}x${height}@${fps} ${format})`);
      cast = await Screencast.start(p, { ffmpeg, path: partial, width, height, fps, format });
      this.run = { cast, pace, glide, speed, settle, captions: input.captions === true, cursor: wantCursor, marks: [] };

      // Title card only when asked for: a plain recording has no chrome at all.
      const title = input.title ?? '';
      if (intro > 0) {
        if (title) await this.showTitle(p, title);
        await sleep(intro);
        if (title) await this.hideTitle(p);
        await sleep(350);
      }

      const outcomes = await this.runSteps(p, input.steps);

      await this.showBanner(p, undefined);
      await sleep(outro);

      const pageTitle = await p.title();
      const wall = await detectLoginWall(p);
      const looksBC = await looksLikeBusinessCentral(p);

      const stats = await cast.stop();
      cast = undefined;

      if (wall) {
        throw new Error(
          `The browser session expired while recording page ${input.pageId}: it ended on the `
          + `${wall === 'entra' ? 'Microsoft Entra' : 'Business Central'} sign-in form (title: "${pageTitle}"). `
          + 'Nothing was written. '
          + (wall === 'entra' ? 'Run `npm run login:aad` once and retry.' : 'Check BC_USERNAME / BC_PASSWORD and retry.'),
        );
      }

      const steps: RecordedStep[] = outcomes.map((o, i) => ({
        index: i + 1,
        label: this.run?.marks[i]?.label ?? o.step,
        atMs: this.run?.marks[i]?.atMs ?? stats.durationMs,
        ...o,
      }));

      if (existsSync(file)) unlinkSync(file);
      renameInPlace(partial, file);
      done = true;

      const timelinePath = `${file}.json`;
      const timeline: RecordingTimeline = {
        video: file, pageId: input.pageId, url: opened.url, company: opened.company,
        recordedAt: new Date().toISOString(), width, height, fps, durationMs: stats.durationMs, steps,
      };
      writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));

      const warnings = stepWarnings(outcomes).map((w) => w.replace(/The image shows/g, 'The video shows'));
      if (!looksBC) {
        warnings.push(`The recorded page does not look like the Business Central web client (title: "${pageTitle}"). Watch the video before using it.`);
      }
      const warning = warnings.length ? warnings.join(' | ') : undefined;
      if (warning) this.logger.error(`[record] ${warning}`);
      this.logger.info(
        `[record] wrote ${file} (${Math.round(stats.durationMs / 100) / 10}s, ${stats.frames} frames, `
        + `${stats.captured} repaints, ${steps.length} steps)`,
      );

      return {
        path: file, timelinePath, url: opened.url, pageTitle, authenticated: true,
        durationMs: stats.durationMs, width, height, fps, format, steps, ...(warning ? { warning } : {}),
      };
    } finally {
      this.run = undefined;
      if (cast) await cast.abort().catch(() => undefined);
      await browser.close().catch(() => undefined);
      if (!done && existsSync(partial)) { try { unlinkSync(partial); } catch { /* best effort */ } }
    }
  }

  // ---------- hooks: what makes a recording look like a person ----------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected override async beforeStep(p: any, step: ScreenshotStep, index: number): Promise<void> {
    if (!this.run) return;
    const label = step.label ?? this.describeStep(step);
    this.run.marks[index] = { index: index + 1, label, atMs: this.run.cast.elapsedMs() };
    // An unlabelled wait is a pause in the CURRENT step, not a step the viewer
    // should read ("wait 1500ms" on screen is noise): keep the strip as it is.
    if (this.run.captions && !(step.wait !== undefined && step.label === undefined)) {
      await this.showBanner(p, label);
      await sleep(250 / this.run.speed);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected override async settleAfterStep(p: any, step: ScreenshotStep): Promise<void> {
    // A navigation threw the overlay away with the old document: draw it again.
    if (step.goto !== undefined) await this.drawCursor(p, this.pointer.x, this.pointer.y);
    // A `wait` step already slept for its own duration inside runSteps.
    if (step.wait === undefined && this.run) {
      if (this.run.settle > 0) await this.waitQuiet(p, 250, this.run.settle);
      await sleep(this.run.pace);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected override async clickHandle(p: any, handle: any, modifiers?: StepModifier[]): Promise<void> {
    const pt = await this.aim(handle);
    if (!pt) {
      // Not measurable (detached, zero-size): let puppeteer do what it can.
      await super.clickHandle(p, handle, modifiers);
      return;
    }
    await this.glideTo(p, pt.x, pt.y);
    // BC's grid scrolls back while the cursor is on its way (measured: "5" meant
    // for Quantity landed in Description). Bring the cell back under the cursor
    // right before pressing, and follow it if it settled a few pixels away.
    const again = await this.visibleCentre(handle, true).catch(() => null);
    const target = again ?? pt;
    if (Math.abs(target.x - pt.x) > 1 || Math.abs(target.y - pt.y) > 1) {
      await p.mouse.move(target.x, target.y);
      await this.drawCursor(p, target.x, target.y);
      this.pointer = { x: target.x, y: target.y };
      await sleep(60 / (this.run?.speed ?? 1));
    }
    const held = modifiers ?? [];
    try {
      for (const m of held) await p.keyboard.down(m);
      await this.ripple(p, target.x, target.y);
      await p.mouse.down();
      await sleep(80 / (this.run?.speed ?? 1));
      await p.mouse.up();
    } finally {
      for (const m of [...held].reverse()) await p.keyboard.up(m).catch(() => undefined);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected override async hoverHandle(p: any, handle: any): Promise<void> {
    const pt = await this.aim(handle);
    if (!pt) {
      await super.hoverHandle(p, handle);
      return;
    }
    await this.glideTo(p, pt.x, pt.y);
  }

  /**
   * Centre of the element in top-level viewport coordinates (puppeteer adds the
   * iframe offsets), measured AFTER the page has stopped moving. A grid cell off
   * to the right makes BC scroll the grid horizontally when it is brought into
   * view, and a point measured before that scroll settled clicked the cell that
   * slid under it: "5" typed for Quantity landed in Description (measured on
   * devel1, 2026-10-20). The point is re-read until two readings agree.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async aim(handle: any): Promise<{ x: number; y: number } | undefined> {
    try {
      // Scroll the element's OWN scroll containers (BC's lines grid scrolls
      // horizontally inside the page), then measure the part of it that is really
      // visible: clipped by every overflow ancestor and by the frame's viewport.
      // puppeteer's clickablePoint ignores overflow clipping, so for a cell to the
      // right of the grid it answered a point over the FactBox pane (devel1).
      let prev: { x: number; y: number } | null = null;
      for (let i = 0; i < 6; i++) {
        const pt = await this.visibleCentre(handle, i === 0);
        if (pt && prev && Math.abs(pt.x - prev.x) < 1 && Math.abs(pt.y - prev.y) < 1) return pt;
        prev = pt;
        await sleep(80);
      }
      return prev ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Centre of the visible part of the element in TOP-LEVEL page coordinates, or
   * null when no part of it is visible. With `scroll`, the element is first
   * scrolled into view inside its own scroll containers (instant, nearest edge).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async visibleCentre(handle: any, scroll: boolean): Promise<{ x: number; y: number } | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const local = await handle.evaluate((el: any, doScroll: boolean) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = globalThis as any;
      // block:'center' keeps a grid row in the middle of the screen instead of on
      // its bottom edge (a line being filled at the very bottom reads badly).
      if (doScroll && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
      let up = el.parentElement;
      while (up) {
        const cs = win.getComputedStyle(up);
        if (/(auto|scroll|hidden)/.test(cs.overflowX + ' ' + cs.overflowY)) {
          const pr = up.getBoundingClientRect();
          x1 = Math.max(x1, pr.left); y1 = Math.max(y1, pr.top); x2 = Math.min(x2, pr.right); y2 = Math.min(y2, pr.bottom);
        }
        up = up.parentElement;
      }
      x1 = Math.max(x1, 0); y1 = Math.max(y1, 0);
      x2 = Math.min(x2, win.innerWidth); y2 = Math.min(y2, win.innerHeight);
      return x2 > x1 + 2 && y2 > y1 + 2 ? { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } : null;
    }, scroll);
    if (!local) return null;
    const off = await this.frameOffset(handle.frame.page(), handle.frame);
    return { x: Math.round(local.x + off.x), y: Math.round(local.y + off.y) };
  }

  /** Move the real mouse AND the drawn cursor along an eased path, frame by frame. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async glideTo(p: any, x: number, y: number): Promise<void> {
    const path = glidePath(this.pointer.x, this.pointer.y, x, y, 16, this.run?.glide ?? 1100);
    for (const pt of path) {
      await p.mouse.move(pt.x, pt.y);
      await this.drawCursor(p, pt.x, pt.y);
      await sleep(pt.dt);
    }
    if (path.length === 0) {
      await p.mouse.move(x, y);
      await this.drawCursor(p, x, y);
    }
    this.pointer = { x, y };
    await sleep(120 / (this.run?.speed ?? 1)); // a hand settles before it presses
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async drawCursor(p: any, x: number, y: number): Promise<void> {
    if (!this.run?.cursor) return;
    await this.drawCursorNow(p, x, y);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async drawCursorNow(p: any, x: number, y: number): Promise<void> {
    await p.evaluate(
      `${OVERLAY_ENSURE}(function(){var c=document.getElementById('__bcrec_cur');if(!c)return;`
      + `c.style.display='block';c.style.transform='translate(${Math.round(x) - 4}px,${Math.round(y) - 2}px)';})();`,
    ).catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async ripple(p: any, x: number, y: number): Promise<void> {
    if (!this.run?.cursor) return;
    await p.evaluate(
      `(function(){var r=document.getElementById('__bcrec_rip');if(!r)return;`
      + `r.style.left='${Math.round(x)}px';r.style.top='${Math.round(y)}px';`
      + `r.animate([{opacity:.95,transform:'scale(.35)'},{opacity:0,transform:'scale(1.25)'}],{duration:480,easing:'ease-out'});})();`,
    ).catch(() => undefined);
  }

  /** Show the caption strip with this text, or hide it when undefined. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async showBanner(p: any, text: string | undefined): Promise<void> {
    await p.evaluate(
      `${OVERLAY_ENSURE}(function(){var b=document.getElementById('__bcrec_ban');if(!b)return;`
      + (text === undefined
        ? 'b.style.opacity=\'0\';'
        : `b.textContent=${JSON.stringify(text)};b.style.opacity='1';`)
      + '})();',
    ).catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async showTitle(p: any, text: string): Promise<void> {
    await p.evaluate(
      `${OVERLAY_ENSURE}(function(){var t=document.getElementById('__bcrec_ttl');if(!t)return;`
      + `t.firstElementChild.textContent=${JSON.stringify(text)};t.style.opacity='1';})();`,
    ).catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async hideTitle(p: any): Promise<void> {
    await p.evaluate(
      `(function(){var t=document.getElementById('__bcrec_ttl');if(t)t.style.opacity='0';})();`,
    ).catch(() => undefined);
  }

  // ---------- output path ----------

  private resolveRecordingOut(out: string | undefined, pageId: string, format: 'mp4' | 'webm'): string {
    const dir = isAbsolute(this.recordingDir) ? this.recordingDir : resolve(process.cwd(), this.recordingDir);
    let file: string;
    if (out) {
      file = isAbsolute(out) ? out : resolve(dir, out);
      if (!file.toLowerCase().endsWith(`.${format}`)) file += `.${format}`;
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      file = resolve(dir, `page-${pageId}-${stamp}.${format}`);
    }
    mkdirSync(resolve(file, '..'), { recursive: true });
    return file;
  }
}

/** Same directory, so a plain rename is atomic and never crosses volumes. */
function renameInPlace(src: string, dst: string): void {
  renameSync(src, dst);
}
