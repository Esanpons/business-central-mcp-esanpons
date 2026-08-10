// tests/unit/object-index-guards.test.ts
//
// The object index is a CACHE that a refresh rewrites wholesale for the scanned
// range. Two ways that has silently destroyed a good index:
//   1. a scan with holes (failed openPage / exhausted read budget) merged as if it
//      were complete -> every object inside the hole is deleted;
//   2. the file being read by the OTHER server of the documented two-registration
//      setup (bc-docker + bc-saas share one cwd) -> answers with foreign object IDs.
// Both are guarded here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { err } from '../../src/core/result.js';
import { ObjectIndexService, normalizeBaseUrl, type ObjectIndexFile } from '../../src/services/object-index-service.js';
import type { PageService } from '../../src/services/page-service.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const BASE = 'https://devel1/BC';
const TENANT = 'default';

let dir: string;

const existing: ObjectIndexFile = {
  updatedAt: '2026-08-01T00:00:00.000Z',
  baseUrl: BASE,
  tenantId: TENANT,
  objects: [
    { type: 'Page', id: 50100, name: 'AESVA Setup', caption: 'AESVA Setup', app: 'AESVA' },
    { type: 'Page', id: 50200, name: 'AESVA Log', caption: 'AESVA Log', app: 'AESVA' },
  ],
};

function indexFile(): string {
  return resolve(dir, 'object-index.json');
}

function writeIndex(file: ObjectIndexFile): void {
  writeFileSync(indexFile(), JSON.stringify(file));
}

/** A page service whose openPage always fails — every sub-range becomes a hole. */
function failingPages(): PageService {
  return {
    openPage: async () => err(new Error('InvalidSessionException: session is dead')),
    closePage: async () => undefined,
  } as unknown as PageService;
}

function service(pages: PageService, baseUrl = BASE, tenantId = TENANT): ObjectIndexService {
  return new ObjectIndexService(pages, dir, baseUrl, tenantId, logger);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bc-objidx-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ObjectIndexService.refresh -- partial-scan guard', () => {
  it('aborts instead of merging a scan whose sub-ranges could not be read', async () => {
    writeIndex(existing);
    await expect(service(failingPages()).refresh({ from: 50000, to: 60000 }))
      .rejects.toThrow(/could not read 1 sub-range/i);
  });

  it('leaves the cached index byte-for-byte untouched when it aborts', async () => {
    writeIndex(existing);
    const before = readFileSync(indexFile(), 'utf8');
    await expect(service(failingPages()).refresh({ from: 50000, to: 60000 })).rejects.toThrow();
    expect(readFileSync(indexFile(), 'utf8')).toBe(before);
  });

  it('names the failed range and its cause so the caller can act', async () => {
    writeIndex(existing);
    await expect(service(failingPages()).refresh({ from: 50000, to: 60000 }))
      .rejects.toThrow(/50000\.\.60000 \(InvalidSessionException/);
  });

  it('reports how much would have been lost (the existing index size)', async () => {
    writeIndex(existing);
    await expect(service(failingPages()).refresh({ from: 50000, to: 60000 }))
      .rejects.toThrow(/2 objects/);
  });

  it('never creates an index file when the very first scan fails', async () => {
    await expect(service(failingPages()).refresh({ from: 50000, to: 60000 })).rejects.toThrow();
    expect(existsSync(indexFile())).toBe(false);
  });
});

describe('ObjectIndexService.find -- environment scoping', () => {
  const pages = { openPage: async () => err(new Error('unused')) } as unknown as PageService;

  it('serves the cached index when it was built by THIS environment', () => {
    writeIndex(existing);
    const r = service(pages).find('AESVA');
    expect(r.count).toBe(2);
    expect(r.note).toBeUndefined();
  });

  it('ignores an index built against a different baseUrl', () => {
    writeIndex({ ...existing, baseUrl: 'https://businesscentral.dynamics.com/abc/Dev' });
    const r = service(pages).find('AESVA');
    expect(r.count).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.note).toMatch(/DIFFERENT environment/);
    expect(r.note).toMatch(/businesscentral\.dynamics\.com/);
    expect(r.note).toMatch(/bc_refresh_objects/);
  });

  it('ignores an index built against a different tenant', () => {
    writeIndex({ ...existing, tenantId: 'other-tenant' });
    const r = service(pages).find('AESVA');
    expect(r.count).toBe(0);
    expect(r.note).toMatch(/other-tenant/);
  });

  it('tolerates a trailing slash / different casing in the stored baseUrl', () => {
    writeIndex({ ...existing, baseUrl: 'https://DEVEL1/BC/' });
    expect(service(pages).find('AESVA').count).toBe(2);
  });

  it('keeps the plain "index is empty" note when there is no cached file at all', () => {
    const r = service(pages).find('AESVA');
    expect(r.count).toBe(0);
    expect(r.note).toMatch(/index is empty/i);
    expect(r.note).not.toMatch(/DIFFERENT environment/);
  });
});

describe('normalizeBaseUrl', () => {
  it('ignores case and trailing slashes', () => {
    expect(normalizeBaseUrl('https://Devel1/BC/')).toBe(normalizeBaseUrl('https://devel1/BC'));
    expect(normalizeBaseUrl(undefined)).toBe('');
  });
});
