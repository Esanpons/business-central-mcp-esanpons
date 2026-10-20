import { describe, it, expect } from 'vitest';
import { detectChangedSections, detectDialogs, detectMessages, classifyDialog } from '../../src/protocol/mutation-result.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeCtx(overrides: Partial<PageContext> = {}): PageContext {
  return {
    pageContextId: 'ctx:1',
    rootFormId: 'root',
    pageType: 'Document',
    caption: 'Test',
    forms: new Map(),
    sections: new Map([
      ['header', { sectionId: 'header', kind: 'header' as const, caption: 'Header', formId: 'root', valid: true }],
      ['lines', { sectionId: 'lines', kind: 'lines' as const, caption: 'Lines', formId: 'child1', valid: true }],
      ['factbox:stats', { sectionId: 'factbox:stats', kind: 'factbox' as const, caption: 'Stats', formId: 'child2', valid: true }],
    ]),
    dialogs: [],
    ownedFormIds: ['root', 'child1', 'child2'],
    ...overrides,
  };
}

describe('detectChangedSections', () => {
  it('detects sections by event formId', () => {
    const ctx = makeCtx();
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'child1', controlPath: 'c[0]', changes: { StringValue: 'x' } },
    ];
    const changed = detectChangedSections(ctx, events);
    expect(changed).toContain('lines');
    expect(changed).not.toContain('header');
    expect(changed).not.toContain('factbox:stats');
  });

  it('includes all sections when root formId is in events (cascade)', () => {
    const ctx = makeCtx();
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'root', controlPath: 'c[0]', changes: {} },
    ];
    const changed = detectChangedSections(ctx, events);
    expect(changed).toContain('header');
    expect(changed).toContain('lines');
    expect(changed).toContain('factbox:stats');
  });

  it('returns empty for InvokeCompleted-only events (no formId)', () => {
    const ctx = makeCtx();
    const events: BCEvent[] = [
      { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
    ];
    const changed = detectChangedSections(ctx, events);
    expect(changed).toEqual([]);
  });

  it('deduplicates when multiple events target same section', () => {
    const ctx = makeCtx();
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'child1', controlPath: 'c[0]', changes: {} },
      { type: 'PropertyChanged', formId: 'child1', controlPath: 'c[1]', changes: {} },
    ];
    const changed = detectChangedSections(ctx, events);
    expect(changed.filter(s => s === 'lines')).toHaveLength(1);
  });
});

describe('detectDialogs', () => {
  it('extracts dialog info from DialogOpened events', () => {
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'dlg1', ownerFormId: 'root', controlTree: { Caption: 'Save changes?' } },
      { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.formId).toBe('dlg1');
    expect(dialogs[0]!.message).toBe('Save changes?');
  });

  it('returns empty when no dialogs', () => {
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'f1', controlPath: 'c[0]', changes: {} },
    ];
    expect(detectDialogs(events)).toHaveLength(0);
  });

  it('handles dialog with no caption', () => {
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'dlg2', controlTree: {} },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.message).toBeUndefined();
  });

  it('parses dialog control tree fields (e.g. Copy Document dialog)', () => {
    const controlTree = {
      Caption: 'Copy Sales Document',
      Children: [
        {
          t: 'gc',
          Children: [
            {
              t: 'sc',
              Caption: 'Document Type',
              Editable: true,
              Visible: true,
              StringValue: 'Quote',
              ColumnBinder: { Name: 'docType_c1' },
            },
            {
              t: 'sc',
              Caption: 'Document No.',
              Editable: true,
              Visible: true,
              StringValue: 'S-ORD101001',
              ColumnBinder: { Name: 'docNo_c2' },
            },
            {
              t: 'bc',
              Caption: 'Include Header',
              Editable: true,
              Visible: true,
              StringValue: 'true',
              ObjectValue: true,
            },
          ],
        },
      ],
    };
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'dlg3', ownerFormId: 'root', controlTree },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.message).toBe('Copy Sales Document');
    expect(dialogs[0]!.fields).toBeDefined();
    expect(dialogs[0]!.fields!.length).toBe(3);

    const docType = dialogs[0]!.fields!.find(f => f.caption === 'Document Type');
    expect(docType).toBeDefined();
    expect(docType!.editable).toBe(true);
    expect(docType!.stringValue).toBe('Quote');
    expect(docType!.controlPath).toMatch(/server:c\[0\]\/c\[0\]/);

    const docNo = dialogs[0]!.fields!.find(f => f.caption === 'Document No.');
    expect(docNo).toBeDefined();
    expect(docNo!.stringValue).toBe('S-ORD101001');

    const includeHeader = dialogs[0]!.fields!.find(f => f.caption === 'Include Header');
    expect(includeHeader).toBeDefined();
    expect(includeHeader!.type).toBe('bc');
  });

  it('does not include fields when dialog has no parseable controls', () => {
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'dlg4', controlTree: { Caption: 'Confirm?', Children: [] } },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.fields).toBeUndefined();
  });

  it('only surfaces a message when Caption/Message really is a non-empty string', () => {
    // These were cast to `string`, so a structured Caption reached the caller as
    // "[object Object]" and an empty one as "".
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'd1', controlTree: { Caption: { Text: 'x' }, Message: 'Real message' } },
      { type: 'DialogOpened', formId: 'd2', controlTree: { Caption: '   ', Message: 'Fallback' } },
      { type: 'DialogOpened', formId: 'd3', controlTree: { Caption: 42 } },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs.map(d => d.message)).toEqual(['Real message', 'Fallback', undefined]);
  });
});

// Wire shapes captured live on devel1 (BC27, 2026-10-03).
describe('message boxes and messages BC raises after an action (bc-saas F-44)', () => {
  const errorBox: BCEvent = {
    type: 'DialogOpened', formId: '4A',
    controlTree: {
      t: 'lmd', Caption: 'Error', MappingHint: 'ErrorDialog', DialogType: 3, ExceptionType: 1, IsModal: true,
      Message: "No hay Customer dentro del filtro.\r\n\r\nFilltros: No.: ''",
      Children: [{ t: 'gc', Children: [{ t: 'ssc', Caption: "No hay Customer dentro del filtro." }] }],
    },
  };
  const confirmBox: BCEvent = {
    type: 'DialogOpened', formId: '31',
    controlTree: { t: 'lmd', Caption: 'Confirmar', MappingHint: 'ConfirmDialog', DialogType: 5, ExceptionType: 0, Message: 'Archive Order no.: 2001777?' },
  };
  const selection: BCEvent = {
    type: 'DialogOpened', formId: '4B',
    controlTree: { t: 'lf', Caption: 'Elegir', MappingHint: 'SelectionMenuDialog', IsModal: true },
  };

  it('reports an AL Error() with its TEXT, not the caption "Error"', () => {
    const [d] = detectDialogs([errorBox]);
    expect(d).toMatchObject({ formId: '4A', kind: 'error', caption: 'Error' });
    expect(d!.message).toContain('No hay Customer dentro del filtro.');
    // The static text is the message itself, not a field to fill.
    expect(d!.fields).toBeUndefined();
  });

  it('reports a Confirm() with its question', () => {
    expect(detectDialogs([confirmBox])).toEqual([{ formId: '31', kind: 'confirm', caption: 'Confirmar', message: 'Archive Order no.: 2001777?' }]);
  });

  it('classifies a selection menu and a modal page', () => {
    expect(detectDialogs([selection])[0]).toMatchObject({ kind: 'selection', message: 'Elegir' });
    expect(classifyDialog({ t: 'lf', Caption: 'Edit Dimension Set Entries', PageType: 1, IsModal: true })).toBe('page');
  });

  it('reports each dialog once even if the batch carries it twice', () => {
    expect(detectDialogs([confirmBox, confirmBox])).toHaveLength(1);
  });

  it('returns AL Message() text from MessageToShow events', () => {
    const events: BCEvent[] = [
      { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
      { type: 'MessageToShow', formId: '', text: 'Document 2001777 has been archived.', messageType: 'None', actions: ['Ok'], defaultAction: 'Ok' },
      { type: 'MessageToShow', formId: '', text: 'Document 2001777 has been archived.', messageType: 'None', actions: ['Ok'], defaultAction: 'Ok' },
      { type: 'MessageToShow', formId: '', text: '   ', messageType: 'None', actions: ['Ok'], defaultAction: 'Ok' },
    ];
    expect(detectMessages(events)).toEqual([{ text: 'Document 2001777 has been archived.', type: 'None' }]);
  });
});

describe('detectChangedSections never names a section bc_read_data refuses (bc-saas F-43)', () => {
  it('skips invalid sections, also in the root cascade', () => {
    const ctx = makeCtx({
      sections: new Map([
        ['header', { sectionId: 'header', kind: 'header' as const, caption: 'Header', formId: 'root', valid: true }],
        ['factbox:Datos pendientes', { sectionId: 'factbox:Datos pendientes', kind: 'factbox' as const, caption: 'Datos pendientes', formId: 'fb', valid: false }],
      ]),
    });
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'root', controlPath: 'c[0]', changes: {} },
      { type: 'PropertyChanged', formId: 'fb', controlPath: 'c[0]', changes: {} },
    ];
    expect(detectChangedSections(ctx, events)).toEqual(['header']);
  });
});
