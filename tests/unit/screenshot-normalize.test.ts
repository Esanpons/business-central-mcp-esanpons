import { describe, it, expect } from 'vitest';
import { normalizeHighlight } from '../../src/operations/screenshot.js';

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
