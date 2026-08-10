import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { ManualService } from '../../src/services/manual-service.js';
import type { ScreenshotService, CaptureResult, CaptureInput } from '../../src/services/screenshot-service.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
// Steps that reference an existing PNG never reach the capture engine — and must
// never even LAUNCH one (opening a session costs a full browser start).
const noCapture = {
  capture: () => { throw new Error('should not capture'); },
  openSession: () => { throw new Error('should not launch a browser'); },
} as unknown as ScreenshotService;

/** A minimal but structurally real PNG head (signature + IHDR). */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/**
 * A screenshot service that writes a PNG for every step and reports the given
 * diagnostics, so the manual builder's handling of them can be tested without a
 * browser. `sessions` counts how many browsers a build would have launched.
 */
function fakeScreenshots(result?: Partial<CaptureResult>): {
  service: ScreenshotService; sessions: () => number; captures: () => CaptureInput[];
} {
  let sessions = 0;
  const captures: CaptureInput[] = [];
  const capture = async (input: CaptureInput): Promise<CaptureResult> => {
    captures.push(input);
    writeFileSync(input.out!, fakePng(400, 300));
    return {
      path: input.out!, url: 'u', pageTitle: 't', authenticated: true, spaReady: true,
      width: 1600, height: 1000, ...result,
    };
  };
  const service = {
    capture,
    openSession: async () => {
      sessions++;
      return { capture, close: async () => undefined };
    },
  } as unknown as ScreenshotService;
  return { service, sessions: () => sessions, captures: () => captures };
}

let dir: string;
let png: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-manual-svc-'));
  png = resolve(dir, 'shot.png');
  writeFileSync(png, fakePng(800, 600));
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

  it('lists a referenced image in the images output', async () => {
    const out = await service().build({ title: 'M', name: 'refs', steps });
    expect(out.images).toEqual([png]);
  });

  it('warns (and omits the figure) when the referenced image does not exist', async () => {
    const out = await service().build({
      title: 'M', name: 'miss2', steps: [{ heading: 'Sense imatge', image: 'no-existeix.png' }],
    });
    expect(out.images).toEqual([]);
    expect(out.warnings?.join('\n')).toMatch(/no-existeix\.png.*does not exist/s);
  });

  it('renders a figure caption in both outputs', async () => {
    const out = await service().build({
      title: 'M', name: 'cap', formats: ['md', 'html'],
      steps: [{ heading: 'Pas', image: 'shot.png', caption: 'Fitxa del client' }],
    });
    expect(readFileSync(out.md!, 'utf8')).toContain('*Fitxa del client*');
    expect(readFileSync(out.html!, 'utf8')).toContain('<figcaption>Fitxa del client</figcaption>');
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

  it('survives a structurally invalid lang instead of failing after every capture', async () => {
    // "ca_ES" is what people type; Intl throws RangeError on the underscore form.
    const out = await service().build({ title: 'M', name: 'lang', steps, formats: ['html'], lang: 'ca_ES' });
    // The Catalan chrome (not the English fallback) — apostrophe is HTML-escaped.
    expect(readFileSync(out.html!, 'utf8')).toContain('Manual d&#39;usuari');
    const bad = await service().build({ title: 'M', name: 'lang2', steps, formats: ['html'], lang: 'not a language' });
    expect(existsSync(bad.html!)).toBe(true);
  });
});

describe('ManualService.build -- capture diagnostics (never trust success alone)', () => {
  const shot = [{ heading: 'Obre la fitxa', screenshot: { pageId: 21 } }];

  it('opens ONE browser session for a multi-step capture build', async () => {
    const f = fakeScreenshots();
    const out = await new ManualService(f.service, dir, logger).build({
      title: 'M', name: 'perf',
      steps: [
        { heading: 'A', screenshot: { pageId: 21 } },
        { heading: 'B', screenshot: { pageId: 22 } },
        { heading: 'C', screenshot: { pageId: 23 } },
      ],
    });
    expect(out.steps).toBe(3);
    expect(f.sessions()).toBe(1);
    expect(out.images).toHaveLength(3);
  });

  it('reports a failed redaction so the step can be re-shot', async () => {
    const f = fakeScreenshots({
      redactions: [{ target: 'IBAN', found: false }],
      warning: 'REDACTION FAILED: [IBAN] matched no control',
    });
    const out = await new ManualService(f.service, dir, logger).build({ title: 'M', name: 'redact', steps: shot });
    expect(out.warnings?.join('\n')).toMatch(/REDACTION FAILED/);
    expect(out.warnings?.join('\n')).toMatch(/Step 1 \("Obre la fitxa"\)/);
  });

  it('reports highlight captions that matched nothing', async () => {
    const f = fakeScreenshots({ annotations: [{ target: 'Nom', found: false }, { target: 'Ciutat', found: true }] });
    const out = await new ManualService(f.service, dir, logger).build({ title: 'M', name: 'hl', steps: shot });
    expect(out.warnings?.join('\n')).toMatch(/\[Nom\]/);
    expect(out.warnings?.join('\n')).not.toMatch(/Ciutat/);
  });

  it('reports a page that never finished loading', async () => {
    const f = fakeScreenshots({ spaReady: false });
    const out = await new ManualService(f.service, dir, logger).build({ title: 'M', name: 'slow', steps: shot });
    expect(out.warnings?.join('\n')).toMatch(/spaReady=false/);
  });

  it('omits warnings entirely when every capture was clean', async () => {
    const f = fakeScreenshots({ annotations: [{ target: 'Nom', found: true }] });
    const out = await new ManualService(f.service, dir, logger).build({ title: 'M', name: 'clean', steps: shot });
    expect(out.warnings).toBeUndefined();
  });

  it('forwards clickBeforeCapture to the capture engine', async () => {
    const f = fakeScreenshots();
    await new ManualService(f.service, dir, logger).build({
      title: 'M', name: 'click',
      steps: [{ heading: 'Linies', screenshot: { pageId: 42, clickBeforeCapture: ['Lines'] } }],
    });
    expect(f.captures()[0]?.clickBeforeCapture).toEqual(['Lines']);
  });
});
