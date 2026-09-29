// WP5 — Semilog (straight-line) analysis and skin deliverables (34-semilog-skin.js).
// Acceptance a–e from the gap plan §WP5 plus API, UI and registration checks.
'use strict';

const SAMPLE_WELL = { q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, pi: 4200, fluid: 'oil', testType: 'drawdown' };
const A_PSI = 141.2 * 850 * 1.25 * 1.1 / (45 * 35);          // 104.78 psi per pD
const B_TD = 0.0002637 * 45 / (0.18 * 1.1 * 1.2e-5 * 0.354 * 0.354); // 39,854 tD per hour
const M_TRUE = 162.6 * 850 * 1.25 * 1.1 / (45 * 35);          // 120.66 psi/cycle
const LOGK = Math.log10(45 / (0.18 * 1.1 * 1.2e-5 * 0.354 * 0.354)) - 3.2275;

// Hide the C1/C2 providers so the WP5 local fallbacks are exercised
// (keeps unit tests independent of WP1 landing).
function hideProviders(app) {
  app.evalInApp('window.PRiSM_getWell = undefined; window.PRiSM_getAnalysisData = undefined;');
}

function logspace(a, b, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.pow(10, Math.log10(a) + (Math.log10(b) - Math.log10(a)) * i / (n - 1)));
  return out;
}

// Build-up after a constant-rate drawdown of tp hours, from the homogeneous
// model (Cd 80, S 2.5) by superposition. Returns {t, p, q} in absolute hours.
function syntheticBuildup(app, tp) {
  const M = app.win.PRiSM_MODELS.homogeneous;
  const pd = (td) => M.pd(td, { Cd: 80, S: 2.5 });
  const t = [], p = [], q = [];
  logspace(0.01, tp, 40).forEach((tt) => { t.push(tt); p.push(4200 - A_PSI * pd(B_TD * tt)); q.push(850); });
  t[t.length - 1] = tp; p[p.length - 1] = 4200 - A_PSI * pd(B_TD * tp);
  logspace(0.01, 72, 55).forEach((dt) => {
    t.push(tp + dt);
    p.push(4200 - A_PSI * (pd(B_TD * (tp + dt)) - pd(B_TD * dt)));
    q.push(0);
  });
  return { t, p, q };
}

module.exports = [
  {
    name: 'a. default sample: MDH window, m, k, p1hr, S and all skin deliverables',
    wp: 'WP5',
    run(app, assert) {
      const ds = app.seedSample();
      const S = app.win.PRiSM_semilog;
      assert.ok(S, 'PRiSM_semilog namespace exported');
      const ad = S.localAnalysisData(ds, SAMPLE_WELL);
      assert.equal(ad.pRefSource, 'pi');
      const r = app.win.PRiSM_semilogAnalysis(ad, SAMPLE_WELL);
      assert.ok(r.ok, r.reason);
      assert.equal(r.method, 'mdh');
      assert.ok(r.window.auto && r.window.found, 'automatic IARF window found');
      assert.within(r.window.t0, 0.3, 120); assert.within(r.window.t1, 0.3, 120.0001);
      assert.near(r.m, 120.7, 1.5);
      assert.near(r.k, 45.0, 1.0);
      assert.near(r.kh, 1575, 35);
      assert.near(r.p1hr, 3340.9, 3);
      assert.near(r.S, 2.50, 0.10);
      assert.near(r.dpS, 262, 8);
      assert.near(r.FE, 0.764, 0.01);
      assert.near(r.DR, 1.31, 0.02);
      assert.near(r.J, 0.766, 0.005);
      assert.near(r.J_ideal, 1.00, 0.01);
      assert.near(r.rwEff, 0.0291, 0.0005);
      assert.near(r.rinv, 1548, 15);
      assert.ok(r.crossCheck.pass, 'derivative-plateau cross-check passes');
      assert.near(r.crossCheck.dpPrime_r, 52.39, 1.0);
      assert.ok(r.warnings.some((w) => /unit-slope/i.test(w)), 'no-unit-slope warning present');
      assert.ok(!r.warnings.some((w) => /biased/.test(w)), 'no bias warning when pi is set');
      assert.ok(!isFinite(r.pStar), 'no p* for a drawdown');
    },
  },
  {
    name: 'a2. no-argument call on the seeded sample stores st.semilog and fires prism:fit-updated',
    wp: 'WP5',
    run(app, assert) {
      hideProviders(app);
      app.seedSample();
      // Seeding (WP8) fires dataset-loaded/well-changed, so 34's quiet recompute may
      // already have stored st.semilog; clear it so the explicit call is a change.
      if (app.win.PRiSM_state) app.win.PRiSM_state.semilog = null;
      app.evalInApp("window.__wp5ev = []; window.addEventListener('prism:fit-updated', function (e) { window.__wp5ev.push(e.detail && e.detail.source); });");
      const r = app.win.PRiSM_semilogAnalysis();
      assert.ok(r && r.ok, r && r.reason);
      assert.strictEqual(app.win.PRiSM_state.semilog, r, 'stored in st.semilog');
      assert.near(r.k, 45, 1); assert.near(r.S, 2.5, 0.1);
      assert.deepEqual(Array.from(app.win.__wp5ev), ['semilog']);
      // Same result again → no duplicate event; lastFit untouched.
      app.win.PRiSM_semilogAnalysis();
      assert.equal(app.win.__wp5ev.length, 1, 'unchanged result does not re-fire');
      assert.ok(!app.win.PRiSM_state.lastFit || app.win.PRiSM_state.lastFit.source !== 'semilog', 'never writes lastFit');
      // Persisted copy has no heavy plotting arrays.
      assert.ok(JSON.stringify(r).indexOf('"plot"') === -1, 'plot arrays are not enumerable');
    },
  },
  {
    name: 'b. pi unset (first-sample pRef): warning says "biased", S ≈ −0.73',
    wp: 'WP5',
    run(app, assert) {
      const ds = app.seedSample();
      const w = Object.assign({}, SAMPLE_WELL, { pi: null });
      const ad = app.win.PRiSM_semilog.localAnalysisData(ds, w);
      assert.equal(ad.pRefSource, 'first-sample');
      const r = app.win.PRiSM_semilogAnalysis(ad, w);
      assert.ok(r.ok);
      assert.ok(r.warnings.some((x) => /biased/.test(x)), 'bias warning');
      assert.near(r.S, -0.73, 0.1);
      assert.near(r.m, 120.7, 1.5);
    },
  },
  {
    name: 'c. synthetic build-up tp = 24 h: Horner k, S, p* (auto-detected from the rate column)',
    wp: 'WP5',
    run(app, assert) {
      const data = syntheticBuildup(app, 24);
      const w = Object.assign({}, SAMPLE_WELL, { pi: null, testType: 'auto' });
      const ad = app.win.PRiSM_semilog.localAnalysisData(data, w);
      assert.equal(ad.testType, 'buildup');
      assert.near(ad.tShut, 24, 1e-9);
      assert.near(ad.tp, 24, 1e-9);
      const r = app.win.PRiSM_semilogAnalysis(ad, w);
      assert.ok(r.ok, r.reason);
      assert.equal(r.method, 'horner');
      assert.near(r.k, 45, 1);
      assert.near(r.S, 2.5, 0.15);
      assert.near(r.pStar, 4200, 5);
      assert.ok(r.line && r.line.kind === 'horner' && r.line.m < 0, 'Horner line: p falls with log ratio');
      assert.near(r.line.b, r.pStar, 1e-9);
      // FE / J for a build-up use p* and pwf(Δt=0).
      assert.near(r.pbar, r.pStar, 1e-9);
      assert.near(r.FE, (r.pStar - r.pwf - r.dpS) / (r.pStar - r.pwf), 1e-12);
      // Superposition and Agarwal methods agree with Horner on a single-rate build-up.
      const rs = app.win.PRiSM_semilogAnalysis(ad, w, { method: 'superposition', window: { t0: r.window.t0, t1: r.window.t1 } });
      const ra = app.win.PRiSM_semilogAnalysis(ad, w, { method: 'agarwal', window: { t0: r.window.t0, t1: r.window.t1 } });
      assert.equal(rs.method, 'superposition'); assert.equal(ra.method, 'agarwal');
      assert.near(rs.k, r.k, 1e-9); assert.near(rs.S, r.S, 1e-9); assert.near(rs.pStar, r.pStar, 1e-9);
      assert.near(ra.k, r.k, 1e-9); assert.near(ra.S, r.S, 1e-9);
    },
  },
  {
    name: 'c2. Horner without tp falls back to MDH with a warning',
    wp: 'WP5',
    run(app, assert) {
      const data = syntheticBuildup(app, 24);
      const ad = app.win.PRiSM_semilog.localAnalysisData(data, Object.assign({}, SAMPLE_WELL, { testType: 'auto' }));
      ad.tp = null;
      const r = app.win.PRiSM_semilogAnalysis(ad, Object.assign({}, SAMPLE_WELL, { tp: null }), { method: 'horner' });
      assert.ok(r.ok);
      assert.equal(r.method, 'mdh');
      assert.ok(r.warnings.some((x) => /tp unknown/.test(x)));
    },
  },
  {
    name: 'd. rate-dependent skin: S′ = 2 + 0.001 q → S = 2, D = 0.001',
    wp: 'WP5',
    run(app, assert) {
      const r = app.win.PRiSM_rateDependentSkin([500, 1000, 1500].map((q) => ({ q, S: 2 + 0.001 * q })));
      assert.ok(r.ok);
      assert.near(r.S, 2.0, 1e-6);
      assert.near(r.D, 0.001, 1e-9);
      assert.equal(r.n, 3);
      assert.ok(!app.win.PRiSM_rateDependentSkin([{ q: 500, S: 2 }]).ok, 'one period is not enough');
      assert.ok(!app.win.PRiSM_rateDependentSkin([{ q: 500, S: 2 }, { q: 500, S: 3 }]).ok, 'equal rates rejected');
    },
  },
  {
    name: 'e. skin decomposition: partialPen b = 0.2, S_total 12.79 → S_mech 2.00',
    wp: 'WP5',
    run(app, assert) {
      const r = app.win.PRiSM_skinDecomposition({
        S_total: 12.79, modelKey: 'partialPen', params: { hp_to_h: 0.2, KvKh: 1 },
        geom: { h: 35, rw: 0.354, kvkh: 1 },
      });
      assert.ok(r.ok);
      assert.near(r.S_mech, 2.0, 0.05);
      assert.near(r.S_pp, 10.79, 0.05);
      // hp given in feet takes precedence over the model fraction.
      const r2 = app.win.PRiSM_skinDecomposition({ S_total: 12.79, geom: { h: 35, hp: 7, rw: 0.354, kvkh: 1 } });
      assert.near(r2.S_mech, r.S_mech, 1e-9);
      // Deviation (negative pseudo-skin), fracture and D·q terms.
      const r3 = app.win.PRiSM_skinDecomposition({ S_total: 0, geom: { h: 35, rw: 0.354, theta: 45, kvkh: 1 }, D: 0.001, q: 850 });
      assert.ok(r3.S_theta < 0, 'deviated well has negative geometric skin');
      assert.near(r3.Dq, 0.85, 1e-12);
      assert.near(r3.S_mech, 0 - r3.S_theta - 0.85, 1e-12);
      const r4 = app.win.PRiSM_skinDecomposition({ S_total: -4, geom: { h: 35, rw: 0.354, xf: 100 } });
      assert.near(r4.S_f, -Math.log(100 / 0.708), 1e-9);
    },
  },
  {
    name: 'skinSummary reproduces the §1.4 reference numbers',
    wp: 'WP5',
    run(app, assert) {
      const r = app.win.PRiSM_skinSummary({ S: 2.5, kh: 1575, m: 120.66, q: 850, B: 1.25, mu: 1.1, rw: 0.354, pbar: 4200, pwf: 3089.8, CD: 80 });
      assert.ok(r.ok);
      assert.near(r.dpS, 261.9, 0.3);
      assert.near(r.FE, 0.764, 0.001);
      assert.near(r.DR, 1.309, 0.002);
      assert.near(r.J, 0.766, 0.001);
      assert.near(r.J_ideal, 1.002, 0.002);
      assert.near(r.rwEff, 0.0291, 0.0001);
      assert.rel(r.CDe2S, 80 * Math.exp(5), 1e-12);
      // Without kh the 0.869·m·S form is used.
      const r2 = app.win.PRiSM_skinSummary({ S: 2.5, m: 120.66 });
      assert.near(r2.dpS, 262.1, 0.3);
    },
  },
  {
    name: 'superposition: two-rate drawdown recovers k and S (Δp from pi and from the period start)',
    wp: 'WP5',
    run(app, assert) {
      const q1 = 500, q2 = 850, t1 = 10;
      const mu = 162.6 * 1.25 * 1.1 / (45 * 35);   // psi/cycle per STB/d
      const F = (tau) => mu * (Math.log10(tau) + LOGK + 0.8686 * 2.5);
      const pw = (t) => 4200 - (t <= t1 ? q1 * F(t) : q1 * F(t) + (q2 - q1) * F(t - t1));
      const dts = logspace(0.05, 100, 40);
      const p = dts.map((dt) => pw(t1 + dt));
      const base = { ok: true, n: dts.length, t: dts, tAbs: dts.map((d) => d + t1), p, testType: 'drawdown',
        tStart: t1, qRef: q2, rateHistory: [{ t: 0, q: q1 }, { t: t1, q: q2 }], fluid: 'oil', warnings: [] };
      const adPi = Object.assign({}, base, { dp: p.map((v) => 4200 - v), pRef: 4200, pRefSource: 'pi' });
      const r1 = app.win.PRiSM_semilogAnalysis(adPi, SAMPLE_WELL);
      assert.equal(r1.method, 'superposition');
      assert.near(r1.m, (q2 - q1) * mu, 1e-6);
      assert.near(r1.k, 45, 1e-6); assert.near(r1.S, 2.5, 1e-3);
      const p0 = pw(t1);
      const adSt = Object.assign({}, base, { dp: p.map((v) => p0 - v), pRef: p0, pRefSource: 'pwf0' });
      const r2 = app.win.PRiSM_semilogAnalysis(adSt, SAMPLE_WELL);
      assert.near(r2.k, 45, 1e-6); assert.near(r2.S, 2.5, 1e-3);
    },
  },
  {
    name: 'injection and gas pseudo-pressure: signs and the 1637 equation',
    wp: 'WP5',
    run(app, assert) {
      // Injection at 850 STB/d: p rises above pi.
      const ts = logspace(0.1, 100, 40);
      const pInj = ts.map((t) => 4200 + M_TRUE * (Math.log10(t) + LOGK + 0.8686 * 2.5));
      const wI = Object.assign({}, SAMPLE_WELL, { testType: 'injection' });
      const adI = app.win.PRiSM_semilog.localAnalysisData({ t: ts, p: pInj, q: ts.map(() => 850) }, wI);
      assert.ok(adI.dp.every((v) => v > 0), 'sign-aware Δp positive for injection');
      const rI = app.win.PRiSM_semilogAnalysis(adI, wI);
      assert.near(rI.k, 45, 1e-6); assert.near(rI.S, 2.5, 1e-3);
      assert.near(rI.p1hr, 4200 + M_TRUE * (LOGK + 0.8686 * 2.5), 1e-6);
      // Gas: Δm(p) straight line, kh = 1637 q T / m.
      const qg = 5000, TR = 640, kh = 1575, mG = 1637 * qg * TR / kh;
      const dm = ts.map((t) => mG * (Math.log10(t) + LOGK + 0.8686 * 2.5));
      const adG = { ok: true, t: ts, p: ts.map(() => NaN), dp: dm, pRef: 4200, pRefSource: 'pi', testType: 'drawdown',
        qRef: qg, fluid: 'gas', pseudo: true, warnings: [] };
      const rG = app.win.PRiSM_semilogAnalysis(adG, Object.assign({}, SAMPLE_WELL, { fluid: 'gas', q: qg, T_R: TR, mu: 0.025, ct: 1e-4 }));
      assert.near(rG.kh, kh, 1e-6);
      assert.ok(rG.warnings.some((w) => /pseudo-pressure/.test(w)));
    },
  },
  {
    name: 'missing inputs are reported, never silently defaulted',
    wp: 'WP5',
    run(app, assert) {
      const ds = app.seedSample();
      const w = { q: 850, B: 1.25, mu: 1.1, pi: 4200, testType: 'drawdown' };  // no h, phi, ct, rw
      const r = app.win.PRiSM_semilogAnalysis(app.win.PRiSM_semilog.localAnalysisData(ds, w), w);
      assert.ok(r.ok);
      assert.ok(isFinite(r.kh) && !isFinite(r.k) && !isFinite(r.S));
      assert.ok(r.warnings.some((x) => /Missing inputs: .*h/.test(x)));
      assert.deepEqual(Array.from(r.missing).sort(), ['ct', 'h', 'phi', 'rw']);
    },
  },
  {
    name: 'panel renders, analyses, seeds regression, splits skin and fits D (fallback providers)',
    wp: 'WP5',
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      hideProviders(app);
      app.seedSample();
      app.evalInApp("window.PRiSM_state.params = window.PRiSM_state.params || {}; window.PRiSM_state.params.S = 0; window.PRiSM_state.params.Cd = 100;");
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      app.win.PRiSM_renderSemilogPanel(host);
      assert.ok(app.el('prism_sl_root'), 'panel root');
      const table = app.el('prism_sl_table');
      assert.ok(table && /Permeability k/.test(table.innerHTML));
      assert.ok(/44\.9|45\.0|45/.test(table.innerHTML));
      assert.ok(/prism-sl-ok/.test(app.el('prism_sl_cross').innerHTML), 'cross-check badge green');
      // No inline fixed widths wider than a phone.
      const wide = app.findAll('#prism_sl_root *').filter((el) => {
        const m = /(?:^|;)\s*(?:min-)?width:\s*(\d+)px/.exec(el.style.cssText || '');
        return m && +m[1] > 343;
      });
      assert.equal(wide.length, 0, 'no inline width > 343 px');
      // Manual window changes the result and fires an event.
      app.evalInApp("window.__wp5ev = 0; window.addEventListener('prism:fit-updated', function (e) { if (e.detail && e.detail.source === 'semilog') window.__wp5ev++; });");
      app.input(app.el('prism_sl_t0'), '1');
      app.input(app.el('prism_sl_t1'), '20');
      app.click(app.el('prism_sl_run'));
      const st = app.win.PRiSM_state;
      assert.near(st.semilog.window.t0, 1.095, 1e-9);
      assert.equal(st.semilog.window.auto, false);
      assert.ok(app.win.__wp5ev >= 1);
      app.click(app.el('prism_sl_auto'));
      assert.equal(st.semilog.window.auto, true);
      assert.equal(app.el('prism_sl_t0').value, '');
      // Use as regression start values.
      app.click(app.el('prism_sl_seed'));
      assert.near(st.phys.k, 45, 1); assert.near(st.phys.S, 2.5, 0.1);
      assert.near(st.params.S, st.phys.S, 1e-12);
      assert.ok(/Start values set/.test(app.el('prism_sl_msg').textContent));
      // Store in report.
      app.click(app.el('prism_sl_report'));
      assert.equal(st.semilog.pinned, true);
      // Skin decomposition sub-card.
      app.input(app.el('prism_sl_hp'), '7');
      app.click(app.el('prism_sl_decomp_run'));
      const dt = app.el('prism_sl_decomp_table');
      assert.ok(dt && /Mechanical skin/.test(dt.innerHTML));
      assert.ok(st.semilog.decomposition && st.semilog.decomposition.S_pp > 10);
      // Rate-dependent skin table (+ an added row).
      app.click(app.el('prism_sl_drow'));
      [[500, 2.5], [1000, 3], [1500, 3.5], [2000, 4]].forEach(([q, s], i) => {
        app.input(app.el('prism_sl_dq_' + i), String(q));
        app.input(app.el('prism_sl_ds_' + i), String(s));
      });
      app.click(app.el('prism_sl_dfit'));
      assert.ok(/Non-Darcy/.test(app.el('prism_sl_dres').innerHTML));
      assert.near(st.semilog.rateDependent.D, 0.001, 1e-9);
      assert.near(parseFloat(app.el('prism_sl_D').value), 0.001, 1e-9);
      // Method selector → Horner without tp falls back with a warning shown.
      app.select(app.el('prism_sl_method'), 'horner');
      assert.ok(/tp unknown/.test(app.el('prism_sl_warn').innerHTML));
      assert.equal(app.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'registration: Tab-2 panel spec, post-draw hook, mdh plot entry; no timers',
    wp: 'WP5',
    run(app, assert) {
      const w = app.win;
      const panels = (w.PRiSM_tabPanels && w.PRiSM_tabPanels[2]) || [];
      const spec = Array.from(panels).find((p) => p && p.id === 'semilog') || w.PRiSM_semilog.panelSpec;
      assert.ok(spec, 'semilog panel registered for tab 2');
      assert.equal(spec.title, 'Straight-line analysis & skin');
      assert.equal(spec.order, 5);
      assert.fn(spec.render);
      assert.equal(spec.when(), true);
      w.PRiSM = w.PRiSM || {}; w.PRiSM.mode = 'decline';
      assert.equal(spec.when(), false, 'hidden in decline mode');
      assert.ok(Array.from(w.PRiSM_postDrawHooks || []).some((h) => h && h._prismId === 'semilog-line'), 'post-draw hook');
      assert.ok(w.PRiSM_PLOT_REGISTRY && w.PRiSM_PLOT_REGISTRY.mdh, 'mdh plot entry');
      ['PRiSM_semilogAnalysis', 'PRiSM_skinSummary', 'PRiSM_skinDecomposition', 'PRiSM_rateDependentSkin',
        'PRiSM_renderSemilogPanel', 'PRiSM_semilogPlotLine', 'PRiSM_semilog_plot_mdh'].forEach((n) => assert.fn(w[n], n));
      const mine = app.timers().filter((t) => /34-semilog/.test(t.where || ''));
      assert.equal(mine.length, 0, 'WP5 installs no timers');
    },
  },
  {
    name: 'post-draw hook draws the fitted line and window markers on an MDH canvas',
    wp: 'WP5',
    run(app, assert) {
      hideProviders(app);
      app.seedSample();
      const r = app.win.PRiSM_semilogAnalysis();
      const line = app.win.PRiSM_semilogPlotLine('mdh');
      assert.ok(line && isFinite(line.m) && isFinite(line.b));
      assert.near(line.b + line.m * Math.log10(1), r.p1hr, 1e-9, 'p = b + m·log10(Δt)');
      assert.equal(app.win.PRiSM_semilogPlotLine('horner'), null, 'no Horner line for a drawdown');
      const cv = app.document.createElement('canvas');
      cv.width = 600; cv.height = 400;
      const plot = { x: 50, y: 20, w: 500, h: 340 };
      const lx = (v) => plot.x + (Math.log10(v) + 2) / (Math.log10(120) + 2) * plot.w;
      const ly = (v) => plot.y + (4200 - v) / 1400 * plot.h;
      const axes = { toX: lx, toY: ly, plot, scaleX: { min: 0.01, max: 120, kind: 'log' }, scaleY: { min: 2800, max: 4200 }, plotKey: 'mdh' };
      app.win.PRiSM_semilog.postDrawHook({ canvas: cv, plotKey: 'mdh', data: {}, opts: {}, axes });
      const ops = app.canvasLog(cv).map((c) => c.op);
      assert.ok(ops.filter((o) => o === 'lineTo').length >= 4, 'line + two window markers');
      assert.ok(app.canvasTexts(cv).some((s) => /m = 120\.\d psi\/cycle/.test(s)));
      // Other plots are left alone.
      const cv2 = app.document.createElement('canvas');
      app.win.PRiSM_semilog.postDrawHook({ canvas: cv2, plotKey: 'bourdet', data: {}, opts: {}, axes });
      assert.equal(app.canvasLog(cv2).length, 0);
    },
  },

  // ── Integration (needs WP1 C1/C2, WP8 C7 panels, WP6/WP7 plots + hooks) ──
  {
    name: 'integration: default sample through getWell/getAnalysisData matches the plan numbers',
    wp: 'WP5',
    integration: true,
    run(app, assert) {
      app.openPRiSM();
      assert.fn(app.win.PRiSM_getWell, 'WP1 getWell');
      assert.fn(app.win.PRiSM_getAnalysisData, 'WP1 getAnalysisData');
      // WP8 applies the sample metadata on seed; apply it here if it has not.
      if (!Number.isFinite(app.win.PRiSM_getWell().pi)) {
        const patch = { p_res: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5,
          h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil' };
        if (typeof app.win.PRiSM_setWell === 'function') app.win.PRiSM_setWell(patch, { source: 'sample' });
        else {
          const pvt = app.win.PRiSM_pvt;
          pvt.provenance = pvt.provenance || {};
          Object.keys(patch).forEach((k) => { pvt[k] = patch[k]; pvt.provenance[k] = 'sample'; });
        }
      }
      const r = app.win.PRiSM_semilogAnalysis();
      assert.ok(r.ok, r.reason);
      assert.equal(r.method, 'mdh');
      assert.equal(r.pRefSource, 'pi');
      assert.near(r.m, 120.7, 1.5); assert.near(r.k, 45, 1); assert.near(r.S, 2.5, 0.1);
      assert.near(r.dpS, 262, 8); assert.near(r.FE, 0.764, 0.01);
    },
  },
  {
    name: 'integration: synthetic build-up through getAnalysisData → Horner k 45, S 2.5, p* 4200',
    wp: 'WP5',
    integration: true,
    run(app, assert) {
      assert.fn(app.win.PRiSM_getAnalysisData, 'WP1 getAnalysisData');
      const data = syntheticBuildup(app, 24);
      app.win.PRiSM_dataset = app.toWin(data);
      const pvt = app.win.PRiSM_pvt;
      const patch = { testType: 'auto', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil' };
      if (typeof app.win.PRiSM_setWell === 'function') app.win.PRiSM_setWell(patch, { source: 'user' });
      else { pvt.provenance = pvt.provenance || {}; Object.keys(patch).forEach((k) => { pvt[k] = patch[k]; pvt.provenance[k] = 'user'; }); }
      const r = app.win.PRiSM_semilogAnalysis();
      assert.ok(r.ok, r.reason);
      assert.equal(r.testType, 'buildup');
      assert.equal(r.method, 'horner');
      assert.near(r.tp, 24, 0.01);
      assert.near(r.k, 45, 1); assert.near(r.S, 2.5, 0.15); assert.near(r.pStar, 4200, 5);
    },
  },
  {
    name: 'integration: Tab 2 shows the straight-line panel and the MDH plot draws the line',
    wp: 'WP5',
    integration: true,
    run(app, assert) {
      app.openPRiSM();
      app.gotoTab(2);
      app.flush(500);
      assert.ok(app.el('prism_sl_root'), 'panel mounted through the Tab-2 panel registry');
      assert.ok(/Permeability k/.test(app.el('prism_sl_table').innerHTML));
      app.click(app.el('prism_sl_plot'));
      app.flush(200);
      const texts = app.canvases('prism_tab_2').reduce((a, c) => a.concat(app.canvasTexts(c)), []);
      assert.ok(texts.some((s) => /m = 1\d\d\.\d psi\/cycle/.test(s)), 'fitted-line label drawn on the MDH plot');
    },
  },
];
