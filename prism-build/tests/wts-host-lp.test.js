// Release 3.4.2 host lane — the LP flare line / tank gas block of calcWTS (flow.lp, designs lpgas.md §6 and INTEGRATION.md §2.8).
//   flow.lp: GOR1 = separator gas over the oil, GOR2 = the Standing flash from the separator to the surge tank at the separator
//   temperature (the engine's ΔRs of qFlashD, WTS_sim.pvt.rsEff), the T-301 residual, the FT-201 line hydraulics (design rate
//   max(3 × flash, 50 Mscf/d), P_in = P0 + K·q²), the whole-well-gas case; the three LP inputs (clamps, flow.sim); the base
//   fields never move; the 'LP flare line / tank gas' box only once a rig-up with a surge tank is handed over (Metric display).
'use strict';

const GOLD = require('../wts-calc-golden.js');
const EQ = require('./_wts-equip-shapes.js');

const WP = 'WTSLPH';
const J = (x) => JSON.parse(JSON.stringify(x));
const mix = (...a) => Object.assign({}, ...a);
const BASE = GOLD.SETS[0].vals;
const PSC = 14.696;
let CALC = null;
function calc() { if (!CALC) CALC = GOLD.makeCalc(GOLD.hostRegion()); return CALC; }
function flowOf(inputs, opts) { const r = calc().run(mix(BASE, inputs || {}), opts); if (!r.flow) throw new Error('no flow'); return r; }
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
const LP_TITLE = 'LP flare line / tank gas (FT-201)';
const RIG_ALL_IN = { esd: true, choke: true, heater: true, separator: true, surge: true, gauge: true, pump: true, flare: true,
  desander: false, surge2: false, heaterChoke: false };

module.exports = [
  {
    name: 'WTSLPH flow.lp GOR: GOR1 = Qg / Qo, GOR2 = the engine ΔRs (WTS_sim.pvt.rsEff at Psep / Psurge, separator T, 1e-9), total, flash rate, T-301 residual; GORs null below 0.1 STB/d oil',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = EQ.loadEngine('work');
      [{}, { wts_Psep: '600', wts_Psurge: '10' }, { wts_API: '45', wts_SGg: '0.8', wts_Qo: '3000' }, { wts_Psurge: '0' }].forEach((v) => {
        const f = flowOf(v).flow, lp = f.lp, Ts = f.nodes[4].T, Psep = f.inputs.Psep, Psu = f.sim.surgeP_psig;
        const SG = f.inputs.SGg, API = f.inputs.API, Qo = f.inputs.Qo, Qg = f.inputs.Qg;
        const dRs = Math.max(0, S.pvt.rsEff(Psep + PSC, Ts, SG, API) - S.pvt.rsEff(Psu + PSC, Ts, SG, API));
        assert.ok(rel(lp.gor2, dRs) < 1e-9 && rel(lp.dRs_scfstb, dRs) < 1e-9, 'GOR2 = engine ΔRs ' + JSON.stringify(v) + ': ' + lp.gor2 + ' vs ' + dRs);
        assert.ok(rel(lp.gor1, Qg * 1e6 / Qo) < 1e-12 && rel(lp.gorTot, lp.gor1 + lp.gor2) < 1e-12, 'GOR1 / total');
        assert.ok(rel(lp.flash_mscfd, Qo * dRs / 1000) < 1e-9, 'flash Mscf/d');
        assert.ok(rel(lp.residualT301_scfstb + 1e-30, S.pvt.rsEff(Psu + PSC, Ts, SG, API) + 1e-30) < 1e-9, 'T-301 residual');
        assert.ok(lp.design_mscfd >= 50 - 1e-9 && rel(lp.design_mscfd, Math.max(3 * lp.flash_mscfd, 50)) < 1e-9, 'design rate');
      });
      const z = flowOf({ wts_Qo: '0' }).flow.lp;
      assert.ok(z.gor1 === null && z.gor2 === null && z.gorTot === null && z.flash_mscfd === 0 && z.design_mscfd === 50, 'no oil: GORs null, design 50');
      assert.ok(Number.isFinite(z.P_in) && z.vel === 0 && z.vSt === 'OK', 'no oil: an idle line');
    },
  },
  {
    name: 'WTSLPH flow.lp line: inputs and clamps (NPS 2 | 3 | 4, SCH 40 | 80, length 10-5,000, blank → 150), flow.sim keys, P_in = P0 + K·q² with the design point at P0 + Darcy + tip, velocity / limit / Mach at P_in, smaller line → higher P_in; the whole-well case capped at the tank pressure; base fields untouched',
    wp: WP,
    opts: false,
    run(app, assert) {
      const d = flowOf({}).flow;
      assert.deepStrictEqual([d.sim.lpNps, d.sim.lpSch, d.sim.lpLen_ft, d.lp.nps, d.lp.sch, d.lp.ID, d.lp.L], [3, 40, 150, 3, 40, 3.068, 150], 'defaults without the inputs');
      [[{ wts_lpNps: '2', wts_lpSch: '80' }, 2, 80, 1.939], [{ wts_lpNps: '4' }, 4, 40, 4.026], [{ wts_lpNps: '6', wts_lpSch: '160' }, 3, 40, 3.068]].forEach(([v, n, s, id]) => {
        const l = flowOf(v).flow; assert.ok(l.lp.nps === n && l.lp.sch === s && l.lp.ID === id && l.sim.lpNps === n && l.sim.lpSch === s, 'line ' + JSON.stringify(v));
      });
      [['', 150], ['0', 150], ['1', 10], ['1e6', 5000], ['300', 300]].forEach(([v, w]) => assert.strictEqual(flowOf({ wts_lpLen: v }).flow.lp.L, w, 'length ' + JSON.stringify(v)));
      const lp = d.lp, D = lp.design;
      assert.ok(lp.P0_psig === 0.2 && lp.tipDP_psi === 0.25 && lp.bpAlarm_psig === Math.max(2, 0.5 * d.sim.surgeP_psig), 'P0 / tip / alarm');
      // P_in follows the quadratic law between P0 and the design point
      const K = (D.P_in - lp.P0_psig) / (D.q_mscfd * D.q_mscfd);
      assert.ok(Math.abs(lp.P_in - (lp.P0_psig + K * lp.flash_mscfd * lp.flash_mscfd)) < 1e-9, 'quadratic law');
      assert.ok(D.P_in > lp.P0_psig + lp.tipDP_psi && D.P_in < 1 && lp.P_in < D.P_in, 'design back pressure well under 1 psig at the defaults: ' + D.P_in);
      // velocity and Mach at P_in (independent recompute: actual ft³/s over the bore)
      const Ts = lp.T + 459.67, Pa = lp.P_in + PSC, A = Math.PI / 4 * Math.pow(lp.ID / 12, 2);
      const zz = d.segs[4].z;   // Z is near 1 at these pressures; use the standard volume law with the block's own vel as the check
      const vChk = lp.flash_mscfd * 1000 / 86400 * (PSC / Pa) * (Ts / 519.67) / A;
      assert.ok(Math.abs(lp.vel / vChk - 1) < 0.02 && zz > 0, 'velocity ≈ q·(Psc/P)(T/Tsc)·Z / A: ' + lp.vel + ' vs ' + vChk);
      assert.ok(Math.abs(lp.vPct - lp.vel / lp.ve * 100) < 1e-9 && lp.mach > 0 && lp.mach < 0.05 && lp.vSt === 'OK' && D.vSt === 'OK', 'limit / Mach / status');
      const small = flowOf({ wts_lpNps: '2', wts_lpSch: '80', wts_lpLen: '5000' }).flow.lp, big = flowOf({ wts_lpNps: '4' }).flow.lp;
      assert.ok(small.design.P_in > D.P_in && D.P_in > big.design.P_in && small.design.vel > D.vel && D.vel > big.design.vel, 'line size orders P_in and velocity');
      assert.ok(small.design.pah === (small.design.P_in >= small.bpAlarm_psig), 'pah flag');
      // the whole well gas into the tanks (V-101 out to T-201): far beyond the line at 10 MMscf/d, capped at the tank pressure
      const w = lp.atWell;
      assert.ok(w.q_mscfd === 10000 && w.P_in === d.sim.surgeP_psig && w.vSt === 'EXCEED' && w.pah === true, 'whole well gas: ' + JSON.stringify(w));
      // the base never depends on the LP inputs
      const bf = J(GOLD.baseFields(d));
      [{ wts_lpNps: '2', wts_lpSch: '80', wts_lpLen: '10' }, { wts_lpNps: '4', wts_lpLen: '5000' }].forEach((v) => assert.deepStrictEqual(J(GOLD.baseFields(flowOf(v).flow)), bf, 'base fields ' + JSON.stringify(v)));
      assert.ok(GOLD.BASE_FIELDS_OMIT.indexOf('lp') >= 0 && GOLD.BASE_FIELDS_OMIT.indexOf('sim.lpLen_ft') >= 0, 'golden tool omits the LP keys');
    },
  },
  {
    name: 'WTSLPH display: the LP flare line box only with a handed-over rig-up and a surge tank in (T-201, or T-202 alone); V-101 out → no GOR rows, to the surge tank → the whole-well row; no rig-up → the v3.3.1 page; a velocity warning at the design rate',
    wp: WP,
    opts: false,
    run(app, assert) {
      const C = GOLD.makeCalc(GOLD.hostRegion()), W = C.sandbox.window, $ = C.sandbox.$;
      const r = C.run(mix(BASE, {}));
      const g = GOLD.loadGolden().sets[0].page;
      assert.ok(r.page.res === g.res && r.page.res.indexOf(LP_TITLE) < 0, 'no rig-up handed over: the v3.3.1 page, no LP box');
      W.wtsRenderResults(r.flow, J(RIG_ALL_IN));
      let h = $('wts_res').innerHTML;
      assert.ok(h.indexOf(LP_TITLE) > 0 && h.indexOf(g.res) === 0, 'rig-up handed over: the LP box after the v3.3.1 rows');
      ['GOR1 (separator)', 'GOR2 (tank, PVT est.)', 'Total GOR', 'Tank flash gas (PVT est.)', 'LP line inlet P (flash / design)', 'Velocity at the design rate', 'T-301 vent, not metered'].forEach((l) =>
        assert.ok(h.indexOf('<span class="rl">' + l + '</span>') > 0, 'row ' + l));
      assert.ok(/GOR1 \(separator\)<\/span><span class="rv">10,000 scf\/STB/i.test(h), 'GOR1 10,000 scf/STB');
      assert.ok(h.indexOf('Whole well gas to the tanks') < 0, 'no whole-well row with V-101 in');
      W.wtsRenderResults(r.flow, mix(RIG_ALL_IN, { surge: false }));
      assert.ok($('wts_res').innerHTML.indexOf(LP_TITLE) < 0, 'T-201 out, T-202 out: no LP box');
      W.wtsRenderResults(r.flow, mix(RIG_ALL_IN, { surge: false, surge2: true }));
      assert.ok($('wts_res').innerHTML.indexOf(LP_TITLE) > 0, 'T-202 alone: LP box');
      // V-101 out: no separator meter (no GOR rows); to the surge tank the whole-well row appears
      const rs = C.run(mix(BASE, { wts_sepByDest: 'surge' }));
      W.wtsRenderResults(rs.flow, mix(RIG_ALL_IN, { separator: false }));
      h = $('wts_res').innerHTML;
      assert.ok(h.indexOf('GOR not measured') > 0 && h.indexOf('GOR1 (separator)') < 0 && h.indexOf('Whole well gas to the tanks') > 0, 'V-101 out to T-201: no GOR rows, whole-well row');
      const rf = C.run(mix(BASE, { wts_sepByDest: 'flare' }));
      W.wtsRenderResults(rf.flow, mix(RIG_ALL_IN, { separator: false }));
      h = $('wts_res').innerHTML;
      assert.ok(h.indexOf('GOR not measured') > 0 && h.indexOf('Whole well gas to the tanks') < 0, 'V-101 out to the burner line: no whole-well row');
      // a small long line at a large flash rate: the design-rate velocity warning and the back-pressure note
      const rv = C.run(mix(BASE, { wts_lpNps: '2', wts_lpSch: '80', wts_lpLen: '5000', wts_Qo: '60000', wts_Psep: '900', wts_Psurge: '0' }));
      W.wtsRenderResults(rv.flow, J(RIG_ALL_IN));
      const wv = $('wts_warn').innerHTML, D = rv.flow.lp.design;
      assert.ok(D.vSt !== 'OK' || D.pah, 'the case loads the line: ' + JSON.stringify(D));
      if (D.vSt !== 'OK') assert.ok(/LP flare line: velocity \d[\d,]* ft\/s is \d[\d,]*% of limit at the design rate/.test(wv), 'velocity warning: ' + wv);
      if (D.pah) assert.ok(/LP flare line: inlet [\d.,]+ psig at the design rate reaches the back-pressure alarm/.test(wv), 'back-pressure warning: ' + wv);
      const r2 = C.run(mix(BASE, {}));   // (only the last calc's flow is painted)
      assert.ok(W.wtsRenderResults(r2.flow, J(RIG_ALL_IN)) === true && $('wts_warn').innerHTML === g.warn, 'defaults: no LP warning');
    },
  },
  {
    name: 'WTSLPH page: the LP line inputs in the Dynamic Simulation card (untagged, autosaved, in flow.sim); the LP box in Metric shows m³/d and sm³/sm³',
    wp: WP,
    integration: true,
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="wts"]'); if (!b) throw new Error('no Well Test Simulator sidebar button');
      app.click(b); app.flush(500);
      ['wts_lpNps', 'wts_lpSch', 'wts_lpLen'].forEach((id) => {
        const e = app.el(id); assert.ok(e, id);
        assert.strictEqual(e.closest('.card').querySelector('.card-title').textContent, 'Dynamic Simulation', id + ' card');
        assert.ok(!e.getAttribute('data-wts-unit-cat'), id + ' untagged (D28)');
      });
      assert.strictEqual(app.el('wts_lpNps').value, '3');
      app.change('wts_lpNps', '4'); app.input('wts_lpLen', '400'); app.flush(500);
      const f = app.win.WTS_state.flow;
      assert.ok(f.sim.lpNps === 4 && f.sim.lpLen_ft === 400 && f.lp.nps === 4 && f.lp.L === 400, 'published: ' + JSON.stringify(f.sim));
      const saved = JSON.parse(app.win.localStorage.getItem('wts_page_wts') || '{}');
      assert.ok(saved.f && saved.f.wts_lpNps === '4' && saved.f.wts_lpLen === '400', 'autosaved: ' + JSON.stringify(saved.f));
      const U = app.win.WTS_units;
      U.setSystem('metric'); app.flush(400);
      const L = app.win.WTS_lastCalc;
      app.win.wtsRenderResults(L.flow, J(RIG_ALL_IN));
      const h = app.el('wts_res').innerHTML;
      assert.ok(h.indexOf(LP_TITLE) > 0 && /sm³\/sm³/.test(h) && /m³\/d/.test(h) && !/SCF\/STB|Mscf\/d/.test(h.slice(h.indexOf(LP_TITLE))), 'Metric LP box');
      U.setSystem('imperial'); app.flush(200);
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    },
  },
  {
    name: 'WTSLPH surge destination (DECISIONS 1): page default and a page without the input → the surge tank T-201 at its set point (0-30 psig), the same block shape as the burner line, choke outlet = P0 + seg 3 + 5 psi + seg 4 + seg 5, Critical, the info warning; unknown → burner line; display rows name the surge tank',
    wp: WP,
    opts: false,
    run(app, assert) {
      const f = flowOf({}).flow, sb = f.sepBy, fb = flowOf({ wts_sepByDest: 'flare' }).flow.sepBy;
      assert.ok(f.sim.sepByDest === 'surge' && sb.dest === 'surge' && sb.P0_psig === 25 && sb.P0_psig === sb.surgeP_psig, 'surge at 25 psig');
      const keys = (o) => JSON.stringify(Object.keys(o).concat(Object.keys(o.choke), Object.keys(o.nodes)));
      assert.strictEqual(keys(sb), keys(fb), 'same block shape as the burner line');
      const sum = (b) => b.P0_psig + b.segs[0].dP + 5 + b.segs[1].dP + b.segs[2].dP;
      assert.ok(Math.abs(sb.choke.Pout - sum(sb)) < 0.5 && Math.abs(sb.segs[2].Pout - 25) < 0.2 && sb.segs[2].phase === 'multi', 'walk closes on 25 psig: ' + sb.choke.Pout);
      assert.ok(sb.choke.regime === 'Critical' && sb.choke.Pout > fb.choke.Pout, 'Critical, above the burner-line outlet');
      assert.ok(sb.warnings.some((w) => w.t === 'info' && /^Whole well stream into the surge tank at 25 psig: PCV-201 vents the gas; above its capacity PSHH-201 shuts the well in/.test(w.msg)), 'info warning');
      assert.ok(!fb.warnings.some((w) => /surge tank at/.test(w.msg)), 'no surge warning on the burner line');
      assert.ok(flowOf({ wts_sepByDest: 'surge', wts_Psurge: '40' }).flow.sepBy.P0_psig === 30 && flowOf({ wts_sepByDest: 'surge', wts_Psurge: '0' }).flow.sepBy.P0_psig === 0, 'set point 0-30');
      assert.ok(flowOf({ wts_sepByDest: 'surge', wts_Psep: '20', wts_Psurge: '25' }).flow.sepBy.P0_psig === 25, 'no Psep − 10 bound');
      assert.strictEqual(flowOf({ wts_sepByDest: 'export' }).flow.sepBy.dest, 'flare', 'unknown → burner line');
      assert.deepStrictEqual(J(GOLD.baseFields(f)), J(GOLD.baseFields(flowOf({ wts_sepByDest: 'flare' }).flow)), 'base fields do not depend on the destination');
      const C = GOLD.makeCalc(GOLD.hostRegion()), W = C.sandbox.window, $ = C.sandbox.$;
      const r = C.run(mix(BASE, { wts_sepByDest: 'surge' }));
      W.wtsRenderResults(r.flow, mix(RIG_ALL_IN, { separator: false }));
      const h = $('wts_res').innerHTML, w = $('wts_warn').innerHTML;
      assert.ok(h.indexOf('>→ surge tank T-201</td>') > 0 && /With V-101 out, to surge tank T-201<\/span><span class="rv">downstream [\d,]+ psig &middot; Critical/.test(h), 'surge rows');
      assert.ok(/Whole well stream into the surge tank at 25 psig/.test(w), 'info warning painted');
    },
  },
  {
    name: 'WTSLPH page: destination select surge | flare | line (surge selected); the one-time autosave migration flare → surge with the marker wts_sepByDest_m1 (runs once; a later flare stays); a project open writes the marker first, so its value is kept',
    wp: WP,
    integration: true,
    run(app, assert) {
      const ls = app.win.localStorage, M = 'wts_sepByDest_m1';
      const go = () => { const h = app.find('.nav-btn[data-p="home"]') || app.find('.nav-btn[data-p="clientinfo"]'); if (h) { app.click(h); app.flush(200); } app.click(app.find('.nav-btn[data-p="wts"]')); app.flush(600); };
      ls.removeItem(M);
      ls.setItem('wts_page_wts', JSON.stringify({ f: { wts_sepByDest: 'flare', wts_Psurge: '20' } }));
      ls.setItem('wts_wts', JSON.stringify({ wts_sepByDest: 'flare' }));
      go();
      assert.strictEqual(app.el('wts_sepByDest').value, 'surge', 'migrated to the surge tank');
      assert.strictEqual(app.el('wts_Psurge').value, '20', 'other values restored');
      assert.strictEqual(ls.getItem(M), '1', 'marker written');
      assert.strictEqual(JSON.parse(ls.getItem('wts_wts')).wts_sepByDest !== 'flare', true, 'legacy list migrated');
      assert.strictEqual(app.win.WTS_state.flow.sepBy.dest, 'surge', 'flow follows');
      app.change('wts_sepByDest', 'flare'); app.flush(600);
      go();
      assert.strictEqual(app.el('wts_sepByDest').value, 'flare', 'a later burner-line choice stays (runs once)');
      // a project open: its keys replace the autosave (marker cleared with them); the open writes the marker before the page re-renders
      ls.removeItem(M);
      ls.setItem('wts_page_wts', JSON.stringify({ f: { wts_sepByDest: 'flare' } }));
      app.win.document.dispatchEvent(new app.win.CustomEvent('wts:project-loaded', { detail: { loaded: ['storage'] } }));
      assert.strictEqual(ls.getItem(M), '1', 'project open writes the marker');
      go();
      assert.strictEqual(app.el('wts_sepByDest').value, 'flare', 'the project value is kept');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    },
  },
  {
    name: 'WTSLPH Quick Report GOR rows (flow.lp; simulator metered GOR1 / GOR2 when WTS_state.sim has them) and Mini WellOS form KPIs (GOR (sep), tank gas from flow.lp, total GOR with quality)',
    wp: WP,
    integration: true,
    run(app, assert) {
      const W = app.win;
      app.click(app.find('.nav-btn[data-p="wts"]')); app.flush(500);
      const lp = W.WTS_state.flow.lp;
      let h = String(W.WTS_quickReport.preview({ modules: ['wts'] }));
      const qrRow = (l) => { const m = h.match(new RegExp('<tr><th>' + l.replace(/[()]/g, '\\$&') + '</th><td>([^<]*)<')); return m ? m[1] : null; };
      assert.ok(/^10,000/.test(qrRow('GOR1 (separator)')) && /^18/.test(qrRow('GOR2 (tank, PVT est.)')) && /^10,018/.test(qrRow('Total GOR')), 'Quick Report GOR rows: ' + [qrRow('GOR1 (separator)'), qrRow('GOR2 (tank, PVT est.)'), qrRow('Total GOR')]);
      assert.ok(h.indexOf('Total GOR') > h.indexOf('Water Rate'), 'after Water Rate');
      assert.strictEqual(qrRow('Simulator GOR1 / GOR2 (metered)'), null, 'no simulator row without WTS_state.sim rates');
      const keepSim = W.WTS_state.sim;
      W.WTS_state.sim = { running: true, rates: { gor: 10020, gor1: 10001, gor2: 19, gorTot: 10020 } };
      h = String(W.WTS_quickReport.preview({ modules: ['wts'] }));
      assert.ok(/^10,001 \/ 19/.test(qrRow('Simulator GOR1 / GOR2 (metered)') || ''), 'simulator metered row: ' + qrRow('Simulator GOR1 / GOR2 (metered)'));
      W.WTS_state.sim = keepSim;
      // Mini WellOS (form data)
      const nb = app.find('.nav-btn[data-p="wellos"]');
      assert.ok(nb && W.WTS_modbus && W.WTS_modbus.wellos, 'Mini WellOS present');
      {
        app.click(nb); app.flush(1500);
        const C = W.WTS_modbus.wellos.controller(), cur = C.current();
        assert.ok(cur.q.tank_gas === 'good' && Math.abs(cur.vals.tank_gas - lp.flash_mscfd) < 1e-9, 'tank gas from flow.lp: ' + cur.vals.tank_gas);
        assert.ok(Math.abs(cur.vals.gor_total - (cur.vals.gas_rate * 1e6 + cur.vals.tank_gas * 1e3) / cur.vals.oil_rate) < 1e-6 && cur.q.gor_total === cur.q.gor, 'total GOR');
        const kp = app.findAll('#wos_kpis .kpi').map((k) => String(k.querySelector('.kpi-l').textContent));
        assert.deepStrictEqual(kp.slice(-2), ['Tank gas (FT-201)', 'Total GOR']);
        assert.ok(kp.indexOf('GOR (sep)') >= 0, 'GOR relabelled');
      }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    },
  },
];
