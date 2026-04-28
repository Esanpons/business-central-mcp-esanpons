# Section-as-First-Class MCP Output Plan (limits.md #2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-tool ad-hoc output shape (`bc_open_page` returns top-level `fields/actions/rows`; `bc_read_data` returns `rows[]` only) with a uniform `Section[]` array. Each section carries `fields/actions/rows` only when present. This subsumes limits.md item #2 (FactBox parts invisible) — the underlying repo is already factbox-aware (`src/protocol/page-context-repo.ts:343,393`), but no DTO surfaces it.

**Architecture:** A new `Section` output DTO becomes the lingua franca. `bc_open_page` returns `sections: Section[]` for every section the repo has tracked (header, lines, subpages, factboxes, requestPage). `bc_read_data` returns the same `Section` for the single requested section, after applying filters / range. A central pure adapter builds a `Section` from `(PageContext, sectionId)` so open-page, read-data, and navigate-drilldown all emit identical shapes. Header is `sections[0]` with `kind:'header'` — no special-case top-level lists.

**Tech Stack:** TypeScript (ESM, strict), Vitest, Node ≥ 20. No new dependencies. Pre-release project — `CLAUDE.md` allows breaking changes.

**Pre-flight:** Work in a dedicated worktree branched off master. Run `npx tsc --noEmit && npx vitest run` and confirm green before starting. Run `npx vitest run --config vitest.integration.config.ts tests/integration/multi-section.test.ts tests/integration/document-and-bc28.test.ts` against a live BC27 to capture baseline (some assertions will be replaced).

---

## File Structure

### New files
- `src/protocol/section-dto.ts` — `Section`, `SectionField`, `SectionAction`, `SectionRow` output DTOs and `buildSection(ctx, sectionId)` adapter
- `tests/protocol/section-dto.test.ts` — unit tests for the adapter using synthetic `PageContext` fixtures

### Modified files
- `src/operations/open-page.ts` — replace top-level `fields/actions/rows` with `sections: Section[]`
- `src/operations/read-data.ts` — return a single `Section` (renamed output)
- `src/operations/navigate.ts` — drill-down branch returns `Section[]` for the target page; select branch returns the resolved section
- `src/mcp/schemas.ts` — refresh tool descriptions on `ReadDataSchema.section`
- `src/mcp/tool-registry.ts` — refresh `bc_open_page` and `bc_read_data` tool descriptions to document the new shape
- `src/api/routes.ts` — update HTTP API doc strings if any reference old shape (verify only)
- `src/protocol/types.ts` — re-export `Section` type for downstream use
- `tests/integration/multi-section.test.ts` — assert on `sections[]` shape
- `tests/integration/document-and-bc28.test.ts` — assert on `sections[]` shape
- `tests/integration/page-service.test.ts` — adjust open-page assertions
- `tests/integration/advanced-workflows.test.ts` — adjust where it reads `fields/actions/rows` directly
- `tests/integration/edge-cases.test.ts` — adjust
- `tests/integration/workflow-smoke.test.ts` — adjust
- `tests/integration/phase3-features.test.ts`, `phase3-workflows.test.ts`, `phase4-features.test.ts`, `phase4-destructive.test.ts`, `phase5-features.test.ts` — adjust as each touches the changed shape

### Deleted
- The `OpenPageOutput.fields/actions/rows` top-level fields (replaced by `sections[0]` etc.).

---

## Conventions for every task

- Use `npx vitest run <path>` for narrow runs, `npx vitest run tests/unit tests/protocol` for the unit/protocol sweep
- After each task: typecheck (`npx tsc --noEmit`), narrow test (must pass), full unit/protocol sweep (must pass)
- Integration tests run only after Task 9 lands; expect adjustments
- Commit message format: `refactor:` for shape migration, `feat:` only when introducing new capability
- All file paths use forward slashes in bash on Windows. Never use `2>nul`. Use `2>/dev/null` for piped silencing in bash (works because we run in Git Bash).
- ESM imports must include `.js` extension even when source is `.ts`

---

## Task 1: Define the Section DTO

**Files:**
- Create: `src/protocol/section-dto.ts`
- Test: `tests/protocol/section-dto.test.ts`

- [ ] **Step 1: Write the failing structural test**

Create `tests/protocol/section-dto.test.ts`:

```typescript
// tests/protocol/section-dto.test.ts
import { describe, it, expect } from 'vitest';
import type { Section, SectionField, SectionAction, SectionRow } from '../../src/protocol/section-dto.js';

describe('Section DTO shape', () => {
  it('exposes the documented top-level fields', () => {
    const s: Section = {
      sectionId: 'header',
      kind: 'header',
      caption: 'Customer',
      fields: [],
      actions: [],
    };
    expect(s.sectionId).toBe('header');
    expect(s.kind).toBe('header');
  });

  it('SectionField carries caption, value, editable, type', () => {
    const f: SectionField = { name: 'No.', value: '10000', editable: false, type: 'sc' };
    expect(f.name).toBe('No.');
  });

  it('SectionAction carries name, systemAction, enabled', () => {
    const a: SectionAction = { name: 'Post', systemAction: 0, enabled: true };
    expect(a.systemAction).toBe(0);
  });

  it('SectionRow carries bookmark and cells', () => {
    const r: SectionRow = { bookmark: 'BMK1', cells: { 'No.': '10000' } };
    expect(r.bookmark).toBe('BMK1');
  });
});
```

- [ ] **Step 2: Run the test, expect compile failure**

Run: `npx vitest run tests/protocol/section-dto.test.ts`
Expected: FAIL — `Cannot find module '../../src/protocol/section-dto.js'`.

- [ ] **Step 3: Create the DTO module**

Create `src/protocol/section-dto.ts`:

```typescript
// src/protocol/section-dto.ts
//
// MCP output DTO for a single page section. A page is a flat list of sections;
// each section is one of: header (the root form's primary content),
// lines (the document's lines repeater), factbox (a CardPart attached as a
// FactBox), subpage (any other embedded part), requestPage (a report's
// request-page modal). Internal code reads FieldNode/ActionNode via
// form-views.ts; this DTO is the shape exposed to MCP callers.

import type { SectionKind } from './section-resolver.js';

export interface SectionField {
  /** Field caption as shown in the BC client. Used as the cell key in row.cells. */
  readonly name: string;
  /** Display string. Undefined for fields that have no string projection (e.g. boolean tristate). */
  readonly value?: string;
  readonly editable: boolean;
  /** Wire-level field type: sc, dc, bc, dtc, i32c, sec, pc, ssc. */
  readonly type: string;
  /** True if BC marked the field as mandatory. */
  readonly showMandatory?: boolean;
  /** True if the field has an AssistEdit/Lookup action attached. */
  readonly isLookup?: boolean;
}

export interface SectionAction {
  readonly name: string;
  readonly systemAction: number;
  readonly enabled: boolean;
  /** Wizard role on a NavigatePage / StandardDialog. */
  readonly wizardNav?: 'back' | 'next' | 'finish' | 'cancel';
}

export interface SectionRow {
  readonly bookmark: string;
  readonly cells: Record<string, unknown>;
}

export interface Section {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  /**
   * Card-shape sections (header, factbox, requestPage, most subpages) carry
   * `fields[]` populated with visible, captioned fields.
   */
  readonly fields?: readonly SectionField[];
  /**
   * List-shape sections (lines, list-bodied subpages) carry `rows[]`.
   * `totalRowCount` reflects BC's TotalRowCount property; null when unknown.
   */
  readonly rows?: readonly SectionRow[];
  readonly totalRowCount?: number | null;
  readonly actions?: readonly SectionAction[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/protocol/section-dto.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/section-dto.ts tests/protocol/section-dto.test.ts
git commit -m "feat: add Section MCP output DTO"
```

---

## Task 2: buildSection adapter

**Files:**
- Modify: `src/protocol/section-dto.ts`
- Modify: `tests/protocol/section-dto.test.ts`

- [ ] **Step 1: Add the failing adapter tests**

Append to `tests/protocol/section-dto.test.ts`:

```typescript
import { buildSection } from '../../src/protocol/section-dto.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { SectionDescriptor } from '../../src/protocol/section-resolver.js';

function makeFormState(formId: string, raw: unknown): FormState {
  return { formId, root: buildFormTree(raw), rows: new Map() };
}

function makeCtx(opts: {
  forms: Map<string, FormState>;
  sections: Map<string, SectionDescriptor>;
  rootFormId: string;
}): PageContext {
  return {
    pageContextId: 'pc:1',
    rootFormId: opts.rootFormId,
    pageType: 'Card',
    caption: 'Test Page',
    forms: opts.forms,
    sections: opts.sections,
    dialogs: [],
    ownedFormIds: [opts.rootFormId],
    isModal: false,
    wizardState: null,
  };
}

describe('buildSection', () => {
  it('builds a header section with visible captioned fields', () => {
    const root = {
      t: 'lf', ServerId: 'root', PageType: 0, Caption: 'Customer',
      Children: [
        { t: 'sc', Caption: 'No.', StringValue: '10000', Visible: true, Editable: false },
        { t: 'sc', Caption: 'Name', StringValue: 'Contoso', Visible: true, Editable: true },
        { t: 'sc', Caption: 'Hidden', StringValue: 'x', Visible: false, Editable: false },
      ],
    };
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', root)]]),
      sections: new Map<string, SectionDescriptor>([['header', {
        sectionId: 'header', kind: 'header', caption: 'Customer',
        formId: 'root', valid: true,
      }]]),
    });
    const section = buildSection(ctx, 'header');
    expect(section).not.toBeNull();
    expect(section!.kind).toBe('header');
    expect(section!.fields).toHaveLength(2);
    expect(section!.fields![0]).toMatchObject({ name: 'No.', value: '10000', editable: false });
    expect(section!.rows).toBeUndefined();
  });

  it('builds a lines section with rows but no fields', () => {
    const child = {
      t: 'lf', ServerId: 'child', PageType: 1, Caption: 'Lines',
      Children: [{
        t: 'rc',
        Columns: [
          { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1', Path: '37.1' } },
          { t: 'rcc', Caption: 'Quantity', ColumnBinder: { Name: 'c2', Path: '37.5' } },
        ],
      }],
    };
    const childForm = makeFormState('child', child);
    childForm.rows.set('server:c[0]', [
      { bookmark: 'BMK1', cells: { 'No.': 'ITEM1', 'Quantity': '5' } },
    ]);

    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map<string, FormState>([
        ['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 5, Children: [] })],
        ['child', childForm],
      ]),
      sections: new Map<string, SectionDescriptor>([
        ['header', { sectionId: 'header', kind: 'header', caption: 'Sales Order', formId: 'root', valid: true }],
        ['lines', {
          sectionId: 'lines', kind: 'lines', caption: 'Lines',
          formId: 'child', repeaterControlPath: 'server:c[0]', valid: true,
        }],
      ]),
    });
    const section = buildSection(ctx, 'lines');
    expect(section!.kind).toBe('lines');
    expect(section!.rows).toEqual([
      { bookmark: 'BMK1', cells: { 'No.': 'ITEM1', 'Quantity': '5' } },
    ]);
    expect(section!.fields).toBeUndefined();
  });

  it('returns null for an invalid sectionId', () => {
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 0, Children: [] })]]),
      sections: new Map(),
    });
    expect(buildSection(ctx, 'nonexistent')).toBeNull();
  });

  it('emits actions only on the header section', () => {
    const root = {
      t: 'lf', ServerId: 'root', PageType: 0, Caption: 'Customer',
      Children: [
        { t: 'ac', Caption: 'New', SystemAction: 10, Enabled: true, Visible: true },
        { t: 'ac', Caption: 'Delete', SystemAction: 20, Enabled: true, Visible: true },
      ],
    };
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', root)]]),
      sections: new Map([['header', {
        sectionId: 'header', kind: 'header', caption: 'Customer', formId: 'root', valid: true,
      }]]),
    });
    const section = buildSection(ctx, 'header');
    expect(section!.actions).toHaveLength(2);
    expect(section!.actions![0].name).toBe('New');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/protocol/section-dto.test.ts`
Expected: FAIL — `buildSection is not a function`.

- [ ] **Step 3: Implement `buildSection`**

Append to `src/protocol/section-dto.ts`:

```typescript
import { resolveSection } from './section-resolver.js';
import {
  fields as treeFields,
  actions as treeActions,
  groupVisibility as treeGroupVisibility,
} from './form-views.js';
import { isEffectivelyVisible } from './visibility.js';
import { mapRowCellKeys } from '../services/data-service.js';
import type { ActionNode } from './form-node.js';
import type { PageContext } from './page-context.js';

function classifyWizardNav(a: ActionNode): 'back' | 'next' | 'finish' | 'cancel' | undefined {
  const id = a.iconIdentifier;
  if (id) {
    if (/PreviousRecord/i.test(id)) return 'back';
    if (/NextRecord|Action_Start/i.test(id)) return 'next';
    if (/Approve/i.test(id)) return 'finish';
  }
  if (a.systemAction === 310 || a.systemAction === 320 || a.systemAction === 350) return 'cancel';
  return undefined;
}

/**
 * Build the Section DTO for `sectionId` in `ctx`. Returns `null` when the
 * sectionId is unknown or the section has been invalidated.
 *
 * Card-shape sections emit `fields[]` (and `actions[]` for header sections);
 * list-shape sections emit `rows[]` and `totalRowCount`. Header sections
 * always include `actions[]` because actions are reachable only from the root
 * form.
 */
export function buildSection(ctx: PageContext, sectionId: string): Section | null {
  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved) return null;
  const { section, form, repeater, rows } = resolved;

  const isHeader = section.kind === 'header';
  const isList = !!repeater;

  const root = form.root;
  const groupVis = treeGroupVisibility(root);
  const ws = ctx.wizardState;

  const out: {
    sectionId: string;
    kind: typeof section.kind;
    caption: string;
    fields?: SectionField[];
    rows?: SectionRow[];
    totalRowCount?: number | null;
    actions?: SectionAction[];
  } = {
    sectionId: section.sectionId,
    kind: section.kind,
    caption: section.caption,
  };

  if (isList && repeater) {
    out.rows = mapRowCellKeys(
      [...rows],
      repeater.columns.map(c => ({
        controlPath: c.controlPath,
        caption: c.properties.caption ?? '',
        type: 'rcc' as const,
        columnBinderName: c.columnBinder?.name,
        columnBinderPath: c.columnBinder?.path,
      })),
    ).map(r => ({ bookmark: r.bookmark, cells: r.cells }));
    out.totalRowCount = repeater.properties.totalRowCount ?? null;
  } else {
    out.fields = treeFields(root)
      .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, ws))
      .map(f => ({
        name: f.properties.caption!,
        value: f.properties.stringValue,
        editable: f.properties.editable ?? false,
        type: f.type,
        ...(f.properties.showMandatory ? { showMandatory: true as const } : {}),
        ...(f.hasLookup ? { isLookup: true as const } : {}),
      }));
  }

  if (isHeader) {
    out.actions = treeActions(root)
      .filter(a => (a.properties.enabled ?? true) && a.properties.caption
        && isEffectivelyVisible(root, a.controlPath, groupVis, ws))
      .map(a => {
        const wn = classifyWizardNav(a);
        return {
          name: a.properties.caption!,
          systemAction: a.systemAction,
          enabled: a.properties.enabled ?? true,
          ...(wn ? { wizardNav: wn } : {}),
        };
      });
  }

  return out as Section;
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `npx vitest run tests/protocol/section-dto.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/section-dto.ts tests/protocol/section-dto.test.ts
git commit -m "feat: implement buildSection DTO adapter"
```

---

## Task 3: Add buildAllSections helper

**Files:**
- Modify: `src/protocol/section-dto.ts`
- Modify: `tests/protocol/section-dto.test.ts`

- [ ] **Step 1: Add a failing ordering test**

Append to `tests/protocol/section-dto.test.ts`:

```typescript
import { buildAllSections } from '../../src/protocol/section-dto.js';

describe('buildAllSections', () => {
  it('emits sections in canonical order: header, lines, subpages, factboxes', () => {
    const rootForm = makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 5, Children: [] });
    const subForm = makeFormState('sub', { t: 'lf', ServerId: 'sub', PageType: 4, Children: [] });
    const fbForm = makeFormState('fb', { t: 'lf', ServerId: 'fb', PageType: 3, Children: [] });

    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', rootForm], ['sub', subForm], ['fb', fbForm]]),
      sections: new Map<string, SectionDescriptor>([
        // Insertion order intentionally scrambled; output order must be canonical
        ['factbox:Customer FactBox', { sectionId: 'factbox:Customer FactBox', kind: 'factbox', caption: 'FactBox', formId: 'fb', valid: true }],
        ['lines', { sectionId: 'lines', kind: 'lines', caption: 'Lines', formId: 'sub', valid: true }],
        ['header', { sectionId: 'header', kind: 'header', caption: 'Sales Order', formId: 'root', valid: true }],
      ]),
    });

    const sections = buildAllSections(ctx);
    expect(sections.map(s => s.kind)).toEqual(['header', 'lines', 'factbox']);
  });

  it('skips invalid sections', () => {
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 0, Children: [] })]]),
      sections: new Map<string, SectionDescriptor>([
        ['header', { sectionId: 'header', kind: 'header', caption: 'Customer', formId: 'root', valid: true }],
        ['stale', { sectionId: 'stale', kind: 'subpage', caption: 'Old', formId: 'gone', valid: false }],
      ]),
    });
    const sections = buildAllSections(ctx);
    expect(sections.map(s => s.sectionId)).toEqual(['header']);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/protocol/section-dto.test.ts -t buildAllSections`
Expected: FAIL — `buildAllSections is not a function`.

- [ ] **Step 3: Implement `buildAllSections`**

Append to `src/protocol/section-dto.ts`:

```typescript
import type { SectionKind } from './section-resolver.js';

const SECTION_KIND_ORDER: Record<SectionKind, number> = {
  header: 0,
  lines: 1,
  subpage: 2,
  factbox: 3,
  requestPage: 4,
};

/**
 * Emit every valid section in `ctx` in canonical order: header, lines,
 * subpages, factboxes, requestPage. Returns an empty array for a context
 * with no sections (defensive — should not occur in practice).
 */
export function buildAllSections(ctx: PageContext): Section[] {
  const out: Section[] = [];
  const ordered = Array.from(ctx.sections.values())
    .filter(s => s.valid)
    .sort((a, b) => SECTION_KIND_ORDER[a.kind] - SECTION_KIND_ORDER[b.kind]);
  for (const desc of ordered) {
    const built = buildSection(ctx, desc.sectionId);
    if (built !== null) out.push(built);
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/protocol/section-dto.test.ts`
Expected: PASS for all describe blocks.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/section-dto.ts tests/protocol/section-dto.test.ts
git commit -m "feat: add buildAllSections with canonical kind ordering"
```

---

## Task 4: Re-export Section from types.ts

**Files:**
- Modify: `src/protocol/types.ts`

- [ ] **Step 1: Add the re-export**

Append at the end of `src/protocol/types.ts`:

```typescript

// Section DTO re-export. New code should import from `protocol/section-dto.js`
// directly; this re-export keeps `protocol/types.js` as the single barrel for
// MCP DTOs.
export type { Section, SectionField, SectionAction, SectionRow } from './section-dto.js';
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/protocol/types.ts
git commit -m "refactor: re-export Section types from protocol/types"
```

---

## Task 5: Switch bc_open_page to sections[]

**Files:**
- Modify: `src/operations/open-page.ts`

- [ ] **Step 1: Replace the OpenPageOutput interface and body**

Overwrite `src/operations/open-page.ts` with:

```typescript
import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { buildAllSections } from '../protocol/section-dto.js';
import type { Section } from '../protocol/section-dto.js';

export interface OpenPageInput {
  pageId: string;
  bookmark?: string;
  tenantId?: string;
}

export interface OpenPageOutput {
  pageContextId: string;
  pageType: string;
  caption: string;
  /** True when the page opened as a modal (wizard, request page, confirmation). */
  isModal: boolean;
  sections: Section[];
}

export class OpenPageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: OpenPageInput): Promise<Result<OpenPageOutput, ProtocolError>> {
    const result = await this.pageService.openPage(input.pageId, {
      bookmark: input.bookmark,
      tenantId: input.tenantId,
    });

    return mapResult(result, (ctx) => ({
      pageContextId: ctx.pageContextId,
      pageType: ctx.pageType,
      caption: ctx.caption || ctx.rootFormId,
      isModal: ctx.isModal,
      sections: buildAllSections(ctx),
    }));
  }
}
```

- [ ] **Step 2: Typecheck (expect downstream errors)**

Run: `npx tsc --noEmit`
Expected: errors in tests that read `OpenPageOutput.fields/actions/rows`. Note them — Tasks 9-12 fix them.

- [ ] **Step 3: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: all pass (no test there reads the old shape directly).

- [ ] **Step 4: Commit**

```bash
git add src/operations/open-page.ts
git commit -m "refactor: bc_open_page returns sections[]"
```

---

## Task 6: Switch bc_read_data to a Section result

**Files:**
- Modify: `src/operations/read-data.ts`

- [ ] **Step 1: Rewrite the operation**

Overwrite `src/operations/read-data.ts` with:

```typescript
import { isOk, isErr, ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { DataService } from '../services/data-service.js';
import type { FilterService } from '../services/filter-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { buildSection, type Section } from '../protocol/section-dto.js';

export interface ReadDataInput {
  pageContextId: string;
  section?: string;
  tab?: string;
  filters?: Array<{ column: string; value: string }>;
  columns?: string[];
  range?: { offset: number; limit: number };
}

export interface ReadDataOutput {
  section: Section;
}

export class ReadDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly filterService: FilterService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: ReadDataInput): Promise<Result<ReadDataOutput, ProtocolError>> {
    const sectionId = input.section ?? 'header';

    if (input.filters && input.filters.length > 0) {
      const filterResult = await this.filterService.applyFilters(input.pageContextId, input.filters, input.section);
      if (isErr(filterResult)) return filterResult;
    }

    // For repeater-bearing sections, materialize rows up to the requested range
    // so the resulting Section.rows reflects the slice the caller asked for.
    if (input.range) {
      const ctx = this.repo.get(input.pageContextId);
      if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));
      const totalRowCount = this.dataService.getRepeaterTotalRowCount(input.pageContextId, input.section);
      const needed = input.range.offset + input.range.limit;
      let loaded = (this.dataService.readRows(input.pageContextId, input.section));
      if (isOk(loaded)) {
        let rowsLen = loaded.value.length;
        while (rowsLen < needed && rowsLen < (totalRowCount ?? Infinity)) {
          const scrollResult = await this.dataService.scrollRepeater(input.pageContextId, 1, input.section);
          if (!isOk(scrollResult)) break;
          if (scrollResult.value.length <= rowsLen) break;
          rowsLen = scrollResult.value.length;
        }
      }
    }

    const ctxAfter = this.repo.get(input.pageContextId);
    if (!ctxAfter) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));

    const section = buildSection(ctxAfter, sectionId);
    if (!section) {
      return err(new ProtocolError(`Section '${sectionId}' not found.`, {
        availableSections: Array.from(ctxAfter.sections.keys()),
      }));
    }

    let materialized: Section = section;

    if (input.tab && materialized.fields) {
      const tabsResult = this.dataService.getTabs(input.pageContextId, input.section);
      if (isOk(tabsResult) && tabsResult.value) {
        const matchingTab = tabsResult.value.find(t => t.caption.toLowerCase() === input.tab!.toLowerCase());
        if (matchingTab) {
          const tabFieldCaptions = new Set(matchingTab.fields.map(f => f.caption.toLowerCase()));
          materialized = {
            ...materialized,
            fields: materialized.fields.filter(f => tabFieldCaptions.has(f.name.toLowerCase())),
          };
        }
      }
    }

    if (input.columns && input.columns.length > 0) {
      const wanted = new Set(input.columns.map(c => c.toLowerCase()));
      if (materialized.rows) {
        materialized = {
          ...materialized,
          rows: materialized.rows.map(r => ({
            bookmark: r.bookmark,
            cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => wanted.has(k.toLowerCase()))),
          })),
        };
      }
      if (materialized.fields) {
        materialized = {
          ...materialized,
          fields: materialized.fields.filter(f => wanted.has(f.name.toLowerCase())),
        };
      }
    }

    if (input.range && materialized.rows) {
      materialized = {
        ...materialized,
        rows: materialized.rows.slice(input.range.offset, input.range.offset + input.range.limit),
      };
    }

    return ok({ section: materialized });
  }
}
```

- [ ] **Step 2: Pass the repo into ReadDataOperation in `src/server.ts`**

Modify `src/server.ts` line 76:

```typescript
readData: new ReadDataOperation(dataService, filterService, pageContextRepo),
```

- [ ] **Step 3: Pass the repo into ReadDataOperation in `src/stdio-server.ts`**

Find the matching line and update identically:

Run: `npx vitest run tests/unit/read-data-range.test.ts` to surface the test that uses old constructor.
The test must be updated — see Task 12.

- [ ] **Step 4: Typecheck (errors expected; resolved by later tasks)**

Run: `npx tsc --noEmit`
Expected: errors only in tests/integration that read old shape; main code typechecks.

- [ ] **Step 5: Commit**

```bash
git add src/operations/read-data.ts src/server.ts src/stdio-server.ts
git commit -m "refactor: bc_read_data returns a Section"
```

---

## Task 7: Switch bc_navigate drill-down branch to sections[]

**Files:**
- Modify: `src/operations/navigate.ts`

- [ ] **Step 1: Update NavigateOutput and the drill_down branch**

Overwrite `src/operations/navigate.ts` with:

```typescript
import { isErr, mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { NavigationService } from '../services/navigation-service.js';
import { buildAllSections, buildSection, type Section } from '../protocol/section-dto.js';

export interface NavigateInput {
  pageContextId: string;
  bookmark: string;
  action?: 'drill_down' | 'select' | 'lookup';
  section?: string;
  field?: string;
}

export interface NavigateOutput {
  /** Set when action='drill_down' lands on a new page. */
  targetPageContextId?: string;
  pageType?: string;
  /** Sections of the target page (drill_down) or the resolved section (select). */
  sections?: Section[];
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class NavigateOperation {
  constructor(private readonly navigationService: NavigationService) {}

  async execute(input: NavigateInput): Promise<Result<NavigateOutput, ProtocolError>> {
    if (input.action === 'drill_down') {
      const result = await this.navigationService.drillDown(input.pageContextId, input.bookmark, input.section);
      return mapResult(result, (r) => ({
        targetPageContextId: r.targetPageContext.pageContextId,
        pageType: r.targetPageContext.pageType,
        sections: buildAllSections(r.targetPageContext),
        changedSections: [],
        dialogsOpened: [],
        requiresDialogResponse: false,
      }));
    }

    const result = await this.navigationService.selectRow(input.pageContextId, input.bookmark, input.section);
    if (isErr(result)) return result;
    return mapResult(result, (ctx) => {
      const sectionId = input.section ?? 'header';
      const section = buildSection(ctx, sectionId);
      return {
        sections: section ? [section] : [],
        changedSections: [],
        dialogsOpened: [],
        requiresDialogResponse: false,
      };
    });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors only in tests referencing old NavigateOutput.fields/rows; resolved later.

- [ ] **Step 3: Commit**

```bash
git add src/operations/navigate.ts
git commit -m "refactor: bc_navigate drill_down returns sections[]"
```

---

## Task 8: Update tool descriptions

**Files:**
- Modify: `src/mcp/tool-registry.ts`
- Modify: `src/mcp/schemas.ts`

- [ ] **Step 1: Update bc_open_page description**

In `src/mcp/tool-registry.ts`, replace the `bc_open_page` description (lines ~57-65) with:

```typescript
      description: `Opens a Business Central page by its numeric page ID and returns its complete state as a list of sections. Each section has an id, kind (header / lines / factbox / subpage / requestPage), caption, and the appropriate content shape: card-style sections (header, factbox, requestPage) carry fields[] and (for header) actions[]; list-style sections (lines, subpages backed by a repeater) carry rows[] and totalRowCount. This is the entry point for all Business Central operations -- it returns a pageContextId that every other bc_ tool requires as input. Use bc_search_pages first if you do not know the page ID for an entity.

Card pages (single-record views like Customer Card=21) return one header section plus any FactBox sections attached to the page. List pages (Customer List=22) return a header section that is itself list-shaped (rows[] populated). Document pages (Sales Order=42) return a header card-section, a "lines" list-section with the document lines, and any FactBoxes.

Typical workflow: bc_open_page -> bc_read_data (refresh / filter / paginate a section) -> bc_write_data (edit fields in any section) -> bc_execute_action (post / release / delete) -> bc_close_page. Always call bc_close_page when done. Do NOT call this if the page is already open -- reuse the existing pageContextId.

Optional bookmark parameter opens a Card page to a specific record. Bookmarks come from list rows in any prior section.

Example: { "pageId": 22 } opens Customer List. Returned sections: [{sectionId:"header", kind:"header", rows:[...], fields:undefined, actions:[...]}]. { "pageId": 21, "bookmark": "..." } opens Customer Card. Returned sections include the header card plus FactBoxes (e.g. {sectionId:"factbox:Customer Statistics", kind:"factbox", fields:[...]}).`,
```

- [ ] **Step 2: Update bc_read_data description**

Replace the `bc_read_data` description (lines ~71-87) with:

```typescript
      description: `Refreshes a single section on an already-open page. Returns one Section: { sectionId, kind, caption, fields?, rows?, actions?, totalRowCount? }. Card-shape sections (header, factbox, requestPage) refresh their fields[]; list-shape sections refresh rows[]. Requires a pageContextId from a prior bc_open_page call.

Pass section: "header" (default) to refresh the page's header. Pass section: "lines" to refresh document line items. Pass a factbox sectionId (e.g. "factbox:Customer Statistics", as listed in the bc_open_page response) to refresh the FactBox card.

Filtering applies to list-shape sections only. Pass an array of { column, value }; values use BC filter syntax (exact "10000", ranges "10000..20000", wildcards "*consulting*", expressions ">1000"). Multiple filters combine with AND.

Column selection: pass columns: ["No.", "Name"] to limit the cells in each row (or fields[] entries on a card section).

Range slicing: { offset, limit } returns rows[offset..offset+limit] for list sections. Use with totalRowCount for pagination.

Examples:
- Refresh header: { pageContextId: "abc" }
- Filter customer list: { pageContextId: "abc", filters: [{ column: "City", value: "London" }] }
- Read sales order lines: { pageContextId: "abc", section: "lines" }
- Refresh a FactBox: { pageContextId: "abc", section: "factbox:Customer Statistics" }`,
```

- [ ] **Step 3: Refresh ReadDataSchema's `section` description**

In `src/mcp/schemas.ts`, replace line 17:

```typescript
  section: z.string().optional().describe('Section id to refresh. Defaults to "header". Examples: "lines" (document line items), "factbox:Customer Statistics" (FactBox). Listed in the bc_open_page sections array.'),
```

- [ ] **Step 4: Typecheck and unit tests**

Run: `npx tsc --noEmit`
Expected: no errors in src/.

Run: `npx vitest run tests/unit/tool-descriptions.test.ts`
Expected: pass — descriptions still meet the 3-4 sentence threshold; if the test enforces specific keywords, update accordingly.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tool-registry.ts src/mcp/schemas.ts
git commit -m "docs: update tool descriptions for sections[] shape"
```

---

## Task 9: Drop empty factbox sections from output

**Files:**
- Modify: `src/services/page-service.ts`
- Modify: `src/protocol/page-context-repo.ts` (if a section-invalidate API doesn't already exist; verify)

- [ ] **Step 1: Add a failing integration assertion**

Augment `tests/integration/multi-section.test.ts` with a case that opens a Customer Card and asserts the FactBox sections appear with non-empty fields. (If the existing test already does this, skip ahead.)

```typescript
it('Customer Card returns FactBox sections with populated fields', async () => {
  const ctx = await session.openPage(21, { bookmark: customerBookmark });
  const fbSections = ctx.sections.filter(s => s.kind === 'factbox');
  expect(fbSections.length).toBeGreaterThan(0);
  for (const fb of fbSections) {
    expect(fb.fields, `FactBox '${fb.caption}' has no fields`).toBeDefined();
    expect(fb.fields!.length, `FactBox '${fb.caption}' is empty`).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Mark factbox sections invalid when no fields are loaded**

In `src/services/page-service.ts`, after `await this.triggerFactboxRefresh(pageContextId)` finishes, walk `ctx.sections` and invalidate any factbox section whose `formId`'s `FormState.root` has zero captioned fields:

```typescript
    // After factbox refresh: any factbox section whose form has no captioned
    // fields is dead (BC returned a stub). Mark it invalid so Section DTO
    // builders skip it.
    const finalCtx = this.repo.get(pageContextId);
    if (finalCtx) {
      for (const [sectionId, sec] of finalCtx.sections) {
        if (sec.kind !== 'factbox') continue;
        const f = finalCtx.forms.get(sec.formId);
        if (!f) continue;
        const captioned = treeFields(f.root).filter(fn => fn.properties.caption);
        if (captioned.length === 0) {
          this.repo.invalidateSection(pageContextId, sectionId);
        }
      }
    }
```

- [ ] **Step 3: Add `invalidateSection` to `PageContextRepository`**

In `src/protocol/page-context-repo.ts`, add a method:

```typescript
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
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/page-service.ts src/protocol/page-context-repo.ts
git commit -m "refactor: invalidate empty factbox sections after refresh"
```

---

## Task 10: Migrate integration test fixtures

**Files (one task per file — split commits):**
- Modify: `tests/integration/multi-section.test.ts`
- Modify: `tests/integration/document-and-bc28.test.ts`
- Modify: `tests/integration/page-service.test.ts`
- Modify: `tests/integration/advanced-workflows.test.ts`
- Modify: `tests/integration/edge-cases.test.ts`
- Modify: `tests/integration/workflow-smoke.test.ts`
- Modify: `tests/integration/phase3-features.test.ts`
- Modify: `tests/integration/phase3-workflows.test.ts`
- Modify: `tests/integration/phase4-features.test.ts`
- Modify: `tests/integration/phase4-destructive.test.ts`
- Modify: `tests/integration/phase5-features.test.ts`

For each file:

- [ ] **Step 1: Replace `result.fields` with `result.sections.find(s => s.kind === 'header')?.fields`**

Use a single Edit per file with replace_all on common patterns. Example:

```typescript
// before
expect(result.value.fields.find(f => f.name === 'Name')).toBeDefined();
// after
const header = result.value.sections.find(s => s.kind === 'header');
expect(header?.fields?.find(f => f.name === 'Name')).toBeDefined();
```

- [ ] **Step 2: Replace `result.rows` (list pages) with `result.sections.find(s => s.kind === 'header')?.rows`**

- [ ] **Step 3: Replace `result.actions` with `result.sections.find(s => s.kind === 'header')?.actions`**

- [ ] **Step 4: Replace `readData` result reads (`result.rows`, `result.totalCount`) with `result.section.rows`, `result.section.rows.length`**

`totalCount` was a derived count; `result.section.rows.length` replaces it. `totalRowCount` becomes `result.section.totalRowCount`.

- [ ] **Step 5: Run the file's tests against live BC**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/<file>.test.ts`
Expected: pass.

- [ ] **Step 6: Commit per file**

```bash
git add tests/integration/<file>.test.ts
git commit -m "test: migrate <file> to sections[] shape"
```

---

## Task 11: Update unit tests that touch the operation outputs

**Files:**
- Modify: `tests/unit/read-data-range.test.ts`
- Modify: `tests/unit/page-service-config.test.ts`
- Modify: `tests/unit/tool-descriptions.test.ts`

- [ ] **Step 1: Update read-data-range constructor signature**

In `tests/unit/read-data-range.test.ts`, the existing `new ReadDataOperation(dataService, filterService)` calls must pass `pageContextRepo` as the third arg. Locate the test's repo fixture (it likely already exists for filter setup); thread it through. Replace assertions on `result.rows` with `result.section.rows`, on `result.totalCount` with `result.section.rows.length`, on `result.totalRowCount` with `result.section.totalRowCount`.

- [ ] **Step 2: Update page-service-config**

If this test asserts on OpenPageOutput fields, replace with sections checks as in Task 10.

- [ ] **Step 3: Update tool-descriptions test**

If it greps for keywords in tool descriptions, ensure the new descriptions still match.

- [ ] **Step 4: Run unit sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tests/unit
git commit -m "test: update unit suites for sections[] shape"
```

---

## Task 12: Final cross-check and full regression

- [ ] **Step 1: Final typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: all pass.

- [ ] **Step 3: Full integration sweep against BC27**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: all pass against a live BC27 environment.

- [ ] **Step 4: Manual end-to-end via stdio**

```bash
npm run start:stdio-direct
```

In a Claude Desktop session pointed at the local server, call `bc_open_page { pageId: 21, bookmark: "<known customer>" }` and confirm the response contains a `sections` array with at least a `header` section and one `factbox:*` section, each with non-empty `fields`.

- [ ] **Step 5: Update CHANGELOG / docs**

Append a "Sections-as-first-class output" section to `README.md` (if a Tools section exists) describing the new shape. No need for a separate doc file.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document sections[] tool output shape"
```

---

## Self-review checklist

- [ ] Every limits.md #2 symptom listed in the spec is covered:
  - "factbox part fields not in parent's fields[]" → header section's `fields[]` is purely header-scoped; factbox fields appear in their own sections
  - "bc_read_data with section: factbox:* returns empty" → buildSection returns the factbox card with fields[] populated
  - "no way to discover factbox sectionId" → bc_open_page returns the full sections array
- [ ] No placeholders, no "TBD", no "implement later"
- [ ] Type names consistent (Section, SectionField, SectionAction, SectionRow) used identically across files
- [ ] Each task ends with a commit
- [ ] Every code step shows the actual code
- [ ] Tests precede implementation in every task that introduces new behaviour
