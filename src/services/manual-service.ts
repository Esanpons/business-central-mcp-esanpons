import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ScreenshotService } from './screenshot-service.js';
import { normalizeHighlight, type HighlightInput } from '../operations/screenshot.js';
import { launchHeadless } from './browser.js';
import {
  renderMarkdown, renderHtml, renderPdf, renderDocx, pngSize,
  type ManualModel, type ManualStepModel, type ManualImage,
} from './manual-render.js';

export interface ManualScreenshotSpec {
  pageId: string | number;
  bookmark?: string;
  company?: string;
  highlight?: HighlightInput;
  redact?: string[];
  crop?: string | string[];
  expand?: boolean;
  width?: number;
  height?: number;
  scale?: number;
}

export interface ManualStepInput {
  heading: string;
  body?: string;
  /** Capture a fresh annotated screenshot for this step. */
  screenshot?: ManualScreenshotSpec;
  /** Or reference an already-captured image (absolute, or relative to the manual dir). */
  image?: string;
}

export interface BuildManualInput {
  title: string;
  intro?: string;
  steps: ManualStepInput[];
  formats?: Array<'md' | 'pdf' | 'docx'>;
  outDir?: string;
  name?: string;
}

export interface BuildManualOutput {
  md?: string;
  pdf?: string;
  docx?: string;
  images: string[];
  steps: number;
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'manual';
}

/**
 * Builds a step-by-step manual from a list of steps. For each step with a screenshot
 * spec it captures an annotated PNG (reusing ScreenshotService), then renders the whole
 * document to the requested formats (Markdown / PDF / DOCX). Additive and out-of-band.
 */
export class ManualService {
  constructor(
    private readonly screenshot: ScreenshotService,
    private readonly manualDir: string,
    private readonly logger: Logger,
  ) {}

  async build(input: BuildManualInput): Promise<BuildManualOutput> {
    const formats = (input.formats && input.formats.length ? input.formats : ['md', 'pdf', 'docx']) as Array<'md' | 'pdf' | 'docx'>;
    const slug = slugify(input.name || input.title);
    const baseDir = isAbsolute(this.manualDir) ? this.manualDir : resolve(process.cwd(), this.manualDir);
    const dir = input.outDir ? (isAbsolute(input.outDir) ? input.outDir : resolve(baseDir, input.outDir)) : baseDir;
    const imgDir = resolve(dir, `${slug}-img`);
    mkdirSync(imgDir, { recursive: true });

    const stepModels: ManualStepModel[] = [];
    const images: string[] = [];
    for (let i = 0; i < input.steps.length; i++) {
      const st = input.steps[i];
      if (!st) continue;
      let absImg: string | undefined;
      if (st.screenshot) {
        const s = st.screenshot;
        const out = resolve(imgDir, `step-${i + 1}.png`);
        await this.screenshot.capture({
          pageId: String(s.pageId),
          bookmark: s.bookmark,
          company: s.company,
          annotations: normalizeHighlight(s.highlight),
          redact: s.redact,
          crop: s.crop === undefined ? undefined : Array.isArray(s.crop) ? s.crop : [s.crop],
          expand: s.expand,
          width: s.width,
          height: s.height,
          scale: s.scale,
          out,
          inline: false,
        });
        absImg = out;
        images.push(out);
      } else if (st.image) {
        absImg = isAbsolute(st.image) ? st.image : resolve(dir, st.image);
      }

      let image: ManualImage | undefined;
      if (absImg && existsSync(absImg)) {
        const buf = readFileSync(absImg);
        const { width, height } = pngSize(buf);
        image = { absPath: absImg, relPath: relative(dir, absImg), width, height };
      }
      stepModels.push({ heading: st.heading, body: st.body, image });
    }

    const model: ManualModel = { title: input.title, intro: input.intro, steps: stepModels };
    const out: BuildManualOutput = { images, steps: stepModels.length };

    if (formats.includes('md')) {
      const p = resolve(dir, `${slug}.md`);
      writeFileSync(p, renderMarkdown(model));
      out.md = p;
    }
    if (formats.includes('docx')) {
      const p = resolve(dir, `${slug}.docx`);
      writeFileSync(p, await renderDocx(model));
      out.docx = p;
    }
    if (formats.includes('pdf')) {
      const browser = await launchHeadless();
      try {
        const pdf = await renderPdf(browser, renderHtml(model));
        const p = resolve(dir, `${slug}.pdf`);
        writeFileSync(p, Buffer.from(pdf));
        out.pdf = p;
      } finally {
        await browser.close();
      }
    }

    this.logger.info(`[manual] built "${input.title}" (${out.steps} steps) -> ${[out.md, out.pdf, out.docx].filter(Boolean).join(', ')}`);
    return out;
  }
}
