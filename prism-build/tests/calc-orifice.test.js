// Roadmap #6 — pure AGA-3 compute (window.WTS_aga3_compute, host) and the
// Orifice Plate Selection plug-in calculator (route `orifice`, file
// prism-build/45-calc-orifice.js, Round-9 registry).
//
//   • Parity: WTS_aga3_compute returns exactly the numbers calcAGA3 renders
//     (it IS the calcAGA3 engine now), over several cases incl. sour gas,
//     non-60 °F base, pipe taps and β outside the RG range.
//   • Hand checks: the selected bore's differential at the target rate is inside
//     20–80 % of range, and the rate through that bore at that differential,
//     recomputed with an independent AGA-3 RG + DAK mass-flow reference (same as
//     calc-g1), equals the target. Plate-change points are the forward rates at
//     20 % / 80 % of range.
//   • Metric parity, registry contract, report/persistence.
'use strict';

const WP = 'ORF';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label) {
  const r = rows(app, resId).find((x) => x.l.indexOf(label) !== -1);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId)));
  const m = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
  if (!m) throw new Error('row "' + label + '" has no number: ' + r.v);
  return parseFloat(m[0]);
}
function txt(app, id) { const e = app.el(id); return String(e ? e.textContent : '').trim(); }
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|∞|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    const e = app.el(k);
    if (!e) throw new Error('no input #' + k);
    if (String(e.tagName).toUpperCase() === 'SELECT') app.select(k, String(vals[k])); else app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="orifice"]');
  if (!b) throw new Error('no orifice nav button');
  app.click(b);
  if (!app.el('op_root')) throw new Error('orifice page did not render');
}
const calc = (app) => app.click('op_calc');
const S = (app) => app.win.WTS_state.orifice;

// Independent AGA-3 RG flange-tap + DAK reference in SI mass-flow form (copy of calc-g1 agaRef).
function dakZ(Tpr, Ppr) {
  const A = [0, 0.3265, -1.07, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210];
  const Zof = (r) => 1 + (A[1] + A[2] / Tpr + A[3] / Tpr ** 3 + A[4] / Tpr ** 4 + A[5] / Tpr ** 5) * r
    + (A[6] + A[7] / Tpr + A[8] / Tpr ** 2) * r * r - A[9] * (A[7] / Tpr + A[8] / Tpr ** 2) * r ** 5
    + A[10] * (1 + A[11] * r * r) * (r * r / Tpr ** 3) * Math.exp(-A[11] * r * r);
  let lo = 1e-9, hi = 3;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (Zof(m) - 0.27 * Ppr / (m * Tpr) > 0) hi = m; else lo = m; }
  return 0.27 * Ppr / (((lo + hi) / 2) * Tpr);
}
function agaRef(o) {
  const { D, d, hw, Ps, TfF, SG, co2 = 0, h2s = 0, TbF = 60, Pb = 14.696, mu = 0.012 } = o;
  const beta = d / D, b4 = beta ** 4, Ev = 1 / Math.sqrt(1 - b4);
  const Pf = Ps + 14.696, Tf = TfF + 459.67, Tb = TbF + 459.67;
  const Tpc = 168 + 325 * SG - 12.5 * SG * SG, Ppc = 677 + 15 * SG - 37.5 * SG * SG;
  const A = (co2 + h2s) / 100, B = h2s / 100, eps = 120 * (A ** 0.9 - A ** 1.6) + 15 * (B ** 0.5 - B ** 4);
  const Tpc2 = Tpc - eps, Ppc2 = Ppc * Tpc2 / (Tpc + B * (1 - B) * eps);
  const Z = dakZ(Tf / Tpc2, Pf / Ppc2);
  const Y = 1 - (0.41 + 0.35 * b4) * hw / (27.707 * Pf) / 1.3;
  const dm = d * 0.0254, Dm = D * 0.0254, dP = hw * 248.84, M = 28.9625e-3 * SG, R = 8.314462;
  const rho = Pf * 6894.757 * M / (Z * R * Tf * 5 / 9), rhob = Pb * 6894.757 * M / (R * Tb * 5 / 9);
  const L = 1 / D, M2 = 2 * L / (1 - beta), M1 = Math.max(2.8 - D, 0);
  let Re = 1e6, Cd = 0.6, qm = 0;
  for (let i = 0; i < 60; i++) {
    const Aa = (19000 * beta / Re) ** 0.8, C = (1e6 / Re) ** 0.35;
    Cd = 0.5961 + 0.0291 * beta ** 2 - 0.2290 * beta ** 8 + 0.003 * (1 - beta) * M1
      + (0.0433 + 0.0712 * Math.exp(-8.5 * L) - 0.1145 * Math.exp(-6 * L)) * (1 - 0.23 * Aa) * b4 / (1 - b4)
      - 0.0116 * (M2 - 0.52 * M2 ** 1.3) * beta ** 1.1 * (1 - 0.14 * Aa)
      + 0.000511 * (1e6 * beta / Re) ** 0.7 + (0.0210 + 0.0049 * Aa) * b4 * C;
    qm = Cd * Ev * Y * Math.PI / 4 * dm * dm * Math.sqrt(2 * rho * dP);
    Re = 4 * qm / (Math.PI * mu * 1e-3 * Dm);
  }
  return { Z, Cd, Qv: qm / rhob / 0.0283168466 * 3600 };
}

const AGA_CASES = [
  { a_pD: 4.026, a_oD: 2.0, a_tap: 'flange', a_dP: 50, a_Ps: 500, a_Tf: 80, a_SG: 0.65, a_CO2: 0.5, a_H2S: 0, a_Tb: 60, a_Pb: 14.696 },
  { a_pD: 8.071, a_oD: 4, a_tap: 'flange', a_dP: 150, a_Ps: 1500, a_Tf: 70, a_SG: 0.7, a_CO2: 2, a_H2S: 1, a_Tb: 60, a_Pb: 14.696 },
  { a_pD: 6.065, a_oD: 3, a_tap: 'flange', a_dP: 80, a_Ps: 800, a_Tf: 100, a_SG: 0.75, a_CO2: 1, a_H2S: 0, a_Tb: 100, a_Pb: 14.73 },
  { a_pD: 3.068, a_oD: 2.5, a_tap: 'pipe', a_dP: 220, a_Ps: 60, a_Tf: 40, a_SG: 0.9, a_CO2: 5, a_H2S: 3, a_Tb: 59, a_Pb: 14.65 },
  { a_pD: 2.067, a_oD: 0.25, a_tap: 'flange', a_dP: 10, a_Ps: 2500, a_Tf: 180, a_SG: 0.58, a_CO2: 0, a_H2S: 0, a_Tb: 32, a_Pb: 14.696 },
];
const toCompute = (c) => ({ D: c.a_pD, d: c.a_oD, hw: c.a_dP, Ps: c.a_Ps, TfF: c.a_Tf, SG: c.a_SG, co2: c.a_CO2, h2s: c.a_H2S, TbF: c.a_Tb, Pb: c.a_Pb, tap: c.a_tap });
const DEF = { q: 5000, D: 4.026, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5, n2: 1, h2s: 0, urv: 200 };

module.exports = [
  {
    name: 'ORF aga3 compute: WTS_aga3_compute is the calcAGA3 engine — identical numbers over 5 cases (sour, base T, pipe taps, β limits)',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      assert.strictEqual(typeof W.WTS_aga3_compute, 'function', 'WTS_aga3_compute');
      app.hook.nav('aga3');
      AGA_CASES.forEach((c, i) => {
        set(app, c);
        W.calcAGA3();
        const last = W._agaLast, r = W.WTS_aga3_compute(toCompute(c));
        assert.ok(r.ok, 'case ' + i + ' ok');
        ['Qv', 'Qmscfd', 'Qmmscfd', 'Cd', 'Ev', 'Y1', 'Z', 'Tpr', 'Ppr', 'rho_f', 'beta'].forEach((k) =>
          assert.strictEqual(last[k], r[k], 'case ' + i + ' ' + k + ' identical'));
        assert.strictEqual(r.zSource, 'dak');
        assert.near(rv(app, 'a_res', 'Gas Rate (SCF/hr)'), r.Qv, 0.051, 'case ' + i + ' page row (1 dp)');
        const ref = agaRef(toCompute(c));
        assert.rel(r.Qv, ref.Qv, 1e-3, 'case ' + i + ' vs independent mass-flow reference');
        const notes = String(app.el('a_notes') ? app.el('a_notes').textContent : '');
        r.notes.forEach((n) => assert.includes(notes, n.slice(0, 30), 'case ' + i + ' note on page'));
      });
      // note set: pipe taps + β 0.815 (case 3), β 0.121 ok, D ≥ 2
      assert.strictEqual(W.WTS_aga3_compute(toCompute(AGA_CASES[3])).notes.length, 2, 'pipe-tap + β notes');
      // Z override is honoured and flows through Fpv = 1/√Z
      const base = W.WTS_aga3_compute(toCompute(AGA_CASES[0]));
      const zo = W.WTS_aga3_compute(Object.assign(toCompute(AGA_CASES[0]), { Z: base.Z }));
      assert.strictEqual(zo.zSource, 'input');
      assert.strictEqual(zo.Qv, base.Qv, 'same Z → same rate');
      const z2 = W.WTS_aga3_compute(Object.assign(toCompute(AGA_CASES[0]), { Z: base.Z * 1.02 }));
      assert.rel(z2.Qv / base.Qv, 1 / Math.sqrt(1.02), 2e-4, 'Fpv = 1/√Z');
      // hw = 0 → zero flow, no NaN
      const z0 = W.WTS_aga3_compute(Object.assign(toCompute(AGA_CASES[0]), { hw: 0 }));
      assert.ok(z0.ok && z0.Qv === 0, 'hw 0 → 0');
      // validation returns errors, never NaN
      [{ d: 5 }, { D: 0 }, { hw: -1 }, { TfF: -500 }, { SG: 0 }, { Pb: 0 }, { co2: 80, h2s: 30 }].forEach((p, i) => {
        const r = W.WTS_aga3_compute(Object.assign(toCompute(AGA_CASES[0]), p));
        assert.strictEqual(r.ok, false, 'bad ' + i); assert.ok(r.errors.length > 0, 'bad ' + i + ' errors');
      });
      assert.includes(W.WTS_aga3_compute(Object.assign(toCompute(AGA_CASES[0]), { d: 5 })).errors[0], 'Orifice diameter must be smaller');
    },
  },
  {
    name: 'ORF select: chosen plate DP inside 20–80 % at target; independent reference rate = target; change points; β limits; neighbours',
    wp: WP,
    run(app, assert) {
      const W = app.win, A = W.WTS_aga3_compute;
      const cases = [
        [DEF, 1.875],
        [Object.assign({}, DEF, { mode: 'eighth' }), 1.875],
        [{ q: 40000, D: 12, Ps: 1200, TfF: 100, SG: 0.7, co2: 2, h2s: 1, urv: 400 }, 3.5],
        [{ q: 800, D: 2.067, Ps: 150, TfF: 60, SG: 0.8, urv: 100, lo: 25, hi: 75, des: 60 }, null],
        [{ q: 15000, D: 6.065, Ps: 1000, TfF: 120, SG: 0.62, urv: 250, TbF: 59, Pb: 14.73, mode: 'eighth' }, null],
      ];
      cases.forEach(([inp, expD], i) => {
        const r = W.WTS_orifice_compute(inp);
        assert.ok(r.ok && r.inWindow, 'case ' + i + ' ok & in window: ' + JSON.stringify(r.errors || r.verdicts));
        const c = r.chosen, lo = inp.lo || 20, hi = inp.hi || 80;
        if (expD != null) assert.near(c.d, expD, 1e-9, 'case ' + i + ' bore');
        assert.ok(c.pct >= lo && c.pct <= hi, 'case ' + i + ' DP ' + c.pct.toFixed(1) + ' % in window');
        assert.ok(c.beta >= 0.1 && c.beta <= 0.75, 'case ' + i + ' β in RG range');
        assert.near(c.hw, c.pct / 100 * inp.urv, 1e-9, 'pct = hw/urv');
        const g = { D: inp.D, d: c.d, Ps: inp.Ps, TfF: inp.TfF, SG: inp.SG, co2: inp.co2 || 0, h2s: inp.h2s || 0, TbF: inp.TbF, Pb: inp.Pb };
        // hand check: independent reference at the chosen DP returns the target rate
        const ref = agaRef(Object.assign({}, g, { hw: c.hw, TbF: inp.TbF == null ? 60 : inp.TbF, Pb: inp.Pb == null ? 14.696 : inp.Pb }));
        assert.rel(ref.Qv * 24 / 1000, inp.q, 1e-3, 'case ' + i + ' reference rate at chosen DP = target');
        assert.rel(A(Object.assign({}, g, { hw: c.hw })).Qmscfd, inp.q, 1e-8, 'case ' + i + ' engine rate at chosen DP');
        // plate-change points = forward rates at lo / hi % of range
        assert.rel(c.qLo, A(Object.assign({}, g, { hw: inp.urv * lo / 100 })).Qmscfd, 1e-12, 'qLo');
        assert.rel(c.qHi, A(Object.assign({}, g, { hw: inp.urv * hi / 100 })).Qmscfd, 1e-12, 'qHi');
        assert.ok(c.qLo < inp.q && inp.q < c.qHi, 'target between change points');
        // exact bore reproduces the target at the design DP
        const des = inp.des || 50;
        assert.rel(A(Object.assign({}, g, { d: r.dStar, hw: inp.urv * des / 100 })).Qmscfd, inp.q, 1e-8, 'd* at design DP');
        if (inp.mode === 'eighth') {
          assert.near(c.d / 0.125, Math.round(c.d / 0.125), 1e-9, '1/8" multiple');
          assert.near(c.d, Math.round(r.dStar / 0.125) * 0.125, 1e-9, 'rounded exact bore');
        }
        // neighbours: next up = larger bore, lower DP; next down = smaller bore, higher DP
        if (r.up) { assert.ok(r.up.d > c.d && r.up.pct < c.pct, 'up'); assert.ok(r.up.beta <= 0.75 + 1e-9, 'up β'); }
        if (r.down) { assert.ok(r.down.d < c.d && r.down.pct > c.pct, 'down'); assert.ok(r.down.beta >= 0.1 - 1e-9, 'down β'); }
        assert.ok(r.up || r.down, 'at least one neighbour');
      });
      // out of range: too much gas for the run → ✗ with the largest β plate; too little → ✗ smallest
      const hiQ = W.WTS_orifice_compute(Object.assign({}, DEF, { q: 60000 }));
      assert.ok(hiQ.ok && !hiQ.inWindow && hiQ.dStarFlag === 'high', 'too high');
      assert.ok(hiQ.chosen.beta <= 0.75 && !hiQ.up, 'largest plate');
      assert.ok(hiQ.verdicts.some((v) => v.level === 'bad' && /larger meter run/.test(v.text)), '✗ verdict high');
      const loQ = W.WTS_orifice_compute(Object.assign({}, DEF, { q: 20 }));
      assert.ok(loQ.ok && !loQ.inWindow && loQ.dStarFlag === 'low' && !loQ.down, 'too low');
      assert.ok(loQ.verdicts.some((v) => v.level === 'bad' && /smaller meter run/.test(v.text)), '✗ verdict low');
      // validation
      [{ q: 0 }, { D: 0 }, { urv: 0 }, { lo: 60, hi: 40 }, { des: 90 }, { SG: 0.3 }, { co2: 60, n2: 50 }].forEach((p, i) => {
        const r = W.WTS_orifice_compute(Object.assign({}, DEF, p));
        assert.strictEqual(r.ok, false, 'bad ' + i); assert.ok(r.errors.length > 0 && r.errorIds.length === r.errors.length, 'bad ' + i + ' errors');
      });
    },
  },
  {
    name: 'ORF page: registry entry and sidebar button in Well Testing; defaults select 1 7/8" with ✓, table, chart, next up/down',
    wp: WP,
    run(app, assert) {
      const W = app.win, e = W.WTS_calcRegistry && W.WTS_calcRegistry.orifice;
      assert.ok(e, 'registry entry');
      assert.strictEqual(e.key, 'orifice');
      assert.ok(/^[a-z][a-z0-9_]{1,31}$/.test(e.key), 'key pattern');
      assert.strictEqual(e.group, 'Well Testing');
      ['title', 'sub', 'icon'].forEach((k) => assert.ok(typeof e[k] === 'string' && e[k].length > 0, k));
      assert.strictEqual(typeof e.render, 'function');
      ['renderOrificeSelect', 'calcOrificeSelect', 'WTS_orifice_compute'].forEach((f) => assert.strictEqual(typeof W[f], 'function', f));
      const b = app.find('.nav-btn[data-p="orifice"]');
      assert.ok(b, 'sidebar button');
      assert.strictEqual(String(b.closest('.nav-group').querySelector('.nav-group-label').textContent).trim(), 'Well Testing');
      open(app);
      assert.strictEqual(txt(app, 'pgTitle'), 'Orifice Plate Selection');
      assert.near(S(app).d, 1.875, 1e-9, 'default plate');
      assert.ok(S(app).inWindow, 'in window');
      assert.near(rv(app, 'op_res', 'Differential at target rate'), S(app).hw, 0.06, 'DP row');
      assert.near(rv(app, 'op_res', 'Beta ratio'), 1.875 / 4.026, 1e-4, 'β row');
      const t = txt(app, 'op_res');
      assert.includes(t, '✓ 1.875 in (1 7/8") plate');
      assert.includes(t, 'Next plate up');
      assert.ok(app.findAll('#op_res table.dtable tbody tr').length >= 3, 'plate-change table rows');
      assert.ok(app.el('op_chart'), 'chart canvas');
      assert.near(S(app).up.d, 2, 1e-9, 'next up 2"'); assert.near(S(app).down.d, 1.75, 1e-9, 'next down 1 3/4"');
      noBadNumbers(assert, app, 'defaults');
      // validation through the DOM
      set(app, { op_q: 0 }); calc(app);
      assert.includes(errText(app, 'op_res'), 'Target gas rate must be greater than zero');
      assert.ok(app.el('op_q').classList.contains('input-err'), 'op_q flagged');
      set(app, { op_q: 60000 }); calc(app);
      assert.includes(txt(app, 'op_res'), '✗ No plate with β ≤ 0.75');
      assert.strictEqual(app.findAll('#op_root .input-err').length, 0, 'flags cleared');
      noBadNumbers(assert, app, 'out of range');
      // mode switch (select change event recalculates)
      set(app, { op_q: 5000, op_mode: 'eighth' }); calc(app);
      assert.strictEqual(S(app).mode, 'eighth');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('Orifice Plate Selection') !== -1, 'dashboard tile');
    },
  },
  {
    name: 'ORF metric: tagged inputs (m³/d, mm, kPa(g), °C, mbar) give the same plate and DP as imperial; unit flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { op_q: 15000, op_D: 6.065, op_P: 1000, op_T: 120, op_SG: 0.62, op_urv: 250 }); calc(app);
      const imp = JSON.parse(JSON.stringify(S(app)));
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('op_urv'), /mbar/, 'urv label'); assert.match(lab('op_D'), /mm/, 'D label');
        assert.match(lab('op_q'), /m³\/d/, 'q label');
        set(app, { op_q: 15000 * 28.3168, op_D: 6.065 * 25.4, op_P: 1000 * 6.89476, op_T: (120 - 32) * 5 / 9, op_SG: 0.62,
          op_urv: 250 * 2.48845, op_Tb: (60 - 32) * 5 / 9, op_Pb: 14.696 * 6.89476 });
        calc(app);
        assert.near(S(app).d, imp.d, 1e-9, 'same plate');
        ['hw', 'pct', 'qLo', 'qHi', 'dStar'].forEach((k) => assert.rel(S(app)[k], imp[k], 1e-6, 'metric ' + k));
        assert.includes(txt(app, 'op_res'), 'mbar', 'DP shown in mbar');
        assert.includes(txt(app, 'op_res'), 'm³/d', 'rate shown in m³/d');
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).hw, imp.hw, 1e-6, 'recalc after flip keeps the physical value');
      assert.includes(txt(app, 'op_res'), 'inH2O');
    },
  },
  {
    name: 'ORF report + persistence: report sections, verdict, notes, autosave restore after reload, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { op_q: 40000, op_D: 12, op_P: 1200, op_T: 100, op_SG: 0.7, op_CO2: 2, op_H2S: 1, op_urv: 400 }); calc(app);
      assert.near(S(app).d, 3.5, 1e-9);
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const s = JSON.stringify(model);
      assert.ok(model.inputs.length >= 4, 'input sections: ' + model.inputs.map((x) => x.title).join(' | '));
      const rt = model.results.map((x) => x.title);
      // (the DOM stub has no table.rows, so the Plate-Change Points table is checked in the DOM, not the report)
      ['Selected Plate', 'Exact Bore & Neighbours'].forEach((t) => assert.ok(rt.indexOf(t) !== -1, 'results section ' + t + ': ' + rt.join(' | ')));
      ['Target gas rate', 'Transmitter range', '3 1/2', 'Notes'].forEach((n) => assert.includes(s, n));
      assert.ok(/✓ 3.5 in/.test(s), 'verdict captured');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_orifice') || 'null');
      assert.ok(rec && rec.f && rec.f.op_q === '40000' && rec.f.op_D === '12', 'autosaved: ' + JSON.stringify(rec));
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('op_q').value, '40000', 'restored');
        assert.near(app2.win.WTS_state.orifice.d, 3.5, 1e-9, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers after reload');
      } finally { app2.dispose(); }
    },
  },
];
