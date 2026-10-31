// =============================================================================
// WTS — Round-9 helper module — Build-up Surveillance: review, Q&A, report model, sign-off, AI export
// helper module: does not add a page to window.WTS_calcRegistry
// -----------------------------------------------------------------------------
// window.WTS_buildup.review (plan docs/BUILDUP-SURVEILLANCE-PLAN.md §3.10, §7, §8; work package WP5).
// Pure and synchronous: no DOM, no storage, no timers, no events, no network, no random numbers.
//
// PUBLIC API (window.WTS_buildup.review)
//   evidence(analysis, opts?)            → EvidenceIndex. Every quotable number lives here with the path it is read
//                                          from; derived numbers also carry the formula that recomputes them. A derived
//                                          number the engine stores (m, Δp_skin, r_inv, cycles, S_abs, sensitivity rows,
//                                          T7, oil T8) is quoted as stored (stored:true) and recomputed by check(), so a
//                                          stored value that disagrees with FORMULAS raises V14.
//                                          opts.cal: calibration table (default window.PRiSM_autoInterpCal).
//   run(analysis, idx?, opts?)           → Review: rules V1–V27 (V14 = evidence-check failures, never acceptable). The
//                                          evidence check covers the findings' values and every stored derived value of
//                                          the index. Review.resultHash = the results hash recomputed from the analysis.
//   check(obj, analysis, idx, ctx?)      → {ok, nChecked, nFailed, failures:[{ref, quoted, recomputed, tol}]}.
//                                          Walks every Value {v, cat, dp, ref} in a Review, Answer or ReportModel,
//                                          re-reads it from the analysis (full precision) or recomputes it with
//                                          FORMULAS, and compares at display precision (|q − r| ≤ ½·10^−dp). It
//                                          never reads text, so the formatter cannot change the result.
//                                          ctx {review, signoff, audit, cal} resolves '$review…' paths; a Value
//                                          whose context is missing is skipped (not failed).
//   recheck(review, analysis, idx?)      → review with V14 findings added for any quoted value that no longer
//                                          matches the analysis (mutates and returns the review).
//   ask(text, analysis, idx?, fmt?)      → Answer (19 intents, deterministic keyword and entity matching). An answer
//                                          that fails its own evidence check is marked (withheld:true, numbers
//                                          withheld) and never adds a review finding.
//   report(analysis, review, audit, signoff, fmt?, opts?) → ReportModel, sections S1–S12 (§8.2). Every number is a
//                                          Value with a ref; templates carry no numbers. The evidence check runs on
//                                          the model, on the review and on the stored derived values; a failure adds V14
//                                          to the review. Without a review S9 says the review was not run.
//                                          opts {selected:'B3', cal, idx (an index already built for this analysis)}.
//   sha256(str)                          → 64 hex (UTF-8, built-in synchronous implementation).
//   hashes(analysis, review)             → {inputsHash, resultsHash, decisionsHash} (hash16/canon from file 53).
//   signature(analysis, review, form)    → {hash, inputsHash, resultsHash, decisionsHash, appVersion, runAt}.
//   status(analysis, review, signoff)    → 'DRAFT' | 'SIGNED' | 'CHANGED' (CHANGED when one of the three hashes differs from the
//                                          signed ones, or when the review holds a V14 finding / a failed evidence check).
//   canSign(review)                      → {ok, open:[findingId]}.
//   signoff(form, analysis, review)      → Signoff (with ok:true) or {ok:false, code, errors, bad}; codes NO_NAME,
//                                          NO_STATEMENT, NO_ANALYSIS (no analysis or no hash16), EVIDENCE_CHECK_FAILED (also
//                                          when the review was run on another state of the analysis: Review.inputHash or
//                                          Review.resultHash differ from the analysis now), OPEN_FINDINGS. It re-runs the
//                                          evidence check of the review (recheck) before canSign.
//   applyDecisions(review, decisions)    → review with Finding.decision filled. decisions: array of
//                                          {target: findingKey | rule id | finding id, d, note, who, at} (later
//                                          entries win; d 'accept' | 'reject' | 'note'; null or 'clear' clears; any other
//                                          code is ignored) or an audit log (kind 'decision' entries).
//   aiExport(analysis, review, opts)     → {text, filename}. opts {deidentify:true, includeDates:false,
//                                          includeFreeText:false, signoff, fmt, idx}. No network, no URL.
//   audit.{append, verify, fold, head, entryHash, GENESIS}  audit chain (hash = hash16(prevHash + canon(entry)) with every
//                                          numeric leaf serialised exactly first, so no digit is rounded away), folded
//                                          beyond 500 entries into a summary that keeps the chain hash.
//   fill(template, values, fmt), blockText(block, fmt), headText(head, fmt), render(model, fmt) → plain text.
//   RULES, INTENTS, FORMULAS, K_TEXT, version.
//
// Formatter contract: fmt(v, cat, dp) → text (the page passes _uFmt). Optional fmt.unit(cat) → unit label for
// table heads. Every unit label in rendered text comes from fmt (templates never contain unit names).
//
// The re-derivation rules V23–V27 and the functions they use sit between the markers
// "RE-DERIVATION START" and "RE-DERIVATION END"; they never call the interpretation engine, run or trend.
// canon / hash16 are looked up on window.PRiSM_autoInterp at call time (file 53, frozen).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    // builtins held in locals: one lookup instead of a global lookup per call (much cheaper in sandboxed contexts)
    var MATH = Math, _isFin = isFinite, _isArr = Array.isArray;
    var BU = G.WTS_buildup = G.WTS_buildup || {};
    var RV = {};

    // ─────────────────────────────────────────────────────────────────────
    // 0. Utilities
    // ─────────────────────────────────────────────────────────────────────
    var LN10 = MATH.LN10;
    var GENESIS = '0000000000000000';
    var MAX_ROWS = 30;
    var DATE_RE = /^\d{4}-\d{2}-\d{2}/;

    function _isNum(v) { return typeof v === 'number' && _isFin(v); }
    function _allNum() { for (var i = 0; i < arguments.length; i++) if (!_isNum(arguments[i])) return false; return true; }
    function _obj(v) { return v !== null && typeof v === 'object' && !_isArr(v); }
    function _arr(v) { return _isArr(v) ? v : []; }
    function _str(v) { return (v === null || v === undefined) ? '' : String(v); }
    function _round(v, dp) { if (!_isNum(v)) return v; var f = MATH.pow(10, dp); var r = MATH.round(v * f) / f; return r === 0 ? 0 : r; }
    function _fixed(v, dp) { var s = v.toFixed(MATH.max(0, MATH.min(20, dp | 0))); return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s; }
    function _sfDp(v, n) {
        if (!_isNum(v) || v === 0) return MATH.max(0, n - 1);
        var e = MATH.floor(MATH.log(MATH.abs(v)) / LN10 + 1e-12);
        return MATH.max(0, MATH.min(8, n - 1 - e));
    }
    function _median(a) {
        var s = a.filter(_isNum).slice().sort(function (x, y) { return x - y; });
        var n = s.length; if (!n) return null;
        return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
    }
    function _uniq(a) { var seen = {}, out = []; a.forEach(function (x) { if (x != null && !seen[x]) { seen[x] = 1; out.push(x); } }); return out; }
    function _now(opts) { return (opts && typeof opts.at === 'string') ? opts.at : new Date().toISOString(); }
    function _AI() { var a = G.PRiSM_autoInterp; return (a && typeof a.canon === 'function' && typeof a.hash16 === 'function') ? a : null; }
    function _h16(obj, mode) { var a = _AI(); return a ? a.hash16(a.canon(obj, mode)) : null; }
    function _canon(obj, mode) { var a = _AI(); return a ? a.canon(obj, mode) : JSON.stringify(obj); }
    function _fluid(an) { return (an && an.well && an.well.fluid) || 'oil'; }
    function _dateOfMs(ms) { return _isNum(ms) ? new Date(ms).toISOString().slice(0, 10) : null; }
    function _dateOfIso(s) { return (typeof s === 'string' && DATE_RE.test(s)) ? s.slice(0, 10) : null; }
    function _pad2(n) { return (n < 10 ? '0' : '') + n; }
    function _clip(s, n) { s = _str(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

    // Path syntax: 'tests[2].result.final.k', 'missed.tooShort.length', '$review.counts.critical', '$analysis'.
    var _pathCache = typeof Map === 'function' ? new Map() : null, _pathObj = {};
    function _parsePath(p) {
        var hit = _pathCache ? _pathCache.get(p) : _pathObj[p];
        if (hit) return hit;
        var parts = [], re = /([^.[\]]+)|\[(\d+)\]/g, m;
        while ((m = re.exec(p)) !== null) parts.push(m[1] !== undefined ? m[1] : +m[2]);
        if (_pathCache) { if (_pathCache.size > 50000) _pathCache.clear(); _pathCache.set(p, parts); } else _pathObj[p] = parts;
        return parts;
    }
    function _ctxRoot(path) { return typeof path === 'string' && path.charAt(0) === '$' && path !== '$analysis' && path.indexOf('$analysis.') !== 0 && path.indexOf('$cal') !== 0; }
    function _get(roots, path) {
        if (typeof path !== 'string' || !path) return undefined;
        var parts = _parsePath(path), cur, i = 0;
        if (typeof parts[0] === 'string' && parts[0].charAt(0) === '$') { cur = roots[parts[0].slice(1)]; i = 1; }
        else cur = roots.analysis;
        for (; i < parts.length; i++) {
            if (cur === null || cur === undefined) return undefined;
            var k = parts[i];
            if (k === 'length' && (_isArr(cur) || typeof cur === 'string')) { cur = cur.length; continue; }
            cur = cur[k];
        }
        return cur;
    }
    function _roots(an, ctx) {
        ctx = ctx || {};
        return { analysis: an, review: ctx.review, signoff: ctx.signoff, audit: ctx.audit,
                 cal: ctx.cal || (G.PRiSM_autoInterpCal && typeof G.PRiSM_autoInterpCal === 'object' ? G.PRiSM_autoInterpCal : null) };
    }

    // ─────────────────────────────────────────────────────────────────────
    // 1. SHA-256 (FIPS 180-4) over the UTF-8 bytes of a string, synchronous
    // ─────────────────────────────────────────────────────────────────────
    var K256 = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    function _utf8(str) {
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
            else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
                var cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
                out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
            } else {
                if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;        // lone surrogate → U+FFFD (as TextEncoder does)
                out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            }
        }
        return out;
    }
    function sha256(str) {
        var bytes = _utf8(str === null || str === undefined ? '' : String(str));
        var len = bytes.length;
        var hi = MATH.floor(len / 0x20000000), lo = (len * 8) >>> 0;
        bytes.push(0x80);
        while ((bytes.length % 64) !== 56) bytes.push(0);
        bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
        var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        var W = new Array(64), t, s0, s1;
        for (var off = 0; off < bytes.length; off += 64) {
            for (t = 0; t < 16; t++) {
                var j = off + 4 * t;
                W[t] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
            }
            for (t = 16; t < 64; t++) {
                var w15 = W[t - 15], w2 = W[t - 2];
                s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
                s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
                W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
            }
            var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
            for (t = 0; t < 64; t++) {
                var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
                var ch = (e & f) ^ (~e & g);
                var T1 = (h + S1 + ch + K256[t] + W[t]) | 0;
                var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var T2 = (S0 + maj) | 0;
                h = g; g = f; f = e; e = (d + T1) | 0; d = c; c = b; b = a; a = (T1 + T2) | 0;
            }
            H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
            H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
        }
        var hex = '';
        for (var k = 0; k < 8; k++) hex += ('0000000' + (H[k] >>> 0).toString(16)).slice(-8);
        return hex;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 2. FORMULAS — the review's own registry (field units). Every function carries .args and .text.
    //    The physics entries share their names and argument order with the test-only table in
    //    tests/_buildup-shapes.js (RV12 checks that both agree on FIX.analysis).
    // ─────────────────────────────────────────────────────────────────────
    function F(args, text, fn) { fn.args = args; fn.text = text; return fn; }
    var SENS_COEF = { h: 1.1513, phi: 1.1513, ct: 1.1513, rw: 2.3026, B: -1.1513, q: -1.1513, mu: 0 };
    function _sensK(input, f, k) { return input === 'h' ? k / f : (input === 'B' || input === 'mu' || input === 'q') ? k * f : k; }

    var FORMULAS = {
        // ── physics (shared names) ──
        m: F(['Dq', 'B', 'mu', 'k', 'h'], 'm = 162.6·Δq·B·μ/(k·h)  [psi/cycle]',
            function (Dq, B, mu, k, h) { return _allNum(Dq, B, mu, k, h) && k * h !== 0 ? 162.6 * Dq * B * mu / (k * h) : null; }),
        mPrime: F(['m'], 'm′ = m/ln 10  [psi]', function (m) { return _isNum(m) ? m / LN10 : null; }),
        dpSkin: F(['m', 'S'], 'Δp_skin = 0.8686·m·S  [psi]', function (m, S) { return _allNum(m, S) ? 0.8686 * m * S : null; }),
        X: F(['re_ft', 'rw'], 'X = ln(r_e/rw) − 0.75', function (re, rw) { return _allNum(re, rw) && re > 0 && rw > 0 ? MATH.log(re / rw) - 0.75 : null; }),
        piRatio: F(['X', 'S'], 'PI ratio = X/(X + S)', function (X, S) { return _allNum(X, S) && X + S !== 0 ? X / (X + S) : null; }),
        rateAtStake: F(['qNow', 'X', 'Snow', 'Sbase'], 'rate at stake = q_now·[(X + S_now)/(X + S_base) − 1]',
            function (q, X, Sn, Sb) { return _allNum(q, X, Sn, Sb) && X + Sb !== 0 ? q * ((X + Sn) / (X + Sb) - 1) : null; }),
        extraDrawdown: F(['q', 'B', 'mu', 'dS', 'k', 'h'], 'extra drawdown = 141.2·q·B·μ·ΔS/(k·h)  [psi]',
            function (q, B, mu, dS, k, h) { return _allNum(q, B, mu, dS, k, h) && k * h !== 0 ? 141.2 * q * B * mu * dS / (k * h) : null; }),
        dkPct: F(['k', 'kRef'], 'dk% = 100·(k/k_ref − 1)', function (k, kRef) { return _allNum(k, kRef) && kRef !== 0 ? 100 * (k / kRef - 1) : null; }),
        rinv: F(['k', 'dt', 'phi', 'mu', 'ct'], 'r_inv = 0.0325·√(k·Δt/(φ·μ·ct))  [ft]',
            function (k, dt, phi, mu, ct) { return _allNum(k, dt, phi, mu, ct) && phi * mu * ct > 0 && k * dt >= 0 ? 0.0325 * MATH.sqrt(k * dt / (phi * mu * ct)) : null; }),
        dte: F(['dt', 'tp'], 'Δt_e = tp·Δt/(tp + Δt)  [h]', function (dt, tp) { return _allNum(dt, tp) && tp + dt !== 0 ? tp * dt / (tp + dt) : null; }),
        shutOfDte: F(['dte', 'tp'], 'Δt = Δt_e·tp/(tp − Δt_e), null when Δt_e ≥ tp  [h]', function (dte, tp) { return _allNum(dte, tp) && dte < tp ? dte * tp / (tp - dte) : null; }),
        xOfDte: F(['dte'], 'X = log10 Δt_e  [cycles]', function (dte) { return _isNum(dte) && dte > 0 ? MATH.log(dte) / LN10 : null; }),
        dteOfX: F(['X'], 'Δt_e = 10^X  [h]', function (X) { return _isNum(X) ? MATH.pow(10, X) : null; }),
        logTerm: F(['k', 'phi', 'mu', 'ct', 'rw'], 'log10(k/(φ·μ·ct·rw²)) − 3.2275',
            function (k, phi, mu, ct, rw) { return _allNum(k, phi, mu, ct, rw) && k > 0 && phi * mu * ct * rw > 0 ? MATH.log(k / (phi * mu * ct * rw * rw)) / LN10 - 3.2275 : null; }),
        pStar: F(['pwf0', 'm', 'tp', 'logTerm', 'S'], 'p* = pwf0 + m·[log10 tp + logTerm + 0.8686·S]  [psia]',
            function (pwf0, m, tp, lt, S) { return _allNum(pwf0, m, tp, lt, S) && tp > 0 ? pwf0 + m * (MATH.log(tp) / LN10 + lt + 0.8686 * S) : null; }),
        p1hr: F(['pStar', 'm', 'tp'], 'p1hr = p* − m·log10(tp + 1)  [psia]', function (pStar, m, tp) { return _allNum(pStar, m, tp) && tp > -1 ? pStar - m * MATH.log(tp + 1) / LN10 : null; }),
        reachFair: F(['t5', 'Lcyc'], 'reach.fair = 10^(0.5 + Lcyc)·t_5%  [h]', function (t5, L) { return _allNum(t5, L) ? MATH.pow(10, 0.5 + L) * t5 : null; }),
        reachGood: F(['t5', 'Lcyc'], 'reach.good = 10^(1 + Lcyc)·t_5%  [h]', function (t5, L) { return _allNum(t5, L) ? MATH.pow(10, 1 + L) * t5 : null; }),
        sTc: F(['dpdt', 'dtc_h', 'm'], 'S_tc = 1.1513·|dp/dt_flow|·δt_c/m', function (dpdt, dtc, m) { return _allNum(dpdt, dtc, m) && m !== 0 ? 1.1513 * MATH.abs(dpdt) * dtc / m : null; }),
        sPwf: F(['pwf0SE', 'm'], 'S_pwf = 1.1513·se(pwf0)/m', function (se, m) { return _allNum(se, m) && m !== 0 ? 1.1513 * se / m : null; }),
        rDrift: F(['driftPsiPerDay', 'dtEnd_h', 'mPrime'], 'r_drift = (d/24)·Δt_end/m′', function (d, dtEnd, mp) { return _allNum(d, dtEnd, mp) && mp !== 0 ? (d / 24) * dtEnd / mp : null; }),
        sensDS: F(['input', 'f'], 'ΔS for input × f: +1.1513·log10 f (h, φ, ct), +2.3026·log10 f (rw), −1.1513·log10 f (B, q), 0 (μ)',
            function (input, f) { return (SENS_COEF.hasOwnProperty(input) && _isNum(f) && f > 0) ? SENS_COEF[input] * MATH.log(f) / LN10 : null; }),
        sensK: F(['input', 'f', 'k'], 'k for input × f: k/f (h), k·f (B, μ, q), k (φ, ct, rw)',
            function (input, f, k) { return (SENS_COEF.hasOwnProperty(input) && _allNum(f, k) && f > 0) ? _sensK(input, f, k) : null; }),
        sKAnalytic: F(['delta', 'dpEnd', 'm'], 'S_kAnalytic = δ·(ln 10·Δp_end/(2·m) − 0.5)',
            function (delta, dpEnd, m) { return _allNum(delta, dpEnd, m) && m !== 0 ? delta * (LN10 * dpEnd / (2 * m) - 0.5) : null; }),
        atStakeDay: F(['q', 'X', 'S', 'Sbase'], 'one day of the cumulative at stake: q_d·[(X + S(t_d))/(X + S_base) − 1]',
            function (q, X, S, Sb) { return _allNum(q, X, S, Sb) && X + Sb !== 0 ? q * ((X + S) / (X + Sb) - 1) : null; }),
        jObs: F(['q', 'pRef', 'pwf'], 'J_obs = q_d/(p_ref,d − pwf_d)', function (q, pRef, pwf) { return _allNum(q, pRef, pwf) && pRef !== pwf ? q / (pRef - pwf) : null; }),
        jPred: F(['k', 'h', 'B', 'mu', 'X', 'S'], 'J_pred = k·h/(141.2·B·μ·(X + S))',
            function (k, h, B, mu, X, S) { return _allNum(k, h, B, mu, X, S) && B * mu * (X + S) !== 0 ? k * h / (141.2 * B * mu * (X + S)) : null; }),
        modelFreeDS: F(['dpj', 'qj', 'dpb', 'qb', 'mOverQb', 'dtej', 'dteb'], 'ΔS = 1.1513·[(Δp_j/q_j − Δp_b/q_b)/(m/q)_b − log10(Δt_e,j/Δt_e,b)]',
            function (dpj, qj, dpb, qb, mq, dtej, dteb) {
                return _allNum(dpj, qj, dpb, qb, mq, dtej, dteb) && qj * qb * mq !== 0 && dtej > 0 && dteb > 0 ? 1.1513 * ((dpj / qj - dpb / qb) / mq - MATH.log(dtej / dteb) / LN10) : null;
            }),
        kStar: F(['truth', 'given', 'f'], 'k* = f·k·(B′/B)·(μ′/μ)·(h/h′)',
            function (t, g, f) { return (_obj(t) && _obj(g) && _isNum(f)) ? f * t.k * (g.B / t.B) * (g.mu / t.mu) * (t.h / g.h) : null; }),
        SStar: F(['truth', 'given', 'f'], 'S* = S + 1.1513·log10((h′/h)(φ′/φ)(ct′/ct)) + 2.3026·log10(rw′/rw) − 1.1513·log10((B′/B)·f)',
            function (t, g, f) {
                if (!(_obj(t) && _obj(g) && _isNum(f))) return null;
                return t.S + 1.1513 * MATH.log((g.h / t.h) * (g.phi / t.phi) * (g.ct / t.ct)) / LN10 + 2.3026 * MATH.log(g.rw / t.rw) / LN10 - 1.1513 * MATH.log((g.B / t.B) * f) / LN10;
            }),

        // ── review helpers (derived numbers and texts quoted by the report) ──
        sensDkPct: F(['input', 'f'], 'dk% for input × f = 100·(k(f)/k − 1)',
            function (input, f) { return (SENS_COEF.hasOwnProperty(input) && _isNum(f) && f > 0) ? 100 * (_sensK(input, f, 1) - 1) : null; }),
        extraDrawdownS: F(['q', 'B', 'mu', 'Snow', 'Sbase', 'k', 'h'], 'extra drawdown = 141.2·q_now·B·μ·(S_now − S_base)/(k_now·h)  [psi]',
            function (q, B, mu, Sn, Sb, k, h) { return _allNum(q, B, mu, Sn, Sb, k, h) && k * h !== 0 ? 141.2 * q * B * mu * (Sn - Sb) / (k * h) : null; }),
        cumAtStake: F(['an'], 'cumulative at stake since the onset: Σ_days q_d·[(X + S(t_d))/(X + S_base) − 1] (oil; S(t) through the used tests with the onset knot)',
            function (an) { return _cumAtStake(an); }),
        cycles: F(['X0', 'X1'], 'cycles = X1 − X0 (log10 Δt_e)', function (a, b) { return _allNum(a, b) ? b - a : null; }),
        sub: F(['a', 'b'], 'a − b', function (a, b) { return _allNum(a, b) ? a - b : null; }),
        neg: F(['a'], '−a', function (a) { return _isNum(a) ? -a : null; }),
        add: F(['a', 'b'], 'a + b', function (a, b) { return _allNum(a, b) ? a + b : null; }),
        rss: F(['a', 'b'], '√(a² + b²)', function (a, b) { return _allNum(a, b) ? MATH.sqrt(a * a + b * b) : null; }),
        pct100: F(['x'], '100·x', function (x) { return _isNum(x) ? 100 * x : null; }),
        scale: F(['x', 'f'], 'x·f (unit change, e.g. Mscf → MMscf)', function (x, f) { return _allNum(x, f) ? x * f : null; }),
        cvLim: F(['allocAccPct'], 'max(5 %, allocation accuracy)', function (a) { return _isNum(a) ? MATH.max(5, a) : 5; }),
        lit: F(['x'], 'the quoted literal (question input)', function (x) { return x === undefined ? null : x; }),
        yesNo: F(['x'], "'yes' | 'no'", function (x) { return x === true ? 'yes' : x === false ? 'no' : null; }),
        join: F(['x'], 'list joined with commas', function (x) { return _isArr(x) ? (x.length ? x.join(', ') : 'none') : null; }),
        joinCodes: F(['x'], 'flag codes joined', function (x) { return _isArr(x) ? (x.length ? x.map(function (f) { return f && f.code; }).filter(Boolean).join(', ') : 'none') : null; }),
        joinRules: F(['x'], 'confidence rule ids joined', function (x) { return _isArr(x) ? (x.length ? _uniq(x.map(function (r) { return r && r.rule; })).join(', ') : 'none') : null; }),
        joinDefaulted: F(['x'], 'defaulted physical inputs', function (x) {
            if (!_isArr(x)) return null;
            var phys = x.filter(function (k) { return ['h', 'mu', 'B', 'phi', 'ct', 'rw'].indexOf(k) !== -1; });
            return phys.length ? phys.join(', ') : 'none';
        }),
        labelPair: F(['ks', 'headline'], "'k/S label · headline label'", function (a, b) { return (a && b) ? a + ' · ' + b : null; }),
        older: F(['n', 'shown'], 'max(0, n − shown)', function (n, s) { return _allNum(n, s) ? MATH.max(0, n - s) : null; }),
        dateOfIso: F(['iso'], 'date part of an ISO time', function (s) { return _dateOfIso(s); }),
        dateOfMs: F(['ms'], 'UTC date of an epoch-ms time', function (ms) { return _dateOfMs(ms); }),
        timeText: F(['ms', 'zone'], 'epoch ms as a date and time in the resolved gauge zone', function (ms, zone) { return _timeText(ms, zone); }),
        zoneText: F(['zone'], 'resolved zone name', function (z) { return _zoneText(z); }),
        prefix16: F(['h'], 'first 16 hex characters', function (h) { return typeof h === 'string' ? h.slice(0, 16) : null; }),
        prefix8: F(['h'], 'first 8 hex characters', function (h) { return typeof h === 'string' ? h.slice(0, 8) : null; }),
        rawText: F(['raw'], 'raw gauge data embedded or not', function (r) { return (r === 'idb' || r === 'memory') ? 'embedded' : 'not embedded; interpretation and trend reproduce from the stored build-ups'; }),
        basisText: F(['basis'], 'absolute alert basis', function (b) { return b === 'mechanical' ? 'mechanical skin' : b === 'total' ? 'total skin (may include geometric pseudo-skin)' : null; }),
        baseState: F(['unstable', 'provisional'], 'baseline state', function (u, p) { return u && p ? 'unstable and provisional' : u ? 'unstable' : p ? 'provisional' : 'stable'; }),
        rivalCount: F(['models'], 'number of rival fits', function (m) { return _isArr(m) ? MATH.max(0, m.length - 1) : null; }),
        resultsHashOf: F(['an'], 'results hash (display-precision canon of finals, S_err, labels, alerts, onset, recent slope)', function (an) { return _resultsHash(an); }),
        results8: F(['an'], 'results hash, first 8', function (an) { var h = _resultsHash(an); return h ? h.slice(0, 8) : null; }),
        decisionsHashOf: F(['review'], 'decisions hash', function (rv) { return _decisionsHash(rv); }),
        openCount: F(['review'], 'open critical/major findings', function (rv) { return _obj(rv) ? canSign(rv).open.length : null; }),
        moreFindings: F(['review', 'shown'], 'findings beyond the shown rows', function (rv, s) { return _obj(rv) && _isNum(s) ? MATH.max(0, _arr(rv.findings).length - s) : null; }),
        chainHead: F(['audit'], 'audit chain head', function (a) { return _auditLog(a) ? auditHead(a) : null; }),
        auditFolded: F(['audit'], 'folded audit entries', function (a) { var L = _auditLog(a); return L ? (L.summary && _isNum(L.summary.n) ? L.summary.n : 0) : null; }),
        testList: F(['tests'], 'test ids', function (t) { return _isArr(t) ? (t.length ? t.map(function (x) { return x && x.id; }).join(', ') : 'none') : null; }),
        excludedList: F(['tests'], 'excluded or not analysed tests', function (t) {
            if (!_isArr(t)) return null;
            var l = t.filter(function (x) { return x && x.status !== 'interpreted'; }).map(function (x) { return x.id + ' (' + x.status + ')'; });
            return l.length ? l.join(', ') : 'none';
        }),
        reachShort: F(['an'], 'tests whose fair reach exceeds Δt_e,end', function (an) { return _reachSummary(an).nShort; }),
        reachTests: F(['an'], 'interpreted tests with a reach', function (an) { return _reachSummary(an).n; }),
        fairShutMedian: F(['an'], 'median fair-IARF shut-in (h)', function (an) { return _reachSummary(an).fair; }),
        goodShutMedian: F(['an'], 'median good-IARF shut-in (h)', function (an) { return _reachSummary(an).good; }),
        rhoSq: F(['an'], 'Spearman ρ(S, Δq) over the used tests', function (an) { return _rhoSq(an); }),
        bubbleBelow: F(['an'], 'tests with sandface pwf below Pb', function (an) { return _bubbleCount(an).below; }),
        bubbleN: F(['an'], 'tests in the bubble-point check', function (an) { return _bubbleCount(an).n; }),
        mfAgree: F(['rows'], 'model-free rows that agree', function (r) { return _isArr(r) ? r.filter(function (x) { return x && x.agrees; }).length : null; }),
        minMargin: F(['rows'], 'lowest bubble-point margin', function (r) { var m = _arr(r).map(function (x) { return x && x.margin; }).filter(_isNum); return m.length ? MATH.min.apply(null, m) : null; }),
        maxOf: F(['xs'], 'largest value', function (xs) { var m = _arr(xs).filter(_isNum); return m.length ? MATH.max.apply(null, m) : null; }),
        dteEnd: F(['evDte', 'dte', 'dtEnd', 'steps', 'from', 'to'], 'Δt_e at the end of the test (evidence, bins or the rate history)', function (evDte, dte, dtEnd, steps, from, to) {
            if (_isNum(evDte)) return evDte;
            if (_isArr(dte) && dte.length && _isNum(dte[dte.length - 1])) return dte[dte.length - 1];
            var r = _dteFromSteps([dtEnd], steps, from, to);
            return r ? r[0] : null;
        }),
        alertShift: F(['an', 'which', 'shift'], 'alert status with every skin shifted by ΔS', function (an, which, shift) { var r = _alertRecompute(an, which, shift); return r ? r.status : null; }),
        alertShiftAt: F(['an', 'which', 'shift'], 'first confirmed test with every skin shifted by ΔS', function (an, which, shift) { var r = _alertRecompute(an, which, shift); return r ? (r.confirmedAt || r.raisedAt || 'none') : null; })
    };

    // ─────────────────────────────────────────────────────────────────────
    // ── RE-DERIVATION START ── (V23–V27 and the functions they use: stored data only, no engine calls)
    // ─────────────────────────────────────────────────────────────────────
    function _rdNum(v) { return typeof v === 'number' && _isFin(v); }
    function _rdRound(v, dp) { var f = MATH.pow(10, dp); var r = MATH.round(v * f) / f; return r === 0 ? 0 : r; }
    // Superposition equivalent time from the stored rate history (stepRef into analysis.rates.steps, the last step
    // being the q = 0 step at t_c): log10 Δt_e = log10 Δt − Σ_{i<N} w_i·log10((t_c − τ_i + Δt)/(t_c − τ_i)), w_i = Δq_i/Δq.
    function _dteFromSteps(dts, steps, from, to) {
        if (!_isArr(dts) || !_isArr(steps) || !_rdNum(from) || !_rdNum(to) || to <= from || to >= steps.length) return null;
        var last = steps[to]; if (!last || !_rdNum(last.t_ms)) return null;
        var dq = steps[to - 1] && _rdNum(steps[to - 1].q) ? steps[to - 1].q : null;
        if (!dq) return null;
        var terms = [], qPrev = 0;
        for (var i = from; i < to; i++) {
            var s = steps[i]; if (!s || !_rdNum(s.t_ms) || !_rdNum(s.q)) return null;
            var age = (last.t_ms - s.t_ms) / 3600000;
            if (age > 0) terms.push({ w: (s.q - qPrev) / dq, age: age });
            qPrev = s.q;
        }
        return dts.map(function (dt) {
            if (!_rdNum(dt) || dt <= 0) return null;
            var lg = MATH.log(dt);
            for (var j = 0; j < terms.length; j++) lg -= terms[j].w * MATH.log((terms[j].age + dt) / terms[j].age);
            return MATH.exp(lg);
        });
    }
    // k from the IARF derivative level: k = 70.6·Δq·B·μ/(m′·h)  (V23)
    function _rdKLevel(Dq, B, mu, level, h) { return (_rdNum(Dq) && _rdNum(B) && _rdNum(mu) && _rdNum(level) && _rdNum(h) && level > 0 && h > 0) ? 70.6 * Dq * B * mu / (level * h) : null; }
    // Mean point skin over the stored IARF window (V24): S_i = 0.5·[Δp_i/m′ − ln(k·Δt_e,i/(φ·μ·ct·rw²)) + 7.4316],
    // with k from the same level, so the result is independent of the fitted k.
    function _rdPointSkinMean(dp, dte, dt, X0, X1, level, Dq, B, mu, h, phi, ct, rw, steps, from, to) {
        if (!_isArr(dp) || !_rdNum(X0) || !_rdNum(X1) || X1 <= X0) return null;
        var k = _rdKLevel(Dq, B, mu, level, h);
        if (!k || !_rdNum(phi) || !_rdNum(ct) || !_rdNum(rw) || phi * mu * ct * rw <= 0) return null;
        var te = (_isArr(dte) && dte.length === dp.length) ? dte : _dteFromSteps(dt, steps, from, to);
        if (!te) return null;
        var lo = MATH.pow(10, X0) * (1 - 1e-6), hi = MATH.pow(10, X1) * (1 + 1e-6), sum = 0, n = 0;
        for (var i = 0; i < dp.length; i++) {
            var x = te[i], y = dp[i];
            if (!_rdNum(x) || !_rdNum(y) || y <= 0 || x < lo || x > hi) continue;
            sum += 0.5 * (y / level - MATH.log(k * x / (phi * mu * ct * rw * rw)) + 7.4316);
            n++;
        }
        return n >= 2 ? sum / n : null;
    }
    // Δq re-derived from the allocation volume and the detected flowing hours of the closing day (V25).
    function _rdClosingRate(days, tcMs, dqSource, mode, events, eventId, closeDayMin) {
        if (mode !== 'daily' || !_isArr(days) || !_rdNum(tcMs)) return null;
        var di = -1;
        for (var i = 0; i < days.length; i++) { var d = days[i]; if (d && d.t0_ms <= tcMs && tcMs < d.t1_ms) { di = i; break; } }
        if (di < 0) return null;
        var partial = (days[di].events || []).some(function (id) {
            if (id === eventId) return false;
            var e = (events || []).filter(function (x) { return x && x.id === id; })[0];
            return e && e.kind === 'partial';
        });
        if (partial) return null;
        var j = di;
        if (dqSource === 'previousDay') {
            var min = _rdNum(closeDayMin) ? closeDayMin : 6;
            for (j = di - 1; j >= 0; j--) if (days[j] && _rdNum(days[j].hOn) && days[j].hOn >= min) break;
            if (j < 0) return null;
        } else if (dqSource !== 'closingDay') return null;
        var day = days[j];
        if (!day || !_rdNum(day.V) || !_rdNum(day.hOn) || day.hOn < 0.5) return null;
        return { q: 24 * day.V / day.hOn, tol: (day.R3 && _rdNum(day.R3.tol)) ? day.R3.tol : null, day: j };
    }
    // The model the stored BIC table selects with τ (rounded to 0.1 per D27); null when exact and rounded differ.
    function _rdBicChoice(bic, ov, trig, found, chosen) {
        if (!bic || !_isArr(bic.rows)) return null;
        var hom = bic.rows.filter(function (r) { return r && r.key === 'homogeneous'; })[0];
        if (!hom || !_rdNum(hom.bic)) return null;
        if (ov && ov.model) return ov.model;
        var tau = _rdNum(bic.tau) ? bic.tau : 10;
        var excl = (ov && _isArr(ov.excludeRivals)) ? ov.excludeRivals : [];
        var cands = bic.rows.filter(function (r) { return r && r.key !== 'homogeneous' && r.eligible === true && _rdNum(r.bic) && excl.indexOf(r.key) === -1; });
        function pick(rounded, useTau) {
            var best = hom;
            cands.forEach(function (r) {
                var gain = hom.bic - r.bic;
                if (rounded) gain = _rdRound(gain, 1);
                if ((!useTau || gain > tau) && r.bic < best.bic) best = r;
            });
            return best.key;
        }
        var exact = pick(false, true), rounded = pick(true, true);
        if (exact !== rounded) return null;
        if (trig && trig.none === true && found === false) {
            var noTau = pick(false, false);
            if (chosen === rounded || chosen === noTau) return chosen;
        }
        return rounded;
    }
    // Alert status recomputed from the stored series, baseline and thresholds (V27; also the what-if answer).
    function _alertRecompute(an, which, shift) {
        var tr = an && an.trend;
        if (!tr || !tr.alerts || !tr.alerts[which]) return null;
        var A = tr.alerts[which];
        var keep = { status: A.status, raisedAt: A.raisedAt, confirmedAt: A.confirmedAt, ambiguous: true };
        if (tr.enabled === false) return keep;
        var segs = tr.baseline && _isArr(tr.baseline.segments) ? tr.baseline.segments : [];
        if (segs.length > 1) return keep;                          // per-segment re-arming is not re-derived
        var base = tr.baseline && _rdNum(tr.baseline.S) ? tr.baseline.S : null;
        var sigB = tr.baseline && _rdNum(tr.baseline.sigma) ? tr.baseline.sigma : 0;
        var thr = A.threshold;
        if (!_rdNum(thr)) return keep;
        var sh = _rdNum(shift) ? shift : 0;
        var mech = which === 'absolute' && A.basis === 'mechanical';
        var confirmMode = an.settings && an.settings.trend ? an.settings.trend.confirm : 'next';
        var series = _isArr(tr.series) ? tr.series : [];
        var low = {};
        (tr.excludedLow && _isArr(tr.excludedLow.ids) ? tr.excludedLow.ids : []).forEach(function (id) { low[id] = 1; });
        function excess(s, rounded) {
            var S = mech ? s.Smech : s.S, E = mech ? s.SmechErr : s.Serr;
            if (!_rdNum(S) || !_rdNum(E)) return null;
            var x;
            if (which === 'delta') {
                if (base === null) return null;
                var Ej = (A.form === 'basevar') ? MATH.sqrt(E * E + sigB * sigB) : E;
                x = (S + sh) - Ej - (base + sh) - thr;           // a uniform shift moves the baseline too
            } else x = (S + sh) - E - thr;
            return rounded ? _rdRound(x, 2) : x;
        }
        function status(rounded) {
            var used = series.filter(function (s) { return s && s.used && s.used.alert; });
            var raised = null, ri = -1;
            for (var i = 0; i < used.length; i++) { var x = excess(used[i], rounded); if (x !== null && x > 0) { raised = used[i]; ri = i; break; } }
            if (raised) {
                var ex = excess(raised, rounded);
                var immediate = confirmMode === 'immediate' || (raised.conf && raised.conf.ks === 'high' && ex >= 1);
                var conf = immediate ? raised : null;
                for (var j = ri + 1; !conf && j < used.length; j++) { var y = excess(used[j], rounded); if (y !== null && y > 0) conf = used[j]; }
                return { status: conf ? 'confirmed' : 'provisional', raisedAt: raised.id, confirmedAt: conf ? conf.id : null };
            }
            var poss = series.some(function (s) { if (!s || !low[s.id] || (s.used && s.used.alert)) return false; var x = excess(s, rounded); return x !== null && x > 0; });
            return { status: poss ? 'possible' : 'none', raisedAt: null, confirmedAt: null };
        }
        var a = status(false), b = status(true);
        if (a.status !== b.status || a.raisedAt !== b.raisedAt || a.confirmedAt !== b.confirmedAt) return keep;
        a.ambiguous = false;
        return a;
    }
    FORMULAS.kFromLevel = F(['Dq', 'B', 'mu', 'mPrime', 'h'], 'k = 70.6·Δq·B·μ/(m′·h)  [md] (V23)', _rdKLevel);
    FORMULAS.dkLevelPct = F(['Dq', 'B', 'mu', 'mPrime', 'h', 'k'], '100·(k_level/k − 1) (V23)', function (Dq, B, mu, mp, h, k) {
        var kl = _rdKLevel(Dq, B, mu, mp, h); return (kl !== null && _rdNum(k) && k !== 0) ? 100 * (kl / k - 1) : null;
    });
    FORMULAS.pointSkinMean = F(['dp', 'dte', 'dt', 'X0', 'X1', 'mPrime', 'Dq', 'B', 'mu', 'h', 'phi', 'ct', 'rw', 'steps', 'from', 'to'],
        'mean of S_i = 0.5·[Δp_i/m′ − ln(k·Δt_e,i/(φμct·rw²)) + 7.4316] over the IARF window (V24)', _rdPointSkinMean);
    FORMULAS.closingRate = F(['days', 'tc_ms', 'dqSource', 'mode', 'events', 'eventId'], 'Δq = 24·V/h_on on the closing (or previous full) day (V25)',
        function (days, tc, src, mode, events, eventId) { var r = _rdClosingRate(days, tc, src, mode, events, eventId, 6); return r ? r.q : null; });
    FORMULAS.closingRatePct = F(['days', 'tc_ms', 'dqSource', 'mode', 'events', 'eventId', 'fRate', 'Dq'], '100·(Δq_alloc·f̂/Δq − 1) (V25)',
        function (days, tc, src, mode, events, eventId, fRate, Dq) {
            var r = _rdClosingRate(days, tc, src, mode, events, eventId, 6);
            return (r && _rdNum(Dq) && Dq !== 0) ? 100 * (r.q * (_rdNum(fRate) ? fRate : 1) / Dq - 1) : null;
        });
    FORMULAS.bicChoice = F(['bic', 'ov', 'trig', 'found', 'chosen'], 'model chosen from the stored BIC table with τ (V26)',
        function (bic, ov, trig, found, chosen) { return _rdBicChoice(bic, ov, trig, found, chosen); });
    FORMULAS.alertRecomputed = F(['an', 'which'], 'alert status recomputed from the stored series (V27)',
        function (an, which) { var r = _alertRecompute(an, which, 0); return r ? r.status : null; });

    function _V23(c) {
        var out = [];
        if (c.gas) return out;
        c.tests.forEach(function (t, i) {
            var r = t.result; if (!r || !r.final || !r.iarf || r.iarf.found !== true) return;
            if (r.final.source !== 'match' && r.final.source !== 'line') return;
            var d = c.V(t.id + '·I3', 'dkLevel');
            if (!_rdNum(d.v)) return;
            var tol = 5 + ((r.agreement && _rdNum(r.agreement.biasKPct)) ? MATH.abs(r.agreement.biasKPct) : 0);
            if (_rdRound(MATH.abs(d.v), 1) > _rdRound(tol, 1)) {
                out.push({ subject: t.id, tests: [t.id], ev: [t.id + '·I3', t.id + '·A2'],
                           template: '{test}: k re-derived from the stored IARF level ({kl}) differs from the final k ({k}) by {d} %.',
                           values: { test: c.V(t.id + '·A2', 'test'), kl: c.V(t.id + '·I3', 'kLevel'), k: c.V(t.id + '·A2', 'k'), d: d } });
            }
        });
        return out;
    }
    function _V24(c) {
        var out = [];
        if (c.gas) return out;
        c.tests.forEach(function (t) {
            var r = t.result; if (!r || !r.final || !r.iarf || r.iarf.found !== true || !r.sErr) return;
            if (r.final.source !== 'match' && r.final.source !== 'line') return;
            var sm = c.V(t.id + '·I4', 'Smean');
            if (!_rdNum(sm.v) || !_rdNum(r.final.S)) return;
            var thr = MATH.max(0.5, _rdNum(r.sErr.value) ? r.sErr.value : 0);
            if (_rdRound(MATH.abs(sm.v - r.final.S), 2) > _rdRound(thr, 2)) {
                out.push({ subject: t.id, tests: [t.id], ev: [t.id + '·I4', t.id + '·A2'],
                           template: '{test}: the mean point skin over the stored window ({sm}) differs from the final skin ({s}) by more than its uncertainty ({e}).',
                           values: { test: c.V(t.id + '·A2', 'test'), sm: sm, s: c.V(t.id + '·A2', 'S'), e: c.V(t.id + '·U1', 'value') } });
            }
        });
        return out;
    }
    function _V25(c) {
        var out = [], an = c.an;
        if (!an.rates || an.rates.mode !== 'daily') return out;
        c.tests.forEach(function (t) {
            var s = t.spec; if (!s || !s.rateQC || s.rateQC.source !== 'allocation') return;
            var d = c.V(t.id + '·R2', 'dqPct');
            if (!_rdNum(d.v)) return;
            var rr = _rdClosingRate(an.rates.days, t.tc_ms, s.rateQC.dqSource, an.rates.mode, an.events, t.eventId, 6);
            var tol = (rr && _rdNum(rr.tol)) ? rr.tol : 0.15;
            if (_rdRound(MATH.abs(d.v), 1) > _rdRound(100 * tol, 1)) {
                out.push({ subject: t.id, tests: [t.id], ev: [t.id + '·R1', t.id + '·R2'],
                           template: '{test}: the rate re-derived from the allocation and the detected flowing hours ({qa}) differs from the rate used ({q}) by {d} %.',
                           values: { test: c.V(t.id + '·A2', 'test'), qa: c.V(t.id + '·R2', 'qDay'), q: c.V(t.id + '·R1', 'Dq'), d: d } });
            }
        });
        return out;
    }
    function _V26(c) {
        var out = [];
        c.tests.forEach(function (t) {
            var r = t.result; if (!r || !r.bic || !r.chosen) return;
            var e = c.V(t.id + '·M4', 'expected');
            if (typeof e.v !== 'string') return;
            if (e.v !== r.bic.chosen || e.v !== r.chosen.key) {
                out.push({ subject: t.id, tests: [t.id], ev: [t.id + '·M4', t.id + '·M6'],
                           template: '{test}: the stored BIC table with τ selects {e}, but the chosen model is {k}.',
                           values: { test: c.V(t.id + '·A2', 'test'), e: e, k: c.V(t.id + '·M6', 'key') } });
            }
        });
        return out;
    }
    function _V27(c) {
        var out = [], tr = c.an.trend;
        if (!tr || !tr.alerts || tr.enabled === false) return out;
        [['delta', 'T2', 'delta'], ['absolute', 'T3', 'absolute']].forEach(function (w) {
            var A = tr.alerts[w[0]]; if (!A) return;
            var rc = c.V(w[1], 'recomputed');
            if (typeof rc.v !== 'string' || rc.v === A.status) return;
            out.push({ subject: w[0], tests: [], ev: ['T2', 'T3'],
                       template: 'The ' + w[2] + ' alert status recomputed from the stored series and thresholds is {rc}, but the reported status is {st}.',
                       values: { rc: rc, st: c.V(w[1], 'status') } });
        });
        return out;
    }
    // ── RE-DERIVATION END ──

    // ─────────────────────────────────────────────────────────────────────
    // 3. Small helpers used by FORMULAS (outside the re-derivation section)
    // ─────────────────────────────────────────────────────────────────────
    function _zoneText(z) {
        if (!_obj(z)) return null;
        if (z.mode === 'utc') return 'UTC';
        if (z.mode === 'fixed' && _isNum(z.offset_h)) return 'UTC' + (z.offset_h >= 0 ? '+' : '−') + MATH.abs(z.offset_h) + ' h';
        if (z.mode === 'iana' && z.tz) return String(z.tz);
        if (z.mode === 'device') return 'device zone (not yet resolved)';
        return null;
    }
    function _timeText(ms, zone) {
        if (!_isNum(ms)) return null;
        var z = _obj(zone) ? zone : { mode: 'utc' };
        var parts = null;
        if (z.mode === 'iana' && z.tz && typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
            try {
                var p = new Intl.DateTimeFormat('en-GB', { timeZone: z.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
                var o = {}; p.forEach(function (x) { o[x.type] = x.value; });
                if (o.year && o.month && o.day) parts = { s: o.year + '-' + o.month + '-' + o.day + ' ' + (o.hour === '24' ? '00' : o.hour) + ':' + o.minute, label: z.tz };
            } catch (e) { parts = null; }
        }
        if (!parts) {
            var off = (z.mode === 'fixed' && _isNum(z.offset_h)) ? z.offset_h : 0;
            var d = new Date(ms + off * 3600000);
            parts = { s: d.getUTCFullYear() + '-' + _pad2(d.getUTCMonth() + 1) + '-' + _pad2(d.getUTCDate()) + ' ' + _pad2(d.getUTCHours()) + ':' + _pad2(d.getUTCMinutes()),
                      label: off ? _zoneText({ mode: 'fixed', offset_h: off }) : 'UTC' };
        }
        return parts.s + ' ' + parts.label;
    }
    function _testDte(t) {
        var r = t && t.result;
        if (!r) return null;
        if (r.evidence && _isNum(r.evidence.dteEnd_h)) return r.evidence.dteEnd_h;
        if (r.bins && _isArr(r.bins.dte) && r.bins.dte.length) return r.bins.dte[r.bins.dte.length - 1];
        return null;
    }
    function _reachSummary(an) {
        var out = { n: 0, nShort: 0, fair: null, good: null };
        if (!an || !_isArr(an.tests)) return out;
        var fairs = [], goods = [];
        an.tests.forEach(function (t) {
            if (!t || t.status !== 'interpreted' || !t.result || !t.result.reach) return;
            var rc = t.result.reach;
            var dte = _testDte(t);
            if (_isNum(dte) && _isNum(rc.fair_h)) { out.n++; if (rc.fair_h > dte) out.nShort++; }
            if (_isNum(rc.fairShut_h)) fairs.push(rc.fairShut_h);
            if (_isNum(rc.goodShut_h)) goods.push(rc.goodShut_h);
        });
        out.fair = _median(fairs); out.good = _median(goods);
        return out;
    }
    function _spearman(x, y) {
        var n = x.length; if (n < 2) return null;
        function ranks(a) {
            var idx = a.map(function (v, i) { return i; }).sort(function (i, j) { return a[i] - a[j]; });
            var r = new Array(n), i = 0;
            while (i < n) { var j = i; while (j + 1 < n && a[idx[j + 1]] === a[idx[i]]) j++; for (var k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1; i = j + 1; }
            return r;
        }
        var rx = ranks(x), ry = ranks(y), mx = (n + 1) / 2, sxy = 0, sxx = 0, syy = 0;
        for (var i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - mx); sxx += (rx[i] - mx) * (rx[i] - mx); syy += (ry[i] - mx) * (ry[i] - mx); }
        return (sxx > 0 && syy > 0) ? sxy / MATH.sqrt(sxx * syy) : null;
    }
    function _rhoSq(an) {
        if (!an || !_isArr(an.tests)) return null;
        var S = [], Q = [];
        an.tests.forEach(function (t) {
            if (!t || !t.used || !t.used.trend || !t.result || !t.result.final) return;
            if (_isNum(t.result.final.S) && _isNum(t.Dq)) { S.push(t.result.final.S); Q.push(t.Dq); }
        });
        return S.length >= 4 ? _spearman(S, Q) : null;
    }
    // piecewise-linear interpolation through [x, y] knots (x ascending), constant outside
    function _lin(knots, x) {
        if (!knots.length) return null;
        if (x <= knots[0][0]) return knots[0][1];
        for (var i = 1; i < knots.length; i++) {
            if (x <= knots[i][0]) { var dx = knots[i][0] - knots[i - 1][0]; return dx > 0 ? knots[i - 1][1] + (knots[i][1] - knots[i - 1][1]) * (x - knots[i - 1][0]) / dx : knots[i][1]; }
        }
        return knots[knots.length - 1][1];
    }
    // T8 cumulative at stake re-derived from the stored series, baseline, onset and daily rates (plan §4.7). Null when it cannot
    // be re-derived from stored data alone (not oil, no onset, several baseline segments, guard), so check() then re-reads it.
    function _cumAtStake(an) {
        var tr = an && an.trend;
        if (!tr || _fluid(an) !== 'oil' || tr.enabled === false || !tr.pi || tr.pi.guard === true || !tr.onset || !tr.baseline) return null;
        var X = tr.pi.X, Sb = tr.baseline.S, tau = tr.onset.tauDays;
        if (!_allNum(X, Sb, tau) || X + Sb < 1) return null;
        if (_isArr(tr.baseline.segments) && tr.baseline.segments.length > 1) return null;
        var days = an.rates ? _arr(an.rates.days) : [];
        if (!days.length) return null;
        var byId = {};
        _arr(an.tests).forEach(function (t) { if (t && t.id) byId[t.id] = t; });
        var first = null, vals = [];
        _arr(tr.series).forEach(function (s) {
            if (!s || !_isNum(s.tDays)) return;
            if (first === null && byId[s.id] && _isNum(byId[s.id].tc_ms)) first = byId[s.id].tc_ms - s.tDays * 86400000;
            if (s.used && s.used.trend && _isNum(s.S)) vals.push([s.tDays, s.S]);
        });
        if (first === null || !vals.length) return null;
        var atTau = vals.some(function (k) { return MATH.abs(k[0] - tau) < 1e-9; });
        var knots = atTau ? vals : vals.filter(function (k) { return k[0] < tau; }).concat([[tau, Sb]]).concat(vals.filter(function (k) { return k[0] > tau; }));
        var cum = 0;
        for (var i = 0; i < days.length; i++) {
            var d = days[i];
            if (!d || !_allNum(d.t0_ms, d.t1_ms, d.q)) continue;
            var td = (0.5 * (d.t0_ms + d.t1_ms) - first) / 86400000;
            if (td < tau) continue;
            var s = _lin(knots, td);
            if (X + s < 1) return null;
            cum += d.q * ((X + s) / (X + Sb) - 1);
        }
        return cum;
    }
    function _bubbleCount(an) {
        var rows = an && an.trend && an.trend.bubble ? _arr(an.trend.bubble.rows) : [];
        var pb = an && an.well ? an.well.Pb : null;
        var below = rows.filter(function (r) { return r && (r.level === 'major' || r.level === 'critical' || (_isNum(pb) && _isNum(r.pwfSand_hi) && r.pwfSand_hi < pb)); }).length;
        return { n: rows.length, below: below };
    }
    // One top-level call (report, run, evidence, check, ask, aiExport, status, signature) memoizes the results hash
    // per analysis object: everything is synchronous, so the analysis cannot change during the call.
    // The evidence index is cached the same way (per analysis object and calibration table), so report(), its second build after a
    // V14 and the checks inside one call build it once.
    var _memo = null, _evMemo = null;
    function _memoized(fn) {
        return function () {
            var outer = _memo === null;
            if (outer) { _memo = typeof Map === 'function' ? new Map() : null; _evMemo = _memo ? new Map() : null; }
            try { return fn.apply(this, arguments); } finally { if (outer) { _memo = null; _evMemo = null; } }
        };
    }
    function _evidenceFor(an, opts) {
        if (!_evMemo || !_obj(an)) return evidence(an, opts);
        var cal = _roots(an, opts).cal, list = _evMemo.get(an);
        if (list) for (var i = 0; i < list.length; i++) if (list[i].cal === cal) return list[i].idx;
        var idx = evidence(an, opts);
        if (!list) _evMemo.set(an, list = []);
        list.push({ cal: cal, idx: idx });
        return idx;
    }
    function _resultsHash(an) {
        if (!_obj(an)) return null;
        if (_memo && _memo.has(an)) return _memo.get(an);
        var h = _resultsHashRaw(an);
        if (_memo) _memo.set(an, h);
        return h;
    }
    function _resultsHashRaw(an) {
        var tr = an.trend || {};
        return _h16({
            tests: _arr(an.tests).map(function (t) {
                var r = t && t.result;
                return { id: t && t.id, final: r ? r.final : null, sErr: r && r.sErr ? r.sErr.value : null,
                         labels: r && r.confidence ? { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline } : null };
            }),
            alerts: tr.alerts || null, onset: tr.onset || null, recent: tr.recent ? tr.recent.slopePer30d : null
        }, 'display');
    }
    function _decisionList(review) {
        return _arr(review && review.findings).filter(function (f) { return f && f.decision; }).map(function (f) {
            return { key: f.key || (f.rule + ':' + f.id), rule: f.rule, d: f.decision.d, note: f.decision.note || null, who: f.decision.who || '', at: f.decision.at || null };
        }).sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    }
    function _decisionsHash(review) { return _obj(review) ? _h16(_decisionList(review), 'display') : null; }

    // ─────────────────────────────────────────────────────────────────────
    // 4. Evidence index (§8.1)
    // ─────────────────────────────────────────────────────────────────────
    // kind → displayed decimals (Value.dp)
    function _dpFor(kind, v) {
        switch (kind) {
            case 'S': return 2;
            case 'dS3': return 3;
            case 'pct': case 'bic': case 'days': case 'snr': return 1;
            case 'k': case 'C': case 'kh': case 'J': case 'D': return _sfDp(v, 3);
            case 'p': case 'q': return (_isNum(v) && v !== 0 && MATH.abs(v) < 10) ? MATH.max(1, _sfDp(v, 3)) : 1;
            case 'h': if (!_isNum(v)) return 1; var a = MATH.abs(v); return a >= 100 ? 0 : a >= 10 ? 1 : MATH.max(1, _sfDp(v, 3));
            case 'ratio': case 'idx': case 'frac': return 3;
            case 'cyc': return 2;
            default: return 0;          // strings, counts, distances (ft), seconds, volumes
        }
    }
    function _usesCtx(sp) {
        if (sp.p && _ctxRoot(sp.p)) return true;
        if (sp.f && sp.f.args) for (var k in sp.f.args) { var a = sp.f.args[k]; if (typeof a === 'string' && _ctxRoot(a)) return true; }
        return false;
    }
    function _firstPath(f) {
        if (!f || !f.args) return null;
        for (var k in f.args) { var a = f.args[k]; if (typeof a === 'string') return a; if (_obj(a) && typeof a.path === 'string') return a.path; if (_obj(a) && _isArr(a.paths) && a.paths.length) return a.paths[0]; }
        return null;
    }
    function _arg(a, roots) {
        if (a === null || a === undefined) return null;
        if (typeof a === 'string') return _get(roots, a);
        if (_obj(a)) {
            if ('lit' in a) return a.lit;
            if (_isArr(a.paths)) return a.paths.map(function (p) { return _get(roots, p); });
            if (typeof a.path === 'string') return _get(roots, a.path);
        }
        return a;
    }
    function _evalF(spec, roots) {
        var fn = spec && FORMULAS[spec.f];
        if (typeof fn !== 'function') return undefined;
        var args = fn.args.map(function (name) { return _arg(spec.args ? spec.args[name] : null, roots); });
        try { return fn.apply(null, args); } catch (e) { return undefined; }
    }
    function _clean(v) {
        if (v === undefined || v === null) return null;
        if (typeof v === 'number') return _isFin(v) ? (v === 0 ? 0 : v) : null;
        if (typeof v === 'string') return v;
        if (typeof v === 'boolean') return v ? 'yes' : 'no';
        return null;
    }
    // Build one evidence value: sp = {p: path, k: kind, c: unit category, f: {f, args}, s: stored}.
    //   P  — a stored field, quoted as stored and re-read by check();
    //   FX — a number only the review computes (v = formula; p, when given, is a reference path only);
    //   FS — a derived number the engine stores: v = the stored field (what the page shows), and check() recomputes it with
    //        the formula from the full-precision stored inputs, so a stored value that disagrees with FORMULAS raises V14.
    function _mkValue(sp, roots) {
        var formula = sp.f || null;
        var path = sp.p || _firstPath(formula);
        if (!path) return null;
        if (!formula && path.charCodeAt(0) !== 36) {                     // fast path: a plain stored field (no '$' root, no formula)
            var pv = _get(roots, path);
            if (pv === undefined) return null;
            if (pv === null || (typeof pv !== 'object' && typeof pv !== 'boolean')) { var cv = _clean(pv); return { v: cv, cat: sp.c || null, dp: _dpFor(sp.k, cv), path: path }; }
            // booleans and arrays continue below (yesNo / join)
        }
        var ctx = _usesCtx(sp);
        if (sp.lazy && formula && !ctx) return _lazyValue(sp, formula, path, roots);
        if (!formula && !ctx) {
            var raw = _get(roots, path);
            if (raw === undefined) return null;
            if (typeof raw === 'boolean') formula = { f: 'yesNo', args: { x: path } };
            else if (_isArr(raw)) { if (raw.every(function (x) { return typeof x === 'string' || typeof x === 'number'; })) formula = { f: 'join', args: { x: path } }; else return null; }
            else if (raw !== null && typeof raw === 'object') return null;
        }
        var v;
        if (sp.s && formula) { var st = sp.hasVal ? sp.val : _get(roots, path); v = st === undefined ? _evalF(formula, roots) : st; }
        else v = formula ? _evalF(formula, roots) : _get(roots, path);
        v = _clean(v);
        var out = { v: v, cat: sp.c || null, dp: _dpFor(sp.k, v), path: path };
        if (formula) out.formula = formula;
        if (sp.s && formula) out.stored = true;
        return out;
    }
    // A costly review-only number (results hash, alert recompute, level k, point-skin mean, closing-day rate, BIC choice, well-level
    // summaries): computed on first read of v (then kept), so building the index does not pay for the ones nobody quotes; JSON and
    // check() read it like any other value.
    function _lazyValue(sp, formula, path, roots) {
        var out = { cat: sp.c || null, path: path, formula: formula };
        var done = false, val = null;
        function get() { if (!done) { val = _clean(_evalF(formula, roots)); done = true; } return val; }
        Object.defineProperty(out, 'v', { enumerable: true, configurable: true, get: get, set: function (x) { val = x; done = true; } });
        Object.defineProperty(out, 'dp', { enumerable: true, configurable: true, get: function () { return _dpFor(sp.k, get()); }, set: function () {} });
        return out;
    }
    function P(p, k, c) { return { p: p, k: k, c: c }; }
    function FX(f, args, k, c, p) { return { f: { f: f, args: args }, k: k, c: c, p: p }; }
    // FS(…, val): val is the stored field already in hand (read without resolving the path again)
    function FS(p, f, args, k, c, val) { var o = { p: p, s: true, f: { f: f, args: args }, k: k, c: c }; if (arguments.length > 5) { o.hasVal = true; o.val = val; } return o; }
    function FL(f, args, k, c, p) { return { f: { f: f, args: args }, k: k, c: c, p: p, lazy: true }; }

    function _rateCat(qUnit) { return qUnit === 'Mscf/d' ? 'gasRateSmall' : 'liquidRate'; }
    function _volCat(an) { return (an && an.rates && an.rates.unit === 'Mscf/d') ? 'gasVolume' : 'volume'; }
    // A volume value: liquid volumes (STB, bbl) as stored; gas volumes in Mscf quoted in MMscf (the gasVolume unit).
    function _volSpec(path, mscf) { return mscf ? FX('scale', { x: path, f: { lit: 0.001 } }, 'D', 'gasVolume') : P(path, 'n', 'volume'); }

    function evidence(analysis, opts) {
        opts = opts || {};
        var an = _obj(analysis) ? analysis : {};
        var roots = _roots(an, opts);
        var idx = { items: {}, order: [] };
        var gas = _fluid(an) === 'gas';
        var tests = _arr(an.tests), events = _arr(an.events);
        var evIndex = {};
        events.forEach(function (e, j) { if (e && e.id) evIndex[e.id] = j; });

        function add(id, group, test, title, vals) {
            var values = {}, names = [], tpl = title, name;
            for (name in vals) {
                if (!Object.prototype.hasOwnProperty.call(vals, name) || !vals[name]) continue;
                var iv = _mkValue(vals[name], roots); if (!iv) continue;
                values[name] = iv; names.push(name);
            }
            for (var i = 0; i < names.length && i < 8; i++) tpl += (i ? ', ' : ': ') + names[i] + ' {' + names[i] + '}';
            tpl += '.';
            idx.items[id] = { id: id, group: group, test: test, title: title, values: values, template: tpl.length <= 600 ? tpl : title + '.' };
            idx.order.push(id);
        }

        // ── well level: Q (data quality) ──
        add('Q1', 'Q', null, 'Gauge noise', { sigma_psi: P('qc.sigma_psi', 'p', 'pressure'), sigmaShut_psi: P('qc.sigmaShut_psi', 'p', 'pressure'),
            sigmaFlow_psi: P('qc.sigmaFlow_psi', 'p', 'pressure'), rho1: P('qc.rho1', 'ratio'), correlated: P('qc.noiseCorrelated'),
            resolution_psi: P('qc.resolution_psi', 'p', 'pressure'), resolutionLimited: P('qc.resolutionLimited') });
        add('Q2', 'Q', null, 'Sampling and zones', { dtMed_s: P('qc.dtMed_s', 'n'), dtP05_s: P('qc.dtP05_s', 'n'), dtP95_s: P('qc.dtP95_s', 'n'), n: P('qc.n', 'n'),
            zoneGauge: FX('zoneText', { zone: 'zones.gauge' }), zoneDay: FX('zoneText', { zone: 'zones.day.zone' }), dayStart: P('zones.day.startHour', 'n') });
        add('Q3', 'Q', null, 'Gaps', { gapCount: P('qc.gapCount', 'n'), gapTotal_h: P('qc.gapTotal_h', 'h'), longestGap_h: P('qc.longestGap_h', 'h') });
        add('Q4', 'Q', null, 'Spikes', { count: P('qc.spikes.count', 'n'), mode: P('qc.spikes.mode') });
        add('Q5', 'Q', null, 'Gauge drift (assumed)', { drift: P('well.driftPsiPerDay', 'idx', 'pressurePerDay') });
        add('Q6', 'Q', null, 'Tide index', { maxTide: FL('maxOf', { xs: { paths: tests.map(function (t, i) { return 'tests[' + i + '].result.quality.rTide'; }) } }, 'idx', null, tests.length ? 'tests[0].result.quality.rTide' : 'tests') });
        add('Q7', 'Q', null, 'Temperature', { present: P('qc.temperature.present') });
        add('Q8', 'Q', null, 'Depth correction', { applied: P('qc.depth.applied'), shift_psi: P('qc.depth.shift_psi', 'p', 'pressure') });

        // ── well level: D (detection; settings; events) ──
        var d1 = {
            nEvents: P('events.length', 'n'), nTests: P('tests.length', 'n'), nTooShort: P('missed.tooShort.length', 'n'), nInterventions: P('missed.interventions.length', 'n'),
            nSub: P('missed.subThreshold.length', 'n'), nAllocOnly: P('missed.allocOnly.length', 'n'), nGaps: P('missed.gaps.length', 'n'),
            detectOk: P('missed.detectability.ok'), pStarMinusPwf_psi: P('missed.detectability.pStarMinusPwf_psi', 'p', 'pressure'), Ts_psi: P('missed.detectability.Ts_psi', 'p', 'pressure'),
            winMin: P('settings.detect.winMin', 'n'), riseMin: P('settings.detect.riseMin', 'p', 'pressure'), riseSig: P('settings.detect.riseSig', 'n'), persistMin: P('settings.detect.persistMin', 'n'),
            minDur_h: P('settings.detect.minDur_h', 'h'), gapN: P('settings.detect.gapN', 'n'), spike: P('settings.detect.spike'), partial: P('settings.detect.partial'),
            testList: FX('testList', { tests: 'tests' }), excludedList: FX('excludedList', { tests: 'tests' }),
            nOlderEvents: FX('older', { n: 'events.length', shown: { lit: MAX_ROWS } }, 'n'), nOlderTests: FX('older', { n: 'tests.length', shown: { lit: MAX_ROWS } }, 'n')
        };
        events.forEach(function (e, j) {
            if (!e || !e.id) return;
            var pe = 'events[' + j + ']';
            d1[e.id + '_time'] = FX('timeText', { ms: pe + '.tc_ms', zone: 'zones.gauge' });
            d1[e.id + '_dtEnd_h'] = P(pe + '.dtEnd_h', 'h');
            d1[e.id + '_pwf0'] = P(pe + '.pwf0', 'p', 'pressure');
        });
        add('D1', 'D', null, 'Detection summary and missed list', d1);

        // ── well level: R (rates) ──
        var r2 = { nOlderDays: null }, gasDays = !!(an.rates && an.rates.unit === 'Mscf/d');
        var days = an.rates ? _arr(an.rates.days) : [];
        var findDay = _dayFinder(an), dayPick = _daysAround(an, findDay);
        dayPick.forEach(function (j) {
            var pd = 'rates.days[' + j + ']';
            r2['d' + j + '_date'] = P(pd + '.date'); r2['d' + j + '_hOn'] = P(pd + '.hOn', 'h'); r2['d' + j + '_V'] = _volSpec(pd + '.V', gasDays);
            r2['d' + j + '_q'] = P(pd + '.q', 'q', _rateCat(an.rates && an.rates.unit)); r2['d' + j + '_R3'] = P(pd + '.R3.ratio', 'ratio');
        });
        r2.nOlderDays = FX('older', { n: { lit: dayPick.length }, shown: { lit: MAX_ROWS } }, 'n', null, 'rates.days');
        add('R2', 'R', null, 'Flowing hours and daily rates', r2);
        add('R3', 'R', null, 'Offset scan', { current_h: P('rates.offsetScan.current_h', 'h'), best_h: P('rates.offsetScan.best_h', 'h'), better: P('rates.offsetScan.better'), improvement: P('rates.offsetScan.improvement', 'ratio') });
        add('R5', 'R', null, 'History before the data', { source: P('rates.start.source'), prepend_h: P('rates.start.prepend_h', 'h'), flag: P('rates.start.flag'), q: P('rates.start.q', 'q', _rateCat(an.rates && an.rates.unit)) });
        add('R7', 'R', null, 'Phase basis', { used: P('rates.phaseBasis.used'), wcMax: P('rates.phaseBasis.wcMax', 'frac'), wcPct: FX('pct100', { x: 'rates.phaseBasis.wcMax' }, 'pct'),
            gorRatioMax: P('rates.phaseBasis.gorRatioMax', 'ratio'), twoPhaseCt: P('rates.phaseBasis.twoPhaseCt'), phase: P('rates.phase'), unit: P('rates.unit'), mode: P('rates.mode') });

        // ── well level: settings echoes (I1 interpretation, M1 models), inputs (U2), reach summary (W4) ──
        add('I1', 'I', null, 'Interpretation settings', { Lcyc: P('settings.interp.Lcyc', 'ratio'), bandPct: FX('pct100', { x: 'settings.interp.band' }, 'pct'), slope: P('settings.interp.slope', 'ratio'), minCycles: P('settings.interp.minCycles', 'cyc') });
        add('M1', 'M', null, 'Model settings', { rivals: P('settings.interp.rivals'), cheld: P('settings.interp.cheld'), kHeld: P('settings.interp.kHeld'), tide: P('settings.interp.tide') });
        add('U2', 'U', null, 'Well inputs', { h: P('well.h', 'n', 'length'), phi: P('well.phi', 'ratio'), mu: P('well.mu', 'ratio', 'viscosity'), B: P('well.B', 'ratio'),
            ct: P('well.ct', 'D', 'compressibility'), rw: P('well.rw', 'ratio', 'length'), re_ft: P('well.re_ft', 'n', 'length'), Pb: P('well.Pb', 'p', 'pressure'),
            defaulted: FX('join', { x: 'well.defaulted' }), defaultedPhys: FX('joinDefaulted', { x: 'well.defaulted' }), fluid: P('well.fluid'), allocAccPct: P('well.allocAccPct', 'pct') });
        add('W4', 'W', null, 'Expected IARF reach (summary)', { nShort: FL('reachShort', { an: '$analysis' }, 'n', null, 'tests'), n: FL('reachTests', { an: '$analysis' }, 'n', null, 'tests'),
            fairShutMedian: FL('fairShutMedian', { an: '$analysis' }, 'h', null, 'tests'), goodShutMedian: FL('goodShutMedian', { an: '$analysis' }, 'h', null, 'tests') });

        // ── per test ──
        var latestUsed = _latestIdx(an);
        tests.forEach(function (t, i) {
            if (!t || !t.id) return;
            var id = t.id, pt = 'tests[' + i + ']', r = pt + '.result', s = pt + '.spec', res = t.result, ej = evIndex[t.eventId], pe = ej !== undefined ? 'events[' + ej + ']' : null;
            var qc = _rateCat(t.qUnit || (t.spec && t.spec.qUnit));
            var physOk = !gas;
            var W = s + '.well';
            if (pe) {
                add(id + '·D1', 'D', id, 'Rise', { rise_psi: P(pe + '.rise_psi', 'p', 'pressure'), Ts_psi: P(pe + '.Ts_psi', 'p', 'pressure') });
                add(id + '·D2', 'D', id, 'Closing time', { tc: FX('timeText', { ms: pe + '.tc_ms', zone: 'zones.gauge' }), dtc_s: P(pe + '.dtc_s', 'n') });
                add(id + '·D3', 'D', id, 'Flowing pressure at closing', { pwf0: P(pe + '.pwf0', 'p', 'pressure'), pwf0SE: P(pe + '.pwf0SE', 'p', 'pressure') });
                add(id + '·D4', 'D', id, 'Gap at closing', { status: P(pe + '.status') });
                add(id + '·D6', 'D', id, 'Allocation confirmation', { confirm: P(pe + '.alloc.confirm'), ratio: P(pe + '.alloc.ratio', 'ratio'), fhat: P(pe + '.fhat', 'ratio') });
            }
            add(id + '·D5', 'D', id, 'Duration', { dtEnd_h: P(pt + '.dtEnd_h', 'h') });
            add(id + '·R1', 'R', id, 'Rate before closing', { Dq: P(s + '.Dq', 'q', qc), source: P(s + '.rateQC.source'), dqSource: P(s + '.rateQC.dqSource'), fRate: P(s + '.fRate', 'ratio'), partialSuspect: P(pt + '.partialSuspect') });
            var di = _closingDay(an, t, findDay);
            var r2v = {
                qDay: FL('closingRate', { days: 'rates.days', tc_ms: pt + '.tc_ms', dqSource: s + '.rateQC.dqSource', mode: 'rates.mode', events: 'events', eventId: pt + '.eventId' }, 'q', qc),
                dqPct: FL('closingRatePct', { days: 'rates.days', tc_ms: pt + '.tc_ms', dqSource: s + '.rateQC.dqSource', mode: 'rates.mode', events: 'events', eventId: pt + '.eventId', fRate: s + '.fRate', Dq: s + '.Dq' }, 'pct')
            };
            if (di >= 0) { r2v.date = P('rates.days[' + di + '].date'); r2v.hOn = P('rates.days[' + di + '].hOn', 'h'); r2v.V = _volSpec('rates.days[' + di + '].V', !!(an.rates && an.rates.unit === 'Mscf/d')); }
            add(id + '·R2', 'R', id, 'Flowing hours on the closing day', r2v);
            add(id + '·R3', 'R', id, 'Allocation consistency', { r3: P(s + '.rateQC.r3', 'ratio'), status: P(s + '.rateQC.r3Status'), date: P(pt + '.date') });
            add(id + '·R4', 'R', id, 'Pressure-based rate check', { r4: P(s + '.rateQC.r4', 'ratio'), status: P(s + '.rateQC.r4Status') });
            add(id + '·R5', 'R', id, 'Rate history', { estimated: P(s + '.history.estimated'), source: P(s + '.history.source'), tPrepend_h: P(s + '.history.tPrepend_h', 'h'),
                sensitive: P(r + '.history.sensitive'), dDerivPct: P(r + '.history.dDerivPct', 'pct') });
            // A2 exists for every test (id, date, status and reason are test-level); the result values join it when there is a result
            var a2 = { test: P(pt + '.id'), date: P(pt + '.date'), status: P(pt + '.status'), statusReason: P(pt + '.statusReason'), Dq: P(s + '.Dq', 'q', qc),
                pExtDatum: P(pt + '.pExtDatum', 'p', 'pressure'), pwf0Datum: P(pt + '.pwf0Datum', 'p', 'pressure') };
            if (!res) { add(id + '·A2', 'A', id, 'Final values', a2); return; }
            add(id + '·W1', 'W', id, 'Unit slope', { unitSlope: P(r + '.storage.unitSlope') });
            add(id + '·W2', 'W', id, 'Storage', { C_us: P(r + '.storage.C_us', 'C', 'wbStorage') });
            add(id + '·W3', 'W', id, 'Hump', { tHump_h: P(r + '.storage.tHump_h', 'h'), humpRatio: P(r + '.storage.humpRatio', 'ratio') });
            add(id + '·W4', 'W', id, 'Expected IARF reach', { t5_h: P(r + '.reach.t5_h', 'h'), t10_h: P(r + '.reach.t10_h', 'h'), fair_h: P(r + '.reach.fair_h', 'h'), good_h: P(r + '.reach.good_h', 'h'),
                fairShut_h: P(r + '.reach.fairShut_h', 'h'), goodShut_h: P(r + '.reach.goodShut_h', 'h'), reachable: P(r + '.reach.reachable'),
                dteEnd_h: FX('dteEnd', { evDte: r + '.evidence.dteEnd_h', dte: r + '.bins.dte', dtEnd: pt + '.dtEnd_h', steps: 'rates.steps', from: s + '.stepRef.from', to: s + '.stepRef.to' }, 'h') });
            add(id + '·I1', 'I', id, 'IARF window', { grade: P(r + '.iarf.grade'), status: P(r + '.iarf.status'), cycles: FS(r + '.iarf.cycles', 'cycles', { X0: r + '.iarf.X0', X1: r + '.iarf.X1' }, 'cyc'),
                dt0_h: P(r + '.iarf.dt0_h', 'h'), dt1_h: P(r + '.iarf.dt1_h', 'h'), noiseWidened: P(r + '.iarf.noiseWidened'), forced: P(r + '.iarf.forced'), longest: P(r + '.iarf.longest.cycles', 'cyc') });
            add(id + '·I2', 'I', id, 'IARF end slope', { slopeLast: P(r + '.iarf.slopeLast', 'ratio'), slopeLastSE: P(r + '.iarf.slopeLastSE', 'ratio'), slope: P(r + '.iarf.slope', 'ratio') });
            var i3 = { level_psi: P(r + '.iarf.level_psi', 'p', 'pressure') };
            var i4 = { spread: P(r + '.iarf.pointSkin.spread', 'S'), min: P(r + '.iarf.pointSkin.min', 'S'), max: P(r + '.iarf.pointSkin.max', 'S') };
            if (physOk) {
                i3.kLevel = FL('kFromLevel', { Dq: s + '.Dq', B: W + '.B', mu: W + '.mu', mPrime: r + '.iarf.level_psi', h: W + '.h' }, 'k', 'permeability');
                i3.dkLevel = FL('dkLevelPct', { Dq: s + '.Dq', B: W + '.B', mu: W + '.mu', mPrime: r + '.iarf.level_psi', h: W + '.h', k: r + '.final.k' }, 'pct');
                i4.Smean = FL('pointSkinMean', { dp: r + '.bins.dp', dte: r + '.bins.dte', dt: r + '.bins.dt', X0: r + '.iarf.X0', X1: r + '.iarf.X1', mPrime: r + '.iarf.level_psi', Dq: s + '.Dq',
                    B: W + '.B', mu: W + '.mu', h: W + '.h', phi: W + '.phi', ct: W + '.ct', rw: W + '.rw', steps: 'rates.steps', from: s + '.stepRef.from', to: s + '.stepRef.to' }, 'S');
            }
            add(id + '·I3', 'I', id, 'IARF level', i3);
            add(id + '·I4', 'I', id, 'Point-skin spread', i4);
            add(id + '·I5', 'I', id, 'Derivative signal-to-noise', { snrD: P(r + '.quality.snrD', 'snr'), sigmaD_psi: P(r + '.quality.sigmaD_psi', 'p', 'pressure') });
            if (res.iarf && res.iarf.secondLevel) add(id + '·I6', 'I', id, 'Second level', { ratio: P(r + '.iarf.secondLevel.ratio', 'ratio') });
            add(id + '·Q5', 'Q', id, 'Drift index', { rDrift: P(r + '.quality.rDrift', 'idx') });
            add(id + '·Q6', 'Q', id, 'Tide index', { rTide: P(r + '.quality.rTide', 'idx'), tideRemoved: P(r + '.quality.tideRemoved'), tideFit: P(r + '.quality.tideFit') });
            if (res.line) {
                add(id + '·L1', 'L', id, 'Semilog line', { k: P(r + '.line.k', 'k', 'permeability'), S: P(r + '.line.S', 'S'), pStar: P(r + '.line.pStar', 'p', 'pressure'), kh: P(r + '.line.kh', 'kh', 'permThickness'),
                    method: P(r + '.line.method'), pStarLo: P(r + '.line.pStarRange.lo', 'p', 'pressure'), pStarHi: P(r + '.line.pStarRange.hi', 'p', 'pressure') });
                add(id + '·L2', 'L', id, 'Line window', { dt0_h: P(r + '.line.dt0_h', 'h'), dt1_h: P(r + '.line.dt1_h', 'h'), n: P(r + '.line.n', 'n'), r2: P(r + '.line.r2', 'ratio') });
                add(id + '·L3', 'L', id, 'Line vs derivative plateau', { khDiffPct: P(r + '.line.plateauCheck.khDiffPct', 'pct'), dS: P(r + '.line.plateauCheck.dS', 'S'), pass: P(r + '.line.plateauCheck.pass') });
            }
            add(id + '·M1', 'M', id, 'Homogeneous fit', { k: P(r + '.models[0].phys.k', 'k', 'permeability'), S: P(r + '.models[0].phys.S', 'S'), C: P(r + '.models[0].phys.C', 'C', 'wbStorage'),
                rmseDp: P(r + '.models[0].rmseDp', 'p', 'pressure'), converged: P(r + '.models[0].converged') });
            add(id + '·M2', 'M', id, 'Triggers', { fired: P(r + '.triggers.fired'), noneSkipped: P(r + '.triggers.noneSkipped') });
            add(id + '·M3', 'M', id, 'Rival fits', { count: FX('rivalCount', { models: r + '.models' }, 'n') });
            var m4 = { n: P(r + '.bic.n', 'n'), nEff: P(r + '.bic.nEff', 'snr'), tau: P(r + '.bic.tau', 'bic'), chosen: P(r + '.bic.chosen'), margin: P(r + '.bic.margin', 'bic'),
                expected: FL('bicChoice', { bic: r + '.bic', ov: s + '.overrides', trig: r + '.triggers', found: r + '.iarf.found', chosen: r + '.chosen.key' }) };
            var rows = res.bic ? _arr(res.bic.rows) : [];
            var hj = -1;
            rows.forEach(function (row, j) { if (row && row.key === 'homogeneous') hj = j; });
            rows.forEach(function (row, j) {
                var pr = r + '.bic.rows[' + j + ']';
                m4['r' + j + '_key'] = P(pr + '.key'); m4['r' + j + '_bic'] = P(pr + '.bic', 'bic'); m4['r' + j + '_p'] = P(pr + '.p', 'n'); m4['r' + j + '_eligible'] = P(pr + '.eligible');
                if (hj >= 0) m4['r' + j + '_gain'] = FX('sub', { a: r + '.bic.rows[' + hj + '].bic', b: pr + '.bic' }, 'bic');
                if (row && res.chosen && row.key === res.chosen.key && hj >= 0) m4.gainChosen = FX('sub', { a: r + '.bic.rows[' + hj + '].bic', b: pr + '.bic' }, 'bic');
            });
            add(id + '·M4', 'M', id, 'BIC table', m4);
            add(id + '·M5', 'M', id, 'Fully seen', { status: P(r + '.chosen.fullySeen.status'), value: P(r + '.chosen.fullySeen.value', 'n', 'length'), minFaultDist_ft: P(r + '.final.minFaultDist_ft', 'n', 'length') });
            add(id + '·M6', 'M', id, 'Chosen model', { key: P(r + '.chosen.key'), label: P(r + '.chosen.label') });
            add(id + '·M7', 'M', id, 'Anomaly flags and background check', { flags: FX('joinCodes', { x: r + '.flags' }), boundaryDepends: P(r + '.background.boundaryDepends') });
            if (res.kHeld) add(id + '·M8', 'M', id, 'k-held fit', { k: P(r + '.kHeld.k', 'k', 'permeability'), delta: P(r + '.kHeld.delta', 'ratio'), S_k: P(r + '.kHeld.S_k', 'S'),
                S_kAnalytic: P(r + '.kHeld.S_kAnalytic', 'S'), converged: P(r + '.kHeld.converged'), corrCS: P(r + '.kHeld.corrCS', 'ratio'), rmsRatio: P(r + '.kHeld.rmsRatio', 'ratio') });
            add(id + '·A1', 'A', id, 'Line vs match', { agree: P(r + '.agreement.agree'), mode: P(r + '.agreement.mode'), dkPct: P(r + '.agreement.dkPct', 'pct'), dS: P(r + '.agreement.dS', 'S'),
                biasKPct: P(r + '.agreement.biasKPct', 'pct'), biasDS: P(r + '.agreement.biasDS', 'S') });
            a2.k = P(r + '.final.k', 'k', 'permeability'); a2.kh = P(r + '.final.kh', 'kh', 'permThickness'); a2.S = P(r + '.final.S', 'S'); a2.C = P(r + '.final.C', 'C', 'wbStorage');
            a2.source = P(r + '.final.source'); a2.pStar = P(r + '.final.pStar', 'p', 'pressure'); a2.pExt = P(r + '.final.pExt', 'p', 'pressure');
            a2.piModel = P(r + '.final.piModel', 'p', 'pressure'); a2.pStarLo = P(r + '.final.pStarRange.lo', 'p', 'pressure'); a2.pStarHi = P(r + '.final.pStarRange.hi', 'p', 'pressure');
            if (physOk) {
                // stored engine values, recomputed by check() from the full-precision stored inputs (the engine's Δt_end and
                // Δt_e,end are result.evidence.dtEnd_h / dteEnd_h when present)
                var dtEndP = (res.evidence && _isNum(res.evidence.dtEnd_h)) ? r + '.evidence.dtEnd_h' : pt + '.dtEnd_h';
                a2.m = FS(r + '.final.m', 'm', { Dq: s + '.Dq', B: W + '.B', mu: W + '.mu', k: r + '.final.k', h: W + '.h' }, 'p', 'pressure');
                a2.mPrime = FS(r + '.final.mPrime', 'mPrime', { m: r + '.final.m' }, 'p', 'pressure');
                a2.dpSkin_psi = FS(r + '.final.dpSkin_psi', 'dpSkin', { m: r + '.final.m', S: r + '.final.S' }, 'p', 'pressure');
                a2.rinv_ft = FS(r + '.final.rinv_ft', 'rinv', { k: r + '.final.k', dt: dtEndP, phi: W + '.phi', mu: W + '.mu', ct: W + '.ct' }, 'n', 'length');
                if (res.evidence && _isNum(res.evidence.dteEnd_h)) a2.rinvE_ft = FS(r + '.final.rinvE_ft', 'rinv', { k: r + '.final.k', dt: r + '.evidence.dteEnd_h', phi: W + '.phi', mu: W + '.mu', ct: W + '.ct' }, 'n', 'length');
                else a2.rinvE_ft = P(r + '.final.rinvE_ft', 'n', 'length');
            } else {
                a2.m = P(r + '.final.m', 'p', 'pressure'); a2.mPrime = P(r + '.final.mPrime', 'p', 'pressure'); a2.dpSkin_psi = P(r + '.final.dpSkin_psi', 'p', 'pressure');
                a2.rinv_ft = P(r + '.final.rinv_ft', 'n', 'length'); a2.rinvE_ft = P(r + '.final.rinvE_ft', 'n', 'length');
            }
            add(id + '·A2', 'A', id, 'Final values', a2);
            add(id + '·C1', 'C', id, 'C-held refits', { triggered: P(r + '.cheld.triggered'), mode: P(r + '.cheld.mode'), S_C: P(r + '.cheld.S_C', 'S'), Slo: P(r + '.cheld.range.S[0]', 'S'), Shi: P(r + '.cheld.range.S[1]', 'S'),
                Clo: P(r + '.cheld.range.C[0]', 'C', 'wbStorage'), Chi: P(r + '.cheld.range.C[1]', 'C', 'wbStorage'), meaningful: P(r + '.cheld.meaningful') });
            add(id + '·U1', 'U', id, 'Skin uncertainty', { value: P(r + '.sErr.value', 'S'), mode: P(r + '.sErr.mode'), driver: P(r + '.sErr.driver'), floor: P(r + '.sErr.floor', 'S'), seS: P(r + '.sErr.seS', 'S'),
                dLineMatch: P(r + '.sErr.dLineMatch', 'S'), sWin: P(r + '.sErr.sWin', 'S'), sTc: P(r + '.sErr.sTc', 'S'), sPwf: P(r + '.sErr.sPwf', 'S'), sK: P(r + '.sErr.sK', 'S'),
                ext: P(r + '.sErr.ext.value', 'S'), S_C: P(r + '.sErr.ext.S_C', 'S'), sSens: P(r + '.sErr.sSens', 'S'),
                sAbs: FS(r + '.sErr.sAbs', 'rss', { a: r + '.sErr.value', b: r + '.sErr.sSens' }, 'S') });
            var u2 = { sSens: P(r + '.sensitivity.sSens', 'S') };
            ['req', 'typ'].forEach(function (tab) {
                _arr(res.sensitivity && res.sensitivity[tab]).forEach(function (row, j) {
                    var pr = r + '.sensitivity.' + tab + '[' + j + ']';
                    var ra = { input: pr + '.input', f: pr + '.f' };
                    u2[tab + j + '_dkPct'] = FS(pr + '.dkPct', 'sensDkPct', ra, 'pct', null, row ? row.dkPct : undefined);
                    u2[tab + j + '_dS'] = FS(pr + '.dS', 'sensDS', ra, 'dS3', null, row ? row.dS : undefined);
                });
            });
            add(id + '·U2', 'U', id, 'Input sensitivity', u2);
            add(id + '·U3', 'U', id, 'Dominant inputs', { kReq: P(r + '.sensitivity.dominantK.req'), kTyp: P(r + '.sensitivity.dominantK.typ'), sReq: P(r + '.sensitivity.dominantS.req'), sTyp: P(r + '.sensitivity.dominantS.typ') });
            add(id + '·K1', 'K', id, 'k/S label', { ks: P(r + '.confidence.ks'), rules: FX('joinRules', { x: r + '.confidence.reasons' }), labels: FX('labelPair', { ks: r + '.confidence.ks', headline: r + '.confidence.headline' }),
                calibrated: P(r + '.confidence.calibrated'), outside: P(r + '.confidence.outsideCalibration'), rate: P(r + '.confidence.rates.ks.rate', 'frac'), stage: P(r + '.confidence.stage') });
            add(id + '·K2', 'K', id, 'Model and headline labels', { model: P(r + '.confidence.model'), headline: P(r + '.confidence.headline'), rate: P(r + '.confidence.rates.headline.rate', 'frac') });
        });

        // ── well level: T (trend) ──
        var tr = an.trend || {};
        var L = latestUsed >= 0 ? 'tests[' + latestUsed + ']' : null;
        var t1 = { S: P('trend.baseline.S', 'S'), sigma: P('trend.baseline.sigma', 'S'), unstable: P('trend.baseline.unstable'), provisional: P('trend.baseline.provisional'),
            tests: P('trend.baseline.tests'), nTests: P('trend.baseline.tests.length', 'n'), baseN: P('settings.trend.baseN', 'n'),
            state: FX('baseState', { unstable: 'trend.baseline.unstable', provisional: 'trend.baseline.provisional' }) };
        if (L) { t1.latest = P(L + '.id'); t1.dSLatest = FX('sub', { a: L + '.result.final.S', b: 'trend.baseline.S' }, 'S'); }
        add('T1', 'T', null, 'Baseline', t1);
        add('T2', 'T', null, 'Delta alert', { status: P('trend.alerts.delta.status'), raisedAt: P('trend.alerts.delta.raisedAt'), confirmedAt: P('trend.alerts.delta.confirmedAt'),
            threshold: P('trend.alerts.delta.threshold', 'S'), form: P('trend.alerts.delta.form'), kHeldOnly: P('trend.alerts.delta.kHeldOnly'), enabled: P('trend.enabled'),
            confirm: P('settings.trend.confirm'),
            recomputed: FL('alertRecomputed', { an: '$analysis', which: { lit: 'delta' } }, null, null, 'trend.alerts.delta.status') });
        add('T3', 'T', null, 'Absolute alert', { status: P('trend.alerts.absolute.status'), raisedAt: P('trend.alerts.absolute.raisedAt'), confirmedAt: P('trend.alerts.absolute.confirmedAt'),
            threshold: P('trend.alerts.absolute.threshold', 'S'), basis: P('trend.alerts.absolute.basis'), basisText: FX('basisText', { basis: 'trend.alerts.absolute.basis' }),
            kHeldOnly: P('trend.alerts.absolute.kHeldOnly'), loAt: P('trend.alerts.absolute.robustness.lo'), hiAt: P('trend.alerts.absolute.robustness.hi'), unchanged: P('trend.alerts.absolute.robustness.unchanged'),
            recomputed: FL('alertRecomputed', { an: '$analysis', which: { lit: 'absolute' } }, null, null, 'trend.alerts.absolute.status') });
        add('T4', 'T', null, 'Onset', { tauDays: P('trend.onset.tauDays', 'days'), date: P('trend.onset.date'), lo: P('trend.onset.interval[0]', 'days'), hi: P('trend.onset.interval[1]', 'days'),
            model: P('trend.onset.model'), alarmAt: P('trend.onset.cusum.alarmAt'), onsetAt: P('trend.onset.cusum.onsetAt'), indicative: P('trend.onset.indicative') });
        add('T5', 'T', null, 'Recent trend', { slopePer30d: P('trend.recent.slopePer30d', 'S'), ciLo: P('trend.recent.ci[0]', 'S'), ciHi: P('trend.recent.ci[1]', 'S'), mkP: P('trend.recent.mkP', 'ratio'),
            n: P('trend.recent.n', 'n'), indicative: P('trend.recent.indicative'), disagree: P('trend.recent.disagree') });
        add('T6', 'T', null, 'Forecast', { show: P('trend.forecast.show'), date: P('trend.forecast.date'), earliest: P('trend.forecast.earliest'), latest: P('trend.forecast.latest'), reason: P('trend.forecast.reason') });
        // T7 and T8: the engine's stored numbers; for oil check() recomputes them (§4.7) from each test's final m and S, the stored
        // X, the baseline S and the latest used test (q_now, k_now, S_now), with B, μ and h from the well inputs
        var oil = _fluid(an) === 'oil', testIdx = {};
        tests.forEach(function (t, i) { if (t && t.id) testIdx[t.id] = i; });
        var t7 = {};
        _arr(tr.skinDp).forEach(function (row, j) {
            if (!row || !row.id) return;
            var p7 = 'trend.skinDp[' + j + '].dpSkin_psi', ti = testIdx[row.id];
            if (oil && ti !== undefined && tests[ti].result && tests[ti].result.final) {
                var rf = 'tests[' + ti + '].result.final';
                t7[row.id + '_dpSkin'] = FS(p7, 'dpSkin', { m: rf + '.m', S: rf + '.S' }, 'p', 'pressure');
            } else t7[row.id + '_dpSkin'] = P(p7, 'p', 'pressure');
        });
        add('T7', 'T', null, 'Pressure drop across the skin', t7);
        var t8 = { X: P('trend.pi.X', 'ratio'), re_ft: P('trend.pi.re_ft', 'n', 'length'), reSource: P('trend.pi.reSource'), ratioNow: P('trend.pi.ratioNow', 'ratio'), ratioBase: P('trend.pi.ratioBase', 'ratio'),
            ratioLowerBound: P('trend.pi.ratioLowerBound'), rateAtStake: P('trend.pi.rateAtStake', 'q', _rateCat(an.rates && an.rates.unit)), rateUnit: P('trend.pi.rateUnit'),
            extraDrawdown_psi: P('trend.pi.extraDrawdown_psi', 'p', 'pressure'), cumAtStake: _volSpec('trend.pi.cumAtStake', !!(tr.pi && tr.pi.cumUnit === 'Mscf')), cumUnit: P('trend.pi.cumUnit'),
            atStakeUpperBound: P('trend.pi.atStakeUpperBound'), value: P('trend.pi.value', 'n'), guard: P('trend.pi.guard') };
        if (oil) {
            var rqc8 = _rateCat(an.rates && an.rates.unit);
            t8.X = FS('trend.pi.X', 'X', { re_ft: 'trend.pi.re_ft', rw: 'well.rw' }, 'ratio');
            t8.ratioBase = FS('trend.pi.ratioBase', 'piRatio', { X: 'trend.pi.X', S: 'trend.baseline.S' }, 'ratio');
            t8.cumAtStake = FS('trend.pi.cumAtStake', 'cumAtStake', { an: '$analysis' }, 'n', 'volume');
            if (L) {
                var LF = L + '.result.final';
                t8.ratioNow = FS('trend.pi.ratioNow', 'piRatio', { X: 'trend.pi.X', S: LF + '.S' }, 'ratio');
                t8.rateAtStake = FS('trend.pi.rateAtStake', 'rateAtStake', { qNow: L + '.Dq', X: 'trend.pi.X', Snow: LF + '.S', Sbase: 'trend.baseline.S' }, 'q', rqc8);
                t8.extraDrawdown_psi = FS('trend.pi.extraDrawdown_psi', 'extraDrawdownS', { q: L + '.Dq', B: 'well.B', mu: 'well.mu', Snow: LF + '.S', Sbase: 'trend.baseline.S', k: LF + '.k', h: 'well.h' }, 'p', 'pressure');
            }
        }
        add('T8', 'T', null, 'PI ratio and production at stake', t8);
        add('T9', 'T', null, 'k stability', { cv: P('trend.kStability.cv', 'frac'), cvPct: FX('pct100', { x: 'trend.kStability.cv' }, 'pct'), stable: P('trend.kStability.stable'),
            allocAccPct: P('trend.kStability.allocAccPct', 'pct'), cvLimPct: FX('cvLim', { allocAccPct: 'trend.kStability.allocAccPct' }, 'pct'), reading: P('trend.kStability.reading'),
            kBase: P('baseline.k', 'k', 'permeability'), cvK: P('baseline.cvK', 'frac') });
        add('T10', 'T', null, 'Pressure trend', { quantity: P('trend.pTrend.quantity'), assessable: P('trend.pTrend.assessable'), reason: P('trend.pTrend.reason'), slopePer30d: P('trend.pTrend.slopePer30d', 'p', 'pressure'),
            scatter: P('trend.pTrend.scatter', 'p', 'pressure'), depletion: P('trend.pTrend.depletion'), label: P('trend.pTrend.label') });
        var t11 = { n: P('trend.modelFree.length', 'n'), nAgree: FX('mfAgree', { rows: 'trend.modelFree' }, 'n') };
        _arr(tr.modelFree).forEach(function (row, j) {
            if (!row || !row.id) return;
            var pr = 'trend.modelFree[' + j + ']';
            t11[row.id + '_dS'] = P(pr + '.dS', 'S'); t11[row.id + '_fitted'] = P(pr + '.fittedDS', 'S'); t11[row.id + '_ref'] = P(pr + '.refId'); t11[row.id + '_agrees'] = P(pr + '.agrees');
        });
        add('T11', 'T', null, 'Model-free skin change', t11);
        var t12 = { spearman: P('trend.bubble.spearman', 'ratio'), pb: P('well.Pb', 'p', 'pressure'), n: FL('bubbleN', { an: '$analysis' }, 'n', null, 'trend.bubble'),
            nBelow: FL('bubbleBelow', { an: '$analysis' }, 'n', null, 'trend.bubble'), minMargin: FX('minMargin', { rows: 'trend.bubble.rows' }, 'p', 'pressure') };
        _arr(tr.bubble && tr.bubble.rows).forEach(function (row, j) {
            if (!row || !row.id) return;
            var pr = 'trend.bubble.rows[' + j + ']';
            t12[row.id + '_lo'] = P(pr + '.pwfSand_lo', 'p', 'pressure'); t12[row.id + '_hi'] = P(pr + '.pwfSand_hi', 'p', 'pressure');
            t12[row.id + '_margin'] = P(pr + '.margin', 'p', 'pressure'); t12[row.id + '_level'] = P(pr + '.level');
        });
        add('T12', 'T', null, 'Bubble point', t12);
        var t13 = { available: P('trend.piCheck.available'), reason: P('trend.piCheck.reason'), consistent: P('trend.piCheck.consistent'), rho: P('trend.piCheck.rho', 'ratio') };
        _arr(tr.piCheck && tr.piCheck.rows).forEach(function (row, j) {
            var pr = 'trend.piCheck.rows[' + j + ']';
            t13['r' + j + '_from'] = P(pr + '.from'); t13['r' + j + '_to'] = P(pr + '.to'); t13['r' + j + '_RJ'] = P(pr + '.RJ', 'ratio');
        });
        add('T13', 'T', null, 'PI cross-check', t13);
        var t14 = { available: P('trend.mech.available'), Sgeo: P('trend.mech.Sgeo', 'S'), SgeoLo: P('trend.mech.SgeoRange[0]', 'S'), SgeoHi: P('trend.mech.SgeoRange[1]', 'S'), basis: P('trend.mech.basis') };
        _arr(tr.series).forEach(function (row, j) {
            if (!row || !row.id) return;
            var pr = 'trend.series[' + j + ']';
            t14[row.id + '_Smech'] = P(pr + '.Smech', 'S'); t14[row.id + '_SmechErr'] = P(pr + '.SmechErr', 'S'); t14[row.id + '_Sd'] = P(pr + '.Sd', 'S');
        });
        add('T14', 'T', null, 'Mechanical skin', t14);
        add('T15', 'T', null, 'Rate-dependent skin', { resolved: P('trend.rateSkin.resolved'), S: P('trend.rateSkin.S', 'S'), D: P('trend.rateSkin.D', 'D'), seD: P('trend.rateSkin.seD', 'D'),
            reason: P('trend.rateSkin.reason'), dqEffect: P('trend.rateSkin.dqEffect', 'S'), rhoSq: FL('rhoSq', { an: '$analysis' }, 'ratio', null, 'trend.series') });
        add('T16', 'T', null, 'Tests excluded as low', { n: P('trend.excludedLow.n', 'n'), ids: P('trend.excludedLow.ids'), Slo: P('trend.excludedLow.S[0]', 'S'), Shi: P('trend.excludedLow.S[1]', 'S') });

        // ── well level: K (calibration tables, file 55) ──
        var cal = roots.cal;
        [['K1', 'ksTable', 'right', 'Calibration: k and S right'], ['K2', 'table', 'fullyRight', 'Calibration: fully right']].forEach(function (k) {
            var vals = {};
            if (cal) {
                vals.version = P('$cal.version'); vals.calibrated = P('$cal.calibrated'); vals.nBuildups = P('$cal.nBuildups', 'n');
                _arr(cal[k[1]]).forEach(function (row, j) {
                    if (!row || !row.label) return;
                    var pr = '$cal.' + k[1] + '[' + j + ']';
                    vals[row.label + '_n'] = P(pr + '.n', 'n');
                    vals[row.label + '_rate'] = FX('pct100', { x: pr + '.' + k[2] }, 'pct');
                    vals[row.label + '_lo'] = FX('pct100', { x: pr + '.lo' }, 'pct');
                    vals[row.label + '_hi'] = FX('pct100', { x: pr + '.hi' }, 'pct');
                });
            }
            add(k[0], 'K', null, k[3], vals);
        });

        // ── well level: V (review; V14 carries the hashes, counts and sign-off facts) ──
        RULE_ORDER.forEach(function (rid) {
            if (rid !== 'V14') { add(rid, 'V', null, RULES[rid].title, {}); return; }
            add('V14', 'V', null, RULES.V14.title, {
                inputsHash: P('inputHash'), resultsHash: FL('resultsHashOf', { an: '$analysis' }, null, null, 'resultHash'), results8: FL('results8', { an: '$analysis' }, null, null, 'resultHash'),
                inputs8: FX('prefix8', { h: 'inputHash' }), appVersion: P('appVersion'), runAt: P('runAt'), runDate: FX('dateOfIso', { iso: 'runAt' }),
                rawText: FX('rawText', { raw: 'record.rawStored' }),
                nCritical: P('$review.counts.critical', 'n'), nMajor: P('$review.counts.major', 'n'), nMinor: P('$review.counts.minor', 'n'), nSuggestion: P('$review.counts.suggestion', 'n'),
                nChecked: P('$review.evidenceCheck.nChecked', 'n'), nFailed: P('$review.evidenceCheck.nFailed', 'n'),
                nOpen: FX('openCount', { review: '$review' }, 'n'), nMoreFindings: FX('moreFindings', { review: '$review', shown: { lit: MAX_ROWS } }, 'n'),
                decisionsHash: FX('decisionsHashOf', { review: '$review' }), chainHash: FX('chainHead', { audit: '$audit' }), auditFolded: FX('auditFolded', { audit: '$audit' }, 'n'),
                signer: P('$signoff.name'), role: P('$signoff.role'), signedAt: FX('dateOfIso', { iso: '$signoff.at' }), sigHash: P('$signoff.hash'), sigHash16: FX('prefix16', { h: '$signoff.hash' }),
                signedVersion: P('$signoff.appVersion'), decisions: P('$signoff.decisions', 'n')
            });
        });

        // ── well level: O (overrides) ──
        _arr(an.overrides).forEach(function (o, j) {
            if (!o || !/^O\d+$/.test(o.id || '')) return;
            var po = 'overrides[' + j + ']';
            add(o.id, 'O', null, 'Override', { id: P(po + '.id'), kind: P(po + '.kind'), target: P(po + '.target'), who: P(po + '.who'), reason: P(po + '.reason'), appVersion: P(po + '.appVersion') });
        });
        return idx;
    }
    // index of the latest test used for the trend (else the latest interpreted test)
    function _latestIdx(an) {
        var tests = _arr(an && an.tests), i;
        for (i = tests.length - 1; i >= 0; i--) if (tests[i] && tests[i].result && tests[i].used && tests[i].used.trend) return i;
        for (i = tests.length - 1; i >= 0; i--) if (tests[i] && tests[i].result && tests[i].status === 'interpreted') return i;
        return -1;
    }
    // tc → index of the production day that contains it: binary search when the days are in time order (as WP2 stores them),
    // else a linear scan
    function _dayFinder(an) {
        var days = an && an.rates ? _arr(an.rates.days) : [], sorted = true;
        for (var i = 0; i < days.length; i++) {
            var d = days[i];
            if (!d || !_isNum(d.t0_ms) || !_isNum(d.t1_ms) || d.t1_ms < d.t0_ms || (i && !(d.t0_ms >= days[i - 1].t1_ms))) { sorted = false; break; }
        }
        return function (tc) {
            if (!_isNum(tc)) return -1;
            if (!sorted) { for (var j = 0; j < days.length; j++) if (days[j] && days[j].t0_ms <= tc && tc < days[j].t1_ms) return j; return -1; }
            var lo = 0, hi = days.length - 1;
            while (lo <= hi) { var mid = (lo + hi) >> 1, dm = days[mid]; if (tc < dm.t0_ms) hi = mid - 1; else if (tc >= dm.t1_ms) lo = mid + 1; else return mid; }
            return -1;
        };
    }
    function _closingDay(an, t, find) { return t ? (find || _dayFinder(an))(t.tc_ms) : -1; }
    // day indexes within ±2 days of every event's closing day (S3 day table), sorted
    function _daysAround(an, find) {
        var days = an && an.rates ? _arr(an.rates.days) : [], pick = {};
        var src = _arr(an && an.events).length ? _arr(an.events) : _arr(an && an.tests);
        find = find || _dayFinder(an);
        src.forEach(function (t) {
            if (!t) return;
            var j = find(t.tc_ms); if (j < 0) return;
            for (var k = MATH.max(0, j - 2); k <= MATH.min(days.length - 1, j + 2); k++) pick[k] = 1;
        });
        return Object.keys(pick).map(Number).sort(function (a, b) { return a - b; });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 5. Values and the evidence check (§7.3)
    // ─────────────────────────────────────────────────────────────────────
    function _isValue(o) { return _obj(o) && typeof o.ref === 'string' && typeof o.dp === 'number' && Object.prototype.hasOwnProperty.call(o, 'v'); }
    function _splitRef(ref) { var i = ref.indexOf(':'); return i === -1 ? { id: ref, name: null } : { id: ref.slice(0, i), name: ref.slice(i + 1) }; }
    // whether an index value needs a context root ($review, $signoff, $audit), cached per value
    var _ctxMemo = typeof WeakMap === 'function' ? new WeakMap() : null;
    function _ivCtx(iv) {
        if (!iv.formula) return _ctxRoot(iv.path);
        if (!_ctxMemo) return _usesCtx({ p: iv.path, f: iv.formula });
        var c = _ctxMemo.get(iv);
        if (c === undefined) { c = _usesCtx({ p: iv.path, f: iv.formula }); _ctxMemo.set(iv, c); }
        return c;
    }
    // The value a ref points to, evaluated with the given roots: undefined when the context is missing.
    // A stored derived value (FS) is recomputed with its formula from the stored inputs; when nothing is stored the formula is the
    // value, when the engine stored null the expected value is null, and when the formula cannot be evaluated (missing inputs)
    // the stored field is re-read instead (no recomputation possible, so no false failure).
    function _evalRef(iv, roots) {
        if (_ivCtx(iv)) {
            var needs = [];
            var collect = function (p) { if (typeof p === 'string' && _ctxRoot(p)) needs.push(p.split(/[.[]/)[0].slice(1)); };
            collect(iv.path);
            if (iv.formula && iv.formula.args) Object.keys(iv.formula.args).forEach(function (k) { collect(iv.formula.args[k]); });
            for (var i = 0; i < needs.length; i++) if (roots[needs[i]] === undefined || roots[needs[i]] === null) return undefined;
        }
        if (iv.stored && iv.formula) { var e = _storedRefs(iv, roots); return e.r; }
        return _clean(iv.formula ? _evalF(iv.formula, roots) : _get(roots, iv.path));
    }
    // A stored derived value has two references: the recomputation (r) and the field as stored now (s, undefined when nothing is
    // stored or when it equals r's source). A quote must agree with both, so a stale quote of a stored value is caught too.
    function _storedRefs(iv, roots) {
        var st = _get(roots, iv.path);
        if (st === undefined) return { r: _clean(_evalF(iv.formula, roots)), s: undefined };
        st = _clean(st);
        if (st === null) return { r: null, s: undefined };
        var rc = _clean(_evalF(iv.formula, roots));
        return (rc === null || rc === undefined) ? { r: st, s: undefined } : { r: rc, s: st };
    }
    // quoted q against a value-index entry: {ok, r (the reference that failed, or the recomputation)}
    function _cmpRef(q, iv, roots, dp) {
        if (iv.stored && iv.formula && !_ivCtx(iv)) {
            var e = _storedRefs(iv, roots);
            if (!_cmp(q, e.r, dp)) return { ok: false, r: e.r };
            if (e.s !== undefined && !_cmp(q, e.s, dp)) return { ok: false, r: e.s };
            return { ok: true, r: e.r };
        }
        var r = _evalRef(iv, roots);
        if (r === undefined) return { ok: true, r: undefined };
        return { ok: _cmp(q, r, dp), r: r };
    }
    // Every stored derived value of the index re-checked against its formula (run(), recheck() and report() call this), so a stored
    // engine number that disagrees with FORMULAS raises V14 even where no text quotes it. Returns {nChecked, failures}.
    function _checkDerived(idx, an, ctx) {
        var roots = _roots(an, ctx), out = { nChecked: 0, failures: [] };
        _arr(idx && idx.order).forEach(function (id) {
            var it = idx.items[id]; if (!it) return;
            for (var name in it.values) {
                var iv = it.values[name];
                if (!iv || !iv.stored || iv.v === null) continue;
                var c = _cmpRef(iv.v, iv, roots, iv.dp | 0);
                if (c.r === undefined) continue;
                out.nChecked++;
                if (!c.ok) out.failures.push({ ref: id + ':' + name, quoted: iv.v, recomputed: c.r, tol: typeof iv.v === 'number' ? 0.5 * MATH.pow(10, -(iv.dp | 0)) : 0 });
            }
        });
        return out;
    }
    var HALF_UNIT = [0.5, 0.05, 0.005, 0.0005, 0.00005, 0.000005, 0.0000005, 0.00000005, 0.000000005];
    function _cmp(q, r, dp) {
        if (q === null || q === undefined) return r === null || r === undefined;
        if (typeof q === 'number') {
            if (!_isNum(r)) return false;
            var tol = (dp >= 0 && dp <= 8) ? HALF_UNIT[dp] : 0.5 * MATH.pow(10, -dp);
            return MATH.abs(q - r) <= tol + 1e-9 * MATH.max(1, MATH.abs(r));
        }
        return String(q) === String(r);
    }
    function _checkValue(val, roots, idx) {
        var sr = _splitRef(val.ref);
        var item = idx && idx.items ? idx.items[sr.id] : null;
        var tol = 0.5 * MATH.pow(10, -(val.dp | 0));
        if (!item) return { checked: true, fail: { ref: val.ref, quoted: val.v, recomputed: null, tol: tol, reason: 'unknown evidence id' } };
        var r;
        if (_obj(val.calc)) {
            r = _clean(_evalF(val.calc, roots));
            if (r === undefined) return { checked: false };
        } else {
            var iv = sr.name ? item.values[sr.name] : null;
            if (!iv) {
                if (typeof val.v === 'number') return { checked: true, fail: { ref: val.ref, quoted: val.v, recomputed: null, tol: tol, reason: 'no source for this number' } };
                return { checked: false };
            }
            var cr = _cmpRef(val.v, iv, roots, val.dp | 0);
            if (cr.r === undefined) return { checked: false };
            if (cr.ok) return { checked: true };
            r = cr.r;
        }
        if (_cmp(val.v, r, val.dp | 0)) return { checked: true };
        return { checked: true, fail: { ref: val.ref, quoted: val.v, recomputed: r, tol: typeof val.v === 'number' ? tol : 0 } };
    }
    function check(obj, analysis, idx, ctx) {
        var an = _obj(analysis) ? analysis : {};
        idx = idx || _evidenceFor(an, ctx);
        var roots = _roots(an, ctx);
        var res = { ok: true, nChecked: 0, nFailed: 0, failures: [] };
        var seen = typeof WeakSet === 'function' ? new WeakSet() : null, seenA = [];
        (function walk(o, key) {
            if (o === null || typeof o !== 'object') return;
            if (key === 'check' || key === 'failures' || key === 'decision') return;
            if (seen) { if (seen.has(o)) return; seen.add(o); }
            else { if (seenA.indexOf(o) !== -1) return; seenA.push(o); }
            if (_isValue(o)) {
                var c = _checkValue(o, roots, idx);
                if (c.checked) res.nChecked++;
                if (c.fail) { res.nFailed++; res.failures.push(c.fail); }
                return;
            }
            if (_isArr(o)) { for (var i = 0; i < o.length; i++) walk(o[i], null); return; }
            Object.keys(o).forEach(function (k) { walk(o[k], k); });
        })(obj, null);
        res.ok = res.nFailed === 0;
        return res;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 6. Rules V1–V22 (plausibility); V14 is created from evidence-check failures
    // ─────────────────────────────────────────────────────────────────────
    var RULES = {};
    var RULE_ORDER = [];
    function defRule(id, severity, where, title, evidenceIds, fn) {
        RULES[id] = { id: id, severity: severity, where: where, title: title, acceptable: id !== 'V14', evidence: evidenceIds, fn: fn || null };
        RULE_ORDER.push(id);
    }
    function _r3(v) { return _round(v, 3); }
    function _usedAny(t) { return !!(t && t.used && (t.used.trend || t.used.alert || t.used.baseline)); }

    defRule('V1', 'major', 'S5', 'Sandface flowing pressure below the bubble point', ['T12'], function (c) {
        var out = [], pb = c.an.well && c.an.well.Pb;
        if (c.fluid !== 'oil' || !_isNum(pb) || !c.an.trend || !c.an.trend.bubble) return out;
        _arr(c.an.trend.bubble.rows).forEach(function (row) {
            var t = c.test(row && row.id); if (!t || t.status !== 'interpreted') return;
            if (!(row.level === 'major' || row.level === 'critical' || (_isNum(row.pwfSand_hi) && row.pwfSand_hi < pb))) return;
            out.push({ subject: t.id, tests: [t.id], ev: ['T12', t.id + '·D3'],
                       template: '{test}: sandface flowing pressure at closing ({lo} to {hi}) is below the bubble point ({pb}).',
                       values: { test: c.V(t.id + '·A2', 'test'), lo: c.V('T12', t.id + '_lo'), hi: c.V('T12', t.id + '_hi'), pb: c.V('T12', 'pb') } });
        });
        return out;
    });
    defRule('V2', 'critical', 'S5', 'Extrapolated pressure below the bubble point', ['T12', 'L1'], function (c) {
        var out = [], pb = c.an.well && c.an.well.Pb, tr = c.an.trend;
        if (c.fluid !== 'oil' || !_isNum(pb) || !tr || !tr.pTrend || tr.pTrend.assessable !== true) return out;
        c.tests.forEach(function (t) {
            if (!t.result || !_usedAny(t) || !_isNum(t.pExtDatum) || !(t.pExtDatum < pb)) return;
            out.push({ subject: t.id, tests: [t.id], ev: ['T12', t.id + '·L1'],
                       template: '{test}: the extrapolated reservoir pressure ({pe}) is below the bubble point ({pb}).',
                       values: { test: c.V(t.id + '·A2', 'test'), pe: c.V(t.id + '·A2', 'pExtDatum'), pb: c.V('T12', 'pb') } });
        });
        return out;
    });
    defRule('V3', 'major', 'S5', 'Non-Darcy skin significant and not resolved', ['T15'], function (c) {
        var rs = c.an.trend && c.an.trend.rateSkin;
        if (c.fluid !== 'gas' || !rs || rs.resolved === true || !_isNum(rs.dqEffect) || !(_round(MATH.abs(rs.dqEffect), 2) > 0.5)) return [];
        return [{ subject: '', tests: [], ev: ['T15'],
                  template: 'Gas well: the expected non-Darcy skin at the test rates ({dq}) is above half a skin unit and the rate-dependent skin is not resolved.',
                  values: { dq: c.V('T15', 'dqEffect') } }];
    });
    defRule('V4', 'major', 'S3', 'Water cut or GOR with an oil-only rate basis', ['R7'], function (c) {
        var pb = c.an.rates && c.an.rates.phaseBasis;
        if (c.fluid !== 'oil' || !pb) return [];
        var wcHigh = _isNum(pb.wcMax) && _r3(pb.wcMax) > 0.05, gorHigh = _isNum(pb.gorRatioMax) && _r3(pb.gorRatioMax) > 1.2;
        if (!((pb.used === 'oil' && (wcHigh || gorHigh)) || pb.twoPhaseCt === true)) return [];
        return [{ subject: '', tests: [], ev: ['R7'],
                  template: 'Rate basis {basis}: maximum water cut {wc} % and GOR ratio to Rs {gor}; two-phase compressibility flagged: {tp}.',
                  values: { basis: c.V('R7', 'used'), wc: c.V('R7', 'wcPct'), gor: c.V('R7', 'gorRatioMax'), tp: c.V('R7', 'twoPhaseCt') } }];
    });
    defRule('V5', 'suggestion', 'S7', 'Stimulation-candidate review', ['T2', 'T9'], function (c) {
        var tr = c.an.trend;
        if (!tr || !tr.alerts || !tr.alerts.delta || tr.alerts.delta.status !== 'confirmed' || !tr.kStability || tr.kStability.stable !== true) return [];
        return [{ subject: '', tests: [tr.alerts.delta.confirmedAt].filter(Boolean), ev: ['T2', 'T9'],
                  template: 'Confirmed delta alert at {test} with stable k (CV {cv} %): review the well as a stimulation candidate.',
                  values: { test: c.V('T2', 'confirmedAt'), cv: c.V('T9', 'cvPct') } }];
    });
    defRule('V6', 'major', 'S5', 'k varies between tests', ['T9'], function (c) {
        var ks = c.an.trend && c.an.trend.kStability;
        if (!ks || !_isNum(ks.cv)) return [];
        var lim = MATH.max(0.05, _isNum(ks.allocAccPct) ? ks.allocAccPct / 100 : 0.05);
        if (!(_r3(ks.cv) > _r3(lim))) return [];
        return [{ subject: '', tests: [], ev: ['T9'], template: 'k varies between tests: CV {cv} % against an allowed {lim} %.',
                  values: { cv: c.V('T9', 'cvPct'), lim: c.V('T9', 'cvLimPct') } }];
    });
    defRule('V7', 'critical', 'S3', 'Allocation check failed or unavailable on an alert test', ['R3', 'R4', 'T2'], function (c) {
        var out = [];
        c.tests.forEach(function (t) {
            if (!t.result || !t.used || !t.used.alert || !t.spec || !t.spec.rateQC) return;
            var q = t.spec.rateQC, ev = [t.id + '·R3', t.id + '·R4', 'T2'];
            if (q.r3Status === 'fail' || q.r3Status === 'unavailable') {
                out.push({ subject: t.id + ':R3', tests: [t.id], ev: ev,
                           template: '{test} is used for the alerts but its allocation check is {st} (r = {r} on {date}).',
                           values: { test: c.V(t.id + '·A2', 'test'), st: c.V(t.id + '·R3', 'status'), r: c.V(t.id + '·R3', 'r3'), date: c.V(t.id + '·R3', 'date') } });
            }
            if (q.r4Status === 'fail') {
                out.push({ subject: t.id + ':R4', tests: [t.id], ev: ev,
                           template: '{test} is used for the alerts but its pressure-based rate check failed (ratio {r}).',
                           values: { test: c.V(t.id + '·A2', 'test'), r: c.V(t.id + '·R4', 'r4') } });
            }
        });
        return out;
    });
    defRule('V8', 'major', 'S5', 'Baseline unstable or provisional', ['T1'], function (c) {
        var b = c.an.trend && c.an.trend.baseline;
        if (!b || !(b.unstable === true || b.provisional === true)) return [];
        return [{ subject: '', tests: _arr(b.tests), ev: ['T1'], template: 'The skin baseline is {state} (tests {tests}; S {s}).',
                  values: { state: c.V('T1', 'state'), tests: c.V('T1', 'tests'), s: c.V('T1', 'S') } }];
    });
    defRule('V9', 'suggestion', 'S7', 'Shut-ins too short for IARF on most tests', ['W4'], function (c) {
        var rs = _reachSummary(c.an);
        if (!(rs.n > 0 && rs.nShort * 2 > rs.n)) return [];
        var ev = ['W4'];
        c.tests.forEach(function (t) { var d = _testDte(t); if (t.result && t.result.reach && _isNum(d) && t.result.reach.fair_h > d) ev.push(t.id + '·W4'); });
        return [{ subject: '', tests: [], ev: ev,
                  template: 'The expected IARF reach exceeds the test on most tests ({n} of {m}): this well needs a shut-in of at least {x} h.',
                  values: { n: c.V('W4', 'nShort'), m: c.V('W4', 'n'), x: c.V('W4', 'fairShutMedian') } }];
    });
    defRule('V10', 'minor', 'S2', 'Tide or drift index above its limit', ['Q5', 'Q6'], function (c) {
        var out = [];
        c.tests.forEach(function (t) {
            var q = t.result && t.result.quality; if (!q) return;
            var tide = _isNum(q.rTide) && _r3(q.rTide) > 0.10 && q.tideRemoved !== true;
            var drift = _isNum(q.rDrift) && _r3(q.rDrift) > 0.05;
            if (!tide && !drift) return;
            out.push({ subject: t.id, tests: [t.id], ev: [t.id + '·Q5', t.id + '·Q6'],
                       template: '{test}: tide index {rt} (removed: {rem}) or drift index {rd} is above its limit.',
                       values: { test: c.V(t.id + '·A2', 'test'), rt: c.V(t.id + '·Q6', 'rTide'), rem: c.V(t.id + '·Q6', 'tideRemoved'), rd: c.V(t.id + '·Q5', 'rDrift') } });
        });
        return out;
    });
    defRule('V11', 'major', 'S5', 'PI cross-check outside its band', ['T13'], function (c) {
        var pc = c.an.trend && c.an.trend.piCheck, out = [];
        if (!pc || pc.available !== true) return out;
        _arr(pc.rows).forEach(function (row, j) {
            if (!row || !_isNum(row.RJ)) return;
            var rj = _r3(row.RJ);
            if (rj >= 0.8 && rj <= 1.25) return;
            out.push({ subject: row.from + '-' + row.to, tests: [row.from, row.to].filter(function (x) { return /^B\d+$/.test(x || ''); }), ev: ['T13'],
                       template: 'PI cross-check from {from} to {to}: observed over predicted PI is {rj}, outside its expected band.',
                       values: { from: c.V('T13', 'r' + j + '_from'), to: c.V('T13', 'r' + j + '_to'), rj: c.V('T13', 'r' + j + '_RJ') } });
        });
        return out;
    });
    defRule('V12', 'major', 'S5', 'Skin rise correlates with rate or with the pressure drop below Pb', ['T12', 'T15'], function (c) {
        var tr = c.an.trend; if (!tr) return [];
        if (c.fluid === 'oil') {
            var sp = tr.bubble && tr.bubble.spearman, n = tr.bubble ? _arr(tr.bubble.rows).length : 0;
            if (!_isNum(sp) || n < 4 || !(_r3(sp) >= 0.7)) return [];
            return [{ subject: 'oil', tests: [], ev: ['T12', 'T15'],
                      template: 'Skin correlates with the pressure drop below the bubble point (Spearman {rho}): the rise may be two-phase flow near the well, not damage.',
                      values: { rho: c.V('T12', 'spearman') } }];
        }
        if (c.fluid === 'gas') {
            var rho = _rhoSq(c.an);
            if (!_isNum(rho) || !(_r3(rho) >= 0.7)) return [];
            return [{ subject: 'gas', tests: [], ev: ['T12', 'T15'],
                      template: 'Skin correlates with the gas rate (Spearman {rho}): the rise may be non-Darcy skin, not damage.',
                      values: { rho: c.V('T15', 'rhoSq') } }];
        }
        return [];
    });
    defRule('V13', 'minor', 'S6', 'Physical inputs left at their defaults', ['U2'], function (c) {
        var d = _arr(c.an.well && c.an.well.defaulted).filter(function (k) { return ['h', 'mu', 'B', 'phi', 'ct', 'rw'].indexOf(k) !== -1; });
        if (!d.length) return [];
        return [{ subject: '', tests: [], ev: ['U2'], template: 'Inputs left at their defaults: {list}. k and S scale with them; verify them.',
                  values: { list: c.V('U2', 'defaultedPhys') } }];
    });
    defRule('V14', 'critical', 'any', 'A quoted number differs from the analysis (evidence check)', [], null);
    defRule('V15', 'major', 'S4', 'Estimated history and a sensitive result on a used test', ['R5'], function (c) {
        var out = [];
        c.tests.forEach(function (t) {
            var r = t.result; if (!r || !r.history || r.history.sensitive !== true || !_usedAny(t)) return;
            if (!(r.history.estimated === true || (t.spec && t.spec.history && t.spec.history.estimated === true))) return;
            out.push({ subject: t.id, tests: [t.id], ev: [t.id + '·R5'],
                       template: '{test}: the production history before the data is estimated and the result depends on it (derivative change {d} %).',
                       values: { test: c.V(t.id + '·A2', 'test'), d: c.V(t.id + '·R5', 'dDerivPct') } });
        });
        return out;
    });
    defRule('V16', 'major', 'S3', 'The offset scan prefers another gauge or production-day offset', ['R3'], function (c) {
        var os = c.an.rates && c.an.rates.offsetScan;
        if (!os || os.better !== true) return [];
        return [{ subject: '', tests: [], ev: ['R3'], template: 'The offset scan prefers an offset of {best} h over the current {cur} h (improvement {imp}).',
                  values: { best: c.V('R3', 'best_h'), cur: c.V('R3', 'current_h'), imp: c.V('R3', 'improvement') } }];
    });
    defRule('V17', 'major', 'S4', 'Partial-cut suspicion on an interpreted test', ['R1', 'I3'], function (c) {
        return c.tests.filter(function (t) { return t.result && t.status === 'interpreted' && t.partialSuspect === true; }).map(function (t) {
            return { subject: t.id, tests: [t.id], ev: [t.id + '·R1', t.id + '·I3'],
                     template: '{test}: the IARF level ({lvl}) suggests a partial rate cut rather than a full shut-in.',
                     values: { test: c.V(t.id + '·A2', 'test'), lvl: c.V(t.id + '·I3', 'level_psi') } };
        });
    });
    defRule('V18', 'minor', 'S4', 'Closed circle without depletion in the pressure trend', ['M6', 'T10'], function (c) {
        var pt = c.an.trend && c.an.trend.pTrend;
        if (!pt || pt.assessable !== true) return [];
        var listed = _arr(c.an.trend.crossTest && c.an.trend.crossTest.closedWithoutDepletion);
        return c.tests.filter(function (t) {
            return t.result && t.status === 'interpreted' && t.result.chosen && t.result.chosen.key === 'closedCircle' && (pt.depletion === false || listed.indexOf(t.id) !== -1);
        }).map(function (t) {
            return { subject: t.id, tests: [t.id], ev: [t.id + '·M6', 'T10'],
                     template: '{test}: closed circle chosen but the pressure trend shows no depletion; a constant-pressure boundary or interference can look the same.',
                     values: { test: c.V(t.id + '·A2', 'test') } };
        });
    });
    defRule('V19', 'major', 'S4', 'Boundary call depends on the background trend', ['M7'], function (c) {
        return c.tests.filter(function (t) {
            var r = t.result; return r && ((r.background && r.background.boundaryDepends === true) || (r.evidence && r.evidence.boundaryDepends === true));
        }).map(function (t) {
            return { subject: t.id, tests: [t.id], ev: [t.id + '·M7'], template: '{test}: the boundary model depends on the background pressure trend.',
                     values: { test: c.V(t.id + '·A2', 'test') } };
        });
    });
    defRule('V20', 'major', 'S4', 'IARF level inconsistent with the baseline kh', ['I3', 'T9'], function (c) {
        var listed = _arr(c.an.trend && c.an.trend.crossTest && c.an.trend.crossTest.windowLevelInconsistent);
        return c.tests.filter(function (t) {
            return t.result && (listed.indexOf(t.id) !== -1 || (t.result.evidence && t.result.evidence.windowLevelInconsistent === true));
        }).map(function (t) {
            return { subject: t.id, tests: [t.id], ev: [t.id + '·I3', 'T9'],
                     template: '{test}: the IARF level implies k = {k}, inconsistent with the baseline k ({kb}); the window may sit on a later plateau.',
                     values: { test: c.V(t.id + '·A2', 'test'), k: c.V(t.id + '·I3', 'kLevel'), kb: c.V('T9', 'kBase') } };
        });
    });
    defRule('V21', 'minor', 'S12', 'Outside the calibration envelope, or labels not calibrated', ['K1'], function (c) {
        var withRes = c.tests.filter(function (t) { return t.result && t.result.confidence; });
        if (!withRes.length) return [];
        if (withRes.every(function (t) { return t.result.confidence.calibrated === false; })) {
            var t0 = withRes[withRes.length - 1];
            return [{ subject: 'uncalibrated', tests: [], ev: [t0.id + '·K1'], template: 'The confidence labels are not calibrated yet (calibrated: {cal}); every label is capped at medium.',
                      values: { cal: c.V(t0.id + '·K1', 'calibrated') } }];
        }
        return withRes.filter(function (t) { return t.result.confidence.outsideCalibration === true || t.result.confidence.calibrated === false; }).map(function (t) {
            return { subject: t.id, tests: [t.id], ev: [t.id + '·K1'], template: '{test}: outside the calibration envelope, or its label is not calibrated (outside: {out}).',
                     values: { test: c.V(t.id + '·A2', 'test'), out: c.V(t.id + '·K1', 'outside') } };
        });
    });
    defRule('V22', 'minor', 'S10', 'An override changed a test used for an alert', ['O', 'T2'], function (c) {
        var out = [];
        _arr(c.an.overrides).forEach(function (o) {
            if (!o || !/^O\d+$/.test(o.id || '')) return;
            var t = c.test(o.target);
            if (!t || !t.used || !t.used.alert) return;
            out.push({ subject: o.id, tests: [t.id], ev: [o.id, 'T2'], template: 'Override {ov} ({kind}) changed {test}, which is used for the alerts.',
                       values: { ov: c.V(o.id, 'id'), kind: c.V(o.id, 'kind'), test: c.V(t.id + '·A2', 'test') } });
        });
        return out;
    });
    defRule('V23', 'major', 'S4', 'Re-derived k differs from the final k', ['I3', 'A2'], _V23);
    defRule('V24', 'major', 'S4', 'Re-derived skin differs from the final skin', ['I4', 'A2'], _V24);
    defRule('V25', 'major', 'S3', 'Re-derived rate differs from the rate used', ['R1', 'R2'], _V25);
    defRule('V26', 'major', 'S4', 'Model choice differs from the stored BIC table', ['M4', 'M6'], _V26);
    defRule('V27', 'major', 'S5', 'Alert status differs from the stored series', ['T2', 'T3'], _V27);

    // Confidence rule texts (S4 reasons table; no numbers)
    var K_TEXT = {
        KL1: 'No IARF window and no fully seen rival.', KL2: 'Skin uncertainty above the low limit.',
        KL3: 'A rate check failed by a wide margin, or the rate before closing is unknown.', KL4: 'A storage hump or steep storage inside or after the IARF start.',
        KL5: 'Derivative signal-to-noise below the low limit in the window.', KL6: 'Line and match disagree and the bias does not explain it.',
        KL7: 'The test ends too early for the window to be IARF.', KL8: 'Partial-cut suspicion from the IARF level.',
        KL9: 'A distractor flag overlaps or precedes the IARF window.', KK1: 'The k-held fit did not converge.',
        KK2: 'Storage and skin are strongly correlated in the k-held fit.', KK3: 'The k-held fit residual is large against the noise.',
        KK4: 'The k-held skin uncertainty is above the low limit.', KC1: 'History start estimated and the derivative depends on it.',
        KC2: 'Outside the calibration envelope, or labels not calibrated.', KC3: 'k-held result (k fixed at the baseline median).',
        KC4: 'Allocation check unavailable or equal rates assumed.', KC5: 'IARF level inconsistent with the baseline kh.',
        KC6: 'Rate step interpreted with a reduced rate fraction.', KH1: 'IARF window good, or fair and long with a small point-skin spread.',
        KH2: 'Line and match agree.', KH3: 'Skin uncertainty within the high limit.', KH4: 'Unit slope sampled, or both storage refits rejected.',
        KH5: 'Allocation and pressure rate checks pass.', KH6: 'High derivative signal-to-noise, small drift and tide, no anomaly flag.'
    };

    // ─────────────────────────────────────────────────────────────────────
    // 7. run, recheck, decisions
    // ─────────────────────────────────────────────────────────────────────
    var SEV_RANK = { critical: 0, major: 1, minor: 2, suggestion: 3 };
    function _ctxFor(an, idx, roots) {
        var tests = _arr(an.tests).filter(function (t) { return t && t.id; });
        var byId = {};
        tests.forEach(function (t) { byId[t.id] = t; });
        return {
            an: an, idx: idx, tests: tests, fluid: _fluid(an), gas: _fluid(an) === 'gas',
            test: function (id) { return byId[id] || null; },
            V: function (id, name) { return _valueOf(idx, roots, id, name); }
        };
    }
    function _valueOf(idx, roots, id, name) {
        var item = idx && idx.items ? idx.items[id] : null;
        var iv = item ? item.values[name] : null;
        var v = iv ? iv.v : null;
        if (iv && _ivCtx(iv)) { var e = _evalRef(iv, roots); v = e === undefined ? null : e; }
        return { v: v === undefined ? null : v, cat: iv ? iv.cat : null, dp: iv ? iv.dp : 0, ref: id + ':' + name };
    }
    function _mkFinding(rule, o, idx) {
        var ev = _uniq(_arr(o.ev)).filter(function (id) { return idx.items[id]; });
        return { id: null, key: rule.id + ':' + (o.subject || ''), rule: rule.id, severity: rule.severity, acceptable: rule.acceptable, where: rule.where,
                 template: o.template, values: o.values || {}, ev: ev.length ? ev : [rule.id], check: { ok: true, failures: [] }, decision: null, tests: _arr(o.tests) };
    }
    function _v14For(fail, idx) {
        var sr = _splitRef(String(fail.ref || ''));
        var ev = ['V14'];
        if (idx.items[sr.id] && sr.id !== 'V14') ev.push(sr.id);
        return { id: null, key: 'V14:' + fail.ref, rule: 'V14', severity: 'critical', acceptable: false, where: 'any',
                 template: 'A quoted value ({ref}) differs from the analysis; re-run the analysis before sign-off.',
                 values: { ref: { v: String(fail.ref), cat: null, dp: 0, ref: 'V14:ref' } }, ev: ev,
                 check: { ok: false, failures: [fail] }, decision: null, tests: /^B\d+$/.test(sr.id.split('·')[0]) ? [sr.id.split('·')[0]] : [] };
    }
    function _renumber(review) {
        var num = function (rid) { return parseInt(String(rid).slice(1), 10) || 0; };
        review.findings.sort(function (a, b) { return (num(a.rule) - num(b.rule)) || (a._seq - b._seq); });
        review.findings.forEach(function (f, i) { f.id = 'F' + (i + 1); });
        var c = { critical: 0, major: 0, minor: 0, suggestion: 0 };
        review.findings.forEach(function (f) { if (f.severity in c) c[f.severity]++; });
        review.counts = c;
        return review;
    }
    function _strip(review) { review.findings.forEach(function (f) { delete f._seq; }); return review; }
    // Add V14 findings for failures not yet reported; returns the number added.
    function _addV14(review, failures, idx) {
        var have = {}, seq = review.findings.length, n = 0;
        review.findings.forEach(function (f) { if (f.rule === 'V14') have[f.key] = 1; f._seq = f._seq === undefined ? seq++ : f._seq; });
        failures.forEach(function (fl) {
            var f = _v14For(fl, idx);
            if (have[f.key]) return;
            have[f.key] = 1; f._seq = seq++; review.findings.push(f); n++;
        });
        if (n) { _renumber(review); }
        _strip(review);
        return n;
    }
    function run(analysis, idx, opts) {
        opts = opts || {};
        var an = _obj(analysis) ? analysis : {};
        idx = idx || _evidenceFor(an, opts);
        var roots = _roots(an, opts);
        var c = _ctxFor(an, idx, roots);
        var findings = [], warnings = [], seq = 0;
        RULE_ORDER.forEach(function (rid) {
            var rule = RULES[rid]; if (!rule.fn) return;
            var out;
            try { out = rule.fn(c) || []; }
            catch (e) { warnings.push({ code: 'RULE_ERROR', level: 'warn', text: 'Rule ' + rid + ' could not be evaluated on this analysis.', ev: [rid] }); out = []; }
            out.forEach(function (o) { var f = _mkFinding(rule, o, idx); f._seq = seq++; findings.push(f); });
        });
        // resultHash: the results hash recomputed from this analysis (not the stored one), so sign-off can tell a stale review
        var review = { version: 'r1', at: _now(opts), findings: findings, counts: null, evidenceCheck: { ok: true, nChecked: 0, nFailed: 0 },
                       inputHash: an.inputHash || GENESIS, resultHash: _resultsHash(an) || an.resultHash || GENESIS, warnings: warnings };
        _renumber(review);
        // evidence check of every finding's own values and of every stored derived value of the index (V14 for failures)
        var allFail = [], nChecked = 0;
        review.findings.forEach(function (f) {
            var r = check({ values: f.values }, an, idx, { review: review, cal: roots.cal });
            nChecked += r.nChecked;
            f.check = { ok: r.ok, failures: r.failures };
            allFail = allFail.concat(r.failures);
        });
        var dc = _checkDerived(idx, an, { review: review, cal: roots.cal });
        nChecked += dc.nChecked; allFail = allFail.concat(dc.failures);
        review.evidenceCheck = { ok: allFail.length === 0, nChecked: nChecked, nFailed: allFail.length };
        _addV14(review, allFail, idx);
        _strip(review);
        return review;
    }
    // Re-run the evidence check of a stored review against the analysis; failures add V14 findings.
    function recheck(review, analysis, idx, opts) {
        if (!_obj(review)) return review;
        var an = _obj(analysis) ? analysis : {};
        idx = idx || _evidenceFor(an, opts);
        var roots = _roots(an, opts);
        var allFail = [], nChecked = 0;
        _arr(review.findings).forEach(function (f) {
            if (f.rule === 'V14') return;
            var r = check({ values: f.values }, an, idx, { review: review, cal: roots.cal });
            nChecked += r.nChecked;
            f.check = { ok: r.ok, failures: r.failures };
            allFail = allFail.concat(r.failures);
        });
        var dc = _checkDerived(idx, an, { review: review, cal: roots.cal });
        nChecked += dc.nChecked; allFail = allFail.concat(dc.failures);
        var prev = review.evidenceCheck || { nChecked: 0, nFailed: 0 };
        _addV14(review, allFail, idx);
        var nV14 = review.findings.filter(function (f) { return f.rule === 'V14'; }).length;
        review.evidenceCheck = { ok: nV14 === 0, nChecked: MATH.max(nChecked, prev.nChecked || 0), nFailed: MATH.max(allFail.length, nV14) };
        return review;
    }
    var DECISION_CODES = { accept: 1, reject: 1, note: 1 };
    function applyDecisions(review, decisions) {
        if (!_obj(review)) return review;
        var list = _isArr(decisions) ? decisions : _decisionsFromAudit(decisions);
        _arr(review.findings).forEach(function (f) {
            var dec = f.decision || null;
            list.forEach(function (d) {
                if (!d) return;
                var tgt = d.target;
                if (tgt !== f.key && tgt !== f.rule && tgt !== f.id) return;
                var clear = d.d === null || d.d === undefined || d.d === 'clear';
                if (!clear && !DECISION_CODES[d.d]) return;                 // unknown decision codes are ignored
                dec = clear ? null
                    : { d: d.d, note: (typeof d.note === 'string' && d.note.trim()) ? d.note.slice(0, 600) : null, who: _str(d.who), at: d.at || null };
            });
            if (dec && !dec.at) dec.at = new Date(0).toISOString();
            f.decision = dec;
        });
        return review;
    }
    function _decisionsFromAudit(log) {
        var L = _auditLog(log);
        if (!L) return [];
        return L.entries.filter(function (e) { return e && e.kind === 'decision'; }).map(function (e) {
            var v = e.value;
            return { target: e.target, d: _obj(v) ? v.d : v, note: _obj(v) && v.note ? v.note : (e.reason || null), who: e.who, at: e.at };
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 8. Hashes, signature, status, sign-off (§8.3, §8.4)
    // ─────────────────────────────────────────────────────────────────────
    function hashes(analysis, review) {
        var an = _obj(analysis) ? analysis : {};
        return { inputsHash: an.inputHash || null, resultsHash: _resultsHash(an), decisionsHash: _decisionsHash(review || { findings: [] }) };
    }
    function _currentVersion(an) {
        try { if (typeof G.WTS_appVersion === 'function') { var v = G.WTS_appVersion(); if (v) return String(v); } } catch (e) { /* host getter missing */ }
        return (an && an.appVersion) || '';
    }
    function _sigHash(h, name, role, at) { return sha256(_canon({ inputsHash: h.inputsHash, resultsHash: h.resultsHash, decisionsHash: h.decisionsHash, name: name, role: role, at: at }, 'display')); }
    function signature(analysis, review, form) {
        var an = _obj(analysis) ? analysis : {};
        var h = hashes(an, review);
        var hash = null;
        if (form && typeof form.name === 'string' && form.name.trim()) hash = _sigHash(h, form.name.trim(), _str(form.role), form.at || null);
        return { hash: hash, inputsHash: h.inputsHash, resultsHash: h.resultsHash, decisionsHash: h.decisionsHash, appVersion: an.appVersion || '', runAt: an.runAt || null };
    }
    function canSign(review) {
        var open = [];
        _arr(review && review.findings).forEach(function (f) {
            if (!f) return;
            var dec = f.decision && DECISION_CODES[f.decision.d] ? f.decision : null;
            if (f.rule === 'V14') { open.push(f.id); return; }
            if ((f.severity === 'critical' || f.severity === 'major') && !dec) { open.push(f.id); return; }
            if (dec && dec.d === 'reject' && !(typeof dec.note === 'string' && dec.note.trim())) open.push(f.id);
        });
        return { ok: open.length === 0, open: open };
    }
    function _fail(code, errors, bad) { return { ok: false, code: code, errors: errors, bad: bad || [] }; }
    // The review must have been built for this state of the analysis: same inputs hash and the same results hash recomputed now;
    // the evidence check of the review is then re-run against the analysis (recheck adds V14 for any quote that no longer matches).
    function signoff(form, analysis, review) {
        var an = _obj(analysis) ? analysis : {};
        if (!form || typeof form.name !== 'string' || !form.name.trim()) return _fail('NO_NAME', ['Enter the name of the person signing off.'], ['name']);
        if (form.statement !== true) return _fail('NO_STATEMENT', ['Tick the statement "I have reviewed the analysis and the findings".'], ['statement']);
        var rh = _resultsHash(an);
        if (typeof an.inputHash !== 'string' || !rh) return _fail('NO_ANALYSIS', ['Run an analysis before sign-off.'], []);
        var rv = _obj(review) ? review : { findings: [] };
        if (!_obj(review) || rv.inputHash !== an.inputHash || rv.resultHash !== rh) {
            return _fail('EVIDENCE_CHECK_FAILED', ['The review was built for an earlier state of the analysis: run the analysis and the review again before sign-off.'], []);
        }
        recheck(rv, an);
        var v14 = _arr(rv.findings).filter(function (f) { return f && f.rule === 'V14'; });
        if (v14.length || (rv.evidenceCheck && rv.evidenceCheck.ok === false)) return _fail('EVIDENCE_CHECK_FAILED', ['The evidence check failed: re-run the analysis before sign-off.'], v14.map(function (f) { return f.id; }));
        var cs = canSign(rv);
        if (!cs.ok) return _fail('OPEN_FINDINGS', ['Decide every critical and major finding (and add a note to every rejection) before sign-off.'], cs.open);
        var at = typeof form.at === 'string' ? form.at : new Date().toISOString();
        var name = form.name.trim(), role = _str(form.role).trim();
        var h = hashes(an, rv);
        return { ok: true, name: name, role: role, statement: true, at: at, hash: _sigHash(h, name, role, at),
                 inputsHash: h.inputsHash, resultsHash: h.resultsHash, decisionsHash: h.decisionsHash,
                 appVersion: typeof form.appVersion === 'string' ? form.appVersion : _currentVersion(an), runAt: an.runAt || null,
                 decisions: _decisionList(rv).length, open: 0 };
    }
    function status(analysis, review, so) {
        if (!_obj(so) || typeof so.hash !== 'string' || !so.hash) return 'DRAFT';
        var h = hashes(analysis, review);
        if (h.inputsHash !== so.inputsHash || h.resultsHash !== so.resultsHash || h.decisionsHash !== so.decisionsHash) return 'CHANGED';
        if (_sigHash({ inputsHash: so.inputsHash, resultsHash: so.resultsHash, decisionsHash: so.decisionsHash }, so.name, _str(so.role), so.at || null) !== so.hash) return 'CHANGED';
        // a quoted number that no longer matches the analysis (V14, e.g. a field outside the results hash) voids the signature
        if (_obj(review) && (_arr(review.findings).some(function (f) { return f && f.rule === 'V14'; }) || (review.evidenceCheck && review.evidenceCheck.ok === false))) return 'CHANGED';
        return 'SIGNED';
    }

    // ─────────────────────────────────────────────────────────────────────
    // 9. Audit chain (§3.12, §8.5): hash = hash16(prevHash + canon(entry without hash)); folded beyond 500 entries
    // ─────────────────────────────────────────────────────────────────────
    var AUDIT_MAX = 500, AUDIT_BYTES = 200000;
    function _auditLog(a) {
        if (_isArr(a)) return { v: 1, entries: a, summary: null };
        if (_obj(a) && _isArr(a.entries)) return a;
        return null;
    }
    // Lossless: numeric leaves are serialised exactly (String(n), the shortest round-trip form) before canon, so canon sorts the keys
    // but rounds nothing; an edit at any digit of an entry breaks the chain.
    function _exactLeaves(v) {
        if (typeof v === 'number') return 'n:' + String(v);
        if (_isArr(v)) return v.map(_exactLeaves);
        if (v !== null && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = _exactLeaves(v[k]); }); return o; }
        return v;
    }
    function entryHash(prevHash, entry) {
        var e = {};
        Object.keys(entry || {}).forEach(function (k) { if (k !== 'hash') e[k] = entry[k]; });
        var a = _AI();
        return a ? a.hash16(_str(prevHash) + a.canon(_exactLeaves(e), 'inputs')) : null;
    }
    function auditHead(log) {
        var L = _auditLog(log); if (!L) return GENESIS;
        if (L.entries.length) return L.entries[L.entries.length - 1].hash;
        return (L.summary && L.summary.chainHash) || GENESIS;
    }
    function auditFold(log, opts) {
        var L = _auditLog(log); if (!L) return { v: 1, entries: [], summary: null };
        opts = opts || {};
        var max = _isNum(opts.max) ? opts.max : AUDIT_MAX, maxBytes = _isNum(opts.maxBytes) ? opts.maxBytes : AUDIT_BYTES;
        var entries = L.entries.slice(), summary = L.summary ? JSON.parse(JSON.stringify(L.summary)) : null;
        var cut = MATH.max(0, entries.length - max);
        var total = 1;
        for (var i = cut; i < entries.length; i++) total += _entryBytes(entries[i]) + 1;
        while (cut < entries.length - 1 && total > maxBytes) { total -= _entryBytes(entries[cut]) + 1; cut++; }
        if (cut <= 0) return { v: 1, entries: entries, summary: summary };
        var folded = entries.slice(0, cut);
        var counts = summary ? Object.assign({}, summary.counts) : {};
        folded.forEach(function (e) { var k = (e && e.kind) || 'other'; counts[k] = (counts[k] || 0) + 1; });
        var last = folded[folded.length - 1];
        summary = { from: summary ? summary.from : folded[0].seq, to: last.seq, n: (summary ? summary.n : 0) + folded.length, counts: counts,
                    chainHash: last.hash, fromAt: summary ? summary.fromAt : (folded[0].at || null), toAt: last.at || null };
        return { v: 1, entries: entries.slice(cut), summary: summary };
    }
    // JSON size of an entry, cached per entry object (entries are never edited, §3.12)
    var _sizes = typeof WeakMap === 'function' ? new WeakMap() : null;
    function _entryBytes(e) {
        if (!e || typeof e !== 'object') return 4;
        if (_sizes && _sizes.has(e)) return _sizes.get(e);
        var n = JSON.stringify(e).length;
        if (_sizes) _sizes.set(e, n);
        return n;
    }
    function auditAppend(log, entry, opts) {
        var L = _auditLog(log) || { v: 1, entries: [], summary: null };
        var lastSeq = L.entries.length ? L.entries[L.entries.length - 1].seq : (L.summary ? L.summary.to : 0);
        var e = {};
        Object.keys(entry || {}).forEach(function (k) { if (k !== 'hash' && k !== 'prevHash' && k !== 'seq') e[k] = entry[k]; });
        e.seq = (_isNum(lastSeq) ? lastSeq : 0) + 1;
        if (!e.at) e.at = new Date().toISOString();
        e.prevHash = auditHead(L);
        e.hash = entryHash(e.prevHash, e);
        return auditFold({ v: 1, entries: L.entries.concat([e]), summary: L.summary }, opts);
    }
    function auditVerify(log) {
        var L = _auditLog(log);
        if (!L) return { ok: false, n: 0, head: null, brokenAt: null, reason: 'not an audit log' };
        var prev = (L.summary && L.summary.chainHash) || GENESIS;
        var seq = L.summary ? L.summary.to : null;
        for (var i = 0; i < L.entries.length; i++) {
            var e = L.entries[i];
            if (!e || e.prevHash !== prev) return { ok: false, n: L.entries.length, head: prev, brokenAt: e ? e.seq : i, reason: 'chain broken (previous hash)' };
            if (entryHash(e.prevHash, e) !== e.hash) return { ok: false, n: L.entries.length, head: prev, brokenAt: e.seq, reason: 'entry edited (hash)' };
            if (seq !== null && e.seq !== seq + 1) return { ok: false, n: L.entries.length, head: prev, brokenAt: e.seq, reason: 'sequence gap' };
            seq = e.seq; prev = e.hash;
        }
        return { ok: true, n: L.entries.length, folded: L.summary ? L.summary.n : 0, head: prev, brokenAt: null, reason: null };
    }

    // ─────────────────────────────────────────────────────────────────────
    // 10. Rendering helpers (plain text; the page escapes before innerHTML)
    // ─────────────────────────────────────────────────────────────────────
    function fmtValue(val, fmt) {
        if (!val || val.v === null || val.v === undefined) return '—';
        if (typeof val.v === 'string') return val.v;
        if (!_isNum(val.v)) return '—';
        if (typeof fmt === 'function') {
            var s = fmt(val.v, val.cat || null, val.dp | 0);
            if (s !== null && s !== undefined && String(s).trim() !== '') return String(s).trim();
        }
        return _fixed(val.v, val.dp | 0);
    }
    function fill(template, values, fmt) {
        return _str(template).replace(/\{(\w+)\}/g, function (m, n) { return fmtValue(values ? values[n] : null, fmt); });
    }
    function headText(h, fmt) {
        if (!h) return '';
        var u = (h.cat && fmt && typeof fmt.unit === 'function') ? fmt.unit(h.cat) : '';
        return _str(h.text) + (u ? ' (' + u + ')' : '');
    }
    function blockText(b, fmt) {
        if (!b) return '';
        switch (b.kind) {
            case 'verdict': return fill(b.template, b.values, fmt);
            case 'notes': return _str(b.head) + ': ' + fill(b.template, b.values, fmt);
            case 'kv': return _arr(b.rows).map(function (r) { return r.label + ': ' + (_isValue(r.value) ? fmtValue(r.value, fmt) : fill(r.value && r.value.template, r.value && r.value.values, fmt)); }).join('\n');
            case 'kpi': return _arr(b.items).map(function (it) { return it.label + ': ' + fmtValue(it.value, fmt); }).join('\n');
            case 'table': return [_arr(b.head).map(function (h) { return headText(h, fmt); }).join(' | ')].concat(_arr(b.rows).map(function (r) {
                return _arr(r).map(function (c) { return typeof c === 'string' ? c : fmtValue(c, fmt); }).join(' | ');
            })).join('\n');
            case 'chart': return 'Chart ' + b.id + ': ' + _arr(b.series).map(function (s) { return s.name; }).join(', ');
            default: return '';
        }
    }
    function render(model, fmt) {
        var out = [];
        if (!model) return out;
        out.push(_str(model.title)); out.push(_str(model.subtitle));
        _arr(model.sections).forEach(function (s) {
            out.push(s.id + ' ' + s.title);
            _arr(s.blocks).forEach(function (b) { var t = blockText(b, fmt); if (t) out.push(t); });
        });
        if (model.reproducibility) out.push(blockText(model.reproducibility, fmt));
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 11. Q&A (§7.4)
    // ─────────────────────────────────────────────────────────────────────
    var INPUT_SYN = [
        ['h', /\b(net pay|pay thickness|net thickness|formation thickness|thickness|h)\b/],
        ['phi', /\b(porosity|phi)\b|φ/],
        ['ct', /\b(total compressibility|compressibility|ct)\b/],
        ['rw', /\b(wellbore radius|well radius|rw)\b/],
        ['B', /\b(formation volume factor|volume factor|fvf)\b|\bb\b(?!\s*#?\d)/],
        ['mu', /\b(viscosity|mu)\b|μ/],
        ['q', /\b(flow rate|production rate|allocated rate|allocation|rate|q)\b/]
    ];
    var INPUT_LABEL = { h: 'net pay h', phi: 'porosity φ', ct: 'compressibility ct', rw: 'wellbore radius rw', B: 'formation volume factor B', mu: 'viscosity μ', q: 'rate q' };
    function _matchAll(s, re) {
        var out = [], m;
        if (typeof s.matchAll === 'function') { var it = s.matchAll(re); for (var x = it.next(); !x.done; x = it.next()) out.push(x.value); return out; }
        re.lastIndex = 0;
        while ((m = re.exec(s)) !== null) out.push(m);
        return out;
    }
    function _entities(q, an) {
        var low = String(q).toLowerCase();
        var ids = _matchAll(low, /\b(?:b|test|build-?up)\s*#?(\d+)\b/g).map(function (m) { return 'B' + parseInt(m[1], 10); });
        var pcts = _matchAll(low, /([+-]?\d+(?:\.\d+)?)\s*%/g).map(function (m) { return parseFloat(m[1]); }).filter(_isNum);
        var thr = _matchAll(low, /\b(?:cross(?:es)?|reach(?:es)?|exceed(?:s)?|above)\s+([+-]?\d+(?:\.\d+)?)(?!\s*%)/g).map(function (m) { return parseFloat(m[1]); });
        var input = null;
        var lowNoTests = low.replace(/\b(?:b|test|build-?up)\s*#?\d+\b/g, ' ');
        for (var i = 0; i < INPUT_SYN.length; i++) if (INPUT_SYN[i][1].test(lowNoTests)) { input = INPUT_SYN[i][0]; break; }
        var up = /\b(higher|increase[sd]?|more|larger|bigger|greater|raised|up)\b/.test(low);
        var down = /\b(lower|decrease[sd]?|less|smaller|reduced?|down|drops?)\b/.test(low);
        var models = [];
        if (/\bfault\b/.test(low)) models.push('linearBoundary');
        if (/\bcomposite\b/.test(low)) models.push('composite2');
        if (/\bclosed\b|\bcircle\b/.test(low)) models.push('closedCircle');
        var norm = low.replace(/[^a-z0-9%*_.\s-]/g, ' ').replace(/\s+/g, ' ').trim();
        var tests = _uniq(ids);
        var exists = tests.filter(function (id) { return _arr(an && an.tests).some(function (t) { return t && t.id === id; }); });
        return { low: low, norm: norm, tests: tests, existing: exists, pcts: pcts, thr: thr, input: input, up: up, down: down, models: models };
    }
    function I(id, example, pats, build, extra) { return { id: id, example: example, patterns: pats, build: build, bonus: extra || null }; }
    function _score(intent, e) {
        var s = 0, t = e.norm;
        intent.patterns.forEach(function (p) { if (p[0].test(t)) s += p[1]; });
        if (intent.bonus) s += intent.bonus(e);
        return s;
    }
    // test for an answer: the first existing named test, else the latest used/interpreted test
    function _qTest(c, e) {
        if (e.existing.length) return c.test(e.existing[0]);
        var i = _latestIdx(c.an);
        return i >= 0 ? c.an.tests[i] : null;
    }
    function _ans(template, values, ev, grounded, followUps) { return { template: template, values: values || {}, ev: ev, grounded: grounded || 'full', followUps: followUps || [] }; }
    function _noTest(c, e) {
        var name = e.tests[0];
        return _ans('There is no test {name} in this analysis; the tests are {list}.',
                    { name: { v: name, cat: null, dp: 0, ref: 'D1:asked', calc: { f: 'lit', args: { x: { lit: name } } } }, list: c.V('D1', 'testList') }, ['D1'], 'partial', ['What is k for ' + (c.tests[0] ? c.tests[0].id : 'B1') + '?']);
    }
    var MODEL_NAME = { homogeneous: 'homogeneous model', linearBoundary: 'sealing fault', composite2: 'radial composite', closedCircle: 'closed circle' };
    var INTENTS = [
        I('why_model', 'why this model?', [[/\bwhy\b.*\bmodels?\b|\bmodels?\b.*\bwhy\b/, 4], [/\bwhy not\b/, 2], [/\b(fault|composite|closed|circle|boundary|rival|homogeneous)\b/, 2],
            [/\bmodels?\b/, 2], [/\b(chosen|choose|chose|choice|selected|select|picked|fits)\b/, 1], [/\bbic\b/, 3], [/\bexplain\b/, 1]], function (c, e) {
            if (e.tests.length && !e.existing.length) return _noTest(c, e);
            var t = _qTest(c, e); if (!t || !t.result) return _ans('No interpreted test is available.', {}, ['D1'], 'partial');
            var r = t.result, id = t.id, vals = { test: c.V(id + '·A2', 'test'), model: c.V(id + '·M6', 'label'), seen: c.V(id + '·M5', 'status') };
            var tpl = '{test}: {model} chosen. ';
            var fired = _arr(r.triggers && r.triggers.fired);
            if (fired.length) { tpl += 'Triggers fired: {trig}. '; vals.trig = c.V(id + '·M2', 'fired'); }
            else tpl += 'No trigger fired, so no rival was needed. ';
            var rows = _arr(r.bic && r.bic.rows), best = -1;
            rows.forEach(function (row, j) { if (row && row.key !== 'homogeneous' && _isNum(row.bic) && (best < 0 || row.bic < rows[best].bic)) best = j; });
            if (best >= 0) { tpl += 'Best rival {rk}: ΔBIC {db} against homogeneous (a rival must exceed τ = {tau}). '; vals.rk = c.V(id + '·M4', 'r' + best + '_key'); vals.db = c.V(id + '·M4', 'r' + best + '_gain'); vals.tau = c.V(id + '·M4', 'tau'); }
            tpl += 'Fully seen: {seen}.';
            e.models.forEach(function (mk) {
                if (mk === r.chosen.key) return;
                var j = -1; rows.forEach(function (row, k) { if (row && row.key === mk) j = k; });
                if (j >= 0) { tpl += ' The ' + MODEL_NAME[mk] + ' was fitted: ΔBIC {g' + j + '} against homogeneous, eligible {e' + j + '}.'; vals['g' + j] = c.V(id + '·M4', 'r' + j + '_gain'); vals['e' + j] = c.V(id + '·M4', 'r' + j + '_eligible'); }
                else tpl += ' The ' + MODEL_NAME[mk] + ' was not fitted: its trigger did not fire.';
            });
            return _ans(tpl, vals, [id + '·M2', id + '·M3', id + '·M4', id + '·M5', id + '·M6'], 'full', ['Why is the confidence ' + (r.confidence ? r.confidence.headline : 'medium') + ' for ' + id + '?']);
        }),
        I('why_conf', 'why is confidence medium?', [[/\bconfiden/, 4], [/\blabel/, 3], [/\b(reliable|reliability|trust|trustworthy|believe)\b/, 4], [/\b(high|medium|low)\b/, 1]], function (c, e) {
            if (e.tests.length && !e.existing.length) return _noTest(c, e);
            var t = _qTest(c, e); if (!t || !t.result) return _ans('No interpreted test is available.', {}, ['D1'], 'partial');
            var r = t.result, id = t.id;
            var tpl = '{test}: confidence {ks} for k and S and {hl} for the test. Rules: {rules}.';
            var reasons = _arr(r.confidence && r.confidence.reasons);
            var main = reasons.filter(function (x) { return x && (x.kind === 'low' || x.kind === 'cap'); })[0] || reasons[0];
            if (main && K_TEXT[main.rule]) tpl += ' Main reason, ' + main.rule + ': ' + K_TEXT[main.rule];
            var ev = [id + '·K1', id + '·K2'];
            reasons.forEach(function (x) { _arr(x && x.ev).forEach(function (rel) { ev.push(id + '·' + rel); }); });
            return _ans(tpl, { test: c.V(id + '·A2', 'test'), ks: c.V(id + '·K1', 'ks'), hl: c.V(id + '·K2', 'headline'), rules: c.V(id + '·K1', 'rules') },
                        ev.filter(function (x) { return c.idx.items[x]; }), 'full', ['Why is the skin uncertainty large for ' + id + '?']);
        }),
        I('whatif_input', 'what if h is 20 % higher?', [[/\bwhat if\b|\bsuppose\b|\bwhat happens if\b|\bassume\b|\bif (the |our )?[a-zφμ ]{1,30}\b(is|were|was|are)\b/, 3]], function (c, e) {
            if (!e.input) return _ans('Name the input (h, φ, ct, rw, B, μ or q) and a percentage, for example: what if h is higher?', {}, ['U2'], 'partial', ['What if h is 20 % higher?']);
            var p = e.pcts.length ? MATH.abs(e.pcts[0]) : (e.input === 'q' ? 10 : 20);
            var sign = (e.pcts.length && e.pcts[0] < 0) ? -1 : (e.down && !e.up) ? -1 : 1;
            var f = 1 + sign * p / 100;
            if (!(f > 0)) return _ans('That change would make the input zero or negative.', {}, ['U2'], 'partial');
            var dk = FORMULAS.sensDkPct(e.input, f), dS = FORMULAS.sensDS(e.input, f);
            var lit = function (x) { return { lit: x }; };
            var L = _qTest(c, e), vals = {
                pct: { v: p, cat: null, dp: p % 1 ? 1 : 0, ref: 'U2:asked', calc: { f: 'lit', args: { x: lit(p) } } },
                dk: { v: dk, cat: null, dp: 1, ref: 'U2:sensDkPct', calc: { f: 'sensDkPct', args: { input: lit(e.input), f: lit(f) } } },
                ds: { v: dS, cat: null, dp: 3, ref: 'U2:sensDS', calc: { f: 'sensDS', args: { input: lit(e.input), f: lit(f) } } }
            };
            var tpl = 'If ' + INPUT_LABEL[e.input] + ' is {pct} % ' + (sign > 0 ? 'higher' : 'lower') + ', k changes by {dk} % and S by {ds} on every test (analytic, homogeneous).';
            var ev = ['U2'];
            // every used test (the latest 8 named), with its shifted skin
            var used = c.tests.filter(function (t) { return t.used && t.used.trend && t.result && t.result.final && _isNum(t.result.final.S); });
            if (!used.length) used = c.tests.filter(function (t) { return t.result && t.result.final && _isNum(t.result.final.S); });
            var shown = used.slice(-8);
            if (shown.length) {
                tpl += ' Shifted skin of the ' + (used[0].used && used[0].used.trend ? 'used' : 'interpreted') + ' tests: ' + shown.map(function (t, j) { return '{t' + j + '} {u' + j + '}'; }).join(', ');
                shown.forEach(function (t, j) {
                    var tj = c.an.tests.indexOf(t);
                    vals['t' + j] = c.V(t.id + '·A2', 'test');
                    vals['u' + j] = { v: FORMULAS.add(t.result.final.S, dS), cat: null, dp: 2, ref: t.id + '·U2:S', calc: { f: 'add', args: { a: 'tests[' + tj + '].result.final.S', b: lit(dS) } } };
                    ev.push(t.id + '·A2');
                });
                if (used.length > shown.length) { tpl += ' (and {nOld} earlier tests)'; vals.nOld = { v: used.length - shown.length, cat: null, dp: 0, ref: 'U2:older', calc: { f: 'lit', args: { x: lit(used.length - shown.length) } } }; }
                tpl += '.';
            }
            if (L && L.result && L.result.final) {
                var li = c.an.tests.indexOf(L);
                tpl += ' For {test}: k {k1}, S {s1}.';
                vals.test = c.V(L.id + '·A2', 'test');
                vals.k1 = { v: FORMULAS.sensK(e.input, f, L.result.final.k), cat: 'permeability', dp: _sfDp(L.result.final.k, 3), ref: L.id + '·U2:k',
                            calc: { f: 'sensK', args: { input: lit(e.input), f: lit(f), k: 'tests[' + li + '].result.final.k' } } };
                vals.s1 = { v: FORMULAS.add(L.result.final.S, dS), cat: null, dp: 2, ref: L.id + '·U2:S', calc: { f: 'add', args: { a: 'tests[' + li + '].result.final.S', b: lit(dS) } } };
                ev.push(L.id + '·U2', L.id + '·A2');
            }
            if (c.an.trend && c.an.trend.alerts) {
                tpl += ' The delta alert is unchanged because a uniform input error shifts every skin equally; ';
                var a = _alertRecompute(c.an, 'absolute', dS);
                if (a && !a.ambiguous) {
                    tpl += 'the absolute alert would be {abs} (at {at}).';
                    vals.abs = { v: a.status, cat: null, dp: 0, ref: 'T3:shifted', calc: { f: 'alertShift', args: { an: '$analysis', which: lit('absolute'), shift: lit(dS) } } };
                    vals.at = { v: a.confirmedAt || a.raisedAt || 'none', cat: null, dp: 0, ref: 'T3:shiftedAt', calc: { f: 'alertShiftAt', args: { an: '$analysis', which: lit('absolute'), shift: lit(dS) } } };
                } else tpl += 'the effect on the absolute alert cannot be re-derived from the stored series; press Analyse with the changed input.';
                ev.push('T2', 'T3');
            }
            return _ans(tpl, vals, ev.filter(function (x) { return c.idx.items[x]; }), 'full', ['What if ' + e.input + ' is ' + p + ' % ' + (sign > 0 ? 'lower' : 'higher') + '?', 'Is there an alert?']);
        }, function (e) { return (e.input ? 2 : 0) + (e.pcts.length ? 2 : 0) + ((e.up || e.down) && e.input ? 1 : 0); }),
        I('onset', 'when did skin start rising?', [[/\bonset\b/, 5], [/\bwhen did\b|\bsince when\b/, 4], [/\b(start|started|starting|begin|began|beginning)\b/, 2],
            [/\b(rising|rise|increase|increasing|going up|rose)\b/, 1]], function (c) {
            var o = c.an.trend && c.an.trend.onset;
            if (!o || !_isNum(o.tauDays)) return _ans('No onset of a skin rise was found ({model} model).', { model: c.V('T4', 'model') }, ['T4'], o ? 'full' : 'partial');
            var tpl = 'Skin started rising about day {tau} after the first test ({date}); interval days {lo} to {hi}; {model} model' + (o.indicative ? ' (indicative: few tests)' : '') + '.';
            var vals = { tau: c.V('T4', 'tauDays'), date: c.V('T4', 'date'), lo: c.V('T4', 'lo'), hi: c.V('T4', 'hi'), model: c.V('T4', 'model') };
            if (o.cusum && o.cusum.alarmAt) { tpl += ' CUSUM: alarm at {al}, onset at {on}.'; vals.al = c.V('T4', 'alarmAt'); vals.on = c.V('T4', 'onsetAt'); }
            return _ans(tpl, vals, ['T4', 'T1'], 'full', ['When will skin cross the absolute threshold?']);
        }),
        I('alert', 'is there an alert?', [[/\balert|\balarm/, 4], [/\bthreshold\b/, 1], [/\b(exceeded|raised|triggered|active)\b/, 1], [/\b(absolute|delta)\b/, 2]], function (c) {
            var A = c.an.trend && c.an.trend.alerts;
            if (!A) return _ans('No trend is available, so no alert is evaluated.', {}, ['T2'], 'partial');
            var tpl = 'Delta alert: {ds}', vals = { ds: c.V('T2', 'status'), as: c.V('T3', 'status'), basis: c.V('T3', 'basisText') };
            if (A.delta && A.delta.raisedAt) { tpl += ', raised at {dr}'; vals.dr = c.V('T2', 'raisedAt'); if (A.delta.confirmedAt) { tpl += ', confirmed at {dc}'; vals.dc = c.V('T2', 'confirmedAt'); } }
            tpl += '. Absolute alert on {basis}: {as}';
            if (A.absolute && A.absolute.raisedAt) { tpl += ', raised at {ar}'; vals.ar = c.V('T3', 'raisedAt'); if (A.absolute.confirmedAt) { tpl += ', confirmed at {ac}'; vals.ac = c.V('T3', 'confirmedAt'); } }
            tpl += '.';
            var low = c.an.trend.excludedLow;
            if (low && low.n > 0) { tpl += ' {nl} tests were excluded as low (S {ll} to {lh}).'; vals.nl = c.V('T16', 'n'); vals.ll = c.V('T16', 'Slo'); vals.lh = c.V('T16', 'Shi'); }
            else tpl += ' No test was excluded as low.';
            if (A.delta && A.delta.kHeldOnly) tpl += ' Every test behind the delta alert is k-held.';
            return _ans(tpl, vals, ['T2', 'T3', 'T16'], 'full', ['When did skin start rising?', 'How much production is at stake?']);
        }),
        I('value', 'what is k for B3?', [[/\bwhat is\b|\bwhat s\b|\bwhats\b|\bgive me\b|\bshow\b|\bvalues?\b|\btell me\b/, 1], [/\b(k|permeability|skin|storage|c|pstar|kh|results?|numbers)\b|(^|\s)p\*/, 2]], function (c, e) {
            if (e.tests.length && !e.existing.length) return _noTest(c, e);
            var t = _qTest(c, e); if (!t || !t.result) return _ans('No interpreted test is available.', {}, ['D1'], 'partial');
            var id = t.id;
            return _ans('{test}: k = {k}, S = {s} ± {e}, C = {c}, p* = {ps}, p_ext = {pe} (from the {src}).',
                        { test: c.V(id + '·A2', 'test'), k: c.V(id + '·A2', 'k'), s: c.V(id + '·A2', 'S'), e: c.V(id + '·U1', 'value'), c: c.V(id + '·A2', 'C'),
                          ps: c.V(id + '·A2', 'pStar'), pe: c.V(id + '·A2', 'pExt'), src: c.V(id + '·A2', 'source') },
                        [id + '·A2', id + '·U1'], 'full', ['Why is the confidence ' + (t.result.confidence ? t.result.confidence.headline : 'medium') + ' for ' + id + '?']);
        }, function (e) { return e.tests.length === 1 ? 2 : 0; }),
        I('compare', 'compare B2 and B5', [[/\bcompar/, 4]], function (c, e) {
            var ids = e.existing.slice(0, 2);
            var missing = e.tests.filter(function (x) { return e.existing.indexOf(x) === -1; });
            if (missing.length) return _noTest(c, { tests: missing });
            var withRes = c.tests.filter(function (t) { return t.result; });
            if (ids.length < 2) {
                var L = _qTest(c, { existing: [] });
                var first = withRes.length ? withRes[0].id : null;
                if (ids.length === 1) ids.push(L && L.id !== ids[0] ? L.id : first);
                else ids = [first, L ? L.id : null];
            }
            var a = c.test(ids[0]), b = c.test(ids[1]);
            if (!a || !b || !a.result || !b.result || a === b) return _ans('Name two interpreted tests to compare, for example: compare two tests.', {}, ['D1'], 'partial');
            var vals = { a: c.V(a.id + '·A2', 'test'), b: c.V(b.id + '·A2', 'test'), ka: c.V(a.id + '·A2', 'k'), kb: c.V(b.id + '·A2', 'k'), sa: c.V(a.id + '·A2', 'S'), sb: c.V(b.id + '·A2', 'S'),
                         ea: c.V(a.id + '·U1', 'value'), eb: c.V(b.id + '·U1', 'value') };
            var ia = c.an.tests.indexOf(a), ib = c.an.tests.indexOf(b);
            vals.ds = { v: FORMULAS.sub(b.result.final.S, a.result.final.S), cat: null, dp: 2, ref: 'T11:cmp', calc: { f: 'sub', args: { a: 'tests[' + ib + '].result.final.S', b: 'tests[' + ia + '].result.final.S' } } };
            var tpl = '{a}: k {ka}, S {sa} ± {ea}. {b}: k {kb}, S {sb} ± {eb}. Fitted skin change {ds}';
            var mf = _arr(c.an.trend && c.an.trend.modelFree), ra = null, rb = null, ja = -1, jb = -1;
            mf.forEach(function (row, j) { if (row && row.id === a.id) { ra = row; ja = j; } if (row && row.id === b.id) { rb = row; jb = j; } });
            if (rb && rb.refId === a.id) { tpl += '; model-free {mf}'; vals.mf = c.V('T11', b.id + '_dS'); }
            else if (ra && ra.refId === b.id) { tpl += '; model-free {mf}'; vals.mf = { v: -ra.dS, cat: null, dp: 2, ref: 'T11:cmpMf', calc: { f: 'neg', args: { a: 'trend.modelFree[' + ja + '].dS' } } }; }
            else if (ra && rb && ra.refId === rb.refId) { tpl += '; model-free {mf}'; vals.mf = { v: rb.dS - ra.dS, cat: null, dp: 2, ref: 'T11:cmpMf', calc: { f: 'sub', args: { a: 'trend.modelFree[' + jb + '].dS', b: 'trend.modelFree[' + ja + '].dS' } } }; }
            tpl += '.';
            return _ans(tpl, vals, [a.id + '·A2', b.id + '·A2', a.id + '·U1', b.id + '·U1', 'T11'], 'full', ['Why do line and match disagree for ' + b.id + '?']);
        }, function (e) { return e.tests.length >= 2 ? 3 + (/\b(versus|vs|differ|difference|different|changed|between|against)\b/.test(e.norm) ? 1 : 0) : 0; }),
        I('excluded', 'why was B4 excluded?', [[/\bexclu/, 5], [/\b(left out|not used|omitted|dropped|ignored|discarded|rejected)\b/, 4]], function (c, e) {
            if (e.tests.length && !e.existing.length) return _noTest(c, e);
            if (e.existing.length) {
                var t = c.test(e.existing[0]), id = t.id, vals = { test: c.V(id + '·A2', 'test') };
                var tpl;
                if (t.status !== 'interpreted') {
                    vals.st = c.V(id + '·A2', 'status');
                    tpl = '{test} is {st}';
                    if (t.statusReason) { tpl += ': {why}'; vals.why = c.V(id + '·A2', 'statusReason'); }
                    var ov = _arr(t.overrides)[0];
                    if (ov && c.idx.items[ov]) { tpl += ' (override {ov}, {kind})'; vals.ov = c.V(ov, 'id'); vals.kind = c.V(ov, 'kind'); }
                    tpl += '.';
                    return _ans(tpl, vals, [id + '·A2'].concat(ov && c.idx.items[ov] ? [ov] : []), 'full', ['Is there an alert?']);
                }
                var u = t.used || {};
                tpl = '{test} is interpreted and ' + (u.trend ? 'used for the trend' + (u.alert ? ' and the alerts' : '') : 'not used for the trend: its k/S label is {ks}') + '.';
                if (!u.trend) vals.ks = c.V(id + '·K1', 'ks');
                return _ans(tpl, vals, [id + '·A2', id + '·K1'], 'full', ['Why is confidence ' + (t.result && t.result.confidence ? t.result.confidence.ks : 'low') + ' for ' + id + '?']);
            }
            return _ans('Tests not interpreted: {ex}. Tests excluded as low from the trend: {low}.', { ex: c.V('D1', 'excludedList'), low: c.V('T16', 'ids') }, ['D1', 'T16'], 'full');
        }),
        I('shutin_length', 'how long should the shut-in be?', [[/\bhow long\b/, 4], [/\b(duration|how many hours|longer)\b/, 3], [/\bshut ?-?ins?\b|\bshut in\b|\bbuild ?-?ups?\b/, 1],
            [/\b(should|need|needed|needs|recommend|recommended)\b/, 1]], function (c, e) {
            if (e.tests.length && !e.existing.length) return _noTest(c, e);
            if (e.existing.length) {
                var t = c.test(e.existing[0]), id = t.id;
                if (!t.result) return _ans('{test} has no interpretation.', { test: c.V(id + '·A2', 'test') }, [id + '·A2'], 'partial');
                var rc = t.result.reach;
                if (!rc || !_isNum(rc.fairShut_h)) return _ans('{test}: a fair IARF cannot be reached with this producing time (reach {f} h in equivalent time).', { test: c.V(id + '·A2', 'test'), f: c.V(id + '·W4', 'fair_h') }, [id + '·W4'], 'full');
                return _ans('{test}: a fair IARF needs about {f} h of shut-in and a good one about {g} h; this test lasted {dt} h.',
                            { test: c.V(id + '·A2', 'test'), f: c.V(id + '·W4', 'fairShut_h'), g: c.V(id + '·W4', 'goodShut_h'), dt: c.V(id + '·D5', 'dtEnd_h') }, [id + '·W4', id + '·D5'], 'full');
            }
            return _ans('A fair IARF needs about {f} h of shut-in and a good IARF about {g} h (median over {n} tests; numeric reach of the fitted model).',
                        { f: c.V('W4', 'fairShutMedian'), g: c.V('W4', 'goodShutMedian'), n: c.V('W4', 'n') }, ['W4'], 'full', ['Could we have missed shut-ins?']);
        }),
        I('stake', 'how much production is at stake?', [[/\bat stake\b|\bstake\b/, 5], [/\b(losing|loss|lost|deferred|recover|recovered)\b/, 3], [/\b(production|barrels|oil|bpd)\b/, 1],
            [/\bhow much\b|\bhow many\b/, 1]], function (c) {
            var pi = c.an.trend && c.an.trend.pi;
            if (!pi) return _ans('No trend is available, so production at stake is not computed.', {}, ['T8'], 'partial');
            if (pi.guard === true) return _ans('Production at stake is not computable: strongly negative skin (X + S below one).', {}, ['T8'], 'full');
            var tpl = 'Pseudo-steady-state estimate: rate at stake {rate} at constant drawdown, or {dd} of extra drawdown at constant rate; cumulative since the onset {cum}. PI ratio {now} now against {base} at the baseline' + (pi.ratioLowerBound ? ' (lower bound)' : '') + '.';
            var vals = { rate: c.V('T8', 'rateAtStake'), dd: c.V('T8', 'extraDrawdown_psi'), cum: c.V('T8', 'cumAtStake'), now: c.V('T8', 'ratioNow'), base: c.V('T8', 'ratioBase') };
            if (pi.atStakeUpperBound) tpl += ' The rate and cumulative are upper bounds (r_e assumed from r_inv).';
            if (_isNum(pi.value)) { tpl += ' Value {val} at the entered price per unit volume.'; vals.val = c.V('T8', 'value'); }
            return _ans(tpl, vals, ['T8'], 'full', ['Is k stable?']);
        }),
        I('kstable', 'is k stable?', [[/\b(k|permeability)\b.*\b(stable|stability|constant|changing|change|changes|drift|drifting|vary|varies|varying)\b/, 5],
            [/\b(stable|stability|constant|changing|drift|drifting|vary|varies)\b.*\b(k|permeability)\b/, 5], [/\b(stable|stability)\b/, 1]], function (c) {
            var ks = c.an.trend && c.an.trend.kStability;
            if (!ks) return _ans('No trend is available, so k stability is not evaluated.', {}, ['T9'], 'partial');
            var READ = { nearWell: 'the skin change is near the well (damage or a pseudo-skin change), not in the formation.',
                         mobility: 'k falls while skin rises: a mobility change (water cut, gas), a model switch or a rate-basis problem.',
                         allocation: 'k drifts with the rate allocation: allocation drift (skin changes only slightly).', none: 'no change in k or skin.' };
            return _ans('k varies by {cv} % between tests (limit {lim} %): ' + (ks.stable ? 'stable' : 'not stable') + '. Reading: ' + (READ[ks.reading] || READ.none),
                        { cv: c.V('T9', 'cvPct'), lim: c.V('T9', 'cvLimPct') }, ['T9'], 'full', ['Is there an alert?']);
        }),
        I('serr', 'why is the skin uncertainty large?', [[/\buncertain/, 5], [/\b(error|errors|s_err|serr|s err|accuracy|accurate|precise|precision|confidence interval)\b/, 5], [/\b(large|big|wide|high)\b/, 1]], function (c, e) {
            if (e.tests.length && !e.existing.length) return _noTest(c, e);
            var t = _qTest(c, e); if (!t || !t.result || !t.result.sErr) return _ans('No interpreted test is available.', {}, ['D1'], 'partial');
            var id = t.id, D = { floor: 'the floor', se: 'the fit standard error', lineMatch: 'the line–match difference', window: 'the window shift', tc: 'the closing-time', pwf: 'the pwf0', kHeld: 'the held-k' };
            return _ans('{test}: S_err = {v} ({mode} mode), driven by ' + (D[t.result.sErr.driver] || 'the largest') + ' term. Terms: floor {fl}, fit {se}, line–match {lm}, window {w}, closing time {tc}, pwf0 {pw}, held k {sk}. C-held range ±{sc}; input sensitivity {ss}.',
                        { test: c.V(id + '·A2', 'test'), v: c.V(id + '·U1', 'value'), mode: c.V(id + '·U1', 'mode'), fl: c.V(id + '·U1', 'floor'), se: c.V(id + '·U1', 'seS'),
                          lm: c.V(id + '·U1', 'dLineMatch'), w: c.V(id + '·U1', 'sWin'), tc: c.V(id + '·U1', 'sTc'), pw: c.V(id + '·U1', 'sPwf'), sk: c.V(id + '·U1', 'sK'),
                          sc: c.V(id + '·U1', 'S_C'), ss: c.V(id + '·U1', 'sSens') }, [id + '·U1'], 'full', ['What if h is 20 % higher?']);
        }),
        I('line_vs_match', 'why do line and match disagree for B6?', [[/\b(line|semilog|straight)\b.*\b(match|matched|type ?-?curve)\b|\b(match|matched)\b.*\b(line|semilog)\b/, 6],
            [/\b(disagree|agree|agreement)\b/, 2]], function (c, e) {
            if (e.tests.length && !e.existing.length) return _noTest(c, e);
            var t = _qTest(c, e); if (!t || !t.result) return _ans('No interpreted test is available.', {}, ['D1'], 'partial');
            var r = t.result, id = t.id;
            if (!r.line) return _ans('{test}: there is no semilog line (no IARF window), so line and match cannot be compared.', { test: c.V(id + '·A2', 'test') }, [id + '·A1', id + '·I1'], 'full');
            var ag = r.agreement || {};
            var tpl = '{test}: line k {kl}, S {sl}; match k {km}, S {sm}; difference {dk} % in k and {ds} in S. ';
            var vals = { test: c.V(id + '·A2', 'test'), kl: c.V(id + '·L1', 'k'), sl: c.V(id + '·L1', 'S'), km: c.V(id + '·M1', 'k'), sm: c.V(id + '·M1', 'S'), dk: c.V(id + '·A1', 'dkPct'), ds: c.V(id + '·A1', 'dS') };
            if (ag.agree && ag.mode === 'bias') { tpl += 'The difference equals the predicted bias of the window (k {bk} %, S {bs}), so they agree.'; vals.bk = c.V(id + '·A1', 'biasKPct'); vals.bs = c.V(id + '·A1', 'biasDS'); }
            else if (ag.agree) tpl += 'They agree within the limits.';
            else tpl += 'They disagree beyond the explained bias; the final values come from the line.';
            return _ans(tpl, vals, [id + '·A1', id + '·L1', id + '·M1'], 'full', ['Why is the skin uncertainty large for ' + id + '?']);
        }),
        I('bubble', 'is pwf below the bubble point?', [[/\bbubble\b/, 5], [/\bpb\b|\bsaturation pressure\b|out of solution|\bbelow saturation\b/, 5], [/\bpwf\b|\bflowing pressure\b/, 1]], function (c, e) {
            if (c.fluid !== 'oil') return _ans('The bubble-point check applies to oil producers only.', {}, ['T12'], 'full');
            if (!_isNum(c.an.well && c.an.well.Pb)) return _ans('The bubble point is not entered, so the check is off.', {}, ['T12', 'U2'], 'partial');
            var rows = _arr(c.an.trend && c.an.trend.bubble && c.an.trend.bubble.rows);
            if (!rows.length) return _ans('No test was checked against the bubble point ({pb}).', { pb: c.V('T12', 'pb') }, ['T12'], 'partial');
            var row = null;
            if (e.existing.length) row = rows.filter(function (x) { return x && x.id === e.existing[0]; })[0] || null;
            if (!row) rows.forEach(function (x) { if (x && _isNum(x.margin) && (!row || x.margin < row.margin)) row = x; });
            if (!row) row = rows[0];
            return _ans('{test}: sandface flowing pressure at closing {lo} to {hi} against Pb {pb} (level {lvl}); {nb} of {n} tests are below Pb.',
                        { test: c.V(row.id + '·A2', 'test'),
                          lo: c.V('T12', row.id + '_lo'), hi: c.V('T12', row.id + '_hi'), pb: c.V('T12', 'pb'), lvl: c.V('T12', row.id + '_level'), nb: c.V('T12', 'nBelow'), n: c.V('T12', 'n') },
                        ['T12'], 'full', ['Is the reservoir depleting?']);
        }),
        I('forecast', 'when will skin cross 5?', [[/\bforecast|\bpredict/, 5], [/\bwhen will\b/, 4], [/\b(cross|crosses|crossing|reach|reaches|exceed|exceeds)\b/, 2], [/\bfuture\b|\bnext\b/, 1]], function (c, e) {
            var fc = c.an.trend && c.an.trend.forecast;
            if (!fc) return _ans('No trend is available, so there is no forecast.', {}, ['T6'], 'partial');
            var tpl, vals = { thr: c.V('T3', 'threshold') };
            if (fc.show) { tpl = 'Skin is forecast to cross the absolute threshold ({thr}) about {d} (earliest {e}, latest {l}).'; vals.d = c.V('T6', 'date'); vals.e = c.V('T6', 'earliest'); vals.l = c.V('T6', 'latest'); }
            else { tpl = 'No forecast: {why}'; vals.why = c.V('T6', 'reason'); delete vals.thr; }
            var thrNow = c.an.trend.alerts && c.an.trend.alerts.absolute ? c.an.trend.alerts.absolute.threshold : null;
            if (e.thr.length && _isNum(thrNow) && MATH.abs(e.thr[0] - thrNow) > 1e-9) { tpl += ' The forecast uses the configured threshold {thr}.'; vals.thr = c.V('T3', 'threshold'); }
            return _ans(tpl, vals, ['T6', 'T3', 'T5'], 'full', ['When did skin start rising?']);
        }),
        I('mech', 'what is the mechanical skin?', [[/\bmechanical\b/, 5], [/\bpseudo ?-?skins?\b|\bgeometric\b|\bpartial penetration\b|\bdeviation skin\b|\bdecompos|\bsplit\b/, 4], [/\bdamage\b/, 3]], function (c, e) {
            var me = c.an.trend && c.an.trend.mech;
            if (!me || me.available !== true) return _ans('Mechanical skin is not available: no completion data, so the alerts use total skin, which may include geometric pseudo-skin.', {}, ['T14'], 'full');
            var t = _qTest(c, e); var id = t ? t.id : null;
            return _ans('{test}: mechanical skin {sm} ± {se} (pressure-drop basis); geometric pseudo-skin {sg} (range {lo} to {hi}); local damage skin {sd}.',
                        { test: id ? c.V(id + '·A2', 'test') : c.V('T14', 'basis'), sm: c.V('T14', id + '_Smech'), se: c.V('T14', id + '_SmechErr'), sg: c.V('T14', 'Sgeo'), lo: c.V('T14', 'SgeoLo'),
                          hi: c.V('T14', 'SgeoHi'), sd: c.V('T14', id + '_Sd') }, ['T14'], 'full');
        }, function (e) { return (e.tests.length && /\b(mechanical|pseudo ?-?skins?|damage)\b/.test(e.norm)) ? 2 : 0; }),   // offsets value's test-id bonus
        I('depletion', 'is the reservoir depleting?', [[/\bdeplet/, 5], [/\breservoir pressure\b/, 4], [/\b(pstar|extrapolated pressure|average pressure)\b|(^|\s)p\*/, 2], [/\b(falling|declining|decline|dropping|trend)\b/, 1],
            [/\btrend\b.*(p\*|pstar|pressure)|(p\*|pstar|pressure).*\btrend\b/, 3]], function (c) {
            var pt = c.an.trend && c.an.trend.pTrend;
            if (!pt) return _ans('No trend is available, so depletion is not evaluated.', {}, ['T10'], 'partial');
            if (pt.assessable !== true) return _ans('Depletion cannot be assessed: {why}', { why: c.V('T10', 'reason') }, ['T10'], 'full');
            return _ans((pt.quantity === 'pbar' ? 'Average reservoir pressure' : 'Extrapolated pressure p*') + ' changes by {slope} per 30 days (scatter {sc}); depletion: {dep}. {label}', { slope: c.V('T10', 'slopePer30d'), sc: c.V('T10', 'scatter'),
                        dep: c.V('T10', 'depletion'), label: c.V('T10', 'label') }, ['T10'], 'full', ['Is pwf below the bubble point?']);
        }),
        I('missed', 'could we have missed shut-ins?', [[/\bmiss(ed|ing)?\b/, 4], [/\bnot detected\b|\bundetected\b|\btoo short\b/, 4], [/\bdetect/, 1], [/\bshut ?-?ins?\b|\bevents?\b/, 1]], function (c) {
            var m = c.an.missed;
            if (!m) return _ans('No detection result is available.', {}, ['D1'], 'partial');
            var tpl = 'Detection found {ne} events ({nt} build-up tests); too short: {ns}; suspected interventions: {ni}. Sub-threshold steps ({nsub}), allocation-only days ({nal}) and gaps ({ng}) could hide shut-ins. ';
            tpl += (m.detectability && m.detectability.ok === false) ? 'Full shut-ins may be missed: p* − pwf ({d}) is less than twice the rise threshold ({ts}).' : 'Full shut-ins are detectable (p* − pwf {d} against the rise threshold {ts}).';
            return _ans(tpl, { ne: c.V('D1', 'nEvents'), nt: c.V('D1', 'nTests'), ns: c.V('D1', 'nTooShort'), ni: c.V('D1', 'nInterventions'), nsub: c.V('D1', 'nSub'), nal: c.V('D1', 'nAllocOnly'),
                               ng: c.V('D1', 'nGaps'), d: c.V('D1', 'pStarMinusPwf_psi'), ts: c.V('D1', 'Ts_psi') }, ['D1'], 'full', ['How long should the shut-in be?']);
        }),
        I('help', 'anything else', [], function () {
            return _ans('I answer questions about this analysis, for example: why this model?; why is confidence medium?; what if h is higher?; when did skin start rising?; is there an alert?; ' +
                        'what is k for a test?; compare two tests; why was a test excluded?; how long should the shut-in be?; how much production is at stake?; is k stable?; ' +
                        'why is the skin uncertainty large?; why do line and match disagree?; is pwf below the bubble point?; when will skin cross the threshold?; ' +
                        'what is the mechanical skin?; is the reservoir depleting?; could we have missed shut-ins?', {}, ['D1'], 'none',
                        ['Is there an alert?', 'What is k for the latest test?', 'Why this model?']);
        })
    ];
    var INTENT_MIN = 3;
    function ask(text, analysis, idx, fmt, opts) {
        var q = _str(text).slice(0, 300);
        var an = _obj(analysis) ? analysis : {};
        idx = idx || _evidenceFor(an, opts);
        var roots = _roots(an, opts);
        var c = _ctxFor(an, idx, roots);
        var e = _entities(q, an);
        var best = null, bestScore = 0;
        INTENTS.forEach(function (it) {
            if (it.id === 'help') return;
            var s = _score(it, e);
            if (s > bestScore) { best = it; bestScore = s; }
        });
        if (!best || bestScore < INTENT_MIN) best = INTENTS[INTENTS.length - 1];
        var b;
        try { b = best.build(c, e); }
        catch (err) { b = _ans('This question could not be answered from the analysis.', {}, ['D1'], 'partial'); }
        var ev = _uniq(_arr(b.ev)).filter(function (x) { return idx.items[x]; });
        var ans = { q: q, intent: best.id, template: b.template, values: b.values || {}, ev: ev.length ? ev : ['D1'], grounded: b.grounded || 'full',
                    check: { ok: true, failures: [] }, followUps: _arr(b.followUps).map(function (s) { return _clip(s, 299); }) };
        var chk = check({ values: ans.values }, an, idx, opts);
        ans.check = { ok: chk.ok, failures: chk.failures };
        if (!chk.ok) {
            ans.withheld = true;
            ans.template = 'This answer failed its evidence check; the numbers are withheld.';
            ans.values = {};
            ans.grounded = 'partial';
        }
        return ans;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 12. Report model (§8.2)
    // ─────────────────────────────────────────────────────────────────────
    function _kv(rows) { return { kind: 'kv', rows: rows.filter(Boolean) }; }
    function _row(label, value, ev) { return { label: label, value: value, ev: ev }; }
    function _tv(template, values) { return { template: template, values: values || {} }; }
    function _verdict(level, template, values, ev) { return { kind: 'verdict', level: level, template: template, values: values || {}, ev: ev }; }
    function _notes(head, template, values, ev) { return { kind: 'notes', head: head, template: template, values: values || {}, ev: ev }; }
    function _table(id, head, rows, ev) { return { kind: 'table', id: id, head: head, rows: rows, ev: ev }; }
    function _chart(id, series) { return { kind: 'chart', id: id, series: series.filter(function (s) { return s && s.x.length; }) }; }
    function _series(name, cat, xs, ys) {
        var x = [], y = [];
        for (var i = 0; i < xs.length; i++) if (_isNum(xs[i])) { x.push(xs[i]); y.push(_isNum(ys[i]) ? ys[i] : null); }
        return { name: name, cat: cat, x: x, y: y };
    }
    function _yes(b) { return b ? 'yes' : 'no'; }
    function _blank(n) { var a = []; for (var i = 0; i < n; i++) a.push(''); return a; }

    function _rc(an, review, audit, signoff, opts) {
        var idx = (opts.idx && opts.idx.items && _isArr(opts.idx.order)) ? opts.idx : _evidenceFor(an, { cal: opts.cal });
        var roots = _roots(an, { review: review, signoff: signoff, audit: audit, cal: opts.cal });
        var c = _ctxFor(an, idx, roots);
        c.roots = roots; c.review = review; c.signoff = signoff; c.audit = _auditLog(audit); c.opts = opts;
        var li = _latestIdx(an);
        c.latest = li >= 0 ? an.tests[li] : null;
        c.has = function (id) { return !!idx.items[id]; };
        c.evs = function (ids) { return _uniq(ids).filter(function (x) { return idx.items[x]; }); };
        c.first = c.tests.length ? c.tests[0] : null;
        c.t0 = c.first ? c.first.tc_ms : null;
        return c;
    }
    function _alertVerdict(c, which) {
        var A = c.an.trend && c.an.trend.alerts && c.an.trend.alerts[which];
        var id = which === 'delta' ? 'T2' : 'T3';
        var name = which === 'delta' ? 'Delta skin alert' : 'Absolute skin alert on {basis}';
        if (!A) return _verdict('warn', '⚠ ' + (which === 'delta' ? 'Delta' : 'Absolute') + ' skin alert: no trend available.', {}, [id]);
        var vals = { thr: c.V(id, 'threshold'), st: c.V(id, 'status') };
        if (which === 'absolute') vals.basis = c.V('T3', 'basisText');
        var tpl, level;
        if (A.status === 'confirmed') { level = 'bad'; tpl = '✗ ' + name + ' confirmed at {cf} (raised at {r}; threshold {thr}).'; vals.cf = c.V(id, 'confirmedAt'); vals.r = c.V(id, 'raisedAt'); }
        else if (A.status === 'provisional') { level = 'warn'; tpl = '⚠ ' + name + ' provisional: raised at {r}, not yet confirmed (threshold {thr}).'; vals.r = c.V(id, 'raisedAt'); }
        else if (A.status === 'possible') { level = 'warn'; tpl = '⚠ ' + name + ' possible: only tests excluded as low exceed the threshold ({thr}).'; }
        else { level = 'ok'; tpl = '✓ ' + name + ': none (threshold {thr}).'; }
        if (A.kHeldOnly) tpl += ' Every contributing test is k-held.';
        delete vals.st;
        return _verdict(level, tpl, vals, which === 'delta' ? ['T2', 'T1'] : ['T3']);
    }
    function _statusVerdict(c, st) {
        if (st === 'SIGNED') return _verdict('ok', '✓ Signed off by {name} ({role}) on {date} · hash {h}.', { name: c.V('V14', 'signer'), role: c.V('V14', 'role'), date: c.V('V14', 'signedAt'), h: c.V('V14', 'sigHash16') }, ['V14']);
        if (st === 'CHANGED') return _verdict('warn', '⚠ DRAFT — changed after sign-off on {date}; sign off again after review.', { date: c.V('V14', 'signedAt') }, ['V14']);
        var n = c.review ? canSign(c.review).open.length : 0;
        if (n) return _verdict('warn', '⚠ DRAFT — not signed off ({n} findings need a decision).', { n: c.V('V14', 'nOpen') }, ['V14']);
        return _verdict('warn', '⚠ DRAFT — not signed off.', {}, ['V14']);
    }
    function _S1(c, st) {
        var b = [], L = c.latest, items = [];
        if (L && L.result) {
            items.push({ label: 'Latest skin', value: c.V(L.id + '·A2', 'S'), ev: c.evs([L.id + '·A2', L.id + '·K1']) });
            items.push({ label: 'Skin uncertainty S_err', value: c.V(L.id + '·U1', 'value'), ev: c.evs([L.id + '·U1']) });
        }
        items.push({ label: 'Baseline skin', value: c.V('T1', 'S'), ev: ['T1'] });
        if (L && L.result) items.push({ label: 'Skin change since the baseline', value: c.V('T1', 'dSLatest'), ev: c.evs(['T1', L.id + '·A2']) });
        items.push({ label: 'k (baseline median)', value: c.V('T9', 'kBase'), ev: ['T9'] });
        if (L && L.result) items.push({ label: 'Labels (k/S · test)', value: c.V(L.id + '·K1', 'labels'), ev: c.evs([L.id + '·K1', L.id + '·K2']) });
        items.push({ label: 'Skin rise onset', value: c.V('T4', 'date'), ev: ['T4'] });
        items.push({ label: 'Forecast crossing', value: c.V('T6', 'date'), ev: ['T6'] });
        b.push({ kind: 'kpi', items: items });
        b.push(_alertVerdict(c, 'delta'));
        b.push(_alertVerdict(c, 'absolute'));
        b.push(_statusVerdict(c, st));
        if (L && L.result) {
            var tr = c.an.trend || {}, d = tr.alerts && tr.alerts.delta;
            var tpl = (d && d.status === 'confirmed' ? 'Skin has risen above the baseline' : d && (d.status === 'provisional' || d.status === 'possible') ? 'Skin may be rising above the baseline' : 'Skin is near the baseline') +
                      ': baseline {sb}, latest {s} ± {e} at {t}. k is ' + (tr.kStability && tr.kStability.stable ? 'stable' : 'not stable') + ' between tests (CV {cv} %). ';
            tpl += (tr.kStability && tr.kStability.stable && d && d.status === 'confirmed') ? 'With stable k the change is near the well (damage or a pseudo-skin change), not in the formation.' : 'Read the alerts with the confidence labels and the review findings below.';
            b.push(_notes('Assessment', tpl, { sb: c.V('T1', 'S'), s: c.V(L.id + '·A2', 'S'), e: c.V(L.id + '·U1', 'value'), t: c.V(L.id + '·A2', 'test'), cv: c.V('T9', 'cvPct') }, c.evs(['T1', 'T9', L.id + '·A2'])));
        }
        return { id: 'S1', title: 'Summary', blocks: b };
    }
    function _S2(c) {
        var b = [], qc = c.an.qc || {};
        b.push(_kv([
            _row('Gauge noise σ (shut-in / flowing)', _tv('{a} / {b}', { a: c.V('Q1', 'sigmaShut_psi'), b: c.V('Q1', 'sigmaFlow_psi') }), ['Q1']),
            _row('Sampling interval (median, 5 %, 95 %)', _tv('{m} s, {p5} s, {p95} s ({n} samples)', { m: c.V('Q2', 'dtMed_s'), p5: c.V('Q2', 'dtP05_s'), p95: c.V('Q2', 'dtP95_s'), n: c.V('Q2', 'n') }), ['Q2']),
            _row('Gaps', _tv('{n} gaps, {tot} h in total, longest {lg} h', { n: c.V('Q3', 'gapCount'), tot: c.V('Q3', 'gapTotal_h'), lg: c.V('Q3', 'longestGap_h') }), ['Q3']),
            _row('Spikes', _tv('{n} ({mode})', { n: c.V('Q4', 'count'), mode: c.V('Q4', 'mode') }), ['Q4']),
            _row('Gauge drift (assumed)', c.V('Q5', 'drift'), ['Q5']),
            _row('Tide index (largest test)', c.V('Q6', 'maxTide'), ['Q6']),
            _row('Temperature data', c.V('Q7', 'present'), ['Q7']),
            _row('Depth correction', _tv('{a} ({s})', { a: c.V('Q8', 'applied'), s: c.V('Q8', 'shift_psi') }), ['Q8']),
            _row('Gauge time zone', c.V('Q2', 'zoneGauge'), ['Q2']),
            _row('Production day', _tv('starts at hour {h} in {z}', { h: c.V('Q2', 'dayStart'), z: c.V('Q2', 'zoneDay') }), ['Q2']),
            _row('Settings used: detection', _tv('window {w} min, rise {r} or {s} σ, persistence {p} min, minimum duration {d} h, gap {g} samples, spikes {sp}, partial cuts classified {pc}',
                { w: c.V('D1', 'winMin'), r: c.V('D1', 'riseMin'), s: c.V('D1', 'riseSig'), p: c.V('D1', 'persistMin'), d: c.V('D1', 'minDur_h'), g: c.V('D1', 'gapN'), sp: c.V('D1', 'spike'), pc: c.V('D1', 'partial') }), ['D1']),
            _row('Settings used: interpretation', _tv('Bourdet L {L} cycle, IARF band {b} %, slope {sl}, minimum {mc} cycle', { L: c.V('I1', 'Lcyc'), b: c.V('I1', 'bandPct'), sl: c.V('I1', 'slope'), mc: c.V('I1', 'minCycles') }), ['I1']),
            _row('Settings used: models', _tv('rivals {r}, C-held refits {c}, k-held fits {k}, tide removal {t}', { r: c.V('M1', 'rivals'), c: c.V('M1', 'cheld'), k: c.V('M1', 'kHeld'), t: c.V('M1', 'tide') }), ['M1']),
            _row('Settings used: trend', _tv('baseline tests {n}, delta alert {d}, absolute alert {a}, confirmation {cf}, trend enabled {en}',
                { n: c.V('T1', 'baseN'), d: c.V('T2', 'threshold'), a: c.V('T3', 'threshold'), cf: c.V('T2', 'confirm'), en: c.V('T2', 'enabled') }), ['T1', 'T2', 'T3'])
        ]));
        var warned = false;
        if (qc.resolutionLimited) { warned = true; b.push(_verdict('warn', '⚠ Gauge resolution ({r}) limits the noise estimate.', { r: c.V('Q1', 'resolution_psi') }, ['Q1'])); }
        if (qc.noiseCorrelated) { warned = true; b.push(_verdict('warn', '⚠ Gauge noise is correlated (lag-one autocorrelation {rho}); σ is a lower bound.', { rho: c.V('Q1', 'rho1') }, ['Q1'])); }
        if (_isNum(qc.gapCount) && qc.gapCount > 0) { warned = true; b.push(_verdict('warn', '⚠ {n} data gaps, the longest {lg} h.', { n: c.V('Q3', 'gapCount'), lg: c.V('Q3', 'longestGap_h') }, ['Q3'])); }
        if (!warned) b.push(_verdict('ok', '✓ Data quality checks passed: no gaps, uncorrelated noise, resolution adequate.', {}, ['Q1', 'Q2', 'Q3']));
        return { id: 'S2', title: 'Data and quality', blocks: b };
    }
    function _S3(c) {
        var b = [], an = c.an, events = _arr(an.events), testOf = {};
        c.tests.forEach(function (t) { testOf[t.eventId] = t; });
        var rqc = _rateCat(an.rates && an.rates.unit);
        var head = [{ text: 'Event', cat: null }, { text: 'Test', cat: null }, { text: 'Time', cat: null }, { text: 'Kind', cat: null }, { text: 'Status', cat: null },
                    { text: 'Δt end (h)', cat: null }, { text: 'Δq', cat: rqc }, { text: 'Rate source', cat: null }, { text: 'pwf0', cat: 'pressure' }, { text: 'Allocation check', cat: null },
                    { text: 'Note', cat: null }];
        var shown = events.slice(-MAX_ROWS), rows = [], ev = ['D1'];
        if (events.length > MAX_ROWS) rows.push([c.V('D1', 'nOlderEvents'), 'older events not shown'].concat(_blank(head.length - 2)));
        shown.forEach(function (e) {
            var t = testOf[e.id];
            rows.push([e.id, t ? t.id : '—', c.V('D1', e.id + '_time'), _str(e.kind), _str(e.status), c.V('D1', e.id + '_dtEnd_h'),
                       t ? c.V(t.id + '·R1', 'Dq') : '—', t && t.spec && t.spec.rateQC ? _str(t.spec.rateQC.dqSource) : '—', c.V('D1', e.id + '_pwf0'), e.alloc ? _str(e.alloc.confirm) : '—',
                       _eventNote(e, t)]);
            if (t && c.has(t.id + '·D2')) ev.push(t.id + '·D2');
        });
        b.push(_table('bu_tbl_events', head, rows, c.evs(ev)));
        var dayIdx = _daysAround(an, _dayFinder(an)), dayRows = [], days = an.rates ? _arr(an.rates.days) : [];
        var keep = dayIdx.slice(-MAX_ROWS);
        if (dayIdx.length > MAX_ROWS) dayRows.push([c.V('R2', 'nOlderDays'), 'earlier days not shown', '', '', '', '']);
        keep.forEach(function (j) {
            var d = days[j];
            dayRows.push([c.V('R2', 'd' + j + '_date'), c.V('R2', 'd' + j + '_hOn'), c.V('R2', 'd' + j + '_V'), c.V('R2', 'd' + j + '_q'), _str(d && d.cls), d && d.R3 ? c.V('R2', 'd' + j + '_R3') : '—']);
        });
        if (dayRows.length) b.push(_table('bu_tbl_days', [{ text: 'Date', cat: null }, { text: 'Flowing hours (h)', cat: null }, { text: 'Volume', cat: _volCat(an) },
                                                             { text: 'Rate', cat: rqc }, { text: 'Class', cat: null }, { text: 'Allocation ratio', cat: null }], dayRows, ['R2']));
        var t0 = c.t0;
        if (_isNum(t0) && days.length) {
            var xs = days.map(function (d) { return (0.5 * (d.t0_ms + d.t1_ms) - t0) / 86400000; });
            b.push(_chart('bu_ch_rate', [_series('Allocated rate', rqc, xs, days.map(function (d) { return d.q; })),
                                         _series('Mean flowing pressure', 'pressure', xs, days.map(function (d) { return d.pwfMean_psia; }))]));
        }
        b.push(_kv([
            _row('Rate basis', _tv('{u} ({mode} mode), maximum water cut {wc} %, GOR ratio to Rs {gor}', { u: c.V('R7', 'used'), mode: c.V('R7', 'mode'), wc: c.V('R7', 'wcPct'), gor: c.V('R7', 'gorRatioMax') }), ['R7']),
            _row('History before the data', _tv('{src}, {pre} h prepended (estimated: {flag})', { src: c.V('R5', 'source'), pre: c.V('R5', 'prepend_h'), flag: c.V('R5', 'flag') }), ['R5']),
            _row('Offset scan', _tv('current {cur} h, best {best} h, better: {bt}', { cur: c.V('R3', 'current_h'), best: c.V('R3', 'best_h'), bt: c.V('R3', 'better') }), ['R3'])
        ]));
        if (an.rates && an.rates.offsetScan && an.rates.offsetScan.better) b.push(_verdict('warn', '⚠ The offset scan prefers {best} h over the current {cur} h: check the gauge and production-day zones.', { best: c.V('R3', 'best_h'), cur: c.V('R3', 'current_h') }, ['R3']));
        var m = an.missed || {};
        var tpl = 'Detection found {ne} events; {ns} too short, {ni} suspected interventions, {nsub} sub-threshold steps, {nal} allocation-only days and {ng} gaps could hide shut-ins. ';
        tpl += (m.detectability && m.detectability.ok === false) ? 'Full shut-ins may be missed: p* − pwf ({d}) is less than twice the rise threshold ({ts}).' : 'Full shut-ins are detectable (p* − pwf {d} against the rise threshold {ts}).';
        b.push(_notes('Notes', tpl, { ne: c.V('D1', 'nEvents'), ns: c.V('D1', 'nTooShort'), ni: c.V('D1', 'nInterventions'), nsub: c.V('D1', 'nSub'), nal: c.V('D1', 'nAllocOnly'), ng: c.V('D1', 'nGaps'),
                                         d: c.V('D1', 'pStarMinusPwf_psi'), ts: c.V('D1', 'Ts_psi') }, ['D1']));
        return { id: 'S3', title: 'Events and rates', blocks: b };
    }
    // S3 events table "Note": fixed reason texts, plus the test's own status reason (free text, escaped by the page)
    var END_TEXT = { reopen: 'ended at the reopening', gap: 'ended at a data gap', data_end: 'ended at the end of the data' };
    var EV_STATUS_TEXT = { too_short: 'too short to interpret', gap_at_closing: 'data gap at the closing time', partial: 'partial rate cut (kept in the rate history)',
                           excluded: 'excluded', not_confirmed: 'not confirmed by the allocation', intervention: 'suspected intervention' };
    function _eventNote(e, t) {
        var l = [];
        if (e.manual === true) l.push('added manually');
        if (e.ramp && e.ramp.present === true) l.push('ramped closing');
        if (EV_STATUS_TEXT[e.status]) l.push(EV_STATUS_TEXT[e.status]);
        if (END_TEXT[e.endReason]) l.push(END_TEXT[e.endReason]);
        if (t && t.status !== 'interpreted' && typeof t.statusReason === 'string' && t.statusReason.trim()) l.push(_clip(t.statusReason.trim(), 120));
        return l.length ? l.join('; ') : '—';
    }
    function _usedText(t) {
        var u = t.used || {}, l = [];
        if (u.baseline) l.push('baseline'); if (u.trend) l.push('trend'); if (u.alert) l.push('alerts');
        return l.length ? l.join(', ') : 'no';
    }
    function _testDetail(c, t, suffix) {
        var b = [], r = t.result, id = t.id;
        if (!r) return b;
        var iarf = r.iarf || {};
        var rows = [
            _row('Test', _tv('{t}: {st}, shut-in {dt} h, Δq {q}', { t: c.V(id + '·A2', 'test'), st: c.V(id + '·A2', 'status'), dt: c.V(id + '·D5', 'dtEnd_h'), q: c.V(id + '·R1', 'Dq') }), c.evs([id + '·D5', id + '·R1'])),
            iarf.found ? _row('IARF window', _tv('{g} window {a} to {b} h ({cy} cycle)' + (iarf.noiseWidened ? ', noise-widened' : '') + (iarf.forced ? ', set by an override' : ''),
                { g: c.V(id + '·I1', 'grade'), a: c.V(id + '·I1', 'dt0_h'), b: c.V(id + '·I1', 'dt1_h'), cy: c.V(id + '·I1', 'cycles') }), [id + '·I1'])
                : _row('IARF window', _tv('none ({s})', { s: c.V(id + '·I1', 'status') }), [id + '·I1']),
            iarf.longest ? _row('Longest qualifying window', _tv('{cy} cycle', { cy: c.V(id + '·I1', 'longest') }), [id + '·I1']) : null,
            r.line ? _row('Semilog line', _tv('k {k}, S {s}, p* {ps} ({m})', { k: c.V(id + '·L1', 'k'), s: c.V(id + '·L1', 'S'), ps: c.V(id + '·L1', 'pStar'), m: c.V(id + '·L1', 'method') }), c.evs([id + '·L1', id + '·L2'])) : null,
            r.line ? _row('Line vs derivative plateau', _tv('kh differs by {d} %, S by {ds}; within limits: {p}', { d: c.V(id + '·L3', 'khDiffPct'), ds: c.V(id + '·L3', 'dS'), p: c.V(id + '·L3', 'pass') }), [id + '·L3']) : null,
            _row('Line vs match', _tv('agree {a} ({m}): k {dk} %, S {ds}', { a: c.V(id + '·A1', 'agree'), m: c.V(id + '·A1', 'mode'), dk: c.V(id + '·A1', 'dkPct'), ds: c.V(id + '·A1', 'dS') }), [id + '·A1']),
            _row('Final values', _tv('k {k}, S {s} ± {e}, C {cc} (from the {src})', { k: c.V(id + '·A2', 'k'), s: c.V(id + '·A2', 'S'), e: c.V(id + '·U1', 'value'), cc: c.V(id + '·A2', 'C'), src: c.V(id + '·A2', 'source') }), c.evs([id + '·A2', id + '·U1'])),
            (r.final && r.final.pStarRange) ? _row('p* range (estimated history)', _tv('{lo} to {hi}', { lo: c.V(id + '·A2', 'pStarLo'), hi: c.V(id + '·A2', 'pStarHi') }), [id + '·A2']) : null,
            _row('Extrapolated pressure', c.V(id + '·A2', 'pExt'), [id + '·A2']),
            _row('Radius of investigation', _tv('{r} at the end of the test, {re} in equivalent time', { r: c.V(id + '·A2', 'rinv_ft'), re: c.V(id + '·A2', 'rinvE_ft') }), [id + '·A2']),
            _row('Fully seen', (r.final && _isNum(r.final.minFaultDist_ft)) ? _tv('{s}; no sealing boundary within {d}', { s: c.V(id + '·M5', 'status'), d: c.V(id + '·M5', 'minFaultDist_ft') }) : _tv('{s}', { s: c.V(id + '·M5', 'status') }), [id + '·M5']),
            _row('Expected IARF reach', _tv('fair {f} h, good {g} h of shut-in (test {dt} h)', { f: c.V(id + '·W4', 'fairShut_h'), g: c.V(id + '·W4', 'goodShut_h'), dt: c.V(id + '·D5', 'dtEnd_h') }), c.evs([id + '·W4', id + '·D5'])),
            (!c.gas && iarf.found) ? _row('Re-derived cross-checks', _tv('k from the IARF level {kl}; mean point skin over the window {sm}', { kl: c.V(id + '·I3', 'kLevel'), sm: c.V(id + '·I4', 'Smean') }), [id + '·I3', id + '·I4']) : null,
            _row('C-held refits', _tv('triggered {tg}: S range {lo} to {hi}, S_C {sc}', { tg: c.V(id + '·C1', 'triggered'), lo: c.V(id + '·C1', 'Slo'), hi: c.V(id + '·C1', 'Shi'), sc: c.V(id + '·C1', 'S_C') }), [id + '·C1'])
        ];
        b.push(_kv(rows));
        var mrows = _arr(r.bic && r.bic.rows).slice(0, MAX_ROWS).map(function (row, j) {
            var fit = _arr(r.models).filter(function (m) { return m && m.key === row.key; })[0];
            return [MODEL_NAME[row.key] || _str(row.key), c.V(id + '·M4', 'r' + j + '_bic'), c.has(id + '·M4') && c.idx.items[id + '·M4'].values['r' + j + '_gain'] ? c.V(id + '·M4', 'r' + j + '_gain') : '—',
                    c.V(id + '·M4', 'r' + j + '_p'), _yes(row.eligible), fit && fit.fullySeen ? _str(fit.fullySeen.status) : '—'];
        });
        if (mrows.length) b.push(_table('bu_tbl_models' + suffix, [{ text: 'Model', cat: null }, { text: 'BIC', cat: null }, { text: 'ΔBIC gain over homogeneous', cat: null },
                                                                   { text: 'Parameters', cat: null }, { text: 'Eligible', cat: null }, { text: 'Fully seen', cat: null }], mrows, c.evs([id + '·M3', id + '·M4', id + '·M5'])));
        var reasons = _arr(r.confidence && r.confidence.reasons).slice(0, MAX_ROWS).map(function (x) {
            return [_str(x.rule), _str(x.kind), K_TEXT[x.rule] || '—', _arr(x.ev).map(function (e) { return id + '·' + e; }).join(', ') || '—'];
        });
        if (!reasons.length) reasons = [['—', '—', 'No rule capped or lowered the label.', id + '·K1']];
        b.push(_table('bu_tbl_reasons' + suffix, [{ text: 'Rule', cat: null }, { text: 'Kind', cat: null }, { text: 'Meaning', cat: null }, { text: 'Evidence', cat: null }], reasons, c.evs([id + '·K1', id + '·K2'])));
        var bins = r.bins || {};
        if (_isArr(bins.dt) && bins.dt.length) {
            var ser = [_series('Δp', 'pressure', bins.dt, _arr(bins.dp)), _series('Δp′', 'pressure', bins.dt, _arr(bins.deriv))];
            if (r.curves && _isArr(r.curves.dt)) {
                if (r.curves.hom) { ser.push(_series('Homogeneous Δp', 'pressure', r.curves.dt, _arr(r.curves.hom.dp))); ser.push(_series('Homogeneous Δp′', 'pressure', r.curves.dt, _arr(r.curves.hom.deriv))); }
                if (r.curves.chosen) { ser.push(_series('Chosen model Δp', 'pressure', r.curves.dt, _arr(r.curves.chosen.dp))); ser.push(_series('Chosen model Δp′', 'pressure', r.curves.dt, _arr(r.curves.chosen.deriv))); }
            }
            b.push(_chart('bu_ch_ll' + suffix, ser));
            var te = (_isArr(bins.dte) && bins.dte.length === bins.dt.length) ? bins.dte : bins.dt;
            b.push(_chart('bu_ch_sl' + suffix, [_series('Δp against log10 Δt_e', 'pressure', te.map(function (x) { return _isNum(x) && x > 0 ? MATH.log(x) / LN10 : null; }), _arr(bins.dp))]));
        }
        var why = _arr(r.triggers && r.triggers.fired).length ? 'triggers {tr}' : 'no trigger fired';
        b.push(_notes('Interpretation', '{t}: {mdl} chosen (' + why + '). IARF {g}' + (iarf.found ? ', {cy} cycle' : '') + '. Final k {k}, S {s} ± {e}; confidence {ks} for k and S and {hl} for the test.',
            { t: c.V(id + '·A2', 'test'), mdl: c.V(id + '·M6', 'label'), tr: c.V(id + '·M2', 'fired'), g: c.V(id + '·I1', 'grade'), cy: c.V(id + '·I1', 'cycles'), k: c.V(id + '·A2', 'k'), s: c.V(id + '·A2', 'S'),
              e: c.V(id + '·U1', 'value'), ks: c.V(id + '·K1', 'ks'), hl: c.V(id + '·K2', 'headline') }, c.evs([id + '·M6', id + '·I1', id + '·A2', id + '·K1'])));
        return b;
    }
    function _S4(c) {
        var b = [], an = c.an, tests = c.tests, rqc = null;
        var head = [{ text: 'Test', cat: null }, { text: 'Date', cat: null }, { text: 'Δt end (h)', cat: null }, { text: 'Δq', cat: tests.length ? _rateCat(tests[0].qUnit) : 'liquidRate' },
                    { text: 'IARF', cat: null }, { text: 'Cycles', cat: null }, { text: 'k', cat: 'permeability' }, { text: 'S', cat: null }, { text: 'S_err', cat: null },
                    { text: 'C', cat: 'wbStorage' }, { text: 'Model', cat: null }, { text: 'ΔBIC', cat: null }, { text: 'Agree', cat: null }, { text: 'Labels', cat: null },
                    { text: 'Used', cat: null }, { text: 'Override', cat: null }];
        var shown = tests.slice(-MAX_ROWS), rows = [], ev = [];
        if (tests.length > MAX_ROWS) rows.push([c.V('D1', 'nOlderTests'), 'older tests not shown'].concat(_blank(head.length - 2)));
        shown.forEach(function (t) {
            var id = t.id, r = t.result;
            if (!r) {
                rows.push([id, c.V(id + '·A2', 'date').v !== null ? c.V(id + '·A2', 'date') : _str(t.date), c.V(id + '·D5', 'dtEnd_h'), c.V(id + '·R1', 'Dq'), _str(t.status), '—', '—', '—', '—', '—', '—', '—', '—', '—', _usedText(t), _arr(t.overrides).join(', ') || '—']);
                ev.push(id + '·R1');
                return;
            }
            var ag = r.agreement || {};
            rows.push([id, c.V(id + '·A2', 'date'), c.V(id + '·D5', 'dtEnd_h'), c.V(id + '·R1', 'Dq'), _str(r.iarf && r.iarf.grade), r.iarf && r.iarf.found ? c.V(id + '·I1', 'cycles') : '—',
                       c.V(id + '·A2', 'k'), c.V(id + '·A2', 'S'), c.V(id + '·U1', 'value'), c.V(id + '·A2', 'C'), _str(r.chosen && r.chosen.label),
                       c.idx.items[id + '·M4'] && c.idx.items[id + '·M4'].values.gainChosen ? c.V(id + '·M4', 'gainChosen') : '—',
                       ag.mode === 'none' ? '—' : (ag.agree ? (ag.mode === 'bias' ? 'yes (bias)' : 'yes') : 'no'),
                       r.confidence ? r.confidence.ks + ' · ' + r.confidence.headline : '—', _usedText(t), _arr(t.overrides).join(', ') || '—']);
            ev.push(id + '·A2');
        });
        b.push(_table('bu_tbl_tests', head, rows, c.evs(ev.length ? ev : ['D1'])));
        var detail = an.settings && an.settings.report && an.settings.report.detail === 'all' ? 'all' : 'selected';
        var interp = tests.filter(function (t) { return t.result; });
        var pick;
        if (detail === 'all') pick = interp.slice(-12);
        else {
            var sel = c.opts.selected && c.test(c.opts.selected);
            pick = [sel && sel.result ? sel : c.latest].filter(Boolean);
        }
        pick.forEach(function (t) { b = b.concat(_testDetail(c, t, detail === 'all' ? '_' + t.id.toLowerCase() : '')); });
        return { id: 'S4', title: 'Build-up tests', blocks: b };
    }
    function _S5(c) {
        var b = [], an = c.an, tr = an.trend || {}, used = c.tests.filter(function (t) { return t.used && t.used.trend && t.result; });
        var series = _arr(tr.series);
        var xs = series.map(function (s) { return s.tDays; });
        var skin = [_series('Skin', null, xs, series.map(function (s) { return s.S; })), _series('Skin + S_err', null, xs, series.map(function (s) { return _isNum(s.S) && _isNum(s.Serr) ? s.S + s.Serr : null; })),
                    _series('Skin − S_err', null, xs, series.map(function (s) { return _isNum(s.S) && _isNum(s.Serr) ? s.S - s.Serr : null; }))];
        if (xs.length && tr.baseline && _isNum(tr.baseline.S)) {
            var x2 = [MATH.min.apply(null, xs.filter(_isNum)), MATH.max.apply(null, xs.filter(_isNum))];
            skin.push(_series('Baseline', null, x2, [tr.baseline.S, tr.baseline.S]));
            if (tr.alerts && tr.alerts.delta && _isNum(tr.alerts.delta.threshold)) skin.push(_series('Baseline + delta threshold', null, x2, [tr.baseline.S + tr.alerts.delta.threshold, tr.baseline.S + tr.alerts.delta.threshold]));
            if (tr.alerts && tr.alerts.absolute && _isNum(tr.alerts.absolute.threshold)) skin.push(_series('Absolute threshold', null, x2, [tr.alerts.absolute.threshold, tr.alerts.absolute.threshold]));
        }
        b.push(_chart('bu_ch_skin', skin));
        b.push(_chart('bu_ch_k', [_series('k', 'permeability', xs, series.map(function (s) { return s.k; }))]));
        b.push(_chart('bu_ch_pi', [_series('Extrapolated pressure', 'pressure', xs, series.map(function (s) { return s.pExt; }))]));
        var J = _jSeries(c);
        if (J) b.push(_chart('bu_ch_j', J));
        if (c.fluid === 'oil' && tr.bubble && _arr(tr.bubble.rows).length) {
            var br = tr.bubble.rows, bx = br.map(function (r) { var s = series.filter(function (x) { return x.id === r.id; })[0]; return s ? s.tDays : null; });
            var ser = [_series('Sandface pwf low', 'pressure', bx, br.map(function (r) { return r.pwfSand_lo; })), _series('Sandface pwf high', 'pressure', bx, br.map(function (r) { return r.pwfSand_hi; }))];
            if (_isNum(an.well && an.well.Pb)) { var bxs = bx.filter(_isNum); if (bxs.length) ser.push(_series('Bubble point', 'pressure', [MATH.min.apply(null, bxs), MATH.max.apply(null, bxs)], [an.well.Pb, an.well.Pb])); }
            b.push(_chart('bu_ch_pwf', ser));
        }
        var ov = used.slice(-12).map(function (t) {
            var bn = t.result.bins || {}, te = (_isArr(bn.dte) && bn.dte.length === _arr(bn.dt).length) ? bn.dte : _arr(bn.dt);
            return _series(t.id + ' Δp/q', null, te, _arr(bn.dp).map(function (y) { return _isNum(y) && t.Dq ? y / t.Dq : null; }));   // psi per rate unit: no single unit category
        });
        if (ov.length) b.push(_chart('bu_ch_ov', ov));
        var L = c.latest, pi = tr.pi || {};
        var bl = tr.baseline || {}, onset = tr.onset || {}, rec = tr.recent || {}, fc = tr.forecast || {}, ks = tr.kStability || {}, pt = tr.pTrend || {}, low = tr.excludedLow || {};
        var rowsKv = [
            _row('Baseline', _tv('S {s} ± {sg} from {ts}' + (bl.unstable ? ' (unstable)' : '') + (bl.provisional ? ' (provisional)' : ''), { s: c.V('T1', 'S'), sg: c.V('T1', 'sigma'), ts: c.V('T1', 'tests') }), ['T1']),
            _row('Delta alert', _tv('{st}; raised at {r}, confirmed at {cf}; threshold {thr} ({f} form)', { st: c.V('T2', 'status'), r: c.V('T2', 'raisedAt'), cf: c.V('T2', 'confirmedAt'), thr: c.V('T2', 'threshold'), f: c.V('T2', 'form') }), ['T2']),
            _row('Absolute alert', _tv('{st} on {b}; raised at {r}, confirmed at {cf}; threshold {thr}', { st: c.V('T3', 'status'), b: c.V('T3', 'basisText'), r: c.V('T3', 'raisedAt'), cf: c.V('T3', 'confirmedAt'), thr: c.V('T3', 'threshold') }), ['T3']),
            _row('Onset', _isNum(onset.tauDays) ? _tv('about day {tau} ({d}), interval days {lo} to {hi}, {m} model' + (onset.indicative ? ' (indicative)' : ''), { tau: c.V('T4', 'tauDays'), d: c.V('T4', 'date'), lo: c.V('T4', 'lo'), hi: c.V('T4', 'hi'), m: c.V('T4', 'model') })
                                                : _tv('none found ({m} model)', { m: c.V('T4', 'model') }), ['T4']),
            _row('Recent trend', _isNum(rec.slopePer30d) ? _tv('{sl} per 30 days (Sen interval {lo} to {hi}, Mann–Kendall p {p}, {n} tests' + (rec.indicative ? ', indicative' : '') + ')', { sl: c.V('T5', 'slopePer30d'), lo: c.V('T5', 'ciLo'), hi: c.V('T5', 'ciHi'), p: c.V('T5', 'mkP'), n: c.V('T5', 'n') })
                                                       : _tv('not computed ({n} tests after the onset)', { n: c.V('T5', 'n') }), ['T5']),
            _row('Forecast', fc.show ? _tv('crossing about {d} (earliest {e}, latest {l})', { d: c.V('T6', 'date'), e: c.V('T6', 'earliest'), l: c.V('T6', 'latest') }) : _tv('{why}', { why: c.V('T6', 'reason') }), ['T6']),
            L && c.has('T7') && c.idx.items.T7.values[L.id + '_dpSkin'] ? _row('Pressure drop across the skin (latest test)', _tv('{dp} at {t}', { dp: c.V('T7', L.id + '_dpSkin'), t: c.V(L.id + '·A2', 'test') }), c.evs(['T7', L.id + '·A2'])) : null,
            _row('PI ratio and production at stake', pi.guard ? _tv('not computable (strongly negative skin)', {}) :
                 _tv('PI ratio {now} now against {base} at the baseline' + (pi.ratioLowerBound ? ' (lower bound)' : '') + '; rate at stake {rate}; extra drawdown at constant rate {dd}; cumulative since the onset {cum}' + (pi.atStakeUpperBound ? ' (upper bounds)' : '') + '; pseudo-steady-state estimate',
                     { now: c.V('T8', 'ratioNow'), base: c.V('T8', 'ratioBase'), rate: c.V('T8', 'rateAtStake'), dd: c.V('T8', 'extraDrawdown_psi'), cum: c.V('T8', 'cumAtStake') }), ['T8']),
            _row('k stability', _tv('CV {cv} % (limit {lim} %): ' + (ks.stable ? 'stable' : 'not stable') + '; reading {rd}', { cv: c.V('T9', 'cvPct'), lim: c.V('T9', 'cvLimPct'), rd: c.V('T9', 'reading') }), ['T9']),
            _row('Pressure trend', pt.assessable ? _tv((pt.quantity === 'pbar' ? 'average pressure' : 'p*') + ' changes by {sl} per 30 days, scatter {sc}; depletion {dep}', { sl: c.V('T10', 'slopePer30d'), sc: c.V('T10', 'scatter'), dep: c.V('T10', 'depletion') })
                                                 : _tv('depletion cannot be assessed: {why}', { why: c.V('T10', 'reason') }), ['T10']),
            _row('Model-free skin change', _tv('{n} tests checked; {a} agree with the fitted change', { n: c.V('T11', 'n'), a: c.V('T11', 'nAgree') }), ['T11']),
            _row('Bubble point', (c.fluid === 'oil' && _isNum(an.well && an.well.Pb)) ? _tv('{n} tests checked against Pb {pb}; {nb} below; lowest margin {mm}', { n: c.V('T12', 'n'), pb: c.V('T12', 'pb'), nb: c.V('T12', 'nBelow'), mm: c.V('T12', 'minMargin') })
                                                                                    : _tv('not applicable', {}), ['T12']),
            _row('PI cross-check', _tv('available {a}; consistent {c}', { a: c.V('T13', 'available'), c: c.V('T13', 'consistent') }), ['T13']),
            _row('Mechanical skin', (tr.mech && tr.mech.available) ? _tv('geometric pseudo-skin {sg} (range {lo} to {hi}), pressure-drop basis', { sg: c.V('T14', 'Sgeo'), lo: c.V('T14', 'SgeoLo'), hi: c.V('T14', 'SgeoHi') })
                                                                   : _tv('not available (no completion data): the alerts use total skin', {}), ['T14']),
            _row('Rate-dependent skin', c.gas ? _tv('resolved {r}: D {d} ± {se}', { r: c.V('T15', 'resolved'), d: c.V('T15', 'D'), se: c.V('T15', 'seD') }) : _tv('not assessed for this fluid', {}), ['T15']),
            _row('Tests excluded as low', (_isNum(low.n) && low.n > 0) ? _tv('{n} low tests excluded, S {lo} to {hi}', { n: c.V('T16', 'n'), lo: c.V('T16', 'Slo'), hi: c.V('T16', 'Shi') }) : _tv('{n} low tests excluded', { n: c.V('T16', 'n') }), ['T16'])
        ];
        b.push(_kv(rowsKv));
        b.push(_alertVerdict(c, 'delta'));
        b.push(_alertVerdict(c, 'absolute'));
        var hist = _arr(c.tests).some(function (t) { return t.spec && t.spec.history && t.spec.history.estimated; });
        if (pt.assessable === false && hist && c.fluid === 'oil' && _isNum(an.well && an.well.Pb) && L && L.result && L.result.final && L.result.final.pStarRange) {
            b.push(_verdict('warn', '⚠ Depletion cannot be assessed (estimated history); the p* range at {t} is {lo} to {hi} against Pb {pb}.',
                            { t: c.V(L.id + '·A2', 'test'), lo: c.V(L.id + '·A2', 'pStarLo'), hi: c.V(L.id + '·A2', 'pStarHi'), pb: c.V('T12', 'pb') }, c.evs(['T10', 'T12', L.id + '·A2'])));
        }
        b.push(_table('bu_tbl_robust', [{ text: 'Case', cat: null }, { text: 'First test meeting the absolute threshold', cat: null }],
                      [['S − S_sens', c.V('T3', 'loAt')], ['S', c.V('T3', 'raisedAt')], ['S + S_sens', c.V('T3', 'hiAt')]], ['T3']));
        return { id: 'S5', title: 'Trend and alerts', blocks: b };
    }
    // Daily J_obs and J_pred (display only; T13 basis): p_ref interpolated between the used tests' p_ext.
    function _jSeries(c) {
        var an = c.an, tr = an.trend || {}, days = an.rates ? _arr(an.rates.days) : [];
        if (c.fluid === 'water_inj' || !tr.pi || !_isNum(tr.pi.X) || !an.baseline || !_isNum(an.baseline.k) || !_isNum(c.t0)) return null;
        var used = c.tests.filter(function (t) { return t.used && t.used.trend && t.result && t.result.final && _isNum(t.result.final.pExt); });
        if (used.length < 2) return null;
        var pk = used.map(function (t) { return [t.tc_ms, t.result.final.pExt]; });
        var sk = used.map(function (t) { return [(t.tc_ms - c.t0) / 86400000, t.result.final.S]; });
        var lin = _lin;
        var w = an.well || {}, x = [], jo = [], jp = [];
        days.forEach(function (d) {
            var mid = 0.5 * (d.t0_ms + d.t1_ms);
            if (d.cls !== 'clean' || !_isNum(d.pwfMean_psia) || mid < used[0].tc_ms || mid > used[used.length - 1].tc_ms) return;
            x.push((mid - c.t0) / 86400000);
            jo.push(FORMULAS.jObs(d.q, lin(pk, mid), d.pwfMean_psia));
            jp.push(FORMULAS.jPred(an.baseline.k, w.h, w.B, w.mu, tr.pi.X, lin(sk, (mid - c.t0) / 86400000)));
        });
        if (!x.length) return null;
        var cat = c.gas ? 'gasPI' : 'productivityIndex';
        return [_series('J observed', cat, x, jo), _series('J predicted', cat, x, jp)];
    }
    function _S6(c) {
        var b = [], rows = [], ev = [];
        c.tests.filter(function (t) { return t.result && t.result.sErr; }).slice(-MAX_ROWS).forEach(function (t) {
            var id = t.id;
            rows.push([id, c.V(id + '·U1', 'mode'), c.V(id + '·U1', 'floor'), c.V(id + '·U1', 'seS'), c.V(id + '·U1', 'dLineMatch'), c.V(id + '·U1', 'sWin'), c.V(id + '·U1', 'sTc'), c.V(id + '·U1', 'sPwf'),
                       c.V(id + '·U1', 'sK'), c.V(id + '·U1', 'S_C'), c.V(id + '·U1', 'sSens'), c.V(id + '·U1', 'value')]);
            ev.push(id + '·U1');
        });
        if (rows.length) b.push(_table('bu_tbl_serr', [{ text: 'Test', cat: null }, { text: 'Mode', cat: null }, { text: 'Floor', cat: null }, { text: 'Fit se', cat: null }, { text: 'Line–match', cat: null },
                                                       { text: 'Window', cat: null }, { text: 'Closing time', cat: null }, { text: 'pwf0', cat: null }, { text: 'Held k', cat: null }, { text: 'C-held', cat: null },
                                                       { text: 'Input sensitivity', cat: null }, { text: 'S_err', cat: null }], rows, c.evs(ev)));
        var L = c.latest;
        if (L && L.result && L.result.sensitivity) {
            var id = L.id;
            b.push(_kv([
                _row('Dominant input for k (requirement ranges)', c.V(id + '·U3', 'kReq'), [id + '·U3']),
                _row('Dominant input for k (typical ranges)', c.V(id + '·U3', 'kTyp'), [id + '·U3']),
                _row('Dominant input for S (requirement ranges)', c.V(id + '·U3', 'sReq'), [id + '·U3']),
                _row('Dominant input for S (typical ranges)', c.V(id + '·U3', 'sTyp'), [id + '·U3'])
            ]));
            b.push(_notes('Assessment', 'A uniform input error shifts every skin equally, so the delta alert does not depend on it; the absolute alert moves by up to {ss} (typical ranges, {t}). Total skin is mechanical skin plus pseudo-skins; μ has no effect on S.',
                          { ss: c.V(id + '·U1', 'sSens'), t: c.V(id + '·A2', 'test') }, c.evs([id + '·U1', id + '·U2'])));
        } else b.push(_notes('Assessment', 'A uniform input error shifts every skin equally, so the delta alert does not depend on it. Total skin is mechanical skin plus pseudo-skins; μ has no effect on S.', {}, ['U2']));
        return { id: 'S6', title: 'Uncertainty', blocks: b };
    }
    var REC = {
        stimReview: ['Review the well as a stimulation candidate: the delta skin alert is confirmed at {t} and k is stable.', function (c) { return { t: c.V('T2', 'confirmedAt') }; }, ['T2', 'T9']],
        verifyInputs: ['Verify the inputs left at their defaults ({l}); k and S scale with them.', function (c) { return { l: c.V('U2', 'defaultedPhys') }; }, ['U2']],
        bubblePoint: ['Check the bubble point: sandface pressure comes close to Pb ({pb}).', function (c) { return { pb: c.V('T12', 'pb') }; }, ['T12']],
        wcGor: ['Watch the water cut and GOR: the rate basis is {u}.', function (c) { return { u: c.V('R7', 'used') }; }, ['R7']],
        nonDarcy: ['Run a multi-rate test to resolve the rate-dependent skin.', null, ['T15']],
        longerShutin: ['Shut the well in for at least {x} h so the build-up reaches a fair IARF.', function (c) { return { x: c.V('W4', 'fairShutMedian') }; }, ['W4']],
        enterStart: ['Enter the production start date or the cumulative production: the history before the data is estimated.', null, ['R5']],
        enterWorkover: ['Enter a workover date: an intervention is suspected.', null, ['D1']]
    };
    var REC_ALIAS = { stimulation: 'stimReview', inputs: 'verifyInputs', defaulted: 'verifyInputs', bubble: 'bubblePoint', waterCut: 'wcGor', gor: 'wcGor', multiRate: 'nonDarcy',
                      shutinLength: 'longerShutin', shutin: 'longerShutin', reach: 'longerShutin', historyStart: 'enterStart', history: 'enterStart', workover: 'enterWorkover', intervention: 'enterWorkover' };
    function _S7(c) {
        var codes = [], b = [];
        _arr(c.an.trend && c.an.trend.recommendations).forEach(function (r) { if (r && r.code) codes.push({ code: REC_ALIAS[r.code] || r.code, rec: r }); });
        var rv = c.review;
        if (rv) _arr(rv.findings).forEach(function (f) { if (f.rule === 'V5') codes.push({ code: 'stimReview' }); if (f.rule === 'V9') codes.push({ code: 'longerShutin' }); if (f.rule === 'V13') codes.push({ code: 'verifyInputs' }); });
        var done = {};
        codes.forEach(function (x) {
            if (b.length >= 6 || done[x.code]) return;
            done[x.code] = 1;
            var R = REC[x.code];
            if (R) { b.push(_notes('Recommendations', R[0], R[1] ? R[1](c) : {}, c.evs(R[2]))); return; }
            var txt = x.rec && typeof x.rec.text === 'string' ? x.rec.text : '';
            if (txt && !/\d/.test(txt) && txt.length <= 600 && txt.indexOf('{') === -1) {
                var ev = c.evs(_arr(x.rec.ev));
                b.push(_notes('Recommendations', txt, {}, ev.length ? ev : ['T1']));
            }
        });
        if (!b.length) b.push(_notes('Recommendations', 'No action is recommended from this analysis.', {}, ['T1']));
        return { id: 'S7', title: 'Recommendations', blocks: b };
    }
    var LIMITS = [
        ['models', 'Dual porosity, fractures, channels and multilayer behaviour are not interpreted; they are flagged when seen.', 'M1'],
        ['singlePhase', 'Single-phase fluid and constant compressibility are assumed; two-phase compressibility is only flagged.', 'R7'],
        ['inputs', 'The inputs (h, φ, μ, B, ct, rw) are not checked by the analysis; k and S scale with them.', 'U2'],
        ['allocation', 'Allocated rates carry the allocation accuracy into k.', 'R3'],
        ['totalSkin', 'Skin is total skin unless completion data split it into mechanical skin and pseudo-skins.', 'T14'],
        ['pss', 'PI ratio and production at stake are pseudo-steady-state estimates.', 'T8'],
        ['partial', 'Partial rate cuts are classified and kept in the rate history but not interpreted.', 'D1'],
        ['storage', 'Changing wellbore storage and gradient changes in the wellbore during the build-up are not modelled.', 'M1'],
        ['iarfEarliest', 'The IARF window is the earliest plateau after the storage hump, not the longest; the longest qualifying window is reported.', 'I1'],
        ['history', 'With an estimated production history p* is a range and is not used for any trend.', 'R5']
    ];
    function _S8(c) {
        var items = LIMITS.slice(), have = {};
        items.forEach(function (x) { have[x[0]] = 1; });
        _arr(c.an.trend && c.an.trend.limitations).forEach(function (l) {
            if (!l || have[l.code] || typeof l.text !== 'string' || /\d/.test(l.text) || l.text.indexOf('{') !== -1 || l.text.length > 300) return;
            have[l.code] = 1; items.push([l.code, l.text, 'T1']);
        });
        var b = [], cur = '', ev = [];
        items.forEach(function (x) {
            if (cur && cur.length + 1 + x[1].length > 600) { b.push(_notes('Notes', cur, {}, c.evs(ev))); cur = ''; ev = []; }
            cur = cur ? cur + ' ' + x[1] : x[1];
            ev.push(x[2]);
        });
        if (cur) b.push(_notes('Notes', cur, {}, c.evs(ev)));
        return { id: 'S8', title: 'Limitations', blocks: b };
    }
    var S9_NOTE = 'This automated rule-based review is independent of the report text and partly of the engine: its re-derivation rules recompute key results from stored data without calling the interpretation engine. ' +
                  'It is not independent of the physics model. The evidence check re-reads every quoted number from the analysis and recomputes derived quantities; a failure blocks sign-off until a re-run clears it.';
    function _S9(c) {
        var b = [], rv = c.review;
        if (!_obj(rv)) {
            b.push(_verdict('warn', '⚠ The automated rule-based review has not been run on this analysis: no findings and no evidence check are reported.', {}, ['V14']));
            b.push(_notes('Notes', S9_NOTE, {}, ['V14']));
            return { id: 'S9', title: 'Automated rule-based review', blocks: b };
        }
        var cn = rv.counts || {};
        var lvl = cn.critical > 0 ? 'bad' : cn.major > 0 ? 'warn' : 'ok';
        b.push(_verdict(lvl, (lvl === 'ok' ? '✓' : lvl === 'warn' ? '⚠' : '✗') + ' Automated rule-based review: {c} critical, {mj} major, {mn} minor, {sg} suggestions.',
                        { c: c.V('V14', 'nCritical'), mj: c.V('V14', 'nMajor'), mn: c.V('V14', 'nMinor'), sg: c.V('V14', 'nSuggestion') }, ['V14']));
        var ec = rv.evidenceCheck || {};
        var v14 = _arr(rv.findings).some(function (f) { return f.rule === 'V14'; });
        b.push(ec.ok !== false && !v14 ? _verdict('ok', '✓ Evidence check: {n} quoted values re-read and recomputed; none differs.', { n: c.V('V14', 'nChecked') }, ['V14'])
                                       : _verdict('bad', '✗ Evidence check: {f} quoted values differ from the analysis; re-run the analysis.', { f: c.V('V14', 'nFailed') }, ['V14']));
        var groups = {}, order = [];
        _arr(rv.findings).forEach(function (f) { if (!groups[f.rule]) { groups[f.rule] = []; order.push(f.rule); } groups[f.rule].push(f); });
        if (order.length) {
            var rows = order.slice(0, MAX_ROWS).map(function (rid) {
                var fs = groups[rid], R = RULES[rid] || {};
                var tests = _uniq([].concat.apply([], fs.map(function (f) { return _arr(f.tests); })));
                var evs = _uniq([].concat.apply([], fs.map(function (f) { return _arr(f.ev); })));
                var decs = _uniq(fs.map(function (f) { return f.decision ? f.decision.d : 'open'; }));
                return [rid, _str(R.severity), _str(R.where), _str(R.title), tests.slice(0, 12).join(', ') || '—', evs.slice(0, 8).join(', ') + (evs.length > 8 ? ', …' : ''),
                        fs.every(function (f) { return f.check && f.check.ok; }) ? 'ok' : 'failed', decs.length === 1 ? decs[0] : 'mixed'];
            });
            var evAll = c.evs(order.concat([].concat.apply([], order.map(function (r) { return [].concat.apply([], groups[r].map(function (f) { return _arr(f.ev); })); }))));
            b.push(_table('bu_tbl_review', [{ text: 'Rule', cat: null }, { text: 'Severity', cat: null }, { text: 'Where', cat: null }, { text: 'Finding', cat: null }, { text: 'Tests', cat: null },
                                            { text: 'Evidence', cat: null }, { text: 'Check', cat: null }, { text: 'Decision', cat: null }], rows, evAll));
            var fr = _arr(rv.findings).slice(0, MAX_ROWS).map(function (f) {
                return _row(f.id + ' · ' + f.rule + ' · ' + f.severity + (f.decision ? ' · ' + f.decision.d : ''), _tv(f.template, f.values), c.evs(_arr(f.ev).length ? f.ev : [f.rule]));
            });
            if (rv.findings.length > MAX_ROWS) fr.push(_row('More findings', _tv('{n} more findings are listed in the table above.', { n: c.V('V14', 'nMoreFindings') }), ['V14']));
            b.push(_kv(fr));
        }
        b.push(_notes('Notes', S9_NOTE, {}, ['V14']));
        return { id: 'S9', title: 'Automated rule-based review', blocks: b };
    }
    function _reproBlock(c) {
        return _notes('Notes', 'Reproducible: opening this project in Well Testing Suite {ver} and pressing Analyse gives the same displayed numbers (inputs {ih}, results {rh}). Times are read in {gz} and production days in {dz}. ' +
                      'Numbers are rounded to display precision before hashing, and threshold decisions use rounded inputs; hidden last digits can differ between devices. Raw gauge data {raw}. Run on {date}.',
                      { ver: c.V('V14', 'appVersion'), ih: c.V('V14', 'inputs8'), rh: c.V('V14', 'results8'), gz: c.V('Q2', 'zoneGauge'), dz: c.V('Q2', 'zoneDay'), raw: c.V('V14', 'rawText'), date: c.V('V14', 'runDate') }, ['V14', 'Q2']);
    }
    function _S10(c) {
        var b = [], L = c.audit, rows = [];
        var entries = L ? L.entries.slice(-MAX_ROWS) : [];
        entries.forEach(function (e) {
            rows.push(['#' + e.seq, _str(e.at), _clip(e.who, 60) || '—', _str(e.kind), _str(e.target) || '—', _clip(e.reason, 120) || '—']);
        });
        if (!rows.length) rows.push(['—', '—', '—', '—', '—', 'No audit entries yet.']);
        var ovIds = _arr(c.an.overrides).map(function (o) { return o && o.id; }).filter(function (x) { return c.has(x); });
        b.push(_table('bu_tbl_audit', [{ text: 'Entry', cat: null }, { text: 'Time', cat: null }, { text: 'Who', cat: null }, { text: 'Kind', cat: null }, { text: 'Target', cat: null }, { text: 'Reason', cat: null }],
                      rows, ovIds.length ? ovIds.concat(['V14']) : ['V14']));
        var kv = [
            _row('App version', c.V('V14', 'appVersion'), ['V14']),
            _row('Run date', c.V('V14', 'runDate'), ['V14']),
            _row('Gauge time zone', c.V('Q2', 'zoneGauge'), ['Q2']),
            _row('Production-day zone', c.V('Q2', 'zoneDay'), ['Q2']),
            _row('Inputs hash', c.V('V14', 'inputsHash'), ['V14']),
            _row('Results hash', c.V('V14', 'resultsHash'), ['V14']),
            _row('Decisions hash', c.V('V14', 'decisionsHash'), ['V14'])
        ];
        if (L) kv.push(_row('Audit chain', _tv('{h} ({f} folded entries)', { h: c.V('V14', 'chainHash'), f: c.V('V14', 'auditFolded') }), ['V14']));
        b.push(_kv(kv));
        b.push(_reproBlock(c));
        return { id: 'S10', title: 'Audit trail and reproducibility', blocks: b };
    }
    function _S11(c, st) {
        var b = [_statusVerdict(c, st)], so = c.signoff;
        if (so && so.hash) {
            b.push(_kv([
                _row('Signed by', _tv('{n} ({r})', { n: c.V('V14', 'signer'), r: c.V('V14', 'role') }), ['V14']),
                _row('Signed on', c.V('V14', 'signedAt'), ['V14']),
                _row('Signature (first 16)', c.V('V14', 'sigHash16'), ['V14']),
                _row('Signature (SHA-256)', c.V('V14', 'sigHash'), ['V14']),
                _row('Decisions recorded', c.V('V14', 'decisions'), ['V14']),
                _row('App version at sign-off', c.V('V14', 'signedVersion'), ['V14'])
            ]));
            var cur = _currentVersion(c.an);
            if (so.appVersion && cur && so.appVersion !== cur) b.push(_verdict('warn', '⚠ Signed with {v}; re-run to verify.', { v: c.V('V14', 'signedVersion') }, ['V14']));
            b.push(_notes('Notes', 'The signature hash checks the integrity of the inputs, results and decisions; it does not authenticate the signer.', {}, ['V14']));
        } else {
            b.push(_kv([_obj(c.review) ? _row('Findings that need a decision', c.V('V14', 'nOpen'), ['V14']) : _row('Findings that need a decision', _tv('the review has not been run', {}), ['V14']),
                        _row('Statement', _tv('I have reviewed the analysis and the findings.', {}), ['V14'])]));
        }
        return { id: 'S11', title: 'Sign-off', blocks: b };
    }
    function _S12(c) {
        var b = [], cal = c.roots.cal;
        if (!cal) { b.push(_notes('Notes', 'The calibration table is not available in this build, so the labels are not calibrated.', {}, ['K1'])); return { id: 'S12', title: 'Confidence calibration', blocks: b }; }
        [['K1', 'ksTable', 'bu_tbl_cal_ks', 'k and S right (%)'], ['K2', 'table', 'bu_tbl_cal_hl', 'Fully right (%)']].forEach(function (k) {
            var rows = _arr(cal[k[1]]).slice(0, MAX_ROWS).filter(function (r) { return r && r.label; }).map(function (r) {
                return [r.label, c.V(k[0], r.label + '_n'), c.V(k[0], r.label + '_rate'), c.V(k[0], r.label + '_lo'), c.V(k[0], r.label + '_hi')];
            });
            if (rows.length) b.push(_table(k[2], [{ text: 'Label', cat: null }, { text: 'Cases', cat: null }, { text: k[3], cat: null }, { text: 'Interval low (%)', cat: null }, { text: 'Interval high (%)', cat: null }], rows, [k[0]]));
        });
        b.push(cal.calibrated ? _notes('Notes', 'Labels calibrated on {n} synthetic build-ups ({v}); the rates are out of sample, with Wilson intervals.', { n: c.V('K1', 'nBuildups'), v: c.V('K1', 'version') }, ['K1', 'K2'])
                              : _notes('Notes', 'Labels are not yet calibrated ({v}): every label is capped at medium (KC2).', { v: c.V('K1', 'version') }, ['K1', 'K2']));
        return { id: 'S12', title: 'Confidence calibration', blocks: b };
    }
    function _buildModel(an, review, audit, so, opts) {
        var c = _rc(an, review, audit, so, opts);
        var st = status(an, review, so);
        var sig = signature(an, review, so ? { name: so.name, role: so.role, at: so.at } : null);
        if (so && so.hash) sig.hash = so.hash;
        var wn = an.meta && typeof an.meta.wellName === 'string' && an.meta.wellName.trim() ? _clip(an.meta.wellName.trim().replace(/\b(null|undefined|NaN|Infinity)\b/g, '—'), 120) : 'Well';
        var model = {
            title: 'Build-up Surveillance',
            subtitle: wn + ' · ' + (st === 'SIGNED' ? 'signed off' : st === 'CHANGED' ? 'DRAFT (changed after sign-off)' : 'DRAFT'),
            status: st,
            sections: [_S1(c, st), _S2(c), _S3(c), _S4(c), _S5(c), _S6(c), _S7(c), _S8(c), _S9(c), _S10(c), _S11(c, st), _S12(c)],
            signature: { hash: sig.hash, inputsHash: sig.inputsHash || GENESIS, resultsHash: sig.resultsHash || GENESIS, decisionsHash: sig.decisionsHash || GENESIS, appVersion: sig.appVersion,
                         runAt: sig.runAt || (review && review.at) || new Date(0).toISOString() },
            reproducibility: _reproBlock(c)
        };
        return { model: model, c: c };
    }
    function report(analysis, review, audit, so, fmt, opts) {
        opts = opts || {};
        var an = _obj(analysis) ? analysis : {};
        var built = _buildModel(an, review, audit, so, opts);
        if (_obj(review)) {
            var ctx = { review: review, signoff: so, audit: _auditLog(audit), cal: built.c.roots.cal };
            var idx = built.c.idx;
            var fails = check(built.model, an, idx, ctx).failures;
            _arr(review.findings).forEach(function (f) {
                if (f.rule === 'V14') return;
                var r = check({ values: f.values }, an, idx, ctx);
                if (!r.ok) { f.check = { ok: false, failures: r.failures }; fails = fails.concat(r.failures); }
            });
            fails = fails.concat(_checkDerived(idx, an, ctx).failures);
            if (fails.length) {
                var n = _addV14(review, fails, idx);
                if (n) {
                    review.evidenceCheck = { ok: false, nChecked: (review.evidenceCheck && review.evidenceCheck.nChecked) || 0, nFailed: review.findings.filter(function (f) { return f.rule === 'V14'; }).length };
                    built = _buildModel(an, review, audit, so, opts);
                }
            }
        }
        return built.model;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 13. AI export (§7.5): de-identified text, no URL, no network; free text and dates only on opt-in
    // ─────────────────────────────────────────────────────────────────────
    var IMP_UNIT = { pressure: 'psi', permeability: 'md', permThickness: 'md·ft', length: 'ft', liquidRate: 'STB/d', gasRateSmall: 'Mscf/d', volume: 'STB', wbStorage: 'bbl/psi',
                     productivityIndex: 'STB/d/psi', gasPI: 'Mscf/d/psi', pressurePerDay: 'psi/d', viscosity: 'cp', compressibility: '1/psi' };
    function _impFmt(v, cat, dp) { return _fixed(v, dp) + (cat && IMP_UNIT[cat] ? ' ' + IMP_UNIT[cat] : ''); }
    function aiExport(analysis, review, opts) {
        opts = opts || {};
        var deid = opts.deidentify !== false, dates = opts.includeDates === true, free = opts.includeFreeText === true;
        var an = _obj(analysis) ? analysis : {};
        var idx = (opts.idx && opts.idx.items && _isArr(opts.idx.order)) ? opts.idx : _evidenceFor(an, opts);
        var roots = _roots(an, { review: review, signoff: opts.signoff, cal: opts.cal });
        var c = _ctxFor(an, idx, roots);
        var fmt = typeof opts.fmt === 'function' ? opts.fmt : _impFmt;
        var t0 = c.tests.length ? c.tests[0].tc_ms : null;
        var dayOf = function (s) {
            var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
            if (!m || !_isNum(t0)) return 'a date';
            var ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
            return 'day ' + _fixed((ms - Date.UTC(new Date(t0).getUTCFullYear(), new Date(t0).getUTCMonth(), new Date(t0).getUTCDate())) / 86400000, 0);
        };
        var undate = function (s) { return dates ? s : _str(s).replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?(?: [A-Za-z_/+−-]+)?)?/g, function (x) { return dayOf(x); }); };
        var V = function (id, name) { var v = c.V(id, name); return fmtValue(v, fmt); };
        var fillD = function (tpl, vals) {
            var vv = {};
            Object.keys(vals || {}).forEach(function (k) { var x = vals[k]; vv[k] = (x && typeof x.v === 'string') ? Object.assign({}, x, { v: undate(x.v) }) : x; });
            return undate(fill(tpl, vv, fmt));
        };
        var st = status(an, review, opts.signoff);
        var h = hashes(an, review);
        var out = [];
        out.push('Build-up surveillance: automated review export' + (deid ? ' (de-identified)' : ''));
        out.push('App version ' + (an.appVersion || '—') + '; report status ' + st + (st === 'SIGNED' ? ' (signed off)' : ' (not signed off)') + '; results hash ' + _str(h.resultsHash).slice(0, 8) + '.');
        var wellLabel = deid ? 'Well A' : ((an.meta && an.meta.wellName) || 'Well');
        out.push('Well: ' + wellLabel + '; fluid ' + _fluid(an) + '; ' + c.tests.length + ' tests (' + c.tests.filter(function (t) { return t.status === 'interpreted'; }).length + ' interpreted).');
        if (!deid && an.meta && an.meta.engineer) out.push('Engineer: ' + an.meta.engineer + '.');
        if (free && an.record && an.record.name) out.push('Gauge data: ' + an.record.name + '.');
        var w = an.well || {};
        out.push('Inputs: h ' + V('U2', 'h') + ', porosity ' + V('U2', 'phi') + ', viscosity ' + V('U2', 'mu') + ', B ' + V('U2', 'B') + ', ct ' + V('U2', 'ct') + ', rw ' + V('U2', 'rw') +
                 ', drainage radius ' + V('U2', 're_ft') + ', Pb ' + V('U2', 'Pb') + '; defaulted: ' + V('U2', 'defaulted') + '.');
        out.push('');
        out.push('Tests (' + (dates ? 'date' : 'day = days since the first test') + ' | shut-in h | rate | k | S ± S_err | C | model | ΔBIC gain | labels k/S·test | reason rules | used | status):');
        c.tests.forEach(function (t) {
            var id = t.id, r = t.result;
            var when = dates ? _str(t.date) : (_isNum(t0) ? 'day ' + _fixed((t.tc_ms - t0) / 86400000, 1) : '—');
            if (!r) { out.push(id + ' | ' + when + ' | ' + V(id + '·D5', 'dtEnd_h') + ' | ' + V(id + '·R1', 'Dq') + ' | — | — | — | — | — | — | — | ' + _usedText(t) + ' | ' + t.status); return; }
            var stText = t.status + (t.status !== 'interpreted' ? (free && t.statusReason ? ': ' + undate(t.statusReason) : (_arr(t.overrides).length ? ' (override ' + t.overrides.join(', ') + ')' : '')) : '');
            out.push([id, when, V(id + '·D5', 'dtEnd_h'), V(id + '·R1', 'Dq'), V(id + '·A2', 'k'), V(id + '·A2', 'S') + ' ± ' + V(id + '·U1', 'value'), V(id + '·A2', 'C'),
                      _str(r.chosen && r.chosen.label), c.idx.items[id + '·M4'] && c.idx.items[id + '·M4'].values.gainChosen ? V(id + '·M4', 'gainChosen') : '—',
                      r.confidence ? r.confidence.ks + '·' + r.confidence.headline : '—', V(id + '·K1', 'rules'), _usedText(t), stText].join(' | '));
        });
        out.push('');
        var tr = an.trend || {}, A = tr.alerts || {};
        out.push('Trend and alerts: baseline S ' + V('T1', 'S') + ' ± ' + V('T1', 'sigma') + ' (' + V('T1', 'tests') + '); delta alert ' + V('T2', 'status') +
                 (A.delta && A.delta.raisedAt ? ' (raised ' + A.delta.raisedAt + (A.delta.confirmedAt ? ', confirmed ' + A.delta.confirmedAt : '') + ')' : '') + ', threshold ' + V('T2', 'threshold') +
                 '; absolute alert ' + V('T3', 'status') + ' on ' + V('T3', 'basisText') + (A.absolute && A.absolute.raisedAt ? ' (raised ' + A.absolute.raisedAt + (A.absolute.confirmedAt ? ', confirmed ' + A.absolute.confirmedAt : '') + ')' : '') +
                 ', threshold ' + V('T3', 'threshold') + '.');
        if (tr.onset && _isNum(tr.onset.tauDays)) out.push('Onset about day ' + V('T4', 'tauDays') + ' (interval days ' + V('T4', 'lo') + ' to ' + V('T4', 'hi') + ', ' + V('T4', 'model') + ' model)' + (dates ? ', ' + V('T4', 'date') : '') + '.');
        out.push('k stability: CV ' + V('T9', 'cvPct') + ' % (limit ' + V('T9', 'cvLimPct') + ' %), reading ' + V('T9', 'reading') + '. Pressure trend: ' +
                 (tr.pTrend && tr.pTrend.assessable ? V('T10', 'slopePer30d') + ' per 30 days, depletion ' + V('T10', 'depletion') : 'not assessable') + '.');
        if (tr.pi && !tr.pi.guard) out.push('PI ratio ' + V('T8', 'ratioNow') + ' (baseline ' + V('T8', 'ratioBase') + '); rate at stake ' + V('T8', 'rateAtStake') + '; cumulative since the onset ' + V('T8', 'cumAtStake') + ' (pseudo-steady-state estimates).');
        out.push('');
        out.push('Review findings (decision codes only' + (free ? ', with notes' : '') + '):');
        var evAll = [];
        _arr(review && review.findings).forEach(function (f) {
            var dec = f.decision ? f.decision.d + (free && f.decision.note ? ' (note: ' + undate(f.decision.note) + ')' : '') + (!deid && f.decision.who ? ' by ' + f.decision.who : '') : 'open';
            out.push(f.id + ' ' + f.rule + ' ' + f.severity + ' [' + f.where + ']: ' + fillD(f.template, f.values) + ' Evidence ' + _arr(f.ev).join(', ') + '. Decision: ' + dec + '.');
            evAll = evAll.concat(_arr(f.ev));
        });
        if (!_arr(review && review.findings).length) out.push('none');
        if (free) {
            _arr(an.overrides).forEach(function (o) { if (o) out.push('Override ' + o.id + ' (' + o.kind + (o.target ? ' ' + o.target : '') + '): ' + undate(o.reason) + (!deid && o.who ? ' (' + o.who + ')' : '')); });
        }
        c.tests.forEach(function (t) { if (t.result) evAll.push(t.id + '·A2', t.id + '·U1', t.id + '·K1'); });
        out.push('');
        out.push('Evidence ids cited: ' + _uniq(evAll.concat(['T1', 'T2', 'T3'])).join(', ') + '.');
        out.push('');
        out.push('Please review this automated build-up surveillance analysis. Check it for consistency and physical plausibility (permeability, skin and its uncertainty, model choice, rates, alerts). ' +
                 'For each point, cite the evidence ids above. Say which extra data or tests would change the conclusions, and which findings you would accept or reject and why.');
        var text = out.join('\n');
        if (deid && an.meta) {
            [an.meta.wellName, an.meta.engineer].forEach(function (s) { if (typeof s === 'string' && s.trim().length >= 4 && s.trim() !== 'Well A') text = text.split(s.trim()).join(s === an.meta.wellName ? 'Well A' : 'the engineer'); });
        }
        if (!free) {
            var drop = [];
            if (an.record && an.record.name) drop.push(an.record.name);
            _arr(an.overrides).forEach(function (o) { if (o && o.reason) drop.push(o.reason); });
            _arr(review && review.findings).forEach(function (f) { if (f.decision && f.decision.note) drop.push(f.decision.note); });
            drop.forEach(function (s) { if (typeof s === 'string' && s.trim().length >= 12) text = text.split(s.trim()).join('[free text omitted]'); });
        }
        if (!dates) text = undate(text);
        return { text: text, filename: 'buildup-review-' + (_str(h.resultsHash).slice(0, 8) || '00000000') + '.txt' };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Public surface
    // ─────────────────────────────────────────────────────────────────────
    RV.version = 'r1';
    RV.evidence = _memoized(evidence);
    RV.run = _memoized(run);
    RV.check = _memoized(check);
    RV.recheck = _memoized(recheck);
    RV.ask = _memoized(ask);
    RV.report = _memoized(report);
    RV.sha256 = sha256;
    RV.hashes = _memoized(hashes);
    RV.signature = _memoized(signature);
    RV.status = _memoized(status);
    RV.canSign = canSign;
    RV.signoff = _memoized(signoff);
    RV.applyDecisions = applyDecisions;
    RV.aiExport = _memoized(aiExport);
    RV.audit = { GENESIS: GENESIS, MAX: AUDIT_MAX, entryHash: entryHash, append: auditAppend, verify: auditVerify, fold: auditFold, head: auditHead, decisions: _decisionsFromAudit };
    RV.fill = fill;
    RV.fmtValue = fmtValue;
    RV.blockText = blockText;
    RV.headText = headText;
    RV.render = render;
    RV.RULES = RULES;
    RV.RULE_ORDER = RULE_ORDER.slice();
    RV.INTENTS = INTENTS.map(function (it) { return { id: it.id, example: it.example, patterns: it.patterns.map(function (p) { return [p[0].source, p[1]]; }) }; });
    RV.FORMULAS = FORMULAS;
    RV.K_TEXT = K_TEXT;
    BU.review = RV;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var R = G.WTS_buildup && G.WTS_buildup.review;
    if (!R || typeof R.sha256 !== 'function') return;
    var checks = [];
    function chk(name, ok) { checks.push([name, !!ok]); }
    chk('sha256 empty', R.sha256('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    chk('sha256 abc', R.sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    chk('sha256 two blocks', R.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    chk('sensDS h 1.2', Math.abs(R.FORMULAS.sensDS('h', 1.2) - 0.09116) < 1e-4);
    chk('sensDkPct h 1.2', Math.abs(R.FORMULAS.sensDkPct('h', 1.2) + 16.667) < 1e-3);
    chk('dpSkin', Math.abs(R.FORMULAS.dpSkin(100, 2) - 173.72) < 1e-9);
    if (G.PRiSM_autoInterp && typeof G.PRiSM_autoInterp.hash16 === 'function') {
        var log = R.audit.append(null, { kind: 'run', who: 'test', at: '2026-01-01T00:00:00Z' });
        log = R.audit.append(log, { kind: 'override', who: 'test', at: '2026-01-01T00:01:00Z', target: 'B1', reason: 'self-test entry' });
        chk('audit chain', R.audit.verify(log).ok === true && log.entries[1].prevHash === log.entries[0].hash);
    }
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-buildup-review self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.WTS_buildup_review_selfTest = checks;
})();
