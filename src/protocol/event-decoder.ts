import { HANDLER_TYPES } from './handler-types.js';
import { resolveChangeType, SESSION_EVENTS } from './wire-types.js';
import type {
  BCEvent, FormCreatedEvent, FormClosedEvent, DialogOpenedEvent, MessageToShowEvent,
  DataLoadedEvent, PropertyChangedEvent, BookmarkChangedEvent, InvokeCompletedEvent,
  SessionInfoEvent,
} from './types.js';
import { createNullLogger, type Logger } from '../core/logger.js';

const MESSAGE_TYPES: readonly MessageToShowEvent['messageType'][] =
  ['None', 'Warning', 'Info', 'Error', 'Fatal', 'Confirm', 'Permission'];

/**
 * Normalize BC's MessageToShow `Type` to the canonical messageType union,
 * tolerating casing variants (e.g. "error" -> "Error"). An unrecognized or
 * numeric-ordinal value falls back to 'None' instead of leaking a non-union
 * value that exact `=== 'Error'` checks downstream would skip.
 */
function normalizeMessageType(raw: unknown): MessageToShowEvent['messageType'] {
  if (typeof raw === 'string') {
    const match = MESSAGE_TYPES.find(t => t.toLowerCase() === raw.toLowerCase());
    if (match) return match;
  }
  return 'None';
}

export class EventDecoder {
  /**
   * @param logger Optional logger. Defaults to a no-op logger so existing
   *   call sites need no change; pass a real logger to surface decoder
   *   diagnostics (malformed handlers at warn, dropped session events at debug).
   */
  constructor(private readonly logger: Logger = createNullLogger()) {}

  decode(handlers: unknown[]): BCEvent[] {
    const events: BCEvent[] = [];
    for (const handler of handlers) {
      if (!handler || typeof handler !== 'object') continue;
      const h = handler as { handlerType?: string; parameters?: unknown[] };
      if (!h.handlerType || !Array.isArray(h.parameters)) continue;
      try {
        switch (h.handlerType) {
          case HANDLER_TYPES.LogicalClientChange:
            events.push(...this.decodeLogicalClientChange(h.parameters));
            break;
          case HANDLER_TYPES.LogicalClientEventRaising:
            events.push(...this.decodeEventRaising(h.parameters));
            break;
          case HANDLER_TYPES.CallbackResponseProperties:
            events.push(...this.decodeCallbackResponseProperties(h.parameters));
            break;
          case HANDLER_TYPES.CachedSessionInit:
          case HANDLER_TYPES.SessionInit:
          // SessionSettingsChanged carries the new company/timezone/locale after a
          // ChangeCompany (SystemAction 500). Decoding it as SessionInfo lets the
          // session refresh its company name from the server's confirmation.
          case HANDLER_TYPES.SessionSettingsChanged:
            events.push(...this.decodeSessionInfo(h.parameters));
            break;
        }
      } catch (e) {
        // A malformed handler is skipped, but silently swallowing it would hide
        // decoder bugs — log which handler type failed so drops are observable.
        this.logger.warn('EventDecoder: failed to decode handler, skipping', {
          handlerType: h.handlerType,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return events;
  }

  private decodeLogicalClientChange(params: unknown[]): BCEvent[] {
    const events: BCEvent[] = [];
    const handlerFormId = params[0] as string;
    const changes = params[1] as unknown[];
    if (!handlerFormId || !Array.isArray(changes)) return events;

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const c = change as Record<string, unknown>;
      const wireType = c.t as string;
      const resolved = resolveChangeType(wireType);
      const controlRef = c.ControlReference as { controlPath?: string; formId?: string } | undefined;
      const controlPath = controlRef?.controlPath ?? '';
      // Each change carries its REAL target form in ControlReference.formId —
      // a single handler batch can mix changes for several forms (live SaaS
      // capture saas-handshake-2026-08-08.json: handler formId 392 with
      // changes targeting 389/38B/38C/38D). The handler-level params[0] is
      // only a fallback for changes without a ControlReference.
      const formId = controlRef?.formId ?? handlerFormId;

      switch (resolved) {
        case 'DataRefreshChange':
          events.push({ type: 'DataLoaded', formId, controlPath, currentRowOnly: (c.CurrentRowOnly as boolean) ?? false, rows: (c.RowChanges as unknown[]) ?? [] } satisfies DataLoadedEvent);
          break;
        case 'PropertyChanges':
          events.push({ type: 'PropertyChanged', formId, controlPath, changes: (c.Changes as Record<string, unknown>) ?? {} } satisfies PropertyChangedEvent);
          break;
        case 'PropertyChange': {
          const propName = c.PropertyName as string;
          if (propName) {
            events.push({ type: 'PropertyChanged', formId, controlPath, changes: { [propName]: c.PropertyValue } } satisfies PropertyChangedEvent);
          }
          break;
        }
        case 'DataRowBookmarkChange':
          events.push({ type: 'BookmarkChanged', formId, controlPath, bookmark: (c.Bookmark as string) ?? '' } satisfies BookmarkChangedEvent);
          break;
      }
    }
    return events;
  }

  private decodeEventRaising(params: unknown[]): BCEvent[] {
    const events: BCEvent[] = [];
    const eventName = params[0] as string;
    const eventData = (params[1] ?? {}) as Record<string, unknown>;

    switch (eventName) {
      case SESSION_EVENTS.FormToShow:
        events.push({ type: 'FormCreated', formId: (eventData.ServerId ?? eventData.formId ?? eventData.FormId ?? '') as string, parentFormId: (eventData.ParentForm ?? eventData.parentForm) as string | undefined, isReload: (eventData.IsReload ?? false) as boolean, controlTree: eventData } satisfies FormCreatedEvent);
        break;
      case SESSION_EVENTS.DialogToShow:
        events.push({ type: 'DialogOpened', formId: (eventData.ServerId ?? eventData.formId ?? eventData.FormId ?? '') as string, ownerFormId: (eventData.OwnerForm ?? eventData.ownerForm) as string | undefined, controlTree: eventData } satisfies DialogOpenedEvent);
        break;
      case SESSION_EVENTS.ClosePendingForm:
        events.push({ type: 'FormClosed', formId: (eventData.ServerId ?? eventData.formId ?? eventData.FormId ?? '') as string } satisfies FormClosedEvent);
        break;
      case SESSION_EVENTS.MessageToShow: {
        // Non-modal toast: AL Message(), license-expiry warnings, etc.
        // Wire: params[1] = { Text, Type?, Actions?, DefaultAction?, AutomationId? }
        // Reference: LogicalMessageSerializer.Write() (decompiled
        //   Microsoft.Dynamics.Framework.UI.Client); ported from upstream, which
        //   confirmed the shape via a live BC28 probe.
        const rawActions = eventData.Actions as string[] | undefined;
        const rawDefault = eventData.DefaultAction as string | undefined;
        events.push({
          type: 'MessageToShow',
          formId: '',
          text: (eventData.Text as string | undefined) ?? '',
          messageType: normalizeMessageType(eventData.Type),
          actions: rawActions ?? ['Ok'],
          defaultAction: rawDefault ?? 'Ok',
          automationId: eventData.AutomationId as string | undefined,
        } satisfies MessageToShowEvent);
        break;
      }
      default:
        // LookupFormReady / UriToShow / RequestUserToken / CopilotSettingsChanged
        // (and anything new) are not decoded yet. Log the drop at debug so it is
        // observable instead of silent.
        this.logger.debug('protocol', 'EventDecoder: unhandled session event dropped', { eventName });
        break;
    }
    return events;
  }

  private decodeCallbackResponseProperties(params: unknown[]): BCEvent[] {
    const data = params[0] as Record<string, unknown> | undefined;
    if (!data) return [];
    const completed = (data.CompletedInteractions ?? []) as Array<Record<string, unknown>>;
    return [{ type: 'InvokeCompleted', sequenceNumber: (data.SequenceNumber as number) ?? 0, completedInteractions: completed.map(ci => ({ invocationId: (ci.InvocationId as string) ?? '', durationMs: (ci.Duration as number) ?? 0, result: ci.Result })) } satisfies InvokeCompletedEvent];
  }

  private decodeSessionInfo(params: unknown[]): BCEvent[] {
    return [{ type: 'SessionInfo', formId: '', sessionData: params[0] } satisfies SessionInfoEvent];
  }
}
