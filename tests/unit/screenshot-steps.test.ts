// tests/unit/screenshot-steps.test.ts
//
// `steps` on bc_screenshot / bc_build_manual: real browser interactions before a
// capture (pointer clicks, typing, key chords, multi-row selection). The schema
// must admit exactly one kind per step, the published JSON schema must stay flat,
// and the operation must pass steps through and surface their outcomes -- a step
// that did nothing has to reach the caller, never be dropped (same contract as
// `clicks`).

import { describe, it, expect, vi } from 'vitest';
import {
  ScreenshotStepSchema, ScreenshotSchema, BuildManualSchema, toMcpJsonSchema,
} from '../../src/mcp/schemas.js';
import { ScreenshotOperation } from '../../src/operations/screenshot.js';
import type { ScreenshotService, CaptureResult, CaptureInput } from '../../src/services/screenshot-service.js';

describe('ScreenshotStepSchema: exactly one kind per step', () => {
  it('accepts each kind on its own', () => {
    for (const step of [
      { click: 'Todo' },
      { click: 'Agrupar', modifiers: ['Control'] },
      { selector: 'button.ms-nav-actionbar-overflow' },
      { type: 'Cambio de vehiculo', into: 'Motivo del cambio' },
      { type: 'texto sin destino' },
      { press: 'Escape' },
      { press: 'Control+A' },
      { selectRows: ['102318', '102319'] },
      { wait: 500 },
    ]) {
      const r = ScreenshotStepSchema.safeParse(step);
      expect(r.success, JSON.stringify(step)).toBe(true);
    }
  });

  it('rejects an empty step and a step of two kinds', () => {
    expect(ScreenshotStepSchema.safeParse({}).success).toBe(false);
    expect(ScreenshotStepSchema.safeParse({ click: 'Todo', press: 'Enter' }).success).toBe(false);
    expect(ScreenshotStepSchema.safeParse({ wait: 100, selectRows: ['x'] }).success).toBe(false);
  });

  it('rejects qualifiers on the wrong kind', () => {
    // `into` names the field that receives `type`; alone it types nothing anywhere.
    expect(ScreenshotStepSchema.safeParse({ into: 'Motivo' }).success).toBe(false);
    expect(ScreenshotStepSchema.safeParse({ press: 'Enter', into: 'Motivo' }).success).toBe(false);
    // `modifiers` are held during a click; on a keystroke they would be silently ignored.
    expect(ScreenshotStepSchema.safeParse({ type: 'x', modifiers: ['Shift'] }).success).toBe(false);
    expect(ScreenshotStepSchema.safeParse({ click: 'x', modifiers: ['Hyper'] }).success).toBe(false);
  });

  it('selectRows needs at least one token', () => {
    expect(ScreenshotStepSchema.safeParse({ selectRows: [] }).success).toBe(false);
  });
});

describe('steps / debugCaptions are advertised on both capture surfaces', () => {
  it('bc_screenshot accepts steps and debugCaptions', () => {
    const r = ScreenshotSchema.safeParse({
      pageId: 50003,
      steps: [{ click: 'Todo' }, { wait: 300 }],
      debugCaptions: true,
    });
    expect(r.success).toBe(true);
  });

  it('bc_screenshot rejects a malformed step inside the list', () => {
    const r = ScreenshotSchema.safeParse({ pageId: 50003, steps: [{ click: 'Todo', wait: 1 }] });
    expect(r.success).toBe(false);
  });

  it('a bc_build_manual step screenshot accepts steps too', () => {
    const r = BuildManualSchema.safeParse({
      title: 'Agrupar',
      steps: [{
        heading: 'Selecciona dos documentos',
        screenshot: { pageId: 50003, steps: [{ selectRows: ['102318', '102319'] }] },
      }],
    });
    expect(r.success).toBe(true);
  });

  it('the published JSON schema stays flat and lists steps as an array of objects', () => {
    const json = toMcpJsonSchema(ScreenshotSchema) as Record<string, unknown>;
    expect(json.oneOf).toBeUndefined();
    expect(json.anyOf).toBeUndefined();
    expect(json.allOf).toBeUndefined();
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.steps?.type).toBe('array');
    expect((props.steps?.items as Record<string, unknown>).type).toBe('object');
    expect(props.debugCaptions?.type).toBe('boolean');
  });
});

describe('ScreenshotOperation: steps go through, outcomes come back', () => {
  function opWith(result: Partial<CaptureResult>): { op: ScreenshotOperation; capture: ReturnType<typeof vi.fn> } {
    const capture = vi.fn(async (_input: CaptureInput): Promise<CaptureResult> => ({
      path: 'C:/shots/p50003.png', url: 'u', pageTitle: 't', authenticated: true, spaReady: true,
      width: 1600, height: 1000, ...result,
    }));
    const op = new ScreenshotOperation({ capture } as unknown as ScreenshotService);
    return { op, capture };
  }

  it('forwards steps and debugCaptions to the capture engine untouched', async () => {
    const steps = [{ click: 'Todo' }, { type: 'motivo', into: 'Motivo del cambio' }];
    const { op, capture } = opWith({});
    const r = await op.execute({ pageId: 50003, steps, debugCaptions: true });
    expect(r.ok).toBe(true);
    const sent = capture.mock.calls[0]?.[0] as CaptureInput;
    expect(sent.steps).toEqual(steps);
    expect(sent.debugCaptions).toBe(true);
  });

  it('surfaces every step outcome, the captions and the warning', async () => {
    const { op } = opWith({
      steps: [{ step: 'click "Todo"', ok: true }, { step: 'click "Mas opciones"', ok: false, reason: 'not found' }],
      captions: ['Publicar', 'Agrupar', 'Anular documento'],
      warning: 'STEP DID NOTHING: click "Mas opciones" (not found).',
    });
    const r = await op.execute({ pageId: 50003, steps: [{ click: 'Todo' }, { click: 'Mas opciones' }], debugCaptions: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.steps).toEqual([
      { step: 'click "Todo"', ok: true },
      { step: 'click "Mas opciones"', ok: false, reason: 'not found' },
    ]);
    expect(r.value.captions).toEqual(['Publicar', 'Agrupar', 'Anular documento']);
    expect(r.value.warning).toMatch(/STEP DID NOTHING/);
  });
});
