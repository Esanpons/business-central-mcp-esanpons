// Build a BC OpenForm `filter=` expression from {column, value} pairs.
//
// This is the filter mechanism that ACTUALLY works on BC27/BC28 (verified live):
// the list "filter pane" (Filter/AddLine) is a no-op because list columns ship a
// ColumnBinder.Name but no .Path, so BC ignores the AddLine. The OpenForm query
// filter does work — the same path ObjectIndexService uses for page 9174.
//
// IMPORTANT: the field identifier is the AL field name (invariant), NOT the
// localized caption. `'No.'` / `'Name'` work in any locale; `'Nº'` / `'Nombre'`
// (Spanish captions) raise a BC "token not found" error. Range (`10000..30000`),
// wildcard (`A*`, `*consulting*`) and expression (`>1000`) values are supported.

export interface OpenFormFilter {
  /** AL field name (invariant), e.g. "No.", "Name", "City" — NOT the localized caption. */
  column: string;
  /** BC filter value: exact, range (`a..b`), wildcard (`*x*`), expression (`>n`). */
  value: string;
}

/**
 * Escape a value for embedding inside a single-quoted filter token.
 *
 * The expression grammar is `'<token>' IS '<token>'`, so an apostrophe inside the
 * token would otherwise CLOSE it and make the rest of the value parse as grammar —
 * BC answers with a "token not found" error and (before the reopen was made
 * transactional) killed the open page with it. Doubling is the quoting convention
 * BC's own filter tokenizer uses, i.e. `L'Oreal` -> `L''Oreal`.
 *
 * Note this is the FILTER-level escape only. The assembled expression still has to
 * be URL-encoded before it goes into the OpenForm query string (`&`, `%`, `+`, `#`
 * are query metacharacters) — see `PageService.buildOpenFormQuery`.
 */
export function escapeFilterToken(token: string): string {
  return token.replace(/'/g, "''");
}

/** `'Col1' IS 'val1' AND 'Col2' IS 'val2'`. Empty entries are dropped; returns '' if none. */
export function buildOpenFormFilter(filters: readonly OpenFormFilter[]): string {
  return filters
    .filter((f) => f.column && f.value !== undefined && f.value !== null && String(f.value) !== '')
    .map((f) => `'${escapeFilterToken(f.column)}' IS '${escapeFilterToken(String(f.value))}'`)
    .join(' AND ');
}
