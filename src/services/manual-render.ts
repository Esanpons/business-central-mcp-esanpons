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
