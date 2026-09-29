// WP10 — plot tools: line tools (click-on-plot analyses), flow-regime markers,
// overlays, exports. Units: Δt hr, p psia, q STB/d, k md, distances ft.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = ['11-polish.js', '15-diagnostic-annotations.js', '21-plot-utilities.js']
  .map((f) => path.join(__dirname, '..', f));

// Default-sample ground truth (plan §1.4).
const SAMPLE_WELL = {
  fluid: 'oil', q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, pi: 4200,
  T_R: null, testType: 'drawdown', tp: null, tShut: null, pwf0: null, complete: true, missing: [], defaulted: [],
};
const KH = 1575, K = 45, DP_PRIME = 52.39;
const PHI_MU_CT = 0.18 * 1.1 * 1.2e-5;

// ── helpers ────────────────────────────────────────────────────────────────
function stubWell(app, over) {
  app.win.__wp10well = app.toWin(Object.assign({}, SAMPLE_WELL, over || {}));
  app.evalInApp('window.PRiSM_getWell = function () { return JSON.parse(JSON.stringify(window.__wp10well)); };');
}
function stubAData(app, ad) {
  app.win.__wp10ad = app.toWin(Object.assign({ ok: true }, ad));
  app.evalInApp('window.PRiSM_getAnalysisData = function () { return window.__wp10ad; };');
}
function state(app) {
  if (!app.win.PRiSM_state) app.win.PRiSM_state = app.toWin({ params: {} });
  return app.win.PRiSM_state;
}
function bourdet(t, y, L) {
  const n = t.length, d = new Array(n).fill(NaN);
  for (let i = 1; i < n - 1; i++) {
    let i1 = i - 1, i2 = i + 1;
    while (i1 > 0 && Math.log(t[i] / t[i1]) < L) i1--;
    while (i2 < n - 1 && Math.log(t[i2] / t[i]) < L) i2++;
    const a = Math.log(t[i] / t[i1]), b = Math.log(t[i2] / t[i]), c = Math.log(t[i2] / t[i1]);
    d[i] = (y[i] - y[i1]) / a * (b / c) + (y[i2] - y[i]) / b * (a / c);
  }
  return d;
}
function logspace(a, b, n) { const o = []; for (let i = 0; i < n; i++) o.push(Math.pow(10, a + (b - a) * i / (n - 1))); return o; }
// Sample drawdown analysed from pi = 4200 (sign-aware Δp).
function sampleAData(app) {
  const ds = app.seedSample();
  const t = Array.from(ds.t), p = Array.from(ds.p);
  const dp = p.map((v) => 4200 - v);
  return { ok: true, t, tAbs: t.slice(), p, dp, deriv: bourdet(t, dp, 0.15), L: 0.15, sign: -1, pRef: 4200,
           pRefSource: 'pi', testType: 'drawdown', tp: null, qRef: 850, timeFn: 'dt', warnings: [] };
}
const PLOT = { x: 64, y: 30, w: 756, h: 342, cssW: 900, cssH: 420 };
// A canvas with C6-style axes (scale + plot rect; no toX/fromX so the
// inversion fallback is exercised unless `withFns`).
function mockCanvas(app, sx, sy, plotKey, withFns) {
  const doc = app.document;
  let c = doc.getElementById('prism_plot_canvas');
  if (!c) { c = doc.createElement('canvas'); c.id = 'prism_plot_canvas'; doc.body.appendChild(c); }
  c.style.cssText = 'width:900px;height:420px;display:block';
  c.width = 900; c.height = 420;
  app.win.__wp10ax = app.toWin({ scaleX: sx, scaleY: sy, plot: PLOT, plotKey: plotKey || 'bourdet' });
  app.evalInApp(
    '(function () { var c = document.getElementById("prism_plot_canvas"); var ax = window.__wp10ax;' +
    (withFns
      ? ' function f(sc, off, len, flip) { var lg = sc.kind === "log", a = lg ? Math.log10(sc.min) : sc.min, b = lg ? Math.log10(sc.max) : sc.max;' +
        '  return { to: function (v) { var u = ((lg ? Math.log10(v) : v) - a) / (b - a); return flip ? off + len - u * len : off + u * len; },' +
        '           from: function (px) { var u = (px - off) / len; if (flip) u = 1 - u; var w = a + u * (b - a); return lg ? Math.pow(10, w) : w; } }; }' +
        ' var X = f(ax.scaleX, ax.plot.x, ax.plot.w, false), Y = f(ax.scaleY, ax.plot.y, ax.plot.h, true);' +
        ' ax.toX = X.to; ax.fromX = X.from; ax.toY = Y.to; ax.fromY = Y.from;'
      : '') +
    ' c._prismAxes = ax; })();');
  return c;
}
function px(sc, off, len, flip, v) {
  const lg = sc.kind === 'log';
  const a = lg ? Math.log10(sc.min) : sc.min, b = lg ? Math.log10(sc.max) : sc.max;
  const u = ((lg ? Math.log10(v) : v) - a) / (b - a);
  return flip ? off + len - u * len : off + u * len;
}
function pixelFor(sx, sy, x, y) { return [px(sx, PLOT.x, PLOT.w, false, x), px(sy, PLOT.y, PLOT.h, true, y)]; }
function pointer(app, canvas, x, y) {
  const n = app.errors.length;
  canvas.dispatchEvent(new app.win.PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 }));
  if (app.errors.length > n) throw new Error('pointer handler threw: ' + app.errors.slice(n).map((e) => e.message).join('; '));
}
function run(app, key, pts, opts) {
  const r = app.win.PRiSM_runAnalysisKey(key, app.toWin(pts), opts ? app.toWin(opts) : undefined);
  if (!r || !r.ok) throw new Error(key + ' failed: ' + (r && r.error));
  return r.result;
}
const LOGLOG = { x: { kind: 'log', min: 0.01, max: 1000 }, y: { kind: 'log', min: 1, max: 10000 } };

module.exports = [
  {
    name: 'line tools: ≥ 20 tools, camelCase ids, plain-language labels, no legacy short codes in sources',
    wp: 'WP10',
    run(app, assert) {
      const keys = app.win.PRiSM_analysisKeys;
      const ids = Object.keys(keys);
      assert.ok(ids.length >= 20, ids.length + ' tools');
      for (const id of ids) {
        assert.match(id, /^[a-z][A-Za-z]+$/, 'id ' + id);
        const k = keys[id];
        assert.ok(k.label.length >= 8 && /\s/.test(k.label), 'plain label for ' + id + ': ' + k.label);
        assert.ok(!/\b[A-Z]{4,}\b/.test(k.label), 'no all-caps code in label ' + k.label);
        assert.ok(k.hint && k.prompts && k.prompts.length === k.clicks, 'hint + prompts for ' + id);
      }
      // Legacy key codes must not survive in UI text, ids or comments.
      const legacy = /\b(STABIL|HALFSL|CHANEL|3-SIDE|BND-DV|BND-ON|PPNSKN|PPNSLP|PPNSTB|INJSTB|INJSLP|HORSLP|HORSTB|AUTOSL|1\/4SLP|SPHERE|OMEGA|LAMBDA|FAULT|ANGLE)\b/;
      for (const f of SRC) {
        const txt = fs.readFileSync(f, 'utf8');
        const m = legacy.exec(txt);
        assert.ok(!m, path.basename(f) + ' still contains "' + (m && m[0]) + '"');
        assert.ok(!/setInterval\s*\(/.test(txt), path.basename(f) + ' uses setInterval');
      }
    },
  },
  {
    name: 'radial plateau pick (pointer click at 50 h, 52.39 psi) → kh 1575, k 45; results kept out of st.params',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      const st = state(app);
      st.activePlot = 'bourdet';
      st.params = app.toWin({ Cd: 80, S: 2.5 });
      const before = JSON.stringify(st.params);
      const c = mockCanvas(app, LOGLOG.x, LOGLOG.y, 'bourdet');
      assert.equal(app.win.PRiSM_armAnalysisKey('radialPlateau'), true, 'armed');
      assert.equal(c.style.touchAction, 'none', 'touch scrolling suspended while armed');
      const [x, y] = pixelFor(LOGLOG.x, LOGLOG.y, 50, DP_PRIME);
      pointer(app, c, x, y);
      const r = st.analysisKeyResults.radialPlateau;
      assert.ok(r, 'result stored in st.analysisKeyResults');
      assert.near(r.values.kh, KH, 15, 'kh');
      assert.near(r.values.k, K, 0.5, 'k');
      assert.equal(r.defaultInputs.length, 0, 'no defaulted inputs with a complete well');
      assert.equal(JSON.stringify(st.params), before, 'st.params unchanged');
      assert.equal(c.style.touchAction, '', 'disarmed after the click');
    },
  },
  {
    name: 'radial plateau pick on the real plot-library axes (drawn Bourdet canvas)',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      const ad = sampleAData(app);
      stubAData(app, ad);
      const st = state(app);
      st.activePlot = 'bourdet';
      const c = mockCanvas(app, LOGLOG.x, LOGLOG.y, 'bourdet');
      c._prismAxes = null;
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: ad.t, dp: ad.dp }), app.toWin({ hover: false, dragZoom: false }));
      const ax = c._prismAxes;
      assert.ok(ax && ax.scaleX && ax.plot, 'plot stashed its axes');
      assert.equal(app.win.PRiSM_armAnalysisKey('radialPlateau'), true);
      pointer(app, c, ax.toX(50), ax.toY(DP_PRIME));
      const r = st.analysisKeyResults.radialPlateau;
      assert.near(r.values.kh, KH, 15, 'kh');
      assert.near(r.values.k, K, 0.5, 'k');
      assert.near(r.values.S, 2.5, 0.15, 'skin from the plateau pick with Δp from pi');
      assert.near(r.values.rinv, 1548, 20, 'r_inv(120 h)');
    },
  },
  {
    name: '½-slope → xf·√k = 1000 ± 2% (synthetic linear flow, μ 1.1)',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      const m = 4.064 * 850 * 1.25 / (35 * 1000) * Math.sqrt(1.1 / (0.18 * 1.2e-5));
      const t = logspace(-2, 2, 41), dp = t.map((v) => m * Math.sqrt(v)), deriv = t.map((v) => 0.5 * m * Math.sqrt(v));
      stubAData(app, { t, dp, deriv, pRefSource: 'pi', testType: 'drawdown' });
      const onDeriv = run(app, 'halfSlope', [{ x: 10, y: 0.5 * m * Math.sqrt(10) }]);
      assert.rel(onDeriv.values.xfSqrtK, 1000, 0.02, 'click on Δp′');
      assert.equal(onDeriv.warnings.length, 0, 'slope check passes (½)');
      const onDp = run(app, 'halfSlope', [{ x: 10, y: m * Math.sqrt(10) }]);
      assert.rel(onDp.values.xfSqrtK, 1000, 0.02, 'click on Δp is recognised');
      // Slope check: a flat derivative is flagged.
      stubAData(app, { t, dp, deriv: t.map(() => 50), pRefSource: 'pi', testType: 'drawdown' });
      const flat = run(app, 'halfSlope', [{ x: 10, y: 50 }]);
      assert.ok(flat.warnings.some((w) => /not ½/.test(w)), 'non-½ slope warned');
    },
  },
  {
    name: 'boundary doubling: R = 1.5 click → sealing-fault distance 300 ± 10 ft',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      stubAData(app, { ok: false });
      const L = 300;
      const tR = L * L * PHI_MU_CT / (0.0002637 * K * Math.log(2));     // R − 1 = 0.5
      const r = run(app, 'boundaryDoubling', [{ x: 1, y: DP_PRIME }, { x: tR, y: 1.5 * DP_PRIME }]);
      assert.near(r.values.L, 300, 10, 'L');
      assert.near(r.values.k, K, 0.5, 'k from the plateau click');
      // Onset (R = 1.1) uses k from the previous plateau pick.
      run(app, 'radialPlateau', [{ x: 1, y: DP_PRIME }]);
      const tOn = L * L * PHI_MU_CT / (0.0002637 * K * Math.log(10));
      const on = run(app, 'boundaryOnset', [{ x: tOn, y: 1.1 * DP_PRIME }]);
      assert.near(on.values.L, 300, 10, 'onset distance');
      assert.match(on.note, /radial-plateau pick/, 'k source named');
      // Out-of-range ratio is rejected.
      const bad = app.win.PRiSM_runAnalysisKey('boundaryDoubling', app.toWin([{ x: 1, y: 50 }, { x: 10, y: 120 }]));
      assert.equal(bad.ok, false);
      // Buildup (tp 240 h): distances use the equivalent time Δte = tp·Δt/(tp+Δt).
      stubAData(app, { ok: true, t: [1], dp: [1], deriv: [1], testType: 'buildup', tp: 240, pRef: 3000, pRefSource: 'pwf0' });
      const te = tR, dtB = 240 * te / (240 - te);
      assert.ok(dtB > te && dtB < 40, 'shut-in time ' + dtB.toFixed(2) + ' h');
      const bu = run(app, 'boundaryDoubling', [{ x: 1, y: DP_PRIME }, { x: dtB, y: 1.5 * DP_PRIME }]);
      assert.near(bu.values.L, 300, 10, 'buildup distance with Δte');
      // Report-friendly display map.
      assert.near(bu.results['Distance (ft)'], bu.values.L, 1e-9, 'results map carries units');
    },
  },
  {
    name: 'dual porosity: dip ratio 0.0549 → ω 0.0100; dip time from the model kernel → λ 1e-6 ± 5%',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      stubAData(app, { ok: false });
      const w = run(app, 'storativityRatio', [{ x: 1, y: DP_PRIME }, { x: 1.2, y: 0.0549 * DP_PRIME }]);
      assert.near(w.values.omega, 0.01, 5e-4, 'ω');
      // Locate the derivative minimum of the doublePorosity kernel (ω 0.01, λ 1e-6).
      const model = app.win.PRiSM_MODELS.doublePorosity;
      const td = logspace(3.5, 5.5, 201);
      const d = Array.from(model.pdPrime(app.toWin(td), app.toWin({ Cd: 0.01, S: 0, omega: 0.01, lambda: 1e-6 })));
      let iMin = 0; for (let i = 1; i < d.length; i++) if (d[i] < d[iMin]) iMin = i;
      const tMinHr = td[iMin] * PHI_MU_CT * 0.354 * 0.354 / (0.0002637 * K);
      run(app, 'radialPlateau', [{ x: 10, y: DP_PRIME }]);
      const lam = run(app, 'interporosityFlow', [{ x: tMinHr, y: 0.0549 * DP_PRIME }]);
      assert.rel(lam.values.lambda, 1e-6, 0.05, 'λ (t_min ' + tMinHr.toFixed(3) + ' h)');
      const both = run(app, 'dualPorosityDip', [{ x: 10, y: DP_PRIME }, { x: tMinHr, y: 0.0549 * DP_PRIME }]);
      assert.near(both.values.omega, 0.01, 5e-4, 'combined ω');
      assert.rel(both.values.lambda, 1e-6, 0.05, 'combined λ');
    },
  },
  {
    name: 'unit slope → C 8.48e-4 bbl/psi, CD 80; ¼-slope, spherical and channel keys give textbook values',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      stubAData(app, { ok: false });
      const C = 8.48e-4, t = 0.002, dpv = 850 * 1.25 * t / (24 * C);
      const u = run(app, 'unitSlope', [{ x: t, y: dpv }]);
      assert.rel(u.values.C, C, 0.01, 'C');
      assert.near(u.values.CD, 80, 1, 'CD');
      run(app, 'radialPlateau', [{ x: 10, y: DP_PRIME }]);
      // Bilinear: kf·wf = 500 md·ft → Δp′ = ¼·m·t^¼ with m = 44.1qBμ/(h√(kfwf)(φμct k)^¼).
      const mb = 44.1 * 850 * 1.25 * 1.1 / (35 * Math.sqrt(500) * Math.pow(PHI_MU_CT * K, 0.25));
      const qs = run(app, 'quarterSlope', [{ x: 0.1, y: 0.25 * mb * Math.pow(0.1, 0.25) }]);
      assert.rel(qs.values.kfwf, 500, 0.01, 'kf·wf');
      // Spherical: ks = 20 md → |m| = 2452.9 qBμ√(φμct)/ks^1.5, Δp′ = ½|m|/√t.
      const ms = 2452.9 * 850 * 1.25 * 1.1 * Math.sqrt(PHI_MU_CT) / Math.pow(20, 1.5);
      const sp = run(app, 'sphericalSlope', [{ x: 2, y: 0.5 * ms / Math.sqrt(2) }]);
      assert.rel(sp.values.ks, 20, 0.01, 'spherical k');
      // Channel width 1000 ft: Δp′ = ½·m·√t, m = 8.128qB/(hW)·√(μ/(kφct)).
      const mc = 8.128 * 850 * 1.25 / (35 * 1000) * Math.sqrt(1.1 / (K * 0.18 * 1.2e-5));
      const ch = run(app, 'channelWidth', [{ x: 50, y: 0.5 * mc * Math.sqrt(50) }]);
      assert.rel(ch.values.W, 1000, 0.01, 'channel width');
      const ang = run(app, 'wedgeAngle', [{ x: 1, y: 50 }, { x: 100, y: 200 }]);
      assert.near(ang.values.theta, 90, 1e-9, 'plateau ratio 4 → 90°');
      // Gas on pseudo-pressure: kh = 711·q·T/Δm′ (q Mscf/d, T °R).
      stubWell(app, { fluid: 'gas', q: 5000, B: 0.75, mu: 0.02, T_R: 639.67 });
      stubAData(app, { ok: true, t: [1], dp: [1], deriv: [1], pseudo: true, dpUnit: 'psi2/cp', pRefSource: 'pi', testType: 'drawdown' });
      const gas = run(app, 'radialPlateau', [{ x: 10, y: 1e6 }]);
      assert.rel(gas.values.kh, 711 * 5000 * 639.67 / 1e6, 1e-9, 'gas kh from Δm′');
    },
  },
  {
    name: 'semilog lines: MDH → kh 1575, S 2.50; Horner (tp 24 h) → kh 1575, p* 4200, S 2.50',
    wp: 'WP10',
    run(app, assert) {
      const m = 162.6 * 850 * 1.25 * 1.1 / KH;                  // 120.66 psi/cycle
      // MDH (drawdown): p = p1hr − m·log10 Δt with p1hr = 3340.9, pi = 4200.
      stubWell(app);
      stubAData(app, { ok: true, t: [1], dp: [1], deriv: [1], pRef: 4200, pRefSource: 'pi', testType: 'drawdown' });
      const mdh = run(app, 'mdhLine', [{ x: 10, y: 3340.9 - m }, { x: 100, y: 3340.9 - 2 * m }], { plotKey: 'mdh' });
      assert.near(mdh.values.kh, KH, 15, 'MDH kh');
      assert.near(mdh.values.p1hr, 3340.9, 0.01, 'p1hr');
      assert.near(mdh.values.S, 2.5, 0.1, 'MDH S');
      // pi unknown → no skin, with a warning.
      stubWell(app, { pi: null });
      stubAData(app, { ok: true, t: [1], dp: [1], deriv: [1], pRef: 3861.4, pRefSource: 'first-sample', testType: 'drawdown' });
      const noPi = run(app, 'mdhLine', [{ x: 10, y: 3340.9 - m }, { x: 100, y: 3340.9 - 2 * m }], { plotKey: 'mdh' });
      assert.ok(!Number.isFinite(noPi.values.S) && noPi.warnings.some((w) => /pi/.test(w)), 'skin needs pi');
      // Horner buildup, tp = 24 h: p = p* − m·log10((tp+Δt)/Δt).
      const tp = 24, pStar = 4200, S = 2.5;
      const p1hr = pStar - m * Math.log10(tp + 1);
      const pwf0 = p1hr - m * (S / 1.1513 + Math.log10(K / (PHI_MU_CT * 0.354 * 0.354)) - 3.2275 - Math.log10((tp + 1) / tp));
      stubWell(app, { testType: 'buildup', tp, pwf0 });
      stubAData(app, { ok: true, t: [1], dp: [1], deriv: [1], pRef: pwf0, pRefSource: 'pwf0', testType: 'buildup', tp });
      const r1 = 3, r2 = 30;
      const h = run(app, 'hornerLine', [{ x: r2, y: pStar - m * Math.log10(r2) }, { x: r1, y: pStar - m * Math.log10(r1) }], { plotKey: 'horner' });
      assert.near(h.values.kh, KH, 15, 'Horner kh');
      assert.near(h.values.pStar, 4200, 0.5, 'p*');
      assert.near(h.values.S, 2.5, 0.05, 'Horner S');
      // Intersection of two Horner lines at ratio 25 → Δt_x = 1 h → L = 0.01217·√(k·1/(φμct)).
      const ix = run(app, 'lineIntersection', [{ x: 25, y: 4000 }], { plotKey: 'horner' });
      assert.near(ix.values.tx, 1, 1e-9, 'Δt at the intersection');
      assert.near(ix.values.L, 0.01217 * Math.sqrt(K / PHI_MU_CT), 1e-6, 'fault distance');
    },
  },
  {
    name: 'default inputs: no Well & Test store → amber "default inputs" warning on the result and the toolbar',
    wp: 'WP10',
    run(app, assert) {
      app.win.PRiSM_getWell = undefined;
      stubAData(app, { ok: false });
      const st = state(app);
      st.activePlot = 'bourdet';
      const r = run(app, 'radialPlateau', [{ x: 50, y: DP_PRIME }]);
      assert.ok(r.defaultInputs.length >= 4, 'q, B, μ, h flagged: ' + r.defaultInputs.join(','));
      assert.match(r.warnings[0], /Default inputs used/);
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      app.win.PRiSM_renderAnalysisKeyToolbar(host);
      assert.ok(host.querySelector('[data-prism-akey-defaults]'), 'toolbar shows the default-inputs banner');
      assert.includes(host.innerHTML, 'default inputs', 'result row carries the chip');
      // With a complete well the banner disappears.
      stubWell(app);
      app.win.PRiSM_renderAnalysisKeyToolbar(host);
      assert.equal(host.querySelector('[data-prism-akey-defaults]'), null);
    },
  },
  {
    name: 'arming: refuses a tool on the wrong plot, Esc cancels, clicks outside the plot box are ignored',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      const st = state(app);
      st.activePlot = 'cartesian';
      const c = mockCanvas(app, { kind: 'lin', min: 0, max: 120 }, { kind: 'lin', min: 3000, max: 4200 }, 'cartesian');
      assert.equal(app.win.PRiSM_armAnalysisKey('radialPlateau'), false, 'not on the Cartesian plot');
      st.activePlot = 'bourdet';
      mockCanvas(app, LOGLOG.x, LOGLOG.y, 'bourdet', true);          // axes with fromX/fromY (C6)
      assert.equal(app.win.PRiSM_armAnalysisKey('boundaryDoubling'), true);
      assert.ok(app.el('prism_akey_hint'), 'prompt shown');
      pointer(app, c, 5, 5);                                         // outside the plot rectangle
      assert.equal((st.analysisKeyResults || {}).boundaryDoubling, undefined, 'ignored');
      app.key(app.document.body, 'Escape');
      assert.equal(app.el('prism_akey_hint'), null, 'Esc removed the prompt');
      const [x, y] = pixelFor(LOGLOG.x, LOGLOG.y, 50, DP_PRIME);
      pointer(app, c, x, y);
      assert.equal((st.analysisKeyResults || {}).radialPlateau, undefined, 'no tool armed after Esc');
      // C6 fromX/fromY path.
      assert.equal(app.win.PRiSM_armAnalysisKey('radialPlateau'), true);
      pointer(app, c, x, y);
      assert.near(st.analysisKeyResults.radialPlateau.values.kh, KH, 15);
    },
  },
  {
    name: 'Tab 2 panels registered (line tools, flow-regime markers, plot tools) and render at 375 px',
    wp: 'WP10',
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      stubWell(app);
      app.seedSample();
      const st = state(app);
      st.activePlot = 'bourdet';
      const panels = (app.win.PRiSM_tabPanels && app.win.PRiSM_tabPanels[2]) || [];
      const ids = Array.from(panels).map((p) => p.id);
      for (const id of ['linetools', 'regimes', 'plottools']) {
        assert.ok(ids.indexOf(id) !== -1, id + ' registered in PRiSM_tabPanels[2]');
      }
      for (const p of panels) {
        if (!/^(linetools|regimes|plottools)$/.test(p.id)) continue;
        assert.ok(p.title && /^[A-Z][a-z]/.test(p.title), 'plain title ' + p.title);
        const host = app.document.createElement('div');
        host.style.cssText = 'width:343px';
        app.document.body.appendChild(host);
        p.render(host);
        assert.ok(host.innerHTML.length > 100, p.id + ' rendered');
        const widths = (host.innerHTML.match(/(?:^|[;"\s])(?:min-)?width:\s*(\d+)px/g) || [])
          .map((s) => +/(\d+)px/.exec(s)[1]);
        assert.ok(widths.every((w) => w <= 343), p.id + ' fixed widths fit a phone: ' + widths.join(','));
      }
      assert.ok(app.findAll('[data-prism-akey]').length >= 10, 'log-log tools listed');
      assert.ok(app.find('[data-cb-png]') && app.find('[data-cb-pdf]'), 'PNG and PDF export buttons in Plot tools');
      assert.ok(app.find('[data-overlay-add]') && app.find('[data-diff-go]'), 'overlay manager and diff picker mounted');
      // Toolbar follows the active plot.
      st.activePlot = 'horner';
      app.fire('window', 'prism:plot-changed', { plotKey: 'horner' });
      const keys = app.findAll('#prism_linetools [data-prism-akey]').map((b) => b.getAttribute('data-prism-akey'));
      assert.ok(keys.indexOf('hornerLine') !== -1 && keys.indexOf('radialPlateau') === -1, 'Horner tools: ' + keys.join(','));
    },
  },
  {
    name: 'flow-regime markers on the default sample (Δp from pi): drawn once per draw, no spherical tag',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      const ad = sampleAData(app);
      stubAData(app, ad);
      const st = state(app);
      st.activePlot = 'bourdet';
      const sx = { kind: 'log', min: 0.008, max: 150 }, sy = { kind: 'log', min: 20, max: 2000 };
      const c = mockCanvas(app, sx, sy, 'bourdet');
      const hooks = Array.from(app.win.PRiSM_postDrawHooks || []);
      const hook = hooks.find((f) => f && f._prismId === 'flow-regime-markers');
      assert.fn(hook, 'marker post-draw hook registered');
      assert.equal(hooks.filter((f) => f && f._prismId === 'flow-regime-markers').length, 1, 'registered once');
      const info = app.toWin({ plotKey: 'bourdet', data: { t: ad.t, dp: ad.dp, deriv: ad.deriv } });
      info.canvas = c; info.axes = c._prismAxes;
      hook(info);
      assert.equal(c._prismAnnotationsDrawCount, 1, 'drawn once');
      hook(info);
      assert.equal(c._prismAnnotationsDrawCount, 2, 'once per draw');
      const types = Array.from(c._prismAnnotations || []).map((v) => v.ann.type);
      assert.ok(types.length > 0, 'markers drawn: ' + types.join(','));
      assert.ok(types.indexOf('sphericalFlow') === -1, 'no spherical marker on the storage hump: ' + types.join(','));
      assert.ok(types.indexOf('radialFlowStart') !== -1, 'radial flow marked: ' + types.join(','));
      const texts = app.canvasTexts(c);
      assert.ok(!texts.some((s) => /spherical/i.test(s)), 'no spherical label text');
      // Disabled → nothing drawn.
      app.win.PRiSM_annotationsEnabled = false;
      hook(info);
      assert.equal(c._prismAnnotationsDrawCount, 2, 'disabled');
      app.win.PRiSM_annotationsEnabled = true;
      // Non-Δt plots are skipped.
      info.plotKey = 'horner';
      hook(info);
      assert.equal(c._prismAnnotationsDrawCount, 2, 'not drawn on the Horner plot');
    },
  },
  {
    name: 'flow-regime panel: L input writes st.bourdetL, Auto L picks from noise, toggle redraws',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      stubAData(app, sampleAData(app));
      const st = state(app);
      let draws = 0;
      app.win.PRiSM_drawActivePlot = function () { draws++; };
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      app.win.PRiSM_renderAnnotationToolbar(host);
      assert.includes(app.el('prism_ann_list').textContent, 'Radial flow', 'detected regimes listed');
      app.input('prism_ann_L', '0.3');
      assert.equal(st.bourdetL, 0.3, 'L stored');
      assert.equal(draws, 1, 'redrawn');
      app.input('prism_ann_L', '0.9');
      assert.equal(st.bourdetL, 0.5, 'clamped to 0.5');
      app.click('prism_ann_autoL');
      assert.within(st.bourdetL, 0.05, 0.5, 'auto L');
      assert.includes(app.el('prism_ann_infoline').textContent, 'suggested L');
      app.check('prism_ann_show', false);
      assert.equal(app.win.PRiSM_annotationsEnabled, false);
      assert.equal(draws, 4, 'every change redraws through PRiSM_drawActivePlot');
    },
  },
  {
    name: 'overlays: model overlay via PRiSM_evalModelCurve drawn with the plot transform; active curve kept',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      const ad = sampleAData(app);
      stubAData(app, ad);
      const st = state(app);
      st.activePlot = 'bourdet';
      st.model = 'homogeneous';
      st.modelCurveData = app.toWin({ marker: 'active' });
      app.win.__wp10curve = app.toWin({ t: ad.t, dp: ad.dp.map((v) => v * 1.01), deriv: ad.deriv });
      app.evalInApp('window.__wp10calls = 0; window.PRiSM_evalModelCurve = function (k, p, o) {' +
                    ' window.__wp10calls++; window.PRiSM_state.modelCurveData = { clobbered: true }; return window.__wp10curve; };');
      const c = mockCanvas(app, { kind: 'log', min: 0.008, max: 150 }, { kind: 'log', min: 20, max: 2000 }, 'bourdet');
      app.win.PRiSM_overlays.clear();
      app.win.PRiSM_overlays.add('model:homogeneous');
      const hook = Array.from(app.win.PRiSM_postDrawHooks).find((f) => f && f._prismId === 'plot-overlays');
      assert.fn(hook, 'overlay post-draw hook registered');
      const n0 = app.canvasLog(c, 'lineTo').length;
      const info = app.toWin({ plotKey: 'bourdet', opts: {} });
      info.canvas = c; info.axes = c._prismAxes;
      hook(info);
      assert.ok(app.win.__wp10calls >= 1, 'model resolved through PRiSM_evalModelCurve');
      assert.equal(st.modelCurveData.marker, 'active', 'active model curve restored');
      assert.equal(Array.from(c._prismOverlaysDrawn || []).length, 1, 'overlay drawn');
      assert.ok(app.canvasLog(c, 'lineTo').length - n0 > 50, 'Δp and Δp′ overlay polylines drawn');
      app.win.PRiSM_overlays.clear();
    },
  },
  {
    name: 'PNG export uses PRiSM_buildPlotData; PDF export goes through the host report pipeline',
    wp: 'WP10',
    run(app, assert) {
      stubWell(app);
      const ad = sampleAData(app);
      stubAData(app, ad);
      state(app).activePlot = 'bourdet';
      app.evalInApp('window.__wp10bpd = []; window.PRiSM_buildPlotData = function (k) { window.__wp10bpd.push(k);' +
                    ' var a = window.__wp10ad; return { data: { t: a.t, dp: a.dp, deriv: a.deriv }, opts: {} }; };');
      assert.equal(app.win.PRiSM_exportPlotPNG('bourdet'), true);
      assert.ok(Array.from(app.win.__wp10bpd).indexOf('bourdet') !== -1, 'buildPlotData called for the plot');
      assert.ok(app.downloads.some((d) => d.filename === 'prism_bourdet.png'), 'PNG downloaded');
      app.evalInApp('window.PRiSM_buildReportHTML = function () { return "<h2>WP10 report body</h2>"; };');
      assert.equal(app.win.PRiSM_exportReportPDF(), 'host', 'host exportReport used');
      const html = app.opened.map((o) => o.html()).join('\n');
      assert.includes(html, 'WP10 report body');
      assert.includes(html, '<img', 'plot gallery baked in as PNG');
      assert.ok(app.win.PRiSM_listPlots().length >= 14);
    },
  },
  {
    name: 'data exports: clipboard TSV and XML carry dp_psi / dp_deriv_psi, well inputs and line-tool results',
    wp: 'WP10',
    async run(app, assert) {
      stubWell(app);
      stubAData(app, sampleAData(app));
      run(app, 'radialPlateau', [{ x: 50, y: DP_PRIME }]);
      const r = await app.win.PRiSM_copyDataToClipboard('tsv');
      assert.ok(r.success, r.error);
      const lines = String(app.clipboard).split('\n');
      assert.equal(lines[0], 'dt_hr\tt_hr\tp_psia\tdp_psi\tdp_deriv_psi');
      assert.equal(lines.length, 56, 'header + 55 rows');
      assert.near(+lines[1].split('\t')[3], 338.6, 0.1, 'Δp(t0) from pi');
      const xml = app.win.PRiSM_exportXML({ pretty: false }).xmlString;
      for (const tag of ['<Well', 'name="q"', '<DerivativeData', '<dp_psi>', '<dp_deriv_psi>', '<LineTools', 'key="radialPlateau"']) {
        assert.includes(xml, tag);
      }
    },
  },
  {
    name: 'analytics via hooks and events (no wrappers); no timers left by WP10 files',
    wp: 'WP10',
    run(app, assert) {
      const any = Array.from((app.win.PRiSM_tabHooks && app.win.PRiSM_tabHooks.any) || []);
      const tabHook = any.find((f) => f && f._prismId === 'ga4-tab-open');
      assert.fn(tabHook, 'GA tab hook registered in PRiSM_tabHooks.any');
      const dl = app.win.dataLayer;
      const n0 = dl.length;
      tabHook(3);
      app.fire('window', 'prism:model-changed', { modelKey: 'homogeneous' });
      app.fire('window', 'prism:fit-updated', { source: 'regression' });
      const names = Array.from(dl).slice(n0).map((e) => e && e[1]);
      assert.deepEqual(names, ['prism_tab_open', 'prism_model_select', 'prism_regress_run']);
      assert.ok(!(app.win.PRiSM && app.win.PRiSM.setTab && app.win.PRiSM.setTab._ga4Wrapped), 'setTab not wrapped');
      // Render the panels + run a tool, then let one-shot timers expire.
      stubWell(app);
      app.seedSample();
      for (const p of Array.from(app.win.PRiSM_tabPanels[2] || [])) {
        const host = app.document.createElement('div');
        app.document.body.appendChild(host);
        p.render(host);
      }
      run(app, 'radialPlateau', [{ x: 50, y: DP_PRIME }]);
      app.flush(10000);
      const mine = app.timers().filter((t) => /(11-polish|15-diagnostic-annotations|21-plot-utilities)\.js/.test(t.where || ''));
      assert.equal(mine.length, 0, 'pending WP10 timers: ' + mine.map((t) => t.where).join(' | '));
    },
  },

  // ── Integration (needs WP1 C1/C2, WP6 axes, WP7 dispatcher + hooks, WP8 panel mount) ──
  {
    name: 'integration: default-sample Tab 2 Bourdet — radial plateau click at (50 h, 52.39 psi) → kh 1575, k 45',
    wp: 'WP10',
    integration: true,
    run(app, assert) {
      app.openPRiSM();
      app.gotoTab(2);
      app.flush(500);
      const st = app.win.PRiSM_state;
      assert.equal(st.activePlot, 'bourdet');
      const before = JSON.stringify(st.params);
      const c = app.el('prism_plot_canvas');
      const ax = c._prismAxes;
      assert.fn(ax && ax.fromX, 'C6 axes inverse');
      assert.equal(app.win.PRiSM_armAnalysisKey('radialPlateau'), true);
      pointer(app, c, ax.toX(50), ax.toY(DP_PRIME));
      const r = st.analysisKeyResults.radialPlateau;
      assert.near(r.values.kh, KH, 15, 'kh');
      assert.near(r.values.k, K, 0.5, 'k');
      assert.equal(r.defaultInputs.length, 0, 'sample well inputs are real, not defaults');
      assert.near(r.values.S, 2.5, 0.2, 'S from Δp referenced to pi');
      assert.equal(JSON.stringify(st.params), before, 'st.params unchanged');
    },
  },
  {
    name: 'integration: panels mounted on Tab 2, markers once per draw, overlay drawn, no pending timers',
    wp: 'WP10',
    integration: true,
    run(app, assert) {
      app.openPRiSM();
      app.gotoTab(2);
      app.flush(500);
      assert.ok(app.el('prism_linetools'), 'line tools mounted');
      assert.ok(app.el('prism_ann_show'), 'flow-regime panel mounted');
      const head = app.find('[data-panel-id="plottools"] .prism-panel-head');
      assert.ok(head, 'plot tools card present (collapsed)');
      app.click(head);
      assert.ok(app.find('[data-pt-overlays]'), 'plot tools mounted on expand');
      const c = app.el('prism_plot_canvas');
      const n = c._prismAnnotationsDrawCount || 0;
      app.win.PRiSM_drawActivePlot();
      assert.equal(c._prismAnnotationsDrawCount, n + 1, 'markers drawn exactly once per draw');
      const types = Array.from(c._prismAnnotations || []).map((v) => v.ann.type);
      assert.ok(types.indexOf('sphericalFlow') === -1, 'no spherical marker: ' + types.join(','));
      app.win.PRiSM_overlays.clear();
      app.win.PRiSM_overlays.add('model:homogeneous');
      app.win.PRiSM_drawActivePlot();
      assert.equal(Array.from(c._prismOverlaysDrawn || []).length, 1, 'overlay drawn');
      app.flush(40000);
      assert.equal(app.pendingTimers(), 0, 'no pending timers: ' + app.timers().map((t) => t.where).join(' | '));
    },
  },
];
