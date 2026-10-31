// =============================================================================
// PRiSM — 53-prism-autointerp.js  (Round 8)
// -----------------------------------------------------------------------------
// Automatic build-up interpretation engine, window.PRiSM_autoInterp. Shared by
// the Build-up Surveillance page (Round 9) and the PRiSM Skin-check card.
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §3.1 (interfaces) and §4.6.
//
// WP0: version, canon(obj, mode), hash16(str).
//   canon and hash16 are FROZEN from WP0 on. Every stored hash (inputs,
//   results and decisions hashes, the per-test inputHash, the audit chain)
//   depends on them bit for bit, so any change would mark every signed report
//   "changed after sign-off". WP1 left these two functions untouched.
// WP1: the rest of §3.1 — bin, derivative, prepare, storage, iarf, line,
//   gridEntry, fitJob / fit (sliced PRiSM_fitPhysical), reach, predictors,
//   triggers / flags, bic, fullySeen, agreement, cHeldJob, sErr, sensitivity,
//   confidence, rinv, compactHistory, gasTable, pStarRange, pExt, kHeldJob,
//   backgroundCheck, interpretJob / interpret, drive, stats; kernels
//   (closed circle, two-zone composite, scaled Bessel functions); and
//   PRiSM_MODELS.closedCircle (§3.3).
//
// canon(obj, mode) → canonical JSON string. These rules are normative: plan
// §3.1 "WP0 resolutions" and §8.4 point here, and the code below implements
// exactly this list (DISPLAY_RULES holds the full key-name table).
//   • Object keys sorted (UTF-16 code-unit order), no whitespace.
//   • NaN, +Infinity, −Infinity → null; −0 → 0; |v| < 1e-12 → 0 in both modes,
//     so a value that is 0 on one engine and 2e-16 on another hashes the same.
//   • undefined, functions and symbols are dropped from objects and become
//     null inside arrays (as JSON does). Typed arrays serialise as arrays,
//     Dates as their ISO string (null when invalid). A repeated reference to
//     an object that is still being serialised (a cycle) becomes null.
//   • mode 'inputs' (also the default for a missing or unknown mode): every
//     number to 6 significant figures, except epoch milliseconds (keys that
//     end in "_ms"), which are rounded to whole seconds — 6 significant
//     figures of an epoch-ms value would lose hours. The rule goes by the key
//     name only, so it also rounds a millisecond DURATION whose key ends in
//     "_ms" (e.g. store.encode tScale_ms) to whole seconds, in both modes:
//     name sub-second durations in another unit (_s, _h) or keep them out of
//     hashed objects.
//   • mode 'display': each number is rounded to its display precision
//     (plan §8.4), chosen from the property name (first rule that matches):
//       epoch      key ends "_ms"                      → whole seconds
//       count      n, nEval, iterations, seed, …       → kept when an integer
//       percent    key contains "Pct"                  → 1 dp
//       ΔBIC       bic, dBic, dBicHom, …               → 1 dp
//       skin       S, dS, Serr, S_err, sErr, sWin, …   → 2 dp
//       k          k, kh, kStar, kBase, …              → 3 significant figures
//       C          C, C_us, Cd, CD                     → 3 significant figures
//       pressure   p*, pwf0, p_ext, dp, m, "_psi(a)"   → 1 dp (*)
//       rate       q, Dq, rateAtStake, V, …            → 1 dp (*)
//       time       key ends "_h", dt, dte, t, …Days    → 3 dp (*)
//       seconds    key ends "_s"                       → 0 dp (*)
//       distance   key ends "_ft", rw                  → 0 dp (*)
//       inherit    v, value, lo, hi, min, max, …       → the parent key's rule
//       other                                          → 4 significant figures
//     (*) or 3 significant figures when that is finer, so small values such
//     as noise in psi, a 0.0028 h first bin or rw = 0.354 ft keep 3 figures.
//     Array elements take the rule of the array's key; numeric keys
//     ('0.5', '2', …) inherit like v/value.
//   • Rounding uses Number.prototype.toPrecision / toFixed / toExponential,
//     which the language defines exactly, so the string is the same on every
//     JS engine for the same input numbers.
//   • GaugeRecord.t (raw epoch-ms samples under the key "t") is not meant to
//     go through canon: the record hash is computed from the record itself.
//
// hash16(str) → 16 lowercase hex characters
//   Two 32-bit FNV-1a passes over the UTF-16 code units of the string (each
//   code unit XORed in whole, then multiplied by the FNV prime 16777619 with
//   Math.imul), with offset bases 0x811c9dc5 and 0x050c5d1f, each written as
//   8 hex digits and concatenated. For an ASCII string the first half equals
//   the standard 32-bit FNV-1a of its bytes. null/undefined hash as ''.
//
// Load rules (smoke stub): no document, no timers, no other PRiSM symbol is
// needed at load time. The namespace object is merged, never replaced.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    // Builtins bound once to closure variables: inside an embedding sandbox (the acceptance
    // harness runs the app in a vm context) every global lookup is an intercepted call, many
    // times slower than a closure read. They are the same objects, so the numbers are too.
    var Math = G.Math, isFinite = G.isFinite, Infinity = G.Infinity, NaN = G.NaN, Array = G.Array, Object = G.Object,
        String = G.String, Number = G.Number, JSON = G.JSON, Map = G.Map, Float64Array = G.Float64Array, parseFloat = G.parseFloat;
    var AI = G.PRiSM_autoInterp = G.PRiSM_autoInterp || {};

    // ─────────────────────────────────────────────────────────────────────
    // canon — canonical JSON (FROZEN after WP0)
    // ─────────────────────────────────────────────────────────────────────
    var SF_INPUTS = 6;
    var SF_FALLBACK = 4;
    var ZERO_FLOOR = 1e-12;     // |v| below this serialises as 0 in both modes

    // Display-precision rules, first match wins. r: rounding kind
    //   'epoch' whole seconds · 'count' integer kept · 'dp' fixed decimals ·
    //   'dp3' fixed decimals or 3 significant figures when finer · 'sf' significant figures.
    var DISPLAY_RULES = [
        { cat: 'epoch',    r: 'epoch', re: /_ms$/ },
        { cat: 'count',    r: 'count', re: /^(n|nDp|nKept|nLumped|nEval|nChecked|nFailed|nCases|nBuildups|nTests|nUsed|iterations|slices|evals|fits|lmIters|gridBuilds|lines|seq|seed|row|j0|j1|gapCount|decisions|open|from|to|idx|count|startHour|master)$/ },
        { cat: 'percent',  r: 'dp', n: 1, re: /Pct($|[A-Z_0-9])/ },
        { cat: 'bic',      r: 'dp', n: 1, re: /^d?(bic|Bic|BIC)($|[A-Z_0-9])/ },
        { cat: 'skin',     r: 'dp', n: 2, re: /^(S|dS|bS|S0|Sd|Sprime|Smech|SmechErr|Serr|SerrExt|Sgeo|SgeoRange|Sbase|seS|biasDS|dLineMatch|medAbsDS|disagreeDS|fittedDS|pointSkin|pointSkinSpread|floor|sErr|sWin|sTc|sPwf|sK|sC|sSens|sAbs|sLine|sMatch|sErrFloor|sErrHigh|sErrLow|sErrMax)$|^S_|^S[A-Z]/ },
        { cat: 'perm',     r: 'sf', n: 3, re: /^(k|kh|kStar|kBase|k_base|khBase|kLine|kMatch|kMed|kMedian)$/ },
        { cat: 'storage',  r: 'sf', n: 3, re: /^(C|C_us|Cd|CD)$/ },
        { cat: 'pressure', r: 'dp3', n: 1, re: /_psia?$|^(p|pi|pbar|Pb|patm|pmax|pdew|p1hr|pRef|dp|dpdt|dpdt_flow|deriv|m|mPrime)$|^pwf|^pStar|^pExt|^piModel/ },
        { cat: 'rate',     r: 'dp3', n: 1, re: /^(q|Dq|qBefore|qAfter|qNow|qRef|qFlow|qCorrect|rateAtStake|cumAtStake|V|oil|gas|water)$/ },
        { cat: 'time',     r: 'dp3', n: 3, re: /_h$|^(dt|dte|t|days)$|Days$/ },
        { cat: 'seconds',  r: 'dp3', n: 0, re: /_s$/ },
        { cat: 'distance', r: 'dp3', n: 0, re: /_ft$|^rw$/ }
    ];
    var INHERIT_RE = /^(v|value|lo|hi|min|max|mean|median|spread|ext|range|byFactor|-?\d+(\.\d+)?)$/;
    var FALLBACK_RULE = { cat: 'other', r: 'sf', n: SF_FALLBACK };
    var ROOT_RULE = FALLBACK_RULE;

    function _ruleFor(key, parentRule) {
        if (INHERIT_RE.test(key)) return parentRule || ROOT_RULE;
        for (var i = 0; i < DISPLAY_RULES.length; i++) {
            if (DISPLAY_RULES[i].re.test(key)) return DISPLAY_RULES[i];
        }
        return FALLBACK_RULE;
    }

    function _clean(x) { return (x === 0) ? 0 : x; }   // −0 → 0

    function _sf(v, n) { return _clean(parseFloat(v.toPrecision(n))); }
    function _dp(v, n) { return _clean(parseFloat(v.toFixed(n))); }
    function _dp3(v, n) {
        if (v === 0) return 0;
        // Exponent of v written with 3 significant figures (exact per the language spec).
        var s = v.toExponential(2);
        var e = parseInt(s.slice(s.indexOf('e') + 1), 10);
        return (2 - e > n) ? _sf(v, 3) : _dp(v, n);
    }

    function _roundNum(v, mode, rule, key) {
        if (typeof v !== 'number' || !isFinite(v)) return null;
        if (Math.abs(v) < ZERO_FLOOR) return 0;   // last-bit residue (0 vs 2e-16) never reaches a hash
        var epochKey = /_ms$/.test(key || '');
        if (mode !== 'display') {
            if (epochKey) return _clean(Math.round(v / 1000) * 1000);
            return _sf(v, SF_INPUTS);
        }
        switch (rule.r) {
            case 'epoch': return _clean(Math.round(v / 1000) * 1000);
            case 'count': return (Math.floor(v) === v && Math.abs(v) <= 9007199254740991) ? _clean(v) : _sf(v, SF_FALLBACK);
            case 'dp':    return _dp(v, rule.n);
            case 'dp3':   return _dp3(v, rule.n);
            default:      return _sf(v, rule.n);
        }
    }

    // Tag checks (not instanceof) so objects made in another realm (iframe, vm context) behave the same.
    function _tag(x) { return Object.prototype.toString.call(x); }
    function _isTyped(x) {
        return (typeof ArrayBuffer !== 'undefined') && typeof ArrayBuffer.isView === 'function' &&
               ArrayBuffer.isView(x) && _tag(x) !== '[object DataView]';
    }

    function _ser(v, mode, rule, key, stack) {
        if (v === null || v === undefined) return 'null';
        var t = typeof v;
        if (t === 'number') {
            var r = _roundNum(v, mode, rule, key);
            return r === null ? 'null' : JSON.stringify(r);
        }
        if (t === 'boolean') return v ? 'true' : 'false';
        if (t === 'string') return JSON.stringify(v);
        if (t === 'bigint') return JSON.stringify(String(v));
        if (t === 'function' || t === 'symbol') return 'null';
        if (stack.indexOf(v) !== -1) return 'null';           // cycle
        if (_tag(v) === '[object Date]') return isFinite(v.getTime()) ? JSON.stringify(v.toISOString()) : 'null';
        var out, i;
        stack.push(v);
        if (Array.isArray(v) || _isTyped(v)) {
            out = [];
            for (i = 0; i < v.length; i++) out.push(_ser(v[i], mode, rule, key, stack));
            stack.pop();
            return '[' + out.join(',') + ']';
        }
        var keys = Object.keys(v).sort();
        out = [];
        for (i = 0; i < keys.length; i++) {
            var k = keys[i], val = v[k], vt = typeof val;
            if (val === undefined || vt === 'function' || vt === 'symbol') continue;
            out.push(JSON.stringify(k) + ':' + _ser(val, mode, _ruleFor(k, rule), k, stack));
        }
        stack.pop();
        return '{' + out.join(',') + '}';
    }

    function canon(obj, mode) {
        var m = (mode === 'display') ? 'display' : 'inputs';
        return _ser(obj, m, ROOT_RULE, '', []);
    }

    // ─────────────────────────────────────────────────────────────────────
    // hash16 — two 32-bit FNV-1a passes (FROZEN after WP0)
    // ─────────────────────────────────────────────────────────────────────
    var FNV_PRIME = 16777619;     // 0x01000193
    var FNV_BASE_A = 0x811c9dc5;
    var FNV_BASE_B = 0x050c5d1f;

    function _fnv(s, basis) {
        var h = basis | 0;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, FNV_PRIME);
        }
        return h >>> 0;
    }
    function _hex8(x) { return ('0000000' + (x >>> 0).toString(16)).slice(-8); }

    function hash16(str) {
        var s = (str === null || str === undefined) ? '' : String(str);
        return _hex8(_fnv(s, FNV_BASE_A)) + _hex8(_fnv(s, FNV_BASE_B));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Public surface (WP0). WP1 adds the rest of §3.1 to this object.
    // ─────────────────────────────────────────────────────────────────────
    AI.version = '1.0';
    AI.canon = canon;
    AI.hash16 = hash16;

    // =====================================================================
    // WP1 — AUTOMATIC BUILD-UP INTERPRETATION ENGINE (plan §3.1–§3.3, §4.6)
    // =====================================================================
    // Pure engine: no DOM, no storage, no events, no random numbers. The only
    // timer user is drive() (a terminating chain of one-shot setTimeout(0)).
    // Every cross-file PRiSM function is looked up at CALL time.
    //
    // Conventions (plan "Conventions" and §3.0)
    //   • Field units: psia, hours, STB/d | Mscf/d | bbl/d, md, ft, cp, 1/psi, bbl/psi.
    //   • Spans, cycles and windows are in log10 Δt_e (iarf.X0/X1, shifts[].dX);
    //     bins.X and the Bourdet distance L are ln Δt_e (D6).
    //   • "Slope" of the derivative is its log-log slope d ln Δp′/d ln Δt_e
    //     (base-independent, the quantity the half / quarter / unit slope
    //     flags use). The OLS slope of Δp′/ℓ is regressed on ln Δt_e.
    //   • Threshold decisions compare inputs rounded per DEFAULTS.round (D27).

    var LN10 = Math.LN10, LN2 = Math.LN2;
    var EULER = 0.5772156649015329;
    var C_A = 141.2, C_B = 0.0002637, C_CD = 0.8936, C_M = 162.6, C_PLAT = 70.6;

    function _deepFreeze(o) {
        if (o && typeof o === 'object' && !Object.isFrozen(o)) {
            Object.freeze(o);
            Object.keys(o).forEach(function (k) { _deepFreeze(o[k]); });
        }
        return o;
    }

    var DEFAULTS = _deepFreeze({
        Lcyc: 0.1, binsPerCycle: 20, fitBinsPerCycle: 12,
        iarf: { band: 0.10, slope: 0.03, bandCap: 0.20, slopeCap: 0.06, minCycles: 0.5, goodCycles: 1.0, goodSlope: 0.01, goodSE: 0.01,
                valleyDepth: 0.15, mergeLevel: 0.05, mergeGap: 0.2 },
        reach: { fairCycles: 0.5, goodCycles: 1.0 },
        trig: { late: 0.15, lateCycles: 0.2, level: [0.8, 1.25] },
        bic: { tau: 10, perCycle: 12, logFloor: 0.005 },
        agree: { kPct: 5, dS: 0.5, biasKPct: 3, biasDS: 0.3 },
        cheld: { f: [0.8, 1.25], ext: [0.64, 0.5, 1.56, 2.0], reject: 10 },
        sErr: { floor: 0.2, winShift: 0.25, winShiftFrac: 0.2 },
        kHeld: { spanMax: 0.6, corrMax: 0.95, rmsK: 3, sErrMax: 1.0 },
        pwf: { trendMin_min: 30, trendSamplesMin: 10, trendDtFactor: 10 },
        seen: { fault: 1.8, faultCycles: 0.15, compCycles: 0.3, closed: 0.5, closedSlope: -0.5, faultDepart: 0.15 },
        history: { maxDerivPct: 2, pStarFactors: [0.5, 2, 10] },
        tide: { m2Min_h: 24, k1Min_h: 48, index: 0.10 },
        budget: { unitMs: 50, perDecade: 10, maxIterTotal: 40, evalsMax: 24,
                  costMs: { homogeneous: { pos: 4, neg: 8 }, closedCircle: { pos: 1.5, neg: 3 }, composite2: { pos: 3, neg: 6 }, linearBoundary: { pos: 9, neg: 18 } } },
        rivals: { composite: { freezeF: true, M: [0.05, 20] }, closedStarts: [0.7, 1.0, 1.4] },
        round: { dBic: 0.1, span: 0.01, slope: 0.001, ratio: 0.001 },
        // Confidence thresholds (§5.1; '*' rules, replaced by PRiSM_autoInterpCal.thresholds when calibrated)
        conf: { snrHigh: 20, snrLow: 5, sErrHigh: 0.5, sErrLow: 1.0, fairSpanHigh: 0.7, pointSkinSpread: 0.3, disagreeDS: 1.0,
                disagreeKPct: 15, reachFactor: 3.98, distractorRule: true, kHeldRmsK: 3, rateTolPct: 15, tauBic: 10, sErrFloor: 0.2,
                rDriftMax: 0.05, rTideMax: 0.10, r4TolPct: 15, r3LowPct: 25 }
    });

    // Calibration lookup at call time (placeholder file 55 or none → DEFAULTS).
    function _cal(cal) {
        if (cal !== undefined) return cal;
        var c = G.PRiSM_autoInterpCal;
        return (c && typeof c === 'object') ? c : null;
    }
    function _thr(cal) {
        var d = DEFAULTS.conf, out = {};
        Object.keys(d).forEach(function (k) { out[k] = d[k]; });
        var c = _cal(cal);
        if (c && c.calibrated && c.thresholds && typeof c.thresholds === 'object') {
            Object.keys(c.thresholds).forEach(function (k) {
                var v = c.thresholds[k];
                if (k === 'deltaForm') return;
                if ((typeof v === 'number' && isFinite(v)) || typeof v === 'boolean') out[k] = v;
            });
        }
        return out;
    }

    // ── stats (counters for tests; plan §4.8) ──
    var STATS = { evals: 0, gridBuilds: 0, fits: 0, lmIters: 0, slices: 0, lines: 0, cheldRefits: 0, cheldExt: 0, kernelEvals: 0, resvPoints: 0 };
    function stats() { var o = {}; Object.keys(STATS).forEach(function (k) { o[k] = STATS[k]; }); return o; }
    function resetStats() { Object.keys(STATS).forEach(function (k) { STATS[k] = 0; }); }

    // ── small numeric helpers ──
    function _num(v) { return typeof v === 'number' && isFinite(v); }
    function _pos(v) { return _num(v) && v > 0; }
    function _fin(v) { return _num(v) ? v : null; }
    function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function _median(a) {
        var s = [];
        for (var i = 0; i < a.length; i++) if (_num(a[i])) s.push(a[i]);
        if (!s.length) return NaN;
        s.sort(function (x, y) { return x - y; });
        var m = s.length >> 1;
        return (s.length % 2) ? s[m] : 0.5 * (s[m - 1] + s[m]);
    }
    function _mad(a) {
        var m = _median(a);
        if (!_num(m)) return NaN;
        return _median(a.map(function (v) { return _num(v) ? Math.abs(v - m) : NaN; }));
    }
    function _wmedian(vals, w) {
        var idx = [];
        for (var i = 0; i < vals.length; i++) idx.push(i);
        idx.sort(function (a, b) { return vals[a] - vals[b]; });
        var tot = 0;
        for (var j = 0; j < w.length; j++) tot += w[j];
        var acc = 0;
        for (var k = 0; k < idx.length; k++) {
            acc += w[idx[k]];
            if (acc > tot / 2) return vals[idx[k]];
            if (acc === tot / 2 && k + 1 < idx.length) return 0.5 * (vals[idx[k]] + vals[idx[k + 1]]);
        }
        return vals[idx[idx.length - 1]];
    }
    // Decision rounding (D27): fixed decimals through the language-defined toFixed.
    function _rdp(v, step) {
        if (!_num(v)) return v;
        var dp = Math.max(0, Math.round(-Math.log10(step)));
        var r = parseFloat(v.toFixed(dp));
        return r === 0 ? 0 : r;
    }
    function _rBic(v) { return _rdp(v, DEFAULTS.round.dBic); }
    function _rSpan(v) { return _rdp(v, DEFAULTS.round.span); }
    function _rSlope(v) { return _rdp(v, DEFAULTS.round.slope); }
    function _rRatio(v) { return _rdp(v, DEFAULTS.round.ratio); }
    function _r2(v) { return _rdp(v, 0.01); }
    function _txt(s) {   // plain text < 300 characters, no banned words
        s = String(s == null ? '' : s).replace(/\b(null|undefined|NaN|Infinity)\b/g, '—').replace(/\[object Object\]/g, '');
        return s.length < 300 ? s : s.slice(0, 296) + '…';
    }
    function _fmt(v, sig) {
        if (!_num(v)) return '—';
        var a = Math.abs(v);
        if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(Math.max(0, (sig || 3) - 1));
        return String(+v.toPrecision(sig || 3));
    }
    function _warn(code, level, text, ev) { return { code: code, level: level, text: _txt(text), ev: ev || ['M7'] }; }
    function _copy(o) { var r = {}; if (o) for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }
    function _jsonClean(v) {
        // finite-or-null for every number, plain arrays (JSON-safe), no undefined
        if (v === null || v === undefined) return null;
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (typeof v !== 'object') return v;
        if (Array.isArray(v) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v))) {
            var a = new Array(v.length);
            for (var i = 0; i < v.length; i++) a[i] = _jsonClean(v[i]);
            return a;
        }
        var o = {};
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && k.charAt(0) !== '_' && v[k] !== undefined && typeof v[k] !== 'function') o[k] = _jsonClean(v[k]);
        return o;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Scaled modified Bessel functions (local to 53): I0e, I1e, K0e, K1e
    //   Ke(x) = K(x)·e^x, Ie(x) = I(x)·e^-x. ≤ ~1e-14 relative (Stehfest
    //   amplifies kernel error ~1e5, so polynomial fits are not used).
    //   K: ascending series for x ≤ 2, trapezoid on ∫ e^{−x(cosh u − 1)} cosh(νu) du for 2 < x ≤ 16
    //   (the trapezoid error grows like e^{x−49}: 8e-15 at 16, 7e-11 at 25), asymptotic beyond (error ~e^{−2x}).
    //   I: ascending series for x ≤ 20, asymptotic expansion beyond (error ~e^{−2x}).
    // ─────────────────────────────────────────────────────────────────────
    var BH = 0.2, BCOSH = [];
    for (var bk = 0; bk < 400; bk++) BCOSH.push(Math.cosh(bk * BH));
    function _kSmall(x) {
        var y = x * x / 4, lx = Math.log(x / 2);
        var t0 = 1, t1 = 1, I0 = 0, I1s = 0, s0 = 0, s1 = 0, psi = -EULER, psi1 = 1 - EULER;
        for (var k = 0; k < 60; k++) {
            if (k > 0) { t0 *= y / (k * k); t1 *= y / (k * (k + 1)); psi += 1 / k; psi1 += 1 / (k + 1); }
            I0 += t0; I1s += t1; s0 += psi * t0; s1 += (psi + psi1) * t1;
            if (t0 < 1e-18 * I0 && k > 2) break;
        }
        var I1 = (x / 2) * I1s;
        return [-lx * I0 + s0, 1 / x + lx * I1 - (x / 4) * s1];
    }
    function _asymK(x, nu) {   // K_ν(x)·e^x ≈ √(π/2x) Σ a_k(ν)/x^k (x > 16: error ~e^{−2x} ≤ 1.3e-14)
        var mu = 4 * nu * nu, sum = 1, term = 1, prev = Infinity;
        for (var k = 1; k < 60; k++) {
            term *= (mu - (2 * k - 1) * (2 * k - 1)) / (k * 8 * x);
            var at = Math.abs(term);
            if (at > prev) break;
            sum += term; prev = at;
            if (at < 1e-17 * Math.abs(sum)) break;
        }
        return sum * Math.sqrt(Math.PI / (2 * x));
    }
    function _kePair(x) {      // [K0e, K1e]
        if (x <= 2) { var k = _kSmall(x), e = Math.exp(x); return [k[0] * e, k[1] * e]; }
        if (x > 16) return [_asymK(x, 0), _asymK(x, 1)];
        var s0 = 0.5, s1 = 0.5;
        for (var j = 1; j < 400; j++) {
            var ch = BCOSH[j], ee = Math.exp(-x * (ch - 1));
            s0 += ee; s1 += ee * ch;
            if (ee * ch < 1e-18 * s1) break;
        }
        return [s0 * BH, s1 * BH];
    }
    function _iePair(x) {      // [I0e, I1e]
        if (!(x > 0)) return [1, 0];
        if (x <= 20) {
            var y = x * x / 4, t0 = 1, t1 = 1, I0 = 1, I1s = 1;
            for (var k = 1; k < 300; k++) {
                t0 *= y / (k * k); t1 *= y / (k * (k + 1));
                I0 += t0; I1s += t1;
                if (t0 < 1e-17 * I0 && t1 < 1e-17 * I1s) break;
            }
            var e = Math.exp(-x);
            return [I0 * e, (x / 2) * I1s * e];
        }
        return [_asymI(x, 0), _asymI(x, 1)];
    }
    function _asymI(x, nu) {   // I_ν(x)·e^-x ≈ Σ (−1)^k a_k(ν)/x^k / √(2πx) (x > 20)
        var pref = 1 / Math.sqrt(2 * Math.PI * x);
        var mu = 4 * nu * nu, sum = 1, term = 1, prev = Infinity;
        for (var kk = 1; kk < 60; kk++) {
            term *= -(mu - (2 * kk - 1) * (2 * kk - 1)) / (kk * 8 * x);
            var at = Math.abs(term);
            if (at > prev) break;
            sum += term; prev = at;
            if (at < 1e-17 * Math.abs(sum)) break;
        }
        return sum * pref;
    }
    // Single members (bit-identical to the pairs; the asymptotic branches skip the unused order).
    function _k0e(x) { return x > 16 ? _asymK(x, 0) : _kePair(x)[0]; }
    function _k1e(x) { return x > 16 ? _asymK(x, 1) : _kePair(x)[1]; }
    function _i1e(x) { return x > 20 ? _asymI(x, 1) : _iePair(x)[1]; }
    // Well-term values repeat across parameter sets: with S ≥ 0 the grid lattice fixes every
    // Stehfest s, so a bounded memo keyed by √s returns the identical numbers without the
    // series / trapezoid work (speed only; cleared when full; never used for S < 0).
    var MEMO_MAX = 40000, _KMEMO = new Map(), _IMEMO = new Map();
    function _kePairW(q, memo) {
        if (!memo) return _kePair(q);
        var v = _KMEMO.get(q);
        if (v === undefined) { if (_KMEMO.size >= MEMO_MAX) _KMEMO.clear(); v = _kePair(q); _KMEMO.set(q, v); }
        return v;
    }
    function _iePairW(q, memo) {
        if (!memo) return _iePair(q);
        var v = _IMEMO.get(q);
        if (v === undefined) { if (_IMEMO.size >= MEMO_MAX) _IMEMO.clear(); v = _iePair(q); _IMEMO.set(q, v); }
        return v;
    }
    function K0e(x) { return _kePair(x)[0]; }
    function K1e(x) { return _kePair(x)[1]; }
    function I0e(x) { return _iePair(x)[0]; }
    function I1e(x) { return _iePair(x)[1]; }

    // ── Laplace reservoir kernels p̄(s) (no WBS / skin); d = distance scale ──
    function _lapHom(s, d, memo) { var q = Math.sqrt(s), k = _kePairW(q, memo); return k[0] / (s * q * k[1]); }
    // Image term K0e(q·r)·e^{−q(r−1)}: skipped beyond q(r − 1) = 40, where it is below 2^−54 of the
    // well term K0e(q) (K0e decreases), so the sum rounds to the same double (speed only).
    var IMG_SKIP = 40;
    function _lapFault(dF, bc) {
        var sgn = (bc === 'constP') ? -1 : 1;
        return function (s, d, memo) {
            var q = Math.sqrt(s), kw = _kePairW(q, memo), r = 2 * dF * (d || 1);
            var img = 0;
            if (r > 1) { var e = q * (r - 1); if (e < IMG_SKIP) img = _k0e(q * r) * Math.exp(-e); }
            return (kw[0] + sgn * img) / (s * q * kw[1]);
        };
    }
    // Closed circle, well at the centre: p̄ = [K0(√s) + I0(√s)ρ] / (s√s[K1(√s) − I1(√s)ρ]),
    // ρ = K1(reD√s)/I1(reD√s), in scaled form (the e^{2q−2x} factor underflows safely to 0).
    // The boundary terms carry e^{g}, g = 2q − 2x; below g = −40 they are < 1e-17
    // of the well term (ρ ≈ π e^g, I(q)e^{−q} ≤ 1) and are skipped.
    var G_SKIP = -40;
    function _lapClosedCircle(reD) {
        return function (s, d, memo) {
            var q = Math.sqrt(s), x = reD * (d || 1) * q;
            var kq = _kePairW(q, memo);
            var g = 2 * q - 2 * x;
            if (g < G_SKIP) return kq[0] / (s * q * kq[1]);
            var iq = _iePairW(q, memo);
            var rho = (_k1e(x) / _i1e(x)) * Math.exp(g);
            return (kq[0] + iq[0] * rho) / (s * q * (kq[1] - iq[1] * rho));
        };
    }
    // Two-zone radial composite (inner r ∈ [1, R], outer r > R; M = λ1/λ2, F = (φct)1/(φct)2):
    //   p̄1 = A I0(r√s) + B K0(r√s), p̄2 = Cc K0(r√(sM/F)); √s(B K1(√s) − A I1(√s)) = 1/s;
    //   p̄1 = p̄2 and dp̄1/dr = (1/M) dp̄2/dr at R. Solved in closed form (3×3 reduced), scaled.
    function _lapComposite2(M, F, R) {
        return function (s, d, memo) {
            var a = Math.sqrt(s), b = Math.sqrt(s * M / F);
            var RR = R * (d || 1); if (!(RR > 1.000001)) RR = 1.000001;
            var ka = _kePairW(a, memo);
            var g = 2 * a - 2 * a * RR;
            if (g < G_SKIP - Math.log(Math.max(1, M))) return ka[0] / (s * a * ka[1]);
            var ia = _iePairW(a, memo), kbR = _kePair(b * RR);
            var gam = (b / M) * kbR[1] / kbR[0];
            var kaR = _kePair(a * RR), iaR = _iePair(a * RR);
            var kap = (a * kaR[1] - gam * kaR[0]) / (a * iaR[1] + gam * iaR[0]) * Math.exp(g);
            return (ka[0] + kap * ia[0]) / (s * a * (ka[1] - kap * ia[1]));
        };
    }

    // ── Stehfest N = 12 (the app's weights when present) ──
    var _SW = null;
    function _stehW() {
        if (_SW) return _SW;
        var t = G.PRiSM_STEHFEST_W;
        if (t && t[12] && t[12].length === 12) { _SW = Array.prototype.slice.call(t[12]); return _SW; }
        var N = 12, N2 = 6, fact = [1];
        for (var i = 1; i <= 2 * N; i++) fact[i] = fact[i - 1] * i;
        var W = new Array(N);
        for (var n = 1; n <= N; n++) {
            var sum = 0;
            for (var k = Math.floor((n + 1) / 2); k <= Math.min(n, N2); k++) {
                sum += Math.pow(k, N2) * fact[2 * k] / (fact[N2 - k] * fact[k] * fact[k - 1] * fact[n - k] * fact[2 * k - n]);
            }
            W[n - 1] = (((n + N2) % 2 === 0) ? 1 : -1) * sum;
        }
        _SW = W;
        return W;
    }

    // [pd, pd′] with WBS + skin, one set of kernel evaluations for both; the same
    // fold, negative-skin transform and pure-storage fast path as PRiSM_evalWbsSkin (03).
    function _pair(lap, t, Cd, S, scaleDist) {
        if (!(t > 0)) return [0, 0];
        var C = (Cd > 0) ? Cd : 0, SS = S || 0, tt = t, dS = 1, memo = !(SS < 0);
        if (SS < 0) { var e2 = Math.exp(2 * SS); tt = t * e2; C = C * e2; dS = scaleDist === false ? 1 : Math.exp(SS); SS = 0; }
        if (C > 0 && tt < Math.min(1e-3 * C, 1e-12 * C * C)) return [tt / C, tt / C];
        var W = _stehW(), a = LN2 / tt, accP = 0, accD = 0;
        for (var i = 1; i <= 12; i++) {
            var s = i * a, pbar = lap(s, dS, memo), inner = s * pbar + SS;
            var F = inner / (s * (1 + C * s * inner));
            accP += W[i - 1] * F; accD += W[i - 1] * s * F;
        }
        STATS.kernelEvals++;
        return [a * accP, tt * a * accD];
    }
    function _evalModel(lap, td, Cd, S, deriv) {
        var one = function (t) { return _pair(lap, +t, Cd, S, true)[deriv ? 1 : 0]; };
        if (Array.isArray(td) || (td && typeof td.length === 'number' && typeof td !== 'string')) {
            var out = new Array(td.length);
            for (var i = 0; i < td.length; i++) out[i] = one(td[i]);
            return out;
        }
        return one(td);
    }

    // ── PRiSM_MODELS.closedCircle (§3.3): registry model folded with PRiSM_evalWbsSkin ──
    function _ccParams(params) {
        var p = params || {};
        var Cd = _num(p.Cd) ? p.Cd : 100, S = _num(p.S) ? p.S : 0, reD = _num(p.reD) ? p.reD : 5000;
        if (!(Cd >= 0)) throw new Error('PRiSM closedCircle: Cd must be ≥ 0');
        if (!(reD > 1)) throw new Error('PRiSM closedCircle: reD must be > 1');
        return { Cd: Cd, S: S, reD: reD };
    }
    function _ccEval(td, params, deriv) {
        var p = _ccParams(params), lap = _lapClosedCircle(p.reD);
        if (typeof G.PRiSM_evalWbsSkin === 'function') return G.PRiSM_evalWbsSkin(lap, td, p.Cd, p.S, { derivative: !!deriv });
        return _evalModel(lap, td, p.Cd, p.S, deriv);
    }
    G.PRiSM_MODELS = G.PRiSM_MODELS || {};
    G.PRiSM_MODELS.closedCircle = {
        name: 'Closed circle',
        pd: function (td, params) { return _ccEval(td, params, false); },
        pdPrime: function (td, params) { return _ccEval(td, params, true); },
        kind: 'pressure', timeInput: 'td', category: 'boundary', refLength: 'rw',
        defaultFrozen: [], evalCostMs: 1.5,
        defaults: { Cd: 100, S: 0, reD: 5000 },
        paramSpec: [
            { key: 'Cd', label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S', label: 'Skin S', unit: '-', min: -7, max: 50, default: 0 },
            { key: 'reD', label: 'r_e / r_w', unit: '-', min: 50, max: 1e7, default: 5000, scale: 'log' }
        ],
        description: 'Well at the centre of a closed circular reservoir; pseudo-steady state at late time.',
        reference: 'van Everdingen & Hurst 1949, The application of the Laplace transformation to flow problems in reservoirs'
    };

    // ─────────────────────────────────────────────────────────────────────
    // bin — medians per log bin (§4.6 item 1)
    // ─────────────────────────────────────────────────────────────────────
    // Bins of 1/perCycle log10 cycle anchored at opts.dtMin (default: the first
    // Δt). With opts.counts (pre-binned input) the medians are count-weighted
    // and the counts add up. Single-sample bins keep the raw value.
    function bin(dt, p, opts) {
        opts = opts || {};
        var per = _pos(opts.perCycle) ? opts.perCycle : 20;
        var counts = Array.isArray(opts.counts) || (opts.counts && typeof opts.counts.length === 'number') ? opts.counts : null;
        var out = { dt: [], p: [], n: [] };
        if (!dt || !dt.length) return out;
        var anchor = _pos(opts.dtMin) ? opts.dtMin : null;
        var i0 = 0;
        while (i0 < dt.length && !(dt[i0] > 0 && _num(p[i0]))) i0++;
        if (i0 >= dt.length) return out;
        if (anchor === null) anchor = dt[i0];
        var la = Math.log10(anchor);
        var curJ = null, bd = [], bp = [], bw = [];
        function flush() {
            if (!bd.length) return;
            var n = 0;
            for (var q = 0; q < bw.length; q++) n += bw[q];
            if (bd.length === 1) { out.dt.push(bd[0]); out.p.push(bp[0]); }
            else { out.dt.push(_wmedian(bd, bw)); out.p.push(_wmedian(bp, bw)); }
            out.n.push(n);
            bd = []; bp = []; bw = [];
        }
        for (var i = i0; i < dt.length; i++) {
            var t = dt[i], v = p[i];
            if (!(t > 0) || !_num(v)) continue;
            var j = Math.floor((Math.log10(t) - la) * per + 1e-7);
            if (j !== curJ) { flush(); curJ = j; }
            bd.push(t); bp.push(v);
            bw.push(counts ? (_pos(counts[i]) ? counts[i] : 1) : 1);
        }
        flush();
        // keep strictly ascending Δt (weighted medians of neighbouring bins never cross, but guard)
        for (var k = out.dt.length - 1; k > 0; k--) {
            if (!(out.dt[k] > out.dt[k - 1])) { out.dt.splice(k, 1); out.p.splice(k, 1); out.n[k - 1] += out.n[k]; out.n.splice(k, 1); }
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // derivative — Bourdet dΔp/d ln Δt_e with a full-window mask (D6)
    // ─────────────────────────────────────────────────────────────────────
    // x = ln Δt_e ascending; L = Lcyc·ln 10 (0.2303 ln at 0.1 cycle). Bin i is
    // "full" when a neighbour at ≥ L exists on both sides (the nearest such
    // neighbours are used); other entries are null. Negative derivatives stay
    // in deriv (they are "falling" evidence) and are listed in neg; they are
    // never logged.
    function derivative(x, dp, Lcyc, opts) {
        var L = (_pos(Lcyc) ? Lcyc : DEFAULTS.Lcyc) * LN10;
        var Ltol = L * (1 - 1e-9);
        var n = x.length, d = new Array(n), full = new Array(n), neg = [];
        var j = 0, k = 0;
        for (var i = 0; i < n; i++) {
            d[i] = null; full[i] = false;
            // nearest j < i with x_i − x_j ≥ L (largest such j)
            while (j + 1 < i && x[i] - x[j + 1] >= Ltol) j++;
            if (k < i + 1) k = i + 1;
            while (k < n && x[k] - x[i] < Ltol) k++;
            if (!(x[i] - x[j] >= Ltol) || j >= i || k >= n) continue;
            var a = x[i] - x[j], b = x[k] - x[i];
            var v = ((dp[i] - dp[j]) / a * b + (dp[k] - dp[i]) / b * a) / (a + b);
            if (!_num(v)) continue;
            d[i] = v; full[i] = true;
            if (v <= 0) neg.push(i);
        }
        return { deriv: d, full: full, neg: neg, L_ln: L };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Superposition equivalent time Δt_e over a rate history
    // ─────────────────────────────────────────────────────────────────────
    // ln Δt_e(Δt) = ln Δt + Σ_{i<n} w_i [ln(off_i + Δt) − ln off_i], w_i = Δq_i/Δq_n,
    // off_i = t_c − t_i. Δt_e → Δt as Δt → 0; Δt_e → tp_eff = Π off_i^{−w_i} as Δt → ∞
    // (= tp for a single rate, so Δt = Δt_e·tp/(tp − Δt_e) exactly there).
    function _supTerms(steps, tc) {
        var n = steps.length, terms = [];
        var dqn = steps[n - 1].q - (n > 1 ? steps[n - 2].q : 0);
        if (dqn === 0) return null;
        for (var i = 0; i < n - 1; i++) {
            var dq = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
            if (dq === 0) continue;
            var off = tc - steps[i].t;
            if (!(off > 0)) return null;
            terms.push({ w: dq / dqn, off: off });
        }
        return terms;
    }
    function _makeTime(steps, tc) {
        var terms = _supTerms(steps, tc);
        if (!terms) return null;
        var lnTp = 0;
        for (var i = 0; i < terms.length; i++) lnTp -= terms[i].w * Math.log(terms[i].off);
        function lnDte(dt) {
            var v = Math.log(dt);
            for (var j = 0; j < terms.length; j++) v += terms[j].w * (Math.log(terms[j].off + dt) - Math.log(terms[j].off));
            return v;
        }
        var tpEff = Math.exp(lnTp);
        function dtOfDte(dte) {
            if (!(dte > 0) || !(dte < tpEff * (1 - 1e-12))) return null;
            if (terms.length === 1 && Math.abs(terms[0].w + 1) < 1e-12) return dte * tpEff / (tpEff - dte);
            var target = Math.log(dte), lo = Math.log(dte) - 1e-9, hi = lo;
            var f = function (u) { return lnDte(Math.exp(u)) - target; };
            if (f(lo) > 0) { while (f(lo) > 0 && lo > -60) lo -= 1; }
            hi = lo;
            var guard = 0;
            while (f(hi) < 0 && guard++ < 200) hi += 1;
            if (f(hi) < 0) return null;
            for (var it = 0; it < 100; it++) {
                var mid = 0.5 * (lo + hi);
                if (f(mid) < 0) lo = mid; else hi = mid;
                if (hi - lo < 1e-13) break;
            }
            return Math.exp(0.5 * (lo + hi));
        }
        // PRiSM C2 time-function terms (x = exp Σ w ln(off + Δt), includes the last step with off 0)
        var c2 = terms.map(function (t) { return { w: t.w, off: t.off }; });
        c2.push({ w: 1, off: 0 });
        return { terms: terms, c2terms: c2, tpEff: tpEff, lnDte: lnDte, dtOfDte: dtOfDte };
    }

    // ─────────────────────────────────────────────────────────────────────
    // compactHistory — last keepFactor·Δt_end exact + one volume-mean block (D5)
    // ─────────────────────────────────────────────────────────────────────
    function compactHistory(steps, tc_h, dtEnd_h, opts) {
        opts = opts || {};
        var keep = _pos(opts.keepFactor) ? opts.keepFactor : 10;
        var s = (steps || []).filter(function (x) { return x && _num(x.t) && _num(x.q); }).map(function (x) { return { t: x.t, q: x.q }; });
        if (!s.length) return { steps: [], nKept: 0, nLumped: 0, lumped: null };
        var tcut = tc_h - keep * dtEnd_h;
        if (!(s[0].t < tcut)) return { steps: s, nKept: s.length, nLumped: 0, lumped: null };
        var V = 0, nL = 0, qAtCut = 0;
        for (var i = 0; i < s.length; i++) {
            if (s[i].t >= tcut) break;
            var t1 = (i + 1 < s.length) ? Math.min(s[i + 1].t, tcut) : tcut;
            V += s[i].q * (t1 - s[i].t);
            qAtCut = s[i].q;
            nL++;
        }
        var kept = s.slice(nL);
        var t0 = s[0].t, qL = V / (tcut - t0);
        var out = [{ t: t0, q: qL }];
        if (!kept.length || kept[0].t > tcut) out.push({ t: tcut, q: qAtCut });
        kept.forEach(function (x) { out.push(x); });
        // merge equal consecutive rates (never the final q = 0 step)
        var merged = [out[0]];
        for (var k = 1; k < out.length; k++) {
            if (out[k].q === merged[merged.length - 1].q && k < out.length - 1) continue;
            merged.push(out[k]);
        }
        return { steps: merged, nKept: kept.length, nLumped: nL, lumped: { t0: t0, t1: tcut, q: qL, V: V } };
    }

    // ─────────────────────────────────────────────────────────────────────
    // gasTable — m(p), z, μ, cg on a pressure grid; normalised pseudo-pressure
    // ─────────────────────────────────────────────────────────────────────
    // z from WTS_gaspvt_z (impurity-aware) when present, else the PRiSM
    // correlations (Sutton pseudo-criticals, Dranchuk–Abou-Kassem); μg Lee–
    // Gonzalez–Eakin. p_n(p) = (μz/p)_ref·m(p)/2 (Meunier et al. 1987) has
    // pressure units and behaves like a liquid Δp with μ_ref, Bg_ref, ct.
    function gasTable(gas) {
        gas = gas || {};
        var sg = +gas.sg, T_F = +gas.T_F, co2 = +gas.co2 || 0, h2s = +gas.h2s || 0, n2 = +gas.n2 || 0;
        var pmax = _pos(gas.pmax) ? gas.pmax : 6000;
        var L = G.PRiSM_pvt_correlations;
        if (!_pos(sg) || !_num(T_F)) return { ok: false, reason: 'gas gravity and temperature are required' };
        var TR = T_F + 459.67;
        var zFn = null, impurityAware = false;
        if (typeof G.WTS_gaspvt_z === 'function') {
            zFn = function (p) { try { var r = G.WTS_gaspvt_z({ sg: sg, p: p, t: T_F, co2: co2, h2s: h2s, n2: n2 }); return (r && r.ok) ? r.z : NaN; } catch (e) { return NaN; } };
            impurityAware = true;
            if (!_pos(zFn(Math.min(1000, pmax)))) { zFn = null; impurityAware = false; }
        }
        if (!zFn && L && typeof L.Z_dranchukAbouKassem === 'function') {
            var Tpc = L.Tpc_sutton(sg), Ppc = L.Ppc_sutton(sg);
            zFn = function (p) { return L.Z_dranchukAbouKassem(TR / Tpc, p / Ppc); };
        }
        if (!zFn || !L || typeof L.mu_g_leeGonzalezEakin !== 'function') return { ok: false, reason: 'gas PVT correlations are not loaded' };
        var muFn = function (p, z) { return L.mu_g_leeGonzalezEakin(sg, T_F, z, p); };
        var N = 241, p0 = 14.7, h = (pmax - p0) / (N - 1);
        var P = new Array(N), Z = new Array(N), MU = new Array(N), D = new Array(N), Mv = new Array(N);
        for (var i = 0; i < N; i++) {
            P[i] = p0 + i * h; Z[i] = zFn(P[i]); MU[i] = muFn(P[i], Z[i]);
            if (!_pos(Z[i]) || !_pos(MU[i])) return { ok: false, reason: 'z or viscosity could not be evaluated' };
            D[i] = 2 * P[i] / (MU[i] * Z[i]);
        }
        Mv[0] = D[0] * p0 / 2;     // ∫_0^p0 2p/(μz) dp with μz ≈ constant
        for (var j = 1; j < N; j++) {
            var pm = P[j] - h / 2, zm = zFn(pm), mm = muFn(pm, zm);
            var dm = (_pos(zm) && _pos(mm)) ? 2 * pm / (mm * zm) : 0.5 * (D[j - 1] + D[j]);
            Mv[j] = Mv[j - 1] + (h / 6) * (D[j - 1] + 4 * dm + D[j]);
        }
        function idx(p) { return Math.max(0, Math.min(N - 2, Math.floor((p - p0) / h))); }
        function mOf(p) {
            if (!_num(p)) return NaN;
            if (p <= p0) return Mv[0] * (p > 0 ? (p / p0) * (p / p0) : 0);
            if (p >= P[N - 1]) return Mv[N - 1] + D[N - 1] * (p - P[N - 1]);
            var k = idx(p), u = (p - P[k]) / h, u2 = u * u, u3 = u2 * u;
            return (2 * u3 - 3 * u2 + 1) * Mv[k] + (u3 - 2 * u2 + u) * h * D[k] + (-2 * u3 + 3 * u2) * Mv[k + 1] + (u3 - u2) * h * D[k + 1];
        }
        function pOf(m) {
            if (!_num(m)) return NaN;
            if (m <= Mv[0]) return p0 * Math.sqrt(Math.max(0, m / Mv[0]));
            if (m >= Mv[N - 1]) return P[N - 1] + (m - Mv[N - 1]) / D[N - 1];
            var lo = 0, hi = N - 1;
            while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (Mv[mid] > m) hi = mid; else lo = mid; }
            var a = P[lo], b = P[hi];
            for (var it = 0; it < 60; it++) { var c = 0.5 * (a + b); if (mOf(c) > m) b = c; else a = c; if (b - a < 1e-10) break; }
            return 0.5 * (a + b);
        }
        function interp(arr, p) { var k = idx(p), u = (p - P[k]) / h; return arr[k] + u * (arr[k + 1] - arr[k]); }
        function cgOf(p) {   // cg = 1/p − (1/z) dz/dp
            var k = idx(p), dz = (Z[k + 1] - Z[k]) / h;
            return 1 / p - dz / interp(Z, p);
        }
        var tbl = { ok: true, p: P, m: Mv, z: Z, mu: MU, cg: P.map(function (pp) { return cgOf(pp); }), mOf: mOf, pOf: pOf,
                    zOf: function (p) { return interp(Z, p); }, muOf: function (p) { return interp(MU, p); }, cgOf: cgOf,
                    impurityAware: impurityAware, ref: null };
        var pRef = _pos(gas.pRef) ? gas.pRef : Math.min(pmax / 1.2, 0.5 * pmax);
        tbl.setRef = function (pr) {
            var z = interp(Z, pr), mu = interp(MU, pr);
            tbl.ref = { p: pr, mu: mu, z: z, ct: cgOf(pr), Bg: 5.035 * z * TR / pr };
            return tbl.ref;
        };
        tbl.pn = function (p) { return (tbl.ref.mu * tbl.ref.z / tbl.ref.p) * mOf(p) / 2; };
        tbl.pOfPn = function (pn) { return pOf(pn * 2 * tbl.ref.p / (tbl.ref.mu * tbl.ref.z)); };
        tbl.setRef(pRef);
        return tbl;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Tide fit (Q6): M2 (12.4206 h) from 24 h, M2 + K1 (23.9345 h) from 48 h
    // ─────────────────────────────────────────────────────────────────────
    function _solve(A, b) {    // small dense Gaussian elimination with partial pivoting
        var n = b.length, M = A.map(function (r, i) { return r.slice().concat([b[i]]); });
        for (var c = 0; c < n; c++) {
            var piv = c;
            for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            if (!(Math.abs(M[piv][c]) > 1e-300)) return null;
            var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
            for (var r2 = c + 1; r2 < n; r2++) {
                var f = M[r2][c] / M[c][c];
                for (var k = c; k <= n; k++) M[r2][k] -= f * M[c][k];
            }
        }
        var x = new Array(n);
        for (var i = n - 1; i >= 0; i--) {
            var s = M[i][n];
            for (var j = i + 1; j < n; j++) s -= M[i][j] * x[j];
            x[i] = s / M[i][i];
        }
        return x;
    }
    function _tideFit(dt, y, tc, dtEnd, nHarm) {
        var t0 = Math.max(2, dtEnd / 4), rows = [];
        var periods = nHarm === 2 ? [12.4206, 23.9345] : [12.4206];
        for (var i = 0; i < dt.length; i++) {
            if (!(dt[i] >= t0) || !_num(y[i])) continue;
            var X = Math.log(dt[i]), r = [1, X, X * X];
            for (var k = 0; k < periods.length; k++) {
                var w = 2 * Math.PI / periods[k], ta = tc + dt[i];
                r.push(Math.cos(w * ta), Math.sin(w * ta));
            }
            rows.push({ r: r, y: y[i] });
        }
        var m = 3 + 2 * periods.length;
        if (rows.length < m + 5) return null;
        var A = [], b = [];
        for (var a = 0; a < m; a++) { A.push(new Array(m).fill(0)); b.push(0); }
        rows.forEach(function (o) {
            for (var a2 = 0; a2 < m; a2++) { b[a2] += o.r[a2] * o.y; for (var c = 0; c < m; c++) A[a2][c] += o.r[a2] * o.r[c]; }
        });
        var x = _solve(A, b);
        if (!x) return null;
        var harm = [];
        for (var k2 = 0; k2 < periods.length; k2++) {
            var ca = x[3 + 2 * k2], sa = x[4 + 2 * k2];
            harm.push({ period: periods[k2], w: 2 * Math.PI / periods[k2], a: ca, b: sa, A: Math.sqrt(ca * ca + sa * sa) });
        }
        return { harm: harm };
    }

    // ─────────────────────────────────────────────────────────────────────
    // prepare(spec) → Prep (§3.1)
    // ─────────────────────────────────────────────────────────────────────
    function _failP(code, msg, bad) { return { ok: false, code: code, errors: [_txt(msg)], bad: bad || [] }; }

    function _localSlopes(X, y) {   // d ln y / d X (central), null where undefined
        var n = X.length, s = new Array(n);
        for (var i = 0; i < n; i++) {
            s[i] = null;
            var a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
            if (b === a || !(y[a] > 0) || !(y[b] > 0)) continue;
            s[i] = (Math.log(y[b]) - Math.log(y[a])) / (X[b] - X[a]);
        }
        return s;
    }

    function prepare(spec, opts) {
        opts = opts || {};
        if (!spec || typeof spec !== 'object') return _failP('NO_DATA', 'No build-up specification.', ['spec']);
        var dtIn = spec.dt, pIn = spec.p;
        if (!dtIn || !pIn || dtIn.length < 5 || pIn.length !== dtIn.length) return _failP('NO_DATA', 'Too few build-up samples.', ['dt', 'p']);
        var w = spec.well || {};
        var badW = ['h', 'phi', 'mu', 'B', 'ct', 'rw'].filter(function (k) { return !_pos(w[k]); });
        if (badW.length) return _failP('BAD_WELL', 'Well inputs missing or not positive: ' + badW.join(', ') + '.', badW);
        if (!_pos(spec.Dq)) return _failP('BAD_WELL', 'The rate before closing is not positive.', ['Dq']);
        var steps = Array.isArray(spec.steps) ? spec.steps.filter(function (s) { return s && _num(s.t) && _num(s.q); }).map(function (s) { return { t: s.t, q: Math.abs(s.q) }; }) : [];
        var tc = spec.tc_h;
        if (!_num(tc) || steps.length < 2) return _failP('BAD_HISTORY', 'The rate history needs at least one flowing step and the closing.', ['steps']);
        for (var si = 1; si < steps.length; si++) if (!(steps[si].t > steps[si - 1].t)) return _failP('BAD_HISTORY', 'Rate steps are not in time order.', ['steps']);
        var last = steps[steps.length - 1];
        if (last.q !== 0 || Math.abs(last.t - tc) > 1e-6 * Math.max(1, Math.abs(tc))) return _failP('BAD_HISTORY', 'The rate history must end with q = 0 at the closing time.', ['steps']);
        var qPrev = steps[steps.length - 2].q;
        if (!(qPrev > 0)) return _failP('BAD_HISTORY', 'The well was not flowing before the closing.', ['steps']);
        var warnings = [];
        var sign = spec.testType === 'falloff' ? -1 : 1;
        var Lcyc = (spec.opts && _pos(spec.opts.Lcyc)) ? spec.opts.Lcyc : DEFAULTS.Lcyc;
        var per20 = (spec.opts && _pos(spec.opts.binsPerCycle)) ? spec.opts.binsPerCycle : DEFAULTS.binsPerCycle;
        var per12 = (spec.opts && _pos(spec.opts.fitBinsPerCycle)) ? spec.opts.fitBinsPerCycle : DEFAULTS.fitBinsPerCycle;
        // Rates: the whole history scaled so the final drop equals Δq (f̂ already in Dq).
        var scale = spec.Dq / qPrev;
        var stepsU = steps.map(function (s) { return { t: s.t, q: s.q * scale }; });
        if (Math.abs(scale - 1) > 1e-6) warnings.push(_warn('RATE_SCALED', 'info', 'The rate history was scaled by ' + _fmt(scale, 4) + ' so the drop at closing equals the interpreted rate change.', ['R1']));
        var tm = _makeTime(stepsU, tc);
        if (!tm) return _failP('BAD_HISTORY', 'The superposition time cannot be built from this rate history.', ['steps']);

        // Raw arrays (sorted, Δt > 0, finite)
        var dtA = [], pA = [], nA = [];
        var cnt = spec.n || null;
        for (var i = 0; i < dtIn.length; i++) {
            if (!(dtIn[i] > 0) || !_num(pIn[i])) continue;
            dtA.push(+dtIn[i]); pA.push(+pIn[i]); nA.push(cnt && _pos(cnt[i]) ? cnt[i] : 1);
        }
        if (dtA.length < 5) return _failP('TOO_FEW_POINTS', 'Fewer than 5 valid build-up samples.', ['dt']);
        for (var c0 = 1; c0 < dtA.length; c0++) if (!(dtA[c0] > dtA[c0 - 1])) return _failP('NO_DATA', 'Build-up times are not ascending.', ['dt']);
        var dtEnd = dtA[dtA.length - 1];

        // Gas: normalised pseudo-pressure (and optional pseudo-time for the build-up period)
        var gt = null, fluid = w.fluid || 'oil';
        var Bm = w.B, mum = w.mu, ctm = w.ct, qUnit = spec.qUnit || (fluid === 'gas' ? 'Mscf/d' : 'STB/d');
        if (fluid === 'gas' && spec.gas) {
            var pmx = spec.pwf0;
            for (var g0 = 0; g0 < pA.length; g0++) if (pA[g0] > pmx) pmx = pA[g0];
            gt = gasTable({ sg: spec.gas.sg, T_F: spec.gas.T_F, co2: spec.gas.co2, h2s: spec.gas.h2s, n2: spec.gas.n2, pmax: Math.max(1.3 * pmx, pmx + 500) });
            if (!gt || !gt.ok) {
                warnings.push(_warn('GAS_TABLE', 'warn', 'Gas properties could not be evaluated: the build-up is analysed with pressure (liquid form).', ['M1']));
                gt = null;
            } else {
                gt.setRef(0.5 * (spec.pwf0 + pA[pA.length - 1]));   // μ·ct at the build-up average pressure (stated)
                Bm = gt.ref.Bg; mum = gt.ref.mu;
            }
        }
        var yA = gt ? pA.map(gt.pn) : pA.slice();
        var y0 = gt ? gt.pn(spec.pwf0) : spec.pwf0;
        if (gt && spec.gas && spec.gas.pseudoTime) {
            // t_a = (μ ct)_ref ∫ dt/(μ ct) over the build-up period only (ct ∝ cg here)
            var ta = new Array(dtA.length), acc = 0, prevT = 0, prevF = 1;
            var fOf = function (pp) { return (gt.ref.mu * gt.ref.ct) / (gt.muOf(pp) * gt.cgOf(pp)); };
            prevF = fOf(spec.pwf0);
            for (var tI = 0; tI < dtA.length; tI++) {
                var fI = fOf(pA[tI]);
                acc += 0.5 * (prevF + fI) * (dtA[tI] - prevT);
                ta[tI] = acc; prevT = dtA[tI]; prevF = fI;
            }
            var okTa = ta.every(function (v, ii) { return v > 0 && (ii === 0 || v > ta[ii - 1]); });
            if (okTa) { dtA = ta; warnings.push(_warn('PSEUDO_TIME', 'info', 'Pseudo-time replaces the elapsed time of the build-up period; earlier rate steps stay in real time.', ['M1'])); }
        }

        // Tide (Q6): index and removal before the derivative
        var rTide = null, tideRemoved = false, tideFit = 'none';
        var tideMode = (spec.opts && spec.opts.tide) || 'auto';
        function buildBins(yy) {
            var b20 = bin(dtA, yy, { perCycle: per20, counts: cnt ? nA : null });
            var bf = bin(dtA, yy, { perCycle: per12, counts: cnt ? nA : null });
            return { b20: b20, bf: bf };
        }
        var BB = buildBins(yA);
        function derivOf(b) {
            var dp = b.p.map(function (v) { return sign * (v - y0); });
            var X = b.dt.map(function (v) { return tm.lnDte(v); });
            return { dp: dp, X: X, d: derivative(X, dp, Lcyc) };
        }
        var D20 = derivOf(BB.b20);
        if (tideMode !== 'off' && dtEnd >= DEFAULTS.tide.m2Min_h) {
            var lateD = [];
            for (var lq = 0; lq < D20.X.length; lq++) if (D20.d.full[lq] && D20.d.deriv[lq] > 0 && D20.X[lq] >= D20.X[D20.X.length - 1] - 0.5 * LN10) lateD.push(D20.d.deriv[lq]);
            var mpProv = _median(lateD);
            var nH = dtEnd >= DEFAULTS.tide.k1Min_h ? 2 : 1;
            var tf = _pos(mpProv) ? _tideFit(dtA, yA, tc, dtEnd, nH) : null;
            if (tf) {
                var sAw = 0;
                tf.harm.forEach(function (hh) { sAw += hh.A * hh.w; });
                rTide = sAw * dtEnd / mpProv;
                if (rTide > DEFAULTS.tide.index) {
                    yA = yA.map(function (v, ii) {
                        var ta2 = tc + dtA[ii], corr = 0;
                        tf.harm.forEach(function (hh) { corr += hh.a * Math.cos(hh.w * ta2) + hh.b * Math.sin(hh.w * ta2); });
                        return v - corr;
                    });
                    tideRemoved = true; tideFit = nH === 2 ? 'M2K1' : 'M2';
                    BB = buildBins(yA);
                    D20 = derivOf(BB.b20);
                    warnings.push(_warn('TIDE_REMOVED', 'info', 'Tidal signal removed before the derivative (index ' + _fmt(rTide, 2) + ').', ['Q6']));
                }
            }
        }

        // Drop non-positive Δp bins (log scale) — counted
        function keepPos(b, D) {
            var o = { dt: [], p: [], n: [], dp: [], X: [] }, dropped = 0;
            for (var k = 0; k < b.dt.length; k++) {
                if (!(D.dp[k] > 0)) { dropped++; continue; }
                o.dt.push(b.dt[k]); o.p.push(b.p[k]); o.n.push(b.n[k]); o.dp.push(D.dp[k]); o.X.push(D.X[k]);
            }
            o.dropped = dropped;
            return o;
        }
        var B20 = keepPos(BB.b20, D20);
        var DF = derivOf(BB.bf), BF = keepPos(BB.bf, DF);
        if (B20.dt.length < 8 || BF.dt.length < 5) return _failP('TOO_FEW_POINTS', 'Too few build-up bins with a positive pressure change.', ['p']);
        if (B20.dropped) warnings.push(_warn('DP_NONPOS', 'info', B20.dropped + ' early bins with no pressure rise were left out.', ['I5']));
        for (var mx = 1; mx < B20.X.length; mx++) if (!(B20.X[mx] > B20.X[mx - 1])) return _failP('BAD_HISTORY', 'The equivalent time is not monotonic for this rate history.', ['steps']);
        var dv = derivative(B20.X, B20.dp, Lcyc);
        var sig = _num(spec.sigma_psi) ? Math.max(0, spec.sigma_psi) : 0;
        var sigLF = _num(spec.sigmaLF_psi) ? Math.max(0, spec.sigmaLF_psi) : 0;
        var sigma_b = B20.n.map(function (n) { return 1.2533 * sig / Math.sqrt(Math.max(1, n)); });
        var sigma_d = sigma_b.map(function (sb) { return Math.sqrt(sb * sb + sigLF * sigLF) / (Math.SQRT2 * dv.L_ln); });
        var sigma_bF = BF.n.map(function (n) { return 1.2533 * sig / Math.sqrt(Math.max(1, n)); });
        var pReal20 = gt ? B20.p.map(gt.pOfPn) : B20.p.slice();

        // Compacted history for the model; signed rates for PRiSM (injection negative)
        var comp = compactHistory(stepsU, tc, dtEnd, { keepFactor: 10 });
        var tmFit = _makeTime(comp.steps, tc);
        if (!tmFit) return _failP('BAD_HISTORY', 'The compacted rate history is not usable.', ['steps']);
        var qs = sign < 0 ? -1 : 1;
        var rhFit = comp.steps.map(function (s) { return { t: s.t, q: qs * s.q }; });
        var rhFull = stepsU.map(function (s) { return { t: s.t, q: qs * s.q }; });
        var singleRate = stepsU.filter(function (s) { return s.q !== 0; }).length === 1 && stepsU.length === 2;

        var wellC1 = { fluid: fluid === 'water_inj' ? 'water' : (gt ? 'gas' : (fluid === 'gas' ? 'gas' : 'oil')), q: spec.Dq, B: Bm, mu: mum, ct: ctm,
                       h: w.h, phi: w.phi, rw: w.rw, T_R: _num(w.T_R) ? w.T_R : null, pi: null, complete: true, missing: [], defaulted: [],
                       testType: sign < 0 ? 'falloff' : 'buildup', tp: tmFit.tpEff, tShut: tc, pwf0: y0 };
        function mkAdata(b, dp, tmx, rh, Lln) {
            var lnx = b.dt.map(function (v) { var s = 0; tmx.c2terms.forEach(function (t) { s += t.w * Math.log(t.off + v); }); return s; });
            var x = lnx.map(Math.exp);
            var bourdet = (typeof G.PRiSM_compute_bourdet === 'function') ? G.PRiSM_compute_bourdet : null;
            var dd = null;
            if (bourdet) { try { dd = Array.prototype.slice.call(bourdet(x, dp, Lln)); } catch (e) { dd = null; } }
            if (!dd) {   // same 3-point formula as PRiSM_compute_bourdet (02)
                dd = new Array(x.length);
                for (var q = 0; q < x.length; q++) {
                    dd[q] = NaN;
                    if (q === 0 || q === x.length - 1) continue;
                    var i1 = q - 1, i2 = q + 1;
                    while (i1 > 0 && lnx[q] - lnx[i1] < Lln) i1--;
                    while (i2 < x.length - 1 && lnx[i2] - lnx[q] < Lln) i2++;
                    var d1 = lnx[q] - lnx[i1], d2 = lnx[i2] - lnx[q], dT = lnx[i2] - lnx[i1];
                    dd[q] = (dp[q] - dp[i1]) / d1 * (d2 / dT) + (dp[i2] - dp[q]) / d2 * (d1 / dT);
                }
            }
            return {
                ok: true, reason: null, n: b.dt.length, t: b.dt.slice(), tAbs: b.dt.map(function (v) { return tc + v; }), p: b.p.slice(), dp: dp.slice(),
                x: x, lnx: lnx, deriv: dd, L: Lln, timeFn: 'superposition', timeFnSpec: { kind: 'superposition', tp: tmx.tpEff, terms: tmx.c2terms },
                sign: sign, pRef: y0, pRefPressure: y0, pRefSource: 'pwf0', dRef: 'start', pwf0: y0, testType: sign < 0 ? 'falloff' : 'buildup',
                tStart: tc, tShut: tc, tp: tmx.tpEff, qRef: spec.Dq, qFlow: spec.Dq, rateHistory: rh, stepIndex: rh.length - 1, periods: [],
                fluid: wellC1.fluid, pseudo: false, dpUnit: 'psi', mpSpec: null, warnings: []
            };
        }
        var adata = mkAdata(BF, BF.dp, tmFit, rhFit, dv.L_ln);
        var adataLine = mkAdata(B20, B20.dp, tm, rhFull, dv.L_ln);
        adataLine.tp = singleRate ? (tc - stepsU[0].t) : tm.tpEff;

        var prep = {
            ok: true, id: spec.id, sign: sign, spec: spec,
            bins: { dt: B20.dt, dte: B20.X.map(Math.exp), X: B20.X, dp: B20.dp, n: B20.n, p: B20.p, pReal: pReal20, sigma_b: sigma_b, sigma_d: sigma_d },
            deriv: dv, fitSet: { dt: BF.dt, dp: BF.dp, n: BF.n, p: BF.p, sigma_b: sigma_bF, X: BF.X, idx: BF.dt.map(function (v, k) { return k; }) },
            adata: adata, adataLine: adataLine, well: wellC1, gasTable: gt,
            histFull: { steps: stepsU }, histFit: comp, time: tm, timeFit: tmFit, tpEff: tm.tpEff, singleRate: singleRate,
            dtEnd: dtEnd, dteEnd: Math.exp(tm.lnDte(dtEnd)), Lcyc: Lcyc, L_ln: dv.L_ln, qUnit: qUnit,
            snrD: null, rDrift: null, rTide: _fin(rTide), tideRemoved: tideRemoved, tideFit: tideFit,
            sigma: sig, sigmaLF: sigLF, warnings: warnings, raw: { dt: dtA, y: yA, p: pA }
        };
        return prep;
    }

    // ─────────────────────────────────────────────────────────────────────
    // storage(prep) — unit slope, C_us, hump (W1–W3)
    // ─────────────────────────────────────────────────────────────────────
    function _humpIndex(prep) {
        var d = prep.deriv.deriv, f = prep.deriv.full, iMax = -1;
        for (var i = 0; i < d.length; i++) {
            if (!f[i] || !(d[i] > 0)) continue;
            if (iMax < 0 || d[i] > d[iMax]) iMax = i;
            else if (d[i] < 0.9 * d[iMax]) return iMax;   // a ≥ 10 % decline after the maximum: the storage hump
        }
        return -1;
    }
    function storage(prep) {
        var b = prep.bins, n = b.dt.length;
        var iH = _humpIndex(prep);
        var sl = _localSlopes(b.X, b.dp);
        var d = prep.deriv.deriv;
        var end = iH >= 0 ? iH : n;
        var us = [];
        for (var i = 0; i < end; i++) {
            if (sl[i] === null) continue;
            if (sl[i] < 0.85 || sl[i] > 1.10) { if (us.length) break; continue; }
            var ratio = (d[i] !== null && _num(d[i])) ? d[i] / b.dp[i] : sl[i];
            if (ratio < 0.85) { if (us.length) break; continue; }
            us.push(i);
        }
        var unitSlope = us.length >= 3;
        var C_us = null;
        if (unitSlope) {
            var Bq = prep.well.B, q = prep.spec.Dq;
            var cs = us.map(function (k) {
                var dpr = Math.abs(b.pReal[k] - prep.spec.pwf0);
                return q * Bq * b.dt[k] / (24 * dpr);
            });
            C_us = _median(cs);
            if (!_pos(C_us)) { C_us = null; unitSlope = false; }
        }
        return {
            unitSlope: unitSlope, C_us: C_us, tHump_h: iH >= 0 ? b.dt[iH] : null, humpRatio: null, seed: null, humpConsistent: null,
            ev: ['W1', 'W2', 'W3'], _iHump: iH, _us: us
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // iarf(prep, opts) — earliest plateau run, longest window inside (M§A8, D7)
    // ─────────────────────────────────────────────────────────────────────
    function _sparse(vals, fn) {          // sparse table for O(1) range min / max
        var n = vals.length, T = [vals.slice()];
        for (var k = 1; (1 << k) <= n; k++) {
            var prev = T[k - 1], cur = new Array(n - (1 << k) + 1), half = 1 << (k - 1);
            for (var i = 0; i < cur.length; i++) cur[i] = fn(prev[i], prev[i + half]);
            T.push(cur);
        }
        return function (a, b) {          // inclusive
            var len = b - a + 1, k2 = 0;
            while ((1 << (k2 + 1)) <= len) k2++;
            return fn(T[k2][a], T[k2][b - (1 << k2) + 1]);
        };
    }
    function _seSlope(u, s, a, b, Lcyc) {  // √(aᵀΣa) of the OLS slope on u (ln), banded noise covariance
        var n = b - a + 1, mu = 0, Sxx = 0, i, j;
        for (i = a; i <= b; i++) mu += u[i];
        mu /= n;
        for (i = a; i <= b; i++) Sxx += (u[i] - mu) * (u[i] - mu);
        if (!(Sxx > 0)) return Infinity;
        var w2 = 2 * Lcyc * LN10, acc = 0;
        for (i = a; i <= b; i++) {
            var ai = (u[i] - mu) / Sxx;
            for (j = i; j <= b; j++) {
                var dx = u[j] - u[i];
                if (dx >= w2) break;
                var kij = 1 - dx / w2, aj = (u[j] - mu) / Sxx;
                acc += (j === i ? 1 : 2) * ai * aj * s[i] * s[j] * kij;
            }
        }
        return Math.sqrt(Math.max(0, acc));
    }
    function _gateIndex(prep, st) {
        var d = prep.deriv.deriv, f = prep.deriv.full, X = prep.bins.X;
        if (st && st._iHump >= 0) {
            for (var i = st._iHump + 1; i < d.length; i++) if (f[i]) return i;
            return d.length;
        }
        // No hump: after the derivative's local log-slope falls below 0.25.
        for (var k = 1; k < d.length - 1; k++) {
            if (!f[k] || !f[k + 1] || !(d[k] > 0) || !(d[k + 1] > 0)) continue;
            var s = (Math.log(d[k + 1]) - Math.log(d[k])) / (X[k + 1] - X[k]);
            if (s < 0.25) return k;
        }
        return d.length;
    }
    function _iarfNone(prep, D, reason, status, extra) {
        return Object.assign({
            found: false, grade: 'none', noiseWidened: false, status: status || 'expectedNotFound',
            dt0_h: null, dt1_h: null, X0: null, X1: null, cycles: null, level_psi: null, slope: null, slopeSE: null,
            slopeLast: null, slopeLastSE: null, band: D.band, slopeTol: D.slope, noiseLimited: false,
            pointSkin: { spread: null, min: null, max: null }, longest: null, secondLevel: null, laterPlateaus: [], forced: false,
            reason: _txt(reason), ev: ['I1']
        }, extra || {});
    }
    function iarf(prep, opts) {
        opts = opts || {};
        var D = _copy(DEFAULTS.iarf);
        ['band', 'slope', 'bandCap', 'slopeCap', 'minCycles', 'goodCycles', 'goodSlope', 'goodSE', 'valleyDepth', 'mergeLevel', 'mergeGap']
            .forEach(function (k) { if (_pos(opts[k])) D[k] = opts[k]; });
        D.bandCap = Math.max(D.bandCap, D.band); D.slopeCap = Math.max(D.slopeCap, D.slope);
        var b = prep.bins, dv = prep.deriv, X = b.X, d = dv.deriv, full = dv.full, sd = b.sigma_d, n = X.length;
        var st = opts.storage || storage(prep);
        var Lcyc = prep.Lcyc;
        var a0 = _gateIndex(prep, st);
        var lastFull = -1;
        for (var lf = n - 1; lf >= 0; lf--) if (full[lf]) { lastFull = lf; break; }
        var w = prep.well, q = prep.spec.Dq;
        var kOf = function (lvl) { return C_PLAT * q * w.B * w.mu / (w.h * lvl); };
        function windowStats(ia, ib) {   // bin indices inclusive
            var nn = ib - ia + 1, sy = 0, su = 0, suu = 0, suy = 0, mn = Infinity, mxv = -Infinity, ssd = [], ys = [];
            for (var i = ia; i <= ib; i++) {
                sy += d[i]; su += X[i]; suu += X[i] * X[i]; suy += X[i] * d[i];
                if (d[i] < mn) mn = d[i]; if (d[i] > mxv) mxv = d[i];
                ssd.push(sd[i]); ys.push(d[i]);
            }
            var lvl = _median(ys), mu = su / nn, Sxx = suu - nn * mu * mu, Sxy = suy - mu * sy;
            return { n: nn, level: lvl, slope: (Sxx > 0 ? Sxy / Sxx : 0) / lvl, band: Math.max(Math.abs(mxv / lvl - 1), Math.abs(mn / lvl - 1)),
                     sdMed: _median(ssd), span: (X[ib] - X[ia]) / LN10 };
        }
        function finish(ia, ib, forced, widened, extra) {
            var ws = windowStats(ia, ib), lvl = ws.level;
            var se = _seSlope(X, sd, ia, ib, Lcyc) / lvl;
            // last 0.5 cycle of the window
            var il = ib;
            while (il > ia && (X[ib] - X[il - 1]) / LN10 <= D.goodCycles * 0.5 + 1e-9) il--;
            var wl = windowStats(il, ib), seL = (ib - il >= 2) ? _seSlope(X, sd, il, ib, Lcyc) / wl.level : Infinity;
            var fixedPass = _rRatio(ws.band) <= D.band && _rSlope(Math.abs(ws.slope)) <= D.slope;
            var span = ws.span, grade;
            var good = fixedPass && _rSpan(span) >= D.goodCycles && _rSlope(Math.abs(wl.slope)) <= D.goodSlope && _rSlope(seL) <= D.goodSE;
            if (good) grade = 'good';
            else if (_rSpan(span) >= D.minCycles) grade = 'fair';
            else grade = forced ? 'fair' : 'none';
            var noiseWidened = !fixedPass && !forced;
            var noiseLimited = grade !== 'good' && (noiseWidened || (fixedPass && _rSpan(span) >= D.goodCycles &&
                               _rSlope(Math.abs(wl.slope)) <= D.goodSlope && _rSlope(seL) > D.goodSE));
            var kk = kOf(lvl), ps = [];
            for (var i = ia; i <= ib; i++) {
                ps.push(0.5 * (b.dp[i] / lvl - Math.log(kk * b.dte[i] / (w.phi * w.mu * w.ct * w.rw * w.rw)) + 7.4316));
            }
            var pMin = Math.min.apply(null, ps), pMax = Math.max.apply(null, ps);
            var bandTol = Math.min(D.bandCap, Math.max(D.band, 3 * ws.sdMed / lvl));
            var slopeTol = Math.min(D.slopeCap, Math.max(D.slope, 2 * se));
            return Object.assign({
                found: true, grade: grade, noiseWidened: noiseWidened, status: 'ok',
                dt0_h: b.dt[ia], dt1_h: b.dt[ib], X0: X[ia] / LN10, X1: X[ib] / LN10, cycles: span, level_psi: lvl,
                slope: ws.slope, slopeSE: _fin(se), slopeLast: wl.slope, slopeLastSE: _num(seL) ? seL : null,
                band: forced ? D.band : (fixedPass ? D.band : bandTol), slopeTol: forced ? D.slope : (fixedPass ? D.slope : slopeTol),
                noiseLimited: !!noiseLimited, pointSkin: { spread: pMax - pMin, min: pMin, max: pMax },
                longest: null, secondLevel: null, laterPlateaus: [], forced: !!forced,
                reason: '', ev: ['I1', 'I2', 'I3', 'I4'], _a: ia, _b: ib, _a0: a0, _lastFull: lastFull, _fixedPass: fixedPass
            }, extra || {});
        }

        // Forced window (engineer override)
        if (opts.window && _pos(opts.window.dt0_h) && _pos(opts.window.dt1_h)) {
            var fa = -1, fb = -1;
            for (var fi = 0; fi < n; fi++) {
                if (!full[fi] || !(d[fi] > 0)) continue;
                if (b.dt[fi] >= opts.window.dt0_h * (1 - 1e-9) && b.dt[fi] <= opts.window.dt1_h * (1 + 1e-9)) { if (fa < 0) fa = fi; fb = fi; }
            }
            if (fa < 0 || fb - fa < 2) return _iarfNone(prep, D, 'The forced window holds fewer than 3 full-window derivative points.', 'expectedNotFound', { forced: true });
            var fr = finish(fa, fb, true, false);
            fr.reason = _txt('Window set by the engineer (override): ' + _fmt(fr.dt0_h) + '–' + _fmt(fr.dt1_h) + ' h.');
            return fr;
        }

        // Candidate positions: full bins from the gate on
        var P = [];
        for (var pi = a0; pi < n; pi++) if (full[pi]) P.push(pi);
        var m = P.length;
        var lateLvl = (function () {
            var v = [];
            for (var i = 0; i < n; i++) if (full[i] && d[i] > 0 && X[i] >= X[lastFull] - LN10) v.push(d[i]);
            return _median(v);
        })();
        var lateSd = (function () {
            var v = [];
            for (var i = 0; i < n; i++) if (full[i] && X[i] >= X[lastFull] - LN10) v.push(sd[i]);
            return _median(v);
        })();
        if (m < 3) {
            return _iarfNone(prep, D, 'No IARF: too few full-window derivative points after the storage hump.', opts.reachFair && prep.dteEnd < opts.reachFair ? 'tooShort' : 'expectedNotFound');
        }
        var u = P.map(function (i) { return X[i]; }), y = P.map(function (i) { return d[i]; }), sP = P.map(function (i) { return sd[i]; });
        var Su = [0], Suu = [0], Sy = [0], Suy = [0], Syy = [0], Ss = [0];
        for (var j = 0; j < m; j++) {
            Su.push(Su[j] + u[j]); Suu.push(Suu[j] + u[j] * u[j]); Sy.push(Sy[j] + y[j]); Suy.push(Suy[j] + u[j] * y[j]);
            Syy.push(Syy[j] + y[j] * y[j]); Ss.push(Ss[j] + sP[j]);
        }
        var minQ = _sparse(y, Math.min), maxQ = _sparse(y, Math.max);
        var sdMinQ = _sparse(sP, Math.min);
        function valleyAt(c) {   // centre bin is a local minimum ≥ 15 % below both sides within 0.5 cycle
            var i = P[c], maxL = -Infinity, maxR = -Infinity;
            for (var k = i - 1; k >= 0 && (X[i] - X[k]) / LN10 <= 0.5; k--) if (full[k] && d[k] > maxL) maxL = d[k];
            for (var k2 = i + 1; k2 < n && (X[k2] - X[i]) / LN10 <= 0.5; k2++) if (full[k2] && d[k2] > maxR) maxR = d[k2];
            var locMin = (c === 0 || y[c] <= y[c - 1]) && (c === m - 1 || y[c] <= y[c + 1]);
            return locMin && d[i] <= (1 - D.valleyDepth) * maxL && d[i] <= (1 - D.valleyDepth) * maxR;
        }
        var wins = [], noiseBlocked = false;
        function ins(arr, v) { var lo = 0, hi = arr.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; } arr.splice(lo, 0, v); }
        for (var a = 0; a < m; a++) {
            var sorted = [y[a]];
            if (a + 1 < m) ins(sorted, y[a + 1]);
            for (var bb = a + 2; bb < m; bb++) {
                ins(sorted, y[bb]);
                var span = (u[bb] - u[a]) / LN10;
                if (_rSpan(span) < D.minCycles) continue;
                var nn = bb - a + 1;
                // window level ℓ: the median derivative (robust to a U-shaped hump-tail + boundary segment)
                var sy = Sy[bb + 1] - Sy[a], hm = nn >> 1, lvl = (nn % 2) ? sorted[hm] : 0.5 * (sorted[hm - 1] + sorted[hm]);
                if (!(lvl > 0)) continue;
                var mn = minQ(a, bb), mxv = maxQ(a, bb);
                if (!(mn > 0)) continue;
                var band = Math.max(mxv / lvl - 1, 1 - mn / lvl);
                var sdMean = (Ss[bb + 1] - Ss[a]) / nn;
                var bandTol = Math.min(D.bandCap, Math.max(D.band, 3 * sdMean / lvl));
                if (_rRatio(band) > bandTol) {
                    if (3 * sdMean / lvl > D.bandCap && _rRatio(band) <= 3 * sdMean / lvl) noiseBlocked = true;
                    continue;
                }
                var su = Su[bb + 1] - Su[a], mu = su / nn, Sxx = (Suu[bb + 1] - Suu[a]) - nn * mu * mu;
                var sl = ((Suy[bb + 1] - Suy[a]) - mu * sy) / Sxx / lvl;
                var asl = _rSlope(Math.abs(sl));
                var fixed = _rRatio(band) <= D.band && asl <= D.slope;
                if (!fixed) {
                    if (asl > D.slopeCap && !(2 * sdMinQ(a, bb) / lvl > D.slopeCap)) continue;
                    var se = _seSlope(u, sP, a, bb, Lcyc) / lvl;
                    var slopeTol = Math.min(D.slopeCap, Math.max(D.slope, 2 * se));
                    if (asl > slopeTol) { if (2 * se > D.slopeCap) noiseBlocked = true; continue; }
                }
                // valley guard
                var cX = 0.5 * (u[a] + u[bb]), c = a;
                while (c + 1 <= bb && Math.abs(u[c + 1] - cX) < Math.abs(u[c] - cX)) c++;
                if (valleyAt(c)) continue;
                var ssq = (Syy[bb + 1] - Syy[a] - 2 * lvl * sy + nn * lvl * lvl) / (lvl * lvl);
                wins.push({ a: a, b: bb, span: span, level: lvl, rms: Math.sqrt(Math.max(0, ssq) / nn), fixed: fixed });
            }
        }
        if (!wins.length) {
            var tooShort = _pos(opts.reachFair) && prep.dteEnd < opts.reachFair;
            var noiseCase = noiseBlocked || (_pos(lateLvl) && 3 * lateSd / lateLvl > D.bandCap);
            var reason = noiseCase ? 'No IARF window: the derivative noise exceeds the widening caps (noise).'
                       : (tooShort ? 'No IARF: the test is too short for the expected reach.' : 'No IARF: no derivative plateau of at least ' + D.minCycles + ' cycle after the storage hump.');
            return _iarfNone(prep, D, reason, tooShort ? 'tooShort' : 'expectedNotFound', { _a0: a0, _lastFull: lastFull, _noise: noiseCase });
        }
        // Plateau runs: overlapping windows; merge runs with levels within 5 % less than 0.2 cycle apart.
        wins.sort(function (p1, p2) { return p1.a - p2.a || p1.b - p2.b; });
        var runs = [];
        wins.forEach(function (wv) {
            var r = runs[runs.length - 1];
            if (r && wv.a <= r.end) { r.w.push(wv); if (wv.b > r.end) r.end = wv.b; }
            else runs.push({ start: wv.a, end: wv.b, w: [wv] });
        });
        runs.forEach(function (r) {
            r.best = r.w.reduce(function (p1, p2) { return (p2.span > p1.span + 1e-12 || (Math.abs(p2.span - p1.span) <= 1e-12 && p2.rms < p1.rms)) ? p2 : p1; });
            r.level = r.best.level;
        });
        var merged = [];
        runs.forEach(function (r) {
            var pr = merged[merged.length - 1];
            if (pr && Math.abs(r.level / pr.level - 1) <= D.mergeLevel && (u[r.start] - u[pr.end]) / LN10 < D.mergeGap) {
                pr.w = pr.w.concat(r.w); pr.end = Math.max(pr.end, r.end);
                pr.best = pr.w.reduce(function (p1, p2) { return (p2.span > p1.span + 1e-12 || (Math.abs(p2.span - p1.span) <= 1e-12 && p2.rms < p1.rms)) ? p2 : p1; });
                pr.level = pr.best.level;
            } else merged.push(r);
        });
        var chosen = merged[0].best;
        var longestAll = wins.reduce(function (p1, p2) { return p2.span > p1.span + 1e-12 ? p2 : p1; });
        var res = finish(P[chosen.a], P[chosen.b], false, !chosen.fixed);
        res.longest = { dt0_h: b.dt[P[longestAll.a]], dt1_h: b.dt[P[longestAll.b]], cycles: longestAll.span };
        res.laterPlateaus = merged.slice(1).map(function (r) { return { dt0_h: b.dt[P[r.best.a]], dt1_h: b.dt[P[r.best.b]], level_psi: r.best.level }; });
        // Second level (I6): disjoint window ≥ 0.3 cycle, ±10 %, |s| ≤ 0.05, ℓ2/ℓ outside [0.8, 1.25]
        var best2 = null;
        for (var a2 = 0; a2 < m; a2++) {
            for (var b2 = a2 + 2; b2 < m; b2++) {
                if (!(b2 < chosen.a || a2 > chosen.b)) continue;
                var sp2 = (u[b2] - u[a2]) / LN10;
                if (_rSpan(sp2) < 0.3) continue;
                var n2 = b2 - a2 + 1, l2 = (Sy[b2 + 1] - Sy[a2]) / n2;
                if (!(l2 > 0)) continue;
                var mn2 = minQ(a2, b2), mx2 = maxQ(a2, b2);
                if (_rRatio(Math.max(mx2 / l2 - 1, 1 - mn2 / l2)) > 0.10) continue;
                var mu2 = (Su[b2 + 1] - Su[a2]) / n2, Sxx2 = (Suu[b2 + 1] - Suu[a2]) - n2 * mu2 * mu2;
                var s2 = ((Suy[b2 + 1] - Suy[a2]) - mu2 * (Sy[b2 + 1] - Sy[a2])) / Sxx2 / l2;
                if (_rSlope(Math.abs(s2)) > 0.05) continue;
                var ratio = _rRatio(l2 / res.level_psi);
                if (ratio >= DEFAULTS.trig.level[0] && ratio <= DEFAULTS.trig.level[1]) continue;
                if (!best2 || sp2 > best2.span + 1e-12) best2 = { a: a2, b: b2, span: sp2, level: l2 };
            }
        }
        if (best2) res.secondLevel = { dt0_h: b.dt[P[best2.a]], dt1_h: b.dt[P[best2.b]], level_psi: best2.level, ratio: best2.level / res.level_psi };
        if (res.secondLevel) res.ev = ['I1', 'I2', 'I3', 'I4', 'I6'];
        var gradeTxt = res.grade === 'good' ? 'Good' : (res.noiseWidened ? 'Fair (noise-widened)' : 'Fair');
        res.reason = _txt(gradeTxt + ' window ' + _fmt(res.dt0_h) + '–' + _fmt(res.dt1_h) + ' h (' + _fmt(res.cycles, 2) + ' cycle): the earliest plateau after the storage hump, longest window inside it' +
            ((longestAll !== chosen) ? '; longest qualifying window ' + _fmt(res.longest.cycles, 2) + ' cycle.' : '.'));
        return res;
    }

    // ─────────────────────────────────────────────────────────────────────
    // line(prep, iarf) — semilog line through the window, shifted lines (L1–L3)
    // ─────────────────────────────────────────────────────────────────────
    function _semilog(prep, dt0, dt1, adata) {
        var fn = G.PRiSM_semilogAnalysis;
        if (typeof fn !== 'function' || !_pos(dt0) || !_pos(dt1) || !(dt1 > dt0)) return null;
        STATS.lines++;
        var w = prep.well;
        var wl = { fluid: w.fluid === 'gas' ? 'oil' : w.fluid, B: w.B, mu: w.mu, h: w.h, phi: w.phi, ct: w.ct, rw: w.rw, q: prep.spec.Dq, tp: adata.tp };
        var r;
        try {
            r = fn(adata, wl, { method: prep.singleRate ? 'horner' : 'superposition', window: { t0: dt0 * (1 - 1e-9), t1: dt1 * (1 + 1e-9) }, L: prep.L_ln });
        } catch (e) { return null; }
        if (!r || !r.ok || !_pos(r.k) || !_num(r.S)) return null;
        return r;
    }
    function _toP(prep, y) { return (prep.gasTable && _num(y)) ? prep.gasTable.pOfPn(y) : y; }
    function line(prep, ir, opts) {
        opts = opts || {};
        if (!ir || !ir.found) return null;
        var r = _semilog(prep, ir.dt0_h, ir.dt1_h, prep.adataLine);
        if (!r) return null;
        var cc = r.crossCheck || {};
        var out = {
            method: prep.singleRate ? 'horner' : 'superposition', k: r.k, kh: r.kh, S: r.S, m: r.m,
            pStar: _fin(_toP(prep, r.pStar)), pStarRange: null, p1hr: _fin(_toP(prep, r.p1hr)), r2: _fin(r.r2),
            dt0_h: ir.dt0_h, dt1_h: ir.dt1_h, n: r.window ? r.window.n : null,
            shifts: [],
            plateauCheck: { khDiffPct: _fin(cc.khDiffPct), dS: _fin(cc.dS), pass: !!cc.pass },
            ev: ['L1', 'L2', 'L3']
        };
        // Shifted lines for S_win: δ = min(0.25, 0.2·span), earlier and later, clipped to [gate, last full bin]
        var span = ir.cycles, delta = Math.min(DEFAULTS.sErr.winShift, DEFAULTS.sErr.winShiftFrac * span);
        var Xg = (ir._a0 != null && ir._a0 < prep.bins.X.length) ? prep.bins.X[ir._a0] / LN10 : ir.X0;
        var Xl = (ir._lastFull != null && ir._lastFull >= 0) ? prep.bins.X[ir._lastFull] / LN10 : ir.X1;
        [-delta, delta].forEach(function (dX) {
            var x0 = ir.X0 + dX, x1 = ir.X1 + dX;
            if (x0 < Xg - 1e-9 || x1 > Xl + 1e-9) return;
            var d0 = prep.time.dtOfDte(Math.pow(10, x0)), d1 = prep.time.dtOfDte(Math.pow(10, x1));
            if (!_pos(d0) || !_pos(d1)) return;
            var rs = _semilog(prep, d0, d1, prep.adataLine);
            if (!rs) return;
            out.shifts.push({ dX: dX, dt0_h: d0, dt1_h: d1, S: rs.S, bS: null });
        });
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Anomaly flags (M7) and triggers (M§A9)
    // ─────────────────────────────────────────────────────────────────────
    function _derivSlopes(prep, halfCyc) {   // OLS log-log slope of Δp′ over ±halfCyc cycle (positive full bins)
        var X = prep.bins.X, d = prep.deriv.deriv, f = prep.deriv.full, n = X.length, out = new Array(n);
        for (var i = 0; i < n; i++) {
            out[i] = null;
            if (!f[i] || !(d[i] > 0)) continue;
            var sx = 0, sy = 0, sxx = 0, sxy = 0, c = 0;
            for (var k = 0; k < n; k++) {
                if (!f[k] || !(d[k] > 0) || Math.abs(X[k] - X[i]) / LN10 > halfCyc + 1e-9) continue;
                var xx = X[k], yy = Math.log(d[k]);
                sx += xx; sy += yy; sxx += xx * xx; sxy += xx * yy; c++;
            }
            if (c < 3) continue;
            var den = c * sxx - sx * sx;
            if (den > 0) out[i] = (c * sxy - sx * sy) / den;
        }
        return out;
    }
    function _runs(prep, pred, minCyc, from, to) {    // runs of bins satisfying pred(i) spanning ≥ minCyc cycle
        var X = prep.bins.X, out = [], st = -1;
        for (var i = from; i <= to + 1; i++) {
            var ok = i <= to && pred(i);
            if (ok && st < 0) st = i;
            if (!ok && st >= 0) {
                if ((X[i - 1] - X[st]) / LN10 >= minCyc - 1e-9) out.push({ i0: st, i1: i - 1 });
                st = -1;
            }
        }
        return out;
    }
    var FLAG_TEXT = {
        valley: 'Derivative valley (dual-porosity or layered behaviour, not modelled).',
        halfLate: 'Late half slope (channel or elongated drainage, not modelled).',
        earlyQuarter: 'Early quarter slope (finite-conductivity fracture, bilinear flow).',
        earlyHalf: 'Early half slope (fracture linear flow).',
        humpDp: 'Pressure hump (phase redistribution in the wellbore); the fit starts after it.',
        steepStorage: 'Storage steeper than unit slope (changing wellbore storage); the fit starts after it.',
        negLate: 'Negative late derivative (interference, depletion or gauge drift).',
        fracHalf: 'Early half slope in the fall-off (injection-induced fracture).'
    };
    var DISTRACTORS = { valley: 1, halfLate: 1, earlyQuarter: 1, earlyHalf: 1, fracHalf: 1 };
    function flagsFor(prep, ir, st) {
        var b = prep.bins, X = b.X, d = prep.deriv.deriv, f = prep.deriv.full, n = X.length, out = [];
        var sl = _derivSlopes(prep, 0.1);
        var a0 = _gateIndex(prep, st), lastFull = -1;
        for (var lf = n - 1; lf >= 0; lf--) if (f[lf]) { lastFull = lf; break; }
        if (lastFull < 0) return out;
        function add(code, i0, i1) { out.push({ code: code, dt0_h: b.dt[i0], dt1_h: b.dt[i1], text: FLAG_TEXT[code] }); }
        var iarfStart = (ir && ir.found) ? ir._a : lastFull;
        // early quarter / half slope between the gate (or the start) and the IARF start
        var eFrom = (st && st._iHump >= 0) ? a0 : 0;
        var half = _runs(prep, function (i) { return sl[i] !== null && sl[i] >= 0.40 && sl[i] <= 0.60; }, 0.3, eFrom, Math.max(eFrom, iarfStart - 1));
        if (half.length) add(prep.sign < 0 ? 'fracHalf' : 'earlyHalf', half[0].i0, half[0].i1);
        var qtr = _runs(prep, function (i) { return sl[i] !== null && sl[i] >= 0.18 && sl[i] <= 0.32; }, 0.3, eFrom, Math.max(eFrom, iarfStart - 1));
        if (qtr.length) add('earlyQuarter', qtr[0].i0, qtr[0].i1);
        // late half slope: the last ≥ 0.2 cycle at slope 0.35–0.65
        var lateH = _runs(prep, function (i) { return sl[i] !== null && sl[i] >= 0.35 && sl[i] <= 0.65; }, 0.2, Math.max(a0, 0), lastFull);
        if (lateH.length && lateH[lateH.length - 1].i1 === lastFull && (!ir || !ir.found || lateH[lateH.length - 1].i0 > ir._b)) add('halfLate', lateH[lateH.length - 1].i0, lastFull);
        // valley: a local minimum ≥ 15 % below both sides within 0.5 cycle that is followed by a
        // plateau (the IARF window starts after it, a later plateau at the IARF level, or — with no
        // IARF — a flat derivative above the dip). A boundary (fault, composite M > 1) has its minimum
        // inside the IARF window, so it is not flagged.
        for (var c = Math.max(a0, 1); c < lastFull; c++) {
            if (!f[c] || !(d[c] > 0)) continue;
            if (!(d[c] <= d[c - 1] && d[c] <= d[c + 1])) continue;
            var maxL = -Infinity, maxR = -Infinity;
            for (var k = c - 1; k >= 0 && (X[c] - X[k]) / LN10 <= 0.5; k--) if (f[k] && d[k] > maxL) maxL = d[k];
            for (var k2 = c + 1; k2 <= lastFull && (X[k2] - X[c]) / LN10 <= 0.5; k2++) if (f[k2] && d[k2] > maxR) maxR = d[k2];
            if (!(d[c] <= 0.85 * maxL && d[c] <= 0.85 * maxR)) continue;
            var after = false;
            if (ir && ir.found) {
                if (c < ir._a) after = true;
                else (ir.laterPlateaus || []).forEach(function (lp) {
                    var rr = lp.level_psi / ir.level_psi;
                    if (lp.dt0_h > b.dt[c] && rr >= 0.8 && rr <= 1.25) after = true;
                });
            } else {
                for (var k3 = c + 1; k3 <= lastFull; k3++) if (f[k3] && sl[k3] !== null && sl[k3] <= 0.1 && d[k3] >= d[c] / 0.85) { after = true; break; }
            }
            if (after) {
                var vi0 = c, vi1 = c;
                while (vi0 > 0 && (X[c] - X[vi0 - 1]) / LN10 <= 0.25) vi0--;
                while (vi1 < lastFull && (X[vi1 + 1] - X[c]) / LN10 <= 0.25) vi1++;
                add('valley', vi0, vi1);
                break;
            }
        }
        // pressure hump: Δp falls by more than max(3σ_b, 0.2 psi, 0.5 %) before rising again
        var pkI = -1;
        for (var h = 1; h < n; h++) {
            if (pkI < 0 || b.dp[h] > b.dp[pkI]) { pkI = h; continue; }
            var drop = b.dp[pkI] - b.dp[h], tol = Math.max(3 * (b.sigma_b[h] || 0), 0.2, 0.005 * b.dp[pkI]);
            if (drop > tol) {
                var hEnd = h;
                while (hEnd < n - 1 && b.dp[hEnd] < b.dp[pkI]) hEnd++;
                add('humpDp', pkI, hEnd);
                break;
            }
        }
        // steep storage: early Δp log-slope > 1.25 over ≥ 3 bins
        var lsp = _localSlopes(X, b.dp), run = 0;
        for (var e = 0; e < Math.min(n, (st && st._iHump >= 0) ? st._iHump : n); e++) {
            if (lsp[e] !== null && lsp[e] > 1.25) { run++; if (run >= 3) { add('steepStorage', e - run + 1, e); break; } }
            else run = 0;
        }
        // negative late derivative: ≥ 2 non-positive full bins in the last 0.5 cycle
        var negs = prep.deriv.neg.filter(function (i) { return (X[lastFull] - X[i]) / LN10 <= 0.5; });
        if (negs.length >= 2) add('negLate', negs[0], negs[negs.length - 1]);
        return out;
    }

    function triggers(prep, ir, rch) {
        var b = prep.bins, X = b.X, d = prep.deriv.deriv, f = prep.deriv.full, n = X.length;
        var T = DEFAULTS.trig, flags = [];
        var lastFull = -1;
        for (var lf = n - 1; lf >= 0; lf--) if (f[lf]) { lastFull = lf; break; }
        var st = (ir && ir._st) || null;
        var lvl = null;
        if (ir && ir.found) lvl = ir.level_psi;
        else {
            var a0 = _gateIndex(prep, st || storage(prep)), mn = Infinity;
            for (var i = a0; i <= lastFull; i++) if (f[i] && d[i] > 0 && d[i] < mn) mn = d[i];
            lvl = mn < Infinity ? mn : null;
        }
        var up = false, down = false;
        if (lvl && lastFull >= 0) {
            var from = lastFull;   // the last ≥ 0.2 cycle of full bins
            while (from > 0 && f[from - 1] && (X[lastFull] - X[from]) / LN10 < T.lateCycles - 1e-9) from--;
            if ((X[lastFull] - X[from]) / LN10 >= T.lateCycles - 1e-9) {
                var allUp = true, allDown = true, xs = [], ys = [];
                for (var k = from; k <= lastFull; k++) {
                    if (!(d[k] > (1 + T.late) * lvl)) allUp = false;
                    if (!(d[k] < (1 - T.late) * lvl)) allDown = false;
                    xs.push(X[k]); ys.push(d[k]);
                }
                var mx = xs.reduce(function (s, v) { return s + v; }, 0) / xs.length, my = ys.reduce(function (s, v) { return s + v; }, 0) / ys.length;
                var sxy = 0, sxx = 0;
                for (var q2 = 0; q2 < xs.length; q2++) { sxy += (xs[q2] - mx) * (ys[q2] - my); sxx += (xs[q2] - mx) * (xs[q2] - mx); }
                var slope = sxx > 0 ? sxy / sxx : 0;
                up = allUp && slope > 0 && !(ir && ir.found && ir._b === lastFull);
                down = allDown && slope < 0 && !(ir && ir.found && ir._b === lastFull);
            }
        }
        var level = !!(ir && ir.secondLevel);
        var none = !(ir && ir.found) && !!(rch && _pos(rch.fair_h) && prep.dteEnd >= rch.fair_h);
        var noneSkipped = !(ir && ir.found) && !none;
        flags = flagsFor(prep, ir, st || storage(prep));
        var fired = [];
        if (up) fired.push('T-up');
        if (down) fired.push('T-down');
        if (level) fired.push('T-level');
        if (none) fired.push('T-none');
        return { triggers: { up: up, down: down, level: level, none: none, noneSkipped: noneSkipped, fired: fired, ev: ['M2'] }, flags: flags, _level: lvl };
    }

    // ─────────────────────────────────────────────────────────────────────
    // gridEntry(key, prep, opts) — registry-like entry on a pd grid (D5)
    // ─────────────────────────────────────────────────────────────────────
    // One grid per parameter set (LRU), on a fixed lattice log10 tD = j/perDecade,
    // holding [pd, pd′] (closed circle: the bounded pd − 2tD/reD² and pd′ − 2tD/reD²,
    // the linear term added analytically). pd is a cubic Hermite in ln tD with
    // the exact pd′; pd′ is a cubic Hermite with central-difference slopes. The
    // first build covers [tD_min/2, 2·tD(t_c − τ_0 + Δt_end)] at the requested
    // time scale; later calls extend the lattice only when a value falls outside.
    var GRID_SPECS = {
        homogeneous: { base: 'homogeneous', category: 'homogeneous', shape: [] },
        linearBoundary: { base: 'linearBoundary', category: 'boundary', shape: [
            { key: 'dF', label: 'Distance to boundary', unit: 'r_w', min: 1, max: 1e7, default: 1000, scale: 'log' },
            { key: 'BC', label: 'Boundary condition', unit: '', options: ['noflow', 'constP'], default: 'noflow' }] },
        composite2: { base: 'radialComposite', category: 'composite', shape: [
            { key: 'M', label: 'Mobility ratio M', unit: '-', min: 0.05, max: 20, default: 1, scale: 'log' },
            { key: 'F', label: 'Storativity ratio F', unit: '-', min: 0.05, max: 20, default: 1, scale: 'log' },
            { key: 'R', label: 'Inner-zone radius R/rw', unit: '-', min: 1.5, max: 1e7, default: 1000, scale: 'log' }] },
        closedCircle: { base: 'closedCircle', category: 'boundary', shape: [
            { key: 'reD', label: 'r_e / r_w', unit: '-', min: 50, max: 1e7, default: 5000, scale: 'log' }] }
    };
    var GRID_LABEL = { homogeneous: 'Homogeneous', linearBoundary: 'Sealing fault', composite2: 'Radial composite', closedCircle: 'Closed circle' };

    // Reservoir values p̄(s) (no WBS / skin) at the lattice Stehfest abscissae s = i·ln2/10^(j/per),
    // i = 1…12. They depend on the model's shape parameters and distance scale only, not on C_D or
    // S, so a C_D, S or k step of a fit re-folds stored values instead of evaluating Bessel functions
    // again (the same numbers either way: speed only). Bounded LRU shared by every grid entry.
    var RESV_MAX = 48, _RESV = [];
    function _resvEntry(rk, key, p, dS, per) {
        for (var c = 0; c < _RESV.length; c++) {
            if (_RESV[c].rk === rk) { var E = _RESV[c]; if (c) { _RESV.splice(c, 1); _RESV.unshift(E); } return E; }
        }
        var E2 = { rk: rk, lap: _lapFor(key, p), dS: dS, per: per, m: new Map() };
        _RESV.unshift(E2);
        if (_RESV.length > RESV_MAX) _RESV.pop();
        return E2;
    }
    function _resvVals(R, j) {
        var v = R.m.get(j);
        if (v) return v;
        STATS.resvPoints++;
        v = new Float64Array(12);
        var a = LN2 / Math.pow(10, j / R.per);
        for (var i = 1; i <= 12; i++) v[i - 1] = R.lap(i * a, R.dS, true);
        R.m.set(j, v);
        return v;
    }

    function _hRange(prep) {
        var hMin = Math.min(prep.fitSet.dt[0], prep.bins.dt[0]) / 2;
        var st = prep.histFit.steps, tau0 = st.length ? st[0].t : prep.spec.tc_h - prep.tpEff;
        var hMax = 2 * (prep.spec.tc_h - tau0 + prep.dtEnd);
        return { hMin: hMin, hMax: Math.max(hMax, 4 * hMin) };
    }
    function gridEntry(key, prep, opts) {
        opts = opts || {};
        var G0 = GRID_SPECS[key];
        if (!G0) throw new Error('PRiSM_autoInterp.gridEntry: unknown key ' + key);
        var per = _pos(opts.perDecade) ? opts.perDecade : DEFAULTS.budget.perDecade;
        var H = LN10 / per;
        var hr = _hRange(prep);
        var spanJ = Math.ceil(Math.log10(hr.hMax / hr.hMin) * per) + 4;
        var cache = [];
        var shapeKeys = G0.shape.filter(function (s) { return !s.options; }).map(function (s) { return s.key; });
        function pkey(p) {
            var s = String(p.Cd) + '|' + String(p.S);
            for (var i = 0; i < shapeKeys.length; i++) s += '|' + String(p[shapeKeys[i]]);
            if (key === 'linearBoundary') s += '|' + (p.BC === 'constP' ? 'c' : 'n');
            return s;
        }
        function norm(p) {
            p = p || {};
            var o = { Cd: _num(p.Cd) ? Math.max(0, p.Cd) : 100, S: _num(p.S) ? p.S : 0 };
            G0.shape.forEach(function (s) { o[s.key] = (p[s.key] !== undefined && p[s.key] !== null && p[s.key] !== '') ? p[s.key] : s.default; });
            if (key === 'composite2' && !_pos(o.F)) o.F = 1;
            return o;
        }
        function linK(p) { return key === 'closedCircle' ? 2 / (p.reD * p.reD) : 0; }
        // S ≥ 0: the lattice is in t_D. S < 0: it is in the effective time t_D·e^{2S} (effective
        // radius r_w·e^{−S}, C_D·e^{2S}, distances ×e^{S}, S = 0; the transform of PRiSM_evalWbsSkin),
        // so the Stehfest abscissae stay on the lattice and the reservoir values are shared.
        function foldOf(p) {
            var C = (p.Cd > 0) ? p.Cd : 0, SS = p.S || 0, f = { C: C, S: SS, e2: 1, dS: 1, neg: false };
            if (SS < 0) { f.e2 = Math.exp(2 * SS); f.C = C * f.e2; f.dS = Math.exp(SS); f.S = 0; f.neg = true; }
            return f;
        }
        function resvKey(p, f) {
            var s = key + '|' + per;
            for (var i = 0; i < shapeKeys.length; i++) s += '|' + String(p[shapeKeys[i]]);
            if (key === 'linearBoundary') s += '|' + (p.BC === 'constP' ? 'c' : 'n');
            if (key !== 'homogeneous') s += '|' + String(f.dS);   // the homogeneous kernel has no distance
            return s;
        }
        function evalPoint(E, j) {
            var tt = Math.pow(10, j / per), td = E.f.neg ? tt / E.f.e2 : tt, lk = E.lk * td;
            var C = E.f.C, SS = E.f.S;
            if (C > 0 && tt < Math.min(1e-3 * C, 1e-12 * C * C)) return [tt / C - lk, tt / C - lk];
            var R = _resvVals(E.rv, j), W = _stehW(), a = LN2 / tt, accP = 0, accD = 0;
            for (var i = 1; i <= 12; i++) {
                var s = i * a, inner = s * R[i - 1] + SS;
                var F = inner / (s * (1 + C * s * inner));
                accP += W[i - 1] * F; accD += W[i - 1] * s * F;
            }
            STATS.kernelEvals++;
            return [a * accP - lk, tt * a * accD - lk];
        }
        function getGrid(p, jlo, jhi, f) {
            var k = pkey(p), E = null;
            for (var c = 0; c < cache.length; c++) if (cache[c].k === k) { E = cache[c]; if (c) { cache.splice(c, 1); cache.unshift(E); } break; }
            if (!E) {
                STATS.gridBuilds++;
                var j1 = jhi, j0 = Math.min(jlo, jhi - spanJ);
                E = { k: k, p: p, f: f, lk: linK(p), rv: _resvEntry(resvKey(p, f), key, p, f.dS, per), j0: j0, j1: j0 - 1, g: [], gp: [] };
                cache.unshift(E);
                if (cache.length > 12) cache.pop();
                extend(E, j0, j1);
                return E;
            }
            if (jlo < E.j0 || jhi > E.j1) extend(E, jlo, jhi);
            return E;
        }
        function extend(E, jlo, jhi) {
            var i;
            if (E.j1 < E.j0) {   // empty
                for (i = jlo; i <= jhi; i++) { var v = evalPoint(E, i); E.g.push(v[0]); E.gp.push(v[1]); }
                E.j0 = jlo; E.j1 = jhi; return;
            }
            if (jlo < E.j0) {
                var pre = [], preD = [];
                for (i = jlo; i < E.j0; i++) { var v1 = evalPoint(E, i); pre.push(v1[0]); preD.push(v1[1]); }
                E.g = pre.concat(E.g); E.gp = preD.concat(E.gp); E.j0 = jlo;
            }
            if (jhi > E.j1) {
                for (i = E.j1 + 1; i <= jhi; i++) { var v2 = evalPoint(E, i); E.g.push(v2[0]); E.gp.push(v2[1]); }
                E.j1 = jhi;
            }
        }
        function run(td, params, deriv) {
            var arr = (Array.isArray(td) || (td && typeof td.length === 'number' && typeof td !== 'string'));
            var tdA = arr ? td : [td];
            var p = norm(params), lo = Infinity, hi = -Infinity, i;
            for (i = 0; i < tdA.length; i++) { var t = tdA[i]; if (t > 0) { if (t < lo) lo = t; if (t > hi) hi = t; } }
            var out = new Array(tdA.length);
            if (!(hi > 0)) { for (i = 0; i < tdA.length; i++) out[i] = 0; return arr ? out : out[0]; }
            var f = foldOf(p), e2 = f.e2;
            var jlo = Math.floor(Math.log10(lo * e2) * per) - 2, jhi = Math.ceil(Math.log10(hi * e2) * per) + 2;
            var E = getGrid(p, jlo, jhi, f), lk = E.lk;
            for (i = 0; i < tdA.length; i++) {
                var tt = tdA[i];
                if (!(tt > 0)) { out[i] = 0; continue; }
                var u = Math.log10(f.neg ? tt * e2 : tt) * per, jf = Math.floor(u), tau = u - jf, ix = jf - E.j0;
                if (ix < 1) { ix = 1; tau = 0; } if (ix > E.g.length - 3) { ix = E.g.length - 3; tau = 1; }
                var t2 = tau * tau, t3 = t2 * tau;
                var h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + tau, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
                var v;
                if (!deriv) v = h00 * E.g[ix] + h10 * H * E.gp[ix] + h01 * E.g[ix + 1] + h11 * H * E.gp[ix + 1];
                else {
                    var s0 = (E.gp[ix + 1] - E.gp[ix - 1]) / 2, s1 = (E.gp[ix + 2] - E.gp[ix]) / 2;
                    v = h00 * E.gp[ix] + h10 * s0 + h01 * E.gp[ix + 1] + h11 * s1;
                }
                out[i] = v + lk * tt;
            }
            return arr ? out : out[0];
        }
        var spec = [
            { key: 'Cd', label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S', label: 'Skin S', unit: '-', min: -7, max: 50, default: 0 }
        ].concat(G0.shape.map(function (s) { return _copy(s); }));
        var defaults = { Cd: 100, S: 0 };
        G0.shape.forEach(function (s) { defaults[s.key] = s.default; });
        return {
            key: key, base: G0.base, name: GRID_LABEL[key],
            pd: function (td, params) { return run(td, params, false); },
            pdPrime: function (td, params) { return run(td, params, true); },
            paramSpec: spec, defaults: defaults, refLength: 'rw', kind: 'pressure', timeInput: 'td', defaultFrozen: [],
            category: G0.category, description: GRID_LABEL[key] + ' (automatic-interpretation pd grid).',
            reference: 'Plan §4.6 grid form', evalCostMs: DEFAULTS.budget.costMs[key].pos,
            gridPoints: function () { return Math.ceil(Math.log10(hr.hMax / hr.hMin) * per) + 1; },
            _cacheSize: function () { return cache.length; }
        };
    }

    // Slicing rule (§4.8): evalsPerSlice = clamp(floor(unitMs / evalCost), nFree + 1, 24),
    // evalCost = costMs[key][sign of S] × gridPoints / 60 — static, never a clock.
    function evalsPerSlice(key, S, nGrid, nFree) {
        var B = DEFAULTS.budget, c = B.costMs[key] || B.costMs.homogeneous;
        var cost = (S < 0 ? c.neg : c.pos) * nGrid / 60;
        return _clamp(Math.floor(B.unitMs / cost), nFree + 1, B.evalsMax);
    }

    // ─────────────────────────────────────────────────────────────────────
    // fitJob / fit — sliced PRiSM_fitPhysical through a grid entry
    // ─────────────────────────────────────────────────────────────────────
    function _pmFor(key, prep, entry) {
        if (typeof G.PRiSM_physicalModel !== 'function') return null;
        try {
            var pm = G.PRiSM_physicalModel(key, prep.well, prep.adata, { entry: entry, isolated: true, mode: 'physical' });
            return (pm && pm.ok) ? pm : null;
        } catch (e) { return null; }
    }
    function _fitPoints(prep, win) {
        var t = prep.adata.t, dp = prep.adata.dp, idx = [];
        var tmin = (win && _num(win.tmin)) ? win.tmin : -Infinity, tmax = (win && _num(win.tmax)) ? win.tmax : Infinity;
        for (var i = 0; i < t.length; i++) if (t[i] >= tmin && t[i] <= tmax && dp[i] > 0) idx.push(i);
        return idx;
    }
    // log-Δp block: residuals, floor, Jacobian standard errors (raw: inflated once by bic()).
    function _logBlock(key, prep, entry, phys, freeKeys, win) {
        var pm = _pmFor(key, prep, entry);
        var idx = _fitPoints(prep, win), n = idx.length;
        var t = idx.map(function (i) { return prep.adata.t[i]; });
        var yd = idx.map(function (i) { return Math.log(prep.adata.dp[i]); });
        var out = { n: n, res: null, ssr: null, floor: 0, se: {}, corr: { CS: null, kS: null }, ok: false, dpModel: null };
        idx.forEach(function (i) {
            var sb = prep.fitSet.sigma_b[i] || 0, dpi = prep.adata.dp[i];
            out.floor += (sb / dpi) * (sb / dpi) + DEFAULTS.bic.logFloor * DEFAULTS.bic.logFloor;
        });
        if (!pm || n < 3) return out;
        function lnModel(ph) {
            STATS.evals++;
            var dm = pm.dp(t, ph);
            return dm.map(function (v) { return v > 0 ? Math.log(v) : NaN; });
        }
        var base = lnModel(phys);
        out.dpModel = base.map(Math.exp);
        var res = base.map(function (v, i) { return _num(v) ? yd[i] - v : 3; });
        out.res = res;
        out.ssr = res.reduce(function (s, v) { return s + v * v; }, 0);
        var p = freeKeys.length;
        if (!p || n <= p) { out.ok = true; return out; }
        var isLog = function (k) { var sp = pm.spec[k]; return !!(sp && sp.scale === 'log'); };
        var J = [];
        for (var a = 0; a < p; a++) {
            var kk = freeKeys[a], ph2 = _copy(phys), h;
            if (isLog(kk)) { h = 1e-4; ph2[kk] = phys[kk] * Math.pow(10, h); }
            else { h = 1e-4 * Math.max(1, Math.abs(phys[kk])); ph2[kk] = phys[kk] + h; }
            var y2 = lnModel(ph2);
            J.push(y2.map(function (v, i) { return _num(v) && _num(base[i]) ? (v - base[i]) / h : 0; }));
        }
        var A = [];
        for (var r = 0; r < p; r++) { A.push([]); for (var c = 0; c < p; c++) { var s = 0; for (var i2 = 0; i2 < n; i2++) s += J[r][i2] * J[c][i2]; A[r].push(s); } }
        var inv = _invert(A);
        if (!inv) return out;
        // σ² from the block's own residuals (the floor belongs to BIC only): noise-free data give se → 0.
        var s2 = out.ssr / Math.max(1, n - p);
        var seInt = freeKeys.map(function (k, i3) { return inv[i3][i3] > 0 ? Math.sqrt(s2 * inv[i3][i3]) : NaN; });
        freeKeys.forEach(function (k, i4) {
            out.se[k] = isLog(k) ? phys[k] * LN10 * seInt[i4] : seInt[i4];
        });
        function corrOf(k1, k2) {
            var i1 = freeKeys.indexOf(k1), j1 = freeKeys.indexOf(k2);
            if (i1 < 0 || j1 < 0) return null;
            var den = Math.sqrt(inv[i1][i1] * inv[j1][j1]);
            return den > 0 ? inv[i1][j1] / den : null;
        }
        out.corr = { CS: corrOf('C', 'S'), kS: corrOf('k', 'S') };
        out.corrMax = 0;
        for (var u = 0; u < p; u++) for (var v = u + 1; v < p; v++) {
            var dd = Math.sqrt(inv[u][u] * inv[v][v]);
            if (dd > 0) out.corrMax = Math.max(out.corrMax, Math.abs(inv[u][v] / dd));
        }
        out.ok = true;
        return out;
    }
    function _invert(A) {
        var n = A.length, M = A.map(function (r, i) { var e = new Array(n).fill(0); e[i] = 1; return r.slice().concat(e); });
        for (var c = 0; c < n; c++) {
            var piv = c;
            for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            if (!(Math.abs(M[piv][c]) > 1e-300)) return null;
            var t = M[c]; M[c] = M[piv]; M[piv] = t;
            var d = M[c][c];
            for (var k = 0; k < 2 * n; k++) M[c][k] /= d;
            for (var r2 = 0; r2 < n; r2++) {
                if (r2 === c) continue;
                var f = M[r2][c];
                if (f === 0) continue;
                for (var k2 = 0; k2 < 2 * n; k2++) M[r2][k2] -= f * M[c][k2];
            }
        }
        return M.map(function (r) { return r.slice(n); });
    }

    var FS_NA = { status: 'n/a', value: null, bound: null, text: 'Homogeneous model: no boundary to see.' };
    function _distanceFt(key, params, rw) {
        var o = {};
        if (key === 'linearBoundary' && _pos(params.dF)) o.dF_ft = params.dF * rw;
        if (key === 'composite2' && _pos(params.R)) o.R_ft = params.R * rw;
        if (key === 'closedCircle' && _pos(params.reD)) o.re_ft = params.reD * rw;
        return o;
    }
    function _buildModelFit(key, prep, entry, fr, meta) {
        var rw = prep.well.rw;
        var ph = fr.phys || {};
        var phys = { k: _fin(ph.k), S: _fin(ph.S), C: _fin(ph.C) };
        var shapeOut = {};
        GRID_SPECS[key].shape.forEach(function (s) { if (!s.options && _num(ph[s.key])) shapeOut[s.key] = ph[s.key]; });
        if (key === 'composite2') { phys.M = _fin(shapeOut.M); phys.F = _num(shapeOut.F) ? shapeOut.F : 1; }
        var dist = _distanceFt(key, shapeOut, rw);
        Object.keys(dist).forEach(function (k) { phys[k] = dist[k]; });
        var params = {};
        Object.keys(fr.params || {}).forEach(function (k) { var v = fr.params[k]; if (_num(v) || typeof v === 'string' || typeof v === 'boolean') params[k] = v; });
        var freeKeys = (fr.fitKeys || []).filter(function (k) { return (fr.frozen || []).indexOf(k) < 0 && _num(ph[k]); });
        var physForPm = {};
        (fr.fitKeys || []).forEach(function (k) { if (_num(ph[k])) physForPm[k] = ph[k]; });
        if (key === 'linearBoundary' && params.BC) physForPm.BC = params.BC;
        var lb = _logBlock(key, prep, entry, physForPm, [], meta.window);
        // Standard errors and correlations from the fit's own final Jacobian (Δp and derivative
        // blocks as fitted): the Δp block alone leaves k and S nearly collinear. bic() inflates
        // them once by √(n/n_eff).
        var se = { k: null, S: null, C: null }, ci = { k: null, S: null, C: null };
        freeKeys.forEach(function (k) { if (fr.stderr && _num(fr.stderr[k])) se[k] = Math.abs(fr.stderr[k]); });
        var ck = fr.corrKeys || [], cm = fr.corr || null;
        function corrOf(a, b2) {
            var i = ck.indexOf(a), j = ck.indexOf(b2);
            return (cm && i >= 0 && j >= 0 && cm[i] && _num(cm[i][j])) ? cm[i][j] : null;
        }
        lb.corr = { CS: corrOf('C', 'S'), kS: corrOf('k', 'S') };
        lb.corrMax = 0;
        if (cm) for (var ci1 = 0; ci1 < ck.length; ci1++) for (var cj1 = ci1 + 1; cj1 < ck.length; cj1++) if (cm[ci1] && _num(cm[ci1][cj1])) lb.corrMax = Math.max(lb.corrMax, Math.abs(cm[ci1][cj1]));
        // At the round-off floor of a noise-free match the LM can end on 'lambda-max' with the
        // objective settled (no further decrease possible): that is a converged fit.
        var settledMin = !fr.converged && fr.stopReason === 'lambda-max' &&
                         !(fr.stalledAtBound && fr.stalledAtBound.length) && !(_num(fr.r2) && fr.r2 < 0.9);
        return {
            key: key, base: entry.base, ok: !!fr.ok, converged: !!fr.converged || !!settledMin,
            stopReason: String(fr.stopReason || '') + (settledMin ? ' (settled)' : ''),
            iterations: meta.iterations, slices: meta.slices, nEval: meta.nEval,
            phys: phys, params: params, se: se, ci95: ci, corr: { CS: _fin(lb.corr.CS), kS: _fin(lb.corr.kS) },
            ssrLog: _fin(lb.ssr), nDp: lb.n, rmseDp: _fin(fr.rmse), bic: null, p: freeKeys.length, eligible: key === 'homogeneous', why: [],
            fullySeen: key === 'homogeneous' ? _copy(FS_NA) : { status: 'not', value: null, bound: null, text: 'Not assessed.' },
            evalsPerSlice: meta.evalsPerSlice, gridPoints: meta.gridPoints,
            _res: lb.res, _floor: lb.floor, _corrMax: lb.corrMax || 0, _fr: fr, _freeKeys: freeKeys, _physPm: physForPm, _entry: entry,
            _atBound: _atBounds(fr, entry, freeKeys), _dpModel: lb.dpModel, _window: meta.window || null
        };
    }
    function _atBounds(fr, entry, freeKeys) {   // parameters within 1 % (of the log / linear range) of a bound
        var out = [], ph = fr.phys || {};
        var pmSpec = { k: { min: 1e-4, max: 1e5, scale: 'log' }, C: { min: 1e-7, max: 10, scale: 'log' }, S: { min: -7, max: 50 } };
        (entry.paramSpec || []).forEach(function (s) { if (s.key !== 'Cd' && s.key !== 'S' && !s.options) pmSpec[s.key] = s; });
        freeKeys.forEach(function (k) {
            var sp = pmSpec[k], v = ph[k];
            if (!sp || !_num(v)) return;
            if (sp.scale === 'log' && v > 0 && sp.min > 0) {
                var rng = Math.log10(sp.max / sp.min);
                if (Math.log10(v / sp.min) < 0.01 * rng || Math.log10(sp.max / v) < 0.01 * rng) out.push(k);
            } else if (_num(sp.min) && _num(sp.max)) {
                var r2 = sp.max - sp.min;
                if (v - sp.min < 0.01 * r2 || sp.max - v < 0.01 * r2) out.push(k);
            }
        });
        return out;
    }
    function _failFit(key, entry, reason, meta) {
        return {
            key: key, base: entry ? entry.base : key, ok: false, converged: false, stopReason: 'failed', iterations: meta ? meta.iterations : 0,
            slices: meta ? meta.slices : 0, nEval: meta ? meta.nEval : 0, phys: { k: null, S: null, C: null }, params: {},
            se: { k: null, S: null, C: null }, ci95: { k: null, S: null, C: null }, corr: { CS: null, kS: null }, ssrLog: null, nDp: 0,
            rmseDp: null, bic: null, p: 0, eligible: false, why: [_txt(reason)], fullySeen: key === 'homogeneous' ? _copy(FS_NA) : { status: 'not', value: null, bound: null, text: 'Fit failed.' }
        };
    }
    function _betterFit(a, b) {   // converged preferred within 0.1 %, then lower objective
        if (!a || !a.ok) return b;
        if (!b || !b.ok) return a;
        var oa = a._fr.objectiveValue, ob = b._fr.objectiveValue, tol = 1e-3 * Math.max(oa, ob);
        if (a.converged && !b.converged && oa <= ob + tol) return a;
        if (b.converged && !a.converged && ob <= oa + tol) return b;
        return ob < oa ? b : a;
    }
    function fitJob(key, prep, opts) {
        opts = opts || {};
        var entry = opts.entry || gridEntry(key, prep);
        var maxIt = _pos(opts.maxIterTotal) ? opts.maxIterTotal : DEFAULTS.budget.maxIterTotal;
        var start = _copy(opts.start || {});
        var freeze = _copy(opts.freeze || {});
        var nFree = 3 + GRID_SPECS[key].shape.filter(function (s) { return !s.options; }).length - Object.keys(freeze).filter(function (k) { return freeze[k]; }).length;
        var nGrid = entry.gridPoints();
        var eps = evalsPerSlice(key, _num(start.S) ? start.S : 0, nGrid, Math.max(1, nFree));
        var state = { phase: 'run', lm: null, it: 0, nEval: 0, slices: 0, retried: false, result: null, best: null, cancelled: false, start: start };
        var label = 'Fit ' + (GRID_LABEL[key] || key);
        function fpOpts(extra) {
            var o = { entry: entry, isolated: true, mode: 'physical', dataset: { t: [], p: [] }, singleStart: true, start: state.start,
                      freeze: freeze, objective: opts.objective === 'dp' ? 'dp' : 'dp+deriv', window: opts.window || undefined };
            if (opts.params0) o.params0 = opts.params0;
            return Object.assign(o, extra);
        }
        function finishWith(fr) {
            var meta = { iterations: state.it, slices: state.slices, nEval: state.nEval, evalsPerSlice: eps, gridPoints: nGrid, window: opts.window || null };
            var mf = (fr && fr.ok) ? _buildModelFit(key, prep, entry, fr, meta) : _failFit(key, entry, (fr && fr.reason) || 'Fit failed.', meta);
            STATS.fits++;
            state.best = state.best ? _betterFit(state.best, mf) : mf;
            if (!mf.converged && !state.retried && opts.retry !== false && _num(start.S) && !freeze.S) {
                state.retried = true;
                var dir = (mf.ok && _num(mf.phys.S) && mf.phys.S < start.S) ? -2 : 2;
                state.start = _copy(start); state.start.S = _clamp(start.S + dir, -6.5, 49);
                state.lm = null; state.it = 0; state.phase = 'run';
                return false;
            }
            state.result = state.best;
            state.phase = 'done';
            return true;
        }
        return {
            step: function () {
                if (state.phase === 'done' || state.cancelled) return { done: true, progress: 1, label: label };
                if (typeof G.PRiSM_fitPhysical !== 'function') { state.result = _failFit(key, entry, 'PRiSM regression is not loaded.', null); state.phase = 'done'; return { done: true, progress: 1, label: label }; }
                var fr;
                if (state.phase === 'run') {
                    fr = G.PRiSM_fitPhysical(key, prep.adata, prep.well, fpOpts({ evalBudget: eps, lmState: state.lm || undefined, slice: true, maxIter: Math.max(1, maxIt - state.it) }));
                    if (!fr || !fr.ok) { finishWith(fr); return { done: state.phase === 'done', progress: state.phase === 'done' ? 1 : 0.5, label: label }; }
                    state.it += fr.iterations || 0; state.nEval += fr.nEval || 0; state.slices++;
                    STATS.slices++; STATS.lmIters += fr.iterations || 0; STATS.evals += fr.nEval || 0;
                    state.lm = fr.lmState;
                    if (state.lm.done || state.it >= maxIt) {
                        if (!state.lm.done) { state.lm.done = true; state.lm.converged = false; state.lm.stopReason = 'maxIter'; }
                        state.phase = 'final';
                    }
                    return { done: false, progress: Math.min(0.9, state.it / maxIt), label: label };
                }
                // final statistics at the carried parameters (no further iteration)
                fr = G.PRiSM_fitPhysical(key, prep.adata, prep.well, fpOpts({ lmState: state.lm, maxIter: 1 }));
                if (fr && fr.ok) { state.nEval += fr.nEval || 0; STATS.evals += fr.nEval || 0; fr.iterations = state.it; }
                var done = finishWith(fr);
                return { done: done, progress: done ? 1 : 0.5, label: label };
            },
            result: function () { return state.result; },
            cancel: function () { state.cancelled = true; },
            entry: entry, evalsPerSlice: eps
        };
    }
    function _runJob(job) { var s, guard = 0; do { s = job.step(); } while (!s.done && ++guard < 100000); return job.result(); }
    function fit(key, prep, opts) { return _runJob(fitJob(key, prep, opts)); }

    // ─────────────────────────────────────────────────────────────────────
    // reach(prep, homFit) — numeric t_10 %, t_5 % and the IARF reach (W4, item 5b)
    // ─────────────────────────────────────────────────────────────────────
    function _tPct(k, C, S, well, frac) {   // last Δt_e (h) where |Δp′/m′ − 1| > frac (homogeneous drawdown)
        var Cd = C_CD * C / (well.phi * well.ct * well.h * well.rw * well.rw);
        var Bt = C_B * k / (well.phi * well.mu * well.ct * well.rw * well.rw);
        var per = 20, j0 = Math.floor(Math.log10(Math.max(1e-3, 1e-2 * Math.max(Cd, 1e-3))) * per);
        var devs = [], lastBad = -1, nGood = 0;
        for (var j = j0; j < j0 + 16 * per; j++) {
            var td = Math.pow(10, j / per), dev = Math.abs(2 * _pair(_lapHom, td, Cd, S, true)[1] - 1);
            devs.push(dev);
            if (dev > frac) { lastBad = devs.length - 1; nGood = 0; }
            else if (lastBad >= 0 && ++nGood >= 3 * per) break;
        }
        if (lastBad < 0) return 0;
        var u = (j0 + lastBad) / per;
        if (lastBad + 1 < devs.length) {   // interpolate the crossing in log tD
            var d0 = devs[lastBad], d1 = devs[lastBad + 1];
            if (d0 > d1) u += (d0 - frac) / (d0 - d1) / per;
        }
        return Math.pow(10, u) / Bt;
    }
    function reach(prep, homFit) {
        var f = homFit && homFit.phys ? homFit.phys : null;
        if (!f || !_pos(f.k) || !_pos(f.C) || !_num(f.S)) {
            return { t10_h: null, t5_h: null, fair_h: null, good_h: null, fairShut_h: null, goodShut_h: null, reachable: false, ev: ['W4'] };
        }
        var t10 = _tPct(f.k, f.C, f.S, prep.well, 0.10), t5 = _tPct(f.k, f.C, f.S, prep.well, 0.05);
        var L = prep.Lcyc, fair = Math.pow(10, DEFAULTS.reach.fairCycles + L) * t5, good = Math.pow(10, DEFAULTS.reach.goodCycles + L) * t5;
        var fs = prep.time.dtOfDte(fair), gs = prep.time.dtOfDte(good);
        return { t10_h: t10, t5_h: t5, fair_h: fair, good_h: good, fairShut_h: _pos(fs) ? fs : null, goodShut_h: _pos(gs) ? gs : null,
                 reachable: _pos(fs), ev: ['W4'] };
    }
    // Storage correlation (Appendix A.1), seeding only: valid 0 ≤ S ≤ 8, 220 ≤ C_D ≤ 22,060.
    function predictors(k, h, mu, C, S) {
        var Sc = _clamp(_num(S) ? S : 0, 0, 8), f = C * mu / (k * h);
        return { tUs_h: (2900 + 750 * Sc) * f, tHump_h: (21400 + 3390 * Sc) * f };
    }
    function _cFromHump(tHump, k, h, mu, S) { var Sc = _clamp(_num(S) ? S : 0, 0, 8); return tHump * k * h / ((21400 + 3390 * Sc) * mu); }
    function rinv(k, dt_h, well) { return 0.0325 * Math.sqrt(k * dt_h / (well.phi * well.mu * well.ct)); }

    // ─────────────────────────────────────────────────────────────────────
    // bic(prep, fits, opts) — log-Δp block BIC with n_eff and a floor (M§A10, D8)
    // ─────────────────────────────────────────────────────────────────────
    // SSR_m = Σ(ln Δp_i − ln Δp_model,i)², floored at Σ((σ_b,i/Δp_i)² + 0.005²);
    // ρ1 = lag-1 autocorrelation of the best model's residuals (clipped to [0, 0.9]);
    // n_eff = n(1 − ρ1)/(1 + ρ1); BIC = n_eff·ln(SSR/n) + p·ln n_eff. dBicHom = BIC_hom − BIC_m
    // (positive = better than homogeneous), rounded to 0.1 before any comparison with τ.
    // Standard errors are inflated by √(n/n_eff) here, once.
    function _rho1(r) {
        if (!r || r.length < 3) return 0;
        var m = 0, i;
        for (i = 0; i < r.length; i++) m += r[i];
        m /= r.length;
        var num = 0, den = 0;
        for (i = 0; i < r.length; i++) { den += (r[i] - m) * (r[i] - m); if (i) num += (r[i] - m) * (r[i - 1] - m); }
        return den > 0 ? _clamp(num / den, 0, 0.9) : 0;
    }
    function bic(prep, fits, opts) {
        opts = opts || {};
        var tau = _num(opts.tau) ? opts.tau : _thr(opts.cal).tauBic;
        var ok = fits.filter(function (f) { return f && f.ok && Array.isArray(f._res) && _num(f.ssrLog); });
        var homF = fits.filter(function (f) { return f && f.key === 'homogeneous'; })[0] || null;
        var n = ok.length ? ok[0]._res.length : 0;
        var floor = ok.length ? ok[0]._floor : 0;
        var best = null;
        ok.forEach(function (f) { if (!best || f.ssrLog < best.ssrLog) best = f; });
        var rho = best ? _rho1(best._res) : 0;
        var nEff = n * (1 - rho) / (1 + rho);
        var floorUsed = false;
        ok.forEach(function (f) {
            var ssr = f.ssrLog;
            if (ssr < floor) { ssr = floor; floorUsed = true; }
            f.bic = (n > 0 && nEff > 0) ? nEff * Math.log(ssr / n) + f.p * Math.log(Math.max(nEff, 1.0000001)) : null;
            if (!f._seInflated && nEff > 0) {
                var infl = Math.sqrt(n / nEff);
                Object.keys(f.se).forEach(function (k) { if (_num(f.se[k])) f.se[k] *= infl; });
                f._seInflated = true;
                var ci = {};
                Object.keys(f.se).forEach(function (k) {
                    var v = f.phys[k], s = f.se[k];
                    if (!_num(v) || !_num(s)) { ci[k] = null; return; }
                    ci[k] = (k === 'S') ? [v - 1.96 * s, v + 1.96 * s] : [v * Math.exp(-1.96 * s / v), v * Math.exp(1.96 * s / v)];
                });
                ['k', 'S', 'C'].forEach(function (k) { if (!(k in ci)) ci[k] = null; });
                f.ci95 = ci;
            }
        });
        var bHom = homF && _num(homF.bic) ? homF.bic : null;
        var rows = fits.filter(function (f) { return f; }).map(function (f) {
            var d = (f.key === 'homogeneous') ? 0 : ((_num(f.bic) && _num(bHom)) ? _rBic(bHom - f.bic) : null);
            return { key: f.key, bic: _fin(f.bic), dBicHom: d, p: f.p, eligible: !!f.eligible, why: (f.why || []).slice() };
        });
        // choice: the best eligible model; a rival replaces homogeneous only if BIC_hom − BIC_r > τ
        var forced = opts.forceModel || null, chosen = 'homogeneous';
        var cands = rows.filter(function (r) { return r.key !== 'homogeneous' && r.eligible && _num(r.dBicHom) && r.dBicHom > tau; });
        cands.sort(function (a, b) { return b.dBicHom - a.dBicHom; });
        if (cands.length) chosen = cands[0].key;
        if (forced && rows.some(function (r) { return r.key === forced; })) chosen = forced;
        // margin: the chosen model's lead over the next best model (ΔBIC, rounded)
        var others = rows.filter(function (r) { return r.key !== chosen && _num(r.bic); });
        var cRow = rows.filter(function (r) { return r.key === chosen; })[0];
        var margin = null;
        if (others.length && cRow && _num(cRow.bic)) {
            var nb = others.reduce(function (a, b) { return a.bic < b.bic ? a : b; });
            margin = _rBic(nb.bic - cRow.bic);
        }
        return { n: n, nEff: nEff, rho1: rho, tau: tau, basis: 'logDp', floorUsed: floorUsed, rows: rows, chosen: chosen, margin: margin, ev: ['M4'] };
    }

    // ─────────────────────────────────────────────────────────────────────
    // fullySeen(key, prep, iarf, fit) (M§A11)
    // ─────────────────────────────────────────────────────────────────────
    function fullySeen(key, prep, ir, mf) {
        if (key === 'homogeneous') return _copy(FS_NA);
        var b = prep.bins, X = b.X, d = prep.deriv.deriv, f = prep.deriv.full, n = X.length, S = DEFAULTS.seen;
        var lvl = ir && ir.found ? ir.level_psi : null;
        if (!lvl) {   // no IARF: the minimum after the hump
            var a0 = _gateIndex(prep, storage(prep)), mn = Infinity;
            for (var i = a0; i < n; i++) if (f[i] && d[i] > 0 && d[i] < mn) mn = d[i];
            lvl = mn < Infinity ? mn : null;
        }
        var lastFull = -1;
        for (var lf = n - 1; lf >= 0; lf--) if (f[lf]) { lastFull = lf; break; }
        var ph = (mf && mf.phys) || {};
        function tail(pred, cyc) {      // the last ≥ cyc cycle of full bins all satisfying pred
            if (lastFull < 0) return false;
            var k = lastFull;
            while (k >= 0 && f[k] && pred(k)) k--;
            return (X[lastFull] - X[k + 1]) / LN10 >= cyc - 1e-9 && k + 1 <= lastFull;
        }
        var sl = _derivSlopes(prep, 0.1);
        var full = false, any = false, val = null, txt = '';
        if (key === 'linearBoundary') {
            val = _fin(ph.dF_ft);
            full = !!lvl && tail(function (k) { return d[k] >= S.fault * lvl; }, S.faultCycles);
            any = !!lvl && tail(function (k) { return d[k] >= (1 + S.faultDepart) * lvl; }, 0.05);
            txt = full ? 'Sealing fault fully seen: the derivative reached ' + S.fault + '× the IARF level.' : 'Sealing fault seen, not fully: the distance is an upper-bound estimate.';
        } else if (key === 'composite2') {
            val = _fin(ph.R_ft);
            var lv2 = ir && ir.secondLevel ? ir.secondLevel : null;
            full = !!lv2 && Math.log10(lv2.dt1_h / lv2.dt0_h) >= S.compCycles - 1e-9;
            if (!full && lvl) full = tail(function (k) { return sl[k] !== null && Math.abs(sl[k]) <= 0.05 && Math.abs(d[k] / lvl - 1) > 0.2; }, S.compCycles);
            any = full || !!(lvl && tail(function (k) { return Math.abs(d[k] / lvl - 1) > 0.15; }, 0.05));
            txt = full ? 'Radial composite fully seen: the outer level is flat for at least ' + S.compCycles + ' cycle.' : 'Radial composite seen, not fully: the outer level is not yet flat; R is an estimate.';
        } else if (key === 'closedCircle') {
            val = _fin(ph.re_ft);
            full = !!lvl && tail(function (k) { return (d[k] <= S.closed * lvl) && sl[k] !== null && sl[k] <= S.closedSlope; }, 0.2);
            any = full || !!(lvl && tail(function (k) { return d[k] < (1 - S.faultDepart) * lvl; }, 0.05));
            txt = (full ? 'Closed boundary fully seen (falling derivative).' : 'Closed boundary seen, not fully.') +
                  ' Alternatives: constant-pressure boundary, interference or depletion.';
        }
        return { status: full ? 'full' : (any ? 'partial' : 'not'), value: val, bound: full ? null : 'upper', text: _txt(txt) };
    }

    // ─────────────────────────────────────────────────────────────────────
    // agreement(line, fit, prep) — line vs match, bias explained (M§A12, D9)
    // ─────────────────────────────────────────────────────────────────────
    function _syntheticLine(prep, mf, dt0, dt1) {
        var pm = _pmFor(mf.key, prep, mf._entry);
        if (!pm) return null;
        STATS.evals++;
        var dpm = pm.dp(prep.adataLine.t, mf._physPm);
        var ad = _copy(prep.adataLine);
        ad.dp = dpm.slice();
        ad.p = dpm.map(function (v) { return prep.adata.pRef + prep.sign * v; });
        return { ad: ad, run: function (a, b) { return _semilog(prep, a, b, ad); } };
    }
    function agreement(ln, mf, prep) {
        var A = DEFAULTS.agree;
        if (!ln || !mf || !mf.ok || !_pos(mf.phys.k)) {
            return { agree: false, mode: 'none', dkPct: null, dS: null, biasKPct: null, biasDS: null, ev: ['A1'] };
        }
        var dk = ln.k / mf.phys.k - 1, dS = ln.S - mf.phys.S;
        var rawOk = _rRatio(Math.abs(dk)) <= A.kPct / 100 && _r2(Math.abs(dS)) <= A.dS;
        var out = { agree: rawOk, mode: rawOk ? 'raw' : 'none', dkPct: 100 * dk, dS: dS, biasKPct: null, biasDS: null, ev: ['A1'] };
        var syn = _syntheticLine(prep, mf, ln.dt0_h, ln.dt1_h);
        if (syn) {
            var rb = syn.run(ln.dt0_h, ln.dt1_h);
            if (rb) {
                var bk = rb.k / mf.phys.k - 1, bS = rb.S - mf.phys.S;
                out.biasKPct = 100 * bk; out.biasDS = bS;
                if (!rawOk && _rRatio(Math.abs(dk - bk)) <= A.biasKPct / 100 && _r2(Math.abs(dS - bS)) <= A.biasDS) { out.agree = true; out.mode = 'bias'; }
            }
            (ln.shifts || []).forEach(function (s) {
                var rs = syn.run(s.dt0_h, s.dt1_h);
                s.bS = rs ? rs.S - mf.phys.S : null;
            });
            ln._biasS = out.biasDS;
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // cHeldJob(prep, fit, opts) — C-held refits (M§A13)
    // ─────────────────────────────────────────────────────────────────────
    function _cheldTriggered(prep, st, mf) {
        if (!st.unitSlope) return true;
        var pr = predictors(mf.phys.k, prep.well.h, prep.well.mu, mf.phys.C, mf.phys.S);
        return prep.bins.dt[0] > pr.tUs_h / 2;
    }
    function cHeldJob(prep, mf, opts) {
        opts = opts || {};
        var mode = opts.mode || 'auto';
        var st = opts.storage || storage(prep);
        var flags = opts.flags || [];
        var bt = opts.bicTable || null;
        var nEff = bt ? bt.nEff : null, nB = bt ? bt.n : null;
        var reject = DEFAULTS.cheld.reject;
        var trig = mf && mf.ok ? _cheldTriggered(prep, st, mf) : false;
        var meaningful = !flags.some(function (fl) { return fl.code === 'humpDp' || fl.code === 'steepStorage'; });
        var refits = [], queue = [], cur = null, curF = null, side = null;
        var rejectedSide = { lo: false, hi: false };
        if (trig && mode !== 'off') { queue.push({ f: DEFAULTS.cheld.f[0], side: 'lo', ext: false }); queue.push({ f: DEFAULTS.cheld.f[1], side: 'hi', ext: false }); }
        var extDone = false, result = null;
        function dBicOf(fr) {
            if (!fr || !fr.ok || !_num(fr.ssrLog) || !_num(mf.ssrLog)) return null;
            var n = nB || fr.nDp, ne = nEff || n, fl = mf._floor || 0;
            var s1 = Math.max(fr.ssrLog, fl), s0 = Math.max(mf.ssrLog, fl);
            return _rBic(ne * Math.log(s1 / s0));
        }
        function enqueueExt() {
            extDone = true;
            var E = DEFAULTS.cheld.ext;
            var lo = [E[0], E[1]], hi = [E[2], E[3]];
            if (mode === 'extended' || !rejectedSide.lo) lo.forEach(function (f) { queue.push({ f: f, side: 'lo', ext: true }); });
            if (mode === 'extended' || !rejectedSide.hi) hi.forEach(function (f) { queue.push({ f: f, side: 'hi', ext: true }); });
        }
        function finish() {
            var acc = refits.filter(function (r) { return !r.rejected; });
            var Cs = [mf.phys.C], ks = [mf.phys.k], Ss = [mf.phys.S];
            acc.forEach(function (r) { Cs.push(r.C); ks.push(r.k); Ss.push(r.S); });
            var rng = function (a) { return [Math.min.apply(null, a), Math.max.apply(null, a)]; };
            var sR = rng(Ss);
            result = { triggered: trig, mode: (mode === 'extended' || refits.some(function (r) { return r._ext; })) ? 'extended' : 'pair',
                       refits: refits.map(function (r) { return { f: r.f, k: r.k, S: r.S, C: r.C, dBic: r.dBic, rejected: r.rejected }; }),
                       range: { C: rng(Cs), k: rng(ks), S: sR }, S_C: (sR[1] - sR[0]) / 2, meaningful: meaningful, ev: ['C1'],
                       _rejectedBoth: refits.filter(function (r) { return !r._ext && r.rejected; }).length === 2 };
        }
        var label = 'C-held refits';
        return {
            step: function () {
                if (result) return { done: true, progress: 1, label: label };
                if (cur) {
                    var s = cur.step();
                    if (!s.done) return { done: false, progress: 0.5, label: label };
                    var fr = cur.result(); cur = null;
                    var db = dBicOf(fr);
                    var rej = !(fr && fr.ok) || db === null || db > reject;
                    STATS.cheldRefits++; if (curF.ext) STATS.cheldExt++;
                    refits.push({ f: curF.f, k: fr && fr.ok ? fr.phys.k : mf.phys.k, S: fr && fr.ok ? fr.phys.S : mf.phys.S, C: mf.phys.C * curF.f,
                                  dBic: _num(db) ? db : 0, rejected: rej, _ext: curF.ext });
                    if (rej) {
                        rejectedSide[curF.side] = true;
                        if (curF.ext && mode !== 'extended') queue = queue.filter(function (q) { return q.side !== curF.side; });
                    }
                    return { done: false, progress: 0.5, label: label };
                }
                if (!queue.length && trig && mode !== 'off' && !extDone) enqueueExt();
                if (!queue.length) { finish(); return { done: true, progress: 1, label: label }; }
                curF = queue.shift();
                var stt = { k: mf.phys.k, S: mf.phys.S, C: mf.phys.C * curF.f };
                cur = fitJob(mf.key, prep, { start: stt, freeze: { C: true }, entry: mf._entry, window: mf._window || undefined, retry: false });
                return { done: false, progress: 0.3, label: label };
            },
            result: function () { return result; },
            cancel: function () { if (cur) cur.cancel(); result = result || null; }
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // sErr(parts) (M§A14, D10)
    // ─────────────────────────────────────────────────────────────────────
    function sErr(parts) {
        parts = parts || {};
        var mode = parts.mode || 'line';
        var floor = _num(parts.floor) ? parts.floor : DEFAULTS.sErr.floor;
        var seS = _num(parts.seS) ? Math.abs(parts.seS) : 0;
        var dLM = (mode === 'line' && _num(parts.sLine) && _num(parts.sMatch)) ? Math.abs(parts.sLine - parts.sMatch) : null;
        var sWin = mode === 'line' ? (_num(parts.sWin) ? Math.abs(parts.sWin) : 0) : null;
        var sTc = _num(parts.sTc) ? Math.abs(parts.sTc) : 0, sPwf = _num(parts.sPwf) ? Math.abs(parts.sPwf) : 0;
        var sK = mode === 'kHeld' ? (_num(parts.sK) ? Math.abs(parts.sK) : 0) : null;
        var terms = [['floor', floor], ['se', seS]];
        if (mode === 'line') { terms.push(['lineMatch', dLM || 0]); terms.push(['window', sWin]); }
        terms.push(['tc', sTc]); terms.push(['pwf', sPwf]);
        if (mode === 'kHeld') terms.push(['kHeld', sK]);
        var top = terms[0];
        for (var i = 1; i < terms.length; i++) if (terms[i][1] > top[1]) top = terms[i];
        var value = top[1];
        var S_C = _num(parts.sC) ? Math.abs(parts.sC) : 0;
        var sSens = _num(parts.sSens) ? Math.abs(parts.sSens) : 0;
        return { value: value, mode: mode, floor: floor, seS: seS, dLineMatch: dLM, sWin: sWin, sTc: sTc, sPwf: sPwf, sK: sK, driver: top[0],
                 ext: { value: Math.max(value, S_C), S_C: S_C }, sSens: sSens, sAbs: Math.sqrt(value * value + sSens * sSens), ev: ['U1'] };
    }

    // ─────────────────────────────────────────────────────────────────────
    // sensitivity(final, well, ranges) — analytic, exact for homogeneous (M§A16, Appendix A.2)
    // ─────────────────────────────────────────────────────────────────────
    var SENS_COEF = { h: 1.1513, phi: 1.1513, ct: 1.1513, rw: 2.3026, B: -1.1513, mu: 0, q: -1.1513 };
    var SENS_INPUTS = ['h', 'phi', 'ct', 'rw', 'B', 'mu', 'q'];
    var REQ_RANGES = { h: 0.2, phi: 0.2, ct: 0.2, rw: 0.2, B: 0.2, mu: 0.2, q: 0.1 };
    function sensitivity(fin, well, ranges) {
        ranges = ranges || {};
        var req = ranges.req || REQ_RANGES;
        var typ = ranges.typ || (well && well.sens) || { h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 };
        var k = fin.k, S = fin.S;
        function rows(rg) {
            var out = [];
            SENS_INPUTS.forEach(function (inp) {
                var r = _num(rg[inp]) ? rg[inp] : 0;
                [1 + r, 1 - r].forEach(function (f) {
                    if (!(f > 0)) return;
                    var dS = SENS_COEF[inp] * Math.log10(f);
                    var kk = inp === 'h' ? k / f : (inp === 'B' || inp === 'mu' || inp === 'q') ? k * f : k;
                    out.push({ input: inp, f: f, k: kk, S: S + dS, dkPct: 100 * (kk / k - 1), dS: dS });
                });
            });
            return out;
        }
        function dom(rs, fn) {
            var best = null, bv = -1;
            rs.forEach(function (r) { var v = _rRatio(Math.abs(fn(r))); if (v > bv + 1e-12) { bv = v; best = r.input; } });
            return best;
        }
        var R = rows(req), T = rows(typ);
        var mx = {};
        T.forEach(function (r) { mx[r.input] = Math.max(mx[r.input] || 0, Math.abs(r.dS)); });
        var sSens = Math.sqrt(Object.keys(mx).reduce(function (s, kk) { return s + mx[kk] * mx[kk]; }, 0));
        return { req: R, typ: T, dominantK: { req: dom(R, function (r) { return r.dkPct; }), typ: dom(T, function (r) { return r.dkPct; }) },
                 dominantS: { req: dom(R, function (r) { return r.dS; }), typ: dom(T, function (r) { return r.dS; }) },
                 sSens: sSens, muNoEffectOnS: true, ev: ['U2', 'U3'] };
    }

    // ─────────────────────────────────────────────────────────────────────
    // confidence(ev, cal) — k/S label (K1), model label (K2), headline (§5.1)
    // ─────────────────────────────────────────────────────────────────────
    var RANKL = { low: 0, medium: 1, high: 2 }, LVL = ['low', 'medium', 'high'];
    function confidence(ev, cal) {
        ev = ev || {};
        var c = _cal(cal);
        var T = _thr(c);
        var calibrated = !!(c && c.calibrated);
        var reasons = [];
        function add(rule, kind, text, evIds) { reasons.push({ rule: rule, kind: kind, text: _txt(text), ev: evIds }); }
        var flags = ev.flags || [];
        var hasDistractor = flags.some(function (fl) { return DISTRACTORS[fl]; });
        var kHeld = !!ev.kHeld;
        var low = false, cap = false;
        // ── LOW rules ──
        var r3Fail = ev.r3Status === 'fail' && _num(ev.r3) && _rRatio(Math.abs(ev.r3 - 1)) > T.r3LowPct / 100;
        var r4Fail = ev.r4Status === 'fail' && _num(ev.r4) && _rRatio(Math.abs(ev.r4 - 1)) > T.r3LowPct / 100;
        if (r3Fail || r4Fail || ev.dqKnown === false) { low = true; add('KL3', 'low', 'KL3: rate check failed by more than ' + T.r3LowPct + ' % or the rate change is unknown.', ['R1', 'R3', 'R4']); }
        if (kHeld) {
            if (flags.some(function (fl) { return fl === 'humpDp' || fl === 'steepStorage'; })) { low = true; add('KL4', 'low', 'KL4: pressure hump or steep storage after the fit start.', ['M7']); }
            if (T.distractorRule && hasDistractor) { low = true; add('KL9', 'low', 'KL9: a distractor flag (valley, half or quarter slope) in a k-held test.', ['M7', 'I1']); }
            if (ev.kHeldConverged === false) { low = true; add('KK1', 'low', 'KK1: the k-held fit did not converge.', ['M8']); }
            if (_num(ev.kHeldCorrCS) && _rRatio(Math.abs(ev.kHeldCorrCS)) >= DEFAULTS.kHeld.corrMax) { low = true; add('KK2', 'low', 'KK2: C and S are strongly correlated in the k-held fit (|r| ' + _fmt(Math.abs(ev.kHeldCorrCS), 3) + ').', ['M8']); }
            if (_num(ev.kHeldRmsRatio) && _rRatio(ev.kHeldRmsRatio) > T.kHeldRmsK) { low = true; add('KK3', 'low', 'KK3: k-held residual RMS ' + _fmt(ev.kHeldRmsRatio, 2) + '× the noise level.', ['M8', 'I5']); }
            if (_num(ev.sErr) && _r2(ev.sErr) > DEFAULTS.kHeld.sErrMax) { low = true; add('KK4', 'low', 'KK4: skin uncertainty ' + _fmt(ev.sErr, 2) + ' above ' + DEFAULTS.kHeld.sErrMax + ' (k-held).', ['U1']); }
        } else {
            var noRival = ev.chosenFullySeen !== 'full';
            if (ev.grade === 'none' && noRival) { low = true; add('KL1', 'low', 'KL1: no IARF window and no fully seen boundary model.', ['I1', 'M5']); }
            if (_num(ev.sErr) && _r2(ev.sErr) > T.sErrLow) { low = true; add('KL2', 'low', 'KL2: skin uncertainty ' + _fmt(ev.sErr, 2) + ' above ' + T.sErrLow + '.', ['U1']); }
            if (ev.humpAfterIarf) { low = true; add('KL4', 'low', 'KL4: pressure hump or steep storage inside or after the IARF start.', ['M7']); }
            if (ev.grade !== 'none' && _num(ev.snrD) && _r2(ev.snrD) < T.snrLow) { low = true; add('KL5', 'low', 'KL5: derivative signal-to-noise ' + _fmt(ev.snrD, 2) + ' below ' + T.snrLow + ' in the IARF window.', ['I5']); }
            if (ev.grade !== 'none' && !ev.agree && ((_num(ev.dS) && _r2(Math.abs(ev.dS)) > T.disagreeDS) || (_num(ev.dkPct) && _rdp(Math.abs(ev.dkPct), 0.1) > T.disagreeKPct))) {
                low = true; add('KL6', 'low', 'KL6: line and match disagree (Δk ' + _fmt(ev.dkPct, 2) + ' %, ΔS ' + _fmt(ev.dS, 2) + '), not explained by the window bias.', ['A1']);
            }
            if (ev.grade !== 'none' && _num(ev.dteEnd_h) && _num(ev.t10_h) && _rRatio(ev.dteEnd_h / (T.reachFactor * ev.t10_h)) < 1) {
                low = true; add('KL7', 'low', 'KL7: the test ends before ' + T.reachFactor + '× the 10 % storage time: the window cannot be IARF.', ['W4', 'I1']);
            }
            if (ev.partialSuspect === true) { low = true; add('KL8', 'low', 'KL8: partial-cut suspicion (semilog slope below 0.7 of the baseline).', ['R1', 'I3', 'T9']); }
            if (T.distractorRule && ev.distractorAtOrBeforeIarf) { low = true; add('KL9', 'low', 'KL9: a distractor flag (valley, half or quarter slope) at or before the IARF window.', ['M7', 'I1']); }
        }
        // ── MEDIUM caps ──
        if (ev.historySensitive) { cap = true; add('KC1', 'cap', 'KC1: history start estimated and the derivative is sensitive to it.', ['R5']); }
        if (ev.outsideEnvelope || !calibrated) { cap = true; add('KC2', 'cap', ev.outsideEnvelope ? 'KC2: outside the calibration envelope.' : 'KC2: labels not yet calibrated.', ['K1']); }
        if (kHeld) { cap = true; add('KC3', 'cap', 'KC3: k-held result (k fixed at the baseline median).', ['M8']); }
        if (ev.r3Status === 'unavailable' || (ev.equalRateAssumed && ev.r3Status !== 'n/a')) { cap = true; add('KC4', 'cap', ev.r3Status === 'unavailable' ? 'KC4: allocation check unavailable.' : 'KC4: equal rates assumed for several events in one day.', ['R2', 'R3']); }
        if (!kHeld && ev.windowLevelInconsistent === true) { cap = true; add('KC5', 'cap', 'KC5: IARF level inconsistent with the baseline kh.', ['T9']); }
        if (_num(ev.fRate) && ev.fRate < 1) { cap = true; add('KC6', 'cap', 'KC6: rate step interpreted with Δq·f̂ (f̂ ' + _fmt(ev.fRate, 3) + ').', ['R1', 'D6']); }
        // ── HIGH (free results only) ──
        var allHigh = false;
        if (!kHeld) {
            var kh1 = ev.grade === 'good' || (ev.grade === 'fair' && !ev.noiseWidened && _num(ev.span) && _rSpan(ev.span) >= T.fairSpanHigh &&
                      _num(ev.pointSkinSpread) && _r2(ev.pointSkinSpread) <= T.pointSkinSpread);
            var kh2 = !!ev.agree;
            var kh3 = _num(ev.sErr) && _r2(ev.sErr) <= T.sErrHigh;
            var kh4 = !!ev.unitSlope || !!ev.cheldRejectedBoth;
            var r4ok = !(ev.r4Status === 'fail') && (!_num(ev.r4) || ev.r4Status === 'unavailable' || ev.r4Status === 'n/a' || _rRatio(Math.abs(ev.r4 - 1)) <= T.r4TolPct / 100);
            var kh5 = (ev.r3Status === 'n/a' || (ev.r3Status === 'pass' && (!_num(ev.r3) || _rRatio(Math.abs(ev.r3 - 1)) <= T.rateTolPct / 100))) && r4ok;
            var kh6 = _num(ev.snrD) && _r2(ev.snrD) >= T.snrHigh && (!_num(ev.rDrift) || _rRatio(ev.rDrift) <= T.rDriftMax) &&
                      (!_num(ev.rTide) || ev.tideRemoved || _rRatio(ev.rTide) <= T.rTideMax) && !flags.length;
            if (!kh1) add('KH1', 'unmet', 'KH1 unmet: ' + (ev.grade === 'none' ? 'no IARF window' : (ev.noiseWidened ? 'noise-widened window' : 'fair window ' + _fmt(ev.span, 2) + ' cycle')) + '.', ['I1', 'I4']);
            if (!kh2) add('KH2', 'unmet', 'KH2 unmet: line and match do not agree.', ['A1']);
            if (!kh3) add('KH3', 'unmet', 'KH3 unmet: skin uncertainty above ' + T.sErrHigh + '.', ['U1']);
            if (!kh4) add('KH4', 'unmet', 'KH4 unmet: unit slope not sampled and the C-held refits were not both rejected.', ['W1', 'C1']);
            if (!kh5) add('KH5', 'unmet', 'KH5 unmet: rate checks not passed within tolerance.', ['R3', 'R4']);
            if (!kh6) add('KH6', 'unmet', 'KH6 unmet: signal-to-noise, drift, tide or anomaly flags.', ['I5', 'Q5', 'Q6', 'M7']);
            allHigh = kh1 && kh2 && kh3 && kh4 && kh5 && kh6;
        }
        var ks = low ? 'low' : ((cap || !allHigh) ? 'medium' : 'high');
        // ── model label (K2) ──
        var trig = ev.triggers || [];
        var model;
        var tau = T.tauBic;
        if ((trig.indexOf('T-none') >= 0 && ev.chosenFullySeen !== 'full') || hasDistractor || ev.boundaryDepends === true) model = 'low';
        else if (ev.chosenKey === 'homogeneous' && !trig.length && ev.grade === 'good') model = 'high';
        else if (ev.chosenKey && ev.chosenKey !== 'homogeneous' && _num(ev.dBicChosen) && _rBic(ev.dBicChosen) > tau &&
                 (!_num(ev.dBicNext) || _rBic(ev.dBicNext) > tau) && ev.chosenFullySeen === 'full') model = 'high';
        else model = 'medium';
        if (ev.compositeOutOfRace && model === 'high') model = 'medium';
        if (_num(ev.modelCap) && RANKL[model] > ev.modelCap) model = LVL[ev.modelCap];
        if (RANKL[model] > RANKL[ks]) model = ks;
        var headline = RANKL[ks] < RANKL[model] ? ks : model;
        var rates = null;
        if (c && Array.isArray(c.ksTable) && Array.isArray(c.table)) {
            var a = c.ksTable.filter(function (r) { return r.label === ks; })[0], bRow = c.table.filter(function (r) { return r.label === headline; })[0];
            if (a && bRow) rates = { ks: { rate: a.right, lo: a.lo, hi: a.hi }, headline: { rate: bRow.fullyRight, lo: bRow.lo, hi: bRow.hi } };
        }
        return { ks: ks, model: model, headline: headline, stage: ev.stage === 'final' ? 'final' : 'pass1', reasons: reasons, rates: rates,
                 outsideCalibration: !!ev.outsideEnvelope, calVersion: c ? (c.version || null) : null, calibrated: calibrated, ev: ['K1', 'K2'] };
    }

    // ─────────────────────────────────────────────────────────────────────
    // p* range, p_ext, k-held, background check
    // ─────────────────────────────────────────────────────────────────────
    function pStarRange(prep, ln, spec) {
        spec = spec || prep.spec;
        if (!ln || !spec.history || !spec.history.estimated || !_pos(spec.history.tPrepend_h)) return null;
        var by = { '1': ln.pStar }, vals = [ln.pStar];
        DEFAULTS.history.pStarFactors.forEach(function (fct) {
            var st = prep.histFull.steps.map(function (s) { return { t: s.t, q: s.q }; });
            st[0].t = st[0].t + spec.history.tPrepend_h * (1 - fct);
            var ad = _copy(prep.adataLine);
            ad.rateHistory = st.map(function (s) { return { t: s.t, q: prep.sign < 0 ? -s.q : s.q }; });
            if (prep.singleRate) ad.tp = prep.spec.tc_h - st[0].t;     // Horner uses tp
            var r = _semilog(prep, ln.dt0_h, ln.dt1_h, ad);
            var ps = r ? _toP(prep, r.pStar) : null;
            by[String(fct)] = _fin(ps);
            if (_num(ps)) vals.push(ps);
        });
        vals = vals.filter(_num);
        if (!vals.length) return null;
        return { lo: Math.min.apply(null, vals), hi: Math.max.apply(null, vals), byFactor: by };
    }
    function _modelDrawdownAtTc(prep, mf) {   // A1·Σ Δq_i·pD(B(t_c − τ_i)), the model drawdown at t_c (psi or pn)
        var e = mf._entry, w = prep.well, ph = mf._physPm || {};
        var Cd = C_CD * ph.C / (w.phi * w.ct * w.h * w.rw * w.rw), Bt = C_B * ph.k / (w.phi * w.mu * w.ct * w.rw * w.rw);
        var params = _copy(mf.params); params.Cd = Cd; params.S = ph.S;
        var A1 = C_A * w.B * w.mu / (ph.k * w.h), st = prep.histFit.steps, tc = prep.spec.tc_h, D = 0;
        for (var i = 0; i < st.length - 1; i++) {
            var dq = st[i].q - (i ? st[i - 1].q : 0);
            if (dq === 0) continue;
            D += dq * e.pd(Bt * (tc - st[i].t), params);
        }
        return A1 * D;
    }
    function pExt(prep, mf, family) {
        if (!mf || !mf.ok || !_pos(mf.phys.k)) return null;
        var pi = _piModel(prep, mf);
        if (!_num(pi)) return null;
        if (family !== 'closed') return pi;
        var re = mf.phys.re_ft || prep.spec.well.re_ft;
        if (!_pos(re)) return null;
        var w = prep.well, st = prep.histFull.steps, Np = 0;
        for (var i = 0; i < st.length - 1; i++) Np += st[i].q * (st[i + 1].t - st[i].t) / 24;
        var dpbar = 5.615 * w.B * Np / (Math.PI * re * re * w.h * w.phi * w.ct);
        var yb = _yOfP(prep, pi) - prep.sign * dpbar;
        return _fin(_toP(prep, yb));
    }
    function _yOfP(prep, p) { return prep.gasTable ? prep.gasTable.pn(p) : p; }
    function _piModel(prep, mf) {
        try {
            var D = _modelDrawdownAtTc(prep, mf);
            return _fin(_toP(prep, prep.adata.pRef + prep.sign * D));
        } catch (e) { return null; }
    }

    // kHeldJob(prep, {k, delta}) — k fixed at the baseline median, S and C free, then
    // two refits at k·(1 ± δ); S_k = half the S range (§4.6 item 18, D14).
    function kHeldJob(prep, opts) {
        opts = opts || {};
        var k = opts.k, delta = _num(opts.delta) ? Math.abs(opts.delta) : 0.05;
        var start = _copy(opts.start || {});
        var jobs = [], idx = 0, cur = null, fits = [], result = null;
        var plan = [1, 1 + delta, 1 - delta];
        var seedS = _num(start.S) ? start.S : null, seedC = _pos(start.C) ? start.C : null;
        if (seedS === null || seedC === null) {
            var sd = _seedFromData(prep, k);
            if (seedS === null) seedS = sd.S;
            if (seedC === null) seedC = sd.C;
        }
        var win = opts.window || null;
        var label = 'k-held fit';
        function finish() {
            var f0 = fits[0];
            var ok = f0 && f0.ok;
            var refits = fits.slice(1).map(function (f, i) { return { f: plan[i + 1], S: f && f.ok ? f.phys.S : null, C: f && f.ok ? f.phys.C : null }; });
            var Ss = refits.map(function (r) { return r.S; }).filter(_num);
            var Sk = Ss.length === 2 ? Math.abs(Ss[0] - Ss[1]) / 2 : null;
            var w = prep.well, mHeld = C_PLAT * prep.spec.Dq * w.B * w.mu / (k * w.h);
            var dpEnd = prep.bins.dp[prep.bins.dp.length - 1];
            var pD = dpEnd / (2 * mHeld);
            var sig = _median(prep.fitSet.sigma_b.map(function (sb) { return Math.sqrt(sb * sb + prep.sigmaLF * prep.sigmaLF); }));
            var rmsRatio = (ok && _num(f0.rmseDp) && sig > 0) ? f0.rmseDp / sig : (ok && _num(f0.rmseDp) && f0.rmseDp === 0 ? 0 : null);
            result = {
                k: k, delta: delta, fit: ok ? f0 : _failFit('homogeneous', null, 'k-held fit failed', null),
                refits: refits.filter(function (r) { return _num(r.S); }), S_k: _fin(Sk), S_kAnalytic: Math.abs(delta * (pD - 0.5)),
                corrCS: ok ? _fin(f0.corr.CS) : null, rmsRatio: _fin(rmsRatio), converged: !!(ok && f0.converged), ev: ['M8']
            };
        }
        return {
            step: function () {
                if (result) return { done: true, progress: 1, label: label };
                if (cur) {
                    var s = cur.step();
                    if (!s.done) return { done: false, progress: (idx + 0.5) / 3, label: label };
                    fits.push(cur.result()); cur = null; idx++;
                    if (idx >= plan.length) { finish(); return { done: true, progress: 1, label: label }; }
                    return { done: false, progress: idx / 3, label: label };
                }
                var f0 = fits[0];
                var st = { k: k * plan[idx], S: (f0 && f0.ok) ? f0.phys.S : seedS, C: (f0 && f0.ok) ? f0.phys.C : seedC };
                cur = fitJob('homogeneous', prep, { start: st, freeze: { k: true }, window: win || undefined, entry: opts.entry || undefined, retry: idx === 0 });
                if (!opts.entry) opts.entry = cur.entry;
                return { done: false, progress: idx / 3, label: label };
            },
            result: function () { return result; },
            cancel: function () { if (cur) cur.cancel(); }
        };
    }
    function _seedFromData(prep, k) {   // S from the late Δp with k given; C from the first bins
        var b = prep.bins, w = prep.well, n = b.dt.length;
        var mp = C_PLAT * prep.spec.Dq * w.B * w.mu / (k * w.h);
        var S = 0.5 * (b.dp[n - 1] / mp - Math.log(k * b.dte[n - 1] / (w.phi * w.mu * w.ct * w.rw * w.rw)) + 7.4316);
        var C = prep.spec.Dq * w.B * b.dt[0] / (24 * Math.max(1e-6, Math.abs(b.pReal[0] - prep.spec.pwf0)));
        return { S: _clamp(_num(S) ? S : 0, -6, 40), C: _clamp(_pos(C) ? C : 0.01, 1e-6, 5) };
    }

    // backgroundCheck(result, spec, dpdt) — subtract Δt·(dp/dt)_bg, recompute the derivative and
    // the triggers (no refit); a chosen rival whose trigger disappears → boundaryDepends.
    function backgroundCheck(result, spec, dpdt_psi_h, source) {
        var out = { applied: false, slopeSource: source === 'drift' ? 'drift' : 'pstar', triggersBefore: [], triggersAfter: [], boundaryDepends: false, ev: ['M7'] };
        if (!result || !spec || !_num(dpdt_psi_h)) return out;
        var sp = _copy(spec);
        sp.p = spec.p.map(function (v, i) { return v - spec.dt[i] * dpdt_psi_h; });
        var pr = prepare(sp);
        if (!pr.ok) return out;
        var st = storage(pr), ir = iarf(pr, { storage: st, reachFair: result.reach && result.reach.fair_h });
        ir._st = st;
        var tg = triggers(pr, ir, result.reach);
        out.applied = true;
        out.triggersBefore = (result.triggers && result.triggers.fired) ? result.triggers.fired.slice() : [];
        out.triggersAfter = tg.triggers.fired.slice();
        var need = { linearBoundary: ['T-up', 'T-none'], composite2: ['T-up', 'T-down', 'T-level', 'T-none'], closedCircle: ['T-down', 'T-none'] };
        var ck = result.chosen && result.chosen.key;
        if (ck && need[ck]) out.boundaryDepends = !need[ck].some(function (t) { return out.triggersAfter.indexOf(t) >= 0; });
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // interpretJob(spec, opts) → Job<BuildupResult> (stage 1, §4.6 items 1–17)
    // ─────────────────────────────────────────────────────────────────────
    var COMPOSITE_IN_RACE = true;   // two-zone kernel measured within its 6 ms limit (merge note)
    var LABELS = { homogeneous: 'Homogeneous', linearBoundary: 'Sealing fault', composite2: 'Radial composite', closedCircle: 'Closed circle' };
    var NEEDS = { linearBoundary: ['T-up', 'T-none'], composite2: ['T-up', 'T-down', 'T-level', 'T-none'], closedCircle: ['T-down', 'T-none'] };

    function _runner() {
        var q = [], sub = null, subCb = null, done = 0;
        return {
            add: function (label, fn) { q.push({ label: label, fn: fn }); },
            front: function (items) { q = items.concat(q); },
            sub: function (job, cb) { sub = job; subCb = cb; },
            step: function () {
                if (sub) {
                    var s = sub.step();
                    if (s.done) { var j = sub, cb = subCb; sub = null; subCb = null; done++; cb(j.result()); }
                    return s.label;
                }
                if (!q.length) return null;
                var it = q.shift(); done++;
                it.fn();
                return it.label;
            },
            idle: function () { return !sub && !q.length; },
            count: function () { return done; },
            pending: function () { return q.length + (sub ? 1 : 0); },
            cancel: function () { if (sub && sub.cancel) sub.cancel(); sub = null; q = []; }
        };
    }
    function _failResult(spec, code, errors) {
        return { ok: false, id: spec && spec.id ? String(spec.id) : 'B?', version: AI.version, code: code || 'FAILED', errors: errors || [],
                 bad: [], reason: code || 'FAILED', warnings: [] };
    }

    function interpretJob(spec, opts) {
        opts = opts || {};
        var cal = _cal(opts.cal);
        var R = _runner();
        var S = { result: null, cancelled: false };
        var so = (spec && spec.opts) || {};
        var ovr = (spec && spec.overrides) || {};
        var rivalsMode = opts.rivals || so.rivals || 'auto';
        var cheldMode = opts.cheld || so.cheld || 'auto';
        var label0 = 'Build-up ' + (spec && spec.id ? spec.id : '');
        var inputHash = hash16(canon({ spec: spec, rivals: rivalsMode, cheld: cheldMode, engine: AI.version }, 'inputs'));

        R.add('prepare', function () {
            var p = prepare(spec);
            if (!p.ok) { S.result = _failResult(spec, p.code, p.errors); R.cancel(); return; }
            S.prep = p;
            S.storage = storage(p);
            S.iarf = iarf(p, { storage: S.storage, window: ovr.window || null,
                               band: spec.opts && spec.opts.band, slope: spec.opts && spec.opts.slope });
            S.iarf._st = S.storage;
            S.line = line(p, S.iarf);
            S.flags = flagsFor(p, S.iarf, S.storage);
            // Seeds (item 5): k, S from the line, else the level and the point skin; C from C_us, else the hump correlation.
            var w = p.well, q = p.spec.Dq, k0, S0, C0;
            if (S.line) { k0 = S.line.k; S0 = S.line.S; }
            else {
                var lv = triggers(p, S.iarf, null)._level || _median(p.deriv.deriv.filter(function (v) { return v > 0; }));
                k0 = C_PLAT * q * w.B * w.mu / (w.h * lv);
                var nb = p.bins.dt.length - 1;
                S0 = 0.5 * (p.bins.dp[nb] / lv - Math.log(k0 * p.bins.dte[nb] / (w.phi * w.mu * w.ct * w.rw * w.rw)) + 7.4316);
            }
            k0 = _clamp(_pos(k0) ? k0 : 10, 1e-3, 5e4); S0 = _clamp(_num(S0) ? S0 : 0, -6, 40);
            if (S.storage.unitSlope) C0 = S.storage.C_us;
            else if (_pos(S.storage.tHump_h)) C0 = _cFromHump(S.storage.tHump_h, k0, w.h, w.mu, S0);
            else C0 = q * w.B * p.bins.dt[0] / (24 * Math.max(1e-6, Math.abs(p.bins.pReal[0] - p.spec.pwf0)));
            C0 = _clamp(_pos(C0) ? C0 : 0.01, 1e-6, 5);
            if (!S.storage.unitSlope) S.storage.seed = predictors(k0, w.h, w.mu, C0, S0);
            S.seed = { k: k0, S: S0, C: C0 };
            // A hump or steep-storage flag moves the fit start to 3·t_end of the anomaly.
            var anom = S.flags.filter(function (fl) { return fl.code === 'humpDp' || fl.code === 'steepStorage'; });
            S.window = anom.length ? { tmin: 3 * Math.max.apply(null, anom.map(function (fl) { return fl.dt1_h; })) } : null;
            if (S.window && _fitPoints(p, S.window).length < 8) S.window = null;
            R.sub(fitJob('homogeneous', p, { start: S.seed, window: S.window || undefined }), function (mf) { S.hom = mf; });
        });
        R.add('reach and agreement', function () {
            var p = S.prep;
            if (!S.hom || !S.hom.ok) { S.result = _failResult(spec, 'FIT_FAILED', ['The homogeneous fit failed.']); R.cancel(); return; }
            S.reach = reach(p, S.hom);
            if (!S.iarf.found) {
                S.iarf.status = (_pos(S.reach.fair_h) && p.dteEnd < S.reach.fair_h) ? 'tooShort' : 'expectedNotFound';
                if (S.iarf.status === 'tooShort' && !S.iarf._noise) {
                    S.iarf.reason = _txt('No IARF: the test is too short (equivalent time ' + _fmt(p.dteEnd) + ' h; a fair IARF needs ' + _fmt(S.reach.fair_h) + ' h).');
                }
            }
            var tg = triggers(p, S.iarf, S.reach);
            S.trig = tg.triggers;
            S.bic0 = bic(p, [S.hom], { cal: cal });
            S.agreement = agreement(S.line, S.hom, p);
            // storage consistency: observed hump vs the fitted model's hump within ×1.5
            if (_pos(S.storage.tHump_h)) {
                var pr = predictors(S.hom.phys.k, p.well.h, p.well.mu, S.hom.phys.C, S.hom.phys.S);
                S.storage.humpConsistent = Math.abs(Math.log(S.storage.tHump_h / pr.tHump_h)) <= Math.log(1.5);
            }
            if (S.iarf.found && S.storage._iHump >= 0) S.storage.humpRatio = p.deriv.deriv[S.storage._iHump] / S.iarf.level_psi;
            var cj = cHeldJob(p, S.hom, { mode: cheldMode, storage: S.storage, flags: S.flags, bicTable: S.bic0 });
            R.sub(cj, function (ch) { S.cheld = ch; });
        });
        R.add('rivals', function () {
            var p = S.prep, fired = S.trig.fired, keys = [];
            function want(k) { if (keys.indexOf(k) < 0) keys.push(k); }
            if (rivalsMode === 'all') { want('linearBoundary'); want('composite2'); want('closedCircle'); }
            else if (rivalsMode !== 'none') {
                if (S.trig.up) { want('linearBoundary'); want('composite2'); }
                if (S.trig.down) { want('closedCircle'); want('composite2'); }
                if (S.trig.level) want('composite2');
                if (S.trig.none) { want('linearBoundary'); want('composite2'); want('closedCircle'); }
            }
            if (ovr.model && ovr.model !== 'homogeneous') want(ovr.model);
            var excl = ovr.excludeRivals || [];
            keys = keys.filter(function (k) { return excl.indexOf(k) < 0 || k === ovr.model; });
            if (!COMPOSITE_IN_RACE && ovr.model !== 'composite2') { S.compositeOut = keys.indexOf('composite2') >= 0; keys = keys.filter(function (k) { return k !== 'composite2'; }); }
            S.rivalKeys = keys;
            S.rivals = [];
            var hp = S.hom.phys, w = p.well, lvl = S.iarf.found ? S.iarf.level_psi : (triggers(p, S.iarf, S.reach)._level || null);
            var b = p.bins, d = p.deriv.deriv, f = p.deriv.full, n = b.dt.length;
            var lastFull = -1;
            for (var lf = n - 1; lf >= 0; lf--) if (f[lf]) { lastFull = lf; break; }
            var from;
            if (S.iarf.found) from = S.iarf._b + 1;
            else {   // no IARF: from the derivative minimum after the hump (the base level)
                from = _gateIndex(p, S.storage);
                var iMin = -1;
                for (var im = Math.max(0, from); im <= lastFull; im++) if (f[im] && d[im] > 0 && (iMin < 0 || d[im] < d[iMin])) iMin = im;
                if (iMin >= 0) { from = iMin; lvl = d[iMin]; }
            }
            var tDev = null;
            for (var i = Math.max(0, from); i <= lastFull; i++) if (f[i] && lvl && Math.abs(d[i] / lvl - 1) > DEFAULTS.seen.faultDepart) { tDev = b.dte[i]; break; }
            if (!tDev) tDev = 0.4 * p.dteEnd;   // no departure seen from a base level: a fraction of the investigated time
            var rInvDev = rinv(hp.k, tDev, w);
            var dEnd = lastFull >= 0 ? d[lastFull] : null;
            var subs = [];
            keys.forEach(function (key) {
                var base = { k: hp.k, S: hp.S, C: hp.C };
                if (key === 'linearBoundary') {
                    var Ls = [];
                    for (var j = Math.max(0, from); j <= lastFull; j++) {
                        if (!f[j] || !lvl) continue;
                        var g = d[j] / lvl - 1;
                        if (g >= 0.1 && g <= 0.9) Ls.push(Math.sqrt(C_B * hp.k * b.dte[j] * Math.log(1 / g) / (w.phi * w.mu * w.ct)));
                    }
                    var L = Ls.length ? _median(Ls) : rInvDev;
                    base.dF = _clamp(L / w.rw, 2, 1e7);
                    subs.push({ key: key, starts: [base] });
                } else if (key === 'composite2') {
                    var M = S.iarf.secondLevel ? S.iarf.secondLevel.ratio : ((dEnd > 0 && lvl) ? dEnd / lvl : 1);
                    if (S.trig.up && !S.trig.level) M = Math.max(M, 1.1);
                    if (S.trig.down && !S.trig.level) M = Math.min(M, 0.9);
                    base.M = _clamp(M, 0.06, 18); base.F = 1; base.R = _clamp(rInvDev / w.rw, 2, 1e7);
                    subs.push({ key: key, starts: [base], freeze: { F: true } });
                } else if (key === 'closedCircle') {
                    var re = 0.9 * rInvDev;
                    subs.push({ key: key, starts: DEFAULTS.rivals.closedStarts.map(function (fc) { var s = _copy(base); s.reD = _clamp(fc * re / w.rw, 60, 9e6); return s; }) });
                }
            });
            var items = [];
            subs.forEach(function (sb) {
                var bestR = null, entry = gridEntry(sb.key, p);
                sb.starts.forEach(function (st0, si) {
                    items.push({ label: 'fit ' + sb.key, fn: function () {
                        R.sub(fitJob(sb.key, p, { start: st0, freeze: sb.freeze || {}, entry: entry, window: S.window || undefined, retry: false }), function (mf) {
                            bestR = bestR ? _betterFit(bestR, mf) : mf;
                            if (si === sb.starts.length - 1) S.rivals.push(bestR);
                        });
                    } });
                });
            });
            R.front(items);
        });
        R.add('model choice', function () {
            var p = S.prep, fired = S.trig.fired;
            var rinvEnd = function (k) { return rinv(k, p.dteEnd, p.well); };
            S.rivals.forEach(function (mf) {
                var why = [];
                var trigOk = NEEDS[mf.key].some(function (t) { return fired.indexOf(t) >= 0; }) || rivalsMode === 'all';
                if (!trigOk) why.push('No trigger for this model.');
                if (!mf.ok) why.push('The fit failed.');
                else {
                    if (!mf.converged) why.push('The fit did not converge (' + mf.stopReason + ').');
                    if (mf._atBound && mf._atBound.length) why.push('Parameter at a bound: ' + mf._atBound.join(', ') + '.');
                    if (mf._corrMax >= 0.98) why.push('Parameters strongly correlated (|r| ' + _fmt(mf._corrMax, 3) + ').');
                    var ri = rinvEnd(mf.phys.k), dist = mf.phys.dF_ft || mf.phys.R_ft || mf.phys.re_ft;
                    if (_pos(dist) && (dist < 0.05 * ri || dist > 1.5 * ri)) why.push('Distance ' + _fmt(dist, 3) + ' ft outside 0.05–1.5 × the radius of investigation (' + _fmt(ri, 3) + ' ft).');
                    if (mf.key === 'composite2' && _num(mf.phys.M) && (mf.phys.M < 0.05 || mf.phys.M > 20)) why.push('Mobility ratio outside 0.05–20.');
                }
                mf.why = why.map(_txt);
                mf.eligible = !why.length;
                mf.fullySeen = fullySeen(mf.key, p, S.iarf, mf);
            });
            var fits = [S.hom].concat(S.rivals);
            S.bic = bic(p, fits, { cal: cal, forceModel: ovr.model || null });
            S.chosenKey = S.bic.chosen;
            S.chosenFit = fits.filter(function (f) { return f.key === S.chosenKey; })[0] || S.hom;
            S.agreementChosen = (S.chosenFit === S.hom) ? S.agreement : agreement(S.line, S.chosenFit, p);
        });
        R.add('final values', function () {
            var p = S.prep, w = p.well, cf = S.chosenFit, ag = S.agreementChosen;
            var src, k, Sk, C;
            if (S.line && ag.agree) { src = 'match'; k = cf.phys.k; Sk = cf.phys.S; C = cf.phys.C; }
            else if (S.line) { src = 'line'; k = S.line.k; Sk = S.line.S; C = _pos(cf.phys.C) ? cf.phys.C : S.storage.C_us; }
            else { src = 'model'; k = cf.phys.k; Sk = cf.phys.S; C = cf.phys.C; }
            var kh = k * w.h, m = C_M * p.spec.Dq * w.B * w.mu / kh;
            var pStar = S.line ? S.line.pStar : null;
            var range = pStarRange(p, S.line, spec);
            if (S.line) S.line.pStarRange = range ? { lo: range.lo, hi: range.hi } : null;
            var piM = _piModel(p, cf);
            var pE = _num(pStar) ? pStar : piM;
            var dpSkin = 0.8686 * m * Sk;
            var gasOut = null;
            if (p.gasTable) {
                var y0 = p.adata.pRef, pw = p.spec.pwf0;
                var pAt = p.gasTable.pOfPn(y0 + p.sign * dpSkin);
                gasOut = { Sprime: Sk, dmSkin: dpSkin, dpSkin_psi: _fin(Math.abs(pAt - pw)) };
            }
            var dist = {};
            ['dF_ft', 'R_ft', 're_ft'].forEach(function (kk) { if (_pos(cf.phys[kk])) dist[kk] = cf.phys[kk]; });
            var minFault = null;
            if (S.chosenKey === 'homogeneous' && S.iarf.found && !S.trig.up) {
                var lf = S.iarf._lastFull, dteLast = p.bins.dte[lf];
                var sdv = _median(p.bins.sigma_d.slice(S.iarf._a, S.iarf._b + 1));
                var g = Math.max(DEFAULTS.seen.faultDepart, 3 * (_num(sdv) ? sdv : 0) / S.iarf.level_psi);
                if (g < 1) minFault = Math.sqrt(C_B * k * dteLast * Math.log(1 / g) / (w.phi * w.mu * w.ct));
            }
            S.final = { k: k, kh: kh, S: Sk, C: C, source: src, m: m, mPrime: m / LN10, pStar: _fin(pStar),
                        pStarRange: range ? { lo: range.lo, hi: range.hi } : null, pExt: _fin(pE), pExtKind: 'pStar', piModel: _fin(piM),
                        rinv_ft: rinv(k, p.dtEnd, w), rinvE_ft: rinv(k, p.dteEnd, w), dpSkin_psi: p.gasTable ? (gasOut.dpSkin_psi) : dpSkin,
                        distances: dist, minFaultDist_ft: _fin(minFault), gas: gasOut, ev: ['A2'] };
            // History sensitivity (item 14)
            S.history = { estimated: !!(spec.history && spec.history.estimated), dDerivPct: null, sensitive: false, ev: ['R5'] };
            if (S.history.estimated && _pos(spec.history.tPrepend_h) && S.iarf.found) S.history = _historyCheck(p, S.hom, S.iarf, spec.history.tPrepend_h);
        });
        R.add('uncertainty and confidence', function () {
            var p = S.prep, w = p.well, fin = S.final, cf = S.chosenFit;
            var thr = _thr(cal);
            var sens = sensitivity({ k: fin.k, S: fin.S }, { sens: (spec.well && spec.well.sens) || null });
            var m = fin.m;
            var sTc = 1.1513 * Math.abs(p.spec.dpdt_flow || 0) * (p.spec.dtc_h || 0) / m;
            var sPwf = 1.1513 * (p.spec.pwf0SE || 0) / m;
            var parts = { floor: thr.sErrFloor, seS: cf.se.S, sTc: sTc, sPwf: sPwf, sC: S.cheld ? S.cheld.S_C : 0, sSens: sens.sSens };
            if (S.line && fin.source !== 'model') {
                var bias = S.agreementChosen.mode === 'bias';
                var s0 = S.line.S - (bias && _num(S.line._biasS) ? S.line._biasS : 0);
                var sh = S.line.shifts.map(function (x) { return x.S - (bias && _num(x.bS) ? x.bS : 0); });
                var sWin = sh.length === 2 ? Math.abs(sh[1] - sh[0]) / 2 : (sh.length === 1 ? Math.abs(sh[0] - s0) : 0);
                parts.mode = 'line'; parts.sLine = S.line.S; parts.sMatch = cf.phys.S; parts.sWin = sWin;
            } else parts.mode = 'model';
            S.sErr = sErr(parts);
            S.sensitivity = sens;
            // quality
            var ir = S.iarf, sdW = ir.found ? _median(p.bins.sigma_d.slice(ir._a, ir._b + 1)) : _median(p.bins.sigma_d);
            var mp = ir.found ? ir.level_psi : fin.mPrime;
            var snr = (_pos(sdW) ? mp / sdW : 1e6);
            snr = Math.min(1e6, snr);
            var rDrift = ((spec.driftPsiPerDay || 0) / 24) * p.dtEnd / fin.mPrime;
            S.quality = { sigma_psi: p.sigma, sigmaFlow_psi: _num(spec.sigmaFlow_psi) ? spec.sigmaFlow_psi : 0, sigmaD_psi: _num(sdW) ? sdW : 0,
                          snrD: snr, rDrift: rDrift, rTide: p.rTide, tideRemoved: p.tideRemoved, tideFit: p.tideFit, ev: ['I5', 'Q5', 'Q6'] };
            // evidence vector
            var codes = S.flags.map(function (fl) { return fl.code; });
            var distr = S.flags.some(function (fl) { return DISTRACTORS[fl.code] && (!ir.found || fl.dt0_h <= ir.dt1_h); });
            var humpAfter = S.flags.some(function (fl) { return (fl.code === 'humpDp' || fl.code === 'steepStorage') && ir.found && fl.dt1_h >= ir.dt0_h; });
            var rq = spec.rateQC || {};
            var rows = S.bic.rows, cRow = rows.filter(function (r) { return r.key === S.chosenKey; })[0];
            var others = rows.filter(function (r) { return r.key !== S.chosenKey && _num(r.bic); });
            var dNext = (others.length && cRow && _num(cRow.bic)) ? _rBic(Math.min.apply(null, others.map(function (r) { return r.bic; })) - cRow.bic) : null;
            var env = _envelope(cal, { k: fin.k, S: fin.S, C: fin.C, well: w, dteEnd: p.dteEnd, snrD: snr, dtEnd: p.dtEnd });
            S.evidence = {
                grade: ir.grade, noiseWidened: !!ir.noiseWidened, span: _fin(ir.cycles), pointSkinSpread: _fin(ir.pointSkin.spread),
                agree: !!S.agreementChosen.agree, agreeMode: S.agreementChosen.mode, dkPct: _fin(S.agreementChosen.dkPct), dS: _fin(S.agreementChosen.dS),
                sErr: S.sErr.value, sErrMode: S.sErr.mode, unitSlope: !!S.storage.unitSlope, cheldRejectedBoth: !!(S.cheld && S.cheld._rejectedBoth),
                rateSource: rq.source || 'allocation', r3: _fin(rq.r3), r3Status: rq.r3Status || 'unavailable', r4: _fin(rq.r4), r4Status: rq.r4Status || 'unavailable',
                dqKnown: rq.dqKnown !== false, fRate: _num(spec.fRate) ? spec.fRate : 1, equalRateAssumed: !!rq.equalRateAssumed,
                snrD: snr, rDrift: rDrift, rTide: p.rTide, tideRemoved: p.tideRemoved, flags: codes, distractorAtOrBeforeIarf: distr, humpAfterIarf: humpAfter,
                dtEnd_h: p.dtEnd, dteEnd_h: p.dteEnd, t10_h: S.reach.t10_h, t5_h: S.reach.t5_h, historySensitive: !!S.history.sensitive,
                outsideEnvelope: env, kHeld: false, kHeldConverged: null, kHeldCorrCS: null, kHeldRmsRatio: null, partialSuspect: null,
                windowLevelInconsistent: null, chosenKey: S.chosenKey, chosenFullySeen: S.chosenFit.fullySeen.status, triggers: S.trig.fired.slice(),
                dBicChosen: S.chosenKey === 'homogeneous' ? 0 : (cRow ? cRow.dBicHom : null), dBicNext: dNext, boundaryDepends: null,
                compositeOutOfRace: !!S.compositeOut, stage: 'pass1'
            };
            S.confidence = confidence(S.evidence, cal);
        });
        R.add('result', function () {
            var p = S.prep, ir = S.iarf, cf = S.chosenFit;
            var curves = _curves(p, S.hom, cf === S.hom ? null : cf);
            var chosenReason;
            if (ovr.model && ovr.model === S.chosenKey) chosenReason = 'Model forced by the engineer (override); it is still fitted and reported.';
            else if (S.chosenKey === 'homogeneous') chosenReason = S.trig.fired.length ? 'No rival better than homogeneous by more than ' + S.bic.tau + ' (BIC): homogeneous kept.'
                : (ir.found ? 'No trigger fired: homogeneous kept.' : 'No IARF (test too short): no rival fitted.');
            else chosenReason = LABELS[S.chosenKey] + ' better than homogeneous by ΔBIC ' + _fmt(S.evidence.dBicChosen, 3) + ' (threshold ' + S.bic.tau + ').';
            var reason = null;
            if (!ir.found) reason = S.trig.noneSkipped ? 'NO_IARF_TOO_SHORT' : (ir._noise ? 'NO_IARF_NOISE' : (S.chosenFit.fullySeen.status === 'full' ? 'NO_IARF_MODEL' : 'NO_IARF_NO_MODEL'));
            var warnings = p.warnings.slice();
            if (!ir.found) warnings.push(_warn(reason, 'warn', ir.reason, ['I1']));
            if (S.compositeOut) warnings.push(_warn('COMPOSITE_OUT', 'info', 'Possible radial composite — open in PRiSM.', ['M2']));
            var fitC4 = {
                modelKey: S.chosenKey, params: _copy(cf.params), phys: _physC4(cf, p), r2: _fin(cf._fr && cf._fr.r2), converged: !!cf.converged,
                ci95: _jsonClean(cf.ci95), kind: 'pressure', source: 'buildup'
            };
            var models = [S.hom].concat(S.rivals);
            var res = {
                ok: true, id: String(spec.id), version: AI.version, inputHash: inputHash, testType: p.sign < 0 ? 'falloff' : 'buildup', reason: reason,
                bins: { dt: p.bins.dt, dte: p.bins.dte, dp: p.bins.dp, n: p.bins.n, deriv: p.deriv.deriv, full: p.deriv.full, X: p.bins.X },
                quality: S.quality, storage: S.storage, reach: S.reach, iarf: ir, line: S.line, triggers: S.trig, flags: S.flags,
                models: models, bic: S.bic,
                chosen: { key: S.chosenKey, label: LABELS[S.chosenKey], fullySeen: S.chosenFit.fullySeen, reason: _txt(chosenReason), ev: ['M6', 'M5'] },
                agreement: S.agreementChosen, final: S.final, cheld: S.cheld || _cheldNone(S.hom), sErr: S.sErr, sensitivity: S.sensitivity,
                history: S.history, background: null, kHeld: null, confidence: S.confidence, curves: curves, fitC4: fitC4, warnings: warnings,
                evidence: S.evidence
            };
            S.result = _jsonClean(res);
            S.result.evidence.stage = 'pass1';
        });
        var nUnits0 = 6;
        return {
            step: function () {
                if (S.result || S.cancelled) return { done: true, progress: 1, label: label0 };
                var lbl = R.step();
                var done = !!S.result || R.idle();
                if (done && !S.result) S.result = _failResult(spec, 'INCOMPLETE', ['The interpretation did not complete.']);
                var c = R.count(), pend = R.pending();
                return { done: done, progress: done ? 1 : Math.min(0.99, c / (c + pend + 1 + Math.max(0, nUnits0 - c))), label: label0 + (lbl ? ': ' + lbl : '') };
            },
            result: function () { return S.result; },
            cancel: function () { S.cancelled = true; R.cancel(); }
        };
    }
    function interpret(spec, opts) { return _runJob(interpretJob(spec, opts)); }

    function _cheldNone(mf) {
        var k = mf && mf.phys ? mf.phys.k : null, S = mf && mf.phys ? mf.phys.S : null, C = mf && mf.phys ? mf.phys.C : null;
        return { triggered: false, mode: 'pair', refits: [], range: { C: [C, C], k: [k, k], S: [S, S] }, S_C: 0, meaningful: true, ev: ['C1'] };
    }
    function _physC4(mf, prep) {
        var w = prep.well, o = {};
        Object.keys(mf.phys).forEach(function (k) { if (_num(mf.phys[k])) o[k] = mf.phys[k]; });
        if (_pos(o.k)) o.kh = o.k * w.h;
        if (_pos(o.C)) o.Cd = C_CD * o.C / (w.phi * w.ct * w.h * w.rw * w.rw);
        return o;
    }
    function _envelope(cal, x) {
        var c = _cal(cal);
        if (!c || !c.envelope) return false;
        var e = c.envelope, w = x.well;
        var CD = C_CD * x.C / (w.phi * w.ct * w.h * w.rw * w.rw);
        var tDCD = 0.0002951 * x.k * w.h * x.dteEnd / (w.mu * x.C);
        var chk = [['CD', CD], ['S', x.S], ['tDCDend', tDCD], ['snrD', x.snrD], ['k', x.k], ['dtEnd_h', x.dtEnd]];
        return chk.some(function (q) { var r = e[q[0]]; return Array.isArray(r) && _num(q[1]) && (q[1] < r[0] || q[1] > r[1]); });
    }
    function _curves(prep, hom, ch) {
        var b = prep.bins, n = 40, t0 = b.dt[0], t1 = b.dt[b.dt.length - 1], dt = [];
        for (var i = 0; i < n; i++) dt.push(t0 * Math.pow(t1 / t0, i / (n - 1)));
        function one(mf) {
            var pm = _pmFor(mf.key, prep, mf._entry);
            if (!pm) return { dp: dt.map(function () { return null; }), deriv: dt.map(function () { return null; }) };
            STATS.evals++;
            var dpm = pm.dp(dt, mf._physPm);
            var X = dt.map(function (v) { return prep.time.lnDte(v); });
            var dd = [];
            for (var k = 0; k < n; k++) {   // central differences on ln Δt_e (display only)
                var a = Math.max(0, k - 1), c = Math.min(n - 1, k + 1);
                dd.push((dpm[c] - dpm[a]) / (X[c] - X[a]));
            }
            return { dp: dpm, deriv: dd };
        }
        return { dt: dt, hom: hom && hom.ok ? one(hom) : { dp: [], deriv: [] }, chosen: ch && ch.ok ? one(ch) : null };
    }
    function _historyCheck(prep, hom, ir, tPrepend) {
        var out = { estimated: true, dDerivPct: null, sensitive: false, ev: ['R5'] };
        var st = prep.histFull.steps.map(function (s) { return { t: s.t, q: s.q }; });
        st[0].t -= tPrepend;     // the prepended period doubled
        var comp2 = compactHistory(st, prep.spec.tc_h, prep.dtEnd, { keepFactor: 10 });
        var tm2 = _makeTime(st, prep.spec.tc_h);
        if (!tm2) return out;
        var ad2 = _copy(prep.adata);
        ad2.rateHistory = comp2.steps.map(function (s) { return { t: s.t, q: prep.sign < 0 ? -s.q : s.q }; });
        var tmf2 = _makeTime(comp2.steps, prep.spec.tc_h);
        ad2.timeFnSpec = { kind: 'superposition', tp: tmf2.tpEff, terms: tmf2.c2terms };
        if (typeof G.PRiSM_physicalModel !== 'function') return out;
        var pm1 = _pmFor('homogeneous', prep, hom._entry), pm2 = null;
        try { pm2 = G.PRiSM_physicalModel('homogeneous', prep.well, ad2, { entry: hom._entry, isolated: true, mode: 'physical' }); } catch (e) { pm2 = null; }
        if (!pm1 || !pm2 || !pm2.ok) return out;
        var t = prep.bins.dt;
        STATS.evals += 2;
        var d1 = pm1.dp(t, hom._physPm), d2 = pm2.dp(t, hom._physPm);
        var X1 = t.map(function (v) { return prep.time.lnDte(v); }), X2 = t.map(function (v) { return tm2.lnDte(v); });
        var D1 = derivative(X1, d1, prep.Lcyc), D2 = derivative(X2, d2, prep.Lcyc);
        var mx = 0;
        for (var i = ir._a; i <= ir._b; i++) {
            if (D1.full[i] && D2.full[i] && D1.deriv[i] > 0) mx = Math.max(mx, Math.abs(D2.deriv[i] / D1.deriv[i] - 1));
        }
        out.dDerivPct = 100 * mx;
        out.sensitive = _rdp(out.dDerivPct, 0.1) > DEFAULTS.history.maxDerivPct;
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // drive(job, opts) — the only timer user in Round 8 (D19)
    // ─────────────────────────────────────────────────────────────────────
    // step(), then a one-shot setTimeout(0) yield, then shouldCancel() and the
    // progress callback; repeat until done. Cancel rejects with {code:'CANCELLED'}
    // at the next yield, so no timer remains; it never re-arms while idle.
    function drive(job, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            function tick() {
                var s;
                try {
                    if (opts.shouldCancel && opts.shouldCancel()) { if (job.cancel) job.cancel(); reject({ code: 'CANCELLED' }); return; }
                    s = job.step();
                    if (typeof opts.onProgress === 'function') { try { opts.onProgress(s.progress, s.label); } catch (e0) { /* listener error ignored */ } }
                } catch (e) { reject(e); return; }
                if (s.done) { resolve(job.result()); return; }
                setTimeout(tick, 0);
            }
            tick();
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Public surface (§3.1)
    // ─────────────────────────────────────────────────────────────────────
    AI.DEFAULTS = DEFAULTS;
    AI.bin = bin;
    AI.derivative = derivative;
    AI.prepare = prepare;
    AI.storage = storage;
    AI.iarf = function (prep, opts) { var r = iarf(prep, opts); return r; };
    AI.line = line;
    AI.gridEntry = gridEntry;
    AI.fitJob = fitJob;
    AI.fit = fit;
    AI.reach = reach;
    AI.predictors = predictors;
    AI.triggers = function (prep, ir, rch) { var t = triggers(prep, ir, rch); return { triggers: t.triggers, flags: t.flags }; };
    AI.flags = flagsFor;
    AI.bic = bic;
    AI.fullySeen = fullySeen;
    AI.agreement = agreement;
    AI.cHeldJob = cHeldJob;
    AI.pStarRange = pStarRange;
    AI.pExt = pExt;
    AI.kHeldJob = kHeldJob;
    AI.sErr = sErr;
    AI.sensitivity = sensitivity;
    AI.confidence = confidence;
    AI.rinv = rinv;
    AI.compactHistory = compactHistory;
    AI.gasTable = gasTable;
    AI.backgroundCheck = backgroundCheck;
    AI.interpretJob = interpretJob;
    AI.interpret = interpret;
    AI.drive = drive;
    AI.stats = stats;
    AI.resetStats = resetStats;
    AI.evalsPerSlice = evalsPerSlice;
    AI.clean = _jsonClean;
    AI.thresholds = function (cal) { return _thr(cal); };

    AI.kernels = {
        closedCircleLap: function (s, reD) { return _lapClosedCircle(reD)(s, 1); },
        composite2Lap: function (s, M, F, R) { return _lapComposite2(M, F, R)(s, 1); },
        homogeneousLap: function (s) { return _lapHom(s); },
        bessel: { I0e: I0e, I1e: I1e, K0e: K0e, K1e: K1e },
        pair: function (key, td, params) { return _pair(_lapFor(key, params), td, params.Cd, params.S, true); }
    };
    function _lapFor(key, p) {
        if (key === 'closedCircle') return _lapClosedCircle(p.reD);
        if (key === 'composite2') return _lapComposite2(p.M, _num(p.F) ? p.F : 1, p.R);
        if (key === 'linearBoundary') return _lapFault(p.dF, p.BC);
        return _lapHom;
    }

})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var AI = G.PRiSM_autoInterp;
    if (!AI || typeof AI.canon !== 'function' || typeof AI.hash16 !== 'function') return;
    var checks = [];
    function chk(name, ok) { checks.push([name, !!ok]); }
    chk('hash16 empty', AI.hash16('') === '811c9dc5050c5d1f');
    chk('hash16 abc', AI.hash16('abc') === '1a47e90bb9de7311');
    chk('hash16 null', AI.hash16(null) === AI.hash16(''));
    chk('key order', AI.canon({ b: 1, a: [1, 2] }) === AI.canon({ a: [1, 2], b: 1 }));
    chk('inputs 6 sf', AI.canon({ x: 1.23456789 }, 'inputs') === '{"x":1.23457}');
    chk('epoch whole s', AI.canon({ tc_ms: 1772366400499 }, 'inputs') === '{"tc_ms":1772366400000}');
    chk('non-finite', AI.canon([NaN, Infinity, -0, undefined], 'display') === '[null,null,0,null]');
    chk('zero floor', AI.canon({ x: 1e-15, y: -3e-13 }, 'display') === '{"x":0,"y":0}');
    chk('display k/S/p', AI.canon({ k: 45.678, S: 4.6666, pStar: 3999.96 }, 'display') === '{"S":4.67,"k":45.7,"pStar":4000}');
    // WP1 pure pieces
    if (typeof AI.bin === 'function') {
        var dts = [], ps = [];
        for (var i = 0; i < 100; i++) { dts.push(0.01 * Math.pow(10, i / 50)); ps.push(i); }
        var b = AI.bin(dts, ps, { perCycle: 20 });
        chk('bin 20/cycle', b.dt.length === 40 && b.n[0] === 3);
        var X = [], dp = [];
        for (var j = 0; j < 30; j++) { X.push(j * 0.05 * Math.LN10); dp.push(30 * X[j]); }
        var dv = AI.derivative(X, dp, 0.1);
        chk('derivative plateau', Math.abs(dv.deriv[10] - 30) < 1e-9 && dv.full[1] === false && dv.full[2] === true);
        var se = AI.sErr({ mode: 'line', floor: 0.2, seS: 0.1, sLine: 1, sMatch: 1.3, sWin: 0.1, sTc: 0, sPwf: 0 });
        chk('sErr max of terms', Math.abs(se.value - 0.3) < 1e-12 && se.driver === 'lineMatch');
        var sv = AI.sensitivity({ k: 45, S: 5 }, null);
        chk('sensitivity rw', sv.dominantS.req === 'rw' && sv.dominantK.req === 'h');
        var ch = AI.compactHistory([{ t: -1000, q: 100 }, { t: -500, q: 200 }, { t: -10, q: 150 }, { t: 0, q: 0 }], 0, 5, {});
        chk('compaction keeps volume', ch.nLumped === 2 && Math.abs(ch.lumped.V - (100 * 500 + 200 * 450)) < 1e-9);
        var k0 = AI.kernels.bessel.K0e(1) / Math.E;
        chk('K0(1)', Math.abs(k0 - 0.42102443824070834) < 1e-14);
        chk('evalsPerSlice', AI.evalsPerSlice('homogeneous', 1, 65, 3) === 11);
    }
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[53-prism-autointerp self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.PRiSM_autoInterp_selfTest = checks;
})();
