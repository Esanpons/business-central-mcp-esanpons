import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchHeadless } from './browser.js';

/**
 * Measures where the printable A4 page breaks actually fall.
 *
 * This is the bridge between the two ways of paginating a document. The HTML
 * output paginates by MEASUREMENT: the bundled paginator measures each unit
 * against the real height of a sheet and decides the breaks (see
 * `manual-html-paginator.ts`). Word paginates DECLARATIVELY: it re-flows the
 * document itself and only honours the rules you state (explicit breaks,
 * keep-with-next).
 *
 * A .docx built from rules alone would therefore break in different places than
 * the printed HTML. So instead of guessing, we run the real HTML in the real
 * headless browser, ask the finished layout which sheet each unit landed on,
 * and hand that map to the Word renderer, which turns it back into explicit
 * page breaks. The result is a .docx whose pages match the PDF.
 *
 * The probe is the only reason a .docx build needs a browser. When Chrome is
 * unavailable the caller falls back to the declarative rules alone -- a manual
 * still comes out, just with Word choosing the breaks.
 */

export interface PageBreakMap {
  /** data-uid -> 1-based sheet number the unit landed on. */
  pages: Record<string, number>;
  /**
   * data-uid of a figure -> the size it ended up rendered at, in CSS pixels.
   *
   * Not simply the intrinsic size scaled to the page width: the paginator may
   * shrink a figure slightly to keep it on the sheet its text is on. Word has to
   * be told that final size or the two outputs stop matching — the whole point
   * of measuring.
   */
  figures: Record<string, { width: number; height: number }>;
  /** Total sheets, including the cover. Matches the HTML footer's "n / total". */
  totalPages: number;
}

/**
 * Loads the manual HTML in the headless browser, waits for the paginator to
 * finish, and reads back the sheet each `data-uid` landed on.
 *
 * The HTML is written to a temp file rather than `page.setContent` because an
 * inline-assets manual is a multi-megabyte string with base64 images: a file
 * URL lets the browser stream it and lets `networkidle0` mean what it says.
 */
export async function measurePageBreaks(html: string): Promise<PageBreakMap> {
  const dir = mkdtempSync(resolve(tmpdir(), 'bcmcp-paginate-'));
  const file = resolve(dir, 'manual.html');
  writeFileSync(file, html, 'utf8');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    browser = await launchHeadless();
    const page = await browser.newPage();
    // The paginator measures against a real A4 sheet, but it also SCALES the
    // document down when the viewport is narrower than the paper. Measurement
    // always happens at true A4 first, so any viewport works -- this one is
    // simply wide enough that no scaling is applied at all.
    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('#doc[data-paginated="1"]', { timeout: 30000 });

    return await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sheets: any[] = Array.from(doc.querySelectorAll('.sheet'));
      const pages: Record<string, number> = {};
      const figures: Record<string, { width: number; height: number }> = {};
      sheets.forEach((sheet, i) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const unit of Array.from(sheet.querySelectorAll('[data-uid]')) as any[]) {
          const uid = unit.getAttribute('data-uid');
          if (!uid) continue;
          pages[uid] = i + 1;
          const img = unit.querySelector('img');
          if (img) {
            const box = img.getBoundingClientRect();
            if (box.width > 0 && box.height > 0) {
              figures[uid] = { width: box.width, height: box.height };
            }
          }
        }
      });
      return { pages, figures, totalPages: sheets.length };
    });
  } finally {
    if (browser) await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
