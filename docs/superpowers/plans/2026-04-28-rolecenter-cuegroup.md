# Role Center & Cuegroup Support Plan (limits.md #1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Role Center pages, including the cue tiles inside their hosted CardParts. Today, opening a CardPart-only page like `6175308 (CDO Document Output Queues)` standalone returns a placeholder shell because BC's web server delivers CardParts as stubs unless reached through their host form. Limits.md #1 documents the symptom (single placeholder field, no actions). The architecturally-correct fix is twofold: (a) detect and reject CardPart-as-target with a structured, actionable error; (b) treat Role Center pages as first-class — load every hosted CardPart, parse its cuegroup gc nodes into a new section-level `cues[]` projection, and route DrillDown actions through the existing `bc_execute_action` pathway.

**Architecture:** The wire `cuegroup` AL keyword compiles to a `gc` GroupControl with cue-style field children (`i32c` integer cues, possibly `dc` decimal cues). The cue child's drill-down target is its `LookupAction`/`AssistEditAction` or its parent gc's `OnDrillDown`. We add a memoised `cues(root)` view to `form-views.ts` that collects gc descendants whose `mappingHint` matches the cuegroup pattern, paired with their child fields. The `Section` DTO grows an optional `cues: SectionCue[]`. `bc_execute_action` recognises a cue caption + section pair and resolves it to a DrillDown on the cue field's controlPath. `OpenPageOperation` recognises the standalone-CardPart-stub pattern and returns a structured error with hosting hints. `PageService.discoverAndLoadChildForms` loads Role-Center–hosted CardParts the same way it loads FactBoxes today.

**Tech Stack:** TypeScript (ESM, strict), Vitest. No new dependencies.

**Pre-flight:** This plan depends on the `section-first-class` plan (`Section` DTO and `buildSection` adapter). Merge that first. Also depends on a live wire capture against pages 6175308 and a Role Center hosting it (Task 1).

---

## File Structure

### New files
- `src/protocol/cue-detection.ts` — `isCueGroupNode(node)`, `isCueFieldNode(node)`, `cueDrillDownActionPath(field)` — pure functions, isolated for unit testing
- `src/protocol/captures/cuegroup-rolecenter-2026-04-28.json` — captured `lf` JSON from the live trace (committed as test fixture)
- `tests/protocol/cue-detection.test.ts`
- `tests/protocol/cuegroup-fixture.test.ts` — drives `buildFormTree` over the captured fixture and asserts the cue model
- `tests/integration/role-center.test.ts` — opens a Role Center on live BC, asserts populated cues

### Modified files
- `src/protocol/form-views.ts` — add `cues(root)` memoised view returning `CueView[]`
- `src/protocol/section-dto.ts` — `Section.cues?: SectionCue[]`; `buildSection` populates from the new view
- `src/protocol/section-resolver.ts` — section kind unchanged; CardPart child forms surface as `subpage` already
- `src/services/page-service.ts` — Role Center handling: enable factbox-style auto-load on hosted CardParts; do not skip `subpage` kind for `RoleCenter` page types
- `src/services/action-service.ts` — `executeOnCue` resolves a cue by section+name and sends `InvokeAction { systemAction: 120 (DrillDown) }` against the cue field's controlPath
- `src/operations/open-page.ts` — detect CardPart-stub responses, return structured error with `hostHint`
- `src/operations/execute-action.ts` — accept `cue` input variant
- `src/mcp/schemas.ts` — extend `ExecuteActionSchema`
- `src/mcp/tool-registry.ts` — refresh `bc_open_page` and `bc_execute_action` tool descriptions
- `tests/integration/multi-section.test.ts` — add Role Center smoke if env supports it

---

## Conventions for every task

- Wire-capture data goes under `src/protocol/captures/`. Keep redaction minimal but strip session keys.
- Use `npx vitest run <path>` for narrow runs, `npx vitest run tests/unit tests/protocol` for the unit/protocol sweep
- After each task: typecheck (`npx tsc --noEmit`), narrow test (must pass), full unit/protocol sweep (must pass)
- Integration test runs only at Task 9
- ESM imports include `.js` extension
- Commit messages: `feat:` for new capability, `refactor:` for shape moves, `test:` for fixture/test additions

---

## Task 1: Live wire capture — Role Center + CardPart

**Files:**
- Create: `src/protocol/captures/cuegroup-rolecenter-2026-04-28.json`
- Create: `src/protocol/captures/cuegroup-cardpart-standalone-2026-04-28.json`
- Create: `src/protocol/captures/README.md` (if not present)

This is research, not code. Without it later tasks cannot determine the exact `t` value, mapping hint, or drill-down action shape used by cue tiles in this BC version.

- [ ] **Step 1: Pick a Role Center that hosts a cuegroup CardPart**

For the Continia DemoPortal env: a Role Center hosting `6175308 CDO Document Output Queues`. Confirm by opening BC's web client and inspecting which Role Center surfaces those tiles. Note the page ID.

For BC27/BC28 default envs: any Business Manager–style role center has cuegroup tiles. Confirm via web client. Use page IDs `9018 (Business Manager Role Center)` or `9022 (Order Processor Role Center)` — whichever has visible cue tiles in the test env.

- [ ] **Step 2: Run a capture**

Set the logger to capture full payloads:

```bash
LOG_CHANNELS=protocol LOG_LEVEL=debug LOG_DIR=./logs npm start
```

In a separate Claude Desktop session pointed at the local server, call:

```
bc_open_page { pageId: 9022 }   # or whichever Role Center
```

Then call:

```
bc_open_page { pageId: 6175308 }   # standalone CardPart for the negative case
```

- [ ] **Step 3: Extract the relevant `lf` payloads**

From `./logs/protocol-*.log`, locate the `FormCreated` event for the Role Center and one of its hosted CardParts (`fhc → lf` walk). Save the raw `lf` JSON of the CardPart (with cuegroups) to `src/protocol/captures/cuegroup-rolecenter-2026-04-28.json`. Save the standalone-CardPart `lf` payload to `cuegroup-cardpart-standalone-2026-04-28.json`. Strip any `ServerSessionId`/`SessionKey` strings from the captured JSON; replace them with `"REDACTED"`.

- [ ] **Step 4: Document the capture format**

Create or update `src/protocol/captures/README.md`:

```markdown
# Wire-format captures

Frozen `lf` JSON payloads used as test fixtures for the form-tree builder and
section/cue projections. Each file is one `FormCreated.controlTree` payload as
sent by BC over the WebSocket, with `ServerSessionId` / `SessionKey` redacted.

| File | Source | Date |
|---|---|---|
| cuegroup-rolecenter-2026-04-28.json | Role Center 9022 in BC27, hosted CardPart with cuegroup | 2026-04-28 |
| cuegroup-cardpart-standalone-2026-04-28.json | Page 6175308 opened standalone (returns stub) | 2026-04-28 |

Add new captures here when the protocol-builder behaviour relies on a
wire-level shape that cannot be derived from the decompiled metadata
definitions alone.
```

- [ ] **Step 5: Commit**

```bash
git add src/protocol/captures/
git commit -m "test: capture Role Center + CardPart wire fixtures"
```

---

## Task 2: Identify the cue marker from the capture

**Files:**
- Read-only: `src/protocol/captures/cuegroup-rolecenter-2026-04-28.json`

This task is investigation; output is a documented decision recorded in the next task's code comments.

- [ ] **Step 1: Inspect the captured Role Center CardPart**

Open `cuegroup-rolecenter-2026-04-28.json`. Navigate down `Children[]` until you find the cuegroup `gc`. Examine:
- The gc's own properties: `MappingHint`, `DesignName`, `ControlIdentifier`
- Each child field's `t` (likely `i32c` for an integer count tile, `dc` for decimals)
- Each child field's `LookupAction` / `AssistEditAction` / `Style`
- Whether the gc has its own `Action` reference

- [ ] **Step 2: Record the discriminator**

Decide which property uniquely identifies a cuegroup at parse time. Plausible candidates (in priority order):
1. `MappingHint === 'CueGroup'` (most stable if BC emits this)
2. `DesignName` matching `/CueGroup$/i`
3. The gc has no caption AND its parent is `ControlContainerType.RoleCenterArea` AND every child is a numeric field with a Style of "StrongAccent" or similar
4. Walk the AL metadata model in the decompiled `Microsoft.Dynamics.Nav.Types` for `cuegroup` semantics

Write the decision into a short note saved in `src/protocol/captures/README.md`:

```markdown
## Cue discriminator (2026-04-28)

A gc node is treated as a cuegroup iff `<discriminator decided in Step 1>`.
A field child of a cuegroup gc is treated as a cue iff its `t` is a numeric
field type AND it carries a drill-down action (LookupAction or AssistEditAction).
Drill-down target: <discovered field>.
```

- [ ] **Step 3: Commit**

```bash
git add src/protocol/captures/README.md
git commit -m "docs: record cuegroup discriminator from live capture"
```

---

## Task 3: cue-detection module

**Files:**
- Create: `src/protocol/cue-detection.ts`
- Create: `tests/protocol/cue-detection.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/protocol/cue-detection.test.ts`:

```typescript
// tests/protocol/cue-detection.test.ts
import { describe, it, expect } from 'vitest';
import { isCueGroupNode, isCueFieldNode, cueDrillDownPath } from '../../src/protocol/cue-detection.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import type { GroupNode, FieldNode } from '../../src/protocol/form-node.js';
import { isGroupNode, isFieldNode } from '../../src/protocol/form-node.js';

// Fixture aligns with the discriminator chosen in Task 2. If the discriminator
// later changes, update this fixture's marker (e.g. swap MappingHint for
// DesignName).
function makeCueGroupGc(): unknown {
  return {
    t: 'lf', ServerId: 'rc', PageType: 2,
    Children: [
      {
        t: 'gc', MappingHint: 'CueGroup', DesignName: 'DocumentQueueCueGroup',
        Children: [
          {
            t: 'i32c', Caption: 'Failed', StringValue: '3',
            LookupAction: { ControlPath: 'server:c[0]/c[0]/lookup' },
          },
          {
            t: 'i32c', Caption: 'Pending', StringValue: '12',
            LookupAction: { ControlPath: 'server:c[0]/c[1]/lookup' },
          },
        ],
      },
      {
        t: 'gc', MappingHint: 'NotACue', DesignName: 'OtherGroup',
        Children: [{ t: 'sc', Caption: 'Note', StringValue: 'hello' }],
      },
    ],
  };
}

describe('cue-detection', () => {
  const tree = buildFormTree(makeCueGroupGc());
  const groups = (tree as any).children.filter(isGroupNode) as GroupNode[];

  it('isCueGroupNode true for the cuegroup, false for the other gc', () => {
    expect(isCueGroupNode(groups[0])).toBe(true);
    expect(isCueGroupNode(groups[1])).toBe(false);
  });

  it('isCueFieldNode true only for numeric fields inside a cuegroup', () => {
    const cueGroup = groups[0];
    const cues = cueGroup.children.filter(isFieldNode) as FieldNode[];
    expect(cues).toHaveLength(2);
    for (const cue of cues) expect(isCueFieldNode(cue)).toBe(true);

    // A non-numeric field inside the same group must not be a cue
    const fakeText: FieldNode = {
      type: 'sc', controlPath: 'x', properties: { caption: 'note' },
    };
    expect(isCueFieldNode(fakeText)).toBe(false);
  });

  it('cueDrillDownPath returns the field controlPath when the field has a lookup action', () => {
    const cueGroup = groups[0];
    const cue = cueGroup.children[0] as FieldNode;
    expect(cueDrillDownPath(cue)).toBe(cue.controlPath);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/protocol/cue-detection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/protocol/cue-detection.ts`:

```typescript
// src/protocol/cue-detection.ts
//
// Detects cue tiles in a parsed FormNode tree. Cuegroups are AL `cuegroup`
// containers — a `gc` GroupControl whose children are numeric "cue" fields,
// each with a drill-down action that opens the underlying list. The
// discriminator was chosen in Task 2 of the cuegroup plan based on a live
// capture (see src/protocol/captures/README.md).

import { isFieldNode, isGroupNode, type FieldNode, type FormNode, type GroupNode } from './form-node.js';

const NUMERIC_FIELD_TYPES = new Set(['i32c', 'dc']);

/**
 * True when `node` is the gc that wraps a cuegroup. Discriminator: the gc's
 * `mappingHint` is `'CueGroup'` (the marker BC emits in the lf wire format
 * for the AL `cuegroup` keyword). Falls back to a `DesignName` ending in
 * "CueGroup" for envs where the mapping hint is absent.
 */
export function isCueGroupNode(node: FormNode): node is GroupNode {
  if (!isGroupNode(node)) return false;
  const hint = node.properties.mappingHint;
  if (hint === 'CueGroup') return true;
  const design = node.properties.designName;
  if (design && /CueGroup$/i.test(design)) return true;
  return false;
}

/**
 * True when `field` is a numeric field child of a cuegroup gc with a
 * drill-down action attached. Caller must already have verified that the
 * parent is a cuegroup (via isCueGroupNode); this function only checks the
 * field-level shape.
 */
export function isCueFieldNode(field: FieldNode): boolean {
  if (!NUMERIC_FIELD_TYPES.has(field.type)) return false;
  return !!field.hasLookup;
}

/**
 * Returns the controlPath that `bc_execute_action` should target to drill
 * down on this cue. Today this is the field's own controlPath; SystemAction
 * 120 (DrillDown) on the field invokes its DefaultAction, which BC resolves
 * via decompiled InvokeActionInteraction.GetContextActionToExecute.
 */
export function cueDrillDownPath(field: FieldNode): string {
  return field.controlPath;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/protocol/cue-detection.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/cue-detection.ts tests/protocol/cue-detection.test.ts
git commit -m "feat: cue-detection helpers (isCueGroupNode/isCueFieldNode/cueDrillDownPath)"
```

---

## Task 4: cues(root) memoised view

**Files:**
- Modify: `src/protocol/form-views.ts`
- Modify: `tests/protocol/form-views.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/protocol/form-views.test.ts`:

```typescript
import { cues, type CueView } from '../../src/protocol/form-views.js';

describe('cues view', () => {
  it('collects cues across all cuegroups in the tree', () => {
    const tree = buildFormTree({
      t: 'lf', ServerId: 'rc', PageType: 2,
      Children: [
        {
          t: 'gc', MappingHint: 'CueGroup', DesignName: 'DocumentQueue',
          Children: [
            { t: 'i32c', Caption: 'Failed', StringValue: '3', LookupAction: { ControlPath: 'a' } },
            { t: 'i32c', Caption: 'Pending', StringValue: '12', LookupAction: { ControlPath: 'b' } },
          ],
        },
        {
          t: 'gc', MappingHint: 'CueGroup', DesignName: 'PrintQueue',
          Children: [
            { t: 'i32c', Caption: 'Printed', StringValue: '99', LookupAction: { ControlPath: 'c' } },
          ],
        },
        {
          t: 'gc', MappingHint: 'NotACue',
          Children: [{ t: 'sc', Caption: 'Note', StringValue: 'hi' }],
        },
      ],
    });

    const result: readonly CueView[] = cues(tree);
    expect(result.map(c => c.caption)).toEqual(['Failed', 'Pending', 'Printed']);
    expect(result[0].value).toBe('3');
    expect(result[0].groupCaption).toBeDefined();
  });

  it('returns identical reference on repeated calls (memoisation)', () => {
    const tree = buildFormTree({
      t: 'lf', ServerId: 'rc', PageType: 2,
      Children: [{
        t: 'gc', MappingHint: 'CueGroup',
        Children: [{ t: 'i32c', Caption: 'X', StringValue: '1', LookupAction: { ControlPath: 'a' } }],
      }],
    });
    expect(cues(tree)).toBe(cues(tree));
  });

  it('returns [] for a tree with no cuegroups', () => {
    const tree = buildFormTree({ t: 'lf', ServerId: 'x', PageType: 0, Children: [] });
    expect(cues(tree)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/protocol/form-views.test.ts -t cues`
Expected: FAIL — `cues is not a function`.

- [ ] **Step 3: Add the view**

Append to `src/protocol/form-views.ts`:

```typescript
import { isCueGroupNode, isCueFieldNode } from './cue-detection.js';

export interface CueView {
  /** Caption of the parent cuegroup gc. May be empty. */
  readonly groupCaption: string;
  /** controlPath of the parent cuegroup gc. */
  readonly groupControlPath: string;
  /** Caption of the cue field — used as the discriminator in MCP DTOs. */
  readonly caption: string;
  /** controlPath of the cue field; pass to InvokeAction(DrillDown=120). */
  readonly controlPath: string;
  /** Display value (the count). */
  readonly value: string;
  /** Wire-level field type (e.g. 'i32c'). */
  readonly type: string;
}

const cuesCache = new WeakMap<FormNode, CueView[]>();

export function cues(root: FormNode): readonly CueView[] {
  const cached = cuesCache.get(root);
  if (cached) return cached;
  const result: CueView[] = [];
  for (const node of walkTree(root)) {
    if (!isCueGroupNode(node)) continue;
    for (const child of node.children) {
      if (!isFieldNode(child)) continue;
      if (!isCueFieldNode(child)) continue;
      result.push({
        groupCaption: node.properties.caption ?? '',
        groupControlPath: node.controlPath,
        caption: child.properties.caption ?? '',
        controlPath: child.controlPath,
        value: child.properties.stringValue ?? '',
        type: child.type,
      });
    }
  }
  cuesCache.set(root, result);
  return result;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/protocol/form-views.test.ts`
Expected: PASS, all tests including the new cues describe.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/form-views.ts tests/protocol/form-views.test.ts
git commit -m "feat: cues(root) view collects cuegroup tile fields"
```

---

## Task 5: Section.cues in DTO

**Files:**
- Modify: `src/protocol/section-dto.ts`
- Modify: `tests/protocol/section-dto.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/protocol/section-dto.test.ts`:

```typescript
describe('buildSection cues projection', () => {
  it('subpage section with cuegroup gc populates cues[]', () => {
    const childTree = {
      t: 'lf', ServerId: 'cardPart', PageType: 3, Caption: 'Document Output Queues',
      Children: [{
        t: 'gc', MappingHint: 'CueGroup', DesignName: 'DocumentQueueCueGroup',
        Children: [
          { t: 'i32c', Caption: 'Failed', StringValue: '3', LookupAction: { ControlPath: 'x' } },
          { t: 'i32c', Caption: 'Pending', StringValue: '12', LookupAction: { ControlPath: 'y' } },
        ],
      }],
    };
    const childForm = makeFormState('cardPart', childTree);
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([
        ['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 2, Children: [] })],
        ['cardPart', childForm],
      ]),
      sections: new Map<string, SectionDescriptor>([
        ['header', { sectionId: 'header', kind: 'header', caption: 'Role Center', formId: 'root', valid: true }],
        ['subpage:Document Output Queues', {
          sectionId: 'subpage:Document Output Queues', kind: 'subpage',
          caption: 'Document Output Queues', formId: 'cardPart', valid: true,
        }],
      ]),
    });
    const section = buildSection(ctx, 'subpage:Document Output Queues');
    expect(section).not.toBeNull();
    expect(section!.cues).toBeDefined();
    expect(section!.cues).toHaveLength(2);
    expect(section!.cues![0]).toMatchObject({ name: 'Failed', value: '3' });
  });

  it('header section without cuegroup omits cues', () => {
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 0, Children: [{ t: 'sc', Caption: 'Name', StringValue: 'X', Visible: true }] })]]),
      sections: new Map([['header', { sectionId: 'header', kind: 'header', caption: 'X', formId: 'root', valid: true }]]),
    });
    const section = buildSection(ctx, 'header');
    expect(section!.cues).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/protocol/section-dto.test.ts -t cues`
Expected: FAIL — `section.cues` is undefined or missing.

- [ ] **Step 3: Extend the DTO and the adapter**

In `src/protocol/section-dto.ts`:

Add the new types near the existing `SectionField`:

```typescript
export interface SectionCue {
  /** Cue caption — used as the cue's identifier for bc_execute_action. */
  readonly name: string;
  readonly value: string;
  /** Group caption (e.g. "Document Queue"). Helps the LLM frame the cue. */
  readonly groupCaption?: string;
  /** Wire-level field type (i32c, dc). */
  readonly type: string;
  /** controlPath of the cue field. Internal — do not surface to MCP unless debugging. */
  readonly controlPath: string;
}
```

Update the `Section` interface:

```typescript
export interface Section {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  readonly fields?: readonly SectionField[];
  readonly rows?: readonly SectionRow[];
  readonly totalRowCount?: number | null;
  readonly actions?: readonly SectionAction[];
  /** Populated when the section's form contains cuegroup gc nodes. */
  readonly cues?: readonly SectionCue[];
}
```

In `buildSection`, after the fields/rows assignment and before returning, add:

```typescript
import { cues as treeCues } from './form-views.js';
// ...
  const cueList = treeCues(root);
  if (cueList.length > 0) {
    out.cues = cueList.map(c => ({
      name: c.caption,
      value: c.value,
      ...(c.groupCaption ? { groupCaption: c.groupCaption } : {}),
      type: c.type,
      controlPath: c.controlPath,
    }));
  }
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/protocol/section-dto.test.ts`
Expected: PASS for all describe blocks.

- [ ] **Step 5: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/protocol/section-dto.ts tests/protocol/section-dto.test.ts
git commit -m "feat: Section.cues populated from cuegroup tree view"
```

---

## Task 6: Standalone-CardPart-stub detection

**Files:**
- Modify: `src/operations/open-page.ts`
- Modify: `src/core/errors.ts`
- Create: `tests/unit/open-page-cardpart-stub.test.ts`

- [ ] **Step 1: Add the structured error class**

Append to `src/core/errors.ts`:

```typescript
/**
 * Returned by bc_open_page when the requested page is a CardPart that BC
 * delivers as a server stub (placeholder field, no children) when opened
 * standalone. The caller should reach the part through its host form
 * (Role Center, FactBox, or the page that embeds it).
 */
export class CardPartStubError extends ProtocolError {
  constructor(message: string, context: { pageId: string; hostHint: string }) {
    super(message, context);
    this.name = 'CardPartStubError';
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/open-page-cardpart-stub.test.ts`:

```typescript
// tests/unit/open-page-cardpart-stub.test.ts
import { describe, it, expect } from 'vitest';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { ok } from '../../src/core/result.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';

describe('OpenPageOperation CardPart-stub detection', () => {
  it('returns CardPartStubError when pageType is CardPart and only a placeholder field is present', async () => {
    // Arrange: a fake PageService that returns a CardPart stub context
    const stubCtx: any = {
      pageContextId: 'pc:1',
      pageType: 'CardPart',
      caption: 'Document Output',
      isModal: false,
      sections: new Map([['header', {
        sectionId: 'header', kind: 'header', caption: 'Document Output',
        formId: 'root', valid: true,
      }]]),
      forms: new Map([['root', {
        formId: 'root',
        root: buildFormTree({
          t: 'lf', ServerId: 'root', PageType: 3, Caption: 'Document Output',
          // Only a placeholder field
          Children: [],
        }),
        rows: new Map(),
      }]]),
      dialogs: [],
      ownedFormIds: ['root'],
      wizardState: null,
      rootFormId: 'root',
    };
    const fakePageService: any = { openPage: async () => ok(stubCtx) };
    const op = new OpenPageOperation(fakePageService);

    const result = await op.execute({ pageId: '6175308' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('CardPartStubError');
      expect(result.error.message).toMatch(/CardPart/);
    }
  });

  it('returns success for a non-CardPart page even if fields are empty', async () => {
    const ctx: any = {
      pageContextId: 'pc:1',
      pageType: 'Card',
      caption: 'Customer',
      isModal: false,
      sections: new Map([['header', {
        sectionId: 'header', kind: 'header', caption: 'Customer',
        formId: 'root', valid: true,
      }]]),
      forms: new Map([['root', {
        formId: 'root',
        root: buildFormTree({ t: 'lf', ServerId: 'root', PageType: 0, Caption: 'Customer', Children: [] }),
        rows: new Map(),
      }]]),
      dialogs: [],
      ownedFormIds: ['root'],
      wizardState: null,
      rootFormId: 'root',
    };
    const fakePageService: any = { openPage: async () => ok(ctx) };
    const op = new OpenPageOperation(fakePageService);

    const result = await op.execute({ pageId: '21' });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `npx vitest run tests/unit/open-page-cardpart-stub.test.ts`
Expected: FAIL — operation returns ok for the stub instead of CardPartStubError.

- [ ] **Step 4: Add detection in OpenPageOperation**

In `src/operations/open-page.ts`, replace the body of `execute` with:

```typescript
import { mapResult, type Result, isOk, err } from '../core/result.js';
import { CardPartStubError, type ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { buildAllSections } from '../protocol/section-dto.js';
import type { Section } from '../protocol/section-dto.js';
import { fields as treeFields } from '../protocol/form-views.js';

export interface OpenPageInput {
  pageId: string;
  bookmark?: string;
  tenantId?: string;
}

export interface OpenPageOutput {
  pageContextId: string;
  pageType: string;
  caption: string;
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
    if (!isOk(result)) return result;

    const ctx = result.value;
    if (ctx.pageType === 'CardPart') {
      const rootForm = ctx.forms.get(ctx.rootFormId);
      const captioned = rootForm ? treeFields(rootForm.root).filter(f => f.properties.caption) : [];
      if (captioned.length === 0) {
        return err(new CardPartStubError(
          `Page ${input.pageId} is a CardPart and BC returned a placeholder shell. CardParts are server stubs unless reached through a host page (Role Center or another page that embeds them). Open the host page instead.`,
          { pageId: input.pageId, hostHint: 'Open the Role Center or host page that embeds this CardPart, then read the corresponding subpage section from its sections[] array.' },
        ));
      }
    }

    return mapResult(result, (c) => ({
      pageContextId: c.pageContextId,
      pageType: c.pageType,
      caption: c.caption || c.rootFormId,
      isModal: c.isModal,
      sections: buildAllSections(c),
    }));
  }
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `npx vitest run tests/unit/open-page-cardpart-stub.test.ts`
Expected: PASS, both cases.

- [ ] **Step 6: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/operations/open-page.ts src/core/errors.ts tests/unit/open-page-cardpart-stub.test.ts
git commit -m "feat: detect CardPart stub responses with structured error"
```

---

## Task 7: Auto-load Role Center hosted CardParts

**Files:**
- Modify: `src/services/page-service.ts`

- [ ] **Step 1: Update DEFAULT_AUTO_LOAD_SECTIONS**

In `src/services/page-service.ts`, the constant already includes `subpage`. Verify lines 62-63 read:

```typescript
export const DEFAULT_AUTO_LOAD_SECTIONS: readonly SectionKind[] = ['header', 'lines', 'subpage', 'factbox'];
```

If `subpage` is missing, add it. Otherwise this step is a no-op.

- [ ] **Step 2: Treat Role Center hosted CardParts the same as factboxes for LoadForm/openForm**

In the `discoverAndLoadChildForms` loop (lines ~182-230), the current logic sends `LoadForm { openForm: true }` only when `section.kind === 'factbox'`. Extend this to also apply when the parent page is a Role Center AND the child is a `subpage`:

Locate:

```typescript
      const isFactbox = section.kind === 'factbox';
      const loadInteraction: LoadFormInteraction = {
        type: 'LoadForm',
        formId: childFormId,
        loadData: true,
        delayed: false,
        openForm: isFactbox,
      };
```

Replace with:

```typescript
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
```

- [ ] **Step 3: Trigger the cue refresh on Role Centers via SetCurrentRow on root**

A Role Center has no repeater on the root form, so `triggerFactboxRefresh` (which selects a row to populate factboxes) is a no-op. But cuegroup values are server-computed and arrive via `PropertyChanged` events on the CardPart form, triggered by the LoadForm itself. Confirm by inspecting the captured trace: cue StringValues should be present in the FormCreated payload OR follow as `PropertyChanged` after `LoadForm`. If they require an explicit refresh, append a Refresh InvokeAction on each Role-Center subpage after LoadForm:

In the same loop, after the LoadForm result is applied, add:

```typescript
      if (isRoleCenterChild) {
        // Cue values may not arrive in FormCreated; force refresh of the
        // hosted CardPart so its computed StringValues land via PropertyChanged.
        const refreshInteraction: InvokeActionInteraction = {
          type: 'InvokeAction',
          formId: childFormId,
          controlPath: 'server:',
          systemAction: 30, // Refresh
        };
        const refreshResult = await this.session.invoke(
          refreshInteraction,
          (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
        );
        if (isOk(refreshResult)) {
          this.repo.applyToPage(pageContextId, refreshResult.value);
        }
      }
```

- [ ] **Step 4: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/page-service.ts
git commit -m "feat: auto-load Role Center hosted CardParts with refresh"
```

---

## Task 8: bc_execute_action with cue input

**Files:**
- Modify: `src/services/action-service.ts`
- Modify: `src/operations/execute-action.ts`
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/tool-registry.ts`
- Create: `tests/unit/execute-action-cue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/execute-action-cue.test.ts`:

```typescript
// tests/unit/execute-action-cue.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ActionService } from '../../src/services/action-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { FormProjection } from '../../src/protocol/form-state.js';
import { SectionResolver } from '../../src/protocol/section-resolver.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';

describe('ActionService.executeOnCue', () => {
  it('sends DrillDown=120 against the cue field controlPath', async () => {
    const repo = new PageContextRepository(new FormProjection(), new SectionResolver());
    const childTree = {
      t: 'lf', ServerId: 'cp', PageType: 3, Caption: 'Document Output Queues',
      Children: [{
        t: 'gc', MappingHint: 'CueGroup', DesignName: 'DocumentQueueCueGroup',
        Children: [
          { t: 'i32c', Caption: 'Failed', StringValue: '3', LookupAction: { ControlPath: 'a' } },
        ],
      }],
    };
    repo.create('pc:1', 'root', { isModal: false, wizardState: null });
    repo.applyRootControlTree('pc:1', { t: 'lf', ServerId: 'root', PageType: 2, Children: [] });
    repo.registerDiscoveredChildForm('pc:1', {
      serverId: 'cp', caption: 'Document Output Queues',
      controlTree: childTree, isSubForm: false, isPart: true,
    });

    const sentInteractions: any[] = [];
    const session: any = {
      invoke: vi.fn(async (interaction: any) => {
        sentInteractions.push(interaction);
        return { ok: true, value: [] };
      }),
    };
    const logger: any = { info() {}, debug() {}, warn() {}, error() {} };

    const svc = new ActionService(session, repo, logger);
    const result = await svc.executeOnCue('pc:1', 'subpage:Document Output Queues', 'Failed');
    expect(result.ok).toBe(true);
    expect(sentInteractions).toHaveLength(1);
    expect(sentInteractions[0].systemAction).toBe(120);
    expect(sentInteractions[0].formId).toBe('cp');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/execute-action-cue.test.ts`
Expected: FAIL — `executeOnCue is not a function`.

- [ ] **Step 3: Add executeOnCue to ActionService**

In `src/services/action-service.ts`, add the method:

```typescript
import { cues as treeCues } from '../protocol/form-views.js';

  /**
   * Drill down on a cuegroup tile by its caption within the given section.
   * Sends `InvokeAction { systemAction: 120 (DrillDown) }` against the cue
   * field's controlPath. The DrillDown returns a new FormCreated event for
   * the target list.
   */
  async executeOnCue(
    pageContextId: string,
    sectionId: string,
    cueName: string,
  ): Promise<Result<{ events: BCEvent[] }, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const section = ctx.sections.get(sectionId);
    if (!section || !section.valid) {
      return err(new ProtocolError(`Section '${sectionId}' not found.`, {
        availableSections: Array.from(ctx.sections.keys()),
      }));
    }
    const form = ctx.forms.get(section.formId);
    if (!form) return err(new ProtocolError(`Form for section '${sectionId}' not loaded.`));

    const want = cueName.toLowerCase();
    const cue = treeCues(form.root).find(c => c.caption.toLowerCase() === want);
    if (!cue) {
      return err(new ProtocolError(`Cue '${cueName}' not found in section '${sectionId}'.`, {
        availableCues: treeCues(form.root).map(c => c.caption),
      }));
    }

    const interaction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: section.formId,
      controlPath: cue.controlPath,
      systemAction: 120, // DrillDown
    };
    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'FormCreated',
    );
    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);
    return ok({ events: result.value });
  }
```

(Add the import for `InvokeActionInteraction`/`BCEvent`/result helpers if not already present at the top of the file.)

- [ ] **Step 4: Wire into ExecuteActionOperation**

In `src/operations/execute-action.ts`, extend `ExecuteActionInput` with an optional `cue: string`:

```typescript
export interface ExecuteActionInput {
  pageContextId: string;
  action?: string;
  cue?: string;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
}
```

In the operation `execute`, add a branch before the existing action lookup:

```typescript
    if (input.cue) {
      if (!input.section) {
        return err(new ProtocolError('cue requires a section (e.g. "subpage:Document Output Queues")'));
      }
      const result = await this.actionService.executeOnCue(input.pageContextId, input.section, input.cue);
      if (!isOk(result)) return result;
      // Cue drill-down opens a new page; surface as an action result with the
      // new pageContextId if the response included a FormCreated.
      const newPageEvent = result.value.events.find(e => e.type === 'FormCreated' && !e['parentFormId']);
      // ...existing reply shape, populating targetPageContextId from newPageEvent.formId if present
      return ok({ /* shape per existing operation */ });
    }
```

(Adapt the reply construction to match the existing ExecuteActionOutput shape — read the current file before writing.)

- [ ] **Step 5: Update the schema and tool description**

In `src/mcp/schemas.ts`:

```typescript
export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  action: z.string().min(1).optional().describe('Action caption name to execute (case-insensitive). Use action OR cue, not both.'),
  cue: z.string().min(1).optional().describe('Cue tile name to drill down on (e.g. "Failed", "Pending"). Use with section pointing at the subpage that owns the cuegroup. Use action OR cue, not both.'),
  section: z.string().optional().describe('Section context. Required when using cue; optional for action. Examples: "lines", "subpage:Document Output Queues".'),
  rowIndex: z.number().optional().describe('0-based row position for row-scoped actions.'),
  bookmark: z.string().optional().describe('Stable row identifier for row-scoped actions.'),
}).refine(d => !!d.action !== !!d.cue, { message: 'Provide exactly one of: action, cue' });
```

In `src/mcp/tool-registry.ts`, refresh the `bc_execute_action` description to mention cue drill-down:

```typescript
      description: `Executes either a named action OR a cue-tile drill-down on an open page. Pass `action` for header / line / system actions (Post, Delete, New). Pass `cue` for Role Center cue tiles — drills into the underlying list (e.g. "Failed" tile opens the Failed Document Queue list). Requires a pageContextId from bc_open_page.

For cue drill-down, also pass `section` pointing at the subpage that owns the cuegroup (e.g. section: "subpage:Document Output Queues", cue: "Failed"). The returned targetPageContextId points at the newly-opened list page.

Otherwise behaves identically to the existing action flow: validates the action is enabled, sends the InvokeAction RPC, applies the resulting events, and returns changedSections / dialogsOpened.

Examples:
- Drill into a cue tile: { pageContextId: "rc1", section: "subpage:Document Output Queues", cue: "Failed" }
- Post a sales order: { pageContextId: "so1", action: "Post" }
- Delete a row: { pageContextId: "list1", action: "Delete", bookmark: "..." }`,
```

- [ ] **Step 6: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS, including the new cue test.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/services/action-service.ts src/operations/execute-action.ts src/mcp/schemas.ts src/mcp/tool-registry.ts tests/unit/execute-action-cue.test.ts
git commit -m "feat: bc_execute_action accepts cue drill-down input"
```

---

## Task 9: Live integration — Role Center cues

**Files:**
- Create: `tests/integration/role-center.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/role-center.test.ts`:

```typescript
// tests/integration/role-center.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestSession } from './helpers/session.js';

describe('Role Center cues', () => {
  let session: Awaited<ReturnType<typeof createTestSession>>;

  beforeAll(async () => {
    session = await createTestSession();
  });

  afterAll(async () => {
    await session.close();
  });

  it('Order Processor Role Center (9022) returns cue tiles via subpage sections', async () => {
    const result = await session.openPage(9022);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const subpages = result.value.sections.filter(s => s.kind === 'subpage');
    const withCues = subpages.filter(s => (s.cues?.length ?? 0) > 0);
    expect(withCues.length, 'no Role Center subpage carried cues').toBeGreaterThan(0);
    for (const sp of withCues) {
      for (const cue of sp.cues!) {
        expect(cue.name).toBeTruthy();
        // value may be "0" but should be a string
        expect(typeof cue.value).toBe('string');
      }
    }
  }, 60000);

  it('returns CardPartStubError for a CardPart opened standalone', async () => {
    const result = await session.openPage(9152); // pick any known CardPart in the env
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('CardPartStubError');
    }
  }, 30000);
});
```

- [ ] **Step 2: Pick the right page IDs for the test env**

Replace `9022` with a Role Center page known to host cue tiles in the target BC env. Replace `9152` with a known CardPart id. Confirm via the BC web client.

- [ ] **Step 3: Run the integration test**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/role-center.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the full integration sweep**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: all pass; no regression.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/role-center.test.ts
git commit -m "test: live Role Center + CardPartStubError integration"
```

---

## Task 10: Documentation

**Files:**
- Modify: `limits.md`
- Modify: `CLAUDE.md` (add a "Cuegroup wire format" note in the Protocol Patterns section)

- [ ] **Step 1: Replace limits.md #1 with a resolved-status block**

Update `limits.md` section "## 1. `cuegroup` Card pages return placeholder field only" with:

```markdown
**Status (resolved 2026-04-XX)**

bc-mcp now models cuegroups as a section-level `cues[]` projection. Open the
host Role Center via `bc_open_page`; each hosted CardPart appears as a
`subpage` section, and any cuegroup gc within it surfaces as
`section.cues[]`. Drill down with
`bc_execute_action { section: "subpage:<caption>", cue: "<name>" }`.

Standalone CardPart opens (e.g. page 6175308 directly) now return
`CardPartStubError` with a structured `hostHint`, telling the caller to open
the host page instead.

References:
- `src/protocol/cue-detection.ts` — discriminator
- `src/protocol/form-views.ts` — `cues(root)` view
- `src/protocol/section-dto.ts` — `Section.cues`
- `src/services/action-service.ts` — `executeOnCue`
- `src/operations/open-page.ts` — `CardPartStubError` emission
```

- [ ] **Step 2: Add a Cuegroup section to CLAUDE.md**

Append to the `## BC Protocol Patterns (Verified from Decompiled Source)` section in `CLAUDE.md`:

```markdown
### Cuegroups (Role-Center cue tiles)

Cuegroups are AL `cuegroup` containers that compile to a `gc` GroupControl
whose children are numeric "cue" fields. Discriminator: `MappingHint = 'CueGroup'`
on the gc, with fallback to `DesignName` matching `/CueGroup$/i`. Each cue
field has a drill-down action; bc-mcp surfaces drill-down via
`bc_execute_action { cue, section }`.

CardParts (PageType=CardPart) opened standalone return a placeholder shell
because BC's web server delivers them as stubs unless reached through a host
page. bc-mcp returns `CardPartStubError` in that case.

Reference: `src/protocol/captures/cuegroup-rolecenter-2026-04-28.json` for
the wire fixture; `src/protocol/cue-detection.ts` for the discriminator.
```

- [ ] **Step 3: Commit**

```bash
git add limits.md CLAUDE.md
git commit -m "docs: limits.md #1 fixed via Role Center + cues model"
```

---

## Self-review checklist

- [ ] Spec coverage:
  - "single placeholder field, no actions" → CardPartStubError path (Task 6)
  - cue tile values surfaced → Section.cues populated via `cues(root)` view (Tasks 4–5)
  - cue drill-down → executeOnCue + bc_execute_action `cue` input (Task 8)
  - Role Center first-class → DEFAULT_AUTO_LOAD_SECTIONS includes subpage; LoadForm openForm extended for Role Center children (Task 7)
- [ ] No placeholders, no "TBD"
- [ ] Type names consistent (`CueView`, `SectionCue`, `executeOnCue`) used identically across files
- [ ] Wire-fixture path matches the date in the filename
- [ ] Each task ends with a commit
- [ ] Tests precede implementation in every behaviour-introducing task
