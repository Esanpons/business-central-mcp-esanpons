/**
 * Document model for a manual, plus the Markdown renderer.
 *
 * One model, two outputs: Markdown (this file) and the printable A4 web page
 * (`manual-html.ts`). Both read the same `ManualModel`, so a manual is authored
 * once and only the rendering differs.
 */

export interface ManualImage {
  /** Absolute path on disk (used to read bytes when inlining into HTML). */
  absPath: string;
  /** Path relative to the document file (used in the .md link and in `files` HTML mode). */
  relPath: string;
  /** Intrinsic pixel size, when the file is a real PNG. Undefined = unknown (see pngSize). */
  width?: number;
  height?: number;
  /** Optional figure caption rendered under the image (<figcaption> in HTML). */
  caption?: string;
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

/** The 8 bytes every PNG starts with: \x89PNG\r\n\x1a\n. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when the buffer starts with the PNG signature. */
export function isPng(buf: Uint8Array): boolean {
  if (buf.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => buf[i] === b);
}

/**
 * Read width/height from a PNG's IHDR (no image library needed).
 *
 * The signature is verified first: reading offsets 16/20 of a JPEG (or of any
 * non-PNG file a caller pointed a step at) yields garbage dimensions, and those
 * numbers reach the HTML as intrinsic `width`/`height` — which is exactly what
 * destabilises the paginator's pre-decode measurement. When the file is not a
 * PNG the size is reported as UNKNOWN (undefined) and the renderer omits the
 * attributes rather than lying about them.
 */
export function pngSize(buf: Uint8Array): { width?: number; height?: number } {
  if (!isPng(buf) || buf.length < 24) return {};
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (!width || !height) return {};
  return { width, height };
}

/**
 * Encode a path for use as a Markdown link destination.
 *
 * `![alt](my shot (1).png)` is broken Markdown: the space ends the destination
 * and the parenthesis closes it early. Percent-encoding is understood by every
 * renderer AND by the filesystem-backed viewers (VS Code, GitHub), so it is
 * preferred over the `<...>` wrapping (which itself breaks on `<`/`>`).
 */
export function encodeMarkdownPath(p: string): string {
  return encodeURI(p.replace(/\\/g, '/'))
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

export function renderMarkdown(model: ManualModel): string {
  const out: string[] = [`# ${model.title}`, ''];
  if (model.intro) out.push(model.intro, '');
  model.steps.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.heading}`, '');
    if (s.body) out.push(s.body, '');
    if (s.image) {
      const alt = (s.image.caption ?? s.heading).replace(/[[\]]/g, '');
      out.push(`![${alt}](${encodeMarkdownPath(s.image.relPath)})`, '');
      if (s.image.caption) out.push(`*${s.image.caption}*`, '');
    }
  });
  return out.join('\n');
}
