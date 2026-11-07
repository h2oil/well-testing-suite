// DFIT — WP5 synthetic generator tests (docs/DFIT-PLAN.md §8.1–§8.3, §9 WP5).
//
//   S1  determinism by seed: make(spec, seed) is identical on repeat and with 05's PRiSM_rng present or absent; another seed
//       changes the noise only; demos are stable; no unseeded randomness
//   S2  the seven demos pass checkShape('DfitDataset') and their role-header CSV re-parses through 07 (PRiSM_datasetFromText)
//       to the same arrays
//   S3  each artefact injector changes only its target channel (row-thinning injectors keep the retained rows unchanged)
//   S4  truth fields complete for every source (gdomain, aca-exact, lk through a contract stub of PRiSM_dfit_lkSimulate, the
//       two-cycle demo), incl. A_f·c_f, R_vis, xf, σ_c,F2; LK_UNAVAILABLE without 58; cases() counts and CaseSpec shapes
//   S5  aca-exact reproduces the example A and B tables (Δp and D) within 0.1 %; when 57's PRiSM_dfit_acaDiag is implemented,
//       its D on the exact example-B record agrees with the exact D (skipped with a note until WP3 lands)
//   S6  no Math.random in any DFIT source file
//   S7  with the real 58 (integration): lk truth R_vis storage-consistent through lkVwcwAt; the storage label follows it
//
// Engine tests: opts:false. S1/S3/S4/S5 load 49-calc-dfit-synth.js in a bare vm context (no document); S2 uses one shared app.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SH = require('./_dfit-shapes');

const WP = 'DF5';
const BUILD = path.join(__dirname, '..');
const SYNTH = '49-calc-dfit-synth.js';

function strip(src, f) { const { stripSelfTest } = require(path.join(BUILD, 'concat-round8.js')); return stripSelfTest(src, f, { log() {}, warn() {} }); }
// a bare context with the synth file (and optional extra globals installed before it loads)
function bare(extra, withSelfTest) {
  const warns = [];
  const ctx = { console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error: (...a) => warns.push(a.join(' ')) } };
  ctx.window = ctx;
  if (extra) Object.assign(ctx, extra);
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(BUILD, SYNTH), 'utf8');
  vm.runInContext(withSelfTest ? src : strip(src, SYNTH), ctx, { filename: SYNTH });
  return { S: ctx.PRiSM_dfit_synth, ctx, warns };
}
const plain = (o) => JSON.parse(JSON.stringify(o));
// 05's generator, copied (PRiSM_rng(seed) = _makeRng(seed))
function rng05(seed) {
  let s = (seed | 0) || 1;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
  };
}

// A contract stub of PRiSM_dfit_lkSimulate (§3.7): the §4.21 closed form (FIX.ref.pFall) on the schedule clock. It stands in
// for WP4 until 58 lands (§2.12 rule 4).
function lkStub() {
  const R = SH.FIX.ref, REF = R.REF;
  const f = function (cfg) {
    const tp = cfg.schedule[cfg.schedule.length - 1].t, dtc = REF.dtc, tEnd = Math.max(cfg.tEnd || 72, tp + 1);
    const t = [0];
    for (let i = 1; i <= 60; i++) t.push(tp * i / 60);
    for (let d = 1 / 3600; tp + d < tEnd; d *= 1.05) t.push(tp + d);
    t.push(tEnd);
    const pw = t.map((x) => (x <= tp ? Math.min(REF.pb, REF.pStart + 6323 * 60 * x) : R.pFall(x - tp)));
    const n = t.length, z = () => new Array(n).fill(0), c = (v) => new Array(n).fill(v);
    return {
      ok: true, why: null, t, pw, pf: pw.slice(), L: c(131.2), A: c(13121), AL: c(13121), W: c(0.1), Vf: z(), Vi: c(25), VL: z(), VLw: z(), VLc: z(), VS: z(),
      qL: z(), eta: c(null), Bw: z(), Ggen: c(null),
      events: { tb: 0.0097, pb: REF.pb, ts: tp, isip: 7600, tcMech: tp + dtc, tcHyd: tp + dtc, Gc: { a05: 18, a1: 18.276, gen: 18.1 } }, xf: { ts: 131.2, tc: 131.2 },
      CLeq: 1.903e-4, dpCL: 2800, wcEq: 0, tDxfMax: 0.02, balanceErr: 0, regime: { tipShare: 0 }, validity: [], warnings: [],
    };
  };
  return f;
}

const TRUTH_KEYS = ['sigmaC', 'sigmaCHyd', 'sigmaCF2', 'isip', 'pi', 'k', 'khmu', 'L', 'mechanism', 'regimeAtEnd', 'tcInj', 'eta', 'CL', 'Gamma', 'AfCf', 'Rvis', 'xf'];
const REGIMES = ['linear', 'bilinear', 'transition', 'radial', 'spherical', 'artefact'];
const CH = ['p', 'q', 'pSurf', 'pBh', 'qFb', 'T', 'pAnn'];

module.exports = [
  {
    name: 'S1 determinism by seed (repeat, PRiSM_rng present or absent, other seed = other noise only)',
    wp: WP, opts: false,
    run(app, assert) {
      const a = bare(null, true), b = bare({ PRiSM_rng: (seed) => rng05(seed == null ? 1 : seed) });
      assert.deepStrictEqual(a.warns, [], 'synth loads (and self-tests) silently');
      const specs = a.S.cases('quick').filter((s) => ['q-tip', 'q-example-a', 'q-penny', 'q-surface-vacuum'].includes(s.id));
      specs.push(plain(a.S.cases('artefact').find((s) => s.id === 'art-tides-2')));
      specs.forEach((s) => { s.noise = { sigma: 0.3, rho1: 0.5, quantum: 0.01 }; });
      specs.forEach((s) => {
        const m1 = a.S.make(s, 7), m2 = a.S.make(s, 7), m3 = b.S.make(s, 7), m4 = a.S.make(s, 8);
        assert(m1.ok === true, s.id + ': make ok (' + (m1.code || '') + ')');
        assert.deepStrictEqual(plain(m1), plain(m2), s.id + ': same seed, same case');
        assert.deepStrictEqual(plain(m1.ds), plain(m3.ds), s.id + ': PRiSM_rng (05 stream) gives the identical record');
        assert.deepStrictEqual(plain(m1.ds.t), plain(m4.ds.t), s.id + ': the time base does not depend on the seed');
        assert.deepStrictEqual(plain(m1.truth), plain(m4.truth), s.id + ': the truth does not depend on the seed');
        assert(m1.ds.p.some((v, i) => v !== m4.ds.p[i]), s.id + ': another seed changes the noise');
        const dmax = Math.max(...m1.ds.p.map((v, i) => Math.abs(v - m4.ds.p[i])));
        assert(dmax < 3, s.id + ': the seeds differ by noise only (max ' + dmax.toFixed(3) + ' psi)');
      });
      ['reference', 'surface-gauge', 'two-cycle'].forEach((n) => assert.deepStrictEqual(plain(a.S.demo(n)), plain(b.S.demo(n)), 'demo ' + n + ' is deterministic (and the same with PRiSM_rng)'));
      // seeds outside 1 … 2^31 − 1 fall back to 1
      const s0 = specs[0];
      assert.deepStrictEqual(plain(a.S.make(s0, -5).ds), plain(a.S.make(s0, 1).ds), 'invalid seed → 1');
    },
  },
  {
    name: 'S2 the seven demos pass DfitDataset and their role-header CSV re-parses through 07 to the same arrays',
    wp: WP, opts: false,
    run(app0, assert, ctx) {
      const app = SH.sharedApp(ctx), W = app.win;
      const S = W.PRiSM_dfit_synth;
      assert(S && S.version === 'g1' && typeof S.demo === 'function', 'synth in the app (Round 9)');
      assert.deepStrictEqual(plain(S.DEMOS), ['reference', 'tight-linear', 'conventional-radial', 'contact', 'pdl', 'surface-gauge', 'two-cycle'], 'the seven demos');
      S.DEMOS.forEach((n) => {
        const ds = S.demo(n), chk = SH.checkShape('DfitDataset', ds);
        assert(chk.ok, n + ': DfitDataset ' + JSON.stringify(chk.errors.slice(0, 3)));
        assert(ds.source === 'dfit-demo' && ds.meta.demo === n && ds.t.length >= 500 && ds.t.length <= 4000, n + ': demo meta and size (' + ds.t.length + ')');
        assert(ds.q.some((v) => v > 0) && ds.q[ds.q.length - 1] === 0, n + ': injection then shut-in');
        const csv = S.demoCsv(n);
        assert(/^time_h,pressure_psia,rate_bbl_d/.test(csv), n + ': role headers');
        const re = W.PRiSM_datasetFromText(csv, { name: 'demo ' + n, source: 'dfit-demo' });
        assert(re && Array.isArray(re.t), n + ': 07 parses the CSV');
        assert.strictEqual(re.t.length, ds.t.length, n + ': row count');
        ['t', 'p', 'q'].forEach((k) => {
          const bad = ds[k].findIndex((v, i) => Math.abs(v - re[k][i]) > 1e-9 * Math.max(1, Math.abs(v)));
          assert(bad === -1, n + ': ' + k + ' re-parses identically (first difference at ' + bad + ')');
        });
        // the extra channels round-trip once 07 knows their roles (WPH); until then 07 ignores them
        ['pSurf', 'pAnn', 'T', 'qFb'].forEach((k) => {
          if (Array.isArray(ds[k]) && Array.isArray(re[k])) assert(ds[k].every((v, i) => Math.abs(v - re[k][i]) <= 1e-9 * Math.max(1, Math.abs(v))), n + ': ' + k + ' re-parses');
        });
      });
      const ref = S.demo('reference');
      assert(Array.isArray(ref.meta.hfWindows) && ref.meta.hfWindows[0].kind === 'shutin' && ref.meta.hfWindows[0].dtS === 0.02 && ref.meta.hfWindows[0].p.length === 6500,
        'reference: one 50 Hz shut-in window (−10 s … +120 s)');
      assert(ref.q.some((v) => v === 3.75 * 1440) && ref.q.some((v) => v === 1.25 * 1440), 'reference: step-down steps 3.75 / 2.5 / 1.25 bbl/min');
      const sg = S.demo('surface-gauge'), tr = S.demoTruth('surface-gauge');
      assert(sg.meta.primary === 'surface' && sg.p.every((v) => v > 0), 'surface-gauge: surface primary, positive psia');
      const iv = sg.t.findIndex((t) => t > tr.ts + 1 && sg.p[sg.t.indexOf(t)] < 1.5);
      const tv = sg.t[iv] - tr.ts;
      assert(tv > 29 && tv < 33, 'surface-gauge: vacuum reached 31 h after shut-in (' + tv.toFixed(2) + ' h)');
      assert(sg.p.slice(iv).every((v) => v < 1.5), 'surface-gauge: the reading stays on vacuum');
      const tc = S.demoTruth('two-cycle');
      assert(tc.cycle2 && tc.cycle2.reopenKnee > tc.sigmaC && tc.cycle2.tStart > tc.ts + tc.dtc, 'two-cycle: a second cycle after closure with a reopening knee above σ_c');
    },
  },
  {
    name: 'S3 each artefact injector changes only its target channel',
    wp: WP, opts: false,
    run(app, assert) {
      const { S } = bare();
      // base 1: the reference with a surface channel (positive everywhere); base 2: the under-pressured surface-gauge well whose
      // raw surface equivalent goes below zero (only the vacuum injector takes it)
      function multi(spec) {
        const m = S.make(Object.assign(spec, { primary: 'bh', artefacts: [{ kind: 'surface' }] }), 3);
        assert(m.ok, 'base case');
        const d = plain(m.ds);
        d.T = d.t.map((t) => 200 + 0.01 * t); d.pAnn = d.t.map(() => 500); d.qFb = d.t.map(() => 0); d.pBh = d.p.map((v) => v + 1);
        return { ds: d, ctx: S.ctxOf(m.truth, 5) };
      }
      const B1 = multi(S.demoSpec('reference').spec), B2 = multi(S.demoSpec('surface-gauge').spec);
      assert(SH.checkShape('DfitDataset', B1.ds).ok, 'multi-channel base passes DfitDataset ' + JSON.stringify(SH.checkShape('DfitDataset', B1.ds).errors.slice(0, 3)));
      assert(B2.ds.pSurf.some((v) => v < 0), 'base 2: the raw surface equivalent goes below zero');
      const kinds = Object.keys(S.artefacts);
      assert(kinds.length >= 19 && S.ARTEFACT_KINDS.length === 15 && S.ARTEFACT_KINDS.every((k) => kinds.includes(k)), 'injector list (15 benchmark kinds + noise, quantise, sampling, ar1)');
      kinds.forEach((k) => {
        const inj = S.artefacts[k];
        assert(Array.isArray(inj.levels) && inj.levels.length === 4, k + ': four severities');
        const Bk = k === 'vacuum' ? B2 : B1, ds = Bk.ds, ctx = Bk.ctx, n = ds.t.length;
        inj.levels.forEach((lv, j) => {
          const before = plain(ds);
          const out = S.inject(ds, Object.assign({ kind: k }, lv), ctx, 11 + j);
          assert.deepStrictEqual(plain(ds), before, k + ': pure (the input is not modified)');
          const chk = SH.checkShape('DfitDataset', out);
          assert(chk.ok, k + '[' + j + ']: output passes DfitDataset ' + JSON.stringify(chk.errors.slice(0, 2)));
          if (inj.target === 'model') { assert.deepStrictEqual(plain(out), before, k + ': a model artefact leaves the record alone (applied at generation)'); return; }
          if (inj.target === 't') {
            assert(out.t.length < n && out.t.length > 10, k + '[' + j + ']: thins or truncates the record');
            const idx = out.t.map((t) => ds.t.indexOf(t));
            assert(idx.every((i) => i >= 0), k + ': retained times are original samples');
            CH.forEach((c) => { if (Array.isArray(ds[c])) assert(idx.every((i, r) => out[c][r] === ds[c][i]), k + ': ' + c + ' unchanged on retained rows'); });
            return;
          }
          CH.concat(['t']).forEach((c) => {
            if (!Array.isArray(ds[c])) return;
            const same = JSON.stringify(out[c]) === JSON.stringify(ds[c]);
            if (c === inj.target) assert(!same, k + '[' + j + ']: changes its target ' + c);
            else assert(same, k + '[' + j + ']: leaves ' + c + ' unchanged');
          });
        });
      });
      // seeded: the same seed gives the same injection, another seed another one (stochastic injectors)
      const ds = B1.ds, ctx = B1.ctx;
      ['white', 'ar1', 'tides'].forEach((k) => {
        const a1 = S.inject(ds, { kind: k }, ctx, 5), a2 = S.inject(ds, { kind: k }, ctx, 5), a3 = S.inject(ds, { kind: k }, ctx, 6);
        assert.deepStrictEqual(plain(a1.p), plain(a2.p), k + ': same seed'); assert.notDeepStrictEqual(plain(a1.p), plain(a3.p), k + ': other seed');
      });
      assert(S.inject(ds, { kind: 'nope' }, ctx, 1).ok === false, 'unknown kind → failure form');
    },
  },
  {
    name: 'S4 truth fields complete for every source (incl. A_f·c_f, R_vis, xf, σ_c,F2); lk through a contract stub; case lists',
    wp: WP, opts: false,
    run(app, assert) {
      const plainS = bare().S;
      const stub = lkStub();
      const st = stub(plainS.cases('quick')[0].lk);
      assert(SH.checkShape('LkResult', st).ok && st.ok === true, 'the lkSimulate stub honours LkResult (§3.7)');
      const withLk = bare({ PRiSM_dfit_lkSimulate: stub }).S;
      const nolk = plainS.make(plainS.cases('integration')[0], 1);
      assert(nolk.ok === false && nolk.code === 'LK_UNAVAILABLE' && SH.checkShape('Failure', nolk).ok, "without 58 an 'lk' case is LK_UNAVAILABLE (failure form)");
      const items = [];
      plainS.DEMOS.forEach((d) => items.push(['demo ' + d, plainS.demoTruth(d)]));
      withLk.cases('quick').forEach((s) => { const m = withLk.make(s, 3); if (m.ok) items.push([s.id, m.truth, m]); else assert(m.code === 'GAS_PVT_UNAVAILABLE' && s.aca && s.aca.fluid === 'gas', s.id + ': make ok (' + m.code + ')'); });
      withLk.cases('integration').forEach((s) => { const m = withLk.make(s, 3); assert(m.ok, s.id + ' (integration) ok'); items.push([s.id, m.truth, m]); });
      assert(items.length >= 7 + 11 + 3, 'cases covered: ' + items.length);
      items.forEach(([id, t, m]) => {
        TRUTH_KEYS.forEach((k) => assert(Object.prototype.hasOwnProperty.call(t, k), id + ': truth.' + k + ' present'));
        ['sigmaC', 'sigmaCHyd', 'sigmaCF2', 'isip', 'pi', 'k', 'khmu', 'L', 'tcInj', 'eta', 'CL', 'Gamma', 'AfCf', 'Rvis', 'xf'].forEach((k) =>
          assert(typeof t[k] === 'number' && isFinite(t[k]), id + ': truth.' + k + ' finite (' + t[k] + ')'));
        assert(t.AfCf > 0 && t.Rvis > 0 && t.Rvis < 1 && t.xf > 0 && t.eta > 0 && t.eta < 1, id + ': A_f·c_f, R_vis, xf, η in range');
        assert(t.pi < t.sigmaCF2 && t.sigmaCF2 <= t.sigmaC && t.sigmaCHyd <= t.sigmaC && t.sigmaC < t.isip, id + ': p_i < σ_c,F2 ≤ σ_c < ISIP');
        assert(t.regimeAtEnd === null ? withLk.classOf(t.mechanism) === 'hr-contact' && t.source === 'gdomain' : REGIMES.includes(t.regimeAtEnd), id + ': regimeAtEnd ' + t.regimeAtEnd);
        assert(withLk.classOf(t.mechanism) !== 'undetermined', id + ': mechanism ' + t.mechanism + ' maps to a class');
        if (m) assert(SH.checkShape('CaseSpec', m.caseSpec).ok && SH.checkShape('DfitDataset', m.ds).ok, id + ': CaseSpec and DfitDataset');
      });
      // the reference demo reproduces the §4.21 chain (V_i* = 25 bbl convention)
      const r = plainS.demoTruth('reference');
      const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b);
      near(r.isip, 7600, 1e-9, 'ISIP'); near(r.sigmaC, 7000, 1e-9, 'σ_c'); near(r.eta, 0.9, 1e-6, 'η_G'); near(r.ViStar, 25, 0.01, 'V_i*');
      near(r.Csys * 5.614583, 0.2105, 0.0005, 'C_sys ft³/psi'); near(r.AfCf * 5.614583, 0.2061, 0.0002, 'A_f·c_f ft³/psi'); near(r.Rvis, 0.979, 0.001, 'R_vis');
      near(r.xf, 131.2, 0.2, 'xf PKN'); near(r.pi, 4500, 1e-9, 'p_i');
      // contact truth: F2 point below the onset, hydraulic between
      const c = plainS.demoTruth('contact');
      assert(c.sigmaCF2 < c.sigmaCHyd && c.sigmaCHyd < c.sigmaC && c.sigmaC - c.sigmaCF2 > 200, 'contact: σ_c,F2 < σ_c,hyd < σ_c (onset)');
      // case lists
      const counts = { integration: 3, quick: 12, artefact: 60, benchmark: 900 };
      Object.keys(counts).forEach((k) => {
        const cs = plainS.cases(k);
        assert.strictEqual(cs.length, counts[k], 'cases(' + k + ') = ' + counts[k]);
        const bad = cs.filter((s) => !SH.checkShape('CaseSpec', s).ok);
        assert(bad.length === 0, k + ': every CaseSpec passes (' + (bad[0] && JSON.stringify(SH.checkShape('CaseSpec', bad[0]).errors.slice(0, 2))) + ')');
        assert(new Set(cs.map((s) => s.id)).size === cs.length, k + ': unique ids');
      });
      assert.deepStrictEqual(plain(plainS.cases('integration').map((s) => s.source)), ['lk', 'lk', 'aca-exact'], 'integration = reference, contact, example B');
      assert(plainS.cases('nope').ok === false, 'unknown kind → failure form');
      // score() on a perfect synthetic run and on a failure
      const tr = plainS.demoTruth('tight-linear');
      const fake = { ok: true, consensus: { mode: 'single', value: tr.sigmaC + 5, range: null, confidence: 'high', families: { F1: { p10: tr.sigmaC - 10, p50: tr.sigmaC, p90: tr.sigmaC + 10 } } },
        isip: { value: tr.isip - 2 }, classification: { type: 'normal', alt: [] },
        aca: { ok: true, regimeSummary: 'linear', pi: { value: 4500.3, lo: 4490, hi: 4510, label: 'medium' }, bounds: { kLo: 0.004, kHi: 0.013 }, kh: null },
        frac: { chosen: { AfCf: tr.AfCf * 1.01, Rvis: tr.Rvis, geometry: { model: 'PKN', byModel: { PKN: { xf: tr.xf * 0.99 } } } } } };
      const sc = plainS.score(fake, tr);
      assert(sc.closure.right && sc.isip.right && sc.classify.right && sc.pi.right && sc.k.right && sc.regime.right && Math.abs(sc.frac.AfCf - 0.01) < 1e-9, 'score: a right run scores right ' + JSON.stringify(sc));
      fake.consensus = { mode: 'range', value: null, range: { lo: tr.sigmaC - 300, hi: tr.sigmaC + 10, medians: { low: tr.sigmaC - 290, high: tr.sigmaC } }, confidence: 'medium' };
      const sr = plainS.score(fake, tr);
      assert(sr.closure.partial === true && sr.closure.right === false && Math.abs(sr.closure.intervalScore - 310) < 1e-9, 'score: a range on a normal truth is partial with its interval score');
      const sf = plainS.score({ ok: false, code: 'X' }, tr);
      assert(sf.ok === false && sf.closure.right === false, 'score: a failed run scores nothing');
      // 'none' closure (§8.3): wrong on a record that closed long before its end, right when the record stops before closure
      const none = { ok: true, consensus: { mode: 'none', value: null, range: null, confidence: 'low' } };
      assert(r.dtc < r.dtEnd, 'reference demo closes inside its record (Δt_c ' + r.dtc + ' h, end ' + r.dtEnd + ' h)');
      const sn = plainS.score(none, r);
      assert(sn.closure.right === false && sn.closure.partial === false, "score: 'none' on the reference truth (closed at 5.7 h of 80 h) is wrong");
      const es = plain(plainS.demoSpec('reference').spec);
      es.tEndFactor = 0.5; es.artefacts = []; es.hf = null;
      const me = plainS.make(es, 3);
      assert(me.ok && me.truth.dtEnd < me.truth.dtc, 'early-stop case (factor 0.5) stops before closure');
      assert(plainS.score(none, me.truth).closure.right === true, "score: 'none' on an early-stop case is right");
      // a record that ends within 0.3 G-decade after closure still scores 'none' right; one 1 G-decade after does not
      const gdec = (dt) => Math.log10(plainS.G(dt / r.tp, 0.5));
      const nearT = Object.assign({}, r, { dtEnd: r.dtc * 1.2 }), farT = Object.assign({}, r, { dtEnd: r.dtc * 200 });
      assert(gdec(nearT.dtEnd) - gdec(r.dtc) <= 0.3 && plainS.score(none, nearT).closure.right === true, "score: 'none' just after closure (≤ 0.3 G-decade) is right");
      assert(gdec(farT.dtEnd) - gdec(r.dtc) > 0.3 && plainS.score(none, farT).closure.right === false, "score: 'none' well after closure is wrong");
      // the reference demo's tp is the full pump time (step-down included) and is stated in its meta
      const rds = plainS.demo('reference');
      assert(r.tp * 60 > 5.0 && typeof rds.meta.note === 'string' && /tp = [0-9.]+ min/.test(rds.meta.note) && Math.abs(rds.meta.tpMin - r.tp * 60) < 1e-3, 'reference demo: tp stated in meta (' + rds.meta.note + ')');
      // storage stratum ≠ matrix stratum (LkConfig and wellbore), storage-dominated at every level
      const bench = plainS.cases('benchmark');
      [0, 1, 2].forEach((iv) => {
        const st = bench.find((s) => s.id === 'pre-storage-r' + iv + '-n0-s1.5-1'), mx = bench.find((s) => s.id === 'pre-matrix-r' + iv + '-n0-s1.5-1');
        assert(st && mx, 'storage / matrix cells r' + iv);
        assert(JSON.stringify(st.lk) !== JSON.stringify(mx.lk), 'r' + iv + ': storage LkConfig differs from matrix');
        assert(JSON.stringify(st.wellbore) !== JSON.stringify(mx.wellbore), 'r' + iv + ': storage wellbore differs from matrix');
        const AfCfRef = 0.2061 / 5.614583, rv = AfCfRef / (AfCfRef + st.wellbore.VwCw);
        assert(rv < 0.3 && (st.wellbore.cwOfP === 'gas' || st.wellbore.cwOfP === 'air'), 'r' + iv + ': storage-dominated (R_vis ' + rv.toFixed(3) + ', ' + st.wellbore.cwOfP + ')');
      });
      // storage truth only when storage-dominated (§4.11): I14's R_vis ≈ 0.54 case carries the underlying mechanism
      const qs = withLk.make(withLk.cases('quick').find((s) => s.id === 'q-storage-gas'), 3);
      assert(qs.ok && (qs.truth.Rvis < 0.3 ? qs.truth.mechanism === 'storage' : qs.truth.mechanism === 'normal') && qs.truth.mechanismSpec === 'storage',
        'q-storage-gas: truth mechanism ' + qs.truth.mechanism + ' at R_vis ' + qs.truth.Rvis);
      const bs = bench.find((s) => s.id === 'pre-storage-r1-n0-s1.5-1'), mb = withLk.make(bs, 3);
      assert(mb.ok && mb.truth.mechanism === 'storage' && mb.truth.Rvis < 0.3, 'benchmark storage cell: truth storage at R_vis ' + (mb.truth && mb.truth.Rvis));
      // regime truth in the regimeSummary vocabulary (+ 'transition'); no bilinear for the uniform-flux / box / penny kernels
      const acaTr = bench.filter((s) => s.source === 'aca-exact' && !(s.aca && s.aca.fluid === 'gas')).map((s) => plainS.make(s, 1)).filter((m) => m.ok).map((m) => m.truth.regimeAtEnd);
      assert(acaTr.length >= 50 && acaTr.every((x) => x === null || ['linear', 'transition', 'radial', 'spherical', 'artefact'].includes(x)), 'after-closure truths: ' + JSON.stringify([...new Set(acaTr)]));
      assert(plainS.regimeFromSD(-0.75) === 'transition' && plainS.regimeFromSD(-0.75, 'full') === 'transition' && plainS.regimeFromSD(-0.75, 'finite-conductivity') === 'bilinear', 'the −0.75 band is bilinear only for a finite-conductivity kernel');
      const rg = (rs, t) => plainS.score({ ok: true, aca: { ok: true, regimeSummary: rs, pi: null, bounds: null } }, Object.assign({}, tr, t)).regime;
      assert(rg('linear-radial', { regimeAtEnd: 'radial' }).right, "'linear-radial' is right for a radial truth");
      assert(!rg('linear-radial', { regimeAtEnd: 'transition', sDEnd: -0.6 }).right && rg('linear-radial', { regimeAtEnd: 'transition', sDEnd: -0.6 }).partial, 'transition truth before s_D −0.90: linear-radial partial only');
      assert(rg('linear-radial', { regimeAtEnd: 'transition', sDEnd: -0.92 }).right, 'transition truth past s_D −0.90: linear-radial right');
      assert(rg('linear', { regimeAtEnd: 'transition', sDEnd: -0.6 }).partial && !rg('radial', { regimeAtEnd: 'transition', sDEnd: -0.6 }).partial, 'transition: linear partial, radial not');
      assert(rg('linear-radial', { regimeAtEnd: 'linear' }).partial && rg('spherical', { regimeAtEnd: 'radial' }).partial, 'adjacent regimes are partial');
      assert(rg('radial', { regimeAtEnd: 'artefact' }).scored === false, "an 'artefact' truth is not scored");
      // p_i widths: named constants (§4.12 high / medium; low fixed); k point estimate with no interval is partial only
      assert(plainS.PI_WIDTH.highPsi === 10 && plainS.PI_WIDTH.mediumPsi === 50 && plainS.PI_WIDTH.lowPsi > 0, 'p_i label widths');
      const piS = (v, lb) => plainS.score({ ok: true, aca: { ok: true, pi: { value: v, lo: 4000, hi: 5000, label: lb } } }, tr).pi;
      assert(!piS(4800, 'low').right && piS(4800, 'low').partial && piS(4550, 'low').right, "p_i 'low': right only within the fixed width, inside the bracket partial");
      const kS = (k) => plainS.score({ ok: true, aca: { ok: true, nolte: { lin: { k } } } }, tr).k;
      assert(!kS(tr.k * 1.05).right && kS(tr.k * 1.05).partial && !kS(tr.k * 3).partial, 'k point with no interval: partial within × 2 only');
    },
  },
  {
    name: 'S5 aca-exact reproduces the example A / B tables (Δp and D) within 0.1 %; 57 acaDiag agreement when implemented',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const { S } = bare();
      // example B: the frozen diagnosis columns of FIX.aca (x = t_inj − t_c/3; D = |dp/d ln x|; p = piHi + D)
      const B = SH.FIX.aca, x = B.diag.x, t = x.map((v) => v + B.t0);
      const rb = S.acaExact(S.EXAMPLE_B, t);
      assert(rb.ok === true && Math.abs(rb.t0 - B.t0) < 1e-6, 'example B runs, centroid origin t_c/3');
      x.forEach((xv, i) => {
        assert(Math.abs(rb.D[i] / B.diag.D[i] - 1) <= 1e-3, 'B: D at t ' + t[i].toFixed(3) + ' h: ' + rb.D[i] + ' vs ' + B.diag.D[i]);
        if (B.diag.piHi[i] != null) {
          const dpT = B.diag.piHi[i] + B.diag.D[i] - 4500;
          assert(Math.abs(rb.dp[i] / dpT - 1) <= 1e-3, 'B: Δp at t ' + t[i].toFixed(3) + ' h: ' + rb.dp[i] + ' vs ' + dpT);
        }
        if (B.diag.sD[i] != null && i > 0) assert(Math.abs(rb.sD[i] - B.diag.sD[i]) <= 0.01, 'B: s_D at ' + t[i].toFixed(2) + ' h');
      });
      // example A (§2.6 table of the research note; D = t·|p′| on the total clock)
      const TA = [[0.75, 367.249, 277.408], [2, 184.951, 136.100], [10, 47.293, 43.981], [20, 24.503, 23.618], [50, 10.018, 9.870], [100, 5.046, 5.009], [300, 1.690, 1.686]];
      const ra = S.acaExact(S.EXAMPLE_A, TA.map((r) => r[0]), { t0: 0 });
      TA.forEach((r, i) => {
        const tolD = Math.max(1e-3, 0.0005 / r[2]), tolP = Math.max(1e-3, 0.0005 / r[1]);   // 0.1 % or the table's rounding
        assert(Math.abs(ra.dp[i] / r[1] - 1) <= tolP, 'A: Δp at ' + r[0] + ' h: ' + ra.dp[i] + ' vs ' + r[1]);
        assert(Math.abs(ra.D[i] / r[2] - 1) <= tolD, 'A: D at ' + r[0] + ' h: ' + ra.D[i] + ' vs ' + r[2]);
      });
      // radial impulse identity: late Δp·t → 1,694.5·V·μ/(kh) (example A, t ≫ t_c)
      const late = S.acaExact(S.EXAMPLE_A, [3000], { t0: 0.5 / 3 });
      const khmu = 1694.5 * 15 / (late.dp[0] * (3000 - 0.5 / 3));
      assert(Math.abs(khmu / 50 - 1) < 0.005, 'A: late radial kh/μ ' + khmu.toFixed(3) + ' ≈ 50');
      // penny / box kernels: late spherical slope (s_D → −1.5) and the full-height kernel's early identity with box
      const pn = { k: 0.1, L: 60, h: 400, phi: 0.1, ct: 1e-5, mu: 0.6, V: 20, tcInj: 1, pi: 4500 };
      const rp = S.acaExact(pn, [3000], { geometry: 'penny' });
      assert(Math.abs(rp.sD[0] + 1.5) < 0.05, 'penny: spherical slope late (' + rp.sD[0] + ')');
      const kb = S.kernel('box', Object.assign({}, pn, { hf: 40, h: 40 })), kf = S.kernel('full', Object.assign({}, pn, { h: 40 }));
      assert(Math.abs(kb(1e-6) / kf(1e-6) - 1) < 1e-6, 'box = full height at early time');
      assert(S.acaExact({ k: 1 }, [1]).ok === false, 'missing inputs → failure form');
      // 57 (WP3): its p_i-free derivative on the exact example-B record agrees with the exact D
      let W = null;
      try { W = SH.sharedApp(ctx).win; } catch (e) { W = null; }
      const diagFn = W && W.PRiSM_dfit_acaDiag;
      if (typeof diagFn !== 'function' || diagFn._dfitStub) {
        console.log('  [DF5] S5: PRiSM_dfit_acaDiag (57, WP3) is not implemented yet — the 57 agreement check is skipped');
        return;
      }
      const tt = [], pp = [];
      for (let lt = Math.log(2.2); lt <= Math.log(300); lt += Math.LN10 / 60) tt.push(Math.exp(lt));
      const ex = S.acaExact(S.EXAMPLE_B, tt);
      ex.dp.forEach((d) => pp.push(4500 + d));
      const dg = diagFn(tt, pp, { t0: 2 / 3, LB: 0.25, sigma: 0.01 });
      assert(dg && Array.isArray(dg.x) && dg.x.length > 10, '57 acaDiag returns a diagnosis');
      let n = 0;
      dg.x.forEach((xv, i) => {
        if (!(dg.D[i] > 0) || xv < 5 || xv > 200) return;
        const r = S.acaExact(S.EXAMPLE_B, [xv + 2 / 3]);
        assert(Math.abs(dg.D[i] / r.D[0] - 1) <= 0.03, '57 D at x ' + xv.toFixed(2) + ' h agrees with the exact D within 3 %');
        n++;
      });
      assert(n >= 10, '57 agreement checked on ' + n + ' points');
    },
  },
  {
    name: 'S6 no Math.random in any DFIT source file',
    wp: WP, opts: false,
    run(app, assert) {
      const files = fs.readdirSync(BUILD).filter((f) => /^(5[6-9]-prism-dfit-[a-z0-9-]+|4[89]-calc-(dfit-[a-z0-9-]+|wellbore(-[a-z0-9]+)?))\.js$/.test(f)).concat(fs.existsSync(path.join(BUILD, 'dfit-validate.js')) ? ['dfit-validate.js'] : []);
      ['56-prism-dfit-core.js', '57-prism-dfit-aca.js', '58-prism-dfit-leakoff.js', '59-prism-dfit-ui.js', SYNTH, '49-calc-dfit-cal.js', '49-calc-dfit-triage.js', '48-calc-wellbore.js']
        .forEach((f) => assert(files.includes(f), 'scanned: ' + f));
      files.forEach((f) => {
        const src = fs.readFileSync(path.join(BUILD, f), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        assert(!/Math\s*\.\s*random|Math\s*\[\s*['"]random['"]\s*\]/.test(src), f + ' uses no Math.random');
      });
      assert(strip(fs.readFileSync(path.join(BUILD, SYNTH), 'utf8'), SYNTH).indexOf('=== SELF-TEST ===') === -1, 'the synth self-test is stripped by concat');
    },
  },
  {
    name: 'S7 with the real 58: the lk truth R_vis is storage-consistent through lkVwcwAt, and the storage label follows it',
    wp: WP, opts: false,
    run(_app, assert, ctx) {
      // integration (lead, after WP4 landed): the truth's V_w·c_w is read through S.lkVwcwAt from the real LkResult, and
      // R_vis = A_f·c_f / (A_f·c_f + V_w·c_w(σ_c)); 'storage' only when R_vis < 0.3 (§4.11 / R5)
      const W = SH.sharedApp(ctx).win, S = W.PRiSM_dfit_synth;
      if (typeof W.PRiSM_dfit_lkSimulate !== 'function' || W.PRiSM_dfit_lkSimulate._dfitStub) { console.log('  [DF5] S7: 58 not merged — skipped'); return; }
      ['q-storage-gas'].concat(S.cases('integration').map((c) => c.id)).forEach((id) => {
        const cs = S.cases('quick').concat(S.cases('integration')).find((c) => c.id === id);
        if (!cs || cs.source !== 'lk') return;
        const m = S.make(cs, 3);
        assert(m.ok === true && m.truth.source === 'lk', id + ': lk case made with the real 58');
        const vw = S.lkVwcwAt(m.lkRes || {}, cs.wellbore, m.truth.sigmaC);
        assert(Math.abs(m.truth.VwCw - vw) <= 1e-12 * Math.max(1, vw), id + ': truth V_w·c_w = lkVwcwAt at σ_c');
        const rv = m.truth.AfCf / (m.truth.AfCf + vw);
        assert(Math.abs(m.truth.Rvis - rv) <= 1e-9, id + ': R_vis ' + m.truth.Rvis + ' = A_f·c_f/(A_f·c_f + V_w·c_w) ' + rv);
        if (cs.mechanism === 'storage') assert(m.truth.mechanism === (rv < 0.3 ? 'storage' : 'normal'), id + ': storage label follows R_vis ' + rv.toFixed(3));
      });
    },
  },
];
