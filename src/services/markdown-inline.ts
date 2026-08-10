/**
 * Minimal Markdown parser for manual prose, plus the HTML renderer.
 *
 * Manual bodies are authored as Markdown (that is what the .md output ships),
 * so every other output must understand the same small subset instead of
 * dumping the raw source into a paragraph. Deliberately tiny -- no tables, no
 * nested lists, no HTML passthrough.
 *
 * Supported: paragraphs, `-`/`*` bullet lists, `1.` ordered lists, `>` notes,
 * `**bold**`, `*italic*` / `_italic_`, `` `code` `` and `[text](url)` links.
 *
 * The source is parsed ONCE into a tiny AST (`parseBlocks`) and rendered from
 * there. HTML lives here; the Word renderer walks the same AST in
 * `manual-docx.ts`, which is what keeps a body reading identically in .md,
 * .html and .docx. Escaping happens in the HTML renderer only -- the AST holds
 * plain text, so a body can never inject markup into any output.
 */

/** A run of text with its inline marks. `code` and `href` are mutually exclusive in practice. */
export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export type Block =
  | { kind: 'p'; spans: InlineSpan[] }
  | { kind: 'note'; spans: InlineSpan[] }
  | { kind: 'ul'; items: InlineSpan[][] }
  | { kind: 'ol'; items: InlineSpan[][] };

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

/** Block-level parse: blank-line separated paragraphs, lists and notes. */
export function parseBlocks(src: string): Block[] {
  const out: Block[] = [];
  for (const block of src.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      out.push({ kind: 'ul', items: lines.map((l) => parseInline(l.replace(/^[-*]\s+/, ''))) });
    } else if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      out.push({ kind: 'ol', items: lines.map((l) => parseInline(l.replace(/^\d+[.)]\s+/, ''))) });
    } else if (lines.every((l) => /^>\s?/.test(l))) {
      out.push({ kind: 'note', spans: parseInline(lines.map((l) => l.replace(/^>\s?/, '')).join(' ')) });
    } else {
      out.push({ kind: 'p', spans: parseInline(lines.join(' ')) });
    }
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

function blockToHtml(b: Block): string {
  if (b.kind === 'ul' || b.kind === 'ol') {
    const items = b.items.map((it) => `<li>${spansToHtml(it)}</li>`).join('');
    return b.kind === 'ul' ? `<ul>${items}</ul>` : `<ol>${items}</ol>`;
  }
  if (b.kind === 'note') return `<blockquote>${spansToHtml(b.spans)}</blockquote>`;
  return `<p>${spansToHtml(b.spans)}</p>`;
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
