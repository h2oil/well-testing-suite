// prism-build/tests/_buildup-shapes.js — Build-up Surveillance executable contract (WP0, FROZEN).
//
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §3 (interfaces), §3.1 "WP0 resolutions" and §3.13. Changes only through the
// lead, together with an update of §3.13.
//
// Exports
//   checkShape(name, obj) → { ok, errors: ['<path>: <reason>', …] }   (path first, e.g. 'tests[2].result.iarf.cycles')
//       Names (§3.13): BuildupSpec, BuildupResult, ModelFit, KHeld, Reach, GaugeRecord, QC, Event, RateHistory,
//       AnalysisInput, Analysis, TestEntry, TrendTest, Trend, Review, Finding, Answer, ReportModel, CaseSpec,
//       SynthCase, Score, Cal. Helper names are also checkable: BuildupSpecStored, Warning, FullySeen,
//       EvidenceVector, Confidence, Zone, ZoneResolved, WellInput, Completion, Depth, Settings, Override,
//       AllocRow, Missed, Value, Block, Section, Signoff, EvidenceItem, EvidenceIndex, Iarf, Line.
//   SHAPE_NAMES        the §3.13 names, in plan order
//   SHAPES             every checkable name (the §3.13 names plus the helper names)
//   FIX                lazy fixtures generated from closed-form values (Appendix A, §4.6); every access returns a deep copy:
//       FIX.result     reference-case BuildupResult (k 45 md, S 5, C 0.02 bbl/psi, h 50 ft, μ 1 cp, 72 h, single rate)
//       FIX.analysis   6-test oil Analysis: confirmed delta alert (raised B5, confirmed B6), one excluded test (B4,
//                      override O1) and one k-held test (B5, 12 h shut-in, no IARF); record = FIX.samples.GaugeRecord
//       FIX.samples    one valid example for every other shape (BuildupSpec, GaugeRecord, AnalysisInput, TrendTests[],
//                      Review, Finding, Answer, ReportModel, CaseSpec, SynthCase, Score, Signoff, EvidenceIndex) plus
//                      ModelFitFault (a linearBoundary rival with the categorical parameter BC)
//       FIX.cal        a Cal-shaped table used by the fixtures only (version 'cal-fixture'; NOT file 55)
//       FIX.inputs     the closed-form inputs the fixtures were generated from (well, RES, settings, plan, sampling, …)
//   FORMULAS           test-only table of derived quantities (each a function with .args and .text):
//                      m, mPrime, dpSkin, X, piRatio, rateAtStake, extraDrawdown, dkPct, rinv, dte, shutOfDte, xOfDte,
//                      dteOfX, logTerm, pStar, p1hr, reachFair, reachGood, sTc, sPwf, rDrift, sensDS, sensK, sKAnalytic,
//                      atStakeDay, jObs, jPred, modelFreeDS, kStar, SStar
//   autoInterp()       PRiSM_autoInterp from 53-prism-autointerp.js with the self-test stripped exactly as Round 8 strips it
//                      (concat-round8.stripSelfTest), evaluated in a bare vm context (canon, hash16)
//   nearDisplay(key, a, b)  true when a and b agree at the display precision of `key` (canon 'display' rules)
//
// Conventions encoded here (§3.0, §3.1 "WP0 resolutions")
//   • Field units. Absolute pressures psia (> 0); Δp and noise psi; record/allocation times epoch ms UTC (plausible
//     epoch: 1e11 ≤ t < 1e14); engine times hours on the history clock (may be negative before the record); Δt > 0 h;
//     dates 'YYYY-MM-DD'; timestamps ISO 8601; hashes 16 lowercase hex (SHA-256 64 hex).
//   • X axes. bins.X is ln Δt_e (the derivative's abscissa, D6). iarf.X0, iarf.X1 and line.shifts[].dX are log10 Δt_e
//     (cycles): cycles = X1 − X0, a shifted window is [X0 + dX, X1 + dX], and dt0_h/dt1_h are the shut-in times of
//     10^X0 / 10^X1 with the test's effective tp (Δt = Δt_e·tp/(tp − Δt_e)).
//   • Null rule. In output shapes (everything an engine returns) every number is finite or null (§3.0), so plain
//     numeric fields accept null; NaN, ±Infinity, undefined and strings never pass. Fields marked "!" below are
//     finite numbers even in outputs (array samples, time anchors). In input shapes (BuildupSpec, AnalysisInput,
//     WellInput, Completion, Depth, Settings, Override, CaseSpec) a number may be null only where §3 writes `|null`.
//   • Keys listed in §3 are required; a trailing '?' marks a key that may be absent (§3 writes `key?`, or the stored
//     copy drops it: bins.X, bins.dte, curves; `evidence` holds the EvidenceVector that §3.1 says is stored in the
//     result). Extra keys are allowed. Enumerations are exact.
//   • ModelFit.params and fitC4.params carry PRiSM model parameters: numbers, or the categorical values PRiSM keeps in
//     params (strings such as BC 'noflow'|'constP', booleans). ModelFit.se and ci95 always carry k, S and C (each may be
//     null); other keys are open. ModelFit.se.S is already inflated by √(n/n_eff) (§4.6 item 6), and sErr.seS is that
//     value (never inflated again).
//   • Settings: detect.partial is a boolean; interp.band and interp.slope are fractions in (0, 1] (band 0.10 = the
//     10 % of bu_i_band); interp.kHeld 'auto'|'off'; trend.confirm 'next'|'immediate'.
//   • Override.target is null only for kind 'event_add' (the new event gets its E id at the next Analyse).
//   • Evidence ids (§8.1): test-level results carry ids relative to the test ('I1'), restricted to the ids §3 lists for
//     that object; well-level and review objects carry 'T2' or 'B3·I1'. Text fields are plain, < 300 characters
//     (notes, recommendations, limitations ≤ 600) and never contain 'null', 'undefined', 'NaN', 'Infinity' or
//     '[object Object]'.
//
// Fixture conventions (closed form, homogeneous infinite-acting + WBS + skin; field units)
//   m = 162.6·q·B·μ/(k·h); m′ = m/ln 10 (= 70.6·qBμ/kh); Δp_IARF(Δt_e) = m·[log10(k·Δt_e/(φμct·rw²)) − 3.2275 + 0.8686·S];
//   Δt_e = tp·Δt/(tp + Δt) with tp the time since the previous reopening (production start for B1);
//   p* = pwf0 + m·[log10(k·tp/(φμct·rw²)) − 3.2275 + 0.8686·S]; p1hr = p* − m·log10(tp + 1); t5 %, t10 % and t_hump from
//   Appendix A.1; IARF window from t5 % to the last full-window bin (Δt_e,end/10^Lcyc); one earlier shifted line with
//   dX = −min(0.25, 0.2·cycles); reach.fair = 10^(0.5+Lcyc)·t5 %, reach.good = 10^(1+Lcyc)·t5 %; r_inv = 0.0325·√(kΔt/(φμct));
//   Δp_skin = 0.8686·m·S; sensitivity from Appendix A.2; S_tc, S_pwf, r_drift from §4.2/§4.6; dp/dt_flow at closing =
//   −m/(ln 10·tp) (the slope of the infinite-acting drawdown); S_kAnalytic = δ·(ln 10·Δp_end/(2m) − 0.5).
//   Bin and record pressures use the smooth closed-form blend Δp = Δp_IARF·(1 − exp(−Δp_WBS/Δp_IARF)), Δp_WBS = qBΔt/(24C),
//   only to give plausible arrays; every reported number comes from the closed forms above. The semilog line carries the
//   EN6 reference bias (fair window: k −2.6 %, S −0.33; good window: k −0.5 %, S −0.05) so line-vs-match numbers are
//   not trivially zero. Calibration rates come from FIX.cal (fixture only).
//   One gauge record (FIX.samples.GaugeRecord = AnalysisInput.record) carries the whole analysis: 15-min samples while
//   flowing (drawdown from the last reopening at the closing test's rate and skin; E4 uses S = 2), 1-min samples in
//   every shut-in starting Δt = 0.005 h after closing, pressures rounded to 0.001 psi, no noise. analysis.record.{n,
//   origin_ms, end_ms, hash}, qc.n / dtMed_s / dtP05_s / dtP95_s, Event.j0/j1, spec.dtSample_h and days[].pwfMean_psia
//   (mean flowing sample per day) are derived from it. The record hash is a fixture convention (hash16 of n, the first
//   and last times and an FNV-1a digest of all samples); WP2 fixes the real one. The SynthCase has its own record (the reference case, 60 s samples).
//   Trend (§4.7), computed from the stored inputs: baseline, alerts, T7, T8 (cumulative = Σ_days q_d·[(X + S(t_d))/(X +
//   S_base) − 1] over days whose midpoint is at or after τ̂), T9, T10, T11 (Δt_ref over the used tests that have an IARF
//   window; reference = the first of them; Δp read from the bins by linear interpolation in log Δt_e), T12, T13 (J_obs
//   on clean flowing days between consecutive used tests, p_ref interpolated between the used tests' p_ext, J_pred with
//   the baseline k; RJ = median J_obs/J_pred). S(t) for T8 and T13 is piecewise linear through the used tests'
//   (tDays, S) with the onset knot (τ̂, S_base) inserted, constant outside. The recent trend needs n ≥ 3 tests after τ̂:
//   the fixture has 2, so its slopes are null. Δp_skin (T7, 0.8686·m·S per test) and the T8 extra drawdown
//   (141.2·q_now·Bμ·ΔS/kh) are different quantities and are never compared (plan §4.7).
//   Placeholders (fixed values, not derived): onset τ̂ (midway between the last baseline-level test and the raising
//   test; interval ±5 days; CUSUM ids), QC noise figures (σ, ρ1, resolution), Event detection numbers (rise_psi,
//   riseScale_min, Ts_psi, alloc ratios, fhat) and the rate checks (R3/R4 ratios).
//   NOT regression truth for the engine. The bins and Δt_e use single-rate Horner with tp since the last reopening,
//   while spec.steps hold the full multi-rate history (line.method 'superposition' for B1–B6), and the bins are
//   closed-form log bins, not binned from the record. An engine run on FIX specs therefore does not reproduce the FIX
//   bins, p* or S exactly. FIX is a shape and self-consistency fixture until the lead refreshes it from engine output
//   (§3.13).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ═════════════════════════════════════════════════════════════════════════════
// 1. PRiSM_autoInterp (canon / hash16) from file 53, loaded without the app
// ═════════════════════════════════════════════════════════════════════════════
// The self-test is stripped with Round 8's own stripper, so the helper evaluates exactly what Round 8 ships and does not
// depend on (or leak) anything the WP1 self-test may need from the app.
let _ai = null;
function autoInterp() {
  if (_ai) return _ai;
  const file = path.join(__dirname, '..', '53-prism-autointerp.js');
  const { stripSelfTest } = require(path.join(__dirname, '..', 'concat-round8.js'));
  const src = stripSelfTest(fs.readFileSync(file, 'utf8'), '53-prism-autointerp.js', { log() {}, warn() {} });
  const ctx = { console: { log() {}, warn() {}, error: (...a) => console.error(...a) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  if (!ctx.PRiSM_autoInterp || typeof ctx.PRiSM_autoInterp.canon !== 'function') throw new Error('_buildup-shapes: 53-prism-autointerp.js did not define PRiSM_autoInterp.canon');
  if (ctx.PRiSM_autoInterp_selfTest !== undefined) throw new Error('_buildup-shapes: the 53 self-test was not stripped');
  _ai = ctx.PRiSM_autoInterp;
  return _ai;
}
function nearDisplay(key, a, b) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  const AI = autoInterp();
  if (AI.canon({ [key]: a }, 'display') === AI.canon({ [key]: b }, 'display')) return true;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));   // a last-bit difference at a rounding boundary
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Schema engine
// ═════════════════════════════════════════════════════════════════════════════
const BANNED = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/;
const EV_ANY = /^(B\d+·)?[QDRWILMACUKTVO]\d+$/;
const EV_REL = /^[QDRWILMACUKTVO]\d+$/;
const REF_RE = /^(B\d+·)?[QDRWILMACUKTVO]\d+(:[A-Za-z0-9_.[\]]+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTyped = (v) => ArrayBuffer.isView(v) && Object.prototype.toString.call(v) !== '[object DataView]';
function validDate(s) {
  const m = DATE_RE.exec(s); if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// type name → predicate. Numeric types accept null in output shapes unless written with '!'.
const NUMERIC = new Set(['num', 'int', 'count', 'pos', 'nonneg', 'frac', 'pfrac', 'phi', 'psia', 'psi', 'h', 'dt', 'pct', 'ms']);
const TYPES = {
  any: (v) => v !== undefined,
  num: isNum,
  int: (v) => isNum(v) && Math.floor(v) === v,
  count: (v) => isNum(v) && Math.floor(v) === v && v >= 0,
  pos: (v) => isNum(v) && v > 0,
  nonneg: (v) => isNum(v) && v >= 0,
  frac: (v) => isNum(v) && v >= 0 && v <= 1,
  pfrac: (v) => isNum(v) && v > 0 && v <= 1,
  phi: (v) => isNum(v) && v > 0 && v <= 1,
  psia: (v) => isNum(v) && v > 0 && v < 1e5,
  psi: isNum,
  h: isNum,
  dt: (v) => isNum(v) && v > 0,
  pct: isNum,
  ms: (v) => isNum(v) && v >= 1e11 && v < 1e14,
  str: (v) => typeof v === 'string',
  nestr: (v) => typeof v === 'string' && v.length > 0,
  text: (v) => typeof v === 'string' && v.length < 300 && !BANNED.test(v),
  text600: (v) => typeof v === 'string' && v.length <= 600 && !BANNED.test(v),
  tmpl: (v) => typeof v === 'string' && v.length <= 600 && !BANNED.test(v),
  bool: (v) => typeof v === 'boolean',
  obj: isObj,
  arr: Array.isArray,
  hex16: (v) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v),
  hex64: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
  date: (v) => typeof v === 'string' && validDate(v),
  iso: (v) => typeof v === 'string' && ISO_RE.test(v) && isFinite(Date.parse(v)),
  upper: (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(v),
  testId: (v) => typeof v === 'string' && /^B\d+$/.test(v),
  eventId: (v) => typeof v === 'string' && /^E\d+$/.test(v),
  targetId: (v) => typeof v === 'string' && /^[BE]\d+$/.test(v),
  ovId: (v) => typeof v === 'string' && /^O\d+$/.test(v),
  findId: (v) => typeof v === 'string' && /^F\d+$/.test(v),
  ruleV: (v) => typeof v === 'string' && /^V([1-9]|1\d|2[0-7])$/.test(v),
  ruleK: (v) => typeof v === 'string' && /^K[LKCH]\d$/.test(v),
  sectionId: (v) => typeof v === 'string' && /^S([1-9]|1[0-2])$/.test(v),
  evid: (v) => typeof v === 'string' && EV_ANY.test(v),
  evrel: (v) => typeof v === 'string' && EV_REL.test(v),
  ref: (v) => typeof v === 'string' && REF_RE.test(v),
  lvl: (v) => v === 'high' || v === 'medium' || v === 'low',
  chartId: (v) => typeof v === 'string' && /^bu_ch_[a-z0-9_]+$/.test(v),
};
const TYPE_TEXT = {
  num: 'a finite number', int: 'an integer', count: 'an integer ≥ 0', pos: 'a number > 0', nonneg: 'a number ≥ 0',
  frac: 'a number in [0, 1]', pfrac: 'a fraction in (0, 1] (not a percentage)', phi: 'a porosity in (0, 1]', psia: 'an absolute pressure in psia (> 0)', psi: 'a pressure in psi',
  h: 'hours', dt: 'a Δt in hours (> 0)', pct: 'a percentage', ms: 'epoch milliseconds UTC', str: 'a string', nestr: 'a non-empty string',
  text: 'plain text < 300 characters', text600: 'plain text ≤ 600 characters', tmpl: 'a template ≤ 600 characters', bool: 'a boolean',
  obj: 'an object', arr: 'an array', hex16: '16 lowercase hex characters', hex64: '64 lowercase hex characters', date: "a 'YYYY-MM-DD' date",
  iso: 'an ISO 8601 timestamp', upper: 'an UPPER_SNAKE code', testId: "a test id 'B<n>'", eventId: "an event id 'E<n>'",
  targetId: "'B<n>' or 'E<n>'", ovId: "an override id 'O<n>'", findId: "a finding id 'F<n>'", ruleV: 'a review rule V1–V27',
  ruleK: 'a confidence rule id KL/KK/KC/KH', sectionId: 'a section id S1–S12', evid: 'an evidence id', evrel: 'a test-relative evidence id',
  ref: "an evidence reference 'B3·I1:name'", lvl: "'high'|'medium'|'low'", chartId: "a chart id 'bu_ch_*'", any: 'a value',
};

const _parsed = new Map();
function parseSpec(s) {
  if (_parsed.has(s)) return _parsed.get(s);
  const alts = s.split('|').map((t) => t.trim()).map((t) => {
    if (t[0] === "'") return { lit: t.slice(1, -1) };
    if (t === 'null') return { nul: true };
    if (t === 'true') return { lit: true };
    if (t === 'false') return { lit: false };
    if (t[0] === '@') return { ref: t.slice(1) };
    const strict = t.endsWith('!');
    const name = strict ? t.slice(0, -1) : t;
    if (!TYPES[name]) throw new Error('_buildup-shapes: unknown type "' + name + '" in spec ' + s);
    return { type: name, strict };
  });
  _parsed.set(s, alts);
  return alts;
}
function describe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number') return isFinite(v) ? String(v) : String(v) + ' (not finite)';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}
function err(ctx, p, msg) { if (ctx.errors.length < ctx.max) ctx.errors.push((p || '(root)') + ': ' + msg); }
const join = (p, k) => (p ? p + '.' + k : k);

function checkAlt(alts, src, v, p, ctx) {
  if (v === undefined) return err(ctx, p, 'missing');
  if (v === null) {
    for (const a of alts) {
      if (a.nul || a.type === 'any') return;
      if (a.type && !a.strict && ctx.out && NUMERIC.has(a.type)) return;
    }
    return err(ctx, p, 'expected ' + src + ', got null');
  }
  const refs = [];
  for (const a of alts) {
    if (a.nul) continue;
    if ('lit' in a) { if (v === a.lit) return; continue; }
    if (a.ref) { refs.push(a.ref); continue; }
    if (TYPES[a.type](v)) return;
  }
  let first = null;
  for (const r of refs) {
    const sub = { errors: [], out: ctx.out, max: ctx.max };
    checkNamed(r, v, p, sub);
    if (!sub.errors.length) return;
    if (!first) first = sub.errors;
  }
  if (refs.length === 1 && first && v && typeof v === 'object') { for (const e of first) if (ctx.errors.length < ctx.max) ctx.errors.push(e); return; }
  const want = alts.length === 1 && alts[0].type ? TYPE_TEXT[alts[0].type] : src;
  err(ctx, p, 'expected ' + want + ', got ' + describe(v));
}
function checkObj(spec, v, p, ctx) {
  if (!isObj(v)) return err(ctx, p, 'expected an object, got ' + describe(v));
  for (const key of Object.keys(spec)) {
    const opt = key.endsWith('?');
    const name = opt ? key.slice(0, -1) : key;
    const val = Object.prototype.hasOwnProperty.call(v, name) ? v[name] : undefined;
    if (val === undefined) { if (!opt) err(ctx, join(p, name), 'missing'); continue; }
    check(spec[key], val, join(p, name), ctx);
  }
}
function checkArr(item, v, p, ctx, o) {
  o = o || {};
  if (!(Array.isArray(v) || (o.typed && isTyped(v)))) return err(ctx, p, 'expected an array' + (o.typed ? ' (or typed array)' : '') + ', got ' + describe(v));
  if (o.len != null && v.length !== o.len) err(ctx, p, 'expected ' + o.len + ' items, got ' + v.length);
  if (o.min != null && v.length < o.min) err(ctx, p, 'expected at least ' + o.min + ' items, got ' + v.length);
  if (o.max != null && v.length > o.max) err(ctx, p, 'expected at most ' + o.max + ' items, got ' + v.length);
  // fast path for plain one-type item specs (record samples): the predicate first, the full check only on a miss
  const alts = typeof item === 'string' ? parseSpec(item) : null;
  const pred = alts && alts.length === 1 && alts[0].type ? TYPES[alts[0].type] : null;
  for (let i = 0; i < v.length && ctx.errors.length < ctx.max; i++) {
    if (!(pred && pred(v[i]))) check(item, v[i], p + '[' + i + ']', ctx);
    if (o.asc && i > 0 && isNum(v[i]) && isNum(v[i - 1]) && !(v[i] > v[i - 1])) err(ctx, p + '[' + i + ']', 'not strictly ascending');
  }
}
function check(spec, v, p, ctx) {
  if (ctx.errors.length >= ctx.max) return;
  if (typeof spec === 'string') return checkAlt(parseSpec(spec), spec, v, p, ctx);
  if (typeof spec === 'function') return spec(v, p, ctx);
  if (Array.isArray(spec)) return checkArr(spec[0], v, p, ctx, null);
  if (spec && spec.$arr) return checkArr(spec.$arr, v, p, ctx, spec.o);
  if (spec && spec.$orNull) {
    if (v === undefined) return err(ctx, p, 'missing');
    if (v === null) return;
    return check(spec.$orNull, v, p, ctx);
  }
  if (spec && spec.$all) { for (const s of spec.$all) check(s, v, p, ctx); return; }
  if (spec && spec.$rec) {
    if (!isObj(v)) return err(ctx, p, 'expected an object (map), got ' + describe(v));
    for (const k of Object.keys(v)) {
      if (spec.key && !spec.key.test(k)) err(ctx, join(p, k), 'unexpected key');
      check(spec.$rec, v[k], join(p, k), ctx);
    }
    return;
  }
  if (spec && spec.$tuple) {
    if (!Array.isArray(v)) return err(ctx, p, 'expected an array, got ' + describe(v));
    if (v.length !== spec.$tuple.length) return err(ctx, p, 'expected ' + spec.$tuple.length + ' items, got ' + v.length);
    spec.$tuple.forEach((s, i) => check(s, v[i], p + '[' + i + ']', ctx));
    return;
  }
  if (spec && spec.$oneOf) {
    if (!isObj(v)) return err(ctx, p, 'expected an object, got ' + describe(v));
    const tag = v[spec.$oneOf];
    if (!Object.prototype.hasOwnProperty.call(spec.map, tag)) return err(ctx, join(p, spec.$oneOf), 'expected ' + Object.keys(spec.map).map((k) => "'" + k + "'").join('|') + ', got ' + describe(tag));
    return check(spec.map[tag], v, p, ctx);
  }
  if (spec && typeof spec === 'object') return checkObj(spec, v, p, ctx);
  throw new Error('_buildup-shapes: bad spec at ' + p);
}
const SHAPES = {};
function def(name, out, spec) { SHAPES[name] = { out, spec }; }
function checkNamed(name, v, p, ctx) {
  const sh = SHAPES[name];
  if (!sh) return err(ctx, p, 'unknown shape ' + name);
  const prev = ctx.out;
  ctx.out = sh.out;
  check(sh.spec, v, p, ctx);
  ctx.out = prev;
}
function checkShape(name, obj) {
  if (!SHAPES[name]) return { ok: false, errors: ['(root): unknown shape ' + name] };
  const ctx = { errors: [], out: false, max: 200 };
  checkNamed(name, obj, '', ctx);
  return { ok: ctx.errors.length === 0, errors: ctx.errors };
}

// spec helpers
const arr = (item, o) => ({ $arr: item, o });
const orNull = (s) => ({ $orNull: s });
const all = (...s) => ({ $all: s });
const rec = (s, key) => ({ $rec: s, key });
const tuple = (...s) => ({ $tuple: s });
const oneOf = (field, map) => ({ $oneOf: field, map });
const pair = (t) => tuple(t, t);
// Evidence-id arrays: test-relative ids from the listed set (non-empty), or any valid ids.
function ev(allowed) {
  return function (v, p, ctx) {
    if (!Array.isArray(v)) return err(ctx, p, 'expected an array of evidence ids, got ' + describe(v));
    if (!v.length) return err(ctx, p, 'expected at least one of ' + allowed.join(', '));
    v.forEach((id, i) => { if (allowed.indexOf(id) === -1) err(ctx, p + '[' + i + ']', 'expected one of ' + allowed.join(', ') + ', got ' + describe(id)); });
  };
}
const evAny = ['evid'];
const evRelAny = ['evrel'];
// Cross-field rules
function rule(fn) { return function (v, p, ctx) { if (!isObj(v)) return; const m = fn(v); if (m) (Array.isArray(m) ? m : [m]).forEach((x) => err(ctx, x[0] ? join(p, x[0]) : p, x[1])); }; }
function sameLen(keys) {
  return rule((v) => {
    const present = keys.filter((k) => v[k] != null && (Array.isArray(v[k]) || isTyped(v[k])));
    if (!present.length) return null;
    const n = v[present[0]].length;
    const bad = present.filter((k) => v[k].length !== n);
    return bad.length ? bad.map((k) => [k, 'length ' + v[k].length + ' differs from ' + present[0] + ' (' + n + ')']) : null;
  });
}
function bound(tKey, vKey) {
  return rule((v) => {
    if (typeof v[tKey] !== 'string') return null;
    const vals = isObj(v[vKey]) ? v[vKey] : {};
    const miss = [];
    v[tKey].replace(/\{(\w+)\}/g, (_, n) => { if (!Object.prototype.hasOwnProperty.call(vals, n)) miss.push(n); return _; });
    return miss.length ? [[tKey, 'placeholder(s) {' + miss.join('}, {') + '} have no entry in ' + vKey]] : null;
  });
}
const uniqueIds = (key) => rule((v) => {
  const a = v[key]; if (!Array.isArray(a)) return null;
  const seen = new Set(); const dup = [];
  a.forEach((x) => { if (x && x.id != null) { if (seen.has(x.id)) dup.push(x.id); seen.add(x.id); } });
  return dup.length ? [[key, 'duplicate id(s) ' + dup.join(', ')]] : null;
});
const sf6 = (x) => parseFloat(x.toPrecision(6));

// ═════════════════════════════════════════════════════════════════════════════
// 3. Shapes (§3)
// ═════════════════════════════════════════════════════════════════════════════
const MODEL_KEY = "'homogeneous'|'linearBoundary'|'composite2'|'closedCircle'";
const R_STATUS = "'pass'|'fail'|'unavailable'|'n/a'";
const FLUID = "'oil'|'gas'|'water_inj'";
const QUNIT = "'STB/d'|'Mscf/d'|'bbl/d'";
const INPUT_KEY = "'h'|'phi'|'ct'|'rw'|'B'|'mu'|'q'";
const FLAG_CODE = "'valley'|'halfLate'|'earlyQuarter'|'earlyHalf'|'humpDp'|'steepStorage'|'negLate'|'fracHalf'";
const STRATUM = "'hom'|'fault'|'comp'|'closed'|'dualpor'|'channel'|'wbschange'|'partpen'|'frac'|'constp'|'interf'|'baddata'|'gas'|'inj'|'partial'";
const LCONF = { ks: 'lvl', model: 'lvl', headline: 'lvl' };
const RANK = { low: 0, medium: 1, high: 2 };

// ── common ──
def('Warning', true, { code: 'nestr', level: "'info'|'warn'|'bad'", text: 'text', ev: evAny });
def('FullySeen', true, { status: "'full'|'partial'|'not'|'n/a'", value: 'num|null', bound: "'upper'|'lower'|null", text: 'text' });
def('Zone', false, oneOf('mode', {
  device: { mode: "'device'" }, utc: { mode: "'utc'" }, fixed: { mode: "'fixed'", offset_h: 'num' }, iana: { mode: "'iana'", tz: 'nestr' } }));
def('ZoneResolved', false, oneOf('mode', { utc: { mode: "'utc'" }, fixed: { mode: "'fixed'", offset_h: 'num' }, iana: { mode: "'iana'", tz: 'nestr' } }));

// ── BuildupSpec (§3.1; input) ──
const SPEC_BASE = {
  id: 'nestr', testType: "'buildup'|'falloff'", tc_h: 'h', dtc_h: 'nonneg', pwf0: 'psia', pwf0SE: 'nonneg', dpdt_flow: 'num',
  dt: arr('dt', { asc: true, min: 1 }), p: arr('psia', { min: 1 }), n: orNull(arr('count')),
  qUnit: QUNIT, Dq: 'pos',
  fRate: (v, p, ctx) => { if (!(isNum(v) && v >= 0.9 && v <= 1)) err(ctx, p, 'expected f̂ in [0.9, 1], got ' + describe(v)); },
  rateQC: { source: "'allocation'|'table'|'measured'", r3: 'num|null', r3Status: R_STATUS, r4: 'num|null', r4Status: R_STATUS, dqKnown: 'bool',
            dqSource: "'closingDay'|'previousDay'|'qref'|'table'", equalRateAssumed: 'bool', ignoresShutin: 'bool', allocAccPct: 'nonneg' },
  well: { fluid: FLUID, h: 'pos', phi: 'phi', mu: 'pos', B: 'pos', ct: 'pos', rw: 'pos', T_R: 'num|null', re_ft: 'pos|null', defaulted: ['nestr'] },
  gas: orNull({ sg: 'pos', T_F: 'num', co2: 'nonneg', h2s: 'nonneg', n2: 'nonneg', pseudoTime: 'bool', pdew: 'psia|null' }),
  sigma_psi: 'nonneg', sigmaFlow_psi: 'nonneg', sigmaLF_psi: 'nonneg|null', dtSample_h: 'pos', driftPsiPerDay: 'nonneg',
  history: { estimated: 'bool', tPrepend_h: 'nonneg', source: "'data'|'date'|'cum'|'default'" },
  overrides: { window: orNull({ dt0_h: 'dt', dt1_h: 'dt' }), model: MODEL_KEY + '|null', excludeRivals: [MODEL_KEY] },
  opts: { Lcyc: 'pos', binsPerCycle: 'count', fitBinsPerCycle: 'count', rivals: "'auto'|'none'|'all'", cheld: "'auto'|'off'|'extended'", tide: "'auto'|'off'" },
};
def('BuildupSpec', false, all(
  Object.assign({}, SPEC_BASE, { steps: arr({ t: 'h', q: 'nonneg' }, { min: 2 }) }),
  sameLen(['dt', 'p', 'n']),
  rule((v) => {
    const s = v.steps; if (!Array.isArray(s) || !s.length) return null;
    const out = [];
    for (let i = 1; i < s.length; i++) if (s[i] && s[i - 1] && isNum(s[i].t) && isNum(s[i - 1].t) && !(s[i].t > s[i - 1].t)) out.push(['steps[' + i + '].t', 'steps not strictly ascending']);
    const last = s[s.length - 1];
    if (last && last.q !== 0) out.push(['steps[' + (s.length - 1) + '].q', 'the last step must be q = 0 (closing)']);
    if (last && isNum(last.t) && isNum(v.tc_h) && Math.abs(last.t - v.tc_h) > 1e-6) out.push(['steps[' + (s.length - 1) + '].t', 'the last step must sit at tc_h (' + v.tc_h + ' h), got ' + last.t]);
    return out.length ? out : null;
  })));
// Stored form (TestEntry.spec): steps → stepRef {from, to} into analysis.rates.steps; dt, p, n at 6 significant figures.
def('BuildupSpecStored', false, all(
  Object.assign({}, SPEC_BASE, { stepRef: all({ from: 'count', to: 'count' }, rule((v) => (isNum(v.from) && isNum(v.to) && v.to < v.from) ? [['to', 'stepRef.to < stepRef.from']] : null)) }),
  sameLen(['dt', 'p', 'n']),
  rule((v) => {
    const out = [];
    ['dt', 'p'].forEach((k) => { if (Array.isArray(v[k])) { const i = v[k].findIndex((x) => isNum(x) && x !== sf6(x)); if (i !== -1) out.push([k + '[' + i + ']', 'stored value not at 6 significant figures']); } });
    if (Object.prototype.hasOwnProperty.call(v, 'steps')) out.push(['steps', 'the stored form replaces steps with stepRef']);
    return out.length ? out : null;
  })));

// ── ModelFit, KHeld, Reach (§3.1; outputs) ──
// PRiSM model parameters: numbers, or the categorical values PRiSM keeps in params (33 toModelParams copies the
// registry's fixed keys, e.g. linearBoundary BC 'noflow'|'constP'), so a rival fit restores in PRiSM unchanged.
const MODEL_PARAMS = rec('num|nestr|bool');
// se / ci95: k, S and C always present (each may be null in an output); other keys open.
const SE_MAP = all({ k: 'nonneg', S: 'nonneg', C: 'nonneg' }, rec('nonneg'));
const CI_MAP = all({ k: orNull(pair('num')), S: orNull(pair('num')), C: orNull(pair('num')) }, rec(orNull(pair('num'))));
def('ModelFit', true, {
  key: MODEL_KEY, base: 'nestr', ok: 'bool', converged: 'bool', stopReason: 'str', iterations: 'count', slices: 'count', nEval: 'count',
  phys: { k: 'pos', S: 'num', C: 'pos', 'M?': 'pos', 'F?': 'pos', 'R_ft?': 'pos', 'dF_ft?': 'pos', 're_ft?': 'pos' },
  params: MODEL_PARAMS, se: SE_MAP, ci95: CI_MAP, corr: { CS: 'num', kS: 'num' },
  ssrLog: 'nonneg', nDp: 'count', rmseDp: 'nonneg', bic: 'num', p: 'count', eligible: 'bool', why: ['text'], fullySeen: '@FullySeen',
});
def('KHeld', true, {
  k: 'pos', delta: 'nonneg', fit: '@ModelFit', refits: arr({ f: 'pos', S: 'num', C: 'pos' }), S_k: 'nonneg', S_kAnalytic: 'nonneg',
  corrCS: 'num', rmsRatio: 'nonneg', converged: 'bool', ev: ev(['M8']),
});
def('Reach', true, {
  t10_h: 'nonneg', t5_h: 'nonneg', fair_h: 'nonneg', good_h: 'nonneg', fairShut_h: 'nonneg|null', goodShut_h: 'nonneg|null', reachable: 'bool', ev: ev(['W4']),
});

// ── BuildupResult (§3.1; output) ──
// X0, X1 are log10 Δt_e (cycles = X1 − X0); bins.X is ln Δt_e (D6).
def('Iarf', true, {
  found: 'bool', grade: "'good'|'fair'|'none'", noiseWidened: 'bool', status: "'ok'|'tooShort'|'expectedNotFound'",
  dt0_h: 'dt', dt1_h: 'dt', X0: 'num', X1: 'num', cycles: 'nonneg', level_psi: 'psi', slope: 'num', slopeSE: 'nonneg', slopeLast: 'num', slopeLastSE: 'nonneg',
  band: 'nonneg', slopeTol: 'nonneg', noiseLimited: 'bool', pointSkin: { spread: 'nonneg', min: 'num', max: 'num' },
  longest: orNull({ dt0_h: 'dt', dt1_h: 'dt', cycles: 'nonneg' }),
  secondLevel: orNull({ dt0_h: 'dt', dt1_h: 'dt', level_psi: 'psi', ratio: 'pos' }),
  laterPlateaus: arr({ dt0_h: 'dt', dt1_h: 'dt', level_psi: 'psi' }), forced: 'bool', reason: 'text', ev: ev(['I1', 'I2', 'I3', 'I4', 'I6']),
});
def('Line', true, {
  method: "'superposition'|'horner'", k: 'pos', kh: 'pos', S: 'num', m: 'num', pStar: 'psia', pStarRange: orNull({ lo: 'psia', hi: 'psia' }), p1hr: 'psia',
  r2: 'num', dt0_h: 'dt', dt1_h: 'dt', n: 'count',
  shifts: arr({ dX: 'num', dt0_h: 'dt', dt1_h: 'dt', S: 'num', bS: 'num|null' }, { max: 2 }),   // dX in log10 cycles (− = earlier)
  plateauCheck: { khDiffPct: 'pct', dS: 'num', pass: 'bool' }, ev: ev(['L1', 'L2', 'L3']),
});
def('Confidence', true, all({
  ks: 'lvl', model: 'lvl', headline: 'lvl', stage: "'pass1'|'final'",
  reasons: arr({ rule: 'ruleK', kind: "'low'|'cap'|'unmet'", text: 'text', ev: evRelAny }),
  rates: orNull({ ks: { rate: 'frac', lo: 'frac', hi: 'frac' }, headline: { rate: 'frac', lo: 'frac', hi: 'frac' } }),
  outsideCalibration: 'bool', calVersion: 'str|null', calibrated: 'bool', ev: ev(['K1', 'K2']),
}, rule((v) => {
  if (!(v.ks in RANK) || !(v.model in RANK) || !(v.headline in RANK)) return null;
  const out = [];
  if (RANK[v.model] > RANK[v.ks]) out.push(['model', 'the model label (K2) is never above the k/S label (K1)']);
  const min = RANK[v.ks] < RANK[v.model] ? v.ks : v.model;
  if (v.headline !== min) out.push(['headline', 'headline must be min(ks, model) = ' + min]);
  return out.length ? out : null;
})));
def('EvidenceVector', true, {
  grade: "'good'|'fair'|'none'", noiseWidened: 'bool', span: 'nonneg', pointSkinSpread: 'nonneg', agree: 'bool', agreeMode: "'raw'|'bias'|'none'",
  dkPct: 'pct', dS: 'num', sErr: 'nonneg', sErrMode: "'line'|'kHeld'|'model'", unitSlope: 'bool', cheldRejectedBoth: 'bool',
  rateSource: "'allocation'|'table'|'measured'", r3: 'num', r3Status: R_STATUS, r4: 'num', r4Status: R_STATUS, dqKnown: 'bool', fRate: 'pos',
  equalRateAssumed: 'bool', snrD: 'nonneg', rDrift: 'nonneg', rTide: 'nonneg', tideRemoved: 'bool', flags: [FLAG_CODE],
  distractorAtOrBeforeIarf: 'bool', humpAfterIarf: 'bool', dtEnd_h: 'dt', dteEnd_h: 'dt', t10_h: 'nonneg', t5_h: 'nonneg',
  historySensitive: 'bool', outsideEnvelope: 'bool', kHeld: 'bool', kHeldConverged: 'bool|null', kHeldCorrCS: 'num', kHeldRmsRatio: 'nonneg',
  partialSuspect: 'bool|null', windowLevelInconsistent: 'bool|null', chosenKey: MODEL_KEY, chosenFullySeen: "'full'|'partial'|'not'|'n/a'",
  triggers: ["'T-up'|'T-down'|'T-level'|'T-none'"], dBicChosen: 'num', dBicNext: 'num', boundaryDepends: 'bool|null',
});
def('BuildupResult', true, all({
  ok: 'bool', id: 'nestr', version: 'nestr', inputHash: 'hex16', testType: "'buildup'|'falloff'", reason: 'upper|null',
  bins: all({ dt: arr('dt!', { asc: true }), 'dte?': arr('dt!', { asc: true }), dp: arr('psi!'), n: arr('count!'), deriv: arr('psi'), full: ['bool'], 'X?': arr('num!') },
            sameLen(['dt', 'dte', 'dp', 'n', 'deriv', 'full', 'X']),
            rule((v) => {
              if (!Array.isArray(v.full) || !Array.isArray(v.deriv)) return null;
              const i = v.full.findIndex((f, j) => f === false && v.deriv[j] !== null);
              return i === -1 ? null : [['deriv[' + i + ']', 'masked entry (full = false) must be null']];
            })),
  quality: { sigma_psi: 'nonneg', sigmaFlow_psi: 'nonneg', sigmaD_psi: 'nonneg', snrD: 'nonneg', rDrift: 'nonneg', rTide: 'nonneg|null', tideRemoved: 'bool',
             tideFit: "'none'|'M2'|'M2K1'", ev: ev(['I5', 'Q5', 'Q6']) },
  storage: { unitSlope: 'bool', C_us: 'pos|null', tHump_h: 'dt|null', humpRatio: 'nonneg|null', seed: orNull({ tUs_h: 'dt', tHump_h: 'dt' }),
             humpConsistent: 'bool|null', ev: ev(['W1', 'W2', 'W3']) },
  reach: '@Reach',
  iarf: '@Iarf',
  line: orNull('@Line'),
  triggers: { up: 'bool', down: 'bool', level: 'bool', none: 'bool', noneSkipped: 'bool', fired: ["'T-up'|'T-down'|'T-level'|'T-none'"], ev: ev(['M2']) },
  flags: arr({ code: FLAG_CODE, dt0_h: 'dt', dt1_h: 'dt', text: 'text' }),
  models: arr('@ModelFit'),
  bic: all({ n: 'count', nEff: 'nonneg', rho1: 'num', tau: 'nonneg', basis: "'logDp'", floorUsed: 'bool',
             rows: arr({ key: MODEL_KEY, bic: 'num', dBicHom: 'num', p: 'count', eligible: 'bool', why: ['text'] }), chosen: MODEL_KEY, margin: 'num|null', ev: ev(['M4']) },
            rule((v) => {
              if (!Array.isArray(v.rows) || !v.rows.length) return null;
              const keys = v.rows.map((r) => r && r.key);
              if (new Set(keys).size !== keys.length) return [['rows', 'duplicate model rows']];
              if (keys.indexOf(v.chosen) === -1) return [['chosen', 'chosen model has no BIC row']];
              const hom = v.rows.find((r) => r && r.key === 'homogeneous');
              if (hom && hom.dBicHom !== 0 && hom.dBicHom !== null) return [['rows', 'homogeneous row must have dBicHom = 0']];
              return null;
            })),
  chosen: { key: MODEL_KEY, label: "'Homogeneous'|'Sealing fault'|'Radial composite'|'Closed circle'", fullySeen: '@FullySeen', reason: 'text', ev: ev(['M6', 'M5']) },
  agreement: { agree: 'bool', mode: "'raw'|'bias'|'none'", dkPct: 'pct', dS: 'num', biasKPct: 'pct|null', biasDS: 'num|null', ev: ev(['A1']) },
  final: { k: 'pos', kh: 'pos', S: 'num', C: 'pos', source: "'match'|'line'|'model'|'kHeld'", m: 'num', mPrime: 'num', pStar: 'psia|null',
           pStarRange: orNull({ lo: 'psia', hi: 'psia' }), pExt: 'psia|null', pExtKind: "'pStar'|'pbar'", piModel: 'psia|null',
           rinv_ft: 'nonneg', rinvE_ft: 'nonneg', dpSkin_psi: 'psi', distances: { 'dF_ft?': 'pos', 'R_ft?': 'pos', 're_ft?': 'pos' },
           minFaultDist_ft: 'nonneg|null', gas: orNull({ Sprime: 'num', dmSkin: 'num', dpSkin_psi: 'psi' }), ev: ev(['A2']) },
  cheld: { triggered: 'bool', mode: "'pair'|'extended'", refits: arr({ f: 'pos', k: 'pos', S: 'num', C: 'pos', dBic: 'num', rejected: 'bool' }),
           range: { C: pair('pos'), k: pair('pos'), S: pair('num') }, S_C: 'nonneg', meaningful: 'bool', ev: ev(['C1']) },
  sErr: { value: 'nonneg', mode: "'line'|'kHeld'|'model'", floor: 'nonneg', seS: 'nonneg', dLineMatch: 'nonneg', sWin: 'nonneg', sTc: 'nonneg', sPwf: 'nonneg', sK: 'nonneg',
          driver: "'floor'|'se'|'lineMatch'|'window'|'tc'|'pwf'|'kHeld'", ext: { value: 'nonneg', S_C: 'nonneg' }, sSens: 'nonneg', sAbs: 'nonneg', ev: ev(['U1']) },
  sensitivity: { req: arr({ input: INPUT_KEY, f: 'pos', k: 'pos', S: 'num', dkPct: 'pct', dS: 'num' }), typ: arr({ input: INPUT_KEY, f: 'pos', k: 'pos', S: 'num', dkPct: 'pct', dS: 'num' }),
                 dominantK: { req: INPUT_KEY, typ: INPUT_KEY }, dominantS: { req: INPUT_KEY, typ: INPUT_KEY }, sSens: 'nonneg', muNoEffectOnS: 'true', ev: ev(['U2', 'U3']) },
  history: { estimated: 'bool', dDerivPct: 'pct|null', sensitive: 'bool', ev: ev(['R5']) },
  background: orNull({ applied: 'bool', slopeSource: "'pstar'|'drift'", boundaryDepends: 'bool', ev: ev(['M7']) }),
  kHeld: orNull('@KHeld'),
  confidence: '@Confidence',
  'curves?': { dt: arr('dt!'), hom: { dp: arr('psi'), deriv: arr('psi') }, chosen: orNull({ dp: arr('psi'), deriv: arr('psi') }) },
  fitC4: orNull({ modelKey: 'nestr', params: MODEL_PARAMS, phys: rec('num'), 'r2?': 'num', 'converged?': 'bool', 'ci95?': 'obj' }),
  warnings: arr('@Warning'),
  'evidence?': '@EvidenceVector',
}, rule((v) => (Array.isArray(v.models) && v.models.length && v.models[0] && v.models[0].key !== 'homogeneous') ? [['models[0].key', 'homogeneous comes first in models']] : null)));

// ── Data layer (§3.6; outputs) ──
def('GaugeRecord', true, all({
  ok: 'true', origin_ms: 'ms!', t: arr('ms!', { typed: true, asc: true, min: 1 }), p: arr('psia!', { typed: true }), T: orNull(arr('num!', { typed: true })),
  n: 'count!', source: "'csv'|'paste'|'historian'|'prism'|'demo'", name: 'str', zone: '@ZoneResolved', pUnitIn: 'nestr', patm: 'pos', elapsed: 'bool',
  rollup: 'bool', hash: 'hex16', warnings: arr('@Warning'),
}, sameLen(['t', 'p', 'T']), rule((v) => {
  const out = [];
  if (v.t && isNum(v.n) && v.t.length !== v.n) out.push(['n', 'n must equal t.length (' + v.t.length + ')']);
  if (v.t && v.t.length && v.origin_ms !== v.t[0]) out.push(['origin_ms', 'origin_ms must be the first sample time t[0]']);
  return out.length ? out : null;
})));
def('QC', true, {
  ok: 'bool', n: 'count', dtMed_s: 'nonneg', dtP05_s: 'nonneg', dtP95_s: 'nonneg', sigma_psi: 'nonneg', sigmaFlow_psi: 'nonneg', sigmaShut_psi: 'nonneg',
  segments: arr({ t0_ms: 'ms!', t1_ms: 'ms!', kind: "'flow'|'shut'", sigma: 'nonneg' }),
  resolution_psi: 'nonneg|null', resolutionLimited: 'bool', rho1: 'num', noiseCorrelated: 'bool',
  gaps: arr({ t0_ms: 'ms!', t1_ms: 'ms!', dur_h: 'nonneg' }), gapCount: 'count', gapTotal_h: 'nonneg', longestGap_h: 'nonneg',
  spikes: { count: 'count', mode: "'off'|'flag'|'filter'", idx: arr('count!', { max: 200 }) },
  depth: { applied: 'bool', shift_psi: 'psi' }, temperature: { present: 'bool', fastChanges: arr({ t_ms: 'ms!', dT_F: 'num' }) },
  plausibility: arr('@Warning'), ev: ev(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q7', 'Q8']),
});
def('Event', true, all({
  id: 'eventId', kind: "'shutin'|'falloff'|'partial'|'substep'",
  status: "'analysable'|'too_short'|'gap_at_closing'|'partial'|'excluded'|'not_confirmed'|'intervention'",
  tc_ms: 'ms!', dtc_s: 'nonneg', j0: 'count', j1: 'count', pwf0: 'psia', pwf0SE: 'nonneg',
  trend: { a: 'psia', b: 'num', ref_ms: 'ms', n: 'count', sigmaRes: 'nonneg' },
  rise_psi: 'psi', riseScale_min: 'nonneg', Ts_psi: 'nonneg', tEnd_ms: 'ms', dtEnd_h: 'nonneg', endReason: "'reopen'|'gap'|'data_end'",
  ramp: { present: 'bool', dur_s: 'nonneg' }, fhat: 'num|null', fhatMethod: "'derivRatio'|'dpDiff'|'allocation'|'proxy'|null",
  qBefore: 'nonneg|null', qAfter: 'nonneg|null',
  alloc: { date: 'date', ratio: 'num|null', pass: 'bool|null', ignoresShutin: 'bool', confirm: "'confirmed'|'not_confirmed'|'no_alloc'|'n/a'" },
  manual: 'bool', ev: ev(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']), warnings: arr('@Warning'),
}, rule((v) => (isNum(v.j0) && isNum(v.j1) && v.j1 < v.j0) ? [['j1', 'j1 (first shut-in sample) must not precede j0']] : null)));
def('Missed', true, {
  subThreshold: arr({ t_ms: 'ms!', dp_psi: 'psi', dur_h: 'nonneg' }), allocOnly: arr({ date: 'date', ratio: 'num' }), gaps: arr({ t0_ms: 'ms!', t1_ms: 'ms!' }),
  detectability: { ok: 'bool', pStarMinusPwf_psi: 'psi|null', Ts_psi: 'nonneg' }, tooShort: ['eventId'], interventions: ['eventId'], ev: ev(['D1']),
});
def('AllocRow', true, { date: 'date', oil: 'nonneg|null', gas: 'nonneg|null', water: 'nonneg|null', hours: 'nonneg|null' });
const R3OBJ = orNull({ ratio: 'num', tol: 'nonneg', pass: 'bool|null', status: R_STATUS });
def('RateHistory', true, all({
  mode: "'daily'|'table'", unit: QUNIT, phase: "'oil'|'gas'|'gasEq'|'total_rb'|'water_inj'",
  days: arr({ date: 'date', t0_ms: 'ms!', t1_ms: 'ms!', hours: 'nonneg', hOn: 'nonneg', V: 'nonneg', q: 'nonneg', cls: "'clean'|'event'|'gap'|'flush'|'shut'",
              events: ['eventId'], pwfMean_psia: 'psia|null', pwfMeanDatum_psia: 'psia|null', R3: R3OBJ,
              R4: orNull({ ratio: 'num', pass: 'bool|null', status: R_STATUS }), R6: orNull({ reported: 'nonneg|null', detected: 'nonneg', flag: 'bool' }),
              ignoresShutin: 'bool', equalRateAssumed: 'bool', shortDay: 'bool' }),
  steps: arr({ t_ms: 'ms!', q: 'nonneg' }, { min: 1 }),
  start: { source: "'data'|'date'|'cum'|'default'", prepend_h: 'nonneg', q: 'nonneg', flag: 'bool' },
  offsetScan: { current_h: 'num', best_h: 'num', better: 'bool', improvement: 'num' },
  phaseBasis: { used: "'oil'|'total'|'gas'|'gasEq'", wcMax: 'frac|null', gorRatioMax: 'nonneg|null', twoPhaseCt: 'bool' },
  ev: ev(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']), warnings: arr('@Warning'),
}, rule((v) => {
  const s = v.steps; if (!Array.isArray(s)) return null;
  for (let i = 1; i < s.length; i++) if (s[i] && s[i - 1] && !(s[i].t_ms > s[i - 1].t_ms)) return [['steps[' + i + '].t_ms', 'steps not strictly ascending']];
  return null;
})));

// ── Pipeline input / output (§3.7) ──
def('WellInput', false, {
  fluid: FLUID, h: 'pos', phi: 'phi', mu: 'pos', B: 'pos', ct: 'pos', rw: 'pos', re_ft: 'pos|null', Pb: 'psia|null', Rs: 'nonneg|null',
  gas: orNull({ sg: 'pos', T_F: 'num', co2: 'nonneg', h2s: 'nonneg', n2: 'nonneg', pseudoTime: 'bool', pdew: 'psia|null', apiCond: 'num|null', Mo: 'pos|null' }),
  Bw: 'pos', muw: 'pos', allocAccPct: 'nonneg', driftPsiPerDay: 'nonneg', defaulted: ['nestr'],   // any WellInput / gas key name
  sens: { h: 'nonneg', phi: 'nonneg', ct: 'nonneg', rw: 'nonneg', B: 'nonneg', mu: 'nonneg', q: 'nonneg' },
});
def('Completion', false, { hp_ft: 'pos', htop_ft: 'nonneg', theta_deg: 'nonneg', kvkh: pair('pos'), perf: orNull({ spf: 'pos', lp_in: 'pos', rp_in: 'pos', phase_deg: 'nonneg' }) });
def('Depth', false, { gaugeTVD: 'num', datumTVD: 'num', grad: 'nonneg', gradFlow: 'nonneg|null' });
def('Settings', false, {
  detect: { winMin: 'pos', riseMin: 'pos', riseSig: 'pos', persistMin: 'pos', minDur_h: 'pos', gapN: 'pos', spike: "'off'|'flag'|'filter'", partial: 'bool' },
  // band and slope are fractions (band 0.10 = the 10 % of bu_i_band; the page divides the % control by 100)
  interp: { Lcyc: 'pos', band: 'pfrac', slope: 'pfrac', minCycles: 'pos', rivals: "'auto'|'none'|'all'", cheld: "'auto'|'off'|'extended'", kHeld: "'auto'|'off'", tide: "'auto'|'off'" },
  trend: { baseN: 'count', delta: 'pos', abs: 'num', basevar: 'bool', confirm: "'next'|'immediate'", price: 'nonneg|null', enabled: "'auto'|'on'|'off'" },
  report: { detail: "'selected'|'all'" },
});
// target is null only for kind 'event_add' (a typed time or a missed-list entry has no E id yet; the next Analyse assigns one).
def('Override', false, all({
  id: 'ovId', kind: "'exclude'|'include'|'window'|'model'|'event_add'|'event_drop'|'tc'", target: 'targetId|null', value: 'any',
  reason: (v, p, ctx) => { if (!(typeof v === 'string' && v.trim().length >= 5 && v.length < 300)) err(ctx, p, 'expected a reason of at least 5 characters'); },
  who: 'str', at: 'iso', appVersion: 'str',
}, rule((v) => (v.target === null && v.kind !== 'event_add') ? [['target', "only an 'event_add' override may have target null"]] : null)));
const META = { wellName: 'str', engineer: 'str', appVersion: 'str' };
def('AnalysisInput', false, {
  record: '@GaugeRecord|null',
  stored: orNull({ events: arr('@Event'), rates: '@RateHistory', qc: '@QC', tests: arr({ id: 'testId', eventId: 'eventId', spec: '@BuildupSpecStored' }) }),
  allocation: orNull({ rows: arr('@AllocRow'), gUnit: "'Mscf'|'MMscf'|'Sm3'", resolution: { oil: 'nonneg|null', gas: 'nonneg|null', water: 'nonneg|null' } }),
  rateTable: orNull(arr({ t_ms: 'ms', q: 'nonneg' })),
  well: '@WellInput', completion: '@Completion|null', depth: '@Depth|null',
  history: { mode: "'unknown'|'date'|'cum'", date: 'date|null', cum: 'nonneg|null' },
  zones: { gauge: '@Zone', day: { zone: '@Zone', startHour: (v, p, ctx) => { if (!(Number.isInteger(v) && v >= 0 && v <= 23)) err(ctx, p, 'expected an hour 0–23'); } } },
  settings: '@Settings', overrides: arr('@Override'), workovers: ['date'], meta: META,
});
def('TestEntry', true, all({
  id: 'testId', eventId: 'eventId', date: 'date', tc_ms: 'ms!', dtEnd_h: 'dt', Dq: 'pos', qUnit: QUNIT,
  pwf0: 'psia', pwf0Datum: 'psia', pStarDatum: 'psia|null', pExtDatum: 'psia|null',
  status: "'interpreted'|'excluded'|'not_analysable'|'failed'", statusReason: 'text|null',
  spec: '@BuildupSpecStored', result: '@BuildupResult|null', used: { baseline: 'bool', trend: 'bool', alert: 'bool' }, partialSuspect: 'bool', overrides: ['ovId'],
}, rule((v) => (v.result && v.result.id !== undefined && v.result.id !== v.id) ? [['result.id', 'result.id must equal the test id']] : null)));
def('Analysis', true, all({
  ok: 'bool', version: 'nestr', appVersion: 'str', runAt: 'iso', inputHash: 'hex16', resultHash: 'hex16',
  meta: META, well: '@WellInput', completion: '@Completion|null', depth: '@Depth|null', settings: '@Settings',
  zones: { gauge: '@ZoneResolved', day: { zone: '@ZoneResolved', startHour: 'count' } },
  record: { name: 'str', source: "'csv'|'paste'|'historian'|'prism'|'demo'", n: 'count', origin_ms: 'ms!', end_ms: 'ms!', hash: 'hex16', reduced: 'false', rawStored: "'idb'|'memory'|'none'" },
  qc: '@QC', events: arr('@Event'), missed: '@Missed', rates: '@RateHistory',
  baseline: orNull({ k: 'pos', cvK: 'nonneg', kh: 'pos', tests: ['testId'] }),
  tests: arr('@TestEntry'), trend: '@Trend', overrides: arr('@Override'),
  stats: { evals: 'count', fits: 'count', slices: 'count', ms: 'nonneg|null' }, warnings: arr('@Warning'),
}, uniqueIds('tests'), uniqueIds('events'), uniqueIds('overrides'), rule((v) => {
  if (!Array.isArray(v.tests)) return null;
  const out = [];
  const evIds = new Set((v.events || []).map((e) => e && e.id));
  const ovIds = new Set((v.overrides || []).map((o) => o && o.id));
  const tIds = new Set(v.tests.map((t) => t && t.id));
  const steps = v.rates && Array.isArray(v.rates.steps) ? v.rates.steps : null;
  const series = v.trend && Array.isArray(v.trend.series) ? v.trend.series : [];
  v.tests.forEach((t, i) => {
    if (!t) return;
    if (!evIds.has(t.eventId)) out.push(['tests[' + i + '].eventId', 'no event ' + t.eventId + ' in events']);
    (t.overrides || []).forEach((o, j) => { if (!ovIds.has(o)) out.push(['tests[' + i + '].overrides[' + j + ']', 'no override ' + o]); });
    const sr = t.spec && t.spec.stepRef;
    if (steps && sr && isNum(sr.to)) {
      if (sr.to >= steps.length) out.push(['tests[' + i + '].spec.stepRef.to', 'beyond rates.steps']);
      else if (steps[sr.to].q !== 0 || steps[sr.to].t_ms !== t.tc_ms) out.push(['tests[' + i + '].spec.stepRef.to', 'must index the q = 0 step at tc_ms']);
    }
    const s = series.find((x) => x && x.id === t.id);
    if (s && s.used && t.used && (s.used.baseline !== t.used.baseline || s.used.trend !== t.used.trend || s.used.alert !== t.used.alert)) out.push(['tests[' + i + '].used', 'must be copied from trend.series[].used']);
  });
  (v.baseline && Array.isArray(v.baseline.tests) ? v.baseline.tests : []).forEach((id, j) => { if (!tIds.has(id)) out.push(['baseline.tests[' + j + ']', 'unknown test ' + id]); });
  series.forEach((s, j) => { if (s && !tIds.has(s.id)) out.push(['trend.series[' + j + '].id', 'unknown test ' + s.id]); });
  return out.length ? out : null;
})));

// ── Trend (§3.8) ──
def('TrendTest', true, {
  id: 'testId', t_ms: 'ms!', tDays: 'num', date: 'date', S: 'num', Serr: 'nonneg', SerrExt: 'nonneg', SerrMode: "'line'|'kHeld'|'model'",
  k: 'pos', kh: 'pos', C: 'pos', m: 'num', mPrime: 'num', pStarDatum: 'psia|null', pStarRangeDatum: orNull({ lo: 'psia', hi: 'psia' }),
  pExtDatum: 'psia|null', pExtKind: "'pStar'|'pbar'", piModelDatum: 'psia|null', pwf0Datum: 'psia', Dq: 'pos', qUnit: QUNIT, rinv_ft: 'nonneg',
  dpSkin_psi: 'psi', conf: LCONF, chosen: MODEL_KEY, fullySeen: "'full'|'partial'|'not'|'n/a'", kHeld: 'bool', excluded: 'bool', excludedReason: 'text|null',
  gasSprime: 'num|null', partialSuspect: 'bool', iarfDt0_h: 'dt|null', dtEnd_h: 'dt', dteEnd_h: 'dt', reachFair_h: 'nonneg', reachGood_h: 'nonneg',
  reachFairShut_h: 'nonneg|null', reachGoodShut_h: 'nonneg|null', bins: all({ dte: arr('dt!'), dp: arr('psi!') }, sameLen(['dte', 'dp'])),
});
const ALERT_STATUS = "'none'|'possible'|'provisional'|'confirmed'";
def('Trend', true, {
  ok: 'bool', n: 'count', nUsed: 'count', enabled: 'bool', disabledReason: 'text|null',
  baseline: { S: 'num', sigma: 'nonneg', tests: ['testId'], unstable: 'bool', provisional: 'bool', segments: arr({ from: 'date', S: 'num', tests: ['testId'] }), ev: ev(['T1']) },
  series: arr({ id: 'testId', tDays: 'num', S: 'num', Serr: 'nonneg', k: 'pos', pExt: 'psia|null', pwf0Datum: 'psia', Smech: 'num|null', SmechErr: 'nonneg|null', Sd: 'num|null',
                conf: LCONF, used: { baseline: 'bool', trend: 'bool', alert: 'bool' } }),
  excludedLow: { n: 'count', ids: ['testId'], S: orNull(pair('num')), ev: ev(['T16']) },
  alerts: {
    delta: { threshold: 'num', form: "'plain'|'basevar'", raisedAt: 'testId|null', confirmedAt: 'testId|null', status: ALERT_STATUS, kHeldOnly: 'bool', inputRobust: 'true', ev: ev(['T2']) },
    absolute: { threshold: 'num', basis: "'mechanical'|'total'", raisedAt: 'testId|null', confirmedAt: 'testId|null', status: ALERT_STATUS, kHeldOnly: 'bool',
                robustness: { lo: 'testId|null', hi: 'testId|null', unchanged: 'bool' }, ev: ev(['T3']) },
  },
  onset: { tauDays: 'num|null', interval: orNull(pair('num')), date: 'date|null', model: "'hinge'|'constant'|'line'", cusum: { alarmAt: 'testId|null', onsetAt: 'testId|null' },
           indicative: 'bool', ev: ev(['T4']) },
  recent: { slopePer30d: 'num', ci: pair('num'), mkZ: 'num', mkP: 'frac', n: 'count', indicative: 'bool', wlsSlopePer30d: 'num', disagree: 'bool', ev: ev(['T5']) },
  forecast: { show: 'bool', date: 'date|null', earliest: 'date|null', latest: 'date|null', reason: 'text', ev: ev(['T6']) },
  skinDp: arr({ id: 'testId', dpSkin_psi: 'psi' }),
  pi: { X: 'num', re_ft: 'pos', reSource: "'input'|'rinv'", ratioNow: 'num', ratioBase: 'num', ratioLowerBound: 'bool', rateAtStake: 'num', rateUnit: 'nestr',
        extraDrawdown_psi: 'psi', cumAtStake: 'num', cumUnit: 'nestr', atStakeUpperBound: 'bool', value: 'num|null', guard: 'bool', ev: ev(['T8']) },
  kStability: { cv: 'nonneg', stable: 'bool', allocAccPct: 'nonneg', reading: "'nearWell'|'mobility'|'none'|'allocation'", ev: ev(['T9']) },
  pTrend: { quantity: "'pStar'|'pbar'", assessable: 'bool', reason: 'text|null', slopePer30d: 'num', scatter: 'nonneg', depletion: 'bool|null', label: 'text', ev: ev(['T10']) },
  modelFree: arr({ id: 'testId', refId: 'testId', dS: 'num', fittedDS: 'num', agrees: 'bool' }),
  bubble: { rows: arr({ id: 'testId', pwfSand_lo: 'psia', pwfSand_hi: 'psia', margin: 'psi', level: "'ok'|'minor'|'major'|'critical'" }), spearman: 'num|null', ev: ev(['T12']) },
  piCheck: { available: 'bool', reason: 'text|null', rows: arr({ from: 'nestr', to: 'nestr', RJ: 'num' }), consistent: 'bool|null', rho: 'num|null', ev: ev(['T13']) },
  mech: { available: 'bool', Sgeo: 'num', SgeoRange: pair('num'), basis: "'pressureDrop'", ev: ev(['T14']) },
  rateSkin: { resolved: 'bool', S: 'num', D: 'num', seD: 'nonneg', reason: 'text', dqEffect: 'num|null', ev: ev(['T15']) },
  crossTest: { windowLevelInconsistent: ['testId'], closedWithoutDepletion: ['testId'] },
  recommendations: arr({ code: 'nestr', text: 'text600', ev: evAny }),
  limitations: arr({ code: 'nestr', text: 'text600' }),
});

// ── Review (§3.10) ──
def('Value', true, { v: 'num|str|null', cat: 'str|null', dp: 'count!', ref: 'ref' });
const VALUES = rec('@Value');
def('Finding', true, all({
  id: 'findId', rule: 'ruleV', severity: "'critical'|'major'|'minor'|'suggestion'", acceptable: 'bool', where: "'any'|'S1'|'S2'|'S3'|'S4'|'S5'|'S6'|'S7'|'S8'|'S9'|'S10'|'S11'|'S12'",
  template: 'tmpl', values: VALUES, ev: evAny, check: { ok: 'bool', failures: ['any'] },
  decision: orNull({ d: "'accept'|'reject'|'note'", note: 'text600|null', who: 'str', at: 'iso' }),
}, bound('template', 'values'), rule((v) => (v.rule === 'V14' && v.acceptable !== false) ? [['acceptable', 'a V14 finding is never acceptable']] : null)));
def('Review', true, all({
  version: 'nestr', at: 'iso', findings: arr('@Finding'), counts: { critical: 'count', major: 'count', minor: 'count', suggestion: 'count' },
  evidenceCheck: { ok: 'bool', nChecked: 'count', nFailed: 'count' }, inputHash: 'hex16', resultHash: 'hex16',
}, uniqueIds('findings'), rule((v) => {
  if (!Array.isArray(v.findings) || !isObj(v.counts)) return null;
  const c = { critical: 0, major: 0, minor: 0, suggestion: 0 };
  v.findings.forEach((f) => { if (f && f.severity in c) c[f.severity]++; });
  const bad = Object.keys(c).filter((k) => v.counts[k] !== c[k]);
  return bad.length ? bad.map((k) => ['counts.' + k, 'expected ' + c[k] + ' (from findings)']) : null;
})));
const INTENT = "'why_model'|'why_conf'|'whatif_input'|'onset'|'alert'|'value'|'compare'|'excluded'|'shutin_length'|'stake'|'kstable'|'serr'|'line_vs_match'|'bubble'|'forecast'|'mech'|'depletion'|'missed'|'help'";
def('Answer', true, all({
  q: 'str', intent: INTENT, template: 'tmpl', values: VALUES, ev: evAny, grounded: "'full'|'partial'|'none'", check: { ok: 'bool', failures: ['any'] }, followUps: ['text'],
}, bound('template', 'values'), rule((v) => (v.intent === 'help' && isObj(v.values) && Object.keys(v.values).length) ? [['values', 'help quotes no numbers']] : null)));
const VAL_OR_TMPL = (v, p, ctx) => {
  if (isObj(v) && typeof v.template === 'string') return check(all({ template: 'tmpl', values: VALUES }, bound('template', 'values')), v, p, ctx);
  return checkNamed('Value', v, p, ctx);
};
def('Block', true, oneOf('kind', {
  verdict: all({ kind: "'verdict'", level: "'ok'|'warn'|'bad'", template: 'text', values: VALUES, ev: evAny }, bound('template', 'values')),
  kv: { kind: "'kv'", rows: arr({ label: 'text', value: VAL_OR_TMPL, ev: evAny }) },
  kpi: { kind: "'kpi'", items: arr({ label: 'text', value: '@Value', ev: evAny }) },
  table: all({ kind: "'table'", id: 'nestr', head: arr({ text: 'str', cat: 'str|null' }, { min: 1 }), rows: arr(arr((v, p, ctx) => { if (typeof v !== 'string') checkNamed('Value', v, p, ctx); })), ev: evAny },
             rule((v) => {
               if (!Array.isArray(v.head) || !Array.isArray(v.rows)) return null;
               const i = v.rows.findIndex((r) => Array.isArray(r) && r.length !== v.head.length);
               return i === -1 ? null : [['rows[' + i + ']', 'row length differs from head (' + v.head.length + ')']];
             })),
  notes: all({ kind: "'notes'", head: "'Notes'|'Recommendations'|'Assessment'|'Conclusions'|'Interpretation'", template: 'tmpl', values: VALUES, ev: evAny }, bound('template', 'values')),
  chart: { kind: "'chart'", id: 'chartId', series: arr(all({ name: 'str', cat: 'str|null', x: arr('num!'), y: arr('num') }, sameLen(['x', 'y']))) },
}));
def('Section', true, { id: 'sectionId', title: 'text', blocks: arr('@Block') });
def('ReportModel', true, {
  title: 'text', subtitle: 'text', status: "'DRAFT'|'SIGNED'|'CHANGED'", sections: arr('@Section'),
  signature: orNull({ hash: 'hex64|null', inputsHash: 'hex16', resultsHash: 'hex16', decisionsHash: 'hex16', appVersion: 'str', runAt: 'iso' }),
  reproducibility: '@Block',
});
def('Signoff', true, {
  name: 'nestr', role: 'str', statement: 'true', at: 'iso', hash: 'hex64', inputsHash: 'hex16', resultsHash: 'hex16', decisionsHash: 'hex16',
  appVersion: 'str', runAt: 'iso', decisions: 'count', open: (v, p, ctx) => { if (v !== 0) err(ctx, p, 'expected 0 open findings'); },
});
def('EvidenceItem', true, {
  id: 'evid', group: "'Q'|'D'|'R'|'W'|'I'|'L'|'M'|'A'|'C'|'U'|'K'|'T'|'V'|'O'", test: 'testId|null', title: 'text',
  values: rec({ v: 'num|str|null', cat: 'str|null', dp: 'count!', path: 'nestr' }), template: 'tmpl',
});
def('EvidenceIndex', true, all({ items: rec('@EvidenceItem', EV_ANY), order: ['evid'] }, rule((v) => {
  if (!isObj(v.items) || !Array.isArray(v.order)) return null;
  const miss = v.order.filter((id) => !Object.prototype.hasOwnProperty.call(v.items, id));
  return miss.length ? [['order', 'ids not in items: ' + miss.join(', ')]] : null;
})));

// ── Synthetic generator (§3.9) ──
def('CaseSpec', false, {
  seed: 'count', stratum: STRATUM, row: 'count',
  truth: { model: 'nestr', k: 'pos', S: 'num', C: 'pos', h: 'pos', phi: 'phi', mu: 'pos', B: 'pos', ct: 'pos', rw: 'pos', q: 'pos', D: 'nonneg|null',
           extra: { 'dF_ft?': 'pos', 'M?': 'pos', 'F?': 'pos', 'R_ft?': 'pos', 're_ft?': 'pos', 'omega?': 'frac', 'lambda?': 'pos', 'width_ft?': 'pos', 'hump_psi?': 'nonneg',
                    'xf_ft?': 'pos', 'b?': 'num', 'dpdt?': 'num' } },
  given: { h: 'pos', phi: 'phi', ct: 'pos', rw: 'pos', B: 'pos', mu: 'pos' },
  history: { days: 'nonneg', variationPct: 'nonneg', earlierShutins: 'count', truncate: 'bool', intraDayChange: 'bool', flushPct: 'nonneg', flushDecay_h: 'nonneg' },
  test: { closeHour: 'nonneg', dtEnd_h: 'dt', dtSample_s: 'pos', sigma: 'nonneg', sigmaFlowFactor: 'nonneg', ar1Rho: 'frac|null', quant: 'nonneg', spikes: 'nonneg|bool',
          drift_psi_d: 'nonneg', tide: { M2: 'nonneg', K1: 'nonneg' }, ramp_s: 'nonneg',
          partialBefore: 'frac|null' },   // rate fraction f cut before the closing (q_after = (1 − f)·q_before, M§A4)
  alloc: { errPct: 'nonneg', bias: 'num', ignoresShutin: 'bool', hoursConflict_h: 'nonneg', resolution: 'nonneg' },
});
def('SynthCase', true, {
  spec: '@CaseSpec', record: '@GaugeRecord', allocation: { rows: arr('@AllocRow') }, rateTable: orNull(arr({ t_ms: 'ms!', q: 'nonneg' })), well: '@WellInput',
  truth: { tc_ms: 'ms!', k: 'pos', S: 'num', model: 'nestr', f: 'pos', qCorrect: 'nonneg', kStar: 'pos', SStar: 'num',
           plateaus: arr({ dt0_h: 'dt', dt1_h: 'dt', kStar: 'pos', SStar: 'num' }), visible: { fault: 'bool', comp: 'bool', closed: 'bool', distractor: 'bool' },
           notAnalysable: 'bool', partial: 'bool' },
});
def('Score', true, {
  matched: 'bool', status: 'nestr', abstained: 'bool', fullyRight: 'bool', ksRight: 'bool', kRight: 'bool', sRight: 'bool', modelRight: 'bool', strict: 'bool',
  falseSeen: 'bool', distractorCaught: 'bool|null', dkPct: 'pct|null', dS: 'num|null', rateErrPct: 'pct|null', label: orNull(LCONF),
});

// ── Calibration table (§3.5) ──
const KS_ROW = { label: 'lvl', n: 'count', right: 'frac', lo: 'frac', hi: 'frac', loCluster: 'frac', hiCluster: 'frac', medAbsDS: 'nonneg', cover2: 'frac' };
const TBL_ROW = { label: 'lvl', n: 'count', fullyRight: 'frac', lo: 'frac', hi: 'frac', loCluster: 'frac', hiCluster: 'frac', kRight: 'frac', sRight: 'frac', modelRight: 'frac', medAbsDS: 'nonneg', cover2: 'frac' };
def('Cal', true, {
  version: 'nestr', calibrated: 'bool', generated: 'date', app: 'nestr', engine: 'nestr',
  seeds: { single: pair('count!'), sequences: pair('count!'), master: 'count!' }, nCases: 'count', nBuildups: 'count',
  thresholds: { snrHigh: 'pos!', sErrHigh: 'pos!', fairSpanHigh: 'pos!', pointSkinSpread: 'pos!', tauBic: 'pos!', rateTolPct: 'pos!', sErrFloor: 'pos!',
                deltaForm: "'plain'|'basevar'", sErrLow: 'pos!', snrLow: 'pos!', disagreeDS: 'pos!', disagreeKPct: 'pos!', reachFactor: 'pos!', distractorRule: 'bool', kHeldRmsK: 'pos!' },
  ksTable: arr(KS_ROW), table: arr(TBL_ROW), strict: arr(TBL_ROW), kHeldTable: arr(KS_ROW), gasTable: arr(TBL_ROW),
  brier: 'nonneg', bss: 'num', reliability: 'nonneg', resolution: 'nonneg', uncertainty: 'nonneg', falseRival: 'frac',
  abstain: { n: 'count', rate: 'frac', rateHom: 'frac' }, distractorCaught: { n: 'count', rate: 'frac' }, rateAccuracy: { medAbsPct: 'nonneg', p90AbsPct: 'nonneg' },
  envelope: { CD: pair('num'), S: pair('num'), tDCDend: pair('num'), snrD: pair('num'), k: pair('num'), dtEnd_h: pair('num') },
  sequences: { falseAlarmDelta: 'frac', falseAlarmAbs: 'frac', delayMedian: 'nonneg', delayMedianShort: 'nonneg', onsetWithin1: 'frac', senCover: 'frac' },
  inApp: arr({ seed: 'count!', stratum: STRATUM, expect: { status: 'str|null', ks: "'high'|'medium'|'low'|null", headline: "'high'|'medium'|'low'|null", fullyRight: 'bool|null' }, margin: 'nonneg' }),
});

const SHAPE_NAMES = ['BuildupSpec', 'BuildupResult', 'ModelFit', 'KHeld', 'Reach', 'GaugeRecord', 'QC', 'Event', 'RateHistory', 'AnalysisInput',
  'Analysis', 'TestEntry', 'TrendTest', 'Trend', 'Review', 'Finding', 'Answer', 'ReportModel', 'CaseSpec', 'SynthCase', 'Score', 'Cal'];

// ═════════════════════════════════════════════════════════════════════════════
// 4. FORMULAS — test-only table of derived quantities (field units)
// ═════════════════════════════════════════════════════════════════════════════
function F(args, text, fn) { fn.args = args; fn.text = text; return fn; }
const SENS_COEF = { h: 1.1513, phi: 1.1513, ct: 1.1513, rw: 2.3026, B: -1.1513, q: -1.1513, mu: 0 };
const FORMULAS = {
  m: F(['Dq', 'B', 'mu', 'k', 'h'], 'm = 162.6·Δq·B·μ/(k·h)  [psi/cycle]', (Dq, B, mu, k, h) => 162.6 * Dq * B * mu / (k * h)),
  mPrime: F(['m'], "m′ = m/ln 10 (= 70.6·Δq·B·μ/(k·h))  [psi]", (m) => m / Math.LN10),
  dpSkin: F(['m', 'S'], 'Δp_skin = 0.8686·m·S  [psi]', (m, S) => 0.8686 * m * S),
  X: F(['re_ft', 'rw'], 'X = ln(r_e/rw) − 0.75', (re, rw) => Math.log(re / rw) - 0.75),
  piRatio: F(['X', 'S'], 'PI ratio = X/(X + S)', (X, S) => X / (X + S)),
  rateAtStake: F(['qNow', 'X', 'Snow', 'Sbase'], 'rate at stake = q_now·[(X + S_now)/(X + S_base) − 1]', (q, X, Sn, Sb) => q * ((X + Sn) / (X + Sb) - 1)),
  extraDrawdown: F(['q', 'B', 'mu', 'dS', 'k', 'h'], 'extra drawdown = 141.2·q·B·μ·ΔS/(k·h)  [psi]', (q, B, mu, dS, k, h) => 141.2 * q * B * mu * dS / (k * h)),
  dkPct: F(['k', 'kRef'], 'dk% = 100·(k/k_ref − 1)', (k, kRef) => 100 * (k / kRef - 1)),
  rinv: F(['k', 'dt', 'phi', 'mu', 'ct'], 'r_inv = 0.0325·√(k·Δt/(φ·μ·ct))  [ft]', (k, dt, phi, mu, ct) => 0.0325 * Math.sqrt(k * dt / (phi * mu * ct))),
  dte: F(['dt', 'tp'], 'Δt_e = tp·Δt/(tp + Δt)  [h]', (dt, tp) => tp * dt / (tp + dt)),
  shutOfDte: F(['dte', 'tp'], 'Δt = Δt_e·tp/(tp − Δt_e), null when Δt_e ≥ tp  [h]', (dte, tp) => (dte < tp ? dte * tp / (tp - dte) : null)),
  xOfDte: F(['dte'], 'X = log10 Δt_e  [cycles; iarf.X0/X1, line.shifts[].dX]', (dte) => Math.log10(dte)),
  dteOfX: F(['X'], 'Δt_e = 10^X  [h]', (X) => Math.pow(10, X)),
  logTerm: F(['k', 'phi', 'mu', 'ct', 'rw'], 'log10(k/(φ·μ·ct·rw²)) − 3.2275', (k, phi, mu, ct, rw) => Math.log10(k / (phi * mu * ct * rw * rw)) - 3.2275),
  pStar: F(['pwf0', 'm', 'tp', 'logTerm', 'S'], 'p* = pwf0 + m·[log10 tp + logTerm + 0.8686·S]  [psia]', (pwf0, m, tp, lt, S) => pwf0 + m * (Math.log10(tp) + lt + 0.8686 * S)),
  p1hr: F(['pStar', 'm', 'tp'], 'p1hr = p* − m·log10((tp + 1)/1)  [psia; Horner at Δt = 1 h]', (pStar, m, tp) => pStar - m * Math.log10(tp + 1)),
  reachFair: F(['t5', 'Lcyc'], 'reach.fair = 10^(0.5 + Lcyc)·t_5%  [h]', (t5, L) => Math.pow(10, 0.5 + L) * t5),
  reachGood: F(['t5', 'Lcyc'], 'reach.good = 10^(1 + Lcyc)·t_5%  [h]', (t5, L) => Math.pow(10, 1 + L) * t5),
  sTc: F(['dpdt', 'dtc_h', 'm'], 'S_tc = 1.1513·|dp/dt_flow|·δt_c/m', (dpdt, dtc, m) => 1.1513 * Math.abs(dpdt) * dtc / m),
  sPwf: F(['pwf0SE', 'm'], 'S_pwf = 1.1513·se(pwf0)/m', (se, m) => 1.1513 * se / m),
  rDrift: F(['driftPsiPerDay', 'dtEnd_h', 'mPrime'], "r_drift = (d/24)·Δt_end/m′", (d, dtEnd, mp) => (d / 24) * dtEnd / mp),
  sensDS: F(['input', 'f'], 'ΔS for input × f (Appendix A.2): +1.1513·log10 f (h, φ, ct), +2.3026·log10 f (rw), −1.1513·log10 f (B, q), 0 (μ)',
    (input, f) => SENS_COEF[input] * Math.log10(f)),
  sensK: F(['input', 'f', 'k'], 'k for input × f (Appendix A.2): k/f (h), k·f (B, μ, q), k (φ, ct, rw)',
    (input, f, k) => (input === 'h' ? k / f : (input === 'B' || input === 'mu' || input === 'q') ? k * f : k)),
  sKAnalytic: F(['delta', 'dpEnd', 'm'], 'S_kAnalytic = δ·(p_D − 0.5), p_D = Δp_end/(2·m′) = ln 10·Δp_end/(2·m)  (§4.6 item 18)',
    (delta, dpEnd, m) => delta * (Math.LN10 * dpEnd / (2 * m) - 0.5)),
  atStakeDay: F(['q', 'X', 'S', 'Sbase'], 'one day of the T8 cumulative: q_d·[(X + S(t_d))/(X + S_base) − 1]  [volume]', (q, X, S, Sb) => q * ((X + S) / (X + Sb) - 1)),
  jObs: F(['q', 'pRef', 'pwf'], 'J_obs = q_d/(p_ref,d − pwf_d)  (T13)', (q, pRef, pwf) => q / (pRef - pwf)),
  jPred: F(['k', 'h', 'B', 'mu', 'X', 'S'], 'J_pred = k·h/(141.2·B·μ·(X + S))  (T13, pseudo-steady state)', (k, h, B, mu, X, S) => k * h / (141.2 * B * mu * (X + S))),
  modelFreeDS: F(['dpj', 'qj', 'dpb', 'qb', 'mOverQb', 'dtej', 'dteb'], 'ΔS = 1.1513·[(Δp_j/q_j − Δp_b/q_b)/(m/q)_b − log10(Δt_e,j/Δt_e,b)]  (T11)',
    (dpj, qj, dpb, qb, mq, dtej, dteb) => 1.1513 * ((dpj / qj - dpb / qb) / mq - Math.log10(dtej / dteb))),
  kStar: F(['truth', 'given', 'f'], "k* = f·k·(B′/B)·(μ′/μ)·(h/h′)  (§5.3)", (t, g, f) => f * t.k * (g.B / t.B) * (g.mu / t.mu) * (t.h / g.h)),
  SStar: F(['truth', 'given', 'f'], "S* = S + 1.1513·log10((h′/h)(φ′/φ)(ct′/ct)) + 2.3026·log10(rw′/rw) − 1.1513·log10((B′/B)·f)  (§5.3)",
    (t, g, f) => t.S + 1.1513 * Math.log10((g.h / t.h) * (g.phi / t.phi) * (g.ct / t.ct)) + 2.3026 * Math.log10(g.rw / t.rw) - 1.1513 * Math.log10((g.B / t.B) * f)),
};

// ═════════════════════════════════════════════════════════════════════════════
// 5. Closed-form generator → FIX
// ═════════════════════════════════════════════════════════════════════════════
const HOUR = 3600000, DAY = 86400000, MIN = 60000;
const SHUT_SAMPLE_MS = MIN;          // record sampling inside shut-ins
const FLOW_SAMPLE_MS = 15 * MIN;     // record sampling while flowing (historian-style)
const P_RES_DP = 3;                  // record pressures rounded to 0.001 psi
const LN10 = Math.LN10;
const isoOf = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };

const WELL = {
  fluid: 'oil', h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354, re_ft: 1500, Pb: 2500, Rs: 450, gas: null,
  Bw: 1.02, muw: 0.5, allocAccPct: 5, driftPsiPerDay: 0.01, defaulted: [],
  sens: { h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 },
};
// dp/dt_flow is not a constant: it is the slope of the closed-form drawdown at closing, −m/(ln 10·tp) (CF.dpdtAt).
const RES = { k: 45, C: 0.02, Lcyc: 0.1, sigma: 0.012, sigmaFlow: 0.08, sigmaLF: 0.02, pwf0SE: 0.11, dtc_h: 0.0021, dtFirst: 0.005 };
const E4_S = 2.0;                    // skin used only for the record around E4 (too short, not interpreted)
const SETTINGS = {
  detect: { winMin: 5, riseMin: 5, riseSig: 10, persistMin: 30, minDur_h: 2, gapN: 5, spike: 'off', partial: true },
  interp: { Lcyc: 0.1, band: 0.10, slope: 0.03, minCycles: 0.5, rivals: 'auto', cheld: 'auto', kHeld: 'auto', tide: 'auto' },
  trend: { baseN: 3, delta: 2, abs: 5, basevar: false, confirm: 'next', price: null, enabled: 'auto' },
  report: { detail: 'selected' },
};
const META_FIX = { wellName: 'Well A', engineer: 'Engineer A', appVersion: '3.3' };
const RUN_AT = '2026-07-01T09:00:00Z';

// closed forms (Appendix A, §4.6)
const CF = {
  m: (q, k) => 162.6 * q * WELL.B * WELL.mu / (k * WELL.h),
  logTerm: (k) => Math.log10(k / (WELL.phi * WELL.mu * WELL.ct * WELL.rw * WELL.rw)) - 3.2275,
  dpIarf: (dte, k, S, m) => m * (Math.log10(dte) + CF.logTerm(k) + 0.8686 * S),
  dte: (dt, tp) => tp * dt / (tp + dt),
  dtOf: (dte, tp) => dte * tp / (tp - dte),
  kh: (k) => k * WELL.h,
  t5: (S, k) => (969000 + 156000 * S) * RES.C * WELL.mu / (k * WELL.h),
  t10: (S, k) => (485000 + 91500 * S) * RES.C * WELL.mu / (k * WELL.h),
  tHump: (S, k) => (21400 + 3390 * S) * RES.C * WELL.mu / (k * WELL.h),
  CD: () => 0.8936 * RES.C / (WELL.phi * WELL.ct * WELL.h * WELL.rw * WELL.rw),
  rinv: (k, dt) => 0.0325 * Math.sqrt(k * dt / (WELL.phi * WELL.mu * WELL.ct)),
  Lmin: (k, dte, g) => Math.sqrt(0.0002637 * k * dte * Math.log(1 / g) / (WELL.phi * WELL.mu * WELL.ct)),
  // smooth WBS blend (plausible arrays only): Δp = Δp_IARF·(1 − exp(−Δp_WBS/Δp_IARF))
  blend: (a, w) => (a > 0 ? a * (1 - Math.exp(-w / a)) : w),
  dpShut: (dt, tp, q, S) => CF.blend(CF.dpIarf(CF.dte(dt, tp), RES.k, S, CF.m(q, RES.k)), q * WELL.B * dt / (24 * RES.C)),   // build-up rise
  dpDraw: (t, q, S) => CF.blend(CF.dpIarf(t, RES.k, S, CF.m(q, RES.k)), q * WELL.B * t / (24 * RES.C)),               // drawdown below p*
  dpdtAt: (q, tp) => -CF.m(q, RES.k) / (LN10 * tp),    // psi/h, slope of the drawdown at closing
};

function bourdet(X, y, L) {
  const n = X.length, d = new Array(n).fill(null), full = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    let j = i - 1; while (j >= 0 && X[i] - X[j] < L) j--;
    let k = i + 1; while (k < n && X[k] - X[i] < L) k++;
    if (j < 0 || k >= n) continue;
    const a = X[i] - X[j], b = X[k] - X[i];
    d[i] = ((y[i] - y[j]) / a * b + (y[k] - y[i]) / b * a) / (a + b);
    full[i] = true;
  }
  return { d, full };
}

let _cal = null;
function fixCal() {
  if (_cal) return _cal;
  const ks = (label, n, right, lo, hi) => ({ label, n, right, lo, hi, loCluster: lo - 0.01, hiCluster: Math.min(1, hi + 0.01), medAbsDS: label === 'high' ? 0.12 : label === 'medium' ? 0.25 : 0.7, cover2: label === 'low' ? 0.8 : 0.93 });
  const tb = (label, n, fr, lo, hi) => ({ label, n, fullyRight: fr, lo, hi, loCluster: lo - 0.01, hiCluster: Math.min(1, hi + 0.01), kRight: Math.min(1, fr + 0.02), sRight: Math.min(1, fr + 0.01), modelRight: Math.min(1, fr + 0.03), medAbsDS: label === 'high' ? 0.12 : label === 'medium' ? 0.25 : 0.7, cover2: label === 'low' ? 0.8 : 0.93 });
  _cal = {
    version: 'cal-fixture', calibrated: true, generated: '2026-10-31', app: 'v3.3', engine: '1.0',
    seeds: { single: [100000, 100639], sequences: [200000, 200119], master: 3300 }, nCases: 640, nBuildups: 1600,
    thresholds: { snrHigh: 20, sErrHigh: 0.5, fairSpanHigh: 0.7, pointSkinSpread: 0.3, tauBic: 10, rateTolPct: 15, sErrFloor: 0.2, deltaForm: 'plain',
                  sErrLow: 1.0, snrLow: 5, disagreeDS: 1.0, disagreeKPct: 15, reachFactor: 3.98, distractorRule: true, kHeldRmsK: 3 },
    ksTable: [ks('high', 520, 0.96, 0.94, 0.975), ks('medium', 760, 0.84, 0.81, 0.865), ks('low', 320, 0.41, 0.36, 0.46)],
    table: [tb('high', 410, 0.955, 0.93, 0.972), tb('medium', 830, 0.82, 0.79, 0.845), tb('low', 360, 0.38, 0.33, 0.43)],
    strict: [tb('high', 410, 0.86, 0.82, 0.89), tb('medium', 830, 0.66, 0.63, 0.69), tb('low', 360, 0.22, 0.18, 0.27)],
    kHeldTable: [ks('medium', 140, 0.82, 0.75, 0.87), ks('low', 60, 0.35, 0.24, 0.48)],
    gasTable: [tb('high', 60, 0.95, 0.86, 0.98), tb('medium', 120, 0.8, 0.72, 0.86), tb('low', 40, 0.4, 0.26, 0.55)],
    brier: 0.12, bss: 0.35, reliability: 0.01, resolution: 0.05, uncertainty: 0.2, falseRival: 0.03,
    abstain: { n: 10, rate: 0.016, rateHom: 0.02 }, distractorCaught: { n: 80, rate: 0.7 }, rateAccuracy: { medAbsPct: 2.1, p90AbsPct: 7.5 },
    envelope: { CD: [100, 100000], S: [-2, 15], tDCDend: [1000, 1000000], snrD: [3, 2000], k: [1, 2000], dtEnd_h: [2, 200] },
    sequences: { falseAlarmDelta: 0.03, falseAlarmAbs: 0.02, delayMedian: 1, delayMedianShort: 2, onsetWithin1: 0.85, senCover: 0.88 },
    inApp: [{ seed: 100003, stratum: 'hom', expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.15 }],
  };
  return _cal;
}
function calRates(ks, headline) {
  const c = fixCal();
  const a = c.ksTable.find((r) => r.label === ks), b = c.table.find((r) => r.label === headline);
  return { ks: { rate: a.right, lo: a.lo, hi: a.hi }, headline: { rate: b.fullyRight, lo: b.lo, hi: b.hi } };
}

function modelFit(phys, se, nFit, extra) {
  const ssrLog = 0.0008, rho1 = 0.3, nEff = nFit * (1 - rho1) / (1 + rho1);
  const bic = nEff * Math.log(ssrLog / nFit) + 3 * Math.log(nEff);
  const ci = (v, s) => [v - 1.96 * s, v + 1.96 * s];
  return Object.assign({
    key: 'homogeneous', base: 'homogeneous', ok: true, converged: true, stopReason: 'tolerance', iterations: 6, slices: 2, nEval: 22,
    phys: { k: phys.k, S: phys.S, C: phys.C }, params: { Cd: CF.CD(), S: phys.S }, se: { k: se.k, S: se.S, C: se.C },
    ci95: { k: ci(phys.k, se.k), S: ci(phys.S, se.S), C: ci(phys.C, se.C) }, corr: { CS: 0.62, kS: 0.35 },
    ssrLog, nDp: nFit, rmseDp: 0.03, bic, p: 3, eligible: true, why: [],
    fullySeen: { status: 'n/a', value: null, bound: null, text: 'Homogeneous model: no boundary to see.' },
  }, extra || {}, { _nEff: nEff, _rho1: rho1 });
}
function stripPriv(o) { delete o._nEff; delete o._rho1; return o; }

function sensitivityOf(k, S) {
  const rows = (ranges) => {
    const out = [];
    ['h', 'phi', 'ct', 'rw', 'B', 'mu', 'q'].forEach((inp) => {
      [1 + ranges[inp], 1 - ranges[inp]].forEach((f) => {
        const dS = SENS_COEF[inp] * Math.log10(f);
        const kk = inp === 'h' ? k / f : (inp === 'B' || inp === 'mu' || inp === 'q') ? k * f : k;
        out.push({ input: inp, f, k: kk, S: S + dS, dkPct: 100 * (kk / k - 1), dS });
      });
    });
    return out;
  };
  const req = rows({ h: 0.2, phi: 0.2, ct: 0.2, rw: 0.2, B: 0.2, mu: 0.2, q: 0.1 });
  const typ = rows(WELL.sens);
  const maxBy = (rs, fn) => { const best = {}; rs.forEach((r) => { best[r.input] = Math.max(best[r.input] || 0, Math.abs(fn(r))); }); return best; };
  const dom = (rs, fn) => { const b = maxBy(rs, fn); return Object.keys(b).reduce((a, c) => (b[c] > b[a] ? c : a)); };
  const mx = maxBy(typ, (r) => r.dS);
  const sSens = Math.sqrt(Object.keys(mx).reduce((s, kk) => s + mx[kk] * mx[kk], 0));
  return { req, typ, dominantK: { req: dom(req, (r) => r.dkPct), typ: dom(typ, (r) => r.dkPct) }, dominantS: { req: dom(req, (r) => r.dS), typ: dom(typ, (r) => r.dS) },
           sSens, muNoEffectOnS: true, ev: ['U2', 'U3'] };
}

// One build-up, closed form. o = {id, q, S, dtEnd, tp, pStar, tc_h, tc_ms, stepTo, steps, multiRate, kHeld, kBase, stage, delta, dtSample_h}
function genTest(o) {
  const k = RES.k, L = RES.Lcyc, Lln = 0.2303 * (L / 0.1);
  const m = CF.m(o.q, k), mp = m / LN10;
  const pwf0 = o.pStar - m * (Math.log10(o.tp) + CF.logTerm(k) + 0.8686 * o.S);
  // bins (20 per cycle) from dtFirst to dtEnd
  const dt = [];
  for (let i = 0; ; i++) { const x = RES.dtFirst * Math.pow(10, i / 20); if (x > o.dtEnd * (1 - 1e-9)) break; dt.push(x); }
  dt.push(o.dtEnd);
  const dte = dt.map((x) => CF.dte(x, o.tp));
  const dp = dt.map((x) => CF.dpShut(x, o.tp, o.q, o.S));
  const dpdt = CF.dpdtAt(o.q, o.tp);
  const n = dt.map((x) => Math.max(1, Math.round(6.92 * x)));
  const X = dte.map((x) => Math.log(x));
  const bd = bourdet(X, dp, Lln);
  const p = dp.map((d) => pwf0 + d);
  // storage, reach
  const t5 = CF.t5(o.S, k), t10 = CF.t10(o.S, k);
  const fair = Math.pow(10, 0.5 + L) * t5, good = Math.pow(10, 1 + L) * t5;
  const dteEnd = dte[dte.length - 1], dteLast = dteEnd / Math.pow(10, L);
  const found = dteEnd >= fair;
  const cycles = found ? Math.log10(dteLast / t5) : null;
  const grade = !found ? 'none' : cycles >= 1 ? 'good' : 'fair';
  const humpMax = Math.max.apply(null, bd.d.filter((x) => x !== null));
  // fit-bin count (12 per cycle)
  const nFit = Math.round(12 * Math.log10(o.dtEnd / RES.dtFirst));
  // line (EN6 reference bias)
  let line = null, shift = null, bk = 0, bS = 0;
  if (found) {
    bk = grade === 'good' ? -0.005 : -0.026; bS = grade === 'good' ? -0.05 : -0.33;
    const kL = k * (1 + bk), SL = o.S + bS, mL = CF.m(o.q, kL);
    const delta = Math.min(0.25, 0.2 * cycles);
    shift = { dX: -delta, dt0_h: CF.dtOf(t5 / Math.pow(10, delta), o.tp), dt1_h: CF.dtOf(dteLast / Math.pow(10, delta), o.tp), S: SL + 0.12, bS: bS * 1.2 };
    const dt0 = CF.dtOf(t5, o.tp), dt1 = CF.dtOf(dteLast, o.tp);
    const khDiffPct = 100 * (CF.kh(kL) / CF.kh(k) - 1);
    line = {
      method: o.multiRate ? 'superposition' : 'horner', k: kL, kh: CF.kh(kL), S: SL, m: mL, pStar: o.pStar, pStarRange: null,
      p1hr: o.pStar - mL * Math.log10((o.tp + 1) / 1), r2: 0.9999, dt0_h: dt0, dt1_h: dt1,
      n: dt.filter((x) => x >= dt0 * (1 - 1e-9) && x <= dt1 * (1 + 1e-9)).length,
      shifts: [shift], plateauCheck: { khDiffPct, dS: bS, pass: Math.abs(khDiffPct) <= 5 && Math.abs(bS) <= 0.3 }, ev: ['L1', 'L2', 'L3'],
    };
  }
  // fits
  const hom = found
    ? modelFit({ k, S: o.S, C: RES.C }, { k: 0.004 * k, S: grade === 'good' ? 0.03 : 0.05, C: 0.0001 }, nFit)
    : modelFit({ k: k * 1.08, S: o.S + 0.6, C: RES.C }, { k: 0.06 * k, S: 0.4, C: 0.0004 }, nFit);
  let kHeld = null, Sk = 0;
  const kFinal = o.kHeld ? o.kBase : k;
  if (o.kHeld) {
    const dpEnd = CF.dpIarf(dteEnd, k, o.S, m);
    const refit = (f) => { const kk = o.kBase * f, mm = CF.m(o.q, kk); return (dpEnd / mm - Math.log10(dteEnd) - CF.logTerm(kk)) / 0.8686; };
    const Sp = refit(1 + o.delta), Sm = refit(1 - o.delta);
    Sk = Math.abs(Sp - Sm) / 2;
    const fitK = modelFit({ k: o.kBase, S: o.S, C: RES.C }, { k: 0, S: 0.04, C: 0.0002 }, nFit);
    kHeld = { k: o.kBase, delta: o.delta, fit: stripPriv(fitK), refits: [{ f: 1 + o.delta, S: Sp, C: RES.C }, { f: 1 - o.delta, S: Sm, C: RES.C }],
              S_k: Sk, S_kAnalytic: o.delta * (LN10 * dpEnd / (2 * m) - 0.5), corrCS: 0.7, rmsRatio: 1.1, converged: true, ev: ['M8'] };
  }
  const mF = CF.m(o.q, kFinal);
  // S_err (§4.6 item 15)
  const sTc = 1.1513 * Math.abs(dpdt) * RES.dtc_h / mF, sPwf = 1.1513 * RES.pwf0SE / mF;
  const sens = sensitivityOf(kFinal, o.S);
  let sErr;
  if (o.kHeld) {
    const seS = kHeld.fit.se.S;
    const terms = [['floor', 0.2], ['se', seS], ['tc', sTc], ['pwf', sPwf], ['kHeld', Sk]];
    const top = terms.reduce((a, c) => (c[1] > a[1] ? c : a));
    sErr = { value: top[1], mode: 'kHeld', floor: 0.2, seS, dLineMatch: null, sWin: null, sTc, sPwf, sK: Sk, driver: top[0] };
  } else {
    const seS = hom.se.S, dLM = Math.abs(line.S - o.S), sWin = Math.abs(shift.S - line.S);
    const terms = [['floor', 0.2], ['se', seS], ['lineMatch', dLM], ['window', sWin], ['tc', sTc], ['pwf', sPwf]];
    const top = terms.reduce((a, c) => (c[1] > a[1] ? c : a));
    sErr = { value: top[1], mode: 'line', floor: 0.2, seS, dLineMatch: dLM, sWin, sTc, sPwf, sK: null, driver: top[0] };
  }
  sErr.ext = { value: Math.max(sErr.value, 0), S_C: 0 };
  sErr.sSens = sens.sSens;
  sErr.sAbs = Math.sqrt(sErr.value * sErr.value + sens.sSens * sens.sSens);
  sErr.ev = ['U1'];
  // quality
  const sigmaD = 0.063, snrD = mp / sigmaD, rDrift = (WELL.driftPsiPerDay / 24) * o.dtEnd / (mF / LN10);
  const rTide = o.dtEnd >= 24 ? 0.02 : null;
  // labels (subset of §5.1 that the fixture exercises)
  const reasons = [];
  let ks, model;
  if (o.kHeld) {
    ks = sErr.value > 1.0 ? 'low' : 'medium';
    reasons.push({ rule: 'KC3', kind: 'cap', text: 'KC3: k-held result (k fixed at the baseline median).', ev: ['M8'] });
    model = 'medium';
  } else {
    const kh1 = grade === 'good' || (grade === 'fair' && cycles >= 0.7);
    const kh2 = Math.abs(bk) <= 0.05 && Math.abs(bS) <= 0.5;
    const kh3 = sErr.value <= 0.5;
    if (!kh1) reasons.push({ rule: 'KH1', kind: 'unmet', text: 'KH1 unmet: fair window ' + cycles.toFixed(2) + ' cycle.', ev: ['I1'] });
    if (!kh2) reasons.push({ rule: 'KH2', kind: 'unmet', text: 'KH2 unmet: line and match disagree.', ev: ['A1'] });
    if (!kh3) reasons.push({ rule: 'KH3', kind: 'unmet', text: 'KH3 unmet: skin uncertainty above 0.5.', ev: ['U1'] });
    ks = (kh1 && kh2 && kh3) ? 'high' : 'medium';
    model = grade === 'good' ? 'high' : 'medium';
  }
  if (RANK[model] > RANK[ks]) model = ks;
  const headline = RANK[ks] < RANK[model] ? ks : model;
  const fullySeen = { status: 'n/a', value: null, bound: null, text: 'Homogeneous model: no boundary to see.' };
  const hom2 = stripPriv(Object.assign({}, hom));
  const nEff = hom._nEff;
  const pStarFinal = found ? o.pStar : null;
  const result = {
    ok: true, id: o.id, version: '1.0', inputHash: '0000000000000000', testType: 'buildup', reason: found ? null : 'NO_IARF_TOO_SHORT',
    bins: { dt, dte, dp, n, deriv: bd.d, full: bd.full, X },
    quality: { sigma_psi: RES.sigma, sigmaFlow_psi: RES.sigmaFlow, sigmaD_psi: sigmaD, snrD, rDrift, rTide, tideRemoved: false, tideFit: 'none', ev: ['I5', 'Q5', 'Q6'] },
    storage: { unitSlope: true, C_us: RES.C, tHump_h: CF.tHump(o.S, k), humpRatio: humpMax / mp, seed: null, humpConsistent: true, ev: ['W1', 'W2', 'W3'] },
    reach: { t10_h: t10, t5_h: t5, fair_h: fair, good_h: good, fairShut_h: fair < o.tp ? CF.dtOf(fair, o.tp) : null, goodShut_h: good < o.tp ? CF.dtOf(good, o.tp) : null,
             reachable: fair < o.tp, ev: ['W4'] },
    iarf: found ? {
      found: true, grade, noiseWidened: false, status: 'ok', dt0_h: line.dt0_h, dt1_h: line.dt1_h, X0: Math.log10(t5), X1: Math.log10(dteLast), cycles,
      level_psi: mp, slope: 0, slopeSE: 0.002, slopeLast: 0, slopeLastSE: 0.002, band: 0.10, slopeTol: 0.03, noiseLimited: false,
      pointSkin: { spread: 0, min: o.S, max: o.S }, longest: { dt0_h: line.dt0_h, dt1_h: line.dt1_h, cycles }, secondLevel: null, laterPlateaus: [],
      forced: false, reason: 'Earliest plateau after the storage hump; the longest qualifying window inside it.', ev: ['I1', 'I2', 'I3', 'I4'],
    } : {
      found: false, grade: 'none', noiseWidened: false, status: 'tooShort', dt0_h: null, dt1_h: null, X0: null, X1: null, cycles: null,
      level_psi: null, slope: null, slopeSE: null, slopeLast: null, slopeLastSE: null, band: 0.10, slopeTol: 0.03, noiseLimited: false,
      pointSkin: { spread: null, min: null, max: null }, longest: null, secondLevel: null, laterPlateaus: [], forced: false,
      reason: 'No IARF: the test is too short for the expected reach.', ev: ['I1'],
    },
    line,
    triggers: { up: false, down: false, level: false, none: false, noneSkipped: !found, fired: [], ev: ['M2'] },
    flags: [],
    models: [hom2],
    bic: { n: nFit, nEff, rho1: hom._rho1, tau: 10, basis: 'logDp', floorUsed: false,
           rows: [{ key: 'homogeneous', bic: hom2.bic, dBicHom: 0, p: 3, eligible: true, why: [] }], chosen: 'homogeneous', margin: null, ev: ['M4'] },
    chosen: { key: 'homogeneous', label: 'Homogeneous', fullySeen, reason: found ? 'No trigger fired: homogeneous kept.' : 'No IARF (test too short): no rival fitted.', ev: ['M6', 'M5'] },
    agreement: found
      ? { agree: Math.abs(bk) <= 0.05 && Math.abs(bS) <= 0.5, mode: 'raw', dkPct: 100 * (line.k / k - 1), dS: line.S - o.S, biasKPct: 100 * bk, biasDS: bS, ev: ['A1'] }
      : { agree: false, mode: 'none', dkPct: null, dS: null, biasKPct: null, biasDS: null, ev: ['A1'] },
    final: {
      k: kFinal, kh: CF.kh(kFinal), S: o.S, C: RES.C, source: o.kHeld ? 'kHeld' : 'match', m: mF, mPrime: mF / LN10, pStar: pStarFinal, pStarRange: null,
      pExt: pStarFinal, pExtKind: 'pStar', piModel: o.pStar,
      rinv_ft: CF.rinv(kFinal, o.dtEnd), rinvE_ft: CF.rinv(kFinal, dteEnd), dpSkin_psi: 0.8686 * mF * o.S, distances: {},
      minFaultDist_ft: found ? CF.Lmin(kFinal, dteLast, 0.15) : null, gas: null, ev: ['A2'],
    },
    cheld: { triggered: false, mode: 'pair', refits: [], range: { C: [RES.C, RES.C], k: [kFinal, kFinal], S: [o.S, o.S] }, S_C: 0, meaningful: true, ev: ['C1'] },
    sErr,
    sensitivity: sens,
    history: { estimated: false, dDerivPct: null, sensitive: false, ev: ['R5'] },
    background: o.stage === 'final' ? { applied: true, slopeSource: 'pstar', boundaryDepends: false, ev: ['M7'] } : null,
    kHeld,
    confidence: { ks, model, headline, stage: o.stage, reasons, rates: calRates(ks, headline), outsideCalibration: false, calVersion: fixCal().version, calibrated: true, ev: ['K1', 'K2'] },
    fitC4: { modelKey: 'homogeneous', params: { Cd: CF.CD(), S: o.S }, phys: { k: kFinal, S: o.S, C: RES.C }, r2: 0.9999, converged: true,
             ci95: hom2.ci95, kind: 'pressure', source: 'buildup' },
    warnings: [],
  };
  result.evidence = {
    grade, noiseWidened: false, span: cycles, pointSkinSpread: found ? 0 : null, agree: result.agreement.agree, agreeMode: result.agreement.mode,
    dkPct: result.agreement.dkPct, dS: result.agreement.dS, sErr: sErr.value, sErrMode: sErr.mode, unitSlope: true, cheldRejectedBoth: false,
    rateSource: 'allocation', r3: 1.0, r3Status: 'pass', r4: 1.02, r4Status: 'pass', dqKnown: true, fRate: 1, equalRateAssumed: false,
    snrD, rDrift, rTide, tideRemoved: false, flags: [], distractorAtOrBeforeIarf: false, humpAfterIarf: false, dtEnd_h: o.dtEnd, dteEnd_h: dteEnd,
    t10_h: t10, t5_h: t5, historySensitive: false, outsideEnvelope: false, kHeld: !!o.kHeld, kHeldConverged: o.kHeld ? true : null,
    kHeldCorrCS: o.kHeld ? 0.7 : null, kHeldRmsRatio: o.kHeld ? 1.1 : null,
    partialSuspect: o.stage === 'final' ? false : null, windowLevelInconsistent: o.stage === 'final' ? false : null,
    chosenKey: 'homogeneous', chosenFullySeen: 'n/a', triggers: [], dBicChosen: 0, dBicNext: null, boundaryDepends: o.stage === 'final' ? false : null,
  };
  const rateQC = { source: 'allocation', r3: 1.0, r3Status: 'pass', r4: 1.02, r4Status: 'pass', dqKnown: true, dqSource: 'closingDay',
                   equalRateAssumed: false, ignoresShutin: false, allocAccPct: WELL.allocAccPct };
  const specCommon = {
    id: o.id, testType: 'buildup', tc_h: o.tc_h, dtc_h: RES.dtc_h, pwf0, pwf0SE: RES.pwf0SE, dpdt_flow: dpdt,
    qUnit: 'STB/d', Dq: o.q, fRate: 1, rateQC,
    well: { fluid: 'oil', h: WELL.h, phi: WELL.phi, mu: WELL.mu, B: WELL.B, ct: WELL.ct, rw: WELL.rw, T_R: null, re_ft: WELL.re_ft, defaulted: [] },
    gas: null, sigma_psi: RES.sigma, sigmaFlow_psi: RES.sigmaFlow, sigmaLF_psi: RES.sigmaLF, dtSample_h: o.dtSample_h || SHUT_SAMPLE_MS / HOUR, driftPsiPerDay: WELL.driftPsiPerDay,
    history: { estimated: false, tPrepend_h: 0, source: 'date' },
    overrides: { window: null, model: null, excludeRivals: [] },
    opts: { Lcyc: L, binsPerCycle: 20, fitBinsPerCycle: 12, rivals: 'auto', cheld: 'auto', tide: 'auto' },
  };
  const specMem = Object.assign({}, specCommon, { dt: dt.slice(), p: p.slice(), n: n.slice(), steps: o.steps || [{ t: o.tc_h - o.tp, q: o.q }, { t: o.tc_h, q: 0 }] });
  const specStored = Object.assign({}, specCommon, { dt: dt.map(sf6), p: p.map(sf6), n: n.slice(), stepRef: { from: 0, to: o.stepTo || 0 } });
  const AI = autoInterp();
  result.inputHash = AI.hash16(AI.canon(specStored, 'inputs'));
  return { result, specMem, specStored, pwf0, m: mF, dteEnd, found, cycles, t5, dpdt };
}

// Reference case (Appendix A.1, §4.6 item 5b): single rate, tp = 720 h from production start.
const FIX_REF = { k: 45, S: 5, C: 0.02, h: 50, mu: 1, q: 800, B: 1.2, tp: 720, dtEnd: 72, pStar: 4000 };
function genReference() {
  const R = FIX_REF;
  return genTest({ id: 'B1', q: R.q, S: R.S, dtEnd: R.dtEnd, tp: R.tp, pStar: R.pStar, tc_h: R.tp, tc_ms: Date.UTC(2026, 2, 31, 9), multiRate: false, stage: 'pass1' });
}

// Schedule of the 6-test analysis (history clock origin = first gauge sample).
const ORIGIN_MS = Date.UTC(2026, 2, 1);
const PROD_START_MS = Date.UTC(2026, 0, 1);
const PLAN = [
  { id: 'B1', ev: 'E1', day: 10, hour: 9, dtEnd: 72, q: 812, S: 1.2 },
  { id: 'B2', ev: 'E2', day: 30, hour: 14, dtEnd: 48, q: 790, S: 1.3 },
  { id: 'B3', ev: 'E3', day: 50, hour: 8, dtEnd: 240, q: 805, S: 1.1 },
  { ev: 'E4', day: 62, hour: 11, dtEnd: 1.5, q: 798, tooShort: true },
  { id: 'B4', ev: 'E5', day: 70, hour: 10, dtEnd: 72, q: 798, S: 2.0, excludedBy: 'O1' },
  { id: 'B5', ev: 'E6', day: 90, hour: 15, dtEnd: 12, q: 820, S: 4.6, kHeld: true },
  { id: 'B6', ev: 'E7', day: 110, hour: 9, dtEnd: 96, q: 801, S: 6.0 },
];
const Q_AFTER = 805;            // rate after the last build-up
const P_INIT = 4000, DEPL_PSI_PER_DAY = 0.01;

// small numeric helpers (fixture only)
const quantile = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
// piecewise-linear interpolation through [[x, y], …] (x ascending), constant outside the knots
function lin(knots, x) {
  if (!knots.length) return null;
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    if (x <= knots[i][0]) return knots[i - 1][1] + (knots[i][1] - knots[i - 1][1]) * (x - knots[i - 1][0]) / (knots[i][0] - knots[i - 1][0]);
  }
  return knots[knots.length - 1][1];
}
// linear interpolation of y in log x (x ascending), null outside
function logInterp(xs, ys, x) {
  for (let i = 1; i < xs.length; i++) {
    if (x >= xs[i - 1] && x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * Math.log(x / xs[i - 1]) / Math.log(xs[i] / xs[i - 1]);
  }
  return null;
}
// Fixture record hash: hash16 over n, the first and last times and a 32-bit FNV-1a digest of every sample (time steps in
// ms and pressures in units of 0.001 psi). A fixture convention only; WP2 defines the real record hash.
function recordHash(t, p) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h = Math.imul(h ^ (i ? t[i] - t[i - 1] : 0), 16777619);
    h = Math.imul(h ^ Math.round(p[i] * Math.pow(10, P_RES_DP)), 16777619);
  }
  return autoInterp().hash16(t.length + '|' + t[0] + '|' + t[t.length - 1] + '|' + (h >>> 0).toString(16));
}
const gaugeRecord = (t, p, name, source) => ({ ok: true, origin_ms: t[0], t, p, T: null, n: t.length, source, name, zone: { mode: 'utc' }, pUnitIn: 'psia',
  patm: 14.696, elapsed: false, rollup: false, hash: recordHash(t, p), warnings: [] });
const rnd = (x) => Math.round(x * 1000) / 1000;    // 0.001 psi (P_RES_DP = 3)

// The one gauge record of the analysis: 15-min samples while flowing (closed-form drawdown from the last reopening at the
// closing test's rate and skin), 1-min samples in every shut-in from Δt = dtFirst (closed-form build-up), 0.001 psi.
function genAnalysisRecord(evs, endMs, pStarAt) {
  const t = [], p = [], flowing = [];
  const push = (ms, pv, fl) => { t.push(ms); p.push(rnd(pv)); flowing.push(fl); };
  const first = Math.round(RES.dtFirst * HOUR);
  const idx = [];
  let g = ORIGIN_MS;                               // next flowing grid point
  evs.forEach((e) => {
    const pStar = pStarAt(e.tc);
    for (; g <= e.tc; g += FLOW_SAMPLE_MS) push(g, pStar - CF.dpDraw((g - e.open) / HOUR, e.q, e.Srec), true);
    const j0 = t.length - 1;                       // the sample at t_c (last flowing sample)
    const pwf0 = pStar - CF.dpIarf(e.tp, RES.k, e.Srec, CF.m(e.q, RES.k));
    for (let ms = e.tc + first; ms <= e.end; ms += SHUT_SAMPLE_MS) push(ms, pwf0 + CF.dpShut((ms - e.tc) / HOUR, e.tp, e.q, e.Srec), false);
    idx.push({ j0, j1: j0 + 1, jEnd: t.length - 1, pwf0 });
    while (g <= e.end) g += FLOW_SAMPLE_MS;        // first flowing grid point after the reopening
  });
  const last = evs[evs.length - 1], pStarL = pStarAt(last.end);
  for (; g <= endMs; g += FLOW_SAMPLE_MS) push(g, pStarL - CF.dpDraw((g - last.end) / HOUR, Q_AFTER, last.Srec), true);
  return { record: gaugeRecord(t, p, 'well-a-gauge.csv', 'csv'), idx, flowing };
}

function genAnalysis() {
  const AI = autoInterp();
  // steps (epoch ms) and per-event timing
  const steps = [{ t_ms: PROD_START_MS, q: PLAN[0].q }];
  let prevOpen = PROD_START_MS;
  const evs = PLAN.map((e, i) => {
    const tc = ORIGIN_MS + e.day * DAY + e.hour * HOUR;
    const end = tc + e.dtEnd * HOUR;
    const tp = (tc - prevOpen) / HOUR;
    steps.push({ t_ms: tc, q: 0 });
    const stepTo = steps.length - 1;
    steps.push({ t_ms: end, q: i + 1 < PLAN.length ? PLAN[i + 1].q : Q_AFTER });
    const open = prevOpen;
    prevOpen = end;
    return Object.assign({}, e, { tc, end, tp, open, stepTo, Srec: e.S != null ? e.S : E4_S });
  });
  const endMs = evs[evs.length - 1].end + DAY;
  const pStarAt = (ms) => P_INIT - DEPL_PSI_PER_DAY * (ms - PROD_START_MS) / DAY;
  const tcH = (ms) => (ms - ORIGIN_MS) / HOUR;
  const memSteps = (upTo) => steps.slice(0, upTo + 1).map((s) => ({ t: tcH(s.t_ms), q: s.q }));
  // the record
  const R = genAnalysisRecord(evs, endMs, pStarAt), record = R.record;
  const diffsS = (j1, j2) => { const d = []; for (let j = j1 + 1; j <= j2; j++) d.push((record.t[j] - record.t[j - 1]) / 1000); return d; };
  // tests
  const tests = [], gens = {};
  let kBase = null;
  evs.forEach((e, i) => {
    if (!e.id) return;
    const ix = R.idx[i];
    const g = genTest({ id: e.id, q: e.q, S: e.S, dtEnd: e.dtEnd, tp: e.tp, pStar: pStarAt(e.tc), tc_h: tcH(e.tc), tc_ms: e.tc, stepTo: e.stepTo,
                        steps: memSteps(e.stepTo), multiRate: true, kHeld: !!e.kHeld, kBase: kBase || RES.k, delta: 0.05, stage: 'final',
                        dtSample_h: median(diffsS(ix.j1, ix.jEnd)) / 3600 });
    gens[e.id] = g;
    if (!kBase && !e.kHeld) kBase = RES.k;
    const r = g.result;
    tests.push({
      id: e.id, eventId: e.ev, date: dateOf(e.tc), tc_ms: e.tc, dtEnd_h: e.dtEnd, Dq: e.q, qUnit: 'STB/d',
      pwf0: g.pwf0, pwf0Datum: g.pwf0, pStarDatum: r.final.pStar, pExtDatum: r.final.pExt,
      status: e.excludedBy ? 'excluded' : 'interpreted', statusReason: e.excludedBy ? 'Excluded by override ' + e.excludedBy + ': the gauge was swapped during this shut-in.' : null,
      spec: g.specStored, result: r, used: { baseline: false, trend: false, alert: false }, partialSuspect: false, overrides: e.excludedBy ? [e.excludedBy] : [],
    });
  });
  // daily rate history and allocation rows (pwfMean = mean flowing record sample of the day)
  const rateAt = (ms) => { let q = 0; for (const s of steps) { if (s.t_ms <= ms) q = s.q; else break; } return q; };
  const pwfMeanOf = (() => {
    let j = 0;
    return (d0, d1) => {
      while (j < record.n && record.t[j] < d0) j++;
      let sum = 0, c = 0;
      for (let i = j; i < record.n && record.t[i] < d1; i++) if (R.flowing[i]) { sum += record.p[i]; c++; }
      return c ? sum / c : null;
    };
  })();
  const days = [], rows = [];
  for (let d0 = ORIGIN_MS; d0 < endMs; d0 += DAY) {
    const d1 = d0 + DAY;
    let V = 0, hOn = 0;
    const cuts = [d0, d1];
    steps.forEach((s) => { if (s.t_ms > d0 && s.t_ms < d1) cuts.push(s.t_ms); });
    cuts.sort((a, c) => a - c);
    for (let i = 0; i + 1 < cuts.length; i++) { const q = rateAt(cuts[i]); const hh = (cuts[i + 1] - cuts[i]) / HOUR; V += q * hh / 24; if (q > 0) hOn += hh; }
    const dayEvents = evs.filter((e) => e.tc < d1 && e.end > d0).map((e) => e.ev);
    const closing = evs.find((e) => e.tc >= d0 && e.tc < d1);
    const q = hOn >= 0.5 ? 24 * V / hOn : 0;
    const pm = hOn >= 0.5 ? pwfMeanOf(d0, d1) : null;
    const date = dateOf(d0);
    days.push({
      date, t0_ms: d0, t1_ms: d1, hours: 24, hOn, V, q, cls: hOn < 0.5 ? 'shut' : dayEvents.length ? 'event' : 'clean', events: dayEvents,
      pwfMean_psia: pm, pwfMeanDatum_psia: pm,
      R3: closing ? { ratio: 1.0, tol: 0.15, pass: true, status: 'pass' } : null, R4: closing ? { ratio: 1.02, pass: true, status: 'pass' } : null, R6: null,
      ignoresShutin: false, equalRateAssumed: false, shortDay: !!closing && hOn < 6,
    });
    rows.push({ date, oil: Math.round(V * 10) / 10, gas: Math.round(V * WELL.Rs / 100) / 10, water: 0, hours: hOn });
  }
  // used set: k/S label ≥ medium and not excluded; baseline = first 3 used
  const usedTests = tests.filter((t) => t.status === 'interpreted' && RANK[t.result.confidence.ks] >= 1);
  const baseIds = usedTests.slice(0, 3).map((t) => t.id);
  tests.forEach((t) => { const u = usedTests.indexOf(t) !== -1; t.used = { baseline: baseIds.indexOf(t.id) !== -1, trend: u, alert: u }; });
  const firstTest = tests[0].tc_ms;
  const tDays = (t) => (t.tc_ms - firstTest) / DAY;
  const Sb = median(baseIds.map((id) => tests.find((t) => t.id === id).result.final.S));
  const serrOf = (t) => t.result.sErr.value;
  // delta alert (plain form): S − S_err − S_base > 2, raised at the first used test, confirmed at the next used test
  const exceeds = (t, thr) => t.result.final.S - serrOf(t) - Sb > thr;
  const raisedD = usedTests.find((t) => exceeds(t, SETTINGS.trend.delta));
  const nextD = raisedD ? usedTests.slice(usedTests.indexOf(raisedD) + 1).find((t) => exceeds(t, SETTINGS.trend.delta)) : null;
  const absEx = (t, dS) => t.result.final.S + (dS || 0) - serrOf(t) > SETTINGS.trend.abs;
  const raisedA = usedTests.find((t) => absEx(t));
  const nextA = raisedA ? usedTests.slice(usedTests.indexOf(raisedA) + 1).find((t) => absEx(t)) : null;
  const immediate = raisedA && raisedA.result.confidence.ks === 'high' && raisedA.result.final.S - serrOf(raisedA) - SETTINGS.trend.abs >= 1;
  const sSens = tests[0].result.sErr.sSens;
  const lo = usedTests.find((t) => absEx(t, -sSens)), hi = usedTests.find((t) => absEx(t, +sSens));
  // onset (placeholder): midway between the last baseline-level used test and the raising test
  const iRaise = usedTests.indexOf(raisedD);
  const tau = 0.5 * (tDays(usedTests[iRaise - 1]) + tDays(raisedD));
  const post = usedTests.filter((t) => tDays(t) > tau);
  // S(t): piecewise linear through the used tests with the onset knot (τ̂, S_base); constant outside
  const sKnots = usedTests.filter((t) => tDays(t) < tau).map((t) => [tDays(t), t.result.final.S]).concat([[tau, Sb]]).concat(post.map((t) => [tDays(t), t.result.final.S]));
  const sAt = (d) => lin(sKnots, d);
  const latest = usedTests[usedTests.length - 1];
  const X = Math.log(WELL.re_ft / WELL.rw) - 0.75;
  const Snow = latest.result.final.S;
  const kNow = latest.result.final.k;
  const kB = RES.k;                                // Analysis.baseline.k
  const midDays = (d) => (0.5 * (d.t0_ms + d.t1_ms) - firstTest) / DAY;
  // T8 cumulative since τ̂: Σ_days q_d·[(X + S(t_d))/(X + S_base) − 1]
  let cum = 0;
  days.forEach((d) => { const td = midDays(d); if (td >= tau) cum += FORMULAS.atStakeDay(d.q, X, sAt(td), Sb); });
  // T11 model-free ΔS at Δt_ref (used tests with an IARF window; reference = the first of them)
  const iarfTests = usedTests.filter((t) => t.result.iarf.dt0_h != null);
  const minEnd = Math.min.apply(null, iarfTests.map((t) => t.dtEnd_h));
  const dtRef = Math.max.apply(null, iarfTests.map((t) => t.result.iarf.dt0_h).filter((x) => x <= minEnd));
  const refT = iarfTests[0];
  const atRef = (t) => {
    const r = t.result, dteEnd = r.bins.dte[r.bins.dte.length - 1];
    const dte = FORMULAS.dte(dtRef, t.dtEnd_h * dteEnd / (t.dtEnd_h - dteEnd));
    return { dte, dp: logInterp(r.bins.dte, r.bins.dp, dte) };
  };
  const modelFree = iarfTests.slice(1).map((t) => {
    const a = atRef(t), b = atRef(refT);
    const dS = FORMULAS.modelFreeDS(a.dp, t.Dq, b.dp, refT.Dq, refT.result.final.m / refT.Dq, a.dte, b.dte);
    const fitted = t.result.final.S - refT.result.final.S;
    return { id: t.id, refId: refT.id, dS, fittedDS: fitted, agrees: Math.abs(dS - fitted) <= Math.max(0.3, serrOf(t)) };
  });
  // T13 PI cross-check: J_obs/J_pred on clean flowing days between consecutive used tests
  const pKnots = usedTests.filter((t) => t.result.final.pExt != null).map((t) => [t.tc_ms, t.result.final.pExt]);
  const piRows = usedTests.slice(1).map((t, i) => {
    const a = usedTests[i], ratios = [];
    days.forEach((d) => {
      const mid = 0.5 * (d.t0_ms + d.t1_ms);
      if (d.cls !== 'clean' || d.pwfMean_psia == null || !(mid > a.tc_ms && mid < t.tc_ms)) return;
      ratios.push(FORMULAS.jObs(d.q, lin(pKnots, mid), d.pwfMean_psia) / FORMULAS.jPred(kB, WELL.h, WELL.B, WELL.mu, X, sAt(midDays(d))));
    });
    return { from: a.id, to: t.id, RJ: ratios.length ? median(ratios) : null };
  });
  const pStars = usedTests.map((t) => t.result.final.pStar).filter((v) => v != null);
  const pSlope = -DEPL_PSI_PER_DAY * 30;           // Theil–Sen of the used p* (exactly linear in the fixture), psi/30 d
  const trend = {
    ok: true, n: tests.length, nUsed: usedTests.length, enabled: true, disabledReason: null,
    baseline: { S: Sb, sigma: Math.max(median(baseIds.map((id) => serrOf(tests.find((t) => t.id === id)))),
                                       1.4826 * median(baseIds.map((id) => Math.abs(tests.find((t) => t.id === id).result.final.S - Sb))) / Math.sqrt(baseIds.length)),
                tests: baseIds, unstable: false, provisional: false,
                segments: [{ from: tests[0].date, S: Sb, tests: baseIds }], ev: ['T1'] },
    series: tests.map((t) => ({ id: t.id, tDays: tDays(t), S: t.result.final.S, Serr: serrOf(t), k: t.result.final.k, pExt: t.result.final.pExt, pwf0Datum: t.pwf0Datum,
                                Smech: null, SmechErr: null, Sd: null, conf: { ks: t.result.confidence.ks, model: t.result.confidence.model, headline: t.result.confidence.headline },
                                used: Object.assign({}, t.used) })),
    excludedLow: { n: 0, ids: [], S: null, ev: ['T16'] },
    alerts: {
      delta: { threshold: SETTINGS.trend.delta, form: 'plain', raisedAt: raisedD ? raisedD.id : null, confirmedAt: nextD ? nextD.id : null,
               status: nextD ? 'confirmed' : raisedD ? 'provisional' : 'none', kHeldOnly: false, inputRobust: true, ev: ['T2'] },
      absolute: { threshold: SETTINGS.trend.abs, basis: 'total', raisedAt: raisedA ? raisedA.id : null, confirmedAt: nextA ? nextA.id : immediate ? raisedA.id : null,
                  status: (nextA || immediate) ? 'confirmed' : raisedA ? 'provisional' : 'none', kHeldOnly: false,
                  robustness: { lo: lo ? lo.id : null, hi: hi ? hi.id : null, unchanged: (lo ? lo.id : null) === (raisedA ? raisedA.id : null) && (hi ? hi.id : null) === (raisedA ? raisedA.id : null) }, ev: ['T3'] },
    },
    onset: { tauDays: tau, interval: [tau - 5, tau + 5], date: dateOf(firstTest + tau * DAY), model: 'hinge', cusum: { alarmAt: raisedD ? raisedD.id : null, onsetAt: usedTests[iRaise - 1].id },
             indicative: usedTests.length < 6, ev: ['T4'] },
    // §4.7: the recent trend needs n ≥ 3 tests after τ̂; the fixture has 2, so the slopes are not computed
    recent: post.length >= 3 ? null : { slopePer30d: null, ci: [null, null], mkZ: null, mkP: null, n: post.length, indicative: true, wlsSlopePer30d: null, disagree: false, ev: ['T5'] },
    forecast: { show: false, date: null, earliest: null, latest: null, reason: 'Not shown: fewer than 3 tests after the onset, so there is no recent slope.', ev: ['T6'] },
    skinDp: tests.map((t) => ({ id: t.id, dpSkin_psi: t.result.final.dpSkin_psi })),
    pi: { X, re_ft: WELL.re_ft, reSource: 'input', ratioNow: X / (X + Snow), ratioBase: X / (X + Sb), ratioLowerBound: false,
          rateAtStake: latest.Dq * ((X + Snow) / (X + Sb) - 1), rateUnit: 'STB/d', extraDrawdown_psi: 141.2 * latest.Dq * WELL.B * WELL.mu * (Snow - Sb) / (kNow * WELL.h),
          cumAtStake: cum, cumUnit: 'STB', atStakeUpperBound: false, value: null, guard: false, ev: ['T8'] },
    kStability: { cv: 0, stable: true, allocAccPct: WELL.allocAccPct, reading: 'nearWell', ev: ['T9'] },
    pTrend: { quantity: 'pStar', assessable: true, reason: null, slopePer30d: pSlope, scatter: 0, depletion: pStars.length >= 3, label: 'Depletion or gauge drift (the drift input could explain it).', ev: ['T10'] },
    modelFree,
    bubble: { rows: usedTests.map((t) => ({ id: t.id, pwfSand_lo: t.pwf0Datum, pwfSand_hi: t.pwf0Datum, margin: t.pwf0Datum - WELL.Pb, level: t.pwf0Datum >= WELL.Pb + 100 ? 'ok' : 'minor' })),
              spearman: null, ev: ['T12'] },
    piCheck: { available: true, reason: null, rows: piRows, consistent: piRows.every((r) => r.RJ != null && r.RJ >= 0.8 && r.RJ <= 1.25), rho: null, ev: ['T13'] },
    mech: { available: false, Sgeo: null, SgeoRange: [null, null], basis: 'pressureDrop', ev: ['T14'] },
    rateSkin: { resolved: false, S: null, D: null, seD: null, reason: 'Oil well: rate-dependent skin is not assessed.', dqEffect: null, ev: ['T15'] },
    crossTest: { windowLevelInconsistent: [], closedWithoutDepletion: [] },
    recommendations: [{ code: 'stimReview', text: 'Confirmed skin rise with stable k: review the well as a stimulation candidate.', ev: ['T2', 'T9'] }],
    limitations: [
      { code: 'models', text: 'Dual porosity, fractures, channels and multilayer behaviour are not interpreted.' },
      { code: 'iarfEarliest', text: 'The IARF window is the earliest plateau after the storage hump, not the longest; the longest qualifying window is reported.' },
    ],
  };
  if (!trend.recent) throw new Error('_buildup-shapes: the fixture plan now has 3 tests after the onset; compute the recent trend');
  // events (j0/j1 and the flowing trend from the record)
  const events = evs.map((e, i) => {
    const ix = R.idx[i], pwf0 = e.id ? gens[e.id].pwf0 : ix.pwf0, b = CF.dpdtAt(e.q, e.tp);
    return {
      id: e.ev, kind: 'shutin', status: e.tooShort ? 'too_short' : 'analysable', tc_ms: e.tc, dtc_s: RES.dtc_h * 3600,
      j0: ix.j0, j1: ix.j1, pwf0, pwf0SE: RES.pwf0SE,
      trend: { a: pwf0, b, ref_ms: e.tc, n: 10, sigmaRes: RES.sigmaFlow },
      rise_psi: e.id ? gens[e.id].result.bins.dp[Math.min(30, gens[e.id].result.bins.dp.length - 1)] : 40, riseScale_min: 5, Ts_psi: 5,
      tEnd_ms: e.end, dtEnd_h: e.dtEnd, endReason: 'reopen', ramp: { present: false, dur_s: 0 },
      fhat: 1, fhatMethod: 'allocation', qBefore: e.q, qAfter: 0,
      alloc: { date: dateOf(e.tc), ratio: 1.0, pass: true, ignoresShutin: false, confirm: 'confirmed' }, manual: false,
      ev: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'], warnings: [],
    };
  });
  const rates = {
    mode: 'daily', unit: 'STB/d', phase: 'oil', days, steps,
    start: { source: 'date', prepend_h: (ORIGIN_MS - PROD_START_MS) / HOUR, q: PLAN[0].q, flag: false },
    offsetScan: { current_h: 0, best_h: 0, better: false, improvement: 0 },
    phaseBasis: { used: 'oil', wcMax: 0, gorRatioMax: 1.0, twoPhaseCt: false },
    ev: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'], warnings: [],
  };
  const allDiffs = diffsS(0, record.n - 1);
  const segments = [];
  evs.forEach((e, i) => {
    segments.push({ t0_ms: i ? evs[i - 1].end : ORIGIN_MS, t1_ms: e.tc, kind: 'flow', sigma: RES.sigmaFlow });
    segments.push({ t0_ms: e.tc, t1_ms: e.end, kind: 'shut', sigma: RES.sigma });
  });
  segments.push({ t0_ms: evs[evs.length - 1].end, t1_ms: record.t[record.n - 1], kind: 'flow', sigma: RES.sigmaFlow });
  const qc = {
    ok: true, n: record.n, dtMed_s: median(allDiffs), dtP05_s: quantile(allDiffs, 0.05), dtP95_s: quantile(allDiffs, 0.95),
    sigma_psi: RES.sigma, sigmaFlow_psi: RES.sigmaFlow, sigmaShut_psi: RES.sigma,
    segments, resolution_psi: Math.pow(10, -P_RES_DP), resolutionLimited: false, rho1: -0.4, noiseCorrelated: false,
    gaps: [], gapCount: 0, gapTotal_h: 0, longestGap_h: 0, spikes: { count: 0, mode: 'off', idx: [] },
    depth: { applied: false, shift_psi: 0 }, temperature: { present: false, fastChanges: [] }, plausibility: [],
    ev: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q7', 'Q8'],
  };
  const tooShort = evs.filter((e) => e.tooShort);
  const missed = {
    subThreshold: [], allocOnly: [], gaps: [],
    detectability: { ok: true, pStarMinusPwf_psi: tests[0].result.final.pStar - tests[0].pwf0, Ts_psi: 5 },
    tooShort: tooShort.map((e) => e.ev), interventions: [], ev: ['D1'],
  };
  const overrides = [{ id: 'O1', kind: 'exclude', target: 'B4', value: true, reason: 'The gauge was swapped during this shut-in.', who: 'Engineer A', at: '2026-06-20T08:30:00Z', appVersion: '3.3' }];
  const zones = { gauge: { mode: 'utc' }, day: { zone: { mode: 'utc' }, startHour: 0 } };
  const recordSummary = { name: record.name, source: record.source, n: record.n, origin_ms: record.origin_ms, end_ms: record.t[record.n - 1], hash: record.hash, reduced: false, rawStored: 'none' };
  const inputHash = AI.hash16(AI.canon({
    well: WELL, completion: null, depth: null, settings: SETTINGS, zones, history: { mode: 'date', date: dateOf(PROD_START_MS), cum: null }, allocationRows: rows,
    recordHash: recordSummary.hash, events: events.map((e) => ({ id: e.id, tc_ms: e.tc_ms, status: e.status })), overrides,
  }, 'inputs'));
  const resultHash = AI.hash16(AI.canon({
    tests: tests.map((t) => ({ id: t.id, final: t.result.final, sErr: t.result.sErr.value, labels: { ks: t.result.confidence.ks, model: t.result.confidence.model, headline: t.result.confidence.headline } })),
    alerts: trend.alerts, onset: trend.onset, recent: trend.recent.slopePer30d,
  }, 'display'));
  const analysis = {
    ok: true, version: '1.0', appVersion: '3.3', runAt: RUN_AT, inputHash, resultHash,
    meta: META_FIX, well: WELL, completion: null, depth: null, settings: SETTINGS, zones,
    record: recordSummary, qc, events, missed, rates,
    baseline: { k: kB, cvK: 0, kh: CF.kh(kB), tests: baseIds },
    tests, trend, overrides, stats: { evals: 264, fits: 7, slices: 14, ms: null }, warnings: [],
  };
  return { analysis, rows, gens, evs, steps, tcH, memSteps, record };
}

// The SynthCase's own record: the reference case (k 45, S 5, q 800, tp 720 h from production start), 60 s samples from
// 6 h before the closing to 72 h after it, the first shut-in sample 0.005 h after the closing; daily allocation rows.
const SYN_PROD_START_MS = Date.UTC(2026, 3, 1, 9);
function genSynthRecord(ref) {
  const R = FIX_REF;
  const tc = SYN_PROD_START_MS + R.tp * HOUR, end = tc + R.dtEnd * HOUR, step = 60000;
  const t = [], p = [];
  for (let ms = tc - 6 * HOUR + Math.round(RES.dtFirst * HOUR); ms <= end; ms += step) {
    t.push(ms);
    p.push(rnd(ms <= tc ? R.pStar - CF.dpDraw((ms - SYN_PROD_START_MS) / HOUR, R.q, R.S) : ref.pwf0 + CF.dpShut((ms - tc) / HOUR, R.tp, R.q, R.S)));
  }
  const rows = [];
  for (let d0 = Date.UTC(2026, 3, 1); d0 < end; d0 += DAY) {
    const a = Math.max(d0, SYN_PROD_START_MS), b = Math.min(d0 + DAY, tc);
    const hOn = Math.max(0, (b - a) / HOUR), V = R.q * hOn / 24;
    rows.push({ date: dateOf(d0), oil: Math.round(V), gas: Math.round(V * WELL.Rs / 100) / 10, water: 0, hours: hOn });
  }
  return { record: gaugeRecord(t, p, 'synthetic case 100000', 'demo'), rows, tc };
}

function val(v, cat, dp, ref) { return { v, cat, dp, ref }; }

function genSamples(A, ref) {
  const an = A.analysis;
  const B3 = an.tests.find((t) => t.id === 'B3'), B6 = an.tests.find((t) => t.id === 'B6');
  const record = A.record;
  // a sealing-fault rival fit (PRiSM keeps the categorical BC in params), as WP1 reports one in models[]
  const homB3 = B3.result.models[0], dF_ft = 2400, seDF = 300;
  const modelFitFault = Object.assign(JSON.parse(JSON.stringify(homB3)), {
    key: 'linearBoundary', base: 'linearBoundary', p: 4, bic: homB3.bic + 6.4, eligible: false, why: ['No T-up trigger: fitted for the BIC table only.'],
    phys: { k: homB3.phys.k, S: homB3.phys.S, C: homB3.phys.C, dF_ft },
    params: { Cd: homB3.params.Cd, S: homB3.params.S, dF: dF_ft / WELL.rw, BC: 'noflow' },
    se: { k: homB3.se.k, S: homB3.se.S, C: homB3.se.C, dF_ft: seDF },
    ci95: { k: homB3.ci95.k, S: homB3.ci95.S, C: homB3.ci95.C, dF_ft: [dF_ft - 1.96 * seDF, dF_ft + 1.96 * seDF] },
    fullySeen: { status: 'not', value: dF_ft, bound: 'lower', text: 'Sealing fault not seen: the derivative stays flat to the end of the test.' },
  });
  const trendTests = an.tests.map((t) => {
    const r = t.result;
    return {
      id: t.id, t_ms: t.tc_ms, tDays: (t.tc_ms - an.tests[0].tc_ms) / DAY, date: t.date, S: r.final.S, Serr: r.sErr.value, SerrExt: r.sErr.ext.value, SerrMode: r.sErr.mode,
      k: r.final.k, kh: r.final.kh, C: r.final.C, m: r.final.m, mPrime: r.final.mPrime, pStarDatum: t.pStarDatum, pStarRangeDatum: null, pExtDatum: t.pExtDatum,
      pExtKind: r.final.pExtKind, piModelDatum: r.final.piModel, pwf0Datum: t.pwf0Datum, Dq: t.Dq, qUnit: t.qUnit, rinv_ft: r.final.rinv_ft, dpSkin_psi: r.final.dpSkin_psi,
      conf: { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline }, chosen: r.chosen.key, fullySeen: r.chosen.fullySeen.status,
      kHeld: !!r.kHeld, excluded: t.status === 'excluded', excludedReason: t.statusReason, gasSprime: null, partialSuspect: t.partialSuspect,
      iarfDt0_h: r.iarf.dt0_h, dtEnd_h: t.dtEnd_h, dteEnd_h: r.bins.dte[r.bins.dte.length - 1], reachFair_h: r.reach.fair_h, reachGood_h: r.reach.good_h,
      reachFairShut_h: r.reach.fairShut_h, reachGoodShut_h: r.reach.goodShut_h, bins: { dte: r.bins.dte.slice(), dp: r.bins.dp.slice() },
    };
  });
  const finding = {
    id: 'F1', rule: 'V5', severity: 'suggestion', acceptable: true, where: 'S7',
    template: 'Confirmed delta alert at {test} with stable k (CV {cv}): review the well as a stimulation candidate.',
    values: { test: val(an.trend.alerts.delta.confirmedAt, null, 0, 'T2:confirmedAt'), cv: val(100 * an.trend.kStability.cv, 'percent', 1, 'T9:cv') },
    ev: ['T2', 'T9'], check: { ok: true, failures: [] },
    decision: { d: 'accept', note: 'Agreed: schedule a stimulation review.', who: 'Engineer A', at: '2026-07-02T10:00:00Z' },
  };
  const review = { version: 'r1', at: '2026-07-01T09:05:00Z', findings: [finding], counts: { critical: 0, major: 0, minor: 0, suggestion: 1 },
                   evidenceCheck: { ok: true, nChecked: 2, nFailed: 0 }, inputHash: an.inputHash, resultHash: an.resultHash };
  const answer = {
    q: 'What is k for B3?', intent: 'value', template: 'B3: k = {k}, S = {S} ± {Serr}, C = {C}.',
    values: { k: val(B3.result.final.k, 'permeability', 1, 'B3·A2:k'), S: val(B3.result.final.S, null, 2, 'B3·A2:S'),
              Serr: val(B3.result.sErr.value, null, 2, 'B3·U1:value'), C: val(B3.result.final.C, null, 4, 'B3·A2:C') },
    ev: ['B3·A2', 'B3·U1'], grounded: 'full', check: { ok: true, failures: [] }, followUps: ['Why is the confidence high for B3?'],
  };
  const report = {
    title: 'Build-up Surveillance', subtitle: 'Well A · DRAFT', status: 'DRAFT',
    sections: [
      { id: 'S1', title: 'Summary', blocks: [
        { kind: 'kpi', items: [{ label: 'Latest skin', value: val(B6.result.final.S, null, 2, 'B6·A2:S'), ev: ['B6·A2', 'B6·U1'] },
                               { label: 'Baseline skin', value: val(an.trend.baseline.S, null, 2, 'T1:S'), ev: ['T1'] }] },
        { kind: 'verdict', level: 'bad', template: 'Delta alert confirmed at {at} (raised at {raised}).',
          values: { at: val(an.trend.alerts.delta.confirmedAt, null, 0, 'T2:confirmedAt'), raised: val(an.trend.alerts.delta.raisedAt, null, 0, 'T2:raisedAt') }, ev: ['T2'] },
        { kind: 'verdict', level: 'warn', template: 'DRAFT: not signed off.', values: {}, ev: [] },
        { kind: 'notes', head: 'Assessment', template: 'Skin rose from {sb} to {s} with stable k; the rise is near the well.',
          values: { sb: val(an.trend.baseline.S, null, 2, 'T1:S'), s: val(B6.result.final.S, null, 2, 'B6·A2:S') }, ev: ['T1', 'T9', 'B6·A2'] },
        { kind: 'kv', rows: [{ label: 'k median', value: val(an.baseline.k, 'permeability', 1, 'T9:k'), ev: ['T9'] },
                             { label: 'Onset', value: { template: 'about day {d}', values: { d: val(an.trend.onset.tauDays, null, 0, 'T4:tauDays') } }, ev: ['T4'] }] },
      ] },
      { id: 'S4', title: 'Build-up tests', blocks: [
        { kind: 'table', id: 'bu_tbl_tests', head: [{ text: 'Test', cat: null }, { text: 'k', cat: 'permeability' }, { text: 'S', cat: null }],
          rows: an.tests.map((t) => [t.id, val(t.result.final.k, 'permeability', 1, t.id + '·A2:k'), val(t.result.final.S, null, 2, t.id + '·A2:S')]),
          ev: an.tests.map((t) => t.id + '·A2') },
        { kind: 'chart', id: 'bu_ch_skin', series: [{ name: 'Skin', cat: null, x: an.trend.series.map((s) => s.tDays), y: an.trend.series.map((s) => s.S) }] },
      ] },
    ],
    signature: null,
    reproducibility: { kind: 'notes', head: 'Notes', template: 'Reproducible: opening this project in the same app version and pressing Analyse gives the same displayed numbers.', values: {}, ev: [] },
  };
  // SynthCase: the reference case as the generator would emit it (single rate for 30 days = tp 720 h, closing at 09:00,
  // 72 h build-up, 60 s samples, exact allocation), with its own record and allocation rows.
  const R = FIX_REF;
  const truth = { model: 'homogeneous', k: R.k, S: R.S, C: R.C, h: R.h, phi: WELL.phi, mu: R.mu, B: R.B, ct: WELL.ct, rw: WELL.rw, q: R.q, D: null, extra: {} };
  const given = { h: 52, phi: 0.2, ct: 1.05e-5, rw: 0.354, B: 1.21, mu: 1 };
  const syn = genSynthRecord(ref);
  const caseSpec = {
    seed: 100000, stratum: 'hom', row: 0, truth, given,
    history: { days: R.tp / 24, variationPct: 0, earlierShutins: 0, truncate: false, intraDayChange: false, flushPct: 0, flushDecay_h: 0 },
    test: { closeHour: new Date(syn.tc).getUTCHours(), dtEnd_h: R.dtEnd, dtSample_s: 60, sigma: 0.02, sigmaFlowFactor: 1, ar1Rho: null, quant: 0, spikes: 0, drift_psi_d: 0,
            tide: { M2: 0, K1: 0 }, ramp_s: 0, partialBefore: null },
    alloc: { errPct: 0, bias: 0, ignoresShutin: false, hoursConflict_h: 0, resolution: 1 },
  };
  const f = 1.0;
  const kStar = FORMULAS.kStar(truth, given, f), SStar = FORMULAS.SStar(truth, given, f);
  const synth = {
    spec: caseSpec, record: syn.record, allocation: { rows: syn.rows }, rateTable: null,
    well: Object.assign({}, WELL, { h: given.h, ct: given.ct, B: given.B }),
    truth: { tc_ms: syn.tc, k: truth.k, S: truth.S, model: 'homogeneous', f, qCorrect: R.q, kStar, SStar,
             plateaus: [{ dt0_h: ref.result.iarf.dt0_h, dt1_h: ref.result.iarf.dt1_h, kStar, SStar }], visible: { fault: false, comp: false, closed: false, distractor: false },
             notAnalysable: false, partial: false },
  };
  const kHat = kStar * 1.02, SHat = SStar - 0.2;
  const score = { matched: true, status: 'interpreted', abstained: false, fullyRight: true, ksRight: true, kRight: true, sRight: true, modelRight: true, strict: true,
                  falseSeen: false, distractorCaught: null, dkPct: FORMULAS.dkPct(kHat, kStar), dS: SHat - SStar, rateErrPct: 0.4,
                  label: { ks: 'high', model: 'medium', headline: 'medium' }, _kHat: kHat, _SHat: SHat };
  const input = {
    record: Object.assign({}, record, { t: record.t.slice(), p: record.p.slice(), zone: Object.assign({}, record.zone), warnings: [] }), stored: null, allocation: { rows: A.rows, gUnit: 'Mscf', resolution: { oil: 0.1, gas: 0.1, water: 0.1 } }, rateTable: null,
    well: WELL, completion: null, depth: null, history: { mode: 'date', date: dateOf(PROD_START_MS), cum: null },
    zones: { gauge: { mode: 'device' }, day: { zone: { mode: 'device' }, startHour: 0 } },
    settings: SETTINGS, overrides: an.overrides, workovers: [], meta: META_FIX,
  };
  const signoff = { name: 'Reviewer B', role: 'Reservoir engineer', statement: true, at: '2026-07-02T11:00:00Z',
                    hash: 'a'.repeat(64), inputsHash: an.inputHash, resultsHash: an.resultHash, decisionsHash: autoInterp().hash16(autoInterp().canon([finding.decision], 'display')),
                    appVersion: '3.3', runAt: RUN_AT, decisions: 1, open: 0 };
  const evIndex = {
    items: { 'B3·I1': { id: 'B3·I1', group: 'I', test: 'B3', title: 'IARF window',
                        values: { grade: { v: B3.result.iarf.grade, cat: null, dp: 0, path: 'tests[2].result.iarf.grade' },
                                  cycles: { v: B3.result.iarf.cycles, cat: null, dp: 2, path: 'tests[2].result.iarf.cycles' } }, template: '{grade} IARF window ({cycles} cycle).' },
             T2: { id: 'T2', group: 'T', test: null, title: 'Delta alert', values: { status: { v: an.trend.alerts.delta.status, cat: null, dp: 0, path: 'trend.alerts.delta.status' } },
                   template: 'Delta alert: {status}.' } },
    order: ['B3·I1', 'T2'],
  };
  return { BuildupSpec: A.gens.B1.specMem, GaugeRecord: record, AnalysisInput: input, TrendTests: trendTests, Review: review, Finding: finding,
           Answer: answer, ReportModel: report, CaseSpec: caseSpec, SynthCase: synth, Score: score, Signoff: signoff, EvidenceIndex: evIndex,
           ModelFitFault: modelFitFault };
}

function deepFreeze(o) {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) if (o[i] && typeof o[i] === 'object') deepFreeze(o[i]); }
  else Object.keys(o).forEach((k) => deepFreeze(o[k]));
  return o;
}
let _fix = null;
function buildFix() {
  if (_fix) return _fix;
  const ref = genReference();
  ref.result.curves = (() => {
    const dt = [], hom = { dp: [], deriv: [] };
    for (let i = 0; i < 40; i++) dt.push(RES.dtFirst * Math.pow(72 / RES.dtFirst, i / 39));
    const r = ref.result;
    dt.forEach((x) => { const j = r.bins.dt.findIndex((y) => y >= x); const jj = j < 0 ? r.bins.dt.length - 1 : j; hom.dp.push(r.bins.dp[jj]); hom.deriv.push(r.bins.deriv[jj]); });
    return { dt, hom, chosen: null };
  })();
  const A = genAnalysis();
  const samples = genSamples(A, ref);
  const score = samples.Score;
  const scoreInputs = { kHat: score._kHat, SHat: score._SHat };
  delete score._kHat; delete score._SHat;
  _fix = {
    result: ref.result,
    analysis: A.analysis,
    samples,
    cal: fixCal(),
    inputs: { well: WELL, res: RES, settings: SETTINGS, plan: PLAN, reference: FIX_REF, e4S: E4_S,
              sampling: { shut_ms: SHUT_SAMPLE_MS, flow_ms: FLOW_SAMPLE_MS, resolution_psi: Math.pow(10, -P_RES_DP), firstShut_h: RES.dtFirst },
              origin_ms: ORIGIN_MS, prodStart_ms: PROD_START_MS, synProdStart_ms: SYN_PROD_START_MS, score: scoreInputs, specReference: ref.specMem },
  };
  deepFreeze(_fix);
  return _fix;
}
// Callers get a deep copy so a test can break a fixture without touching the cache (structuredClone: the records are
// tens of thousands of samples, and a JSON round trip of them would cost every access tens of milliseconds).
const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const FIX = {};
['result', 'analysis', 'samples', 'cal', 'inputs'].forEach((k) => Object.defineProperty(FIX, k, { enumerable: true, get: () => clone(buildFix()[k]) }));

module.exports = { checkShape, SHAPE_NAMES, SHAPES: Object.keys(SHAPES), FIX, FORMULAS, autoInterp, nearDisplay };
