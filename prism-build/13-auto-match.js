// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 13 — Auto-Match Orchestrator
//   Classifies flow regimes from the (sign-aware) Bourdet derivative,
//   narrows to a candidate model set, races every candidate through a
//   PHYSICAL parameterisation (k, C, S [, pi, shape]) and ranks by AIC on
//   an identical residual vector. Decline (rate) models race separately.
// -----------------------------------------------------------------------------
// PUBLIC API (all on window.PRiSM_*)
//   PRiSM_classifyRegimes(t, p, deriv?, opts?) → { regimes, candidates, summary, flags }
//   PRiSM_autoMatch(opts?)            → Promise<AutoMatchResult>   (yields between fits)
//   PRiSM_autoMatchSync(opts?)        → AutoMatchResult             (same, blocking)
//   PRiSM_applyAutoMatchRow(rowOrKey, result?) → row | null
//   PRiSM_suggestInitialParams(modelKey, t, p, deriv, classification) → params
//   PRiSM_renderAutoMatchPanel(host, result?)
//   PRiSM_modelPlainName(modelKey)    → 'Homogeneous reservoir' …
//
// AutoMatchResult = { ok, kind:'pressure'|'rate', mode, ranked:[row], top:[row ≤ 3],
//   bestKey (first CONVERGED row) , recommendedKey, bestConverged, deltaAIC:[],
//   decline:{ranked, top}|null, failed:[{modelKey, error}], classification,
//   analysis:{n, pRef, pRefSource, testType, timeFn, warnings}, well:{complete, missing},
//   elapsedMs, timestamp, warnings }
// row = C4 LastFit object + { rank, dAIC, akaikeWeight, label, status, modelName }
//   label: 'Best fit' (rank 1 AND converged) | 'Alternative' | 'Starting point — refine'
//   A non-converged row is NEVER labelled 'Best fit'.
//
// PHYSICAL PARAMETERISATION (contract C3). The response is fitted as
//   Δp(t) = A · pD(B·t; Cd, S, shape)   with
//   A  = 141.2 q B μ /(k h)             [psi per unit pD]
//   B  = 0.0002637 k /(φ μ ct Lref²)    [tD per hour]
//   Cd = 0.8936 C /(φ ct h Lref²)
// so A and B are tied through k and cannot absorb skin independently.
// When the well inputs are incomplete the race runs in SCALE mode
// (A, T = B/Cd, Cd·e^2S) and reports kh and C only; S is flagged as not
// identifiable without φ·ct·rw².
//
// Engines: window.PRiSM_fitPhysical / PRiSM_fitRate (05) and
// PRiSM_getAnalysisData / PRiSM_getWell / PRiSM_physicalModel (33) are used
// when present; every one has a local fallback in this file.
//
// CONVENTIONS: single outer IIFE; window.PRiSM_* only; registries read,
// never replaced; no external deps; never writes PRiSM_state.match.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});

// =========================================================================
// SECTION 0 — SMALL UTILITIES
// =========================================================================

function _fmt(n, sig) {
    if (n == null || typeof n !== 'number' || !isFinite(n)) return '—';
    sig = sig || 4;
    var a = Math.abs(n);
    if (a === 0) return '0';
    if (a >= 1e6 || a < 1e-3) return n.toExponential(Math.max(0, sig - 1));
    var s = n.toPrecision(sig);
    if (s.indexOf('.') !== -1 && s.indexOf('e') === -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}

function _num(v) { return typeof v === 'number' && isFinite(v); }
function _pos(v) { return typeof v === 'number' && isFinite(v) && v > 0; }

function _mean(arr) {
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) { s += arr[i]; n++; }
    return n > 0 ? (s / n) : NaN;
}

function _median(arr) {
    var f = [];
    for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) f.push(arr[i]);
    if (!f.length) return NaN;
    f.sort(function (a, b) { return a - b; });
    var m = f.length >> 1;
    return (f.length & 1) ? f[m] : 0.5 * (f[m - 1] + f[m]);
}

function _slope(xs, ys) {
    var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < xs.length; i++) {
        var x = xs[i], y = ys[i];
        if (!isFinite(x) || !isFinite(y)) continue;
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    if (n < 2) return NaN;
    var denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-20) return NaN;
    return (n * sxy - sx * sy) / denom;
}

function _clone(o) {
    if (o == null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(_clone);
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = _clone(o[k]);
    return out;
}

function _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

function _toArr(a) {
    if (!a) return null;
    if (Array.isArray(a)) return a;
    if (typeof a.length === 'number') return Array.prototype.slice.call(a);
    return null;
}

// Bourdet derivative d(y)/d(ln x) with log-window L (natural-log units).
// The SAME operator is applied to data and model inside the objective so the
// derivative comparison is free of smoothing bias.
function _bourdet(x, y, L) {
    L = (L != null && isFinite(L)) ? Math.max(0, L) : 0.15;
    var n = x.length;
    var d = new Array(n);
    for (var k = 0; k < n; k++) d[k] = NaN;
    if (n < 3) return d;
    var lx = new Array(n);
    for (var j = 0; j < n; j++) lx[j] = (x[j] > 0) ? Math.log(x[j]) : NaN;
    for (var i = 1; i < n - 1; i++) {
        if (!isFinite(lx[i]) || !isFinite(y[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && lx[i] - lx[i1] < L) i1--;
            while (i2 < n - 1 && lx[i2] - lx[i] < L) i2++;
        }
        var dl1 = lx[i] - lx[i1], dl2 = lx[i2] - lx[i], dlT = lx[i2] - lx[i1];
        if (!(dl1 > 0) || !(dl2 > 0) || !(dlT > 0)) continue;
        d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
    }
    return d;
}

function _dispatch(name, detail) {
    try {
        if (typeof G.dispatchEvent === 'function' && typeof G.CustomEvent === 'function') {
            G.dispatchEvent(new G.CustomEvent(name, { detail: detail }));
        }
    } catch (e) { /* silent */ }
}

// Plain-language model names (never product names).
var PLAIN_NAMES = {
    homogeneous:       'Homogeneous reservoir',
    infiniteFrac:      'Fractured well (infinite conductivity)',
    finiteFrac:        'Fractured well (finite conductivity)',
    finiteFracSkin:    'Fractured well with fracture-face skin',
    inclined:          'Inclined (slanted) well',
    horizontal:        'Horizontal well',
    partialPenFrac:    'Partially penetrating fracture',
    linearBoundary:    'Single fault',
    parallelChannel:   'Channel (two parallel faults)',
    closedChannel3:    'Channel closed at one end',
    closedRectangle:   'Closed rectangle',
    intersecting:      'Intersecting faults',
    fogBoundary:       'Leaky fault',
    doublePorosity:    'Dual porosity (naturally fractured)',
    partialPen:        'Partial penetration',
    verticalPulse:     'Vertical pulse test',
    twoLayerXF:        'Two layers with crossflow',
    radialComposite:   'Radial composite',
    multiLayerXF:      'Multi-layer with crossflow',
    multiLayerNoXF:    'Multi-layer without crossflow',
    linearComposite:   'Linear composite',
    arps:              'Arps decline',
    duong:             'Duong decline',
    sepd:              'Stretched-exponential decline',
    fetkovich:         'Fetkovich decline',
    userDefined:       'User-defined type curve'
};

function PRiSM_modelPlainName(key) {
    if (!key) return '';
    if (PLAIN_NAMES[key]) return PLAIN_NAMES[key];
    var e = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
    if (e && typeof e.label === 'string' && e.label) return e.label;
    if (e && typeof e.name === 'string' && e.name) return e.name;
    var s = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}


// =========================================================================
// SECTION 1 — REGIME CLASSIFIER
// =========================================================================
//
//   1. Window the log-t axis into ≈ 6 segments; regress d(log Δp')/d(log t).
//   2. Tag each by the nearest library slope (±tolerance).
//   3. HUMP RULE (fix for classifier-skin-hump-as-spherical): a negative-
//      slope segment is only tagged spherical (−½) or constant-pressure (−1)
//      when it FOLLOWS a flat/radial segment, or starts more than 1.5 log
//      cycles after the derivative maximum. Otherwise it is the falling limb
//      of the wellbore-storage hump ('storageHump') and routes to the
//      WBS → homogeneous rule. (The Δp reference does not change the
//      derivative, so this is purely a shape rule.)
//   4. Higher-order shapes: derivative doubling (fault), valley (dual φ).
// =========================================================================

var SLOPE_LIBRARY = [
    { slope:  1.00, tag: 'wellboreStorage', tol: 0.20 },
    { slope:  0.50, tag: 'linearFlow',      tol: 0.18 },
    { slope:  0.25, tag: 'bilinearFlow',    tol: 0.12 },
    { slope:  0.00, tag: 'radialFlow',      tol: 0.15 },
    { slope: -0.50, tag: 'sphericalFlow',   tol: 0.18 },
    { slope: -1.00, tag: 'constPressure',   tol: 0.20 }
];
var LATE_PSS_TOL = 0.25;
var HUMP_LOG_CYCLES = 1.5;

var CANDIDATE_RULES = [
    { cond: function (f) { return f.wbs && f.radial && !f.fault && !f.lin && !f.bilin && !f.spheric && !f.dpor; },
      models: ['homogeneous', 'partialPen'] },
    { cond: function (f) { return f.lin && !f.bilin; },
      models: ['infiniteFrac', 'parallelChannel', 'partialPenFrac'] },
    { cond: function (f) { return f.bilin; },
      models: ['finiteFrac', 'finiteFracSkin'] },
    { cond: function (f) { return f.radial && f.spheric; },
      models: ['partialPen', 'verticalPulse'] },
    { cond: function (f) { return f.dpor; },
      models: ['doublePorosity', 'twoLayerXF'] },
    { cond: function (f) { return f.radial && f.fault; },
      models: ['linearBoundary', 'parallelChannel', 'closedChannel3'] },
    { cond: function (f) { return f.pss; },
      models: ['closedRectangle', 'intersecting'] },
    { cond: function (f) { return f.constP; },
      models: ['linearBoundary', 'radialComposite'] },
    { cond: function (f) { return f.radial; },
      models: ['homogeneous'] }
];

var DEFAULT_CANDIDATES = ['homogeneous', 'linearBoundary', 'infiniteFrac', 'doublePorosity',
                          'radialComposite', 'horizontal', 'partialPen'];
var DECLINE_CANDIDATES = ['arps', 'duong', 'sepd', 'fetkovich'];
var MAX_PRESSURE_CANDIDATES = 7;
var MIN_PRESSURE_CANDIDATES = 4;

var PRETTY_TAG = {
    wellboreStorage: 'Wellbore storage (unit slope)',
    storageHump:     'Wellbore-storage hump (damaged/storage)',
    linearFlow:      'Linear flow (½-slope)',
    bilinearFlow:    'Bilinear flow (¼-slope)',
    radialFlow:      'Radial flow',
    sphericalFlow:   'Spherical flow (−½-slope)',
    constPressure:   'Constant-pressure boundary',
    closedBoundary:  'Pseudo-steady state (closed)',
    sealingFault:    'Derivative doubling (sealing fault)',
    doublePorosity:  'Valley (dual porosity)'
};

/**
 * Classify flow regimes.
 * @param {number[]} t      Δt (> 0)
 * @param {number[]} p      pressure or Δp (only used when deriv is absent)
 * @param {number[]=} deriv Bourdet derivative (sign-aware, positive). If
 *                          absent it is computed from sign-aware Δp.
 * @param {object=} opts    { L }
 */
function PRiSM_classifyRegimes(t, p, deriv, opts) {
    opts = opts || {};
    t = _toArr(t); p = _toArr(p); deriv = _toArr(deriv);
    if (!t || !p || t.length !== p.length) {
        return { regimes: [], candidates: DEFAULT_CANDIDATES.slice(), flags: {},
                 summary: 'Invalid input — t and p arrays required.' };
    }
    var n = t.length;
    if (n < 4) {
        return { regimes: [{ tag: 'unknown', tdStart: t[0] || 0, tdEnd: t[n - 1] || 0, slope: NaN, confidence: 0 }],
                 candidates: DEFAULT_CANDIDATES.slice(), flags: {},
                 summary: 'Dataset too short (< 4 samples) — using default candidates.' };
    }

    var d;
    if (deriv && deriv.length === n) {
        d = deriv.map(function (v) { return Math.abs(v); });
    } else {
        // Sign-aware Δp (CLAUDE.md): +1 buildup, −1 drawdown.
        var sign = (p[n - 1] - p[0]) >= 0 ? 1 : -1;
        var dP = new Array(n);
        for (var i = 0; i < n; i++) dP[i] = sign * (p[i] - p[0]);
        d = _bourdet(t, dP, opts.L != null ? opts.L : 0.2);
    }

    var X = [], Y = [], idxMap = [];
    for (var k = 0; k < n; k++) {
        if (!(t[k] > 0)) continue;
        if (!isFinite(d[k]) || d[k] <= 0) continue;
        X.push(Math.log10(t[k])); Y.push(Math.log10(d[k])); idxMap.push(k);
    }
    var nGood = X.length;
    if (nGood < 3) {
        return { regimes: [{ tag: 'unknown', tdStart: t[0], tdEnd: t[n - 1], slope: NaN, confidence: 0 }],
                 candidates: DEFAULT_CANDIDATES.slice(), flags: {},
                 summary: 'Derivative dominated by non-positive values — using default candidates.' };
    }

    // Derivative maximum (for the hump rule).
    var iMax = 0;
    for (var im = 1; im < nGood; im++) if (Y[im] > Y[iMax]) iMax = im;
    var xMax = X[iMax];

    var nSeg = Math.max(3, Math.min(6, Math.floor(nGood / 3)));
    var perSeg = Math.floor(nGood / nSeg);
    var segments = [];
    for (var s = 0; s < nSeg; s++) {
        var i0 = s * perSeg;
        var i1 = (s === nSeg - 1) ? nGood : i0 + perSeg;
        if (i1 - i0 < 2) continue;
        var xs = X.slice(i0, i1), ys = Y.slice(i0, i1);
        var m = _slope(xs, ys);
        var b = _mean(ys) - m * _mean(xs);
        var sse = 0;
        for (var rr = 0; rr < xs.length; rr++) { var e = ys[rr] - (b + m * xs[rr]); sse += e * e; }
        segments.push({ tdStart: t[idxMap[i0]], tdEnd: t[idxMap[i1 - 1]], x0: xs[0],
                        slope: m, rmse: Math.sqrt(sse / xs.length), level: Math.pow(10, _mean(ys)) });
    }

    var regimes = [];
    var lastSegIdx = segments.length - 1;
    var seenFlat = false;
    for (var ss = 0; ss < segments.length; ss++) {
        var seg = segments[ss];
        var best = null, bestErr = Infinity;
        for (var li = 0; li < SLOPE_LIBRARY.length; li++) {
            var err = Math.abs(seg.slope - SLOPE_LIBRARY[li].slope);
            if (err < bestErr) { bestErr = err; best = SLOPE_LIBRARY[li]; }
        }
        if (ss === lastSegIdx && ss > 0 && seenFlat && seg.slope > 0.6 && seg.slope < 1.4) {
            regimes.push({ tag: 'closedBoundary', tdStart: seg.tdStart, tdEnd: seg.tdEnd, slope: seg.slope,
                           confidence: Math.max(0.3, 1 - Math.abs(seg.slope - 1) / LATE_PSS_TOL - seg.rmse),
                           level: seg.level });
            continue;
        }
        var tag = (best && bestErr <= best.tol) ? best.tag : 'unknown';
        var conf = 1 - (bestErr / Math.max(best.tol, 1e-6)) - Math.min(0.4, seg.rmse);
        if (conf < 0) conf = 0; if (conf > 1) conf = 1;

        // Hump rule.
        if (seg.slope < -0.2 && !seenFlat && (seg.x0 - xMax) <= HUMP_LOG_CYCLES) {
            tag = 'storageHump';
            conf = Math.max(conf, 0.6);
        }
        if (tag === 'radialFlow' || Math.abs(seg.slope) < 0.15) seenFlat = true;
        regimes.push({ tag: tag, tdStart: seg.tdStart, tdEnd: seg.tdEnd, slope: seg.slope,
                       confidence: conf, level: seg.level });
    }

    // Derivative doubling between two radial segments → sealing fault.
    var faultDetected = false;
    var baseLen = regimes.length;
    for (var rk = 1; rk < baseLen; rk++) {
        var a = regimes[rk - 1], b2 = regimes[rk];
        if (a.tag === 'radialFlow' && b2.tag === 'radialFlow' && a.level > 0) {
            var ratio = b2.level / a.level;
            if (ratio > 1.4 && ratio < 3.0) {
                regimes.push({ tag: 'sealingFault', tdStart: a.tdEnd, tdEnd: b2.tdStart, slope: 0,
                               confidence: Math.min(0.95, 0.5 + 0.4 * (1 - Math.abs(ratio - 2.0))), level: b2.level });
                faultDetected = true;
                break;
            }
        }
    }
    // Rising segment between two flats with a level step → fault as well.
    if (!faultDetected) {
        for (var rf = 1; rf < baseLen - 1; rf++) {
            var pr = regimes[rf - 1], cu = regimes[rf], nx = regimes[rf + 1];
            if (pr.tag === 'radialFlow' && nx.tag === 'radialFlow' && cu.slope > 0.1 && cu.slope < 0.8 && pr.level > 0) {
                var rt = nx.level / pr.level;
                if (rt > 1.4 && rt < 3.0) {
                    regimes.push({ tag: 'sealingFault', tdStart: cu.tdStart, tdEnd: cu.tdEnd, slope: cu.slope,
                                   confidence: 0.7, level: nx.level });
                    faultDetected = true;
                    break;
                }
            }
        }
    }

    // Valley between two stabilisations → dual porosity.
    var dporDetected = false;
    for (var v = 1; v < baseLen - 1; v++) {
        var pre = regimes[v - 1], cur = regimes[v], nxt = regimes[v + 1];
        if (pre.tag === 'radialFlow' && nxt.tag === 'radialFlow' && cur.level > 0 &&
            cur.level < 0.7 * Math.min(pre.level, nxt.level)) {
            regimes.push({ tag: 'doublePorosity', tdStart: pre.tdEnd, tdEnd: nxt.tdStart, slope: cur.slope,
                           confidence: 0.7, level: cur.level });
            dporDetected = true;
            break;
        }
    }

    var f = { wbs: false, hump: false, lin: false, bilin: false, radial: false, spheric: false,
              constP: false, pss: false, fault: faultDetected, dpor: dporDetected };
    for (var rg = 0; rg < regimes.length; rg++) {
        var r = regimes[rg];
        if (r.confidence < 0.45) continue;
        switch (r.tag) {
            case 'wellboreStorage': f.wbs = true; break;
            case 'storageHump':     f.hump = true; f.wbs = true; break;
            case 'linearFlow':      f.lin = true; break;
            case 'bilinearFlow':    f.bilin = true; break;
            case 'radialFlow':      f.radial = true; break;
            case 'sphericalFlow':   f.spheric = true; break;
            case 'constPressure':   f.constP = true; break;
            case 'closedBoundary':  f.pss = true; break;
        }
    }
    // A hump followed by radial flow counts as WBS + radial even when the
    // unit-slope itself was not sampled (data starting after WBS).
    var candidates = [];
    for (var c = 0; c < CANDIDATE_RULES.length; c++) {
        if (CANDIDATE_RULES[c].cond(f)) { candidates = CANDIDATE_RULES[c].models.slice(); break; }
    }
    if (!candidates.length) candidates = DEFAULT_CANDIDATES.slice();
    if (candidates.indexOf('homogeneous') === -1) candidates.push('homogeneous');

    var registry = G.PRiSM_MODELS || {};
    if (Object.keys(registry).length > 0) {
        candidates = candidates.filter(function (key) { return !!registry[key]; });
    }

    var tagOrder = [], seenT = {};
    for (var rg2 = 0; rg2 < regimes.length; rg2++) {
        var tg = regimes[rg2].tag;
        if (tg === 'unknown' || seenT[tg]) continue;
        seenT[tg] = true; tagOrder.push(tg);
    }
    var summary;
    if (tagOrder.length) {
        summary = tagOrder.map(function (x) { return PRETTY_TAG[x] || x; }).join(' → ');
        summary += '. Candidates: ' + candidates.slice(0, 4).map(PRiSM_modelPlainName).join(', ');
        if (candidates.length > 4) summary += ' (+' + (candidates.length - 4) + ')';
        summary += '.';
    } else {
        summary = 'No clear regime detected — fitting the default candidate set.';
    }
    return { regimes: regimes, candidates: candidates, summary: summary, flags: f,
             derivMax: { t: t[idxMap[iMax]], value: Math.pow(10, Y[iMax]) } };
}


// =========================================================================
// SECTION 2 — SHAPE-PARAMETER STARTS
// =========================================================================
// Dimensionless shape parameters start from the registry defaults, nudged by
// diagnostic features. k, C, S and pi are seeded physically in SECTION 4.

function PRiSM_suggestInitialParams(modelKey, t, p, deriv, classification) {
    var registry = G.PRiSM_MODELS || {};
    var entry = registry[modelKey];
    var defaults = (entry && entry.defaults) ? entry.defaults : {};
    var out = {};
    for (var k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = defaults[k];
    var regimes = (classification && classification.regimes) || [];

    // Dual porosity ω ≈ valley / first-radial level.
    if ('omega' in out) {
        var firstR = NaN, valley = NaN;
        for (var i = 0; i < regimes.length; i++) {
            if (regimes[i].tag === 'radialFlow' && !isFinite(firstR)) firstR = regimes[i].level;
            if (regimes[i].tag === 'doublePorosity') valley = regimes[i].level;
        }
        if (_pos(firstR) && _pos(valley)) out.omega = Math.max(0.005, Math.min(0.5, valley / firstR));
    }
    // Decline starts (rate models).
    var q = (G.PRiSM_dataset && _toArr(G.PRiSM_dataset.q)) || null;
    if (q && t && t.length) {
        var qf = q.filter(function (v) { return _pos(v); });
        if (qf.length) {
            if ('qi' in out) out.qi = qf[0];
            if ('q1' in out) out.q1 = qf[0];
        }
    }
    return out;
}

// Race-time freeze when the registry carries no `defaultFrozen` metadata
// (S_perf / S_global are collinear; geometry fractions are rarely resolved).
var RACE_FREEZE_FALLBACK = {
    partialPen:    ['S_global', 'zw_to_h', 'h_eff'],
    verticalPulse: ['zw_to_h', 'zobs_to_h', 'h_eff'],
    horizontal:    ['S_global', 'zw_to_h'],
    inclined:      ['S_global', 'hp_to_h'],
    fogBoundary:   [],
    doublePorosity:[]
};

var DISTANCE_KEYS = ['L', 'dF', 'dF1', 'dF2', 'dEnd', 'dN', 'dS', 'dE', 'dW', 'R', 'rD', 'reD', 'Ri'];


// =========================================================================
// SECTION 3 — INPUTS: WELL + ANALYSIS DATA (core API or local fallback)
// =========================================================================

var WELL_REQUIRED = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];

function _finishWell(w) {
    w = w || {};
    var missing = [];
    for (var i = 0; i < WELL_REQUIRED.length; i++) if (!_pos(w[WELL_REQUIRED[i]])) missing.push(WELL_REQUIRED[i]);
    if (typeof w.complete !== 'boolean') w.complete = missing.length === 0;
    if (!Array.isArray(w.missing)) w.missing = missing;
    if (!Array.isArray(w.defaulted)) w.defaulted = [];
    if (!w.testType) w.testType = 'auto';
    if (!w.fluid) w.fluid = 'oil';
    return w;
}

function _medianPositive(arr) {
    if (!arr) return NaN;
    var f = [];
    for (var i = 0; i < arr.length; i++) if (_pos(arr[i])) f.push(arr[i]);
    return _median(f);
}

function _localWell(ds) {
    var pvt = G.PRiSM_pvt || {};
    var c = pvt._computed || {};
    var fluid = pvt.fluidType || 'oil';
    var qData = ds ? _medianPositive(_toArr(ds.q)) : NaN;
    var B, mu;
    if (fluid === 'gas')        { B = _pos(pvt.Bg) ? pvt.Bg : c.Bg; mu = _pos(pvt.mu_g) ? pvt.mu_g : c.mu_g; }
    else if (fluid === 'water') { B = pvt.Bw; mu = pvt.mu_w; }
    else                        { B = _pos(pvt.Bo) ? pvt.Bo : c.Bo; mu = _pos(pvt.mu_o) ? pvt.mu_o : c.mu_o; }
    if (!_pos(B)) B = c.B;
    if (!_pos(mu)) mu = c.mu;
    var prov = (pvt.provenance && pvt.provenance.p_res) || null;
    var piOk = prov === 'user' || prov === 'sample' || prov === 'deconvolution';
    return _finishWell({
        fluid: fluid,
        q: _pos(qData) ? qData : pvt.q,
        B: B, mu: mu,
        ct: _pos(pvt.ct) ? pvt.ct : c.ct,
        h: pvt.h, phi: pvt.phi, rw: pvt.rw,
        pi: (piOk && _pos(pvt.p_res)) ? pvt.p_res : null,
        T_R: _num(pvt.T_res) ? pvt.T_res + 459.67 : null,
        testType: pvt.testType || 'auto',
        tp: _pos(pvt.tp) ? pvt.tp : null,
        tShut: _pos(pvt.tShut) ? pvt.tShut : null,
        pwf0: _pos(pvt.pwf0) ? pvt.pwf0 : null,
        _local: true
    });
}

function _resolveWell(ds, opts, useCore) {
    if (opts.well) return _finishWell(_clone(opts.well));
    if (useCore && typeof G.PRiSM_getWell === 'function') {
        try { var w = G.PRiSM_getWell(ds); if (w) return _finishWell(_clone(w)); } catch (e) { /* fall back */ }
    }
    return _localWell(ds);
}

// Local analysis-data builder (subset of contract C2): sign-aware Δp,
// reference pressure with provenance, Δt re-zeroed at shut-in.
function _localAnalysisData(ds, well, opts) {
    var t = _toArr(ds && ds.t), p = _toArr(ds && ds.p), q = _toArr(ds && ds.q);
    if (!t || !p || t.length !== p.length) return { ok: false, reason: 'No pressure data (need t[] and p[]).' };
    var n = t.length;
    var warnings = [];

    // Test type.
    var testType = (well.testType && well.testType !== 'auto') ? well.testType : null;
    var tShut = _pos(well.tShut) ? well.tShut : null;
    var qRef = _pos(well.q) ? well.q : NaN;
    if (q && q.length === n) {
        var firstZeroAfterFlow = -1, sawFlow = false;
        for (var i = 0; i < n; i++) {
            if (_pos(q[i])) sawFlow = true;
            else if (sawFlow && q[i] === 0) { firstZeroAfterFlow = i; break; }
        }
        if (firstZeroAfterFlow > 0) {
            if (!testType) testType = 'buildup';
            if (!tShut) tShut = t[firstZeroAfterFlow - 1] + 0.5 * (t[firstZeroAfterFlow] - t[firstZeroAfterFlow - 1]);
            var qBefore = _medianPositive(q.slice(0, firstZeroAfterFlow));
            if (_pos(qBefore)) qRef = qBefore;
        }
    }
    if (!testType) testType = ((p[n - 1] - p[0]) >= 0) ? 'buildup' : 'drawdown';
    var ddSign = (testType === 'drawdown' || testType === 'falloff') ? -1 : 1;   // Δp = ddSign·(p − pRef)

    var isBU = (testType === 'buildup' || testType === 'falloff');
    var tStart = isBU ? (tShut || 0) : 0;
    var tp = isBU ? (_pos(well.tp) ? well.tp : (tStart > 0 ? tStart : null)) : null;

    // Reference pressure.
    var pRef = NaN, pRefSource = null;
    if (!isBU) {
        if (_pos(well.pi)) { pRef = well.pi; pRefSource = 'pi'; }
        else {
            for (var z = 0; z < n; z++) if (t[z] <= 0 && _num(p[z])) { pRef = p[z]; pRefSource = 't0-row'; break; }
        }
        if (!_num(pRef)) {
            var pts = [];
            for (var e = 0; e < n && pts.length < 3; e++) if (t[e] > 0 && _num(p[e])) pts.push([t[e], p[e]]);
            if (pts.length >= 2) {
                var sl = _slope(pts.map(function (a) { return a[0]; }), pts.map(function (a) { return a[1]; }));
                var p0 = _mean(pts.map(function (a) { return a[1]; })) - sl * _mean(pts.map(function (a) { return a[0]; }));
                if (_num(p0) && ddSign * (pts[0][1] - p0) > 0) { pRef = p0; pRefSource = 'extrapolated'; }
            }
            if (!_num(pRef)) { pRef = p[0]; pRefSource = 'first-sample'; }
            warnings.push('No initial reservoir pressure pi entered — Δp is measured from the ' +
                          (pRefSource === 'extrapolated' ? 'extrapolated first points' : 'first sample') +
                          ', so skin is biased. Enter pi or let the fit float it.');
        }
    } else {
        if (_pos(well.pwf0)) { pRef = well.pwf0; pRefSource = 'pwf0'; }
        else {
            var bestIdx = -1;
            for (var b = 0; b < n; b++) if (t[b] <= tStart + 1e-12) bestIdx = b;
            if (bestIdx >= 0) { pRef = p[bestIdx]; pRefSource = 't0-row'; }
            else { pRef = p[0]; pRefSource = 'first-sample'; }
        }
    }

    var tt = [], tA = [], pp = [], dp = [];
    for (var k = 0; k < n; k++) {
        var dt = t[k] - tStart;
        if (!(dt > 0) || !_num(p[k])) continue;
        var d = ddSign * (p[k] - pRef);
        if (!(d > 0)) continue;
        tt.push(dt); tA.push(t[k]); pp.push(p[k]); dp.push(d);
    }
    if (tt.length < 5) return { ok: false, reason: 'Fewer than 5 points with positive Δp.', warnings: warnings };
    var L = _num(opts.L) ? opts.L : ((G.PRiSM_state && _num(G.PRiSM_state.bourdetL)) ? G.PRiSM_state.bourdetL : 0.15);
    var rateHistory = [{ t: 0, q: _pos(qRef) ? qRef : 1 }];
    if (isBU && _pos(tp)) rateHistory = [{ t: 0, q: _pos(qRef) ? qRef : 1 }, { t: tp, q: 0 }];
    else if (isBU) warnings.push('Buildup without a producing time tp — analysed as a drawdown-equivalent.');
    return {
        ok: true, n: tt.length, t: tt, tAbs: tA, p: pp, dp: dp, x: tt.slice(),
        deriv: _bourdet(tt, dp, L), L: L, timeFn: 'dt',
        sign: ddSign, pRef: pRef, pRefSource: pRefSource, testType: testType,
        tStart: isBU && _pos(tp) ? tp : 0, tShut: tShut, tp: tp, qRef: _pos(qRef) ? qRef : null,
        rateHistory: rateHistory, periods: [], fluid: well.fluid, warnings: warnings, _local: true
    };
}

function _resolveAdata(ds, well, opts, useCore) {
    if (opts.adata && opts.adata.t) return opts.adata;
    if (useCore && typeof G.PRiSM_getAnalysisData === 'function') {
        try {
            var a = G.PRiSM_getAnalysisData(ds, { period: opts.period, timeFn: opts.timeFn, L: opts.L });
            if (a) return a;
        } catch (e) { /* fall back */ }
    }
    return _localAnalysisData(ds, well, opts);
}


// =========================================================================
// SECTION 4 — LOCAL PHYSICAL MODEL (contract C3 subset)
// =========================================================================

var NOMINAL_WELL = { q: 1000, B: 1.2, mu: 1.0, ct: 1e-5, h: 50, phi: 0.2, rw: 0.354 };

function _specOf(entry, key) {
    var ps = entry && entry.paramSpec;
    if (Array.isArray(ps)) for (var i = 0; i < ps.length; i++) if (ps[i].key === key) return ps[i];
    return null;
}

function _isLogShape(sp, def) {
    if (!sp) return false;
    if (sp.scale === 'log') return true;
    if (sp.scale === 'lin') return false;
    if (_pos(sp.min) && _num(sp.max) && sp.max / sp.min >= 100) return true;
    if (sp.min === 0 && _pos(def) && _num(sp.max) && sp.max / def >= 100) return true;
    return false;
}

// Superposed dimensionless response for the analysed period.
// A is psi per unit pD at the reference rate qA (single-rate: Δp = A·pD).
function _superposedDp(entry, params, A, qA, Bt, adata, tArr) {
    var hist = adata.rateHistory || [];
    var tStart = _num(adata.tStart) ? adata.tStart : 0;
    var multi = hist.length > 1 && tStart > 0;
    if (!multi) {
        var tdArr = tArr.map(function (x) { return Math.max(1e-12, Bt * x); });
        var pd = entry.pd(tdArr, params);
        return pd.map(function (v) { return A * v; });
    }
    var A1 = A / qA;
    // P(T) = A1 Σ Δq_i pD(B (T − t_i));  Δp(Δt) = sgn [P(tStart+Δt) − P(tStart)]
    var steps = [];
    var prevQ = 0;
    for (var i = 0; i < hist.length; i++) {
        var qi = _num(hist[i].q) ? hist[i].q : 0;
        if (hist[i].t < tStart + 1e-12 || i === 0) steps.push({ t: hist[i].t, dq: qi - prevQ });
        prevQ = qi;
    }
    var lastQBefore = 0, qNow = 0;
    for (var j = 0; j < hist.length; j++) {
        if (hist[j].t < tStart - 1e-12) lastQBefore = hist[j].q;
        if (hist[j].t <= tStart + 1e-12) qNow = hist[j].q;
    }
    var sgn = (qNow - lastQBefore) >= 0 ? 1 : -1;
    var args = [], map = [];
    function _push(T, si, ti) {
        var a = T - steps[si].t;
        if (a > 0) { map.push([si, ti, args.length]); args.push(Math.max(1e-12, Bt * a)); }
    }
    for (var s = 0; s < steps.length; s++) {
        _push(tStart, s, -1);
        for (var k = 0; k < tArr.length; k++) _push(tStart + tArr[k], s, k);
    }
    var pdv = args.length ? entry.pd(args, params) : [];
    var P0 = 0, P = new Array(tArr.length);
    for (var z = 0; z < tArr.length; z++) P[z] = 0;
    for (var m = 0; m < map.length; m++) {
        var contrib = A1 * steps[map[m][0]].dq * pdv[map[m][2]];
        if (map[m][1] < 0) P0 += contrib; else P[map[m][1]] += contrib;
    }
    return P.map(function (v) { return sgn * (v - P0); });
}

function _localPM(modelKey, well, adata, opts) {
    var entry = (G.PRiSM_MODELS || {})[modelKey];
    if (!entry || typeof entry.pd !== 'function') return { ok: false, reason: 'No evaluator for ' + modelKey };
    if (entry.kind === 'rate') return { ok: false, reason: modelKey + ' is a rate model' };
    var defaults = entry.defaults || {};
    var hasCd = _num(defaults.Cd);
    var skinKey = _num(defaults.S) ? 'S' : (_num(defaults.S_perf) ? 'S_perf' : null);
    var refLength = entry.refLength || 'rw';
    var refKey = (refLength === 'xf' || refLength === 'Lh') ? refLength : null;
    var scale = !well.complete || !!opts.forceScale;
    var W = {};
    for (var wk in NOMINAL_WELL) W[wk] = _pos(well[wk]) ? well[wk] : NOMINAL_WELL[wk];
    var qA = W.q;

    var frozen = {};
    var df = Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : (RACE_FREEZE_FALLBACK[modelKey] || []);
    df.forEach(function (k) { frozen[k] = true; });
    if (opts.freeze) for (var fz in opts.freeze) if (opts.freeze[fz]) frozen[fz] = true;

    var keys = [], spec = {}, fixed = {};
    function addKey(k, lo, hi, isLog, unit, def) {
        keys.push(k); spec[k] = { min: lo, max: hi, scale: isLog ? 'log' : 'lin', unit: unit || '', default: def };
    }
    var shapeKeys = [];
    for (var dk in defaults) {
        if (!Object.prototype.hasOwnProperty.call(defaults, dk)) continue;
        var dv = defaults[dk];
        if (dk === 'Cd' || dk === skinKey || dk.indexOf('__') === 0) continue;
        if (typeof dv !== 'number') { fixed[dk] = dv; continue; }
        if (refKey && dk === refKey) continue;
        shapeKeys.push(dk);
    }
    var skinSpec = skinKey ? _specOf(entry, skinKey) : null;
    var sLo = (skinSpec && _num(skinSpec.min)) ? Math.max(skinSpec.min, -7) : -7;
    var sHi = (skinSpec && _num(skinSpec.max)) ? Math.min(skinSpec.max, 50) : 50;

    if (!scale) {
        addKey('k', 1e-4, 1e6, true, 'md');
        if (hasCd) addKey('C', 1e-8, 10, true, 'bbl/psi');
        if (skinKey) addKey('S', sLo, sHi, false, '');
        if (refKey) addKey(refKey, 1, 1e5, true, 'ft', 100);
    } else {
        addKey('A', 1e-3, 1e7, true, 'psi');
        if (hasCd) addKey('T', 1e-6, 1e9, true, '1/hr'); else addKey('Bt', 1e-2, 1e12, true, '1/hr');
        if (hasCd && skinKey) addKey('CDe2S', 1e-6, 1e60, true, '');
        else if (skinKey) { frozen.S = true; }
    }
    shapeKeys.forEach(function (sk) {
        var sp = _specOf(entry, sk) || {};
        var def = defaults[sk];
        var lg = _isLogShape(sp, def);
        var lo = _num(sp.min) ? sp.min : (def > 0 ? def / 1e4 : -1e3);
        var hi = _num(sp.max) ? sp.max : (def > 0 ? def * 1e4 : 1e3);
        if (lg && !(lo > 0)) lo = Math.max(def / 1e4, 1e-12);
        addKey(sk, lo, hi, lg, sp.unit || '', def);
    });
    var floatPi = !scale && !!opts.floatPi && (adata.testType === 'drawdown' || adata.testType === 'injection');
    if (floatPi) {
        var pmax = -Infinity, pmin = Infinity;
        (adata.p || []).forEach(function (v) { if (v > pmax) pmax = v; if (v < pmin) pmin = v; });
        var span = Math.max(1, pmax - pmin);
        if (adata.testType === 'injection') addKey('pi', pmin - 3 * span, pmin - 0.01, false, 'psia');
        else addKey('pi', pmax + 0.01, pmax + 3 * span, false, 'psia');
    }
    var Cd0 = 100;

    function toModelParams(phys) {
        var params = {};
        for (var d0 in defaults) if (Object.prototype.hasOwnProperty.call(defaults, d0)) params[d0] = defaults[d0];
        for (var fx in fixed) params[fx] = fixed[fx];
        shapeKeys.forEach(function (sk) { if (_num(phys[sk])) params[sk] = phys[sk]; });
        var A, Bt, Lref = W.rw;
        if (!scale) {
            if (refKey) Lref = phys[refKey];
            var kh = phys.k * W.h;
            A = 141.2 * qA * W.B * W.mu / kh;
            Bt = 0.0002637 * phys.k / (W.phi * W.mu * W.ct * Lref * Lref);
            if (hasCd) params.Cd = 0.8936 * phys.C / (W.phi * W.ct * W.h * Lref * Lref);
            if (skinKey) params[skinKey] = phys.S;
            if (refKey) { params[refKey] = phys[refKey]; params.__h_rw = W.h / W.rw; }
        } else {
            A = phys.A;
            if (hasCd) {
                params.Cd = Cd0;
                Bt = phys.T * Cd0;
                if (skinKey) params[skinKey] = 0.5 * Math.log(phys.CDe2S / Cd0);
            } else {
                Bt = phys.Bt;
                if (skinKey) params[skinKey] = _num(phys.S) ? phys.S : 0;
            }
        }
        return { params: params, A: A, B: Bt, Lref: Lref };
    }

    function dpFn(tArr, phys) {
        var mp = toModelParams(phys);
        return _superposedDp(entry, mp.params, mp.A, qA, mp.B, adata, tArr);
    }

    function seed(work) {
        // Late derivative level → kh; unit slope → C; late point → S.
        var n = work.t.length, tEnd = work.t[n - 1];
        var late = [];
        for (var i = 0; i < n; i++) if (work.t[i] >= tEnd / 10 && _pos(work.deriv[i])) late.push(i);
        if (late.length < 3) for (var i2 = Math.max(0, n - 6); i2 < n; i2++) if (_pos(work.deriv[i2]) && late.indexOf(i2) < 0) late.push(i2);
        var dLate = _median(late.map(function (ix) { return work.deriv[ix]; }));
        if (!_pos(dLate)) dLate = _median(work.dp) / 5;
        var kh = 70.6 * qA * W.B * W.mu / dLate;
        var k = kh / W.h;
        var Cs = [];
        for (var u = 1; u < n - 1 && u < 12; u++) {
            var s1 = Math.log(work.dp[u + 1] / work.dp[u - 1]) / Math.log(work.t[u + 1] / work.t[u - 1]);
            if (s1 > 0.85 && s1 < 1.15) Cs.push(qA * W.B * work.t[u] / (24 * work.dp[u]));
        }
        var C = Cs.length ? _median(Cs) : 0.7 * qA * W.B * work.t[0] / (24 * work.dp[0]);
        var r = late.length ? late[late.length - 1] : n - 1;
        var dpr = work.dp[r], dr = _pos(work.deriv[r]) ? work.deriv[r] : dLate;
        var S = 0.5 * (dpr / dr - Math.log(0.0002637 * k * work.t[r] / (W.phi * W.mu * W.ct * W.rw * W.rw)) - 0.80907);
        if (!_num(S)) S = 0;
        var phys = {};
        if (!scale) {
            phys.k = k;
            if (hasCd) phys.C = C;
            if (skinKey) phys.S = S;
            if (refKey) phys[refKey] = 100;
        } else {
            var Bt = 0.0002637 * k / (W.phi * W.mu * W.ct * W.rw * W.rw);
            var Cd = 0.8936 * C / (W.phi * W.ct * W.h * W.rw * W.rw);
            phys.A = 141.2 * qA * W.B * W.mu / kh;
            if (hasCd) phys.T = Bt / Cd; else phys.Bt = Bt;
            if (hasCd && skinKey) phys.CDe2S = Cd * Math.exp(2 * Math.max(-3, S));
        }
        var shape = PRiSM_suggestInitialParams(modelKey, work.t, work.dp, work.deriv, opts.classification);
        shapeKeys.forEach(function (sk) { phys[sk] = _num(shape[sk]) ? shape[sk] : defaults[sk]; });
        // Boundary distance seed from a detected fault time.
        var reg = (opts.classification && opts.classification.regimes) || [];
        var tf = NaN;
        reg.forEach(function (rg) { if (rg.tag === 'sealingFault' && !_num(tf)) tf = rg.tdStart; });
        if (_pos(tf) && !scale) {
            var rinvF = Math.sqrt(k * tf / (948 * W.phi * W.mu * W.ct));
            ['dF', 'dF1', 'dF2'].forEach(function (dk2) { if (shapeKeys.indexOf(dk2) >= 0) phys[dk2] = 0.5 * rinvF / W.rw; });
        }
        if (floatPi) phys.pi = _pos(well.pi) ? well.pi : (adata.testType === 'injection' ? adata.pRef - 1 : adata.pRef + 1);
        keys.forEach(function (kk) {
            var sp = spec[kk];
            if (!_num(phys[kk])) phys[kk] = _num(sp.default) ? sp.default : (sp.scale === 'log' ? Math.sqrt(sp.min * sp.max) : 0.5 * (sp.min + sp.max));
            phys[kk] = Math.min(sp.max, Math.max(sp.min, phys[kk]));
        });
        return phys;
    }

    function derived(phys, tEnd) {
        var mp = toModelParams(phys);
        var out = {};
        if (!scale) {
            out.k = phys.k; out.kh = phys.k * W.h;
            if (hasCd) { out.C = phys.C; out.Cd = mp.params.Cd; }
            if (skinKey) out.S = phys.S;
            if (refKey) out[refKey] = phys[refKey];
            if (_pos(tEnd)) out.rinv = Math.sqrt(phys.k * tEnd / (948 * W.phi * W.mu * W.ct));
            out.pi = _num(phys.pi) ? phys.pi : (_pos(well.pi) ? well.pi : null);
        } else {
            var known = _pos(well.q) && _pos(well.B) && _pos(well.mu);
            out.kh = known ? 141.2 * well.q * well.B * well.mu / phys.A : null;
            out.k = (out.kh && _pos(well.h)) ? out.kh / well.h : null;
            out.C = (out.kh && hasCd) ? 0.0002951 * out.kh / (well.mu * phys.T) : null;
            out.Cd = null; out.S = null;
            if (_num(phys.CDe2S)) out.CDe2S = phys.CDe2S;
            out.pi = _pos(well.pi) ? well.pi : null;
        }
        var dist = {};
        DISTANCE_KEYS.forEach(function (dk3) {
            if (shapeKeys.indexOf(dk3) >= 0 && _num(phys[dk3]) && !scale) dist[dk3] = phys[dk3] * mp.Lref;
        });
        if (Object.keys(dist).length) out.distances_ft = dist;
        out.A = mp.A; out.B = mp.B;
        return out;
    }

    return {
        ok: true, mode: scale ? 'scale' : 'physical', kind: 'pressure',
        keys: keys, spec: spec, frozen: frozen, floatPi: floatPi, skinKey: skinKey,
        toModelParams: toModelParams, dp: dpFn, seed: seed, derived: derived, _local: true
    };
}

// Adapter over the core PM (33) so it exposes the same surface.
function _corePM(modelKey, well, adata, opts) {
    if (typeof G.PRiSM_physicalModel !== 'function') return null;
    var pm;
    try { pm = G.PRiSM_physicalModel(modelKey, well, adata, { floatPi: !!opts.floatPi }); }
    catch (e) { return null; }
    if (!pm || !pm.ok || typeof pm.dp !== 'function' || !Array.isArray(pm.keys)) return null;
    var entry = (G.PRiSM_MODELS || {})[modelKey] || {};
    var frozen = {};
    var df = Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : (RACE_FREEZE_FALLBACK[modelKey] || []);
    df.forEach(function (k) { frozen[k] = true; });
    if (opts.freeze) for (var fz in opts.freeze) if (opts.freeze[fz]) frozen[fz] = true;
    var spec = {};
    pm.keys.forEach(function (k) {
        var s = (pm.spec && pm.spec[k]) || {};
        var lg = s.scale === 'log';
        var lo = _num(s.min) ? s.min : (lg ? 1e-6 : -1e3), hi = _num(s.max) ? s.max : (lg ? 1e6 : 1e3);
        if (lg && !(lo > 0)) lo = 1e-12;
        spec[k] = { min: lo, max: hi, scale: lg ? 'log' : 'lin', unit: s.unit || '', default: s.default };
    });
    return {
        ok: true, mode: pm.mode || 'physical', kind: 'pressure', keys: pm.keys.slice(), spec: spec,
        frozen: frozen, floatPi: pm.keys.indexOf('pi') >= 0, skinKey: _num((entry.defaults || {}).S) ? 'S' : 'S_perf',
        toModelParams: function (phys) { return pm.toModelParams(phys); },
        dp: function (t, phys) { return pm.dp(t, phys); },
        seed: function () {
            var s = (typeof pm.seed === 'function') ? (pm.seed() || {}) : {};
            pm.keys.forEach(function (k) {
                var sp = spec[k];
                if (!_num(s[k])) s[k] = _num(sp.default) ? sp.default : (sp.scale === 'log' ? Math.sqrt(sp.min * sp.max) : 0.5 * (sp.min + sp.max));
                s[k] = Math.min(sp.max, Math.max(sp.min, s[k]));
            });
            return s;
        },
        derived: function (phys, tEnd) {
            var d = (typeof pm.derived === 'function') ? (pm.derived(phys) || {}) : {};
            var mp = pm.toModelParams(phys) || {};
            if (!_num(d.A)) d.A = mp.A;
            if (!_num(d.B)) d.B = mp.B;
            return d;
        },
        _core: true
    };
}


// =========================================================================
// SECTION 5 — CANDIDATE FITTER (normalised LM on the physical keys)
// =========================================================================
//
// Every free key is mapped affinely onto u ∈ [1, 2] (log10 for log keys), so
// the forward-difference Jacobian step is well scaled whatever PRiSM_lm's
// step rule. The LM sees data.p = 0 and a model that returns −residuals,
// which lets pi float (the Δp target moves with pi).
//
// Objective 'dp+deriv' (default): [ln Δp_d − ln Δp_m] ∪ [ln Δp'_d − ln Δp'_m],
// each block weighted 0.5 of the total. Δp' is computed with the SAME
// Bourdet operator for data and model. 'dp' uses linear psi residuals.
// AIC = N ln(max(SSR, N·ε²)/N) + 2p on that identical vector (ε = gauge floor).

var LOG_FLOOR = 1e-4;       // log-residual resolution floor for AIC
var RATE_LOG_FLOOR = 1e-6;

function _tr(v, isLog) { return isLog ? Math.log(v) / Math.LN10 : v; }
function _itr(v, isLog) { return isLog ? Math.pow(10, v) : v; }

function _decimate(adata, maxN) {
    var n = adata.t.length;
    if (n <= maxN) return null;
    var lo = Math.log10(adata.t[0]), hi = Math.log10(adata.t[n - 1]);
    var step = (hi - lo) / (maxN - 1);
    var keep = [], last = -1;
    for (var i = 0; i < n; i++) {
        var cell = Math.floor((Math.log10(adata.t[i]) - lo) / Math.max(step, 1e-12));
        if (cell !== last) { keep.push(i); last = cell; }
    }
    if (keep[keep.length - 1] !== n - 1) keep.push(n - 1);
    return keep;
}

function _buildWork(adata, opts) {
    var idx = null;
    var maxN = opts.maxPoints || 240;
    var keep = _decimate(adata, maxN);
    var n = adata.t.length;
    idx = keep || (function () { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; })();
    var pick = function (arr) { return arr ? idx.map(function (i) { return arr[i]; }) : null; };
    var w = {
        t: pick(adata.t), p: pick(adata.p), dp: pick(adata.dp),
        x: pick(adata.x && adata.x.length === n ? adata.x : adata.t),
        L: _num(adata.L) ? adata.L : 0.15, decimated: !!keep
    };
    w.deriv = _bourdet(w.x, w.dp, w.L);
    var tmin = (opts.window && _num(opts.window.tmin)) ? opts.window.tmin : -Infinity;
    var tmax = (opts.window && _num(opts.window.tmax)) ? opts.window.tmax : Infinity;
    w.dpIdx = []; w.dvIdx = [];
    for (var j = 0; j < w.t.length; j++) {
        if (w.t[j] < tmin || w.t[j] > tmax) continue;
        if (_pos(w.dp[j])) w.dpIdx.push(j);
        if (_pos(w.deriv[j])) w.dvIdx.push(j);
    }
    w.window = { tmin: _num(tmin) ? tmin : w.t[0], tmax: _num(tmax) ? tmax : w.t[w.t.length - 1] };
    return w;
}

function _targetDp(work, phys, pm, adata) {
    if (!pm.floatPi || !_num(phys.pi)) return work.dp;
    var inj = adata.testType === 'injection';
    return work.p.map(function (pv) { return inj ? pv - phys.pi : phys.pi - pv; });
}

function _residuals(work, phys, pm, adata, objective) {
    var mp = pm.dp(work.t, phys);
    var dpD = _targetDp(work, phys, pm, adata);
    var out = [];
    var nDp = work.dpIdx.length, nDv = (objective === 'dp') ? 0 : work.dvIdx.length;
    var N = nDp + nDv;
    if (objective === 'dp') {
        for (var a = 0; a < nDp; a++) {
            var ia = work.dpIdx[a];
            var m = mp[ia];
            out.push(_num(m) ? (dpD[ia] - m) : 1e6);
        }
        return { r: out, mp: mp };
    }
    var wDp = Math.sqrt(0.5 * N / Math.max(1, nDp));
    var wDv = Math.sqrt(0.5 * N / Math.max(1, nDv));
    for (var i = 0; i < nDp; i++) {
        var ii = work.dpIdx[i];
        var md = mp[ii], dd = dpD[ii];
        if (!(dd > 0)) { out.push(5 * wDp); continue; }
        out.push(((_pos(md)) ? (Math.log(dd) - Math.log(md)) : 7) * wDp);
    }
    if (nDv) {
        var mder = _bourdet(work.x, mp, work.L);
        for (var j = 0; j < nDv; j++) {
            var jj = work.dvIdx[j];
            var mdv = mder[jj];
            out.push(((_pos(mdv)) ? (Math.log(work.deriv[jj]) - Math.log(mdv)) : 7) * wDv);
        }
    }
    return { r: out, mp: mp };
}

function _ssr(r) { var s = 0; for (var i = 0; i < r.length; i++) s += r[i] * r[i]; return s; }

function _fitWithPM(modelKey, pm, adata, work, opts) {
    var objective = opts.objective || 'dp+deriv';
    var maxIter = opts.maxIter || 40;
    var free = pm.keys.filter(function (k) { return !pm.frozen[k]; });
    var seed0 = pm.seed(work);
    if (typeof G.PRiSM_lm !== 'function') throw new Error('Regression engine (PRiSM_lm) not loaded');

    function enc(phys) {
        var u = {};
        free.forEach(function (k) {
            var s = pm.spec[k], lg = s.scale === 'log';
            var lo = _tr(s.min, lg), hi = _tr(s.max, lg);
            u['u_' + k] = 1 + (_tr(Math.min(s.max, Math.max(s.min, phys[k])), lg) - lo) / (hi - lo);
        });
        return u;
    }
    function dec(u, base) {
        var phys = {};
        for (var b in base) phys[b] = base[b];
        free.forEach(function (k) {
            var s = pm.spec[k], lg = s.scale === 'log';
            var lo = _tr(s.min, lg), hi = _tr(s.max, lg);
            phys[k] = _itr(lo + (u['u_' + k] - 1) * (hi - lo), lg);
        });
        return phys;
    }

    var nRes = _residuals(work, seed0, pm, adata, objective).r.length;
    var tIdx = [], zeros = [];
    for (var z = 0; z < nRes; z++) { tIdx.push(z); zeros.push(0); }
    var bounds = {};
    free.forEach(function (k) { bounds['u_' + k] = [1, 2]; });

    function runFrom(start) {
        var modelFn = function (tArr, up) {
            var phys = dec(up, start);
            var r;
            try { r = _residuals(work, phys, pm, adata, objective).r; }
            catch (e) { r = zeros.map(function () { return 1e3; }); }
            return r.map(function (v) { return _num(v) ? -v : -1e3; });
        };
        var lm = G.PRiSM_lm(modelFn, { t: tIdx, p: zeros }, enc(start), bounds, {},
                            { maxIter: maxIter, tolerance: opts.tolerance || 1e-6, weightingMode: 'uniform' });
        var phys = dec(lm.params, start);
        var ssr = _ssr(_residuals(work, phys, pm, adata, objective).r);
        return { lm: lm, phys: phys, ssr: ssr };
    }

    var best = runFrom(seed0);
    // Extra starts on skin when the first fit is not clean (C3 / WP2 2.2).
    if (free.indexOf('S') >= 0 && (best.lm.iterations >= maxIter || !(best.ssr < 1e-3 * nRes))) {
        [2, -2].forEach(function (dS) {
            var st2 = _clone(seed0);
            st2.S = Math.min(pm.spec.S.max, Math.max(pm.spec.S.min, seed0.S + dS));
            try {
                var alt = runFrom(st2);
                if (alt.ssr < best.ssr) best = alt;
            } catch (e) { /* keep best */ }
        });
    }
    return _assemblePressureRow(modelKey, pm, adata, work, best, free, maxIter, objective, opts);
}

function _tQuantile(dof) { return 1.96 + 2.4 / Math.max(1, dof); }

function _assemblePressureRow(modelKey, pm, adata, work, best, free, maxIter, objective, opts) {
    var lm = best.lm, phys = best.phys;
    var res = _residuals(work, phys, pm, adata, objective);
    var N = res.r.length, p = free.length;
    var ssr = _ssr(res.r);
    var floor = (objective === 'dp') ? 0.01 : LOG_FLOOR;
    var aic = N * Math.log(Math.max(ssr, N * floor * floor) / N) + 2 * p;

    // Linear Δp statistics (psi) inside the window.
    var dpD = _targetDp(work, phys, pm, adata);
    var mean = 0, cnt = 0;
    work.dpIdx.forEach(function (i) { mean += dpD[i]; cnt++; });
    mean /= Math.max(1, cnt);
    var ssT = 0, ssR = 0;
    work.dpIdx.forEach(function (i) {
        var e = dpD[i] - res.mp[i]; ssR += e * e;
        var d = dpD[i] - mean; ssT += d * d;
    });
    var r2 = ssT > 0 ? 1 - ssR / ssT : NaN;
    var rmse = Math.sqrt(ssR / Math.max(1, cnt));

    // CIs: u-space stderr → physical.
    var dof = Math.max(1, N - p), tq = _tQuantile(dof);
    var ci95 = {}, stderr = {}, identifiable = {};
    free.forEach(function (k) {
        var s = pm.spec[k], lg = s.scale === 'log';
        var seU = lm.stderr ? lm.stderr['u_' + k] : NaN;
        var span = _tr(s.max, lg) - _tr(s.min, lg);
        var se = _num(seU) ? seU * span : NaN;
        var v = phys[k];
        if (_num(se)) {
            if (lg) {
                var lv = _tr(v, true);
                ci95[k] = [Math.pow(10, lv - tq * se), Math.pow(10, lv + tq * se)];
                stderr[k] = v * se * Math.LN10;
            } else {
                ci95[k] = [v - tq * se, v + tq * se];
                stderr[k] = se;
            }
        } else { ci95[k] = [NaN, NaN]; stderr[k] = NaN; }
        var uVal = 1 + (_tr(v, lg) - _tr(s.min, lg)) / span;
        var atBound = uVal < 1 + 1e-3 || uVal > 2 - 1e-3;
        var wide;
        if (!_num(se)) wide = true;
        else if (lg) wide = tq * se > 0.5;                                  // > ±half a decade
        else wide = tq * se > Math.max(Math.abs(v), 1);
        identifiable[k] = !(atBound || wide);
    });
    var corr = null;
    if (lm.covariance && Array.isArray(lm.freeKeys)) {
        var cv = lm.covariance, fk = lm.freeKeys.map(function (x) { return String(x).replace(/^u_/, ''); });
        corr = cv.map(function (row, a) {
            return row.map(function (c, b) {
                var den = Math.sqrt(Math.abs(cv[a][a] * cv[b][b]));
                return den > 0 ? c / den : NaN;
            });
        });
        for (var a2 = 0; a2 < fk.length; a2++) for (var b2 = 0; b2 < fk.length; b2++) {
            if (a2 !== b2 && Math.abs(corr[a2][b2]) > 0.98) identifiable[fk[a2]] = false;
        }
        corr = { keys: fk, matrix: corr };
    }

    var mp = pm.toModelParams(phys);
    var params = {};
    for (var pk in mp.params) if (pk.indexOf('__') !== 0) params[pk] = mp.params[pk];
    var tEnd = work.t[work.t.length - 1];
    var physOut = pm.derived(phys, tEnd) || {};
    // Shape parameters stay dimensionless in params; derived CIs.
    if (ci95.C && _num(physOut.C) && _num(physOut.Cd) && physOut.C > 0) {
        var f = physOut.Cd / physOut.C;
        ci95.Cd = [ci95.C[0] * f, ci95.C[1] * f];
        identifiable.Cd = identifiable.C;
    }
    if (ci95.k && _num(physOut.kh) && _num(physOut.k) && physOut.k > 0) {
        var hh = physOut.kh / physOut.k;
        ci95.kh = [ci95.k[0] * hh, ci95.k[1] * hh];
    }
    var warnings = [];
    if (pm.mode === 'scale') {
        warnings.push('Well inputs incomplete — skin is not identifiable without φ·ct·rw²; kh and C are reported from the fit scales.');
    }
    if (adata.pRefSource && adata.pRefSource !== 'pi' && adata.pRefSource !== 'pwf0' && !pm.floatPi &&
        (adata.testType === 'drawdown' || adata.testType === 'injection')) {
        warnings.push('Δp reference is ' + adata.pRefSource + ' (no pi) — skin is biased.');
    }
    var unresolved = Object.keys(identifiable).filter(function (k) { return identifiable[k] === false; });
    if (unresolved.length) warnings.push('Not resolved by the data: ' + unresolved.join(', ') + '.');
    var converged = !!(lm.converged || lm.iterations < maxIter) && isFinite(ssr);

    var row = {
        modelKey: modelKey, model: modelKey, modelName: PRiSM_modelPlainName(modelKey),
        kind: 'pressure', source: 'automatch', mode: pm.mode,
        params: params, phys: physOut,
        fitted: _clone(phys),
        ci95: ci95, stderr: stderr, corr: corr, identifiable: identifiable,
        r2: r2, rmse: rmse, aic: aic, ssr: ssr, nObs: N, nFree: p,
        iterations: lm.iterations, converged: converged,
        objective: objective, window: _clone(work.window),
        scales: { A: mp.A, B: mp.B },
        pRef: _num(phys.pi) && pm.floatPi ? phys.pi : adata.pRef,
        pRefSource: pm.floatPi ? 'floated' : adata.pRefSource,
        timestamp: new Date().toISOString(),
        warnings: warnings,
        engine: pm._core ? 'core-model' : 'local'
    };
    if (typeof G.PRiSM_datasetHash === 'function') {
        try { row.datasetHash = G.PRiSM_datasetHash(G.PRiSM_dataset); } catch (e) { /* ignore */ }
    }
    return row;
}

// Normalise a C4 object returned by the regression engine (05).
function _normaliseEngineRow(modelKey, fit) {
    var row = _clone(fit) || {};
    row.modelKey = row.modelKey || row.model || modelKey;
    row.model = row.modelKey;
    row.modelName = PRiSM_modelPlainName(row.modelKey);
    if (!_num(row.r2) && _num(row.R2)) row.r2 = row.R2;
    if (!_num(row.rmse) && _num(row.RMSE)) row.rmse = row.RMSE;
    if (!_num(row.aic) && _num(row.AIC)) row.aic = row.AIC;
    if (!row.ci95 && row.CI95) row.ci95 = row.CI95;
    row.kind = row.kind || 'pressure';
    row.source = 'automatch';
    row.converged = !!row.converged;
    row.warnings = Array.isArray(row.warnings) ? row.warnings : [];
    row.engine = 'core-fit';
    return row;
}


// =========================================================================
// SECTION 6 — RATE (DECLINE) FITTER
// =========================================================================

function _rateSeries(ds) {
    var t = _toArr(ds && ds.t), q = _toArr(ds && ds.q);
    if (!t || !q || t.length !== q.length) return null;
    var unit = String((ds && ds.timeUnit) || 'h').toLowerCase();
    var toDays = (unit === 'd' || unit === 'day' || unit === 'days') ? 1 : 1 / 24;
    var td = [], qq = [];
    for (var i = 0; i < t.length; i++) {
        if (!(t[i] > 0) || !_pos(q[i])) continue;
        td.push(t[i] * toDays); qq.push(q[i]);
    }
    return td.length >= 4 ? { t: td, q: qq } : null;
}

function _rateVaries(ds) {
    var q = _toArr(ds && ds.q);
    if (!q || q.length < 8) return false;
    var vals = [], nz = 0;
    for (var i = 0; i < q.length; i++) { var v = q[i]; if (_pos(v)) { nz++; vals.push(v); } else vals.push(0); }
    if (nz <= 0.5 * q.length) return false;
    var nq = Math.max(2, Math.floor(vals.length / 4)), early = 0, late = 0;
    for (var e = 0; e < nq; e++) early += vals[e];
    for (var l = vals.length - nq; l < vals.length; l++) late += vals[l];
    early /= nq; late /= nq;
    return early > 0 && late < 0.85 * early;
}

function _fitRateLocal(modelKey, series, opts) {
    var entry = (G.PRiSM_MODELS || {})[modelKey];
    if (!entry || typeof entry.pd !== 'function') throw new Error('No evaluator for ' + modelKey);
    if (typeof G.PRiSM_lm !== 'function') throw new Error('Regression engine (PRiSM_lm) not loaded');
    var defaults = entry.defaults || {};
    var t = series.t, q = series.q, n = t.length;
    var qMax = Math.max.apply(null, q);
    var Di0 = Math.log(q[0] / q[n - 1]) / Math.max(1e-9, t[n - 1] - t[0]);
    if (!(Di0 > 0)) Di0 = 0.01;
    var seed = {}, spec = {}, keys = [], fixed = {};
    for (var k in defaults) {
        if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue;
        if (typeof defaults[k] !== 'number') { fixed[k] = defaults[k]; continue; }
        var sp = _specOf(entry, k) || {};
        var lo = _num(sp.min) ? sp.min : 0, hi = _num(sp.max) ? sp.max : 1e6, lg = false, s0 = defaults[k];
        if (k === 'qi' || k === 'q1') { lo = qMax / 20; hi = qMax * 20; lg = true; s0 = (k === 'qi') ? q[0] * Math.exp(Di0 * t[0]) : q[0]; }
        else if (k === 'Di') { lo = 1e-6; hi = Math.max(5, Di0 * 100); lg = true; s0 = Di0; }
        else if (k === 'tau') { lo = Math.max(1e-3, _num(sp.min) ? sp.min : 1e-3); hi = Math.max(1e6, hi); lg = true; s0 = 1 / Di0; }
        else if (k === 'reD') { lg = true; lo = Math.max(1, lo); }
        else if (k === 'b') { lo = 0; hi = _num(sp.max) ? sp.max : 2; s0 = 0.5; }
        s0 = Math.min(hi, Math.max(lo, s0));
        keys.push(k); spec[k] = { min: lo, max: hi, scale: lg ? 'log' : 'lin' }; seed[k] = s0;
    }
    var freeze = {};
    if (opts.freeze) for (var f in opts.freeze) if (opts.freeze[f]) freeze[f] = true;
    var free = keys.filter(function (kk) { return !freeze[kk]; });
    function dec(u) {
        var p = {};
        for (var fx in fixed) p[fx] = fixed[fx];
        keys.forEach(function (kk) { p[kk] = seed[kk]; });
        free.forEach(function (kk) {
            var s = spec[kk], lg = s.scale === 'log', lo = _tr(s.min, lg), hi = _tr(s.max, lg);
            p[kk] = _itr(lo + (u['u_' + kk] - 1) * (hi - lo), lg);
        });
        return p;
    }
    var u0 = {}, bounds = {};
    free.forEach(function (kk) {
        var s = spec[kk], lg = s.scale === 'log', lo = _tr(s.min, lg), hi = _tr(s.max, lg);
        u0['u_' + kk] = 1 + (_tr(seed[kk], lg) - lo) / (hi - lo);
        bounds['u_' + kk] = [1, 2];
    });
    function resid(p) {
        var qm;
        try { qm = entry.pd(t, p); } catch (e) { qm = null; }
        return t.map(function (_, i) {
            var m = qm ? qm[i] : NaN;
            return _pos(m) ? Math.log(q[i]) - Math.log(m) : 7;
        });
    }
    var zeros = t.map(function () { return 0; });
    var idx = t.map(function (_, i) { return i; });
    var maxIter = opts.maxIter || 60;
    var lm = G.PRiSM_lm(function (_t, up) { return resid(dec(up)).map(function (v) { return -v; }); },
                        { t: idx, p: zeros }, u0, bounds, {}, { maxIter: maxIter, tolerance: 1e-9, weightingMode: 'uniform' });
    var params = dec(lm.params);
    var r = resid(params), ssr = _ssr(r), N = r.length, p = free.length;
    var aic = N * Math.log(Math.max(ssr, N * RATE_LOG_FLOOR * RATE_LOG_FLOOR) / N) + 2 * p;
    var qm2 = entry.pd(t, params), mq = _mean(q), ssT = 0, ssR = 0;
    q.forEach(function (v, i) { ssT += (v - mq) * (v - mq); ssR += (v - qm2[i]) * (v - qm2[i]); });
    var dof = Math.max(1, N - p), tq = _tQuantile(dof), ci95 = {}, stderr = {}, identifiable = {};
    free.forEach(function (kk) {
        var s = spec[kk], lg = s.scale === 'log', span = _tr(s.max, lg) - _tr(s.min, lg);
        var seU = lm.stderr ? lm.stderr['u_' + kk] : NaN, se = _num(seU) ? seU * span : NaN, v = params[kk];
        if (_num(se)) {
            ci95[kk] = lg ? [Math.pow(10, _tr(v, true) - tq * se), Math.pow(10, _tr(v, true) + tq * se)] : [v - tq * se, v + tq * se];
            stderr[kk] = lg ? v * se * Math.LN10 : se;
            identifiable[kk] = lg ? tq * se < 0.5 : tq * se < Math.max(Math.abs(v), 0.1);
        } else { ci95[kk] = [NaN, NaN]; stderr[kk] = NaN; identifiable[kk] = false; }
    });
    var physOut = {};
    keys.forEach(function (kk) { physOut[kk] = params[kk]; });
    physOut.timeUnit = 'd';
    if (typeof entry.eur === 'function') {
        try { physOut.eurAtEnd = entry.eur(t[t.length - 1], params); } catch (e) { /* optional */ }
    }
    return {
        modelKey: modelKey, model: modelKey, modelName: PRiSM_modelPlainName(modelKey),
        kind: 'rate', source: 'automatch', mode: 'rate',
        params: params, phys: physOut, ci95: ci95, stderr: stderr, identifiable: identifiable,
        r2: ssT > 0 ? 1 - ssR / ssT : NaN, rmse: Math.sqrt(ssR / N), aic: aic, ssr: ssr,
        nObs: N, nFree: p, iterations: lm.iterations,
        converged: !!(lm.converged || lm.iterations < maxIter),
        objective: 'ln q', window: { tmin: t[0] * 24, tmax: t[t.length - 1] * 24 },
        timestamp: new Date().toISOString(), warnings: [], engine: 'local'
    };
}

function _raceRate(ds, candidates, opts, useCore, failed) {
    var series = _rateSeries(ds);
    if (!series) return [];
    var rows = [];
    candidates.forEach(function (key) {
        try {
            var row;
            if (useCore && typeof G.PRiSM_fitRate === 'function' && opts.engine !== 'local') {
                row = _normaliseEngineRow(key, G.PRiSM_fitRate(key, ds, { maxIter: opts.maxIter || 60 }));
                row.kind = 'rate';
            } else {
                row = _fitRateLocal(key, series, opts);
            }
            if (!_num(row.aic)) throw new Error('fit returned no AIC');
            rows.push(row);
        } catch (e) {
            failed.push({ modelKey: key, modelName: PRiSM_modelPlainName(key), error: String(e && e.message || e) });
        }
    });
    return rows;
}


// =========================================================================
// SECTION 7 — ORCHESTRATOR
// =========================================================================

// Parsimony: AIC differences under 2 are not meaningful evidence. When the
// AIC leader carries a parameter the data cannot determine (identifiable[k]
// === false, e.g. a tiny fracture half-length collinear with skin) and a
// converged alternative within ΔAIC < 2 has none, the simpler, fully
// determined model leads. Shared with ▶ Analyse (37) so both rank alike.
function _hasUndetermined(r) {
    var id = r && r.identifiable;
    if (!id) return false;
    for (var k in id) if (Object.prototype.hasOwnProperty.call(id, k) && id[k] === false) return true;
    return false;
}
function PRiSM_rankCandidates(rows, aicOf) {
    aicOf = aicOf || function (r) { return r.aic; };
    rows.sort(function (a, b) {
        var d = aicOf(a) - aicOf(b);
        if (d !== 0 && !isNaN(d)) return d;
        return (b.r2 || -Infinity) - (a.r2 || -Infinity);
    });
    if (rows.length > 1 && _hasUndetermined(rows[0])) {
        for (var j = 1; j < rows.length; j++) {
            if (!(aicOf(rows[j]) - aicOf(rows[0]) < 2)) break;
            if (rows[j].converged !== false && !_hasUndetermined(rows[j])) {
                var pick = rows.splice(j, 1)[0];
                pick.parsimony = true;
                rows.unshift(pick);
                break;
            }
        }
    }
    return rows;
}
window.PRiSM_rankCandidates = PRiSM_rankCandidates;

function _rankRows(rows) {
    PRiSM_rankCandidates(rows);
    var best = rows.length ? Math.min.apply(null, rows.map(function (r) { return r.aic; })) : NaN;
    var wsum = 0;
    rows.forEach(function (r, i) {
        r.rank = i + 1;
        r.dAIC = r.aic - best;
        r.akaikeWeight = Math.exp(-0.5 * r.dAIC);
        wsum += r.akaikeWeight;
    });
    rows.forEach(function (r) {
        r.akaikeWeight = wsum > 0 ? r.akaikeWeight / wsum : NaN;
        if (!r.converged) { r.status = 'refine'; r.label = 'Starting point — refine'; }
        else if (r.rank === 1) { r.status = 'best'; r.label = r.parsimony ? 'Best fit — simplest equivalent model' : 'Best fit'; }
        else { r.status = 'alternative'; r.label = 'Alternative'; }
        // ΔAIC relative to the next-ranked row, used by the interpretation cautions.
    });
    for (var i = 0; i < rows.length; i++) {
        if (i === 0 && rows.length > 1) { rows[i].dAICnext = Math.abs(rows[1].aic - rows[0].aic); rows[i].secondModelKey = rows[1].modelKey; }
    }
    return rows;
}

function _resolveMode(ds, opts) {
    if (opts.mode) return opts.mode;
    var p = _toArr(ds && ds.p);
    var hasP = p && p.some(function (v) { return _num(v); });
    if (!hasP) return 'decline';
    var st = G.PRiSM_state;
    if (st && (st.mode === 'decline' || st.mode === 'combined' || st.mode === 'transient')) return st.mode;
    return 'transient';
}

function _pressureCandidates(opts, classification) {
    var registry = G.PRiSM_MODELS || {};
    var list;
    if (Array.isArray(opts.candidates) && opts.candidates.length) {
        list = opts.candidates.slice();
    } else {
        list = classification.candidates.slice();
        var minN = opts.minCandidates || MIN_PRESSURE_CANDIDATES;
        for (var i = 0; i < DEFAULT_CANDIDATES.length && list.length < minN; i++) {
            if (list.indexOf(DEFAULT_CANDIDATES[i]) === -1) list.push(DEFAULT_CANDIDATES[i]);
        }
    }
    // The infinite-conductivity fracture (cheap) is raced just before the
    // finite-conductivity ones: it is their FcD → ∞ limit and warm-starts
    // their (slow) fits. Added after the padding so it never displaces a
    // default candidate.
    if (!(Array.isArray(opts.candidates) && opts.candidates.length) && list.indexOf('infiniteFrac') === -1) {
        var iff = -1;
        for (var j = 0; j < list.length; j++) if (list[j] === 'finiteFrac' || list[j] === 'finiteFracSkin') { iff = j; break; }
        if (iff >= 0) list.splice(iff, 0, 'infiniteFrac');
    }
    list = list.filter(function (k, i) {
        return registry[k] && registry[k].kind !== 'rate' && list.indexOf(k) === i;
    });
    var cap = Math.max(1, Math.min(MAX_PRESSURE_CANDIDATES, opts.maxCandidates || MAX_PRESSURE_CANDIDATES));
    return list.slice(0, cap);
}

// Prepare everything the race needs; returns a context or an error result.
function _prepare(opts) {
    opts = opts || {};
    var useCore = opts.useCore !== false;
    var ds = opts.dataset || G.PRiSM_dataset;
    var t0 = _now();
    var ctx = { opts: opts, useCore: useCore, ds: ds, t0: t0, failed: [], warnings: [] };
    if (!ds || !_toArr(ds.t) || _toArr(ds.t).length < 4) {
        ctx.error = 'No usable dataset — load data on step ① first (need at least 4 samples).';
        return ctx;
    }
    ctx.mode = _resolveMode(ds, opts);
    ctx.runPressure = ctx.mode !== 'decline';
    ctx.runRate = (ctx.mode === 'decline') || (ctx.mode === 'combined' && _rateVaries(ds));
    if (Array.isArray(opts.candidates) && opts.candidates.length) {
        var reg = G.PRiSM_MODELS || {};
        var anyRate = opts.candidates.some(function (k) { return reg[k] && reg[k].kind === 'rate'; });
        var anyP = opts.candidates.some(function (k) { return reg[k] && reg[k].kind !== 'rate'; });
        if (anyRate && _rateSeries(ds)) ctx.runRate = true;
        if (!anyP) ctx.runPressure = false;
    }
    if (ctx.runPressure) {
        ctx.well = _resolveWell(ds, opts, useCore);
        ctx.adata = _resolveAdata(ds, ctx.well, opts, useCore);
        if (!ctx.adata || !ctx.adata.ok) {
            ctx.runPressure = false;
            ctx.warnings.push('Pressure analysis unavailable: ' + ((ctx.adata && ctx.adata.reason) || 'no analysis data') + '.');
        } else {
            var derivForClass = _toArr(ctx.adata.deriv);
            ctx.classification = PRiSM_classifyRegimes(_toArr(ctx.adata.t), _toArr(ctx.adata.dp), derivForClass);
            ctx.work = _buildWork(ctx.adata, opts);
            ctx.floatPi = (opts.floatPi != null) ? !!opts.floatPi
                : !(ctx.adata.pRefSource === 'pi' || ctx.adata.pRefSource === 'pwf0' ||
                    ctx.adata.testType === 'buildup' || ctx.adata.testType === 'falloff');
            ctx.candidates = _pressureCandidates(opts, ctx.classification);
            (ctx.adata.warnings || []).forEach(function (w) { ctx.warnings.push(w); });
        }
    }
    if (!ctx.classification) ctx.classification = { regimes: [], candidates: [], summary: ctx.runRate ? 'Rate-decline data.' : '' };
    if (ctx.runRate) {
        var rc = DECLINE_CANDIDATES.slice();
        if (Array.isArray(opts.candidates) && opts.candidates.length) {
            var reg2 = G.PRiSM_MODELS || {};
            var picked = opts.candidates.filter(function (k) { return reg2[k] && reg2[k].kind === 'rate'; });
            if (picked.length) rc = picked;
        }
        ctx.rateCandidates = rc.filter(function (k) { return !!(G.PRiSM_MODELS || {})[k]; });
    }
    if (!ctx.runPressure && !ctx.runRate) {
        ctx.error = ctx.warnings.length ? ctx.warnings.join(' ') : 'Nothing to fit for this dataset and mode.';
    }
    return ctx;
}

function _fitPressureCandidate(ctx, key) {
    var opts = ctx.opts;
    var fOpts = { maxIter: opts.maxIter || 40, objective: opts.objective || 'dp+deriv', window: opts.window,
                  floatPi: ctx.floatPi, freeze: opts.freeze, classification: ctx.classification,
                  forceScale: opts.forceScale, maxPoints: opts.maxPoints };
    var entry = (G.PRiSM_MODELS || {})[key] || {};
    if (ctx.useCore && opts.engine !== 'local' && typeof G.PRiSM_fitPhysical === 'function') {
        var frz = {};
        var df = Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : (RACE_FREEZE_FALLBACK[key] || []);
        df.forEach(function (k) { frz[k] = true; });
        if (opts.freeze) for (var f in opts.freeze) if (opts.freeze[f]) frz[f] = true;
        // Finite-conductivity fractures start from the infinite-conductivity
        // result when it was raced (same k, C, S, xf; FcD from a high value).
        var warm = null, inf = ctx.rowsByKey && ctx.rowsByKey.infiniteFrac;
        if ((key === 'finiteFrac' || key === 'finiteFracSkin') && inf && inf.phys && _num(inf.phys.k) && _num(inf.phys.xf)) {
            warm = { k: inf.phys.k, xf: inf.phys.xf, FcD: 100 };
            if (_num(inf.phys.C)) warm.C = inf.phys.C;
            if (_num(inf.phys.S)) warm.S = inf.phys.S;
            if (_num(inf.phys.pi) && ctx.floatPi) warm.pi = inf.phys.pi;
        }
        var fit = G.PRiSM_fitPhysical(key, ctx.adata, ctx.well,
            { maxIter: fOpts.maxIter, objective: fOpts.objective, window: opts.window, freeze: frz,
              floatPi: ctx.floatPi, race: true, start: warm || undefined });
        if (!fit || fit.ok === false) throw new Error((fit && (fit.reason || fit.error)) || 'fit failed');
        var row = _normaliseEngineRow(key, fit);
        if (!_num(row.aic)) throw new Error('fit returned no AIC');
        return row;
    }
    var pm = (ctx.useCore && opts.engine !== 'local') ? _corePM(key, ctx.well, ctx.adata, fOpts) : null;
    if (!pm) pm = _localPM(key, ctx.well, ctx.adata, fOpts);
    if (!pm || !pm.ok) throw new Error((pm && pm.reason) || 'physical model unavailable');
    return _fitWithPM(key, pm, ctx.adata, ctx.work, fOpts);
}

function _finish(ctx, pRows, rRows) {
    var opts = ctx.opts;
    var topN = Math.max(1, Math.min(8, opts.topN || 5));
    _rankRows(pRows); _rankRows(rRows);
    var primaryKind = ctx.runPressure && pRows.length ? 'pressure' : 'rate';
    var primary = primaryKind === 'pressure' ? pRows : rRows;
    var ranked = primary.slice(0, topN);
    var firstConv = null;
    for (var i = 0; i < ranked.length; i++) if (ranked[i].converged) { firstConv = ranked[i]; break; }
    var elapsed = _now() - ctx.t0;
    var result = {
        ok: ranked.length > 0,
        kind: primaryKind, mode: ctx.mode,
        ranked: ranked, top: ranked.slice(0, 3), candidates: ranked.slice(0, 3),
        bestKey: firstConv ? firstConv.modelKey : null,
        recommendedKey: ranked.length ? ranked[0].modelKey : null,
        bestConverged: !!(ranked[0] && ranked[0].converged),
        deltaAIC: ranked.map(function (r) { return r.dAIC; }),
        decline: (primaryKind === 'pressure' && rRows.length) ? { ranked: rRows.slice(0, topN), top: rRows.slice(0, 3) } : null,
        failed: ctx.failed,
        classification: ctx.classification,
        analysis: ctx.adata ? { n: ctx.adata.n || (ctx.adata.t && ctx.adata.t.length), pRef: ctx.adata.pRef,
                                pRefSource: ctx.adata.pRefSource, testType: ctx.adata.testType,
                                timeFn: ctx.adata.timeFn, warnings: (ctx.adata.warnings || []).slice(),
                                floatPi: !!ctx.floatPi, decimated: !!(ctx.work && ctx.work.decimated) } : null,
        well: ctx.well ? { complete: !!ctx.well.complete, missing: (ctx.well.missing || []).slice(),
                           defaulted: (ctx.well.defaulted || []).slice() } : null,
        elapsedMs: Math.round(elapsed),
        timestamp: new Date().toISOString(),
        warnings: ctx.warnings.slice()
    };
    // Stamp the ranking with the data it was computed on (report / rail ignore
    // a ranking whose hash no longer matches the active dataset).
    if (typeof G.PRiSM_datasetHash === 'function') {
        try { result.datasetHash = G.PRiSM_datasetHash(ctx.ds || G.PRiSM_dataset); } catch (e) { /* ignore */ }
    }
    result.activePeriod = (G.PRiSM_state && G.PRiSM_state.activePeriod != null) ? G.PRiSM_state.activePeriod : null;
    if (!result.ok) result.error = ctx.failed.length ? 'No candidate could be fitted.' : 'No candidates to fit.';
    if (ranked.length && !ranked[0].converged) {
        result.warnings.push('The top-ranked model did not converge — treat it as a starting point and refine it in regression.');
    }
    try {
        if (G.PRiSM_state && typeof G.PRiSM_state === 'object') G.PRiSM_state.autoMatch = result;
    } catch (e) { /* silent */ }
    _dispatch('prism:automatch-updated', { bestKey: result.bestKey, kind: result.kind });
    try {
        if (typeof G.gtag === 'function') {
            G.gtag('event', 'prism_auto_match_run', { event_category: 'PRiSM', best_model: result.bestKey || 'none',
                   elapsed_ms: result.elapsedMs, n_candidates: ranked.length });
        }
    } catch (e) { /* silent */ }
    if (opts.apply && result.ok) {
        var toApply = firstConv || (opts.applyUnconverged ? ranked[0] : null);
        if (toApply) PRiSM_applyAutoMatchRow(toApply, result, { quiet: true });
    }
    return result;
}

function _errorResult(ctx) {
    return { ok: false, error: ctx.error, kind: null, mode: ctx.mode || null, ranked: [], top: [], candidates: [],
             bestKey: null, recommendedKey: null, bestConverged: false, deltaAIC: [], decline: null,
             failed: ctx.failed || [], classification: ctx.classification || { regimes: [], candidates: [], summary: ctx.error },
             analysis: null, well: null, elapsedMs: 0, timestamp: new Date().toISOString(), warnings: ctx.warnings || [] };
}

function _raceOnePressure(ctx, key, rows) {
    try {
        var row = _fitPressureCandidate(ctx, key);
        if (!_num(row.aic)) throw new Error('fit produced no finite objective');
        rows.push(row);
        ctx.rowsByKey = ctx.rowsByKey || {};
        ctx.rowsByKey[key] = row;
    } catch (e) {
        ctx.failed.push({ modelKey: key, modelName: PRiSM_modelPlainName(key), error: String(e && e.message || e) });
    }
}

/** Blocking race. See header for the result shape. */
function PRiSM_autoMatchSync(opts) {
    var ctx = _prepare(opts || {});
    if (ctx.error) return _errorResult(ctx);
    if (ctx.opts.classifyOnly) {
        var r0 = _errorResult(ctx); r0.ok = true; r0.error = null; r0.classification = ctx.classification;
        r0.candidateKeys = ctx.candidates || [];
        return r0;
    }
    var pRows = [], rRows = [];
    if (ctx.runPressure) {
        ctx.candidates.forEach(function (key, i) {
            if (typeof ctx.opts.onProgress === 'function') { try { ctx.opts.onProgress(i, ctx.candidates.length, key); } catch (e) {} }
            _raceOnePressure(ctx, key, pRows);
        });
    }
    if (ctx.runRate) rRows = _raceRate(ctx.ds, ctx.rateCandidates, ctx.opts, ctx.useCore, ctx.failed);
    return _finish(ctx, pRows, rRows);
}

/** Race with a yield to the UI between candidates. Resolves with the result. */
function PRiSM_autoMatch(opts) {
    opts = opts || {};
    var ctx;
    try { ctx = _prepare(opts); } catch (e) { return Promise.reject(e); }
    if (ctx.error) return Promise.resolve(_errorResult(ctx));
    if (opts.classifyOnly) return Promise.resolve(PRiSM_autoMatchSync(opts));
    var pRows = [], rRows = [];
    var list = ctx.runPressure ? ctx.candidates.slice() : [];
    var i = 0;
    function _yield() { return new Promise(function (r) { setTimeout(r, 0); }); }
    function _loop() {
        if (i >= list.length) return Promise.resolve();
        // opts.shouldCancel() → stop racing; the models fitted so far are ranked.
        if (typeof opts.shouldCancel === 'function') {
            var stopNow = false;
            try { stopNow = !!opts.shouldCancel(); } catch (e) { stopNow = false; }
            if (stopNow) {
                ctx.warnings.push('Model race cancelled after ' + i + ' of ' + list.length + ' candidates.');
                return Promise.resolve();
            }
        }
        return _yield().then(function () {
            var key = list[i];
            if (typeof opts.onProgress === 'function') { try { opts.onProgress(i, list.length, key); } catch (e) {} }
            _raceOnePressure(ctx, key, pRows);
            i++;
            return _loop();
        });
    }
    return _loop().then(function () {
        if (ctx.runRate) return _yield().then(function () { rRows = _raceRate(ctx.ds, ctx.rateCandidates, opts, ctx.useCore, ctx.failed); });
    }).then(function () { return _finish(ctx, pRows, rRows); });
}


// =========================================================================
// SECTION 8 — APPLY A ROW (propagates everywhere; never writes st.match)
// =========================================================================

function _fmtPhysSummary(row) {
    var ph = row.phys || {};
    if (row.kind === 'rate') {
        var bits = [];
        if (_num(ph.qi)) bits.push('qi ' + _fmt(ph.qi, 4));
        if (_num(ph.Di)) bits.push('Di ' + _fmt(ph.Di, 3) + ' 1/d');
        if (_num(ph.b)) bits.push('b ' + _fmt(ph.b, 3));
        return bits.join(', ');
    }
    var s = [];
    if (_num(ph.k)) s.push('k ' + (ph.k >= 100 ? ph.k.toFixed(0) : ph.k.toFixed(1)) + ' md');
    else if (_num(ph.kh)) s.push('kh ' + _fmt(ph.kh, 3) + ' md·ft');
    if (_num(ph.S)) s.push('S ' + ph.S.toFixed(2));
    if (_num(ph.C)) s.push('C ' + ph.C.toExponential(1) + ' bbl/psi');
    return s.join(', ');
}

function _findRow(rowOrKey, result) {
    if (rowOrKey && typeof rowOrKey === 'object') return rowOrKey;
    var res = result || (G.PRiSM_state && G.PRiSM_state.autoMatch);
    if (!res) return null;
    var lists = [res.ranked || []];
    if (res.decline && res.decline.ranked) lists.push(res.decline.ranked);
    for (var l = 0; l < lists.length; l++) for (var i = 0; i < lists[l].length; i++) {
        if (lists[l][i].modelKey === rowOrKey) return lists[l][i];
    }
    return null;
}

function PRiSM_applyAutoMatchRow(rowOrKey, result, applyOpts) {
    applyOpts = applyOpts || {};
    var row = _findRow(rowOrKey, result);
    if (!row) return null;
    var key = row.modelKey;
    if (!G.PRiSM_state) G.PRiSM_state = { model: key, params: {}, paramFreeze: {}, match: { timeShift: 0, pressShift: 0 } };
    var st = G.PRiSM_state;
    if (typeof G.PRiSM_setModel === 'function') {
        try { G.PRiSM_setModel(key); } catch (e) { st.model = key; }
    } else { st.model = key; }
    st.params = _clone(row.params || {});
    st.phys = _clone(row.phys || {});
    var entry = (G.PRiSM_MODELS || {})[key] || {};
    var frz = {};
    var df = Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : [];
    df.forEach(function (k) { frz[k] = true; });
    st.paramFreeze = frz;
    var fit = _clone(row);
    fit.source = 'automatch';
    fit.model = key;
    if (row.kind !== 'rate' && row.scales && _pos(row.scales.A) && _pos(row.scales.B)) {
        st.tcMatch = { logPM: Math.log10(1 / row.scales.A), logTM: Math.log10(row.scales.B), source: 'automatch' };
    }
    if (typeof G.PRiSM_setLastFit === 'function') {
        try { G.PRiSM_setLastFit(fit); } catch (e) { st.lastFit = fit; }
    } else {
        st.lastFit = fit;
        if (typeof G.PRiSM_interpretCurrentFit === 'function') {
            try { st.interp = G.PRiSM_interpretCurrentFit(); } catch (e) { /* silent */ }
        }
        _dispatch('prism:fit-updated', { source: 'automatch', modelKey: key });
    }
    if (typeof G.PRiSM_evalModelCurve === 'function') {
        try { G.PRiSM_evalModelCurve(key, st.params, { phys: st.phys }); } catch (e) { /* silent */ }
    }
    if (typeof G.PRiSM_drawActivePlot === 'function') {
        try { G.PRiSM_drawActivePlot(); } catch (e) { /* silent */ }
    }
    if (typeof G.PRiSM_saveState === 'function') {
        try { G.PRiSM_saveState(); } catch (e) { /* silent */ }
    }
    var msg = 'Applied ' + PRiSM_modelPlainName(key) + ' — ' + _fmtPhysSummary(row);
    st.autoMatchStatus = msg;
    if (typeof document !== 'undefined' && document.getElementById) {
        var el = document.getElementById('prism_am_status');
        if (el) el.textContent = msg;
    }
    if (!applyOpts.quiet && typeof G.toast === 'function') { try { G.toast(msg, 'success'); } catch (e) {} }
    try {
        if (typeof G.gtag === 'function') G.gtag('event', 'prism_auto_match_apply', { event_category: 'PRiSM', model_key: key });
    } catch (e) { /* silent */ }
    return row;
}


// =========================================================================
// SECTION 9 — PANEL UI ("Recommended models")
// =========================================================================
// Top-3 cards: plain model name, status chip, ΔAIC, R², key physical results
// with ±95 % CI, and a "Use this model" button. Styled with the host theme
// variables; flex-wraps to a single column at phone width.

var PANEL_CSS =
    '.prism-am{display:flex;flex-direction:column;gap:10px;color:var(--text);font-size:13px;min-width:0}' +
    '.prism-am-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '.prism-am-diag{font-size:12px;color:var(--text2);overflow-wrap:anywhere}' +
    '.prism-am-cards{display:flex;flex-wrap:wrap;gap:10px}' +
    '.prism-am-card{flex:1 1 220px;min-width:0;max-width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg2)}' +
    '.prism-am-card--best{border-color:var(--green)}' +
    '.prism-am-card--refine{border-color:var(--yellow)}' +
    '.prism-am-name{font-weight:600;font-size:14px;overflow-wrap:anywhere}' +
    '.prism-am-chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--border);color:var(--text2);white-space:nowrap}' +
    '.prism-am-chip--best{color:var(--green);border-color:var(--green)}' +
    '.prism-am-chip--refine{color:var(--yellow);border-color:var(--yellow)}' +
    '.prism-am-stats{font-size:12px;color:var(--text2);margin-top:4px}' +
    '.prism-am-res{margin-top:6px;font-size:12px;display:grid;grid-template-columns:auto 1fr;gap:2px 8px}' +
    '.prism-am-res span:nth-child(odd){color:var(--text3)}' +
    '.prism-am-res span:nth-child(even){font-family:Menlo,Consolas,monospace;overflow-wrap:anywhere}' +
    '.prism-am-btn{margin-top:8px;padding:6px 12px;font-size:12px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:var(--bg1);color:var(--text)}' +
    '.prism-am-btn--primary{background:var(--accent);border-color:var(--accent);color:#fff}' +
    '.prism-am-warn{font-size:12px;color:var(--yellow)}' +
    '.prism-am-muted{font-size:11px;color:var(--text3)}' +
    '.prism-am-status{font-size:12px;color:var(--green);min-height:16px}';

function _ensureCss() {
    if (typeof document === 'undefined' || !document.getElementById || !document.createElement) return;
    if (document.getElementById('prism_am_css')) return;
    var s = document.createElement('style');
    s.id = 'prism_am_css';
    s.textContent = PANEL_CSS;
    var head = document.head || document.body;
    if (head && head.appendChild) head.appendChild(s);
}

function _ciText(v, ci, digits) {
    if (!_num(v)) return '—';
    var txt = (typeof digits === 'function') ? digits(v) : _fmt(v, 3);
    if (ci && _num(ci[0]) && _num(ci[1])) {
        var half = 0.5 * (ci[1] - ci[0]);
        if (half > 0) txt += ' ± ' + _fmt(half, 2);
    }
    return txt;
}

function _resultRows(row) {
    var ph = row.phys || {}, ci = row.ci95 || {}, out = [];
    if (row.kind === 'rate') {
        Object.keys(ph).forEach(function (k) {
            if (k === 'timeUnit' || !_num(ph[k])) return;
            out.push([k === 'eurAtEnd' ? 'Cum. to end' : k, _ciText(ph[k], ci[k])]);
        });
        return out;
    }
    if (_num(ph.k)) out.push(['k', _ciText(ph.k, ci.k) + ' md']);
    if (_num(ph.kh)) out.push(['kh', _ciText(ph.kh, ci.kh) + ' md·ft']);
    if (_num(ph.S)) out.push(['S', _ciText(ph.S, ci.S, function (v) { return v.toFixed(2); })]);
    else if (row.mode === 'scale') out.push(['S', 'not identifiable (well inputs incomplete)']);
    if (_num(ph.C)) out.push(['C', _ciText(ph.C, ci.C) + ' bbl/psi']);
    if (_num(ph.xf)) out.push(['xf', _ciText(ph.xf, ci.xf) + ' ft']);
    if (_num(ph.Lh)) out.push(['Lh', _ciText(ph.Lh, ci.Lh) + ' ft']);
    if (ph.distances_ft) Object.keys(ph.distances_ft).forEach(function (k) {
        out.push([k + ' distance', _fmt(ph.distances_ft[k], 3) + ' ft']);
    });
    if (row.pRefSource === 'floated' && _num(row.pRef)) out.push(['pi', _fmt(row.pRef, 5) + ' psia']);
    return out;
}

function _cardHTML(row, idx) {
    var cls = row.status === 'best' ? ' prism-am-card--best' : (row.status === 'refine' ? ' prism-am-card--refine' : '');
    var chip = row.status === 'best' ? ' prism-am-chip--best' : (row.status === 'refine' ? ' prism-am-chip--refine' : '');
    var res = _resultRows(row).map(function (p) { return '<span>' + _esc(p[0]) + '</span><span>' + _esc(p[1]) + '</span>'; }).join('');
    var warn = (row.warnings && row.warnings.length) ? '<div class="prism-am-warn">⚠ ' + _esc(row.warnings[0]) + '</div>' : '';
    return '<div class="prism-am-card' + cls + '" data-prism-am-row="' + idx + '" data-prism-am-key="' + _esc(row.modelKey) + '">' +
        '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">' +
            '<span class="prism-am-name">' + _esc(row.modelName || PRiSM_modelPlainName(row.modelKey)) + '</span>' +
            '<span class="prism-am-chip' + chip + '">' + _esc(row.label) + '</span>' +
        '</div>' +
        '<div class="prism-am-stats">ΔAIC ' + (_num(row.dAIC) ? row.dAIC.toFixed(1) : '—') +
            ' · R² ' + (_num(row.r2) ? row.r2.toFixed(4) : '—') +
            ' · ' + (row.converged ? '✓ converged' : 'not converged') +
            (_num(row.iterations) ? ' (' + row.iterations + ' it)' : '') + '</div>' +
        '<div class="prism-am-res">' + res + '</div>' + warn +
        '<button type="button" class="prism-am-btn' + (row.status === 'best' ? ' prism-am-btn--primary' : '') +
            '" data-prism-am-apply="' + _esc(row.modelKey) + '">' +
            (row.status === 'refine' ? 'Use as starting point' : 'Use this model') + '</button>' +
        '</div>';
}

function PRiSM_renderAutoMatchPanel(container, result) {
    if (!container || typeof container.innerHTML !== 'string') return;
    _ensureCss();
    if (result === undefined) result = G.PRiSM_state && G.PRiSM_state.autoMatch;
    var runBtn = '<button type="button" class="prism-am-btn prism-am-btn--primary" id="prism_am_run">Find best model</button>';
    if (!result) {
        container.innerHTML = '<div class="prism-am"><div class="prism-am-muted">Races the likely models against your data in physical units (k, C, S) and ranks them by AIC.</div>' + runBtn + '<div class="prism-am-status" id="prism_am_status"></div></div>';
        _wirePanel(container, null);
        return;
    }
    var h = ['<div class="prism-am">'];
    h.push('<div class="prism-am-head"><strong>Recommended models</strong>' +
           '<span class="prism-am-muted">' + (result.ranked ? result.ranked.length : 0) + ' fitted · ' +
           (_num(result.elapsedMs) ? result.elapsedMs + ' ms' : '') + '</span></div>');
    if (result.classification && result.classification.summary) {
        h.push('<div class="prism-am-diag"><b>Diagnostic:</b> ' + _esc(result.classification.summary) + '</div>');
    }
    (result.warnings || []).slice(0, 3).forEach(function (w) { h.push('<div class="prism-am-warn">⚠ ' + _esc(w) + '</div>'); });
    if (!result.ok || !result.ranked || !result.ranked.length) {
        h.push('<div class="prism-am-warn">No model could be fitted' + (result.error ? ': ' + _esc(result.error) : '.') + '</div>');
    } else {
        h.push('<div class="prism-am-cards">' + result.top.map(_cardHTML).join('') + '</div>');
    }
    if (result.decline && result.decline.top && result.decline.top.length) {
        h.push('<div><strong>Decline models (rate)</strong></div><div class="prism-am-cards">' +
               result.decline.top.map(function (r, i) { return _cardHTML(r, 100 + i); }).join('') + '</div>');
    }
    if (result.failed && result.failed.length) {
        h.push('<div class="prism-am-muted">Could not fit: ' + result.failed.map(function (f) {
            return _esc(f.modelName || f.modelKey);
        }).join(', ') + '</div>');
    }
    h.push('<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
           runBtn.replace('Find best model', 'Run again') +
           '<button type="button" class="prism-am-btn" id="prism_am_choose">Choose models…</button></div>');
    h.push('<div class="prism-am-status" id="prism_am_status">' + _esc((G.PRiSM_state && G.PRiSM_state.autoMatchStatus) || '') + '</div>');
    h.push('</div>');
    container.innerHTML = h.join('');
    _wirePanel(container, result);
}

function _runAndRender(container, opts) {
    var status = container.querySelector ? container.querySelector('#prism_am_status') : null;
    if (status) status.textContent = 'Fitting candidate models…';
    return PRiSM_autoMatch(opts || {}).then(function (res) {
        PRiSM_renderAutoMatchPanel(container, res);
        return res;
    }, function (err) {
        if (status) status.textContent = 'Auto-match failed: ' + String(err && err.message || err);
    });
}

function _wirePanel(container, result) {
    if (!container.querySelectorAll) return;
    var btns = container.querySelectorAll('button[data-prism-am-apply]');
    for (var i = 0; i < btns.length; i++) {
        btns[i].onclick = function (ev) {
            var key = (ev && ev.currentTarget ? ev.currentTarget : this).getAttribute('data-prism-am-apply');
            PRiSM_applyAutoMatchRow(key, result);
        };
    }
    var run = container.querySelector('#prism_am_run');
    if (run) run.onclick = function () { _runAndRender(container, {}); };
    var choose = container.querySelector('#prism_am_choose');
    if (choose) choose.onclick = function () { _openCandidateChooser(container, result); };
}

function _openCandidateChooser(host, prevResult) {
    if (typeof document === 'undefined' || !document.createElement) return;
    _ensureCss();
    var registry = G.PRiSM_MODELS || {};
    var keys = Object.keys(registry).sort(function (a, b) {
        return PRiSM_modelPlainName(a).localeCompare(PRiSM_modelPlainName(b));
    });
    if (!keys.length) return;
    var pre = {};
    if (prevResult && prevResult.ranked) prevResult.ranked.forEach(function (r) { pre[r.modelKey] = true; });
    var old = document.getElementById('prism_am_chooser');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var ov = document.createElement('div');
    ov.id = 'prism_am_chooser';
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';
    var rows = keys.map(function (k) {
        var e = registry[k] || {};
        return '<label style="display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:12px;border-bottom:1px dashed var(--border);">' +
            '<input type="checkbox" data-prism-am-cand value="' + _esc(k) + '"' + (pre[k] ? ' checked' : '') + '>' +
            '<span style="flex:1;min-width:0;overflow-wrap:anywhere;">' + _esc(PRiSM_modelPlainName(k)) + '</span>' +
            '<span style="color:var(--text3);">' + _esc(e.kind === 'rate' ? 'decline' : (e.category || '')) + '</span></label>';
    }).join('');
    ov.innerHTML = '<div style="background:var(--bg1);border:1px solid var(--border);border-radius:10px;width:100%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;color:var(--text);">' +
        '<div style="padding:12px;border-bottom:1px solid var(--border);font-weight:600;">Choose models to compare</div>' +
        '<div style="padding:8px 12px;overflow-y:auto;flex:1;">' + rows + '</div>' +
        '<div style="padding:12px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;">' +
            '<button type="button" class="prism-am-btn" id="prism_am_chooser_cancel">Cancel</button>' +
            '<button type="button" class="prism-am-btn prism-am-btn--primary" id="prism_am_chooser_run">Compare</button></div></div>';
    document.body.appendChild(ov);
    ov.querySelector('#prism_am_chooser_cancel').onclick = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
    ov.querySelector('#prism_am_chooser_run').onclick = function () {
        var picked = [];
        var boxes = ov.querySelectorAll('input[data-prism-am-cand]');
        for (var b = 0; b < boxes.length; b++) if (boxes[b].checked) picked.push(boxes[b].value);
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        if (picked.length) _runAndRender(host, { candidates: picked });
    };
}


// =========================================================================
// SECTION 10 — EXPORTS
// =========================================================================

G.PRiSM_classifyRegimes      = PRiSM_classifyRegimes;
G.PRiSM_autoMatch            = PRiSM_autoMatch;
G.PRiSM_autoMatchSync        = PRiSM_autoMatchSync;
G.PRiSM_applyAutoMatchRow    = PRiSM_applyAutoMatchRow;
G.PRiSM_suggestInitialParams = PRiSM_suggestInitialParams;
G.PRiSM_renderAutoMatchPanel = PRiSM_renderAutoMatchPanel;
G.PRiSM_modelPlainName       = PRiSM_modelPlainName;
// Internal hooks for the acceptance tests (not a public contract).
G.PRiSM__autoMatchInternals  = { localPM: _localPM, localAnalysisData: _localAnalysisData, bourdet: _bourdet };

// A ranking belongs to the data and flow period it was run on: drop it when
// either changes, so the report's model comparison and the Recommended strip
// never show another dataset's ΔAIC.
if (typeof G.addEventListener === 'function' && !G.__PRiSM_amStaleListener) {
    G.__PRiSM_amStaleListener = true;
    ['prism:dataset-loaded', 'prism:dataset-cleared', 'prism:period-changed'].forEach(function (type) {
        G.addEventListener(type, function () {
            try {
                var st = G.PRiSM_state;
                if (st && typeof st === 'object') { st.autoMatch = null; if (st.lastAutoMatch) st.lastAutoMatch = null; }
                if (G.PRiSM_lastAutoMatch) G.PRiSM_lastAutoMatch = null;
            } catch (e) { /* silent */ }
        });
    });
}


// =========================================================================
// === SELF-TEST ===
// =========================================================================
(function _selfTest() {
    var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
    var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
    var results = [];
    function check(name, fn) {
        try { results.push({ name: name, ok: !!fn() }); }
        catch (e) { results.push({ name: name, ok: false, msg: e && e.message }); }
    }
    // 1. Flat-ish data returns at least one regime.
    check('classifier returns regimes on smooth data', function () {
        var t = [], p = [];
        for (var i = 0; i < 30; i++) { t.push(Math.pow(10, -2 + i * 0.2)); p.push(2500 + 10 * Math.log10(t[i] + 0.01)); }
        var c = PRiSM_classifyRegimes(t, p);
        return c.regimes.length >= 1 && c.candidates.length >= 1;
    });
    // 2. Derivative doubling → fault candidate.
    check('classifier flags derivative doubling', function () {
        var t = [], p = [];
        for (var j = 0; j < 50; j++) {
            var tt = Math.pow(10, -1 + j * 0.12); t.push(tt);
            var dp = 0.5 * Math.log(tt) + 5; if (tt > 20) dp += 0.5 * Math.log(tt / 20);
            p.push(2500 + dp);
        }
        var c = PRiSM_classifyRegimes(t, p);
        return c.regimes.some(function (r) { return r.tag === 'sealingFault'; }) ||
               c.candidates.indexOf('linearBoundary') !== -1 || c.candidates.indexOf('parallelChannel') !== -1;
    });
    // 3. Storage hump (falling limb straight after the maximum) is not spherical flow.
    check('falling limb after the maximum is a storage hump', function () {
        var t = [], d = [], p = [];
        for (var k = 0; k < 40; k++) {
            var x = -2 + k * 0.1; t.push(Math.pow(10, x));
            // Hump at x = -1.5 decaying with slope −0.5 to a plateau from x ≈ 0.
            var lvl = x < -1.5 ? 1 + (x + 2) * 2 : Math.max(0, 1 - 0.5 * (x + 1.5));
            d.push(Math.pow(10, lvl) * 0.5 + 0.5);
            p.push(0);
        }
        var c = PRiSM_classifyRegimes(t, p, d);
        return c.regimes.every(function (r) { return r.tag !== 'sphericalFlow'; }) &&
               /storage/i.test(c.summary);
    });
    // 4. Plain names never empty.
    check('plain model names', function () {
        return PRiSM_modelPlainName('homogeneous') === 'Homogeneous reservoir' &&
               PRiSM_modelPlainName('someNewModel') === 'Some new model';
    });
    var fails = results.filter(function (r) { return !r.ok; });
    if (fails.length) err('PRiSM 13 (auto-match) self-test FAILED:', fails);
    else log('PRiSM 13 (auto-match) self-test passed (' + results.length + ' checks).');
    try { G.PRiSM_autoMatch_selfTest = results; } catch (e) { /* silent */ }
})();

})();
