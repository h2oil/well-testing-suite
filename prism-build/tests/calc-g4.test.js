// Calculator audit G4 — Safety & relief, driven through the real page
// (host nav → set inputs → Calculate → read result rows).
//
//   flare · prv · flamearr · arc · esdhi · esdlo · hydrate · liquidline · pipelife
//
// Expected values are independent hand calculations:
//   • API 521 flame length fit L[m] = 0.00326·Q[W]^0.478 (Annex example
//     Q = 6.15e8 W → L ≈ 52 m); point-source D = √(τ·F·Q/(4π·K)).
//   • API 520 Part I: gas Eq. 2 / subcritical F2 form, steam 51.5 form,
//     liquid 38·Kd·Kw·Kc·Kv form (Kv from R = 2800·Q·G/(μ√A)); Kb/Kw for
//     balanced bellows only (straight-line Fig. 30 / Fig. 32); API 526 areas.
//   • Crane TP-410: ΔP = K·ρ·V²/(2·gc·144); compressible discharge
//     w = 0.525·Y·d²·√(ΔP·ρ1/K) with Fig. A-22 limits (k = 1.3).
//   • Critical-flow Cv gas equation Q[scfh] = 816·Cv·P1/√(G·T).
//   • Towler & Mokhatab (2005) hydrate T; Hammerschmidt inhibitor balance.
//   • ASME B31.3 Eq. 3a, S = min(UTS/3, 2Sy/3).
// Tests for the ESD / hydrate / liquid-line / pipe-life pages (round 5) used to
// force opts.fromSources while round 5 was unbuilt; round 5 is now rebuilt, so
// they follow the runner mode (--html exercises the built HTML).
'use strict';

const WP = 'G4';
const SRC = {};

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function num(s) {
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
  if (!m) throw new Error('no number in: ' + s);
  return parseFloat(m[0]);
}
function rv(app, resId, label) {
  const r = rows(app, resId).find((x) => x.l.indexOf(label) !== -1);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId)));
  return num(r.v);
}
function rvText(app, resId, label) {
  const r = rows(app, resId).find((x) => x.l.indexOf(label) !== -1);
  return r ? r.v : null;
}
// Table row whose first cell STARTS WITH `first` → array of cell texts.
// (reportHas() below checks .fg-item/.rrow/notes; the harness DOM models
// table.rows / tr.cells, so collectPageReport captures tables here too.)
function trow(app, rootId, first) {
  const tr = app.findAll('#' + rootId + ' tr').find((r) => {
    const c = r.querySelector('td'); return c && String(c.textContent).trim().indexOf(first) === 0;
  });
  if (!tr) throw new Error('no table row "' + first + '" in #' + rootId);
  return tr.querySelectorAll('td').map ? tr.querySelectorAll('td').map((c) => String(c.textContent).trim())
    : Array.prototype.map.call(tr.querySelectorAll('td'), (c) => String(c.textContent).trim());
}
function errText(app, resId) {
  return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | ');
}
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|∞|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function setMetric(app, on) { app.win.WTS_units.setSystem(on ? 'metric' : 'imperial'); }
function set(app, vals) { for (const k of Object.keys(vals)) app.input(k, String(vals[k])); }
function reportHas(app, assert, needles) {
  const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
  const s = JSON.stringify(model);
  for (const n of needles) assert.includes(s, n, 'page report contains ' + n);
  assert.ok(model.inputs.length > 0, 'report has input sections');
  assert.ok(model.results.length > 0, 'report has result sections');
}

// ── Independent references ───────────────────────────────────────────────
const W_PER_BTUH = 0.29307107;
function gasC(k) { return 520 * Math.sqrt(k * Math.pow(2 / (k + 1), (k + 1) / (k - 1))); }
function kvRef(A, Q, G, mu) {
  const R = Q * 2800 * G / (mu * Math.sqrt(A));
  return 1 / (0.9935 + 2.878 / Math.sqrt(R) + 342.75 / Math.pow(R, 1.5));
}
function liquidAreaRef(Q, G, mu, dp, Kd, Kw) {
  let Kv = 1, A = 0;
  for (let i = 0; i < 50; i++) {
    A = Q / (38 * Kd * Kw * Kv) * Math.sqrt(G / dp);
    const nk = kvRef(Math.max(A, 0.110), Q, G, mu);
    if (Math.abs(nk - Kv) < 1e-7) { Kv = nk; A = Q / (38 * Kd * Kw * Kv) * Math.sqrt(G / dp); break; }
    Kv = nk;
  }
  return A;
}
function crane(tankPsig, idIn, L, SG, TF) {
  const P1 = tankPsig + 14.7, M = SG * 28.9647, T = TF + 459.67, rho = P1 * M / (10.732 * T);
  const f = 0.25 / Math.pow(Math.log10(0.0018 / (3.7 * idIn)), 2);
  const K = f * L / (idIn / 12) + 1.5;
  const KT = [1.2, 1.5, 2, 3, 4, 6, 8, 10, 15, 20, 40, 100];
  const XT = [0.525, 0.55, 0.593, 0.642, 0.678, 0.722, 0.75, 0.773, 0.807, 0.831, 0.877, 0.92];
  const YT = [0.612, 0.631, 0.635, 0.658, 0.67, 0.685, 0.698, 0.705, 0.718, 0.718, 0.718, 0.718];
  let i = 0; while (i < KT.length - 2 && K > KT[i + 1]) i++;
  const fr = (Math.log(K) - Math.log(KT[i])) / (Math.log(KT[i + 1]) - Math.log(KT[i]));
  const xl = XT[i] + fr * (XT[i + 1] - XT[i]), yl = YT[i] + fr * (YT[i + 1] - YT[i]);
  let x = tankPsig / P1, Y; if (x >= xl) { x = xl; Y = yl; } else Y = 1 - (1 - yl) * x / xl;
  const w = 0.525 * Y * idIn * idIn * Math.sqrt(x * P1 * rho / K);
  return w * 86400 / M * 379.49 / 1e6;
}
function idealOrificeMMscfd(d64, P1, SG, TR) {
  const A = Math.PI / 4 * Math.pow(d64 / 64, 2), M = 28.9647 * SG;
  const W = gasC(1.27) * A * P1 * Math.sqrt(M / TR);     // lb/h, Kd = 1
  return W / M * 379.49 * 24 / 1e6;
}
function towler(Ppsia, SG) {
  const a = Math.log(Ppsia), b = Math.log(SG);
  return 13.47 * a + 34.27 * b - 1.675 * a * b - 20.35;
}

module.exports = [
  // ── Flare (API 521) ────────────────────────────────────────────────────
  {
    name: 'G4 flare: 10 MMSCFD default — Q, API 521 flame length (SI fit), point-source radii, labels',
    wp: WP,
    run(app, assert) {
      app.hook.nav('flare'); app.flush(300);
      app.win.calcFlare();
      const Qb = 10e6 / 24 * 1000 * 0.98;                       // 408,333,333 BTU/h
      const QW = Qb * W_PER_BTUH;
      assert.near(rv(app, 'fl_res', 'Heat Release (MW)'), QW / 1e6, 0.01);
      const Lm = 0.00326 * Math.pow(QW, 0.478);                  // 23.7 m (was 13.0)
      assert.near(rv(app, 'fl_res', 'Flame Length (m)'), Lm, 0.06);
      assert.near(rv(app, 'fl_res', 'Flame Length (ft)'), Lm / 0.3048, 0.06);
      const r = (I) => Math.sqrt(0.2 * 1 * QW / 1000 / (4 * Math.PI * I));
      assert.near(num(trow(app, 'fl_res', '500 BTU')[3]), r(1.58), 0.06);   // 34.7 m
      assert.near(num(trow(app, 'fl_res', '3000 BTU')[3]), r(9.46), 0.06);  // 14.2 m
      assert.includes(trow(app, 'fl_res', '1500 BTU')[0], '2–3 min');
      assert.includes(trow(app, 'fl_res', '2000 BTU')[0], '30 s');
      noBadNumbers(assert, app, 'flare');
      reportHas(app, assert, ['Gas Flow Rate', 'Flame Length']);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G4 flare: API 521 annex anchor Q = 6.15e8 W → L ≈ 52 m; calm wind accepted; bad inputs rejected',
    wp: WP,
    run(app, assert) {
      app.hook.nav('flare'); app.flush(300);
      const flow = 6.15e8 / W_PER_BTUH * 24 / (1000 * 1e6);    // MMSCFD at 1000 BTU/scf, 100 %
      set(app, { fl_flow: flow, fl_nhv: 1000, fl_eff: 100 });
      app.win.calcFlare();
      assert.within(rv(app, 'fl_res', 'Flame Length (m)'), 50, 54);
      // Calm wind: 0 m/s must not be replaced by the 5 m/s default (tilt ≈ 0°)
      set(app, { fl_W: 0 });
      app.win.calcFlare();
      assert.ok(rv(app, 'fl_res', 'Flame Tilt Angle') < 1, 'calm wind gives ~vertical flame');
      set(app, { fl_flow: 0 }); app.win.calcFlare();
      assert.match(errText(app, 'fl_res'), /Gas Flow Rate/);
      set(app, { fl_flow: -5 }); app.win.calcFlare();
      assert.match(errText(app, 'fl_res'), /Gas Flow Rate/);
      set(app, { fl_flow: 10, fl_F: 1.5 }); app.win.calcFlare();
      assert.match(errText(app, 'fl_res'), /Fraction Heat Radiated/);
      noBadNumbers(assert, app, 'flare invalid');
      // Navigating away before the 120 ms auto-calc timer must not throw.
      app.hook.nav('flare'); app.hook.nav('prv'); app.flush(300);
      assert.deepEqual(app.errors.map((e) => e.message), []);
    },
  },

  {
    name: 'G4 flare (v3.0): fl_flow / fl_nhv stay native field units (untagged); Metric mode shows SI companions (10³ m³/d, MJ/m³)',
    wp: WP,
    run(app, assert) {
      // Imperial: no companion text
      app.hook.nav('flare'); app.flush(300);
      assert.strictEqual(String(app.el('fl_flow_si').textContent), '', 'no companion in Imperial');
      setMetric(app, true);
      try {
        app.hook.nav('flare'); app.flush(300);
        set(app, { fl_flow: 10, fl_nhv: 1000 });
        // 1 MMSCF = 10⁶·0.0283168466 m³ = 28.3168 10³ m³; 1 Btu/scf = 1055.056 J / 0.0283168466 m³ = 0.0372589 MJ/m³
        const qt = String(app.el('fl_flow_si').textContent), ht = String(app.el('fl_nhv_si').textContent);
        assert.includes(qt, '10³ m³/d'); assert.includes(ht, 'MJ/m³');
        assert.near(num(qt.replace('= ', '')), 10 * 28.3168466, 0.06, 'flow companion');
        assert.near(num(ht.replace('= ', '')), 1000 * 1055.05585 / 0.0283168466 / 1e6, 0.006, 'NHV companion');
        // The inputs themselves are not converted (the page is natively mixed-unit)
        assert.strictEqual(String(app.el('fl_flow').value), '10');
        app.win.calcFlare();
        const Qb = 10e6 / 24 * 1000 * 0.98;
        assert.near(rv(app, 'fl_res', 'Heat Release (MW)'), Qb * W_PER_BTUH / 1e6, 0.01, 'same physical result in Metric');
      } finally { setMetric(app, false); }
      noBadNumbers(assert, app, 'flare companions');
    },
  },

  // ── PRV (API 520 / 526) ────────────────────────────────────────────────
  {
    name: 'G4 prv gas: conventional default A = 2.546 in² (L); Kb = 1 for conventional; balanced 40 % BP → Kb 0.845',
    wp: WP,
    run(app, assert) {
      app.hook.nav('prv');
      app.win.calcPRVgas();
      const P1 = 250 * 1.1 + 14.7, T = 760;
      const A = 50000 / (gasC(1.4) * 0.975 * P1) * Math.sqrt(T / 28.97);
      assert.near(rv(app, 'pg_res', 'Gas Coefficient C'), 356.1, 0.06);
      assert.near(rv(app, 'pg_res', 'Required Area A'), A, 2e-4);       // 2.5464 (was 2.771 with Kb 0.919)
      assert.near(rv(app, 'pg_res', 'Kb'), 1, 1e-9);
      assert.includes(rvText(app, 'pg_res', 'Selected API 526 Orifice'), 'L (2.853');
      // Balanced bellows, Pb = 100 psig = 40 % of set → Fig. 30 (10 % OP): 1 − 0.10·1.55
      app.select('pg_vtype', 'balanced'); set(app, { pg_pb: 100 });
      app.win.calcPRVgas();
      assert.near(rv(app, 'pg_res', 'Kb'), 0.845, 1e-3);
      assert.near(rv(app, 'pg_res', 'Required Area A'), A / 0.845, 2e-3);
      assert.includes(rvText(app, 'pg_res', 'Selected API 526 Orifice'), 'M (3.6');
      reportHas(app, assert, ['Set Pressure', 'Required Area A']);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G4 prv gas: subcritical Eq. 12 (Pb 200 psig); k = 1 rejected; metric entry gives same area',
    wp: WP,
    run(app, assert) {
      app.hook.nav('prv');
      set(app, { pg_pb: 200 });
      app.win.calcPRVgas();
      const P1 = 289.7, P2 = 214.7, r = P2 / P1, k = 1.4;
      const F2 = Math.sqrt(k / (k - 1) * Math.pow(r, 2 / k) * (1 - Math.pow(r, (k - 1) / k)) / (1 - r));
      const A = 50000 / (735 * F2 * 0.975) * Math.sqrt(760 / (28.97 * P1 * (P1 - P2)));
      assert.includes(rvText(app, 'pg_res', 'Flow Regime'), 'Subcritical');
      assert.near(rv(app, 'pg_res', 'Required Area A'), A, 2e-4);
      set(app, { pg_pb: 30, pg_k: 1 });
      app.win.calcPRVgas();
      assert.match(errText(app, 'pg_res'), /Specific Heat Ratio/);
      noBadNumbers(assert, app, 'prv k=1');
      // Metric: same physical case entered in kPa(g), °C, kg/h
      app.hook.nav('home'); setMetric(app, true); app.hook.nav('prv');
      set(app, { pg_ps: 250 * 6.894757, pg_pb: 30 * 6.894757, pg_t: (300 - 32) / 1.8, pg_w: 50000 * 0.45359237, pg_k: 1.4 });
      app.win.calcPRVgas();
      // Metric results: area in mm² (1 in² = 645.16 mm²), P1 = 289.7 psia = 1,997 kPa(a)
      assert.near(rv(app, 'pg_res', 'Required Area A'), 2.5464 * 645.16, 1.5);
      assert.includes(rvText(app, 'pg_res', 'Required Area A'), 'mm²');
      assert.near(rv(app, 'pg_res', 'Relieving Pressure P₁'), 289.7 * 6.894757, 1);
      assert.includes(rvText(app, 'pg_res', 'Relieving Pressure P₁'), 'kPa(a)');
    },
  },
  {
    name: 'G4 prv liquid: certified 200 gpm (Kv iterated); non-certified uses 1.25·Ps − Pb; steam 51.5 form',
    wp: WP,
    run(app, assert) {
      app.hook.nav('prv');
      app.click('prvt3');
      app.win.calcPRVliquid();
      const Acert = liquidAreaRef(200, 0.85, 1.0, 330 - 30, 0.65, 1);
      assert.near(rv(app, 'pl_res', 'Required Area A'), Acert, 2e-4);          // ≈ 0.4297 in²
      app.select('pl_cert', 'no');
      app.select('pl_op', '25');
      app.win.calcPRVliquid();
      const Anc = liquidAreaRef(200, 0.85, 1.0, 1.25 * 300 - 30, 0.62, 1);    // Δp = 345 (was 382.5), Kp(25 %) = 1
      assert.near(rv(app, 'pl_res', 'Required Area A'), Anc, 2e-4);
      assert.near(rv(app, 'pl_res', 'Kp'), 1, 1e-9);
      app.select('pl_op', '10');
      app.win.calcPRVliquid();                                                  // Kp(10 %) ≈ 0.6 (Fig. 37)
      assert.near(rv(app, 'pl_res', 'Required Area A'), liquidAreaRef(200, 0.85, 1.0, 345, 0.62 * 0.6, 1), 2e-4);
      app.select('pl_op', '25');
      // Balanced bellows, Pb 30/300 = 10 % → Kw = 1 (Fig. 32 flat to 15 %)
      app.select('pl_cert', 'yes'); app.select('pl_vtype', 'balanced');
      app.win.calcPRVliquid();
      assert.near(rv(app, 'pl_res', 'Kw'), 1, 1e-9);
      app.click('prvt2');
      app.win.calcPRVsteam();
      assert.near(rv(app, 'ps_res', 'Required Area A'), 10000 / (51.5 * 564.7 * 0.975), 2e-4); // 0.3527
      app.select('ps_type', 'sup'); set(app, { ps_t: '' });
      app.win.calcPRVsteam();
      assert.match(errText(app, 'ps_res'), /Superheat temperature/);
      noBadNumbers(assert, app, 'prv liquid/steam');
    },
  },
  {
    name: 'G4 prv liquid regression: non-certified 10 % OP applies Kp 0.6 (150 psig, 500 gpm → 2.574 in², L); basis 1.25·Ps shown',
    wp: WP,
    run(app, assert) {
      app.hook.nav('prv');
      app.click('prvt3');
      set(app, { pl_ps: 150, pl_pb: 0, pl_q: 500, pl_sg: 1.0, pl_mu: 1 });
      app.select('pl_cert', 'no'); app.select('pl_op', '10'); app.select('pl_vtype', 'conv'); app.select('pl_rd', 'no');
      app.win.calcPRVliquid();
      const A25 = liquidAreaRef(500, 1.0, 1, 187.5, 0.62, 1);                  // 1.544 in² without Kp
      const A10 = liquidAreaRef(500, 1.0, 1, 187.5, 0.62 * 0.6, 1);            // ≈ 2.574 in²
      assert.near(A25, 1.544, 2e-3);
      assert.near(rv(app, 'pl_res', 'Kp'), 0.6, 1e-9);
      assert.near(rv(app, 'pl_res', 'Required Area A'), A10, 2e-4);
      assert.within(rv(app, 'pl_res', 'Required Area A'), 2.56, 2.59);
      assert.includes(rvText(app, 'pl_res', 'Selected API 526 Orifice'), 'L (2.853');
      assert.near(rv(app, 'pl_res', 'Relieving Pressure'), 165, 1e-6);
      assert.includes(rvText(app, 'pl_res', 'Sizing Basis'), '187.5');
      assert.includes(rvText(app, 'pl_res', 'Equation Used'), '10% OP');
      assert.ok(!/25% OP/.test(rvText(app, 'pl_res', 'Equation Used')), 'equation label follows the selected overpressure');
      app.select('pl_op', '25'); app.win.calcPRVliquid();
      assert.near(rv(app, 'pl_res', 'Required Area A'), A25, 2e-4);
      assert.includes(rvText(app, 'pl_res', 'Selected API 526 Orifice'), 'K (1.838');
      app.select('pl_cert', 'yes'); app.win.calcPRVliquid();                  // certified: no Kp row
      assert.ok(!rows(app, 'pl_res').some((r) => r.l.indexOf('Kp') !== -1), 'certified result has no Kp row');
      noBadNumbers(assert, app, 'prv liquid Kp');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G4 prv metric regression: Steam / Liquid / Gas tabs keep kPa(g), °C, L/min after tab switches; gas area unchanged',
    wp: WP,
    run(app, assert) {
      const label = (id) => { const e = app.el(id); const it = e && e.parentNode; const l = it && it.querySelector('label'); return l ? String(l.textContent) : ''; };
      const shown = (id) => parseFloat(app.win.WTS_units.displayValue(app.el(id)));
      app.hook.nav('home'); setMetric(app, true); app.hook.nav('prv'); app.flush(100);
      assert.includes(label('pg_ps'), 'kPa(g)');
      assert.near(shown('pg_ps'), 250 * 6.89476, 0.2);
      app.click('prvt2'); app.flush(10);
      assert.includes(label('ps_ps'), 'kPa(g)');
      assert.near(shown('ps_ps'), 500 * 6.89476, 0.2);
      assert.includes(label('ps_w'), 'kg/hr');
      app.click('prvt3'); app.flush(10);
      assert.includes(label('pl_ps'), 'kPa(g)');
      assert.includes(label('pl_q'), 'L/min');
      assert.near(shown('pl_q'), 200 * 3.78541, 0.2);
      app.click('prvt1'); app.flush(10);
      assert.includes(label('pg_ps'), 'kPa(g)');
      assert.includes(label('pg_t'), '°C');
      assert.near(shown('pg_ps'), 250 * 6.89476, 0.2);
      assert.near(shown('pg_t'), (300 - 32) / 1.8, 0.06);                  // 148.9 °C (1 dp display)
      app.win.calcPRVgas();
      assert.near(rv(app, 'pg_res', 'Required Area A'), 2.5464 * 645.16, 1.5);   // mm² in Metric
      // Round trip back to imperial restores the canonical values.
      app.hook.nav('home'); setMetric(app, false); app.hook.nav('prv'); app.flush(100);
      app.click('prvt3'); app.click('prvt1'); app.flush(10);
      assert.includes(label('pg_ps'), 'psig');
      assert.near(shown('pg_ps'), 250, 1e-6);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G4 prv inlet line: Crane ΔP includes gc (default 3" line ≈ 18.3 psi, 7.3 % → FAIL)',
    wp: WP,
    run(app, assert) {
      app.hook.nav('prv');
      app.click('prvt4');
      app.win.calcPRVinlet();
      const A = Math.PI / 4 * Math.pow(3.068 / 12, 2), V = 50000 / (3600 * 1.2 * A);
      const K = 0.018 * 15 * 12 / 3.068 + 0.5 + 2 * 30 * 0.018 + 8 * 0.018;
      const dP = K * 1.2 * V * V / (2 * 32.174 * 144);
      assert.near(rv(app, 'pi_res', 'Gas Velocity'), V, 0.01);
      assert.near(rv(app, 'pi_res', 'Inlet ΔP'), dP, 0.01);                  // 18.3 psi (was 588)
      assert.includes(rvText(app, 'pi_res', 'Status'), 'FAIL');
      set(app, { pi_el: '', pi_gv: '' });                                      // blank = none, no NaN
      app.win.calcPRVinlet();
      noBadNumbers(assert, app, 'prv inlet blank fittings');
    },
  },

  // ── Flame arrestor ─────────────────────────────────────────────────────
  {
    name: 'G4 flamearr: 500 MSCFD MW 18 @ 30 °C → 364.6 ACFM; Crane ΔP with K 11 → 3" recommended; metric same',
    wp: WP,
    run(app, assert) {
      app.hook.nav('flamearr');
      app.win.calcFlameArr();
      const TR = 86 + 460, acfm = 500e3 / 1440 * TR / 520, rho = 14.7 * 18 / (10.7316 * TR);
      assert.near(rv(app, 'fa_res', 'ACFM'), acfm, 0.1);
      assert.near(rv(app, 'fa_res', 'Gas Density'), rho, 1e-4);
      const dp = (id, K) => { const V = acfm / (Math.PI / 4 * Math.pow(id / 12, 2)) / 60; return K * rho * V * V / (2 * 32.174 * 144); };
      assert.near(num(trow(app, 'fa_res', '3"')[2]), dp(3.068, 11), 2e-3);   // 0.751 psi
      assert.near(num(trow(app, 'fa_res', '2"')[2]), dp(2.067, 11), 2e-3);   // 3.645 psi → FAIL
      assert.includes(app.el('fa_res').textContent, 'Recommended: 3"');
      set(app, { fa_k: 30 }); app.win.calcFlameArr();
      assert.near(num(trow(app, 'fa_res', '4"')[2]), dp(4.026, 30), 2e-3);
      set(app, { fa_q: 0 }); app.win.calcFlameArr();
      assert.match(errText(app, 'fa_res'), /Gas Flow/);
      noBadNumbers(assert, app, 'flamearr');
      app.hook.nav('home'); setMetric(app, true); app.hook.nav('flamearr');
      set(app, { fa_q: 500 * 28.316847, fa_p: 0, fa_dp: 6.894757, fa_k: '' });
      app.win.calcFlameArr();
      assert.near(rv(app, 'fa_res', 'ACFM'), acfm, 0.2);
      assert.includes(app.el('fa_res').textContent, 'Recommended: 3"');
      reportHas(app, assert, ['Gas MW', 'ACFM']);
    },
  },
  {
    name: 'G4 flamearr metric regression: ΔP / velocity / density results shown in kPa, m/s, kg/m³ (same units as the ΔP input)',
    wp: WP,
    run(app, assert) {
      const TR = 86 + 460, acfm = 500e3 / 1440 * TR / 520, rho = 14.7 * 18 / (10.7316 * TR);
      const V = (id) => acfm / (Math.PI / 4 * Math.pow(id / 12, 2)) / 60;          // ft/s
      const dp = (id) => 11 * rho * V(id) * V(id) / (2 * 32.174 * 144);            // psi
      const hdr = () => app.findAll('#fa_res th').map((t) => String(t.textContent));
      // Imperial: psi / ft/s headers, psi values
      app.hook.nav('flamearr'); app.win.calcFlameArr();
      assert.ok(hdr().some((h) => /ΔP \(psi\)/.test(h)), 'imperial ΔP header in psi: ' + hdr());
      assert.ok(hdr().some((h) => /Velocity \(ft\/s\)/.test(h)), 'imperial velocity header in ft/s');
      assert.near(num(trow(app, 'fa_res', '3"')[1]), V(3.068), 0.06);
      assert.near(rv(app, 'fa_res', 'Allowable'), 1, 1e-9);
      // Metric: same case entered in m³/d and kPa
      app.hook.nav('home'); setMetric(app, true); app.hook.nav('flamearr');
      set(app, { fa_q: 500 * 28.3168, fa_p: 0, fa_dp: 6.89476, fa_k: '' });
      app.win.calcFlameArr();
      assert.ok(hdr().some((h) => /ΔP \(kPa\)/.test(h)), 'metric ΔP header in kPa: ' + hdr());
      assert.ok(hdr().some((h) => /Velocity \(m\/s\)/.test(h)), 'metric velocity header in m/s');
      assert.near(num(trow(app, 'fa_res', '3"')[2]), dp(3.068) * 6.89476, 0.01);   // ≈ 5.18 kPa
      assert.near(num(trow(app, 'fa_res', '3"')[1]), V(3.068) * 0.3048, 0.06);     // m/s
      assert.near(rv(app, 'fa_res', 'Gas Density'), rho * 16.0185, 2e-3);         // kg/m³
      assert.includes(rows(app, 'fa_res').find((r) => r.l.indexOf('Gas Density') !== -1).l, 'kg/m³');
      assert.near(rv(app, 'fa_res', 'Allowable'), 6.89476, 1e-3);
      assert.includes(rows(app, 'fa_res').find((r) => r.l.indexOf('Allowable') !== -1).l, 'kPa');
      assert.includes(trow(app, 'fa_res', '3"')[3], 'OK');
      assert.includes(trow(app, 'fa_res', '2"')[3], 'FAIL');
      assert.includes(app.el('fa_res').textContent, 'Recommended: 3"');
      noBadNumbers(assert, app, 'flamearr metric');
      // Flip back to imperial without recalculating: outputs revert to psi.
      setMetric(app, false);
      assert.near(num(trow(app, 'fa_res', '3"')[2]), dp(3.068), 2e-3);
      assert.ok(hdr().some((h) => /ΔP \(psi\)/.test(h)), 'header back to psi after flip');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },

  // ── ARC (automatic recirculation) valve ────────────────────────────────
  {
    name: 'G4 arc: Pd@Qmin = Pn + 0.6(Pso − Pn) = 440 psig, ΔP 390, 3.31 m³/h → 1.5"; invalid rejected; metric same',
    wp: WP,
    run(app, assert) {
      app.hook.nav('arc');
      app.win.calcARC();
      assert.near(rv(app, 'av_res', 'discharge'), 440, 1e-6);
      assert.near(rv(app, 'av_res', 'Bypass'), 390, 1e-6);
      assert.near(rv(app, 'av_res', 'Recirc Flow'), 500 * 0.158987 / 24, 0.01);
      assert.includes(rvText(app, 'av_res', 'Recommended Valve'), '1.5"');
      set(app, { av_qmin: 6000 }); app.win.calcARC();
      assert.match(errText(app, 'av_res'), /Min process flow/);
      set(app, { av_qmin: '' }); app.win.calcARC();
      assert.match(errText(app, 'av_res'), /Min Process Flow/);
      noBadNumbers(assert, app, 'arc');
      app.hook.nav('home'); setMetric(app, true); app.hook.nav('arc');
      set(app, { av_qn: 5000 * 0.158987, av_qmin: 500 * 0.158987, av_pso: 500 * 6.894757, av_pdn: 350 * 6.894757, av_ret: 50 * 6.894757 });
      app.win.calcARC();
      assert.near(rv(app, 'av_res', 'Bypass'), 390, 0.2);
    },
  },

  // ── ESD Hi-Pilot (prism-build/23) ──────────────────────────────────────
  {
    name: 'G4 esdhi: heater shell 292 ft³ @ 23 °F — inventory referred to 60 °F; t_fill 0.235 s FAIL; 1 MMscfd PASS',
    wp: WP, opts: SRC,
    run(app, assert) {
      app.hook.nav('esdhi');
      app.click('wts_esdhi_calc');
      const Vstd = 292 * 519.67 / (23 + 459.67);
      const q = 39.28e6 / 86400;
      const cell = (lbl) => num(trow(app, 'wts_esdhi_results', lbl)[1]);
      assert.near(cell('Inventory @ Hi-Pilot'), Vstd * 144.7 / 14.7, 1);          // 3,095 scf
      assert.near(cell('Time to reach RV'), Vstd * 5 / 14.7 / q, 0.006);          // 0.235 s
      assert.near(cell('Gas released'), q * 5, 1);
      assert.includes(app.el('wts_esdhi_results').textContent, 'FAIL');
      set(app, { wts_esdhi_q: 1 });
      app.click('wts_esdhi_calc');
      assert.near(cell('Time to reach RV'), Vstd * 5 / 14.7 / (1e6 / 86400), 0.006); // 9.24 s
      assert.includes(app.el('wts_esdhi_results').textContent, 'PASS');
      set(app, { wts_esdhi_volume: '' });
      app.click('wts_esdhi_calc');
      assert.match(app.el('wts_esdhi_results').textContent, /Section volume must be > 0/);
      noBadNumbers(assert, app, 'esdhi');
      set(app, { wts_esdhi_volume: 292 }); app.click('wts_esdhi_calc');
      reportHas(app, assert, ['Section Volume', 'Rationale', 'PASS']);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },

  // ── ESD Lo-Pilot (prism-build/24) ──────────────────────────────────────
  {
    name: 'G4 esdlo: 4.36 ft³, 0.05 MMscfd, 5 s → ΔP 9.76 psi, PSL 1956 psig; blanks rejected',
    wp: WP, opts: SRC,
    run(app, assert) {
      app.hook.nav('esdlo');
      set(app, { wts_esdlo_volume: 4.36, wts_esdlo_pflow: 1971, wts_esdlo_qleak: 0.05, wts_esdlo_whsip: 1500, wts_esdlo_tresp: 5, wts_esdlo_margin: 5 });
      app.click('wts_esdlo_calc_btn');
      const dP = 0.05e6 / 86400 * 5 * 14.7 / 4.36;
      assert.near(num(trow(app, 'wts_esdlo_results', 'Pressure drop')[1]), dP, 0.01);
      assert.near(rv(app, 'wts_esdlo_results', 'Recommended PSL setpoint'), 1971 - dP - 5, 0.51);
      assert.includes(app.el('wts_esdlo_status').textContent, 'PSL reachable');
      set(app, { wts_esdlo_whsip: 2100 }); app.click('wts_esdlo_calc_btn');
      assert.includes(app.el('wts_esdlo_status').textContent, 'below WHSIP');
      set(app, { wts_esdlo_volume: '' }); app.click('wts_esdlo_calc_btn');
      assert.match(app.el('wts_esdlo_results').textContent, /Section volume must be > 0/);
      noBadNumbers(assert, app, 'esdlo');
    },
  },

  // ── Hydrate (prism-build/25) ───────────────────────────────────────────
  {
    name: 'G4 hydrate: Towler–Mokhatab T_hyd (SG 0.6 @ 1000 psia ≈ 61 °F, rises with SG); Hammerschmidt MeOH rate',
    wp: WP, opts: SRC,
    run(app, assert) {
      const Th = app.win.WTS_hydrate_temp;
      assert.near(Th(1000, 0.6), towler(1000, 0.6), 1e-9);
      assert.within(Th(1000, 0.6), 59, 64);                                   // Katz chart ≈ 61-62 °F
      assert.ok(Th(1000, 0.7) > Th(1000, 0.6), 'heavier gas → higher hydrate T');
      app.hook.nav('hydrate'); app.flush(10);
      set(app, { wts_hydrate_sg: 0.65, wts_hydrate_qw: 400, wts_hydrate_safety: 5 });
      for (let i = 0; i < 4; i++) set(app, { ['wts_hydrate_inj_' + i]: 0 });
      app.click('wts_hydrate_run');
      const TH = towler(885 + 14.696, 0.65);
      const dT = TH - (41 - 5);
      const W = dT * 32 * 100 / (2335 + dT * 32);
      const mi = 400 * 350 / 24 * W / (100 - W);
      const cc = mi / 6.6 * 3785.41 / 60 * 1.30;
      const r = trow(app, 'wts_hydrate_summary', 'WH Choke → Heater Inlet');
      assert.near(num(r[1]), TH, 0.06);
      assert.near(num(r[3]), dT, 0.06);
      assert.near(num(r[4]), W, 0.06);
      assert.near(num(r[5]), cc, 0.06 * cc / 100 + 0.1);
      noBadNumbers(assert, app, 'hydrate');
      // Results are a plain table (not visible to the harness DOM) — inputs only here.
      const hm = JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
      assert.includes(hm, 'Gas SG'); assert.includes(hm, 'Upstream P');
    },
  },

  // ── Liquid line / RO (prism-build/26) ──────────────────────────────────
  {
    name: 'G4 liquidline: 4" LCV Cv 230 @ 1440 psig blowby 313.6 MMscfd; Crane vent 29.5 MMscfd; RO ideal-nozzle',
    wp: WP, opts: SRC,
    run(app, assert) {
      app.hook.nav('liquidline'); app.flush(10);
      app.click('wts_ll_calc_btn');
      const P1 = 1454.7, TR = 559.67, SG = 0.78;
      const qLcv = 816 * 230 * P1 / Math.sqrt(SG * TR) * 24 / 1e6;
      const qVent = crane(50, 6.065, 100, SG, 100);
      const cell = (lbl) => num(trow(app, 'wts_ll_results', lbl)[1]);
      assert.near(cell('Max Gas Rate Through LCV'), qLcv, 0.01);
      assert.near(cell('Vent Line Max Capacity'), qVent, 0.01);
      assert.near(cell('Installed RO Throughput'), idealOrificeMMscfd(58, P1, SG, TR), 0.01);
      // Required bore: ideal-nozzle flow at that bore equals the vent capacity
      const dReq = cell('Required RO Bore');
      assert.near(idealOrificeMMscfd(dReq, P1, SG, TR), qVent, 0.05);
      assert.includes(trow(app, 'wts_ll_results', 'RO Required?')[1], 'YES');
      // Tank rated 5 psig, 2" × 300 ft vent — subsonic branch of Crane
      assert.near(app.win.WTS_vent_capacity(2, 40, 300, 5, 0.65, 60), crane(5, 2.067, 300, 0.65, 60), 1e-6);
      noBadNumbers(assert, app, 'liquidline');
    },
  },

  // ── Pipe life (prism-build/27) ─────────────────────────────────────────
  {
    name: 'G4 pipelife: B31.3 MAWP (4" SCH80 A333-6 → 3186 psig), mixture velocity, B36.10 XXS walls',
    wp: WP, opts: SRC,
    run(app, assert) {
      app.storage.removeItem && app.storage.removeItem('wts_pipelife');
      app.hook.nav('pipelife'); app.flush(500);
      const mawp = (S, t, od) => 2 * S * t / (od - 0.8 * t);
      assert.near(num(app.el('wts_pl_seg1_mawp').textContent), mawp(20000, 0.337, 4.5), 1);          // 3186
      assert.near(num(app.el('wts_pl_seg2_mawp').textContent), mawp(66700 / 3, 0.674, 4.5), 1);      // 7566 (X52)
      // Choke → Heater: 10 MMscfd at 500 psig / 100 °F + 1200 bpd liquid in 3" (ID 2.396")
      const acfs = 10e6 / 86400 * (14.696 / 514.696) * (559.67 / 519.67) + 1200 * 5.615 / 86400;
      const v = acfs / (Math.PI / 4 * Math.pow(2.396 / 12, 2));
      assert.near(num(app.el('wts_pl_seg3_vel').textContent), v, 0.06);                            // 116.2 ft/s
      assert.near(app.win.WTS_PIPELIFE_SCHEDULES['4'].XXH, 0.674, 1e-9);
      assert.near(app.win.WTS_PIPELIFE_SCHEDULES['6'].XXH, 0.864, 1e-9);
      noBadNumbers(assert, app, 'pipelife');
      reportHas(app, assert, ['Sand Production', 'Overall min RSL']);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
];
