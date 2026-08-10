/**
 * Verifies the printable A4 manual and the Word export end to end WITHOUT
 * touching BC.
 *
 * Builds a synthetic multi-page manual from PNGs already on disk, renders the
 * HTML, loads it in the headless browser and asserts what actually matters:
 * no sheet overflows its paper, every step landed on a sheet, the index page
 * numbers resolved, and printing yields exactly one PDF page per sheet (no
 * blank pages -- the classic 297mm rounding trap).
 *
 * The same paginated layout then drives the .docx, which is the only way to
 * check the claim that matters for the Word output: that its pages match the
 * printed HTML. Proving that needs something that re-flows a Word document, so
 * the final comparison runs only when LibreOffice is installed and is reported
 * as skipped when it is not -- never silently passed.
 *
 * Run: tsx scripts/verify-manual.ts
 */
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchHeadless } from '../src/services/browser.js';
import { renderHtmlDocument } from '../src/services/manual-html.js';
import { renderDocx } from '../src/services/manual-docx.js';
import { measurePageBreaks } from '../src/services/manual-paginate.js';
import { pngSize, type ManualModel } from '../src/services/manual-render.js';

/** LibreOffice, when present, is the only local thing that can re-flow a .docx. */
function findSoffice(): string | undefined {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  return candidates.find(existsSync);
}

function countPdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** Printable width (210mm paper less 16mm margins) in CSS pixels at 96 DPI. */
const PX_USABLE_W = (178 / 25.4) * 96;
/** Mirrors MIN_FIG_SCALE in `manual-html-paginator.ts`. */
const MIN_FIG_SCALE = 0.75;

/**
 * `word/document.xml` out of a .docx, read through the central directory --
 * compressed image data contains the local-header signature often enough that
 * scanning for it finds phantom entries.
 */
function docxXml(docx: Buffer): string {
  const eocd = docx.lastIndexOf(Buffer.from('PK\x05\x06'));
  const count = docx.readUInt16LE(eocd + 10);
  let off = docx.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = docx.readUInt16LE(off + 28);
    const name = docx.subarray(off + 46, off + 46 + nameLen).toString();
    if (name === 'word/document.xml') {
      const method = docx.readUInt16LE(off + 10);
      const size = docx.readUInt32LE(off + 20);
      const local = docx.readUInt32LE(off + 42);
      const start = local + 30 + docx.readUInt16LE(local + 26) + docx.readUInt16LE(local + 28);
      const raw = docx.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    }
    off += 46 + nameLen + docx.readUInt16LE(off + 30) + docx.readUInt16LE(off + 32);
  }
  throw new Error('word/document.xml not found in the .docx');
}

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

// A body long enough that the step CANNOT fit on one sheet. This is the case that
// used to overflow the paper: prose is now emitted block by block, so a step like
// this flows across sheets instead of becoming one indivisible unit.
const LONG = Array.from({ length: 9 }, (_, i) =>
  `Paragraf ${i + 1}. ${LOREM} ${LOREM} El text ha de poder repartir-se entre fulls sense que `
  + 'cap bloc quedi partit pel mig ni cap full sobreeixi del paper.').join('\n\n');

// 10 steps: prose-only, image-heavy, a body that outgrows a sheet, and text below a figure.
const model: ManualModel = {
  title: 'Manual de proves de paginacio A4',
  intro: 'Aquest document **no** documenta res: serveix per validar que la paginacio A4 funciona.\n\nInclou passos amb imatge, passos nomes de text i llistes.',
  steps: [
    { heading: 'Requisits previs', body: `${LOREM}\n\n- Un usuari amb permisos\n- La companyia CRONUS activa\n- Chrome o Edge instal.lat` },
    { heading: 'Obre la llista', body: LOREM, image: img(0) },
    {
      heading: 'Filtra els registres',
      body: `${LOREM}\n\n> Recorda que el filtre es manté entre sessions.`,
      image: img(1),
      after: `${LOREM}\n\n- Comprova el resultat\n- Desa la vista si la faras servir sovint`,
    },
    { heading: 'Un pas que no cap en un full', body: LONG },
    // Sized to land in the shrink window: the figure misses the sheet by a
    // little, so the paginator scales it down instead of sending it to the next
    // page. The exact text metrics vary by machine, so the check below asserts
    // the INVARIANTS (floor respected, Word agrees) rather than a fixed scale.
    {
      heading: 'Una figura que no cap per poc',
      body: Array.from({ length: 9 }, (_, i) => `${i + 1}. ${LOREM}`).join('\n\n'),
      image: img(0),
      caption: 'Aquesta captura hauria de reduir-se una mica en comptes de saltar de pagina',
    },
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
  const pageCount = countPdfPages(Buffer.from(pdf));

  console.log(JSON.stringify(report, null, 2));
  console.log(`PDF (print simulation): ${pdfPath} -- ${pageCount} pages`);

  const problems: string[] = [];
  if (report.overflowing.length) problems.push(`sheets overflow their paper: ${JSON.stringify(report.overflowing)}`);
  if (report.flowLeft) problems.push('#flow was not consumed by the paginator');
  if (report.stepsPlaced !== model.steps.length) problems.push(`${report.stepsPlaced}/${model.steps.length} steps placed`);
  if (report.toc.some((t) => !t.page)) problems.push('index rows without a page number');
  if (pageCount && pageCount !== report.sheets) problems.push(`printed ${pageCount} pages for ${report.sheets} sheets (blank pages?)`);

  // ---- Word export, driven by the very layout just verified -----------------
  const breaks = await measurePageBreaks(html);
  const docx = await renderDocx(model, { lang: 'ca', breaks });
  const docxPath = resolve(outDir, 'paginacio.docx');
  writeFileSync(docxPath, docx.buffer);
  console.log(`\nDOCX: ${docxPath} -- ${(docx.buffer.length / 1024).toFixed(0)} KB, `
    + `measured=${docx.measured}, ${breaks.totalPages} pages expected`);
  if (docx.warnings.length) console.log(` warnings: ${docx.warnings.join(' | ')}`);

  if (breaks.totalPages !== report.sheets) {
    problems.push(`the break probe saw ${breaks.totalPages} pages but the layout has ${report.sheets} sheets`);
  }
  if (docx.warnings.length) problems.push(`the Word export dropped content: ${docx.warnings.join(' | ')}`);

  // Every step must open a page of its own.
  const stepPages = model.steps.map((_, i) => breaks.pages[`step-${i + 1}-head`]);
  const shared = stepPages.filter((p, i) => i > 0 && p === stepPages[i - 1]);
  if (shared.length) problems.push(`${shared.length} step(s) do not start on a fresh page`);

  // A shrunk figure must stay a SLIGHT reduction, and Word must embed the very
  // size the browser settled on -- that agreement is the whole point of measuring.
  const docxExtents = [...docxXml(docx.buffer).matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)]
    .map((m) => ({ w: Number(m[1]), h: Number(m[2]) }));
  const measuredFigs = Object.entries(breaks.figures).sort(
    (a, b) => (breaks.pages[a[0]] ?? 0) - (breaks.pages[b[0]] ?? 0));
  const scales = measuredFigs.map(([uid, box]) => ({ uid, scale: box.width / PX_USABLE_W }));
  for (const { uid, scale } of scales) {
    if (scale < MIN_FIG_SCALE - 0.01) {
      problems.push(`${uid} was scaled to ${(scale * 100).toFixed(0)}%, below the ${MIN_FIG_SCALE * 100}% floor`);
    }
  }
  if (docxExtents.length !== measuredFigs.length) {
    problems.push(`Word embedded ${docxExtents.length} figures for ${measuredFigs.length} measured`);
  } else {
    measuredFigs.forEach(([uid, box], i) => {
      // EMU at 9525 per CSS pixel, floored by the renderer.
      const expected = Math.floor(box.width) * 9525;
      const got = docxExtents[i]!.w;
      if (Math.abs(got - expected) > 9525) {
        problems.push(`${uid}: Word embedded it ${(got / 9525).toFixed(0)}px wide, the browser rendered it ${box.width.toFixed(0)}px`);
      }
    });
  }
  const shrunk = scales.filter((s) => s.scale < 0.995);
  console.log(shrunk.length
    ? ` ${shrunk.length} figure(s) scaled to fit their page: ${shrunk.map((s) => `${s.uid}=${(s.scale * 100).toFixed(0)}%`).join(', ')}`
    : ' no figure needed scaling on this run (text metrics decide; the floor is still asserted)');

  const soffice = findSoffice();
  if (!soffice) {
    console.log(' SKIPPED: LibreOffice is not installed, so the .docx page count was NOT verified.\n'
      + ' Install it to have this script re-flow the Word file and compare it against the HTML.');
  } else {
    const convDir = resolve(outDir, 'docx-pdf');
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir, { recursive: true });
    execFileSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', convDir, docxPath], { stdio: 'pipe' });
    const converted = resolve(convDir, 'paginacio.pdf');
    if (!existsSync(converted)) {
      problems.push('LibreOffice did not produce a PDF from the .docx');
    } else {
      const docxPages = countPdfPages(readFileSync(converted));
      console.log(` LibreOffice re-flowed the .docx to ${docxPages} pages (HTML: ${report.sheets})`);
      if (docxPages !== report.sheets) {
        problems.push(`the Word document paginates to ${docxPages} pages but the HTML to ${report.sheets}`);
      }
    }
  }

  if (problems.length) {
    console.error('\nFAIL:\n - ' + problems.join('\n - '));
    process.exitCode = 1;
  } else {
    console.log(`\nOK: ${report.sheets} A4 sheets, ${report.figures} figures, index resolved, `
      + 'print matches screen, Word export written.');
  }
} finally {
  await browser.close();
}
