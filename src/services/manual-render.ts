import { readFileSync } from 'node:fs';

/**
 * Pure renderers for a manual document model -> Markdown / HTML / PDF / DOCX.
 * - Markdown references images by relative path.
 * - HTML inlines images as data URIs (used to produce the PDF via the headless browser).
 * - DOCX embeds images via the `docx` package (lazy-imported).
 */

export interface ManualImage {
  /** Absolute path on disk (used to read bytes for HTML/DOCX). */
  absPath: string;
  /** Path relative to the markdown file (used in the .md image link). */
  relPath: string;
  width: number;
  height: number;
}

export interface ManualStepModel {
  heading: string;
  body?: string;
  image?: ManualImage;
}

export interface ManualModel {
  title: string;
  intro?: string;
  steps: ManualStepModel[];
}

/** Read width/height from a PNG's IHDR (no image library needed). */
export function pngSize(buf: Uint8Array): { width: number; height: number } {
  if (buf.length < 24) return { width: 0, height: 0 };
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function renderMarkdown(model: ManualModel): string {
  const out: string[] = [`# ${model.title}`, ''];
  if (model.intro) out.push(model.intro, '');
  model.steps.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.heading}`, '');
    if (s.body) out.push(s.body, '');
    if (s.image) out.push(`![${s.heading.replace(/[[\]]/g, '')}](${s.image.relPath.replace(/\\/g, '/')})`, '');
  });
  return out.join('\n');
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function renderHtml(model: ManualModel): string {
  const parts: string[] = [`<h1>${esc(model.title)}</h1>`];
  if (model.intro) parts.push(`<p>${esc(model.intro)}</p>`);
  model.steps.forEach((s, i) => {
    parts.push(`<h2>${i + 1}. ${esc(s.heading)}</h2>`);
    if (s.body) parts.push(`<p>${esc(s.body)}</p>`);
    if (s.image) {
      const b64 = readFileSync(s.image.absPath).toString('base64');
      parts.push(`<img alt="${esc(s.heading)}" src="data:image/png;base64,${b64}" />`);
    }
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI',Arial,sans-serif;margin:28px;color:#1b1b1b;}
    h1{font-size:24px;margin:0 0 12px;}
    h2{font-size:17px;margin:22px 0 8px;color:#15396b;}
    p{line-height:1.5;margin:6px 0;}
    img{max-width:100%;border:1px solid #d9d9d9;border-radius:4px;margin:6px 0 14px;display:block;}
  </style></head><body>${parts.join('\n')}</body></html>`;
}

/** Render the assembled HTML to a PDF using a headless browser page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function renderPdf(browser: any, html: string): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
  } finally {
    await page.close();
  }
}

export async function renderDocx(model: ManualModel): Promise<Buffer> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, HeadingLevel, ImageRun, TextRun } = docx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children: any[] = [new Paragraph({ text: model.title, heading: HeadingLevel.TITLE })];
  if (model.intro) children.push(new Paragraph({ children: [new TextRun(model.intro)] }));
  model.steps.forEach((s, i) => {
    children.push(new Paragraph({ text: `${i + 1}. ${s.heading}`, heading: HeadingLevel.HEADING_2 }));
    if (s.body) children.push(new Paragraph({ children: [new TextRun(s.body)] }));
    if (s.image) {
      const data = readFileSync(s.image.absPath);
      const maxW = 600;
      const scale = s.image.width > maxW ? maxW / s.image.width : 1;
      children.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: 'png',
              data,
              transformation: {
                width: Math.max(1, Math.round(s.image.width * scale)),
                height: Math.max(1, Math.round(s.image.height * scale)),
              },
            }),
          ],
        }),
      );
    }
  });
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
