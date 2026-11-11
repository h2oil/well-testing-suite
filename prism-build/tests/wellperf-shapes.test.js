// Well Performance WP0 contracts — docs/WELL-PERFORMANCE-PLAN.md §3, §2.8, §2.9, §17.1 (wellperf-shapes, 4 tests).
//
// WS1 fixtures frozen (hash pin) and well formed; WS2 WTS_wp_model read / write / scalars / decimation / cap / future version / DFIT
// geometry import; WS3 the stub contract (window.__WP_STUBS, {ok:false, code:'STUB'}) and the page registry entry; WS4 the page shell
// (one calc at open, events, re-read on a well switch) and the report-capture rules the page is built on.
'use strict';

const crypto = require('crypto');
const S = require('./_wellperf-shapes');

const WP = 'WP0';
// sha256 (first 16 hex) of JSON.stringify of every fixture in FIX order — bump only through the lead (fixtures are frozen)
const FIX_HASH = '84831ce1a23dd80a';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));   // values from the app realm → this realm
const fixHash = () => crypto.createHash('sha256').update(JSON.stringify(Object.keys(S.FIX).map((k) => S.FIX[k]))).digest('hex').slice(0, 16);

module.exports = [
  {
    name: 'WS1 fixtures: frozen (hash pin), complete models (SHAPE.M), the minimum-curvature answers of FIX.devSurvey are closed form and consistent',
    wp: WP,
    opts: false,
    run(app, assert) {
      assert.strictEqual(fixHash(), FIX_HASH, 'fixtures changed — they are frozen after WP0 (lead only)');
      ['oilWell', 'gasWell', 'fallingBranch'].forEach((k) => { const r = S.checkShape('M', S.FIX[k]); assert.ok(r.ok, k + ': ' + r.errors.join('; ')); });
      assert.ok(S.FIX.oilWell !== S.FIX.oilWell, 'each read is a fresh copy');
      const d = S.FIX.devSurvey;
      assert.strictEqual(d.rows.length, d.expect.length);
      d.expect.forEach((e, i) => {
        assert.strictEqual(e.md, d.rows[i][0]);
        assert.ok(Math.abs(Math.hypot(e.n, e.e) - e.dep) < 1e-9, 'departure = √(N² + E²) at ' + e.md);
        if (i > 0) assert.ok(e.tvd >= d.expect[i - 1].tvd - 1e-9 && e.md - d.expect[i - 1].md >= e.tvd - d.expect[i - 1].tvd - 1e-9, 'ΔTVD ≤ ΔMD');
      });
      const last = d.expect[d.expect.length - 2];
      assert.rel(last.tvd, 1000 + d.R, 1e-12, 'TVD at 90° = KOP + R');
      assert.rel(last.dep, d.R, 1e-12, 'departure at 90° = R');
      const g = S.FIX.gasWell.well.survey;
      assert.ok(g.every((r) => r.length === 3) && g[g.length - 1][0] === 10000, 'gas well: MD / inc / azi to 10,000 ft');
      assert.ok(S.FIX.fallingBranch.expect && S.FIX.fallingBranch.expect.confirmedBy === 'WP5');
      const dg = S.FIX.dfitGeometry;
      assert.ok(dg.state.tests[0].id === 't1' && dg.test.inputs.survey.length === 3, 'DFIT test record');
      assert.ok(S.SHAPES.join(',') === 'M,I,G,SkinTable,Job,R', 'shape names: ' + S.SHAPES.join(','));
      assert.ok(S.BASELINE.traverse8000ft_50ft_ms > 0 && S.BASELINE.E_ms > 0, 'timing baseline recorded');
    },
  },
  {
    name: 'WS2 WTS_wp_model: frozen defaults; table write / read round trip with the event; scalars (WC %, wp_ip_*); survey decimation; 256 kB cap; future version read-only; DFIT geometry import',
    wp: WP,
    run(app, assert) {
      const W = app.win.WTS_wp_model;
      assert.ok(W && typeof W.read === 'function' && typeof W.write === 'function', 'WTS_wp_model');
      S.resetWellPerf(app);
      const M0 = W.read();
      assert.ok(Object.isFrozen(M0) && Object.isFrozen(M0.fluid.corr), 'deep frozen');
      const c = S.checkShape('M', M0); assert.ok(c.ok, c.errors.join('; '));
      assert.strictEqual(M0.meta.status, 'none');
      assert.strictEqual(M0.res.pr, null, 'p̄r has no default (§2.10)');
      assert.strictEqual(M0.surface.rating.wellhead_psi, null, 'no default rating (Q20)');
      assert.strictEqual(M0.system.corr.line, 'bb');
      const events = [];
      app.document.addEventListener('wts:wellperf-model-changed', (e) => events.push(e.detail));
      const oil = S.FIX.oilWell;
      const r = W.write({ survey: oil.well.survey, strings: oil.well.strings, flowline: oil.surface.flowline, tests: [S.FIX.test1], rating: { wellhead_psi: 5000, tht_max_F: 250 } });
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(plain(events).map((e) => e.keys.sort().join(',')), ['flowline,rating,strings,survey,tests']);
      app.storage.setItem('wts_page_wellperf', JSON.stringify({ f: { wp_wc: '30', wp_pr: '3000', wp_ip_J: '2', wp_ftype: 'oil', wp_bean: '32', wp_choke: 'true', wp_corr_well: 'hb', wp_ftype_bad: 'x' } }));
      const M = W.read();
      assert.deepStrictEqual(plain(M.well.survey), oil.well.survey);
      assert.strictEqual(M.well.strings.length, 2);
      assert.strictEqual(M.tests[0].gauge_psia, 2500);
      assert.strictEqual(M.surface.rating.wellhead_psi, 5000);
      assert.rel(M.fluid.wc, 0.30, 1e-12, 'the WC control is in %');
      assert.strictEqual(M.res.pr, 3000); assert.strictEqual(M.res.params.J, 2); assert.strictEqual(M.surface.choke.bean64, 32);
      assert.strictEqual(M.system.corr.well, 'hb', 'correlation keys are strings (D3)');
      const live = W.read({ scalars: { wp_pr: '2800', wp_wc: '' } });
      assert.strictEqual(live.res.pr, 2800, 'live values override stored ones'); assert.strictEqual(live.fluid.wc, null, 'blank → null, never a default');
      // survey decimation: the largest-dogleg stations survive
      const big = []; for (let i = 0; i <= 2600; i++) big.push([i * 5, i === 1300 ? 30 : 0, 0]);
      const dec = W.decimate(big, 2000);
      assert.strictEqual(dec.rows.length, 2000); assert.strictEqual(dec.removed, 601);
      assert.ok(dec.rows.some((x) => x[0] === 6500), 'the dogleg station is kept');
      assert.deepStrictEqual(plain([dec.rows[0], dec.rows[dec.rows.length - 1]]), [big[0], big[big.length - 1]], 'end points kept');
      const wr = W.write({ survey: big });
      assert.ok(wr.ok && wr.decimated === 601 && wr.warnings.some((w) => w.code === 'SURVEY_DECIMATED'), JSON.stringify(wr).slice(0, 200));
      // cap
      const huge = { cases: [] }; for (let i = 0; i < 20; i++) huge.cases.push({ blob: 'x'.repeat(14000) });
      const cr = W.write(huge);
      assert.strictEqual(cr.code, 'TOO_BIG', 'over 256 kB refused');
      // future version: read-only with a note, writes refused
      const keep = app.storage.getItem('wts_wellperf_model');
      app.storage.setItem('wts_wellperf_model', JSON.stringify({ v: 2, survey: [] }));
      const Mf = W.read();
      assert.ok(Mf.meta.readOnly && /newer app/.test(Mf.meta.notes.join(' ')), 'future version read-only');
      assert.strictEqual(W.write({ beans: [32] }).code, 'READ_ONLY');
      app.storage.setItem('wts_wellperf_model', keep);
      // DFIT geometry (read-only mapping of a test's inputs)
      const dg = S.FIX.dfitGeometry;
      const m = W.fromDfit(dg.test);
      assert.deepStrictEqual(plain({ ok: m.ok, patch: m.patch, scalars: m.scalars }), dg.expect);
      app.win.PRiSM_state = app.win.PRiSM_state || {};
      const saved = app.win.PRiSM_state.dfit;
      app.win.PRiSM_state.dfit = dg.state;
      try {
        assert.deepStrictEqual(plain(W.dfitTests()).map((t) => [t.id, t.survey, t.strings, t.datumMd]), [['t1', 3, 2, 9500]]);
        assert.deepStrictEqual(plain(W.fromDfit('t1').patch), dg.expect.patch, 'by test id');
        assert.strictEqual(W.fromDfit('t9').code, 'NO_DFIT_TEST');
      } finally { app.win.PRiSM_state.dfit = saved; }
      S.resetWellPerf(app);
    },
  },
  {
    name: 'WS3 stubs and registry: every WP0 stub is a function returning {ok:false, code:"STUB"} and is listed in window.__WP_STUBS; the wellperf entry is well formed (hub member, silent restore)',
    wp: WP,
    run(app, assert) {
      const G = app.win, listed = plain(G.__WP_STUBS || []);
      Object.keys(S.STUBS).forEach((wp) => S.STUBS[wp].forEach((n) => {
        const p = n.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]];
        assert.strictEqual(typeof f, 'function', n + ' is a function');
        if (listed.indexOf(n) === -1) return;          // implemented by its work package
        const r = f();
        assert.ok(r && r.ok === false && r.code === 'STUB' && r.wp === wp && r.name === n, n + ' → STUB of ' + wp + ': ' + JSON.stringify(r));
      }));
      const all = [].concat.apply([], Object.keys(S.STUBS).map((k) => S.STUBS[k]));
      assert.deepStrictEqual(listed.filter((n) => all.indexOf(n) === -1), [], 'no unknown stub names');
      assert.ok(G.WTS_wp_ipr && typeof G.WTS_wp_ipr.models === 'object', 'WTS_wp_ipr.models registry');
      const e = G.WTS_calcRegistry && G.WTS_calcRegistry.wellperf;
      assert.ok(e && e.key === 'wellperf' && e.group === 'Production & Reservoir' && e.hooks && e.hooks.silent === true && typeof e.hooks.after === 'function', 'registry entry');
      assert.strictEqual(typeof G.renderWellPerf, 'function'); assert.strictEqual(typeof G.calcWellPerf, 'function');
      assert.ok(/^calc[A-Z]/.test('calcWellPerf'), 'calc name wrapped by the units layer');
    },
  },
  {
    name: 'WS4 page shell + report capture: one calc at open, wts:wellperf-solved, re-read on a well switch; reports take visible blocks only (.rp-skip and hidden steps are left out, canvases need a drawn size)',
    wp: WP,
    run(app, assert) {
      const G = app.win;
      S.resetWellPerf(app);
      const solved = [];
      app.document.addEventListener('wts:wellperf-solved', (e) => solved.push(e.detail));
      const n0 = G.WTS_wellperf_page.calcs();
      app.hook.nav('wellperf');
      app.flush(50);
      assert.strictEqual(G.WTS_wellperf_page.calcs() - n0, 1, 'one calc at open (silent restore)');
      assert.ok(app.el('wp_root') && app.el('wp_res'), '#wp_root and the compact block #wp_res');
      assert.strictEqual(G.WTS_state.wellperf.v, 1);
      assert.deepStrictEqual(plain(solved), [{ ok: false }], 'wts:wellperf-solved fired');
      const n1 = G.WTS_wellperf_page.calcs();
      app.document.dispatchEvent(new G.CustomEvent('wts:well-changed', { detail: {} }));
      app.document.dispatchEvent(new G.CustomEvent('wts:project-loaded', { detail: {} }));
      assert.strictEqual(G.WTS_wellperf_page.calcs() - n1, 2, 're-read on a well switch and a project open');
      // report-capture rules (host collectPageReport): the markup the page is built on (§2.9)
      const root = app.el('wp_root');
      root.insertAdjacentHTML('beforeend',
        '<div class="rp-skip" id="wpx_strip"><div class="card"><div class="card-title">Steps</div><div class="rrow"><span class="rl">Skip me</span><span class="rv">1</span></div></div></div>' +
        '<section id="wpx_step5" style="display:none"><div class="rbox"><div class="rbox-title">Hidden step card</div><div class="rrow"><span class="rl">Hidden row</span><span class="rv">2</span></div><div class="chart-wrap"><canvas id="wpx_cvh"></canvas></div></div></section>' +
        '<div class="rbox" id="wpx_block"><div class="rbox-title">Operating point</div><div class="rrow"><span class="rl">Oil rate</span><span class="rv">812 STB/d</span></div>' +
        '<div class="chart-wrap"><canvas id="wpx_cv"></canvas></div><div class="chart-wrap"><canvas id="wpx_cv0"></canvas></div>' +
        '<div style="color:var(--green)">✓ Stable operating point.</div></div>');
      const cv = app.el('wpx_cv'); cv.width = 640; cv.height = 360;                      // explicit size, drawn even while hidden
      const cx = cv.getContext('2d'); cx.fillStyle = '#0a0'; cx.fillRect(10, 10, 100, 50);
      const cv0 = app.el('wpx_cv0'); cv0.width = 0; cv0.height = 0;                     // never sized → not in the report
      const cvh = app.el('wpx_cvh'); cvh.width = 640; cvh.height = 360;                  // sized but in a hidden step → not in the report
      // the harness canvas reads back blank, so the host's snapshot hook (__h2oilSnapshot, checked before the blank test) stands in for pixels
      [cv, cv0, cvh].forEach((c) => { c.__h2oilSnapshot = () => 'data:image/png;base64,AAAA'; });
      const m = G.collectPageReport(app.el('pgBody'), { charts: true });
      const flat = JSON.stringify(m);
      assert.ok(/Operating point/.test(flat) && /812 STB\/d/.test(flat) && /Stable operating point/.test(flat), 'visible block, row and verdict captured');
      assert.ok(!/Skip me/.test(flat), '.rp-skip left out');
      assert.ok(!/Hidden row|Hidden step card/.test(flat), 'a hidden step is left out: reportable cards belong in the always-visible #wp_res');
      const charts = m.results.reduce((a, s) => a.concat(s.items.filter((i) => i.type === 'chart')), []);
      assert.strictEqual(charts.length, 1, 'the sized canvas only: ' + charts.length);
      assert.strictEqual(charts[0].w, 640); assert.strictEqual(charts[0].h, 360);
      ['wpx_strip', 'wpx_step5', 'wpx_block'].forEach((id) => { const x = app.el(id); x.parentNode.removeChild(x); });
      S.resetWellPerf(app);
    },
  },
];
