// Well Test Simulator follow-up — review round (WP-I, lead): regression tests of the fixes to the engineering / GUI / compat review
// (docs/SIM-FOLLOWUP-PLAN.md §12.5). Each test names the issue it guards:
//   R1  a flow-limited flow.ck2 block publishes one physical state: the walk at the pair capacity QmaxPair (= the same walk run
//       at that rate), never the requested-rate state (No Flow: Pm above the WHP, 0 °F of J-T, a heater inlet at 30 °F)
//   R2  the engine on a real calcWTS flow runs that state: live Pm / CK-101 outlet / duty = the block, and the CK-102 inlet = the
//       heater inlet ('inlet' position: the same point)
//   R3  midcoil: the engine's heater inlet is the coil inlet the host publishes (flow.ck2.heater.Tin), not the CK-102 outlet, so
//       the cushion's steady heat-capacity rate mcpSs = duty·eff / (Th − coil inlet)
//   R4  during a cushion unload with CK-102 in line, the CK-102 inlet follows the live CK-101 outlet and its regime the live ratio
//   R5  the page with CK-102 in line / V-101 out shows the active block's states in the Choke / Heater / Separator rows
//   R6  Production line pressure comes back from the page autosave alone (wts_page_wts), and the row looks disabled with the burner
//   R7  alarm texts: PSHH-104 and SEPBY_RATING with thousands separators and the choke-outlet pressure; CUSH_LIMIT / CUSH_DUMP
//       through the host formatter (Metric)
'use strict';

const X = require('./_wts-fu-shapes');
const GOLD = require('../wts-calc-golden.js');

const WP = 'WTSFU';
const J = (x) => JSON.parse(JSON.stringify(x));
const mix = (...a) => Object.assign({}, ...a);
const BASE = GOLD.SETS[0].vals;
let CALC = null;
function calc() { if (!CALC) CALC = GOLD.makeCalc(GOLD.hostRegion()); return CALC; }
function flowOf(inputs) { const r = calc().run(mix(BASE, inputs || {})); if (!r.flow) throw new Error('no flow'); return r; }
const NZ = { noise: { on: false } };
const alarm = (st, id) => st.alarms.find((a) => a.id === id) || null;
function adv(sim, secs, dt) { dt = dt || 1; const n = Math.round(secs / dt); for (let i = 0; i < n; i++) sim.advance(dt); }
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));

module.exports = [
  {
    name: 'WTSFU R1 flow-limited flow.ck2 = the walk at the pair capacity (24/64 No Flow, 32/64, separator 1,500 "both"): equal to the page run at Qg = QmaxPair; Pm below the CK-101 inlet; one state',
    wp: WP,
    opts: false,
    run(app, assert) {
      [{ wts_bean2: '24' }, { wts_bean2: '32' }, { wts_Psep: '1500', wts_bean2: '32' }].forEach((o) => {
        const tag = JSON.stringify(o), fl = flowOf(o).flow, k = fl.ck2;
        assert.ok(k.flowLimited && k.QmaxMMscfd < 10, tag + ' flow-limited');
        // the same walk run at the pair capacity (every rate scaled, as the walk's qs does): not limited, so it publishes that state
        const lf = k.QmaxMMscfd / 10, q = flowOf(mix(o, { wts_Qg: String(k.QmaxMMscfd), wts_Qo: String(1000 * lf), wts_Qw: String(200 * lf) })).flow.ck2;
        assert.ok(!q.noFlow, tag + ': a state exists at QmaxPair');
        [['Pin', (b) => b.Pin], ['Pout', (b) => b.Pout], ['ck1.Pout', (b) => b.ck1.Pout], ['ck1.Tout', (b) => b.ck1.Tout], ['Tout', (b) => b.Tout],
          ['duty', (b) => b.heater.dutyMMBtuHr], ['heater.Tin', (b) => b.heater.Tin], ['seg3 dP', (b) => b.segs[0].dP], ['seg4 dP', (b) => b.segs[1].dP]]
          .forEach(([n, g]) => assert.ok(rel(g(k), g(q)) < 0.002 || Math.abs(g(k) - g(q)) < 0.01, tag + ' ' + n + ': ' + g(k) + ' vs ' + g(q)));
        assert.ok(k.regime === q.regime && k.ck1.regime === q.ck1.regime, tag + ' regimes at QmaxPair: ' + k.regime + ' / ' + k.ck1.regime);
        assert.ok(k.Pin < fl.choke.Pin && k.ck1.Pout < fl.choke.Pin - 0.5 && k.ck1.dTjt > 1 && k.Tin < 180, tag + ': below the CK-101 inlet, CK-101 J-T > 0');
        assert.ok(Math.abs(k.nodes.choke.P - k.nodes.heaterChoke.Pin - k.segs[0].dP) < 1e-6 && k.nodes.heater.Tin === k.heater.Tin, tag + ': node chain');
      });
      // 24/64: the No Flow flag stays (no state at 10 MMscf/d); the page says the states are at the pair capacity
      const r = calc().run(mix(BASE, { wts_bean2: '24' }));
      assert.ok(r.flow.ck2.noFlow === true && r.flow.ck2.regime === 'Critical' && r.flow.ck2.Pin < 3000, '24/64: flag + regime at QmaxPair');
      calc().sandbox.window.wtsRenderResults(r.flow, mix(X.RIG_DEFAULTS, { heaterChoke: true }));
      const res = calc().sandbox.$('wts_res').innerHTML;
      assert.ok(/States shown at<\/span><span class="rv">the pair capacity 5\.69 MMSCFD/.test(res) && /Upstream P \(between the chokes\)<\/span><span class="rv">2,796 psig/.test(res), 'rbox at the pair capacity');
      calc().sandbox.window.wtsRenderResults(r.flow, J(X.RIG_DEFAULTS));
    },
  },
  {
    name: 'WTSFU R2 engine on a real calcWTS flow (CK-102 24/64 and 32/64): live Pm, CK-101 outlet, CK-102 node, duty and heater inlet = flow.ck2 at the pair capacity; CK-101 regime at the pair capacity',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      ['24', '32'].forEach((b2) => {
        const fl = flowOf({ wts_bean2: b2 }).flow, k = fl.ck2;
        const s = S.create(J(fl), { seed: 5, config: NZ, rigup: { heaterChoke: true } });
        adv(s, 600, 1);
        const st = s.getState(), N = st.nodes, nk = N.heaterChoke;
        assert.near(st.f, k.QmaxMMscfd / 10, 0.003, b2 + ': rate at the pair capacity');
        assert.ok(rel(nk.Pin, k.Pin) < 0.003, b2 + ': live Pm ' + nk.Pin + ' = page ' + k.Pin);
        assert.ok(rel(N.choke.P, k.ck1.Pout) < 0.003 && N.choke.P < N.choke.Pin - 50, b2 + ': CK-101 outlet ' + N.choke.P + ' (page ' + k.ck1.Pout + ', inlet ' + N.choke.Pin + ')');
        // CK-102 outlet: the block less the fixed 5 psi H-101 drop scaled with f² (as the base), on the live separator pressure
        assert.ok(Math.abs(nk.P - (k.Pout - 5 * (1 - st.fInst * st.fInst) + (N.separator.P - fl.inputs.Psep))) < 0.1, b2 + ': CK-102 outlet ' + nk.P);
        assert.ok(N.choke.regime === k.ck1.regime && nk.regime === 'Critical', b2 + ': regimes ' + N.choke.regime + ' / ' + nk.regime);
        assert.ok(Math.abs(N.choke.T - k.ck1.Tout) < 0.5 && Math.abs(nk.Tin - k.Tin) < 0.5 && Math.abs(nk.T - k.Tout) < 1, b2 + ': CK-101 / CK-102 temperatures');
        assert.ok(Math.abs(N.heater.Tin - nk.T) < 1, b2 + ': heater inlet ' + N.heater.Tin + ' = CK-102 outlet ' + nk.T + ' (the same point on "inlet")');
        assert.ok(rel(N.heater.dutyMMBtuHr, k.heater.dutyMMBtuHr) < 0.01, b2 + ': duty ' + N.heater.dutyMMBtuHr + ' vs ' + k.heater.dutyMMBtuHr);
        assert.ok(alarm(st, 'CHOKE2_LIMIT') && !alarm(st, 'ESD_TRIPPED'), b2 + ': CHOKE2_LIMIT, no ESD');
      });
    },
  },
  {
    name: 'WTSFU R3 midcoil: the engine heater inlet = the coil inlet (flow.ck2.heater.Tin), the CK-102 node keeps its own inlet / outlet; cushion mcpSs on the coil inlet',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const fl = flowOf({ wts_bean2: '48', wts_ck2Pos: 'midcoil' }).flow, k = fl.ck2;
      assert.ok(k.pos === 'midcoil' && k.heater.Tin > k.Tout + 10 && k.heater.Tin < k.Tin, 'host: coil inlet ' + k.heater.Tin + ' (T3) between the CK-102 outlet ' + k.Tout + ' and the pass-1 outlet ' + k.Tin);
      const s = S.create(J(fl), { seed: 5, config: NZ, rigup: { heaterChoke: true } });
      adv(s, 300, 1);
      const st = s.getState();
      assert.ok(Math.abs(st.nodes.heater.Tin - k.heater.Tin) < 0.2, 'engine heater inlet ' + st.nodes.heater.Tin + ' = coil inlet ' + k.heater.Tin);
      assert.ok(Math.abs(st.nodes.heaterChoke.T - k.Tout) < 0.5 && Math.abs(st.nodes.heaterChoke.Tin - k.Tin) < 0.5, 'CK-102 node at the pass-1 outlet');
      const r = s.startCushion({});
      assert.ok(r && r.ok, 'cushion started');
      const c = s._internal().fu.cushS, eff = fl.inputs.htrEff;
      const want = k.heater.dutyMMBtuHr * eff * 1e6 / (k.heater.Tout - k.heater.Tin);
      assert.ok(rel(c.mcpSs, want) < 0.005, 'mcpSs ' + c.mcpSs + ' = duty·eff / (Th − coil inlet) ' + want + ' (not / (Th − CK-102 outlet))');
    },
  },
  {
    name: 'WTSFU R4 cushion unload with CK-102 in line (production line 300 psig): the CK-102 inlet follows the live CK-101 outlet (within 1 °F), small ΔP → Subcritical; heater inlet consistent',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const fl = flowOf({ wts_bean2: '48', wts_sepByDest: 'line', wts_sepByP: '300' }).flow;
      const s = S.create(J(fl), { seed: 5, config: NZ, rigup: { heaterChoke: true, separator: false } });
      adv(s, 120, 1);
      assert.ok(s.startCushion({}).ok, 'started');
      let seen = 0;
      for (let t = 0; t < 2000; t += 10) {
        adv(s, 10, 10);
        const st = s.getState(), N = st.nodes, nk = N.heaterChoke;
        if (st.cushion.phase !== 'unloading') continue;
        seen++;
        assert.ok(Math.abs(nk.Tin - N.choke.T) < 1, 't ' + st.t + ': CK-102 inlet ' + nk.Tin + ' = CK-101 outlet ' + N.choke.T);
        if (nk.Pin - nk.P < 10) assert.strictEqual(nk.regime, 'Subcritical', 't ' + st.t + ': ΔP ' + (nk.Pin - nk.P).toFixed(2) + ' psi');
        // the heater inlet (the cushion's own blend from its steady value) meets the CK-102 outlet once the cushion temperatures are in
        if (s._internal().fu.cushS.kT >= 0.95) assert.ok(Math.abs(N.heater.Tin - nk.T) < 2, 't ' + st.t + ': heater inlet ' + N.heater.Tin + ' vs CK-102 outlet ' + nk.T);
      }
      assert.ok(seen > 20, 'unloading samples ' + seen);
      // without a cushion the regime follows the live ratio as well: critical at the steady 48/64 state
      const q = S.create(J(flowOf({ wts_bean2: '48' }).flow), { seed: 5, config: NZ, rigup: { heaterChoke: true } });
      adv(q, 300, 1);
      assert.strictEqual(q.getState().nodes.heaterChoke.regime, 'Critical', '48/64 steady: Critical');
    },
  },
  {
    name: 'WTSFU R5 page rows: CK-102 in line → Choke / Heater rows from flow.ck2 (CK-101 outlet 1,135 psig on 48/64); V-101 out → Choke / Heater / Separator from flow.sepBy; neither → the v3.3.1 page',
    wp: WP,
    opts: false,
    run(app, assert) {
      const C = GOLD.makeCalc(GOLD.hostRegion()), W = C.sandbox.window, $ = C.sandbox.$;
      const row = (html, nm) => { const m = new RegExp('<tr><td style="font-weight:600">' + nm.replace(/[()]/g, '\\$&') + '</td><td>([^<]*)</td><td>([^<]*)</td>').exec(html); return m ? [m[1], m[2]] : null; };
      const r = C.run(mix(BASE, { wts_bean2: '48' }));
      W.wtsRenderResults(r.flow, mix(X.RIG_DEFAULTS, { heaterChoke: true }));
      let h = $('wts_res').innerHTML;
      assert.deepStrictEqual(row(h, 'Choke (with CK-102)'), ['1,135', '107.0'], 'Choke row = the CK-101 outlet with CK-102');
      assert.ok(row(h, 'Heater (with CK-102)') && row(h, 'Heater choke (CK-102)') && !row(h, 'Choke'), 'Heater row replaced, CK-102 row kept, no base Choke row');
      assert.ok(h.indexOf('Heater choke (CK-102)') > h.indexOf('Choke (with CK-102)') && h.indexOf('Heater (with CK-102)') > h.indexOf('Heater choke (CK-102)'), 'row order Choke → CK-102 → Heater');
      const rb = C.run(mix(BASE, { wts_bean2: '48' }));
      W.wtsRenderResults(rb.flow, mix(X.RIG_DEFAULTS, { separator: false }));
      h = $('wts_res').innerHTML;
      const sb = rb.flow.sepBy;
      assert.deepStrictEqual(row(h, 'Choke (V-101 out)'), [Math.round(sb.nodes.choke.P).toString(), sb.nodes.choke.T.toFixed(1)], 'Choke row from flow.sepBy');
      assert.ok(row(h, 'Heater (V-101 out)') && row(h, 'Separator (bypassed: line at V-101)'), 'Heater / Separator rows from flow.sepBy');
      // the base segment velocity warnings of seg 3-5 give way to the block's (no duplicates)
      const w = $('wts_warn').innerHTML;
      // 4.1 review: the page default destination is the surge tank, whose seg-5 run is named for its route (Bypass→Surge Tank)
      ['Heater→Sep', 'Bypass→Surge Tank'].forEach((nm) => assert.strictEqual(w.split(nm + ': Velocity').length - 1, 1, nm + ' velocity warning once: ' + w));
      assert.ok(w.indexOf('Sep→Flare: Velocity') < 0, 'no Sep→Flare warning on the surge route');
      W.wtsRenderResults(rb.flow, J(X.RIG_DEFAULTS));
      const g = GOLD.loadGolden().sets[0].page;
      const r0 = C.run(mix(BASE, {}));
      // v4.1 (2026-11-09): the kept rig-up has T-201 in, so the LP flare line box follows the v3.3.1 rows (only that)
      const noLp = (h) => { const i = h.indexOf('<div class="rbox" style="margin-top:10px"><div class="rbox-title">LP flare line'); return i < 0 ? h : h.slice(0, i); };
      assert.ok(noLp(r0.page.res) === g.res && r0.page.warn === g.warn, 'neither active: the v3.3.1 page (+ the LP box)');
    },
  },
  {
    name: 'WTSFU R6 page: Production line pressure is restored from wts_page_wts alone (no legacy wts_wts list); the row is muted (wts-dis) with the burner line',
    wp: WP,
    integration: true,
    run(app, assert, ctx) {
      const go = (a) => { const b = a.find('.nav-btn[data-p="wts"]'); if (!b) throw new Error('no Well Test Simulator button'); a.click(b); a.flush(800); };
      go(app);
      const item = (a) => a.el('wts_sepByP').closest('.fg-item');
      assert.ok(app.el('wts_sepByP').disabled && item(app).classList.contains('wts-dis'), 'burner line: disabled and muted');
      app.change('wts_sepByDest', 'line'); app.flush(400);
      assert.ok(!app.el('wts_sepByP').disabled && !item(app).classList.contains('wts-dis'), 'line: enabled, not muted');
      app.input('wts_sepByP', '300'); app.flush(800);
      app.input('wts_bean2', '32'); app.flush(800);
      if (app.win.WTS_pageAutosave && app.win.WTS_pageAutosave.flush) app.win.WTS_pageAutosave.flush();
      app.win.localStorage.removeItem('wts_wts');                   // only the universal page record is left
      assert.ok(/wts_sepByP/.test(app.win.localStorage.getItem('wts_page_wts') || ''), 'page record holds the line pressure');
      const b = ctx.loadApp({ storage: app.storage });
      go(b); b.flush(1000);
      assert.ok(b.el('wts_sepByDest').value === 'line' && b.el('wts_sepByP').value === '300' && !b.el('wts_sepByP').disabled, 'restored: line at ' + b.el('wts_sepByP').value);
      assert.strictEqual(b.win.WTS_state.flow.sepBy.P0_psig, 300, 'flow.sepBy.P0_psig 300 after the reload');
    },
  },
  {
    name: 'WTSFU R7 alarm texts: PSHH-104 grouped ("1,4xx psig"); SEPBY_RATING quotes the choke-outlet pressure and the whole line loss; CUSH_LIMIT / CUSH_DUMP through the host formatter',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const ex = X.EXAMPLES.flowSepBy;
      const byp = (P) => { const f = J(S.SAMPLE_FLOW); f.sepBy = X.EXAMPLES.flowSepBy; f.sim.sepByDest = 'line'; f.sepBy.dest = 'line'; f.sepBy.P0_psig = P; f.sim.sepByP_psig = P; return f; };
      const a = S.create(byp(1400), { seed: 7, config: NZ, rigup: { separator: false } });
      adv(a, 30, 1);
      const A = alarm(a.getState(), 'PSHH_SEPBY');
      assert.ok(A && /^PSHH-104: bypass path 1,4\d\d psig ≥ 90 % of its 1,440 psig design pressure/.test(A.msg), 'PSHH-104 text: ' + (A && A.msg));
      const P = 1440 - ex.segs[2].dP / 2, c = S.create(byp(P), { seed: 7, config: NZ, rigup: { separator: false } });
      c.advance(1);
      const st = c.getState(), R = alarm(st, 'SEPBY_RATING');
      assert.ok(R && X.textRe(X.ALARM_TEXTS.SEPBY_RATING).test(R.msg) && Math.abs(R.value - st.nodes.choke.P) < 0.5 && R.value > 1440, 'rating on the choke outlet: ' + (R && R.msg) + ' / ' + st.nodes.choke.P);
      assert.ok(/plus line loss \d+\.\d psi\)/.test(R.msg) && R.msg.indexOf('1,44') >= 0, 'loss with 1 dp, grouped pressures: ' + R.msg);
      // Metric: the cushion liquid rates through the formatter (no bbl/d left in the text)
      const fmt = (v, cat, dp) => cat === 'liquidRate' ? (v * 0.158987).toFixed(dp == null ? 0 : dp) + ' m³/d' : cat === 'pressureG' ? (v * 0.0689476).toFixed(1) + ' barg' : null;
      const m = S.create(J(S.SAMPLE_FLOW), { seed: 7, config: NZ });
      m.setFormatter(fmt);
      const r = m.startCushion({});
      assert.ok(r.ok && /V-101 water dump passes \d+ m³\/d/.test(r.warn) && r.warn.indexOf('bbl/d') < 0, 'CUSH_DUMP (Start) metric: ' + r.warn);
      adv(m, 30, 5);
      const D = alarm(m.getState(), 'CUSH_DUMP');
      assert.ok(D && D.msg.indexOf('m³/d') > 0 && D.msg.indexOf('bbl/d') < 0, 'CUSH_DUMP metric: ' + (D && D.msg));
      const l = S.create(J(mix(S.SAMPLE_FLOW, { inputs: mix(S.SAMPLE_FLOW.inputs, { bean: 12, Qg: 1 }) })), { seed: 7, config: NZ, rigup: { separator: false } });
      l.setFormatter(fmt);
      l.startCushion({}); adv(l, 120, 5);
      const L = alarm(l.getState(), 'CUSH_LIMIT');
      assert.ok(L && /CK-101 bean limits the cushion unload: \d+ m³\/d of \d+ m³\/d/.test(L.msg), 'CUSH_LIMIT metric: ' + (L && L.msg));
      l.setFormatter(null);
      const n = S.create(J(mix(S.SAMPLE_FLOW, { inputs: mix(S.SAMPLE_FLOW.inputs, { bean: 12, Qg: 1 }) })), { seed: 7, config: NZ, rigup: { separator: false } });
      n.startCushion({}); adv(n, 120, 5);
      const L2 = alarm(n.getState(), 'CUSH_LIMIT');
      assert.ok(L2 && /CK-101 bean limits the cushion unload: [\d,]+ of 1,500 bbl\/d/.test(L2.msg), 'CUSH_LIMIT field units: ' + (L2 && L2.msg));
    },
  },
];
