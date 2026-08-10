import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderHtmlDocument } from '../../src/services/manual-html.js';
import type { ManualModel } from '../../src/services/manual-render.js';

let dir: string;
let png: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-manual-html-'));
  png = join(dir, 'step-1.png');
  // 24 bytes is enough: only the IHDR is ever parsed, the rest is base64'd as-is.
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(800, 16);
  buf.writeUInt32BE(600, 20);
  writeFileSync(png, buf);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function model(steps = 2): ManualModel {
  return {
    title: 'Com crear un client',
    intro: 'Guia **curta**.',
    steps: Array.from({ length: steps }, (_, i) => ({
      heading: `Pas ${i + 1}`,
      body: i === 0 ? 'Fes aixo.\n\n- un\n- dos' : undefined,
      image: i === 0 ? { absPath: png, relPath: 'x-img/step-1.png', width: 800, height: 600 } : undefined,
    })),
  };
}

const DATE = new Date(Date.UTC(2026, 6, 31));

describe('renderHtmlDocument -- document shape', () => {
  it('emits an A4 sheet template, an empty target and the paginator', () => {
    const { html } = renderHtmlDocument(model(), { date: DATE });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<div id="doc" class="doc"></div>');
    expect(html).toContain('<template id="sheet-tpl">');
    expect(html).toContain('class="sheet-body"');
    expect(html).toContain('data-paginated');           // from the bundled paginator
    expect(html).toContain('@page { size: A4; margin: 0; }');
  });

  it('groups a step heading with its figure so they are never split', () => {
    const { html } = renderHtmlDocument(model(), { date: DATE });
    expect(html).toContain('class="unit step-head" data-unit data-uid="step-1-head" data-group="step-1" data-anchor="step-1"');
    expect(html).toContain('class="unit step-fig" data-unit data-uid="step-1-fig" data-group="step-1"');
  });

  it('emits a table and a listing as their own units, each splittable by the paginator', () => {
    const m = model(1);
    m.steps[0]!.body = 'Text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nls -la\n```';
    const { html } = renderHtmlDocument(m, { date: DATE });

    // One unit per block: a table or a listing longer than a sheet has to be
    // measurable on its own before the paginator can cut it.
    expect(html).toContain('data-uid="step-1-b2"');
    expect(html).toContain('data-uid="step-1-b3"');
    // The rows and the lines are real child ELEMENTS -- that is what gets moved
    // to the next sheet.
    expect(html).toContain('<tbody><tr><td>1</td><td>2</td></tr></tbody>');
    expect(html).toContain('<span class="cl">ls -la</span>');
    expect(html).toContain('.md-table');            // the stylesheet travels with it
  });

  it('gives every unit a stable id, which is what the Word export maps its page breaks to', () => {
    const { html } = renderHtmlDocument(model(4), { date: DATE });
    const uids = [...html.matchAll(/data-uid="([^"]+)"/g)].map((m) => m[1]);

    expect(uids).toContain('toc-title');
    expect(uids).toContain('toc-row-4');
    expect(uids).toContain('step-1-head');
    expect(uids).toContain('step-1-fig');
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('renders step prose through the Markdown converter', () => {
    const { html } = renderHtmlDocument(model(), { date: DATE });
    expect(html).toContain('<p>Fes aixo.</p>');
    expect(html).toContain('<ul><li>un</li><li>dos</li></ul>');
    expect(html).toContain('Guia <strong>curta</strong>.');
  });

  it('splits prose into one unit per block, keeping the first with the heading', () => {
    const { html } = renderHtmlDocument(model(), { date: DATE });

    // The lead paragraph rides with the heading: placing a group unit by unit
    // would otherwise leave the heading alone at the foot of a sheet.
    expect(html).toMatch(/data-uid="step-1-head"[^>]*>.*?<h2>.*?<p>Fes aixo\.<\/p>/s);
    // Every later block is measurable on its own, so a long body can flow.
    expect(html).toContain('data-uid="step-1-b2"');
  });

  it('renders prose below the figure as its own units, still grouped with the step', () => {
    const m = model();
    m.steps[0]!.after = 'Comprova el resultat.\n\n- primer\n- segon';
    const { html } = renderHtmlDocument(m, { date: DATE });

    expect(html).toContain('data-uid="step-1-a1" data-group="step-1"');
    expect(html).toContain('data-uid="step-1-a2" data-group="step-1"');
    // Order matters: the figure comes before the text that comments on it.
    expect(html.indexOf('data-uid="step-1-fig"')).toBeLessThan(html.indexOf('data-uid="step-1-a1"'));
  });

  it('escapes the title everywhere it is interpolated', () => {
    const m = { ...model(1), title: 'A & <b>B</b>' };
    const { html } = renderHtmlDocument(m, { date: DATE });
    expect(html).toContain('A &amp; &lt;b&gt;B&lt;/b&gt;');
    expect(html).not.toContain('<b>B</b>');
  });
});

describe('renderHtmlDocument -- cover and index', () => {
  it('puts the title, intro and date on a cover sheet by default', () => {
    const { html } = renderHtmlDocument(model(), { date: DATE, lang: 'ca' });
    expect(html).toContain('class="sheet cover" data-cover');
    expect(html).toContain("Manual d&#39;usuari");
    expect(html).toContain('31');            // localized date, day is stable across locales
  });

  it('omits the index below four steps and emits it from four up', () => {
    // Match the emitted element, not the ".toc-row" selector inside the paginator.
    expect(renderHtmlDocument(model(3), { date: DATE }).html).not.toContain('class="unit toc-row"');
    const big = renderHtmlDocument(model(4), { date: DATE }).html;
    expect(big).toContain('class="unit toc-row"');
    expect(big).toContain('data-target="step-4"');
  });

  it('links every index row to the anchor the paginator resolves to a page number', () => {
    const { html } = renderHtmlDocument(model(4), { date: DATE, toc: true });
    for (let i = 1; i <= 4; i++) {
      expect(html).toContain(`data-target="step-${i}"`);
      expect(html).toContain(`data-anchor="step-${i}"`);
    }
    expect(html).toContain('<span class="t-page"></span>');
  });

  it('honors cover:false and toc:true overrides', () => {
    const { html } = renderHtmlDocument(model(2), { date: DATE, cover: false, toc: true });
    expect(html).not.toContain('class="sheet cover" data-cover');
    expect(html).toContain('class="unit toc-row"');
  });

  it('switches the chrome language and falls back to English', () => {
    expect(renderHtmlDocument(model(), { date: DATE, lang: 'es' }).html).toContain('Manual de usuario');
    expect(renderHtmlDocument(model(), { date: DATE, lang: 'en' }).html).toContain('User manual');
    expect(renderHtmlDocument(model(), { date: DATE, lang: 'de' }).html).toContain('User manual');
  });
});

describe('renderHtmlDocument -- assets', () => {
  it('inline (default) produces one self-contained file with embedded images', () => {
    const res = renderHtmlDocument(model(), { date: DATE });
    expect(res.css).toBeUndefined();
    expect(res.js).toBeUndefined();
    expect(res.html).toContain('<style>');
    expect(res.html).toContain('src="data:image/png;base64,');
    expect(res.html).not.toContain('<link rel="stylesheet"');
  });

  it('files mode links external assets and the PNG by relative path', () => {
    const res = renderHtmlDocument(model(), { date: DATE, assets: 'files', assetBase: 'crear-client' });
    expect(res.css).toContain('--sheet-h');
    expect(res.js).toContain('function paginate');
    expect(res.html).toContain('<link rel="stylesheet" href="crear-client.css">');
    expect(res.html).toContain('<script src="crear-client.js"></script>');
    expect(res.html).toContain('src="x-img/step-1.png"');
    expect(res.html).not.toContain('data:image/png;base64,');
  });

  it('carries the intrinsic PNG size so the layout is stable before decode', () => {
    const { html } = renderHtmlDocument(model(), { date: DATE });
    expect(html).toContain('width="800" height="600"');
  });
});
