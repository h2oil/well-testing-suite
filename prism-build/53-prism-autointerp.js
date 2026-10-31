// =============================================================================
// PRiSM — 53-prism-autointerp.js  (Round 8)
// -----------------------------------------------------------------------------
// Automatic build-up interpretation engine, window.PRiSM_autoInterp. Shared by
// the Build-up Surveillance page (Round 9) and the PRiSM Skin-check card.
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §3.1 (interfaces) and §4.6.
//
// WP0 SKELETON (this revision): version, canon(obj, mode), hash16(str).
//   canon and hash16 are FROZEN from WP0 on. Every stored hash (inputs,
//   results and decisions hashes, the per-test inputHash, the audit chain)
//   depends on them bit for bit, so any change would mark every signed report
//   "changed after sign-off". WP1 adds the rest of §3.1 to this file and
//   leaves these two functions untouched.
//
// canon(obj, mode) → canonical JSON string
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
//     figures of an epoch-ms value would lose hours.
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
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[53-prism-autointerp self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.PRiSM_autoInterp_selfTest = checks;
})();
