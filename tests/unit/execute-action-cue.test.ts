// tests/unit/execute-action-cue.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ActionService } from '../../src/services/action-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

describe('ActionService.executeOnCue', () => {
  it('sends DrillDown=120 against the cue field controlPath', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'root', { isModal: false, wizardState: null });
    repo.applyEvents([{
      type: 'FormCreated',
      formId: 'root',
      controlTree: { t: 'lf', ServerId: 'root', PageType: 2, Children: [] },
    } as BCEvent]);
    repo.registerDiscoveredChildForm('pc:1', {
      serverId: 'cp',
      caption: 'Activities',
      controlTree: {
        t: 'lf', ServerId: 'cp', PageType: 3, Caption: 'Activities',
        Children: [{
          t: 'stackgc', Caption: 'Ongoing Sales',
          Children: [{
            t: 'gc', MappingHint: 'STACKGROUP',
            Children: [
              { t: 'stackc', Caption: 'Sales Quotes', StringValue: '5', HasAction: true, ColumnBinder: { Name: 'a' } },
            ],
          }],
        }],
      },
      isSubForm: false,
      isPart: true,
    });

    const sentInteractions: any[] = [];
    const session: any = {
      invoke: vi.fn(async (interaction: any) => {
        sentInteractions.push(interaction);
        return ok([]);
      }),
    };
    const logger: any = { info() {}, debug() {}, warn() {}, error() {} };

    const svc = new ActionService(session, repo, logger);
    const ctx = repo.get('pc:1')!;
    const cueSectionId = Array.from(ctx.sections.keys()).find(k => k.includes('Activities'))!;
    expect(cueSectionId).toBeDefined();

    const result = await svc.executeOnCue('pc:1', cueSectionId, 'Sales Quotes');
    expect(result.ok).toBe(true);
    expect(sentInteractions).toHaveLength(1);
    expect(sentInteractions[0].systemAction).toBe(120);
    expect(sentInteractions[0].formId).toBe('cp');
    expect(sentInteractions[0].type).toBe('InvokeAction');
    expect(typeof sentInteractions[0].controlPath).toBe('string');
    expect(sentInteractions[0].controlPath.length).toBeGreaterThan(0);
  });

  it('returns error for unknown cue name', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'root', { isModal: false, wizardState: null });
    repo.applyEvents([{
      type: 'FormCreated', formId: 'root',
      controlTree: { t: 'lf', ServerId: 'root', PageType: 2, Children: [] },
    } as BCEvent]);
    repo.registerDiscoveredChildForm('pc:1', {
      serverId: 'cp', caption: 'Activities',
      controlTree: { t: 'lf', ServerId: 'cp', PageType: 3, Children: [] },
      isSubForm: false, isPart: true,
    });
    const session: any = { invoke: vi.fn() };
    const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
    const svc = new ActionService(session, repo, logger);
    const ctx = repo.get('pc:1')!;
    const cueSectionId = Array.from(ctx.sections.keys()).find(k => k.includes('Activities'))!;

    const result = await svc.executeOnCue('pc:1', cueSectionId, 'Nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/not found/i);
    }
  });

  it('returns error when cue has no drill-down action', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'root', { isModal: false, wizardState: null });
    repo.applyEvents([{
      type: 'FormCreated', formId: 'root',
      controlTree: { t: 'lf', ServerId: 'root', PageType: 2, Children: [] },
    } as BCEvent]);
    repo.registerDiscoveredChildForm('pc:1', {
      serverId: 'cp', caption: 'Activities',
      controlTree: {
        t: 'lf', ServerId: 'cp', PageType: 3,
        Children: [{
          t: 'stackgc', Caption: 'Group',
          Children: [{
            t: 'gc', MappingHint: 'STACKGROUP',
            Children: [{ t: 'stackc', Caption: 'NoDrill', StringValue: '0' /* HasAction omitted */ }],
          }],
        }],
      },
      isSubForm: false, isPart: true,
    });
    const session: any = { invoke: vi.fn() };
    const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
    const svc = new ActionService(session, repo, logger);
    const ctx = repo.get('pc:1')!;
    const cueSectionId = Array.from(ctx.sections.keys()).find(k => k.includes('Activities'))!;

    const result = await svc.executeOnCue('pc:1', cueSectionId, 'NoDrill');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/not drill-downable/i);
    }
  });

  it('registers a new pageContextId for the drill-down target form', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'root', { isModal: false, wizardState: null });
    repo.applyEvents([{
      type: 'FormCreated', formId: 'root',
      controlTree: { t: 'lf', ServerId: 'root', PageType: 2, Children: [] },
    } as BCEvent]);
    repo.registerDiscoveredChildForm('pc:1', {
      serverId: 'cp', caption: 'Activities',
      controlTree: {
        t: 'lf', ServerId: 'cp', PageType: 3, Caption: 'Activities',
        Children: [{
          t: 'stackgc', Caption: 'Ongoing Sales',
          Children: [{
            t: 'gc', MappingHint: 'STACKGROUP',
            Children: [{ t: 'stackc', Caption: 'Sales Quotes', StringValue: '5', HasAction: true, ColumnBinder: { Name: 'a' } }],
          }],
        }],
      },
      isSubForm: false, isPart: true,
    });

    // Mock the DrillDown response: BC echoes a FormCreated for the new list page
    // (ownerless — not a child of any existing form), plus an InvokeCompleted.
    const session: any = {
      invoke: vi.fn(async () => ok([
        {
          type: 'FormCreated', formId: 'newList', isReload: false,
          controlTree: { t: 'lf', ServerId: 'newList', PageType: 1, Caption: 'Sales Quotes', Children: [] },
        },
        {
          type: 'InvokeCompleted', sequenceNumber: 1,
          completedInteractions: [{ invocationId: 'cb1', durationMs: 0 }],
        },
      ] as BCEvent[])),
    };
    const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
    const svc = new ActionService(session, repo, logger);
    const ctx = repo.get('pc:1')!;
    const cueSectionId = Array.from(ctx.sections.keys()).find(k => k.includes('Activities'))!;

    const result = await svc.executeOnCue('pc:1', cueSectionId, 'Sales Quotes');
    expect(result.ok).toBe(true);
    // The new formId should be indexed against a freshly-created pageContextId
    const newPage = repo.getByFormId('newList');
    expect(newPage).toBeDefined();
    expect(newPage!.pageContextId).not.toBe('pc:1');
    expect(newPage!.pageContextId.startsWith('session:page:cue:')).toBe(true);
  });
});
