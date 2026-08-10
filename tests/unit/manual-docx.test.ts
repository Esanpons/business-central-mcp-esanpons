import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDocx } from '../../src/services/manual-docx.js';
import type { PageBreakMap } from '../../src/services/manual-paginate.js';
import type { ManualModel } from '../../src/services/manual-render.js';

/**
 * A .docx is a zip of XML parts, so every assertion here reads the real
 * document.xml back out of the package. Doing it through the central directory
 * (rather than scanning for local file headers) matters: compressed image data
 * contains the `PK\x03\x04` signature often enough that a naive scan finds
 * phantom entries.
 */
function part(docx: Buffer, name: string): string {
  const eocd = docx.lastIndexOf(Buffer.from('PK\x05\x06'));
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = docx.readUInt16LE(eocd + 10);
  let off = docx.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = docx.readUInt16LE(off + 28);
    const extraLen = docx.readUInt16LE(off + 30);
    const commentLen = docx.readUInt16LE(off + 32);
    const entry = docx.subarray(off + 46, off + 46 + nameLen).toString();
    if (entry === name) {
      const method = docx.readUInt16LE(off + 10);
      const compressed = docx.readUInt32LE(off + 20);
      const localOff = docx.readUInt32LE(off + 42);
      const start = localOff + 30 + docx.readUInt16LE(localOff + 26) + docx.readUInt16LE(localOff + 28);
      const raw = docx.subarray(start, start + compressed);
      return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`part not found: ${name}`);
}

/** The step headings, in order, with whether each carries an explicit page break. */
function headings(document: string): { text: string; pageBreak: boolean }[] {
  return [...document.matchAll(/<w:p>(?:(?!<\/w:p>).)*?ManualHeading.*?<\/w:p>/gs)].map((m) => ({
    text: [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''),
    pageBreak: /pageBreakBefore/.test(m[0]),
  }));
}

/** Index rows: the bookmark each PAGEREF points at and the page number cached in it. */
function tocFields(document: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of document.matchAll(/<w:fldSimple w:instr="PAGEREF (\S+) \\h"(\/>|>(.*?)<\/w:fldSimple>)/gs)) {
    out[m[1]!] = m[3] ? (/<w:t[^>]*>([^<]*)</.exec(m[3])?.[1] ?? '') : '';
  }
  return out;
}

let dir: string;
let png: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-manual-docx-'));
  png = join(dir, 'step-1.png');
  // A real (tiny) PNG: the renderer reads the IHDR for the intrinsic size and
  // embeds the bytes verbatim, so a hand-built header is enough.
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(1600, 16);
  buf.writeUInt32BE(1200, 20);
  writeFileSync(png, buf);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DATE = new Date(Date.UTC(2026, 7, 10));

function model(steps = 4): ManualModel {
  return {
    title: 'Com crear un client',
    intro: 'Guia **curta** amb `codi`.',
    steps: Array.from({ length: steps }, (_, i) => ({
      heading: `Pas ${i + 1}`,
      body: i === 0 ? 'Fes aixo.\n\n- un\n- dos\n\n1. primer\n2. segon\n\n> Compte amb el filtre.' : 'Text.',
      image: i === 0 ? { absPath: png, relPath: 'x-img/step-1.png', width: 1600, height: 1200, caption: 'La fitxa' } : undefined,
    })),
  };
}

describe('renderDocx -- document shape', () => {
  it('writes a valid Word package with the manual styles and no hard-coded heading style clash', async () => {
    const { buffer } = await renderDocx(model(), { date: DATE });
    const document = part(buffer, 'word/document.xml');
    const styles = part(buffer, 'word/styles.xml');

    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    for (const id of ['ManualTitle', 'ManualHeading', 'ManualBody', 'ManualNote', 'ManualCaption']) {
      expect(styles).toContain(`w:styleId="${id}"`);
    }
    // Word honours only the first w:pStyle in a paragraph, so a second one
    // silently discards the manual's formatting. There must never be two.
    for (const props of document.matchAll(/<w:pPr>.*?<\/w:pPr>/gs)) {
      expect((props[0].match(/<w:pStyle/g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it('gives every bookmark a distinct numeric id', async () => {
    const { buffer } = await renderDocx(model(5), { date: DATE });
    const document = part(buffer, 'word/document.xml');
    const ids = [...document.matchAll(/<w:bookmarkStart w:name="(step-\d+)" w:id="(\d+)"/g)].map((m) => m[2]);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('places prose below the figure when a step carries it', async () => {
    const m = model(1);
    m.steps[0]!.after = 'Comprova que el resultat sigui correcte.';
    const document = part((await renderDocx(m, { date: DATE })).buffer, 'word/document.xml');

    expect(document).toContain('Comprova que el resultat sigui correcte.');
    // The figure comes first; the commentary follows it.
    expect(document.indexOf('<a:blip')).toBeLessThan(document.indexOf('Comprova que el resultat'));
  });

  it('embeds the figure and its caption, and keeps the two together', async () => {
    const { buffer, warnings } = await renderDocx(model(), { date: DATE });
    const document = part(buffer, 'word/document.xml');

    expect(warnings).toEqual([]);
    expect(document).toContain('<a:blip');
    expect(document).toContain('La fitxa');
    // The figure paragraph must not be separated from the caption below it.
    const figure = /<w:p>(?:(?!<\/w:p>).)*?ManualFigure.*?<\/w:p>/s.exec(document);
    expect(figure?.[0]).toContain('keepNext');
  });

  it('scales a capture down to the printable width instead of embedding it full size', async () => {
    const { buffer } = await renderDocx(model(), { date: DATE });
    const document = part(buffer, 'word/document.xml');
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(document);

    // 178mm of usable width, in EMU (1mm = 36000 EMU). A 1600px capture at a 2x
    // device scale must come back down to the page, not overflow it.
    expect(Number(extent?.[1])).toBeLessThanOrEqual(178 * 36000);
    expect(Number(extent?.[1]) / Number(extent?.[2])).toBeCloseTo(1600 / 1200, 2);
  });

  it('renders each Markdown list as its own numbering instance so counters restart', async () => {
    const { buffer } = await renderDocx(model(), { date: DATE });
    const numbering = part(buffer, 'word/numbering.xml');

    expect(numbering).toContain('w:numFmt w:val="decimal"');
    expect(numbering).toContain('w:numFmt w:val="bullet"');
  });

  it('reports the figure it had to drop instead of writing a manual that silently lost it', async () => {
    const broken = model(1);
    broken.steps[0]!.image = { absPath: join(dir, 'missing.png'), relPath: 'missing.png' };
    const { warnings, buffer } = await renderDocx(broken, { date: DATE });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('WITHOUT its figure');
    expect(part(buffer, 'word/document.xml')).not.toContain('<a:blip');
  });
});

describe('renderDocx -- page breaks', () => {
  /** Cover on 1, index on 1, then one page per step -- what the HTML now produces. */
  const breaks: PageBreakMap = {
    totalPages: 4,
    figures: {},
    pages: {
      'toc-title': 1, 'toc-row-1': 1, 'toc-row-2': 1, 'toc-row-3': 1, 'toc-row-4': 1,
      'step-1-head': 2, 'step-1-fig': 2,
      'step-2-head': 3,
      'step-3-head': 4,
      'step-4-head': 5,
    },
  };

  it('opens a page for every step, so a numbered heading never starts mid-page', async () => {
    const { buffer, measured } = await renderDocx(model(), { date: DATE, breaks });

    expect(measured).toBe(true);
    expect(headings(part(buffer, 'word/document.xml'))).toEqual([
      { text: '1. Pas 1', pageBreak: true },
      { text: '2. Pas 2', pageBreak: true },
      { text: '3. Pas 3', pageBreak: true },
      { text: '4. Pas 4', pageBreak: true },
    ]);
  });

  it('does the same without a measurement -- the rule does not depend on the browser', async () => {
    const { buffer, measured } = await renderDocx(model(), { date: DATE });

    expect(measured).toBe(false);
    expect(headings(part(buffer, 'word/document.xml')).map((h) => h.pageBreak)).toEqual([true, true, true, true]);
  });

  it('does NOT break before a first step that has nothing in front of it', async () => {
    // No cover and no index: a break here would open the document on a blank page.
    const { buffer } = await renderDocx(model(2), { date: DATE, cover: false, toc: false });

    expect(headings(part(buffer, 'word/document.xml')).map((h) => h.pageBreak)).toEqual([false, true]);
  });

  it('caches the measured page number in each index field so the index reads right unrefreshed', async () => {
    const { buffer } = await renderDocx(model(), { date: DATE, breaks });

    expect(tocFields(part(buffer, 'word/document.xml')))
      .toEqual({ 'step-1': '2', 'step-2': '3', 'step-3': '4', 'step-4': '5' });
  });

  it('leaves the index fields bare when nothing was measured, for Word to fill on F9', async () => {
    const { buffer } = await renderDocx(model(), { date: DATE });

    expect(tocFields(part(buffer, 'word/document.xml')))
      .toEqual({ 'step-1': '', 'step-2': '', 'step-3': '', 'step-4': '' });
  });

  it('embeds a figure at the size the browser settled on, not at its own computed scale', async () => {
    // The paginator shrinks a figure that misses its sheet by a little. Word has
    // to copy that exact size or the two outputs stop matching.
    const shrunk = { ...breaks, figures: { 'step-1-fig': { width: 500, height: 375 } } };
    const document = part((await renderDocx(model(), { date: DATE, breaks: shrunk })).buffer, 'word/document.xml');
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(document);

    // 9525 EMU per CSS pixel.
    expect(Number(extent?.[1])).toBe(500 * 9525);
    expect(Number(extent?.[2])).toBe(375 * 9525);
  });
});
