import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative } from 'node:path';
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
 * Anything the document model cannot represent (tables, code fences, sub-
 * headings, a second figure in one step) is reported as a diagnostic with its
 * line number rather than silently mangled -- the caller can validate first,
 * fix, and only then build.
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
const DEEP_HEADING = /^#{3,}\s+/;
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const CAPTION_LINE = /^\*([^*].*[^*])\*\s*$/;
const TABLE_LINE = /^\s*\|.*\|\s*$/;
const FENCE = /^\s*```/;

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

/** Flags constructs the document model cannot represent, so nothing is lost quietly. */
function checkProse(block: SourceLine[], diagnostics: Diagnostic[]): void {
  let inFence = false;
  let tableReported = false;
  block.forEach(({ line, text: raw }) => {
    if (FENCE.test(raw)) {
      if (!inFence) {
        diagnostics.push({ line, severity: 'warning', message: 'fenced code block — the manual model has inline code only, the fence markers will be printed as text' });
      }
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (DEEP_HEADING.test(raw)) {
      diagnostics.push({ line, severity: 'warning', message: 'sub-heading — a manual has one heading level; make it a "## " step or plain prose, or it renders as a paragraph starting with #' });
    } else if (TABLE_LINE.test(raw) && !tableReported) {
      diagnostics.push({ line, severity: 'warning', message: 'Markdown table — not supported by the manual model, it will render as literal pipe characters' });
      tableReported = true;
    }
  });
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

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = i + 1;

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

    const collected: SourceLine = { line, text: raw };
    if (heading === undefined) introLines.push(collected);
    else if (target === 'body') bodyLines.push(collected);
    else afterLines.push(collected);
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
