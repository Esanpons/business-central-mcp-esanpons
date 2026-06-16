/**
 * Translates raw Business Central / .NET / transport error strings into clear,
 * actionable messages for the MCP caller (the LLM and, through it, the user).
 *
 * IMPORTANT: this runs only at the OUTPUT boundary (the MCP handler), never inside
 * the session/websocket layer. Upstream code (e.g. bc-session.ts) pattern-matches on
 * the RAW message to detect session death and modal violations, so the raw string
 * must stay intact until it reaches here.
 */

export interface TranslatedError {
  /** Friendly, actionable message (already includes the hint, if any). */
  message: string;
  /** Stable machine code for the category. */
  code: string;
}

interface Rule {
  test: RegExp;
  code: string;
  message: string;
  hint?: string;
}

const RULES: Rule[] = [
  {
    test: /LogicalModalityViolationException/i,
    code: 'MODAL_STUCK',
    message: 'A dialog from a previous action was left open in Business Central, so the session was reset.',
    hint: 'Re-open the pages you were working with and retry. If it persists, the BC user may have a dialog open in another browser window.',
  },
  {
    test: /InvalidSessionException|"code"\s*:\s*1\b/i,
    code: 'SESSION_LOST',
    message: 'The Business Central session was lost.',
    hint: 'It reconnects automatically; re-open any pages you had open and retry.',
  },
  {
    test: /NavCancelCredentialPromptException/i,
    code: 'AUTH_APPLICATION_ID',
    message: 'Business Central cancelled the credential prompt while opening the session.',
    hint: 'This usually means BC_APPLICATION_ID is wrong for this build (BC 27 expects "NAV").',
  },
  {
    test: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang ?up|fetch failed|getaddrinfo/i,
    code: 'CONNECTION',
    message: 'Could not reach the Business Central server.',
    hint: 'Is the BC container/service running and reachable at BC_BASE_URL? Check the URL and network. For self-signed on-prem TLS, set NODE_TLS_REJECT_UNAUTHORIZED=0.',
  },
  {
    test: /self.?signed|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|unable to verify|certificate/i,
    code: 'TLS',
    message: 'The Business Central TLS certificate could not be verified.',
    hint: 'For a self-signed on-prem BC, set NODE_TLS_REJECT_UNAUTHORIZED=0.',
  },
  {
    test: /InvalidBookmarkException|invalid bookmark/i,
    code: 'BOOKMARK',
    message: 'The record bookmark is no longer valid.',
    hint: 'Re-open the list and use a fresh bookmark from the current rows.',
  },
  {
    test: /ArgumentOutOfRangeException/i,
    code: 'ROW_TARGET',
    message: 'Business Central rejected the row/control target.',
    hint: 'The row selection may be stale — refresh the list (bc_read_data) and retry with a current bookmark.',
  },
  {
    test: /\b(TimeoutError|timed? ?out)\b/i,
    code: 'TIMEOUT',
    message: 'The operation timed out waiting for Business Central.',
    hint: 'BC may be busy or doing a slow cold-load; retry. You can raise BC_INVOKE_TIMEOUT if it is consistently slow.',
  },
];

/**
 * Pull a human-readable core out of a raw error string. Many raw messages are
 * `JSON-RPC error: {"code":..,"message":"..","data":{"exceptionMessage":".."}}`.
 */
function extractCore(raw: string): string {
  const m = raw.match(/JSON-RPC error:\s*(\{[\s\S]*\})\s*$/);
  if (m && m[1]) {
    try {
      const obj = JSON.parse(m[1]) as Record<string, unknown>;
      const data = obj.data as Record<string, unknown> | undefined;
      const inner =
        (data && (data.exceptionMessage as string)) ||
        (data && (data.message as string)) ||
        (obj.message as string);
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    } catch {
      /* not JSON — fall through */
    }
  }
  return raw;
}

export function translateBcError(raw: string): TranslatedError {
  const text = raw ?? '';
  for (const r of RULES) {
    if (r.test.test(text)) {
      return { code: r.code, message: r.hint ? `${r.message} ${r.hint}` : r.message };
    }
  }
  // No specific rule — return a cleaned-up core message so the caller at least
  // gets the BC exception text rather than a JSON-RPC envelope.
  const core = extractCore(text);
  return { code: 'BC_ERROR', message: core || 'Unknown Business Central error.' };
}
