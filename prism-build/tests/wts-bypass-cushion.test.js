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

module.exports = [
  // ─── host group (WP-C) ─────────────────────────────────────────────────────
  {
    name: 'WTSFU C bypass destination: flow.sepBy walks from the destination (burner line 5 psig, production line P) through the whole-stream seg 5; independent of the separator pressure; strict shape; base fields untouched',
    wp: WP,
    opts: false,
    run(app, assert) {
      const fl = flowOf({}).flow, sb = fl.sepBy;
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
      assert.ok(warnHas(rt, X.WARN_TEXTS.sepByRating) && rt.warnings.some((w) => /^Production line 1,440 psig plus line loss \d+ psi/.test(w.msg)), 'rating: ' + JSON.stringify(rt.warnings));
      assert.ok(!warnHas(flowOf(LINE(300)).flow.sepBy, X.WARN_TEXTS.sepByRating) && flowOf({}).flow.sepBy.warnings.length === 0, 'no warnings at the defaults / line 300');
      const all = Object.keys(X.WARN_TEXTS).map((k) => X.textRe(X.WARN_TEXTS[k]));
      assert.ok(!flowOf(mix(LINE(1400), { wts_Pwh: '500' })).flow.warnings.some((w) => all.some((re) => re.test(w.m))), 'the base warnings carry none of the new texts');
    },
  },
  {
    name: 'WTSFU C bypass destination display: V-101 out → destination Node-table row, the V-101-out choke line, block warnings, the surge-vs-separator warning hidden; V-101 in → the v3.3.1 page',
    wp: WP,
    opts: false,
    run(app, assert) {
      const C = GOLD.makeCalc(GOLD.hostRegion()), W = C.sandbox.window, $ = C.sandbox.$;
      const r = C.run(mix(BASE, { wts_Psep: '30', wts_Psurge: '25' }));
      assert.ok(/Surge tank pressure too close to separator pressure/.test(r.page.warn), 'base surge warning (V-101 in)');
      W.wtsRenderResults(r.flow, mix(X.RIG_DEFAULTS, { separator: false }));
      const res = $('wts_res').innerHTML, warn = $('wts_warn').innerHTML;
      assert.ok(res.indexOf('>' + X.LABELS.nodeRowBurner + '</td>') >= 0 && res.indexOf(X.LABELS.nodeRowLine) < 0, 'burner-line row');
      assert.ok(/With V-101 out, to burner line<\/span><span class="rv">downstream \d+ psig &middot; Critical/.test(res), 'V-101-out choke line');
      assert.ok(!/Surge tank pressure too close to separator pressure/.test(warn), 'surge-vs-separator warning hidden while V-101 is out');
      const rl = C.run(mix(BASE, LINE(1440)));
      assert.ok(rl.page.res.indexOf('>' + X.LABELS.nodeRowLine + '</td>') >= 0 && /to production line/.test(rl.page.res), 'production-line row (calc keeps the last rig-up)');
      assert.ok(/Production line 1,440 psig plus line loss/.test(rl.page.warn), 'rating warning shown');
      W.wtsRenderResults(rl.flow, J(X.RIG_DEFAULTS));
      const g = GOLD.loadGolden().sets[0].page;
      assert.ok($('wts_res').innerHTML === g.res && $('wts_warn').innerHTML === g.warn, 'V-101 back in: the v3.3.1 page');
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
      assert.deepStrictEqual(opts, Object.keys(X.LABELS.sepByDestOptions).map((k) => [k, X.LABELS.sepByDestOptions[k]]), 'destination options');
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
