// src/protocol/page-context-repo.ts
import type { BCEvent } from './types.js';
import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';
import { FormProjection } from './form-state.js';
import { SectionResolver } from './section-resolver.js';
import { buildFormTree } from './form-tree-builder.js';
import { isLogicalFormNode, type FormNode } from './form-node.js';
import {
  fields as treeFields, repeaters as treeRepeaters,
} from './form-views.js';
import { applyPropertyChange } from './form-tree-mutator.js';

/**
 * Descriptor for a child form discovered inside a parent form's control tree
 * (via fhc -> lf nodes). Used by `PageContextRepository.registerDiscoveredChildForm`
 * to create a separate FormState for the child form.
 */
export interface DiscoveredChildForm {
  readonly serverId: string;       // lf node's ServerId (used as formId)
  readonly caption: string;
  readonly controlTree: unknown;   // raw lf node, built into a FormState separately
  readonly isSubForm: boolean;     // true for lines subpages
  readonly isPart: boolean;        // true for factboxes and parts
}

/** Build a FormNode tree from a raw control tree, returning null if the input is absent or lacks the lf wrapper. */
function tryBuildFormTree(raw: unknown): FormNode | null {
  if (!raw || typeof raw !== 'object') return null;
  if ((raw as Record<string, unknown>).t !== 'lf') return null;
  return buildFormTree(raw); // any throw here = real bug, surface it
}

export class PageContextRepository {
  private readonly pages = new Map<string, PageContext>();
  private readonly formIdIndex = new Map<string, string>();  // formId -> pageContextId
  private readonly formProjection = new FormProjection();
  private readonly sectionResolver = new SectionResolver();

  get(pageContextId: string): PageContext | undefined {
    return this.pages.get(pageContextId);
  }

  getByFormId(formId: string): PageContext | undefined {
    const id = this.formIdIndex.get(formId);
    return id ? this.pages.get(id) : undefined;
  }

  create(
    pageContextId: string,
    rootFormId: string,
    options?: { isModal?: boolean; wizardState?: PageContext['wizardState'] },
  ): PageContext {
    const rootForm = this.formProjection.createInitial(rootFormId);
    const headerSection = this.sectionResolver.createHeaderSection(rootFormId);

    const ctx: PageContext = {
      pageContextId,
      rootFormId,
      pageType: 'Unknown',
      caption: '',
      forms: new Map([[rootFormId, rootForm]]),
      sections: new Map([['header', headerSection]]),
      dialogs: [],
      ownedFormIds: [rootFormId],
      isModal: options?.isModal ?? false,
      wizardState: options?.wizardState ?? null,
    };

    this.pages.set(pageContextId, ctx);
    this.formIdIndex.set(rootFormId, pageContextId);
    return ctx;
  }

  /**
   * Mirror a NavigatePage step transition into the root form's groupVisibility
   * map. Hides every step participating in the wizard except the new active
   * one. Updates the page's wizardState pointer.
   *
   * BC's web client owns the step variable client-side and does not emit
   * PropertyChanged events when Next/Back is invoked — this method is the
   * authoritative source of step state on bc-mcp's side.
   */
  advanceWizardStep(pageContextId: string, newIndex: number): void {
    const page = this.pages.get(pageContextId);
    if (!page || !page.wizardState) return;
    const ws = page.wizardState;
    if (newIndex < 0 || newIndex >= ws.stepPaths.length) return;
    if (newIndex === ws.currentStepIndex) return;

    const rootForm = page.forms.get(page.rootFormId);
    if (!rootForm) return;

    // Apply wizard step visibility directly to the tree: set visible=true on the
    // active step group and visible=false on all others.
    let newTreeRoot = rootForm.root;
    for (let i = 0; i < ws.stepPaths.length; i++) {
      newTreeRoot = applyPropertyChange(newTreeRoot, ws.stepPaths[i]!, { visible: i === newIndex });
    }

    const updatedRoot: FormState = { ...rootForm, root: newTreeRoot };
    const forms = new Map(page.forms);
    forms.set(page.rootFormId, updatedRoot);

    this.pages.set(pageContextId, {
      ...page,
      forms,
      wizardState: { stepPaths: ws.stepPaths, currentStepIndex: newIndex },
    });
  }

  applyEvents(events: BCEvent[]): void {
    for (const event of events) {
      this.applyEvent(event);
    }
  }

  applyToPage(pageContextId: string, events: BCEvent[]): PageContext | undefined {
    for (const event of events) {
      this.applyEvent(event, pageContextId);
    }
    return this.pages.get(pageContextId);
  }

  private applyEvent(event: BCEvent, targetPcId?: string): void {
    const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
    if (!formId) return;

    // New child form: route by parentFormId (not indexed yet)
    if (event.type === 'FormCreated' && event.parentFormId) {
      const parentPcId = targetPcId ?? this.formIdIndex.get(event.parentFormId);
      if (parentPcId) {
        this.addChildForm(parentPcId, event);
      }
      return;
    }

    // FormCreated for root form (no parentFormId): update existing form
    if (event.type === 'FormCreated' && !event.parentFormId) {
      const pcId = targetPcId ?? this.formIdIndex.get(formId);
      if (pcId) {
        this.updateRootForm(pcId, event);
      }
      return;
    }

    // FormClosed: mark sections referencing this form as invalid
    if (event.type === 'FormClosed') {
      const pcId = targetPcId ?? this.formIdIndex.get(formId);
      if (pcId) {
        this.markFormClosed(pcId, formId);
      }
      return;
    }

    // Dialog: when the dialog's formId IS a page's rootFormId (modal-rooted page),
    // treat the dialog's controlTree as the page's root layout. Otherwise it's a
    // child dialog opened over an existing page (route via ownerFormId, fall back
    // to targetPcId when an ownerless dialog arrives during the open invocation).
    if (event.type === 'DialogOpened') {
      const directPcId = targetPcId ?? this.formIdIndex.get(formId);
      if (directPcId) {
        const page = this.pages.get(directPcId);
        if (page && page.rootFormId === formId) {
          this.applyRootControlTree(directPcId, formId, event.controlTree);
          return;
        }
      }
      const ownerPcId = event.ownerFormId
        ? (targetPcId ?? this.formIdIndex.get(event.ownerFormId))
        : targetPcId;
      if (ownerPcId) {
        this.addDialog(ownerPcId, event);
      }
      return;
    }

    // All other events: route by formId
    const pcId = targetPcId ?? this.formIdIndex.get(formId);
    if (!pcId) return;

    const page = this.pages.get(pcId);
    if (!page) return;

    const form = page.forms.get(formId);
    if (form) {
      const updated = this.formProjection.apply(form, event);

      // Check if the event was actually applied (repeater matched).
      // If not, and this is a DataLoaded/PropertyChanged/BookmarkChanged with a controlPath,
      // try routing to a child form whose repeater matches that controlPath.
      // BC sends lines data with the ROOT formId but a controlPath matching the child repeater.
      const controlPath = 'controlPath' in event ? (event as { controlPath: string }).controlPath : undefined;
      if (controlPath && updated === form) {
        const childForm = this.findChildFormByRepeaterPath(page, formId, controlPath);
        if (childForm) {
          const childUpdated = this.formProjection.apply(childForm, event);
          if (childUpdated !== childForm) {
            const forms = new Map(page.forms);
            forms.set(childForm.formId, childUpdated);
            this.pages.set(pcId, { ...page, forms });
            return;
          }
        }
      }

      // Route PropertyChanged events to factbox forms when the controlPath matches a factbox field.
      // BC sends factbox data changes on the ROOT formId. The controlPath matches a factbox
      // form's field controlPath. Verified from decompiled WebLogicalFormObserver.cs.
      if (controlPath && event.type === 'PropertyChanged' && formId === page.rootFormId) {
        const factboxForm = this.findFactboxFormByFieldPath(page, controlPath);
        if (factboxForm) {
          const childUpdated = this.formProjection.apply(factboxForm, event);
          if (childUpdated !== factboxForm) {
            const forms = new Map(page.forms);
            forms.set(factboxForm.formId, childUpdated);
            this.pages.set(pcId, { ...page, forms });
            return; // Don't also apply to root form
          }
        }
      }

      const forms = new Map(page.forms);
      forms.set(formId, updated);
      this.pages.set(pcId, { ...page, forms });
    }
  }

  private addChildForm(pcId: string, event: BCEvent & { type: 'FormCreated' }): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    // Create FormState for child
    const childForm = this.formProjection.createInitial(event.formId, event.parentFormId);
    const tree = tryBuildFormTree(event.controlTree) ?? childForm.root;
    const withData: FormState = {
      ...childForm,
      root: tree,
    };

    // Derive section
    const section = this.sectionResolver.deriveSection(page, event.formId, event.controlTree);

    // Update PageContext
    const forms = new Map(page.forms);
    forms.set(event.formId, withData);

    const sections = new Map(page.sections);
    sections.set(section.sectionId, section);

    // Infer Document page type if we have a lines section
    let pageType = page.pageType;
    for (const s of sections.values()) {
      if (s.kind === 'lines') { pageType = 'Document'; break; }
    }

    this.pages.set(pcId, {
      ...page,
      forms,
      sections,
      pageType,
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    // Index the new formId AFTER creation
    this.formIdIndex.set(event.formId, pcId);
  }

  private updateRootForm(pcId: string, event: BCEvent & { type: 'FormCreated' }): void {
    this.applyRootControlTree(pcId, event.formId, event.controlTree);
  }

  /**
   * Apply a control tree as the page's root form layout. Shared between
   * `FormCreated` (regular pages) and `DialogOpened` (modal-rooted pages such
   * as wizards / request pages).
   */
  private applyRootControlTree(pcId: string, formId: string, controlTree: unknown): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    const existingForm = page.forms.get(formId);
    const base = existingForm ?? this.formProjection.createInitial(formId);
    const tree = tryBuildFormTree(controlTree) ?? base.root;
    const updated: FormState = { ...base, root: tree };

    // Update pageType + caption from the new tree's root.
    const updatedPageType = isLogicalFormNode(tree) && tree.pageType !== 'Unknown' ? tree.pageType : page.pageType;
    const updatedCaption = isLogicalFormNode(tree) ? (tree.properties.caption || page.caption) : page.caption;

    const forms = new Map(page.forms);
    forms.set(formId, updated);

    this.pages.set(pcId, {
      ...page,
      forms,
      pageType: updatedPageType,
      caption: updatedCaption,
    });
  }

  /** Mark a section as invalid (no longer surfaced via buildSection / buildAllSections). */
  invalidateSection(pageContextId: string, sectionId: string): void {
    const page = this.pages.get(pageContextId);
    if (!page) return;
    const old = page.sections.get(sectionId);
    if (!old || !old.valid) return;
    const sections = new Map(page.sections);
    sections.set(sectionId, { ...old, valid: false });
    this.pages.set(pageContextId, { ...page, sections });
  }

  private markFormClosed(pcId: string, formId: string): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    // Mark any sections that reference this formId as invalid
    let changed = false;
    const sections = new Map(page.sections);
    for (const [sectionId, section] of sections) {
      if (section.formId === formId && section.valid) {
        sections.set(sectionId, { ...section, valid: false });
        changed = true;
      }
    }
    if (!changed) return;

    this.pages.set(pcId, { ...page, sections });
  }

  private addDialog(pcId: string, event: BCEvent & { type: 'DialogOpened' }): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    this.pages.set(pcId, {
      ...page,
      dialogs: [...page.dialogs, { formId: event.formId, ownerFormId: event.ownerFormId, controlTree: event.controlTree }],
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    this.formIdIndex.set(event.formId, pcId);
  }

  /** Find a child form (not rootFormId) that has a repeater at the given controlPath. */
  private findChildFormByRepeaterPath(page: PageContext, excludeFormId: string, controlPath: string): FormState | undefined {
    for (const [fId, form] of page.forms) {
      if (fId === excludeFormId) continue;
      if (treeRepeaters(form.root).has(controlPath)) return form;
    }
    return undefined;
  }

  /** Find a factbox form that has a field at the given controlPath. */
  private findFactboxFormByFieldPath(page: PageContext, controlPath: string): FormState | undefined {
    for (const [, section] of page.sections) {
      if (section.kind !== 'factbox') continue;
      const form = page.forms.get(section.formId);
      if (!form) continue;
      if (treeFields(form.root).some(f => f.controlPath === controlPath)) return form;
    }
    return undefined;
  }

  /** Register a child form discovered from fhc/lf nodes in the control tree. */
  registerDiscoveredChildForm(pcId: string, child: DiscoveredChildForm): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    // Don't re-register if already known
    if (page.forms.has(child.serverId)) return;

    // Build the child form's state from the tree
    const tree = tryBuildFormTree(child.controlTree);
    const childForm: FormState = {
      ...this.formProjection.createInitial(child.serverId, page.rootFormId),
      ...(tree ? { root: tree } : {}),
    };

    // Derive section: use IsSubForm to distinguish lines from factboxes
    const section = child.isSubForm
      ? this.sectionResolver.deriveSection(page, child.serverId, child.controlTree)
      : this.deriveFactboxSection(page, child);

    const forms = new Map(page.forms);
    forms.set(child.serverId, childForm);

    const sections = new Map(page.sections);
    sections.set(section.sectionId, section);

    let pageType = page.pageType;
    if (section.kind === 'lines') pageType = 'Document';

    this.pages.set(pcId, {
      ...page,
      forms,
      sections,
      pageType,
      ownedFormIds: [...page.ownedFormIds, child.serverId],
    });

    this.formIdIndex.set(child.serverId, pcId);
  }

  private deriveFactboxSection(page: PageContext, child: DiscoveredChildForm) {
    const caption = child.caption || 'FactBox';
    const base = `factbox:${caption}`;
    let sectionId = base;
    if (page.sections.has(sectionId)) {
      for (let i = 2; ; i++) {
        sectionId = `${base}#${i}`;
        if (!page.sections.has(sectionId)) break;
      }
    }
    return {
      sectionId,
      kind: 'factbox' as const,
      caption,
      formId: child.serverId,
      valid: true,
    };
  }

  remove(pageContextId: string): void {
    const page = this.pages.get(pageContextId);
    if (page) {
      for (const fId of page.ownedFormIds) this.formIdIndex.delete(fId);
    }
    this.pages.delete(pageContextId);
  }

  /** Remove all page contexts (e.g., after session recovery). */
  clearAll(): void {
    this.pages.clear();
    this.formIdIndex.clear();
  }

  listPageContextIds(): string[] { return Array.from(this.pages.keys()); }

  listPageContextSummaries(): Array<{ id: string; caption: string }> {
    return Array.from(this.pages.entries()).map(([id, ctx]) => ({
      id,
      caption: ctx.caption || `Page (${ctx.pageType})`,
    }));
  }
  get size(): number { return this.pages.size; }
}
