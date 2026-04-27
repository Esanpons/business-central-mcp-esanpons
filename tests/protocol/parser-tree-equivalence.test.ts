// tests/protocol/parser-tree-equivalence.test.ts
//
// Verifies the new tree builder produces views (fields, actions, repeaters,
// tabs, groupVisibility) equivalent to the existing parseControlTree output
// across every fixture in tests/recordings/. This is the cut-over guard:
// once it passes for every fixture, we can drop the legacy parser.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseControlTree } from '../../src/protocol/control-tree-parser.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { fields, actions, repeaters, tabs, groupVisibility, filterControlPath } from '../../src/protocol/form-views.js';

const FIXTURES = [
  { name: 'Customer Card (page 21)', path: 'tests/recordings/page21-control-tree.json', extract: (raw: any) => raw.formCreatedEvents[0].controlTree },
  { name: 'Customer List (page 22)', path: 'tests/recordings/page22-control-tree.json', extract: (raw: any) => raw.formCreatedEvents[0].controlTree },
  { name: 'Continia wizard (page 6175295)', path: 'tests/recordings/cdo-wizard-page6175295-tree.json', extract: (raw: any) => raw },
];

for (const fx of FIXTURES) {
  describe(`parser equivalence — ${fx.name}`, () => {
    const raw = JSON.parse(readFileSync(fx.path, 'utf8'));
    const tree = fx.extract(raw);
    const legacy = parseControlTree(tree);
    const root = buildFormTree(tree);

    it('field captions match (in document order)', () => {
      const legacyCaptions = legacy.fields.map(f => f.caption);
      const treeCaptions = fields(root).map(f => f.properties.caption ?? '');
      expect(treeCaptions).toEqual(legacyCaptions);
    });

    it('field controlPaths match', () => {
      expect(fields(root).map(f => f.controlPath)).toEqual(legacy.fields.map(f => f.controlPath));
    });

    it('action captions match', () => {
      expect(actions(root).map(a => a.properties.caption ?? '')).toEqual(legacy.actions.map(a => a.caption));
    });

    it('repeater controlPaths match', () => {
      expect([...repeaters(root).keys()].sort()).toEqual([...legacy.repeaters.keys()].sort());
    });

    it('tab captions match', () => {
      const legacyTabs = (legacy.tabs ?? []).map(t => t.caption);
      const treeTabs = tabs(root).map(t => t.caption);
      expect(treeTabs).toEqual(legacyTabs);
    });

    it('groupVisibility paths match', () => {
      expect([...groupVisibility(root).keys()].sort()).toEqual([...legacy.groupVisibility.keys()].sort());
    });

    it('filterControlPath matches', () => {
      expect(filterControlPath(root)).toEqual(legacy.filterControlPath);
    });
  });
}
