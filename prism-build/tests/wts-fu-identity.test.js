// Well Test Simulator follow-up — CK-102 heater inlet choke, bypass destination, cushion unload (docs/SIM-FOLLOWUP-PLAN.md).
// WP0 / lead (§9.2 wts-fu-identity): the frozen v3.3.1 engine (tests/_wts-sim-v331.js), the host golden of calcWTS
// (tests/_wts-calc-v331.js, prism-build/wts-calc-golden.js) and the contract fixture (tests/_wts-fu-shapes.js) are sound, and
//   (1) the frozen v3.3.1 engine and the working engine agree exactly — every v3.3.1 snapshot path ===, sig slice(0, 10)
//       equal and slice(10) '' (before WP-E0) or '0' — on scenarios a–e, (b) one per core item out, DS-101 in with flow-back,
//       T-202 in with route 'both' and both in, on SAMPLE_FLOW and on a harness-calcWTS default flow;
//   (2) the v3.3 identity tests of wts-equipment.test.js are still there (unchanged);
//   (3) the host golden: BASE_FIELDS strictly === for the 12 sets, with and without the new inputs and with a stored
//       CK-102 / V-101-out rig-up; calcWTS never reads wts_sim_rigup;
//   (4) DEFAULTS.sep.bypass.P_flare_psig === DEFAULTS.sep.pcv.P2_psig and the three features flags are equal (from 1.5.0).
// Green on the unchanged tree (WP0) and after every package (U6). Expected values: the frozen engine, the golden, or plan
// constants in the fixture.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const X = require('./_wts-fu-shapes');
const EQ = require('./_wts-equip-shapes');
const GOLD = require('../wts-calc-golden.js');
// v1.6.0 changed the T-201 default line-up; runs against a frozen engine pin the v3.3.1 one on the working engine (_wts-lineup-pin.js)
const { legacyOpts } = require('./_wts-lineup-pin.js');

const WP = 'WTSFU';
const BUILD_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(BUILD_DIR, '..');
const J = (x) => JSON.parse(JSON.stringify(x));
const quietLog = { log() {}, warn() {} };
function gitShow(spec) {
  try { return execFileSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (e) { return null; }
}

// mid: [[t_s, fn(sim)], …] calls made during the run (mid-run setRigup); the 'rigup' events are collected (payload JSON)
function runStates(S, secs, dt, every, setup, flow, opts, mid) {
  const sim = S.create(flow, Object.assign({ seed: 7 }, S.SURGE_LINEUP ? legacyOpts(opts) : (opts || {}))), events = [];   // pin on the working engine only
  sim.on('rigup', (p) => events.push(J(p)));
  if (setup) setup(sim);
  const states = [J(sim.getState())];
  const n = Math.round(secs / dt), k = Math.round(every / dt), calls = (mid || []).map((m) => [Math.round(m[0] / dt), m[1]]);
  for (let i = 1; i <= n; i++) {
    sim.advance(dt);
    calls.forEach((c) => { if (c[0] === i) c[1](sim); });
    if (i % k === 0) states.push(J(sim.getState()));
  }
  return { sim, states, events };
}
// a 'rigup' event of the working engine vs v3.3.1: the same payload except rig.heaterChoke and the 11-character sig (§9.2 rule)
function sameRigEvents(assert, a, b, tag) {
  assert.strictEqual(b.events.length, a.events.length, tag + ' rigup event count');
  a.events.forEach((ea, i) => {
    const eb = J(b.events[i]);
    assert.ok(sigRule(ea.sig, eb.sig) === '', tag + ' event ' + i + ' sig: ' + sigRule(ea.sig, eb.sig));
    assert.ok(eb.rig.heaterChoke === false, tag + ' event ' + i + ' CK-102 out');
    delete eb.rig.heaterChoke; eb.sig = ea.sig;
    assert.strictEqual(JSON.stringify(eb), JSON.stringify(ea), tag + ' event ' + i + ' payload / msg');
  });
}
// v3.3.1 → working: identityDiff (every path of the v3.3.1 snapshot ===) plus the exact sig rule of §9.2
function sigRule(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 'sig missing';
  if (a.length !== 10) return 'v3.3.1 sig has ' + a.length + ' characters';
  if (b.slice(0, 10) !== a) return 'sig prefix ' + b.slice(0, 10) + ' vs ' + a;
  if (!(b.length === 10 || (b.length === 11 && b.charAt(10) === '0'))) return 'sig tail "' + b.slice(10) + '" (want "" or "0")';
  return '';
}
function sameStates(assert, a, b, tag) {
  assert.strictEqual(a.states.length, b.states.length, tag + ' state count');
  a.states.forEach((st, i) => {
    const d = EQ.identityDiff(st, b.states[i], 5);
    assert.ok(d.length === 0, tag + ' state ' + i + ': ' + d.join('; '));
    const sr = sigRule(st.rigup.sig, b.states[i].rigup.sig);
    assert.ok(sr === '', tag + ' state ' + i + ' sig: ' + sr);
  });
  const ha = J(X.HIST_KEYS_V331.map((k) => a.sim.getHistory(k))), hb = J(X.HIST_KEYS_V331.map((k) => b.sim.getHistory(k)));
  const dh = EQ.identityDiff(ha, hb, 5);
  assert.ok(dh.length === 0, tag + ' history: ' + dh.join('; '));
}
let HOST_FLOW = null;   // harness-calcWTS default flow (blocks present once WP-C lands; V-101 in, CK-102 out)
function hostDefaultFlow() {
  if (!HOST_FLOW) {
    // v3.4.2 (2026-11-09): the page default destination is now the surge tank T-201; this identity flow pins the burner line (C7)
    const r = GOLD.runSet(GOLD.hostRegion(), Object.assign({}, GOLD.SETS[0].vals, { wts_sepByDest: 'flare' }));
    if (!r.flow) throw new Error('calcWTS published no flow');
    HOST_FLOW = J(r.flow);
  }
  return J(HOST_FLOW);
}

module.exports = [
  {
    name: 'WTSFU frozen v3.3.1 engine: tests/_wts-sim-v331.js is 31-wts-sim.js at 3611343 with the self-test stripped, in its own context',
    wp: WP,
    opts: false,
    run(app, assert) {
      const frozen = fs.readFileSync(path.join(__dirname, '_wts-sim-v331.js'), 'utf8');
      assert.ok(/^\/\/ prism-build\/tests\/_wts-sim-v331\.js — FROZEN copy/.test(frozen), 'header names the frozen copy');
      assert.ok(/3611343/.test(frozen.slice(0, 700)), 'header names the origin commit');
      const orig = gitShow('3611343:prism-build/31-wts-sim.js');
      if (orig) {
        const body = frozen.slice(frozen.indexOf('\n// ====') + 1);
        const want = require(path.join(BUILD_DIR, 'concat-round7.js')).stripSelfTest(orig, '31-wts-sim.js', quietLog);
        assert.ok(body === want, 'frozen body = stripSelfTest(3611343:prism-build/31-wts-sim.js)');
        const sha = require('crypto').createHash('sha256').update(orig).digest('hex');
        assert.ok(frozen.slice(0, 700).indexOf(sha) > 0, 'header carries the sha256 of the origin source');
      }
      const A = EQ.loadEngine('v331'), B = EQ.loadEngine('v331');
      assert.strictEqual(A.VERSION, X.VERSION_V331);
      assert.ok(A !== B && A.create !== B.create, 'each loadEngine call is a separate context');
      assert.ok(!('WTS_sim' in globalThis), 'nothing leaks into the test realm');
      assert.deepStrictEqual(J(A.RIG_KEYS), X.RIG_KEYS_V331);
      assert.strictEqual(A.normRigup({}).sig, X.SIG_V331);
      // the v3.3 frozen copy stays (D13)
      assert.ok(fs.existsSync(path.join(__dirname, '_wts-sim-v33.js')) && EQ.loadEngine('v33').VERSION === EQ.VERSION_V33, '_wts-sim-v33.js stays');
    },
  },
  {
    name: 'WTSFU frozen v3.3.1 host: _wts-calc-v331-src.js is the calcWTS region at 3611343; the golden is complete and decodes',
    wp: WP,
    opts: false,
    run(app, assert) {
      const F = require('./_wts-calc-v331-src.js');
      assert.strictEqual(F.ORIGIN, '3611343');
      const sha = require('crypto').createHash('sha256').update(F.SRC).digest('hex');
      assert.strictEqual(sha, F.SHA256, 'SHA256 of SRC');
      const html = gitShow('3611343:well-testing-app.html');
      if (html) assert.ok(GOLD.region(html) === F.SRC, 'SRC = the calcWTS region of 3611343:well-testing-app.html');
      assert.ok(/window\.calcWTS=function\(\)\{/.test(F.SRC) && /^const WTS_PIPES=/.test(F.SRC), 'region bounds');
      const G = GOLD.loadGolden();
      assert.strictEqual(G.origin, '3611343');
      assert.deepStrictEqual(G.sets.map((s) => s.name), GOLD.SETS.map((s) => s.name), '12 sets in tool order');
      assert.strictEqual(G.sets.length, 12);
      assert.deepStrictEqual(J(G.omit), X.BASE_FIELDS_OMIT, 'golden omit list = BASE_FIELDS_OMIT');
      // v3.4.2 (2026-11-09): the tool also omits the LP flare line block and its three flow.sim inputs (appended, C17)
      assert.deepStrictEqual(GOLD.BASE_FIELDS_OMIT, X.BASE_FIELDS_OMIT.concat(['lp', 'sim.lpNps', 'sim.lpSch', 'sim.lpLen_ft']), 'tool omit list = BASE_FIELDS_OMIT + the v3.4.2 LP keys');
      // the golden numbers carry the Help page checks (FS-1 (a)–(e), FS-2) and the anchor base rows
      const by = {}; G.sets.forEach((s) => { by[s.name] = GOLD.decode(s.flow); });
      const near = (a, b, t) => Math.abs(a - b) <= t;
      assert.ok(near(by.defaults.choke.Pout, 157.7, 0.05) && near(by.defaults.choke.ratio, 0.0572, 0.0001) && by.defaults.choke.regime === 'Critical', 'FS-2 / FS-1 (e)');
      assert.ok(near(by.fs1a.choke.Pout, 20.5, 0.05) && near(by.fs1a.choke.QmaxMMscfd, 1.78, 0.01) && by.fs1a.warnings.length === 1, 'FS-1 (a)');
      assert.ok(by.fs1b.warnings.length === 0 && by.fs1c.choke.flowLimited && near(by.fs1c.choke.QmaxMMscfd, 0.25, 0.005), 'FS-1 (b), (c)');
      assert.ok(near(by.fs1d.choke.Pout, 24.1, 0.05) && near(by.fs1d.choke.QmaxMMscfd, 7.21, 0.01) && by.fs1d.warnings.length === 0, 'FS-1 (d)');
      assert.ok(by.whp60.choke.regime === 'No Flow' && by.bean16.choke.flowLimited && by.heaterBypass.heater.bypass === true, 'other sets');
      const b0 = X.ANCHORS_CK2.find((a) => a.id === 'baseDefaults');
      assert.ok(near(by.defaults.choke.Pout, b0.Pco, 1e-4) && near(by.defaults.heater.Tin, b0.Thi, 0.001) && near(by.defaults.heater.dutyMMBtuHr, b0.duty, 0.0001) &&
        near(by.defaults.choke.QcritMMscfd, b0.QcritMMscfd, 0.0001), 'ANCHORS_CK2 baseDefaults = the golden defaults');
      // the encoder keeps -0, NaN, ±Infinity and undefined
      const e = GOLD.decode(J(GOLD.encode({ a: -0, b: NaN, c: Infinity, d: -Infinity, e: undefined, f: [1, -0] })));
      assert.ok(Object.is(e.a, -0) && Number.isNaN(e.b) && e.c === Infinity && e.d === -Infinity && 'e' in e && e.e === undefined && Object.is(e.f[1], -0), 'encode / decode');
      assert.ok(GOLD.compare({ x: 0 }, { x: -0 }).length === 1 && GOLD.compare({ x: 1 }, { x: 1, y: 2 }).length === 1 && GOLD.compare({ x: NaN }, { x: NaN }).length === 0, 'compare is strict');
    },
  },
  {
    name: 'WTSFU host golden (3): calcWTS BASE_FIELDS === v3.3.1 for the 12 sets, with and without the new inputs and a stored CK-102 / V-101-out rig-up; never reads wts_sim_rigup',
    wp: WP,
    opts: false,
    timeoutMs: 240000,
    run(app, assert) {
      const r = GOLD.check();
      assert.ok(r.pass, 'golden check: ' + r.failures.slice(0, 8).join(' | '));
      assert.strictEqual(r.sets, 12);
      assert.strictEqual(r.variants, 12 * 5, 'plain, three new-input variants, stored rig-up');
      // storage spy: a stored rig-up is present and calcWTS does not read it
      const one = GOLD.runSet(GOLD.hostRegion(), Object.assign({}, GOLD.SETS[0].vals, GOLD.NEW_INPUTS[1]), { storage: { wts_sim_rigup: GOLD.RIG_CK2_V101OUT } });
      assert.ok(one.reads.indexOf('wts_sim_rigup') < 0, 'calcWTS reads: ' + one.reads.join(','));
      assert.strictEqual(one.events.length, 1, 'one wts:calc dispatch');
      // a CK-102 / V-101-out rig-up or the new inputs never move the base (the flow blocks are the only additions)
      const base = GOLD.baseFields(one.flow), g = GOLD.decode(GOLD.loadGolden().sets[0].flow);
      assert.ok(GOLD.compare(g, base).length === 0, 'defaults with new inputs and a stored rig-up');
      // the fixture's baseFields rule = the tool's (same omissions)
      const f = J(one.flow); f.ck2 = { v: 1 }; f.sepBy = { v: 1 }; f.sim.sepByDest = 'line'; f.sim.sepByP_psig = 3; f.ts = 1; f.seq = 9;
      // v3.4.2: the fixture rule plus the LP keys (flow.lp, flow.sim.lpNps / lpSch / lpLen_ft) = the tool's
      const xf = X.baseFields(f); delete xf.lp; ['lpNps', 'lpSch', 'lpLen_ft'].forEach((k) => { delete xf.sim[k]; });
      assert.deepStrictEqual(xf, J(GOLD.baseFields(f)), 'fixture baseFields (+ v3.4.2 LP keys) = tool baseFields');
    },
  },
  {
    name: 'WTSFU contract fixture: rig-up row, defaults, sig, step numbers, alarms and quiet lists, labels, history and node lists, shapes and fakeFuSnapshot',
    wp: WP,
    opts: false,
    run(app, assert) {
      // rig-up
      assert.deepStrictEqual(X.RIG_KEYS.slice(0, 10), X.RIG_KEYS_V331, 'RIG_KEYS append only');
      assert.strictEqual(X.RIG_KEYS[10], 'heaterChoke');
      assert.deepStrictEqual(Object.keys(X.RIG_DEFAULTS), X.RIG_KEYS, 'RIG_DEFAULTS in signature order');
      assert.strictEqual(X.RIG_KEYS.map((k) => (X.RIG_DEFAULTS[k] ? '1' : '0')).join(''), X.SIG_DEFAULT);
      assert.strictEqual(X.SIG_DEFAULT, EQ.SIG_DEFAULT, 'equip fixture SIG_DEFAULT is the 11-character default');
      assert.strictEqual(X.SIG_DEFAULT.length, 11);
      assert.deepStrictEqual(X.RIG_ORDER.slice().sort(), X.RIG_KEYS.slice().sort(), 'display order is a permutation of RIG_KEYS');
      assert.ok(X.RIG_ORDER.indexOf('heaterChoke') === X.RIG_ORDER.indexOf('choke') + 1, 'CK-102 after CK-101 in process order');
      assert.strictEqual(X.RIG_ITEM_NEW.name, X.LABELS.rigItem);
      assert.strictEqual(X.NAMES_NEW.heaterChoke, X.LABELS.rigItem);
      assert.deepStrictEqual(X.RIG_OPTIONAL, EQ.RIG_OPTIONAL.concat(['heaterChoke']));
      assert.ok(X.RIG_ITEM_NEW.optional === true && X.RIG_ITEM_NEW.def === false && X.RIG_ITEM_NEW.needs === 'heater', 'optional, out by default, needs H-101');
      // sig helpers of the equip fixture (§3.6)
      const S331 = EQ.loadEngine('v331');
      assert.strictEqual(EQ.sigDefaultOf(S331), X.SIG_V331, 'sigDefaultOf(v3.3.1) = 10 characters');
      assert.strictEqual(EQ.sigDefaultOf({ VERSION: X.VERSION_NEW }), X.SIG_DEFAULT, 'sigDefaultOf(1.5.0) = 11 characters');
      const ru = J(S331.create(S331.SAMPLE_FLOW, { seed: 1 }).getState().rigup);
      assert.ok(EQ.checkShape('rigup', ru, { strict: true }).ok, 'v3.3.1 rigup passes the equip shape');
      const ru11 = Object.assign({}, ru, { heaterChoke: false, sig: ru.sig + '0' });
      assert.ok(EQ.checkShape('rigup', ru11, { strict: true, rigKeys: X.RIG_KEYS }).ok, 'an 11-key rigup passes with rigKeys: ' + EQ.checkShape('rigup', ru11, { strict: true, rigKeys: X.RIG_KEYS }).errors.join('; '));
      assert.ok(!EQ.checkShape('rigup', ru11, { strict: true }).ok, 'without rigKeys the extra key is unexpected');
      assert.ok(!EQ.checkShape('rigup', Object.assign({}, ru11, { sig: ru.sig }), { rigKeys: X.RIG_KEYS }).ok, 'sig length must follow rigKeys');
      assert.ok(!EQ.checkShape('rigup', Object.assign({}, ru11, { heaterChoke: true }), { rigKeys: X.RIG_KEYS }).ok, 'character 10 must agree with heaterChoke');
      assert.ok(EQ.identityDiff({ rigup: { sig: X.SIG_V331 } }, { rigup: { sig: X.SIG_DEFAULT } }).length === 0, 'identityDiff: v3.3.1 → 11 characters');
      assert.ok(EQ.identityDiff({ rigup: { sig: X.SIG_V331 } }, { rigup: { sig: '11111111001' } }).length === 1, 'identityDiff rejects CK-102 in');
      // step numbers (§3.5)
      X.STEP_COMBOS.forEach((c) => assert.deepStrictEqual(X.stepForRef(c.rig), c.step, 'stepFor ' + c.name));
      assert.deepStrictEqual(X.stepForRef({}), J(S331.stepFor({})), 'default numbering = v3.3.1 stepFor');
      assert.deepStrictEqual(X.stepForRef({ heaterChoke: 'yes' }), X.STEP_V331, 'only strict true counts');
      // alarms (D12) and quiet lists
      assert.strictEqual(X.ALARM_IDS.length, 11);
      assert.deepStrictEqual(X.Q_CK2.concat(X.Q_SEPBY, X.Q_CUSH).slice().sort(), X.ALARM_IDS.slice().sort(), 'every new alarm id is in exactly one quiet list');
      assert.strictEqual(new Set(X.Q_CK2.concat(X.Q_SEPBY, X.Q_CUSH)).size, X.ALARM_IDS.length, 'no id twice');
      X.ALARM_IDS.forEach((id) => {
        assert.ok(['trip', 'alarm', 'warn', 'hyd'].indexOf(X.ALARMS[id].sev) >= 0, id + ' sev');
        assert.ok(EQ.ALARM_IDS.indexOf(id) < 0, id + ' is new');
      });
      assert.deepStrictEqual(X.ALARM_IDS.filter((id) => X.ALARMS[id].esd), X.ESD_TRIP_IDS, 'only PSHH-104 trips SDV-101');
      // lists
      assert.deepStrictEqual(X.HIST_KEYS.slice(0, X.HIST_KEYS_V331.length), X.HIST_KEYS_V331);
      assert.deepStrictEqual(X.HIST_KEYS_NEW, ['Pck2', 'cushionLeft']);
      const st = J(S331.create(S331.SAMPLE_FLOW, { seed: 3 }).getState());
      assert.deepStrictEqual(Object.keys(st.nodes), X.NODE_IDS_V331, 'v3.3.1 node order');
      assert.strictEqual(X.NODE_IDS.indexOf('heaterChoke'), 10);
      assert.strictEqual(st.segs.length, X.SEG_COUNT);
      assert.strictEqual(X.SAMPLE_FLOW_SIM_KEYS.length, 9, '9 flow.sim keys after the v3.3 five');
      assert.deepStrictEqual(Object.keys(J(S331.SAMPLE_FLOW.sim)).slice(5), Object.keys(EQ.SAMPLE_FLOW_SIM), 'v3.3.1 SAMPLE_FLOW.sim = the five + seven');
      X.NULLABLE_NEW.forEach((p) => assert.ok(J(S331.NULLABLE).indexOf(p) < 0, p + ' is new in NULLABLE'));
      assert.strictEqual(X.DEFAULTS_NEW.sepBypass.P_flare_psig, J(S331.DEFAULTS).sep.pcv.P2_psig, 'burner-line P0 = the v3.3.1 PCV outlet setting (identity, D3)');
      assert.strictEqual(X.P_FLARE_HDR, X.DEFAULTS_NEW.sepBypass.P_flare_psig);
      assert.ok(X.FEATURES.heaterChoke === X.FEATURES.bypassDest && X.FEATURES.bypassDest === X.FEATURES.cushion, 'features equal (D14)');
      // labels and inputs (D17, §4.1)
      assert.deepStrictEqual(X.INPUTS.map((i) => i.id), ['wts_bean2', 'wts_ck2Pos', 'wts_sepByDest', 'wts_sepByP']);
      assert.deepStrictEqual(X.INPUTS.map((i) => i.label), [X.LABELS.bean2, X.LABELS.ck2Pos, X.LABELS.sepByDest, X.LABELS.sepByP]);
      assert.deepStrictEqual(Object.keys(X.LABELS.sepByDestOptions), ['flare', 'line']);
      assert.ok(X.textRe(X.WARN_TEXTS.ck2Limit).test('CK-102 limits the rate: bean 32/64 passes 8.92 of 10.00 MMscf/d — open CK-102 or reduce the rate'), 'textRe');
      assert.ok(!X.textRe(X.WARN_TEXTS.ck2Limit).test('CK-101 limits the rate'), 'textRe rejects');
      // the 3D → 38 payloads
      assert.deepStrictEqual(X.ACTIONS.bean2Minus, { type: 'bean', eq: 'heaterChoke', d: -4 });
      assert.deepStrictEqual(X.ACTIONS.cushionStart, { type: 'cushion', cmd: 'start' });
      // shapes: examples pass strictly; the segment example has the keys of a real host segment
      [['flow.ck2', 'flowCk2'], ['flow.ck2', 'flowCk2Skipped'], ['flow.sepBy', 'flowSepBy'], ['nodes.heaterChoke', 'nodesHeaterChoke'],
        ['nodes.heaterChoke', 'nodesHeaterChokeOut'], ['cushion', 'cushion'], ['cushion', 'cushionOff'], ['sepBy', 'sepBy'], ['sepBy', 'sepByLine']].forEach(([n, e]) => {
        const c = X.checkShape(n, X.EXAMPLES[e], { strict: true });
        assert.ok(c.ok, n + ' / ' + e + ': ' + c.errors.join('; '));
      });
      const g0 = GOLD.decode(GOLD.loadGolden().sets[0].flow);
      assert.deepStrictEqual(Object.keys(X.EXAMPLES.flowCk2.segs[0]).sort(), Object.keys(g0.segs[2]).sort(), 'flow.ck2.segs[0] has the keys of flow.segs[2]');
      assert.deepStrictEqual(Object.keys(X.EXAMPLES.flowSepBy.choke).sort(), Object.keys(g0.choke).sort(), 'flow.sepBy.choke has the keys of flow.choke');
      const sb = X.EXAMPLES.flowSepBy; sb.ck2 = X.EXAMPLES.flowCk2;
      assert.ok(X.checkShape('flow.sepBy', sb, { strict: true }).ok, 'flow.sepBy.ck2 = a flow.ck2');
      const bad = X.EXAMPLES.cushion; bad.phase = 'flying'; bad.V_bbl = NaN;
      assert.strictEqual(X.checkShape('cushion', bad).errors.length, 2, 'enum and finite checks');
      // fakeFuSnapshot over a real v3.3.1 snapshot and a bare skeleton
      [null, st].forEach((base, bi) => {
        [{}, { ck2: true }, { ck2: true, bypassed: true }, { ck2: true, pos: 'midcoil' }, { sepOut: true, dest: 'line', P: 300, flareOut: true, cushion: 'tail' },
          { sepOut: true, cushion: 'unloading' }, { cushion: 'stalled' }, { ck2: true, cushion: 'done' }].forEach((o) => {
          const f = X.fakeFuSnapshot(base, o), tag = 'base ' + bi + ' ' + JSON.stringify(o);
          ['nodes.heaterChoke', 'cushion', 'sepBy'].forEach((n) => {
            const v = n === 'nodes.heaterChoke' ? f.nodes.heaterChoke : f[n.split('.')[0]];
            const c = X.checkShape(n, v, { strict: true });
            assert.ok(c.ok, tag + ' ' + n + ': ' + c.errors.join('; '));
          });
          assert.strictEqual(f.rigup.sig.length, 11, tag + ' sig');
          assert.strictEqual(f.rigup.heaterChoke, o.ck2 === true, tag + ' rigup.heaterChoke');
          assert.strictEqual(f.nodes.heaterChoke.active, o.ck2 === true && o.bypassed !== true, tag + ' active');
          assert.strictEqual(f.nodes.heaterChoke.bypassed, o.ck2 === true && o.bypassed === true, tag + ' bypassed');
          assert.ok((f.inputs.bean2 === null) === (o.ck2 !== true), tag + ' inputs.bean2 nullable');
          X.SNAP_CUM_NEW.forEach((k) => assert.strictEqual(typeof f.cum[k], 'number', tag + ' cum.' + k));
          if (bi === 1) {
            const rigChanged = o.ck2 === true || o.sepOut === true;   // CK-102 in / V-101 out change rigup.sig, extras, separator, flare
            const d = EQ.identityDiff(st, f).filter((e) => !(rigChanged && /^rigup\./.test(e)));
            assert.ok(d.length === 0, tag + ' every v3.3.1 path kept: ' + d.join('; '));
            assert.ok(EQ.checkShape('rigup', f.rigup, { strict: true, rigKeys: X.RIG_KEYS }).ok, tag + ' rigup 11 keys');
          }
        });
      });
      assert.ok(X.fakeFuSnapshot(null, { sepOut: true, dest: 'flare', flareOut: true }).rigup.flare !== false, 'FS-401 stays in with dest flare');
      assert.strictEqual(X.fakeFuSnapshot(st, { ck2: true }).nodes.choke.P, st.nodes.choke.P, 'the choke outlet does not move');
      // the WP0 files carry no competitor abbreviation and no web address
      const txt = ['tests/_wts-fu-shapes.js', 'tests/wts-fu-identity.test.js', 'wts-calc-golden.js', 'wts-sim-perf.js']
        .map((f) => fs.readFileSync(path.join(BUILD_DIR, f), 'utf8')).join('\n');
      const banned = new RegExp('\\b' + String.fromCharCode(80, 73, 69) + '\\b');   // the abbreviation CLAUDE.md forbids
      assert.ok(!banned.test(txt) && !/https?:\/\//.test(txt), 'no forbidden names or URLs');
      // COUNT_SITES (§3.6)
      assert.ok(X.COUNT_SITES.length > 0, 'COUNT_SITES recorded');
      X.COUNT_SITES.forEach((c) => {
        assert.ok(['rig', 'not', 'frozen', 'done'].indexOf(c.kind) >= 0 && typeof c.file === 'string' && c.line > 0 && typeof c.text === 'string', 'site ' + JSON.stringify(c));
        assert.ok(fs.existsSync(path.join(ROOT, c.file)), c.file + ' exists');
        if (c.kind === 'rig') assert.ok(typeof c.owner === 'string' && c.owner.length > 0 && typeof c.change === 'string', 'rig site has an owner and a change: ' + c.file + ':' + c.line);
      });
    },
  },
  {
    name: 'WTSFU anchors: the closed forms of §6.3 reproduce ANCHORS_CUSH on SAMPLE_FLOW; ANCHORS_CK2 are complete and consistent',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = EQ.loadEngine('v331'), F = J(S.SAMPLE_FLOW), D = J(S.DEFAULTS);
      const o = { Pwh: F.nodes[0].P, Twh: F.nodes[0].T, Qg: F.inputs.Qg, Qo: F.inputs.Qo, Qw: F.inputs.Qw, SGg: F.inputs.SGg, SIT: D.ramp.sithpFactor * F.nodes[0].P,
        floor: F.nodes[4].P + X.DEFAULTS_NEW.cushion.stallMargin_psi };
      const c0 = X.cushionStartRef(o), A = {};
      X.ANCHORS_CUSH.forEach((a) => { A[a.id] = a; });
      assert.ok(X.near(A.fUnload0, c0.fUnload), 'fUnload0 ' + c0.fUnload);
      assert.ok(X.near(A.column0, c0.column_ft), 'column0 ' + c0.column_ft);
      assert.ok(X.near(A.WHPstart, c0.WHPtgt), 'WHPstart ' + c0.WHPtgt);
      assert.ok(X.near(A.floor, o.floor), 'floor');
      assert.ok(X.near(A.WHPendMain, o.SIT - (o.SIT - o.Pwh) * c0.fUnload), 'WHPendMain');
      const nl = X.cushionStartRef(Object.assign({}, o, A.nolift.inputs));
      assert.ok(X.near(A.nolift, nl.WHPcol) && nl.WHPcol < o.floor, 'NOLIFT column law below the floor ' + nl.WHPcol);
      assert.ok(X.near(A.qLcap32, X.qLcapRef.apply(null, A.qLcap32.args)) && X.near(A.qLcap12, X.qLcapRef.apply(null, A.qLcap12.args)), 'qLcap');
      assert.ok(X.qLcapRef(32, 1550, 1.03) > 1500 && X.qLcapRef(12, 1550, 1.03) < 0.99 * 1500, 'CUSH_LIMIT at 12/64, not at 32/64');
      assert.ok(X.near(A.dEq32_128, X.dEqRef(32, 128)), 'dEq');
      assert.ok(X.qLcapRef(X.dEqRef(32, 128), 1550, 1.03) / X.qLcapRef(32, 1550, 1.03) > 0.99, 'CK-102 128/64: qLcap within 1 % of CK-101 alone');
      // tBreak: 42.5 bbl delivered through the τf lag: t·qT − qT·τf·(1 − e^{−t/τf}) = Vmain
      const qT = X.DEFAULTS_NEW.cushion.q_bpd / 86400, tau = D.ramp.tauFlow, Vm = c0.Vmain;
      assert.ok(Math.abs(A.tBreak.value - (Vm / qT + tau)) < 0.01, 'tBreak closed form');
      assert.ok(Math.abs(A.Vtail.value - (X.DEFAULTS_NEW.cushion.V_bbl - Vm - tau * qT)) < 1e-3, 'Vtail closed form');
      assert.ok(Math.abs(A.waterIn1h.value - (qT * 3600 - qT * tau)) < 1e-3 && Math.abs(A.waterIn1h.value / 62.5 - 1) < 0.01, 'water in after 1 h');
      const gas = X.DEFAULTS_NEW.cushion.gasFrac * F.inputs.Qg * 1e6 / 86400 * 14.696 * 28.97 * F.inputs.SGg / (10.73 * 519.67) * 0.56;
      assert.ok(X.near(A.wJTc, gas / (gas + 14.6 / 3600 * X.DEFAULTS_NEW.cushion.SG * X.DEFAULTS_NEW.cushion.q_bpd)), 'wJTc');
      // ANCHORS_CK2: ids, the rule of thumb (CK-101 critical while bean2 ≥ about 1.35 × bean1), monotone Pm in bean2
      const K = {}; X.ANCHORS_CK2.forEach((a) => { K[a.id] = a; });
      ['bean48', 'bean48mid', 'bean40', 'bean32', 'bean24', 'bean4', 'bean64', 'bean96', 'bothPsep1500b40', 'bothPsep1500b32', 'dryGas48', 'liquidOnly', 'blockedIn', 'baseDefaults']
        .forEach((id) => assert.ok(K[id], 'anchor ' + id));
      assert.ok(K.bean48.ck1 === 'Critical' && K.bean40.ck1 === 'Subcritical' && 48 >= 1.35 * 32 && 40 < 1.35 * 32, 'rule of thumb 1.35 × bean1');
      assert.ok(K.bean32.Pm > K.bean40.Pm && K.bean40.Pm > K.bean48.Pm && K.bean48.Pm > K.bean64.Pm && K.bean64.Pm > K.bean96.Pm, 'Pm falls as CK-102 opens');
      assert.ok(K.bean48mid.Pm === K.bean48.Pm && K.bean48mid.duty === K.bean48.duty && K.bean48mid.TmOut > K.bean48.TmOut, 'midcoil: same P and duty, warmer CK-102 outlet');
      assert.ok(K.bean48mid.TmIn <= 150 - K.bean48mid.Tp1MaxBelowTho + 1e-9, 'Tp1 ≤ Tho − 25');
      assert.ok(Math.abs(K.dryGas48.dT1 + K.dryGas48.dT2 - 150) < 0.01 && Math.abs(K.dryGas48.TmOut - K.dryGas48.baseTin) <= K.dryGas48.tolTinAbs &&
        Math.abs(K.dryGas48.duty / K.dryGas48.baseDuty - 1) <= K.dryGas48.tolDutyRel, 'dry-gas cumulative cap');
      assert.ok(K.bothPsep1500b40.limiter === 'both' && K.bothPsep1500b32.limiter === 'both' && K.bean32.limiter === 'CK-102' && K.bean48.limiter === 'CK-101', 'limiters');
      assert.ok(K.bean32.flowLimited && K.bean32.QmaxPair < 10 && !K.bean40.flowLimited && K.bean40.QmaxPair > 10 * 1.01, 'pair margin 1.01');
      assert.ok(K.blockedIn.sit > X.DESIGN_P_CK2 && K.blockedIn.ratingOK === false, 'blocked-in');
    },
  },
  {
    name: 'WTSFU (1) v3.3.1 identity (U6): frozen v3.3.1 vs working engine, scenarios a–e, core items out, DS-101 / T-202 in, on SAMPLE_FLOW and a calcWTS flow',
    wp: WP,
    opts: false,
    timeoutMs: 900000,
    run(app, assert) {
      const A = EQ.loadEngine('v331'), B = EQ.loadEngine('work');
      const sample = J(B.SAMPLE_FLOW), host = hostDefaultFlow();
      assert.ok(host.v === 1 && host.nodes.length === 8 && host.choke.regime === 'Critical', 'calcWTS default flow');
      // SAMPLE_FLOW has no ck2 / sepBy block (D3); a host flow may carry them once WP-C lands
      assert.ok(!('ck2' in sample) && !('sepBy' in sample), 'SAMPLE_FLOW has no flow blocks');
      assert.ok(host.ck2 && host.ck2.skipped === false && host.sepBy && host.sepBy.dest === 'flare', 'the calcWTS default flow carries flow.ck2 and flow.sepBy (WP-C)');
      const scen = [
        { name: '(a) 4 h default dt 10', secs: 4 * 3600, dt: 10, every: 1200 },
        { name: '(c) T-201 A/B divert with auto-divert', secs: 2 * 3600, dt: 5, every: 600, setup: (s) => { s.setAutoDivert('surge', true, { sp: 0.6 }); s.setValve('surge', 1, false); } },
        { name: '(d) oilDumpStuckOpen', secs: 3600, dt: 5, every: 600, setup: (s) => s.setFault('oilDumpStuckOpen', true) },
        { name: '(d) xferStuckClosed', secs: 3600, dt: 5, every: 600, setup: (s) => s.setFault('xferStuckClosed', true) },
        { name: '(e) ESD trip and reset', secs: 1200, dt: 2, every: 200, setup: (s) => s.tripESD('test'), after: true },
        { name: 'DS-101 in with sand flow-back', secs: 3600, dt: 5, every: 600, opts: { rigup: { desander: true } }, setup: (s) => s.setFault('sandFlowback', true) },
        { name: "T-202 in, route 'both'", secs: 3600, dt: 5, every: 600, opts: { rigup: { surge2: true } }, setup: (s) => s.setSurgeRoute('both') },
        { name: 'DS-101 and T-202 in', secs: 3600, dt: 10, every: 900, opts: { rigup: { desander: true, surge2: true } } },
      ];
      ['heater', 'separator', 'surge', 'gauge', 'pump', 'flare'].forEach((k) => {
        const rig = {}; rig[k] = false;
        scen.push({ name: '(b) 1 h without ' + k, secs: 3600, dt: 10, every: 900, opts: { rigup: rig }, sepOut: k === 'separator' });
      });
      // mid-run setRigup (log and 'rigup' event text, not only create-time rig-ups): V-101 out then in (dest 'flare': the
      // v1.4.0 separator text), H-101 out then in, V-101 and FS-401 out together (FS-401 re-forced, its note)
      scen.push({ name: 'mid-run V-101 out, back in', secs: 2400, dt: 10, every: 300, sepOut: true, mid: [[600, (s) => s.setRigup({ separator: false })], [1800, (s) => s.setRigup({ separator: true })]] });
      scen.push({ name: 'mid-run H-101 out, back in', secs: 2400, dt: 10, every: 300, mid: [[600, (s) => s.setRigup({ heater: false })], [1800, (s) => s.setRigup({ heater: true })]] });
      scen.push({ name: 'mid-run V-101 + FS-401 out', secs: 1800, dt: 10, every: 300, sepOut: true, mid: [[600, (s) => s.setRigup({ separator: false, flare: false })]] });
      // V-101 out on a host flow: the D3 change (whole-stream back pressure from flow.sepBy) is intended for every host flow
      // (plan Release row), so these scenarios run the calcWTS flow without its sepBy block (an old flow: the v3.3.1 law);
      // the destination law itself is tested in wts-bypass-cushion (WP-C note)
      const noSepBy = (f) => { const c = J(f); delete c.sepBy; return c; };
      [['SAMPLE_FLOW', sample], ['calcWTS default flow', host]].forEach(([fn, flow0]) => {
        scen.forEach((sc) => {
          const flow = sc.sepOut && 'sepBy' in flow0 ? noSepBy(flow0) : flow0;
          const a = runStates(A, sc.secs, sc.dt, sc.every, sc.setup, J(flow), sc.opts, sc.mid);
          const b = runStates(B, sc.secs, sc.dt, sc.every, sc.setup, J(flow), sc.opts, sc.mid);
          sameStates(assert, a, b, sc.name + ' / ' + fn);
          sameRigEvents(assert, a, b, sc.name + ' / ' + fn);
          if (sc.after) {
            const ra = a.sim.resetESD(), rb = b.sim.resetESD();
            assert.strictEqual(JSON.stringify(ra), JSON.stringify(rb), 'resetESD result');
            for (let i = 0; i < 60; i++) { a.sim.advance(10); b.sim.advance(10); }
            const d = EQ.identityDiff(J(a.sim.getState()), J(b.sim.getState()), 5);
            assert.ok(d.length === 0, sc.name + ' / ' + fn + ' after the reset: ' + d.join('; '));
          }
        });
        // mid-run CK-102 in, then out, on a flow without a CK-102 block (in line with ΔP 0): v3.3.1 ignores the key, the working
        // engine logs two rig-up entries, fires two 'rigup' events and — as v3.3.1 does on every effective rig-up change —
        // re-derives with a bumpless controller re-initialisation, so the trajectory is not === after the first change (the
        // noise draws shift). Checked here: the log and event text, and the v3.3.1 log entries (type, id, message) in order
        const ck = [[600, (s) => s.setRigup({ heaterChoke: true })], [1500, (s) => s.setRigup({ heaterChoke: false })]];
        const flowNoCk2 = J(flow0); delete flowNoCk2.ck2;   // the host flow carries flow.ck2 since WP-C: take it out here
        const a = runStates(A, 2400, 10, 300, null, J(flowNoCk2), null, ck), b = runStates(B, 2400, 10, 300, null, J(flowNoCk2), null, ck);
        const tag = 'mid-run CK-102 in, out / ' + fn;
        assert.strictEqual(a.events.length, 0, tag + ': v3.3.1 ignores heaterChoke');
        assert.ok(b.events.length === 2 && /CK-102 in line on the H-101 inlet/.test(b.events[0].msg) && /CK-102 out of the rig-up/.test(b.events[1].msg),
          tag + ' events: ' + b.events.map((e) => e.msg).join(' | '));
        const la = a.sim.getState().alarmLog, lb = b.sim.getState().alarmLog;
        const ck2Log = lb.filter((e) => e.id === 'RIGUP' && /CK-102/.test(e.msg)).map((e) => e.msg);
        assert.deepStrictEqual(J(ck2Log), ['Rig-up: CK-102 in line on the H-101 inlet (full rig-up)', 'Rig-up: CK-102 out of the rig-up (full rig-up)'], tag + ' log text: ' + JSON.stringify(ck2Log));
        const idm = (l) => l.map((e) => e.type + ' ' + e.id + ' ' + e.msg).join('\n');
        assert.strictEqual(idm(lb.filter((e) => !(e.id === 'RIGUP' && /CK-102/.test(e.msg)))), idm(la), tag + ': the v3.3.1 log entries');
        assert.strictEqual(b.states[b.states.length - 1].rigup.sig, X.SIG_DEFAULT, tag + ': CK-102 out at the end');
      });
    },
  },
  {
    name: 'WTSFU (2) + (4): the v3.3 identity tests stay; DEFAULTS.sep.bypass.P_flare_psig = DEFAULTS.sep.pcv.P2_psig and the features flags are equal (from 1.5.0)',
    wp: WP,
    opts: false,
    run(app, assert) {
      const eqSrc = fs.readFileSync(path.join(__dirname, 'wts-equipment.test.js'), 'utf8');
      ["WTSEQ identity baseline: frozen v3.3 and working engine agree exactly", 'WTSEQ E0 frozen-engine identity (U6)'].forEach((n) =>
        assert.ok(eqSrc.indexOf(n) >= 0, 'wts-equipment.test.js keeps "' + n + '"'));
      assert.ok(/loadEngine\('v33'\)/.test(eqSrc), 'v3.3 identity still runs against _wts-sim-v33.js');
      const B = EQ.loadEngine('work'), D = J(B.DEFAULTS);
      if (B.VERSION === X.VERSION_V331) {
        // before WP-E0: none of the new contract is there yet (the working engine is v3.3.1)
        assert.ok(D.sep.bypass === undefined && D.cushion === undefined && D.heaterChoke === undefined && B.features === undefined, 'v3.3.1: no new DEFAULTS / features yet');
      } else {
        assert.strictEqual(B.VERSION, X.VERSION_NEW, 'working engine version');
        assert.strictEqual(D.sep.bypass.P_flare_psig, D.sep.pcv.P2_psig, 'burner / flare line inlet = the PCV outlet setting (identity, D3)');
        assert.strictEqual(D.sep.bypass.P_flare_psig, X.DEFAULTS_NEW.sepBypass.P_flare_psig);
        const f = J(B.features);
        assert.deepStrictEqual(Object.keys(f).sort(), Object.keys(X.FEATURES).sort(), 'features keys');
        assert.ok(f.heaterChoke === f.bypassDest && f.bypassDest === f.cushion, 'features all equal (D14): ' + JSON.stringify(f));
        assert.ok(f.bypassDest === true, 'features set by this build');
      }
    },
  },
];
