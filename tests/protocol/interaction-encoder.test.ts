import { describe, it, expect, vi } from 'vitest';
import { InteractionEncoder, deriveTimeZoneInfo, type SessionContext } from '../../src/protocol/interaction-encoder.js';
import type { OpenFormInteraction, SaveValueInteraction } from '../../src/protocol/types.js';

describe('InteractionEncoder', () => {
  const encoder = new InteractionEncoder('27.0.0.0');

  const testSession: SessionContext = {
    sessionId: 'test-session-id',
    sessionKey: 'test-session-key',
    company: 'CRONUS',
    tenantId: 'default',
    spaInstanceId: 'testspa123',
  };

  it('encodes OpenForm interaction', () => {
    const interaction: OpenFormInteraction = {
      type: 'OpenForm',
      query: 'page=22&tenant=default',
      controlPath: 'server:c[0]',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-1',
      sequenceNo: 'spa1#1',
      lastClientAckSequenceNumber: 0,
      openFormIds: new Set(['form1']),
      session: testSession,
    });
    expect(result.method).toBe('Invoke');
    const params = result.params[0] as Record<string, unknown>;
    expect(params.sequenceNo).toBe('spa1#1');
    expect(params.sessionId).toBe('test-session-id');
    expect(params.sessionKey).toBe('test-session-key');
    expect(params.company).toBe('CRONUS');
    expect(params.tenantId).toBe('default');
    expect(params.features).toBeInstanceOf(Array);
    expect(typeof params.supportedExtensions).toBe('string');
    const navCtx = params.navigationContext as Record<string, unknown>;
    expect(navCtx.applicationId).toBe('NAV');
    expect(navCtx.spaInstanceId).toBe('testspa123');
    const interactions = params.interactionsToInvoke as unknown[];
    expect(interactions.length).toBe(1);
    const inv = interactions[0] as Record<string, unknown>;
    expect(inv.interactionName).toBe('OpenForm');
    expect(inv.callbackId).toBe('cb-1');
    expect(typeof inv.namedParameters).toBe('string'); // JSON string on wire
  });

  it('encodes SaveValue interaction', () => {
    const interaction: SaveValueInteraction = {
      type: 'SaveValue',
      formId: 'form123',
      controlPath: 'server:c[2]/c[0]/c[3]',
      newValue: 'test value',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-2',
      sequenceNo: 'spa1#2',
      lastClientAckSequenceNumber: 1,
      openFormIds: new Set(['form123']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    expect(params.sessionId).toBe('test-session-id');
    const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
    expect(inv.interactionName).toBe('SaveValue');
    expect(inv.formId).toBe('form123');
    const namedParams = JSON.parse(inv.namedParameters as string);
    expect(namedParams.newValue).toBe('test value');
  });

  it('includes openFormIds in request', () => {
    const interaction: SaveValueInteraction = {
      type: 'SaveValue',
      formId: 'form1',
      controlPath: 'c[0]',
      newValue: 'x',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-3',
      sequenceNo: 'spa1#3',
      lastClientAckSequenceNumber: 2,
      openFormIds: new Set(['form1', 'form2', 'dialogForm3']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    const openFormIds = params.openFormIds as string[];
    expect(openFormIds).toContain('form1');
    expect(openFormIds).toContain('form2');
    expect(openFormIds).toContain('dialogForm3');
  });

  it('encodes InvokeAction with systemAction', () => {
    const interaction = {
      type: 'InvokeAction' as const,
      formId: 'form1',
      controlPath: 'server:c[2]/c[0]',
      systemAction: 40,
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-4',
      sequenceNo: 'spa1#4',
      lastClientAckSequenceNumber: 3,
      openFormIds: new Set(['form1']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
    expect(inv.interactionName).toBe('InvokeAction');
    const namedParams = JSON.parse(inv.namedParameters as string);
    expect(namedParams.systemAction).toBe(40);
  });

  it('encodes Filter with AddLine operation', () => {
    const interaction = {
      type: 'Filter' as const,
      formId: 'form1',
      controlPath: 'server:c[1]',
      filterOperation: 1,
      filterColumnId: '36_Sales Header.3',
      filterValue: '101002',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-5',
      sequenceNo: 'spa1#5',
      lastClientAckSequenceNumber: 4,
      openFormIds: new Set(['form1']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
    expect(inv.interactionName).toBe('Filter');
    const namedParams = JSON.parse(inv.namedParameters as string);
    expect(namedParams.filterOperation).toBe(1);
    expect(namedParams.filterColumnId).toBe('36_Sales Header.3');
  });

  it('encodes SetCurrentRow', () => {
    const interaction = {
      type: 'SetCurrentRow' as const,
      formId: 'form1',
      controlPath: 'server:c[1]',
      key: 'bookmark-abc',
    };
    const result = encoder.encode(interaction, {
      callbackId: 'cb-6',
      sequenceNo: 'spa1#6',
      lastClientAckSequenceNumber: 5,
      openFormIds: new Set(['form1']),
      session: testSession,
    });
    const params = result.params[0] as Record<string, unknown>;
    const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
    expect(inv.interactionName).toBe('SetCurrentRowAndRowsSelection');
    const namedParams = JSON.parse(inv.namedParameters as string);
    expect(namedParams.key).toBe('bookmark-abc');
  });

  it('encodes OpenSession handshake', () => {
    const result = encoder.encodeOpenSession('default', 'spa-abc');
    expect(result.method).toBe('OpenSession');
    const params = result.params[0] as Record<string, unknown>;
    expect(params.sessionId).toBe('');
    expect(params.tenantId).toBe('default');
    expect(params.company).toBeNull();
    expect(params.lastClientAckSequenceNumber).toBe(-1);
    expect(params.features).toBeInstanceOf(Array);
    expect(typeof params.supportedExtensions).toBe('string');
    const navCtx = params.navigationContext as Record<string, unknown>;
    expect(navCtx.applicationId).toBe('NAV');
    expect(navCtx.spaInstanceId).toBe('spa-abc');
    const interactions = params.interactionsToInvoke as Record<string, unknown>[];
    expect(interactions.length).toBe(1);
    expect(interactions[0]!.interactionName).toBe('OpenForm');
    const tz = params.timeZoneInformation as Record<string, unknown>;
    expect(typeof tz.timeZoneBaseOffset).toBe('number');
    expect(typeof tz.dstOffset).toBe('number');
    // dstPeriodStart is a string only where the host zone observes DST; a
    // no-DST host (UTC CI runner) correctly sends null.
    expect(tz.dstPeriodStart === null || typeof tz.dstPeriodStart === 'string').toBe(true);
  });

  // F-11: a BC session is bound to its company at OpenSession. Asking a live
  // session to change company is answered with a bare InvokeCompleted and the data
  // keeps coming from the old company (verified live on devel1), so the switch has
  // to be made HERE — which is also what the web client's `?company=` does.
  describe('encodeOpenSession company', () => {
    const openForm = (call: ReturnType<InteractionEncoder['encodeOpenSession']>): string => {
      const params = call.params[0] as Record<string, unknown>;
      const inv = (params.interactionsToInvoke as Record<string, unknown>[])[0]!;
      return (JSON.parse(inv.namedParameters as string) as { query: string }).query;
    };

    it('opens on BC\'s default company when none is given', () => {
      const call = encoder.encodeOpenSession('default', 'spa-1');
      expect((call.params[0] as Record<string, unknown>).company).toBeNull();
      expect(openForm(call)).toBe('tenant=default&runinframe=1');
    });

    it('binds the session to the requested company, in the param AND the query', () => {
      const call = encoder.encodeOpenSession('default', 'spa-1', '', 'JBC JAPAN');
      expect((call.params[0] as Record<string, unknown>).company).toBe('JBC JAPAN');
      expect(openForm(call)).toBe('tenant=default&company=JBC%20JAPAN&runinframe=1');
    });

    // Same trap as the screenshot deep links: BC reads a query value LITERALLY, so
    // form encoding would look up a company called "CRONUS+ES", which does not exist.
    it('encodes a space as %20, never as +', () => {
      const q = openForm(encoder.encodeOpenSession('default', 'spa-1', '', 'CRONUS ES'));
      expect(q).toContain('company=CRONUS%20ES');
      expect(q).not.toContain('+');
    });
  });

  describe('encodeOpenSession profile', () => {
    it('emits empty profile by default', () => {
      const enc = new InteractionEncoder('27.0.0.0');
      const call = enc.encodeOpenSession('default', 'spa-1');
      const params = (call.params[0] as Record<string, unknown>);
      expect(params.profile).toBe('');
    });

    it('emits the supplied profile string', () => {
      const enc = new InteractionEncoder('27.0.0.0');
      const call = enc.encodeOpenSession('default', 'spa-1', 'BUSINESS MANAGER');
      const params = (call.params[0] as Record<string, unknown>);
      expect(params.profile).toBe('BUSINESS MANAGER');
    });

    it('treats undefined profile as empty', () => {
      const enc = new InteractionEncoder('27.0.0.0');
      const call = enc.encodeOpenSession('default', 'spa-1', undefined);
      const params = (call.params[0] as Record<string, unknown>);
      expect(params.profile).toBe('');
    });
  });

  // Finding 8 — timezone must be derived, not hardcoded to the EU.
  describe('deriveTimeZoneInfo', () => {
    /**
     * Runs `fn` with `Date.prototype.getTimezoneOffset` faked for a zone whose
     * January / July offsets (in MINUTES EAST of UTC) are the given values.
     * The real API returns minutes WEST, hence the negation.
     */
    function withZone(janEast: number, julEast: number, fn: () => void): void {
      const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockImplementation(function (this: Date) {
        return this.getMonth() < 6 ? -janEast : -julEast;
      });
      try { fn(); } finally { spy.mockRestore(); }
    }

    const summer = new Date(2026, 7, 15, 12, 0, 0); // August — the old bug's trigger
    const winter = new Date(2026, 0, 15, 12, 0, 0);

    it('reports the STANDARD offset in summer, not the DST-inflated one (Madrid)', () => {
      withZone(60, 120, () => {
        const tz = deriveTimeZoneInfo(summer);
        // The old code sent base=120 (already DST-shifted) AND dstOffset=60 => +180.
        expect(tz.timeZoneBaseOffset).toBe(60);
        expect(tz.dstOffset).toBe(60);
      });
    });

    it('reports the same standard offset in winter (stable across the year)', () => {
      withZone(60, 120, () => {
        expect(deriveTimeZoneInfo(winter).timeZoneBaseOffset).toBe(60);
        expect(deriveTimeZoneInfo(winter).dstOffset).toBe(60);
      });
    });

    it('sends no DST window for a zone without DST (UTC)', () => {
      withZone(0, 0, () => {
        const tz = deriveTimeZoneInfo(summer);
        expect(tz).toEqual({ timeZoneBaseOffset: 0, dstOffset: 0, dstPeriodStart: null, dstPeriodEnd: null });
      });
    });

    it('sends no DST window for a non-DST zone with a non-zero offset (Kolkata +5:30)', () => {
      withZone(330, 330, () => {
        const tz = deriveTimeZoneInfo(summer);
        expect(tz.timeZoneBaseOffset).toBe(330);
        expect(tz.dstOffset).toBe(0);
        expect(tz.dstPeriodStart).toBeNull();
      });
    });

    it('handles negative (western) offsets — New York', () => {
      withZone(-300, -240, () => {
        const tz = deriveTimeZoneInfo(summer);
        expect(tz.timeZoneBaseOffset).toBe(-300);
        expect(tz.dstOffset).toBe(60);
      });
    });

    it('handles a southern-hemisphere zone whose DST straddles the new year (Sydney)', () => {
      withZone(660, 600, () => {
        const tz = deriveTimeZoneInfo(new Date(2026, 5, 1));
        expect(tz.timeZoneBaseOffset).toBe(600);   // standard = the SMALLER offset
        expect(tz.dstOffset).toBe(60);
        const start = new Date(tz.dstPeriodStart!);
        const end = new Date(tz.dstPeriodEnd!);
        expect(end.getTime()).toBeGreaterThan(start.getTime());
        expect(end.getUTCFullYear()).toBe(2027);   // window crosses into the next year
      });
    });

    it('emits a northern DST window inside the same year', () => {
      withZone(60, 120, () => {
        const tz = deriveTimeZoneInfo(new Date(2026, 7, 15));
        const start = new Date(tz.dstPeriodStart!);
        const end = new Date(tz.dstPeriodEnd!);
        expect(start.getUTCFullYear()).toBe(2026);
        expect(end.getUTCFullYear()).toBe(2026);
        expect(end.getTime()).toBeGreaterThan(start.getTime());
      });
    });

    it('handles a half-hour DST shift (Lord Howe, 30 min)', () => {
      withZone(660, 630, () => {
        const tz = deriveTimeZoneInfo(summer);
        expect(tz.timeZoneBaseOffset).toBe(630);
        expect(tz.dstOffset).toBe(30);
      });
    });

    it('is what encodeOpenSession sends on the wire', () => {
      withZone(60, 120, () => {
        const call = new InteractionEncoder('27.0.0.0').encodeOpenSession('default', 'spa-1');
        const tz = (call.params[0] as Record<string, unknown>).timeZoneInformation as Record<string, unknown>;
        expect(tz.timeZoneBaseOffset).toBe(60);
        expect(tz.dstOffset).toBe(60);
      });
    });
  });

  describe('navigationContext applicationId', () => {
    it('uses NAV as the default applicationId (BC 27 web client; FIN triggers NavCancelCredentialPromptException)', () => {
      const enc = new InteractionEncoder('27.0.0.0');
      const call = enc.encodeOpenSession('default', 'spa-1');
      const navCtx = (call.params[0] as Record<string, unknown>).navigationContext as Record<string, unknown>;
      expect(navCtx.applicationId).toBe('NAV');
    });

    it('honors a custom applicationId override', () => {
      const enc = new InteractionEncoder('27.0.0.0', 'FIN');
      const call = enc.encodeOpenSession('default', 'spa-1');
      const navCtx = (call.params[0] as Record<string, unknown>).navigationContext as Record<string, unknown>;
      expect(navCtx.applicationId).toBe('FIN');
    });
  });
});
