// tests/unit/execute-action-schema.test.ts
//
// BC745 #1: bc_execute_action's action/cue exclusivity is enforced at runtime by
// a Zod .refine(). The exclusivity must NOT be emitted as a JSON Schema
// oneOf/anyOf/allOf in the tool's inputSchema: a top-level combinator makes
// Claude Code's MCP client drop the entire tool (verified live, BC745). These
// tests lock the runtime guard AND that the published schema stays a flat object.

import { describe, it, expect } from 'vitest';
import { ExecuteActionSchema, toMcpJsonSchema } from '../../src/mcp/schemas.js';

describe('ExecuteActionSchema runtime validation', () => {
  it('accepts action only', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'x', action: 'Re&lease', quiet: true }).success).toBe(true);
  });
  it('accepts cue only', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'x', cue: 'Sales Quotes' }).success).toBe(true);
  });
  it('rejects both action and cue (even a placeholder cue)', () => {
    const r = ExecuteActionSchema.safeParse({ pageContextId: 'x', action: 'Re&lease', cue: '.' });
    expect(r.success).toBe(false);
  });
  it('rejects neither', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'x' }).success).toBe(false);
  });
});

describe('ExecuteActionSchema -> MCP JSON Schema', () => {
  const js = toMcpJsonSchema(ExecuteActionSchema) as Record<string, any>;

  it('marks only pageContextId as structurally required (action/cue stay optional props)', () => {
    expect(js.required).toEqual(['pageContextId']);
    expect(js.properties.action).toBeDefined();
    expect(js.properties.cue).toBeDefined();
  });

  it('stays a flat object schema with NO top-level combinator (would make the MCP client drop the tool)', () => {
    expect(js.type).toBe('object');
    expect(js.oneOf).toBeUndefined();
    expect(js.anyOf).toBeUndefined();
    expect(js.allOf).toBeUndefined();
  });
});
