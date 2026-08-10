// tests/protocol/page-context-repo-routing.test.ts
//
// Event routing across page contexts. The same event batch is applied to BOTH the
// source and the target context after a drill-down / action, so the repository has
// to decide what belongs to whom. Getting it wrong corrupted the SOURCE page.

import { describe, it, expect } from 'vitest';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

const lf = (serverId: string, pageType: number, caption: string, children: unknown[] = []) =>
  ({ t: 'lf', ServerId: serverId, PageType: pageType, Caption: caption, Children: children });

const formCreated = (formId: string, tree: unknown, parentFormId?: string): BCEvent =>
  ({ type: 'FormCreated', formId, controlTree: tree, ...(parentFormId ? { parentFormId } : {}) } as BCEvent);

describe('ownerless FormCreated routing (drill-down must not pollute the source)', () => {
  function listWithCard() {
    const repo = new PageContextRepository();
    repo.create('pc:list', 'listForm', { pageId: '22' });
    repo.applyToPage('pc:list', [formCreated('listForm', lf('listForm', 1, 'Customers'))]);

    // BC answers the drill-down with an ownerless FormCreated for a NEW form. The
    // service applies the same batch to the new context and to the source.
    const batch = [formCreated('cardForm', lf('cardForm', 0, 'Customer Card'))];
    repo.create('pc:card', 'cardForm');
    repo.applyToPage('pc:card', batch);
    repo.applyToPage('pc:list', batch);
    return repo;
  }

  it('keeps the source page identity intact', () => {
    const repo = listWithCard();
    const list = repo.get('pc:list')!;
    expect(list.caption).toBe('Customers');
    expect(list.pageType).toBe('List');
  });

  it('does not insert the new page\'s form into the source context', () => {
    const repo = listWithCard();
    expect(repo.get('pc:list')!.forms.has('cardForm')).toBe(false);
    expect(repo.get('pc:card')!.forms.has('cardForm')).toBe(true);
    expect(repo.get('pc:card')!.caption).toBe('Customer Card');
  });

  it('routes a PARENTED FormCreated to the owner of its parent, not to the batch target', () => {
    const repo = listWithCard();
    // The card's factbox arrives while the same batch is applied to both contexts.
    const factbox = formCreated('fbForm', lf('fbForm', 3, 'Customer Statistics'), 'cardForm');
    repo.applyToPage('pc:card', [factbox]);
    repo.applyToPage('pc:list', [factbox]);

    expect(repo.get('pc:card')!.forms.has('fbForm')).toBe(true);
    expect(repo.get('pc:list')!.forms.has('fbForm')).toBe(false);
    // ...and the formId index still points at the page that really owns it.
    expect(repo.getByFormId('fbForm')!.pageContextId).toBe('pc:card');
  });

  it('still applies a FormCreated for a form the context DOES own (reload)', () => {
    const repo = new PageContextRepository();
    repo.create('pc:x', 'f1');
    repo.applyToPage('pc:x', [formCreated('f1', lf('f1', 1, 'First'))]);
    repo.applyToPage('pc:x', [formCreated('f1', lf('f1', 1, 'Reloaded'))]);
    expect(repo.get('pc:x')!.caption).toBe('Reloaded');
  });
});

describe('page type inference', () => {
  const repeaterChild = (id: string) => lf(id, 4, 'Lines', [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.' }] }]);

  it('does not turn a Card that hosts a list part into a Document', () => {
    const repo = new PageContextRepository();
    repo.create('pc:card', 'root');
    repo.applyToPage('pc:card', [formCreated('root', lf('root', 0, 'Item Card'))]);
    repo.applyToPage('pc:card', [formCreated('part', repeaterChild('part'), 'root')]);

    const ctx = repo.get('pc:card')!;
    expect(ctx.pageType).toBe('Card');
    const section = Array.from(ctx.sections.values()).find(s => s.formId === 'part')!;
    expect(section.kind).toBe('subpage');
    expect(section.repeaterControlPath).toBeDefined();
  });

  it('a registered SUBFORM is the lines section and can still infer Document', () => {
    const repo = new PageContextRepository();
    repo.create('pc:doc', 'root');   // pageType stays Unknown: BC sent no root tree
    repo.registerDiscoveredChildForm('pc:doc', {
      serverId: 'sub', caption: 'Sales Lines', controlTree: repeaterChild('sub'),
      isSubForm: true, isPart: false,
    });
    const ctx = repo.get('pc:doc')!;
    expect(ctx.sections.get('lines')!.kind).toBe('lines');
    expect(ctx.pageType).toBe('Document');
  });
});

describe('dialog routing', () => {
  it('registers a dialog once, on the page that owns its ownerFormId', () => {
    const repo = new PageContextRepository();
    repo.create('pc:a', 'formA');
    repo.applyToPage('pc:a', [formCreated('formA', lf('formA', 1, 'A'))]);
    repo.create('pc:b', 'formB');
    repo.applyToPage('pc:b', [formCreated('formB', lf('formB', 0, 'B'))]);

    const dialog: BCEvent = {
      type: 'DialogOpened', formId: 'dlg', ownerFormId: 'formA',
      controlTree: lf('dlg', 8, 'Delete?'),
    } as BCEvent;

    // Applied to both contexts, the way an action batch is.
    repo.applyToPage('pc:a', [dialog]);
    repo.applyToPage('pc:b', [dialog]);

    expect(repo.get('pc:a')!.dialogs.map(d => d.formId)).toEqual(['dlg']);
    expect(repo.get('pc:b')!.dialogs).toHaveLength(0);
    expect(repo.get('pc:b')!.ownedFormIds).not.toContain('dlg');
  });

  it('is idempotent for the same dialog formId', () => {
    const repo = new PageContextRepository();
    repo.create('pc:a', 'formA');
    repo.applyToPage('pc:a', [formCreated('formA', lf('formA', 1, 'A'))]);
    const dialog: BCEvent = {
      type: 'DialogOpened', formId: 'dlg', ownerFormId: 'formA', controlTree: lf('dlg', 8, 'Delete?'),
    } as BCEvent;
    repo.applyToPage('pc:a', [dialog]);
    repo.applyToPage('pc:a', [dialog]);
    expect(repo.get('pc:a')!.dialogs).toHaveLength(1);
    expect(repo.get('pc:a')!.ownedFormIds.filter(f => f === 'dlg')).toHaveLength(1);
  });
});

describe('rekey', () => {
  it('moves a staged context onto the caller-visible id, keeping form routing', () => {
    const repo = new PageContextRepository();
    repo.create('pc:staging', 'f1', { pageId: '22' });
    repo.applyToPage('pc:staging', [formCreated('f1', lf('f1', 1, 'Customers'))]);

    const moved = repo.rekey('pc:staging', 'pc:final')!;
    expect(moved.pageContextId).toBe('pc:final');
    expect(repo.get('pc:staging')).toBeUndefined();
    expect(repo.get('pc:final')!.caption).toBe('Customers');
    expect(repo.getByFormId('f1')!.pageContextId).toBe('pc:final');
    expect(repo.get('pc:final')!.pageId).toBe('22');
  });
});
