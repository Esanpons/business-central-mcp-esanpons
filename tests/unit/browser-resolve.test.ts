// tests/unit/browser-resolve.test.ts
//
// Every out-of-band feature (bc_screenshot, bc_download_report, bc_build_manual)
// dies at the same point when no browser is found, so the candidate list is a
// user-visible contract. Two installs used to be missed: a per-user Chrome (no
// admin rights -> %LOCALAPPDATA%) and the 64-bit Edge under Program Files.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromeCandidates, resolveChrome } from '../../src/services/browser.js';

const savedOverride = process.env.BC_SCREENSHOT_CHROME;
const savedLocalAppData = process.env.LOCALAPPDATA;

afterEach(() => {
  if (savedOverride === undefined) delete process.env.BC_SCREENSHOT_CHROME;
  else process.env.BC_SCREENSHOT_CHROME = savedOverride;
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocalAppData;
});

describe('chromeCandidates', () => {
  it('includes the per-user Chrome install under %LOCALAPPDATA%', () => {
    process.env.LOCALAPPDATA = 'C:\\Users\\someone\\AppData\\Local';
    expect(chromeCandidates()).toContain('C:\\Users\\someone\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
  });

  it('includes BOTH the 64-bit and the 32-bit Edge locations', () => {
    const c = chromeCandidates();
    expect(c).toContain('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(c).toContain('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  });

  it('still covers machine-wide Chrome, Linux and macOS', () => {
    const c = chromeCandidates();
    expect(c).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(c).toContain('/usr/bin/google-chrome');
    expect(c).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('prefers Chrome over Edge', () => {
    const c = chromeCandidates();
    expect(c.findIndex((x) => x.includes('chrome.exe'))).toBeLessThan(c.findIndex((x) => x.includes('msedge.exe')));
  });

  it('omits the per-user path entirely when %LOCALAPPDATA% is unset', () => {
    delete process.env.LOCALAPPDATA;
    expect(chromeCandidates().some((c) => c.includes('undefined'))).toBe(false);
  });
});

describe('resolveChrome', () => {
  it('uses BC_SCREENSHOT_CHROME when it points at a real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-chrome-'));
    const exe = join(dir, 'chrome.exe');
    writeFileSync(exe, '');
    process.env.BC_SCREENSHOT_CHROME = exe;
    try {
      expect(resolveChrome()).toBe(exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly (rather than falling back) when the override is wrong', () => {
    process.env.BC_SCREENSHOT_CHROME = join(tmpdir(), 'definitely-not-here-chrome.exe');
    expect(() => resolveChrome()).toThrow(/BC_SCREENSHOT_CHROME points to a missing file/);
  });
});
