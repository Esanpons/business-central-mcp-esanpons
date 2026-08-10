import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type { FilterInteraction } from '../protocol/types.js';
import { FilterOperation } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { filterControlPath } from '../protocol/form-views.js';
import type { Logger } from '../core/logger.js';

export interface Filter {
  column: string;
  value: string;
}

/**
 * BC's "filter pane" interaction (Filter/AddLine) — NOT wired into the MCP tools.
 *
 * It is a no-op on BC27/BC28: list columns carry a `ColumnBinder.Name` but no `.Path`,
 * so BC silently ignores an AddLine keyed by name and returns every row. The paths that
 * DO filter are:
 *   - main list  -> the OpenForm `filter=` query (`PageService.reopenWithFilters`)
 *   - lines/subpage -> client-side row matching (`protocol/row-filter.ts`, G8)
 *
 * This class stays as the live probe that documents that behaviour (the integration
 * suites call it directly). Do not re-wire it into `ReadDataOperation` without first
 * proving on a live build that the columns finally ship a binder path.
 */
export class FilterService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
    private readonly redactValues: boolean = false,
  ) {}

  /** Mask a filter value in logs when LOG_REDACT_VALUES is enabled. */
  private redact(value: unknown): string {
    return this.redactValues ? '<redacted>' : String(value);
  }

  async applyFilter(pageContextId: string, columnName: string, value: string, sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    return this.applyFilters(pageContextId, [{ column: columnName, value }], sectionId);
  }

  async applyFilters(pageContextId: string, filters: Filter[], sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater -- cannot filter'));

    const initialFilterPath = filterControlPath(resolved.form.root);
    if (!initialFilterPath) {
      return err(new ProtocolError('Page has no FilterLogicalControl (filc) -- cannot filter'));
    }

    for (const filter of filters) {
      const currentCtx = this.repo.get(pageContextId);
      if (!currentCtx) return err(new ProtocolError('State lost during filter application'));

      const currentResolved = resolveSection(currentCtx, sectionId);
      if ('error' in currentResolved) return err(new ProtocolError(currentResolved.error, { availableSections: currentResolved.availableSections }));
      if (!currentResolved.repeater) return err(new ProtocolError('State lost during filter application'));

      const fpath = filterControlPath(currentResolved.form.root);
      if (!fpath) return err(new ProtocolError('FilterControlPath lost during filter application'));

      // Resolve column on the RepeaterNode by caption
      const column = currentResolved.repeater.columns.find(c =>
        (c.properties.caption ?? '').toLowerCase() === filter.column.toLowerCase()
      );
      if (!column) {
        return err(new ProtocolError(`Filter column not found: ${filter.column}`, {
          availableColumns: currentResolved.repeater.columns.map(c => c.properties.caption ?? '').filter(Boolean),
        }));
      }
      // The filter PANE (Filter/AddLine with a columnBinderPath) does NOT work on
      // BC27/BC28: these builds ship list columns with a ColumnBinder.Name but no
      // .Path, and BC silently ignores an AddLine keyed by the Name (verified live:
      // a no-match value still returns every row). The mechanism that DOES work is
      // the OpenForm `filter=` query at open time (see PageService.openPage /
      // ObjectIndexService). So fail loudly here instead of silently returning
      // unfiltered data, and point the caller at the working path.
      const columnBinderPath = column.columnBinder?.path;
      if (!columnBinderPath) {
        return err(new ProtocolError(
          `Filtering the "${filter.column}" column via the filter pane is not supported on this BC build ` +
          `(the column has no columnBinderPath). Re-open the page with an OpenForm query filter instead.`,
        ));
      }

      const addLineInteraction: FilterInteraction = {
        type: 'Filter',
        formId: currentResolved.form.formId,
        controlPath: fpath,
        filterOperation: FilterOperation.AddLine,
        filterColumnId: columnBinderPath,
        filterValue: filter.value,
      };
      this.logger.info(`[Filter] Filter(AddLine) on ${fpath}, column=${columnBinderPath}, value="${this.redact(filter.value)}"`);
      this.logger.info(`[Filter] repeater.controlPath=${currentResolved.repeater.controlPath}, formId=${currentResolved.form.formId}`);

      const addResult = await this.session.invoke(
        addLineInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
      );
      if (isErr(addResult)) return addResult;
      this.repo.applyToPage(pageContextId, addResult.value);
    }

    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return err(new ProtocolError('State lost after filter'));
    this.logger.info(`[Filter] Filters applied on ${pageContextId}: ${filters.map(f => `${f.column}=${this.redact(f.value)}`).join(', ')}`);
    return ok(updatedCtx);
  }

  async clearFilters(pageContextId: string, sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater -- cannot clear filters'));

    // Fail as loudly as applyFilters does. On BC27/BC28 the filter PANE is inert
    // (columns ship a ColumnBinder.Name but no .Path), so a Reset here completes
    // happily and clears nothing — reporting success for a no-op, while the
    // symmetric applyFilters hard-errors. Both must point at the working path.
    const hasBinderPath = resolved.repeater.columns.some(c => !!c.columnBinder?.path);
    if (!hasBinderPath) {
      return err(new ProtocolError(
        'Clearing filters via the filter pane is not supported on this BC build (no column carries a columnBinderPath), ' +
        'so a Reset here would silently do nothing. Clear the filters by re-opening the page without them ' +
        '(bc_read_data with filters: [], which re-opens the form unfiltered).',
      ));
    }

    const fpath = filterControlPath(resolved.form.root);
    const controlPath = fpath ?? resolved.repeater.controlPath;

    const resetInteraction: FilterInteraction = {
      type: 'Filter',
      formId: resolved.form.formId,
      controlPath,
      filterOperation: FilterOperation.Reset,
    };
    const result = await this.session.invoke(
      resetInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    );
    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);

    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return err(new ProtocolError('State lost after clear'));
    this.logger.info(`[Filter] Filters cleared on ${pageContextId}`);
    return ok(updatedCtx);
  }
}
