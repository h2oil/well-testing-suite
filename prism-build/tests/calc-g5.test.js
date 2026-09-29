// prism-build/tests/calc-g5.test.js — G5 calculator audit (mechanical & electrical):
// pipesz, pumpsz, aircomp, gensz, cablesz, vdrop, elec.
//
// Every case is driven through the real page: navigate to the route, type the
// inputs, click Calculate, read the result rows, and compare with an
// INDEPENDENT hand calculation written here (Colebrook–White iterated instead of
// the app's Swamee–Jain, mass-balance gas rate, IEC 60228 resistances, …).
//
//   node prism-build/accept-test.js --html --wp G5

'use strict';

// ── page helpers ────────────────────────────────────────────────────────────
function go(app, route, system) {
  app.hook.nav(route);
  app.flush(50);
  if (system) { app.win.WTS_units.setSystem(system); app.flush(10); }
}
function setv(app, vals) {
  for (const id of Object.keys(vals)) {
    const el = app.el(id);
    if (!el) throw new Error('no input #' + id);
    el.value = String(vals[id]);            // display text (outside a canonical context)
  }
}
function calc(app, fnName) {
  const btn = app.findAll('#pgBody button').find((b) => (b.getAttribute('onclick') || '').indexOf(fnName + '(') === 0);
  if (!btn) throw new Error('no button for ' + fnName);
  app.click(btn);
  app.flush(20);
}
const num = (s) => parseFloat(String(s).replace(/,/g, '').replace(/[^\d.eE+-].*$/, ''));
function row(app, resId, label) {
  const rows = app.findAll('#' + resId + ' .rrow');
  const r = rows.find((x) => x.querySelector('.rl').textContent.trim().indexOf(label) === 0);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + app.el(resId).textContent);
  return r.querySelector('.rv').textContent.trim();
}
function tableRows(app, resId) {
  return app.findAll('#' + resId + ' table tr').slice(1).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()));
}
function title(app, resId) { const t = app.find('#' + resId + ' .rbox-title'); return t ? t.textContent.trim() : ''; }
function errText(app, resId) { const e = app.find('#' + resId + ' .val-error'); return e ? e.textContent : ''; }
function clean(app, assert, what) {
  const txt = app.el('pgBody').textContent;
  assert.ok(!/NaN|Infinity|∞|undefined/.test(txt), what + ': page shows NaN/Infinity/undefined');
  assert.deepStrictEqual(app.consoleErrors ? app.consoleErrors().map(String) : [], [], what + ': console errors');
}

// ── independent hand calculations ───────────────────────────────────────────
const G = 9.81;                                   // the app's g (heads are in m)
function colebrook(Re, relRough) {               // Darcy f, Colebrook–White (iterated)
  if (Re < 2300) return 64 / Re;
  let f = 0.02;
  for (let i = 0; i < 60; i++) f = Math.pow(-2 * Math.log10(relRough / 3.7 + 2.51 / (Re * Math.sqrt(f))), -2);
  return f;
}
const BBL = 0.158987294928, FT = 0.3048, PSI = 6894.757, FT3 = 0.028316846592;
const IN = 0.0254;

// Liquid line ΔP (psi) by Darcy–Weisbach.
function liquidLine(bpd, sg, muPas, idM, lenFt) {
  const rho = sg * 999, Q = bpd * BBL / 86400, A = Math.PI * idM * idM / 4, V = Q / A;
  const Re = rho * V * idM / muPas, f = colebrook(Re, 0.000045 / idM);
  return { V, Re, f, dP: f * (lenFt * FT / idM) * rho * V * V / 2 / PSI };
}
// Gas line: real-gas law, Z = 0.9, 80 °F, mass balance ρ·Q = ρsc·Qsc.
function gasLine(mmscfd, psig, sg, idM, lenFt) {
  const Pa = psig + 14.696, T = 539.67;
  const rho = Pa * 144 * sg * 28.9647 / (0.9 * 1545.349 * T) * 16.018463;       // kg/m³
  const rhoSc = 14.696 * 144 * sg * 28.9647 / (1545.349 * 519.67) * 16.018463;  // 60 °F, 14.696 psia
  const m = rhoSc * mmscfd * 1e6 * FT3 / 86400;                                 // kg/s
  const Q = m / rho, A = Math.PI * idM * idM / 4, V = Q / A;
  const Re = rho * V * idM / 1.5e-5, f = colebrook(Re, 0.000045 / idM);
  return { V, rho, dP: f * (lenFt * FT / idM) * rho * V * V / 2 / PSI };
}

// DNV-RP-O501 (2015) §4.7 pipe bend, written out independently from the RP steps:
//   α = atan(1/(2R)); A = ρm²·tanα·Up·D/(ρp·μm); γc = ρm/(ρp·(1.88 lnA − 6.04)) (0.1 if ≤ 0 or ≥ 0.1);
//   G = min(1, γ/γc); F = 0.6·(sinα + 7.2(sinα − sin²α))^0.6·(1 − e^(−20α));
//   E [mm/y] = 2e-9·F·Up^2.6·sinα·G·2.5·ṁp·3.15e10/(7800·πD²/4).
function dnvBendRef({ lbPerDay, vFps, dIn, rhoLbFt3, muCp, dpUm, RD }) {
  const mp = lbPerDay * 0.45359237 / 86400, Up = vFps * 0.3048, D = dIn * 0.0254;
  const rm = rhoLbFt3 * 16.018463, mu = muCp / 1000;
  const a = Math.atan(1 / (2 * RD));
  const A = rm * rm * Math.tan(a) * Up * D / (2650 * mu);
  let gc = rm / (2650 * (1.88 * Math.log(A) - 6.04));
  if (!(gc > 0) || gc >= 0.1) gc = 0.1;
  const G = Math.min(1, dpUm * 1e-6 / D / gc);
  const sa = Math.sin(a);
  const F = 0.6 * Math.pow(sa + 7.2 * (sa - sa * sa), 0.6) * (1 - Math.exp(-20 * a));
  const mmy = 2e-9 * F * Math.pow(Up, 2.6) * sa * G * 2.5 * mp * 3.15e10 / (7800 * Math.PI * D * D / 4);
  return { mmy, mpy: mmy / 0.0254, F, G, A, gc, alphaDeg: a * 180 / Math.PI };
}
// velocity-weighted mixture viscosity (gas 0.012 cP, liquid 1 cP) from the RP 14E volume terms
function muMixRef(Z, R, T, P) { const g = Z * R * T / (21.25 * P), fg = g / (9.35 + g); return 0.012 * fg + 1 * (1 - fg); }

module.exports = [
  // ── PIPE SIZING ─────────────────────────────────────────────────────────────
  {
    name: 'G5 pipesz: liquid 5000 BPD 35 API 500 ft — velocities and Darcy ΔP vs Colebrook hand calc',
    wp: 'G5',
    run(app, assert) {
      go(app, 'pipesz');
      setv(app, { pp_p: 500, pp_l: 500, pp_ql: 5000, pp_qg: 5, pp_sg: 35 });
      app.el('pp_fluid').value = 'liquid';
      calc(app, 'calcPipeSz');
      const sg = 141.5 / (35 + 131.5);
      const rows = tableRows(app, 'pp_res');
      const ids = { '2"': 2.067, '3"': 3.068, '4"': 4.026 };
      for (const r of rows) {
        if (!ids[r[0]]) continue;
        const h = liquidLine(5000, sg, 0.005, ids[r[0]] * IN, 500);
        assert.rel(num(r[1]), h.V, 0.01, r[0] + ' velocity m/s');
        assert.rel(num(r[3]), h.dP, 0.03, r[0] + ' ΔP psi (Swamee–Jain vs Colebrook)');
      }
      // 3": V = 1.93 m/s, ΔP ≈ 11.6 psi; recommended = first size inside 0.8–2.5 m/s
      assert.match(title(app, 'pp_res'), /Recommended: 3"/);
      clean(app, assert, 'pipesz liquid');
    },
  },
  {
    name: 'G5 pipesz: gas 10 MMSCFD 500 psig SG 0.65 — actual rate uses ×Z (mass balance), Imperial = Metric',
    wp: 'G5',
    run(app, assert) {
      const read = () => tableRows(app, 'pp_res').map((r) => [r[0], num(r[1]), num(r[3])]);
      go(app, 'pipesz');
      app.el('pp_fluid').value = 'gas';
      setv(app, { pp_p: 500, pp_l: 1000, pp_qg: 10, pp_sg: 0.65 });
      calc(app, 'calcPipeSz');
      const imp = read();
      const r3 = imp.find((r) => r[0] === '3"');
      const h = gasLine(10, 500, 0.65, 3.068 * IN, 1000);
      assert.rel(r3[1], h.V, 0.01, '3" gas velocity (hand ' + h.V.toFixed(2) + ' m/s)');   // ≈ 18.3 m/s
      assert.rel(r3[2], h.dP, 0.04, '3" gas ΔP (hand ' + h.dP.toFixed(2) + ' psi)');
      assert.match(title(app, 'pp_res'), /Recommended: 3"/);
      clean(app, assert, 'pipesz gas imperial');

      // Metric: 10 MMSCFD = 283.168 × 10³ m³/d, 500 psig = 3447.38 kPa(g), 1000 ft = 304.8 m
      go(app, 'pipesz', 'metric');
      app.el('pp_fluid').value = 'gas';
      setv(app, { pp_p: 3447.38, pp_l: 304.8, pp_qg: 283.168, pp_sg: 0.65 });
      calc(app, 'calcPipeSz');
      const met = read();
      // v3.0: the ΔP column follows the unit system (kPa in Metric; v1.8 showed psi in both).
      met.forEach((r, i) => { assert.rel(r[1], imp[i][1], 0.002, r[0] + ' V metric=imperial'); assert.rel(r[2] || 1e-9, (imp[i][2] * 6.894757) || 1e-9, 0.01, r[0] + ' ΔP metric = imperial × 6.894757 kPa/psi'); });
      assert.ok(app.findAll('#pp_res th').some((t) => /ΔP \(kPa\)/.test(String(t.textContent))), 'ΔP header in kPa');
      clean(app, assert, 'pipesz gas metric');
    },
  },
  {
    name: 'G5 pipesz: validation — zero rate, API typed into gas SG, vacuum → messages, no NaN',
    wp: 'G5',
    run(app, assert) {
      go(app, 'pipesz');
      app.el('pp_fluid').value = 'liquid';
      setv(app, { pp_ql: 0 }); calc(app, 'calcPipeSz');
      assert.match(errText(app, 'pp_res'), /liquid rate/i);
      app.el('pp_fluid').value = 'gas';
      setv(app, { pp_qg: 5, pp_sg: 35 }); calc(app, 'calcPipeSz');
      assert.match(errText(app, 'pp_res'), /gas SG/i);
      setv(app, { pp_sg: 0.7, pp_p: -20 }); calc(app, 'calcPipeSz');
      assert.match(errText(app, 'pp_res'), /vacuum/i);
      setv(app, { pp_p: 100, pp_qg: '' }); calc(app, 'calcPipeSz');
      assert.match(errText(app, 'pp_res'), /gas rate/i);
      clean(app, assert, 'pipesz validation');
    },
  },

  // ── PUMP SIZING ─────────────────────────────────────────────────────────────
  {
    name: 'G5 pumpsz: default crude case — TDH, hydraulic power, NPSHa vs hand calc; Metric identical',
    wp: 'G5',
    run(app, assert) {
      go(app, 'pumpsz');
      calc(app, 'calcPumpSz');
      // hand: 5000 BPD, 35 API (ρ = 849.0), 5 cP, 3" Sch 40, Ps 50 / Pd 300 psig,
      // Hs 2 m, Hd 10 m, Ls 20 m, Ld 100 m, η 65 %, Pv 2 psia; 30 % fittings, 6 % margin.
      const rho = 141.5 / 166.5 * 999, D = 3.068 * IN;
      const h = liquidLine(5000, 141.5 / 166.5, 0.005, D, 1);
      const vh = h.V * h.V / (2 * G);
      const hfS = h.f * (20 / D) * vh * 1.3, hfD = h.f * (100 / D) * vh * 1.3;
      const Hp = 250 * PSI / (rho * G);
      const TDH = (10 - 2 + Hp + hfS + hfD) * 1.06;
      const Q = 5000 * BBL / 86400;
      const kW = rho * G * Q * TDH / 0.65 / 1000;
      const NPSHa = 64.7 * PSI / (rho * G) + 2 - hfS - 2 * PSI / (rho * G);
      const tdh = num(row(app, 'ps_res', 'Total Dynamic Head'));
      assert.rel(tdh, TDH, 0.005, 'TDH m (hand ' + TDH.toFixed(1) + ')');                 // ≈ 238.3 m
      assert.rel(num(row(app, 'ps_res', 'Power Required')), kW, 0.005, 'kW (hand ' + kW.toFixed(2) + ')'); // ≈ 28.1 kW
      assert.rel(num(row(app, 'ps_res', 'NPSHa')), NPSHa, 0.005, 'NPSHa m');                // ≈ 52.3 m
      assert.rel(num(row(app, 'ps_res', 'Fluid Density')), rho, 0.001);
      clean(app, assert, 'pumpsz imperial');

      go(app, 'pumpsz', 'metric');     // the defaults are converted on screen; same physics
      calc(app, 'calcPumpSz');
      assert.rel(num(row(app, 'ps_res', 'Total Dynamic Head')), tdh, 0.002, 'TDH metric = imperial');
      clean(app, assert, 'pumpsz metric');
    },
  },
  {
    name: 'G5 pumpsz: water 10 000 BPD, 4" line — head and power; validation for zero flow / TDH ≤ 0',
    wp: 'G5',
    run(app, assert) {
      go(app, 'pumpsz');
      app.el('ps_liq').value = 'water';
      app.el('ps_pipe').value = '4';
      setv(app, { ps_q: 10000, ps_mu: 1, ps_ps: 0, ps_pd: 100, ps_hs: 3, ps_hd: 5, ps_ls: 10, ps_ld: 200, ps_eff: 70, ps_vp: 0.5 });
      calc(app, 'calcPumpSz');
      const rho = 998, D = 4.026 * IN, Q = 10000 * BBL / 86400, V = Q / (Math.PI * D * D / 4);
      const f = colebrook(rho * V * D / 0.001, 0.000045 / D), vh = V * V / (2 * G);
      const TDH = (5 - 3 + 100 * PSI / (rho * G) + f * (210 / D) * vh * 1.3) * 1.06;
      assert.rel(num(row(app, 'ps_res', 'Total Dynamic Head')), TDH, 0.005, 'TDH (hand ' + TDH.toFixed(1) + ' m)');
      assert.rel(num(row(app, 'ps_res', 'Power Required')), rho * G * Q * TDH / 0.7 / 1000, 0.005, 'kW');
      clean(app, assert, 'pumpsz water');

      setv(app, { ps_q: 0 }); calc(app, 'calcPumpSz');
      assert.match(errText(app, 'ps_res'), /flow rate/i);
      setv(app, { ps_q: 1000, ps_ps: 500, ps_pd: 0 }); calc(app, 'calcPumpSz');
      assert.match(errText(app, 'ps_res'), /no pump is needed/i);
      setv(app, { ps_ps: 0, ps_pd: 100, ps_eff: 0 }); calc(app, 'calcPumpSz');
      assert.match(errText(app, 'ps_res'), /efficiency/i);
      clean(app, assert, 'pumpsz validation');
    },
  },

  {
    name: 'G5 fix pipesz gas: 5 MMSCFD 1000 psig SG 0.7 2000 ft — 1.5" (> Ve) and 2" (ΔP > 10 %) rejected, Ve shown',
    wp: 'G5',
    run(app, assert) {
      go(app, 'pipesz');
      app.el('pp_fluid').value = 'gas';
      setv(app, { pp_p: 1000, pp_l: 2000, pp_qg: 5, pp_sg: 0.7, pp_dpmax: 10 });
      calc(app, 'calcPipeSz');
      const h15 = gasLine(5, 1000, 0.7, 1.610 * IN, 2000), h2 = gasLine(5, 1000, 0.7, 2.067 * IN, 2000);
      const rhoLb = h15.rho / 16.018463, Ve = 100 / Math.sqrt(rhoLb) * FT;   // ≈ 15.3 m/s
      assert.rel(num(row(app, 'pp_res', 'Erosional Velocity')), Ve, 0.005, 'Ve m/s');
      assert.rel(num(row(app, 'pp_res', 'Gas Density')), h15.rho, 0.005, 'gas density');
      assert.near(num(row(app, 'pp_res', 'Max ΔP')), 101.47, 0.1, '10 % of 1014.7 psia');
      assert.match(row(app, 'pp_res', 'Velocity Band Used'), /^10(\.00)? – 15\.3\d m\/s/);
      const rows = tableRows(app, 'pp_res');
      const r15 = rows.find((r) => r[0] === '1.5"'), r2 = rows.find((r) => r[0] === '2"');
      assert.ok(num(r15[1]) > Ve && h15.V > Ve, '1.5" velocity above Ve');
      assert.match(r15[2], /HIGH \(> Ve\)/);
      assert.rel(num(r2[3]), h2.dP, 0.04, '2" ΔP vs Colebrook');
      assert.ok(num(r2[3]) > 101.47, '2" ΔP above 10 % of inlet');
      assert.match(r2[2], /ΔP > 10 %/);
      // No size inside 10–15.3 m/s meets ΔP → smallest size meeting Ve+ΔP (3"), flagged as below min velocity.
      assert.match(title(app, 'pp_res'), /Recommended: 3" \(SCH 80\)/);
      assert.match(app.el('pp_res').textContent, /smallest size meeting/);
      // With a 15 % ΔP allowance, 2" (≈ 10.2 m/s, ≈ 107 psi) is inside every limit.
      setv(app, { pp_dpmax: 15 }); calc(app, 'calcPipeSz');
      assert.match(title(app, 'pp_res'), /Recommended: 2" \(SCH 80\)/);
      setv(app, { pp_dpmax: '' }); calc(app, 'calcPipeSz');
      assert.match(errText(app, 'pp_res'), /max ΔP/i);
      clean(app, assert, 'pipesz gas erosional');
    },
  },
  {
    name: 'G5 fix pipesz liquid: gravity 3–10 rejected as ambiguous (8 °API → SG hint); blank pressure rejected',
    wp: 'G5',
    run(app, assert) {
      go(app, 'pipesz');
      app.el('pp_fluid').value = 'liquid';
      setv(app, { pp_p: 150, pp_l: 1500, pp_ql: 12000, pp_sg: 8 });
      calc(app, 'calcPipeSz');
      assert.match(errText(app, 'pp_res'), /ambiguous/);
      assert.match(errText(app, 'pp_res'), /1\.0143/);            // 141.5/(8+131.5)
      setv(app, { pp_sg: 10 }); calc(app, 'calcPipeSz');
      assert.match(errText(app, 'pp_res'), /ambiguous/);
      // SG 1.0143 entered directly → 3" ΔP ≈ the 25 API value × ρ ratio (not 8×)
      setv(app, { pp_sg: 25 }); calc(app, 'calcPipeSz');
      const d25 = num(tableRows(app, 'pp_res').find((r) => r[0] === '3"')[3]);
      setv(app, { pp_sg: 1.0143 }); calc(app, 'calcPipeSz');
      const dHeavy = num(tableRows(app, 'pp_res').find((r) => r[0] === '3"')[3]);
      const hA = liquidLine(12000, 141.5 / 156.5, 0.005, 3.068 * IN, 1500), hB = liquidLine(12000, 1.0143, 0.005, 3.068 * IN, 1500);
      assert.rel(dHeavy / d25, hB.dP / hA.dP, 0.01, 'heavy/25 API ΔP ratio');
      assert.ok(dHeavy / d25 < 1.2, 'no 8× blow-up');
      // blank / non-numeric pressure → error in liquid mode too (was silent "SCH 160")
      setv(app, { pp_p: '' }); calc(app, 'calcPipeSz');
      assert.match(errText(app, 'pp_res'), /operating pressure/i);
      assert.ok(!/SCH 160/.test(app.el('pp_res').textContent), 'no SCH 160 label');
      setv(app, { pp_p: 150 }); calc(app, 'calcPipeSz');
      assert.match(title(app, 'pp_res'), /SCH 40/);
      clean(app, assert, 'pipesz liquid gravity/pressure');
    },
  },

  // ── AIR COMPRESSOR ──────────────────────────────────────────────────────────
  {
    name: 'G5 fix aircomp: exact multiples do not round up (100 → 110 SCFM, 550 gal; 50 → 55; 200 → 220)',
    wp: 'G5',
    run(app, assert) {
      go(app, 'aircomp');
      for (const [q, sel] of [[100, 110], [50, 55], [200, 220], [150, 165], [1000, 1100], [101, 112]]) {
        setv(app, { ac_q: q, ac_p: 100 }); calc(app, 'calcAirComp');
        assert.equal(num(row(app, 'ac_res', 'Selected Capacity')), sel, q + ' SCFM → ' + sel);
        assert.equal(num(row(app, 'ac_res', 'Daily Capacity')), sel * 1440, q + ' daily');
        assert.match(row(app, 'ac_res', 'Receiver Volume'), new RegExp(String(sel * 5).replace(/\B(?=(\d{3})+(?!\d))/g, ',?') + ' gal'));
      }
      clean(app, assert, 'aircomp rounding');
    },
  },
  {
    name: 'G5 aircomp: 150 SCFM → 165 SCFM (+10 %), 237 600 SCF/D, 825 gal receiver; type rules; validation',
    wp: 'G5',
    run(app, assert) {
      go(app, 'aircomp');
      setv(app, { ac_q: 150, ac_p: 100 });
      calc(app, 'calcAirComp');
      assert.equal(num(row(app, 'ac_res', 'Selected Capacity')), 165);
      assert.equal(num(row(app, 'ac_res', 'Daily Capacity')), 165 * 1440);
      const rec = row(app, 'ac_res', 'Receiver Volume');
      assert.near(num(rec), 825 * 3.78541, 1, 'receiver L');
      assert.match(rec, /825 gal/);
      assert.match(row(app, 'ac_res', 'Compressor Type'), /Rotary Screw/);
      // 20 SCFM intermittent utility → reciprocating; continuous instrument air 20 SCFM → screw
      setv(app, { ac_q: 20 }); app.el('ac_duty').value = 'int'; app.el('ac_app').value = 'util';
      calc(app, 'calcAirComp');
      assert.equal(row(app, 'ac_res', 'Compressor Type'), 'Reciprocating');
      app.el('ac_duty').value = 'cont'; app.el('ac_app').value = 'ia'; app.el('ac_of').value = 'yes';
      calc(app, 'calcAirComp');
      assert.equal(row(app, 'ac_res', 'Compressor Type'), 'Rotary Screw (Oil-Free)');
      setv(app, { ac_q: 0 }); calc(app, 'calcAirComp');
      assert.match(errText(app, 'ac_res'), /air flow/i);
      clean(app, assert, 'aircomp');
    },
  },

  // ── GENERATOR SIZING ────────────────────────────────────────────────────────
  {
    name: 'G5 gensz: default load list → 301.7 kVA / 350 kVA std, FLA 362.9 A; pf > 1 rejected; > 2000 kVA flagged',
    wp: 'G5',
    run(app, assert) {
      go(app, 'gensz');
      app.win._genMotors = app.toWin([{ kw: 30, method: 'dol', qty: 1 }, { kw: 15, method: 'sd', qty: 2 }]);
      app.win.renderGenMotors();
      setv(app, { gs_nm: 50, gs_pf: 0.8, gs_v: 480 });
      app.el('gs_mode').value = 'norm';
      calc(app, 'calcGenSz');
      // hand: run = 110 kW / 0.8 = 137.5 kVA; start = (30·5 + 15·2.2·2 + 50)/0.8 × 1.10 = 365.75 kVA
      // rated = max(137.5, 365.75/1.6) × 1.2 × 1.1 = 301.76 kVA; FLA = kVA·1000/(√3·480)
      const start = (150 + 33 + 33 + 50) / 0.8 * 1.10, recKVA = Math.max(137.5, start / 1.6) * 1.32;
      assert.near(num(row(app, 'gs_res', 'Worst-Case Starting')), start, 0.06);
      assert.near(num(row(app, 'gs_res', 'Recommended')), recKVA, 0.06);
      assert.near(num(row(app, 'gs_res', 'Full Load Current')), recKVA * 1000 / (Math.sqrt(3) * 480), 0.06);
      assert.equal(row(app, 'gs_res', 'Standard Size'), '350 kVA');
      clean(app, assert, 'gensz');

      setv(app, { gs_pf: 1.2 }); calc(app, 'calcGenSz');
      assert.match(errText(app, 'gs_res'), /no more than 1/);
      setv(app, { gs_pf: 0.8, gs_nm: 1500 }); calc(app, 'calcGenSz');
      assert.match(row(app, 'gs_res', 'Standard Size'), /> 2000 kVA/);
      setv(app, { gs_nm: '' }); calc(app, 'calcGenSz');
      assert.match(errText(app, 'gs_res'), /Non-motor load/);
      clean(app, assert, 'gensz validation');
    },
  },
  {
    name: 'G5 fix gensz: recommended label discloses ÷1.6 and ×1.2×1.1; conservative VFD/DOL/soft-start case = 382.6 kVA',
    wp: 'G5',
    run(app, assert) {
      go(app, 'gensz');
      app.win._genMotors = app.toWin([{ kw: 55, method: 'vfd', qty: 1 }, { kw: 22, method: 'dol', qty: 2 }, { kw: 7.5, method: 'ss', qty: 3 }]);
      app.win.renderGenMotors();
      setv(app, { gs_nm: 20, gs_pf: 0.85, gs_v: 480 });
      app.el('gs_mode').value = 'cons';
      calc(app, 'calcGenSz');
      // top 3 starts: DOL 110, DOL 110, VFD 66 kW; + 3×7.5 running + 20 → 328.5 kW / 0.85 × 1.2
      const start = (110 + 110 + 66 + 22.5 + 20) / 0.85 * 1.2;
      assert.near(num(row(app, 'gs_res', 'Worst-Case Starting')), start, 0.06);        // 463.8
      assert.near(num(row(app, 'gs_res', 'Starting-Limited Rating')), start / 1.6, 0.06); // 289.9
      assert.near(num(row(app, 'gs_res', 'Recommended')), start / 1.6 * 1.32, 0.06);   // 382.6
      const lbl = app.findAll('#gs_res .rl').map((e) => e.textContent).find((t) => t.indexOf('Recommended') === 0);
      assert.match(lbl, /1\.6/); assert.match(lbl, /1\.2 growth/); assert.match(lbl, /1\.1 margin/);
      clean(app, assert, 'gensz margins');
    },
  },

  // ── CABLE SIZING ────────────────────────────────────────────────────────────
  {
    name: 'G5 cablesz: 415 V 3φ 50 A 100 m 40 °C → 16 mm², ΔV from IEC 60228 R90 (11.2 V, 2.70 %)',
    wp: 'G5',
    run(app, assert) {
      go(app, 'cablesz');
      setv(app, { cs_v: 415, cs_i: 50, cs_pf: 0.85, cs_l: 100, cs_amb: 40 });
      app.el('cs_sys').value = '3'; app.el('cs_lay').value = '1.0';
      calc(app, 'calcCableSz');
      assert.match(title(app, 'cs_res'), /Recommended: 16 mm/);
      const r16 = tableRows(app, 'cs_res').find((r) => r[0] === '16');
      // R90 = 1.15 Ω/km × (1 + 0.00393·70) = 1.4664; ΔV = √3·50·(R·0.85 + 0.09·0.5268)·0.1 km
      const R = 1.15 * (1 + 0.00393 * 70), sin = Math.sqrt(1 - 0.85 * 0.85);
      const dV = Math.sqrt(3) * 50 * (R * 0.85 + 0.09 * sin) * 0.1;
      assert.near(num(r16[2]), dV, 0.006, '16 mm² ΔV (hand ' + dV.toFixed(2) + ' V)');
      assert.near(num(r16[3]), dV / 415 * 100, 0.006, '16 mm² ΔV %');
      assert.equal(num(r16[1]), Math.round(70 * 0.87), 'ampacity 70 A × 0.87 (40 °C)');
      clean(app, assert, 'cablesz');
    },
  },
  {
    name: 'G5 cablesz: 60 °C ambient uses 0.50 (IEC 60364-5-52 B.52.14) → 35 mm²; > 60 °C and pf > 1 rejected; 1φ 230 V case',
    wp: 'G5',
    run(app, assert) {
      go(app, 'cablesz');
      setv(app, { cs_v: 415, cs_i: 50, cs_pf: 0.85, cs_l: 100, cs_amb: 60 });
      app.el('cs_sys').value = '3'; app.el('cs_lay').value = '1.0';
      calc(app, 'calcCableSz');
      assert.match(title(app, 'cs_res'), /Recommended: 35 mm/, '25 mm² × 0.50 = 45 A < 50 A');
      setv(app, { cs_amb: 65 }); calc(app, 'calcCableSz');
      assert.match(errText(app, 'cs_res'), /60 °C/);
      setv(app, { cs_amb: 30, cs_pf: 1.5 }); calc(app, 'calcCableSz');
      assert.match(errText(app, 'cs_res'), /Power factor/);
      // 1-phase 230 V, 20 A, pf 1, 30 m, 30 °C: 1.5 mm² (16 A) fails ampacity; 2.5 mm²:
      // ΔV = 2·20·7.41·1.2751·0.03 = 11.34 V = 4.93 % ≤ 5 % → 2.5 mm²
      app.el('cs_sys').value = '1';
      setv(app, { cs_v: 230, cs_i: 20, cs_pf: 1, cs_l: 30 });
      calc(app, 'calcCableSz');
      assert.match(title(app, 'cs_res'), /Recommended: 2.5 mm/);
      const r = tableRows(app, 'cs_res').find((x) => x[0] === '2.5');
      assert.near(num(r[2]), 2 * 20 * 7.41 * (1 + 0.00393 * 70) * 0.03, 0.006);
      clean(app, assert, 'cablesz edge');
    },
  },

  // ── VOLTAGE DROP ────────────────────────────────────────────────────────────
  {
    name: 'G5 vdrop: 50 mm² Cu XLPE 80 A 150 m → 9.59 V (2.31 %), matches BS 7671 App. 4 mV/A/m to ~1 %',
    wp: 'G5',
    run(app, assert) {
      go(app, 'vdrop');
      setv(app, { vd_v: 415, vd_i: 80, vd_pf: 0.85, vd_l: 150 });
      app.el('vd_mm').value = '50'; app.el('vd_con').value = 'cu'; app.el('vd_ins').value = 'xlpe'; app.el('vd_sys').value = '3'; app.el('vd_lt').value = 'motor';
      calc(app, 'calcVDrop');
      const R = 0.387 * (1 + 0.00393 * 70), sin = Math.sqrt(1 - 0.85 * 0.85);
      const dV = Math.sqrt(3) * 80 * (R * 0.85 + 0.08 * sin) * 0.15;
      assert.near(num(row(app, 'vd_res', 'Voltage Drop')), dV, 0.006, 'ΔV (hand ' + dV.toFixed(2) + ')');
      // BS 7671 Table 4E2B-style check: r = 0.86, x = 0.135 mV/A/m (3φ, 90 °C, 50 mm²)
      const bs = (0.86 * 0.85 + 0.135 * sin) * 80 * 150 / 1000;
      assert.rel(num(row(app, 'vd_res', 'Voltage Drop')), bs, 0.02, 'vs tabulated mV/A/m');
      assert.equal(row(app, 'vd_res', 'Status'), 'OK');
      clean(app, assert, 'vdrop cu');
    },
  },
  {
    name: 'G5 vdrop: 95 mm² Al PVC 150 A 200 m 400 V → 18.32 V 4.58 %; sensitive limit → NOT OK; Al 6 mm² / pf 0 rejected',
    wp: 'G5',
    run(app, assert) {
      go(app, 'vdrop');
      setv(app, { vd_v: 400, vd_i: 150, vd_pf: 0.8, vd_l: 200 });
      app.el('vd_mm').value = '95'; app.el('vd_con').value = 'al'; app.el('vd_ins').value = 'pvc'; app.el('vd_sys').value = '3'; app.el('vd_lt').value = 'motor';
      calc(app, 'calcVDrop');
      const R = 0.320 * (1 + 0.00403 * 50);
      const dV = Math.sqrt(3) * 150 * (R * 0.8 + 0.075 * 0.6) * 0.2;
      assert.near(num(row(app, 'vd_res', 'Voltage Drop')), dV, 0.006);
      assert.near(num(row(app, 'vd_res', 'Drop %')), dV / 4, 0.006);
      assert.equal(row(app, 'vd_res', 'Status'), 'OK');
      app.el('vd_lt').value = 'sensitive'; calc(app, 'calcVDrop');
      assert.equal(row(app, 'vd_res', 'Status'), 'NOT OK', '4.58 % > 1.25 × 3 %');
      app.el('vd_mm').value = '6'; calc(app, 'calcVDrop');
      assert.match(errText(app, 'vd_res'), /Aluminium/);
      app.el('vd_mm').value = '95'; setv(app, { vd_pf: 0 }); calc(app, 'calcVDrop');
      assert.match(errText(app, 'vd_res'), /Power factor/);
      clean(app, assert, 'vdrop al');
    },
  },

  // ── ELECTRICAL & PUMPS ──────────────────────────────────────────────────────
  {
    name: 'G5 elec: 3φ current I = P/(√3·V·pf); kW↔HP round-trips; guards',
    wp: 'G5',
    run(app, assert) {
      go(app, 'elec');
      setv(app, { el_v: 400, el_kw: 37, el_pf: 0.85 });
      calc(app, 'calcElec');
      const I = 37000 / (Math.sqrt(3) * 400 * 0.85);                               // 62.83 A
      assert.near(num(row(app, 'el_res', 'Full Load Current')), I, 0.051);
      assert.near(num(row(app, 'el_res', 'Startup Current')), I * 7, 0.51);
      setv(app, { el_kw2: 100 }); app.click(app.findAll('#pgBody button').find((b) => /kwToHP/.test(b.getAttribute('onclick')))); app.flush(5);
      assert.equal(app.el('el_hp').value, '134.1', '100 kW = 134.1 hp (745.7 W/hp)');
      app.click(app.findAll('#pgBody button').find((b) => /hpToKW/.test(b.getAttribute('onclick')))); app.flush(5);
      assert.equal(app.el('el_kw2').value, '100.0', 'round trip back to 100 kW');
      setv(app, { el_pf: 0 }); calc(app, 'calcElec');
      assert.match(errText(app, 'el_res'), /power factor/);
      clean(app, assert, 'elec');
    },
  },
  {
    name: 'G5 elec: triplex mud pump 6.25" × 12" 96 % 54 SPM × 2 → 4.590 gal/stk, 495.7 gpm; SPM label has no "(Hz)"; Metric identical',
    wp: 'G5',
    run(app, assert) {
      go(app, 'elec');
      setv(app, { mp_d: 6.25, mp_sl: 12, mp_eff: 96, mp_spm: 54, mp_n: 2 });
      calc(app, 'calcMudPump');
      // triplex: bbl/stk = 0.000243·D²·L·eff = 0.10935 (exact 3·π/4·D²·L·eff/9702 = 0.10929)
      const gal = 3 * Math.PI / 4 * 6.25 * 6.25 * 12 * 0.96 / 231;
      assert.rel(num(row(app, 'mp_res', 'Displacement/Stroke').split('(')[1]), gal, 0.001, 'gal/stk');
      assert.rel(gal / 42, 0.000243 * 6.25 * 6.25 * 12 * 0.96, 0.002, 'field formula 0.000243·D²·L·eff');
      const gpm = gal * 54 * 2;
      assert.near(num(row(app, 'mp_res', 'Flow Rate (GPM)')), gpm, 0.06);
      assert.near(num(row(app, 'mp_res', 'Flow Rate (BPM)')), gpm / 42, 0.006);
      assert.near(num(row(app, 'mp_res', 'Strokes per Barrel')), 42 / gal, 0.06);
      const lab = app.el('mp_spm').closest('.fg-item').querySelector('label').textContent;
      assert.ok(!/Hz/.test(lab), 'SPM label: ' + lab);
      clean(app, assert, 'mud pump imperial');

      go(app, 'elec', 'metric');
      setv(app, { mp_d: 158.75, mp_sl: 304.8, mp_eff: 96, mp_spm: 54, mp_n: 2 });
      calc(app, 'calcMudPump');
      // v3.0: Metric shows L/min, m³/min, L per stroke (v1.8 showed gpm / bpm in Metric too).
      assert.near(num(row(app, 'mp_res', 'Flow Rate (L/min)')), gpm * 3.785411784, 0.06, 'metric L/min = gpm × 3.785411784');
      assert.near(num(row(app, 'mp_res', 'Flow Rate (m³/min)')), gpm / 42 * 0.158987295, 0.0006);
      assert.near(num(row(app, 'mp_res', 'Displacement/Stroke')), gal * 3.785411784, 0.0006, 'L per stroke');
      assert.ok(!/Hz/.test(app.el('mp_spm').closest('.fg-item').querySelector('label').textContent));
      clean(app, assert, 'mud pump metric');
    },
  },

  // ── EROSIONAL VELOCITY & SAND QUICK CHECK (roadmap #15, card on pipesz) ─────
  {
    name: 'G5 pipesz erosion card: RP 14E ρm, Ve = C/√ρm, Vm and minimum ID vs hand calc and first principles; C table; sand screen on one line',
    wp: 'G5',
    run(app, assert) {
      go(app, 'pipesz');
      assert.ok(app.el('ev_res'), 'card present');
      setv(app, { ev_svc: 'cont', ev_sol: 'free', ev_c: '', ev_p: 500, ev_t: 100, ev_ql: 5000, ev_glr: 1000, ev_sl: 0.85, ev_sg: 0.7, ev_z: 0.9, ev_id: 3.826, ev_sand: '' });
      calc(app, 'calcPipeErosion');
      const P = 514.696, T = 559.67, QL = 5000, R = 1000, S1 = 0.85, Sg = 0.7, Z = 0.9, D = 3.826;
      // API RP 14E eq. (2.2) and (2.3), written out here
      const rho = (12409 * S1 * P + 2.7 * R * Sg * P) / (198.7 * P + R * T * Z);
      // first principles per barrel of liquid: mass (water 62.37 lb/ft³, 379.5 scf/lb-mol) / in-situ volume
      const mass = S1 * 62.37 * 5.6146 + R * Sg * 28.9647 / 379.5, vol = 5.6146 + R * (14.696 / P) * (T / 519.67) * Z;
      assert.rel(rho, mass / vol, 5e-3, 'RP 14E ρm vs first principles');
      const st = app.win.WTS_state.pipeErosion;
      assert.rel(st.rho, rho, 1e-9, 'ρm'); assert.strictEqual(st.C, 100, 'continuous solids-free C = 100');
      const Ve = 100 / Math.sqrt(rho);
      assert.rel(st.Ve, Ve, 1e-9, 'Ve');
      const A = Math.PI / 4 * D * D, Vm = QL / 1000 * (9.35 + Z * R * T / (21.25 * P)) / A;
      assert.rel(st.Vm, Vm, 1e-9, 'Vm (RP 14E area form)');
      assert.rel(st.Vm, QL * vol / 86400 / (A / 144), 5e-3, 'Vm vs first principles');
      const dMin = Math.sqrt(4 / Math.PI * QL / 1000 * (9.35 + Z * R * T / (21.25 * P)) / Ve);
      assert.rel(st.dMin, dMin, 1e-9, 'minimum ID');
      assert.near(num(row(app, 'ev_res', 'Erosional velocity')), Math.round(Ve * 10) / 10, 1e-9, 'Ve row (ft/s)');
      assert.near(num(row(app, 'ev_res', 'Minimum ID')), Math.round(dMin * 1000) / 1000, 1e-9, 'min ID row');
      assert.includes(row(app, 'ev_res', 'Sand erosion screen'), 'No sand rate entered');
      assert.includes(app.el('ev_res').textContent, '✓ Mixture velocity is below the erosional velocity');
      // Sand: 2 lb/MMscf × 5 MMscf/d = 10 lb/d. v3.0: DNV-RP-O501 (2015) pipe bend, hand calc from the RP
      // steps (R/D 1.5, 250 µm, GF 1, steel K 2e-9, n 2.6, ρt 7800, C1 2.5, sand 2650 kg/m³, Cunit 3.15e10).
      // v1.8 used the calibrated fit 2.8·W·V²/D² = 222.1 mpy (5.64 mm/y → ⚠ at any sand rate).
      setv(app, { ev_sand: 2 }); calc(app, 'calcPipeErosion');
      const Eref = dnvBendRef({ lbPerDay: 2 * 5, vFps: Vm, dIn: D, rhoLbFt3: rho, muCp: muMixRef(Z, R, T, P), dpUm: 250, RD: 1.5 });
      assert.rel(app.win.WTS_state.pipeErosion.E, Eref.mpy, 1e-6, 'DNV bend erosion vs hand calc (mpy)');
      assert.ok(Eref.mmy > 1e-4 && Eref.mmy < 0.1, 'well below 0.1 mm/y: ' + Eref.mmy);
      assert.ok(222 / Eref.mpy > 100, 'v1.8 fit read > 100× higher');
      const sl = row(app, 'ev_res', 'Sand erosion screen');
      assert.near(num(sl), Eref.mpy, 0.0006, 'mpy on the one line (3 dp)'); assert.includes(sl, 'mm/y'); assert.includes(sl, 'lb/MMscf'); assert.includes(sl, 'DNV');
      assert.includes(app.el('ev_res').textContent, '✓ Sand erosion is within 0.1 mm/y');
      // Linear in sand rate: the 0.1 mm/y threshold is crossed at W = 2·0.1/E(2) lb/MMscf.
      const Wcrit = 2 * 0.1 / Eref.mmy;
      setv(app, { ev_sand: Wcrit * 1.02 }); calc(app, 'calcPipeErosion');
      assert.rel(app.win.WTS_state.pipeErosion.E, Eref.mpy * Wcrit * 1.02 / 2, 1e-6, 'linear in sand');
      assert.includes(app.el('ev_res').textContent, '⚠ Sand erosion exceeds 0.1 mm/y');
      setv(app, { ev_sand: Wcrit * 0.98 }); calc(app, 'calcPipeErosion');
      assert.includes(app.el('ev_res').textContent, '✓ Sand erosion is within 0.1 mm/y');
      // A tighter bend (R/D 1 → α 26.6°) erodes more than a 5D bend (α 5.7°).
      setv(app, { ev_sand: 2, ev_rd: 1 }); calc(app, 'calcPipeErosion'); const E1 = app.win.WTS_state.pipeErosion.E;
      setv(app, { ev_rd: 5 }); calc(app, 'calcPipeErosion'); const E5 = app.win.WTS_state.pipeErosion.E;
      assert.rel(E1, dnvBendRef({ lbPerDay: 10, vFps: Vm, dIn: D, rhoLbFt3: rho, muCp: muMixRef(Z, R, T, P), dpUm: 250, RD: 1 }).mpy, 1e-6);
      assert.ok(E1 > E5, 'R/D 1 > R/D 5');
      setv(app, { ev_rd: 1.5, ev_dp: 0 }); calc(app, 'calcPipeErosion');
      assert.includes(errText(app, 'ev_res'), 'particle size');
      setv(app, { ev_dp: 250, ev_sand: 2 });
      // C selection: intermittent / sand / override
      const Cof = (svc, sol) => { setv(app, { ev_svc: svc, ev_sol: sol, ev_c: '' }); calc(app, 'calcPipeErosion'); return app.win.WTS_state.pipeErosion.C; };
      assert.strictEqual(Cof('int', 'free'), 125, 'RP 14E intermittent');
      assert.strictEqual(Cof('cont', 'sand'), 70, 'sand continuous (conservative choice)');
      assert.strictEqual(Cof('int', 'sand'), 100, 'sand intermittent (conservative choice)');
      setv(app, { ev_c: 150 }); calc(app, 'calcPipeErosion');
      assert.strictEqual(app.win.WTS_state.pipeErosion.C, 150); assert.includes(row(app, 'ev_res', 'C-factor'), 'entered');
      // Too small a line → ✗ and the minimum ID
      setv(app, { ev_svc: 'cont', ev_sol: 'free', ev_c: '', ev_id: 2.9, ev_sand: '' }); calc(app, 'calcPipeErosion');
      assert.ok(!app.win.WTS_state.pipeErosion.velOk, 'Vm > Ve');
      assert.includes(app.el('ev_res').textContent, '✗ Mixture velocity exceeds the erosional velocity');
      // Validation
      setv(app, { ev_ql: 0, ev_z: 5 }); calc(app, 'calcPipeErosion');
      assert.includes(errText(app, 'ev_res'), 'Liquid rate must be greater than zero');
      assert.includes(errText(app, 'ev_res'), 'Z-factor must be between');
      setv(app, { ev_ql: 5000, ev_z: 0.9, ev_id: 3.826 }); calc(app, 'calcPipeErosion');
      clean(app, assert, 'pipesz erosion');
      // Metric: same physical case entered in SI, same state
      go(app, 'pipesz', 'metric');
      setv(app, { ev_p: 500 * 6.89476, ev_t: (100 - 32) / 1.8, ev_ql: 5000 * 0.158987, ev_glr: 1000 * 0.0283168466 / 0.158987294928, ev_id: 3.826 * 25.4 });
      calc(app, 'calcPipeErosion');
      assert.rel(app.win.WTS_state.pipeErosion.Ve, Ve, 1e-5, 'metric Ve');
      assert.rel(app.win.WTS_state.pipeErosion.Vm, Vm, 1e-5, 'metric Vm');
      assert.includes(row(app, 'ev_res', 'Erosional velocity'), 'm/s');
      assert.includes(row(app, 'ev_res', 'Mixture density'), 'kg/m³');
      assert.includes(row(app, 'ev_res', 'Minimum ID'), 'mm');
      app.win.WTS_units.setSystem('imperial');
      clean(app, assert, 'pipesz erosion metric');
    },
  },

  // ── EXPORT ──────────────────────────────────────────────────────────────────
  {
    name: 'G5 report export: collectPageReport captures inputs and results for every G5 page',
    wp: 'G5',
    run(app, assert) {
      // pipesz / cablesz results are <table>s (captured through table.rows / tr.cells,
      // which the harness DOM models); the labels below are checked on the kv items.
      const pages = { pipesz: ['calcPipeSz', 'Liquid Rate', null], pumpsz: ['calcPumpSz', 'Flow Rate', 'Total Dynamic Head'],
        aircomp: ['calcAirComp', 'Air Flow', 'Selected Capacity'], gensz: ['calcGenSz', 'Power Factor', 'Standard Size'],
        cablesz: ['calcCableSz', 'Load Current', null], vdrop: ['calcVDrop', 'Load Current', 'Receiving End Voltage'],
        elec: ['calcElec', 'Supply Voltage', 'Full Load Current'] };
      for (const route of Object.keys(pages)) {
        const [fn, inLabel, outLabel] = pages[route];
        go(app, route);
        calc(app, fn);
        const model = app.win.collectPageReport(null, { charts: false });
        const s = JSON.stringify(model);
        assert.ok(s.indexOf(inLabel) !== -1, route + ': report has input "' + inLabel + '"');
        if (outLabel) assert.ok(s.indexOf(outLabel) !== -1, route + ': report has result "' + outLabel + '"');
        assert.ok(!/NaN|Infinity/.test(s), route + ': report free of NaN');
      }
      clean(app, assert, 'export');
    },
  },
];
