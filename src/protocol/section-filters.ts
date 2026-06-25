// src/protocol/section-filters.ts
//
// Pure, reusable narrowing operations over a built Section DTO. Shared by
// bc_read_data and bc_open_page so both acoten payloads the same way (P7).
// None of these touch the session or the form tree -- they operate on the
// already-materialized Section.

import type { Section, SectionField, SectionRow } from './section-dto.js';

/**
 * Strip a Section down to its identity (no fields/rows/actions/cues). The
 * result is still a valid Section (fields/rows are optional). Use for the
 * bc_open_page `summary` mode so callers can see what sections exist and then
 * pull each one with bc_read_data. `totalRowCount` is kept when known so the
 * caller can size pagination.
 */
export function toSectionSummary(s: Section): Section {
  return {
    sectionId: s.sectionId,
    kind: s.kind,
    caption: s.caption,
    ...(s.totalRowCount !== undefined ? { totalRowCount: s.totalRowCount } : {}),
  };
}

/** Keep only card fields whose nearest group caption matches (case-insensitive). */
export function filterFieldsByGroup(s: Section, group: string): Section {
  if (!s.fields) return s;
  const want = group.trim().toLowerCase();
  return { ...s, fields: s.fields.filter(f => (f.group ?? '').trim().toLowerCase() === want) };
}

/**
 * Keep only the requested columns. Matches card fields by caption OR by stable
 * controlPath (so a duplicate-caption field can be pinned exactly), and list
 * row cells by caption key.
 */
export function filterColumns(s: Section, columns: readonly string[]): Section {
  const wanted = new Set(columns.map(c => c.toLowerCase()));
  let out: Section = s;
  if (s.rows) {
    out = {
      ...out,
      rows: s.rows.map((r): SectionRow => ({
        bookmark: r.bookmark,
        cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => wanted.has(k.toLowerCase()))),
      })),
    };
  }
  if (out.fields) {
    out = {
      ...out,
      fields: out.fields.filter((f: SectionField) => wanted.has(f.name.toLowerCase()) || wanted.has(f.controlPath.toLowerCase())),
    };
  }
  return out;
}

/** Slice already-loaded rows to rows[offset .. offset+limit]. No scrolling. */
export function sliceRows(s: Section, range: { offset: number; limit: number }): Section {
  if (!s.rows) return s;
  return { ...s, rows: s.rows.slice(range.offset, range.offset + range.limit) };
}
