// Roadmap calculator #8 — Separator Sampling & GOR QC (route `sepqc`,
// prism-build/49-calc-sepqc.js, Round-9 plug-in registry).
//
// Expected values are independent hand calculations written out below:
//   • Standing (1947) at 500 psig, 100 °F, 40 °API, γg 0.75:
//       Rs = 0.75·[(514.7/18.2 + 1.4)·10^(0.5 − 0.091)]^1.2048 = 138.63 scf/STB
//       F  = Rs·√(0.75/0.82507) + 125 = 257.17 ; Bo = 0.9759 + 0.00012·F^1.2 = 1.06954
//       S  = 1/Bo = 0.93498   (computed independently in Python and below)
//   • AGA-3 gas-rate ratio q_lab/q_field = √(SG_f/SG_l)·√(Z_f/Z_l) (Fgr = 1/√G, Fpv = 1/√Z);
//   • GOR_sep = 1000·q_g/q_o,sep ; GOR_ST = GOR_sep / S ;
//   • gas bottle expected opening pressure: p_sep,abs·T_open,abs/T_sep,abs;
//   • duplicate spread (max − min)/mean on absolute saturation pressures.
'use strict';

const WP = 'SEPQC';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label, nth) {
  const r = rows(app, resId).find((x) => x.l === label);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId).map((x) => x.l)));
  const nums = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (!nums || nums[nth || 0] == null) throw new Error('row "' + label + '" has no number #' + (nth || 0) + ': ' + r.v);
  return parseFloat(nums[nth || 0]);
}
function rowText(app, resId, label) { const r = rows(app, resId).find((x) => x.l === label); return r ? r.v : ''; }
function txt(app, id) { const e = app.el(id); return String(e ? e.textContent : '').trim(); }
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|∞|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="sepqc"]');
  if (!b) throw new Error('no sepqc nav button');
  app.click(b);
  if (!app.el('sq_root')) throw new Error('sepqc page did not render');
}
const calc = (app) => app.click('sq_calc');
const S = (app) => app.win.WTS_state.sepqc;

// ── Independent hand formulas ───────────────────────────────────────
function standingHand(pPsig, tF, api, g) {
  const go = 141.5 / (api + 131.5);
  const Rs = g * Math.pow(((pPsig + 14.7) / 18.2 + 1.4) * Math.pow(10, 0.0125 * api - 0.00091 * tF), 1.2048);
  const Bo = 0.9759 + 0.00012 * Math.pow(Rs * Math.sqrt(g / go) + 1.25 * tF, 1.2);
  return { Rs, Bo, S: 1 / Bo };
}
const BASE = { psep: 500, tsep: 100, api: 40, sgField: 0.70, sgLab: 0.75, co2: 2, h2s: 0, n2: 0.5, qGas: 5000, qOil: 2000, oilBasis: 'sep', shrMethod: 'standing' };
const BOTTLES = [
  { id: 'A-101', kind: 'oil', pOpen: 495, tOpen: 100, psat: 505 },
  { id: 'A-102', kind: 'oil', pOpen: 490, tOpen: 100, psat: 498 },
  { id: 'G-201', kind: 'gas', pOpen: 470, tOpen: 70, sg: 0.752 },
  { id: 'G-202', kind: 'gas', pOpen: 468, tOpen: 70, sg: 0.748 },
];

module.exports = [
  {
    name: 'SEPQC compute: Standing shrinkage, lab gravity/Z gas correction, separator / stock-tank / recombination GOR match hand calculations',
    wp: WP,
    run(app, assert) {
      const W = app.win, F = W.WTS_sepqc_compute;
      ['renderSepQC', 'calcSepQC', 'WTS_sepqc_compute', 'WTS_sepqc_standing'].forEach((f) => assert.strictEqual(typeof W[f], 'function', f));
      // Standing literal values (Python hand calculation)
      const st = W.WTS_sepqc_standing(500, 100, 40, 0.75);
      assert.rel(st.Rs, 138.6286, 1e-5, 'Rs');
      assert.rel(st.Bo, 1.069537, 1e-6, 'Bo');
      assert.rel(st.S, 0.934984, 1e-6, 'S');
      // Host Shrinkage tab defaults (710 psig, 121 °F, 0.751, 52 °API) — same correlation
      const h = standingHand(710, 121, 52, 0.751);
      assert.rel(W.WTS_sepqc_standing(710, 121, 52, 0.751).Bo, h.Bo, 1e-12, 'host defaults Bo');

      // Typed Z and shrinkage — pure ratios
      const a = F(Object.assign({}, BASE, { zField: 0.92, zLab: 0.90, shrMethod: 'user', shrUser: 0.88 }));
      assert.ok(a.ok, 'typed ok: ' + JSON.stringify(a.errors));
      const corr = Math.sqrt(0.70 / 0.75) * Math.sqrt(0.92 / 0.90);
      assert.rel(a.corr, corr, 1e-12, 'correction');
      assert.rel(a.corr, 0.976767, 1e-5, 'correction ≈ 0.97677 (0.966092 × 1.011050)');
      assert.rel(a.qGasCorr, 5000 * corr, 1e-12, 'corrected gas rate');
      assert.rel(a.gorSepField, 2500, 1e-12, 'field GOR per separator bbl = 5,000,000/2,000');
      assert.rel(a.gorSTField, 2500 / 0.88, 1e-12, 'field GOR per STB = GOR_sep / S');
      assert.rel(a.gorSepCorr, 2500 * corr, 1e-12, 'recombination GOR');
      assert.rel(a.gorSTCorr, 2500 * corr / 0.88, 1e-12, 'corrected GOR per STB');
      assert.rel(a.qOilST, 2000 * 0.88, 1e-12, 'stock-tank oil');
      assert.rel(a.Bsep, 1 / 0.88, 1e-12, 'separator volume factor');
      assert.strictEqual(a.zFieldSrc, 'input');
      // Stock-tank basis: GOR per STB = 1000 q / q_ST; per sep bbl = that × S
      const b = F(Object.assign({}, BASE, { zField: 0.92, zLab: 0.90, shrMethod: 'user', shrUser: 0.88, oilBasis: 'st' }));
      assert.rel(b.gorSTField, 2500, 1e-12, 'ST basis');
      assert.rel(b.gorSepField, 2500 * 0.88, 1e-12, 'ST basis, per sep bbl');
      assert.rel(b.qOilSep, 2000 / 0.88, 1e-12, 'separator oil from ST');

      // Computed Z (Gas PVT engine: Sutton + Kay + Wichert–Aziz + DAK) and Standing shrinkage
      const c = F(Object.assign({}, BASE, { bottles: BOTTLES }));
      assert.ok(c.ok, 'computed ok');
      const zF = W.WTS_gaspvt_compute({ sg: 0.70, p: 514.696, t: 100 }).z;
      const zL = W.WTS_gaspvt_compute({ sg: 0.75, p: 514.696, t: 100, co2: 2, h2s: 0, n2: 0.5 }).z;
      assert.rel(c.zField, zF, 1e-12, 'field Z = Gas PVT'); assert.rel(c.zLab, zL, 1e-12, 'lab Z = Gas PVT');
      assert.ok(c.zField > 0.9 && c.zField < 0.97 && c.zLab > 0.9 && c.zLab < 0.97, 'Z plausible at 515 psia / 100 °F');
      assert.rel(c.corr, Math.sqrt(0.70 / 0.75) * Math.sqrt(zF / zL), 1e-12, 'correction with computed Z');
      assert.rel(c.S, standingHand(500, 100, 40, 0.75).S, 1e-12, 'Standing S with the lab gravity');
      assert.rel(c.gorSTCorr, 1000 * c.qGasCorr / (2000 * c.S), 1e-12, 'GOR ST');
      assert.rel(c.gorTotal, c.gorSTCorr + 138.6286, 1e-6, 'total = ST GOR + Standing Rs');
      // lab gravity blank → mean of gas bottles (0.75)
      const d = F(Object.assign({}, BASE, { sgLab: '', bottles: BOTTLES }));
      assert.rel(d.sgLab, 0.75, 1e-12, 'mean of bottles'); assert.strictEqual(d.sgLabSrc, 'bottles');
      // AGA-3 fallback Z (host engine) when Gas PVT is absent
      const keep = W.WTS_gaspvt_compute;
      W.WTS_gaspvt_compute = undefined;
      try {
        const e = F(Object.assign({}, BASE));
        assert.ok(e.ok && /AGA-3/.test(e.zLabSrc), 'AGA-3 fallback');
        const ag = W.WTS_aga3_compute({ D: 4, d: 2, hw: 50, Ps: 500, TfF: 100, SG: 0.75, co2: 2, h2s: 0, n2: 0.5 });
        assert.rel(e.zLab, ag.Z, 1e-12, 'Z from WTS_aga3_compute');
      } finally { W.WTS_gaspvt_compute = keep; }

      // Validation
      const bad = [F({}), F(Object.assign({}, BASE, { psep: -5 })), F(Object.assign({}, BASE, { sgLab: 0.3 })),
        F(Object.assign({}, BASE, { shrMethod: 'user', shrUser: 1.3 })), F(Object.assign({}, BASE, { zLab: 5 })),
        F(Object.assign({}, BASE, { bottles: [{ kind: 'oil', pOpen: -50 }] }))];
      bad.forEach((r, i) => { assert.strictEqual(r.ok, false, 'bad ' + i); assert.ok(r.errors.length > 0, 'bad ' + i + ' errors'); });
      assert.deepStrictEqual(Array.from(bad[5].bad), ['b1'], 'bottle row flagged');
    },
  },
  {
    name: 'SEPQC sample checks: opening pressure, saturation pressure and duplicate agreement verdicts',
    wp: WP,
    run(app, assert) {
      const F = app.win.WTS_sepqc_compute;
      const psepA = 514.696;
      const r = F(Object.assign({}, BASE, { bottles: BOTTLES }));
      assert.strictEqual(r.bottles.length, 4);
      const [o1, o2, g1, g2] = r.bottles;
      assert.rel(o1.openDev, 100 * (509.696 - psepA) / psepA, 1e-9, 'A-101 opening −0.971 %');
      assert.rel(o1.satDev, 100 * (519.696 - psepA) / psepA, 1e-9, 'A-101 saturation +0.971 %');
      assert.rel(o2.satDev, -0.38858, 1e-4, 'A-102 saturation −0.389 %');
      const expG = psepA * 529.67 / 559.67;                      // 487.107 psia
      assert.rel(g1.pOpenExpG, expG - 14.696, 1e-12, 'gas expected opening 472.41 psig');
      assert.rel(g1.pOpenExpG, 472.411, 1e-5, 'gas expected opening literal');
      assert.rel(g1.openDev, 100 * (484.696 - expG) / expG, 1e-9, 'G-201 opening');
      assert.rel(r.dup.oil.pct, 100 * 7 / 516.196, 1e-9, 'oil duplicate spread 1.356 %');
      assert.rel(r.dup.gas.pct, 100 * 0.004 / 0.75, 1e-9, 'gas duplicate spread 0.533 %');
      assert.strictEqual(r.fails, 0, 'defaults pass');
      assert.ok(r.bottles.every((b) => b.verdict === 'ok'), 'all bottles ✓');
      // Leaking oil bottle: psat 470 psig (−5.83 %) → ✗ saturation and ✗ duplicate (6.97 %)
      const L = BOTTLES.map((b) => Object.assign({}, b));
      L[1].psat = 470;
      const x = F(Object.assign({}, BASE, { bottles: L }));
      assert.rel(x.bottles[1].satDev, 100 * (484.696 - psepA) / psepA, 1e-9, '−5.83 %');
      assert.strictEqual(x.bottles[1].verdict, 'bad');
      assert.rel(x.dup.oil.pct, 100 * 35 / 502.196, 1e-9, 'spread 6.97 %');
      assert.ok(x.checks.some((c) => c.level === 'bad' && /Duplicate oil samples/.test(c.text)), 'duplicate ✗');
      assert.ok(x.checks.some((c) => c.level === 'bad' && /below separator pressure/.test(c.text)), 'saturation low ✗');
      assert.strictEqual(x.fails, 2);
      // Carry-under: psat 30 psi above separator (+5.8 %) → ✗ "above"
      const C = BOTTLES.map((b) => Object.assign({}, b)); C[0].psat = 535;
      assert.ok(F(Object.assign({}, BASE, { bottles: C })).checks.some((c) => c.level === 'bad' && /carry-under/.test(c.text)), 'carry-under ✗');
      // Gas bottle leak: opening 430 psig vs 472.4 expected (−8.7 %) → ✗
      const GL = BOTTLES.map((b) => Object.assign({}, b)); GL[2].pOpen = 430;
      const y = F(Object.assign({}, BASE, { bottles: GL }));
      assert.strictEqual(y.bottles[2].verdict, 'bad');
      assert.rel(y.bottles[2].openDev, 100 * (444.696 - expG) / expG, 1e-9, 'gas leak deviation');
      // Oil bottle opened off separator temperature → ⚠
      const T = BOTTLES.map((b) => Object.assign({}, b)); T[0].tOpen = 70;
      assert.strictEqual(F(Object.assign({}, BASE, { bottles: T })).bottles[0].verdict, 'warn');
      // One oil bottle only → ⚠ no duplicate check; tolerance widened → ✓
      const one = F(Object.assign({}, BASE, { bottles: [BOTTLES[0], BOTTLES[2], BOTTLES[3]] }));
      assert.ok(one.checks.some((c) => c.level === 'warn' && /Fewer than two oil samples/.test(c.text)), 'single oil ⚠');
      assert.strictEqual(F(Object.assign({}, BASE, { tolSat: 7, tolDup: 8, bottles: L })).fails, 0, 'wider tolerances pass');
    },
  },
  {
    name: 'SEPQC page: registry nav in Well Testing, defaults compute, rows, sample table, verdicts, typed shrinkage',
    wp: WP,
    run(app, assert) {
      const R = app.win.WTS_calcRegistry.sepqc;
      assert.ok(R && R.key === 'sepqc' && typeof R.render === 'function' && R.title === 'Separator Sampling & GOR QC', 'registry entry');
      const b = app.find('.nav-btn[data-p="sepqc"]');
      assert.ok(b, 'sidebar button');
      assert.strictEqual(String(b.closest('.nav-group').querySelector('.nav-group-label').textContent).trim(), 'Well Testing');
      open(app);
      assert.strictEqual(txt(app, 'pgTitle'), 'Separator Sampling & GOR QC');
      assert.match(txt(app, 'pgSub'), /API RP 44/);
      const ref = app.win.WTS_sepqc_compute(Object.assign({}, BASE, { sgLab: '', bottles: BOTTLES }));
      assert.rel(S(app).gorSepCorr, ref.gorSepCorr, 1e-12, 'state = compute');
      assert.strictEqual(S(app).fails, 0);
      assert.rel(rv(app, 'sq_res', 'Laboratory gas gravity'), 0.75, 1e-9);
      assert.includes(rowText(app, 'sq_res', 'Laboratory gas gravity'), 'mean of gas bottles');
      assert.rel(rv(app, 'sq_res', 'Shrinkage factor S (STB per separator bbl)'), 0.9350, 1e-4);
      assert.rel(rv(app, 'sq_res', 'Corrected gas rate'), ref.qGasCorr, 1e-4);
      assert.rel(rv(app, 'sq_res', 'Recombination GOR (separator gas / separator liquid)'), ref.gorSepCorr, 1e-4);
      assert.includes(rowText(app, 'sq_res', 'Recombination GOR (separator gas / separator liquid)'), 'scf/sep bbl');
      assert.rel(rv(app, 'sq_res', 'Corrected GOR, stock-tank basis'), ref.gorSTCorr, 1e-4);
      assert.includes(txt(app, 'sq_res'), '⚠ No check failed; review the');
      assert.includes(txt(app, 'sq_res'), '⚠ Laboratory gravity and Z change the gas rate by');
      assert.ok(!/✗/.test(txt(app, 'sq_res')), 'no ✗ at the defaults');
      const trs = app.findAll('#sq_res table.dtable tbody tr');
      assert.strictEqual(trs.length, 4, 'sample table rows');
      assert.includes(trs[0].textContent, 'A-101');
      // Typed shrinkage + leaking bottle
      set(app, { sq_shrm: 'user', sq_shr: '0.9', sq_bps2: '470' }); calc(app);
      assert.rel(S(app).S, 0.9, 1e-12);
      assert.strictEqual(S(app).fails, 2);
      assert.includes(txt(app, 'sq_res'), '✗ 2 check(s) failed');
      // Bottle IDs are escaped
      set(app, { sq_bid1: '<b>x</b>' }); calc(app);
      assert.ok(!app.find('#sq_res table b'), 'bottle id not rendered as HTML');
      noBadNumbers(assert, app, 'page');
    },
  },
  {
    name: 'SEPQC validation: messages, flagged inputs, cleared on a good run',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { sq_psep: '-10', sq_sgf: '0.3', sq_bpo3: '-40' }); calc(app);
      const e = errText(app, 'sq_res');
      assert.includes(e, 'Separator pressure must be between');
      assert.includes(e, 'Field (meter) gas gravity');
      assert.includes(e, 'Bottle 3: opening pressure');
      assert.ok(app.el('sq_psep').classList.contains('input-err') && app.el('sq_sgf').classList.contains('input-err') && app.el('sq_bpo3').classList.contains('input-err'), 'flagged');
      assert.ok(!app.el('sq_tsep').classList.contains('input-err'), 'valid input not flagged');
      assert.strictEqual(S(app).ok, false);
      set(app, { sq_psep: '500', sq_sgf: '0.70', sq_bpo3: '470' }); calc(app);
      assert.strictEqual(app.findAll('#sq_root .input-err').length, 0, 'flags cleared');
      assert.ok(S(app).ok, 'good run');
      noBadNumbers(assert, app, 'validation');
    },
  },
  {
    name: 'SEPQC metric: labels switch, state equals the imperial run, GOR in sm³/m³, unit flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      const imp = JSON.parse(JSON.stringify(S(app)));
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        assert.match(String(app.el('sq_psep').closest('.fg-item').querySelector('label').textContent), /kPa/, 'pressure label');
        ['S', 'zField', 'zLab', 'corr', 'qGasCorr', 'gorSepCorr', 'gorSTCorr'].forEach((k) => assert.rel(S(app)[k], imp[k], 1e-6, 'metric ' + k));
        assert.strictEqual(S(app).fails, 0, 'bottle checks unchanged in metric');
        assert.rel(rv(app, 'sq_res', 'Corrected GOR, stock-tank basis'), imp.gorSTCorr * 0.0283168466 / 0.158987294928, 1e-3, 'sm³/m³');
        assert.includes(rowText(app, 'sq_res', 'Corrected GOR, stock-tank basis'), 'sm³/sm³');
        assert.rel(rv(app, 'sq_res', 'Corrected gas rate'), imp.qGasCorr * 28.3168, 1e-3, 'm³/d');
        // 3447.38 kPa(g) = 500 psig
        app.input('sq_psep', '3447.38'); calc(app);
        assert.rel(S(app).gorSepCorr, imp.gorSepCorr, 1e-5, 'metric entry converted');
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).gorSepCorr, imp.gorSepCorr, 1e-5, 'recalc after flip');
    },
  },
  {
    name: 'SEPQC report + persistence: sections, sample table, PDF, autosave restore after reload, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { sq_qg: '6200', sq_bps1: '507' }); calc(app);
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const rt = model.results.map((x) => x.title);
      ['Gas Rate Re-computation', 'Shrinkage and GOR', 'Recombination GOR for the Laboratory', 'Sample Validity'].forEach((t) => assert.ok(rt.indexOf(t) !== -1, 'results section ' + t + ': ' + rt.join(' | ')));
      const it = model.inputs.map((x) => x.title);
      ['Separator and Rates', 'Gas Gravity and Z', 'Sample Bottles'].forEach((t) => assert.ok(it.indexOf(t) !== -1, 'input section ' + t + ': ' + it.join(' | ')));
      const tabs = [];
      model.inputs.concat(model.results).forEach((s) => s.items.forEach((x) => { if (x.type === 'table') tabs.push(s.title); }));
      assert.ok(tabs.indexOf('Sample Bottles') !== -1 && tabs.indexOf('Sample Validity') !== -1, 'tables captured: ' + tabs.join(','));
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Separator Sampling') !== -1 && pdf.indexOf('Recombination GOR') !== -1, 'PDF');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_sepqc') || 'null');
      assert.ok(rec && rec.f && rec.f.sq_qg === '6200' && rec.f.sq_bps1 === '507', 'autosaved');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      const g = S(app).gorSepCorr;
      const app2 = app.reload();
      try {
        const b = app2.find('.nav-btn[data-p="sepqc"]'); app2.click(b);
        assert.strictEqual(app2.el('sq_qg').value, '6200', 'restored');
        assert.rel(app2.win.WTS_state.sepqc.gorSepCorr, g, 1e-12, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0);
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'SEPQC phone: renders at 375 px with results and a dashboard tile',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="sepqc"]');
      assert.ok(b && b.closest('#sidebar'), 'button in the mobile sidebar');
      open(app);
      assert.ok(app.el('sq_res').querySelector('.rrow'), 'results rendered');
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no fixed widths above 340 px');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('Separator Sampling & GOR QC') !== -1, 'dashboard tile: ' + titles.join(' | '));
    },
  },
];
