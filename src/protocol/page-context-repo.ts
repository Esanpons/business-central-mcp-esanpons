// src/protocol/page-context-repo.ts
import { ProtocolError } from '../core/errors.js';
import type { BCEvent } from './types.js';
import type { PageContext } from './page-context.js';
import type { OpenFormFilter } from './filter-query.js';
import type { FormState } from './form-state.js';
import { FormProjection } from './form-state.js';
import { SectionResolver } from './section-resolver.js';
import type { SectionDescriptor } from './section-resolver.js';
import { tryBuildFormTree } from './form-tree-builder.js';
import { isFormHostNode, isLogicalFormNode } from './form-node.js';
import { walkTree } from './form-tree-walk.js';
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
    options?: {
      isModal?: boolean;
      wizardState?: PageContext['wizardState'];
      activeFilters?: readonly OpenFormFilter[];
      /** Open parameters, persisted so a re-open can reproduce them exactly. */
      pageId?: string;
      tenantId?: string;
      openMode?: PageContext['openMode'];
      bookmark?: string;
    },
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
      activeFilters: options?.activeFilters ?? [],
      ...(options?.pageId ? { pageId: options.pageId } : {}),
      ...(options?.tenantId ? { tenantId: options.tenantId } : {}),
      ...(options?.openMode ? { openMode: options.openMode } : {}),
      ...(options?.bookmark ? { bookmark: options.bookmark } : {}),
    };

    this.pages.set(pageContextId, ctx);
    this.formIdIndex.set(rootFormId, pageContextId);
    return ctx;
  }

  /**
   * Move an existing context to a different pageContextId, keeping its forms and
   * sections. Used by the transactional re-open (`PageService.reopenWithFilters`),
   * which materializes the filtered page under a temporary id FIRST and only
   * adopts the caller's id once the new page is known to be good.
   */
  rekey(fromPageContextId: string, toPageContextId: string): PageContext | undefined {
    const page = this.pages.get(fromPageContextId);
    if (!page) return undefined;
    if (fromPageContextId === toPageContextId) return page;
    this.pages.delete(fromPageContextId);
    const moved: PageContext = { ...page, pageContextId: toPageContextId };
    this.pages.set(toPageContextId, moved);
    for (const fId of moved.ownedFormIds) {
      if (this.formIdIndex.get(fId) === fromPageContextId) this.formIdIndex.set(fId, toPageContextId);
    }
    return moved;
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
    // New child form: route to whoever owns the PARENT form, not to the context the
    // batch happens to be applied to. Same reasoning as the ownerless case below —
    // after a drill-down the identical batch is applied to source and target, and
    // force-routing put the target's factbox/subform into the source page too (and,
    // being last-write-wins, stole its formId index entry).
    if (event.type === 'FormCreated' && event.parentFormId) {
      const parentPcId = this.formIdIndex.get(event.parentFormId)
        ?? (this.ownsForm(targetPcId, event.parentFormId) ? targetPcId : undefined);
      if (parentPcId) {
        this.addChildForm(parentPcId, event);
      }
      return;
    }

    // FormCreated for root form (no parentFormId): update existing form.
    //
    // targetPcId must NOT force-route here. An ownerless FormCreated in an event
    // batch is very often a BRAND NEW page (drill-down target, "New" card, cue
    // page) that BC delivered while the batch was being applied to the SOURCE
    // context. Routing it into the source's updateRootForm overwrote the source
    // page's pageType/caption with the new page's and left a stray FormState in
    // its `forms` map that later stole cross-form-routed DataLoaded events.
    // Only accept the event for a context that actually owns this formId.
    if (event.type === 'FormCreated' && !event.parentFormId) {
      const indexedPcId = this.formIdIndex.get(formId);
      const pcId = this.ownsForm(targetPcId, formId) ? targetPcId : indexedPcId;
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
      const directPcId = this.ownsForm(targetPcId, formId) ? targetPcId : this.formIdIndex.get(formId);
      if (directPcId) {
        const page = this.pages.get(directPcId);
        if (page && page.rootFormId === formId) {
          this.applyRootControlTree(directPcId, formId, event.controlTree);
          return;
        }
      }
      // Owner routing wins over the invocation's target context: the same event
      // batch is applied to BOTH the source and the target context after a
      // drill-down / action, and letting targetPcId override put one dialog in two
      // contexts. Closing either page then sent CloseForm for it and left the other
      // context holding a dead dialog entry.
      const ownerIndexedPcId = event.ownerFormId ? this.formIdIndex.get(event.ownerFormId) : undefined;
      const ownerPcId = ownerIndexedPcId ?? targetPcId;
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

  /** True when `pcId` names a page that already owns `formId` (as root or child). */
  private ownsForm(pcId: string | undefined, formId: string): pcId is string {
    if (!pcId) return false;
    const page = this.pages.get(pcId);
    if (!page) return false;
    return page.rootFormId === formId || page.forms.has(formId);
  }

  /**
   * Is this child form a genuine SUBFORM (the document's lines) rather than a part?
   * A `FormCreated` carries no IsSubForm flag, but the parent's control tree does:
   * BC publishes the hosting `fhc` node with IsSubForm/IsPart. Look the child up
   * there; when the parent has no such host node, assume "not a subform" — a part
   * that merely contains a repeater must not turn the host page into a Document.
   */
  private isHostedSubForm(page: PageContext, parentFormId: string | undefined, childFormId: string): boolean {
    const parentForm = page.forms.get(parentFormId ?? page.rootFormId) ?? page.forms.get(page.rootFormId);
    if (!parentForm) return false;
    for (const node of walkTree(parentForm.root)) {
      if (isFormHostNode(node) && node.hostedFormServerId === childFormId) {
        return node.hostedFormIsSubForm === true;
      }
    }
    return false;
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

    // Derive section from the tree we JUST built (deriveSection would otherwise
    // parse the same controlTree a second time).
    const section = this.sectionResolver.deriveSection(page, event.formId, event.controlTree, {
      isSubForm: this.isHostedSubForm(page, event.parentFormId, event.formId),
      root: tree,
    });

    // Update PageContext
    const forms = new Map(page.forms);
    forms.set(event.formId, withData);

    const sections = new Map(page.sections);
    sections.set(section.sectionId, section);

    this.pages.set(pcId, {
      ...page,
      forms,
      sections,
      pageType: this.inferPageType(page, sections),
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    // Index the new formId AFTER creation
    this.formIdIndex.set(event.formId, pcId);
  }

  /**
   * A page with a real lines subform is a Document — but only when BC has not
   * already told us what the page is. The root form's own PageType is
   * authoritative; overriding it from part shape made every Card that embeds a
   * ListPart report itself as a Document.
   */
  private inferPageType(page: PageContext, sections: ReadonlyMap<string, SectionDescriptor>): PageContext['pageType'] {
    if (page.pageType !== 'Unknown') return page.pageType;
    for (const s of sections.values()) {
      if (s.kind === 'lines') return 'Document';
    }
    return page.pageType;
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

    // Prune the closed form from the append-only bookkeeping so long-lived
    // contexts don't accumulate dead dialog control trees and stale form
    // references for the life of the process (M12). The root form is left in
    // place — the page stays addressable until it is explicitly closed.
    const dialogs = page.dialogs.filter(d => d.formId !== formId);
    const isRoot = formId === page.rootFormId;
    const ownedFormIds = !isRoot
      ? page.ownedFormIds.filter(f => f !== formId)
      : page.ownedFormIds;
    // Drop the dead FormState too. Leaving it in `forms` was the other half of the
    // leak: findChildFormByRepeaterPath scans forms in insertion order and matches
    // on a FORM-RELATIVE controlPath, so after BC closed and re-created a lines
    // subform, every new DataLoaded folded into the dead copy and the live one
    // stayed empty.
    const forms = !isRoot && page.forms.has(formId)
      ? new Map([...page.forms].filter(([fId]) => fId !== formId))
      : page.forms;
    if (!isRoot && this.formIdIndex.get(formId) === pcId) {
      this.formIdIndex.delete(formId);
    }

    const pruned = dialogs.length !== page.dialogs.length
      || ownedFormIds.length !== page.ownedFormIds.length
      || forms !== page.forms;
    if (!changed && !pruned) return;

    this.pages.set(pcId, { ...page, sections, dialogs, ownedFormIds, forms });
  }

  private addDialog(pcId: string, event: BCEvent & { type: 'DialogOpened' }): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    // Idempotent: the same DialogOpened can reach this page more than once (the
    // event batch of an action is applied to several contexts). One formId must
    // never produce two dialog entries / two ownedFormIds.
    const dialogs = page.dialogs.some(d => d.formId === event.formId)
      ? page.dialogs.map(d => (d.formId === event.formId
        ? { formId: event.formId, ownerFormId: event.ownerFormId, controlTree: event.controlTree }
        : d))
      : [...page.dialogs, { formId: event.formId, ownerFormId: event.ownerFormId, controlTree: event.controlTree }];
    const ownedFormIds = page.ownedFormIds.includes(event.formId)
      ? page.ownedFormIds
      : [...page.ownedFormIds, event.formId];

    this.pages.set(pcId, { ...page, dialogs, ownedFormIds });

    this.formIdIndex.set(event.formId, pcId);
  }

  /**
   * Find a child form (not rootFormId) that has a repeater at the given controlPath.
   * Restricted to forms a CURRENTLY VALID section points at: controlPaths are
   * form-relative and therefore collide across forms, so an unreferenced form is
   * both unreachable by the caller and a magnet for other forms' row events.
   */
  private findChildFormByRepeaterPath(page: PageContext, excludeFormId: string, controlPath: string): FormState | undefined {
    for (const [, section] of page.sections) {
      if (!section.valid) continue;
      if (section.formId === excludeFormId) continue;
      const form = page.forms.get(section.formId);
      if (!form) continue;
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

    // Derive section: use IsSubForm to distinguish lines from parts. Both
    // derivations live in SectionResolver so every sectionId in a context comes
    // from the same uniqueness rule. The tree built above is reused (deriveSection
    // would otherwise parse the same controlTree again).
    const section = child.isSubForm
      ? this.sectionResolver.deriveSection(page, child.serverId, child.controlTree, { isSubForm: true, root: tree })
      : this.sectionResolver.deriveFactboxSection(page, child);

    const forms = new Map(page.forms);
    forms.set(child.serverId, childForm);

    const sections = new Map(page.sections);
    sections.set(section.sectionId, section);

    this.pages.set(pcId, {
      ...page,
      forms,
      sections,
      pageType: this.inferPageType(page, sections),
      ownedFormIds: [...page.ownedFormIds, child.serverId],
    });

    this.formIdIndex.set(child.serverId, pcId);
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

  /**
   * Build the canonical "unknown page context" error, listing the page contexts
   * that ARE open so the caller can pick a valid one (or re-open) in a single
   * turn instead of a discovery round-trip. The open list is also attached as
   * `availablePageContexts` context for machine consumption.
   */
  notFoundError(pageContextId: string): ProtocolError {
    const open = this.listPageContextSummaries();
    const list = open.length > 0
      ? open.map(p => `"${p.id}" (${p.caption})`).join(', ')
      : 'none are open';
    return new ProtocolError(
      `Page context not found: ${pageContextId}. Open page contexts: ${list}. Open one with bc_open_page first.`,
      { availablePageContexts: open },
    );
  }

  get size(): number { return this.pages.size; }
}
