// prism-build/tests/_dfit-shapes.js — DFIT executable contract (WP0, FROZEN).
//
// Plan: docs/DFIT-PLAN.md §3 (interfaces), §3.2 (inputs and the range table), §3.13 (this file), §4.21 (reference worked
// example). Changes only through the lead, together with an update of §3.13.
//
// Exports
//   checkShape(name, obj) → { ok, errors: ['<path>: <reason>', …] }   (path first, e.g. 'derivs.GdPdG[3]')
//       §3.13 names (SHAPE_NAMES): DfitDataset, DfitInputs, DfitState, DfitTest, DfitRun, Prepared, Events, Derivs, IsipResult,
//       StepDown, StepRate, Ramp, Hammer, ClosurePick, Consensus, ConsensusLite, Classification, FracOutputs, Triage, AcaResult,
//       LeakPlot, Uncertainty, LkConfig, LkResult, LkFit, Identify, DesignRanges, Design, LiveVerdict, EvidenceIndex,
//       ReportModel, HandoffPacket, CaseSpec. Helper names are also checkable: Failure, Warning, Summary, Block, AcaDiag, Job.
//   SHAPE_NAMES, SHAPES       the §3.13 names in plan order / every checkable name
//   RANGES                    the §3.2 range table {path: {min, max, def, unit, integer, scope, display?, rows?}} (frozen)
//   defaultInputs()           a complete DfitInputs with every §3.2 default (a fresh object per call)
//   clampInputs(inputs)       → { inputs, warnings } — the reference behaviour of PRiSM_dfit_inputRanges.clamp
//   clampValue(path, v)       → { value, warning|null } for one range-table field
//   FIX                       fixtures; every access returns a deep copy:
//       FIX.ds      the reference DFIT of §4.21 (600 points; committed data below, generated once by the prototype)
//       FIX.state   a complete st.dfit with two tests: t1 = the reference (single closure, high), t2 = the toy contact case of
//                   §4.7 / §6.2 C1 (closure RANGE 6,495–7,004 psia, medians 6,507 / 6,998, medium; user F1 hand-off choice,
//                   pick log with reasons, a leak-off model fit and a high-rate window index)
//       FIX.run     a complete DfitRun on FIX.ds (every stage filled; numbers from the §4.21 closed-form chain)
//       FIX.aca     the AcaResult of example B (§4.12, tight, linear only: k 0.0100 md, L 50 ft, p_i 4,500 psia, t_c 2 h)
//       FIX.samples one valid example for every other §3.13 shape (StepDown, StepRate, Ramp, Hammer, LkConfig, LkResult, LkFit,
//                   Identify, DesignRanges, Design, LiveVerdict, HandoffPacket, CaseSpec, Failure)
//       FIX.ref     the closed-form reference constants and chain (REF, chain(pClosure), forecast) the fixtures were built from
//   sharedApp(ctx, opts?)     one app per test FILE (opts:false files): created lazily through ctx.loadApp(opts) and kept in
//                             this module; a request from another file (or other opts) disposes the previous app first
//   resetDfit(app)            clears st.dfit, st._dfitRun, st._dfitWhatIf, every 'wts_prism_dfit*' storage key and the dfit
//                             field of the persisted wts_prism_state (after running a pending debounced save, manual timers)
//   dsHash(ds), inputHash(inputs), picksHash(picks), resultHash(summary)   frozen hash definitions (below)
//   rng(seed)                 the seeded PRNG used by the fixtures (mulberry32; never an unseeded generator)
//   G                         { g, gPrime, G, Ginv } closed forms α = ½ and α = 1 (§4.5) used to build the fixtures
//   autoInterp()              PRiSM_autoInterp (canon / hash16) from file 53, via _buildup-shapes
//
// Conventions encoded here (§3.0)
//   • Field units; engine time in hours. Record clock t (h since the first sample); shut-in time dt = t − ts; injection clock
//     tInj = t − tStart. AcaResult.t0, AcaResult.tcInj and acaDiag.x are on the INJECTION clock (x = tInj − t0).
//   • Rates in DFIT objects bbl/min; ds.q, ds.qFb and multiRate bbl/d; leak rates qk bbl/d. Volumes bbl; VwCw, Csys, AfCf
//     bbl/psi (§4.21 quotes ft³/psi: ÷ 5.614583); cf ft/psi; CL ft/√min; Gamma psi/√min; Ep psi (the UI shows 1e6 psi:
//     the range table stores psi and carries display {unit:'1e6 psi', scale:1e6}); areas ft²; widths in.
//   • Derivative arrays in Derivs (GdPdG, dPdG, sdPds, dPds, D, Dref, ppd) are MAGNITUDES (≥ 0 for a falling pressure);
//     dpIsip = ISIP − p. Display series may carry null for gaps (§3.0); prepared arrays (Prepared.t/pw/q/idx) never do.
//   • Null rule. In output shapes every plain numeric field accepts null (§3.0 "finite or null"); NaN, ±Infinity,
//     undefined and strings never pass. Fields written with '!' below are finite even in outputs (array samples, time
//     anchors). Input shapes (DfitDataset, DfitInputs, LkConfig, DesignRanges, CaseSpec) accept null only where §3 shows it,
//     and DfitInputs must lie inside the range table (stored inputs are clamped).
//   • Failure form (§3.0): {ok:false, code:'UPPER_SNAKE', errors:[string], bad:[fieldName]} passes every engine-output shape
//     (stubs return it with code 'NOT_IMPLEMENTED'). {} and null never pass. Because of that, checkShape alone passes a stub
//     or a failed run: every WP test that checks an engine output must ALSO assert result.ok === true next to checkShape.
//   • ClosurePick votes: F1 compliance, F1 loglog when independent (|ι| ≥ 0.05, sameEvidenceAs null), F2 tangent, F4
//     reopening and user picks in F1/F2/F4 may vote; crel, sqrt (at any ΔtD,c) and maxdpdg never vote; F0/F3 never vote; a
//     member with sameEvidenceAs set never votes.
//   • Numeric strings (range fields, event overrides): see parseRaw — WTS_parseNumber at call time when it follows the
//     decimal-comma option, else '1,5' → 1.5, '1,500' ambiguous → default with INPUT_DEFAULT, '1,500,000' → 1500000.
//   • Keys listed in §3 are required; '?' marks a key that may be absent. Extra keys are allowed. Enumerations are exact.
//   • Text (warnings, verdicts, reasons, evidence sentences): plain, < 300 characters, never the words null, undefined, NaN,
//     Infinity or '[object Object]'. Evidence ids /^[QXEIHSGCKMFALUPO]\d+$/ (§6.10 groups).
//   • Timestamps `at` are ISO 8601 strings. Test ids /^t\d+$/. Hashes are 16 lowercase hex characters.
//   • Hash definitions (frozen; 53's canon + hash16, v3.3):
//       dsHash(ds)          = hash16(canon({t: ds.t, p: ds.p, q: ds.q || null}, 'inputs'))
//       inputHash(inputs)   = hash16(canon(inputs, 'inputs'))          (DfitRun.inputsHash, summary.inputHash)
//       picksHash(picks)    = hash16(canon(picks, 'inputs'))
//       resultHash(summary) = hash16(canon({isip, closure, pn, eta, CL, Gamma, xf, R, pi, khmu, k, kLo, kHi, triage, grade}, 'display'))
//
// Fixture conventions (closed form; §4.21)
//   FIX.ds: 10 static samples at 4,500 psia (12 s apart), pump start t_start = 2 min, 120 pumping samples every 2.5 s at
//   5 bbl/min (7,200 bbl/d): wellbore ramp 6,323 psi/min to the breakdown 8,188.42 psia at t_start + 35 s, then an exponential
//   decay (0.25 min) onto a propagation line 7,933 → 7,953 psia; shut-in t_s = 7 min (tp 5.0 min, V_i 25 bbl); 470 falloff
//   samples log-spaced from Δt = 1 s to 72 h: p = 7,600 − (600/18)·G(ΔtD, α = ½) to closure (G_c 18.000, ΔtD,c 61.0187,
//   Δt_c 305.094 min), then the exact Carter linear line p = 4,500 + 2,500·F_L(t_inj) with F_L = (2/π)·asin√(t_c/t), t_c
//   measured from the start of injection (continuous at 7,000 psia). No noise; t to 1e-9 h, p to 0.01 psi.
//   FIX.run follows the §4.21 convention that the 25 bbl IS V_i* (no fill; the wellbore compression up to closure excluded
//   by definition), so Csys = η_G·V_i*/p_n = 0.2105 ft³/psi reads directly. An engine run on FIX.ds computes V_i* = V_i −
//   V_w·c_w·(σ_c − p_start) = 23.02 bbl and therefore a C_sys 7.9 % lower: FIX.run is a SHAPE and CONSISTENCY fixture, not
//   regression truth. ISIP candidates are the §4.4 P3a "given numbers" (wh 7,605, G 7,600.0, sd 7,595.5, lp 7,599.4 — FIX.ds
//   has no high-rate window and no step-down); their standard errors are chosen so the inverse-variance mean is 7,600.0.
//   Stability samples, uncertainty draws and bootstrap bands come from rng(seed) and are illustrative.
//   The after-closure line of FIX.ds (and FIX.run.aca) has m_L = σ_c − p_r = 2,500 psi, chosen for continuity at closure and
//   NOT derived from CL: its F_L-line k (3.46e-3 md) differs from the CL-based k of FIX.run.frac (2.75e-3 md) by about 26 %.
//   Tests and displays must not compare the two k values on FIX.run as a physical consistency check.
'use strict';

const path = require('path');

// ═════════════════════════════════════════════════════════════════════════════
// 1. canon / hash16 (file 53) and a seeded PRNG
// ═════════════════════════════════════════════════════════════════════════════
let _bu = null;
function autoInterp() { if (!_bu) _bu = require('./_buildup-shapes'); return _bu.autoInterp(); }
function hash16(s) { return autoInterp().hash16(s); }
function canon(o, mode) { return autoInterp().canon(o, mode); }
function dsHash(ds) { return hash16(canon({ t: ds.t, p: ds.p, q: ds.q || null }, 'inputs')); }
function inputHash(inputs) { return hash16(canon(inputs, 'inputs')); }
function picksHash(picks) { return hash16(canon(picks, 'inputs')); }
const RESULT_KEYS = ['isip', 'closure', 'pn', 'eta', 'CL', 'Gamma', 'xf', 'R', 'pi', 'khmu', 'k', 'kLo', 'kHi', 'triage', 'grade'];
function resultHash(sum) { const o = {}; RESULT_KEYS.forEach((k) => { o[k] = sum[k]; }); return hash16(canon(o, 'display')); }
function rng(seed) {
  let a = (seed == null ? 1 : seed) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

// ═════════════════════════════════════════════════════════════════════════════
// 2. Schema engine (the _buildup-shapes engine, DFIT types)
// ═════════════════════════════════════════════════════════════════════════════
const BANNED = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/;
const EV_RE = /^[QXEIHSGCKMFALUPO]\d+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTyped = (v) => ArrayBuffer.isView(v) && Object.prototype.toString.call(v) !== '[object DataView]';

const NUMERIC = new Set(['num', 'int', 'count', 'pos', 'nonneg', 'frac', 'psia', 'psi', 'h', 'dt', 'G', 'rate', 'vol']);
const TYPES = {
  any: (v) => v !== undefined,
  num: isNum,
  int: (v) => isNum(v) && Math.floor(v) === v,
  count: (v) => isNum(v) && Math.floor(v) === v && v >= 0,
  pos: (v) => isNum(v) && v > 0,
  nonneg: (v) => isNum(v) && v >= 0,
  frac: (v) => isNum(v) && v >= 0 && v <= 1,
  psia: (v) => isNum(v) && v > 0 && v < 1e5,
  psi: isNum,
  h: isNum,
  dt: (v) => isNum(v) && v > 0,
  G: (v) => isNum(v) && v >= 0,
  rate: (v) => isNum(v) && v >= 0,
  vol: isNum,
  str: (v) => typeof v === 'string',
  nestr: (v) => typeof v === 'string' && v.length > 0,
  text: (v) => typeof v === 'string' && v.length < 300 && !BANNED.test(v),
  bool: (v) => typeof v === 'boolean',
  obj: isObj,
  arr: Array.isArray,
  hex16: (v) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v),
  iso: (v) => typeof v === 'string' && ISO_RE.test(v) && isFinite(Date.parse(v)),
  upper: (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(v),
  testId: (v) => typeof v === 'string' && /^t\d+$/.test(v),
  evid: (v) => typeof v === 'string' && EV_RE.test(v),
  lvl: (v) => v === 'high' || v === 'medium' || v === 'low',
  fam: (v) => v === 'F0' || v === 'F1' || v === 'F2' || v === 'F3' || v === 'F4',
};
const TYPE_TEXT = {
  num: 'a finite number', int: 'an integer', count: 'an integer ≥ 0', pos: 'a number > 0', nonneg: 'a number ≥ 0', frac: 'a number in [0, 1]',
  psia: 'an absolute pressure in psia (> 0)', psi: 'a pressure in psi', h: 'hours', dt: 'a Δt in hours (> 0)', G: 'a G value (≥ 0)',
  rate: 'a rate (≥ 0)', vol: 'a volume', str: 'a string', nestr: 'a non-empty string', text: 'plain text < 300 characters', bool: 'a boolean',
  obj: 'an object', arr: 'an array', hex16: '16 lowercase hex characters', iso: 'an ISO 8601 timestamp', upper: 'an UPPER_SNAKE code',
  testId: "a test id 't<n>'", evid: 'an evidence id', lvl: "'high'|'medium'|'low'", fam: "a family 'F0'…'F4'", any: 'a value',
};

const _parsed = new Map();
function parseSpec(s) {
  if (_parsed.has(s)) return _parsed.get(s);
  const alts = s.split('|').map((t) => t.trim()).map((t) => {
    if (t[0] === "'") return { lit: t.slice(1, -1) };
    if (t === 'null') return { nul: true };
    if (t === 'true') return { lit: true };
    if (t === 'false') return { lit: false };
    if (/^-?\d+(\.\d+)?$/.test(t)) return { lit: +t };
    if (t[0] === '@') return { ref: t.slice(1) };
    const strict = t.endsWith('!');
    const name = strict ? t.slice(0, -1) : t;
    if (!TYPES[name]) throw new Error('_dfit-shapes: unknown type "' + name + '" in spec ' + s);
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
  const alts = typeof item === 'string' ? parseSpec(item) : null;
  const pred = alts && alts.length === 1 && alts[0].type ? TYPES[alts[0].type] : null;
  for (let i = 0; i < v.length && ctx.errors.length < ctx.max; i++) {
    if (!(pred && pred(v[i]))) check(item, v[i], p + '[' + i + ']', ctx);
    if (o.asc && i > 0 && isNum(v[i]) && isNum(v[i - 1]) && !(v[i] > v[i - 1])) err(ctx, p + '[' + i + ']', 'not strictly ascending');
    if (o.nondec && i > 0 && isNum(v[i]) && isNum(v[i - 1]) && v[i] < v[i - 1]) err(ctx, p + '[' + i + ']', 'decreasing');
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
  throw new Error('_dfit-shapes: bad spec at ' + p);
}
const SHAPES = {};
function def(name, out, spec, o) { SHAPES[name] = { out, spec, fail: !!(o && o.fail) }; }
function isFailure(v) { return isObj(v) && v.ok === false && Object.prototype.hasOwnProperty.call(v, 'code'); }
function checkNamed(name, v, p, ctx) {
  const sh = SHAPES[name];
  if (!sh) return err(ctx, p, 'unknown shape ' + name);
  const prev = ctx.out;
  ctx.out = sh.out;
  if (sh.fail && isFailure(v)) check(SHAPES.Failure.spec, v, p, ctx);
  else check(sh.spec, v, p, ctx);
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
// evidence-id arrays: non-empty unless {empty:true}; optionally restricted to a set of groups
function ev(o) {
  o = o || {};
  return function (v, p, ctx) {
    if (!Array.isArray(v)) return err(ctx, p, 'expected an array of evidence ids, got ' + describe(v));
    if (!v.length && !o.empty) return err(ctx, p, 'expected at least one evidence id');
    v.forEach((id, i) => {
      if (!TYPES.evid(id)) err(ctx, p + '[' + i + ']', 'expected an evidence id (§6.10 groups), got ' + describe(id));
      else if (o.groups && o.groups.indexOf(id[0]) === -1) err(ctx, p + '[' + i + ']', 'expected a ' + o.groups.split('').join('/') + ' id, got ' + id);
    });
  };
}
function rule(fn) { return function (v, p, ctx) { if (!isObj(v)) return; const m = fn(v); if (m) (Array.isArray(m) ? m : [m]).forEach((x) => err(ctx, x[0] ? join(p, x[0]) : p, x[1])); }; }
function getPath(o, pathStr) { return pathStr.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function sameLen(keys) {
  return rule((v) => {
    const present = keys.filter((k) => { const x = getPath(v, k); return x != null && (Array.isArray(x) || isTyped(x)); });
    if (!present.length) return null;
    const n = getPath(v, present[0]).length;
    const bad = present.filter((k) => getPath(v, k).length !== n);
    return bad.length ? bad.map((k) => [k, 'length ' + getPath(v, k).length + ' differs from ' + present[0] + ' (' + n + ')']) : null;
  });
}
const uniqueIds = (key) => rule((v) => {
  const a = v[key]; if (!Array.isArray(a)) return null;
  const seen = new Set(); const dup = [];
  a.forEach((x) => { if (x && x.id != null) { if (seen.has(x.id)) dup.push(x.id); seen.add(x.id); } });
  return dup.length ? [[key, 'duplicate id(s) ' + dup.join(', ')]] : null;
});
const ordered = (loKey, hiKey) => rule((v) => (isNum(v[loKey]) && isNum(v[hiKey]) && v[loKey] > v[hiKey]) ? [[loKey, loKey + ' > ' + hiKey]] : null);
const P3 = all({ p10: 'num', p50: 'num', p90: 'num' }, rule((v) => (isNum(v.p10) && isNum(v.p50) && isNum(v.p90) && !(v.p10 <= v.p50 && v.p50 <= v.p90)) ? [['', 'expected p10 ≤ p50 ≤ p90']] : null));
const P3p = (extra) => all(Object.assign({ p10: 'num', p50: 'num', p90: 'num' }, extra || {}), rule((v) => (isNum(v.p10) && isNum(v.p50) && isNum(v.p90) && !(v.p10 <= v.p50 && v.p50 <= v.p90)) ? [['', 'expected p10 ≤ p50 ≤ p90']] : null));

// ═════════════════════════════════════════════════════════════════════════════
// 3. The §3.2 range table (frozen in WP0; PRiSM_dfit_inputRanges in 56 carries the same table)
// ═════════════════════════════════════════════════════════════════════════════
// scope 'inputs' = a DfitInputs path; 'rows' = a row cap; 'designer' / 'synth' / 'sandbox' = fields outside DfitInputs.
// def null = "not set" is a valid value; def 'auto' = the string 'auto' is a valid value.
const IMAX = 2147483647;
const RANGES = {
  datumTvd:                 { min: 100, max: 40000, def: null, unit: 'ft', integer: false, scope: 'inputs' },
  datumMd:                  { min: 100, max: 40000, def: null, unit: 'ft', integer: false, scope: 'inputs' },
  'gauge.bhTvd':            { min: 0, max: 40000, def: null, unit: 'ft', integer: false, scope: 'inputs' },
  'gauge.bhMd':             { min: 0, max: 40000, def: null, unit: 'ft', integer: false, scope: 'inputs' },
  survey:                   { min: 0, max: 2000, def: null, unit: 'rows', integer: true, scope: 'rows', rows: true },
  strings:                  { min: 0, max: 10, def: null, unit: 'rows', integer: true, scope: 'rows', rows: true },
  tests:                    { min: 0, max: 12, def: null, unit: 'rows', integer: true, scope: 'rows', rows: true },
  'fluid.rhoPpg':           { min: 6, max: 20, def: 8.43, unit: 'ppg', integer: false, scope: 'inputs' },
  'fluid.salinityWt':       { min: 0, max: 30, def: null, unit: 'wt %', integer: false, scope: 'inputs' },
  'fluid.muCp':             { min: 0.1, max: 5000, def: 1.0, unit: 'cp', integer: false, scope: 'inputs' },
  'fluid.fr':               { min: 0, max: 0.85, def: 0, unit: '–', integer: false, scope: 'inputs' },
  'fluid.nPrime':           { min: 0.1, max: 1, def: null, unit: '–', integer: false, scope: 'inputs' },
  'fluid.kPrime':           { min: 1e-6, max: 1, def: null, unit: 'lbf·sⁿ/ft²', integer: false, scope: 'inputs' },
  'fluid.tInjF':            { min: 32, max: 300, def: 70, unit: '°F', integer: false, scope: 'inputs' },
  'temp.surfF':             { min: -20, max: 150, def: 70, unit: '°F', integer: false, scope: 'inputs' },
  'temp.gradFper100':       { min: 0.5, max: 4, def: 1.5, unit: '°F/100 ft', integer: false, scope: 'inputs' },
  'temp.tauLoH':            { min: 0.05, max: 24, def: 0.5, unit: 'h', integer: false, scope: 'inputs' },
  'temp.tauHiH':            { min: 0.1, max: 72, def: 5, unit: 'h', integer: false, scope: 'inputs' },
  'perfs.n':                { min: 1, max: 2000, def: null, unit: '–', integer: true, scope: 'inputs' },
  'perfs.dIn':              { min: 0.1, max: 1.5, def: 0.40, unit: 'in', integer: false, scope: 'inputs' },
  'perfs.cd':               { min: 0.4, max: 1.0, def: 0.62, unit: '–', integer: false, scope: 'inputs' },
  'rock.Ep':                { min: 1e5, max: 2e7, def: null, unit: 'psi', integer: false, scope: 'inputs', display: { unit: '1e6 psi', scale: 1e6 } },
  'rock.nu':                { min: 0.05, max: 0.45, def: 0.25, unit: '–', integer: false, scope: 'inputs' },
  'rock.hf':                { min: 1, max: 5000, def: null, unit: 'ft', integer: false, scope: 'inputs' },
  'rock.hp':                { min: 1, max: 5000, def: null, unit: 'ft', integer: false, scope: 'inputs' },
  'rock.barrierSpacing':    { min: 1, max: 5000, def: null, unit: 'ft', integer: false, scope: 'inputs' },
  'rock.sigmaVGrad':        { min: 0.7, max: 1.3, def: 1.0, unit: 'psi/ft', integer: false, scope: 'inputs' },
  'rock.sigmaVGradLo':      { min: 0.7, max: 1.3, def: 0.9, unit: 'psi/ft', integer: false, scope: 'inputs' },
  'rock.muFricWarn':        { min: 0.3, max: 1.2, def: 0.6, unit: '–', integer: false, scope: 'inputs' },
  'rock.muFricVeto':        { min: 0.3, max: 1.2, def: 1.0, unit: '–', integer: false, scope: 'inputs' },
  'rock.biot':              { min: 0, max: 1, def: 1.0, unit: '–', integer: false, scope: 'inputs' },
  'priors.sigmaGrad':       { min: 0.4, max: 1.3, def: null, unit: 'psi/ft', integer: false, scope: 'inputs' },
  'priors.sigmaGradSd':     { min: 0.005, max: 0.2, def: 0.02, unit: 'psi/ft', integer: false, scope: 'inputs' },
  'priors.piGrad':          { min: 0.2, max: 1.0, def: null, unit: 'psi/ft', integer: false, scope: 'inputs' },
  'channels.atmPsia':       { min: 10, max: 15.2, def: 14.696, unit: 'psia', integer: false, scope: 'inputs' },
  'channels.clockOffsetH':  { min: -24, max: 24, def: 0, unit: 'h', integer: false, scope: 'inputs' },
  'options.alphaGeneral':   { min: 0.51, max: 1, def: 0.75, unit: '–', integer: false, scope: 'inputs' },
  'options.L':              { min: 0.05, max: 0.4, def: 0.1, unit: 'ln units', integer: false, scope: 'inputs' },
  'options.gMin':           { min: 0, max: 50, def: 'auto', unit: 'G', integer: false, scope: 'inputs' },
  'options.eps.compliance': { min: 0.005, max: 0.3, def: 0.02, unit: '–', integer: false, scope: 'inputs' },
  'options.eps.tangent':    { min: 0.005, max: 0.3, def: 0.02, unit: '–', integer: false, scope: 'inputs' },
  'options.eps.loglog':     { min: 0.005, max: 0.3, def: 0.05, unit: '–', integer: false, scope: 'inputs' },
  'options.tau.abs':        { min: 1, max: 200, def: 15, unit: 'psi', integer: false, scope: 'inputs' },
  'options.tau.fSigma':     { min: 0, max: 0.02, def: 0.003, unit: '–', integer: false, scope: 'inputs' },
  'options.tau.fN':         { min: 0, max: 0.2, def: 0.03, unit: '–', integer: false, scope: 'inputs' },
  'options.familyWeightF1': { min: 0, max: 1, def: 0.5, unit: '–', integer: false, scope: 'inputs' },
  'options.aca.LB':         { min: 0.1, max: 0.5, def: 0.25, unit: 'ln units', integer: false, scope: 'inputs' },
  'options.unc.n':          { min: 100, max: 2000, def: 1000, unit: 'draws', integer: true, scope: 'inputs' },
  'options.unc.seed':       { min: 1, max: IMAX, def: 1, unit: '–', integer: true, scope: 'inputs' },
  'designer.n':             { min: 50, max: 2000, def: 500, unit: 'draws', integer: true, scope: 'designer' },
  'designer.seed':          { min: 1, max: IMAX, def: 1, unit: '–', integer: true, scope: 'designer' },
  'synth.seed':             { min: 1, max: IMAX, def: 1, unit: '–', integer: true, scope: 'synth' },
  'sandbox.V':              { min: 0.1, max: 2000, def: 25, unit: 'bbl', integer: false, scope: 'sandbox' },
  'sandbox.q':              { min: 0.05, max: 100, def: 5, unit: 'bbl/min', integer: false, scope: 'sandbox' },
  'sandbox.tEnd':           { min: 0.01, max: 10000, def: 300, unit: 'h', integer: false, scope: 'sandbox' },
};
const ENUMS = {
  'fluid.kind': ['water', 'slickwater', 'gel', 'oil'],
  'temp.model': ['static', 'displaced', 'ramey'],
  'rock.EpSource': ['static', 'dynamic-corrected', 'dynamic', 'unknown'],
  'channels.primary': ['bh', 'surface'],
  'options.alpha': ['auto', 0.5, 1, 'general', 'data'],
  'options.tp': ['pump', 'breakdown', 'veq'],
  'options.aca.origin': ['centroid', 'total', 'midInjection', 'sinceClosure'],
  'options.aca.tideRemove': ['auto', 'on', 'off'],
};
function defaultInputs() {
  return {
    datumTvd: null, datumMd: null, survey: null,
    gauge: { bhTvd: null, bhMd: null },
    strings: [],
    fluid: { kind: 'water', rhoPpg: 8.43, salinityWt: null, muCp: 1.0, fr: 0, nPrime: null, kPrime: null, tInjF: 70 },
    temp: { model: 'static', surfF: 70, gradFper100: 1.5, tauLoH: 0.5, tauHiH: 5 },
    perfs: { n: null, dIn: 0.40, cd: 0.62 },
    rock: { Ep: null, EpSource: 'unknown', nu: 0.25, hf: null, hp: null, barrierSpacing: null,
            sigmaVGrad: 1.0, sigmaVGradLo: 0.9, muFricWarn: 0.6, muFricVeto: 1.0, biot: 1.0 },
    priors: { sigmaGrad: null, sigmaGradSd: 0.02, piGrad: null },
    channels: { primary: 'bh', psig: { p: false, pSurf: false, pAnn: false }, atmPsia: 14.696, clockOffsetH: 0,
                unitFix: { p: null, pSurf: null, q: null, t: null }, depthFix: null, mask: [] },
    events: { tStart: null, tb: null, ts: null, flowback: null },
    options: {
      alpha: 'auto', alphaGeneral: 0.75, tp: 'pump', L: 0.1, gMin: 'auto',
      eps: { compliance: 0.02, tangent: 0.02, loglog: 0.05 },
      tau: { abs: 15, fSigma: 0.003, fN: 0.03 },
      familyWeightF1: 0.5, axisLock: false, ppd: false,
      aca: { origin: 'centroid', LB: 0.25, carterExactFR: false, tideRemove: 'auto' },
      unc: { n: 1000, seed: 1 },
      triage: {},
    },
  };
}
function fmtNum(x) { return Math.abs(x) >= 1e6 || (x !== 0 && Math.abs(x) < 1e-3) ? x.toExponential(3).replace('e+', 'e') : String(+x.toPrecision(6)); }
// Parse a raw field value: numbers pass; blank = undefined, null or an all-space string; anything else is unparsable
// (→ default). Strings without a comma must match a strict decimal pattern. A string with a comma is read, at call time,
// with WTS_parseNumber (50-a11y) when that parser follows the decimal-comma option (WTS_parseNumber('1,5') === 1.5) and the
// string has the 'digits,digits' form. Otherwise (no parser, or the option off) the fallback rule applies:
//   '1,5' / '12,25' (one comma, no point, not three digits after it) → decimal comma: 1.5 / 12.25;
//   '1,500' (one comma followed by exactly three digits, no point) → AMBIGUOUS (thousands separator or decimal comma): unparsable;
//   '1,500,000' and '1,500.5' (well-formed thousands groups) → 1500000 / 1500.5; any other comma → unparsable.
const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const DEC_COMMA_RE = /^[-+]?\d*,\d+(e[-+]?\d+)?$/i;
function parseRaw(v) {
  if (v === undefined || v === null) return { blank: true };
  if (typeof v === 'number') return isFinite(v) ? { num: v } : { bad: true };
  if (typeof v !== 'string') return { bad: true };
  const s = v.replace(/^\s+|\s+$/g, '');
  if (!s) return { blank: true };
  let t = s;
  if (s.indexOf(',') !== -1) {
    const pn = typeof globalThis.WTS_parseNumber === 'function' ? globalThis.WTS_parseNumber : null;
    if (pn && DEC_COMMA_RE.test(s) && pn('1,5') === 1.5) { const y = pn(s); return (typeof y === 'number' && isFinite(y)) ? { num: y } : { bad: true }; }
    if (/^[-+]?\d+,\d+$/.test(s)) {
      if (/^[-+]?\d{1,3},\d{3}$/.test(s)) return { bad: true, ambiguous: true };
      t = s.replace(',', '.');
    } else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) t = s.replace(/,/g, '');
    else return { bad: true };
  }
  if (!NUM_RE.test(t)) return { bad: true };
  const x = Number(t);
  return isFinite(x) ? { num: x } : { bad: true };
}
function clampValue(pathStr, v) {
  const r = RANGES[pathStr];
  if (!r) throw new Error('_dfit-shapes: no range for ' + pathStr);
  if (r.def === 'auto' && v === 'auto') return { value: 'auto', warning: null };
  const raw = parseRaw(v);
  const W = (code, text) => ({ code, level: 'warn', text, ev: [] });
  if (raw.blank) {
    if (r.def === null || r.def === 'auto') return { value: r.def, warning: null };
    return { value: r.def, warning: W('INPUT_DEFAULT', pathStr + ' was blank; the default ' + fmtNum(r.def) + ' ' + r.unit + ' is used.') };
  }
  if (raw.bad) {
    return { value: r.def, warning: W('INPUT_DEFAULT', pathStr + (raw.ambiguous ? ' ' + v.trim() + ' is ambiguous (a thousands separator or a decimal comma); ' : ' could not be read as a number; ') + (r.def === null ? 'it is left unset.' : 'the default ' + (r.def === 'auto' ? 'auto' : fmtNum(r.def) + ' ' + r.unit) + ' is used.')) };
  }
  let x = raw.num;
  if (r.integer) x = Math.round(x);
  if (x < r.min) return { value: r.min, warning: W('INPUT_CLAMPED', pathStr + ' ' + fmtNum(raw.num) + ' is below the minimum ' + fmtNum(r.min) + ' ' + r.unit + '; ' + fmtNum(r.min) + ' is used.') };
  if (x > r.max) return { value: r.max, warning: W('INPUT_CLAMPED', pathStr + ' ' + fmtNum(raw.num) + ' is above the maximum ' + fmtNum(r.max) + ' ' + r.unit + '; ' + fmtNum(r.max) + ' is used.') };
  if (x === 0) x = 0;   // −0 → 0
  return { value: x, warning: (r.integer && x !== raw.num) ? W('INPUT_ROUNDED', pathStr + ' ' + fmtNum(raw.num) + ' is rounded to the integer ' + x + '.') : null };
}
function setPath(o, pathStr, v) { const ks = pathStr.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) { if (!isObj(a[ks[i]])) a[ks[i]] = {}; a = a[ks[i]]; } a[ks[ks.length - 1]] = v; }
function mergeDefaults(dst, src) {
  if (!isObj(src)) return dst;
  Object.keys(src).forEach((k) => {
    if (isObj(dst[k]) && isObj(src[k])) mergeDefaults(dst[k], src[k]);
    else if (src[k] !== undefined) dst[k] = JSON.parse(JSON.stringify(src[k]));
  });
  return dst;
}
// The reference clamp (PRiSM_dfit_inputRanges.clamp in 56 is the same, step for step and warning for warning):
//   1. defaults completed; a non-object where the defaults hold an object → the default object (INPUT_DEFAULT)
//   2. every 'inputs' range-table field through clampValue
//   3. survey / strings: a non-list → unset / no string (INPUT_DEFAULT); invalid rows dropped (ROWS_DROPPED): a survey row is
//      [md, tvd] with finite numbers and MD strictly ascending; a string row has id, od, wall > 0, id < od and finite
//      topMd < botMd (an invalid tubKey becomes null); then the row caps (ROWS_TRUNCATED)
//   4. enums → default when not allowed (INPUT_DEFAULT)
//   5. flags (psig.*, axisLock, ppd, aca.carterExactFR): true / false kept, 'true' / 1 and 'false' / 0 coerced, else the
//      default (INPUT_DEFAULT)
//   6. channels.unitFix.* → null unless {kind: non-empty string, factor, offset: finite}; channels.depthFix → null unless an
//      object; channels.mask → only [t0, t1, why] rows with finite t0 < t1 (why '' when not a string; ROWS_DROPPED)
//   7. events.tStart / tb / ts → finite numbers or null (parsed like range fields); events.flowback → null unless finite
//      t0 ≤ t1 (INPUT_DEFAULT)
const W_ = (code, text) => ({ code, level: 'warn', text, ev: [] });
const FLAGS = ['channels.psig.p', 'channels.psig.pSurf', 'channels.psig.pAnn', 'options.axisLock', 'options.ppd', 'options.aca.carterExactFR'];
function repairObjects(out, def, prefix, warnings) {
  Object.keys(def).forEach((k) => {
    if (!isObj(def[k])) return;
    const p = prefix ? prefix + '.' + k : k;
    if (!isObj(out[k])) { out[k] = JSON.parse(JSON.stringify(def[k])); warnings.push(W_('INPUT_DEFAULT', p + ' is not a group of fields; its defaults are used.')); return; }
    repairObjects(out[k], def[k], p, warnings);
  });
}
const plural = (n) => (n === 1 ? '1 row is' : n + ' rows are');
function clampInputs(inputs) {
  const out = mergeDefaults(defaultInputs(), isObj(inputs) ? inputs : {});
  const warnings = [];
  repairObjects(out, defaultInputs(), '', warnings);
  Object.keys(RANGES).forEach((k) => {
    const r = RANGES[k];
    if (r.scope !== 'inputs') return;
    const c = clampValue(k, getPath(out, k));
    setPath(out, k, c.value);
    if (c.warning) warnings.push(c.warning);
  });
  // rows
  if (out.survey !== null && !Array.isArray(out.survey)) { out.survey = null; warnings.push(W_('INPUT_DEFAULT', 'survey is not a list of rows; it is left unset.')); }
  if (!Array.isArray(out.strings)) { out.strings = []; warnings.push(W_('INPUT_DEFAULT', 'strings is not a list of rows; no string is used.')); }
  if (Array.isArray(out.survey)) {
    const keep = []; let last = -Infinity;
    out.survey.forEach((row) => { if (Array.isArray(row) && row.length >= 2 && isNum(row[0]) && isNum(row[1]) && row[0] > last) { keep.push([row[0], row[1]]); last = row[0]; } });
    if (keep.length !== out.survey.length) warnings.push(W_('ROWS_DROPPED', 'survey: ' + plural(out.survey.length - keep.length) + ' not [MD, TVD] pairs of finite numbers with MD ascending; dropped.'));
    out.survey = keep;
  }
  {
    const keep = [];
    out.strings.forEach((row) => {
      if (!isObj(row)) return;
      if (!(isNum(row.id) && isNum(row.od) && isNum(row.wall) && row.id > 0 && row.od > 0 && row.wall > 0 && row.id < row.od)) return;
      if (!(isNum(row.topMd) && isNum(row.botMd) && row.topMd < row.botMd)) return;
      const c = JSON.parse(JSON.stringify(row));
      if (!(typeof c.tubKey === 'string' && c.tubKey.length > 0)) c.tubKey = null;
      keep.push(c);
    });
    if (keep.length !== out.strings.length) warnings.push(W_('ROWS_DROPPED', 'strings: ' + plural(out.strings.length - keep.length) + ' without id < od, wall > 0 and top MD < bottom MD; dropped.'));
    out.strings = keep;
  }
  ['survey', 'strings'].forEach((k) => {
    const a = out[k];
    if (Array.isArray(a) && a.length > RANGES[k].max) {
      out[k] = a.slice(0, RANGES[k].max);
      warnings.push(W_('ROWS_TRUNCATED', k + ' has ' + a.length + ' rows; the first ' + RANGES[k].max + ' are kept.'));
    }
  });
  // enums
  Object.keys(ENUMS).forEach((k) => {
    const v = getPath(out, k);
    if (ENUMS[k].indexOf(v) === -1) {
      const d = getPath(defaultInputs(), k);
      setPath(out, k, d);
      warnings.push(W_('INPUT_DEFAULT', k + ' is not one of the allowed values; ' + d + ' is used.'));
    }
  });
  // flags
  FLAGS.forEach((k) => {
    const v = getPath(out, k);
    if (v === true || v === false) return;
    if (v === 'true' || v === 1) { setPath(out, k, true); return; }
    if (v === 'false' || v === 0) { setPath(out, k, false); return; }
    const d = getPath(defaultInputs(), k);
    setPath(out, k, d);
    warnings.push(W_('INPUT_DEFAULT', k + ' is not true or false; ' + d + ' is used.'));
  });
  // channels: unit fixes, depth fix, mask
  const ch = out.channels;
  ['p', 'pSurf', 'q', 't'].forEach((k) => {
    const f = ch.unitFix[k];
    if (f === null) return;
    if (isObj(f) && typeof f.kind === 'string' && f.kind.length > 0 && isNum(f.factor) && isNum(f.offset)) return;
    ch.unitFix[k] = null;
    warnings.push(W_('INPUT_DEFAULT', 'channels.unitFix.' + k + ' is not a unit fix (kind, factor, offset); no fix is applied.'));
  });
  if (ch.depthFix !== null && !isObj(ch.depthFix)) { ch.depthFix = null; warnings.push(W_('INPUT_DEFAULT', 'channels.depthFix is not a depth fix; no fix is applied.')); }
  if (!Array.isArray(ch.mask)) { ch.mask = []; warnings.push(W_('INPUT_DEFAULT', 'channels.mask is not a list of windows; nothing is masked.')); }
  {
    const keep = [];
    ch.mask.forEach((m) => { if (Array.isArray(m) && m.length >= 2 && isNum(m[0]) && isNum(m[1]) && m[0] < m[1]) keep.push([m[0], m[1], typeof m[2] === 'string' ? m[2] : '']); });
    if (keep.length !== ch.mask.length) warnings.push(W_('ROWS_DROPPED', 'channels.mask: ' + plural(ch.mask.length - keep.length) + ' not [t0, t1, why] windows with t0 < t1; dropped.'));
    ch.mask = keep;
  }
  // events (user overrides)
  const evs = out.events;
  ['tStart', 'tb', 'ts'].forEach((k) => {
    const raw = parseRaw(evs[k]);
    if (raw.blank) { evs[k] = null; return; }
    if (raw.bad) { evs[k] = null; warnings.push(W_('INPUT_DEFAULT', 'events.' + k + ' could not be read as a time; the detected event is used.')); return; }
    evs[k] = raw.num === 0 ? 0 : raw.num;
  });
  if (evs.flowback !== null) {
    const fb = evs.flowback;
    if (isObj(fb) && isNum(fb.t0) && isNum(fb.t1) && fb.t0 <= fb.t1) { /* valid */ } else {
      evs.flowback = null;
      warnings.push(W_('INPUT_DEFAULT', 'events.flowback is not a window with t0 ≤ t1; the detected flowback is used.'));
    }
  }
  return { inputs: out, warnings };
}
// range rule used by the DfitInputs shape (stored inputs are clamped)
const IN_RANGE = rule((v) => {
  const out = [];
  Object.keys(RANGES).forEach((k) => {
    const r = RANGES[k];
    if (r.scope !== 'inputs') return;
    const x = getPath(v, k);
    if (x === null && r.def === null) return;
    if (x === 'auto' && r.def === 'auto') return;
    if (x === undefined) return;   // reported as missing by the structure check
    if (!isNum(x)) { out.push([k, 'expected a number in [' + r.min + ', ' + r.max + '], got ' + describe(x)]); return; }
    if (x < r.min || x > r.max) out.push([k, 'outside the range table [' + r.min + ', ' + r.max + '] ' + r.unit + ': ' + x]);
    if (r.integer && Math.floor(x) !== x) out.push([k, 'expected an integer, got ' + x]);
  });
  if (Array.isArray(v.survey) && v.survey.length > RANGES.survey.max) out.push(['survey', 'more than ' + RANGES.survey.max + ' rows']);
  if (Array.isArray(v.strings) && v.strings.length > RANGES.strings.max) out.push(['strings', 'more than ' + RANGES.strings.max + ' rows']);
  return out.length ? out : null;
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Shapes (§3)
// ═════════════════════════════════════════════════════════════════════════════
const LVL = "'high'|'medium'|'low'";
const FAMS = "'F0'|'F1'|'F2'|'F3'|'F4'";
const METHODS = "'tangent'|'sqrt'|'maxdpdg'|'compliance'|'crel'|'loglog'|'varcomp'|'model'|'fissure'|'reopening'|'user'";
const CTYPE = "'normal'|'matrix'|'pdl'|'tip'|'hr-contact'|'storage'|'undetermined'";
const GEOM = "'PKN'|'KGD'|'radial'";
const ORIGIN = "'centroid'|'total'|'midInjection'|'sinceClosure'";
const STAT = all({ p10: 'num', p50: 'num', p90: 'num', sigma: 'nonneg', n: 'count' }, ordered('p10', 'p50'), ordered('p50', 'p90'));
const LIMIT = { rule: 'nestr', text: 'text', value: 'num', limit: 'num' };

// ── common ──
def('Failure', true, { ok: 'false', code: 'upper', errors: ['str'], bad: ['str'] });
def('Warning', true, { code: 'upper', level: "'info'|'warn'|'bad'", text: 'text', ev: ev({ empty: true }) });
def('Job', false, (v, p, ctx) => {
  if (!isObj(v)) return err(ctx, p, 'expected a Job object, got ' + describe(v));
  ['step', 'result', 'cancel'].forEach((k) => { if (typeof v[k] !== 'function') err(ctx, join(p, k), 'expected a function'); });
});

// ── DfitDataset (§3.1; input) ──
const DS_CH = ['pSurf', 'pBh', 'qFb', 'T', 'pAnn'];
def('DfitDataset', false, all({
  t: arr('num!', { min: 2, nondec: true }), p: arr('psia!', { min: 2 }), q: { $orNull: arr('rate!') },
  'pSurf?': arr('psia!'), 'pBh?': arr('psia!'), 'qFb?': arr('rate!'), 'T?': arr('num!'), 'pAnn?': arr('psia!'),
  'name?': 'str', 'source?': 'str', 'timeUnit?': "'h'", 'timeUnitOriginal?': 'str', 'rateUnit?': "'bbl/d'|'STB/d'", 'ratePhase?': 'str',
  'meta?': { 'psigConverted?': { 'p?': 'pos', 'pSurf?': 'pos', 'pAnn?': 'pos' } },
}, sameLen(['t', 'p', 'q'].concat(DS_CH))));

// ── DfitInputs (§3.2; input, clamped) ──
const UNITFIX = orNull({ kind: 'nestr', factor: 'num', offset: 'num' });
def('DfitInputs', false, all({
  datumTvd: 'num|null', datumMd: 'num|null',
  survey: orNull(arr(tuple('num', 'num'))),
  gauge: { bhTvd: 'num|null', bhMd: 'num|null' },
  strings: arr({ tubKey: 'nestr|null', id: 'pos', od: 'pos', wall: 'pos', topMd: 'num', botMd: 'num' }),
  fluid: { kind: "'water'|'slickwater'|'gel'|'oil'", rhoPpg: 'num', salinityWt: 'num|null', muCp: 'num', fr: 'num', nPrime: 'num|null', kPrime: 'num|null', tInjF: 'num' },
  temp: { model: "'static'|'displaced'|'ramey'", surfF: 'num', gradFper100: 'num', tauLoH: 'num', tauHiH: 'num' },
  perfs: { n: 'int|null', dIn: 'num', cd: 'num' },
  rock: { Ep: 'num|null', EpSource: "'static'|'dynamic-corrected'|'dynamic'|'unknown'", nu: 'num', hf: 'num|null', hp: 'num|null', barrierSpacing: 'num|null',
          sigmaVGrad: 'num', sigmaVGradLo: 'num', muFricWarn: 'num', muFricVeto: 'num', biot: 'num' },
  priors: { sigmaGrad: 'num|null', sigmaGradSd: 'num', piGrad: 'num|null' },
  channels: { primary: "'bh'|'surface'", psig: { p: 'bool', pSurf: 'bool', pAnn: 'bool' }, atmPsia: 'num', clockOffsetH: 'num',
              unitFix: { p: UNITFIX, pSurf: UNITFIX, q: UNITFIX, t: UNITFIX }, depthFix: 'obj|null', mask: arr(tuple('num', 'num', 'str')) },
  events: { tStart: 'num|null', tb: 'num|null', ts: 'num|null', flowback: orNull(all({ t0: 'num', t1: 'num' }, ordered('t0', 't1'))) },
  options: {
    alpha: "'auto'|0.5|1|'general'|'data'", alphaGeneral: 'num', tp: "'pump'|'breakdown'|'veq'", L: 'num', gMin: "'auto'|num",
    eps: { compliance: 'num', tangent: 'num', loglog: 'num' }, tau: { abs: 'num', fSigma: 'num', fN: 'num' },
    familyWeightF1: 'num', axisLock: 'bool', ppd: 'bool',
    aca: { origin: ORIGIN, LB: 'num', carterExactFR: 'bool', tideRemove: "'auto'|'on'|'off'" },
    unc: { n: 'int', seed: 'int' }, triage: 'obj',
  },
}, IN_RANGE));

// ── Summary (§3.3 DfitTest.summary; output) ──
const FAM_P50 = { F1: orNull({ p50: 'psia' }), F2: orNull({ p50: 'psia' }), F4: orNull({ p50: 'psia' }) };
def('Summary', true, {
  at: 'iso', dsHash: 'hex16', inputHash: 'hex16', resultHash: 'hex16', stale: 'bool', forOtherDataset: 'bool',
  isip: { value: 'psia', spread: 'nonneg', label: "'high'|'medium'|'low'|null" },
  closure: all({ mode: "'single'|'range'|'none'", value: 'psia', lo: 'psia', hi: 'psia', label: "'high'|'medium'|'low'|'not-estimable'", families: FAM_P50 },
    rule((v) => {
      if (v.mode === 'single' && !isNum(v.value)) return [['value', 'single mode needs a value']];
      if (v.mode === 'single' && v.label === 'not-estimable') return [['label', "'not-estimable' only goes with mode none"]];
      if (v.mode === 'range' && !(isNum(v.lo) && isNum(v.hi) && v.lo < v.hi)) return [['lo', 'range mode needs lo < hi']];
      if (v.mode === 'range' && v.value != null) return [['value', 'range mode has no value']];
      if (v.mode === 'none' && (v.value != null || v.lo != null || v.hi != null)) return [['value', 'mode none has no value or range']];
      return null;
    })),
  pn: 'psi', eta: 'frac', CL: 'nonneg', Gamma: 'nonneg', xf: 'nonneg', R: 'nonneg', model: "'PKN'|'KGD'|'radial'|null",
  pi: { value: 'psia', lo: 'psia', hi: 'psia', label: "'high'|'medium'|'low'|null" },
  khmu: 'nonneg', k: 'nonneg', kLo: 'nonneg', kHi: 'nonneg',
  triage: "'green'|'amber'|'red'|null", grade: "'A'|'B'|'C'|'D'|null", unc: { seed: 'int', n: 'count' },
  gdpdgN: all({ x: arr('num!', { max: 60 }), y: arr('num!', { max: 60 }) }, sameLen(['x', 'y'])),
});

// ── LkConfig (§3.7; input, display units) ──
def('LkConfig', false, {
  mode: "'propagate'|'prescribed'|'constP'", geometry: GEOM,
  schedule: arr({ t: 'num', q: 'rate' }, { min: 1 }),
  Ep: 'pos', nu: 'num', hf: 'pos', hp: 'pos', muCp: 'pos', KIc: 'nonneg', viscCal: 'pos',
  Cw: 'nonneg', k: 'pos|null', Sp: 'nonneg',
  pdl: { Cd: 'nonneg', pfo: 'psia|null', fmax: 'pos' }, sigmaC: 'psia', pr: 'psia', VwCw: 'nonneg',
  nwb: orNull({ a: 'nonneg', b: 'nonneg', beta: 'pos' }), pBd: 'psia|null', L0: 'pos',
  aperture: { law: "'none'|'exp'|'hyp'", sh: 'pos', sc: 'pos', fres: 'frac', sr: 'pos|null' }, tip: { tauX: 'pos|null' }, farField: 'bool',
  tEnd: 'pos', phi: 'pos', ct: 'pos', muRes: 'pos', CL: 'pos|null', wc: 'pos|null',
});

// ── DfitTest, DfitState (§3.3; stored) ──
const AT = 'iso';
def('DfitTest', true, all({
  id: 'testId', zone: 'str',
  dsRef: orNull({ kind: "'data-tab'|'gauge'|'demo'", id: 'nestr|null', name: 'str', hash: 'hex16', n: 'count' }),
  inputs: '@DfitInputs',
  picks: {
    isip: orNull({ value: 'psia!', method: 'nestr', source: "'auto'|'user'", reason: 'str', at: AT }),
    closure: orNull(all({ mode: "'consensus'|'family'|'user'", family: FAMS + '|null', method: METHODS + "|'consensus'|null", p: 'psia!', dt: 'dt', source: "'auto'|'user'", reason: 'str', at: AT },
      rule((v) => {
        if (v.mode === 'family' && !(v.family === 'F1' || v.family === 'F2' || v.family === 'F4')) return [['family', "mode 'family' needs the chosen range end F1, F2 or F4"]];
        if (v.source === 'user' && !(typeof v.reason === 'string' && v.reason.trim())) return [['reason', 'a user closure needs a reason']];
        return null;
      }))),
    user: rec({ G: 'G', dt: 'dt', p: 'psia', value: 'num', at: AT }),
    aca: { origin: ORIGIN, linWin: orNull(pair('dt')), radWin: orNull(pair('dt')), piLevel: 'psia|null' },
  },
  summary: { $orNull: '@Summary' },
  lk: orNull({ cfg: '@LkConfig', preset: "'falloff'|'full'|'geometry'|'pdl'|'spurt'", fit: orNull({ params: rec('num'), ci95: rec(orNull(pair('num'))), ci95Inflated: rec(orNull(pair('num'))), groups: 'obj', chi2: 'nonneg', at: AT }), gridN: 'count' }),
  hf: orNull({ key: 'nestr', kinds: arr("'shutin'|'step'|'flowback'|'ramp'", { min: 1, max: 4 }), bytes: 'count', store: "'idb'|'ls'" }),
  log: arr({ seq: 'count', at: AT, who: 'str', item: 'nestr', old: 'any', new: 'any', reason: 'str' }, { max: 300 }),
}, rule((v) => {
  if (!Array.isArray(v.log)) return null;
  for (let i = 1; i < v.log.length; i++) if (v.log[i] && v.log[i - 1] && !(v.log[i].seq > v.log[i - 1].seq)) return [['log[' + i + '].seq', 'the pick log is append-only (seq strictly ascending)']];
  return null;
})));
def('DfitState', true, all({
  v: '2', active: 'testId', tests: arr('@DfitTest', { min: 1, max: 12 }),
  plan: orNull({ ranges: '@DesignRanges', summary: 'any', corridor: all({ t: arr('num!', { max: 60 }), p10: arr('num!', { max: 60 }), p50: arr('num!', { max: 60 }), p90: arr('num!', { max: 60 }) }, sameLen(['t', 'p10', 'p50', 'p90'])), ticks: 'obj' }),
  live: orNull({ tags: { p: 'nestr|null', pSurf: 'nestr|null', q: 'nestr|null', T: 'nestr|null' }, enabled: 'bool', verdictLog: arr({ t: 'h', state: 'nestr', family: "'F1'|'F2'|null", text: 'text' }) }),
}, uniqueIds('tests'), rule((v) => {
  const out = [];
  if (Array.isArray(v.tests) && typeof v.active === 'string' && !v.tests.some((t) => t && t.id === v.active)) out.push(['active', 'no test has the active id ' + v.active]);
  const bytes = JSON.stringify(v).length;
  if (bytes > 100 * 1024) out.push(['', 'st.dfit is ' + bytes + ' characters (cap 100 kB, §3.3)']);
  return out.length ? out : null;
})));

// ── Prepared (§3.5; output) ──
def('Prepared', true, all({
  ok: 'bool', t: arr('num!', { nondec: true }), pw: arr('psia!'), band: orNull({ p10: arr('psia|null'), p90: arr('psia|null') }), pSurf: orNull(arr('num|null')),
  q: orNull(arr('rate!')), T: orNull(arr('num|null')), idx: arr('count!', { asc: true }), src: "'bh'|'surface-converted'", sigma: 'nonneg', quantum: 'nonneg',
  applied: { atmDelta: 'num', unitFix: 'any', clockOffsetH: 'num', masked: 'count' }, flags: arr('@Warning'), hf: orNull({ windows: 'arr' }),
}, sameLen(['t', 'pw', 'q', 'idx', 'pSurf', 'T', 'band.p10', 'band.p90'])), { fail: true });

// ── Events (§3.5) ──
def('Events', true, all({
  ok: 'bool', tStart: 'h', tb: 'h', pb: 'psia', ts: 'h', tsRefined: 'bool', tEnd: 'h', qMax: 'rate', qLast: 'rate',
  Vi: 'vol', ViFrac: 'vol', ViStar: 'vol', Vfill: 'vol', Vfb: 'vol', qEq: 'rate', VwCwMeasured: 'nonneg',
  tp: { pump: 'dt', breakdown: 'dt', veq: 'dt' }, rampDownFrac: 'frac',
  steps: arr(all({ t0: 'h', t1: 'h', q: 'rate', pSettled: 'psia', n: 'count', dir: "'down'|'up'" }, ordered('t0', 't1'))),
  flowback: orNull({ t0: 'h', t1: 'h', q: 'rate', V: 'vol' }),
  cycles: arr({ tStart: 'h', ts: 'h', Vi: 'vol', closedBefore: 'bool', rampWin: orNull(pair('h')) }),
  schedule: arr({ t: 'h!', q: 'rate!' }),
  source: { tStart: "'auto'|'user'", tb: "'auto'|'user'", ts: "'auto'|'user'" }, warnings: arr('@Warning'), ev: ev({ groups: 'E' }),
}, ordered('tStart', 'ts'), ordered('ts', 'tEnd')), { fail: true });

// ── Derivs (§3.5) ──
const DSER = ['dt', 'dtD', 'G', 'p', 'dpIsip', 'GdPdG', 'dPdG', 'sqrtDt', 'sdPds', 'dPds', 'D', 'Dref', 'ppd', 'usable'];
def('Derivs', true, all({
  ok: 'bool', alpha: 'pos', gType: "'a05'|'a1'|'general'|'data'|'model'", tp: 'dt', tpChoice: "'pump'|'breakdown'|'veq'",
  dt: arr('dt!', { asc: true }), dtD: arr('pos!'), G: arr('G!'), p: arr('psia!'), dpIsip: arr('num|null'),
  GdPdG: arr('nonneg|null'), dPdG: arr('nonneg|null'), sqrtDt: arr('pos!'), sdPds: arr('nonneg|null'), dPds: arr('nonneg|null'),
  D: arr('nonneg|null'), Dref: arr('nonneg|null'), ppd: arr('nonneg|null'), mG: 'nonneg', earlyWin: pair('G'),
  h: orNull(all({ h: arr('num|null'), dPdh: arr('num|null'), hdPdh: arr('num|null') }, sameLen(['h', 'dPdh', 'hdPdh']))),
  axis: { GdPdG: pair('num'), dPdG: pair('num') }, L: 'pos', gMin: 'G', gMinWhy: "'hammer'|'bleed-off'|'thermal'|'1%'|'user'",
  usable: arr('0|1'), sigmaY: 'nonneg', ev: ev({ groups: 'G' }),
}, sameLen(DSER)), { fail: true });

// ── IsipResult (§3.5) ──
def('IsipResult', true, {
  ok: 'bool', value: 'psia', spread: 'nonneg', confidence: LVL, why: arr('text'),
  candidates: arr({ method: "'wh'|'g'|'sd'|'lp'", family: "'wave'|'falloff'|'friction'", value: 'psia', se: 'nonneg', ok: 'bool', upper: 'bool',
                    bleedAtEnd: 'psi', viscCorr: 'psi', why: 'text|null', ev: ev({ groups: 'IHS' }) }, { min: 1 }),
  loglogCheck: { isipBest: 'psia', ok: 'bool' }, ev: ev({ groups: 'I' }),
}, { fail: true });

// ── WTS_wellbore outputs (§3.4) ──
def('StepDown', true, {
  ok: 'bool', pFrac: 'psia', se: { pFrac: 'nonneg', a: 'nonneg', b: 'nonneg' }, a: 'num', b: 'num', beta: 'pos', drift: 'num',
  nOpen: 'nonneg', nOpenBand: P3p({ driver: 'str' }), at: { dpPerf: 'psi', dpNwb: 'psi', dpPipe: 'psi' }, label: "'high'|'medium'|'low'|'refused'",
  refused: 'text|null', resid: arr('num|null'), corr: 'any',
}, { fail: true });
def('StepRate', true, {
  ok: 'bool', qStar: 'rate', fep: 'psia', band: P3, b1: 'num', b2: 'num', fTest: { F: 'nonneg', p: 'frac' }, breakFound: 'bool',
  steps: arr({ q: 'rate', pEnd: 'psia', dpdt: 'num', stabilised: 'bool' }), why: 'text|null',
}, { fail: true });
def('Ramp', true, {
  ok: 'bool', kind: "'pre-breakdown'|'reopening'|'lot'|'pump-in'", VwCwRamp: 'nonneg', knee: orNull({ p: 'psia', V: 'vol', t: 'h' }), band: orNull(P3),
  slopes: { s1: 'num', s2: 'num' }, stiffRatio: 'nonneg', nwbCorr: 'psi', label: 'str', why: 'text|null',
}, { fail: true });
def('Hammer', true, {
  ok: 'bool', why: 'text|null', c: 'pos', cSource: "'korteweg'|'calibrated'", T: 'pos', tau: 'pos', delta: 'nonneg', A: 'psi', phi: 'num', isip: 'psia',
  regime: "'ringing'|'staircase'|'single'|'none'", Lquarter: 'nonneg', Lhalf: 'nonneg', reflectorMatch: "'perfs'|'shallower'|'deeper'|'unknown'",
  gammaDecay: 'nonneg', joukowsky: { expected: 'psi', measured: 'psi', ratio: 'nonneg' }, VwCwHammer: 'nonneg', tEnd: 'h',
  sampling: { hz: 'pos', per2Lc: 'nonneg', ok: 'bool' },
}, { fail: true });

// ── ClosurePick, Consensus, ConsensusLite (§3.5) ──
def('ClosurePick', true, all({
  method: METHODS, family: FAMS, vote: 'bool', ok: 'bool', dt: 'dt', G: 'G', p: 'psia', band: orNull(P3), se: 'nonneg', window: pair('G'),
  admissible: 'bool', vetoes: arr(LIMIT), warnings: arr(LIMIT), sameEvidenceAs: METHODS + '|null', upperSide: 'bool',
  evidence: arr({ text: 'text', ev: ev() }), ev: ev({ groups: 'CK' }),
}, rule((v) => {
  // voting members (§4.7, §4.22): F1 compliance, F1 loglog when independent (|ι| ≥ 0.05 ⇒ sameEvidenceAs null), F2 tangent,
  // F4 reopening, and a user pick in F1/F2/F4. crel, sqrt and maxdpdg never vote (WP0 resolution, §3.13).
  const voters = { compliance: 'F1', loglog: 'F1', tangent: 'F2', reopening: 'F4' };
  if ((v.family === 'F0' || v.family === 'F3') && v.vote === true) return [['vote', 'F0 and F3 are cross-checks and never vote']];
  if (v.vote === true && v.method !== 'user' && voters[v.method] !== v.family) return [['vote', 'only an independent member of a voting family votes (F1 compliance or an independent loglog, F2 tangent, F4 reopening)']];
  if (v.vote === true && v.sameEvidenceAs != null) return [['sameEvidenceAs', 'a dependent member never votes']];
  return null;
})));
def('Consensus', true, all({
  ok: 'bool', mode: "'single'|'range'|'none'", value: 'psia',
  range: orNull(all({ lo: 'psia', hi: 'psia', medians: { low: 'psia', high: 'psia' }, lowFamily: FAMS, highFamily: FAMS }, ordered('lo', 'hi'))),
  families: { F0: orNull(STAT), F1: orNull(STAT), F2: orNull(STAT), F3: orNull(STAT), F4: orNull(STAT) },
  tau: 'pos', metrics: { w: 'nonneg', s: 'nonneg', g: 'nonneg' }, bimodal: 'bool', preferred: "'F1'|'F2'|null", preferredWhy: 'text|null',
  confidence: "'high'|'medium'|'low'|'not-estimable'", calibrated: 'bool', hitRate: orNull({ p: 'frac', lo: 'frac', hi: 'frac', n: 'count', mode: "'single'|'range'" }),
  rules: arr({ id: 'evid', fired: 'bool', value: 'num|null', threshold: 'num|null', text: 'text' }),
  stability: { L: arr('pos'), tp: arr("'pump'|'breakdown'|'veq'"), grid: { F1: arr(arr('num|null')), F2: arr(arr('num|null')) }, unstable: 'bool' },
  samples: { F1: arr('num!'), F2: arr('num!'), F4: arr('num!') },
  counterfactual: orNull({ knob: "'L'|'tp'|'ts'|'eps'", setting: 'str', text: 'text' }),
  frictional: { veto: 'psia', warn: 'psia' }, forecast: orNull(arr({ sigma: 'psia', Gc: 'G', dtc: 'dt' })), ev: ev({ groups: 'CK' }),
}, rule((v) => {
  if (v.mode === 'single' && (!isNum(v.value) || v.range !== null)) return [['value', 'single mode: a value and range null']];
  if (v.mode === 'range' && (v.value !== null || !isObj(v.range))) return [['range', 'range mode: value null and a range']];
  if (v.mode === 'none' && (v.value !== null || v.range !== null || v.confidence !== 'not-estimable')) return [['mode', "mode none: value and range null, confidence 'not-estimable'"]];
  if (v.mode === 'range' && v.confidence === 'high') return [['confidence', "'high' is not available in range mode"]];
  if (v.mode === 'single' && v.confidence === 'not-estimable') return [['confidence', "'not-estimable' only goes with mode none"]];
  return null;
})), { fail: true });
def('ConsensusLite', true, all({
  mode: "'single'|'range'|'none'", value: 'psia', range: orNull(all({ lo: 'psia', hi: 'psia' }, ordered('lo', 'hi'))), families: FAM_P50, confidence: "'stale'",
}, rule((v) => {
  if (v.mode === 'single' && (!isNum(v.value) || v.range !== null)) return [['value', 'single mode: a value and range null']];
  if (v.mode === 'range' && (v.value !== null || !isObj(v.range))) return [['range', 'range mode: value null and a range']];
  if (v.mode === 'none' && (v.value !== null || v.range !== null)) return [['mode', 'mode none: value and range null']];
  return null;
})));

// ── Classification (§3.5) ──
def('Classification', true, {
  ok: 'bool', type: CTYPE, scores: { normal: 'num', matrix: 'num', pdl: 'num', tip: 'num', hrContact: 'num', storage: 'num' }, alt: arr(CTYPE),
  features: { iota: 'num', curv: 'num', curvExp: 'num', curvWb: 'num', H: 'num', DoverDref: 'num', Rvis: 'num', VwCwRatio: 'num', unitSlopeSink: 'bool', bleedOffExplained: 'bool' },
  pdl: orNull({ pfo: 'psia', Cd: 'nonneg', multAtIsip: 'nonneg', sigmaHminusH: 'psi' }), hr: orNull({ Rs: 'num', hf0FromPKN: 'nonneg', hf0FromKGD: 'nonneg' }),
  evidence: arr('text'), ev: ev({ groups: 'M' }),
}, { fail: true });

// ── FracOutputs (§3.5) ──
const GEO_COMMON = { cf: 'nonneg', Af: 'nonneg', rp: 'frac', CL: 'nonneg', wAvg: 'nonneg', wMax: 'nonneg', Vf: 'vol', VLpump: 'vol' };
def('FracOutputs', true, {
  'label?': 'str', pClosure: 'psia', family: FAMS + '|null', method: 'nestr|null', Gc: 'G', dtc: 'dt', dtDc: 'pos', ViStar: 'vol',
  eta: { a05: 'frac', a1: 'frac', matched: 'frac', alphaUsed: 'pos', etaF: 'frac' },
  Csys: 'nonneg', VwCw: 'nonneg', AfCf: 'nonneg', Rvis: 'num', pn: 'psi', chi: 'num', gradIsip: 'nonneg', gradClosure: 'nonneg', Gamma: 'nonneg', GammaPKN: 'nonneg', mG: 'nonneg',
  geometry: { model: GEOM, auto: 'bool', consistent: 'bool', msgs: arr('text'),
              byModel: { PKN: Object.assign({ xf: 'nonneg' }, GEO_COMMON), KGD: Object.assign({ xf: 'nonneg' }, GEO_COMMON), radial: Object.assign({ R: 'nonneg' }, GEO_COMMON) } },
  spurt: { value: 'nonneg', note: 'text' },
  kBefore: { kCL: orNull({ k: 'nonneg', dpCL: 'psi', factor: 'pos', kCorr: 'nonneg' }), kH: orNull({ k: 'nonneg', factor: 'pos', kCorr: 'nonneg' }) },
  pdlMult: 'nonneg', farField: orNull({ p: 'psia', regime: 'str', window: orNull(pair('G')), note: 'text' }),
  padFraction: all({ lo: 'frac', hi: 'frac' }, ordered('lo', 'hi')), stressCal: orNull({ dSigmaTect: 'psi', sigmaModel: 'psia', biot: 'frac' }), ev: ev({ groups: 'F' }),
}, { fail: true });

// ── Triage (§3.5a) ──
def('Triage', true, {
  ok: 'bool', light: "'green'|'amber'|'red'", verdict: "'interpretable'|'partly'|'uninterpretable'",
  checks: arr({ id: 'nestr', title: 'text', level: "'pass'|'warn'|'fail'|'na'", value: 'num|str|null', threshold: 'num|str|null', text: 'text', ev: ev({ groups: 'Q' }) }),
  windows: { usable: arr(pair('h')), excluded: arr({ t0: 'h', t1: 'h', why: 'text' }) },
  blunders: arr({ id: 'nestr', hypothesis: 'text', score: 'num', bf: 'num|null', fix: { field: 'nestr', from: 'any', to: 'any' }, text: 'text' }),
  repump: { verdict: "'continue'|'caution'|'repump'", rules: arr({ id: 'nestr', level: "'pass'|'warn'|'fail'", text: 'text' }), ack: 'bool' },
  grade: { letter: "'A'|'B'|'C'|'D'", why: arr('text') }, salvage: arr('text'), ev: ev({ groups: 'Q' }),
}, { fail: true });

// ── AcaResult, LeakPlot, Uncertainty, LiveVerdict, EvidenceIndex, ReportModel, HandoffPacket (§3.6) ──
def('AcaDiag', true, all({
  x: arr('pos!', { asc: true }), D: arr('nonneg|null'), sD: arr('num|null'), n: arr('num|null'), piLo: arr('psia|null'), piHi: arr('psia|null'), piPoint: arr('psia|null'),
  noiseD: arr('nonneg|null'), regimes: arr(all({ kind: "'linear'|'bilinear'|'radial'|'spherical'|'storage'|'transition'|'artefact'", t0: 'h', t1: 'h', slope: 'num' }, ordered('t0', 't1'))), sequenceOk: 'bool',
}, sameLen(['x', 'D', 'sD', 'n', 'piLo', 'piHi', 'piPoint', 'noiseD'])));
const BR = orNull(pair('psia'));
def('AcaResult', true, {
  ok: 'bool', regimeSummary: "'none'|'linear'|'linear-radial'|'radial'|'spherical'|'storage'",
  origin: ORIGIN, t0: 'h', tcInj: 'dt', V: 'vol', diag: '@AcaDiag',
  nolte: { lin: orNull({ pr: 'psia', mL: 'num', k: 'nonneg', win: pair('h') }), rad: orNull({ pr: 'psia', mR: 'num', khmu: 'nonneg', k: 'nonneg', win: pair('h') }) },
  impulse: { lin: orNull({ pi: 'psia', m: 'num', group: "'Ask'", value: 'nonneg' }), rad: orNull({ pi: 'psia', m: 'num', group: "'khmu'", value: 'nonneg' }),
             sph: orNull({ pi: 'psia', m: 'num', group: "'ks'", value: 'nonneg' }) },
  brackets: all({ cart: BR, imp: BR, deriv: BR, combined: BR, edges: { lo: 'str|null', hi: 'str|null' } }, rule((v) => {
    const out = [];
    ['cart', 'imp', 'deriv', 'combined'].forEach((k) => { const b = v[k]; if (Array.isArray(b) && isNum(b[0]) && isNum(b[1]) && b[0] > b[1]) out.push([k, 'bracket lo > hi']); });
    return out.length ? out : null;
  })),
  pi: all({ value: 'psia', lo: 'psia', hi: 'psia', label: LVL, reasons: arr('text') }, ordered('lo', 'value'), ordered('value', 'hi')),
  kh: orNull({ khmu: 'nonneg', k: 'nonneg', biasDirection: "'upper'|'none'" }),
  bounds: orNull(all({ kLo: 'nonneg', kHi: 'nonneg', binding: arr({ edge: "'lo'|'hi'", rule: 'nestr', value: 'num' }), direction: "'normal'|'reversed'" }, ordered('kLo', 'kHi'))),
  match: 'obj|null', gas: orNull({ iterations: 'count', converged: 'bool' }), tidalCt: orNull({ ct: 'pos', ok: 'bool', note: 'text' }),
  eps: { atClosure: 'nonneg', now: 'nonneg' }, ratios: orNull({ AacaOverAcarter: 'nonneg', lambda: 'num' }), warnings: arr('@Warning'), ev: ev({ groups: 'A' }),
}, { fail: true });
def('LeakPlot', true, {
  ok: 'bool', form: "'linear'|'radial'", A: 'num', B: 'num', d: 'num', dPrior: 'num', corrBd: 'num', separable: 'bool', qk: 'num', qkCI: pair('num'), floor: 'nonneg',
  piCorr: 'psia', piUncorr: 'psia', windowBiasNote: 'text|null', qkMax: 'nonneg', theta: 'num', verdict: "'none'|'leak'|'leak-or-drift'|'below-floor'",
}, { fail: true });
const P3N = { p10: 'num', p50: 'num', p90: 'num' };
def('Uncertainty', true, {
  ok: 'bool', n: 'count', seed: 'int', mode: "'single'|'range'",
  familyWeight: all({ F1: 'frac', F2: 'frac' }, rule((v) => (isNum(v.F1) && isNum(v.F2) && Math.abs(v.F1 + v.F2 - 1) > 1e-9) ? [['', 'family weights must sum to 1']] : null)),
  inputs: arr({ name: 'nestr', dist: "'normal'|'lognormal'|'uniform'|'triangular'|'fixed'|'empirical'", params: 'obj', provenance: 'str' }),
  outputs: rec(all({ p10: 'num', p50: 'num', p90: 'num', unit: 'str', shares: arr({ input: 'nestr', s: 'frac' }), closureShare: 'frac', bimodal: 'bool',
                     byFamily: orNull({ F1: P3N, F2: P3N }), envelope: orNull(pair('num')) },
    rule((v) => {
      if (v.bimodal === true && (v.p10 !== null || v.p50 !== null || v.p90 !== null)) return [['p50', 'bimodal ⇒ p10/p50/p90 are null (§6.6)']];
      if (v.bimodal === true && (!isObj(v.byFamily) || !Array.isArray(v.envelope))) return [['byFamily', 'bimodal ⇒ byFamily and envelope carry the answer']];
      if (isNum(v.p10) && isNum(v.p50) && isNum(v.p90) && !(v.p10 <= v.p50 && v.p50 <= v.p90)) return [['p50', 'expected p10 ≤ p50 ≤ p90']];
      return null;
    }))),
  tornado: arr({ output: 'nestr', input: 'nestr', lo: 'num', hi: 'num' }), ev: ev({ groups: 'U' }),
}, { fail: true });
def('LiveVerdict', true, {
  t: 'h', state: "'none'|'continue'|'provisional'|'confirmed'|'enough-pi'|'radial-unreachable'|'outside-corridor'", family: "'F1'|'F2'|null",
  p: 'psia', forecast: orNull(all({ lo: 'h', hi: 'h' }, ordered('lo', 'hi'))), text: 'text', ev: ev({ empty: true }),
});
def('EvidenceIndex', true, all({
  items: rec({ id: 'evid', group: "'Q'|'X'|'E'|'I'|'H'|'S'|'G'|'C'|'K'|'M'|'F'|'A'|'L'|'U'|'P'|'O'", title: 'text', values: arr({ label: 'str', value: 'num|str|null', unit: 'str', dp: 'count' }), path: 'str', text: 'text' }, EV_RE),
  order: arr('evid'),
}, rule((v) => {
  if (!isObj(v.items) || !Array.isArray(v.order)) return null;
  const out = [], keys = Object.keys(v.items);
  keys.forEach((k) => { const it = v.items[k]; if (it && it.id !== k) out.push(['items.' + k + '.id', 'id differs from its key']); if (it && typeof it.group === 'string' && k[0] !== it.group) out.push(['items.' + k + '.group', 'group differs from the id letter']); });
  if (v.order.length !== keys.length || v.order.some((id) => !v.items[id])) out.push(['order', 'order must list every item id exactly once']);
  if (new Set(v.order).size !== v.order.length) out.push(['order', 'duplicate ids']);
  return out.length ? out : null;
})));
const INLINE_EV = /\[[QXEIHSGCKMFALUPO]\d+([·,\s]+[QXEIHSGCKMFALUPO]\d+)*\]/;
const CELL = (v, p, ctx) => {
  if (v === null || isNum(v)) return;
  if (typeof v !== 'string') return err(ctx, p, 'expected a string, a number or null, got ' + describe(v));
  if (BANNED.test(v)) err(ctx, p, 'text contains a banned word');
  if (INLINE_EV.test(v)) err(ctx, p, 'no inline evidence bracket in a value (§6.10, R8)');
};
def('Block', true, oneOf('kind', {
  kv: { kind: "'kv'", rows: arr(tuple('str', CELL, ev({ empty: true }))) },
  table: { kind: "'table'", head: arr('str', { min: 1 }), rows: arr(arr(CELL)), ev: 'bool', 'title?': 'str' },
  verdict: { kind: "'verdict'", level: "'ok'|'warn'|'bad'", text: 'text' },
  notes: { kind: "'notes'", text: 'str' },
  plot: { kind: "'plot'", key: 'nestr', title: 'str' },
  kpi: { kind: "'kpi'", items: arr({ label: 'str', value: CELL, ev: ev({ empty: true }) }) },
}));
def('ReportModel', true, all({
  title: 'nestr', keyRows: arr(tuple('str', 'str')), keyLine: 'text', grade: { letter: "'A'|'B'|'C'|'D'", why: arr('text') },
  sections: arr({ id: 'nestr', title: 'nestr', order: 'num', blocks: arr('@Block') }), appendix: '@EvidenceIndex', quoted: { ok: 'bool', nFailed: 'count' },
}, uniqueIds('sections')));
def('HandoffPacket', true, {
  target: "'pta'|'rta'|'frac'", family: "'F1'|'F2'|'F4'|null", setWell: 'obj', multiRate: arr({ t: 'h!', q: 'rate!' }), qEq: 'rate',
  model: "'infiniteFrac'|'finiteFrac'|'homogeneous'|'radialComposite'|null", seeds: { xf: 'nonneg', k: 'nonneg', pi: 'psia' }, notes: arr('text'), blockers: arr('text'),
});

// ── 58 outputs (§3.7) ──
const LK_ARR = ['t', 'pw', 'pf', 'L', 'A', 'AL', 'W', 'Vf', 'Vi', 'VL', 'VLw', 'VLc', 'VS', 'qL', 'eta', 'Bw', 'Ggen'];
def('LkResult', true, all({
  ok: 'bool', why: 'text|null', t: arr('num!', { asc: true }), pw: arr('psia|null'), pf: arr('psia|null'), L: arr('nonneg|null'), A: arr('nonneg|null'), AL: arr('nonneg|null'),
  W: arr('nonneg|null'), Vf: arr('vol'), Vi: arr('vol'), VL: arr('vol'), VLw: arr('vol'), VLc: arr('vol'), VS: arr('vol'), qL: arr('num|null'), eta: arr('num|null'),
  Bw: arr('num|null'), Ggen: arr('num|null'),
  events: { tb: 'h', pb: 'psia', ts: 'h', isip: 'psia', tcMech: 'h', tcHyd: 'h', Gc: { a05: 'G', a1: 'G', gen: 'G' } }, xf: { ts: 'nonneg', tc: 'nonneg' },
  CLeq: 'nonneg', dpCL: 'psi', wcEq: 'nonneg', tDxfMax: 'nonneg', balanceErr: 'num', regime: { tipShare: 'frac' }, validity: arr('@Warning'), warnings: arr('@Warning'),
}, sameLen(LK_ARR)), { fail: true });
const RANGE2 = orNull(pair('num'));
def('LkFit', true, {
  ok: 'bool', preset: "'falloff'|'full'|'geometry'|'pdl'|'spurt'", params: rec('num'), ci95: rec(RANGE2), ci95Inflated: rec(RANGE2), corr: 'any', nEff: 'nonneg', rho1: 'num',
  structural: { sigmaC: RANGE2, pr: RANGE2, k: RANGE2, CLeq: RANGE2 }, groups: { Gamma: 'nonneg', GammaPKN: 'nonneg', text: 'text' },
  sloppy: arr({ vec: 'any', text: 'text' }), starts: { n: 'count', converged: 'count' }, runs: 'count', chi2: 'nonneg', rmse: 'nonneg', stopReason: 'str', warnings: arr('@Warning'),
}, { fail: true });
def('Identify', true, {
  rows: arr({ param: 'nestr', status: "'determined'|'group'|'not'", pm: 'num|null', text: 'text' }), sloppyText: 'text',
  voi: arr({ source: 'nestr', reduction: 'num', text: 'text' }), extend: arr({ tEndD: 'pos', sdPi: 'nonneg', kRange: orNull(pair('nonneg')), pRadial: 'frac' }),
}, { fail: true });
const PR = (t) => all({ p10: t, p90: t }, ordered('p10', 'p90'));
def('DesignRanges', false, {
  k: PR('pos'), phi: PR('pos'), ct: PR('pos'), muRes: PR('pos'), h: PR('pos'), hf: PR('pos'), hp: 'pos|null',
  Ep: { p50: 'pos', sdLn: 'nonneg' }, nu: 'num', sigmaGrad: { p50: 'pos', sd: 'nonneg' }, piGrad: { p50: 'pos', sd: 'nonneg' }, datumTvd: 'pos',
  strings: 'arr', fluid: 'obj', gauge: { kind: "'surface'|'bh'", sigma: 'nonneg', resolution: 'nonneg', hz: 'pos', driftPsiPerDay: 'nonneg' },
  V: 'pos|null', q: 'pos|null', suggest: 'bool', allowedShutInD: 'pos', targetW: 'pos|null', repressurise: 'bool', epsMax: 'pos', leakEps: 'pos',
});
def('Design', true, {
  ok: 'bool', n: 'count', seed: 'int', outcome: { label: "'closure-only'|'linear'|'radial'", text: 'text' },
  tc: P3, shutIn: P3p({ binding: "'radial'|'3tc'|'afterflow'|'precision'" }), tRadial: P3, signalPsi: P3, Vmin: 'vol', Rvis: { p50: 'num' },
  vacuum: { risk: "'none'|'surface-zero'", text: 'text' }, gauge: { bhRequired: 'bool', why: arr('text'), hz: 'pos', resolutionPsi: 'nonneg', driftPsiPerDay: 'nonneg' },
  leak: { qkMax: 'nonneg', theta: 'num', holdMin: 'nonneg', dTneeded: 'num' }, stepDown: { rates: arr('rate') },
  repressurise: orNull({ q: 'rate', V: 'vol', kneeP: P3 }), precision: arr({ tEndD: 'pos', sdPi: 'nonneg' }), checklist: arr({ id: 'nestr', text: 'text' }),
  corridor: all({ t: arr('num!', { max: 60 }), p10: arr('num|null'), p50: arr('num|null'), p90: arr('num|null') }, sameLen(['t', 'p10', 'p50', 'p90'])), warnings: arr('@Warning'),
}, { fail: true });

// ── CaseSpec (§3.9; input) ──
def('CaseSpec', false, all({
  id: 'nestr', source: "'lk'|'aca-exact'|'gdomain'", mechanism: 'nestr', lk: { $orNull: '@LkConfig' },
  aca: orNull({ k: 'pos', L: 'pos', h: 'pos', phi: 'pos', ct: 'pos', mu: 'pos', V: 'pos', tcInj: 'pos', pi: 'psia' }),
  wellbore: { VwCw: 'nonneg', cwOfP: "'gas'|'air'|null" }, noise: { sigma: 'nonneg', rho1: 'num', quantum: 'nonneg' }, sampling: { dtS: 'pos' }, tEndFactor: 'pos',
  artefacts: arr({ kind: 'nestr' }), tags: arr('str'),
}, rule((v) => (v.source === 'lk' && v.lk === null) ? [['lk', "source 'lk' needs an LkConfig"]] : (v.source === 'aca-exact' && v.aca === null) ? [['aca', "source 'aca-exact' needs the aca block"]] : null)));

// ── DfitRun (§3.3a) ──
def('DfitRun', true, all({
  v: '1', ok: 'bool', fast: 'bool', dsHash: 'hex16', inputsHash: 'hex16', picksHash: 'hex16', seed: 'int',
  prep: '@Prepared', events: '@Events', triage: { $orNull: '@Triage' }, isip: '@IsipResult', derivs: '@Derivs',
  picks: arr('@ClosurePick'), consensus: { $orNull: '@Consensus' }, consensusLite: '@ConsensusLite', classification: '@Classification',
  frac: { chosen: { $orNull: '@FracOutputs' }, byFamily: { 'F0?': '@FracOutputs', 'F1?': '@FracOutputs', 'F2?': '@FracOutputs', 'F3?': '@FracOutputs', 'F4?': '@FracOutputs' } },
  whatIf: arr(all('@FracOutputs', { label: 'nestr' })), aca: { $orNull: '@AcaResult' }, leak: { $orNull: '@LeakPlot' }, unc: { $orNull: '@Uncertainty' },
  evidence: { $orNull: '@EvidenceIndex' }, report: { $orNull: '@ReportModel' }, grade: orNull({ letter: "'A'|'B'|'C'|'D'", why: arr('text') }),
  summary: { $orNull: '@Summary' }, warnings: arr('@Warning'), counts: { evals: 'count', refits: 'count', draws: 'count' },
}, rule((v) => {
  const out = [];
  if (v.fast === true && v.unc !== null) out.push(['unc', 'a fast run skips the uncertainty (unc null)']);
  if (v.fast === true && isObj(v.counts) && v.counts.draws !== 0) out.push(['counts.draws', 'a fast run makes no draws']);
  if (isObj(v.prep) && isObj(v.derivs) && Array.isArray(v.derivs.dt) && Array.isArray(v.prep.t) && v.derivs.dt.length > v.prep.t.length) out.push(['derivs.dt', 'more derivative samples than prepared samples']);
  return out.length ? out : null;
})), { fail: true });

const SHAPE_NAMES = ['DfitDataset', 'DfitInputs', 'DfitState', 'DfitTest', 'DfitRun', 'Prepared', 'Events', 'Derivs', 'IsipResult', 'StepDown', 'StepRate',
  'Ramp', 'Hammer', 'ClosurePick', 'Consensus', 'ConsensusLite', 'Classification', 'FracOutputs', 'Triage', 'AcaResult', 'LeakPlot', 'Uncertainty',
  'LkConfig', 'LkResult', 'LkFit', 'Identify', 'DesignRanges', 'Design', 'LiveVerdict', 'EvidenceIndex', 'ReportModel', 'HandoffPacket', 'CaseSpec'];
SHAPE_NAMES.forEach((n) => { if (!SHAPES[n]) throw new Error('_dfit-shapes: shape ' + n + ' is not defined'); });

// FIX.ds data (generated once by the WP0 prototype; see the header). 600 samples.
const DS_T = [
  0,0.003333333,0.006666667,0.01,0.013333333,0.016666667,0.02,0.023333333,0.026666667,0.03,0.034027778,0.034722222,0.035416667,0.036111111,0.036805556,0.0375,0.038194444,0.038888889,0.039583333,
  0.040277778,0.040972222,0.041666667,0.042361111,0.043055556,0.04375,0.044444444,0.045138889,0.045833333,0.046527778,0.047222222,0.047916667,0.048611111,0.049305556,0.05,0.050694444,0.051388889,
  0.052083333,0.052777778,0.053472222,0.054166667,0.054861111,0.055555556,0.05625,0.056944444,0.057638889,0.058333333,0.059027778,0.059722222,0.060416667,0.061111111,0.061805556,0.0625,0.063194444,
  0.063888889,0.064583333,0.065277778,0.065972222,0.066666667,0.067361111,0.068055556,0.06875,0.069444444,0.070138889,0.070833333,0.071527778,0.072222222,0.072916667,0.073611111,0.074305556,0.075,
  0.075694444,0.076388889,0.077083333,0.077777778,0.078472222,0.079166667,0.079861111,0.080555556,0.08125,0.081944444,0.082638889,0.083333333,0.084027778,0.084722222,0.085416667,0.086111111,0.086805556,
  0.0875,0.088194444,0.088888889,0.089583333,0.090277778,0.090972222,0.091666667,0.092361111,0.093055556,0.09375,0.094444444,0.095138889,0.095833333,0.096527778,0.097222222,0.097916667,0.098611111,
  0.099305556,0.1,0.100694444,0.101388889,0.102083333,0.102777778,0.103472222,0.104166667,0.104861111,0.105555556,0.10625,0.106944444,0.107638889,0.108333333,0.109027778,0.109722222,0.110416667,
  0.111111111,0.111805556,0.1125,0.113194444,0.113888889,0.114583333,0.115277778,0.115972222,0.116666667,0.116944444,0.116951926,0.11695961,0.1169675,0.116975603,0.116983924,0.11699247,0.117001245,
  0.117010257,0.117019512,0.117029015,0.117038775,0.117048798,0.117059091,0.117069661,0.117080515,0.117091662,0.117103109,0.117114865,0.117126937,0.117139335,0.117152066,0.11716514,0.117178566,
  0.117192354,0.117206514,0.117221055,0.117235987,0.117251322,0.117267069,0.117283241,0.117299848,0.117316903,0.117334417,0.117352403,0.117370873,0.117389841,0.11740932,0.117429323,0.117449865,
  0.117470961,0.117492624,0.117514871,0.117537718,0.117561179,0.117585273,0.117610016,0.117635425,0.117661518,0.117688314,0.117715832,0.117744092,0.117773112,0.117802914,0.117833519,0.117864948,
  0.117897224,0.117930368,0.117964406,0.117999361,0.118035257,0.11807212,0.118109975,0.118148851,0.118188773,0.118229771,0.118271873,0.11831511,0.11835951,0.118405107,0.118451932,0.118500018,
  0.118549399,0.11860011,0.118652188,0.118705667,0.118760588,0.118816987,0.118874906,0.118934385,0.118995466,0.119058192,0.119122608,0.119188758,0.119256691,0.119326453,0.119398094,0.119471665,
  0.119547217,0.119624805,0.119704482,0.119786305,0.119870333,0.119956623,0.120045238,0.12013624,0.120229692,0.120325662,0.120424217,0.120525426,0.120629362,0.120736097,0.120845707,0.120958269,
  0.121073863,0.121192571,0.121314476,0.121439664,0.121568224,0.121700248,0.121835827,0.121975058,0.122118039,0.122264872,0.122415659,0.122570508,0.122729527,0.12289283,0.123060531,0.12323275,
  0.123409607,0.123591228,0.12377774,0.123969277,0.124165972,0.124367965,0.124575399,0.124788421,0.12500718,0.125231831,0.125462533,0.125699449,0.125942747,0.126192597,0.126449178,0.126712669,
  0.126983258,0.127261135,0.127546496,0.127839544,0.128140484,0.128449531,0.128766902,0.129092821,0.129427519,0.129771232,0.130124202,0.13048668,0.130858921,0.131241189,0.131633753,0.132036891,
  0.132450887,0.132876034,0.133312632,0.13376099,0.134221425,0.134694261,0.135179834,0.135678485,0.136190567,0.136716442,0.137256482,0.137811067,0.13838059,0.138965454,0.13956607,0.140182864,
  0.140816272,0.14146674,0.142134729,0.14282071,0.143525167,0.144248599,0.144991517,0.145754445,0.146537923,0.147342504,0.148168756,0.149017263,0.149888624,0.150783456,0.151702389,0.152646075,
  0.153615178,0.154610384,0.155632396,0.156681936,0.157759745,0.158866584,0.160003237,0.161170505,0.162369213,0.163600209,0.164864361,0.166162563,0.167495732,0.16886481,0.170270764,0.171714587,
  0.1731973,0.17471995,0.176283611,0.17788939,0.179538421,0.181231868,0.182970928,0.18475683,0.186590834,0.188474238,0.190408371,0.192394599,0.194434327,0.196528995,0.198680082,0.200889108,0.203157635,
  0.205487264,0.207879642,0.210336459,0.212859449,0.215450396,0.21811113,0.220843531,0.223649529,0.226531107,0.229490299,0.232529197,0.235649948,0.238854756,0.242145885,0.245525661,0.24899647,
  0.252560766,0.256221066,0.259979956,0.263840091,0.267804199,0.27187508,0.27605561,0.280348742,0.284757509,0.289285027,0.293934492,0.298709191,0.303612496,0.308647872,0.313818874,0.319129158,
  0.324582474,0.330182674,0.335933716,0.341839661,0.347904683,0.354133066,0.36052921,0.367097634,0.373842978,0.380770007,0.387883616,0.395188829,0.402690807,0.410394851,0.418306403,0.426431053,
  0.434774539,0.443342756,0.452141758,0.461177761,0.470457148,0.479986474,0.489772473,0.499822056,0.510142325,0.52074057,0.531624277,0.542801137,0.554279045,0.566066109,0.578170658,0.590601242,
  0.603366643,0.616475879,0.629938212,0.643763152,0.657960466,0.672540183,0.687512605,0.702888308,0.718678155,0.7348933,0.751545199,0.768645617,0.786206633,0.804240654,0.82276042,0.841779015,
  0.861309875,0.881366798,0.901963953,0.923115891,0.944837555,0.967144291,0.990051857,1.013576438,1.037734652,1.062543566,1.088020706,1.114184072,1.141052147,1.168643912,1.19697886,1.226077007,
  1.255958912,1.286645684,1.318159002,1.35052113,1.38375493,1.417883881,1.452932093,1.488924326,1.525886009,1.563843252,1.602822871,1.642852404,1.683960131,1.726175091,1.769527109,1.814046812,
  1.85976565,1.906715922,1.954930797,2.004444337,2.055291522,2.107508273,2.161131478,2.216199022,2.272749807,2.330823784,2.390461981,2.451706529,2.514600695,2.579188912,2.645516809,2.713631244,
  2.783580338,2.855413507,2.929181498,3.004936425,3.082731807,3.162622604,3.244665254,3.328917719,3.415439519,3.504291779,3.595537269,3.689240452,3.785467524,3.884286467,3.985767093,4.089981094,
  4.197002093,4.306905696,4.419769547,4.535673379,4.654699074,4.77693072,4.902454668,5.031359597,5.163736572,5.299679114,5.43928326,5.582647637,5.729873524,5.881064933,6.036328673,6.195774434,
  6.359514857,6.527665619,6.700345513,6.877676529,7.059783947,7.246796417,7.438846058,7.636068545,7.838603208,8.046593131,8.260185251,8.479530462,8.704783725,8.936104171,9.17365522,9.417604693,
  9.668124932,9.925392919,10.189590404,10.460904034,10.739525482,11.025651582,11.319484472,11.621231734,11.931106542,12.249327811,12.576120351,12.91171503,13.256348932,13.610265529,13.97371485,
  14.346953657,14.730245631,15.123861552,15.528079495,15.943185026,16.369471401,16.807239775,17.256799416,17.71846792,18.192571439,18.67944491,19.17943229,19.692886801,20.220171181,20.761657935,
  21.317729605,21.888779033,22.475209646,23.077435734,23.695882747,24.330987596,24.983198957,25.652977595,26.340796683,27.047142138,27.772512968,28.517421621,29.282394346,30.067971568,30.874708268,
  31.703174375,32.553955169,33.427651697,34.32488119,35.246277509,36.192491586,37.164191886,38.162064877,39.186815522,40.239167767,41.319865059,42.429670873,43.569369243,44.739765323,45.941685956,
  47.175980253,48.443520198,49.745201258,51.081943024,52.454689854,53.864411542,55.312104004,56.79878998,58.325519758,59.893371917,61.503454085,63.156903724,64.854888936,66.598609283,68.389296639,
  70.228216058,72.116666667
];
const DS_P = [
  4500,4500,4500,4500,4500,4500,4500,4500,4500,4500,4763.46,5026.92,5290.38,5553.83,5817.29,6080.75,6344.21,6607.67,6871.13,7134.58,7398.04,7661.5,7924.96,8188.42,8149.39,8116.39,8088.48,8064.89,
  8044.95,8028.09,8013.86,8001.84,7991.69,7983.13,7975.91,7969.83,7964.71,7960.41,7956.8,7953.77,7951.23,7949.11,7947.35,7945.89,7944.68,7943.68,7942.87,7942.21,7941.68,7941.26,7940.93,7940.68,7940.5,
  7940.38,7940.31,7940.27,7940.27,7940.3,7940.35,7940.43,7940.52,7940.62,7940.74,7940.87,7941.01,7941.16,7941.31,7941.47,7941.63,7941.8,7941.97,7942.14,7942.32,7942.5,7942.67,7942.86,7943.04,7943.22,
  7943.4,7943.59,7943.77,7943.96,7944.15,7944.33,7944.52,7944.71,7944.89,7945.08,7945.27,7945.46,7945.65,7945.83,7946.02,7946.21,7946.4,7946.59,7946.77,7946.96,7947.15,7947.34,7947.53,7947.72,7947.91,
  7948.09,7948.28,7948.47,7948.66,7948.85,7949.04,7949.23,7949.42,7949.6,7949.79,7949.98,7950.17,7950.36,7950.55,7950.74,7950.92,7951.11,7951.3,7951.49,7951.68,7951.87,7952.06,7952.25,7952.43,7952.62,
  7952.81,7953,7599.78,7599.78,7599.77,7599.77,7599.76,7599.75,7599.75,7599.74,7599.73,7599.73,7599.72,7599.71,7599.7,7599.7,7599.69,7599.68,7599.67,7599.66,7599.65,7599.64,7599.63,7599.62,7599.61,
  7599.6,7599.59,7599.58,7599.57,7599.56,7599.55,7599.54,7599.52,7599.51,7599.5,7599.49,7599.47,7599.46,7599.44,7599.43,7599.41,7599.4,7599.38,7599.37,7599.35,7599.33,7599.32,7599.3,7599.28,7599.26,
  7599.24,7599.22,7599.2,7599.18,7599.16,7599.14,7599.11,7599.09,7599.07,7599.04,7599.02,7598.99,7598.96,7598.94,7598.91,7598.88,7598.85,7598.82,7598.79,7598.76,7598.73,7598.69,7598.66,7598.63,7598.59,
  7598.55,7598.52,7598.48,7598.44,7598.4,7598.35,7598.31,7598.27,7598.22,7598.18,7598.13,7598.08,7598.03,7597.98,7597.93,7597.88,7597.82,7597.77,7597.71,7597.65,7597.59,7597.53,7597.46,7597.4,7597.33,
  7597.26,7597.19,7597.12,7597.05,7596.97,7596.89,7596.81,7596.73,7596.65,7596.57,7596.48,7596.39,7596.3,7596.2,7596.11,7596.01,7595.91,7595.8,7595.7,7595.59,7595.48,7595.36,7595.25,7595.13,7595,
  7594.88,7594.75,7594.62,7594.49,7594.35,7594.21,7594.06,7593.91,7593.76,7593.61,7593.45,7593.29,7593.12,7592.95,7592.78,7592.6,7592.42,7592.23,7592.04,7591.84,7591.64,7591.44,7591.23,7591.01,7590.8,
  7590.57,7590.34,7590.11,7589.87,7589.62,7589.37,7589.12,7588.85,7588.59,7588.31,7588.03,7587.75,7587.45,7587.15,7586.85,7586.53,7586.22,7585.89,7585.56,7585.21,7584.87,7584.51,7584.15,7583.78,7583.4,
  7583.01,7582.61,7582.21,7581.8,7581.37,7580.94,7580.5,7580.06,7579.6,7579.13,7578.65,7578.17,7577.67,7577.16,7576.65,7576.12,7575.58,7575.03,7574.47,7573.9,7573.31,7572.72,7572.11,7571.5,7570.86,
  7570.22,7569.57,7568.9,7568.22,7567.52,7566.81,7566.09,7565.36,7564.61,7563.85,7563.07,7562.28,7561.47,7560.65,7559.81,7558.96,7558.09,7557.2,7556.3,7555.39,7554.45,7553.5,7552.54,7551.55,7550.55,
  7549.53,7548.49,7547.43,7546.36,7545.27,7544.15,7543.02,7541.87,7540.7,7539.51,7538.29,7537.06,7535.81,7534.53,7533.24,7531.92,7530.58,7529.22,7527.83,7526.43,7525,7523.54,7522.07,7520.56,7519.04,
  7517.49,7515.91,7514.31,7512.68,7511.03,7509.35,7507.64,7505.91,7504.15,7502.36,7500.55,7498.71,7496.83,7494.93,7493,7491.04,7489.05,7487.03,7484.97,7482.89,7480.77,7478.63,7476.45,7474.23,7471.99,
  7469.71,7467.39,7465.04,7462.66,7460.24,7457.78,7455.29,7452.76,7450.2,7447.59,7444.95,7442.27,7439.55,7436.79,7433.99,7431.15,7428.27,7425.35,7422.38,7419.37,7416.32,7413.22,7410.08,7406.9,7403.67,
  7400.39,7397.07,7393.69,7390.27,7386.81,7383.29,7379.72,7376.11,7372.44,7368.72,7364.94,7361.12,7357.24,7353.3,7349.31,7345.27,7341.17,7337.01,7332.79,7328.51,7324.18,7319.78,7315.33,7310.81,7306.22,
  7301.58,7296.87,7292.09,7287.25,7282.35,7277.37,7272.32,7267.21,7262.03,7256.77,7251.44,7246.04,7240.56,7235.01,7229.39,7223.68,7217.9,7212.04,7206.1,7200.07,7193.97,7187.78,7181.51,7175.15,7168.7,
  7162.17,7155.54,7148.83,7142.03,7135.13,7128.14,7121.05,7113.87,7106.59,7099.21,7091.73,7084.15,7076.47,7068.68,7060.79,7052.79,7044.68,7036.46,7028.13,7019.69,7011.13,7002.46,6782.08,6663.76,6578,
  6507.49,6446.37,6391.81,6342.16,6296.38,6253.77,6213.8,6176.09,6140.34,6106.31,6073.81,6042.69,6012.81,5984.07,5956.36,5929.62,5903.75,5878.71,5854.44,5830.88,5808,5785.76,5764.12,5743.05,5722.51,
  5702.49,5682.96,5663.89,5645.27,5627.07,5609.29,5591.89,5574.87,5558.22,5541.91,5525.94,5510.29,5494.96,5479.93,5465.19,5450.74,5436.56,5422.64,5408.99,5395.59,5382.43,5369.51,5356.82,5344.35,5332.1,
  5320.07,5308.24,5296.62,5285.19,5273.95,5262.9,5252.04,5241.35,5230.84,5220.5,5210.33,5200.32,5190.47,5180.78,5171.24,5161.85,5152.61,5143.51,5134.55,5125.73,5117.04,5108.49,5100.07,5091.78,5083.61,
  5075.57,5067.64,5059.83,5052.14,5044.57,5037.1,5029.75,5022.51,5015.37,5008.33,5001.4,4994.57,4987.83,4981.2,4974.66,4968.21,4961.86,4955.59,4949.42,4943.34,4937.34,4931.42
];

// ═════════════════════════════════════════════════════════════════════════════
// 5. Closed forms (§4.5) and the §4.21 reference chain
// ═════════════════════════════════════════════════════════════════════════════
// α = ½ : g = (1 + d)·asin((1 + d)^−½) + d^½, g0 = π/2;   α = 1 : g = (4/3)·[(1 + d)^1.5 − d^1.5], g0 = 4/3;   G = (4/π)·(g − g0)
function gFn(d, a) { return a === 1 ? 4 / 3 * (Math.pow(1 + d, 1.5) - Math.pow(d, 1.5)) : (1 + d) * Math.asin(1 / Math.sqrt(1 + d)) + Math.sqrt(d); }
function gPrimeFn(d, a) { return a === 1 ? 2 * (Math.sqrt(1 + d) - Math.sqrt(d)) : Math.asin(1 / Math.sqrt(1 + d)); }
function GFn(d, a) { return 4 / Math.PI * (gFn(d, a) - (a === 1 ? 4 / 3 : Math.PI / 2)); }
function GinvFn(Gv, a) { let lo = Math.log(1e-9), hi = Math.log(1e7); for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (GFn(Math.exp(m), a) < Gv) lo = m; else hi = m; } return Math.exp((lo + hi) / 2); }
const Gx = { g: gFn, gPrime: gPrimeFn, G: GFn, Ginv: GinvFn };

const BBL = 5.614583;                       // ft³ per bbl
const REF = (() => {
  const r = {
    datumTvd: 10000, rhoPpg: 8.43, grad: 8.43 * 0.052, idIn: 4.778, odIn: 5.5, wallIn: 0.361, nPerf: 12, dPerf: 0.40, cdPerf: 0.6,
    Vi: 25, q: 5, tp: 5 / 60, tStart: 2 / 60, ts: 7 / 60, tEndShut: 72, pStart: 4500, pLast: 7953, tb: 2 / 60 + 35 / 3600, pb: 4500 + 6323 * 35 / 60,
    Ep: 5.0e6, hf: 50, hp: 40, pr: 4500, phi: 0.06, ct: 1e-5, mu: 0.5, isip: 7600, sigmaC: 7000, mG: 600 / 18, c: 4539,
    sigmaGauge: 0.0029, quantum: 0.01, at: '2026-11-07T10:00:00Z',
  };
  r.rho = r.rhoPpg * 7.48052 / 32.174;                          // slug/ft³
  r.cSys = 144 / (r.rho * r.c * r.c);                           // 1/psi
  r.area = Math.PI / 4 * Math.pow(r.idIn / 12, 2);              // ft²
  r.Vw = r.datumTvd * r.area;                                   // ft³
  r.VwCwFt3 = r.Vw * r.cSys;                                    // ft³/psi
  r.VwCw = r.VwCwFt3 / BBL;                                     // bbl/psi
  r.dtDc = GinvFn((r.isip - r.sigmaC) / r.mG, 0.5);             // 61.0187
  r.dtc = r.dtDc * r.tp;                                        // h
  r.tcInj = r.tp + r.dtc;                                       // h, injection clock
  return r;
})();
// FIX.ds generating function (shut-in time dt in h → psia)
function FLfn(tInj, tcInj) { return 2 / Math.PI * Math.asin(Math.sqrt(Math.min(1, tcInj / tInj))); }
function pFall(dt) { const d = dt / REF.tp; return d <= REF.dtDc ? REF.isip - REF.mG * GFn(d, 0.5) : REF.pr + (REF.sigmaC - REF.pr) * FLfn(dt + REF.tp, REF.tcInj); }
function dpdtFall(dt) {                                          // dp/d(dt), psi/h (negative)
  const d = dt / REF.tp;
  if (d <= REF.dtDc) return -REF.mG * (4 / Math.PI) * gPrimeFn(d, 0.5) / REF.tp;
  const t = dt + REF.tp, u = Math.sqrt(REF.tcInj / t);
  return (REF.sigmaC - REF.pr) * (2 / Math.PI) / Math.sqrt(1 - u * u) * (-u / (2 * t));
}
function dtAtP(p) { let lo = 1e-6, hi = 1e4; for (let i = 0; i < 200; i++) { const m = Math.sqrt(lo * hi); if (pFall(m) > p) lo = m; else hi = m; } return Math.sqrt(lo * hi); }
const fx = (v, n) => +v.toFixed(n);
const sf = (v, n) => +v.toPrecision(n);

// The storage-consistent chain of §4.6 / §4.9 / §4.10 for one closure candidate (the what-if table, §6.2).
function chain(pc, o) {
  o = o || {};
  const R = REF, Ep = o.Ep || R.Ep, hf = o.hf || R.hf, hp = o.hp || R.hp, isip = o.isip || R.isip;
  const Vstar = (o.ViStar || R.Vi) * BBL;                        // ft³ (§4.21: the 25 bbl is V_i*)
  const dtc = dtAtP(pc), dtD = dtc / R.tp, Gc = GFn(dtD, 0.5), Gc1 = GFn(dtD, 1);
  const pn = isip - pc, etaG = Gc / (Gc + 2), eta1 = Gc1 / (Gc1 + 16 / (3 * Math.PI));
  const Csys = etaG * Vstar / pn, AfCf = Csys - R.VwCwFt3, Rvis = AfCf / Csys;
  const Vf = AfCf * pn, VLts = Vstar * (1 - etaG), etaF = Vf / (Vf + VLts), sqtp = Math.sqrt(R.tp * 60);
  const CLof = (rp, Af) => 2 * R.mG * Csys / (Math.PI * rp * Af * sqtp);
  const rpP = Math.min(1, hp / hf);
  const xfP = AfCf * Ep / (Math.PI * hf * hf), AfP = 2 * xfP * hf;
  const xfK = Math.sqrt(AfCf * Ep / (2 * Math.PI * hf)), AfK = 2 * xfK * hf;
  const Rr = Math.pow(3 * Ep * AfCf / 16, 1 / 3), AfR = Math.PI * Rr * Rr, u = Math.min(1, hp / (2 * Rr)), rpR = 2 / Math.PI * (u * Math.sqrt(1 - u * u) + Math.asin(u));
  const geo = (Af, rp, wf) => {
    const w = AfCf * pn / Af * 12;
    return { cf: AfCf / Af, Af: fx(Af, 0), rp: fx(rp, 4), CL: sf(CLof(rp, Af), 4), wAvg: fx(w, 4), wMax: fx(w * wf, 4), Vf: fx(Vf / BBL, 3), VLpump: fx(VLts / BBL, 3) };
  };
  const PKN = Object.assign({ xf: fx(xfP, 1) }, geo(AfP, rpP, 4 / Math.PI));
  const KGD = Object.assign({ xf: fx(xfK, 1) }, geo(AfK, rpP, 4 / Math.PI));
  const radial = Object.assign({ R: fx(Rr, 1) }, geo(AfR, rpR, 1.5));
  PKN.cf = sf(PKN.cf, 4); KGD.cf = sf(KGD.cf, 4); radial.cf = sf(radial.cf, 4);
  const Gamma = 2 * R.mG / (Math.PI * sqtp), dpCL = 0.5 * (isip + pc) - R.pr;
  const kCL = 1000 * Math.pow(CLof(rpP, AfP) / (0.0374 * dpCL), 2) * R.mu / (R.phi * R.ct);
  const msgs = [];
  const barrier = o.barrierSpacing || hf;
  if (2 * Rr > barrier) msgs.push('Radial: 2R = ' + (2 * Rr).toFixed(1) + ' ft exceeds the ' + barrier + ' ft barrier spacing; the radial geometry is not consistent.');
  return {
    pClosure: fx(pc, 1), family: o.family === undefined ? null : o.family, method: o.method === undefined ? null : o.method,
    Gc: fx(Gc, 3), dtc: fx(dtc, 4), dtDc: fx(dtD, 3), ViStar: fx(Vstar / BBL, 3),
    eta: { a05: fx(etaG, 4), a1: fx(eta1, 4), matched: fx(etaG, 4), alphaUsed: 0.5, etaF: fx(etaF, 4) },
    Csys: sf(Csys / BBL, 4), VwCw: sf(R.VwCwFt3 / BBL, 4), AfCf: sf(AfCf / BBL, 4), Rvis: fx(Rvis, 4), pn: fx(pn, 1), chi: fx(pn / (R.mG * Gc), 3),
    gradIsip: fx(isip / R.datumTvd, 4), gradClosure: fx(pc / R.datumTvd, 4), Gamma: fx(Gamma, 3), GammaPKN: fx(Math.PI / 2 * Gamma / Rvis, 3), mG: fx(R.mG, 3),
    geometry: { model: 'PKN', auto: true, consistent: true, msgs, byModel: { PKN, KGD, radial } },
    spurt: { value: null, note: 'Spurt is not separable from a falloff alone; the efficiency is an upper bound.' },
    kBefore: { kCL: { k: sf(kCL, 3), dpCL: fx(dpCL, 1), factor: 2, kCorr: null }, kH: null },
    pdlMult: null, farField: null,
    padFraction: { lo: fx((1 - eta1) / (1 + eta1), 4), hi: fx((1 - etaG) / (1 + etaG), 4) }, stressCal: null, ev: ['F1'],
    _raw: { Csys, AfCf, Rvis, etaG, eta1, xfP, CL: CLof(rpP, AfP), Gc, dtc, pn },
  };
}
const stripRaw = (o) => { delete o._raw; return o; };
// frictional limit σ ≥ p_p + (S_v − p_p)/[√(μ² + 1) + μ]²  (§4.8)
function frictional(pp, sv, mu) { const f = Math.pow(Math.sqrt(mu * mu + 1) + mu, 2); return pp + (sv - pp) / f; }

// ═════════════════════════════════════════════════════════════════════════════
// 6. Fixtures
// ═════════════════════════════════════════════════════════════════════════════
function genDs() {
  const q = DS_T.map((t, i) => (i >= 10 && i < 130 ? 7200 : 0));
  return { t: DS_T.slice(), p: DS_P.slice(), q, name: 'DFIT reference (synthetic)', source: 'dfit-demo', timeUnit: 'h', timeUnitOriginal: 'h',
           rateUnit: 'bbl/d', ratePhase: 'water', meta: { psigConverted: {} } };
}
function refInputs() {
  const I = defaultInputs();
  I.datumTvd = 10000; I.datumMd = 10000;
  I.strings = [{ tubKey: null, id: REF.idIn, od: REF.odIn, wall: REF.wallIn, topMd: 0, botMd: 10000 }];
  I.fluid.kind = 'slickwater'; I.fluid.rhoPpg = 8.43; I.fluid.muCp = 1.0;
  I.perfs = { n: 12, dIn: 0.40, cd: 0.6 };
  I.rock.Ep = REF.Ep; I.rock.EpSource = 'static'; I.rock.hf = REF.hf; I.rock.hp = REF.hp; I.rock.barrierSpacing = 50;
  I.options.alpha = 0.5;
  return I;
}
function evArr(id) { return [id]; }
function W(code, level, text, evs) { return { code, level, text, ev: evs || [] }; }

function genRun(ds) {
  const R = REF, inputs = refInputs(), at = R.at;
  const n = ds.t.length, iS = 129;                               // last pumping sample (t = ts)
  // ── prepare ──
  const prep = { ok: true, t: ds.t.slice(), pw: ds.p.slice(), band: null, pSurf: null, q: ds.q.map((x) => x / 1440), T: null, idx: ds.t.map((_, i) => i),
                 src: 'bh', sigma: R.sigmaGauge, quantum: R.quantum, applied: { atmDelta: 0, unitFix: null, clockOffsetH: 0, masked: 0 }, flags: [], hf: null };
  // ── events ──
  const ViFrac = R.Vi - R.VwCw * (R.pLast - R.sigmaC);           // §4.21 convention (25 bbl = V_i*), see the header
  const events = {
    ok: true, tStart: fx(R.tStart, 9), tb: fx(R.tb, 9), pb: fx(R.pb, 2), ts: fx(R.ts, 9), tsRefined: false, tEnd: ds.t[n - 1], qMax: 5, qLast: 5,
    Vi: 25, ViFrac: fx(ViFrac, 3), ViStar: 25, Vfill: 0, Vfb: 0, qEq: 5, VwCwMeasured: sf(R.VwCw, 4),
    tp: { pump: fx(R.tp, 9), breakdown: fx(R.ts - R.tb, 9), veq: fx(R.tp, 9) }, rampDownFrac: 0,
    steps: [], flowback: null, cycles: [{ tStart: fx(R.tStart, 9), ts: fx(R.ts, 9), Vi: 25, closedBefore: false, rampWin: null }],
    schedule: [{ t: fx(R.ts - R.tp, 9), q: 5 }, { t: fx(R.ts, 9), q: 0 }],
    source: { tStart: 'auto', tb: 'auto', ts: 'auto' }, warnings: [], ev: ['E1'],
  };
  // ── derivatives (exact derivatives of the generating function at the falloff samples) ──
  const dts = [], gMin = 0.05;
  for (let i = iS + 1; i < n; i++) dts.push(ds.t[i] - R.ts);
  const d = { ok: true, alpha: 0.5, gType: 'a05', tp: fx(R.tp, 9), tpChoice: 'pump', dt: [], dtD: [], G: [], p: [], dpIsip: [], GdPdG: [], dPdG: [], sqrtDt: [], sdPds: [], dPds: [],
              D: [], Dref: [], ppd: [], mG: sf(R.mG, 10), earlyWin: [gMin, 12], h: null, axis: null, L: 0.1, gMin, gMinWhy: '1%', usable: [], sigmaY: 0.001, ev: ['G1'] };
  dts.forEach((dt, k) => {
    const dD = dt / R.tp, Gv = GFn(dD, 0.5), Gp = 4 / Math.PI * gPrimeFn(dD, 0.5), dpdt = dpdtFall(dt), dpdG = dpdt * R.tp / Gp;
    d.dt.push(dt); d.dtD.push(dD); d.G.push(Gv); d.p.push(ds.p[iS + 1 + k]); d.dpIsip.push(fx(R.isip - ds.p[iS + 1 + k], 2));
    d.GdPdG.push(sf(Gv * Math.abs(dpdG), 8)); d.dPdG.push(sf(Math.abs(dpdG), 8)); d.sqrtDt.push(Math.sqrt(dt));
    d.sdPds.push(sf(2 * dt * Math.abs(dpdt), 8)); d.dPds.push(sf(2 * Math.sqrt(dt) * Math.abs(dpdt), 8));
    d.D.push(sf(dt * Math.abs(dpdt), 8)); d.Dref.push(sf(R.mG * dD * Gp, 8)); d.ppd.push(sf(Math.abs(dpdt), 8)); d.usable.push(Gv >= gMin ? 1 : 0);
  });
  const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
  const after = (key) => d[key].filter((v, i) => d.G[i] >= gMin && v != null);
  const ax = (key) => { const a = after(key), lo = pct(a, 0.02), hi = pct(a, 0.98), pad = 0.1 * (hi - lo); return [fx(Math.max(0, lo - pad), 4), fx(hi + pad, 4)]; };
  d.axis = { GdPdG: ax('GdPdG'), dPdG: ax('dPdG') };
  // ── ISIP (§4.4 P3a given numbers; se chosen so the inverse-variance mean is 7,600.0) ──
  const cand = [
    { method: 'wh', family: 'wave', value: 7605.0, se: 3.162, ok: true, upper: false, bleedAtEnd: 1.2, viscCorr: null, why: 'Water-hammer midline with the bleed-off term fitted.', ev: ['H1'] },
    { method: 'g', family: 'falloff', value: 7600.0, se: 1.0, ok: true, upper: false, bleedAtEnd: null, viscCorr: null, why: 'Early-G straight line on G from 0.05 to 12.', ev: ['I2'] },
    { method: 'sd', family: 'friction', value: 7595.5, se: 3.0, ok: true, upper: false, bleedAtEnd: null, viscCorr: null, why: 'Step-down intercept (better determined member of the friction family).', ev: ['S1'] },
    { method: 'lp', family: 'friction', value: 7599.4, se: 6.0, ok: true, upper: false, bleedAtEnd: null, viscCorr: 35, why: 'Last pump pressure minus perforation, tortuosity and in-fracture viscous losses.', ev: ['S2'] },
  ];
  const fam = [cand[0], cand[1], cand[2]], wsum = fam.reduce((a, c) => a + 1 / (c.se * c.se), 0);
  const isipVal = fam.reduce((a, c) => a + c.value / (c.se * c.se), 0) / wsum;
  const isip = { ok: true, value: fx(isipVal, 1), spread: fx(7605.0 - 7595.5, 1), confidence: 'high',
                 why: ['Three families agree within 9.5 psi, inside max(10 psi, 2 % of pn) = 12 psi.'], candidates: cand, loglogCheck: { isipBest: 7600.0, ok: true }, ev: ['I1'] };
  // ── closure picks ──
  const Gc = GFn(R.dtDc, 0.5), dtc = R.dtc;
  const band = (s) => ({ p10: fx(7000 - 1.2816 * s, 1), p50: 7000.0, p90: fx(7000 + 1.2816 * s, 1) });
  const pick = (method, family, vote, same, s, win, evid, text) => ({
    method, family, vote, ok: true, dt: fx(dtc, 4), G: fx(Gc, 3), p: 7000.0, band: band(s), se: s, window: win, admissible: true, vetoes: [], warnings: [],
    sameEvidenceAs: same, upperSide: false, evidence: [{ text, ev: [evid] }], ev: [evid] });
  const picks = [
    pick('compliance', 'F1', true, null, 3.9, [0.5, 18.0], 'C2', 'G·dP/dG leaves the line through the origin at G 18.0 (ε 0.02).'),
    pick('crel', 'F1', false, 'compliance', 3.9, [0.5, 18.0], 'C6', 'Relative compliance drops below 0.98 at the same G.'),
    pick('loglog', 'F1', false, 'compliance', 4.4, [0.5, 18.0], 'C7', 'D leaves the Nolte reference curve at the compliance pick (iota below 0.05, same evidence).'),
    pick('tangent', 'F2', true, null, 4.4, [0.5, 18.0], 'C3', 'The tangent through the origin touches G·dP/dG up to G 18.0.'),
    pick('sqrt', 'F2', false, 'tangent', 4.8, [0.5, 18.0], 'C4', 'Maximum of the square-root derivative at the tangent pick (same evidence for ΔtD above 5).'),
    pick('maxdpdg', 'F2', false, 'tangent', 4.8, [0.5, 18.0], 'C5', 'dP/dG is largest just before G 18.0.'),
    pick('varcomp', 'F3', false, null, 6.0, [0.5, 27.0], 'C8', 'The variable-compliance fit gives 7,000 psia (cross-check, no vote).'),
  ];
  // ── consensus ──
  const tau = Math.max(15, 0.003 * 7000, 0.03 * 600);
  // 104 = 54 grid settings + 50 bootstrap resamples; re-centred so each family median is exactly 7,000 psia
  const r1 = rng(1), samp = (s) => {
    const z = []; for (let i = 0; i < 104; i++) z.push(s * gauss(r1));
    const med = z.slice().sort((a, b) => a - b)[52];
    return z.map((x) => fx(7000 + x - med, 2));
  };
  const sF1 = samp(3.9), sF2 = samp(4.4);
  const statOf = (a) => { const s = a.slice().sort((x, y) => x - y), q = (f) => s[Math.round(f * (s.length - 1))], p10 = q(0.1), p90 = q(0.9);
    return { p10: fx(p10, 1), p50: fx(q(0.5), 1), p90: fx(p90, 1), sigma: fx(Math.max((p90 - p10) / 2.563, 1, 2 * R.sigmaGauge), 2), n: a.length }; };
  const F1s = statOf(sF1), F2s = statOf(sF2);
  const w1 = 1 / (F1s.sigma * F1s.sigma), w2 = 1 / (F2s.sigma * F2s.sigma);
  const cValue = fx((F1s.p50 * w1 + F2s.p50 * w2) / (w1 + w2), 1);
  const wHalf = Math.max((F1s.p90 - F1s.p10) / 2, (F2s.p90 - F2s.p10) / 2), sSep = Math.abs(F1s.p50 - F2s.p50);
  const grid = (base) => [[base - 1.5, base - 0.5, base + 0.5], [base - 1.0, base, base + 1.0], [base - 0.5, base + 0.5, base + 1.5]].map((r) => r.map((x) => fx(x, 1)));
  const gSpread = fx(1.5, 1);
  const vetoP = frictional(R.pr, 0.9 * R.datumTvd, 1.0), warnP = frictional(R.pr, 1.0 * R.datumTvd, 0.6);
  const ruleRows = [
    ['K1', 'mode', 0, null, 'Mode single: the family medians differ by less than 2.5 τ and the bands overlap.'],
    ['K2', 's', sSep, tau, 'Family separation s within τ.'],
    ['K3', 'w', wHalf, tau, 'Largest voting-family half-width w within τ.'],
    ['K4', 'g', gSpread, tau, 'Stability-grid spread g within τ.'],
    ['K5', 'Rvis', 0.979, 0.7, 'Storage-consistent closure visibility above 0.7.'],
    ['K6', 'past', 0.6, 0.3, 'More than 0.3 G-decade of data after the pick.'],
    ['K7', 'noise', 0.001, 0.02, 'Derivative noise at the pick below 2 %.'],
    ['K8', 'chi', 1.0, null, 'Consistency ratio within 0.9 to 1.1.'],
    ['K9', 'overlap', 0, null, 'No vacuum or thermal flag overlaps the pick window.'],
    ['K10', 'frictional', fx(vetoP, 1), null, 'The pick lies above both frictional-limit lines.'],
  ].map((r) => ({ id: r[0], fired: false, value: r[2] === null ? null : fx(r[2], 3), threshold: r[3] === null ? null : fx(r[3], 3), text: r[4] }));
  const forecast = [7200, 6800].map((sig) => { const G2 = (R.isip - sig) / R.mG; return { sigma: sig, Gc: fx(G2, 3), dtc: fx(GinvFn(G2, 0.5) * R.tp, 3) }; });
  const consensus = {
    ok: true, mode: 'single', value: cValue, range: null,
    families: { F0: null, F1: F1s, F2: F2s, F3: { p10: 6992.3, p50: 7000.0, p90: 7007.7, sigma: 6.0, n: 1 }, F4: null },
    tau: fx(tau, 1), metrics: { w: fx(wHalf, 1), s: fx(sSep, 1), g: gSpread }, bimodal: false, preferred: null, preferredWhy: 'Families agree (normal leak-off).',
    confidence: 'high', calibrated: false, hitRate: null, rules: ruleRows,
    stability: { L: [0.05, 0.1, 0.2], tp: ['pump', 'breakdown', 'veq'], grid: { F1: grid(F1s.p50), F2: grid(F2s.p50) }, unstable: false },
    samples: { F1: sF1, F2: sF2, F4: [] },
    counterfactual: { knob: 'L', setting: '0.2', text: 'Within the tested settings the compliance pick moves at most 2 psi (largest effect: L); both families stay inside each other band.' },
    frictional: { veto: fx(vetoP, 1), warn: fx(warnP, 1) }, forecast, ev: ['C1', 'K1'],
  };
  const consensusLite = { mode: 'single', value: cValue, range: null, families: { F1: { p50: F1s.p50 }, F2: { p50: F2s.p50 }, F4: null }, confidence: 'stale' };
  // ── classification ──
  const classification = {
    ok: true, type: 'normal', scores: { normal: 0.92, matrix: 0.12, pdl: 0.02, tip: 0.03, hrContact: 0.05, storage: 0.04 }, alt: [],
    features: { iota: 0.0, curv: 0.0, curvExp: 0.0, curvWb: 0.0, H: 0.0, DoverDref: 1.0, Rvis: 0.979, VwCwRatio: 1.0, unitSlopeSink: false, bleedOffExplained: true },
    pdl: null, hr: null, evidence: ['G·dP/dG is a straight line through the origin up to closure (iota 0.00).', 'The curvature matches the reservoir-controlled expectation within 0.02.'], ev: ['M1'],
  };
  // ── frac outputs, what-if ──
  const chosenC = stripRaw(chain(cValue, { family: null, method: 'consensus' }));
  const byF1 = stripRaw(chain(F1s.p50, { family: 'F1', method: 'compliance' }));
  const byF2 = stripRaw(chain(F2s.p50, { family: 'F2', method: 'tangent' }));
  const whatIf = [
    Object.assign({ label: 'Consensus' }, stripRaw(chain(cValue, { family: null, method: 'consensus' }))),
    Object.assign({ label: 'F1 compliance' }, stripRaw(chain(F1s.p50, { family: 'F1', method: 'compliance' }))),
    Object.assign({ label: 'F2 tangent' }, stripRaw(chain(F2s.p50, { family: 'F2', method: 'tangent' }))),
    Object.assign({ label: 'What-if 6,800 psia' }, stripRaw(chain(6800, { family: null, method: 'user' }))),
  ];
  // ── after-closure (FIX.ds is an exact Carter linear line after closure) ──
  const aca = genRefAca(ds, chosenC);
  // ── leak plot ──
  const leak = { ok: true, form: 'linear', A: fx(aca.nolte.lin.mL, 1), B: 0, d: 0, dPrior: 0, corrBd: 0, separable: true, qk: 0, qkCI: [-0.002, 0.002], floor: 0.003,
                 piCorr: 4500.0, piUncorr: 4500.0, windowBiasNote: null, qkMax: 0.05, theta: 0.2, verdict: 'none' };
  // ── uncertainty (seeded draws through the chain) ──
  const unc = genUnc(cValue, F1s, R);
  // ── triage ──
  const triage = {
    ok: true, light: 'green', verdict: 'interpretable',
    checks: [
      { id: 'units', title: 'Units and time base', level: 'pass', value: null, threshold: null, text: 'Columns mapped, time monotonic, no gaps.', ev: ['Q1'] },
      { id: 'stiffness', title: 'Wellbore stiffness', level: 'pass', value: 1.0, threshold: 2, text: 'Ramp storage equals the theory value (ratio 1.00).', ev: ['Q2'] },
      { id: 'shutin', title: 'Shut-in duration', level: 'pass', value: 72, threshold: null, text: 'The shut-in covers 14 closure times.', ev: ['Q3'] },
      { id: 'noise', title: 'Derivative noise', level: 'pass', value: 0.001, threshold: 0.05, text: 'Derivative noise at the pick is 0.1 % of D.', ev: ['Q4'] },
    ],
    windows: { usable: [[fx(R.ts, 9), ds.t[n - 1]]], excluded: [] }, blunders: [],
    repump: { verdict: 'continue', rules: [{ id: 'R1', level: 'pass', text: 'Breakdown seen at 8,188 psia.' }, { id: 'R2', level: 'pass', text: 'ISIP gradient 0.760 psi/ft lies between the pore and overburden gradients.' }], ack: false },
    grade: { letter: 'A', why: ['Triage green; closure single with label high; p_i label medium.'] }, salvage: [], ev: ['Q1'],
  };
  const grade = { letter: 'A', why: ['Triage green; closure single with label high (uncalibrated); p_i label medium.'] };
  const run = {
    v: 1, ok: true, fast: false, dsHash: dsHash(ds), inputsHash: inputHash(inputs), picksHash: picksHash(emptyPicks()), seed: 1,
    prep, events, triage, isip, derivs: d, picks, consensus, consensusLite, classification,
    frac: { chosen: chosenC, byFamily: { F1: byF1, F2: byF2 } }, whatIf, aca, leak, unc, evidence: null, report: null, grade, summary: null, warnings: [],
    counts: { evals: 54 * 7 + 50 * 7, refits: 0, draws: unc.n },
  };
  run.evidence = genEvidence(run);
  run.summary = genSummary(run, ds, inputs, 't1');
  run.report = genReport(run);
  return { run, inputs };
}
function emptyPicks() { return { isip: null, closure: null, user: {}, aca: { origin: 'centroid', linWin: null, radWin: null, piLevel: null } }; }

function linfit(X, Y) { const m = X.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < m; i++) { sx += X[i]; sy += Y[i]; sxx += X[i] * X[i]; sxy += X[i] * Y[i]; } const s = (m * sxy - sx * sy) / (m * sxx - sx * sx); return { m: s, b: (sy - s * sx) / m }; }
// After-closure result on FIX.ds (injection clock tInj = t − tStart)
function genRefAca(ds, chosen) {
  const R = REF, tc = R.tcInj, t0 = tc / 3, V = R.Vi, LB = 0.25, sigma = R.sigmaGauge;
  const pOf = (tInj) => pFall(tInj - R.tp), Dof = (tInj) => (tInj - t0) * Math.abs(dpdtFall(tInj - R.tp));
  const sDof = (tInj) => { const e = 1e-3, x = tInj - t0; return (Math.log(Dof(t0 + x * Math.exp(e))) - Math.log(Dof(t0 + x * Math.exp(-e)))) / (2 * e); };
  const tAll = ds.t.map((t) => t - R.tStart).filter((ti) => ti - R.tp > R.dtc * 1.0001);
  const pick = []; for (let i = 0; i < tAll.length; i += 4) pick.push(tAll[i]);
  if (pick[pick.length - 1] !== tAll[tAll.length - 1]) pick.push(tAll[tAll.length - 1]);
  const dg = { x: [], D: [], sD: [], n: [], piLo: [], piHi: [], piPoint: [], noiseD: [], regimes: [], sequenceOk: true };
  pick.forEach((ti) => {
    const p = pOf(ti), D = Dof(ti), s = sDof(ti), s1 = sDof(t0 + (ti - t0) / Math.pow(10, 0.25)), s2 = sDof(t0 + (ti - t0) * Math.pow(10, 0.25));
    dg.x.push(sf(ti - t0, 8)); dg.D.push(sf(D, 6)); dg.sD.push(fx(s, 4)); dg.n.push(fx(-2 * s, 4)); // the bracket holds only while the s_D sequence is linear → radial-ward (no s_D below −1.1, §4.12)
    const gate = s >= -1.1;
    dg.piLo.push(gate ? fx(p - 2 * D, 3) : null); dg.piHi.push(gate ? fx(p - D, 3) : null);
    dg.piPoint.push((Math.abs(s2 - s1) < 0.1 && Math.abs(s + 0.5) <= 0.07) ? fx(p - (2 / (-2 * s)) * D, 3) : null);
    dg.noiseD.push(fx(sigma / (Math.sqrt(2) * LB), 5));
  });
  const linIdx = dg.sD.map((s, i) => (Math.abs(s + 0.5) <= 0.07 ? i : -1)).filter((i) => i >= 0);
  if (linIdx.length) dg.regimes.push({ kind: 'linear', t0: fx(dg.x[linIdx[0]] + t0, 4), t1: fx(dg.x[linIdx[linIdx.length - 1]] + t0, 4), slope: -0.5 });
  const tEnd = pick[pick.length - 1], late = tAll.filter((ti) => ti >= tEnd / 3);
  const fitOn = (fxn) => linfit(late.map(fxn), late.map(pOf));
  const CHI = 16 / (Math.PI * Math.PI);
  const FRc = (ti) => { const u = Math.sqrt(tc / ti); return CHI / 4 * u * 0.5 * Math.log((1 + u) / (1 - u)); };
  const linF = fitOn((ti) => FLfn(ti, tc)), radF = fitOn(FRc), impL = fitOn((ti) => 1 / Math.sqrt(ti - t0)), impR = fitOn((ti) => 1 / (ti - t0));
  const CL = chosen.geometry.byModel.PKN.CL, kL = R.mu / (R.phi * R.ct) * Math.pow(CL / (1.1827e-3 * linF.m), 2);
  const Ask = 97.54 * V * Math.sqrt(R.mu / (R.phi * R.ct)) / impL.m;
  const pEnd = pOf(tEnd), DEnd = Dof(tEnd);
  const cart = [fx(linF.b, 2), fx(radF.b, 2)], imp = [fx(impL.b, 2), fx(impR.b, 2)], deriv = [fx(pEnd - 2 * DEnd, 2), fx(pEnd - DEnd, 2)];
  const los = [['cart', cart[0]], ['imp', imp[0]], ['deriv', deriv[0]]], his = [['cart', cart[1]], ['imp', imp[1]], ['deriv', deriv[1]]];
  const lo = los.reduce((a, b) => (b[1] > a[1] ? b : a)), hi = his.reduce((a, b) => (b[1] < a[1] ? b : a));
  const Lmax = 2 * chosen.geometry.byModel.PKN.xf, Amax = 2 * Lmax * R.hp;
  const kHi = 1.6 * R.phi * R.mu * R.ct * Lmax * Lmax / (0.0002637 * (tEnd - t0));
  const kLo = Math.pow(97.54 * V / (Amax * impL.m), 2) * R.mu / (R.phi * R.ct);
  return {
    ok: true, regimeSummary: 'linear', origin: 'centroid', t0: fx(t0, 6), tcInj: fx(tc, 6), V, diag: dg,
    nolte: { lin: { pr: fx(linF.b, 2), mL: fx(linF.m, 2), k: sf(kL, 3), win: [fx(late[0], 4), fx(tEnd, 4)] }, rad: null },
    impulse: { lin: { pi: fx(impL.b, 2), m: fx(impL.m, 2), group: 'Ask', value: sf(Ask, 4) }, rad: null, sph: null },
    brackets: { cart, imp, deriv, combined: [lo[1], hi[1]], edges: { lo: lo[0], hi: hi[0] } },
    pi: { value: fx(linF.b, 1), lo: lo[1], hi: hi[1], label: 'medium', reasons: ['Linear flow only: the F_L line and the impulse line agree within 10 psi.', 'Radial flow is not reached by the end of the shut-in.'] },
    kh: null,
    bounds: { kLo: sf(kLo, 3), kHi: sf(kHi, 3), binding: [{ edge: 'lo', rule: 'linear-Amax', value: fx(Amax, 0) }, { edge: 'hi', rule: 'radial-not-reached', value: fx(Lmax, 1) }], direction: 'normal' },
    match: null, gas: null, tidalCt: null,
    eps: { atClosure: fx(R.VwCw * (R.sigmaC - R.pr) / V, 4), now: fx(R.VwCw * (pEnd - R.pr) / V, 4) },
    ratios: { AacaOverAcarter: null, lambda: fx(linF.m / (0.5 * (R.isip + R.sigmaC) - R.pr), 3) }, warnings: [], ev: ['A1'],
  };
}
// Example B (§4.12; research note aca2b.js): V 15 bbl, t_e 5 min, t_c 2 h, k 0.01 md, h 40 ft, μ 0.8 cp, φ 0.12, c_t 1.2e-5, L 50 ft, p_i 4,500.
// Diagnosis columns computed once by the prototype (4,000-panel Gauss–Legendre convolution of a Carter source on a uniform-flux
// plane, D = |dp/d ln(t − t_c/3)|); committed as data. x = t_inj − t0.
const EXB = {
  T: [2.5, 2.94874, 3.47802, 4.1023, 4.83864, 5.70715, 6.73156, 7.93983, 9.36499, 11.046, 13.0286, 15.3672, 18.1255, 21.379, 25.2164, 29.7426, 35.0812, 41.3781, 48.8052, 57.5655, 67.8982, 80.0855, 94.4604, 111.416, 131.414, 155.002, 182.824, 215.64, 254.346, 300],
  D: [1413.7, 1083.08, 906.323, 787.357, 697.594, 625.277, 564.606, 512.348, 466.533, 425.869, 389.465, 356.663, 326.971, 299.999, 275.442, 253.07, 232.746, 214.437, 198.194, 184.078, 172.056, 161.92, 153.278, 145.618, 138.414, 131.222, 123.745, 115.853, 107.554, 98.9636],
  sD: [-1.5672, -0.9767, -0.7594, -0.6546, -0.5971, -0.563, -0.5419, -0.5283, -0.5193, -0.5133, -0.5093, -0.5065, -0.5046, -0.5031, -0.5017, -0.4992, -0.4933, -0.4805, -0.4578, -0.4245, -0.3844, -0.3454, -0.3163, -0.3039, -0.3107, -0.3355, -0.3744, -0.4226, -0.4758, -0.5303],
  pw: [6634.326, 6365.432, 6159.274, 5990.027, 5846.156, 5721.261, 5611.32, 5513.589, 5426.085, 5347.309, 5276.098, 5211.504, 5152.764, 5099.228, 5050.355, 5005.668, 4964.749, 4927.207, 4892.662, 4860.735, 4831.05, 4803.254, 4777.053, 4752.229, 4728.657, 4706.294, 4685.159, 4665.309, 4646.811, 4629.72],
  lin: { pr: 4500.00, mL: 3028.14, k: 0.0100, win: [5, 30] }, imp: { pi: 4498.65, m: 2733.70, Ask: 398.9 },
  cart: [4441.72, 4567.59], impBr: [4441.72, 4567.58],
};
function genAcaB() {
  const t0 = 2 / 3, x = EXB.T.map((t) => sf(t - t0, 6)), sigma = 0.01, LB = 0.25;
  const gate = (i) => EXB.sD[i] >= -1.1;   // closure proximity (s_D below −1.1): no bracket (§4.12)
  const piLo = EXB.pw.map((p, i) => (gate(i) ? fx(p - 2 * EXB.D[i], 3) : null)), piHi = EXB.pw.map((p, i) => (gate(i) ? fx(p - EXB.D[i], 3) : null));
  // point estimate only in the linear band with s_D locally constant (t 5.7–41 h)
  const piPoint = EXB.sD.map((s, i) => (EXB.T[i] >= 5.7 && EXB.T[i] <= 41.4 && Math.abs(s + 0.5) <= 0.07) ? fx(EXB.pw[i] - (2 / (-2 * s)) * EXB.D[i], 3) : null);
  const deriv = [piLo[piLo.length - 1], piHi[piHi.length - 1]];
  const lo = Math.max(EXB.cart[0], EXB.impBr[0], deriv[0]), hi = Math.min(EXB.cart[1], EXB.impBr[1], deriv[1]);
  return {
    ok: true, regimeSummary: 'linear', origin: 'centroid', t0: fx(t0, 6), tcInj: 2, V: 15,
    diag: { x, D: EXB.D.slice(), sD: EXB.sD.slice(), n: EXB.sD.map((s) => fx(-2 * s, 4)), piLo, piHi, piPoint, noiseD: x.map(() => fx(sigma / (Math.sqrt(2) * LB), 5)),
            regimes: [{ kind: 'linear', t0: 5.70715, t1: 48.8052, slope: -0.5 }, { kind: 'transition', t0: 57.5655, t1: 300, slope: -0.42 }], sequenceOk: true },
    nolte: { lin: { pr: EXB.lin.pr, mL: EXB.lin.mL, k: EXB.lin.k, win: EXB.lin.win.slice() }, rad: null },
    impulse: { lin: { pi: EXB.imp.pi, m: EXB.imp.m, group: 'Ask', value: EXB.imp.Ask }, rad: null, sph: null },
    brackets: { cart: EXB.cart.slice(), imp: EXB.impBr.slice(), deriv, combined: [lo, hi], edges: { lo: lo === EXB.cart[0] ? 'cart' : 'imp', hi: 'deriv' } },
    pi: { value: 4500.0, lo, hi, label: 'medium', reasons: ['Linear flow only: the F_L line (4,500.0) and the centroid impulse line (4,498.6) agree within 10 psi.', 'Radial flow would start near 1,750 h; the shut-in ends at 300 h.'] },
    kh: null,
    bounds: { kLo: 0.0039, kHi: 0.0131, binding: [{ edge: 'lo', rule: 'linear-Amax', value: 80 }, { edge: 'hi', rule: 'trend', value: 300 }], direction: 'normal' },
    match: null, gas: null, tidalCt: null, eps: { atClosure: 0.031, now: 0.0063 }, ratios: { AacaOverAcarter: 1.0, lambda: 1.0 }, warnings: [], ev: ['A1'],
  };
}
function quantile(s, f) { return s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]; }
function genUnc(cValue, F1s, R) {
  const n = 1000, r = rng(1), draws = [];
  const inputs = [
    { name: 'closure', dist: 'empirical', params: { family: 'F1', samples: 104 }, provenance: 'stability' },
    { name: 'isip', dist: 'normal', params: { mu: 7600, sd: 3.7 }, provenance: 'dfit' },
    { name: 'Ep', dist: 'lognormal', params: { p50: R.Ep, sdLn: 0.2 }, provenance: 'user' },
    { name: 'hf', dist: 'normal', params: { mu: R.hf, sd: 5 }, provenance: 'user' },
  ];
  for (let i = 0; i < n; i++) {
    const x = { closure: cValue + F1s.sigma * gauss(r), isip: 7600 + 3.7 * gauss(r), Ep: R.Ep * Math.exp(0.2 * gauss(r)), hf: Math.max(20, R.hf + 5 * gauss(r)) };
    const c = chain(x.closure, { isip: x.isip, Ep: x.Ep, hf: x.hf, hp: Math.min(R.hp, x.hf) });
    draws.push({ x, y: { closure: x.closure, pn: c._raw.pn, eta: c._raw.etaG, xf: c._raw.xfP, CL: c._raw.CL } });
  }
  const outDef = { closure: 'psia', pn: 'psi', eta: '–', xf: 'ft', CL: 'ft/√min' };
  const outputs = {};
  Object.keys(outDef).forEach((k) => {
    const ys = draws.map((d) => d.y[k]), s = ys.slice().sort((a, b) => a - b), mean = ys.reduce((a, b) => a + b, 0) / n;
    const vtot = ys.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n || 1e-300;
    const shares = inputs.map((inp) => {
      const idx = draws.map((d, i) => i).sort((a, b) => draws[a].x[inp.name] - draws[b].x[inp.name]);
      let vb = 0; for (let b = 0; b < 10; b++) { const sl = idx.slice(b * 100, (b + 1) * 100), m = sl.reduce((a, i) => a + ys[i], 0) / sl.length; vb += (m - mean) * (m - mean) / 10; }
      return { input: inp.name, s: fx(Math.min(1, vb / vtot), 3) };
    });
    const dpOf = k === 'eta' ? 4 : k === 'CL' ? 8 : 2;
    outputs[k] = { p10: fx(quantile(s, 0.1), dpOf), p50: fx(quantile(s, 0.5), dpOf), p90: fx(quantile(s, 0.9), dpOf), unit: outDef[k], shares,
                   closureShare: shares[0].s, bimodal: false, byFamily: null, envelope: null };
  });
  const tornado = ['Ep', 'hf', 'closure'].map((inp) => ({ output: 'xf', input: inp, lo: outputs.xf.p10, hi: outputs.xf.p90 }));
  return { ok: true, n, seed: 1, mode: 'single', familyWeight: { F1: 0.5, F2: 0.5 }, inputs, outputs, tornado, ev: ['U1'] };
}
function genEvidence(run) {
  const items = {}, order = [];
  const add = (id, title, values, pathStr, text) => { items[id] = { id, group: id[0], title, values, path: pathStr, text }; order.push(id); };
  const v = (label, value, unit, dp) => ({ label, value, unit, dp });
  add('Q1', 'Triage', [v('light', 'green', '', 0)], 'triage', 'All checks pass.');
  add('Q2', 'Wellbore stiffness', [v('ratio', 1.0, '', 2)], 'triage.checks[1]', 'Ramp storage equals the theory value.');
  add('Q3', 'Shut-in duration', [v('shut-in', 72, 'h', 0)], 'triage.checks[2]', 'Shut-in long enough for after-closure analysis.');
  add('Q4', 'Derivative noise', [v('noise', 0.1, '%', 1)], 'triage.checks[3]', 'Derivative noise at the pick.');
  add('E1', 'Events', [v('tp', 5.0, 'min', 1), v('V_i', 25, 'bbl', 1)], 'events', 'Pump start, breakdown and shut-in from the rate record.');
  add('H1', 'Water-hammer ISIP', [v('ISIP', 7605.0, 'psia', 0)], 'isip.candidates[0]', 'Wave family member.');
  add('I1', 'ISIP', [v('ISIP', run.isip.value, 'psia', 0), v('spread', run.isip.spread, 'psi', 1)], 'isip', 'Inverse-variance mean over the families.');
  add('I2', 'Early-G ISIP', [v('ISIP', 7600.0, 'psia', 0)], 'isip.candidates[1]', 'Falloff family member.');
  add('S1', 'Step-down intercept', [v('p_frac', 7595.5, 'psia', 1)], 'isip.candidates[2]', 'Friction family member.');
  add('S2', 'Last pump minus friction', [v('ISIP', 7599.4, 'psia', 1)], 'isip.candidates[3]', 'Friction family member (same coefficients).');
  add('G1', 'Pre-closure derivatives', [v('m_G', run.derivs.mG, 'psi', 2)], 'derivs', 'G type: ideal α = ½.');
  add('C1', 'Closure consensus', [v('closure', run.consensus.value, 'psia', 0)], 'consensus', 'Single closure; families agree.');
  ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'].forEach((id) => {
    const pk = run.picks.find((p) => p.ev[0] === id);
    add(id, 'Closure pick: ' + pk.method, [v('p', pk.p, 'psia', 0), v('G', pk.G, '', 2)], 'picks[' + run.picks.indexOf(pk) + ']', pk.evidence[0].text);
  });
  run.consensus.rules.forEach((r, i) => add(r.id, 'Label rule ' + r.id, [v('value', r.value, '', 3)], 'consensus.rules[' + i + ']', r.text));
  add('M1', 'Leak-off type', [v('type', 'normal', '', 0)], 'classification', 'Normal leak-off.');
  add('F1', 'Fracture outputs', [v('pn', run.frac.chosen.pn, 'psi', 0), v('η', run.frac.chosen.eta.a05, '', 3), v('xf', run.frac.chosen.geometry.byModel.PKN.xf, 'ft', 0)], 'frac.chosen', 'Storage-consistent chain for the consensus closure.');
  add('A1', 'After-closure', [v('p_i', run.aca.pi.value, 'psia', 0), v('k', run.aca.nolte.lin.k, 'md', 6)], 'aca', 'Linear flow; F_L line.');
  add('U1', 'Uncertainty', [v('n', run.unc.n, 'draws', 0), v('seed', run.unc.seed, '', 0)], 'unc', 'Seeded draws through the closed-form chain.');
  return { items, order };
}
function genSummary(run, ds, inputs, id) {
  const c = run.frac.chosen, aca = run.aca;
  const gx = [], gy = [];
  const d = run.derivs, Gc = c.Gc, step = Math.max(1, Math.floor(d.G.length / 60));
  for (let i = 0; i < d.G.length && gx.length < 60; i += step) if (d.G[i] > 0 && d.GdPdG[i] != null) { gx.push(fx(d.G[i] / Gc, 4)); gy.push(fx(d.GdPdG[i] / (run.derivs.mG * d.G[i]), 4)); }
  const s = {
    at: REF.at, dsHash: dsHash(ds), inputHash: inputHash(inputs), resultHash: '0000000000000000', stale: false, forOtherDataset: false,
    isip: { value: run.isip.value, spread: run.isip.spread, label: run.isip.confidence },
    closure: { mode: 'single', value: run.consensus.value, lo: null, hi: null, label: run.consensus.confidence, families: { F1: { p50: run.consensus.families.F1.p50 }, F2: { p50: run.consensus.families.F2.p50 }, F4: null } },
    pn: c.pn, eta: c.eta.a05, CL: c.geometry.byModel.PKN.CL, Gamma: c.Gamma, xf: c.geometry.byModel.PKN.xf, R: null, model: 'PKN',
    pi: { value: aca.pi.value, lo: aca.pi.lo, hi: aca.pi.hi, label: aca.pi.label }, khmu: null, k: aca.nolte.lin.k, kLo: aca.bounds.kLo, kHi: aca.bounds.kHi,
    triage: run.triage.light, grade: run.grade.letter, unc: { seed: run.unc.seed, n: run.unc.n }, gdpdgN: { x: gx, y: gy },
  };
  s.resultHash = resultHash(s);
  return s;
}
const fmt0 = (x) => Math.round(x).toLocaleString('en-US');
function genReport(run) {
  const s = run.summary, c = run.frac.chosen, pm = Math.round((s.pi.hi - s.pi.lo) / 2);
  const keyLine = 'DFIT · closure ' + fmt0(s.closure.value) + ' psia (single, ' + s.closure.label + ') · p_i ' + fmt0(s.pi.value) + ' ±' + pm + ' psia';
  const u = run.unc.outputs;
  return {
    title: 'DFIT analysis — Zone A',
    keyRows: [['Closure', fmt0(s.closure.value) + ' psia (single, ' + s.closure.label + ', uncalibrated)'], ['ISIP', fmt0(s.isip.value) + ' psia'],
              ['Net pressure', fmt0(s.pn) + ' psi'], ['p_i', fmt0(s.pi.value) + ' psia (' + s.pi.label + ')'], ['Grade', run.grade.letter]],
    keyLine, grade: run.grade,
    sections: [
      { id: 'dfit-headline', title: 'DFIT headline', order: 10, blocks: [
        { kind: 'kv', rows: [['Closure', fmt0(s.closure.value) + ' psia', ['C1']], ['ISIP', fmt0(s.isip.value) + ' psia', ['I1']], ['Net pressure', fmt0(s.pn) + ' psi', ['F1']],
                             ['Efficiency (α = ½)', c.eta.a05.toFixed(3), ['F1']], ['p_i', fmt0(s.pi.value) + ' psia', ['A1']]] },
        { kind: 'table', head: ['Output', 'P10', 'P50', 'P90', 'Unit', 'Ev.'], ev: true, rows: [
          ['Closure', u.closure.p10, u.closure.p50, u.closure.p90, 'psia', 'C1'], ['Net pressure', u.pn.p10, u.pn.p50, u.pn.p90, 'psi', 'F1'], ['xf (PKN)', u.xf.p10, u.xf.p50, u.xf.p90, 'ft', 'F1']] },
        { kind: 'verdict', level: 'ok', text: '✓ Closure 7,000 psia (single, high, uncalibrated): the compliance and tangent readings agree within 21 psi.' },
      ] },
      { id: 'dfit-board', title: 'Closure board', order: 11, blocks: [
        { kind: 'table', head: ['Method', 'Family', 'Vote', 'Closure (psia)', 'Ev.'], ev: true, rows: run.picks.map((p) => [p.method, p.family, p.vote ? 'yes' : 'no', p.p, p.ev[0]]) },
        { kind: 'plot', key: 'dfitG', title: 'G-function plot' }, { kind: 'plot', key: 'dfitStrip', title: 'Closure strip' },
      ] },
      { id: 'dfit-aca', title: 'After-closure analysis', order: 13, blocks: [
        { kind: 'kv', rows: [['Regime', 'linear', ['A1']], ['p_i', fmt0(run.aca.pi.value) + ' psia (' + run.aca.pi.label + ')', ['A1']], ['k (F_L line)', String(run.aca.nolte.lin.k) + ' md', ['A1']]] },
        { kind: 'notes', text: 'Radial flow is not reached; k is bounded from both sides.' },
      ] },
      { id: 'dfit-log', title: 'Pick log and evidence', order: 20, blocks: [{ kind: 'notes', text: 'No user picks or overrides.' }] },
    ],
    appendix: run.evidence, quoted: { ok: true, nFailed: 0 },
  };
}

// ── FIX.state ──
function genState(run, ds, refIn) {
  const at = REF.at;
  const t1 = {
    id: 't1', zone: 'Zone A',
    dsRef: { kind: 'demo', id: 'reference', name: ds.name, hash: dsHash(ds), n: ds.t.length },
    inputs: refIn,
    picks: { isip: { value: run.isip.value, method: 'consensus', source: 'auto', reason: '', at },
             closure: { mode: 'consensus', family: null, method: 'consensus', p: run.consensus.value, dt: run.frac.chosen.dtc, source: 'auto', reason: '', at },
             user: {}, aca: { origin: 'centroid', linWin: null, radWin: null, piLevel: null } },
    summary: run.summary, lk: null, hf: null, log: [],
  };
  // t2: the toy contact case of §4.7 / §6.2 C1 one zone deeper (closure range, medians 6,507 / 6,998)
  const in2 = refIn ? JSON.parse(JSON.stringify(refIn)) : refInputs();
  in2.datumTvd = 10400; in2.datumMd = 10400; in2.options.familyWeightF1 = 0.6;
  in2.strings = [{ tubKey: null, id: REF.idIn, od: REF.odIn, wall: REF.wallIn, topMd: 0, botMd: 10400 }];
  const gx = [], gy = [];
  for (let i = 0; i < 50; i++) { const x = 0.05 + i * 0.03; gx.push(fx(x, 3)); gy.push(fx(x < 0.62 ? 1 : x < 1 ? 1 + 0.45 * Math.sin((x - 0.62) / 0.38 * Math.PI / 2) : 1.45 * Math.exp(-(x - 1) * 3), 4)); }
  const lkCfg = sampleLkConfig();
  const sum2 = {
    at, dsHash: 'a3f09c41d27b5e18', inputHash: inputHash(in2), resultHash: '0000000000000000', stale: false, forOtherDataset: false,
    isip: { value: 7600.0, spread: 6.0, label: 'high' },
    closure: { mode: 'range', value: null, lo: 6495.0, hi: 7004.0, label: 'medium', families: { F1: { p50: 6998.0 }, F2: { p50: 6507.0 }, F4: null } },
    pn: 602.0, eta: 0.9, CL: 1.91e-4, Gamma: 9.49, xf: 131.0, R: null, model: 'PKN',
    pi: { value: 4498.0, lo: 4470.0, hi: 4530.0, label: 'low' }, khmu: null, k: null, kLo: 2.0e-4, kHi: 0.05,
    triage: 'amber', grade: 'B', unc: { seed: 1, n: 1000 }, gdpdgN: { x: gx, y: gy },
  };
  sum2.resultHash = resultHash(sum2);
  const t2 = {
    id: 't2', zone: 'Zone B',
    dsRef: { kind: 'data-tab', id: null, name: 'Zone B DFIT', hash: 'a3f09c41d27b5e18', n: 1450 },
    inputs: in2,
    picks: {
      isip: { value: 7600.0, method: 'consensus', source: 'auto', reason: '', at },
      closure: { mode: 'family', family: 'F1', method: 'compliance', p: 6998.0, dt: 5.0849, source: 'user',
                 reason: 'Hand-offs use the contact (F1) reading: the core shows asperity-supported natural fractures.', at: '2026-11-07T10:20:00Z' },
      user: { dfitTangent: { G: 25.0, dt: 8.21, p: 6507.0, value: 6507.0, at: '2026-11-07T10:12:00Z' } },
      aca: { origin: 'centroid', linWin: [6.0, 40.0], radWin: null, piLevel: null },
    },
    summary: sum2,
    lk: { cfg: lkCfg, preset: 'falloff', fit: { params: { k: 2.6e-3, sigmaC: 6990, pr: 4498 }, ci95: { k: [1.9e-3, 3.4e-3], sigmaC: [6960, 7020], pr: [4470, 4526] },
          ci95Inflated: { k: [1.4e-3, 4.6e-3], sigmaC: [6930, 7050], pr: [4450, 4546] }, groups: { Gamma: 9.47, GammaPKN: 15.1 }, chi2: 41.2, at: '2026-11-07T10:30:00Z' }, gridN: 1840 },
    hf: { key: 'dfit-hf:a3f09c41d27b5e18', kinds: ['shutin'], bytes: 96000, store: 'idb' },
    log: [
      { seq: 1, at: '2026-11-07T10:05:00Z', who: 'A. Analyst', item: 'options.familyWeightF1', old: 0.5, new: 0.6, reason: 'Interpretive weight towards the contact reading (core description).' },
      { seq: 2, at: '2026-11-07T10:12:00Z', who: 'A. Analyst', item: 'pick.dfitTangent', old: null, new: 6507.0, reason: 'Tangent drawn by hand on the G plot.' },
      { seq: 3, at: '2026-11-07T10:20:00Z', who: 'A. Analyst', item: 'closure.family', old: null, new: 'F1', reason: 'Hand-offs use the contact (F1) reading: the core shows asperity-supported natural fractures.' },
    ],
  };
  return { v: 2, active: 't1', tests: [t1, t2], plan: null, live: null };
}

// ── FIX.samples ──
function sampleLkConfig() {
  return {
    mode: 'propagate', geometry: 'PKN', schedule: [{ t: 0, q: 5 }, { t: fx(REF.tp, 9), q: 0 }],
    Ep: REF.Ep, nu: 0.25, hf: REF.hf, hp: REF.hp, muCp: 1.0, KIc: 14000, viscCal: 1, Cw: 0, k: 2.75e-3, Sp: 0,
    pdl: { Cd: 0, pfo: null, fmax: 50 }, sigmaC: 7000, pr: 4500, VwCw: sf(REF.VwCw, 4), nwb: { a: 1.505, b: 140.9, beta: 0.5 }, pBd: null, L0: 1,
    aperture: { law: 'none', sh: 60, sc: 100, fres: 0.1, sr: null }, tip: { tauX: null }, farField: false,
    tEnd: 72, phi: REF.phi, ct: REF.ct, muRes: REF.mu, CL: null, wc: null,
  };
}
function genSamples(run) {
  const R = REF, twoLc = 2 * R.datumTvd / R.c, T = 2 * twoLc, dv = R.q * BBL / 60 / R.area, jouk = R.rho * R.c * dv / 144;
  const t = [0, 0.02, 0.05, R.tp, R.tp + 0.5, R.tp + 5.08];
  const lkRes = {
    ok: true, why: null, t, pw: [4500, 7900, 7930, 7953, 7583, 7000], pf: [4500, 7595, 7598, 7600, 7583, 7000], L: [1, 60, 95, 131, 131, 131], A: [80, 6000, 9500, 13121, 13121, 13121],
    AL: [80, 6000, 9500, 13121, 13121, 13121], W: [0, 0.09, 0.105, 0.113, 0.11, 0.0], Vf: [0, 5.2, 10.1, 22.0, 20.5, 0.0], Vi: [0, 6, 15, 25, 25, 25], VL: [0, 0.6, 1.2, 2.5, 4.0, 22.5],
    VLw: [0, 0, 0, 0, 0, 0], VLc: [0, 0.6, 1.2, 2.5, 4.0, 22.5], VS: [0, 0, 0, 0, 0, 0], qL: [0, 0.4, 0.45, 0.5, 0.3, 0.0405], eta: [null, 0.9, 0.9, 0.9, null, null],
    Bw: [0, 0.2, 0.4, 0.6, 0.6, 0.6], Ggen: [null, null, null, 0, 1.2, 18.0],
    events: { tb: 0.0097, pb: 8188.4, ts: fx(R.tp, 9), isip: 7600, tcMech: fx(R.tcInj, 4), tcHyd: fx(R.tcInj, 4), Gc: { a05: 18.0, a1: 18.276, gen: 18.1 } }, xf: { ts: 131.2, tc: 131.2 },
    CLeq: 1.903e-4, dpCL: 2800, wcEq: 0, tDxfMax: 0.02, balanceErr: 1e-9, regime: { tipShare: 0.05 }, validity: [], warnings: [],
  };
  return {
    StepDown: { ok: true, pFrac: 7595.5, se: { pFrac: 3.0, a: 0.05, b: 4.0 }, a: 1.505, b: 140.9, beta: 0.5, drift: 0, nOpen: 11.9,
                nOpenBand: { p10: 8.9, p50: 11.7, p90: 16.0, driver: 'perforation discharge coefficient' }, at: { dpPerf: 37.6, dpNwb: 315.0, dpPipe: null },
                label: 'high', refused: null, resid: [0.4, -0.3, 0.1, -0.2], corr: { ab: -0.62 } },
    StepRate: { ok: true, qStar: 3.2, fep: 7480.0, band: { p10: 2.9, p50: 3.2, p90: 3.5 }, b1: 410.0, b2: 52.0, fTest: { F: 38.4, p: 0.001 }, breakFound: true,
                steps: [{ q: 0.5, pEnd: 5060, dpdt: 0.2, stabilised: true }, { q: 1.5, pEnd: 5880, dpdt: 0.3, stabilised: true }, { q: 2.5, pEnd: 6700, dpdt: 0.4, stabilised: true },
                        { q: 3.5, pEnd: 7495, dpdt: 0.6, stabilised: true }, { q: 4.5, pEnd: 7547, dpdt: 0.5, stabilised: true }], why: null },
    Ramp: { ok: true, kind: 'pre-breakdown', VwCwRamp: sf(R.VwCw, 4), knee: null, band: null, slopes: { s1: fx(1 / R.VwCw, 1), s2: null }, stiffRatio: null, nwbCorr: null, label: 'high', why: null },
    Hammer: { ok: true, why: null, c: R.c, cSource: 'korteweg', T: fx(T, 3), tau: 6.5, delta: 0.11, A: 115.0, phi: 0.0, isip: 7605.0, regime: 'ringing',
              Lquarter: fx(R.c * T / 4, 0), Lhalf: fx(R.c * T / 2, 0), reflectorMatch: 'perfs', gammaDecay: 0.15,
              joukowsky: { expected: fx(jouk, 1), measured: 228.0, ratio: fx(228 / jouk, 3) }, VwCwHammer: sf(R.VwCw, 4), tEnd: fx(R.ts + 60 / 3600, 6),
              sampling: { hz: 50, per2Lc: fx(50 * twoLc, 1), ok: true } },
    LkConfig: sampleLkConfig(),
    LkResult: lkRes,
    LkFit: { ok: true, preset: 'falloff', params: { k: 2.75e-3, sigmaC: 7000, pr: 4500 }, ci95: { k: [2.4e-3, 3.1e-3], sigmaC: [6994, 7006], pr: [4497, 4503] },
             ci95Inflated: { k: [2.0e-3, 3.7e-3], sigmaC: [6985, 7015], pr: [4490, 4510] }, corr: { k_sigmaC: 0.31 }, nEff: 120, rho1: 0.4,
             structural: { sigmaC: [6990, 7010], pr: [4495, 4505], k: [2.3e-3, 3.3e-3], CLeq: [1.8e-4, 2.0e-4] },
             groups: { Gamma: 9.49, GammaPKN: 15.2, text: 'The falloff fixes the group Gamma; E′, the fracture height and CL are not separately identifiable.' },
             sloppy: [{ vec: { Ep: 0.7, hf: -0.7 }, text: 'E′ and the fracture height trade off along this direction.' }], starts: { n: 8, converged: 8 }, runs: 412, chi2: 38.1, rmse: 0.42, stopReason: 'converged', warnings: [] },
    Identify: { rows: [{ param: 'sigmaC', status: 'determined', pm: 6.0, text: 'Closure stress is determined to ±6 psi.' }, { param: 'Gamma', status: 'group', pm: 0.1, text: 'Only the group Gamma is determined.' },
                       { param: 'Ep', status: 'not', pm: null, text: 'E′ is not determined by this test.' }],
                sloppyText: 'E′ and the fracture height correlate at 0.997.', voi: [{ source: 'core E′', reduction: 0.6, text: 'A static E′ from core narrows xf by 60 %.' }],
                extend: [{ tEndD: 3, sdPi: 12, kRange: [2e-4, 0.04], pRadial: 0.02 }, { tEndD: 10, sdPi: 6, kRange: [3e-4, 0.01], pRadial: 0.1 }] },
    DesignRanges: { k: { p10: 1e-4, p90: 1e-2 }, phi: { p10: 0.04, p90: 0.08 }, ct: { p10: 8e-6, p90: 1.5e-5 }, muRes: { p10: 0.3, p90: 0.8 }, h: { p10: 30, p90: 60 },
                    hf: { p10: 40, p90: 80 }, hp: 40, Ep: { p50: 5e6, sdLn: 0.25 }, nu: 0.25, sigmaGrad: { p50: 0.7, sd: 0.02 }, piGrad: { p50: 0.45, sd: 0.02 }, datumTvd: 10000,
                    strings: [{ tubKey: null, id: REF.idIn, od: REF.odIn, wall: REF.wallIn, topMd: 0, botMd: 10000 }], fluid: { kind: 'slickwater', rhoPpg: 8.43, muCp: 1 },
                    gauge: { kind: 'bh', sigma: 0.05, resolution: 0.01, hz: 1, driftPsiPerDay: 0.1 }, V: null, q: null, suggest: true, allowedShutInD: 10, targetW: null,
                    repressurise: false, epsMax: 0.05, leakEps: 0.05 },
    Design: { ok: true, n: 500, seed: 1, outcome: { label: 'linear', text: 'Closure and after-closure linear flow are expected within 10 days; radial flow is unlikely.' },
              tc: { p10: 2.1, p50: 5.1, p90: 14.0 }, shutIn: { p10: 48, p50: 96, p90: 240, binding: '3tc' }, tRadial: { p10: 300, p50: 1700, p90: 9000 }, signalPsi: { p10: 40, p50: 120, p90: 300 },
              Vmin: 12, Rvis: { p50: 0.95 }, vacuum: { risk: 'none', text: 'The column stays liquid-supported at the expected p_i.' },
              gauge: { bhRequired: false, why: ['Surface gauge adequate: the column stays liquid-filled.'], hz: 1, resolutionPsi: 0.01, driftPsiPerDay: 0.1 },
              leak: { qkMax: 0.05, theta: 0.2, holdMin: 15, dTneeded: 0.5 }, stepDown: { rates: [5, 3.5, 2, 1] }, repressurise: null,
              precision: [{ tEndD: 3, sdPi: 12 }, { tEndD: 10, sdPi: 6 }], checklist: [{ id: 'P1', text: 'Pump 25 bbl at 5 bbl/min with a four-step step-down.' }],
              corridor: { t: [0.1, 1, 5, 24], p10: [7480, 7300, 6950, 5600], p50: [7530, 7380, 7010, 5700], p90: [7570, 7450, 7080, 5800] }, warnings: [] },
    LiveVerdict: { t: 3.2, state: 'provisional', family: 'F1', p: 7004.0, forecast: { lo: 4.8, hi: 5.6 }, text: 'Provisional closure near 7,004 psia (compliance); confirmation expected in 1.6 to 2.4 h.', ev: ['C2'] },
    HandoffPacket: { target: 'pta', family: null, setWell: { testType: 'falloff', tShut: fx(R.ts, 9), tp: fx(R.tp, 9), pwf0: run.isip.value, pi: run.aca.pi.value },
                     multiRate: [{ t: fx(R.ts - R.tp, 9), q: 7200 }, { t: fx(R.ts, 9), q: 0 }], qEq: 5, model: 'infiniteFrac',
                     seeds: { xf: run.frac.chosen.geometry.byModel.PKN.xf, k: run.aca.nolte.lin.k, pi: run.aca.pi.value },
                     notes: ['After-closure linear flow seen: infinite-conductivity fracture model seeded with xf and k.'], blockers: [] },
    CaseSpec: { id: 'reference', source: 'gdomain', mechanism: 'normal', lk: null, aca: null, wellbore: { VwCw: sf(R.VwCw, 4), cwOfP: null },
                noise: { sigma: 0, rho1: 0, quantum: 0.01 }, sampling: { dtS: 2.5 }, tEndFactor: 14, artefacts: [], tags: ['reference', 'fixture'] },
    Failure: { ok: false, code: 'NOT_IMPLEMENTED', errors: ['PRiSM_dfit_prepare is not implemented yet (WP0 skeleton).'], bad: [] },
  };
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
  const ds = genDs();
  const { run, inputs } = genRun(ds);
  _fix = { ds, run, state: genState(run, ds, inputs), aca: genAcaB(), samples: genSamples(run), ref: Object.assign({}, REF) };
  deepFreeze(_fix);
  return _fix;
}
const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const FIX = {};
['ds', 'state', 'run', 'aca', 'samples'].forEach((k) => Object.defineProperty(FIX, k, { enumerable: true, get: () => clone(buildFix()[k]) }));
Object.defineProperty(FIX, 'ref', { enumerable: true, get: () => ({ REF: clone(buildFix().ref), chain: (pc, o) => stripRaw(chain(pc, o)), pFall, dpdtFall, dtAtP, frictional }) });

// ═════════════════════════════════════════════════════════════════════════════
// 7. Shared app per test file (§3.13) and the DFIT reset
// ═════════════════════════════════════════════════════════════════════════════
let _shared = null;   // { key, app }
function callerFile() {
  const st = String(new Error().stack || '').split('\n');
  for (const ln of st) {
    const m = /\(?([^()\s]+\.test\.js):\d+:\d+\)?/.exec(ln);
    if (m) return path.basename(m[1]);
  }
  return '(unknown)';
}
function sharedApp(ctx, opts) {
  if (!ctx || typeof ctx.loadApp !== 'function') throw new Error('_dfit-shapes.sharedApp: needs the accept-test ctx (ctx.loadApp)');
  const key = callerFile() + '|' + ctx.mode + '|' + hash16(canon(opts || null, 'inputs')) + '|' + (opts && opts.sourceOverrides ? hash16(Object.keys(opts.sourceOverrides).map((k) => k + ':' + opts.sourceOverrides[k]).join('\n')) : '');
  if (_shared && _shared.key === key) return _shared.app;
  if (_shared && _shared.app && typeof _shared.app.dispose === 'function') { try { _shared.app.dispose(); } catch (_) { /* ignore */ } }
  _shared = { key, app: ctx.loadApp(opts || {}) };
  return _shared.app;
}
// resetDfit: (1) with manual timers, runs the pending debounced C8 save first (33 saves 300 ms after a C7 event; flush(400)
// advances the virtual clock by 400 ms) so it cannot write st.dfit back afterwards; (2) deletes st.dfit, st._dfitRun and
// st._dfitWhatIf; (3) removes every 'wts_prism_dfit*' key; (4) removes the dfit field from the persisted wts_prism_state
// (once WPH adds 'dfit' to STATE_FIELDS a reload would otherwise bring the previous test's st.dfit back).
function resetDfit(app) {
  const g = app && (app.win || app.window);
  if (!g) return;
  if (app.timersMode === 'manual' && typeof app.flush === 'function') { try { app.flush(400); } catch (_) { /* ignore */ } }
  const st = g.PRiSM_state;
  if (st && typeof st === 'object') { delete st.dfit; delete st._dfitRun; delete st._dfitWhatIf; }
  const s = app.storage;
  if (s && typeof s.length === 'number' && typeof s.key === 'function') {
    const keys = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && /^wts_prism_dfit/.test(k)) keys.push(k); }
    keys.forEach((k) => s.removeItem(k));
    let raw = null;
    try { raw = s.getItem('wts_prism_state'); } catch (_) { raw = null; }
    if (raw) {
      let o = null;
      try { o = JSON.parse(raw); } catch (_) { o = null; }
      if (isObj(o) && Object.prototype.hasOwnProperty.call(o, 'dfit')) { delete o.dfit; s.setItem('wts_prism_state', JSON.stringify(o)); }
    }
  }
}

module.exports = {
  checkShape, SHAPE_NAMES, SHAPES: Object.keys(SHAPES), RANGES, ENUMS, defaultInputs, clampInputs, clampValue, FIX, sharedApp, resetDfit,
  dsHash, inputHash, picksHash, resultHash, rng, G: Gx, autoInterp,
};
