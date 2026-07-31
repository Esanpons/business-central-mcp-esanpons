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

    function addSheet() {
      var sheet = tpl.content.firstElementChild.cloneNode(true);
      doc.appendChild(sheet);
      body = sheet.querySelector('.sheet-body');
    }
    function fits() { return body.scrollHeight <= body.clientHeight + 1; }
    function put(nodes) { for (var k = 0; k < nodes.length; k++) body.appendChild(nodes[k]); }
    function pull(nodes) { for (var k = 0; k < nodes.length; k++) body.removeChild(nodes[k]); }

    function place(grp) {
      put(grp);
      if (fits()) return;
      pull(grp);
      if (body.children.length) {
        // The sheet already had content: give the whole group a fresh sheet.
        addSheet();
        put(grp);
        if (fits()) return;
        pull(grp);
      }
      // Too tall even for an empty sheet: place unit by unit.
      for (var u = 0; u < grp.length; u++) {
        body.appendChild(grp[u]);
        if (!fits() && body.children.length > 1) {
          body.removeChild(grp[u]);
          addSheet();
          body.appendChild(grp[u]);
        }
      }
    }

    addSheet();
    var pendingBreak = false;
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      // data-break="after" on the last unit of a group ends the sheet (the index).
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
