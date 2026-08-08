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

/** `'Col1' IS 'val1' AND 'Col2' IS 'val2'`. Empty entries are dropped; returns '' if none. */
export function buildOpenFormFilter(filters: readonly OpenFormFilter[]): string {
  return filters
    .filter((f) => f.column && f.value !== undefined && f.value !== null && String(f.value) !== '')
    .map((f) => `'${f.column}' IS '${f.value}'`)
    .join(' AND ');
}
