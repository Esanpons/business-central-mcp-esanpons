import { describe, it, expect } from 'vitest';
import { escapeHtml, renderInline, renderBlocks } from '../../src/services/markdown-inline.js';

describe('escapeHtml', () => {
  it('escapes the five markup-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('renderInline', () => {
  it('renders bold, italic, code and links', () => {
    expect(renderInline('**bold**')).toBe('<strong>bold</strong>');
    expect(renderInline('say *this* now')).toBe('say <em>this</em> now');
    expect(renderInline('use _that_')).toBe('use <em>that</em>');
    expect(renderInline('press `Ctrl+P`')).toBe('press <code>Ctrl+P</code>');
    expect(renderInline('[docs](https://aesva.es/a?b=1)')).toBe('<a href="https://aesva.es/a?b=1">docs</a>');
  });

  it('escapes before formatting so prose can never inject markup', () => {
    expect(renderInline('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    // Inside a code span the content is escaped and left unformatted.
    expect(renderInline('`<b>**x**</b>`')).toBe('<code>&lt;b&gt;**x**&lt;/b&gt;</code>');
  });

  it('leaves a non-http link target as plain text', () => {
    expect(renderInline('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });
});

describe('renderBlocks', () => {
  it('splits blank-line separated paragraphs', () => {
    expect(renderBlocks('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
  });

  it('joins soft-wrapped lines into a single paragraph', () => {
    expect(renderBlocks('one\ntwo')).toBe('<p>one two</p>');
  });

  it('renders bullet and ordered lists', () => {
    expect(renderBlocks('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderBlocks('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('renders a quoted block as a note', () => {
    expect(renderBlocks('> heads up\n> really')).toBe('<blockquote>heads up really</blockquote>');
  });
});
