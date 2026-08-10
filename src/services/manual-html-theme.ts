/**
 * Stylesheet for the printable A4 manual.
 *
 * Screen and print share ONE layout: the document is a stack of `.sheet`
 * elements that are exactly 210x297mm, so what you see is literally the page
 * that comes out of Ctrl+P. Everything that is not part of the paper (the
 * toolbar) is marked `.no-print`.
 *
 * All tunables live in `:root` -- editing those variables restyles the whole
 * manual, which is why the "files" asset mode ships this as a separate .css.
 */
export const MANUAL_CSS = `/* =========================================================================
   Manual imprimible A4 -- generat per bc_build_manual
   Per canviar l'aspecte global, edita nomes les variables de :root.
   ========================================================================= */

:root {
  /* --- Paleta corporativa AESVA --- */
  --teal:       #00ACB8;
  --teal-dark:  #008293;
  --teal-deep:  #006673;
  --ink:        #111518;
  --grey:       #687279;
  --grey-soft:  #8a949b;
  --line:       #e3e8ec;
  --bg-soft:    #edeff2;
  --wash:       #e6f7f8;
  --white:      #ffffff;

  /* --- Tipografia --- */
  --font-body: 'Segoe UI', Roboto, -apple-system, system-ui, sans-serif;
  --font-head: 'Segoe UI', Roboto, -apple-system, system-ui, sans-serif;

  /* --- Geometria del full --- */
  --sheet-w:    210mm;
  --sheet-h:    297mm;
  --pad-x:      16mm;
  --pad-top:    13mm;
  --pad-bottom: 11mm;
  --head-h:     11mm;
  --foot-h:      9mm;

  /* Alcada maxima d'una captura: garanteix que cap imatge parteix un full. */
  --fig-max-h:  180mm;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

body {
  font-family: var(--font-body);
  color: var(--ink);
  background: var(--bg-soft);
  font-size: 10.5pt;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

/* =========================================================================
   FULL A4
   ========================================================================= */
.doc { padding: 10mm 0; transform-origin: top center; }

.sheet {
  position: relative;
  width: var(--sheet-w);
  height: var(--sheet-h);
  margin: 0 auto 8mm;
  padding: var(--pad-top) var(--pad-x) var(--pad-bottom);
  background: var(--white);
  box-shadow: 0 6px 28px rgba(17, 21, 24, .18);
  overflow: hidden;
  display: grid;
  grid-template-rows: var(--head-h) 1fr var(--foot-h);
}

/* El cos es l'unic tram elastic; min-height:0 evita que el grid l'estiri
   i manté clientHeight igual a l'espai real disponible (el paginador s'hi basa). */
.sheet-body {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.sheet-body > * { flex: 0 0 auto; }

/* Capcalera */
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8mm;
  padding-bottom: 3mm;
  border-bottom: 1.5px solid var(--line);
  font-size: 8.2pt;
  color: var(--grey);
}
.sheet-head .h-title {
  font-weight: 600;
  color: var(--teal-dark);
  letter-spacing: .04em;
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sheet-head .h-kicker {
  flex: 0 0 auto;
  letter-spacing: .12em;
  text-transform: uppercase;
  font-size: 7.2pt;
  color: var(--grey-soft);
}

/* Peu */
.sheet-foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8mm;
  padding-top: 3mm;
  border-top: 1px solid var(--line);
  font-size: 7.6pt;
  color: var(--grey-soft);
  letter-spacing: .03em;
}
.sheet-foot .page-no { flex: 0 0 auto; font-weight: 600; color: var(--grey); }

/* =========================================================================
   PORTADA
   ========================================================================= */
.sheet.cover {
  padding: 0;
  grid-template-rows: 40mm 1fr 24mm;
}
.cover-band {
  background: linear-gradient(120deg, var(--teal) 0%, var(--teal-dark) 55%, var(--teal-deep) 100%);
  display: flex;
  align-items: center;
  padding: 0 var(--pad-x);
}
.cover-band .c-kicker {
  color: #ffffff;
  font-size: 10pt;
  font-weight: 600;
  letter-spacing: .22em;
  text-transform: uppercase;
}
.cover-main {
  padding: 22mm var(--pad-x) 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  min-height: 0;
}
.cover-main .c-title {
  font-family: var(--font-head);
  font-size: 30pt;
  font-weight: 700;
  line-height: 1.15;
  color: var(--ink);
  letter-spacing: -.01em;
}
.cover-main .c-rule {
  width: 46mm;
  height: 3px;
  margin: 7mm 0;
  background: var(--teal);
  border-radius: 2px;
}
.cover-main .c-intro {
  font-size: 12pt;
  line-height: 1.6;
  color: #3a4147;
  max-width: 150mm;
}
.cover-main .c-intro p { margin-bottom: 4mm; }
.cover-main .c-intro p:last-child { margin-bottom: 0; }
.cover-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--line);
  margin: 0 var(--pad-x);
  padding: 5mm 0 0;
  font-size: 8.6pt;
  color: var(--grey);
}
.cover-foot .c-brand { font-weight: 600; color: var(--teal-dark); letter-spacing: .06em; }

/* =========================================================================
   INDEX
   ========================================================================= */
.toc-title {
  font-size: 16pt;
  font-weight: 700;
  color: var(--teal-dark);
  margin-bottom: 7mm;
  letter-spacing: .02em;
}
.toc-row {
  display: flex;
  align-items: baseline;
  gap: 3mm;
  margin-bottom: 3.2mm;
  font-size: 10.5pt;
}
.toc-row .t-num {
  flex: 0 0 8mm;
  font-weight: 700;
  color: var(--teal-dark);
}
.toc-row .t-name { flex: 0 1 auto; color: var(--ink); }
.toc-row .t-dots {
  flex: 1 1 auto;
  border-bottom: 1.5px dotted #c9d2d8;
  transform: translateY(-2px);
  min-width: 6mm;
}
.toc-row .t-page { flex: 0 0 auto; font-weight: 600; color: var(--grey); }

/* =========================================================================
   PASSOS
   ========================================================================= */
.step-head { margin-bottom: 4mm; }
.step-head h2 {
  display: flex;
  align-items: center;
  gap: 3.5mm;
  font-family: var(--font-head);
  font-size: 14pt;
  font-weight: 700;
  color: var(--teal-deep);
  margin-bottom: 3mm;
  letter-spacing: -.005em;
}
.step-head .step-num {
  flex: 0 0 auto;
  width: 8.5mm;
  height: 8.5mm;
  border-radius: 50%;
  background: var(--teal);
  color: #ffffff;
  font-size: 10.5pt;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.step-body p { margin-bottom: 3mm; color: #2b3238; }
.step-body p:last-child { margin-bottom: 0; }
.step-body ul, .step-body ol { margin: 0 0 3mm 6mm; }
.step-body li { margin-bottom: 1.6mm; color: #2b3238; }
.step-body ul { list-style: none; }
.step-body ul > li { position: relative; padding-left: 4mm; }
.step-body ul > li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 2.1mm;
  width: 1.6mm;
  height: 1.6mm;
  border-radius: 50%;
  background: var(--teal-dark);
}
.step-body code {
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 9.2pt;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 4px;
}
.step-body a { color: var(--teal-dark); text-decoration: none; border-bottom: 1px solid #bfe6ea; }
.step-body blockquote {
  margin: 0 0 3mm;
  padding: 3mm 4mm;
  background: var(--wash);
  border-left: 3px solid var(--teal);
  border-radius: 0 5px 5px 0;
  color: var(--teal-deep);
  font-size: 10pt;
}

/* Captura */
.step-fig { margin: 0 0 7mm; }
.step-fig img {
  display: block;
  margin: 0 auto;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: var(--fig-max-h);
  border: 1px solid var(--line);
  border-radius: 5px;
  box-shadow: 0 2px 8px rgba(17, 21, 24, .10);
}
.step-fig figcaption {
  margin-top: 2mm;
  text-align: center;
  font-size: 8.2pt;
  color: var(--grey-soft);
}

/* Contingut en brut abans de paginar. Amb JS queda amagat (el paginador el
   buida i l'elimina); sense JS es el fallback llegible i imprimible. */
#flow { padding: 10mm 16mm; background: var(--white); }
html.js #flow { visibility: hidden; height: 0; overflow: hidden; padding: 0; }

/* =========================================================================
   BARRA D'IMPRESSIO (nomes pantalla)
   ========================================================================= */
/* A baix a la dreta: aixi no tapa mai la cantonada del full. */
.toolbar {
  position: fixed;
  bottom: 18px;
  right: 18px;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.print-btn {
  font-family: var(--font-body);
  font-size: 10pt;
  font-weight: 600;
  color: #ffffff;
  background: var(--teal-dark);
  border: none;
  border-radius: 24px;
  padding: 10px 20px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 130, 147, .35);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: background .15s ease, transform .1s ease;
}
.print-btn:hover { background: var(--teal); transform: translateY(-1px); }
.print-btn svg { width: 16px; height: 16px; fill: #ffffff; }
/* El consell nomes apareix en passar per sobre: no molesta la lectura. */
.print-hint {
  font-size: 8pt;
  color: var(--grey);
  background: #ffffff;
  padding: 6px 10px;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .10);
  max-width: 210px;
  line-height: 1.35;
  opacity: 0;
  transform: translateX(8px);
  pointer-events: none;
  transition: opacity .15s ease, transform .15s ease;
}
.toolbar:hover .print-hint { opacity: 1; transform: translateX(0); }

/* =========================================================================
   IMPRESSIO
   ========================================================================= */
@media print {
  @page { size: A4; margin: 0; }
  html, body { background: #ffffff; }
  .no-print { display: none !important; }
  .doc { padding: 0; transform: none !important; }
  .sheet {
    margin: 0;
    box-shadow: none;
    /* Els 0.2mm de menys eviten els fulls en blanc que Chrome intercala quan
       l'alcada del full quadra exactament amb la de la pagina (arrodoniments). */
    height: calc(var(--sheet-h) - 0.2mm);
    break-after: page;
    page-break-after: always;
    break-inside: avoid;
  }
  .sheet:last-child { break-after: auto; page-break-after: auto; }
}
`;
