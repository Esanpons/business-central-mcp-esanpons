// tests/unit/search-service-cleanup.test.ts
//
// The Tell Me form must be closed on EVERY exit path. When the close sat on the
// happy path only, a transient error left the form in session.openFormIds — and
// openFormIds is re-sent with every subsequent request, which is exactly the
// server-side form growth the close was added to prevent.

import { describe, it, expect, vi } from 'vitest';
import { SearchService } from '../../src/services/search-service.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeSession(behaviour: { failOnQuery?: boolean; throwOnQuery?: boolean }) {
  const sent: string[] = [];
  const removed: string[] = [];
  let saves = 0;
  const session = {
    invoke: async (interaction: { type: string }) => {
      sent.push(interaction.type);
      if (interaction.type === 'SessionAction') {
        return ok([{ type: 'FormCreated', formId: 'tellme1', controlTree: { t: 'lf', ServerId: 'tellme1', PageType: 1, Children: [] } } as BCEvent]);
      }
      if (interaction.type === 'SaveValue') {
        saves += 1;
        if (saves === 2 && behaviour.throwOnQuery) throw new Error('socket closed');
        if (saves === 2 && behaviour.failOnQuery) return err(new ProtocolError('BC rejected the search'));
      }
      return ok([]);
    },
    removeOpenForm: (formId: string) => { removed.push(formId); },
  } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  return { service: new SearchService(session, logger), sent, removed };
}

describe('SearchService Tell Me form cleanup', () => {
  it('closes the form after a successful search', async () => {
    const { service, sent, removed } = makeSession({});
    const r = await service.search('customer');
    expect(r.ok).toBe(true);
    expect(sent).toContain('CloseForm');
    expect(removed).toEqual(['tellme1']);
  });

  it('closes the form when the search returns an error', async () => {
    const { service, sent, removed } = makeSession({ failOnQuery: true });
    const r = await service.search('customer');
    expect(r.ok).toBe(false);
    expect(sent).toContain('CloseForm');
    expect(removed).toEqual(['tellme1']);
  });

  it('closes the form when the invoke throws', async () => {
    const { service, sent, removed } = makeSession({ throwOnQuery: true });
    await expect(service.search('customer')).rejects.toThrow('socket closed');
    expect(sent).toContain('CloseForm');
    expect(removed).toEqual(['tellme1']);
  });
});
