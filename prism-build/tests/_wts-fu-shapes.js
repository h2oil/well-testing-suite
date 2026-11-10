// prism-build/tests/_wts-fu-shapes.js — Simulator follow-up executable contract (WP0, FROZEN).
//
// Plan: docs/SIM-FOLLOWUP-PLAN.md §7 (interfaces, exact), §7.3 (this fixture), §3 (rig-up model), §4 (host walk), §5 / §6
// (engine), D12 (alarms), D17 (labels), §4.6 / §6.4 (worked numbers = test anchors, re-computed at WP0 with a prototype
// wtsWalk and a prototype cushion step; values in the WP0 notes of the plan). Changes only through the lead, together with
// the plan. Items: CK-102 heater inlet choke (optional rig-up item, out by default), the V-101-out bypass destination
// (burner / flare line or production line) and the cushion-unload scenario. Field units throughout.
//
// Exports
//   PLAN, VERSION_V331 '1.4.0', VERSION_NEW '1.5.0'
//   RIG_KEYS_V331 (10) / RIG_KEYS (11, signature order, append only) / RIG_ORDER (display = process order)
//   RIG_ITEM_NEW (the RIG_ITEMS row of CK-102), RIG_DEFAULTS, RIG_OPTIONAL, SIG_V331, SIG_DEFAULT, GETRIGUP_DEFAULT_JSON,
//   RIG_TXT_NEW, RIG_TXT_SEPARATOR, RIG_NOTES (plain-text notes of §3.2 / §3.4 / §6.2; {P} = the line pressure)
//   STEP_ORDER, STEP_V331, STEP_COMBOS (§3.5), stepForRef(rig)
//   COUNT_RULE, COUNT_SITES (§3.6: the grep rule and its hits at WP0, each 'rig' (changes, with the owner) or 'not')
//   LABELS (D17: one label per item, for WP-C, WP-L and WP-HC), INPUTS (§4.1), WARN_TEXTS (§4.5 host), ALARM_TEXTS (§5.5 /
//   §6.2 / §6.3 engine), textRe(template) → RegExp ({x} placeholders match any number or text)
//   TAGS_NEW, NAMES_NEW, ALARM_TAGS_NEW, ALARMS (id → {tag, sev, eq, esd?}), ALARM_IDS (11), Q_CK2, Q_SEPBY, Q_CUSH,
//   LOG_EVENT_IDS_NEW, CUSHION_PHASES, EVENT_CUSHION_EXAMPLE
//   HIST_KEYS_V331, HIST_KEYS_NEW, HIST_KEYS, NODE_IDS_V331, NODE_IDS (heaterChoke = index 10), SEG_COUNT (6)
//   NULLABLE_NEW, CUM_NEW, SNAP_CUM_NEW
//   DEFAULTS_NEW (§5.1 / §6.1: heaterChoke, sep.bypass, cushion), FEATURES (D14), FLOW_SIM_NEW, SAMPLE_FLOW_SIM_NEW,
//   SAMPLE_FLOW_SIM_KEYS (the 9 keys after v3.3: 7 of v3.3.1 + 2), API_STATIC_NEW, API_INSTANCE_NEW
//   DESIGN_P_CK2, P_FLARE_HDR, CUSHION_TUBING (the four tubing sizes of the Scenarios form)
//   BASE_FIELDS_OMIT, baseFields(flow) (§9.2; the golden rule of wts-calc-golden.js)
//   ANCHORS_CK2, ANCHORS_CUSH (with tolerances), near(anchor, value), qLcapRef, dEqRef, cushionStartRef (closed forms of §6.3)
//   ACTIONS (3D → 38 payloads)
//   EXAMPLES (lazy deep copies): flowCk2, flowCk2Skipped, flowSepBy, nodesHeaterChoke, nodesHeaterChokeOut, cushion,
//            cushionOff, sepBy, sepByLine
//   SHAPE_NAMES, checkShape(name, obj, {strict}) → {ok, errors}
//   fakeFuSnapshot(base, {ck2, bypassed, pos, sepOut, flareOut, dest, P, cushion}) → a snapshot with every new path
//   loadEngine(which) (re-export of _wts-equip-shapes.js: 'v33', 'v331', 'work' or a source string)
//
// Conventions encoded here
//   • Units: psig (pressures), psi (ΔP), °F, MMscf/d (QmaxMMscfd), bbl, bbl/d (rates in the snapshot), bbl/ft (tubing
//     capacity), ft, s (engine time), 64ths of an inch (beans).
//   • Null rule (as v3.3.1): a snapshot number is finite; null only on the NULLABLE paths (here: inputs.bean2, inputs.ck2Pos,
//     cushion.tBreak). Never NaN, ±Infinity or undefined.
//   • flow.ck2 / flow.sepBy warnings are {t, msg} (§4.4; the base flow.warnings keep {t, m}).
//   • Example values: ANCHORS_* are the asserted numbers; every other number in EXAMPLES is illustrative (consistent with
//     the prototype at the defaults) and is used for shape, not value, checks.
//   • ES5 style (var / function; no arrow functions, no optional chaining, no nullish coalescing).
'use strict';

var EQ = require('./_wts-equip-shapes.js');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
  }
  return o;
}
function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

// ─── versions ────────────────────────────────────────────────────────────────
var PLAN = 'docs/SIM-FOLLOWUP-PLAN.md';
var VERSION_V331 = '1.4.0';
var VERSION_NEW = '1.5.0';

// ─── rig-up (§3.1, §3.2, D1, D4) ─────────────────────────────────────────────
var RIG_KEYS_V331 = EQ.RIG_KEYS.slice();
var RIG_KEYS = RIG_KEYS_V331.concat(['heaterChoke']);
var RIG_ORDER = ['esd', 'desander', 'choke', 'heaterChoke', 'heater', 'separator', 'surge', 'surge2', 'gauge', 'pump', 'flare'];
var RIG_ITEM_NEW = { key: 'heaterChoke', tag: 'CK-102', name: 'Heater inlet choke', optional: true, def: false, needs: 'heater',
  why: 'Optional: a second adjustable choke on the H-101 inlet. It takes part of the pressure drop and is in line only while the stream goes through the heater.' };
var RIG_DEFAULTS = { esd: true, choke: true, heater: true, separator: true, surge: true, gauge: true, pump: true, flare: true,
  desander: false, surge2: false, heaterChoke: false };
var RIG_OPTIONAL = ['desander', 'surge2', 'heaterChoke'];
var SIG_V331 = EQ.SIG_DEFAULT_V331;          // '1111111100'
var SIG_DEFAULT = '11111111000';
var GETRIGUP_DEFAULT_JSON = JSON.stringify(RIG_DEFAULTS);
var RIG_TXT_NEW = { heaterChoke: ['CK-102', 'out of the rig-up', 'in line on the H-101 inlet'] };
// RIG_TXT.separator by destination (§6.2): [tag, out text, in text]; {P} = cfg.sep.bypass.P_psig. 'flare' keeps the v3.3.1
// (engine 1.4.0) text, so the log and 'rigup' event text of a mid-run setRigup are v3.3.1 exactly (wts-fu-identity (1))
var RIG_TXT_SEPARATOR = {
  flare: ['V-101', 'bypassed (well stream to the flare / burner)', 'back in line'],
  line: ['V-101', 'bypassed (well stream to the production line at {P} psig through NRV-501 / XV-501)', 'back in line'] };
var RIG_NOTES = {
  heaterChokeNeedsHeater: 'CK-102 sits on the H-101 inlet, so with H-101 out of the rig-up CK-102 is out too.',
  sepFlareOutLine: 'V-101 and FS-401 out: whole stream to the production line at {P} psig (non-return valve NRV-501 and isolation valve XV-501 at the tie-in). Relief and vent gas of the tanks still in the rig-up goes to vent.',
  forcedFlare: 'No separator and no flare would leave the well stream nowhere to go, so FS-401 stays in the rig-up.',   // v3.3.1 text (l.173), kept for dest 'flare'
  bypassedWithHeater: 'Bypassed with H-101',                // 38 card / rig row while CK-102 is in the rig-up but not in line
  heaterBypassConfirm: 'CK-102 goes out of line with it',   // added to 38's heater bypass confirm text while CK-102 is in
  flareSwitchLine: 'relief of the tanks goes to vent',      // 38 rig card: FS-401 switch with V-101 out and dest 'line'
  sepByNoBlockFlare: 'the destination of this flow differs from the engine setting; the flow block wins',   // snap.sepBy.note (§6.2), wording free
  shutInLine: 'held at line pressure by NRV-501: lower the line pressure below the PSHH-104 set point, or go to the burner line, to reset',   // review round: no XV-501 control is modelled
  ck2NoBlock: 'no heater-choke data in this flow (in line, ΔP 0)',
  ck2SkippedNote: 'no gas rate: the two-stage gas walk does not apply' };

// ─── step numbers (§3.5) ─────────────────────────────────────────────────────
var STEP_ORDER = ['wellhead', 'esd', 'desander', 'choke', 'heaterChoke', 'heater', 'separator', 'flare', 'surge', 'surge2', 'gauge', 'pump'];
var STEP_V331 = clone(EQ.STEP_V33);          // the default rig-up keeps ①–⑨
var OPT_STEP = { desander: true, heaterChoke: true, surge2: true };
function circled(n) { return String.fromCharCode(0x2460 + n - 1); }
function stepForRef(rig) {
  var r = rig || {}, out = {}, n = 0;
  STEP_ORDER.forEach(function (k) {
    if (OPT_STEP[k] === true && r[k] !== true) return;
    n++; out[k] = circled(n);
  });
  return out;
}
var STEP_COMBOS = [
  { name: 'none (default)', rig: {}, step: STEP_V331 },
  { name: 'CK-102 in', rig: { heaterChoke: true },
    step: { wellhead: '①', esd: '②', choke: '③', heaterChoke: '④', heater: '⑤', separator: '⑥', flare: '⑦', surge: '⑧', gauge: '⑨', pump: '⑩' } },
  { name: 'CK-102 + DS-101 in', rig: { heaterChoke: true, desander: true },
    step: { wellhead: '①', esd: '②', desander: '③', choke: '④', heaterChoke: '⑤', heater: '⑥', separator: '⑦', flare: '⑧', surge: '⑨', gauge: '⑩', pump: '⑪' } },
  { name: 'all three in', rig: { heaterChoke: true, desander: true, surge2: true },
    step: { wellhead: '①', esd: '②', desander: '③', choke: '④', heaterChoke: '⑤', heater: '⑥', separator: '⑦', flare: '⑧', surge: '⑨', surge2: '⑩', gauge: '⑪', pump: '⑫' } }];

// ─── hard-coded counts (§3.6) ────────────────────────────────────────────────
// COUNT_RULE: the grep of §3.6, first run on the WP0 tree (sim-fu at WP0). COUNT_SITES: every hit. kind 'rig' = a rig-up /
// node / signature count that moves with CK-102 (owner = the WP that changes it), 'done' = already changed (owner WP0 or
// WP-E0), 'not' = not a rig count (left alone), 'frozen' = a frozen copy (never edited). Line numbers and texts are those of
// the post-WP-E0 tree (re-recorded by the lead on sim-fu-found). WP-E0 sites the change took out of the grep (counts now
// derived from RIG_KEYS / SIG_DEFAULT) keep their entry with the line of the changed check. Open: the WP-3D sites.
var COUNT_RULE = {
  pattern: "'1111111[01]*'|\\{10\\}|\\{9\\}|length, ?(9|10)\\b|=== ?(9|10)\\b|\\b(9|10) (rig|items|keys|nodes)",
  files: ['prism-build/tests/*.js', 'prism-build/wts3d-test.js', 'prism-build/31-wts-sim.js', 'prism-build/32-wts-3d.js', 'prism-build/38-wts-live.js'] };
var COUNT_SITES = /*COUNT_SITES_BEGIN*/[
  {file: "prism-build/tests/_wts-equip-shapes.js",line: 12,kind: "done",text: "//   SIM-FOLLOWUP WP0), SIG_DEFAULT_V331 ('1111111100'), sigDefaultOf(S) (by S.VERSION), GETRIGUP_DEFAULT_JSON",owner: "WP0",change: "SIG_DEFAULT 11 characters, SIG_DEFAULT_V331 + sigDefaultOf(S); regex {10,}, rigKeys, tail /^0*$/ (WP0)"},
  {file: "prism-build/tests/_wts-equip-shapes.js",line: 81,kind: "not",text: "var SIG_V33 = '11111111';",change: "the v3.3 8-character signature (a historical constant)"},
  {file: "prism-build/tests/_wts-equip-shapes.js",line: 85,kind: "done",text: "var SIG_DEFAULT_V331 = '1111111100';",owner: "WP0",change: "SIG_DEFAULT 11 characters, SIG_DEFAULT_V331 + sigDefaultOf(S); regex {10,}, rigKeys, tail /^0*$/ (WP0)"},
  {file: "prism-build/tests/_wts-equip-shapes.js",line: 86,kind: "done",text: "var SIG_DEFAULT = '11111111000';",owner: "WP0",change: "SIG_DEFAULT 11 characters, SIG_DEFAULT_V331 + sigDefaultOf(S); regex {10,}, rigKeys, tail /^0*$/ (WP0)"},
  {file: "prism-build/tests/_wts-sim-v33.js",line: 1754,kind: "frozen",text: "rigup: { esd: true, choke: true, heater: true, separator: true, surge: true, gauge: true, pump: true, flare: t",change: "frozen copy, never edited"},
  {file: "prism-build/tests/_wts-sim-v331.js",line: 1944,kind: "frozen",text: "full: true, sig: '1111111100', notes: [], extras: [], refused: '', v: 0 },",change: "frozen copy, never edited"},
  {file: "prism-build/tests/buildup-benchmark.test.js",line: 92,kind: "not",text: "assert.strictEqual(SNAPSHOT.length, 10, 'ten acceptance seeds');",change: "not a rig count"},
  {file: "prism-build/tests/buildup-integration.test.js",line: 112,kind: "not",text: "assert.strictEqual(ok.length, 9, 'interpreted build-ups: ' + a.tests.map((t) => t.id + ':' + t.status).join(' ",change: "not a rig count"},
  {file: "prism-build/tests/buildup-synth.test.js",line: 161,kind: "not",text: "assert.strictEqual(ev.filter((e) => e.kind === 'shutin').length, 9, '9 analysable build-ups');",change: "not a rig count"},
  {file: "prism-build/tests/calc-disp-scale.test.js",line: 156,kind: "not",text: "assert.ok(c2.exceed.h2s.idlh.reached && c2.limits.h2sStel === 10, 'custom IDLH, default STEL');",change: "not a rig count"},
  {file: "prism-build/tests/calc-g2.test.js",line: 200,kind: "not",text: "assert.strictEqual(cOpts.length, 32, '32 casing rows'); assert.strictEqual(tOpts.length, 9, '9 tubing rows');",change: "not a rig count"},
  {file: "prism-build/tests/cheminj-engine.test.js",line: 113,kind: "not",text: "assert.ok(seenZ.length && seenZ.every((s) => s[0] === 10 && s[1] === true), '100,000 ppm → 10 mol %');",change: "not a rig count"},
  {file: "prism-build/tests/cheminj-foundation.test.js",line: 333,kind: "not",text: "assert.strictEqual(C.plungers.length, 10, 'ten plunger sizes');",change: "not a rig count"},
  {file: "prism-build/tests/historian.test.js",line: 361,kind: "not",text: "for (let i = 0; i < 20; i++) { t.push(i * 1000); v.push(i === 8 || i === 9 ? null : Math.sin(i)); q.push(i ===",change: "not a rig count"},
  {file: "prism-build/tests/historian.test.js",line: 451,kind: "not",text: "for (let i = 0; i < 50; i++) s.push({ tag: 'A', unit: 'bar', t: T0 - 50000 + i * 1000, v: i / 4, q: i === 10 ?",change: "not a rig count"},
  {file: "prism-build/tests/sweep-fixes-v31.test.js",line: 50,kind: "not",text: "assert.ok(!/\\bpsig?\\b|ft\\/s|MMBtu\\/hr/.test(res.replace(/T \\(°F\\)/, '')), 'no imperial units left: ' + (res.ma",change: "not a rig count"},
  {file: "prism-build/tests/sweep-fixes-v31.test.js",line: 75,kind: "not",text: "assert.ok(!IMPERIAL.test(t), id + ' card: ' + (t.match(new RegExp('.{25}(' + IMPERIAL.source + ').{10}')) || [",change: "not a rig count"},
  {file: "prism-build/tests/wp14-fieldtools.test.js",line: 177,kind: "not",text: "assert.equal(r.flagged.length, 9, 'flagged: ' + r.flagged.length);",change: "not a rig count"},
  {file: "prism-build/tests/wp14-fieldtools.test.js",line: 188,kind: "not",text: "assert.equal(r2.flagged.length, 9);",change: "not a rig count"},
  {file: "prism-build/tests/wts-desander.test.js",line: 111,kind: "done",text: "assert.ok(d.inRig && st.rigup.desander && st.rigup.sig === X.SIG_DEFAULT.slice(0, 8) + '1' + X.SIG_DEFAULT.sli",owner: "WP-E0",change: "DS-101 in: '11111111100' (derive from SIG_DEFAULT) — done at WP-E0"},
  {file: "prism-build/tests/wts-divert-safety.test.js",line: 190,kind: "not",text: "if (i === 10) { assert.strictEqual(T[1].pos, 1, 'B open at 10 s'); assert.strictEqual(T[0].state, 'filling', '",change: "not a rig count"},
  {file: "prism-build/tests/wts-divert-safety.test.js",line: 279,kind: "not",text: "assert.ok(prefs.ctl && prefs.ctl.gauge.strokeS === 9 && prefs.ctl.gauge.allowInterrupt === true, 'saved: ' + J",change: "not a rig count"},
  {file: "prism-build/tests/wts-divert-safety.test.js",line: 283,kind: "not",text: "assert.ok(c2.gauge.strokeS === 9 && c2.gauge.allowInterrupt === true, 'restored after reload');",change: "not a rig count"},
  {file: "prism-build/tests/wts-equipment-views.test.js",line: 387,kind: "not",text: "assert.ok(!IMPERIAL.test(ct), id + ' card has no imperial unit: ' + (ct.match(new RegExp('.{25}(' + IMPERIAL.s",change: "not a rig count"},
  {file: "prism-build/tests/wts-equipment-views.test.js",line: 916,kind: "not",text: "assert.ok(/kPa/.test(ct) && !IMP.test(ct), id + ' card metric: ' + (ct.match(new RegExp('.{25}(' + IMP.source ",change: "not a rig count"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 206,kind: "done",text: "assert.ok(X.identityDiff({ rigup: { sig: X.SIG_DEFAULT_V331 } }, { rigup: { sig: '11111111001' } }).length ===",owner: "WP0",change: "new sig-rule case (WP0)"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 207,kind: "not",text: "assert.ok(X.identityDiff({ rigup: { sig: X.SIG_V33 } }, { rigup: { sig: '1111111110' } }).length === 1, 'sig r",change: "a v3.3 → 10-character sig-rule case (stays valid)"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 297,kind: "done",text: "assert.strictEqual(f.rigup.sig.length, 10);",owner: "WP-E0",change: "fakeEquipSnapshot sig length: 10 stays (the equip fixture keeps its 10 keys) or derive from RIG_KEYS.length — done at WP-E0"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 335,kind: "done",text: "assert.ok(both.sig === sigOf(S, { desander: true, surge2: true }) && both.full === true && J(both.extras).join",owner: "WP-E0",change: "both in → '11111111110' (11 characters) — done at WP-E0"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 337,kind: "done",text: "assert.strictEqual(JSON.stringify(sim.getRigup()), FU.GETRIGUP_DEFAULT_JSON, 'getRigup default (11 keys)');",owner: "WP-E0",change: "getRigup default: 11 keys (_wts-fu-shapes GETRIGUP_DEFAULT_JSON) — done at WP-E0"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 547,kind: "done",text: "assert.strictEqual(I.rigItems().length, 11);",owner: "WP-E0",change: "11 rig items — done at WP-E0"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 557,kind: "done",text: "assert.ok(Object.keys(w).length === 11 && w.heater === false && w.desander === false && w.surge2 === false && ",owner: "WP-E0",change: "writeRig stores all 11 keys — done at WP-E0"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 562,kind: "done",text: "assert.strictEqual(s331.getState().rigup.sig, sigOf(S, { desander: true }), 'round trip v3.3.1 → DS-101 in');",owner: "WP-E0",change: "'11111111100' (DS-101 in, 11 characters) — done at WP-E0"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 580,kind: "done",text: "assert.ok(n.length === 11 && n.every((x) => isFinite(x.P) && isFinite(x.T)) && n[8].nm === 'Desander' && n[9].",owner: "WP-E0",change: "liveNodes 11 — done at WP-E0"},
  {file: "prism-build/tests/wts-equipment.test.js",line: 632,kind: "done",text: "assert.ok(saved.surge2 === true && Object.keys(saved).length === 11, 'saved request (11 keys): ' + JSON.string",owner: "WP-E0",change: "a saved request stores 11 keys — done at WP-E0"},
  {file: "prism-build/tests/wts-fu-foundation.test.js",line: 51,kind: "done",text: "assert.ok(k.sig === '11111111001' && k.full && J(k.extras).join() === 'heaterChoke', 'CK-102 in: ' + k.sig);",owner: "WP-E0",change: "new v1.5.0 check with an 11-character CK-102-in signature (WP-E0)"},
  {file: "prism-build/tests/wts-fu-foundation.test.js",line: 72,kind: "done",text: "assert.strictEqual(sim.getState().rigup.sig, '11111111001');",owner: "WP-E0",change: "new v1.5.0 check with an 11-character CK-102-in signature (WP-E0)"},
  {file: "prism-build/tests/wts-fu-identity.test.js",line: 61,kind: "not",text: "if (!(b.length === 10 || (b.length === 11 && b.charAt(10) === '0'))) return 'sig tail \"' + b.slice(10) + '\" (w",change: "this WP0 test: the v3.3.1 → 11-character sig rule and fixture counts"},
  {file: "prism-build/tests/wts-fu-identity.test.js",line: 200,kind: "not",text: "assert.ok(EQ.identityDiff({ rigup: { sig: X.SIG_V331 } }, { rigup: { sig: '11111111001' } }).length === 1, 'id",change: "this WP0 test: the v3.3.1 → 11-character sig rule and fixture counts"},
  {file: "prism-build/tests/wts-fu-identity.test.js",line: 221,kind: "not",text: "assert.strictEqual(X.SAMPLE_FLOW_SIM_KEYS.length, 9, '9 flow.sim keys after the v3.3 five');",change: "this WP0 test: the v3.3.1 → 11-character sig rule and fixture counts"},
  {file: "prism-build/tests/wts-rigup.test.js",line: 121,kind: "done",text: "assert.ok(st.rigup.full && st.rigup.sig === FU.SIG_DEFAULT && st.rigup.notes.length === 0 && st.rates.separate",owner: "WP-E0",change: "default sig 11 characters (derive from SIG_DEFAULT) — done at WP-E0"},
  {file: "prism-build/tests/wts-rigup.test.js",line: 133,kind: "done",text: "assert.strictEqual(S.normRigup(app.toWin({ desander: 'true', surge2: 1, heaterChoke: 'yes' })).sig, FU.SIG_DEF",owner: "WP-E0",change: "default sig 11 characters (derive from SIG_DEFAULT) — done at WP-E0"},
  {file: "prism-build/tests/wts-rigup.test.js",line: 135,kind: "done",text: "assert.strictEqual(S.normRigup(app.toWin({ esd: true, choke: true, heater: true, separator: true, surge: true,",owner: "WP-E0",change: "default sig 11 characters (derive from SIG_DEFAULT) — done at WP-E0"},
  {file: "prism-build/tests/wts-surge2.test.js",line: 70,kind: "done",text: "assert.ok(sb.surge2.inRig && !sb.surge2.inlet && sb.surge2.frac === 0 && sb.rigup.sig === X.SIG_DEFAULT.slice(",owner: "WP-E0",change: "T-202 in: '11111111010' (derive from SIG_DEFAULT) — done at WP-E0"},
  {file: "prism-build/wts3d-test.js",line: 204,kind: "done",text: "// v1.5.0: 11 items (DS-101 / T-202 / CK-102 optional, out by default); the RIGUP key set = RIG_KEYS; sig appe",owner: "WP-E0",change: "comment and RIGUP.length 11 — done at WP-E0"},
  {file: "prism-build/wts3d-test.js",line: 210,kind: "done",text: "if (!(st.rigup.full && st.rigup.sig === S.RIG_KEYS.map((k) => S.RIG_DEFAULTS[k] ? '1' : '0').join('') && st.ri",owner: "WP-E0",change: "default sig 11 characters — done at WP-E0"},
  {file: "prism-build/wts3d-test.js",line: 585,kind: "rig",text: "fin(fe, 'fe'); if (!(fe.rig.desander && fe.rig.surge2 && fe.ds.phase === 'held' && fe.rigSig === '11111111')) ",owner: "WP-3D",change: "3D rigSig 9 characters once heaterChoke joins RIG_GROUPS"},
  {file: "prism-build/wts3d-test.js",line: 588,kind: "rig",text: "if (!(n.rigSig === '11111111' && n.ds.phase === 'flush' && n.ds.open && n.surge2.inRig && n.nodes.desander.Pin",owner: "WP-3D",change: "3D rigSig 9 characters once heaterChoke joins RIG_GROUPS"},
  {file: "prism-build/wts3d-test.js",line: 600,kind: "rig",text: "if (typeof s.setRigup === 'function' && s.setRigup({ desander: true, surge2: true })) { s.advance(20); const m",owner: "WP-3D",change: "3D rigSig 9 characters once heaterChoke joins RIG_GROUPS"},
  {file: "prism-build/wts3d-test.js",line: 739,kind: "not",text: "return p.mode === '3d' && p.speed === 10 && p.labels === 'all' && p.overlay === 'phase' && p.quality === 'auto",change: "speed preference"},
  {file: "prism-build/wts3d-test.js",line: 756,kind: "done",text: "// v1.5.0: 11 items; a request equal to RIG_DEFAULTS stores no key, any other request stores all 11 keys (disp",owner: "WP-E0",change: "stored keys 11 (38 persistence) — done at WP-E0"},
  {file: "prism-build/wts3d-test.js",line: 902,kind: "done",text: "const n = L.liveNodes(real()); return Array.isArray(n) && n.length === 11 && n.every(x => isFinite(x.P) && isF",owner: "WP-E0",change: "liveNodes 11 — done at WP-E0"},
  {file: "prism-build/31-wts-sim.js",line: 2111,kind: "done",text: "heaterChoke: false, full: true, sig: '11111111000', notes: [], extras: [], refused: '', v: 0 },",owner: "WP-E0",change: "initial snapshot rigup sig 11 characters — done at WP-E0"},
  {file: "prism-build/31-wts-sim.js",line: 4662,kind: "done",text: "assert(d.sig === '11111111000' && d.full && d.extras.length === 0 && d.notes.length === 0 && !d.rig.desander &",owner: "WP-E0",change: "self-test default sig 11 characters — done at WP-E0"},
  {file: "prism-build/31-wts-sim.js",line: 4664,kind: "done",text: "assert(v33.sig === '11111111000', 'an 8-key (v1.3.0) request leaves the optional items out');",owner: "WP-E0",change: "self-test default sig 11 characters — done at WP-E0"},
  {file: "prism-build/31-wts-sim.js",line: 4670,kind: "done",text: "assert(S.RIG_OPTIONAL.join() === 'desander,surge2,heaterChoke' && S.RIGUP.length === 11 && S.RIG_KEYS.length =",owner: "WP-E0",change: "self-test exports: RIG_OPTIONAL 'desander,surge2,heaterChoke', lengths 11, VERSION '1.5.0' — done at WP-E0"},
  {file: "prism-build/31-wts-sim.js",line: 4723,kind: "done",text: "assert(k.sig === '11111111001' && k.extras.join() === 'heaterChoke' && k.full && S.stepFor({ heaterChoke: true",owner: "WP-E0",change: "new v1.5.0 check with an 11-character CK-102-in signature (WP-E0)"},
  {file: "prism-build/32-wts-3d.js",line: 1002,kind: "rig",text: "full:true, sig:'11111111' + (dsIn ? '1' : '0') + (u2In ? '1' : '0'), notes:[], extras:[].concat(dsIn ? ['desan",owner: "WP-3D",change: "fakeSnapshot sig: + (ck2In ? '1' : '0') (11 characters)"},
  {file: "prism-build/32-wts-3d.js",line: 3410,kind: "not",text: "for (var q = 0; q < 14; q++) K.phaseSeg[q].set(q <= 3 ? '#9fc3dd' : (q === 4 || q === 9 || q === 10) ? '#cfe6f",change: "phase colour index of a segment"},
  {file: "prism-build/32-wts-3d.js",line: 4625,kind: "not",text: "a.gauge.tanks[0].frac === 0.3 && a.gauge.tanks[1].frac === 0 && a.esd.travel === 1 && a.nodes.heater.firing ==",change: "flare rate 10 MMscf/d"},
  {file: "prism-build/32-wts-3d.js",line: 4629,kind: "rig",text: "ok(6, !bad2.length && I.NODE_NAMES.length === 10 && a.rig.desander === false && a.rig.surge2 === false && a.ri",owner: "WP-3D",change: "NODE_NAMES 11, 3D rigSig 9 characters"},
  {file: "prism-build/32-wts-3d.js",line: 4630,kind: "rig",text: "isFinite(a.nodes.surge2.P) && c.rigSig === '11111100' && e.rig.desander === true && e.rig.surge2 === true && e",owner: "WP-3D",change: "NODE_NAMES 11, 3D rigSig 9 characters"},
  {file: "prism-build/32-wts-3d.js",line: 4675,kind: "rig",text: "ok(11, se.rigup.sig === '1111111111' && se.desander.dump.lastT !== null && se.surge2.tFull_s !== undefined && ",owner: "WP-3D",change: "self-test 11: '11111111110'"},
  {file: "prism-build/32-wts-3d.js",line: 4676,kind: "rig",text: "I.LINE_NAMES.every(function (k) { return se.lines[k] && typeof se.lines[k].q === 'number'; }) && I.fakeSnapsho",owner: "WP-3D",change: "fakeSnapshot default sig '11111111000'"},
  {file: "prism-build/38-wts-live.js",line: 230,kind: "done",text: "for (var i = 0; i < NODE_KEYS.length; i++) {             // 11 nodes (the host diagram reads the first 8)",owner: "WP-E0",change: "comment: 11 nodes — done at WP-E0"},
  {file: "prism-build/38-wts-live.js",line: 4018,kind: "done",text: "// v1.5.0: 11 nodes (DS-101, T-202 and CK-102 appended; positional readers use the first 8), segments stay 6",owner: "WP-E0",change: "self-test comment: 11 nodes — done at WP-E0"},
  {file: "prism-build/38-wts-live.js",line: 4024,kind: "done",text: "return e.length === 11 && isFinite(e[0].P) && typeof n[2].regime === 'string' && isFinite(n[2].Qmax) && isFini",owner: "WP-E0",change: "self-test liveNodes 11 — done at WP-E0"}]/*COUNT_SITES_END*/;

// ─── labels (D17) and inputs (§4.1) ──────────────────────────────────────────
var LABELS = {
  rigItem: 'Heater inlet choke',                         // RIG_ITEMS name and NAMES.heaterChoke
  bean2: 'Heater choke CK-102 bean (64ths)',             // #wts_bean2
  ck2Pos: 'CK-102 position',                             // #wts_ck2Pos
  ck2PosOptions: { inlet: 'On the heater inlet', midcoil: 'Between the coil passes' },
  sepByDest: 'With V-101 out, well stream to',           // #wts_sepByDest
  sepByDestOptions: { flare: 'Burner / flare line', line: 'Production line' },
  sepByP: 'Production line pressure (psig)',             // #wts_sepByP
  scenario: 'Cushion unload (clean-up)',                 // 38 Scenarios menu entry
  hudToLine: 'To production line',                       // HUD totals line while bypLine
  hudToVent: 'To vent',                                  // HUD totals line while ventOn
  bypassed: 'Bypassed with H-101',
  ck2Rbox: 'Heater choke CK-102 (API 14B)',              // host rbox title
  nodeRowCk2: 'Heater choke (CK-102)',                   // host Node-table row while CK-102 is active
  nodeRowLine: '→ production line',                      // host Node-table last row, V-101 out, dest line
  nodeRowBurner: '→ burner line',                        // host Node-table last row, V-101 out, dest flare
  flareCardLine: 'Production line',                      // 38 flare card label while bypLine
  diag2dBurner: 'BYPASSED → BURNER LINE',                // live 2D (38 l.3117)
  diag2dLine: 'BYPASSED → PRODUCTION LINE ({P} psig) · NRV-501 / XV-501',
  between: 'between passes' };                           // 3D label for midcoil if the body stays on the inlet
var INPUTS = [
  { id: 'wts_bean2', card: 'Heater', label: LABELS.bean2, def: 48, min: 4, max: 128, tag: 'count', note: 'row rp-skip and hidden while CK-102 is out of the rig-up' },
  { id: 'wts_ck2Pos', card: 'Heater', label: LABELS.ck2Pos, def: 'inlet', options: ['inlet', 'midcoil'], tag: null, note: 'as wts_bean2; C' },
  { id: 'wts_sepByDest', card: 'Dynamic Simulation', label: LABELS.sepByDest, def: 'flare', options: ['flare', 'line'], tag: null, note: 'always shown' },
  { id: 'wts_sepByP', card: 'Dynamic Simulation', label: LABELS.sepByP, def: 150, min: 0, max: 1440, tag: null,
    note: 'untagged imperial (D28; Q3); rp-skip and disabled while dest is flare; an entered 0 is kept (isFinite clamp)' }];

// texts: {x} placeholders (numbers formatted by the page / engine); textRe() turns a template into a RegExp
var WARN_TEXTS = {   // host, flow.ck2.warnings / flow.sepBy.warnings (§4.5)
  ck2Limit: 'CK-102 limits the rate: bean {b}/64 passes {y} of {z} MMscf/d — open CK-102 or reduce the rate',
  pairLimit: 'CK-101 and CK-102 together pass {y} of {z} MMscf/d — open either choke or reduce the rate',
  ck1Subcrit: 'CK-101 subcritical with CK-102 in line (P2/P1 {r} above {rc}): in a real well the rate and WHP would now respond to the downstream pressure (not simulated)',
  ck2NoFlow: 'No flow at this rate: CK-102 back-pressure reaches the CK-101 inlet',
  blockedInlet: 'SITHP {x} psig above the 1,440 psig design pressure of the line CK-101 → CK-102: if CK-102 is closed or plugged this line sees full SITHP; the coil is downstream of CK-102',
  blockedMidcoil: 'SITHP {x} psig above the 1,440 psig design pressure between the chokes: if CK-102 is closed or plugged the line and H-101 pass 1 see full SITHP',
  ck2Hydrate: 'Hydrate margin at the CK-102 outlet {x} °F',
  ck2HydrateIn: 'Hydrate margin at the CK-102 inlet {x} °F (hydrate {y} °F at {p} psig)',   // WP-C review (§4.3-7 second check, seg 3 at Pm); lead, WP-I
  sepBySubcrit: 'Destination pressure makes CK-101 subcritical',
  sepByNoFlow: 'No flow: destination pressure ≥ choke upstream pressure',
  // review round (lead, WP-I): the rating at the CK-101 outlet (the highest bypass-path pressure), PSHH-104 on the page, velocities
  sepByRating: 'Bypass path {x} psig at the CK-101 outlet (production line {y} psig plus line loss {z} psi) above the 1,440 psig design pressure (blocked outlet not simulated)',
  sepByPshh: 'PSHH-104 trips SDV-101 at {x} psig (H-101 outlet {y} psig): this line pressure shuts the well in — lower the line pressure or go to the burner line',
  segVelExceed: '{seg}: Velocity {x} ft/s EXCEEDS erosional limit {y} ft/s',
  segVelWarn: '{seg}: Velocity {x} ft/s is {y}% of limit — consider upsizing' };
var ALARM_TEXTS = {  // engine (§5.5, §6.2, §6.3)
  CHOKE2_LIMIT: WARN_TEXTS.ck2Limit,
  CHOKE2_LIMIT_both: WARN_TEXTS.pairLimit,
  CK1_SUBCRIT: 'CK-101 subcritical with CK-102 in line: in a real well the rate and WHP would now respond to the downstream pressure (not simulated)',
  PAH_CK2_inlet: 'PAH-102: pressure between the chokes {x} psig, ≥ 90 % of the 1,440 psig design pressure of the line CK-101 → CK-102 — open CK-102',
  PAH_CK2_midcoil: 'PAH-102: pressure between the chokes {x} psig, ≥ 90 % of the 1,440 psig design pressure of the line and H-101 pass 1 — open CK-102',
  PSHH_SEPBY: 'PSHH-104: bypass path {x} psig ≥ 90 % of its 1,440 psig design pressure — SDV-101 tripped',
  SEPBY_RATING: 'Bypass path {x} psig at the choke outlet (production line {y} psig plus line loss {z} psi) above its 1,440 psig design pressure; a blocked outlet is not simulated',
  CUSH_BURNER_water: 'Water / brine cushion to the burner: flame-out and fallout — put V-101 in (liquids to the tanks) or route to a production line',
  CUSH_BURNER_oil: 'Oil / diesel cushion to the burner: liquid fallout and burning liquid without an atomising burner (not modelled) — put V-101 in or route to a production line',
  CUSH_DUMP_start: 'V-101 water dump passes {x} bbl/d: reduce the unload rate or route to the line',
  HTR_FULL: 'H-101 at full firing: outlet {x} °F, set point {y} °F' };
function textRe(tpl) {
  var esc = String(tpl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc.replace(/\\\{[a-z0-9]+\\\}/gi, '(?:.+?)'));
}

// ─── tags, names, alarms (§2.2, D12, §5.5, §6.2, §6.3) ───────────────────────
var TAGS_NEW = { heaterChoke: 'CK-102', pahCk2: 'PAH-102', pshhSepBy: 'PSHH-104', nrvLine: 'NRV-501', xvLine: 'XV-501' };
var NAMES_NEW = { heaterChoke: LABELS.rigItem };
var ALARM_TAGS_NEW = ['CK-102', 'PAH-102', 'PSHH-104'];
// sev: 'trip' | 'alarm' | 'warn' | 'hyd'. esd: true when it trips SDV-101 (PSHH-104 only, through the DES_PSHH path).
var ALARMS = {
  CHOKE2_LIMIT:    { tag: 'CK-102', sev: 'alarm', eq: 'heaterChoke' },
  CK1_SUBCRIT:     { tag: 'CK-101', sev: 'warn', eq: 'choke' },
  PAH_CK2:         { tag: 'PAH-102', sev: 'warn', eq: 'heaterChoke' },
  HYD_heaterChoke: { tag: 'CK-102', sev: 'hyd', eq: 'heaterChoke' },
  PSHH_SEPBY:      { tag: 'PSHH-104', sev: 'trip', eq: 'separator', esd: true },
  SEPBY_RATING:    { tag: 'V-101', sev: 'warn', eq: 'separator' },
  CUSH_LIMIT:      { tag: 'CK-101', sev: 'warn', eq: 'choke' },
  CUSH_NOLIFT:     { tag: 'WH-101', sev: 'alarm', eq: 'wellhead' },
  CUSH_BURNER:     { tag: 'FS-401', sev: 'warn', eq: 'flare' },
  CUSH_DUMP:       { tag: 'LCV-101', sev: 'warn', eq: 'separator' },
  HTR_FULL:        { tag: 'H-101', sev: 'warn', eq: 'heater' } };
var ALARM_IDS = Object.keys(ALARMS);   // 11 (§9.1 says "thirteen"; D12 lists these eleven)
var Q_CK2 = ['CHOKE2_LIMIT', 'CK1_SUBCRIT', 'PAH_CK2', 'HYD_heaterChoke'];
var Q_SEPBY = ['PSHH_SEPBY', 'SEPBY_RATING'];
var Q_CUSH = ['CUSH_LIMIT', 'CUSH_NOLIFT', 'CUSH_BURNER', 'CUSH_DUMP', 'HTR_FULL'];
var ESD_TRIP_IDS = ['PSHH_SEPBY'];
var LOG_EVENT_IDS_NEW = ['CUSHION', 'BYPASS_DEST'];
var CUSHION_PHASES = ['off', 'unloading', 'stalled', 'breakthrough', 'tail', 'done'];
var EVENT_CUSHION_EXAMPLE = { type: 'cushion', t: 0, phase: 'unloading', msg: 'Cushion unload started: 50 bbl at 1,500 bbl/d' };

// ─── history, nodes, nullable, cumulative (§2.2, §5.1, §6.2) ─────────────────
var HIST_KEYS_V331 = EQ.HIST_KEYS.slice();
var HIST_KEYS_NEW = ['Pck2', 'cushionLeft'];
var HIST_KEYS = HIST_KEYS_V331.concat(HIST_KEYS_NEW);
var NODE_IDS_V331 = EQ.NODE_IDS.slice();
var NODE_IDS = NODE_IDS_V331.concat(['heaterChoke']);   // positional readers: heaterChoke = index 10
var SEG_COUNT = 6;                                       // snap.segs stays 6; no new lines entry
var NULLABLE_NEW = ['inputs.bean2', 'inputs.ck2Pos', 'cushion.tBreak'];
var CUM_NEW = ['lineGas', 'lineOil', 'lineWater', 'vent'];
var SNAP_CUM_NEW = ['toLine_gas_mscf', 'toLine_oil_stb', 'toLine_water_bbl', 'toVent_gas_mscf'];

// ─── DEFAULTS additions (§5.1, §6.1), features (D14), flow.sim (§4.1) ─────────
var DEFAULTS_NEW = {
  heaterChoke: { lagS: 5, designP_psig: 1440, pahFrac: 0.90 },
  sepBypass: { dest: 'flare', P_psig: 150, P_flare_psig: 5, designP_psig: 1440, pshhFrac: 0.90 },   // DEFAULTS.sep.bypass
  cushion: { V_bbl: 50, SG: 1.03, q_bpd: 1500, tbgCap_bblft: 0.00870, depth_ft: 10000, Gr_psift: 0.08, gasFrac: 0.05,
    tailFrac: 0.15, tailTau_s: 1800, breakTau_s: 600, Cd_liq: 0.85, burnerSG: 0.95, stallMargin_psi: 50,
    unstallHyst_psi: 25, htrRatedFactor: 1.25,
    lim: { V: [1, 500], SG: [0.80, 1.50], q: [100, 6000], cap: [0.003, 0.03], depth: [500, 25000] } } };
var FEATURES = { heaterChoke: true, bypassDest: true, cushion: true };
var FLOW_SIM_NEW = [
  { key: 'sepByDest', input: 'wts_sepByDest', def: 'flare', values: ['flare', 'line'], cfg: 'sep.bypass.dest', note: "anything else → 'flare'" },
  { key: 'sepByP_psig', input: 'wts_sepByP', def: 150, min: 0, max: 1440, cfg: 'sep.bypass.P_psig', note: 'isFin, clamp 0–1440; 0 kept' }];
var SAMPLE_FLOW_SIM_NEW = { sepByDest: 'flare', sepByP_psig: 150 };
var SAMPLE_FLOW_SIM_KEYS = Object.keys(EQ.SAMPLE_FLOW_SIM).concat(Object.keys(SAMPLE_FLOW_SIM_NEW));   // 9
var API_STATIC_NEW = ['features'];
var API_INSTANCE_NEW = ['startCushion', 'stopCushion', 'getCushion'];
var DESIGN_P_CK2 = 1440;      // psig, ASME B16.5 Class 600 at ambient (ASSUMPTION, D16); host constant and cfg.heaterChoke.designP_psig
var P_FLARE_HDR = 5;          // psig, host constant = the default cfg.sep.bypass.P_flare_psig = cfg.sep.pcv.P2_psig
var CUSHION_TUBING = [        // Scenarios form tubing select → capacity (bbl/ft) (nominal ID, typical weight)
  { id: '2-3/8', label: '2-3/8″ 4.7 lb/ft (1.995″ ID)', cap: 0.00387 },
  { id: '2-7/8', label: '2-7/8″ 6.5 lb/ft (2.441″ ID)', cap: 0.00579 },
  { id: '3-1/2', label: '3-1/2″ 9.2 lb/ft (2.992″ ID)', cap: 0.00870 },
  { id: '4-1/2', label: '4-1/2″ 12.75 lb/ft (3.958″ ID)', cap: 0.01522 }];

// ─── BASE_FIELDS (§9.2) ──────────────────────────────────────────────────────
// 'ck1' (CK-101 manifold block, added after v3.3.3) is omitted like ck2 / sepBy (= wts-calc-golden.js BASE_FIELDS_OMIT)
var BASE_FIELDS_OMIT = ['ts', 'seq', 'ck2', 'sepBy', 'sim.sepByDest', 'sim.sepByP_psig', 'ck1'];
function baseFields(flow) {
  if (!flow || typeof flow !== 'object') return flow;
  var c = clone(flow);
  delete c.ts; delete c.seq; delete c.ck2; delete c.sepBy; delete c.ck1;
  if (c.sim && typeof c.sim === 'object') { delete c.sim.sepByDest; delete c.sim.sepByP_psig; }
  return c;
}

// ─── worked numbers (§4.6, §6.4; re-anchored at WP0) ─────────────────────────
// ANCHORS_CK2: the prototype wtsWalk of §4.3 (calcWTS v3.3.1 physics, 8 outer passes, Illinois solves) on the page
// defaults (wts-calc-golden.js SETS defaults: CK-101 32/64, Cd 0.85, 10 MMscf/d, 1,000 / 200 bbl/d, WHP 3,000, Psep 150)
// unless `inputs` says otherwise. rel: relative tolerance (0.5 % as §4.6), abs: absolute; strings and booleans exact.
// Field names follow flow.ck2: Pm = flow.ck2.Pin, Pco2 = ck1.Pout, ratio = ck1.ratio, ck1 = ck1.regime, ck2Crit = CK-102
// critical (regime 'Critical'), QmaxPair = flow.ck2.QmaxMMscfd, Tco2 = ck1.Tout, dT1 = ck1.dTjt,
// dT2 = flow.ck2.dTjt, TmIn / TmOut = flow.ck2.Tin / Tout (TmOut = the heater inlet for 'inlet'), duty = heater.dutyMMBtuHr
// (fired, as flow.heater). base* = the CK-101-only walk (the golden). Pci (CK-101 inlet) 2,999.26 psig at the defaults.
var ANCHORS_CK2 = [
  { id: 'bean48', inputs: { wts_bean2: '48', wts_ck2Pos: 'inlet' }, rel: 0.005,
    Pm: 1135.12, Pout: 156.01, Pco2: 1135.37, ratio: 0.3816, ck1: 'Critical', ck2Crit: true, QmaxPair: 10.7104, limiter: 'CK-101', flowLimited: false,
    Tco2: 107.02, dT1: 72.98, dT2: 38.34, TmIn: 107.02, TmOut: 68.68, duty: 2.1044, noFlow: false,
    text: 'default 48/64 inlet: about 1,135 psig between the chokes, CK-101 critical (P2/P1 0.38), pair not limited' },
  { id: 'bean48mid', inputs: { wts_bean2: '48', wts_ck2Pos: 'midcoil' }, rel: 0.005,
    Pm: 1135.12, ratio: 0.3816, ck1: 'Critical', QmaxPair: 10.7104, TmIn: 125.00, TmOut: 86.66, duty: 2.1044, Tp1MaxBelowTho: 25,
    text: 'midcoil: same pressures and duty; CK-102 inlet = pass-1 outlet Tp1 = T3 + min(½(Tho − T3), Tho − 25 − T3)' },
  { id: 'bean40', inputs: { wts_bean2: '40' }, rel: 0.005,
    Pm: 1659.54, ratio: 0.5556, ck1: 'Subcritical', ck2Crit: true, QmaxPair: 10.6591, limiter: 'CK-102', flowLimited: false, Tco2: 127.55, TmOut: 68.68,
    text: '40/64: CK-101 just subcritical (P2/P1 0.556 > r_crit 0.549), CK1_SUBCRIT; pair passes 10.66 > 10 × 1.01' },
  // review round (lead, WP-I): a flow-limited block publishes every state at the pair capacity QmaxPair (the rate that flows); the
  // requested-rate walk has no physical state then (24/64: none at all — noFlow stays a flag, the regime is the one at QmaxPair)
  { id: 'bean32', inputs: { wts_bean2: '32' }, rel: 0.005,
    Pm: 2401.58, Pco2: 2401.69, ratio: 0.8017, ck1: 'Subcritical', ck2Crit: true, regime: 'Critical', QmaxPair: 8.9202, limiter: 'CK-102', flowLimited: true, noFlow: false,
    Tco2: 156.60, dT1: 23.40, dT2: 87.93, TmOut: 68.67, duty: 1.8775,
    text: 'equal beans 32/32: flow-limited, limiter CK-102 (critical) with CK-101 subcritical; QmaxPair 8.92 < 10; states at 8.92 (about 2,400 psig between the chokes)' },
  { id: 'bean24', inputs: { wts_bean2: '24' }, rel: 0.005,
    noFlow: true, flowLimited: true, QmaxPair: 5.6947, limiter: 'CK-102', regime: 'Critical', ck1: 'Subcritical',
    Pm: 2795.53, Pco2: 2795.57, ratio: 0.9324, Tco2: 172.02, dT1: 7.975, TmOut: 68.65, duty: 1.1989,
    text: '24/64: no feasible state at 10 MMscf/d (No Flow guard, the flag), pair capacity 5.69; states at 5.69 (CK-101 0.93 subcritical, CK-102 critical)' },
  { id: 'bean4', inputs: { wts_bean2: '4' }, rel: 0.02,
    noFlow: true, flowLimited: true, QmaxPair: 0.1673, limiter: 'CK-102', regime: 'No Flow',
    text: '4/64: No Flow, no throw; pair capacity at the infeasible edge (Illinois clamps there; 2 % tolerance), so the state at it is No Flow too' },
  { id: 'bean64', inputs: { wts_bean2: '64' }, rel: 0.005,
    Pm: 634.42, ratio: 0.2155, ck1: 'Critical', QmaxPair: 10.7104, limiter: 'CK-101', flowLimited: false, TmOut: 68.69 },
  { id: 'bean96', inputs: { wts_bean2: '96' }, rel: 0.005,
    Pm: 278.15, ratio: 0.0975, ck1: 'Critical', ck2Crit: false, QmaxPair: 10.7104, limiter: 'CK-101', flowLimited: false, TmOut: 68.71 },
  { id: 'bothPsep1500b40', inputs: { wts_Psep: '1500', wts_bean2: '40' }, rel: 0.005,
    Pm: 1939.67, ratio: 0.6485, ck1: 'Subcritical', ck2Crit: false, QmaxPair: 10.3908, limiter: 'both', flowLimited: false,
    text: 'both subcritical (separator 1,500 psig, 32/64 + 40/64): joint limit, limiter both' },
  { id: 'bothPsep1500b32', inputs: { wts_Psep: '1500', wts_bean2: '32' }, rel: 0.005,
    Pm: 2415.87, ratio: 0.8065, ck1: 'Subcritical', ck2Crit: false, QmaxPair: 8.8438, limiter: 'both', flowLimited: true, duty: 0.6523,
    text: 'equal beans at 1,500 psig separator: flow-limited, limiter both (neither choke critical at the pair capacity; states at 8.84)' },
  { id: 'dryGas48', inputs: { wts_Qo: '0', wts_Qw: '0', wts_bean2: '48' }, rel: 0.005,
    Pm: 1030.25, ratio: 0.3467, ck1: 'Critical', QmaxPair: 10.7116, limiter: 'CK-101', flowLimited: false, dT1: 137.85, dT2: 12.15, dTsum: 150,
    TmOut: 29.998, duty: 1.7370, baseTin: 29.996, baseDuty: 1.7371, tolTinAbs: 0.5, tolDutyRel: 0.005,
    text: 'dry-gas anchor (wJT 1, cumulative cap): stages 137.9 + 12.2 = 150 °F; heater inlet T and duty equal the CK-101-only walk within 0.5 °F / 0.5 % (measured 0.002 °F, 0.01 %)' },
  { id: 'liquidOnly', inputs: { wts_Qg: '0', wts_bean2: '48' }, skipped: true, note: RIG_NOTES.ck2SkippedNote,
    text: 'Qg 0: flow.ck2 = {v:1, bean, pos, skipped:true, note}' },
  { id: 'blockedIn', inputs: { wts_bean2: '48' }, sit: 3600, sitEst: true, ratingOK: false,
    text: 'SITHP estimate 1.2 × 3,000 = 3,600 psig > 1,440: the blocked-in warning (text by position) in flow.ck2.warnings' },
  { id: 'baseDefaults', inputs: {}, rel: 0.0005, Pco: 157.66086, Thi: 68.735, duty: 2.1031, QcritMMscfd: 10.7104,
    text: 'the CK-101-only walk at the defaults (golden): choke outlet, heater inlet T, fired duty (for the comparison rows; 4-5 significant figures)' }];
// ANCHORS_CUSH: the prototype cushion step of §6.3 on WTS_sim.SAMPLE_FLOW (V-101 in, no SITHP entered → SIT = 1.2 × 3,000,
// noise off, D7 defaults), time from startCushion. The delivered cushion water follows the τf = 20 s lag (Rr.tauFlow).
var ANCHORS_CUSH = [
  { id: 'fUnload0', value: 0.18248, rel: 0.005, text: 'fUnload at the start: (0.05·1e7·Bgwh + 1,500) / qRes_ss; Bgwh 0.000967 rb/scf (Z 0.904), qRes_ss 10,869 rb/d' },
  { id: 'column0', value: 4885.06, rel: 0.001, text: 'main-slug column 42.5 bbl / 0.00870 bbl/ft (ft)' },
  { id: 'WHPstart', value: 1702.63, rel: 0.005, text: 'WHP target at the start (SIT-based column law, noise off) (psig)' },
  { id: 'WHPendMain', value: 3490.51, rel: 0.005, text: 'column law at the end of the main slug, hc = 0 (psig)' },
  { id: 'floor', value: 200, abs: 1, text: 'stall floor pDown() + 50 with V-101 in at 150 psig (psig)' },
  { id: 'tBreak', value: 2468.0, abs: 10, text: 'breakthrough (s after start): 42.5 bbl delivered = 42.5 / (1,500/86,400) + τf; to one substep of dt 10' },
  { id: 'Vtail', value: 7.1528, rel: 0.005, text: 'tail volume V − Vprod(tBreak) − τf·qDel(tBreak) (bbl)' },
  { id: 'tDone', value: 2468 + 8933, rel: 0.10, text: 'done at Vprod ≥ 0.999·V: tBreak + τt·ln(Vtail / 0.05) ≈ tBreak + 4.96 τt (s), ± 10 %' },
  { id: 'recovered', value: 50, rel: 0.001, text: '∫ cushion water dt at tBreak + 10·tailTau (bbl): = V within 0.1 %' },
  { id: 'waterIn1h', value: 62.153, rel: 0.002, inputs: { V: 500, gasFrac: 0 }, text: 'cum water in after 1 h at 1,500 bbl/d with V 500 (no breakthrough), gasFrac 0: 62.5 − τf·q (bbl); within 1 % of 62.5' },
  { id: 'nolift', value: -4568.85, rel: 0.005, inputs: { V: 150, cap: 0.00579, depth: 25000 }, text: 'column law with 150 bbl in 2-7/8″ to 25,000 ft (column 22,021 ft): below the floor → stall, CUSH_NOLIFT' },
  { id: 'qLcap32', value: 8433.0, rel: 0.001, args: [32, 1550, 1.03], text: 'qLcapRef(32, 1,550 psi, SG 1.03) (bbl/d): does not limit 1,500' },
  { id: 'qLcap12', value: 1185.9, rel: 0.001, args: [12, 1550, 1.03], text: 'qLcapRef(12, 1,550 psi, SG 1.03) (bbl/d): CUSH_LIMIT' },
  { id: 'dEq32_128', value: 31.9688, rel: 0.0001, args: [32, 128], text: 'equivalent bean of 32/64 and 128/64 in series (64ths): qLcap within 0.2 % of CK-101 alone' },
  { id: 'wJTc', value: 0.025026, rel: 0.005, text: 'J-T weight of the unload stream at the defaults (gas 5 %, water 1,500 bbl/d)' }];
function near(a, v) {
  if (typeof a.value === 'number') { var tol = a.abs !== undefined ? a.abs : (a.rel || 0) * Math.max(1, Math.abs(a.value)); return Math.abs(v - a.value) <= tol + 1e-12; }
  return v === a.value;
}
// closed forms of §6.3 (bbl/d; beans in 64ths; ΔP psi)
function qLcapRef(bean64, dP, SG, Cd) { var d = bean64 / 64; return 1023 * (Cd === undefined ? 0.85 : Cd) * d * d * Math.sqrt(Math.max(0, dP) / SG); }
function dEqRef(b1, b2) { return Math.pow(Math.pow(b1, -4) + Math.pow(b2, -4), -0.25); }
// cushionStartRef(o): the derive-time constants and the WHP column law at the start (§6.3). o: {Pwh, Twh, Qg (MMscf/d), Qo, Qw,
// SGg, SIT (default 1.2·Pwh), floor, V, SG, q, cap, depth, Gr, gasFrac, tailFrac}
function zRef(Pa, TR, SGg) { var Ppc = 756.8 - 131 * SGg - 3.6 * SGg * SGg, Tpc = 169.2 + 349.5 * SGg - 74 * SGg * SGg, pr = Pa / Ppc, tr = TR / Tpc;
  return Math.max(0.3, Math.min(1.2, 1 - 3.52 * pr / Math.pow(10, 0.9813 * tr) + 0.274 * pr * pr / Math.pow(10, 0.8157 * tr))); }
function cushionStartRef(o) {
  var C = DEFAULTS_NEW.cushion, x = o || {};
  var Pwh = num(x.Pwh, 3000), TR = num(x.Twh, 180) + 459.67, Pa = Pwh + 14.696, Qg = num(x.Qg, 10) * 1e6, SGg = num(x.SGg, 0.65);
  var V = num(x.V, C.V_bbl), SG = num(x.SG, C.SG), q = num(x.q, C.q_bpd), cap = num(x.cap, C.tbgCap_bblft), depth = num(x.depth, C.depth_ft),
    Gr = num(x.Gr, C.Gr_psift), gasFrac = num(x.gasFrac, C.gasFrac), tailFrac = num(x.tailFrac, C.tailFrac);
  var SIT = num(x.SIT, 1.2 * Pwh), Bgwh = 0.00504 * zRef(Pa, TR, SGg) * TR / Pa, qRes = Qg * Bgwh + num(x.Qo, 1000) + num(x.Qw, 200);
  var Vmain = V * (1 - tailFrac), hc = Math.min(Vmain, depth * cap) / cap, fU = Math.min(1, (gasFrac * Qg * Bgwh + q) / qRes);
  var WHPcol = SIT - (SIT - Pwh) * fU - (0.433 * SG - Gr) * hc;
  return { SIT: SIT, Bgwh: Bgwh, qRes: qRes, Vmain: Vmain, column_ft: hc, fUnload: fU, WHPcol: WHPcol, WHPtgt: Math.max(num(x.floor, 200), WHPcol) };
}

// ─── 3D → 38 action payloads (§7.3) ──────────────────────────────────────────
var ACTIONS = {
  bean2Minus: { type: 'bean', eq: 'heaterChoke', d: -4 },
  bean2Plus: { type: 'bean', eq: 'heaterChoke', d: 4 },
  cushionStart: { type: 'cushion', cmd: 'start' },
  cushionStop: { type: 'cushion', cmd: 'stop' } };

// ─── examples (illustrative, consistent with the prototype at the defaults) ──
var EX_SEG3 = { id: 'choke_heater', from: 'choke', to: 'heater', label: 'Choke→Heater', nps: '6', sch: '40', ID: 6.065, L: 200, phase: 'multi',
  P0: 1135.37, Pout: 1135.12, T0: 107.02, Tout: 107.02, vel: 10.9, ve: 51.7, rhom: 3.74, dP: 0.25, dT: 0.0008, z: 0.86, Re: 610000, ff: 0.0158,
  Thyd: 61.9, hydR: false, vSt: 'OK', vPct: 21.1 };
var EX_SEG4 = { id: 'heater_sep', from: 'heater', to: 'separator', label: 'Heater→Sep', nps: '6', sch: '40', ID: 6.065, L: 100, phase: 'multi',
  P0: 151.01, Pout: 150, T0: 150, Tout: 150, vel: 56.5, ve: 103.3, rhom: 0.94, dP: 1.18, dT: 0.0035, z: 0.97, Re: 790000, ff: 0.0159,
  Thyd: 36.0, hydR: false, vSt: 'OK', vPct: 54.7 };
var EX_SEG5M = { id: 'sep_flare', from: 'separator', to: 'flare', label: 'Sep→Flare', nps: '6', sch: '40', ID: 6.065, L: 300, phase: 'multi',
  P0: 19.54, Pout: 4.79, T0: 150, Tout: 149.96, vel: 289.7, ve: 239.5, rhom: 0.17, dP: 14.75, dT: 0.044, z: 0.997, Re: 1000000, ff: 0.0156,
  Thyd: 32, hydR: false, vSt: 'EXCEED', vPct: 121 };
var EX_WARN = { t: 'warn', msg: 'text' };
var EX_FLOW_CK2 = {
  v: 1, bean: 48, pos: 'inlet', Cd: 0.85, skipped: false, note: '',
  regime: 'Critical', noFlow: false, flowLimited: false, limiter: 'CK-101',
  QmaxMMscfd: 10.7104, Pin: 1135.12, Pout: 156.01, dP: 979.12, dTjt: 38.34, Tin: 107.02, Tout: 68.68, hyd: { T: 36.5, margin: 32.2 },
  ck1: { regime: 'Critical', Pout: 1135.37, ratio: 0.3816, QmaxMMscfd: 10.7104, Tout: 107.02, dTjt: 72.98, wJT: 0.5593 },
  nodes: { choke: { P: 1135.37, T: 107.02 }, heaterChoke: { P: 156.01, Pin: 1135.12, T: 68.68, Tin: 107.02 }, heater: { P: 151.01, T: 150, Tin: 68.68, duty: 2.1044 } },
  segs: [EX_SEG3, EX_SEG4],
  heater: { dutyMMBtuHr: 2.1044, Tin: 68.68, Tout: 150 },
  sit_psig: 3600, sitEst: true, designP_psig: 1440, ratingOK: false,
  warnings: [EX_WARN] };
var EX_FLOW_CK2_SKIPPED = { v: 1, bean: 48, pos: 'inlet', skipped: true, note: RIG_NOTES.ck2SkippedNote };
var EX_CHOKE = { regime: 'Critical', flowLimited: false, QmaxMMscfd: 10.7104, QcritMMscfd: 10.7104, Pin: 2999.26, Pout: 34.72, ratio: 0.0164,
  rCrit: 0.5494, dP: 2964.54, dTjt: 116.0, wJT: 0.5593 };
var EX_FLOW_SEPBY = {
  v: 1, dest: 'flare', P0_psig: 5, noFlow: false, choke: EX_CHOKE,
  nodes: { choke: { P: 34.72, T: 64.0 }, heater: { P: 27.6, T: 150 }, sep: { P: 19.54, T: 150 } },
  segs: [EX_SEG3, EX_SEG4, EX_SEG5M],
  heater: { dP: 5, dutyMMBtuHr: 2.2, Tin: 63.9, Tout: 150 }, surgeP_psig: 25, designP_psig: 1440, warnings: [EX_WARN], ck2: null };
var EX_NODES_HC = { tag: 'CK-102', inRig: true, active: true, bypassed: false, P: 156.0, Pin: 1135.1, T: 68.7, Tin: 107.0, th: 36.5, hyd: false,
  dTjt: 38.3, regime: 'Critical', bean: 48, pos: 'inlet', flowLimited: false, limiter: 'CK-101', QmaxMMscfd: 10.71, designP_psig: 1440, note: '' };
var EX_NODES_HC_OUT = { tag: 'CK-102', inRig: false, active: false, bypassed: false, P: 157.7, Pin: 157.7, T: 68.7, Tin: 68.7, th: 36.6, hyd: false,
  dTjt: 0, regime: '', bean: 0, pos: 'inlet', flowLimited: false, limiter: '', QmaxMMscfd: 0, designP_psig: 1440, note: '' };
var EX_CUSHION = { on: true, phase: 'unloading', V_bbl: 50, SG: 1.03, q_set_bpd: 1500, q_bpd: 1500, qcap_bpd: 8433, WHPtgt_psig: 1702.6, column_ft: 4885.1,
  Vleft_bbl: 50, recovered_bbl: 0, fUnload: 0.1825, wJT: 0.025, dutyCapped: false, tBreak: null, out: { flare: 0, line: 0, sep: 0, surge: 0 } };   // 4.1: + out.surge
var EX_CUSHION_OFF = { on: false, phase: 'off', V_bbl: 0, SG: 0, q_set_bpd: 0, q_bpd: 0, qcap_bpd: 0, WHPtgt_psig: 0, column_ft: 0,
  Vleft_bbl: 0, recovered_bbl: 0, fUnload: 0, wJT: 0, dutyCapped: false, tBreak: null, out: { flare: 0, line: 0, sep: 0, surge: 0 } };
// release 4.1 (appended): recv ('' | 'T-201' | 'T-202' | 'both') and gasCap_mmscfd (null unless V-101 is out to 'surge');
// 4.1 round 2 (appended): gasCap1_mmscfd / gasCap2_mmscfd = PCV-201 / PCV-203 each at PSHH (always a number)
var EX_SEPBY = { dest: 'flare', P_psig: 150, P0_psig: 5, active: false, vent: false, note: '', recv: '', gasCap_mmscfd: null, gasCap1_mmscfd: 0.152, gasCap2_mmscfd: 0.152 };
var EX_SEPBY_LINE = { dest: 'line', P_psig: 300, P0_psig: 300, active: true, vent: true, note: '', recv: '', gasCap_mmscfd: null, gasCap1_mmscfd: 0.152, gasCap2_mmscfd: 0.152 };
var EXAMPLES = {};
[['flowCk2', EX_FLOW_CK2], ['flowCk2Skipped', EX_FLOW_CK2_SKIPPED], ['flowSepBy', EX_FLOW_SEPBY], ['nodesHeaterChoke', EX_NODES_HC],
  ['nodesHeaterChokeOut', EX_NODES_HC_OUT], ['cushion', EX_CUSHION], ['cushionOff', EX_CUSHION_OFF], ['sepBy', EX_SEPBY], ['sepByLine', EX_SEPBY_LINE]].forEach(function (p) {
  Object.defineProperty(EXAMPLES, p[0], { enumerable: true, get: function () { return clone(p[1]); } });
});

// ─── checkShape ──────────────────────────────────────────────────────────────
// Templates: a number accepts a finite number (or null when the template value is null — the NULLABLE paths); a string is
// checked against ENUMS when the path has one; objects recurse (strict: no unexpected keys); arrays element-wise against the
// first template element. flow.ck2 accepts the skipped variant; flow.sepBy.ck2 is null or a flow.ck2.
var ENUMS = {
  'flow.ck2.pos': ['inlet', 'midcoil'],
  'flow.ck2.regime': ['Critical', 'Subcritical', 'No Flow'],
  'flow.ck2.limiter': ['CK-101', 'CK-102', 'both'],
  'flow.ck2.ck1.regime': ['Critical', 'Subcritical', 'No Flow'],
  'flow.ck2.warnings[*].t': ['error', 'warn', 'info'],
  'flow.sepBy.dest': ['flare', 'line', 'surge'],   // 4.1: + 'surge'
  'flow.sepBy.choke.regime': ['Critical', 'Subcritical', 'No Flow'],
  'flow.sepBy.warnings[*].t': ['error', 'warn', 'info'],
  'nodes.heaterChoke.regime': ['', 'Critical', 'Subcritical', 'No Flow'],
  'nodes.heaterChoke.limiter': ['', 'CK-101', 'CK-102', 'both'],
  'nodes.heaterChoke.pos': ['inlet', 'midcoil'],
  'cushion.phase': CUSHION_PHASES,
  'sepBy.dest': ['flare', 'line', 'surge'] };   // 4.1: + 'surge' (the chain rules)
var FIXED = { 'nodes.heaterChoke.tag': 'CK-102', 'flow.ck2.designP_psig': DESIGN_P_CK2, 'flow.sepBy.designP_psig': DESIGN_P_CK2, 'cushionEvent.type': 'cushion' };
var SHAPES = {
  'flow.ck2': { tpl: EX_FLOW_CK2, root: 'flow.ck2' },
  'flow.sepBy': { tpl: EX_FLOW_SEPBY, root: 'flow.sepBy' },
  'nodes.heaterChoke': { tpl: EX_NODES_HC, root: 'nodes.heaterChoke' },
  cushion: { tpl: EX_CUSHION, root: 'cushion' },
  sepBy: { tpl: EX_SEPBY, root: 'sepBy' },
  cushionEvent: { tpl: EVENT_CUSHION_EXAMPLE, root: 'cushionEvent' } };
var SHAPE_NAMES = Object.keys(SHAPES);
function typeName(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
function walkShape(tpl, act, p, errs, strict) {
  var pk = p.replace(/\[\d+\]/g, '[*]');
  if (pk === 'flow.sepBy.ck2') {
    if (act === null) return;
    walkShape(act && act.skipped === true ? EX_FLOW_CK2_SKIPPED : EX_FLOW_CK2, act, 'flow.ck2', errs, strict);
    return;
  }
  var tt = typeName(tpl), at = typeName(act);
  if (tpl === null) {   // nullable number
    if (!(act === null || (typeof act === 'number' && isFinite(act)))) errs.push(p + ': expected a finite number or null, got ' + at);
    return;
  }
  if (tt === 'number') {
    if (typeof act !== 'number' || !isFinite(act)) errs.push(p + ': expected a finite number, got ' + (typeof act === 'number' ? String(act) : at));
    else if (hasOwn(FIXED, pk) && FIXED[pk] !== act) errs.push(p + ': expected ' + FIXED[pk] + ', got ' + act);
    return;
  }
  if (tt === 'string') {
    if (typeof act !== 'string') { errs.push(p + ': expected a string, got ' + at); return; }
    if (hasOwn(ENUMS, pk) && ENUMS[pk].indexOf(act) < 0) errs.push(p + ': "' + act + '" not in ' + ENUMS[pk].join('|'));
    if (hasOwn(FIXED, pk) && FIXED[pk] !== act) errs.push(p + ': expected "' + FIXED[pk] + '", got "' + act + '"');
    return;
  }
  if (tt === 'boolean') { if (typeof act !== 'boolean') errs.push(p + ': expected a boolean, got ' + at); return; }
  if (tt === 'array') {
    if (!Array.isArray(act)) { errs.push(p + ': expected an array, got ' + at); return; }
    if (tpl.length) act.forEach(function (v, i) { walkShape(tpl[Math.min(i, tpl.length - 1)], v, p + '[' + i + ']', errs, strict); });
    return;
  }
  if (tt === 'object') {
    if (at !== 'object') { errs.push(p + ': expected an object, got ' + at); return; }
    Object.keys(tpl).forEach(function (k) { walkShape(tpl[k], act[k], p + '.' + k, errs, strict); });
    if (strict) Object.keys(act).forEach(function (k) { if (!hasOwn(tpl, k)) errs.push(p + '.' + k + ': unexpected key'); });
  }
}
function checkShape(name, obj, opts) {
  if (!hasOwn(SHAPES, name)) throw new Error('_wts-fu-shapes: unknown shape ' + name + ' (known: ' + SHAPE_NAMES.join(', ') + ')');
  var errs = [], S = SHAPES[name], tpl = S.tpl;
  if (name === 'flow.ck2' && obj && obj.skipped === true) tpl = EX_FLOW_CK2_SKIPPED;
  walkShape(tpl, obj, S.root, errs, !!(opts && opts.strict));
  if (name === 'flow.ck2' && obj && obj.skipped !== true && Array.isArray(obj.segs) && obj.segs.length !== 2) errs.push('flow.ck2.segs: expected [seg3, seg4]');
  if (name === 'flow.sepBy' && obj && Array.isArray(obj.segs) && obj.segs.length !== 3) errs.push('flow.sepBy.segs: expected [seg3, seg4, seg5]');
  // release 4.1 appended keys may be missing in an older engine's / view's snapshot: only "missing" (undefined) is excused, and
  // only for an old object (4.1 review; the rule of _wts-equip-shapes.js excuse342: opts.legacy or all of the shape's 4.1 keys
  // missing; never with opts.engine 'work')
  errs = EQ.excuse342(errs, OPTIONAL_342, S.root, opts, function (e) { var m = /^([^:]*): (missing|expected .*, got undefined)$/.exec(e); return m ? m[1] : null; });
  return { ok: errs.length === 0, errors: errs };
}
var OPTIONAL_342 = ['sepBy.recv', 'sepBy.gasCap_mmscfd', 'sepBy.gasCap1_mmscfd', 'sepBy.gasCap2_mmscfd', 'cushion.out.surge'];

// ─── fakeFuSnapshot (§7.3) ───────────────────────────────────────────────────
// base: a snapshot-like object (a real getState(), 32's fakeSnapshot(), fakeEquipSnapshot(), or null); deep-copied, never
// modified. o: { ck2: bool (CK-102 in the rig-up), bypassed: bool (heater bypassed: CK-102 in the rig-up, not in line),
// pos: 'inlet'|'midcoil', sepOut: bool (V-101 out), flareOut: bool (FS-401 out; only with dest 'line'), dest: 'flare'|'line',
// P: line pressure (psig, default 150), cushion: false | a CUSHION_PHASES phase }.
// Result: nodes.heaterChoke, rigup.heaterChoke + 11-character sig + extras, inputs.bean2 / ck2Pos, sepBy, cushion, the four
// snapshot cum keys; the choke outlet stays where it was (CK-102 sits downstream of it).
function fakeFuSnapshot(base, o) {
  o = o || {};
  var s = base ? clone(base) : {};
  var ck2In = o.ck2 === true, byp = ck2In && o.bypassed === true, act = ck2In && !byp, pos = o.pos === 'midcoil' ? 'midcoil' : 'inlet';
  var sepOut = o.sepOut === true, dest = o.dest === 'line' ? 'line' : 'flare', P = num(o.P, 150), flareOut = sepOut && dest === 'line' && o.flareOut === true;
  s.nodes = s.nodes || {};
  s.inputs = s.inputs || {};
  s.cum = s.cum || {};
  var ch = s.nodes.choke || {}, Pck = num(ch.P, 157.7), Tck = num(ch.T, 68.7);
  // rig-up
  var ru = s.rigup || {};
  RIG_KEYS_V331.forEach(function (k) { if (typeof ru[k] !== 'boolean') ru[k] = RIG_DEFAULTS[k]; });
  ru.heaterChoke = ck2In;
  if (sepOut) ru.separator = false;
  if (flareOut) ru.flare = false;
  ru.extras = RIG_OPTIONAL.filter(function (k) { return ru[k] === true; });
  ru.sig = RIG_KEYS.map(function (k) { return ru[k] ? '1' : '0'; }).join('');
  ru.full = RIG_KEYS.filter(function (k) { return RIG_OPTIONAL.indexOf(k) < 0; }).every(function (k) { return ru[k]; });
  if (!Array.isArray(ru.notes)) ru.notes = [];
  if (typeof ru.refused !== 'string') ru.refused = '';
  if (typeof ru.v !== 'number') ru.v = 1;
  s.rigup = ru;
  // CK-102 node (append: index 10)
  var n = act ? clone(EX_NODES_HC) : clone(EX_NODES_HC_OUT);
  n.inRig = ck2In; n.active = act; n.bypassed = byp; n.pos = pos;
  if (act) { n.Pin = Pck - 0.25; n.Tin = pos === 'midcoil' ? Tck + 18 : Tck; n.T = n.Tin - n.dTjt; }
  else { n.P = n.Pin = Pck; n.T = n.Tin = Tck; n.bean = ck2In ? 48 : 0; }
  s.nodes.heaterChoke = n;
  s.inputs.bean2 = ck2In ? 48 : null;
  s.inputs.ck2Pos = ck2In ? pos : null;
  // bypass destination
  var sb = dest === 'line' ? clone(EX_SEPBY_LINE) : clone(EX_SEPBY);
  sb.P_psig = P; sb.P0_psig = dest === 'line' ? P : P_FLARE_HDR; sb.active = sepOut; sb.vent = flareOut;
  s.sepBy = sb;
  // cushion
  var ph = (typeof o.cushion === 'string' && CUSHION_PHASES.indexOf(o.cushion) >= 0 && o.cushion !== 'off') ? o.cushion : null;
  var c = ph ? clone(EX_CUSHION) : clone(EX_CUSHION_OFF);
  if (ph) {
    c.phase = ph; c.on = ph !== 'done';
    var frac = { unloading: 0.3, stalled: 0.1, breakthrough: 0.86, tail: 0.95, done: 1 }[ph];
    c.recovered_bbl = c.V_bbl * frac; c.Vleft_bbl = c.V_bbl - c.recovered_bbl;
    if (ph === 'stalled') { c.q_bpd = 0; c.WHPtgt_psig = 200; }
    if (frac > 0.85) { c.tBreak = 2468; c.column_ft = 0; }
    var to = sepOut ? (dest === 'line' ? 'line' : 'flare') : 'sep';
    c.out[to] = c.recovered_bbl;
  }
  s.cushion = c;
  SNAP_CUM_NEW.forEach(function (k) { if (typeof s.cum[k] !== 'number') s.cum[k] = 0; });
  return s;
}

module.exports = deepFreeze({
  PLAN: PLAN, VERSION_V331: VERSION_V331, VERSION_NEW: VERSION_NEW,
  RIG_KEYS_V331: RIG_KEYS_V331, RIG_KEYS: RIG_KEYS, RIG_ORDER: RIG_ORDER, RIG_ITEM_NEW: RIG_ITEM_NEW, RIG_DEFAULTS: RIG_DEFAULTS,
  RIG_OPTIONAL: RIG_OPTIONAL, SIG_V331: SIG_V331, SIG_DEFAULT: SIG_DEFAULT, GETRIGUP_DEFAULT_JSON: GETRIGUP_DEFAULT_JSON,
  RIG_TXT_NEW: RIG_TXT_NEW, RIG_TXT_SEPARATOR: RIG_TXT_SEPARATOR, RIG_NOTES: RIG_NOTES,
  STEP_ORDER: STEP_ORDER, STEP_V331: STEP_V331, STEP_COMBOS: STEP_COMBOS, stepForRef: stepForRef,
  COUNT_RULE: COUNT_RULE, COUNT_SITES: COUNT_SITES,
  LABELS: LABELS, INPUTS: INPUTS, WARN_TEXTS: WARN_TEXTS, ALARM_TEXTS: ALARM_TEXTS, textRe: textRe,
  TAGS_NEW: TAGS_NEW, NAMES_NEW: NAMES_NEW, ALARM_TAGS_NEW: ALARM_TAGS_NEW, ALARMS: ALARMS, ALARM_IDS: ALARM_IDS,
  Q_CK2: Q_CK2, Q_SEPBY: Q_SEPBY, Q_CUSH: Q_CUSH, ESD_TRIP_IDS: ESD_TRIP_IDS, LOG_EVENT_IDS_NEW: LOG_EVENT_IDS_NEW,
  CUSHION_PHASES: CUSHION_PHASES, EVENT_CUSHION_EXAMPLE: EVENT_CUSHION_EXAMPLE,
  HIST_KEYS_V331: HIST_KEYS_V331, HIST_KEYS_NEW: HIST_KEYS_NEW, HIST_KEYS: HIST_KEYS, NODE_IDS_V331: NODE_IDS_V331, NODE_IDS: NODE_IDS,
  SEG_COUNT: SEG_COUNT, NULLABLE_NEW: NULLABLE_NEW, CUM_NEW: CUM_NEW, SNAP_CUM_NEW: SNAP_CUM_NEW,
  DEFAULTS_NEW: DEFAULTS_NEW, FEATURES: FEATURES, FLOW_SIM_NEW: FLOW_SIM_NEW, SAMPLE_FLOW_SIM_NEW: SAMPLE_FLOW_SIM_NEW,
  SAMPLE_FLOW_SIM_KEYS: SAMPLE_FLOW_SIM_KEYS, API_STATIC_NEW: API_STATIC_NEW, API_INSTANCE_NEW: API_INSTANCE_NEW,
  DESIGN_P_CK2: DESIGN_P_CK2, P_FLARE_HDR: P_FLARE_HDR, CUSHION_TUBING: CUSHION_TUBING,
  BASE_FIELDS_OMIT: BASE_FIELDS_OMIT, baseFields: baseFields,
  ANCHORS_CK2: ANCHORS_CK2, ANCHORS_CUSH: ANCHORS_CUSH, near: near, qLcapRef: qLcapRef, dEqRef: dEqRef, cushionStartRef: cushionStartRef,
  ACTIONS: ACTIONS, EXAMPLES: EXAMPLES, SHAPE_NAMES: SHAPE_NAMES, checkShape: checkShape, fakeFuSnapshot: fakeFuSnapshot,
  loadEngine: EQ.loadEngine });
