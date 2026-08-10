import { describe, it, expect } from 'vitest';
import { renderMarkdown, pngSize, isPng, encodeMarkdownPath } from '../../src/services/manual-render.js';

/** A minimal but STRUCTURALLY REAL PNG head: signature + IHDR width/height. */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

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

describe('renderMarkdown -- image links', () => {
  it('percent-encodes spaces and parentheses so the link is not truncated', () => {
    const md = renderMarkdown({
      title: 'T',
      steps: [{ heading: 'S', image: { absPath: 'C:/a/b.png', relPath: 'my img (final)/step 1.png' } }],
    });
    expect(md).toContain('![S](my%20img%20%28final%29/step%201.png)');
    expect(md).not.toContain('(my img (final)');
  });

  it('normalises Windows separators and leaves a plain path untouched', () => {
    expect(encodeMarkdownPath('x-img\\step-1.png')).toBe('x-img/step-1.png');
    expect(encodeMarkdownPath('a#b?c.png')).toBe('a%23b%3Fc.png');
  });

  it('emits the caption as alt text plus an italic line under the figure', () => {
    const md = renderMarkdown({
      title: 'T',
      steps: [{ heading: 'S', image: { absPath: 'C:/a/b.png', relPath: 'i/1.png', caption: 'Customer card' } }],
    });
    expect(md).toContain('![Customer card](i/1.png)');
    expect(md).toContain('*Customer card*');
  });
});

describe('pngSize', () => {
  it('reads width/height from a PNG IHDR', () => {
    expect(pngSize(fakePng(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('reports UNKNOWN for a file that is not a PNG instead of reading garbage', () => {
    // A JPEG head: offsets 16/20 hold pixel data, not an IHDR.
    const jpeg = Buffer.alloc(24, 0x7f);
    jpeg.writeUInt16BE(0xffd8, 0);
    expect(isPng(jpeg)).toBe(false);
    expect(pngSize(jpeg)).toEqual({});
  });

  it('reports UNKNOWN for a truncated or zero-sized PNG', () => {
    expect(pngSize(Buffer.alloc(8))).toEqual({});
    expect(pngSize(fakePng(0, 0))).toEqual({});
  });
});
