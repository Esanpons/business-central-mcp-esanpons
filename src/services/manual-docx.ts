import { readFileSync } from 'node:fs';
import {
  AlignmentType, BookmarkEnd, BookmarkStart, BorderStyle, Document, ExternalHyperlink, Footer,
  Header, ImageRun, InternalHyperlink, LevelFormat, Packer, PageNumber, Paragraph,
  ShadingType, SimpleField, Table, TableCell, TableLayoutType, TableRow, TabStopType, TextRun,
  VerticalAlign, WidthType, LeaderType, convertMillimetersToTwip,
} from 'docx';
import { parseBlocks, type Block, type CellAlign, type InlineSpan } from './markdown-inline.js';
import { imageInfo, type ManualModel, type ManualStepModel } from './manual-render.js';
import type { PageBreakMap } from './manual-paginate.js';

/**
 * Renders the manual model as an editable Word document.
 *
 * Third renderer over the same `ManualModel` as Markdown and the printable A4
 * web page, so a manual is authored once. Unlike the other two this one is a
 * DELIVERABLE the reader edits: it emits real Word paragraph styles rather than
 * hard formatting, so opening the Styles pane and changing "Manual Heading"
 * restyles every step at once.
 *
 * Page breaks are the interesting part. Word re-flows the document itself and
 * cannot be told "break here because I measured 253mm of content", so a .docx
 * built from rules alone lands its breaks somewhere other than the printed
 * HTML. When the caller supplies a `breaks` map -- measured from the real HTML
 * in a real browser by `manual-paginate.ts` -- every measured break is replayed
 * as an explicit `pageBreakBefore`, and the Word pages match the PDF page for
 * page. Without it the layout falls back to the declarative rules alone (a step
 * per page, headings kept with their figure), which still reads correctly but
 * paginates wherever Word decides.
 *
 * Geometry mirrors `manual-html-theme.ts` exactly: A4, 16mm side margins, the
 * running header in the 13mm top strip and the page footer in the 11mm bottom
 * one. Change a value there and change it here.
 */

/** Palette, mirrored from the `:root` variables in `manual-html-theme.ts`. */
const C = {
  teal: '00ACB8',
  tealDark: '008293',
  tealDeep: '006673',
  ink: '111518',
  body: '2B3238',
  grey: '687279',
  line: 'E3E8EC',
  wash: 'E6F7F8',
  bgSoft: 'EDEFF2',
  zebra: 'F7F9FA',
  white: 'FFFFFF',
} as const;

/** Sheet geometry in mm, mirrored from the CSS custom properties. */
const G = {
  padX: 16,
  padTop: 13,
  padBottom: 11,
  headH: 11,
  footH: 9,
  sheetW: 210,
  figMaxH: 180,
} as const;

const USABLE_W_MM = G.sheetW - G.padX * 2;

/** Word measures embedded images in pixels at 96 DPI. */
function mmToPx(mm: number): number {
  return (mm / 25.4) * 96;
}

const FONT = 'Segoe UI';
/** docx sizes are half-points, so 10.5pt (the CSS body size) is 21. */
const BODY_SIZE = 21;

export interface ManualDocxOptions {
  /** UI label language for cover/index/footer chrome. Falls back to English. */
  lang?: string;
  /** Cover page. Default true. */
  cover?: boolean;
  /** Index page. Default: only when the manual has 4 or more steps. */
  toc?: boolean;
  /** Cover date. Injected so the output is reproducible in tests. */
  date?: Date;
  /** Measured page map from `measurePageBreaks`. Absent = declarative layout only. */
  breaks?: PageBreakMap;
}

export interface ManualDocxResult {
  buffer: Buffer;
  /** Figures that could not be embedded, as human-readable warnings. */
  warnings: string[];
  /** True when a measured break map drove the pagination. */
  measured: boolean;
}

interface Labels {
  manual: string; toc: string; page: string;
}

const LABELS: Record<string, Labels> = {
  ca: { manual: "Manual d'usuari", toc: 'Index', page: 'Pagina' },
  es: { manual: 'Manual de usuario', toc: 'Indice', page: 'Pagina' },
  en: { manual: 'User manual', toc: 'Contents', page: 'Page' },
};

function labelsFor(lang: string): Labels {
  return LABELS[lang.toLowerCase().split('-')[0] ?? 'en'] ?? LABELS.en!;
}

function formatDate(date: Date, lang: string): string {
  const opts = { year: 'numeric', month: 'long', day: 'numeric' } as const;
  try {
    return date.toLocaleDateString(lang.replace(/_/g, '-'), opts);
  } catch {
    return date.toLocaleDateString('en', opts);
  }
}

/** Markdown spans -> Word runs. Marks map 1:1; a link wraps its runs in a hyperlink. */
function spansToRuns(spans: InlineSpan[]): (TextRun | ExternalHyperlink)[] {
  return spans.map((s) => {
    const run = new TextRun({
      text: s.text,
      bold: s.bold,
      italics: s.italic,
      ...(s.code
        ? { font: 'Consolas', color: C.tealDeep, shading: { type: ShadingType.CLEAR, fill: C.wash } }
        : {}),
    });
    return s.href ? new ExternalHyperlink({ children: [run], link: s.href }) : run;
  });
}

function alignOf(a: CellAlign | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] {
  return a === 'center' ? AlignmentType.CENTER : a === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
}

/** Thin grid, mirroring the 1px `--line` borders of the printed table. */
const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: C.line } as const;

/**
 * A Markdown table as a real Word table.
 *
 * `tableHeader` on the first row is what makes Word repeat the column titles
 * when the table runs past a page -- the same thing the HTML paginator does by
 * cloning the `<thead>`, so both outputs read alike. Word splits the rest of the
 * rows by itself, which is why a table needs no measured break of its own.
 */
function tableFor(block: Extract<Block, { kind: 'table' }>): Table {
  const cell = (spans: InlineSpan[], style: string, align: CellAlign | undefined, header: boolean) =>
    new TableCell({
      children: [new Paragraph({ style, alignment: alignOf(align), children: spansToRuns(spans) })],
      ...(header ? { shading: { type: ShadingType.CLEAR, fill: C.wash } } : {}),
      margins: { top: 40, bottom: 40, left: 80, right: 80 },
      verticalAlign: VerticalAlign.TOP,
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    borders: {
      top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER,
      insideHorizontal: CELL_BORDER, insideVertical: CELL_BORDER,
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: block.head.map((h, i) => cell(h, 'ManualTableHead', block.align[i], true)),
      }),
      ...block.rows.map((r) => new TableRow({
        children: r.map((c, i) => cell(c, 'ManualTableCell', block.align[i], false)),
      })),
    ],
  });
}

/**
 * A fenced code block, as one shaded paragraph PER LINE.
 *
 * Not one paragraph with line breaks inside: that is indivisible, and a listing
 * longer than a page would then be pushed whole onto the next one (or overflow).
 * Consecutive shaded paragraphs read as a single block, and Word can break
 * between any two of them.
 *
 * An empty line still needs a run, or Word drops the paragraph's shading and the
 * block comes out with a white gap through it.
 */
function codeParagraphs(block: Extract<Block, { kind: 'code' }>): Paragraph[] {
  const lines = block.lines.length ? block.lines : [''];
  return lines.map((line, i) => new Paragraph({
    style: 'ManualCode',
    shading: { type: ShadingType.CLEAR, fill: C.bgSoft },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.tealDark, space: 6 } },
    spacing: {
      before: i === 0 ? 120 : 0,
      after: i === lines.length - 1 ? 160 : 0,
      line: 240,
    },
    // Indentation is the content in an ASCII diagram, so the spaces are written
    // as they are and `xml:space="preserve"` (which docx always emits) keeps them.
    children: [new TextRun({ text: line || ' ' })],
  }));
}

/**
 * Markdown blocks -> Word content.
 *
 * Returns paragraphs AND tables: a Word table is not a paragraph, so the caller
 * pushes both into the section's children list.
 *
 * `olInstance` gives each ordered list its own numbering instance; sharing one
 * would make the second list in a manual continue from where the first stopped.
 */
function blocksToChildren(src: string, olInstance: () => number): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const block of parseBlocks(src)) {
    if (block.kind === 'table') {
      out.push(tableFor(block));
      // Word needs a paragraph after a table: two adjacent tables merge into
      // one, and a table as the last element of the body is not a valid
      // document. This is also where the table's bottom spacing comes from.
      out.push(new Paragraph({ style: 'ManualAfterTable' }));
    } else if (block.kind === 'code') {
      out.push(...codeParagraphs(block));
    } else if (block.kind === 'ul') {
      // Bullets go through our own numbering definition rather than docx's
      // `bullet` shorthand: the shorthand injects Word's built-in ListParagraph
      // style, which lands a SECOND w:pStyle in the paragraph and wins over
      // ManualBody -- so bullets silently lost the body spacing and font.
      for (const item of block.items) {
        out.push(new Paragraph({
          style: 'ManualBody',
          children: spansToRuns(item),
          numbering: { reference: 'manual-ul', level: 0 },
        }));
      }
    } else if (block.kind === 'ol') {
      const instance = olInstance();
      for (const item of block.items) {
        out.push(new Paragraph({
          style: 'ManualBody',
          children: spansToRuns(item),
          numbering: { reference: 'manual-ol', level: 0, instance },
        }));
      }
    } else if (block.kind === 'sub') {
      // keepNext for the same reason as a step heading: a sub-section title left
      // alone at the foot of a page is the one layout error Word makes on its own.
      out.push(new Paragraph({ style: 'ManualSubheading', keepNext: true, children: spansToRuns(block.spans) }));
    } else if (block.kind === 'note') {
      out.push(new Paragraph({ style: 'ManualNote', children: spansToRuns(block.spans) }));
    } else {
      out.push(new Paragraph({ style: 'ManualBody', children: spansToRuns(block.spans) }));
    }
  }
  return out;
}

/**
 * The figure for one step, scaled to fit the printable area.
 *
 * Same arithmetic as the CSS (`max-width:100%` plus `--fig-max-h`), done here
 * because Word stores an absolute size per image rather than a constraint.
 * Captures are taken at a 2x device scale, so this is almost always a
 * downscale -- the stored size shrinks while the pixels stay, which is exactly
 * what keeps a screenshot sharp in print.
 */
function figureFor(
  step: ManualStepModel,
  warn: (s: string) => void,
  at: string,
  measured?: { width: number; height: number },
): Paragraph[] {
  const img = step.image;
  if (!img) return [];

  let bytes: Buffer;
  try {
    bytes = readFileSync(img.absPath);
  } catch {
    warn(`${at}: the image ${img.absPath} could not be read -- the step was written WITHOUT its figure.`);
    return [];
  }

  const info = imageInfo(bytes);
  if (!info.kind || !info.width || !info.height) {
    warn(`${at}: ${img.absPath} is not a Word-embeddable image with a readable size `
      + '(PNG, JPEG, GIF or BMP) -- the step was written WITHOUT its figure.');
    return [];
  }

  // The browser's own answer wins when there is one. It is not simply the
  // intrinsic size scaled to the page: the paginator may have shrunk the figure
  // slightly to keep it on the sheet its text is on, and copying that is what
  // keeps the two outputs identical. CSS pixels are 96 DPI, which is exactly
  // what Word's transformation expects.
  //
  // Floor, never round: Word stores the size in EMU at 9525 per pixel, so
  // rounding a width UP puts the image a fraction of a millimetre past the
  // printable area -- enough for Word to reflow it onto its own page.
  const scale = measured
    ? measured.width / info.width
    : Math.min(1, mmToPx(USABLE_W_MM) / info.width, mmToPx(G.figMaxH) / info.height);
  const px = (n: number) => Math.floor(n * scale);
  const out: Paragraph[] = [
    new Paragraph({
      style: 'ManualFigure',
      // The figure must not be torn from its caption, nor the caption left to
      // open a page on its own.
      keepNext: !!img.caption,
      children: [new ImageRun({
        data: bytes,
        type: info.kind,
        transformation: { width: px(info.width), height: px(info.height) },
      })],
    }),
  ];
  if (img.caption) out.push(new Paragraph({ style: 'ManualCaption', text: img.caption }));
  return out;
}

/** Cover page: title band, rule, intro, then the brand/date line. */
function coverParagraphs(model: ManualModel, l: Labels, lang: string, date: Date, olInstance: () => number): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [
    new Paragraph({
      spacing: { before: convertMillimetersToTwip(55), after: 200 },
      children: [new TextRun({ text: l.manual.toUpperCase(), color: C.teal, bold: true, size: 20, characterSpacing: 60 })],
    }),
    new Paragraph({ style: 'ManualTitle', text: model.title }),
    new Paragraph({
      spacing: { before: 120, after: 320 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: C.teal, space: 1 } },
      children: [],
    }),
  ];
  if (model.intro) out.push(...blocksToChildren(model.intro, olInstance));
  out.push(new Paragraph({
    spacing: { before: convertMillimetersToTwip(60) },
    tabStops: [{ type: TabStopType.RIGHT, position: convertMillimetersToTwip(USABLE_W_MM) }],
    children: [
      new TextRun({ text: 'Microsoft Dynamics 365 Business Central', color: C.grey, size: 18 }),
      new TextRun({ text: `\t${formatDate(date, lang)}`, color: C.grey, size: 18 }),
    ],
  }));
  return out;
}

/**
 * Index page.
 *
 * Rows are real internal hyperlinks with a PAGEREF field, so the numbers stay
 * correct if the reader edits the document and presses F9 -- but the field also
 * ships with the measured number cached, so it reads correctly the moment the
 * file is opened, before any refresh.
 */
function tocParagraphs(model: ManualModel, l: Labels, pageBreakBefore: boolean, breaks?: PageBreakMap): Paragraph[] {
  const out: Paragraph[] = [new Paragraph({ style: 'ManualTocTitle', text: l.toc, pageBreakBefore })];
  model.steps.forEach((s, i) => {
    const anchor = `step-${i + 1}`;
    const cached = breaks?.pages[`${anchor}-head`];
    out.push(new Paragraph({
      style: 'ManualTocRow',
      tabStops: [{ type: TabStopType.RIGHT, position: convertMillimetersToTwip(USABLE_W_MM), leader: LeaderType.DOT }],
      children: [
        new InternalHyperlink({
          anchor,
          children: [new TextRun({ text: `${i + 1}.  `, bold: true, color: C.teal }), new TextRun({ text: s.heading })],
        }),
        new TextRun({ text: '\t' }),
        new SimpleField(`PAGEREF ${anchor} \\h`, cached === undefined ? undefined : String(cached)),
      ],
    }));
  });
  return out;
}

/**
 * One step: bookmarked heading, prose, figure.
 *
 * The bookmark is emitted as an explicit start/end pair rather than with docx's
 * `Bookmark` convenience class, which builds its numeric id from a generator it
 * creates per instance -- so every bookmark in a document comes out as id 1, and
 * Word resolves the index's PAGEREF fields against whichever duplicate it meets
 * first. `bookmarkId` is the document-wide counter that keeps them distinct.
 *
 * The style is applied by name only. Passing `heading` as well would write a
 * second `w:pStyle` into the same paragraph; `ManualHeading` is based on
 * Heading1 and carries `outlineLevel: 0`, so the step still shows up in Word's
 * navigation pane and in any TOC field the reader inserts.
 */
function stepParagraphs(
  step: ManualStepModel,
  index: number,
  bookmarkId: number,
  olInstance: () => number,
  warn: (s: string) => void,
  pageBreakBefore: boolean,
  figureSize?: { width: number; height: number },
): (Paragraph | Table)[] {
  const n = index + 1;
  const anchor = `step-${n}`;
  const out: (Paragraph | Table)[] = [
    new Paragraph({
      style: 'ManualHeading',
      pageBreakBefore,
      // A heading alone at the foot of a page is the one layout error Word makes
      // on its own, and the only defence that survives the reader editing the text.
      keepNext: true,
      children: [
        new BookmarkStart(anchor, bookmarkId),
        new TextRun({ text: `${n}. `, color: C.teal }),
        new TextRun({ text: step.heading }),
        new BookmarkEnd(bookmarkId),
      ],
    }),
  ];
  if (step.body) out.push(...blocksToChildren(step.body, olInstance));
  out.push(...figureFor(step, warn, `Step ${n} ("${step.heading}")`, figureSize));
  if (step.after) out.push(...blocksToChildren(step.after, olInstance));
  return out;
}

/**
 * Paragraph styles, so the document is editable as a Word document rather than
 * as a pile of hard formatting. Every visual choice mirrors the print CSS.
 */
function styles() {
  return {
    default: {
      document: { run: { font: FONT, size: BODY_SIZE, color: C.ink } },
      hyperlink: { run: { color: C.tealDark, underline: {} } },
    },
    paragraphStyles: [
      {
        id: 'ManualTitle', name: 'Manual Title', basedOn: 'Normal', quickFormat: true,
        run: { size: 64, bold: true, color: C.ink },
        paragraph: { spacing: { after: 120 } },
      },
      {
        id: 'ManualHeading', name: 'Manual Heading', basedOn: 'Heading1', next: 'ManualBody', quickFormat: true,
        run: { size: 30, bold: true, color: C.tealDeep, font: FONT },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0 },
      },
      {
        // Based on Heading2 with outlineLevel 1: a sub-section shows up in Word's
        // navigation pane under its step, but the manual's own index lists steps
        // only -- it is built from bookmarks, not from an outline scan.
        id: 'ManualSubheading', name: 'Manual Subheading', basedOn: 'Heading2', next: 'ManualBody', quickFormat: true,
        run: { size: 23, bold: true, color: C.tealDark, font: FONT },
        paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 1 },
      },
      {
        id: 'ManualBody', name: 'Manual Body', basedOn: 'Normal', next: 'ManualBody', quickFormat: true,
        run: { size: BODY_SIZE },
        paragraph: { spacing: { after: 120, line: 300 } },
      },
      {
        id: 'ManualNote', name: 'Manual Note', basedOn: 'Normal', next: 'ManualBody',
        run: { size: BODY_SIZE, color: C.tealDeep },
        paragraph: {
          spacing: { before: 120, after: 160 },
          indent: { left: convertMillimetersToTwip(4) },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.teal, space: 8 } },
          shading: { type: ShadingType.CLEAR, fill: C.wash },
        },
      },
      {
        id: 'ManualFigure', name: 'Manual Figure', basedOn: 'Normal', next: 'ManualBody',
        paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 160, after: 80 } },
      },
      {
        // 9pt, like the printed table: a three-column cell grid at body size
        // wraps into unreadable columns on A4.
        id: 'ManualTableHead', name: 'Manual Table Head', basedOn: 'Normal', next: 'ManualTableCell',
        run: { size: 18, bold: true, color: C.tealDeep },
        paragraph: { spacing: { before: 20, after: 20, line: 240 } },
      },
      {
        id: 'ManualTableCell', name: 'Manual Table Cell', basedOn: 'Normal', next: 'ManualTableCell',
        run: { size: 18, color: C.body },
        paragraph: { spacing: { before: 20, after: 20, line: 240 } },
      },
      {
        // The paragraph Word requires after a table. Kept small so it reads as
        // the table's bottom margin rather than as an empty line.
        id: 'ManualAfterTable', name: 'Manual After Table', basedOn: 'Normal', next: 'ManualBody',
        run: { size: 8 },
        paragraph: { spacing: { before: 0, after: 60, line: 120 } },
      },
      {
        id: 'ManualCode', name: 'Manual Code', basedOn: 'Normal', next: 'ManualBody',
        run: { font: 'Consolas', size: 17, color: '1D2429' },
        paragraph: { indent: { left: convertMillimetersToTwip(3) } },
      },
      {
        id: 'ManualCaption', name: 'Manual Caption', basedOn: 'Normal', next: 'ManualBody',
        run: { size: 17, italics: true, color: C.grey },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 200 } },
      },
      {
        id: 'ManualTocTitle', name: 'Manual Index Title', basedOn: 'Normal', next: 'ManualTocRow',
        run: { size: 30, bold: true, color: C.tealDeep },
        paragraph: { spacing: { after: 240 } },
      },
      {
        id: 'ManualTocRow', name: 'Manual Index Row', basedOn: 'Normal', next: 'ManualTocRow',
        run: { size: BODY_SIZE },
        paragraph: { spacing: { after: 100 } },
      },
    ],
  };
}

function numbering() {
  const indent = { left: convertMillimetersToTwip(8), hanging: convertMillimetersToTwip(5) };
  return {
    config: [
      {
        reference: 'manual-ol',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START,
          style: { run: { color: C.tealDeep, bold: true }, paragraph: { indent } },
        }],
      },
      {
        reference: 'manual-ul',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.START,
          style: { run: { color: C.teal }, paragraph: { indent } },
        }],
      },
    ],
  };
}

function runningHeader(title: string, l: Labels): Header {
  return new Header({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: convertMillimetersToTwip(USABLE_W_MM) }],
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.line, space: 6 } },
      children: [
        new TextRun({ text: title, color: C.grey, size: 17 }),
        new TextRun({ text: `\t${l.manual}`, color: C.teal, size: 17, bold: true }),
      ],
    })],
  });
}

/**
 * Page footer. The page number is a live field pair rather than baked text: the
 * document stays correct after the reader inserts or deletes a page.
 */
function runningFooter(l: Labels): Footer {
  return new Footer({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: convertMillimetersToTwip(USABLE_W_MM) }],
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: C.line, space: 6 } },
      children: [
        new TextRun({ text: l.manual, color: C.grey, size: 16 }),
        new TextRun({ text: '\t', size: 16 }),
        new TextRun({ children: [PageNumber.CURRENT], color: C.grey, size: 16 }),
        new TextRun({ text: ' / ', color: C.grey, size: 16 }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], color: C.grey, size: 16 }),
      ],
    })],
  });
}

export async function renderDocx(model: ManualModel, options: ManualDocxOptions = {}): Promise<ManualDocxResult> {
  const lang = (options.lang ?? 'ca').trim() || 'ca';
  const l = labelsFor(lang);
  const withCover = options.cover ?? true;
  const withToc = options.toc ?? model.steps.length >= 4;
  const date = options.date ?? new Date();
  const breaks = options.breaks;
  const warnings: string[] = [];
  const warn = (s: string) => warnings.push(s);

  let olSeq = 0;
  const olInstance = () => ++olSeq;

  const children: (Paragraph | Table)[] = [];
  if (withCover) {
    children.push(...coverParagraphs(model, l, lang, date, olInstance));
  } else {
    children.push(new Paragraph({ style: 'ManualTitle', text: model.title }));
    if (model.intro) children.push(...blocksToChildren(model.intro, olInstance));
  }

  // The index opens a page of its own whenever a cover precedes it.
  if (withToc) children.push(...tocParagraphs(model, l, withCover, breaks));

  model.steps.forEach((step, i) => {
    // Every step opens a page of its own, matching the `data-break="before"` the
    // HTML puts on each step's first unit. The only exception is a step with
    // nothing at all in front of it, which would otherwise open on a blank page.
    const pageBreakBefore = i > 0 || withCover || withToc;
    children.push(...stepParagraphs(
      step, i, i + 1, olInstance, warn, pageBreakBefore,
      breaks?.figures[`step-${i + 1}-fig`],
    ));
  });

  const doc = new Document({
    creator: 'bc_build_manual',
    title: model.title,
    description: model.intro,
    styles: styles(),
    numbering: numbering(),
    sections: [{
      properties: {
        page: {
          size: { width: convertMillimetersToTwip(G.sheetW), height: convertMillimetersToTwip(297) },
          margin: {
            // The header and footer live inside the top/bottom strips, exactly
            // as the CSS grid reserves --head-h / --foot-h inside the padding.
            top: convertMillimetersToTwip(G.padTop + G.headH),
            bottom: convertMillimetersToTwip(G.padBottom + G.footH),
            left: convertMillimetersToTwip(G.padX),
            right: convertMillimetersToTwip(G.padX),
            header: convertMillimetersToTwip(G.padTop),
            footer: convertMillimetersToTwip(G.padBottom),
          },
        },
        // The cover carries no running header or footer, like the HTML cover sheet.
        titlePage: withCover,
      },
      headers: { default: runningHeader(model.title, l), ...(withCover ? { first: new Header({ children: [] }) } : {}) },
      footers: { default: runningFooter(l), ...(withCover ? { first: new Footer({ children: [] }) } : {}) },
      children,
    }],
  });

  return { buffer: await Packer.toBuffer(doc), warnings, measured: !!breaks };
}
