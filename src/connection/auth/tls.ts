// Per-connection TLS relaxation for a self-signed on-prem BC.
//
// The historical answer was NODE_TLS_REJECT_UNAUTHORIZED=0, which turns
// certificate validation off for EVERY TLS socket the process opens -- including
// unrelated HTTP clients running in the same process. `BC_TLS_INSECURE=1` scopes
// the opt-out to the connections bc-mcp makes to the BC host:
//
//   - the WebSocket upgrade  -> `rejectUnauthorized: false` in the `ws` options
//     (a real per-socket option; see ConnectionFactory).
//   - the auth provider's /SignIn fetches -> an undici dispatcher whose TLS
//     options apply to that request only (see `insecureFetch` below).
//
// Node's global `fetch` has no standard per-request TLS knob, so the dispatcher
// comes from the `undici` module. If it cannot be loaded, we fall back to
// toggling NODE_TLS_REJECT_UNAUTHORIZED around the single request (ref-counted,
// restored afterwards) -- narrower in time than setting it for the whole process,
// but still process-wide for the duration of that request.

/* eslint-disable @typescript-eslint/no-explicit-any */

let dispatcherPromise: Promise<unknown | null> | null = null;

/** Lazily build (once) an undici Agent that skips certificate verification. */
async function insecureDispatcher(): Promise<unknown | null> {
  if (!dispatcherPromise) {
    dispatcherPromise = (async () => {
      try {
        const undici: any = await import('undici');
        if (!undici?.Agent) return null;
        return new undici.Agent({ connect: { rejectUnauthorized: false } });
      } catch {
        return null;
      }
    })();
  }
  return dispatcherPromise;
}

let envOverrideDepth = 0;
let savedEnvValue: string | undefined;

/**
 * `fetch` that optionally accepts an untrusted certificate. `insecure=false`
 * (the default everywhere) is a plain `fetch` call -- byte-for-byte the previous
 * behaviour.
 */
export async function insecureFetch(
  url: string,
  init: RequestInit,
  insecure: boolean,
): Promise<Response> {
  if (!insecure) return fetch(url, init);

  const dispatcher = await insecureDispatcher();
  if (dispatcher) {
    // `dispatcher` is an undici-specific RequestInit extension.
    return fetch(url, { ...init, dispatcher } as RequestInit);
  }

  // Fallback: no undici module available. Relax globally for the duration of
  // this request only, ref-counted so concurrent calls restore correctly.
  if (envOverrideDepth === 0) {
    savedEnvValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  envOverrideDepth += 1;
  try {
    return await fetch(url, init);
  } finally {
    envOverrideDepth -= 1;
    if (envOverrideDepth === 0) {
      if (savedEnvValue === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedEnvValue;
    }
  }
}
