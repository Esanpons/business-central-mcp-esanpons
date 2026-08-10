/**
 * Minimal Markdown parser for manual prose, plus the HTML renderer.
 *
 * Manual bodies are authored as Markdown (that is what the .md output ships),
 * so every other output must understand the same small subset instead of
 * dumping the raw source into a paragraph. Deliberately small -- no nested
 * lists, no HTML passthrough.
 *
 * Supported: paragraphs, `-`/`*` bullet lists, `1.` ordered lists, `>` notes,
 * `###` sub-headings, GFM tables, ``` fenced code blocks, `**bold**`,
 * `*italic*` / `_italic_`, `` `code` `` and `[text](url)` links.
 *
 * The source is parsed ONCE into a tiny AST (`parseBlocks`) and rendered from
 * there. HTML lives here; the Word renderer walks the same AST in
 * `manual-docx.ts`, which is what keeps a body reading identically in .md,
 * .html and .docx. Escaping happens in the HTML renderer only -- the AST holds
 * plain text, so a body can never inject markup into any output.
 *
 * Tables and code blocks are the two constructs that can outgrow a sheet on
 * their own, so both are rendered as a container of per-row / per-line child
 * ELEMENTS: that is what lets the paginator split one across pages instead of
 * clipping it (see `manual-html-paginator.ts`).
 */

/** A run of text with its inline marks. `code` and `href` are mutually exclusive in practice. */
export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

/** Column alignment, read from the `:---` / `:---:` / `---:` delimiter row. */
export type CellAlign = 'left' | 'center' | 'right';

export type Block =
  | { kind: 'p'; spans: InlineSpan[] }
  | { kind: 'note'; spans: InlineSpan[] }
  /** `###` and deeper: a sub-section INSIDE a step. `## ` is the step itself and never reaches here. */
  | { kind: 'sub'; spans: InlineSpan[] }
  | { kind: 'ul'; items: InlineSpan[][] }
  | { kind: 'ol'; items: InlineSpan[][] }
  /** Rows are padded/truncated to the header width, so every renderer can assume a rectangle. */
  | { kind: 'table'; head: InlineSpan[][]; rows: InlineSpan[][][]; align: CellAlign[] }
  /** Verbatim lines: no inline parsing at all, indentation preserved. */
  | { kind: 'code'; lines: string[]; lang?: string };

export function escapeHtml(s: string): string {
  // Quotes are escaped too: callers also interpolate this into attribute values.
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

// Split patterns (capturing, so the delimiters survive) and their anchored twins.
const CODE_SPLIT = /(`[^`]+`)/g;
const LINK_SPLIT = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
const LINK_ONE = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/;
const BOLD_SPLIT = /(\*\*[^*]+\*\*)/g;
// The leading group keeps `*` inside a word (a*b) from opening emphasis, and is
// re-emitted as its own span so no character is lost.
const ITALIC_SPLIT = /((?:^|[\s(])[*_][^*_\n]+[*_])/g;

/** Bold/italic over a plain-text fragment that carries no code span and no link. */
function markSpans(text: string, base: InlineSpan): InlineSpan[] {
  const out: InlineSpan[] = [];
  for (const boldPart of text.split(BOLD_SPLIT)) {
    if (!boldPart) continue;
    if (boldPart.startsWith('**') && boldPart.endsWith('**') && boldPart.length > 4) {
      out.push({ ...base, text: boldPart.slice(2, -2), bold: true });
      continue;
    }
    for (const itPart of boldPart.split(ITALIC_SPLIT)) {
      if (!itPart) continue;
      const m = /^([\s(]?)([*_])([^*_\n]+)\2$/.exec(itPart);
      if (m) {
        if (m[1]) out.push({ ...base, text: m[1] });
        out.push({ ...base, text: m[3]!, italic: true });
      } else {
        out.push({ ...base, text: itPart });
      }
    }
  }
  return out;
}

/**
 * Parse one line of inline Markdown into spans.
 *
 * Order matters: code spans are peeled off first (their contents must stay
 * literal), then links -- a URL carrying `_` or `*` (very common in doc/query
 * links) would otherwise get emphasis marks injected into the destination.
 * Only the link LABEL is emphasised.
 */
export function parseInline(src: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  for (const part of src.split(CODE_SPLIT)) {
    if (!part) continue;
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      out.push({ text: part.slice(1, -1), code: true });
      continue;
    }
    for (const seg of part.split(LINK_SPLIT)) {
      if (!seg) continue;
      const m = LINK_ONE.exec(seg);
      if (m) out.push(...markSpans(m[1]!, { text: '', href: m[2]! }));
      else out.push(...markSpans(seg, { text: '' }));
    }
  }
  return out;
}

/**
 * Opening fence of a code block, capturing the marker run and the info string.
 *
 * Both ``` and ~~~ are accepted because a block whose CONTENT contains
 * backticks (a Markdown snippet, a shell line with a command substitution) can
 * only be written with the other marker.
 */
export const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/;

/**
 * Does this line CLOSE a fence opened with `marker`?
 *
 * A closing fence carries no info string, so ` ```markdown ` inside a block that
 * shows Markdown is content, not the end of it. Exported because
 * `manual-source.ts` scans the same documents for structure and has to agree
 * exactly: when the two disagree the reader closes the block early, starts
 * treating a `## ` inside the listing as a real step, and neither side reports
 * anything -- the silent mangling this parser exists to prevent.
 */
export function isFenceClose(line: string, marker: string): boolean {
  const s = line.trim();
  if (s.length < 3) return false;
  for (let i = 0; i < s.length; i++) if (s[i] !== marker) return false;
  return true;
}

/**
 * A table's delimiter row: only pipes, dashes, colons and spaces, with at least
 * one of each structural character.
 *
 * Deliberately looser than the GFM grammar. The strict form rejects rows a human
 * routinely writes (a stray space, a missing outer pipe) and the failure mode is
 * silent -- the table degrades to a paragraph of literal pipes, which is exactly
 * the thing this parser exists to stop.
 */
export function isTableDivider(line: string): boolean {
  const s = line.trim();
  return /^[|\-: ]+$/.test(s) && s.includes('-') && s.includes('|');
}

/** A candidate table row: anything carrying a pipe that is not the delimiter. */
function isRow(line: string): boolean {
  return line.includes('|');
}

/**
 * Split one table row into cells.
 *
 * Pipes inside an inline-code span are content, not separators (`` `a|b` ``),
 * and `\|` escapes one anywhere -- both are how a real table carries a pipe.
 */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function alignOf(cell: string): CellAlign {
  const s = cell.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : 'left';
}

/** Drop blank lines at both ends of a code block without touching the ones inside. */
function trimEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}

/** `###` or deeper. `## ` is a step boundary and is consumed before prose is ever parsed. */
const SUB_HEADING = /^#{3,}\s+(.*)$/;

/**
 * Classify one run of consecutive non-blank lines.
 *
 * A sub-heading and a table each consume only the lines they own and hand the
 * rest of the run back to this function, so prose written straight under either
 * -- with no blank line between -- is still classified on its own.
 */
function pushRun(run: string[], out: Block[]): void {
  if (!run.length) return;

  // A sub-heading is one line, so it is peeled off and the rest of the run is
  // re-classified: text written straight under it is its own block.
  const sub = SUB_HEADING.exec(run[0]!);
  if (sub) {
    out.push({ kind: 'sub', spans: parseInline(sub[1]!.trim()) });
    pushRun(run.slice(1), out);
    return;
  }

  if (run.length >= 2 && isRow(run[0]!) && isTableDivider(run[1]!)) {
    const head = splitRow(run[0]!);
    const align = splitRow(run[1]!).map(alignOf);
    let end = 2;
    while (end < run.length && isRow(run[end]!) && !isTableDivider(run[end]!)) end++;
    out.push({
      kind: 'table',
      head: head.map((c) => parseInline(c)),
      align: head.map((_, i) => align[i] ?? 'left'),
      // Padded to the header width: a short row is a typo, not a reason to emit
      // a ragged table that every renderer then has to guard against.
      rows: run.slice(2, end).map((r) => {
        const cells = splitRow(r);
        return head.map((_, i) => parseInline(cells[i] ?? ''));
      }),
    });
    pushRun(run.slice(end), out);
    return;
  }

  if (run.every((l) => /^[-*]\s+/.test(l))) {
    out.push({ kind: 'ul', items: run.map((l) => parseInline(l.replace(/^[-*]\s+/, ''))) });
  } else if (run.every((l) => /^\d+[.)]\s+/.test(l))) {
    out.push({ kind: 'ol', items: run.map((l) => parseInline(l.replace(/^\d+[.)]\s+/, ''))) });
  } else if (run.every((l) => /^>\s?/.test(l))) {
    out.push({ kind: 'note', spans: parseInline(run.map((l) => l.replace(/^>\s?/, '')).join(' ')) });
  } else {
    out.push({ kind: 'p', spans: parseInline(run.join(' ')) });
  }
}

/**
 * Block-level parse: paragraphs, lists, notes, tables and fenced code.
 *
 * Scans line by line rather than splitting on blank lines first, because a code
 * block owns its blank lines -- splitting first tears one into pieces that no
 * later pass can put back together.
 */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i]!.trim()) { i++; continue; }

    const fence = FENCE_OPEN.exec(lines[i]!);
    if (fence) {
      const marker = fence[1]![0]!;
      const lang = fence[2] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i]!, marker)) { body.push(lines[i]!); i++; }
      // An unterminated fence runs to the end of the prose rather than losing it;
      // `manual-source.ts` reports the missing close by line number.
      if (i < lines.length) i++;
      out.push({ kind: 'code', lines: trimEdges(body), ...(lang ? { lang } : {}) });
      continue;
    }

    const run: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE_OPEN.test(lines[i]!)) {
      run.push(lines[i]!.trim());
      i++;
    }
    pushRun(run, out);
  }
  return out;
}

/** Render parsed spans as HTML. Escapes every text node, so markup can never leak through. */
function spansToHtml(spans: InlineSpan[]): string {
  return spans.map((s) => {
    if (s.code) return `<code>${escapeHtml(s.text)}</code>`;
    let html = escapeHtml(s.text);
    if (s.bold) html = `<strong>${html}</strong>`;
    if (s.italic) html = `<em>${html}</em>`;
    return s.href ? `<a href="${escapeHtml(s.href)}">${html}</a>` : html;
  }).join('');
}

/** Inline span formatting. Escapes first, so the input can never emit markup. */
export function renderInline(src: string): string {
  return spansToHtml(parseInline(src));
}

/** `class` attribute for a cell, omitted for the default alignment. */
function alignClass(a: CellAlign | undefined): string {
  return a && a !== 'left' ? ` class="a-${a}"` : '';
}

function blockToHtml(b: Block): string {
  if (b.kind === 'ul' || b.kind === 'ol') {
    const items = b.items.map((it) => `<li>${spansToHtml(it)}</li>`).join('');
    return b.kind === 'ul' ? `<ul>${items}</ul>` : `<ol>${items}</ol>`;
  }
  if (b.kind === 'note') return `<blockquote>${spansToHtml(b.spans)}</blockquote>`;
  if (b.kind === 'sub') return `<h3 class="md-sub">${spansToHtml(b.spans)}</h3>`;
  if (b.kind === 'table') {
    const head = b.head.map((c, i) => `<th${alignClass(b.align[i])}>${spansToHtml(c)}</th>`).join('');
    const rows = b.rows
      .map((r) => `<tr>${r.map((c, i) => `<td${alignClass(b.align[i])}>${spansToHtml(c)}</td>`).join('')}</tr>`)
      .join('');
    // thead/tbody are not decoration: the paginator moves <tbody> rows to the
    // next sheet and clones the header with them, so a long table continues
    // under its own column titles instead of being clipped.
    return `<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  if (b.kind === 'p') return `<p>${spansToHtml(b.spans)}</p>`;
  // One element per line, for the same splitting reason as the table rows. An
  // empty line needs a character or it collapses to zero height and the printed
  // block loses its shape -- a zero-width space is the one that shows nothing.
  const lines = b.lines.length ? b.lines : [''];
  const code = lines.map((l) => `<span class="cl">${l ? escapeHtml(l) : '&#8203;'}</span>`).join('');
  return `<pre class="md-code"${b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : ''}><code>${code}</code></pre>`;
}

/**
 * Block-level formatting, one HTML string PER BLOCK.
 *
 * The printable page needs prose split at its natural boundaries: a body long
 * enough to outgrow a sheet has to be measured (and therefore paginated) block
 * by block, or it becomes one indivisible unit that overflows the paper.
 */
export function renderBlockList(src: string): string[] {
  return parseBlocks(src).map(blockToHtml);
}

/** Block-level formatting: blank-line separated paragraphs, lists and notes. */
export function renderBlocks(src: string): string {
  return parseBlocks(src).map(blockToHtml).join('');
}
