// Roadmap calculator #16 — Gas Lift Quick Design (route `gaslift`, prism-build/49-calc-gaslift.js).
//
// Expected values are independent of the module:
//   • Injection gas column: RK4 integration of dp/dh = 0.018743·γ·p/(Z(p,T)·T) with the local Z
//     (DAK from the PVT library, Sutton pseudo-criticals typed here) and T linear with depth,
//     against the page's average-Z closed form.
//   • Static gas gradient check: Brown (1980) Vol. 2a gas-column chart, 0.65 gravity at 1,000 psig:
//     about 23–26 psi per 1,000 ft.
//   • Nitrogen dome correction: Winkler approximation Ct = 1/(1 + 0.00215(T − 60)) (Brown; RP 11V2)
//     and the ideal-gas limit 519.67/(T + 459.67).
//   • Straight-line PI, injection GLR and the IPO force balance typed here.
//   • Valve depths solved again here by bisection on the RK4 casing pressure and the RP 11V6 lines.
//   • POI and minimum GLR re-checked with the Flowline engine's traverse (independently tested in
//     calc-flowline.test.js against Brill & Mukherjee Example 4.7).
'use strict';

const WP = 'GASLIFT';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label, nth) {
  const r = rows(app, resId).find((x) => x.l === label);
  if (!r) throw new Error('no result row "' + label + '": ' + JSON.stringify(rows(app, resId).map((x) => x.l)));
  const nums = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (!nums || nums[nth || 0] == null) throw new Error('row "' + label + '" has no number: ' + r.v);
  return parseFloat(nums[nth || 0]);
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="gaslift"]');
  if (!b) throw new Error('no gaslift nav button');
  app.click(b);
  if (!app.el('gl_root')) throw new Error('gaslift page did not render');
}
function noBad(assert, app, where) {
  assert.ok(!/NaN|Infinity|undefined/.test(String(app.el('pgBody').textContent || '')), where + ': NaN/Infinity/undefined on page');
}
const S = (app) => app.win.WTS_state.gaslift;

const BASE = { qo: 800, qw: 400, gor: 300, api: 35, sgg: 0.7, sgw: 1.07, sginj: 0.65, pr: 3000, pi: 2, dperf: 8000, dmax: 7700,
  tub: 'tubing-2.875-6.5', rough: 0.0018, pwh: 120, twh: 110, bht: 190, pko: 1100, pso: 1000, glr: 800, dpv: 100, dpdrop: 25,
  gs: 0.465, ftub: 20, minsp: 250, R: 0.067 };

// RK4 gas column with local Z and linear T (independent of the page's average-Z method).
function gasColumn(L, ps, D, sg, tTop, tBot) {
  if (D <= 0) return ps;
  const Tpc = 169.2 + 349.5 * sg - 74.0 * sg * sg, Ppc = 756.8 - 131.0 * sg - 3.6 * sg * sg;   // Sutton (1985)
  const f = (h, p) => {
    const T = tTop + (tBot - tTop) * h / D + 459.67;
    const z = L.Z_dranchukAbouKassem(T / Tpc, p / Ppc);
    return 28.9647 * sg * p / (z * 10.7316 * T) / 144;
  };
  const n = 400, dh = D / n;
  let p = ps + 14.696;
  for (let k = 0; k < n; k++) {
    const h = k * dh;
    const k1 = f(h, p), k2 = f(h + dh / 2, p + dh * k1 / 2), k3 = f(h + dh / 2, p + dh * k2 / 2), k4 = f(h + dh, p + dh * k3);
    p += dh * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
  }
  return p - 14.696;
}
function bisect(f, a, b) {
  let fa = f(a);
  for (let k = 0; k < 80; k++) { const m = (a + b) / 2, fm = f(m); if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m; }
  return (a + b) / 2;
}

module.exports = [
  {
    name: 'GASLIFT injection gas column vs RK4 local-Z integration; Brown gas gradient; nitrogen Ct vs Winkler',
    wp: WP,
    run(app, assert) {
      const W = app.win, L = W.PRiSM_pvt_correlations;
      ['WTS_gaslift_compute', 'WTS_gaslift_casingP', 'WTS_gaslift_ct', 'calcGasLift', 'renderGasLift', 'WTS_flowline_march']
        .forEach((f) => assert.strictEqual(typeof W[f], 'function', f));
      [[1000, 8000, 0.65, 110, 190], [1500, 10000, 0.8, 80, 250], [500, 3000, 0.6, 60, 90]].forEach((c) => {
        const ref = gasColumn(L, ...c), got = W.WTS_gaslift_casingP(...c).p;
        assert.rel(got - c[0], ref - c[0], 0.01, 'gas column increase ' + JSON.stringify(c) + ': ' + got + ' vs RK4 ' + ref);
      });
      // Near-surface gradient = ρ/144 with ρ = pM/(ZRT) at 1,014.7 psia and 75 °F (Sutton + DAK typed here)
      const g = (W.WTS_gaslift_casingP(1000, 100, 0.65, 74.5, 75.5).p - 1000) / 100;
      const Tpc = 169.2 + 349.5 * 0.65 - 74 * 0.65 * 0.65, Ppc = 756.8 - 131 * 0.65 - 3.6 * 0.65 * 0.65;
      const Zs = L.Z_dranchukAbouKassem(534.67 / Tpc, 1016 / Ppc);
      assert.rel(g, 1016 * 28.9647 * 0.65 / (Zs * 10.7316 * 534.67) / 144, 5e-3, 'gas gradient ' + g + ' psi/ft');
      assert.ok(g > 0.025 && g < 0.029, '≈ 27 psi per 1,000 ft for 0.65 gas at 1,000 psig and 75 °F');
      // Winkler's linear fit holds to ≈ 1 % up to about 1,200 psi dome pressure; above it the real-gas value is lower.
      [[800, 120, 0.012], [1000, 160, 0.012], [1500, 200, 0.02]].forEach(([pd, t, tol]) => {
        const c = W.WTS_gaslift_ct(pd, t);
        assert.rel(c.ct, 1 / (1 + 0.00215 * (t - 60)), tol, 'Ct vs Winkler at ' + pd + ' psia, ' + t + ' °F: ' + c.ct);
        assert.ok(c.ct < 1 && c.ct > 0.95 * 519.67 / (t + 459.67), 'Ct near the ideal-gas limit');
      });
    },
  },
  {
    name: 'GASLIFT design: gas requirement, POI, valve spacing and IPO settings against hand calculations',
    wp: WP,
    run(app, assert) {
      const W = app.win, L = W.PRiSM_pvt_correlations;
      const r = W.WTS_gaslift_compute(BASE);
      assert.ok(r.ok, JSON.stringify(r.errors));
      const qL = 1200, glrF = 800 * 300 / 1200;
      assert.rel(r.pwf, 3000 - qL / 2, 1e-12, 'p_wf = p_r − q/J');
      assert.rel(r.glrF, glrF, 1e-12, 'formation GLR 200');
      assert.rel(r.qinj, (800 - glrF) * qL / 1e6, 1e-12, 'injection 0.72 MMSCFD');
      assert.rel(r.pts, 120 + 0.2 * (1000 - 120), 1e-12, 'design tubing at surface 296 psig');
      const tAt = (D) => 110 + 80 * D / 8000;
      // POI: casing (operating valve's surface pressure) − 100 psi = formation-GLR traverse
      const below = W.WTS_flowline_march([{ len: 8000, id: 2.441, dz: 8000 }], { qo: 800, qw: 400, qg: 0.24, api: 35, sgg: 0.7, sgw: 1.07 },
        r.pwf, 190, 110, { rough: 0.0018, payne: true, accel: false });
      const bp = below.profile.map((q) => ({ d: 8000 - q.x, p: q.p })).reverse();
      const pB = (D) => { for (let k = 1; k < bp.length; k++) if (bp[k].d >= D) { const a = bp[k - 1], b = bp[k]; return a.p + (b.p - a.p) * (D - a.d) / (b.d - a.d); } return bp[bp.length - 1].p; };
      assert.strictEqual(r.psoOp, 1000 - (r.valves.length - 1) * 25, 'operating valve surface pressure');
      const pcPoi = gasColumn(L, r.psoOp, r.poi, 0.65, 110, tAt(r.poi));
      assert.ok(Math.abs(pcPoi - 100 - pB(r.poi)) < 5, 'balance at POI: ' + (pcPoi - 100) + ' vs ' + pB(r.poi));
      assert.ok(r.poi > 3000 && r.poi < 5500 && r.poiValve === r.poi, 'POI ' + r.poi);
      // Lift check with the traverse above (total GLR 800, mixed gravity)
      const sgMix = (0.24 * 0.7 + 0.72 * 0.65) / 0.96;
      assert.rel(r.sgMix, sgMix, 1e-12, 'mixed gas gravity');
      const ab = W.WTS_flowline_march([{ len: r.poiValve, id: 2.441, dz: r.poiValve }], { qo: 800, qw: 400, qg: 0.96, api: 35, sgg: sgMix, sgw: 1.07 },
        120, 110, tAt(r.poiValve), { rough: 0.0018, payne: true, accel: false, reverse: true });
      assert.rel(r.pAbove, ab.pOut, 1e-9, 'tubing pressure above POI');
      assert.ok(r.lifts && r.pAbove < r.pBelow, 'target GLR lifts');
      // Minimum GLR: the traverse at glrMin just meets the supported pressure
      assert.ok(r.glrMin > glrF && r.glrMin < 800, 'glrMin ' + r.glrMin);
      const qgMin = r.glrMin * qL / 1e6, qi = qgMin - 0.24;
      const am = W.WTS_flowline_march([{ len: r.poiValve, id: 2.441, dz: r.poiValve }], { qo: 800, qw: 400, qg: qgMin, api: 35, sgg: (0.24 * 0.7 + qi * 0.65) / qgMin, sgw: 1.07 },
        120, 110, tAt(r.poiValve), { rough: 0.0018, payne: true, accel: false, reverse: true });
      assert.ok(Math.abs(am.pOut - r.pBelow) < 2, 'min GLR traverse ' + am.pOut + ' vs ' + r.pBelow);
      assert.rel(r.qinjMin, (r.glrMin - glrF) * qL / 1e6, 1e-9);
      // Top valve: kickoff casing line meets the kill fluid from the wellhead
      const D1 = bisect((D) => gasColumn(L, 1100, D, 0.65, 110, tAt(D)) - (120 + 0.465 * D), 0, r.poiValve);
      assert.ok(Math.abs(r.valves[0].d - D1) < 10, 'top valve ' + r.valves[0].d + ' vs ' + D1);
      assert.ok(D1 > (1100 - 120) / 0.465 && D1 < 1.1 * (1100 - 120) / 0.465, 'deeper than (p_ko − p_wh)/g_s by the gas column only');
      // Valve 2: casing line at p_so − Δp meets kill fluid from the design tubing pressure at valve 1
      const ptd = (D) => r.pts + (r.ptPoi - r.pts) * D / r.poiValve;
      const v1 = r.valves[0].d;
      const D2 = bisect((D) => gasColumn(L, 975, D, 0.65, 110, tAt(D)) - (ptd(v1) + 0.465 * (D - v1)), v1, r.poiValve);
      assert.ok(Math.abs(r.valves[1].d - Math.max(D2, v1 + 250)) < 10, 'valve 2 ' + r.valves[1].d + ' vs ' + D2);
      assert.strictEqual(r.valves[r.valves.length - 1].role, 'Operating');
      assert.rel(r.valves[r.valves.length - 1].d, r.poiValve, 1e-12, 'bottom valve at POI');
      r.valves.forEach((v, k) => {
        assert.strictEqual(v.pso, 1000 - k * 25, 'surface opening ' + k);
        if (k) assert.ok(v.d - r.valves[k - 1].d >= 250 - 1e-6 || v.d === r.poiValve, 'minimum spacing');
        assert.rel(v.pvo, gasColumn(L, v.pso, v.d, 0.65, 110, tAt(v.d)), 2e-3, 'casing opening at depth');
        assert.rel(v.pd, v.pvo * (1 - 0.067) + v.pt * 0.067, 1e-12, 'dome pressure force balance');
        assert.rel(v.ptro, (v.ct * (v.pd + 14.696) - 14.696) / (1 - 0.067), 1e-12, 'test-rack opening');
        assert.ok(v.pvcs < v.pso && v.pvcs > v.pso - 150, 'surface closing below opening');
      });
      // Valves get shallower-spaced with depth and stay below the casing line
      assert.ok(r.valves.every((v) => v.pt < v.pvo), 'design tubing below casing at every valve');
    },
  },
  {
    name: 'GASLIFT limits: POI capped at the deepest mandrel, too little gas, validation messages',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_gaslift_compute;
      const deep = C(Object.assign({}, BASE, { pr: 2200, pi: 1 }));       // p_wf 1,000 psig: balance below the perforations
      assert.ok(deep.ok && deep.poi > 7700 && deep.poiValve === 7700, 'capped at mandrel ' + deep.poi + ' ' + deep.poiValve);
      assert.ok(deep.warnings.some((w) => /deepest mandrel/.test(w)));
      const weak = C(Object.assign({}, BASE, { glr: 250 }));
      assert.ok(weak.ok && !weak.lifts, 'GLR 250 does not lift');
      [{ pko: 900 }, { dmax: 9000 }, { pso: 100 }, { qo: 0, qw: 0 }, { R: 0.6 }, { gs: 1 }].forEach((o, k) => {
        const b = C(Object.assign({}, BASE, o));
        assert.ok(!b.ok && b.errors.length && b.bad.length, 'bad ' + k + ' ' + JSON.stringify(o));
      });
      const neg = C(Object.assign({}, BASE, { pr: 500 }));
      assert.ok(!neg.ok && /flowing bottomhole/.test(neg.errors[0]), 'p_wf < 0 rejected');
    },
  },
  {
    name: 'GASLIFT page: renders, verdicts, schedule table, chart, metric, report, autosave and reload, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      const st = S(app);
      assert.ok(st && st.ok, JSON.stringify(st && st.result && st.result.errors));
      const r = st.result;
      noBad(assert, app, 'default');
      const t = app.el('gl_res').textContent;
      assert.includes(t, '✓ The target GLR lifts');
      assert.includes(t, 'unload the well to the point of injection');
      assert.strictEqual(app.findAll('#gl_res table.dtable tbody tr').length, r.valves.length, 'one row per valve');
      assert.ok(app.canvasLog('gl_chart', 'lineTo').length > 30, 'pressure–depth chart drawn');
      assert.rel(rv(app, 'gl_res', 'Point of injection (operating valve)'), r.poiValve, 2e-3);
      assert.rel(rv(app, 'gl_res', 'Injection gas rate at target GLR'), r.qinj, 2e-3);
      // Metric: same physics
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        assert.rel(S(app).result.poiValve, r.poiValve, 2e-3, 'metric same POI');
        assert.includes(rows(app, 'gl_res').find((x) => x.l === 'Point of injection (operating valve)').v, 'm');
        noBad(assert, app, 'metric');
      } finally { U.setSystem('imperial'); }
      // Report
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const rt = model.results.map((x) => x.title);
      ['Point of Injection and Gas Requirement', 'Valve Schedule', 'Pressure vs Depth'].forEach((s) => assert.ok(rt.indexOf(s) !== -1, 'section ' + s + ': ' + rt.join(' | ')));
      set(app, { gl_glr: 700 }); app.click('gl_calc');
      const q = S(app).qinj;
      assert.rel(q, (700 - 200) * 1200 / 1e6, 1e-9);
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_gaslift') || 'null');
      assert.ok(rec && rec.f && rec.f.gl_glr === '700', 'autosaved');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('gl_glr').value, '700');
        assert.rel(app2.win.WTS_state.gaslift.qinj, q, 1e-9, 'restored and recalculated');
        app2.hook.nav('home');
        const titles = app2.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
        assert.ok(titles.indexOf('Gas Lift Quick Design') !== -1, 'dashboard tile');
      } finally { app2.dispose(); }
    },
  },
];
