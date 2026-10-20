import { describe, it, expect } from 'vitest';
import { buildToolRegistry, type Operations } from '../../src/mcp/tool-registry.js';

const mockOps = {
  openPage: { execute: async () => ({}) },
  readData: { execute: async () => ({}) },
  writeData: { execute: async () => ({}) },
  executeAction: { execute: async () => ({}) },
  closePage: { execute: async () => ({}) },
  searchPages: { execute: async () => ({}) },
  navigate: { execute: async () => ({}) },
  respondDialog: { execute: async () => ({}) },
  switchCompany: { execute: async () => ({}) },
  listCompanies: { execute: async () => ({}) },
  runReport: { execute: async () => ({}) },
} as unknown as Operations;

describe('tool descriptions', () => {
  const tools = buildToolRegistry(mockOps);

  it('every tool has at least 3 sentences in description', () => {
    for (const tool of tools) {
      const sentences = tool.description.split(/[.!?]+/).filter(s => s.trim().length > 0);
      expect(sentences.length, `${tool.name} has only ${sentences.length} sentences`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every tool description mentions related tools', () => {
    for (const tool of tools) {
      const otherTools = tools.filter(t => t.name !== tool.name);
      const mentionsOther = otherTools.some(t => tool.description.includes(t.name));
      expect(mentionsOther, `${tool.name} does not mention any other bc_ tool`).toBe(true);
    }
  });

  // bc-saas F-62: the PAGE_OPEN_REJECTED hint and the bc_open_page description
  // proposed filters: [{ field: ... }], which the schema rejects ("filters[0].column:
  // expected string"). Copying the hint must give a call that validates.
  it('never proposes a filter keyed by "field" (the schema key is "column")', () => {
    for (const tool of tools) {
      expect(tool.description, tool.name).not.toMatch(/filters:\s*\[\s*\{\s*field:/);
    }
    expect(tools.find(t => t.name === 'bc_open_page')!.description).toContain('{ column: "No.", value: "<doc no>" }');
  });

  it('bc_respond_dialog explains request pages, errors and opened pages (F-55, F-56, F-65)', () => {
    const d = tools.find(t => t.name === 'bc_respond_dialog')!.description;
    expect(d).toContain('REQUEST PAGE');
    expect(d).toContain('"files"');
    expect(d).toContain('"errors"');
    expect(d).toContain('Error Messages');
  });

  it('bc_write_data explains newLineBookmark (F-60, F-70)', () => {
    const d = tools.find(t => t.name === 'bc_write_data')!.description;
    expect(d).toContain('newLineBookmark');
    expect(d).toContain('APPENDS');
  });

  it('bc_execute_action describes create/delete workflow', () => {
    const tool = tools.find(t => t.name === 'bc_execute_action')!;
    expect(tool.description).toContain('New');
    expect(tool.description).toContain('Delete');
  });

  it('bc_respond_dialog describes dialog chaining', () => {
    const tool = tools.find(t => t.name === 'bc_respond_dialog')!;
    expect(tool.description).toContain('chain');
  });

  it('bc_write_data documents that raw events are opt-in (F-42)', () => {
    const tool = tools.find(t => t.name === 'bc_write_data')!;
    expect(tool.description).toContain('includeEvents');
    expect(tool.description).toContain('quiet');
  });

  it('bc_execute_action documents BC messages and the error text (F-44)', () => {
    const tool = tools.find(t => t.name === 'bc_execute_action')!;
    expect(tool.description).toContain('messages');
    expect(tool.description).toMatch(/kind/);
  });

  it('bc_close_page says which answer discards (F-47 b: yes, measured live)', () => {
    const tool = tools.find(t => t.name === 'bc_close_page')!;
    expect(tool.description).toMatch(/"yes" = discard/);
  });
});
