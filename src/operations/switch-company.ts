import { ok, isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';

export interface SwitchCompanyInput {
  companyName: string;
}

export interface SwitchCompanyOutput {
  previousCompany: string;
  newCompany: string;
  invalidatedPageContextIds: string[];
}

export class SwitchCompanyOperation {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
    /**
     * B2: notified with the company the caller asked for, so the session manager can
     * re-apply it after a reconnect. Without this, a session recreated after a crash
     * (or an `al_publish`) silently returns to the server-default company.
     */
    private readonly onCompanySelected?: (companyName: string) => void,
  ) {}

  async execute(input: SwitchCompanyInput): Promise<Result<SwitchCompanyOutput, ProtocolError>> {
    const previousCompany = this.session.companyName;
    const invalidatedIds = this.repo.listPageContextIds();

    const result = await this.session.changeCompany(input.companyName);
    if (!isOk(result)) return result;

    const newCompany = this.session.companyName;
    this.onCompanySelected?.(input.companyName);

    // Invalidate all page contexts -- company switch resets server-side page state
    this.repo.clearAll();

    this.logger.info(`Switched company from "${previousCompany}" to "${newCompany}"`);

    return ok({
      previousCompany,
      newCompany,
      invalidatedPageContextIds: invalidatedIds,
    });
  }
}
