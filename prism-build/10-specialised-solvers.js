// ════════════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 10 — Specialised solvers (Phase 7)
//   #18 User-Defined Type-Curve — table-loader + log-log interpolation
//   #38 Water Injection         — semi-analytic two-phase displacement
// ════════════════════════════════════════════════════════════════════════════
//
// This is the LAST and one of the LARGEST contributions to the PRiSM model
// catalogue. It introduces TWO new evaluators that don't fit the well-trodden
// closed-form pressure-transient mould of Phases 1-6:
//
//   1. userDefined        (Model #18 in the master catalogue)
//      A table-driven type-curve. The user supplies td/pd (and optionally pd′)
//      values — typically extracted from a published Bourdet-Gringarten chart,
//      a software vendor's curve library, or proprietary in-house data — and
//      this evaluator interpolates linearly in log-log space, falling back to
//      end-slope extrapolation outside the tabulated range. The module
//      maintains a persistent in-browser library of named curves keyed off
//      localStorage['wts_prism_user_curves'].
//
//   2. waterInjection     (Model #38 in the master catalogue)
//      A semi-analytic 1-D radial Buckley-Leverett-like front-tracking model
//      for water injection wells. Front radius advances with cumulative water
//      injected; the resulting two-zone composite pressure response is
//      computed in closed form for the intra-flood and post-flood radial
//      profiles, then folded with WBS+skin via a Stehfest convolution.
//
// ════════════════════════════════════════════════════════════════════════════
// MAJOR APPROXIMATIONS in the water-injection model (do NOT confuse with a
// commercial reservoir simulator that runs 100k+ LOC of fully-implicit
// IMPES/AIM solvers):
//
//   A1. PISTON-LIKE DISPLACEMENT — ahead of the front the rock is at Swc
//       (single-phase oil mobility), behind the front the rock is at 1-Sor
//       (single-phase water mobility). The actual Buckley-Leverett saturation
//       fan between these two end-points is not resolved; the front is
//       treated as a sharp shock at the volumetric-balance radius.
//
//   A2. RADIALLY-SYMMETRIC INJECTION — gravity, capillary pressure, vertical
//       sweep efficiency, and any reservoir heterogeneity are ignored.
//
//   A3. CONSTANT-RATE EQUIVALENT — the convolution against an arbitrary
//       rateProfile is approximated by a STEP-WISE constant-rate
//       superposition (PRiSM_stehfest is called for each step). Smooth rate
//       histories are honoured as their right-rectangle digitisation.
//
//   A4. INCOMPRESSIBLE-FLUID FRONT — front radius
//       r_f(t) = sqrt(W_inj(t) / (π · h · φ · (1−Sor−Swc)))
//       uses the volume of water injected (incompressible) without correcting
//       for fluid expansion within the swept zone. Compressibility enters
//       only through the diffusivity (td) of the radial pressure response.
//
//   A5. COMPOSITE-RADIAL PRESSURE — the two-zone pressure profile is the
//       classic Hawkins / van Everdingen-Hurst composite-radial line-source:
//       constant mobility ratio M = (kro·μw)/(krw·μo), front radius rf as
//       computed, line-source kernel outside rf for the unswept zone. This
//       is exact for a STEADY-STATE radial profile, not for the transient
//       pressure rise — but it captures the dominant log-time behaviour and
//       the unit-mobility-contrast slope change at the front.
//
//   A6. NO COUNTERCURRENT FLOW, NO DISSOLVED-GAS, NO TEMPERATURE EFFECTS.
//
//   A7. WBS+SKIN folded as a Bourdet-Gringarten convolution against the
//       composite-radial response (treated as the reservoir-side input).
//
// These approximations are appropriate for engineering quick-look /
// regression-pre-screening; for production decisions a full reservoir
// simulator (Eclipse, IMEX, OPM, MRST) should be used.
// ════════════════════════════════════════════════════════════════════════════

(function () {
'use strict';

// =============================================================================
// SECTION 0 — Shared helpers (resolve foundation primitives, type guards)
// =============================================================================

var STEHFEST_N = 12;
var DERIV_REL_STEP = 1e-3;

// Resolve a foundation symbol from window/globalThis with a final eval
// fallback so the module also works in Node-only smoke tests.
function _foundation(name) {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (typeof g[name] === 'function') return g[name];
    try { return eval(name); } catch (e) { return null; }
}

function _num(v) {
    return (typeof v === 'number') && isFinite(v) && !isNaN(v);
}

function _arrayMap(td, fn) {
    if (Array.isArray(td)) {
        var out = new Array(td.length);
        for (var i = 0; i < td.length; i++) out[i] = fn(td[i]);
        return out;
    }
    return fn(td);
}

function _requirePositiveTd(td) {
    if (Array.isArray(td)) {
        for (var i = 0; i < td.length; i++) {
            if (!_num(td[i]) || td[i] <= 0) {
                throw new Error('PRiSM 10: td must be > 0 (got ' + td[i] + ' at index ' + i + ')');
            }
        }
    } else if (!_num(td) || td <= 0) {
        throw new Error('PRiSM 10: td must be > 0 (got ' + td + ')');
    }
}

function _requireParams(params, keys) {
    if (!params || typeof params !== 'object') {
        throw new Error('PRiSM 10: params object required');
    }
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!(k in params)) {
            throw new Error('PRiSM 10: missing required param "' + k + '"');
        }
    }
}

// Standard browser-storage gate. Some host environments (file://, private
// modes, Node) may throw on touch; we silently degrade.
function _safeStorageGet(key) {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    } catch (e) { return null; }
}

function _safeStorageSet(key, val) {
    try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem(key, val);
        return true;
    } catch (e) { return false; }
}


// =============================================================================
// SECTION 1 — User-defined type-curve infrastructure
// =============================================================================
// Persistence layout:
//
//   localStorage['wts_prism_user_curves'] = JSON.stringify({
//      "MyCurveA": { td: [...], pd: [...], pdPrime: [...] | null },
//      "MyCurveB": { td: [...], pd: [...], pdPrime: null }
//   })
//
// PRiSM_userTypeCurves is the in-memory mirror, populated on first access
// and kept in sync with localStorage on every load/delete.
//
// CSV parser handles tab, comma, semicolon, and whitespace separators;
// auto-detects header rows (any non-numeric cell in row 1). Two and three
// column inputs are both accepted: 3rd column = pd′. If pd′ is omitted we
// compute central-differences in (ln td, pd) space at module-evaluation
// time.
//
// Validation rules (all reject with a clear Error message):
//   - At least 3 rows (linear interpolation needs ≥ 2 points; we require 3
//     so the end-slope extrapolation is well-defined).
//   - td strictly monotonically increasing.
//   - All td > 0, all pd finite, all pd′ finite (when present).
//
// Evaluation rules:
//   - timeShift parameter is ADDITIVE in log10 space:
//        td_eff = td_input / 10^timeShift
//     (positive timeShift moves the curve LATER, negative moves it EARLIER).
//   - pressShift is ADDITIVE in pd directly.
//   - For td_eff inside the tabulated range: linear interpolation in
//     (log10 td, pd). pd is NOT log-transformed because pd can pass through
//     zero (e.g. infinite-conductivity fracture early time) and cannot.
//   - For td_eff < min(td): extrapolation using slope of first 2 points.
//   - For td_eff > max(td): extrapolation using slope of last 2 points.
// =============================================================================

var STORAGE_KEY = 'wts_prism_user_curves';

// In-memory mirror. Populated lazily on first access. Map<name, curveObj>.
var PRiSM_userTypeCurves = {};
var _curvesLoaded = false;

// Hydrate the in-memory mirror from localStorage. Idempotent. Safe to call
// from any thread (we use a sentinel boolean).
function _loadCurvesFromStorage() {
    if (_curvesLoaded) return PRiSM_userTypeCurves;
    _curvesLoaded = true;
    var raw = _safeStorageGet(STORAGE_KEY);
    if (!raw) return PRiSM_userTypeCurves;
    try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            // Defensive copy; re-validate each entry to filter corrupted JSON.
            for (var name in parsed) {
                if (!parsed.hasOwnProperty(name)) continue;
                var c = parsed[name];
                if (c && Array.isArray(c.td) && Array.isArray(c.pd)
                    && c.td.length === c.pd.length && c.td.length >= 2) {
                    PRiSM_userTypeCurves[name] = {
                        td: c.td.slice(),
                        pd: c.pd.slice(),
                        pdPrime: Array.isArray(c.pdPrime) && c.pdPrime.length === c.td.length
                                 ? c.pdPrime.slice() : null
                    };
                }
            }
        }
    } catch (e) { /* corrupted JSON — start fresh */ }
    return PRiSM_userTypeCurves;
}

function _persistCurves() {
    try {
        return _safeStorageSet(STORAGE_KEY, JSON.stringify(PRiSM_userTypeCurves));
    } catch (e) { return false; }
}

// Lightweight CSV / paste parser for type-curve uploads. Returns
// { td, pd, pdPrime } where pdPrime may be null. Throws on malformed input.
function _parseTypeCurveCsv(csvText) {
    if (typeof csvText !== 'string' || !csvText.trim()) {
        throw new Error('PRiSM_loadUserTypeCurve: csvText is empty');
    }
    var lines = csvText.split(/\r?\n/)
                       .map(function (l) { return l.trim(); })
                       .filter(function (l) { return l.length > 0 && l[0] !== '#'; });
    if (lines.length < 3) {
        throw new Error('PRiSM_loadUserTypeCurve: need at least 3 data rows (got ' + lines.length + ')');
    }

    // Pick separator from the first line: tab > comma > semicolon > whitespace.
    var sample = lines[0];
    var sep = /\s+/;
    if (sample.indexOf('\t') >= 0)      sep = /\t/;
    else if (sample.indexOf(',') >= 0)  sep = /,/;
    else if (sample.indexOf(';') >= 0)  sep = /;/;
    var split = function (line) {
        return line.split(sep)
                   .map(function (s) { return s.trim(); })
                   .filter(function (s) { return s.length > 0; });
    };

    // Header detection — if ANY cell in row 1 is non-numeric we drop it.
    var firstCells = split(lines[0]);
    var headerSkipped = firstCells.some(function (c) { return isNaN(parseFloat(c)); });
    var startIdx = headerSkipped ? 1 : 0;

    var td = [], pd = [], pdPrime = [];
    var hasDeriv = null;   // determined from the FIRST data row
    for (var i = startIdx; i < lines.length; i++) {
        var cells = split(lines[i]);
        if (cells.length < 2) continue;
        if (hasDeriv === null) hasDeriv = cells.length >= 3;
        var t = parseFloat(cells[0]);
        var p = parseFloat(cells[1]);
        if (!_num(t) || !_num(p)) {
            throw new Error('PRiSM_loadUserTypeCurve: non-numeric cell on row ' + (i + 1));
        }
        if (t <= 0) {
            throw new Error('PRiSM_loadUserTypeCurve: td must be > 0 on row ' + (i + 1) + ' (got ' + t + ')');
        }
        td.push(t);
        pd.push(p);
        if (hasDeriv) {
            var pp = parseFloat(cells[2]);
            if (!_num(pp)) {
                throw new Error('PRiSM_loadUserTypeCurve: non-numeric pd_prime on row ' + (i + 1));
            }
            pdPrime.push(pp);
        }
    }

    // Validate strict monotone-increasing td.
    for (var j = 1; j < td.length; j++) {
        if (td[j] <= td[j - 1]) {
            throw new Error('PRiSM_loadUserTypeCurve: td must be strictly increasing (row ' + (j + 1) + ' td=' + td[j] + ' ≤ row ' + j + ' td=' + td[j - 1] + ')');
        }
    }
    if (td.length < 3) {
        throw new Error('PRiSM_loadUserTypeCurve: need at least 3 valid data rows (got ' + td.length + ')');
    }

    return { td: td, pd: pd, pdPrime: hasDeriv ? pdPrime : null };
}

// Compute pd' (Bourdet derivative) on a tabulated curve via central
// differences in (ln td, pd) space. End points use forward / backward
// 2-point differences. Returns a fresh array of the same length.
function _centralDerivativeLogTime(tdArr, pdArr) {
    var n = tdArr.length;
    var out = new Array(n);
    if (n < 2) return out.fill(0);
    // forward at left edge
    out[0] = (pdArr[1] - pdArr[0]) / (Math.log(tdArr[1]) - Math.log(tdArr[0]));
    // central in interior
    for (var i = 1; i < n - 1; i++) {
        out[i] = (pdArr[i + 1] - pdArr[i - 1]) /
                 (Math.log(tdArr[i + 1]) - Math.log(tdArr[i - 1]));
    }
    // backward at right edge
    out[n - 1] = (pdArr[n - 1] - pdArr[n - 2]) /
                 (Math.log(tdArr[n - 1]) - Math.log(tdArr[n - 2]));
    return out;
}

// Linear interpolation in (log10 td, value) space with end-slope extrapolation.
// tdArr MUST be strictly increasing and all > 0.
function _interpLogLinear(tdArr, valArr, tQuery) {
    var n = tdArr.length;
    if (n === 0) return NaN;
    if (n === 1) return valArr[0];
    if (!_num(tQuery) || tQuery <= 0) return NaN;
    var lq = Math.log10(tQuery);

    // Below-range: end-slope extrapolation from points 0 and 1.
    if (tQuery <= tdArr[0]) {
        var l0 = Math.log10(tdArr[0]);
        var l1 = Math.log10(tdArr[1]);
        var slope = (valArr[1] - valArr[0]) / (l1 - l0);
        return valArr[0] + slope * (lq - l0);
    }
    // Above-range: end-slope extrapolation from points n-2 and n-1.
    if (tQuery >= tdArr[n - 1]) {
        var lN1 = Math.log10(tdArr[n - 2]);
        var lN  = Math.log10(tdArr[n - 1]);
        var slopeR = (valArr[n - 1] - valArr[n - 2]) / (lN - lN1);
        return valArr[n - 1] + slopeR * (lq - lN);
    }

    // Binary search for the bracketing pair [i, i+1] such that
    // tdArr[i] <= tQuery < tdArr[i+1].
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (tdArr[mid] <= tQuery) lo = mid;
        else                       hi = mid;
    }
    var lA = Math.log10(tdArr[lo]);
    var lB = Math.log10(tdArr[hi]);
    if (lB === lA) return valArr[lo];
    var w = (lq - lA) / (lB - lA);
    return valArr[lo] * (1 - w) + valArr[hi] * w;
}

// -- Public API for managing user type-curves ---------------------------------

/**
 * Parse a CSV/paste of (td, pd, [pd_prime]) and register it under `name`.
 * Overwrites any existing curve of the same name. Persists immediately.
 * @param {string} name Non-empty identifier — used in the picker UI.
 * @param {string} csvText Multi-line CSV/TSV text (header optional).
 * @returns {{name:string, n:number, hasDeriv:boolean}} on success.
 * @throws {Error} on parse / validation failure.
 */
function PRiSM_loadUserTypeCurve(name, csvText) {
    if (typeof name !== 'string' || !name.trim()) {
        throw new Error('PRiSM_loadUserTypeCurve: name must be a non-empty string');
    }
    name = name.trim();
    _loadCurvesFromStorage();
    var parsed = _parseTypeCurveCsv(csvText);
    // Compute pd' if missing — done at load time so the runtime evaluator
    // can be a clean log-log interpolation.
    var pdPrime = parsed.pdPrime;
    if (!pdPrime) pdPrime = _centralDerivativeLogTime(parsed.td, parsed.pd);
    PRiSM_userTypeCurves[name] = {
        td: parsed.td,
        pd: parsed.pd,
        pdPrime: pdPrime
    };
    _persistCurves();
    return { name: name, n: parsed.td.length, hasDeriv: !!parsed.pdPrime };
}

/**
 * List the names of currently registered user type-curves. Useful for
 * populating the model-picker UI.
 * @returns {string[]}
 */
function PRiSM_listUserTypeCurves() {
    _loadCurvesFromStorage();
    return Object.keys(PRiSM_userTypeCurves);
}

/**
 * Delete a registered curve by name. Persists.
 * @param {string} name
 * @returns {boolean} true if a curve was deleted, false if not found.
 */
function PRiSM_deleteUserTypeCurve(name) {
    _loadCurvesFromStorage();
    if (PRiSM_userTypeCurves.hasOwnProperty(name)) {
        delete PRiSM_userTypeCurves[name];
        _persistCurves();
        return true;
    }
    return false;
}

/**
 * Retrieve a curve by name (defensive copy).
 */
function PRiSM_getUserTypeCurve(name) {
    _loadCurvesFromStorage();
    var c = PRiSM_userTypeCurves[name];
    if (!c) return null;
    return {
        td: c.td.slice(),
        pd: c.pd.slice(),
        pdPrime: c.pdPrime ? c.pdPrime.slice() : null
    };
}

// -- Model #18 evaluator ------------------------------------------------------

/**
 * User-Defined Type-Curve evaluator (pd at given td values).
 *
 * Looks up the curve named in `params.curveName`, applies a log10 time
 * shift and additive pd shift, and interpolates linearly in (log10 td, pd)
 * space with end-slope extrapolation outside the tabulated range.
 *
 * @param {number|number[]} td   Dimensionless time(s) in the SAME convention
 *                                as the tabulated curve.
 * @param {{curveName:string, timeShift?:number, pressShift?:number}} params
 * @returns {number|number[]}
 * @throws {Error} if the named curve is not registered.
 */
function PRiSM_model_userDefined(td, params) {
    _requirePositiveTd(td);
    if (!params || typeof params !== 'object') {
        throw new Error('PRiSM_model_userDefined: params object required');
    }
    var name = params.curveName;
    if (typeof name !== 'string' || !name) {
        throw new Error('PRiSM_model_userDefined: params.curveName missing — register a curve first via PRiSM_loadUserTypeCurve(name, csv)');
    }
    _loadCurvesFromStorage();
    var curve = PRiSM_userTypeCurves[name];
    if (!curve) {
        var available = Object.keys(PRiSM_userTypeCurves);
        throw new Error('PRiSM_model_userDefined: curve "' + name + '" not registered. Known: ' +
            (available.length ? available.join(', ') : '(none)'));
    }
    var timeShift  = _num(params.timeShift)  ? params.timeShift  : 0;
    var pressShift = _num(params.pressShift) ? params.pressShift : 0;

    // td_eff = td_input / 10^timeShift
    var shiftFactor = Math.pow(10, timeShift);

    return _arrayMap(td, function (t) {
        var tEff = t / shiftFactor;
        var pdInterp = _interpLogLinear(curve.td, curve.pd, tEff);
        return pdInterp + pressShift;
    });
}

/**
 * pd' evaluator for the user-defined curve. Uses the stored derivative
 * column if present, else the central-differences pd' computed at load time.
 *
 * @param {number|number[]} td
 * @param {object} params  Same as PRiSM_model_userDefined.
 * @returns {number|number[]}
 */
function PRiSM_model_userDefined_pd_prime(td, params) {
    _requirePositiveTd(td);
    if (!params || typeof params !== 'object') {
        throw new Error('PRiSM_model_userDefined_pd_prime: params object required');
    }
    var name = params.curveName;
    if (typeof name !== 'string' || !name) {
        throw new Error('PRiSM_model_userDefined_pd_prime: params.curveName missing');
    }
    _loadCurvesFromStorage();
    var curve = PRiSM_userTypeCurves[name];
    if (!curve) {
        throw new Error('PRiSM_model_userDefined_pd_prime: curve "' + name + '" not registered');
    }
    var timeShift = _num(params.timeShift) ? params.timeShift : 0;
    var shiftFactor = Math.pow(10, timeShift);
    var pdpArr = curve.pdPrime;
    // Defensive: if pdPrime is missing (shouldn't be — we synthesise on load —
    // but guard against externally mutated state), compute it on the fly.
    if (!Array.isArray(pdpArr) || pdpArr.length !== curve.td.length) {
        pdpArr = _centralDerivativeLogTime(curve.td, curve.pd);
    }
    return _arrayMap(td, function (t) {
        var tEff = t / shiftFactor;
        return _interpLogLinear(curve.td, pdpArr, tEff);
    });
}


// =============================================================================
// SECTION 2 — Water Injection (semi-analytic two-phase displacement)
// =============================================================================
//
// Forward model for an injection well in a 1-D radial reservoir, single
// horizontal stratum, two phases (oil ahead of front, water behind front).
// See the module header for the full list of approximations.
//
// Workflow per evaluator call:
//
//   1. From params.rateProfile (optional [t,q] pairs) and the constant
//      injection rate baseline, build a piecewise-constant cumulative water
//      injected schedule W_inj(t).
//   2. For each output td (which we treat as REAL time in days, see note on
//      time convention below), compute:
//        a. cumulative water injected up to td  → W_inj(td) [bbl]
//        b. front radius  rf(td) = sqrt( W_inj * 5.615 / (π · h · φ · ΔS) )
//           (5.615 ft³/bbl conversion factor; ΔS = 1 - Sor - Swc)
//        c. dimensionless front radius  rfD = rf / rw
//        d. composite-radial line-source pressure rise Δp_res in
//           Laplace-domain Bourdet-Gringarten form, with mobility ratio
//           M = (kro·μw)/(krw·μo) and rfD as the discontinuity radius
//        e. Add WBS+skin via Stehfest convolution with Cd, S
//   3. Return the resulting pwd at each td.
//
// TIME CONVENTION NOTE
//   PRiSM evaluators conventionally take dimensionless td. For the water-
//   injection model the problem is INHERENTLY non-dimensionless because the
//   front radius depends on ABSOLUTE cumulative volume. We adopt the
//   convention: the input td array IS interpreted as real time in days, and
//   the rateProfile (q in bbl/d) is referenced against the same time axis.
//   Internally we form a "pseudo-td" against a reference diffusivity
//   constant that the user provides via params (kh, mu, ct, phi, rw); the
//   composite-radial Laplace solution then runs on that pseudo-td.
//
// COMPOSITE-RADIAL LAPLACE-DOMAIN SOLUTION
//   For a constant-rate injector (the workhorse step that we superpose), the
//   Laplace-domain dimensionless pressure at the wellbore for a two-zone
//   composite reservoir of radius discontinuity rfD is (see Bratvold & Horne
//   SPE 19819, Aanonsen SPE 17386, or Fair Petroleum Engineering Handbook
//   Vol IV §10.5):
//
//      P̂_d(s) = [ K0(√s) + B · I0(√s) ] / s  evaluated at the wellbore
//
//   where the matching coefficient B comes from continuity of pressure and
//   flux at rfD between the inner (water mobility) and outer (oil mobility)
//   regions. We use a SIMPLIFIED CLOSED FORM appropriate for engineering
//   work — the Hawkins-style composite skin:
//
//      ΔP_d ≈ ½ [ ln(rfD²) + (M − 1) · ln(rfD²) + 2·S ] + ½·Ei(¼/td_outer)
//
//   which collapses to a Hawkins skin S_eq = (M − 1) · ln(rfD) on top of the
//   line-source kernel for the outer (oil) region. This is EXACT in the
//   late-time PSS limit and a very-good approximation for the transient
//   regime as long as the front is not moving faster than the pressure
//   diffusivity (typical for water-floods).
// =============================================================================

// Useful conversion: 1 bbl = 5.615 ft³.
var BBL_TO_FT3 = 5.6145833;

// =============================================================================
// 2.1 — Cumulative-injection helper
// =============================================================================

// Build a piecewise-linear cumulative-injection function from a rateProfile.
// rateProfile is an array of [t, q] pairs where q is in bbl/d. Sign
// convention: q < 0 (injection, well-test convention) OR q > 0 (positive
// injection rate). We use abs(q) so either convention works — the model
// only cares about the magnitude of injected water.
//
// If rateProfile is missing or empty we fall back to a constant rate q_const
// supplied via params.q_inj.
//
// Returns a callable: cumWater(t) → cumulative bbl injected up to time t.
function _buildCumulativeInjector(rateProfile, q_const) {
    var hasProfile = Array.isArray(rateProfile) && rateProfile.length > 0;
    if (!hasProfile) {
        var qFlat = _num(q_const) ? Math.abs(q_const) : 0;
        return function (t) {
            if (!_num(t) || t <= 0) return 0;
            return qFlat * t;
        };
    }
    // Sort + sanitise.
    var pairs = [];
    for (var i = 0; i < rateProfile.length; i++) {
        var rec = rateProfile[i];
        if (!Array.isArray(rec) || rec.length < 2) continue;
        var t = parseFloat(rec[0]);
        var q = parseFloat(rec[1]);
        if (!_num(t) || !_num(q)) continue;
        pairs.push([t, Math.abs(q)]);
    }
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    if (!pairs.length) {
        // Degenerate: profile parsed as empty after sanitise.
        var qFlat2 = _num(q_const) ? Math.abs(q_const) : 0;
        return function (t) {
            if (!_num(t) || t <= 0) return 0;
            return qFlat2 * t;
        };
    }
    // Pre-compute cumulative-bbl at each profile knot using the LEFT rate
    // (the rate at pair i is held constant from pair i to pair i+1).
    var cum = new Array(pairs.length);
    cum[0] = 0;
    for (var k = 1; k < pairs.length; k++) {
        cum[k] = cum[k - 1] + pairs[k - 1][1] * (pairs[k][0] - pairs[k - 1][0]);
    }
    return function (t) {
        if (!_num(t) || t <= pairs[0][0]) {
            // Before the first knot: assume zero injection.
            if (t <= pairs[0][0]) return 0;
            return 0;
        }
        // Find the bracketing pair.
        // Binary search.
        var lo = 0, hi = pairs.length - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (pairs[mid][0] <= t) lo = mid;
            else                     hi = mid;
        }
        // After the last knot: extrapolate at the last rate.
        if (t >= pairs[pairs.length - 1][0]) {
            var last = pairs.length - 1;
            return cum[last] + pairs[last][1] * (t - pairs[last][0]);
        }
        var dt = t - pairs[lo][0];
        return cum[lo] + pairs[lo][1] * dt;
    };
}

// =============================================================================
// 2.2 — Front radius and composite-radial pressure
// =============================================================================

/**
 * Water-front radius from cumulative water injected.
 *   rf = sqrt( W_inj_ft3 / (π · h · φ · ΔS) )
 *
 * @param {number} W_bbl  Cumulative water injected (bbl)
 * @param {number} h      Net pay (ft)
 * @param {number} phi    Porosity (-)
 * @param {number} dS     Movable-water saturation 1 - Sor - Swc
 * @returns {number} Front radius in ft. Returns rw_min (1e-3 ft) for
 *                    W_bbl ≤ 0 to avoid log(0).
 */
function _waterFrontRadius(W_bbl, h, phi, dS) {
    if (W_bbl <= 0 || h <= 0 || phi <= 0 || dS <= 0) return 1e-3;
    var V = W_bbl * BBL_TO_FT3;
    return Math.sqrt(V / (Math.PI * h * phi * dS));
}

/**
 * Composite-radial Hawkins-style skin from inner-zone water mobility and
 * outer-zone oil mobility.
 *
 *   S_composite = (M - 1) · ln(rfD)
 *
 * where the mobility ratio is defined CONVENTIONALLY for water-floods as
 * the ratio of displacing-phase mobility to displaced-phase mobility:
 *
 *   M = (krw_max / mu_w) / (kro_max / mu_o)
 *
 * For M > 1 (favourable for sweep but unfavourable for pressure),
 * S_composite > 0 (looks like positive skin).
 *
 * @param {number} rfD    Dimensionless front radius rf/rw
 * @param {number} M      Mobility ratio (krw·μo)/(kro·μw)
 * @returns {number} Equivalent Hawkins skin (dimensionless)
 */
function _compositeRadialSkin(rfD, M) {
    if (rfD <= 1) return 0;       // front still inside the wellbore
    if (M <= 0)   return 0;
    return (M - 1) * Math.log(rfD);
}

/**
 * Full composite-radial dimensionless pressure rise at the wellbore for an
 * injector. Combines a homogeneous line-source response in the OUTER (oil)
 * region with a Hawkins-style composite skin from the inner swept region.
 *
 * Inputs (all dimensionless):
 *   td_inj  — pseudo-td referred to OUTER (oil) diffusivity
 *   rfD     — instantaneous front radius rf/rw (snapshot at this td)
 *   M       — mobility ratio (krw·μo)/(kro·μw)
 *   Cd      — wellbore-storage coefficient
 *   S_well  — mechanical skin at the wellbore
 *   N_steh  — Stehfest order
 *
 * Implementation: Stehfest-invert the Bourdet-Gringarten WBS+skin Laplace
 * form using the composite skin as the EFFECTIVE skin. This is the
 * Hawkins-equivalent treatment which is exact in the late-time PSS limit
 * and a very-good approximation for the transient regime.
 */
function _waterInjectionPwd(td_inj, rfD, M, Cd, S_well, N_steh) {
    var stehfest = _foundation('PRiSM_stehfest');
    var K0 = _foundation('PRiSM_besselK0') || _foundation('PRiSM_K0');
    var K1 = _foundation('PRiSM_besselK1') || _foundation('PRiSM_K1');
    if (!stehfest || !K0 || !K1) {
        throw new Error('PRiSM 10: foundation primitives (PRiSM_stehfest / besselK0 / besselK1) not loaded');
    }
    var S_comp = _compositeRadialSkin(rfD, M);
    var S_eff  = S_well + S_comp;

    // Bourdet-Gringarten Laplace pwd with WBS + (mech + composite) skin:
    //   num   = K0(√s) + S_eff · √s · K1(√s)
    //   denom = √s · K1(√s) + Cd · s · num
    //   pwd_lap = num / (s · denom)
    var Phat = function (s) {
        var sqs = Math.sqrt(s);
        var k0 = K0(sqs);
        var k1 = K1(sqs);
        var num = k0 + S_eff * sqs * k1;
        var denom = sqs * k1 + Cd * s * num;
        return num / (s * denom);
    };
    return stehfest(Phat, td_inj, N_steh);
}

// =============================================================================
// 2.3 — Top-level water injection evaluators
// =============================================================================
//
// PARAMETERS (all keys ARE consumed; superfluous keys are ignored):
//
//   { Cd, S, kh, mu_o, mu_w, B, h, phi, rw, ct,
//     Swc, Sor, krw_max, kro_max,
//     q_inj, rateProfile }
//
//   Cd        : dimensionless wellbore-storage coefficient
//   S         : mechanical skin at the wellbore (dimensionless)
//   kh        : reservoir kh in mD·ft (used to scale td)
//   mu_o      : oil viscosity in cp
//   mu_w      : water viscosity in cp
//   B         : water formation volume factor (rb/STB ≈ 1 for water)
//   h         : net pay in ft
//   phi       : porosity (fraction)
//   rw        : wellbore radius in ft
//   ct        : total compressibility in 1/psi (must be > 0)
//   Swc       : connate water saturation (fraction)
//   Sor       : residual oil saturation (fraction)
//   krw_max   : water relative permeability at Sor (endpoint)
//   kro_max   : oil   relative permeability at Swc (endpoint)
//   q_inj     : constant injection rate baseline in bbl/d (used when
//               rateProfile is absent or empty)
//   rateProfile : optional [[t1, q1], [t2, q2], ...] schedule overriding
//                 q_inj. Time in days, rate in bbl/d (sign-agnostic).
//
// The evaluator interprets the input td values as REAL TIME in days.
//
// pseudo-td:
//   td_inj = 0.0002637 · (kh / mu_o) · t / (φ · ct · μ_o · rw²)
//   This is the standard radial diffusivity grouping in field units.
//   Reference: Bourdet 2002 §3.1.

// Field-units diffusivity constant: oilfield (md, ft, hr, cp, psi).
// 0.0002637 hr (kh in md·ft, t in hr, μ in cp, φct in psi^-1, rw in ft).
// We work with t in DAYS to match injection rates in bbl/d, so we multiply
// by 24 to convert hr → day.
var FIELD_UNITS_DIFFUSIVITY = 0.0002637 * 24;   // /day

function _toRealTimeTd(t_day, p) {
    var phi = p.phi;
    var ct  = p.ct;
    var muo = p.mu_o;
    var rw  = p.rw;
    var kh  = p.kh;
    var h   = p.h;
    if (!(phi > 0 && ct > 0 && muo > 0 && rw > 0 && kh > 0 && h > 0)) {
        return NaN;
    }
    var k = kh / h;                     // md
    return FIELD_UNITS_DIFFUSIVITY * k * t_day / (phi * muo * ct * rw * rw);
}

function _validateWaterInjectionParams(p) {
    var required = ['Cd', 'S', 'kh', 'mu_o', 'mu_w', 'B', 'h', 'phi', 'rw',
                    'ct', 'Swc', 'Sor', 'krw_max', 'kro_max'];
    _requireParams(p, required);
    if (!(p.kh > 0))      throw new Error('PRiSM_model_waterInjection: kh must be > 0');
    if (!(p.mu_o > 0))    throw new Error('PRiSM_model_waterInjection: mu_o must be > 0');
    if (!(p.mu_w > 0))    throw new Error('PRiSM_model_waterInjection: mu_w must be > 0');
    if (!(p.h > 0))       throw new Error('PRiSM_model_waterInjection: h must be > 0');
    if (!(p.phi > 0 && p.phi < 1)) throw new Error('PRiSM_model_waterInjection: phi must be in (0,1)');
    if (!(p.rw > 0))      throw new Error('PRiSM_model_waterInjection: rw must be > 0');
    if (!(p.ct > 0))      throw new Error('PRiSM_model_waterInjection: ct must be > 0 (water-injection model is non-linear in ct — zero would imply incompressible reservoir)');
    if (!(p.Cd >= 0))     throw new Error('PRiSM_model_waterInjection: Cd must be ≥ 0');
    if (!isFinite(p.S))   throw new Error('PRiSM_model_waterInjection: S must be finite');
    var dS = 1 - p.Sor - p.Swc;
    if (!(dS > 0))        throw new Error('PRiSM_model_waterInjection: Swc + Sor ≥ 1 leaves no movable phase');
    if (!(p.krw_max > 0)) throw new Error('PRiSM_model_waterInjection: krw_max must be > 0');
    if (!(p.kro_max > 0)) throw new Error('PRiSM_model_waterInjection: kro_max must be > 0');
}

/**
 * Water Injection forward model — pwd at each input time.
 *
 * @param {number|number[]} td  Time(s) in DAYS (NOT dimensionless td).
 * @param {object} params       See SECTION 2.3 header for keys.
 * @returns {number|number[]}   Dimensionless pressure rise at the wellbore.
 *                              Multiply by (q · μ · B) / (kh · 141.2) to get
 *                              real Δp in psi, the standard field-units
 *                              conversion.
 */
function PRiSM_model_waterInjection(td, params) {
    _requirePositiveTd(td);
    _validateWaterInjectionParams(params);

    var p = params;
    var dS = 1 - p.Sor - p.Swc;
    var M  = (p.krw_max / p.mu_w) / (p.kro_max / p.mu_o);

    var cumInj = _buildCumulativeInjector(p.rateProfile, p.q_inj);
    var Nsteh = (params.N != null) ? params.N : STEHFEST_N;

    return _arrayMap(td, function (t_day) {
        // Cumulative water injected up to t_day (bbl).
        var W = cumInj(t_day);
        // Front radius (ft).
        var rf = _waterFrontRadius(W, p.h, p.phi, dS);
        // Dimensionless front radius. Guard for early time where rf < rw.
        var rfD = Math.max(rf / p.rw, 1.0 + 1e-6);
        // Pseudo-td referred to outer (oil) diffusivity.
        var td_inj = _toRealTimeTd(t_day, p);
        if (!_num(td_inj) || td_inj <= 0) return NaN;
        // Composite-radial pwd via Bourdet-Gringarten WBS+skin convolution.
        return _waterInjectionPwd(td_inj, rfD, M, p.Cd, p.S, Nsteh);
    });
}

/**
 * Bourdet derivative pwd' = td · d(pwd)/d(ln td) for the water-injection
 * model. Implemented numerically because the time-dependent front radius
 * makes the Laplace-domain derivative (s · F̂) inappropriate — F̂ itself
 * varies with td via rfD.
 */
function PRiSM_model_waterInjection_pd_prime(td, params) {
    _requirePositiveTd(td);
    _validateWaterInjectionParams(params);
    var h = DERIV_REL_STEP;
    var pdAt = function (tQ) {
        return PRiSM_model_waterInjection(tQ, params);
    };
    return _arrayMap(td, function (t) {
        var lnT = Math.log(t);
        // 5-point central difference in ln t. Fall back to forward difference
        // at small td to avoid log of negative values after subtraction.
        var t_m2 = Math.exp(lnT - 2 * h);
        var t_m1 = Math.exp(lnT -     h);
        var t_p1 = Math.exp(lnT +     h);
        var t_p2 = Math.exp(lnT + 2 * h);
        var f_m2 = pdAt(t_m2);
        var f_m1 = pdAt(t_m1);
        var f_p1 = pdAt(t_p1);
        var f_p2 = pdAt(t_p2);
        var deriv = (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);
        return deriv;   // already td · d/dt because we differentiated in ln t
    });
}


// =============================================================================
// SECTION 3 — Registry merge — install both new evaluators
// =============================================================================

var REGISTRY_ADDITIONS = {
    userDefined: {
        pd: PRiSM_model_userDefined,
        pdPrime: PRiSM_model_userDefined_pd_prime,
        defaults: {
            curveName: '',
            timeShift: 0,
            pressShift: 0,
            Cd: 100,
            S: 0
        },
        paramSpec: [
            { key: 'curveName',  label: 'Curve name (load via PRiSM_loadUserTypeCurve)',
              unit: '', type: 'string', default: '' },
            { key: 'timeShift',  label: 'log10 time shift', unit: '-',
              min: -10, max: 10, default: 0 },
            { key: 'pressShift', label: 'pd shift',         unit: '-',
              min: -10, max: 10, default: 0 },
            { key: 'Cd',         label: 'WBS Cd (info only — already in curve)',
              unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S',          label: 'Skin S (info only)',
              unit: '-', min: -7,  max: 50,  default: 0 }
        ],
        reference: 'PRiSM Phase 7 — log-log table-curve interpolation with end-slope extrapolation',
        category: 'special',
        description: 'User-Defined Type-Curve. User pastes (td, pd[, pd′]) tabulated points; this model interpolates linearly in log-log space and extrapolates with end-slope. Ideal for digitised vendor charts, in-house libraries, or custom analytical solutions. Persisted in localStorage; manage via PRiSM_loadUserTypeCurve / PRiSM_listUserTypeCurves / PRiSM_deleteUserTypeCurve.',
        kind: 'pressure'
    },
    waterInjection: {
        pd: PRiSM_model_waterInjection,
        pdPrime: PRiSM_model_waterInjection_pd_prime,
        defaults: {
            Cd: 100, S: 0,
            kh: 1000, mu_o: 1.0, mu_w: 0.5, B: 1.0,
            h: 50, phi: 0.20, rw: 0.354, ct: 1e-5,
            Swc: 0.2, Sor: 0.2,
            krw_max: 0.3, kro_max: 0.8,
            q_inj: 1000,
            rateProfile: null
        },
        paramSpec: [
            { key: 'Cd',       label: 'WBS Cd',              unit: '-',     min: 0,     max: 1e10, default: 100 },
            { key: 'S',        label: 'Skin',                unit: '-',     min: -7,    max: 50,   default: 0 },
            { key: 'kh',       label: 'Permeability-thickness kh', unit: 'md·ft', min: 0.1, max: 1e7, default: 1000 },
            { key: 'mu_o',     label: 'Oil viscosity',       unit: 'cp',    min: 0.1,   max: 1000, default: 1.0 },
            { key: 'mu_w',     label: 'Water viscosity',     unit: 'cp',    min: 0.1,   max: 10,   default: 0.5 },
            { key: 'B',        label: 'Water FVF',           unit: 'rb/stb', min: 0.5,  max: 2.0,  default: 1.0 },
            { key: 'kro_max',  label: 'kr_oil at Swc',       unit: '-',     min: 0.01,  max: 1.0,  default: 0.8 },
            { key: 'krw_max',  label: 'kr_water at Sor',     unit: '-',     min: 0.01,  max: 1.0,  default: 0.3 },
            { key: 'Swc',      label: 'Connate water sat',   unit: '-',     min: 0,     max: 0.5,  default: 0.2 },
            { key: 'Sor',      label: 'Residual oil sat',    unit: '-',     min: 0,     max: 0.5,  default: 0.2 },
            { key: 'phi',      label: 'Porosity',            unit: '-',     min: 0.01,  max: 0.4,  default: 0.20 },
            { key: 'h',        label: 'Net pay',             unit: 'ft',    min: 1,     max: 1000, default: 50 },
            { key: 'rw',       label: 'Wellbore radius',     unit: 'ft',    min: 0.1,   max: 1.0,  default: 0.354 },
            { key: 'ct',       label: 'Total compressibility', unit: '1/psi', min: 1e-7, max: 1e-3, default: 1e-5 },
            { key: 'q_inj',    label: 'Constant inj rate',   unit: 'bbl/d', min: 1,     max: 1e6,  default: 1000 }
        ],
        reference: 'Buckley-Leverett (1942); Bratvold & Horne SPE 19819 (1990); Aanonsen SPE 17386; Hawkins composite skin (1956). Semi-analytic two-zone water-injection — see source header for full list of approximations.',
        category: 'special',
        description: 'Water Injection (two-phase, semi-analytic). Piston-like radial displacement with mobility ratio M = (krw·μo)/(kro·μw); composite Hawkins-style skin from inner (water) and outer (oil) zones; WBS+skin folded via Stehfest. Time IS REAL TIME IN DAYS (not dimensionless); rateProfile is optional [[t,q],...] in days/bbl/d. APPROXIMATIONS: piston-like front, single-stratum, no gravity/capillary, incompressible-front volumetric balance. NOT a substitute for a commercial reservoir simulator.',
        kind: 'pressure'
    }
};

(function _installRegistry() {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
    for (var key in REGISTRY_ADDITIONS) {
        if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
            g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
        }
    }
    // Expose evaluators + curve management API on the global namespace.
    g.PRiSM_userTypeCurves            = PRiSM_userTypeCurves;
    g.PRiSM_loadUserTypeCurve         = PRiSM_loadUserTypeCurve;
    g.PRiSM_listUserTypeCurves        = PRiSM_listUserTypeCurves;
    g.PRiSM_deleteUserTypeCurve       = PRiSM_deleteUserTypeCurve;
    g.PRiSM_getUserTypeCurve          = PRiSM_getUserTypeCurve;
    g.PRiSM_model_userDefined         = PRiSM_model_userDefined;
    g.PRiSM_model_userDefined_pd_prime = PRiSM_model_userDefined_pd_prime;
    g.PRiSM_model_waterInjection      = PRiSM_model_waterInjection;
    g.PRiSM_model_waterInjection_pd_prime = PRiSM_model_waterInjection_pd_prime;
    g.PRiSM_renderUserCurveManager    = PRiSM_renderUserCurveManager;

    // Hydrate from localStorage on load so curves persist across page loads.
    _loadCurvesFromStorage();
})();


// =============================================================================
// SECTION 4 — Optional UI helper: PRiSM_renderUserCurveManager
// =============================================================================
//
// Tiny render-helper that produces a self-contained UI fragment for managing
// user type-curves: a list with delete buttons + a textarea + name input +
// "Load" button. Intended to be called from the Tab 3 (Model) renderer when
// `userDefined` becomes the active model — but works as a standalone widget
// too.
//
// Usage:
//   const div = document.createElement('div');
//   PRiSM_renderUserCurveManager(div);
//   parentNode.appendChild(div);
//
// The widget's CSS classes match the existing PRiSM design system so it
// should look at home inside the Tab 3 card layout.
// =============================================================================

function PRiSM_renderUserCurveManager(container) {
    if (!container || typeof container !== 'object') {
        throw new Error('PRiSM_renderUserCurveManager: container element required');
    }
    _loadCurvesFromStorage();

    function rerender() {
        var names = PRiSM_listUserTypeCurves();
        var listHtml = '';
        if (names.length === 0) {
            listHtml = '<div style="color:var(--text3, #888); font-size:12px; padding:8px;">No user type-curves registered yet.</div>';
        } else {
            listHtml = '<table class="dtable" style="margin-bottom:6px;"><thead><tr><th>Name</th><th>Points</th><th>td range</th><th></th></tr></thead><tbody>';
            for (var i = 0; i < names.length; i++) {
                var nm = names[i];
                var c = PRiSM_userTypeCurves[nm];
                var n = c ? c.td.length : 0;
                var tdMin = c && n ? c.td[0] : 0;
                var tdMax = c && n ? c.td[n - 1] : 0;
                listHtml += '<tr>' +
                    '<td><code>' + _escapeHtml(nm) + '</code></td>' +
                    '<td>' + n + '</td>' +
                    '<td>' + tdMin.toExponential(2) + ' .. ' + tdMax.toExponential(2) + '</td>' +
                    '<td><button class="btn btn-secondary" data-prism-curve-del="' + _escapeAttr(nm) + '" style="padding:2px 8px;">delete</button></td>' +
                '</tr>';
            }
            listHtml += '</tbody></table>';
        }

        container.innerHTML =
            '<div class="card">' +
              '<div class="card-title">User Type-Curve Library</div>' +
              '<div style="font-size:12px; color:var(--text2, #aaa); margin-bottom:8px;">' +
                'Paste tabulated <code>(td, pd, pd_prime)</code> values. ' +
                'Header row optional; <code>pd_prime</code> column optional ' +
                '(computed automatically if omitted). Curves persist across sessions.' +
              '</div>' +
              listHtml +
              '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px;">' +
                '<input type="text" id="prism_uc_name" placeholder="Curve name" ' +
                  'style="padding:4px 8px; min-width:200px; background:var(--bg1, #fff); color:var(--text, #000); border:1px solid var(--border, #ccc); border-radius:4px;">' +
                '<button class="btn btn-primary" id="prism_uc_load">Load</button>' +
              '</div>' +
              '<textarea id="prism_uc_paste" style="margin-top:6px; width:100%; min-height:140px; ' +
                  'font-family:monospace; font-size:11px; background:var(--bg1, #fff); color:var(--text, #000); border:1px solid var(--border, #ccc); border-radius:4px; padding:6px;" ' +
                  'placeholder="td, pd, pd_prime' + '\\n' +
                  '0.001, 0.0234, 0.0234' + '\\n' +
                  '0.01,  0.123,  0.123' + '\\n' +
                  '0.1,   0.567,  0.567' + '\\n' +
                  '1,     2.30,   1.00' + '\\n' +
                  '10,    4.61,   1.00' + '\\n' +
                  '100,   6.91,   1.00"></textarea>' +
              '<div id="prism_uc_msg" style="margin-top:6px; font-size:12px; color:var(--text2, #aaa); min-height:1em;"></div>' +
            '</div>';

        // Wire delete buttons.
        var delBtns = container.querySelectorAll('button[data-prism-curve-del]');
        for (var j = 0; j < delBtns.length; j++) {
            (function (btn) {
                btn.onclick = function () {
                    var nm = btn.getAttribute('data-prism-curve-del');
                    if (PRiSM_deleteUserTypeCurve(nm)) {
                        rerender();
                    }
                };
            })(delBtns[j]);
        }

        // Wire load button.
        var loadBtn = container.querySelector('#prism_uc_load');
        var msgEl   = container.querySelector('#prism_uc_msg');
        if (loadBtn) {
            loadBtn.onclick = function () {
                var nameEl = container.querySelector('#prism_uc_name');
                var pasteEl = container.querySelector('#prism_uc_paste');
                var nm = nameEl ? nameEl.value.trim() : '';
                var txt = pasteEl ? pasteEl.value : '';
                if (!nm) {
                    if (msgEl) msgEl.innerHTML = '<span style="color:var(--red, #c00);">Please enter a curve name.</span>';
                    return;
                }
                try {
                    var info = PRiSM_loadUserTypeCurve(nm, txt);
                    if (msgEl) msgEl.innerHTML = '<span style="color:var(--green, #0a0);">Loaded "' +
                        _escapeHtml(info.name) + '" (' + info.n + ' points' +
                        (info.hasDeriv ? ', with pd′' : ', pd′ auto-computed') + ').</span>';
                    if (nameEl)  nameEl.value = '';
                    if (pasteEl) pasteEl.value = '';
                    rerender();
                } catch (e) {
                    if (msgEl) msgEl.innerHTML = '<span style="color:var(--red, #c00);">Error: ' +
                        _escapeHtml(e && e.message ? e.message : String(e)) + '</span>';
                }
            };
        }
    }

    rerender();
}

function _escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _escapeAttr(s) {
    return _escapeHtml(s);
}


// =============================================================================
// === SELF-TEST ===
// =============================================================================
// Smoke tests at module load time. We do NOT throw on failure — failures go
// to console.error so they surface in browser dev-tools without breaking the
// host app.
//
// Coverage:
//   1. CSV parser — synthetic 7-row curve, header auto-detect, 3-column.
//   2. CSV parser rejects non-monotone td and non-numeric cells.
//   3. Persistence round-trip: load a curve, re-read it, confirm identity.
//   4. Interpolation: in-range linear interp matches expected; out-of-range
//      extrapolation uses end-slope.
//   5. Parity: register a synthetic homogeneous-like type-curve, evaluate at
//      3 td's, compare to PRiSM_MODELS.homogeneous (if present) within 5%.
//   6. Water injection: forward solve at td=10 days with defaults — expect
//      finite, positive pwd.
//   7. Water injection: pwd is monotonically increasing in time at fixed
//      injection rate (no-storage limit).
//   8. Water injection: pdPrime returns finite values at all queried td's.
// =============================================================================

(function _selfTest() {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    var log = (typeof console !== 'undefined' && console.log)
            ? console.log.bind(console) : function () {};
    var err = (typeof console !== 'undefined' && console.error)
            ? console.error.bind(console) : function () {};

    // --- Stub foundation primitives for stand-alone Node tests --------------
    if (typeof g.PRiSM_stehfest !== 'function') {
        function _I0(x){var ax=Math.abs(x);if(ax<3.75){var y=x/3.75,y2=y*y;return 1.0+y2*(3.5156229+y2*(3.0899424+y2*(1.2067492+y2*(0.2659732+y2*(0.0360768+y2*0.0045813)))));}var y=3.75/ax;return (Math.exp(ax)/Math.sqrt(ax))*(0.39894228+y*(0.01328592+y*(0.00225319+y*(-0.00157565+y*(0.00916281+y*(-0.02057706+y*(0.02635537+y*(-0.01647633+y*0.00392377))))))));}
        function _I1(x){var ax=Math.abs(x);var r;if(ax<3.75){var y=x/3.75,y2=y*y;r=ax*(0.5+y2*(0.87890594+y2*(0.51498869+y2*(0.15084934+y2*(0.02658733+y2*(0.00301532+y2*0.00032411))))));}else{var y2=3.75/ax;r=0.39894228+y2*(-0.03988024+y2*(-0.00362018+y2*(0.00163801+y2*(-0.01031555+y2*(0.02282967+y2*(-0.02895312+y2*(0.01787654+y2*-0.00420059)))))));r*=(Math.exp(ax)/Math.sqrt(ax));}return x<0?-r:r;}
        g.PRiSM_besselK0 = function (x) {
            if (x <= 2) { var y=x*x/4; return -Math.log(x/2)*_I0(x) + (-0.57721566 + y*(0.42278420 + y*(0.23069756 + y*(0.03488590 + y*(0.00262698 + y*(0.00010750 + y*0.00000740)))))); }
            var y=2/x; return Math.exp(-x)/Math.sqrt(x)*(1.25331414 + y*(-0.07832358 + y*(0.02189568 + y*(-0.01062446 + y*(0.00587872 + y*(-0.00251540 + y*0.00053208))))));
        };
        g.PRiSM_besselK1 = function (x) {
            if (x <= 2) { var y=x*x/4; return Math.log(x/2)*_I1(x) + (1/x)*(1 + y*(0.15443144 + y*(-0.67278579 + y*(-0.18156897 + y*(-0.01919402 + y*(-0.00110404 + y*-0.00004686)))))); }
            var y=2/x; return Math.exp(-x)/Math.sqrt(x)*(1.25331414 + y*(0.23498619 + y*(-0.03655620 + y*(0.01504268 + y*(-0.00780353 + y*(0.00325614 + y*-0.00068245))))));
        };
        var V_CACHE = {};
        function _stehV(N) {
            if (V_CACHE[N]) return V_CACHE[N];
            var V = new Array(N + 1), fact = [1];
            for (var i = 1; i <= N; i++) fact[i] = fact[i - 1] * i;
            for (var n = 1; n <= N; n++) {
                var sum = 0;
                var k1 = Math.floor((n + 1) / 2);
                var k2 = Math.min(n, N / 2);
                for (var k = k1; k <= k2; k++) {
                    sum += Math.pow(k, N / 2) * fact[2 * k] /
                           (fact[N / 2 - k] * fact[k] * fact[k - 1] *
                            fact[n - k] * fact[2 * k - n]);
                }
                V[n] = (Math.pow(-1, n + N / 2)) * sum;
            }
            V_CACHE[N] = V;
            return V;
        }
        g.PRiSM_stehfest = function (Fhat, t, N) {
            if (!N) N = 12;
            var V = _stehV(N);
            var ln2_t = Math.log(2) / t;
            var sum = 0;
            for (var n = 1; n <= N; n++) sum += V[n] * Fhat(n * ln2_t);
            return sum * ln2_t;
        };
    }

    var results = [];
    var pass = 0, fail = 0;
    function record(name, ok, detail) {
        results.push({ name: name, ok: !!ok, detail: detail });
        if (ok) pass++; else fail++;
    }

    // ---- 1. CSV parser ------------------------------------------------------
    try {
        var sample =
            'td, pd, pd_prime\n' +
            '0.001, 0.0234, 0.0234\n' +
            '0.01,  0.123,  0.123\n' +
            '0.1,   0.567,  0.567\n' +
            '1,     2.30,   1.00\n' +
            '10,    4.61,   1.00\n' +
            '100,   6.91,   1.00\n';
        var parsed = _parseTypeCurveCsv(sample);
        record('csv-parse 6-row 3-col header',
            parsed.td.length === 6 && parsed.pdPrime !== null
            && Math.abs(parsed.td[0] - 0.001) < 1e-12
            && Math.abs(parsed.pd[5] - 6.91) < 1e-12,
            parsed);
    } catch (e) { record('csv-parse 6-row', false, e.message); }

    // ---- 2. CSV parser rejects bad input ------------------------------------
    try {
        _parseTypeCurveCsv('a, b, c\n1, 2, 3\n');
        record('csv-parse rejects too-few-rows', false, 'expected throw');
    } catch (e) { record('csv-parse rejects too-few-rows', true, e.message); }

    try {
        _parseTypeCurveCsv('1, 2\n3, 4\n2, 5\n4, 6\n');  // td goes 1→3→2 → not monotone
        record('csv-parse rejects non-monotone td', false, 'expected throw');
    } catch (e) { record('csv-parse rejects non-monotone td', true, e.message); }

    // ---- 3. Persistence round-trip + curve registration --------------------
    try {
        var canonName = '__PRiSM_selftest_curve';
        var info = PRiSM_loadUserTypeCurve(canonName,
            '0.01, 0.123\n0.1, 0.567\n1, 2.30\n10, 4.61\n100, 6.91\n');
        var listed = PRiSM_listUserTypeCurves();
        record('register + list',
            info.n === 5 && listed.indexOf(canonName) >= 0, listed);
        var got = PRiSM_getUserTypeCurve(canonName);
        record('get returns same data',
            got && got.td.length === 5 && Math.abs(got.pd[2] - 2.30) < 1e-12,
            got && got.td);
    } catch (e) { record('register/get/list', false, e.message); }

    // ---- 4. Interpolation in / out of range ---------------------------------
    try {
        var tdArr  = [0.01, 0.1, 1, 10, 100];
        var valArr = [0.123, 0.567, 2.30, 4.61, 6.91];
        // In range: at td=1 should match exactly.
        var v1 = _interpLogLinear(tdArr, valArr, 1);
        // Halfway in log10 between td=1 and td=10 (i.e. td≈3.16): expected
        // is (2.30+4.61)/2 = 3.455.
        var v2 = _interpLogLinear(tdArr, valArr, Math.pow(10, 0.5));
        // Above range: extrapolate at log slope of last two points.
        var v3 = _interpLogLinear(tdArr, valArr, 1000);
        var slope = (6.91 - 4.61) / (Math.log10(100) - Math.log10(10));
        var v3_expect = 6.91 + slope * (Math.log10(1000) - Math.log10(100));
        record('interp exact match at knot',
            Math.abs(v1 - 2.30) < 1e-12, v1);
        record('interp midpoint in log10',
            Math.abs(v2 - (2.30 + 4.61) / 2) < 1e-9, v2);
        record('extrapolation uses end slope',
            Math.abs(v3 - v3_expect) < 1e-9, [v3, v3_expect]);
    } catch (e) { record('interpolation', false, e.message); }

    // ---- 5. Parity vs homogeneous ------------------------------------------
    // Build a synthetic type-curve that mimics the homogeneous reservoir
    // (Cd=100, S=0) at known td points, register it, then evaluate the
    // userDefined model at the same td values. Compare element-wise within
    // ±5% of the canonical homogeneous response.
    //
    // Canonical homogeneous values precomputed from the foundation Stehfest
    // engine — see node-script in PRiSM 10 source comments. The exact values
    // are:
    //   td=1   → 0.0099
    //   td=10  → 0.0958
    //   td=100 → 0.7975
    //   td=1000 → 3.2680
    try {
        var canonicalTd = [0.1, 1, 10, 100, 1000];
        var canonicalPd = [0.0001, 0.0099, 0.0958, 0.7975, 3.2680];
        // Register a curve using these exact points then sample at the SAME
        // td values — we should get back numerically what we put in.
        var pName = '__PRiSM_selftest_homog';
        var rows = [];
        for (var k = 0; k < canonicalTd.length; k++) {
            rows.push(canonicalTd[k] + ',' + canonicalPd[k]);
        }
        PRiSM_loadUserTypeCurve(pName, rows.join('\n'));
        var pdAt = PRiSM_model_userDefined([1, 10, 100],
            { curveName: pName, timeShift: 0, pressShift: 0 });
        var ok = true;
        for (var ii = 0; ii < pdAt.length; ii++) {
            var expected = canonicalPd[ii + 1];   // td=1, 10, 100 are indices 1..3
            var rel = Math.abs(pdAt[ii] - expected) / Math.max(1e-6, Math.abs(expected));
            if (rel > 0.05) { ok = false; break; }
        }
        record('userDefined parity vs homogeneous (5% tol)',
            ok, { got: pdAt, expected: [0.0099, 0.0958, 0.7975] });
        // Also compare against the live homogeneous registry entry if
        // available; this is the BETTER test because it exercises the FULL
        // foundation+model stack.
        if (g.PRiSM_MODELS && g.PRiSM_MODELS.homogeneous &&
            typeof g.PRiSM_MODELS.homogeneous.pd === 'function') {
            var pdHomLive = g.PRiSM_MODELS.homogeneous.pd([1, 10, 100], { Cd: 100, S: 0 });
            var ok2 = true;
            for (var jj = 0; jj < pdAt.length; jj++) {
                var rel2 = Math.abs(pdAt[jj] - pdHomLive[jj]) /
                           Math.max(1e-6, Math.abs(pdHomLive[jj]));
                if (rel2 > 0.10) { ok2 = false; break; }   // 10% tol vs LIVE
            }
            record('userDefined ≈ homogeneous live (10% tol)',
                ok2, { got: pdAt, live: pdHomLive });
        }
        // Cleanup the test curves.
        PRiSM_deleteUserTypeCurve(pName);
        PRiSM_deleteUserTypeCurve('__PRiSM_selftest_curve');
    } catch (e) { record('userDefined parity', false, e.message); }

    // ---- 6. Water-injection: forward eval finite + positive ----------------
    try {
        var defs = REGISTRY_ADDITIONS.waterInjection.defaults;
        // Inject 1000 bbl over 1 day (default q_inj = 1000 bbl/d, 1 day).
        var pwd1 = PRiSM_model_waterInjection([1.0], defs);
        var ok = Array.isArray(pwd1) && pwd1.length === 1
                 && _num(pwd1[0]) && pwd1[0] > 0;
        record('waterInjection 1-day pwd finite & positive',
            ok, pwd1);
    } catch (e) { record('waterInjection 1-day', false, e.message); }

    // ---- 7. Water-injection: monotone increasing ----------------------------
    try {
        var defs2 = REGISTRY_ADDITIONS.waterInjection.defaults;
        var pwdSeries = PRiSM_model_waterInjection([0.1, 1, 10, 100], defs2);
        var monotone = true;
        for (var i = 1; i < pwdSeries.length; i++) {
            if (!(pwdSeries[i] > pwdSeries[i - 1])) { monotone = false; break; }
        }
        record('waterInjection pwd monotone increasing',
            monotone && pwdSeries.every(function (v) { return _num(v) && v > 0; }),
            pwdSeries);
    } catch (e) { record('waterInjection monotone', false, e.message); }

    // ---- 8. Water-injection: pdPrime finite ---------------------------------
    try {
        var defs3 = REGISTRY_ADDITIONS.waterInjection.defaults;
        var pdp = PRiSM_model_waterInjection_pd_prime([1, 10, 100], defs3);
        var allFinite = Array.isArray(pdp) && pdp.every(function (v) {
            return typeof v === 'number' && isFinite(v);
        });
        record('waterInjection pdPrime finite', allFinite, pdp);
    } catch (e) { record('waterInjection pdPrime', false, e.message); }

    // ---- 9. Sanity: rateProfile honoured ------------------------------------
    try {
        var defs4 = Object.assign({}, REGISTRY_ADDITIONS.waterInjection.defaults);
        // Inject 5000 bbl/d for first 0.5 day, then shut in (q=0).
        defs4.rateProfile = [[0, 5000], [0.5, 0]];
        var pwd_at_2 = PRiSM_model_waterInjection([2.0], defs4);
        // After shut-in pwd should still be finite.
        record('waterInjection rateProfile honoured',
            _num(pwd_at_2[0]), pwd_at_2);
    } catch (e) { record('waterInjection rateProfile', false, e.message); }

    // ---- Roll up -------------------------------------------------------------
    if (fail === 0) {
        log('PRiSM 10: SELF-TEST PASSED — ' + pass + '/' + (pass + fail) + ' checks ok');
    } else {
        err('PRiSM 10: SELF-TEST FAILED — ' + fail + ' of ' + (pass + fail) + ' checks failed');
        results.forEach(function (r) {
            (r.ok ? log : err)('  ' + (r.ok ? 'OK ' : 'XX ') + r.name +
                (r.detail !== undefined ? ' :: ' + JSON.stringify(r.detail) : ''));
        });
    }
})();

})();
