// DFIT — WP1 wellbore, step-rate and ramp engine (docs/DFIT-PLAN.md §3.4, §4.1–§4.4, §4.14–§4.17, §9 WP1 "dfit-wellbore").
//
// Sources of the vectors: the research prototypes of the plan (pipe friction / hydrostatics, the step-down identifiability
// script, the step-rate synthetic with its seeded noise, the clock-alignment synthetic) are rebuilt INLINE here with the same
// seeds; the ramp and the hammer windows are generated in the test from the stated models (§4.15b, §4.4 P3b).
//
//   W1  v = 17.157 ft/s for 1 bbl/min in 1 in (+ the file loads in a bare context, no timers, no Math.random)
//   W2  perforation constant 0.2376 (first principles) and 37.6 psi for 12 × 0.40 in at 5 bbl/min, C_d 0.6
//   W3  water in 5½-in casing at 5 bbl/min: Re 140,456, 40 psi smooth / 46 psi rough per 10,000 ft
//   W4  2⅞-in tubing at 5 bbl/min: 1,020 / 1,355 psi
//   W5  power law (n′ 0.45, K′ 0.012): 66 psi laminar in casing, 1,134 psi turbulent in tubing
//   W6  n = 1 limits: Re = 926.6·ρvd/K and dp/dL = K·v/(1,497.6·d²)
//   W7  Virk asymptote f 0.00049 at Re 549,856 (friction reduction capped at ≈ 85 %)
//   W8  8.43 ppg ⇔ 1.571 wt %
//   W9  p_s for BHP 7,600: 3,220.0 / 3,173.0 / 3,181.3 / 3,260.1 psia; convert() reproduces hydrostatics, the band and vacuum masking
//   W10 displaced-column warm-back +18.3 / +33.8 / +57.4 psi for 25 / 50 / 100 bbl
//   W11 bleed-off 1 psi at 15.45 / 1.63 min (V_w·c_w 4.44e-3 ft³/psi); 17.33 / 1.83 min at 4.98e-3
//   W12 step-down reference fit: p_frac 7,595.5, a 1.528, b 140.9, n 11.9 (tortuosity dominated)
//   W13 identifiability table se (10.6, 0.414, 8.8) at σ 2 psi; a 25 % rate range is refused
//   W14 open perforations P10 / P50 / P90 8.9 / 11.7 / 16.0 (± 0.3, seeded, reproducible)
//   W15 surface tubing case: open perforations "not determinable"; p_frac and b robust
//   W16 hammer: c 4,539 ft/s, T 8.81 / 4.41 s, Joukowsky 232.1 psi; a 50 Hz window gives ISIP_wh within 1 psi, reflector within 3 %
//   W16b bleed-off + ringing window: the bleed-aware midline recovers ISIP within 5 psi, a linear midline reads ≥ 20 psi high and is
//        flagged "upper" when the bleed term is switched off
//   W17 vacuum: p_s 195.2 / 95.9 / −3.3 psia at p_i 4,500 / 4,400 / 4,300
//   W18 clock offset 37.4 s recovered within 0.2 s
//   W19 csys: c_sys 3.57e-6 1/psi, V_w·c_w 4.44e-3 ft³/psi, ramp 6,323 psi/min, and L·A/(ρc²) from the 8.81 s period = ramp ± 1 %
//   W20 step-rate vector: q* 1,805 bbl/d, FEP 6,199.3, P10–P90 6,186–6,217, b₁ 1.249, b₂ 0.037 psi/(bbl/d)
//   W21 an unstabilised step is flagged and the band is recomputed without it
//   W22 ramp knee within 10 psi (truth inside P10–P90) and s₁ within 1 %
//   W23 one-slope ramp → "no knee"; the LOT onset within 3σ of the true departure
//   W24 the near-wellbore-corrected knee shifts by 99.6 psi (+ 0.4 psi perforation) at 0.5 bbl/min
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('./_dfit-shapes');

const WP = 'DF1';
const BBL = 5.614583;
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');
const rel = (assert, a, b, f, what) => assert(typeof a === 'number' && Math.abs(a - b) <= f * Math.abs(b), what + ': ' + a + ' vs ' + b + ' (± ' + (100 * f) + ' %)');
function W(ctx) { const a = S.sharedApp(ctx); S.resetDfit(a); return a.win.WTS_wellbore; }
function shapeOk(assert, name, obj) {
  assert(obj && obj.ok === true, name + ': ok must be true (' + JSON.stringify(obj && (obj.errors || obj.code)) + ')');
  const r = S.checkShape(name, obj);
  assert(r.ok, name + ' shape: ' + r.errors.join('; '));
}
// the reference well of §4.21: 10,000 ft vertical, 5½-in 20 lb/ft casing, 8.43 ppg, geotherm 70 °F + 1.5 °F/100 ft
const REFCOL = { datumTvd: 10000, strings: [{ tubKey: null, id: 4.778, od: 5.5, wall: 0.361, topMd: 0, botMd: 10000 }],
  fluid: { kind: 'water', rhoPpg: 8.43, muCp: 1.0 }, temp: { model: 'static', surfF: 70, gradFper100: 1.5, tauLoH: 0.5, tauHiH: 5 } };
// a seeded LCG (the prototypes' generator) for the inline data
function lcg(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
function nrmOf(rnd) { return () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }; }
// reference step-down (four steps 5 → 1.25 bbl/min, p_frac 7,598, a 1.505, b 140, a −0.5 psi per step drift)
const SD_Q = [5, 3.75, 2.5, 1.25];
const sdSteps = (extra) => SD_Q.map((q, i) => ({ q, p: 7598 - 0.5 * i + 1.505 * q * q + 140 * Math.sqrt(q) + (extra ? extra(q) : 0) }));
// step-rate synthetic (matrix superposition + extension line, seeded noise 1 psi)
function stepRateData() {
  const k = 10, h = 40, mu = 0.6, B = 1.0, phi = 0.18, ct = 6e-6, rw = 0.354, pi = 4000;
  const m = 162.6 * B * mu / (k * h), C0 = Math.log10(k / (phi * mu * ct * rw * rw)) - 3.23;
  const qSteps = [300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700], dtStep = 0.5, nrm = nrmOf(lcg(99));
  const T = [], P = []; let parted = false;
  for (let n = 0; n < qSteps.length; n++) for (let j = 1; j <= 30; j++) {
    const t = n * dtStep + j / 60; let dp = 0;
    for (let i = 0; i <= n; i++) dp += m * (qSteps[i] - (i ? qSteps[i - 1] : 0)) * (Math.log10(t - i * dtStep) + C0);
    let p = pi + dp; const pe = 6150 + 0.03 * qSteps[n];
    if (p >= pe || parted) { parted = true; p = pe; }
    T.push(t); P.push(p + nrm());
  }
  return { qSteps, T, P, ends: qSteps.map((q, n) => ({ q: q / 1440, pEnd: P[(n + 1) * 30 - 1] })) };
}
// ramp generator (§4.15b vectors): V_w·c_w 7.908e-4 bbl/psi, knee 7,050 psia, A_f·c_f 0.0367 bbl/psi, σ 0.5 psi, 0.5 bbl/min
function rampData(oneSlope) {
  const VC = 7.908e-4, AfCf = 0.0367, pk = 7050, p0 = 6000, q = 0.5, nrm = nrmOf(lcg(5));
  const Vk = (pk - p0) * VC, t = [], p = [];
  for (let i = 0; i <= 600; i++) {
    const ti = i / 3600, V = q * ti * 60;
    const pi = (oneSlope || V <= Vk) ? p0 + V / VC : pk + (V - Vk) / (VC + AfCf);
    t.push(ti); p.push(pi + 0.5 * nrm());
  }
  return { t, p, q, VC, pk, Vk, tk: Vk / q / 60 };
}
// hammer window at 50 Hz after a shut-in at ts (s since shut-in → h on the record clock)
function hammerWindow(fn, ts, seed) {
  const nrm = nrmOf(lcg(seed)), t = [], p = [];
  for (let i = -100; i <= 3000; i++) { const s = i / 50; t.push(ts + s / 3600); p.push(fn(s, nrm)); }
  return { t, p };
}

module.exports = [
  {
    name: 'W1 v = 17.157 ft/s for 1 bbl/min in 1 in; the helper loads in a bare context with no timers and no Math.random',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx);
      const r = w.pipeFriction(1, { id: 1, rough: 0 }, { rhoPpg: 8.43, muCp: 1 });
      assert(r.ok, 'pipeFriction ok');
      near(assert, r.v, 17.157, 5e-4, 'velocity');
      // bare context: no document, no other engine; the self-test strips cleanly
      const src = fs.readFileSync(path.join(__dirname, '..', '48-calc-wellbore.js'), 'utf8');
      assert(!/Math\.random/.test(src), 'no Math.random in 48-calc-wellbore.js');
      assert(!/\bset(Timeout|Interval)\s*\(/.test(src), 'no timers in 48-calc-wellbore.js');
      assert(/helper module: does not add a page to window\.WTS_calcRegistry/.test(src.split('\n').slice(0, 6).join('\n')), 'helper header line');
      assert.strictEqual((src.match(/\/\/ === SELF-TEST ===/g) || []).length, 1, 'exactly one self-test marker');
      const { stripSelfTest } = require(path.join(__dirname, '..', 'concat-round8.js'));
      const warns = [];
      const c = { console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error: (...a) => warns.push(a.join(' ')) } };
      c.window = c; vm.createContext(c);
      vm.runInContext(src, c, { filename: '48-calc-wellbore.js' });            // with its self-test (local fallbacks)
      assert.deepStrictEqual(warns, [], 'self-test passes in a bare context');
      const c2 = { console: c.console }; c2.window = c2; vm.createContext(c2);
      vm.runInContext(stripSelfTest(src, '48-calc-wellbore.js', { log() {}, warn() {} }), c2);
      assert(typeof c2.WTS_wellbore.stepDown === 'function' && c2.WTS_wellbore.stepDown([]).ok === true, 'stripped copy loads; stepDown([]) answers (refused)');
      ['column', 'csys', 'tempProfile', 'hydrostatic', 'pipeFriction', 'perfFriction', 'nwbLoss', 'bleedOff', 'convert', 'vacuum', 'stepDown',
       'stepDownDesignCheck', 'stepRate', 'ramp', 'hammerQuick', 'align'].forEach((n) => {
        assert(typeof w[n] === 'function' && !w[n]._dfitStub, 'WTS_wellbore.' + n + ' implemented');
        const out = w[n]();
        assert(out === null || typeof out === 'number' || (out && typeof out === 'object'), n + '() with no input does not throw');
      });
      assert.strictEqual(w.hydrostatic().ok, false, 'a bad call returns the failure form');
      assert(S.checkShape('Failure', w.hydrostatic()).ok, 'failure shape');
    },
  },
  {
    name: 'W2 perforation constant 0.2376 (first principles) and 37.6 psi',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx);
      near(assert, w.perfConstant(), 0.2376, 5e-5, 'ρv²/2 constant');
      near(assert, w.perfFriction(5, { n: 12, dIn: 0.40, cd: 0.6 }, 8.43), 37.6, 0.05, '12 × 0.40 in, C_d 0.6, 5 bbl/min');
      near(assert, w.perfFriction(5, { n: 6, dIn: 0.40, cd: 0.6 }, 8.43), 150.5, 0.1, 'six open');
      assert.strictEqual(w.perfFriction(5, { n: null }, 8.43), null, 'no shot count → null');
      near(assert, w.nwbLoss(5, { b: 140.9, beta: 0.5 }), 315.06, 0.01, 'tortuosity at 5 bbl/min');
      near(assert, w.nwbLoss(0.05, { b: 140.9, beta: 0.5, qt: 0.1 }), 140.9 * Math.sqrt(0.1) * 0.5, 1e-9, 'linear branch below q_t');
    },
  },
  {
    name: 'W3 water in 5½-in casing at 5 bbl/min: Re 140,456, 40 psi smooth / 46 psi rough',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), fl = { rhoPpg: 8.43, muCp: 1 };
      const sm = w.pipeFriction(5, { id: 4.778, rough: 0 }, fl), rg = w.pipeFriction(5, { id: 4.778, rough: 0.0018 }, fl);
      near(assert, sm.re, 140456, 2, 'Reynolds number');
      assert.strictEqual(sm.regime, 'turbulent', 'turbulent'); assert.strictEqual(sm.model, 'newtonian', 'newtonian');
      near(assert, sm.dpdl * 1e4, 40, 0.6, 'smooth Δp over 10,000 ft');
      near(assert, rg.dpdl * 1e4, 46, 0.6, 'rough Δp over 10,000 ft');
      const col = w.column(REFCOL);
      near(assert, w.pipeDp(5, col, { rhoPpg: 8.43, muCp: 1 }).dp, rg.dpdl * 1e4, 1e-6, 'pipeDp along the column (default roughness 0.0018 in)');
    },
  },
  {
    name: 'W4 2⅞-in tubing at 5 bbl/min: 1,020 / 1,355 psi',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), fl = { rhoPpg: 8.43, muCp: 1 };
      near(assert, w.pipeFriction(5, { id: 2.441, rough: 0 }, fl).dpdl * 1e4, 1020, 2, 'smooth');
      near(assert, w.pipeFriction(5, { id: 2.441, rough: 0.0018 }, fl).dpdl * 1e4, 1355, 2, 'rough');
    },
  },
  {
    name: 'W5 power law: 66 psi laminar in casing and 1,134 psi turbulent in tubing',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), gel = { kind: 'gel', rhoPpg: 8.43, nPrime: 0.45, kPrime: 0.012 };
      const c = w.pipeFriction(5, { id: 4.778 }, gel), t = w.pipeFriction(5, { id: 2.441 }, gel);
      assert(c.model === 'powerlaw' && c.regime === 'laminar', 'casing: power law, laminar');
      near(assert, c.dpdl * 1e4, 66, 0.6, 'casing');
      assert(t.regime === 'turbulent', 'tubing turbulent');
      near(assert, t.dpdl * 1e4, 1134, 2, 'tubing (Dodge–Metzner)');
      near(assert, c.reCrit, 3470 - 1370 * 0.45, 1e-9, 'critical Reynolds number');
    },
  },
  {
    name: 'W6 n = 1 limits: 926.6 and 1/(1,497.6 d²)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), Kcp = 1.0, d = 4.778, r = w.pipeFriction(0.05, { id: d }, { rhoPpg: 8.43, nPrime: 1, kPrime: Kcp / 47880.26 });
      near(assert, r.re / (8.43 * r.v * d / Kcp), 926.6, 0.05, 'Re coefficient');
      near(assert, r.dpdl * (1497.6 * d * d) / (Kcp * r.v), 1, 1e-4, 'laminar gradient coefficient');
    },
  },
  {
    name: 'W7 Virk asymptote f 0.00049 at Re 549,856',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), r = w.pipeFriction(10, { id: 2.441, rough: 0 }, { kind: 'slickwater', rhoPpg: 8.43, muCp: 1, fr: 0.85 });
      near(assert, r.re, 549856, 2, 'Reynolds number');
      assert.strictEqual(r.model, 'fr', 'friction-reduced model');
      near(assert, r.fVirk, 0.00049, 5e-6, 'Virk f');
      assert(r.frCapped === true && r.f === r.fVirk, 'the requested 85 % is capped by the asymptote');
      near(assert, r.frEff, 0.849, 0.002, 'maximum drag reduction');
      const r70 = w.pipeFriction(10, { id: 2.441, rough: 0.0018 }, { rhoPpg: 8.43, muCp: 1, fr: 0.7 });
      near(assert, r70.dpdl * 1e4, 1576, 2, 'FR 70 % in rough tubing at 10 bbl/min');
    },
  },
  {
    name: 'W8 8.43 ppg ⇔ 1.571 wt %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx);
      near(assert, w.salinityFromPpg(8.43), 1.571, 5e-4, 'salinity');
      near(assert, w.rhoScPpg(w.salinityFromPpg(8.43)), 8.43, 1e-9, 'round trip');
      near(assert, w.rhoAt(7600, 220, { rhoPpg: 8.43 }), 8.2339, 1e-3, 'ρ at 7,600 psia, 220 °F');
    },
  },
  {
    name: 'W9 p_s for BHP 7,600: 3,220.0 / 3,173.0 / 3,181.3 / 3,260.1 psia; convert() reproduces it with a band and vacuum masking',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), col = w.column(REFCOL);
      assert(col.ok && Math.abs(col.Vw * BBL - 1245.1) < 0.1, 'V_w 1,245.1 ft³');
      near(assert, w.hydrostatic(7600, 10000, 0, col, null, { grad: 0.438 }).p, 3220.0, 0.05, 'constant 0.438 psi/ft');
      near(assert, w.hydrostatic(7600, 10000, 0, col, 60).p, 3173.0, 0.1, 'ρ(p,T) isothermal 60 °F');
      near(assert, w.hydrostatic(7600, 10000, 0, col, 70).p, 3181.3, 0.1, 'ρ(p,T) isothermal 70 °F');
      const geo = w.hydrostatic(7600, 10000, 0, col, null);
      near(assert, geo.p, 3260.1, 0.1, 'ρ(p,T) geotherm');
      assert(typeof geo.rangeNote === 'string' && geo.rangeNote.length < 300, 'correlation-range note (7,600 psia > 5,000)');
      near(assert, w.hydrostatic(geo.p, 0, 10000, col, null).p, 7600, 0.05, 'downward integration inverts the upward one');
      // convert: a pumping period then a falloff that runs the surface into vacuum
      const t = [], ps = [], q = [];
      for (let i = 0; i <= 40; i++) { const ti = i * 0.01; t.push(ti); q.push(ti < 0.1 ? 7200 : 0); ps.push(ti < 0.1 ? 3400 : 3260.1 - 400 * (ti - 0.1)); }
      t.push(20); q.push(0); ps.push(10);   // late: below 0 psig
      const cv = w.convert({ t, pSurf: ps, q }, { column: col, perfs: { n: 12, dIn: 0.4, cd: 0.6 }, stepDown: { a: 1.528, b: 140.9, beta: 0.5, se: { b: 8.8 } } }, { band: true });
      assert(cv.ok, 'convert ok');
      const iS = 12;   // first falloff sample after t_s
      near(assert, cv.pw[iS], w.hydrostatic(ps[iS], 0, 10000, col, null).p, 0.05, 'static falloff sample = hydrostatics');
      const pipe = w.pipeDp(5, col, col.fluid).dp;
      near(assert, cv.parts.pipe[5], -pipe, 1e-6, 'pumping: pipe friction subtracted');
      near(assert, cv.parts.perf[5], 37.6 * (8.43 / 8.43), 0.6, 'perforation term at 5 bbl/min (stated C_d 0.6)');
      near(assert, cv.parts.nwb[5], 315.06, 0.05, 'near-wellbore term');
      near(assert, cv.pf[5], cv.pw[5] - cv.parts.perf[5] - cv.parts.nwb[5], 1e-9, 'fracture-entrance pressure');
      assert(cv.band && cv.band.p10[5] < cv.pw[5] && cv.band.p90[5] > cv.pw[5], 'band brackets p_w while pumping');
      assert(cv.bandF.p90[5] - cv.bandF.p10[5] > cv.band.p90[5] - cv.band.p10[5], 'the p_f band also carries the perforation and b terms');
      assert(cv.terms.length === 4 && cv.terms.every((x) => typeof x.name === 'string'), 'term list');
      assert(cv.bandTerms.some((x) => /density/.test(x.name)) && cv.bandTerms.some((x) => /temperature model/.test(x.name)), 'band terms named');
      assert.strictEqual(cv.vacuumAt, 20, 'vacuum time');
      assert.strictEqual(cv.pw[cv.pw.length - 1], null, 'converted data after vacuum are masked');
      assert(cv.flags.some((f) => f.code === 'VACUUM' && f.level === 'bad'), 'vacuum flag');
      cv.flags.forEach((f) => assert(S.checkShape('Warning', f).ok, 'flag shape ' + f.code));
    },
  },
  {
    name: 'W10 displaced-column warm-back +18.3 / +33.8 / +57.4 psi for 25 / 50 / 100 bbl',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), col = w.column(REFCOL);
      const geo = w.hydrostatic(7600, 10000, 0, col, null).p;
      [[25, 18.3, 1127], [50, 33.8, 2255], [100, 57.4, 4509]].forEach(([V, drift, D]) => {
        const tp = w.tempProfile(col, { model: 'displaced', Vinj: V, t: 0, tInjF: 70 });
        assert(tp.ok && tp.model === 'displaced', 'displaced profile');
        near(assert, tp.D, D, 1, 'displaced depth for ' + V + ' bbl');
        near(assert, geo - w.hydrostatic(7600, 10000, 0, col, tp).p, drift, 0.1, 'warm-back drift for ' + V + ' bbl');
      });
      const late = w.tempProfile(col, { model: 'displaced', Vinj: 25, t: 100, tauH: 1 });
      near(assert, w.hydrostatic(7600, 10000, 0, col, late).p, geo, 0.01, 'relaxed back to the geotherm');
      assert.strictEqual(w.tempProfile(col, { model: 'ramey' }).code, 'NOT_AVAILABLE', 'Ramey belongs to 3.4b');
    },
  },
  {
    name: 'W11 bleed-off 1 psi at 15.45 / 1.63 min (V_w·c_w 4.44e-3 ft³/psi); 17.33 / 1.83 min at 4.98e-3',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx);
      [[4.44e-3, 15.45, 1.63], [4.98e-3, 17.33, 1.83]].forEach(([VC, tPure, tTwo]) => {
        const pure = w.bleedOff({ b: 140, beta: 0.5, qt: 0, VwCw: VC / BBL, d0: 315 });
        const two = w.bleedOff({ b: 140, beta: 0.5, qt: 0.1, VwCw: VC / BBL, d0: 315 });
        assert(pure.ok && two.ok, 'bleedOff ok');
        near(assert, pure.t1psi * 60, tPure, 0.01, 'pure q^½ at ' + VC);
        near(assert, two.t1psi * 60, tTwo, 0.01, 'two-branch at ' + VC);
        near(assert, pure.curve(pure.t1psi), 1, 1e-6, 'curve(t1psi) = 1 psi');
      });
      const r = w.bleedOff({ b: 140.9, beta: 0.5, qt: 0.1, VwCw: 4.44e-3 / BBL, q0: 5 });
      near(assert, r.d0, 315.06, 0.01, 'loss at shut-in from b and q0');
      const pure = w.bleedOff({ b: 140.9, beta: 0.5, qt: 0, VwCw: 4.44e-3 / BBL, q0: 5 });
      near(assert, pure.curve(6 / 3600), 105, 5, 'tortuosity loss ≈ 105 psi at 6 s (pure q^½)');
      near(assert, pure.curve(30 / 3600), 29, 3, '≈ 29 psi at 30 s (pure q^½)');
      assert(r.curve(30 / 3600) < pure.curve(30 / 3600), 'the linear branch below q_t bleeds faster');
      assert(r.t10psi < r.t1psi, 't10psi before t1psi');
    },
  },
  {
    name: 'W12 step-down reference fit: p_frac 7,595.5, a 1.528, b 140.9, n 11.9',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), r = w.stepDown(sdSteps(), { perfs: { n: 12, dIn: 0.40, cd: 0.6 }, rhoPpg: 8.43 });
      shapeOk(assert, 'StepDown', r);
      near(assert, r.pFrac, 7595.5, 0.05, 'p_frac'); near(assert, r.a, 1.528, 5e-4, 'a'); near(assert, r.b, 140.9, 0.05, 'b');
      near(assert, r.nOpen, 11.9, 0.05, 'open perforations (C_d 0.6)');
      assert.strictEqual(r.beta, 0.5, 'β fixed at ½');
      near(assert, r.at.dpPerf, 38.2, 0.1, 'perforation at 5 bbl/min'); near(assert, r.at.dpNwb, 315.0, 0.1, 'tortuosity at 5 bbl/min');
      assert.strictEqual(r.regime, 'tortuosity dominated', 'connection label');
      assert.strictEqual(r.label, 'high', 'fit label'); assert.strictEqual(r.refused, null, 'not refused');
      assert(r.resid.length === 4 && r.resid.every((x) => Math.abs(x) < 1), 'residuals');
      assert(r.corr.ab < -0.9, 'a and b anti-correlated');
      // β free with five noiseless steps: β recovered
      const r5 = w.stepDown([5, 4, 3, 2, 1].map((q) => ({ q, p: 7598 + 1.505 * q * q + 140 * Math.pow(q, 0.5) })), { beta: 'free' });
      shapeOk(assert, 'StepDown', r5);
      near(assert, r5.beta, 0.5, 0.011, 'β free');
    },
  },
  {
    name: 'W13 identifiability (10.6, 0.414, 8.8) at σ 2 psi; a 25 % rate range is refused',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx);
      const ok = w.stepDownDesignCheck(SD_Q.map((q) => ({ q })));
      assert(ok.ok === true && ok.why === null, 'four steps 5 → 1.25 pass');
      near(assert, ok.se.pFrac, 10.6, 0.05, 'se(p_frac)'); near(assert, ok.se.a, 0.414, 5e-4, 'se(a)'); near(assert, ok.se.b, 8.8, 0.05, 'se(b)');
      const five = w.stepDownDesignCheck([5, 4, 3, 2, 1].map((q) => ({ q })));
      near(assert, five.se.pFrac, 7.9, 0.05, 'five steps se(p_frac)'); near(assert, five.se.a, 0.34, 0.005, 'five steps se(a)'); near(assert, five.se.b, 6.8, 0.05, 'five steps se(b)');
      const narrow = [5, 4.583, 4.167, 3.75];
      const bad = w.stepDownDesignCheck(narrow.map((q) => ({ q })));
      assert(bad.ok === false && bad.code === 'REFUSED' && /25 %/.test(bad.why), 'a 25 % range is refused');
      near(assert, bad.se.pFrac, 219, 1, 'its se(p_frac)');
      assert(S.checkShape('Failure', bad).ok, 'refusal carries the failure form');
      const rf = w.stepDown(narrow.map((q) => ({ q, p: 7600 + 1.5 * q * q + 140 * Math.sqrt(q) })));
      shapeOk(assert, 'StepDown', rf);
      assert(rf.label === 'refused' && typeof rf.refused === 'string' && rf.pFrac === null, 'stepDown refuses the split');
      assert(w.stepDownDesignCheck([{ q: 5 }, { q: 2 }]).ok === false, 'fewer than three steps refused');
    },
  },
  {
    name: 'W14 open perforations P10 / P50 / P90 8.9 / 11.7 / 16.0 (± 0.3, seeded)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), o = { perfs: { n: 12, dIn: 0.40, cd: 0.6 }, rhoPpg: 8.43, seed: 1 };
      const r = w.stepDown(sdSteps(), o);
      near(assert, r.nOpenBand.p10, 8.9, 0.3, 'P10'); near(assert, r.nOpenBand.p50, 11.7, 0.3, 'P50'); near(assert, r.nOpenBand.p90, 16.0, 0.3, 'P90');
      assert(/diameter/.test(r.nOpenBand.driver), 'dominant driver: the entrance-hole diameter (d⁴)');
      assert.deepStrictEqual(w.stepDown(sdSteps(), o).nOpenBand, r.nOpenBand, 'same seed → identical band');
      assert.notDeepStrictEqual(w.stepDown(sdSteps(), Object.assign({}, o, { seed: 7 })).nOpenBand, r.nOpenBand, 'another seed → another sample');
    },
  },
  {
    name: 'W15 surface tubing case: open perforations "not determinable"',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), cpt = 406 / Math.pow(5, 1.855), pipe = (q) => cpt * Math.pow(q, 1.855);
      const r = w.stepDown(sdSteps(pipe), { pipe, perfs: { n: 12, dIn: 0.40, cd: 0.6 } });
      shapeOk(assert, 'StepDown', r);
      assert.strictEqual(r.nOpen, null, 'n_p null'); assert.strictEqual(r.nOpenText, 'not determinable', 'n_p not determinable');
      assert(r.nOpenBand.p50 === null && /not determinable/.test(r.nOpenBand.driver), 'no band');
      near(assert, r.at.dpPipe, 406, 0.5, 'pipe term at the top rate');
      near(assert, r.pFrac, 7595.5, 0.05, 'p_frac robust'); near(assert, r.b, 140.9, 0.05, 'b robust');
      // ±10 % pipe-friction error moves n_p widely (8.5 → 58): the reason it is not reported
      const r9 = w.stepDown(sdSteps(pipe), { pipe: (q) => 0.9 * pipe(q), perfs: { n: 12, dIn: 0.40, cd: 0.6 } });
      assert(r9.nOpen === null, 'still not determinable with 90 % of the pipe term');
    },
  },
  {
    name: 'W16 hammer: c 4,539 ft/s, T 8.81 / 4.41 s, Joukowsky 232.1 psi; a 50 Hz window gives ISIP within 1 psi and the reflector within 3 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), col = w.column(REFCOL), cs = w.csys(col);
      near(assert, cs.waveSpeed, 4539, 1, 'wave speed');
      near(assert, 4 * 10000 / cs.waveSpeed, 8.81, 0.005, 'quarter-wave period'); near(assert, 2 * 10000 / cs.waveSpeed, 4.41, 0.005, 'half-wave period');
      const T = 4 * 10000 / cs.waveSpeed, ts = 0.1;
      const hw = hammerWindow((s, nrm) => (s <= 0 ? 7953 : 7605 - 0.4 * s / 60 + 115 * Math.exp(-s / 6.5) * Math.cos(2 * Math.PI * s / T) + 0.2 * nrm()), ts, 11);
      const h = w.hammerQuick(hw.t, hw.p, ts, { column: col, qShut: 5 });
      shapeOk(assert, 'Hammer', h);
      near(assert, h.isip, 7605, 1, 'ISIP_wh');
      rel(assert, h.Lquarter, 10000, 0.03, 'quarter-wave reflector depth');
      assert(h.regime === 'ringing' && h.reflectorMatch === 'perfs', 'ringing at the perforations');
      near(assert, h.joukowsky.expected, 232.1, 0.2, 'Joukowsky');
      near(assert, h.T, T, 0.02, 'period'); near(assert, h.tau, 6.5, 0.2, 'decay time');
      assert(h.sampling.ok && h.sampling.per2Lc > 200, 'sampling ≥ 10 per 2L/c');
      assert(h.upper === false && h.bleed.fitted === false, 'no bleed term (no step-down)');
      const slow = w.hammerQuick(hw.t.filter((_, i) => i % 50 === 0), hw.p.filter((_, i) => i % 50 === 0), ts, { column: col });
      assert(slow.ok === false && slow.code === 'NOT_RESOLVABLE' && slow.sampling.ok === false, '1 Hz: water hammer not resolvable');
    },
  },
  {
    name: 'W16b bleed-off + ringing: bleed-aware midline within 5 psi, linear midline ≥ 20 psi high and "upper" with the bleed term off',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      // source: one lumped bleed-off simulation of the reference (b 140.9, β ½, q_t 0.1, V_w·c_w 4.44e-3 ft³/psi, 5 bbl/min)
      // with a damped quarter-wave ring and 0.3 psi noise; truth ISIP 7,600 psia
      const w = W(ctx), col = w.column(REFCOL), VC = 4.44e-3 / BBL, ts = 0.1, T = 4 * 10000 / w.csys(col).waveSpeed;
      const bo = w.bleedOff({ b: 140.9, beta: 0.5, qt: 0.1, VwCw: VC, q0: 5 });
      const hw = hammerWindow((s, nrm) => (s <= 0 ? 7953 : 7600 - 0.4 * s / 60 + bo.curve(s / 3600) + 60 * Math.exp(-s / 8) * Math.cos(2 * Math.PI * s / T + 0.3) + 0.3 * nrm()), ts, 13);
      const ctxH = { column: col, qShut: 5, bleed: { b: 120, beta: 0.5, qt: 0.1 }, VwCw: VC };   // seeded off the truth
      const h = w.hammerQuick(hw.t, hw.p, ts, ctxH);
      shapeOk(assert, 'Hammer', h);
      near(assert, h.isip, 7600, 5, 'bleed-aware midline ISIP');
      assert(h.bleed.fitted === true && h.upper === false, 'bleed term fitted → accepted');
      near(assert, h.bleed.b, 140.9, 5, 'fitted b');
      const lin = w.hammerQuick(hw.t, hw.p, ts, Object.assign({}, ctxH, { bleed: { b: 140.9, beta: 0.5, qt: 0.1 }, fitBleed: false }));
      shapeOk(assert, 'Hammer', lin);
      assert(lin.isip >= 7620, 'linear midline reads ≥ 20 psi high: ' + lin.isip);
      assert(lin.upper === true && /Upper estimate/.test(lin.why), 'flagged "upper"');
    },
  },
  {
    name: 'W17 vacuum: p_s 195.2 / 95.9 / −3.3 psia at p_i 4,500 / 4,400 / 4,300',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), col = w.column(REFCOL);
      const v = [4500, 4400, 4300].map((pi) => w.vacuum(pi, col, null));
      near(assert, v[0].pSurfAtPi, 195.2, 0.1, '4,500'); near(assert, v[1].pSurfAtPi, 95.9, 0.1, '4,400'); near(assert, v[2].pSurfAtPi, -3.3, 0.1, '4,300');
      assert(v[0].risk === 'none' && v[2].risk === 'surface-zero' && v[2].level === 'fail', 'risk levels');
      v.forEach((x) => assert(x.text.length < 300 && !/\b(null|undefined|NaN|Infinity)\b/.test(x.text), 'plain text'));
      assert(w.vacuum(4400, col, null).level === 'ok' && w.vacuum(4325, col, null).level === 'warn', 'warn below 15 psig');
    },
  },
  {
    name: 'W18 clock offset 37.4 s recovered within 0.2 s',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), nrm = nrmOf(lcg(3)), off = 37.4;
      const qT = (t) => (t < 300.3 ? 5 : t < 320.3 ? 3.75 : t < 340.3 ? 2.5 : t < 360.3 ? 1.25 : 0);
      const tp = [], pp = [], tq = [], qq = [];
      for (let t = 200; t <= 900; t++) { const q = qT(t); tp.push(t / 3600); pp.push(7600 - 0.03 * (t - 300) + 1.505 * q * q + 140 * Math.sqrt(q) + 0.5 * nrm()); }
      for (let t = 200; t <= 900; t++) { tq.push((t + off) / 3600); qq.push(qT(t) + 0.02 * nrm()); }
      const a = w.align(tp, pp, tq, qq);
      assert(a.ok && a.method === 'xcorr', 'cross-correlation');
      near(assert, a.offsetS, 37.4, 0.2, 'offset');
      assert(a.confirm === true && a.hourShift === false && a.score > 0.5, 'shown for confirmation; not an hour shift');
      near(assert, a.events[0].offsetS, 37.4, 1.5, 'event method agrees roughly');
      // a whole-hour shift is labelled
      const b = w.align(tp, pp, tq.map((x) => x + 1), qq);
      near(assert, b.offsetS, 3637.4, 0.3, 'offset with one hour added');
      assert.strictEqual(b.hourShift, false, '3,637.4 s is not a whole number of hours');
      const c = w.align(tp, pp, tq.map((x) => x + 1 - off / 3600), qq);
      assert(c.hourShift === true && /time zone/.test(c.text), 'exactly one hour → time zone / daylight saving');
    },
  },
  {
    name: 'W19 csys: c_sys 3.57e-6, V_w·c_w 4.44e-3 ft³/psi, ramp 6,323 psi/min, and L·A/(ρc²) from the period = the ramp value ± 1 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), col = w.column(REFCOL), cs = w.csys(col);
      assert(cs.ok, 'csys ok');
      near(assert, cs.cSys, 3.57e-6, 0.005e-6, 'c_sys'); near(assert, cs.cFluid, 3.125e-6, 1e-12, 'c_fluid (1/K, K 3.2e5 psi)'); near(assert, cs.cPipe, 0.44e-6, 0.005e-6, 'pipe term');
      near(assert, cs.VwCwFt3, 4.44e-3, 0.005e-3, 'V_w·c_w ft³/psi'); near(assert, cs.VwCw, 7.91e-4, 0.005e-4, 'V_w·c_w bbl/psi');
      near(assert, 5 / cs.VwCw, 6323, 3, 'ramp psi/min at 5 bbl/min');
      near(assert, cs.rhoSlug, 1.960, 5e-4, 'ρ slug/ft³');
      const fromT = w.vwcwFromPeriod(8.81, 10000, col.segments[0].area, 8.43, 'quarter');
      rel(assert, fromT, cs.VwCw, 0.01, 'L·A/(ρc²) from the 8.81 s period');
      // the ramp analyser reads the same stiffness from a synthetic 5 bbl/min pre-breakdown ramp
      const t = [], p = []; for (let i = 0; i <= 60; i++) { t.push(i / 3600); p.push(4500 + 6322.6 * i / 60); }
      const rp = w.ramp(t, p, 5, null, { kind: 'pre-breakdown' });
      shapeOk(assert, 'Ramp', rp);
      rel(assert, rp.VwCwRamp, cs.VwCw, 0.01, 'ramp V_w·c_w'); assert.strictEqual(rp.label, 'no knee', 'one line');
    },
  },
  {
    name: 'W20 step-rate vector: q* 1,805 bbl/d, FEP 6,199.3, P10–P90 6,186–6,217, b₁ 1.249, b₂ 0.037',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), d = stepRateData(), r = w.stepRate(d.ends, { seed: 1 });
      shapeOk(assert, 'StepRate', r);
      assert(r.breakFound === true && r.fTest.p < 0.05, 'break found (F-test)');
      // continuous hinge: the prototype's 5 bbl/d grid gave 1,805 / 6,199.3; the continuous minimum is 1,806.2 / 6,200.5
      near(assert, r.qStar * 1440, 1805, 5, 'q* bbl/d');
      near(assert, r.fep, 6199.3, 2, 'FEP');
      near(assert, r.band.p10, 6186, 3, 'FEP P10'); near(assert, r.band.p90, 6217, 3, 'FEP P90');
      assert(r.band.p10 <= 6204 && r.band.p90 >= 6204, 'the true parting pressure 6,204 is inside the band');
      near(assert, r.b1 / 1440, 1.249, 0.003, 'b₁ psi/(bbl/d)'); near(assert, r.b2 / 1440, 0.037, 0.004, 'b₂ psi/(bbl/d)');
      assert.deepStrictEqual(w.stepRate(d.ends, { seed: 1 }).band, r.band, 'seeded bootstrap is reproducible');
      // a straight matrix line: no break
      const line = w.stepRate(d.ends.slice(0, 5).map((s, i) => ({ q: s.q, pEnd: 4000 + 1500 * s.q + (i % 2 ? 0.5 : -0.5) })), {});
      shapeOk(assert, 'StepRate', line);
      assert(line.breakFound === false && line.qStar === null && /No break/.test(line.why), 'one line → no break');
    },
  },
  {
    name: 'W21 an unstabilised step is flagged and the band is recomputed without it',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      // six flat steps (6-s samples, 30 min each, σ 0.2 psi) on a hinge with q* 2.0 bbl/min; step 5 still climbs 4 psi/min
      const w = W(ctx), qs = [0.5, 1.0, 1.5, 2.5, 3.0, 3.5], nrm = nrmOf(lcg(21)), t = [], p = [], steps = [];
      const pOf = (q) => 5000 + 800 * Math.min(q, 2) + 40 * Math.max(0, q - 2);
      qs.forEach((q, n) => {
        const t0 = n * 0.5, t1 = (n + 1) * 0.5;
        steps.push({ q, t0, t1 });
        for (let j = 1; j <= 300; j++) { const tt = t0 + j / 600; t.push(tt); p.push(pOf(q) + (n === 4 ? 0.4 * (j - 300) : 0) + 0.2 * nrm()); }
      });
      const r = w.stepRate(steps, t, p, { seed: 2 });
      shapeOk(assert, 'StepRate', r);
      assert.strictEqual(JSON.stringify(r.steps.map((s) => s.stabilised)), JSON.stringify([true, true, true, true, false, true]), 'step 5 not stabilised');
      assert(r.steps.every((s) => typeof s.dpdt === 'number') && r.steps[4].dpdt > 200, 'dp/dt over the last 30 % (psi/h)');
      assert(/not stabilised/.test(r.why), 'stated in why');
      assert(r.stableOnly && Array.isArray(r.stableOnly.excluded) && r.stableOnly.excluded[0] === 3.0, 'second answer without the step');
      assert(r.stableOnly.breakFound === true, 'band recomputed without the unstabilised step');
      near(assert, r.stableOnly.fep, 6600, 5, 'FEP without it');
      near(assert, r.stableOnly.qStar, 2.0, 0.05, 'q* without it');
      assert(r.stableOnly.band.p10 <= r.stableOnly.fep && r.stableOnly.band.p90 >= r.stableOnly.fep, 'its band');
      assert(Math.abs(r.fep - r.stableOnly.fep) > 1 || Math.abs(r.qStar - r.stableOnly.qStar) > 0.01, 'both answers differ (the hollow step pulls the all-steps fit)');
    },
  },
  {
    name: 'W22 ramp knee within 10 psi (truth inside P10–P90), s₁ within 1 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), d = rampData(false), r = w.ramp(d.t, d.p, d.q, null, { kind: 'reopening', seed: 1 });
      shapeOk(assert, 'Ramp', r);
      near(assert, r.knee.p, d.pk, 10, 'knee pressure');
      assert(r.band.p10 <= d.pk && r.band.p90 >= d.pk, 'truth inside P10–P90: ' + JSON.stringify(r.band));
      rel(assert, r.slopes.s1, 1 / d.VC, 0.01, 's₁ = 1/(V_w·c_w)');
      rel(assert, r.VwCwRamp, d.VC, 0.01, 'V_w·c_w from the ramp');
      rel(assert, r.slopes.s2, 1 / (d.VC + 0.0367), 0.05, 's₂ = 1/(V_w·c_w + A_f·c_f)');
      assert(r.stiffRatio > 40 && r.label === 'knee', 'stiffness ratio and label');
      near(assert, r.knee.t, d.tk, 0.002, 'knee time (h)');
      assert(/near-wellbore/.test(r.why) && r.nwbCorr === null, 'reopening without a step-down: upper-bound caveat');
    },
  },
  {
    name: 'W23 one-slope ramp → "no knee"; the LOT onset within 3σ of the true departure',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx);
      const one = rampData(true), r1 = w.ramp(one.t, one.p, one.q, [0, 1], {});
      shapeOk(assert, 'Ramp', r1);
      assert(r1.knee === null && r1.band === null && r1.label === 'no knee', 'no knee');
      rel(assert, r1.slopes.s1, 1 / one.VC, 0.01, 'single slope');
      const d = rampData(false), lot = w.ramp(d.t, d.p, d.q, { t0: 0, t1: 1 }, { kind: 'lot' });
      shapeOk(assert, 'Ramp', lot);
      assert(lot.kind === 'lot' && lot.onset, 'onset reported for a leak-off test');
      near(assert, lot.onset.p, d.pk, 3 * 0.5, 'onset pressure within 3σ of the departure');
      assert(lot.onset.V >= d.Vk - 0.01, 'onset at or after the departure');
    },
  },
  {
    name: 'W24 the near-wellbore-corrected knee shifts by 99.6 psi (+ 0.4 psi perforation) at 0.5 bbl/min',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const w = W(ctx), d = rampData(false);
      const r = w.ramp(d.t, d.p, d.q, null, { kind: 'reopening', stepDown: { a: 1.528, b: 140.9, beta: 0.5 } });
      shapeOk(assert, 'Ramp', r);
      near(assert, w.nwbLoss(0.5, { b: 140.9, beta: 0.5 }), 99.6, 0.05, 'Δp_nwb(0.5)');
      near(assert, r.nwbCorr, 99.63 + 0.382, 0.02, 'correction = tortuosity + perforation');
      near(assert, r.knee.p - r.knee.pCorr, 100.0, 0.05, 'corrected knee shift');
      assert.strictEqual(r.why, null, 'corrected: no upper-bound caveat');
    },
  },
];
