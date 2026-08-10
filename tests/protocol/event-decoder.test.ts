import { describe, it, expect } from 'vitest';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { HANDLER_TYPES } from '../../src/protocol/handler-types.js';
import type { Logger } from '../../src/core/logger.js';

interface LogEntry { level: 'info' | 'warn' | 'error' | 'debug'; msg: string; context?: Record<string, unknown> }

/** Logger that records every call, so decoder diagnostics are assertable. */
function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: Logger = {
    info: (msg, context) => { entries.push({ level: 'info', msg, context }); },
    warn: (msg, context) => { entries.push({ level: 'warn', msg, context }); },
    error: (msg, context) => { entries.push({ level: 'error', msg, context }); },
    debug: (_channel, msg, context) => { entries.push({ level: 'debug', msg, context }); },
  };
  return { logger, entries };
}

describe('EventDecoder', () => {
  const decoder = new EventDecoder();

  it('decodes DataRefreshChange from LogicalClientChangeHandler', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId123', [{
        t: 'DataRefreshChange',
        ControlReference: { controlPath: 'server:c[1]' },
        HasSortingChanged: false,
        CurrentRowOnly: false,
        RowChanges: [
          { t: 'DataRowInserted', DataRowInserted: [0, { cells: { 'No.': '10000' } }] },
        ],
      }]],
    }];
    const events = decoder.decode(handlers);
    const dataLoaded = events.find(e => e.type === 'DataLoaded');
    expect(dataLoaded).toBeDefined();
    expect(dataLoaded!.formId).toBe('formId123');
    if (dataLoaded?.type === 'DataLoaded') {
      expect(dataLoaded.currentRowOnly).toBe(false);
      expect(dataLoaded.rows.length).toBe(1);
    }
  });

  it('decodes PropertyChanges', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId456', [{
        t: 'PropertyChanges',
        ControlReference: { controlPath: 'server:c[2]/c[0]/c[3]' },
        Changes: { StringValue: 'Hello', Editable: true },
      }]],
    }];
    const events = decoder.decode(handlers);
    const propChanged = events.find(e => e.type === 'PropertyChanged');
    expect(propChanged).toBeDefined();
    if (propChanged?.type === 'PropertyChanged') {
      expect(propChanged.formId).toBe('formId456');
      expect(propChanged.controlPath).toBe('server:c[2]/c[0]/c[3]');
      expect(propChanged.changes['StringValue']).toBe('Hello');
    }
  });

  it('decodes CallbackResponseProperties', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.CallbackResponseProperties,
      parameters: [{
        SequenceNumber: 42,
        CompletedInteractions: [{ InvocationId: 'cb-001', Duration: 150 }],
      }],
    }];
    const events = decoder.decode(handlers);
    const completed = events.find(e => e.type === 'InvokeCompleted');
    expect(completed).toBeDefined();
    if (completed?.type === 'InvokeCompleted') {
      expect(completed.sequenceNumber).toBe(42);
      expect(completed.completedInteractions[0]!.invocationId).toBe('cb-001');
    }
  });

  it('decodes FormToShow event', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientEventRaising,
      parameters: ['FormToShow', { formId: 'newForm789', ParentForm: 'parentForm123', IsReload: false }, {}],
    }];
    const events = decoder.decode(handlers);
    const formCreated = events.find(e => e.type === 'FormCreated');
    expect(formCreated).toBeDefined();
    if (formCreated?.type === 'FormCreated') {
      expect(formCreated.formId).toBe('newForm789');
      expect(formCreated.parentFormId).toBe('parentForm123');
    }
  });

  it('decodes DialogToShow event', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientEventRaising,
      parameters: ['DialogToShow', { formId: 'dialog001', OwnerForm: 'owner123' }, {}],
    }];
    const events = decoder.decode(handlers);
    const dialogOpened = events.find(e => e.type === 'DialogOpened');
    expect(dialogOpened).toBeDefined();
    if (dialogOpened?.type === 'DialogOpened') {
      expect(dialogOpened.ownerFormId).toBe('owner123');
    }
  });

  it('decodes BookmarkChanged (DataRowBookmarkChange)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId999', [{
        t: 'DataRowBookmarkChange',
        ControlReference: { controlPath: 'server:c[1]' },
        Bookmark: 'bookmark123',
      }]],
    }];
    const events = decoder.decode(handlers);
    const bookmark = events.find(e => e.type === 'BookmarkChanged');
    expect(bookmark).toBeDefined();
    if (bookmark?.type === 'BookmarkChanged') expect(bookmark.bookmark).toBe('bookmark123');
  });

  it('handles abbreviated change types (drch)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId', [{
        t: 'drch',
        ControlReference: { controlPath: 'server:c[1]' },
        CurrentRowOnly: false,
        RowChanges: [],
      }]],
    }];
    const events = decoder.decode(handlers);
    expect(events.find(e => e.type === 'DataLoaded')).toBeDefined();
  });

  it('handles abbreviated PropertyChanges (lcpchs)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId', [{
        t: 'lcpchs',
        ControlReference: { controlPath: 'c[0]' },
        Changes: { Caption: 'Test' },
      }]],
    }];
    const events = decoder.decode(handlers);
    expect(events.find(e => e.type === 'PropertyChanged')).toBeDefined();
  });

  it('skips unknown handler types', () => {
    const handlers = [{ handlerType: 'DN.UnknownHandler', parameters: [] }];
    expect(decoder.decode(handlers)).toEqual([]);
  });

  it('handles single PropertyChange (lcpch)', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientChange,
      parameters: ['formId', [{
        t: 'lcpch',
        ControlReference: { controlPath: 'c[0]' },
        PropertyName: 'Visible',
        PropertyValue: false,
      }]],
    }];
    const events = decoder.decode(handlers);
    const prop = events.find(e => e.type === 'PropertyChanged');
    expect(prop).toBeDefined();
    if (prop?.type === 'PropertyChanged') expect(prop.changes['Visible']).toBe(false);
  });

  // Finding 1 — per-change ControlReference.formId routing.
  describe('per-change formId routing', () => {
    it('routes each change to its own ControlReference.formId', () => {
      const handlers = [{
        handlerType: HANDLER_TYPES.LogicalClientChange,
        parameters: ['392', [
          { t: 'lcpchs', ControlReference: { controlPath: 'server:c[0]', formId: '389' }, Changes: { StringValue: 'a' } },
          { t: 'lcpchs', ControlReference: { controlPath: 'server:c[1]', formId: '38B' }, Changes: { StringValue: 'b' } },
          { t: 'drch', ControlReference: { controlPath: 'server:c[2]', formId: '38C' }, CurrentRowOnly: false, RowChanges: [] },
          { t: 'drbch', ControlReference: { controlPath: 'server:c[3]', formId: '38D' }, Bookmark: 'bm' },
        ]],
      }];
      const events = decoder.decode(handlers);
      expect(events.map(e => e.type === 'InvokeCompleted' ? 'x' : e.formId))
        .toEqual(['389', '38B', '38C', '38D']);
    });

    it('falls back to the handler-level formId when a change carries no ControlReference.formId', () => {
      const handlers = [{
        handlerType: HANDLER_TYPES.LogicalClientChange,
        parameters: ['handlerForm', [
          { t: 'lcpchs', ControlReference: { controlPath: 'server:c[0]' }, Changes: { Caption: 'X' } },
        ]],
      }];
      const events = decoder.decode(handlers);
      expect(events[0]!.type === 'InvokeCompleted' ? '' : events[0]!.formId).toBe('handlerForm');
    });
  });

  // Finding 2 — MessageToShow decoding + unknown-session-event debug drop.
  describe('MessageToShow', () => {
    function decodeMessage(data: Record<string, unknown>) {
      const events = decoder.decode([{
        handlerType: HANDLER_TYPES.LogicalClientEventRaising,
        parameters: ['MessageToShow', data, {}],
      }]);
      const msg = events.find(e => e.type === 'MessageToShow');
      expect(msg).toBeDefined();
      return msg!.type === 'MessageToShow' ? msg : null;
    }

    it('decodes a full MessageToShow payload', () => {
      const msg = decodeMessage({
        Text: 'The customer has an overdue balance.',
        Type: 'Warning',
        Actions: ['Ok', 'Cancel'],
        DefaultAction: 'Cancel',
        AutomationId: 'msg-42',
      })!;
      expect(msg.formId).toBe('');
      expect(msg.text).toBe('The customer has an overdue balance.');
      expect(msg.messageType).toBe('Warning');
      expect(msg.actions).toEqual(['Ok', 'Cancel']);
      expect(msg.defaultAction).toBe('Cancel');
      expect(msg.automationId).toBe('msg-42');
    });

    it('defaults text/type/actions when the wire omits them', () => {
      const msg = decodeMessage({})!;
      expect(msg.text).toBe('');
      expect(msg.messageType).toBe('None');
      expect(msg.actions).toEqual(['Ok']);
      expect(msg.defaultAction).toBe('Ok');
      expect(msg.automationId).toBeUndefined();
    });

    it('normalizes the messageType casing to the canonical union member', () => {
      expect(decodeMessage({ Type: 'error' })!.messageType).toBe('Error');
      expect(decodeMessage({ Type: 'FATAL' })!.messageType).toBe('Fatal');
      expect(decodeMessage({ Type: 'Permission' })!.messageType).toBe('Permission');
    });

    it('falls back to None for an unrecognized or numeric-ordinal Type', () => {
      expect(decodeMessage({ Type: 'Bogus' })!.messageType).toBe('None');
      expect(decodeMessage({ Type: 3 })!.messageType).toBe('None');
    });
  });

  describe('unhandled session events', () => {
    it('drops the event and logs it at debug (not silently)', () => {
      const { logger, entries } = recordingLogger();
      const events = new EventDecoder(logger).decode([{
        handlerType: HANDLER_TYPES.LogicalClientEventRaising,
        parameters: ['CopilotSettingsChanged', {}, {}],
      }]);
      expect(events).toEqual([]);
      const debug = entries.find(e => e.level === 'debug');
      expect(debug).toBeDefined();
      expect(debug!.context!.eventName).toBe('CopilotSettingsChanged');
    });

    it('stays silent with the default null logger', () => {
      expect(() => decoder.decode([{
        handlerType: HANDLER_TYPES.LogicalClientEventRaising,
        parameters: ['UriToShow', { Uri: 'https://example.invalid' }, {}],
      }])).not.toThrow();
    });
  });

  // Finding 10 — malformed handlers are skipped, but visibly.
  describe('malformed handlers', () => {
    it('logs a warn with the handler type and keeps decoding the rest', () => {
      const { logger, entries } = recordingLogger();
      const events = new EventDecoder(logger).decode([
        // CompletedInteractions is not an array -> `.map` throws inside the decoder.
        { handlerType: HANDLER_TYPES.CallbackResponseProperties, parameters: [{ SequenceNumber: 1, CompletedInteractions: 'nope' }] },
        { handlerType: HANDLER_TYPES.LogicalClientEventRaising, parameters: ['ClosePendingForm', { ServerId: 'f1' }, {}] },
      ]);
      // The good handler after the malformed one still produced its event.
      expect(events.map(e => e.type)).toEqual(['FormClosed']);
      const warn = entries.find(e => e.level === 'warn');
      expect(warn).toBeDefined();
      expect(warn!.context!.handlerType).toBe(HANDLER_TYPES.CallbackResponseProperties);
      expect(typeof warn!.context!.error).toBe('string');
    });

    it('does not throw when no logger is supplied', () => {
      expect(() => decoder.decode([
        { handlerType: HANDLER_TYPES.CallbackResponseProperties, parameters: [{ CompletedInteractions: 7 }] },
      ])).not.toThrow();
    });
  });

  it('decodes ClosePendingForm as FormClosed event', () => {
    const handlers = [{
      handlerType: HANDLER_TYPES.LogicalClientEventRaising,
      parameters: ['ClosePendingForm', { ServerId: 'closedForm123' }, {}],
    }];
    const events = decoder.decode(handlers);
    const closed = events.find(e => e.type === 'FormClosed');
    expect(closed).toBeDefined();
    if (closed?.type === 'FormClosed') {
      expect(closed.formId).toBe('closedForm123');
    }
  });
});
