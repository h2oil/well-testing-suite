// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 14 — Plain-English Interpretation
//   Turns the current fit (C4 lastFit: physical k, C, S + dimensionless
//   shape parameters + CIs) into a narrative with honest precision,
//   qualitative tags, skin-based actions and cautions.
// ────────────────────────────────────────────────────────────────────
//
// Public API (all on window.*):
//   PRiSM_interpretFit(modelKey, params, CI95, fitMeta?) -> Interp
//   PRiSM_interpretCurrentFit()                          -> Interp | null  (pure)
//   PRiSM_refreshInterpretation()                        -> Interp | null  (writes st.interp)
//   PRiSM_renderInterpretationPanel(container, interp?)  -> void
//   PRiSM_buildNarrative(tags, modelKey, ctx)            -> string
//   PRiSM_formatWithCI(value, halfWidth, unit?)          -> '45.0 ± 0.3 md'
//
// Interp = { tags, narrative, headline, actions, confidence, cautions,
//            skin:{S_total, S_pseudo, S_mech, Sf, FE, DR, dpS, J, J_ideal, rwEff},
//            modelKey, source, timestamp }
//
// fitMeta (all optional): { r2, dAIC (margin to runner-up), iterations,
//   secondModelKey, lateRMSE, phys:{k,kh,C,Cd,S,pi,rinv,…}, identifiable:{},
//   well:{q,B,mu,rw,h,…}, pwf, pbar, testType, source, stale, mode }
//
// Skin rules (actions keyed on the MECHANICAL skin S_mech = S_total − pseudo-skins):
//   S_mech 2–5            → consider an acid wash
//   S_mech 5–10           → remedial treatment recommended (moderate)
//   S_mech > 10 or FE < ½ → stimulation strongly indicated
//   S < −4 in a radial model → rw′ > 50·rw, try a fracture model
//   Sf > 0.5              → fracture-face damage
//   "No workover" reassurance only when EVERY skin term is acceptable.
//
// Conventions: single outer IIFE; window.PRiSM_* only; no external deps;
// defensive against missing models / lastFit / DOM; self-test at the end.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});
var _hasDoc = (typeof document !== 'undefined');

function _num(v) { return typeof v === 'number' && isFinite(v); }
function _pos(v) { return typeof v === 'number' && isFinite(v) && v > 0; }

// Compact in-prose number formatter.
function _prose(n) {
    if (n == null || !isFinite(n)) return '—';
    var v = Number(n), a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10)  return v.toFixed(1);
    if (a >= 1)   return v.toFixed(2);
    return v.toFixed(3);
}

// Honest precision: round the half-width to 1 significant figure (2 when it
// starts with a 1) and the value to the same decimal place.
function _decimalsFor(half) {
    if (!_pos(half)) return null;
    var e = Math.floor(Math.log10(half));
    var lead = half / Math.pow(10, e);
    var sig = lead < 1.95 ? 2 : 1;
    return Math.max(0, -(e - sig + 1));
}

function PRiSM_formatWithCI(v, half, unit) {
    if (!_num(v)) return '—';
    var u = unit ? ' ' + unit : '';
    var a = Math.abs(v);
    if (_pos(half)) {
        if (half >= a && a > 0) return '≈' + _sig(v, 1) + u + ' (poorly constrained)';
        if (a !== 0 && (a < 1e-3 || a >= 1e6)) {
            var relDigits = Math.max(1, Math.min(4, Math.ceil(Math.log10(a / half)) + 1));
            return v.toExponential(relDigits - 1) + ' ± ' + half.toExponential(0) + u;
        }
        var d = _decimalsFor(half);
        if (d > 6) d = 6;
        return v.toFixed(d) + ' ± ' + half.toFixed(d) + u;
    }
    return _sig(v, 3) + u;
}

function _sig(v, n) {
    if (!_num(v)) return '—';
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a < 1e-3 || a >= 1e6) return v.toExponential(Math.max(0, n - 1));
    var d = Math.max(0, n - 1 - Math.floor(Math.log10(a)));
    return v.toFixed(Math.min(6, d));
}

function _half(range) {
    if (!range || !_num(range[0]) || !_num(range[1])) return NaN;
    return 0.5 * Math.abs(range[1] - range[0]);
}


// ════════════════════════════════════════════════════════════════════
// SECTION 1 — PARAM-TO-TAG RULES
// ════════════════════════════════════════════════════════════════════
// Severity ladder: 'good' | 'normal' | 'warning' | 'important'

var SKIN_BUCKETS = [
    [-5,        'highly stimulated',         'good',      'a highly stimulated completion'],
    [-2,        'effectively stimulated',    'good',      'an effectively stimulated completion'],
    [ 0,        'mildly stimulated',         'good',      'a mildly stimulated completion'],
    [ 2,        'no significant skin',       'normal',    'no significant skin'],
    [ 5,        'mildly damaged',            'warning',   'mild damage near the wellbore'],
    [10,        'damaged',                   'warning',   'moderate damage near the wellbore'],
    [Infinity,  'severely damaged',          'important', 'severe damage near the wellbore']
];
var CD_BUCKETS = [
    [50,        'low WBS',                                          'normal',    'low wellbore storage'],
    [500,       'typical WBS',                                      'normal',    'typical wellbore storage'],
    [5000,      'high WBS — masks early-time response',             'warning',   'high wellbore storage that masks the early-time response'],
    [Infinity,  'very high WBS — consider downhole shut-in',        'important', 'very high wellbore storage']
];
var KH_BUCKETS = [
    [10,        'very low productivity',  'warning',   'very low'],
    [100,       'low productivity',       'normal',    'low'],
    [1000,      'moderate productivity',  'normal',    'moderate'],
    [10000,     'high productivity',      'good',      'high'],
    [Infinity,  'very high productivity', 'good',      'very high']
];
var OMEGA_BUCKETS = [
    [0.01,      'fracture-dominated storage (matrix mostly drains)',          'normal',
                'fracture-dominated storage with matrix that mostly drains into the fractures'],
    [0.1,       'natural fractures with significant matrix storage',          'normal',
                'a naturally fractured response with significant matrix storage'],
    [0.5,       'partially fractured',                                         'normal',
                'a partially fractured system'],
    [Infinity,  'weak fracture signature — consider homogeneous instead',     'warning',
                'a weak fracture signature; the response is close to homogeneous']
];
var LAMBDA_BUCKETS = [
    [1e-8,      'very slow matrix-fracture transfer',              'normal', 'very slow matrix-to-fracture transfer'],
    [1e-5,      'typical NF transfer',                              'normal', 'typical naturally fractured transfer'],
    [Infinity,  'fast transfer — close to homogeneous behaviour',  'normal', 'fast matrix-to-fracture transfer (close to homogeneous behaviour)']
];
var XF_BUCKETS = [
    [30,        'short fracture — possible re-frac candidate',     'warning', 'a short fracture half-length'],
    [100,       'moderate fracture half-length',                    'normal',  'a moderate fracture half-length'],
    [300,       'effective fracture stimulation',                   'good',    'effective fracture stimulation'],
    [Infinity,  'very long fracture — confirm propagation model',  'good',    'a very long fracture']
];
var LATERAL_BUCKETS = [
    [500,       'short lateral',                          'normal', 'a short lateral'],
    [3000,      'typical horizontal completion',          'normal', 'a typical horizontal completion'],
    [Infinity,  'long lateral / multi-stage completion',  'normal', 'a long, multi-stage horizontal completion']
];
var FCD_BUCKETS = [
    [1,         'low FcD — fracture-face limited',         'warning', 'low fracture conductivity (fracture-face limited)'],
    [30,        'finite-conductivity fracture',            'normal',  'a finite-conductivity fracture'],
    [300,       'effectively infinite-conductivity',       'good',    'a high-conductivity fracture (effectively infinite)'],
    [Infinity,  'fully conductive fracture',               'good',    'a fully conductive fracture']
];
var SF_BUCKETS = [
    [0.5,       'clean fracture face',       'normal',  'a clean fracture face'],
    [Infinity,  'fracture-face damage',      'warning', 'fracture-face damage']
];

function _bucketLookup(buckets, v) {
    if (!isFinite(v)) return null;
    for (var i = 0; i < buckets.length; i++) {
        if (v < buckets[i][0]) return { qualitative: buckets[i][1], severity: buckets[i][2], hint: buckets[i][3] };
    }
    return null;
}

function _ruleBoundaryL(v, label, unitFt) {
    if (!isFinite(v)) return null;
    var name = label || 'Boundary';
    var lname = name.toLowerCase();
    // Distances in ft when known (phys.distances_ft), else in the model's own units.
    var near = unitFt ? 150 : 100, mid = unitFt ? 600 : 500, far = unitFt ? 3000 : 2000;
    if (v < near)  return { qualitative: name + ' very close — recheck data quality', severity: 'warning',
                            hint: lname + ' very close to the wellbore — data quality should be re-checked' };
    if (v < mid)   return { qualitative: 'near ' + lname + ' detected', severity: 'important',
                            hint: 'a near ' + lname + ' is detected' };
    if (v < far)   return { qualitative: name + ' detected at moderate distance', severity: 'important',
                            hint: 'a ' + lname + ' is detected at moderate distance' };
    return { qualitative: 'far ' + lname + ' — late-time signal only', severity: 'normal',
             hint: 'a far ' + lname + ' is hinted by the late-time signal' };
}

var BOUNDARY_KEYS = {
    'L': 'Boundary', 'dF': 'Boundary', 'dF1': 'Fault 1', 'dF2': 'Fault 2', 'dEnd': 'End',
    'dN': 'North boundary', 'dS': 'South boundary', 'dE': 'East boundary', 'dW': 'West boundary'
};
var SKIN_KEYS = { S: 1, S_perf: 1, S_global: 1, S_mech: 1, Sf: 1 };

function _ruleForKey(key, value) {
    if (key === 'S' || key === 'S_global' || key === 'S_perf' || key === 'S_mech') return _bucketLookup(SKIN_BUCKETS, value);
    if (key === 'Sf')                              return _bucketLookup(SF_BUCKETS, value);
    if (key === 'Cd')                              return _bucketLookup(CD_BUCKETS, value);
    if (key === 'kh')                              return _bucketLookup(KH_BUCKETS, value);
    if (key === 'omega')                           return _bucketLookup(OMEGA_BUCKETS, value);
    if (key === 'lambda')                          return _bucketLookup(LAMBDA_BUCKETS, value);
    if (key === 'xf')                              return _bucketLookup(XF_BUCKETS, value);
    if (key === 'FcD')                             return _bucketLookup(FCD_BUCKETS, value);
    if (key === 'Lh' || key === 'Llat')            return _bucketLookup(LATERAL_BUCKETS, value);
    if (BOUNDARY_KEYS.hasOwnProperty(key))         return _ruleBoundaryL(value, BOUNDARY_KEYS[key], false);
    return null;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 2 — MODEL HELPERS
// ════════════════════════════════════════════════════════════════════

function _entry(modelKey) { return (G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]) || null; }

function _plainName(modelKey) {
    if (typeof G.PRiSM_modelPlainName === 'function') {
        try { var n = G.PRiSM_modelPlainName(modelKey); if (n) return n; } catch (e) { /* ignore */ }
    }
    return modelKey || 'model';
}

function _modelCategoryOpening(modelKey) {
    var spec = _entry(modelKey);
    var cat = spec && spec.category;
    if (modelKey === 'homogeneous' || cat === 'homogeneous') return 'a radial-flow (homogeneous reservoir) response';
    if (!cat) return null;
    if (cat === 'fracture')      return 'a hydraulically fractured response';
    if (cat === 'boundary')      return 'a bounded reservoir response';
    if (cat === 'composite')     return 'a composite (radial-discontinuity) response';
    if (cat === 'multilayer')    return 'a multi-layer response';
    if (cat === 'multilateral')  return 'a multilateral / branched response';
    if (cat === 'interference')  return 'an interference-test response';
    if (cat === 'decline')       return 'a production-decline signature';
    if (cat === 'special')       return 'a specialised flow regime';
    if (cat === 'reservoir')     return 'a naturally fractured reservoir response';
    if (cat === 'well-type')     return 'a ' + _plainName(modelKey).toLowerCase() + ' response';
    return null;
}

// A radial model has no fracture / lateral reference length.
function _isRadialModel(modelKey, params) {
    var e = _entry(modelKey);
    var cat = e && e.category;
    if (cat === 'fracture' || cat === 'multilateral' || cat === 'decline') return false;
    if (e && e.refLength && e.refLength !== 'rw') return false;
    if (params && (_num(params.xf) || _num(params.Lh) || _num(params.FcD))) return false;
    if (modelKey === 'horizontal' || modelKey === 'inclined') return false;
    return true;
}

function _paramMeta(modelKey, key) {
    var spec = _entry(modelKey);
    if (!spec || !spec.paramSpec) return { unit: '', label: key };
    for (var i = 0; i < spec.paramSpec.length; i++) if (spec.paramSpec[i].key === key) return spec.paramSpec[i];
    return { unit: '', label: key };
}

function _makeTag(key, value, range, rule, extra) {
    var t = { param: key, value: value, range: range || [NaN, NaN],
              qualitative: rule.qualitative, severity: rule.severity, hint: rule.hint };
    if (extra) for (var k in extra) t[k] = extra[k];
    return t;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 3 — SKIN ANALYSIS (S_total → S_mech, FE / DR)
// ════════════════════════════════════════════════════════════════════

function _skinAnalysis(modelKey, params, meta) {
    var phys = meta.phys || {};
    var entry = _entry(modelKey) || {};
    var out = { S_total: NaN, S_pseudo: 0, S_mech: NaN, Sf: NaN, FE: NaN, DR: NaN, dpS: NaN,
                J: NaN, J_ideal: NaN, rwEff: NaN, hasPseudo: false, source: null };
    var Sfit;
    // Scale mode (φ, ct or rw missing): params.S is only the curve's skin at the
    // arbitrary reference Cd, not a result. Skin comes from phys.S (null) only.
    if (meta.mode === 'scale') {
        if (_num(phys.S)) Sfit = phys.S;
    } else if (_num(params.S)) Sfit = params.S;
    else if (_num(params.S_perf) || _num(params.S_global)) Sfit = (params.S_perf || 0) + (params.S_global || 0);
    else if (_num(phys.S)) Sfit = phys.S;
    if (!_num(Sfit)) return out;
    if (_num(params.Sf)) out.Sf = params.Sf;
    var well = meta.well || {};
    var g0 = meta.geom || {};
    var geom = { h: _num(g0.h) ? g0.h : well.h, rw: _num(g0.rw) ? g0.rw : well.rw,
                 hp: _num(g0.hp) ? g0.hp : well.hp, kvkh: _num(g0.kvkh) ? g0.kvkh : params.KvKh,
                 theta: _num(g0.theta) ? g0.theta : params.theta_deg, xf: phys.xf };

    // Three cases (plan §4: pseudo-skin models already separate Sg internally):
    //  (a) registry pseudoSkin metadata → fitted skin is mechanical,
    //      S_total = S_fit + pseudoSkin(params);
    //  (b) S_perf / S_global models without metadata → fitted skin is
    //      mechanical; the internal geometric term is not reported;
    //  (c) plain-S models → fitted skin is TOTAL; decompose only when the
    //      user supplied partial-penetration / slant geometry or D·q.
    var separates = params.S_perf != null || params.S_global != null;
    var pseudo = NaN;
    if (typeof entry.pseudoSkin === 'function') {
        try { pseudo = entry.pseudoSkin(params, geom); } catch (e) { pseudo = NaN; }
    }
    var decomposed = false;
    var hasGeom = (_pos(geom.hp) && _pos(geom.h) && geom.hp < geom.h) || (_num(geom.theta) && geom.theta !== 0) ||
                  (_num(meta.D) && _pos(well.q));
    if (!_num(pseudo) && !separates && hasGeom && typeof G.PRiSM_skinDecomposition === 'function') {
        try {
            var dec = G.PRiSM_skinDecomposition({ S_total: Sfit, modelKey: modelKey, params: params, geom: geom,
                                                  D: meta.D, q: well.q });
            if (dec && _num(dec.S_mech)) {
                out.S_total = Sfit;
                out.S_mech = dec.S_mech;
                out.S_pseudo = Sfit - dec.S_mech;
                out.hasPseudo = Math.abs(out.S_pseudo) > 1e-6;
                decomposed = true;
            }
        } catch (e) { /* fall back */ }
    }
    if (!decomposed) {
        out.S_pseudo = _num(pseudo) ? pseudo : 0;
        out.S_mech = Sfit;
        out.S_total = Sfit + out.S_pseudo;
        out.hasPseudo = _num(pseudo) && Math.abs(pseudo) > 1e-6;
    }
    if (_pos(well.rw)) out.rwEff = well.rw * Math.exp(-out.S_total);

    // FE / DR / ΔpS (on the mechanical, i.e. removable, skin).
    var kh = _num(phys.kh) ? phys.kh : (_num(phys.k) && _pos(well.h) ? phys.k * well.h : NaN);
    var pbar = _num(meta.pbar) ? meta.pbar : (_num(phys.pi) ? phys.pi : well.pi);
    var pwf = meta.pwf;
    var args = { S: out.S_mech, kh: kh, k: phys.k, q: well.q, B: well.B, mu: well.mu, rw: well.rw,
                 pbar: pbar, pwf: pwf, testType: meta.testType, CD: phys.Cd };
    var ss = null;
    if (typeof G.PRiSM_skinSummary === 'function' && _pos(kh)) {
        try { ss = G.PRiSM_skinSummary(args); } catch (e) { ss = null; }
    }
    function pick(o, names) {
        if (!o) return NaN;
        for (var i = 0; i < names.length; i++) if (_num(o[names[i]])) return o[names[i]];
        return NaN;
    }
    out.FE = pick(ss, ['FE', 'fe']);
    out.DR = pick(ss, ['DR', 'dr']);
    out.dpS = pick(ss, ['dpS', 'dPs', 'deltaPs', 'dpSkin', 'dps']);
    out.J = pick(ss, ['J']);
    out.J_ideal = pick(ss, ['J_ideal', 'Jideal']);
    if (ss) out.source = 'skinSummary';
    if (!_num(out.FE) && _pos(kh) && _pos(well.q) && _pos(well.B) && _pos(well.mu) && _num(pbar) && _num(pwf)) {
        var dd = Math.abs(pbar - pwf);
        if (dd > 0) {
            out.dpS = 141.2 * well.q * well.B * well.mu * out.S_mech / kh;
            out.FE = (dd - out.dpS) / dd;
            out.DR = out.FE !== 0 ? 1 / out.FE : NaN;
            out.J = well.q / dd;
            out.J_ideal = (dd - out.dpS) > 0 ? well.q / (dd - out.dpS) : NaN;
            out.source = 'local';
        }
    }
    if (!_num(out.DR) && _num(out.FE) && out.FE !== 0) out.DR = 1 / out.FE;
    return out;
}

function _skinActions(skin, modelKey, params) {
    var actions = [];
    var Sm = skin.S_mech;
    if (!_num(Sm)) return actions;
    var feLow = _num(skin.FE) && skin.FE < 0.5;
    var smTxt = Sm.toFixed(1);
    if (Sm > 10 || feLow) {
        actions.push('Stimulation strongly indicated — mechanical skin ' + smTxt +
                     (feLow ? ' and flow efficiency ' + Math.round(100 * skin.FE) + '%' : '') +
                     ' (matrix acid or re-perforation)');
    } else if (Sm >= 5) {
        actions.push('Remedial treatment recommended (moderate damage, mechanical skin ' + smTxt + ')');
    } else if (Sm >= 2) {
        actions.push('Consider an acid wash if production targets are unmet (mild damage, mechanical skin ' + smTxt + ')');
    }
    if (_num(skin.S_total) && skin.S_total < -4 && _isRadialModel(modelKey, params)) {
        var ratio = Math.exp(-skin.S_total);
        actions.push('Effective wellbore radius rw′ ≈ ' + (ratio >= 100 ? ratio.toFixed(0) : ratio.toFixed(1)) +
                     '·rw (> 50·rw) — try a fracture model');
    }
    if (_num(skin.Sf) && skin.Sf > 0.5) {
        actions.push('Fracture-face damage (Sf = ' + skin.Sf.toFixed(2) + ') — consider a fracture clean-up or re-stimulation');
    }
    return actions;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 4 — OTHER ACTIONS
// ════════════════════════════════════════════════════════════════════

var ACTION_TEMPLATES = [
    { match: /very high WBS/i,                action: 'Use a downhole shut-in for the next test' },
    { match: /near .* detected|detected at/i, action: 'Confirm the boundary against seismic / well-spacing geometry; revise rate planning' },
    { match: /very close/i,                   action: 'Re-examine the early-time data — a very close boundary may be a gauge or data artefact' },
    { match: /short fracture/i,               action: 'Evaluate as a re-fracture candidate' },
    { match: /^high WBS/i,                    action: 'Future tests: downhole shut-in or a longer buildup' },
    { match: /low productivity/i,             action: 'Confirm completion efficiency; consider re-perforation or stimulation' },
    { match: /weak fracture signature/i,      action: 'Re-fit as homogeneous and compare AIC' },
    { match: /low FcD/i,                      action: 'Investigate fracture clean-up or proppant pack quality' }
];

function _actionsForTags(tags) {
    var out = [];
    for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        if (SKIN_KEYS[t.param]) continue;        // skin handled by _skinActions
        if (t.severity !== 'warning' && t.severity !== 'important') continue;
        for (var j = 0; j < ACTION_TEMPLATES.length; j++) {
            if (ACTION_TEMPLATES[j].match.test(t.qualitative)) {
                if (out.indexOf(ACTION_TEMPLATES[j].action) < 0) out.push(ACTION_TEMPLATES[j].action);
                break;
            }
        }
    }
    return out;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 5 — CONFIDENCE
// ════════════════════════════════════════════════════════════════════
//   high   : R² ≥ 0.99 AND all CIs < 30 % AND (margin to runner-up > 10 or unknown)
//   medium : R² ≥ 0.95
//   low    : R² < 0.95 OR any CI > 100 % OR margin < 2 OR not converged

function _ciFractionalWidth(value, range) {
    if (!range || !isFinite(range[0]) || !isFinite(range[1])) return Infinity;
    if (!isFinite(value)) return Infinity;
    var halfWidth = 0.5 * (range[1] - range[0]);
    if (Math.abs(value) < 1) return Math.abs(halfWidth);      // skin-like values near zero
    return Math.abs(halfWidth / value);
}

function _confidenceLevel(tags, fitMeta) {
    var r2 = (fitMeta && isFinite(fitMeta.r2)) ? fitMeta.r2 : NaN;
    var dAIC = (fitMeta && isFinite(fitMeta.dAIC)) ? fitMeta.dAIC : NaN;
    var withCI = tags.filter(function (t) { return t.range && isFinite(t.range[0]) && isFinite(t.range[1]); });
    var widths = withCI.map(function (t) { return _ciFractionalWidth(t.value, t.range); });
    var anyVeryWide = widths.some(function (w) { return w > 1.0; });
    var allTight = widths.length > 0 && widths.every(function (w) { return w < 0.30; });
    if (fitMeta && fitMeta.converged === false) return 'low';
    if (isFinite(r2) && r2 < 0.95) return 'low';
    if (anyVeryWide) return 'low';
    if (isFinite(dAIC) && dAIC < 2) return 'low';
    if ((!isFinite(r2) || r2 >= 0.99) && allTight && (!isFinite(dAIC) || dAIC > 10)) return 'high';
    return 'medium';
}

function _confidenceVerb(level) {
    if (level === 'high')   return 'shows';
    if (level === 'medium') return 'is consistent with';
    return 'tentatively suggests';
}

function _confidenceStatement(level) {
    if (level === 'high')   return 'Confidence in this interpretation is high';
    if (level === 'medium') return 'Confidence is moderate — longer flow periods would tighten the ranges';
    return 'Confidence is low — treat this interpretation as preliminary';
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6 — NARRATIVE
// ════════════════════════════════════════════════════════════════════

function _findTag(tags, key) {
    for (var i = 0; i < tags.length; i++) if (tags[i].param === key) return tags[i];
    return null;
}
function _findSkinTag(tags) {
    return _findTag(tags, 'S_mech') || _findTag(tags, 'S') || _findTag(tags, 'S_perf') || _findTag(tags, 'S_global');
}
function _findBoundaryTags(tags) {
    return tags.filter(function (t) { return BOUNDARY_KEYS.hasOwnProperty(t.param); });
}

function _valueWithCI(tag, modelKey) {
    var meta = _paramMeta(modelKey, tag.param);
    var unit = (meta.unit && meta.unit !== '-') ? meta.unit : '';
    if (tag.identifiable === false) return tag.param + ' ≈ ' + _sig(tag.value, 2) + (unit ? ' ' + unit : '') + ' (not resolved)';
    return tag.param + ' = ' + PRiSM_formatWithCI(tag.value, _half(tag.range), unit);
}

function _capitalize(s) { return (s && s.length) ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

G.PRiSM_buildNarrative = function PRiSM_buildNarrative(tags, modelKey, ctx) {
    ctx = ctx || {};
    if (!tags || !tags.length) {
        if (ctx.phys && _num(ctx.phys.kh)) tags = [];
        else return 'No interpretable parameters were extracted from this fit.';
    }
    var conf = ctx.confidence || 'medium';
    var verb = _confidenceVerb(conf);
    var modelKnown = !!_entry(modelKey);
    var phys = ctx.phys || {};
    var ci = ctx.ci95 || {};
    var ident = ctx.identifiable || {};
    var skin = ctx.skin || {};
    var clauses = [];

    var skinTag = _findSkinTag(tags);
    var openCat = modelKnown ? _modelCategoryOpening(modelKey) : null;
    var skinPart = '';
    if (skinTag) {
        skinPart = skinTag.hint + ' (' + _valueWithCI(skinTag, modelKey) + ')';
    }
    if (openCat) {
        clauses.push('This well ' + verb + ' ' + openCat + (skinPart ? ' with ' + skinPart : '') + '.');
    } else if (skinPart) {
        clauses.push('This well ' + verb + ' ' + skinPart + '.');
    } else {
        clauses.push('Fitted parameters are described below.');
    }
    if (skin.hasPseudo && _num(skin.S_total) && _num(skin.S_mech)) {
        clauses.push('The total skin of ' + skin.S_total.toFixed(2) + ' includes ' + skin.S_pseudo.toFixed(2) +
                     ' of geometric (pseudo-)skin, leaving a mechanical skin of ' + skin.S_mech.toFixed(2) + '.');
    }

    // Permeability / productivity in field units.
    if (_num(phys.k)) {
        var kTxt = ident.k === false ? '≈' + _sig(phys.k, 2) + ' md (not resolved)'
                                     : PRiSM_formatWithCI(phys.k, _half(ci.k), 'md');
        var khTxt = _num(phys.kh) ? ' (kh ' + PRiSM_formatWithCI(phys.kh, _half(ci.kh), 'md·ft') + ')' : '';
        var khTag = _findTag(tags, 'kh');
        clauses.push('Permeability is ' + kTxt + khTxt + (khTag ? ', ' + khTag.hint + ' productivity' : '') + '.');
    } else if (_num(phys.kh)) {
        clauses.push('Flow capacity kh is ' + PRiSM_formatWithCI(phys.kh, _half(ci.kh), 'md·ft') + '.');
    }

    var cdTag = _findTag(tags, 'Cd');
    if (cdTag) {
        var cTxt = _num(phys.C) ? 'C ' + PRiSM_formatWithCI(phys.C, _half(ci.C), 'bbl/psi') + ', ' : '';
        clauses.push('Wellbore storage is ' + cdTag.hint + ' (' + cTxt + 'Cd ≈ ' + _sig(cdTag.value, 2) + ').');
    }

    // Flow efficiency wording.
    if (_num(skin.FE) && skin.FE > 0) {
        var fePct = Math.round(100 * skin.FE);
        var gain = _num(skin.DR) ? Math.round(100 * (skin.DR - 1)) : NaN;
        var txt = 'The well flows at ' + fePct + '% of its undamaged potential (FE ' + fePct + '%';
        if (_num(skin.DR)) txt += ', DR ' + skin.DR.toFixed(2);
        txt += ')';
        if (_num(gain) && gain > 0) {
            txt += '; removing the skin would add ≈' + gain + '% rate';
            if (_num(skin.dpS)) txt += ' (skin pressure drop ≈' + _sig(skin.dpS, 3) + ' psi)';
        } else if (_num(gain) && gain < 0) {
            txt += '; the completion outperforms an undamaged well by ≈' + Math.abs(gain) + '%';
        }
        clauses.push(txt + '.');
    }

    _findBoundaryTags(tags).forEach(function (bt) {
        var dFt = phys.distances_ft && phys.distances_ft[bt.param];
        var hintAct = '';
        if (bt.severity === 'important') hintAct = ' — confirm against geology before extending production at this rate';
        else if (bt.severity === 'warning') hintAct = ' — verify data quality at the early-time end of the test';
        var where = _num(dFt) ? (' about ' + _sig(dFt, 2) + ' ft') : (' at ' + _prose(bt.value) + ' (model units)');
        if (bt.identifiable === false) {
            clauses.push('A ' + (BOUNDARY_KEYS[bt.param] || 'boundary').toLowerCase() + ' is not resolved by the data (beyond the radius investigated).');
        } else {
            clauses.push(_capitalize(bt.hint) + where + ' from the wellbore' + hintAct + '.');
        }
    });

    var xfTag = _findTag(tags, 'xf');
    if (xfTag) clauses.push(_capitalize(xfTag.hint) + ' is observed (xf ' + PRiSM_formatWithCI(xfTag.value, _half(xfTag.range), 'ft') + ').');
    var fcdTag = _findTag(tags, 'FcD');
    if (fcdTag) clauses.push('The data show ' + fcdTag.hint + ' (FcD ≈ ' + _sig(fcdTag.value, 2) + ').');
    var sfTag = _findTag(tags, 'Sf');
    if (sfTag && sfTag.severity !== 'normal') clauses.push('There is ' + sfTag.hint + ' (Sf = ' + sfTag.value.toFixed(2) + ').');

    var omegaTag = _findTag(tags, 'omega'), lambdaTag = _findTag(tags, 'lambda');
    if (omegaTag || lambdaTag) {
        var parts = [];
        if (omegaTag)  parts.push(omegaTag.hint  + ' (ω ≈ ' + _sig(omegaTag.value, 2) + ')');
        if (lambdaTag) parts.push(lambdaTag.hint + ' (λ ≈ ' + _sig(lambdaTag.value, 2) + ')');
        clauses.push('The dual-porosity signature shows ' + parts.join(' and ') + '.');
    }
    var lhTag = _findTag(tags, 'Lh') || _findTag(tags, 'Llat');
    if (lhTag) clauses.push('Completion length is consistent with ' + lhTag.hint + '.');

    if (_num(phys.rinv)) clauses.push('The test investigated about ' + _sig(phys.rinv, 2) + ' ft from the well.');

    clauses.push(_confidenceStatement(conf) + '.');
    if (!modelKnown) clauses.push('Note: model "' + (modelKey || '?') + '" is not in the PRiSM registry — this is a generic interpretation.');
    return clauses.join(' ');
};

function _headline(skin, tags, modelKey, fitMeta) {
    var parts = [];
    var st = _findSkinTag(tags);
    fitMeta = fitMeta || {};
    if (fitMeta.mode === 'scale') {
        parts.push(_plainName(modelKey));
        parts.push('skin not identifiable (enter φ, ct, rw)');
    } else if (st) {
        var q = st.qualitative;
        var label = /damaged/.test(q) ? _capitalize(q) + ' well' : (/stimulated/.test(q) ? _capitalize(q) + ' well' : 'No significant skin');
        parts.push(label + ' (S ' + (_num(skin.S_total) ? skin.S_total.toFixed(1) : _sig(st.value, 2)) + ')');
    } else {
        parts.push(_plainName(modelKey));
    }
    if (_num(skin.FE) && skin.FE > 0) parts.push('FE ' + Math.round(100 * skin.FE) + '%');
    if (fitMeta.mode !== 'scale' && Array.isArray(fitMeta.inputsDefaulted) && fitMeta.inputsDefaulted.length) {
        parts.push('based on default ' + fitMeta.inputsDefaulted.join(', '));
    }
    var b = _findBoundaryTags(tags).filter(function (t) { return t.severity === 'important' && t.identifiable !== false; })[0];
    if (b) parts.push((BOUNDARY_KEYS[b.param] || 'boundary').toLowerCase() + ' detected');
    return parts.join(' · ');
}


// ════════════════════════════════════════════════════════════════════
// SECTION 7 — PUBLIC API: PRiSM_interpretFit
// ════════════════════════════════════════════════════════════════════

G.PRiSM_interpretFit = function PRiSM_interpretFit(modelKey, params, CI95, fitMeta) {
    params = params || {};
    CI95 = CI95 || {};
    fitMeta = fitMeta || {};
    var phys = fitMeta.phys || {};
    var ident = fitMeta.identifiable || {};
    var spec = _entry(modelKey);
    var modelKnown = !!spec;
    var tags = [];

    var keys = [];
    if (spec && spec.paramSpec) spec.paramSpec.forEach(function (s) { keys.push(s.key); });
    for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k) && keys.indexOf(k) < 0) keys.push(k);

    var skinScale = fitMeta.mode === 'scale';
    for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var v = params[key];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        // Scale mode: S is not identifiable and Cd is the arbitrary reference value.
        if (skinScale && (key === 'S' || key === 'S_perf' || key === 'S_global' || key === 'Cd')) continue;
        var rule;
        var dFt = phys.distances_ft && phys.distances_ft[key];
        if (BOUNDARY_KEYS.hasOwnProperty(key) && _num(dFt)) rule = _ruleBoundaryL(dFt, BOUNDARY_KEYS[key], true);
        else rule = _ruleForKey(key, v);
        if (!rule) continue;
        var range = CI95[key] ? CI95[key] : [NaN, NaN];
        tags.push(_makeTag(key, v, range, rule, ident.hasOwnProperty(key) ? { identifiable: ident[key] } : null));
    }
    // kh tag from the physical results.
    if (_num(phys.kh) && !_findTag(tags, 'kh')) {
        var khRule = _ruleForKey('kh', phys.kh);
        if (khRule) tags.push(_makeTag('kh', phys.kh, CI95.kh || [NaN, NaN], khRule));
    }

    var skin = _skinAnalysis(modelKey, params, fitMeta);
    // Mechanical-skin tag when it differs from the fitted skin (pseudo-skin present).
    if (skin.hasPseudo && _num(skin.S_mech)) {
        var smRule = _ruleForKey('S_mech', skin.S_mech);
        if (smRule) tags.unshift(_makeTag('S_mech', skin.S_mech, [NaN, NaN], smRule));
    }
    // Combined skin tag when the model splits skin (S_perf + S_global) or only
    // the physical results carry S.
    if (!_findTag(tags, 'S') && !_findTag(tags, 'S_mech') && _num(skin.S_mech)) {
        var sRule = _ruleForKey('S', skin.S_mech);
        if (sRule) tags.unshift(_makeTag('S', skin.S_mech, CI95.S || [NaN, NaN], sRule));
    }

    var confidence = _confidenceLevel(tags, fitMeta);
    var cautions = _buildCautions(tags, fitMeta, modelKnown, modelKey, skin);
    var narrative = G.PRiSM_buildNarrative(tags, modelKey, {
        confidence: confidence, phys: phys, ci95: CI95, identifiable: ident, skin: skin });

    var actions = _skinActions(skin, modelKey, params).concat(_actionsForTags(tags));
    // Reassurance only when EVERY skin term is acceptable.
    var skinTags = tags.filter(function (t) { return SKIN_KEYS[t.param]; });
    var allSkinOk = skinTags.length > 0 &&
        skinTags.every(function (t) { return t.severity === 'good' || t.severity === 'normal'; }) &&
        _num(skin.S_mech) && skin.S_mech < 2 &&
        !(_num(skin.FE) && skin.FE < 0.5) &&
        !(_num(skin.S_total) && skin.S_total < -4 && _isRadialModel(modelKey, params)) &&
        !(_num(skin.Sf) && skin.Sf > 0.5);
    if (allSkinOk) actions.push('Skin is acceptable; no immediate workover indicated');

    for (var bi = 0; bi < tags.length; bi++) {
        var t = tags[bi];
        if (BOUNDARY_KEYS.hasOwnProperty(t.param)) {
            var w = _ciFractionalWidth(t.value, t.range);
            if (isFinite(w) && w > 0.10) {
                actions.push('Extend the test or re-run the buildup at higher resolution to better constrain ' + t.param +
                             ' (currently ±' + _prose(0.5 * (t.range[1] - t.range[0])) + ')');
                break;
            }
        }
    }

    return {
        tags: tags, narrative: narrative, headline: _headline(skin, tags, modelKey, fitMeta),
        actions: actions, confidence: confidence, cautions: cautions,
        skin: { S_total: skin.S_total, S_pseudo: skin.S_pseudo, S_mech: skin.S_mech, Sf: skin.Sf,
                FE: skin.FE, DR: skin.DR, dpS: skin.dpS, J: skin.J, J_ideal: skin.J_ideal, rwEff: skin.rwEff },
        modelKey: modelKey, modelName: _plainName(modelKey), source: fitMeta.source || null,
        timestamp: new Date().toISOString()
    };
};

function _buildCautions(tags, fitMeta, modelKnown, modelKey, skin) {
    var cautions = [];
    if (!modelKnown) cautions.push('Model "' + (modelKey || '?') + '" is not in the PRiSM registry — interpretation is generic.');
    if (fitMeta.stale) cautions.push('The fit is out of date (data or model changed since it was run) — re-run the fit.');
    if (fitMeta.converged === false) cautions.push('The fit did not converge — values are a starting point, not a result.');
    if (fitMeta.mode === 'scale') cautions.push('Well inputs are incomplete — skin cannot be identified without φ, ct and rw.');
    if (isFinite(fitMeta.iterations)) {
        var iters = Math.round(fitMeta.iterations);
        if (isFinite(fitMeta.dAIC) && fitMeta.secondModelKey) {
            cautions.push('Fit converged in ' + iters + ' iterations; AIC prefers ' + _plainName(modelKey) + ' over ' +
                          _plainName(fitMeta.secondModelKey) + ' by ' + _prose(fitMeta.dAIC) + '.');
        } else {
            cautions.push('Fit finished in ' + iters + ' iterations.');
        }
    }
    if (isFinite(fitMeta.r2) && fitMeta.r2 < 0.99 && fitMeta.r2 >= 0.95) {
        cautions.push('Residual structure remains (R² ' + fitMeta.r2.toFixed(3) + ') — a second mechanism may be present.');
    }
    if (isFinite(fitMeta.lateRMSE) && fitMeta.lateRMSE > 0.02) {
        cautions.push('Late-time data show ~' + _prose(100 * fitMeta.lateRMSE) + '% RMSE — a boundary may lie beyond the fitted model.');
    }
    if (tags.some(function (t) { var w = _ciFractionalWidth(t.value, t.range); return isFinite(w) && w > 1.0; })) {
        cautions.push('At least one parameter has a range wider than its value — interpret with care.');
    }
    var unresolved = tags.filter(function (t) { return t.identifiable === false; }).map(function (t) { return t.param; });
    if (unresolved.length) cautions.push('Not resolved by the data: ' + unresolved.join(', ') + '.');
    if (skin && skin.hasPseudo) cautions.push('Actions are based on the mechanical skin, not the total skin.');
    if (Array.isArray(fitMeta.warnings)) fitMeta.warnings.forEach(function (w) {
        if (typeof w === 'string' && cautions.indexOf(w) < 0 && !/^Not resolved/.test(w)) cautions.push(w);
    });
    return cautions;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 8 — CURRENT FIT (reads the normalised lastFit)
// ════════════════════════════════════════════════════════════════════

function _normaliseFit(lf) {
    if (!lf) return null;
    var f = {};
    for (var k in lf) if (Object.prototype.hasOwnProperty.call(lf, k)) f[k] = lf[k];
    if (!_num(f.r2) && _num(f.R2)) f.r2 = f.R2;
    if (!_num(f.rmse) && _num(f.RMSE)) f.rmse = f.RMSE;
    if (!_num(f.aic) && _num(f.AIC)) f.aic = f.AIC;
    if (!f.ci95 && f.CI95) f.ci95 = f.CI95;
    if (!f.modelKey && f.model) f.modelKey = f.model;
    return f;
}

function _currentWell() {
    if (typeof G.PRiSM_getWell === 'function') {
        try { var w = G.PRiSM_getWell(); if (w) return w; } catch (e) { /* fall back */ }
    }
    var pvt = G.PRiSM_pvt || {}, c = pvt._computed || {};
    var ds = G.PRiSM_dataset;
    var qd = NaN;
    if (ds && ds.q && ds.q.length) {
        var qs = []; for (var i = 0; i < ds.q.length; i++) if (_pos(ds.q[i])) qs.push(ds.q[i]);
        qs.sort(function (a, b) { return a - b; });
        if (qs.length) qd = qs[qs.length >> 1];
    }
    var prov = pvt.provenance && pvt.provenance.p_res;
    return {
        q: _pos(qd) ? qd : pvt.q, B: _pos(pvt.Bo) ? pvt.Bo : c.B, mu: _pos(pvt.mu_o) ? pvt.mu_o : c.mu,
        ct: _pos(pvt.ct) ? pvt.ct : c.ct, h: pvt.h, phi: pvt.phi, rw: pvt.rw,
        pi: (prov === 'user' || prov === 'sample' || prov === 'deconvolution') ? pvt.p_res : null,
        testType: pvt.testType || 'auto', pwf0: pvt.pwf0
    };
}

// Flowing pressure used for FE: last flowing pressure (drawdown) or pwf at shut-in (buildup).
function _pwfFor(testType, well, lf) {
    if (lf && _num(lf.pwf)) return lf.pwf;
    var ds = G.PRiSM_dataset;
    if (testType === 'buildup' || testType === 'falloff') {
        if (_num(well.pwf0)) return well.pwf0;
        if (lf && lf.pRefSource === 'pwf0' && _num(lf.pRef)) return lf.pRef;
        return NaN;
    }
    if (ds && ds.p && ds.p.length) {
        for (var i = ds.p.length - 1; i >= 0; i--) if (_num(ds.p[i])) return ds.p[i];
    }
    return NaN;
}

G.PRiSM_interpretCurrentFit = function PRiSM_interpretCurrentFit() {
    var st = G.PRiSM_state;
    var lf = null;
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; }
    }
    if (!lf && st) lf = st.lastFit;
    lf = _normaliseFit(lf);
    var modelKey = (st && st.model) || null;
    var params, ci, fitMeta;
    if (lf && lf.params) {
        if (lf.kind === 'rate') return null;             // decline results are interpreted by 35
        modelKey = lf.modelKey || modelKey;
        params = lf.params;
        ci = lf.ci95 || {};
        var well = _currentWell() || {};
        var testType = (lf.testType) || (well.testType && well.testType !== 'auto' ? well.testType : null) || 'drawdown';
        fitMeta = {
            r2: lf.r2,
            // Margin to the runner-up (the applied auto-match row carries dAICnext).
            dAIC: _num(lf.dAICnext) ? lf.dAICnext : NaN,
            secondModelKey: lf.secondModelKey,
            iterations: lf.iterations, lateRMSE: lf.lateRMSE,
            converged: (lf.converged === false) ? false : undefined,
            phys: lf.phys || (st && st.phys) || {},
            identifiable: lf.identifiable || {},
            well: well, testType: testType,
            pbar: (lf.phys && _num(lf.phys.pi)) ? lf.phys.pi : (_num(lf.pRef) && (lf.pRefSource === 'pi' || lf.pRefSource === 'floated') ? lf.pRef : well.pi),
            pwf: _pwfFor(testType, well, lf),
            source: lf.source, stale: !!lf.stale, mode: lf.mode, warnings: lf.warnings,
            inputsDefaulted: lf.inputsDefaulted,
            geom: (st && (st.skinGeom || (st.semilog && st.semilog.geom))) || null,
            D: (st && st.semilog && _num(st.semilog.D)) ? st.semilog.D : undefined
        };
    } else if (st && st.params) {
        params = st.params; ci = {}; fitMeta = { phys: st.phys || {}, source: 'manual' };
    } else {
        return null;
    }
    return G.PRiSM_interpretFit(modelKey, params, ci, fitMeta);
};

// Recompute and store st.interp (read by the results rail and the report).
G.PRiSM_refreshInterpretation = function PRiSM_refreshInterpretation() {
    var interp = null;
    try { interp = G.PRiSM_interpretCurrentFit(); } catch (e) { interp = null; }
    if (G.PRiSM_state && typeof G.PRiSM_state === 'object') G.PRiSM_state.interp = interp;
    return interp;
};

if (typeof G.addEventListener === 'function' && !G.__prismInterpListeners) {
    G.__prismInterpListeners = true;
    ['prism:fit-updated', 'prism:well-changed'].forEach(function (evName) {
        G.addEventListener(evName, function () { G.PRiSM_refreshInterpretation(); });
    });
}


// ════════════════════════════════════════════════════════════════════
// SECTION 9 — UI RENDER
// ════════════════════════════════════════════════════════════════════

var PANEL_CSS =
    '.prism-interp{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:12px;color:var(--text);font-size:13px;line-height:1.5;min-width:0;overflow-wrap:anywhere}' +
    '.prism-interp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}' +
    '.prism-interp-title{font-weight:700;font-size:14px}' +
    '.prism-interp-chip{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;border:1px solid var(--border);color:var(--text2)}' +
    '.prism-interp-chip--high{color:var(--green);border-color:var(--green)}' +
    '.prism-interp-chip--medium{color:var(--blue);border-color:var(--blue)}' +
    '.prism-interp-chip--low{color:var(--yellow);border-color:var(--yellow)}' +
    '.prism-interp-headline{font-weight:600;margin-bottom:6px}' +
    '.prism-interp-text{padding:8px 10px;background:var(--bg1);border-left:3px solid var(--accent);border-radius:4px;margin-bottom:10px}' +
    '.prism-interp-h{font-weight:600;font-size:11px;color:var(--text3);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.5px}' +
    '.prism-interp-tags{display:flex;flex-wrap:wrap;gap:6px}' +
    '.prism-interp-tag{display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;border:1px solid var(--border);color:var(--text2);max-width:100%}' +
    '.prism-interp-tag--good{color:var(--green);border-color:var(--green)}' +
    '.prism-interp-tag--warning{color:var(--yellow);border-color:var(--yellow)}' +
    '.prism-interp-tag--important{color:var(--red);border-color:var(--red)}' +
    '.prism-interp ul{margin:0;padding-left:18px}' +
    '.prism-interp-cautions{color:var(--text2);font-size:12px}';

function _ensureCss() {
    if (!_hasDoc || !document.getElementById || !document.createElement) return;
    if (document.getElementById('prism_interp_css')) return;
    var s = document.createElement('style');
    s.id = 'prism_interp_css';
    s.textContent = PANEL_CSS;
    var head = document.head || document.body;
    if (head && head.appendChild) head.appendChild(s);
}

function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var CONF_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

G.PRiSM_renderInterpretationPanel = function PRiSM_renderInterpretationPanel(container, interp) {
    if (!_hasDoc || !container) return;
    _ensureCss();
    if (interp === undefined) {
        var st = G.PRiSM_state;
        interp = (st && st.interp) || G.PRiSM_refreshInterpretation();
    }
    if (!interp) {
        container.innerHTML = '<div class="prism-interp"><em style="color:var(--text3);">No interpretation yet — fit a model first.</em></div>';
        return;
    }
    var conf = interp.confidence || 'medium';
    var h = [];
    h.push('<div class="prism-interp" id="prism_interp_body">');
    h.push('<div class="prism-interp-head"><span class="prism-interp-title">Interpretation</span>' +
           '<span class="prism-interp-chip prism-interp-chip--' + _esc(conf) + '">' + _esc(CONF_LABEL[conf] || conf) + '</span></div>');
    if (interp.headline) h.push('<div class="prism-interp-headline">' + _esc(interp.headline) + '</div>');
    h.push('<div class="prism-interp-text">' + _esc(interp.narrative || '') + '</div>');
    if (interp.tags && interp.tags.length) {
        h.push('<div class="prism-interp-h">Findings</div><div class="prism-interp-tags">');
        interp.tags.forEach(function (t) {
            var sev = t.severity === 'good' || t.severity === 'warning' || t.severity === 'important' ? ' prism-interp-tag--' + t.severity : '';
            h.push('<span class="prism-interp-tag' + sev + '">' + _esc(t.param) + ' ' + _esc(_sig(t.value, 3)) + ' — ' + _esc(t.qualitative) + '</span>');
        });
        h.push('</div>');
    }
    if (interp.actions && interp.actions.length) {
        h.push('<div class="prism-interp-h">Suggested actions</div><ul>');
        interp.actions.forEach(function (a) { h.push('<li>' + _esc(a) + '</li>'); });
        h.push('</ul>');
    }
    if (interp.cautions && interp.cautions.length) {
        h.push('<div class="prism-interp-h">Cautions &amp; fit notes</div><ul class="prism-interp-cautions">');
        interp.cautions.forEach(function (c) { h.push('<li>' + _esc(c) + '</li>'); });
        h.push('</ul>');
    }
    h.push('</div>');
    container.innerHTML = h.join('');
};

// Tab 6 panel (contract C7): shown once a fit exists.
function _hasFit() {
    var st = G.PRiSM_state;
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { var lf = G.PRiSM_getLastFit(); if (lf && lf.params) return true; } catch (e) { /* ignore */ }
    }
    return !!(st && st.lastFit && st.lastFit.params);
}
var INTERP_PANEL = {
    id: 'prism_interp_panel', title: 'Interpretation', order: 30,
    when: _hasFit,
    render: function (hostEl) { G.PRiSM_renderInterpretationPanel(hostEl); }
};
(function _registerPanel() {
    try {
        if (typeof G.PRiSM_registerTabPanel === 'function') { G.PRiSM_registerTabPanel(6, INTERP_PANEL); return; }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var list = G.PRiSM_tabPanels[6] = G.PRiSM_tabPanels[6] || [];
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === INTERP_PANEL.id) return;
        list.push(INTERP_PANEL);
    } catch (e) { /* silent */ }
})();

G.PRiSM_formatWithCI = PRiSM_formatWithCI;


// ════════════════════════════════════════════════════════════════════
// SECTION 10 — SELF-TEST
// ════════════════════════════════════════════════════════════════════
// === SELF-TEST ===
(function PRiSM_interpretSelfTest() {
    var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
    var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
    var checks = [];
    function _check(name, fn) {
        try { checks.push({ name: name, ok: !!fn() }); }
        catch (e) { checks.push({ name: name, ok: false, msg: e && e.message }); }
    }
    function _has(arr, sub) {
        return (arr || []).some(function (a) { return a.toLowerCase().indexOf(sub.toLowerCase()) >= 0; });
    }
    _check('mild damage (S 2.5) → consider', function () {
        var r = G.PRiSM_interpretFit('homogeneous', { Cd: 80, S: 2.5 }, { S: [2.4, 2.6] }, { r2: 0.9999 });
        return _has(r.actions, 'consider') && !_has(r.actions, 'strongly') && !_has(r.actions, 'no immediate workover');
    });
    _check('moderate damage (S 7) is not "strongly"', function () {
        var r = G.PRiSM_interpretFit('homogeneous', { Cd: 80, S: 7 }, {}, {});
        return _has(r.actions, 'remedial') && !_has(r.actions, 'strongly');
    });
    _check('severe damage (S 15) → strongly', function () {
        return _has(G.PRiSM_interpretFit('homogeneous', { Cd: 80, S: 15 }, {}, {}).actions, 'strongly');
    });
    _check('S −6 radial → fracture model', function () {
        return _has(G.PRiSM_interpretFit('homogeneous', { Cd: 80, S: -6 }, {}, {}).actions, 'fracture model');
    });
    _check('horizontal S_perf 1 / S_global 6 → no reassurance', function () {
        var r = G.PRiSM_interpretFit('horizontal', { Cd: 100, S_perf: 1, S_global: 6 }, {}, {});
        return !_has(r.actions, 'no immediate workover');
    });
    _check('confidence low when R² 0.8', function () {
        return G.PRiSM_interpretFit('homogeneous', { Cd: 80, S: 0.5 }, {}, { r2: 0.8 }).confidence === 'low';
    });
    _check('honest precision', function () {
        return PRiSM_formatWithCI(45.0312, 0.31, 'md') === '45.0 ± 0.3 md' &&
               PRiSM_formatWithCI(2.5047, 0.047) === '2.50 ± 0.05';
    });
    _check('FE wording from well inputs', function () {
        var r = G.PRiSM_interpretFit('homogeneous', { Cd: 80, S: 2.5 }, {}, {
            phys: { k: 45, kh: 1575, pi: 4200 }, pwf: 3089.8,
            well: { q: 850, B: 1.25, mu: 1.1, h: 35, rw: 0.354 } });
        return /FE 76%/.test(r.narrative) && /mild damage/.test(r.narrative);
    });
    var fails = checks.filter(function (c) { return !c.ok; });
    if (fails.length) err('PRiSM interpretation self-test FAILED:', fails);
    else log('[PRiSM-interp] all ' + checks.length + ' self-test checks passed');
})();

})();
