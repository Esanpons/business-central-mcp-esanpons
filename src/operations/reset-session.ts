import { ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export interface ResetSessionInput {
  // No parameters: a reset is unconditional by design. Anything that could make it
  // partial (keep this page, keep that dialog) would reintroduce exactly the state
  // this exists to discard.
}

export interface ResetSessionOutput {
  success: boolean;
  /** The company the old session was on. */
  previousCompany: string;
  /** The company BUSINESS CENTRAL granted the NEW session, read from its OpenSession response. */
  newCompany: string;
  /** Page contexts destroyed by the reset. Every one of them is now unusable. */
  invalidatedPageContextIds: string[];
  /** Forms BC had open on the old session — zero on the new one by construction. */
  droppedOpenForms: number;
  /** Modal depth of the old session — likewise zero on the new one. */
  droppedModalDepth: number;
}

/**
 * Throw the BC session away and open a fresh one.
 *
 * Until this existed there was NO way back to a clean state: bc_close_page closes one
 * page at a time, does not accept `all`, and does not lower `modalDepth` — it was
 * observed RAISING it (2 -> 3) while closing pages, because closing a page with
 * unsaved changes makes BC put up another modal. A session with a modal BC is holding
 * on to gets progressively less usable, and the only remedy was for a person to
 * restart the MCP server process (bc-saas F-39 §4 ter).
 *
 * `openFormIds` and the modal stack are per-SESSION state, so replacing the session is
 * what actually clears them; nothing sent over the old one can. The pinned company is
 * preserved across the reset, so this never doubles as a silent company change.
 *
 * Cost: every open page dies. That is the point, and it is why this reports the
 * invalidated ids rather than pretending they survived.
 */
export class ResetSessionOperation {
  constructor(
    /** Session-level reset: tear down, open a new session on the same company. */
    private readonly resetSession: () => Promise<{
      previousCompany: string;
      newCompany: string;
      invalidatedPageContextIds: string[];
      previousOpenForms: number;
      previousModalDepth: number;
    }>,
    private readonly logger: Logger,
  ) {}

  async execute(_input: ResetSessionInput): Promise<Result<ResetSessionOutput, ProtocolError>> {
    // A failure here throws (session-create failure), which the MCP handler already
    // translates with the reason and what to do about it. It must NOT be softened
    // into a success-shaped result: a reset that did not happen leaves the caller
    // believing the state is clean when it is exactly as dirty as before.
    const r = await this.resetSession();
    this.logger.info(`Session reset on company "${r.newCompany}"`);
    return ok({
      success: true,
      previousCompany: r.previousCompany,
      newCompany: r.newCompany,
      invalidatedPageContextIds: r.invalidatedPageContextIds,
      droppedOpenForms: r.previousOpenForms,
      droppedModalDepth: r.previousModalDepth,
    });
  }
}
