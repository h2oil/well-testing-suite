// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 14 — Plain-English Interpretation
//   Turns fitted parameter values + CIs into a narrative report:
//   qualitative tags, severity, suggested actions, cautions.
// ────────────────────────────────────────────────────────────────────
//
// Public API (all on window.*):
//   PRiSM_interpretFit(modelKey, params, CI95)         -> { tags, narrative,
//                                                            actions, confidence,
//                                                            cautions }
//   PRiSM_interpretCurrentFit()                        -> result | null
//   PRiSM_renderInterpretationPanel(container, interp) -> void
//   PRiSM_buildNarrative(tags, modelKey, classification)-> string
//
// Conventions:
//   - Single outer IIFE, 'use strict'.
//   - All public symbols on window.PRiSM_*.
//   - No external dependencies — pure vanilla JS, Math.*.
//   - Defensive against missing models / lastFit / DOM.
//   - Self-test at the bottom.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

// Global container — works in browser and Node (smoke-test stub).
var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});
var _hasDoc = (typeof document !== 'undefined');

// Compact in-prose number formatter — fewer trailing zeros, exponential
// for very small or very large magnitudes.
function _prose(n) {
    if (n == null || !isFinite(n)) return '—';
    var v = Number(n), a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10)  return v.toFixed(1);
    if (a >= 1)   return v.toFixed(2);
    return v.toFixed(3);
}


// ════════════════════════════════════════════════════════════════════
// SECTION 1 — PARAM-TO-TAG RULES
// ════════════════════════════════════════════════════════════════════
// Each rule maps a parameter key to a function returning a tag object:
//   { qualitative, severity, hint }
// where hint is a short verb-phrase used in the narrative chain.
//
// Severity ladder: 'good' | 'normal' | 'warning' | 'important'
//   - 'good'      : positive finding, no action required
//   - 'normal'    : within typical range, no action required
//   - 'warning'   : worth flagging, possible action
//   - 'important' : strongly suggests action / further work
// ════════════════════════════════════════════════════════════════════

// Bucket tables — each entry is [upperBound, qualitative, severity, hint].
// First entry whose value < upperBound wins. Last entry must use Infinity.
var SKIN_BUCKETS = [
    [-5,        'highly stimulated',         'good',      'completion is highly stimulated'],
    [-2,        'effectively stimulated',    'good',      'an effectively stimulated completion'],
    [ 0,        'mildly stimulated',         'good',      'a mildly stimulated completion'],
    [ 2,        'no significant skin',       'normal',    'no significant skin'],
    [ 5,        'mildly damaged',            'warning',   'mild near-wellbore damage'],
    [10,        'damaged',                   'warning',   'near-wellbore damage'],
    [Infinity,  'severely damaged',          'important', 'severe near-wellbore damage']
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

function _bucketLookup(buckets, v) {
    if (!isFinite(v)) return null;
    for (var i = 0; i < buckets.length; i++) {
        if (v < buckets[i][0]) {
            return { qualitative: buckets[i][1], severity: buckets[i][2], hint: buckets[i][3] };
        }
    }
    return null;
}

// Boundary rule needs label substitution because keys distinguish
// fault 1 / fault 2 / N / S / E / W boundaries.
function _ruleBoundaryL(v, label) {
    if (!isFinite(v)) return null;
    var name = label || 'Boundary';
    var lname = name.toLowerCase();
    if (v < 100)   return { qualitative: name + ' very close — recheck data quality', severity: 'warning',
                             hint: lname + ' very close to the wellbore — data quality should be re-checked' };
    if (v < 500)   return { qualitative: 'near ' + lname + ' detected',               severity: 'important',
                             hint: 'a near ' + lname + ' is detected' };
    if (v < 2000)  return { qualitative: name + ' detected at moderate distance',     severity: 'important',
                             hint: 'a ' + lname + ' is detected at moderate distance' };
    return             { qualitative: 'far ' + lname + ' — late-time signal only', severity: 'normal',
                             hint: 'a far ' + lname + ' is hinted by the late-time signal' };
}

// Param-key dispatch — names follow the registry keys used in 03/06/08/09.
//
// A note on the boundary-distance keys:
//   Layer 03 uses dF, dF1, dF2, dEnd, dN, dS, dE, dW (units of r_w).
//   The Task contract above describes "L" (ft). We treat both as
//   distance-to-boundary tags — the qualitative buckets are unitless
//   bands so the labelling is correct in either case, and the value is
//   reported in the unit attached to the parameter when known.
// --------------------------------------------------------------------
var BOUNDARY_KEYS = {
    'L':     'Boundary',
    'dF':    'Boundary',
    'dF1':   'Fault 1',
    'dF2':   'Fault 2',
    'dEnd':  'End',
    'dN':    'North boundary',
    'dS':    'South boundary',
    'dE':    'East boundary',
    'dW':    'West boundary'
};

function _ruleForKey(key, value) {
    if (key === 'S' || key === 'S_global' || key === 'S_perf') return _bucketLookup(SKIN_BUCKETS, value);
    if (key === 'Cd')                              return _bucketLookup(CD_BUCKETS, value);
    if (key === 'kh')                              return _bucketLookup(KH_BUCKETS, value);
    if (key === 'omega')                           return _bucketLookup(OMEGA_BUCKETS, value);
    if (key === 'lambda')                          return _bucketLookup(LAMBDA_BUCKETS, value);
    if (key === 'xf')                              return _bucketLookup(XF_BUCKETS, value);
    if (key === 'FcD')                             return _bucketLookup(FCD_BUCKETS, value);
    if (key === 'Lh' || key === 'Llat')            return _bucketLookup(LATERAL_BUCKETS, value);
    if (BOUNDARY_KEYS.hasOwnProperty(key))         return _ruleBoundaryL(value, BOUNDARY_KEYS[key]);
    return null;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 2 — PER-MODEL NARRATIVE TEMPLATES
// ════════════════════════════════════════════════════════════════════
// Each model class produces a different opening sentence. We don't
// need a per-model template for every one of the 27 — we group them by
// category and primary parameter signature.
// ════════════════════════════════════════════════════════════════════

// Categories that need a special opening clause beyond the generic one.
function _modelCategoryOpening(modelKey) {
    var spec = (G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]) || null;
    var cat = spec && spec.category;
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
    return null;
}

// Look up parameter unit / label from the registry — graceful fallback.
function _paramMeta(modelKey, key) {
    var spec = (G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]) || null;
    if (!spec || !spec.paramSpec) return { unit: '', label: key };
    for (var i = 0; i < spec.paramSpec.length; i++) {
        if (spec.paramSpec[i].key === key) return spec.paramSpec[i];
    }
    return { unit: '', label: key };
}

// Produce a tag entry (the public-API tag shape) from a value + rule.
function _makeTag(key, value, range, rule) {
    return {
        param:       key,
        value:       value,
        range:       range || [NaN, NaN],
        qualitative: rule.qualitative,
        severity:    rule.severity,
        hint:        rule.hint
    };
}


// ════════════════════════════════════════════════════════════════════
// SECTION 3 — ACTION RECOMMENDER
// ════════════════════════════════════════════════════════════════════
// Severity → list of suggested actions, keyed off the tag's qualitative
// label so we can be specific (e.g. 'damaged' vs 'high WBS').
// ════════════════════════════════════════════════════════════════════

// Map qualitative-label-substring → action sentence.
// Order matters: more-specific phrases come first.
var ACTION_TEMPLATES = [
    // important
    { match: /severely damaged/i,             action: 'Matrix acid stimulation strongly indicated' },
    { match: /^damaged/i,                     action: 'Matrix acid stimulation strongly indicated' },
    { match: /very high WBS/i,                action: 'Mandatory downhole shut-in for next test' },
    { match: /near .* detected|detected at/i, action: 'Confirm boundary against seismic / well-spacing geometry; revise rate planning' },
    { match: /very close/i,                   action: 'Re-examine the early-time data — boundary very close may indicate logging or pressure-gauge artefacts' },
    // warning
    { match: /mildly damaged/i,               action: 'Consider acid wash or matrix stimulation if production targets unmet' },
    { match: /short fracture/i,               action: 'Re-frac candidate evaluation' },
    { match: /^high WBS/i,                    action: 'Future tests: downhole shut-in or longer build-up' },
    { match: /low productivity/i,             action: 'Confirm completion efficiency; consider re-perforation or stimulation' },
    { match: /weak fracture signature/i,      action: 'Re-fit as homogeneous; compare AIC' },
    { match: /low FcD/i,                      action: 'Investigate fracture cleanup or proppant pack quality' }
    // 'good' and 'normal' produce no actions.
];

function _actionsForTags(tags) {
    var out = [];
    for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        if (t.severity !== 'warning' && t.severity !== 'important') continue;
        for (var j = 0; j < ACTION_TEMPLATES.length; j++) {
            if (ACTION_TEMPLATES[j].match.test(t.qualitative)) {
                if (out.indexOf(ACTION_TEMPLATES[j].action) < 0) {
                    out.push(ACTION_TEMPLATES[j].action);
                }
                break;
            }
        }
    }
    return out;
}

// Number of action templates implemented (for the final report).
var ACTION_TEMPLATES_COUNT = ACTION_TEMPLATES.length;


// ════════════════════════════════════════════════════════════════════
// SECTION 4 — CONFIDENCE ASSESSMENT
// ════════════════════════════════════════════════════════════════════
// Combine R², CI tightness vs param value, and ΔAIC margin (if known).
//
//   high    : R² ≥ 0.99 AND all CIs < 30 % AND ΔAIC > 10
//   medium  : R² ≥ 0.95 AND most CIs < 50 %
//   low     : R² < 0.95  OR any CI > 100 %  OR ΔAIC < 2
// ════════════════════════════════════════════════════════════════════

function _ciFractionalWidth(value, range) {
    if (!range || !isFinite(range[0]) || !isFinite(range[1])) return Infinity;
    if (!isFinite(value)) return Infinity;
    var halfWidth = 0.5 * (range[1] - range[0]);
    // For near-zero parameter values (e.g. S = 0), fractional width is
    // ill-defined. Use the half-width directly as an absolute tolerance
    // and treat anything < 1.0 (in skin units, etc.) as "tight".
    if (Math.abs(value) < 1e-3) {
        return Math.abs(halfWidth);
    }
    return Math.abs(halfWidth / value);
}

function _confidenceLevel(tags, fitMeta) {
    var r2     = (fitMeta && isFinite(fitMeta.r2))     ? fitMeta.r2     : NaN;
    var dAIC   = (fitMeta && isFinite(fitMeta.dAIC))   ? fitMeta.dAIC   : NaN;
    // Inspect CI tightness across tagged params.
    var widths = tags.map(function (t) { return _ciFractionalWidth(t.value, t.range); });
    var anyVeryWide = widths.some(function (w) { return w > 1.0; });
    var allTight    = widths.every(function (w) { return w < 0.30; });
    var mostMedium  = widths.filter(function (w) { return w < 0.50; }).length
                       >= Math.max(1, Math.floor(widths.length / 2 + 0.5));

    // Low takes precedence — any bad signal demotes the verdict.
    if (isFinite(r2) && r2 < 0.95) return 'low';
    if (anyVeryWide)                return 'low';
    if (isFinite(dAIC) && dAIC < 2) return 'low';
    // High requires every gate to pass; if AIC margin unknown, accept other gates.
    if ((!isFinite(r2) || r2 >= 0.99) && allTight && (!isFinite(dAIC) || dAIC > 10)) return 'high';
    // Medium fallback.
    if ((!isFinite(r2) || r2 >= 0.95) && mostMedium) return 'medium';
    return 'medium';
}

// Confidence-tinted verbs to keep the prose honest.
function _confidenceVerb(level) {
    if (level === 'high')   return 'indicates';
    if (level === 'medium') return 'is consistent with';
    return 'tentatively suggests';
}

function _confidenceStatement(level) {
    if (level === 'high')   return 'Confidence in this interpretation is high';
    if (level === 'medium') return 'Confidence is moderate — tighten CIs with longer flow periods if possible';
    return 'Confidence is low — treat this interpretation as preliminary';
}


// ════════════════════════════════════════════════════════════════════
// SECTION 5 — NARRATIVE COMPOSITION
// ════════════════════════════════════════════════════════════════════
// Generate the full prose paragraph from tags + classification info.
// Kept tight (60-120 words) by chaining short clauses.
// ════════════════════════════════════════════════════════════════════

function _findTag(tags, key) {
    for (var i = 0; i < tags.length; i++) if (tags[i].param === key) return tags[i];
    return null;
}
function _findTagByPrefix(tags, prefix) {
    for (var i = 0; i < tags.length; i++) {
        if (tags[i].param.indexOf(prefix) === 0) return tags[i];
    }
    return null;
}
function _findBoundaryTags(tags) {
    var out = [];
    for (var i = 0; i < tags.length; i++) {
        if (BOUNDARY_KEYS.hasOwnProperty(tags[i].param)) out.push(tags[i]);
    }
    return out;
}

// Build a value+CI string ("S = -1.4 ± 0.3" or "kh = 245 md·ft").
function _valueWithCI(tag, modelKey) {
    var meta = _paramMeta(modelKey, tag.param);
    var unit = meta.unit && meta.unit !== '-' ? (' ' + meta.unit) : '';
    var v = _prose(tag.value);
    var halfCI = NaN;
    if (tag.range && isFinite(tag.range[0]) && isFinite(tag.range[1])) {
        halfCI = 0.5 * (tag.range[1] - tag.range[0]);
    }
    if (isFinite(halfCI) && halfCI > 0) {
        return tag.param + ' = ' + v + ' ± ' + _prose(halfCI) + unit;
    }
    return tag.param + ' = ' + v + unit;
}

G.PRiSM_buildNarrative = function PRiSM_buildNarrative(tags, modelKey, classification) {
    if (!tags || !tags.length) {
        return 'No interpretable parameters were extracted from this fit.';
    }
    var verb = _confidenceVerb((classification && classification.confidence) || 'medium');
    var spec = (G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]) || null;
    var modelKnown = !!spec;
    var clauses = [];

    // Opening — model class + skin tag (if present).
    var skinTag = _findTagByPrefix(tags, 'S');
    var openCat = _modelCategoryOpening(modelKey);
    var opening;
    if (modelKnown && openCat) {
        if (skinTag) {
            opening = 'This well ' + verb + ' ' + openCat + ' with '
                    + skinTag.hint + ' (' + _valueWithCI(skinTag, modelKey) + ').';
        } else {
            opening = 'This well ' + verb + ' ' + openCat + '.';
        }
    } else if (skinTag) {
        opening = 'This well ' + verb + ' ' + skinTag.hint
                + ' (' + _valueWithCI(skinTag, modelKey) + ').';
    } else {
        opening = 'Fitted parameters described below.';
    }
    clauses.push(opening);

    // Wellbore storage clause.
    var cdTag = _findTag(tags, 'Cd');
    if (cdTag) {
        clauses.push('Wellbore storage is ' + cdTag.hint + ' (Cd ≈ '
                     + _prose(cdTag.value) + ').');
    }

    // Productivity clause (kh).
    var khTag = _findTag(tags, 'kh');
    if (khTag) {
        var khMeta = _paramMeta(modelKey, 'kh');
        var unit = khMeta.unit && khMeta.unit !== '-' ? (' ' + khMeta.unit) : ' md·ft';
        clauses.push('Productivity is ' + khTag.hint + ' (kh = '
                     + _prose(khTag.value) + unit + ').');
    }

    // Boundary clauses (one per boundary tag found).
    var bTags = _findBoundaryTags(tags);
    for (var i = 0; i < bTags.length; i++) {
        var bt = bTags[i];
        var bMeta = _paramMeta(modelKey, bt.param);
        var bUnit = (bMeta.unit && bMeta.unit !== '-') ? (' ' + bMeta.unit) : ' ft';
        var hintAct = '';
        if (bt.severity === 'important') {
            hintAct = ' — confirm against geology before extending production at this rate';
        } else if (bt.severity === 'warning') {
            hintAct = ' — verify data quality at the early-time end of the test';
        }
        clauses.push(_capitalize(bt.hint) + ' at ' + _prose(bt.value) + bUnit
                     + ' from the wellbore' + hintAct + '.');
    }

    // Fracture clause (xf, FcD).
    var xfTag = _findTag(tags, 'xf');
    if (xfTag) {
        clauses.push(_capitalize(xfTag.hint) + ' is observed (xf = '
                     + _prose(xfTag.value) + ' ft).');
    }
    var fcdTag = _findTag(tags, 'FcD');
    if (fcdTag) {
        clauses.push('The data show ' + fcdTag.hint + ' (FcD ≈ '
                     + _prose(fcdTag.value) + ').');
    }

    // Naturally fractured clause (ω, λ).
    var omegaTag  = _findTag(tags, 'omega');
    var lambdaTag = _findTag(tags, 'lambda');
    if (omegaTag || lambdaTag) {
        var nf = 'The double-porosity signature shows ';
        var parts = [];
        if (omegaTag)  parts.push(omegaTag.hint  + ' (ω = '  + _prose(omegaTag.value)  + ')');
        if (lambdaTag) parts.push(lambdaTag.hint + ' (λ = '  + _prose(lambdaTag.value) + ')');
        clauses.push(nf + parts.join(' and ') + '.');
    }

    // Lateral length clause (horizontal wells).
    var lhTag = _findTag(tags, 'Lh') || _findTag(tags, 'Llat');
    if (lhTag) {
        clauses.push('Completion length is consistent with ' + lhTag.hint + '.');
    }

    // Closing — confidence + primary action hint.
    var conf = (classification && classification.confidence) || 'medium';
    clauses.push(_confidenceStatement(conf) + '.');

    // Unknown-model caveat.
    if (!modelKnown) {
        clauses.push('Note: model "' + (modelKey || '?') + '" is not in the PRiSM registry — '
                     + 'this is a generic interpretation.');
    }

    return clauses.join(' ');
};

function _capitalize(s) {
    if (!s || !s.length) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6 — PUBLIC API: PRiSM_interpretFit
// ════════════════════════════════════════════════════════════════════
//
// Inputs:
//   modelKey  — registry key (e.g. 'homogeneous', 'singleFault')
//   params    — { paramKey: numericValue, ... }
//   CI95      — { paramKey: [lo, hi], ... }   (optional, may be partial)
//
// Optional 4th argument: fitMeta = { r2, dAIC, iterations, secondModelKey }
//   used to refine confidence + cautions.
//
// Output:
//   { tags, narrative, actions, confidence, cautions }
// ════════════════════════════════════════════════════════════════════

G.PRiSM_interpretFit = function PRiSM_interpretFit(modelKey, params, CI95, fitMeta) {
    params = params || {};
    CI95   = CI95   || {};
    fitMeta = fitMeta || {};

    var modelKnown = !!(G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]);
    var tags = [];

    // Determine the iteration set: union of known param keys.
    // Prefer the model's paramSpec ordering when available, else
    // iterate the supplied params object.
    var keys = [];
    if (modelKnown) {
        var spec = G.PRiSM_MODELS[modelKey];
        if (spec.paramSpec && spec.paramSpec.length) {
            for (var i = 0; i < spec.paramSpec.length; i++) {
                keys.push(spec.paramSpec[i].key);
            }
        }
    }
    // Append any extra keys present in `params` but not in paramSpec.
    for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k) && keys.indexOf(k) < 0) {
            keys.push(k);
        }
    }

    for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var v = params[key];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        var rule = _ruleForKey(key, v);
        if (!rule) continue;
        var range = (CI95 && CI95[key]) ? CI95[key] : [NaN, NaN];
        tags.push(_makeTag(key, v, range, rule));
    }

    // Confidence — pick before narrative so the prose can reflect it.
    var confidence = _confidenceLevel(tags, fitMeta);

    // Cautions — explicit data-quality / fit-quality flags.
    var cautions = _buildCautions(tags, fitMeta, modelKnown, modelKey);

    var narrative = G.PRiSM_buildNarrative(tags, modelKey, { confidence: confidence });
    var actions   = _actionsForTags(tags);

    // If skin is acceptable (good/normal) explicitly add a "no workover" reassurance.
    var skinTag = _findTagByPrefix(tags, 'S');
    if (skinTag && (skinTag.severity === 'good' || skinTag.severity === 'normal')) {
        actions.push('Skin is acceptable; no immediate workover indicated');
    }

    // If a boundary CI is wide, suggest a longer build-up.
    for (var bi = 0; bi < tags.length; bi++) {
        var t = tags[bi];
        if (BOUNDARY_KEYS.hasOwnProperty(t.param)) {
            var w = _ciFractionalWidth(t.value, t.range);
            if (isFinite(w) && w > 0.10) {
                actions.push('Re-run buildup at higher resolution if data permits, to better-constrain '
                             + t.param + ' (currently ±' + _prose(0.5 * (t.range[1] - t.range[0])) + ')');
                break;
            }
        }
    }

    return {
        tags:       tags,
        narrative:  narrative,
        actions:    actions,
        confidence: confidence,
        cautions:   cautions
    };
};

function _buildCautions(tags, fitMeta, modelKnown, modelKey) {
    var cautions = [];
    if (!modelKnown) {
        cautions.push('Model "' + (modelKey || '?') + '" is not in the PRiSM registry — interpretation is generic.');
    }
    if (fitMeta) {
        if (isFinite(fitMeta.iterations) && isFinite(fitMeta.dAIC)) {
            // Format both — exact wording matches the example in the spec.
            var iters = Math.round(fitMeta.iterations);
            if (fitMeta.secondModelKey) {
                cautions.push('Fit converged in ' + iters + ' LM iterations; AIC strongly prefers '
                              + (modelKey || 'this model') + ' over '
                              + fitMeta.secondModelKey + ' (ΔAIC = ' + _prose(fitMeta.dAIC) + ').');
            } else {
                cautions.push('Fit converged in ' + iters + ' LM iterations (ΔAIC vs runner-up = '
                              + _prose(fitMeta.dAIC) + ').');
            }
        } else if (isFinite(fitMeta.iterations)) {
            cautions.push('Fit converged in ' + Math.round(fitMeta.iterations) + ' LM iterations.');
        }
        if (isFinite(fitMeta.r2) && fitMeta.r2 < 0.99 && fitMeta.r2 >= 0.95) {
            cautions.push('Late-time data shows residual structure — possible second mechanism out of range.');
        }
        if (isFinite(fitMeta.lateRMSE) && fitMeta.lateRMSE > 0.02) {
            cautions.push('Late-time data (td > 1000) shows ~' + _prose(100 * fitMeta.lateRMSE)
                          + '% RMSE — possible second boundary out of range.');
        }
    }
    // Wide-CI flag per tag.
    var anyVeryWide = false;
    for (var i = 0; i < tags.length; i++) {
        var w = _ciFractionalWidth(tags[i].value, tags[i].range);
        if (isFinite(w) && w > 1.0) { anyVeryWide = true; break; }
    }
    if (anyVeryWide) {
        cautions.push('At least one parameter has a CI wider than the value itself — interpret with care.');
    }
    return cautions;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 7 — PUBLIC API: PRiSM_interpretCurrentFit
// ════════════════════════════════════════════════════════════════════
// Convenience wrapper — pulls everything from PRiSM_state.lastFit.
// Returns null if no fit is available.
// ════════════════════════════════════════════════════════════════════

G.PRiSM_interpretCurrentFit = function PRiSM_interpretCurrentFit() {
    var st = G.PRiSM_state;
    if (!st) return null;
    var modelKey = st.model;
    // Prefer a stored lastFit (set by the auto-match orchestrator) but fall
    // back to the live params + (no CI) so we still produce a narrative.
    var lf = st.lastFit;
    var params, ci, fitMeta;
    if (lf && lf.params) {
        params  = lf.params;
        ci      = lf.ci95 || lf.CI95 || {};
        fitMeta = {
            r2:             lf.r2,
            dAIC:           lf.dAIC,
            iterations:     lf.iterations,
            secondModelKey: lf.secondModelKey,
            lateRMSE:       lf.lateRMSE
        };
        if (lf.modelKey) modelKey = lf.modelKey;
    } else if (st.params) {
        params  = st.params;
        ci      = {};
        fitMeta = {};
    } else {
        return null;
    }
    return G.PRiSM_interpretFit(modelKey, params, ci, fitMeta);
};


// ════════════════════════════════════════════════════════════════════
// SECTION 8 — UI RENDER
// ════════════════════════════════════════════════════════════════════
// Render a styled panel into the container with:
//   • confidence badge
//   • narrative paragraph
//   • parameter chips colour-coded by severity
//   • actions checklist
//   • cautions block
// ════════════════════════════════════════════════════════════════════

var SEV_COLORS = {
    'good':      { bg: '#0f3a1f', border: '#2ea043', text: '#7ee787' },
    'normal':    { bg: '#1f2937', border: '#30363d', text: '#c9d1d9' },
    'warning':   { bg: '#3a2f0f', border: '#bb8009', text: '#f0c674' },
    'important': { bg: '#3a0f0f', border: '#cf222e', text: '#ff9494' }
};

var CONF_COLORS = {
    'high':   { bg: '#0f3a1f', text: '#7ee787', label: 'High confidence' },
    'medium': { bg: '#1f2a3a', text: '#79b8ff', label: 'Medium confidence' },
    'low':    { bg: '#3a2f0f', text: '#f0c674', label: 'Low confidence' }
};

function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Shared style fragments (single-line) — keeps the renderer compact.
var _PANEL_STYLE   = 'background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:14px; color:#c9d1d9; font-size:13px; line-height:1.5;';
var _HEADING_STYLE = 'font-weight:600; font-size:12px; color:#8b949e; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;';
var _CHIP_STYLE    = 'display:inline-block; padding:4px 10px; border-radius:12px; font-size:11px; ';

G.PRiSM_renderInterpretationPanel = function PRiSM_renderInterpretationPanel(container, interp) {
    if (!_hasDoc || !container) return;
    if (!interp) {
        container.innerHTML = '<div style="padding:12px; color:#8b949e; font-style:italic;">'
            + 'No interpretation available. Run a fit first, then re-open this panel.</div>';
        return;
    }
    var conf = CONF_COLORS[interp.confidence] || CONF_COLORS.medium;
    var h = [];
    h.push('<div class="prism-interp-panel" style="' + _PANEL_STYLE + '">');
    // Header — confidence badge.
    h.push('<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:12px; flex-wrap:wrap;">'
         + '<div style="font-weight:700; font-size:14px; color:#c9d1d9;">Interpretation</div>'
         + '<span style="' + _CHIP_STYLE + 'font-weight:600; background:' + conf.bg + '; color:' + conf.text + ';">'
         + _esc(conf.label) + '</span></div>');
    // Narrative paragraph.
    h.push('<div style="margin-bottom:14px; padding:10px; background:#161b22; border-left:3px solid '
         + conf.text + '; border-radius:4px;">' + _esc(interp.narrative || '') + '</div>');
    // Parameter chips.
    if (interp.tags && interp.tags.length) {
        h.push('<div style="margin-bottom:12px;"><div style="' + _HEADING_STYLE + '">Parameter findings</div>'
             + '<div style="display:flex; flex-wrap:wrap; gap:6px;">');
        for (var i = 0; i < interp.tags.length; i++) {
            var t = interp.tags[i], sev = SEV_COLORS[t.severity] || SEV_COLORS.normal;
            var rangeStr = (t.range && isFinite(t.range[0]) && isFinite(t.range[1]))
                ? ' [' + _prose(t.range[0]) + ', ' + _prose(t.range[1]) + ']' : '';
            h.push('<span style="' + _CHIP_STYLE + 'background:' + sev.bg + '; color:' + sev.text
                + '; border:1px solid ' + sev.border + ';" title="' + _esc(t.qualitative + rangeStr) + '">'
                + _esc(t.param) + ' = ' + _esc(_prose(t.value)) + ' — ' + _esc(t.qualitative) + '</span>');
        }
        h.push('</div></div>');
    }
    // Actions checklist.
    if (interp.actions && interp.actions.length) {
        h.push('<div style="margin-bottom:12px;"><div style="' + _HEADING_STYLE + '">Suggested actions</div>'
             + '<ul style="margin:0; padding-left:20px; list-style:none;">');
        for (var ai = 0; ai < interp.actions.length; ai++) {
            h.push('<li style="margin-bottom:4px; position:relative;">'
                + '<span style="position:absolute; left:-18px; color:#79b8ff;">□</span>'
                + _esc(interp.actions[ai]) + '</li>');
        }
        h.push('</ul></div>');
    }
    // Cautions.
    if (interp.cautions && interp.cautions.length) {
        h.push('<div><div style="' + _HEADING_STYLE.replace('#8b949e', '#f0c674') + '">Cautions &amp; fit notes</div>'
             + '<ul style="margin:0; padding-left:20px; color:#a6a39a; font-size:12px;">');
        for (var ci = 0; ci < interp.cautions.length; ci++) {
            h.push('<li style="margin-bottom:4px;">' + _esc(interp.cautions[ci]) + '</li>');
        }
        h.push('</ul></div>');
    }
    h.push('</div>');
    container.innerHTML = h.join('');
};


// ════════════════════════════════════════════════════════════════════
// SECTION 9 — SELF-TEST
// ════════════════════════════════════════════════════════════════════
// === SELF-TEST ===
(function PRiSM_interpretSelfTest() {
    var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
    var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
    var checks = [];
    function _check(name, fn) {
        try { var ok = fn(); checks.push({ name: name, ok: !!ok }); }
        catch (e) { checks.push({ name: name, ok: false, msg: e && e.message }); }
    }
    function _findT(tags, k) {
        for (var i = 0; i < tags.length; i++) if (tags[i].param === k) return tags[i];
        return null;
    }
    function _hasAction(arr, sub) {
        if (!arr) return false;
        for (var i = 0; i < arr.length; i++) if (arr[i].toLowerCase().indexOf(sub.toLowerCase()) >= 0) return true;
        return false;
    }

    // Test 1 — Damaged well (S = +5)
    var r1 = G.PRiSM_interpretFit('homogeneous', { Cd: 100, S: 5 },
                { Cd: [80, 120], S: [4.5, 5.5] },
                { r2: 0.998, dAIC: 12, iterations: 8 });
    log('[PRiSM-interp self-test] Damaged narrative:\n  ' + r1.narrative);
    _check('Damaged well (S=+5) flags damage + matrix-acid action', function () {
        var s = _findT(r1.tags, 'S');
        return s && /damaged/i.test(s.qualitative) && _hasAction(r1.actions, 'matrix acid');
    });

    // Test 2 — Stimulated frac (S = -4, infiniteFrac, xf = 120)
    var r2 = G.PRiSM_interpretFit('infiniteFrac', { Cd: 80, S: -4, xf: 120 },
                { Cd: [70, 90], S: [-4.3, -3.7], xf: [110, 130] },
                { r2: 0.995, dAIC: 8, iterations: 10 });
    log('[PRiSM-interp self-test] Stimulated narrative:\n  ' + r2.narrative);
    _check('Stimulated frac (S=-4, xf=120) tags effective stimulation', function () {
        var s = _findT(r2.tags, 'S'), x = _findT(r2.tags, 'xf');
        return s && /stimulated/i.test(s.qualitative) && x && /effective/i.test(x.qualitative);
    });

    // Test 3 — Sealing fault detected (singleFault uses 'dF' in r_w)
    var r3 = G.PRiSM_interpretFit('singleFault', { Cd: 100, S: 0, dF: 870 },
                { Cd: [85, 115], S: [-0.2, 0.2], dF: [820, 920] },
                { r2: 0.997, dAIC: 11, iterations: 12, secondModelKey: 'closedRectangle' });
    log('[PRiSM-interp self-test] Fault narrative:\n  ' + r3.narrative);
    _check('Sealing fault detected — boundary tag + confirm-geology action', function () {
        var b = _findT(r3.tags, 'dF');
        return b && /detected/i.test(b.qualitative) && _hasAction(r3.actions, 'confirm');
    });

    // Test 4 — Double-porosity (ω = 0.05, λ = 1e-6)
    var r4 = G.PRiSM_interpretFit('doublePorosity', { Cd: 100, S: 0, omega: 0.05, lambda: 1e-6 },
                { Cd: [90, 110], S: [-0.1, 0.1], omega: [0.04, 0.06], lambda: [5e-7, 2e-6] },
                { r2: 0.996, dAIC: 9, iterations: 14 });
    log('[PRiSM-interp self-test] Double-porosity narrative:\n  ' + r4.narrative);
    _check('Double-porosity narrative mentions natural fractures', function () {
        var o = _findT(r4.tags, 'omega');
        return o && /natural fractures/i.test(o.qualitative)
                  && r4.narrative.toLowerCase().indexOf('natural') >= 0;
    });

    // Test 5 — Confidence ladder
    _check('Confidence levels (high/medium/low) computed correctly', function () {
        var hi = G.PRiSM_interpretFit('homogeneous', { Cd: 100, S: -1 },
                    { Cd: [98, 102], S: [-1.1, -0.9] }, { r2: 0.998, dAIC: 25, iterations: 6 });
        var md = G.PRiSM_interpretFit('homogeneous', { Cd: 100, S: -1 },
                    { Cd: [80, 120], S: [-1.4, -0.6] }, { r2: 0.97, dAIC: 5, iterations: 10 });
        var lo = G.PRiSM_interpretFit('homogeneous', { Cd: 100, S: -1 },
                    { Cd: [10, 200], S: [-3.0, 1.0] }, { r2: 0.93, dAIC: 1.5, iterations: 30 });
        return hi.confidence === 'high' && md.confidence === 'medium' && lo.confidence === 'low';
    });

    // Test 6 — Unknown model graceful fallback
    _check('Unknown model produces caveat in cautions', function () {
        var u = G.PRiSM_interpretFit('not_a_real_model', { S: 0, Cd: 100 },
                    { S: [-0.3, 0.3], Cd: [90, 110] }, { r2: 0.99, dAIC: 6, iterations: 7 });
        return u && u.cautions && /not in the PRiSM registry/i.test(u.cautions.join(' '));
    });

    // Test 7 — PRiSM_interpretCurrentFit pulls from state.lastFit
    _check('interpretCurrentFit pulls from PRiSM_state.lastFit', function () {
        var prev = G.PRiSM_state;
        G.PRiSM_state = {
            model: 'homogeneous', params: { Cd: 100, S: 0 }, paramFreeze: {}, modelCurve: null,
            match: { timeShift: 0, pressShift: 0 },
            lastFit: { modelKey: 'homogeneous', params: { Cd: 100, S: 0 },
                       ci95: { Cd: [90, 110], S: [-0.2, 0.2] },
                       r2: 0.998, dAIC: 15, iterations: 8 }
        };
        var c = G.PRiSM_interpretCurrentFit();
        G.PRiSM_state = prev;
        return c && c.tags.length > 0 && c.confidence === 'high';
    });

    // Test 8 — PRiSM_buildNarrative reachable + non-empty
    _check('buildNarrative returns non-empty prose', function () {
        var s = G.PRiSM_buildNarrative(
            [{ param: 'S', value: -1.4, range: [-1.7, -1.1], qualitative: 'mildly stimulated',
                severity: 'good', hint: 'a mildly stimulated completion' }],
            'homogeneous', { confidence: 'high' });
        return s && s.length > 30;
    });

    // Test 9 — render panel doesn't throw on a fake container
    _check('renderInterpretationPanel injects styled HTML', function () {
        if (!_hasDoc || typeof document.createElement !== 'function') return true;
        var c = document.createElement('div');
        if (!c) return true;
        G.PRiSM_renderInterpretationPanel(c, {
            tags: [{ param: 'S', value: -1, range: [-1.2, -0.8], qualitative: 'mildly stimulated',
                      severity: 'good', hint: 'a mildly stimulated completion' }],
            narrative: 'Test narrative.',
            actions: ['Skin is acceptable; no immediate workover indicated'],
            confidence: 'high', cautions: []
        });
        return (c.innerHTML || '').length > 50;
    });

    var fails = checks.filter(function (c) { return !c.ok; });
    if (fails.length) err('PRiSM interpretation self-test FAILED:', fails);
    else              log('[PRiSM-interp] all ' + checks.length + ' self-test checks passed');
})();

})();
