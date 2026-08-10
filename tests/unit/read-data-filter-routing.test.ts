// tests/unit/read-data-filter-routing.test.ts
//
// `filters` has two completely different implementations behind it: a server-side
// re-open of the page (main list) and a client-side row match (lines/subpage). The
// routing decision is what makes filtering either correct or destructive — the
// server-side path REPOSITIONS the page, so taking it on a card context throws the
// record away.

import { describe, it, expect, vi } from 'vitest';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const listTree = {
  t: 'lf', ServerId: 'f1', PageType: 1, Caption: 'Customers',
  Children: [{
    t: 'rc',
    Columns: [
      { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' } },
      { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'c2' } },
    ],
  }],
};

const cardTree = {
  t: 'lf', ServerId: 'f1', PageType: 0, Caption: 'Customer Card',
  Children: [
    { t: 'gc', Caption: 'General', Visible: true, Children: [
      { t: 'sc', Caption: 'No.', StringValue: '10000', Visible: true },
    ] },
  ],
};

function contextWith(tree: unknown, rows?: Array<{ bookmark: string; cells: Record<string, unknown> }>) {
  const repo = new PageContextRepository();
  repo.create('pc:1', 'f1', { pageId: '22' });
  repo.applyToPage('pc:1', [{ type: 'FormCreated', formId: 'f1', controlTree: tree } as BCEvent]);
  if (rows) {
    repo.applyToPage('pc:1', [{
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[0]', currentRowOnly: false,
      rows: rows.map((r, i) => ({ DataRowInserted: [i, r] })),
    } as BCEvent]);
  }
  return repo;
}

function services(repo: PageContextRepository, tabs: Array<{ caption: string; fields: Array<{ caption: string }> }> = []) {
  const dataService = {
    readRows: () => ok([]),
    getRepeaterTotalRowCount: () => null,
    getTabs: () => ok(tabs),
    scrollRepeater: async () => ok([]),
  } as never;
  const reopen = vi.fn(async () => ok(repo.get('pc:1')!));
  const pageService = { reopenWithFilters: reopen } as never;
  return { dataService, pageService, reopen };
}

describe('ReadDataOperation filter routing', () => {
  it('uses the server-side re-open for a list-shaped root', async () => {
    const repo = contextWith(listTree, [{ bookmark: 'b1', cells: { c1: '10000', c2: 'Contoso' } }]);
    const { dataService, pageService, reopen } = services(repo);
    const op = new ReadDataOperation(dataService, repo, pageService);

    const r = await op.execute({ pageContextId: 'pc:1', filters: [{ column: 'No.', value: '10000' }] });
    expect(r.ok).toBe(true);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('refuses to filter a CARD context instead of silently repositioning it', async () => {
    const repo = contextWith(cardTree);
    const { dataService, pageService, reopen } = services(repo);
    const op = new ReadDataOperation(dataService, repo, pageService);

    const r = await op.execute({ pageContextId: 'pc:1', filters: [{ column: 'No.', value: '20000' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/not a list/);
    expect(reopen).not.toHaveBeenCalled();
  });

  it('filters a lines section client-side and says so', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'root', { pageId: '42' });
    repo.applyToPage('pc:1', [{
      type: 'FormCreated', formId: 'root',
      controlTree: { t: 'lf', ServerId: 'root', PageType: 5, Caption: 'Sales Order', Children: [] },
    } as BCEvent]);
    repo.registerDiscoveredChildForm('pc:1', {
      serverId: 'sub', caption: 'Lines', isSubForm: true, isPart: false,
      controlTree: {
        t: 'lf', ServerId: 'sub', PageType: 4, Caption: 'Lines',
        Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'Type', ColumnBinder: { Name: 'c1' } }] }],
      },
    });
    repo.applyToPage('pc:1', [{
      type: 'DataLoaded', formId: 'sub', controlPath: 'server:c[0]', currentRowOnly: false,
      rows: [
        { DataRowInserted: [0, { bookmark: 'b1', cells: { c1: 'Item' } }] },
        { DataRowInserted: [1, { bookmark: 'b2', cells: { c1: 'Resource' } }] },
      ],
    } as BCEvent]);

    const { dataService, pageService, reopen } = services(repo);
    const op = new ReadDataOperation(dataService, repo, pageService);

    const r = await op.execute({ pageContextId: 'pc:1', section: 'lines', filters: [{ column: 'Type', value: 'Item' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(reopen).not.toHaveBeenCalled();
    expect(r.value.rowFilter?.mode).toBe('client');
    expect(r.value.section.rows!.map(x => x.bookmark)).toEqual(['b1']);
  });

  it('an EMPTY lines section filters to zero rows, and an unknown column still lists the real ones', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'root', { pageId: '42' });
    repo.applyToPage('pc:1', [{
      type: 'FormCreated', formId: 'root',
      controlTree: { t: 'lf', ServerId: 'root', PageType: 5, Caption: 'Sales Order', Children: [] },
    } as BCEvent]);
    repo.registerDiscoveredChildForm('pc:1', {
      serverId: 'sub', caption: 'Lines', isSubForm: true, isPart: false,
      controlTree: {
        t: 'lf', ServerId: 'sub', PageType: 4, Caption: 'Lines',
        Children: [{
          t: 'rc',
          Columns: [
            { t: 'rcc', Caption: 'Type', ColumnBinder: { Name: 'c1' } },
            { t: 'rcc', Caption: 'Quantity', ColumnBinder: { Name: 'c2' } },
          ],
        }],
      },
    });
    const { dataService, pageService } = services(repo);
    const op = new ReadDataOperation(dataService, repo, pageService);

    // No rows loaded at all: a known column must NOT be reported as "not found".
    const empty = await op.execute({ pageContextId: 'pc:1', section: 'lines', filters: [{ column: 'Type', value: 'Item' }] });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value.section.rows).toEqual([]);
    expect(empty.value.rowFilter?.matched).toBe(0);

    const bogus = await op.execute({ pageContextId: 'pc:1', section: 'lines', filters: [{ column: 'Importe', value: '1' }] });
    expect(bogus.ok).toBe(false);
    if (bogus.ok) return;
    expect(bogus.error.message).toContain('Importe');
    expect(bogus.error.message).toContain('Type, Quantity');
  });
});

describe('ReadDataOperation narrowing diagnostics', () => {
  it('errors when `tab` matches nothing instead of returning every field', async () => {
    const repo = contextWith(cardTree);
    const { dataService, pageService } = services(repo, [{ caption: 'General', fields: [{ caption: 'No.' }] }]);
    const op = new ReadDataOperation(dataService, repo, pageService);

    const r = await op.execute({ pageContextId: 'pc:1', tab: 'Facturacion' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/Tab 'Facturacion' not found/);
    expect(r.error.message).toContain('General');
  });

  it('errors when `group` matches nothing, naming the groups that exist', async () => {
    const repo = contextWith(cardTree);
    const { dataService, pageService } = services(repo);
    const op = new ReadDataOperation(dataService, repo, pageService);

    const r = await op.execute({ pageContextId: 'pc:1', group: 'Bill-to' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/Group 'Bill-to' matched no field/);
    expect(r.error.message).toContain('General');
  });

  it('unknown pageContextId errors with the list of open contexts', async () => {
    const repo = contextWith(listTree);
    const { dataService, pageService } = services(repo);
    const op = new ReadDataOperation(dataService, repo, pageService);

    const r = await op.execute({ pageContextId: 'pc:nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Open page contexts');
    expect((r.error.context as { availablePageContexts: unknown[] }).availablePageContexts).toHaveLength(1);
  });
});
