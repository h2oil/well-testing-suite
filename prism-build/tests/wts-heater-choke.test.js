// Well Test Simulator follow-up — CK-102 heater inlet choke (docs/SIM-FOLLOWUP-PLAN.md §4, §5, §9.2 wts-heater-choke).
//   Host group (WP-C): the two-stage steady walk of calcWTS (flow.ck2) against ANCHORS_CK2 of the frozen contract
//   tests/_wts-fu-shapes.js — the default 48/64, the pair capacity and its limiter (CK-101 / CK-102 / both), No Flow, the
//   liquid-only skip, the dry-gas anchor (cumulative J-T cap), the midcoil position, the blocked-in check — the warning texts
//   (WARN_TEXTS), the strict flow.ck2 shape, "calcWTS never reads wts_sim_rigup", and the display-only wtsRenderResults
//   (CK-102 rbox, Node-table row, two-stage choke line, block warnings; no save, no dispatch, no storage read). The integration
//   test runs the real page: the two Heater-card inputs, their labels, rows hidden / rp-skip while CK-102 is out, the
//   Rig-up switch shows them and the rbox, a bean2 edit re-runs the walk.
//   Engine group (WP-E1): below the host group (its own header, WP WTSHC).
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

const HOST = [
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
        if (a.regime) assert.strictEqual(k.regime, a.regime, tag + ' regime (at the pair capacity when flow-limited)');
        if (a.flowLimited) assert.ok(Math.abs(k.nodes.choke.P - k.nodes.heaterChoke.Pin - k.segs[0].dP) < 1e-6 && k.nodes.choke.P < k.ck1.Pout + 1e-9 && k.Pin < 3000, tag + ': one physical state (at QmaxPair) — Pm below the CK-101 inlet');
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
      // §4.3-7 second check: seg 3 at the CK-102 inlet, Thyd(Pm) against T3 (a warning; the frozen hyd shape is the outlet)
      const inRe = /^Hydrate margin at the CK-102 inlet -?[\d,.]+ °F \(hydrate [\d,.]+ °F at [\d,.]+ psig\)$/;
      assert.ok(X.textRe(X.WARN_TEXTS.ck2HydrateIn).test('Hydrate margin at the CK-102 inlet 4.2 °F (hydrate 61 °F at 1,135 psig)'), 'fixture text ck2HydrateIn');
      assert.ok(cold.warnings.some((w) => inRe.test(w.msg)), 'cold: inlet hydrate warning: ' + cold.warnings.map((w) => w.msg).join(' | '));
      assert.ok(!b48.warnings.some((w) => /CK-102 inlet/.test(w.msg)), 'defaults: no inlet hydrate warning');
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
      // v3.4.2 (2026-11-09): the three LP flare line inputs are appended after the v3.3.3 keys
      assert.deepStrictEqual(Object.keys(plain.flow.sim).slice(5), X.SAMPLE_FLOW_SIM_KEYS.concat(['lpNps', 'lpSch', 'lpLen_ft']), 'flow.sim: the 9 keys after the v3.3 five, then the v3.4.2 LP inputs');
      // v3.4.2 (2026-11-09): a page without the destination input gets the page default, the surge tank T-201
      assert.ok(plain.flow.sim.sepByDest === 'surge' && plain.flow.sim.sepByP_psig === 150 && !('bean2' in plain.flow.sim), 'flow.sim destination defaults; bean2 travels in flow.ck2');
      // input clamps (§4.1): the bean 4–128 (blank → 48), the position (anything else → inlet)
      [['', 48], ['2', 4], ['500', 128], ['56', 56], ['1e400', 48]].forEach(([v, w]) => assert.strictEqual(flowOf({ wts_bean2: v }).flow.ck2.bean, w, 'bean2 ' + v));
      assert.strictEqual(flowOf({ wts_ck2Pos: 'between' }).flow.ck2.pos, 'inlet');
      // a page without the new inputs (stub DOM returns null) still publishes the blocks with the defaults
      const old = flowOf({});
      assert.ok(old.flow.ck2.bean === 48 && old.flow.ck2.pos === 'inlet' && old.flow.sepBy.dest === 'surge', 'defaults without the inputs (v3.4.2: dest surge)');
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
      // v3.4.2: a handed-over rig-up with T-201 in adds the LP flare line box at the end of #wts_res (only that)
      const noLp = (h) => { const i = h.indexOf('<div class="rbox" style="margin-top:10px"><div class="rbox-title">LP flare line'); return i < 0 ? h : h.slice(0, i); };
      assert.ok($('wts_res').innerHTML !== g.res && noLp($('wts_res').innerHTML) === g.res && $('wts_warn').innerHTML === g.warn, 'default rig-up = v3.3.1 page + the LP box');
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

// Well Test Simulator follow-up — CK-102 heater inlet choke (docs/SIM-FOLLOWUP-PLAN.md §5, §9.2 "tests/wts-heater-choke.test.js").
// Engine group (WP-E1): the working engine 31 with flow.ck2 blocks built from the contract fixture (tests/_wts-fu-shapes.js
// ANCHORS_CK2 / EXAMPLES.flowCk2) on WTS_sim.SAMPLE_FLOW (= the page defaults), so the engine is tested against the frozen
// block shape whatever the host walk (WP-C) publishes:
//   • steady values from the block: CK-101 outlet = Pm + seg-3 loss, the CK-102 node (inlet, outlet, J-T, hydrate), history Pck2;
//   • alarms CHOKE2_LIMIT (CHOKE_LIMIT suppressed), CK1_SUBCRIT only when the base was critical, PAH_CK2 on a live pinch (U7),
//     HYD_heaterChoke, texts by limiter and position, release by quiet(Q_CK2);
//   • the 5 s ΔP lag: heater bypass and rig in / out without a step (U3), derive-survival through a bean2 change and a Thtr
//     change during a transient (U2), the cumulative J-T cap (D10), determinism, dt 1 vs dt 10, old flows.
// The host group (WP-C) is above.
// Expected values: the fixture (anchors, texts, shapes), the plan's laws of §5.3 evaluated on the block, or the v1.4.0 law.


const WP_E1 = 'WTSHC';
const NZ = { noise: { on: false } };
const A = {}; X.ANCHORS_CK2.forEach((a) => { A[a.id] = a; });

// ── flow.ck2 blocks from the anchors (the example block at 48/64 inlet; other numbers consistent with §4.3 at the defaults) ──
function block(id, edit) {
  const b = X.EXAMPLES.flowCk2, a = A[id] || {};
  // review round: a flow-limited block stands at the pair capacity (the host walk at QmaxPair: segments, heater, duty, nodes)
  const atQ = (P, Phi, Tin, dT2, Tco2, dT1, s3, s4, duty) => {
    Object.assign(b, { QmaxMMscfd: a.QmaxPair, Pin: P.Pm, Pout: Phi, dP: P.Pm - Phi, Tin, dTjt: dT2, Tout: Tin - dT2 });
    Object.assign(b.ck1, { Pout: P.Pco2, ratio: a.ratio, QmaxMMscfd: a.QmaxPair, Tout: Tco2, dTjt: dT1 });
    b.nodes.choke = { P: P.Pco2, T: Tco2 }; Object.assign(b.nodes.heaterChoke, { P: Phi, Pin: P.Pm, T: Tin - dT2, Tin });
    Object.assign(b.nodes.heater, { P: Phi - 5, Tin: Tin - dT2, duty }); Object.assign(b.heater, { dutyMMBtuHr: duty, Tin: Tin - dT2 });
    Object.assign(b.segs[0], { dP: s3[0], vel: s3[1], P0: P.Pco2, Pout: P.Pm }); Object.assign(b.segs[1], { dP: s4[0], vel: s4[1], P0: Phi - 5 });
  };
  if (id === 'bean32') {
    Object.assign(b, { bean: 32, regime: 'Critical', flowLimited: true, limiter: 'CK-102' }); b.ck1.regime = 'Subcritical';
    atQ({ Pm: a.Pm, Pco2: a.Pco2 }, 155.8065, 156.6003, 87.9293, 156.6006, 23.3972, [0.1089316, 3.574155], [0.8064856, 52.9232], 1.877463);
  } else if (id === 'bean40') {
    Object.assign(b, { bean: 40, regime: 'Critical', flowLimited: false, limiter: 'CK-102', QmaxMMscfd: a.QmaxPair, Pin: a.Pm, dP: a.Pm - b.Pout, Tin: a.Tco2 });
    Object.assign(b.ck1, { regime: 'Subcritical', Pout: a.Pm + 0.25, ratio: a.ratio, QmaxMMscfd: a.QmaxPair, Tout: a.Tco2 });
  } else if (id === 'bean24') {
    Object.assign(b, { bean: 24, regime: 'Critical', noFlow: true, flowLimited: true, limiter: 'CK-102' }); b.ck1.regime = 'Subcritical';
    atQ({ Pm: a.Pm, Pco2: a.Pco2 }, 155.3396, 172.0225, 103.3723, 172.0227, 7.975137, [0.04173572, 2.0818], [0.3396406, 33.88292], 1.198877);
  } else if (id === 'bean4') {
    Object.assign(b, { bean: 4, regime: 'No Flow', noFlow: true, flowLimited: true, limiter: 'CK-102' }); b.ck1.regime = 'No Flow';
    atQ({ Pm: 2998.892, Pco2: 2998.892 }, 155.0005, 179.9832, 111.3477, 179.9832, 0.0146, [0.00006231801, 0.05889386], [0.0005278548, 0.9977022], 0.03523463);
    b.ck1.QmaxMMscfd = 0;
  } else if (id === 'bean48mid') {
    Object.assign(b, { pos: 'midcoil', Tin: a.TmIn, Tout: a.TmOut });
  }
  if (edit) edit(b);
  return b;
}
function flowWith(S, blk, edit) { const f = J(S.SAMPLE_FLOW); if (blk) f.ck2 = blk; if (edit) edit(f); return f; }
function mk(S, flow, o) {
  o = o || {};
  return S.create(flow, { seed: o.seed == null ? 21 : o.seed, config: o.cfg || NZ, rigup: o.rig === undefined ? { heaterChoke: true } : o.rig });
}
function adv(sim, secs, dt) { dt = dt || 1; const n = Math.round(secs / dt); for (let i = 0; i < n; i++) sim.advance(dt); }
function ids(st) { return st.alarms.map((a) => a.id); }
function alarm(st, id) { return st.alarms.filter((a) => a.id === id)[0] || null; }
function fu(sim) { return sim._internal().fu; }
// every number finite; null only on a NULLABLE path; never undefined
function finiteBad(o, nullable, p, bad) {
  p = p || ''; bad = bad || [];
  if (o === null) { if (nullable.indexOf(p.replace(/\[\d+\]/g, '[*]')) < 0) bad.push(p + '=null'); return bad; }
  if (o === undefined) { bad.push(p + '=undefined'); return bad; }
  if (typeof o === 'number') { if (!isFinite(o)) bad.push(p + '=' + o); return bad; }
  if (Array.isArray(o)) { o.forEach((v, i) => finiteBad(v, nullable, p + '[' + i + ']', bad)); return bad; }
  if (typeof o === 'object') Object.keys(o).forEach((k) => finiteBad(o[k], nullable, p ? p + '.' + k : k, bad));
  return bad;
}
// largest |Δ| of the CK-101 outlet over one 1 s step at dt 0.05 s (no jump inside the step)
function maxJump(sim, key) {
  let prev = sim.getState().nodes.choke[key || 'P'], m = 0;
  for (let i = 0; i < 20; i++) { sim.advance(0.05); const v = sim.getState().nodes.choke[key || 'P']; m = Math.max(m, Math.abs(v - prev)); prev = v; }
  return m;
}

const ENGINE = [
  {
    name: 'WTSHC E1 steady values from flow.ck2 (48/64 inlet): CK-101 outlet = Pm + seg-3 loss, CK-102 node = the block, J-T per stage, history Pck2, node shape',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work'), b = block('bean48'), a = A.bean48;
      const sim = mk(S, flowWith(S, b));
      for (const when of ['t = 0', 'after 1 h']) {
        if (when !== 't = 0') adv(sim, 3600, 10);
        const st = J(sim.getState()), nk = st.nodes.heaterChoke, f = fu(sim);
        assert.ok(f.sel === 'ck2' && f.CK2.act === true && f.CK2.note === '', when + ': in line ' + JSON.stringify(f.CK2));
        assert.ok(nk.inRig && nk.active && !nk.bypassed && nk.note === '', when + ': node active');
        assert.near(nk.Pin, a.Pm, 0.005 * a.Pm, when + ': Pm (CK-102 inlet)');
        assert.near(nk.P, a.Pout, 1, when + ': CK-102 outlet');
        assert.near(st.nodes.choke.P, nk.Pin + st.segs[2].dP, 1e-6, when + ': CK-101 outlet = Pm + seg-3 loss');
        assert.near(st.nodes.choke.P, b.ck1.Pout, 0.005 * b.ck1.Pout, when + ': CK-101 outlet = ck1.Pout');
        assert.ok(nk.regime === 'Critical' && nk.limiter === 'CK-101' && nk.bean === 48 && nk.pos === 'inlet' && !nk.flowLimited, when + ': regime / limiter / bean');
        assert.near(nk.QmaxMMscfd, a.QmaxPair, 1e-9, when + ': pair capacity');
        assert.near(nk.dTjt, a.dT2, 0.2, when + ': CK-102 J-T stage');
        assert.near(st.nodes.choke.dTjt, a.dT1, 0.2, when + ': CK-101 J-T stage');
        assert.near(nk.Tin, a.TmIn, 0.05, when + ': CK-102 inlet T (= T3)'); assert.near(nk.T, a.TmOut, 0.2, when + ': CK-102 outlet T');
        assert.near(st.nodes.heater.Tin, a.TmOut, 0.05, when + ': H-101 inlet = CK-102 outlet');
        assert.ok(nk.hyd === false && nk.th > 0 && nk.th < nk.T, when + ': hydrate margin ' + nk.th);
        assert.ok(nk.designP_psig === X.DESIGN_P_CK2 && st.inputs.bean2 === 48 && st.inputs.ck2Pos === 'inlet', when + ': inputs');
        const r = X.checkShape('nodes.heaterChoke', nk, { strict: true }); assert.ok(r.ok, when + ': ' + r.errors.join('; '));
        assert.deepStrictEqual(finiteBad(st, J(S.NULLABLE)), [], when + ': finite snapshot');
        assert.deepStrictEqual(J(ids(st).filter((id) => X.Q_CK2.indexOf(id) >= 0)), [], when + ': no CK-102 alarm at 48/64');
      }
      const h = sim.getHistory('Pck2'), hp = sim.getHistory('Pchoke'), n = h.y.length - 1;
      assert.near(h.y[n], A.bean48.Pm, 0.005 * A.bean48.Pm, 'history Pck2 = Pm');
      assert.near(hp.y[n] - h.y[n], sim.getState().segs[2].dP, 0.05, 'history Pchoke − Pck2 = seg-3 loss');
      const m = sim.getState().health.massErr;
      assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'mass balance ' + JSON.stringify(m));
    },
  },
  {
    name: 'WTSHC E1 midcoil: same pressures, CK-102 inlet at the pass-1 temperature (Tp1 ≤ Tho − 25), outlet T and hydrate from it; PAH text by position',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work'), a = A.bean48mid;
      const si = mk(S, flowWith(S, block('bean48'))), sm = mk(S, flowWith(S, block('bean48mid')));
      adv(si, 600, 10); adv(sm, 600, 10);
      const ni = si.getState().nodes.heaterChoke, nm = sm.getState().nodes.heaterChoke;
      assert.ok(nm.pos === 'midcoil' && sm.getState().inputs.ck2Pos === 'midcoil', 'position');
      assert.near(nm.Pin, ni.Pin, 1e-9, 'same CK-102 inlet'); assert.near(nm.P, ni.P, 1e-9, 'same outlet');
      assert.near(sm.getState().nodes.choke.P, si.getState().nodes.choke.P, 1e-9, 'same CK-101 outlet');
      assert.near(nm.Tin, a.TmIn, 0.05, 'CK-102 inlet = Tp1'); assert.ok(nm.Tin <= 150 - a.Tp1MaxBelowTho + 1e-6, 'Tp1 ≤ Tho − 25');
      assert.near(nm.T, a.TmOut, 0.2, 'CK-102 outlet T (pass-1 heat, then its J-T)');
      assert.near(nm.dTjt, ni.dTjt, 1e-9, 'same J-T stage'); assert.ok(nm.T - ni.T > 15, 'outlet warmer by the pass-1 heat');
      assert.near(sm.getState().nodes.heater.dutyMMBtuHr, si.getState().nodes.heater.dutyMMBtuHr, 0.005 * si.getState().nodes.heater.dutyMMBtuHr, 'same duty');
      // PAH-102 texts by position at a high pressure between the chokes (a block with Pm above 90 % of the design pressure)
      for (const pos of ['inlet', 'midcoil']) {
        const s = mk(S, flowWith(S, block('bean40', (b) => { b.pos = pos; })));
        adv(s, 60, 1);
        const al = alarm(s.getState(), 'PAH_CK2');
        assert.ok(al && al.sev === 'warn' && al.tag === 'PAH-102' && al.eq === 'heaterChoke', pos + ': PAH-102 ' + JSON.stringify(al));
        assert.match(al.msg, X.textRe(X.ALARM_TEXTS['PAH_CK2_' + pos]), pos + ' text');
      }
    },
  },
  {
    name: 'WTSHC E1 alarms: CHOKE2_LIMIT (CHOKE_LIMIT suppressed) by limiter, CK1_SUBCRIT only when the base was critical, HYD_heaterChoke, released when CK-102 leaves',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      // 32/64: pair flow-limited by CK-102, CK-101 subcritical with a critical base walk
      const s = mk(S, flowWith(S, block('bean32')));
      adv(s, 120, 1);
      let st = s.getState(), c2 = alarm(st, 'CHOKE2_LIMIT'), sub = alarm(st, 'CK1_SUBCRIT');
      assert.ok(c2 && c2.sev === 'alarm' && c2.tag === 'CK-102' && c2.eq === 'heaterChoke', 'CHOKE2_LIMIT ' + JSON.stringify(c2));
      assert.match(c2.msg, X.textRe(X.ALARM_TEXTS.CHOKE2_LIMIT), 'CK-102 text');
      assert.ok(c2.msg.indexOf('bean 32/64 passes 8.92 of 10.00 MMscf/d') >= 0, c2.msg);
      assert.ok(ids(st).indexOf('CHOKE_LIMIT') < 0, 'CHOKE_LIMIT suppressed while CHOKE2_LIMIT is raised');
      assert.ok(sub && sub.sev === 'warn' && sub.tag === 'CK-101' && sub.eq === 'choke' && sub.msg === X.ALARM_TEXTS.CK1_SUBCRIT, 'CK1_SUBCRIT ' + JSON.stringify(sub));
      assert.near(st.f, A.bean32.QmaxPair / 10, 0.002, 'rate at the pair capacity');
      assert.ok(st.nodes.heaterChoke.flowLimited && st.nodes.heaterChoke.limiter === 'CK-102' && st.nodes.choke.regime === 'Subcritical', 'node flags');
      // review round: the block stands at the pair capacity, so the live steady state at f = QmaxPair / Qg is the block's own state
      // (one value on the page and live): Pm, the CK-102 outlet, the CK-101 outlet = Pm + the seg-3 loss, the heater duty
      const nk = st.nodes.heaterChoke, bk = block('bean32');
      assert.near(nk.Pin, A.bean32.Pm, 1.0, 'live Pm at the limited rate = the block (2,402 psig at 8.92)');
      assert.near(nk.P, bk.Pout - 5 * (1 - st.fInst * st.fInst), 0.05, 'live CK-102 outlet = the block, less the fixed 5 psi H-101 drop scaled with f² (as the base)');
      assert.near(st.nodes.choke.P, bk.ck1.Pout, 1.0, 'live CK-101 outlet = the block');
      assert.near(st.nodes.heater.dutyMMBtuHr, bk.heater.dutyMMBtuHr, 0.02, 'live duty = the block duty at the pair capacity');
      assert.ok(nk.regime === 'Critical' && Math.abs(st.nodes.choke.T - bk.ck1.Tout) < 0.5 && Math.abs(nk.Tin - bk.Tin) < 0.5, 'CK-102 regime / temperatures of the block');
      // the CK-101-only walk subcritical: no CK1_SUBCRIT
      const s2 = mk(S, flowWith(S, block('bean32'), (fl) => { fl.choke.regime = 'Subcritical'; }));
      adv(s2, 30, 1);
      assert.ok(ids(s2.getState()).indexOf('CK1_SUBCRIT') < 0 && ids(s2.getState()).indexOf('CHOKE2_LIMIT') >= 0, 'base subcritical: no CK1_SUBCRIT');
      // limiter 'both': the pair text
      const s3 = mk(S, flowWith(S, block('bean32', (b) => { b.limiter = 'both'; b.QmaxMMscfd = 8.8438; })));
      adv(s3, 30, 1);
      const c3 = alarm(s3.getState(), 'CHOKE2_LIMIT');
      assert.ok(c3 && c3.msg.indexOf('CK-101 and CK-102 together pass 8.84 of 10.00 MMscf/d') === 0, c3 && c3.msg);
      assert.match(c3.msg, X.textRe(X.ALARM_TEXTS.CHOKE2_LIMIT_both), 'both text');
      // limiter CK-101 and flow-limited: CHOKE_LIMIT as today, no CHOKE2_LIMIT
      const s4 = mk(S, flowWith(S, block('bean48', (b) => { b.flowLimited = true; b.QmaxMMscfd = 9; b.ck1.QmaxMMscfd = 9; })));
      adv(s4, 30, 1);
      assert.ok(ids(s4.getState()).indexOf('CHOKE_LIMIT') >= 0 && ids(s4.getState()).indexOf('CHOKE2_LIMIT') < 0, 'limiter CK-101: CHOKE_LIMIT');
      // CK-102 hydrate at its outlet: a cold CK-102 inlet (T3 50 °F; the outlet 38 °F colder, below the hydrate line)
      const s5 = mk(S, flowWith(S, block('bean48', (b) => { b.Tin = 50; b.Tout = 11.7; })));
      adv(s5, 30, 1);
      const hy = alarm(s5.getState(), 'HYD_heaterChoke'), n5 = s5.getState().nodes.heaterChoke;
      assert.ok(n5.hyd && n5.T < n5.th && hy && hy.sev === 'hyd' && hy.tag === 'CK-102' && hy.eq === 'heaterChoke', 'HYD_heaterChoke ' + JSON.stringify(hy));
      assert.ok(/^Heater inlet choke \(CK-102\) outlet: .+ below hydrate .+ at .+/.test(hy.msg), hy.msg);
      // every CK-102 alarm id is in Q_CK2; leaving the rig-up releases them (and CHOKE_LIMIT takes over for the base flow)
      [s, s5].forEach((x) => ids(x.getState()).filter((id) => /CHOKE2|CK1_SUB|PAH_CK2|HYD_heaterChoke/.test(id)).forEach((id) => assert.ok(X.Q_CK2.indexOf(id) >= 0, id)));
      assert.strictEqual(s.setRigup({ heaterChoke: false }), true);
      adv(s, 5, 1);
      st = s.getState();
      assert.deepStrictEqual(J(ids(st).filter((id) => X.Q_CK2.indexOf(id) >= 0)), [], 'released by quiet(Q_CK2)');
      assert.ok(!st.nodes.heaterChoke.active && !st.nodes.heaterChoke.inRig, 'out');
      assert.strictEqual(s5.setRigup({ heaterChoke: false }), true); adv(s5, 2, 1);
      assert.ok(ids(s5.getState()).indexOf('HYD_heaterChoke') < 0, 'hydrate alarm released');
    },
  },
  {
    name: 'WTSHC E1 alarm texts follow a new flow while raised (bean2 32 → 28, limiter CK-102 → both; PAH-102 by position) and the host formatter (Metric)',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const s = mk(S, flowWith(S, block('bean32')));
      adv(s, 120, 1);
      let c2 = alarm(s.getState(), 'CHOKE2_LIMIT');
      assert.ok(c2 && c2.msg.indexOf('bean 32/64 passes 8.92 of 10.00 MMscf/d') >= 0, c2 && c2.msg);
      const since = c2.since;
      // bean2 32 → 28 while the alarm stays raised: value / limit and the text follow (no clear / re-raise)
      s.setFlow(flowWith(S, block('bean32', (b) => { b.bean = 28; b.QmaxMMscfd = 7.5; b.ck1.QmaxMMscfd = 7.5; })));
      adv(s, 2, 1);
      c2 = alarm(s.getState(), 'CHOKE2_LIMIT');
      assert.ok(c2 && c2.since === since, 'still the same raise');
      assert.near(c2.limit, 7.5, 1e-9, 'limit follows');
      assert.ok(c2.msg.indexOf('bean 28/64 passes 7.50 of 10.00 MMscf/d') >= 0 && c2.msg.indexOf('32/64') < 0, c2.msg);
      assert.match(c2.msg, X.textRe(X.ALARM_TEXTS.CHOKE2_LIMIT), 'CK-102 text');
      // limiter CK-102 → both while raised: the pair text
      s.setFlow(flowWith(S, block('bean32', (b) => { b.limiter = 'both'; b.QmaxMMscfd = 8.8438; })));
      adv(s, 2, 1);
      c2 = alarm(s.getState(), 'CHOKE2_LIMIT');
      assert.ok(c2 && c2.since === since && c2.msg.indexOf('CK-101 and CK-102 together pass 8.84 of 10.00 MMscf/d') === 0, c2 && c2.msg);
      assert.match(c2.msg, X.textRe(X.ALARM_TEXTS.CHOKE2_LIMIT_both), 'both text');
      // PAH-102 (raised at 40/64 inlet): inlet text; field units by default
      const p = mk(S, flowWith(S, block('bean40')));
      adv(p, 300, 1);
      let pa = alarm(p.getState(), 'PAH_CK2');
      assert.ok(pa, 'PAH-102 raised');
      assert.match(pa.msg, X.textRe(X.ALARM_TEXTS.PAH_CK2_inlet), pa.msg);
      // a host formatter (Metric): CHOKE2_LIMIT and PAH-102 go through it as CHOKE_LIMIT does (no psig / MMscf/d left)
      const fmt = (v, cat, dp) => cat === 'pressureG' ? (v * 0.0689476).toFixed(1) + ' barg' : cat === 'gasRate' ? (v * 28.3168).toFixed(1) + ' km3/d'
        : v.toFixed(dp == null ? 1 : dp) + ' u';
      s.setFormatter(fmt); p.setFormatter(fmt);
      adv(s, 2, 1); adv(p, 2, 1);
      c2 = alarm(s.getState(), 'CHOKE2_LIMIT'); pa = alarm(p.getState(), 'PAH_CK2');
      assert.ok(c2.msg.indexOf('together pass 250.4 km3/d of 283.2 km3/d') >= 0 && c2.msg.indexOf('MMscf/d') < 0, c2.msg);
      assert.ok(pa.msg.indexOf(' barg, ≥ 90 % of the 99.3 barg design pressure of the line CK-101 → CK-102') >= 0 && pa.msg.indexOf('psig') < 0, pa.msg);
      // back to field units: the fixture texts again
      p.setFormatter(null); adv(p, 2, 1);
      assert.match(alarm(p.getState(), 'PAH_CK2').msg, X.textRe(X.ALARM_TEXTS.PAH_CK2_inlet), 'field units again');
    },
  },
  {
    name: 'WTSHC E1 U7: a live pinch of CK-102 (No Flow block: 24/64, and 4/64) at WHP 3,000 raises PAH-102 from the live Pm; opening to 48/64 clears it; no throw, finite',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      // 4/64 (pair capacity 0.167 MMscf/d): PAH-102 within the first second of the pinch. (The rate cut to 1.7 % then trips
      // PSHH-101 / ESD through the separator PCV re-sizing, as a CK-101-only flow limited to 0.167 does in v3.3.1.)
      const q = mk(S, flowWith(S, block('bean48')));
      adv(q, 300, 1);
      q.setFlow(flowWith(S, block('bean4')));
      adv(q, 1, 1);
      const q1 = q.getState(), qa = alarm(q1, 'PAH_CK2');
      assert.ok(qa && qa.value >= 0.9 * X.DESIGN_P_CK2, '4/64: PAH-102 after 1 s ' + JSON.stringify(qa));
      adv(q, 120, 1);
      assert.deepStrictEqual(finiteBad(J(q.getState()), J(S.NULLABLE)), [], '4/64: finite');
      // 24/64 (pair capacity 5.69): the sustained case
      const s = mk(S, flowWith(S, block('bean48')));
      adv(s, 300, 1);
      assert.ok(ids(s.getState()).indexOf('PAH_CK2') < 0, 'no PAH-102 at 48/64');
      const p0 = s.getState().nodes.choke.P, b48 = block('bean48'), b24 = block('bean24');
      s.setFlow(flowWith(S, b24));                                  // bean2 24/64: setHostInput → calcWTS → setFlow
      const st0 = s.getState();
      // the ΔP lag holds; the only change is the re-solved seg 3 / seg 4 of the new block (stated at its pair capacity, put back on
      // the requested-rate basis: ΔP / lf²) at the flow fraction of the moment
      const l2 = Math.pow(A.bean24.QmaxPair / 10, 2), fi2 = st0.fInst * st0.fInst;
      const dS3 = fi2 * (b24.segs[0].dP / l2 - b48.segs[0].dP), dS4 = fi2 * (b24.segs[1].dP / l2 - (b48.nodes.heater.P - S.SAMPLE_FLOW.nodes[4].P));   // the old Ph − Psep came from the nodes
      assert.near(st0.nodes.choke.P, p0 + dS3 + dS4, 0.01, 'no step at the bean change (the ΔP lag holds; seg 3 / 4 re-solved ' + (dS3 + dS4).toFixed(3) + ' psi)');
      let raised = -1;
      for (let t = 1; t <= 300; t++) {
        s.advance(1);
        if (raised < 0 && ids(s.getState()).indexOf('PAH_CK2') >= 0) raised = t;
      }
      const st = s.getState(), pah = alarm(st, 'PAH_CK2'), nk = st.nodes.heaterChoke;
      assert.ok(raised > 0 && raised <= 5 && pah, 'PAH-102 raised after ' + raised + ' s and held');
      assert.ok(ids(st).indexOf('ESD_TRIPPED') < 0, 'no ESD');
      assert.match(pah.msg, X.textRe(X.ALARM_TEXTS.PAH_CK2_inlet), 'inlet text');
      assert.ok(pah.tag === 'PAH-102' && pah.value >= 0.9 * X.DESIGN_P_CK2 && pah.limit === 0.9 * X.DESIGN_P_CK2, 'value / limit');
      // review round: the No Flow block (no state at 10 MMscf/d) stands at its pair capacity 5.69: CK-102 critical there, live Pm =
      // the block's Pm (2,796 psig, not the CK-101 inlet), CK-101 subcritical
      assert.ok(nk.regime === 'Critical' && nk.flowLimited && nk.limiter === 'CK-102' && st.nodes.choke.regime === 'Subcritical', 'No Flow block at its pair capacity: ' + nk.regime);
      assert.near(nk.Pin, A.bean24.Pm, 1.0, 'Pm = the block at the pair capacity');
      assert.ok(nk.Pin <= st.nodes.choke.Pin + 1e-9, 'Pm never above the CK-101 inlet: ' + nk.Pin + ' / ' + st.nodes.choke.Pin);
      assert.ok(st.nodes.choke.P <= st.nodes.choke.Pin + 1e-9, 'CK-101 outlet (Pm + seg-3 loss) never above its inlet: ' + st.nodes.choke.P + ' / ' + st.nodes.choke.Pin);
      assert.near(st.f, A.bean24.QmaxPair / 10, 0.002, 'rate at the pair capacity');
      assert.ok(ids(st).indexOf('CHOKE2_LIMIT') >= 0 && ids(st).indexOf('CHOKE_LIMIT') < 0, 'CHOKE2_LIMIT (CHOKE_LIMIT suppressed)');
      assert.deepStrictEqual(finiteBad(J(st), J(S.NULLABLE)), [], 'finite');
      assert.ok(st.nodes.choke.dTjt + nk.dTjt <= 150 + 1e-9, 'cumulative J-T cap');
      // open again: Pm falls through the lag, PAH-102 clears (2 % below the limit)
      s.setFlow(flowWith(S, block('bean48')));
      adv(s, 300, 1);
      assert.ok(ids(s.getState()).indexOf('PAH_CK2') < 0 && ids(s.getState()).indexOf('CHOKE2_LIMIT') < 0, 'cleared');
      assert.near(s.getState().nodes.heaterChoke.Pin, A.bean48.Pm, 0.005 * A.bean48.Pm, 'back to 48/64');
    },
  },
  {
    name: 'WTSHC E1 U3: heater bypass takes CK-102 out of line (bypassed, alarms released) without a step; the ΔP decays on its 5 s lag; rig out / in continuous',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const base = mk(S, flowWith(S, null), { rig: {} });
      adv(base, 600, 1);
      const seg3Base = base.getState().segs[2].dP, seg3Blk = X.EXAMPLES.flowCk2.segs[0].dP, swap = Math.abs(seg3Base - seg3Blk);
      // heater bypass (host input wts_bypass → setFlow) with CK-102 pinched to 32/64 (alarms raised)
      const s = mk(S, flowWith(S, block('bean32')));
      adv(s, 600, 1);
      assert.ok(ids(s.getState()).indexOf('CHOKE2_LIMIT') >= 0, 'alarm before');
      const before = s.getState(), dP0 = fu(s).ck2dP, fi2 = before.fInst * before.fInst;
      s.setFlow(flowWith(S, block('bean32'), (f) => { f.inputs.bypass = true; f.heater.bypass = true; }));
      const after = s.getState(), nk = after.nodes.heaterChoke;
      assert.ok(nk.inRig && nk.bypassed && !nk.active && fu(s).CK2.act === false && fu(s).sel === 'base', 'bypassed with H-101');
      assert.strictEqual(fu(s).ck2dP, dP0, 'X.ck2dP kept through derive()');
      assert.ok(Math.abs(after.nodes.choke.P - before.nodes.choke.P) <= swap * fi2 + 1e-6, 'no step: only the seg-3 loss swaps (' +
        (after.nodes.choke.P - before.nodes.choke.P).toFixed(3) + ' psi, seg 3 ' + seg3Blk + ' → ' + seg3Base.toFixed(3) + ')');
      assert.deepStrictEqual(J(ids(after).filter((id) => X.Q_CK2.indexOf(id) >= 0)), [], 'alarms released (quiet Q_CK2)');
      assert.ok(maxJump(s) < 0.2 * dP0, 'no jump inside the next second');
      assert.near(fu(s).ck2dP, dP0 * Math.exp(-1 / 5), 0.01 * dP0, 'ΔP decays with τ 5 s');
      adv(s, 200, 1);
      assert.strictEqual(fu(s).ck2dP, 0, 'decayed to exactly 0');
      assert.near(s.getState().nodes.choke.P, base.getState().nodes.choke.P, 0.5, 'CK-101 outlet back on the CK-101-only law');
      // un-bypass: back in line, the lag rises from 0 (no step) to the steady ΔP
      const p1 = s.getState().nodes.choke.P;
      s.setFlow(flowWith(S, block('bean48')));
      assert.ok(Math.abs(s.getState().nodes.choke.P - p1) <= swap + 1e-6, 'back in line without a step');
      adv(s, 120, 1);
      assert.near(s.getState().nodes.heaterChoke.Pin, A.bean48.Pm, 0.005 * A.bean48.Pm, 'steady again');
      // rig out, then in again while the ΔP still decays: continuous both ways
      const q0 = s.getState().nodes.choke.P;
      assert.strictEqual(s.setRigup({ heaterChoke: false }), true);
      assert.ok(Math.abs(s.getState().nodes.choke.P - q0) <= swap + 1e-6, 'rig out: no step');
      adv(s, 2, 1);
      const q1 = s.getState().nodes.choke.P, d1 = fu(s).ck2dP;
      assert.ok(d1 > 0.5 * (A.bean48.Pm - X.EXAMPLES.flowCk2.Pout), 'still decaying ' + d1);
      assert.strictEqual(s.setRigup({ heaterChoke: true }), true);
      assert.ok(fu(s).ck2dP === d1 && Math.abs(s.getState().nodes.choke.P - q1) <= swap + 1e-6, 'rig in mid-decay: continues from the present ΔP');
      assert.ok(maxJump(s) < 0.2 * d1, 'no jump inside the next second');
      adv(s, 120, 1);
      assert.near(s.getState().nodes.heaterChoke.Pin, A.bean48.Pm, 0.005 * A.bean48.Pm, 'steady after re-entry');
      const m = s.getState().health.massErr;
      assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'mass balance ' + JSON.stringify(m));
    },
  },
  {
    name: 'WTSHC E1 U2 derive-survival: a bean2 change and then a Thtr change during the CK-102 transient keep X.ck2dP (no step); the pressure between the chokes rises smoothly',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const s = mk(S, flowWith(S, block('bean48')));
      adv(s, 300, 1);
      const p0 = s.getState().nodes.choke.P, d0 = fu(s).ck2dP;
      s.setFlow(flowWith(S, block('bean40')));                      // bean2 48 → 40 (−4/64 twice)
      assert.ok(fu(s).ck2dP === d0 && Math.abs(s.getState().nodes.choke.P - p0) < 0.01, 'bean change: lag kept, no step');
      adv(s, 2, 1);
      const d1 = fu(s).ck2dP, p1 = s.getState().nodes.choke.P;
      assert.ok(d1 > d0, 'rising ' + d0 + ' → ' + d1);
      s.setFlow(flowWith(S, block('bean40'), (f) => { f.inputs.Thtr = 140; f.heater.Tout = 140; }));   // another host input
      assert.ok(fu(s).ck2dP === d1 && Math.abs(s.getState().nodes.choke.P - p1) < 0.01, 'Thtr change: lag kept, no step');
      let prev = s.getState().nodes.heaterChoke.Pin, mono = true;
      for (let i = 0; i < 60; i++) { s.advance(1); const v = s.getState().nodes.heaterChoke.Pin; if (v < prev - 1e-6) mono = false; prev = v; }
      assert.ok(mono, 'monotone rise to the new steady value');
      assert.near(prev, A.bean40.Pm, 0.005 * A.bean40.Pm, 'Pm at 40/64');
      assert.ok(ids(s.getState()).indexOf('CK1_SUBCRIT') >= 0 && ids(s.getState()).indexOf('PAH_CK2') >= 0, 'CK-101 subcritical, PAH-102 (1,660 ≥ 1,296 psig)');
      assert.ok(ids(s.getState()).indexOf('CHOKE2_LIMIT') < 0, '40/64 passes 10.66 > 10.1: not limited');
    },
  },
  {
    name: 'WTSHC E1 cumulative J-T cap (D10): dry gas (wJT 1) — CK-101 + CK-102 stages ≤ 150 °F at every sample, 150 at steady; heater inlet as the CK-101-only walk',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work'), a = A.dryGas48;
      const dry = (f) => { f.inputs.Qo = 0; f.inputs.Qw = 0; f.choke.wJT = 1; f.choke.dTjt = 150; f.heater.Tin = a.baseTin; f.nodes[2].T = a.baseTin; f.heater.dutyMMBtuHr = a.baseDuty; };
      const b = block('bean48', (x) => { Object.assign(x, { Pin: a.Pm, dP: a.Pm - x.Pout, dTjt: a.dT2, Tin: 180 - a.dT1, Tout: a.TmOut });
        Object.assign(x.ck1, { Pout: a.Pm + 0.25, ratio: a.ratio, Tout: 180 - a.dT1, dTjt: a.dT1, wJT: 1 }); x.heater.dutyMMBtuHr = a.duty;
        x.heater.Tin = a.TmOut; x.nodes.heater.Tin = a.TmOut; x.nodes.heaterChoke.T = a.TmOut; });   // 'inlet': the coil inlet = the CK-102 outlet
      const s = mk(S, flowWith(S, b, dry), { cfg: { noise: { on: false } } });
      let worst = 0;
      for (let i = 0; i < 120; i++) { s.advance(5); const n = s.getState().nodes; worst = Math.max(worst, n.choke.dTjt + n.heaterChoke.dTjt); }
      const n = s.getState().nodes;
      assert.ok(worst <= 150 + 1e-9, 'cap ' + worst);
      assert.near(n.choke.dTjt + n.heaterChoke.dTjt, a.dTsum, 0.05, 'stages ' + n.choke.dTjt.toFixed(2) + ' + ' + n.heaterChoke.dTjt.toFixed(2));
      assert.near(n.choke.dTjt, a.dT1, 0.5, 'CK-101 stage'); assert.near(n.heaterChoke.dTjt, a.dT2, 0.5, 'CK-102 stage (the rest of the cap)');
      assert.near(n.heater.Tin, a.baseTin, a.tolTinAbs, 'heater inlet T = CK-101-only walk within 0.5 °F');
      // an empty start (rate ramps up from 0): the cap holds through the transient too
      const u = S.create(flowWith(S, b, dry), { seed: 3, config: NZ, rigup: { heaterChoke: true }, mode: 'empty' });
      let w2 = 0; for (let i = 0; i < 400; i++) { u.advance(2); const m = u.getState().nodes; w2 = Math.max(w2, m.choke.dTjt + m.heaterChoke.dTjt); }
      assert.ok(w2 <= 150 + 1e-9, 'empty-start cap ' + w2);
    },
  },
  {
    name: 'WTSHC E1 determinism (same seed → same state, noise on) and dt 1 vs dt 10 over a bean2 pinch (self-test 6 tolerances)',
    wp: WP_E1,
    opts: false,
    timeoutMs: 300000,
    run(app, assert) {
      const S = X.loadEngine('work');
      const run = (dt, cfg) => {
        const s = mk(S, flowWith(S, block('bean48')), { seed: 99, cfg: cfg || NZ });
        adv(s, 600, dt); s.setFlow(flowWith(S, block('bean32'))); adv(s, 1200, dt);
        s.setFlow(flowWith(S, block('bean48'), (f) => { f.inputs.bypass = true; })); adv(s, 600, dt);
        return s;
      };
      const a = run(2, {}), b = run(2, {});
      assert.strictEqual(JSON.stringify(a.getState()), JSON.stringify(b.getState()), 'bit-identical with noise on');
      const s1 = run(1), s10 = run(10), x = s1.getState(), y = s10.getState();
      assert.near(x.t, y.t, 1e-6, 'clock');
      assert.near(y.cum.oilIn_stb / x.cum.oilIn_stb, 1, 1e-3, 'cum oil');
      assert.near(x.sep.P, y.sep.P, 1, 'Psep');
      assert.near(x.nodes.choke.P, y.nodes.choke.P, 1, 'CK-101 outlet');
      assert.near(fu(s1).ck2dP, fu(s10).ck2dP, 1e-6 + 0.001 * fu(s1).ck2dP, 'ΔP lag');
      // mid-transient check (dt 1 vs dt 10 at the same clock, 30 s after the pinch)
      const m1 = mk(S, flowWith(S, block('bean48'))), m10 = mk(S, flowWith(S, block('bean48')));
      adv(m1, 600, 1); adv(m10, 600, 10);
      m1.setFlow(flowWith(S, block('bean32'))); m10.setFlow(flowWith(S, block('bean32')));
      adv(m1, 30, 1); adv(m10, 30, 10);
      assert.near(m10.getState().nodes.heaterChoke.Pin, m1.getState().nodes.heaterChoke.Pin, 0.01 * m1.getState().nodes.heaterChoke.Pin, 'Pm 30 s after the pinch');
      assert.deepStrictEqual(J(ids(m10.getState()).sort()), J(ids(m1.getState()).sort()), 'same alarms');
    },
  },
  {
    name: 'WTSHC E1 old flows: CK-102 in without flow.ck2 (note, ΔP 0), a skipped block (no gas rate), a malformed block — no throw, finite, v1.4.0 law',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const ref = mk(S, flowWith(S, null), { rig: {} }); adv(ref, 600, 10);
      const cases = [['no block', null, X.RIG_NOTES.ck2NoBlock], ['skipped', X.EXAMPLES.flowCk2Skipped, X.RIG_NOTES.ck2SkippedNote]];
      cases.forEach(([nm, blk, note]) => {
        const s = mk(S, flowWith(S, blk)); adv(s, 600, 10);
        const st = J(s.getState()), nk = st.nodes.heaterChoke;
        assert.ok(nk.inRig && !nk.active && nk.note === note && fu(s).CK2.act === false && fu(s).ck2dP === 0, nm + ': ' + JSON.stringify(nk));
        assert.strictEqual(st.nodes.choke.P, ref.getState().nodes.choke.P, nm + ': CK-101 outlet = v1.4.0 law');
        assert.deepStrictEqual(finiteBad(st, J(S.NULLABLE)), [], nm + ': finite');
        assert.ok(X.checkShape('nodes.heaterChoke', nk, { strict: true }).ok, nm + ': shape');
      });
      [{}, { v: 1, bean: 'x', Pin: 'y', segs: 'z', nodes: 3, ck1: null }, { v: 1, regime: 'No Flow', noFlow: true }].forEach((blk, i) => {
        const s = mk(S, flowWith(S, blk)); adv(s, 300, 10);
        const st = J(s.getState());
        assert.deepStrictEqual(finiteBad(st, J(S.NULLABLE)), [], 'malformed ' + i + ': finite');
        assert.ok(st.nodes.heaterChoke.Pin >= st.nodes.heaterChoke.P - 1e-9 && st.nodes.heaterChoke.Pin <= st.nodes.choke.Pin + 1e-9, 'malformed ' + i + ': Phi ≤ Pm ≤ PB');
      });
      // the flow changes from a block to none while in line: the lag decays to 0, the note appears
      const s = mk(S, flowWith(S, block('bean48'))); adv(s, 300, 10);
      s.setFlow(flowWith(S, null));
      assert.ok(fu(s).CK2.act === false && s.getState().nodes.heaterChoke.note === X.RIG_NOTES.ck2NoBlock && fu(s).ck2dP > 0, 'block gone: note, lag decaying');
      adv(s, 300, 10);
      assert.strictEqual(fu(s).ck2dP, 0);
    },
  },

  {
    name: 'WTSHC E1 rig-up: CK-102 needs H-101, strict true, 11-character signature, extras; in line only through the heater (H-101 out / bypass → not active)',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const k = S.normRigup({ heaterChoke: true });
      assert.ok(k.sig === X.SIG_DEFAULT.slice(0, 10) + '1' && k.sig.length === 11 && k.extras.join() === 'heaterChoke' && k.full === true, 'in: ' + JSON.stringify(k));
      ['yes', 1, 'true', {}, null, false].forEach((v) => assert.strictEqual(S.normRigup({ heaterChoke: v }).rig.heaterChoke, false, 'strict true: ' + JSON.stringify(v)));
      const kh = S.normRigup({ heaterChoke: true, heater: false });
      assert.ok(kh.rig.heaterChoke === false && kh.notes.indexOf(X.RIG_NOTES.heaterChokeNeedsHeater) >= 0, 'needs H-101: ' + JSON.stringify(kh.notes));
      // H-101 out of the rig-up: CK-102 out too (not active, no CK-102 alarm), the request kept for when H-101 comes back
      const s = mk(S, flowWith(S, block('bean32')));
      adv(s, 60, 1);
      assert.ok(fu(s).CK2.act === true && ids(s.getState()).indexOf('CHOKE2_LIMIT') >= 0, 'in line, limited');
      assert.strictEqual(s.setRigup({ heater: false }), true);
      adv(s, 2, 1);
      let st = s.getState();
      assert.ok(st.rigup.heaterChoke === false && !st.nodes.heaterChoke.inRig && !st.nodes.heaterChoke.active && fu(s).CK2.act === false, 'H-101 out');
      assert.deepStrictEqual(J(ids(st).filter((id) => X.Q_CK2.indexOf(id) >= 0)), [], 'CK-102 alarms released');
      assert.strictEqual(s.setRigup({ heater: true }), true);
      adv(s, 120, 1);
      st = s.getState();
      assert.ok(st.rigup.heaterChoke === true && st.nodes.heaterChoke.active && fu(s).CK2.act === true, 'H-101 back: CK-102 back in line');
      assert.ok(ids(st).indexOf('CHOKE2_LIMIT') >= 0, 'its alarm again');
    },
  },
  {
    name: 'WTSHC E1 V-101 out with flow.sepBy.ck2: CK-102 in line on the walk from the destination (Phi from the destination law, Pm, CK-101 outlet = Pm + seg-3), finite, balanced',
    wp: WP_E1,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const sb = X.EXAMPLES.flowSepBy, k2 = X.EXAMPLES.flowCk2, Phi = sb.nodes.heater.P + 5;
      // a block consistent with the destination walk: CK-102 critical (Pm as at 48/64), its outlet = H-101 inlet of the sepBy walk
      Object.assign(k2, { Pout: Phi, dP: k2.Pin - Phi });
      k2.nodes.heaterChoke.P = Phi; k2.nodes.heater = { P: sb.nodes.heater.P, T: sb.nodes.heater.T, Tin: k2.Tout, duty: k2.heater.dutyMMBtuHr };
      k2.segs[1] = J(sb.segs[1]);
      sb.ck2 = k2;
      const s = mk(S, flowWith(S, null, (f) => { f.sepBy = sb; }), { rig: { separator: false, heaterChoke: true } });
      const f0 = fu(s);
      assert.ok(f0.sel === 'sepBy+ck2' && f0.CK2.act === true && f0.Phi_ss === Phi, 'selection ' + f0.sel + ' Phi ' + f0.Phi_ss);
      adv(s, 1800, 5);
      const st = J(s.getState()), nk = st.nodes.heaterChoke, fi2 = st.fInst * st.fInst;
      assert.ok(nk.active && !nk.bypassed && nk.note === '', 'in line');
      // CK-102 outlet and H-101 outlet both on the destination law (pDown + (P_ss − Psep_ss)·fi²): they differ by the heater drop
      assert.near(nk.P - st.nodes.heater.P, (Phi - sb.nodes.heater.P) * fi2, 1e-6, 'CK-102 outlet − H-101 outlet = the 5 psi heater drop');
      assert.ok(nk.P < 0.1 * k2.Pin && st.nodes.heater.P > sb.P0_psig, 'low-pressure side on the destination walk: ' + nk.P.toFixed(2));
      assert.near(nk.Pin, k2.Pin, 0.01 * k2.Pin, 'Pm');
      assert.near(st.nodes.choke.P, nk.Pin + st.segs[2].dP, 1e-6, 'CK-101 outlet = Pm + seg-3 loss');
      assert.ok(nk.Pin < st.nodes.choke.Pin, 'below the CK-101 inlet');
      assert.deepStrictEqual(finiteBad(st, J(S.NULLABLE)), [], 'finite');
      const m = st.health.massErr;
      assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'mass balance ' + JSON.stringify(m));
    },
  },
];

module.exports = HOST.concat(ENGINE);
