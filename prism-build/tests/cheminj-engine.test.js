// Chemical Injection (v3.2a) — engine tests for prism-build/49-calc-cheminj.js
// (window.WTS_cheminj and window.WTS_cheminj_compute), docs/CHEMICAL-INJECTION-PLAN.md §7.1:
//   N1–N6 (water, hydrate temperature, depression, methanol loss), N8–N14 and N17 (spread and
//   hydrate design, worked example H1 and its variants), N18 (ppm bases), N24–N28 and N30
//   (pumps), N31 (discharge pressure), N34 (tank), N35 (drive gas), N40 (thermal relief),
//   N42 (engine boundaries), N44 (solver cost by counter), the §7.2 edge cases and the
//   point × chemical × pump loop. N7, V1 and V2 (the isenthalpic solver) are in
//   cheminj-foundation.test.js.
//
//   The engine also carries the gas-phase scavenger line rate, the compatibility pairs and the
//   water carried by aqueous chemicals, so the line results are complete for every chemical
//   in the 3.2a dropdown; their plan fixtures (N19, N20, N29, N37–N39, N43) are checked at the
//   end ("3.2b preview").
//
// Expected values come from the plan's worked examples (§4.13) and §7.1 tolerances; they were
// re-derived independently from the plan's equations before the engine was written.
'use strict';

const WP = 'CHEM';
const J = (x) => JSON.parse(JSON.stringify(x));
const codes = (vs) => Array.from(vs || []).map((v) => v.code);
const GAL_L = 3.785411784;

function E(app) { return app.win.WTS_cheminj; }
function compute(app, inp, opts) { return app.win.WTS_cheminj_compute(inp || {}, opts); }
function okc(assert, r, what) {
  assert.ok(r && r.ok, (what || 'compute') + ' ok' + (r && r.errors ? ': ' + r.errors.join(' | ') : ''));
  return r;
}
// Every number reachable from v is finite (null is allowed: the page shows a dash).
function allFinite(v, path, bad) {
  bad = bad || [];
  if (typeof v === 'number') { if (!isFinite(v)) bad.push(path); return bad; }
  if (v === undefined) { bad.push(path + ' (undefined)'); return bad; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) allFinite(v[k], path + '.' + k, bad);
  return bad;
}
const H1_PUMP = { rate_gal_d: 159.95, pReq: 3550, pRating: 3905, psup: 100, peakF: 2, eta: 0.9, haz: 'yes' };
function pump(app, over) { return E(app).pumpSetting(Object.assign({}, H1_PUMP, over)); }

module.exports = [
  {
    name: 'CHEM engine: window.WTS_cheminj namespace and WTS_cheminj_compute; defaults() reproduce H1; fromIds() maps the cj_* ids',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      assert.ok(C && typeof C === 'object', 'WTS_cheminj');
      ['pvWater', 'waterContent', 'hydrateTemp', 'hydrateCurve', 'depression', 'requiredWt', 'methanolLoss', 'freezePoint', 'spread',
        'hydrateDose', 'doseRate', 'scavRatio', 'scavengerDose', 'pumpSetting', 'pumpOptions', 'nextPlunger', 'injectionPressure',
        'supplyGas', 'calibration', 'fieldCheck', 'tank', 'compat', 'defaults', 'fromIds', 'stats', 'inhKey']
        .forEach((f) => assert.fn(C[f], f));
      assert.fn(app.win.WTS_cheminj_compute, 'WTS_cheminj_compute');
      const d = J(C.defaults());
      assert.strictEqual(d.stream.qg, 10); assert.strictEqual(d.stream.sg, 0.65); assert.strictEqual(d.stream.qw, 2);
      assert.strictEqual(d.spread.sithp, 3500); assert.strictEqual(d.spread.fwhp, 3000); assert.strictEqual(d.spread.pck, 1000);
      assert.strictEqual(d.spread.psvsep, 1440); assert.strictEqual(d.spread.haz, 'yes'); assert.strictEqual(d.spread.supgas, 'air');
      assert.strictEqual(d.basis.margin, 10, 'Q5 margin 10 °F'); assert.strictEqual(d.basis.fJT, 1.10, 'Q17 J-T factor 1.10');
      assert.strictEqual(d.nlines, 1);
      assert.strictEqual(d.lines.length, 6);
      assert.strictEqual(d.lines[0].chem, 'meoh'); assert.strictEqual(d.lines[0].point, 'wh');
      assert.strictEqual(d.lines[0].pump, 'air_liquid', 'Q19 default pump for the hydrate line');
      // fromIds: a flat cj_* map (the page's control ids) → the structured input
      const f = J(C.fromIds({ cj_qg: '12', cj_chem_1: 'meg', cj_lean_1: '80', cj_nlines: '2', cj_pt_2: 'sepin', cj_cal_ml: '72' }));
      assert.strictEqual(f.stream.qg, '12'); assert.strictEqual(f.lines[0].chem, 'meg'); assert.strictEqual(f.lines[0].lean, '80');
      assert.strictEqual(f.nlines, '2'); assert.strictEqual(f.lines[1].point, 'sepin'); assert.strictEqual(f.cal.mL, '72');
      const r = okc(assert, compute(app, C.fromIds({ cj_chem_1: 'meg', cj_lean_1: '80' })), 'fromIds compute');
      assert.strictEqual(r.lines[0].chem, 'meg');
      const e = compute(app, C.fromIds({ cj_qg: '' }));
      assert.strictEqual(e.ok, false, 'blank gas rate is an error');
      assert.ok(Array.from(e.bad).indexOf('cj_qg') !== -1, 'bad carries the control id');
    },
  },
  {
    name: 'CHEM N1/N2: water vapour pressure (Wagner–Pruss) and Bukacek water content, with the extrapolation flag below 60 °F',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      assert.near(C.pvWater(60), 0.2564, 0.0005, 'p_v 60 °F');
      assert.near(C.pvWater(100), 0.9505, 0.0005, 'p_v 100 °F');
      assert.near(C.pvWater(212), 14.71, 0.01, 'p_v 212 °F');
      [[1000, 100, 60.40], [1000, 60, 17.92], [3014.7, 110, 39.18], [1014.7, 34.56, 7.44]].forEach(([p, t, w]) => {
        const r = C.waterContent(p, t);
        assert.ok(r.ok, 'ok ' + p + '/' + t);
        assert.near(r.W_lbMMscf, w, 0.05, 'W ' + p + ' psia / ' + t + ' °F');
      });
      assert.strictEqual(C.waterContent(1000, 100).inRange, true, 'in range');
      const cold = C.waterContent(1014.7, 34.56);
      assert.strictEqual(cold.inRange, false, 'below 60 °F is flagged');
      assert.ok(cold.warnings.length === 1 && /extrapolated/.test(cold.warnings[0]), 'extrapolation warning');
      assert.strictEqual(C.waterContent(0, 100).ok, false, 'p ≤ 0 refused');
    },
  },
  {
    name: 'CHEM N3: hydrate temperature = WTS_hydrate_temp; H2S ppm reaches the gas PVT engines in mol % (20,000 ppm → 2.0, 100,000 → 10)',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = E(app);
      assert.near(C.hydrateTemp(1014.7, 0.65), W.WTS_hydrate_temp(1014.7, 0.65), 1e-12, 'identity');
      assert.near(C.hydrateTemp(1014.7, 0.65), 63.13, 0.01, '63.13 °F at 1014.7 psia');
      assert.near(C.hydrateTemp(1014.7, 0.65, 5), 68.13, 0.01, 'user parallel shift');
      assert.strictEqual(C.ppmToMolPct(20000), 2);
      const seenZ = [], seenI = [];
      const z0 = W.WTS_gaspvt_z, i0 = W.WTS_gaspvt_isenthalpic;
      W.WTS_gaspvt_z = function (a) { const r = z0(a); seenZ.push([a.h2s, r.ok]); return r; };
      W.WTS_gaspvt_isenthalpic = function (a) { const r = i0(a); seenI.push([a.h2s, r.ok]); return r; };
      try {
        const r = okc(assert, compute(app, { stream: { h2s: 20000 } }), 'H1 + 20,000 ppm');
        assert.ok(seenZ.length >= 5 && seenZ.every((s) => s[0] === 2 && s[1] === true), 'WTS_gaspvt_z got 2.0 mol % and ok:true ' + JSON.stringify(seenZ));
        assert.ok(seenI.length >= 2 && seenI.every((s) => s[0] === 2 && s[1] === true), 'WTS_gaspvt_isenthalpic got 2.0 mol % and ok:true');
        assert.ok(r.spread.nodes.every((n) => typeof n.z === 'number'), 'Z at every node');
        seenZ.length = 0;
        okc(assert, compute(app, { stream: { h2s: 100000 } }), 'H2S 100,000 ppm');
        assert.ok(seenZ.length && seenZ.every((s) => s[0] === 10 && s[1] === true), '100,000 ppm → 10 mol %');
      } finally { W.WTS_gaspvt_z = z0; W.WTS_gaspvt_isenthalpic = i0; }
    },
  },
  {
    name: 'CHEM N4/N42: Hammerschmidt through the 25-hydrate key map (methanol 24.32 °F at 25 wt %); ethanol computed locally, never passed to the engine',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = E(app);
      assert.near(C.depression('meoh', 25, 'ham'), W.WTS_hammerschmidt_depression(25, 'methanol'), 1e-12, 'identity');
      assert.near(C.depression('meoh', 25, 'ham'), 24.32, 0.01, '24.32 °F');
      assert.near(C.requiredWt('meoh', 31.73, 'ham').W, 30.31, 0.01, 'meoh via the map');
      assert.near(C.requiredWt('etoh', 31.73, 'ham').W, 38.50, 0.01, 'etoh local M 46.07 (not the methanol 30.31)');
      assert.strictEqual(C.inhKey('meoh'), 'methanol'); assert.strictEqual(C.inhKey('meg'), 'meg');
      assert.strictEqual(C.inhKey('etoh'), null, 'ethanol refused by the key map');
      // N42: spy on the 25-hydrate engines — only their own keys ever arrive.
      const inv0 = W.WTS_hammerschmidt_invert, dep0 = W.WTS_hammerschmidt_depression, keys = [];
      W.WTS_hammerschmidt_invert = function (d, k) { keys.push(k); return inv0(d, k); };
      W.WTS_hammerschmidt_depression = function (w, k) { keys.push(k); return dep0(w, k); };
      try {
        ['meoh', 'etoh', 'meg', 'deg', 'teg'].forEach((k) => { C.requiredWt(k, 30, 'auto'); C.depression(k, 20, 'auto'); });
        okc(assert, compute(app, { lines: [{ chem: 'etoh', lean: 95 }] }), 'ethanol line');
        okc(assert, compute(app, {}), 'methanol line');
        assert.ok(keys.length > 0, 'engine used');
        assert.ok(keys.every((k) => ['methanol', 'meg', 'deg', 'teg'].indexOf(k) !== -1), 'only 25-hydrate keys: ' + Array.from(new Set(keys)).join(','));
      } finally { W.WTS_hammerschmidt_invert = inv0; W.WTS_hammerschmidt_depression = dep0; }
      // γ outside 0.55–1.0: cheminj raises the warning itself (the engine clamps silently).
      const r = okc(assert, compute(app, { stream: { sg: 1.05 } }), 'γ 1.05');
      assert.ok(codes(r.hydrate.verdicts).indexOf('sg_range') !== -1, 'γ ⚠');
    },
  },
  {
    name: 'CHEM N5: Nielsen–Bucklin values and the design rule W = max(Hammerschmidt, NB) with no step near 25 wt %',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      const dT = -129.6 * Math.log(1 - 0.13);
      assert.near(dT, 18.05, 0.005, 'x_I 0.13');
      assert.near(C.requiredWt('meoh', dT, 'nb').W, 21.00, 0.02, 'MeOH 21.00 wt %');
      assert.near(C.requiredWt('meg', dT, 'nb').W, 33.99, 0.02, 'MEG 33.99 wt %');
      assert.near(C.depression('meoh', 28.85, 'nb'), 26.62, 0.02, 'NB 28.85 wt %');
      assert.near(C.depression('meoh', 46.53, 'nb'), 51.62, 0.02, 'NB 46.53 wt %');
      assert.near(C.depression('meoh', 20, 'ham'), 18.24, 0.02); assert.near(C.depression('meoh', 20, 'nb'), 17.05, 0.02);
      assert.near(C.depression('meoh', 25, 'ham'), 24.32, 0.02); assert.near(C.depression('meoh', 25, 'nb'), 22.26, 0.02);
      assert.near(C.depression('meoh', 25, 'auto'), 22.26, 0.02, 'design depression = the smaller');
      let prev = null, maxStep = 0;
      for (let t = 10; t <= 40.0001; t += 0.1) {
        const r = C.requiredWt('meoh', t, 'auto');
        assert.strictEqual(r.methodUsed, 'nb', 'NB is the larger for methanol at ' + t.toFixed(1));
        assert.near(r.W, Math.max(r.W_ham, r.W_nb), 1e-12, 'max rule');
        if (prev != null) maxStep = Math.max(maxStep, r.W - prev);
        prev = r.W;
      }
      assert.ok(maxStep < 0.2, 'no step: largest change per 0.1 °F is ' + maxStep.toFixed(3) + ' wt %');
      const f = C.requiredWt('meoh', 30, 'ham');
      assert.ok(f.warnings.some((w) => /Forced Hammerschmidt/.test(w)), 'forced method warning');
      const deg = C.requiredWt('deg', 30, 'auto');
      assert.strictEqual(deg.methodUsed, 'ham'); assert.strictEqual(deg.W_nb, null, 'DEG: Hammerschmidt only');
      assert.ok(deg.warnings.some((w) => /limited validation/.test(w)), 'DEG ⚠');
    },
  },
  {
    name: 'CHEM N6: methanol K-value express — K 9.614e-4 and 12.81 lb/MMscf at 1000 psia, 10 °F, 25 wt % (V_m 379.48)',
    wp: WP,
    run(app, assert) {
      const r = E(app).methanolLoss(1000, 10, 25, 379.48);
      assert.rel(r.K, 9.614e-4, 0.01, 'K');
      assert.rel(r.lbPerMMscf, 12.81, 0.01, 'lb/MMscf');
      assert.near(r.perMole, 1e6 * 32.04 / 379.48, 1e-6, '84,431 lb/MMscf per mole fraction');
      assert.strictEqual(r.inRange, true);
      assert.strictEqual(E(app).methanolLoss(1000, -20, 25, 379.48).inRange, false, 'below −10 °F flagged');
    },
  },
  {
    name: 'CHEM N8: 7 °F/100 psi rule option gives −30.0 °F for 110 °F and a 2000 psi drop, with the quick-check verdict',
    wp: WP,
    run(app, assert) {
      const s = E(app).spread({ jt: 'rule', fwht: 110, fwhp: 3000, pck: 1000 });
      assert.ok(s.ok);
      const ck = s.nodes.filter((n) => n.key === 'ck')[0];
      assert.near(ck.t_F, -30.0, 1e-9, 'rule T₂');
      assert.strictEqual(ck.tDak_F, null);
      assert.ok(codes(s.verdicts).indexOf('jt_rule') !== -1, 'quick-check verdict');
      assert.includes(s.verdicts.filter((v) => v.code === 'jt_rule')[0].text, 'quick check');
      assert.includes(s.title, '7 °F/100 psi');
    },
  },
  {
    name: 'CHEM N9: H1 hydrate design with the choke temperature fixed at 34.56 °F — ΔT 38.57, X_R 38.14 (Ham 34.58), water, losses, 159.95 gal/d',
    wp: WP,
    run(app, assert) {
      const r = okc(assert, compute(app, { spread: { jt: 'user', tck: 34.56 } }));
      const h = r.lines[0].hydrate;
      assert.strictEqual(h.control.key, 'ck', 'controlling node: downstream of choke');
      assert.near(h.dT, 38.57, 0.05, 'ΔT');
      assert.near(h.XR, 38.14, 0.05, 'X_R (NB)'); assert.strictEqual(h.methodUsed, 'nb');
      assert.near(h.XR_ham, 34.58, 0.05, 'Hammerschmidt reference');
      assert.near(h.x, 0.2574, 0.0005, 'x_MeOH');
      assert.near(h.water.cond, 317.4, 1, 'condensed'); assert.near(h.water.free, 735.4, 0.5, 'free');
      assert.near(h.water.total, 1052.8, 1.5, 'm_W');
      assert.ok(h.water.extrapolated, 'condensed water extrapolated below 60 °F (flagged)');
      assert.near(h.inh.aq, 649.0, 2, 'aqueous'); assert.near(h.inh.vap, 412.5, 3, 'vapour loss');
      assert.rel(h.inh.K, 1.898e-3, 0.005, 'K at the controlling node');
      assert.near(h.inh.solution_lb_d, 1061.5, 5, 'total lb/d');
      assert.near(h.inh.gal_d, 159.95, 0.8, 'gal/d'); assert.near(h.inh.mL_min, 420.5, 2, 'mL/min');
      assert.near(h.inh.rho_lbgal, 6.636, 0.001, 'ρ');
      assert.near(r.lines[0].rate.gal_d, h.inh.gal_d, 1e-9, 'line rate = design rate');
    },
  },
  {
    name: 'CHEM N10: H1 end to end (page defaults, isenthalpic × 1.10) — T₂ 34.56, 1061.5 lb/d, node table and the table title',
    wp: WP,
    run(app, assert) {
      const r = okc(assert, compute(app, {}));
      const nodes = r.spread.nodes, by = {};
      nodes.forEach((n) => { by[n.key] = n; });
      assert.near(by.ck.t_F, 34.56, 0.3, 'design T₂'); assert.near(by.ck.tDak_F, 41.42, 0.3, 'raw DAK');
      assert.strictEqual(by.ck.status, 'bad', 'choke outlet at risk'); assert.near(by.ck.thyd, 63.13, 0.01);
      assert.strictEqual(by.fh.status, 'ok', 'flowhead no risk while flowing'); assert.near(by.fh.thyd, 78.58, 0.01);
      assert.strictEqual(by.sep.status, 'ok', 'heater outlet no risk');
      assert.includes(r.hydrate.title, 'margin 10 °F, J-T × 1.10');
      const L1 = r.lines[0], h = L1.hydrate;
      assert.rel(h.inh.solution_lb_d, 1061.5, 0.03, 'total ±3 %');
      assert.near(L1.rate.L_hr, 25.23, 0.15); assert.near(L1.rate.bbl_d, 3.81, 0.02); assert.near(L1.rate.gal_MMscf, 15.99, 0.1);
      assert.near(h.inh.kg_d, 481.5, 3); assert.near(L1.rate.L_d, 605.5, 3);
      assert.near(h.freezeF, -33.7, 0.3, 'rich-phase freeze point'); assert.ok(codes(h.verdicts).indexOf('freeze') === -1, 'freeze ✓');
      assert.ok(codes(r.hydrate.verdicts).indexOf('node_protected') !== -1, 'choke outlet protected by line 1');
      assert.includes(L1.chip, 'Methanol · Upstream of choke · ');
      assert.includes(L1.chip, 'air 45.6 psig');
      assert.strictEqual(L1.suit.level, 'R');
      assert.ok(r.verdicts[0].code === 'disclaimer' && r.verdicts[0].text.length < 299, 'top-line disclaimer');
      const all = [].concat(r.verdicts, r.hydrate.verdicts, r.summary.verdicts, L1.verdicts);
      all.forEach((v) => { assert.ok(v.text.length < 299, 'verdict < 299 characters: ' + v.code); assert.ok(['ok', 'warn', 'bad'].indexOf(v.level) !== -1); });
      assert.deepStrictEqual(allFinite(J(r.lines), 'lines'), [], 'all line numbers finite');
      const cv = E(app).hydrateCurve(0.65, 0, 4000, 20);
      assert.strictEqual(cv.length, 20); assert.ok(cv[19].t_F > cv[0].t_F, 'hydrate curve rises with pressure');
    },
  },
  {
    name: 'CHEM N11: H1 variants — Hammerschmidt 923.6, all condensed 1107.3, lean 95 wt % 1154.8 lb/d (172.2 gal/d), +20 bbl/d condensate +6.6 lb/d',
    wp: WP,
    run(app, assert) {
      const base = okc(assert, compute(app, {})).lines[0].hydrate;
      const ham = okc(assert, compute(app, { basis: { method: 'ham' } })).lines[0].hydrate;
      assert.near(ham.inh.solution_lb_d, 923.6, 6, 'Hammerschmidt (reference only)');
      assert.ok(ham.warnings.some((w) => /Forced Hammerschmidt/.test(w)), 'forced-method warning');
      const all = okc(assert, compute(app, { basis: { cond: 'all' } })).lines[0].hydrate;
      assert.near(all.inh.solution_lb_d, 1107.3, 5, 'all vapour water condenses');
      const lean = okc(assert, compute(app, { lines: [{ lean: 95 }] })).lines[0].hydrate;
      assert.near(lean.inh.solution_lb_d, 1154.8, 5, 'rigorous lean balance');
      assert.near(lean.inh.gal_d, 172.2, 1, 'lean 95 gal/d');
      const qo = okc(assert, compute(app, { stream: { qo: 20 } })).lines[0].hydrate;
      assert.near(qo.inh.lhc, 6.6, 0.3, 'condensate loss');
      assert.near(0.25 * base.x / E(app).constants.X_REF_30, 0.331, 0.001, 'f_c 0.331 lb/bbl');
      assert.near(qo.inh.solution_lb_d - base.inh.solution_lb_d, 6.6, 0.3, '+6.6 lb/d');
    },
  },
  {
    name: 'CHEM N12: MEG 80 wt % on H1 — X_R 54.42 wt % (NB; Hammerschmidt 46.97), 2240 lb/d, 246.4 gal/d (glycol loss 0)',
    wp: WP,
    run(app, assert) {
      const h = okc(assert, compute(app, { basis: { glyloss: 0 }, lines: [{ chem: 'meg', lean: 80 }] })).lines[0].hydrate;
      assert.near(h.XR, 54.42, 0.05, 'X_R'); assert.near(h.XR_ham, 46.97, 0.05, 'Hammerschmidt');
      assert.near(h.inh.solution_lb_d, 2240, 10, 'lb/d'); assert.near(h.inh.gal_d, 246.4, 1.5, 'gal/d');
      assert.near(h.inh.rho_lbgal, 9.093, 0.002, 'ρ 80 wt %');
      assert.strictEqual(h.inh.vap, 0, 'no vapour loss for glycol');
      const g1 = okc(assert, compute(app, { lines: [{ chem: 'meg', lean: 80 }] })).lines[0].hydrate;
      assert.near(g1.inh.solution_lb_d, h.inh.solution_lb_d * 1.01, 0.01, 'glycol loss allowance 1 %');
    },
  },
  {
    name: 'CHEM N13: practical limits — start-up −26.69 °F needs 67.36 wt % (⚠ marginal); > 70 wt % and the DEG 80 wt % clamp give ✗ and no rate',
    wp: WP,
    run(app, assert) {
      const r = okc(assert, compute(app, {}));
      assert.near(r.spread.startup.t_F, -26.69, 0.5, 'start-up T₂ (design)');
      assert.near(r.spread.startup.tDak_F, -18.81, 0.5, 'start-up raw DAK');
      const su = r.lines[0].hydrate.startup;
      assert.near(su.dT, 99.81, 0.5); assert.near(su.XR, 67.36, 1.0, 'start-up X_R');
      assert.strictEqual(su.level, 'warn'); assert.includes(su.text, 'marginal');
      assert.ok(codes(r.hydrate.verdicts).indexOf('startup_req') !== -1, 'start-up verdict in the hydrate block');
      // Forcing above 70 wt %: user choke temperature −40 °F → ΔT 113 °F → 71.3 wt %
      const hi = okc(assert, compute(app, { spread: { jt: 'user', tck: -40 } })).lines[0];
      assert.ok(hi.hydrate.noRate, 'no rate'); assert.strictEqual(hi.rate.gal_d, 0);
      assert.ok(hi.hydrate.XR > 70, 'X_R ' + hi.hydrate.XR);
      assert.ok(codes(hi.verdicts).indexOf('beyond_range') !== -1 && hi.level === 'bad', '✗ beyond the method range');
      assert.strictEqual(hi.pump.noFlow, true, 'pump block: no flow');
      // DEG at ΔT ≈ 153 °F reaches the Hammerschmidt 80 wt % clamp → out of range, never a clamped rate
      const deg = okc(assert, compute(app, { basis: { margin: 30 }, spread: { jt: 'user', tck: -60 }, lines: [{ chem: 'deg', lean: 90 }] })).lines[0];
      assert.ok(deg.hydrate.noRate && deg.rate.gal_d === 0, 'DEG no rate');
      assert.ok(codes(deg.verdicts).indexOf('beyond_range') !== -1, 'DEG ✗');
      const rq = E(app).requiredWt('deg', 160, 'auto');
      assert.strictEqual(rq.outOfRange, true); assert.ok(rq.W_ham <= 80, 'engine clamp seen');
      assert.near(E(app).requiredWt('deg', 150, 'auto').W, 79.90, 0.01, 'DEG at 150 °F just inside');
    },
  },
  {
    name: 'CHEM N14: shut-in at SITHP — 60 °F: ΔT 30.76, MeOH 32.27, MEG 47.99 (Ham 41.39); 50 °F: ΔT 40.76, MeOH 39.66, MEG 56.01 (Ham 48.34)',
    wp: WP,
    run(app, assert) {
      const m60 = okc(assert, compute(app, {})).lines[0].hydrate.shutin;
      assert.near(m60.dT, 30.76, 0.05); assert.near(m60.XR, 32.27, 0.1); assert.near(m60.XR_ham, 29.65, 0.1);
      const g60 = okc(assert, compute(app, { lines: [{ chem: 'meg', lean: 80 }] })).lines[0].hydrate.shutin;
      assert.near(g60.XR, 47.99, 0.1); assert.near(g60.XR_ham, 41.39, 0.1);
      const m50 = okc(assert, compute(app, { spread: { tamb: 50 } })).lines[0].hydrate.shutin;
      assert.near(m50.dT, 40.76, 0.05); assert.near(m50.XR, 39.66, 0.1);
      const g50 = okc(assert, compute(app, { spread: { tamb: 50 }, lines: [{ chem: 'meg', lean: 80 }] })).lines[0].hydrate.shutin;
      assert.near(g50.XR, 56.01, 0.1); assert.near(g50.XR_ham, 48.34, 0.1);
      assert.strictEqual(g50.level, 'ok', 'MEG 56 wt % is below its 60 wt % ⚠ band');
    },
  },
  {
    name: 'CHEM N17: sour hydrate — 2 mol % H2S raises the margin to 20 °F (⚠); 5 mol % refused (✗, no rate); a user hydrate temperature lifts the refusal',
    wp: WP,
    run(app, assert) {
      const s2 = okc(assert, compute(app, { stream: { h2s: 20000 } }));
      assert.near(s2.spread.margin.used, 20, 1e-9, 'margin 10 + 10');
      assert.near(s2.spread.margin.adder, 10, 1e-9);
      assert.ok(codes(s2.hydrate.verdicts).indexOf('sour_adder') !== -1, 'sour ⚠');
      assert.includes(s2.hydrate.title, 'margin 20 °F');
      assert.ok(s2.lines[0].rate.gal_d > 0, 'rate given');
      const s1 = okc(assert, compute(app, { stream: { h2s: 5000 } }));
      assert.near(s1.spread.margin.used, 15, 1e-9, '0.5 mol %: at least the 5 °F adder');
      const s5 = okc(assert, compute(app, { stream: { h2s: 50000 } }));
      assert.ok(codes(s5.hydrate.verdicts).indexOf('sour_refused') !== -1, '✗ correlation refused');
      assert.ok(s5.lines[0].hydrate.noRate && s5.lines[0].rate.gal_d === 0, 'no rate');
      assert.ok(codes(s5.lines[0].verdicts).indexOf('sour_refused') !== -1, 'line ✗');
      const su = okc(assert, compute(app, { stream: { h2s: 50000 }, basis: { thsrc: 'user', thuser: 80, thuserp: 1000 } }));
      assert.ok(su.lines[0].rate.gal_d > 0, 'user hydrate temperature → rate given');
      const all = [].concat(su.hydrate.verdicts, su.lines[0].verdicts);
      assert.ok(codes(all).indexOf('sour_refused') === -1, 'no ✗');
      assert.near(su.spread.nodes[1].thyd, 80, 0.01, 'user curve passes through 80 °F at 1000 psig');
      const co2 = okc(assert, compute(app, { stream: { co2: 8 } }));
      assert.near(co2.spread.margin.used, 15, 1e-9, 'CO2 > 5 mol %: flat adder');
      const co2x = okc(assert, compute(app, { stream: { co2: 25 } }));
      assert.ok(codes(co2x.hydrate.verdicts).indexOf('sour_refused') !== -1, 'CO2 > 20 mol % refused');
    },
  },
  {
    name: 'CHEM N18: ppm identities (§4.9 table), product vs active ppm, turndown ⚠ on a 10 L/h pump and the host chem-page identity',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      const rows = [
        [{ basis: 'ppmv_liq', dose: 25, qo: 0, qw: 5000 }, 5.25, 13.80],
        [{ basis: 'ppmv_oil', dose: 30, qo: 3000 }, 3.78, 9.94],
        [{ basis: 'ppmw_water', dose: 10, qw: 2000, sgw: 1.05, sgc: 1.20 }, 0.735, 1.93],
        [{ basis: 'ppmv_oil', dose: 5, qo: 3000 }, 0.630, 1.66],
        [{ basis: 'ppmv_oil', dose: 200, qo: 2000 }, 16.8, 44.2],
        [{ basis: 'ppmv_oil', dose: 200, qo: 3000 }, 25.2, 66.2],
        [{ basis: 'pt_mmscf', dose: 1, qg: 20 }, 2.50, 6.57],
        [{ basis: 'ppm_per_ppm_o2', dose: 10, o2: 0.5, qw: 1000, sgw: 1.05, sgc: 1.35 }, 0.163, 0.429],
      ];
      rows.forEach(([inp, gal, ml]) => {
        const r = C.doseRate(inp);
        assert.ok(r.ok, inp.basis);
        assert.near(r.gal_d, gal, gal < 1 ? 0.0005 : 0.005, inp.basis + ' ' + inp.dose + ' gal/d');
        assert.near(r.mL_min, ml, 0.05, inp.basis + ' mL/min (plan values to 3 figures)');
      });
      // Identity with the host chem page: cc/min = BPD × ppm × 158,987 / 1e6 / 1440
      const id = C.doseRate({ basis: 'ppmv_liq', dose: 10, qo: 12000, qw: 0 });
      assert.near(id.gal_d, 5.04, 1e-9);
      assert.near(id.mL_min, 12000 * 10 * 158987 / 1e6 / 1440, 1e-4, 'host chem formula');
      assert.near(id.mL_min, 13.2489, 1e-3);
      // product vs active
      const a = C.doseRate({ basis: 'ppmv_oil', dose: 30, qo: 3000, activePct: 30 });
      assert.near(a.activePpm, 9, 1e-9, 'active ppm = product ppm × active %');
      // l_1e6sm3 / gal_mmscf twins and vol_water on q_w,ctrl
      assert.near(C.doseRate({ basis: 'gal_mmscf', dose: 2, qg: 5 }).gal_d, 10, 1e-9);
      assert.near(C.doseRate({ basis: 'l_1e6sm3', dose: 133.68, qg: 1 }).gal_d, 1.0, 0.001);
      assert.near(C.doseRate({ basis: 'vol_water', dose: 1.5, qw: 100, qwCtrl: 100 }).gal_d, 63.0, 1e-9, 'LDHI 1.5 % of 100 bwpd');
      assert.strictEqual(C.doseRate({ basis: 'wt_water', dose: 10 }).ok, false, 'wt % basis needs the hydrate design');
      // Silicone antifoam 0.630 gal/d on a 10 L/h solenoid pump → turndown ⚠ with a dilution ratio
      const ps = C.pumpSetting({ rate_gal_d: 0.630, pump: 'elec_solenoid', pReq: 100, pRating: 200, peakF: 1.25 });
      assert.ok(codes(ps.verdicts).indexOf('turndown') !== -1, 'turndown ⚠');
      assert.includes(ps.verdicts.filter((v) => v.code === 'turndown')[0].text, 'dilute 1 : 26');
      // Through compute: ppm line on H1 stream (2 bwpd water-soluble corrosion inhibitor at 50 ppm v)
      const r = okc(assert, compute(app, { lines: [{ chem: 'ci_water', point: 'wh', pump: 'elec_solenoid' }] }));
      assert.near(r.lines[0].rate.gal_d, 42 * 2 * 50e-6, 1e-12, 'ppmv_water on the stream');
      assert.strictEqual(r.lines[0].achieved.unit, 'ppm v');
    },
  },
  {
    name: 'CHEM N24/N25: plunger geometry 3/8 × 1 in (0.110447 in³, 1.8099 mL, 0.68850 gal/d per SPM) and 30 gal/d → 48.41 SPM (1/2 in 27.23)',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      const base = { rate_gal_d: 30, pump: 'pneu_plunger', plunger_in: 0.375, stroke_in: 1, heads: 1, pReq: 100, pRating: 200, psup: 100, peakF: 1.25 };
      const g = C.pumpSetting(Object.assign({}, base, { eta: 1 }));
      assert.near(g.Vs_in3, 0.110447, 1e-6); assert.near(g.Vs_mL, 1.8099, 1e-4); assert.near(g.galPerSpm, 0.68850, 1e-5);
      const r = C.pumpSetting(Object.assign({}, base, { eta: 0.9 }));
      assert.near(r.spm, 48.41, 0.01, 'SPM'); assert.near(r.sPerStroke, 1.239, 0.001, 's/stroke'); assert.near(r.per15, 12.10, 0.01, 'strokes per 15 s');
      assert.near(r.del_mL, 1.8099 * 0.9, 1e-4, 'delivered per stroke');
      assert.near(30 * GAL_L * 1000 / 1440, 78.86, 0.01, 'mL/min');
      const h = C.pumpSetting(Object.assign({}, base, { eta: 0.9, plunger_in: 0.5 }));
      assert.near(h.spm, 27.23, 0.01, '1/2 in');
      // ηv auto model (blank): methanol at 4000 psi loses 5.2 % to compressibility
      const auto = C.pumpSetting(Object.assign({}, base, { eta: '', beta: 8.6e-6, pReq: 4000, pRating: 4400 }));
      assert.near(auto.eta, 1 - 8.6e-6 * 4000 * 1.5 - 0.03, 1e-12, 'auto ηv');
    },
  },
  {
    name: 'CHEM N26/N27: calibration (72 mL / 60 s at 48 SPM → 52.58 SPM) and metering settings (40 × 50, 100 × 70, 20 × 15 + turndown; 36 mL/min → 37.04 %)',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      const vs = Math.PI / 4 * 0.375 * 0.375 * 16.387064;
      const c = C.calibration({ mL: 72, s: 60, setting: 48, kind: 'spm', Vs_mL: vs, heads: 1, target_gal_d: 30 });
      assert.near(c.gal_d, 27.39, 0.01); assert.near(c.etaActual, 0.8288, 0.0001); assert.near(c.newSetting, 52.58, 0.01);
      assert.ok(codes(c.verdicts).indexOf('cal_off') !== -1, 'calibration ⚠ (−8.7 %)');
      assert.strictEqual(C.calibration({ mL: 0, s: 60, setting: 48 }).ok, false, 'needs a volume');
      const q = (Lh) => Lh / GAL_L * 24;
      assert.near(q(2), 12.68, 0.01, '2 L/h = 12.68 gal/d');
      const m = (Lh) => C.pumpSetting({ rate_gal_d: q(Lh), pump: 'elec_solenoid', pReq: 100, pRating: 140, peakF: 1.5 });
      const a = m(2);
      assert.near(a.f, 0.2, 1e-9); assert.strictEqual(a.S, 40); assert.near(a.N, 50, 1e-9);
      assert.near(a.pulse, 60, 1e-9, 'pulses/min'); assert.near(a.mLperStroke, 0.556, 0.001, 'mL/stroke');
      assert.ok(a.alt && a.alt.S === 50 && Math.abs(a.alt.N - 40) < 1e-9, 'alternative 50 × 40');
      assert.ok(codes(a.verdicts).indexOf('turndown') === -1, 'no turndown at f 0.2');
      const b = m(7); assert.strictEqual(b.S, 100); assert.near(b.N, 70, 1e-9);
      const t = m(0.3); assert.near(t.f, 0.03, 1e-9); assert.strictEqual(t.S, 20); assert.near(t.N, 15, 1e-9);
      assert.ok(codes(t.verdicts).indexOf('turndown') !== -1, 'turndown ⚠ (0.03 < max(0.10, 0.02))');
      const cal = C.calibration({ mL: 36, s: 60, setting: 40, kind: 'stroke_speed', target_gal_d: q(2) });
      assert.near(cal.newSetting, 37.04, 0.01, 'corrected speed');
      // Air-driven calibration: Q₀ re-fitted to the measurement, new air setting at the target
      const ac = C.calibration({ mL: 420.5, s: 60, setting: 45.6, kind: 'air', pReq: 3550, ratio: 100, target_gal_d: 159.95 });
      assert.ok(ac.ok && ac.q0Refit_gal_d > 0 && Math.abs(ac.newSetting - 45.6) < 0.2, 'air setting re-derived');
    },
  },
  {
    name: 'CHEM N28: H1 pump options — no pneumatic option (4 in 1/2 in 242 %, 4 in 3/4 in 2,276 psig, 8 in 1 in peak 121 %, 8 in duplex 2,560 psig); air-driven first; electric 7/8 in at 39.5 %',
    wp: WP,
    run(app, assert) {
      const C = E(app), P = (o) => pump(app, Object.assign({ pump: 'pneu_plunger', stroke_in: 1, heads: 1 }, o));
      const a = P({ actD_in: 4, plunger_in: 0.5 });
      assert.near(a.spm, 145.2, 0.1); assert.near(a.pct, 242, 1); assert.ok(a.why.indexOf('rate') !== -1 && !a.feasible);
      const b = P({ actD_in: 4, plunger_in: 0.75 });
      assert.near(b.pMax, 2276, 1); assert.ok(b.why.indexOf('pressure') !== -1 && b.why.indexOf('rate') !== -1, '4 in 3/4: pressure and rate');
      const c6 = P({ actD_in: 6, plunger_in: 0.75 });
      assert.near(c6.spm, 64.5, 0.1); assert.near(c6.pct, 107.6, 0.5); assert.near(c6.pMax, 5120, 1); assert.deepStrictEqual(Array.from(c6.why), ['rate']);
      const d = P({ actD_in: 8, plunger_in: 1 });
      assert.near(d.spm, 36.3, 0.1); assert.near(d.pct, 60.5, 0.3); assert.near(d.peakPct, 121, 0.5); assert.deepStrictEqual(Array.from(d.why), ['peak']);
      const e = P({ actD_in: 8, plunger_in: 0.75, heads: 2 });
      assert.near(e.pMax, 4551, 1); assert.ok(e.pOk); assert.near(e.peakPct, 107.6, 0.5); assert.deepStrictEqual(Array.from(e.why), ['peak']);
      const f = P({ actD_in: 8, plunger_in: 1, heads: 2 });
      assert.near(f.pMax, 2560, 1); assert.ok(f.why.indexOf('pressure') !== -1);
      const opt = C.pumpOptions(Object.assign({}, H1_PUMP, { pump: 'air_liquid', all: true }));
      assert.strictEqual(opt.byPump.pneu_plunger.feasible, 0, 'no feasible pneumatic option');
      assert.strictEqual(opt.byPump.pneu_plunger.total, 216, '9 plungers × 4 strokes × 2 heads × 3 actuators');
      assert.strictEqual(opt.ranked[0].pump, 'air_liquid', 'air-driven ranked first (classified area)');
      assert.strictEqual(opt.ranked[1].pump, 'elec_plunger');
      assert.ok(opt.ranked[1].plunger_in === 0.875 && opt.ranked[1].stroke_in === 1 && opt.ranked[1].heads === 1, 'electric 7/8 in simplex next');
      assert.strictEqual(opt.reason, '');
      const air = pump(app, { pump: 'air_liquid' });
      assert.ok(air.feasible, 'air-driven feasible');
      assert.near(air.qAtPreq, 464.4, 1, 'flow at 3550 psig with full air'); assert.near(air.airDesign, 45.6, 0.2, 'air setting');
      assert.near(air.airPeak, 63.9, 0.2, 'peak air'); assert.near(air.cyclesMin, 25.7, 0.1); assert.near(air.cyclesPeak, 51.3, 0.1);
      assert.near(air.pStallDesign, 4560, 10, 'stall at the design setting');
      assert.near(air.pReq / air.stallAvail, 0.355, 0.001, 'P_req / P_stall');
      assert.ok(codes(air.verdicts).indexOf('air_verify') !== -1, 'drawdown / meter verification verdict');
      const el = pump(app, { pump: 'elec_plunger', plunger_in: 0.875, stroke_in: 1, heads: 1 });
      assert.ok(el.feasible); assert.near(el.pct, 39.5, 0.1); assert.near(el.peakPct, 79.0, 0.2); assert.near(el.S, el.pct, 1e-9, 'fixed speed: % stroke');
      assert.near(el.pMax, 4158, 1); assert.near(el.mLperStroke, 3.89, 0.01, 'swept'); assert.near(el.del_mL, 3.50, 0.01, 'delivered');
      assert.near(el.hhp, 0.23, 0.005); assert.near(el.hhpRating, 0.25, 0.005);
      assert.ok(codes(el.verdicts).indexOf('haz_electric') !== -1, 'certified-motor ⚠');
      assert.near(pump(app, { pump: 'elec_plunger', plunger_in: 0.625, stroke_in: 1, heads: 2 }).pct, 38.7, 0.1, 'duplex 5/8');
      assert.near(pump(app, { pump: 'elec_plunger', plunger_in: 0.75, stroke_in: 1, heads: 2 }).pct, 26.9, 0.1, 'duplex 3/4');
      // Through compute: the default line ranks the same way
      const r = okc(assert, compute(app, {}));
      assert.strictEqual(r.lines[0].options.ranked[0].pump, 'air_liquid');
      assert.ok(r.lines[0].options.ranked.length <= 3);
    },
  },
  {
    name: 'CHEM N30 + edges: next plunger (1/4 in at 108.9 SPM ✗ → 3/8 in at 48.4 SPM), below the stable SPM, pump cannot reach pressure, air-driven stall and low flow',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      const n = C.pumpSetting({ rate_gal_d: 30, pump: 'pneu_plunger', plunger_in: 0.25, stroke_in: 1, heads: 1, eta: 0.9, pReq: 1000, pRating: 1100, psup: 100, peakF: 1.25 });
      assert.near(n.spm, 108.9, 0.1); assert.ok(codes(n.verdicts).indexOf('spm_over') !== -1 && !n.feasible, '✗ above the maximum SPM');
      assert.ok(n.nextPlunger && n.nextPlunger.plunger_in === 0.375, 'next plunger 3/8 in');
      assert.near(n.nextPlunger.spm, 48.4, 0.1);
      assert.includes(n.verdicts.filter((v) => v.code === 'spm_over')[0].text, 'Next plunger: 3/8 in at 48.4 SPM');
      assert.strictEqual(C.nextPlunger({ rate_gal_d: 30, pump: 'pneu_plunger', plunger_in: 0.25, stroke_in: 1, eta: 0.9, pReq: 1000, pRating: 1100 }).plunger_in, 0.375);
      const lo = C.pumpSetting({ rate_gal_d: 1, pump: 'pneu_plunger', plunger_in: 1, stroke_in: 1, eta: 0.9, pReq: 100, pRating: 200 });
      assert.ok(codes(lo.verdicts).indexOf('spm_min') !== -1 && lo.verdicts.filter((v) => v.code === 'spm_min')[0].level === 'bad', '✗ below the stable minimum');
      assert.ok(lo.nextPlunger && lo.nextPlunger.plunger_in === 0.1875, 'next smaller plunger 3/16 in');
      const pr = pump(app, { pump: 'pneu_plunger', plunger_in: 0.75, stroke_in: 1, heads: 1, actD_in: 4 });
      const pv = pr.verdicts.filter((v) => v.code === 'pressure')[0];
      assert.ok(pv && pv.level === 'bad', '✗ pump cannot reach');
      assert.includes(pv.text, 'Pump cannot reach 3,905 psig with a 3/4 in plunger (maximum 2,276 psig)');
      assert.includes(pv.text, '1/2 in or less');
      const lf = C.pumpSetting({ rate_gal_d: 50, pump: 'air_liquid', pReq: 1000, pRating: 1100, psup: 100, peakF: 1.25 });
      assert.ok(codes(lf.verdicts).indexOf('air_lowflow') !== -1 && lf.why.indexOf('turndown') !== -1, 'below 0.1 × Q₀: erratic ⚠');
      const st = C.pumpSetting({ rate_gal_d: 100, pump: 'air_liquid', pReq: 7500, pRating: 8250, psup: 100, peakF: 1.25 });
      assert.ok(codes(st.verdicts).indexOf('air_stall') !== -1 && !st.feasible, 'above 0.7 × stall: ✗');
      const none = C.pumpOptions({ rate_gal_d: 5000, pReq: 3550, pRating: 3905, psup: 100, peakF: 2, eta: 0.9, haz: 'yes', pump: 'pneu_plunger' });
      assert.strictEqual(none.ranked.length, 0, 'nothing feasible at 5000 gal/d');
      assert.includes(none.reason, 'rate-limited');
    },
  },
  {
    name: 'CHEM N31: discharge pressure — H1 wh 3550 / 3500 / 3905 (PSV ≥ 3905), dsch 1050 / 1440 / 1584 (PSV ≥ 1440), MAWP 3000 ✗, full-class basis 5500',
    wp: WP,
    run(app, assert) {
      const C = E(app), base = { sithp: 3500, fwhp: 3000, pck: 1000, psep: 1000, psvsep: 1440, whclass: 5000, chem: 'meoh' };
      const wh = C.injectionPressure(Object.assign({ point: 'wh' }, base));
      assert.strictEqual(wh.pReq, 3550); assert.strictEqual(wh.pBack, 3500); assert.near(wh.pRating, 3905, 1e-9); assert.near(wh.psvBand.lo, 3905, 1e-9);
      const ds = C.injectionPressure(Object.assign({ point: 'dsch' }, base));
      assert.strictEqual(ds.pReq, 1050); assert.strictEqual(ds.pBack, 1440); assert.near(ds.pRating, 1584, 1e-9); assert.near(ds.psvBand.lo, 1440, 1e-9);
      const lowM = C.injectionPressure(Object.assign({ point: 'wh', mawp: 3000 }, base));
      const vb = lowM.verdicts.filter((v) => v.code === 'below_sithp')[0];
      assert.ok(vb && vb.level === 'bad'); assert.includes(vb.text, 'below the shut-in wellhead pressure');
      assert.ok(codes(lowM.verdicts).indexOf('psv_band') !== -1 && codes(lowM.verdicts).indexOf('below_rating') !== -1, 'empty PSV band and under-rated');
      const cls = C.injectionPressure(Object.assign({ point: 'wh', rateBasis: 'class' }, base));
      assert.strictEqual(cls.pBack, 5000); assert.near(cls.pRating, 5500, 1e-9);
      const sep = C.injectionPressure(Object.assign({ point: 'sepoil' }, base));
      assert.strictEqual(sep.pReq, 1050); assert.strictEqual(sep.pBack, 1440);
      const tk = C.injectionPressure(Object.assign({ point: 'tank' }, base));
      assert.strictEqual(tk.pReq, 50); assert.strictEqual(tk.pBack, 0); assert.ok(codes(tk.verdicts).indexOf('anti_siphon') !== -1);
      const dh = C.injectionPressure(Object.assign({ point: 'dh' }, base));
      assert.strictEqual(dh.pBack, 3500); assert.ok(dh.warnings.some((w) => /surface figure is a minimum/.test(w)), 'downhole terms not included (3.2b)');
      assert.ok(codes(C.injectionPressure(Object.assign({ point: 'wh' }, base, { sithp: 6000 })).verdicts).indexOf('class') !== -1, 'SITHP above the flowhead class ✗');
      // compute: PSV band upper bound defaults to the pump rating; a line MAWP below SITHP gives the ✗
      const r = okc(assert, compute(app, {}));
      assert.near(r.lines[0].pressure.psvBand.hi, 10000, 1e-9, 'hi = air-driven pump rating');
      const m = okc(assert, compute(app, { lines: [{ mawp: 3000 }] }));
      assert.ok(codes(m.lines[0].verdicts).indexOf('below_sithp') !== -1);
    },
  },
  {
    name: 'CHEM N34 + field check: tote 8.25 d at 30 gal/d, 4 ft tank 3.83 in/d; H1 1.55 d ⚠, 960 gal, 4 totes, 3 changes; 2000 mL cylinder',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      assert.near(C.tank({ V_gal: 275, rate_gal_d: 30 }).days, 8.25, 1e-9);
      assert.near(C.tank({ V_gal: 275, rate_gal_d: 30, diam_ft: 4 }).levelDrop_in_d, 3.83, 0.01);
      const z = C.tank({ V_gal: 275, rate_gal_d: 0 });
      assert.strictEqual(z.days, null); assert.strictEqual(z.totes, 0);
      const r = okc(assert, compute(app, {}));
      const s = r.lines[0].supply;
      assert.near(s.days, 1.55, 0.01); assert.near(s.inventory_gal, 960, 1); assert.strictEqual(s.totes, 4); assert.strictEqual(s.toteChanges, 3);
      assert.ok(codes(r.lines[0].verdicts).indexOf('supply') !== -1, 'supply ⚠ for a 5-day test');
      const f = r.lines[0].field;
      assert.near(f.mL_30s, 210, 1); assert.near(f.mL_60s, 420, 1); assert.near(f.cylNeed_mL, 1051, 2); assert.strictEqual(f.cylinder_mL, 2000);
      assert.near(f.s_per_100mL, 14.27, 0.02);
      assert.near(r.summary.inventory[0].gal_test, s.inventory_gal, 1e-9);
    },
  },
  {
    name: 'CHEM N35: drive gas — set at the shut-in design pressure 35.3 psig, 0.02472 scf/stroke, 1000 scf/d; sour produced gas ✗; instrument air no GHG line; 30 psig supply stalls',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      const base = { kind: 'pneumatic', actD_in: 4, plunger_in: 0.5, stroke_in: 1, heads: 1, spm: 28.10, pdDesign_psig: 1550, psup: 100, h2s_ppm: 50, vm: 379.48 };
      const w = C.supplyGas(Object.assign({ gasType: 'well' }, base));
      assert.near(w.ps_set, 35.3, 0.1); assert.near(w.scf_stroke, 0.02472, 0.00001); assert.near(w.scf_d, 1000, 5); assert.near(w.scf_h, 41.7, 0.2);
      assert.strictEqual(w.regDefault_scf_h, 13.3, 'regulatory default shown for gas drive');
      const sv = w.verdicts.filter((v) => v.code === 'sour_drive')[0];
      assert.ok(sv && sv.level === 'bad', '✗ sour drive gas'); assert.includes(sv.text, '50 ppm H2S');
      assert.near(w.exhaustH2S_lb_d, 0.0045, 0.0001);
      const a = C.supplyGas(Object.assign({ gasType: 'air' }, base));
      assert.strictEqual(a.regDefault_scf_h, null); assert.strictEqual(a.verdicts.length, 0, 'air: no GHG line, no ✗');
      const lo = C.supplyGas(Object.assign({ gasType: 'air' }, base, { psup: 30 }));
      assert.ok(lo.stalls && codes(lo.verdicts).indexOf('gas_stall') !== -1, '✗ stall');
      const sw = C.supplyGas(Object.assign({ gasType: 'well' }, base, { h2s_ppm: 5 }));
      assert.ok(codes(sw.verdicts).indexOf('well_drive') !== -1 && sw.verdicts[0].level === 'warn', 'below 10 ppm: ⚠');
      assert.strictEqual(C.supplyGas({ kind: null }).applies, false, 'electric pumps: no drive gas');
      const un = C.supplyGas({ kind: 'airliquid', airPeak_psig: null, psup: 100, gasType: 'air' });
      assert.ok(un.stalls && un.ps_set === null, 'air-driven peak not reachable at any air pressure → stall');
      assert.includes(un.verdicts.filter((v) => v.code === 'gas_stall')[0].text, 'not reachable');
      const ok = C.supplyGas({ kind: 'airliquid', airPeak_psig: 63.9, psup: 100, gasType: 'air' });
      assert.ok(!ok.stalls && ok.ps_set === 63.9, 'air-driven peak air within the supply');
      // Through compute: S1-like spread, MEA-triazine on a 4 in pneumatic 1/2 × 1 in pump driven by produced gas
      const r = okc(assert, compute(app, {
        stream: { qg: 5, h2s: 50 },
        spread: { sithp: 1500, fwhp: 985, fwht: 100, pck: 300, psep: 285, psvsep: 720, thtr: 100, supgas: 'well' },
        lines: [{ chem: 'h2s_mea_triazine', point: 'wh', pump: 'pneu_plunger', plunger: 0.5, stroke: 1, heads: 1, actd: 4, eff: 0.58 }],
      }));
      const L1 = r.lines[0];
      assert.near(L1.pressure.pReq, 1550, 1e-9); assert.near(L1.pressure.pRating, 1705, 1e-9);
      assert.near(L1.gas.ps_set, 35.3, 0.1); assert.near(L1.gas.scf_d, 1000, 6);
      assert.ok(codes(L1.verdicts).indexOf('sour_drive') !== -1, 'line ✗ sour drive gas');
      const s2 = okc(assert, compute(app, { spread: { supgas: 'well' }, basis: { psup: 30 }, lines: [{ pump: 'air_liquid' }] }));
      assert.ok(codes(s2.lines[0].verdicts).indexOf('gas_stall') !== -1, 'air-driven: peak air above the supply → stall ✗');
    },
  },
  {
    name: 'CHEM N40/N44: thermal relief 77 psi/°F on the line, backflow and thermal ⚠ in the Summary; ≤ 4 isenthalpic solves per calc, 0 on a repeat',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      W.WTS_gaspvt_isenthalpic.clearMemo();
      const r = okc(assert, compute(app, {}));
      const s1 = E(app).stats();
      assert.ok(s1.isenthalpicSolves >= 1 && s1.isenthalpicSolves <= 4, 'solves per calc: ' + s1.isenthalpicSolves);
      okc(assert, compute(app, {}));
      const s2 = E(app).stats();
      assert.strictEqual(s2.isenthalpicSolves, s1.isenthalpicSolves, 'repeat: no new solve (memo)');
      assert.ok(s2.memoHits > s1.memoHits, 'memo hits');
      assert.near(r.lines[0].dPdT_psiF, 77, 1, 'methanol blocked-in rise');
      const sc = codes(r.summary.verdicts);
      assert.ok(sc.indexOf('backflow') !== -1 && sc.indexOf('thermal') !== -1, 'Summary: backflow and thermal relief');
      assert.includes(r.summary.verdicts.filter((v) => v.code === 'thermal')[0].text, '77 psi per °F');
      assert.ok(codes(r.lines[0].verdicts).indexOf('backflow') === -1, 'backflow lives in the Summary, not repeated per line');
      assert.near(r.summary.total_gal_d, r.lines[0].rate.gal_d, 1e-9);
      assert.strictEqual(r.summary.rows.length, 1);
    },
  },
  {
    name: 'CHEM edge cases (§7.2): dry gas, no water, no hydrate risk, q_g 0, H2S 100,000 ppm, cold start-up below −40 °F, γ and methanol-loss ranges, six lines',
    wp: WP,
    run(app, assert) {
      // Zero free water: condensed water only
      const dry = okc(assert, compute(app, { stream: { qw: 0 } })).lines[0].hydrate;
      assert.near(dry.water.total, 317.4, 1, 'm_W = condensed only');
      // No free and no condensed water (no gas): ✓ no inhibitor, rate 0, pump "no flow required"
      const nw = okc(assert, compute(app, { stream: { qw: 0, qg: 0 } })).lines[0];
      assert.ok(codes(nw.verdicts).indexOf('no_water') !== -1, '✓ no water'); assert.strictEqual(nw.rate.gal_d, 0);
      assert.strictEqual(nw.pump.noFlow, true); assert.strictEqual(nw.pump.whyText, 'no flow required');
      // No hydrate risk on the flowing nodes
      const nr = okc(assert, compute(app, { spread: { jt: 'user', tck: 100, tamb: 100 } }));
      assert.ok(codes(nr.hydrate.verdicts).indexOf('no_risk') !== -1, '✓ no hydrate risk');
      assert.includes(nr.hydrate.verdicts.filter((v) => v.code === 'no_risk')[0].text, 'with a 10 °F margin');
      assert.ok(codes(nr.lines[0].verdicts).indexOf('not_required') !== -1 && nr.lines[0].rate.gal_d === 0, '⚠ line not required');
      // q_g = 0: gas-basis line ✗, liquid line still works
      const q0 = okc(assert, compute(app, { stream: { qg: 0 }, nlines: 2, lines: [{ chem: 'ci_gas', pump: 'elec_solenoid' }, { chem: 'ci_water', pump: 'elec_solenoid' }] }));
      assert.ok(codes(q0.lines[0].verdicts).indexOf('needs_gas') !== -1, 'gas-basis ✗');
      assert.ok(q0.lines[1].rate.gal_d > 0, 'liquid line works');
      // H2S 100,000 ppm: correlation refused unless a user hydrate temperature
      const hs = okc(assert, compute(app, { stream: { h2s: 100000 } }));
      assert.ok(codes(hs.hydrate.verdicts).indexOf('sour_refused') !== -1);
      // Very cold start-up: clamped / range warnings, Z still returned
      const s = E(app).spread({ tamb: -60, sithp: 15000, fwhp: 3000, pck: 100, psep: 100 });
      assert.ok(s.ok, 'cold start-up spread');
      assert.finite(s.startup.t_F); assert.ok(s.startup.t_F < -40, 'start-up below −40 °F: ' + s.startup.t_F.toFixed(1));
      assert.ok(s.warnings.some((w) => /^Start-up:/.test(w)), 'start-up range warnings');
      assert.ok(typeof s.startup.z === 'number', 'WTS_gaspvt_z still returns Z');
      // Methanol vapour-loss range: controlling node colder than −10 °F
      const cold = okc(assert, compute(app, { spread: { jt: 'user', tck: -20 } })).lines[0].hydrate;
      assert.ok(cold.warnings.some((w) => /outside its range/.test(w)), 'methanol-loss range warning');
      assert.ok(cold.inh.gal_d > 0, 'value still computed');
      // Injection downstream of the first at-risk node / choke body not protected
      const late = okc(assert, compute(app, { lines: [{ point: 'sepin' }] })).lines[0];
      assert.ok(codes(late.verdicts).indexOf('downstream_of_risk') !== -1 && late.level === 'bad', '✗ move it upstream');
      const ds = okc(assert, compute(app, { lines: [{ point: 'dsch' }] })).lines[0];
      assert.ok(codes(ds.verdicts).indexOf('choke_unprotected') !== -1, '⚠ choke body not protected');
      // Six lines on, all finite; back to one
      const six = okc(assert, compute(app, { nlines: 6 }));
      assert.strictEqual(six.lines.length, 6);
      assert.deepStrictEqual(allFinite(J(six.lines), 'lines'), []);
      assert.strictEqual(okc(assert, compute(app, { nlines: 1 })).lines.length, 1);
      // Text formatters can be replaced (the page passes Metric ones)
      const mf = okc(assert, compute(app, {}, { fmt: { pSet: (v) => (v * 6.894757).toFixed(0) + ' kPa(g)' } }));
      assert.includes(mf.lines[0].chip, 'kPa(g)');
      assert.includes(okc(assert, compute(app, {})).lines[0].chip, 'psig', 'formatters restored after the call');
    },
  },
  {
    name: 'CHEM edge sweep: blank / 0 / −1 / 1e12 in every numeric input never throws — either finite results or an error list naming the cj_* control',
    wp: WP,
    run(app, assert) {
      const C = E(app), ids = C.ids;
      const sections = { stream: ids.stream, spread: ids.spread, basis: ids.basis };
      const numeric = (s, k) => typeof C.defaults()[s][k] === 'number' || C.defaults()[s][k] === '';
      let n = 0;
      Object.keys(sections).forEach((s) => {
        Object.keys(sections[s]).filter((k) => numeric(s, k) && ['whclass'].indexOf(k) === -1).forEach((k) => {
          ['', 0, -1, 1e12].forEach((val) => {
            const inp = {}; inp[s] = {}; inp[s][k] = val;
            let r;
            assert.doesNotThrow(() => { r = compute(app, inp, { noOptions: true }); }, s + '.' + k + ' = ' + val);
            n++;
            if (r.ok) assert.deepStrictEqual(allFinite(J(r.lines), s + '.' + k + '=' + val), [], 'finite');
            else {
              assert.ok(r.errors.length > 0, 'error list');
              assert.ok(Array.from(r.bad).some((b) => /^cj_/.test(b)), s + '.' + k + ' = ' + val + ' names a control: ' + Array.from(r.bad).join(','));
            }
          });
        });
      });
      const lineNum = ['dose', 'lean', 'sgc', 'eff', 'qrated', 'pmax', 'q0', 'ratio', 'vcyc', 'tank', 'active', 'water', 'peak', 've', 'spmmax', 'rod', 'dpq', 'mawp', 'o2'];
      ['air_liquid', 'pneu_plunger', 'elec_plunger', 'elec_hyd_diaph'].forEach((pk) => {
        lineNum.forEach((k) => {
          ['', 0, -1, 1e12].forEach((val) => {
            const l = { pump: pk }; l[k] = val;
            let r;
            assert.doesNotThrow(() => { r = compute(app, { lines: [l] }, { noOptions: true }); }, 'line ' + k + ' = ' + val);
            n++;
            if (r.ok) assert.deepStrictEqual(allFinite(J(r.lines), 'line.' + k + '=' + val), [], 'finite');
            else assert.ok(r.errors.length > 0 && Array.from(r.bad).some((b) => /_1$/.test(b)), 'line error names a cj_*_1 control: ' + k + '=' + val);
          });
        });
      });
      assert.ok(n > 300, 'cases ' + n);
      // Selects with an unknown option are errors, never a throw
      const bad = compute(app, { spread: { jt: 'nope' } });
      assert.strictEqual(bad.ok, false); assert.ok(Array.from(bad.bad).indexOf('cj_jt') !== -1);
      const pck = compute(app, { spread: { pck: 4000 } });
      assert.strictEqual(pck.ok, false); assert.ok(Array.from(pck.bad).indexOf('cj_pck') !== -1, 'P_ck above FWHP');
      const cal = okc(assert, compute(app, { cal: { line: 1, mL: 420.5, s: 60, setting: 45.6 } }));
      assert.ok(cal.calibration && cal.calibration.line === 1 && Math.abs(cal.calibration.withinPct) < 1, 'calibration card on line 1');
    },
  },
  {
    name: 'CHEM loop: every point × chemical × pump (9 × 30 × 8 = 2,160) gives finite output from WTS_cheminj_compute with one precomputed spread',
    wp: WP,
    run(app, assert) {
      const W = app.win, L = W.WTS_chemlib;
      const sp = okc(assert, compute(app, {})).spread;
      W.WTS_gaspvt_isenthalpic.clearMemo();
      let n = 0;
      const fails = [];
      L.pointKeys.forEach((pt) => L.chemicals.forEach((c) => L.pumps.forEach((p) => {
        const r = W.WTS_cheminj_compute({ precomputed: { spread: sp }, lines: [{ point: pt, chem: c.key, pump: p.key, dose: c.key === 'custom' ? 10 : undefined }] }, { noOptions: true });
        n++;
        if (!r.ok) { fails.push(pt + '/' + c.key + '/' + p.key + ': ' + r.errors[0]); return; }
        const b = allFinite(J(r.lines[0]), 'line');
        if (b.length) fails.push(pt + '/' + c.key + '/' + p.key + ': ' + b.slice(0, 3).join(','));
        if (!r.lines[0].verdicts.every((v) => v.text.length < 299)) fails.push(pt + '/' + c.key + '/' + p.key + ': long verdict');
      })));
      assert.strictEqual(n, 2160);
      assert.deepStrictEqual(fails.slice(0, 10), [], fails.length + ' failing cases');
      assert.strictEqual(E(app).stats().isenthalpicSolves, 0, 'the precomputed spread needs no solve');
      // Pump options for every point × pump type (finite ranking, at most 3)
      L.pointKeys.forEach((pt) => L.pumps.forEach((p) => {
        const r = W.WTS_cheminj_compute({ precomputed: { spread: sp }, lines: [{ point: pt, chem: 'meoh', pump: p.key }] });
        assert.ok(r.ok && r.lines[0].options && r.lines[0].options.ranked.length <= 3, pt + '/' + p.key);
        assert.deepStrictEqual(allFinite(J(r.lines[0].options), 'options'), []);
      }));
    },
  },
  {
    name: 'CHEM 3.2b preview — scavenger N19/N20/N29/N43: R_th 0.8691, R 1.4984; S1 20.656 lb/d = WTS_h2s_scavenger, 30.95 gal/d, 28.10 SPM; guards',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = E(app);
      const sr = C.scavRatio({ mw: 219.28, nH2S: 2, activePct: 40, sg: 1.11, eff: 0.58 });
      assert.near(sr.theo_galPerLb, 0.8691, 0.0005); assert.near(sr.galPerLb, 1.4984, 0.001); assert.near(sr.lbProdPerLb, 13.9, 0.05);
      const r = okc(assert, compute(app, {
        stream: { qg: 5, h2s: 50 },
        spread: { sithp: 1500, fwhp: 985, fwht: 100, pck: 300, psep: 285, psvsep: 720, thtr: 100 },
        lines: [{ chem: 'h2s_mea_triazine', point: 'wh', pump: 'pneu_plunger', plunger: 0.5, stroke: 1, heads: 1, actd: 4, eff: 0.58 }],
      }));
      const L1 = r.lines[0];
      const ref = W.WTS_h2s_scavenger(5, 50, 4, sr.galPerLb);
      assert.near(L1.scav.removed_lb_d, 20.656, 0.005); assert.near(L1.scav.removed_lb_d, ref.lb_d, 1e-9, '= WTS_h2s_scavenger');
      assert.near(L1.rate.gal_d, 30.95, 0.05); assert.near(L1.rate.mL_min, 81.4, 0.2);
      assert.near(L1.pump.spm, 28.10, 0.01); assert.near(L1.pump.pct, 46.8, 0.1); assert.near(L1.pump.spmPeak, 42.1, 0.1);
      assert.ok(L1.pump.feasible, '1/2 × 1 in feasible');
      const s38 = C.pumpSetting({ rate_gal_d: L1.rate.gal_d, pump: 'pneu_plunger', plunger_in: 0.375, stroke_in: 1, heads: 1, actD_in: 4, eta: 0.9, pReq: 1550, pRating: 1705, peakF: 1.5 });
      assert.near(s38.spm, 49.95, 0.05); assert.ok(!s38.feasible && s38.why.indexOf('peak') !== -1, '3/8 in infeasible at peak');
      const ck = r.spread.nodes[1];
      assert.near(ck.t_F, 59.90, 0.3, 'S1 choke outlet design'); assert.near(ck.thyd, 46.51, 0.05);
      assert.ok(codes(L1.verdicts).indexOf('aq_hydrate') === -1, 'no hydrate risk: no THI cross-check');
      // Guards (N43)
      assert.ok(codes(C.scavengerDose({ qg: 5, yin: 0, yout: 4, galPerLb: 1.5 }).verdicts).indexOf('no_h2s') !== -1);
      assert.strictEqual(C.scavengerDose({ qg: 5, yin: 0, yout: 4, galPerLb: 1.5 }).gal_d, 0);
      assert.ok(codes(C.scavengerDose({ qg: 5, yin: 4, yout: 4, galPerLb: 1.5 }).verdicts).indexOf('below_target') !== -1);
      assert.ok(codes(C.scavengerDose({ qg: 0, yin: 50, yout: 4, galPerLb: 1.5 }).verdicts).indexOf('needs_gas') !== -1);
      const low = okc(assert, compute(app, { stream: { qg: 5, h2s: 50 }, lines: [{ chem: 'h2s_mea_triazine', pump: 'pneu_plunger', eff: 0.05 }] })).lines[0];
      assert.ok(codes(low.verdicts).indexOf('eff_clamped') !== -1, 'η clamped ⚠'); assert.near(low.ratio.eff, 0.087, 0.0005);
      assert.ok(codes(low.verdicts).indexOf('engine') === -1, 'no engine error text');
    },
  },
  {
    name: 'CHEM 3.2b preview — N39 water from aqueous chemicals (+171.8 lb/d → 1167.4 lb/d) and the ⚠ without a THI line; N37/N38 compatibility and suitability',
    wp: WP,
    run(app, assert) {
      const C = E(app);
      const sp = C.spread({});
      const lb = 30.95 * 8.337 * 1.11 * 0.60;
      assert.near(lb, 171.8, 0.05);
      const h = C.hydrateDose({ spread: sp, chem: 'meoh', point: 'wh', qg: 10, qw: 2, sgw: 1.05, otherWater: [{ point: 'wh', lb_d: lb }] });
      assert.near(h.water.other, 171.8, 0.5); assert.near(h.water.total, 1224.7, 1.5); assert.near(h.inh.solution_lb_d, 1167.4, 5); assert.near(h.inh.gal_d, 175.9, 1);
      const late = C.hydrateDose({ spread: sp, chem: 'meoh', point: 'wh', qg: 10, qw: 2, sgw: 1.05, otherWater: [{ point: 'sepin', lb_d: lb }] });
      assert.near(late.water.other, 0, 1e-12, 'water injected downstream of the controlling node is not counted');
      // Through compute: the triazine line's water feeds the methanol design
      const r = okc(assert, compute(app, { stream: { h2s: 50 }, nlines: 2, lines: [{}, { chem: 'h2s_mea_triazine', point: 'wh', pump: 'pneu_plunger' }] }));
      const tri = r.lines[1];
      assert.near(r.lines[0].hydrate.water.other, tri.rate.gal_d * 8.337 * 1.11 * 0.60, 1e-6, 'other water = V·8.337·SG·w');
      const alone = okc(assert, compute(app, { stream: { h2s: 50 }, lines: [{ chem: 'h2s_mea_triazine', point: 'wh', pump: 'pneu_plunger' }] })).lines[0];
      const aq = alone.verdicts.filter((v) => v.code === 'aq_hydrate')[0];
      assert.ok(aq, '⚠ without a THI line'); assert.includes(aq.text, 'can form hydrate or ice');
      // N37
      const c1 = C.compat([{ chem: 'h2s_nitrite', point: 'sepwat' }, { chem: 'h2s_mea_triazine', point: 'sepwat' }]);
      assert.ok(c1.some((v) => v.level === 'bad' && /must never share a line or tank/.test(v.text)), 'oxidiser ✗');
      const c2 = C.compat([{ chem: 'meoh', point: 'wh' }, { chem: 'si_phosphonate', point: 'wh' }]);
      assert.ok(c2.some((v) => v.code === 'compat_methanol_si' && v.level === 'warn'), 'methanol / scale inhibitor ⚠');
      const c3 = C.compat([{ chem: 'h2s_peroxide', point: 'tank' }]);
      assert.ok(c3.some((v) => v.code === 'compat_oxidiser_hc_tank'), 'O2 evolution ⚠');
      assert.strictEqual(C.compat([{ chem: 'meoh', point: 'wh' }, { chem: 'si_phosphonate', point: 'dsch' }]).length, 0, 'different points: no pair rule');
      // N38 (suitability through compute; rate stays finite)
      const S = (pt, ch) => okc(assert, compute(app, { lines: [{ point: pt, chem: ch, pump: 'elec_solenoid' }] })).lines[0];
      const a = S('dh', 'h2s_mea_triazine'); assert.strictEqual(a.suit.level, 'N'); assert.ok(codes(a.verdicts).indexOf('suit_N') !== -1);
      const b = S('wh', 'h2s_nitrite'); assert.strictEqual(b.suit.level, 'X'); assert.strictEqual(b.level, 'bad');
      const c = S('sepgas', 'af_silicone'); assert.strictEqual(c.suit.level, 'X');
      const d = S('tank', 'h2s_nitrite'); assert.strictEqual(d.suit.level, 'N'); assert.finite(d.rate.gal_d);
      assert.ok(codes(d.verdicts).indexOf('oxidiser_block') !== -1 && codes(d.verdicts).indexOf('nitrite_nox') !== -1, 'oxidiser rules');
      // Compatibility reaches the Summary through compute
      const cs = okc(assert, compute(app, { nlines: 2, lines: [{}, { chem: 'si_phosphonate', point: 'wh', pump: 'elec_solenoid' }] }));
      assert.ok(codes(cs.summary.verdicts).indexOf('compat_methanol_si') !== -1, 'Summary compatibility verdict');
    },
  },
];
