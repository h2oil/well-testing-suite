// prism-build/tests/a11y.test.js — P10 accessibility + P6 drawing/formatting checks.
//
// The accessible-name, focusability and contrast rules below are independent
// re-implementations (W3C accname 1.2 subset; HTML focus rules; WCAG 2.2
// relative-luminance formula), not calls into prism-build/50-a11y.js, so the
// layer is checked against the standards rather than against itself.
'use strict';

const CTL = 'input, select, textarea';

// ── independent accessible-name subset (accname 1.2 §4.3 steps 2B–2I) ──
function textOf(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('input, select, textarea, button, script, style, [aria-hidden="true"]').forEach((n) => n.remove());
  return String(c.textContent || '').replace(/\s+/g, ' ').trim();
}
function accName(doc, el) {
  const lb = el.getAttribute('aria-labelledby');
  if (lb) { const s = lb.split(/\s+/).map((id) => { const r = doc.getElementById(id); return r ? textOf(r) : ''; }).join(' ').trim(); if (s) return s; }
  const al = (el.getAttribute('aria-label') || '').trim();
  if (al) return al;
  const tag = el.localName;
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (el.id) { const l = doc.querySelector('label[for="' + el.id + '"]'); if (l && textOf(l)) return textOf(l); }
    const w = el.closest('label'); if (w && textOf(w)) return textOf(w);
    if (tag === 'input' && /^(button|submit|reset)$/.test(el.type) && el.value) return el.value;
  }
  if (tag === 'button' || /^(button|tab|link)$/.test(el.getAttribute('role') || '')) {
    const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (/[A-Za-z0-9]/.test(t)) return t;
  }
  return (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
}
const reportable = (el) => !(el.localName === 'input' && /^(hidden|submit|reset|image)$/.test(el.type || ''));

// ── WCAG 2.2 contrast ──
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function routes(app) {
  return app.findAll('#sidebar .nav-btn').map((b) => b.getAttribute('data-p')).filter(Boolean);
}
function unnamed(app, root) {
  const doc = app.document;
  return Array.from((root || doc).querySelectorAll(CTL)).filter(reportable).filter((c) => !accName(doc, c))
    .map((c) => (c.id || c.localName + '[' + (c.getAttribute('type') || '') + ']'));
}

// A recording canvas plus transforms for the decimation checks.
function pathOps(app, canvas) {
  return app.canvasLog(canvas).filter((e) => e.op === 'moveTo' || e.op === 'lineTo').map((e) => ({ op: e.op, x: e.args[0], y: e.args[1] }));
}

module.exports = [
  {
    name: 'a11y: every form control on every sidebar page (and PRiSM tabs 1-7) has an accessible name',
    wp: 'A11Y',
    timeoutMs: 240000,
    run(app, assert) {
      const bad = [];
      let checked = 0;
      const count = () => { checked += app.findAll('#pgBody input, #pgBody select, #pgBody textarea').length; };
      const head = unnamed(app, app.el('wts_unit_toggle_host').parentNode);
      if (head.length) bad.push('header: ' + head.join(', '));
      for (const r of routes(app)) {
        app.hook.nav(r);
        app.flush(400);
        count();
        const u = unnamed(app, app.el('pgBody'));
        if (u.length) bad.push(r + ': ' + u.slice(0, 8).join(', ') + (u.length > 8 ? ' … (' + u.length + ')' : ''));
      }
      app.openPRiSM(); app.seedSample(); app.flush(300);
      for (let t = 1; t <= 7; t++) {
        try { app.gotoTab(t); } catch (e) { continue; }
        app.flush(300);
        const u = unnamed(app, app.el('pgBody'));
        if (u.length) bad.push('prism tab ' + t + ': ' + u.slice(0, 8).join(', ') + (u.length > 8 ? ' … (' + u.length + ')' : ''));
      }
      assert.deepEqual(bad, [], 'controls without an accessible name');
      assert.ok(checked > 800, 'controls checked: ' + checked);
      assert.ok(routes(app).length >= 55, 'routes: ' + routes(app).length);
    },
  },
  {
    name: 'a11y: click targets are buttons (native or role=button + tabindex) and no positive tabindex',
    wp: 'A11Y',
    timeoutMs: 240000,
    run(app, assert) {
      const bad = [];
      const check = (where) => {
        app.findAll('.nav-btn, .dash-card, [data-dc], [onclick]').forEach((el) => {
          if (el.id === 'sidebarOverlay') return;
          if (/^(button|a|input|select|textarea|label)$/.test(el.localName)) return;
          if (el.querySelector('button, a[href], input, select, textarea')) return;
          const role = el.getAttribute('role'), ti = el.getAttribute('tabindex');
          if (role !== 'button' && role !== 'tab' && role !== 'link') bad.push(where + ': ' + (el.id || el.className) + ' has no button role');
          if (ti == null) bad.push(where + ': ' + (el.id || el.getAttribute('data-p') || el.className) + ' is not focusable');
        });
        app.findAll('[tabindex]').forEach((el) => { if (+el.getAttribute('tabindex') > 0) bad.push(where + ': positive tabindex on ' + (el.id || el.localName)); });
        app.findAll('button').forEach((b) => { if (!accName(app.document, b)) bad.push(where + ': button without a name ' + (b.id || b.outerHTML.slice(0, 60))); });
      };
      check('start');
      for (const r of ['home', 'prv', 'flare', 'gasdeliv', 'wts', 'prism']) { app.hook.nav(r); app.flush(300); check(r); }
      assert.deepEqual(bad.slice(0, 30), []);
    },
  },
  {
    name: 'a11y: sidebar is one tab stop with arrow-key roving; Enter opens the page; aria-current follows',
    wp: 'A11Y',
    run(app, assert) {
      const btns = () => app.findAll('#sidebar .nav-btn');
      const stops = btns().filter((b) => b.getAttribute('tabindex') === '0');
      assert.equal(stops.length, 1, 'exactly one tabbable sidebar button');
      const active = btns().find((b) => b.classList.contains('active'));
      assert.equal(stops[0], active, 'the tab stop is the current page');
      assert.equal(active.getAttribute('aria-current'), 'page');
      active.focus();
      app.key(active, 'ArrowDown');
      const i = btns().indexOf(active);
      const next = btns()[i + 1];
      assert.equal(app.document.activeElement, next, 'ArrowDown moves focus to the next page');
      assert.equal(next.getAttribute('tabindex'), '0');
      assert.equal(active.getAttribute('tabindex'), '-1');
      // v3.1 accordion + hubs: End / Home go to the last / first button the sidebar shows (closed
      // groups show only their active button; hub members show only while searching)
      const shown = () => btns().filter((b) => !b.classList.contains('sb-hide') && !b.classList.contains('nav-hub-member') &&
        !(b.closest('.nav-group').classList.contains('collapsed') && !b.classList.contains('active')));
      assert.ok(shown().length < btns().length, 'some buttons hidden by the accordion');
      app.key(next, 'End');
      const last = shown()[shown().length - 1];
      assert.equal(app.document.activeElement, last, 'End → last shown');
      app.key(last, 'Home');
      assert.equal(app.document.activeElement, shown()[0], 'Home → first shown');
      const target = btns().find((b) => b.getAttribute('data-p') === 'aga3');
      target.focus();
      app.key(target, 'Enter');
      app.flush(100);
      assert.equal(app.hook.page(), 'aga3', 'Enter opened the page');
      assert.equal(target.getAttribute('aria-current'), 'page');
      assert.equal(active.getAttribute('aria-current'), null);
      // a dashboard tile is a keyboard button too
      app.hook.nav('home'); app.flush(50);
      const tile = app.find('.dash-card');
      // v3.0 dashboard marks tiles role="link" (they navigate to a page); either keyboard role is correct.
      assert.ok(/^(button|link)$/.test(tile.getAttribute('role') || ''), 'tile has a keyboard role: ' + tile.getAttribute('role'));
      assert.equal(tile.getAttribute('tabindex'), '0');
      tile.focus(); app.key(tile, ' ');
      app.flush(50);
      assert.notEqual(app.hook.page(), 'home', 'Space on a tile opens its calculator');
    },
  },
  {
    name: 'a11y: host tab strip is a tablist; ←/→ move and activate; aria-selected + roving tabindex',
    wp: 'A11Y',
    run(app, assert) {
      app.hook.nav('prv'); app.flush(100);
      const list = app.el('prv_tabs');
      assert.equal(list.getAttribute('role'), 'tablist');
      const tabs = Array.from(list.children).filter((c) => c.classList.contains('tab-btn'));
      assert.ok(tabs.length >= 2);
      tabs.forEach((t) => assert.equal(t.getAttribute('role'), 'tab'));
      const sel = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
      assert.equal(sel.length, 1, 'one selected tab');
      assert.ok(sel[0].classList.contains('active'));
      assert.deepEqual(tabs.map((t) => t.getAttribute('tabindex')), tabs.map((t) => (t === sel[0] ? '0' : '-1')));
      const i = tabs.indexOf(sel[0]);
      sel[0].focus();
      app.key(sel[0], 'ArrowRight');
      const now = Array.from(app.el('prv_tabs').children).filter((c) => c.classList.contains('tab-btn'));
      const want = now[(i + 1) % now.length];
      assert.ok(want.classList.contains('active'), 'ArrowRight activated the next tab');
      assert.equal(want.getAttribute('aria-selected'), 'true');
      assert.equal(want.getAttribute('tabindex'), '0');
      assert.equal(now[i].getAttribute('aria-selected'), 'false');
    },
  },
  {
    name: 'a11y: units toggle is a labelled group with aria-pressed; Std select named; skip link + landmarks',
    wp: 'A11Y',
    run(app, assert) {
      const g = app.el('wts_unit_toggle');
      assert.equal(g.getAttribute('role'), 'group');
      assert.ok(accName(app.document, g) || g.getAttribute('aria-label'));
      const imp = app.el('wts_units_imperial'), met = app.el('wts_units_metric');
      assert.equal(imp.getAttribute('aria-pressed'), 'true');
      assert.equal(met.getAttribute('aria-pressed'), 'false');
      app.click(met); app.flush(50);
      assert.equal(imp.getAttribute('aria-pressed'), 'false');
      assert.equal(met.getAttribute('aria-pressed'), 'true');
      assert.ok(accName(app.document, app.el('wts_base_select')), 'Std select has a name');
      const dc = app.el('wts_dec_comma');
      assert.ok(dc && dc.localName === 'button' && dc.getAttribute('aria-pressed') === 'false', 'decimal-comma toggle, off by default');
      assert.equal(app.document.body.firstElementChild.id, 'wts_skip_link', 'skip link is the first focusable element');
      assert.equal(app.el('sidebar').getAttribute('role'), 'navigation');
      assert.equal(app.find('.main').getAttribute('role'), 'main');
      assert.ok(accName(app.document, app.el('mobBurger')), 'menu button named');
    },
  },
  {
    name: 'a11y: result areas are polite live regions; canvases are named images with a data summary',
    wp: 'A11Y',
    run(app, assert) {
      app.hook.nav('gasdeliv'); app.flush(400);
      const res = app.findAll('#pgBody [id$="_res"]');
      assert.ok(res.length >= 1);
      res.forEach((r) => assert.equal(r.getAttribute('aria-live'), 'polite', r.id));
      const cvs = app.canvases(app.el('pgBody'));
      assert.ok(cvs.length >= 1);
      cvs.forEach((c) => { assert.equal(c.getAttribute('role'), 'img'); assert.ok(c.getAttribute('aria-label')); });
      // drawLineChart summary ("… N points, <y> a to b over <x> c to d")
      const lab = cvs.map((c) => c.getAttribute('aria-label')).join(' | ');
      assert.match(lab, /Chart of .+ against .+\. .*\d+ points/, 'summary: ' + lab);
    },
  },
  {
    name: 'a11y: PRiSM plot canvas carries role=img and a summary with the plotted point count',
    wp: 'A11Y',
    run(app, assert) {
      app.openPRiSM(); app.flush(100);
      // 40 log-spaced build-up samples, Δp = 20·ln(t) + 100 (all positive → all plotted)
      const t = [], dp = [];
      for (let i = 0; i < 40; i++) { t.push(Math.pow(10, -2 + i * 0.1)); dp.push(20 * Math.log(t[i]) + 100); }
      const deriv = Array.from(app.win.PRiSM_compute_bourdet(app.toWin(t), app.toWin(dp), 0.1));
      const c = app.document.createElement('canvas'); c.style.width = '600px'; c.style.height = '360px';
      app.el('pgBody').appendChild(c);
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t, dp, deriv }), app.toWin({}));
      assert.equal(c.getAttribute('role'), 'img');
      const lab = c.getAttribute('aria-label') || '';
      assert.match(lab, /^bourdet plot: Δp against Δt\. 40 points; /, lab);
      // ranges: Δt 0.01 … 10^1.9 = 79.4, Δp 20·ln(0.01)+100 = 7.897 … 20·1.9·ln(10)+100 = 187.498 (3 s.f.: 7.9 … 187)
      assert.match(lab, /Δt 0\.01 to 79\.4, Δp 7\.9 to 187\./, lab);
      // an author label is never replaced
      const c2 = app.document.createElement('canvas'); c2.setAttribute('aria-label', 'Mine'); app.el('pgBody').appendChild(c2);
      app.win.PRiSM_plot_bourdet(c2, app.toWin({ t, dp, deriv }), app.toWin({}));
      assert.equal(c2.getAttribute('aria-label'), 'Mine');
    },
  },
  {
    name: 'decimal comma: off by default ("12,5" stays text); on → 12,5 is read as 12.5 (keyboard value path)',
    wp: 'A11Y',
    async run(app, assert, ctx) {
      app.hook.nav('aga3'); app.flush(200);
      const inp = app.findAll('#pgBody input[type="number"]')[0];
      assert.ok(inp, 'a number input');
      app.input(inp, '12,5');
      assert.equal(inp.value, '12,5', 'setting off: value untouched');
      assert.equal(app.win.WTS_parseNumber('12,5'), 12, 'setting off: plain parseFloat');
      app.click('wts_dec_comma');
      assert.equal(app.el('wts_dec_comma').getAttribute('aria-pressed'), 'true');
      assert.equal(app.storage.getItem('wtspref_decimal_comma'), '1');
      app.input(inp, '12,5');
      assert.equal(inp.value, '12.5', '12 + 5/10');
      app.input(inp, '-0,75');
      assert.equal(inp.value, '-0.75');
      app.input(inp, '1.234,5');
      assert.equal(inp.value, '1.234,5', 'ambiguous grouping is left alone');
      assert.equal(app.win.WTS_parseNumber('3,25'), 3.25);
      // textareas (CSV paste areas) are never rewritten
      const ta = app.document.createElement('textarea'); app.el('pgBody').appendChild(ta);
      app.input(ta, '1,5');
      assert.equal(ta.value, '1,5');
      // the preference survives a reload and is not a project (wts_*) key
      const app2 = ctx.loadApp({ storage: app.storage });
      assert.equal(app2.el('wts_dec_comma').getAttribute('aria-pressed'), 'true');
      app2.dispose();
    },
  },
  {
    name: 'contrast: dark-theme text tokens ≥ 4.5:1 on every background; text on accent ≥ 4.5:1 (WCAG 2.2 AA)',
    wp: 'A11Y',
    opts: false,
    run(_app, assert) {
      const fs = require('fs'); const path = require('path');
      const html = fs.readFileSync(path.join(__dirname, '..', '..', 'well-testing-app.html'), 'utf8');
      const root = /:root\s*\{([^}]*)\}/.exec(html)[1];
      const v = {}; root.replace(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g, (_, k, c) => { v[k] = c; });
      const bgs = ['--bg0', '--bg1', '--bg2', '--bg3', '--bg4'];
      const bad = [];
      for (const fg of ['--text', '--text2', '--text3', '--accent', '--green', '--blue', '--purple', '--red', '--yellow']) {
        for (const bg of bgs) { const c = contrast(v[fg], v[bg]); if (c < 4.5) bad.push(fg + ' on ' + bg + ' = ' + c.toFixed(2)); }
      }
      for (const fill of ['--accent', '--green']) { const c = contrast(v['--on-accent'], v[fill]); if (c < 4.5) bad.push('--on-accent on ' + fill + ' = ' + c.toFixed(2)); }
      // hand check of the formula: white on black is 21:1, #777777 on white ≈ 4.48:1
      assert.ok(Math.abs(contrast('#ffffff', '#000000') - 21) < 1e-9);
      assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.48) < 0.01);
      assert.deepEqual(bad, []);
      assert.ok(!/\.btn-primary\s*\{[^}]*color:\s*#fff/.test(html), 'primary buttons no longer white on orange');
    },
  },
  {
    name: 'P6: WTS_fmtNum / host fmt are identical to Number#toLocaleString for many values and digit settings',
    wp: 'A11Y',
    run(app, assert) {
      const W = app.win;
      const refFmt = app.evalInApp('(function (v, a, b) { return Number(v).toLocaleString(undefined, { minimumFractionDigits: a, maximumFractionDigits: b }); })');
      const vals = [0, -0, 1, -1, 0.5, 1234.5678, -98765.4321, 1e-7, 3.14159e12, 999.995, 1 / 3, 2.675, 1e21];
      for (const v of vals) {
        for (const [a, b] of [[0, 0], [0, 1], [0, 2], [0, 3], [0, 6], [2, 2], [1, 4]]) {
          const ref = refFmt(v, a, b);
          assert.equal(W.WTS_fmtNum(v, a, b), ref, v + ' ' + a + '/' + b);
        }
      }
      assert.throws(() => W.WTS_fmtNum(1, 3, 1), 'min > max still throws, as toLocaleString does');
      assert.throws(() => refFmt(1, 3, 1));
    },
  },
  {
    name: 'P6: long series are decimated per pixel column (M4) — same extremes and end points; short series untouched',
    wp: 'A11Y',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM(); app.flush(100);
      // the stroked paths of one colour, from the recorded canvas calls
      const strokes = (canvas, color) => {
        const out = []; let cur = [], stroke = null;
        for (const e of app.canvasLog(canvas)) {
          if (e.op === 'set' && e.prop === 'strokeStyle') stroke = e.value;
          else if (e.op === 'beginPath') cur = [];
          else if (e.op === 'moveTo' || e.op === 'lineTo') cur.push({ op: e.op, x: e.args[0], y: e.args[1] });
          else if (e.op === 'stroke' && stroke === color && cur.length) out.push(cur);
        }
        return out;
      };
      const draw = (N, f) => {
        const t = [], p = [];
        for (let i = 0; i < N; i++) { t.push(i * 0.01); p.push(f(i)); }
        const canvas = app.document.createElement('canvas');
        canvas.style.width = '500px'; canvas.style.height = '260px';
        app.el('pgBody').appendChild(canvas);
        W.PRiSM_plot_cartesian(canvas, app.toWin({ t, p }), { showLegend: false });
        const path = strokes(canvas, W.PRiSM_THEME.accent).sort((a, b) => b.length - a.length)[0];
        return { canvas, t, p, path, ax: canvas._prismAxes };
      };
      const N = 20000;
      const f = (i) => 3000 + Math.sin(i / 50) * 100 + ((i * 7919) % 13) - 6;
      const d = draw(N, f);
      assert.ok(d.ax && typeof d.ax.toX === 'function', '_prismAxes transforms');
      const w = d.ax.plot.w;
      assert.ok(d.path.length <= 4 * (Math.ceil(w) + 2), 'vertex count ' + d.path.length + ' for plot width ' + w);
      assert.ok(d.path.length >= Math.floor(w) - 2, 'at least one vertex per pixel column');
      assert.equal(d.path[0].op, 'moveTo');
      const X = (i) => d.ax.toX(d.t[i]), Y = (i) => d.ax.toY(d.p[i]);
      assert.ok(Math.abs(d.path[0].x - X(0)) < 1e-9 && Math.abs(d.path[d.path.length - 1].x - X(N - 1)) < 1e-9, 'first and last sample kept');
      // every pixel column keeps exactly its own lowest and highest vertex
      const col = new Map(), got = new Map();
      for (let i = 0; i < N; i++) { const c = Math.floor(X(i)); const y = Y(i); const e = col.get(c) || [Infinity, -Infinity]; col.set(c, [Math.min(e[0], y), Math.max(e[1], y)]); }
      d.path.forEach((o) => { const c = Math.floor(o.x); const e = got.get(c) || [Infinity, -Infinity]; got.set(c, [Math.min(e[0], o.y), Math.max(e[1], o.y)]); });
      assert.equal(got.size, col.size, 'same pixel columns');
      for (const [c, e] of col) assert.deepEqual(got.get(c), e, 'column ' + c);
      // vertices stay in data order (x never goes backwards)
      for (let i = 1; i < d.path.length; i++) assert.ok(d.path[i].x >= d.path[i - 1].x - 1e-9);
      // a short series is drawn point for point
      const s = draw(300, (i) => 3000 + (i % 17));
      assert.equal(s.path.length, 300);
      // the plot label summarises the full data, not the decimated path
      assert.match(d.canvas.getAttribute('aria-label'), new RegExp(N + ' points'));
    },
  },
];
