// Build-up Surveillance — WP4 synthetic generator tests (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.9, §5.2, §5.3, §9 WP4).
//
//   GE1  the same seed gives an identical record (hash, samples); the sliced job equals the synchronous run; rng stream pinned
//   GE2  homogeneous generator vs the IARF asymptote 0.5(ln tD + 0.80907) + S within 0.1 % at late time
//   GE3  own Stehfest N = 16 vs the Ei line source (C_D 0, S 0) within 1e-4
//   GE4  oil demo: 9 analysable + 1 short + 1 partial truth events, k 45, C 0.01, the S path and durations, each duration
//        ≥ 1.2·reach.fair, the 15:00 closing, sampling, and the recorded expected grade of each test
//   GE5  gas demo: rate ratio 2.0, D·q = 2.0 at the high rate, 3 + 3 constant-skin tests, D/se ≥ 6 with S_err = 0.2
//   GE6  caseFromSeed follows the fixed seed table, covers every stratum, parameters within the §5.2 ranges
//   GE7  source grep: the generator never references the data layer, the fitted PRiSM kernels or unseeded random numbers
//   GE8  truth follows the given inputs and the true flowing hours; score never reads the engine's Δq; record cap
//   GE9  (added) file 55 placeholder passes checkShape('Cal') and is exactly what buildup-validate.js --placeholder writes;
//        the tool's statistics helpers and its calibration path on stub outcomes
//
// One app is loaded for the whole file (opts:false + a lazy cache): the generator is pure, so tests share it.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('./_buildup-shapes');

const WP = 'BU4';
const SRC = path.join(__dirname, '..', '49-calc-buildup-synth.js');
let _env = null;
function env(ctx) {
  if (_env) return _env;
  const app = ctx.loadApp({ fromSources: true, console: 'errors' });
  const SY = app.win.WTS_buildup && app.win.WTS_buildup.synth;
  if (!SY) throw new Error('WTS_buildup.synth missing from the Round-9 build');
  _env = { app, SY, demos: {} };
  return _env;
}
function demo(ctx, kind) {
  const e = env(ctx);
  if (!e.demos[kind]) e.demos[kind] = e.SY.demo(kind);
  return e.demos[kind];
}
const H = 3600000, DAY = 86400000;
// deep equality across realms (app values come from the harness vm realm, with their own Array/Object prototypes)
const plain = (v) => JSON.parse(JSON.stringify(v));
function deq(assert, a, b, msg) { assert.deepStrictEqual(plain(a), plain(b), msg); }
const LABELS_OF = (tb) => [].concat(tb.high, tb.medium, tb.low);
function medianOf(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); }

module.exports = [
  {
    name: 'GE1 same seed → identical record hash and samples; sliced job = synchronous run; rng stream pinned',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const { SY } = env(ctx);
      const a = SY.generate(SY.caseFromSeed(100003, { lite: true }));
      const b = SY.generate(SY.caseFromSeed(100003, { lite: true }));
      assert.match(a.record.hash, /^[0-9a-f]{16}$/, 'hex16 record hash');
      assert.strictEqual(a.record.hash, b.record.hash, 'same seed → same hash');
      assert.strictEqual(a.record.n, b.record.n);
      for (let i = 0; i < a.record.n; i++) if (a.record.t[i] !== b.record.t[i] || a.record.p[i] !== b.record.p[i]) assert.fail('sample ' + i + ' differs');
      deq(assert, JSON.parse(JSON.stringify(a.allocation)), JSON.parse(JSON.stringify(b.allocation)), 'same allocation');
      const c = SY.generate(SY.caseFromSeed(100004, { lite: true }));
      assert.notStrictEqual(c.record.hash, a.record.hash, 'another seed → another record');
      // the count-sliced job gives the synchronous result, with bounded steps
      const job = SY.generateJob(SY.caseFromSeed(100003, { lite: true }));
      let r, steps = 0;
      do { r = job.step(); steps++; assert(r.progress >= 0 && r.progress <= 1, 'progress in [0, 1]'); assert.strictEqual(typeof r.label, 'string'); } while (!r.done && steps < 10000);
      assert(steps > 2, 'sliced into several work units');
      assert.strictEqual(job.result().record.hash, a.record.hash, 'job result = synchronous result');
      // the uniform stream is integer-only (Math.imul): pinned values
      const g = SY.rng(42);
      deq(assert, [g.next(), g.next(), g.next()], [0.24572046380490065, 0.5754302670247853, 0.3558912726584822], 'rng(42) stream');
      const h = SY.rng(42), k = SY.rng(43);
      assert.strictEqual(h.next(), 0.24572046380490065); assert.notStrictEqual(k.next(), 0.24572046380490065);
      const ri = SY.rng(7); for (let i = 0; i < 200; i++) { const v = ri.int(2, 5); assert(v >= 2 && v <= 5 && v === Math.floor(v)); }
      assert(S.checkShape('SynthCase', a).ok, JSON.stringify(S.checkShape('SynthCase', a).errors.slice(0, 4)));
      // the record hash is the data layer's construction (§3.6): hash16("n|t0|tN|digest"), digest = FNV-1a (Math.imul) over the
      // sample spacing and round(p·1000), unpadded hex; hash16 = the frozen §3.1 algorithm (the app's PRiSM_autoInterp.hash16)
      const AI = env(ctx).app.win.PRiSM_autoInterp, rec = a.record;
      let hd = 0x811c9dc5;
      for (let i = 0; i < rec.n; i++) { hd = Math.imul(hd ^ (i ? rec.t[i] - rec.t[i - 1] : 0), 16777619); hd = Math.imul(hd ^ Math.round(rec.p[i] * 1000), 16777619); }
      assert.strictEqual(rec.hash, AI.hash16(rec.n + '|' + rec.t[0] + '|' + rec.t[rec.n - 1] + '|' + (hd >>> 0).toString(16)), 'record hash = the data layer recipe');
      assert.strictEqual(app, null);
    },
  },
  {
    name: 'GE1b count-based work units: no generateJob step exceeds its phase cap (forward, grid, finishing)',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const { SY } = env(ctx);
      assert.strictEqual(SY.UNIT.fwd, 500000, 'UNIT_FWD halved to 5e5 (§4.8 50 ms desktop unit)');
      // a lite homogeneous case, a gas case with pseudo-time, a channel case (cost-weighted grid) and an injector
      const jobs = [SY.generateJob(SY.caseFromSeed(100003, { lite: true })), SY.generateJob(SY.caseFromSeed(100400, { lite: true })),
                    SY.generateJob(SY.caseFromSeed(100530, { lite: true })), SY.generateJob(SY.caseFromSeed(100485, { lite: true }))];
      jobs.forEach((job, j) => {
        let r, n = 0; do { r = job.step(); n++; } while (!r.done && n < 20000);
        assert(r.done, 'job ' + j + ' finished');
        const st = job.stats();
        ['grid', 'fwd', 'fin'].forEach((ph) => {
          assert(st.cap[ph] > 0, ph + ' cap');
          // a step may finish the item it started (one grid point, one curve point): 2 % slack
          assert(st.max[ph] <= 1.02 * st.cap[ph], 'job ' + j + ' ' + ph + ': largest step ' + Math.round(st.max[ph]) + ' ops > cap ' + st.cap[ph] + (st.worst ? ' ' + JSON.stringify(st.worst.detail) : ''));
        });
        assert(st.steps >= 4, 'several units');
      });
    },
  },
  {
    name: 'GE2 homogeneous generator vs the IARF asymptote 0.5(ln tD + 0.80907) + S within 0.1 % at late time',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const { SY } = env(ctx);
      // reference case (k 45 md, S 5, C 0.02 bbl/psi, h 50 ft, φ 0.2, ct 1e-5, rw 0.354): C_D = 1426
      const CdRef = 0.8936 * 0.02 / (0.2 * 1e-5 * 50 * 0.354 * 0.354);
      assert.near(CdRef, 1426, 1, 'reference C_D');
      [[CdRef, 5], [100, 0], [500, -2], [5000, 10]].forEach(([Cd, Sk]) => {
        const late = 1e4 * Cd * Math.exp(2 * Math.max(Sk, 0)) * 30;   // well past the storage–skin transition
        [late, 3 * late, 10 * late].forEach((tD) => {
          const p = SY.pwd('homogeneous', { Cd, S: Sk }, [tD])[0], ref = 0.5 * (Math.log(tD) + 0.80907) + Sk;
          assert(Math.abs(p / ref - 1) <= 1e-3, 'Cd ' + Cd.toFixed(0) + ', S ' + Sk + ', tD ' + tD.toExponential(2) + ': ' + p + ' vs ' + ref);
        });
      });
      // its derivative sits on the 0.5 plateau
      const d = SY.pwdPrime('homogeneous', { Cd: CdRef, S: 5 }, [1e10])[0];
      assert.near(d, 0.5, 5e-4, 'plateau 0.5');
    },
  },
  {
    name: 'GE3 own Stehfest N = 16 vs the Ei line source (C_D 0, S 0) within 1e-4',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const { SY } = env(ctx);
      const V = SY.special.stehfestWeights(16);
      assert.strictEqual(V.length, 16, 'N = 16 weights');
      assert(Math.abs(V.reduce((a, b) => a + b, 0)) < 1e-5, 'Σ V_i = 0');
      assert.near(V.reduce((a, b, i) => a + b / (i + 1), 0), 1, 1e-7, 'inverts 1/s to 1');
      let worst = 0;
      for (let e = 0; e <= 8; e += 0.25) {
        const tD = Math.pow(10, e), p = SY.pwd('line', { Cd: 0, S: 0 }, [tD])[0], ref = 0.5 * SY.special.E1(1 / (4 * tD));
        worst = Math.max(worst, Math.abs(p - ref) / ref);
      }
      assert(worst <= 1e-4, 'worst relative error ' + worst);
      // own special functions against tabulated values
      const K = SY.special.besselKe(1).map((v) => v * Math.exp(-1));
      assert.near(K[0], 0.4210244382, 1e-9, 'K0(1)'); assert.near(K[1], 0.6019072302, 1e-9, 'K1(1)');
      assert.near(SY.special.besselIe(30)[0] * Math.exp(30) / 7.816722978e11, 1, 1e-8, 'I0(30)');
      assert.near(SY.special.E1(0.25), 1.044282634, 1e-9, 'E1(0.25)');
      assert.near(SY.special.intK0(60), Math.PI / 2, 1e-12, '∫K0 → π/2');
      // the lattice sums used by the channel kernel agree with direct summation
      const direct = (x) => { let s = 0; for (let n = 1; n * x < 60; n++) s += SY.special.besselKe(n * x)[0] * Math.exp(-n * x); return s; };
      assert.near(SY.special.sumK0n(0.3), direct(0.3), 1e-9, 'Σ K0(n·0.3)');
    },
  },
  {
    name: 'GE4 oil demo: 9 + 1 short + 1 partial, k 45, C 0.01, S path, durations ≥ 1.2·reach.fair, 15:00 closing, expected grades',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const d = demo(ctx, 'oil'), T = d.truth;
      assert.strictEqual(d.kind, 'oil'); assert.strictEqual(d.seed, 3301);
      const ev = T.events;
      assert.strictEqual(ev.filter((e) => e.kind === 'shutin').length, 9, '9 analysable build-ups');
      const short = ev.filter((e) => e.kind === 'short'), part = ev.filter((e) => e.kind === 'partial');
      assert.strictEqual(short.length, 1); assert.strictEqual(short[0].dur_h, 1.5, 'short shut-in 1.5 h');
      assert.strictEqual(part.length, 1); assert.strictEqual(part[0].f, 0.4, 'partial cut 40 %');
      assert.strictEqual(T.k, 45); assert.strictEqual(T.C, 0.01); assert.strictEqual(T.h, 50);
      assert.strictEqual(d.well.h, 50); assert.strictEqual(d.well.mu, 1); assert.strictEqual(d.well.fluid, 'oil');
      deq(assert, T.tests.map((t) => t.S), [1.2, 1.3, 1.1, 1.8, 2.9, 4.0, 5.9, 6.8, 7.4], 'S path');
      // the expected alerts sit clear of the immediate-confirmation rule (§4.7: confirm at once when the raising test exceeds
      // its threshold by ≥ 1): excesses from truth.SStar with baseN = 3, delta 2, absolute 5, all below 1 − 0.1 at the raising test
      const SS = T.tests.map((t) => t.SStar), base = (SS[0] + SS[1] + SS[2]) / 3, M = 0.1;
      const dRaise = SS.findIndex((s, i) => i >= 3 && s - base >= 2), aRaise = SS.findIndex((s) => s >= 5);
      assert.strictEqual(dRaise, 5, 'delta raised at B6 (S* − base ' + (SS[5] - base).toFixed(2) + ')');
      assert(SS[5] - base - 2 < 1 - M && SS[5] - base - 2 > M, 'B6 delta excess ' + (SS[5] - base - 2).toFixed(2) + ' clear of 0 and 1');
      assert(SS[6] - base >= 2 + M, 'B7 confirms the delta alert');
      assert.strictEqual(aRaise, 6, 'absolute raised at B7');
      assert(SS[6] - 5 < 1 - M && SS[6] - 5 > M && SS[7] >= 5 + M, 'B7 absolute excess ' + (SS[6] - 5).toFixed(2) + '; B8 confirms');
      assert(SS.slice(0, 5).every((s) => s - base < 2 - M), 'no delta alert before B6');
      deq(assert, T.tests.map((t) => t.dtEnd_h), [72, 48, 36, 30, 48, 42, 48, 60, 72], 'durations');
      T.tests.forEach((t) => {
        assert(t.dtEnd_h >= 1.2 * t.reachFair_h, t.id + ': ' + t.dtEnd_h + ' h ≥ 1.2 × ' + t.reachFair_h.toFixed(1) + ' h');
        assert.strictEqual(t.k, 45);
      });
      // the generator's own numeric reach: about 21 h at S 1.2 and 38 h at S 7.4 (correlation figures of the plan)
      assert(Math.abs(T.tests[0].reachFair_h / 21 - 1) < 0.2 && Math.abs(T.tests[8].reachFair_h / 38 - 1) < 0.2, 'reach.fair ' + T.tests[0].reachFair_h + ' / ' + T.tests[8].reachFair_h);
      // the US3 closing: 15:00 on a production day that starts at 00:00
      const b3 = T.tests[2];
      assert.strictEqual(b3.closeHour, 15, 'B3 closes at 15:00');
      assert.strictEqual(d.zones.day.startHour, 0); assert.strictEqual(d.zones.day.zone.mode, 'utc');
      const row = d.allocation.rows.find((r) => r.date === new Date(b3.tc_ms).toISOString().slice(0, 10));
      assert.strictEqual(row.hours, 15, 'the closing day reports 15 flowing hours');
      assert.near(24 * row.oil / 15 / b3.qTrue, 1, 0.12, '24·V/15 reads the flowing rate (3 % allocation noise)');
      // 135 days of record and allocation; 1 min inside events and the day before, 5 min elsewhere
      assert.strictEqual(d.allocation.rows.length, 135);
      assert.near((d.record.t[d.record.n - 1] - d.record.t[0]) / DAY, 135, 0.01, '135 days');
      const t = d.record.t, inside = [], outside = [];
      for (let i = 1; i < d.record.n; i++) {
        const dtS = (t[i] - t[i - 1]) / 1000, mid = 0.5 * (t[i] + t[i - 1]);
        const near = ev.some((e) => mid >= e.tc_ms - DAY && mid <= e.tc_ms + e.dur_h * H);
        (near ? inside : outside).push(dtS);
      }
      assert.strictEqual(medianOf(inside), 60, '1 min sampling near events'); assert.strictEqual(medianOf(outside), 300, '5 min elsewhere');
      // expected grades recorded (noise-free prediction of the §4.6 item 3 rule, margin ≥ 0.1 from the nearest other grade)
      deq(assert, T.tests.map((x) => x.grade), ['fair', 'fair', 'fair', 'fair', 'fair', 'fair', 'fair', 'fair', 'fair'], 'expected grades');
      T.tests.forEach((x) => assert(x.gradeMargin >= 0.1, x.id + ' grade margin ' + x.gradeMargin));
      deq(assert, d.expect.delta, { raisedAt: 'B6', confirmedAt: 'B7' }); deq(assert, d.expect.absolute, { raisedAt: 'B7', confirmedAt: 'B8' });
      // contracts
      assert(S.checkShape('GaugeRecord', d.record).ok); assert(S.checkShape('WellInput', d.well).ok);
      const inp = d.input || env(ctx).SY.toInput(d);
      const ri = S.checkShape('AnalysisInput', inp); assert(ri.ok, JSON.stringify(ri.errors.slice(0, 4)));
      assert.strictEqual(inp.history.mode, 'date'); assert.strictEqual(inp.record.source, 'demo');
      // deterministic: the memoised copy is a deep copy with the same hash
      const d2 = env(ctx).SY.demo('oil'); assert.strictEqual(d2.record.hash, d.record.hash); d2.truth.tests[0].S = 99; assert.strictEqual(env(ctx).SY.demo('oil').truth.tests[0].S, 1.2);
    },
  },
  {
    name: 'GE5 gas demo: rate ratio 2.0, D·q = 2.0 at the high rate, 3 + 3 constant-skin tests, D/se ≥ 6 with S_err = 0.2',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const d = demo(ctx, 'gas'), T = d.truth, tests = T.tests;
      assert.strictEqual(d.seed, 3302); assert.strictEqual(tests.length, 8, '8 build-ups'); assert.strictEqual(d.well.fluid, 'gas');
      const hi = tests.filter((t) => Math.abs(t.qTrue - T.qHigh) < 1e-6), lo = tests.filter((t) => Math.abs(t.qTrue - T.qLow) < 1e-6);
      assert.strictEqual(T.rateRatio, 2.0); assert.near(T.qHigh / T.qLow, 2.0, 1e-12, 'rate ratio 2.0');
      deq(assert, tests.map((t) => (t.qTrue === T.qHigh ? 'H' : 'L')).join(''), 'HLHLHLHH', 'high, low, … then two high');
      assert.near(T.DqHigh, 2.0, 1e-12, 'D·q at the high rate'); assert.near(T.D * T.qLow, 1.0, 1e-12, 'D·q at the low rate');
      const first6 = tests.slice(0, 6);
      assert(first6.every((t) => t.Smech === first6[0].Smech), 'constant mechanical skin on the first 6');
      assert.strictEqual(hi.filter((t) => first6.includes(t)).length, 3); assert.strictEqual(lo.length, 3, '3 + 3 constant-skin tests');
      deq(assert, tests.slice(6).map((t) => +(t.Smech - first6[0].Smech).toFixed(9)), [2.5, 5], 'then +2.5 and +5');
      // test 7 raises the delta alert on both bases (S′ and mechanical, baseN = 3, threshold 2) without the immediate
      // confirmation of §4.7 (excess ≥ 1); test 8 confirms
      const M = 0.1, SSg = tests.map((t) => t.SStar), baseP = (SSg[0] + SSg[1] + SSg[2]) / 3, exP = SSg[6] - baseP - 2, exM = tests[6].Smech - first6[0].Smech - 2;
      assert(exP > M && exP < 1 - M, 'S′ excess at test 7 ' + exP.toFixed(2));
      assert(exM > M && exM < 1 - M, 'mechanical excess at test 7 ' + exM.toFixed(2));
      assert(SSg.slice(0, 6).every((s) => s - baseP < 2 - M), 'no delta alert on the constant-skin tests');
      assert(SSg[7] - baseP >= 2 + M && tests[7].Smech - first6[0].Smech >= 2 + M, 'test 8 confirms');
      // gas B is Bg in rb/Mscf (q in Mscf/d) and the WellInput passes the run layer's well check. Explicit stub of that check
      // (§3: another WP's function in a WP4 test): WP2's WELL_RANGES in 49-calc-buildup-run.js, copied here, with its gas B
      // range B_GAS [0.3, 5].
      const RANGES = { h: [1, 2000], phi: [0.01, 0.5], mu: [0.01, 1000], B: [0.3, 5], ct: [1e-7, 1e-3], rw: [0.1, 2] };
      const wellOk = (w) => Object.keys(RANGES).filter((k) => !(w[k] >= RANGES[k][0] && w[k] <= RANGES[k][1]));
      const SY = env(ctx).SY;
      const one = SY.generate(SY.caseFromSeed(100400, { lite: true })), seq = SY.generateSequence(200112, { lite: true });
      [['demo', d.well], ['single case 100400', one.well], ['sequence 200112', seq.well]].forEach(([what, w]) => {
        assert.strictEqual(w.fluid, 'gas', what);
        assert(w.B >= 0.3 && w.B <= 5, what + ': gas B ' + w.B + ' rb/Mscf');
        deq(assert, wellOk(w), [], what + ': passes the well check');
      });
      assert.near(d.well.B, 5.035 * d.info.gasRef.z * (220 + 459.67) / d.info.gasRef.p, 1e-4 * d.well.B, 'Bg = 5.035·z·T/p at the reference pressure');
      for (let s = 100388; s < 100468; s++) { const cs = SY.caseFromSeed(s); assert(cs.given.B >= 0.32 && cs.given.B <= 5, s + ' gas B ' + cs.given.B); }
      // S′ = S + D·q: the constant-skin tests differ by D·Δq = 1.0 < 2 (no delta alert expected)
      const Sp = first6.map((t) => t.S);
      assert.near(Math.max(...Sp) - Math.min(...Sp), 1.0, 1e-9, 'S′ spread on the constant tests');
      const dS = (hi.slice(0, 3).reduce((a, t) => a + t.S, 0) - lo.reduce((a, t) => a + t.S, 0)) / 3;
      const se = 0.2 * Math.sqrt(1 / 3 + 1 / 3);
      assert.near(se, 0.163, 5e-4, 'se(ΔS′)'); assert.near(dS, 1.0, 1e-9, 'ΔS′ = 1.0');
      assert(dS / se >= 6, 'D/se = ' + (dS / se).toFixed(2));
      deq(assert, d.expect.delta, { raisedAt: 'B7', confirmedAt: 'B8' });
      assert(S.checkShape('GaugeRecord', d.record).ok); assert(S.checkShape('WellInput', d.well).ok);
      assert(S.checkShape('AnalysisInput', env(ctx).SY.toInput(d)).ok);
      assert(d.allocation.rows.every((r) => r.gas !== null && r.oil === 0), 'gas volumes in the gas column');
    },
  },
  {
    name: 'GE6 caseFromSeed follows the fixed seed table, covers every stratum, parameters within the §5.2 ranges',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const { SY } = env(ctx);
      const table = [['hom', 232], ['fault', 60], ['comp', 60], ['closed', 36], ['gas', 80], ['inj', 24], ['dualpor', 36], ['channel', 24], ['wbschange', 18],
                     ['partpen', 12], ['frac', 12], ['constp', 12], ['interf', 12], ['partial', 10], ['baddata', 12]];
      let s0 = 100000;
      deq(assert, SY.SEED_TABLE.map((e) => [e.stratum, e.n]), table, 'strata order and sizes');
      SY.SEED_TABLE.forEach((e) => { assert.strictEqual(e.from, s0); assert.strictEqual(e.to, s0 + e.n - 1); s0 += e.n; });
      assert.strictEqual(s0, 100640, '640 single cases');
      const R = SY.RANGES, inR = (v, r, what) => assert(v >= r[0] * (1 - 1e-9) && v <= r[1] * (1 + 1e-9), what + ' = ' + v + ' outside [' + r + ']');
      const seen = new Set(), sCells = {}, all = [];
      let edge = 0;
      for (let seed = 100000; seed <= 100639; seed++) {
        const cs = SY.caseFromSeed(seed), e = SY.SEED_TABLE.find((x) => seed >= x.from && seed <= x.to), t = cs.truth;
        all.push(cs);
        assert.strictEqual(cs.seed, seed); assert.strictEqual(cs.stratum, e.stratum); assert.strictEqual(cs.row, seed - e.from);
        seen.add(cs.stratum);
        inR(t.k, R.k, seed + ' k'); inR(t.h, R.h, seed + ' h'); inR(t.S, R.S, seed + ' S'); inR(t.C, R.C, seed + ' C'); inR(t.phi, R.phi, seed + ' φ'); inR(t.rw, R.rw, seed + ' rw');
        if (cs.stratum === 'gas') {
          inR(t.q, R.qGas, seed + ' q (gas)'); inR(t.D * t.q, [0, 2], seed + ' D·q');
          ['co2', 'h2s', 'n2'].forEach((k) => inR(cs.gas[k], [0, 10], seed + ' ' + k));
        } else {
          inR(t.q, R.q, seed + ' q'); inR(t.B, R.B, seed + ' B'); inR(t.mu, R.mu, seed + ' μ'); inR(t.ct, R.ct, seed + ' ct');
        }
        assert(cs.check.ok, seed + ': the rejection rule holds (Δp(Δt_end) ≥ 5 psi, pwf ≥ 50 psia)');
        if (cs.check.dpEnd_psi < 6.5) edge++;
        if (cs.highKh) assert(t.k * t.h >= 20000 * (1 - 1e-9), seed + ': high-kh case keeps kh ≥ 20,000 md·ft (' + t.k * t.h + ')');
        assert(cs.test.dtEnd_h >= 2 && cs.test.dtEnd_h <= 200, seed + ' duration');
        const cell = Math.min(e.n - 1, Math.floor((t.S + 2) / 17 * e.n));
        (sCells[e.stratum] = sCells[e.stratum] || new Set()).add(cell);
        if (seed % 40 === 0) { const r = S.checkShape('CaseSpec', JSON.parse(JSON.stringify(cs))); assert(r.ok, seed + ': ' + JSON.stringify(r.errors.slice(0, 3))); }
      }
      assert.strictEqual(seen.size, 15, 'every stratum covered');
      // rescaled cases aim at a per-case level (log-uniform 6–60 psi), so they do not pile up at the rejection edge
      assert(edge / 640 <= 0.05, 'cases at the rejection edge (Δp(Δt_end) < 6.5 psi): ' + edge + ' of 640');
      SY.SEED_TABLE.forEach((e) => assert.strictEqual(sCells[e.stratum].size, e.n, e.stratum + ': S is Latin-hypercube stratified (one row per cell)'));
      // short tests: 20 % of hom at 2–8 h
      const hom = SY.SEED_TABLE[0], shortN = all.slice(0, hom.n).filter((c) => c.test.dtEnd_h < 8).length;
      assert(Math.abs(shortN / hom.n - 0.2) < 0.01, 'hom short share ' + shortN / hom.n);
      // pure function of the seed; seeds outside the table refused
      deq(assert, JSON.parse(JSON.stringify(SY.caseFromSeed(100321))), JSON.parse(JSON.stringify(SY.caseFromSeed(100321))));
      assert.throws(() => SY.caseFromSeed(99999)); assert.throws(() => SY.caseFromSeed(100640));
      // at least 40 % of cases contain an effect the engine does not model (§5.2; the generator reports the share)
      // (SY.unmodelledShare() runs the same count over the table; computed here from the cases already built)
      assert.strictEqual(typeof SY.unmodelledShare, 'function');
      const share = { share: 0, byEffect: {} };
      all.forEach((cs) => { const ef = SY.unmodelledEffects(cs); if (ef.length) share.share += 1 / 640; ef.forEach((x) => { share.byEffect[x] = (share.byEffect[x] || 0) + 1; }); });
      assert(share.share >= 0.40, 'unmodelled share ' + share.share); assert.strictEqual(share.byEffect.physics, 130, '126 distractor cases + 4 injector fractures');
      // the 24 in-app cases sit in their strata
      const ia = SY.IN_APP;
      assert.strictEqual(ia.length, 24);
      ia.forEach((c) => assert.strictEqual(SY.caseFromSeed(c.seed).stratum, c.stratum, c.seed + ' stratum'));
      // sequences: 120 seeds, the five paths in fixed ranges
      deq(assert, SY.SEQUENCES.paths.map((p) => [p.path, p.n]), [['constant', 48], ['step', 24], ['linear', 24], ['stimulation', 12], ['gasRate', 12]]);
      const sq = SY.sequenceFromSeed(200050);
      assert.strictEqual(sq.path, 'step'); assert(sq.nTests >= 6 && sq.nTests <= 12 && sq.days >= 90);
      assert.throws(() => SY.sequenceFromSeed(200120));
    },
  },
  {
    name: 'GE7 source grep: no data layer, no fitted PRiSM kernels, no unseeded random numbers, no timers',
    wp: WP, opts: false,
    run(app, assert) {
      const src = fs.readFileSync(SRC, 'utf8');
      ['WTS_buildup.data', 'PRiSM_MODELS.homogeneous', 'linearBoundary', 'radialComposite', 'closedCircle', 'PRiSM_evalWbsSkin', 'Math.random'].forEach((w) => {
        assert.strictEqual(src.indexOf(w), -1, 'the generator must not reference ' + w);
      });
      assert(!/\brandom\s*\(/.test(src), 'no random() call through any alias');
      assert(!/PRiSM_MODELS/.test(src), 'no PRiSM model registry at all');
      assert(!/\b(setTimeout|setInterval|requestAnimationFrame)\b/.test(src), 'no timers');
      assert(/helper module: does not add a page to window\.WTS_calcRegistry/.test(src), 'helper-module header');
      assert(!/WTS_calcRegistry\s*\./.test(src.replace(/^\s*\/\/.*$/gm, '')), 'registers no page');
    },
  },
  {
    name: 'GE8 truth follows the given inputs and the true hours; score never reads the engine Δq; records ≤ 500k samples',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const { SY } = env(ctx);
      const F = S.FORMULAS;
      // a plain allocation case: clean closing day, no ramp / cut / intra-day change / table / offset
      let plain = null;
      for (let s = 100010; s < 100232 && !plain; s++) {
        const cs = SY.caseFromSeed(s, { lite: true });
        if (cs.test.ramp_s || cs.test.partialBefore || cs.alloc.ignoresShutin || cs.alloc.hoursConflict_h || cs.history.intraDayChange || cs.rateSource !== 'allocation' ||
            cs.dayStart.trueHour !== cs.dayStart.statedHour || cs.test.closeHour < 8 || cs.history.earlierShutins) continue;
        plain = cs;
      }
      assert(plain, 'found a plain case');
      const sc = SY.generate(plain);
      const tr = sc.truth, g = plain.given, t = plain.truth;
      assert.near(tr.f, tr.qCorrect / tr.qTrue, 1e-12, 'f = q_correct/q_true');
      assert.near(tr.kStar, F.kStar(t, g, tr.f), 1e-9 * tr.kStar, 'k* = f·k·(B′/B)(μ′/μ)(h/h′)');
      assert.near(tr.SStar, F.SStar(t, g, tr.f), 1e-9, 'S* (§5.3)');
      const day = new Date(tr.tc_ms).toISOString().slice(0, 10), row = sc.allocation.rows.find((r) => r.date === day);
      const hOn = plain.test.closeHour;   // flowing from 00:00 to the closing
      assert.near(row.hours, hOn, 0.011, 'true flowing hours reported on the closing day');
      assert.near(tr.qCorrect, 24 * row.oil / hOn, 1e-6 * tr.qCorrect, 'q_correct = 24·V_given/h_true,on');
      // a case with a partial cut before the closing: q_correct is the post-cut rate, f stays near 1
      let pb = null;
      for (let s = 100000; s < 100232 && !pb; s++) { const cs = SY.caseFromSeed(s, { lite: true }); if (cs.test.partialBefore && cs.rateSource === 'allocation' && !cs.alloc.ignoresShutin) pb = cs; }
      const scp = SY.generate(pb);
      assert(scp.truth.f > 0.8 && scp.truth.f < 1.25, 'partial-cut f ' + scp.truth.f);
      assert.near(scp.truth.SStar, F.SStar(pb.truth, pb.given, scp.truth.f), 1e-9);
      // "ignores the shut-in": the neighbouring-day reference rate
      let ig = null;
      for (let s = 100000; s < 100232 && !ig; s++) { const cs = SY.caseFromSeed(s, { lite: true }); if (cs.alloc.ignoresShutin && !cs.test.partialBefore && cs.rateSource === 'allocation') ig = cs; }
      const sci = SY.generate(ig);
      assert.strictEqual(sci.truth.dqSource, 'qref'); assert(sci.truth.f > 0.75 && sci.truth.f < 1.3, 'ignores-shut-in f ' + sci.truth.f);
      // score: reads k̂, Ŝ, model, flags, status and label — never Δq (Δq only feeds rateErrPct)
      const truth = sc.truth;
      const entry = (k, Sk, Dq, label) => ({ id: 'B1', status: 'interpreted', Dq, tc_ms: truth.tc_ms,
        result: { final: { k, S: Sk, gas: null }, chosen: { key: 'homogeneous', label: label || 'Homogeneous', fullySeen: { status: 'n/a' } }, flags: [], triggers: { fired: [] },
                  confidence: { ks: 'high', model: 'high', headline: 'high' } } });
      const good = SY.score(entry(truth.kStar, truth.SStar, 1.3 * truth.qCorrect), truth);
      assert.strictEqual(good.ksRight, true, 'right k and S with a wrong Δq still score right'); assert.strictEqual(good.fullyRight, true);
      assert.near(good.rateErrPct, 30, 1e-6, 'Δq only reaches the rate-accuracy figure');
      const bad = SY.score(entry(truth.kStar * 1.3, truth.SStar - 1.1513 * Math.log10(1.3), 1.3 * truth.qCorrect), truth);
      assert.strictEqual(bad.kRight, false); assert.strictEqual(bad.fullyRight, false, 'a stub engine that used a 30 % high Δq is not right');
      assert(S.checkShape('Score', good).ok && S.checkShape('Score', bad).ok);
      const ab = SY.score(null, truth); assert.strictEqual(ab.abstained, true); assert.strictEqual(ab.status, 'missed'); assert.strictEqual(ab.fullyRight, false);
      const rival = SY.score(entry(truth.kStar, truth.SStar, truth.qCorrect, 'Sealing fault'), truth); assert.strictEqual(rival.modelRight, false, 'homogeneous truth needs homogeneous');
      // partial and bad-data truths score on the classification only
      const pTruth = Object.assign({}, truth, { partial: true, model: 'partial' });
      assert.strictEqual(SY.score(null, pTruth, { event: { id: 'E1', kind: 'partial', status: 'partial' } }).fullyRight, true);
      assert.strictEqual(SY.score(entry(truth.kStar, truth.SStar, truth.qCorrect), pTruth).fullyRight, false, 'interpreting a partial cut is wrong');
      const bTruth = Object.assign({}, truth, { notAnalysable: true, model: 'baddata' });
      assert.strictEqual(SY.score(null, bTruth, { event: { id: 'E2', kind: 'shutin', status: 'gap_at_closing' } }).fullyRight, true);
      // match by closing time (within 1 h)
      const an = { events: [{ id: 'E3', tc_ms: truth.tc_ms + 120000, kind: 'shutin', status: 'analysable' }], tests: [Object.assign(entry(truth.kStar, truth.SStar, truth.qCorrect), { eventId: 'E3' })] };
      const m = SY.scoreAnalysis(an, sc); assert.strictEqual(m.test.id, 'B1'); assert.strictEqual(m.score.fullyRight, true);
      // records are capped (500k by default; the cap coarsens the sampling first)
      assert.strictEqual(SY.UNIT.maxSamples, 500000);
      const capped = SY.generate(SY.caseFromSeed(plain.seed, { lite: true }), { maxSamples: 3000 });
      assert(capped.record.n <= 3000 && capped.record.n > 500, 'capped record ' + capped.record.n);
    },
  },
  {
    name: 'GE8b closing ramp: t_c at the ramp midpoint; S*, k* and the grade equal the no-ramp values (dualpor, frac); gas WellInput and resolution',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const { SY } = env(ctx);
      // §4.3: with a closing ramp t_c is the ramp midpoint, Δp is referenced to the pre-ramp flowing level extrapolated to it,
      // so the reference build-up (first-plateau truth of distractors, grade) is the one of an instantaneous closing there
      [[100502, 'dualpor'], [100592, 'frac']].forEach(([seed, st]) => {
        const cs = SY.caseFromSeed(seed, { lite: true });
        assert.strictEqual(cs.stratum, st); assert(cs.test.ramp_s > 60, seed + ' has a closing ramp (' + cs.test.ramp_s + ' s)');
        const cs0 = JSON.parse(JSON.stringify(cs)); cs0.test.ramp_s = 0;
        const a = SY.generate(cs).truth, b = SY.generate(cs0).truth;
        assert(a.plateaus.length >= 1 && a.distractor, seed + ': distractor scored on its first plateau');
        assert.near(a.tc_ms, b.tc_ms - 500 * cs.test.ramp_s, 1, seed + ': truth t_c at the ramp midpoint');
        assert(Math.abs(a.SStar - b.SStar) <= 0.1, seed + ' S* ' + a.SStar + ' vs ' + b.SStar);
        assert(Math.abs(a.kStar / b.kStar - 1) <= 0.01, seed + ' k* ' + a.kStar + ' vs ' + b.kStar);
        // the grade is compared where neither prediction sits on a grade threshold (100502 without the ramp is exactly on
        // the fair/good boundary, margin 0)
        if (a.gradeMargin >= 0.1 && b.gradeMargin >= 0.1) assert.strictEqual(a.grade, b.grade, seed + ' grade');
        else assert.strictEqual(seed, 100502, 'only the documented knife-edge case skips the grade comparison');
      });
      // gas single case: B in rb/Mscf, volumes resolved as generated (gas column to spec.alloc.resolution, water to 0.1)
      let gs = 100388; while (SY.caseFromSeed(gs).rateSource !== 'allocation') gs++;
      const g = SY.generate(SY.caseFromSeed(gs, { lite: true })), inp = SY.toInput(g);
      assert(g.well.B >= 0.5 && g.well.B <= 5, 'gas B ' + g.well.B);
      deq(assert, inp.allocation.resolution, { oil: null, gas: g.spec.alloc.resolution, water: 0.1 }, 'gas resolution');
      let os = 100041; while (SY.caseFromSeed(os).rateSource !== 'allocation') os++;
      const o = SY.generate(SY.caseFromSeed(os, { lite: true }));
      deq(assert, SY.toInput(o).allocation.resolution, { oil: o.spec.alloc.resolution, gas: 0.1, water: o.spec.alloc.resolution }, 'oil resolution');
      // gas S* follows the engine's μ rule (§4.6 item 1): μ at the realised noise-free mean of pwf0 and the last build-up pressure
      const gt = g.truth, gm = gt.gasMu, gv = g.spec.given, gr = g.spec.truth;
      assert(gm && gm.pBar > 0 && gm.pBar < g.spec.pi, 'gas μ reference pressure ' + (gm && gm.pBar));
      assert.near(gm.mu, g.spec.gasRef.mu, 0.05 * gm.mu, 'μ(p̄) near the planning estimate');
      const sx = gt.S + 1.1513 * Math.log10((gv.h / gr.h) * (gv.phi / gr.phi) * (gv.ct / gr.ct)) + 2.3026 * Math.log10(gv.rw / gr.rw) - 1.1513 * Math.log10((gv.B / gr.B) * gt.f) + 1.1513 * Math.log10(gm.mu / gv.mu);
      assert.near(gt.SStarInputs, sx, 1e-4, 'gas S* = S′ + input terms + 1.1513·log10(μ(p̄)/μ′)');
    },
  },
  {
    name: 'GE9 file 55 placeholder passes checkShape(Cal) and is what the tool writes; tool helpers and calibration on stub outcomes',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const tool = require('../buildup-validate.js');
      const file = path.join(__dirname, '..', '55-prism-autointerp-cal.js');
      const src = fs.readFileSync(file, 'utf8');
      assert(src.indexOf('GENERATED by buildup-validate.js — do not edit by hand') !== -1, 'generated header');
      const { stripSelfTest } = require('../concat-round8.js');
      const c = { console: { log() {}, warn() {} } }; c.window = c; vm.createContext(c);
      vm.runInContext(stripSelfTest(src, '55', { log() {}, warn() {} }), c);
      const cal = JSON.parse(JSON.stringify(c.PRiSM_autoInterpCal));
      const r = S.checkShape('Cal', cal); assert(r.ok, JSON.stringify(r.errors.slice(0, 5)));
      if (!cal.calibrated) {
        assert.strictEqual(cal.version, 'cal-0');
        deq(assert, cal.thresholds, tool.PRE_THRESHOLDS, 'pre-calibration thresholds');
        assert.strictEqual(tool.calSource(tool.placeholderCal(cal.generated)), src, 'file 55 is exactly the placeholder the tool writes');
      }
      assert(Object.isFrozen(c.PRiSM_autoInterpCal) && Object.isFrozen(c.PRiSM_autoInterpCal.thresholds), 'deep-frozen');
      assert.strictEqual(cal.inApp.length, 24);
      // the in-app list of the tool and of the generator agree (before calibration)
      const { SY } = env(ctx);
      if (!cal.calibrated) deq(assert, SY.IN_APP.map((x) => [x.seed, x.stratum]), tool.IN_APP_PROVISIONAL);
      // statistics helpers
      const w = tool.wilson(95, 100); assert.near(w.rate, 0.95, 1e-12); assert.near(w.lo, 0.8882, 1e-3); assert.near(w.hi, 0.9785, 1e-3);
      deq(assert, tool.parseSeeds('100000-100002,100010'), [100000, 100001, 100002, 100010]);
      assert.near(tool.quantile([1, 2, 3, 4], 0.5), 2.5, 1e-12);
      assert.strictEqual(tool.combos({ a: [1, 2], b: [3, 4, 5] }).length, 6);
      // folds are grouped by well: a well's tests never split
      const cases = [{ g: 'q1', stratum: 'hom', durClass: 'long' }, { g: 'q1', stratum: 'hom', durClass: 'long' }, { g: 's2', stratum: 'hom', durClass: 'long' }, { g: 's3', stratum: 'gas', durClass: 'long' }];
      const fo = tool.foldsOf(cases, 5); assert.strictEqual(fo[0], fo[1], 'one well, one fold');
      // the margin of an evidence vector to the nearest threshold
      assert.near(tool.marginOf({ snrD: 25, sErr: 0.45, pointSkinSpread: 0.1 }, tool.PRE_THRESHOLDS), 0.1, 1e-9);
      // cluster bootstrap is deterministic (seeded) and brackets the pooled rate
      const items = Array.from({ length: 60 }, (_, i) => ({ g: 'w' + Math.floor(i / 5), y: i % 7 !== 0 }));   // 12 wells of 5, pooled rate 51/60
      const b1 = tool.clusterBootstrap(items, SY.rng, 400), b2 = tool.clusterBootstrap(items, SY.rng, 400);
      deq(assert, b1, b2); assert(b1.lo < 0.85 && b1.hi > 0.85 && b1.hi - b1.lo > 0.05, JSON.stringify(b1));
      // sequence metrics on stub lines
      const seq = (path, delta) => ({ kind: 'sequence', seed: 1, path, shutClass: '24-48', truth: { path, constantS: path === 'constant', onsetIdx: null, tests: [{ S: 1, tDays: 0 }, { S: 1, tDays: 14 }, { S: 1, tDays: 28 }] },
                                     alerts: { plain: { delta: { status: delta, raisedAt: null, confirmedAt: null }, absolute: { status: 'none' } }, basevar: null }, matched: [] });
      const sm = tool.sequenceMetrics([seq('constant', 'none'), seq('constant', 'confirmed'), seq('constant', 'possible'), seq('constant', 'none')], 'plain');
      assert.strictEqual(sm.falseAlarmDelta, 0.25, 'one of four constant wells raised a delta alert');
      // the calibration path on stub outcomes: a stub labeller (S_err and SNR rules) over 60 synthetic single-case lines
      const stubAI = { version: '1.0', confidence(ev, calT) {
        const th = calT.thresholds; let L = 'medium';
        if (ev.sErr > th.sErrLow || ev.snrD < th.snrLow) L = 'low'; else if (ev.sErr <= th.sErrHigh && ev.snrD >= th.snrHigh) L = 'high';
        return { ks: L, model: L, headline: L };
      } };
      const lines = Array.from({ length: 60 }, (_, i) => {
        const sErr = 0.2 + 0.02 * i, truthL = { tc_ms: 1.7e12, model: 'homogeneous', kStar: 50, SStar: 2, qCorrect: 500, visible: {}, notAnalysable: false, partial: false,
                                                  distractor: false, stratum: 'hom', Cd: 1000, tDCDend: 1e4, dtEnd_h: 48 };
        const test = { id: 'B1', status: 'interpreted', Dq: 500, tc_ms: 1.7e12, result: { final: { k: 50 * (1 + 0.01 * ((i % 7) - 3)), S: 2 + sErr * 0.8 * ((i % 5) - 2) / 2, gas: null },
          chosen: { key: 'homogeneous', label: 'Homogeneous', fullySeen: { status: 'n/a' } }, flags: [], triggers: { fired: [] }, confidence: { ks: 'medium', model: 'medium', headline: 'medium' },
          sErr: { value: sErr, mode: 'line', floor: 0.2, seS: sErr, dLineMatch: 0, sWin: 0, sTc: 0, sPwf: 0, sK: null }, bic: { rows: [], chosen: 'homogeneous' }, models: [], kHeld: false } };
        return { kind: 'single', seed: 100000 + i, stratum: 'hom', durClass: 'long', fluid: 'oil', truth: truthL, test, event: null, error: null, gen_ms: 1, analyse_ms: 1,
                 outcome: SY.score(test, truthL), evidence: { sErr, snrD: 40 - 0.5 * i, pointSkinSpread: 0.1 } };
      });
      // non-analysable truths: a partial cut the engine correctly left unlabelled stays out of both tables (§5.3); one it
      // interpreted keeps its label with y = false
      const pTruth = Object.assign({}, lines[0].truth, { partial: true, model: 'partial' });
      const evP = { id: 'E9', kind: 'partial', status: 'partial' };
      lines.push({ kind: 'single', seed: 100620, stratum: 'partial', durClass: 'long', fluid: 'oil', truth: pTruth, test: null, event: evP, error: null, gen_ms: 1, analyse_ms: 1,
                   outcome: SY.score(null, pTruth, { event: evP }), evidence: null });
      const wrongTest = JSON.parse(JSON.stringify(lines[1].test));
      lines.push({ kind: 'single', seed: 100621, stratum: 'partial', durClass: 'long', fluid: 'oil', truth: pTruth, test: wrongTest, event: null, error: null, gen_ms: 1, analyse_ms: 1,
                   outcome: SY.score(wrongTest, pTruth), evidence: { sErr: 0.3, snrD: 39, pointSkinSpread: 0.1 } });
      const res = tool.calibrate(lines, { SY, AI: stubAI }, { gridSample: 5000 });
      res.cal.inApp = [];
      const rc = S.checkShape('Cal', JSON.parse(JSON.stringify(res.cal))); assert(rc.ok, JSON.stringify(rc.errors.slice(0, 5)));
      assert.strictEqual(res.cal.calibrated, true); assert.strictEqual(res.cal.nBuildups, 61, '60 analysable + the wrongly interpreted partial cut');
      assert.strictEqual(res.cal.ksTable.reduce((a, x) => a + x.n, 0), 61, 'the unlabelled partial cut is not in the k/S table');
      const allY = []; LABELS_OF(res.T.hd).forEach((x) => allY.push(x));
      assert(!allY.some((x) => x.i === 60), 'unlabelled non-analysable truth left out');
      assert(allY.some((x) => x.i === 61 && x.y === false), 'interpreted partial cut kept, y = false');
      // Brier with training-fold forecasts: the Murphy identity BS = REL − RES + UNC holds over the forecast bins
      assert.near(res.cal.brier, res.cal.reliability - res.cal.resolution + res.cal.uncertainty, 1e-12, 'Murphy decomposition');
      const sm2 = tool.summarize(lines, { SY });
      assert.strictEqual(sm2.statusAccuracy.partial.n, 2); assert.strictEqual(sm2.statusAccuracy.partial.right, 1, 'status accuracy of partial truths reported apart');
      const md = tool.markdown(res.cal, sm2);
      assert(md.indexOf('## Headline label') !== -1 && md.indexOf('## Non-analysable truth') !== -1 && md.indexOf('## Reach') !== -1);
      assert(!/\bnull\b|\bundefined\b/.test(md), 'calibration.md prints no null/undefined text');
      // §5.4 lower bounds: Wilson on the single cases AND a cluster bootstrap over wells on the pooled table. Stub: 40 single
      // cases right, 20 sequence wells of 20 tests with one well entirely wrong: pooled rate 0.952 and pooled Wilson bound 0.927
      // pass, but the tests of one well are correlated and the cluster bound falls below 0.90
      const mk = (bad) => {
        const it = []; let i = 0;
        for (let s = 0; s < 40; s++) it.push({ i: i++, g: 's' + s, single: true, y: true, dS: null, cov: null });
        for (let w = 0; w < 20; w++) for (let k = 0; k < 20; k++) it.push({ i: i++, g: 'q' + w, single: false, y: bad(w, k), dS: null, cov: null });
        return { ks: { high: it, medium: [], low: [] }, hd: { high: it.map((x) => Object.assign({}, x)), medium: [], low: [] } };
      };
      const Tc = mk((w) => w !== 7), pooled = tool.wilson(400, 420);
      assert(pooled.rate >= 0.95 && pooled.lo >= 0.90, 'pooled Wilson passes (' + pooled.lo.toFixed(3) + ')');
      const fc = tool.checkTargets(Tc, { rng: SY.rng });
      assert(fc.some((f) => /cluster-bootstrap/.test(f)), 'the cluster bound fails: ' + JSON.stringify(fc));
      // the same 20 wrong tests spread one per well: the cluster bound passes
      const Ts = mk((w, k) => k !== w % 20 || w >= 20);
      deq(assert, tool.checkTargets(Ts, { rng: SY.rng }), [], 'spread errors pass');
      // sequence targets: the stimulation drop without a workover date classified as a shut-in; no delta alert on
      // constant-skin gas wells with D resolved
      const stim = (kind, status) => ({ kind: 'sequence', seed: 2, path: 'stimulation', shutClass: '24-48',
        truth: { path: 'stimulation', constantS: false, onsetIdx: 2, workover: { afterTest: 3, entered: false }, tests: [{ S: 1, tDays: 0 }, { S: 1, tDays: 14 }, { S: 1, tDays: 28 }, { S: 6, tDays: 42 }, { S: 0, tDays: 56 }] },
        alerts: { plain: { delta: { status: 'confirmed', raisedAt: 'B4', confirmedAt: 'B5' }, absolute: { status: 'none' } }, basevar: null },
        matched: [0, 1, 2, 3, 4].map((j) => ({ truthIdx: j, testId: 'B' + (j + 1), event: j === 4 ? { id: 'E5', kind, status } : { id: 'E' + (j + 1), kind: 'shutin', status: 'analysable' } })) });
      const gasW = (raisedD) => ({ kind: 'sequence', seed: 3, path: 'gasRate', shutClass: '48-120', truth: { path: 'gasRate', constantS: true, onsetIdx: null, tests: [{ S: 2, tDays: 0 }, { S: 1, tDays: 14 }, { S: 2, tDays: 28 }] },
        alerts: { plain: { delta: { status: raisedD ? 'provisional' : 'none' }, absolute: { status: 'none' }, rateSkin: { resolved: true } }, basevar: null }, matched: [] });
      const sm3 = tool.sequenceMetrics([stim('shutin', 'analysable'), stim('partial', 'partial'), gasW(false), gasW(true)], 'plain');
      assert.strictEqual(sm3.stimN, 2); assert.strictEqual(sm3.stimShutinRate, 0.5, 'one of two post-workover tests classified as a shut-in');
      assert.strictEqual(sm3.gasResolvedN, 2); assert.strictEqual(sm3.gasNoAlertWhenDResolved, 0.5, 'one resolved gas well raised a delta alert');
    },
  },
];
