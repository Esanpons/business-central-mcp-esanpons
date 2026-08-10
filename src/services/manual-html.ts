import { readFileSync } from 'node:fs';
import { escapeHtml, renderBlocks } from './markdown-inline.js';
import { MANUAL_CSS } from './manual-html-theme.js';
import { MANUAL_JS } from './manual-html-paginator.js';
import type { ManualModel, ManualStepModel } from './manual-render.js';

/**
 * Renders the manual model as a printable A4 web page.
 *
 * The page is NOT a flowing document: content is emitted as measurable units
 * that the bundled paginator distributes across 210x297mm `.sheet` elements, so
 * the on-screen preview and the Ctrl+P output are the same pages. Prose goes
 * through the small Markdown converter, so bodies read identically in the .md
 * and .html outputs.
 */

export type ManualAssets = 'inline' | 'files';

export interface ManualHtmlOptions {
  /** `inline` (default): one self-contained .html. `files`: link an external .css/.js and the PNGs. */
  assets?: ManualAssets;
  /** UI label language for cover/index/footer chrome. Falls back to English. */
  lang?: string;
  /** Cover sheet. Default true. */
  cover?: boolean;
  /** Index sheet. Default: only when the manual has 4 or more steps. */
  toc?: boolean;
  /** Base file name used to link the external assets in `files` mode. */
  assetBase?: string;
  /** Cover date. Injected so the output is reproducible in tests. */
  date?: Date;
}

export interface ManualHtmlResult {
  html: string;
  /** Only in `files` mode -- the caller writes these next to the .html. */
  css?: string;
  js?: string;
}

interface Labels {
  manual: string; toc: string; print: string; hint: string;
}

const LABELS: Record<string, Labels> = {
  ca: {
    manual: "Manual d'usuari",
    toc: 'Index',
    print: 'Imprimir',
    hint: 'Ctrl+P per imprimir o desar en PDF. Marca "Grafics de fons" per conservar els colors.',
  },
  es: {
    manual: 'Manual de usuario',
    toc: 'Indice',
    print: 'Imprimir',
    hint: 'Ctrl+P para imprimir o guardar en PDF. Marca "Graficos de fondo" para conservar los colores.',
  },
  en: {
    manual: 'User manual',
    toc: 'Contents',
    print: 'Print',
    hint: 'Ctrl+P to print or save as PDF. Tick "Background graphics" to keep the colours.',
  },
};

function labelsFor(lang: string): Labels {
  return LABELS[lang.toLowerCase().split('-')[0] ?? 'en'] ?? LABELS.en!;
}

/**
 * Normalise a language tag to something `Intl` accepts. Callers hand us whatever
 * they typed ("ca_ES" is the common one), and an underscore makes every Intl API
 * throw a RangeError — which used to blow up the render AFTER every screenshot
 * had already been taken.
 */
export function normalizeLang(lang: string): string {
  return lang.trim().replace(/_/g, '-');
}

/**
 * Cover date. A structurally invalid tag still throws even after normalisation
 * (e.g. "not a language"), so the whole call is guarded: a manual must never fail
 * to render because of a cosmetic label.
 */
function formatDate(date: Date, lang: string): string {
  const opts = { year: 'numeric', month: 'long', day: 'numeric' } as const;
  try {
    return date.toLocaleDateString(lang, opts);
  } catch {
    return date.toLocaleDateString('en', opts);
  }
}

/** Sniff the real image type so an inlined data: URI is not mislabelled as PNG. */
function mimeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x3c) return 'image/svg+xml';
  return 'image/png';
}

function imageSrc(step: ManualStepModel, assets: ManualAssets): string {
  const img = step.image!;
  if (assets === 'files') return escapeHtml(img.relPath.replace(/\\/g, '/'));
  const bytes = readFileSync(img.absPath);
  return `data:${mimeOf(bytes)};base64,${bytes.toString('base64')}`;
}

const PRINTER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>';

function coverSheet(model: ManualModel, l: Labels, lang: string, date: Date): string {
  const when = formatDate(date, lang);
  const intro = model.intro ? `<div class="c-intro">${renderBlocks(model.intro)}</div>` : '';
  return `<div class="sheet cover" data-cover>
  <div class="cover-band"><span class="c-kicker">${escapeHtml(l.manual)}</span></div>
  <div class="cover-main">
    <h1 class="c-title">${escapeHtml(model.title)}</h1>
    <div class="c-rule"></div>
    ${intro}
  </div>
  <div class="cover-foot"><span class="c-brand">Microsoft Dynamics 365 Business Central</span><span>${escapeHtml(when)}</span></div>
</div>`;
}

function tocUnits(model: ManualModel, l: Labels): string[] {
  const units = [`<div class="unit toc-title" data-unit data-group="toc-head">${escapeHtml(l.toc)}</div>`];
  model.steps.forEach((s, i) => {
    // The first row rides with the title so the index never opens on an orphan heading.
    const group = i === 0 ? 'toc-head' : `toc-${i}`;
    // The last row closes the sheet, so the steps always start on a fresh page.
    const brk = i === model.steps.length - 1 ? ' data-break="after"' : '';
    units.push(
      `<div class="unit toc-row" data-unit data-group="${group}" data-target="step-${i + 1}"${brk}>` +
      `<span class="t-num">${i + 1}</span>` +
      `<span class="t-name">${escapeHtml(s.heading)}</span>` +
      '<span class="t-dots"></span><span class="t-page"></span></div>',
    );
  });
  return units;
}

function stepUnits(step: ManualStepModel, index: number, assets: ManualAssets): string[] {
  const n = index + 1;
  const group = `step-${n}`;
  const body = step.body ? `<div class="step-body">${renderBlocks(step.body)}</div>` : '';
  const units = [
    `<section class="unit step-head" data-unit data-group="${group}" data-anchor="${group}">` +
    `<h2><span class="step-num">${n}</span>${escapeHtml(step.heading)}</h2>${body}</section>`,
  ];
  if (step.image) {
    const { width, height, caption } = step.image;
    // Intrinsic size keeps the aspect box correct before the image decodes,
    // which is what makes the measured layout stable for the paginator. Unknown
    // (non-PNG) sizes emit no attributes rather than bogus ones.
    const dims = width && height ? ` width="${width}" height="${height}"` : '';
    const figcaption = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
    units.push(
      `<figure class="unit step-fig" data-unit data-group="${group}">` +
      `<img alt="${escapeHtml(caption ?? step.heading)}" src="${imageSrc(step, assets)}"${dims}>${figcaption}</figure>`,
    );
  }
  return units;
}

export function renderHtmlDocument(model: ManualModel, options: ManualHtmlOptions = {}): ManualHtmlResult {
  const assets: ManualAssets = options.assets ?? 'inline';
  const lang = normalizeLang(options.lang ?? 'ca') || 'ca';
  const l = labelsFor(lang);
  const withCover = options.cover ?? true;
  const withToc = options.toc ?? model.steps.length >= 4;
  const date = options.date ?? new Date();
  const base = options.assetBase ?? 'manual';

  const flow: string[] = [];
  if (withCover) flow.push(coverSheet(model, l, lang, date));
  else {
    flow.push(`<div class="unit toc-title" data-unit data-group="head">${escapeHtml(model.title)}</div>`);
    if (model.intro) flow.push(`<div class="unit step-body" data-unit data-group="head">${renderBlocks(model.intro)}</div>`);
  }
  if (withToc) flow.push(...tocUnits(model, l));
  model.steps.forEach((s, i) => flow.push(...stepUnits(s, i, assets)));

  const title = escapeHtml(model.title);
  const head = assets === 'files'
    ? `<link rel="stylesheet" href="${escapeHtml(base)}.css">`
    : `<style>${MANUAL_CSS}</style>`;
  const tail = assets === 'files'
    ? `<script src="${escapeHtml(base)}.js"></script>`
    : `<script>${MANUAL_JS}</script>`;

  const html = `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script>document.documentElement.className += ' js';</script>
${head}
</head>
<body>
<div class="toolbar no-print">
  <span class="print-hint">${escapeHtml(l.hint)}</span>
  <button class="print-btn" type="button" data-print>${PRINTER_ICON}${escapeHtml(l.print)}</button>
</div>

<div id="doc" class="doc"></div>

<div id="flow">
${flow.join('\n')}
</div>

<template id="sheet-tpl"><div class="sheet">
  <header class="sheet-head"><span class="h-title">${title}</span><span class="h-kicker">${escapeHtml(l.manual)}</span></header>
  <div class="sheet-body"></div>
  <footer class="sheet-foot"><span class="f-left">${escapeHtml(l.manual)}</span><span class="page-no"></span></footer>
</div></template>
${tail}
</body>
</html>`;

  return assets === 'files' ? { html, css: MANUAL_CSS, js: MANUAL_JS } : { html };
}
