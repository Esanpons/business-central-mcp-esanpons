import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderHtml, pngSize } from '../../src/services/manual-render.js';

const model = {
  title: 'How to X',
  intro: 'Intro paragraph.',
  steps: [
    { heading: 'First step', body: 'Do this.', image: { absPath: 'C:/a/step-1.png', relPath: 'x-img/step-1.png', width: 10, height: 10 } },
    { heading: 'Second step' },
  ],
};

describe('renderMarkdown', () => {
  it('renders title, intro, numbered steps and relative image links', () => {
    const md = renderMarkdown(model);
    expect(md).toContain('# How to X');
    expect(md).toContain('Intro paragraph.');
    expect(md).toContain('## 1. First step');
    expect(md).toContain('Do this.');
    expect(md).toContain('![First step](x-img/step-1.png)');
    expect(md).toContain('## 2. Second step');
  });
});

describe('renderHtml', () => {
  it('escapes text and produces a full HTML document', () => {
    const html = renderHtml({ title: 'A & B', steps: [{ heading: '<x>' }] });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('1. &lt;x&gt;');
  });
});

describe('pngSize', () => {
  it('reads width/height from a PNG IHDR', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(640, 16);
    buf.writeUInt32BE(480, 20);
    expect(pngSize(buf)).toEqual({ width: 640, height: 480 });
  });
});
