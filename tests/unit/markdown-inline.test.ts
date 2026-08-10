import { describe, it, expect } from 'vitest';
import { escapeHtml, renderInline, renderBlocks, renderBlockList, parseBlocks, isFenceClose } from '../../src/services/markdown-inline.js';

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

  it('never applies inline formatting inside a link href', () => {
    // Underscores and asterisks are ordinary URL characters; emphasising them
    // used to inject <em> into the href and break the link.
    expect(renderInline('[doc](https://aesva.es/a_b_c)'))
      .toBe('<a href="https://aesva.es/a_b_c">doc</a>');
    expect(renderInline('see [x](https://aesva.es/a_b_c) and _this_'))
      .toBe('see <a href="https://aesva.es/a_b_c">x</a> and <em>this</em>');
  });

  it('still formats the link LABEL', () => {
    expect(renderInline('[**bold**](https://aesva.es/)'))
      .toBe('<a href="https://aesva.es/"><strong>bold</strong></a>');
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

describe('renderBlocks -- sub-headings', () => {
  it('renders ### as a sub-heading, with its inline formatting', () => {
    expect(renderBlocks('### Permisos: `Crear` y **Escritura**'))
      .toBe('<h3 class="md-sub">Permisos: <code>Crear</code> y <strong>Escritura</strong></h3>');
  });

  it('takes only its own line, so text right under it is still a paragraph', () => {
    expect(renderBlocks('### Titulo\nTexto pegado'))
      .toBe('<h3 class="md-sub">Titulo</h3><p>Texto pegado</p>');
  });

  it('treats #### and deeper the same: a manual has one level of sub-section', () => {
    expect(renderBlocks('#### Hondo')).toBe('<h3 class="md-sub">Hondo</h3>');
  });
});

describe('renderBlocks -- tables', () => {
  it('renders a GFM table as a real table, header apart from the body', () => {
    expect(renderBlocks('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(
      '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
  });

  it('formats inside the cells', () => {
    expect(renderBlocks('| a |\n|---|\n| **x** `y` |'))
      .toContain('<td><strong>x</strong> <code>y</code></td>');
  });

  it('reads the alignment off the delimiter row', () => {
    const html = renderBlocks('| l | c | r |\n|:---|:---:|---:|\n| 1 | 2 | 3 |');
    expect(html).toContain('<th>l</th><th class="a-center">c</th><th class="a-right">r</th>');
    expect(html).toContain('<td>1</td><td class="a-center">2</td><td class="a-right">3</td>');
  });

  it('pads a short row to the header width so the grid stays rectangular', () => {
    const [table] = parseBlocks('| a | b | c |\n|---|---|---|\n| 1 |');
    expect(table).toMatchObject({ kind: 'table' });
    expect(table && 'rows' in table ? table.rows[0] : []).toHaveLength(3);
  });

  it('keeps a pipe that is content: escaped, or inside an inline-code span', () => {
    const html = renderBlocks('| a | b |\n|---|---|\n| x \\| y | `p|q` |');
    // Two cells, not four: neither pipe was read as a separator.
    expect(html).toContain('<tbody><tr><td>x | y</td><td><code>p|q</code></td></tr></tbody>');
  });

  it('ends the table at the first line that is not a row, and keeps the rest as prose', () => {
    const blocks = parseBlocks('| a |\n|---|\n| 1 |\nplain text after');
    expect(blocks.map((b) => b.kind)).toEqual(['table', 'p']);
  });

  it('leaves a pipe row with no delimiter row as an ordinary paragraph', () => {
    // The delimiter is what distinguishes a table from prose that happens to
    // carry pipes; without it there is nothing to build a grid from.
    expect(parseBlocks('| a | b |\n| 1 | 2 |').map((b) => b.kind)).toEqual(['p']);
  });
});

describe('renderBlocks -- fenced code', () => {
  it('renders one element per line, verbatim and escaped', () => {
    expect(renderBlocks('```\nif (a < b) {\n  go();\n}\n```')).toBe(
      '<pre class="md-code"><code>'
      + '<span class="cl">if (a &lt; b) {</span><span class="cl">  go();</span><span class="cl">}</span>'
      + '</code></pre>',
    );
  });

  it('keeps the info string as data-lang', () => {
    expect(renderBlocks('```bash\nls\n```')).toContain('<pre class="md-code" data-lang="bash">');
  });

  it('keeps the blank lines INSIDE a block, which is why parsing is line-based', () => {
    const [block] = parseBlocks('```\na\n\nb\n```');
    expect(block).toEqual({ kind: 'code', lines: ['a', '', 'b'] });
  });

  it('does not format the content: a listing is not prose', () => {
    expect(renderBlocks('```\n**not bold** `not code`\n```'))
      .toContain('<span class="cl">**not bold** `not code`</span>');
  });

  it('accepts ~~~ so a block can contain backticks', () => {
    expect(renderBlocks('~~~\n```\n~~~')).toContain('<span class="cl">```</span>');
  });

  it('runs an unterminated fence to the end rather than losing the text', () => {
    expect(parseBlocks('```\nstill code')).toEqual([{ kind: 'code', lines: ['still code'] }]);
  });

  it('is one unit per block, so a long listing can be paginated', () => {
    expect(renderBlockList('para\n\n```\nx\n```\n\n| a |\n|---|\n| 1 |')).toHaveLength(3);
  });
});

describe('isFenceClose', () => {
  it('accepts a bare run of the opening marker', () => {
    expect(isFenceClose('```', '`')).toBe(true);
    expect(isFenceClose('   ~~~~  ', '~')).toBe(true);
  });

  it('rejects a line carrying an info string', () => {
    // CommonMark: a closing fence has no info string. `manual-source.ts` applies
    // this same helper, so a listing that shows Markdown reads identically on
    // both sides instead of ending early on one of them.
    expect(isFenceClose('```markdown', '`')).toBe(false);
  });

  it('rejects the other marker, so ``` cannot close a ~~~ block', () => {
    expect(isFenceClose('```', '~')).toBe(false);
    expect(isFenceClose('~~~', '`')).toBe(false);
  });

  it('rejects a run shorter than three', () => {
    expect(isFenceClose('``', '`')).toBe(false);
  });
});
