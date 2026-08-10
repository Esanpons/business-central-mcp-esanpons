import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isOk } from '../core/result.js';
import type { PageService } from '../services/page-service.js';
import type { Logger } from '../core/logger.js';
import { buildAllSections } from '../protocol/section-dto.js';

/**
 * Builds and queries a cached index of BC objects (id + name + caption + app) so the
 * agent can resolve a page name/keyword to a numeric ID and open pages BY ID reliably,
 * instead of guessing.
 *
 * Source: the "All Objects with Caption" system page (9174), which lists every object
 * (standard + add-ins + custom) with Object ID / Name / Caption / App Name.
 *
 * Reading mechanism (verified live): the page can't be filtered via the filter pane
 * (no columnBinderPath) and can't be deep-paginated, BUT BC honors a `filter=` in the
 * OpenForm query. So we read by Object ID range and "seek" forward: open filtered to
 * `cursor..to`, take the rows (one window), advance the cursor past the max ID seen,
 * repeat until empty. Sparse ranges (custom/add-ins) are a handful of reads; the full
 * standard range is many (slow) but works on demand.
 */

const OBJECTS_PAGE = '9174';
const SAFETY_MAX_READS = 30000;

/**
 * Page 9174's columns arrive with LOCALIZED captions — English on one environment
 * ("Object ID"), Spanish on another ("Id. objeto"), Catalan on a third. Hardcoding
 * the English names made every row unparseable on a Spanish tenant, and because the
 * refresh then merged an EMPTY result over the cached range, a single run silently
 * wiped a good 14k-object index (observed live on SaaS, 2026-08-09).
 *
 * So the columns are resolved from whatever keys the rows actually carry.
 */
export interface ObjectColumnKeys {
  id: string;
  type: string;
  name: string;
  caption?: string;
  app?: string;
}

/** lowercase, strip accents and every non-letter/digit, so "Id. objeto" -> "idobjeto". */
function normalizeKey(key: string): string {
  return key.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const OBJECT_WORDS = ['object', 'objeto', 'objecte'];
const includesAny = (haystack: string, words: readonly string[]): boolean => words.some((w) => haystack.includes(w));

/**
 * Map the five columns the index needs onto the row's real cell keys.
 * Returns null when the mandatory three (id / type / name) can't be identified —
 * the caller must then fail loudly instead of collecting nothing.
 */
export function resolveObjectColumns(cellKeys: readonly string[]): ObjectColumnKeys | null {
  const norm = cellKeys.map((k) => ({ key: k, n: normalizeKey(k) }));
  // "Subtipo de objeto" / "Object Subtype" must never win the `type` slot.
  const objectCols = norm.filter((c) => includesAny(c.n, OBJECT_WORDS) && !c.n.includes('sub'));

  const id = objectCols.find((c) => c.n.includes('id'))?.key;
  const type = objectCols.find((c) => includesAny(c.n, ['type', 'tipo', 'tipus']))?.key;
  const name = objectCols.find((c) => includesAny(c.n, ['name', 'nombre', 'nom']))?.key;
  const caption = objectCols.find((c) => includesAny(c.n, ['caption', 'titulo', 'titol', 'title']))?.key;
  const app = norm.find((c) => includesAny(c.n, ['app', 'aplicacion', 'aplicacio']))?.key;

  if (!id || !type || !name) return null;
  return { id, type, name, ...(caption ? { caption } : {}), ...(app ? { app } : {}) };
}

/** Compare BC base URLs ignoring case and a trailing slash. */
export function normalizeBaseUrl(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

export interface BcObject {
  type: string;
  id: number;
  name: string;
  caption: string;
  app: string;
}

export interface ObjectIndexFile {
  updatedAt: string;
  baseUrl: string;
  tenantId: string;
  objects: BcObject[];
}

export interface RefreshResult {
  scanned: number;
  totalInIndex: number;
  range: { from: number; to: number };
  reads: number;
  updatedAt: string;
}

export interface FindResult {
  query: string;
  count: number;
  results: BcObject[];
  indexUpdatedAt: string | null;
  note?: string;
}

export class ObjectIndexService {
  constructor(
    private readonly pageService: PageService,
    private readonly stateDir: string,
    private readonly baseUrl: string,
    private readonly tenantId: string,
    private readonly logger: Logger,
  ) {}

  private indexPath(): string {
    const dir = isAbsolute(this.stateDir) ? this.stateDir : resolve(process.cwd(), this.stateDir);
    mkdirSync(dir, { recursive: true });
    return resolve(dir, 'object-index.json');
  }

  /** Raw file contents, or null when absent/corrupt. NOT environment-checked. */
  private loadRaw(): ObjectIndexFile | null {
    const p = this.indexPath();
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as ObjectIndexFile;
      return Array.isArray(parsed?.objects) ? parsed : null;
    } catch {
      return null; // corrupt — start fresh
    }
  }

  private empty(): ObjectIndexFile {
    return { updatedAt: '', baseUrl: this.baseUrl, tenantId: this.tenantId, objects: [] };
  }

  /**
   * The documented two-server setup (bc-docker + bc-saas registered side by side)
   * shares one cwd, so both instances read the SAME .state/object-index.json. The
   * file records which environment built it; an index built elsewhere is treated
   * as EMPTY rather than answering bc_find_object with another environment's object
   * IDs (silently wrong ids are worse than "run bc_refresh_objects").
   */
  private isOwnEnvironment(file: ObjectIndexFile): boolean {
    return normalizeBaseUrl(file.baseUrl) === normalizeBaseUrl(this.baseUrl)
      && (file.tenantId ?? '') === (this.tenantId ?? '');
  }

  private load(): ObjectIndexFile {
    const raw = this.loadRaw();
    if (raw && this.isOwnEnvironment(raw)) return raw;
    return this.empty();
  }

  /** The cached file when it belongs to ANOTHER environment (for the find() note). */
  private foreignIndex(): ObjectIndexFile | null {
    const raw = this.loadRaw();
    return raw && !this.isOwnEnvironment(raw) ? raw : null;
  }

  private save(file: ObjectIndexFile): void {
    writeFileSync(this.indexPath(), JSON.stringify(file, null, 0));
  }

  /**
   * Refresh the index for an Object ID range (default = the custom/add-in space, >= 50000).
   * Pass { all: true } for the full range (standard included) — slow but complete.
   *
   * Page 9174 is sorted by (Object Type, Object ID) and only Object ID can be filtered (the
   * query ignores an Object Type filter, and the filter pane has no columnBinderPath here).
   * A single read returns one ~48-row window, so a plain ID seek would skip later type groups
   * (Pages come after Tables). We instead use ADAPTIVE chunking: read [lo,hi]; if the window
   * looks full (>= WINDOW_FULL, possibly truncated) split it in half and recurse, otherwise the
   * read is complete and we keep its rows. Small enough ranges hold every type in one window,
   * so nothing is skipped. Sparse ranges (custom/add-ins) cost few reads; dense ones (standard)
   * cost many but are correct.
   */
  async refresh(opts?: { from?: number; to?: number; all?: boolean }): Promise<RefreshResult> {
    const from = opts?.all ? 1 : (opts?.from ?? 50000);
    const to = opts?.to ?? 99999999; // covers PTE (50000-99999) AND high ISV ranges
    const WINDOW_FULL = 45; // a read returning >= this many rows may be truncated -> split
    const collected = new Map<string, BcObject>();
    let reads = 0;
    // Resolved once from the first non-empty read, then reused (the page's columns
    // don't change mid-run). `seenKeys` feeds the error message when they can't be.
    let cols: ObjectColumnKeys | null = null;
    let seenKeys: string[] = [];
    // Sub-ranges that were NOT read completely. The merge below replaces the whole
    // [from,to] window with what was collected, so persisting a scan with holes
    // DELETES the objects that live in those holes — the same class of incident as
    // the 0-object wipe. Any hole aborts the save.
    const gaps: Array<{ from: number; to: number; reason: string }> = [];

    const readRange = async (lo: number, hi: number): Promise<void> => {
      if (lo > hi) return;
      if (reads >= SAFETY_MAX_READS) {
        gaps.push({ from: lo, to: hi, reason: `read budget (${SAFETY_MAX_READS}) exhausted` });
        return;
      }
      const r = await this.pageService.openPage(OBJECTS_PAGE, { filters: [{ column: 'Object ID', value: `${lo}..${hi}` }], tenantId: this.tenantId });
      reads++;
      if (!isOk(r)) {
        this.logger.warn(`[objects] refresh open failed for ${lo}..${hi}: ${r.error.message}`);
        gaps.push({ from: lo, to: hi, reason: r.error.message });
        return;
      }
      const rows = buildAllSections(r.value).flatMap((s) => s.rows ?? []);
      await this.pageService.closePage(r.value.pageContextId).catch(() => undefined);
      if (reads % 100 === 0) this.logger.info(`[objects] progress: ${reads} reads, ${collected.size} objects so far (at ${lo}..${hi})`);
      if (rows.length === 0) return;

      if (rows.length >= WINDOW_FULL && lo < hi) {
        // Possibly truncated — split. Discard this partial read; the halves re-read it fully.
        const mid = Math.floor(lo + (hi - lo) / 2);
        await readRange(lo, mid);
        await readRange(mid + 1, hi);
        return;
      }
      if (!cols) {
        seenKeys = Object.keys(rows[0]!.cells);
        cols = resolveObjectColumns(seenKeys);
      }
      if (!cols) return; // reported after the walk — never silently collect nothing
      for (const row of rows) {
        const id = Number(row.cells[cols.id]);
        if (Number.isNaN(id)) continue;
        const type = String(row.cells[cols.type] ?? '');
        collected.set(`${type}:${id}`, {
          type,
          id,
          name: String(row.cells[cols.name] ?? ''),
          caption: cols.caption ? String(row.cells[cols.caption] ?? '') : '',
          app: cols.app ? String(row.cells[cols.app] ?? '') : '',
        });
      }
    };

    await readRange(from, to);

    if (reads > 0 && !cols && seenKeys.length > 0) {
      throw new Error(
        `Could not identify page ${OBJECTS_PAGE}'s columns from [${seenKeys.join(', ')}]. `
        + 'The index was left untouched. Expected an Object ID / Object Type / Object Name column '
        + '(any locale). Extend resolveObjectColumns() with this locale.',
      );
    }
    // A scan with holes must NEVER be merged either: the merge replaces the whole
    // [from,to] window, so every object inside an unread sub-range would be deleted
    // from the saved index (a mid-refresh session death used to do exactly that,
    // silently). Abort loudly instead — same policy as the 0-object guard below.
    if (gaps.length > 0) {
      const existing = this.load();
      const shown = gaps.slice(0, 5).map((g) => `${g.from}..${g.to} (${g.reason})`).join('; ');
      throw new Error(
        `Refresh of range ${from}..${to} could not read ${gaps.length} sub-range(s) — the index was left `
        + `UNTOUCHED (${existing.objects.length} objects, updated ${existing.updatedAt || 'never'}). `
        + `Saving a partial scan would DELETE the objects that live in the unread sub-ranges, because the `
        + `merge replaces everything in [${from},${to}]. Failed: ${shown}`
        + `${gaps.length > 5 ? ` (+${gaps.length - 5} more)` : ''}. `
        + 'Fix the cause (usually a dead/expired BC session — retry) or refresh a narrower range.',
      );
    }
    // A scan that found nothing must NEVER be merged: with `all: true` the merge keeps
    // nothing outside [from,to], so saving an empty result would wipe the whole cache
    // (that is exactly how a good 14k index was lost once).
    if (collected.size === 0) {
      const existing = this.load();
      throw new Error(
        `Refresh of range ${from}..${to} found 0 objects in ${reads} reads — refusing to overwrite the `
        + `existing index (${existing.objects.length} objects, updated ${existing.updatedAt || 'never'}). `
        + 'Check that page 9174 is accessible and returns rows for this range.',
      );
    }

    // Merge: replace everything in [from,to] with the freshly read set (handles deletions).
    const index = this.load();
    const kept = index.objects.filter((o) => o.id < from || o.id > to);
    const merged = [...kept, ...collected.values()].sort((a, b) => (a.type === b.type ? a.id - b.id : a.type.localeCompare(b.type)));
    const updatedAt = new Date().toISOString();
    this.save({ updatedAt, baseUrl: this.baseUrl, tenantId: this.tenantId, objects: merged });

    this.logger.info(`[objects] refreshed range ${from}..${to}: ${collected.size} objects in ${reads} reads (index total ${merged.length})`);
    return { scanned: collected.size, totalInIndex: merged.length, range: { from, to }, reads, updatedAt };
  }

  /** Search the cached index by name/caption (substring, case-insensitive). */
  find(query: string, opts?: { type?: string; limit?: number }): FindResult {
    const index = this.load();
    const limit = opts?.limit ?? 25;
    const q = query.trim().toLowerCase();
    const wantType = opts?.type ? canonType(opts.type) : undefined;

    let results = index.objects.filter((o) => {
      // The Object Type column is localized (e.g. "Página" in a Spanish env) — match on
      // a canonical English token so type:"Page" works regardless of UI language.
      if (wantType && canonType(o.type) !== wantType) return false;
      return o.name.toLowerCase().includes(q) || o.caption.toLowerCase().includes(q) || String(o.id) === q;
    });
    // Rank: exact name/caption first, then startsWith, then by name length.
    results = results.sort((a, b) => rank(a, q) - rank(b, q) || a.name.length - b.name.length);

    let note: string | undefined;
    if (index.objects.length === 0) {
      const foreign = this.foreignIndex();
      note = foreign
        ? `The cached object index was built against a DIFFERENT environment `
          + `(${foreign.baseUrl || 'unknown'} / tenant ${foreign.tenantId || 'unknown'}, `
          + `${foreign.objects.length} objects, updated ${foreign.updatedAt || 'never'}) and was ignored — `
          + `this server talks to ${this.baseUrl} / tenant ${this.tenantId}. `
          + 'Run bc_refresh_objects to build the index for THIS environment (it will replace the cached file).'
        : 'The object index is empty. Run bc_refresh_objects first (default refreshes custom/add-in objects; pass { all: true } for the full standard set).';
    }

    return {
      query,
      count: results.length,
      results: results.slice(0, limit),
      indexUpdatedAt: index.updatedAt || null,
      note,
    };
  }
}

/**
 * Canonicalize a (possibly localized) BC Object Type to an English token, so callers can
 * filter by "Page" even when the environment renders it as "Página", "Seite", etc.
 * Covers EN + ES (the fork's primary locales); extend as needed.
 */
const TYPE_CANON: Record<string, string> = {
  page: 'page', 'página': 'page', pagina: 'page',
  pageextension: 'pageextension',
  table: 'table', tabla: 'table',
  tabledata: 'tabledata',
  tableextension: 'tableextension',
  report: 'report', informe: 'report',
  reportextension: 'reportextension',
  codeunit: 'codeunit',
  query: 'query', consulta: 'query',
  xmlport: 'xmlport',
  enum: 'enum', enumeration: 'enum', 'enumeración': 'enum', 'enumeracion': 'enum',
  enumextension: 'enumextension',
  permissionset: 'permissionset', permissionsetextension: 'permissionsetextension',
  profile: 'profile', perfil: 'profile',
  controladdin: 'controladdin',
};
export function canonType(s: string): string {
  const k = s.trim().toLowerCase();
  return TYPE_CANON[k] ?? k;
}

function rank(o: BcObject, q: string): number {
  const name = o.name.toLowerCase();
  const cap = o.caption.toLowerCase();
  if (name === q || cap === q) return 0;
  if (name.startsWith(q) || cap.startsWith(q)) return 1;
  return 2;
}
