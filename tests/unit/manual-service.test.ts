import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { ManualService } from '../../src/services/manual-service.js';
import type { ScreenshotService } from '../../src/services/screenshot-service.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
// Steps that reference an existing PNG never reach the capture engine.
const noCapture = { capture: () => { throw new Error('should not capture'); } } as unknown as ScreenshotService;

let dir: string;
let png: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-manual-svc-'));
  png = resolve(dir, 'shot.png');
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(800, 16);
  buf.writeUInt32BE(600, 20);
  writeFileSync(png, buf);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function service() {
  return new ManualService(noCapture, dir, logger);
}

const steps = [{ heading: 'Obre la llista', body: 'Cerca **Clients**.', image: 'shot.png' }];

describe('ManualService.build -- format selection', () => {
  it('defaults to Markdown only', async () => {
    const out = await service().build({ title: 'Manual de prova', name: 'prova', steps });
    expect(basename(out.md!)).toBe('prova.md');
    expect(out.html).toBeUndefined();
    expect(readFileSync(out.md!, 'utf8')).toContain('# Manual de prova');
  });

  it('writes the A4 page when html is requested', async () => {
    const out = await service().build({ title: 'Manual de prova', name: 'prova', steps, formats: ['html'] });
    expect(out.md).toBeUndefined();
    expect(basename(out.html!)).toBe('prova.html');
    const html = readFileSync(out.html!, 'utf8');
    expect(html).toContain('<template id="sheet-tpl">');
    expect(html).toContain('Cerca <strong>Clients</strong>.');
  });

  it('writes both when both are requested', async () => {
    const out = await service().build({ title: 'Manual', name: 'dos', steps, formats: ['md', 'html'] });
    expect(existsSync(out.md!)).toBe(true);
    expect(existsSync(out.html!)).toBe(true);
  });
});

describe('ManualService.build -- assets', () => {
  it('inline (default) keeps everything in the single .html', async () => {
    const out = await service().build({ title: 'M', name: 'inline', steps, formats: ['html'] });
    expect(out.css).toBeUndefined();
    expect(out.js).toBeUndefined();
    expect(readFileSync(out.html!, 'utf8')).toContain('src="data:image/png;base64,');
  });

  it('files mode writes a sibling .css and .js named after the slug', async () => {
    const out = await service().build({ title: 'M', name: 'sep', steps, formats: ['html'], assets: 'files' });
    expect(basename(out.css!)).toBe('sep.css');
    expect(basename(out.js!)).toBe('sep.js');
    expect(existsSync(out.css!)).toBe(true);
    expect(existsSync(out.js!)).toBe(true);
    const html = readFileSync(out.html!, 'utf8');
    expect(html).toContain('href="sep.css"');
    expect(html).toContain('src="sep.js"');
    expect(html).toContain('src="shot.png"');
  });
});

describe('ManualService.build -- step handling', () => {
  it('renders a step without an image when the referenced file is missing', async () => {
    const out = await service().build({
      title: 'M', name: 'miss', formats: ['md', 'html'],
      steps: [{ heading: 'Sense imatge', image: 'no-existeix.png' }],
    });
    expect(out.steps).toBe(1);
    expect(readFileSync(out.md!, 'utf8')).not.toContain('![');
    // Match the emitted element, not the ".step-fig" rule in the stylesheet.
    expect(readFileSync(out.html!, 'utf8')).not.toContain('class="unit step-fig"');
  });

  it('passes the html-only options through to the renderer', async () => {
    const out = await service().build({
      title: 'M', name: 'opts', steps, formats: ['html'], lang: 'en', cover: false, toc: true,
    });
    const html = readFileSync(out.html!, 'utf8');
    expect(html).toContain('User manual');
    expect(html).not.toContain('class="sheet cover" data-cover');
    expect(html).toContain('class="unit toc-row"');
  });
});
