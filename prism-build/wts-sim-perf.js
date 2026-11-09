#!/usr/bin/env node
// prism-build/wts-sim-perf.js — A/B performance gate of the Well Test Simulator engine (docs/SIM-EQUIPMENT-PLAN.md §7, WP0;
// docs/SIM-FOLLOWUP-PLAN.md §10, WP0: --base, --case, --probe).
//
// Loads a frozen engine (A; --base v331 = tests/_wts-sim-v331.js, the default since SIM-FOLLOWUP WP0, or --base v33 =
// tests/_wts-sim-v33.js, the old pair) and the working prism-build/31-wts-sim.js (B; self-test stripped as Round 7 strips it)
// into vm contexts in ONE process, discards 2 warm-up runs of each, then runs N interleaved A/B pairs (the order inside a pair
// alternates) of 4 h of sim time at dt 10 s on SAMPLE_FLOW (seed 14) — the self-test 14 workload — and compares
//   • minRatio    = min(B) / min(A)
//   • medianRatio = median over the pairs of B_i / A_i
// Measured noise on UNCHANGED code (A/A, 2026-11-01, a 4-core box under load): one process with one context per engine gave
// min ratios from 0.88 to 1.27 — a context can be unlucky in what the JIT makes of it, and that biases every run in it.
// So each process loads TWO contexts per engine and alternates them, and the measurement is repeated in --rounds fresh child
// processes (default 7; the load order of the two engines alternates with the round). The gate: minRatio = median over the
// rounds of the per-round ratio of minima (the median ignores the odd unlucky process), medianRatio = median of all per-pair
// ratios pooled over the rounds. Per-round min ratios on unchanged code ranged 0.80–1.17 under load; both gate values stayed
// within about ±0.03 of 1 with 7 rounds.
// Gate (default spread: DS-101, T-202 and CK-102 out, sand 0, dest flare, no cushion): both medians ≤ 1.05, else exit 1.
// Secondary ratios, each against the default spread of the working engine in the same contexts (median over the rounds of
// min(case) / min(default)):
//   • both  — DS-101 and T-202 in, flow-back on (rig-up {desander, surge2}, fault sandFlowback, route 'both') ≤ 1.6
//             (SIM-EQUIPMENT WP-I: measured DS-101 alone ≈ 1.23, T-202 alone ≈ 1.27, both ≈ 1.45); when RIG_OPTIONAL exists
//   • ck2   — CK-102 in on a calcWTS flow that carries flow.ck2 (wts_bean2 48) ≤ 1.10 (SIM-FOLLOWUP §10)
//   • cushion — Scenarios → Cushion unload with the defaults started at t = 0 ≤ 1.15
//   • line  — V-101 out, destination production line 150 psig, against the default spread ≤ 1.05
//   • surge — release 4.1: V-101 out, destination surge tank T-201, low gas (Qg 0.1 MMscf/d, 1,000 STB/d, 200 bbl/d — no ESD; an
//             ESD'd sim is cheap and proves nothing) ≤ 1.10; skipped until WTS_sim.features.rigChain
// Release 4.1: the working default includes the LP flare line (cfg.surge.vent 'lp') and the rig chain — the default gate covers
// their cost (the tool pins nothing on the working side; the frozen engine runs its own default)
// A secondary case is skipped (with the reason) until the working engine has it (WTS_sim.features, startCushion, a flow.ck2
// block from the host calcWTS); --case ck2|cushion|line|both|all (default all) limits which run.
// --probe hist: the working source gets the two SIM-FOLLOWUP history keys (Pck2, cushionLeft) stubbed in as constant number
// writes on every sample, so the A/A run of WP0 measures them (§10); skipped once the engine has its own Pck2 key.
// No absolute millisecond budget (a cold vm or a slow box would break one).
//
// Usage: node prism-build/wts-sim-perf.js [--base v331|v33] [--case all|both|ck2|cushion|line|surge] [--probe hist]
//          [--pairs n (default 10, minimum 10)] [--rounds n (default 7)] [--json] [--hours h (default 4)]
// Exit: 0 pass, 1 gate failed, 2 tool error.
'use strict';

var fs = require('fs');
var path = require('path');
var shapes = require(path.join(__dirname, 'tests', '_wts-equip-shapes.js'));

var GATE_AB = 1.05, WARMUPS = 2, DT = 10, SEED = 14;
var GATES = { both: 1.6, ck2: 1.10, cushion: 1.15, line: 1.05, surge: 1.10 };
var CASES = ['both', 'ck2', 'cushion', 'line', 'surge'];

function arg(name, def) {
  var i = process.argv.indexOf(name);
  if (i < 0) return def;
  var v = process.argv[i + 1];
  return v === undefined ? def : v;
}
var PAIRS = Math.max(10, parseInt(arg('--pairs', '10'), 10) || 10);
var ROUNDS = Math.max(1, parseInt(arg('--rounds', '7'), 10) || 7);
var ROUND = parseInt(arg('--round', '0'), 10) || 0;
var HOURS = Math.max(0.1, parseFloat(arg('--hours', '4')) || 4);
var JSON_OUT = process.argv.indexOf('--json') >= 0;
var BASE = arg('--base', 'v331');
var CASE = arg('--case', 'all');
var PROBE = arg('--probe', '');

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }
function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; }
function min(a) { return Math.min.apply(null, a); }

// the working source, optionally with the history probe (two constant number writes per sample, §10)
function workSource() {
  var src = require(path.join(__dirname, 'concat-round7.js')).stripSelfTest(
    fs.readFileSync(path.join(__dirname, '31-wts-sim.js'), 'utf8'), '31-wts-sim.js', { log: function () {}, warn: function () {} });
  if (PROBE !== 'hist') return { src: src, probe: '' };
  if (/var HIST_KEYS = \[[^\]]*'Pck2'/.test(src)) return { src: src, probe: 'skipped: the engine has its own Pck2 history key' };
  var a = src.replace(/(var HIST_KEYS = \[[^\]]*?)\];/, "$1, 'Pck2', 'cushionLeft'];");
  var b = a.replace('desHist(i); surge2Hist(i);', 'desHist(i); surge2Hist(i); H.k.Pck2[i] = H.k.Pchoke[i]; H.k.cushionLeft[i] = 0;');
  if (a === src || b === a) throw new Error('--probe hist: the HIST_KEYS / histSample anchors were not found in 31-wts-sim.js');
  return { src: b, probe: 'hist (Pck2, cushionLeft stubbed in)' };
}
// a host calcWTS flow with CK-102 inputs (flow.ck2 exists only once WP-C lands); null when the host has no block
function hostCk2Flow() {
  try {
    var G = require(path.join(__dirname, 'wts-calc-golden.js'));
    var r = G.runSet(G.hostRegion(), Object.assign({}, G.SETS[0].vals, { wts_bean2: '48', wts_ck2Pos: 'inlet', wts_sepByDest: 'flare', wts_sepByP: '150' }));
    return r.flow && r.flow.ck2 && r.flow.ck2.skipped !== true ? JSON.parse(JSON.stringify(r.flow)) : null;
  } catch (e) { return null; }
}

// variant → {opts, flow, setup} or a skip reason (string)
function variantOf(S, v, ck2Flow) {
  if (v === 'default') return { flow: S.SAMPLE_FLOW, opts: {} };
  if (v === 'both') {
    if (!(S.RIG_OPTIONAL && S.RIG_OPTIONAL.length)) return 'working engine has no optional rig-up items (WTS_sim.RIG_OPTIONAL missing)';
    return { flow: S.SAMPLE_FLOW, opts: { rigup: { desander: true, surge2: true } }, setup: function (sim) {
      if (typeof sim.setFault === 'function') sim.setFault('sandFlowback', true);
      if (typeof sim.setSurgeRoute === 'function') { try { sim.setSurgeRoute('both'); } catch (e) { /* not available */ } }
    } };
  }
  var F = S.features;
  if (!F) return 'working engine has no WTS_sim.features yet (arrives with SIM-FOLLOWUP WP-E0)';
  if (v === 'ck2') {
    if (!F.heaterChoke) return 'features.heaterChoke is false';
    if (!ck2Flow) return 'the host calcWTS publishes no flow.ck2 block yet (arrives with WP-C)';
    return { flow: ck2Flow, opts: { rigup: { heaterChoke: true } } };
  }
  if (v === 'cushion') {
    if (!F.cushion) return 'features.cushion is false';
    var probe = S.create(S.SAMPLE_FLOW, { seed: SEED }), r = typeof probe.startCushion === 'function' ? probe.startCushion({}) : null;
    if (!(r && r.ok)) return 'startCushion is not available yet (' + (r && r.msg ? r.msg : 'missing') + ')';
    return { flow: S.SAMPLE_FLOW, opts: {}, setup: function (sim) { sim.startCushion({}); } };
  }
  if (v === 'line') {
    if (!F.bypassDest) return 'features.bypassDest is false';
    var fl = JSON.parse(JSON.stringify(S.SAMPLE_FLOW)); fl.sim.sepByDest = 'line'; fl.sim.sepByP_psig = 150;
    return { flow: fl, opts: { rigup: { separator: false } } };
  }
  if (v === 'surge') {
    if (!F.rigChain) return 'features.rigChain is false (release 4.1 rig chain)';
    var fs2 = JSON.parse(JSON.stringify(S.SAMPLE_FLOW)); fs2.sim.sepByDest = 'surge';
    fs2.inputs.Qg = 0.1; fs2.inputs.Qo = 1000; fs2.inputs.Qw = 200; fs2.gasRate = 0.1;
    return { flow: fs2, opts: { rigup: { separator: false } } };
  }
  return 'unknown case ' + v;
}
function makeRun(S, spec) {
  var steps = Math.round(HOURS * 3600 / DT);
  return function () {
    var sim = S.create(spec.flow, Object.assign({ seed: SEED }, spec.opts || {}));
    if (spec.setup) spec.setup(sim);
    var t0 = nowMs();
    for (var i = 0; i < steps; i++) sim.advance(DT);
    var ms = nowMs() - t0;
    var st = sim.getState();
    if (!(st && typeof st.t === 'number' && isFinite(st.t))) throw new Error('engine returned no finite state.t');
    return ms;
  };
}

// One measurement round (runs in a fresh child process): two vm contexts per engine (a context can be unlucky in what the JIT
// makes of it, which biases every run in that context by up to ±12 % on unchanged code), 2 warm-ups per context, then PAIRS
// interleaved A/B pairs (pair i uses context i % 2 of each engine; the order inside a pair alternates).
function measureRound() {
  var W = workSource(), A, B;   // load order alternates with the round (--round k) so neither engine always gets the first contexts
  if (ROUND % 2 === 0) { A = [shapes.loadEngine(BASE), shapes.loadEngine(BASE)]; B = [shapes.loadEngine(W.src), shapes.loadEngine(W.src)]; }
  else { B = [shapes.loadEngine(W.src), shapes.loadEngine(W.src)]; A = [shapes.loadEngine(BASE), shapes.loadEngine(BASE)]; }
  var runA = [makeRun(A[0], variantOf(A[0], 'default')), makeRun(A[1], variantOf(A[1], 'default'))];
  var runB = [makeRun(B[0], variantOf(B[0], 'default')), makeRun(B[1], variantOf(B[1], 'default'))];
  var i, c;
  for (c = 0; c < 2; c++) for (i = 0; i < WARMUPS; i++) { runA[c](); runB[c](); }
  var ta = [], tb = [], ratios = [];
  for (i = 0; i < PAIRS; i++) {
    var a, b; c = i % 2;
    if ((i >> 1) % 2 === 0) { a = runA[c](); b = runB[c](); } else { b = runB[c](); a = runA[c](); }
    ta.push(a); tb.push(b); ratios.push(b / a);
  }
  var r = { versions: { base: A[0].VERSION, work: B[0].VERSION }, probe: W.probe, minA_ms: min(ta), minB_ms: min(tb), medA_ms: median(ta), medB_ms: median(tb),
    minRatio: min(tb) / min(ta), medianRatio: median(ratios), ratios: ratios, a_ms: ta, b_ms: tb, cases: {} };
  var ck2Flow = (CASE === 'all' || CASE === 'ck2') ? hostCk2Flow() : null;
  CASES.forEach(function (v) {
    if (CASE !== 'all' && CASE !== v) return;
    var spec0 = variantOf(B[0], v, ck2Flow), spec1 = variantOf(B[1], v, ck2Flow);
    if (typeof spec0 === 'string') { r.cases[v] = { skipped: spec0 }; return; }
    var runV = [makeRun(B[0], spec0), makeRun(B[1], spec1)], tDef = [], tV = [];
    for (c = 0; c < 2; c++) for (i = 0; i < WARMUPS; i++) runV[c]();
    for (i = 0; i < PAIRS; i++) {
      c = i % 2;
      if ((i >> 1) % 2 === 0) { tDef.push(runB[c]()); tV.push(runV[c]()); } else { tV.push(runV[c]()); tDef.push(runB[c]()); }
    }
    r.cases[v] = { minDefault_ms: min(tDef), minCase_ms: min(tV), ratio: min(tV) / min(tDef) };
  });
  return r;
}

function main() {
  if (['v331', 'v33'].indexOf(BASE) < 0) throw new Error('--base must be v331 or v33, got ' + BASE);
  if (CASES.concat(['all']).indexOf(CASE) < 0) throw new Error('--case must be all, ' + CASES.join(', ') + '; got ' + CASE);
  if (PROBE && PROBE !== 'hist') throw new Error('--probe must be hist, got ' + PROBE);
  if (process.argv.indexOf('--child') >= 0) { process.stdout.write(JSON.stringify(measureRound())); return; }
  var cp = require('child_process'), rounds = [], k;
  var childArgs = [__filename, '--child', '--pairs', String(PAIRS), '--hours', String(HOURS), '--base', BASE, '--case', CASE].concat(PROBE ? ['--probe', PROBE] : []);
  for (k = 0; k < ROUNDS; k++) {
    var out = cp.execFileSync(process.execPath, childArgs.concat(['--round', String(k)]), { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
    rounds.push(JSON.parse(out));
    if (!JSON_OUT) {
      var cs = Object.keys(rounds[k].cases).filter(function (v) { return !rounds[k].cases[v].skipped; })
        .map(function (v) { return v + ' ' + rounds[k].cases[v].ratio.toFixed(3); }).join(', ');
      process.stdout.write('  round ' + (k + 1) + '/' + ROUNDS + ': min ratio ' + rounds[k].minRatio.toFixed(3) +
        ', median ratio ' + rounds[k].medianRatio.toFixed(3) + (cs ? ', ' + cs : '') + '\n');
    }
  }
  var pick = function (f) { return rounds.map(f); };
  var res = {
    tool: 'wts-sim-perf', plan: shapes.PLAN + ' §7; docs/SIM-FOLLOWUP-PLAN.md §10', node: process.version, hours: HOURS, dt: DT, seed: SEED, pairs: PAIRS,
    warmups: WARMUPS, rounds: ROUNDS, contextsPerEngine: 2, base: BASE, probe: rounds[0].probe || '', versions: rounds[0].versions,
    ab: { minA_ms: min(pick(function (r) { return r.minA_ms; })), minB_ms: min(pick(function (r) { return r.minB_ms; })),
      minRatio: 0, medianRatio: median([].concat.apply([], pick(function (r) { return r.ratios; }))), gate: GATE_AB,
      perRound: pick(function (r) { return { minRatio: r.minRatio, medianRatio: r.medianRatio, minA_ms: r.minA_ms, minB_ms: r.minB_ms, a_ms: r.a_ms, b_ms: r.b_ms }; }) },
    cases: {}, pass: true, failures: [] };
  res.ab.minRatio = median(pick(function (r) { return r.minRatio; }));
  if (res.ab.minRatio > GATE_AB) res.failures.push('minRatio ' + res.ab.minRatio.toFixed(3) + ' > ' + GATE_AB);
  if (res.ab.medianRatio > GATE_AB) res.failures.push('medianRatio ' + res.ab.medianRatio.toFixed(3) + ' > ' + GATE_AB);
  Object.keys(rounds[0].cases).forEach(function (v) {
    if (rounds[0].cases[v].skipped) { res.cases[v] = { skipped: rounds[0].cases[v].skipped }; return; }
    res.cases[v] = { ratio: median(pick(function (r) { return r.cases[v].ratio; })), gate: GATES[v], perRound: pick(function (r) { return r.cases[v]; }) };
    if (res.cases[v].ratio > GATES[v]) res.failures.push(v + ' ratio ' + res.cases[v].ratio.toFixed(3) + ' > ' + GATES[v]);
  });
  res.both = res.cases.both || null;   // v3.3.1 report key
  res.pass = res.failures.length === 0;

  if (JSON_OUT) console.log(JSON.stringify(res, null, 2));
  else {
    var f = function (x) { return x.toFixed(1); };
    console.log('[wts-sim-perf] ' + HOURS + ' h at dt ' + DT + ' s, SAMPLE_FLOW seed ' + SEED + '; ' + ROUNDS + ' rounds (fresh processes) × ' +
      PAIRS + ' interleaved pairs, 2 contexts per engine, ' + WARMUPS + ' warm-ups each; node ' + process.version + (res.probe ? '; probe ' + res.probe : ''));
    console.log('  A ' + BASE + ' frozen (' + res.versions.base + '): best ' + f(res.ab.minA_ms) + ' ms;  B working (' + res.versions.work + '): best ' + f(res.ab.minB_ms) + ' ms');
    console.log('  median over rounds of the ratio of minima ' + res.ab.minRatio.toFixed(3) + ', pooled median of per-pair ratios ' + res.ab.medianRatio.toFixed(3) +
      '  (gate ≤ ' + GATE_AB + ')');
    Object.keys(res.cases).forEach(function (v) {
      var c = res.cases[v];
      if (c.skipped) console.log('  ' + v + ': skipped — ' + c.skipped);
      else console.log('  ' + v + ' vs default (same contexts): ratio of minima ' + c.ratio.toFixed(3) + '  (gate ≤ ' + c.gate + ')');
    });
    console.log(res.pass ? '[ok] performance gate passed' : '[FAIL] ' + res.failures.join('; '));
  }
  process.exitCode = res.pass ? 0 : 1;
}

try { main(); } catch (e) { console.error('[wts-sim-perf] tool error: ' + ((e && e.stack) || e)); process.exitCode = 2; }
