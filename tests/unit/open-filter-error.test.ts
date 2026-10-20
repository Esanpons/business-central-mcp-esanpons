// bc-saas F-68 b / F-63: bc_open_page / bc_read_data with a filter keyed by a CAPTION
// ("Nº", "Tipo de documento origen", "Este almacén hace transporte") answered only
// "Se produjo un error". Measured live on devel1 (BC27, 2026-10-04): BC rejects the
// OpenForm with Microsoft.Dynamics.Nav.Client.ExtendedUriFormatException and nothing
// else; the session survives. The error must say why and which filter it was.
import { describe, it, expect, vi } from 'vitest';
import { PageService } from '../../src/services/page-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';

const BC = 'JSON-RPC error: {"code":2,"data":null,"detailedMessage":"","errorType":"Microsoft.Dynamics.Nav.Client.ExtendedUriFormatException","message":"Se produjo un error"}';

function svc(alive: boolean) {
  const session = {
    invoke: async () => err(new ProtocolError(BC)),
    removeOpenForm: vi.fn(),
    get isAlive() { return alive; },
  } as never;
  return new PageService(session, new PageContextRepository(), { info() {}, warn() {}, error() {}, debug() {} } as never, { tenantId: 'default', authMode: 'UserPassword' });
}

describe('a refused filtered open explains itself (F-68 b)', () => {
  it('names the filter and says columns are AL field names, keeping BC\'s own text', async () => {
    const r = await svc(true).openPage('130', { filters: [{ column: 'Nº', value: '102418' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("'Nº' = '102418'");
    expect(r.error.message).toContain('AL field NAME');
    expect(r.error.message).toContain('ExtendedUriFormatException');
  });

  it('leaves the error untouched without filters, or when the session died', async () => {
    const a = await svc(true).openPage('130');
    expect(!a.ok && a.error.message).toBe(BC);
    const b = await svc(false).openPage('130', { filters: [{ column: 'Nº', value: 'x' }] });
    expect(!b.ok && b.error.message).toBe(BC);
  });
});
