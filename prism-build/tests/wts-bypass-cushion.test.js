// Well Test Simulator follow-up — bypass destination and cushion unload (docs/SIM-FOLLOWUP-PLAN.md §4, §6, §9.2
// wts-bypass-cushion; HELP-GUIDE-PLAN §8.3 as corrected).
//   Host group (WP-C): the V-101-out walk of calcWTS (flow.sepBy, and flow.sepBy.ck2) — the choke outlet follows the
//   destination (burner / flare line at the 5 psig header or a production line at P psig), not the separator pressure;
//   wts_sepByP 0 is kept; destination ≥ choke inlet → No Flow; the subcritical and rating warnings; the surge set point
//   without the Psep − 10 bound; the strict shape; the base fields untouched; the display rows (destination Node-table row,
//   the V-101-out choke line, the surge-vs-separator warning hidden while V-101 is out). The integration test runs the real
//   page: the two Dynamic Simulation inputs, labels, options, the line pressure disabled / rp-skip while 'flare'.
//   Engine group (WP-E2): appended below the host group by WP-E2.
// Expected values: the fixture (plan constants), the segment losses the block publishes, plan texts.
'use strict';

const { legacyCfg } = require('./_wts-lineup-pin.js');

const X = require('./_wts-fu-shapes');
const GOLD = require('../wts-calc-golden.js');

const WP = 'WTSFU';
const J = (x) => JSON.parse(JSON.stringify(x));
const mix = (...a) => Object.assign({}, ...a);
const BASE = GOLD.SETS[0].vals;
let CALC = null;
function calc() { if (!CALC) CALC = GOLD.makeCalc(GOLD.hostRegion()); return CALC; }
function flowOf(inputs, opts) { const r = calc().run(mix(BASE, inputs || {}), opts); if (!r.flow) throw new Error('no flow'); return r; }
const warnHas = (b, tpl) => (b.warnings || []).some((w) => X.textRe(tpl).test(w.msg));
const LINE = (P) => ({ wts_sepByDest: 'line', wts_sepByP: String(P) });

const HOST = [
  // ─── host group (WP-C) ─────────────────────────────────────────────────────
  {
    name: 'WTSFU C bypass destination: flow.sepBy walks from the destination (burner line 5 psig, production line P) through the whole-stream seg 5; independent of the separator pressure; strict shape; base fields untouched',
    wp: WP,
    opts: false,
    run(app, assert) {
      // v3.4.2 (2026-11-09): the page default destination is the surge tank T-201; this test is about the burner line (pinned)
      const fl = flowOf({ wts_sepByDest: 'flare' }).flow, sb = fl.sepBy;
      const sh = X.checkShape('flow.sepBy', sb, { strict: true });
      assert.ok(sh.ok, 'shape: ' + sh.errors.slice(0, 4).join('; '));
      assert.ok(sb.dest === 'flare' && sb.P0_psig === X.P_FLARE_HDR && sb.noFlow === false && sb.designP_psig === 1440, 'burner line P0 = the header');
      assert.ok(sb.segs[2].id === 'sep_flare' && sb.segs[2].phase === 'multi' && fl.segs[4].phase === 'gas', 'seg 5 whole stream (the base keeps gas only)');
      // the walk closes on P0: choke outlet = P0 + seg 3 + 5 psi heater + seg 4 + seg 5 (fixed-point residual well below 1 psi)
      const sum = (b) => b.P0_psig + b.segs[0].dP + 5 + b.segs[1].dP + b.segs[2].dP;
      assert.ok(Math.abs(sb.choke.Pout - sum(sb)) < 0.5, 'burner: ' + sb.choke.Pout + ' vs ' + sum(sb));
      assert.ok(Math.abs(sb.segs[2].Pout - sb.P0_psig) < 0.2, 'seg 5 arrives at P0: ' + sb.segs[2].Pout);
      assert.ok(sb.nodes.choke.P === sb.choke.Pout && sb.nodes.heater.P === sb.choke.Pout - sb.segs[0].dP - 5 && sb.nodes.sep.P === sb.segs[1].Pout, 'node chain');
      assert.ok(sb.choke.Pout < fl.choke.Pout && sb.choke.regime === 'Critical', 'below the separator-side outlet, still critical');
      const l3 = flowOf(LINE(300)).flow.sepBy;
      assert.ok(l3.dest === 'line' && l3.P0_psig === 300 && Math.abs(l3.choke.Pout - sum(l3)) < 0.5 && l3.choke.Pout > 300, 'line 300: ' + l3.choke.Pout);
      // the destination, not Psep, sets the outlet; the base follows Psep as before
      const a = flowOf(mix(LINE(300), { wts_Psep: '150' })).flow, b = flowOf(mix(LINE(300), { wts_Psep: '600' })).flow;
      assert.deepStrictEqual(J(a.sepBy), J(b.sepBy), 'flow.sepBy does not depend on the separator pressure');
      assert.ok(b.choke.Pout > a.choke.Pout + 400, 'the base still follows Psep');
      // base fields never depend on the destination inputs
      const bf = J(X.baseFields(fl));
      [LINE(0), LINE(1400), { wts_sepByDest: 'flare', wts_sepByP: '900' }].forEach((v) => assert.deepStrictEqual(J(X.baseFields(flowOf(v).flow)), bf, 'base fields: ' + JSON.stringify(v)));
      // flow.sepBy.ck2: the two-stage walk from the destination (a flow.ck2 shape)
      const c = flowOf(mix(LINE(300), { wts_bean2: '48' })).flow.sepBy.ck2;
      assert.ok(c && c.skipped === false && X.checkShape('flow.ck2', c, { strict: true }).ok, 'sepBy.ck2 shape');
      assert.ok(Math.abs(c.Pout - (l3.nodes.heater.P + 5)) < 0.5 && c.Pin > c.Pout && c.ck1.Pout > c.Pin, 'sepBy.ck2 from the line: ' + c.Pout);
      assert.strictEqual(flowOf({ wts_Qg: '0' }).flow.sepBy.ck2.skipped, true, 'Qg 0: sepBy.ck2 skipped');
    },
  },
  {
    name: 'WTSFU C bypass destination: inputs and clamps (0 psig kept, blank → 150, 0–1,440), flow.sim keys, surge set point without the Psep − 10 bound, warnings (No Flow, subcritical, rating) only in flow.sepBy.warnings',
    wp: WP,
    opts: false,
    run(app, assert) {
      const z = flowOf(LINE(0)).flow;
      assert.ok(z.sim.sepByDest === 'line' && z.sim.sepByP_psig === 0 && z.sepBy.P0_psig === 0, 'an entered 0 psig is kept');
      [['', 150], ['-5', 0], ['5000', 1440], ['1e400', 150], ['300', 300]].forEach(([v, w]) => {
        const f = flowOf(LINE(v)).flow; assert.ok(f.sim.sepByP_psig === w && f.sepBy.P0_psig === w, 'sepByP ' + JSON.stringify(v) + ' → ' + f.sim.sepByP_psig);
      });
      const fl = flowOf({ wts_sepByDest: 'export', wts_sepByP: '300' }).flow;
      assert.ok(fl.sim.sepByDest === 'flare' && fl.sepBy.dest === 'flare' && fl.sepBy.P0_psig === 5 && fl.sim.sepByP_psig === 300, 'unknown destination → flare; the line P still published');
      // surge set point with V-101 out: 0–30, no Psep − 10 bound (the base keeps it)
      const s = flowOf({ wts_Psep: '20', wts_Psurge: '25' }).flow;
      assert.ok(s.sim.surgeP_psig === 10 && s.sepBy.surgeP_psig === 25, 'surge: base ' + s.sim.surgeP_psig + ', sepBy ' + s.sepBy.surgeP_psig);
      assert.strictEqual(flowOf({ wts_Psurge: '40' }).flow.sepBy.surgeP_psig, 30);
      // destination ≥ choke upstream pressure → No Flow (WHP 500, line 1,400 psig)
      const nf = flowOf(mix(LINE(1400), { wts_Pwh: '500' })).flow.sepBy;
      assert.ok(nf.noFlow && nf.choke.regime === 'No Flow' && warnHas(nf, X.WARN_TEXTS.sepByNoFlow), 'No Flow: ' + JSON.stringify(nf.warnings));
      assert.ok(X.checkShape('flow.sepBy', nf, { strict: true }).ok, 'No Flow shape (finite numbers)');
      // a high line pressure makes CK-101 subcritical (WHP 2,000, line 1,200 psig)
      const sc = flowOf(mix(LINE(1200), { wts_Pwh: '2000' })).flow.sepBy;
      assert.ok(sc.choke.regime === 'Subcritical' && warnHas(sc, X.WARN_TEXTS.sepBySubcrit) && !warnHas(sc, X.WARN_TEXTS.sepByNoFlow), 'subcritical: ' + JSON.stringify(sc.warnings));
      // production line plus the line loss above the bypass-path design pressure
      const rt = flowOf(LINE(1440)).flow.sepBy;
      // review round: the rating is at the CK-101 outlet (line + the whole loss to the choke, 1 dp), and PSHH-104 is named on the page
      assert.ok(warnHas(rt, X.WARN_TEXTS.sepByRating) && rt.warnings.some((w) => /^Bypass path 1,44\d psig at the CK-101 outlet \(production line 1,440 psig plus line loss [1-9]\d*\.\d psi\)/.test(w.msg)), 'rating: ' + JSON.stringify(rt.warnings));
      assert.ok(Math.abs(rt.choke.Pout - 1440 - 5.6) < 0.5, 'CK-101 outlet ≈ 1,445.6 psig at line 1,440: ' + rt.choke.Pout);
      [[1290, false], [1300, true], [1440, true], [300, false]].forEach(([P, on]) => {
        const w = flowOf(LINE(P)).flow.sepBy;
        assert.strictEqual(warnHas(w, X.WARN_TEXTS.sepByPshh), on, 'PSHH-104 page warning at line ' + P + ' psig: ' + JSON.stringify(w.warnings));
      });
      assert.ok(!warnHas(flowOf(LINE(300)).flow.sepBy, X.WARN_TEXTS.sepByRating) && flowOf(LINE(300)).flow.sepBy.warnings.length === 0, 'no warnings at line 300');
      // the burner line at the defaults: the whole stream runs above the erosional velocity on seg 4 and seg 5 (review round), so the
      // block carries exactly the segment velocity warnings in the base text form (the engine raises VEL_* live)
      const dw = flowOf({ wts_sepByDest: 'flare' }).flow.sepBy;   // v3.4.2: the burner line pinned (page default 'surge')
      const vel = dw.warnings.filter((w) => X.textRe(X.WARN_TEXTS.segVelExceed).test(w.msg) || X.textRe(X.WARN_TEXTS.segVelWarn).test(w.msg));
      assert.ok(vel.length === dw.warnings.length && dw.segs.filter((g) => g.vSt !== 'OK').length === vel.length, 'defaults: velocity warnings only ' + JSON.stringify(dw.warnings));
      ['Heater→Sep', 'Sep→Flare'].forEach((nm) => assert.ok(dw.warnings.some((w) => w.t === 'error' && w.msg.indexOf(nm + ': Velocity ') === 0 && /EXCEEDS erosional limit/.test(w.msg)), nm + ' EXCEED'));
      const all = Object.keys(X.WARN_TEXTS).filter((k) => !/^segVel/.test(k)).map((k) => X.textRe(X.WARN_TEXTS[k]));
      assert.ok(!flowOf(mix(LINE(1400), { wts_Pwh: '500' })).flow.warnings.some((w) => all.some((re) => re.test(w.m))), 'the base warnings carry none of the new texts');
    },
  },
  {
    name: 'WTSFU C bypass destination display: V-101 out → destination Node-table row, the V-101-out choke line, block warnings, the surge-vs-separator warning hidden; V-101 in → the v3.3.1 page',
    wp: WP,
    opts: false,
    run(app, assert) {
      const C = GOLD.makeCalc(GOLD.hostRegion()), W = C.sandbox.window, $ = C.sandbox.$;
      const r = C.run(mix(BASE, { wts_Psep: '30', wts_Psurge: '25', wts_sepByDest: 'flare' }));   // v3.4.2: burner line pinned
      assert.ok(/Surge tank pressure too close to separator pressure/.test(r.page.warn), 'base surge warning (V-101 in)');
      W.wtsRenderResults(r.flow, mix(X.RIG_DEFAULTS, { separator: false }));
      const res = $('wts_res').innerHTML, warn = $('wts_warn').innerHTML;   // (v3.4.2: BASE has no destination input → 'surge')
      assert.ok(res.indexOf('>' + X.LABELS.nodeRowBurner + '</td>') >= 0 && res.indexOf(X.LABELS.nodeRowLine) < 0, 'burner-line row');
      assert.ok(/With V-101 out, to burner line<\/span><span class="rv">downstream \d+ psig &middot; Critical/.test(res), 'V-101-out choke line');
      assert.ok(!/Surge tank pressure too close to separator pressure/.test(warn), 'surge-vs-separator warning hidden while V-101 is out');
      const rl = C.run(mix(BASE, LINE(1440)));
      assert.ok(rl.page.res.indexOf('>' + X.LABELS.nodeRowLine + '</td>') >= 0 && /to production line/.test(rl.page.res), 'production-line row (calc keeps the last rig-up)');
      assert.ok(/Bypass path 1,44\d psig at the CK-101 outlet \(production line 1,440 psig plus line loss/.test(rl.page.warn) && /PSHH-104 trips SDV-101 at 1,296 psig/.test(rl.page.warn), 'rating and PSHH-104 warnings shown');
      W.wtsRenderResults(rl.flow, J(X.RIG_DEFAULTS));
      const g = GOLD.loadGolden().sets[0].page;
      // v3.4.2 (2026-11-09): with T-201 in the LP flare line box follows the v3.3.1 rows (only that)
      const noLp = (h) => { const i = h.indexOf('<div class="rbox" style="margin-top:10px"><div class="rbox-title">LP flare line'); return i < 0 ? h : h.slice(0, i); };
      assert.ok(noLp($('wts_res').innerHTML) === g.res && $('wts_warn').innerHTML === g.warn, 'V-101 back in: the v3.3.1 page (+ the LP box)');
      // V-101 out and CK-102 in: the CK-102 rbox reads flow.sepBy.ck2
      W.wtsRenderResults(rl.flow, mix(X.RIG_DEFAULTS, { separator: false, heaterChoke: true }));
      const res2 = $('wts_res').innerHTML;
      const pm = Math.round(rl.flow.sepBy.ck2.Pin).toLocaleString('en-US');
      assert.ok(res2.indexOf(X.LABELS.ck2Rbox) >= 0 && res2.indexOf('Upstream P (between the chokes)</span><span class="rv">' + pm + ' psig') >= 0, 'CK-102 rbox from flow.sepBy.ck2 (' + pm + ')');
    },
  },
  {
    name: 'WTSFU C page: Dynamic Simulation destination inputs (labels, options), the line pressure disabled and rp-skip while the burner line is chosen; a change re-runs the walk and is autosaved',
    wp: WP,
    integration: true,
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="wts"]'); if (!b) throw new Error('no Well Test Simulator sidebar button');
      app.click(b); app.flush(500);
      const item = (id) => app.el(id).closest('.fg-item'), lab = (id) => String(item(id).querySelector('label').textContent);
      assert.strictEqual(lab('wts_sepByDest'), X.LABELS.sepByDest);
      assert.strictEqual(lab('wts_sepByP'), X.LABELS.sepByP);
      assert.ok(app.el('wts_sepByDest').closest('.card').querySelector('.card-title').textContent === 'Dynamic Simulation', 'in the Dynamic Simulation card');
      const opts = Array.from(app.el('wts_sepByDest').querySelectorAll('option')).map((o) => [o.getAttribute('value'), String(o.textContent)]);
      // v3.4.2 (2026-11-09, DECISIONS 1): the surge tank T-201 first and selected, then the v3.3.3 options
      assert.deepStrictEqual(opts, [['surge', 'Surge tank T-201']].concat(Object.keys(X.LABELS.sepByDestOptions).map((k) => [k, X.LABELS.sepByDestOptions[k]])), 'destination options');
      assert.strictEqual(app.el('wts_sepByDest').value, 'surge', 'page default: the surge tank');
      assert.ok(!item('wts_sepByDest').classList.contains('rp-skip'), 'destination always shown');
      assert.ok(app.el('wts_sepByP').disabled && item('wts_sepByP').classList.contains('rp-skip'), 'line pressure disabled / rp-skip with the burner line');
      assert.ok(!app.el('wts_sepByP').getAttribute('data-wts-unit-cat'), 'line pressure untagged (card rule)');
      app.change('wts_sepByDest', 'line'); app.flush(400);
      assert.ok(!app.el('wts_sepByP').disabled && !item('wts_sepByP').classList.contains('rp-skip'), 'enabled with the production line');
      app.input('wts_sepByP', '300'); app.flush(500);
      const f = app.win.WTS_state.flow;
      assert.ok(f.sim.sepByDest === 'line' && f.sim.sepByP_psig === 300 && f.sepBy.dest === 'line' && f.sepBy.P0_psig === 300, 'published: ' + JSON.stringify(f.sim));
      const saved = JSON.stringify(JSON.parse(app.win.localStorage.getItem('wts_page_wts') || '{}'));
      assert.ok(saved.indexOf('wts_sepByDest') >= 0 && saved.indexOf('wts_sepByP') >= 0, 'autosaved');
      app.change('wts_sepByDest', 'flare'); app.flush(400);
      assert.ok(app.el('wts_sepByP').disabled && app.win.WTS_state.flow.sepBy.P0_psig === 5, 'back to the burner line');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    },
  },
];

// Well Test Simulator follow-up — bypass destination and cushion unload (docs/SIM-FOLLOWUP-PLAN.md §6, §9.2, §10).
// Groups: ENGINE (WP-E2, this file's first part) — the working engine (31) against the frozen contract tests/_wts-fu-shapes.js:
//   • pDown per destination: the legacy law on SAMPLE_FLOW, the multiphase seg-5 law with flow.sepBy (P0 from the block), the
//     cushion mixture-rate fraction; flare node / line totals / vent sink; mass balance per destination;
//   • protection: PSHH-104 trips SDV-101, SEPBY_RATING, a shut-in with 'line' held at line pressure (NRV-501 note);
//   • the cushion: units, column law and ANCHORS_CUSH, breakthrough located on the delivered volume (dt 1 = dt 10), the
//     volume-balanced tail (∫ = V), phases, WHP continuity, CUSH_LIMIT / NOLIFT / BURNER / DUMP, HTR_FULL, J-T and hydrates,
//     warm-up, derive-survival, Reset, determinism, gauge batches.
// HOST (WP-C, calcWTS flow.sepBy) is the group above; the lead merged the two (HOST.concat(ENGINE)).
// Flow blocks are built on the fixture examples (WP-C publishes the real ones); values are the engine's steady inputs.


const NOISE_OFF = { noise: { on: false } };
const anc = (id) => X.ANCHORS_CUSH.find((a) => a.id === id);
const alarm = (st, id) => st.alarms.find((a) => a.id === id) || null;
function balanced(assert, st, where, tol) {
  const m = st.health.massErr, e = tol || 1e-6;
  assert.ok(Math.abs(m.oil) < e && Math.abs(m.water) < e && Math.abs(m.gas) < e, where + ': mass balance ' + JSON.stringify(m));
}
// SAMPLE_FLOW with a flow.sepBy block (fixture example), destination dest at P0 (line) or the burner-line inlet (flare)
function sepByFlow(S, dest, P, edit) {
  const f = J(S.SAMPLE_FLOW);
  f.sepBy = X.EXAMPLES.flowSepBy;
  f.sim.sepByDest = dest;
  if (dest === 'line') { f.sepBy.dest = 'line'; f.sepBy.P0_psig = P; f.sim.sepByP_psig = P; }
  if (edit) edit(f);
  return f;
}
function mk(S, flow, o) {
  o = o || {};
  return S.create(flow || S.SAMPLE_FLOW, { seed: o.seed || 7, config: Object.assign({}, o.noise ? {} : NOISE_OFF, o.config || {}), rigup: o.rigup || {} });
}
function run(sim, sec, dt, each) { for (let t = 0; t < sec - 1e-9; t += dt) { sim.advance(dt); if (each) each(sim.getState()); } }
// a cold spread: steady temperatures from the flow nodes (the engine's steady inputs), choke outlet below its hydrate point
// (Tck: choke-outlet T, default 25 °F; a warm Tck = a wellhead stream with no hydrates before the start)
function coldFlow(S, heaterWarm, Tck) {
  const f = J(S.SAMPLE_FLOW), n = f.nodes, tc = Tck === undefined ? 25 : Tck;
  n[0].T = 80; n[1].T = 80; n[2].T = tc;
  f.heater.Tin = tc;
  if (heaterWarm) { n[3].T = 150; } else { f.inputs.bypass = true; f.heater.bypass = true; n[3].T = 25; n[4].T = 25; n[5].T = 25; n[6].T = 25; n[7].T = 25; }
  return f;
}

const ENGINE = [
  // ═════════════════════════ ENGINE (WP-E2) ═════════════════════════
  {
    name: 'WTSFU E2 bypass destination: pDown per destination (legacy, flow.sepBy, P0 from the block), flare node, line / flare / vent totals, mass balance',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      assert.strictEqual(S.DEFAULTS.sep.bypass.P_flare_psig, S.DEFAULTS.sep.pcv.P2_psig, 'legacy burner-line inlet = PCV outlet setting');
      // legacy (SAMPLE_FLOW, no block): bypF0 + the separator gas line loss · fg² (v1.4.0 law)
      const a = mk(S, S.SAMPLE_FLOW, { rigup: { separator: false } });
      run(a, 600, 10);
      let st = a.getState(), fu = a._internal().fu;
      assert.ok(fu.sel === 'base' && st.nodes.flare.Pline === st.nodes.flare.P && st.nodes.flare.P === S.DEFAULTS.sep.bypass.P_flare_psig, 'legacy flare node');
      assert.ok(st.cum.flare_mmscf > 0 && st.cum.toLine_gas_mscf === 0, 'legacy: well gas to the burner line');
      balanced(assert, st, 'legacy');
      // flow.sepBy, burner line: P0 from the block + its whole-stream seg-5 loss; at t = 0 (steady) fg = 1
      const ex = X.EXAMPLES.flowSepBy;
      const b = mk(S, sepByFlow(S, 'flare'), { rigup: { separator: false } });
      st = b.getState(); fu = b._internal().fu;
      assert.ok(fu.sel === 'sepBy' && fu.bypP0 === ex.P0_psig && fu.bypDP === ex.segs[2].dP, 'block P0 / seg-5 loss');
      assert.ok(Math.abs(st.nodes.flare.Pline - (ex.P0_psig + ex.segs[2].dP)) < 1e-6 && st.nodes.flare.P === ex.P0_psig, 'flare node Pline = pDown ' + st.nodes.flare.Pline);
      assert.ok(Math.abs(st.segs[4].Pout - st.nodes.flare.Pline) < 1e-9 && st.sepBy.note === '' && st.sepBy.P0_psig === ex.P0_psig, 'seg 5 outlet / note');
      run(b, 600, 10);
      st = b.getState();
      assert.ok(st.nodes.flare.flame > 0 && st.cum.flare_mmscf > 0 && st.cum.toLine_gas_mscf === 0, 'burner line: flame and flare totals');
      balanced(assert, st, 'burner line with the block');
      // a setConfig destination that differs from the block: the block wins, with the note
      b.setConfig({ sep: { bypass: { P_flare_psig: 9 } } });
      assert.ok(b._internal().fu.bypP0 === ex.P0_psig && /flow block wins/.test(b.getState().sepBy.note), 'mismatch note: ' + b.getState().sepBy.note);
      // production line 300 psig: choke outlet follows 300 + the line loss, flame 0, totals to the line, FS-401 may be out
      const c = mk(S, sepByFlow(S, 'line', 300), { rigup: { separator: false } });
      st = c.getState();
      // review round: FS-401 idles at its burner-header value while the stream goes to the line (the line P is snap.sepBy.P0_psig);
      // seg 5 (V-101 position → the line) keeps the pDown value
      assert.ok(Math.abs(st.segs[4].Pout - (300 + ex.segs[2].dP)) < 1e-6, 'line: pDown = 300 + loss');
      assert.ok(st.nodes.flare.Pline <= 10 && st.nodes.flare.P <= 10 && st.sepBy.P0_psig === 300, 'line: FS-401 idle, not at the line pressure ' + st.nodes.flare.Pline);
      assert.ok(Math.abs(st.nodes.choke.P - (300 + ex.segs[2].dP + ex.nodes.choke.P - ex.nodes.sep.P)) < 0.05, 'choke outlet from the line pressure ' + st.nodes.choke.P);
      run(c, 900, 10);
      st = c.getState();
      // the well stream goes to the line; FS-401 (in) takes only the tanks' relief / vent gas
      assert.ok(st.nodes.flare.flame === 0 && st.cum.flare_mmscf < 1e-4 * st.cum.gasIn_mmscf, 'line: no flame, no well gas in the flare totals ' + st.cum.flare_mmscf);
      assert.ok(st.cum.toLine_gas_mscf > 0 && st.cum.toLine_oil_stb > 0 && st.cum.toLine_water_bbl > 0 && st.sepBy.active && !st.sepBy.vent, 'line totals');
      assert.ok(st.lines.sep_flare.q > 0, 'seg 5 carries the stream to the line');
      balanced(assert, st, 'production line');
      // V-101 + FS-401 out (line only): the tanks' relief / vent gas goes to vent, never to the flare
      // v3.3.1 T-201 line-up pinned: the transfer is still running after 30 min (with the v1.6.0 default suction B sits at LSL)
      const d = mk(S, sepByFlow(S, 'line', 300), { rigup: {}, config: legacyCfg() });
      run(d, 1800, 10);                                 // T-201 holds liquid that flashes
      d.setRigup({ separator: false, flare: false });
      st = d.getState();
      assert.ok(st.rigup.flare === false && st.sepBy.vent === true, 'FS-401 out with the line');
      const fl0 = st.cum.flare_mmscf;
      let ventSeen = 0;
      run(d, 1800, 10, (s) => { if (s.nodes.flare.qMMscfd > 1e-9) ventSeen++; });
      st = d.getState();
      assert.ok(st.cum.flare_mmscf === fl0 && ventSeen === 0, 'vent: flare total frozen, flare node 0');
      assert.ok(st.cum.toVent_gas_mscf > 0, 'vent sink ' + st.cum.toVent_gas_mscf);
      const hq = d.getHistory('qgFlare').y;
      assert.ok(hq[hq.length - 1] === 0, 'history qgFlare without the vented gas');
      balanced(assert, st, 'vent sink');
      // line → burner line (setFlow, the page path): FS-401 forced back in, the flare takes the relief again
      d.setFlow(sepByFlow(S, 'flare'));
      st = d.getState();
      assert.ok(st.rigup.flare === true && st.sepBy.vent === false && st.sepBy.dest === 'flare', 'line → flare re-forces FS-401');
      run(d, 600, 10);
      balanced(assert, d.getState(), 'back to the burner line');
    },
  },
  {
    name: 'WTSFU E2 tie-in protection: PSHH-104 trips SDV-101 at 1,400 psig, SEPBY_RATING above the design pressure, a line shut-in held by NRV-501',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const ex = X.EXAMPLES.flowSepBy;
      const a = mk(S, sepByFlow(S, 'line', 1400), { rigup: { separator: false } }), trips = [];
      a.on('trip', (p) => trips.push(p));
      run(a, 30, 1);
      let st = a.getState();
      const A = alarm(st, 'PSHH_SEPBY');
      assert.ok(A && A.sev === 'trip' && A.tag === 'PSHH-104' && A.eq === 'separator' && X.textRe(X.ALARM_TEXTS.PSHH_SEPBY).test(A.msg), 'PSHH_SEPBY: ' + (A && A.msg));
      assert.ok(st.esd.tripped && trips.some((p) => p.cause === 'PSHH_SEPBY'), 'SDV-101 tripped by PSHH-104');
      run(a, 600, 10);
      st = a.getState();
      assert.ok(Math.abs(st.nodes.esd.P - 1400) < 1 && alarm(st, 'PSHH_SEPBY') && /held at line pressure by NRV-501/.test(st.sepBy.note), 'shut in at line pressure ' + st.nodes.esd.P + ' / ' + st.sepBy.note);
      // below 90 % of the rating: no trip; SEPBY_RATING only when P0 + the line loss exceeds the design pressure
      const b = mk(S, sepByFlow(S, 'line', 1000), { rigup: { separator: false } });
      run(b, 120, 10);
      st = b.getState();
      assert.ok(!st.esd.tripped && !alarm(st, 'PSHH_SEPBY') && !alarm(st, 'SEPBY_RATING'), '1,000 psig: no protection alarm');
      const P = 1440 - ex.segs[2].dP / 2;
      const c = mk(S, sepByFlow(S, 'line', P), { rigup: { separator: false } });
      c.advance(1);
      const R = alarm(c.getState(), 'SEPBY_RATING');
      assert.ok(R && R.sev === 'warn' && R.tag === 'V-101' && X.textRe(X.ALARM_TEXTS.SEPBY_RATING).test(R.msg), 'SEPBY_RATING: ' + (R && R.msg));
      // the burner line never raises SEPBY_RATING; V-101 in evaluates neither
      const d = mk(S, sepByFlow(S, 'flare'), { rigup: { separator: false } }), e = mk(S, sepByFlow(S, 'line', 1400));
      run(d, 60, 10); run(e, 60, 10);
      assert.ok(!alarm(d.getState(), 'SEPBY_RATING') && !alarm(e.getState(), 'PSHH_SEPBY') && !e.getState().esd.tripped, 'flare / V-101 in');
      // a manual shut-in with the line: held at line pressure
      const f = mk(S, sepByFlow(S, 'line', 300), { rigup: { separator: false } });
      run(f, 120, 10); f.tripESD('test'); run(f, 900, 10);
      st = f.getState();
      assert.ok(Math.abs(st.nodes.esd.P - 300) < 1 && st.sepBy.note === X.RIG_NOTES.shutInLine, 'manual shut-in ' + st.nodes.esd.P);
    },
  },
  {
    name: 'WTSFU E2 cushion: units, ANCHORS_CUSH start values, breakthrough on the delivered volume (dt 1 = dt 10), volume-balanced tail ∫ = V, phases, WHP',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      // units: gasFrac 0, V 500 (no breakthrough in 1 h), 1,500 bbl/d → 62.5 bbl less the τf lag's in-flight volume
      const u = mk(S);
      u.advance(600);
      const w0 = u.getState().cum.waterIn_bbl;
      // (V 500 bbl fills 10,000 ft of tubing, a column the well cannot lift: depth 5,000 ft keeps it unloading; the anchor does
      // not depend on the column)
      assert.ok(u.startCushion({ V: 500, gasFrac: 0, depth: 5000 }).ok);
      run(u, 3600, 10);
      let st = u.getState();
      assert.ok(X.near(anc('waterIn1h'), st.cushion.recovered_bbl), 'cushion water after 1 h ' + st.cushion.recovered_bbl);
      assert.ok(Math.abs(st.cum.waterIn_bbl - w0 - 62.5) / 62.5 < 0.01, 'cum.waterIn after 1 h ' + (st.cum.waterIn_bbl - w0));
      assert.ok(st.cushion.phase === 'unloading' && st.cushion.tBreak === null, 'still unloading');
      const hl = u.getHistory('cushionLeft').y;
      assert.ok(Math.abs(hl[hl.length - 1] - (500 - st.cushion.recovered_bbl)) < 0.05, 'history cushionLeft ' + hl[hl.length - 1]);
      balanced(assert, st, 'cushion units');
      // the defaults on SAMPLE_FLOW (V-101 in, SIT = 1.2 × 3,000, noise off)
      const res = [1, 10].map((dt) => {
        const sim = mk(S), ev = [];
        sim.advance(600);
        sim.on('cushion', (p) => ev.push(p));
        const r = sim.startCushion({}), t0 = sim.getState().t, c0 = sim.getCushion();
        let tgtPrev = -Infinity, mono = true, maxBreakStep = 0, prevP = sim.getState().nodes.wellhead.P, tB = null, recAt10 = null;
        for (let t = 0; t < 30000; t += dt) {
          sim.advance(dt);
          const s = sim.getState(), c = s.cushion;
          if (c.phase === 'unloading') { if (c.WHPtgt_psig < tgtPrev - 1e-9) mono = false; tgtPrev = c.WHPtgt_psig; }
          if (c.tBreak !== null && tB === null) tB = c.tBreak - t0;
          if (tB !== null && s.t - t0 > tB - 30 && s.t - t0 < tB + 60) maxBreakStep = Math.max(maxBreakStep, Math.abs(s.nodes.wellhead.P - prevP));
          if (tB !== null && recAt10 === null && s.t - t0 >= tB + 10 * 1800) recAt10 = c.recovered_bbl;
          prevP = s.nodes.wellhead.P;
        }
        return { sim, ev, r, c0, mono, maxBreakStep, tB, recAt10, st: sim.getState(), t0 };
      });
      const d1 = res[0], d10 = res[1];
      assert.ok(d1.r.ok && X.textRe(X.ALARM_TEXTS.CUSH_DUMP_start).test(d1.r.warn), 'V-101 in at the defaults: dump warning ' + d1.r.warn);
      const ref = X.cushionStartRef({ Pwh: 3000, Twh: 180 });
      assert.ok(X.near(anc('fUnload0'), d1.c0.fUnload) && X.near(anc('column0'), d1.c0.column_ft) && X.near(anc('WHPstart'), d1.c0.WHPtgt_psig) && X.near(anc('wJTc'), d1.c0.wJT),
        'start: ' + JSON.stringify([d1.c0.fUnload, d1.c0.column_ft, d1.c0.WHPtgt_psig, d1.c0.wJT]));
      assert.ok(Math.abs(d1.c0.WHPtgt_psig - ref.WHPtgt) / ref.WHPtgt < 0.005, 'start WHP = the closed form ' + ref.WHPtgt);
      const ck = X.checkShape('cushion', J(d1.c0), { strict: true, engine: 'work' }); assert.ok(ck.ok, 'snap.cushion shape: ' + ck.errors.join('; '));
      d1.ev.forEach((p) => { const r = X.checkShape('cushionEvent', J(p), { strict: true }); assert.ok(r.ok, 'event shape: ' + r.errors.join('; ')); });
      assert.deepStrictEqual(d1.ev.map((p) => p.phase), ['unloading', 'breakthrough', 'tail', 'done'], 'phase sequence');
      assert.deepStrictEqual(d10.ev.map((p) => p.phase), ['unloading', 'breakthrough', 'tail', 'done'], 'phase sequence (dt 10)');
      assert.ok(X.near(anc('tBreak'), d1.tB) && Math.abs(d1.tB - d10.tB) < 0.3, 'tBreak dt 1 ' + d1.tB + ' / dt 10 ' + d10.tB);
      assert.ok(/42\.5 bbl recovered/.test(d1.ev[1].msg), 'breakthrough at Vmain delivered: ' + d1.ev[1].msg);
      const tDone = (r) => r.ev[3].t - r.t0;
      assert.ok(X.near(anc('tDone'), tDone(d1)) && Math.abs(tDone(d1) - tDone(d10)) < 1, 'done ' + tDone(d1) + ' / ' + tDone(d10));
      assert.ok(X.near(anc('recovered'), d1.recAt10) && X.near(anc('recovered'), d10.recAt10), '∫ cushion water at tBreak + 10 τt: ' + d1.recAt10 + ' / ' + d10.recAt10);
      const s1 = d1.st;
      assert.ok(s1.cushion.out.sep === s1.cushion.recovered_bbl && s1.cushion.out.flare === 0 && s1.cushion.out.line === 0, 'all to V-101');
      assert.ok(d1.mono, 'WHP target monotonic while unloading');
      assert.ok(d1.maxBreakStep < 50, 'no WHP step at breakthrough (' + d1.maxBreakStep.toFixed(2) + ' psi per 1 s step)');
      assert.ok(d10.maxBreakStep < 50, 'no WHP step at breakthrough (' + d10.maxBreakStep.toFixed(2) + ' psi per 10 s step)');
      assert.ok(s1.cushion.on === false && s1.cushion.phase === 'done' && s1.alarms.every((a) => X.Q_CUSH.indexOf(a.id) < 0), 'scenario ended, its alarms quiet');
      assert.ok(Math.abs(s1.nodes.wellhead.P - 3000) < 400 && s1.f > 0.95, 'back on the formation flow');
      balanced(assert, s1, 'cushion through V-101');
      const cl = d1.sim.getHistory('cushionLeft').y;
      assert.ok(cl.every((y) => y >= 0 && y <= 50) && cl[cl.length - 1] < 0.05, 'history cushionLeft');
      // column law at the end of the main slug (hc = 0)
      assert.ok(X.near(anc('WHPendMain'), d1.sim._internal().fu.cushS.WHPcol), 'WHPcol at the end of the main slug ' + d1.sim._internal().fu.cushS.WHPcol);
    },
  },
  {
    name: 'WTSFU E2 cushion short tail: ∫qDel dt = V when V·tailFrac is below the in-flight volume τf·qDel (V 1, tailFrac 0, V 5 at 6,000 bbl/d), cushionLeft ≥ 0',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const f64 = J(S.SAMPLE_FLOW); f64.inputs.bean = 64;
      [['V 1 at 1,500 bbl/d', { V: 1 }, null, {}], ['tailFrac 0', { tailFrac: 0 }, null, {}],
        ['V 5 at 6,000 bbl/d (64/64, V-101 out)', { V: 5, q: 6000 }, f64, { separator: false }]].forEach(([lab, p, f, rig]) => {
        const sim = mk(S, f, { rigup: rig }), ev = [];
        sim.advance(600);
        sim.on('cushion', (e) => ev.push(e));
        assert.ok(sim.startCushion(p).ok, lab + ': started');
        const V = sim.getCushion().V_bbl;
        let minLeft = Infinity, maxRec = 0;
        run(sim, 30000, 10, (s) => {
          const c = sim._internal().fu.cushS;
          minLeft = Math.min(minLeft, c.V - c.Vprod); maxRec = Math.max(maxRec, s.cushion.recovered_bbl);
        });
        const st = sim.getState(), hl = sim.getHistory('cushionLeft').y;
        assert.ok(maxRec <= V * (1 + 1e-3) && st.cushion.recovered_bbl >= V * (1 - 1e-3), lab + ': recovered ' + st.cushion.recovered_bbl + ' (max ' + maxRec + ') of ' + V);
        assert.ok(minLeft >= 0 && hl.every((y) => y >= 0), lab + ': cushionLeft ≥ 0 throughout (min ' + minLeft + ')');
        const ph = ev.map((e) => e.phase);
        assert.ok(ph[0] === 'unloading' && ph.indexOf('breakthrough') > 0 && ph[ph.length - 1] === 'done' && st.cushion.phase === 'done', lab + ': phases ' + ph.join());
        const done = ev[ev.length - 1].msg, m = /recovered: ([0-9.]+) of/.exec(done);
        assert.ok(m && Math.abs(+m[1] - V) <= 0.05, lab + ': done text ' + done);
        balanced(assert, st, lab, 1e-6);
      });
    },
  },
  {
    name: 'WTSFU E2 cushion limits: CUSH_LIMIT on 12/64, the series bean (ck2Info), CUSH_NOLIFT stall (rates 0), CUSH_BURNER texts, CUSH_DUMP with Cv_w fixed, refusals',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      // 12/64: the liquid orifice law limits 1,500 bbl/d once the choke ΔP falls with WHP (≈ 1,190 bbl/d at 1,550 psi)
      const f12 = J(S.SAMPLE_FLOW); f12.inputs.bean = 12;
      const a = mk(S, f12);
      a.startCushion({});
      let lim = null;
      run(a, 1200, 10, (s) => { const A = alarm(s, 'CUSH_LIMIT'); if (A && !lim) lim = { A, c: J(s.cushion) }; });
      assert.ok(lim && lim.A.tag === 'CK-101' && lim.A.sev === 'warn' && lim.c.qcap_bpd < 0.99 * 1500 && lim.c.q_bpd === lim.c.qcap_bpd, 'CUSH_LIMIT ' + JSON.stringify(lim && lim.c));
      assert.ok(X.near(anc('qLcap12'), X.qLcapRef(12, 1550, 1.03)) && X.near(anc('qLcap32'), X.qLcapRef(32, 1550, 1.03)), 'qLcap closed forms');
      // CK-102 in line (ck2Info().act — the WP-E1 engine; forced here on a copy of the source): the whole drop across both chokes
      // with the series equivalent bean. CK-102 128/64 → within 1 % of CK-101 alone
      const fs = require('fs'), path = require('path');
      const src = require(path.join(__dirname, '..', 'concat-round7.js')).stripSelfTest(fs.readFileSync(path.join(__dirname, '..', '31-wts-sim.js'), 'utf8'), '31-wts-sim.js', { log() {}, warn() {} });
      const hook = 'function ck2Info() { CK2I.act = CK2.act; CK2I.b1 = bean; CK2I.b2 = CK2.bean;';
      assert.ok(src.indexOf(hook) >= 0, 'ck2Info accessor present');
      const S2 = X.loadEngine(src.replace(hook, 'function ck2Info() { CK2I.act = true; CK2I.b1 = bean; CK2I.b2 = 128;'));
      const q1 = mk(S), q2 = mk(S2);
      q1.startCushion({}); q2.startCushion({});
      run(q1, 300, 10); run(q2, 300, 10);
      const c1 = q1.getCushion().qcap_bpd, c2 = q2.getCushion().qcap_bpd;
      assert.ok(Math.abs(c2 / c1 - 1) < 0.01 && c2 < c1, 'qLcap with CK-102 128/64 ' + c2 + ' vs CK-101 alone ' + c1);
      assert.ok(X.near(anc('dEq32_128'), X.dEqRef(32, 128)), 'equivalent bean');
      // no lift: 150 bbl in 2-7/8″ to 25,000 ft — stalled at once, every well rate 0 (well dead), CUSH_NOLIFT
      const n = mk(S), nev = [];
      n.on('cushion', (p) => nev.push(p.phase));
      const nr = n.startCushion({ V: 150, cap: 0.00579, depth: 25000 });
      assert.ok(nr.ok && n.getCushion().phase === 'stalled' && X.near(anc('nolift'), n._internal().fu.cushS.WHPcol), 'stalled at the start ' + n._internal().fu.cushS.WHPcol);
      run(n, 600, 10);
      let st = n.getState();
      const NL = alarm(st, 'CUSH_NOLIFT');
      assert.ok(NL && NL.sev === 'alarm' && NL.tag === 'WH-101', 'CUSH_NOLIFT');
      assert.ok(st.cushion.q_bpd === 0 && st.f < 1e-3 && st.rates && st.cushion.recovered_bbl < 0.5 && nev.join() === 'unloading,stalled', 'rates 0 while stalled ' + st.f + ' ' + st.cushion.recovered_bbl);
      assert.ok(isFinite(st.nodes.wellhead.P) && st.nodes.wellhead.P >= st.nodes.separator.P - 1 && st.nodes.wellhead.P < 400, 'static WHP of a dead well = back pressure ' + st.nodes.wellhead.P);
      // burner caution: any cushion liquid to the burner / flare line with V-101 out (water and hydrocarbon texts)
      [[1.03, 'CUSH_BURNER_water'], [0.85, 'CUSH_BURNER_oil']].forEach(([SG, key]) => {
        const b = mk(S, S.SAMPLE_FLOW, { rigup: { separator: false } });
        b.startCushion({ SG: SG });
        run(b, 120, 10);
        const B = alarm(b.getState(), 'CUSH_BURNER');
        assert.ok(B && B.tag === 'FS-401' && B.msg === X.ALARM_TEXTS[key] && b.getCushion().out.flare > 0, 'CUSH_BURNER SG ' + SG + ': ' + (B && B.msg));
        balanced(assert, b.getState(), 'cushion to the burner (legacy path, SG ' + SG + ')');
      });
      const bl = mk(S, sepByFlow(S, 'line', 300), { rigup: { separator: false } });
      bl.startCushion({});
      run(bl, 300, 10);
      st = bl.getState();
      assert.ok(!alarm(st, 'CUSH_BURNER') && st.cushion.out.line > 0 && st.cushion.out.flare === 0 && st.cum.toLine_water_bbl > 0, 'to the line: no burner caution');
      balanced(assert, st, 'cushion to the line');
      // with a block, pDown follows the mixture-rate fraction while the cushion flows (the liquid line loss, §6.2)
      const fu = bl._internal().fu, ex = X.EXAMPLES.flowSepBy;
      assert.ok(fu.cushFm > 0.05 && Math.abs(st.segs[4].Pout - (300 + ex.segs[2].dP * fu.cushFm * fu.cushFm)) < 1e-6 && st.nodes.flare.Pline <= 10, 'pDown with cushFm ' + fu.cushFm);
      // V-101 in at the defaults: the start warning, CUSH_DUMP, the water level rises (LAH acts); Cv_w as sized throughout
      const v = mk(S), cv0 = v._internal().Cv.w;
      run(v, 300, 10);
      const vr = v.startCushion({});
      assert.ok(vr.ok && vr.warn !== '', 'dump warning');
      let dump = null, cvMid = null, lah = null;
      run(v, 1500, 10, (s) => {
        if (!dump && alarm(s, 'CUSH_DUMP')) dump = alarm(s, 'CUSH_DUMP');
        if (!lah && alarm(s, 'CUSH_DUMP') && alarm(s, 'ISHH_SEP')) lah = alarm(s, 'ISHH_SEP');
      });
      cvMid = v._internal().Cv.w;
      st = v.getState();
      assert.ok(dump && dump.tag === 'LCV-101' && dump.sev === 'warn', 'CUSH_DUMP');
      // the water side floods: its level alarm is LAHH-101 (ISHH_SEP, interface level; the water compartment has no separate LAH —
      // LAH-102 / LSH_SEP is the oil bucket, which the carry-over water does not reach while LCV-102 keeps up), raised while
      // CUSH_DUMP is active; carry-over at the weir follows
      assert.ok(lah && lah.tag === 'LAHH-101' && lah.sev === 'alarm', 'LAHH-101 (ISHH_SEP) raised while CUSH_DUMP is active: ' + (lah && lah.tag));
      assert.ok(st.alarms.some((A) => A.id === 'CARRYOVER'), 'carry-over at the weir: ' + st.alarms.map((A) => A.id).join());
      v.stopCushion(); run(v, 60, 10);
      assert.ok(cv0 === cvMid && v._internal().Cv.w === cv0, 'Cv_w unchanged before / during / after');
      // refusals: while running, while the ESD is tripped
      const r = mk(S);
      assert.ok(r.startCushion({}).ok && r.startCushion({}).ok === false, 'refused while running');
      r.stopCushion(); r.tripESD('test');
      assert.ok(r.startCushion({}).ok === false && r.getCushion().phase === 'off', 'refused while tripped');
      // inputs clamped by DEFAULTS.cushion.lim
      const l = mk(S);
      l.startCushion({ V: 1e6, SG: 9, q: 1, cap: 1, depth: 1 });
      const lc = l._internal().fu.cushS, L = S.DEFAULTS.cushion.lim;
      assert.ok(lc.V === L.V[1] && lc.SG === L.SG[1] && lc.qSet === L.q[0] && lc.cap === L.cap[1] && lc.depth === L.depth[0], 'clamped ' + JSON.stringify([lc.V, lc.SG, lc.qSet, lc.cap, lc.depth]));
    },
  },
  {
    name: 'WTSFU E2 cushion heat and temperatures: J-T weight, hydrates (none while unloading, back at breakthrough with a cold heater), warm-up, additive duty and HTR_FULL',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const HYD = (s) => s.alarms.filter((A) => /^HYD_/.test(A.id)).map((A) => A.id);
      [false, true].forEach((warm) => {
        const sim = mk(S, coldFlow(S, warm));
        sim.advance(300);
        assert.ok(HYD(sim.getState()).indexOf('HYD_choke') >= 0, 'cold spread: hydrates before the cushion');
        sim.startCushion({});
        const t0 = sim.getState().t;
        let lateUnload = [], afterBreak = new Set();
        run(sim, 6000, 10, (s) => {
          const dt = s.t - t0;
          // grace 120 s: the kT lag on warmTau and the alarm off-delay of the hydrate alarms present at the start
          if (s.cushion.phase === 'unloading' && dt > 120) lateUnload = lateUnload.concat(HYD(s));
          if (s.cushion.tBreak !== null) HYD(s).forEach((id) => afterBreak.add(id));
        });
        assert.strictEqual(lateUnload.length, 0, (warm ? 'warm' : 'cold') + ' heater: no hydrate alarm while unloading ' + lateUnload.join());
        assert.ok(afterBreak.has('HYD_choke'), 'the existing hydrate alarms return at breakthrough: ' + [...afterBreak].join());
        if (warm) assert.ok(!afterBreak.has('HYD_heater') && !afterBreak.has('HYD_separator'), 'warm heater: nothing downstream of H-101');
        else assert.ok(afterBreak.has('HYD_heater'), 'cold heater: H-101 outlet hydrates at breakthrough');
      });
      // a warm wellhead stream (no hydrates before the start): no HYD_* at any point while unloading
      const ww = mk(S, coldFlow(S, true, 150));
      ww.advance(300);
      assert.strictEqual(HYD(ww.getState()).length, 0, 'warm wellhead: no hydrates before the cushion ' + HYD(ww.getState()).join());
      ww.startCushion({});
      let wwUnload = [], wwN = 0;
      run(ww, 6000, 10, (s) => { if (s.cushion.phase === 'unloading') { wwN++; wwUnload = wwUnload.concat(HYD(s)); } });
      assert.ok(wwN > 100 && wwUnload.length === 0, 'warm wellhead + warm heater: no hydrate alarm at any point while unloading (' + wwN + ' samples) ' + wwUnload.join());
      // J-T weight: the unload stream cools ~ wJTc / wJT less across CK-101 than the gas
      const j = mk(S);
      const dT0 = j.getState().nodes.choke.dTjt;
      j.startCushion({}); run(j, 600, 10);
      const sj = j.getState();
      assert.ok(sj.nodes.choke.dTjt < 0.1 * dT0 && sj.nodes.choke.dTjt > 0, 'choke J-T while unloading ' + sj.nodes.choke.dTjt + ' vs ' + dT0);
      // warm-up runs during the unload (gas fraction 0.05 alone would cool the spread)
      const w = mk(S);
      w.reset('empty');
      w.startCushion({});
      const Tw0 = w.getState().nodes.wellhead.T;
      run(w, 1800, 10);
      const sw = w.getState();
      assert.ok(Tw0 < 81 && sw.nodes.wellhead.T > 0.5 * (180 - 80) + 80 && sw.cushion.phase === 'unloading', 'warm-up during the unload: wellhead T ' + Tw0 + ' → ' + sw.nodes.wellhead.T);
      // duty additive (heater not capped at 500 bbl/d) and HTR_FULL at 3,000 bbl/d from a 60 °F wellhead
      const f60 = J(S.SAMPLE_FLOW), n = f60.nodes;
      f60.inputs.Twh = 60; n[0].T = 60; n[1].T = 60; n[2].T = 40; f60.heater.Tin = 40;
      const dA = mk(S, f60);
      dA.startCushion({ q: 500 }); run(dA, 900, 10);
      const sA = dA.getState();
      assert.ok(sA.nodes.heater.dutyMMBtuHr > 2.1030781 * sA.f + 0.5 && !alarm(sA, 'HTR_FULL') && Math.abs(sA.nodes.heater.T - 150) < 1, 'additive duty ' + sA.nodes.heater.dutyMMBtuHr + ' at f ' + sA.f);
      // a warm unload stream (inlet above the set point) needs no liquid duty: the outlet is the inlet
      const dW = mk(S);
      dW.startCushion({ q: 500 }); run(dW, 900, 10);
      const sW = dW.getState();
      assert.ok(sW.nodes.heater.Tin > 150 && sW.nodes.heater.T === sW.nodes.heater.Tin && Math.abs(sW.nodes.heater.dutyMMBtuHr - 2.1030781 * sW.f) < 1e-9, 'warm stream ' + sW.nodes.heater.Tin);
      const h = mk(S, f60);
      h.startCushion({ q: 3000 }); run(h, 900, 10);
      const sh = h.getState(), HF = alarm(sh, 'HTR_FULL');
      assert.ok(HF && HF.tag === 'H-101' && X.textRe(X.ALARM_TEXTS.HTR_FULL).test(HF.msg), 'HTR_FULL: ' + (HF && HF.msg));
      assert.ok(sh.nodes.heater.T < 150 - 10 && sh.cushion.dutyCapped === true && Math.abs(sh.nodes.heater.dutyMMBtuHr - 1.25 * 2.1030781) < 1e-6, 'capped: outlet ' + sh.nodes.heater.T + ', duty ' + sh.nodes.heater.dutyMMBtuHr);
      assert.ok(sh.nodes.separator.T < 150 - 10, 'the capped outlet reaches V-101 ' + sh.nodes.separator.T);
      balanced(assert, sh, 'HTR_FULL');
    },
  },
  {
    name: 'WTSFU E2 cushion state: derive-survival (Thtr, bean2), Reset clears, stop, determinism (noise on), gauge batches tagged, history',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      // derive-survival: setFlow with a new Thtr and a flow.ck2 bean during the unload keeps the cushion state and Cv_w
      const a = mk(S), b = mk(S);
      a.startCushion({}); b.startCushion({});
      run(a, 900, 10); run(b, 900, 10);
      const before = J(a.getCushion()), cv = a._internal().Cv.w;
      const f1 = J(S.SAMPLE_FLOW); f1.inputs.Thtr = 120; f1.ck2 = X.EXAMPLES.flowCk2; f1.ck2.bean = 40;
      a.setFlow(f1);
      const after = J(a.getCushion());
      assert.ok(after.recovered_bbl === before.recovered_bbl && after.phase === before.phase && after.V_bbl === 50 && after.on, 'setFlow keeps the cushion');
      assert.ok(a._internal().Cv.w === cv, 'Cv_w kept');
      run(a, 3000, 10); run(b, 3000, 10);
      const ca = a.getCushion(), cb = b.getCushion();
      assert.ok(ca.tBreak !== null && Math.abs(ca.tBreak - cb.tBreak) < 1 && Math.abs(ca.recovered_bbl - cb.recovered_bbl) < 0.01, 'the unload goes on: tBreak ' + ca.tBreak + ' / ' + cb.tBreak);
      // Reset clears; stop clears and logs
      a.reset();
      assert.deepStrictEqual(J(a.getCushion()), X.EXAMPLES.cushionOff, 'reset → off');
      assert.ok(a.getHistory('cushionLeft').y.every((y) => y === 0), 'history cleared');
      b.stopCushion();
      assert.ok(b.getCushion().phase === 'off' && b.getState().alarmLog.some((e) => e.id === 'CUSHION' && /stopped/.test(e.msg)), 'stop logged');
      assert.ok(b.getState().alarmLog.filter((e) => e.id === 'CUSHION').length >= 3, 'CUSHION log entries');
      // determinism: same seed with noise → same state
      const d = [0, 1].map(() => { const s = mk(S, S.SAMPLE_FLOW, { seed: 99, noise: true }); s.advance(300); s.startCushion({}); run(s, 3000, 10); return J(s.getState()); });
      d.forEach((s) => { s.flowTs = 0; });
      assert.deepStrictEqual(d[0], d[1], 'deterministic');
      // gauge-tank batches recorded while the cushion flows are tagged cushion:true
      const g = mk(S);
      g.startCushion({ V: 500, depth: 5000 });
      run(g, 4 * 3600, 30);
      const bt = g.getState().gauge.batches;
      assert.ok(bt.length > 0 && bt.every((x) => x.cushion === true), 'batches tagged ' + bt.length);
      // a batch still open when the unload is stopped is tagged against the stopped window; a batch opened after it is not
      const gs = mk(S);
      gs.startCushion({ V: 500, depth: 5000 });
      let nb = 0, tStop;
      run(gs, 4 * 3600, 30, (s) => { if (nb === 0 && s.gauge.batches.length > 0) { nb = s.gauge.batches.length; tStop = s.t + 1800; } else if (nb > 0 && tStop !== null && s.t >= tStop && gs.getCushion().on) { gs.stopCushion(); } });
      run(gs, 6 * 3600, 30);
      const bs = gs.getState().gauge.batches;
      const across = bs.filter((x) => x.tOpen < tStop && x.tClose > tStop), later = bs.filter((x) => x.tOpen > tStop + 1);
      assert.ok(nb > 0 && tStop !== undefined && across.length > 0 && across.every((x) => x.cushion === true), 'batch across the stop tagged ' + J(across.map((x) => [x.tOpen, x.tClose, x.cushion])));
      assert.ok(later.length > 0 && later.every((x) => !('cushion' in x)), 'batches after the stop not tagged ' + later.length);
      gs.reset();
      assert.ok(gs._internal().fu.cushS.phase === 'off', 'reset clears the stopped window too');
      const g2 = mk(S); run(g2, 4 * 3600, 30);
      assert.ok(g2.getState().gauge.batches.every((x) => !('cushion' in x)), 'no tag without a cushion');
      // the default spread: the cushion closure never moves (cushOn false), cushionLeft 0
      const z = mk(S); run(z, 600, 10);
      const zi = z._internal().fu;
      assert.ok(zi.cushOn === false && zi.cushHas === false && zi.cushFm === 0 && zi.cushS.phase === 'off', 'default spread: no cushion state');
    },
  },
];

module.exports = HOST.concat(ENGINE);
