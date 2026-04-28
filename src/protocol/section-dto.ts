// src/protocol/section-dto.ts
//
// MCP output DTO for a single page section. A page is a flat list of sections;
// each section is one of: header (the root form's primary content),
// lines (the document's lines repeater), factbox (a CardPart attached as a
// FactBox), subpage (any other embedded part), requestPage (a report's
// request-page modal). Internal code reads FieldNode/ActionNode via
// form-views.ts; this DTO is the shape exposed to MCP callers.

import type { SectionKind } from './section-resolver.js';
import type { FieldType } from './form-node.js';
import type { RepeaterRow } from './types.js';

export interface SectionField {
  /** Field caption as shown in the BC client. Display label only. */
  readonly name: string;
  /** Display string. Undefined for fields that have no string projection (e.g. boolean tristate). */
  readonly value?: string;
  readonly editable: boolean;
  /** Wire-level BC field type. See FieldType union in protocol/form-node.ts. */
  readonly type: FieldType;
  /** True if BC marked the field as mandatory. */
  readonly showMandatory?: boolean;
  /** True if the field has an AssistEdit/Lookup action attached. */
  readonly isLookup?: boolean;
}

export interface SectionAction {
  /** Action caption as shown in the BC client. */
  readonly name: string;
  /** SystemAction ordinal. See SystemAction enum in protocol/types.ts. 0 = no system role (custom AL action). */
  readonly systemAction: number;
  /** True if BC marks the action as currently invokable. */
  readonly enabled: boolean;
  /** Wizard role on a NavigatePage / StandardDialog. */
  readonly wizardNav?: 'back' | 'next' | 'finish' | 'cancel';
}

/**
 * Row inside a list-shape Section. Identical to the internal `RepeaterRow`
 * type — cells keyed by `columnBinderName` (e.g. "1165569367_c2"), not by
 * caption.
 */
export type SectionRow = RepeaterRow;

export interface Section {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  /**
   * Card-shape sections (header, factbox, requestPage, most subpages) carry
   * `fields[]` populated with visible, captioned fields.
   */
  readonly fields?: readonly SectionField[];
  /**
   * List-shape sections (lines, list-bodied subpages) carry `rows[]`.
   * `totalRowCount` reflects BC's TotalRowCount property; null when unknown.
   */
  readonly rows?: readonly SectionRow[];
  readonly totalRowCount?: number | null;
  readonly actions?: readonly SectionAction[];
}
