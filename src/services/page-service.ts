import { v4 as uuid } from 'uuid';
import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError, PageOpenRejectedError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext, PageOpenMode } from '../protocol/page-context.js';
import type {
  BCEvent, DialogOpenedEvent, OpenFormInteraction, LoadFormInteraction, CloseFormInteraction, InvokeActionInteraction, SetCurrentRowInteraction,
} from '../protocol/types.js';
import { buildFormTree } from '../protocol/form-tree-builder.js';
import { fields as treeFields, repeaters as treeRepeaters, cues as treeCues } from '../protocol/form-views.js';
import { walkTree } from '../protocol/form-tree-walk.js';
import { isFormHostNode, isGroupNode, isLogicalFormNode } from '../protocol/form-node.js';
import type { Logger } from '../core/logger.js';
import type { SectionKind } from '../protocol/section-resolver.js';
import type { WizardState } from '../protocol/types.js';
import { buildOpenFormFilter, type OpenFormFilter } from '../protocol/filter-query.js';
import { classifyDialog } from '../protocol/mutation-result.js';

/**
 * `mode=` values BC's OpenForm query accepts, mirroring the web client URL.
 * `Create` opens a NEW, initialised record (runs OnNewRecord / No. Series) instead
 * of positioning on an existing one — the only way to create a record over the
 * protocol, since `InvokeAction(New)` on a card just navigates.
 *
 * Defined in protocol/page-context.ts (the PageContext persists it for re-opens);
 * re-exported here under the name the services/operations layer uses.
 */
export type OpenFormMode = PageOpenMode;

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

/**
 * BC's own message when an OpenForm was answered with an ERROR DIALOG rather
 * than a form, or undefined when this dialog is a normal one (a wizard, a
 * request page, a confirmation — all of which ARE the page and must be kept).
 *
 * The marker is the wire type `lmd` (logical message dialog) carrying an
 * `ExceptionType`; `Caption` is just "Error" and `Message` holds the reason.
 * Captured live on devel1 by opening page 132 with a bookmark from another
 * table's list:
 *   { t: 'lmd', Caption: 'Error', ExceptionType: 1, DialogType: 3,
 *     Message: "No se puede utilizar un RecordID de la tabla 'Sales Shipment
 *               Header' con un registro de la tabla 'Sales Invoice Header'." }
 */
function errorDialogMessage(controlTree: unknown): string | undefined {
  if (!controlTree || typeof controlTree !== 'object') return undefined;
  const raw = controlTree as Record<string, unknown>;
  // A CONFIRM is an `lmd` too, and it carries `ExceptionType: 0` (measured live on
  // devel1, 2026-10-03) — "has an ExceptionType" is not "is an error". The shared
  // classifier reads MappingHint / DialogType / a non-zero ExceptionType.
  if (classifyDialog(raw) !== 'error') return undefined;
  const message = typeof raw.Message === 'string' ? raw.Message.trim() : '';
  if (message) return message;
  const caption = typeof raw.Caption === 'string' ? raw.Caption.trim() : '';
  return caption || 'BC returned an error dialog with no message.';
}

export interface ClosePageResult {
  events: BCEvent[];
  /**
   * The dialogs that are STILL OPEN after the close, for the caller to answer. Not
   * every DialogOpened in `events`: with `discardChanges` the save-changes question
   * is answered here, and reporting it anyway made bc_close_page say `success:false`
   * and point at a dialog that no longer existed, on a page context it had already
   * removed (bc-saas F-47 b).
   */
  pendingDialogs: DialogOpenedEvent[];
}

/**
 * Is this FactBox a dead stub (BC returned a placeholder with nothing in it)?
 *
 * A FactBox carries its content in one of three ways: loose fields (a CardPart),
 * cue tiles (a Role Center CardPart) or a REPEATER (a ListPart). The check used to
 * look only at the first two, and `fields()` does not count repeater columns, so
 * every ListPart FactBox was declared dead right after the page opened and stayed
 * unreadable for the life of the context: "Section 'factbox:Datos pendientes' not
 * found" while that very name was listed in availableSections (bc-saas F-59, F-66).
 * A ListPart with zero rows is not a stub either — it is an empty list, and its rows
 * may arrive later (a part whose visibility depends on the record, a FactBox BC
 * refreshes after an action).
 */
export function isDeadFactbox(root: Parameters<typeof treeFields>[0]): boolean {
  return treeFields(root).length === 0 && treeCues(root).length === 0 && treeRepeaters(root).size === 0;
}

/** Default section kinds that are auto-loaded when a page is opened. */
export const DEFAULT_AUTO_LOAD_SECTIONS: readonly SectionKind[] = ['header', 'lines', 'subpage', 'factbox'];

export class PageService {
  private readonly autoLoadSections: readonly SectionKind[];
  private readonly defaultTenantId: string;
  private readonly authMode: 'UserPassword' | 'AAD';

  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
    options?: { autoLoadSections?: readonly SectionKind[]; tenantId?: string; authMode?: 'UserPassword' | 'AAD' },
  ) {
    this.autoLoadSections = options?.autoLoadSections ?? DEFAULT_AUTO_LOAD_SECTIONS;
    this.defaultTenantId = options?.tenantId ?? 'default';
    this.authMode = options?.authMode ?? 'UserPassword';
  }

  async openPage(pageId: string, options?: { bookmark?: string; tenantId?: string; filters?: readonly OpenFormFilter[]; mode?: OpenFormMode }): Promise<Result<PageContext, ProtocolError>> {
    // Precedence: explicit per-call tenant > server-configured tenant > 'default'.
    const tenantId = options?.tenantId ?? this.defaultTenantId;
    const filters = options?.filters ?? [];
    const query = this.buildOpenFormQuery(pageId, tenantId, {
      bookmark: options?.bookmark,
      filter: buildOpenFormFilter(filters) || undefined,
      mode: options?.mode,
    });
    const pageContextId = `session:page:${pageId}:${uuid().substring(0, 8)}`;
    return this.materializePage(pageId, query, pageContextId, filters, {
      pageId,
      tenantId,
      ...(options?.mode ? { openMode: options.mode } : {}),
      ...(options?.bookmark ? { bookmark: options.bookmark } : {}),
    });
  }

  /**
   * Re-open a list page's form IN PLACE with an OpenForm `filter=` expression,
   * reusing the same pageContextId. This is how list filtering actually works on
   * BC27/BC28 (the filter pane is a no-op — see protocol/filter-query.ts). Pass an
   * empty array to clear the filter. The caller's pageContextId keeps pointing at
   * the freshly-filtered form, and the context's `activeFilters` is replaced with
   * exactly what was sent.
   *
   * TRANSACTIONAL: the filtered page is materialized under a temporary id FIRST and
   * the old one is closed only once the new one is known to be good. The previous
   * order (close + remove, then open) meant that the single most likely failure —
   * a localized caption instead of an AL field name, which BC rejects with "token
   * not found" — destroyed the working page context along with the request.
   */
  async reopenWithFilters(pageContextId: string, filters: readonly OpenFormFilter[]): Promise<Result<PageContext, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));

    const pageId = ctx.pageId ?? this.pageIdFromRootForm(ctx);
    if (!pageId) {
      return err(new ProtocolError(
        `Cannot filter ${pageContextId}: this context was not opened from a page id (drill-downs, cue pages and dialogs can't be re-opened in place). ` +
        `Open the list page with bc_open_page { pageId, filters } instead.`,
      ));
    }

    // Reuse the parameters the page was OPENED with. Rebuilding the query from the
    // server default silently dropped a per-call tenantId and the mode (a page
    // opened with mode=Create came back as a plain Edit of the first record).
    // The bookmark is deliberately NOT replayed: filtering re-positions the list,
    // and a bookmark excluded by the new filter is a BC error.
    const query = this.buildOpenFormQuery(pageId, ctx.tenantId ?? this.defaultTenantId, {
      filter: buildOpenFormFilter(filters) || undefined,
      ...(ctx.openMode ? { mode: ctx.openMode } : {}),
    });

    const stagingId = `${pageContextId}:refilter:${uuid().substring(0, 8)}`;
    const staged = await this.materializePage(pageId, query, stagingId, filters, {
      pageId,
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      ...(ctx.openMode ? { openMode: ctx.openMode } : {}),
    });
    if (!isOk(staged)) {
      // The original context is untouched and still usable.
      this.repo.remove(stagingId);
      return staged;
    }

    // The filtered page is live — now retire the old one and adopt its id.
    for (const formId of ctx.ownedFormIds) {
      await this.session.invoke({ type: 'CloseForm', formId }, (e) => e.type === 'InvokeCompleted').catch(() => undefined);
      this.session.removeOpenForm(formId);
    }
    this.repo.remove(pageContextId);
    const adopted = this.repo.rekey(stagingId, pageContextId);
    if (!adopted) return err(new ProtocolError(`Failed to re-key the filtered page context for ${pageContextId}`));
    return ok(adopted);
  }

  /** Page object id published by BC in the root form's `lf` metadata, when present. */
  private pageIdFromRootForm(ctx: PageContext): string | undefined {
    const rootForm = ctx.forms.get(ctx.rootFormId);
    if (!rootForm) return undefined;
    const root = rootForm.root;
    const id = isLogicalFormNode(root) ? root.metadata?.id : undefined;
    return id !== undefined && id > 0 ? String(id) : undefined;
  }

  private buildOpenFormQuery(pageId: string, tenantId: string, options?: { bookmark?: string; filter?: string; mode?: OpenFormMode }): string {
    // SaaS binds the tenant at session open (path-based URL); the OpenForm query
    // must not carry &tenant=. On-prem keeps the explicit query tenant.
    let query = this.authMode === 'AAD' ? `page=${pageId}` : `page=${pageId}&tenant=${tenantId}`;
    if (options?.bookmark) {
      query += `&bookmark=${encodeURIComponent(options.bookmark)}`;
    }
    if (options?.mode) {
      // Same `mode=` the web client puts in its URL: Create opens a blank, initialised
      // record (OnNewRecord runs, No. Series fires) instead of the first existing one;
      // Edit/View force the editability of an existing record.
      query += `&mode=${options.mode}`;
    }
    if (options?.filter) {
      // BC honors a filter in the OpenForm query (verified live against page 9174
      // and the Customer List). The whole expression is a query PARAMETER VALUE, so
      // it must be percent-encoded: only encoding spaces and quotes left `&` free to
      // split the parameter (a customer named "Smith & Sons" truncated the filter
      // and injected a bogus query key), and `%`, `+`, `#` equally corrupt it.
      // encodeURIComponent leaves `'` and `*` alone; `'` is additionally encoded the
      // way the web client does, and `*` is kept literal because it is BC's wildcard.
      query += `&filter=${encodeURIComponent(options.filter).replace(/'/g, '%27')}`;
    }
    return query;
  }

  private async materializePage(
    pageId: string,
    query: string,
    pageContextId: string,
    activeFilters: readonly OpenFormFilter[] = [],
    openParams?: { pageId?: string; tenantId?: string; openMode?: OpenFormMode; bookmark?: string },
  ): Promise<Result<PageContext, ProtocolError>> {
    const interaction: OpenFormInteraction = {
      type: 'OpenForm',
      query,
      controlPath: 'server:c[0]',
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted',
    );

    if (!isOk(result)) {
      // With filters, the usual cause is a CAPTION where BC wants the AL field name:
      // `filters: [{ column: "Nº" }]` or "Tipo de documento origen" made BC answer
      // only "Se produjo un error" (bc-saas F-68 b), which says nothing about why.
      // Only when the session survived — a dead session's error must reach the
      // recovery path untouched.
      if (activeFilters.length > 0 && this.session.isAlive) {
        return err(new ProtocolError(
          `${result.error.message} — BC refused to open page ${pageId} with the filters `
          + `${activeFilters.map(f => `'${f.column}' = '${f.value}'`).join(', ')}. `
          + 'OpenForm filters take the AL field NAME of the source table ("No.", "Name", "Document Type"), '
          + 'not the caption the page shows ("Nº", "Nombre", "Tipo de documento origen"). Fix the column names '
          + 'and retry, or open the page without filters and use bc_read_data on its rows.',
          { pageId, filters: activeFilters, bcError: result.error.message },
        ));
      }
      return result;
    }

    const events = result.value;

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

    // BC refused the open and answered with an ERROR DIALOG instead of a form.
    // Registering it as the page produced an unreadable shell (Unknown/modal/no
    // fields, caption = raw formId) and threw away the ONE thing that explains the
    // refusal: BC's message. Surface it, and leave the session clean.
    if (root.type === 'DialogOpened') {
      const bcMessage = errorDialogMessage(root.controlTree);
      if (bcMessage) {
        await this.dismissDialog(root.formId);
        return err(new PageOpenRejectedError(
          `BC refused to open page ${pageId}: ${bcMessage}`,
          {
            pageId,
            bcMessage,
            query,
            hint: /bookmark=/.test(query)
              ? 'A bookmark only addresses the table the page is bound to. Drop it and open the page filtered '
                + "(bc_open_page { pageId, filters: [{ column: \"No.\", value: \"<doc no>\" }] }), or open the list "
                + 'page and drill into the row (bc_execute_action { action: "View" | "Edit", rowIndex }), which '
                + 'returns a pageContextId for the card BC itself considers correct.'
              : 'Read the message above: BC rejected this open before any page existed.',
          },
        ));
      }
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
    this.repo.create(pageContextId, formId, { isModal, wizardState, activeFilters, ...openParams });
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

  /**
   * Close a dialog BC opened that we are NOT going to hand back to the caller.
   * Without this the error dialog stays on the session's modal stack and the very
   * next interaction pays a full modal reconcile (observed live: four extra
   * round-trips before the following OpenForm went through).
   *
   * Ok=300 is what a message dialog accepts; CloseForm is the fallback. The form
   * is only untracked when BC acknowledged, mirroring the license-dialog path —
   * dropping a form BC still holds is what leaves the stack lying to us.
   */
  private async dismissDialog(formId: string): Promise<void> {
    const dismissed = await this.session.invoke(
      { type: 'InvokeAction', formId, controlPath: 'server:', systemAction: 300 },
      (e) => e.type === 'InvokeCompleted',
    ).catch(() => err(new ProtocolError('dismiss threw')));
    if (isOk(dismissed)) { this.session.removeOpenForm(formId); return; }

    const closed = await this.session.invoke({ type: 'CloseForm', formId }, (e) => e.type === 'InvokeCompleted')
      .catch(() => err(new ProtocolError('close threw')));
    if (isOk(closed)) this.session.removeOpenForm(formId);
    else this.logger.warn(`Could not dismiss BC's error dialog (formId=${formId}); the next invoke will reconcile the modal stack.`);
  }

  /**
   * Discover and load the child forms (subpages, FactBoxes) embedded in a root
   * form's control tree.
   *
   * PUBLIC because a page does not only arrive through `openPage`: an ACTION can
   * open one too (`Nuevo` on a list opens the creation card, a drill-down opens a
   * card), and those contexts used to be registered with their root form alone —
   * no subpages at all. On a document that meant the creation context had no
   * `lines` section, so there was no way to put the first line on a document you
   * had just created; the caller had to guess a parameter that does not exist and
   * got "Field not found" for a line column (bc-saas F-39). ActionService is given
   * this method so both paths build the same context shape.
   */
  async discoverAndLoadChildForms(pageContextId: string, openEvents: BCEvent[]): Promise<void> {
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
      // Role Center hosted CardParts arrive on the wire as IsSubForm=false /
      // IsPart=true, which page-context-repo classifies as `factbox` -- the
      // same bucket used for genuine FactBoxes on Card pages. They aren't
      // really factboxes but the wire shape doesn't distinguish, so we key
      // off `pageType === 'RoleCenter'` and treat any non-lines child as a
      // role-center child (subpage OR factbox).
      const ctxForKind = this.repo.get(pageContextId);
      const isRoleCenterChild =
        ctxForKind?.pageType === 'RoleCenter' &&
        (section.kind === 'subpage' || section.kind === 'factbox');
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
        // controlPath: 'server:' targets the form root — cuegroup CardParts
        // have no top-level repeater, and form-root Refresh triggers
        // recomputation of the bound stackc StringValues via
        // PropertyChanged events.
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
    //
    // Exception: Role Center hosted CardParts whose entire content is a
    // cuegroup (stackgc -> stackc tiles) yield zero FieldNodes -- stackc is
    // a separate node type, not a member of FIELD_TYPES. Those sections must
    // stay valid so their `cues[]` projection survives into the output.
    const finalCtx = this.repo.get(pageContextId);
    if (finalCtx) {
      for (const [sectionId, sec] of finalCtx.sections) {
        if (sec.kind !== 'factbox') continue;
        const f = finalCtx.forms.get(sec.formId);
        if (!f) continue;
        if (isDeadFactbox(f.root)) {
          this.repo.invalidateSection(pageContextId, sectionId);
        }
      }
    }
  }

  /**
   * Load the ROWS of every list a just-opened dialog shows: its own repeater (a
   * worksheet or lookup list run modally) and the subforms it hosts (the lines grid of
   * page 5855). BC sends a modal page's control tree in DialogToShow but no row data,
   * exactly like a subpage: nothing asked for it, so those grids read as `rows: []`
   * while the web client showed them full — "Crear pedidos de compra" with no lines
   * (bc-saas F-57, 2nd case), the "Almacenes" lookup with `scanned: 0` (F-64 c), the
   * lines to reverse that could not be picked (F-65).
   *
   * Same recipe as a subpage, measured live on devel1 (2026-10-04, page 5855): LoadForm
   * on the form, then InvokeAction(Refresh) on its repeater — the Refresh is what
   * produced the DataLoaded (49 rows). Message boxes and dialogs without a grid are
   * left alone. Best effort: a failure leaves the dialog exactly as it was.
   */
  async loadDialogContent(pageContextId: string, events: readonly BCEvent[]): Promise<void> {
    for (const e of events) {
      if (e.type !== 'DialogOpened') continue;
      const ctx = this.repo.get(pageContextId);
      if (!ctx) return;
      const dialogForm = ctx.forms.get(e.formId);
      if (!dialogForm || e.formId === ctx.rootFormId) continue;
      const targets: Array<{ formId: string; repeaterPath: string }> = [];
      for (const path of treeRepeaters(dialogForm.root).keys()) {
        if ((dialogForm.rows.get(path) ?? []).length === 0) targets.push({ formId: e.formId, repeaterPath: path });
      }
      for (const s of ctx.sections.values()) {
        if (s.ownerDialogFormId === e.formId && s.valid && s.repeaterControlPath) {
          targets.push({ formId: s.formId, repeaterPath: s.repeaterControlPath });
        }
      }
      for (const t of targets) {
        const load = await this.session.invoke(
          { type: 'LoadForm', formId: t.formId, loadData: true, delayed: false, openForm: false } as LoadFormInteraction,
          (ev) => ev.type === 'InvokeCompleted' || ev.type === 'DataLoaded',
        );
        if (isOk(load)) this.repo.applyToPage(pageContextId, load.value);
        const refresh = await this.session.invoke(
          { type: 'InvokeAction', formId: t.formId, controlPath: t.repeaterPath, systemAction: 30 } as InvokeActionInteraction,
          (ev) => ev.type === 'InvokeCompleted' || ev.type === 'DataLoaded',
        );
        if (isOk(refresh)) this.repo.applyToPage(pageContextId, refresh.value);
        else this.logger.warn(`Could not load the rows of dialog ${e.formId} (form ${t.formId}): ${refresh.error.message}`);
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
    if (!ctx) return err(this.repo.notFoundError(pageContextId));

    const allEvents: BCEvent[] = [];
    const pendingDialogs: DialogOpenedEvent[] = [];
    for (const formId of ctx.ownedFormIds) {
      const closeInteraction: CloseFormInteraction = { type: 'CloseForm', formId };
      const result = await this.session.invoke(closeInteraction, (event) => event.type === 'InvokeCompleted');
      if (isOk(result)) {
        allEvents.push(...result.value);

        // Handle the unsaved-changes question CloseForm raises.
        for (const event of result.value) {
          if (event.type !== 'DialogOpened' || !event.formId) continue;
          if (!options?.discardChanges) {
            // Leave the dialog open for the caller to answer via bc_respond_dialog.
            // We must NOT remove the page context in this case: that tool needs a
            // live pageContextId, and removing it here would strand the dialog
            // server-side -> the next invoke dies with LogicalModalityViolationException
            // (MODAL_STUCK). The caller either answers the dialog, or re-calls
            // bc_close_page with discardChanges.
            pendingDialogs.push(event);
            continue;
          }
          const still = await this.discardOnClose(event);
          allEvents.push(...still.events);
          pendingDialogs.push(...still.pending);
        }
      }
      if (pendingDialogs.length > 0) break;      // stop; wait for the caller to resolve the dialog
      this.session.removeOpenForm(formId);
    }

    if (pendingDialogs.length > 0) {
      this.logger.info(`Close of ${pageContextId} left a dialog open; keeping the context so bc_respond_dialog can answer it (or re-call bc_close_page with discardChanges).`);
      return ok({ events: allEvents, pendingDialogs });
    }

    this.repo.remove(pageContextId);
    this.logger.info(`Page closed: ${pageContextId}`);
    return ok({ events: allEvents, pendingDialogs });
  }

  /**
   * Answer the dialog a CloseForm raised so the close completes WITHOUT keeping the
   * page's unsaved changes. Returns the events and whatever is still open after it.
   *
   * The question BC27/BC28 ask is "La página contiene cambios no guardados. ¿Desea
   * descartar estos cambios?" (an `lmd` ConfirmDialog), and the answer that discards
   * is YES. This used to send No=390 — written for an older "save changes?" wording —
   * which KEEPS the page open: measured live on devel1 (2026-10-03), after No the root
   * form still answered a Refresh; after Yes=380 it was gone (FormNotFoundException).
   * So "discardChanges" closed the context here while BC kept the page and its dirty
   * record (bc-saas F-47 b). An error/message box only needs Ok. Anything else is
   * not a question this method knows how to answer, so it is left to the caller.
   */
  private async discardOnClose(dialog: DialogOpenedEvent): Promise<{ events: BCEvent[]; pending: DialogOpenedEvent[] }> {
    const kind = classifyDialog(dialog.controlTree);
    const answer = kind === 'confirm' ? 380 /* Yes = discard */ : (kind === 'error' || kind === 'message') ? 300 /* Ok */ : undefined;
    if (answer === undefined) return { events: [], pending: [dialog] };
    this.logger.info(`Close raised a ${kind} dialog (formId=${dialog.formId}); answering ${answer === 380 ? 'Yes (discard the changes)' : 'Ok'}`);
    const dismissed = await this.session.invoke(
      { type: 'InvokeAction', formId: dialog.formId, controlPath: 'server:c[0]', systemAction: answer } as InvokeActionInteraction,
      (e) => e.type === 'InvokeCompleted',
    );
    if (!isOk(dismissed)) {
      this.logger.warn(`Could not answer the close dialog ${dialog.formId}: ${dismissed.error.message}`);
      return { events: [], pending: [dialog] };
    }
    // Answered: BC sends no FormClosed for it, so untrack it ourselves. Anything the
    // answer raised in turn (an error while discarding) is still open.
    this.session.removeOpenForm(dialog.formId);
    const chained = dismissed.value.filter((e): e is DialogOpenedEvent => e.type === 'DialogOpened' && e.formId !== dialog.formId);
    return { events: dismissed.value, pending: chained };
  }

  getPageContext(pageContextId: string): PageContext | undefined {
    return this.repo.get(pageContextId);
  }
}
