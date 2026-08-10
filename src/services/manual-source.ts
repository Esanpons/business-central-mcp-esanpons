import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative } from 'node:path';
import { FENCE_OPEN, isFenceClose, isTableDivider } from './markdown-inline.js';
import { pngSize, type ManualImage, type ManualModel, type ManualStepModel } from './manual-render.js';

/**
 * Reads a manual back from a Markdown file.
 *
 * The point of this module is NOT to parse arbitrary Markdown -- that is a race
 * nobody wins, because "whatever the author wrote this time" is not a contract.
 * It reads ONE documented format: the exact shape `renderMarkdown` emits. The
 * generator is therefore the specification, the round-trip test pins the two
 * together, and an assistant that needs to produce a valid source file can
 * simply be shown what the tool itself writes.
 *
 * Anything the document model cannot represent (a second figure in one step, a
 * table missing its delimiter row, a fence that is never closed) is reported as
 * a diagnostic with its line number rather than silently mangled -- the caller
 * can validate first, fix, and only then build.
 *
 * Format:
 *
 *     ---
 *     lang: ca          <- optional front matter: build settings travel WITH
 *     cover: true          the document, so the same file always builds the
 *     toc: true            same way
 *     ---
 *
 *     # Manual title
 *
 *     Intro prose, until the first step.
 *
 *     ## 1. Step heading          <- the "1. " is optional; numbering is positional
 *
 *     Prose ABOVE the figure.
 *
 *     ![alt](img/step-1.png)      <- one figure per step, path relative to this file
 *     *Figure caption*            <- optional, italic line right after the image
 *
 *     Prose BELOW the figure.
 *
 * Prose carries the Markdown subset of `markdown-inline.ts`: paragraphs, `-` and
 * `1.` lists, `>` notes, GFM tables, ``` fenced code, and the inline marks. A
 * fence owns every line up to its close, INCLUDING blank ones and lines that
 * would otherwise read as structure -- a `## ` or an `![](…)` inside a listing is
 * content, so the scan below tracks the fence state instead of matching blindly.
 */

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  /** 1-based line in the source file. 0 when the problem is the file as a whole. */
  line: number;
  severity: Severity;
  message: string;
}

export interface ManualSourceOptions {
  /** Build settings read from the front matter. Every key is optional. */
  lang?: string;
  cover?: boolean;
  toc?: boolean;
  name?: string;
  assets?: string;
}

export interface ParsedManualSource {
  /** Undefined when a hard error made the document unusable. */
  model?: ManualModel;
  options: ManualSourceOptions;
  diagnostics: Diagnostic[];
  /** Directory the image paths were resolved against (the source file's own). */
  baseDir: string;
}

const H1 = /^#\s+(.*)$/;
const H2 = /^##\s+(?:\d+[.)]\s*)?(.*)$/;
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const CAPTION_LINE = /^\*([^*].*[^*])\*\s*$/;
const TABLE_LINE = /^\s*\|.*\|\s*$/;

/** Percent-decoding, undoing `encodeMarkdownPath` so a path with spaces round-trips. */
function decodePath(p: string): string {
  try {
    return decodeURI(p).replace(/%28/g, '(').replace(/%29/g, ')').replace(/%23/g, '#').replace(/%3F/g, '?');
  } catch {
    return p;
  }
}

/**
 * Front matter: `key: value` scalars only.
 *
 * Deliberately not YAML. The settings this carries are five flat scalars, and a
 * real YAML parser would invite documents this renderer cannot honour anyway.
 */
function parseFrontMatter(lines: string[], diagnostics: Diagnostic[]): { options: ManualSourceOptions; start: number } {
  if (lines[0]?.trim() !== '---') return { options: {}, start: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) {
    diagnostics.push({ line: 1, severity: 'error', message: 'front matter opens with --- but is never closed' });
    return { options: {}, start: 0 };
  }

  const options: ManualSourceOptions = {};
  for (let i = 1; i < end; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!m) {
      diagnostics.push({ line: i + 1, severity: 'warning', message: `front matter line is not "key: value", ignored: ${raw.trim()}` });
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim().replace(/^["']|["']$/g, '');
    switch (key) {
      case 'lang': options.lang = value; break;
      case 'name': options.name = value; break;
      case 'assets': options.assets = value; break;
      case 'cover': options.cover = value !== 'false'; break;
      case 'toc': options.toc = value !== 'false'; break;
      default:
        diagnostics.push({ line: i + 1, severity: 'warning', message: `unknown front matter key "${key}", ignored` });
    }
  }
  return { options, start: end + 1 };
}

/**
 * A collected prose line, carrying the file line it came from.
 *
 * Prose blocks are gathered out of order (a step's body is only checked once the
 * step ends), so a single "block starts at line N" offset drifts by one at every
 * boundary. Diagnostics are the whole point of this module, and a line number
 * that is almost right is worse than none.
 */
interface SourceLine { line: number; text: string }

/** Trim leading/trailing blank lines without touching the blank lines inside. */
function tidy(block: SourceLine[]): string {
  let a = 0;
  let b = block.length;
  while (a < b && !block[a]!.text.trim()) a++;
  while (b > a && !block[b - 1]!.text.trim()) b--;
  return block.slice(a, b).map((l) => l.text).join('\n');
}

/**
 * Flags constructs the document model cannot represent, so nothing is lost quietly.
 *
 * Tables and fenced code are rendered for real now, so what is checked here is
 * that they are WELL FORMED: a table without its delimiter row and a fence that
 * is never closed both still parse, but into something the author did not mean.
 */
function checkProse(block: SourceLine[], diagnostics: Diagnostic[]): void {
  let fence: { line: number; marker: string } | undefined;
  block.forEach(({ line, text: raw }, i) => {
    const open = FENCE_OPEN.exec(raw);
    if (fence) {
      if (isFenceClose(raw, fence.marker)) fence = undefined;
      return;
    }
    if (open) {
      fence = { line, marker: open[1]![0]! };
      return;
    }
    // Only the FIRST row of a pipe run is checked: the rows after the delimiter
    // are the table's body and reporting each of them is noise.
    if (TABLE_LINE.test(raw) && !TABLE_LINE.test(block[i - 1]?.text ?? '')) {
      const next = block[i + 1]?.text ?? '';
      if (!isTableDivider(next)) {
        diagnostics.push({ line, severity: 'warning', message: 'table without a delimiter row — add "|---|---|" under the header, or the pipes print as literal text' });
      }
    }
  });
  if (fence) {
    diagnostics.push({ line: fence.line, severity: 'warning', message: 'code fence is never closed — everything below it is treated as code' });
  }
}

/**
 * Resolve an image reference against the source file and read its intrinsic size.
 *
 * `outDir` is where the built document will be written: the model's `relPath` has
 * to be relative to THAT, not to the source, or the .md and `assets:"files"` HTML
 * outputs would link images that are not there.
 */
function resolveImage(
  src: string,
  baseDir: string,
  outDir: string,
  line: number,
  caption: string | undefined,
  diagnostics: Diagnostic[],
): ManualImage | undefined {
  const decoded = decodePath(src.trim());
  if (/^[a-z]+:\/\//i.test(decoded)) {
    diagnostics.push({ line, severity: 'error', message: `image "${decoded}" is a URL — only files on disk can be embedded` });
    return undefined;
  }
  const absPath = isAbsolute(decoded) ? decoded : resolve(baseDir, decoded);
  if (!existsSync(absPath)) {
    diagnostics.push({ line, severity: 'error', message: `image "${decoded}" does not exist (resolved to ${absPath})` });
    return undefined;
  }
  const { width, height } = pngSize(readFileSync(absPath));
  return {
    absPath,
    relPath: relative(outDir, absPath),
    ...(width && height ? { width, height } : {}),
    ...(caption ? { caption } : {}),
  };
}

export interface ParseManualSourceInput {
  /** Absolute path of the .md file. */
  file: string;
  /** Where the built document will be written; image `relPath`s are made relative to it. */
  outDir: string;
}

export function parseManualSource({ file, outDir }: ParseManualSourceInput): ParsedManualSource {
  const baseDir = dirname(file);
  const diagnostics: Diagnostic[] = [];

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return {
      options: {},
      baseDir,
      diagnostics: [{ line: 0, severity: 'error', message: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const { options, start } = parseFrontMatter(lines, diagnostics);

  let title: string | undefined;
  const introLines: SourceLine[] = [];
  const steps: ManualStepModel[] = [];

  // Per-step accumulation. `target` flips from body to after the moment the
  // figure is seen, which is what makes "prose above" and "prose below" fall out
  // of the document order instead of needing markers.
  let heading: string | undefined;
  let bodyLines: SourceLine[] = [];
  let afterLines: SourceLine[] = [];
  let image: ManualImage | undefined;
  let awaitingCaption = false;
  let target: 'body' | 'after' = 'body';

  const flushStep = () => {
    if (heading === undefined) return;
    checkProse(bodyLines, diagnostics);
    checkProse(afterLines, diagnostics);
    const body = tidy(bodyLines);
    const after = tidy(afterLines);
    steps.push({
      heading,
      ...(body ? { body } : {}),
      ...(image ? { image } : {}),
      ...(after ? { after } : {}),
    });
    heading = undefined;
    bodyLines = [];
    afterLines = [];
    image = undefined;
    awaitingCaption = false;
    target = 'body';
  };

  /** Send one line to whichever prose bucket is open right now. */
  const collect = (line: number, text: string) => {
    const entry: SourceLine = { line, text };
    if (heading === undefined) introLines.push(entry);
    else if (target === 'body') bodyLines.push(entry);
    else afterLines.push(entry);
  };

  // A fence swallows everything up to its close. Without this a listing that
  // shows how to write a manual (`## `, `![](…)`) would be read as real structure
  // and silently cut the document in two.
  let fenceMarker: string | undefined;

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = i + 1;

    const fence = FENCE_OPEN.exec(raw);
    if (fenceMarker) {
      // The SAME close rule the renderer applies (`isFenceClose`). Anything
      // looser closes the block here but not there, so the reader starts seeing
      // structure inside a listing while the renderer keeps swallowing prose
      // into it -- and neither side says a word.
      if (isFenceClose(raw, fenceMarker)) fenceMarker = undefined;
      collect(line, raw);
      continue;
    }
    if (fence) {
      fenceMarker = fence[1]![0]!;
      awaitingCaption = false;
      collect(line, raw);
      continue;
    }

    const h2 = H2.exec(raw);
    if (h2) {
      flushStep();
      heading = h2[1]!.trim();
      if (!heading) diagnostics.push({ line, severity: 'error', message: 'step heading is empty' });
      continue;
    }

    const h1 = H1.exec(raw);
    if (h1 && !H2.test(raw)) {
      if (title === undefined) {
        title = h1[1]!.trim();
      } else {
        diagnostics.push({ line, severity: 'warning', message: 'second "# " title — a manual has one; this one is ignored' });
      }
      continue;
    }

    const img = IMAGE_LINE.exec(raw);
    if (img) {
      if (heading === undefined) {
        diagnostics.push({ line, severity: 'warning', message: 'image before the first "## " step — the intro carries no figure, it is dropped' });
        continue;
      }
      if (image) {
        diagnostics.push({ line, severity: 'warning', message: `a step carries one figure; "${img[2]}" is dropped — split the step in two to keep it` });
        continue;
      }
      image = resolveImage(img[2]!, baseDir, outDir, line, undefined, diagnostics);
      awaitingCaption = true;
      target = 'after';
      continue;
    }

    // The italic line straight after a figure is its caption, which is exactly
    // how `renderMarkdown` writes one. A blank line between the two is allowed;
    // anything else ends the window.
    if (awaitingCaption) {
      if (!raw.trim()) continue;
      const cap = CAPTION_LINE.exec(raw.trim());
      if (cap && image) {
        image = { ...image, caption: cap[1]!.trim() };
        awaitingCaption = false;
        continue;
      }
      awaitingCaption = false;
    }

    collect(line, raw);
  }
  flushStep();

  if (title === undefined) {
    diagnostics.push({ line: 0, severity: 'error', message: 'no "# " title line — the first heading of the file is the manual title' });
  }
  if (!steps.length) {
    diagnostics.push({ line: 0, severity: 'error', message: 'no "## " steps — every manual needs at least one' });
  }
  checkProse(introLines, diagnostics);
  // Reported in reading order: prose is only checked when its step is flushed, so
  // the raw order jumps around and is miserable to work through in an editor.
  diagnostics.sort((a, b) => a.line - b.line);
  if (diagnostics.some((d) => d.severity === 'error')) {
    return { options, diagnostics, baseDir };
  }

  const intro = tidy(introLines);
  return {
    model: { title: title!, ...(intro ? { intro } : {}), steps },
    options,
    diagnostics,
    baseDir,
  };
}

/** One-line-per-problem rendering, for an error message or a tool response. */
export function formatDiagnostics(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((d) => `${d.line ? `line ${d.line}` : 'file'}: ${d.severity}: ${d.message}`);
}
