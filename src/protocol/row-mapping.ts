// src/protocol/row-mapping.ts
//
// Pure helpers that translate BC repeater row cells from columnBinderName
// keys (e.g. "1165569367_c2") to display-caption keys for MCP output.
// Lives in protocol/ because both protocol-level adapters (section-dto.ts)
// and service-level code (data-service.ts) read these.

import type { RepeaterRow, RepeaterColumn } from './types.js';
import type { RepeaterNode } from './form-node.js';

/**
 * Adapt a RepeaterNode's columns to the `RepeaterColumn` DTO shape the row
 * mappers and MCP output use. Single definition — section-dto.ts and
 * data-service.ts both went through their own copy of this projection.
 */
export function repeaterColumnsToDto(repeater: RepeaterNode): RepeaterColumn[] {
  return repeater.columns.map(c => ({
    controlPath: c.controlPath,
    caption: c.properties.caption ?? '',
    type: 'rcc' as const,
    columnBinderName: c.columnBinder?.name,
    columnBinderPath: c.columnBinder?.path,
  }));
}

/**
 * Build a mapping from columnBinderName to column caption.
 * Used to remap row.cells keys from internal binder names to human-readable captions.
 *
 * Duplicate captions get an ordinal suffix (`Amount`, `Amount#2`). The suffix is
 * checked against the FULL caption set first, so a repeater that genuinely ships a
 * column literally captioned `Amount#2` doesn't get two cells fighting over the same
 * key — the generated name keeps incrementing until it is free.
 */
export function buildBinderToCaptionMap(columns: RepeaterColumn[]): Map<string, string> {
  const map = new Map<string, string>();
  const taken = new Set<string>();
  for (const col of columns) {
    if (!col.columnBinderName) continue;
    taken.add(col.caption || col.columnBinderName);
  }
  const used = new Set<string>();
  for (const col of columns) {
    if (!col.columnBinderName) continue;
    const base = col.caption || col.columnBinderName;
    let caption = base;
    if (used.has(caption)) {
      for (let i = 2; ; i++) {
        const candidate = `${base}#${i}`;
        // Skip a candidate that collides with a REAL caption of another column.
        if (!used.has(candidate) && !taken.has(candidate)) { caption = candidate; break; }
      }
    }
    used.add(caption);
    map.set(col.columnBinderName, caption);
  }
  return map;
}

/**
 * Remap row cell keys from columnBinderName to caption.
 * Cell values are extracted: if value is an object with stringValue, use that.
 */
export function mapRowCellKeys(rows: RepeaterRow[], columns: RepeaterColumn[]): RepeaterRow[] {
  const binderMap = buildBinderToCaptionMap(columns);
  return rows.map(row => ({
    bookmark: row.bookmark,
    cells: remapCells(row.cells, binderMap),
  }));
}

export function remapCells(
  cells: Record<string, unknown>,
  binderMap: Map<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(cells)) {
    const caption = binderMap.get(key) ?? key;
    // Extract the display value from BC's cell structure
    // BC sends cells as objects like { stringValue: "...", objectValue: ..., editable: ..., ... }
    if (rawValue && typeof rawValue === 'object') {
      const cell = rawValue as Record<string, unknown>;
      // Prefer stringValue (formatted), fall back to objectValue (raw), then null for empty cells
      result[caption] = cell.stringValue ?? cell.objectValue ?? null;
    } else {
      result[caption] = rawValue;
    }
  }
  return result;
}
