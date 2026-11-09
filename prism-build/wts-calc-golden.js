#!/usr/bin/env node
// prism-build/wts-calc-golden.js — golden and timing gate of the host steady walk calcWTS (docs/SIM-FOLLOWUP-PLAN.md D2 / D13,
// §9.2, §10; WP0, owner: lead).
//
// The host has no frozen engine, so the v3.3.1 output of calcWTS itself is the exact guard for D2 ("the base fields never
// change"). This tool runs the host calcWTS in a stub DOM (the same harness idea as wts3d-test.js runHostCalc) for 12 input
// sets written as literals below, and
//   --write   writes tests/_wts-calc-v331.js (the golden; only on the unchanged v3.3.1 tree, WP0)
//   --check   (default) compares every set with the golden: the BASE_FIELDS of flow strictly (=== on every number, string,
//             boolean and null; -0 / NaN / ±Infinity encoded), and the page output (#wts_res / #wts_warn / #wts_regime)
//             exactly; also with the four new inputs present and with wts_sim_rigup holding a CK-102 / V-101-out rig-up
//             (neither may move the base, D2)
//   --time    timing gate (§10): median of 10 runs (after 2 warm-ups; a run = RUN_CALLS calcWTS calls) of the working
//             calcWTS over the frozen v3.3.1 text (tests/_wts-calc-v331-src.js) in the same process: defaults ≤ 4.0,
//             the CK-102 + V-101-out set ≤ 6.0
//   --json    machine-readable report
// Exit: 0 pass, 1 check / gate failed, 2 tool error.
//
// The calcWTS region is the host text from the line `const WTS_PIPES=` up to `\nconst WTS_DIAG_LAYOUT` (it holds
// WTS_PIPES, WTS_IDS, renderWTS and calcWTS; WP-C keeps wtsWalk / wtsRenderResults and any helper calcWTS needs inside it).
// Storage is a fresh stub per set: wts_sim_rigup and wts_page_wts are cleared before each set (the golden must not depend on
// what a user stored), and every getItem key is recorded (a test can assert calcWTS never reads wts_sim_rigup).
// Module API (used by tests/wts-fu-identity.test.js): SETS, NEW_INPUTS, RIG_CK2_V101OUT, region(html), hostRegion(),
// frozenRegion(), makeCalc(regionSrc), runSet(regionSrc, vals, {storage}), baseFields(flow), encode(x), decode(x),
// compare(golden, actual) → ['<path>: …'], check(opts), time(opts).
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');
var HOST = path.join(ROOT, 'well-testing-app.html');
var GOLDEN = path.join(__dirname, 'tests', '_wts-calc-v331.js');
var FROZEN_SRC = path.join(__dirname, 'tests', '_wts-calc-v331-src.js');
var PLAN = 'docs/SIM-FOLLOWUP-PLAN.md';
var ORIGIN = '3611343';
var GATE_DEFAULT = 4.0, GATE_CK2_SEPBY = 6.0, RUNS = 10, WARMUPS = 2, RUN_CALLS = 20;

// ─── the 12 input sets (literals; §9.2) ──────────────────────────────────────
// BASE: the page form defaults (as wts3d-test.js runHostCalc). FS1: the Help field scenario FS-1 step-3 inputs (Help branch,
// tests/help-course.test.js FS1, copied as a plain object; no import from the unmerged branch).
var BASE = {
  wts_Pwh: '3000', wts_Twh: '180', wts_Qg: '10', wts_Qo: '1000', wts_Qw: '200', wts_SGg: '0.65', wts_API: '35', wts_bean: '32', wts_Cd: '0.85',
  wts_Thtr: '150', wts_htrEff: '80', wts_bypass: '0', wts_Psep: '150', wts_Cfac: '100', wts_eps: '0.0018', wts_sepID: '36', wts_sepL: '10',
  wts_Psurge: '25', wts_surgeCap: '100', wts_gtCap: '100',
  wts_nps1: '4', wts_sch1: '40', wts_len1: '50', wts_nps2: '4', wts_sch2: '40', wts_len2: '100', wts_nps3: '6', wts_sch3: '40', wts_len3: '200',
  wts_nps4: '6', wts_sch4: '40', wts_len4: '100', wts_nps5: '6', wts_sch5: '40', wts_len5: '300', wts_nps6: '3', wts_sch6: '40', wts_len6: '80',
  wts_sandPptb: '0', wts_sandGas: '0', wts_sandD50: '150', wts_dsRating: '10000', wts_dsAcc: '50', wts_SITHP: '', wts_surge2Cap: '100' };
var FS1 = { wts_Psep: '15', wts_Psurge: '5', wts_Qg: '0.3', wts_Qo: '0', wts_Qw: '2400', wts_Pwh: '500', wts_bean: '32' };
function mix() { var o = {}; for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; for (var k in a) o[k] = a[k]; } return o; }
var SETS = [
  { name: 'defaults', note: 'page defaults; also Help FS-1 (e) and FS-2 (default spread: Pout 157.7, P2/P1 0.057, Critical)', vals: mix(BASE) },
  { name: 'fs1a', note: 'Help FS-1 (a): FS-1 step-3 inputs with Surge Tank Pressure 25 (surge warning; Pout 20.5, Qmax 1.78)', vals: mix(BASE, FS1, { wts_Psurge: '25' }) },
  { name: 'fs1b', note: 'Help FS-1 (b): FS-1 step-3 inputs (Surge Tank Pressure 5, no warnings)', vals: mix(BASE, FS1) },
  { name: 'fs1c', note: 'Help FS-1 (c): WHP 60 (flow-limited, Qmax 0.25)', vals: mix(BASE, FS1, { wts_Pwh: '60' }) },
  { name: 'fs1c100', note: 'Help FS-1: WHP 100 (not limited, Qmax 0.387)', vals: mix(BASE, FS1, { wts_Pwh: '100' }) },
  { name: 'fs1d', note: 'Help FS-1 (d): breakthrough inputs (Pout 24.1, Qmax 7.21, no warnings)', vals: mix(BASE, FS1, { wts_Pwh: '2000', wts_Qg: '5', wts_Qo: '500', wts_Qw: '300' }) },
  { name: 'whp500', note: 'default spread at WHP 500', vals: mix(BASE, { wts_Pwh: '500' }) },
  { name: 'whp60', note: 'default spread at WHP 60', vals: mix(BASE, { wts_Pwh: '60' }) },
  { name: 'whp2000', note: 'default spread at WHP 2,000', vals: mix(BASE, { wts_Pwh: '2000' }) },
  { name: 'bean16', note: 'default spread on a 16/64 bean (flow-limited)', vals: mix(BASE, { wts_bean: '16' }) },
  { name: 'bean64', note: 'default spread on a 64/64 bean', vals: mix(BASE, { wts_bean: '64' }) },
  { name: 'heaterBypass', note: 'heater bypassed (wts_bypass 1)', vals: mix(BASE, { wts_bypass: '1' }) }];
// the four new inputs of §4.1 (WP-C adds them to the page); present in --check with these values the base must not move
// (CK-101 manifold, after v3.3.3: the adjustable leg in service with any positive-choke bean must not move the base either)
var NEW_INPUTS = [
  { wts_bean2: '48', wts_ck2Pos: 'inlet', wts_sepByDest: 'flare', wts_sepByP: '150', wts_ckLeg: 'adj', wts_beanFix: '24', wts_lpNps: '3', wts_lpSch: '40', wts_lpLen: '150' },
  { wts_bean2: '24', wts_ck2Pos: 'midcoil', wts_sepByDest: 'line', wts_sepByP: '0', wts_ckLeg: 'adj', wts_beanFix: '4', wts_lpNps: '2', wts_lpSch: '80', wts_lpLen: '10' },
  { wts_bean2: '4', wts_ck2Pos: 'inlet', wts_sepByDest: 'surge', wts_sepByP: '1400', wts_ckLeg: 'adj', wts_beanFix: '128', wts_lpNps: '4', wts_lpSch: '40', wts_lpLen: '5000' }];
// a stored rig-up with CK-102 in and V-101 out (calcWTS never reads it, D2)
var RIG_CK2_V101OUT = JSON.stringify({ esd: true, choke: true, heater: true, separator: false, surge: true, gauge: true, pump: true, flare: true,
  desander: false, surge2: false, heaterChoke: true });
// the timing set for the ≤ 6.0 gate: CK-102 and the production-line destination inputs present
var TIME_CK2_SEPBY = mix(BASE, { wts_bean2: '48', wts_ck2Pos: 'inlet', wts_sepByDest: 'line', wts_sepByP: '300' });

// ─── BASE_FIELDS (§9.2): all of flow minus ts, seq, ck2, sepBy, sim.sepByDest, sim.sepByP_psig, ck1 ───────────────────
// ck1 (CK-101 choke manifold: leg in service, adjustable / positive beans, effective bean) is a new block added after v3.3.3;
// it is omitted like ck2 / sepBy so the strict no-extra-keys compare still guards every v3.3.1 field (no golden value changes;
// with the adjustable leg in service flow.inputs.bean / flow.chokeBean are the v3.3.1 wts_bean, checked as before)
// v4.1 (2026-11-09): lp (the LP flare line / tank gas block) and the three LP line inputs in flow.sim are new blocks, omitted the
// same way (the golden file is not edited; the LP box is painted only once a rig-up is handed over, so the page stays exact)
var BASE_FIELDS_OMIT = ['ts', 'seq', 'ck2', 'sepBy', 'sim.sepByDest', 'sim.sepByP_psig', 'ck1', 'lp', 'sim.lpNps', 'sim.lpSch', 'sim.lpLen_ft'];

// encode: JSON-safe copy keeping -0, NaN and ±Infinity ({$n: '-0' | 'NaN' | 'Infinity' | '-Infinity'}); undefined values
// become {$u: 1} so a key that is present but undefined is not lost
function encode(x) {
  if (typeof x === 'number') {
    if (x !== x) return { $n: 'NaN' };
    if (x === Infinity) return { $n: 'Infinity' };
    if (x === -Infinity) return { $n: '-Infinity' };
    if (x === 0 && 1 / x < 0) return { $n: '-0' };
    return x;
  }
  if (x === undefined) return { $u: 1 };
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(encode);
  var o = {};
  Object.keys(x).forEach(function (k) { o[k] = encode(x[k]); });
  return o;
}
function decode(x) {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(decode);
  var ks = Object.keys(x);
  if (ks.length === 1 && ks[0] === '$n') return x.$n === '-0' ? -0 : Number(x.$n);
  if (ks.length === 1 && ks[0] === '$u') return undefined;
  var o = {};
  ks.forEach(function (k) { o[k] = decode(x[k]); });
  return o;
}
function baseFields(flow) {
  if (!flow || typeof flow !== 'object') return flow;
  var c = decode(encode(flow));
  BASE_FIELDS_OMIT.forEach(function (p) {                       // every omitted path (top-level keys and 'sim.<key>')
    var i = p.indexOf('.');
    if (i < 0) delete c[p];
    else if (c[p.slice(0, i)] && typeof c[p.slice(0, i)] === 'object') delete c[p.slice(0, i)][p.slice(i + 1)];
  });
  return c;
}
// compare(g, a): strict, every path of g in a with === (NaN equals NaN; -0 and 0 must match by sign too), no extra keys in a
function compare(g, a, max) {
  var out = [], lim = max || 20;
  (function walk(x, y, p) {
    if (out.length >= lim) return;
    if (x === null || typeof x !== 'object') {
      var same = (x === y && (x !== 0 || 1 / x === 1 / y)) || (typeof x === 'number' && typeof y === 'number' && x !== x && y !== y);
      if (!same) out.push(p + ': ' + JSON.stringify(encode(x)) + ' !== ' + JSON.stringify(encode(y)));
      return;
    }
    if (y === null || typeof y !== 'object' || Array.isArray(x) !== Array.isArray(y)) { out.push(p + ': type ' + (Array.isArray(x) ? 'array' : 'object') + ' vs ' + JSON.stringify(encode(y))); return; }
    if (Array.isArray(x)) {
      if (x.length !== y.length) { out.push(p + '.length: ' + x.length + ' !== ' + y.length); return; }
      for (var i = 0; i < x.length; i++) walk(x[i], y[i], p + '[' + i + ']');
      return;
    }
    Object.keys(x).forEach(function (k) { walk(x[k], y[k], p ? p + '.' + k : k); });
    Object.keys(y).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(x, k)) out.push((p ? p + '.' : '') + k + ': unexpected key'); });
  })(g, a, '');
  return out;
}

// ─── the calcWTS region and the stub harness ─────────────────────────────────
function region(html) {
  var s = String(html).replace(/\r\n/g, '\n');
  var a = s.indexOf('\nconst WTS_PIPES=');
  var b = s.indexOf('\nconst WTS_DIAG_LAYOUT', a);
  if (a < 0 || b < 0) throw new Error('wts-calc-golden: no calcWTS region (const WTS_PIPES= … const WTS_DIAG_LAYOUT) in the host');
  var r = s.slice(a + 1, b + 1);
  if (r.indexOf('window.calcWTS=function(){') < 0) throw new Error('wts-calc-golden: the region has no window.calcWTS=function(){');
  return r;
}
function hostRegion() { return region(fs.readFileSync(HOST, 'utf8')); }
function frozenRegion() { return require(FROZEN_SRC).SRC; }

function memStorage(init) {
  var m = {}, reads = [];
  if (init) Object.keys(init).forEach(function (k) { m[k] = String(init[k]); });
  return {
    reads: reads,
    getItem: function (k) { reads.push(String(k)); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    clear: function () { m = {}; },
    key: function (i) { return Object.keys(m)[i] || null; },
    get length() { return Object.keys(m).length; },
    _dump: function () { return JSON.parse(JSON.stringify(m)); } };
}
// the page's fmt: en-US grouping, '—' for null / NaN (host l.867 uses an Intl formatter with the same output in Imperial mode)
function fmtStub(v, d) {
  if (d === undefined) d = 2;
  if (v == null || isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
// makeCalc(regionSrc) → {run(vals, opts) → {flow, lastCalc, page, events, reads}}; one vm context per call of makeCalc
// (the region is compiled once; run() swaps the element values and the storage, then calls window.calcWTS()).
function makeCalc(regionSrc) {
  var cur = { els: {}, storage: memStorage(), events: [] };
  var isOut = /^wts_(res|warn|regime)$/;
  var $ = function (id) {
    if (Object.prototype.hasOwnProperty.call(cur.els, id)) return cur.els[id];
    if (isOut.test(id)) return (cur.els[id] = { id: id, style: {}, innerHTML: '', textContent: '' });
    return null;
  };
  var win = {};
  var sb = {
    window: win, console: { warn: function () {}, log: function () {}, error: function () {} },
    document: { dispatchEvent: function (e) { cur.events.push(e); return true; }, getElementById: $, querySelector: function () { return null; },
      querySelectorAll: function () { return []; } },
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    $: $, fmt: fmtStub, saveInputs: function () {}, wtsDrawDiag: function () {} };
  Object.defineProperty(sb, 'localStorage', { get: function () { return cur.storage; } });
  Object.defineProperty(win, 'localStorage', { get: function () { return cur.storage; } });
  vm.createContext(sb);
  vm.runInContext(regionSrc + '\n', sb, { filename: 'calcWTS-region.js' });
  if (typeof win.calcWTS !== 'function') throw new Error('wts-calc-golden: the region did not define window.calcWTS');
  return {
    sandbox: sb,
    run: function (vals, opts) {
      opts = opts || {};
      var els = {};
      Object.keys(vals).forEach(function (k) { els[k] = { id: k, value: String(vals[k]), style: {}, dataset: {} }; });
      cur.els = els; cur.events = [];
      cur.storage = memStorage(opts.storage || null);
      cur.storage.removeItem('wts_page_wts');
      if (!opts.storage || !Object.prototype.hasOwnProperty.call(opts.storage, 'wts_sim_rigup')) cur.storage.removeItem('wts_sim_rigup');
      cur.storage.reads.length = 0;
      if (!opts.keepState) win.WTS_state = undefined;
      win.WTS_lastCalc = undefined;
      win.calcWTS();
      var g = function (id, f) { var e = els[id]; return e ? (f === 'display' ? (e.style.display == null ? null : String(e.style.display)) : f === 'color' ? (e.style.color == null ? null : String(e.style.color)) : (e[f] == null ? null : String(e[f]))) : null; };
      return {
        flow: win.WTS_lastCalc ? win.WTS_lastCalc.flow : null, lastCalc: win.WTS_lastCalc, events: cur.events, reads: cur.storage.reads.slice(),
        page: { res: g('wts_res', 'innerHTML'), warn: g('wts_warn', 'innerHTML'), warnDisplay: g('wts_warn', 'display'),
          regime: g('wts_regime', 'textContent'), regimeColor: g('wts_regime', 'color') } };
    } };
}
function runSet(regionSrc, vals, opts) { return makeCalc(regionSrc).run(vals, opts); }
function jsonCopy(x) { return JSON.parse(JSON.stringify(encode(x))); }

// ─── write / check ───────────────────────────────────────────────────────────
function writeGolden() {
  var src = hostRegion(), frozen = frozenRegion();
  if (src !== frozen) throw new Error('wts-calc-golden --write: the host calcWTS region differs from the frozen v3.3.1 text; the golden is written only on the unchanged v3.3.1 tree');
  var C = makeCalc(src);
  var sets = SETS.map(function (s) {
    var r = C.run(s.vals);
    if (!r.flow) throw new Error('set ' + s.name + ': calcWTS published no flow');
    return { name: s.name, flow: jsonCopy(baseFields(r.flow)), page: r.page };
  });
  var hdr = [
    '// prism-build/tests/_wts-calc-v331.js — GOLDEN calcWTS output of v3.3.1 (host at ' + ORIGIN + '). GENERATED, NEVER EDIT BY HAND.',
    '// Written by `node prism-build/wts-calc-golden.js --write` on the unchanged tree (' + PLAN + ' D2 / D13 / §9.2): the BASE_FIELDS',
    '// of WTS_lastCalc.flow (all of flow minus ' + BASE_FIELDS_OMIT.join(', ') + ') and the page output (#wts_res / #wts_warn /',
    '// #wts_regime) for the 12 literal input sets of wts-calc-golden.js (SETS), in its stub DOM with wts_sim_rigup and wts_page_wts',
    '// cleared. Numbers are JSON (exact round trip); -0 / NaN / ±Infinity are {"$n": …} and undefined is {"$u": 1} (decode()).',
    '// Checked strictly (===) by `node prism-build/wts-calc-golden.js --check` and tests/wts-fu-identity.test.js.',
    "'use strict';"].join('\n');
  var body = 'module.exports = ' + JSON.stringify({ origin: ORIGIN, plan: PLAN, omit: BASE_FIELDS_OMIT, sets: sets }, null, 1) + ';\n';
  fs.writeFileSync(GOLDEN, hdr + '\n' + body);
  return sets.length;
}
function loadGolden() {
  delete require.cache[require.resolve(GOLDEN)];
  return require(GOLDEN);
}
// check(opts) → {pass, failures: [...], sets: n, variants: n}
function check(opts) {
  opts = opts || {};
  var G = loadGolden(), src = opts.regionSrc || hostRegion(), C = makeCalc(src), failures = [], variants = 0;
  var byName = {};
  G.sets.forEach(function (g) { byName[g.name] = g; });
  if (G.sets.length !== SETS.length) failures.push('golden has ' + G.sets.length + ' sets, the tool ' + SETS.length);
  SETS.forEach(function (s) {
    var g = byName[s.name];
    if (!g) { failures.push(s.name + ': not in the golden'); return; }
    var gf = decode(g.flow);
    var runs = [{ tag: 'plain', vals: s.vals, opts: {}, page: true }];
    NEW_INPUTS.forEach(function (ni, i) { runs.push({ tag: 'new inputs ' + i, vals: mix(s.vals, ni), opts: {}, page: true }); });
    runs.push({ tag: 'rig-up CK-102 / V-101 out stored', vals: mix(s.vals, NEW_INPUTS[0]), opts: { storage: { wts_sim_rigup: RIG_CK2_V101OUT } }, page: true });
    runs.forEach(function (rr) {
      variants++;
      var r = C.run(rr.vals, rr.opts);
      if (!r.flow) { failures.push(s.name + ' / ' + rr.tag + ': no flow'); return; }
      var d = compare(gf, baseFields(r.flow), 6);
      d.forEach(function (e) { failures.push(s.name + ' / ' + rr.tag + ': flow.' + e); });
      if (rr.page && !opts.noPage) Object.keys(g.page).forEach(function (k) {
        if (g.page[k] !== r.page[k]) failures.push(s.name + ' / ' + rr.tag + ': page.' + k + ' differs');
      });
      if (r.reads.indexOf('wts_sim_rigup') >= 0) failures.push(s.name + ' / ' + rr.tag + ': calcWTS read wts_sim_rigup (D2)');
      if (r.events.length !== 1 || r.events[0].type !== 'wts:calc') failures.push(s.name + ' / ' + rr.tag + ': expected one wts:calc dispatch, got ' + r.events.length);
    });
  });
  return { pass: failures.length === 0, failures: failures, sets: SETS.length, variants: variants };
}

// ─── timing gate (§10) ───────────────────────────────────────────────────────
function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }
function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; }
function timeSet(Cnew, Cold, vals) {
  var one = function (C) { var t0 = nowMs(); for (var i = 0; i < RUN_CALLS; i++) C.run(vals, { keepState: true }); return (nowMs() - t0) / RUN_CALLS; };
  var i;
  for (i = 0; i < WARMUPS; i++) { one(Cold); one(Cnew); }
  var tn = [], to = [];
  for (i = 0; i < RUNS; i++) {
    if (i % 2 === 0) { to.push(one(Cold)); tn.push(one(Cnew)); } else { tn.push(one(Cnew)); to.push(one(Cold)); }
  }
  return { new_ms: median(tn), old_ms: median(to), ratio: median(tn) / median(to) };
}
function time(opts) {
  opts = opts || {};
  var Cnew = makeCalc(opts.regionSrc || hostRegion()), Cold = makeCalc(frozenRegion());
  var d = timeSet(Cnew, Cold, SETS[0].vals), c = timeSet(Cnew, Cold, TIME_CK2_SEPBY), failures = [];
  if (d.ratio > GATE_DEFAULT) failures.push('defaults ratio ' + d.ratio.toFixed(2) + ' > ' + GATE_DEFAULT);
  if (c.ratio > GATE_CK2_SEPBY) failures.push('CK-102 + V-101-out set ratio ' + c.ratio.toFixed(2) + ' > ' + GATE_CK2_SEPBY);
  return { pass: failures.length === 0, failures: failures, runs: RUNS, warmups: WARMUPS, callsPerRun: RUN_CALLS,
    defaults: Object.assign({ gate: GATE_DEFAULT }, d), ck2SepBy: Object.assign({ gate: GATE_CK2_SEPBY }, c) };
}

function main() {
  var argv = process.argv.slice(2), known = ['--write', '--check', '--time', '--json'];
  var bad = argv.filter(function (a) { return known.indexOf(a) < 0; });
  if (bad.length) { console.error('[wts-calc-golden] unknown argument(s): ' + bad.join(' ') + ' (known: ' + known.join(' ') + ')'); process.exitCode = 2; return; }
  var J = argv.indexOf('--json') >= 0, res = { tool: 'wts-calc-golden', plan: PLAN };
  if (argv.indexOf('--write') >= 0) {
    if (argv.indexOf('--check') >= 0) { console.error('[wts-calc-golden] --write and --check together'); process.exitCode = 2; return; }
    res.written = writeGolden();
    if (!J) console.log('[wts-calc-golden] wrote ' + path.relative(ROOT, GOLDEN) + ' (' + res.written + ' sets)');
  }
  var doCheck = argv.indexOf('--check') >= 0 || (argv.indexOf('--write') < 0 && argv.indexOf('--time') < 0);
  var pass = true;
  if (doCheck || argv.indexOf('--write') >= 0) {
    res.check = check();
    pass = pass && res.check.pass;
    if (!J) {
      console.log('[wts-calc-golden] check: ' + res.check.sets + ' sets, ' + res.check.variants + ' runs (plain, three new-input variants, stored CK-102 / V-101-out rig-up)');
      res.check.failures.slice(0, 30).forEach(function (f) { console.log('  ✗ ' + f); });
      console.log(res.check.pass ? '[ok] BASE_FIELDS and page output strictly equal to the v3.3.1 golden' : '[FAIL] ' + res.check.failures.length + ' difference(s)');
    }
  }
  if (argv.indexOf('--time') >= 0) {
    res.time = time();
    pass = pass && res.time.pass;
    if (!J) {
      var t = res.time, f = function (x) { return x.toFixed(4); };
      console.log('[wts-calc-golden] time: median of ' + t.runs + ' runs × ' + t.callsPerRun + ' calls after ' + t.warmups + ' warm-ups, working vs frozen v3.3.1 calcWTS, same process');
      console.log('  defaults: ' + f(t.defaults.new_ms) + ' / ' + f(t.defaults.old_ms) + ' ms per call, ratio ' + t.defaults.ratio.toFixed(3) + ' (gate ≤ ' + t.defaults.gate + ')');
      console.log('  CK-102 + V-101-out inputs: ' + f(t.ck2SepBy.new_ms) + ' / ' + f(t.ck2SepBy.old_ms) + ' ms per call, ratio ' + t.ck2SepBy.ratio.toFixed(3) + ' (gate ≤ ' + t.ck2SepBy.gate + ')');
      console.log(t.pass ? '[ok] calcWTS timing gate passed' : '[FAIL] ' + t.failures.join('; '));
    }
  }
  if (J) console.log(JSON.stringify(res, null, 2));
  process.exitCode = pass ? 0 : 1;
}

module.exports = {
  PLAN: PLAN, ORIGIN: ORIGIN, SETS: SETS, NEW_INPUTS: NEW_INPUTS, RIG_CK2_V101OUT: RIG_CK2_V101OUT, TIME_CK2_SEPBY: TIME_CK2_SEPBY,
  BASE_FIELDS_OMIT: BASE_FIELDS_OMIT, GATE_DEFAULT: GATE_DEFAULT, GATE_CK2_SEPBY: GATE_CK2_SEPBY,
  region: region, hostRegion: hostRegion, frozenRegion: frozenRegion, makeCalc: makeCalc, runSet: runSet, memStorage: memStorage,
  baseFields: baseFields, encode: encode, decode: decode, compare: compare, loadGolden: loadGolden, check: check, time: time };

if (require.main === module) {
  try { main(); } catch (e) { console.error('[wts-calc-golden] tool error: ' + ((e && e.stack) || e)); process.exitCode = 2; }
}
