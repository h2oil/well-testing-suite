#!/usr/bin/env node
// prism-build/wts-sim-perf.js — A/B performance gate of the Well Test Simulator engine (docs/SIM-EQUIPMENT-PLAN.md §7, WP0).
//
// Loads the frozen v3.3 engine (tests/_wts-sim-v33.js) and the working prism-build/31-wts-sim.js (self-test stripped as
// Round 7 strips it) into vm contexts in ONE process, discards 2 warm-up runs of each, then runs N interleaved A/B pairs
// (A = v3.3, B = working; the order inside a pair alternates) of 4 h of sim time at dt 10 s on SAMPLE_FLOW (seed 14) — the
// self-test 14 workload — and compares
//   • minRatio    = min(B) / min(A)
//   • medianRatio = median over the pairs of B_i / A_i
// Measured noise on UNCHANGED code (A/A, 2026-11-01, a 4-core box under load): one process with one context per engine gave
// min ratios from 0.88 to 1.27 — a context can be unlucky in what the JIT makes of it, and that biases every run in it.
// So each process loads TWO contexts per engine and alternates them, and the measurement is repeated in --rounds fresh child
// processes (default 7; the load order of the two engines alternates with the round). The gate: minRatio = median over the
// rounds of the per-round ratio of minima (the median ignores the odd unlucky process), medianRatio = median of all per-pair
// ratios pooled over the rounds. Per-round min ratios on unchanged code ranged 0.80–1.17 under load; both gate values stayed
// within about ±0.03 of 1 with 7 rounds.
// Gate (default spread: DS-101 and T-202 out, sand 0): both medians ≤ 1.05, else exit 1.
// When the working engine has the optional items (WTS_sim.RIG_OPTIONAL), it also times "both in, flow-back on"
// (rig-up {desander, surge2}, fault sandFlowback, route 'both' when setSurgeRoute accepts it) against the default spread in
// the same contexts: median over rounds of min(both) / min(default) ≤ 1.4, else exit 1. Before WP-E0 that check is skipped.
// No absolute millisecond budget (a cold vm or a slow box would break one).
//
// Usage: node prism-build/wts-sim-perf.js [--pairs n (default 10, minimum 10)] [--rounds n (default 7)] [--json] [--hours h (default 4)]
// Exit: 0 pass, 1 gate failed, 2 tool error.
'use strict';

var path = require('path');
var shapes = require(path.join(__dirname, 'tests', '_wts-equip-shapes.js'));

var GATE_AB = 1.05, GATE_BOTH = 1.4, WARMUPS = 2, DT = 10, SEED = 14;

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

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }
function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; }
function min(a) { return Math.min.apply(null, a); }

function makeRun(S, variant) {
  var steps = Math.round(HOURS * 3600 / DT);
  return function () {
    var opts = { seed: SEED };
    if (variant === 'both') opts.rigup = { desander: true, surge2: true };
    var sim = S.create(S.SAMPLE_FLOW, opts);
    if (variant === 'both') {
      if (typeof sim.setFault === 'function') sim.setFault('sandFlowback', true);
      if (typeof sim.setSurgeRoute === 'function') { try { sim.setSurgeRoute('both'); } catch (e) { /* not available yet */ } }
    }
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
  var A, B;   // load order alternates with the round (--round k) so neither engine always gets the first contexts
  if (ROUND % 2 === 0) { A = [shapes.loadEngine('v33'), shapes.loadEngine('v33')]; B = [shapes.loadEngine('work'), shapes.loadEngine('work')]; }
  else { B = [shapes.loadEngine('work'), shapes.loadEngine('work')]; A = [shapes.loadEngine('v33'), shapes.loadEngine('v33')]; }
  var runA = [makeRun(A[0], 'default'), makeRun(A[1], 'default')], runB = [makeRun(B[0], 'default'), makeRun(B[1], 'default')];
  var i, c;
  for (c = 0; c < 2; c++) for (i = 0; i < WARMUPS; i++) { runA[c](); runB[c](); }
  var ta = [], tb = [], ratios = [];
  for (i = 0; i < PAIRS; i++) {
    var a, b; c = i % 2;
    if ((i >> 1) % 2 === 0) { a = runA[c](); b = runB[c](); } else { b = runB[c](); a = runA[c](); }
    ta.push(a); tb.push(b); ratios.push(b / a);
  }
  var r = { versions: { v33: A[0].VERSION, work: B[0].VERSION }, minA_ms: min(ta), minB_ms: min(tb), medA_ms: median(ta), medB_ms: median(tb),
    minRatio: min(tb) / min(ta), medianRatio: median(ratios), ratios: ratios, a_ms: ta, b_ms: tb, both: null };
  if (B[0].RIG_OPTIONAL && B[0].RIG_OPTIONAL.length) {
    var runBoth = [makeRun(B[0], 'both'), makeRun(B[1], 'both')], tDef = [], tBoth = [];
    for (c = 0; c < 2; c++) for (i = 0; i < WARMUPS; i++) runBoth[c]();
    for (i = 0; i < PAIRS; i++) {
      c = i % 2;
      if ((i >> 1) % 2 === 0) { tDef.push(runB[c]()); tBoth.push(runBoth[c]()); } else { tBoth.push(runBoth[c]()); tDef.push(runB[c]()); }
    }
    r.both = { minDefault_ms: min(tDef), minBoth_ms: min(tBoth), ratio: min(tBoth) / min(tDef) };
  }
  return r;
}

function main() {
  if (process.argv.indexOf('--child') >= 0) { process.stdout.write(JSON.stringify(measureRound())); return; }
  var cp = require('child_process'), rounds = [], k;
  var childArgs = [__filename, '--child', '--pairs', String(PAIRS), '--hours', String(HOURS)];
  for (k = 0; k < ROUNDS; k++) {
    var out = cp.execFileSync(process.execPath, childArgs.concat(['--round', String(k)]), { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
    rounds.push(JSON.parse(out));
    if (!JSON_OUT) process.stdout.write('  round ' + (k + 1) + '/' + ROUNDS + ': min ratio ' + rounds[k].minRatio.toFixed(3) +
      ', median ratio ' + rounds[k].medianRatio.toFixed(3) + (rounds[k].both ? ', both-in ratio ' + rounds[k].both.ratio.toFixed(3) : '') + '\n');
  }
  var pick = function (f) { return rounds.map(f); };
  var res = {
    tool: 'wts-sim-perf', plan: shapes.PLAN + ' §7', node: process.version, hours: HOURS, dt: DT, seed: SEED, pairs: PAIRS,
    warmups: WARMUPS, rounds: ROUNDS, contextsPerEngine: 2, versions: rounds[0].versions,
    ab: { minA_ms: min(pick(function (r) { return r.minA_ms; })), minB_ms: min(pick(function (r) { return r.minB_ms; })),
      minRatio: 0, medianRatio: median([].concat.apply([], pick(function (r) { return r.ratios; }))), gate: GATE_AB,
      perRound: pick(function (r) { return { minRatio: r.minRatio, medianRatio: r.medianRatio, minA_ms: r.minA_ms, minB_ms: r.minB_ms, a_ms: r.a_ms, b_ms: r.b_ms }; }) },
    both: null, pass: true, failures: [] };
  res.ab.minRatio = median(pick(function (r) { return r.minRatio; }));
  if (res.ab.minRatio > GATE_AB) res.failures.push('minRatio ' + res.ab.minRatio.toFixed(3) + ' > ' + GATE_AB);
  if (res.ab.medianRatio > GATE_AB) res.failures.push('medianRatio ' + res.ab.medianRatio.toFixed(3) + ' > ' + GATE_AB);
  if (rounds[0].both) {
    res.both = { ratio: median(pick(function (r) { return r.both.ratio; })), gate: GATE_BOTH,
      perRound: pick(function (r) { return r.both; }) };
    if (res.both.ratio > GATE_BOTH) res.failures.push('both-in ratio ' + res.both.ratio.toFixed(3) + ' > ' + GATE_BOTH);
  } else {
    res.both = { skipped: 'working engine has no optional rig-up items yet (WTS_sim.RIG_OPTIONAL missing; arrives with WP-E0)' };
  }
  res.pass = res.failures.length === 0;

  if (JSON_OUT) console.log(JSON.stringify(res, null, 2));
  else {
    var f = function (x) { return x.toFixed(1); };
    console.log('[wts-sim-perf] ' + HOURS + ' h at dt ' + DT + ' s, SAMPLE_FLOW seed ' + SEED + '; ' + ROUNDS + ' rounds (fresh processes) × ' +
      PAIRS + ' interleaved pairs, 2 contexts per engine, ' + WARMUPS + ' warm-ups each; node ' + process.version);
    console.log('  A v3.3 frozen (' + res.versions.v33 + '): best ' + f(res.ab.minA_ms) + ' ms;  B working (' + res.versions.work + '): best ' + f(res.ab.minB_ms) + ' ms');
    console.log('  median over rounds of the ratio of minima ' + res.ab.minRatio.toFixed(3) + ', pooled median of per-pair ratios ' + res.ab.medianRatio.toFixed(3) +
      '  (gate ≤ ' + GATE_AB + ')');
    if (res.both.skipped) console.log('  both in, flow-back on: skipped — ' + res.both.skipped);
    else console.log('  both in, flow-back on vs default (same contexts): ratio of minima ' + res.both.ratio.toFixed(3) + '  (gate ≤ ' + GATE_BOTH + ')');
    console.log(res.pass ? '[ok] performance gate passed' : '[FAIL] ' + res.failures.join('; '));
  }
  process.exitCode = res.pass ? 0 : 1;
}

try { main(); } catch (e) { console.error('[wts-sim-perf] tool error: ' + ((e && e.stack) || e)); process.exitCode = 2; }
