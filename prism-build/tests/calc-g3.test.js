// G3 calculator audit — Separation, vessels & heat.
//   sep      Separator Retention Time        (calcSepRetention)
//   seprate  Separator Rating, Souders–Brown (calcSepRate)
//   sephand  Separator Handling Estimator    (calcSepHandling / _shCompute)
//   vessel   ASME VIII-1 shell / 2:1 head    (calcVesselShell / calcVesselHead)
//   heater   Indirect heater duty            (calcHeater)
//   chem     Chemical injection + chloride   (calcChem / renderChemTable / calcChloride)
//
// Every expected value below is an INDEPENDENT hand calculation (the helper
// maths in this file, not the app's code), driven through the real page:
// set the inputs, click the Calculate button, read the result rows.
// Field units internally; metric cases type metric values into the unit-
// tagged inputs and must give the same physical answer.
'use strict';

// ── page helpers ────────────────────────────────────────────────────────────
function go(app, route, metric) {
  if (metric) app.win.WTS_units.setSystem('metric');
  app.hook.nav(route);
  app.flush(50);
}
function setv(app, id, v) {
  const el = app.el(id);
  if (!el) throw new Error('missing input #' + id);
  if (el.tagName === 'SELECT') app.select(el, String(v)); else app.input(el, String(v));
}
function setAll(app, map) { Object.keys(map).forEach((k) => setv(app, k, map[k])); }
function press(app, fnName) {
  const btn = app.findAll('#pgBody button').find((b) => (b.getAttribute('onclick') || '').indexOf(fnName + '(') === 0);
  if (!btn) throw new Error('no button for ' + fnName);
  app.click(btn);
  app.flush(20);
}
function text(app, id) { const el = app.el(id); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
// First number in the value cell of the result row whose label contains `label`.
function rowNum(app, resId, label, nth) {
  const rows = app.findAll('#' + resId + ' .rrow');
  const hits = rows.filter((r) => { const l = r.querySelector('.rl'); return l && l.textContent.indexOf(label) !== -1; });
  const row = hits[nth || 0];
  if (!row) throw new Error('row "' + label + '" not found in #' + resId + ': ' + text(app, resId).slice(0, 300));
  const v = row.querySelector('.rv').textContent.replace(/,/g, '');
  const m = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i.exec(v);
  return m ? parseFloat(m[0]) : NaN;
}
function rowText(app, resId, label) {
  const row = app.findAll('#' + resId + ' .rrow').find((r) => { const l = r.querySelector('.rl'); return l && l.textContent.indexOf(label) !== -1; });
  return row ? row.querySelector('.rv').textContent.replace(/\s+/g, ' ').trim() : '';
}
function clean(assert, app, resId) {
  const t = text(app, resId);
  assert(!/NaN|Infinity|undefined/.test(t), '#' + resId + ' shows NaN/Infinity/undefined: ' + t.slice(0, 200));
  assert.deepStrictEqual(app.consoleErrors().map(String), [], 'no console errors');
}
function hasError(assert, app, resId, needle) {
  const errs = app.findAll('#' + resId + ' .val-error').map((e) => e.textContent);
  assert(errs.length > 0, '#' + resId + ' should show a validation message');
  if (needle) assert(errs.some((e) => e.indexOf(needle) !== -1), 'expected "' + needle + '" in ' + JSON.stringify(errs));
  clean(assert, app, resId);
}

// ── independent reference maths (field units) ───────────────────────────────
const BBL_M3 = 0.158987, FT3_GAL = 7.48052;
function segFrac(h) { const th = 2 * Math.acos(1 - 2 * h); return (th - Math.sin(th)) / (2 * Math.PI); } // circular-segment area / full area
function sepRateRef(o) {
  const P = o.p + 14.7, T = o.t + 460, Z = 0.9;
  const rhoO = 141.5 / (o.api + 131.5) * 62.4, rhoL = rhoO * (1 - o.bsw) + 62.4 * o.bsw;
  const rhoG = P * o.gsg * 28.97 / (Z * 10.7316 * T);
  const K = (o.orient === 'V' ? { low: 0.15, med: 0.10, high: 0.06 } : { low: 0.35, med: 0.25, high: 0.15 })[o.foam];
  const vAllow = K * Math.sqrt((rhoL - rhoG) / rhoG);
  const A = Math.PI * Math.pow(o.id / 12, 2) / 4;
  const fl = o.orient === 'V' ? o.nll : segFrac(o.nll);
  const Agas = o.orient === 'V' ? A : A * (1 - fl);
  const qa = o.qg * 1e6 * (14.7 / P) * (T / 520) * Z / 86400;          // ft³/s, V ∝ Z
  const lf = { low: 0.85, med: 0.75, high: 0.65 }[o.foam];
  const Vbbl = A * fl * o.len * 0.85 * lf * FT3_GAL / 42;
  const ret = Vbbl / (o.qo / (1 - o.bsw) / 1440);
  return { rhoG, rhoL, vAllow, vGas: qa / Agas, Vbbl, ret };
}
function papay(Ppr, Tpr) { return 1 - 3.52 * Ppr / Math.pow(10, 0.9813 * Tpr) + 0.274 * Ppr * Ppr / Math.pow(10, 0.8157 * Tpr); }
function sepHandRef(o) {
  const TR = o.tC * 1.8 + 32 + 460, TK = o.tC + 273.15, P = o.p + 14.7, Pd = o.pd + 14.7;
  const Tpc = 169.2 + 349.5 * o.gsg - 74 * o.gsg * o.gsg, Ppc = 756.8 - 131 * o.gsg - 3.6 * o.gsg * o.gsg; // Sutton 1985
  const Z = papay(P / Ppc, TR / Tpc), Zd = papay(Pd / Ppc, TR / Tpc);
  const MW = o.gsg * 28.97;
  const rhoG = P * 6894.76 * MW / (Z * 8314.46 * TK);
  const rhoGd = Pd * 6894.76 * MW / (Zd * 8314.46 * TK);
  const rhoO = 141500 / (o.api + 131.5), rhoL = rhoO * (1 - o.bsw) + 1000 * o.bsw;
  const K = 0.30 * 1.5; // horizontal, low foam, mesh pad = 0.45 ft/s (GPSA Sec. 7 mesh pad 0.40–0.50)
  const vAllow = K * Math.sqrt((rhoL - rhoG) / rhoG) * 0.3048;           // density ratio is unit-free
  const D = o.id * 0.0254, A = Math.PI * D * D / 4;
  const qa = o.qg * 1e6 * (14.7 / P) * (TR / 520) * Z / 86400 * 0.0283168; // m³/s
  const qd = o.qg * 1e6 * (14.7 / Pd) * (TR / 520) * Zd / 86400 * 0.0283168;
  const vGas = qa / (A * (1 - segFrac(o.nll)));
  const vPCV = qd / (Math.PI * Math.pow(o.pcv * 0.0254, 2) / 4);
  const vEros = 100 / Math.sqrt(rhoGd * 0.062428) * 0.3048;              // API RP 14E, C = 100
  const Vliq = A * segFrac(o.nll) * o.len * 0.3048;
  const qo = o.q * BBL_M3 / 86400, qw = o.q * o.bsw / (1 - o.bsw) * BBL_M3 / 86400;
  const retO = Vliq * o.oilFrac / qo / 60, retW = Vliq * (1 - o.oilFrac) / qw / 60;
  // Gas PCV Cv: q_scfh = 963·Cv·√(ΔP(P1+P2)/(G·T)), ΔP ≤ P1/2 (choked)
  const dp = Math.min(P - Pd, P / 2);
  const cvG = o.qg * 1e6 / 24 / (963 * Math.sqrt(dp * (2 * P - dp) / (o.gsg * TR)));
  const cvO = qo * 15850.323 * Math.sqrt(rhoO / 1000 / o.dplcv);
  return { Z, rhoG, vAllow, vGas, vPCV, vEros, retO, retW, cvG, cvO };
}

const SH_DEFAULTS = { id: 42, len: 12.5, nll: 0.5, oilFrac: 0.6, p: 500, pd: 100, tC: 40, q: 3000, qg: 5, gsg: 0.75, api: 35, bsw: 0.2, pcv: 2, dplcv: 25 };

module.exports = [
  // ── sep ───────────────────────────────────────────────────────────────────
  {
    name: 'G3 sep: retention time = V·level / q (defaults, 17.4 bbl @ 50 %, 6600 BPD)',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sep');
      setAll(app, { sp_cap: 17.4, sp_lvl: 50, sp_q: 6600 });
      press(app, 'calcSepRetention');
      const V = 17.4 * 0.5, t = V / (6600 / 1440);                 // 8.7 bbl, 1.8982 min
      assert.near(rowNum(app, 'sp_res', 'Fluid Volume'), V, 0.005);
      assert.near(rowNum(app, 'sp_res', 'Retention Time', 1), t, 0.005, 'minutes');
      assert.includes(rowText(app, 'sp_res', 'Retention Time'), '1:54');
      clean(assert, app, 'sp_res');
    },
  },
  {
    name: 'G3 sep: mm:ss never shows 60 seconds; validation for zero / blank inputs',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sep');
      setAll(app, { sp_cap: 10, sp_lvl: 100, sp_q: 10 * 1440 / 1.995 });   // 1.995 min → 2:00
      press(app, 'calcSepRetention');
      assert.includes(rowText(app, 'sp_res', 'Retention Time'), '2:00');
      setv(app, 'sp_q', 0); press(app, 'calcSepRetention');
      hasError(assert, app, 'sp_res', 'Flow rate');
      setv(app, 'sp_q', 6600); setv(app, 'sp_lvl', ''); press(app, 'calcSepRetention');
      hasError(assert, app, 'sp_res', 'Fluid level');
      setv(app, 'sp_lvl', 150); press(app, 'calcSepRetention');
      hasError(assert, app, 'sp_res', 'Fluid level');
    },
  },
  {
    name: 'G3 sep: metric inputs (m³, m³/d) give the same retention time',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sep', true);
      setAll(app, { sp_cap: 17.4 * BBL_M3, sp_lvl: 50, sp_q: 6600 * BBL_M3 });
      press(app, 'calcSepRetention');
      assert.near(rowNum(app, 'sp_res', 'Retention Time', 1), 8.7 / (6600 / 1440), 0.005);
      clean(assert, app, 'sp_res');
    },
  },
  // ── seprate ───────────────────────────────────────────────────────────────
  {
    name: 'G3 seprate: Souders–Brown defaults — actual gas volume uses ×Z (not ÷Z)',
    wp: 'G3',
    run(app, assert) {
      go(app, 'seprate');
      const o = { orient: 'H', id: 36, len: 10, nll: 0.5, p: 500, t: 100, qo: 3000, qg: 5, api: 35, gsg: 0.75, bsw: 0.05, foam: 'low' };
      setAll(app, { sr_orient: 'H', sr_id: 36, sr_len: 10, sr_nll: 50, sr_p: 500, sr_t: 100, sr_qo: 3000, sr_qg: 5, sr_api: 35, sr_gsg: 0.75, sr_bsw: 5, sr_foam: 'low' });
      press(app, 'calcSepRate');
      const r = sepRateRef(o);   // ρg 2.068 lb/ft³, v_allow 1.746, v_gas 0.453 ft/s, 4.55 bbl, 2.07 min
      assert.near(rowNum(app, 'sr_res', 'Gas Density'), r.rhoG, 0.001);
      assert.near(rowNum(app, 'sr_res', 'Allowable Gas Velocity'), r.vAllow, 0.006);
      assert.near(rowNum(app, 'sr_res', 'Actual Gas Velocity'), r.vGas, 0.006);
      assert.near(r.vGas, 0.4533, 0.001, 'hand calc');
      assert.near(rowNum(app, 'sr_res', 'Liquid Volume'), r.Vbbl, 0.006);
      assert.near(rowNum(app, 'sr_res', 'Retention Time'), r.ret, 0.006);
      clean(assert, app, 'sr_res');
    },
  },
  {
    name: 'G3 seprate: horizontal NLL 25 % uses segment area; vertical uses full bore for gas',
    wp: 'G3',
    run(app, assert) {
      go(app, 'seprate');
      const base = { id: 36, len: 10, p: 500, t: 100, qo: 3000, qg: 5, api: 35, gsg: 0.75, bsw: 0.05, foam: 'low' };
      setAll(app, { sr_orient: 'H', sr_id: 36, sr_len: 10, sr_nll: 25, sr_p: 500, sr_t: 100, sr_qo: 3000, sr_qg: 5, sr_api: 35, sr_gsg: 0.75, sr_bsw: 5, sr_foam: 'low' });
      press(app, 'calcSepRate');
      let r = sepRateRef(Object.assign({ orient: 'H', nll: 0.25 }, base));
      assert.near(rowNum(app, 'sr_res', 'Actual Gas Velocity'), r.vGas, 0.006);
      assert.near(rowNum(app, 'sr_res', 'Liquid Volume'), r.Vbbl, 0.006);
      setAll(app, { sr_orient: 'V', sr_nll: 50 });
      press(app, 'calcSepRate');
      r = sepRateRef(Object.assign({ orient: 'V', nll: 0.5 }, base));
      assert.near(rowNum(app, 'sr_res', 'Actual Gas Velocity'), r.vGas, 0.006);          // 0.227 ft/s
      assert.near(rowNum(app, 'sr_res', 'Allowable Gas Velocity'), r.vAllow, 0.006);      // K 0.15
      clean(assert, app, 'sr_res');
    },
  },
  {
    name: 'G3 seprate: validation (BS&W 100 %, blank ID, zero oil rate) and metric parity',
    wp: 'G3',
    run(app, assert) {
      go(app, 'seprate');
      setv(app, 'sr_bsw', 100); press(app, 'calcSepRate');
      hasError(assert, app, 'sr_res', 'BS');
      setv(app, 'sr_bsw', 5); setv(app, 'sr_id', ''); press(app, 'calcSepRate');
      hasError(assert, app, 'sr_res', 'Separator ID');
      setv(app, 'sr_id', 36); setv(app, 'sr_qo', 0); press(app, 'calcSepRate');
      clean(assert, app, 'sr_res');
      assert.includes(rowText(app, 'sr_res', 'Retention Time'), 'no liquid flow');
    },
  },
  {
    name: 'G3 seprate: metric inputs give the same Souders–Brown result',
    wp: 'G3',
    run(app, assert) {
      go(app, 'seprate', true);
      // 914.4 mm, 3.048 m, 3447.38 kPa(g), 37.778 °C, 476.96 m³/d, 141.584 Mm³/d
      setAll(app, { sr_orient: 'H', sr_id: 914.4, sr_len: 3.048, sr_nll: 50, sr_p: 500 * 6.894757, sr_t: (100 - 32) / 1.8,
        sr_qo: 3000 * BBL_M3, sr_qg: 5 * 28.316847, sr_api: 35, sr_gsg: 0.75, sr_bsw: 5, sr_foam: 'low' });
      press(app, 'calcSepRate');
      const r = sepRateRef({ orient: 'H', id: 36, len: 10, nll: 0.5, p: 500, t: 100, qo: 3000, qg: 5, api: 35, gsg: 0.75, bsw: 0.05, foam: 'low' });
      assert.near(rowNum(app, 'sr_res', 'Actual Gas Velocity'), r.vGas * 0.3048, 0.002);   // m/s
      assert.near(rowNum(app, 'sr_res', 'Retention Time'), r.ret, 0.006);
      const t = String(app.el('sr_res').textContent);
      assert.ok(!/ft\/s|lb\/ft|bbls/.test(t), 'no field units in metric results: ' + t);
      assert.ok(/m\/s/.test(t) && /kg\/m³/.test(t) && /m³/.test(t), 'metric units shown');
      clean(assert, app, 'sr_res');
    },
  },
  // ── sephand ───────────────────────────────────────────────────────────────
  {
    name: 'G3 sephand: defaults — Sutton/Papay Z, ×Z gas volume, downstream Z, choked gas Cv',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sephand');
      press(app, 'calcSepHandling');
      const r = sepHandRef(SH_DEFAULTS);
      // Z 0.906, v_gas 0.103 m/s, PCV 109.8 m/s, erosional 46.9 m/s, Cv 9.98
      assert.near(rowNum(app, 'sh_res', 'Z-factor'), r.Z, 0.0006);
      assert.near(rowNum(app, 'sh_res', 'Gas density'), r.rhoG, 0.006);
      assert.near(rowNum(app, 'sh_res', 'Allowable gas velocity'), r.vAllow, 0.006);
      assert.near(rowNum(app, 'sh_res', 'Actual gas velocity'), r.vGas, 0.006);
      assert.near(rowNum(app, 'sh_res', 'Oil retention'), r.retO, 0.06);
      assert.near(rowNum(app, 'sh_res', 'Water retention'), r.retW, 0.06);
      const t = text(app, 'sh_res');
      const pcv = /Gas PCV \(downstream\)2"×1([\d.]+) m\/s ✗([\d.]+)/.exec(t);
      assert(pcv, 'PCV outlet row present');
      assert.near(parseFloat(pcv[1]), r.vPCV, 0.01, 'PCV velocity');
      assert.near(parseFloat(pcv[2]), r.vEros, 0.01, 'API RP 14E erosional (downstream)');
      const cv = /Gas PCV \(per line, ×1\)400 \(choked\)([\d.]+) \(at flow ([\d.]+)\)/.exec(t);
      assert(cv, 'gas Cv row shows choked ΔP');
      assert.near(parseFloat(cv[2]), r.cvG, 0.05, 'gas Cv at flow');
      assert.near(parseFloat(cv[1]), r.cvG / 0.5, 0.1, 'gas Cv at 50 % travel');
      const cvo = /Oil LCV \(per line, ×1\)25([\d.]+) \(at flow ([\d.]+)\)/.exec(t);
      assert.near(parseFloat(cvo[2]), r.cvO, 0.05, 'oil Cv');
      clean(assert, app, 'sh_res');
    },
  },
  {
    name: 'G3 sephand: validation for blank ID / BS&W 100 % / zero travel',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sephand');
      setv(app, 'sh_id', ''); press(app, 'calcSepHandling');
      hasError(assert, app, 'sh_res', 'Separator ID');
      setv(app, 'sh_id', 42); setv(app, 'sh_bsw', 100); press(app, 'calcSepHandling');
      hasError(assert, app, 'sh_res', 'BS');
      setv(app, 'sh_bsw', 20); setv(app, 'sh_travel', 0); press(app, 'calcSepHandling');
      hasError(assert, app, 'sh_res', 'travel');
      setv(app, 'sh_travel', 50); setv(app, 'sh_qg', 0); press(app, 'calcSepHandling');
      clean(assert, app, 'sh_res');
    },
  },
  {
    name: 'G3 sephand: metric inputs give the same capacity answer',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sephand', true);
      setAll(app, { sh_id: 42 * 25.4, sh_len: 12.5 * 0.3048, sh_p: 500 * 6.894757, sh_pd: 100 * 6.894757, sh_qo: 3000 * BBL_M3, sh_qg: 5 * 28.316847 });
      press(app, 'calcSepHandling');
      const r = sepHandRef(SH_DEFAULTS);
      assert.near(rowNum(app, 'sh_res', 'Z-factor'), r.Z, 0.0006);
      assert.near(rowNum(app, 'sh_res', 'Actual gas velocity'), r.vGas, 0.006);
      assert.near(rowNum(app, 'sh_res', 'Oil retention'), r.retO, 0.06);
      clean(assert, app, 'sh_res');
    },
  },
  {
    name: 'G3 sephand: 2-phase liquid outlet carries oil + water (4000 BLPD, 25 % BS&W → 2" LCV 3.63 m/s FAIL, blend-SG Cv)',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sephand');
      setAll(app, { sh_service: '2', sh_qbasis: 'blpd', sh_qo: 4000, sh_bsw: 25 });
      press(app, 'calcSepHandling');
      const q = 4000 * BBL_M3 / 86400;                                   // 0.0073605 m³/s — total liquid
      const A = (d) => Math.PI * Math.pow(d * 0.0254, 2) / 4;
      const t = text(app, 'sh_res');
      const lcv = /Liquid LCV2"×1([\d.]+) m\/s (✓|✗)/.exec(t);
      assert(lcv, 'Liquid LCV outlet row present: ' + t.slice(0, 400));
      assert.near(parseFloat(lcv[1]), q / A(2), 0.006, 'LCV velocity uses total liquid');   // 3.63 m/s
      assert.strictEqual(lcv[2], '✗', 'LCV above the 3 m/s limit fails');
      const line = /Liquid line3"×1([\d.]+) m\/s/.exec(t);
      assert.near(parseFloat(line[1]), q / A(3), 0.006, 'line velocity');                   // 1.61 m/s
      assert(!/Oil LCV|Oil line|Oil turbine/.test(t), 'no oil-only outlet rows in 2-phase');
      const sgBlend = (141500 / (35 + 131.5) * 0.75 + 1000 * 0.25) / 1000;               // 0.8874
      const cvRef = q * 15850.323 * Math.sqrt(sgBlend / 25);                              // 21.98
      const cv = /Liquid LCV \(per line, ×1\)25([\d.]+) \(at flow ([\d.]+)\)/.exec(t);
      assert(cv, 'Liquid LCV Cv row present');
      assert.near(parseFloat(cv[2]), cvRef, 0.06, 'Cv at flow (total liquid, blend SG)');
      assert.near(parseFloat(cv[1]), cvRef / 0.5, 0.1, 'Cv at 50 % travel');
      assert.includes(t, '✗ Liquid LCV: 3.63 m/s > limit 3 m/s');
      assert(rowText(app, 'sh_res', 'Liquid retention') !== '', 'retention row labelled Liquid');
      clean(assert, app, 'sh_res');
    },
  },
  {
    name: 'G3 sephand: verdict, failures, warnings and fixes reach the page report',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sephand');
      press(app, 'calcSepHandling');                                    // defaults: gas PCV 2" fails
      assert.strictEqual(rowText(app, 'sh_res', 'Overall verdict').indexOf('FAIL'), 0);
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const sec = model.results.find((s) => /^Verdict/.test(s.title || ''));
      assert(sec, 'report has a Verdict section: ' + model.results.map((s) => s.title).join(' | '));
      const items = sec.items;
      assert(items.some((i) => i.type === 'kv' && i.label === 'Overall verdict' && /^FAIL/.test(i.value)), 'overall verdict row');
      assert(items.some((i) => i.type === 'note' && i.verdict && /^✗ Gas PCV \(downstream\)/.test(i.text)), 'failure reason note');
      assert(items.some((i) => i.type === 'note' && i.title === 'Recommendation' && /upsize from 2" to/.test(i.text)), 'fix hint note');
      clean(assert, app, 'sh_res');
    },
  },
  {
    name: 'G3 sephand: Souders–Brown K inside GPSA mesh-pad ranges (H 0.45, V 0.27; no pad H 0.30)',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sephand');
      press(app, 'calcSepHandling');
      assert.near(rowNum(app, 'sh_res', 'Souders-Brown K'), 0.45, 1e-6);
      assert.near(rowNum(app, 'sh_res', 'Allowable gas velocity'), sepHandRef(SH_DEFAULTS).vAllow, 0.006);
      setv(app, 'sh_mist', 'no'); press(app, 'calcSepHandling');
      assert.near(rowNum(app, 'sh_res', 'Souders-Brown K'), 0.30, 1e-6);
      setAll(app, { sh_mist: 'yes', sh_orient: 'V' }); press(app, 'calcSepHandling');
      assert.near(rowNum(app, 'sh_res', 'Souders-Brown K'), 0.27, 1e-6);
      clean(assert, app, 'sh_res');
    },
  },
  {
    name: 'G3 sephand: metric mode shows mm / m / kPa in outlet sizes, hints, Cv ΔP and diagram title',
    wp: 'G3',
    run(app, assert) {
      go(app, 'sephand', true);
      setAll(app, { sh_id: 42 * 25.4, sh_len: 12.5 * 0.3048, sh_p: 500 * 6.894757, sh_pd: 100 * 6.894757, sh_qo: 3000 * BBL_M3,
        sh_qg: 5 * 28.316847, sh_gpcv: 76.2, sh_dplcv: 25 * 6.894757 });
      press(app, 'calcSepHandling');
      const t = text(app, 'sh_res');
      assert.includes(t, 'Gas PCV (downstream)76.2 mm×1', 'outlet Size column in mm');
      assert(/Gas PCV \(downstream\): upsize from 76\.2 mm to ≈ [\d.,]+ mm/.test(t), 'hint in mm: ' + t.slice(0, 600));
      assert(!/\d"/.test(t), 'no inch marks in metric results');
      assert.includes(t, 'ΔP (kPa)');
      assert.includes(t, 'Gas PCV (per line, ×1)2,758 (choked)', 'gas ΔP 400 psi shown as 2,758 kPa');
      assert.includes(t, 'Oil LCV (per line, ×1)172', 'LCV ΔP 25 psi shown as 172 kPa');
      const title = app.canvasTexts('sh_diag')[0] || '';
      assert.includes(title, '1,066.8 mm × 3.81 m', 'diagram title in metric');
      // Physics unchanged: PCV velocity for a 3" PCV at the default flows.
      const r = sepHandRef(Object.assign({}, SH_DEFAULTS, { pcv: 3 }));
      const pcv = /Gas PCV \(downstream\)76\.2 mm×1([\d.]+) m\/s/.exec(t);
      assert.near(parseFloat(pcv[1]), r.vPCV, 0.01);
      clean(assert, app, 'sh_res');
    },
  },
  // ── vessel ────────────────────────────────────────────────────────────────
  {
    name: 'G3 vessel: thin-wall validity is a result row, so the Appendix 1-2 warning reaches the report',
    wp: 'G3',
    run(app, assert) {
      go(app, 'vessel');
      setAll(app, { vs_p: 8000, vs_r: 24, vs_s: 17500, vs_e: 1, vs_ca: 0.125 });
      press(app, 'calcVesselShell');
      assert.includes(rowText(app, 'vs_res', 'Validity'), 'Appendix 1-2');
      let s = JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
      assert.includes(s, 'Appendix 1-2', 'report carries the thick-wall warning');
      setv(app, 'vs_p', 1440); press(app, 'calcVesselShell');
      assert.includes(rowText(app, 'vs_res', 'Validity'), 'Within limits');
      s = JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
      assert(s.indexOf('Appendix 1-2') === -1, 'no warning inside limits');
      clean(assert, app, 'vs_res');
    },
  },
  {
    name: 'G3 vessel: ASME VIII-1 UG-27(c)(1) shell and UG-32(d) 2:1 head in corroded dimensions',
    wp: 'G3',
    run(app, assert) {
      go(app, 'vessel');
      setAll(app, { vs_p: 1440, vs_r: 24, vs_s: 17500, vs_e: 1, vs_ca: 0.125 });
      press(app, 'calcVesselShell');
      const ts = 1440 * (24 + 0.125) / (17500 - 0.6 * 1440);          // 2.0882 in
      assert.near(rowNum(app, 'vs_res', 'without CA'), ts, 0.0001);
      assert.near(rowNum(app, 'vs_res', 'with CA'), ts + 0.125, 0.0001);
      setAll(app, { vh_p: 1440, vh_d: 42, vh_s: 17500, vh_e: 1, vh_ca: 0.125 });
      press(app, 'calcVesselHead');
      const th = 1440 * (42 + 0.25) / (2 * 17500 - 0.2 * 1440);        // 1.7527 in
      assert.near(rowNum(app, 'vh_res', 'without CA'), th, 0.0001);
      assert.near(rowNum(app, 'vh_res', 'with CA'), th + 0.125, 0.0001);
      // Textbook check (no CA, E = 0.85): P 250, R 30, S 20,000 → t = 0.4446 in
      setAll(app, { vs_p: 250, vs_r: 30, vs_s: 20000, vs_e: 0.85, vs_ca: 0 });
      press(app, 'calcVesselShell');
      assert.near(rowNum(app, 'vs_res', 'without CA'), 250 * 30 / (20000 * 0.85 - 150), 0.0001);
      clean(assert, app, 'vs_res');
    },
  },
  {
    name: 'G3 vessel: validation (blank, E > 1) and thick-wall warning above 0.385·S·E',
    wp: 'G3',
    run(app, assert) {
      go(app, 'vessel');
      setAll(app, { vs_p: '', vs_r: 24, vs_s: 17500, vs_e: 1, vs_ca: 0.125 });
      press(app, 'calcVesselShell');
      hasError(assert, app, 'vs_res', 'Design pressure');
      setAll(app, { vs_p: 1440, vs_e: 1.5 }); press(app, 'calcVesselShell');
      hasError(assert, app, 'vs_res', 'Joint efficiency');
      setAll(app, { vs_p: 8000, vs_e: 1 }); press(app, 'calcVesselShell');
      assert.includes(text(app, 'vs_res'), 'Appendix 1-2');
      setAll(app, { vh_p: 1440, vh_d: -1, vh_s: 17500, vh_e: 1, vh_ca: 0.125 }); press(app, 'calcVesselHead');
      hasError(assert, app, 'vh_res', 'Inside diameter');
    },
  },
  {
    name: 'G3 vessel: metric inputs (kPa, mm) give the same thickness',
    wp: 'G3',
    run(app, assert) {
      go(app, 'vessel', true);
      setAll(app, { vs_p: 1440 * 6.894757, vs_r: 24 * 25.4, vs_s: 17500 * 6.894757, vs_e: 1, vs_ca: 3.175 });
      press(app, 'calcVesselShell');
      assert.near(rowNum(app, 'vs_res', 'with CA'), 1440 * 24.125 / 16636 + 0.125, 0.0002);
      clean(assert, app, 'vs_res');
    },
  },
  // ── heater ────────────────────────────────────────────────────────────────
  {
    name: 'G3 heater: Q = Σ ṁ·Cp·ΔT with oil and water split by water cut (defaults)',
    wp: 'G3',
    run(app, assert) {
      go(app, 'heater');
      setAll(app, { ih_q: 5000, ih_api: 30, ih_ti: 20, ih_to: 65, ih_wc: 30, ih_eff: 80 });
      press(app, 'calcHeater');
      const rhoO = 141.5 / 161.5 * 999;
      const mO = 5000 * 0.7 * BBL_M3 * rhoO / 86400, mW = 5000 * 0.3 * BBL_M3 * 999 / 86400;
      const QW = (mO * 2.0 + mW * 4.18) * 1000 * 45;                  // 1,026 kW
      const MM = QW * 3.412142 / 1e6;                                  // 3.501 MMBtu/hr
      assert.near(rowNum(app, 'ih_res', 'Mass Flow'), mO + mW, 0.001);
      assert.near(rowNum(app, 'ih_res', 'Process Heat Duty'), MM, 0.001);
      assert.near(rowNum(app, 'ih_res', 'Fired Duty'), MM / 0.8, 0.001);
      assert.near(rowNum(app, 'ih_res', 'Diesel'), MM / 0.8 * 1e6 / 138000, 0.01);
      clean(assert, app, 'ih_res');
    },
  },
  {
    name: 'G3 heater: dry oil and 100 % water limits; validation for reversed ΔT / zero efficiency',
    wp: 'G3',
    run(app, assert) {
      go(app, 'heater');
      setAll(app, { ih_q: 5000, ih_api: 30, ih_ti: 20, ih_to: 65, ih_wc: 0, ih_eff: 80 });
      press(app, 'calcHeater');
      const mO = 5000 * BBL_M3 * (141.5 / 161.5 * 999) / 86400;
      assert.near(rowNum(app, 'ih_res', 'Process Heat Duty'), mO * 2.0 * 45 * 1000 * 3.412142 / 1e6, 0.001);
      setv(app, 'ih_wc', 100); press(app, 'calcHeater');
      const mW = 5000 * BBL_M3 * 999 / 86400;
      assert.near(rowNum(app, 'ih_res', 'Process Heat Duty'), mW * 4.18 * 45 * 1000 * 3.412142 / 1e6, 0.001);
      setAll(app, { ih_wc: 30, ih_to: 10 }); press(app, 'calcHeater');
      hasError(assert, app, 'ih_res', 'Outlet temperature');
      setAll(app, { ih_to: 65, ih_eff: 0 }); press(app, 'calcHeater');
      hasError(assert, app, 'ih_res', 'efficiency');
    },
  },
  {
    name: 'G3 heater: metric liquid rate (m³/d) gives the same duty',
    wp: 'G3',
    run(app, assert) {
      go(app, 'heater', true);
      setAll(app, { ih_q: 5000 * BBL_M3, ih_api: 30, ih_ti: 20, ih_to: 65, ih_wc: 30, ih_eff: 80 });
      press(app, 'calcHeater');
      const rhoO = 141.5 / 161.5 * 999;
      const QW = (5000 * 0.7 * BBL_M3 * rhoO / 86400 * 2.0 + 5000 * 0.3 * BBL_M3 * 999 / 86400 * 4.18) * 1000 * 45;
      assert.near(rowNum(app, 'ih_res', 'Process Heat Duty'), QW * 3.412142 / 1e6, 0.002);
      clean(assert, app, 'ih_res');
    },
  },
  // ── chem ──────────────────────────────────────────────────────────────────
  {
    name: 'G3 chem: injection cc/min = BPD × ppm × 158987/1e6/1440; zero flow is zero (not 12,000 BPD)',
    wp: 'G3',
    run(app, assert) {
      go(app, 'chem');
      setv(app, 'ch_q', 12000); press(app, 'calcChem');
      const f = 158987 / 1e6 / 1440;
      const cells = () => app.findAll('#ch_tbl tr').slice(1).map((tr) => parseFloat(tr.children[2].textContent.replace(/,/g, '')));
      const c = cells();
      assert.near(c[0], 12000 * 1 * f, 0.006);                          // 1.32
      assert.near(c[1], 12000 * 10 * f, 0.006);                         // 13.25
      assert.near(c[2], 12000 * 30 * f, 0.006);                         // 39.75
      setv(app, 'ch_q', 0); press(app, 'calcChem');
      assert.deepStrictEqual(cells(), [0, 0, 0]);
      setv(app, 'ch_q', ''); press(app, 'calcChem');
      hasError(assert, app, 'ch_res', 'Flow rate');
      assert(!/NaN/.test(text(app, 'ch_tbl')));
    },
  },
  {
    name: 'G3 chem: metric flow (m³/d) and page re-entry use the canonical BPD rate',
    wp: 'G3',
    run(app, assert) {
      go(app, 'chem', true);
      setv(app, 'ch_q', 500); press(app, 'calcChem');                   // 500 m³/d = 3144.9 BPD
      const f = 158987 / 1e6 / 1440, bpd = 500 / BBL_M3;
      const cell = () => parseFloat(app.findAll('#ch_tbl tr')[3].children[2].textContent.replace(/,/g, ''));
      assert.near(cell(), bpd * 30 * f, 0.006);                          // 10.42 cc/min
      app.hook.nav('sep'); app.flush(400); app.hook.nav('chem'); app.flush(50);
      assert.near(cell(), bpd * 30 * f, 0.006, 'after re-entry (autosave restore)');
    },
  },
  {
    name: 'G3 chem: argentometric chloride (A−B)·N·35,450/D and validation',
    wp: 'G3',
    run(app, assert) {
      go(app, 'chem');
      setAll(app, { cl_a: 29.3, cl_b: 0, cl_n: 0.1, cl_d: 1 });
      press(app, 'calcChloride');
      const cl = 29.3 * 0.1 * 35450;                                    // 103,868.5 mg/L
      assert.near(rowNum(app, 'cl_res', 'Chlorides'), cl, 0.1);
      assert.near(rowNum(app, 'cl_res', 'NaCl equivalent'), cl * 1.65, 1);
      setAll(app, { cl_a: 2, cl_b: 0.2, cl_n: 0.0282, cl_d: 100 });   // 0.0282 N → 1 ml ≙ 1 mg Cl
      press(app, 'calcChloride');
      assert.near(rowNum(app, 'cl_res', 'Chlorides'), 1.8 * 0.0282 * 35450 / 100, 0.1);
      setAll(app, { cl_a: 1, cl_b: 2 }); press(app, 'calcChloride');
      hasError(assert, app, 'cl_res', 'blank');
      setAll(app, { cl_a: '', cl_b: 0 }); press(app, 'calcChloride');
      hasError(assert, app, 'cl_res', 'Silver nitrate');
    },
  },
];
