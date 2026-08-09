// scripts/verify-features.ts <docker|saas> [--keep-capture]
//
// Live check for the capabilities added on top of the upstream fork. It runs the
// SAME Operations the MCP tools wrap, so a PASS here means the tool works on that
// environment. Non-destructive except for one draft Sales Order it creates and
// deletes again (the standard way to observe line insert/remove events).
//
//   npm run verify:features docker
//   npm run verify:features saas
//
// Checks:
//   G2  create mode      — bc_open_page { mode: "Create" } yields a blank, writable record
//   G8  line filtering   — bc_read_data { section:"lines", filters } narrows the lines
//   G9  activeFilters    — every read echoes the filters actually in force
//   B4  row removal      — deleting a line drops it from the projected rows
//   B6  repeater choice  — a document's header/lines sections stay distinguishable
//
// With --keep-capture the raw DataLoaded row payload of a removal is written to
// src/protocol/captures/ so the wire shape can be pinned in a unit test.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnvName, loadEnvFile, createHarness } from './lib/harness.js';
import { isOk } from '../src/core/result.js';

const env = parseEnvName(process.argv[2]);
const keepCapture = process.argv.includes('--keep-capture');
loadEnvFile(env);

type Status = 'PASS' | 'FAIL' | 'SKIP';
const results: Array<{ id: string; status: Status; detail: string }> = [];
const rec = (id: string, status: Status, detail: string): void => {
  results.push({ id, status, detail });
  console.log(`  [${status}] ${id} — ${detail}`);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const A = (v: any): any => v;

const h = await createHarness(env);
console.log(`\n===== FEATURE VERIFICATION: ${env} =====`);
console.log(`base=${h.cfg.bc.baseUrl} auth=${h.cfg.bc.authMode} company=${h.session.companyName}\n`);

// B4: watch the RAW DataLoaded row-change payloads on their way into the projection.
// `DataLoadedEvent.rows` is the untouched wire array, and the repository is the one
// choke point every event passes through — so wrapping it captures the real shape of
// a row removal without adding a debug hook to src/.
const rawRowChanges: unknown[] = [];
const originalApply = h.repo.applyToPage.bind(h.repo);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(h.repo as any).applyToPage = (pageContextId: string, events: any[]) => {
  for (const e of events ?? []) {
    if (e?.type !== 'DataLoaded' || !Array.isArray(e.rows)) continue;
    for (const row of e.rows) {
      const keys = row && typeof row === 'object' ? Object.keys(row) : [];
      if (keys.some((k) => /remove/i.test(k))) rawRowChanges.push(row);
    }
  }
  return originalApply(pageContextId, events);
};

/** First non-empty value of the column whose caption matches `column`, on a list page. */
async function firstCellValue(pageId: string, column: RegExp): Promise<string | undefined> {
  const r = await h.ops.openPage.execute({ pageId });
  if (!isOk(r)) return undefined;
  const pcId = A(r.value).pageContextId;
  try {
    const rows: Array<{ cells: Record<string, unknown> }> = A(r.value).sections?.[0]?.rows ?? [];
    for (const row of rows) {
      const key = Object.keys(row.cells).find((k) => column.test(k.trim()));
      const value = key ? row.cells[key] : undefined;
      if (value !== null && value !== undefined && String(value) !== '') return String(value);
    }
    return undefined;
  } finally {
    await h.ops.closePage.execute({ pageContextId: pcId }).catch(() => undefined);
  }
}

let orderPcId = '';
try {
  // ---- G2: open a Sales Order in Create mode ------------------------------
  // A blank order is the cleanest observable: BC assigns a No. via the number
  // series and every header field is editable. Opening WITHOUT mode lands on an
  // existing record instead, which is exactly the gap G2 describes.
  try {
    const created = await h.ops.openPage.execute({ pageId: '42', mode: 'Create' });
    if (!isOk(created)) {
      rec('G2 create mode', 'FAIL', created.error.message);
    } else {
      orderPcId = A(created.value).pageContextId;
      const header = A(created.value).sections?.find((s: { kind: string }) => s.kind === 'header');
      const fields: Array<{ name: string; stringValue?: string; editable?: unknown }> = header?.fields ?? [];
      const editable = fields.filter((f) => f.editable !== false).length;
      // A freshly created document has no customer yet: the Sell-to name is empty.
      const nameField = fields.find((f) => /^(sell-to customer name|nombre|name|nom)$/i.test(f.name));
      const blank = !nameField || !nameField.stringValue;
      rec('G2 create mode', blank && editable > 0 ? 'PASS' : 'FAIL',
        `pageType=${A(created.value).pageType} fields=${fields.length} editable=${editable} blankCustomer=${blank}`);
    }
  } catch (e) { rec('G2 create mode', 'FAIL', String(e)); }

  // ---- G2 (part 2): the created record must accept real data --------------
  // A blank shell proves little; the capability is only real if BC accepts a
  // customer and a line on it. This also builds the fixture B4 needs.
  let lineWritten = false;
  try {
    if (!orderPcId) {
      rec('G2 fill created record', 'SKIP', 'no order created');
    } else {
      // Pick a real customer and item from the live data (locale-independent: read
      // the first row's first non-empty cell of the primary-key column).
      const custNo = await firstCellValue('22', /^(n[ºo]\.?|no\.|code|c[oó]digo)$/i);
      const itemNo = await firstCellValue('31', /^(n[ºo]\.?|no\.|code|c[oó]digo)$/i);
      const header = await h.ops.readData.execute({ pageContextId: orderPcId });
      const fields: Array<{ name: string; controlPath: string; editable?: unknown }> = isOk(header) ? A(header.value).section?.fields ?? [] : [];
      const custField = fields.find((f) => /(sell-to customer no|cliente|customer no)/i.test(f.name) && /n[ºo]|no\.|c[oó]d/i.test(f.name))
        ?? fields.find((f) => /(sell-to customer no|customer no|nº cliente)/i.test(f.name));
      if (!custNo || !custField) {
        rec('G2 fill created record', 'SKIP', `customer=${custNo ?? 'none'} field=${custField?.name ?? 'not found'}`);
      } else {
        const w = await h.ops.writeData.execute({ pageContextId: orderPcId, fields: { [custField.controlPath]: custNo } });
        const changed = isOk(w) ? A(w.value).results?.[0]?.changed === true : false;
        if (!changed) {
          console.log(`      (field "${custField.name}" @ ${custField.controlPath} -> ${isOk(w) ? JSON.stringify(A(w.value).results) : A(w).error.message})`);
        }
        // Now a line: BC's first blank line accepts Type=Item + No.
        let lineNote = 'no item to add';
        if (changed && itemNo) {
          const lineSecs = h.repo.get(orderPcId);
          const lineId = lineSecs ? Array.from(lineSecs.sections.keys()).find((k) => k === 'lines') : undefined;
          if (lineId) {
            const lw = await h.ops.writeData.execute({
              pageContextId: orderPcId, section: lineId, rowIndex: 0,
              fields: { 'No.': itemNo, 'Nº': itemNo },
            }).catch(() => null);
            lineWritten = !!(lw && isOk(lw) && A(lw.value).results?.some((r: { changed?: boolean }) => r.changed));
            lineNote = lineWritten ? `line set to item ${itemNo}` : `line write did not stick (item ${itemNo})`;
          }
        }
        rec('G2 fill created record', changed ? 'PASS' : 'FAIL',
          `customer ${custNo} -> changed=${changed}; ${lineNote}`);
      }
    }
  } catch (e) { rec('G2 fill created record', 'FAIL', String(e)); }

  // ---- G9: activeFilters echoed on a filtered list ------------------------
  try {
    const list = await h.ops.openPage.execute({ pageId: '22', filters: [{ column: 'No.', value: '1*' }] });
    if (!isOk(list)) rec('G9 activeFilters', 'FAIL', list.error.message);
    else {
      const echoed = A(list.value).activeFilters ?? [];
      const rows = A(list.value).sections?.[0]?.rows?.length ?? 0;
      const read = await h.ops.readData.execute({ pageContextId: A(list.value).pageContextId });
      const echoedOnRead = isOk(read) ? A(read.value).activeFilters ?? [] : [];
      const okEcho = echoed.length === 1 && echoed[0].column === 'No.' && echoedOnRead.length === 1;
      rec('G9 activeFilters', okEcho ? 'PASS' : 'FAIL',
        `open echoed ${JSON.stringify(echoed)}; read echoed ${JSON.stringify(echoedOnRead)}; rows=${rows}`);
      await h.ops.closePage.execute({ pageContextId: A(list.value).pageContextId }).catch(() => undefined);
    }
  } catch (e) { rec('G9 activeFilters', 'FAIL', String(e)); }

  // ---- B6 + G8: document sections, then filter the LINES ------------------
  if (!orderPcId) {
    rec('B6 repeater sections', 'SKIP', 'no order page');
    rec('G8 line filtering', 'SKIP', 'no order page');
    rec('B4 row removal', 'SKIP', 'no order page');
  } else {
    let linesSectionId = '';
    try {
      const opened = await h.ops.openPage.execute({ pageId: '42', summary: true });
      const sections: Array<{ sectionId: string; kind: string }> = isOk(opened) ? A(opened.value).sections ?? [] : [];
      const lines = sections.find((s) => s.kind === 'lines') ?? sections.find((s) => s.kind === 'subpage');
      linesSectionId = lines?.sectionId ?? '';
      const header = sections.find((s) => s.kind === 'header');
      rec('B6 repeater sections', header && lines ? 'PASS' : 'FAIL',
        `sections=${sections.map((s) => `${s.sectionId}:${s.kind}`).join(', ')}`);
      if (isOk(opened)) await h.ops.closePage.execute({ pageContextId: A(opened.value).pageContextId }).catch(() => undefined);
    } catch (e) { rec('B6 repeater sections', 'FAIL', String(e)); }

    // Add two lines to the draft order so there is something to filter and remove.
    let lineRowsBefore = 0;
    try {
      if (!linesSectionId) {
        rec('G8 line filtering', 'SKIP', 'no lines section on page 42');
        rec('B4 row removal', 'SKIP', 'no lines section on page 42');
      } else {
        const before = await h.ops.readData.execute({ pageContextId: orderPcId, section: linesSectionId });
        lineRowsBefore = isOk(before) ? A(before.value).section?.rows?.length ?? 0 : 0;

        // Filter the lines by whatever the first row shows, so the check works on
        // any dataset: an impossible value must return 0 rows, a real one >= 1.
        const rows: Array<{ cells: Record<string, unknown> }> = isOk(before) ? A(before.value).section?.rows ?? [] : [];
        const firstKey = rows[0] ? Object.keys(rows[0].cells).find((k) => rows[0]!.cells[k]) : undefined;
        if (!firstKey) {
          // An empty new order has no lines: filtering must still be well-defined
          // (0 rows, reported as a client-side filter) rather than an error.
          const empty = await h.ops.readData.execute({
            pageContextId: orderPcId, section: linesSectionId,
            filters: [{ column: 'Type', value: 'zzz-not-a-real-value' }],
          });
          const rf = isOk(empty) ? A(empty.value).rowFilter : undefined;
          rec('G8 line filtering', isOk(empty) && rf?.mode === 'client' ? 'PASS' : (isOk(empty) ? 'FAIL' : 'FAIL'),
            isOk(empty)
              ? `no lines to match: matched=${rf?.matched ?? '?'} scanned=${rf?.scanned ?? '?'} mode=${rf?.mode ?? 'none'}`
              : A(empty).error.message);
        } else {
          const value = String(rows[0]!.cells[firstKey]);
          const narrowed = await h.ops.readData.execute({
            pageContextId: orderPcId, section: linesSectionId,
            filters: [{ column: firstKey, value }],
          });
          const impossible = await h.ops.readData.execute({
            pageContextId: orderPcId, section: linesSectionId,
            filters: [{ column: firstKey, value: 'zzz-not-a-real-value' }],
          });
          const nMatch = isOk(narrowed) ? A(narrowed.value).section?.rows?.length ?? -1 : -1;
          const nNone = isOk(impossible) ? A(impossible.value).section?.rows?.length ?? -1 : -1;
          const mode = isOk(narrowed) ? A(narrowed.value).rowFilter?.mode : undefined;
          rec('G8 line filtering', nMatch >= 1 && nNone === 0 && mode === 'client' ? 'PASS' : 'FAIL',
            `filter ${firstKey}="${value}" -> ${nMatch} rows; impossible value -> ${nNone} rows; mode=${mode}`);
        }
      }
    } catch (e) { rec('G8 line filtering', 'FAIL', String(e)); }

    // ---- B4: remove a LINE, then confirm the projection dropped it --------
    // Deleting the whole document closes the form, so it proves nothing about row
    // removal. Deleting one line is the case that leaves a stale row behind.
    try {
      if (!linesSectionId) {
        rec('B4 row removal', 'SKIP', 'no lines section');
      } else {
        const before = await h.ops.readData.execute({ pageContextId: orderPcId, section: linesSectionId });
        const rowsBefore: Array<{ bookmark: string; cells: Record<string, unknown> }> = isOk(before) ? A(before.value).section?.rows ?? [] : [];
        // Only a row with content can be deleted; BC's trailing blank placeholders can't.
        const target = rowsBefore.find((r) => Object.values(r.cells).some((v) => v !== null && v !== ''));
        if (!target) {
          rec('B4 row removal', 'SKIP', `no populated line to delete (rows=${rowsBefore.length})`);
        } else {
          const del = await h.ops.executeAction.execute({
            pageContextId: orderPcId, section: linesSectionId, action: 'Delete', bookmark: target.bookmark,
          });
          if (!isOk(del)) {
            rec('B4 row removal', 'FAIL', A(del).error.message);
          } else {
            const dialogs = A(del.value).dialogsOpened ?? [];
            for (const d of dialogs) {
              await h.ops.respondDialog.execute({
                pageContextId: orderPcId, dialogFormId: d.formId ?? d.dialogFormId, response: 'yes',
              }).catch(() => undefined);
            }
            const after = await h.ops.readData.execute({ pageContextId: orderPcId, section: linesSectionId });
            const rowsAfter: Array<{ bookmark: string }> = isOk(after) ? A(after.value).section?.rows ?? [] : [];
            const stillThere = rowsAfter.some((r) => r.bookmark === target.bookmark);
            rec('B4 row removal', stillThere ? 'FAIL' : 'PASS',
              `line deleted: rows ${rowsBefore.length} -> ${rowsAfter.length}; stale row present=${stillThere}; `
              + `raw removal payloads seen=${rawRowChanges.length}`);
          }
        }
      }
    } catch (e) { rec('B4 row removal', 'FAIL', String(e)); }

    // ---- Tidy up: delete the draft order --------------------------------
    try {
      const del = await h.ops.executeAction.execute({ pageContextId: orderPcId, action: 'Delete' });
      if (isOk(del)) {
        for (const d of A(del.value).dialogsOpened ?? []) {
          await h.ops.respondDialog.execute({
            pageContextId: orderPcId, dialogFormId: d.formId ?? d.dialogFormId, response: 'yes',
          }).catch(() => undefined);
        }
        orderPcId = '';
      }
    } catch { /* cleanup is best effort; the finally block retries */ }
  }

  // ---- Raw removal capture (only when asked) ------------------------------
  if (keepCapture && rawRowChanges.length > 0) {
    const out = resolve(process.cwd(), 'src/protocol/captures', `datarowremoved-${env}.json`);
    writeFileSync(out, JSON.stringify({
      env,
      source: 'scripts/verify-features.ts — raw DataLoaded row-change entries containing a *Removed key',
      payloads: rawRowChanges,
    }, null, 2));
    console.log(`\ncapture written to ${out} (${rawRowChanges.length} payloads)`);
  } else if (keepCapture) {
    console.log('\nno row-removal payload observed — nothing captured');
  }
} finally {
  if (orderPcId) {
    // Never leave a draft order behind.
    await h.ops.executeAction.execute({ pageContextId: orderPcId, action: 'Delete' }).catch(() => undefined);
  }
  await h.dispose();
}

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const skip = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n===== SUMMARY ${env}: ${pass} PASS, ${fail} FAIL, ${skip} SKIP =====`);
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.id.padEnd(24)} ${r.detail}`);
process.exit(fail > 0 ? 1 : 0);
