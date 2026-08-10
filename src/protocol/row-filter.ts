// src/protocol/row-filter.ts
//
// G8: filtering rows of a section that the OpenForm `filter=` query cannot reach.
//
// The server-side mechanism (see filter-query.ts) re-opens the PAGE with a filter, so
// it only ever targets the page's main list. A document's LINES live in a subpage form
// inside that page, and BC's other filtering route (the filter pane, Filter/AddLine)
// is a no-op on BC27/BC28 because list columns carry a ColumnBinder.Name but no .Path.
// That left "show me only the lines where X" impossible.
//
// This module closes that gap by evaluating BC's filter value syntax against rows that
// are ALREADY materialized in the FormState. It is deliberately client-side and says so:
// `bc_read_data` reports `rowFilter.mode: 'client'` plus how many rows it scanned, so
// nobody mistakes it for a server-side filter that reduced transfer.
//
// Supported value syntax (the subset BC users actually type):
//   exact      "1000"        equal, case-insensitive, trimmed
//   wildcard   "*consult*"   * matches any run of characters; ? matches exactly one
//   range      "10..20"      inclusive; numeric when both ends parse as numbers, else string
//   open range "..20" "10.." bounded on one side only
//   comparison ">100" ">=100" "<100" "<=100" "<>x"
//   set        "10|20|30"    any of
//   blank      ""            matches everything (an empty filter is dropped upstream)
// Values are compared against the cell's DISPLAY text (what BC formatted), except for
// numeric comparisons, which parse the text as a number when possible.
//
// KNOWN LIMITATIONS (client-side matching works on display text, not on typed values):
//   * DATES are compared LEXICOGRAPHICALLY. `01/01/2026..31/03/2026` therefore does NOT
//     mean what a BC user means by it — dd/mm/yyyy text does not sort chronologically.
//     Only an ISO-formatted date column (yyyy-mm-dd) ranges correctly. For real date
//     filtering use the server-side OpenForm `filter=` query on the page's main list
//     (see filter-query.ts), which BC evaluates against the typed field.
//   * A DOT-GROUPED INTEGER is ambiguous: `1.234` is 1234 in es-ES and 1.234 in en-US.
//     We refuse to guess (see `toNumber`) and fall back to string comparison, so a
//     numeric comparison against such a cell is best-effort. Decimal cells that carry
//     an explicit decimal comma (`1.234,56`) are unambiguous and parse correctly.

export interface RowLike {
  readonly bookmark: string;
  readonly cells: Record<string, unknown>;
}

export interface RowFilter {
  /** Column caption (as returned in `cells`) or the AL column name — both are accepted. */
  column: string;
  /** BC filter value expression; see the syntax table above. */
  value: string;
}

/** Normalize a cell value to the text BC would display. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const v = o.stringValue ?? o.objectValue ?? '';
    return v === null || v === undefined ? '' : String(v);
  }
  return String(value);
}

/**
 * A number written with dot thousands-groups and no decimal mark — `1.234`,
 * `12.345.678`. Locale-ambiguous: es-ES reads 1234, en-US reads 1.234. See the
 * header note; we decline to guess and let the caller fall back to text compare.
 */
const DOT_GROUPED_INTEGER = /^-?\d{1,3}(\.\d{3})+$/;

/**
 * BC-ish number parse: tolerates thousands separators and both decimal marks.
 * Returns null when the text is not a number OR when reading it as one would
 * require guessing the locale (see DOT_GROUPED_INTEGER).
 */
function toNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (DOT_GROUPED_INTEGER.test(t)) return null;   // ambiguous -> compare as text
  // "1.234,56" (es) and "1,234.56" (en) both become 1234.56.
  const normalized = /,\d{1,2}$/.test(t)
    ? t.replace(/\./g, '').replace(',', '.')
    : t.replace(/,(?=\d{3}\b)/g, '');
  const n = Number(normalized.replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
}

function wildcardToRegExp(pattern: string): RegExp {
  // Built in ONE left-to-right pass. The previous two-pass version substituted the
  // wildcards for the literal placeholders " STAR " / " ANY " and split on them
  // afterwards, so a pattern containing that literal text (`*ROCK STAR BAND*`) was
  // rewritten into `.*` and matched everything.
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') { source += '.*'; continue; }
    if (ch === '?') { source += '.'; continue; }
    source += ch.replace(/[.*+?^${}()|[\]\\]/, (c) => `\\${c}`);
  }
  return new RegExp(`^${source}$`, 'i');
}

function compare(cell: string, other: string): number {
  const a = toNumber(cell);
  const b = toNumber(other);
  if (a !== null && b !== null) return a === b ? 0 : (a < b ? -1 : 1);
  const ca = cell.trim().toLowerCase();
  const cb = other.trim().toLowerCase();
  return ca === cb ? 0 : (ca < cb ? -1 : 1);
}

/** Evaluate ONE filter expression against ONE cell's display text. */
export function matchesFilterValue(cellValue: unknown, expression: string): boolean {
  const cell = cellText(cellValue);
  const expr = expression.trim();
  if (expr === '') return true;

  // Set: a|b|c (evaluated first so each alternative keeps its own syntax)
  if (expr.includes('|')) {
    return expr.split('|').some((part) => matchesFilterValue(cellValue, part));
  }

  if (expr.startsWith('<>')) return !matchesFilterValue(cellValue, expr.slice(2));
  if (expr.startsWith('>=')) return compare(cell, expr.slice(2)) >= 0;
  if (expr.startsWith('<=')) return compare(cell, expr.slice(2)) <= 0;
  if (expr.startsWith('>')) return compare(cell, expr.slice(1)) > 0;
  if (expr.startsWith('<')) return compare(cell, expr.slice(1)) < 0;

  // Range a..b (either side may be empty)
  const range = expr.match(/^(.*?)\.\.(.*)$/);
  if (range) {
    const [, lo, hi] = range;
    if (lo && compare(cell, lo) < 0) return false;
    if (hi && compare(cell, hi) > 0) return false;
    return true;
  }

  if (expr.includes('*') || expr.includes('?')) return wildcardToRegExp(expr).test(cell);

  return cell.trim().toLowerCase() === expr.toLowerCase();
}

/**
 * Resolve a caller-supplied column identifier to the key actually present in
 * `row.cells`. Accepts the display caption (what the rows are keyed by), an alias,
 * or a case-insensitive/trimmed variant of either. Returns null when nothing matches,
 * so the caller can raise a proper "column not found" error listing what IS available
 * instead of silently returning zero rows.
 */
export function resolveCellKey(
  column: string,
  availableKeys: readonly string[],
  aliases?: ReadonlyMap<string, string>,
): string | null {
  const want = column.trim().toLowerCase();
  const direct = availableKeys.find((k) => k.trim().toLowerCase() === want);
  if (direct) return direct;
  if (aliases) {
    for (const [alias, key] of aliases) {
      if (alias.trim().toLowerCase() === want && availableKeys.includes(key)) return key;
    }
  }
  return null;
}

export interface RowFilterOutcome<T extends RowLike> {
  rows: T[];
  /** Rows examined (i.e. rows that were materialized when the filter ran). */
  scanned: number;
  /** Filters that were applied, with the cell key each one resolved to. */
  applied: Array<{ column: string; value: string; resolvedKey: string }>;
}

export interface FilterRowsOptions {
  /**
   * The section's repeater column captions. This is the AUTHORITATIVE column list:
   * derived from the repeater's columns, it is complete even when zero rows are
   * loaded and unaffected by rows that happen to carry only some cells. Without it
   * the column list is inferred from the rows present, so an empty result set made
   * every filter throw "column not found. Available columns:" with nothing after it.
   */
  columns?: readonly string[];
  /** Extra names accepted for a column (e.g. AL/binder name -> caption). */
  aliases?: ReadonlyMap<string, string>;
}

/**
 * Apply every filter (AND) to `rows`. Throws a plain Error naming the offending
 * column when one can't be resolved — callers turn it into a ProtocolError with the
 * available column list attached. A column that IS known but has no matching rows
 * yields an empty result, never an error.
 */
export function filterRows<T extends RowLike>(
  rows: readonly T[],
  filters: readonly RowFilter[],
  options?: FilterRowsOptions,
): RowFilterOutcome<T> {
  const fromRows = rows.flatMap((r) => Object.keys(r.cells));
  const availableKeys = Array.from(new Set([...(options?.columns ?? []), ...fromRows]));
  const applied: RowFilterOutcome<T>['applied'] = [];

  for (const f of filters) {
    const key = resolveCellKey(f.column, availableKeys, options?.aliases);
    if (!key) {
      const listed = availableKeys.length > 0 ? availableKeys.join(', ') : '(none — the section exposes no columns)';
      throw new Error(`Filter column not found: "${f.column}". Available columns: ${listed}`);
    }
    applied.push({ column: f.column, value: f.value, resolvedKey: key });
  }

  // Zero rows is a trivially-empty match, not an error: the filter resolved fine,
  // there is simply nothing to match against.
  const out = rows.filter((row) => applied.every((a) => matchesFilterValue(row.cells[a.resolvedKey], a.value)));
  return { rows: [...out], scanned: rows.length, applied };
}
