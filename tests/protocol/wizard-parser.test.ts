import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseControlTree } from '../../src/protocol/control-tree-parser.js';

function loadTree(filename: string): unknown {
  return JSON.parse(readFileSync(`tests/recordings/${filename}`, 'utf8'));
}

describe('parseControlTree — PageType enum', () => {
  it.each([
    [0, 'Card'],
    [1, 'List'],
    [2, 'RoleCenter'],
    [3, 'CardPart'],
    [4, 'ListPart'],
    [5, 'Document'],
    [6, 'Worksheet'],
    [7, 'ListPlus'],
    [8, 'ConfirmationDialog'],
    [9, 'NavigatePage'],
    [10, 'StandardDialog'],
    [11, 'API'],
    [12, 'HeadlinePart'],
    [22, 'UserControlHost'],
  ])('maps wire PageType %d to %s', (wire, name) => {
    const parsed = parseControlTree({ t: 'lf', PageType: wire, Children: [] });
    expect(parsed.pageType).toBe(name);
  });

  it('returns Unknown for missing or out-of-range PageType', () => {
    expect(parseControlTree({ t: 'lf', Children: [] }).pageType).toBe('Unknown');
    expect(parseControlTree({ t: 'lf', PageType: 999, Children: [] }).pageType).toBe('Unknown');
  });
});

describe('parseControlTree — wizard nav detection', () => {
  it('classifies icon paths into back/next/finish', () => {
    const tree = {
      t: 'lf',
      PageType: 9,
      Children: [
        { t: 'ac', Caption: 'Back', Icon: { Identifier: 'Actions/PreviousRecord/16.png' } },
        { t: 'ac', Caption: 'Next', Icon: { Identifier: 'Actions/NextRecord/16.png' } },
        { t: 'ac', Caption: 'Finish', Icon: { Identifier: 'Actions/Approve/16.png' } },
        { t: 'ac', Caption: 'Cancel', SystemAction: 320 },
      ],
    };
    const parsed = parseControlTree(tree);
    expect(parsed.actions.find(a => a.caption === 'Back')!.wizardNav).toBe('back');
    expect(parsed.actions.find(a => a.caption === 'Next')!.wizardNav).toBe('next');
    expect(parsed.actions.find(a => a.caption === 'Finish')!.wizardNav).toBe('finish');
    expect(parsed.actions.find(a => a.caption === 'Cancel')!.wizardNav).toBe('cancel');
  });

  it('classifies legacy Action_*_16x16.png icon paths', () => {
    const tree = {
      t: 'lf',
      PageType: 9,
      Children: [
        { t: 'ac', Caption: 'Back', Icon: { Identifier: 'Action_PreviousRecord_16x16.png' } },
        { t: 'ac', Caption: 'Next', Icon: { Identifier: 'Action_NextRecord_16x16.png' } },
        { t: 'ac', Caption: 'Finish', Icon: { Identifier: 'Action_Approve_16x16.png' } },
      ],
    };
    const parsed = parseControlTree(tree);
    expect(parsed.actions.find(a => a.caption === 'Back')!.wizardNav).toBe('back');
    expect(parsed.actions.find(a => a.caption === 'Next')!.wizardNav).toBe('next');
    expect(parsed.actions.find(a => a.caption === 'Finish')!.wizardNav).toBe('finish');
  });

  it('treats SystemAction Cancel(310) / Abort(320) / Close(350) as cancel', () => {
    const tree = {
      t: 'lf',
      PageType: 10,
      Children: [
        { t: 'ac', Caption: 'Cancel', SystemAction: 310 },
        { t: 'ac', Caption: 'Abort', SystemAction: 320 },
        { t: 'ac', Caption: 'Close', SystemAction: 350 },
      ],
    };
    const parsed = parseControlTree(tree);
    expect(parsed.actions.every(a => a.wizardNav === 'cancel')).toBe(true);
  });

  it('exposes the raw icon identifier for non-nav icons too', () => {
    const tree = {
      t: 'lf',
      PageType: 9,
      Children: [
        { t: 'ac', Caption: 'Refresh', Icon: { Identifier: 'Actions/Refresh/16.png' } },
      ],
    };
    const parsed = parseControlTree(tree);
    const a = parsed.actions[0]!;
    expect(a.iconIdentifier).toBe('Actions/Refresh/16.png');
    expect(a.wizardNav).toBeUndefined();
  });
});

describe('parseControlTree — Continia activation wizard (page 6175295)', () => {
  const tree = loadTree('cdo-wizard-page6175295-tree.json');
  const parsed = parseControlTree(tree);

  it('reports caption and NavigatePage type', () => {
    expect(parsed.caption).toBe('Set Up Document Output');
    expect(parsed.pageType).toBe('NavigatePage');
  });

  it('extracts Back, Next, Finish wizardNav actions from the actionbar', () => {
    const navs = parsed.actions
      .map(a => a.wizardNav)
      .filter((v): v is NonNullable<typeof v> => v !== undefined);
    expect(navs).toContain('back');
    expect(navs).toContain('next');
    expect(navs).toContain('finish');
    expect(navs).toContain('cancel');
  });
});
