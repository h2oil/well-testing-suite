// =============================================================================
// PRiSM — 56-prism-dfit-core.js  (Round 8)
// -----------------------------------------------------------------------------
// DFIT pre-closure core (docs/DFIT-PLAN.md §3.5; owner WP2). Pure engine: no DOM, no storage, no timers, no events.
//
// WP0 SKELETON. Every §3.5 function is a stub that returns
//   {ok:false, code:'NOT_IMPLEMENTED', errors:[…], bad:[]}
// (Job twins return a Job whose result() is that object). WP2 replaces the stubs; the names, argument lists and result
// shapes are fixed by §3.5 and prism-build/tests/_dfit-shapes.js. Two parts are real already because WP0 freezes them:
//   • PRiSM_dfit_inputRanges — the §3.2 range table {path: {min, max, def, unit, integer, scope, display?, rows?}} with
//     clamp(inputs) → {inputs, warnings} (fields, rows, flags, unit fixes, mask and event overrides; the output always
//     passes the DfitInputs shape), clampValue(path, v) and defaults() (the reference behaviour of tests/_dfit-shapes.js
//     clampInputs);
//   • PRiSM_dfit_units.table — the display ↔ engine conversion factors of §3.5 (toEngine / toDisplay are stubs).
// Loads without document, WTS_units, the 02 lexical helpers or any Round-9 engine (smoke stub).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _ni(name) {
        return { ok: false, code: 'NOT_IMPLEMENTED', errors: [name + ' is not implemented yet (DFIT WP0 skeleton).'], bad: [] };
    }
    function _stub(name) {
        var f = function () { return _ni(name); };
        f._dfitStub = true;
        return f;
    }
    function _jobStub(name) {
        var f = function () {
            var r = _ni(name);
            return {
                step: function () { return { done: true, progress: 1, label: 'not implemented' }; },
                result: function () { return r; },
                cancel: function () {}
            };
        };
        f._dfitStub = true;
        return f;
    }

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
        toEngine: _stub('PRiSM_dfit_units.toEngine'),
        toDisplay: _stub('PRiSM_dfit_units.toDisplay')
    };

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

    // ─────────────────────────────────────────────────────────────────────
    // §3.5 engine functions (stubs until WP2)
    // ─────────────────────────────────────────────────────────────────────
    ['PRiSM_dfit_dsHash', 'PRiSM_dfit_prepare', 'PRiSM_dfit_resample', 'PRiSM_dfit_events',
     'PRiSM_dfit_g', 'PRiSM_dfit_gPrime', 'PRiSM_dfit_G', 'PRiSM_dfit_Ginv', 'PRiSM_dfit_gFromHistory', 'PRiSM_dfit_hFn',
     'PRiSM_dfit_derivs', 'PRiSM_dfit_isip', 'PRiSM_dfit_closurePicks', 'PRiSM_dfit_varComplianceFit', 'PRiSM_dfit_vcModel',
     'PRiSM_dfit_consensus', 'PRiSM_dfit_consensusLite', 'PRiSM_dfit_bounds', 'PRiSM_dfit_classify', 'PRiSM_dfit_frac',
     'PRiSM_dfit_whatIf', 'PRiSM_dfit_leakoffRate', 'PRiSM_dfit_kBeforeClosure', 'PRiSM_dfit_farField',
     'PRiSM_dfit_forecastClosure'].forEach(function (n) { G[n] = _stub(n); });
    G.PRiSM_dfit_consensusJob = _jobStub('PRiSM_dfit_consensusJob');
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis, bad = [];
    var r = G.PRiSM_dfit_prepare && G.PRiSM_dfit_prepare();
    if (!r || r.ok !== false || r.code !== 'NOT_IMPLEMENTED') bad.push('prepare stub');
    var c = G.PRiSM_dfit_inputRanges.clamp({ fluid: { muCp: 1e12 }, options: { unc: { n: 1500.4 } } });
    if (c.inputs.fluid.muCp !== 5000 || c.inputs.options.unc.n !== 1500) bad.push('clamp');
    if (bad.length && typeof console !== 'undefined') console.warn('[56-prism-dfit-core self-test] ' + bad.join('; '));
})();
