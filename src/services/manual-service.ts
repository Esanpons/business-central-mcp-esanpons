import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ScreenshotService, ScreenshotSession, CaptureResult } from './screenshot-service.js';
import { normalizeHighlight, type HighlightInput } from '../operations/screenshot.js';
import {
  renderMarkdown, pngSize,
  type ManualModel, type ManualStepModel, type ManualImage,
} from './manual-render.js';
import { renderHtmlDocument, type ManualAssets } from './manual-html.js';
import { renderDocx } from './manual-docx.js';
import { measurePageBreaks, type PageBreakMap } from './manual-paginate.js';
import type { Metrics } from './metrics.js';

export interface ManualScreenshotSpec {
  pageId: string | number;
  bookmark?: string;
  company?: string;
  highlight?: HighlightInput;
  redact?: string[];
  crop?: string | string[];
  expand?: boolean;
  /** Captions to click before capturing (e.g. ["Lines"]). Same semantics as bc_screenshot. */
  clickBeforeCapture?: string[];
  width?: number;
  height?: number;
  scale?: number;
}

export interface ManualStepInput {
  heading: string;
  /** Prose above the figure. */
  body?: string;
  /** Prose BELOW the figure. */
  after?: string;
  /** Capture a fresh annotated screenshot for this step. */
  screenshot?: ManualScreenshotSpec;
  /** Or reference an already-captured image (absolute, or relative to the manual dir). */
  image?: string;
  /** Figure caption rendered under the image (<figcaption> in HTML, italic line in .md). */
  caption?: string;
}

export type ManualFormat = 'md' | 'html' | 'docx';

export interface BuildManualInput {
  title: string;
  intro?: string;
  steps: ManualStepInput[];
  formats?: ManualFormat[];
  outDir?: string;
  name?: string;
  /** HTML only: self-contained single file (default) or separate .css/.js/PNG files. */
  assets?: ManualAssets;
  /** HTML/DOCX: language of the generated chrome (cover, index, footer). Default `ca`. */
  lang?: string;
  /** HTML/DOCX: emit a cover sheet. Default true. */
  cover?: boolean;
  /** HTML/DOCX: emit an index sheet. Default: only from 4 steps up. */
  toc?: boolean;
}

export interface BuildManualOutput {
  md?: string;
  html?: string;
  docx?: string;
  /** Only when HTML was built with `assets: "files"`. */
  css?: string;
  js?: string;
  /** Every image the document references (captured this run or referenced by path). */
  images: string[];
  steps: number;
  /**
   * Per-step problems found while building. A manual can be written successfully
   * from captures that missed their callouts, failed a redaction or caught a
   * half-loaded page — this is the only signal that a step should be re-shot, so
   * NEVER treat a returned document as proof the steps are good. Absent = clean.
   */
  warnings?: string[];
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'manual';
}

/**
 * Builds a step-by-step manual from a list of steps. For each step with a screenshot
 * spec it captures an annotated PNG (reusing ScreenshotService), then renders the whole
 * document to the requested formats. Additive and out-of-band.
 *
 * Three outputs share one authoring model: `md` (plain Markdown, images linked),
 * `html` (a printable A4 web page -- open it and Ctrl+P for a paged PDF) and
 * `docx` (an editable Word document). The Word output is derived FROM the HTML:
 * the page is paginated in the headless browser and the measured breaks are
 * replayed into the .docx, so all three tell the same story and the printed
 * pages match.
 */
export class ManualService {
  constructor(
    private readonly screenshot: ScreenshotService,
    private readonly manualDir: string,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
  ) {}

  async build(input: BuildManualInput): Promise<BuildManualOutput> {
    const started = Date.now();
    try {
      const out = await this.buildInner(input);
      this.metrics?.recordManualBuild(true, Date.now() - started);
      return out;
    } catch (e) {
      this.metrics?.recordManualBuild(false, Date.now() - started);
      throw e;
    }
  }

  /** Diagnostics a single capture produced, as human-readable warnings. */
  private captureWarnings(step: number, heading: string, r: CaptureResult): string[] {
    const w: string[] = [];
    const at = `Step ${step} ("${heading}")`;
    if (r.warning) w.push(`${at}: ${r.warning}`);
    const missedAnn = (r.annotations ?? []).filter((a) => !a.found).map((a) => a.target);
    if (missedAnn.length) {
      w.push(`${at}: highlight caption(s) [${missedAnn.join(', ')}] matched no control — the image has `
        + 'NO callout for them. Check the caption exactly as the page renders it (locale-dependent).');
    }
    if (!r.spaReady) {
      w.push(`${at}: the BC page never reported ready (spaReady=false) — the capture may show a `
        + 'half-loaded page. Re-shoot this step.');
    }
    return w;
  }

  private async buildInner(input: BuildManualInput): Promise<BuildManualOutput> {
    const formats: ManualFormat[] = input.formats && input.formats.length ? input.formats : ['md'];
    const slug = slugify(input.name || input.title);
    const baseDir = isAbsolute(this.manualDir) ? this.manualDir : resolve(process.cwd(), this.manualDir);
    const dir = input.outDir ? (isAbsolute(input.outDir) ? input.outDir : resolve(baseDir, input.outDir)) : baseDir;
    const imgDir = resolve(dir, `${slug}-img`);
    mkdirSync(imgDir, { recursive: true });

    const stepModels: ManualStepModel[] = [];
    const images: string[] = [];
    const warnings: string[] = [];
    // ONE browser for the whole manual. Opened lazily so a manual assembled purely
    // from existing images never launches Chrome at all.
    let session: ScreenshotSession | undefined;
    try {
      for (let i = 0; i < input.steps.length; i++) {
        const st = input.steps[i];
        if (!st) continue;
        let absImg: string | undefined;
        if (st.screenshot) {
          const s = st.screenshot;
          const out = resolve(imgDir, `step-${i + 1}.png`);
          if (!session) session = await this.screenshot.openSession();
          const res = await session.capture({
            pageId: String(s.pageId),
            bookmark: s.bookmark,
            company: s.company,
            annotations: normalizeHighlight(s.highlight),
            redact: s.redact,
            crop: s.crop === undefined ? undefined : Array.isArray(s.crop) ? s.crop : [s.crop],
            expand: s.expand,
            clickBeforeCapture: s.clickBeforeCapture,
            width: s.width,
            height: s.height,
            scale: s.scale,
            out,
            inline: false,
          });
          warnings.push(...this.captureWarnings(i + 1, st.heading, res));
          absImg = out;
        } else if (st.image) {
          absImg = isAbsolute(st.image) ? st.image : resolve(dir, st.image);
          if (!existsSync(absImg)) {
            warnings.push(`Step ${i + 1} ("${st.heading}"): referenced image "${st.image}" does not exist `
              + `(resolved to ${absImg}) — the step was written WITHOUT a figure.`);
          }
        }

        let image: ManualImage | undefined;
        if (absImg && existsSync(absImg)) {
          const buf = readFileSync(absImg);
          const { width, height } = pngSize(buf);
          image = {
            absPath: absImg,
            relPath: relative(dir, absImg),
            ...(width && height ? { width, height } : {}),
            ...(st.caption ? { caption: st.caption } : {}),
          };
          // Referenced images belong in the output list too: the caller needs the
          // full set of files the document depends on (to copy/ship it).
          images.push(absImg);
        } else if (absImg && st.screenshot) {
          warnings.push(`Step ${i + 1} ("${st.heading}"): the capture returned without writing ${absImg} — `
            + 'the step was written WITHOUT a figure.');
        }
        stepModels.push({ heading: st.heading, body: st.body, after: st.after, image });
      }
    } finally {
      if (session) await session.close();
    }

    const model: ManualModel = { title: input.title, intro: input.intro, steps: stepModels };
    const out: BuildManualOutput = { images, steps: stepModels.length };

    if (formats.includes('md')) {
      const p = resolve(dir, `${slug}.md`);
      writeFileSync(p, renderMarkdown(model));
      out.md = p;
    }
    if (formats.includes('html')) {
      const doc = renderHtmlDocument(model, {
        assets: input.assets ?? 'inline',
        lang: input.lang,
        cover: input.cover,
        toc: input.toc,
        assetBase: slug,
      });
      const p = resolve(dir, `${slug}.html`);
      writeFileSync(p, doc.html, 'utf8');
      out.html = p;
      if (doc.css !== undefined) {
        const c = resolve(dir, `${slug}.css`);
        writeFileSync(c, doc.css, 'utf8');
        out.css = c;
      }
      if (doc.js !== undefined) {
        const j = resolve(dir, `${slug}.js`);
        writeFileSync(j, doc.js, 'utf8');
        out.js = j;
      }
    }

    if (formats.includes('docx')) {
      const p = resolve(dir, `${slug}.docx`);
      const doc = await renderDocx(model, {
        lang: input.lang,
        cover: input.cover,
        toc: input.toc,
        breaks: await this.measureBreaks(model, input, warnings),
      });
      writeFileSync(p, doc.buffer);
      out.docx = p;
      warnings.push(...doc.warnings);
    }

    // Collected across all three renderers, so a figure that only the Word
    // output had to drop is still reported.
    if (warnings.length) {
      out.warnings = warnings;
      for (const w of warnings) this.logger.warn(`[manual] ${w}`);
    }

    this.logger.info(`[manual] built "${input.title}" (${out.steps} steps) -> ${[out.md, out.html, out.docx].filter(Boolean).join(', ')}`);
    return out;
  }

  /**
   * Measures the A4 page breaks by paginating the real HTML in the headless browser.
   *
   * This is what makes the Word output break where the printed HTML breaks: the
   * browser is the only thing that knows how tall a rendered step actually is,
   * and Word will not measure anything for us (see `manual-paginate.ts`).
   *
   * A missing browser must not cost the caller their manual, so a failure here
   * degrades to the declarative layout (one step per page, headings kept with
   * their figure) and says so in the warnings rather than throwing.
   */
  private async measureBreaks(
    model: ManualModel,
    input: BuildManualInput,
    warnings: string[],
  ): Promise<PageBreakMap | undefined> {
    try {
      const { html } = renderHtmlDocument(model, {
        assets: 'inline',
        lang: input.lang,
        cover: input.cover,
        toc: input.toc,
      });
      return await measurePageBreaks(html);
    } catch (e) {
      warnings.push('The Word page breaks could not be measured in the browser '
        + `(${e instanceof Error ? e.message : String(e)}) -- the .docx was written with Word choosing `
        + 'its own breaks, so its pages may not match the HTML/PDF.');
      return undefined;
    }
  }
}
