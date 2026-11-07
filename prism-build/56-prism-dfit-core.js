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
//   • PRiSM_dfit_units.table — the display ↔ engine conversion factors of §3.5.
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
    G.PRiSM_dfit_units.table['bbl->ft3'] = 5.614583;
    function _unitConv(obj, inverse) {
        try {
            if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: 'BAD_INPUT', errors: ['PRiSM_dfit_units: an object of named fields is needed.'], bad: [] };
            var U = G.PRiSM_dfit_units, out = {};
            for (var k in obj) {
                if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                var v = obj[k], key = U.fields[k], f = key ? U.table[key] : null;
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
    function _Gof(d, a) { return _isSpec(a) ? a.G(d) : G_(d, a); }
    function _Gpof(d, a) { return _isSpec(a) ? a.Gp(d) : Gp_(d, a); }
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
        if (_isSpec(alpha)) return _nn(alpha.g ? alpha.g(dtD) : NaN);
        var a = _alphaOf(alpha); if (a === null || !_fin(dtD) || dtD < 0) return null;
        return _nn(g_(dtD, a));
    };
    G.PRiSM_dfit_g.quad = function (dtD, alpha) { return (_fin(dtD) && dtD >= 0 && alpha > 0.5 - 1e-12 && alpha <= 1) ? _gQuad(dtD, alpha) : null; };
    G.PRiSM_dfit_g.g0 = function (alpha) { var a = _alphaOf(alpha); return a === null ? null : g0_(a); };
    G.PRiSM_dfit_gPrime = function (dtD, alpha) {
        if (_isSpec(alpha)) return _nn(alpha.Gp(dtD) * PI / 4);
        var a = _alphaOf(alpha); if (a === null || !_fin(dtD) || dtD < 0) return null;
        return _nn(gp_(dtD, a));
    };
    G.PRiSM_dfit_gPrime.quad = function (dtD, alpha) { return (_fin(dtD) && dtD >= 0 && alpha > 0.5 - 1e-12 && alpha <= 1) ? _gpQuad(dtD, alpha) : null; };
    G.PRiSM_dfit_G = function (dtD, alpha) {
        if (!_fin(dtD) || dtD < 0) return null;
        if (_isSpec(alpha)) return _nn(alpha.G(dtD));
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
    // opts.modelHist {t, AL} (area history). a = (V(τ)/V_total)^α (volume) or AL(τ)/AL(ts) (model). gSpec functions take ΔtD.
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
            ok: true, kind: kind, alpha: alpha, tp: tp, ts: ts, g0: g0, dtUnit: 'dtD',
            g: gD, G: function (d) { return 4 / PI * (gD(d) - g0); }, Gp: function (d) { return 4 / PI * gpD(d); },
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
                    applied: { atmDelta: aP, unitFix: (ch.unitFix.p || ch.unitFix.q || ch.unitFix.t || ch.unitFix.pSurf) ? ch.unitFix : null, clockOffsetH: off, masked: nMasked },
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
            if (conv) { try { cv = conv({ t: out.t, p: out.pw, q: out.q ? out.q.map(function (x) { return x * 1440; }) : null }, { inputs: I, well: well || null }, { band: true }); } catch (e) { cv = null; } }
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
        } else if (depthGauge !== null && _fin(I.datumTvd) && Math.abs(I.datumTvd - depthGauge) > 0.5) {
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
        if (iq >= 0) {
            var tsx = out.t[iq], a0 = tsx - 10 / 3600, a1 = tsx + 120 / 3600, nWin = 0;
            for (i = 0; i < out.t.length; i++) if (out.t[i] >= a0 && out.t[i] <= a1) nWin++;
            if (nWin >= 2 && (a1 - a0) * 3600 / nWin <= 0.5) out.hf = { windows: [{ kind: 'shutin', t0: a0, t1: a1, n: nWin }] };
        }
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
        cycles.forEach(function (c) {
            var i0 = c.i0, tA = i0 > 0 ? t[i0 - 1] : t[i0], tS = tA;
            if (i0 > 0 && i0 + 1 < n) {
                var pPre = p[i0 - 1], s = (p[i0 + 1] - p[i0]) / (t[i0 + 1] - t[i0]);
                if (s > 0 && p[i0] > pPre) { var tx = t[i0] - (p[i0] - pPre) / s; tS = _clampN(tx, tA, t[i0]); }
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
        var tsRefined = false;
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
            for (i = i0c + 1; i <= iS + 1; i++) {
                if (i > iS || Math.abs(q[i] - q[r0]) > 0.01 * Math.max(q[r0], 1e-9)) { runs.push({ a: r0, b: i - 1, q: _median(q.slice(r0, i)) }); r0 = i; }
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
            var iR = iS; while (iR > i0c && q[iR] < 0.95 * qLast) iR--;
            rampDown = tp > 0 ? _clampN((ts - t[iR]) / tp, 0, 1) : 0;
            if (rampDown > 0.1) warnings.push(_W('RAMP_DOWN', 'warn', 'The rate ramps down over ' + _f1(rampDown * 100, 0) + ' % of the pumping time: the instantaneous shut-in is not defined, the data-driven G is used.'));
        }
        // volumes (bbl)
        var Vi = 0;
        if (hasQ) {
            for (i = i0c; i <= iS; i++) Vi += q[i] * (t[i] - (i === i0c ? tStart : t[i - 1])) * 60;
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
        var tpPump = ts - tStart, tpB = tb !== null ? ts - tb : null, tpV = (hasQ && qLast > 0) ? Vi / qLast / 60 : null;
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
    function _growLine(Gv, p, i0, iMax, sigma, P) {
        if (i0 < 0 || iMax - i0 < 3) return null;
        var thr = Math.max(3 * sigma, 0.05), best = null, j = Math.min(iMax, i0 + 5), fails = 0;
        while (j <= iMax) {
            var wf = _winFits(P, Gv, i0, j);
            if (!wf) break;
            var lf = wf.lin;
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
    // units the one reaching the largest G wins
    function _earlyLine(Gv, p, i0, iMax, sigma) {
        if (i0 < 0 || iMax - i0 < 3) return null;
        var P = _prefix(Gv, p), best = null, start = i0, g0 = Gv[i0], tries = 0;
        while (start <= iMax - 5 && tries < 8) {
            var w = _growLine(Gv, p, start, iMax, sigma, P);
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
        var el = _earlyLine(Gv, p, iG, iMax, sigma);
        var isip = _fin(opts.isip) ? opts.isip : (el ? el.a : p[0]);
        var mG = el ? -el.b : null;
        var dpI = p.map(function (v) { return isip - v; });
        var y = _bourdet(Gv, dpI, L), Dd = _bourdet(dt, dpI, L);
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
            earlyWin: el ? [Gv[el.i0], Gv[el.i1]] : [gMin, gMin], h: null, axis: { GdPdG: axis(GdPdG), dPdG: axis(dPdG) },
            L: L, gMin: gMin, gMinWhy: why, usable: usable, sigmaY: sigmaY, ev: ['G1'],
            // extras (not in the §3.5 table; read by 56's own pick, ISIP and frac functions and by 57)
            ts: ts, isip: isip, idx: idx, Gp: Gp, sigma: sigma, early: el ? { a: el.a, b: el.b, seA: el.seA, i0: el.i0, i1: el.i1, s: el.s, n: el.n } : null,
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
        if (derivs.gSpec) return derivs.gSpec.G(dtD);
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
            var bleedAtEnd = null, fitted = hm.bleedFitted === true;
            var dtEnd = _fin(hm.tEnd) ? (hm.tEnd > derivs.ts ? hm.tEnd - derivs.ts : hm.tEnd) : null;
            if (ctx.bleed && typeof ctx.bleed.curve === 'function' && _fin(dtEnd)) bleedAtEnd = ctx.bleed.curve(dtEnd);
            var accepted = fitted || (_fin(bleedAtEnd) && bleedAtEnd < sig3);
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
                var dpF = (_fin(sd.at.dpPerf) ? sd.at.dpPerf : 0) + (_fin(sd.at.dpNwb) ? sd.at.dpNwb : 0);
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
        var pn = _fin(ctx.pn) ? ctx.pn : (_fin(ctx.sigmaC) ? null : null);
        var rec = _reconcile(cands, { pn: _fin(ctx.pn) ? ctx.pn : (_fin(ctx.sigmaC) ? null : null) });
        if (_fin(ctx.sigmaC) && rec) rec = _reconcile(cands, { pn: rec.value - ctx.sigmaC });
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
        var span = v.G[iE] - v.G[i0], ret = false;
        for (j = iE + 1; j < Math.min(n, iE + 10); j++) if (sm[j] <= (1 + eps) * b) { ret = true; break; }
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
        var cands = [0, 0.01, 0.02, 0.05];
        for (var c = 0; c < cands.length; c++) {
            var Lp = cands[c];
            if (Lp >= d.L) break;
            var y = _bourdet(d.G, d.dpIsip, Lp), r = [];
            for (var i = 0; i < d.G.length; i++) if (d.G[i] >= Math.max(d.gMin, 0.1 * ge) && d.G[i] <= ge && _fin(y[i])) r.push(y[i] / d.G[i]);
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
        var sigY = Math.max(d.sigmaY || 0, 1e-9), sigP = Math.max(d.sigma || 0, 1e-6), Lw = _fin(d.Lpick) ? d.Lpick : d.L, i, j;
        var sm = _movMed(v.s, 5);
        var relN = 0;      // relative noise of dP/dG after the early window start (set once b is known)
        function tolAt(k, base, cap) { return Math.min(cap, Math.max(0.001, 3 * relN)); }
        // 1. the early window (from the straight p-G segment), trimmed by the pick window at its end
        var gE0 = d.earlyWin ? d.earlyWin[0] : v.G[0], gE1 = d.earlyWin ? d.earlyWin[1] : v.G[n - 1];
        var e0 = 0; while (e0 < n && v.G[e0] < gE0) e0++;
        if (e0 > n - 4) return res;
        var e1 = e0; while (e1 + 1 < n && v.G[e1 + 1] <= gE1 * Math.exp(-Lw)) e1++;
        if (e1 - e0 < 3) e1 = Math.min(n - 1, e0 + 3);
        // 2. the G·dP/dG line over the early window: through the origin when |ι| < 0.05; one robust refit
        var lfA = _linfit(v.G, v.y, e0, e1, false), iota0 = (lfA && lfA.b > 0) ? lfA.a / (lfA.b * v.G[e1]) : 0;
        var origin = Math.abs(iota0) < 0.05, lf = _linfit(v.G, v.y, e0, e1, origin);
        if (lf && lf.b > 0) {
            var keepG = [], keepY = [];
            for (i = e0; i <= e1; i++) { var yh0 = lf.a + lf.b * v.G[i]; if (Math.abs(v.y[i] - yh0) <= Math.max(3 * epsC * yh0, 3 * sigY)) { keepG.push(v.G[i]); keepY.push(v.y[i]); } }
            var lf2 = keepG.length >= 4 ? _linfit(keepG, keepY, 0, keepG.length - 1, origin) : null;
            if (lf2 && lf2.b > 0) lf = lf2;
        }
        if (!lf || !(lf.b > 0)) return res;
        var b = lf.b;
        res.line = lf; res.iota = iota0;
        relN = _noise2(v.s.slice(e0)) / b; res.relNoise = relN;
        function yh(k) { return lf.a + lf.b * v.G[k]; }
        function ecAt(k) { return Math.max(epsC, 3 * relN); }
        // 3. PDL hump before the early window: dP/dG above (1 + ε)·b at the start, returning to b
        var hump = _hump(v, sm, b, e0, Math.max(epsC, 0.02));
        res.hump = hump;
        // 4. the first departure from the line after the early window (held ≥ 3 points or ≥ 0.05 in ln G)
        // the search starts half a ln unit before the window end: the p-line window may run slightly past a gentle closure
        var iBack = e0 + 1; while (iBack < e1 && v.G[iBack] < v.G[e1] * Math.exp(-0.5)) iBack++;
        var iDep = -1, down = false;
        for (i = iBack; i < n; i++) {
            var ec = ecAt(i), up = v.y[i] > (1 + ec) * yh(i);
            if (!(up || v.y[i] < (1 - ec) * yh(i))) continue;
            var held = 0;
            for (j = i; j < n; j++) { var ej = ecAt(j); if (up ? v.y[j] > (1 + ej) * yh(j) : v.y[j] < (1 - ej) * yh(j)) held++; else break; }
            if (held >= 3 || (held >= 2 && Math.log(v.G[i + held - 1] / v.G[i]) >= 0.05) || (j === n && held >= 2)) { iDep = i; down = !up; break; }
        }
        if (iDep < 0) { res.noDeparture = true; return res; }
        // 5. compliance (upward departure): the onset refined on the pressure residual from the local straight segment
        if (!down) {
            var l0 = iDep, l1 = iDep;
            while (l0 > e0 && v.G[l0 - 1] >= v.G[iDep] * Math.exp(-0.4)) l0--;
            while (l1 > l0 && v.G[l1] > v.G[iDep] * Math.exp(-(Lw + 0.01))) l1--;
            var pl = (l1 - l0 >= 3) ? _linfit(v.G, v.p, l0, l1, false) : _linfit(v.G, v.p, e0, e1, false), gOn = v.G[iDep], pOn = v.p[iDep];
            if (pl) {
                var thr = Math.max(3 * sigP, 0.01, 3 * pl.s), gLo = v.G[iDep] * Math.exp(-2 * Lw - 0.02), kOn = iDep;
                for (j = iDep; j >= e0 && v.G[j] >= gLo; j--) { if ((pl.a + pl.b * v.G[j]) - v.p[j] <= thr) { kOn = j; break; } kOn = j; }
                for (j = kOn; j < Math.min(n, iDep + 50); j++) { if ((pl.a + pl.b * v.G[j]) - v.p[j] > thr) break; kOn = j; }
                gOn = v.G[kOn]; pOn = v.p[kOn];
                if (kOn + 2 < n) {   // the residual grows ~ quadratically from the onset: √r is linear in G → extrapolate √r to zero
                    var r1 = (pl.a + pl.b * v.G[kOn + 1]) - v.p[kOn + 1], r2 = (pl.a + pl.b * v.G[kOn + 2]) - v.p[kOn + 2];
                    if (r1 > 0 && r2 > r1) {
                        var g0x = v.G[kOn + 1] - Math.sqrt(r1) * (v.G[kOn + 2] - v.G[kOn + 1]) / (Math.sqrt(r2) - Math.sqrt(r1));
                        gOn = _clampN(g0x, v.G[kOn], v.G[kOn + 1]); pOn = pl.a + pl.b * gOn;
                    }
                }
            }
            res.picks.compliance = { k: iDep, G: gOn, p: pOn, down: false, line: lf, departRel: (v.y[iDep] - yh(iDep)) / Math.max(yh(iDep), 1e-9),
                text: 'G·dP/dG leaves the early ' + (origin ? 'line through the origin' : 'straight line') + ' upward at G ' + _f1(gOn, 2) + ' (ε ' + _f1(epsC, 3) + ').' };
        }
        // 6. tangent through the origin: the end of the stiffening (peak of dP/dG after an upward departure) or, after a
        //    downward departure, the end of the early plateau (s* = b); noise-local tolerance ≤ ε_tangent, two dips allowed
        var tg = null;
        if (!down) {
            var cs = (relN < 0.005) ? v.s : sm, iPk = iDep;
            for (i = iDep; i < n; i++) if (cs[i] > cs[iPk]) iPk = i;
            if (iPk < n - 2) {
                var sStar = cs[iPk], iT = iPk, dips = 0;
                for (j = iPk + 1; j < n; j++) { if (cs[j] >= (1 - tolAt(j, sStar, epsT)) * sStar) { iT = j; dips = 0; } else if (++dips > 2) break; }
                var gT = v.G[iT], pT = v.p[iT], sPk = sStar;
                if (iT === iPk && iPk > 0) {
                    var x0 = Math.log(v.G[iPk - 1]), x1 = Math.log(v.G[iPk]), x2 = Math.log(v.G[iPk + 1]), y0 = cs[iPk - 1], y1 = cs[iPk], y2 = cs[iPk + 1];
                    var den = (x0 - x1) * (x0 - x2) * (x1 - x2);
                    if (den !== 0) {
                        var A2 = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / den, B2 = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / den;
                        if (A2 < 0) { var xv = _clampN(-B2 / (2 * A2), x0, x2); gT = Math.exp(xv); pT = _pAtG(d, gT); sPk = Math.max(sStar, A2 * xv * xv + B2 * xv + (y0 - A2 * x0 * x0 - B2 * x0)); }
                    }
                } else if (iT + 1 < n && cs[iT] > cs[iT + 1]) {
                    var f = _clampN((cs[iT] - (1 - tolAt(iT, sStar, epsT)) * sStar) / (cs[iT] - cs[iT + 1]), 0, 1);
                    gT = v.G[iT] + f * (v.G[iT + 1] - v.G[iT]); pT = v.p[iT] + f * (v.p[iT + 1] - v.p[iT]);
                }
                tg = { k: iT, G: gT, p: pT, sStar: sPk, iPk: iPk, noise: relN * b / sStar, tol: tolAt(iT, sStar, epsT) };
            } else res.noDeparture = true;     // still stiffening at the end of the data
        } else {
            var cs2 = (relN < 0.005) ? v.s : sm, iP = iBack, dps = 0;
            for (j = iBack; j < n; j++) { if (cs2[j] >= (1 - tolAt(j, b, epsT)) * b) { iP = j; dps = 0; } else if (++dps > 2) break; }
            if (iP < n - 2) {
                var gP = v.G[iP], pP = v.p[iP];
                if (cs2[iP] > cs2[iP + 1]) {
                    var fp = _clampN((cs2[iP] - (1 - tolAt(iP, b, epsT)) * b) / (cs2[iP] - cs2[iP + 1]), 0, 1);
                    gP = v.G[iP] + fp * (v.G[iP + 1] - v.G[iP]); pP = v.p[iP] + fp * (v.p[iP + 1] - v.p[iP]);
                }
                tg = { k: iP, G: gP, p: pP, sStar: b, iPk: iP, noise: relN, tol: tolAt(iP, b, epsT) };
                res.picks.compliance = { k: iP, G: gP, p: pP, down: true, line: lf, departRel: 0,
                    text: 'G·dP/dG first leaves the early line downward, so the compliance and tangent picks coincide at G ' + _f1(gP, 2) + '.' };
            } else res.noDeparture = true;
        }
        if (tg) {
            tg.text = 'The tangent through the origin touches G·dP/dG up to G ' + _f1(tg.G, 2) + ' (largest dP/dG ' + _f1(tg.sStar, 2) + ' psi per unit G).';
            res.picks.tangent = tg;
            // dependent F2 members: the dP/dG maximum and the √t inflection, searched after the early window up to 1.5 × G_tangent
            var iM = -1, iS2 = -1, gLim = 1.5 * tg.G;
            for (i = Math.max(e1, 0); i < n && v.G[i] <= gLim; i++) {
                if (iM < 0 || v.s[i] > v.s[iM]) iM = i;
                if (_fin(v.sd[i]) && (iS2 < 0 || v.sd[i] > v.sd[iS2])) iS2 = i;
            }
            if (iM >= 0) res.picks.maxdpdg = { k: iM, G: v.G[iM], p: v.p[iM], text: 'dP/dG is largest at G ' + _f1(v.G[iM], 2) + '.' };
            if (iS2 >= 0) res.picks.sqrt = { k: iS2, G: v.G[iS2], p: v.p[iS2], text: 'The square-root-of-time derivative is largest at √Δt ' + _f1(Math.sqrt(v.dt[iS2] * 60), 2) + ' min^½.' };
        }
        // crel (same evidence as compliance): the first p where C_rel = b/(dP/dG) < 1 − ε for ≥ 3 points
        if (res.picks.compliance && !down) {
            for (i = Math.max(e0 + 1, e1); i < n; i++) {
                if (b / Math.max(v.s[i], 1e-12) < 1 - Math.max(epsC, tolAt(i, b, 1))) {
                    var h2 = 0; for (j = i; j < n && b / Math.max(v.s[j], 1e-12) < 1 - Math.max(epsC, tolAt(j, b, 1)); j++) h2++;
                    if (h2 >= 3 || j === n) { res.picks.crel = { k: i, G: v.G[i], p: v.p[i], text: 'The relative compliance falls below ' + _f1(1 - epsC, 3) + ' at ' + _f0(v.p[i]) + ' psia.' }; break; }
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
        if (P.compliance) out.push(mk('compliance', 'F1', P.compliance, { vote: true, ev: 'C2', se: Math.max(d.sigma, 0.5) / Math.max(d.mG || 1, 1e-6) * (d.mG || 1) }));
        if (P.crel) out.push(mk('crel', 'F1', P.crel, { vote: false, same: 'compliance', ev: 'C6' }));
        if (P.loglog) {
            var indep = Math.abs(cf.iota) >= 0.05;
            out.push(mk('loglog', 'F1', P.loglog, { vote: indep, same: indep ? null : 'compliance', ev: 'C7' }));
            if (!indep) out[out.length - 1].evidence.push({ text: _txt('iota ' + _f1(cf.iota, 3) + ' is below 0.05: the log-log departure is the compliance test with another ε (same evidence).'), ev: ['C7'] });
        }
        if (P.tangent) out.push(mk('tangent', 'F2', P.tangent, { vote: true, ev: 'C3' }));
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
                if (!b.admissible && pk.method !== 'user') pk.vote = false;
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
    G.PRiSM_dfit_varComplianceFit = _safe(function (derivs, ctx, opts) {
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
        return { ok: true, sigmaC: _r(pp2.sigmaC, 2), ci95: (Array.isArray(ciS) && _fin(ciS[0]) && _fin(ciS[1])) ? [_r(ciS[0], 2), _r(ciS[1], 2)] : null,
                 sc: _r(pp2.sc, 3), fres: _r(_fin(pp2.fres) ? pp2.fres : base.fres, 4), K: _sf(pp2.K, 6), isip: _r(pp2.isip, 2), corrSigmaSc: _nn(corrSS),
                 resid: resid, rmse: _r(res.rmse, 4), profile: null, law: base.law, n: Gf.length };
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
        var d = derivs, tp = d.tp, X = frac.Csys * (_fin(frac.mG) ? frac.mG : d.mG), dtc = frac.dtc, out = { dt: [0], qL: [], VL: [], Vf: [] };
        var VL0 = frac.ViStar !== null && frac.eta ? frac.ViStar * (1 - frac.eta.matched) : 0;
        function dGdt(dtD) { return (d.gSpec ? d.gSpec.Gp(dtD) : Gp_(dtD, d.gType === 'a1' ? 1 : (d.gType === 'a05' ? 0.5 : d.alpha))) / (tp * 60); }   // per minute
        out.qL.push(_sf(X * dGdt(0), 6)); out.VL.push(_r(VL0, 4)); out.Vf.push(_r(frac.AfCf * frac.pn, 4));
        for (var i = 0; i < d.dt.length && d.dt[i] <= dtc * (1 + 1e-9); i++) {
            out.dt.push(d.dt[i]);
            out.qL.push(_sf(X * dGdt(d.dtD[i]), 6));
            out.VL.push(_r(VL0 + X * d.G[i], 4));
            out.Vf.push(_r(Math.max(0, frac.AfCf * (d.p[i] - frac.pClosure)), 4));
        }
        out.dt.push(dtc); out.qL.push(_sf(X * dGdt(dtc / tp), 6)); out.VL.push(_r(VL0 + X * frac.Gc, 4)); out.Vf.push(0);
        out.ok = true;
        return out;
    });

    // ═════════════════════════════════════════════════════════════════════
    // §4.11 leak-off-type classifier
    // ═════════════════════════════════════════════════════════════════════
    function _logit(x) { return 1 / (1 + Math.exp(-x)); }
    // logistic margin σ((value − threshold)/(0.2·|threshold| + δ)), oriented: dir +1 'above', −1 'below'
    function _mg(value, thr, dir, delta) { if (!_fin(value)) return 0.5; return _logit(dir * (value - thr) / (0.2 * Math.abs(thr) + (delta || 0.02))); }
    function _relChange(v, iA, iC) {           // robust relative change of dP/dG from the start to the end of [iA, iC]
        var m = Math.max(2, Math.round((iC - iA + 1) * 0.15)), a = [], b = [];
        for (var i = iA; i < iA + m && i <= iC; i++) a.push(v.s[i]);
        for (i = Math.max(iA, iC - m + 1); i <= iC; i++) b.push(v.s[i]);
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
                    if (_okRes(cfg)) {
                        cfg.sigmaC = sigC; cfg.pr = pr; cfg.wc = 1; cfg.CL = null; cfg.mode = 'prescribed';
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
                var sA = sl(Math.max(gA, Gm[1])), sC = sl(gC);
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
        var gC = _fin(ctx.Gc) ? ctx.Gc : (P.tangent ? P.tangent.G : v.G[n - 1]);
        var iA = 0, iC = n - 1; while (iC > 0 && v.G[iC] > gC) iC--;
        var iota = _iota(v, iA, iC), curv = _relChange(v, hump ? hump.iEnd : iA, iC);
        var frac = ctx.frac || null, isip = _isipVal(ctx.isip); if (isip === null) isip = d.isip;
        var sigC = frac && _fin(frac.pClosure) ? frac.pClosure : (P.tangent ? P.tangent.p : v.p[iC]);
        var pr = _fin(ctx.pr) ? ctx.pr : (ctx.well && _fin(ctx.well.pi) ? ctx.well.pi : null);
        var ke = _kappaExp(d, ctx, v.G[iA], gC, isip, sigC, pr), kwb = 0;
        if (typeof ctx.VwCwOfP === 'function' && frac && _fin(frac.AfCf)) {
            var cA = frac.AfCf + ctx.VwCwOfP(v.p[iA]), cC = frac.AfCf + ctx.VwCwOfP(v.p[iC]);
            if (cA > 0 && cC > 0) kwb = cA / cC - 1;
        }
        var curvExp = ke.k + kwb;
        var ratios = []; for (var i = iA; i <= iC; i++) if (_fin(v.D[i]) && _fin(v.Dref[i]) && v.Dref[i] > 0) ratios.push(v.D[i] / v.Dref[i]);
        var DoverDref = _median(ratios); if (!_fin(DoverDref)) DoverDref = 1;
        var H = hump ? hump.H : 0, returns = hump ? hump.returns : false;
        // no-return excess: G·dP/dG above the late line from the start (tip extension) — H measured against the end slope
        var sEnd = _median(v.s.slice(Math.max(iA, iC - 3), iC + 1)), Hnr = 0;
        if (sEnd > 0) for (i = iA; i <= iC; i++) Hnr = Math.max(Hnr, (v.y[i] - sEnd * v.G[i]) / (sEnd * v.G[i]));
        var Rvis = frac && _fin(frac.Rvis) ? frac.Rvis : (_fin(ctx.Rvis) ? ctx.Rvis : null);
        var VwT = _fin(ctx.VwCwTheory) ? ctx.VwCwTheory : null, VwM = _fin(ctx.VwCwMeasured) ? ctx.VwCwMeasured : null;
        var VwR = (VwT > 0 && VwM > 0) ? VwM / VwT : null;
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
            hrContact: mean([_mg(iota, -0.05, -1), _mg(curv, 0.1, 1), _mg(DoverDref, 1.0, 1, 0.05)]),
            storage: Rvis === null ? 0.1 : mean([(Rvis < 0.3 || (Rvis < 0.5 && VwR !== null && VwR > 2)) ? 0.95 : _mg(Rvis, 0.3, -1, 0.05), _mg(Math.abs(iota), 0.05, -1)])
        };
        if (!hasHump) sc.pdl = Math.min(sc.pdl, 0.2);
        if (Rvis !== null && Rvis > 0.7) sc.storage = Math.min(sc.storage, 0.2);
        if (Math.abs(ke.k) < 0.05) sc.matrix = Math.min(sc.matrix, sc.normal - 0.16);
        Object.keys(sc).forEach(function (k) { sc[k] = _r(Math.max(0, sc[k]), 4); });
        var names = { normal: 'normal', matrix: 'matrix', pdl: 'pdl', tip: 'tip', hrContact: 'hr-contact', storage: 'storage' };
        var order = Object.keys(sc).sort(function (a, b) { return sc[b] - sc[a]; });
        var top = order[0];
        if (sc.storage >= 0.5 && Rvis !== null && Rvis <= 0.7) top = 'storage';
        var type = sc[top] >= 0.5 ? names[top] : 'undetermined';
        var alt = order.filter(function (k) { return k !== top && sc[k] >= 0.5 && sc[top] - sc[k] <= 0.15; }).map(function (k) { return names[k]; });
        // PDL block
        var pdl = null;
        if (hasHump) {
            var pfo = v.p[hump.iEnd], sB = hump.s, xs = [], ys = [];
            for (i = 0; i <= hump.iEnd; i++) if (v.s[i] > sB) { xs.push(v.p[i] - pfo); ys.push(Math.log(v.s[i] / sB)); }
            var lfp = xs.length >= 3 ? _linfit(xs, ys, 0, xs.length - 1, true) : null, Cd = lfp && lfp.b > 0 ? lfp.b : 0;
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
            features: { iota: _r(iota, 4), curv: _r(curv, 4), curvExp: _r(curvExp, 4), curvWb: _r(kwb, 4), H: _r(hasHump ? H : 0, 4), DoverDref: _r(DoverDref, 4), Rvis: _r(Rvis, 4), VwCwRatio: _r(VwR, 4),
                        unitSlopeSink: unitSlope, bleedOffExplained: bleedExpl },
            pdl: pdl, hr: hr, evidence: evid.map(_txt), ev: ['M1'], curvExpSource: ke.source
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
        var sg = Math.max(prep.sigma || 0, 1e-9);
        for (i = 0; i < n; i++) r[i] = (i >= 3 && i < n - 3) ? _clampN(r[i] - mr, -3 * sg, 3 * sg) : 0;
        var num = 0, den = 0; for (i = 4; i < n - 3; i++) { num += r[i] * r[i - 1]; den += r[i] * r[i]; }
        var rho = den > 0 ? _clampN(num / den, -0.99, 0.99) : 0, bl = Math.min(50, Math.max(5, Math.round(2 / (1 - Math.max(rho, 0)))));
        return { idx: idx, sm: sm, r: r, bl: bl, rng: _rng(seed == null ? 1 : seed), rho: rho };
    }
    function _bootPrep(prep, bs) {
        var n = bs.idx.length, pw = prep.pw.slice(), pool = [], i;
        for (i = 3; i < n - 3; i++) pool.push(bs.r[i]);
        var out = [], m = pool.length;
        while (out.length < n && m > 0) { var st = Math.floor(bs.rng() * Math.max(1, m - bs.bl + 1)); for (i = 0; i < bs.bl && out.length < n; i++) out.push(pool[Math.min(m - 1, st + i)]); }
        for (i = 0; i < n; i++) pw[bs.idx[i]] = bs.sm[i] + (out[i] || 0);
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
            d = st.cache[key] || (st.cache[key] = _derivsCore(prep, e2, { L: it.L, tp: it.tp, alpha: base.alpha, alphaGeneral: base.alphaGeneral, isip: base.isip, gMin: base.gMinUser, hammer: base.hammer, bleed: base.bleed }));
            epsO.compliance = it.eps; epsO.tangent = it.eps;
        } else {
            d = _derivsCore(_bootPrep(prep, st.boot), ev, { L: base.L, tp: base.tp, alpha: base.alpha, alphaGeneral: base.alphaGeneral, isip: base.isip, gMin: base.gMinUser, hammer: base.hammer, bleed: base.bleed });
        }
        st.counts.evals += CF_METHODS.length;
        if (!_okRes(d)) return;
        var cf = _closedForm(d, { eps: epsO });
        CF_METHODS.forEach(function (m) {
            var pk = cf.picks[m];
            if (pk && _fin(pk.p)) {
                st.samples[m].push(pk.p);
                st.tags[m].push(it);
            }
        });
    }
    function _consensusFinish(picks, derivs, ctx, st) {
        var I = st.I, sigG = _fin(ctx.sigmaGauge) ? ctx.sigmaGauge : (derivs.sigma || 0);
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
            samples[f] = arr.map(function (x) { return _r(x, 2); });
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
                var bucket = {};
                st.tags[m].forEach(function (it, k) { if (it.kind !== 'grid') return; var key = it.li + '_' + it.ti; (bucket[key] = bucket[key] || []).push(st.samples[m][k]); });
                var vals = [];
                Object.keys(bucket).forEach(function (key) { var md = _median(bucket[key]), q = key.split('_'); cells[+q[0]][+q[1]] = _r(md, 1); vals.push(md); });
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
        var br = pRef !== null ? G.PRiSM_dfit_bounds(pRef, { isip: isip, pi: ctx.pi, piBracket: ctx.piBracket, inputs: ctx.inputs, well: ctx.well }) : null;
        var fric = br && _okRes(br) ? br.frictional : { veto: null, warn: null };
        var fricFired = !!(br && _okRes(br) && (br.vetoes.some(function (x) { return x.rule === 'frictional'; }) || br.warnings.some(function (x) { return x.rule === 'frictional'; })));
        var rules = [
            { id: 'K1', fired: mode !== 'single', value: null, threshold: null, text: mode === 'single' ? 'Mode single: the family medians differ by less than 2.5 τ and the bands overlap.' : (mode === 'range' ? 'Mode range: the families do not agree within 2.5 τ or their bands do not overlap.' : 'Mode none: dP/dG never departs; closure is not estimable.') },
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
            samples: samples, counterfactual: counterfactual, frictional: { veto: fric.veto, warn: fric.warn }, forecast: forecast, ev: ['C1', 'K1'],
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
            st = { I: I, counts: { evals: 0, refits: 0 }, samples: {}, tags: {}, boot: null, cache: {} };
            CF_METHODS.forEach(function (m) { st.samples[m] = []; st.tags[m] = []; });
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
