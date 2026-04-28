// tests/unit/modal-stack.test.ts
import { describe, it, expect } from 'vitest';
import { ModalStack } from '../../src/session/modal-stack.js';

describe('ModalStack', () => {
  it('push and peek return LIFO order', () => {
    const s = new ModalStack();
    s.push('a');
    s.push('b');
    expect(s.peek()).toBe('b');
    expect(s.size).toBe(2);
  });

  it('pop returns and removes the topmost id', () => {
    const s = new ModalStack();
    s.push('a');
    s.push('b');
    expect(s.pop()).toBe('b');
    expect(s.peek()).toBe('a');
    expect(s.size).toBe(1);
  });

  it('remove deletes an arbitrary id without disturbing order', () => {
    const s = new ModalStack();
    s.push('a');
    s.push('b');
    s.push('c');
    s.remove('b');
    expect(s.snapshot()).toEqual(['a', 'c']);
  });

  it('push deduplicates an already-tracked id', () => {
    const s = new ModalStack();
    s.push('a');
    s.push('a');
    expect(s.snapshot()).toEqual(['a']);
  });

  it('snapshot returns a defensive copy', () => {
    const s = new ModalStack();
    s.push('a');
    const snap = s.snapshot();
    snap.push('b');
    expect(s.snapshot()).toEqual(['a']);
  });

  it('clear empties the stack', () => {
    const s = new ModalStack();
    s.push('a');
    s.clear();
    expect(s.size).toBe(0);
    expect(s.peek()).toBeUndefined();
  });
});
