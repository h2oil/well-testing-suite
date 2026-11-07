// DFIT — WPT triage helper tests (docs/DFIT-PLAN.md §3.5a, §4.18, §6.3; file 49-calc-dfit-triage.js).
//
//   T1  each check fires on its artefact (one case per check, 21 checks; the clean reference passes or is not applicable)
//   T2  psig blunder found; the fix restores the true ISIP gradient through channels (dataset unchanged)
//   T3  bbl/d vs bbl/min (straps, and the ramp-implied rate without straps)
//   T4  MD used as TVD with a deviated survey
//   T5  vacuum masks the converted data after p_s < 0 (excluded window, usable window, salvage)
//   T6  a 37.4 s clock offset is recovered within 0.2 s; a 1 h offset is a blunder with its fix
//   T7  re-pump verdict: air in the well (R4, both detectors) → repump; clean → continue; overpressured (ISIP 1.05, p_i 0.75,
//       S_v 1.15 psi/ft) → not a repump; overpressured with S_v at its default (ISIP 1.10, p_i 0.75, S_v not entered) → R2 warns
//       (generic upper bound), not a repump; the same S_v marked entered by provenance → R2 fails
//   T8  thresholds in inputs.options.triage change the levels
//   T9  grade mapping A–D on four fixture combinations
//   T10 the air cross-check fails only when both detectors exceed 2 × theory
//   T11 the static hydrostatic check and the blunder bands use WTS_wellbore.hydrostatic with the column and the inputs' fluid
//       (10 ppg case passes; a stand-in that honours opts.fluid, and the real 48 when it is loaded)
//
// Artefacts are built inline from the frozen fixtures (FIX.run, FIX.ds, FIX.samples); no dependency on the generator.
// Stub (§2.12 rule 4): T2 applies the blunder fix through a test-local stand-in for PRiSM_dfit_prepare (stubPrepare below:
// psig, unit fixes, surface → datum with the plain column); 56 is not called. T11 swaps in a WTS_wellbore stand-in (column +
// hydrostatic that honours opts.fluid, else a 8.45 ppg default like 48) and restores the app's object. Pure-engine file:
// opts:false, one shared app.
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./_dfit-shapes');

const WP = 'DFT';
const SRC = path.join(__dirname, '..', '49-calc-dfit-triage.js');
const REF = S.FIX.ref.REF;
const HYD = 0.052 * REF.rhoPpg * REF.datumTvd;        // 4,383.6 psi of static column at the datum

function G(ctx) {
  const app = S.sharedApp(ctx);
  S.resetDfit(app);
  return app.win || app.window;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// the clean reference: FIX.run stages + the WP0 samples, inputs of FIX.state t1
function base() {
  const r = S.FIX.run, sm = S.FIX.samples;
  return {
    prep: clone(r.prep), events: clone(r.events),
    ctx: { isip: clone(r.isip), derivs: clone(r.derivs), hammer: clone(sm.Hammer), ramps: [clone(sm.Ramp)], stepDown: null,
           inputs: clone(S.FIX.state.tests[0].inputs), well: {}, plan: null, ds: clone(S.FIX.ds), picks: clone(r.picks),
           csys: { VwCw: REF.VwCw, waveSpeed: REF.c } },
  };
}
function falloffDt(b) { return b.prep.t.map((t) => t - b.events.ts); }
function runT(g, b) { return g.PRiSM_dfit_triage(b.prep, b.events, b.ctx); }
function chk(tr, id) { return tr.checks.filter((c) => c.id === id)[0]; }
function okTriage(assert, tr, what) {
  assert(tr && tr.ok === true, what + ': ok — ' + JSON.stringify(tr && tr.errors));
  const sh = S.checkShape('Triage', tr);
  assert(sh.ok, what + ': Triage shape — ' + JSON.stringify(sh.errors.slice(0, 5)));
  assert.strictEqual(tr.checks.length, 21, what + ': 21 checks');
}
// a smooth bottomhole temperature (warm-back after shut-in) with seeded noise
function addT(b, seed) {
  const r = S.rng(seed || 7);
  const gauss = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  b.prep.T = b.prep.t.map((t) => { const dt = t - b.events.ts; return (dt > 0 ? 196 + 4 * (1 - Math.exp(-dt / 3)) : 196) + 0.01 * gauss(); });
}
function surfaceFrom(b, shift) { b.prep.pSurf = b.prep.pw.map((p) => p - HYD + (shift || 0)); }

// T2's stand-in for PRiSM_dfit_prepare (§3.1: psig, unit fixes, surface → datum with ρ·g·TVD; the dataset is never rewritten)
function stubPrepare(ds, inputs) {
  const ch = inputs.channels, atm = ch.atmPsia;
  const f = (fix, v) => (fix ? v * fix.factor + fix.offset : v);
  const p = ds.p.map((v) => f(ch.unitFix.p, v + (ch.psig.p ? atm : 0)));
  const q = ds.q.map((v) => f(ch.unitFix.q, v / 1440));
  const surf = ch.primary === 'surface';
  const pw = surf ? p.map((v) => v + 0.052 * inputs.fluid.rhoPpg * inputs.datumTvd) : p;
  return { ok: true, t: ds.t.slice(), pw, band: null, pSurf: surf ? p : null, q, T: null, idx: ds.t.map((_, i) => i),
           src: surf ? 'surface-converted' : 'bh', sigma: 0.003, quantum: 0.01,
           applied: { atmDelta: 0, unitFix: null, clockOffsetH: ch.clockOffsetH, masked: 0 }, flags: [], hf: null };
}
function applyFix(inputs, fix) {
  const set = (o, p, v) => { const k = p.split('.'); let x = o; for (let i = 0; i < k.length - 1; i++) x = x[k[i]]; x[k[k.length - 1]] = v; };
  const out = clone(inputs);
  set(out, fix.field, clone(fix.to));
  (fix.also || []).forEach((a) => set(out, a.field, clone(a.to)));
  return out;
}

// T6: a 1 Hz record on the pressure clock; the rate logger lags by `lag` s (rate ramps 20 s up, 3 s down)
function clockCase(lag) {
  const t = [], p = [], q = [], C = REF.VwCw, t0 = 120, tb = t0 + 60, ts = 420, n = lag > 1800 ? 9000 : 2400;
  const qTrue = (s) => (s < t0 ? 0 : s < t0 + 20 ? 5 * (s - t0) / 20 : s < ts - 3 ? 5 : s < ts ? 5 * (ts - s) / 3 : 0);
  const V = (s) => { let v = 0; for (let x = 0; x < s; x += 0.05) v += qTrue(x + 0.025) * 0.05 / 60; return v; };
  for (let i = 0; i <= n; i++) {
    const s = i, vt = V(Math.min(s, tb));
    let pp;
    if (s <= tb) pp = 4500 + vt / C;
    else if (s <= ts) pp = 4500 + V(tb) / C - 150 * (1 - Math.exp(-(s - tb) / 20));
    else pp = 7400 - 300 * Math.log(1 + (s - ts) / 60);
    t.push(s / 3600); p.push(Math.round(pp * 100) / 100); q.push(qTrue(s - lag));
  }
  const prep = { ok: true, t, pw: p, band: null, pSurf: null, q, T: null, idx: t.map((_, i) => i), src: 'bh', sigma: 0.003, quantum: 0.01,
                 applied: { atmDelta: 0, unitFix: null, clockOffsetH: 0, masked: 0 }, flags: [], hf: null };
  const events = clone(S.FIX.run.events);
  Object.assign(events, { tStart: t0 / 3600, tb: tb / 3600, ts: ts / 3600, tEnd: t[t.length - 1], qLast: 5, qMax: 5 });
  return { prep, events, ctx: { inputs: clone(S.FIX.state.tests[0].inputs), well: {}, csys: { VwCw: REF.VwCw, waveSpeed: REF.c } } };
}

module.exports = [
  {
    name: 'T1 every check fires on its artefact; the clean reference passes or is not applicable',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      ['PRiSM_dfit_triage', 'PRiSM_dfit_blunders', 'PRiSM_dfit_repump', 'PRiSM_dfit_grade'].forEach((n) =>
        assert(typeof g[n] === 'function' && !g[n]._dfitStub, n + ' is implemented (not the WP0 stub)'));
      // clean reference, with and without a temperature channel
      const clean = runT(g, base());
      okTriage(assert, clean, 'clean');
      clean.checks.forEach((c) => assert(c.level === 'pass' || c.level === 'na', 'clean: ' + c.id + ' is ' + c.level + ' — ' + c.text));
      assert.strictEqual(clean.light, 'green'); assert.strictEqual(clean.verdict, 'interpretable');
      assert.strictEqual(clean.blunders.length, 0, 'clean: no blunder');
      ['units', 'clock', 'stiffness', 'air', 'isolation', 'sampling', 'shutin', 'noise', 'sink'].forEach((id) => assert.strictEqual(chk(clean, id).level, 'pass', 'clean: ' + id + ' pass'));
      const bT = base(); addT(bT);
      const cleanT = runT(g, bT);
      okTriage(assert, cleanT, 'clean + T');
      ['temperature', 'gaugeThermal', 'thermal'].forEach((id) => assert.strictEqual(chk(cleanT, id).level, 'pass', 'clean + T: ' + id + ' pass — ' + chk(cleanT, id).text));

      const cases = [];
      const add = (id, level, mod) => cases.push({ id, level, mod });
      add('units', 'fail', (b) => { b.ctx.ds.t[200] = b.ctx.ds.t[199]; });
      add('units', 'warn', (b) => {
        const keep = (a) => a.filter((_, i) => i < 520 || i >= 560);
        ['t', 'pw', 'q', 'idx'].forEach((k) => { b.prep[k] = keep(b.prep[k]); });
      });
      add('clock', 'warn', (b) => {
        const lag = 40 / 3600, e = b.events;
        b.prep.q = b.prep.t.map((t) => (t - lag >= e.tStart && t - lag <= e.ts ? 5 : 0));
      });
      add('clock', 'fail', (b) => {
        const e = b.events, lag = 40 / 3600;                       // the start lags 40 s, the stop does not
        b.prep.q = b.prep.t.map((t) => (t - lag >= e.tStart && t <= e.ts ? 5 : 0));
      });
      add('stiffness', 'fail', (b) => { b.ctx.ramps[0].VwCwRamp = 5 * REF.VwCw; });
      add('air', 'fail', (b) => { b.ctx.ramps[0].VwCwRamp = 3 * REF.VwCw; b.ctx.hammer.VwCwHammer = 3 * REF.VwCw; });
      add('surface', 'fail', (b) => { b.prep.src = 'surface-converted'; surfaceFrom(b, -580); });
      add('hydrostatic', 'fail', (b) => { surfaceFrom(b, -0.10 * HYD); });
      add('isolation', 'fail', (b) => {
        b.ctx.hammer = null;
        const dt = falloffDt(b);
        b.prep.pw = b.prep.pw.map((p, i) => (dt[i] > 0 ? 7953 - 30 * dt[i] : p));
      });
      add('sampling', 'fail', (b) => { b.ctx.hammer.sampling = { hz: 0.5, per2Lc: 2.2, ok: false }; });
      add('shutin', 'fail', (b) => { b.ctx.tCloseS = 20; });
      add('stepdown', 'fail', (b) => { b.events.steps = [{ t0: 0.10, t1: 0.105, q: 4, pSettled: 7900, n: 5, dir: 'down' }, { t0: 0.105, t1: 0.11, q: 3, pSettled: 7850, n: 5, dir: 'down' }]; });
      add('steprate', 'fail', (b) => { const sr = clone(S.FIX.samples.StepRate); sr.steps[1].stabilised = false; sr.steps[3].stabilised = false; b.ctx.stepRate = sr; });
      add('friction', 'fail', (b) => { const sd = clone(S.FIX.samples.StepDown); sd.at.dpPipe = 200; b.ctx.stepDown = sd; });
      add('bleed', 'pass', (b) => { b.ctx.bleed = { t1psi: 1e-4, t10psi: 1e-5 }; });
      add('bleed', 'fail', (b) => { b.ctx.bleed = { t1psi: 6, t10psi: 1 }; });
      add('volume', 'fail', (b) => { b.ctx.strapVolume = 20; });
      add('volume', 'pass', (b) => { b.ctx.strapVolume = 25.2; });
      add('temperature', 'fail', (b) => { b.prep.src = 'surface-converted'; surfaceFrom(b, 100); });
      add('gaugeThermal', 'fail', (b) => {
        addT(b);
        const dt = falloffDt(b);
        b.prep.T = b.prep.T.map((v, i) => v + 10 * Math.min(1, Math.max(0, (dt[i] - 2) / (5 / 60))));
      });
      add('noise', 'fail', (b) => {
        const d = b.ctx.derivs; let k = 0, best = Infinity;
        d.G.forEach((x, i) => { if (Math.abs(x - 18) < best) { best = Math.abs(x - 18); k = i; } });
        for (let i = k - 10; i <= k + 10; i++) d.GdPdG[i] *= 1 + 0.3 * ((i % 2) ? 1 : -1);
      });
      add('thermal', 'fail', (b) => {
        addT(b);
        // gauge thermal sensitivity: seeded temperature fluctuations (σ 0.5 °F) between 0.5 and 7 h carried into the
        // pressure at 4 psi/°F
        const dt = falloffDt(b), r = S.rng(11);
        const w = dt.map((x) => (x >= 0.5 && x <= 7 ? (r() - 0.5) * Math.sqrt(12) * 0.5 : 0));
        b.prep.T = b.prep.T.map((v, i) => v + w[i]);
        b.prep.pw = b.prep.pw.map((v, i) => v + 4 * w[i]);
      });
      add('sink', 'warn', (b) => { const d = b.ctx.derivs; d.D = d.dt.map((x) => 100 * x); });
      add('tides', 'fail', (b) => { b.ctx.tide = { ampPsi: 40, dpPsi: 100, removed: false }; });
      add('tides', 'pass', (b) => { b.ctx.tide = { ampPsi: 4, dpPsi: 100, removed: false }; });
      add('annulus', 'fail', (b) => {
        const e = b.events;
        b.ctx.ds.pAnn = b.ctx.ds.t.map((t) => (t >= e.tStart && t <= e.ts ? 500 + 300 * (t - e.tStart) / (e.ts - e.tStart) : (t > e.ts ? 520 : 500)));
      });
      add('annulus', 'pass', (b) => { b.ctx.ds.pAnn = b.ctx.ds.t.map(() => 500); });

      const fired = new Set();
      cases.forEach((c) => {
        const b = base(); c.mod(b);
        const tr = runT(g, b);
        okTriage(assert, tr, c.id + ' artefact');
        const k = chk(tr, c.id);
        assert.strictEqual(k.level, c.level, c.id + ' artefact: expected ' + c.level + ', got ' + k.level + ' — ' + k.text);
        assert(/^Q\d+$/.test(k.ev[0]), c.id + ': evidence id');
        if (c.level !== 'pass') fired.add(c.id);
        if (c.level === 'fail') assert(tr.light !== 'green', c.id + ': a failed check is never green');
      });
      assert.strictEqual(fired.size, 21, 'all 21 checks fired on their artefacts: ' + [...fired].join(','));
      // texts: plain, < 300 characters, no banned words (§3.0)
      assert(!/Math\.random/.test(fs.readFileSync(SRC, 'utf8')), 'no Math.random in the triage source');
      // failure forms
      [g.PRiSM_dfit_triage(), g.PRiSM_dfit_triage({ ok: true, t: [0], pw: [1] }), g.PRiSM_dfit_blunders(null), g.PRiSM_dfit_repump(null), g.PRiSM_dfit_grade(null)].forEach((f, i) => {
        assert(f && f.ok === false && /^[A-Z_]+$/.test(f.code) && S.checkShape('Failure', f).ok, 'failure form ' + i);
      });
      assert(S.checkShape('Triage', g.PRiSM_dfit_triage()).ok, 'the failure form passes the Triage shape');
    },
  },
  {
    name: 'T2 psig blunder found; the fix restores the true ISIP gradient through channels (dataset unchanged)',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const fx = S.FIX.ds, ATM = 14.696, SHIFT = 4500 - HYD - ATM;   // static surface pressure 0 psig: the well stands full
      const truePsia = fx.p.map((p) => p - SHIFT - HYD);            // true surface pressure, psia
      const ds = clone(fx);
      ds.p = truePsia.map((p) => Math.round((p - ATM) * 100) / 100); // psig numbers, not converted by 07
      const ds0 = clone(ds);
      Object.assign(ds, clone(ds));                                  // -0 → 0, as stored
      const inputs = clone(S.FIX.state.tests[0].inputs);
      inputs.channels.primary = 'surface';
      const ev = clone(S.FIX.run.events);
      const iF = ds.t.findIndex((t) => t > ev.ts);
      const trueGrad = (truePsia[iF] + HYD) / REF.datumTvd;
      const prep = stubPrepare(ds, inputs);
      const isipOf = (pr) => pr.pw[iF];
      const bl = g.PRiSM_dfit_blunders(prep, ev, { inputs, well: {}, ds });
      assert(Array.isArray(bl) && bl.length >= 1, 'a blunder is flagged: ' + JSON.stringify(bl));
      const b = bl.filter((x) => x.id === 'psig-p')[0];
      assert(b && b.fix.field === 'channels.psig.p' && b.fix.from === false && b.fix.to === true, 'psig blunder on the primary channel with its fix');
      assert(b.score > 0 && b.bf === null && b.text.length < 300, 'score, bf null (rule flags in 3.4a), plain text');
      const before = isipOf(prep) / REF.datumTvd;
      assert(Math.abs(before - trueGrad) > 1e-3, 'the blunder biases the ISIP gradient (' + before + ' vs ' + trueGrad + ')');
      const fixed = applyFix(inputs, b.fix);
      const prep2 = stubPrepare(ds, fixed);
      const after = isipOf(prep2) / REF.datumTvd;
      assert(Math.abs(after - trueGrad) < 1e-6, 'the fix restores the true ISIP gradient: ' + after + ' vs ' + trueGrad);
      assert.deepStrictEqual(ds, ds0, 'the dataset is unchanged');
      const bl2 = g.PRiSM_dfit_blunders(prep2, ev, { inputs: fixed, well: {}, ds });
      assert(!bl2.some((x) => x.id === 'psig-p'), 'no psig blunder once the flag is set');
      // the triage carries the blunder and turns amber
      const tr = g.PRiSM_dfit_triage(prep, ev, { inputs, well: {}, ds });
      okTriage(assert, tr, 'psig case');
      assert(tr.blunders.some((x) => x.id === 'psig-p') && tr.light !== 'green', 'triage lists the blunder and is not green');
      // the source unit flag alone is evidence too
      const ds3 = clone(S.FIX.ds); ds3.meta.unit = 'psig';
      const r3 = base(); r3.ctx.ds = ds3;
      assert(g.PRiSM_dfit_blunders(r3.prep, r3.events, r3.ctx).some((x) => x.id === 'psig-p'), 'meta.unit psig flags the blunder');
    },
  },
  {
    name: 'T3 bbl/d read as bbl/min (straps) and bbl/min read as bbl/d (ramp-implied rate)',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const a = base(); a.prep.q = a.prep.q.map((v) => v * 1440); a.ctx.strapVolume = 25;
      let bl = g.PRiSM_dfit_blunders(a.prep, a.events, a.ctx);
      let r = bl.filter((x) => x.id === 'rate-unit')[0];
      assert(r && Math.abs(r.fix.to.factor - 1 / 1440) < 1e-12 && r.fix.field === 'channels.unitFix.q', 'straps: factor 1/1440 — ' + JSON.stringify(bl));
      assert.strictEqual(chk(runT(g, a), 'volume').level, 'fail', 'the volume check fails too');
      const b = base(); b.prep.q = b.prep.q.map((v) => v / 1440); b.ctx.ramps = []; b.events.VwCwMeasured = 0;
      bl = g.PRiSM_dfit_blunders(b.prep, b.events, b.ctx);
      r = bl.filter((x) => x.id === 'rate-unit')[0];
      assert(r && r.fix.to.factor === 1440, 'no straps: the ramp-implied rate gives factor 1440 — ' + JSON.stringify(bl));
      const c = base(); c.ctx.strapVolume = 25;
      assert(!g.PRiSM_dfit_blunders(c.prep, c.events, c.ctx).some((x) => x.id === 'rate-unit'), 'clean: no rate blunder');
    },
  },
  {
    name: 'T4 MD used as TVD with a deviated survey',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const b = base();
      surfaceFrom(b, 0);                                   // a surface channel consistent with the true 10,000 ft TVD
      b.ctx.inputs.datumTvd = 12000; b.ctx.inputs.datumMd = null;
      b.ctx.inputs.survey = [[0, 0], [2000, 2000], [12000, 10000]];
      const tr = runT(g, b);
      okTriage(assert, tr, 'MD as TVD');
      assert.strictEqual(chk(tr, 'hydrostatic').level, 'fail', 'the static column fails at 12,000 ft');
      const m = tr.blunders.filter((x) => x.id === 'md-as-tvd')[0];
      assert(m && m.fix.field === 'datumTvd' && m.fix.from === 12000 && Math.abs(m.fix.to - 10000) < 0.5, 'fix to TVD 10,000 ft — ' + JSON.stringify(tr.blunders));
      assert(m.fix.also[0].field === 'datumMd' && m.fix.also[0].to === 12000, 'the MD moves to datumMd');
      const fixed = applyFix(b.ctx.inputs, m.fix);
      b.ctx.inputs = fixed;
      const tr2 = runT(g, b);
      assert.strictEqual(chk(tr2, 'hydrostatic').level, 'pass', 'after the fix the static column passes');
      assert(!tr2.blunders.some((x) => x.id === 'md-as-tvd'), 'no MD/TVD blunder after the fix');
      const c = base(); surfaceFrom(c, 0); c.ctx.inputs.survey = [[0, 0], [2000, 2000], [12000, 10000]]; c.ctx.inputs.datumMd = 12000;
      assert(!runT(g, c).blunders.some((x) => x.id === 'md-as-tvd'), 'a correct MD/TVD pair is not flagged');
    },
  },
  {
    name: 'T5 vacuum masks the converted data after p_s < 0',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const b = base(); b.prep.src = 'surface-converted'; surfaceFrom(b, -580); addT(b);
      const atm = b.ctx.inputs.channels.atmPsia;
      const i0 = b.prep.pSurf.findIndex((v, i) => b.prep.t[i] > b.events.ts && v - atm < 0);
      assert(i0 > 0, 'the artefact reaches vacuum');
      const tr = runT(g, b);
      okTriage(assert, tr, 'vacuum');
      const s = chk(tr, 'surface');
      assert.strictEqual(s.level, 'fail'); assert.strictEqual(s.inWindow, false, 'masked: the fail lies outside the analysed windows');
      assert.strictEqual(tr.windows.excluded.length, 1, 'one excluded window');
      const x = tr.windows.excluded[0];
      assert(Math.abs(x.t0 - b.prep.t[i0]) < 1e-12 && Math.abs(x.t1 - b.prep.t[b.prep.t.length - 1]) < 1e-12, 'excluded from the first vacuum sample to the end');
      assert.strictEqual(tr.windows.usable.length, 1);
      assert(Math.abs(tr.windows.usable[0][0] - b.events.ts) < 1e-12 && Math.abs(tr.windows.usable[0][1] - x.t0) < 1e-12, 'usable = shut-in to vacuum');
      assert.strictEqual(tr.verdict, 'partly'); assert.strictEqual(tr.light, 'amber');
      assert(tr.salvage.length >= 2 && tr.salvage.some((t) => /excluded/.test(t)) && tr.salvage.some((t) => /p_i not observable/.test(t)), 'salvage plan: ' + JSON.stringify(tr.salvage));
      assert.strictEqual(tr.grade.letter, 'C', 'a failed check outside the analysed windows → C');
    },
  },
  {
    name: 'T6 a 37.4 s clock offset is recovered within 0.2 s; a 1 h offset is a blunder with its fix',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const c = clockCase(37.4);
      const tr = g.PRiSM_dfit_triage(c.prep, c.events, c.ctx);
      okTriage(assert, tr, 'clock 37.4 s');
      const k = chk(tr, 'clock');
      assert.strictEqual(k.level, 'warn', 'offset above 1 s → warn: ' + k.text);
      assert(Math.abs(k.value - 37.4) <= 0.2, 'offset recovered: ' + k.value + ' s');
      const z = clockCase(0);
      const k0 = chk(g.PRiSM_dfit_triage(z.prep, z.events, z.ctx), 'clock');
      assert(k0.level === 'pass' && Math.abs(k0.value) <= 0.2, 'no offset → pass: ' + k0.value);
      const h = clockCase(3610);
      const bl = g.PRiSM_dfit_blunders(h.prep, h.events, h.ctx);
      const b = bl.filter((x) => x.id === 'clock-hour')[0];
      assert(b && b.fix.field === 'channels.clockOffsetH' && Math.abs(b.fix.to - (-3610 / 3600)) < 0.2 / 3600, '1 h blunder and its fix: ' + JSON.stringify(bl));
    },
  },
  {
    name: 'T7 re-pump verdict: air in the well → repump; clean → continue; overpressured → not a repump',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const air = base(); air.ctx.ramps[0].VwCwRamp = 3 * REF.VwCw; air.ctx.hammer.VwCwHammer = 2.8 * REF.VwCw;
      const ta = runT(g, air);
      okTriage(assert, ta, 'air');
      const r4 = ta.repump.rules.filter((r) => r.id === 'R4')[0];
      assert(r4 && r4.level === 'fail', 'R4 fails with both detectors');
      assert.strictEqual(ta.repump.verdict, 'repump'); assert.strictEqual(ta.repump.ack, false);
      assert.strictEqual(ta.grade.letter, 'D', 'a repump verdict grades D');
      const one = base(); one.ctx.ramps[0].VwCwRamp = 3 * REF.VwCw;     // the hammer does not confirm
      assert.strictEqual(runT(g, one).repump.rules.filter((r) => r.id === 'R4')[0].level, 'warn', 'R4 warns with one detector');
      const clean = runT(g, base());
      assert.strictEqual(clean.repump.verdict, 'continue', 'clean → continue');
      // overpressured: ISIP 1.05 psi/ft, p_i 0.75 psi/ft, S_v 1.15 psi/ft (pressures scaled, breakdown kept)
      const op = base(), f = 10500 / 7600;
      op.prep.pw = op.prep.pw.map((p) => p * f); op.events.pb *= f; op.ctx.isip.value = 10500;
      op.ctx.inputs.priors.piGrad = 0.75; op.ctx.inputs.rock.sigmaVGrad = 1.15;
      const to = runT(g, op);
      okTriage(assert, to, 'overpressured');
      assert(to.repump.verdict !== 'repump', 'overpressured is not a repump: ' + JSON.stringify(to.repump));
      assert.strictEqual(to.repump.rules.filter((r) => r.id === 'R2')[0].level, 'pass', 'R2 passes');
      // overpressured with S_v not entered (the clamp leaves its default 1.0): ISIP 1.10 psi/ft, p_i 0.75 psi/ft
      const od = base(), f2 = 11000 / 7600;
      od.prep.pw = od.prep.pw.map((p) => p * f2); od.events.pb *= f2; od.ctx.isip.value = 11000;
      od.ctx.inputs.priors.piGrad = 0.75; od.ctx.inputs.rock.sigmaVGrad = 1.0;
      const tod = runT(g, od);
      okTriage(assert, tod, 'overpressured, default S_v');
      const r2d = tod.repump.rules.filter((r) => r.id === 'R2')[0];
      assert(r2d.level === 'warn' && /generic prior/.test(r2d.text), 'R2 warns: the violated upper bound is the default S_v — ' + r2d.text);
      assert(tod.repump.verdict !== 'repump' && tod.grade.letter !== 'D', 'overpressured with default S_v is not a repump: ' + JSON.stringify(tod.repump));
      const odW = base(); odW.prep.pw = od.prep.pw.slice(); odW.events.pb = od.events.pb; odW.ctx.isip.value = 11000;
      odW.ctx.well = { pi: 7500 };                                   // p_i from the well (C1), S_v still the default
      assert(runT(g, odW).repump.verdict !== 'repump', 'well.pi + default S_v: not a repump');
      od.ctx.inputs.provenance = { 'rock.sigmaVGrad': 'user' };      // the same 1.0 psi/ft, entered
      assert.strictEqual(runT(g, od).repump.rules.filter((r) => r.id === 'R2')[0].level, 'fail', 'S_v entered (provenance user): R2 fails');
      // R2 outside the band: fail with priors, warn with generic priors only
      const lo = base(); lo.ctx.isip.value = 3000; lo.ctx.inputs.priors.piGrad = 0.45;
      assert.strictEqual(runT(g, lo).repump.rules.filter((r) => r.id === 'R2')[0].level, 'fail', 'R2 fails below the p_i gradient (priors given)');
      const gen = base(); gen.ctx.isip.value = 3000;
      assert.strictEqual(runT(g, gen).repump.rules.filter((r) => r.id === 'R2')[0].level, 'warn', 'R2 is a warning with generic priors only');
      // R7 against the designer minimum; the public function with ctx.prep
      const r7 = base(); r7.ctx.plan = { Vmin: 30 };
      const v = g.PRiSM_dfit_repump(runT(g, r7), Object.assign({ prep: r7.prep, events: r7.events }, r7.ctx));
      assert(v.verdict === 'repump' && v.rules.some((r) => r.id === 'R7' && r.level === 'fail'), 'R7 below V_min → repump');
      assert(v.rules.every((r) => r.text.length < 300), 'plain rule texts');
    },
  },
  {
    name: 'T8 thresholds passed in inputs.options.triage change the levels',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const mk = (tri) => { const b = base(); b.ctx.ramps[0].VwCwRamp = 2.5 * REF.VwCw; b.ctx.strapVolume = 24; b.ctx.inputs.options.triage = tri; return chk.bind(null, runT(g, b)); };
      let c = mk({});
      assert.strictEqual(c('stiffness').level, 'warn', 'default: ratio 2.5 warns'); assert.strictEqual(c('volume').level, 'warn', 'default: 6.3 % warns');
      c = mk({ stiffness: { warn: 3 }, volume: { warn: 0.08 } });
      assert.strictEqual(c('stiffness').level, 'pass', 'warn limit 3: pass'); assert.strictEqual(c('volume').level, 'pass', 'warn limit 8 %: pass');
      c = mk({ stiffness: { fail: 2.2 }, volume: { fail: 0.052 } });
      assert.strictEqual(c('stiffness').level, 'fail', 'fail limit 2.2: fail'); assert.strictEqual(c('volume').level, 'fail', 'fail limit 5.2 %: fail');
      c = mk({ stiffness: { warn: 'x', fail: null } });
      assert.strictEqual(c('stiffness').level, 'warn', 'non-numeric overrides are ignored');
      assert.strictEqual(c('stiffness').threshold, 2, 'the threshold reported is the one used');
      assert(Object.isFrozen(g.PRiSM_dfit_triage.defaults.stiffness) && g.PRiSM_dfit_triage.defaults.stiffness.warn === 2, 'defaults exposed and frozen');
      assert.strictEqual(g.PRiSM_dfit_triage.checkIds.length, 21, '21 check ids');
    },
  },
  {
    name: 'T9 grade mapping A–D on four fixture combinations',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const run = S.FIX.run;
      const okG = (x, letter, what) => { assert(x && x.ok !== false && x.letter === letter && Array.isArray(x.why) && x.why.length && x.why.every((w) => w.length < 300), what + ': ' + JSON.stringify(x)); };
      // A: FIX triage green, consensus single high, p_i medium
      okG(g.PRiSM_dfit_grade(run.triage, run.consensus, run.aca), 'A', 'A');
      // B: closure a range (medium)
      const rng = clone(run.consensus);
      Object.assign(rng, { mode: 'range', value: null, confidence: 'medium', range: { lo: 6495, hi: 7004, medians: { low: 6507, high: 6998 }, lowFamily: 'F1', highFamily: 'F2' } });
      assert(S.checkShape('Consensus', rng).ok, 'the range consensus is a valid Consensus');
      okG(g.PRiSM_dfit_grade(run.triage, rng, run.aca), 'B', 'B (range)');
      const lowPi = clone(run.aca); lowPi.pi.label = 'low';
      okG(g.PRiSM_dfit_grade(run.triage, run.consensus, lowPi), 'B', 'B (p_i low)');
      okG(g.PRiSM_dfit_grade(run.triage, run.consensus, lowPi, { closureOnly: true }), 'A', 'A (designed outcome closure only)');
      // C: a failed check outside the analysed windows
      const tc = clone(run.triage);
      tc.light = 'amber'; tc.verdict = 'partly';
      tc.checks.push({ id: 'sampling', title: 'Sampling vs hammer', level: 'fail', value: 2, threshold: 3, text: 'Too few samples per 2L/c.', ev: ['Q8'], inWindow: false });
      okG(g.PRiSM_dfit_grade(tc, run.consensus, run.aca), 'C', 'C (failed check outside)');
      // a failed check inside an analysed window (red light): C (B excludes it; §6.3 gives no letter, the mapping chosen is C)
      const ti = clone(run.triage);
      ti.light = 'red'; ti.verdict = 'partly';
      ti.checks.push({ id: 'hydrostatic', title: 'Static hydrostatic check', level: 'fail', value: 0.08, threshold: 0.05, text: 'Static column off by 8 %.', ev: ['Q6'], inWindow: true });
      const gi = g.PRiSM_dfit_grade(ti, run.consensus, run.aca);
      okG(gi, 'C', 'C (failed check inside a window)');
      assert(/inside an analysed window/.test(gi.why[0]), 'the reason names the failed check inside the window');
      const lowC = clone(run.consensus); lowC.confidence = 'low';
      okG(g.PRiSM_dfit_grade(run.triage, lowC, run.aca), 'C', 'C (low closure label)');
      // D: a repump verdict, or uninterpretable
      const td = clone(run.triage); td.repump.verdict = 'repump';
      okG(g.PRiSM_dfit_grade(td, run.consensus, run.aca), 'D', 'D (repump)');
      const tu = clone(run.triage); tu.verdict = 'uninterpretable';
      okG(g.PRiSM_dfit_grade(tu, run.consensus, run.aca), 'D', 'D (uninterpretable)');
      // the stale fast-pipeline consensus never grades A
      assert(g.PRiSM_dfit_grade(run.triage, run.consensusLite, run.aca).letter !== 'A', 'ConsensusLite (stale) is not A');
      // the engine triage grades the clean reference A once closure and p_i are known
      const b = base(); b.ctx.consensus = run.consensus; b.ctx.aca = run.aca;
      okG(runT(g, b).grade, 'A', 'engine triage + FIX consensus/aca');
    },
  },
  {
    name: 'T10 the air cross-check fails only when both detectors exceed 2 × theory',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const lv = (r1, r2, refl) => {
        const b = base(); b.ctx.ramps[0].VwCwRamp = r1 * REF.VwCw; b.ctx.hammer.VwCwHammer = r2 * REF.VwCw;
        if (refl) b.ctx.hammer.reflectorMatch = refl;
        return chk(runT(g, b), 'air');
      };
      assert.strictEqual(lv(2.5, 1.2).level, 'warn', 'ramp only → warn');
      assert.strictEqual(lv(1.2, 2.5).level, 'warn', 'hammer only → warn');
      assert.strictEqual(lv(2.1, 1.9).level, 'warn', 'one detector below 2 → warn');
      assert.strictEqual(lv(2.5, 2.5).level, 'fail', 'both above 2 → fail');
      assert.strictEqual(lv(1.1, 0.9).level, 'pass', 'both within 25 % → pass');
      assert.strictEqual(lv(2.5, 2.5, 'unknown').level, 'na', 'unknown reflector → not applicable');
      const b = base(); b.ctx.hammer = null;
      assert.strictEqual(chk(runT(g, b), 'air').level, 'na', 'no hammer → not applicable');
    },
  },
  {
    name: 'T11 the static hydrostatic check uses WTS_wellbore.hydrostatic with the column and the inputs\' fluid (10 ppg passes)',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const g = G(ctx);
      const real = g.WTS_wellbore;
      const realOk = real && typeof real.hydrostatic === 'function' && !real.hydrostatic._dfitStub && typeof real.column === 'function' && !real.column._dfitStub;
      // the 10 ppg case: p_s = p_w − the column of 10 ppg at the datum (before pumping)
      const mk = (dp) => {
        const b = base(); b.ctx.inputs.fluid.rhoPpg = 10;
        b.prep.pSurf = b.prep.pw.map((p) => p - dp);
        return b;
      };
      const calls = [];
      const stub = {
        column(spec) { return { ok: true, tvdAt: (md) => md, mdAt: (tvd) => tvd, segments: [], Vw: 0, warnings: [], fluid: spec.fluid, datumTvd: spec.datumTvd, datumMd: spec.datumMd }; },
        hydrostatic(pKnown, tvdKnown, tvdTarget, col, T, opts) {
          const fl = (opts && opts.fluid) || (col && col.fluid) || { rhoPpg: 8.45 };   // 48's default when no fluid reaches it
          calls.push({ pKnown, tvdKnown, tvdTarget, col, fluid: fl });
          const dp = 0.052 * fl.rhoPpg * (tvdTarget - tvdKnown);
          return { ok: true, p: pKnown + dp, rhoBar: fl.rhoPpg, dp, rangeNote: null };
        },
      };
      try {
        g.WTS_wellbore = stub;
        const b = mk(0.052 * 10 * REF.datumTvd);
        const tr = runT(g, b);
        okTriage(assert, tr, '10 ppg (stand-in)');
        const h = chk(tr, 'hydrostatic');
        assert.strictEqual(h.level, 'pass', '10 ppg static column passes: ' + h.text);
        assert(h.value < 1e-6, 'the model matches the 10 ppg column: ' + h.value);
        assert.strictEqual(tr.light, 'green', 'the light stays green on clean 10 ppg data');
        assert(!tr.blunders.length, 'no blunder on clean 10 ppg data: ' + JSON.stringify(tr.blunders));
        assert(calls.length >= 1, 'WTS_wellbore.hydrostatic is called');
        const c0 = calls[0];
        assert(c0.fluid.rhoPpg === 10 && c0.col && c0.col.ok === true && c0.col.datumTvd === REF.datumTvd, 'the column and the inputs\' fluid reach hydrostatic');
        const psStatic = b.prep.pSurf[0];
        assert(Math.abs(c0.pKnown - psStatic) < 1e-6 && c0.tvdKnown === 0 && c0.tvdTarget === REF.datumTvd, 'from the static surface pressure at 0 ft to the datum');
        // the blunder bands use the same model: a 10 ppg gauge-depth case is still found (the column matches the gauge depth)
        const gd = mk(0.052 * 10 * 9000); gd.ctx.inputs.gauge.bhTvd = 9000;
        const tg = runT(g, gd);
        assert.strictEqual(chk(tg, 'hydrostatic').level, 'fail', 'the gauge-depth column fails at the datum');
        const bl = tg.blunders.filter((x) => x.id === 'gauge-as-datum')[0];
        assert(bl && Math.abs(bl.fix.to.dpPsi - 0.052 * 10 * 1000) < 0.01, 'gauge-as-datum with the 10 ppg shift: ' + JSON.stringify(tg.blunders));
      } finally { g.WTS_wellbore = real; }
      // with the real 48 loaded (after integration): a column built from its own model at 10 ppg passes too
      if (realOk) {
        const inp = base().ctx.inputs, fl = Object.assign({}, inp.fluid, { rhoPpg: 10 });
        const col = real.column({ survey: null, strings: inp.strings, fluid: fl, temp: inp.temp, datumTvd: REF.datumTvd, datumMd: null });
        const ps0 = base().prep.pw[0] - 0.052 * 10 * REF.datumTvd;
        const dpReal = real.hydrostatic(ps0, 0, REF.datumTvd, col, null, { fluid: fl }).dp;
        const h = chk(runT(g, mk(dpReal)), 'hydrostatic');
        assert.strictEqual(h.level, 'pass', 'real WTS_wellbore, 10 ppg: ' + h.text);
      }
    },
  },
];
