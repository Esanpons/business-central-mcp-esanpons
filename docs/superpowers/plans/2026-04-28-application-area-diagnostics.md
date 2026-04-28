# ApplicationArea Diagnostics Plan (limits.md #3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address limits.md #3 — page-extension fields gated by `ApplicationArea` are filtered server-side and arrive missing from `bc_open_page`. Per the decompiled `Microsoft.Dynamics.Nav.Ncl/NavSession.cs`, `session.ApplicationAreas` is set by AL (typically by app-activation wizards writing `ApplicationAreaSetup`); BC has no client-side wire-level override exposed to external clients. The honest fix is therefore diagnostic and configurational, not a parser hack: (a) introspect the active session's areas via the existing `INavService.GetApplicationAreas` RPC; (b) provide a helper to programmatically toggle entries on the `Application Area Setup` page (9178); (c) loud documentation of the gating model.

**Architecture:** A new `SessionInfoService` exposes `getApplicationAreas()` over the existing BCSession. A new `bc_get_application_areas` MCP tool wraps it. A new `bc_set_application_area` operation opens page 9178, writes the requested booleans, and re-applies. The BC server then re-emits page metadata under the new application areas on subsequent `bc_open_page` calls, so the missing fields appear without any further client action.

**Tech Stack:** TypeScript (ESM, strict), Vitest. No new dependencies.

**Pre-flight:** Independent of other plans. Best executed after `section-first-class` lands so that the page-9178 helper produces the same MCP shape used by everything else.

---

## File Structure

### New files
- `src/services/session-info-service.ts` — `getApplicationAreas()`, future home for similar BC introspection RPCs
- `src/operations/get-application-areas.ts`
- `src/operations/set-application-area.ts`
- `tests/unit/get-application-areas.test.ts`
- `tests/unit/set-application-area.test.ts`
- `tests/integration/application-area.test.ts`

### Modified files
- `src/protocol/types.ts` — add a `SessionActionInteraction` variant for `GetApplicationAreas` if not already representable, OR add a generic helper that calls the existing BC RPC
- `src/protocol/interaction-encoder.ts` — encode the GetApplicationAreas RPC (the decompiled `INavService.GetApplicationAreas()` returns a comma-separated string)
- `src/mcp/schemas.ts` — add `GetApplicationAreasSchema`, `SetApplicationAreaSchema`
- `src/mcp/tool-registry.ts` — register the two new tools
- `src/server.ts` — wire the new operations
- `src/stdio-server.ts` — wire the new operations
- `src/api/routes.ts` — expose HTTP endpoints if other tools have them
- `limits.md` — update #3 with the new tools and their usage
- `CLAUDE.md` — document the ApplicationArea gating model and the new tools

---

## Conventions for every task

- Use `npx vitest run <path>` for narrow runs, `npx vitest run tests/unit tests/protocol` for the unit/protocol sweep
- After each task: typecheck (`npx tsc --noEmit`), narrow test (must pass), full sweep (must pass)
- Integration tests only at Task 7
- ESM imports include `.js` extension
- Commit messages: `feat:` for new tools, `refactor:` for shape moves, `docs:` for documentation

---

## Task 1: Encode GetApplicationAreas RPC

**Files:**
- Modify: `src/protocol/interaction-encoder.ts`
- Modify: `tests/protocol/interaction-encoder.test.ts`

- [ ] **Step 1: Verify the wire format**

Decompile reference: `reference/bc28/decompiled/Microsoft.Dynamics.Nav.Service/Microsoft.Dynamics.Nav.Service/NSService.cs:591` shows:

```csharp
public string GetApplicationAreas() {
  return base.Session.ApplicationAreas;
}
```

`INavService.GetApplicationAreas()` is a no-argument RPC returning a comma-separated string. The wire method name is verifiable via the JSON-RPC trace: open a debug session and call any tool, then look for `IService.GetApplicationAreas` or similar in the protocol log. Confirm the exact method string before writing the encoder.

Document the verified method string at the top of the encoder change:

```typescript
// GetApplicationAreas RPC: no params, returns string. Wire method name:
// "<verified-string-from-protocol-log>". Reference: decompiled
// Microsoft.Dynamics.Nav.Service/NSService.cs:591.
```

- [ ] **Step 2: Write the failing encoder test**

Append to `tests/protocol/interaction-encoder.test.ts`:

```typescript
describe('encodeGetApplicationAreas', () => {
  it('produces a no-argument RPC call against the verified method name', () => {
    const encoder = new InteractionEncoder('27.0.0.0', 27);
    const out = encoder.encodeGetApplicationAreas({
      callbackId: 'cb1',
      sequenceNo: 1,
      lastClientAckSequenceNumber: 0,
      openFormIds: new Set(),
      session: { sessionId: 'S', sessionKey: 'K', company: 'C', tenantId: 'default', spaInstanceId: 'X' },
    });
    expect(out.method).toBe('Invoke'); // adjust to the verified method
    // params shape: a single Invoke wrapper around GetApplicationAreas — adjust per Step 1
    expect(Array.isArray(out.params)).toBe(true);
  });
});
```

(Update both the method name and the params shape after Step 1 verifies them.)

- [ ] **Step 3: Run, expect failure**

Run: `npx vitest run tests/protocol/interaction-encoder.test.ts -t encodeGetApplicationAreas`
Expected: FAIL.

- [ ] **Step 4: Implement `encodeGetApplicationAreas`**

In `src/protocol/interaction-encoder.ts`, add:

```typescript
  /**
   * Encode an Invoke that calls `INavService.GetApplicationAreas`. Returns
   * a comma-separated string of area names (e.g. "#All" or "#All,Basic,Suite").
   * Reference: decompiled Microsoft.Dynamics.Nav.Service/NSService.cs:591.
   */
  encodeGetApplicationAreas(context: EncodeContext): { method: string; params: unknown[] } {
    // Construct the same wrapper used by other Invoke RPCs, with method name
    // GetApplicationAreas and an empty parameter set. Field names and ordering
    // copied from the wire trace verified in Task 1 Step 1.
    const params = [{
      // ... shape follows the existing Invoke encoding in this file ...
      // Read the file to mirror the existing Invoke wrapper exactly.
    }];
    return { method: 'Invoke', params };
  }
```

(Read `interaction-encoder.ts` first; mirror the structure of the existing Invoke encoders for parameter consistency. The session header fields, sequence numbers, and openFormIds are shared with every other Invoke.)

- [ ] **Step 5: Run tests, expect pass**

Run: `npx vitest run tests/protocol/interaction-encoder.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/protocol/interaction-encoder.ts tests/protocol/interaction-encoder.test.ts
git commit -m "feat: encode GetApplicationAreas RPC"
```

---

## Task 2: SessionInfoService

**Files:**
- Create: `src/services/session-info-service.ts`
- Create: `tests/unit/session-info-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/session-info-service.test.ts`:

```typescript
// tests/unit/session-info-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SessionInfoService } from '../../src/services/session-info-service.js';
import { ok } from '../../src/core/result.js';

describe('SessionInfoService.getApplicationAreas', () => {
  it('parses BC response into an ordered array of areas', async () => {
    const session: any = {
      // sendRpc is the BCWebSocket-level send — but SessionInfoService should call BCSession.invoke
      // For the test we stub BCSession.invoke directly to return a synthetic CallbackResponseProperties result
      invoke: vi.fn(async () => ok([{
        type: 'InvokeCompleted',
        sequenceNumber: 1,
        completedInteractions: [{ invocationId: 'cb1', durationMs: 0, result: '#All,Basic,Suite' }],
      }])),
    };
    const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
    const svc = new SessionInfoService(session, logger);
    const result = await svc.getApplicationAreas();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['#All', 'Basic', 'Suite']);
    }
  });

  it('handles empty result as ["#All"]', async () => {
    const session: any = {
      invoke: vi.fn(async () => ok([{
        type: 'InvokeCompleted',
        sequenceNumber: 1,
        completedInteractions: [{ invocationId: 'cb1', durationMs: 0, result: '' }],
      }])),
    };
    const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
    const svc = new SessionInfoService(session, logger);
    const result = await svc.getApplicationAreas();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['#All']);
    }
  });

  it('returns the underlying error when invoke fails', async () => {
    const session: any = {
      invoke: vi.fn(async () => ({ ok: false, error: { message: 'boom' } })),
    };
    const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
    const svc = new SessionInfoService(session, logger);
    const result = await svc.getApplicationAreas();
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/session-info-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/services/session-info-service.ts`:

```typescript
// src/services/session-info-service.ts
//
// Read-only BC-session diagnostic queries. Today: GetApplicationAreas.
// Future: more BC introspection RPCs that are session-level rather than
// page-level. Reference: decompiled Microsoft.Dynamics.Nav.Service/NSService.cs.

import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { Logger } from '../core/logger.js';
import type { BCEvent } from '../protocol/types.js';

export class SessionInfoService {
  constructor(
    private readonly session: BCSession,
    private readonly logger: Logger,
  ) {}

  /**
   * Read the active session's ApplicationAreas as an ordered array. BC stores
   * it as a comma-separated string with `#All` always present (see decompiled
   * NavSession.cs:1128). Empty-string responses are normalised to `['#All']`.
   */
  async getApplicationAreas(): Promise<Result<string[], ProtocolError>> {
    const interaction = {
      type: 'GetApplicationAreas' as const,
    };
    const result = await this.session.invoke(
      interaction as any,
      (event: BCEvent) => event.type === 'InvokeCompleted',
    );
    if (isErr(result)) return result;
    const completed = result.value.find(e => e.type === 'InvokeCompleted');
    if (!completed || completed.type !== 'InvokeCompleted') {
      return err(new ProtocolError('GetApplicationAreas: no InvokeCompleted event in response'));
    }
    const ci = completed.completedInteractions[0];
    const raw = (ci?.result as string | undefined) ?? '';
    if (!raw) return ok(['#All']);
    return ok(raw.split(',').map(s => s.trim()).filter(Boolean));
  }
}
```

- [ ] **Step 4: Add `GetApplicationAreasInteraction` to BCInteraction union**

In `src/protocol/types.ts`, add the new interaction type:

```typescript
export interface GetApplicationAreasInteraction {
  readonly type: 'GetApplicationAreas';
}
```

Add it to the `BCInteraction` union (line 73 area):

```typescript
export type BCInteraction =
  | OpenFormInteraction
  | LoadFormInteraction
  | CloseFormInteraction
  | InvokeActionInteraction
  | SaveValueInteraction
  | FilterInteraction
  | SetCurrentRowInteraction
  | ScrollRepeaterInteraction
  | SessionActionInteraction
  | GetApplicationAreasInteraction;
```

- [ ] **Step 5: Route the interaction through the encoder**

In `src/protocol/interaction-encoder.ts`, locate the dispatch table that maps interaction `type` to encoded RPC. Add a case for `'GetApplicationAreas'` calling `encodeGetApplicationAreas` from Task 1.

- [ ] **Step 6: Run tests, expect pass**

Run: `npx vitest run tests/unit/session-info-service.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 7: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/services/session-info-service.ts tests/unit/session-info-service.test.ts src/protocol/types.ts src/protocol/interaction-encoder.ts
git commit -m "feat: SessionInfoService.getApplicationAreas"
```

---

## Task 3: bc_get_application_areas operation

**Files:**
- Create: `src/operations/get-application-areas.ts`
- Create: `tests/unit/get-application-areas.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/get-application-areas.test.ts`:

```typescript
// tests/unit/get-application-areas.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GetApplicationAreasOperation } from '../../src/operations/get-application-areas.js';
import { ok } from '../../src/core/result.js';

describe('GetApplicationAreasOperation', () => {
  it('returns the area list and isAllOnly flag', async () => {
    const svc: any = { getApplicationAreas: vi.fn(async () => ok(['#All', 'Basic', 'Suite'])) };
    const op = new GetApplicationAreasOperation(svc);
    const result = await op.execute({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.areas).toEqual(['#All', 'Basic', 'Suite']);
      expect(result.value.isAllOnly).toBe(false);
    }
  });

  it('flags isAllOnly when only #All is returned', async () => {
    const svc: any = { getApplicationAreas: vi.fn(async () => ok(['#All'])) };
    const op = new GetApplicationAreasOperation(svc);
    const result = await op.execute({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isAllOnly).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/get-application-areas.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the operation**

Create `src/operations/get-application-areas.ts`:

```typescript
// src/operations/get-application-areas.ts
import { isOk, ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { SessionInfoService } from '../services/session-info-service.js';

export interface GetApplicationAreasInput {}

export interface GetApplicationAreasOutput {
  /** Ordered list of active areas. `#All` is always present (BC always prepends it). */
  areas: string[];
  /** True when the only active area is `#All`. In this case ApplicationArea-gated fields are NOT filtered (per decompiled NavSession.IsApplicationAreaEnabled). */
  isAllOnly: boolean;
  /** Hint string shown to the LLM to interpret the result. */
  note: string;
}

export class GetApplicationAreasOperation {
  constructor(private readonly sessionInfo: SessionInfoService) {}

  async execute(_input: GetApplicationAreasInput): Promise<Result<GetApplicationAreasOutput, ProtocolError>> {
    const result = await this.sessionInfo.getApplicationAreas();
    if (!isOk(result)) return result;
    const areas = result.value;
    const isAllOnly = areas.length === 1 && areas[0] === '#All';
    return ok({
      areas,
      isAllOnly,
      note: isAllOnly
        ? 'Only #All is active — ApplicationArea-gated fields are NOT filtered. Missing fields are due to other gating (Visible expression, RoleCenter scope, app-activation state).'
        : `Active areas: ${areas.join(', ')}. ApplicationArea-gated fields are filtered unless the field's required area is in this list.`,
    });
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/unit/get-application-areas.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/operations/get-application-areas.ts tests/unit/get-application-areas.test.ts
git commit -m "feat: bc_get_application_areas operation"
```

---

## Task 4: bc_set_application_area operation

**Files:**
- Create: `src/operations/set-application-area.ts`
- Create: `tests/unit/set-application-area.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/set-application-area.test.ts`:

```typescript
// tests/unit/set-application-area.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SetApplicationAreaOperation } from '../../src/operations/set-application-area.js';
import { ok } from '../../src/core/result.js';

describe('SetApplicationAreaOperation', () => {
  it('opens page 9178, writes booleans, closes the page, returns updated areas', async () => {
    const pageService: any = {
      openPage: vi.fn(async () => ok({
        pageContextId: 'aas:1', pageType: 'Card', caption: 'Application Area Setup',
        sections: new Map([['header', { sectionId: 'header', kind: 'header', caption: '', formId: 'root', valid: true }]]),
        forms: new Map(),
        rootFormId: 'root', isModal: false, wizardState: null, dialogs: [], ownedFormIds: ['root'],
      })),
      closePage: vi.fn(async () => ok({ events: [] })),
    };
    const dataService: any = {
      writeFields: vi.fn(async () => ok({ results: [{ fieldName: 'Basic', controlPath: 'x', success: true, newValue: 'Yes' }], events: [] })),
    };
    const sessionInfo: any = {
      getApplicationAreas: vi.fn(async () => ok(['#All', 'Basic'])),
    };
    const op = new SetApplicationAreaOperation(pageService, dataService, sessionInfo);
    const result = await op.execute({ areas: { Basic: true, Suite: false } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.activeAreas).toEqual(['#All', 'Basic']);
    }
    expect(pageService.openPage).toHaveBeenCalledWith('9178', expect.anything());
    expect(dataService.writeFields).toHaveBeenCalled();
    expect(pageService.closePage).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/set-application-area.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the operation**

Create `src/operations/set-application-area.ts`:

```typescript
// src/operations/set-application-area.ts
//
// Programmatically toggles entries on the BC "Application Area Setup" page
// (9178). After the writes, the BC server updates `ApplicationAreaSetup` for
// the active company; subsequent bc_open_page calls receive page metadata
// under the new areas. Reference: limits.md #3 root cause analysis.

import { isOk, isErr, ok, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import type { DataService } from '../services/data-service.js';
import type { SessionInfoService } from '../services/session-info-service.js';

export interface SetApplicationAreaInput {
  /** Map of area name → desired boolean. Area names match Application Area Setup page captions (e.g. "Basic", "Suite", "Manufacturing"). */
  areas: Record<string, boolean>;
}

export interface SetApplicationAreaOutput {
  /** Areas reported active after the write. */
  activeAreas: string[];
  /** Per-area write result. */
  results: Array<{ area: string; success: boolean; error?: string }>;
}

export class SetApplicationAreaOperation {
  constructor(
    private readonly pageService: PageService,
    private readonly dataService: DataService,
    private readonly sessionInfo: SessionInfoService,
  ) {}

  async execute(input: SetApplicationAreaInput): Promise<Result<SetApplicationAreaOutput, ProtocolError>> {
    const opened = await this.pageService.openPage('9178');
    if (!isOk(opened)) return opened;
    const ctxId = opened.value.pageContextId;

    const results: Array<{ area: string; success: boolean; error?: string }> = [];
    for (const [area, want] of Object.entries(input.areas)) {
      const writeResult = await this.dataService.writeFields(ctxId, { [area]: want ? 'Yes' : 'No' });
      if (isErr(writeResult)) {
        results.push({ area, success: false, error: writeResult.error.message });
        continue;
      }
      const fieldResult = writeResult.value.results[0];
      results.push({
        area,
        success: fieldResult?.success ?? false,
        ...(fieldResult?.error ? { error: fieldResult.error } : {}),
      });
    }

    await this.pageService.closePage(ctxId, { discardChanges: false });

    const areasAfter = await this.sessionInfo.getApplicationAreas();
    if (isErr(areasAfter)) return areasAfter;
    return ok({ activeAreas: areasAfter.value, results });
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/unit/set-application-area.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/operations/set-application-area.ts tests/unit/set-application-area.test.ts
git commit -m "feat: bc_set_application_area operation"
```

---

## Task 5: MCP wiring

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/tool-registry.ts`
- Modify: `src/server.ts`
- Modify: `src/stdio-server.ts`

- [ ] **Step 1: Add schemas**

Append to `src/mcp/schemas.ts`:

```typescript
export const GetApplicationAreasSchema = z.object({});

export const SetApplicationAreaSchema = z.object({
  areas: z.record(z.string(), z.boolean()).describe('Map of area name → desired boolean. Area names match the "Application Area Setup" page captions (e.g. "Basic", "Suite", "Manufacturing", "Service").'),
});
```

- [ ] **Step 2: Register the tools**

In `src/mcp/tool-registry.ts`:

Update `Operations` interface:

```typescript
export interface Operations {
  // ...existing fields...
  getApplicationAreas: GetApplicationAreasOperation;
  setApplicationArea: SetApplicationAreaOperation;
}
```

Add imports for the operation classes.

In `buildToolRegistry`, append:

```typescript
    {
      name: 'bc_get_application_areas',
      description: `Returns the active session's ApplicationAreas as a structured list. ApplicationArea is BC's per-session feature gate — fields and pages with `ApplicationArea = X` are filtered server-side unless `X` is in the active areas (or the active set is "#All"-only). Use this when a known field is missing from bc_open_page output to confirm whether ApplicationArea is the cause. Returns { areas, isAllOnly, note }.

Reference: decompiled Microsoft.Dynamics.Nav.Ncl/NavSession.cs ApplicationAreas + IsApplicationAreaEnabled.`,
      inputSchema: toMcpJsonSchema(GetApplicationAreasSchema),
      zodSchema: GetApplicationAreasSchema,
      execute: (input) => ops.getApplicationAreas.execute(input as Parameters<typeof ops.getApplicationAreas.execute>[0]),
    },
    {
      name: 'bc_set_application_area',
      description: `Toggles entries on the BC "Application Area Setup" page (9178) and re-reads the active areas after the write. Use this to enable a vertical app's areas (e.g. "CDOBasic" for Continia Document Output) so subsequent bc_open_page calls receive the previously-filtered fields. The write affects the active company.

Pass areas as a map of area name → boolean (true=enable, false=disable). Returns { activeAreas, results } with per-area write status.

Example: { areas: { Basic: true, Suite: true, Service: false } }.`,
      inputSchema: toMcpJsonSchema(SetApplicationAreaSchema),
      zodSchema: SetApplicationAreaSchema,
      execute: (input) => ops.setApplicationArea.execute(input as Parameters<typeof ops.setApplicationArea.execute>[0]),
    },
```

- [ ] **Step 3: Wire in server.ts and stdio-server.ts**

In `src/server.ts` `buildServices`:

```typescript
    const sessionInfoService = new SessionInfoService(s, logger);
    // ...
    const operations: Operations = {
      // ...existing fields...
      getApplicationAreas: new GetApplicationAreasOperation(sessionInfoService),
      setApplicationArea: new SetApplicationAreaOperation(pageService, dataService, sessionInfoService),
    };
```

Apply the same change in `src/stdio-server.ts`.

- [ ] **Step 4: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/tool-registry.ts src/server.ts src/stdio-server.ts
git commit -m "feat: register bc_get_application_areas and bc_set_application_area tools"
```

---

## Task 6: HTTP API exposure (parity with other tools)

**Files:**
- Modify: `src/api/routes.ts`

- [ ] **Step 1: Mirror the pattern used by existing tools**

Read `src/api/routes.ts` to see how an existing operation (e.g. `bc_search_pages`) is exposed over HTTP. Add the same wrapper for the two new operations.

- [ ] **Step 2: Run unit tests if any cover the routes file**

Run: `npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/api/routes.ts
git commit -m "feat: HTTP routes for application-area tools"
```

---

## Task 7: Live integration

**Files:**
- Create: `tests/integration/application-area.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/application-area.test.ts`:

```typescript
// tests/integration/application-area.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestSession } from './helpers/session.js';

describe('ApplicationArea diagnostics', () => {
  let session: Awaited<ReturnType<typeof createTestSession>>;
  beforeAll(async () => { session = await createTestSession(); });
  afterAll(async () => { await session.close(); });

  it('bc_get_application_areas returns at least #All', async () => {
    const result = await session.getApplicationAreas();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.areas).toContain('#All');
    }
  }, 30000);

  it('bc_set_application_area can flip Suite off and on, observed via the active areas list', async () => {
    const before = await session.getApplicationAreas();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const hadSuite = before.value.areas.includes('Suite');

    // Flip
    const flip = await session.setApplicationArea({ areas: { Suite: !hadSuite } });
    expect(flip.ok).toBe(true);

    const after = await session.getApplicationAreas();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.areas.includes('Suite')).toBe(!hadSuite);
    }

    // Restore
    await session.setApplicationArea({ areas: { Suite: hadSuite } });
  }, 60000);
});
```

(Add `getApplicationAreas` and `setApplicationArea` helpers to `tests/integration/helpers/session.ts` mirroring how `searchPages` is exposed there.)

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/application-area.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full integration sweep**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: all pass; no regression.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/application-area.test.ts tests/integration/helpers/session.ts
git commit -m "test: live application-area integration"
```

---

## Task 8: Documentation

**Files:**
- Modify: `limits.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update limits.md #3**

Replace section "## 3. Page-extension fields gated by `ApplicationArea` are server-filtered" with:

```markdown
**Status (resolved 2026-04-XX, diagnostically)**

ApplicationArea filtering is a server-side gate on `session.ApplicationAreas`
(set by AL — typically by `ApplicationAreaSetup` rows or app-activation
wizards). BC has no client-side wire override. bc-mcp now provides:

- `bc_get_application_areas` — returns the active session's areas plus an
  `isAllOnly` flag. Use this to confirm whether ApplicationArea is responsible
  when a known field is missing from `bc_open_page` output.
- `bc_set_application_area` — toggles entries on the Application Area Setup
  page (9178). Subsequent `bc_open_page` calls receive metadata under the new
  area set, so previously-filtered fields appear without further client action.

For vertical apps (e.g. Continia Document Output's `CDOBasic`) the area is
typically activated by the app's setup wizard rather than the standard setup
page; use `bc_open_page` on the wizard and drive it with `bc_wizard_navigate`.

References:
- `src/services/session-info-service.ts` — `getApplicationAreas`
- `src/operations/set-application-area.ts` — page 9178 driver
- decompiled `Microsoft.Dynamics.Nav.Ncl/NavSession.cs` — `ApplicationAreas`,
  `IsApplicationAreaEnabled`
```

- [ ] **Step 2: Add an ApplicationArea section to CLAUDE.md**

Append to the `## BC Protocol Patterns (Verified from Decompiled Source)` section in `CLAUDE.md`:

```markdown
### ApplicationArea gating

BC filters page metadata server-side based on `session.ApplicationAreas` (a
comma-separated list, set by AL via `ApplicationAreaSetup` rows or app
wizards). The check is `NavSession.IsApplicationAreaEnabled`: returns true
when the session's areas contain the field's declared area, OR when the
session's only area is `#All`. There is no client-side wire-level override.

bc-mcp surfaces this via two diagnostic tools:
- `bc_get_application_areas` reads the active areas
- `bc_set_application_area` writes the Application Area Setup page (9178)

Reference: decompiled `Microsoft.Dynamics.Nav.Ncl/NavSession.cs` lines
~1111-1135 (property setter) and ~3291-3308 (`IsApplicationAreaEnabled`).
```

- [ ] **Step 3: Commit**

```bash
git add limits.md CLAUDE.md
git commit -m "docs: limits.md #3 — ApplicationArea diagnostics tools documented"
```

---

## Self-review checklist

- [ ] Spec coverage:
  - "field absent from bc_open_page response" → diagnosable via `bc_get_application_areas` (Task 3)
  - "Activate any Continia app … to enable" → automatable via `bc_set_application_area` for the standard setup page (Task 4)
  - "Add an env var BC_APPLICATION_AREA" → intentionally NOT done. Decompile shows no client-side wire override exists; an env var would be a non-functional shim. Documented as such.
- [ ] No placeholders, no "TBD"
- [ ] Type names consistent (`SessionInfoService.getApplicationAreas`, `GetApplicationAreasOperation`, `SetApplicationAreaOperation`) used identically across files
- [ ] Each task ends with a commit
- [ ] Tests precede implementation in every behaviour-introducing task
