import { ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export interface SwitchCompanyInput {
  companyName: string;
}

export interface SwitchCompanyOutput {
  previousCompany: string;
  /** The company BUSINESS CENTRAL granted, read back from its OpenSession response. */
  newCompany: string;
  /** Page contexts destroyed by the switch. Re-open anything you still need. */
  invalidatedPageContextIds: string[];
  /**
   * True when the session had to be re-opened to make the switch stick — which is
   * the normal path, because BC binds a session to its company at OpenSession.
   */
  sessionReopened: boolean;
}

/**
 * The result of this operation is only ever built from what BC reported.
 *
 * It used to send the live-session ChangeCompany action, write the REQUESTED name
 * into the session, and report that as the new company. BC answers that action with
 * a bare InvokeCompleted (verified live on devel1: no SessionSettingsChanged, no
 * CompanyName) and goes on serving the old company's data — so the tool announced a
 * switch that had not happened, bc_health repeated it, and a caller could validate
 * one company's configuration while actually reading another's (bc-saas F-11).
 *
 * The switch is now performed the way the web client performs it: by re-opening the
 * session on the target company (`?company=`), and confirmed against the
 * `CompanyName` BC returns. If BC grants a different company, the manager throws
 * rather than hand back a result that looks correct.
 */
export class SwitchCompanyOperation {
  constructor(
    /** Session-level switch: tears down, re-opens on the company, confirms. */
    private readonly switchSessionCompany: (companyName: string) => Promise<{
      previousCompany: string;
      newCompany: string;
      invalidatedPageContextIds: string[];
    }>,
    private readonly logger: Logger,
    /**
     * B2: notified with the company the caller asked for, so the session manager can
     * re-apply it after a reconnect. Without this, a session recreated after a crash
     * (or an `al_publish`) silently returns to the server-default company.
     */
    private readonly onCompanySelected?: (companyName: string) => void,
  ) {}

  async execute(input: SwitchCompanyInput): Promise<Result<SwitchCompanyOutput, ProtocolError>> {
    // A failure here throws (SessionLostError / session-create failure), which the
    // MCP handler already translates: both carry what the caller has to do next, and
    // neither may be softened into a success-shaped result.
    const r = await this.switchSessionCompany(input.companyName);
    this.onCompanySelected?.(r.newCompany);
    this.logger.info(`Switched company from "${r.previousCompany}" to "${r.newCompany}"`);
    return ok({ ...r, sessionReopened: true });
  }
}
