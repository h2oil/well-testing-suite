// =============================================================================
// PRiSM — 56-prism-dfit-core.js  (Round 8)
// -----------------------------------------------------------------------------
// DFIT pre-closure core (docs/DFIT-PLAN.md §3.5; owner WP2). Pure engine: no DOM, no storage, no timers, no events.
//
// WP2 implementation of every §3.5 function: units, dataset hash, preparation (non-destructive channel fixes, masks
// compacted out), the O(n) resampler, events and volumes (§4.3), the G family (closed forms, 64-point Gauss–Legendre for a
// general α, data-driven and model-derived G, inverse), derivatives (§4.6), ISIP reconciliation (§4.4), the closure methods
// (§4.7), the G-domain forward model and the variable-compliance fit, consensus with the stability grid and block bootstrap
// (§4.8, §6.2; also as a Job), bounds with the two-tier frictional check, efficiency, net pressure, the storage-consistent
// closure balance, CL, geometry, leak-off rate, before-closure k, closure forecast (§4.9, §4.10), the leak-off-type
// classifier (§4.11) and the §6.12 calibration outputs. The h-function and the far-field extension reading are deferred to
// 3.4b by gate G6 (PRiSM_dfit_hFn and PRiSM_dfit_farField return null).
// Frozen in WP0 and kept as is:
//   • PRiSM_dfit_inputRanges — the §3.2 range table {path: {min, max, def, unit, integer, scope, display?, rows?}} with
//     clamp(inputs) → {inputs, warnings} (fields, rows, flags, unit fixes, mask and event overrides; the output always
//     passes the DfitInputs shape), clampValue(path, v) and defaults() (the reference behaviour of tests/_dfit-shapes.js
//     clampInputs);
//   • PRiSM_dfit_units.table — the display ↔ engine conversion factors of §3.5 (exactly those seven; the bbl → ft³ factor
//     of the fields map is kept apart in UNIT_EXTRA).
// Closure picks under noise (review fix round; §4.7 / §4.8 / §8.2 noise levels σ 0.05 / 0.3 / 1 psi, white and ρ1 0.9):
//   • the early p-G window is grown while its curvature is statistically absent (σ_eff, ρ1 from lag-1 / lag-2 difference
//     variances) and capped one Bourdet window before the provisional G·dP/dG departure;
//   • the departure is searched from the window start with ε as the §4.7 floor and the local noise 3σ_y/ŷ as the scale,
//     held, persistent (joint z ≥ 4) and still beyond the threshold 0.3 ln units later;
//   • the onset (compliance; the plateau end after a downward departure) is refined by a hinge fit on the pressure,
//     p = A + B·u + C·u₊² + D·u₊³, with an SSR-profile standard error; an abrupt break (an interval falling ≥ 3 × the early
//     slope after one falling less than half as fast, e.g. the exact Carter after-closure line of FIX.ds) is read at the
//     start of that interval;
//   • the tangent after an upward departure is the vertex of dP/dG (touch point of the line through the origin, s* = max
//     dP/dG) on a noise-limited short window, fitted where dP/dG ≥ (1 − δ)·s*, δ = max(ε_tangent, 3σ_s/s*); a flat top
//     longer than 0.5 ln units keeps the §4.7 plateau-end rule;
//   • the stability grid evaluates each setting at its own L; the family band adds the voting pick's own se in quadrature.
//   Deviations for lead sign-off: the hinge / vertex refinements and the se fold-in are additions to §4.7 / §4.8 (the
//   detection itself follows them, ε as the floor); classify reads to ctx.Gc → frac.Gc → ctx.consensus → the tangent G
//   (gcSource), and the pipeline (57) should pass frac or the consensus (gradual-decline signatures pick early);
//   gSpec.G(dt) / Gp(dt) take Δt in hours (§3.5), Gp = dG/dΔtD, and GD / GpD / gD take ΔtD.
// Loads without document, WTS_units, the 02 lexical helpers or any Round-9 engine (smoke stub).
// =============================================================================

// The globals used in hot loops are passed in as parameters (local bindings are much faster than global lookups in a
// vm context such as the test harness).
(function () {
  (function (Math, isFinite, Array, Object, JSON, String) {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ─────────────────────────────────────────────────────────────────────
    // §3.5 units: display ↔ engine factors (engine = h, ft, psi, ft³, psi·h)
    // ─────────────────────────────────────────────────────────────────────
    G.PRiSM_dfit_units = {
        table: {
            'bbl/min->ft3/h': 336.875,
            'ft/sqrt(min)->ft/sqrt(h)': 7.74597,
            'gal/100ft2->ft': 1 / 748.05,
            'psi*sqrt(in)->psi*sqrt(ft)': 0.288675,
            'cp->psi*h': 4.02883e-11,
            'md->ft2': 1.062315e-14,
            'bbl/psi->ft3/psi': 5.614583
        },
        // field name → [display unit, engine unit, factor display→engine]; keys not listed pass through unchanged
        fields: {
            q: 'bbl/min->ft3/h', qMax: 'bbl/min->ft3/h', qLast: 'bbl/min->ft3/h', qEq: 'bbl/min->ft3/h', qL: 'bbl/min->ft3/h', qStar: 'bbl/min->ft3/h',
            CL: 'ft/sqrt(min)->ft/sqrt(h)', Cw: 'ft/sqrt(min)->ft/sqrt(h)', CLeq: 'ft/sqrt(min)->ft/sqrt(h)',
            Sp: 'gal/100ft2->ft', KIc: 'psi*sqrt(in)->psi*sqrt(ft)',
            mu: 'cp->psi*h', muCp: 'cp->psi*h', muRes: 'cp->psi*h', k: 'md->ft2',
            VwCw: 'bbl/psi->ft3/psi', Csys: 'bbl/psi->ft3/psi', AfCf: 'bbl/psi->ft3/psi',
            V: 'bbl->ft3', Vi: 'bbl->ft3', ViStar: 'bbl->ft3', ViFrac: 'bbl->ft3', Vf: 'bbl->ft3', VL: 'bbl->ft3', Vfill: 'bbl->ft3', Vfb: 'bbl->ft3'
        },
        toEngine: function (obj) { return _unitConv(obj, false); },
        toDisplay: function (obj) { return _unitConv(obj, true); }
    };
    // factors used by the fields map but not part of the frozen §3.5 table (kept apart so the table deep-compares as frozen)
    var UNIT_EXTRA = { 'bbl->ft3': 5.614583 };
    function _unitConv(obj, inverse) {
        try {
            if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: 'BAD_INPUT', errors: ['PRiSM_dfit_units: an object of named fields is needed.'], bad: [] };
            var U = G.PRiSM_dfit_units, out = {};
            for (var k in obj) {
                if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                var v = obj[k], key = U.fields[k], f = key ? (U.table[key] || UNIT_EXTRA[key]) : null;
                if (!f) { out[k] = v; continue; }
                var fac = inverse ? 1 / f : f;
                if (typeof v === 'number') out[k] = isFinite(v) ? v * fac : null;
                else if (Array.isArray(v)) out[k] = v.map(function (x) { return (typeof x === 'number' && isFinite(x)) ? x * fac : null; });
                else out[k] = v;
            }
            return out;
        } catch (e) {
            return { ok: false, code: 'UNIT_FAILED', errors: [String(e && e.message || e)], bad: [] };
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // §3.2 range table (FROZEN in WP0) and the clamp
    // ─────────────────────────────────────────────────────────────────────
    var IMAX = 2147483647;
    function R(min, max, def, unit, integer, scope, extra) {
        var o = { min: min, max: max, def: def, unit: unit, integer: !!integer, scope: scope || 'inputs' };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
        return o;
    }
    var TABLE = {
        'datumTvd':                 R(100, 40000, null, 'ft'),
        'datumMd':                  R(100, 40000, null, 'ft'),
        'gauge.bhTvd':              R(0, 40000, null, 'ft'),
        'gauge.bhMd':               R(0, 40000, null, 'ft'),
        'survey':                   R(0, 2000, null, 'rows', true, 'rows', { rows: true }),
        'strings':                  R(0, 10, null, 'rows', true, 'rows', { rows: true }),
        'tests':                    R(0, 12, null, 'rows', true, 'rows', { rows: true }),
        'fluid.rhoPpg':             R(6, 20, 8.43, 'ppg'),
        'fluid.salinityWt':         R(0, 30, null, 'wt %'),
        'fluid.muCp':               R(0.1, 5000, 1.0, 'cp'),
        'fluid.fr':                 R(0, 0.85, 0, '–'),
        'fluid.nPrime':             R(0.1, 1, null, '–'),
        'fluid.kPrime':             R(1e-6, 1, null, 'lbf·sⁿ/ft²'),
        'fluid.tInjF':              R(32, 300, 70, '°F'),
        'temp.surfF':               R(-20, 150, 70, '°F'),
        'temp.gradFper100':         R(0.5, 4, 1.5, '°F/100 ft'),
        'temp.tauLoH':              R(0.05, 24, 0.5, 'h'),
        'temp.tauHiH':              R(0.1, 72, 5, 'h'),
        'perfs.n':                  R(1, 2000, null, '–', true),
        'perfs.dIn':                R(0.1, 1.5, 0.40, 'in'),
        'perfs.cd':                 R(0.4, 1.0, 0.62, '–'),
        'rock.Ep':                  R(1e5, 2e7, null, 'psi', false, 'inputs', { display: { unit: '1e6 psi', scale: 1e6 } }),
        'rock.nu':                  R(0.05, 0.45, 0.25, '–'),
        'rock.hf':                  R(1, 5000, null, 'ft'),
        'rock.hp':                  R(1, 5000, null, 'ft'),
        'rock.barrierSpacing':      R(1, 5000, null, 'ft'),
        'rock.sigmaVGrad':          R(0.7, 1.3, 1.0, 'psi/ft'),
        'rock.sigmaVGradLo':        R(0.7, 1.3, 0.9, 'psi/ft'),
        'rock.muFricWarn':          R(0.3, 1.2, 0.6, '–'),
        'rock.muFricVeto':          R(0.3, 1.2, 1.0, '–'),
        'rock.biot':                R(0, 1, 1.0, '–'),
        'priors.sigmaGrad':         R(0.4, 1.3, null, 'psi/ft'),
        'priors.sigmaGradSd':       R(0.005, 0.2, 0.02, 'psi/ft'),
        'priors.piGrad':            R(0.2, 1.0, null, 'psi/ft'),
        'channels.atmPsia':         R(10, 15.2, 14.696, 'psia'),
        'channels.clockOffsetH':    R(-24, 24, 0, 'h'),
        'options.alphaGeneral':     R(0.51, 1, 0.75, '–'),
        'options.L':                R(0.05, 0.4, 0.1, 'ln units'),
        'options.gMin':             R(0, 50, 'auto', 'G'),
        'options.eps.compliance':   R(0.005, 0.3, 0.02, '–'),
        'options.eps.tangent':      R(0.005, 0.3, 0.02, '–'),
        'options.eps.loglog':       R(0.005, 0.3, 0.05, '–'),
        'options.tau.abs':          R(1, 200, 15, 'psi'),
        'options.tau.fSigma':       R(0, 0.02, 0.003, '–'),
        'options.tau.fN':           R(0, 0.2, 0.03, '–'),
        'options.familyWeightF1':   R(0, 1, 0.5, '–'),
        'options.aca.LB':           R(0.1, 0.5, 0.25, 'ln units'),
        'options.unc.n':            R(100, 2000, 1000, 'draws', true),
        'options.unc.seed':         R(1, IMAX, 1, '–', true),
        'designer.n':               R(50, 2000, 500, 'draws', true, 'designer'),
        'designer.seed':            R(1, IMAX, 1, '–', true, 'designer'),
        'synth.seed':               R(1, IMAX, 1, '–', true, 'synth'),
        'sandbox.V':                R(0.1, 2000, 25, 'bbl', false, 'sandbox'),
        'sandbox.q':                R(0.05, 100, 5, 'bbl/min', false, 'sandbox'),
        'sandbox.tEnd':             R(0.01, 10000, 300, 'h', false, 'sandbox')
    };
    var ENUMS = {
        'fluid.kind': ['water', 'slickwater', 'gel', 'oil'],
        'temp.model': ['static', 'displaced', 'ramey'],
        'rock.EpSource': ['static', 'dynamic-corrected', 'dynamic', 'unknown'],
        'channels.primary': ['bh', 'surface'],
        'options.alpha': ['auto', 0.5, 1, 'general', 'data'],
        'options.tp': ['pump', 'breakdown', 'veq'],
        'options.aca.origin': ['centroid', 'total', 'midInjection', 'sinceClosure'],
        'options.aca.tideRemove': ['auto', 'on', 'off']
    };
    function defaults() {
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
                triage: {}
            }
        };
    }
    function _isObj(v) { return v !== null && typeof v === 'object' && !(Array.isArray(v)); }
    function _get(o, path) { var ks = path.split('.'), a = o; for (var i = 0; i < ks.length; i++) { if (a == null) return undefined; a = a[ks[i]]; } return a; }
    function _set(o, path, v) { var ks = path.split('.'), a = o; for (var i = 0; i < ks.length - 1; i++) { if (!_isObj(a[ks[i]])) a[ks[i]] = {}; a = a[ks[i]]; } a[ks[ks.length - 1]] = v; }
    function _copy(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    function _merge(dst, src) {
        if (!_isObj(src)) return dst;
        for (var k in src) {
            if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
            if (_isObj(dst[k]) && _isObj(src[k])) _merge(dst[k], src[k]);
            else if (src[k] !== undefined) dst[k] = _copy(src[k]);
        }
        return dst;
    }
    function _fmt(x) {
        if (Math.abs(x) >= 1e6 || (x !== 0 && Math.abs(x) < 1e-3)) return x.toExponential(3).replace('e+', 'e');
        return String(+x.toPrecision(6));
    }
    // Numbers pass; blank = undefined, null or an all-space string; anything else is unparsable. A string without a comma
    // must match a strict decimal pattern. A string with a comma is read with WTS_parseNumber (resolved at CALL time) when
    // that parser follows the decimal-comma option (WTS_parseNumber('1,5') === 1.5) and the string has the 'digits,digits'
    // form; otherwise the fallback rule: '1,5' → 1.5 (one comma, no point, not three digits after it), '1,500' (1–3 digits,
    // a comma, exactly three digits) → ambiguous (thousands separator or decimal comma) → unparsable, '1,500,000' / '1,500.5'
    // (well-formed thousands groups) → 1500000 / 1500.5, any other comma → unparsable. Same as parseRaw in tests/_dfit-shapes.js.
    var NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
    var DEC_COMMA_RE = /^[-+]?\d*,\d+(e[-+]?\d+)?$/i;
    function _parse(v) {
        if (v === undefined || v === null) return { blank: true };
        if (typeof v === 'number') return isFinite(v) ? { num: v } : { bad: true };
        if (typeof v !== 'string') return { bad: true };
        var s = v.replace(/^\s+|\s+$/g, '');
        if (!s) return { blank: true };
        var t = s;
        if (s.indexOf(',') !== -1) {
            var pn = (typeof G.WTS_parseNumber === 'function') ? G.WTS_parseNumber : null;
            if (pn && DEC_COMMA_RE.test(s) && pn('1,5') === 1.5) {
                var y = pn(s);
                return (typeof y === 'number' && isFinite(y)) ? { num: y } : { bad: true };
            }
            if (/^[-+]?\d+,\d+$/.test(s)) {
                if (/^[-+]?\d{1,3},\d{3}$/.test(s)) return { bad: true, ambiguous: true };
                t = s.replace(',', '.');
            } else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) t = s.replace(/,/g, '');
            else return { bad: true };
        }
        if (!NUM_RE.test(t)) return { bad: true };
        var x = Number(t);
        return isFinite(x) ? { num: x } : { bad: true };
    }
    function _w(code, text) { return { code: code, level: 'warn', text: text, ev: [] }; }
    function clampValue(path, v) {
        var r = TABLE[path];
        if (!r) return { value: v, warning: null };
        if (r.def === 'auto' && v === 'auto') return { value: 'auto', warning: null };
        var raw = _parse(v);
        if (raw.blank) {
            if (r.def === null || r.def === 'auto') return { value: r.def, warning: null };
            return { value: r.def, warning: _w('INPUT_DEFAULT', path + ' was blank; the default ' + _fmt(r.def) + ' ' + r.unit + ' is used.') };
        }
        if (raw.bad) {
            return { value: r.def, warning: _w('INPUT_DEFAULT', path + (raw.ambiguous ? ' ' + v.replace(/^\s+|\s+$/g, '') + ' is ambiguous (a thousands separator or a decimal comma); ' : ' could not be read as a number; ') +
                (r.def === null ? 'it is left unset.' : 'the default ' + (r.def === 'auto' ? 'auto' : _fmt(r.def) + ' ' + r.unit) + ' is used.')) };
        }
        var x = raw.num;
        if (r.integer) x = Math.round(x);
        if (x < r.min) return { value: r.min, warning: _w('INPUT_CLAMPED', path + ' ' + _fmt(raw.num) + ' is below the minimum ' + _fmt(r.min) + ' ' + r.unit + '; ' + _fmt(r.min) + ' is used.') };
        if (x > r.max) return { value: r.max, warning: _w('INPUT_CLAMPED', path + ' ' + _fmt(raw.num) + ' is above the maximum ' + _fmt(r.max) + ' ' + r.unit + '; ' + _fmt(r.max) + ' is used.') };
        if (x === 0) x = 0;
        return { value: x, warning: (r.integer && x !== raw.num) ? _w('INPUT_ROUNDED', path + ' ' + _fmt(raw.num) + ' is rounded to the integer ' + x + '.') : null };
    }
    // clamp (same steps and warnings as clampInputs in tests/_dfit-shapes.js):
    //   1. defaults completed; a non-object where the defaults hold an object → the default object (INPUT_DEFAULT)
    //   2. every 'inputs' range-table field through clampValue
    //   3. survey / strings: a non-list → unset / no string; invalid rows dropped (ROWS_DROPPED: survey [md, tvd] finite with MD
    //      strictly ascending; string id, od, wall > 0, id < od, finite topMd < botMd; an invalid tubKey → null); row caps
    //   4. enums; 5. flags (true/false kept, 'true'/1 and 'false'/0 coerced, else the default)
    //   6. channels.unitFix.* {kind, factor, offset} or null; depthFix object or null; mask rows [t0 < t1, why]
    //   7. events.tStart / tb / ts finite or null; events.flowback null or finite t0 ≤ t1
    var FLAGS = ['channels.psig.p', 'channels.psig.pSurf', 'channels.psig.pAnn', 'options.axisLock', 'options.ppd', 'options.aca.carterExactFR'];
    function _isNum(v) { return typeof v === 'number' && isFinite(v); }
    function _plural(n) { return n === 1 ? '1 row is' : n + ' rows are'; }
    function _repairObjects(out, def, prefix, warnings) {
        for (var k in def) {
            if (!Object.prototype.hasOwnProperty.call(def, k) || !_isObj(def[k])) continue;
            var p = prefix ? prefix + '.' + k : k;
            if (!_isObj(out[k])) { out[k] = _copy(def[k]); warnings.push(_w('INPUT_DEFAULT', p + ' is not a group of fields; its defaults are used.')); continue; }
            _repairObjects(out[k], def[k], p, warnings);
        }
    }
    function clamp(inputs) {
        try {
            var out = _merge(defaults(), _isObj(inputs) ? inputs : {}), warnings = [], k, c, i, keep, row;
            _repairObjects(out, defaults(), '', warnings);
            for (k in TABLE) {
                if (!Object.prototype.hasOwnProperty.call(TABLE, k) || TABLE[k].scope !== 'inputs') continue;
                c = clampValue(k, _get(out, k));
                _set(out, k, c.value);
                if (c.warning) warnings.push(c.warning);
            }
            // rows
            if (out.survey !== null && !(Array.isArray(out.survey))) { out.survey = null; warnings.push(_w('INPUT_DEFAULT', 'survey is not a list of rows; it is left unset.')); }
            if (!(Array.isArray(out.strings))) { out.strings = []; warnings.push(_w('INPUT_DEFAULT', 'strings is not a list of rows; no string is used.')); }
            if (Array.isArray(out.survey)) {
                keep = []; var last = -Infinity;
                for (i = 0; i < out.survey.length; i++) {
                    row = out.survey[i];
                    if (Array.isArray(row) && row.length >= 2 && _isNum(row[0]) && _isNum(row[1]) && row[0] > last) { keep.push([row[0], row[1]]); last = row[0]; }
                }
                if (keep.length !== out.survey.length) warnings.push(_w('ROWS_DROPPED', 'survey: ' + _plural(out.survey.length - keep.length) + ' not [MD, TVD] pairs of finite numbers with MD ascending; dropped.'));
                out.survey = keep;
            }
            keep = [];
            for (i = 0; i < out.strings.length; i++) {
                row = out.strings[i];
                if (!_isObj(row)) continue;
                if (!(_isNum(row.id) && _isNum(row.od) && _isNum(row.wall) && row.id > 0 && row.od > 0 && row.wall > 0 && row.id < row.od)) continue;
                if (!(_isNum(row.topMd) && _isNum(row.botMd) && row.topMd < row.botMd)) continue;
                var cr = _copy(row);
                if (!(typeof cr.tubKey === 'string' && cr.tubKey.length > 0)) cr.tubKey = null;
                keep.push(cr);
            }
            if (keep.length !== out.strings.length) warnings.push(_w('ROWS_DROPPED', 'strings: ' + _plural(out.strings.length - keep.length) + ' without id < od, wall > 0 and top MD < bottom MD; dropped.'));
            out.strings = keep;
            ['survey', 'strings'].forEach(function (key) {
                var a = out[key], cap = TABLE[key].max;
                if (Array.isArray(a) && a.length > cap) { out[key] = a.slice(0, cap); warnings.push(_w('ROWS_TRUNCATED', key + ' has ' + a.length + ' rows; the first ' + cap + ' are kept.')); }
            });
            // enums
            for (k in ENUMS) {
                if (!Object.prototype.hasOwnProperty.call(ENUMS, k)) continue;
                if (ENUMS[k].indexOf(_get(out, k)) === -1) {
                    var d = _get(defaults(), k);
                    _set(out, k, d);
                    warnings.push(_w('INPUT_DEFAULT', k + ' is not one of the allowed values; ' + d + ' is used.'));
                }
            }
            // flags
            FLAGS.forEach(function (fk) {
                var v = _get(out, fk);
                if (v === true || v === false) return;
                if (v === 'true' || v === 1) { _set(out, fk, true); return; }
                if (v === 'false' || v === 0) { _set(out, fk, false); return; }
                var fd = _get(defaults(), fk);
                _set(out, fk, fd);
                warnings.push(_w('INPUT_DEFAULT', fk + ' is not true or false; ' + fd + ' is used.'));
            });
            // channels: unit fixes, depth fix, mask
            var ch = out.channels;
            ['p', 'pSurf', 'q', 't'].forEach(function (uk) {
                var f = ch.unitFix[uk];
                if (f === null) return;
                if (_isObj(f) && typeof f.kind === 'string' && f.kind.length > 0 && _isNum(f.factor) && _isNum(f.offset)) return;
                ch.unitFix[uk] = null;
                warnings.push(_w('INPUT_DEFAULT', 'channels.unitFix.' + uk + ' is not a unit fix (kind, factor, offset); no fix is applied.'));
            });
            if (ch.depthFix !== null && !_isObj(ch.depthFix)) { ch.depthFix = null; warnings.push(_w('INPUT_DEFAULT', 'channels.depthFix is not a depth fix; no fix is applied.')); }
            if (!(Array.isArray(ch.mask))) { ch.mask = []; warnings.push(_w('INPUT_DEFAULT', 'channels.mask is not a list of windows; nothing is masked.')); }
            keep = [];
            for (i = 0; i < ch.mask.length; i++) {
                row = ch.mask[i];
                if (Array.isArray(row) && row.length >= 2 && _isNum(row[0]) && _isNum(row[1]) && row[0] < row[1]) keep.push([row[0], row[1], typeof row[2] === 'string' ? row[2] : '']);
            }
            if (keep.length !== ch.mask.length) warnings.push(_w('ROWS_DROPPED', 'channels.mask: ' + _plural(ch.mask.length - keep.length) + ' not [t0, t1, why] windows with t0 < t1; dropped.'));
            ch.mask = keep;
            // events (user overrides)
            var evs = out.events;
            ['tStart', 'tb', 'ts'].forEach(function (ek) {
                var raw = _parse(evs[ek]);
                if (raw.blank) { evs[ek] = null; return; }
                if (raw.bad) { evs[ek] = null; warnings.push(_w('INPUT_DEFAULT', 'events.' + ek + ' could not be read as a time; the detected event is used.')); return; }
                evs[ek] = raw.num === 0 ? 0 : raw.num;
            });
            if (evs.flowback !== null) {
                var fb = evs.flowback;
                if (!(_isObj(fb) && _isNum(fb.t0) && _isNum(fb.t1) && fb.t0 <= fb.t1)) {
                    evs.flowback = null;
                    warnings.push(_w('INPUT_DEFAULT', 'events.flowback is not a window with t0 ≤ t1; the detected flowback is used.'));
                }
            }
            return { inputs: out, warnings: warnings };
        } catch (e) {
            return { ok: false, code: 'CLAMP_FAILED', errors: [String(e && e.message || e)], bad: [] };
        }
    }
    G.PRiSM_dfit_inputRanges = { table: TABLE, enums: ENUMS, defaults: defaults, clamp: clamp, clampValue: clampValue };


    // ═════════════════════════════════════════════════════════════════════
    // WP2 ENGINE (docs/DFIT-PLAN.md §3.5, §4.1, §4.3–§4.11, §6.2, §6.12)
    // Internal units: time h, pressure psi, rate bbl/min, volume bbl, compliance bbl/psi (geometry in ft / ft³ / psi).
    // Cross-file engines (WTS_wellbore, PRiSM_lm, PRiSM_compute_bourdet, PRiSM_rng, PRiSM_autoInterp, PRiSM_dfit_lk*) are
    // resolved at CALL time, each behind a typeof guard with a stated fallback.
    // ═════════════════════════════════════════════════════════════════════
    var BBL = 5.614583;            // ft³ per bbl
    var PI = Math.PI;
    var LN10 = Math.LN10;
    var INF = 1 / 0;

    function _fail(code, msg, bad) { return { ok: false, code: code, errors: [String(msg)], bad: bad || [] }; }
    function _W(code, level, text, ev) { return { code: code, level: level || 'warn', text: _txt(text), ev: ev || [] }; }
    // plain text < 300 characters, never the banned words (§3.0)
    function _txt(s) {
        s = String(s == null ? '' : s).replace(/\b(null|undefined|NaN|Infinity)\b/g, 'n/a').replace(/\[object Object\]/g, '');
        return s.length > 299 ? s.slice(0, 296) + '...' : s;
    }
    function _fin(v) { return typeof v === 'number' && v - v === 0; }
    function _nn(v) { return _fin(v) ? v : null; }                 // finite or null
    function _r(v, n) { if (!_fin(v)) return null; var f = Math.pow(10, n); return Math.round(v * f) / f; }
    function _sf(v, n) { return _fin(v) ? +v.toPrecision(n) : null; }
    function _f0(v) { return _fin(v) ? String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : 'n/a'; }   // 7,000
    function _f1(v, n) { return _fin(v) ? (+v.toFixed(n == null ? 1 : n)).toString() : 'n/a'; }
    function _clampN(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function _kth(s, k) {                    // k-th smallest (quickselect, in place, deterministic middle pivot)
        var lo = 0, hi = s.length - 1;
        while (lo < hi) {
            var piv = s[(lo + hi) >> 1], i = lo, j = hi;
            while (i <= j) { while (s[i] < piv) i++; while (s[j] > piv) j--; if (i <= j) { var t = s[i]; s[i] = s[j]; s[j] = t; i++; j--; } }
            if (k <= j) hi = j; else if (k >= i) lo = i; else break;
        }
        return s[k];
    }
    function _median(a) {
        var s = []; for (var i = 0; i < a.length; i++) { var x = a[i]; if (typeof x === 'number' && x === x && x !== INF && x !== -INF) s.push(x); }
        if (!s.length) return null;
        var m = s.length >> 1;
        if (s.length % 2) return _kth(s, m);
        var hiV = _kth(s, m), loV = -INF;
        for (i = 0; i < m; i++) if (s[i] > loV) loV = s[i];       // after the select, s[0..m-1] ≤ s[m]
        return 0.5 * (loV + hiV);
    }
    function _pct(sorted, q) {             // sorted ascending, linear interpolation
        if (!sorted.length) return null;
        var x = q * (sorted.length - 1), i = Math.floor(x), f = x - i;
        return i + 1 < sorted.length ? sorted[i] + f * (sorted[i + 1] - sorted[i]) : sorted[i];
    }
    function _sortedFinite(a) { var s = []; for (var i = 0; i < a.length; i++) if (_fin(a[i])) s.push(a[i]); s.sort(function (x, y) { return x - y; }); return s; }
    function _isObj2(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function _okRes(v) { return _isObj2(v) && v.ok !== false; }
    function _fn(name) { return (typeof G[name] === 'function') ? G[name] : null; }
    function _wb(name) { var W = G.WTS_wellbore; return (W && typeof W[name] === 'function' && !W[name]._dfitStub) ? W[name] : null; }
    function _safe(f) {                     // public functions never throw (§3.0)
        return function () {
            try { return f.apply(this, arguments); }
            catch (e) { return _fail('ENGINE_ERROR', 'DFIT engine error: ' + String(e && e.message || e).slice(0, 200)); }
        };
    }

    // ── seeded PRNG: PRiSM_rng (05, WPH) at call time, else mulberry32 (never an unseeded generator) ──
    function _rng(seed) {
        var f = _fn('PRiSM_rng');
        if (f) { try { var r = f(seed == null ? 1 : seed); if (typeof r === 'function') return r; } catch (e) { /* fall through */ } }
        var a = (seed == null ? 1 : seed) >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ── hashes (§3.0): 53's canon + hash16 when present, else a local FNV-1a pair (weak) ──
    function _fnv(s, seed) {
        var h = seed >>> 0;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        return h >>> 0;
    }
    function _hex8(x) { var s = (x >>> 0).toString(16); while (s.length < 8) s = '0' + s; return s; }
    function _hash(obj) {
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.canon === 'function' && typeof AI.hash16 === 'function') {
            try { var h = AI.hash16(AI.canon(obj, 'inputs')); if (typeof h === 'string' && /^[0-9a-f]{16}$/.test(h)) return { hash: h, weak: false }; } catch (e) { /* fall through */ }
        }
        var s = JSON.stringify(obj, function (k, v) { return (typeof v === 'number' && !isFinite(v)) ? null : v; });
        return { hash: _hex8(_fnv(s, 2166136261)) + _hex8(_fnv(s, 0x811c9dc5 ^ 0x5bd1e995)), weak: true };
    }
    G.PRiSM_dfit_dsHash = _safe(function (ds) {
        if (!_isObj2(ds) || !Array.isArray(ds.t) || !Array.isArray(ds.p)) return _fail('BAD_DATASET', 'A dataset with t and p arrays is needed.', ['t', 'p']);
        return _hash({ t: ds.t, p: ds.p, q: ds.q || null }).hash;
    });
    G.PRiSM_dfit_hash = function (obj) { return _hash(obj); };   // {hash, weak} for 57 / 59 (inputHash, picksHash)

    // ── Gauss–Legendre 64 nodes on [0, 1] (computed once at load, Newton on P64) ──
    var GL = (function () {
        var n = 64, x = [], w = [];
        for (var i = 1; i <= n; i++) {
            var z = Math.cos(PI * (i - 0.25) / (n + 0.5)), pp = 0;
            for (var it = 0; it < 100; it++) {
                var p1 = 1, p2 = 0;
                for (var j = 1; j <= n; j++) { var p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
                pp = n * (z * p1 - p2) / (z * z - 1);
                var z1 = z; z = z1 - p1 / pp;
                if (Math.abs(z - z1) < 1e-15) break;
            }
            x.push(0.5 * (1 - z)); w.push(1 / ((1 - z * z) * pp * pp));      // mapped to [0,1]: weight 2/((1-z²)P'²) × ½
        }
        return { x: x, w: w };
    })();

    // ═════════════════════════════════════════════════════════════════════
    // §4.5 G-function family
    // ═════════════════════════════════════════════════════════════════════
    // g(ΔtD, α) = 2∫₀¹ √(1 + ΔtD − a^(1/α)) da; general α by a = 1 − (1 − u)² and 64-point Gauss–Legendre on u.
    function _gQuad(d, alpha) {
        var s = 0, ia = 1 / alpha;
        for (var k = 0; k < 64; k++) {
            var u = GL.x[k], om = 1 - u, a = 1 - om * om, v = 1 + d - Math.pow(a, ia);
            s += GL.w[k] * 2 * om * Math.sqrt(v > 0 ? v : 0);
        }
        return 2 * s;
    }
    function _gpQuad(d, alpha) {          // dg/dΔtD = ∫₀¹ da / √(1 + ΔtD − a^(1/α))
        var s = 0, ia = 1 / alpha;
        for (var k = 0; k < 64; k++) {
            var u = GL.x[k], om = 1 - u, a = 1 - om * om, v = 1 + d - Math.pow(a, ia);
            if (v <= 0) {                  // ΔtD = 0 at a → 1: the integrand limit 2(1 − u)/√(1 − a^(1/α)) → 2√α
                s += GL.w[k] * 2 * Math.sqrt(alpha);
                continue;
            }
            s += GL.w[k] * 2 * om / Math.sqrt(v);
        }
        return s;
    }
    function _alphaOf(a) {
        if (a === 0.5 || a === 1) return a;
        if (_fin(a) && a > 0.5 && a <= 1) return a;
        return null;
    }
    function _isSpec(s) { return _isObj2(s) && typeof s.G === 'function'; }
    function g_(d, alpha) {
        if (!(d >= 0)) return NaN;
        if (alpha === 1) return 4 / 3 * (Math.pow(1 + d, 1.5) - Math.pow(d, 1.5));
        if (alpha === 0.5) return (1 + d) * Math.asin(1 / Math.sqrt(1 + d)) + Math.sqrt(d);
        return _gQuad(d, alpha);
    }
    function gp_(d, alpha) {
        if (!(d >= 0)) return NaN;
        if (alpha === 1) return 2 * (Math.sqrt(1 + d) - Math.sqrt(d));
        if (alpha === 0.5) return Math.asin(1 / Math.sqrt(1 + d));
        return _gpQuad(d, alpha);
    }
    var _g0cache = {};
    function g0_(alpha) {
        if (alpha === 0.5) return PI / 2;
        if (alpha === 1) return 4 / 3;
        var k = String(alpha);
        if (!(k in _g0cache)) _g0cache[k] = _gQuad(0, alpha);
        return _g0cache[k];
    }
    function G_(d, alpha) { return 4 / PI * (g_(d, alpha) - g0_(alpha)); }
    function Gp_(d, alpha) { return 4 / PI * gp_(d, alpha); }       // dG/dΔtD
    // generic G / G′ for an α or a gSpec
    // a gSpec's public G(dt) / Gp(dt) take the shut-in time in hours (§3.5, §3.0); the engine works in ΔtD through GD / GpD
    // (a gSpec without them is converted with its tp)
    function _sGD(a, d) { return typeof a.GD === 'function' ? a.GD(d) : a.G(d * a.tp); }
    function _sGpD(a, d) { return typeof a.GpD === 'function' ? a.GpD(d) : a.Gp(d * a.tp); }
    function _Gof(d, a) { return _isSpec(a) ? _sGD(a, d) : G_(d, a); }
    function _Gpof(d, a) { return _isSpec(a) ? _sGpD(a, d) : Gp_(d, a); }
    function _Ginv(Gv, a) {
        if (!(Gv >= 0)) return NaN;
        if (Gv === 0) return 0;
        var lo = Math.log(1e-9), hi = Math.log(1e7);
        for (var i = 0; i < 60; i++) {
            var m = 0.5 * (lo + hi);
            if (_Gof(Math.exp(m), a) < Gv) lo = m; else hi = m;
        }
        return Math.exp(0.5 * (lo + hi));
    }
    G.PRiSM_dfit_g = function (dtD, alpha) {
        if (_isSpec(alpha)) return _nn(typeof alpha.gD === 'function' ? alpha.gD(dtD) : (alpha.g ? alpha.g(dtD * alpha.tp) : NaN));
        var a = _alphaOf(alpha); if (a === null || !_fin(dtD) || dtD < 0) return null;
        return _nn(g_(dtD, a));
    };
    G.PRiSM_dfit_g.quad = function (dtD, alpha) { return (_fin(dtD) && dtD >= 0 && alpha > 0.5 - 1e-12 && alpha <= 1) ? _gQuad(dtD, alpha) : null; };
    G.PRiSM_dfit_g.g0 = function (alpha) { var a = _alphaOf(alpha); return a === null ? null : g0_(a); };
    G.PRiSM_dfit_gPrime = function (dtD, alpha) {
        if (_isSpec(alpha)) return _nn(_sGpD(alpha, dtD) * PI / 4);
        var a = _alphaOf(alpha); if (a === null || !_fin(dtD) || dtD < 0) return null;
        return _nn(gp_(dtD, a));
    };
    G.PRiSM_dfit_gPrime.quad = function (dtD, alpha) { return (_fin(dtD) && dtD >= 0 && alpha > 0.5 - 1e-12 && alpha <= 1) ? _gpQuad(dtD, alpha) : null; };
    G.PRiSM_dfit_G = function (dtD, alpha) {
        if (!_fin(dtD) || dtD < 0) return null;
        if (_isSpec(alpha)) return _nn(_sGD(alpha, dtD));
        var a = _alphaOf(alpha); if (a === null) return null;
        return _nn(G_(dtD, a));
    };
    G.PRiSM_dfit_Ginv = function (Gv, alpha) {
        if (!_fin(Gv) || Gv < 0) return null;
        var a = _isSpec(alpha) ? alpha : _alphaOf(alpha);
        if (a === null) return null;
        return _nn(_Ginv(Gv, a));
    };
    // η_G = G_c/(G_c + 4·g0/π) (§4.9) and the α-pair display rule (|η(½) − η(1)| > 0.01)
    G.PRiSM_dfit_eta = function (Gc, alpha) {
        var a = _alphaOf(alpha); if (a === null || !_fin(Gc) || Gc <= 0) return null;
        return Gc / (Gc + 4 * g0_(a) / PI);
    };
    G.PRiSM_dfit_etaPair = function (dtDc) {
        if (!_fin(dtDc) || dtDc <= 0) return null;
        var G5 = G_(dtDc, 0.5), G1 = G_(dtDc, 1), e5 = G5 / (G5 + 2), e1 = G1 / (G1 + 16 / (3 * PI));
        return { Gc: { a05: G5, a1: G1 }, a05: e5, a1: e1, delta: Math.abs(e1 - e5), showPair: Math.abs(e1 - e5) > 0.01 };
    };

    // ── data-driven G (§4.5): g(Δt) = 2∫₀¹ √((t_s + Δt − τ(a))/tp) da, τ(a) the opening time of area fraction a ──
    // schedule: rate steps [{t, q}] (q bbl/min from t to the next t; the last step runs to ts) or, with opts.area 'model',
    // opts.modelHist {t, AL} (area history). a = (V(τ)/V_total)^α (volume) or AL(τ)/AL(ts) (model). The gSpec's g(dt), G(dt) and Gp(dt) take the
    // shut-in time Δt in hours (§3.5); Gp is dG/dΔtD (the derivative used by D_ref = m_G·ΔtD·G′). gD / GD / GpD take ΔtD.
    function _invMonotone(xs, ys, y) {      // xs ascending, ys non-decreasing → x at y (linear)
        var n = xs.length;
        if (y <= ys[0]) return xs[0];
        if (y >= ys[n - 1]) return xs[n - 1];
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) { var m = (lo + hi) >> 1; if (ys[m] < y) lo = m; else hi = m; }
        var dy = ys[hi] - ys[lo];
        return dy > 0 ? xs[lo] + (y - ys[lo]) / dy * (xs[hi] - xs[lo]) : xs[hi];
    }
    G.PRiSM_dfit_gFromHistory = _safe(function (schedule, ts, tp, opts) {
        opts = opts || {};
        if (!_fin(ts) || !_fin(tp) || tp <= 0) return _fail('BAD_INPUT', 'gFromHistory needs a shut-in time and tp > 0.', ['ts', 'tp']);
        var alpha = _alphaOf(opts.alpha == null ? 0.5 : opts.alpha);
        if (alpha === null) return _fail('BAD_INPUT', 'alpha must lie in (0.5, 1].', ['alpha']);
        var kind = opts.area === 'model' ? 'model' : 'data', xs = [], ys = [], i;
        if (kind === 'model') {
            var mh = opts.modelHist;
            if (!mh || !Array.isArray(mh.t) || !Array.isArray(mh.AL) || mh.t.length < 2) return _fail('BAD_INPUT', 'The model area history (t, AL) is missing.', ['modelHist']);
            for (i = 0; i < mh.t.length; i++) if (_fin(mh.t[i]) && _fin(mh.AL[i]) && mh.t[i] <= ts + 1e-12) { xs.push(mh.t[i]); ys.push(Math.max(ys.length ? ys[ys.length - 1] : 0, mh.AL[i])); }
        } else {
            if (!Array.isArray(schedule) || !schedule.length) return _fail('BAD_INPUT', 'A rate schedule is needed.', ['schedule']);
            var V = 0;
            for (i = 0; i < schedule.length; i++) {
                var s = schedule[i], t0 = s.t, t1 = (i + 1 < schedule.length) ? schedule[i + 1].t : ts;
                if (!_fin(t0) || !_fin(t1)) continue;
                t1 = Math.min(t1, ts);
                if (t1 <= t0) continue;
                if (!xs.length) { xs.push(t0); ys.push(0); }
                else if (t0 > xs[xs.length - 1]) { xs.push(t0); ys.push(V); }
                V += Math.max(0, _fin(s.q) ? s.q : 0) * (t1 - t0) * 60;
                xs.push(t1); ys.push(V);
            }
        }
        var tot = ys.length ? ys[ys.length - 1] : 0;
        if (!(tot > 0)) return _fail('NO_VOLUME', 'The schedule injects no volume before shut-in.', ['schedule']);
        // τ at the 64 nodes (independent of Δt)
        var tau = [], jac = [];
        for (var k = 0; k < 64; k++) {
            var u = GL.x[k], om = 1 - u, a = 1 - om * om;
            var frac = kind === 'model' ? a : Math.pow(a, 1 / alpha);
            tau.push(_invMonotone(xs, ys, frac * tot));
            jac.push(GL.w[k] * 2 * om);
        }
        function gD(d) {
            var dt = d * tp, s2 = 0;
            for (var k2 = 0; k2 < 64; k2++) { var v = (ts + dt - tau[k2]) / tp; s2 += jac[k2] * Math.sqrt(v > 0 ? v : 0); }
            return 2 * s2;
        }
        function gpD(d) {
            var dt = d * tp, s2 = 0;
            for (var k2 = 0; k2 < 64; k2++) { var v = (ts + dt - tau[k2]) / tp; s2 += v > 1e-12 ? jac[k2] / Math.sqrt(v) : 0; }
            return s2;
        }
        var g0 = gD(0);
        return {
            ok: true, kind: kind, alpha: alpha, tp: tp, ts: ts, g0: g0, dtUnit: 'h',
            g: function (dt) { return gD(dt / tp); }, G: function (dt) { return 4 / PI * (gD(dt / tp) - g0); }, Gp: function (dt) { return 4 / PI * gpD(dt / tp); },
            gD: gD, GD: function (d) { return 4 / PI * (gD(d) - g0); }, GpD: function (d) { return 4 / PI * gpD(d); },
            tauNodes: tau.map(function (x) { return x; })
        };
    });

    // ── h-function (gate G6, §4.6): the definition and check values could not be taken from a verified source in this
    // increment, so the h-function, its permeability estimate and the far-field extension reading stay on the 3.4b slip
    // list (plan §9 WP2, gate G6). The function returns null and the dfitH plot stays hidden. ──
    G.PRiSM_dfit_hFn = function () { return null; };
    G.PRiSM_dfit_hFn.gate = { id: 'G6', verified: false, note: 'h-function deferred to 3.4b (gate G6): definition not verified against the cited source.' };

    // ═════════════════════════════════════════════════════════════════════
    // §4.6 Bourdet derivative (one engine): PRiSM_compute_bourdet (02, O(n) after WPH) at call time, else the same
    // two-pointer algorithm here. Points without a full window (L on both sides) are NaN.
    // ═════════════════════════════════════════════════════════════════════
    function _bourdet(x, y, L) {
        var n = x.length, out = new Array(n), lnx = new Array(n), i;
        L = (_fin(L) && L > 0) ? L : 0;
        for (i = 0; i < n; i++) { out[i] = NaN; lnx[i] = x[i] > 0 ? Math.log(x[i]) : NaN; }
        if (n < 3) return out;
        // full-window flags with two monotone pointers (x ascending)
        var lft = new Array(n), rgt = new Array(n), j = -1, k = 0;
        for (i = 0; i < n; i++) {
            while (j + 1 < i && lnx[i] - lnx[j + 1] >= L) j++;
            lft[i] = (j >= 0 && lnx[i] - lnx[j] >= L) ? j : -1;
            if (k <= i) k = i + 1;
            while (k < n && lnx[k] - lnx[i] < L) k++;
            rgt[i] = k < n ? k : -1;
        }
        // The host engine is used only on request (PRiSM_dfit_hostBourdet = true): its numbers are identical (same window and
        // weights), but before WPH's O(n) rewrite it walks the window with Math.log at every step, ≈ 5 × slower here.
        var ext = G.PRiSM_dfit_hostBourdet === true ? _fn('PRiSM_compute_bourdet') : null, d = null;
        if (ext) { try { d = ext(x, y, L); } catch (e) { d = null; } }
        for (i = 1; i < n - 1; i++) {
            var i1 = lft[i], i2 = rgt[i];
            var yi = y[i];
            if (i1 < 0 || i2 < 0 || typeof yi !== 'number' || yi !== yi || !(lnx[i] === lnx[i])) continue;
            if (d && d.length === n) { var di = d[i]; out[i] = (typeof di === 'number' && isFinite(di)) ? di : NaN; continue; }
            var dl1 = lnx[i] - lnx[i1], dl2 = lnx[i2] - lnx[i], dlT = lnx[i2] - lnx[i1], y1 = y[i1], y2 = y[i2];
            if (!(dl1 > 0 && dl2 > 0 && dlT > 0) || typeof y1 !== 'number' || typeof y2 !== 'number' || y1 !== y1 || y2 !== y2) continue;
            out[i] = (yi - y1) / dl1 * (dl2 / dlT) + (y2 - yi) / dl2 * (dl1 / dlT);
        }
        return out;
    }
    G.PRiSM_dfit_bourdet = function (x, y, L) { return _bourdet(x, y, L); };

    // robust noise of a series: σ = 1.4826·MAD(Δ²y)/√6 (second differences remove a smooth trend)
    G.PRiSM_dfit_noise2 = function (y) { return _noise2(y); };
    function _noise2(y, i0, i1) {
        var d = [];
        for (var i = Math.max(1, i0 || 0); i < Math.min(y.length - 1, (i1 == null ? y.length : i1 + 1)); i++) {
            var a0 = y[i - 1], a1 = y[i], a2 = y[i + 1];
            if (typeof a0 === 'number' && typeof a1 === 'number' && typeof a2 === 'number') { var dd = a2 - 2 * a1 + a0; if (dd === dd && dd !== INF && dd !== -INF) d.push(dd); }
        }
        if (d.length < 3) return 0;
        var m = _median(d), ad = d.map(function (v) { return Math.abs(v - m); });
        return 1.4826 * _median(ad) / Math.sqrt(6);
    }

    // ═════════════════════════════════════════════════════════════════════
    // §4.1 preparation (non-destructive; masked samples removed with an index map)
    // ═════════════════════════════════════════════════════════════════════
    G.PRiSM_dfit_prepare = _safe(function (ds, inputs, well) {
        if (!_isObj2(ds) || !Array.isArray(ds.t) || !Array.isArray(ds.p) || ds.t.length < 2 || ds.p.length !== ds.t.length) {
            return _fail('BAD_DATASET', 'The dataset needs t and p arrays of the same length (at least 2 samples).', ['t', 'p']);
        }
        var cl = G.PRiSM_dfit_inputRanges.clamp(inputs || {});
        if (cl && cl.ok === false) return cl;
        var I = cl.inputs, ch = I.channels, flags = [], n = ds.t.length, i;
        cl.warnings.forEach(function (w) { flags.push(w); });
        var hasQ = Array.isArray(ds.q) && ds.q.length === n;
        var psigC = (ds.meta && ds.meta.psigConverted) || {};
        var atmDelta = ch.atmPsia - 14.696;
        function chanAtm(name) {   // psia correction for a channel (§3.1 psig rule)
            if (_fin(psigC[name])) return atmDelta;
            if (ch.psig && ch.psig[name] === true) return ch.atmPsia;
            return 0;
        }
        function fix(arr, f) {
            if (!f) return arr;
            return arr.map(function (v) { return _fin(v) ? v * f.factor + f.offset : v; });
        }
        var t = fix(ds.t.slice(), ch.unitFix.t), p = fix(ds.p.slice(), ch.unitFix.p);
        var qd = hasQ ? fix(ds.q.slice(), ch.unitFix.q) : null;
        var ps = Array.isArray(ds.pSurf) && ds.pSurf.length === n ? fix(ds.pSurf.slice(), ch.unitFix.pSurf) : null;
        var TT = Array.isArray(ds.T) && ds.T.length === n ? ds.T.slice() : null;
        var qfb = Array.isArray(ds.qFb) && ds.qFb.length === n ? ds.qFb.slice() : null;
        var aP = chanAtm('p'), aS = chanAtm('pSurf');
        if (aP) for (i = 0; i < n; i++) if (_fin(p[i])) p[i] += aP;
        if (ps && aS) for (i = 0; i < n; i++) if (_fin(ps[i])) ps[i] += aS;
        if (aP || aS) flags.push(_W('ATM_APPLIED', 'info', 'Atmospheric correction applied: ' + _f1(aP || aS, 3) + ' psi (test value ' + _f1(ch.atmPsia, 3) + ' psia).'));
        // depth fix (an applied 'gauge-to-datum' blunder fix of 49-calc-dfit-triage): the bottomhole channel is referred from the
        // gauge depth to the datum by the static column difference dpPsi (datum minus gauge, psi); non-destructive like the unit fixes
        var dFix = (_isObj2(ch.depthFix) && _fin(ch.depthFix.dpPsi)) ? ch.depthFix.dpPsi : 0;
        if (dFix && ch.primary !== 'surface') {
            for (i = 0; i < n; i++) if (_fin(p[i])) p[i] += dFix;
            flags.push(_W('DEPTH_FIX', 'info', 'Gauge pressure referred to the datum: ' + (dFix > 0 ? '+' : '') + _f1(dFix, 2) + ' psi' +
                (_fin(ch.depthFix.fromTvd) && _fin(ch.depthFix.toTvd) ? ' (' + _f1(ch.depthFix.fromTvd, 0) + ' ft to ' + _f1(ch.depthFix.toTvd, 0) + ' ft TVD).' : '.')));
        } else dFix = 0;
        // clock offset (rate logger vs gauge): q'(t) = q(t − offset), sample-and-hold on the dataset clock
        var off = _fin(ch.clockOffsetH) ? ch.clockOffsetH : 0;
        if (qd && off !== 0) {
            var q2 = new Array(n), k = 0;
            for (i = 0; i < n; i++) {
                var tq = t[i] - off;
                while (k + 1 < n && t[k + 1] <= tq) k++;
                q2[i] = (tq < t[0]) ? 0 : qd[k];
            }
            qd = q2;
            flags.push(_W('CLOCK_OFFSET', 'info', 'Rate clock shifted by ' + _f1(off * 3600, 1) + ' s against the gauge clock.'));
        }
        // keep: finite t and p, t strictly ascending, outside every mask window
        var mask = ch.mask || [], keep = [], last = -INF, nMasked = 0, nDup = 0, nBad = 0;
        for (i = 0; i < n; i++) {
            if (!_fin(t[i]) || !_fin(p[i])) { nBad++; continue; }
            var inMask = false;
            for (var m = 0; m < mask.length; m++) if (t[i] >= mask[m][0] && t[i] <= mask[m][1]) { inMask = true; break; }
            if (inMask) { nMasked++; continue; }
            if (!(t[i] > last)) { nDup++; continue; }
            keep.push(i); last = t[i];
        }
        if (keep.length < 2) return _fail('NO_DATA', 'Fewer than two usable samples remain after the masks and checks.', ['t', 'p']);
        if (nBad) flags.push(_W('NONFINITE', 'warn', nBad + ' samples with a missing time or pressure were skipped.'));
        if (nDup) flags.push(_W('TIME_ORDER', 'bad', nDup + ' samples with a repeated or reversed time were skipped.'));
        if (nMasked) flags.push(_W('MASKED', 'info', nMasked + ' samples inside the masked windows were removed before any derivative.'));
        var out = { ok: true, t: [], pw: [], band: null, pSurf: ps ? [] : null, q: qd ? [] : null, T: TT ? [] : null, idx: keep.slice(),
                    src: 'bh', sigma: 0, quantum: 0,
                    applied: { atmDelta: aP, unitFix: (ch.unitFix.p || ch.unitFix.q || ch.unitFix.t || ch.unitFix.pSurf) ? ch.unitFix : null, clockOffsetH: off, masked: nMasked, depthFixPsi: dFix },
                    flags: flags, hf: null };
        var qfbOut = qfb ? [] : null;
        for (var kk = 0; kk < keep.length; kk++) {
            i = keep[kk];
            out.t.push(t[i]); out.pw.push(p[i]);
            if (out.pSurf) out.pSurf.push(_nn(ps[i]));
            if (out.q) out.q.push(_fin(qd[i]) && qd[i] > 0 ? qd[i] / 1440 : 0);     // bbl/d → bbl/min
            if (out.T) out.T.push(_nn(TT[i]));
            if (qfbOut) qfbOut.push(_fin(qfb[i]) && qfb[i] > 0 ? qfb[i] / 1440 : 0);
        }
        if (qfbOut) out.qFb = qfbOut;
        // primary channel: a surface gauge is converted to bottomhole (WTS_wellbore.convert at call time, else constant gradient)
        var depthGauge = _fin(I.gauge.bhTvd) ? I.gauge.bhTvd : null;
        if (ch.primary === 'surface') {
            var conv = _wb('convert'), cv = null;
            // integration: WTS_wellbore.convert(ds, prepCtx, opts) reads the surface channel from ds.pSurf (or ds.p with
            // opts.channel 'p') and needs prepCtx.column (survey, strings, fluid, temperature, datum), the fluid, the temperature
            // model and the test atmospheric pressure; the primary surface channel here is the dataset's p (psia)
            var sCol = _fin(I.datumTvd) && I.datumTvd > 0 ? { survey: I.survey, strings: I.strings, fluid: I.fluid, temp: I.temp, datumTvd: I.datumTvd, datumMd: I.datumMd } : null;
            if (conv && sCol) {
                try {
                    cv = conv({ t: out.t, p: out.pw, q: out.q ? out.q.map(function (x) { return x * 1440; }) : null, qFb: out.qFb ? out.qFb.map(function (x) { return x * 1440; }) : null },
                              { column: sCol, fluid: I.fluid, temp: I.temp, atmPsia: ch.atmPsia, gaugeTvd: 0, well: well || null }, { band: true, channel: 'p' });
                } catch (e) { cv = null; }
            }
            if (_okRes(cv) && Array.isArray(cv.pw) && cv.pw.length === out.t.length) {
                out.pSurf = out.pw.slice(); out.pw = cv.pw.slice();
                if (cv.band && Array.isArray(cv.band.p10) && cv.band.p10.length === out.t.length) out.band = { p10: cv.band.p10.map(_nn), p90: cv.band.p90.map(_nn) };
                (cv.flags || []).forEach(function (f) { if (_isObj2(f) && f.code) flags.push(_W(f.code, f.level, f.text, f.ev)); });
                if (_fin(cv.vacuumAt)) flags.push(_W('VACUUM', 'bad', 'The surface gauge reads a vacuum from ' + _f1(cv.vacuumAt, 3) + ' h; converted data after that time need a bottomhole gauge.'));
            } else if (_fin(I.datumTvd)) {
                var grad = 0.052 * I.fluid.rhoPpg, dpH = grad * I.datumTvd;
                out.pSurf = out.pw.slice();
                out.pw = out.pw.map(function (v) { return v + dpH; });
                flags.push(_W('CONVERSION_FALLBACK', 'warn', 'Surface pressure converted with a constant ' + _f1(grad, 3) + ' psi/ft gradient and no friction (wellbore engine unavailable); pumping pressures read high.'));
            } else {
                flags.push(_W('NO_DATUM', 'bad', 'The datum depth is not set: the surface pressure cannot be converted to bottomhole and is used as recorded.'));
            }
            out.src = 'surface-converted';
        } else if (!dFix && depthGauge !== null && _fin(I.datumTvd) && Math.abs(I.datumTvd - depthGauge) > 0.5) {     // an applied depth fix supersedes it
            var dz = 0.052 * I.fluid.rhoPpg * (I.datumTvd - depthGauge);
            out.pw = out.pw.map(function (v) { return v + dz; });
            flags.push(_W('GAUGE_TO_DATUM', 'info', 'Gauge pressure moved to the datum: ' + (dz >= 0 ? '+' : '') + _f1(dz, 1) + ' psi over ' + _f1(I.datumTvd - depthGauge, 0) + ' ft.'));
        }
        // noise σ (second differences) and quantum (most common non-zero |Δp|)
        out.sigma = _noise2(out.pw);
        var cnt = {}, best = 0, bestN = 0;
        for (i = 1; i < out.pw.length; i++) {
            var dq = Math.abs(out.pw[i] - out.pw[i - 1]);
            if (dq > 0) { var key = dq.toPrecision(4); cnt[key] = (cnt[key] || 0) + 1; if (cnt[key] > bestN) { bestN = cnt[key]; best = +key; } }
        }
        out.quantum = bestN >= 3 ? best : 0;
        // Hampel spikes (window 7, 4 MAD): flagged, never deleted
        var spikes = 0, nn = out.pw.length;
        if (nn >= 7) {
            for (i = 3; i < nn - 3; i++) {
                var win = out.pw.slice(i - 3, i + 4), md = _median(win), mad = 1.4826 * _median(win.map(function (v) { return Math.abs(v - md); }));
                if (mad > 0 && Math.abs(out.pw[i] - md) > 4 * mad && Math.abs(out.pw[i] - md) > 3 * Math.max(out.sigma, 0.01) &&
                    Math.abs(out.pw[i] - out.pw[i - 1]) > 3 * mad && Math.abs(out.pw[i + 1] - out.pw[i]) > 3 * mad &&
                    (out.pw[i] - out.pw[i - 1]) * (out.pw[i + 1] - out.pw[i]) < 0) spikes++;
            }
        }
        if (spikes) flags.push(_W('SPIKES', 'warn', spikes + ' isolated pressure spikes flagged (Hampel test); they are kept.'));
        // high-rate windows (≥ 2 Hz around shut-in): indexed for 59 to store (§3.1)
        var iq = -1;
        if (out.q) for (i = out.q.length - 1; i >= 0; i--) if (out.q[i] > 0) { iq = i; break; }
        // Each window carries its samples (t h, p psia on the analysed channel) so the wave ISIP (WTS_wellbore.hammerQuick) and
        // 59's store can use them: from the main record when it is ≥ 2 Hz there, else from ds.meta.hfWindows (a logger's
        // high-rate shut-in window beside a 1 Hz main record), converted like the main bottomhole channel
        var wins = [];
        if (iq >= 0) {
            var tsx = out.t[iq], a0 = tsx - 10 / 3600, a1 = tsx + 120 / 3600, wt = [], wp = [];
            for (i = 0; i < out.t.length; i++) if (out.t[i] >= a0 && out.t[i] <= a1) { wt.push(out.t[i]); wp.push(out.pw[i]); }
            if (wt.length >= 2 && (a1 - a0) * 3600 / wt.length <= 0.5)
                wins.push({ kind: 'shutin', t0: a0, t1: a1, n: wt.length, t: wt, p: wp, dtS: (wt[wt.length - 1] - wt[0]) * 3600 / (wt.length - 1), src: 'record' });
        }
        var mw = ds.meta && Array.isArray(ds.meta.hfWindows) ? ds.meta.hfWindows : [];
        if (ch.primary !== 'surface') mw.slice(0, 4).forEach(function (w) {
            if (!_isObj2(w) || !_fin(w.t0) || !_fin(w.dtS) || !(w.dtS > 0) || !Array.isArray(w.p) || w.p.length < 2) return;
            var kind = /^(shutin|step|flowback|ramp)$/.test(w.kind) ? w.kind : 'shutin';
            if (wins.some(function (x) { return x.kind === kind; })) return;            // the main record's own window wins
            var nW = Math.min(w.p.length, 20000), wt2 = new Array(nW), wp2 = new Array(nW), fp = ch.unitFix.p;
            for (var j = 0; j < nW; j++) {
                wt2[j] = w.t0 + j * w.dtS / 3600;
                var v = w.p[j];
                wp2[j] = _fin(v) ? (fp ? v * fp.factor + fp.offset : v) + aP + dFix : null;
            }
            wins.push({ kind: kind, t0: wt2[0], t1: wt2[nW - 1], n: nW, t: wt2, p: wp2, dtS: w.dtS, src: 'meta' });
        });
        if (wins.length) out.hf = { windows: wins };
        out.atmPsia = ch.atmPsia;
        return out;
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.1 resampler: O(n), one pass; pumping ≤ keepPump (bin extremes), falloff log-spaced (perDecade) or a pressure step
    // ═════════════════════════════════════════════════════════════════════
    function _qselect(a, k, cnt) {        // in place, deterministic middle pivot; returns a[k]
        var lo = 0, hi = a.length - 1;
        while (lo < hi) {
            var piv = a[(lo + hi) >> 1], i = lo, j = hi;
            while (i <= j) {
                while (a[i] < piv) { i++; cnt.n++; }
                while (a[j] > piv) { j--; cnt.n++; }
                if (i <= j) { var tmp = a[i]; a[i] = a[j]; a[j] = tmp; i++; j--; }
                cnt.n++;
            }
            if (k <= j) hi = j; else if (k >= i) lo = i; else break;
        }
        return a[k];
    }
    G.PRiSM_dfit_resample = _safe(function (t, p, ts, opts) {
        opts = opts || {};
        if (!t || !p || t.length !== p.length || t.length < 2) return _fail('BAD_INPUT', 'resample needs t and p arrays of equal length.', ['t', 'p']);
        var n = t.length, per = _fin(opts.perDecade) && opts.perDecade > 0 ? opts.perDecade : 40, keepPump = _fin(opts.keepPump) && opts.keepPump >= 2 ? Math.floor(opts.keepPump) : 2000;
        var cnt = { n: 0 }, idx = [], i;
        var dpMin = opts.dpMin;
        if (!_fin(dpMin)) {
            var sig = _noise2(p), q = _fin(opts.quantum) ? opts.quantum : 0;
            cnt.n += n;
            dpMin = Math.max(0.05, 3 * sig, 10 * q);
        }
        // split at ts (first index with t > ts)
        var iS = 0;
        while (iS < n && t[iS] <= ts) { iS++; cnt.n++; }
        if (iS <= keepPump) { for (i = 0; i < iS; i++) idx.push(i); cnt.n += iS; }
        else {
            var nb = Math.max(1, Math.floor(keepPump / 2)), bs = iS / nb;
            for (var b = 0; b < nb; b++) {
                var i0 = Math.floor(b * bs), i1 = Math.min(iS, Math.floor((b + 1) * bs)), imn = i0, imx = i0;
                for (i = i0; i < i1; i++) { if (p[i] < p[imn]) imn = i; if (p[i] > p[imx]) imx = i; cnt.n++; }
                if (imn === imx) idx.push(imn); else if (imn < imx) { idx.push(imn); idx.push(imx); } else { idx.push(imx); idx.push(imn); }
            }
        }
        // falloff bins: a bin closes when ln Δt advanced by ln10/per or p moved by dpMin from the bin start
        var step = LN10 / per, binStart = iS, out = [];
        function flush(i0, i1) {          // [i0, i1)
            if (i1 <= i0) return;
            if (i1 - i0 === 1) { idx.push(i0); return; }
            var vals = []; for (var j = i0; j < i1; j++) { vals.push(p[j]); cnt.n++; }
            var k = (vals.length - 1) >> 1, med = _qselect(vals, k, cnt), pick = i0, bestD = INF;
            for (j = i0; j < i1; j++) { var dd = Math.abs(p[j] - med); cnt.n++; if (dd < bestD) { bestD = dd; pick = j; } }
            idx.push(pick);
        }
        for (i = iS; i < n; i++) {
            cnt.n++;
            if (i === binStart) continue;
            var lt0 = Math.log(Math.max(t[binStart] - ts, 1e-12)), lt = Math.log(Math.max(t[i] - ts, 1e-12));
            if (lt - lt0 >= step || Math.abs(p[i] - p[binStart]) >= dpMin) { flush(binStart, i); binStart = i; }
        }
        if (binStart < n) flush(binStart, n);
        return { ok: true, idx: idx, t: idx.map(function (j) { return t[j]; }), p: idx.map(function (j) { return p[j]; }), dpMin: dpMin, ops: cnt.n };
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.3 events, volumes and the pumping time
    // ═════════════════════════════════════════════════════════════════════
    function _vwcwTheory(inputs, well) {   // bbl/psi from WTS_wellbore.csys (call time); null when unavailable
        var col = _wb('column'), cs = _wb('csys');
        if (!col || !cs || !inputs) return null;
        try {
            var c = col({ survey: inputs.survey, strings: inputs.strings, fluid: inputs.fluid, temp: inputs.temp, datumTvd: inputs.datumTvd, datumMd: inputs.datumMd });
            if (!_okRes(c)) return null;
            var r = cs(c, inputs.fluid, null);
            return (_okRes(r) && _fin(r.VwCw) && r.VwCw > 0) ? r.VwCw : null;
        } catch (e) { return null; }
    }
    G.PRiSM_dfit_events = _safe(function (prep, overrides, opts) {
        opts = opts || {};
        if (!_okRes(prep) || !Array.isArray(prep.t) || prep.t.length < 3) return _fail('BAD_INPUT', 'Prepared data are needed for the events.', ['prep']);
        overrides = overrides || {};
        var t = prep.t, p = prep.pw, q = prep.q, n = t.length, i, warnings = [];
        var fStart = _fin(opts.qStartFrac) ? opts.qStartFrac : 0.02, fStop = _fin(opts.qStopFrac) ? opts.qStopFrac : 0.05;
        var sig = Math.max(prep.sigma || 0, 0.01);
        var hasQ = Array.isArray(q) && q.some(function (v) { return v > 0; });
        var qMax = 0; if (hasQ) for (i = 0; i < n; i++) if (q[i] > qMax) qMax = q[i];
        // cycles: runs of q > fStart·qMax (rate sample i holds over (t[i−1], t[i]])
        var cycles = [], src = { tStart: 'auto', tb: 'auto', ts: 'auto' };
        if (hasQ) {
            var on = false, c0 = -1;
            for (i = 0; i < n; i++) {
                var pump = q[i] > fStart * qMax;
                if (pump && !on) { on = true; c0 = i; }
                if (!pump && on) { on = false; cycles.push({ i0: c0, i1: i - 1 }); }
            }
            if (on) cycles.push({ i0: c0, i1: n - 1 });
        } else {
            // pressure only: the injection is the rise from the first static level; shut-in at the largest negative step
            var iDrop = -1, big = 0;
            for (i = 1; i < n; i++) { var dd = p[i] - p[i - 1]; if (dd < big) { big = dd; iDrop = i; } }
            if (iDrop < 1) return _fail('NO_SHUTIN', 'No shut-in could be found (no rate and no pressure drop).', ['q']);
            var p0 = p[0], ir = 0;
            for (i = 1; i < iDrop; i++) if (p[i] - p0 > Math.max(5 * sig, 1)) { ir = i; break; }
            cycles.push({ i0: Math.max(ir, 1), i1: iDrop - 1 });
            warnings.push(_W('NO_RATE', 'warn', 'No rate channel: events are read from the pressure; volumes need the rate.'));
        }
        if (!cycles.length) return _fail('NO_INJECTION', 'No injection period was found in the rate.', ['q']);
        function cycVol(c) {
            if (!hasQ) return null;
            var v = 0;
            for (var j = c.i0; j <= c.i1; j++) v += q[j] * (t[j] - (j === c.i0 ? c.tStart : t[j - 1])) * 60;
            return v;
        }
        // pump start refined by the pressure ramp onset (back-extrapolated to the pre-pump level within (t[i0−1], t[i0]])
        // The onset is read from the first sample that has risen above the pre-pump level (a pressure still at that level
        // at t[i0] means the pumping began at t[i0], the end of the bracket, not at its start): the line through that sample
        // and the next one, back to the pre-pump level, clamped to the rate bracket.
        cycles.forEach(function (c) {
            var i0 = c.i0, tA = i0 > 0 ? t[i0 - 1] : t[i0], tS = tA;
            if (i0 > 0 && i0 + 1 < n) {
                var pPre = p[i0 - 1], thr = Math.max(5 * sig, 1), kR = i0;
                while (kR < Math.min(n - 2, i0 + 3) && !(p[kR] - pPre > thr)) kR++;
                var s = (p[kR + 1] - p[kR]) / (t[kR + 1] - t[kR]);
                if (s > 0 && p[kR] - pPre > thr) { var tx = t[kR] - (p[kR] - pPre) / s; tS = _clampN(tx, tA, t[i0]); }
                else if (s > 0 && p[i0] > pPre) { tx = t[i0] - (p[i0] - pPre) / s; tS = _clampN(tx, tA, t[i0]); }
            }
            c.tStart = tS;
            c.ts = t[c.i1];
            c.pStart = i0 > 0 ? p[i0 - 1] : p[i0];
            c.Vi = cycVol(c);
        });
        var cyc = cycles[cycles.length - 1];
        // the analysed cycle: the last one (re-opening is analysed alone when the fracture closed in between)
        var tStart = cyc.tStart, iS = cyc.i1, ts = t[iS];
        if (_fin(overrides.tStart)) { tStart = overrides.tStart; src.tStart = 'user'; }
        if (_fin(overrides.ts)) {
            ts = overrides.ts; src.ts = 'user';
            iS = 0; for (i = 0; i < n; i++) if (t[i] <= ts) iS = i;
        }
        // the last pumping sample from the pressure (§4.3: the largest negative pressure difference between the last pumping and
        // the first falloff sample): a logger that writes the rate as the value from its time stamp on (forward-held) reports
        // q = 0 at the shut-in sample while the pressure there is still the pumping pressure. When the largest drop within the
        // next three samples comes after a sample that has not fallen, that sample is the last pumping one; the rate arrays
        // keep iQ (the last sample with q > 0) and the volume carries the last rate up to it.
        var iQ = iS;
        if (src.ts === 'auto' && hasQ) {
            var kD = iS, dBest = -INF, thrD = Math.max(5 * sig, 1);
            for (i = iS; i <= Math.min(n - 2, iS + 3); i++) { var ddp = p[i] - p[i + 1]; if (ddp > dBest) { dBest = ddp; kD = i; } }
            var flat = true; for (i = iS + 1; i <= kD; i++) if (p[i] < p[i - 1] - thrD) flat = false;
            if (kD > iS && flat && dBest > thrD) { iS = kD; ts = t[kD]; }
        }
        // shut-in refined to sub-sample resolution by the water-hammer onset when a high-rate window gives one
        var tsRefined = false;
        if (src.ts === 'auto' && _fin(opts.hammerOnset) && iS + 1 < n && opts.hammerOnset >= t[iS] && opts.hammerOnset < t[iS + 1]) { ts = opts.hammerOnset; tsRefined = true; }
        // breakdown: pressure maximum during pumping followed by a drop (> max(5σ, 0.5 % of the rise)) while pumping
        var iB = -1, pmx = -INF, i0c = cyc.i0;
        for (i = i0c; i <= iS; i++) if (p[i] > pmx) { pmx = p[i]; iB = i; }
        var tb = null, pb = null;
        if (iB >= 0 && iB < iS) {
            var pMinAfter = INF; for (i = iB; i <= iS; i++) if (p[i] < pMinAfter) pMinAfter = p[i];
            if (pmx - pMinAfter > Math.max(5 * sig, 0.005 * (pmx - cyc.pStart))) { tb = t[iB]; pb = pmx; }
        }
        if (_fin(overrides.tb)) { tb = overrides.tb; src.tb = 'user'; var kb = 0; for (i = 0; i < n; i++) if (t[i] <= tb) kb = i; pb = p[kb]; }
        // rates
        var qLast = null, steps = [];
        if (hasQ) {
            // last stable rate: median of the pumping samples in the last 20 % of the cycle that lie within 5 % of the final run
            var runs = [], r0 = i0c;
            for (i = i0c + 1; i <= iQ + 1; i++) {
                if (i > iQ || Math.abs(q[i] - q[r0]) > 0.01 * Math.max(q[r0], 1e-9)) { runs.push({ a: r0, b: i - 1, q: _median(q.slice(r0, i)) }); r0 = i; }
            }
            var lastRun = runs[runs.length - 1];
            qLast = lastRun.q;
            // steps: plateaus of ≥ 5 s at distinct levels (> 5 %)
            var plats = runs.filter(function (r) { return (t[r.b] - (r.a > 0 ? t[r.a - 1] : t[r.a])) * 3600 >= 5; });
            if (plats.length >= 2) {
                var down = true, up = true;
                for (i = 1; i < plats.length; i++) {
                    if (!(plats[i].q < plats[i - 1].q * 0.95)) down = false;
                    if (!(plats[i].q > plats[i - 1].q * 1.05)) up = false;
                }
                if (down || up) {
                    plats.forEach(function (r) {
                        steps.push({ t0: r.a > 0 ? t[r.a - 1] : t[r.a], t1: t[r.b], q: r.q, pSettled: p[r.b], n: r.b - r.a + 1, dir: down ? 'down' : 'up' });
                    });
                }
            }
        }
        // ramp-down: time with q below 95 % of q_last before shut-in, as a fraction of tp
        var tp = ts - tStart, rampDown = 0;
        if (hasQ && qLast > 0) {
            var iR = iQ; while (iR > i0c && q[iR] < 0.95 * qLast) iR--;
            rampDown = tp > 0 ? _clampN((ts - t[iR]) / tp, 0, 1) : 0;
            if (rampDown > 0.1) warnings.push(_W('RAMP_DOWN', 'warn', 'The rate ramps down over ' + _f1(rampDown * 100, 0) + ' % of the pumping time: the instantaneous shut-in is not defined, the data-driven G is used.'));
        }
        // volumes (bbl)
        var Vi = 0;
        if (hasQ) {
            for (i = i0c; i <= iQ; i++) Vi += q[i] * (t[i] - (i === i0c ? tStart : t[i - 1])) * 60;
            if (iS > iQ) Vi += q[iQ] * (t[iS] - t[iQ]) * 60;
            if (cycles.length > 1) {
                var prev = cycles[cycles.length - 2];
                var pBetween = INF; for (i = prev.i1; i < cyc.i0; i++) if (p[i] < pBetween) pBetween = p[i];
                var sp = _fin(opts.sigmaPrior) ? opts.sigmaPrior : null;
                cyc.closedBefore = sp !== null ? pBetween < sp : false;
                if (!cyc.closedBefore) { cycles.slice(0, -1).forEach(function (c) { Vi += c.Vi || 0; }); warnings.push(_W('MULTI_CYCLE', 'info', cycles.length + ' injection cycles; closure between them was not established, so the volumes are combined.')); }
            }
        }
        // V_fill: delay between the rate start and the pressure rise
        var Vfill = 0;
        if (hasQ) {
            var pS = cyc.pStart, iRise = -1;
            for (i = cyc.i0; i <= iS; i++) if (p[i] - pS > Math.max(5 * sig, 1)) { iRise = i; break; }
            if (iRise > cyc.i0 + 1) { for (i = cyc.i0; i < iRise - 1; i++) Vfill += q[i] * (t[i] - (i === cyc.i0 ? tStart : t[i - 1])) * 60; }
        }
        // flowback
        var flowback = null, Vfb = 0;
        if (Array.isArray(prep.qFb)) {
            var f0 = -1, f1 = -1, qs = [];
            for (i = iS + 1; i < n; i++) if (prep.qFb[i] > 0) { if (f0 < 0) f0 = i; f1 = i; qs.push(prep.qFb[i]); Vfb += prep.qFb[i] * (t[i] - t[i - 1]) * 60; }
            if (f0 >= 0) flowback = { t0: t[f0 - 1 >= 0 ? f0 - 1 : f0], t1: t[f1], q: _median(qs), V: Vfb };
        }
        if (overrides.flowback && _fin(overrides.flowback.t0) && _fin(overrides.flowback.t1)) flowback = { t0: overrides.flowback.t0, t1: overrides.flowback.t1, q: flowback ? flowback.q : null, V: flowback ? flowback.V : null };
        // wellbore stiffness from the pre-breakdown ramp: V_w·c_w = q/(dp/dt) (bbl/psi); fit over the steep part
        var VwCwM = null;
        if (hasQ) {
            var iEnd = (tb !== null && iB > cyc.i0) ? iB : iS, best2 = 0;
            for (i = cyc.i0 + 1; i <= iEnd; i++) { var s2 = (p[i] - p[i - 1]) / ((t[i] - t[i - 1]) * 60); if (s2 > best2) best2 = s2; }
            var sx = 0, sy = 0, sxx = 0, sxy = 0, nr = 0, qr = [];
            for (i = cyc.i0 + 1; i <= iEnd; i++) {
                var s3 = (p[i] - p[i - 1]) / ((t[i] - t[i - 1]) * 60);
                if (s3 >= 0.8 * best2 && best2 > 0) { var x = t[i] * 60; sx += x; sy += p[i]; sxx += x * x; sxy += x * p[i]; nr++; qr.push(q[i]); }
            }
            if (nr >= 2) {
                var den = nr * sxx - sx * sx, slope = den !== 0 ? (nr * sxy - sx * sy) / den : null;
                if (!(nr >= 3) || !_fin(slope)) slope = best2;
                if (slope > 0) VwCwM = _median(qr) / slope;
            } else if (best2 > 0) VwCwM = q[cyc.i0] / best2;
        }
        var VwCw = _fin(opts.VwCw) ? opts.VwCw : (VwCwM !== null ? VwCwM : _vwcwTheory(opts.inputs, opts.well));
        var pShut = p[iS], pStart = cyc.pStart;
        var ViFrac = hasQ ? Vi - (VwCw || 0) * (pShut - pStart) - Vfill : null;
        // V_i* depends on the closure candidate (§4.3): opts.sigmaC, else the prior, else the first falloff pressure (an
        // ISIP proxy, so V_i* starts as V_i,frac); 56's frac recomputes it per candidate.
        var sigC = _fin(opts.sigmaC) ? opts.sigmaC : (_fin(opts.sigmaPrior) ? opts.sigmaPrior : (iS + 1 < n ? p[iS + 1] : pShut));
        var ViStar = hasQ ? Vi - (VwCw || 0) * (sigC - pStart) - Vfill : null;
        // tp_veq = V_i / q: q_last, unless the injection ends below the main stage (a step-down, or any last rate under 90 % of
        // q_max): then the volume-weighted rate of this cycle Σq²Δt / ΣqΔt (the reference demo's 1.25 bbl/min last step made
        // V_i/q_last 21.5 min against a 5.6 min pump time)
        var qVeq = qLast;
        if (hasQ && qLast > 0 && _fin(qMax) && qLast < 0.9 * qMax) {
            var sq = 0, sq2 = 0;
            for (i = i0c; i <= iQ; i++) { var dtq = (t[i] - (i === i0c ? tStart : t[i - 1])) * 60, qq = q[i] > 0 ? q[i] : 0; sq += qq * dtq; sq2 += qq * qq * dtq; }
            if (sq > 0 && sq2 > 0) qVeq = sq2 / sq;
        }
        var tpPump = ts - tStart, tpB = tb !== null ? ts - tb : null, tpV = (hasQ && qVeq > 0) ? Vi / qVeq / 60 : null;
        var qEq = (hasQ && tpV > 0) ? (Vi - Vfill - Vfb) / (tpV * 60) : null;
        var schedule = hasQ && tpV > 0 ? [{ t: ts - tpV, q: qEq }, { t: ts, q: 0 }] : [];
        var cycOut = cycles.map(function (c, k) {
            var rw = null;
            if (k > 0) {         // re-pressurisation window of a later cycle: start → breakdown or end of the ramp
                var jm = c.i0, pm = -INF; for (var j = c.i0; j <= c.i1; j++) if (p[j] > pm) { pm = p[j]; jm = j; }
                if (t[jm] > c.tStart) rw = [c.tStart, t[jm]];
            }
            return { tStart: c.tStart, ts: c.ts, Vi: _nn(c.Vi), closedBefore: !!c.closedBefore, rampWin: rw };
        });
        if (tb === null) warnings.push(_W('NO_BREAKDOWN', 'info', 'No breakdown (pressure maximum followed by a drop while pumping) was found.'));
        return {
            ok: true, tStart: tStart, tb: tb, pb: pb, ts: ts, tsRefined: tsRefined, tEnd: t[n - 1], qMax: hasQ ? qMax : null, qLast: qLast,
            Vi: hasQ ? Vi : null, ViFrac: _nn(ViFrac), ViStar: _nn(ViStar), Vfill: hasQ ? Vfill : null, Vfb: Array.isArray(prep.qFb) ? Vfb : 0, qEq: _nn(qEq),
            VwCwMeasured: _nn(VwCwM), tp: { pump: tpPump > 0 ? tpPump : null, breakdown: tpB > 0 ? tpB : null, veq: tpV > 0 ? tpV : null }, rampDownFrac: rampDown,
            steps: steps, flowback: flowback, cycles: cycOut, schedule: schedule, source: src, warnings: warnings, ev: ['E1'],
            pStart: pStart, pShut: pShut, iShut: iS, VwCwUsed: _nn(VwCw), sigmaCForViStar: sigC
        };
    });

    // rate history of the analysed cycle as steps [{t, q}] (bbl/min; sample i holds over (t[i−1], t[i]])
    function _rateSteps(prep, events) {
        if (!prep || !Array.isArray(prep.q) || !events) return null;
        var t = prep.t, q = prep.q, out = [], i0 = -1, i;
        for (i = 0; i < t.length; i++) if (t[i] > events.tStart && t[i] <= events.ts + 1e-12) { if (i0 < 0) i0 = i; }
        if (i0 < 0) return null;
        out.push({ t: events.tStart, q: q[i0] });
        for (i = i0 + 1; i < t.length && t[i] <= events.ts + 1e-12; i++) if (q[i] !== q[i - 1]) out.push({ t: t[i - 1], q: q[i] });
        return out;
    }

    // ═════════════════════════════════════════════════════════════════════
    // §4.6 derivatives on the falloff
    // ═════════════════════════════════════════════════════════════════════
    // early-G straight line p = a − m·G grown over [G_min, …] while a quadratic term stays insignificant
    function _linfit(x, y, i0, i1, origin) {
        var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, i;
        for (i = i0; i <= i1; i++) { if (!_fin(x[i]) || !_fin(y[i])) continue; n++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
        if (origin) {
            if (n < 1 || sxx <= 0) return null;
            var b0 = sxy / sxx, ss0 = 0;
            for (i = i0; i <= i1; i++) if (_fin(x[i]) && _fin(y[i])) { var r0 = y[i] - b0 * x[i]; ss0 += r0 * r0; }
            return { a: 0, b: b0, n: n, s: n > 1 ? Math.sqrt(ss0 / (n - 1)) : 0, seA: 0, seB: n > 1 ? Math.sqrt(ss0 / (n - 1) / sxx) : 0 };
        }
        if (n < 2) return null;
        var den = n * sxx - sx * sx; if (!(den > 0)) return null;
        var b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n, ss = 0;
        for (i = i0; i <= i1; i++) if (_fin(x[i]) && _fin(y[i])) { var r = y[i] - a - b * x[i]; ss += r * r; }
        var s2 = n > 2 ? ss / (n - 2) : 0, xm = sx / n;
        return { a: a, b: b, n: n, s: Math.sqrt(s2), seA: Math.sqrt(s2 * (1 / n + xm * xm / (sxx - n * xm * xm || 1e-300))), seB: Math.sqrt(s2 / ((sxx - n * xm * xm) || 1e-300)) };
    }
    function _quadDev(x, y, i0, i1, lf) {   // max |quadratic − linear| fit over the window
        var n = 0, xm = 0, i;
        for (i = i0; i <= i1; i++) { n++; xm += x[i]; }
        xm /= n;
        var S = [0, 0, 0, 0, 0], T = [0, 0, 0];
        for (i = i0; i <= i1; i++) { var u = x[i] - xm, u2 = u * u; S[0]++; S[1] += u; S[2] += u2; S[3] += u2 * u; S[4] += u2 * u2; T[0] += y[i]; T[1] += u * y[i]; T[2] += u2 * y[i]; }
        // solve 3×3 normal equations
        var M = [[S[0], S[1], S[2], T[0]], [S[1], S[2], S[3], T[1]], [S[2], S[3], S[4], T[2]]];
        for (var c = 0; c < 3; c++) {
            var piv = c; for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
            if (Math.abs(M[c][c]) < 1e-300) return 0;
            for (r = c + 1; r < 3; r++) { var f = M[r][c] / M[c][c]; for (var k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
        }
        var c2 = M[2][3] / M[2][2], c1 = (M[1][3] - M[1][2] * c2) / M[1][1], c0 = (M[0][3] - M[0][1] * c1 - M[0][2] * c2) / M[0][0];
        var dev = 0;
        for (i = i0; i <= i1; i++) { var uu = x[i] - xm, q = c0 + c1 * uu + c2 * uu * uu, l = lf.a + lf.b * x[i]; dev = Math.max(dev, Math.abs(q - l)); }
        return dev;
    }
    // prefix sums of 1, x, x², x³, x⁴, y, xy, x²y, y² (x centred) → every window's line and quadratic in O(1)
    function _prefix(x, y) {
        var n = x.length, xm = 0, i;
        for (i = 0; i < n; i++) xm += x[i];
        xm = n ? xm / n : 0;
        var P = { xm: xm, s: [] }, a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        P.s.push(a.slice());
        for (i = 0; i < n; i++) {
            var u = x[i] - xm, u2 = u * u, yy = y[i];
            a[0] += 1; a[1] += u; a[2] += u2; a[3] += u2 * u; a[4] += u2 * u2; a[5] += yy; a[6] += u * yy; a[7] += u2 * yy; a[8] += yy * yy;
            P.s.push(a.slice());
        }
        return P;
    }
    function _winFits(P, x, i0, i1) {          // {lin:{a,b,s,seA,n}, dev} on the window [i0, i1] (a, b in raw x)
        var A = P.s[i1 + 1], B = P.s[i0], S = [];
        for (var k = 0; k < 9; k++) S.push(A[k] - B[k]);
        var n = S[0];
        if (n < 3) return null;
        var den = n * S[2] - S[1] * S[1];
        if (!(den > 0)) return null;
        var b = (n * S[6] - S[1] * S[5]) / den, ac = (S[5] - b * S[1]) / n;           // y = ac + b·u
        var ssr = S[8] - ac * S[5] - b * S[6];
        if (ssr < 0) ssr = 0;
        var s2 = n > 2 ? ssr / (n - 2) : 0, um = S[1] / n, sxx = S[2] - n * um * um;
        var lin = { a: ac - b * P.xm, b: b, n: n, s: Math.sqrt(s2), seA: Math.sqrt(s2 * (1 / n + Math.pow(um + P.xm, 2) / (sxx || 1e-300))) };
        // quadratic y = c0 + c1·u + c2·u²
        var M = [[S[0], S[1], S[2], S[5]], [S[1], S[2], S[3], S[6]], [S[2], S[3], S[4], S[7]]];
        for (var c = 0; c < 3; c++) {
            var piv = c; for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
            if (Math.abs(M[c][c]) < 1e-300) return { lin: lin, dev: 0 };
            for (r = c + 1; r < 3; r++) { var f = M[r][c] / M[c][c]; for (var kk = c; kk < 4; kk++) M[r][kk] -= f * M[c][kk]; }
        }
        var c2 = M[2][3] / M[2][2], c1 = (M[1][3] - M[1][2] * c2) / M[1][1], c0 = (M[0][3] - M[0][1] * c1 - M[0][2] * c2) / M[0][0];
        // max |quad − lin| over [u(i0), u(i1)]: the difference is a quadratic → the ends and the vertex
        var dq = function (u) { return Math.abs((c0 + c1 * u + c2 * u * u) - (ac + b * u)); };
        var u0 = x[i0] - P.xm, u1 = x[i1] - P.xm, dev = Math.max(dq(u0), dq(u1));
        if (c2 !== 0) { var uv = -(c1 - b) / (2 * c2); if (uv > u0 && uv < u1) dev = Math.max(dev, dq(uv)); }
        return { lin: lin, dev: dev };
    }
    // per-sample noise of y[i0..i1] and its lag-1 correlation for AR(1)-like gauge noise, from the robust variances of the
    // lag-1 and lag-2 differences, each de-trended by a 21-sample quadratic (Savitzky–Golay) smoother — a moving median is
    // the identity on a monotone trend and would remove the noise with it where the slope changes fast: V(h) = 2σ²(1 − ρ^h),
    // so ρ = V(2)/V(1) − 1 and σ² = V(1)/(2(1 − ρ)). Second differences alone read correlated noise ≈ 4 × low (ρ 0.9).
    var SG21 = (function () { var w = []; for (var j = -10; j <= 10; j++) w.push(3 * (329 - 5 * j * j) / 9177); return w; })();
    function _noiseAR(y, i0, i1) {
        var mad = function (a) { var m = _median(a); return 1.4826 * _median(a.map(function (v) { return Math.abs(v - m); })); };
        function vlag(h) {
            var d = [], k;
            for (k = Math.max(h, i0 + h); k <= i1; k++) if (_fin(y[k]) && _fin(y[k - h])) d.push(y[k] - y[k - h]);
            if (d.length < 30) return null;
            var e = [], j;
            for (k = 10; k < d.length - 10; k++) { var sm = 0; for (j = -10; j <= 10; j++) sm += SG21[j + 10] * d[k + j]; e.push(d[k] - sm); }
            return Math.pow(mad(e), 2) / (1 - SG21[10]);
        }
        var v1 = vlag(1), v2 = vlag(2);
        if (!(v1 > 0) || !(v2 > 0)) return { sigma: 0, rho: 0 };
        var rho = _clampN(v2 / v1 - 1, 0, 0.97);
        return { sigma: Math.sqrt(v1 / (2 * (1 - rho))), rho: rho };
    }
    // the noise used by the line tests: σ_eff ≥ the second-difference σ, and the effective sample count n·(1 − ρ)/(1 + ρ)
    function _nEff(n, rho) { var r = _clampN(rho || 0, 0, 0.98); return Math.max(2, n * (1 - r) / (1 + r)); }
    function _growLine(Gv, p, i0, iMax, sigma, P, rho) {
        if (i0 < 0 || iMax - i0 < 3) return null;
        var thr0 = Math.max(3 * sigma, 0.05), best = null, j = Math.min(iMax, i0 + 5), fails = 0;
        while (j <= iMax) {
            var wf = _winFits(P, Gv, i0, j);
            if (!wf) break;
            var lf = wf.lin;
            // curvature test: the quadratic-minus-line deviation of a pure-noise window is ≈ 1.68 σ/√n, so a window stops
            // where the deviation exceeds 4 standard errors (never below the 0.05 psi resolution floor, never above 3σ).
            // With correlated noise (ρ1 > 0.3) n_eff is too uncertain for that and the fixed 3σ deviation is kept; the
            // derivative cap in _derivsCore then bounds the window either way.
            var thr = (rho || 0) > 0.3 ? thr0 : Math.max(0.05, Math.min(thr0, 6.7 * sigma / Math.sqrt(_nEff(lf.n, rho))));
            if (wf.dev > thr || lf.s > Math.max(2 * sigma, 0.03)) { if (best || ++fails >= 2) break; }
            else best = { a: lf.a, b: lf.b, i0: i0, i1: j, seA: lf.seA, s: lf.s, n: lf.n };
            if (j === iMax) break;
            var gTarget = Gv[j] * 1.12, jn = j + 1;
            while (jn < iMax && Gv[jn] < gTarget) jn++;
            j = jn;
        }
        return best;
    }
    // the longest straight early-G segment: starts at G_min, then later (× 3 steps in G) when the earliest samples are
    // distorted (shut-in time off by a sample, bleed-off, hammer, a PDL hump); among windows of ≥ 6 points and ≥ 0.5 ln
    // units the one reaching the largest G wins. Each window is grown only while its curvature is statistically absent
    // (_growLine with σ_eff and ρ1), so with noise a window no longer runs past a gentle closure; _derivsCore then caps it
    // at the provisional derivative departure (_departure).
    function _earlyLine(Gv, p, i0, iMax, sigma, rho) {
        if (i0 < 0 || iMax - i0 < 3) return null;
        var P = _prefix(Gv, p), best = null, start = i0, g0 = Gv[i0], tries = 0;
        while (start <= iMax - 5 && tries < 8) {
            var w = _growLine(Gv, p, start, iMax, sigma, P, rho);
            if (w && w.n >= 6) {
                // prefer a window of at least 0.5 ln units that ends at the largest G; else the longest one
                var span = Math.log(Gv[w.i1] / Gv[w.i0]), bspan = best ? Math.log(Gv[best.i1] / Gv[best.i0]) : -1;
                if (!best) best = w;
                else if (span >= 0.5 && (bspan < 0.5 || Gv[w.i1] > Gv[best.i1] * 1.05)) best = w;
                else if (bspan < 0.5 && span > bspan) best = w;
            }
            tries++;
            var gT = Math.max(g0, Gv[start]) * 3; while (start <= iMax && Gv[start] < gT) start++;
        }
        return best;
    }
    // the early G·dP/dG line over [i0, i1]: through the origin when |ι| = |a/(b·G_end)| < 0.05 (§4.7), else free
    function _yLine(x, y, i0, i1) {
        var lfA = _linfit(x, y, i0, i1, false);
        var iota0 = (lfA && lfA.b > 0) ? lfA.a / (lfA.b * x[i1]) : 0;
        var lf = _linfit(x, y, i0, i1, Math.abs(iota0) < 0.05);
        if (!lf || !(lf.b > 0)) return null;
        lf.iota = iota0; lf.origin = Math.abs(iota0) < 0.05;
        return lf;
    }
    // _yLine with one robust refit (samples within max(3ε·ŷ, 4σ_y) of the first line)
    function _yLineRobust(x, y, i0, i1, epsC) {
        var lf = _yLine(x, y, i0, i1);
        if (!lf) return null;
        var nz0 = _lineNoise(x, y, lf, i0, i1), keepG = [], keepY = [];
        for (var i = i0; i <= i1; i++) { var yh0 = lf.a + lf.b * x[i]; if (Math.abs(y[i] - yh0) <= Math.max(3 * epsC * yh0, 4 * nz0.sigma)) { keepG.push(x[i]); keepY.push(y[i]); } }
        var lf2 = keepG.length >= 4 ? _linfit(keepG, keepY, 0, keepG.length - 1, lf.origin) : null;
        if (lf2 && lf2.b > 0) { lf2.iota = lf.iota; lf2.origin = lf.origin; return lf2; }
        return lf;
    }
    // absolute per-sample noise of y about a line over the upper part of [i0, i1] (x ≥ x[i1]·e^−1.5, at least 8 samples):
    // σ = 1.4826·MAD of the residuals, ρ1 their lag-1 correlation. G·dP/dG noise is nearly constant in absolute terms
    // (≈ σ_p/(√2·L) for white pressure noise), so a relative tolerance is σ/ŷ at each sample, not one number.
    function _lineNoise(x, y, lf, i0, i1) {
        var j0 = i1; while (j0 > i0 && (x[j0 - 1] >= x[i1] * Math.exp(-1.5) || i1 - j0 < 7)) j0--;
        var r = [], k;
        for (k = j0; k <= i1; k++) if (_fin(y[k])) r.push(y[k] - (lf.a + lf.b * x[k]));
        if (r.length < 4) return { sigma: 0, rho: 0 };
        var m = _median(r), ad = r.map(function (v) { return Math.abs(v - m); }), num = 0, den = 0;
        for (k = 0; k < r.length; k++) { var u = r[k] - m; den += u * u; if (k) num += u * (r[k - 1] - m); }
        return { sigma: 1.4826 * _median(ad), rho: den > 0 ? _clampN(num / den, -0.99, 0.99) : 0 };
    }
    // the first held departure of y from the early line after index i0 (§4.7 compliance rule). The relative residual of a
    // 5-point moving median must exceed thr(k) = max(ε, 3·c·σ_y/ŷ(k)) — ε is the floor, the noise term the local scale —
    // and stay beyond it for nHold samples (more when the noise is correlated), ≥ 0.05 in ln G with two, or to the end.
    // A moving median is the identity on monotone noise-free data, so clean departures are not shifted.
    function _departure(x, y, lf, i0, eps, sigY, rho) {
        var n = x.length, sm = _movMed(y, 5), rr = _clampN(rho || 0, 0, 0.95);
        var c = Math.min(1, 0.6 * Math.sqrt((1 + rr) / (1 - rr))), nHold = Math.max(3, Math.min(15, Math.round(1 / (1 - rr))));
        function yh(k) { return Math.max(lf.a + lf.b * x[k], 1e-9); }
        function thr(k) { return Math.max(eps, 3 * c * sigY / yh(k)); }
        function rel(k) { return (sm[k] - yh(k)) / yh(k); }
        for (var i = Math.max(0, i0); i < n; i++) {
            var t = thr(i), r0 = rel(i), up = r0 > t;
            if (!(up || r0 < -t)) continue;
            var held = 0, j;
            for (j = i; j < n; j++) { var rj = rel(j), tj = thr(j); if (up ? rj > tj : rj < -tj) held++; else break; }
            // a short excursion (fewer than nHold samples: nHold grows to 15 on smooth, correlated residuals) that then crosses to
            // the other side of the line within 0.3 ln units is a sharp closure, not noise (see the persistence test below)
            // (the excursion must also be far beyond the noise, Σ(r/σ_r)/√n_eff ≥ 8: correlated noise crosses the line too)
            var crossH = false;
            if (held >= 3 && held < nHold) {
                var zH = 0; for (var jz = i; jz < i + held; jz++) zH += (y[jz] - yh(jz)) / Math.max(sigY, 1e-12);
                if (Math.abs(zH) / Math.sqrt(_nEff(held, rr)) >= 8)
                    for (var jc = i + held; jc < n && x[jc] <= x[i] * Math.exp(0.3); jc++) { var rc = rel(jc), tc = thr(jc); if (up ? rc < -tc : rc > tc) { crossH = true; break; } }
            }
            if (held >= nHold || crossH || (nHold <= 3 && held >= 2 && Math.log(x[i + held - 1] / x[i]) >= 0.05) || (j === n && held >= 2)) {
                // persistence: a closure departure grows, a correlated-noise excursion reverts. The smoothed residual must
                // stay beyond half the threshold, same sign, over max(0.05, 0.25·ρ1) in ln G and at least 6 samples after the
                // crossing, and the raw residuals there must be significant together: Σ(r/σ_r)/√n_eff ≥ 4 (σ_r = σ_y/ŷ, n_eff
                // = n·(1 − ρ)/(1 + ρ)). Many crossings are tested on a long falloff, so one 3σ crossing alone is not enough.
                var span = Math.max(0.05, 0.25 * rr), persist = true, zs = 0, nz = 0;
                for (j = i; j < n && (Math.log(x[j] / x[i]) <= span || nz < 6); j++) {
                    var rp = rel(j);
                    if (up ? rp <= 0.5 * thr(j) : rp >= -0.5 * thr(j)) {
                        // a sharp closure reverses ACROSS the line within 0.3 ln units (the excursion can be shorter than the span
                        // on smooth, highly correlated data); a correlated-noise excursion only returns to it
                        var crossE = false;
                        if (nz > 0 && Math.abs(zs) / Math.sqrt(_nEff(nz, rr)) >= 8)
                            for (var jj = j; jj < n && x[jj] <= x[i] * Math.exp(0.3); jj++) { var rq = rel(jj), tq = thr(jj); if (up ? rq < -tq : rq > tq) { crossE = true; break; } }
                        if (!crossE) persist = false;
                        break;
                    }
                    zs += (y[j] - yh(j)) / Math.max(sigY, 1e-12); nz++;
                }
                if (persist && j < n && Math.abs(zs) / Math.sqrt(_nEff(nz, rr)) < 4 && sigY > 0) persist = false;
                // and still beyond the threshold 0.3 ln units later (a start-up distortion or a bump reverts; closure does not)
                // — unless it reverts by crossing to the other side of the line (the after-closure signature of a sharp,
                // compliance-drop closure: G·dP/dG jumps above the line at G_c and then falls below it as the decline slows) or
                // it is far beyond the noise (Σ(r/σ_r)/√n_eff ≥ 8). Those are read at their start (the abrupt-break rule). The
                // reversion test alone moved a noise-free sharp closure 140–190 psi late (Example A, penny case)
                if (persist) {
                    var kl = i; while (kl + 1 < n && x[kl + 1] <= x[i] * Math.exp(0.3)) kl++;
                    if (kl + 1 < n) {
                        var rl = rel(kl), tl = thr(kl);
                        var reverted = up ? rl <= tl : rl >= -tl, crossed = up ? rl < -tl : rl > tl;
                        var strong = sigY > 0 && Math.abs(zs) / Math.sqrt(_nEff(Math.max(nz, 1), rr)) >= 8;
                        if (reverted && !crossed && !strong) persist = false;
                    }
                }
                if (persist) return { i: i, down: !up, thr: thr, rel: rel, sm: sm, nHold: nHold, c: c };
                i = Math.max(i, j - 1);
                continue;
            }
        }
        return null;
    }
    // hinge refinement of a departure on the pressure itself: p = A + B·(G − G_c) + C·(G − G_c)₊² by least squares over
    // [i0, i1], G_c scanned over the samples in [i0 + 5, jMax] and refined by a parabola through the SSR minimum. A dP/dG
    // that leaves its plateau linearly in G (contact onset, the post-closure damping) is exactly this shape at the onset,
    // and the fit uses every pressure sample instead of the first noisy derivative crossing. sgn = +1 needs C > 0 (the
    // decline slows: closure, downward departure), −1 needs C < 0 (stiffening). → {G, p (= A, on the line), C, B} or null
    function _hingeAt(x, p, i0, i1, gc, pm, curved) {
        // basis 1, u, u₊², u₊³ (u = G − G_c): the cubic term absorbs the change of the departure rate over the window, so
        // the onset is not pulled early or late by a curvature that is not exactly quadratic. curved adds u² over the whole
        // window: a base trend that already bends (reservoir-controlled leak-off, dP/dG declining with p − p_r), so u₊² is
        // the change of curvature at G_c
        var m = curved ? 5 : 4, M = [], k, c, r, q;
        for (r = 0; r < m; r++) { var row = []; for (c = 0; c <= m; c++) row.push(0); M.push(row); }
        var bs = [1, 0, 0, 0, 0];
        for (k = i0; k <= i1; k++) {
            var u = x[k] - gc, h = u > 0 ? u * u : 0, yy = p[k] - pm;
            bs[1] = u; bs[2] = h; bs[3] = u > 0 ? h * u : 0; bs[4] = u * u;
            for (r = 0; r < m; r++) { var br = bs[r]; if (br === 0) continue; for (c = r; c < m; c++) M[r][c] += br * bs[c]; M[r][m] += br * yy; }
        }
        for (r = 1; r < m; r++) for (c = 0; c < r; c++) M[r][c] = M[c][r];
        var idx = []; for (r = 0; r < m; r++) idx.push(r);
        if (!(M[3][3] > 0)) {          // no point past G_c far enough for the cubic term: drop it
            idx = idx.filter(function (z) { return z !== 3; });
            M = idx.map(function (rr) { return idx.map(function (cc) { return M[rr][cc]; }).concat([M[rr][m]]); });
            m = idx.length;
        }
        for (c = 0; c < m; c++) {
            var piv = c; for (r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
            if (Math.abs(M[c][c]) < 1e-200) return null;
            for (r = c + 1; r < m; r++) { var f = M[r][c] / M[c][c]; for (q = c; q <= m; q++) M[r][q] -= f * M[c][q]; }
        }
        var cs = []; for (r = 0; r < m; r++) cs.push(0);
        for (r = m - 1; r >= 0; r--) { var sum = M[r][m]; for (c = r + 1; c < m; c++) sum -= M[r][c] * cs[c]; cs[r] = sum / M[r][r]; }
        var co = [0, 0, 0, 0, 0]; idx.forEach(function (z, j) { co[z] = cs[j]; });
        var ss = 0;
        for (k = i0; k <= i1; k++) { var u2 = x[k] - gc, e = (p[k] - pm) - (co[0] + co[1] * u2 + co[4] * u2 * u2 + (u2 > 0 ? co[2] * u2 * u2 + co[3] * u2 * u2 * u2 : 0)); ss += e * e; }
        return { A: co[0] + pm, B: co[1], C: co[2], D: co[3], E: co[4], ssr: ss };
    }
    function _hinge(x, p, i0, i1, jMax, sgn, curved) {
        if (i1 - i0 < 10) return null;
        var pm = 0, k; for (k = i0; k <= i1; k++) pm += p[k]; pm /= (i1 - i0 + 1);
        var best = null, bj = -1, ss = {};
        var jS = i0 + 5; while (jS < jMax && x[jS] < x[Math.min(jMax, i1 - 3)] * Math.exp(-0.45)) jS++;
        for (var j = jS; j <= Math.min(jMax, i1 - 3); j++) {
            var f = _hingeAt(x, p, i0, i1, x[j], pm, curved);
            if (!f) continue;
            ss[j] = f.ssr;
            if (sgn * f.C > 0 && (!best || f.ssr < best.ssr)) { best = f; bj = j; best.gc = x[j]; }
        }
        if (!best) return null;
        // sub-sample scan (4 steps per interval over the neighbouring intervals): the SSR is not convex at the sample
        // resolution when the departure law is only approximately cubic; the best sub-sample G_c is then refined by a
        // parabola through its neighbours
        var gl = x[Math.max(i0 + 5, bj - 1)], gh = x[Math.min(Math.min(jMax, i1 - 3), bj + 1)], fine = [], q;
        if (gh > gl) {
            for (q = 0; q <= 8; q++) {
                var gq = gl + (gh - gl) * q / 8, fq = _hingeAt(x, p, i0, i1, gq, pm, curved);
                fine.push({ g: gq, f: fq });
                if (fq && sgn * fq.C > 0 && fq.ssr < best.ssr) { best = fq; best.gc = gq; }
            }
            var qb = -1; for (q = 0; q < fine.length; q++) if (fine[q].f && fine[q].g === best.gc) qb = q;
            if (qb > 0 && qb < fine.length - 1 && fine[qb - 1].f && fine[qb + 1].f) {
                var x0 = fine[qb - 1].g, x1 = fine[qb].g, x2 = fine[qb + 1].g, y0 = fine[qb - 1].f.ssr, y1 = fine[qb].f.ssr, y2 = fine[qb + 1].f.ssr;
                var den = (x0 - x1) * (x0 - x2) * (x1 - x2);
                if (den !== 0) {
                    var A2 = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / den, B2 = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / den;
                    if (A2 > 0) {
                        var gv = _clampN(-B2 / (2 * A2), x0, x2), fv = _hingeAt(x, p, i0, i1, gv, pm, curved);
                        if (fv && sgn * fv.C > 0 && fv.ssr <= best.ssr) { best = fv; best.gc = gv; }
                    }
                }
            }
        }
        // profile interval of G_c: the samples whose SSR stays within σ²·(1 + ρ)/(1 − ρ) of the minimum (χ²₁ = 1, the
        // residual σ² and lag-1 ρ of the best fit), contiguous around it → se(G_c) = half its width (≥ half a sample step)
        var r = [], num = 0, den = 0;
        for (k = i0; k <= i1; k++) { var u = x[k] - best.gc; r.push((p[k] - pm) - (best.A - pm + best.B * u + (best.E || 0) * u * u + (u > 0 ? best.C * u * u + (best.D || 0) * u * u * u : 0))); }
        for (k = 1; k < r.length; k++) { num += r[k] * r[k - 1]; den += r[k] * r[k]; }
        var rho = den > 0 ? _clampN(num / den, 0, 0.95) : 0, s2 = best.ssr / Math.max(1, r.length - (curved ? 6 : 5)), lim = best.ssr + s2 * (1 + rho) / (1 - rho);
        var jl = bj, jh = bj;
        while (ss[jl - 1] != null && ss[jl - 1] <= lim) jl--;
        while (ss[jh + 1] != null && ss[jh + 1] <= lim) jh++;
        var seG = Math.max((x[jh] - x[jl]) / 2, 0.5 * (x[Math.min(bj + 1, i1)] - x[Math.max(bj - 1, i0)]) / 2);
        return { G: best.gc, p: best.A, C: best.C, B: best.B, ssr: best.ssr, seG: seG, se: Math.abs(best.B) * seG, rho: rho };
    }
    function _inv3(A) {
        var a = A[0][0], b = A[0][1], c = A[0][2], d = A[1][0], e = A[1][1], f = A[1][2], g = A[2][0], h = A[2][1], i = A[2][2];
        var D = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
        if (!(Math.abs(D) > 1e-300)) return null;
        return [[(e * i - f * h) / D, (c * h - b * i) / D, (b * f - c * e) / D], [(f * g - d * i) / D, (a * i - c * g) / D, (c * d - a * f) / D], [(d * h - e * g) / D, (b * g - a * h) / D, (a * e - b * d) / D]];
    }
    // the vertex of a peak of s (concave quadratic in ln G) over [k0, k1]; null when not concave or outside
    function _vertex(x, s, k0, k1) {
        var n = 0, sx = [0, 0, 0, 0, 0], sy = [0, 0, 0], k, xm = 0;
        for (k = k0; k <= k1; k++) if (_fin(s[k]) && x[k] > 0) { xm += Math.log(x[k]); n++; }
        if (n < 3) return null;
        xm /= n;
        for (k = k0; k <= k1; k++) {
            if (!_fin(s[k]) || !(x[k] > 0)) continue;
            var u = Math.log(x[k]) - xm, u2 = u * u;
            sx[0]++; sx[1] += u; sx[2] += u2; sx[3] += u2 * u; sx[4] += u2 * u2; sy[0] += s[k]; sy[1] += u * s[k]; sy[2] += u2 * s[k];
        }
        var M = [[sx[0], sx[1], sx[2], sy[0]], [sx[1], sx[2], sx[3], sy[1]], [sx[2], sx[3], sx[4], sy[2]]], c, r, q;
        for (c = 0; c < 3; c++) {
            var piv = c; for (r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
            if (Math.abs(M[c][c]) < 1e-300) return null;
            for (r = c + 1; r < 3; r++) { var f = M[r][c] / M[c][c]; for (q = c; q < 4; q++) M[r][q] -= f * M[c][q]; }
        }
        var c2 = M[2][3] / M[2][2], c1 = (M[1][3] - M[1][2] * c2) / M[1][1], c0 = (M[0][3] - M[0][1] * c1 - M[0][2] * c2) / M[0][0];
        if (!(c2 < 0)) return null;
        var uv = -c1 / (2 * c2), lo = Math.log(x[k0]) - xm, hi = Math.log(x[k1]) - xm;
        if (uv < lo || uv > hi) return null;
        // se of the vertex (delta method on c1, c2 with the residual σ², inflated by the lag-1 correlation)
        var rs = [], ss2 = 0, num = 0, den = 0;
        for (k = k0; k <= k1; k++) { if (!_fin(s[k]) || !(x[k] > 0)) continue; var w = Math.log(x[k]) - xm; rs.push(s[k] - (c0 + c1 * w + c2 * w * w)); }
        for (k = 0; k < rs.length; k++) { ss2 += rs[k] * rs[k]; if (k) num += rs[k] * rs[k - 1]; }
        den = ss2;
        var rho = den > 0 ? _clampN(num / den, 0, 0.95) : 0, s2 = n > 3 ? ss2 / (n - 3) * (1 + rho) / (1 - rho) : 0, seU = null;
        var Sx = [[sx[0], sx[1], sx[2]], [sx[1], sx[2], sx[3]], [sx[2], sx[3], sx[4]]], Ci = n > 3 ? _inv3(Sx) : null;
        if (Ci) {
            var g1 = -1 / (2 * c2), g2 = c1 / (2 * c2 * c2);           // ∂u_v/∂c1, ∂u_v/∂c2
            var vv = s2 * (g1 * g1 * Ci[1][1] + 2 * g1 * g2 * Ci[1][2] + g2 * g2 * Ci[2][2]);
            seU = vv > 0 ? Math.sqrt(vv) : 0;
        }
        return { G: Math.exp(uv + xm), s: c0 + c1 * uv + c2 * uv * uv, seLn: seU };
    }
    function _tpOf(events, choice) {
        var tpc = events.tp || {};
        var v = tpc[choice];
        if (_fin(v) && v > 0) return { tp: v, choice: choice };
        return { tp: tpc.pump, choice: 'pump' };
    }
    // the G function object used by derivs: closed form (α ½ / 1 / general) or a data-driven / model gSpec
    function _gChoice(prep, events, opts, tp) {
        var a = opts.alpha, aGen = _fin(opts.alphaGeneral) ? opts.alphaGeneral : 0.75;
        if (_isSpec(a)) return { fn: a, alpha: a.alpha || 0.5, gType: a.kind === 'model' ? 'model' : 'data' };
        if (a === 'general') return { fn: aGen, alpha: aGen, gType: 'general' };
        if (a === 0.5 || a === 1) return { fn: a, alpha: a, gType: a === 1 ? 'a1' : 'a05' };
        if (_fin(a) && a > 0.5 && a <= 1) return { fn: a, alpha: a, gType: 'general' };
        var wantData = (a === 'data') || (a === 'auto' || a == null);
        var steps = wantData ? _rateSteps(prep, events) : null;
        if (steps && steps.length) {
            var gs = G.PRiSM_dfit_gFromHistory(steps, events.ts, tp, { alpha: 0.5 });
            if (_okRes(gs)) return { fn: gs, alpha: 0.5, gType: 'data' };
        }
        return { fn: 0.5, alpha: 0.5, gType: 'a05' };
    }
    function _derivsCore(prep, events, opts) {
        opts = opts || {};
        var tpc = _tpOf(events, opts.tp || 'pump'), tp = tpc.tp;
        if (!_fin(tp) || tp <= 0) return _fail('NO_TP', 'The pumping time is not defined.', ['tp']);
        var ts = _fin(opts.ts) ? opts.ts : events.ts, tEnd = INF;
        // the falloff ends at the next injection or the flowback start
        if (events.flowback && _fin(events.flowback.t0) && events.flowback.t0 > ts) tEnd = events.flowback.t0;
        (events.cycles || []).forEach(function (c) { if (c.tStart > ts + 1e-9 && c.tStart < tEnd) tEnd = c.tStart; });
        var gc = _gChoice(prep, events, opts, tp);
        var L = _fin(opts.L) && opts.L > 0 ? opts.L : 0.1;
        var t = prep.t, pw = prep.pw, dt = [], p = [], idx = [], i;
        var qq = Array.isArray(prep.q) ? prep.q : null;   // pumping samples never enter the falloff (t_s moved by a sample)
        for (i = 0; i < t.length; i++) if (t[i] > ts + 1e-12 && t[i] < tEnd && !(qq && qq[i] > 0 && t[i] <= events.ts + 1e-12)) { dt.push(t[i] - ts); p.push(pw[i]); idx.push(i); }
        var n = dt.length;
        if (n < 5) return _fail('SHORT_FALLOFF', 'Fewer than five falloff samples after shut-in.', ['p']);
        var dtD = new Array(n), Gv = new Array(n), Gp = new Array(n);
        for (i = 0; i < n; i++) { dtD[i] = dt[i] / tp; Gv[i] = _Gof(dtD[i], gc.fn); Gp[i] = _Gpof(dtD[i], gc.fn); }
        var sigma = Math.max(prep.sigma || 0, 1e-6);
        // G_min: hammer end, predicted bleed-off end, gauge thermal transient end, 1 % of the falloff samples; or the user's
        var gMin = null, why = '1%', i1p = Math.min(n - 1, Math.floor(0.01 * n));
        gMin = Gv[i1p];
        var tMinH = 0, cand = [];
        if (opts.hammer && _fin(opts.hammer.tEnd)) { var te = opts.hammer.tEnd > ts ? opts.hammer.tEnd - ts : opts.hammer.tEnd; cand.push({ dt: te, why: 'hammer' }); }
        if (opts.bleed) {
            var thr1 = Math.max(1, 3 * sigma), tb1 = null;
            if (typeof opts.bleed.curve === 'function') {
                for (i = 0; i < n; i++) { var bv = opts.bleed.curve(dt[i]); if (_fin(bv) && bv < thr1) { tb1 = dt[i]; break; } }
            } else if (_fin(opts.bleed.t1psi)) tb1 = opts.bleed.t1psi;
            if (_fin(tb1)) cand.push({ dt: tb1, why: 'bleed-off' });
        }
        if (Array.isArray(prep.T)) {
            var tTh = null;
            for (i = 1; i < idx.length; i++) {
                var Ta = prep.T[idx[i - 1]], Tb = prep.T[idx[i]];
                if (_fin(Ta) && _fin(Tb) && Math.abs(Tb - Ta) / ((dt[i] - dt[i - 1]) * 60) > 1) tTh = dt[i];
            }
            if (tTh !== null) cand.push({ dt: tTh, why: 'thermal' });
        }
        cand.forEach(function (c) { var gc2 = _Gof(c.dt / tp, gc.fn); if (gc2 > gMin) { gMin = gc2; why = c.why; } });
        if (_fin(opts.gMin)) { gMin = opts.gMin; why = 'user'; }
        // early line (needs ≥ 6 points after G_min) → m_G and a provisional ISIP
        var iG = 0; while (iG < n && Gv[iG] < gMin) iG++;
        var iMax = n - 1;
        // per-sample pressure noise with its lag-1 correlation (block quadratics), never below the second-difference σ
        var nzP = _noiseAR(p, iG, iMax), sigEff = Math.max(sigma, nzP.sigma);
        var el = _earlyLine(Gv, p, iG, iMax, sigEff, nzP.rho);
        // cap the p-line window at the provisional derivative departure: the line must end one window L before G·dP/dG
        // leaves the early line (a p-line can still run a little past a gentle closure within its noise)
        // the G derivative does not depend on the ISIP (a constant offset): computed once on −p and reused below
        var yt = _bourdet(Gv, p.map(function (v) { return -v; }), L);
        if (el) {
            var cx = [], cy = [], ci = [];
            for (i = el.i0; i < n; i++) if (_fin(yt[i]) && Gv[i] > 0) { cx.push(Gv[i]); cy.push(yt[i]); ci.push(i); }
            var gEnd = Gv[el.i1] * Math.exp(-L), ke = 0; while (ke + 1 < cx.length && ci[ke + 1] <= el.i1 && cx[ke + 1] <= gEnd) ke++;
            var ly = ke >= 5 ? _yLineRobust(cx, cy, 0, ke, 0.02) : null;
            if (ly) {
                var kS = 1; while (kS < ke && cx[kS] < cx[0] * Math.exp(L + 0.02)) kS++;
                var nzY = _lineNoise(cx, cy, ly, 0, ke), dpv = _departure(cx, cy, ly, kS, 0.02, nzY.sigma, nzY.rho);
                if (dpv && ci[dpv.i] <= el.i1) {
                    var gCap = cx[dpv.i] * Math.exp(-L), j1 = el.i0;
                    while (j1 + 1 <= el.i1 && Gv[j1 + 1] <= gCap) j1++;
                    var wfc = (j1 - el.i0 >= 5 && Math.log(Gv[j1] / Gv[el.i0]) >= 0.5) ? _winFits(_prefix(Gv, p), Gv, el.i0, j1) : null;
                    if (wfc) el = { a: wfc.lin.a, b: wfc.lin.b, i0: el.i0, i1: j1, seA: wfc.lin.seA, s: wfc.lin.s, n: wfc.lin.n, capped: true };
                }
            }
        }
        // PDL hump (§4.4, §4.11: fit after the hump). With pressure-dependent leak-off the earliest straight p-G piece lies on the
        // hump (dP/dG still falling) and its slope is not m_G. A later straight window (≥ 0.5 ln units, ≥ 6 points, its own
        // G·dP/dG line through the origin, |ι| < 0.05) with a dP/dG at least 10 % lower, reached by a dP/dG that only falls
        // (2 % tolerance) and joins that window within 5 %, is the post-hump line: it sets m_G and the early window of the
        // picks; the ISIP stays on the earliest line (the hump decays from the true ISIP)
        var late = null;
        if (el && !opts.noPostHump) {
            var Pp = _prefix(Gv, p), smD = _movMed(Gv.map(function (g, k) { return _fin(yt[k]) && g > 0 ? yt[k] / g : null; }), 5);
            var humpOK = function (e1, w2) {
                if (!w2 || w2.n < 6 || Math.log(Gv[w2.i1] / Gv[w2.i0]) < 0.5 || !(-w2.b > 0) || !(-w2.b < 0.9 * -e1.b)) return false;
                // ι over the window less one Bourdet window L at its end (the derivative there already sees what follows)
                var j1L = w2.i0; while (j1L + 1 <= w2.i1 && Gv[j1L + 1] <= Gv[w2.i1] * Math.exp(-L)) j1L++;
                var bL = -w2.b, lyL = j1L - w2.i0 >= 4 ? _linfit(Gv, yt, w2.i0, j1L, false) : null, ioL = lyL && lyL.b > 0 ? lyL.a / (lyL.b * Gv[j1L]) : 1;
                if (!(Math.abs(ioL) < 0.05 && _fin(smD[w2.i0]) && Math.abs(smD[w2.i0] / bL - 1) <= 0.05)) return false;
                for (var kk = e1.i0, mx = -INF; kk <= w2.i0; kk++) {
                    if (!_fin(smD[kk])) continue;
                    if (mx > -INF && smD[kk] > 1.02 * mx) return false;      // dP/dG rises again: not a decaying hump
                    mx = mx === -INF ? smD[kk] : Math.min(mx, smD[kk]);
                }
                return _fin(smD[e1.i0]) && smD[e1.i0] >= 1.1 * bL;
            };
            var asLate = function (w2) { return { a: w2.a, b: w2.b, i0: w2.i0, i1: w2.i1, seA: w2.seA, s: w2.s, n: w2.n, postHump: true }; };
            // the window _earlyLine chose (the one reaching the largest G) may itself be the post-hump line: the ISIP line is
            // then the earliest window from G_min (on the hump, where the decline starts from the true ISIP)
            var elF = _growLine(Gv, p, iG, iMax, sigEff, Pp, nzP.rho);
            // — only when the hump carries a real pressure drop (the two intercepts differ by ≥ 15 % of the drop to the end of the
            // later window): a short bleed-off of the near-well friction on a soft (gas-filled) wellbore also lifts the first
            // samples, by a few psi, and there the later line's intercept is the ISIP
            if (elF && elF.n >= 6 && el.i0 > elF.i1 && elF.a - el.a >= 0.15 * (elF.a - p[el.i1]) && humpOK(elF, el)) { late = asLate(el); el = { a: elF.a, b: elF.b, i0: elF.i0, i1: elF.i1, seA: elF.seA, s: elF.s, n: elF.n }; }
            var st2 = el.i1, tr2 = 0;
            while (!late && st2 <= iMax - 5 && tr2 < 24) {
                var w2 = _growLine(Gv, p, st2, iMax, sigEff, Pp, nzP.rho);
                if (humpOK(el, w2)) late = asLate(w2);
                tr2++;
                var gT2 = Gv[st2] * 1.25; while (st2 <= iMax && Gv[st2] < gT2) st2++;
            }
            var bEl = -el.b;
            // second route: after the hump the leak-off can still decline gently with p − p_r (no exactly straight p-G piece). The
            // hump ends where the smoothed dP/dG stops falling fast (log slope over the next 0.2 ln above −0.1, after a hump
            // with dP/dG(start) ≥ 1.3 × its end value); the post-hump window runs on while dP/dG stays within 15 % of that end
            // value (≥ 0.4 ln units, ≥ 6 points), its G·dP/dG line within |ι| < 0.15 of the origin
            if (!late) {
                var kAtG = function (gv, from) { var k = from; while (k + 1 <= iMax && Gv[k + 1] <= gv) k++; return k; };
                var kh = -1;
                for (var q = el.i1; q <= iMax - 3 && kh < 0; q++) {
                    if (!_fin(smD[q]) || !(smD[q] > 0)) continue;
                    var qn = kAtG(Gv[q] * Math.exp(0.2), q);
                    if (qn <= q || !_fin(smD[qn]) || !(smD[qn] > 0)) continue;
                    if (Math.log(smD[qn] / smD[q]) / Math.log(Gv[qn] / Gv[q]) > -0.1 && _fin(smD[el.i0]) && smD[el.i0] >= 1.3 * smD[q]) kh = q;
                }
                if (kh > 0) {
                    var ref = smD[kh], kq = kh;
                    while (kq + 1 <= iMax && _fin(smD[kq + 1]) && Math.abs(smD[kq + 1] / ref - 1) <= 0.15) kq++;
                    var kqL = kq; while (kqL > kh && Gv[kqL] > Gv[kq] * Math.exp(-L)) kqL--;
                    if (kq - kh >= 5 && Math.log(Gv[kq] / Gv[kh]) >= 0.4) {
                        var wfL = _winFits(Pp, Gv, kh, kq), lyQ = kqL - kh >= 4 ? _linfit(Gv, yt, kh, kqL, false) : null;
                        var ioQ = lyQ && lyQ.b > 0 ? lyQ.a / (lyQ.b * Gv[kqL]) : 1;
                        for (var kk2 = el.i0, mx2 = -INF, okQ = true; kk2 <= kh; kk2++) {
                            if (!_fin(smD[kk2])) continue;
                            if (mx2 > -INF && smD[kk2] > 1.02 * mx2) okQ = false;
                            mx2 = mx2 === -INF ? smD[kk2] : Math.min(mx2, smD[kk2]);
                        }
                        if (wfL && wfL.lin.b < 0 && -wfL.lin.b < 0.9 * bEl && Math.abs(ioQ) < 0.15 && okQ)
                            late = { a: wfL.lin.a, b: wfL.lin.b, i0: kh, i1: kq, seA: wfL.lin.seA, s: wfL.lin.s, n: wfL.lin.n, postHump: true, plateau: true };
                    }
                }
            }
        }
        var isip = _fin(opts.isip) ? opts.isip : (el ? el.a : p[0]);
        var elM = late || el;
        var mG = elM ? -elM.b : null;
        var dpI = p.map(function (v) { return isip - v; });
        var y = yt, Dd = _bourdet(dt, dpI, L);
        var GdPdG = new Array(n), dPdG = new Array(n), D = new Array(n), Dref = new Array(n), ppd = new Array(n), sdPds = new Array(n), dPds = new Array(n), sq = new Array(n), usable = new Array(n);
        for (i = 0; i < n; i++) {
            var yi = y[i], di = Dd[i];
            GdPdG[i] = _fin(yi) ? Math.max(0, yi) : null;
            dPdG[i] = _fin(yi) ? Math.max(0, yi / Gv[i]) : null;
            D[i] = _fin(di) ? Math.max(0, di) : null;
            ppd[i] = _fin(di) ? Math.max(0, di / dt[i]) : null;
            sdPds[i] = _fin(di) ? Math.max(0, 2 * di) : null;
            dPds[i] = _fin(di) ? Math.max(0, 2 * di / Math.sqrt(dt[i])) : null;
            sq[i] = Math.sqrt(dt[i]);
            Dref[i] = (_fin(mG) && mG > 0) ? mG * dtD[i] * Gp[i] : null;
            usable[i] = (Gv[i] >= gMin && GdPdG[i] !== null) ? 1 : 0;
        }
        // derivative noise σ_y (second differences of G·dP/dG over the usable part)
        var yu = []; for (i = 0; i < n; i++) if (usable[i]) yu.push(GdPdG[i]);
        var sigmaY = _noise2(yu);
        function axis(arr) {
            var a = []; for (var k = 0; k < n; k++) if (usable[k] && arr[k] !== null) a.push(arr[k]);
            a.sort(function (u, v) { return u - v; });
            if (!a.length) return [0, 1];
            var lo = _pct(a, 0.02), hi = _pct(a, 0.98), pad = 0.1 * (hi - lo || Math.abs(hi) || 1);
            return [Math.max(0, lo - pad), hi + pad];
        }
        var warnings = [];
        if (!el) warnings.push(_W('NO_EARLY_LINE', 'warn', 'No straight early-G segment after G_min: m_G and the reference curve are not defined.', ['G1']));
        return {
            ok: true, alpha: gc.alpha, gType: gc.gType, tp: tp, tpChoice: tpc.choice, dt: dt, dtD: dtD, G: Gv, p: p, dpIsip: dpI,
            GdPdG: GdPdG, dPdG: dPdG, sqrtDt: sq, sdPds: sdPds, dPds: dPds, D: D, Dref: Dref, ppd: ppd, mG: _nn(mG),
            earlyWin: elM ? [Gv[elM.i0], Gv[elM.i1]] : [gMin, gMin], h: null, humpWin: late ? [Gv[el.i0], Gv[late.i0]] : null, axis: opts._inner ? { GdPdG: [0, 1], dPdG: [0, 1] } : { GdPdG: axis(GdPdG), dPdG: axis(dPdG) },
            L: L, gMin: gMin, gMinWhy: why, usable: usable, sigmaY: sigmaY, ev: ['G1'],
            // extras (not in the §3.5 table; read by 56's own pick, ISIP and frac functions and by 57)
            ts: ts, isip: isip, idx: idx, Gp: Gp, sigma: sigma, sigmaEff: sigEff, rho: _r(nzP.rho, 4), early: el ? { a: el.a, b: el.b, seA: el.seA, i0: el.i0, i1: el.i1, s: el.s, n: el.n } : null,
            gSpec: _isSpec(gc.fn) ? gc.fn : null, warnings: warnings
        };
    }
    G.PRiSM_dfit_derivs = _safe(function (prep, events, opts) {
        if (!_okRes(prep) || !Array.isArray(prep.t)) return _fail('BAD_INPUT', 'Prepared data are needed.', ['prep']);
        if (!_okRes(events) || !_fin(events.ts)) return _fail('BAD_INPUT', 'Events with a shut-in time are needed.', ['events']);
        return _derivsCore(prep, events, opts || {});
    });
    // G at a ΔtD for a Derivs object (closed form when the α is closed, the gSpec when data-driven)
    function _GatD(derivs, dtD) {
        if (derivs.gSpec) return _sGD(derivs.gSpec, dtD);
        return G_(dtD, derivs.gType === 'a1' ? 1 : (derivs.gType === 'a05' ? 0.5 : derivs.alpha));
    }
    function _GinvD(derivs, Gv) {
        if (derivs.gSpec) return _Ginv(Gv, derivs.gSpec);
        return _Ginv(Gv, derivs.gType === 'a1' ? 1 : (derivs.gType === 'a05' ? 0.5 : derivs.alpha));
    }
    // Δt at which the falloff reaches a pressure (first crossing; log interpolation) or null
    function _dtAtP(derivs, pc) {
        var p = derivs.p, dt = derivs.dt, el = derivs.early;
        for (var i = 1; i < p.length; i++) {
            if (p[i - 1] >= pc && p[i] < pc) {
                // on the early straight line the crossing is read on the line (exact for normal leak-off)
                if (el && _fin(el.a) && el.b < 0) {
                    var gl = (el.a - pc) / -el.b;
                    if (gl >= derivs.G[i - 1] && gl <= derivs.G[i] && Math.abs(p[i - 1] - (el.a + el.b * derivs.G[i - 1])) <= Math.max(3 * (derivs.sigma || 0), 0.05)) {
                        return _GinvD(derivs, gl) * derivs.tp;
                    }
                }
                var f = (p[i - 1] - pc) / (p[i - 1] - p[i]);
                return Math.exp(Math.log(dt[i - 1]) + f * (Math.log(dt[i]) - Math.log(dt[i - 1])));
            }
        }
        if (p.length && p[0] < pc) return dt[0];
        return null;
    }

    // ═════════════════════════════════════════════════════════════════════
    // §4.4 ISIP: four estimates in three families, reconciled over families
    // ═════════════════════════════════════════════════════════════════════
    // candidates [{method, family, value, se, ok, upper, …}] → {value, spread, confidence, why}; pn and sigma set the bands
    function _reconcile(cands, o) {
        o = o || {};
        var pn = _fin(o.pn) && o.pn > 0 ? o.pn : 0, fams = {}, why = [];
        cands.forEach(function (c) {
            if (!c.ok || c.upper || !_fin(c.value)) return;
            var se = Math.max(_fin(c.se) ? c.se : 0, 0.1);
            if (!fams[c.family] || se < Math.max(fams[c.family].se, 0.1)) fams[c.family] = { value: c.value, se: se, method: c.method };
        });
        var keys = Object.keys(fams);
        if (!keys.length) {
            var up = cands.filter(function (c) { return c.ok && _fin(c.value); });
            if (!up.length) return null;
            var mn = Math.min.apply(null, up.map(function (c) { return c.value; }));
            return { value: mn, spread: 0, confidence: 'low', why: ['Only upper estimates are available; the lowest, ' + _f0(mn) + ' psia, is used.'], families: {} };
        }
        var ws = 0, wv = 0, mx = -INF, mn2 = INF;
        keys.forEach(function (k) { var f = fams[k], w = 1 / (f.se * f.se); ws += w; wv += w * f.value; mx = Math.max(mx, f.value); mn2 = Math.min(mn2, f.value); });
        var val = wv / ws, spread = mx - mn2;
        var hi = Math.max(10, 0.02 * pn), med = Math.max(25, 0.05 * pn), conf;
        if (keys.length === 1) { conf = 'medium'; why.push('Only one ISIP family (' + keys[0] + ') is available, so agreement cannot be checked.'); }
        else if (spread <= hi) { conf = 'high'; why.push(keys.length + ' families agree within ' + _f1(spread, 1) + ' psi, inside max(10 psi, 2 % of pn) = ' + _f1(hi, 0) + ' psi.'); }
        else if (spread <= med) { conf = 'medium'; why.push('The families differ by ' + _f1(spread, 1) + ' psi, inside max(25 psi, 5 % of pn) = ' + _f1(med, 0) + ' psi.'); }
        else {
            conf = 'low';
            var far = null, fd = -1;
            keys.forEach(function (k) { var d = Math.abs(fams[k].value - val); if (d > fd) { fd = d; far = k; } });
            var reason = { wave: 'friction bleed-off left in the hammer midline', falloff: 'a non-linear early-G segment (PDL or tip extension)', friction: 'step-down coefficients or in-fracture viscous loss' }[far] || 'an inconsistent estimate';
            why.push('The families differ by ' + _f1(spread, 1) + ' psi; the ' + far + ' estimate is the outlier (likely ' + reason + ').');
        }
        return { value: val, spread: spread, confidence: conf, why: why, families: fams };
    }
    G.PRiSM_dfit_isip = _safe(function (prep, events, derivs, ctx) {
        ctx = ctx || {};
        if (!_okRes(derivs) || !Array.isArray(derivs.G)) return _fail('BAD_INPUT', 'Derivatives are needed for the ISIP.', ['derivs']);
        var sigma = Math.max(_fin(derivs.sigma) ? derivs.sigma : (prep && prep.sigma) || 0, 0.01), cands = [];
        var sig3 = Math.max(2, 3 * sigma);
        // 1. water-hammer midline (WTS_wellbore.hammerQuick result passed in ctx.hammer)
        var hm = ctx.hammer;
        if (_okRes(hm) && _fin(hm.isip)) {
            // WTS_wellbore.hammerQuick reports the fit as hm.bleed.fitted and its own §4.4 verdict as hm.upper (false = accepted)
            var bleedAtEnd = null, fitted = hm.bleedFitted === true || (_isObj2(hm.bleed) && hm.bleed.fitted === true);
            var dtEnd = _fin(hm.tEnd) ? (hm.tEnd > derivs.ts ? hm.tEnd - derivs.ts : hm.tEnd) : null;
            if (ctx.bleed && typeof ctx.bleed.curve === 'function' && _fin(dtEnd)) bleedAtEnd = ctx.bleed.curve(dtEnd);
            if (!_fin(bleedAtEnd) && _isObj2(hm.bleed) && _fin(hm.bleed.dEnd)) bleedAtEnd = hm.bleed.dEnd;
            var accepted = fitted || (_fin(bleedAtEnd) && bleedAtEnd < sig3) || (hm.upper === false && _fin(bleedAtEnd));
            cands.push({ method: 'wh', family: 'wave', value: hm.isip, se: _fin(hm.se) ? hm.se : Math.max(1, 3 * sigma), ok: true, upper: !accepted,
                         bleedAtEnd: _nn(bleedAtEnd), viscCorr: null,
                         why: _txt(accepted ? (fitted ? 'Water-hammer midline with the friction bleed-off term fitted.' : 'Water-hammer midline; the predicted bleed-off at the window end is ' + _f1(bleedAtEnd, 1) + ' psi.')
                             : 'Upper estimate: the friction bleed-off is ' + (_fin(bleedAtEnd) ? _f1(bleedAtEnd, 1) + ' psi at the window end and was not fitted.' : 'not modelled in the hammer fit.')),
                         ev: ['H1'] });
        }
        // 2. early-G extrapolation p = ISIP − m_G·G (on G, never on √Δt)
        var el = derivs.early;
        if (el && _fin(el.a)) {
            var nl = derivs.earlyWin && derivs.earlyWin[0] > derivs.gMin * 1.5;
            cands.push({ method: 'g', family: 'falloff', value: el.a, se: Math.max(el.seA || 0, sigma / Math.sqrt(Math.max(el.n, 1)), 0.1), ok: true, upper: false,
                         bleedAtEnd: null, viscCorr: null,
                         why: _txt('Early-G straight line on G from ' + _f1(derivs.earlyWin[0], 2) + ' to ' + _f1(derivs.earlyWin[1], 2) + (nl ? ' (after a non-linear early segment).' : '.')), ev: ['I2'] });
        }
        // 3. step-down intercept, 4. last pump pressure minus friction (shared coefficients, family friction)
        var sd = ctx.stepDown;
        if (_okRes(sd) && _fin(sd.pFrac)) {
            cands.push({ method: 'sd', family: 'friction', value: sd.pFrac, se: (sd.se && _fin(sd.se.pFrac)) ? Math.max(sd.se.pFrac, 0.1) : 5, ok: sd.label !== 'refused', upper: false,
                         bleedAtEnd: null, viscCorr: null, why: _txt('Step-down intercept (' + (sd.label || 'unlabelled') + ').'), ev: ['S1'] });
            if (events && _fin(events.pShut) && sd.at) {
                var lump = ctx.lumped, visc = (lump && _fin(lump.lambda) && _fin(lump.pVisc)) ? (lump.lambda - 1) * lump.pVisc : null;
                // the friction at the LAST pumping rate (pShut is read there): a·q_last² + b·q_last^β from the step-down coefficients.
                // sd.at is evaluated at the top step rate, which after a step-down overstated the friction (reference demo: 353 psi
                // at 5 bbl/min against 160 psi at 1.25 bbl/min, so ISIP_lp sat 190 psi low)
                var qL = _fin(events.qLast) && events.qLast > 0 ? events.qLast : null, dpF;
                if (qL !== null && _fin(sd.a) && _fin(sd.b)) dpF = sd.a * qL * qL + sd.b * Math.pow(qL, _fin(sd.beta) && sd.beta > 0 ? sd.beta : 0.5);
                else dpF = (_fin(sd.at.dpPerf) ? sd.at.dpPerf : 0) + (_fin(sd.at.dpNwb) ? sd.at.dpNwb : 0);
                var lp = events.pShut - dpF - (visc || 0);
                cands.push({ method: 'lp', family: 'friction', value: lp, se: Math.sqrt(Math.pow((sd.se && _fin(sd.se.pFrac)) ? sd.se.pFrac : 5, 2) + 4) + (visc === null ? 10 : 0), ok: true, upper: visc === null,
                             bleedAtEnd: null, viscCorr: _nn(visc),
                             why: _txt(visc === null ? 'Fracture-entrance pressure, upper estimate: the in-fracture viscous term is not known.' : 'Last pump pressure minus perforation, tortuosity and in-fracture viscous losses.'), ev: ['S2'] });
            }
        }
        // extra given candidates (tests, user-entered estimates)
        (ctx.candidates || []).forEach(function (c) {
            if (!_isObj2(c) || !_fin(c.value)) return;
            var fam = c.family || ({ wh: 'wave', g: 'falloff', sd: 'friction', lp: 'friction' }[c.method] || 'falloff');
            cands.push({ method: c.method || 'g', family: fam, value: c.value, se: _fin(c.se) ? c.se : 5, ok: c.ok !== false, upper: !!c.upper,
                         bleedAtEnd: _nn(c.bleedAtEnd), viscCorr: _nn(c.viscCorr), why: _txt(c.why || 'Given estimate.'), ev: Array.isArray(c.ev) && c.ev.length ? c.ev : ['I3'] });
        });
        if (!cands.length) return _fail('NO_ISIP', 'No ISIP estimate is available (no early straight G segment, hammer or step-down).', ['isip']);
        // the agreement bands scale with p_n: ctx.pn, else ISIP − ctx.sigmaC once the ISIP is known, else the 10 / 25 psi floors
        var rec = _reconcile(cands, { pn: ctx.pn });
        if (!_fin(ctx.pn) && _fin(ctx.sigmaC) && rec) rec = _reconcile(cands, { pn: rec.value - ctx.sigmaC });
        if (!rec) return _fail('NO_ISIP', 'No usable ISIP estimate.', ['isip']);
        // log-log check: the ISIP for which early Δp and D keep the Nolte ratio Δp/D = G/(ΔtD·G′)
        var best = [], d = derivs;
        for (var i = 0; i < d.G.length; i++) {
            if (!d.usable[i] || d.D[i] === null || !(d.G[i] <= d.earlyWin[1])) continue;
            best.push(d.p[i] + d.D[i] * d.G[i] / (d.dtD[i] * d.Gp[i]));
        }
        var ib = _median(best);
        var llOk = _fin(ib) ? Math.abs(ib - rec.value) <= Math.max(10, 2 * rec.spread, 3 * sigma) : false;
        if (_fin(ib) && !llOk) rec.why.push('The log-log check prefers ' + _f0(ib) + ' psia: early Δp and D do not keep the reference ratio.');
        cands.forEach(function (c) { c.value = _r(c.value, 2); c.se = _r(c.se, 3); });
        return { ok: true, value: _r(rec.value, 2), spread: _r(rec.spread, 2), confidence: rec.confidence, why: rec.why.map(_txt), candidates: cands,
                 loglogCheck: { isipBest: _r(ib, 2), ok: llOk }, ev: ['I1'] };
    });
    G.PRiSM_dfit_isip.reconcile = function (cands, o) { var r = _reconcile(cands || [], o); return r ? { value: r.value, spread: r.spread, confidence: r.confidence, why: r.why } : null; };

    // ═════════════════════════════════════════════════════════════════════
    // §4.7 G-domain forward model of the variable-compliance fit (also the test-signal generator)
    //   dp/dG = −K·f_L(p)·M(p) / C_sys(p),  C_sys(p) = A_f·c_f·c(p)/c_f0 + V_w·c_w(p),  p(0) = ISIP
    //   c(p)/c_f0: 1 above σ_c (× the height-recession factor when hrStep is set); below (x = σ_c − p):
    //     'hyp' (s_h/(s_h + x))², 'exp' f_res·e^(−x/s_r) + (1 − f_res)·e^(−x/s_c) (s_r null = no decay of the residual)
    //   f_L = 1 above σ_c, (p − p_r)/(σ_c − p_r) below; M: fissure PDL e^(C_d·(p − p_fo)) above p_fo (≤ 50), matrix
    //   [(p − p_r)/(ISIP − p_r)]^nMat; tip extension C × (1 + tipA·G); gas wellbore V_w·c_w·[(1 − φ_g) + φ_g·ISIP/p].
    //   params also take AfCf (default 1 − VwCw when absent) and sh (hyp scale, default sc).
    // ═════════════════════════════════════════════════════════════════════
    function _vcNorm(P) {
        var VwCw = _fin(P.VwCw) ? P.VwCw : 0;
        return {
            isip: P.isip, K: P.K, sigmaC: P.sigmaC, law: P.law === 'hyp' ? 1 : (P.law === 'none' ? 2 : 0),
            sh: _fin(P.sh) ? P.sh : (_fin(P.sc) ? P.sc : 100), sc: _fin(P.sc) && P.sc > 0 ? P.sc : 100, fres: _fin(P.fres) ? P.fres : 0.1,
            sr: _fin(P.sr) && P.sr > 0 ? P.sr : 0, hr: _fin(P.hrStep) && P.hrStep > 0 ? P.hrStep : 0, hrFrac: _fin(P.hrFrac) ? P.hrFrac : 0.5,
            gas: P.cwOfP === 'gas', phiGas: _fin(P.phiGas) ? P.phiGas : 0.5, VwCw: VwCw, AfCf: _fin(P.AfCf) ? P.AfCf : Math.max(1e-9, 1 - VwCw),
            tipA: _fin(P.tipA) && P.tipA > 0 ? P.tipA : 0, pr: _fin(P.pr) ? P.pr : 0, Cd: _fin(P.Cd) && P.Cd > 0 && _fin(P.pfo) ? P.Cd : 0, pfo: P.pfo,
            fmax: _fin(P.fmax) ? P.fmax : 50, nMat: _fin(P.nMat) && P.nMat > 0 ? P.nMat : 0
        };
    }
    function _vcRate(p, Gv, Q) {
        var x = Q.sigmaC - p, c = 1;
        if (x > 0) {
            if (Q.law === 1) { var r = Q.sh / (Q.sh + x); c = r * r; }
            else if (Q.law === 0) c = Q.fres * (Q.sr ? Math.exp(-x / Q.sr) : 1) + (1 - Q.fres) * Math.exp(-x / Q.sc);
        }
        if (Q.hr) { var pHr = Q.sigmaC + Q.hr; if (p < pHr) c *= 1 - Q.hrFrac * Math.min(1, (pHr - p) / Q.hr); }
        var cw = Q.gas ? Q.VwCw * ((1 - Q.phiGas) + Q.phiGas * Q.isip / Math.max(p, 1)) : Q.VwCw;
        var C = Q.AfCf * c * (Q.tipA ? 1 + Q.tipA * Gv : 1) + cw;
        var fL = x > 0 ? Math.max(0, (p - Q.pr) / Math.max(Q.sigmaC - Q.pr, 1e-9)) : 1;
        var M = 1;
        if (Q.Cd && p > Q.pfo) M = Math.min(Q.fmax, Math.exp(Q.Cd * (p - Q.pfo)));
        if (Q.nMat) M *= Math.pow(Math.max(0, (p - Q.pr) / Math.max(Q.isip - Q.pr, 1e-9)), Q.nMat);
        return -Q.K * fL * M / Math.max(C, 1e-12);
    }
    function _vcIntegrate(Garr, P, maxStep) {
        var Q = _vcNorm(P), out = new Array(Garr.length), g = 0, p = Q.isip, h0 = maxStep || 0.02;
        for (var i = 0; i < Garr.length; i++) {
            var gT = Garr[i];
            if (typeof gT !== 'number' || !isFinite(gT) || gT < g) { out[i] = p; continue; }
            var span = gT - g, ns = Math.max(1, Math.ceil(span / h0)), h = span / ns;
            for (var s = 0; s < ns; s++) {
                var k1 = _vcRate(p, g, Q), k2 = _vcRate(p + 0.5 * h * k1, g + 0.5 * h, Q), k3 = _vcRate(p + 0.5 * h * k2, g + 0.5 * h, Q), k4 = _vcRate(p + h * k3, g + h, Q);
                p += h / 6 * (k1 + 2 * k2 + 2 * k3 + k4); g += h;
            }
            out[i] = p;
        }
        return out;
    }
    G.PRiSM_dfit_vcModel = _safe(function (Garr, params, ctx) {
        if (!Array.isArray(Garr) || !_isObj2(params) || !_fin(params.isip) || !_fin(params.K) || !_fin(params.sigmaC)) return _fail('BAD_INPUT', 'vcModel needs a G grid and params isip, K, sigmaC.', ['params']);
        var step = ctx && _fin(ctx.maxStep) && ctx.maxStep > 0 ? ctx.maxStep : 0.02;
        return _vcIntegrate(Garr, params, step);
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.7 closure picks
    // ═════════════════════════════════════════════════════════════════════
    function _movMed(a, w) {
        var n = a.length, out = new Array(n), h = w >> 1, buf = new Array(w), i, j, k, m;
        for (i = 0; i < n; i++) {
            m = 0;
            for (j = (i - h > 0 ? i - h : 0); j <= (i + h < n - 1 ? i + h : n - 1); j++) {
                var x = a[j];
                if (typeof x !== 'number' || x !== x || x === INF || x === -INF) continue;
                k = m++; while (k > 0 && buf[k - 1] > x) { buf[k] = buf[k - 1]; k--; } buf[k] = x;     // insertion sort
            }
            out[i] = m ? (m % 2 ? buf[m >> 1] : 0.5 * (buf[(m >> 1) - 1] + buf[m >> 1])) : NaN;
        }
        return out;
    }
    // the usable falloff as compact arrays (masked / windowless samples out: no null reaches a numeric routine)
    function _usableView(d) {
        var v = { i: [], G: [], y: [], s: [], p: [], dt: [], dtD: [], D: [], Dref: [], sd: [] };
        for (var i = 0; i < d.G.length; i++) {
            if (!d.usable[i] || d.GdPdG[i] === null || d.dPdG[i] === null) continue;
            v.i.push(i); v.G.push(d.G[i]); v.y.push(d.GdPdG[i]); v.s.push(d.dPdG[i]); v.p.push(d.p[i]); v.dt.push(d.dt[i]); v.dtD.push(d.dtD[i]);
            v.D.push(d.D[i]); v.Dref.push(d.Dref[i]); v.sd.push(d.dPds[i]);
        }
        return v;
    }
    // PDL hump (§4.11 H): dP/dG above the early-line slope b at the start, returning to it before the straight segment
    // → {iEnd (first index back within ε), H (max relative excess of G·dP/dG over b·G), returns, s: b, span (in G)}
    function _hump(v, sm, b, e0, eps) {
        var n = v.G.length, i0 = -1, iE = -1, j;
        if (n < 8 || !(b > 0)) return null;
        for (j = 0; j < Math.min(n, e0 + 2); j++) {
            if (sm[j] > (1 + eps) * b) { if (i0 < 0) i0 = j; iE = j; }
            else if (i0 >= 0 && j > iE + 2) break;
        }
        if (i0 < 0 || i0 > 3) return null;
        var H = 0;
        for (j = i0; j <= iE; j++) H = Math.max(H, (v.y[j] - b * v.G[j]) / (b * v.G[j]));
        var span = v.G[iE] - v.G[i0], ret = false, jr = -1;
        for (j = iE + 1; j < Math.min(n, iE + 10); j++) if (sm[j] <= (1 + eps) * b) { jr = j; break; }
        if (jr >= 0) {
            var jp = jr; while (jp + 1 < n && Math.abs(sm[jp + 1] - b) <= eps * b) jp++;
            ret = Math.log(v.G[jp] / v.G[jr]) >= 0.3;
        }
        if (!(H > 0.05 && span >= 0.3)) return null;
        return { iEnd: Math.min(n - 1, iE + 1), H: H, returns: ret, s: b, span: span };
    }
    // ι = a/(b·G_c) of y = a + bG over the lower 60 % of W
    function _iota(v, iA, iC) {
        if (iC - iA < 4) return 0;
        var gA = v.G[iA], gC = v.G[iC], gCut = gA + 0.6 * (gC - gA), i1 = iA;
        while (i1 + 1 <= iC && v.G[i1 + 1] <= gCut) i1++;
        var lf = _linfit(v.G, v.y, iA, Math.max(i1, iA + 3), false);
        if (!lf || !(lf.b > 0)) return 0;
        return lf.a / (lf.b * gC);
    }
    function _pick(method, family, v, k, o) {
        var d = o.derivs;
        return {
            method: method, family: family, vote: !!o.vote, ok: true, dt: _r(o.dt != null ? o.dt : v.dt[k], 6), G: _r(o.G != null ? o.G : v.G[k], 4),
            p: _r(o.p != null ? o.p : v.p[k], 2), band: o.band || null, se: _r(_fin(o.se) ? o.se : Math.max(d.sigma, 0.5), 3),
            window: o.window || [_r(d.gMin, 4), _r(v.G[v.G.length - 1], 4)], admissible: true, vetoes: [], warnings: [],
            sameEvidenceAs: o.same || null, upperSide: !!o.upperSide, evidence: [{ text: _txt(o.text), ev: [o.ev] }], ev: [o.ev]
        };
    }
    // the falloff pressure at G (linear in G between samples)
    function _pAtG(d, Gv) {
        var g = d.G, p = d.p;
        if (Gv <= g[0]) return p[0];
        for (var i = 1; i < g.length; i++) if (g[i] >= Gv) { var f = (Gv - g[i - 1]) / (g[i] - g[i - 1]); return p[i - 1] + f * (p[i] - p[i - 1]); }
        return p[p.length - 1];
    }
    function _dtAtG(d, Gv) { return _GinvD(d, Gv) * d.tp; }
    // the closed-form methods on one Derivs (shared by closurePicks and the stability grid)
    // a copy of a Derivs on another Bourdet window (the pick window; display arrays keep the user's L)
    function _rederive(d, Lp) {
        var c = {}, k, n = d.G.length, i;
        for (k in d) c[k] = d[k];
        var y = _bourdet(d.G, d.dpIsip, Lp), Dd = _bourdet(d.dt, d.dpIsip, Lp);
        c.GdPdG = new Array(n); c.dPdG = new Array(n); c.D = new Array(n); c.dPds = new Array(n); c.usable = new Array(n);
        for (i = 0; i < n; i++) {
            c.GdPdG[i] = _fin(y[i]) ? Math.max(0, y[i]) : null;
            c.dPdG[i] = _fin(y[i]) ? Math.max(0, y[i] / d.G[i]) : null;
            c.D[i] = _fin(Dd[i]) ? Math.max(0, Dd[i]) : null;
            c.dPds[i] = _fin(Dd[i]) ? Math.max(0, 2 * Dd[i] / Math.sqrt(d.dt[i])) : null;
            c.usable[i] = (d.G[i] >= d.gMin && c.GdPdG[i] !== null) ? 1 : 0;
        }
        var yu = []; for (i = 0; i < n; i++) if (c.usable[i]) yu.push(c.GdPdG[i]);
        c.sigmaY = _noise2(yu); c.Lpick = Lp;
        return c;
    }
    // noise-limited pick window: the smallest L in {0, 0.01, 0.02, 0.05} (≤ the user's L) whose dP/dG noise over the upper
    // part of the early straight segment stays ≤ 0.5 %; else the user's L. Smoothing only as far as the noise needs it
    // keeps the Bourdet window from shifting the picks on clean data.
    function _pickWindow(d) {
        var ge = d.earlyWin ? d.earlyWin[1] : null;
        if (!_fin(ge) || ge <= 0) return null;
        var cands = [0, 0.01, 0.02, 0.05], gLo = Math.max(d.gMin, 0.1 * ge), a0 = 0, a1 = d.G.length - 1;
        // the derivative only on the tested segment (with a margin wider than the largest candidate window)
        while (a0 < a1 && d.G[a0] < gLo * Math.exp(-0.06)) a0++;
        while (a1 > a0 && d.G[a1] > ge * Math.exp(0.06)) a1--;
        var gs = d.G.slice(a0, a1 + 1), ps = d.dpIsip.slice(a0, a1 + 1);
        for (var c = 0; c < cands.length; c++) {
            var Lp = cands[c];
            if (Lp >= d.L) break;
            var y = _bourdet(gs, ps, Lp), r = [];
            for (var i = 0; i < gs.length; i++) if (gs[i] >= gLo && gs[i] <= ge && _fin(y[i])) r.push(y[i] / gs[i]);
            if (r.length < 8) continue;
            var md = _median(r), nz = _noise2(r);
            if (md > 0 && nz / md <= 0.005) return Lp;
        }
        return null;
    }
    function _closedForm(d0, o) {
        o = o || {};
        var Lp = _fin(o.Lpick) ? o.Lpick : _pickWindow(d0), d = (Lp !== null && Lp < d0.L) ? _rederive(d0, Lp) : d0;
        var eps = o.eps || {}, epsC = _fin(eps.compliance) ? eps.compliance : 0.02, epsT = _fin(eps.tangent) ? eps.tangent : 0.02, epsL = _fin(eps.loglog) ? eps.loglog : 0.05;
        var v = _usableView(d), n = v.G.length, res = { picks: {}, iota: 0, hump: null, view: v, Lpick: d.Lpick != null ? d.Lpick : d0.L, line: null, noDeparture: false };
        if (n < 6) return res;
        var Lw = _fin(d.Lpick) ? d.Lpick : d.L, i, j;
        // 1. the early window (from the straight p-G segment), trimmed by the pick window at its end
        var gE0 = d.earlyWin ? d.earlyWin[0] : v.G[0], gE1 = d.earlyWin ? d.earlyWin[1] : v.G[n - 1];
        var e0 = 0; while (e0 < n && v.G[e0] < gE0) e0++;
        if (e0 > n - 4) return res;
        var e1 = e0; while (e1 + 1 < n && v.G[e1 + 1] <= gE1 * Math.exp(-Lw)) e1++;
        if (e1 - e0 < 3) e1 = Math.min(n - 1, e0 + 3);
        // 2. the G·dP/dG line over the early window: through the origin when |ι| < 0.05; one robust refit
        var lf = _yLineRobust(v.G, v.y, e0, e1, epsC);
        if (!lf) return res;
        var iota0 = lf.iota, origin = lf.origin, b = lf.b;
        res.line = lf; res.iota = iota0;
        // absolute G·dP/dG noise (≈ constant in G) and its lag-1 correlation over the upper early window; the relative
        // noise at a sample is σ_y/ŷ there (res.relNoise is its value at the window end)
        var nz = _lineNoise(v.G, v.y, lf, e0, e1), sigY = Math.max(nz.sigma, 1e-9), rhoY = nz.rho;
        function yh(k) { return lf.a + lf.b * v.G[k]; }
        var relN = sigY / Math.max(yh(e1), 1e-9); res.relNoise = relN; res.sigmaY = sigY; res.rhoY = rhoY;
        var sm = _movMed(v.s, 5);
        // 3. PDL hump before the early window: dP/dG above (1 + ε)·b at the start, returning to b
        var hump = _hump(v, sm, b, e0, Math.max(epsC, 0.02));
        res.hump = hump;
        // 4. the first held departure from the line, searched from the window start (ε the floor, the local noise the scale)
        // (from the first sample whose derivative window lies inside the early segment)
        var eS = e0 + 1; while (eS < e1 && v.G[eS] < v.G[e0] * Math.exp(Lw + 0.02)) eS++;
        var dep = _departure(v.G, v.y, lf, eS, epsC, sigY, rhoY);
        if (!dep) { res.noDeparture = true; return res; }
        var iDep = dep.i, down = dep.down, thrAt = dep.thr;
        // 4b. a downward first departure followed by a strong stiffening is reservoir-controlled (matrix) leak-off, not a
        //     closure: dP/dG declines smoothly as p − p_r falls (§4.11: 28-40 % to closure) and the closure is the later upward
        //     departure from that declining trend. The trend is the straight G·dP/dG line over the last 0.7 ln units before the
        //     dP/dG minimum; the search for the upward departure starts one Bourdet window L before that minimum.
        if (down) {
            var iMx = iDep, iMn = iDep;
            for (i = iDep; i < n; i++) if (_fin(sm[i]) && sm[i] > sm[iMx]) iMx = i;
            for (i = iDep; i <= iMx; i++) if (_fin(sm[i]) && sm[i] < sm[iMn]) iMn = i;
            if (iMx - iMn >= 3 && sm[iMx] >= 1.3 * sm[iMn] && sm[iMn] < (1 - thrAt(iMn)) * b) {
                var kT = function (gv) { var k = 0; while (k + 1 < n && v.G[k + 1] <= gv) k++; return k; };
                var w0 = Math.max(e0, kT(v.G[iMn] * Math.exp(-0.7))), lf2 = (iMn - w0 >= 4) ? _linfit(v.G, v.y, w0, iMn, false) : null;
                if (lf2 && lf2.b > 0) {
                    lf2.iota = lf.iota; lf2.origin = false;
                    var nz2 = _lineNoise(v.G, v.y, lf2, w0, iMn), q2s = Math.max(w0 + 1, kT(v.G[iMn] * Math.exp(-Lw))), dep2 = null;
                    for (var tries = 0; tries < 6 && q2s < n - 3; tries++) {
                        var dd2 = _departure(v.G, v.y, lf2, q2s, epsC, Math.max(nz2.sigma, sigY * 0.5, 1e-9), nz2.rho);
                        if (!dd2) break;
                        if (!dd2.down) { dep2 = dd2; break; }
                        q2s = dd2.i + 1;
                    }
                    if (dep2) {
                        dep = dep2; iDep = dep2.i; down = false; thrAt = dep2.thr; lf = lf2;
                        res.matrixDecline = { gMin: _r(v.G[iMn], 3), drop: _r(1 - sm[iMn] / b, 3), trend: [_r(v.G[w0], 3), _r(v.G[iMn], 3)] };
                    }
                }
            }
        }
        // 5. the onset by the hinge fit on the pressure: from ln 0.7 before the departure (inside the early window) to where
        //    the derivative has moved by max(15 %, 2 thresholds) or ln 0.4 after it. A Bourdet window L shows a departure up
        //    to L early (the derivative at G sees G·e^L), so the onset is searched up to G_dep·e^L and the derivative
        //    criterion of the window end is read L back.
        function kAt(gv) { var k = 0; while (k + 1 < n && v.G[k + 1] <= gv) k++; return k; }
        var h0 = e0; while (h0 < iDep && v.G[h0] < v.G[iDep] * Math.exp(-0.7)) h0++;
        var jMax = Math.max(iDep, kAt(v.G[iDep] * Math.exp(Lw))), h1 = jMax, gH = v.G[iDep] * Math.exp(0.4 + Lw);
        while (h1 + 1 < n && v.G[h1 + 1] <= gH && Math.abs(dep.rel(kAt(v.G[h1 + 1] * Math.exp(-Lw)))) <= Math.max(0.15, 2 * thrAt(h1))) h1++;
        h1 = Math.min(n - 1, Math.max(h1, jMax + 4));
        var hg = _hinge(v.G, v.p, h0, h1, jMax, down ? 1 : -1, !!res.matrixDecline);
        if (hg && !(hg.G >= v.G[h0] && hg.G <= v.G[jMax])) hg = null;
        // an abrupt break (a pressure interval falling ≥ 3 × faster than the early slope while the interval before it falls
        // less than half as fast: a closure with an unbounded slope, as on an exact Carter after-closure line) is read at the start of
        // that interval; neither the hinge shape nor a derivative peak can locate a jump between two samples
        var brk = null;
        if (!down) {
            var sl = function (k) { return (v.p[k] - v.p[k + 1]) / Math.max(v.G[k + 1] - v.G[k], 1e-12); }, kb = -1;
            for (i = Math.max(e0, iDep - 2); i <= Math.min(n - 2, jMax + 1); i++) if (kb < 0 || sl(i) > sl(kb)) kb = i;
            // the break starts in the first of the steep intervals: walk back from the steepest one while the interval before
            // it still falls ≥ 3 × faster than the early slope (on an exact Carter line the slope keeps growing for a few samples
            // after closure, so the steepest interval is not the one that holds the closure)
            while (kb > Math.max(e0, 1) && sl(kb - 1) > 3 * b) kb--;
            // the closure lies inside that interval, uniformly as far as the samples tell: its centre on the pre-closure line
            // (p at the interval start minus the slope of the interval before it over half the interval), se = half-width / √3
            if (kb > 0 && kb < n - 2 && sl(kb) > 3 * b && sl(kb - 1) < 0.5 * sl(kb)) {
                var dGb = v.G[kb + 1] - v.G[kb], sPre = Math.max(0, sl(kb - 1));
                brk = { k: kb, G: v.G[kb] + 0.5 * dGb, p: v.p[kb] - 0.5 * sPre * dGb, se: Math.max(sPre, b) * dGb / (2 * Math.sqrt(3)) };
            }
        }
        res.abrupt = !!brk;
        if (!down) {
            var gOn = v.G[iDep], pOn = v.p[iDep], kOn = iDep, seOn = null;
            if (brk) { gOn = brk.G; pOn = brk.p; kOn = brk.k; seOn = brk.se; }
            else if (hg) { gOn = hg.G; pOn = hg.p; kOn = kAt(gOn); seOn = hg.se; }
            res.picks.compliance = { k: kOn, G: gOn, p: pOn, se: seOn, down: false, line: lf, departRel: dep.rel(iDep), hinge: hg,
                text: 'G·dP/dG leaves the early ' + (origin ? 'line through the origin' : 'straight line') + ' upward at G ' + _f1(gOn, 2) + ' (ε ' + _f1(epsC, 3) + ').' };
        }
        // 6. tangent through the origin. After an upward departure: s* = max dP/dG and the touch point is where y/G is largest,
        //    i.e. the vertex of a concave quadratic (ln G) fitted to dP/dG where it stays within (1 − δ)·s*,
        //    δ = max(ε_tangent, 3σ_s/s*) (§4.7: ε the floor, the noise the scale). The vertex is read on a derivative with a
        //    short window (L ≤ 0.02): a long Bourdet window drags an asymmetric peak late. A flat top longer than 0.5 ln
        //    units keeps the §4.7 plateau-end rule. After a downward departure the compliance and tangent picks coincide at
        //    the onset of the decline (the hinge).
        var tg = null;
        if (!down) {
            var cs = sm, iPk = iDep;
            for (i = iDep; i < n; i++) if (cs[i] > cs[iPk]) iPk = i;
            if (iPk < n - 2) {
                // the vertex window: the smallest L in {0, 0.01, 0.02} (≤ the pick L) whose dP/dG noise near the peak is
                // ≤ 0.3 % of s* — the vertex is read as unsmoothed as the noise allows, whatever the detection window L
                var Lv = Math.min(Lw, 0.02), sv = v.s, csv = relN < 0.005 ? v.s : cs, LvC = [0, 0.01, 0.02];
                // the short-window derivative only around the peak (± 80 samples; L ≤ 0.02 needs a few), mapped back
                var b0 = Math.max(0, iPk - 80), b1 = Math.min(n - 1, iPk + 80), gS = v.G.slice(b0, b1 + 1), nS = v.p.slice(b0, b1 + 1).map(function (x) { return -x; });
                for (var lc = 0; lc < LvC.length; lc++) {
                    var Lc = LvC[lc]; if (Lc >= Lw) break;
                    var ycS = _bourdet(gS, nS, Lc), sc = new Array(n);
                    for (var kk = 0; kk < n; kk++) sc[kk] = NaN;
                    for (kk = 0; kk < ycS.length; kk++) sc[b0 + kk] = _fin(ycS[kk]) ? Math.max(0, ycS[kk] / gS[kk]) : NaN;
                    var w0 = Math.max(0, iPk - 15), w1 = Math.min(n - 1, iPk + 15), nzc = _noise2(sc, w0, w1);
                    if (lc === LvC.length - 1 || (cs[iPk] > 0 && nzc / cs[iPk] <= 0.003)) {
                        Lv = Lc; sv = sc;
                        if (Lc === 0 && nzc / cs[iPk] <= 0.0005) csv = sc;
                        else { csv = new Array(n); var mS = _movMed(sc.slice(b0, b1 + 1), 5); for (kk = 0; kk < n; kk++) csv[kk] = NaN; for (kk = 0; kk < mS.length; kk++) csv[b0 + kk] = mS[kk]; }
                        break;
                    }
                }
                // the short-window peak near the smoothed one (the long window moves it later, never earlier by more than L)
                var q0 = kAt(v.G[iPk] * Math.exp(-Lw - 0.05)), q1 = kAt(v.G[iPk] * Math.exp(0.05)), jPk = iPk;
                for (i = Math.max(iDep, q0); i <= q1; i++) if (_fin(csv[i]) && (!_fin(csv[jPk]) || csv[i] > csv[jPk])) jPk = i;
                var sStar = _fin(csv[jPk]) ? csv[jPk] : cs[iPk], sigS = sigY * (Lv > 0 && Lw > Lv ? Lw / Lv : 1);
                var dl = function (k) { return Math.max(epsT, 3 * dep.c * sigS / Math.max(sStar * v.G[k], 1e-9)); };
                var k0 = jPk, k1 = jPk, dips = 0;
                while (k0 - 1 > iDep && _fin(csv[k0 - 1]) && csv[k0 - 1] >= (1 - dl(k0 - 1)) * sStar) k0--;
                for (j = jPk + 1; j < n; j++) { if (_fin(csv[j]) && csv[j] >= (1 - dl(j)) * sStar) { k1 = j; dips = 0; } else if (++dips > 2) break; }
                var gT = v.G[jPk], pT = v.p[jPk], sPk = sStar, vx = null, seT = null;
                if (brk && Math.abs(Math.log(v.G[jPk] / brk.G)) <= Lw + Lv + 0.03) { gT = brk.G; pT = brk.p; seT = brk.se; }     // the peak is the break itself (within the derivative windows)
                else if (Math.log(v.G[k1] / v.G[k0]) > 0.5) {                 // a plateau: its end (§4.7)
                    gT = v.G[k1]; pT = v.p[k1];
                    if (k1 + 1 < n && csv[k1] > csv[k1 + 1]) {
                        var f = _clampN((csv[k1] - (1 - dl(k1)) * sStar) / (csv[k1] - csv[k1 + 1]), 0, 1);
                        gT = v.G[k1] + f * (v.G[k1 + 1] - v.G[k1]); pT = v.p[k1] + f * (v.p[k1 + 1] - v.p[k1]);
                    }
                } else {
                    // at least ±1 sample (±3 when the derivative noise is above 0.2 %) around the peak; raw short-window values
                    var hw = (sigS / Math.max(sStar * v.G[jPk], 1e-9) > 0.002) ? 2 : 1;
                    var r0 = Math.max(iDep, Math.min(k0, jPk - hw)), r1 = Math.min(n - 1, Math.max(k1, jPk + hw));
                    vx = _vertex(v.G, sv, r0, r1) || _vertex(v.G, csv, Math.max(0, jPk - 1), Math.min(n - 1, jPk + 1));
                    if (vx) { gT = vx.G; pT = _pAtG(d, gT); sPk = Math.max(sStar, vx.s); seT = _fin(vx.seLn) ? sPk * gT * vx.seLn : null; }
                }
                tg = { k: kAt(gT), G: gT, p: pT, se: seT, sStar: sPk, iPk: jPk, noise: sigS / Math.max(sPk * gT, 1e-9), tol: dl(kAt(gT)) };
            } else res.noDeparture = true;     // still stiffening at the end of the data
        } else {
            var gP = null, pP = null, kP = iDep, seP = null;
            if (hg) { gP = hg.G; pP = hg.p; kP = kAt(gP); seP = hg.se; }
            else {                                   // the plateau end with the §4.7 tolerance (no hinge)
                var iP = e0 + 1, dps = 0;
                for (j = e0 + 1; j < n; j++) { if (sm[j] >= (1 - thrAt(j)) * b) { iP = j; dps = 0; } else if (++dps > 2) break; }
                if (iP < n - 2) { gP = v.G[iP]; pP = v.p[iP]; kP = iP; }
            }
            if (gP !== null) {
                tg = { k: kP, G: gP, p: pP, se: seP, sStar: b, iPk: kP, noise: sigY / Math.max(b * gP, 1e-9), tol: thrAt(kP) };
                res.picks.compliance = { k: kP, G: gP, p: pP, se: seP, down: true, line: lf, departRel: 0, hinge: hg,
                    text: 'G·dP/dG first leaves the early line downward, so the compliance and tangent picks coincide at G ' + _f1(gP, 2) + '.' };
            } else res.noDeparture = true;
        }
        // the pre-refinement detection pressure (the departure sample), read by the stability grid: the hinge / vertex refinement
        // re-reads one pressure for every L / tp setting, so the grid spread g measured no sensitivity at all
        // (an abrupt break is exact — the detection sample then already lies after the jump — so it keeps its reading)
        if (res.picks.compliance) res.picks.compliance.pRaw = res.abrupt ? res.picks.compliance.p : v.p[iDep];
        if (tg) {
            tg.pRaw = res.abrupt ? tg.p : (_fin(tg.iPk) && tg.iPk >= 0 && tg.iPk < n ? v.p[tg.iPk] : v.p[iDep]);
            tg.text = 'The tangent through the origin touches G·dP/dG up to G ' + _f1(tg.G, 2) + ' (largest dP/dG ' + _f1(tg.sStar, 2) + ' psi per unit G).';
            res.picks.tangent = tg;
            // dependent F2 members: the dP/dG maximum and the √t inflection (smoothed, vertex-refined), searched after the
            // early window up to 1.5 × G_tangent
            var iM = -1, iS2 = -1, gLim = 1.5 * tg.G, q2 = Math.max(e1, 0), q3 = q2; while (q3 + 1 < n && v.G[q3 + 1] <= gLim) q3++;
            var smd = new Array(n), smdS = _movMed(v.sd.slice(Math.max(0, q2 - 3), Math.min(n, q3 + 4)), 5);
            for (i = 0; i < smdS.length; i++) smd[Math.max(0, q2 - 3) + i] = smdS[i];
            for (i = q2; i < n && v.G[i] <= gLim; i++) {
                if (_fin(sm[i]) && (iM < 0 || sm[i] > sm[iM])) iM = i;
                if (_fin(smd[i]) && (iS2 < 0 || smd[i] > smd[iS2])) iS2 = i;
            }
            if (iM >= 0) {
                var vm = (iM > 0 && iM < n - 1) ? _vertex(v.G, sm, iM - 1, iM + 1) : null, gM = vm ? vm.G : v.G[iM];
                res.picks.maxdpdg = { k: iM, G: gM, p: vm ? _pAtG(d, gM) : v.p[iM], text: 'dP/dG is largest at G ' + _f1(gM, 2) + '.' };
            }
            if (iS2 >= 0) {
                var vs = (iS2 > 0 && iS2 < n - 1) ? _vertex(v.dt, smd, iS2 - 1, iS2 + 1) : null, gS = vs ? _GatD(d, vs.G / d.tp) : v.G[iS2];
                res.picks.sqrt = { k: iS2, G: gS, p: vs ? _pAtG(d, gS) : v.p[iS2], text: 'The square-root-of-time derivative is largest at √Δt ' + _f1(Math.sqrt((vs ? vs.G : v.dt[iS2]) * 60), 2) + ' min^½.' };
            }
        }
        // crel (same evidence as compliance): the first p where C_rel = b/(dP/dG) < 1 − max(ε, local noise) for the hold count
        if (res.picks.compliance && !down) {
            for (i = Math.max(e0 + 1, e1 < iDep ? e1 : iDep); i < n; i++) {
                if (b / Math.max(sm[i], 1e-12) < 1 - thrAt(i)) {
                    var h2 = 0; for (j = i; j < n && b / Math.max(sm[j], 1e-12) < 1 - thrAt(j); j++) h2++;
                    if (h2 >= Math.max(3, dep.nHold) || j === n) { res.picks.crel = { k: i, G: v.G[i], p: v.p[i], text: 'The relative compliance falls below ' + _f1(1 - epsC, 3) + ' at ' + _f0(v.p[i]) + ' psia.' }; break; }
                }
            }
        }
        // log-log departure: D/D_ref > 1 + ε_ll held ≥ 0.1 log cycle on Δt
        for (i = Math.max(e0, e1 - 3); i < n; i++) {
            if (!_fin(v.D[i]) || !_fin(v.Dref[i]) || v.Dref[i] <= 0) continue;
            if (v.D[i] / v.Dref[i] > 1 + epsL) {
                var ok2 = true, j2;
                for (j2 = i; j2 < n && Math.log(v.dt[j2] / v.dt[i]) / LN10 < 0.1; j2++) if (!(v.D[j2] / v.Dref[j2] > 1 + epsL)) { ok2 = false; break; }
                if (ok2 && j2 < n) { res.picks.loglog = { k: i, G: v.G[i], p: v.p[i], text: 'D leaves the reference curve upward (D/D_ref above ' + _f1(1 + epsL, 2) + ') at Δt ' + _f1(v.dt[i] * 60, 1) + ' min.' }; break; }
            }
        }
        // fissure (F0): the end of the PDL hump = p_fo
        if (hump) res.picks.fissure = { k: hump.iEnd, G: v.G[hump.iEnd], p: v.p[hump.iEnd], text: 'The PDL hump ends at G ' + _f1(v.G[hump.iEnd], 2) + ': fissure opening pressure about ' + _f0(v.p[hump.iEnd]) + ' psia.' };
        return res;
    }
    G.PRiSM_dfit_closedForm = function (derivs, o) { return _closedForm(derivs, o || {}); };   // the raw closed-form readings (tests, 57)
    // ClosurePick list from the closed-form result + ramps, a leak-off fit, the variable-compliance fit and a user pick
    function _bctx(ctx) { return { isip: ctx.isipValue, pi: ctx.pi, piBracket: ctx.piBracket, inputs: ctx.inputs, well: ctx.well, datumTvd: ctx.inputs ? ctx.inputs.datumTvd : null }; }
    G.PRiSM_dfit_closurePicks = _safe(function (derivs, ctx) {
        ctx = ctx || {};
        if (!_okRes(derivs) || !Array.isArray(derivs.G)) return _fail('BAD_INPUT', 'Derivatives are needed for the closure picks.', ['derivs']);
        var I = ctx.inputs ? G.PRiSM_dfit_inputRanges.clamp(ctx.inputs).inputs : G.PRiSM_dfit_inputRanges.defaults();
        var eps = ctx.eps || I.options.eps, d = derivs;
        var cf = _closedForm(d, { eps: eps }), P = cf.picks, v = cf.view, out = [];
        var ov = { derivs: d };
        function mk(m, fam, src, o) { var oo = {}; for (var k in ov) oo[k] = ov[k]; for (k in o) oo[k] = o[k]; oo.G = src.G; oo.p = src.p; oo.dt = _dtAtG(d, src.G); oo.text = src.text; return _pick(m, fam, v, src.k, oo); }
        var dtDcT = P.tangent ? _dtAtG(d, P.tangent.G) / d.tp : null;
        var seOf = function (src) { return Math.max(d.sigma, 0.5, _fin(src.se) ? src.se : 0); };
        if (P.compliance) out.push(mk('compliance', 'F1', P.compliance, { vote: true, ev: 'C2', se: seOf(P.compliance) }));
        if (P.crel) out.push(mk('crel', 'F1', P.crel, { vote: false, same: 'compliance', ev: 'C6' }));
        if (P.loglog) {
            var indep = Math.abs(cf.iota) >= 0.05;
            out.push(mk('loglog', 'F1', P.loglog, { vote: indep, same: indep ? null : 'compliance', ev: 'C7' }));
            if (!indep) out[out.length - 1].evidence.push({ text: _txt('iota ' + _f1(cf.iota, 3) + ' is below 0.05: the log-log departure is the compliance test with another ε (same evidence).'), ev: ['C7'] });
        }
        if (P.tangent) out.push(mk('tangent', 'F2', P.tangent, { vote: true, ev: 'C3', se: seOf(P.tangent) }));
        if (P.sqrt) out.push(mk('sqrt', 'F2', P.sqrt, { vote: false, same: (dtDcT !== null && dtDcT > 5) ? 'tangent' : null, ev: 'C4' }));
        if (P.maxdpdg) out.push(mk('maxdpdg', 'F2', P.maxdpdg, { vote: false, same: 'tangent', ev: 'C5' }));
        if (P.fissure) out.push(mk('fissure', 'F0', P.fissure, { vote: false, ev: 'C10' }));
        // F3: variable-compliance fit (cross-check, own LM CI) and the leak-off model closure
        if (ctx.varcomp !== false && P.tangent) {
            var vc = G.PRiSM_dfit_varComplianceFit(d, { picks: P, VwCw: ctx.VwCw, Csys: ctx.Csys, AfCf: ctx.AfCf, pr: ctx.pr, inputs: I }, ctx.varcompOpts || {});
            if (_okRes(vc) && _fin(vc.sigmaC)) {
                var se = vc.ci95 ? Math.abs(vc.ci95[1] - vc.ci95[0]) / (2 * 1.96) : Math.max(d.sigma, 1);
                var gV = _GatD(d, (_dtAtP(d, vc.sigmaC) || d.dt[d.dt.length - 1]) / d.tp);
                out.push(_pick('varcomp', 'F3', v, 0, { derivs: d, vote: false, ev: 'C8', p: vc.sigmaC, G: gV, dt: _dtAtP(d, vc.sigmaC) || d.dt[d.dt.length - 1],
                    band: { p10: _r(vc.sigmaC - 1.2816 * se, 2), p50: _r(vc.sigmaC, 2), p90: _r(vc.sigmaC + 1.2816 * se, 2) }, se: se,
                    text: 'The variable-compliance fit gives ' + _f0(vc.sigmaC) + ' psia (cross-check, no vote; rms ' + _f1(vc.rmse, 2) + ' psi).' }));
                out[out.length - 1]._fit = vc;
            }
        }
        var lk = ctx.lkFit;
        if (lk && lk.params && _fin(lk.params.sigmaC)) {
            var dtm = _dtAtP(d, lk.params.sigmaC) || d.dt[d.dt.length - 1];
            out.push(_pick('model', 'F3', v, 0, { derivs: d, vote: false, ev: 'C9', p: lk.params.sigmaC, G: _GatD(d, dtm / d.tp), dt: dtm, text: 'The leak-off model fit places mechanical closure at ' + _f0(lk.params.sigmaC) + ' psia (cross-check).' }));
        }
        // F4: reopening knees of later ramps (WTS_wellbore.ramp results), near-wellbore corrected when a step-down exists
        (ctx.ramps || []).forEach(function (rp) {
            if (!_okRes(rp) || !rp.knee || !_fin(rp.knee.p)) return;
            var corr = _fin(rp.nwbCorr), pk = corr ? rp.knee.p - rp.nwbCorr : rp.knee.p;
            var b = rp.band && _fin(rp.band.p10) ? { p10: _r(rp.band.p10 - (corr ? rp.nwbCorr : 0), 2), p50: _r(pk, 2), p90: _r(rp.band.p90 - (corr ? rp.nwbCorr : 0), 2) } : null;
            if (b && !(b.p10 <= b.p50 && b.p50 <= b.p90)) b = null;
            var dtr = _dtAtP(d, pk) || d.dt[d.dt.length - 1];
            out.push(_pick('reopening', 'F4', v, 0, { derivs: d, vote: corr, upperSide: true, ev: 'C11', p: pk, G: _GatD(d, dtr / d.tp), dt: dtr, band: b,
                se: b ? (b.p90 - b.p10) / 2.563 : 5,
                text: corr ? 'Reopening knee ' + _f0(rp.knee.p) + ' psia less ' + _f1(rp.nwbCorr, 1) + ' psi near-wellbore loss = ' + _f0(pk) + ' psia.' : 'Reopening knee ' + _f0(rp.knee.p) + ' psia: an upper-side bound (reads high by the near-wellbore loss).' }));
        });
        // user pick
        var u = ctx.user;
        if (u && _fin(u.p)) {
            var dtu = _fin(u.dt) ? u.dt : (_dtAtP(d, u.p) || d.dt[d.dt.length - 1]);
            var fam = (u.family === 'F1' || u.family === 'F2' || u.family === 'F4') ? u.family : 'F1';
            out.push(_pick('user', fam, v, 0, { derivs: d, vote: true, ev: 'C12', p: u.p, G: _GatD(d, dtu / d.tp), dt: dtu, text: 'User closure ' + _f0(u.p) + ' psia' + (u.reason ? ': ' + String(u.reason).slice(0, 200) : '.') }));
            out[out.length - 1].source = 'user';
        }
        // bounds per pick
        var bc = _bctx(ctx);
        out.forEach(function (pk) {
            var b = G.PRiSM_dfit_bounds(pk.p, bc);
            if (_okRes(b)) {
                pk.admissible = b.admissible; pk.vetoes = b.vetoes; pk.warnings = b.warnings;
                if (!b.admissible && pk.method !== 'user') { if (pk.vote) pk.vetoedVote = true; pk.vote = false; }
            }
        });
        out.iota = cf.iota;
        out.hump = cf.hump;
        return out;
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.7 variable-compliance fit (F3): PRiSM_lm (05) at call time, else a small LM here
    // ═════════════════════════════════════════════════════════════════════
    function _lmLocal(model, data, p0, bounds, keys, maxIter) {
        var p = {}, k; for (k in p0) p[k] = p0[k];
        function ssr(pp) { var y = model(data.t, pp), s = 0; for (var i = 0; i < y.length; i++) { var r = data.p[i] - y[i]; s += r * r; } return s; }
        var lam = 1e-3, cur = ssr(p), it, J, r, y;
        for (it = 0; it < (maxIter || 40); it++) {
            y = model(data.t, p); r = data.p.map(function (v, i) { return v - y[i]; });
            J = keys.map(function (key) {
                var h = Math.max(Math.abs(p[key]) * 1e-4, 1e-6), q = {}; for (var kk in p) q[kk] = p[kk]; q[key] += h;
                var y2 = model(data.t, q); return y2.map(function (v, i) { return (v - y[i]) / h; });
            });
            var m = keys.length, A = [], g = [], i, j, l;
            for (i = 0; i < m; i++) { A.push([]); g.push(0); for (j = 0; j < m; j++) { var s = 0; for (l = 0; l < r.length; l++) s += J[i][l] * J[j][l]; A[i].push(s); } for (l = 0; l < r.length; l++) g[i] += J[i][l] * r[l]; }
            var improved = false;
            for (var tries = 0; tries < 8; tries++) {
                var M = A.map(function (row, ii) { return row.map(function (v, jj) { return ii === jj ? v * (1 + lam) + 1e-12 : v; }); });
                var dx = _solve(M, g.slice());
                if (!dx) { lam *= 10; continue; }
                var q2 = {}; for (k in p) q2[k] = p[k];
                keys.forEach(function (key, ii) { q2[key] = _clampN(p[key] + dx[ii], bounds[key][0], bounds[key][1]); });
                var s2 = ssr(q2);
                if (s2 < cur) { p = q2; cur = s2; lam = Math.max(lam / 10, 1e-12); improved = true; break; }
                lam *= 10;
            }
            if (!improved) break;
        }
        // covariance from the last Jacobian
        var dof = Math.max(1, data.t.length - keys.length), s2r = cur / dof, cov = null;
        if (J) {
            var A2 = keys.map(function (_, ii) { return keys.map(function (__, jj) { var s = 0; for (var l2 = 0; l2 < J[ii].length; l2++) s += J[ii][l2] * J[jj][l2]; return s; }); });
            cov = _inv(A2); if (cov) cov = cov.map(function (row) { return row.map(function (v) { return v * s2r; }); });
        }
        var se = {}, ci = {}, corr = {};
        keys.forEach(function (key, ii) { var sd = cov && cov[ii][ii] > 0 ? Math.sqrt(cov[ii][ii]) : null; se[key] = sd; ci[key] = sd !== null ? [p[key] - 1.96 * sd, p[key] + 1.96 * sd] : null; });
        if (cov && keys.indexOf('sigmaC') >= 0 && keys.indexOf('sc') >= 0) {
            var a = keys.indexOf('sigmaC'), b = keys.indexOf('sc');
            corr.sigmaC_sc = cov[a][b] / Math.sqrt(cov[a][a] * cov[b][b]);
        }
        return { params: p, ci95: ci, stderr: se, rmse: Math.sqrt(cur / data.t.length), corr: corr, converged: true };
    }
    function _solve(A, b) {
        var n = A.length, M = A.map(function (r, i) { return r.concat([b[i]]); });
        for (var c = 0; c < n; c++) {
            var piv = c; for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            if (Math.abs(M[piv][c]) < 1e-300) return null;
            var t = M[c]; M[c] = M[piv]; M[piv] = t;
            for (r = 0; r < n; r++) { if (r === c) continue; var f = M[r][c] / M[c][c]; for (var k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
        }
        return M.map(function (row, i) { return row[n] / row[i]; });
    }
    function _inv(A) {
        var n = A.length, cols = [];
        for (var j = 0; j < n; j++) { var e = []; for (var i = 0; i < n; i++) e.push(i === j ? 1 : 0); var x = _solve(A, e); if (!x) return null; cols.push(x); }
        return A.map(function (_, i) { return cols.map(function (c) { return c[i]; }); });
    }
    var _vcCalls = 0;     // variable-compliance fits made (the consensus reads the count: none may run inside the grid)
    G.PRiSM_dfit_varComplianceFit = _safe(function (derivs, ctx, opts) {
        _vcCalls++;
        ctx = ctx || {}; opts = opts || {};
        if (!_okRes(derivs) || !Array.isArray(derivs.G) || !_fin(derivs.mG)) return _fail('BAD_INPUT', 'Derivatives with an early slope are needed.', ['derivs']);
        var d = derivs, P = ctx.picks || (_closedForm(d, {}).picks);
        var gT = P.tangent ? P.tangent.G : null;
        if (!_fin(gT)) return _fail('NO_PICK', 'The variable-compliance fit needs an F2 pick to set its window.', ['picks']);
        var gEnd = 1.5 * gT, G0 = [], P0 = [];
        for (var i = 0; i < d.G.length; i++) if (d.G[i] >= d.gMin && d.G[i] <= gEnd) { G0.push(d.G[i]); P0.push(d.p[i]); }
        if (G0.length < 8) return _fail('SHORT', 'Too few samples in the variable-compliance window.', ['p']);
        // thin to ≤ 120 points (uniform in index) for speed
        var stride = Math.max(1, Math.ceil(G0.length / 120)), Gf = [], Pf = [];
        for (i = 0; i < G0.length; i += stride) { Gf.push(G0[i]); Pf.push(P0[i]); }
        var VwCw = _fin(ctx.VwCw) ? ctx.VwCw : 0, AfCf = _fin(ctx.AfCf) ? ctx.AfCf : (_fin(ctx.Csys) ? Math.max(ctx.Csys - VwCw, 1e-9) : null);
        if (AfCf === null) { AfCf = 1; VwCw = VwCw > 0 ? VwCw : 0.02; }       // relative units: R_vis 0.98 when nothing is known
        var Copen = AfCf + VwCw, isip0 = d.early ? d.early.a : d.isip;
        var sig0 = P.compliance ? P.compliance.p : (P.tangent.p + (isip0 - P.tangent.p) * 0.1);
        var pr = _fin(ctx.pr) ? ctx.pr : Math.min(d.p[d.p.length - 1], sig0) - 0.5 * Math.abs(isip0 - sig0) - 1;
        var base = { isip: isip0, K: d.mG * Copen, sigmaC: sig0, sc: Math.max(10, 0.2 * Math.abs(sig0 - P.tangent.p)), fres: 0.1, sr: null, law: opts.law === 'hyp' ? 'hyp' : 'exp', pr: pr, VwCw: VwCw, AfCf: AfCf };
        var keys = opts.law === 'hyp' ? ['isip', 'K', 'sigmaC', 'sc'] : ['isip', 'K', 'sigmaC', 'sc', 'fres'];
        var bounds = { isip: [isip0 - 200, isip0 + 200], K: [base.K * 0.2, base.K * 5], sigmaC: [Math.min.apply(null, Pf), isip0], sc: [1, 2000], fres: [0.001, 0.9] };
        function model(Garr, pp) { var q = {}; for (var k in base) q[k] = base[k]; for (k in pp) if (_fin(pp[k])) q[k] = pp[k]; if (q.law === 'hyp') q.sh = q.sc; return _vcIntegrate(Garr, q, 0.05); }
        var lm = _fn('PRiSM_lm'), res = null, p0 = {};
        keys.forEach(function (k) { p0[k] = base[k]; });
        if (lm) {
            try {
                var free = {}; for (var kk in p0) free[kk] = false;
                var r = lm(model, { t: Gf, p: Pf }, p0, bounds, free, { maxIter: 40 });
                if (r && r.params) res = { params: r.params, ci95: r.ci95 || {}, rmse: r.rmse, corr: r.corr, converged: r.converged };
            } catch (e) { res = null; }
        }
        if (!res) res = _lmLocal(model, { t: Gf, p: Pf }, p0, bounds, keys, 40);
        var pp2 = res.params, ciS = res.ci95 && res.ci95.sigmaC;
        var corrSS = null;
        if (res.corr) {
            if (_fin(res.corr.sigmaC_sc)) corrSS = res.corr.sigmaC_sc;
            else if (res.corr.sigmaC && _fin(res.corr.sigmaC.sc)) corrSS = res.corr.sigmaC.sc;
        }
        var fit = model(Gf, pp2), resid = Pf.map(function (v, j) { return _r(v - fit[j], 3); });
        // profile of σ_c on demand (opts.profile): σ_c held at 9 values across ±max(3 se, 50 psi), the others refitted
        var profile = null;
        if (opts.profile) {
            profile = [];
            var seS = (Array.isArray(ciS) && _fin(ciS[0]) && _fin(ciS[1])) ? (ciS[1] - ciS[0]) / 3.92 : 0, half = Math.max(3 * seS, 50);
            var kp = keys.filter(function (k) { return k !== 'sigmaC'; });
            for (var q = -4; q <= 4; q++) {
                var sv = pp2.sigmaC + half * q / 4, b2 = {}; for (var bk in base) b2[bk] = base[bk];
                b2.sigmaC = sv;
                var p1 = {}; kp.forEach(function (k) { p1[k] = pp2[k]; });
                var m2 = function (Garr, pp) { var qq = {}; for (var k in b2) qq[k] = b2[k]; for (k in pp) if (_fin(pp[k])) qq[k] = pp[k]; if (qq.law === 'hyp') qq.sh = qq.sc; return _vcIntegrate(Garr, qq, 0.05); };
                var rr = _lmLocal(m2, { t: Gf, p: Pf }, p1, bounds, kp, 20);
                profile.push({ sigmaC: _r(sv, 2), rmse: _r(rr.rmse, 4) });
            }
        }
        return { ok: true, sigmaC: _r(pp2.sigmaC, 2), ci95: (Array.isArray(ciS) && _fin(ciS[0]) && _fin(ciS[1])) ? [_r(ciS[0], 2), _r(ciS[1], 2)] : null,
                 sc: _r(pp2.sc, 3), fres: _r(_fin(pp2.fres) ? pp2.fres : base.fres, 4), K: _sf(pp2.K, 6), isip: _r(pp2.isip, 2), corrSigmaSc: _nn(corrSS),
                 resid: resid, rmse: _r(res.rmse, 4), profile: profile, law: base.law, n: Gf.length };
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.8 bounds check: order, efficiency, pn plausibility, two-tier frictional limit
    // ═════════════════════════════════════════════════════════════════════
    function _fricLimit(pp, sv, mu) { var f = Math.pow(Math.sqrt(mu * mu + 1) + mu, 2); return pp + (sv - pp) / f; }
    function _frictional(ctx) {
        var I = ctx.inputs ? G.PRiSM_dfit_inputRanges.clamp(ctx.inputs).inputs : G.PRiSM_dfit_inputRanges.defaults();
        var tvd = _fin(ctx.datumTvd) ? ctx.datumTvd : I.datumTvd;
        if (!_fin(tvd)) return null;
        var hyd = 0.052 * 8.33 * tvd;
        var ppLo = (Array.isArray(ctx.piBracket) && _fin(ctx.piBracket[0])) ? ctx.piBracket[0] : (_fin(ctx.ppLo) ? ctx.ppLo : hyd);
        var ppNom = _fin(ctx.pi) ? ctx.pi : (ctx.well && _fin(ctx.well.pi) ? ctx.well.pi : (_fin(I.priors.piGrad) ? I.priors.piGrad * tvd : hyd));
        var veto = _fricLimit(ppLo, I.rock.sigmaVGradLo * tvd, I.rock.muFricVeto);
        var warn = _fricLimit(ppNom, I.rock.sigmaVGrad * tvd, I.rock.muFricWarn);
        return { veto: veto, warn: Math.max(warn, veto), ppLo: ppLo, ppNom: ppNom, tvd: tvd, I: I };
    }
    G.PRiSM_dfit_bounds = _safe(function (candidate, ctx) {
        ctx = ctx || {};
        var pc = _fin(candidate) ? candidate : (_isObj2(candidate) && _fin(candidate.p) ? candidate.p : null);
        if (pc === null) return _fail('BAD_INPUT', 'A closure candidate pressure is needed.', ['candidate']);
        var vetoes = [], warnings = [];
        var pi = _fin(ctx.pi) ? ctx.pi : (ctx.well && _fin(ctx.well.pi) ? ctx.well.pi : null);
        var isip = _fin(ctx.isip) ? ctx.isip : null;
        if (pi !== null && !(pc > pi)) vetoes.push({ rule: 'order', text: _txt('The closure ' + _f0(pc) + ' psia is not above the reservoir pressure ' + _f0(pi) + ' psia.'), value: pc, limit: pi });
        if (isip !== null && !(pc < isip)) vetoes.push({ rule: 'order', text: _txt('The closure ' + _f0(pc) + ' psia is not below the ISIP ' + _f0(isip) + ' psia.'), value: pc, limit: isip });
        if (_fin(ctx.eta) && !(ctx.eta > 0 && ctx.eta < 1)) vetoes.push({ rule: 'eta', text: _txt('The efficiency ' + _f1(ctx.eta, 3) + ' lies outside (0, 1).'), value: ctx.eta, limit: 1 });
        if (isip !== null && pi !== null && isip - pc > 0.5 * (isip - pi)) warnings.push({ rule: 'pn', text: _txt('Net pressure ' + _f0(isip - pc) + ' psi is more than half of ISIP minus p_i (' + _f0(isip - pi) + ' psi).'), value: isip - pc, limit: 0.5 * (isip - pi) });
        var fr = _frictional(ctx), fric = { veto: null, warn: null };
        if (fr) {
            fric = { veto: _r(fr.veto, 1), warn: _r(fr.warn, 1) };
            if (pc < fr.veto) vetoes.push({ rule: 'frictional', text: _txt('Below the conservative frictional limit ' + _f0(fr.veto) + ' psia (friction ' + _f1(fr.I.rock.muFricVeto, 2) + ', p_p ' + _f0(fr.ppLo) + ' psia, S_v ' + _f1(fr.I.rock.sigmaVGradLo, 2) + ' psi/ft).'), value: pc, limit: _r(fr.veto, 1) });
            else if (pc < fr.warn) warnings.push({ rule: 'frictional', text: _txt('Between the frictional limits ' + _f0(fr.veto) + ' and ' + _f0(fr.warn) + ' psia (friction ' + _f1(fr.I.rock.muFricWarn, 2) + ', S_v ' + _f1(fr.I.rock.sigmaVGrad, 2) + ' psi/ft).'), value: pc, limit: _r(fr.warn, 1) });
        }
        return { admissible: vetoes.length === 0, vetoes: vetoes, warnings: warnings, frictional: fric };
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.9 / §4.10 frac outputs for one closure candidate (storage-consistent chain)
    // ═════════════════════════════════════════════════════════════════════
    function _isipVal(x) { return _fin(x) ? x : (_isObj2(x) && _fin(x.value) ? x.value : null); }
    G.PRiSM_dfit_frac = _safe(function (pClosure, derivs, ctx) {
        ctx = ctx || {};
        if (!_fin(pClosure)) return _fail('BAD_INPUT', 'A closure pressure is needed.', ['pClosure']);
        if (!_okRes(derivs) || !Array.isArray(derivs.G)) return _fail('BAD_INPUT', 'Derivatives are needed.', ['derivs']);
        var d = derivs, ev = ctx.events || {}, I = G.PRiSM_dfit_inputRanges.clamp(ctx.inputs || {}).inputs, well = ctx.well || {};
        var isip = _isipVal(ctx.isip); if (isip === null) isip = d.isip;
        var pn = isip - pClosure, msgs = [];
        var mG = _fin(ctx.mG) ? ctx.mG : d.mG;
        // closure time on the data (or the early line when the data stop above it)
        var dtc = _dtAtP(d, pClosure), reached = dtc !== null;
        if (!reached && _fin(mG) && mG > 0) { dtc = _GinvD(d, pn / mG) * d.tp; msgs.push(_txt('Closure is not reached in the data; the closure time is extrapolated on the early G line.')); }
        if (!_fin(dtc) || dtc <= 0) return _fail('NO_CLOSURE_TIME', 'The closure time could not be found.', ['pClosure']);
        var tp = d.tp, tpMin = tp * 60, dtDc = dtc / tp, Gc = _GatD(d, dtDc);
        var Gc5 = G_(dtDc, 0.5), Gc1 = G_(dtDc, 1);
        var e5 = Gc5 / (Gc5 + 2), e1 = Gc1 / (Gc1 + 16 / (3 * PI));
        var g0m = d.gSpec ? d.gSpec.g0 : g0_(d.gType === 'a1' ? 1 : (d.gType === 'a05' ? 0.5 : d.alpha));
        var eM = Gc / (Gc + 4 * g0m / PI);
        var VwCw = _fin(ctx.VwCw) ? ctx.VwCw : (_fin(ev.VwCwMeasured) ? ev.VwCwMeasured : (_fin(ev.VwCwUsed) ? ev.VwCwUsed : _vwcwTheory(I, well)));
        if (!_fin(VwCw)) { VwCw = 0; msgs.push(_txt('No wellbore storage value (ramp or theory): V_w·c_w is taken as zero, so A_f·c_f is an upper bound.')); }
        var pStart = _fin(ev.pStart) ? ev.pStart : (_fin(well.pi) ? well.pi : null);
        var ViStar = _fin(ctx.ViStar) ? ctx.ViStar : ((_fin(ev.Vi) && pStart !== null) ? ev.Vi - VwCw * (pClosure - pStart) - (ev.Vfill || 0) : null);
        var Csys = (ViStar !== null && pn > 0) ? eM * ViStar / pn : null;          // bbl/psi
        // PDL (a hump before the post-hump early window, §4.11): the leak-off coefficient during pumping is the one at the pumping
        // pressure, m = the PDL multiplier at the ISIP times the post-hump one. V* = C_sys·p_n (leak-off after shut-in, exact) +
        // X·(4g0/π)·m (during pumping), X = C_sys·m_G, so C_sys = V*/(p_n + (4g0/π)·m_G·m). The constant-CL η = G_c/(G_c + 4g0/π)
        // assumes m = 1 and overstated A_f·c_f by 36 % on the mini-model PDL case. m: the classifier's multiplier at the ISIP
        // (only when the classifier calls the test PDL and gives its multiplier: a gas-filled wellbore also has a falling early
        // dP/dG, from its pressure-dependent storage)
        var mPdl = (ctx.classification && ctx.classification.type === 'pdl' && ctx.classification.pdl && _fin(ctx.classification.pdl.multAtIsip)) ? ctx.classification.pdl.multAtIsip : null;
        if (_fin(mPdl) && mPdl > 1.05 && ViStar !== null && pn > 0 && _fin(mG) && mG > 0) {
            Csys = ViStar / (pn + (4 * g0m / PI) * mG * mPdl);
            eM = Csys * pn / ViStar;
        }
        var AfCf = Csys !== null ? Csys - VwCw : null, Rvis = (Csys > 0 && AfCf !== null) ? AfCf / Csys : null;
        if (AfCf !== null && AfCf <= 0) msgs.push(_txt('The system compliance is below the wellbore storage: the fracture compliance is not positive (check V_w·c_w and the closure).'));
        var X = (Csys !== null && _fin(mG)) ? Csys * mG : null;                    // bbl per unit G
        var chi = (_fin(mG) && mG > 0 && Gc > 0) ? pn / (mG * Gc) : null;
        var tvd = I.datumTvd, Gamma = _fin(mG) ? 2 * mG / (PI * Math.sqrt(tpMin)) : null;
        // geometry from A_f·c_f (ft³/psi)
        var Ep = I.rock.Ep, hf = I.rock.hf, hp = _fin(I.rock.hp) ? I.rock.hp : hf, bar = _fin(I.rock.barrierSpacing) ? I.rock.barrierSpacing : hf;
        var AfCfFt = (AfCf !== null && AfCf > 0) ? AfCf * BBL : null, VfB = (AfCf !== null && AfCf > 0) ? AfCf * pn : null;
        var VLpump = (ViStar !== null) ? ViStar * (1 - eM) : null, etaF = (VfB !== null && VLpump !== null) ? VfB / (VfB + VLpump) : null;
        function geo(model) {
            var o = { cf: null, Af: null, rp: null, CL: null, wAvg: null, wMax: null, Vf: _r(VfB, 3), VLpump: _r(VLpump, 3) };
            if (model === 'radial') o.R = null; else o.xf = null;
            if (!(AfCfFt > 0) || !_fin(Ep)) return o;
            var Af, rp, wf, xs;
            if (model === 'PKN') { if (!_fin(hf)) return o; xs = AfCfFt * Ep / (PI * hf * hf); Af = 2 * xs * hf; rp = Math.min(1, hp / hf); wf = 4 / PI; o.xf = _r(xs, 2); }
            else if (model === 'KGD') { if (!_fin(hf)) return o; xs = Math.sqrt(AfCfFt * Ep / (2 * PI * hf)); Af = 2 * xs * hf; rp = Math.min(1, hp / hf); wf = 4 / PI; o.xf = _r(xs, 2); }
            else { xs = Math.pow(3 * Ep * AfCfFt / 16, 1 / 3); Af = PI * xs * xs; var u = _fin(hp) ? Math.min(1, hp / (2 * xs)) : 1; rp = 2 / PI * (u * Math.sqrt(1 - u * u) + Math.asin(u)); wf = 1.5; o.R = _r(xs, 2); }
            o.cf = _sf(AfCfFt / Af, 5); o.Af = _r(Af, 1); o.rp = _r(rp, 4);
            o.CL = (X !== null && rp > 0) ? _sf(2 * X * BBL / (PI * rp * Af * Math.sqrt(tpMin)), 5) : null;
            var w = VfB * BBL / Af * 12; o.wAvg = _r(w, 4); o.wMax = _r(w * wf, 4);
            o._size = xs;
            return o;
        }
        var byModel = { PKN: geo('PKN'), KGD: geo('KGD'), radial: geo('radial') };
        var model = 'PKN', consistent = true, auto = true;
        if (byModel.radial._size && _fin(bar) && 2 * byModel.radial._size <= bar) model = 'radial';
        else {
            if (byModel.radial._size && _fin(bar)) msgs.push(_txt('Radial: 2R = ' + _f1(2 * byModel.radial._size, 1) + ' ft exceeds the ' + _f1(bar, 0) + ' ft barrier spacing; the radial geometry is not consistent.'));
            if (byModel.PKN._size && _fin(hf) && byModel.PKN._size >= 1.5 * hf) model = 'PKN';
            else if (byModel.KGD._size) { model = 'KGD'; if (byModel.PKN._size) msgs.push(_txt('PKN xf ' + _f1(byModel.PKN._size, 1) + ' ft is below 1.5 h_f: KGD is used (PKN and KGD bound the length).')); }
        }
        if (_fin(ctx.geometry) || ctx.geometry === 'PKN' || ctx.geometry === 'KGD' || ctx.geometry === 'radial') { model = ctx.geometry; auto = false; }
        if (model === 'radial' && byModel.radial._size && _fin(bar) && 2 * byModel.radial._size > bar) consistent = false;
        if (model === 'PKN' && byModel.PKN._size && _fin(hf) && byModel.PKN._size < 1.5 * hf) consistent = false;
        if (!_fin(Ep) || !_fin(hf)) { msgs.push(_txt('E′ and the fracture height are needed for the geometry, CL and the leak-off coefficient.')); consistent = false; }
        ['PKN', 'KGD', 'radial'].forEach(function (k) { delete byModel[k]._size; });
        var ch = byModel[model] || byModel.PKN;
        // k from CL (§4.10 convention: Δp_CL = ½(ISIP + σ_c) − p_r)
        var kb = G.PRiSM_dfit_kBeforeClosure({ isip: isip, pClosure: pClosure, CL: ch.CL }, d, { well: well, pr: ctx.pr });
        var gradI = _fin(tvd) ? isip / tvd : null, gradC = _fin(tvd) ? pClosure / tvd : null;
        // stress-log calibration offset Δσ_tect = σ_c − [ν/(1 − ν)·(S_v − α·p_p) + α·p_p]
        var pp = _fin(ctx.pr) ? ctx.pr : (_fin(well.pi) ? well.pi : (_fin(I.priors.piGrad) && _fin(tvd) ? I.priors.piGrad * tvd : null));
        var stressCal = null;
        if (_fin(tvd) && pp !== null) {
            var nu = I.rock.nu, al = I.rock.biot, Sv = I.rock.sigmaVGrad * tvd, sm = nu / (1 - nu) * (Sv - al * pp) + al * pp;
            stressCal = { dSigmaTect: _r(pClosure - sm, 1), sigmaModel: _r(sm, 1), biot: al };
        }
        var pair = G.PRiSM_dfit_etaPair(dtDc);
        var eta = { a05: _r(e5, 5), a1: _r(e1, 5), matched: _r(eM, 5), alphaUsed: d.alpha, etaF: _r(etaF, 5), showPair: pair ? pair.showPair : false };
        var pdlMult = (ctx.classification && ctx.classification.pdl && _fin(ctx.classification.pdl.multAtIsip)) ? ctx.classification.pdl.multAtIsip : null;
        var ff = G.PRiSM_dfit_farField(d, ev, ctx);
        return {
            pClosure: _r(pClosure, 2), family: ctx.family || null, method: ctx.method || null, Gc: _r(Gc, 4), dtc: _r(dtc, 6), dtDc: _r(dtDc, 4), ViStar: _r(ViStar, 4),
            eta: eta, Csys: _sf(Csys, 5), VwCw: _sf(VwCw, 5), AfCf: _sf(AfCf, 5), Rvis: _r(Rvis, 4), pn: _r(pn, 2), chi: _r(chi, 4),
            gradIsip: _r(gradI, 5), gradClosure: _r(gradC, 5), Gamma: _r(Gamma, 4), GammaPKN: (_fin(Gamma) && Rvis > 0) ? _r(PI / 2 * Gamma / Rvis, 4) : null, mG: _r(mG, 4),
            geometry: { model: model, auto: auto, consistent: consistent, msgs: msgs, byModel: byModel },
            spurt: { value: null, note: 'Spurt is not separable from a falloff alone; the efficiency is an upper bound.' },
            kBefore: { kCL: _okRes(kb) ? kb.kCL : null, kH: _okRes(kb) ? kb.kH : null }, pdlMult: _nn(pdlMult), farField: _okRes(ff) ? ff : null,
            padFraction: { lo: _r(Math.pow(1 - eM, 2), 5), hi: _r((1 - eM) / (1 + eM), 5) }, stressCal: stressCal, ev: ['F1'],
            reached: reached, X: _sf(X, 6)
        };
    });
    G.PRiSM_dfit_whatIf = _safe(function (candidates, derivs, ctx) {
        if (!Array.isArray(candidates)) return _fail('BAD_INPUT', 'A list of candidates is needed.', ['candidates']);
        var out = [];
        candidates.forEach(function (c, i) {
            if (!_isObj2(c) || !_fin(c.p)) return;
            var o = {}; for (var k in (ctx || {})) o[k] = ctx[k];
            o.family = c.family || null; o.method = c.method || null;
            var f = G.PRiSM_dfit_frac(c.p, derivs, o);
            if (_okRes(f)) { f.label = _txt(c.label || ('Candidate ' + (i + 1))); out.push(f); }
        });
        return out;
    });
    G.PRiSM_dfit_kBeforeClosure = _safe(function (frac, derivs, ctx) {
        ctx = ctx || {};
        var well = ctx.well || {}, isip = _fin(frac && frac.isip) ? frac.isip : (derivs && derivs.isip), pc = frac && (_fin(frac.pClosure) ? frac.pClosure : null);
        var CL = frac && (_fin(frac.CL) ? frac.CL : (frac.geometry && frac.geometry.byModel && frac.geometry.byModel[frac.geometry.model] ? frac.geometry.byModel[frac.geometry.model].CL : null));
        var pr = _fin(ctx.pr) ? ctx.pr : (_fin(well.pi) ? well.pi : null);
        var kCL = null;
        if (_fin(CL) && CL > 0 && _fin(isip) && _fin(pc) && pr !== null && _fin(well.mu) && _fin(well.phi) && _fin(well.ct)) {
            var dpCL = 0.5 * (isip + pc) - pr;
            if (dpCL > 0) {
                var k = 1000 * Math.pow(CL / (0.0374 * dpCL), 2) * well.mu / (well.phi * well.ct);
                kCL = { k: _sf(k, 5), dpCL: _r(dpCL, 2), factor: 2, kCorr: _sf(k / 2, 5) };
            }
        }
        return { kCL: kCL, kH: null, note: 'k from CL is read high against the after-closure k (÷ 2 shown); the h-function estimate is deferred (gate G6).' };
    });
    // far-field extension pressure (informational, gate G6): deferred with the h-function → null
    G.PRiSM_dfit_farField = function () { return null; };
    G.PRiSM_dfit_forecastClosure = _safe(function (derivs, ctx, sigmas) {
        if (!_okRes(derivs) || !_fin(derivs.mG) || derivs.mG <= 0) return _fail('BAD_INPUT', 'Derivatives with an early slope are needed.', ['derivs']);
        ctx = ctx || {};
        var isip = _isipVal(ctx.isip); if (isip === null) isip = derivs.isip;
        var list = Array.isArray(sigmas) ? sigmas : [];
        if (!list.length && ctx.inputs) {
            var I = G.PRiSM_dfit_inputRanges.clamp(ctx.inputs).inputs;
            if (_fin(I.priors.sigmaGrad) && _fin(I.datumTvd)) { var s0 = I.priors.sigmaGrad * I.datumTvd, ds = I.priors.sigmaGradSd * I.datumTvd; list = [s0 + ds, s0, s0 - ds]; }
        }
        var out = [];
        list.forEach(function (sg) {
            if (!_fin(sg) || sg >= isip) return;
            var Gcf = (isip - sg) / derivs.mG, dtD = _GinvD(derivs, Gcf);
            if (_fin(dtD)) out.push({ sigma: _r(sg, 1), Gc: _r(Gcf, 4), dtc: _r(dtD * derivs.tp, 4) });
        });
        return out;
    });
    // §4.10 leak-off rate from the data: q_L = C_sys·|dP/dG|·dG/dt (bbl/min), V_L = V_L(t_s) + X·G, V_f = A_f·c_f·(p − σ_c)
    G.PRiSM_dfit_leakoffRate = _safe(function (derivs, frac) {
        if (!_okRes(derivs) || !_okRes(frac) || !_fin(frac.Csys)) return _fail('BAD_INPUT', 'Derivatives and frac outputs (with C_sys) are needed.', ['frac']);
        var d = derivs, tp = d.tp, X = frac.Csys * (_fin(frac.mG) ? frac.mG : d.mG), dtc = frac.dtc, out = { dt: [0], qL: [], VL: [], Vf: [], qLData: [null], pdl: _fin(frac.pdlMult) };
        var VL0 = frac.ViStar !== null && frac.eta ? frac.ViStar * (1 - frac.eta.matched) : 0;
        function dGdt(dtD) { return (d.gSpec ? _sGpD(d.gSpec, dtD) : Gp_(dtD, d.gType === 'a1' ? 1 : (d.gType === 'a05' ? 0.5 : d.alpha))) / (tp * 60); }   // per minute
        out.qL.push(_sf(X * dGdt(0), 6)); out.VL.push(_r(VL0, 4)); out.Vf.push(_r(frac.AfCf * frac.pn, 4));
        for (var i = 0; i < d.dt.length && d.dt[i] <= dtc * (1 + 1e-9); i++) {
            out.dt.push(d.dt[i]);
            // normal leak-off: q_L = X·dG/dt; with PDL (frac.pdlMult set) the data slope: q_L = C_sys·|dP/dG|·dG/dt
            var qd = (d.dPdG[i] !== null && _fin(d.dPdG[i])) ? frac.Csys * d.dPdG[i] * dGdt(d.dtD[i]) : null;
            out.qLData.push(_sf(qd, 6));
            out.qL.push(_sf(out.pdl && qd !== null ? qd : X * dGdt(d.dtD[i]), 6));
            out.VL.push(_r(VL0 + X * d.G[i], 4));
            out.Vf.push(_r(Math.max(0, frac.AfCf * (d.p[i] - frac.pClosure)), 4));
        }
        out.dt.push(dtc); out.qL.push(_sf(X * dGdt(dtc / tp), 6)); out.qLData.push(null); out.VL.push(_r(VL0 + X * frac.Gc, 4)); out.Vf.push(0);
        out.ok = true;
        return out;
    });
    // §6.12 overlay curve: G·dP/dG normalised by m_G·G against G/G_c, ≤ 60 points log-spaced (DfitTest.summary.gdpdgN)
    G.PRiSM_dfit_gdpdgN = _safe(function (derivs, frac, maxN) {
        if (!_okRes(derivs) || !_fin(derivs.mG) || derivs.mG <= 0) return _fail('BAD_INPUT', 'Derivatives with an early slope are needed.', ['derivs']);
        var Gc = _okRes(frac) && _fin(frac.Gc) ? frac.Gc : null, m = _fin(maxN) ? Math.min(60, Math.max(2, maxN)) : 60, d = derivs, xs = [], ys = [], i;
        for (i = 0; i < d.G.length; i++) if (d.usable[i] && d.GdPdG[i] !== null && d.G[i] > 0) { xs.push(Gc ? d.G[i] / Gc : d.G[i]); ys.push(d.GdPdG[i] / (d.mG * d.G[i])); }
        if (!xs.length) return { x: [], y: [] };
        var lo = Math.log(xs[0]), hi = Math.log(xs[xs.length - 1]), out = { x: [], y: [] }, k = 0;
        for (var j = 0; j < m; j++) {
            var target = m === 1 ? lo : lo + (hi - lo) * j / (m - 1);
            while (k + 1 < xs.length && Math.log(xs[k + 1]) <= target) k++;
            if (out.x.length && out.x[out.x.length - 1] === _r(xs[k], 5)) continue;
            out.x.push(_r(xs[k], 5)); out.y.push(_r(ys[k], 5));
        }
        return out;
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.11 leak-off-type classifier
    // ═════════════════════════════════════════════════════════════════════
    function _logit(x) { return 1 / (1 + Math.exp(-x)); }
    // logistic margin σ((value − threshold)/(0.2·|threshold| + δ)), oriented: dir +1 'above', −1 'below'
    function _mg(value, thr, dir, delta) { if (!_fin(value)) return 0.5; return _logit(dir * (value - thr) / (0.2 * Math.abs(thr) + (delta || 0.02))); }
    // robust relative change of dP/dG across [iA, iC]: the start is the median over the first 10 % of the window in G
    // (at least 3 points), the end the median of the last 3 points (log-spaced data put most indices at early G)
    function _relChange(v, iA, iC) {
        if (iC - iA < 3) return 0;
        var gA = v.G[iA], gC = v.G[iC], a = [], b = [], i;
        for (i = iA; i <= iC && (v.G[i] <= gA + 0.1 * (gC - gA) || a.length < 3); i++) a.push(v.s[i]);
        for (i = Math.max(iA, iC - 2); i <= iC; i++) b.push(v.s[i]);
        var s0 = _median(a), s1 = _median(b);
        return (s0 > 0 && _fin(s1)) ? (s1 - s0) / s0 : 0;
    }
    function _kappaExp(d, ctx, gA, gC, isip, sigC, pr) {
        // a coarse w_c = 1 leak-off model run (58 at call time) read over the same window; else the quasi-static form
        var run = ctx.curvExpRun;
        if (!run) {
            var sim = _fn('PRiSM_dfit_lkSimulate'), defs = _fn('PRiSM_dfit_lkDefaults');
            if (sim && !sim._dfitStub && defs && !defs._dfitStub) {
                try {
                    var cfg = defs();
                    // integration: 58's 'prescribed' mode needs {Ap, cf, alpha, rp, tp} (Nolte's constant-area assumptions), taken
                    // from the frac candidate's geometry; the leak-off is fully reservoir-controlled (CL with w_c = 1). Without a
                    // geometry or p_r there is no model run (quasi-static form below).
                    var fr = ctx.frac, gmK = fr && fr.geometry && fr.geometry.byModel ? fr.geometry.byModel[fr.geometry.model || 'PKN'] || fr.geometry.byModel.PKN : null;
                    if (_okRes(cfg) && _isObj2(gmK) && _fin(gmK.Af) && gmK.Af > 0 && _fin(gmK.cf) && gmK.cf > 0 && _fin(gmK.CL) && gmK.CL > 0 && _fin(pr) && _fin(sigC) && sigC > pr) {
                        cfg.sigmaC = sigC; cfg.pr = pr; cfg.wc = 1; cfg.CL = gmK.CL; cfg.mode = 'prescribed';
                        cfg.prescribed = { Ap: gmK.Af, cf: gmK.cf, alpha: d.gType === 'a1' ? 1 : (d.gType === 'a05' ? 0.5 : (_fin(d.alpha) ? d.alpha : 0.5)), rp: _fin(gmK.rp) ? gmK.rp : undefined, tp: d.tp };
                        if (_fin(isip) && isip > sigC) cfg.dpRef = isip - pr;
                        if (ctx.events && Array.isArray(ctx.events.schedule) && ctx.events.schedule.length) cfg.schedule = ctx.events.schedule.map(function (s) { return { t: s.t - ctx.events.schedule[0].t, q: s.q }; });
                        var r = sim(cfg, { grid: 'coarse' });
                        if (_okRes(r)) run = r;
                    }
                } catch (e) { run = null; }
            }
        }
        if (_okRes(run) && Array.isArray(run.pw) && Array.isArray(run.Ggen) && run.events) {
            var Gm = [], Pm = [];
            for (var i = 0; i < run.t.length; i++) if (run.t[i] > run.events.ts && _fin(run.Ggen[i]) && _fin(run.pw[i])) { Gm.push(run.Ggen[i]); Pm.push(run.pw[i]); }
            if (Gm.length >= 4) {
                var sl = function (g) {     // |dp/dG| of the model at G (central difference on the model grid)
                    var j = 1; while (j < Gm.length - 1 && Gm[j] < g) j++;
                    return Math.abs((Pm[j] - Pm[j - 1]) / ((Gm[j] - Gm[j - 1]) || 1e-12));
                };
                // the end of the window is the model's own closure when the model closes before the data's G_c: the expected
                // change is the change up to σ_c (dP/dG ∝ p − p_r there), and past the model closure the slope is the
                // after-closure one (it read +345 % on a matrix case whose model run closed at G 17.9 against the data's 19.3)
                var gcm = run.events.Gc ? (_fin(run.events.Gc.gen) ? run.events.Gc.gen : run.events.Gc.a05) : null;
                var gE = (_fin(gcm) && gcm > 0 && gcm < gC) ? 0.97 * gcm : gC;
                // the end slope on the last model interval that ends at or before the window end (an interval that straddles
                // the model closure mixes in the after-closure slope)
                var slEnd = function (g) {
                    var j = 1; while (j + 1 < Gm.length && Gm[j + 1] <= g) j++;
                    return Math.abs((Pm[j] - Pm[j - 1]) / ((Gm[j] - Gm[j - 1]) || 1e-12));
                };
                var sA = sl(Math.max(gA, Gm[1])), sC = slEnd(gE);
                if (sA > 0) return { k: (sC - sA) / sA, source: 'model' };
            }
        }
        if (_fin(isip) && _fin(sigC) && _fin(pr) && isip > pr) return { k: (sigC - pr) / (isip - pr) - 1, source: 'quasi-static' };
        return { k: 0, source: 'none' };
    }
    G.PRiSM_dfit_classify = _safe(function (derivs, ctx) {
        ctx = ctx || {};
        if (!_okRes(derivs) || !Array.isArray(derivs.G)) return _fail('BAD_INPUT', 'Derivatives are needed for the classifier.', ['derivs']);
        var d = derivs, cf = ctx.closed || _closedForm(d, { eps: ctx.eps }), v = cf.view, n = v.G.length, evid = [];
        if (n < 6) return _fail('SHORT', 'Too few usable derivative samples to classify the leak-off.', ['derivs']);
        var P = cf.picks, hump = cf.hump;
        // the closure G read to: ctx.Gc, else the frac candidate's G_c, else the consensus closure (value, or the F1 median of
        // a range), else the tangent pick. The closed-form picks land early on gradual-decline signatures (matrix, tip
        // extension), so the pipeline (57) passes frac or the consensus; the tangent is only the last resort.
        var cons = _isObj2(ctx.consensus) && ctx.consensus.ok !== false ? ctx.consensus : null;
        var pCons = null;       // a Consensus or a ConsensusLite: the value, else the F1 (upper) median of a range
        if (cons) {
            if (_fin(cons.value)) pCons = cons.value;
            else if (cons.range && cons.range.medians && _fin(cons.range.medians.high)) pCons = cons.range.medians.high;
            else if (cons.families && cons.families.F1 && _fin(cons.families.F1.p50)) pCons = cons.families.F1.p50;
            else if (cons.range && _fin(cons.range.hi)) pCons = cons.range.hi;
        }
        var dtCons = pCons !== null ? _dtAtP(d, pCons) : null, gCons = _fin(dtCons) ? _GatD(d, dtCons / d.tp) : null;
        var gC = _fin(ctx.Gc) ? ctx.Gc : (ctx.frac && _fin(ctx.frac.Gc) ? ctx.frac.Gc : (_fin(gCons) ? gCons : (P.tangent ? P.tangent.G : v.G[n - 1])));
        var gcSource = _fin(ctx.Gc) ? 'ctx' : (ctx.frac && _fin(ctx.frac.Gc) ? 'frac' : (_fin(gCons) ? 'consensus' : (P.tangent ? 'tangent' : 'end')));
        // §4.11: W ends at the tangent (end of stiffening) G. When the tangent pick lies after the closure candidate (a
        // concave-up closure range: the F1 onset first, the F2 end later), W runs to it, so the stiffening between the two
        // is part of κ; on a single closure the two coincide.
        if (!_fin(ctx.Gc) && P.tangent && _fin(P.tangent.G) && !cf.noDeparture && P.tangent.G > gC * Math.exp(0.02) && (gcSource === 'frac' || gcSource === 'consensus')) { gC = P.tangent.G; gcSource = 'tangent'; }
        var iA = 0, iC = n - 1; while (iC > 0 && v.G[iC] > gC) iC--;
        var iota = _iota(v, iA, iC), curv = _relChange(v, hump ? hump.iEnd : iA, iC);
        var frac = ctx.frac || null, isip = _isipVal(ctx.isip); if (isip === null) isip = d.isip;
        var sigC = frac && _fin(frac.pClosure) ? frac.pClosure : (pCons !== null ? pCons : (P.tangent ? P.tangent.p : v.p[iC]));
        var pr = _fin(ctx.pr) ? ctx.pr : (ctx.well && _fin(ctx.well.pi) ? ctx.well.pi : null);
        var ke = _kappaExp(d, ctx, v.G[iA], gC, isip, sigC, pr), kwb = 0;
        if (typeof ctx.VwCwOfP === 'function' && frac && _fin(frac.AfCf)) {
            var cA = frac.AfCf + ctx.VwCwOfP(v.p[iA]), cC = frac.AfCf + ctx.VwCwOfP(v.p[iC]);
            if (cA > 0 && cC > 0) kwb = cA / cC - 1;
        }
        var curvExp = ke.k + kwb;
        var ratios = []; for (var i = iA; i <= iC; i++) if (_fin(v.D[i]) && _fin(v.Dref[i]) && v.Dref[i] > 0) ratios.push(v.D[i] / v.Dref[i]);
        var DoverDref = _median(ratios); if (!_fin(DoverDref)) DoverDref = 1;
        var late = ratios.slice(Math.floor(ratios.length * 0.85)), DlateRatio = late.length ? Math.max.apply(null, late) : DoverDref;
        var H = hump ? hump.H : 0, returns = hump ? hump.returns : false;
        // no-return excess: G·dP/dG above the late line from the start (tip extension) — H measured against the end slope
        var sEnd = _median(v.s.slice(Math.max(iA, iC - 3), iC + 1)), Hnr = 0;
        if (sEnd > 0) for (i = iA; i <= iC; i++) Hnr = Math.max(Hnr, (v.y[i] - sEnd * v.G[i]) / (sEnd * v.G[i]));
        var Rvis = frac && _fin(frac.Rvis) ? frac.Rvis : (_fin(ctx.Rvis) ? ctx.Rvis : null);
        var VwT = _fin(ctx.VwCwTheory) ? ctx.VwCwTheory : null, VwM = _fin(ctx.VwCwMeasured) ? ctx.VwCwMeasured : null;
        var VwR = (VwT > 0 && VwM > 0) ? VwM / VwT : null;
        // no closure (R_vis not computable): an upper bound from the early slope. Closure is not reached by G_end, so
        // V* = X·(G_c + 4g0/π) ≥ X·(G_end + 4g0/π), X = C_sys·m_G, hence C_sys ≤ V*/(m_G·(G_end + 4g0/π)) and
        // R_vis ≤ 1 − V_w·c_w/C_sys,max. When storage explains ≥ 70 % of that C_sys (R_vis,max ≤ 0.3) the test is storage;
        // without either number the type is never reported as 'normal' (q-storage-gas, R_vis 0.009, was normal 0.74)
        var RvisMax = null, ev0 = ctx.events || {};
        if (Rvis === null) {
            var VwU = VwM > 0 ? VwM : (_fin(ev0.VwCwUsed) && ev0.VwCwUsed > 0 ? ev0.VwCwUsed : (VwT > 0 ? VwT : null));
            var Vi0 = _fin(ev0.Vi) ? ev0.Vi - (_fin(ev0.Vfill) ? ev0.Vfill : 0) : null, gEnd0 = v.G[n - 1];
            var g0c = d.gSpec ? d.gSpec.g0 : g0_(d.gType === 'a1' ? 1 : (d.gType === 'a05' ? 0.5 : d.alpha));
            if (VwU && Vi0 > 0 && _fin(d.mG) && d.mG > 0 && gEnd0 > 0) {
                var CsMax = Vi0 / (d.mG * (gEnd0 + 4 * g0c / PI));
                if (CsMax > 0) RvisMax = Math.max(0, 1 - VwU / CsMax);
            }
        }
        // unit log-log slope past ΔtD ≈ 1 (a constant-rate sink, not storage)
        var unit = [], dtSpan = [];
        for (i = 0; i < d.G.length; i++) if (d.usable[i] && d.dtD[i] >= 1 && d.G[i] <= gC && _fin(d.D[i]) && d.dpIsip[i] > 0) { unit.push(d.D[i] / d.dpIsip[i]); dtSpan.push(d.dt[i]); }
        var unitSlope = unit.length >= 4 && _median(unit) >= 0.9 && Math.log(dtSpan[dtSpan.length - 1] / dtSpan[0]) / LN10 >= 0.3;
        // bleed-off / hammer explanation of an early hump (tested first)
        var bleedExpl = true;
        if (hump) {
            bleedExpl = false;
            if (ctx.bleed && typeof ctx.bleed.curve === 'function') {
                var dtEnd = v.dt[hump.iEnd], b = ctx.bleed.curve(dtEnd);
                if (_fin(b) && b >= Math.max(1, 3 * d.sigma)) bleedExpl = true;
            }
            if (ctx.hammer && _fin(ctx.hammer.tEnd)) { var te = ctx.hammer.tEnd > d.ts ? ctx.hammer.tEnd - d.ts : ctx.hammer.tEnd; if (v.dt[hump.iEnd] <= te) bleedExpl = true; }
        }
        // scores: mean logistic margin over each class's conditions
        function mean(a) { var s = 0; a.forEach(function (x) { s += x; }); return a.length ? s / a.length : 0; }
        var hasHump = !!hump && !bleedExpl;
        var sc = {
            normal: mean([_mg(Math.abs(iota), 0.05, -1), _mg(Math.abs(curv), 0.05, -1), _mg(hasHump ? H : 0, 0.05, -1), _mg(Math.abs(DoverDref - 1), 0.1, -1)]),
            matrix: mean([_mg(Math.abs(iota), 0.05, -1), _mg(Math.abs(curv - ke.k), 0.05, -1), _mg(hasHump ? H : 0, 0.05, -1), _mg(-ke.k, 0.05, 1)]),
            pdl: mean([_mg(hasHump ? iota : -1, 0.0, 1, 0.05), _mg(hasHump ? H : 0, 0.05, 1), hasHump && returns ? 0.9 : 0.1]),
            tip: mean([_mg(iota, 0.1, 1), _mg(curv, curvExp - 0.1, -1), (!returns && Hnr > 0.05) ? 0.9 : 0.1]),
            hrContact: mean([_mg(curv, 0.1, 1), _mg(curv, 0.1, 1), Math.max(_mg(iota, -0.05, -1), _mg(DlateRatio, 1.05, 1, 0.05))]),
            storage: Rvis === null ? (RvisMax !== null && RvisMax <= 0.3 && cons && cons.mode === 'none' ? 0.9 : 0.1) : mean([(Rvis < 0.3 || (Rvis < 0.5 && VwR !== null && VwR > 2)) ? 0.95 : _mg(Rvis, 0.3, -1, 0.05), _mg(Math.abs(iota), 0.05, -1)])
        };
        if (!hasHump) sc.pdl = Math.min(sc.pdl, 0.2);
        if (Rvis !== null && Rvis > 0.7) sc.storage = Math.min(sc.storage, 0.2);
        if (Math.abs(ke.k) < 0.05) sc.matrix = Math.min(sc.matrix, sc.normal - 0.16);
        Object.keys(sc).forEach(function (k) { sc[k] = _r(Math.max(0, sc[k]), 4); });
        var names = { normal: 'normal', matrix: 'matrix', pdl: 'pdl', tip: 'tip', hrContact: 'hr-contact', storage: 'storage' };
        var order = Object.keys(sc).sort(function (a, b) { return sc[b] - sc[a]; });
        var top = order[0];
        if (sc.storage >= 0.5 && Rvis !== null && Rvis <= 0.7) top = 'storage';
        if (Rvis === null && RvisMax !== null && RvisMax <= 0.3 && cons && cons.mode === 'none') top = 'storage';
        var type = sc[top] >= 0.5 ? names[top] : 'undetermined';
        // no closure visibility (R_vis not computable) and the bound does not show storage: never 'normal' — the test may still
        // be storage-dominated, which is exactly when closure is not seen
        var consNone = !!(cons && cons.mode === 'none') && !frac && !_fin(ctx.Gc);
        if (consNone && Rvis === null && type === 'normal') type = 'undetermined';
        var alt = order.filter(function (k) { return k !== top && sc[k] >= 0.5 && sc[top] - sc[k] <= 0.15; }).map(function (k) { return names[k]; });
        // PDL block
        var pdl = null;
        if (hasHump) {
            var pfo = v.p[hump.iEnd], sB = hump.s, xs = [], ys = [];
            for (i = 0; i <= hump.iEnd; i++) if (v.s[i] > sB) { xs.push(v.p[i] - pfo); ys.push(Math.log(v.s[i] / sB)); }
            var lfp = xs.length >= 3 ? _linfit(xs, ys, 0, xs.length - 1, false) : null, Cd = lfp && lfp.b > 0 ? lfp.b : 0;
            pdl = { pfo: _r(pfo, 2), Cd: _sf(Cd, 4), multAtIsip: _r(Math.exp(Cd * (isip - pfo)), 3), sigmaHminusH: _r((1 - 2 * (ctx.inputs ? G.PRiSM_dfit_inputRanges.clamp(ctx.inputs).inputs.rock.nu : 0.25)) * (pfo - sigC), 1) };
            evid.push('A PDL hump spans G ' + _f1(v.G[0], 2) + ' to ' + _f1(v.G[hump.iEnd], 2) + ' (excess ' + _f1(H * 100, 0) + ' %); fissure opening about ' + _f0(pfo) + ' psia, C_d ' + _f1(Cd, 4) + ' 1/psi.');
        }
        var hr = null;
        if (type === 'hr-contact') {
            var Rs = curv + 1, hfI = ctx.inputs ? G.PRiSM_dfit_inputRanges.clamp(ctx.inputs).inputs.rock.hf : null;
            hr = { Rs: _r(Rs, 4), hf0FromPKN: _r(_fin(hfI) ? hfI * Math.sqrt(Math.max(Rs, 0)) : Math.sqrt(Math.max(Rs, 0)), 3), hf0FromKGD: _r(_fin(hfI) ? hfI * Math.max(Rs, 0) : Math.max(Rs, 0), 3) };
        }
        evid.unshift('dP/dG changes ' + _f1(curv * 100, 0) + ' % to closure; ' + _f1(curvExp * 100, 0) + ' % is expected (' + (ke.source === 'model' ? 'leak-off model run' : (ke.source === 'quasi-static' ? 'quasi-static estimate' : 'no estimate')) + (_fin(pr) ? ' at p_r = ' + _f0(pr) + ' psia' : '') + '); iota ' + _f1(iota, 3) + '; classified ' + type + '.');
        if (unitSlope) evid.push('The log-log slope stays near 1 past ΔtD 1: a near-constant-rate sink (leak?), not storage.');
        if (Rvis !== null) evid.push('Storage-consistent closure visibility R_vis ' + _f1(Rvis, 3) + (VwR !== null ? '; measured to theory V_w·c_w ' + _f1(VwR, 2) : '') + '.');
        if (type === 'tip') evid.push('Alternatives to tip extension: wrong shut-in time or tp, matrix PDL with a large pn, a slow valve, thermal effects, gas in the wellbore.');
        if (hump && bleedExpl) evid.push('The early hump is explained by friction bleed-off or the water hammer (G_min moved), not by PDL.');
        return {
            ok: true, type: type, scores: sc, alt: alt,
            features: { iota: _r(iota, 4), curv: _r(curv, 4), curvExp: _r(curvExp, 4), curvWb: _r(kwb, 4), H: _r(hasHump ? H : 0, 4), DoverDref: _r(DoverDref, 4), Rvis: _r(Rvis, 4), RvisMax: _r(RvisMax, 4), VwCwRatio: _r(VwR, 4),
                        unitSlopeSink: unitSlope, bleedOffExplained: bleedExpl },
            pdl: pdl, hr: hr, evidence: evid.map(_txt), ev: ['M1'], curvExpSource: ke.source, gcSource: gcSource
        };
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.8 / §6.2 consensus: stability grid (closed-form methods only) + block bootstrap, mode, label, counterfactual
    // ═════════════════════════════════════════════════════════════════════
    var CF_METHODS = ['tangent', 'sqrt', 'maxdpdg', 'compliance', 'crel', 'loglog', 'fissure'];
    var GRID_L = [0.05, 0.1, 0.2], GRID_TP = ['pump', 'breakdown', 'veq'], GRID_TS = [-1, 0, 1], GRID_EPS = [0.02, 0.05];
    var NAMES_M = { compliance: 'compliance', tangent: 'tangent', loglog: 'log-log', reopening: 'reopening', user: 'user' };
    function _stat(samples, sigGauge) {
        var s = _sortedFinite(samples);
        if (!s.length) return null;
        var p10 = _pct(s, 0.1), p50 = _pct(s, 0.5), p90 = _pct(s, 0.9);
        return { p10: _r(p10, 2), p50: _r(p50, 2), p90: _r(p90, 2), sigma: _r(Math.max((p90 - p10) / 2.563, 1, 2 * (sigGauge || 0)), 3), n: s.length };
    }
    // τ = max(τ_abs, f_σ·σ_c, f_n·p_n) (§4.8) and the family statistics with the σ_f floor max(1 psi, 2σ_gauge)
    G.PRiSM_dfit_tau = function (sigmaC, pn, inputs) {
        var I = G.PRiSM_dfit_inputRanges.clamp(inputs || {}).inputs;
        return Math.max(I.options.tau.abs, I.options.tau.fSigma * (_fin(sigmaC) ? sigmaC : 0), I.options.tau.fN * (_fin(pn) && pn > 0 ? pn : 0));
    };
    G.PRiSM_dfit_familyStat = function (samples, sigmaGauge) { return _stat(Array.isArray(samples) ? samples : [], sigmaGauge); };
    function _voters(picks) {        // one voting member per family (admissible); user picks win in their family
        var fam = {};
        (picks || []).forEach(function (pk) {
            if (!pk || !pk.ok || !pk.vote || !pk.admissible || !_fin(pk.p)) return;
            var f = pk.family;
            if (f !== 'F1' && f !== 'F2' && f !== 'F4') return;
            if (!fam[f] || pk.method === 'user' || (fam[f].method === 'loglog' && pk.method === 'compliance')) fam[f] = pk;
        });
        return fam;
    }
    // the work list of the grid (54 settings) and the bootstrap (50 resamples); each evaluates every closed-form method
    function _consensusPlan(picks, derivs, ctx) {
        var prep = ctx.prep, events = ctx.events, I = G.PRiSM_dfit_inputRanges.clamp(ctx.inputs || {}).inputs;
        var items = [];
        var canGrid = _okRes(prep) && _okRes(events) && Array.isArray(prep.t);
        if (canGrid) {
            var iS = _fin(events.iShut) ? events.iShut : null;
            if (iS === null) { iS = 0; for (var i = 0; i < prep.t.length; i++) if (prep.t[i] <= events.ts) iS = i; }
            GRID_L.forEach(function (L, li) {
                GRID_TP.forEach(function (tpC, ti) {
                    GRID_TS.forEach(function (sh) {
                        var j = _clampN(iS + sh, 1, prep.t.length - 2);
                        GRID_EPS.forEach(function (e) { items.push({ kind: 'grid', L: L, li: li, tp: tpC, ti: ti, ts: prep.t[j], sh: sh, eps: e }); });
                    });
                });
            });
            var nb = _fin(ctx.nBoot) ? ctx.nBoot : 50;
            for (var b = 0; b < nb; b++) items.push({ kind: 'boot', b: b });
        }
        return { items: items, canGrid: canGrid, I: I };
    }
    function _bootSetup(prep, derivs, seed) {
        // residuals of the falloff about a 7-point quadratic smoother (index space), block length from the lag-1 correlation
        var idx = derivs.idx || [], n = idx.length, p = idx.map(function (k) { return prep.pw[k]; }), sm = p.slice(), cfs = [-2, 3, 6, 7, 6, 3, -2];
        for (var i = 3; i < n - 3; i++) { var s = 0; for (var j = -3; j <= 3; j++) s += cfs[j + 3] * p[i + j]; sm[i] = s / 21; }
        var r = p.map(function (v, k) { return v - sm[k]; }), mr = 0;
        for (i = 3; i < n - 3; i++) mr += r[i];
        mr /= Math.max(1, n - 6);
        // winsorised at 3σ (σ from second differences): curvature left by the smoother at a closure kink is not noise
        var sg = Math.max(prep.sigma || 0, derivs.sigmaEff || 0, 1e-9), keep = new Array(n);
        // where the smoother misses by more than 5σ (a closure jump, a kink) the resamples keep the data (±3 samples, no
        // residual): smoothing across a break would move the break in every resample
        for (i = 3; i < n - 3; i++) if (Math.abs(r[i] - mr) > 5 * sg) for (j = i - 3; j <= i + 3; j++) keep[j] = 1;
        for (i = 0; i < n; i++) { if (keep[i]) { sm[i] = p[i]; r[i] = 0; } else r[i] = (i >= 3 && i < n - 3) ? _clampN(r[i] - mr, -3 * sg, 3 * sg) : 0; }
        var num = 0, den = 0; for (i = 4; i < n - 3; i++) { num += r[i] * r[i - 1]; den += r[i] * r[i]; }
        var rho = den > 0 ? _clampN(num / den, -0.99, 0.99) : 0, bl = Math.min(50, Math.max(5, Math.round(2 / (1 - Math.max(rho, 0)))));
        return { idx: idx, sm: sm, r: r, keep: keep, bl: bl, rng: _rng(seed == null ? 1 : seed), rho: rho };
    }
    function _bootPrep(prep, bs) {
        var n = bs.idx.length, pw = prep.pw.slice(), pool = [], i;
        for (i = 3; i < n - 3; i++) if (!bs.keep[i]) pool.push(bs.r[i]);
        var out = [], m = pool.length;
        while (out.length < n && m > 0) { var st = Math.floor(bs.rng() * Math.max(1, m - bs.bl + 1)); for (i = 0; i < bs.bl && out.length < n; i++) out.push(pool[Math.min(m - 1, st + i)]); }
        for (i = 0; i < n; i++) pw[bs.idx[i]] = bs.sm[i] + (bs.keep[i] ? 0 : (out[i] || 0));
        var cp = {}; for (var k in prep) cp[k] = prep[k];
        cp.pw = pw;
        return cp;
    }
    function _evalItem(it, base, st) {
        var prep = base.prep, ev = base.events, d, epsO = { compliance: base.eps.compliance, tangent: base.eps.tangent, loglog: base.eps.loglog };
        if (it.kind === 'grid') {
            var e2 = {}; for (var k in ev) e2[k] = ev[k];
            e2.ts = it.ts;
            e2.tp = { pump: it.ts - ev.tStart, breakdown: _fin(ev.tb) ? it.ts - ev.tb : null, veq: ev.tp ? ev.tp.veq : null };
            var key = it.L + '|' + it.tp + '|' + it.sh;      // the two ε settings share one derivative
            if (st.cache[key]) st.counts.cacheHits++;
            d = st.cache[key] || (st.cache[key] = _derivsCore(prep, e2, { L: it.L, tp: it.tp, alpha: base.alpha, alphaGeneral: base.alphaGeneral, isip: base.isip, gMin: base.gMinUser, hammer: base.hammer, bleed: base.bleed, _inner: true }));
            epsO.compliance = it.eps; epsO.tangent = it.eps;
        } else {
            d = _derivsCore(_bootPrep(prep, st.boot), ev, { L: base.L, tp: base.tp, alpha: base.alpha, alphaGeneral: base.alphaGeneral, isip: base.isip, gMin: base.gMinUser, hammer: base.hammer, bleed: base.bleed, _inner: true });
        }
        if (!_okRes(d)) return;
        st.counts.evals += CF_METHODS.length;     // one closed-form evaluation reads all seven methods
        // a grid setting is evaluated at its own L (Lpick = L): the noise-limited pick window of the nominal reading would
        // collapse L ∈ {0.05, 0.1, 0.2} onto one derivative and hide the window sensitivity
        var cf = _closedForm(d, it.kind === 'grid' ? { eps: epsO, Lpick: it.L } : { eps: epsO });
        st.counts.cf++;
        CF_METHODS.forEach(function (m) {
            var pk = cf.picks[m];
            if (pk && _fin(pk.p)) {
                st.samples[m].push(pk.p);
                st.tags[m].push(it);
                if (st.raw) (st.raw[m] = st.raw[m] || []).push(_fin(pk.pRaw) ? pk.pRaw : pk.p);
            }
        });
    }
    function _consensusFinish(picks, derivs, ctx, st) {
        var I = st.I, sigG = _fin(ctx.sigmaGauge) ? ctx.sigmaGauge : (derivs.sigma || 0);
        st.counts.vcInGrid = _vcCalls - (st.counts.vcBefore || 0);
        if (_isObj2(ctx._debug)) ctx._debug.st = st;
        var isip = _isipVal(ctx.isip); if (isip === null) isip = derivs.isip;
        var vot = _voters(picks), methods = {}, fams = { F0: null, F1: null, F2: null, F3: null, F4: null }, samples = { F1: [], F2: [], F4: [] };
        CF_METHODS.forEach(function (m) { var s = _stat(st.samples[m], sigG); if (s) methods[m] = s; });
        // family stats from the one voting member (grid + bootstrap samples), F4 from its ramp band, a user pick as a point
        ['F1', 'F2', 'F4'].forEach(function (f) {
            var pk = vot[f];
            if (!pk) return;
            if (pk.method === 'user') { fams[f] = { p10: pk.p, p50: pk.p, p90: pk.p, sigma: _r(Math.max(1, 2 * sigG), 3), n: 1 }; samples[f] = [pk.p]; return; }
            if (f === 'F4') {
                var b = pk.band || { p10: pk.p - 1.2816 * (pk.se || 5), p50: pk.p, p90: pk.p + 1.2816 * (pk.se || 5) };
                fams.F4 = { p10: _r(b.p10, 2), p50: _r(b.p50, 2), p90: _r(b.p90, 2), sigma: _r(Math.max((b.p90 - b.p10) / 2.563, 1, 2 * sigG), 3), n: 1 };
                samples.F4 = [b.p10, b.p50, b.p90].map(function (x) { return _r(x, 2); });
                return;
            }
            var arr = st.samples[pk.method] && st.samples[pk.method].length ? st.samples[pk.method] : [pk.p];
            fams[f] = _stat(arr, sigG);
            // the pick's own noise-limited uncertainty (hinge SSR profile or vertex se) is added in quadrature to the grid and
            // bootstrap band: a residual bootstrap about a local smoother keeps the realisation's slow noise in every
            // resample and so under-reports how far noise can move an onset that is only weakly curved
            if (fams[f] && _fin(pk.se) && pk.se > 0) {
                var e = 1.2816 * pk.se, m50 = fams[f].p50, lo = m50 - Math.sqrt(Math.pow(m50 - fams[f].p10, 2) + e * e), hi = m50 + Math.sqrt(Math.pow(fams[f].p90 - m50, 2) + e * e);
                fams[f].p10 = _r(lo, 2); fams[f].p90 = _r(hi, 2); fams[f].sigma = _r(Math.max((hi - lo) / 2.563, 1, 2 * (sigG || 0)), 3);
            }
            samples[f] = arr.map(function (x) { return _r(x, 2); });
        });
        // model-form floor of a voting family band: σ ≥ max(1 psi, 2σ_gauge, 0.25 % of p_n, 0.05 % of the closure). On noise-free
        // data the band came only from the hinge se (≈ 0.5 psi) and missed the method's own model-form error (Example B +3.25 psi)
        ['F1', 'F2'].forEach(function (f) {
            var st0 = fams[f]; if (!st0 || !_fin(st0.p50)) return;
            var pnF = _fin(isip) ? Math.max(0, isip - st0.p50) : 0, fl = Math.max(1, 2 * (sigG || 0), 0.0025 * pnF, 0.0005 * Math.abs(st0.p50)), e2 = 1.2816 * fl;
            if (st0.p50 - st0.p10 < e2) st0.p10 = _r(st0.p50 - e2, 2);
            if (st0.p90 - st0.p50 < e2) st0.p90 = _r(st0.p50 + e2, 2);
            st0.sigma = _r(Math.max(st0.sigma || 0, fl), 3);
        });
        // cross-check families (no vote): F0 fissure from its samples, F3 from the LM CI / model pick
        if (methods.fissure) fams.F0 = methods.fissure;
        (picks || []).forEach(function (pk) {
            if (pk && pk.family === 'F3' && !fams.F3 && _fin(pk.p)) {
                var b3 = pk.band || { p10: pk.p, p50: pk.p, p90: pk.p };
                fams.F3 = { p10: b3.p10, p50: b3.p50, p90: b3.p90, sigma: _r(Math.max((b3.p90 - b3.p10) / 2.563, 1, 2 * sigG), 3), n: 1 };
            }
        });
        // uncorrected F4 bounds (upper-side, not voting)
        var f4u = (picks || []).filter(function (pk) { return pk && pk.method === 'reopening' && !pk.vote && pk.admissible && _fin(pk.p); });
        var V = ['F1', 'F2', 'F4'].filter(function (f) { return fams[f] && vot[f]; });
        var p50s = V.map(function (f) { return fams[f].p50; }), sigC0 = p50s.length ? p50s.reduce(function (a, b) { return a + b; }, 0) / p50s.length : null;
        var pn0 = (sigC0 !== null && _fin(isip)) ? isip - sigC0 : 0;
        var tau = Math.max(I.options.tau.abs, I.options.tau.fSigma * (sigC0 || 0), I.options.tau.fN * Math.max(pn0, 0));
        var w = 0, s = 0, g = 0;
        V.forEach(function (f) { w = Math.max(w, (fams[f].p90 - fams[f].p10) / 2); });
        for (var a = 0; a < V.length; a++) for (var b2 = a + 1; b2 < V.length; b2++) s = Math.max(s, Math.abs(fams[V[a]].p50 - fams[V[b2]].p50));
        // grid table: family P50 per (L, tp) cell (median over t_s and ε)
        var grid = { F1: [], F2: [] }, unstable = false;
        ['F1', 'F2'].forEach(function (f) {
            var pk = vot[f], m = pk ? pk.method : null, cells = [];
            for (var li = 0; li < 3; li++) { var row = []; for (var ti = 0; ti < 3; ti++) row.push(null); cells.push(row); }
            if (m && st.tags[m]) {
                // the cells show the family reading per setting; the spread g is taken on the pre-refinement detection points
                var bucket = {}, bucketR = {}, rawM = st.raw && st.raw[m] && st.raw[m].length === st.samples[m].length ? st.raw[m] : st.samples[m];
                st.tags[m].forEach(function (it, k) { if (it.kind !== 'grid') return; var key = it.li + '_' + it.ti; (bucket[key] = bucket[key] || []).push(st.samples[m][k]); (bucketR[key] = bucketR[key] || []).push(rawM[k]); });
                var vals = [];
                Object.keys(bucket).forEach(function (key) { var md = _median(bucket[key]), q = key.split('_'); cells[+q[0]][+q[1]] = _r(md, 1); vals.push(_median(bucketR[key])); });
                if (vals.length) { var gg = (Math.max.apply(null, vals) - Math.min.apply(null, vals)) / 2; g = Math.max(g, gg); }
            }
            grid[f] = cells;
        });
        unstable = g > 2.5 * tau;
        // mode
        var mode, value = null, range = null;
        function overlap(x, y) { return x.p10 <= y.p90 && y.p10 <= x.p90; }
        if (!V.length) mode = 'none';
        else {
            var allOverlap = true;
            for (a = 0; a < V.length; a++) for (b2 = a + 1; b2 < V.length; b2++) if (!overlap(fams[V[a]], fams[V[b2]])) allOverlap = false;
            var ws = 0, wv = 0;
            V.forEach(function (f) { var sg = fams[f].sigma; ws += 1 / (sg * sg); wv += fams[f].p50 / (sg * sg); });
            var cand = wv / ws, f4below = f4u.filter(function (pk) { return pk.p < cand; });
            if (s <= 2.5 * tau && allOverlap && !f4below.length) { mode = 'single'; value = _r(cand, 2); }
            else {
                mode = 'range';
                var ends = V.map(function (f) { return { f: f, st: fams[f] }; });
                f4below.forEach(function (pk) { var b4 = pk.band || { p10: pk.p - 1.2816 * (pk.se || 5), p50: pk.p, p90: pk.p + 1.2816 * (pk.se || 5) }; ends.push({ f: 'F4', st: { p10: b4.p10, p50: pk.p, p90: b4.p90 } }); if (!fams.F4) fams.F4 = { p10: _r(b4.p10, 2), p50: _r(pk.p, 2), p90: _r(b4.p90, 2), sigma: _r(Math.max((b4.p90 - b4.p10) / 2.563, 1), 3), n: 1 }; });
                ends.sort(function (x, y) { return x.st.p50 - y.st.p50; });
                var lowE = ends[0], hiE = ends[ends.length - 1];
                var lo = lowE.st.p10, hi = hiE.st.p90;
                if (!(lo < hi)) { lo = Math.min(lowE.st.p10, hiE.st.p10) - 0.5; hi = Math.max(lowE.st.p90, hiE.st.p90) + 0.5; }
                range = { lo: _r(lo, 2), hi: _r(hi, 2), medians: { low: _r(lowE.st.p50, 2), high: _r(hiE.st.p50, 2) }, lowFamily: lowE.f, highFamily: hiE.f };
            }
        }
        // the storage-consistent chain at the value (R_vis, χ) for the label
        var pRef = value !== null ? value : (range ? range.medians.high : null), fr = null;
        if (pRef !== null) {
            var fc = {}; for (var k in ctx) fc[k] = ctx[k];
            fr = G.PRiSM_dfit_frac(pRef, derivs, fc);
            if (!_okRes(fr)) fr = null;
        }
        var Rvis = fr ? fr.Rvis : null, chi = fr ? fr.chi : null;
        var mainPk = vot.F1 || vot.F2 || vot.F4 || null;
        var gEnd = derivs.G[derivs.G.length - 1], past = (mainPk && mainPk.G > 0) ? Math.log(gEnd / mainPk.G) / LN10 : null;
        var cf = ctx._closed || _closedForm(derivs, { eps: I.options.eps });
        var noise = cf.picks.tangent ? cf.picks.tangent.noise : null;
        var dep = cf.picks.compliance && !cf.picks.compliance.down ? cf.picks.compliance.departRel : null;
        var depWeak = (dep !== null && cf.picks.compliance) ? dep < 3 * (derivs.sigmaY || 0) / Math.max(cf.picks.compliance.line.b * cf.picks.compliance.G, 1e-9) : false;
        var overlapFlag = !!(ctx.prep && Array.isArray(ctx.prep.flags) && ctx.prep.flags.some(function (f) { return f.code === 'VACUUM' || f.code === 'THERMAL'; }));
        // every voting-family candidate vetoed (§4.8 bounds): mode none, but the picks did depart; K1 says so, lists them and the
        // binding limit, and K10 is read at the vetoed candidates (it used to say 'above both frictional-limit lines')
        var vetoed = [];
        if (mode === 'none') (picks || []).forEach(function (pk) {
            if (!pk || !pk.ok || !pk.vetoedVote || pk.admissible !== false || !_fin(pk.p)) return;
            if (pk.family !== 'F1' && pk.family !== 'F2' && pk.family !== 'F4') return;
            var vt = Array.isArray(pk.vetoes) && pk.vetoes.length ? pk.vetoes[0] : null;
            vetoed.push({ method: pk.method, family: pk.family, p: _r(pk.p, 2), rule: vt ? vt.rule : 'bounds', limit: vt && _fin(vt.limit) ? _r(vt.limit, 1) : null });
        });
        var pRefB = pRef !== null ? pRef : (vetoed.length ? _median(vetoed.map(function (x) { return x.p; })) : null);
        var br = pRefB !== null ? G.PRiSM_dfit_bounds(pRefB, { isip: isip, pi: ctx.pi, piBracket: ctx.piBracket, inputs: ctx.inputs, well: ctx.well }) : null;
        var fric = br && _okRes(br) ? br.frictional : { veto: null, warn: null };
        var fricFired = !!(br && _okRes(br) && (br.vetoes.some(function (x) { return x.rule === 'frictional'; }) || br.warnings.some(function (x) { return x.rule === 'frictional'; })));
        var k1None = 'Mode none: dP/dG never departs; closure is not estimable.';
        if (vetoed.length) {
            var lst = vetoed.slice(0, 3).map(function (x) { return (NAMES_M[x.method] || x.method) + ' ' + _f0(x.p); }).join(', ');
            var bind = vetoed.filter(function (x) { return x.limit !== null; })[0];
            k1None = 'Mode none: all closure candidates vetoed (' + lst + ' psia)' + (bind ? ' by the ' + bind.rule + ' limit ' + _f0(bind.limit) + ' psia' : '') + '; closure is not estimable.';
        }
        var rules = [
            { id: 'K1', fired: mode !== 'single', value: null, threshold: null, text: mode === 'single' ? 'Mode single: the family medians differ by less than 2.5 τ and the bands overlap.' : (mode === 'range' ? 'Mode range: the families do not agree within 2.5 τ or their bands do not overlap.' : k1None) },
            { id: 'K2', fired: s > tau, value: _r(s, 3), threshold: _r(tau, 3), text: 'Family separation s ' + _f1(s, 1) + ' psi against τ ' + _f1(tau, 1) + ' psi.' },
            { id: 'K3', fired: w > tau, value: _r(w, 3), threshold: _r(tau, 3), text: 'Largest voting-family half-width w ' + _f1(w, 1) + ' psi against τ.' },
            { id: 'K4', fired: g > tau, value: _r(g, 3), threshold: _r(tau, 3), text: 'Stability-grid spread g ' + _f1(g, 1) + ' psi against τ.' },
            { id: 'K5', fired: !(Rvis > 0.7), value: _r(Rvis, 3), threshold: 0.7, text: Rvis === null ? 'Closure visibility R_vis could not be computed (volume or storage missing).' : 'Storage-consistent closure visibility R_vis ' + _f1(Rvis, 3) + ' (high needs above 0.7).' },
            { id: 'K6', fired: !(past >= 0.3), value: _r(past, 3), threshold: 0.3, text: 'Data past the pick: ' + _f1(past, 2) + ' G-decade (high needs 0.3).' },
            { id: 'K7', fired: !(noise !== null && noise < 0.02), value: _r(noise, 4), threshold: 0.02, text: 'Derivative noise at the pick ' + _f1((noise || 0) * 100, 2) + ' % (high needs below 2 %).' },
            { id: 'K8', fired: !(chi >= 0.9 && chi <= 1.1), value: _r(chi, 3), threshold: null, text: 'Consistency ratio χ ' + _f1(chi, 3) + ' (high needs 0.9 to 1.1).' },
            { id: 'K9', fired: overlapFlag, value: null, threshold: null, text: overlapFlag ? 'A vacuum or thermal flag overlaps the pick window.' : 'No vacuum or thermal flag overlaps the pick window.' },
            { id: 'K10', fired: fricFired, value: _r(fric.veto, 1), threshold: _r(fric.warn, 1), text: fricFired ? 'The closure lies below a frictional-limit line.' : 'The closure lies above both frictional-limit lines.' }
        ];
        rules.forEach(function (r) { r.text = _txt(r.text); });
        var conf;
        if (mode === 'none') conf = 'not-estimable';
        else {
            var low = w > 2.5 * tau || g > 2.5 * tau || (Rvis !== null && Rvis < 0.3) || depWeak || overlapFlag;
            var high = mode === 'single' && !rules.slice(1).some(function (r) { return r.fired; });
            conf = low ? 'low' : (high ? 'high' : 'medium');
        }
        // preferred reading from the classifier
        var cls = ctx.classification, preferred = null, prefWhy = null, ctype = cls && cls.type;
        if (mode === 'single') prefWhy = 'Families agree' + (ctype ? ' (' + ctype + ' leak-off).' : '.');
        else if (mode === 'range') {
            if (ctype === 'hr-contact') prefWhy = 'Ambiguous: the F1 end is the contact (compliance) reading, the F2 end the end of stiffening (tangent) reading.';
            else if (ctype === 'pdl') { prefWhy = 'PDL: the reading after the hump is preferred.'; preferred = vot.F2 ? 'F2' : null; }
            else if (ctype === 'storage') prefWhy = 'Low visibility: storage masks the closure signature.';
            else prefWhy = 'The families differ; no reading is preferred by the classifier.';
            if (fams.F4 && vot.F4) {
                var dF1 = fams.F1 ? Math.abs(fams.F4.p50 - fams.F1.p50) : INF, dF2 = fams.F2 ? Math.abs(fams.F4.p50 - fams.F2.p50) : INF;
                preferred = dF1 <= dF2 ? 'F1' : 'F2';
                prefWhy = 'Reopening ' + _f0(fams.F4.p50) + ' psia, near-wellbore corrected, supports the ' + preferred + ' end.';
            }
        }
        // counterfactual sentence from the stability samples (no refit)
        var counterfactual = null;
        var mF = vot.F1 && st.tags[vot.F1.method] ? 'F1' : (vot.F2 && st.tags[vot.F2.method] ? 'F2' : null);
        if (mF && st.samples[vot[mF].method].length > 1) {
            var meth = vot[mF].method, tags = st.tags[meth], sv = st.samples[meth], knobs = { L: 'L', tp: 'tp', ts: 'sh', eps: 'eps' }, bestK = null, bestE = -1, bestSet = null;
            Object.keys(knobs).forEach(function (kn) {
                var grp = {};
                tags.forEach(function (it, k2) { if (it.kind !== 'grid') return; var key = String(it[knobs[kn]]); (grp[key] = grp[key] || []).push(sv[k2]); });
                var meds = Object.keys(grp).map(function (key) { return { key: key, m: _median(grp[key]) }; });
                if (meds.length < 2) return;
                var mx = Math.max.apply(null, meds.map(function (x) { return x.m; })), mn = Math.min.apply(null, meds.map(function (x) { return x.m; }));
                if (mx - mn > bestE) { bestE = mx - mn; bestK = kn; var dev = meds.slice().sort(function (x, y) { return Math.abs(y.m - fams[mF].p50) - Math.abs(x.m - fams[mF].p50); })[0]; bestSet = dev.key; }
            });
            var gs = []; tags.forEach(function (it, k2) { if (it.kind === 'grid') gs.push(sv[k2]); });
            var moveMax = gs.length ? Math.max(Math.max.apply(null, gs) - fams[mF].p50, fams[mF].p50 - Math.min.apply(null, gs)) : 0;
            var other = mF === 'F1' ? 'F2' : 'F1', enter = null;
            if (fams[other] && vot[other] && st.tags[vot[other].method]) {
                tags.forEach(function (it, k2) {
                    if (enter || it.kind !== 'grid') return;
                    var x = sv[k2];
                    if (x >= fams[other].p10 && x <= fams[other].p90) enter = it;
                });
            }
            if (bestK) {
                var setTxt = bestK === 'ts' ? (bestSet === '0' ? 'the detected shut-in' : 'shut-in ' + (bestSet > 0 ? '+' : '') + bestSet + ' sample') : bestK + ' = ' + bestSet;
                var t1 = 'Within the tested settings the ' + NAMES_M[meth] + ' pick moves at most ' + _f1(moveMax, 0) + ' psi (largest effect: ' + bestK + ')';
                var t2;
                if (!fams[other] || !vot[other]) t2 = '.';
                else if (enter) t2 = '; at ' + (enter.L !== undefined ? 'L = ' + enter.L + ', tp ' + enter.tp + ', ε ' + enter.eps : 'one setting') + ' it enters the ' + NAMES_M[vot[other].method] + ' band.';
                else t2 = '; no tested setting brings it into the ' + NAMES_M[vot[other].method] + ' band, so the difference is interpretive.';
                var settle = '';
                if (mode === 'range') settle = ctype === 'storage' ? ' A bottomhole gauge with less wellbore volume would settle it.' : (ctype === 'pdl' ? ' A longer shut-in past the hump would settle it.' : ' A second-cycle reopening ramp would settle it.');
                var txt = t1 + t2 + settle;
                if (txt.length > 299) txt = t1 + t2;
                counterfactual = { knob: bestK, setting: setTxt, text: _txt(txt) };
            }
        }
        var forecast = null;
        if (mode === 'none' || (ctx.inputs && _fin(I.priors.sigmaGrad) && _fin(I.datumTvd))) {
            var fc2 = G.PRiSM_dfit_forecastClosure(derivs, { isip: isip, inputs: ctx.inputs }, ctx.forecastSigmas);
            forecast = Array.isArray(fc2) && fc2.length ? fc2 : null;
        }
        var calTab = G.PRiSM_dfit_cal, calibrated = !!(calTab && calTab.calibrated === true), hitRate = null;
        if (calibrated && mode !== 'none' && calTab.hitRate && calTab.hitRate[mode] && calTab.hitRate[mode][conf]) {
            var hrr = calTab.hitRate[mode][conf];
            if (_isObj2(hrr) && _fin(hrr.p)) hitRate = { p: hrr.p, lo: hrr.lo, hi: hrr.hi, n: hrr.n, mode: mode };
        }
        return {
            ok: true, mode: mode, value: value, range: range, families: fams, tau: _r(tau, 2), metrics: { w: _r(w, 2), s: _r(s, 2), g: _r(g, 2) },
            bimodal: mode === 'range' && s > 2.5 * tau, preferred: preferred, preferredWhy: prefWhy ? _txt(prefWhy) : null, confidence: conf,
            calibrated: calibrated, hitRate: hitRate, rules: rules,
            stability: { L: GRID_L.slice(), tp: GRID_TP.slice(), grid: grid, unstable: unstable },
            samples: samples, counterfactual: counterfactual, frictional: { veto: fric.veto, warn: fric.warn }, forecast: forecast, ev: ['C1', 'K1'], vetoed: vetoed,
            methods: methods, counts: { evals: st.counts.evals, refits: st.counts.refits, draws: 0 }, label: conf === 'not-estimable' ? conf : conf + ' (uncalibrated rule label)',
            chain: fr ? { Rvis: fr.Rvis, chi: fr.chi, pn: fr.pn } : null
        };
    }
    function _consensusJob(picks, derivs, ctx) {
        ctx = ctx || {};
        var bad = null;
        if (!_okRes(derivs) || !Array.isArray(derivs.G)) bad = _fail('BAD_INPUT', 'Derivatives are needed for the consensus.', ['derivs']);
        else if (!Array.isArray(picks)) bad = _fail('BAD_INPUT', 'A list of closure picks is needed.', ['picks']);
        var plan = bad ? null : _consensusPlan(picks, derivs, ctx), k = 0, done = !!bad, result = bad, cancelled = false;
        var st = null, base = null;
        if (!bad) {
            var I = plan.I;
            st = { I: I, counts: { evals: 0, refits: 0, cf: 0, cacheHits: 0, vcBefore: _vcCalls }, samples: {}, tags: {}, raw: {}, boot: null, cache: {} };
            CF_METHODS.forEach(function (m) { st.samples[m] = []; st.tags[m] = []; st.raw[m] = []; });
            base = { prep: ctx.prep, events: ctx.events, L: derivs.L, tp: derivs.tpChoice, alpha: I.options.alpha, alphaGeneral: I.options.alphaGeneral,
                     isip: _isipVal(ctx.isip) !== null ? _isipVal(ctx.isip) : derivs.isip, gMinUser: _fin(I.options.gMin) ? I.options.gMin : null,
                     hammer: ctx.hammer, bleed: ctx.bleed, eps: I.options.eps };
            if (plan.canGrid) st.boot = _bootSetup(ctx.prep, derivs, _fin(ctx.seed) ? ctx.seed : I.options.unc.seed);
            // the default-settings picks enter the samples of methods the grid never found (no grid possible)
            if (!plan.canGrid) (picks || []).forEach(function (pk) { if (pk && st.samples[pk.method] && _fin(pk.p)) { st.samples[pk.method].push(pk.p); st.tags[pk.method].push({ kind: 'pick' }); } });
        }
        var total = plan ? plan.items.length : 0;
        return {
            step: function () {
                if (done || cancelled) return { done: true, progress: 1, label: cancelled ? 'cancelled' : 'consensus' };
                try {
                    var end = Math.min(total, k + 8);
                    for (; k < end; k++) _evalItem(plan.items[k], base, st);
                    if (k >= total) { result = _consensusFinish(picks, derivs, ctx, st); done = true; }
                } catch (e) { result = _fail('ENGINE_ERROR', 'Consensus failed: ' + String(e && e.message || e).slice(0, 200)); done = true; }
                return { done: done, progress: total ? Math.min(1, k / total) : 1, label: done ? 'consensus' : 'stability grid ' + k + ' of ' + total };
            },
            result: function () { return result; },
            cancel: function () { cancelled = true; if (!done) result = _fail('CANCELLED', 'The consensus was cancelled.'); }
        };
    }
    G.PRiSM_dfit_consensusJob = function (picks, derivs, ctx) { try { return _consensusJob(picks, derivs, ctx); } catch (e) { var r = _fail('ENGINE_ERROR', String(e && e.message || e)); return { step: function () { return { done: true, progress: 1, label: 'error' }; }, result: function () { return r; }, cancel: function () {} }; } };
    G.PRiSM_dfit_consensus = _safe(function (picks, derivs, ctx) {
        var job = G.PRiSM_dfit_consensusJob(picks, derivs, ctx), guard = 0;
        while (!job.step().done && guard++ < 100000) { /* run to completion */ }
        return job.result();
    });
    G.PRiSM_dfit_consensusLite = _safe(function (picks, derivs, ctx) {
        ctx = ctx || {};
        var vot = _voters(picks), I = G.PRiSM_dfit_inputRanges.clamp(ctx.inputs || {}).inputs, fam = { F1: null, F2: null, F4: null };
        ['F1', 'F2', 'F4'].forEach(function (f) { if (vot[f]) fam[f] = { p50: vot[f].p }; });
        var V = ['F1', 'F2', 'F4'].filter(function (f) { return fam[f]; });
        if (!V.length) return { mode: 'none', value: null, range: null, families: fam, confidence: 'stale' };
        var ps = V.map(function (f) { return fam[f].p50; }), mn = Math.min.apply(null, ps), mx = Math.max.apply(null, ps), mean = ps.reduce(function (a, b) { return a + b; }, 0) / ps.length;
        var isip = _isipVal(ctx.isip); if (isip === null && derivs && _fin(derivs.isip)) isip = derivs.isip;
        var tau = Math.max(I.options.tau.abs, I.options.tau.fSigma * mean, I.options.tau.fN * Math.max(0, (isip || mean) - mean));
        var f4u = (picks || []).some(function (pk) { return pk && pk.method === 'reopening' && !pk.vote && pk.admissible && pk.p < mean; });
        if (mx - mn <= 2.5 * tau && !f4u) return { mode: 'single', value: _r(mean, 2), range: null, families: fam, confidence: 'stale' };
        var lo = mn, hi = mx;
        (picks || []).forEach(function (pk) { if (pk && pk.method === 'reopening' && !pk.vote && pk.p < lo) lo = pk.p; });
        if (!(lo < hi)) hi = lo + 1;
        return { mode: 'range', value: null, range: { lo: _r(lo, 2), hi: _r(hi, 2) }, families: fam, confidence: 'stale' };
    });
    // the closure used downstream: a user pick in picks wins (source 'user'), else the consensus value, else the F1 / F2
    // end chosen for hand-offs (mode 'family'), else the upper family median of a range
    G.PRiSM_dfit_chooseClosure = function (consensus, picks, choice) {
        var u = (picks || []).filter(function (pk) { return pk && pk.method === 'user' && _fin(pk.p); })[0];
        if (u) return { p: u.p, family: u.family, method: 'user', source: 'user', mode: 'user' };
        if (!_isObj2(consensus) || consensus.ok === false) return null;
        if (consensus.mode === 'single') return { p: consensus.value, family: null, method: 'consensus', source: 'auto', mode: 'consensus' };
        if (consensus.mode === 'range') {
            var f = (choice === 'F1' || choice === 'F2' || choice === 'F4') ? choice : (consensus.preferred || consensus.range.highFamily);
            var st = consensus.families[f];
            return st ? { p: st.p50, family: f, method: 'consensus', source: 'auto', mode: 'family' } : null;
        }
        return null;
    };
    // what-if candidates: the chosen closure, each voting family median, a user value and the what-if marker
    G.PRiSM_dfit_whatIfCandidates = function (consensus, picks, whatIfP) {
        var out = [], ch = G.PRiSM_dfit_chooseClosure(consensus, picks);
        if (ch) out.push({ label: ch.source === 'user' ? 'User closure' : 'Consensus', family: ch.family, p: ch.p, method: ch.method });
        if (_isObj2(consensus) && consensus.families) {
            if (consensus.families.F1) out.push({ label: 'F1 compliance', family: 'F1', p: consensus.families.F1.p50, method: 'compliance' });
            if (consensus.families.F2) out.push({ label: 'F2 tangent', family: 'F2', p: consensus.families.F2.p50, method: 'tangent' });
            if (consensus.families.F4) out.push({ label: 'F4 reopening', family: 'F4', p: consensus.families.F4.p50, method: 'reopening' });
        }
        if (_fin(whatIfP)) out.push({ label: 'What-if ' + _f0(whatIfP) + ' psia', family: null, p: whatIfP, method: 'user' });
        return out;
    };

    // ═════════════════════════════════════════════════════════════════════
    // §4.10 extras: spurt with independent geometry, thermal sensitivity, injection net-pressure slope
    // ═════════════════════════════════════════════════════════════════════
    // S_p = [V_i* − C_sys·p_n − 2·r_p·A_f·g0·CL·√tp] / (2·r_p·A_f), with C_sys = A_f·c_f + V_w·c_w and CL from m_G (gal/100 ft²);
    // negative → "geometry inconsistent" (never clipped). geo {Af (ft², one face), cf (ft/psi), rp}
    G.PRiSM_dfit_spurt = _safe(function (frac, derivs, geo) {
        if (!_okRes(frac) || !_okRes(derivs) || !_isObj2(geo) || !_fin(geo.Af) || !_fin(geo.cf) || geo.Af <= 0) return _fail('BAD_INPUT', 'Frac outputs, derivatives and an independent geometry (A_f, c_f) are needed.', ['geo']);
        var rp = _fin(geo.rp) && geo.rp > 0 ? geo.rp : 1, tpMin = derivs.tp * 60;
        var VwCwFt = (_fin(frac.VwCw) ? frac.VwCw : 0) * BBL, Csys = geo.Af * geo.cf + VwCwFt;               // ft³/psi
        var mG = _fin(frac.mG) ? frac.mG : derivs.mG, pn = frac.pn, Vstar = (_fin(frac.ViStar) ? frac.ViStar : 0) * BBL;
        var CL = 2 * mG * Csys / (PI * rp * geo.Af * Math.sqrt(tpMin));                                          // ft/√min
        var g0 = derivs.gSpec ? derivs.gSpec.g0 : g0_(derivs.gType === 'a1' ? 1 : (derivs.gType === 'a05' ? 0.5 : derivs.alpha));
        var Sp = (Vstar - Csys * pn - 2 * rp * geo.Af * g0 * CL * Math.sqrt(tpMin)) / (2 * rp * geo.Af) * 748.05;
        if (Math.abs(Sp) < 1e-3) Sp = 0;      // rounding of the inputs
        return { ok: true, value: _r(Sp, 4), CL: _sf(CL, 5), Csys: _sf(Csys / BBL, 5), consistent: Sp >= 0,
                 note: _txt(Sp >= 0 ? 'Spurt from the independent geometry: ' + _f1(Sp, 3) + ' gal/100 ft².' : 'Negative spurt (' + _f1(Sp, 3) + ' gal/100 ft²): the geometry is inconsistent with the falloff.') };
    });
    // dp/dT ≈ V_w·β/C_sys before closure and β/c_sys after (C_sys → V_w·c_sys), β = ∂ln B_w/∂T (Meehan, 16, at call time)
    G.PRiSM_dfit_thermal = _safe(function (frac, ctx) {
        ctx = ctx || {};
        var T = _fin(ctx.TmeanF) ? ctx.TmeanF : 100, p = _fin(ctx.pMean) ? ctx.pMean : (_okRes(frac) && _fin(frac.pClosure) ? frac.pClosure : 5000);
        var pv = G.PRiSM_pvt_correlations, beta = null, src = 'default';
        if (pv && typeof pv.Bw_meehan === 'function') {
            var b1 = pv.Bw_meehan(p, T - 1), b2 = pv.Bw_meehan(p, T + 1);
            if (_fin(b1) && _fin(b2) && b1 > 0 && b2 > 0) { beta = (Math.log(b2) - Math.log(b1)) / 2; src = 'Bw correlation'; }
        }
        if (!_fin(beta)) beta = 2.3e-4;
        var notes = [];
        if (p > 5000 || T > 260) notes.push('The water formation-volume correlation is fitted to p ≤ 5,000 psia and T ≤ 260 °F: correlation range exceeded.');
        var cSys = _fin(ctx.cSys) ? ctx.cSys : null, Vw = _fin(ctx.VwFt3) ? ctx.VwFt3 : null;     // 1/psi, ft³
        var before = (Vw !== null && _okRes(frac) && _fin(frac.Csys)) ? Vw * beta / (frac.Csys * BBL) : null;
        var after = cSys ? beta / cSys : null;
        return { ok: true, beta: _sf(beta, 4), betaSource: src, beforeClosure: _r(before, 3), afterClosure: _r(after, 2), notes: notes };
    });
    // injection net-pressure slope (indicative): d ln(p − σ_c)/d ln(t − t_start) over the propagation period after breakdown
    G.PRiSM_dfit_netPressureSlope = _safe(function (prep, events, sigmaC) {
        if (!_okRes(prep) || !_okRes(events) || !_fin(sigmaC)) return _fail('BAD_INPUT', 'Prepared data, events and a closure stress are needed.', ['sigmaC']);
        var t0 = _fin(events.tb) ? events.tb : events.tStart, xs = [], ys = [];
        for (var i = 0; i < prep.t.length; i++) {
            var t = prep.t[i];
            if (t <= t0 || t > events.ts || prep.pw[i] <= sigmaC) continue;
            if (t - t0 < 0.2 * (events.ts - t0)) continue;                    // past the breakdown transient
            xs.push(Math.log(t - events.tStart)); ys.push(Math.log(prep.pw[i] - sigmaC));
        }
        if (xs.length < 4) return _fail('SHORT', 'Too few pumping samples above the closure stress.', ['p']);
        var lf = _linfit(xs, ys, 0, xs.length - 1, false), s = lf ? lf.b : null;
        var reading = !_fin(s) ? 'undetermined' : (s >= 0.15 && s <= 0.3 ? 'contained height (PKN-like)' : (s < -0.02 ? 'KGD / radial or height growth' : (Math.abs(s) <= 0.05 ? 'barrier or fissures (near-constant)' : (s > 0.5 ? 'restriction' : 'transitional'))));
        return { ok: true, slope: _r(s, 4), n: xs.length, reading: reading, note: 'Indicative: the injection net-pressure slope reading (Nolte and Smith).' };
    });
  })(Math, isFinite, Array, Object, JSON, String);
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis, bad = [];
    function near(a, b, tol, what) { if (!(typeof a === 'number' && Math.abs(a - b) <= tol)) bad.push(what + ' ' + a + ' vs ' + b); }
    near(G.PRiSM_dfit_G(1, 0.5), 1.27324, 1e-5, 'G(1, ½)');
    near(G.PRiSM_dfit_G(100, 1), 23.8307, 1e-4, 'G(100, 1)');
    near(G.PRiSM_dfit_Ginv(18, 0.5), 61.019, 1e-3, 'G⁻¹(18, ½)');
    near(G.PRiSM_dfit_g.quad(10, 0.5000001), G.PRiSM_dfit_g(10, 0.5), 1e-5, 'quadrature');
    var c = G.PRiSM_dfit_inputRanges.clamp({ fluid: { muCp: 1e12 }, options: { unc: { n: 1500.4 } } });
    if (c.inputs.fluid.muCp !== 5000 || c.inputs.options.unc.n !== 1500) bad.push('clamp');
    var b = G.PRiSM_dfit_bounds(5000, { inputs: { datumTvd: 10000 }, pi: 4500, piBracket: [4500, 4600] });
    if (!b || b.admissible !== false) bad.push('frictional veto');
    if (bad.length && typeof console !== 'undefined') console.warn('[56-prism-dfit-core self-test] ' + bad.join('; '));
})();
