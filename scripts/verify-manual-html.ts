/**
 * Verifies the printable A4 manual end to end WITHOUT touching BC.
 *
 * Builds a synthetic multi-page manual from PNGs already on disk, renders the
 * HTML, loads it in the headless browser and asserts what actually matters:
 * no sheet overflows its paper, every step landed on a sheet, the index page
 * numbers resolved, and printing yields exactly one PDF page per sheet (no
 * blank pages -- the classic 297mm rounding trap).
 *
 * Run: tsx scripts/verify-manual-html.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchHeadless } from '../src/services/browser.js';
import { renderHtmlDocument } from '../src/services/manual-html.js';
import { pngSize, type ManualModel } from '../src/services/manual-render.js';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'manuals', '_verify');
mkdirSync(outDir, { recursive: true });

const pngs = [
  resolve(root, 'manuals/crear-client-img/step-1.png'),
  resolve(root, 'manuals/crear-client-img/step-2.png'),
].filter(existsSync);

if (!pngs.length) {
  console.error('No PNGs found under manuals/crear-client-img -- run a capture first.');
  process.exit(1);
}

function img(i: number) {
  const absPath = pngs[i % pngs.length]!;
  const { width, height } = pngSize(readFileSync(absPath));
  return { absPath, relPath: `x-img/step-${i + 1}.png`, width, height };
}

const LOREM =
  'Obre la pagina i comprova que el filtre de companyia sigui el correcte abans de continuar. ' +
  'Si el camp no es editable, revisa els permisos del rol assignat a l usuari.';

// 9 steps: prose-only, image-heavy and a long body, so several sheets are needed.
const model: ManualModel = {
  title: 'Manual de proves de paginacio A4',
  intro: 'Aquest document **no** documenta res: serveix per validar que la paginacio A4 funciona.\n\nInclou passos amb imatge, passos nomes de text i llistes.',
  steps: [
    { heading: 'Requisits previs', body: `${LOREM}\n\n- Un usuari amb permisos\n- La companyia CRONUS activa\n- Chrome o Edge instal.lat` },
    { heading: 'Obre la llista', body: LOREM, image: img(0) },
    { heading: 'Filtra els registres', body: `${LOREM}\n\n> Recorda que el filtre es manté entre sessions.`, image: img(1) },
    { heading: 'Un pas nomes de text', body: `${LOREM} ${LOREM}` },
    { heading: 'Obre la fitxa', body: 'Prem `Enter` sobre la fila.', image: img(0) },
    { heading: 'Omple els camps', body: LOREM, image: img(1) },
    { heading: 'Comprova el resultat', body: `${LOREM}\n\n1. Revisa el nom\n2. Revisa el limit\n3. Desa` },
    { heading: 'Registra el document', body: LOREM, image: img(0) },
    { heading: 'Tanca la sessio', body: 'Ja esta. Consulta la [documentacio](https://aesva.es) per a mes detalls.' },
  ],
};

const { html } = renderHtmlDocument(model, { lang: 'ca' });
const file = resolve(outDir, 'paginacio.html');
writeFileSync(file, html, 'utf8');
console.log(`HTML: ${file} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);

const browser = await launchHeadless();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('#doc[data-paginated="1"]', { timeout: 30000 });

  const report = await page.evaluate(() => {
    const sheets = Array.from(document.querySelectorAll('.sheet'));
    const overflowing: Array<{ page: string | null; over: number }> = [];
    for (const s of sheets) {
      const body = s.querySelector('.sheet-body') as HTMLElement | null;
      if (!body) continue;
      const over = body.scrollHeight - body.clientHeight;
      if (over > 1) overflowing.push({ page: s.getAttribute('data-page'), over });
    }
    return {
      sheets: sheets.length,
      flowLeft: !!document.getElementById('flow'),
      footers: sheets.map((s) => s.querySelector('.page-no')?.textContent ?? ''),
      toc: Array.from(document.querySelectorAll('.toc-row')).map((r) => ({
        name: r.querySelector('.t-name')?.textContent ?? '',
        page: r.querySelector('.t-page')?.textContent ?? '',
      })),
      stepsPlaced: document.querySelectorAll('[data-anchor]').length,
      figures: document.querySelectorAll('.step-fig').length,
      overflowing,
    };
  });

  // One PNG per sheet, so the layout can be eyeballed without opening a browser.
  const shots = await page.$$('.sheet');
  for (let i = 0; i < shots.length; i++) {
    await shots[i].screenshot({ path: resolve(outDir, `sheet-${i + 1}.png`) });
  }

  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  const pdfPath = resolve(outDir, 'paginacio.pdf');
  writeFileSync(pdfPath, Buffer.from(pdf));
  const pageCount = (Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

  console.log(JSON.stringify(report, null, 2));
  console.log(`PDF (print simulation): ${pdfPath} -- ${pageCount} pages`);

  const problems: string[] = [];
  if (report.overflowing.length) problems.push(`sheets overflow their paper: ${JSON.stringify(report.overflowing)}`);
  if (report.flowLeft) problems.push('#flow was not consumed by the paginator');
  if (report.stepsPlaced !== model.steps.length) problems.push(`${report.stepsPlaced}/${model.steps.length} steps placed`);
  if (report.toc.some((t) => !t.page)) problems.push('index rows without a page number');
  if (pageCount && pageCount !== report.sheets) problems.push(`printed ${pageCount} pages for ${report.sheets} sheets (blank pages?)`);

  if (problems.length) {
    console.error('\nFAIL:\n - ' + problems.join('\n - '));
    process.exitCode = 1;
  } else {
    console.log(`\nOK: ${report.sheets} A4 sheets, ${report.figures} figures, index resolved, print matches screen.`);
  }
} finally {
  await browser.close();
}
