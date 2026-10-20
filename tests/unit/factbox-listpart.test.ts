// bc-saas F-59 / F-66: a FactBox that is a ListPart (a repeater, no loose fields) was
// declared a dead stub right after the page opened, because the check counted only
// fields() and cues() — and fields() does not count repeater columns. The section was
// invalidated for the life of the context, so bc_read_data answered "Section
// 'factbox:Datos pendientes' not found" while listing that same id in availableSections.
import { describe, it, expect } from 'vitest';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { isDeadFactbox } from '../../src/services/page-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { resolveSection, readableSectionIds } from '../../src/protocol/section-resolver.js';
import { buildSection } from '../../src/protocol/section-dto.js';

// Shape of a ListPart FactBox: an lf whose only content is a repeater with columns.
const listPart = {
  t: 'lf', Caption: 'Datos pendientes del documento', ServerId: 'FB1',
  Children: [
    { t: 'rc', Columns: [
      { t: 'rcc', Caption: 'Descripción', ColumnBinder: { Name: 'desc' } },
      { t: 'rcc', Caption: 'Nº documento', ColumnBinder: { Name: 'docno' } },
    ], Children: [] },
  ],
};

const cardPart = {
  t: 'lf', Caption: 'Resumen', ServerId: 'FB2',
  Children: [{ t: 'sc', Caption: 'Estado', ColumnBinder: { Name: 'st' } }],
};

const placeholder = { t: 'lf', Caption: 'Vacío', ServerId: 'FB3', Children: [] };

describe('isDeadFactbox (F-59)', () => {
  it('a ListPart FactBox is NOT dead even with zero rows', () => {
    expect(isDeadFactbox(buildFormTree(listPart))).toBe(false);
  });

  it('a CardPart with fields is not dead', () => {
    expect(isDeadFactbox(buildFormTree(cardPart))).toBe(false);
  });

  it('a placeholder with nothing in it is dead', () => {
    expect(isDeadFactbox(buildFormTree(placeholder))).toBe(true);
  });
});

describe('ListPart FactBox section stays readable (F-59 / F-66)', () => {
  function pageWithFactboxes(): PageContextRepository {
    const repo = new PageContextRepository();
    repo.create('pc', 'ROOT');
    repo.registerDiscoveredChildForm('pc', { serverId: 'FB1', caption: 'Datos pendientes', controlTree: listPart, isSubForm: false, isPart: true });
    repo.registerDiscoveredChildForm('pc', { serverId: 'FB3', caption: 'Vacío', controlTree: placeholder, isSubForm: false, isPart: true });
    return repo;
  }

  it('builds as a list-shape section with rows[]', () => {
    const repo = pageWithFactboxes();
    const ctx = repo.get('pc')!;
    const id = [...ctx.sections.values()].find(s => s.formId === 'FB1')!.sectionId;
    const section = buildSection(ctx, id);
    expect(section).not.toBeNull();
    expect(section!.rows).toEqual([]);
  });

  it('an error never offers an invalidated section as available', () => {
    const repo = pageWithFactboxes();
    const ctx0 = repo.get('pc')!;
    const deadId = [...ctx0.sections.values()].find(s => s.formId === 'FB3')!.sectionId;
    repo.invalidateSection('pc', deadId);
    const ctx = repo.get('pc')!;

    expect(readableSectionIds(ctx)).not.toContain(deadId);
    const missing = resolveSection(ctx, 'factbox:nope');
    expect('error' in missing && missing.availableSections).not.toContain(deadId);
    const gone = resolveSection(ctx, deadId);
    expect('error' in gone).toBe(true);
    expect('error' in gone && gone.availableSections).not.toContain(deadId);
  });
});
