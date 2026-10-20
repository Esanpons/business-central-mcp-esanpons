// tests/unit/recording.test.ts
//
// bc_record: a video of a circuit performed in the real web client. What can be
// asserted without a browser: the schema (same step kinds as bc_screenshot plus
// `hover` / `label`, flat JSON schema), the operation's pass-through and error
// shape, the cursor path (eased, bounded, ends on the target) and the ffmpeg
// lookup (explicit override wins, a missing one says how to install).

import { describe, it, expect, vi } from 'vitest';
import { RecordSchema, ScreenshotStepSchema, toMcpJsonSchema } from '../../src/mcp/schemas.js';
import { RecordOperation } from '../../src/operations/record.js';
import { glidePath, easeInOut, type RecordingService, type RecordResult } from '../../src/services/recording-service.js';
import { ffmpegCandidates, resolveFfmpeg } from '../../src/services/ffmpeg.js';
import { encoderArgs } from '../../src/services/screencast.js';
import { buildToolRegistry, TOOL_METADATA, type Operations } from '../../src/mcp/tool-registry.js';

describe('RecordSchema', () => {
  it('needs pageId and at least one step', () => {
    expect(RecordSchema.safeParse({ pageId: 22 }).success).toBe(false);
    expect(RecordSchema.safeParse({ pageId: 22, steps: [] }).success).toBe(false);
    expect(RecordSchema.safeParse({ pageId: 22, steps: [{ click: 'Nuevo' }] }).success).toBe(true);
  });

  it('accepts hover and label on a step, for screenshots too', () => {
    expect(ScreenshotStepSchema.safeParse({ hover: 'Nuevo' }).success).toBe(true);
    expect(ScreenshotStepSchema.safeParse({ click: 'Nuevo', label: 'Crear un cliente' }).success).toBe(true);
    expect(ScreenshotStepSchema.safeParse({ wait: 500, label: 'Esperar' }).success).toBe(true);
    // hover is a kind of its own: not combinable with a click.
    expect(ScreenshotStepSchema.safeParse({ hover: 'Nuevo', click: 'Nuevo' }).success).toBe(false);
    // label alone is not a step.
    expect(ScreenshotStepSchema.safeParse({ label: 'x' }).success).toBe(false);
  });

  it('accepts the tempo controls and a goto step', () => {
    expect(RecordSchema.safeParse({ pageId: 22, steps: [{ goto: 9301 }], speed: 2, glide: 300, typingDelay: 0, pace: 200 }).success).toBe(true);
    expect(ScreenshotStepSchema.safeParse({ goto: '9301' }).success).toBe(true);
    expect(ScreenshotStepSchema.safeParse({ goto: 9301, click: 'x' }).success).toBe(false);
  });

  it('bounds format and keeps the published JSON schema flat (no root combinator)', () => {
    expect(RecordSchema.safeParse({ pageId: 22, steps: [{ wait: 1 }], format: 'avi' }).success).toBe(false);
    const json = toMcpJsonSchema(RecordSchema) as Record<string, unknown>;
    expect(json.oneOf).toBeUndefined();
    expect(json.anyOf).toBeUndefined();
    expect(json.allOf).toBeUndefined();
    const steps = (json.properties as Record<string, Record<string, unknown>>).steps;
    const item = steps.items as Record<string, unknown>;
    expect(item.oneOf).toBeUndefined();
    expect(item.anyOf).toBeUndefined();
  });
});

describe('RecordOperation', () => {
  const result: RecordResult = {
    path: 'D:/x/page-22.mp4', timelinePath: 'D:/x/page-22.mp4.json', url: 'https://bc/?page=22',
    pageTitle: 'Customers', authenticated: true, durationMs: 12345, width: 1920, height: 1080, fps: 30,
    format: 'mp4',
    steps: [{ index: 1, label: 'Buscar', atMs: 1800, step: 'click "Buscar"', ok: true }],
  };

  it('passes the input through with pageId as a string and returns the service result', async () => {
    const record = vi.fn(async () => result);
    const op = new RecordOperation({ record } as unknown as RecordingService);
    const r = await op.execute({ pageId: 22, steps: [{ click: 'Buscar', label: 'Buscar' }], pace: 800 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(result);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ pageId: '22', pace: 800 }));
  });

  it('turns a thrown error into RECORDING_ERROR with the message intact', async () => {
    const op = new RecordOperation({ record: async () => { throw new Error('No ffmpeg found. install it'); } } as unknown as RecordingService);
    const r = await op.execute({ pageId: 22, steps: [{ wait: 1 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('RECORDING_ERROR');
      expect(r.error.message).toContain('No ffmpeg found');
    }
  });
});

describe('glidePath: the cursor moves like a hand', () => {
  it('is empty for a move of nothing', () => {
    expect(glidePath(10, 10, 10, 10)).toEqual([]);
  });

  it('ends exactly on the target and takes between 350 ms and 1.1 s', () => {
    for (const [x1, y1] of [[50, 20], [900, 600], [1900, 1070]] as const) {
      const path = glidePath(0, 0, x1, y1, 16);
      const last = path[path.length - 1]!;
      expect(Math.abs(last.x - x1)).toBeLessThan(0.01);
      expect(Math.abs(last.y - y1)).toBeLessThan(0.01);
      const total = path.reduce((s, p) => s + p.dt, 0);
      expect(total).toBeGreaterThanOrEqual(350 - 16);
      // + the four overshoot-and-return frames a hand adds at the end
      expect(total).toBeLessThanOrEqual(1100 + 16 * 5);
    }
  });

  it('is eased: slow at both ends, fastest in the middle', () => {
    const path = glidePath(0, 0, 1000, 0);
    const n = path.length;
    const d = (i: number): number => Math.hypot(path[i]!.x - (path[i - 1]?.x ?? 0), path[i]!.y - (path[i - 1]?.y ?? 0));
    expect(d(1)).toBeLessThan(d(Math.floor(n / 2)));
    expect(d(n - 1)).toBeLessThan(d(Math.floor(n / 2)));
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 5);
  });

  it('honours a smaller cap and jumps at 0', () => {
    const slow = glidePath(0, 0, 1000, 0, 16, 1100).reduce((s, p) => s + p.dt, 0);
    const fast = glidePath(0, 0, 1000, 0, 16, 300).reduce((s, p) => s + p.dt, 0);
    expect(fast).toBeLessThan(slow / 2);
    expect(fast).toBeLessThanOrEqual(300 + 16 * 5);
    expect(glidePath(0, 0, 1000, 0, 16, 0)).toEqual([]);
  });

  it('bows away from the straight line but never far', () => {
    const path = glidePath(0, 0, 1000, 0);
    const maxOff = Math.max(...path.map((p) => Math.abs(p.y)));
    expect(maxOff).toBeGreaterThan(5);
    expect(maxOff).toBeLessThanOrEqual(40.01);
  });
});

describe('Screencast encoder command line', () => {
  it('encodes H.264 yuv420p from the JPEG pipe for mp4, VP9 for webm, at the requested rate', () => {
    const mp4 = encoderArgs({ fps: 30, format: 'mp4', path: 'D:/v/out.mp4' });
    expect(mp4).toContain('libx264');
    expect(mp4).toContain('yuv420p');
    expect(mp4.slice(-1)[0]).toBe('D:/v/out.mp4');
    expect(mp4[mp4.indexOf('-framerate') + 1]).toBe('30');
    expect(mp4[mp4.indexOf('-r') + 1]).toBe('30');
    // image2pipe of mjpeg frames on stdin: what the CDP screencast delivers.
    expect(mp4.join(' ')).toContain('-f image2pipe -vcodec mjpeg');
    const webm = encoderArgs({ fps: 24, format: 'webm', path: 'D:/v/out.webm' });
    expect(webm).toContain('libvpx-vp9');
    expect(webm).not.toContain('libx264');
    expect(webm[webm.indexOf('-framerate') + 1]).toBe('24');
  });
});

describe('ffmpeg lookup', () => {
  it('BC_FFMPEG wins when it exists and fails loudly when it does not', () => {
    expect(resolveFfmpeg({ BC_FFMPEG: process.execPath })).toBe(process.execPath);
    expect(() => resolveFfmpeg({ BC_FFMPEG: 'Z:/nowhere/ffmpeg.exe' })).toThrow(/BC_FFMPEG points to a missing file/);
  });

  it('probes the pip / winget / classic locations under LOCALAPPDATA', () => {
    const c = ffmpegCandidates({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    expect(c).toContain('C:\\ffmpeg\\bin\\ffmpeg.exe');
    expect(c).toContain('/usr/bin/ffmpeg');
  });
});

describe('bc_record tool', () => {
  it('is registered with a description that says what it does not do', () => {
    const meta = TOOL_METADATA.find((t) => t.name === 'bc_record');
    expect(meta).toBeDefined();
    expect(meta!.description).toContain('REAL client');
    expect(meta!.description).toContain('bc_screenshot');
    expect(meta!.description).toContain('BC_RECORDING_DIR');
    expect(meta!.description).toContain('ffmpeg');
  });

  it('routes to ops.record', async () => {
    const execute = vi.fn(async () => ({ ok: true, value: {} }));
    const tools = buildToolRegistry({ record: { execute } } as unknown as Operations);
    await tools.find((t) => t.name === 'bc_record')!.execute({ pageId: 22, steps: [{ wait: 1 }] });
    expect(execute).toHaveBeenCalledOnce();
  });
});
