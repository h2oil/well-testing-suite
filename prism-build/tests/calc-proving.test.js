// Roadmap calculator #13 — Meter Proving & Net Standard Volume (route `proving`,
// prism-build/49-calc-proving.js), with #18 (net-oil BS&W / shrinkage audit
// trail) folded in.
//
// Expected values come from published references and independent hand
// calculations (Python, written out below — not the module's code):
//   • API MPMS 12.2 Part 1, Example 3: MF 1.0253, CTL 1.0000, CPL 1.0006
//       → CCF 1.0259; IV 47,082.85 bbl → GSV 48,302.30 bbl;
//   • ASTM D1250 / API MPMS 11.1 (1980) Table 6A: 35.0 °API at 100 °F → 0.9810;
//   • MPMS 4.8 Table A-1 repeatability limits (3–10 runs: 0.02 … 0.12 %);
//   • hand proving of the page defaults (Python): ρ60 = 867.6944 kg/m³ (API 31.415
//     from 32.5 °API observed at 75 °F), CTSp 1.00034, CPSp 1.00013, CTLp 0.99173,
//     CPLp 1.00048, CCFp 0.99267, CTLm 0.99183, CPLm 1.00050, CCFm 0.99233,
//     MF 1.0012 (unrounded 1.0011836), repeatability 0.0400 %;
//     ticket: CTL 0.9918, CPL 1.0005, CCF 0.9935, GSV 6,209.77, CSW 0.9965, NSV 6,188.04 bbl;
//   • audit trail vs the host Oil & Gas Rate page (its own calcOilGas code):
//     defaults → API60 33.491, VCF 0.971900, 97.7226 BPD.
'use strict';

const WP = 'PROVE';

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
function open(app, key) {
  const b = app.find('.nav-btn[data-p="' + (key || 'proving') + '"]');
  if (!b) throw new Error('no ' + (key || 'proving') + ' nav button');
  app.click(b);
}
const calc = (app) => app.click('pv_calc');
const S = (app) => app.win.WTS_state.proving;

// ── Independent hand formulas (1980 crude, MPMS 11.2.1, MPMS 12.2 rounding) ──
const W = 999.012;
const rnd = (x, d) => Math.sign(x || 1) * Math.floor(Math.abs(x) * Math.pow(10, d) + 0.5 + 1e-9) / Math.pow(10, d);
const ctlH = (rho, t) => { const a = 341.0957 / (rho * rho), dt = t - 60; return Math.exp(-a * dt * (1 + 0.8 * a * dt)); };
const fpH = (rho, t) => 1e-5 * Math.exp(-1.9947 + 0.00013427 * t + (793920 + 2326 * t) / (rho * rho));
const RUNS = [[49.95, 78.2, 95, 78.0, 100], [49.96, 78.2, 95, 78.0, 100], [49.95, 78.3, 95, 78.1, 100], [49.97, 78.3, 95, 78.1, 100], [49.96, 78.2, 95, 78.0, 100]];
const runObj = (a) => a.map((r) => ({ iv: r[0], tp: r[1], pp: r[2], tm: r[3], pm: r[4] }));
const BASE = {
  round: true, group: 'crude', apiObs: 32.5, tHyd: 75, pe: 0, steel: 'cs', bpv: 50, proverId: 15.25, wall: 0.375, prevMf: 1.0005,
  runs: runObj(RUNS),
  ticket: { open: 125000, close: 131250.40, tm: 78, pm: 100, sw: 0.35 },
  audit: { interval: 60, apiObs: 35, tHyd: 80, m0: 1000, m1: 1004.5, tLine: 120, bsw: 2, mf: 1.0, shr: 0.95 },
};

module.exports = [
  {
    name: 'PROVE MPMS references: 12.2 Example 3 ticket chain, Table 6A 35 °API @ 100 °F, CTL/CPL equations, product groups',
    wp: WP,
    run(app, assert) {
      const Wn = app.win;
      ['renderProving', 'calcProving', 'copyOilGasToProving', 'WTS_proving_compute', 'WTS_proving_ctl', 'WTS_proving_fp', 'WTS_proving_api60', 'WTS_proving_ticketChain']
        .forEach((f) => assert.strictEqual(typeof Wn[f], 'function', f));
      // MPMS 12.2 Part 1 Example 3
      const c = Wn.WTS_proving_ticketChain({ iv: 47082.85, ctl: 1.0000, cpl: 1.0006, mf: 1.0253, sw: 0, round: true });
      assert.strictEqual(c.ccf, 1.0259, 'CCF 1.0259');
      assert.strictEqual(c.gsv, 48302.30, 'GSV 48,302.30 bbl');
      assert.strictEqual(c.nsv, 48302.30, 'no S&W');
      // With S&W 0.25 %: CSW 0.9975, NSV = round(48302.30 × 0.9975, 2) = 48181.54
      const c2 = Wn.WTS_proving_ticketChain({ iv: 47082.85, ctl: 1.0000, cpl: 1.0006, mf: 1.0253, sw: 0.25, round: true });
      assert.strictEqual(c2.csw, 0.9975); assert.strictEqual(c2.nsv, 48181.54); assert.strictEqual(c2.swv, 120.76);
      // Unrounded chain = plain product
      const c3 = Wn.WTS_proving_ticketChain({ iv: 47082.85, ctl: 1.0000, cpl: 1.0006, mf: 1.0253, sw: 0, round: false });
      assert.rel(c3.gsv, 47082.85 * 1.0006 * 1.0253, 1e-14, 'unrounded GSV');
      // Table 6A
      assert.strictEqual(Math.round(Wn.WTS_proving_ctl(35, 100, 'crude') * 1e4) / 1e4, 0.9810, 'Table 6A 35.0 @ 100 °F');
      assert.rel(Wn.WTS_proving_ctl(35, 100), 0.98096856, 1e-7, 'unrounded (Python)');
      assert.strictEqual(Wn.WTS_proving_ctl(30, 60), 1, 'CTL = 1 at 60 °F');
      assert.ok(Wn.WTS_proving_ctl(30, 40) > 1, 'CTL > 1 below 60 °F');
      // CPL compressibility (MPMS 11.2.1): 35 °API at 60 °F ≈ 0.50 ×10⁻⁵ /psi
      const rho35 = 141.5 * W / 166.5;
      assert.rel(Wn.WTS_proving_fp(35, 60), fpH(rho35, 60), 1e-12, 'F hand');
      assert.rel(Wn.WTS_proving_fp(35, 60), 5.008e-6, 2e-3, 'F ≈ 5.0e-6 /psi');
      // Product groups (1980 Table 6B/6D constants), α60 = K0/ρ² + K1/ρ
      const rhoG = 141.5 * W / (60 + 131.5), dtG = 30;
      const aG = 192.4571 / (rhoG * rhoG) + 0.2438 / rhoG;
      assert.rel(Wn.WTS_proving_ctl(60, 90, 'gasoline'), Math.exp(-aG * dtG * (1 + 0.8 * aG * dtG)), 1e-12, 'gasoline');
      const rhoF = 141.5 * W / (20 + 131.5), aF = 103.8720 / (rhoF * rhoF) + 0.2701 / rhoF;
      assert.rel(Wn.WTS_proving_ctl(20, 150, 'fuel'), Math.exp(-aF * 90 * (1 + 0.8 * aF * 90)), 1e-12, 'fuel oil');
      const rhoT = 780, apiT = 141.5 * W / rhoT - 131.5, aT = -0.00186840 + 1489.0670 / (rhoT * rhoT);
      assert.rel(Wn.WTS_proving_ctl(apiT, 100, 'trans'), Math.exp(-aT * 40 * (1 + 0.8 * aT * 40)), 1e-12, 'transition zone');
      // Table 5A iteration: hydrometer at 60 °F returns the reading; round trip
      assert.rel(Wn.WTS_proving_api60(32.5, 60).api60, 32.5, 1e-12, 'no correction at 60 °F');
      const h = Wn.WTS_proving_api60(32.5, 75);
      assert.rel(h.rho60, 867.69442, 1e-7, 'ρ60 (Python)');
      assert.rel(h.api60, 31.414724, 1e-6, 'API60 (Python)');
    },
  },
  {
    name: 'PROVE compute: meter factor, run factors, repeatability, ticket NSV and audit trail match the hand proving',
    wp: WP,
    run(app, assert) {
      const F = app.win.WTS_proving_compute;
      const r = F(BASE);
      assert.ok(r.ok, JSON.stringify(r.errors));
      const pv = r.prove, fa = pv.factors;
      assert.deepStrictEqual([fa.ctsp, fa.cpsp, fa.ctlp, fa.cplp, fa.ccfp, fa.ctlm, fa.cplm, fa.ccfm],
        [1.00034, 1.00013, 0.99173, 1.00048, 0.99267, 0.99183, 1.0005, 0.99233], 'proving factors (5 dp)');
      assert.deepStrictEqual([pv.avg.iv, pv.avg.tp, pv.avg.pp, pv.avg.tm, pv.avg.pm], [49.958, 78.2, 95, 78.0, 100], 'run averages');
      assert.strictEqual(pv.mf, 1.0012, 'MF (average data method)');
      assert.rel(pv.mfRaw, 1.0011836222, 1e-9, 'unrounded MF (Python)');
      assert.rel(fa.gsvp, 50 * 0.99267, 1e-12, 'GSVp'); assert.rel(fa.isvm, 49.958 * 0.99233, 1e-12, 'ISVm');
      assert.strictEqual(pv.mfAvgMethod, 1.0012, 'MF (average meter factor method)');
      const runMf = [1.0013439719, 1.0011435428, 1.0013540771, 1.0009532950, 1.0011435428];
      pv.runs.forEach((x, k) => assert.rel(x.mfRaw, runMf[k], 1e-9, 'run ' + (k + 1) + ' MF'));
      assert.rel(pv.rangePct, 0.04004004, 1e-6, 'repeatability 0.0400 %');
      assert.strictEqual(pv.limitPct, 0.05); assert.strictEqual(pv.repeatOk, true);
      assert.rel(pv.mfChangePct, 100 * (1.0012 - 1.0005) / 1.0005, 1e-12, 'change vs previous MF');
      // Ticket
      const t = r.ticket;
      assert.deepStrictEqual([t.iv, t.ctl, t.cpl, t.mf, t.ccf, t.gsv, t.csw, t.nsv, t.swv],
        [6250.40, 0.9918, 1.0005, 1.0012, 0.9935, 6209.77, 0.9965, 6188.04, 21.73], 'ticket chain');
      assert.strictEqual(t.mfSrc, 'proven');
      assert.rel(t.F, 5.021979e-6, 1e-6, 'F at 78 °F (Python)');
      // Audit trail (#18)
      const a = r.audit;
      assert.rel(a.api60, 33.491008, 1e-7, 'API60 (Python)');
      assert.rel(a.vcf, 0.97190045, 1e-8, 'VCF (Python)');
      assert.rel(a.rate, 97.722646, 1e-7, 'net oil rate (Python)');
      assert.rel(a.rate, a.iv * a.mf * a.vcf * a.csw * a.shr * 24, 1e-12, 'chain product');
      // Unrounded mode: factors are plain products
      const u = F(Object.assign({}, BASE, { round: false }));
      const rho = u.liquid.rho60;
      const avgP = (78.2 + 78.2 + 78.3 + 78.3 + 78.2) / 5, avgT = (78 + 78 + 78.1 + 78.1 + 78) / 5;   // no rounding of averages
      const cc = (1 + (avgP - 60) * 1.86e-5) * (1 + 95 * 15.25 / (3e7 * 0.375)) * ctlH(rho, avgP) / (1 - fpH(rho, avgP) * 95);
      const cm = ctlH(rho, avgT) / (1 - fpH(rho, avgT) * 100);
      assert.rel(u.prove.mf, 50 * cc / (49.958 * cm), 1e-12, 'unrounded MF hand');
      // Repeatability fails: run 4 at 50.00 bbl
      const bad = RUNS.map((x) => x.slice()); bad[3][0] = 50.0;
      const f2 = F(Object.assign({}, BASE, { runs: runObj(bad) }));
      assert.strictEqual(f2.prove.repeatOk, false, 'range > 0.05 %');
      assert.ok(f2.prove.rangePct > 0.09 && f2.prove.rangePct < 0.11, 'range ≈ 0.10 %: ' + f2.prove.rangePct);
      // Three runs → 0.02 % limit; ten → 0.12 %
      assert.strictEqual(F(Object.assign({}, BASE, { runs: runObj(RUNS.slice(0, 3)) })).prove.limitPct, 0.02);
      const ten = runObj(RUNS.concat(RUNS));
      assert.strictEqual(F(Object.assign({}, BASE, { runs: ten })).prove.limitPct, 0.12);
      // Two runs: no MF; ticket needs a typed MF
      const two = F(Object.assign({}, BASE, { runs: runObj(RUNS.slice(0, 2)) }));
      assert.ok(two.ok && two.prove.ok === false && /three prover runs/.test(two.prove.reason));
      assert.strictEqual(two.ticket.ok, false);
      const two2 = F(Object.assign({}, BASE, { runs: runObj(RUNS.slice(0, 2)), ticket: Object.assign({}, BASE.ticket, { mf: 1.0253 }) }));
      assert.ok(two2.ticket.ok && two2.ticket.mfSrc === 'typed' && two2.ticket.mf === 1.0253);
      // Pe above line pressure → CPL 1
      assert.strictEqual(F(Object.assign({}, BASE, { pe: 150 })).ticket.cpl, 1);
      // Validation
      const errs = [F({}), F(Object.assign({}, BASE, { bpv: 0 })), F(Object.assign({}, BASE, { wall: 20 })),
        F(Object.assign({}, BASE, { runs: runObj([[49.95, 78, -5, 78, 100]]) })),
        F(Object.assign({}, BASE, { ticket: Object.assign({}, BASE.ticket, { close: 100 }) })),
        F(Object.assign({}, BASE, { audit: Object.assign({}, BASE.audit, { m1: 900 }) }))];
      errs.forEach((x, i) => { assert.strictEqual(x.ok, false, 'bad ' + i); assert.ok(x.errors.length > 0); });
      assert.deepStrictEqual(Array.from(errs[3].bad), ['run1']);
    },
  },
  {
    name: 'PROVE audit trail (#18) reproduces the Oil & Gas Rate page: defaults, and copied inputs after a change',
    wp: WP,
    run(app, assert) {
      open(app, 'oilgas');
      app.win.calcOilGas();
      const hostRate = rv(app, 'og_res', 'Oil Rate'), hostApi = rv(app, 'og_res', 'API @ 60°F'), hostVcf = rv(app, 'og_res', 'VCF');
      open(app);
      const a = S(app);
      assert.rel(a.auditRate, hostRate, 6e-4, 'default rate = host (1 dp) ' + hostRate);
      assert.rel(rv(app, 'pv_res', 'Net oil rate'), hostRate, 6e-4);
      const tabTxt = txt(app, 'pv_res');
      assert.includes(tabTxt, '0.971900', 'VCF shown to 6 dp as the host: ' + hostVcf);
      assert.rel(hostApi, 33.5, 1e-9, 'host API60 row');
      // Change the host page, calculate there, then copy
      open(app, 'oilgas');
      set(app, { og_api: '28', og_ht: '90', og_m1: '1010.2', og_olt: '140', og_bsw: '5', og_mf: '1.002', og_sf: '0.92', og_int: '30' });
      app.win.calcOilGas();
      const host2 = rv(app, 'og_res', 'Oil Rate');
      app.flush(1200);
      open(app);
      app.click('pv_copy');
      assert.includes(txt(app, 'pv_copymsg'), 'Copied 9 inputs');
      assert.strictEqual(app.el('pv_aapi').value, '28');
      const r2 = app.win.WTS_state.proving.auditRate;
      assert.rel(r2, host2, 6e-4, 'copied rate = host ' + host2);
      // Independent hand value for the copied case
      const rhoObs = 141.5 * W / (28 + 131.5) * (1 - 1.278e-5 * 30 - 6.2e-9 * 900);
      let rho = rhoObs; for (let i = 0; i < 60; i++) rho = rhoObs / ctlH(rho, 90);
      const hand = 10.2 * 1.002 * ctlH(rho, 140) * 0.95 * 0.92 * 48;
      assert.rel(r2, hand, 1e-9, 'hand chain');
      // Optional CPL and GOR rows
      set(app, { pv_ap: '150', pv_agas: '500' }); calc(app);
      assert.ok(/with CPL/.test(txt(app, 'pv_res')), 'CPL step shown');
      assert.rel(rv(app, 'pv_res', 'GOR (gas rate / net oil rate)'), 500000 / r2, 1e-3, 'GOR');
      noBadNumbers(assert, app, 'audit');
    },
  },
  {
    name: 'PROVE page: registry nav in Metering & Chokes, defaults, run table, verdicts, rounding toggle, validation',
    wp: WP,
    run(app, assert) {
      const R = app.win.WTS_calcRegistry.proving;
      assert.ok(R && R.key === 'proving' && typeof R.render === 'function' && R.title === 'Meter Proving & Net Standard Volume', 'registry');
      const b = app.find('.nav-btn[data-p="proving"]');
      assert.strictEqual(String(b.closest('.nav-group').querySelector('.nav-group-label').textContent).trim(), 'Metering & Chokes');
      open(app);
      assert.strictEqual(txt(app, 'pgTitle'), 'Meter Proving & Net Standard Volume');
      assert.strictEqual(S(app).mf, 1.0012);
      assert.strictEqual(S(app).nsv, 6188.04);
      assert.rel(rv(app, 'pv_res', 'Meter factor (average data method)'), 1.0012, 1e-12);
      assert.rel(rv(app, 'pv_res', 'Net standard volume'), 6188.04, 1e-9);
      assert.rel(rv(app, 'pv_res', 'CCFp'), 0.99267, 1e-12);
      const t = txt(app, 'pv_res');
      assert.includes(t, '✓ Repeatability 0.0400 % over 5 runs is within the 0.05 % limit');
      assert.includes(t, '✓ Meter factor changed 0.070 % from the previous proving');
      assert.includes(t, '✓ Factors and volumes rounded to the API MPMS 12.2');
      assert.strictEqual(app.findAll('#pv_res table.dtable').length, 3, 'run, NSV and audit tables');
      assert.strictEqual(app.findAll('#pv_res table.dtable')[0].querySelectorAll('tbody tr').length, 5, 'five runs');
      // Bad repeatability and a big MF shift
      set(app, { pv_iv4: '50.00', pv_prev: '0.9950' }); calc(app);
      assert.includes(txt(app, 'pv_res'), '✗ Repeatability');
      assert.includes(txt(app, 'pv_res'), '⚠ Meter factor changed');
      assert.strictEqual(S(app).repeatOk, false);
      // Rounding off
      set(app, { pv_iv4: '49.970' }); app.check('pv_round', false); calc(app);
      assert.rel(S(app).mf, app.win.WTS_proving_compute(Object.assign({}, BASE, { round: false, prevMf: 0.995 })).prove.mf, 1e-12, 'unrounded');
      assert.includes(txt(app, 'pv_res'), '⚠ MPMS 12.2 rounding is off');
      app.check('pv_round', true); calc(app);
      // Validation
      set(app, { pv_bpv: '0', pv_pp2: '-3' }); calc(app);
      const e = errText(app, 'pv_res');
      assert.includes(e, 'Prover base volume'); assert.includes(e, 'Run 2: prover and meter pressures');
      assert.ok(app.el('pv_bpv').classList.contains('input-err') && app.el('pv_pp2').classList.contains('input-err'), 'flagged');
      assert.strictEqual(S(app).ok, false);
      set(app, { pv_bpv: '50', pv_pp2: '95' }); calc(app);
      assert.strictEqual(app.findAll('#pv_root .input-err').length, 0);
      assert.strictEqual(S(app).mf, 1.0012);
      noBadNumbers(assert, app, 'page');
    },
  },
  {
    name: 'PROVE metric: labels switch, state equals the imperial run, volumes in m³, unit flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      const imp = JSON.parse(JSON.stringify(S(app)));
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        assert.match(String(app.el('pv_bpv').closest('.fg-item').querySelector('label').textContent), /m³/, 'volume label');
        ['mf', 'rangePct', 'gsv', 'nsv', 'auditRate'].forEach((k) => assert.rel(S(app)[k], imp[k], 1e-6, 'metric ' + k));
        assert.rel(rv(app, 'pv_res', 'Net standard volume'), imp.nsv * 0.158987, 1e-4, 'm³');
        assert.includes(rowText(app, 'pv_res', 'Net standard volume'), 'm³');
        assert.rel(rv(app, 'pv_res', 'Net oil rate'), imp.auditRate * 0.158987, 1e-3, 'm³/d');
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).nsv, imp.nsv, 1e-9, 'recalc after flip');
    },
  },
  {
    name: 'PROVE report + persistence: sections, input and result tables, PDF, autosave restore after reload, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { pv_tsw: '0.5' }); calc(app);
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const rt = model.results.map((x) => x.title);
      ['Liquid Properties', 'Meter Proving', 'Net Standard Volume', 'Oil & Gas BS&W / Shrinkage Audit Trail'].forEach((t) => assert.ok(rt.indexOf(t) !== -1, 'results ' + t + ': ' + rt.join(' | ')));
      const tabs = [];
      model.inputs.concat(model.results).forEach((s) => s.items.forEach((x) => { if (x.type === 'table') tabs.push(s.title); }));
      ['Prover Runs', 'Meter Proving', 'Net Standard Volume'].forEach((t) => assert.ok(tabs.indexOf(t) !== -1, 'table in ' + t + ': ' + tabs.join(',')));
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Meter Proving') !== -1 && pdf.indexOf('Net standard volume') !== -1, 'PDF');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_proving') || 'null');
      assert.ok(rec && rec.f && rec.f.pv_tsw === '0.5', 'autosaved');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
      const nsv = S(app).nsv;
      const app2 = app.reload();
      try {
        app2.click(app2.find('.nav-btn[data-p="proving"]'));
        assert.strictEqual(app2.el('pv_tsw').value, '0.5');
        assert.strictEqual(app2.win.WTS_state.proving.nsv, nsv, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0);
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'PROVE phone: renders at 375 px with results and a dashboard tile',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      open(app);
      assert.ok(app.el('pv_res').querySelector('.rrow'), 'results rendered');
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no fixed widths above 340 px');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('Meter Proving & Net Standard Volume') !== -1, 'dashboard tile');
    },
  },
];
