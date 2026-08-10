// src/protocol/page-context.ts
import type { FormState } from './form-state.js';
import type { SectionDescriptor } from './section-resolver.js';
import type { DialogInfo, PageType, WizardState } from './types.js';
import type { OpenFormFilter } from './filter-query.js';

/**
 * `mode=` values BC's OpenForm query accepts (mirrors the web client URL).
 * Declared here rather than imported from services/page-service.ts so the
 * protocol layer keeps no dependency on the service layer; PageService
 * re-exports it as `OpenFormMode`.
 */
export type PageOpenMode = 'Create' | 'Edit' | 'View';

export interface PageContext {
  readonly pageContextId: string;
  readonly rootFormId: string;
  /**
   * The BC page object id this context was opened from, when it has one
   * (`bc_open_page`). Absent for contexts BC spawned itself — drill-down targets,
   * cue pages, dialogs. Stored at open time so a re-open (filtering) never has to
   * reverse-engineer it out of the pageContextId string.
   */
  readonly pageId?: string;
  /** Tenant used for the OpenForm query at open time. Reused verbatim on re-open. */
  readonly tenantId?: string;
  /** `mode=` the page was opened with (Create/Edit/View). Reused on re-open. */
  readonly openMode?: PageOpenMode;
  /** `bookmark=` the page was opened with, when it was opened positioned on a record. */
  readonly bookmark?: string;
  readonly pageType: PageType;
  readonly caption: string;
  readonly forms: ReadonlyMap<string, FormState>;
  readonly sections: ReadonlyMap<string, SectionDescriptor>;
  readonly dialogs: DialogInfo[];
  readonly ownedFormIds: string[];
  /**
   * True when the root was a `DialogOpened` (modal page — wizards, request pages,
   * confirmation prompts). Modal-rooted pages must be closed via the modal's own
   * Cancel/Finish/Close action; CloseForm on the root works but BC may emit a
   * LogicalModalityViolation if other modals layered on top.
   */
  readonly isModal: boolean;
  /**
   * Set on NavigatePage / wizard pages where the parser found ≥2 top-level gcs
   * with `ExpressionProperties.Visible`. ActionService.executeWizardNav advances
   * `currentStepIndex` after each successful Next/Back; the repo mirrors the
   * change into the root form's groupVisibility map. `null` for non-wizard
   * pages — leave it untouched.
   */
  readonly wizardState: WizardState | null;
  /**
   * Server-side filters currently applied to this page's form, as they were sent in
   * the OpenForm `filter=` query. Empty = unfiltered.
   *
   * Filtering re-opens the form (see `PageService.reopenWithFilters`), so this is
   * REPLACED on every open/re-open and is always the full truth — never a delta. It
   * is echoed back to the caller as `activeFilters` so an agent can tell what it is
   * actually looking at instead of tracking filters on its own side.
   */
  readonly activeFilters: readonly OpenFormFilter[];
}
