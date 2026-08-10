/**
 * Minimal Markdown -> HTML converter for manual prose.
 *
 * Manual bodies are authored as Markdown (that is what the .md output ships),
 * so the HTML output must understand the same small subset instead of dumping
 * the raw source into a `<p>`. Deliberately tiny -- no tables, no nested lists,
 * no HTML passthrough (everything is escaped first, so a body can never inject
 * markup into the generated document).
 *
 * Supported: paragraphs, `-`/`*` bullet lists, `1.` ordered lists, `>` notes,
 * `**bold**`, `*italic*` / `_italic_`, `` `code` `` and `[text](url)` links.
 */

export function escapeHtml(s: string): string {
  // Quotes are escaped too: callers also interpolate this into attribute values.
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

/** Bold / italic, applied to already-escaped text. */
function emphasize(escaped: string): string {
  let t = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  return t;
}

// Split pattern (capturing, so the delimiters survive) and its anchored twin.
const LINK_SPLIT = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
const LINK_ONE = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/;

/** Inline span formatting. Escapes first, so the input can never emit markup. */
export function renderInline(src: string): string {
  // Split on code spans so their contents are escaped but not further formatted.
  return src.split(/(`[^`]+`)/g).map((part) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    }
    // Split on links BEFORE emphasising: a URL carrying `_` or `*` (very common
    // in doc/query links) would otherwise get <em> tags injected into the href.
    // Only the link LABEL is emphasised; the destination is passed through
    // escaped-but-unformatted.
    return escapeHtml(part).split(LINK_SPLIT).map((seg) => {
      const m = LINK_ONE.exec(seg);
      return m ? `<a href="${m[2]}">${emphasize(m[1]!)}</a>` : emphasize(seg);
    }).join('');
  }).join('');
}

/** Block-level formatting: blank-line separated paragraphs, lists and notes. */
export function renderBlocks(src: string): string {
  return src.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';

    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      const items = lines.map((l) => `<li>${renderInline(l.replace(/^[-*]\s+/, ''))}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      const items = lines.map((l) => `<li>${renderInline(l.replace(/^\d+[.)]\s+/, ''))}</li>`).join('');
      return `<ol>${items}</ol>`;
    }
    if (lines.every((l) => /^>\s?/.test(l))) {
      const text = lines.map((l) => l.replace(/^>\s?/, '')).join(' ');
      return `<blockquote>${renderInline(text)}</blockquote>`;
    }
    return `<p>${renderInline(lines.join(' '))}</p>`;
  }).join('');
}
