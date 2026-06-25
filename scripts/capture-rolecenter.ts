// scripts/capture-rolecenter.ts
//
// One-shot capture: open the user's Role Center on live BC28, save the full
// FormCreated control tree to
//   src/protocol/captures/cuegroup-rolecenter-2026-04-28.json
// Then, for one of the hosted CardParts, attempt to open it standalone (via
// numeric page id) and save the result to
//   src/protocol/captures/cuegroup-cardpart-standalone-2026-04-28.json
// to characterise the standalone-CardPart-stub symptom (see docs/tools/bc_open_page.md).
//
// Run with:
//   BC_PROFILE="BUSINESS MANAGER" npx tsx scripts/capture-rolecenter.ts
//
// The Role Center page is opened by passing a query without a `page=`
// parameter — BC then resolves the user's default Role Center via the active
// profile. We fall back to known Role Center page ids if the empty query
// doesn't return a host page (i.e. one whose control tree contains `fhc`
// FormHost children).

import { config as dotenvConfig } from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { createNullLogger } from '../src/core/logger.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { isOk, unwrap } from '../src/core/result.js';
import type { OpenFormInteraction, CloseFormInteraction, BCEvent } from '../src/protocol/types.js';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface FhcChild {
  // The hosted form's ServerId (BC's internal form id).
  serverId: string;
  caption: string;
  pageType: number;
  // Hint for the source page object — sometimes BC carries this as the
  // hosted form's `Name` (AL page name). We capture whatever we can find.
  name: string | undefined;
  // The fhc node's controlPath — useful for documenting structure.
  fhcPath: string | undefined;
}

function asObject(node: unknown): Record<string, unknown> | null {
  return node && typeof node === 'object' ? (node as Record<string, unknown>) : null;
}

/**
 * Walks a control tree and collects every `fhc` (FormHost) node's hosted
 * form metadata. The hosted `lf` is the first child of an `fhc`.
 */
function findFhcChildren(node: unknown, results: FhcChild[] = []): FhcChild[] {
  const obj = asObject(node);
  if (!obj) return results;

  if (obj['t'] === 'fhc') {
    const children = obj['Children'] as unknown[] | undefined;
    const hosted = asObject(children?.[0]);
    if (hosted) {
      results.push({
        serverId: (hosted['ServerId'] as string) ?? '',
        caption: (hosted['Caption'] as string) ?? '',
        pageType: typeof hosted['PageType'] === 'number' ? (hosted['PageType'] as number) : -1,
        name: (hosted['Name'] as string) ?? undefined,
        fhcPath: (obj['ControlPath'] as string) ?? undefined,
      });
    }
  }

  const children = obj['Children'] as unknown[] | undefined;
  if (Array.isArray(children)) {
    for (const c of children) findFhcChildren(c, results);
  }
  return results;
}

/**
 * Heuristic check for "looks like a cuegroup": a `gc` (group container) whose
 * children are all i32c / numeric leaves. A genuine cue dashboard typically
 * has multiple integer-typed cells with hint metadata. We just count i32c
 * descendants — actual discriminator selection is Task 2.
 */
function countI32cDescendants(node: unknown): number {
  const obj = asObject(node);
  if (!obj) return 0;
  let count = 0;
  if (obj['t'] === 'i32c') count += 1;
  const children = obj['Children'] as unknown[] | undefined;
  if (Array.isArray(children)) {
    for (const c of children) count += countI32cDescendants(c);
  }
  return count;
}

async function main(): Promise<void> {
  const logger = createNullLogger();
  const appConfig = loadConfig();
  const auth = new NTLMAuthProvider(
    {
      baseUrl: appConfig.bc.baseUrl,
      username: appConfig.bc.username,
      password: appConfig.bc.password,
      tenantId: appConfig.bc.tenantId,
    },
    logger,
  );
  const connFactory = new ConnectionFactory(auth, appConfig.bc, logger);
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(appConfig.bc.clientVersionString);
  const sessionFactory = new SessionFactory(
    connFactory,
    decoder,
    encoder,
    logger,
    appConfig.bc.tenantId,
    appConfig.bc.invokeTimeoutMs,
    appConfig.bc.profile,
  );

  console.error(`Connecting to BC (profile: ${appConfig.bc.profile || '<default>'})...`);
  const sessionResult = await sessionFactory.create();
  if (!isOk(sessionResult)) {
    console.error('Failed to create session:', sessionResult.error.message);
    process.exit(1);
  }
  const session = unwrap(sessionResult);
  console.error('Connected.');

  try {
    // ---------------------------------------------------------------
    // Phase 1: open the role center
    // ---------------------------------------------------------------
    console.error('\nPhase 1: opening role center candidates...');
    const candidates: Array<{ query: string; label: string }> = [
      { query: `tenant=${appConfig.bc.tenantId}&runinframe=1`, label: 'default role center' },
      { query: `page=9022&tenant=${appConfig.bc.tenantId}`, label: 'page 9022 (Sales Order Processor RC)' },
      { query: `page=9018&tenant=${appConfig.bc.tenantId}`, label: 'page 9018 (Business Manager RC)' },
      { query: `page=9006&tenant=${appConfig.bc.tenantId}`, label: 'page 9006 (Sales & Relationship Mgr RC)' },
    ];

    let chosen:
      | { events: BCEvent[]; label: string; rootFormId: string; fhcs: FhcChild[] }
      | null = null;

    for (const cand of candidates) {
      console.error(`  Trying ${cand.label} (query="${cand.query}")...`);
      const open: OpenFormInteraction = { type: 'OpenForm', query: cand.query };
      const result = await session.invoke(open, (e) => e.type === 'InvokeCompleted');
      if (!isOk(result)) {
        console.error(`    failed: ${result.error.message}`);
        continue;
      }
      const events = result.value;
      // The root FormCreated has no parentFormId.
      const rootFc = events.find(
        (e) => e.type === 'FormCreated' && !(e as { parentFormId?: string }).parentFormId,
      );
      if (!rootFc || rootFc.type !== 'FormCreated') {
        console.error(`    no root FormCreated event (got: ${events.map((e) => e.type).join(',')})`);
        continue;
      }
      const fhcs = findFhcChildren(rootFc.controlTree);
      if (fhcs.length === 0) {
        console.error(`    ${cand.label} has no fhc children — not a host page`);
        // Close and try next
        const closeRes = await session
          .invoke(
            { type: 'CloseForm', formId: rootFc.formId } satisfies CloseFormInteraction,
            (e) => e.type === 'InvokeCompleted',
          )
          .catch(() => null);
        if (closeRes && !isOk(closeRes)) {
          console.error(`    (close failed: ${closeRes.error.message})`);
        }
        continue;
      }
      console.error(`    Found ${fhcs.length} hosted form(s):`);
      for (const f of fhcs) {
        console.error(
          `      - serverId=${f.serverId} caption="${f.caption}" PageType=${f.pageType} name=${f.name ?? '?'} fhcPath=${f.fhcPath ?? '?'}`,
        );
      }
      chosen = { events, label: cand.label, rootFormId: rootFc.formId, fhcs };
      break;
    }

    if (!chosen) {
      console.error('Could not open any role center. Aborting.');
      process.exit(1);
    }

    const outDir = resolve(__dirname, '../src/protocol/captures');
    mkdirSync(outDir, { recursive: true });

    const rcOutPath = resolve(outDir, 'cuegroup-rolecenter-2026-04-28.json');
    writeFileSync(rcOutPath, JSON.stringify(chosen.events, null, 2));
    console.error(`\nSaved role center capture: ${rcOutPath}`);
    console.error(`  Source: ${chosen.label}`);
    console.error(`  Root formId: ${chosen.rootFormId}`);
    console.error(`  fhc children: ${chosen.fhcs.length}`);

    // Quick cuegroup heuristic — count i32c descendants per hosted form.
    console.error('\nCuegroup heuristic (i32c descendant counts per hosted form):');
    const rootFc = chosen.events.find(
      (e) => e.type === 'FormCreated' && !(e as { parentFormId?: string }).parentFormId,
    );
    const rcTree = rootFc && rootFc.type === 'FormCreated' ? rootFc.controlTree : null;
    const fhcNodes: Array<{ child: FhcChild; i32cCount: number }> = [];
    if (rcTree) {
      const obj = asObject(rcTree);
      if (obj) {
        // Walk the tree and pick the hosted lf (first child of each fhc)
        const visit = (n: unknown): void => {
          const o = asObject(n);
          if (!o) return;
          if (o['t'] === 'fhc') {
            const children = o['Children'] as unknown[] | undefined;
            const hosted = asObject(children?.[0]);
            if (hosted) {
              const idx = fhcNodes.length;
              const meta = chosen!.fhcs[idx];
              if (meta) {
                fhcNodes.push({ child: meta, i32cCount: countI32cDescendants(hosted) });
              }
            }
          }
          const childs = o['Children'] as unknown[] | undefined;
          if (Array.isArray(childs)) for (const c of childs) visit(c);
        };
        visit(obj);
      }
    }
    for (const f of fhcNodes) {
      console.error(
        `  - "${f.child.caption}" (PageType=${f.child.pageType}): ${f.i32cCount} i32c descendants`,
      );
    }

    // ---------------------------------------------------------------
    // Phase 2: open one CardPart standalone
    // ---------------------------------------------------------------
    console.error('\nPhase 2: opening a hosted CardPart standalone...');
    // BC's PageType ordinal map (PAGE_TYPE_MAP in form-tree-builder.ts):
    //   3 = CardPart (per Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs).
    const cardPartCandidates = chosen.fhcs.filter((f) => f.pageType === 3);
    if (cardPartCandidates.length === 0) {
      console.error(
        '  No CardPart (PageType=3) found among hosted forms. Standalone capture cannot be performed via fhc enumeration alone — falling back to a known-id list.',
      );
    }
    // Prefer a CardPart with cuegroup-shaped content if we can identify one;
    // else just take the first CardPart.
    const cuegroupCardParts = cardPartCandidates.filter((c) => {
      const idx = chosen!.fhcs.indexOf(c);
      const cnt = fhcNodes[idx]?.i32cCount ?? 0;
      return cnt >= 2;
    });
    const targetCardPart =
      cuegroupCardParts[0] ?? cardPartCandidates[0] ?? null;

    if (!targetCardPart) {
      // No CardPart from the role center; just write an informational stub.
      const note = {
        note: 'Standalone CardPart capture skipped: the role center had no hosted CardParts (PageType=3).',
        rolecenter: { label: chosen.label, fhcs: chosen.fhcs },
      };
      const standaloneOutPath = resolve(outDir, 'cuegroup-cardpart-standalone-2026-04-28.json');
      writeFileSync(standaloneOutPath, JSON.stringify(note, null, 2));
      console.error(`  Documented skip: ${standaloneOutPath}`);
      return;
    }

    console.error(
      `  Target CardPart: "${targetCardPart.caption}" (serverId=${targetCardPart.serverId}, name=${targetCardPart.name ?? '?'})`,
    );

    // BC's `page=` query expects a numeric page id (the AL `id` of the page
    // object). The fhc child's `ServerId` is BC's internal form-handle hex
    // (e.g. "3C14") and is NOT a usable page id. Likewise the hosted lf has
    // no numeric id field exposed on the wire.
    //
    // Known standard CardPart page ids on a default BC28 install (used here
    // to characterise the standalone-stub symptom; see docs/tools/bc_open_page.md):
    //   1310  -- O365 Activities (the role-center Activities cuegroup)
    //   9061  -- Sales Cue
    //   9043  -- Purchase Cue
    //   9152  -- Customer Statistics FactBox
    //   9056  -- Customer Details FactBox
    type Attempt = { query: string; label: string };
    const attempts: Attempt[] = [
      { query: `page=1310&tenant=${appConfig.bc.tenantId}`, label: 'page 1310 (O365 Activities — cuegroup CardPart)' },
      { query: `page=9061&tenant=${appConfig.bc.tenantId}`, label: 'page 9061 (Sales Cue — CueGroup CardPart)' },
      { query: `page=9152&tenant=${appConfig.bc.tenantId}`, label: 'page 9152 (Customer Statistics FactBox CardPart)' },
    ];

    type StandaloneResult = {
      attempt: Attempt;
      events: BCEvent[];
      rootFormId: string | null;
      isStub: boolean;
      stubReason?: string;
    };
    const standaloneAttempts: StandaloneResult[] = [];

    for (const att of attempts) {
      console.error(`  Attempting OpenForm "${att.query}" (${att.label})...`);
      const openRes = await session.invoke(
        { type: 'OpenForm', query: att.query } satisfies OpenFormInteraction,
        (e) => e.type === 'InvokeCompleted',
      );
      if (!isOk(openRes)) {
        console.error(`    failed: ${openRes.error.message}`);
        standaloneAttempts.push({
          attempt: att,
          events: [],
          rootFormId: null,
          isStub: true,
          stubReason: `OpenForm error: ${openRes.error.message}`,
        });
        continue;
      }
      const events = openRes.value;
      const rootFc = events.find(
        (e) => e.type === 'FormCreated' && !(e as { parentFormId?: string }).parentFormId,
      );
      const rootFormId = rootFc && rootFc.type === 'FormCreated' ? rootFc.formId : null;

      // Stub heuristic: a "stub" CardPart returns a FormCreated whose tree
      // has no children, or whose only children are placeholders. We
      // record both raw events and a brief summary.
      let isStub = false;
      let stubReason: string | undefined;
      if (!rootFc) {
        isStub = true;
        stubReason = 'no FormCreated in response';
      } else if (rootFc.type === 'FormCreated') {
        const tree = asObject(rootFc.controlTree);
        const children = tree?.['Children'] as unknown[] | undefined;
        const childCount = Array.isArray(children) ? children.length : 0;
        const i32c = countI32cDescendants(rootFc.controlTree);
        if (childCount === 0) {
          isStub = true;
          stubReason = 'FormCreated has zero children (placeholder shell)';
        } else if (i32c === 0) {
          // Not necessarily a stub, but worth noting if the role-center
          // version had cues and the standalone doesn't.
          stubReason = `FormCreated had ${childCount} children but 0 i32c — content may be loaded lazily`;
        }
      }
      standaloneAttempts.push({ attempt: att, events, rootFormId, isStub, stubReason });
      console.error(
        `    rootFormId=${rootFormId ?? '<none>'} isStub=${isStub} reason=${stubReason ?? '<n/a>'}`,
      );

      // Close standalone form between attempts.
      if (rootFormId) {
        await session
          .invoke(
            { type: 'CloseForm', formId: rootFormId } satisfies CloseFormInteraction,
            (e) => e.type === 'InvokeCompleted',
          )
          .catch(() => null);
      }
    }

    // Save the first attempt as the primary fixture; include everything for
    // forensic completeness.
    const primary = standaloneAttempts[0] ?? null;
    const standaloneOutPath = resolve(outDir, 'cuegroup-cardpart-standalone-2026-04-28.json');
    const standalonePayload = {
      target: targetCardPart,
      attempts: standaloneAttempts.map((a) => ({
        query: a.attempt.query,
        label: a.attempt.label,
        rootFormId: a.rootFormId,
        isStub: a.isStub,
        stubReason: a.stubReason,
        events: a.events,
      })),
      summary: primary
        ? `Primary attempt label="${primary.attempt.label}" isStub=${primary.isStub}; reason=${primary.stubReason ?? '<n/a>'}`
        : 'No standalone OpenForm attempts succeeded.',
    };
    writeFileSync(standaloneOutPath, JSON.stringify(standalonePayload, null, 2));
    console.error(`\nSaved standalone CardPart capture: ${standaloneOutPath}`);
  } finally {
    await session.closeGracefully().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
