/**
 * In-browser paginator for the printable A4 manual.
 *
 * The generated document ships its content as a flat list of measurable units
 * inside a hidden `#flow`; this script measures each one against the real
 * height of a `.sheet-body` and distributes them across A4 sheets, so what the
 * reader sees on screen is exactly what Ctrl+P produces.
 *
 * Units carrying the same `data-group` are kept together when possible (a step
 * heading is never orphaned from its screenshot). A group that does not fit on
 * a fresh sheet is split unit by unit rather than dropped.
 *
 * Kept as a plain string (not a serialized TS function) on purpose: esbuild/tsx
 * rewrites nested named functions with a `__name` helper that does not exist in
 * the browser -- the same trap documented for the screenshot annotator.
 */
export const MANUAL_JS = `(function () {
  'use strict';

  var scale = 1;

  function fit() {
    var doc = document.getElementById('doc');
    var sheet = doc && doc.querySelector('.sheet');
    if (!sheet) return;
    // offsetWidth ignores transforms, so this stays stable across resizes.
    var natural = sheet.offsetWidth;
    var avail = document.documentElement.clientWidth - 24;
    scale = natural > avail ? Math.max(0.3, avail / natural) : 1;
    doc.style.transform = '';
    doc.style.height = '';
    if (scale === 1) return;
    var naturalHeight = doc.scrollHeight;
    doc.style.transform = 'scale(' + scale + ')';
    doc.style.height = (naturalHeight * scale) + 'px';
  }

  function paginate() {
    var doc = document.getElementById('doc');
    var flow = document.getElementById('flow');
    var tpl = document.getElementById('sheet-tpl');
    if (!doc || !flow || !tpl) return;

    doc.innerHTML = '';
    doc.style.transform = '';
    doc.style.height = '';

    var cover = flow.querySelector('[data-cover]');
    if (cover) doc.appendChild(cover);

    // Units in document order, bundled into keep-together groups.
    var units = [].slice.call(flow.querySelectorAll('[data-unit]'));
    var groups = [];
    var byKey = {};
    for (var i = 0; i < units.length; i++) {
      var key = units[i].getAttribute('data-group') || ('_' + i);
      if (!byKey[key]) { byKey[key] = []; groups.push(byKey[key]); }
      byKey[key].push(units[i]);
    }

    var body = null;

    // A figure that misses the sheet by a little is scaled down to fit instead of
    // being sent to the next page, which would leave a hole under the text it
    // belongs to. The floor keeps that a SLIGHT reduction: past it the capture
    // stops being readable in print, and moving it whole is the better answer.
    var MIN_FIG_SCALE = 0.75;

    function addSheet() {
      var sheet = tpl.content.firstElementChild.cloneNode(true);
      doc.appendChild(sheet);
      body = sheet.querySelector('.sheet-body');
    }
    function fits() { return body.scrollHeight <= body.clientHeight + 1; }
    function put(nodes) { for (var k = 0; k < nodes.length; k++) body.appendChild(nodes[k]); }
    function pull(nodes) { for (var k = 0; k < nodes.length; k++) body.removeChild(nodes[k]); }

    // Scale is always measured against the figure's ORIGINAL height, stashed on
    // first touch: without it a unit that is shrunk, rejected and shrunk again on
    // the next sheet compounds the reductions and slips past the floor.
    function figureOf(unit) { return unit.querySelector ? unit.querySelector('img') : null; }
    function restore(unit) {
      var img = figureOf(unit);
      if (img) img.style.height = '';
    }
    function shrinkToFit(unit) {
      var img = figureOf(unit);
      if (!img) return false;
      var over = body.scrollHeight - body.clientHeight;
      if (over <= 0) return true;
      var h0 = parseFloat(img.getAttribute('data-h0') || '0');
      if (!h0) {
        h0 = img.getBoundingClientRect().height;
        img.setAttribute('data-h0', String(h0));
      }
      var target = img.getBoundingClientRect().height - over - 1;
      if (h0 <= 0 || target / h0 < MIN_FIG_SCALE) return false;
      img.style.height = target + 'px';
      return fits();
    }

    function place(grp) {
      put(grp);
      if (fits()) return;
      // All but fits: a slightly smaller figure may be all this group needs.
      for (var s = 0; s < grp.length; s++) if (shrinkToFit(grp[s])) return;
      for (var r = 0; r < grp.length; r++) restore(grp[r]);
      pull(grp);
      if (body.children.length) {
        // The sheet already had content: give the whole group a fresh sheet.
        addSheet();
        put(grp);
        if (fits()) return;
        for (var s2 = 0; s2 < grp.length; s2++) if (shrinkToFit(grp[s2])) return;
        for (var r2 = 0; r2 < grp.length; r2++) restore(grp[r2]);
        pull(grp);
      }
      // Too tall even for an empty sheet: place unit by unit.
      for (var u = 0; u < grp.length; u++) {
        body.appendChild(grp[u]);
        if (!fits() && body.children.length > 1) {
          if (shrinkToFit(grp[u])) continue;
          restore(grp[u]);
          body.removeChild(grp[u]);
          addSheet();
          body.appendChild(grp[u]);
          // Alone on a fresh sheet a figure can still overflow (a very tall
          // capture plus its caption); shrinking is then the only way to keep it
          // on the paper at all, so the floor does not apply.
          if (!fits()) {
            var lone = figureOf(grp[u]);
            if (lone) {
              var excess = body.scrollHeight - body.clientHeight;
              lone.style.height = (lone.getBoundingClientRect().height - excess - 1) + 'px';
            }
          }
        }
      }
    }

    addSheet();
    var pendingBreak = false;
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      // data-break="after" on the last unit of a group ends the sheet (the index);
      // data-break="before" on the first opens one (every step starts a page).
      var head = grp[0];
      if (head && head.getAttribute('data-break') === 'before') pendingBreak = true;
      if (pendingBreak && body.children.length) addSheet();
      pendingBreak = false;
      place(grp);
      var tail = grp[grp.length - 1];
      pendingBreak = !!(tail && tail.getAttribute('data-break') === 'after');
    }

    var sheets = [].slice.call(doc.querySelectorAll('.sheet'));
    var last = sheets[sheets.length - 1];
    if (last && !last.classList.contains('cover')) {
      var lastBody = last.querySelector('.sheet-body');
      if (lastBody && !lastBody.children.length) { doc.removeChild(last); sheets.pop(); }
    }

    for (var s = 0; s < sheets.length; s++) {
      sheets[s].setAttribute('data-page', String(s + 1));
      var no = sheets[s].querySelector('.page-no');
      if (no) no.textContent = (s + 1) + ' / ' + sheets.length;
    }

    // Fill the index with the page each step actually landed on.
    var rows = doc.querySelectorAll('.toc-row');
    for (var r = 0; r < rows.length; r++) {
      var target = rows[r].getAttribute('data-target');
      var anchor = target ? doc.querySelector('[data-anchor="' + target + '"]') : null;
      var host = anchor ? anchor.closest('.sheet') : null;
      var cell = rows[r].querySelector('.t-page');
      if (cell) cell.textContent = host ? host.getAttribute('data-page') : '';
    }

    if (flow.parentNode) flow.parentNode.removeChild(flow);
    doc.setAttribute('data-paginated', '1');
    fit();
  }

  function boot() {
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(paginate, paginate);
    } else {
      paginate();
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);

  window.addEventListener('resize', fit);

  // Printing before pagination finished (very fast Ctrl+P) must not print raw flow.
  window.addEventListener('beforeprint', function () {
    var doc = document.getElementById('doc');
    if (doc && doc.getAttribute('data-paginated') !== '1') paginate();
  });

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-print]') : null;
    if (btn) { e.preventDefault(); window.print(); }
  });
})();
`;
