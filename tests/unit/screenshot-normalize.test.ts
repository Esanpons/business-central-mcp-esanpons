import { describe, it, expect } from 'vitest';
import { normalizeHighlight, ScreenshotOperation } from '../../src/operations/screenshot.js';
import type { ScreenshotService, CaptureResult } from '../../src/services/screenshot-service.js';

function opWith(result: Partial<CaptureResult>): ScreenshotOperation {
  return new ScreenshotOperation({
    capture: async (): Promise<CaptureResult> => ({
      path: 'C:/shots/p21.png', url: 'u', pageTitle: 't', authenticated: true, spaReady: true,
      width: 1600, height: 1000, ...result,
    }),
  } as unknown as ScreenshotService);
}

describe('normalizeHighlight', () => {
  it('returns [] for undefined', () => {
    expect(normalizeHighlight(undefined)).toEqual([]);
  });

  it('a single string -> one box', () => {
    expect(normalizeHighlight('Name')).toEqual([{ target: 'Name', style: 'box' }]);
  });

  it('a string[] -> auto-numbered badges', () => {
    expect(normalizeHighlight(['No.', 'Name', 'City'])).toEqual([
      { target: 'No.', label: '1', style: 'badge' },
      { target: 'Name', label: '2', style: 'badge' },
      { target: 'City', label: '3', style: 'badge' },
    ]);
  });

  it('an Annotation[] is passed through unchanged', () => {
    const anns = [{ target: 'Post', style: 'arrow' as const, label: 'click' }];
    expect(normalizeHighlight(anns)).toEqual(anns);
  });
});

describe('ScreenshotOperation -- redaction reporting (security)', () => {
  it('surfaces every redaction outcome and the loud warning', async () => {
    // A redact caption that matched nothing means the PNG still SHOWS the value.
    // Dropping that outcome made a leaking capture look perfectly clean.
    const r = await opWith({
      redactions: [{ target: 'IBAN', found: false }, { target: 'Balance', found: true }],
      warning: 'REDACTION FAILED: [IBAN] matched no control',
    }).execute({ pageId: 21, redact: ['IBAN', 'Balance'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.redactions).toEqual([{ target: 'IBAN', found: false }, { target: 'Balance', found: true }]);
    expect(r.value.warning).toMatch(/REDACTION FAILED/);
  });

  it('carries no warning when every redaction landed', async () => {
    const r = await opWith({ redactions: [{ target: 'IBAN', found: true }] })
      .execute({ pageId: 21, redact: ['IBAN'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.warning).toBeUndefined();
    expect(r.value.redactions).toEqual([{ target: 'IBAN', found: true }]);
  });

  it('keeps the inline image out of the plain result fields', async () => {
    const r = await opWith({ base64: 'AAAA' }).execute({ pageId: 21 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.__image).toEqual({ data: 'AAAA', mimeType: 'image/png' });
    expect((r.value as Record<string, unknown>).base64).toBeUndefined();
  });
});
