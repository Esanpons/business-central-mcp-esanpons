# Tell Me Search Extraction & Profile Plumbing Plan (limits.md #5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bc_search_pages` currently extracts only generic strings from Tell Me result rows — `pageId` is always empty, `type` is whatever cell happens to land second. Two fixes: (a) parse the actual cell layout from a live capture so `pageId`, `objectType`, and (where present) the run-target URL come back accurately, and (b) plumb an optional `BC_PROFILE` environment variable through the OpenSession login parameters so callers can target a profile whose Tell Me index includes the searched objects (limits.md #5 root cause: profile-specific result scoping).

**Architecture:** SearchService keeps the existing `InvokeSessionAction { SystemAction: 220 }` flow. The fix is downstream: a new `extractTellMeRow(row)` pure function decodes one DataLoaded row payload into a `{ name, pageId, objectType, runUrl? }` SearchResult based on a captured wire fixture. Profile plumbing flows from `BCConfig.profile` (new optional field) → `InteractionEncoder.encodeOpenSession` → BC's loginParameters payload field name verified against decompiled `LoginParameters.cs`.

**Tech Stack:** TypeScript (ESM, strict), Vitest. No new dependencies.

**Pre-flight:** Independent of other plans. Requires a successful Tell Me search against a known-working BC env (BC27 with default profile) for the wire capture in Task 1.

---

## File Structure

### New files
- `src/protocol/captures/tell-me-result-2026-04-28.json` — frozen DataLoaded payload from a Tell Me search
- `src/services/tell-me-extractor.ts` — pure `extractTellMeRow(row)` and `extractTellMeResults(events)` functions
- `tests/unit/tell-me-extractor.test.ts` — fixture-driven unit tests

### Modified files
- `src/services/search-service.ts` — delegates extraction to the new module; documented behaviour change
- `src/core/config.ts` — `BCConfig.profile?: string` reading `BC_PROFILE`
- `src/protocol/interaction-encoder.ts` — passes `profile` into the OpenSession payload (field name from decompile, see Task 4)
- `src/session/bc-session.ts` — accepts `profile` via constructor and threads to `encoder.encodeOpenSession`
- `src/session/session-factory.ts` — passes the profile from config into BCSession
- `src/operations/search-pages.ts` — adds an explanatory `note` field when results are empty
- `src/mcp/schemas.ts` — touches search schema description if needed
- `src/mcp/tool-registry.ts` — `bc_search_pages` description mentions BC_PROFILE behaviour
- `tests/integration/connection.test.ts` — extend with profile env var smoke

---

## Conventions for every task

- Use `npx vitest run <path>` for narrow runs, `npx vitest run tests/unit tests/protocol` for the unit/protocol sweep
- After each task: typecheck (`npx tsc --noEmit`), narrow test (must pass), full sweep (must pass)
- Integration tests only at Task 7
- ESM imports include `.js` extension
- Commit messages: `feat:` for new behaviour, `refactor:` for shape moves, `test:` for fixtures

---

## Task 1: Live wire capture — Tell Me result

**Files:**
- Create: `src/protocol/captures/tell-me-result-2026-04-28.json`

- [ ] **Step 1: Run a Tell Me search**

Set capture mode and start the server:

```bash
LOG_CHANNELS=protocol LOG_LEVEL=debug LOG_DIR=./logs npm start
```

In a Claude Desktop session call:

```
bc_search_pages { query: "customer" }
```

The session must run against a BC env where the same query returns results in the BC web client (BC27 default profile is a good choice).

- [ ] **Step 2: Find and save the DataLoaded payload**

In `./logs/protocol-*.log`, locate the `DataLoaded` event(s) emitted in response to the second SaveValue (the actual query). Save the full event JSON (including `rows`) to `src/protocol/captures/tell-me-result-2026-04-28.json`. If the search returned zero results, switch to a different env / profile and repeat — empty results don't help build the extractor.

Strip session keys and any user-identifying strings; otherwise leave the payload literal.

- [ ] **Step 3: Update the captures README**

Append to `src/protocol/captures/README.md`:

```markdown
| File | Source | Date |
|---|---|---|
| tell-me-result-2026-04-28.json | BC27 default profile, query "customer" | 2026-04-28 |
```

- [ ] **Step 4: Inspect the row layout**

Open the captured JSON. For each row, examine the `cells` (or `Cells`) keys. BC labels columns with column-binder names like `1234567_c1`. Decompile reference: `Microsoft.Dynamics.Nav.DataSearch/PageSearchResultRow.cs` (if present) or grep for "PageSearchResult" in the decompiled tree.

Decide:
- Which cell carries the human-readable caption (used as `name`)?
- Which carries the BC object id (the page/report number — used as `pageId`)?
- Which carries the object type ("Page" / "Report" / "Codeunit" — used as `objectType`)?
- Is there a runtime URL (e.g. `runUrl`) or does the row carry only ids?

Document the decision in the captures README, e.g.:

```markdown
## Tell Me row layout (2026-04-28)

Each Tell Me result row's payload has the shape:

```json
{
  "DataRowInserted": [
    <bookmark>,
    {
      "cells": {
        "<cap_caption_binder>": "<caption>",
        "<cap_objectid_binder>": "<id>",
        "<cap_objecttype_binder>": "<Page|Report|...>"
      }
    }
  ]
}
```

The binder name → semantic mapping is keyed by position in the `cells` object
because the binder names are server-generated. Order is stable within a Tell
Me session.
```

- [ ] **Step 5: Commit**

```bash
git add src/protocol/captures/
git commit -m "test: capture Tell Me result wire fixture"
```

---

## Task 2: tell-me-extractor module

**Files:**
- Create: `src/services/tell-me-extractor.ts`
- Create: `tests/unit/tell-me-extractor.test.ts`

- [ ] **Step 1: Write the failing fixture-driven test**

Create `tests/unit/tell-me-extractor.test.ts`:

```typescript
// tests/unit/tell-me-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractTellMeResults, extractTellMeRow } from '../../src/services/tell-me-extractor.js';

const fixturePath = resolve(__dirname, '../../src/protocol/captures/tell-me-result-2026-04-28.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('tell-me-extractor', () => {
  it('extracts at least one result with name and numeric pageId', () => {
    const events = Array.isArray(fixture) ? fixture : [fixture];
    const results = extractTellMeResults(events);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.name).toBeTruthy();
      // pageId is numeric for Page type; '' allowed for non-Page entries
      if (r.objectType === 'Page') {
        expect(r.pageId).toMatch(/^\d+$/);
      }
    }
  });

  it('extractTellMeRow returns null on a malformed row', () => {
    expect(extractTellMeRow(null)).toBeNull();
    expect(extractTellMeRow({})).toBeNull();
    expect(extractTellMeRow({ DataRowInserted: 'not-an-array' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/tell-me-extractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the extractor**

Create `src/services/tell-me-extractor.ts`:

```typescript
// src/services/tell-me-extractor.ts
//
// Decodes BC Tell Me (page-search) DataLoaded rows into structured
// SearchResult records. Cell layout was determined from a live capture
// (src/protocol/captures/tell-me-result-2026-04-28.json) — see
// src/protocol/captures/README.md for the row-layout decision.

import type { BCEvent } from '../protocol/types.js';

export interface TellMeResult {
  /** Human-readable caption shown to the user (e.g. "Customers"). */
  readonly name: string;
  /** BC object id as a string. Empty when the row is not a Page. */
  readonly pageId: string;
  /** Object type label: 'Page', 'Report', 'Codeunit', 'Table', etc. */
  readonly objectType: string;
  /** Direct runtime URL, when BC supplies it. Optional — most rows do not carry this. */
  readonly runUrl?: string;
}

/**
 * Extract every Tell Me row from a list of DataLoaded events. Non-DataLoaded
 * events are ignored. Malformed rows are skipped silently.
 */
export function extractTellMeResults(events: BCEvent[]): TellMeResult[] {
  const out: TellMeResult[] = [];
  for (const event of events) {
    if (event.type !== 'DataLoaded') continue;
    for (const raw of event.rows) {
      const result = extractTellMeRow(raw);
      if (result) out.push(result);
    }
  }
  return out;
}

/**
 * Extract a single Tell Me row's structured fields. Returns null when the
 * payload doesn't match the documented shape.
 *
 * Row payload shape (verified 2026-04-28 against BC27 default profile):
 *
 *   { DataRowInserted: [ <bookmark>, { cells: { <binder1>: <caption>, <binder2>: <objectId>, <binder3>: <objectType> } } ] }
 *
 * Binder names are server-generated and stable only within one Tell Me session,
 * so this function reads cell values by position, not by name.
 */
export function extractTellMeRow(raw: unknown): TellMeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const data = (r.DataRowInserted ?? r.DataRowUpdated) as unknown;
  if (!Array.isArray(data) || data.length < 2) return null;
  const payload = data[1];
  if (!payload || typeof payload !== 'object') return null;
  const cells = ((payload as Record<string, unknown>).cells
    ?? (payload as Record<string, unknown>).Cells) as Record<string, unknown> | undefined;
  if (!cells || typeof cells !== 'object') return null;

  const values = Object.values(cells).filter(v => typeof v === 'string') as string[];
  if (values.length === 0) return null;

  // Cell-value positions per the captured fixture.
  // Adjust these indices if a future capture shows BC reordered them.
  const name = values[0] ?? '';
  const pageId = values[1] && /^\d+$/.test(values[1]) ? values[1] : '';
  const objectType = values[2] ?? (pageId ? 'Page' : '');

  if (!name) return null;

  return { name, pageId, objectType };
}
```

NOTE: Adjust the `values[0]/[1]/[2]` index assignment to match the actual order documented in the captures README during Task 1.5. The tests will fail loudly until the indices match the fixture.

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/unit/tell-me-extractor.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/tell-me-extractor.ts tests/unit/tell-me-extractor.test.ts
git commit -m "feat: tell-me-extractor for structured search results"
```

---

## Task 3: SearchService delegates to extractor

**Files:**
- Modify: `src/services/search-service.ts`

- [ ] **Step 1: Replace `extractSearchResults` with the shared extractor**

In `src/services/search-service.ts`, replace the entire body of `extractSearchResults` (lines ~79-104) with a thin delegate:

```typescript
import { extractTellMeResults } from './tell-me-extractor.js';

  private extractSearchResults(events: BCEvent[]): SearchResult[] {
    const results = extractTellMeResults(events);
    return results.map(r => ({
      name: r.name,
      pageId: r.pageId,
      type: r.objectType,
    }));
  }
```

(Or remove the method entirely and call `extractTellMeResults` directly from `search()`.)

- [ ] **Step 2: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/search-service.ts
git commit -m "refactor: SearchService delegates extraction to tell-me-extractor"
```

---

## Task 4: Locate the OpenSession profile field

**Files:**
- Read-only investigation in `reference/bc28/decompiled/`

- [ ] **Step 1: Decompile lookup**

Run a grep across the decompiled tree:

```bash
# In Claude Code (use the Grep tool, NOT bash grep)
```

Use the Grep tool to search for `"Profile"` in:
- `reference/bc28/decompiled/Microsoft.Dynamics.Nav.Service.ClientService/`
- `reference/bc28/decompiled/Microsoft.Dynamics.Nav.Types/`
- `reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI.Web/`

Look for class names matching `LoginParameters` / `SessionInitParameters` / `OpenSessionParameters`. Record the field name BC accepts on the wire (e.g. `Profile`, `ProfileId`, `RoleCenterId`).

- [ ] **Step 2: Cross-check against the `encodeOpenSession` source**

Read `src/protocol/interaction-encoder.ts` `encodeOpenSession` to see how the existing tenantId / spaInstanceId / clientVersion fields are serialised. The profile field will go into the same payload structure.

- [ ] **Step 3: Document the field name**

Write the discovered field name as a comment block at the top of `src/protocol/interaction-encoder.ts`'s `encodeOpenSession` function:

```typescript
  // OpenSession login parameters (verified against decompiled
  // Microsoft.Dynamics.Nav.Service.ClientService/<class>.cs):
  //   - tenantId: <tenant>
  //   - clientVersion: <BC version string>
  //   - profile: <Profile-id-or-empty>  (set when caller supplied BC_PROFILE)
```

- [ ] **Step 4: Commit (docs-only commit)**

```bash
git add src/protocol/interaction-encoder.ts
git commit -m "docs: record decompiled OpenSession profile field name"
```

---

## Task 5: BC_PROFILE env var threading

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/protocol/interaction-encoder.ts`
- Modify: `src/session/bc-session.ts`
- Modify: `src/session/session-factory.ts`

- [ ] **Step 1: Read profile from env**

In `src/core/config.ts`, extend `BCConfig`:

```typescript
export interface BCConfig {
  baseUrl: string;
  username: string;
  password: string;
  tenantId: string;
  clientVersionString: string;
  serverMajor: number;
  timeoutMs: number;
  invokeTimeoutMs: number;
  reconnectMaxRetries: number;
  reconnectBaseDelayMs: number;
  /** Optional BC profile id. When set, OpenSession requests this profile. Empty string = server default. */
  profile: string;
}
```

In `loadConfig`:

```typescript
      profile: optionalEnv('BC_PROFILE', ''),
```

- [ ] **Step 2: Thread profile through encodeOpenSession**

In `src/protocol/interaction-encoder.ts`, change `encodeOpenSession`'s signature to accept profile:

```typescript
encodeOpenSession(tenantId: string, spaInstanceId: string, options?: { profile?: string }): { method: string; params: unknown[] } {
  // ...build payload as today...
  // Insert the profile field per the decompiled name from Task 4
  if (options?.profile) {
    (payload as Record<string, unknown>).Profile = options.profile; // adjust field name per Task 4 finding
  }
  // ...
}
```

(Adjust the actual property name to whatever the decompile in Task 4 revealed.)

- [ ] **Step 3: Pass profile from BCSession**

In `src/session/bc-session.ts`, add `profile: string` to the constructor parameter list and use it in `initialize`:

```typescript
constructor(
  private readonly ws: BCWebSocket,
  private readonly decoder: EventDecoder,
  private readonly encoder: InteractionEncoder,
  private readonly logger: Logger,
  private readonly tenantId: string,
  private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  private readonly profile: string = '',
) {}
```

Inside `initialize`:

```typescript
const openSessionCall = this.encoder.encodeOpenSession(tenantId, this.ws.spaInstanceId, { profile: this.profile });
```

- [ ] **Step 4: Pass profile from SessionFactory**

In `src/session/session-factory.ts`, find the line that constructs `BCSession` and add `config.bc.profile` as the new arg:

```typescript
const session = new BCSession(ws, decoder, encoder, logger, config.bc.tenantId, config.bc.invokeTimeoutMs, config.bc.profile);
```

(Or whatever `BCConfig` field is read at this site; adapt to existing variable names.)

- [ ] **Step 5: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/config.ts src/protocol/interaction-encoder.ts src/session/bc-session.ts src/session/session-factory.ts
git commit -m "feat: BC_PROFILE env var plumbed into OpenSession"
```

---

## Task 6: Surface helpful note when search returns empty

**Files:**
- Modify: `src/operations/search-pages.ts`
- Modify: `src/mcp/tool-registry.ts`

- [ ] **Step 1: Update SearchPagesOutput**

In `src/operations/search-pages.ts`:

```typescript
import { isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { SearchService, SearchResult } from '../services/search-service.js';

export interface SearchPagesInput {
  query: string;
}

export interface SearchPagesOutput {
  results: SearchResult[];
  /** When results are empty, an explanatory note. Absent when results were returned. */
  note?: string;
}

export class SearchPagesOperation {
  constructor(private readonly searchService: SearchService) {}

  async execute(input: SearchPagesInput): Promise<Result<SearchPagesOutput, ProtocolError>> {
    const result = await this.searchService.search(input.query);
    if (!isOk(result)) return result;
    if (result.value.length === 0) {
      return {
        ok: true,
        value: {
          results: [],
          note: 'No results. Tell Me is profile-scoped — set BC_PROFILE to a profile that includes the searched objects, or open known page IDs directly via bc_open_page.',
        },
      };
    }
    return { ok: true, value: { results: result.value } };
  }
}
```

- [ ] **Step 2: Refresh the tool description**

In `src/mcp/tool-registry.ts`, replace the `bc_search_pages` description with:

```typescript
      description: `Searches BC's Tell Me index for pages, reports, and codeunits matching the query. Returns structured results: { name, pageId, type } per row, plus an explanatory note when results are empty. Tell Me is profile-scoped on the server; if the search returns no rows in an env where the BC web client finds matches, set the BC_PROFILE environment variable to a profile that indexes the relevant objects.

Tip: bc_search_pages results give you pageIds to feed into bc_open_page. For Continia / vertical apps where Tell Me may be empty, common page IDs are listed in limits.md.

Example: { query: "customer" } returns [{ name: "Customers", pageId: "22", type: "Page" }, ...]. Empty result example: { results: [], note: "...set BC_PROFILE..." }.`,
```

- [ ] **Step 3: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/operations/search-pages.ts src/mcp/tool-registry.ts
git commit -m "feat: bc_search_pages emits explanatory note on empty results"
```

---

## Task 7: Live integration

**Files:**
- Modify: `tests/integration/connection.test.ts` (or create `tests/integration/search-pages.test.ts` if cleaner)

- [ ] **Step 1: Add an integration assertion**

Append to or create a search-focused test:

```typescript
// tests/integration/search-pages.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestSession } from './helpers/session.js';

describe('bc_search_pages live extraction', () => {
  let session: Awaited<ReturnType<typeof createTestSession>>;
  beforeAll(async () => { session = await createTestSession(); });
  afterAll(async () => { await session.close(); });

  it('returns structured results with non-empty pageId for "customer"', async () => {
    const result = await session.searchPages('customer');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.results.length === 0) {
      // empty in this env — assert the helpful note instead
      expect(result.value.note).toMatch(/profile/i);
      return;
    }
    const pageHit = result.value.results.find(r => r.type === 'Page');
    expect(pageHit, 'no Page-type result for "customer"').toBeDefined();
    expect(pageHit!.pageId).toMatch(/^\d+$/);
    expect(pageHit!.name).toBeTruthy();
  }, 30000);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/search-pages.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full integration sweep**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/search-pages.test.ts
git commit -m "test: live Tell Me extraction integration"
```

---

## Task 8: Documentation

**Files:**
- Modify: `limits.md`
- Modify: `CLAUDE.md` (Essential Commands or Configuration section)

- [ ] **Step 1: Update limits.md #5**

Replace section "## 5. `bc_search_pages` (Tell Me) returns empty results in some envs" with:

```markdown
**Status (resolved 2026-04-XX, partially)**

- Result extraction is now correct: `pageId`, `name`, `type` populated from
  the captured cell layout. See `src/services/tell-me-extractor.ts` and
  `src/protocol/captures/tell-me-result-2026-04-28.json`.
- Empty-results-in-some-envs is profile-bound. Set `BC_PROFILE` to a profile
  whose Tell Me index includes the searched objects. The `bc_search_pages`
  response now includes an explanatory `note` when results are empty.

Workaround when no profile exposes the target object: use known page IDs
directly with `bc_open_page` (the table in this section remains useful for
Continia DemoPortal envs).
```

- [ ] **Step 2: Document BC_PROFILE in CLAUDE.md**

Append to the configuration / env-var documentation in `CLAUDE.md`:

```markdown
- `BC_PROFILE` (optional) — BC profile id passed in OpenSession login parameters.
  Affects which pages Tell Me indexes and which Role Center loads. Empty =
  server default. Useful for envs where Tell Me returns empty under the
  default profile but the web client (signed in to a specific profile)
  finds matches.
```

- [ ] **Step 3: Commit**

```bash
git add limits.md CLAUDE.md
git commit -m "docs: limits.md #5 — Tell Me extraction fixed, profile env var documented"
```

---

## Self-review checklist

- [ ] Spec coverage:
  - "pageId always empty" → `extractTellMeRow` populates `pageId` from cell layout (Tasks 1–3)
  - "empty results in some envs" → BC_PROFILE plumbed (Tasks 4–5), explanatory note when empty (Task 6)
- [ ] No placeholders, no "TBD"
- [ ] Type names consistent (`TellMeResult`, `extractTellMeResults`) used identically across files
- [ ] Each task ends with a commit
- [ ] Wire-fixture path matches the date in the filename
- [ ] Tests precede implementation in every behaviour-introducing task
