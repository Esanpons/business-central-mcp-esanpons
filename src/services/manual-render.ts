/**
 * Document model for a manual, plus the Markdown renderer.
 *
 * One model, three outputs: Markdown (this file), the printable A4 web page
 * (`manual-html.ts`) and the editable Word document (`manual-docx.ts`). All
 * three read the same `ManualModel`, so a manual is authored once and only the
 * rendering differs.
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
  /** Prose above the figure. */
  body?: string;
  image?: ManualImage;
  /** Prose BELOW the figure -- what the reader should notice once they have seen it. */
  after?: string;
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

/** Raster formats Word can embed. SVG and anything unrecognised is reported as undefined. */
export type ImageKind = 'png' | 'jpg' | 'gif' | 'bmp';

export interface ImageInfo {
  kind?: ImageKind;
  width?: number;
  height?: number;
}

/**
 * Sniff an image's format and intrinsic size from its header alone.
 *
 * The HTML output can get away with not knowing the size (the browser measures
 * the file itself), but Word cannot: an embedded image carries an explicit
 * width and height, so a figure whose size is unknown cannot be placed at all.
 * Covering the four raster formats a caller can realistically point a step at
 * turns "the figure was dropped" into a case that only happens for genuinely
 * exotic files.
 */
export function imageInfo(buf: Uint8Array): ImageInfo {
  if (buf.length < 24) return {};
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);

  if (isPng(buf)) {
    const { width, height } = pngSize(buf);
    return { kind: 'png', width, height };
  }
  // GIF: "GIF87a"/"GIF89a", then width/height as little-endian uint16.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { kind: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  // BMP: "BM", then width/height as little-endian int32 in the DIB header.
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return { kind: 'bmp', width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  }
  // JPEG: walk the marker chain to the frame header (SOF0..SOF15), which is the
  // only place the real dimensions live. SOF4 (DHT), SOF8 (JPG) and SOF12 (DAC)
  // share the marker range but are not frame headers, hence the exclusions.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { kind: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      // Standalone markers carry no length payload; everything else does.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) i += 2;
      else i += 2 + b.readUInt16BE(i + 2);
    }
    return { kind: 'jpg' };
  }
  return {};
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
    if (s.after) out.push(s.after, '');
  });
  return out.join('\n');
}
