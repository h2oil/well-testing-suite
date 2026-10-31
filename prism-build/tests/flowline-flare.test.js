// Flowline page (route `flowline`, prism-build/49-calc-flowline.js): boundaries of a well-test spread.
//
//   • The separator gas PCV holds the separator pressure, so the gas line to the flare starts
//     DOWNSTREAM of the PCV: it is marched back from the flare tip (14.696 psia + tip pressure drop)
//     to the PCV outlet, and the PCV takes Psep − P_out (isenthalpic, choked below the critical ratio).
//   • The well line is marched back from the separator pressure to the choke outlet (P2); the choke
//     takes WHP − P2 and WHP < P2 means the well cannot deliver the rate.
//
// Expected values are independent of the module:
//   * Flare line: the isothermal general flow equation with the kinetic-energy term,
//       p1² − p2² = (G²/gc)·(Z·R·T/M)·[f·L/D + 2·ln(p1/p2)]
//     (e.g. Menon, "Gas Pipeline Hydraulics", 2005, §2; Coulson & Richardson Vol. 1, §4.5), Z and μ at the
//     mean pressure p̄ = ⅔(p1 + p2 − p1p2/(p1 + p2)), f = Colebrook by bisection; and an RK4 integration of
//     dp/dx = −[f·ρ·v²/(2·gc·D)]/(1 − ρ·v²/(gc·p)) with Z(p), μ(p) at every point.
//   * Mach = v/c with v = ṁ/(ρ·A) typed here, c from the Gas PVT engine (and √(k·gc·R·T/M) as a cross-check).
//   * Joule–Thomson: μJT = R·T²·(∂Z/∂T)p/(p·Cp) evaluated in SI units here; magnitude against the
//     "7 °F per 100 psi" rule for natural gas (GPSA Sect. 20).
//   * Critical ratios (2/(k+1))^(k/(k−1)) and Gilbert's 0.588 typed here.
'use strict';

const WP = 'FLARE';
const LG = Math.log10;
const PATM = 14.696;

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, label, nth) {
  const r = rows(app, 'fl_res').find((x) => x.l === label);
  if (!r) throw new Error('no result row "' + label + '": ' + JSON.stringify(rows(app, 'fl_res').map((x) => x.l)));
  const nums = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (!nums || nums[nth || 0] == null) throw new Error('row "' + label + '" has no number: ' + r.v);
  return parseFloat(nums[nth || 0]);
}
function rtext(app, label) { const r = rows(app, 'fl_res').find((x) => x.l === label); return r ? r.v : null; }
function resText(app) { return String(app.el('fl_res').textContent || ''); }
function noBad(assert, app, where) {
  assert.ok(!/NaN|Infinity|undefined|\[object/.test(String(app.el('pgBody').textContent || '')), where + ': NaN/Infinity/undefined on page');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="flowline"]');
  if (!b) throw new Error('no flowline nav button');
  app.click(b);
  if (!app.el('fl_root')) throw new Error('flowline page did not render');
}
const calc = (app) => app.click('fl_calc');
const S = (app) => app.win.WTS_state.flowline;
function colebrookBisect(re, e) {
  if (re < 2000) return 64 / re;
  let lo = 1e-4, hi = 0.2;
  const g = (f) => 1 / Math.sqrt(f) + 2 * LG(e / 3.7 + 2.51 / (re * Math.sqrt(f)));
  for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (g(lo) * g(m) <= 0) hi = m; else lo = m; }
  return (lo + hi) / 2;
}
// Sutton pseudo-criticals, typed here.
const sutton = (sg) => ({ Tpc: 169.2 + 349.5 * sg - 74 * sg * sg, Ppc: 756.8 - 131 * sg - 3.6 * sg * sg });

// The task's hand case: 5 MMscf/d of 0.65 gas from a 250 psig / 100 °F separator, 300 ft + 200 ft of
// 3.826 in (4 in Sch 40) to the flare tip, horizontal.
const GAS5 = { qo: 0, qw: 0, qg: 5, api: 35, sgg: 0.65, sgw: 1.0, pwh: 600, t0: 100, t1: 100, psep: 250, rough: 0.0018, payne: true, accel: true,
  well: [{ name: 'Choke to separator', len: 100, id: 3.826, dz: 0 }],
  flare: [{ name: 'PCV to knock-out drum', len: 300, id: 3.826, dz: 0 }, { name: 'Flare line', len: 200, id: 3.826, dz: 0 }] };
// Isenthalpic expansion T(p) of the separator gas (dT/dp = μJT, Gas PVT state), RK4 with 400 steps from
// (p1 psia, t1 °F) down to pLo psia, tabulated; linear between nodes.
function isenthTable(W, sg, p1, t1, pLo) {
  const n = 400, h = (pLo - p1) / n, ps = [p1], ts = [t1], mu = (pp, tt) => W.WTS_gaspvt_state(sg, pp, tt).muJT;
  let T = t1, q = p1;
  for (let k = 0; k < n; k++) {
    const k1 = mu(q, T), k2 = mu(q + h / 2, T + h * k1 / 2), k3 = mu(q + h / 2, T + h * k2 / 2), k4 = mu(q + h, T + h * k3);
    T += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6; q += h; ps.push(q); ts.push(T);
  }
  return (p) => {
    if (p >= p1) return t1;
    const j = Math.min(n - 1, Math.floor((p - p1) / h));
    return ts[j] + (ts[j + 1] - ts[j]) * (p - ps[j]) / (ps[j + 1] - ps[j]);
  };
}
// Flare line hand calculation. Tf(p) = gas temperature (°F) at pressure p psia: the adiabatic line follows the
// isenthalpic expansion from the separator (a constant function gives the isothermal line).
function flareHand(L, Tf, qg) {
  const sg = 0.65, D = 3.826 / 12, A = Math.PI * D * D / 4, Lt = 500, pc = sutton(sg), M = 28.9647 * sg;
  const mdot = (qg || 5) * 1e6 / (10.7316 * 519.67 / PATM) * M / 86400, G = mdot / A;      // lb/s, lb/ft²·s
  const zmu = (p) => { const T = Tf(p), TR = T + 459.67, z = L.Z_dranchukAbouKassem(TR / pc.Tpc, p / pc.Ppc); return { z, mu: L.mu_g_leeGonzalezEakin(sg, T, z, p), TR }; };
  const p2 = PATM + 1.5;
  // General flow equation with the kinetic-energy term, Z, μ and T at the mean pressure
  let p1 = 50;
  for (let it = 0; it < 60; it++) {
    const pav = (2 / 3) * (p1 + p2 - p1 * p2 / (p1 + p2)), q = zmu(pav);
    const f = colebrookBisect(1488 * G * D / q.mu, 0.0018 / 3.826);
    const K = G * G / 32.174 * q.z * 1545.35 * q.TR / M / (144 * 144);            // psi²
    p1 = Math.sqrt(p2 * p2 + K * (f * Lt / D + 2 * Math.log(p1 / p2)));
  }
  // RK4 against the flow, Z(p), μ(p) and T(p) at every point
  const dpdx = (p) => {
    const q = zmu(p), rho = p * M / (q.z * 10.7316 * q.TR), v = G / rho;
    const f = colebrookBisect(1488 * rho * v * D / q.mu, 0.0018 / 3.826);
    return (f * rho * v * v / (2 * 32.174 * D) / 144) / (1 - rho * v * v / (32.174 * p * 144));
  };
  let p = p2; const h = 0.5;
  for (let x = 0; x < Lt - 1e-9; x += h) {
    const k1 = dpdx(p), k2 = dpdx(p + h * k1 / 2), k3 = dpdx(p + h * k2 / 2), k4 = dpdx(p + h * k3);
    p += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
  }
  const q2 = zmu(p2), rho2 = p2 * M / (q2.z * 10.7316 * q2.TR), v2 = G / rho2;
  return { gfe: p1 - PATM, rk4: p - PATM, vTip: v2, rhoTip: rho2, M, TR: q2.TR, tTip: Tf(p2), G, A };
}

module.exports = [
  {
    name: 'FLARE hand calculation: PCV outlet back-pressure = general flow equation and RK4 marched back from the tip (5 MMscf/d, 0.65, 300 + 200 ft of 3.826 in)',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = W.WTS_flowline_compute, L = W.PRiSM_pvt_correlations;
      const r = C(GAS5);
      assert.ok(r.ok, JSON.stringify(r.errors));
      const f = r.flare;
      assert.ok(f && !f.lost && !f.chokedExit, 'flare line computed');
      // Linear temperature model: the flare line is adiabatic, so the gas keeps expanding isenthalpically from
      // the separator to the tip (it was held at the PCV outlet temperature before, which left out the further
      // Joule–Thomson cooling to the tip). Hand: RK4 of dT/dp = μJT from 264.696 psia / 100 °F.
      const Th = isenthTable(W, 0.65, 250 + PATM, 100, 15);
      assert.near(f.segments[0].tIn, r.pcv.tOut, 1e-3, 'line starts at the PCV outlet temperature');
      f.segments.forEach((s) => {
        assert.near(s.tIn, Th(s.pIn + PATM), 0.02, s.name + ' inlet T on the isenthalpic curve');
        assert.near(s.tOut, Th(s.pOut + PATM), 0.02, s.name + ' outlet T on the isenthalpic curve');
        assert.ok(s.tOut < s.tIn, 'the gas cools along ' + s.name);
      });
      assert.within(r.pcv.tOut - f.segments[1].tOut, 1.5, 3.5, 'μJT × (P_out − P_tip) ≈ 0.07 × 36 psi more cooling to the tip');
      assert.near(r.flareCheck.tMin, f.segments[1].tOut, 1e-9, 'coldest at the tip');
      const hd = flareHand(L, (p) => Th(p));
      assert.within(hd.gfe, 30, 45, 'hand back-pressure ≈ 38 psig');
      assert.rel(r.pcv.pOut, hd.gfe, 2e-3, 'general flow equation ' + hd.gfe.toFixed(3) + ' psig');
      assert.rel(r.pcv.pOut, hd.rk4, 1e-4, 'RK4 ' + hd.rk4.toFixed(3) + ' psig');
      // The temperature matters at this level: an isothermal line at the PCV outlet temperature gives a
      // back-pressure ≈ 0.2 % higher (the colder gas near the tip is denser and slower).
      const iso = flareHand(L, () => r.pcv.tOut);
      assert.ok(iso.rk4 > hd.rk4 && iso.rk4 - hd.rk4 < 0.01 * hd.rk4, 'isothermal ' + iso.rk4.toFixed(3) + ' vs adiabatic ' + hd.rk4.toFixed(3));
      // Boundaries and continuity, presented in the flow direction
      assert.rel(f.pOut, 1.5, 1e-12, 'tip = atmosphere + 1.5 psi');
      assert.rel(f.pIn, r.pcv.pOut, 1e-12);
      assert.rel(f.dp, r.pcv.pOut - 1.5, 1e-9);
      assert.rel(f.segments[0].pIn, f.pIn, 1e-12); assert.rel(f.segments[0].pOut, f.segments[1].pIn, 1e-12); assert.rel(f.segments[1].pOut, 1.5, 1e-9);
      f.segments.forEach((s) => assert.rel(s.dpEl + s.dpF + s.dpAcc, s.dp, 1e-6, s.name + ' components'));
      assert.ok(f.segments[1].dpAcc > 0.05 * f.segments[1].dp, 'acceleration matters near the tip');
      for (let k = 1; k < f.profile.length; k++) assert.ok(f.profile[k].x >= f.profile[k - 1].x && f.profile[k].p <= f.profile[k - 1].p + 1e-9, 'profile in flow order');
      // The flare line always includes acceleration (the well line's option does not apply to it)
      assert.strictEqual(C(Object.assign({}, GAS5, { accel: false })).pcv.pOut, r.pcv.pOut, 'flare line ignores the acceleration option');
      // The old model (march from the separator pressure) would have put 250 psig at the PCV outlet
      assert.ok(r.pcv.pOut < 0.2 * r.psep, 'flare header is far below the separator pressure');
      // Tip pressure drop input moves the whole profile
      const r2 = C(Object.assign({}, GAS5, { dptip: 5 }));
      assert.rel(r2.flare.pOut, 5, 1e-12);
      // p1² − p2² is nearly fixed by the flow: a 3.5 psi higher tip pressure adds only ≈ 1.2 psi at the PCV
      assert.within(r2.pcv.pOut - r.pcv.pOut, 0.5, 3.5, 'higher tip drop → higher back-pressure');
    },
  },
  {
    name: 'FLARE PCV pressure drop and choked flow; well choke p2/p1 against 0.588 (gas–liquid) and the gas critical ratio',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = W.WTS_flowline_compute;
      const r = C(GAS5);
      const pc = r.pcv, k = W.WTS_gaspvt_k(0.65, 100, 0, 0, 0), rc = Math.pow(2 / (k + 1), k / (k - 1));
      assert.within(k, 1.2, 1.35, 'natural-gas k');
      assert.rel(pc.dp, 250 - pc.pOut, 1e-12, 'PCV ΔP = Psep − P_out');
      assert.rel(pc.ratio, (pc.pOut + PATM) / (250 + PATM), 1e-12);
      assert.rel(pc.rc, rc, 1e-12, 'ideal-nozzle critical ratio from k');
      // The valve chokes at x = ΔP/p1 ≥ Fγ·xT (IEC 60534-2-1), Fγ = k/1.4, default xT 0.7 (globe valve)
      assert.rel(pc.x, (250 - pc.pOut) / (250 + PATM), 1e-12, 'x = ΔP/p1');
      assert.rel(pc.xChoke, k / 1.4 * 0.7, 1e-12, 'Fγ·xT');
      assert.ok(pc.passes && pc.choked && pc.nozzleCritical && pc.ratio < 0.3 && pc.x > pc.xChoke, 'choked PCV: ' + pc.ratio);
      // Subcritical PCV: low separator pressure, small rate
      const s = C(Object.assign({}, GAS5, { qg: 1, psep: 12 }));
      assert.ok(s.pcv.passes && !s.pcv.choked && !s.pcv.nozzleCritical && s.pcv.ratio > s.pcv.rc, 'subcritical: ' + s.pcv.ratio);
      // p2/p1 between 1 − Fγ·xT (≈ 0.37) and the ideal-nozzle ratio (≈ 0.55): an ideal nozzle would be critical,
      // a globe valve with xT 0.7 is not choked; a low-xT valve (0.3) is.
      const mid = C(Object.assign({}, GAS5, { psep: 90 }));
      assert.ok(mid.pcv.ratio > 1 - mid.pcv.xChoke && mid.pcv.ratio < mid.pcv.rc, 'between the two limits: ' + mid.pcv.ratio);
      assert.ok(mid.pcv.nozzleCritical && !mid.pcv.choked, 'not choked with xT 0.7');
      const lowXt = C(Object.assign({}, GAS5, { psep: 90, xt: 0.3 }));
      assert.ok(lowXt.pcv.choked && lowXt.pcv.xT === 0.3, 'choked with xT 0.3');
      assert.strictEqual(lowXt.pcv.pOut, mid.pcv.pOut, 'xT does not change the line hydraulics');
      // Separator below the flare back-pressure: the PCV cannot pass the gas. Compute keeps the signed
      // shortfall (dp < 0); there is no expansion, so no outlet temperature.
      const n = C(Object.assign({}, GAS5, { psep: 10 }));
      assert.ok(!n.pcv.passes && n.pcv.dp < 0 && n.pcv.tOut === null && !n.pcv.choked, 'no flow through the PCV');
      assert.strictEqual(n.psv, null, 'no PSV back-pressure check without flow');
      assert.strictEqual(n.flareCheck.hydrate, null); assert.strictEqual(n.flareCheck.belowMdmt, null);
      // Well choke, dry gas: k-based ratio at the line inlet temperature
      assert.strictEqual(r.choke.basis, 'gas');
      assert.rel(r.choke.rc, rc, 1e-12);
      assert.rel(r.choke.ratio, (r.choke.p2 + PATM) / (600 + PATM), 1e-12);
      assert.ok(r.choke.deliver && r.choke.critical, 'critical choke at 600 psig WHP');
      // Gas–liquid: Gilbert 0.588
      const m = C(Object.assign({}, GAS5, { qo: 2000, qw: 500, qg: 3, sgg: 0.7, well: [{ name: 'l', len: 420, id: 2.9, dz: 20 }] }));
      assert.strictEqual(m.choke.basis, 'multiphase');
      assert.strictEqual(m.choke.rc, 0.588);
      assert.strictEqual(m.choke.critical, m.choke.ratio <= 0.588);
      // Page
      open(app);
      set(app, { fl_psep: 12, fl_qg: 1 }); calc(app);
      assert.includes(resText(app), 'subcritical flow');
      assert.strictEqual(rtext(app, 'PCV flow'), 'Not choked (subcritical)');
      // Page default geometry at 12 MMSCFD: p2/p1 ≈ 0.48 is below the ideal-nozzle ratio 0.555, but
      // x ≈ 0.52 < Fγ·xT ≈ 0.62: the page no longer tells the user to size the globe valve for choked flow.
      set(app, { fl_psep: 250, fl_qg: 12 }); calc(app);
      let p = S(app).result.pcv;
      assert.ok(p.nozzleCritical && !p.choked && S(app).pcvChoked === false, 'not choked: x ' + p.x + ' vs ' + p.xChoke);
      assert.includes(resText(app), 'not choked (IEC 60534-2-1), subcritical flow through the valve, although p2/p1');
      assert.ok(resText(app).indexOf('size it for choked flow') === -1, 'no choked-valve advice');
      assert.rel(rv(app, 'PCV pressure differential ratio x = ΔP/p1'), p.x, 2e-3);
      assert.rel(rv(app, 'PCV pressure differential ratio x = ΔP/p1', 1), p.xChoke, 2e-3);
      assert.includes(rtext(app, 'PCV pressure ratio p2/p1, absolute'), 'ideal-nozzle critical ratio');
      set(app, { fl_xt: 0.4 }); calc(app);
      assert.ok(S(app).pcvChoked === true, 'xT 0.4: choked');
      assert.includes(resText(app), 'choked flow through the valve (IEC 60534-2-1); size it for choked flow');
      assert.strictEqual(rtext(app, 'PCV flow'), 'Choked (IEC 60534-2-1)');
      set(app, { fl_xt: 1.2 }); calc(app);
      assert.ok(!S(app).ok && app.el('fl_xt').classList.contains('input-err'), 'xT range');
      set(app, { fl_xt: 0.7, fl_psep: 10, fl_qg: 3 }); calc(app);
      assert.includes(resText(app), '✗ Back-pressure at the PCV outlet');
      assert.strictEqual(rtext(app, 'PCV pressure drop'), '—');
      noBad(assert, app, 'PCV no flow');
    },
  },
  {
    name: 'FLARE Mach and ρv²: v = ṁ/(ρA) by hand over the real-gas speed of sound; API 521 verdicts',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = W.WTS_flowline_compute, L = W.PRiSM_pvt_correlations;
      const r = C(GAS5);
      // Tip temperature: the isenthalpic expansion from the separator to the tip pressure (hand RK4)
      const Th = isenthTable(W, 0.65, 250 + PATM, 100, 15);
      const hd = flareHand(L, (p) => Th(p)), last = r.flare.segments[1], T = hd.tTip;
      assert.near(last.tOut, T, 0.02, 'tip temperature ' + T.toFixed(2) + ' °F');
      assert.rel(last.vOut, hd.vTip, 1e-4, 'tip velocity ' + hd.vTip.toFixed(1) + ' ft/s');
      const gp = W.WTS_gaspvt_compute({ sg: 0.65, p: PATM + 1.5, t: last.tOut });
      assert.rel(last.machOut, hd.vTip / gp.c, 2e-4, 'Mach with the Gas PVT speed of sound');
      const cIdeal = Math.sqrt(W.WTS_gaspvt_k(0.65, T, 0, 0, 0) * 32.174 * 1545.35 * hd.TR / hd.M);
      assert.rel(gp.c, cIdeal, 0.01, 'near-ideal at the tip');
      assert.within(last.machOut, 0.5, 0.53, 'Mach ≈ 0.51 at the tip');
      assert.rel(r.flareCheck.machMax, last.machOut, 1e-12, 'highest Mach at the tip');
      assert.strictEqual(r.flareCheck.machLevel, 'warn');
      assert.rel(last.rhoV2, hd.rhoTip * hd.vTip * hd.vTip, 1e-4, 'ρv² at the tip');
      assert.ok(!r.flareCheck.rhoV2High, 'below 200,000 kg/m·s²');
      assert.ok(r.flare.segments[0].machOut < last.machIn + 1e-12 && last.machIn < last.machOut, 'Mach rises toward the tip');
      // Page verdicts: ⚠ above 0.5, ✗ above 0.7 / choked
      open(app);
      set(app, { fl_qo: 0, fl_qw: 0, fl_qg: 5, fl_sgg: 0.65, fl_t0: 100, fl_t1: 100, fl_f2_dz: 0, fl_f1_name: 'PCV to knock-out drum', fl_f2_name: 'Flare line' }); calc(app);
      assert.includes(resText(app), '⚠ Mach 0.51');
      assert.includes(resText(app), 'above 0.5 (API 521');
      assert.rel(rv(app, 'Highest Mach number in the flare line'), S(app).flareMachMax, 2e-3);
      assert.ok(S(app).flareMachMax > 0.5 && S(app).flareMachMax < 0.53);
      // 12 MMscf/d through the same line: the exit chokes. The model is the isothermal compressible-flow
      // momentum balance, dp/dx ∝ 1/(1 − ρv²/p): it chokes at ρv² = p (gc, 144 implied), i.e. at the gas
      // velocity √(gc·Z·R·T/M) = c/√k — the table shows Mach ≈ 0.89 there, so the page says "isothermal
      // limit" (it said "sonic" and flagged the choke already at ρv²/p = 0.9, Mach ≈ 0.85).
      set(app, { fl_qg: 12 }); calc(app);
      const st = S(app), rr = st.result, ex = rr.flare.segments[1];
      assert.ok(rr.flare.chokedExit && st.flareMachMax > 0.7, 'choked exit, Mach ' + st.flareMachMax);
      const pStar = (q) => {                                   // isothermal choked exit pressure by hand, psia
        const G = flareHand(L, (p) => Th(p), q).G, M = 28.9647 * 0.65, sut = sutton(0.65);
        let p = 20;
        for (let k = 0; k < 30; k++) {
          const TR = Th(p) + 459.67, z = L.Z_dranchukAbouKassem(TR / sut.Tpc, p / sut.Ppc);
          p = G * Math.sqrt(z * 1545.35 * TR / (32.174 * M)) / 144;
        }
        return p;
      };
      const ps12 = pStar(12);
      assert.rel(st.pFlare + PATM, ps12, 2e-3, 'exit pressure = isothermal choked pressure ' + (ps12 - PATM).toFixed(2) + ' psig');
      assert.ok(st.pFlare > 1.5, 'exit pressure raised above the tip back-pressure: ' + st.pFlare);
      const zx = L.Z_dranchukAbouKassem((ex.tOut + 459.67) / sutton(0.65).Tpc, ps12 / sutton(0.65).Ppc);
      const vIso = Math.sqrt(32.174 * zx * 1545.35 * (ex.tOut + 459.67) / (28.9647 * 0.65));
      const cx = W.WTS_gaspvt_compute({ sg: 0.65, p: st.pFlare + PATM, t: ex.tOut }).c;
      assert.rel(ex.vOut, vIso, 2e-3, 'exit velocity √(gc·Z·R·T/M) ' + vIso.toFixed(1) + ' ft/s');
      assert.rel(ex.machOut, vIso / cx, 2e-3, 'exit Mach ' + (vIso / cx).toFixed(3));
      assert.within(ex.machOut, 0.85, 0.92, 'Mach ≈ 1/√k at the isothermal limit');
      assert.includes(resText(app), '✗ The flare line chokes at the outlet of Flare line (isothermal limit, gas velocity √(ZRT/M), Mach ' + ex.machOut.toFixed(3) + ')');
      assert.ok(resText(app).indexOf('sonic') === -1, 'not called sonic');
      assert.rel(rv(app, 'Highest Mach number in the flare line'), ex.machOut, 2e-3, 'table and verdict agree');
      assert.strictEqual(rr.flareCheck.machLevel, 'bad');
      assert.ok(app.canvasLog('fl_chart2', 'lineTo').length > 10, 'flare chart drawn');
      noBad(assert, app, 'choked');
      // Onset: Ek = 1 at the tip back-pressure (16.196 psia, isenthalpic tip temperature) by hand → q*.
      const M = 28.9647 * 0.65, pt = PATM + 1.5, TRt = Th(pt) + 459.67, zt = L.Z_dranchukAbouKassem(TRt / sutton(0.65).Tpc, pt / sutton(0.65).Ppc);
      const rhoT = pt * M / (zt * 10.7316 * TRt), Gs = Math.sqrt(rhoT * 32.174 * 144 * pt);
      const A = Math.PI * Math.pow(3.826 / 12, 2) / 4, rhoStd = PATM * M / (10.7316 * 519.67);
      const qs = Gs * A * 86400 / rhoStd / 1e6;
      assert.within(qs, 8, 10, 'choking onset ' + qs.toFixed(2) + ' MMscf/d');
      const below = C(Object.assign({}, GAS5, { qg: 0.98 * qs })), above = C(Object.assign({}, GAS5, { qg: 1.02 * qs }));
      assert.ok(!below.flare.chokedExit && Math.abs(below.flare.pOut - 1.5) < 1e-9, 'not choked 2 % below the onset');
      assert.ok(below.flare.segments[1].machOut > 0.85 && below.flareCheck.machLevel === 'bad', 'but above Mach 0.7: ✗');
      assert.ok(above.flare.chokedExit, 'choked 2 % above the onset');
      assert.rel(above.flare.pOut + PATM, pStar(1.02 * qs), 2e-3, 'choked exit pressure just above the onset');
      // Near the exit (ρv²/p ≥ 0.9) the last ≈ 0.1 ft is one step, booked as acceleration: components still add up
      below.flare.segments.concat(above.flare.segments).forEach((s) => assert.rel(s.dpEl + s.dpF + s.dpAcc, s.dp, 1e-6, s.name + ' components'));
    },
  },
  {
    name: 'FLARE Joule–Thomson at the PCV: μJT = R·T²·(∂Z/∂T)p/(p·Cp) in SI units, ≈ 7 °F per 100 psi, integration and page rows',
    wp: WP,
    run(app, assert) {
      const W = app.win, L = W.PRiSM_pvt_correlations;
      // Independent SI evaluation at 100 psia, 80 °F, γ 0.6
      const sg = 0.6, p = 100, tF = 80, g = W.WTS_gaspvt_compute({ sg, p, t: tF });
      const TK = (tF + 459.67) / 1.8, hK = 0.05;
      const Z = (tk) => L.Z_dranchukAbouKassem(tk * 1.8 / g.Tpc, p / g.Ppc);
      const zT = (Z(TK + hK) - Z(TK - hK)) / (2 * hK);                  // 1/K
      const muSI = 8.314462 * TK * TK * zT / (p * 6894.757 * g.cpReal);   // K/Pa
      const muF = muSI * 1.8 * 6894.757;                                  // °F/psi
      const st = W.WTS_gaspvt_state(sg, p, tF);
      assert.rel(st.muJT, muF, 2e-3, 'μJT ' + st.muJT + ' vs SI ' + muF);
      assert.rel(st.c, g.c, 1e-5, 'state() speed of sound = compute()');
      assert.rel(st.kReal, g.kReal, 1e-5, 'state() real-gas k = compute()');
      assert.within(st.muJT, 0.04, 0.08, 'natural gas, ≈ 7 °F per 100 psi order');
      // Integration of dT/dp = μJT by Heun in the module vs a fine RK4 here
      const fine = (p1, t1, p2, n) => {
        let T = t1, q = p1; const h = (p2 - p1) / n, mu = (pp, tt) => W.WTS_gaspvt_state(0.65, pp, tt).muJT;
        for (let k = 0; k < n; k++) {
          const k1 = mu(q, T), k2 = mu(q + h / 2, T + h * k1 / 2), k3 = mu(q + h / 2, T + h * k2 / 2), k4 = mu(q + h, T + h * k3);
          T += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6; q += h;
        }
        return T;
      };
      const iso = W.WTS_flowline_isenthalp(0.65, 264.696, 100, 52.5);
      assert.near(iso.t, fine(264.696, 100, 52.5, 40), 0.02, 'PCV outlet temperature');
      assert.ok(iso.real, 'real-gas μJT used');
      const hp = W.WTS_flowline_isenthalp(0.65, 1414.696, 100, 30);
      assert.near(hp.t, fine(1414.696, 100, 30, 80), 0.1, 'large drop');
      assert.within(hp.dT / (1414.696 - 30), 0.05, 0.1, 'larger mean μJT over a 1,400 psi drop');
      // Flowline result and page rows
      const r = W.WTS_flowline_compute(GAS5);
      assert.near(r.pcv.tOut, W.WTS_flowline_isenthalp(0.65, 264.696, 100, r.pcv.pOut + PATM).t, 0.01, 'PCV outlet temperature at the converged back-pressure');
      assert.within(r.pcv.dT / r.pcv.dp, 0.04, 0.08, '≈ 7 °F per 100 psi');
      open(app);
      const s = S(app);
      assert.within((100 - s.tPcvOut) / s.dpPcv, 0.04, 0.08, 'page default');
      assert.rel(rv(app, 'Temperature downstream of the PCV, isenthalpic'), s.tPcvOut, 2e-3);
      assert.rel(rv(app, 'Joule–Thomson cooling across the PCV'), 100 - s.tPcvOut, 5e-3);
      assert.includes(rtext(app, 'Joule–Thomson cooling across the PCV'), 'real gas');
      // Coupled mode: the flare line starts at the PCV outlet temperature
      set(app, { fl_tmode: 'heat' }); calc(app);
      const c = S(app).result;
      assert.ok(c.ok && c.coupled, 'coupled');
      assert.near(c.flare.segments[0].tIn, c.pcv.tOut, 0.05, 'flare line starts at the PCV outlet temperature');
      assert.rel(c.tSep, c.well.tOut, 1e-12, 'PCV inlet at the calculated separator temperature');
      noBad(assert, app, 'coupled');
    },
  },
  {
    name: 'FLARE well route: the backward march from the separator reproduces Psep when marched forward from P2; WHP too low is ✗',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = W.WTS_flowline_compute;
      const fluid = { qo: 2000, qw: 500, qg: 3, api: 35, sgg: 0.7, sgw: 1.05 };
      const well = [{ name: 'Choke manifold to heater', len: 150, id: 2.9, dz: 0 }, { name: 'Heater to separator', len: 250, id: 2.9, dz: 5 }, { name: 'Separator inlet riser', len: 20, id: 2.9, dz: 15 }];
      const inp = Object.assign({ pwh: 600, t0: 120, t1: 100, psep: 250, rough: 0.0018, payne: true, accel: true, well, flare: [] }, fluid);
      const r = C(inp);
      const p2 = r.well.pIn, opt = { rough: 0.0018, payne: true, accel: true };
      assert.ok(p2 > 280 && p2 < 340, 'P2 ' + p2);
      // Forward from P2 (flow direction, T linear inlet → arrival) arrives at the separator pressure
      const fw = W.WTS_flowline_march(well, fluid, p2, 120, 100, Object.assign({ refine: true }, opt));
      assert.near(fw.pOut, 250, 0.05, 'forward march with sub-steps: ' + fw.pOut);
      const fw0 = W.WTS_flowline_march(well, fluid, p2, 120, 100, opt);
      assert.near(fw0.pOut, 250, 0.5, 'forward march, standard steps: ' + fw0.pOut);
      // The public reverse march (segments in march order) gives the same P2
      const rev = well.slice().reverse();
      const bw = W.WTS_flowline_march(rev, fluid, 250, 100, 120, Object.assign({ reverse: true, refine: true }, opt));
      assert.rel(bw.pOut, p2, 1e-9, 'public reverse march');
      // Segments in flow order, continuous, components add up
      r.well.segments.forEach((s, k) => {
        assert.strictEqual(s.name, well[k].name);
        assert.rel(s.dpEl + s.dpF + s.dpAcc, s.dp, 1e-6, s.name);
        if (k) assert.rel(s.pIn, r.well.segments[k - 1].pOut, 1e-12);
      });
      assert.rel(r.well.segments[0].pIn, p2, 1e-12); assert.rel(r.well.segments[2].pOut, 250, 1e-12);
      assert.rel(r.well.segments[0].tIn, 120, 1e-12); assert.rel(r.well.segments[2].tOut, 100, 1e-12);
      // Coupled temperature: forward coupled pass and backward march agree
      const heat = { tmode: 'heat', tair: 60, wind: 10, eps: 0.9, wall: 0.3, ins: 0, kp: 26, kins: 0.025, cpo: 0.5, cpw: 1, cpg: 0.55, jt: 0.07 };
      const h = C(Object.assign({}, inp, heat));
      assert.ok(h.ok && h.well.iterations <= 8 && Math.abs(h.well.pIn - p2) < 5, 'coupled P2 ' + h.well.pIn);
      // WHP below P2
      const lo = C(Object.assign({}, inp, { pwh: 280 }));
      assert.ok(!lo.choke.deliver && !lo.choke.critical && lo.choke.dp < 0, 'cannot deliver');
      open(app);
      set(app, { fl_pwh: 280 }); calc(app);
      assert.includes(resText(app), '✗ WHP 280 psig is below the');
      assert.includes(resText(app), 'the well cannot deliver this rate into the separator at 250 psig');
      assert.strictEqual(rtext(app, 'Choke flow'), 'Cannot deliver: WHP below the required pressure');
      assert.strictEqual(S(app).chokeCritical, false);
      noBad(assert, app, 'low WHP');
    },
  },
  {
    name: 'FLARE compatibility: inputs missing from an older saved page take their defaults; blank PSV skips the check; blank tip drop is flagged',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = W.WTS_flowline_compute;
      const a = C(GAS5), b = C(Object.assign({}, GAS5, { dptip: 1.5, mdmt: -20, psvset: 1440 }));
      assert.ok(a.ok && a.dptip === 1.5 && a.mdmt === -20 && a.psvset === 1440 && a.xt === 0.7 && a.pcv.xT === 0.7, 'defaults');
      assert.strictEqual(a.pcv.pOut, b.pcv.pOut);
      assert.ok(a.psv && a.psv.ok && a.psv.valid, 'PSV check with the default 1,440 psig');
      const n = C(Object.assign({}, GAS5, { psvset: '' }));
      assert.ok(n.ok && n.psv === null, 'blank PSV: no check');
      // An autosaved record from before the PCV/flare rework (no fl_dptip / fl_mdmt / fl_psvset)
      app.storage.setItem('wts_page_flowline', JSON.stringify({ v: 1, t: 1, tabs: [], f: {
        fl_qo: '1500', fl_qw: '300', fl_qg: '4', fl_api: '38', fl_sgg: '0.72', fl_sgw: '1.05', fl_pwh: '700', fl_t0: '110', fl_t1: '95', fl_psep: '300',
        fl_rough: '0.0018', fl_payne: 'yes', fl_accel: 'yes', fl_tmode: 'linear', fl_f1_name: 'Separator to knock-out drum', fl_f1_len: '300', fl_f1_id: '3.826', fl_f1_dz: '0' } }));
      open(app);
      assert.strictEqual(app.el('fl_qg').value, '4');
      assert.strictEqual(app.el('fl_dptip').value, '1.5');
      assert.strictEqual(app.el('fl_mdmt').value, '-20');
      assert.strictEqual(app.el('fl_psvset').value, '1440');
      assert.strictEqual(app.el('fl_xt').value, '0.7', 'PCV xT (added later) takes its default');
      const st = S(app);
      assert.ok(st.ok && st.p2Choke > 300 && st.pPcvOut > 1.5 && st.pPcvOut < 300, 'old record calculates: ' + JSON.stringify([st.p2Choke, st.pPcvOut]));
      assert.includes(resText(app), 'Separator to knock-out drum');
      noBad(assert, app, 'old record');
      set(app, { fl_psvset: '' }); calc(app);
      assert.ok(S(app).ok && rtext(app, 'Back-pressure / separator PSV set pressure') === null, 'no PSV row');
      set(app, { fl_dptip: '' }); calc(app);
      assert.ok(!S(app).ok && app.el('fl_dptip').classList.contains('input-err'), 'blank tip drop flagged');
      assert.includes(String(app.el('fl_res').textContent), 'Flare tip pressure drop must be between 0 and 50 psi');
      set(app, { fl_dptip: 1.5, fl_mdmt: 500 }); calc(app);
      assert.ok(!S(app).ok && app.el('fl_mdmt').classList.contains('input-err'), 'MDMT range');
      set(app, { fl_mdmt: -20 }); calc(app);
      assert.ok(S(app).ok);
    },
  },
  {
    name: 'FLARE metric: PCV, flare and choke rows in kPa / °C / kg/m·s², metric entry of the new inputs, same physical answer',
    wp: WP,
    run(app, assert) {
      open(app);
      const imp = Object.assign({}, S(app));
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('fl_dptip'), /kPa/);
        assert.match(lab('fl_mdmt'), /°C/);
        assert.match(lab('fl_psvset'), /kPa/);
        assert.rel(S(app).pPcvOut, imp.pPcvOut, 2e-3, 'same back-pressure');
        assert.rel(S(app).tPcvOut, imp.tPcvOut, 2e-3, 'same PCV temperature');
        assert.rel(S(app).p2Choke, imp.p2Choke, 2e-3, 'same P2');
        assert.includes(rtext(app, 'Pressure at the PCV outlet (flare header back-pressure)'), 'kPa');
        assert.rel(rv(app, 'Pressure at the PCV outlet (flare header back-pressure)'), imp.pPcvOut * 6.89476, 5e-3);
        assert.includes(rtext(app, 'Temperature downstream of the PCV, isenthalpic'), '°C');
        assert.rel(rv(app, 'Temperature downstream of the PCV, isenthalpic'), (imp.tPcvOut - 32) * 5 / 9, 5e-3);
        assert.includes(rtext(app, 'Highest ρv² in the flare line'), 'kg/m·s²');
        assert.includes(rtext(app, 'Joule–Thomson cooling across the PCV'), '°C/bar');
        assert.includes(rtext(app, 'Choke pressure drop'), 'kPa');
        assert.includes(rtext(app, 'Minimum design metal temperature'), '-28.9 °C');
        // Metric entry: 2 psi tip drop typed as 13.79 kPa
        app.input('fl_dptip', String(2 * 6.89476)); calc(app);
        assert.rel(S(app).pFlare, 2, 1e-4, 'tip pressure from kPa');
        noBad(assert, app, 'metric');
      } finally { U.setSystem('imperial'); }
    },
  },
  {
    name: 'FLARE verdicts: PSV back-pressure 10 %, hydrate and minimum design metal temperature, Notes ≤ 600 characters, verdicts < 300, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      const st = S(app);
      assert.ok(st.result.psv.ok, 'default PSV 1,440 psig');
      assert.includes(resText(app), '✓ Flare header back-pressure');
      assert.includes(resText(app), '✓ Mach ≤ 0.5 in the flare line');
      // Separator at 150 psig with its PSV set at 180 psig: the ≈ 20 psig flare back-pressure is above 10 %
      set(app, { fl_psep: 150, fl_psvset: 180 }); calc(app);
      assert.ok(S(app).result.psv.valid && !S(app).result.psv.ok && S(app).result.psv.frac > 0.1, 'above 10 %');
      assert.includes(resText(app), 'above 10 %: use a balanced-bellows or pilot PSV');
      assert.near(rv(app, 'Back-pressure / separator PSV set pressure'), 100 * S(app).pPcvOut / 180, 0.051);
      set(app, { fl_psep: 250, fl_psvset: 200 }); calc(app);
      assert.includes(resText(app), '⚠ The PSV set pressure 200 psig is not above the separator pressure');
      // 1,400 psig separator at 60 °F: deep J-T cooling below the hydrate temperature and a 0 °F MDMT
      set(app, { fl_psvset: 1440, fl_pwh: 3000, fl_psep: 1400, fl_t1: 60, fl_mdmt: 0 }); calc(app);
      const r = S(app).result;
      assert.ok(r.ok && r.pcv.tOut < 0 && r.flareCheck.hydrate && r.flareCheck.belowMdmt, 'cold: ' + r.pcv.tOut);
      assert.rel(r.flareCheck.tHyd, app.win.WTS_hydrate_temp(r.pcv.pOut + PATM, 0.7), 1e-12, 'hydrate T at the PCV outlet pressure');
      // The hydrate check is point by point: the worst point is below the hydrate temperature at its own pressure
      // (the hydrate temperature falls with the pressure while the gas cools toward the tip).
      const hw = r.flareCheck.hydAt;
      assert.ok(hw && hw.t < hw.tHyd, 'hydrate margin < 0');
      assert.rel(hw.tHyd, app.win.WTS_hydrate_temp(hw.p + PATM, 0.7), 1e-12, 'hydrate T at that point');
      r.flare.profile.forEach((q) => assert.ok(q.t - app.win.WTS_hydrate_temp(q.p + PATM, 0.7) >= hw.margin - 1e-9, 'worst point'));
      assert.includes(resText(app), 'below the hydrate temperature');
      assert.includes(resText(app), 'below the minimum design metal temperature 0 °F');
      assert.includes(resText(app), '⚠ The separator runs above 90 % of its PSV set pressure');
      // Notes and verdict lengths
      const notes = app.findAll('#fl_res div').filter((d) => { const b = d.children && d.children[0]; return b && b.tagName === 'B' && b.textContent === 'Notes'; });
      assert.strictEqual(notes.length, 1);
      const nt = String(notes[0].textContent);
      assert.ok(nt.length <= 600, 'Notes ' + nt.length + ' characters');
      ['marched back', 'tip', 'PCV', 'API 521', 'API 520'].forEach((w) => assert.includes(nt, w));
      const verdicts = app.findAll('#fl_res div').map((d) => String(d.textContent)).filter((t) => /^[✓⚠✗] /.test(t));
      assert.ok(verdicts.length >= 5, 'verdicts');
      verdicts.forEach((t) => assert.ok(t.length < 300, 'verdict under 300 characters: ' + t.length + ' ' + t));
      noBad(assert, app, 'verdicts');
      // Report sections
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const titles = model.results.map((x) => x.title);
      ['Gas PCV and Flare Line', 'Segments: PCV outlet to flare tip'].forEach((t) => assert.ok(titles.indexOf(t) !== -1, t + ': ' + titles.join(' | ')));
      assert.includes(JSON.stringify(model), 'Flare System, Downstream of the Separator Gas PCV');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
    },
  },
  {
    name: 'FLARE adiabatic flare line: the gas keeps cooling isenthalpically from the PCV outlet to the tip; MDMT judged at the coldest point; a higher rate no longer clears it',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = W.WTS_flowline_compute;
      // 1,000 psig separator at 57 °F, 12 MMscf/d, 1,000 ft + 100 ft (25 ft up) of 5.761 in, MDMT −20 °F.
      // Before: the line was held at the PCV outlet temperature (≈ −18.9 °F at ≈ 43.6 psig) and every check passed.
      const inp = { qo: 200, qw: 0, qg: 12, api: 35, sgg: 0.7, sgw: 1.05, pwh: 3000, t0: 57, t1: 57, psep: 1000, rough: 0.0018, payne: true, accel: true,
        mdmt: -20, well: [{ name: 'Choke to separator', len: 400, id: 2.9, dz: 0 }],
        flare: [{ name: 'Flare header', len: 1000, id: 5.761, dz: 0 }, { name: 'Flare boom', len: 100, id: 5.761, dz: 25 }] };
      const r = C(inp), f = r.flare;
      assert.ok(r.ok && f && !f.lost && !f.chokedExit && r.pcv.passes, 'computed');
      const Th = isenthTable(W, 0.7, 1000 + PATM, 57, 15);
      assert.near(r.pcv.tOut, Th(r.pcv.pOut + PATM), 0.05, 'PCV outlet on the isenthalpic curve');
      assert.within(r.pcv.tOut, -20, -17.5, 'PCV outlet ≈ −18.9 °F');
      const tExit = Th(f.pOut + PATM);
      assert.near(r.flareCheck.tMin, tExit, 0.05, 'coldest = isenthalpic temperature at the line exit ' + tExit.toFixed(2) + ' °F');
      assert.ok(r.flareCheck.tMin < r.pcv.tOut - 3, 'more cooling to the tip: ' + r.flareCheck.tMin);
      assert.ok(r.flareCheck.belowMdmt === true, 'below the −20 °F MDMT');
      // ≈ 7 °F per 100 psi order over the whole expansion (larger at high pressure: real-gas μJT)
      assert.within((57 - r.flareCheck.tMin) / (1000 - f.pOut), 0.06, 0.1, 'mean μJT, separator → tip');
      // The tip temperature does not depend on the rate (same tip pressure): 14 and 16 MMscf/d at 55 °F both warn.
      // Before, the higher rate raised the back-pressure, warmed the PCV outlet and cleared the warning.
      const a = C(Object.assign({}, inp, { t0: 55, t1: 55, qg: 14 })), b = C(Object.assign({}, inp, { t0: 55, t1: 55, qg: 16 }));
      assert.ok(b.pcv.pOut > a.pcv.pOut && b.pcv.tOut > a.pcv.tOut, 'higher rate: higher back-pressure, warmer PCV outlet');
      assert.ok(a.flareCheck.belowMdmt && b.flareCheck.belowMdmt, 'both below the MDMT');
      assert.near(a.flareCheck.tMin, b.flareCheck.tMin, 0.3, 'same coldest temperature at the tip');
      // Page
      open(app);
      set(app, { fl_qo: 200, fl_qw: 0, fl_qg: 12, fl_pwh: 3000, fl_t0: 57, fl_t1: 57, fl_psep: 1000, fl_mdmt: -20,
        fl_f1_len: 1000, fl_f1_id: 5.761, fl_f1_dz: 0, fl_f2_len: 100, fl_f2_id: 5.761, fl_f2_dz: 25 }); calc(app);
      const st = S(app);
      assert.ok(st.ok && st.result.flareCheck.belowMdmt, 'page: below MDMT');
      assert.includes(resText(app), 'cools to');
      assert.includes(resText(app), '(isenthalpic expansion to the line exit), below the minimum design metal temperature -20 °F');
      assert.rel(rv(app, 'Coldest gas temperature in the flare line'), st.result.flareCheck.tMin, 3e-3);
      const segs = st.result.flare.segments;
      assert.ok(segs[0].tIn > segs[0].tOut && segs[1].tIn > segs[1].tOut, 'segment table: temperature falls along the line');
      noBad(assert, app, 'adiabatic');
    },
  },
  {
    name: 'FLARE verdict consistency: a choked or blocked route shows no contradicting ✓; no-flow pressure drops are null in the state; routes stop above 15,000 psig',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      const vlist = () => app.findAll('#fl_res div').map((d) => String(d.textContent)).filter((t) => /^[✓⚠✗] /.test(t));
      const box = (title) => {
        const b = app.findAll('#fl_res .rbox').find((x) => String(x.querySelector('.rbox-title').textContent) === title);
        return b ? b.querySelectorAll('div').map((d) => String(d.textContent)).filter((t) => /^[✓⚠✗] /.test(t)) : [];
      };
      const short = () => vlist().forEach((t) => assert.ok(t.length < 300, 'verdict < 300: ' + t));
      open(app);
      // Separator at 15 psig: the well line chokes at the separator inlet, the PCV cannot pass the gas.
      set(app, { fl_psep: 15 }); calc(app);
      let st = S(app), r = st.result, w = r.well;
      assert.ok(w.chokedExit && !w.reaches && r.choke.deliver, 'well line chokes at its outlet');
      assert.ok(vlist().every((t) => t.indexOf('✓ Line:') !== 0), 'no ✓ Line verdict when the line chokes');
      assert.includes(resText(app), '✗ The line chokes (critical velocity) at the outlet of Separator inlet riser');
      assert.rel(rv(app, 'Line outlet pressure, choked (above the separator pressure)'), st.pArr, 2e-3);
      assert.rel(st.dpSep, st.p2Choke - st.pArr, 1e-9, 'line drop to the choked outlet');
      assert.includes(rtext(app, 'Pressure drop, choke outlet to separator'), 'to the choked line outlet');
      // The choked outlet is at the B&B kinetic-energy limit Ek = 1 (it was Ek = 0.9 before)
      const fl = r.fluid, pA = st.pArr + PATM, last = w.segments[2], A = Math.PI * Math.pow(2.9 / 12, 2) / 4;
      const pr = W.WTS_flowline_props(fl, pA, last.tOut);
      const g = W.WTS_flowline_bb({ vsl: pr.qL / A, vsg: pr.qG / A, d: 2.9, rhoL: pr.rhoL, rhoG: pr.rhoG, muL: pr.muL, muG: pr.mug, sigma: pr.sigL,
        theta: Math.asin(15 / 20) * 180 / Math.PI, rough: 0.0018, p: pA, payne: true, accel: true });
      assert.rel(g.Ek, 1, 1e-6, 'Ek = 1 at the choked outlet: ' + g.Ek);
      w.segments.forEach((s) => assert.rel(s.dpEl + s.dpF + s.dpAcc, s.dp, 1e-6, s.name + ' components'));
      // PCV: no flow — only the ✗ in the PCV box (no Mach / PSV ✓, no hydrate / MDMT ⚠), null drops in the state
      const pv = box('Gas PCV and Flare Line');
      assert.ok(pv.length >= 1 && pv.every((t) => t[0] === '✗'), 'only ✗ in the PCV box: ' + JSON.stringify(pv));
      assert.includes(pv[0], '✗ Back-pressure at the PCV outlet');
      assert.ok(st.dpPcv === null && st.tPcvOut === null && st.pcvChoked === false, 'state: ' + JSON.stringify([st.dpPcv, st.tPcvOut, st.pcvChoked]));
      assert.ok(st.pPcvOut > 15, 'back-pressure still reported');
      assert.strictEqual(rtext(app, 'PCV pressure drop'), '—');
      assert.strictEqual(rtext(app, 'Temperature downstream of the PCV, isenthalpic'), '—');
      assert.strictEqual(rtext(app, 'Back-pressure / separator PSV set pressure'), null);
      noBad(assert, app, 'psep 15'); short();
      // WHP below P2: no ✓ Line; dpChoke null in the state (compute keeps the signed shortfall)
      set(app, { fl_psep: 250, fl_pwh: 200 }); calc(app);
      st = S(app);
      assert.ok(!st.result.choke.deliver && st.result.choke.dp < 0, 'shortfall in compute');
      assert.ok(st.dpChoke === null && st.chokeCritical === false && st.p2Choke > 200, 'state: ' + JSON.stringify([st.dpChoke, st.chokeCritical]));
      assert.ok(vlist().every((t) => t.indexOf('✓ Line:') !== 0), 'no ✓ Line verdict when the well cannot deliver');
      assert.includes(resText(app), '✗ WHP 200 psig is below the');
      noBad(assert, app, 'WHP 200'); short();
      // Extreme rate in 0.5 in lines: the backward marches stop above 15,000 psig (they ran to 624,869 psig)
      set(app, { fl_pwh: 15000, fl_qg: 100, fl_w1_id: 0.5, fl_w2_id: 0.5, fl_w3_id: 0.5 }); calc(app);
      st = S(app); r = st.result;
      assert.ok(st.ok && r.well.lost && r.well.lost.reason === 'high' && st.p2Choke === null && st.dpChoke === null, 'well route stops: ' + JSON.stringify(r.well.lost));
      assert.strictEqual(rtext(app, 'Required pressure downstream of the choke'), 'More than 15,000 psig');
      assert.includes(rtext(app, 'Choke flow'), 'Cannot deliver');
      assert.includes(resText(app), 'more than 15,000 psig would be needed in');
      assert.ok(vlist().every((t) => t.indexOf('✓') !== 0 || t.indexOf('✓ Line') === -1), 'no ✓ Line');
      r.well.profile.forEach((q) => assert.ok(q.p <= 15000 + 1e-6, 'profile within the cap: ' + q.p));
      noBad(assert, app, 'well cap'); short();
      set(app, { fl_w1_id: 2.9, fl_w2_id: 2.9, fl_w3_id: 2.9, fl_f1_id: 0.5, fl_f2_id: 0.5, fl_psep: 1000 }); calc(app);
      st = S(app); r = st.result;
      assert.ok(st.ok && r.flare.lost && r.flare.lost.reason === 'high' && st.pPcvOut === null && st.dpPcv === null, 'flare route stops');
      assert.strictEqual(rtext(app, 'Pressure at the PCV outlet (flare header back-pressure)'), 'More than 15,000 psig');
      assert.includes(resText(app), 'more than 15,000 psig would be needed at the PCV outlet');
      assert.ok(box('Gas PCV and Flare Line').every((t) => t[0] === '✗'), 'only ✗ in the PCV box');
      noBad(assert, app, 'flare cap'); short();
      // The public march (used by gas lift) has no cap and no choke handling: unchanged
      const m = W.WTS_flowline_march([{ len: 20000, id: 2.441, dz: 20000 }], { qo: 800, qw: 400, qg: 0.3, api: 35, sgg: 0.7, sgw: 1.07 }, 200, 80, 200, { reverse: true });
      assert.ok(m && !m.lost && m.pOut > 6000, 'public reverse march down a 20,000 ft column: ' + (m && m.pOut));
    },
  },
  {
    name: 'FLARE Gas PVT state(): Simpson end node no longer scatters Cp at low pressure; k → ideal at 1 atm',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      // Before the fix the integrand was evaluated at Ppr = 1e-6·Ppr, where the Z differences are round-off:
      // ±7 % Cp scatter at 30 psia (16 panels), ±1 % with 120.
      const cps = [85, 86, 87, 88, 89].map((t) => W.WTS_gaspvt_compute({ sg: 0.7, p: 30, t }).cpReal);
      for (let k = 1; k < cps.length; k++) assert.ok(Math.abs(cps[k] / cps[k - 1] - 1) < 2e-3, 'smooth Cp ' + cps.join(', '));
      const st = [85, 86, 87, 88, 89].map((t) => W.WTS_gaspvt_state(0.7, 30, t).muJT);
      for (let k = 1; k < st.length; k++) assert.ok(st[k] < st[k - 1] && st[k - 1] - st[k] < 0.002, 'μJT smooth and falling with T ' + st.join(', '));
      const atm = W.WTS_gaspvt_compute({ sg: 0.65, p: 14.696, t: 60 });
      assert.rel(atm.kReal, atm.k, 3e-3, 'k real → k ideal at 1 atm');
      assert.strictEqual(W.WTS_gaspvt_state(0.7, 30, -150), null, 'below the pseudo-critical temperature');
    },
  },
];
