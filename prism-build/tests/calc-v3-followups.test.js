// v3.0 engineering follow-ups from the v1.8 reviews:
//   Ei / E1 (01-foundation.js), Gas PVT real-gas k + Standing sour viscosity (46-calc-gaspvt.js),
//   Well Kill friction + tailpipe (48-calc-wellkill.js), Flowline coupled P–T march
//   (49-calc-flowline.js + 49-calc-lineheat.js), Scale Langelier form (49-calc-scale.js).
//
// Expected values are independent of the code under test:
//   • Abramowitz & Stegun (1964) Table 5.1 / eq. 5.1.2 values of Ei and E1.
//   • NIST Chemistry WebBook (Setzmann & Wagner EOS), methane isotherm 310.93 K (100 °F):
//       0.10132 MPa  Cp 36.289, Cv 27.904 J/mol·K, w 457.10 m/s
//       6.9961  MPa  Cp 43.325, Cv 28.866,         w 449.09 m/s
//       13.891  MPa  Cp 51.161, Cv 29.626,         w 473.02 m/s
//   • Standing (1981) impurity terms and the Lee–Gonzalez–Eakin formula typed here.
//   • Bourgoyne et al. (1986) pipe-flow equations typed here, Swamee–Jain explicit friction factor.
//   • Series heat-flow resistances by hand (Incropera eq. 3.33) for an insulation-dominated line.
//   • USBR MS-2016 worked example (LSI 0.18).
'use strict';

const WP = 'V3FU';
const log10 = Math.log10;

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
function nav(app, key, root) {
  const b = app.find('.nav-btn[data-p="' + key + '"]');
  if (!b) throw new Error('no ' + key + ' nav button');
  app.click(b);
  if (!app.el(root)) throw new Error(key + ' did not render');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function noBad(assert, app, where) {
  assert.ok(!/NaN|Infinity|undefined/.test(String(app.el('pgBody').textContent || '')), where + ': NaN/Infinity/undefined on page');
}

module.exports = [
  {
    name: 'V3 Ei/E1: A&S Table 5.1 values for positive and negative arguments; interference model E1 is the foundation one',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      const Ei = W.PRiSM_Ei, E1 = W.PRiSM_E1;
      assert.strictEqual(typeof Ei, 'function'); assert.strictEqual(typeof E1, 'function');
      // A&S Table 5.1 (x·e^-x·E1 and Ei columns), 10 significant figures
      [[1, 1.895117816], [0.5, 0.4542199049], [2, 4.954234356], [10, 2492.228976], [0.01, -4.017929465]]
        .forEach(([x, v]) => assert.rel(Ei(x), v, 1e-8, 'Ei(' + x + ')'));
      [[1, 0.2193839344], [0.5, 0.5597735948], [5, 0.001148295591], [0.01, 4.037929577], [2, 0.04890051071]]
        .forEach(([x, v]) => { assert.rel(E1(x), v, 1e-8, 'E1(' + x + ')'); assert.rel(Ei(-x), -v, 1e-8, 'Ei(-' + x + ') = -E1'); });
      // Asymptotic branch: Ei(50) = 1.0585636897e20 (A&S 5.1.51 region)
      assert.rel(Ei(50), 1.0585636897131690e20, 1e-9, 'Ei(50)');
      assert.ok(Number.isNaN(Ei(NaN)) && Ei(0) === -Infinity && Ei(-Infinity) === 0, 'edge values');
      // Line-source well function W(u) = E1(u) = −Ei(−u) (Theis): u = 1e-4 → 8.633
      assert.rel(-Ei(-1e-4), 8.63322470, 1e-8, 'W(1e-4)');
      // Interference model (09) still evaluates finite values in the early-time E1 region
      const M = W.PRiSM_MODELS.interference;
      assert.ok(M && typeof M.pd === 'function', 'interference model');
      const v = M.pd([0.01, 0.1, 1, 10, 100], Object.assign({}, M.defaults));
      assert.ok(v.every((x) => Number.isFinite(x) && x >= 0), 'interference pd finite: ' + v);
    },
  },
  {
    name: 'V3 Gas PVT: real-gas k and speed of sound against NIST methane; Standing N2/CO2/H2S viscosity correction by hand',
    wp: WP,
    run(app, assert) {
      const F = app.win.WTS_gaspvt_compute;
      const sgm = 16.043 / 28.9647;
      const NIST = [[0.10132, 36.289, 27.904, 457.10], [6.9961, 43.325, 28.866, 449.09], [13.891, 51.161, 29.626, 473.02]];
      NIST.forEach(([mpa, cp, cv, w]) => {
        const r = F({ sg: sgm, p: mpa * 145.0377, t: 100 });
        assert.ok(r.ok, 'ok ' + mpa);
        const kN = cp / cv, cN = w / 0.3048;
        assert.rel(r.kReal, kN, 0.04, 'k real vs NIST at ' + mpa + ' MPa: ' + r.kReal + ' / ' + kN);
        assert.rel(r.c, cN, 0.03, 'c vs NIST at ' + mpa + ' MPa: ' + r.c + ' / ' + cN);
        assert.ok(Math.abs(r.c - cN) <= Math.abs(r.cIdealK - cN) + 1, 'real-gas c no worse than the ideal-k form');
      });
      // At 2,015 psia the pre-v3.0 form was ≈ 11 % low
      const hp = F({ sg: sgm, p: 13.891 * 145.0377, t: 100 });
      assert.ok(hp.cIdealK < 0.9 * 473.02 / 0.3048 && hp.c > 0.97 * 473.02 / 0.3048, 'ideal-k c ' + hp.cIdealK + ' vs real ' + hp.c);
      // Low-pressure limit: real k → ideal k
      const lo = F({ sg: 0.65, p: 14.7, t: 60 });
      assert.rel(lo.kReal, lo.k, 5e-3, 'k real → k ideal at 1 atm');
      // Standing correction: sour gas γ 0.7, 150 °F, 2,000 psia, CO2 5 %, H2S 10 %, N2 2 %
      const s = F({ sg: 0.7, p: 2000, t: 150, co2: 5, h2s: 10, n2: 2 });
      const lg = log10(0.7);
      const dMu = 0.05 * (9.08e-3 * lg + 6.24e-3) + 0.10 * (8.49e-3 * lg + 3.73e-3) + 0.02 * (8.48e-3 * lg + 9.59e-3);
      assert.rel(dMu, 6.487e-4, 1e-3, 'ΣΔμ typed check');
      const M = 0.7 * 28.9647, T = 609.67;
      const K = (9.4 + 0.02 * M) * Math.pow(T, 1.5) / (209 + 19 * M + T), X = 3.5 + 986 / T + 0.01 * M, Y = 2.4 - 0.2 * X;
      const rho = 1.4935e-3 * 2000 * M / (s.z * T), ratio = Math.exp(X * Math.pow(rho, Y));
      assert.rel(s.mu, (1e-4 * K + dMu) * ratio, 1e-9, 'μ = (μ1 + ΣΔμ)·exp(Xρ^Y)');
      assert.rel(s.muLGE, 1e-4 * K * ratio, 1e-9, 'plain LGE kept');
      assert.ok(s.mu > s.muLGE * 1.03, 'impurities raise μ by > 3 %');
      // Sweet gas: unchanged LGE
      const sw = F({ sg: 0.7, p: 3000, t: 200 });
      assert.rel(sw.mu, sw.muLGE, 1e-12, 'sweet gas unchanged');
      // Page rows
      nav(app, 'gaspvt', 'gp_root');
      set(app, { gp_co2: 5, gp_h2s: 10, gp_n2: 2, gp_p: 2000, gp_t: 150 }); app.click('gp_calc');
      assert.rel(rv(app, 'gp_res', 'Viscosity (Lee–Gonzalez–Eakin)'), s.mu, 2e-3, 'page μ');
      assert.ok(rows(app, 'gp_res').some((x) => /Standing N2\/CO2\/H2S/.test(x.l)), 'correction row shown');
      assert.rel(rv(app, 'gp_res', 'Cp/Cv (k), real gas at p and T'), s.kReal, 1e-3);
      assert.rel(rv(app, 'gp_res', 'Cp/Cv (k), ideal gas'), s.k, 1e-3);
      noBad(assert, app, 'gaspvt');
    },
  },
  {
    name: 'V3 Well Kill: tubing friction at pump rate (Bourgoyne, laminar and turbulent), pump pressures, tailpipe volume',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_wellkill_compute;
      const base = { pres: 5400, tvd: 10000, ob: 200, fg: 15, wf: 1.9, ann: 8.6, tub: 'tubing-2.875-6.5', cas: 'casing-7-29',
        pmd: 9800, ptvd: 9620, tmd: 10150, bmd: 10250, pbtd: 10400, to: 'top', od: 10, pump: 0.1, spm: 40, mu: 2, rough: 0.0018 };
      const r = C(base);
      assert.ok(r.ok);
      // Hand: q = 4 bbl/min = 168 gal/min; 2-7/8 6.5# ID 2.441 in; ρ 10.8 ppg
      const d = 2.441, q = 168, v = q / (2.448 * d * d), re = 928 * 10.8 * v * d / 2;
      const fSJ = 0.0625 / Math.pow(log10(0.0018 / d / 3.7 + 5.74 / Math.pow(re, 0.9)), 2);   // Swamee–Jain, Fanning
      const dpT = fSJ * 10.8 * v * v * 9800 / (25.8 * d);
      const fr = r.bullhead.friction;
      assert.rel(fr.tubing.v, v, 1e-9, 'velocity'); assert.rel(fr.tubing.nre, re, 1e-9, 'Reynolds');
      assert.strictEqual(fr.tubing.regime, 'turbulent');
      assert.rel(fr.tubing.f, fSJ, 0.015, 'Fanning f (Colebrook vs Swamee–Jain)');
      assert.rel(fr.tubing.dp, dpT, 0.015, 'tubing friction ' + fr.tubing.dp + ' vs ' + dpT);
      assert.ok(fr.tubing.dp > 1000 && fr.tubing.dp < 1300, '≈ 0.12 psi/ft for 4 bpm of 10.8 ppg in 2-7/8');
      assert.rel(r.limits.pumpEnd, r.limits.endReq + fr.total, 1e-12, 'pump pressure at end');
      assert.rel(r.limits.maxPumpEnd, r.limits.perfEnd + fr.total, 1e-12, 'max pump pressure at end');
      const last = r.bullhead.schedule[10];
      assert.rel(last.friction, fr.total, 1e-9, 'full-string friction at 100 %');
      assert.strictEqual(r.bullhead.schedule[0].friction, 0, 'no kill fluid in the string at 0 %');
      // Laminar: 0.1 bbl/min of 100 cp → f = 16/Re exactly
      const lam = C(Object.assign({}, base, { pump: 0.01, spm: 10, mu: 100 }));
      const vl = 4.2 / (2.448 * d * d), rel = 928 * 10.8 * vl * d / 100;
      assert.strictEqual(lam.bullhead.friction.tubing.regime, 'laminar');
      assert.rel(lam.bullhead.friction.tubing.f, 16 / rel, 1e-12, 'laminar f');
      assert.rel(lam.bullhead.friction.tubing.dp, 16 / rel * 10.8 * vl * vl * 9800 / (25.8 * d), 1e-9, 'laminar dp');
      // No pump speed → no friction, results as before
      const nf = C(Object.assign({}, base, { spm: '' }));
      assert.strictEqual(nf.bullhead.friction, null);
      assert.strictEqual(nf.bullhead.sections.length, 4, 'no tailpipe → 4 sections');
      // Tailpipe to 9,950 ft: tubing bore to the WLEG, then casing
      const K = Math.PI / 4 * 12 / 9702;
      const t = C(Object.assign({}, base, { tpmd: 9950 }));
      assert.strictEqual(t.bullhead.sections.map((s) => s.key).join(','), 'tubing,tailpipe,casing,perfs,rathole');
      const vT = 2.441 * 2.441 * K * 9800, vTp = 2.441 * 2.441 * K * 150, vC = 6.184 * 6.184 * K * 200;
      assert.rel(t.bullhead.vol, vT + vTp + vC, 1e-4, 'bullhead with tailpipe');
      assert.rel(t.bullhead.tailpipe.vol, vTp, 1e-4, 'tailpipe volume');
      assert.rel(t.bullhead.tailpipe.deadVol, (6.184 * 6.184 - 2.875 * 2.875) * K * 150, 1e-4, 'dead annulus below packer');
      assert.ok(t.bullhead.vol < r.bullhead.vol, 'tailpipe replaces casing volume');
      const bad = C(Object.assign({}, base, { tpmd: 9700 }));
      assert.ok(!bad.ok && bad.bad.indexOf('tpmd') !== -1, 'tailpipe above packer rejected');
      // Page
      nav(app, 'wellkill', 'wk_root');
      set(app, { wk_tpmd: 9950 }); app.click('wk_calc');
      assert.rel(rv(app, 'wk_res', 'Friction pressure at pump rate, kill fluid'), app.win.WTS_state.wellkill.result.bullhead.friction.total, 2e-3);
      assert.rel(rv(app, 'wk_res', 'Tailpipe volume below the packer (included)'), vTp, 0.06);
      assert.includes(app.el('wk_res').textContent, 'is not displaced by the bullhead');
      noBad(assert, app, 'wellkill');
    },
  },
  {
    name: 'V3 Flowline: coupled P–T march matches the Line Heat Loss page, hand exponential decay and Joule–Thomson; linear mode unchanged',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = W.WTS_flowline_compute;
      const base = { qo: 2000, qw: 500, qg: 3, api: 35, sgg: 0.7, sgw: 1.05, pwh: 1000, t0: 120, t1: 100, psep: 0, rough: 0.0018, payne: true, accel: true,
        well: [{ name: 'l', len: 5000, id: 2.9, dz: 0 }], flare: [] };
      const lin = C(base);
      const lin2 = C(Object.assign({}, base, { tmode: 'linear', tair: 'x' }));
      assert.strictEqual(lin.well.pOut, lin2.well.pOut, 'linear mode ignores heat inputs');
      const heat = { tmode: 'heat', tair: 60, wind: 10, eps: 0.9, wall: 0.3, ins: 0, kp: 26, kins: 0.025, cpo: 0.5, cpw: 1, cpg: 0.55, jt: 0 };
      const h = C(Object.assign({}, base, heat));
      assert.ok(h.ok && h.coupled, 'coupled ok');
      // Same line on the Line Heat Loss page (independently tested engine), no choke, no JT
      const lh = W.WTS_lineheat_compute({ qo: 2000, qw: 500, qg: 3, api: 35, sgg: 0.7, sgw: 1.05, cpo: 0.5, cpw: 1, cpg: 0.55, p0: 1000, t0: 120,
        hi: '', kp: 26, kins: 0.025, eps: 0.9, tair: 60, wind: 10, tsoil: 50, ksoil: 0.7, jt: 0.07,
        segs: [{ name: 'l', len: 5000, od: 3.5, wall: 0.3, ins: '', type: 'bare' }] });
      assert.ok(Math.abs(h.tArr - lh.tArr) < 0.1, 'arrival ' + h.tArr + ' vs Line Heat Loss ' + lh.tArr);
      assert.ok(h.tArr < 100, 'bare line in 60 °F air cools below the linear 100 °F guess');
      // Hand exponential for an insulation-dominated line: R' = ln(Ds/Do)/(2πk_ins) + ln(Do/Di)/(2πk_p) + R'out,
      // R'out = 1/(h·π·Ds) with h between 1.5 and 6 Btu/hr·ft²·°F (forced + radiation, 10 mph)
      const ins = Object.assign({}, heat, { ins: 2, kins: 0.02 });
      const hi = C(Object.assign({}, base, ins));
      const Di = 2.9 / 12, Do = 3.5 / 12, Ds = 7.5 / 12;
      const Rin = Math.log(Ds / Do) / (2 * Math.PI * 0.02) + Math.log(Do / Di) / (2 * Math.PI * 26);
      const go = 141.5 / 166.5, vm = 10.7316 * 519.67 / 14.696;
      const mcp = 2000 * 5.614583 * 62.366 * go / 24 * 0.5 + 500 * 5.614583 * 62.366 * 1.05 / 24 * 1 + 3e6 / vm * 28.9647 * 0.7 / 24 * 0.55;
      const Tarr = (Rout) => 60 + (120 - 60) * Math.exp(-5000 / (Rin + Rout) / mcp);
      const tHi = Tarr(1 / (1.5 * Math.PI * Ds)), tLo = Tarr(1 / (6 * Math.PI * Ds));
      assert.ok(hi.tArr >= tLo - 0.01 && hi.tArr <= tHi + 0.01, 'insulated arrival ' + hi.tArr + ' within hand band ' + tLo + '…' + tHi);
      // Joule–Thomson alone: near-perfect insulation, μJT 0.05 °F/psi → ΔT = 0.05·Δp
      const jt = C(Object.assign({}, base, heat, { ins: 12, kins: 0.0005, jt: 0.05 }));
      const dT = 120 - jt.tArr, dp = jt.well.dp;
      assert.rel(dT, 0.05 * dp, 0.03, 'JT cooling ' + dT + ' vs 0.05·' + dp);
      // Page: coupled mode shows the calculated arrival temperature
      nav(app, 'flowline', 'fl_root');
      set(app, { fl_tmode: 'heat' }); app.click('fl_calc');
      const st = W.WTS_state.flowline;
      assert.ok(st.ok && st.result.coupled, 'page coupled');
      assert.rel(rv(app, 'fl_res', 'Arrival temperature at separator, calculated'), st.result.tArr, 2e-3);
      noBad(assert, app, 'flowline coupled');
      set(app, { fl_wind: -5 }); app.click('fl_calc');
      assert.ok(!W.WTS_state.flowline.ok && app.el('fl_wind').classList.contains('input-err'), 'heat input validated');
    },
  },
  {
    name: 'V3 Scale: Langelier by the ASTM D3739 chart fit reproduces the USBR example; Carrier form still shown',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_scale_compute;
      const r = S({ na: 93, k: 9, ca: 196.3, mg: 120.4, ba: 0.1426, sr: 0.12, cl: 1.9, hco3: 169.2, so4: 953, ph: 7.5, tds: 1566.56, t: 59, p: 14.7 });
      assert.ok(Math.abs(r.lsi.value - 0.18) < 0.01, 'LSI ' + r.lsi.value + ' vs USBR 0.18');
      assert.ok(Math.abs(r.lsi.carrier.value - 0.133) < 0.005, 'Carrier form 0.13 kept for comparison');
      // Stiff–Davis fit as published (USBR eq. 13): −0.04 against the worksheet's 0.12 (documented)
      assert.ok(Math.abs(r.sdi.value + 0.04) < 0.005, 'S&DSI ' + r.sdi.value);
      nav(app, 'scale', 'sc_root');
      assert.ok(rows(app, 'sc_res').some((x) => /Carrier/.test(x.l)), 'Carrier row');
      assert.includes(app.el('sc_res').textContent, 'ASTM D3739');
    },
  },
];
