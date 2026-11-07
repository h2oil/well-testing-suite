// DFIT — WP2 closure consensus (docs/DFIT-PLAN.md §4.7, §4.8, §6.2 "Tests", §9 WP2 "dfit-closure").
//
// Test signals are built with PRiSM_dfit_vcModel (the G-domain forward model) on the §4.21 reference well: ISIP 7,600 psia,
// m_G = 600/18 psi per unit G (closure at G 18 for normal leak-off), p_r 4,500 psia, A_f·c_f 0.2061 and V_w·c_w 4.44e-3 ft³/psi,
// 5 bbl/min for 5 min (V_i* taken as 25 bbl, the §4.21 convention). The falloff is sampled 120 per decade from 1 s to 24 h
// (noise-free, 0.001 psi resolution) unless a test says otherwise. Reopening ramps are Ramp-shaped objects built from the
// §4.15b hinge numbers (WTS_wellbore.ramp is WP1's; the consensus only reads knee, nwbCorr and band).
//
//   C1  toy contact (exp aperture law, f_res 0.10, s_c 100): F1 6,998 ± 5, F2 6,507 ± 10, √t same evidence as the tangent,
//       mode range [P10(F2), P90(F1)] with both medians, χ(F2) ≈ 1.44, label medium
//   C2  pure Carter normal leak-off: s ≤ τ → single, label high
//   C3  PDL hump: the tangent excludes the hump (pick after G_fo); F0 = p_fo within 15 psi
//   C4  low visibility (gas-filled wellbore, storage-consistent R_vis 0.54): label medium or low, the R_vis rule fired
//   C5  closure not reached → mode none, not estimable, forecast shown
//   C6  frictional check: below the μ 1.0 bound (p_p at the lower bracket edge, S_v 0.9 psi/ft) vetoed and excluded;
//       between the μ 1.0 and μ 0.6 bounds kept with a warning
//   C7  the counterfactual names the largest-effect knob from the stability samples, with no extra refits
//   C8  determinism: the same seed gives identical bands; the synchronous consensus equals the Job
//   C9  the stability grid makes exactly (54 + 50) × 7 closed-form evaluations with varcomp present (no varcomp refit)
//   C10 a user closure in picks replaces the consensus in frac and the what-if table and is marked source 'user'
//   C11 on contact data the log-log pick is sameEvidenceAs 'compliance' and coincides with it within one window L
//   C12 label arithmetic: τ at pn 100 / σ_c 7,000 is 21 psi (not 3); ISIP spreads 8 / 12 / 30 psi are high / medium / low; a
//       family band with P90 = P10 gets σ_f = max(1 psi, 2σ_gauge)
//   C13 a near-wellbore-corrected F4 within τ of F1 keeps the mode single; an uncorrected F4 bound below the single value
//       turns it into a range
'use strict';

const S = require('./_dfit-shapes');

const WP = 'DF2';
const BBL = 5.614583;
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');
const okShape = (assert, name, obj, what) => { const r = S.checkShape(name, obj); assert(r.ok, (what || name) + ' shape: ' + JSON.stringify(r.errors.slice(0, 4))); };
function app(ctx) { const a = S.sharedApp(ctx); S.resetDfit(a); return a.win; }

const AfCf = 0.2061 / BBL, VwCw = 4.44e-3 / BBL;
const BASE = { isip: 7600, sigmaC: 7000, law: 'none', sc: 100, fres: 0.1, sr: null, pr: 4500, AfCf, VwCw, K: (600 / 18) * (AfCf + VwCw) };
const TOY = Object.assign({}, BASE, { law: 'exp', sc: 100, fres: 0.1 });
const WELL = { pi: 4500, mu: 0.5, phi: 0.06, ct: 1e-5 };
function inputs(over) {
  const I = S.FIX.state.tests[0].inputs;
  if (over) Object.keys(over).forEach((k) => { if (typeof over[k] === 'object' && over[k] && !Array.isArray(over[k])) I[k] = Object.assign({}, I[k], over[k]); else I[k] = over[k]; });
  return I;
}
// a DFIT record from a G-domain model: 10 static samples, 5 bbl/min for 5 min, falloff log-spaced to tEnd
function synth(G, P, o) {
  o = o || {};
  const tp = 5 / 60, tS = 2 / 60, ts = tS + tp, per = o.perDecade || 120, tEnd = o.tEnd || 24;
  const t = [], p = [], q = [];
  for (let i = 0; i < 10; i++) { t.push(i * 12 / 3600); p.push(4500); q.push(0); }
  for (let i = 1; i <= 120; i++) { const tt = tS + i * 2.5 / 3600; t.push(tt); p.push(Math.min(4500 + 6323 * (tt - tS) * 60, 7950)); q.push(7200); }
  const dts = []; for (let k = 0; ; k++) { const dt = (1 / 3600) * Math.pow(10, k / per); if (dt > tEnd) break; dts.push(dt); }
  const pf = G.PRiSM_dfit_vcModel(dts.map((dt) => G.PRiSM_dfit_G(dt / tp, 0.5)), P, { maxStep: 0.01 });
  dts.forEach((dt, k) => { t.push(ts + dt); p.push(+pf[k].toFixed(3)); q.push(0); });
  return { t, p, q, name: 'synthetic', source: 'test', timeUnit: 'h', rateUnit: 'bbl/d', meta: { psigConverted: {} } };
}
function analyse(G, P, o) {
  o = o || {};
  const I = o.inputs || inputs();
  const ds = synth(G, P, o);
  const prep = G.PRiSM_dfit_prepare(ds, I, WELL), ev = G.PRiSM_dfit_events(prep, I.events, {});
  const d = G.PRiSM_dfit_derivs(prep, ev, { alpha: 0.5, L: I.options.L });
  const pctx = Object.assign({ inputs: I, isipValue: d.isip, pr: 4500, VwCw: o.VwCw || VwCw, AfCf, well: WELL, pi: 4500 }, o.pickCtx || {});
  const picks = G.PRiSM_dfit_closurePicks(d, pctx);
  const cctx = Object.assign({ prep, events: ev, inputs: I, isip: d.isip, well: WELL, pi: 4500, VwCw: o.VwCw || VwCw, ViStar: o.ViStar || 25, seed: 1 }, o.consCtx || {});
  return { ds, prep, ev, d, picks, cctx, I, cons: o.noCons ? null : G.PRiSM_dfit_consensus(picks, d, cctx) };
}
const pick = (r, m) => r.picks.filter((x) => x.method === m)[0];

module.exports = [
  {
    name: 'C1 toy contact: F1 6,998 ± 5, F2 6,507 ± 10, √t same evidence, range [P10(F2), P90(F1)], χ(F2) ≈ 1.44, medium',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = analyse(G, TOY), c = r.cons;
      assert(c.ok === true, 'consensus ok'); okShape(assert, 'Consensus', c);
      r.picks.forEach((p, i) => okShape(assert, 'ClosurePick', p, 'picks[' + i + '] ' + p.method));
      near(assert, pick(r, 'compliance').p, 6998, 5, 'compliance pick (F1)');
      near(assert, c.families.F1.p50, 6998, 5, 'F1 median');
      near(assert, pick(r, 'tangent').p, 6507, 10, 'tangent pick (F2)');
      near(assert, c.families.F2.p50, 6507, 10, 'F2 median');
      const sq = pick(r, 'sqrt');
      assert(sq && sq.sameEvidenceAs === 'tangent' && sq.vote === false, '√t pick: same evidence as the tangent, no vote');
      assert(pick(r, 'compliance').vote === true && pick(r, 'tangent').vote === true, 'one voting member each in F1 and F2');
      assert.strictEqual(c.mode, 'range', 'mode range');
      assert(c.value === null && c.range.lowFamily === 'F2' && c.range.highFamily === 'F1', 'range ends F2 (low) and F1 (high)');
      near(assert, c.range.lo, c.families.F2.p10, 1e-6, 'range lo = P10(F2)'); near(assert, c.range.hi, c.families.F1.p90, 1e-6, 'range hi = P90(F1)');
      near(assert, c.range.medians.low, c.families.F2.p50, 1e-6, 'low median'); near(assert, c.range.medians.high, c.families.F1.p50, 1e-6, 'high median');
      const f2 = G.PRiSM_dfit_frac(c.families.F2.p50, r.d, Object.assign({}, r.cctx, { family: 'F2', method: 'tangent' }));
      const f1 = G.PRiSM_dfit_frac(c.families.F1.p50, r.d, Object.assign({}, r.cctx, { family: 'F1', method: 'compliance' }));
      assert(f1.ok !== false && f2.ok !== false, 'frac at both ends');
      near(assert, f2.chi, 1.44, 0.03, 'χ at the F2 end'); near(assert, f1.chi, 1.00, 0.01, 'χ at the F1 end');
      assert(f2.geometry.byModel.PKN.xf < f1.geometry.byModel.PKN.xf, 'the F2 end gives the shorter PKN fracture');
      assert.strictEqual(c.confidence, 'medium', 'label medium (range mode never high)');
      assert(c.bimodal === true && /F1 end is the contact/.test(G.PRiSM_dfit_consensus(r.picks, r.d, Object.assign({}, r.cctx, { classification: { type: 'hr-contact' } })).preferredWhy), 'hr-contact reading names both ends');
    },
  },
  {
    name: 'C2 pure Carter normal leak-off: s ≤ τ → single, label high',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = analyse(G, BASE), c = r.cons;
      assert(c.ok === true, 'consensus ok'); okShape(assert, 'Consensus', c);
      assert.strictEqual(c.mode, 'single', 'mode single');
      near(assert, c.value, 7000, 5, 'closure value');
      assert(c.metrics.s <= c.tau, 's ' + c.metrics.s + ' ≤ τ ' + c.tau);
      near(assert, c.tau, 21, 0.5, 'τ = max(15, 0.3 % σ_c, 3 % pn)');
      assert.strictEqual(c.confidence, 'high', 'label high; fired rules: ' + c.rules.filter((x) => x.fired).map((x) => x.id).join(','));
      assert(c.rules.length === 10 && c.rules.every((x) => /^K\d+$/.test(x.id)), 'ten K rules listed');
      assert(c.calibrated === false && c.hitRate === null && /uncalibrated/.test(c.label), 'uncalibrated rule label (3.4a)');
      const lite = G.PRiSM_dfit_consensusLite(r.picks, r.d, r.cctx);
      okShape(assert, 'ConsensusLite', lite); assert(lite.mode === 'single' && Math.abs(lite.value - c.value) < 5, 'consensusLite agrees (single)');
    },
  },
  {
    name: 'C3 PDL hump: the tangent excludes the hump (pick after G_fo); F0 = p_fo within 15 psi',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const P = Object.assign({}, BASE, { Cd: 0.004, pfo: 7350 });
      const r = analyse(G, P, { noCons: true });
      const f0 = pick(r, 'fissure'), tg = pick(r, 'tangent');
      assert(f0 && f0.family === 'F0' && f0.vote === false, 'a fissure pick in F0 (no vote)');
      near(assert, f0.p, 7350, 15, 'F0 = p_fo');
      assert(tg && tg.G > f0.G, 'tangent pick G ' + (tg && tg.G) + ' after the hump end G ' + f0.G);
      near(assert, tg.p, 7000, 15, 'tangent after the hump reads the closure');
      const cl = G.PRiSM_dfit_classify(r.d, { inputs: r.I, isip: r.d.isip, pr: 4500 });
      assert(cl.ok === true && cl.type === 'pdl', 'classified pdl (got ' + cl.type + ')');
    },
  },
  {
    name: 'C4 low visibility (gas-filled wellbore, R_vis 0.54): label medium or low with the R_vis rule fired',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const VwG = 0.1775 / BBL, Af2 = 0.2105 / BBL;                        // C_sys 0.388 ft³/psi for A_f·c_f 0.2105
      const P = Object.assign({}, BASE, { AfCf: Af2, VwCw: VwG, K: (600 / 18) * (Af2 + VwG) });
      const ViStar = (Af2 + VwG) * 600 / G.PRiSM_dfit_eta(18, 0.5);         // consistent with the closure balance
      const r = analyse(G, P, { VwCw: VwG, ViStar }), c = r.cons;
      assert(c.ok === true && c.mode === 'single', 'single closure');
      const k5 = c.rules.filter((x) => x.id === 'K5')[0];
      near(assert, k5.value, 0.54, 0.01, 'R_vis'); assert(k5.fired === true, 'the R_vis rule fired');
      assert(c.confidence === 'medium' || c.confidence === 'low', 'label ' + c.confidence);
    },
  },
  {
    name: 'C5 closure not reached → mode none, not estimable, forecast shown',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const I = inputs({ priors: { sigmaGrad: 0.7, sigmaGradSd: 0.02, piGrad: null } });
      const r = analyse(G, BASE, { tEnd: 3, inputs: I }), c = r.cons;
      assert(c.ok === true, 'consensus ok'); okShape(assert, 'Consensus', c);
      assert(!r.picks.some((p) => p.vote), 'no voting pick (dP/dG never departs)');
      assert(c.mode === 'none' && c.value === null && c.range === null && c.confidence === 'not-estimable', 'mode none, not estimable');
      assert(Array.isArray(c.forecast) && c.forecast.length === 3, 'forecast for the prior band');
      const mid = c.forecast[1];
      near(assert, mid.sigma, 7000, 1e-6, 'prior σ 0.7 psi/ft × 10,000 ft');
      near(assert, mid.dtc, S.FIX.ref.REF.dtc, 0.01, 'forecast closure time at 7,000 psia');
      const lite = G.PRiSM_dfit_consensusLite(r.picks, r.d, r.cctx);
      assert(lite.mode === 'none' && lite.value === null, 'consensusLite none');
    },
  },
  {
    name: 'C6 frictional check: below the μ 1.0 bound (lower bracket edge, S_v 0.9) vetoed and excluded; between the bounds warned',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      // veto: 12,000 ft, p_p lower edge 6,500 → σ_veto = 6,500 + (10,800 − 6,500)/5.83 = 7,238 psia > 7,000
      const Iv = inputs({ datumTvd: 12000 });
      const rv = analyse(G, BASE, { inputs: Iv, pickCtx: { piBracket: [6500, 6600], pi: 6500 }, consCtx: { piBracket: [6500, 6600], pi: 6500 } });
      const cv = pick(rv, 'compliance');
      assert(cv.admissible === false && cv.vote === false && cv.vetoes.some((v) => v.rule === 'frictional'), 'compliance pick vetoed by the frictional limit');
      near(assert, cv.vetoes.filter((v) => v.rule === 'frictional')[0].limit, 6500 + (10800 - 6500) / Math.pow(Math.SQRT2 + 1, 2), 0.2, 'veto limit');
      assert(rv.cons.families.F1 === null && rv.cons.families.F2 === null && rv.cons.mode === 'none', 'vetoed picks are excluded from the consensus');
      // warning: 10,000 ft, p_p 6,000 (C1), bracket 5,800 → veto 6,349, warning 6,000 + 4,000/3.119 = 7,282 psia
      const rw = analyse(G, BASE, { pickCtx: { piBracket: [5800, 6100], pi: 6000 }, consCtx: { piBracket: [5800, 6100], pi: 6000 } });
      const cw = pick(rw, 'compliance');
      assert(cw.admissible === true && cw.vote === true && cw.warnings.some((w) => w.rule === 'frictional'), 'compliance pick kept with a frictional warning');
      assert(rw.cons.mode === 'single', 'the warned pick stays in the consensus');
      const k10 = rw.cons.rules.filter((x) => x.id === 'K10')[0];
      assert(k10.fired === true && rw.cons.confidence !== 'high', 'K10 fired: the label is not high');
      near(assert, rw.cons.frictional.warn, 6000 + 4000 / Math.pow(Math.sqrt(1.36) + 0.6, 2), 0.2, 'warning line');
    },
  },
  {
    name: 'C7 the counterfactual names the largest-effect knob from the stability samples (no extra refits)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = analyse(G, TOY), c = r.cons;
      const cf = c.counterfactual;
      assert(cf && ['L', 'tp', 'ts', 'eps'].indexOf(cf.knob) >= 0, 'counterfactual knob ' + (cf && cf.knob));
      assert(new RegExp('largest effect: ' + cf.knob + '\\)').test(cf.text), 'the sentence names the knob: ' + cf.text);
      assert(/compliance pick moves at most \d+ psi/.test(cf.text) && /tangent band/.test(cf.text), 'computed numbers only');
      assert(cf.text.length < 300 && !/\b(null|undefined|NaN|Infinity)\b/.test(cf.text), 'plain text');
      assert.strictEqual(c.counts.refits, 0, 'no refits for the counterfactual');
      // the largest-effect knob recomputed from the same stability samples (debug hook)
      const dbg = {};
      G.PRiSM_dfit_consensus(r.picks, r.d, Object.assign({}, r.cctx, { _debug: dbg }));
      const tags = dbg.st.tags.compliance, sv = dbg.st.samples.compliance, keyOf = { L: 'L', tp: 'tp', ts: 'sh', eps: 'eps' };
      let best = null, bestE = -1;
      Object.keys(keyOf).forEach((kn) => {
        const g = {}; tags.forEach((it, k) => { if (it.kind === 'grid') (g[it[keyOf[kn]]] = g[it[keyOf[kn]]] || []).push(sv[k]); });
        const med = Object.keys(g).map((key) => { const a = g[key].slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; });
        const e = Math.max.apply(null, med) - Math.min.apply(null, med); if (e > bestE) { bestE = e; best = kn; }
      });
      assert.strictEqual(cf.knob, best, 'largest-effect knob');
    },
  },
  {
    name: 'C8 determinism: the same seed gives identical bands; the synchronous consensus equals the Job',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = analyse(G, TOY, { noCons: true });
      const a = G.PRiSM_dfit_consensus(r.picks, r.d, r.cctx), b = G.PRiSM_dfit_consensus(r.picks, r.d, r.cctx);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), 'same seed, same consensus');
      const job = G.PRiSM_dfit_consensusJob(r.picks, r.d, r.cctx);
      okShape(assert, 'Job', job);
      let st, steps = 0, lastProg = -1, mono = true;
      do { st = job.step(); steps++; if (st.progress < lastProg) mono = false; lastProg = st.progress; } while (!st.done && steps < 1000);
      assert(st.done && steps > 5 && mono, 'the Job runs in ' + steps + ' monotone steps (8 settings per unit)');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(job.result())), JSON.parse(JSON.stringify(a)), 'Job result = synchronous result');
      const c2 = G.PRiSM_dfit_consensus(r.picks, r.d, Object.assign({}, r.cctx, { seed: 7 }));
      assert(c2.ok === true && c2.families.F1.n === a.families.F1.n, 'another seed runs the same number of samples');
      const jc = G.PRiSM_dfit_consensusJob(r.picks, r.d, r.cctx); jc.step(); jc.cancel();
      assert(jc.result().ok === false && jc.result().code === 'CANCELLED' && jc.step().done === true, 'cancel ends the Job with a failure result');
    },
  },
  {
    name: 'C9 the stability grid makes exactly (54 + 50) × 7 closed-form evaluations with varcomp present (no varcomp refit)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = analyse(G, TOY), c = r.cons;
      assert(r.picks.some((p) => p.method === 'varcomp' && p.family === 'F3' && p.vote === false), 'varcomp is present (F3, no vote)');
      assert.strictEqual(JSON.stringify(c.counts), JSON.stringify({ evals: (54 + 50) * 7, refits: 0, draws: 0 }), 'evaluation count');
      assert.strictEqual(JSON.stringify(c.stability.L), '[0.05,0.1,0.2]', 'grid L'); assert.strictEqual(JSON.stringify(c.stability.tp), '["pump","breakdown","veq"]', 'grid tp');
      assert(c.stability.grid.F1.length === 3 && c.stability.grid.F1.every((row) => row.length === 3), '3 × 3 heat map per family');
      assert(c.families.F1.n === 104 && c.families.F2.n === 104, '54 settings + 50 bootstrap samples per family');
      assert(c.families.F3 !== null, 'F3 shows its own LM band');
    },
  },
  {
    name: 'C10 a user closure in picks replaces the consensus in frac and the what-if table (source user)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const r = analyse(G, TOY, { pickCtx: { user: { p: 6800, family: 'F1', reason: 'Analyst reading after a second-cycle check.' } } });
      const u = pick(r, 'user');
      assert(u && u.vote === true && u.family === 'F1' && u.source === 'user', 'user pick votes in F1 and is marked user');
      okShape(assert, 'ClosurePick', u);
      const ch = G.PRiSM_dfit_chooseClosure(r.cons, r.picks);
      assert(ch.source === 'user' && ch.p === 6800 && ch.method === 'user', 'the user closure is the chosen one');
      const wi = G.PRiSM_dfit_whatIf(G.PRiSM_dfit_whatIfCandidates(r.cons, r.picks, 6600), r.d, r.cctx);
      assert(wi[0].label === 'User closure' && wi[0].pClosure === 6800 && wi[0].method === 'user', 'what-if row 1 is the user closure');
      assert(wi.some((w) => /What-if 6,600/.test(w.label)), 'the what-if marker row');
      wi.forEach((w) => okShape(assert, 'FracOutputs', w, 'what-if ' + w.label));
      const fu = G.PRiSM_dfit_frac(ch.p, r.d, Object.assign({}, r.cctx, { family: ch.family, method: ch.method }));
      near(assert, fu.pClosure, 6800, 1e-9, 'frac at the user closure'); near(assert, fu.pn, r.d.isip - 6800, 0.01, 'pn from the user closure');
      // without a user pick the consensus range gives the preferred / upper family for hand-offs (mode 'family')
      const r2 = analyse(G, TOY);
      const ch2 = G.PRiSM_dfit_chooseClosure(r2.cons, r2.picks), chF2 = G.PRiSM_dfit_chooseClosure(r2.cons, r2.picks, 'F2');
      assert(ch2.mode === 'family' && ch2.source === 'auto' && chF2.family === 'F2' && Math.abs(chF2.p - r2.cons.families.F2.p50) < 1e-9, 'range mode: the chosen family end');
    },
  },
  {
    name: 'C11 contact data: the log-log pick is sameEvidenceAs compliance and coincides with it within one window L',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = analyse(G, TOY, { noCons: true });
      const ll = pick(r, 'loglog'), cp = pick(r, 'compliance');
      assert(ll && ll.sameEvidenceAs === 'compliance' && ll.vote === false, 'log-log: same evidence as compliance (|ι| < 0.05)');
      assert(Math.abs(Math.log(ll.dt / cp.dt)) <= r.d.L, 'within one window L in ln Δt: ' + Math.log(ll.dt / cp.dt).toFixed(4));
      assert(Math.abs(Math.log(ll.G / cp.G)) <= r.d.L, 'within one window L in ln G');
      const crel = pick(r, 'crel');
      assert(crel && crel.sameEvidenceAs === 'compliance' && crel.vote === false, 'crel is a dependent member');
      ['maxdpdg', 'sqrt'].forEach((m) => assert(pick(r, m).vote === false, m + ' never votes'));
    },
  },
  {
    name: 'C12 label arithmetic: τ 21 psi at pn 100 / σ_c 7,000; ISIP spreads 8 / 12 / 30 → high / medium / low; σ_f floor',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), I = inputs();
      near(assert, G.PRiSM_dfit_tau(7000, 100, I), 21, 1e-9, 'τ = max(15, 21, 3) = 21 psi');
      near(assert, G.PRiSM_dfit_tau(7000, 600, I), 21, 1e-9, 'reference τ = max(15, 21, 18)');
      near(assert, G.PRiSM_dfit_tau(7000, 1000, I), 30, 1e-9, 'pn 1,000 psi: τ = 30');
      const rc = (spread) => G.PRiSM_dfit_isip.reconcile([
        { method: 'g', family: 'falloff', value: 7600, se: 1, ok: true, upper: false },
        { method: 'sd', family: 'friction', value: 7600 + spread, se: 1, ok: true, upper: false }], { pn: 100 });
      assert.strictEqual(rc(8).confidence, 'high', 'spread 8 psi: high (≤ max(10, 2 % pn))');
      assert.strictEqual(rc(12).confidence, 'medium', 'spread 12 psi: medium (≤ max(25, 5 % pn))');
      assert.strictEqual(rc(30).confidence, 'low', 'spread 30 psi: low');
      // the medium threshold never falls below the high one, at any pn
      [0, 100, 600, 5000].forEach((pn) => assert(Math.max(25, 0.05 * pn) >= Math.max(10, 0.02 * pn), 'thresholds ordered at pn ' + pn));
      const st = G.PRiSM_dfit_familyStat([7000, 7000, 7000], 0.2), st2 = G.PRiSM_dfit_familyStat([7000, 7000], 0.9);
      assert(st.p10 === st.p90 && st.sigma === 1, 'P90 = P10 → σ_f = 1 psi');
      near(assert, st2.sigma, 1.8, 1e-9, 'σ_f = 2σ_gauge when larger');
    },
  },
  {
    name: 'C13 F4: a corrected reopening within τ of F1 keeps the mode single; an uncorrected F4 bound below it makes a range',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const ramp = (p, corr) => ({ ok: true, kind: 'reopening', VwCwRamp: 7.908e-4, knee: { p, V: 1.2, t: 30 }, band: { p10: p - 6, p50: p, p90: p + 6 },
        slopes: { s1: 1264.6, s2: 26.6 }, stiffRatio: 47.5, nwbCorr: corr, label: 'knee', why: null });
      S.checkShape('Ramp', ramp(7100, 99.6)).ok || assert.fail('the test ramp is Ramp-shaped');
      const r1 = analyse(G, BASE, { pickCtx: { ramps: [ramp(7101.6, 99.6)] } });
      const f4 = pick(r1, 'reopening');
      assert(f4.vote === true && f4.upperSide === true && f4.family === 'F4', 'corrected reopening votes (upper side)');
      near(assert, f4.p, 7101.6 - 99.6, 1e-6, 'knee less the near-wellbore loss Δp_nwb(0.5) = 99.6 psi');
      assert(r1.cons.mode === 'single' && r1.cons.families.F4 !== null, 'single with F4 in the mean (got ' + r1.cons.mode + ')');
      const r2 = analyse(G, BASE, { pickCtx: { ramps: [ramp(6950, null)] } });
      const u4 = pick(r2, 'reopening');
      assert(u4.vote === false && u4.upperSide === true, 'uncorrected reopening is an upper-side bound (no vote)');
      assert(r2.cons.mode === 'range' && r2.cons.range.lowFamily === 'F4', 'the bound below the single value makes a range (low end F4)');
    },
  },
];
