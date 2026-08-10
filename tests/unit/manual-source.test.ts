import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManualSource, formatDiagnostics } from '../../src/services/manual-source.js';
import { renderMarkdown, type ManualModel } from '../../src/services/manual-render.js';
import { parseBlocks } from '../../src/services/markdown-inline.js';

let dir: string;
let png: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-manual-src-'));
  mkdirSync(join(dir, 'img'), { recursive: true });
  png = join(dir, 'img', 'step-1.png');
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(1600, 16);
  buf.writeUInt32BE(1200, 20);
  writeFileSync(png, buf);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Writes a source document and parses it back, with the output next to it. */
function parse(md: string, name = 'manual.md') {
  const file = join(dir, name);
  writeFileSync(file, md, 'utf8');
  return parseManualSource({ file, outDir: dir });
}

const FULL = `---
lang: es
cover: false
toc: true
---

# Gestion de clientes

Introduccion con **negrita**.

> Una nota.

## 1. Abre la lista

Prosa encima de la figura.

- primer punto
- segundo punto

![Lista](img/step-1.png)
*Pie de figura*

Prosa debajo de la figura.

## 2. Un paso sin figura

Solo texto.
`;

describe('parseManualSource -- the documented format', () => {
  it('reads title, intro, steps, figure, caption and the prose on each side of it', () => {
    const { model, diagnostics } = parse(FULL);

    expect(formatDiagnostics(diagnostics)).toEqual([]);
    expect(model?.title).toBe('Gestion de clientes');
    expect(model?.intro).toBe('Introduccion con **negrita**.\n\n> Una nota.');
    expect(model?.steps).toHaveLength(2);

    const [one, two] = model!.steps;
    expect(one?.heading).toBe('Abre la lista');
    expect(one?.body).toBe('Prosa encima de la figura.\n\n- primer punto\n- segundo punto');
    expect(one?.after).toBe('Prosa debajo de la figura.');
    expect(one?.image?.absPath).toBe(png);
    expect(one?.image?.caption).toBe('Pie de figura');
    // The intrinsic size is read from the PNG, so the layout is measurable.
    expect(one?.image?.width).toBe(1600);
    expect(two?.image).toBeUndefined();
  });

  it('reads the build settings out of the front matter', () => {
    expect(parse(FULL).options).toEqual({ lang: 'es', cover: false, toc: true });
  });

  it('accepts a step heading with or without its number', () => {
    const { model } = parse('# T\n\n## 1. Numerado\n\nx\n\n## Sin numerar\n\ny\n');
    expect(model?.steps.map((s) => s.heading)).toEqual(['Numerado', 'Sin numerar']);
  });

  it('treats an italic line as a caption only right after a figure', () => {
    const { model } = parse(`# T\n\n## Paso\n\n*Esto es prosa en cursiva, no un pie.*\n\n![a](img/step-1.png)\n\n*Pie*\n`);
    expect(model?.steps[0]?.body).toBe('*Esto es prosa en cursiva, no un pie.*');
    expect(model?.steps[0]?.image?.caption).toBe('Pie');
  });
});

describe('parseManualSource -- round trip', () => {
  it('re-renders to a byte-identical document, which is what makes the generator the spec', () => {
    const model: ManualModel = {
      title: 'Com crear un client',
      intro: 'Guia **curta**.\n\n> Compte.',
      steps: [
        {
          heading: 'Obre la llista',
          body: 'Fes aixo.\n\n- un\n- dos',
          image: { absPath: png, relPath: 'img/step-1.png', width: 1600, height: 1200, caption: 'La llista' },
          after: 'Comprova el resultat.',
        },
        { heading: 'Un pas sense figura', body: 'Nomes text.' },
      ],
    };

    const md = renderMarkdown(model);
    writeFileSync(join(dir, 'round.md'), md, 'utf8');
    const parsed = parseManualSource({ file: join(dir, 'round.md'), outDir: dir });

    expect(formatDiagnostics(parsed.diagnostics)).toEqual([]);
    expect(renderMarkdown(parsed.model!)).toBe(md);
  });
});

describe('parseManualSource -- diagnostics', () => {
  it('refuses a document with no title and no steps, naming both', () => {
    const { model, diagnostics } = parse('Just some prose.\n');

    expect(model).toBeUndefined();
    expect(formatDiagnostics(diagnostics)).toEqual([
      'file: error: no "# " title line — the first heading of the file is the manual title',
      'file: error: no "## " steps — every manual needs at least one',
    ]);
  });

  it('points at a missing image by line and builds nothing', () => {
    const { model, diagnostics } = parse('# T\n\n## Paso\n\n![a](img/ausente.png)\n');

    expect(model).toBeUndefined();
    expect(diagnostics[0]?.line).toBe(5);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.message).toContain('does not exist');
  });

  it('reports EVERY problem in one pass, in reading order', () => {
    const { diagnostics } = parse(`---
color: azul
---

# T

## Paso

| a | b |
| 1 | 2 |

### Sub

\`\`\`bash
x
`);
    // One pass must be enough to fix the file: an author should never have to
    // rebuild just to discover the next problem.
    expect(diagnostics.map((d) => d.line)).toEqual([2, 9, 14]);
    expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    expect(diagnostics.map((d) => d.message.split(' —')[0])).toEqual([
      'unknown front matter key "color", ignored',
      'table without a delimiter row',
      'code fence is never closed',
    ]);
  });

  it('accepts a sub-heading inside a step: it is a sub-section, not a broken step', () => {
    const { model, diagnostics } = parse('# T\n\n## Paso\n\n### Sub\n\nTexto.\n');
    expect(formatDiagnostics(diagnostics)).toEqual([]);
    expect(model?.steps).toHaveLength(1);
    expect(model?.steps[0]?.body).toBe('### Sub\n\nTexto.');
  });

  it('accepts a table and a fenced code block without a word of complaint', () => {
    const { model, diagnostics } = parse(`# T

## Paso

| Campo | Valor |
|---|---|
| TLS | 1.2 |

\`\`\`bash
az group create --name rg
\`\`\`
`);
    expect(formatDiagnostics(diagnostics)).toEqual([]);
    // The model keeps the prose verbatim; the renderers parse it.
    expect(model?.steps[0]?.body).toContain('| TLS | 1.2 |');
    expect(model?.steps[0]?.body).toContain('az group create --name rg');
  });

  it('treats a step heading, an image and a caption INSIDE a fence as code', () => {
    // A manual that documents this very format has all three in a listing. Read
    // as structure they would cut the document into pieces the author never wrote.
    const { model, diagnostics } = parse(`# T

## Un solo paso

\`\`\`markdown
## No soy un paso

![tampoco](img/ausente.png)
*ni un pie*
\`\`\`

Texto final.
`);
    expect(formatDiagnostics(diagnostics)).toEqual([]);
    expect(model?.steps).toHaveLength(1);
    expect(model?.steps[0]?.image).toBeUndefined();
    expect(model?.steps[0]?.body).toContain('## No soy un paso');
    expect(model?.steps[0]?.body?.endsWith('Texto final.')).toBe(true);
  });

  it('closes a fence by the SAME rule the renderer uses, so the two never disagree', () => {
    // A line carrying an info string opens a fence but never closes one. Reading
    // it as a close here while the renderer reads on is the worst kind of bug:
    // the reader starts seeing structure inside a listing, the renderer keeps
    // swallowing prose into it, and nothing is reported. So this document has an
    // UNCLOSED fence, and that is what must be said.
    const { model, diagnostics } = parse(`# T

## Un paso

\`\`\`markdown
## No soy un paso
\`\`\`markdown

Texto que el renderizador seguiria tragandose.
`);
    expect(model?.steps).toHaveLength(1);
    expect(formatDiagnostics(diagnostics)).toEqual([
      'line 5: warning: code fence is never closed — everything below it is treated as code',
    ]);
    // Both parsers agree the block runs on, so nothing is silently reinterpreted.
    expect(parseBlocks(model!.steps[0]!.body!).map((b) => b.kind)).toEqual(['code']);
  });

  it('warns instead of failing when a step carries a second figure, and keeps the first', () => {
    const { model, diagnostics } = parse('# T\n\n## Paso\n\n![a](img/step-1.png)\n\n![b](img/step-1.png)\n');

    expect(model?.steps[0]?.image?.absPath).toBe(png);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe('warning');
    expect(diagnostics[0]?.message).toContain('split the step in two');
  });

  it('rejects a remote image rather than silently omitting the figure', () => {
    const { model, diagnostics } = parse('# T\n\n## Paso\n\n![a](https://example.com/x.png)\n');

    expect(model).toBeUndefined();
    expect(diagnostics[0]?.message).toContain('only files on disk');
  });

  it('reports unterminated front matter instead of eating the document', () => {
    const { diagnostics } = parse('---\nlang: ca\n\n# T\n\n## P\n\nx\n');
    expect(formatDiagnostics(diagnostics)[0]).toContain('never closed');
  });
});
