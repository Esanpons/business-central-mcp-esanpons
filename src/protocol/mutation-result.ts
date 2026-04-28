// src/protocol/mutation-result.ts
import type { BCEvent, DialogOpenedEvent, ControlField } from './types.js';
import type { PageContext } from './page-context.js';
import { buildFormTree } from './form-tree-builder.js';
import { fields as treeFields } from './form-views.js';
import { fieldNodeToControlField } from './mcp-adapters.js';

/**
 * Shared envelope returned by all mutating operations (write-data, execute-action,
 * navigate, close-page). Surfaces which sections changed, whether dialogs opened,
 * and whether the caller must respond to a dialog before continuing.
 */
export interface MutationResult<T = void> {
  readonly success: boolean;
  readonly value?: T;
  readonly changedSections: string[];
  readonly openedPages: Array<{ pageContextId: string; caption: string }>;
  readonly dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
  readonly requiresDialogResponse: boolean;
}

/**
 * After a mutating invoke, check which sections received events by matching
 * event formIds to the section map. If the root formId was touched, all
 * sections are considered changed (root events cascade via cross-form routing).
 */
export function detectChangedSections(
  ctx: PageContext,
  events: BCEvent[],
): string[] {
  const changedFormIds = new Set<string>();
  for (const event of events) {
    const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
    if (formId) changedFormIds.add(formId);
  }

  const changedSections: string[] = [];
  for (const [sectionId, section] of ctx.sections) {
    if (changedFormIds.has(section.formId)) {
      changedSections.push(sectionId);
    }
  }

  // Root form events may cascade to lines via cross-form routing
  if (changedFormIds.has(ctx.rootFormId)) {
    for (const [sectionId] of ctx.sections) {
      if (!changedSections.includes(sectionId)) {
        changedSections.push(sectionId);
      }
    }
  }

  return changedSections;
}

/**
 * Extract dialog information from events. Tries to pull a human-readable
 * message from the dialog control tree (Caption or Message property).
 */
export function detectDialogs(events: BCEvent[]): Array<{ formId: string; message?: string; fields?: ControlField[] }> {
  return events
    .filter((e): e is DialogOpenedEvent => e.type === 'DialogOpened')
    .map(e => {
      const raw = e.controlTree as Record<string, unknown> | undefined;
      const message = (raw?.Caption as string) || (raw?.Message as string) || undefined;

      // Build the dialog's FormNode tree to extract structured fields.
      // Dialog controlTree nodes may arrive as a bare object (no `t` field) or
      // as a proper `lf` LogicalForm node. Normalise to `lf` when absent so
      // buildFormTree can process children in either case.
      let fields: ControlField[] | undefined;
      if (raw && typeof raw.Children !== 'undefined') {
        const lfNode = raw.t === 'lf' ? raw : { ...raw, t: 'lf' };
        try {
          const root = buildFormTree(lfNode);
          const nodeFields = treeFields(root);
          if (nodeFields.length > 0) {
            fields = nodeFields.map(f => fieldNodeToControlField(root, f));
          }
        } catch {
          // Non-fatal: dialog field extraction failure should not abort the operation
        }
      }

      return { formId: e.formId, message, fields };
    });
}
