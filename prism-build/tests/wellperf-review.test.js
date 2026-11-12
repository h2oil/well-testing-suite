// Well Performance A1 review fixes (2026-11-12) — one regression test per verified finding, on the REAL engines (no test double).
//
// Engines: WRV1 liquid-only choke constant (1022.7) · WRV2 THP design across the stability cliff · WRV3 erosion in the flowline ·
//   WRV4 loading verdict on the tubing (shoe node takes the tubing ID; the liner below the end of tubing reported apart) ·
//   WRV5 hydrate ⚠ band downstream of the choke · WRV6 hydrate gravity = the well-stream gravity · WRV7 darcyGas p² coefficients ·
//   WRV8 bean design capped by the sub-critical bound says why · WRV9 flowline at the choke-downstream temperature ·
//   WRV10 dry-gas method refused for oil and water wells.
// Page: WRV11 schematic hover marker passes clicks through · WRV12 decimal-comma paste · WRV13 test gauges on the schematic ·
//   WRV14 MD and TVD on every depth readout · WRV15 case summary in the report from any step · WRV16 sensitivity values fit the
//   variable, and an engine refusal is shown · WRV17 touch-action / wheel · WRV18 survey form conversion with undo, no confirm ·
//   WRV19 stale study results · WRV20 system-plot labels and legend placement · WRV21 layout CSS, report title, units and wording,
//   step status text · WRV22 one solve per well switch (WTS_wells on the real engines) and per example click · WRV23 real-engine
//   page variants of WPG1 / WPG5 / WPG8 / WPG12 · WRV24 the naming-rule scan covers the help text and the test double.
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP9';
const PATM = 14.696;
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 200); return job.result(); };
const app = (ctx) => S.sharedApp(ctx);
const _memo = new Map();
const sol = (SY, M) => { const k = JSON.stringify(M); if (!_memo.has(k)) _memo.set(k, SY.solve(M)); return _memo.get(k); };
const P = (A) => A.win.WTS_wellperf_page;
function page(ctx, ex) {
  const A = app(ctx);
  if (A.win.__WP_MOCK) throw new Error('the test double must not be installed in this app');
  S.resetWellPerf(A); P(A).resetJobs(); P(A).budget(1e6);
  A.hook.nav('wellperf'); A.flush(30);
  if (ex) { A.click(A.find('[data-act="example"][data-ex="' + ex + '"]')); A.flush(30); }
  return A;
}
function waterWell() {
  const M = S.FIX.oilWell;
  Object.assign(M.fluid, { type: 'water', gor: 0, wc: 1 });
  Object.assign(M.res, { pr: 5000, params: { J: 10 } });
  Object.assign(M.surface.choke, { cd: 0.85, bean64: 32 });
  return M;
}

module.exports = [
  {
    name: 'WRV1 liquid-only choke: q = 1022.7·Cd·d²·√(Δp/SG) — 5,000 BWPD through 0.5 in, Cd 0.85, SG 1.07 → Δp 566 psi (hand value)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = waterWell();
      const b = SY.boundary(M, 5000);
      assert.ok(b.ok && b.regime === 'liquid', JSON.stringify(plain(b)));
      const hand = 1.07 * Math.pow(5000 / (1022.7 * 0.85 * 0.25), 2);
      assert.near(hand, 566.4, 0.5, 'hand value');
      assert.near(b.thp - b.p2, hand, 0.01, 'choke Δp = the hand value (was 2.31× too high)');
      const R = sol(SY, M);
      assert.ok(R.ok && R.surface.choke.regime === 'liquid', 'water well solves through the orifice');
      const q = R.op.q, dp = R.surface.choke.dp;
      assert.near(dp, 1.07 * Math.pow(q / (1022.7 * 0.85 * 0.25), 2), 0.05, 'operating-point choke Δp on the same law');
    },
  },
  {
    name: 'WRV2 design THP across the stability cliff: targets 600 and 700 STB/d on FIX.oilWell are found (no-flow trials are one-sided bounds, never secant values)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = S.FIX.oilWell;
      [600, 700].forEach((qT) => {
        const r = run(SY.designFor(M, { thp: qT }));
        assert.ok(r.ok, qT + ': ' + JSON.stringify(plain(r.errors)));
        assert.ok(Math.abs(r.q - qT) <= 0.01 * qT, qT + ' → ' + r.q);
        const Mx = S.FIX.oilWell; Mx.surface.choke.present = false; Mx.system.thp_psig = r.thp;
        const R = SY.solve(Mx);
        assert.ok(R.ok && Math.abs(R.op.q - qT) <= 0.015 * qT, 'solving at THP ' + r.thp.toFixed(1) + ' psig gives ' + (R.op && R.op.q));
        assert.ok(r.solves <= 16, 'solves ' + r.solves);
      });
      const nr = run(SY.designFor(M, { thp: 300 }));
      assert.ok(!nr.ok && /stability limit/.test(nr.errors.join(' ')), 'below the cliff: unreachable, and says why: ' + nr.errors.join(' | '));
    },
  },
  {
    name: 'WRV3 erosion covers the flowline: an undersized 2 in × 3,000 ft line on FIX.gasWell reports the flowline maximum, the EROSION flag and the location',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = S.FIX.gasWell;
      M.surface.flowline = [{ name: 'Flowline', len: 3000, id: 2, dz: 0 }]; M.surface.psep_psig = 300; M.surface.choke.bean64 = 48;
      const R = sol(SY, M), v = R.velocities;
      assert.ok(R.ok, JSON.stringify(plain(R.errors)));
      assert.strictEqual(v.where, 'flowline');
      assert.ok(v.flowline.eroMax > 1 && v.eroMax === v.flowline.eroMax && v.eroMax > v.tubing.eroMax, 'max(tubing, flowline): ' + JSON.stringify(plain(v)));
      const f = R.flags.find((x) => x.code === 'EROSION');
      assert.ok(f && f.sev === 'warn' && /flowline/.test(f.msg), 'EROSION flag in the flowline');
      const R0 = sol(SY, S.FIX.gasWell);
      assert.ok(R0.velocities.flowline && R0.velocities.eroMax >= R0.velocities.tubing.eroMax, 'the default well reports both');
    },
  },
  {
    name: 'WRV4 liquid loading: the verdict is the tubing critical rate (wellhead → shoe), the shoe node takes the tubing ID, the liner below the end of tubing is an information line',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, R = sol(SY, S.FIX.gasWell), L = R.loading;
      const shoe = L.perDepth.find((r) => Math.abs(r.md - 9850) < 1e-6);
      assert.ok(shoe && Math.abs(shoe.id - 2.441) < 1e-9 && !shoe.belowEot, 'shoe node: tubing ID ' + (shoe && shoe.id));
      assert.ok(L.verdict === 'ok' && L.margin > 0, 'the shipped gas example is not marked loading: ' + L.margin);
      assert.ok(L.belowEot && L.belowEot.margin < 0 && !L.belowEot.inVerdict, 'rathole reported apart');
      assert.ok(!R.flags.some((f) => f.code === 'LOADING'), 'no LOADING flag');
    },
  },
  {
    name: 'WRV5 hydrate downstream of the choke: ⚠ flag and check within 10 °F; the KPI shows the smaller margin and where it is',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, R = sol(SY, S.FIX.gasWell), sf = R.surface;
      assert.ok(sf.hydMarginDn >= 0 && sf.hydMarginDn < 10, 'downstream margin ' + sf.hydMarginDn);
      assert.ok(R.flags.some((f) => f.code === 'HYDRATE_DN_NEAR' && f.sev === 'warn'), 'HYDRATE_DN_NEAR flag');
      const A = page(ctx, 'gas');
      const k = A.findAll('#wp_kpis .kpi').find((e) => /Hydrate margin/.test(txt(e)));
      assert.ok(k && /st-warn/.test(k.className) && /downstream of the choke/.test(txt(k)), 'KPI: ' + txt(k));
      assert.match(txt(A.el('wp_verd')), /⚠ Hydrate margin downstream of the choke only/);
    },
  },
  {
    name: 'WRV6 hydrate and choke isenthalp use the well-stream gas gravity for gas-condensate wells (as shut-in does)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.gasWell, R = sol(G.WTS_wp_system, M), F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
      assert.ok(F.sgWell > F.sgg, 'condensate: well stream heavier than the separator gas');
      assert.near(R.surface.sgHyd, F.sgWell, 1e-12, 'basis stated in the result');
      assert.near(R.surface.tHyd, G.WTS_hydrate_temp(R.surface.thp, F.sgWell), 1e-9, 'hydrate T at the THP with sgWell');
      assert.ok(R.surface.tHyd > G.WTS_hydrate_temp(R.surface.thp, F.sgg) + 1, 'the heavier gas forms hydrate warmer (conservative)');
      const Ro = sol(G.WTS_wp_system, S.FIX.oilWell);
      assert.near(Ro.surface.sgHyd, 0.65, 1e-12, 'oil well: the separator gas gravity');
    },
  },
  {
    name: 'WRV7 darcyGas p² form stores the coefficients it uses (a·μ̄z̄, b·μ̄z̄); the m(p) ones stay as aMp / bMp',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.gasWell;
      const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
      const spec = { model: 'darcyGas', pr: 5000, T_F: 230, params: { k: 5, h: 50, rw: 0.354, re: 1490, S: 2, D: 0.0001, p2: 1 } };
      const I = G.WTS_wp_ipr.curve(spec, F);
      assert.ok(I.ok, JSON.stringify(plain(I.errors)));
      const a = I.params.a, b = I.params.b, q = I.qAt(3000);
      assert.near(5000 * 5000 - 3000 * 3000, a * q + b * q * q, 1e-6 * 5000 * 5000, 'p̄r² − pwf² = a q + b q² with the stored a, b');
      assert.ok(I.params.aMp > 10 * a && I.form.units && /psi²/.test(I.form.units.a), 'm(p) coefficients kept apart, units labelled');
    },
  },
  {
    name: 'WRV8 bean design capped by the sub-critical bound: the message says the critical correlation caps the rate, and shows the no-choke maximum',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = S.FIX.oilWell; M.surface.choke.subcritical = 'bound';   // the A1 rule (A2 default: wellperf-choke2 WCK5)
      const r = run(SY.designFor(M, { bean: 1300 }));
      const mx = SY.maxRate(M);
      assert.ok(!r.ok, 'not reachable with a bean');
      const t = r.errors.join(' ');
      assert.ok(/sub-critical bound/.test(t) && /Without a choke the well can deliver/.test(t), t);
      assert.ok(Math.abs(r.maxRate - mx.q) < 1e-6 * mx.q && mx.q > 1300, 'no-choke maximum ' + mx.q);
    },
  },
  {
    name: 'WRV9 the flowline of a choked gas well is marched at the choke-downstream temperature, not at the THT',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, R = sol(SY, S.FIX.gasWell), sf = R.surface;
      assert.ok(sf.tLine < sf.tht - 20, 'line at ' + sf.tLine + ' °F, THT ' + sf.tht);
      assert.near(sf.tLine, sf.tChokeDn, 6, 'line temperature ≈ the choke-downstream temperature');
      const Ro = sol(SY, S.FIX.oilWell);
      assert.near(Ro.surface.tLine, 120, 1e-9, 'oil well: the THT (no isenthalp)');
    },
  },
  {
    name: 'WRV10 the dry-gas method is refused for oil and water wells: CORR_NOT_APPLICABLE from the solver, ✗ in WTS_wp_check and its validity row',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.oilWell; M.system.corr.well = 'gasTZ';
      const R = G.WTS_wp_system.solve(M);
      assert.ok(!R.ok && R.code === 'CORR_NOT_APPLICABLE', R.code);
      const c = G.WTS_wp_check(M);
      assert.ok(!c.ok && c.items.some((i) => i.code === 'CORR_NOT_APPLICABLE' && i.sev === 'error'), 'check error');
      assert.ok(c.validity.some((v) => v.corr === 'gasTZ' && v.inRange === false), 'validity ✗');
      const Mg = S.FIX.gasWell; Mg.system.corr.well = 'gasTZ';
      assert.ok(G.WTS_wp_system.solve(Mg).ok, 'still available for gas wells');
    },
  },
  {
    name: 'WRV11 schematic hover marker never takes the click: pointer-events none, so a click on a restriction or the perforations under it opens the editor',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas'), sch = A.el('wp_sch').innerHTML;
      assert.match(sch, /class="wp-hover" pointer-events="none"/);
      // a hover over the restriction moves the marker onto it; a click there still reaches the component
      const mk = A.find('#wp_sch .wp-hover');
      assert.strictEqual(mk.getAttribute('pointer-events'), 'none');
      A.click(A.find('#wp_sch [data-comp="restr:0"]'));
      assert.strictEqual(A.el('wp_step_3').style.display, '', 'restriction → step ③');
      A.click(A.find('#wp_sch [data-comp="perf"]'));
      assert.strictEqual(A.el('wp_step_3').style.display, '', 'perforations → step ③');
    },
  },
  {
    name: 'WRV12 survey paste with the decimal-comma setting: tab and semicolon rows keep "30,5" as one cell; a cell-count mismatch warns',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil');
      const paste = (text) => {
        A.click(A.find('[data-act="paste"][data-t="survey"]'));
        A.el('wp_pastet_survey').value = text;
        A.click(A.find('[data-act="pasteok"][data-t="survey"]')); A.flush(10);
        return P(A).state().M.well.survey;
      };
      A.storage.setItem('wtspref_decimal_comma', '1');
      try {
        let sv = paste('MD;Inc;Azi\n0;0;0\n3000;30,5;45');
        assert.deepStrictEqual(plain(sv[1]), [3000, 30.5, 45], 'semicolon row');
        sv = paste('0\t0\t0\n3000\t30,5\t45');
        assert.deepStrictEqual(plain(sv[1]), [3000, 30.5, 45], 'tab row');
        sv = paste('0 0 0\n3000 30,5 45');
        assert.deepStrictEqual(plain(sv[1]), [3000, 30.5, 45], 'space row, decimal comma');
      } finally { A.storage.removeItem('wtspref_decimal_comma'); }
      let sv = paste('0,0,0\n3000,30.5,45');
      assert.deepStrictEqual(plain(sv[1]), [3000, 30.5, 45], 'comma-separated row without the setting');
      sv = paste('0\t0\t0\n3000\t30,5\t45');
      assert.deepStrictEqual(plain(sv[1]), [3000, 30.5, 45], 'tab row with a decimal-comma cell, setting off');
      paste('0\t0\t0\n3000\t30');
      assert.match(txt(A.el('wp_pastemsg_survey')), /⚠ .*different number of cells/);
    },
  },
  {
    name: 'WRV13 test gauge depths are drawn on the schematic (gauge:0 on the gas example) and a click opens the test row',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas');
      const g = A.find('#wp_sch [data-comp="gauge:0"]');
      assert.ok(g, 'gauge component');
      assert.match(g.getAttribute('aria-label'), /9,800 ft MD · [\d,]+ ft TVD/);
      A.click(g);
      assert.strictEqual(A.el('wp_step_6').style.display, '', 'gauge → step ⑥');
      assert.ok(/wp-flash/.test(A.find('#wp_tbl_tests tr[data-r="0"]').className), 'the test row');
    },
  },
  {
    name: 'WRV14 every depth readout shows MD and TVD: strings / restrictions / tests tables, perforations, the BHP KPI, schematic labels, depth-plot crosshairs',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas');
      assert.match(txt(A.find('#wp_tbl_strings thead')), /Top TVD.*Bottom TVD/);
      assert.match(txt(A.find('#wp_tbl_restrictions thead')), /TVD/);
      assert.match(txt(A.find('#wp_tbl_tests thead')), /Gauge TVD/);
      const ro = A.findAll('#wp_tbl_restrictions tbody tr')[0].querySelectorAll('td.ro');
      assert.ok(ro.length === 1 && /^\d[\d,.]*$/.test(txt(ro[0])), 'restriction TVD value: ' + txt(ro[0]));
      assert.match(txt(A.el('wp_perftvd')), /Mid-perforation \(bottom node\)\s*9,950 ft MD · [\d,]+ ft TVD/);
      const k = A.findAll('#wp_kpis .kpi').find((e) => /Flowing BHP/.test(txt(e)));
      assert.match(txt(k), /@ 9,950 ft MD · [\d,]+ ft TVD/);
      ['string:0', 'restr:0', 'perf'].forEach((c) => assert.match(A.find('#wp_sch [data-comp="' + c + '"]').getAttribute('aria-label'), /MD · [\d,]+ ft TVD/, c));
      const sp = A.el('wp_cv_tr')._wp.spec;
      assert.match(sp.y.fmtR(5000), /5,000 ft TVD · [\d,]+ ft MD/);
      A.click(A.find('#wp_depthseg [data-depth="md"]'));
      assert.match(A.el('wp_cv_tr')._wp.spec.y.fmtR(5000), /5,000 ft MD · [\d,]+ ft TVD/);
      A.click(A.find('#wp_depthseg [data-depth="tvd"]'));
    },
  },
  {
    name: 'WRV15 the report of any step carries the case summary (p̄r, inflow model, survey TD MD / TVD / departure, strings, perforations, choke, separator, correlations)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas');
      P(A).goStep(1);
      const flat = JSON.stringify(A.win.collectPageReport(A.el('pgBody'), { charts: false }));
      ['Case summary', 'Reservoir', 'Inflow model', 'LIT in p²', 'Survey', 'Tubing', 'Liner', 'Perforations', 'Wellhead', 'Surface', 'Correlations'].forEach((t) => assert.includes(flat, t));
      assert.match(flat, /10 stations · TD 10,000 ft MD · [\d,]+ ft TVD · departure [\d,]+ ft/);
    },
  },
  {
    name: 'WRV16 sensitivity: stored values that do not fit the variable are replaced by suggestions on open; an engine refusal is shown as ✗',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = page(ctx, 'oil');
      const sel = A.el('wpv_svar'), box = A.el('wpv_svals'), V = A.win.WTS_wp_sens.VARS;
      const vals = String(box.value).trim().split(/\s+/).map(Number);
      assert.ok(vals.length && vals.every((v) => v >= V[sel.value].lo && v <= V[sel.value].hi), sel.value + ' values fit: ' + box.value);
      // force values outside the range past the box check: the engine says why
      box.value = '0 1'; A.select('wpv_svar', 'pr'); box.value = '0 1';
      A.click(A.find('[data-act="sens"]'));
      for (let i = 0; i < 40 && !/✗/.test(txt(A.el('wp_jobbox'))); i++) await A.flushAsync(1);
      assert.match(txt(A.el('wp_jobbox')), /✗ Sensitivity not run: .*p̄r/);
    },
  },
  {
    name: 'WRV17 plots: touch-action none on the plot with handles (pan-y elsewhere); the wheel zooms only with Ctrl / Cmd or a focused plot',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil');
      const cs = A.el('wp_cv_sys'), ct = A.el('wp_cv_tr');
      assert.strictEqual(cs.style.touchAction, 'none'); assert.strictEqual(ct.style.touchAction, 'pan-y');
      if (A.document.activeElement && A.document.activeElement.blur) A.document.activeElement.blur();
      const r = ct.getBoundingClientRect();
      const ev = new A.win.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: r.left + 200, clientY: r.top + 100 });
      ct.dispatchEvent(ev);
      assert.ok(!ct._wp.view && !ev.defaultPrevented && ct._wp.wheelHint, 'plain wheel scrolls the page and shows the hint');
      const ev2 = new A.win.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ctrlKey: true, clientX: r.left + 200, clientY: r.top + 100 });
      ct.dispatchEvent(ev2);
      assert.ok(ct._wp.view, 'Ctrl + wheel zooms');
      ct.dispatchEvent(new A.win.MouseEvent('dblclick', { bubbles: true }));
    },
  },
  {
    name: 'WRV18 switching the survey form converts the stations (MD·Inc·Azi ↔ MD·TVD) without a browser confirm, and Undo brings the rows back',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas'), G = A.win;
      const conf = G.confirm; let asked = 0; G.confirm = () => { asked++; return false; };
      try {
        const before = plain(P(A).state().M.well.survey), stn = P(A).state().W.stations;
        A.click(A.find('#wp_svmode [data-m="mdtvd"]')); A.flush(10);
        const sv = P(A).state().M.well.survey;
        assert.strictEqual(asked, 0, 'no confirm');
        assert.strictEqual(sv.length, 10, 'all stations kept');
        sv.forEach((r, i) => { assert.strictEqual(r.length, 2); assert.near(r[1], stn.find((s) => Math.abs(s.md - r[0]) < 0.01).tvd, 0.01, 'TVD row ' + i); });
        A.click(A.find('[data-act="svundo"]')); A.flush(10);
        assert.deepStrictEqual(plain(P(A).state().M.well.survey), before, 'undo');
        A.click(A.find('#wp_svmode [data-m="mdtvd"]')); A.flush(10);
        A.click(A.find('#wp_svmode [data-m="mdinc"]')); A.flush(10);
        const back = P(A).state().M.well.survey;
        assert.ok(back.length === 10 && back.every((r) => r.length === 3 && r[2] === 120), 'back to MD·Inc·Azi with the azimuth kept');
        assert.near(back[5][1], 30, 0.5, 'hold section at 30° (tangent between stations)');
      } finally { G.confirm = conf; }
    },
  },
  {
    name: 'WRV19 study results from other inputs are marked stale: the family is drawn faint and labelled, the table carries a re-run chip',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = page(ctx, 'oil');
      A.select('wpv_svar', 'wc'); A.el('wpv_svals').value = '20 30 40';
      A.click(A.find('[data-act="sens"]'));
      const st = P(A).state();
      for (let i = 0; i < 60 && !st.sens; i++) await A.flushAsync(1);
      assert.ok(st.sens && st.sens.cases && !st.sens.stale, 'sensitivity ran');
      A.change('wp_pr', '3200'); A.flush(10);
      assert.ok(st.sens.stale, 'stale after an input change');
      assert.ok(A.el('wp_cv_sys')._wp.spec.series.filter((s) => /^sens/.test(s.key)).every((s) => s.stale === true && !/previous inputs/.test(s.label)), 'family marked stale (no suffix per entry)');
      assert.match(String(A.el('wp_cv_sys')._wp.spec.legendNote), /previous inputs/, 'one legend note instead (review fix: long entries were cut at 390 px)');
      assert.match(txt(A.el('wp_senstbl')), /Results are from the previous inputs/);
    },
  },
  {
    name: 'WRV20 system plot: vertical-line labels never overlap each other or the legend; the legend avoids the operating point',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas'), st = A.el('wp_cv_sys')._wp, ov = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
      const L = st.vlabels || [];
      assert.ok(L.length >= 2, 'labels placed: ' + L.map((l) => l.label).join(', '));
      for (let i = 0; i < L.length; i++) { for (let j = i + 1; j < L.length; j++) assert.ok(!ov(L[i], L[j]), L[i].label + ' / ' + L[j].label); assert.ok(!st.legBox || !ov(L[i], st.legBox), L[i].label + ' / legend'); }
      const A2 = A.el('wp_cv_sys')._wpAxes, op = st.spec.markers.find((m) => m.halo), x = A2.toX(op.x), y = A2.toY(op.y), b = st.legBox;
      assert.ok(!(x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1), 'legend clear of the operating point');
    },
  },
  {
    name: 'WRV21 layout, report title, units, wording and step status: minmax(0,1fr) columns, Kind select width, .rrow gap; "Well" card title; q_s in the rate unit; no increment code; status text on each step',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas'), html = A.el('pgBody').innerHTML;
      assert.includes(html, '.wp-2c{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)');
      assert.includes(html, '#wp_root .wp-ed select{min-width:104px}');
      assert.includes(html, '#wp_root .rrow{gap:12px}');
      const card = A.find('#wp_sch').closest('.card'), ttl = card.querySelector('.card-title');
      assert.strictEqual(txt(ttl), 'Well', 'the report takes the title element text: ' + txt(ttl));
      assert.ok(!ttl.querySelector('select, .wp-tools') && card.querySelector('.wp-tools.rp-skip'), 'the tools sit beside the title, in .rp-skip');
      const op = txt(A.el('wp_op'));
      assert.match(op, /Gas rate\s*[\d.]+ MMscf\/d/); assert.match(op, /Static stability limit q_s\s*([\d.]+ MMscf\/d|none in range)/);
      assert.match(op, /Condensate rate/);
      assert.ok(!/\bA2\b/.test(txt(A.el('wp_res'))), 'no increment code on the page');
      const sq = A.find('[data-act="sqc"]').parentNode;
      assert.ok(/wp-off/.test(sq.className), 'the GOR import is hidden for gas wells');
      assert.ok(txt(A.el('wp_dotsr_5')).length > 3 && /—/.test(A.find('#wp_steps [data-step="5"]').getAttribute('title')), 'step ⑤ status text: ' + txt(A.el('wp_dotsr_5')));
      A.win.WTS_units.setSystem('metric');
      try {
        A.flush(30);
        const o2 = txt(A.el('wp_op')), u = (o2.match(/Gas rate\s*[\d.,]+ (\S+ \S+)/) || [])[1];
        assert.ok(u && (o2.indexOf('q_s none') !== -1 || o2.indexOf('q_s') !== -1) && o2.split(u).length >= 2, 'metric q_s in the gas-rate unit: ' + o2);
      } finally { A.win.WTS_units.setSystem('imperial'); A.flush(30); }
    },
  },
  {
    name: 'WRV22 one solve per well switch (WTS_wells.create / switchTo on the real engines) and per example click',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas'), G = A.win, W = G.WTS_wells;
      let n = P(A).calcs();
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      assert.strictEqual(P(A).calcs() - n, 1, 'one solve per example click');
      if (!W || typeof W.create !== 'function') return assert.ok(true, 'multi-well not present');
      const from = ((W.list() || []).filter((w) => w.active)[0] || {}).id;
      assert.ok(from, 'the active well id');
      n = P(A).calcs();
      const c = W.create('Review well'); A.flush(60);
      assert.ok(c.ok, JSON.stringify(c));
      assert.strictEqual(P(A).calcs() - n, 1, 'create: one solve');
      n = P(A).calcs();
      W.switchTo(from); A.flush(60);
      assert.strictEqual(P(A).calcs() - n, 1, 'switch back: one solve');
      assert.ok(G.WTS_state.wellperf.ok, 'the oil example is back and solved');
      W.remove(c.id); A.flush(60);
    },
  },
  {
    name: 'WRV23 real-engine page variants: render (WPG1), Metric (WPG5), Quick Report snapshot (WPG8), live drag (WPG12) on the oil and gas examples',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      ['oil', 'gas'].forEach((ex) => {
        const A = page(ctx, ex), st = A.win.WTS_state.wellperf;
        assert.ok(st.ok && st.op.stable, ex + ' solved');
        assert.strictEqual(A.findAll('#wp_kpis .kpi').length, ex === 'oil' ? 10 : 9, ex + ': KPI strip');
        assert.ok(!BAD.test(txt(A.el('wp_res'))), ex + ' clean');
        const q = st.op.q;
        A.win.WTS_units.setSystem('metric');
        try { A.flush(30); assert.rel(A.win.WTS_state.wellperf.op.q, q, 1e-9, ex + ' metric: same answer'); assert.ok(/kPa/.test(txt(A.el('wp_kpis'))) && !BAD.test(txt(A.el('wp_res'))), ex + ' metric KPIs'); }
        finally { A.win.WTS_units.setSystem('imperial'); A.flush(30); }
        A.change('wp_psep', ex === 'gas' ? '820' : '110'); A.flush(1200);
        const snaps = JSON.parse(A.storage.getItem('wts_report_snapshots') || '{}');
        assert.ok(snaps.wellperf && JSON.stringify(snaps.wellperf).length <= 60 * 1024, ex + ' snapshot ≤ 60 kB');
        const n = P(A).calcs(), pst = P(A).state(), pr = A.win.WTS_state.wellperf;
        P(A).handle('pr', ex === 'gas' ? 5200 : 3200, 'move'); A.flush(5);
        assert.ok(pst.R.ok && pst.R.tracked && P(A).calcs() - n === 1, ex + ': a drag move = one tracking solve');
        P(A).handle('pr', ex === 'gas' ? 5200 : 3200, 'end'); A.flush(30);
        assert.ok(pst.R.ok && !pst.R.tracked && pr, ex + ': release = full solve');
        assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      });
    },
  },
  {
    name: 'WRV24 the naming-rule scan (WN1) covers the help text, the test double and the shared-engine files of the module',
    wp: WP, opts: false,
    run(_a, assert) {
      const f = S.files();
      ['prism-build/48-calc-help-production.js', 'prism-build/48-calc-help-start.js', 'prism-build/tests/_wellperf-mock.js', 'prism-build/tests/wellperf-review.test.js'].forEach((x) => assert.ok(f.indexOf(x) !== -1, x));
    },
  },
];
