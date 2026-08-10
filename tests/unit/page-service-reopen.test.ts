// tests/unit/page-service-reopen.test.ts
//
// reopenWithFilters is the ONLY working list-filtering mechanism (the filter pane is
// a no-op on BC27/BC28), and it re-opens the page under the caller's own
// pageContextId. It therefore has to be transactional: the most likely failure — a
// localized caption instead of an AL field name, which BC rejects with "token not
// found" — must not take the working page context down with it.

import { describe, it, expect, vi } from 'vitest';
import { PageService } from '../../src/services/page-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import type { BCEvent } from '../../src/protocol/types.js';

const listTree = (formId: string, caption: string) => ({
  t: 'lf', ServerId: formId, PageType: 1, Caption: caption,
  Metadata: { id: 22, sourceTableId: 18 },
  Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' } }] }],
});

interface Sent { type: string; query?: string; formId?: string }

function makeService(opts: {
  repo: PageContextRepository;
  sent: Sent[];
  /** Called for each OpenForm; return the events, or an error to simulate BC rejecting the filter. */
  onOpenForm: (query: string) => { events?: BCEvent[]; error?: string };
}) {
  const session = {
    invoke: async (interaction: { type: string; query?: string; formId?: string }) => {
      opts.sent.push({ type: interaction.type, query: interaction.query, formId: interaction.formId });
      if (interaction.type === 'OpenForm') {
        const r = opts.onOpenForm(interaction.query ?? '');
        if (r.error) return err(new ProtocolError(r.error));
        return ok(r.events ?? []);
      }
      return ok([]);
    },
    removeOpenForm: vi.fn(),
  } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  return new PageService(session, opts.repo, logger, { tenantId: 'aesva' });
}

describe('PageService.reopenWithFilters', () => {
  it('reuses the tenant and mode the page was opened with, and escapes/encodes the filter', async () => {
    const repo = new PageContextRepository();
    const sent: Sent[] = [];
    let n = 0;
    const svc = makeService({
      repo, sent,
      onOpenForm: () => ({ events: [{ type: 'FormCreated', formId: `f${++n}`, controlTree: listTree(`f${n}`, 'Customers') } as BCEvent] }),
    });

    const opened = await svc.openPage('22', { tenantId: 'aesva', mode: 'Edit' });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const pcId = opened.value.pageContextId;

    const refiltered = await svc.reopenWithFilters(pcId, [{ column: 'Name', value: "L'Oreal & Co" }]);
    expect(refiltered.ok).toBe(true);

    const reopen = sent.filter(s => s.type === 'OpenForm').at(-1)!;
    expect(reopen.query).toContain('tenant=aesva');    // NOT the server default
    expect(reopen.query).toContain('mode=Edit');       // the mode survived the re-open
    // ' doubled inside the token, then the whole expression percent-encoded.
    expect(reopen.query).toContain("%27Name%27%20IS%20%27L%27%27Oreal%20%26%20Co%27".replace(/%27/g, '%27'));
    expect(reopen.query!.split('&filter=')[1]).not.toContain('&');
  });

  it('keeps the original page usable when BC rejects the filter', async () => {
    const repo = new PageContextRepository();
    const sent: Sent[] = [];
    let n = 0;
    const svc = makeService({
      repo, sent,
      onOpenForm: (query) => query.includes('filter=')
        ? { error: 'The filter token was not found in the table.' }
        : { events: [{ type: 'FormCreated', formId: `f${++n}`, controlTree: listTree(`f${n}`, 'Customers') } as BCEvent] },
    });

    const opened = await svc.openPage('22');
    if (!opened.ok) throw new Error('setup failed');
    const pcId = opened.value.pageContextId;
    const rootFormId = opened.value.rootFormId;

    const failed = await svc.reopenWithFilters(pcId, [{ column: 'Nombre', value: 'x' }]);
    expect(failed.ok).toBe(false);

    // The page context still exists, still points at the live form, and no
    // CloseForm was sent for it.
    const still = repo.get(pcId);
    expect(still).toBeDefined();
    expect(still!.rootFormId).toBe(rootFormId);
    expect(still!.caption).toBe('Customers');
    expect(sent.some(s => s.type === 'CloseForm' && s.formId === rootFormId)).toBe(false);
    // ...and no staging context leaked.
    expect(repo.listPageContextIds()).toEqual([pcId]);
  });

  it('keeps the caller\'s pageContextId and replaces activeFilters on success', async () => {
    const repo = new PageContextRepository();
    const sent: Sent[] = [];
    let n = 0;
    const svc = makeService({
      repo, sent,
      onOpenForm: () => ({ events: [{ type: 'FormCreated', formId: `f${++n}`, controlTree: listTree(`f${n}`, 'Customers') } as BCEvent] }),
    });

    const opened = await svc.openPage('22', { filters: [{ column: 'City', value: 'Barcelona' }] });
    if (!opened.ok) throw new Error('setup failed');
    const pcId = opened.value.pageContextId;
    const firstFormId = opened.value.rootFormId;

    const refiltered = await svc.reopenWithFilters(pcId, [{ column: 'No.', value: '10000..20000' }]);
    expect(refiltered.ok).toBe(true);
    if (!refiltered.ok) return;

    expect(refiltered.value.pageContextId).toBe(pcId);
    expect(refiltered.value.activeFilters).toEqual([{ column: 'No.', value: '10000..20000' }]);
    expect(repo.listPageContextIds()).toEqual([pcId]);
    expect(repo.getByFormId(refiltered.value.rootFormId)!.pageContextId).toBe(pcId);
    // the superseded form was closed
    expect(sent.some(s => s.type === 'CloseForm' && s.formId === firstFormId)).toBe(true);
  });

  it('refuses a context that was not opened from a page id', async () => {
    const repo = new PageContextRepository();
    const sent: Sent[] = [];
    const svc = makeService({ repo, sent, onOpenForm: () => ({ events: [] }) });
    repo.create('session:page:drilldown:abc123', 'df1');

    const r = await svc.reopenWithFilters('session:page:drilldown:abc123', [{ column: 'No.', value: '1' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/not opened from a page id/);
  });

  it('recovers the page id from the root form metadata when the context predates the field', async () => {
    const repo = new PageContextRepository();
    const sent: Sent[] = [];
    let n = 0;
    const svc = makeService({
      repo, sent,
      onOpenForm: () => ({ events: [{ type: 'FormCreated', formId: `f${++n}`, controlTree: listTree(`f${n}`, 'Customers') } as BCEvent] }),
    });
    // A context created without pageId, but whose root form carries Metadata.id = 22.
    repo.create('pc:legacy', 'f0');
    repo.applyToPage('pc:legacy', [{ type: 'FormCreated', formId: 'f0', controlTree: listTree('f0', 'Customers') } as BCEvent]);

    const r = await svc.reopenWithFilters('pc:legacy', [{ column: 'No.', value: '10000' }]);
    expect(r.ok).toBe(true);
    expect(sent.filter(s => s.type === 'OpenForm').at(-1)!.query).toContain('page=22');
  });
});
