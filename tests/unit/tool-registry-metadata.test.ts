// tests/unit/tool-registry-metadata.test.ts
//
// The tool SURFACE (name/description/inputSchema/zodSchema) must be readable with no
// services at all: both entrypoints advertise it before BC is connected. It used to
// be harvested by building the whole service graph on a forged `{} as BCSession`,
// which only worked while no constructor dereferenced the session.

import { describe, it, expect, vi } from 'vitest';
import { TOOL_METADATA, buildToolRegistry, buildLazyToolRegistry, type Operations } from '../../src/mcp/tool-registry.js';

describe('static tool metadata', () => {
  it('is available without any Operations instance', () => {
    expect(TOOL_METADATA.length).toBeGreaterThan(10);
    for (const t of TOOL_METADATA) {
      expect(t.name).toMatch(/^bc_/);
      expect(t.description.length).toBeGreaterThan(100);
      expect(t.inputSchema).toBeTruthy();
      expect(t.zodSchema).toBeTruthy();
    }
  });

  it('buildToolRegistry exposes exactly the same names', () => {
    const names = buildToolRegistry({} as Operations).map(t => t.name);
    expect(names).toEqual(TOOL_METADATA.map(t => t.name));
  });
});

describe('lazy registry', () => {
  it('does not resolve operations until a tool is executed', async () => {
    const openPage = { execute: vi.fn(async () => ({ ok: true, value: {} })) };
    const resolve = vi.fn(async () => ({ openPage }) as unknown as Operations);
    const tools = buildLazyToolRegistry(resolve);

    // Listing / describing must not touch BC.
    expect(tools.map(t => t.name)).toContain('bc_open_page');
    expect(resolve).not.toHaveBeenCalled();

    await tools.find(t => t.name === 'bc_open_page')!.execute({ pageId: '22' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(openPage.execute).toHaveBeenCalledWith({ pageId: '22' });
  });

  it('re-resolves per call, so a recreated session is picked up without rebuilding the list', async () => {
    const first = { execute: vi.fn(async () => ({ ok: true, value: 1 })) };
    const second = { execute: vi.fn(async () => ({ ok: true, value: 2 })) };
    let current = first;
    const tools = buildLazyToolRegistry(async () => ({ openPage: current }) as unknown as Operations);
    const openPage = tools.find(t => t.name === 'bc_open_page')!;

    await openPage.execute({ pageId: '22' });
    current = second;
    await openPage.execute({ pageId: '23' });

    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(second.execute).toHaveBeenCalledTimes(1);
  });
});

describe('descriptions match the implementation', () => {
  const byName = new Map(TOOL_METADATA.map(t => [t.name, t.description]));

  it('bc_navigate no longer advertises a "lookup" action or a "field" parameter', () => {
    const d = byName.get('bc_navigate')!;
    // It may still MENTION lookup — to say it does not exist — but never advertise it.
    expect(d).not.toContain('Action "lookup":');
    expect(d).not.toContain('three actions');
    expect(d).not.toContain('"field": "No."');
    expect(d).toContain('TWO actions');
  });

  it('bc_write_data teaches the requested/changed/reason contract, not "returns an error"', () => {
    const d = byName.get('bc_write_data')!;
    expect(d).not.toContain('writing to a read-only field returns an error');
    expect(d).toContain('changed');
    expect(d).toContain('allSucceeded');
  });

  it('bc_close_page admits the save-changes dialog case', () => {
    const d = byName.get('bc_close_page')!;
    expect(d).toContain('requiresDialogResponse');
    expect(d).toContain('discardChanges');
  });
});
