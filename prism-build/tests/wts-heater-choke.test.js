// Well Test Simulator follow-up — CK-102 heater inlet choke (docs/SIM-FOLLOWUP-PLAN.md §4, §5, §9.2 wts-heater-choke).
//   Host group (WP-C): the two-stage steady walk of calcWTS (flow.ck2) against ANCHORS_CK2 of the frozen contract
//   tests/_wts-fu-shapes.js — the default 48/64, the pair capacity and its limiter (CK-101 / CK-102 / both), No Flow, the
//   liquid-only skip, the dry-gas anchor (cumulative J-T cap), the midcoil position, the blocked-in check — the warning texts
//   (WARN_TEXTS), the strict flow.ck2 shape, "calcWTS never reads wts_sim_rigup", and the display-only wtsRenderResults
//   (CK-102 rbox, Node-table row, two-stage choke line, block warnings; no save, no dispatch, no storage read). The integration
//   test runs the real page: the two Heater-card inputs, their labels, rows hidden / rp-skip while CK-102 is out, the
//   Rig-up switch shows them and the rbox, a bean2 edit re-runs the walk.
//   Engine group (WP-E1): appended below the host group by WP-E1.
// Expected values: the fixture (plan constants and the WP0 anchors), the golden CK-101-only walk, plan texts.
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
function near(v, want, rel, tag) {
  const tol = rel * Math.max(1, Math.abs(want)) + 1e-12;
  if (!(typeof v === 'number' && Math.abs(v - want) <= tol)) throw new Error(tag + ': ' + v + ' vs ' + want + ' (± ' + tol.toFixed(4) + ')');
}
// anchor field → value of flow.ck2 (names of the fixture header)
const FIELD = {
  Pm: (k) => k.Pin, Pout: (k) => k.Pout, Pco2: (k) => k.ck1.Pout, ratio: (k) => k.ck1.ratio, QmaxPair: (k) => k.QmaxMMscfd,
  Tco2: (k) => k.ck1.Tout, dT1: (k) => k.ck1.dTjt, dT2: (k) => k.dTjt, TmIn: (k) => k.Tin, TmOut: (k) => k.Tout, duty: (k) => k.heater.dutyMMBtuHr };
const warnHas = (k, tpl) => (k.warnings || []).some((w) => X.textRe(tpl).test(w.msg));

module.exports = [
  // ─── host group (WP-C) ─────────────────────────────────────────────────────
  {
    name: 'WTSFU C heater choke: flow.ck2 reproduces ANCHORS_CK2 (48/64 default, 40, 32, 24, 4, 64, 96, separator 1,500 psig "both", midcoil), strict shape, regime / limiter / flow-limited exact',
    wp: WP,
    opts: false,
    run(app, assert) {
      X.ANCHORS_CK2.filter((a) => !a.skipped && a.id !== 'blockedIn' && a.id !== 'baseDefaults').forEach((a) => {
        const k = flowOf(a.inputs).flow.ck2, tag = a.id;
        assert.ok(k && k.skipped === false, tag + ': a two-stage block');
        const sh = X.checkShape('flow.ck2', k, { strict: true });
        assert.ok(sh.ok, tag + ' shape: ' + sh.errors.slice(0, 4).join('; '));
        Object.keys(FIELD).forEach((f) => { if (typeof a[f] === 'number') near(FIELD[f](k), a[f], a.rel, tag + ' ' + f); });
        if (a.ck1) assert.strictEqual(k.ck1.regime, a.ck1, tag + ' CK-101 regime');
        if (typeof a.ck2Crit === 'boolean') assert.strictEqual(k.regime === 'Critical', a.ck2Crit, tag + ' CK-102 critical');
        if (a.limiter) assert.strictEqual(k.limiter, a.limiter, tag + ' limiter');
        if (typeof a.flowLimited === 'boolean') assert.strictEqual(k.flowLimited, a.flowLimited, tag + ' flow-limited');
        if (typeof a.noFlow === 'boolean') assert.strictEqual(k.noFlow, a.noFlow, tag + ' noFlow');
        if (a.noFlow) assert.strictEqual(k.regime, 'No Flow', tag + ' regime No Flow');
        assert.ok(k.bean === +a.inputs.wts_bean2 && k.Cd === 0.85 && k.designP_psig === X.DESIGN_P_CK2, tag + ' bean / Cd / design P');
      });
      // the CK-102 node chain is consistent: CK-101 outlet = CK-102 inlet + the seg-3 loss; CK-102 outlet = heater outlet + 5 psi
      const k = flowOf({ wts_bean2: '48' }).flow.ck2;
      near(k.nodes.choke.P - k.nodes.heaterChoke.Pin, k.segs[0].dP, 1e-6, 'seg-3 loss between the chokes');
      near(k.nodes.heaterChoke.P - k.nodes.heater.P, 5, 1e-9, 'H-101 drop');
      near(k.dP, k.Pin - k.Pout, 1e-12, 'ΔP CK-102');
      assert.ok(k.segs[0].id === 'choke_heater' && k.segs[1].id === 'heater_sep' && k.segs[0].label === 'Choke→Heater', 'segment ids / labels as flow.segs');
    },
  },
  {
    name: 'WTSFU C heater choke: dry-gas anchor (cumulative J-T cap 150 °F; heater inlet T and duty = the CK-101-only walk), midcoil (same pressures and duty, Tp1 ≤ Tho − 25), liquid-only skip, No Flow without a throw',
    wp: WP,
    opts: false,
    run(app, assert) {
      const dg = X.ANCHORS_CK2.find((a) => a.id === 'dryGas48');
      const r = flowOf(dg.inputs), k = r.flow.ck2, base = r.flow.heater;
      near(k.ck1.dTjt + k.dTjt, dg.dTsum, 1e-9, 'stages sum to the cap');
      assert.ok(Math.abs(k.Tout - base.Tin) <= dg.tolTinAbs, 'heater inlet T vs CK-101-only: ' + k.Tout + ' / ' + base.Tin);
      assert.ok(Math.abs(k.heater.dutyMMBtuHr - base.dutyMMBtuHr) <= dg.tolDutyRel * base.dutyMMBtuHr, 'duty vs CK-101-only: ' + k.heater.dutyMMBtuHr + ' / ' + base.dutyMMBtuHr);
      near(base.Tin, dg.baseTin, 0.005, 'base heater inlet'); near(base.dutyMMBtuHr, dg.baseDuty, 0.005, 'base duty');
      // defaults: the staging does not move the heater inlet temperature by more than the seg-3 loss term either
      const d = flowOf({ wts_bean2: '48' }).flow, m = flowOf({ wts_bean2: '48', wts_ck2Pos: 'midcoil' }).flow;
      assert.ok(Math.abs(d.ck2.Tout - d.heater.Tin) < 0.5 && Math.abs(d.ck2.heater.dutyMMBtuHr - d.heater.dutyMMBtuHr) < 0.005 * d.heater.dutyMMBtuHr, 'defaults: inlet T / duty');
      // midcoil: identical pressures and duty; the CK-102 temperatures move by the pass-1 heat
      ['Pin', 'Pout', 'QmaxMMscfd', 'dTjt'].forEach((f) => assert.strictEqual(m.ck2[f], d.ck2[f], 'midcoil ' + f));
      assert.strictEqual(m.ck2.ck1.Pout, d.ck2.ck1.Pout);
      near(m.ck2.heater.dutyMMBtuHr, d.ck2.heater.dutyMMBtuHr, 1e-9, 'midcoil duty');
      const heat = m.ck2.Tin - d.ck2.Tin;
      assert.ok(heat > 0, 'pass 1 heats');
      near(m.ck2.Tout - d.ck2.Tout, heat, 1e-9, 'CK-102 outlet moves by the pass-1 heat');
      assert.ok(m.ck2.Tin <= m.ck2.heater.Tout - 25 + 1e-9, 'Tp1 ≤ Tho − 25: ' + m.ck2.Tin);
      assert.ok(m.ck2.pos === 'midcoil' && d.ck2.pos === 'inlet' && m.ck2.heater.Tin === m.ck2.segs[0].Tout, 'midcoil coil inlet = seg-3 outlet');
      // Qg 0: the two-stage gas walk is skipped with the note
      const lo = flowOf({ wts_Qg: '0', wts_bean2: '48' }).flow.ck2, la = X.ANCHORS_CK2.find((a) => a.id === 'liquidOnly');
      assert.deepStrictEqual(J(lo), { v: 1, bean: 48, pos: 'inlet', skipped: true, note: la.note }, 'skipped block');
      assert.ok(X.checkShape('flow.ck2', lo, { strict: true }).ok, 'skipped shape');
      // 4/64: No Flow, finite numbers everywhere, the pair capacity at the infeasible edge
      const n4 = flowOf({ wts_bean2: '4' }).flow.ck2;
      assert.ok(n4.noFlow && n4.flowLimited && n4.regime === 'No Flow' && n4.ck1.regime === 'No Flow', '4/64 No Flow');
      assert.ok(X.checkShape('flow.ck2', n4, { strict: true }).ok, '4/64 shape (finite numbers)');
      assert.ok(warnHas(n4, X.WARN_TEXTS.ck2NoFlow) && warnHas(n4, X.WARN_TEXTS.ck2Limit), '4/64 warnings: ' + n4.warnings.map((w) => w.msg).join(' | '));
    },
  },
  {
    name: 'WTSFU C heater choke: warnings in flow.ck2.warnings only (limiter CK-102 / both, CK-101 subcritical, blocked-in by position, hydrate margin); base fields and base warnings untouched',
    wp: WP,
    opts: false,
    run(app, assert) {
      const b32 = flowOf({ wts_bean2: '32' }).flow.ck2;
      assert.ok(warnHas(b32, X.WARN_TEXTS.ck2Limit) && warnHas(b32, X.WARN_TEXTS.ck1Subcrit), '32/64: ' + b32.warnings.map((w) => w.msg).join(' | '));
      assert.ok(b32.warnings.some((w) => /bean 32\/64 passes 8\.92 of 10\.00 MMscf\/d/.test(w.msg)), '32/64 numbers in the text');
      const both = flowOf({ wts_Psep: '1500', wts_bean2: '32' }).flow.ck2;
      assert.ok(warnHas(both, X.WARN_TEXTS.pairLimit) && !warnHas(both, X.WARN_TEXTS.ck2Limit), 'both: ' + both.warnings.map((w) => w.msg).join(' | '));
      const b40 = flowOf({ wts_bean2: '40' }).flow.ck2;
      assert.ok(warnHas(b40, X.WARN_TEXTS.ck1Subcrit) && !b40.flowLimited && !warnHas(b40, X.WARN_TEXTS.ck2Limit), '40/64: subcritical warning, not limited');
      const b48 = flowOf({ wts_bean2: '48' }).flow.ck2;
      assert.ok(!warnHas(b48, X.WARN_TEXTS.ck1Subcrit) && !warnHas(b48, X.WARN_TEXTS.ck2Limit), '48/64: CK-101 critical, no limit');
      // blocked-in (D16): SITHP estimate 1.2 × 3,000 = 3,600 psig; text by position
      const bi = X.ANCHORS_CK2.find((a) => a.id === 'blockedIn');
      assert.ok(b48.sit_psig === bi.sit && b48.sitEst === bi.sitEst && b48.ratingOK === bi.ratingOK, 'blocked-in fields');
      assert.ok(warnHas(b48, X.WARN_TEXTS.blockedInlet) && !warnHas(b48, X.WARN_TEXTS.blockedMidcoil), 'inlet text');
      assert.ok(b48.warnings.some((w) => /^SITHP 3,600 psig above/.test(w.msg)), 'SITHP value in the text');
      const mid = flowOf({ wts_bean2: '48', wts_ck2Pos: 'midcoil' }).flow.ck2;
      assert.ok(warnHas(mid, X.WARN_TEXTS.blockedMidcoil) && !warnHas(mid, X.WARN_TEXTS.blockedInlet), 'midcoil text');
      const ent = flowOf({ wts_bean2: '48', wts_SITHP: '1200' }).flow.ck2;
      assert.ok(ent.sit_psig === 1200 && ent.sitEst === false && ent.ratingOK === true && !warnHas(ent, X.WARN_TEXTS.blockedInlet), 'entered SITHP below the rating');
      // a cold stream: the hydrate margin warning at the CK-102 outlet
      const cold = flowOf({ wts_bean2: '48', wts_Twh: '60' }).flow.ck2;
      assert.ok(cold.hyd.margin < 10 && warnHas(cold, X.WARN_TEXTS.ck2Hydrate), 'hydrate margin ' + cold.hyd.margin);
      assert.ok(!warnHas(b48, X.WARN_TEXTS.ck2Hydrate) && b48.hyd.margin > 10, 'defaults: no hydrate warning');
      // the base never carries the new texts
      const base = flowOf({ wts_bean2: '32' }).flow;
      const all = Object.keys(X.WARN_TEXTS).map((k) => X.textRe(X.WARN_TEXTS[k]));
      assert.ok(!base.warnings.some((w) => all.some((re) => re.test(w.m))), 'base warnings unchanged');
      assert.deepStrictEqual(J(X.baseFields(base)), J(X.baseFields(flowOf({}).flow)), 'base fields do not depend on bean2');
      ['t', 'msg'].forEach((f) => assert.ok(b32.warnings.every((w) => typeof w[f] === 'string'), 'warnings are {t, msg}'));
    },
  },
  {
    name: 'WTSFU C heater choke: calcWTS never reads wts_sim_rigup (storage spy), a stored CK-102 rig-up changes nothing, one wts:calc per call, flow.sim keeps bean2 out',
    wp: WP,
    opts: false,
    run(app, assert) {
      const plain = flowOf({ wts_bean2: '48' });
      const stored = flowOf({ wts_bean2: '48' }, { storage: { wts_sim_rigup: GOLD.RIG_CK2_V101OUT } });
      assert.ok(plain.reads.indexOf('wts_sim_rigup') < 0 && stored.reads.indexOf('wts_sim_rigup') < 0, 'no read of wts_sim_rigup: ' + stored.reads.join(','));
      const strip = (f) => { const c = J(f); delete c.ts; delete c.seq; return c; };
      assert.deepStrictEqual(strip(stored.flow), strip(plain.flow), 'the stored rig-up does not move any field');
      assert.ok(stored.events.length === 1 && stored.events[0].type === 'wts:calc', 'one dispatch');
      assert.strictEqual(stored.page.res, plain.page.res, 'page unchanged');
      assert.deepStrictEqual(Object.keys(plain.flow.sim).slice(5), X.SAMPLE_FLOW_SIM_KEYS, 'flow.sim: the 9 keys after the v3.3 five');
      assert.ok(plain.flow.sim.sepByDest === 'flare' && plain.flow.sim.sepByP_psig === 150 && !('bean2' in plain.flow.sim), 'flow.sim destination defaults; bean2 travels in flow.ck2');
      // input clamps (§4.1): the bean 4–128 (blank → 48), the position (anything else → inlet)
      [['', 48], ['2', 4], ['500', 128], ['56', 56], ['1e400', 48]].forEach(([v, w]) => assert.strictEqual(flowOf({ wts_bean2: v }).flow.ck2.bean, w, 'bean2 ' + v));
      assert.strictEqual(flowOf({ wts_ck2Pos: 'between' }).flow.ck2.pos, 'inlet');
      // a page without the new inputs (stub DOM returns null) still publishes the blocks with the defaults
      const old = flowOf({});
      assert.ok(old.flow.ck2.bean === 48 && old.flow.ck2.pos === 'inlet' && old.flow.sepBy.dest === 'flare', 'defaults without the inputs');
    },
  },
  {
    name: 'WTSFU C wtsRenderResults: display only — no rig-up → the v3.3.1 page; CK-102 in → rbox, Node-table row, two-stage line, block warnings; bypassed / H-101 out → "Bypassed with H-101"; no dispatch, no storage read',
    wp: WP,
    opts: false,
    run(app, assert) {
      const C = GOLD.makeCalc(GOLD.hostRegion()), W = C.sandbox.window, $ = C.sandbox.$;
      const r = C.run(mix(BASE, { wts_bean2: '48' }));
      const g = GOLD.loadGolden().sets[0].page;
      assert.strictEqual(r.page.res, g.res, 'no rig-up handed over: #wts_res = v3.3.1');
      assert.strictEqual(r.page.warn, g.warn, 'no rig-up handed over: #wts_warn = v3.3.1');
      assert.strictEqual(typeof W.wtsRenderResults, 'function');
      const reads0 = r.reads.length;
      // the default rig-up (CK-102 out, V-101 in): the v3.3.1 page
      W.wtsRenderResults(r.flow, J(X.RIG_DEFAULTS));
      assert.ok($('wts_res').innerHTML === g.res && $('wts_warn').innerHTML === g.warn, 'default rig-up = v3.3.1 page');
      // CK-102 in line
      W.wtsRenderResults(r.flow, mix(X.RIG_DEFAULTS, { heaterChoke: true }));
      const res = $('wts_res').innerHTML, warn = $('wts_warn').innerHTML;
      assert.ok(res.indexOf('<div class="rbox-title">' + X.LABELS.ck2Rbox + '</div>') >= 0, 'CK-102 rbox');
      assert.ok(res.indexOf('>' + X.LABELS.nodeRowCk2 + '</td>') >= 0, 'Node-table row');
      assert.ok(/Two-stage with CK-102<\/span><span class="rv">P between chokes 1,135 psig &middot; CK-101 Critical/.test(res), 'two-stage line on the Choke rbox');
      assert.ok(res.indexOf('Max Rate at this ratio') === res.lastIndexOf('Max Rate at this ratio'), 'the base choke rows once');
      assert.ok(/SITHP 3,600 psig above the 1,440 psig design pressure of the line CK-101 → CK-102/.test(warn), 'blocked-in warning shown');
      assert.ok(res.indexOf(g.res.slice(0, 200)) === 0 && res.length > g.res.length, 'built on the base page');
      assert.ok(r.events.length === 1 && C.sandbox.localStorage.reads.length === reads0, 'no dispatch, no storage read');
      // the next calc keeps the last rig-up (calcWTS passes none)
      const r2 = C.run(mix(BASE, { wts_bean2: '32' }));
      assert.ok(r2.page.res.indexOf(X.LABELS.ck2Rbox) >= 0 && /CK-102 limits the rate: bean 32\/64/.test(r2.page.warn), 'calc keeps the last rig-up');
      assert.deepStrictEqual(J(X.baseFields(r2.flow)), J(X.baseFields(C.run(mix(BASE, { wts_bean2: '32' })).flow)), 'base fields');
      // heater bypassed / H-101 out: CK-102 in the rig-up, out of line
      const r3 = C.run(mix(BASE, { wts_bean2: '48', wts_bypass: '1' }));
      assert.ok(/Bypassed with H-101/.test(r3.page.res) && r3.page.res.indexOf(X.LABELS.nodeRowCk2) < 0, 'heater bypass: bypassed');
      W.wtsRenderResults(r3.flow, mix(X.RIG_DEFAULTS, { heaterChoke: true, heater: false }));
      assert.ok(/Bypassed with H-101/.test($('wts_res').innerHTML), 'H-101 out: bypassed');
      // a stale flow (not the last calc) renders nothing new; a flow without blocks (old flow) neither throws
      const before = $('wts_res').innerHTML;
      W.wtsRenderResults(J(r3.flow), mix(X.RIG_DEFAULTS, { heaterChoke: true }));
      assert.strictEqual($('wts_res').innerHTML, before, 'stale flow ignored');
      W.wtsRenderResults(null, null); W.wtsRenderResults({ v: 1 }, {});
    },
  },
  {
    name: 'WTSFU C page: Heater-card CK-102 inputs (labels, options, count tag), hidden and rp-skip while CK-102 is out; the Rig-up switch shows them and the CK-102 rbox; a bean2 edit re-runs the walk',
    wp: WP,
    integration: true,
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="wts"]'); if (!b) throw new Error('no Well Test Simulator sidebar button');
      app.click(b); app.flush(500);
      const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
      assert.strictEqual(lab('wts_bean2'), X.LABELS.bean2);
      assert.strictEqual(lab('wts_ck2Pos'), X.LABELS.ck2Pos);
      const opts = Array.from(app.el('wts_ck2Pos').querySelectorAll('option')).map((o) => [o.getAttribute('value'), String(o.textContent)]);
      assert.deepStrictEqual(opts, Object.keys(X.LABELS.ck2PosOptions).map((k) => [k, X.LABELS.ck2PosOptions[k]]), 'position options');
      assert.ok(app.el('wts_bean2').closest('.card').querySelector('.card-title').textContent === 'Heater', 'in the Heater card');
      const unitCat = app.el('wts_bean2').getAttribute('data-wts-unit-cat') || (app.el('wts_bean2').dataset && app.el('wts_bean2').dataset.wtsUnitCat);
      assert.strictEqual(unitCat, 'count', 'bean2 tagged count');
      const row = app.el('wts_bean2').closest('.fg-item'), row2 = app.el('wts_ck2Pos').closest('.fg-item');
      assert.ok(row.classList.contains('rp-skip') && row.style.display === 'none' && row2.classList.contains('rp-skip'), 'hidden + rp-skip while out');
      const f0 = app.win.WTS_state.flow;
      assert.ok(f0.ck2 && f0.ck2.bean === 48 && f0.ck2.skipped === false, 'the page publishes flow.ck2');
      assert.ok(app.el('wts_res').innerHTML.indexOf(X.LABELS.ck2Rbox) < 0, 'no CK-102 rbox while out');
      // CK-102 into the rig-up from the Rig-up card
      const sw = app.el('wtsl_rigup').querySelector('[data-rig="heaterChoke"]');
      app.click(sw); app.flush(400);
      assert.ok(!row.classList.contains('rp-skip') && row.style.display !== 'none' && !row2.classList.contains('rp-skip'), 'rows shown with CK-102 in');
      assert.ok(app.el('wts_res').innerHTML.indexOf(X.LABELS.ck2Rbox) >= 0, 'CK-102 rbox shown');
      app.input('wts_bean2', '32'); app.flush(500);
      const f1 = app.win.WTS_state.flow;
      assert.ok(f1.ck2.bean === 32 && f1.ck2.flowLimited && f1.ck2.limiter === 'CK-102', 'bean2 32 re-runs the walk');
      assert.ok(/CK-102 limits the rate/.test(app.el('wts_warn').innerHTML), 'limit warning on the page');
      assert.ok(JSON.stringify(JSON.parse(app.win.localStorage.getItem('wts_page_wts') || '{}')).indexOf('wts_bean2') >= 0, 'bean2 autosaved');
      // calcWTS never reads the rig-up (storage spy on a direct call)
      const ls = app.win.localStorage, keep = ls.getItem, seen = [];
      ls.getItem = function (k) { seen.push(String(k)); return keep.apply(this, arguments); };
      try { app.win.calcWTS(); } finally { ls.getItem = keep; }
      assert.ok(seen.indexOf('wts_sim_rigup') < 0, 'calcWTS read: ' + seen.join(','));
      app.click(app.el('wtsl_rigup').querySelector('[data-rig="heaterChoke"]')); app.flush(400);
      assert.ok(row.classList.contains('rp-skip') && app.el('wts_res').innerHTML.indexOf(X.LABELS.ck2Rbox) < 0, 'out again: hidden, no rbox');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    },
  },
];
