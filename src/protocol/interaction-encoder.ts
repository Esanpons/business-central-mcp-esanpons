import type { BCInteraction } from './types.js';

export interface SessionContext {
  sessionId: string;
  sessionKey: string;
  company: string;
  tenantId: string;
  spaInstanceId: string;
}

export interface EncodeContext {
  callbackId: string;
  sequenceNo: string;
  lastClientAckSequenceNumber: number;
  openFormIds: ReadonlySet<string>;
  session: SessionContext;
}

export interface EncodedRpcCall {
  method: string;
  params: unknown[];
}

const BC_FEATURES = [
  'QueueInteractions', 'MetadataCache', 'CacheSession', 'DynamicsQuickEntry',
  'Multitasking', 'MultilineEdit', 'SaveValueToDatabasePromptly', 'CalcOnlyVisibleFlowFields',
];

const BC_SUPPORTED_EXTENSIONS = JSON.stringify([
  { Name: 'Microsoft.Dynamics.Nav.Client.PageNotifier' },
  { Name: 'Microsoft.Dynamics.Nav.Client.Capabilities.Tour' },
  { Name: 'Microsoft.Dynamics.Nav.Client.Capabilities.UserTours' },
  { Name: 'Microsoft.Dynamics.Nav.Client.Capabilities.AppSource' },
  { Name: 'Microsoft.Dynamics.Nav.Client.Capabilities.Designer' },
]);

/** Wire shape of OpenSession's `timeZoneInformation`. All offsets in minutes east of UTC. */
export interface TimeZoneInfo {
  /** STANDARD (non-DST) UTC offset in minutes east. Madrid = 60 year-round. */
  readonly timeZoneBaseOffset: number;
  /** Extra minutes added while DST is in effect; 0 when the zone has no DST. */
  readonly dstOffset: number;
  /** ISO start of the DST window. Omitted (null) when dstOffset is 0. */
  readonly dstPeriodStart: string | null;
  /** ISO end of the DST window. Omitted (null) when dstOffset is 0. */
  readonly dstPeriodEnd: string | null;
}

/**
 * Derive BC's `timeZoneInformation` from the host clock, WITHOUT assuming
 * Europe or even that DST exists.
 *
 * The bug this replaces: `-now.getTimezoneOffset()` already INCLUDES the DST
 * shift when it is called during summer, yet a fixed `dstOffset: 60` plus the
 * EU last-Sunday-of-March/October window was sent alongside it. A Madrid host
 * in August therefore told BC "base +120 and add 60 more" = +180. Hosts outside
 * the EU, hosts with no DST (UTC, most of Asia), and southern-hemisphere hosts
 * (DST spans the new year) all got fictional windows.
 *
 * Method: probe both solstice months. `Date.prototype.getTimezoneOffset` is
 * evaluated for the host zone at that instant, so January and July bracket the
 * standard and daylight offsets in either hemisphere:
 *   - standard offset = the SMALLER of the two (in minutes east; DST always
 *     moves the clock forward, i.e. increases the minutes-east value)
 *   - dstOffset       = their difference (0 when the zone observes no DST)
 *   - the DST window  = the half of the year whose probe carries the larger
 *     offset — northern zones get roughly Apr–Oct, southern zones Oct–Apr.
 *
 * The window bounds are deliberately MONTH-GRANULAR approximations: BC only
 * uses them to render local times, no jurisdiction's exact transition date is
 * derivable from the ECMAScript API without an IANA rule table, and the
 * offsets themselves (which is what matters for correctness) are exact.
 *
 * Exported as a pure function of `now` so it is testable without changing the
 * machine timezone.
 */
export function deriveTimeZoneInfo(now: Date = new Date()): TimeZoneInfo {
  const year = now.getFullYear();
  // Minutes EAST of UTC (getTimezoneOffset returns minutes WEST).
  const janOffset = -new Date(year, 0, 1).getTimezoneOffset();
  const julOffset = -new Date(year, 6, 1).getTimezoneOffset();

  const standardOffset = Math.min(janOffset, julOffset);
  const dstOffset = Math.abs(julOffset - janOffset);

  if (dstOffset === 0) {
    // No DST in this zone (UTC, IST, most of Asia, Arizona, …).
    return { timeZoneBaseOffset: standardOffset, dstOffset: 0, dstPeriodStart: null, dstPeriodEnd: null };
  }

  // Northern hemisphere: July is the DST half -> window inside the year.
  // Southern hemisphere: January is the DST half -> window straddles new year.
  const northern = julOffset > janOffset;
  const start = northern ? new Date(year, 3, 1, 2, 0, 0, 0) : new Date(year, 9, 1, 2, 0, 0, 0);
  const end = northern ? new Date(year, 9, 1, 2, 0, 0, 0) : new Date(year + 1, 3, 1, 2, 0, 0, 0);

  return {
    timeZoneBaseOffset: standardOffset,
    dstOffset,
    dstPeriodStart: start.toISOString(),
    dstPeriodEnd: end.toISOString(),
  };
}

export class InteractionEncoder {
  /**
   * @param _clientVersion  BC client version string (e.g. "27.0.0.0"). ACCEPTED
   *   BUT UNUSED: no BC payload this encoder builds carries a client version —
   *   the wire compatibility number lives in the protocol codec, not here. The
   *   parameter is kept so the many call sites need no change; see the report on
   *   `BC_CLIENT_VERSION` / `BCConfig.clientVersionString`, which only feeds
   *   `bc_health` output today.
   * @param applicationId  navigationContext.applicationId sent in OpenSession/Invoke.
   *   Must match what the NST expects for the target BC build. On BC 27
   *   (ltsc2025) the real web client sends "NAV"; sending "FIN" makes the server
   *   throw NavCancelCredentialPromptException on OpenSession even though the WS
   *   handshake succeeds. Verified empirically against the browser web client.
   *   Defaults to "NAV". Override via BC_APPLICATION_ID for other builds.
   */
  constructor(
    _clientVersion: string,
    private readonly applicationId: string = 'NAV',
  ) {}

  encode(interaction: BCInteraction, context: EncodeContext): EncodedRpcCall {
    const invocation = this.buildInvocation(interaction, context.callbackId);
    return {
      method: 'Invoke',
      params: [{
        sessionId: context.session.sessionId,
        sessionKey: context.session.sessionKey,
        company: context.session.company,
        tenantId: context.session.tenantId,
        openFormIds: Array.from(context.openFormIds),
        interactionsToInvoke: [invocation],
        sequenceNo: context.sequenceNo,
        lastClientAckSequenceNumber: context.lastClientAckSequenceNumber,
        navigationContext: {
          applicationId: this.applicationId,
          deviceCategory: 0,
          spaInstanceId: context.session.spaInstanceId,
        },
        features: BC_FEATURES,
        supportedExtensions: BC_SUPPORTED_EXTENSIONS,
        telemetryClientActivityId: null,
        telemetryClientSessionId: null,
      }],
    };
  }

  /**
   * OpenSession login parameters (verified against decompiled BC):
   * - tenantId: tenant to connect to
   * - profile: BC profile id (e.g. "BUSINESS MANAGER"). Server uppercases and trims.
   *   Unknown ids silently fall back to the user's default profile, with a
   *   `ConnectionWarning.MissingProfile` returned in UserSettings. Empty string
   *   = use server default.
   *
   * Reference: `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs`
   * Profile field; `Microsoft.Dynamics.Nav.Service/NSService.cs:OpenConnection`
   * resolution logic.
   */
  /**
   * @param company  Company to open the session ON. This is how the web client
   *   changes company: it does NOT ask a live session to move — it re-enters with
   *   `?company=<name>`, because a BC session is bound to its company server-side
   *   at OpenSession. Sending `InvokeSessionAction(ChangeCompany)` to an open
   *   session was answered with a bare `InvokeCompleted` (no SessionSettingsChanged,
   *   verified live on devel1) and the data kept coming from the old company, while
   *   the tool reported the switch as done (bc-saas F-11). Omit for BC's default.
   *   The value goes into the query with `encodeURIComponent`, never form encoding:
   *   BC reads a query value LITERALLY, so `CRONUS ES` sent as `CRONUS+ES` is a
   *   company that does not exist (the same trap as the screenshot deep links).
   */
  encodeOpenSession(tenantId: string, spaInstanceId: string, profile?: string, company?: string): EncodedRpcCall {
    const query = company
      ? `tenant=${tenantId}&company=${encodeURIComponent(company)}&runinframe=1`
      : `tenant=${tenantId}&runinframe=1`;
    return {
      method: 'OpenSession',
      params: [{
        openFormIds: [],
        sessionId: '',
        sequenceNo: null,
        lastClientAckSequenceNumber: -1,
        telemetryClientActivityId: null,
        telemetryTraceStartInfo: 'traceStartInfo=%5BWeb%20Client%20-%20Web%20browser%5D%20OpenForm',
        navigationContext: {
          applicationId: this.applicationId,
          deviceCategory: 0,
          spaInstanceId,
        },
        supportedExtensions: BC_SUPPORTED_EXTENSIONS,
        interactionsToInvoke: [{
          interactionName: 'OpenForm',
          skipExtendingSessionLifetime: false,
          namedParameters: JSON.stringify({ query }),
          callbackId: '0',
        }],
        tenantId,
        company: company ?? null,
        telemetryClientSessionId: null,
        features: BC_FEATURES,
        profile: profile ?? '',
        rememberCompany: false,
        timeZoneInformation: deriveTimeZoneInfo(),
        profileDescription: { Id: null, Caption: null, Description: null },
        disableResponseSequencing: true,
      }],
    };
  }

  private buildInvocation(interaction: BCInteraction, callbackId: string): Record<string, unknown> {
    switch (interaction.type) {
      case 'OpenForm':
        return { interactionName: 'OpenForm', namedParameters: JSON.stringify({ query: interaction.query }), controlPath: interaction.controlPath ?? 'server:c[0]', callbackId };
      case 'LoadForm':
        return { interactionName: 'LoadForm', formId: interaction.formId, namedParameters: JSON.stringify({ loadData: interaction.loadData, delayed: interaction.delayed ?? false, ...(interaction.openForm ? { openForm: true } : {}) }), callbackId };
      case 'CloseForm':
        return { interactionName: 'CloseForm', formId: interaction.formId, namedParameters: JSON.stringify({}), callbackId };
      case 'InvokeAction':
        return { interactionName: 'InvokeAction', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ systemAction: interaction.systemAction ?? 0, key: null, repeaterControlTarget: null, ...interaction.namedParameters }), callbackId };
      case 'SaveValue':
        return { interactionName: 'SaveValue', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ newValue: interaction.newValue }), callbackId };
      case 'Filter': {
        const filterParams: Record<string, unknown> = { filterOperation: interaction.filterOperation, filterColumnId: interaction.filterColumnId };
        if (interaction.filterValue !== undefined) filterParams['FilterValue'] = interaction.filterValue;
        return { interactionName: 'Filter', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify(filterParams), callbackId };
      }
      case 'SetCurrentRow':
        return { interactionName: 'SetCurrentRowAndRowsSelection', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ key: interaction.key, selectAll: false, rowsToSelect: [interaction.key], unselectAll: true, rowsToUnselect: [] }), callbackId };
      case 'ScrollRepeater':
        return { interactionName: 'ScrollRepeater', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ delta: interaction.delta }), callbackId };
      case 'SessionAction':
        return { interactionName: interaction.actionName, namedParameters: JSON.stringify(interaction.namedParameters ?? {}), controlPath: interaction.controlPath ?? 'server:c[0]', callbackId };
    }
  }
}
