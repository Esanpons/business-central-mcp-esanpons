import { v4 as uuid } from 'uuid';
import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type {
  BCEvent, OpenFormInteraction, LoadFormInteraction, CloseFormInteraction, InvokeActionInteraction, SetCurrentRowInteraction,
} from '../protocol/types.js';
import { buildFormTree } from '../protocol/form-tree-builder.js';
import { fields as treeFields, repeaters as treeRepeaters } from '../protocol/form-views.js';
import { walkTree } from '../protocol/form-tree-walk.js';
import { isFormHostNode, isGroupNode, isLogicalFormNode } from '../protocol/form-node.js';
import type { Logger } from '../core/logger.js';
import type { SectionKind } from '../protocol/section-resolver.js';
import type { WizardState } from '../protocol/types.js';

/**
 * Recognise the NavigatePage / multi-step wizard pattern. Returns null for
 * pages that don't qualify — non-wizard PageType, fewer than two participating
 * step gcs, or no initially-visible step.
 *
 * Detection is anchored on `ExpressionProperties.Visible` (stored as
 * `node.properties.hasVisibleExpression` in the FormNode tree) AND
 * `DesignName` starting with "Step" (stored as `node.properties.designName`).
 * This mirrors the legacy `parseControlTree` wizard-step detection and the
 * BC web client's own classification from
 * `NavigatePageActionControlHelper.cs` (decompiled).
 */
function buildWizardState(controlTree: unknown): WizardState | null {
  if (!controlTree || typeof controlTree !== 'object') return null;
  const raw = controlTree as Record<string, unknown>;
  if (raw.t !== 'lf') return null;

  const tree = buildFormTree(controlTree);
  if (!isLogicalFormNode(tree)) return null;
  if (tree.pageType !== 'NavigatePage' && tree.pageType !== 'StandardDialog') return null;

  const dynamicSteps: Array<{ controlPath: string; initiallyVisible: boolean }> = [];
  for (const child of tree.children) {
    if (!isGroupNode(child)) continue;
    if (!child.properties.hasVisibleExpression) continue;
    const designName = child.properties.designName ?? '';
    if (!/^Step/i.test(designName)) continue;
    dynamicSteps.push({
      controlPath: child.controlPath,
      initiallyVisible: child.properties.visible ?? true,
    });
  }

  if (dynamicSteps.length < 2) return null;
  const initialIndex = dynamicSteps.findIndex(s => s.initiallyVisible);
  if (initialIndex < 0) return null;

  return { stepPaths: dynamicSteps.map(s => s.controlPath), currentStepIndex: initialIndex };
}

export interface ClosePageResult {
  events: BCEvent[];
}

/** Default section kinds that are auto-loaded when a page is opened. */
export const DEFAULT_AUTO_LOAD_SECTIONS: readonly SectionKind[] = ['header', 'lines', 'subpage', 'factbox'];

export class PageService {
  private readonly autoLoadSections: readonly SectionKind[];

  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
    options?: { autoLoadSections?: readonly SectionKind[] },
  ) {
    this.autoLoadSections = options?.autoLoadSections ?? DEFAULT_AUTO_LOAD_SECTIONS;
  }

  async openPage(pageId: string, options?: { bookmark?: string; tenantId?: string }): Promise<Result<PageContext, ProtocolError>> {
    const tenantId = options?.tenantId ?? 'default';
    let query = `page=${pageId}&tenant=${tenantId}`;
    if (options?.bookmark) {
      query += `&bookmark=${encodeURIComponent(options.bookmark)}`;
    }

    const interaction: OpenFormInteraction = {
      type: 'OpenForm',
      query,
      controlPath: 'server:c[0]',
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted',
    );

    if (!isOk(result)) return result;

    const events = result.value;
    const pageContextId = `session:page:${pageId}:${uuid().substring(0, 8)}`;

    // Resolve the page root: prefer FormCreated (regular page). Fall back to
    // DialogOpened for modal-rooted pages — wizards (NavigatePage), request
    // pages (StandardDialog), confirmation prompts. The ownerless DialogOpened
    // arrives in the same OpenForm response and IS the page.
    const formCreated = events.find((e): e is BCEvent & { type: 'FormCreated' } => e.type === 'FormCreated' && !e.parentFormId);
    const dialogOpened = !formCreated
      ? events.find((e): e is BCEvent & { type: 'DialogOpened' } => e.type === 'DialogOpened')
      : undefined;
    const root = formCreated ?? dialogOpened;

    if (!root) {
      this.logger.warn(`No FormCreated/DialogOpened event for page ${pageId}. Events: ${events.map(e => e.type).join(', ')}`);
      return err(new ProtocolError(`Page ${pageId} did not return a form root. Events: ${events.map(e => e.type).join(', ')}`));
    }

    const formId = root.formId;
    const isModal = root.type === 'DialogOpened';

    // Inspect the root tree once now to decide whether this is a wizard
    // (NavigatePage with ≥2 dynamic-visibility step gcs). The repo's
    // applyRootControlTree will re-parse the same tree internally; that's
    // fine — parsing is cheap and stateless.
    const wizardState = buildWizardState(root.controlTree);

    // Create page context and apply all events. The repo recognises a
    // DialogOpened whose formId equals rootFormId and treats it as the root
    // layout (see applyRootControlTree).
    this.repo.create(pageContextId, formId, { isModal, wizardState });
    this.repo.applyToPage(pageContextId, events);

    // Discover child forms embedded in the root form's control tree (fhc -> lf nodes)
    await this.discoverAndLoadChildForms(pageContextId, events);

    const finalState = this.repo.get(pageContextId);
    if (!finalState) {
      return err(new ProtocolError(`Failed to create page context for page ${pageId}`));
    }

    this.logger.info(`Page opened: ${pageId} (${pageContextId}, formId: ${formId})`);
    return ok(finalState);
  }

  private async discoverAndLoadChildForms(pageContextId: string, openEvents: BCEvent[]): Promise<void> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return;

    // Collect child form IDs to load data for
    const childFormIds: string[] = [];

    // Source 1: Child forms from separate FormCreated events (rare, but possible)
    for (const e of openEvents) {
      if (e.type === 'FormCreated' && e.formId !== ctx.rootFormId) {
        childFormIds.push(e.formId);
      }
    }

    // Source 2: Child forms embedded in root form's control tree as fhc -> lf nodes
    const rootFormCreated = openEvents.find(e => e.type === 'FormCreated' && e.formId === ctx.rootFormId);
    if (rootFormCreated?.type === 'FormCreated' && rootFormCreated.controlTree) {
      try {
        const rootTree = buildFormTree(rootFormCreated.controlTree);
        for (const node of walkTree(rootTree)) {
          if (!isFormHostNode(node) || !node.hostedFormServerId) continue;
          this.repo.registerDiscoveredChildForm(pageContextId, {
            serverId: node.hostedFormServerId,
            caption: node.hostedFormCaption,
            controlTree: node.hostedFormControlTree,
            isSubForm: node.hostedFormIsSubForm,
            isPart: node.hostedFormIsPart,
          });
          childFormIds.push(node.hostedFormServerId);
          this.logger.debug('page', `Discovered child form: ${node.hostedFormServerId} (${node.hostedFormCaption}, subform=${node.hostedFormIsSubForm}, part=${node.hostedFormIsPart})`);
        }
      } catch {
        // Non-fatal: child form discovery failure shouldn't abort the page open
      }
    }

    // Load data for all child forms (only lines subpage and key parts, skip most factboxes)
    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return;

    for (const childFormId of childFormIds) {
      // Only load data for sections whose kind is in the auto-load list
      const section = Array.from(updatedCtx.sections.values()).find(s => s.formId === childFormId);
      if (!section) continue;
      if (!this.autoLoadSections.includes(section.kind)) continue;

      // Step 1: LoadForm to initialize the child form on the server.
      // For factboxes, openForm:true is needed -- without it, CanLoadData() returns false
      // because the form was already opened during control tree parsing. openForm resets
      // the form state so LoadData() can populate field values.
      // Verified from decompiled LoadFormInteraction.cs: OpenForm -> LoadData chain.
      // Role Center hosted CardParts (cuegroups) follow the same pattern: BC won't
      // populate cue StringValues without openForm:true, since the form was already
      // opened during root-tree parsing.
      const ctxForKind = this.repo.get(pageContextId);
      const isRoleCenterChild = ctxForKind?.pageType === 'RoleCenter' && section.kind === 'subpage';
      const isFactbox = section.kind === 'factbox';
      const loadInteraction: LoadFormInteraction = {
        type: 'LoadForm',
        formId: childFormId,
        loadData: true,
        delayed: false,
        openForm: isFactbox || isRoleCenterChild,
      };

      const loadResult = await this.session.invoke(
        loadInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded' || event.type === 'PropertyChanged',
      );

      if (isOk(loadResult)) {
        this.repo.applyToPage(pageContextId, loadResult.value);
      }

      if (isRoleCenterChild) {
        // Cue StringValues are computed server-side in response to a refresh
        // on the hosted CardPart. Without this, cue tiles parse correctly
        // but their values stay at the initial "0" stub.
        const refreshInteraction: InvokeActionInteraction = {
          type: 'InvokeAction',
          formId: childFormId,
          controlPath: 'server:',
          systemAction: 30, // SystemAction.Refresh
        };
        const refreshResult = await this.session.invoke(
          refreshInteraction,
          (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
        );
        if (isOk(refreshResult)) {
          this.repo.applyToPage(pageContextId, refreshResult.value);
        }
      }

      // Step 2: Refresh the child form's repeater to trigger DataLoaded.
      // BC sends lines data as DataLoaded on the ROOT formId with the child's controlPath.
      // LoadForm alone doesn't trigger DataLoaded for subpage repeaters.
      if (section.repeaterControlPath) {
        const refreshInteraction: InvokeActionInteraction = {
          type: 'InvokeAction',
          formId: childFormId,
          controlPath: section.repeaterControlPath,
          systemAction: 30, // SystemAction.Refresh
        };

        const refreshResult = await this.session.invoke(
          refreshInteraction,
          (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
        );

        if (isOk(refreshResult)) {
          this.repo.applyToPage(pageContextId, refreshResult.value);
        }
      }
    }

    // Step 3: Trigger factbox data population by selecting the current row.
    // BC populates factbox data server-side in response to SetCurrentRow on the
    // parent repeater. Without this, factbox forms have field metadata but empty values.
    // Verified from decompiled WebLogicalFormObserver.cs and live WebSocket capture.
    await this.triggerFactboxRefresh(pageContextId);

    // After factbox refresh: any factbox section whose form yielded no field
    // nodes is dead (BC returned a stub). buildFormTree already skips
    // MappingHint='PlaceholderField' nodes (form-tree-builder.ts), so a
    // genuinely populated factbox always has at least one FieldNode here.
    // Mark empty ones invalid so Section DTO builders skip them.
    const finalCtx = this.repo.get(pageContextId);
    if (finalCtx) {
      for (const [sectionId, sec] of finalCtx.sections) {
        if (sec.kind !== 'factbox') continue;
        const f = finalCtx.forms.get(sec.formId);
        if (!f) continue;
        if (treeFields(f.root).length === 0) {
          this.repo.invalidateSection(pageContextId, sectionId);
        }
      }
    }
  }

  private async triggerFactboxRefresh(pageContextId: string): Promise<void> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return;

    // Collect factbox sections
    const factboxSections = Array.from(ctx.sections.entries()).filter(([, s]) => s.kind === 'factbox');
    if (factboxSections.length === 0) return;

    // Find the root form's repeater to select a row (triggers server-side factbox Query change)
    const rootForm = ctx.forms.get(ctx.rootFormId);
    if (!rootForm) return;

    for (const [repPath] of treeRepeaters(rootForm.root)) {
      const repRows = rootForm.rows.get(repPath) ?? [];
      const firstRow = repRows[0];
      if (!firstRow?.bookmark) continue;

      // Step 1: Select the first row to trigger factbox Query property change on the server.
      // The server-side WebLogicalFormObserver registers a "Query" change on child forms.
      const selectResult = await this.session.invoke(
        { type: 'SetCurrentRow', formId: ctx.rootFormId, controlPath: repPath, key: firstRow.bookmark } as SetCurrentRowInteraction,
        (event) => event.type === 'InvokeCompleted',
      );
      if (isOk(selectResult)) {
        this.repo.applyToPage(pageContextId, selectResult.value);
      }

      // Step 2: Re-load each factbox with openForm+loadData to force data refresh.
      // LoadFormInteraction.CanLoadData() only returns true if DataLoaded is false.
      // After the initial LoadForm, DataLoaded is true. OpenForm resets form state.
      // Verified from decompiled LoadFormInteraction.cs: OpenForm -> LoadData chain.
      for (const [, sec] of factboxSections) {
        const loadResult = await this.session.invoke(
          { type: 'LoadForm', formId: sec.formId, loadData: true, delayed: true, openForm: true } as LoadFormInteraction,
          (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged' || event.type === 'DataLoaded',
        );
        if (isOk(loadResult)) {
          this.repo.applyToPage(pageContextId, loadResult.value);
        }
      }
      break;
    }
  }

  async closePage(pageContextId: string, options?: { discardChanges?: boolean }): Promise<Result<ClosePageResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const allEvents: BCEvent[] = [];
    for (const formId of ctx.ownedFormIds) {
      const closeInteraction: CloseFormInteraction = { type: 'CloseForm', formId };
      const result = await this.session.invoke(closeInteraction, (event) => event.type === 'InvokeCompleted');
      if (isOk(result)) {
        allEvents.push(...result.value);

        // Handle "save changes?" dialogs triggered by CloseForm.
        // When discardChanges is true, auto-dismiss with "no" to complete the close.
        // Otherwise, the dialog info is returned in events for the caller to handle.
        if (options?.discardChanges) {
          for (const event of result.value) {
            if (event.type === 'DialogOpened' && event.formId) {
              this.logger.info(`Close triggered dialog (formId=${event.formId}), dismissing with "no"`);
              const dismissResult = await this.session.invoke(
                { type: 'InvokeAction', formId: event.formId, controlPath: 'server:', systemAction: 390 } as InvokeActionInteraction, // No=390
                (e) => e.type === 'InvokeCompleted',
              );
              if (isOk(dismissResult)) {
                allEvents.push(...dismissResult.value);
              }
              this.session.removeOpenForm(event.formId);
            }
          }
        }
      }
      this.session.removeOpenForm(formId);
    }

    this.repo.remove(pageContextId);
    this.logger.info(`Page closed: ${pageContextId}`);
    return ok({ events: allEvents });
  }

  getPageContext(pageContextId: string): PageContext | undefined {
    return this.repo.get(pageContextId);
  }
}
