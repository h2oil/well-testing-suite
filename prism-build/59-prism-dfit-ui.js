// =============================================================================
// PRiSM — 59-prism-dfit-ui.js  (Round 8)
// -----------------------------------------------------------------------------
// DFIT user interface (docs/DFIT-PLAN.md §2.6–2.11, §3.8, §4.20, §6.12, §7; owner WP6). The only DFIT file that
// touches the DOM, writes PRiSM.multiRate, writes C1, writes storage and fires events. The engines (56, 57, 58 and the
// Round-9 helpers) are resolved at call time; every call is guarded, so the page works (with ⚠ reasons) while an engine
// is missing or still a NOT_IMPLEMENTED stub.
//
// Exports (§3.8)
//   PRiSM_modeExt.dfit            the workspace-mode extension read by the generic shell hooks (WPH, §3.12)
//   PRiSM_dfit_analyse(opts)      ▶ Analyse → Promise (pipeline Job via PRiSM_autoInterp.drive, one undo batch, cancel)
//   PRiSM_dfit_renderStep2(host), PRiSM_dfit_renderStep4(host)          step views (#prism_stepview)
//   PRiSM_renderDfit{Designer,Sandbox,Replay,Hammer,Notes}Tool(host)     Tools drawer entries (PRiSM_toolCatalogueExtra)
//   PRiSM_dfit_state() / _test() / _selectTest(id) / _addTest(opts)     st.dfit (created on demand) and its tests
//   PRiSM_dfit_setPick(item, value, {source, reason})                    the only writer of picks (log, event, fast run)
//   PRiSM_dfit_applyHandoff(target, {family})                            confirm → PRiSM_dfit_handoff inside one undo batch
//   PRiSM_dfit_results()          the active test's summary (rail, report key line, WTS_state.dfit)
//   PRiSM_dfit_hooks              read-only hook points for the 3.4b files (merged, never replaced)
//   PRiSM_plot_dfitDual / PRiSM_plot_dfitStrip / PRiSM_plot_dfitStack   plot functions (host-IIFE scope, bridged)
// Also (tests and the integrator): PRiSM_dfit_ui = {fields, plots, panels, tools, …} and PRiSM_dfit_deleteTest(id).
//
// The generic hooks of §3.12 (PRiSM_modeExt read by 01/04/37, PRiSM_undoBatch, PRiSM_drawPlot, PRiSM_plot_overlay,
// panel `modes`, gallery / report `modes`, analysis-key `store:false`) belong to WPH. Until they are in the build the
// items that would leak into the transient / decline / combined modes (plot registry entries, line tools, Tools
// functions) are kept off the shared registries (PRiSM_dfit_ui.hooksReady() === false); everything else works.
// No timers in this file: long work runs through PRiSM_autoInterp.drive (53), the one timer user in Round 8.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var HAS_DOC = typeof document !== 'undefined' && !!document && typeof document.getElementById === 'function';

    // =========================================================================
    // SECTION 1 — UTILITIES
    // =========================================================================
    function _isNum(v) { return typeof v === 'number' && isFinite(v); }
    function _num(v) { return _isNum(v) ? v : null; }
    function _own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
    function _isObj(o) { return !!o && typeof o === 'object' && !(o instanceof Array); }
    function _arr(a) { return (a && typeof a.length === 'number' && typeof a !== 'string') ? a : null; }
    function _esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function _clone(o) { if (o == null) return o; try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; } }
    function _nowISO() { try { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch (e) { return '2026-01-01T00:00:00Z'; } }
    function _byId(id) { return HAS_DOC ? document.getElementById(id) : null; }
    function _fn(name) { var f = G[name]; return (typeof f === 'function' && !f._dfitStub) ? f : null; }
    function _okRes(r) { return !!(r && typeof r === 'object' && r.ok !== false); }
    // number text: thousands separators, fixed decimals; '—' for anything that is not a finite number
    function _f(v, dp) {
        if (!_isNum(v)) return '—';
        dp = (dp == null) ? 0 : dp;
        var neg = v < 0, s = Math.abs(v).toFixed(dp), parts = s.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (neg ? '−' : '') + parts.join('.');
    }
    // significant-figure text for small quantities (k, CL)
    function _sig(v, n) {
        if (!_isNum(v)) return '—';
        if (v === 0) return '0';
        n = n || 3;
        var a = Math.abs(v);
        if (a >= 1e5 || a < 1e-3) return v.toExponential(n - 1).replace('e', 'e');
        var d = Math.max(0, n - 1 - Math.floor(Math.log(a) / Math.LN10));
        return _f(v, Math.min(d, 6));
    }
    // plain text guard (§3.0): under 300 characters, no banned words
    var BANNED = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/g;
    function _txt(s) { return String(s == null ? '' : s).replace(BANNED, '—').slice(0, 299); }
    function _emit(name, detail) {
        if (!G || typeof G.dispatchEvent !== 'function') return;
        try {
            var ev = null;
            if (typeof CustomEvent === 'function') ev = new CustomEvent(name, { detail: detail || {} });
            else if (HAS_DOC && document.createEvent) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent(name, false, false, detail || {}); }
            if (ev) G.dispatchEvent(ev);
        } catch (e) { /* listeners must not break the UI */ }
    }
    function _st() { if (!G.PRiSM_state || typeof G.PRiSM_state !== 'object') G.PRiSM_state = {}; return G.PRiSM_state; }
    function _P() { if (!G.PRiSM || typeof G.PRiSM !== 'object') G.PRiSM = { mode: 'transient', tab: 1, multiRate: [] }; return G.PRiSM; }
    function _inDfit() { return !!(G.PRiSM && G.PRiSM.mode === 'dfit'); }
    function _ls() { try { return G.localStorage || null; } catch (e) { return null; } }
    function _shell() { return _byId('prism_shell'); }
    // the WPH generic hooks (§3.12) are in the build
    function hooksReady() {
        // PRiSM_drawPlot (04) and PRiSM_undoBatch (37) come with the generic hooks; PRiSM_modeExt is created here when absent
        return typeof G.PRiSM_drawPlot === 'function' && typeof G.PRiSM_undoBatch === 'function';
    }
    function _batch(which) { if (typeof G.PRiSM_undoBatch === 'function') { try { G.PRiSM_undoBatch(which); } catch (e) { /* ignore */ } } }
    function _well() { try { return (typeof G.PRiSM_getWell === 'function') ? (G.PRiSM_getWell() || {}) : {}; } catch (e) { return {}; } }
    function _hasData(ds) { return !!(ds && _arr(ds.t) && ds.t.length >= 2 && _arr(ds.p)); }

    // =========================================================================
    // SECTION 2 — RANGE TABLE, INPUT FIELDS
    // =========================================================================
    function _ranges() { return _isObj(G.PRiSM_dfit_inputRanges) ? G.PRiSM_dfit_inputRanges : null; }
    function _defaults() {
        var R = _ranges();
        if (R && typeof R.defaults === 'function') { try { return R.defaults(); } catch (e) { /* fall through */ } }
        return {
            datumTvd: null, datumMd: null, survey: null, gauge: { bhTvd: null, bhMd: null }, strings: [],
            fluid: { kind: 'water', rhoPpg: 8.43, salinityWt: null, muCp: 1.0, fr: 0, nPrime: null, kPrime: null, tInjF: 70 },
            temp: { model: 'static', surfF: 70, gradFper100: 1.5, tauLoH: 0.5, tauHiH: 5 },
            perfs: { n: null, dIn: 0.40, cd: 0.62 },
            rock: { Ep: null, EpSource: 'unknown', nu: 0.25, hf: null, hp: null, barrierSpacing: null, sigmaVGrad: 1.0, sigmaVGradLo: 0.9,
                    muFricWarn: 0.6, muFricVeto: 1.0, biot: 1.0 },
            priors: { sigmaGrad: null, sigmaGradSd: 0.02, piGrad: null },
            channels: { primary: 'bh', psig: { p: false, pSurf: false, pAnn: false }, atmPsia: 14.696, clockOffsetH: 0,
                        unitFix: { p: null, pSurf: null, q: null, t: null }, depthFix: null, mask: [] },
            events: { tStart: null, tb: null, ts: null, flowback: null },
            options: { alpha: 'auto', alphaGeneral: 0.75, tp: 'pump', L: 0.1, gMin: 'auto', eps: { compliance: 0.02, tangent: 0.02, loglog: 0.05 },
                       tau: { abs: 15, fSigma: 0.003, fN: 0.03 }, familyWeightF1: 0.5, axisLock: false, ppd: false,
                       aca: { origin: 'centroid', LB: 0.25, carterExactFR: false, tideRemove: 'auto' }, unc: { n: 1000, seed: 1 }, triage: {} }
        };
    }
    function _clampInputs(inp) {
        var R = _ranges();
        if (R && typeof R.clamp === 'function') { try { var r = R.clamp(inp); if (r && r.inputs) return r.inputs; } catch (e) { /* fall through */ } }
        return inp || _defaults();
    }
    function _getPath(o, path) {
        var parts = String(path).split('.');
        for (var i = 0; i < parts.length; i++) { if (!o || typeof o !== 'object') return undefined; o = o[parts[i]]; }
        return o;
    }
    function _setPath(o, path, v) {
        var parts = String(path).split('.');
        for (var i = 0; i < parts.length - 1; i++) { if (!_isObj(o[parts[i]])) o[parts[i]] = {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = v;
    }
    // One range-table field: raw text (or number) → {value, warning}. Ep is entered in 1e6 psi and stored in psi.
    function clampField(path, raw) {
        var R = _ranges(), row = R && R.table ? R.table[path] : null;
        var scale = (row && row.display && _isNum(row.display.scale)) ? row.display.scale : 1;
        var v = raw;
        if (scale !== 1 && raw !== '' && raw != null) {
            var n = (typeof raw === 'number') ? raw : _parse(raw);
            v = _isNum(n) ? n * scale : raw;
        }
        if (R && typeof R.clampValue === 'function') {
            try { var r = R.clampValue(path, v); if (r && 'value' in r) return { value: r.value, warning: r.warning || null }; } catch (e) { /* fall through */ }
        }
        var x = (typeof v === 'number') ? v : _parse(v);
        if (!_isNum(x)) return { value: row ? row.def : null, warning: null };
        if (row) { if (x < row.min) x = row.min; if (x > row.max) x = row.max; if (row.integer) x = Math.round(x); }
        return { value: x, warning: null };
    }
    function _parse(s) {
        if (typeof s === 'number') return s;
        if (s == null) return NaN;
        s = String(s).trim();
        if (!s) return NaN;
        if (s.indexOf(',') !== -1) {
            var A = G.WTS_a11y, dc = false;
            try { dc = !!(A && typeof A.decimalComma === 'function' && A.decimalComma()); } catch (e) { dc = false; }
            if (dc && typeof G.WTS_parseNumber === 'function' && /^[-+]?\d+,\d+$/.test(s)) { try { var n = G.WTS_parseNumber(s); if (_isNum(n)) return n; } catch (e) { /* fall through */ } }
            if (/^[-+]?\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(s) || /^[-+]?\d{1,3},\d{3}\.\d+$/.test(s)) s = s.replace(/,/g, '');   // thousands groups
            else if (/^[-+]?\d{1,3},\d{3}$/.test(s)) return NaN;                                                          // ambiguous
            else if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(',', '.');                                                   // decimal comma
            else return NaN;
        }
        return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? parseFloat(s) : NaN;
    }
    function _displayOf(path, v) {
        var R = _ranges(), row = R && R.table ? R.table[path] : null;
        if (!_isNum(v)) return '';
        var scale = (row && row.display && _isNum(row.display.scale)) ? row.display.scale : 1;
        var x = v / scale;
        return String(Math.round(x * 1e6) / 1e6);
    }
    function _unitOf(path) {
        var R = _ranges(), row = R && R.table ? R.table[path] : null;
        return row ? ((row.display && row.display.unit) || row.unit || '') : '';
    }
    function _id(path) { return 'prism_dfit_' + String(path).replace(/\./g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(); }

    // Step-① numeric fields: [path, label]; ids are _id(path) (e.g. datumTvd → prism_dfit_datum_tvd)
    var FIELDS = {
        well: [['datumTvd', 'Datum TVD (mid-perforation, required)'], ['datumMd', 'Datum MD (blank = vertical)'],
               ['gauge.bhTvd', 'Bottomhole gauge TVD'], ['gauge.bhMd', 'Bottomhole gauge MD']],
        fluid: [['fluid.rhoPpg', 'Density'], ['fluid.salinityWt', 'Salinity'], ['fluid.muCp', 'Viscosity'], ['fluid.fr', 'Friction reduction (0–0.85)'],
                ['fluid.nPrime', "n′ (gel)"], ['fluid.kPrime', "K′ (gel)"], ['fluid.tInjF', 'Injection temperature']],
        temp: [['temp.surfF', 'Surface temperature'], ['temp.gradFper100', 'Temperature gradient'], ['temp.tauLoH', 'τ_T low'], ['temp.tauHiH', 'τ_T high']],
        perfs: [['perfs.n', 'Shot holes'], ['perfs.dIn', 'Hole diameter'], ['perfs.cd', 'Discharge coefficient C_d']],
        rock: [['rock.Ep', 'Plane-strain modulus E′'], ['rock.nu', "Poisson's ratio ν"], ['rock.hf', 'Fracture height h_f'], ['rock.hp', 'Permeable height h_p'],
               ['rock.barrierSpacing', 'Barrier spacing'], ['rock.sigmaVGrad', 'Overburden gradient'], ['rock.sigmaVGradLo', 'Overburden gradient, low'],
               ['rock.muFricWarn', 'Friction coefficient (warning)'], ['rock.muFricVeto', 'Friction coefficient (veto)'], ['rock.biot', 'Biot coefficient']],
        priors: [['priors.sigmaGrad', 'Prior closure gradient'], ['priors.sigmaGradSd', 'Prior gradient s.d.'], ['priors.piGrad', 'Prior p_i gradient']],
        channels: [['channels.atmPsia', 'Atmospheric pressure'], ['channels.clockOffsetH', 'Clock offset (rate vs pressure)']],
        options: [['options.L', 'Bourdet window L'], ['options.alphaGeneral', 'General α (when α = general)'], ['options.tau.abs', 'Tolerance τ_abs'],
                  ['options.familyWeightF1', 'Family weight F1 (range mode)'], ['options.unc.n', 'Uncertainty draws'], ['options.unc.seed', 'Uncertainty seed']],
        aca: [['options.aca.LB', 'After-closure window L_B']]
    };
    var SELECTS = {
        'fluid.kind': [['water', 'Water'], ['slickwater', 'Slickwater'], ['gel', 'Gel'], ['oil', 'Oil']],
        'temp.model': [['static', 'Static'], ['displaced', 'Displaced']],
        'rock.EpSource': [['unknown', 'Unknown'], ['static', 'Static'], ['dynamic-corrected', 'Dynamic, corrected'], ['dynamic', 'Dynamic']],
        'channels.primary': [['bh', 'Bottomhole gauge'], ['surface', 'Surface (converted)']],
        'options.alpha': [['auto', 'Auto'], ['0.5', '½'], ['1', '1'], ['general', 'General'], ['data', 'Data-driven']],
        'options.tp': [['pump', 'Pump time'], ['breakdown', 'From breakdown'], ['veq', 'Volume-equivalent']],
        'options.aca.origin': [['centroid', 'Centroid'], ['total', 'Total'], ['midInjection', 'Mid-injection'], ['sinceClosure', 'Since closure']],
        'options.aca.tideRemove': [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]
    };
    var SELECT_IDS = { 'fluid.kind': 'prism_dfit_fluid', 'temp.model': 'prism_dfit_tmodel', 'channels.primary': 'prism_dfit_primary',
                       'options.alpha': 'prism_dfit_alpha', 'options.tp': 'prism_dfit_tp', 'options.aca.origin': 'prism_dfit_aca_origin',
                       'rock.EpSource': 'prism_dfit_ep_source', 'options.aca.tideRemove': 'prism_dfit_aca_tide' };
    function _selId(path) { return SELECT_IDS[path] || _id(path); }

    // =========================================================================
    // SECTION 3 — STATE (st.dfit, §3.3)
    // =========================================================================
    var TEST_CAP = 12, LOG_CAP = 300;
    function _newTest(id) {
        return { id: id, zone: '', dsRef: null, inputs: _defaults(),
                 picks: { isip: null, closure: null, user: {}, aca: { origin: 'centroid', linWin: null, radWin: null, piLevel: null } },
                 summary: null, lk: null, hf: null, log: [] };
    }
    function _validTest(t) { return _isObj(t) && typeof t.id === 'string' && /^t\d+$/.test(t.id); }
    function dstate() {
        var st = _st();
        var d = st.dfit;
        if (!_isObj(d) || !(d.tests instanceof Array) && !_arr(d.tests)) d = st.dfit = { v: 2, active: 't1', tests: [], plan: null, live: null };
        d.v = 2;
        var tests = [];
        for (var i = 0; i < d.tests.length && tests.length < TEST_CAP; i++) if (_validTest(d.tests[i])) tests.push(d.tests[i]);
        if (!tests.length) tests.push(_newTest('t1'));
        d.tests = tests;
        tests.forEach(function (t) {
            if (!_isObj(t.inputs)) t.inputs = _defaults();
            if (!_isObj(t.picks)) t.picks = _newTest(t.id).picks;
            if (!_isObj(t.picks.user)) t.picks.user = {};
            if (!_isObj(t.picks.aca)) t.picks.aca = { origin: 'centroid', linWin: null, radWin: null, piLevel: null };
            if (!(t.log instanceof Array) && !_arr(t.log)) t.log = [];
            if (typeof t.zone !== 'string') t.zone = '';
        });
        if (!tests.some(function (t) { return t.id === d.active; })) d.active = tests[0].id;
        if (!('plan' in d)) d.plan = null;
        if (!('live' in d)) d.live = null;
        return d;
    }
    function test() {
        var d = dstate();
        for (var i = 0; i < d.tests.length; i++) if (d.tests[i].id === d.active) return d.tests[i];
        return d.tests[0];
    }
    function _findTest(id) { var d = dstate(); for (var i = 0; i < d.tests.length; i++) if (d.tests[i].id === id) return d.tests[i]; return null; }
    function _who() { var d = dstate(); return (d.report && typeof d.report.who === 'string') ? d.report.who.slice(0, 60) : ''; }
    function logEntry(T, item, oldV, newV, reason) {
        T = T || test();
        if (!(T.log instanceof Array)) T.log = [];
        var seq = T.log.length ? (T.log[T.log.length - 1].seq || T.log.length) + 1 : 1;
        var small = function (v) { var s = JSON.stringify(v == null ? null : v); return (s && s.length > 200) ? s.slice(0, 200) : (v == null ? null : v); };
        T.log.push({ seq: seq, at: _nowISO(), who: _who(), item: String(item).slice(0, 80), old: small(oldV), new: small(newV), reason: _txt(reason || '') });
        if (T.log.length > LOG_CAP) T.log.splice(0, T.log.length - LOG_CAP);
        return T.log[T.log.length - 1];
    }
    function _nextId() {
        var d = dstate(), n = 0;
        d.tests.forEach(function (t) { var k = parseInt(t.id.slice(1), 10); if (k > n) n = k; });
        return 't' + (n + 1);
    }
    function addTest(opts) {
        opts = opts || {};
        var d = dstate();
        if (d.tests.length >= TEST_CAP) return { ok: false, code: 'TEST_CAP', errors: ['A well holds at most ' + TEST_CAP + ' DFIT tests.'], bad: ['tests'] };
        var T = _newTest(_nextId());
        T.zone = _txt(opts.zone || '').slice(0, 40);
        if (opts.copyInputs !== false) { var A = test(); if (A && A.inputs) { T.inputs = _clone(A.inputs); T.inputs.events = _defaults().events; T.inputs.channels.mask = []; } }
        d.tests.push(T);
        _batch('begin');
        var prev = d.active;
        d.active = T.id;
        logEntry(T, 'test.add', null, T.id, opts.reason || 'Test added');
        _dropRun();
        _emit('prism:dfit-updated', { what: 'test', source: 'user' });
        _batch('end');
        _refreshUI();
        return { ok: true, id: T.id, previous: prev };
    }
    function selectTest(id) {
        var d = dstate(), T = _findTest(id);
        if (!T) return { ok: false, code: 'NO_TEST', errors: ['No test ' + _txt(id) + ' in this well.'], bad: ['id'] };
        if (d.active === id) return { ok: true, id: id, loaded: false };
        _batch('begin');
        var old = d.active;
        d.active = id;
        logEntry(T, 'test.open', old, id, 'Opened from the tests table');
        var loaded = _loadTestDataset(T);
        _dropRun();
        _checkBinding();
        runFast('test');
        _emit('prism:dfit-updated', { what: 'test', source: 'user' });
        _batch('end');
        _refreshUI();
        return { ok: true, id: id, loaded: loaded };
    }
    function deleteTest(id) {
        var d = dstate();
        if (d.tests.length <= 1) return { ok: false, code: 'LAST_TEST', errors: ['The last test cannot be deleted; reset its inputs instead.'], bad: ['id'] };
        var i = -1;
        for (var k = 0; k < d.tests.length; k++) if (d.tests[k].id === id) i = k;
        if (i < 0) return { ok: false, code: 'NO_TEST', errors: ['No test ' + _txt(id) + ' in this well.'], bad: ['id'] };
        _batch('begin');
        d.tests.splice(i, 1);
        if (d.active === id) { d.active = d.tests[Math.max(0, i - 1)].id; _dropRun(); }
        _emit('prism:dfit-updated', { what: 'test', source: 'user' });
        _batch('end');
        _refreshUI();
        return { ok: true, id: id, active: d.active };
    }
    function _dropRun() { var st = _st(); delete st._dfitRun; delete st._dfitWhatIf; }
    function _run() { var r = _st()._dfitRun; return (r && r.ok) ? r : null; }

    // ── dataset binding (§2.9) ──
    function dsHash(ds) {
        if (!_hasData(ds)) return null;
        var f = _fn('PRiSM_dfit_dsHash');
        if (f) { try { var h = f(ds); if (typeof h === 'string' && /^[0-9a-f]{16}$/.test(h)) return h; } catch (e) { /* fall through */ } }
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.canon === 'function' && typeof AI.hash16 === 'function') {
            try { return AI.hash16(AI.canon({ t: ds.t, p: ds.p, q: ds.q || null }, 'inputs')); } catch (e) { /* fall through */ }
        }
        // FNV-1a 32-bit, doubled (weak hash; only without 53)
        var s = ds.t.length + ':' + ds.t[0] + ':' + ds.t[ds.t.length - 1] + ':' + ds.p[0] + ':' + ds.p[ds.p.length - 1];
        var h1 = 0x811c9dc5, h2 = 0x01000193;
        for (var i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = (h1 * 16777619) >>> 0; h2 = ((h2 ^ s.charCodeAt(i)) * 2246822519) >>> 0; }
        return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
    }
    function _dsRefOf(ds, kind, id) {
        return { kind: kind || 'data-tab', id: id || null, name: _txt(ds.name || 'Data tab').slice(0, 80), hash: dsHash(ds), n: ds.t.length };
    }
    // compare the active test's binding with the loaded dataset; returns 'bound' | 'other' | 'new' | 'none'
    function _checkBinding() {
        var T = test(), ds = G.PRiSM_dataset;
        if (!_hasData(ds)) return 'none';
        var h = dsHash(ds);
        if (!T.dsRef || !T.dsRef.hash) {
            var kind = (ds.source === 'dfit-demo') ? 'demo' : (ds.source === 'gauge' ? 'gauge' : 'data-tab');
            T.dsRef = _dsRefOf(ds, kind, ds.source === 'dfit-demo' ? (ds.demoName || null) : null);
            if (T.summary) T.summary.forOtherDataset = false;
            return 'new';
        }
        var other = T.dsRef.hash !== h;
        if (T.summary) { T.summary.forOtherDataset = other; if (other) T.summary.stale = true; }
        return other ? 'other' : 'bound';
    }
    function rebind(reason) {
        var T = test(), ds = G.PRiSM_dataset;
        if (!_hasData(ds)) return { ok: false, code: 'NO_DATA', errors: ['Load a DFIT first.'], bad: [] };
        var old = T.dsRef ? T.dsRef.hash : null;
        T.dsRef = _dsRefOf(ds, ds.source === 'dfit-demo' ? 'demo' : 'data-tab', ds.demoName || null);
        logEntry(T, 'dsRef', old, T.dsRef.hash, reason || 'Decisions re-bound to the loaded dataset');
        if (T.summary) { T.summary.forOtherDataset = false; T.summary.stale = true; }
        _emit('prism:dfit-updated', { what: 'test', source: 'user' });
        return { ok: true, hash: T.dsRef.hash };
    }
    function _loadTestDataset(T) {
        var ds = G.PRiSM_dataset;
        if (!T.dsRef || (_hasData(ds) && dsHash(ds) === T.dsRef.hash)) return false;
        if (T.dsRef.kind === 'demo' && T.dsRef.id) return !!loadDemo(T.dsRef.id, { silentBind: true });
        return false;
    }

    // =========================================================================
    // SECTION 4 — RUNS: fast pipeline, ▶ Analyse (§4.20), applying a run
    // =========================================================================
    var _job = null;          // {token, job, cancelled}
    var _token = 0;
    var _status = { text: '', level: 'info' };
    function _setStatus(text, level) {
        _status = { text: _txt(text), level: level || 'info' };
        var el = _byId('prism_dfit_status');
        if (el) { el.textContent = _status.text; el.className = 'prism-dfit-status prism-dfit-status--' + _status.level; }
    }
    function _engineMissing(r) { return !r || r.code === 'NOT_IMPLEMENTED'; }
    function _pipeArgs(fast) {
        var T = test(), o = T.inputs.options || {};
        return [G.PRiSM_dataset, T.inputs, _well(), T.picks,
                { fast: !!fast, seed: (o.unc && o.unc.seed) || 1, uncN: (o.unc && o.unc.n) || 1000, stages: 'all', whatIf: _st()._dfitWhatIf || null }];
    }
    // the fast pipeline (no stability grid, bootstrap or uncertainty): undo restore, picks, drag preview, restore
    function runFast(why) {
        var ds = G.PRiSM_dataset, T = test();
        if (!_hasData(ds)) return null;
        if (T.summary && T.summary.forOtherDataset) return null;
        var f = G.PRiSM_dfit_pipeline;
        if (typeof f !== 'function') { if (T.summary) T.summary.stale = true; return null; }
        var run = null;
        try { run = f.apply(null, _pipeArgs(true)); } catch (e) { run = null; }
        if (!run || run.ok === false) { if (T.summary) T.summary.stale = true; return null; }
        _apply(run, { fast: true, why: why || 'fast' });
        return run;
    }
    function _summaryOf(run) {
        var f = _fn('PRiSM_dfit_summarise'), s = null;
        if (f) { try { s = f(run); } catch (e) { s = null; } }
        if (!s || s.ok === false || !_isObj(s.closure)) s = _clone(run.summary) || null;
        if (s) { s.stale = false; s.forOtherDataset = false; if (!s.at) s.at = _nowISO(); }
        return s;
    }
    // store a run: st._dfitRun, T.summary, PRiSM.multiRate (idealised schedule, bbl/d), C1, WTS_state.dfit, event
    function _apply(run, o) {
        o = o || {};
        var st = _st(), T = test();
        st._dfitRun = run;
        var s = _summaryOf(run);
        if (s) {
            if (o.fast && T.summary && _isObj(T.summary.unc)) s.unc = T.summary.unc;
            T.summary = s;
        }
        if (!T.dsRef || !T.dsRef.hash) _checkBinding();
        // an undo restores C1 and multiRate from its own snapshot: re-writing them here would undo the undo
        if (o.source !== 'undo') { _writeSchedule(run); _writeC1(run); }
        if (!o.fast) { try { _storeHf(run); } catch (e) { /* the windows are optional */ } }
        _publish();
        _emit('prism:dfit-updated', { what: o.what || 'all', source: o.source || 'auto' });
        _refreshUI();
    }
    // High-rate windows (§3.11): the ≥ 2 Hz windows 56 cut on import go to 19's PRiSM_storage as the analysis record
    // 'dfit-hf:<dsHash>' (IndexedDB backend, carried by project files); without IndexedDB only the shut-in window
    // (≤ 150 kB) is kept in 'wts_prism_dfit_hf'. Pressures are scaled integers stored as first differences.
    var HF_LS_KEY = 'wts_prism_dfit_hf', HF_LS_CAP = 150000, HF_MAX = 12000;
    function _encWin(w) {
        var p = _arr(w && w.p) ? w.p : null;
        if (!p || !p.length) return null;
        var n = Math.min(p.length, HF_MAX), scale = 0.01, off = _isNum(p[0]) ? p[0] : 0, d = [], prev = 0;
        for (var i = 0; i < n; i++) { var q = Math.round(((_isNum(p[i]) ? p[i] : off) - off) / scale); d.push(q - prev); prev = q; }
        var kind = /^(shutin|step|flowback|ramp)$/.test(w.kind) ? w.kind : 'shutin';
        return { kind: kind, t0: _num(w.t0), dtS: _num(w.dtS), n: n, p: d, pSurf: null, q: null, scale: scale, offset: off };
    }
    function _storeHf(run) {
        var T = test(), hf = run && run.prep && run.prep.hf;
        var wins = hf && _arr(hf.windows) ? Array.prototype.slice.call(hf.windows, 0, 4).map(_encWin).filter(function (x) { return !!x; }) : [];
        if (!wins.length || !run.dsHash) return null;
        var key = 'dfit-hf:' + run.dsHash, rec = { v: 1, windows: wins };
        var S = G.PRiSM_storage, idb = !!(S && S.backend === 'indexedDB' && typeof S.putAnalysis === 'function');
        var txt = JSON.stringify(rec);
        if (idb) {
            try { S.putAnalysis(key, rec); } catch (e) { idb = false; }
        }
        if (!idb) {
            var shut = wins.filter(function (x) { return x.kind === 'shutin'; }).slice(0, 1);
            txt = JSON.stringify({ v: 1, key: key, windows: shut });
            if (!shut.length || txt.length > HF_LS_CAP) { T.hf = null; return null; }
            var ls = _ls();
            if (ls) { try { ls.setItem(HF_LS_KEY, txt); } catch (e) { T.hf = null; return null; } }
            wins = shut;
        }
        T.hf = { key: key, kinds: wins.map(function (x) { return x.kind; }), bytes: txt.length, store: idb ? 'idb' : 'ls' };
        return T.hf;
    }
    function _schedule(run) {
        var ev = run && run.events;
        if (!ev || !_isNum(ev.ts)) return null;
        var tp = (ev.tp && _isNum(ev.tp.veq) && ev.tp.veq > 0) ? ev.tp.veq : null;
        var qEq = _isNum(ev.qEq) && ev.qEq > 0 ? ev.qEq : null;
        if (!tp || !qEq) return null;
        return [{ t: ev.ts - tp, q: qEq * 1440 }, { t: ev.ts, q: 0 }];
    }
    function _writeSchedule(run) {
        var rows = _schedule(run);
        if (!rows) return false;
        var P = _P();
        P.multiRate = rows;
        var ls = _ls();
        if (ls) { try { ls.setItem('wts_prism_mrate', JSON.stringify(rows)); } catch (e) { /* quota */ } }
        return true;
    }
    function _writeC1(run) {
        if (typeof G.PRiSM_setWell !== 'function' || !run || !run.events) return false;
        var ev = run.events, patch = {};
        var w = _well();
        if (w.testType !== 'falloff') patch.testType = 'falloff';
        if (_isNum(ev.ts)) patch.tShut = ev.ts;
        if (ev.tp && _isNum(ev.tp.veq)) patch.tp = ev.tp.veq;
        if (run.isip && _isNum(run.isip.value)) patch.pwf0 = run.isip.value;
        var same = true;
        for (var k in patch) if (_own(patch, k) && w[k] !== patch[k]) same = false;
        if (same) return false;
        try { G.PRiSM_setWell(patch, { source: 'dfit' }); } catch (e) { return false; }
        return true;
    }
    // WTS_state.dfit (§2.9): field units, published after each stored run
    function _publish() {
        var d = dstate(), T = test(), s = T.summary;
        var W = G.WTS_state = (G.WTS_state && typeof G.WTS_state === 'object') ? G.WTS_state : {};
        if (!s) { W.dfit = { ok: false, tests: _testRows(d) }; return W.dfit; }
        var c = s.closure || {};
        W.dfit = {
            ok: true, ts: (_run() && _run().events) ? _num(_run().events.ts) : null,
            isip: s.isip ? _num(s.isip.value) : null,
            closure: { mode: c.mode || 'none', value: _num(c.value), lo: _num(c.lo), hi: _num(c.hi), label: c.label || null,
                       families: _clone(c.families) || {} },
            closureGrad: _grad(_closureP(s), T), pn: _num(s.pn), eta: _num(s.eta), CL: _num(s.CL), Gamma: _num(s.Gamma), xf: _num(s.xf),
            pi: s.pi ? _num(s.pi.value) : null, piLabel: s.pi ? (s.pi.label || null) : null,
            khmu: _num(s.khmu), k: _num(s.k), kLo: _num(s.kLo), kHi: _num(s.kHi), triage: s.triage || null, grade: s.grade || null,
            tests: _testRows(d), appVersion: _appVersion()
        };
        return W.dfit;
    }
    function _appVersion() {
        var RN = G.RELEASE_NOTES;
        return (RN && RN[0] && RN[0].ver) ? String(RN[0].ver) : null;
    }
    function _closureP(s) {
        var c = s && s.closure;
        if (!c) return null;
        if (c.mode === 'single') return _num(c.value);
        if (c.mode === 'range' && _isNum(c.lo) && _isNum(c.hi)) {
            var F1 = c.families && c.families.F1 && c.families.F1.p50, F2 = c.families && c.families.F2 && c.families.F2.p50;
            if (_isNum(F1) && _isNum(F2)) return (F1 + F2) / 2;
            return (c.lo + c.hi) / 2;
        }
        return null;
    }
    function _grad(p, T) { var z = T && T.inputs ? _num(T.inputs.datumTvd) : null; return (_isNum(p) && z) ? p / z : null; }
    function _testRows(d) {
        return d.tests.map(function (t) {
            var s = t.summary || null;
            return { id: t.id, zone: t.zone || '', datumTvd: _num(t.inputs && t.inputs.datumTvd), closureGrad: _grad(_closureP(s), t),
                     closureLabel: s && s.closure ? (s.closure.label || null) : null, pi: s && s.pi ? _num(s.pi.value) : null,
                     k: s ? _num(s.k) : null, kRange: s && _isNum(s.kLo) && _isNum(s.kHi) ? [s.kLo, s.kHi] : null };
        });
    }

    function _shouldCancelFactory(tok, hadShell) {
        return function () {
            if (!_job || _job.token !== tok || _job.cancelled || tok !== _token) return true;
            if (hadShell) { var sh = _shell(); if (!sh || sh.isConnected === false) return true; }
            if (hooksReady() && G.PRiSM && G.PRiSM.mode !== 'dfit') return true;
            return false;
        };
    }
    function cancelAnalyse(why) {
        if (!_job) return false;
        _job.cancelled = true;
        try { if (_job.job && typeof _job.job.cancel === 'function') _job.job.cancel(); } catch (e) { /* ignore */ }
        if (why) _setStatus(why, 'warn');
        return true;
    }
    function _runJobSync(job, shouldCancel, onProgress) {
        for (var i = 0; i < 100000; i++) {
            if (shouldCancel()) { if (job.cancel) job.cancel(); throw { code: 'CANCELLED' }; }
            var s = job.step();
            if (onProgress) onProgress(s.progress, s.label);
            if (s.done) return job.result();
        }
        throw { code: 'STEP_CAP' };
    }
    function analyse(opts) {
        opts = opts || {};
        var resolved = function (v) { return (typeof Promise !== 'undefined') ? Promise.resolve(v) : v; };
        var ds = G.PRiSM_dataset;
        if (!_hasData(ds)) { _setStatus('⚠ Load a DFIT first: paste or open a record on the Data step, or load a demo DFIT.', 'warn'); return resolved({ ok: false, code: 'NO_DATA', errors: ['Load a DFIT first.'], bad: [] }); }
        var T = test();
        var bind = _checkBinding();
        if (bind === 'other') { _setStatus('⚠ The decisions of this test belong to another dataset: load it, or re-bind the test to the loaded data.', 'warn'); return resolved({ ok: false, code: 'OTHER_DATASET', errors: ['Decisions belong to another dataset.'], bad: [] }); }
        var mk = G.PRiSM_dfit_pipelineJob;
        if (typeof mk !== 'function') { _setStatus('⚠ The DFIT engines are not in this build.', 'warn'); return resolved({ ok: false, code: 'NO_ENGINE', errors: ['No pipeline.'], bad: [] }); }
        if (_job) cancelAnalyse();
        var tok = ++_token, job = null;
        try { job = mk.apply(null, _pipeArgs(false)); } catch (e) { job = null; }
        if (!job || typeof job.step !== 'function') { _setStatus('⚠ The DFIT pipeline could not start.', 'warn'); return resolved({ ok: false, code: 'NO_JOB', errors: ['No job.'], bad: [] }); }
        _job = { token: tok, job: job, cancelled: false };
        var hadShell = !!_shell();
        var shouldCancel = _shouldCancelFactory(tok, hadShell);
        var onProgress = function (p, label) {
            var el = _byId('prism_dfit_progress');
            if (el) { el.style.display = ''; el.textContent = 'Analysing… ' + Math.round(100 * (_isNum(p) ? p : 0)) + ' %' + (label ? ' · ' + _txt(label).slice(0, 60) : ''); }
            if (typeof opts.onProgress === 'function') { try { opts.onProgress(p, label); } catch (e) { /* ignore */ } }
        };
        _setStatus('Analysing…', 'info');
        _batch('begin');
        var ended = false;
        var finish = function () { if (!ended) { ended = true; _batch('end'); } if (_job && _job.token === tok) _job = null; var el = _byId('prism_dfit_progress'); if (el) el.style.display = 'none'; };
        var done = function (run) {
            if (!run || run.ok === false) {
                finish();
                _setStatus(_engineMissing(run) ? '⚠ The DFIT engines are not available in this build yet: previous results kept.' : '⚠ The analysis failed: ' + _txt((run && run.errors && run.errors[0]) || 'no result'), 'warn');
                return run || { ok: false, code: 'NO_RESULT', errors: ['No result.'], bad: [] };
            }
            try { _apply(run, { fast: false, what: 'all', source: 'auto' }); } catch (e) { finish(); throw e; }
            finish();
            _nAnalyse++;
            _setStatus('✓ Analysis ' + _nAnalyse + ' complete' + (run && run.counts && _isNum(run.counts.evals) ? ' (' + _f(run.counts.evals, 0) + ' evaluations)' : '') + '.', 'ok');
            return run;
        };
        var fail = function (err) {
            finish();
            if (err && err.code === 'CANCELLED') { _setStatus('Cancelled — previous results kept.', 'warn'); return { ok: false, code: 'CANCELLED', errors: ['Cancelled.'], bad: [] }; }
            _setStatus('⚠ The analysis stopped: ' + _txt((err && err.message) || (err && err.code) || 'error'), 'warn');
            return { ok: false, code: 'PIPELINE_FAILED', errors: [_txt((err && err.message) || 'error')], bad: [] };
        };
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.drive === 'function' && typeof Promise !== 'undefined') {
            return AI.drive(job, { shouldCancel: shouldCancel, onProgress: onProgress }).then(done, fail);
        }
        var out;
        try { out = done(_runJobSync(job, shouldCancel, onProgress)); } catch (e) { out = fail(e); }
        return resolved(out);
    }

    // =========================================================================
    // SECTION 5 — PICKS (the only writer, §3.8, §7.10) and inputs
    // =========================================================================
    var PICK_ITEMS = { isip: 1, closure: 1, aca: 1 };
    function setPick(item, value, o) {
        _batch('begin');
        try { return _setPick(item, value, o); } finally { _batch('end'); }
    }
    function _setPick(item, value, o) {
        o = o || {};
        var T = test(), source = o.source || 'user';
        var reason = _txt(o.reason || '');
        if (source === 'user' && !reason && o.requireReason) return { ok: false, code: 'REASON_REQUIRED', errors: ['A reason is required for an override.'], bad: ['reason'] };
        var key = String(item || '');
        var old;
        if (PICK_ITEMS[key]) {
            old = _clone(T.picks[key]);
            if (value == null) T.picks[key] = (key === 'aca') ? { origin: 'centroid', linWin: null, radWin: null, piLevel: null } : null;
            else if (key === 'aca') { var a = T.picks.aca; for (var k in value) if (_own(value, k)) a[k] = value[k]; }
            else { var v = _clone(value) || {}; v.source = source; v.reason = reason; v.at = _nowISO(); T.picks[key] = v; }
        } else if (/^dfit[A-Z]\w*$/.test(key)) {
            old = _clone(T.picks.user[key] || null);
            if (value == null) delete T.picks.user[key];
            else { var u = _clone(value) || {}; u.at = _nowISO(); T.picks.user[key] = u; }
        } else return { ok: false, code: 'BAD_ITEM', errors: ['Unknown pick ' + _txt(key) + '.'], bad: ['item'] };
        logEntry(T, PICK_ITEMS[key] ? key : 'pick.' + key, old && (old.value != null ? old.value : (old.p != null ? old.p : old)),
                 value && (value.value != null ? value.value : (value.p != null ? value.p : value)), reason || (source === 'user' ? 'User pick' : 'Automatic pick'));
        if (T.summary) T.summary.stale = true;
        _emit('prism:dfit-updated', { what: 'pick', item: key, source: source });
        if (o.fast !== false) runFast('pick');
        _refreshUI();
        return { ok: true, item: key };
    }
    // one input field written from the UI: clamp, store, log; returns {value, warning}
    function setInput(path, raw, o) {
        o = o || {};
        var T = test(), r;
        var R = _ranges();
        if (SELECTS[path]) {
            var en = R && R.enums ? R.enums[path] : null, v = raw;
            if (path === 'options.alpha' && (raw === '0.5' || raw === '1')) v = +raw;
            if (en && en.indexOf(v) === -1) v = _getPath(_defaults(), path);
            r = { value: v, warning: null };
        } else if (/^options\.(axisLock|ppd)$|carterExactFR$/.test(path)) {
            r = { value: !!raw, warning: null };
        } else r = clampField(path, raw);
        var old = _getPath(T.inputs, path);
        if (old === r.value) return r;
        _setPath(T.inputs, path, r.value);
        logEntry(T, 'inputs.' + path, old, r.value, o.reason || 'Edited in the DFIT cards');
        if (T.summary) T.summary.stale = true;
        if (o.silent !== true) _emit('prism:dfit-updated', { what: 'test', source: 'user' });
        return r;
    }
    function results() { var T = test(); return T.summary || null; }

    // ── demo datasets (49-calc-dfit-synth, WP5) committed with a role-header CSV in the Data-tab text (§2.9) ──
    var DEMOS = [['reference', 'Reference (normal leak-off)'], ['tight-linear', 'Tight, linear flow'], ['conventional-radial', 'Conventional, radial flow'],
                 ['contact', 'Contact (closure range)'], ['pdl', 'Pressure-dependent leak-off'], ['surface-gauge', 'Surface gauge'], ['two-cycle', 'Two cycles']];
    function _csvOf(ds) {
        var cols = [['time_h', ds.t], ['pressure_psia', ds.p]];
        if (_arr(ds.q)) cols.push(['rate_bbl/d', ds.q]);
        if (_arr(ds.pSurf)) cols.push(['pressure_surf_psia', ds.pSurf]);
        if (_arr(ds.T)) cols.push(['temp_F', ds.T]);
        if (_arr(ds.pAnn)) cols.push(['pressure_ann_psia', ds.pAnn]);
        if (_arr(ds.qFb)) cols.push(['rate_fb_bbl/d', ds.qFb]);
        var lines = [cols.map(function (c) { return c[0]; }).join(',')];
        for (var i = 0; i < ds.t.length; i++) lines.push(cols.map(function (c) { var v = c[1][i]; return _isNum(v) ? String(v) : ''; }).join(','));
        return lines.join('\n');
    }
    function loadDemo(name, o) {
        o = o || {};
        var S = G.PRiSM_dfit_synth, ds = null;
        if (S && typeof S.demo === 'function') { try { ds = S.demo(name); } catch (e) { ds = null; } }
        if (!_hasData(ds) || ds.ok === false) { _setStatus('⚠ The demo DFIT datasets are not available in this build yet.', 'warn'); return null; }
        ds.source = 'dfit-demo'; ds.demoName = name;
        if (!ds.name) ds.name = 'DFIT demo — ' + name;
        var csv = _csvOf(ds);
        if (typeof PRiSM_persistPaste === 'function') { try { PRiSM_persistPaste(csv); } catch (e) { /* ignore */ } }
        var box = _byId('prism_data_paste');
        if (box) box.value = csv;
        _batch('begin');
        if (typeof G.PRiSM_commitDataset === 'function') G.PRiSM_commitDataset(ds, { source: 'dfit-demo', name: ds.name });
        else { G.PRiSM_dataset = ds; _emit('prism:dataset-loaded', { source: 'dfit-demo', dataset: ds }); }
        var T = test();
        if (!T.dsRef || T.dsRef.hash !== dsHash(ds)) {
            if (!o.silentBind) logEntry(T, 'dsRef', T.dsRef ? T.dsRef.hash : null, dsHash(ds), 'Demo DFIT ' + name + ' loaded');
            T.dsRef = _dsRefOf(ds, 'demo', name);
            if (T.summary) { T.summary.forOtherDataset = false; T.summary.stale = true; }
        }
        _batch('end');
        _refreshUI();
        return ds;
    }

    // =========================================================================
    // SECTION 6 — PLOT FUNCTIONS (host-IIFE scope: the 02 lexical helpers, typeof-guarded)
    // =========================================================================
    function _theme(k, d) { try { return (typeof PRiSM_THEME !== 'undefined' && PRiSM_THEME[k]) ? PRiSM_THEME[k] : d; } catch (e) { return d; } }
    function _plotLib() {
        return typeof PRiSM_plot_setup === 'function' && typeof PRiSM_plot_axes === 'function' && typeof PRiSM_plot_finish === 'function' &&
               typeof PRiSM_plot_line === 'function' && typeof PRiSM_plot_range === 'function';
    }
    function _msgCanvas(canvas, msg) {
        if (typeof PRiSM_plot_message === 'function') { try { PRiSM_plot_message(canvas, msg); return; } catch (e) { /* fall through */ } }
        try {
            var c = canvas.getContext && canvas.getContext('2d');
            if (!c) return;
            c.clearRect(0, 0, canvas.width || 300, canvas.height || 150);
            c.fillStyle = '#8b949e'; c.font = '13px sans-serif'; c.textAlign = 'center';
            c.fillText(msg, (canvas.width || 300) / 2, (canvas.height || 150) / 2);
        } catch (e) { /* ignore */ }
    }
    function _pairs(x, y) { var out = []; if (!_arr(x) || !_arr(y)) return out; for (var i = 0; i < x.length && i < y.length; i++) out.push([x[i], y[i]]); return out; }
    function _finiteVals(a, log) { var out = []; if (!_arr(a)) return out; for (var i = 0; i < a.length; i++) { var v = a[i]; if (_isNum(v) && (!log || v > 0)) out.push(v); } return out; }
    function _fillBand(ctx, x, lo, hi, toX, toY, color) {
        var pts = [], i;
        for (i = 0; i < x.length; i++) if (_isNum(x[i]) && _isNum(lo[i]) && _isNum(hi[i])) pts.push(i);
        if (pts.length < 2) return;
        ctx.save(); ctx.fillStyle = color; ctx.beginPath();
        for (i = 0; i < pts.length; i++) { var j = pts[i], X = toX(x[j]), Y = toY(lo[j]); if (!isFinite(X) || !isFinite(Y)) continue; if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); }
        for (i = pts.length - 1; i >= 0; i--) { var k = pts[i], X2 = toX(x[k]), Y2 = toY(hi[k]); if (isFinite(X2) && isFinite(Y2)) ctx.lineTo(X2, Y2); }
        ctx.closePath(); ctx.fill(); ctx.restore();
    }
    function _vline(ctx, plot, X, color, dash, label) {
        if (!isFinite(X) || X < plot.x - 1 || X > plot.x + plot.w + 1) return;
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; if (dash && ctx.setLineDash) ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(X, plot.y); ctx.lineTo(X, plot.y + plot.h); ctx.stroke();
        if (label) { if (ctx.setLineDash) ctx.setLineDash([]); ctx.fillStyle = color; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(label, X + 3, plot.y + 3, 140); }
        ctx.restore();
    }
    function _hline(ctx, plot, Y, color, dash, label) {
        if (!isFinite(Y) || Y < plot.y - 1 || Y > plot.y + plot.h + 1) return;
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.2; if (dash && ctx.setLineDash) ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(plot.x, Y); ctx.lineTo(plot.x + plot.w, Y); ctx.stroke();
        if (label) { if (ctx.setLineDash) ctx.setLineDash([]); ctx.fillStyle = color; ctx.font = '11px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(label, plot.x + plot.w - 4, Y - 2, 180); }
        ctx.restore();
    }
    // Dual-axis DFIT plot. data = {series:[{x, y, axis:'L'|'R', color, dash, dots, width, label}], bands:[{x, lo, hi, axis, color}],
    //   vlines:[{x, color, dash, label}], hlines:[{y, axis, color, dash, label}], shade:[{x0, x1, color}], hbands:[{y0, y1, axis, color}],
    //   markers:[{x, y, axis, color, label, hollow}],
    //   xKind, yKind ('lin'|'log'), xRange:{min,max}?, yRange:{min,max}?, yR:{min, max, label}? (right linear axis)}
    function PRiSM_plot_dfitDual(canvas, data, opts) {
        opts = opts || {};
        if (!canvas || typeof canvas.getContext !== 'function') return false;
        if (!_plotLib()) { _msgCanvas(canvas, 'Plot library not loaded'); return false; }
        var series = (data && _arr(data.series)) ? data.series : [];
        var hasR = !!(data && data.yR && series.some(function (s) { return s.axis === 'R'; }));
        var setup = PRiSM_plot_setup(canvas, opts, { secondaryAxis: hasR });
        var ctx = setup.ctx, plot = setup.plot;
        if (!series.length) { PRiSM_plot_noData(setup, opts.empty || 'No data'); return false; }
        var xKind = data.xKind === 'log' ? 'log' : 'lin', yKind = data.yKind === 'log' ? 'log' : 'lin';
        var xs = [], ys = [];
        series.forEach(function (s) { xs = xs.concat(_finiteVals(s.x, xKind === 'log')); if (s.axis !== 'R') ys = ys.concat(_finiteVals(s.y, yKind === 'log')); });
        (data.bands || []).forEach(function (b) { if (b.axis !== 'R') { ys = ys.concat(_finiteVals(b.lo, yKind === 'log')).concat(_finiteVals(b.hi, yKind === 'log')); } });
        (data.hlines || []).forEach(function (h) { if (h.axis !== 'R' && h.fit && _isNum(h.y)) ys.push(h.y); });
        if (!xs.length || !ys.length) { PRiSM_plot_noData(setup, opts.empty || 'No data'); return false; }
        var xr = (data.xRange && _isNum(data.xRange.min) && data.xRange.max > data.xRange.min) ? data.xRange : PRiSM_plot_range(xs, xKind === 'log', 0.03, 8);
        var yr = (data.yRange && _isNum(data.yRange.min) && data.yRange.max > data.yRange.min) ? data.yRange : PRiSM_plot_range(ys, yKind === 'log', 0.06, 6);
        var scaleX = { kind: xKind, min: xr.min, max: xr.max, label: opts.xLabel || data.xLabel || 'x' };
        var scaleY = { kind: yKind, min: yr.min, max: yr.max, label: opts.yLabel || data.yLabel || 'y' };
        var scaleY2 = hasR ? { min: data.yR.min, max: data.yR.max, label: data.yR.label || '', color: _theme('cyan', '#39c5cf') } : null;
        var first = series[0], points = _pairs(first.x, first.y);
        function render() {
            var tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || data.title || '', scaleY2: scaleY2 });
            var toYR = tr.toY2 || null;
            var yOf = function (axis) { return axis === 'R' ? toYR : tr.toY; };
            if (typeof PRiSM_plot_clip === 'function') PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h); else ctx.save();
            (data.shade || []).forEach(function (s) {
                var a = tr.toX(s.x0), b = tr.toX(s.x1);
                if (!isFinite(a) || !isFinite(b)) return;
                ctx.save(); ctx.fillStyle = s.color || 'rgba(88,166,255,0.10)'; ctx.fillRect(Math.min(a, b), plot.y, Math.abs(b - a), plot.h); ctx.restore();
            });
            (data.hbands || []).forEach(function (b) {
                var ty = yOf(b.axis); if (!ty || !_isNum(b.y0) || !_isNum(b.y1)) return;
                var a = ty(b.y0), c = ty(b.y1); if (!isFinite(a) || !isFinite(c)) return;
                ctx.save(); ctx.fillStyle = b.color || 'rgba(210,153,34,0.14)'; ctx.fillRect(plot.x, Math.min(a, c), plot.w, Math.abs(c - a)); ctx.restore();
            });
            (data.bands || []).forEach(function (b) { var ty = yOf(b.axis); if (ty) _fillBand(ctx, b.x, b.lo, b.hi, tr.toX, ty, b.color || 'rgba(88,166,255,0.18)'); });
            series.forEach(function (s) {
                var ty = yOf(s.axis);
                if (!ty) return;
                var pts = _pairs(s.x, s.y);
                if (s.dots && typeof PRiSM_plot_dots === 'function') PRiSM_plot_dots(ctx, pts, tr.toX, ty, s.color || _theme('accent', '#f0883e'), s.r || 2.2);
                else PRiSM_plot_line(ctx, pts, tr.toX, ty, s.color || _theme('accent', '#f0883e'), { width: s.width || 2, dash: s.dash || null });
            });
            (data.hlines || []).forEach(function (h) { var ty = yOf(h.axis); if (ty && _isNum(h.y)) _hline(ctx, plot, ty(h.y), h.color || _theme('text2', '#8b949e'), h.dash || [4, 4], h.label || ''); });
            (data.vlines || []).forEach(function (v) { if (_isNum(v.x)) _vline(ctx, plot, tr.toX(v.x), v.color || _theme('text2', '#8b949e'), v.dash || [4, 4], v.label || ''); });
            (data.markers || []).forEach(function (m) {
                var ty = yOf(m.axis); if (!ty || !_isNum(m.x) || !_isNum(m.y)) return;
                var X = tr.toX(m.x), Y = ty(m.y); if (!isFinite(X) || !isFinite(Y)) return;
                ctx.save(); ctx.beginPath(); ctx.arc(X, Y, m.r || 4.5, 0, Math.PI * 2);
                if (m.hollow) { ctx.strokeStyle = m.color || '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); } else { ctx.fillStyle = m.color || '#fff'; ctx.fill(); }
                if (m.label) { ctx.fillStyle = m.color || '#fff'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(m.label, X + 6, Y - 6, 160); }
                ctx.restore();
            });
            ctx.restore();
            if (opts.showLegend !== false && typeof PRiSM_plot_legend === 'function') {
                var items = series.filter(function (s) { return s.label; }).map(function (s) { return { label: s.label, color: s.color || _theme('accent', '#f0883e'), dash: !!s.dash, marker: s.dots ? 'dot' : 'line' }; });
                if (items.length) PRiSM_plot_legend(ctx, items.slice(0, 6), plot);
            }
        }
        PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: opts.plotKey || data.plotKey || null, data: data,
                                           xName: data.xName || 'x', yName: data.yName || 'y' });
        return true;
    }
    // Closure strip: one row per family (F0 top … F4 bottom) on a pressure axis.
    // data = {rows:[{fam, label, band:{p10,p50,p90}|null, members:[{p, method, vote, vetoed}]}], consensus:{mode, value, lo, hi, medians:[]},
    //         friction:{veto, warn}, whatIf:p|null, xRange?}
    var FAM_COLORS = { F0: '#8b949e', F1: '#58a6ff', F2: '#f0883e', F3: '#bc8cff', F4: '#3fb950' };
    function PRiSM_plot_dfitStrip(canvas, data, opts) {
        opts = opts || {};
        if (!canvas || typeof canvas.getContext !== 'function') return false;
        if (!_plotLib()) { _msgCanvas(canvas, 'Plot library not loaded'); return false; }
        var setup = PRiSM_plot_setup(canvas, opts);
        var ctx = setup.ctx, plot = setup.plot;
        var rows = (data && _arr(data.rows)) ? data.rows : [];
        var ps = [];
        rows.forEach(function (r) { (r.members || []).forEach(function (m) { if (_isNum(m.p)) ps.push(m.p); }); if (r.band) { if (_isNum(r.band.p10)) ps.push(r.band.p10); if (_isNum(r.band.p90)) ps.push(r.band.p90); } });
        var c = (data && data.consensus) || {};
        [c.value, c.lo, c.hi, data && data.whatIf, data && data.friction && data.friction.veto, data && data.friction && data.friction.warn].forEach(function (v) { if (_isNum(v)) ps.push(v); });
        if (!ps.length) { PRiSM_plot_noData(setup, opts.empty || 'No closure picks yet — run ▶ Analyse'); return false; }
        var xr = (data.xRange && data.xRange.max > data.xRange.min) ? data.xRange : PRiSM_plot_range(ps, false, 0.12);
        var scaleX = { kind: 'lin', min: xr.min, max: xr.max, label: 'Closure pressure (psia)' };
        var scaleY = { kind: 'lin', min: -0.5, max: 4.5, label: 'F4 · F3 · F2 · F1 · F0' };
        var points = ps.map(function (p) { return [p, 0]; });
        function render() {
            var tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Closure consensus strip' });
            if (typeof PRiSM_plot_clip === 'function') PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h); else ctx.save();
            if (c.mode === 'range' && _isNum(c.lo) && _isNum(c.hi)) {
                ctx.save(); ctx.fillStyle = 'rgba(210,153,34,0.14)'; var a = tr.toX(c.lo), b = tr.toX(c.hi); ctx.fillRect(Math.min(a, b), plot.y, Math.abs(b - a), plot.h); ctx.restore();
                (c.medians || []).forEach(function (m) { if (_isNum(m)) _vline(ctx, plot, tr.toX(m), '#d29922', [2, 3], _f(m, 0)); });
            } else if (_isNum(c.value)) _vline(ctx, plot, tr.toX(c.value), '#3fb950', null, _f(c.value, 0));
            if (data.friction) {
                if (_isNum(data.friction.veto)) _vline(ctx, plot, tr.toX(data.friction.veto), '#f85149', [6, 3], 'μ veto');
                if (_isNum(data.friction.warn)) _vline(ctx, plot, tr.toX(data.friction.warn), '#d29922', [6, 3], 'μ warn');
            }
            if (_isNum(data.whatIf)) _vline(ctx, plot, tr.toX(data.whatIf), '#bc8cff', [3, 2], 'what-if');
            rows.forEach(function (r) {
                var idx = parseInt(String(r.fam).slice(1), 10);
                if (!(idx >= 0 && idx <= 4)) return;
                var Y = tr.toY(4 - idx), col = FAM_COLORS[r.fam] || '#8b949e';
                if (r.band && _isNum(r.band.p10) && _isNum(r.band.p90)) {
                    var x0 = tr.toX(r.band.p10), x1 = tr.toX(r.band.p90);
                    ctx.save(); ctx.fillStyle = col; ctx.globalAlpha = 0.35; ctx.fillRect(Math.min(x0, x1), Y - 6, Math.max(2, Math.abs(x1 - x0)), 12); ctx.restore();
                }
                (r.members || []).forEach(function (m) {
                    if (!_isNum(m.p)) return;
                    var X = tr.toX(m.p);
                    ctx.save(); ctx.beginPath(); ctx.arc(X, Y, m.vote ? 5 : 4, 0, Math.PI * 2);
                    if (m.vote) { ctx.fillStyle = col; ctx.fill(); } else { ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke(); }
                    if (m.vetoed) { ctx.strokeStyle = '#f85149'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X - 7, Y - 7); ctx.lineTo(X + 7, Y + 7); ctx.stroke(); }
                    ctx.restore();
                });
                ctx.save(); ctx.fillStyle = col; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText(r.fam + (r.label ? ' ' + r.label : ''), plot.x + 4, Y - 11, 200); ctx.restore();
            });
            ctx.restore();
        }
        try {
            var fams = rows.map(function (r) { return r.fam + (r.band && _isNum(r.band.p50) ? ' ' + _f(r.band.p50, 0) : ''); }).join(', ');
            var cs = c.mode === 'single' ? 'single closure ' + _f(c.value, 0) + ' psia' : (c.mode === 'range' ? 'closure range ' + _f(c.lo, 0) + ' to ' + _f(c.hi, 0) + ' psia' : 'no closure');
            canvas.setAttribute('aria-label', 'Closure strip: ' + cs + '. Families ' + fams + '.');
            canvas.setAttribute('role', 'img');
        } catch (e) { /* aria is a nicety */ }
        PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: opts.plotKey || 'dfitStrip', data: data, xName: 'p', yName: 'family' });
        return true;
    }
    // Stacked partition: data = {x:[], layers:[{label, y:[], color}], xLabel, yLabel, xKind}
    function PRiSM_plot_dfitStack(canvas, data, opts) {
        opts = opts || {};
        if (!canvas || typeof canvas.getContext !== 'function') return false;
        if (!_plotLib()) { _msgCanvas(canvas, 'Plot library not loaded'); return false; }
        var setup = PRiSM_plot_setup(canvas, opts);
        var layers = (data && _arr(data.layers)) ? data.layers : [];
        if (!layers.length || !data || !_arr(data.x) || !data.x.length) { PRiSM_plot_noData(setup, opts.empty || 'No data'); return false; }
        var n = data.x.length, cum = [], top = [];
        layers.forEach(function (L, j) {
            var row = [];
            for (var i = 0; i < n; i++) { var v = _isNum(L.y[i]) ? Math.max(0, L.y[i]) : 0; row.push((j ? cum[j - 1][i] : 0) + v); }
            cum.push(row);
        });
        top = cum[cum.length - 1];
        var xKind = data.xKind === 'log' ? 'log' : 'lin';
        var xr = PRiSM_plot_range(_finiteVals(data.x, xKind === 'log'), xKind === 'log', 0.02, 8), yr = PRiSM_plot_range(top.concat([0]), false, 0.05);
        var scaleX = { kind: xKind, min: xr.min, max: xr.max, label: opts.xLabel || data.xLabel || 't (h)' };
        var scaleY = { kind: 'lin', min: Math.min(0, yr.min), max: yr.max, label: opts.yLabel || data.yLabel || 'Volume (bbl)' };
        var ctx = setup.ctx, plot = setup.plot;
        function render() {
            var tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || data.title || '' });
            if (typeof PRiSM_plot_clip === 'function') PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h); else ctx.save();
            for (var j = cum.length - 1; j >= 0; j--) {
                var lo = j ? cum[j - 1] : data.x.map(function () { return 0; });
                _fillBand(ctx, data.x, lo, cum[j], tr.toX, tr.toY, layers[j].color || 'rgba(88,166,255,0.4)');
            }
            ctx.restore();
            if (typeof PRiSM_plot_legend === 'function') PRiSM_plot_legend(ctx, layers.map(function (L) { return { label: L.label, color: L.color || '#58a6ff' }; }), plot);
        }
        PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: _pairs(data.x, top), plotKey: opts.plotKey || null, data: data, xName: 'x', yName: 'V' });
        return true;
    }

    // =========================================================================
    // SECTION 7 — PLOT REGISTRY ENTRIES AND DATA BUILDERS (§7.9)
    // =========================================================================
    var C = { p: '#f0883e', d1: '#3fb950', d2: '#58a6ff', ref: '#8b949e', band: 'rgba(88,166,255,0.16)', q: '#39c5cf', y: '#d29922', r: '#f85149', v: '#bc8cff' };
    var NEED_RUN = 'Run ▶ Analyse (or load a demo DFIT) to draw this plot.';
    function _interp(xs, ys, x) {
        if (!_arr(xs) || !xs.length) return null;
        var n = xs.length, inc = xs[n - 1] >= xs[0];
        for (var i = 1; i < n; i++) {
            var a = xs[i - 1], b = xs[i];
            if (!_isNum(a) || !_isNum(b) || !_isNum(ys[i - 1]) || !_isNum(ys[i])) continue;
            if ((inc && x >= a && x <= b) || (!inc && x <= a && x >= b)) return (b === a) ? ys[i] : ys[i - 1] + (ys[i] - ys[i - 1]) * (x - a) / (b - a);
        }
        return null;
    }
    // G at a closure pressure (the falloff is monotone before closure)
    function _gAtP(d, p) { if (!d || !_isNum(p)) return null; return _interp(d.p, d.G, p); }
    function _closureOf(run) {
        var c = run && (run.consensus || run.consensusLite);
        if (!c) return { mode: 'none' };
        var fam = c.families || {};
        var med = [];
        if (c.range && c.range.medians) { med = [c.range.medians.low, c.range.medians.high]; }
        else if (c.mode === 'range') { ['F1', 'F2', 'F4'].forEach(function (k) { if (fam[k] && _isNum(fam[k].p50)) med.push(fam[k].p50); }); }
        return { mode: c.mode, value: _num(c.value), lo: c.range ? _num(c.range.lo) : null, hi: c.range ? _num(c.range.hi) : null, medians: med, families: fam };
    }
    function _scaleR(lo, hi, label) { if (!_isNum(lo) || !_isNum(hi) || hi <= lo) return null; return { min: lo, max: hi, label: label }; }
    function _rangeOf(arr, from) {
        var v = [];
        for (var i = from || 0; i < (arr ? arr.length : 0); i++) if (_isNum(arr[i])) v.push(arr[i]);
        if (!v.length) return null;
        v.sort(function (a, b) { return a - b; });
        var lo = v[Math.floor(0.02 * (v.length - 1))], hi = v[Math.ceil(0.98 * (v.length - 1))];
        if (!(hi > lo)) { hi = lo + 1; }
        return [Math.min(0, lo), hi * 1.1];
    }
    var _axisLock = null;   // runtime: the derivative ranges captured when "lock axis" was turned on
    function _derivAxis(d, key) {
        var T = test(), o = T.inputs.options || {};
        if (o.axisLock && _axisLock && _axisLock[key]) return _axisLock[key];
        var a = (d.axis && _arr(d.axis[key]) && d.axis[key].length === 2 && _isNum(d.axis[key][0]) && d.axis[key][1] > d.axis[key][0]) ? d.axis[key].slice() : null;
        if (!a) a = _rangeOf(d[key]);
        if (o.axisLock && a) { _axisLock = _axisLock || {}; _axisLock[key] = a; }
        return a;
    }
    function _pickVlines(run, xOf) {
        var out = [], c = _closureOf(run);
        if (c.mode === 'single' && _isNum(c.value)) { var x = xOf(c.value); if (_isNum(x)) out.push({ x: x, color: C.d1, dash: [6, 3], label: 'closure ' + _f(c.value, 0) }); }
        if (c.mode === 'range') (c.medians || []).forEach(function (m) { var x2 = xOf(m); if (_isNum(x2)) out.push({ x: x2, color: C.y, dash: [6, 3], label: _f(m, 0) }); });
        return out;
    }
    var B = {};   // plotKey → function(run, T, ds) → {data, opts} | {error}
    B.dfitHistory = function (run, T, ds) {
        if (!_hasData(ds)) return { error: 'No data loaded — load a DFIT on the Data step.' };
        var s = [{ x: ds.t, y: ds.p, color: C.p, label: 'p (psia)' }];
        if (_arr(ds.pSurf)) s.push({ x: ds.t, y: ds.pSurf, color: C.d2, dash: [5, 3], label: 'p_surf (psia)' });
        var qmax = 0, q = null;
        if (_arr(ds.q)) { q = ds.q.map(function (v) { return _isNum(v) ? v / 1440 : null; }); q.forEach(function (v) { if (_isNum(v) && v > qmax) qmax = v; }); }
        var yR = null;
        if (q && qmax > 0) { s.push({ x: ds.t, y: q, axis: 'R', color: C.q, width: 1.5, label: 'q (bbl/min)' }); yR = { min: 0, max: qmax * 1.2, label: 'Rate (bbl/min)' }; }
        var v = [];
        var ev = run && run.events;
        if (ev) {
            if (_isNum(ev.tStart)) v.push({ x: ev.tStart, color: C.q, label: 'start' });
            if (_isNum(ev.tb)) v.push({ x: ev.tb, color: C.y, label: 'breakdown' });
            if (_isNum(ev.ts)) v.push({ x: ev.ts, color: C.r, label: 'shut-in' });
        }
        var shade = [];
        if (run && run.triage && run.triage.windows) (run.triage.windows.excluded || []).forEach(function (w) { if (_isNum(w.t0) && _isNum(w.t1)) shade.push({ x0: w.t0, x1: w.t1, color: 'rgba(248,81,73,0.10)' }); });
        return { data: { series: s, vlines: v, shade: shade, yR: yR, xKind: 'lin', yKind: 'lin', xName: 't', yName: 'p' }, opts: { title: 'DFIT history', xLabel: 'Time, t (h)', yLabel: 'Pressure (psia)' } };
    };
    B.dfitConv = function (run, T, ds) {
        if (!_hasData(ds)) return { error: 'No data loaded — load a DFIT on the Data step.' };
        var pr = run && run.prep;
        if (!pr || pr.src !== 'surface-converted') {
            if (!_arr(ds.pSurf)) return { error: 'No surface channel: the primary gauge is bottomhole (no conversion needed).' };
            return { data: { series: [{ x: ds.t, y: ds.pSurf, color: C.d2, label: 'p_surf' }, { x: ds.t, y: ds.p, color: C.p, label: 'p (BH)' }], xName: 't', yName: 'p' },
                     opts: { title: 'Surface and bottomhole pressure', xLabel: 'Time, t (h)', yLabel: 'Pressure (psia)' } };
        }
        var s = [{ x: pr.t, y: pr.pw, color: C.p, label: 'converted p_w' }];
        if (_arr(pr.pSurf)) s.unshift({ x: pr.t, y: pr.pSurf, color: C.d2, dash: [5, 3], label: 'p_surf' });
        var bands = pr.band && _arr(pr.band.p10) ? [{ x: pr.t, lo: pr.band.p10, hi: pr.band.p90, color: C.band }] : [];
        var v = [];
        (pr.flags || []).forEach(function (f) { if (f && f.code === 'TRIAGE_VACUUM' && _isNum(f.t)) v.push({ x: f.t, color: C.r, label: 'vacuum' }); });
        return { data: { series: s, bands: bands, vlines: v, xName: 't', yName: 'p' }, opts: { title: 'Bottomhole conversion', xLabel: 'Time, t (h)', yLabel: 'Pressure (psia)' } };
    };
    B.dfitGradient = function (run, T, ds) {
        var z = _num(T.inputs.datumTvd);
        if (!z) return { error: '⚠ Enter the datum TVD (step ①, DFIT well card) to plot gradients.' };
        if (!_hasData(ds)) return { error: 'No data loaded — load a DFIT on the Data step.' };
        var x = run && run.prep ? run.prep.t : ds.t, p = run && run.prep ? run.prep.pw : ds.p;
        var g = p.map(function (v) { return _isNum(v) ? v / z : null; });
        var h = [], s = T.summary || {};
        var cp = _closureP(s);
        if (_isNum(cp)) h.push({ y: cp / z, color: C.d1, label: 'closure ' + _f(cp / z, 3), fit: true });
        if (s.isip && _isNum(s.isip.value)) h.push({ y: s.isip.value / z, color: C.r, label: 'ISIP ' + _f(s.isip.value / z, 3), fit: true });
        if (s.pi && _isNum(s.pi.value)) h.push({ y: s.pi.value / z, color: C.d2, label: 'p_i ' + _f(s.pi.value / z, 3), fit: true });
        var ob = _num(T.inputs.rock && T.inputs.rock.sigmaVGrad);
        if (ob) h.push({ y: ob, color: C.ref, label: 'overburden ' + _f(ob, 2) });
        return { data: { series: [{ x: x, y: g, color: C.p, label: 'p_w / TVD' }], hlines: h, xName: 't', yName: 'gradient' },
                 opts: { title: 'Pressure gradient', xLabel: 'Time, t (h)', yLabel: 'Gradient (psi/ft)' } };
    };
    B.dfitStress = function (run, T) {
        var d = dstate(), s = [], m = [];
        d.tests.forEach(function (t) {
            var z = _num(t.inputs && t.inputs.datumTvd), sm = t.summary;
            if (!z || !sm) return;
            var c = sm.closure || {};
            if (c.mode === 'single' && _isNum(c.value)) m.push({ x: c.value / z, y: -z, color: C.d1, label: (t.zone || t.id) + ' closure' });
            if (c.mode === 'range' && _isNum(c.lo) && _isNum(c.hi)) s.push({ x: [c.lo / z, c.hi / z], y: [-z, -z], color: C.y, width: 6, label: (t.zone || t.id) + ' closure range' });
            if (sm.isip && _isNum(sm.isip.value)) m.push({ x: sm.isip.value / z, y: -z, color: C.r, hollow: true });
            if (sm.pi && _isNum(sm.pi.value)) m.push({ x: sm.pi.value / z, y: -z, color: C.d2, hollow: true });
        });
        if (!m.length && !s.length) return { error: 'Gradient vs depth needs analysed tests with a datum TVD.' };
        var zs = m.map(function (k) { return k.y; });
        s.forEach(function (k) { zs = zs.concat(k.y); });
        var zmin = Math.min.apply(null, zs), zmax = Math.max.apply(null, zs);
        s.push({ x: [0.433, 0.433], y: [zmin - 500, zmax + 500], color: C.ref, dash: [4, 4], label: 'hydrostatic 0.433' });
        var ob = _num(T.inputs.rock && T.inputs.rock.sigmaVGrad) || 1.0;
        s.push({ x: [ob, ob], y: [zmin - 500, zmax + 500], color: C.v, dash: [4, 4], label: 'overburden ' + _f(ob, 2) });
        return { data: { series: s, markers: m, xName: 'gradient', yName: 'depth' }, opts: { title: 'Gradients against depth', xLabel: 'Gradient (psi/ft)', yLabel: 'Depth (−TVD, ft)' } };
    };
    B.dfitOverlay = function () {
        var d = dstate(), cols = [C.p, C.d2, C.d1, C.v, C.y, C.q], s = [];
        d.tests.forEach(function (t, i) {
            var g = t.summary && t.summary.gdpdgN;
            if (g && _arr(g.x) && g.x.length > 1) s.push({ x: g.x, y: g.y, color: cols[i % cols.length], label: (t.zone || t.id) });
        });
        if (s.length < 1) return { error: 'The overlay needs at least one analysed test (two to compare).' };
        return { data: { series: s, xName: 'G/G_c', yName: 'normalised' }, opts: { title: 'G·dP/dG overlay (normalised)', xLabel: 'G / G_c', yLabel: 'G·dP/dG ÷ (m_G·G)' } };
    };
    B.dfitIsip = function (run) {
        var d = run.derivs, I = run.isip;
        if (!d || !_arr(d.G)) return { error: NEED_RUN };
        var n = d.G.length, x = [], y = [];
        for (var i = 0; i < n; i++) if (d.G[i] <= Math.max(2, (d.earlyWin && d.earlyWin[1]) || 2) * 1.5) { x.push(d.G[i]); y.push(d.p[i]); }
        var s = [{ x: x, y: y, color: C.p, dots: true, label: 'p' }];
        if (I && _isNum(I.value) && _isNum(d.mG)) s.push({ x: [0, x[x.length - 1] || 1], y: [I.value, I.value - d.mG * (x[x.length - 1] || 1)], color: C.d2, dash: [6, 3], label: 'early G line' });
        var h = [];
        (I && I.candidates || []).forEach(function (c) { if (_isNum(c.value)) h.push({ y: c.value, color: c.upper ? C.r : C.ref, dash: [2, 3], label: c.method + ' ' + _f(c.value, 0), fit: true }); });
        return { data: { series: s, hlines: h, xName: 'G', yName: 'p' }, opts: { title: 'Early falloff and ISIP', xLabel: 'G-function', yLabel: 'Pressure (psia)' } };
    };
    // Water hammer (§4.17, §7.3): run.hammer when the pipeline carries one, else WTS_wellbore.hammerQuick on the high-rate
    // shut-in window of prep.hf (resolved at call time). The view (seconds since shut-in, the window pressures and the fitted
    // midline + damped sinusoid) is cached on the run object, never stored. → {H, why, s:[], p:[], fit:[]|null} | null (no window)
    var HAMMER_1HZ = 'Water hammer not resolvable at 1 Hz: record ≥ 2.3 Hz at the wellhead through shut-in to use it.';
    function _hammerOf(run) {
        if (!run) return null;
        if (Object.prototype.hasOwnProperty.call(run, '_dfitHammerView')) return run._dfitHammerView;
        var ev = run.events, W = G.WTS_wellbore, T = test(), I = T.inputs, view = null;
        var wins = (run.prep && run.prep.hf && _arr(run.prep.hf.windows)) ? run.prep.hf.windows : [], win = null, i;
        for (i = 0; i < wins.length; i++) if (wins[i] && wins[i].kind === 'shutin' && _arr(wins[i].p) && _isNum(wins[i].t0) && wins[i].dtS > 0) { win = wins[i]; break; }
        if (win && ev && _isNum(ev.ts)) {
            var t = [], p = [];
            for (i = 0; i < win.p.length && i < HF_MAX; i++) if (_isNum(win.p[i])) { t.push(win.t0 + i * win.dtS / 3600); p.push(win.p[i]); }
            var H = (run.hammer && run.hammer.ok === true) ? run.hammer : null, why = null;
            if (!H && W && typeof W.hammerQuick === 'function' && !W.hammerQuick._dfitStub) {
                var col = { survey: I.survey, strings: I.strings, fluid: I.fluid, temp: I.temp, datumTvd: I.datumTvd, datumMd: I.datumMd };
                var r = null;
                try { r = W.hammerQuick(t, p, ev.ts, { column: col, fluid: I.fluid, qShut: ev.qLast, VwCw: ev.VwCwMeasured }); } catch (e) { r = null; }
                if (r && r.ok === true) H = r; else why = _txt((r && (r.why || (r.errors && r.errors[0]))) || 'The water-hammer fit did not run.');
            } else if (!H) why = 'The wellbore engine is needed for the water-hammer fit.';
            var sx = [], py = [], fit = null;
            for (i = 0; i < t.length; i++) { var si = (t[i] - ev.ts) * 3600; if (si >= 0 && si <= 60) { sx.push(si); py.push(p[i]); } }
            if (H && _isNum(H.T) && H.T > 0 && _isNum(H.tau) && H.tau > 0 && _isNum(H.A) && _isNum(H.isip) && sx.length > 3) {
                var osc = sx.map(function (x) { return H.A * Math.exp(-x / H.tau) * Math.cos(2 * Math.PI * x / H.T + (_isNum(H.phi) ? H.phi : 0)); });
                var sxx = 0, sxr = 0;   // midline isip − m·(s/60): m by least squares through the fitted intercept
                for (i = 0; i < sx.length; i++) { var xm = sx[i] / 60; sxx += xm * xm; sxr += xm * (H.isip - (py[i] - osc[i])); }
                var m = sxx > 0 ? sxr / sxx : 0;
                fit = sx.map(function (x, k) { return H.isip - m * x / 60 + osc[k]; });
            }
            view = { H: H, why: H ? null : why, s: sx, p: py, fit: fit };
        }
        try { Object.defineProperty(run, '_dfitHammerView', { value: view, enumerable: false, configurable: true, writable: true }); } catch (e) { /* frozen run */ }
        return view;
    }
    function _hammerHTML(run, big) {
        var v = _hammerOf(run);
        if (!v || !v.s.length) return _verdict('warn', HAMMER_1HZ);
        var H = v.H;
        if (!H) return _verdict('warn', 'High-rate window found, but ' + (v.why || 'the water hammer could not be fitted.').replace(/^Water hammer not resolvable: /, 'the water hammer is not resolvable: ')) + _chart('dfitHammer', big ? 240 : 220);
        var J = H.joukowsky || {}, md = _num(test().inputs.datumMd) || _num(test().inputs.datumTvd);
        var rows = [_rrow('Period T (s)', _f(H.T, 3)), _rrow('Regime', H.regime || '—'), _rrow('Damping τ (s)', _f(H.tau, 2)),
                    _rrow('Quarter-wave length c·T/4 (ft)', _f(H.Lquarter, 0)), _rrow('Perforation MD (ft)', _f(md, 0)), _rrow('Reflector', H.reflectorMatch || '—'),
                    _rrow('Joukowsky expected / measured (psi)', _f(J.expected, 0) + ' / ' + _f(J.measured, 0)), _rrow('Wave ISIP (psia)', _f(H.isip, 1)),
                    _rrow('V_w·c_w from the period (bbl/psi)', _isNum(H.VwCwHammer) ? _sig(H.VwCwHammer, 3) : '—'), _rrow('Hammer end (h after shut-in)', _isNum(H.tEnd) && run.events ? _f(H.tEnd - run.events.ts, 4) : '—')];
        if (big && H.sampling) rows.push(_rrow('Sampling (Hz; samples per 2L/c)', _f(H.sampling.hz, 1) + '; ' + _f(H.sampling.per2Lc, 1)));
        return _chart('dfitHammer', big ? 240 : 220) + _rbox('Water hammer', rows);
    }
    B.dfitHammer = function (run) {
        var v = _hammerOf(run);
        if (!v || !v.s.length) return { error: '⚠ ' + HAMMER_1HZ };
        var s = [{ x: v.s, y: v.p, color: C.p, label: 'p (high rate)' }];
        if (_arr(v.fit)) s.push({ x: v.s, y: v.fit, color: C.d2, dash: [5, 3], label: 'midline + damped sinusoid' });
        var h = (v.H && _isNum(v.H.isip)) ? [{ y: v.H.isip, color: C.r, dash: [2, 3], label: 'wave ISIP ' + _f(v.H.isip, 0) }] : [];
        return { data: { series: s, hlines: h, xName: 't', yName: 'p' }, opts: { title: 'Water hammer', xLabel: 'Time since shut-in (s)', yLabel: 'Pressure (psia)' } };
    };
    function _stepResult(kind, run) {
        var W = G.WTS_wellbore, ev = run && run.events;
        if (!ev || !_arr(ev.steps) || !ev.steps.length) return null;
        var dir = kind === 'down' ? 'down' : 'up';
        var steps = ev.steps.filter(function (s) { return s.dir === dir; });
        if (steps.length < 2) return null;
        if (run['_' + kind]) return run['_' + kind];
        var r = null;
        try {
            if (kind === 'down' && W && typeof W.stepDown === 'function') r = W.stepDown(steps.map(function (s) { return { q: s.q, p: s.pSettled, n: s.n, t: s.t1 }; }), { beta: 0.5 });
            if (kind === 'up' && W && typeof W.stepRate === 'function') r = W.stepRate(steps.map(function (s) { return { q: s.q, t0: s.t0, t1: s.t1 }; }), { stabFrac: 0.3, seed: 1 });
        } catch (e) { r = null; }
        try { Object.defineProperty(run, '_' + kind, { value: r, enumerable: false, configurable: true, writable: true }); } catch (e) { /* frozen */ }
        return { steps: steps, res: (r && r.ok) ? r : null };
    }
    B.dfitStepDown = function (run) {
        var sd = _stepResult('down', run);
        if (!sd) return { error: 'No step-down in this record (rate steps down before shut-in).' };
        var q = sd.steps.map(function (s) { return s.q; }), p = sd.steps.map(function (s) { return s.pSettled; });
        var s = [{ x: q, y: p, color: C.p, dots: true, r: 4, label: 'settled p' }];
        var r = sd.res;
        if (r && _isNum(r.pFrac)) {
            var qq = [], pp = [], qm = Math.max.apply(null, q);
            for (var i = 0; i <= 20; i++) { var x = qm * i / 20; qq.push(x); pp.push(r.pFrac + (r.a || 0) * x * x + (r.b || 0) * Math.pow(x, r.beta || 0.5)); }
            s.push({ x: qq, y: pp, color: C.d2, dash: [5, 3], label: 'fit' });
        }
        return { data: { series: s, xName: 'q', yName: 'p' }, opts: { title: 'Step-down', xLabel: 'Rate, q (bbl/min)', yLabel: 'Settled pressure (psia)' } };
    };
    B.dfitStepRate = function (run) {
        var sr = _stepResult('up', run);
        if (!sr) return { error: 'No step-rate sequence in this record (rate steps up before breakdown).' };
        var r = sr.res, pts = r && _arr(r.steps) ? r.steps : sr.steps.map(function (s) { return { q: s.q, pEnd: s.pSettled, stabilised: true }; });
        var stab = pts.filter(function (s) { return s.stabilised !== false; }), un = pts.filter(function (s) { return s.stabilised === false; });
        var s = [{ x: stab.map(function (s) { return s.q; }), y: stab.map(function (s) { return s.pEnd; }), color: C.p, dots: true, r: 4, label: 'end-of-step p' }];
        var m = un.map(function (u) { return { x: u.q, y: u.pEnd, color: C.p, hollow: true }; });
        var v = [];
        if (r && _isNum(r.qStar)) v.push({ x: r.qStar, color: C.r, label: 'FEP ' + _f(r.fep, 0) + ' psia' });
        return { data: { series: s, markers: m, vlines: v, xName: 'q', yName: 'p' }, opts: { title: 'Step-rate test', xLabel: 'Rate, q (bbl/min)', yLabel: 'End-of-step pressure (psia)' } };
    };
    B.dfitCycles = function (run, T, ds) {
        var ev = run.events;
        if (!ev || !_arr(ev.cycles) || !ev.cycles.some(function (c) { return c.rampWin; })) return { error: 'No re-pressurisation ramp (a later cycle, pump-in or LOT) in this record.' };
        if (!_hasData(ds) || !_arr(ds.q)) return { error: 'The cycles plot needs the rate channel.' };
        var s = [], cols = [C.p, C.d2, C.d1, C.v];
        ev.cycles.forEach(function (c, j) {
            if (!c.rampWin) return;
            var V = 0, x = [], y = [];
            for (var i = 1; i < ds.t.length; i++) {
                if (ds.t[i] < c.rampWin[0] || ds.t[i] > c.rampWin[1]) continue;
                V += (_isNum(ds.q[i]) ? ds.q[i] : 0) / 1440 * (ds.t[i] - ds.t[i - 1]) * 60;
                x.push(V); y.push(ds.p[i]);
            }
            s.push({ x: x, y: y, color: cols[j % cols.length], label: 'cycle ' + (j + 1) });
        });
        var h = _pickVlines(run, function (p) { return p; }).map(function (v) { return { y: v.x, color: v.color, label: v.label }; });
        // the knee (F4 reopening pick) and its band, a marker where each cycle crosses it, and the wellbore line V/(V_w·c_w)
        var hb = [], mk = [], knees = (_arr(run.picks) ? run.picks : []).filter(function (pk) { return pk && pk.method === 'reopening' && pk.ok !== false && _isNum(pk.p); });
        var uk = T && T.picks && T.picks.user ? T.picks.user.dfitRampKnee : null;
        if (uk && _isNum(uk.p)) knees.push({ p: uk.p, user: true, V: uk.V });
        var Vw = (_isNum(ev.VwCwMeasured) && ev.VwCwMeasured > 0) ? ev.VwCwMeasured : null;
        knees.forEach(function (k) {
            h.push({ y: k.p, color: k.user ? C.r : FAM_COLORS.F4 || C.v, dash: k.user ? [6, 2] : [4, 2], label: (k.user ? 'user knee ' : 'reopening ') + _f(k.p, 0) + (k.upperSide ? ' (upper side)' : '') });
            if (k.band && _isNum(k.band.p10) && _isNum(k.band.p90)) hb.push({ y0: k.band.p10, y1: k.band.p90, color: 'rgba(163,113,247,0.14)' });
            s.forEach(function (c) {
                if (/^wellbore/.test(c.label || '')) return;
                for (var i = 1; i < c.y.length; i++) if ((c.y[i - 1] - k.p) * (c.y[i] - k.p) <= 0 && c.y[i] !== c.y[i - 1]) {
                    var f = (k.p - c.y[i - 1]) / (c.y[i] - c.y[i - 1]);
                    mk.push({ x: c.x[i - 1] + f * (c.x[i] - c.x[i - 1]), y: k.p, color: c.color, hollow: !!k.user });
                    break;
                }
            });
        });
        if (Vw) s.slice().forEach(function (c, j) {
            if (!c.x.length || /^wellbore/.test(c.label || '')) return;
            var top = knees.length ? knees[0].p : Math.max.apply(null, _finiteVals(c.y)), p0 = c.y[0];
            if (!(top > p0)) return;
            s.push({ x: [c.x[0], c.x[0] + (top - p0) * Vw], y: [p0, top], color: C.ref, dash: [5, 4], label: j === 0 ? 'wellbore line (V_w·c_w ' + _sig(Vw, 3) + ' bbl/psi)' : '' });
        });
        return { data: { series: s, hlines: h, hbands: hb, markers: mk, xName: 'V', yName: 'p' }, opts: { title: 'Cycles and reopening', xLabel: 'Pumped volume (bbl)', yLabel: 'Pressure (psia)' } };
    };
    B.dfitInjNet = function (run, T, ds) {
        var ev = run.events, pc = _closureP(T.summary);
        if (T.inputs.channels && T.inputs.channels.primary === 'surface') return { error: 'Injection net pressure needs a bottomhole gauge.' };
        if (!ev || !_isNum(ev.tb) || !_isNum(ev.ts) || !_isNum(pc)) return { error: NEED_RUN };
        var x = [], y = [];
        for (var i = 0; i < ds.t.length; i++) if (ds.t[i] > ev.tb && ds.t[i] <= ev.ts && ds.p[i] - pc > 0) { x.push((ds.t[i] - ev.tb) * 60); y.push(ds.p[i] - pc); }
        if (x.length < 3) return { error: 'Too few pumping samples after breakdown.' };
        return { data: { series: [{ x: x, y: y, color: C.p, label: 'p_n,inj (indicative)' }], xKind: 'log', yKind: 'log', xName: 't − t_b', yName: 'p_n' },
                 opts: { title: 'Injection net pressure (indicative)', xLabel: 't − t_b (min)', yLabel: 'Net pressure (psi)' } };
    };
    B.dfitG = function (run, T) {
        var d = run.derivs;
        if (!d || !_arr(d.G)) return { error: NEED_RUN };
        var s = [{ x: d.G, y: d.p, color: C.p, dots: true, r: 1.8, label: 'p' }];
        var a1 = _derivAxis(d, 'GdPdG');
        s.push({ x: d.G, y: d.GdPdG, axis: 'R', color: C.d1, label: 'G·dP/dG' });
        s.push({ x: d.G, y: d.dPdG, axis: 'R', color: C.d2, label: 'dP/dG' });
        if (_isNum(d.mG)) {
            var gm = Math.max.apply(null, _finiteVals(d.G));
            s.push({ x: [0, gm], y: [0, d.mG * gm], axis: 'R', color: C.ref, dash: [6, 4], label: 'm_G·G' });
            if (run.isip && _isNum(run.isip.value)) s.push({ x: [0, gm], y: [run.isip.value, run.isip.value - d.mG * gm], color: C.ref, dash: [3, 3] });
        }
        var bands = [], c = _closureOf(run), v = _pickVlines(run, function (p) { return _gAtP(d, p); });
        var shade = [];
        if (c.mode === 'range' && _isNum(c.lo) && _isNum(c.hi)) { var g0 = _gAtP(d, c.hi), g1 = _gAtP(d, c.lo); if (_isNum(g0) && _isNum(g1)) shade.push({ x0: g0, x1: g1, color: 'rgba(210,153,34,0.12)' }); }
        return { data: { series: s, bands: bands, vlines: v, shade: shade, yR: _scaleR(a1 ? a1[0] : 0, a1 ? a1[1] : 1, 'G·dP/dG, dP/dG (psi)'), xName: 'G', yName: 'p' },
                 opts: { title: 'G-function plot', xLabel: 'G-function', yLabel: 'Pressure (psia)' } };
    };
    B.dfitSqrt = function (run) {
        var d = run.derivs;
        if (!d || !_arr(d.dt)) return { error: NEED_RUN };
        var x = d.dt.map(function (v) { return Math.sqrt(Math.max(0, v) * 60); });
        var a = _derivAxis(d, 'sdPds') || _rangeOf(d.sdPds);
        var s = [{ x: x, y: d.p, color: C.p, dots: true, r: 1.8, label: 'p' },
                 { x: x, y: d.sdPds, axis: 'R', color: C.d1, label: '√t·dP/d√t' }, { x: x, y: d.dPds, axis: 'R', color: C.d2, label: 'dP/d√t' }];
        var v = _pickVlines(run, function (p) { var dt = _interp(d.p, d.dt, p); return _isNum(dt) ? Math.sqrt(dt * 60) : null; });
        return { data: { series: s, vlines: v, yR: _scaleR(a ? a[0] : 0, a ? a[1] : 1, 'Derivatives (psi)'), xName: '√Δt', yName: 'p' },
                 opts: { title: 'Square-root-of-time plot', xLabel: '√Δt (min^½)', yLabel: 'Pressure (psia)' } };
    };
    B.dfitLogLog = function (run, T) {
        var d = run.derivs;
        if (!d || !_arr(d.dt)) return { error: NEED_RUN };
        var x = d.dt.map(function (v) { return v * 60; });
        var s = [{ x: x, y: d.dpIsip, color: C.p, dots: true, r: 1.8, label: 'ISIP − p' }, { x: x, y: d.D, color: C.d1, dots: true, r: 1.8, label: 'D (Bourdet)' }];
        if (_arr(d.Dref)) s.push({ x: x, y: d.Dref, color: C.ref, dash: [5, 4], label: 'D_ref (open fracture)' });
        if (T.inputs.options && T.inputs.options.ppd && _arr(d.ppd)) s.push({ x: x, y: d.ppd, color: C.v, dots: true, r: 1.5, label: 'dp/dΔt (PPD)' });
        var v = _pickVlines(run, function (p) { var dt = _interp(d.p, d.dt, p); return _isNum(dt) ? dt * 60 : null; });
        return { data: { series: s, vlines: v, xKind: 'log', yKind: 'log', xName: 'Δt', yName: 'Δp' }, opts: { title: 'Log-log diagnostic', xLabel: 'Δt (min)', yLabel: 'ISIP − p, D (psi)' } };
    };
    B.dfitCompliance = function (run) {
        var d = run.derivs;
        if (!d || !_arr(d.dPdG) || !_isNum(d.mG) || !(d.mG > 0)) return { error: NEED_RUN };
        var crel = d.dPdG.map(function (v) { return (_isNum(v) && v > 0) ? d.mG / v : null; });
        var v = _pickVlines(run, function (p) { return p; });
        return { data: { series: [{ x: d.p, y: crel, color: C.d2, dots: true, r: 1.8, label: 'C_rel' }], hlines: [{ y: 1, color: C.ref, label: 'open fracture' }], vlines: v, xName: 'p', yName: 'C_rel' },
                 opts: { title: 'Relative compliance', xLabel: 'Pressure (psia; falls with time)', yLabel: 'C_rel (–)' } };
    };
    B.dfitH = function (run) {
        var d = run.derivs;
        if (!d || !d.h || !_arr(d.h.h)) return { error: 'The h-function plot is not available until its definition is verified.' };
        return { data: { series: [{ x: d.h.h, y: d.p, color: C.p, dots: true, r: 1.8, label: 'p' }, { x: d.h.h, y: d.h.hdPdh, axis: 'R', color: C.d1, label: 'h·dP/dh' }],
                         yR: _scaleR.apply(null, (_rangeOf(d.h.hdPdh) || [0, 1]).concat(['h·dP/dh (psi)'])), xName: 'h', yName: 'p' },
                 opts: { title: 'h-function plot', xLabel: 'h-function', yLabel: 'Pressure (psia)' } };
    };
    B.dfitPdpdt = function (run) {
        var d = run.derivs;
        if (!d || !_arr(d.dt) || d.dt.length < 3) return { error: NEED_RUN };
        var x = [], y = [];
        for (var i = 1; i < d.dt.length - 1; i++) {
            var dd = d.dt[i + 1] - d.dt[i - 1];
            if (dd > 0 && _isNum(d.p[i + 1]) && _isNum(d.p[i - 1])) { x.push(Math.abs(d.p[i + 1] - d.p[i - 1]) / dd); y.push(d.p[i]); }
        }
        return { data: { series: [{ x: x, y: y, color: C.p, dots: true, r: 1.8, label: 'p' }], xName: '|dp/dt|', yName: 'p' }, opts: { title: 'p against |dp/dt|', xLabel: '|dp/dt| (psi/h)', yLabel: 'Pressure (psia)' } };
    };
    B.dfitStrip = function (run, T) {
        var picks = _arr(run.picks) ? run.picks : [];
        var cons = run.consensus || run.consensusLite || {};
        var fam = cons.families || {};
        var rows = ['F0', 'F1', 'F2', 'F3', 'F4'].map(function (k) {
            var b = fam[k] && _isNum(fam[k].p50) ? { p10: _num(fam[k].p10), p50: fam[k].p50, p90: _num(fam[k].p90) } : null;
            var mem = picks.filter(function (p) { return p.family === k; }).map(function (p) { return { p: p.p, method: p.method, vote: !!p.vote, vetoed: p.admissible === false }; });
            return { fam: k, label: '', band: b, members: mem };
        });
        var c = _closureOf(run);
        var fr = cons.frictional || null;
        return { data: { rows: rows, consensus: c, friction: fr ? { veto: _num(fr.veto), warn: _num(fr.warn) } : null, whatIf: _st()._dfitWhatIf ? _num(_st()._dfitWhatIf.p) : null },
                 opts: { title: 'Closure consensus strip' }, fn: 'PRiSM_plot_dfitStrip' };
    };
    B.dfitQL = function (run) {
        var f = _fn('PRiSM_dfit_leakoffRate'), r = null;
        if (f && run.derivs && run.frac && run.frac.chosen) { try { r = f(run.derivs, run.frac.chosen); } catch (e) { r = null; } }
        if (!r || !_arr(r.dt) || !r.dt.length) return { error: 'The leak-off rate needs a closure pick and the pre-closure engine.' };
        var x = r.dt.map(function (v) { return v * 60; });
        return { data: { series: [{ x: x, y: r.qL, color: C.p, label: 'q_L (bbl/min)' }], xKind: 'log', xName: 'Δt', yName: 'q_L' },
                 opts: { title: 'Leak-off rate', xLabel: 'Δt (min)', yLabel: 'q_L (bbl/min)' } };
    };
    function _aca(run) { return (run && run.aca && run.aca.ok !== false && run.aca.diag && _arr(run.aca.diag.x)) ? run.aca : null; }
    var NEED_ACA = 'After-closure analysis needs data after closure — run ▶ Analyse.';
    B.dfitAcaLogLog = function (run, T) {
        var A = _aca(run);
        if (!A) return { error: NEED_ACA };
        var D = A.diag, s = [{ x: D.x, y: D.D, color: C.d1, dots: true, r: 2, label: 'D' }];
        if (T.inputs.options && T.inputs.options.ppd) s.push({ x: D.x, y: D.x.map(function (x, i) { return (_isNum(D.D[i]) && x > 0) ? D.D[i] / x : null; }), color: C.v, dots: true, r: 1.5, label: 'PPD' });
        var bands = _arr(D.noiseD) ? [{ x: D.x, lo: D.x.map(function () { return 1e-9; }), hi: D.noiseD, color: 'rgba(139,148,158,0.15)' }] : [];
        var x0 = D.x[0], x1 = D.x[D.x.length - 1], y0 = null;
        for (var i = 0; i < D.D.length; i++) if (_isNum(D.D[i]) && D.D[i] > 0) { y0 = D.D[i]; break; }
        if (_isNum(y0) && x0 > 0) { s.push({ x: [x0, x1], y: [y0, y0 * Math.pow(x1 / x0, -0.5)], color: C.y, dash: [4, 4], label: 'slope −½' }); s.push({ x: [x0, x1], y: [y0, y0 * Math.pow(x1 / x0, -1)], color: C.r, dash: [4, 4], label: 'slope −1' }); }
        return { data: { series: s, bands: bands, shade: _winShade(run, 'dfitAcaLogLog'), xKind: 'log', yKind: 'log', xName: 't − t0', yName: 'D' }, opts: { title: 'After-closure log-log', xLabel: 't − t0 (h)', yLabel: 'D (psi)' } };
    };
    B.dfitFlowDim = function (run) {
        var A = _aca(run);
        if (!A || !_arr(A.diag.n)) return { error: NEED_ACA };
        var h = [1, 1.5, 2, 3].map(function (n) { return { y: n, color: C.ref, label: 'n = ' + n }; });
        return { data: { series: [{ x: A.diag.x, y: A.diag.n, color: C.d2, dots: true, r: 2, label: 'n(t)' }], hlines: h, xKind: 'log', yRange: { min: 0, max: 4 }, xName: 't − t0', yName: 'n' },
                 opts: { title: 'Flow dimension', xLabel: 't − t0 (h)', yLabel: 'Flow dimension n' } };
    };
    function _afterClosure(run) {
        var pr = run.prep, ev = run.events, A = _aca(run);
        if (!pr || !ev || !A) return null;
        var tc = _isNum(A.tcInj) ? A.tcInj : null, t0 = _isNum(ev.tStart) ? ev.tStart : 0;
        if (!tc) return null;
        var x = [], p = [];
        for (var i = 0; i < pr.t.length; i++) { var ti = pr.t[i] - t0; if (ti > tc * 1.0001 && _isNum(pr.pw[i])) { x.push(ti); p.push(pr.pw[i]); } }
        return x.length > 2 ? { tInj: x, p: p, tc: tc, t0A: _isNum(A.t0) ? A.t0 : 0 } : null;
    }
    B.dfitFL = function (run) {
        var a = _afterClosure(run);
        if (!a) return { error: NEED_ACA };
        var f = _fn('PRiSM_dfit_timeFns'), FL = null;
        if (f) { try { var r = f(a.tInj, a.tc, {}); if (r && _arr(r.FL)) FL = r.FL; } catch (e) { FL = null; } }
        if (!FL) FL = a.tInj.map(function (t) { return (2 / Math.PI) * Math.asin(Math.sqrt(Math.min(1, a.tc / t))); });
        var s = [{ x: FL, y: a.p, color: C.p, dots: true, r: 2, label: 'p' }];
        var L = run.aca.nolte && run.aca.nolte.lin;
        if (L && _isNum(L.pr) && _isNum(L.mL)) s.push({ x: [0, 1], y: [L.pr, L.pr + L.mL], color: C.d2, dash: [6, 3], label: 'linear line' });
        return { data: { series: s, shade: _winShade(run, 'dfitFL'), xRange: { min: 0, max: 1 }, xName: 'F_L', yName: 'p' }, opts: { title: 'After-closure linear (F_L)', xLabel: 'F_L', yLabel: 'Pressure (psia)' } };
    };
    var _frShading = false;   // _acaConv('dfitFR') rebuilds this plot: no recursion through the shading
    B.dfitFR = function (run) {
        var a = _afterClosure(run), f = _fn('PRiSM_dfit_timeFns'), FR = null;
        if (!a) return { error: NEED_ACA };
        if (f) { try { var r = f(a.tInj, a.tc, {}); if (r && _arr(r.FRc || r.FR)) FR = r.FRc || r.FR; } catch (e) { FR = null; } }
        if (!FR) return { error: 'The radial time function needs the after-closure engine.' };
        var s = [{ x: FR, y: a.p, color: C.p, dots: true, r: 2, label: 'p' }];
        var R = run.aca.nolte && run.aca.nolte.rad;
        if (R && _isNum(R.pr) && _isNum(R.mR)) { var xm = Math.max.apply(null, _finiteVals(FR)); s.push({ x: [0, xm], y: [R.pr, R.pr + R.mR * xm], color: C.d2, dash: [6, 3], label: 'radial line' }); }
        var out = { data: { series: s, xName: 'F_R', yName: 'p' }, opts: { title: 'After-closure radial (F_R)', xLabel: 'F_R', yLabel: 'Pressure (psia)' } };
        if (!_frShading) { _frShading = true; try { out.data.shade = _winShade(run, 'dfitFR'); } finally { _frShading = false; } }
        return out;
    };
    function _impulse(run, pow, title) {
        var a = _afterClosure(run);
        if (!a) return { error: NEED_ACA };
        var x = [], y = [];
        for (var i = 0; i < a.tInj.length; i++) { var dt = a.tInj[i] - a.t0A; if (dt > 0) { x.push(Math.pow(dt, -pow)); y.push(a.p[i]); } }
        var h = [];
        if (run.aca.pi && _isNum(run.aca.pi.value)) h.push({ y: run.aca.pi.value, color: C.d2, label: 'p_i ' + _f(run.aca.pi.value, 0), fit: true });
        return { data: { series: [{ x: x, y: y, color: C.p, dots: true, r: 2, label: 'p' }], hlines: h, shade: _winShade(run, pow === 0.5 ? 'dfitImpLin' : 'dfitImpRad'), xName: 'x', yName: 'p' },
                 opts: { title: title, xLabel: pow === 0.5 ? '(t − t0)^−½ (h^−½)' : '(t − t0)^−1 (1/h)', yLabel: 'Pressure (psia)' } };
    }
    B.dfitImpLin = function (run) { return _impulse(run, 0.5, 'Impulse linear'); };
    B.dfitImpRad = function (run) { return _impulse(run, 1, 'Impulse radial'); };
    B.dfitPiTraj = function (run) {
        var A = _aca(run);
        if (!A) return { error: NEED_ACA };
        var D = A.diag, s = [];
        if (_arr(D.piPoint)) s.push({ x: D.x, y: D.piPoint, color: C.p, dots: true, r: 2, label: 'p_i (point)' });
        var bands = (_arr(D.piLo) && _arr(D.piHi)) ? [{ x: D.x, lo: D.piLo, hi: D.piHi, color: C.band }] : [];
        if (!s.length) s.push({ x: D.x, y: D.piLo || [], color: C.d2, label: 'lower bracket' });
        var h = (A.pi && _isNum(A.pi.value)) ? [{ y: A.pi.value, color: C.d1, label: 'p_i ' + _f(A.pi.value, 0) + ' (' + (A.pi.label || '—') + ')', fit: true }] : [];
        return { data: { series: s, bands: bands, hlines: h, xKind: 'log', xName: 't − t0', yName: 'p_i' }, opts: { title: 'p_i trajectory and bracket', xLabel: 't − t0 (h)', yLabel: 'p_i (psia)' } };
    };
    B.dfitCrDeriv = function (run) {
        var f = _fn('PRiSM_dfit_crTransform'), a = _afterClosure(run);
        if (!f || !a) return { error: 'The constant-rate transform needs the after-closure engine.' };
        var r = null;
        try { r = f(a.tInj, a.p, { t0: a.t0A, V: run.aca.V, pi: run.aca.pi ? run.aca.pi.value : null }); } catch (e) { r = null; }
        if (!r || !_arr(r.t)) return { error: 'The constant-rate transform failed for these data.' };
        return { data: { series: [{ x: r.t, y: r.y, color: C.p, dots: true, r: 2, label: 't·(p − p_i)/(24V)' }], xKind: 'log', yKind: 'log', xName: 't', yName: 'y' },
                 opts: { title: 'Constant-rate equivalent derivative', xLabel: 't − t0 (h)', yLabel: 'psi per STB/d' } };
    };
    B.dfitLeakPlot = function (run) {
        var L = run.leak;
        if (!L || L.ok === false || !_arr(L.x)) return { error: 'The leak plot needs after-closure data and the leak check.' };
        return { data: { series: [{ x: L.x, y: L.y, color: C.p, dots: true, r: 2, label: L.form === 'radial' ? 'y_rad' : 'y_lin' }], xName: "t′", yName: 'y' },
                 opts: { title: 'Leak plot', xLabel: "t′", yLabel: L.form === 'radial' ? 'y_rad' : 'y_lin' } };
    };
    function _lk() { var r = _st()._dfitLk; return (r && r.ok && _arr(r.t)) ? r : null; }
    var NEED_LK = 'Run the leak-off model (step ④ → Leak-off model) to draw this plot.';
    B.dfitLkP = function (run, T, ds) {
        var r = _lk();
        if (!r) return { error: NEED_LK };
        var s = [{ x: r.t, y: r.pw, color: C.d2, label: 'model p_w' }];
        if (_hasData(ds) && run && run.events && _isNum(run.events.tStart)) s.unshift({ x: ds.t.map(function (t) { return t - run.events.tStart; }), y: ds.p, color: C.p, dots: true, r: 1.5, label: 'data' });
        return { data: { series: s, xName: 't', yName: 'p' }, opts: { title: 'Leak-off model: pressure', xLabel: 't since pump start (h)', yLabel: 'Pressure (psia)' } };
    };
    B.dfitLkQ = function () {
        var r = _lk();
        if (!r) return { error: NEED_LK };
        return { data: { x: r.t, layers: [{ label: 'in fracture V_f', y: r.Vf, color: 'rgba(88,166,255,0.55)' }, { label: 'leaked (Carter) V_Lc', y: r.VLc, color: 'rgba(63,185,80,0.55)' },
                                          { label: 'leaked (wall) V_Lw', y: r.VLw, color: 'rgba(210,153,34,0.55)' }, { label: 'spurt V_S', y: r.VS, color: 'rgba(188,140,255,0.55)' }] },
                 opts: { title: 'Volume partition', xLabel: 't since pump start (h)', yLabel: 'Volume (bbl)' }, fn: 'PRiSM_plot_dfitStack' };
    };
    B.dfitLkG = function () {
        var r = _lk();
        if (!r || !_arr(r.Ggen)) return { error: NEED_LK };
        return { data: { series: [{ x: r.Ggen, y: r.pw, color: C.d2, label: 'model p_w' }], xName: 'G', yName: 'p' }, opts: { title: 'Leak-off model on G', xLabel: 'G-function', yLabel: 'Pressure (psia)' } };
    };
    B.dfitLkGeom = function () {
        var r = _lk();
        if (!r) return { error: NEED_LK };
        var wm = 0; (r.W || []).forEach(function (v) { if (_isNum(v) && v > wm) wm = v; });
        return { data: { series: [{ x: r.t, y: r.L, color: C.p, label: 'half-length L (ft)' }, { x: r.t, y: r.W, axis: 'R', color: C.d2, label: 'w̄ (in)' }],
                         yR: _scaleR(0, (wm || 0.1) * 1.2, 'Average width (in)'), xName: 't', yName: 'L' }, opts: { title: 'Leak-off model geometry', xLabel: 't since pump start (h)', yLabel: 'Half-length (ft)' } };
    };
    B.dfitLkRes = function (run, T, ds) {
        var r = _lk(), f = _fn('PRiSM_dfit_lkSample');
        if (!r || !f || !_hasData(ds) || !run || !run.events) return { error: NEED_LK };
        var t0 = run.events.tStart || 0, tt = ds.t.map(function (t) { return t - t0; }), m = null;
        try { m = f(r, tt); } catch (e) { m = null; }
        if (!_arr(m)) return { error: NEED_LK };
        var res = ds.p.map(function (p, i) { return (_isNum(p) && _isNum(m[i]) && tt[i] >= 0) ? p - m[i] : null; });
        return { data: { series: [{ x: tt, y: res, color: C.p, dots: true, r: 1.5, label: 'data − model' }], hlines: [{ y: 0, color: C.ref }], xName: 't', yName: 'residual' },
                 opts: { title: 'Leak-off model residuals', xLabel: 't since pump start (h)', yLabel: 'Residual (psi)' } };
    };
    B.dfitPlan = function () {
        var pl = dstate().plan, c = pl && pl.corridor;
        if (!c || !_arr(c.t) || c.t.length < 2) return { error: 'Plan a DFIT in the designer (Tools → DFIT designer) to draw the corridor.' };
        return { data: { series: [{ x: c.t, y: c.p50, color: C.p, label: 'P50' }], bands: [{ x: c.t, lo: c.p10, hi: c.p90, color: C.band }], xKind: 'log', xName: 't', yName: 'p' },
                 opts: { title: 'Planned falloff corridor', xLabel: 'Shut-in time (h)', yLabel: 'Pressure (psia)' } };
    };

    // registry metadata: [key, label, x, y, step]
    var PLOTS = [
        ['dfitHistory', 'DFIT history (p, q, events)', 'lin', 'lin', 1], ['dfitConv', 'Bottomhole conversion', 'lin', 'lin', 1],
        ['dfitGradient', 'Pressure gradient', 'lin', 'lin', 1], ['dfitStress', 'Gradients against depth (tests)', 'lin', 'lin', 1],
        ['dfitOverlay', 'G·dP/dG overlay (tests)', 'lin', 'lin', 1], ['dfitIsip', 'Early falloff and ISIP', 'lin', 'lin', 2],
        ['dfitHammer', 'Water hammer', 'lin', 'lin', 2], ['dfitStepDown', 'Step-down', 'lin', 'lin', 2], ['dfitStepRate', 'Step-rate', 'lin', 'lin', 2],
        ['dfitCycles', 'Cycles and reopening', 'lin', 'lin', 2], ['dfitInjNet', 'Injection net pressure', 'log', 'log', 2],
        ['dfitG', 'G-function (p, G·dP/dG, dP/dG)', 'lin', 'lin', 3], ['dfitSqrt', 'Square-root of time', 'lin', 'lin', 3],
        ['dfitLogLog', 'Log-log (ISIP − p, D)', 'log', 'log', 3], ['dfitCompliance', 'Relative compliance', 'lin', 'lin', 3],
        ['dfitH', 'h-function', 'lin', 'lin', 3], ['dfitPdpdt', 'p against |dp/dt|', 'lin', 'lin', 3], ['dfitStrip', 'Closure strip', 'lin', 'lin', 3],
        ['dfitQL', 'Leak-off rate', 'log', 'lin', 3], ['dfitAcaLogLog', 'After-closure log-log', 'log', 'log', 4], ['dfitFlowDim', 'Flow dimension', 'log', 'lin', 4],
        ['dfitFL', 'After-closure F_L', 'lin', 'lin', 4], ['dfitFR', 'After-closure F_R', 'lin', 'lin', 4], ['dfitImpLin', 'Impulse linear', 'lin', 'lin', 4],
        ['dfitImpRad', 'Impulse radial', 'lin', 'lin', 4], ['dfitPiTraj', 'p_i trajectory', 'log', 'lin', 4], ['dfitCrDeriv', 'Constant-rate equivalent', 'log', 'log', 4],
        ['dfitLeakPlot', 'Leak plot', 'lin', 'lin', 4], ['dfitLkP', 'Leak-off model: pressure', 'lin', 'lin', 4], ['dfitLkQ', 'Leak-off model: volumes', 'lin', 'lin', 4],
        ['dfitLkG', 'Leak-off model: G', 'lin', 'lin', 4], ['dfitLkGeom', 'Leak-off model: geometry', 'lin', 'lin', 4], ['dfitLkRes', 'Leak-off model: residuals', 'lin', 'lin', 4],
        ['dfitPlan', 'Planned corridor', 'log', 'lin', 0]
    ];
    var STEP3_PLOTS = ['dfitG', 'dfitSqrt', 'dfitLogLog', 'dfitCompliance', 'dfitH', 'dfitPdpdt', 'dfitHistory', 'dfitGradient', 'dfitStrip'];
    function buildPlot(key, extra) {
        var b = B[key];
        if (!b) return { data: null, opts: {}, error: 'Unknown DFIT plot.' };
        var run = _run(), T = test(), ds = G.PRiSM_dataset;
        var needsRun = !(key === 'dfitHistory' || key === 'dfitConv' || key === 'dfitGradient' || key === 'dfitStress' || key === 'dfitOverlay' ||
                         key === 'dfitPlan' || key === 'dfitLkP' || key === 'dfitLkQ' || key === 'dfitLkG' || key === 'dfitLkGeom');
        if (needsRun && !run) return { data: null, opts: {}, error: _hasData(ds) ? NEED_RUN : 'Load a DFIT first (Data step), or load a demo DFIT.' };
        var r;
        try { r = b(run || {}, T, ds, extra || {}); } catch (e) { r = { error: 'Plot data failed: ' + _txt(e && e.message) }; }
        if (!r || r.error) return { data: null, opts: {}, error: _txt((r && r.error) || 'Nothing to plot.') };
        var o = r.opts || {};
        o.hoverEvent = true;
        return { data: r.data, opts: o, fn: r.fn || null, error: null };
    }
    function _entry(meta) {
        var key = meta[0];
        var e = { fn: 'PRiSM_plot_dfitDual', label: meta[1], mode: 'dfit', kind: 'dfit', axes: { x: meta[2], y: meta[3] }, dfitStep: meta[4] };
        if (key === 'dfitStrip') e.fn = 'PRiSM_plot_dfitStrip';
        if (key === 'dfitLkQ') e.fn = 'PRiSM_plot_dfitStack';
        e.build = function () { return buildPlot(key); };
        return e;
    }
    var PLOT_ENTRIES = {};
    PLOTS.forEach(function (m) { PLOT_ENTRIES[m[0]] = _entry(m); });
    // Draw any DFIT plot on any canvas: PRiSM_drawPlot (WPH: registry build + fn + _prismAxes + post-draw hooks) when present,
    // else the same steps here (02 runs the post-draw hooks on paint because opts.plotKey is set).
    function drawPlot(canvas, key, extra) {
        if (!canvas) return false;
        if (LINK_KEYS[key] && !(extra && _own(extra, 'hoverEvent'))) {
            var ex = {}; if (extra) for (var k0 in extra) if (_own(extra, k0)) ex[k0] = extra[k0];
            ex.hoverEvent = true; extra = ex;
        }
        if (typeof G.PRiSM_drawPlot === 'function' && G.PRiSM_PLOT_REGISTRY && G.PRiSM_PLOT_REGISTRY[key]) {
            try { var okH = G.PRiSM_drawPlot(canvas, key, extra || {}) !== false; if (okH) _attachOwner(canvas, key); return okH; } catch (e) { /* fall through */ }
        }
        var b = buildPlot(key, extra);
        if (!b.data) { _msgCanvas(canvas, b.error || 'Nothing to plot.'); return false; }
        var fname = b.fn || PLOT_ENTRIES[key].fn, f = G[fname];
        if (typeof f !== 'function') { _msgCanvas(canvas, 'Plot not available in this build.'); return false; }
        var o = { hover: true, dragZoom: true, showLegend: true, plotKey: key };
        for (var k in b.opts) if (_own(b.opts, k)) o[k] = b.opts[k];
        if (extra) for (var k2 in extra) if (_own(extra, k2)) o[k2] = extra[k2];
        try { f(canvas, b.data, o); } catch (e) { _msgCanvas(canvas, 'Render error: ' + _txt(e && e.message)); return false; }
        _attachOwner(canvas, key);
        return true;
    }

    // =========================================================================
    // SECTION 8 — PICKS HOOK ('dfit-picks'), LINE TOOLS (§2.7)
    // =========================================================================
    function _xOfPick(key, d, pk) {
        if (!d) return null;
        if (key === 'dfitG' || key === 'dfitIsip') return _isNum(pk.G) ? pk.G : _gAtP(d, pk.p);
        var dt = _isNum(pk.dt) ? pk.dt : _interp(d.p, d.dt, pk.p);
        if (!_isNum(dt)) return null;
        if (key === 'dfitSqrt') return Math.sqrt(dt * 60);
        if (key === 'dfitLogLog') return dt * 60;
        if (key === 'dfitCompliance' || key === 'dfitStrip') return pk.p;
        return null;
    }
    var PICK_PLOTS = { dfitG: 1, dfitSqrt: 1, dfitLogLog: 1, dfitCompliance: 1, dfitStrip: 1, dfitIsip: 1 };
    function picksHook(info) {
        if (!info || !info.canvas || !PICK_PLOTS[info.plotKey]) return;
        if (!info.exporting) _attachOwner(info.canvas, info.plotKey);
        var ax = info.canvas._prismAxes || info.axes;
        var run = _run();
        if (!ax || typeof ax.toX !== 'function' || !run) return;
        var ctx = info.canvas.getContext && info.canvas.getContext('2d');
        if (!ctx) return;
        var d = run.derivs, T = test(), plot = ax.plot || { x: 0, y: 0, w: 300, h: 150 };
        var marks = [];
        if (info.plotKey !== 'dfitStrip') (_arr(run.picks) ? run.picks : []).forEach(function (pk) {
            if (!pk || pk.ok === false || !_isNum(pk.p)) return;
            var x = _xOfPick(info.plotKey, d, pk);
            if (_isNum(x)) marks.push({ x: x, color: FAM_COLORS[pk.family] || '#8b949e', dash: pk.vote ? null : [2, 3], label: '', method: pk.method });
        });
        var U = T.picks.user || {};
        Object.keys(U).forEach(function (k) { var u = U[k]; if (!u) return; var x = _xOfPick(info.plotKey, d, u); if (_isNum(x)) marks.push({ x: x, color: '#ff7b72', dash: [6, 2], label: 'user ' + _f(u.p != null ? u.p : u.value, 0) }); });
        var cp = T.picks.closure;
        if (cp && cp.source === 'user' && _isNum(cp.p)) { var x3 = _xOfPick(info.plotKey, d, cp); if (_isNum(x3)) marks.push({ x: x3, color: '#ff7b72', dash: null, label: 'override ' + _f(cp.p, 0) }); }
        if (!marks.length) return;
        try {
            ctx.save();
            marks.forEach(function (m) { _vline(ctx, plot, ax.toX(m.x), m.color, m.dash, m.label); });
            ctx.restore();
        } catch (e) { /* cosmetic */ }
    }
    picksHook._prismId = 'dfit-picks';
    function _registerPicksHook() {
        var hooks = G.PRiSM_postDrawHooks = (G.PRiSM_postDrawHooks instanceof Array || _arr(G.PRiSM_postDrawHooks)) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === 'dfit-picks') { hooks[i] = picksHook; return; }
        hooks.push(picksHook);
    }
    // ── draggable handles through 02's pointer-owner hook (§2.7, §7.10): the closure marker on dfitG / dfitSqrt / dfitLogLog
    //    and the what-if marker on dfitStrip. Within 24 px of the marker the gesture is taken; a drag previews (redraw with the
    //    marker at the pointer) and the release commits ONE pick-log entry (closure) or the what-if (strip).
    //    Further handles (§7.2, §7.5): the event markers (pump start, breakdown, shut-in) on dfitHistory write T.inputs.events,
    //    and the after-closure window edges on dfitFL / dfitFR / dfitImpLin / dfitImpRad / dfitAcaLogLog write picks.aca
    //    (linWin / radWin on the injection clock, h). One release = one log entry, inside one undo batch.
    var DRAG_KEYS = { dfitG: 1, dfitSqrt: 1, dfitLogLog: 1, dfitStrip: 1, dfitHistory: 1, dfitFL: 1, dfitFR: 1, dfitImpLin: 1, dfitImpRad: 1, dfitAcaLogLog: 1 };
    var WIN_PLOTS = { dfitFL: ['lin'], dfitImpLin: ['lin'], dfitFR: ['rad'], dfitImpRad: ['rad'], dfitAcaLogLog: ['lin', 'rad'] };
    var EV_KEYS = [['tStart', 'pump start'], ['tb', 'breakdown'], ['ts', 'shut-in']];
    var HIT_PX = 24;
    function _localX(canvas, ev) {
        if (_isNum(ev.offsetX)) return ev.offsetX;
        var r = (canvas.getBoundingClientRect && canvas.getBoundingClientRect()) || { left: 0 };
        return (_isNum(ev.clientX) ? ev.clientX : 0) - (r.left || 0);
    }
    function _markerX(canvas, key) {
        var ax = canvas._prismAxes, run = _run();
        if (!ax || typeof ax.toX !== 'function' || !run) return null;
        if (key === 'dfitStrip') {
            var w = _st()._dfitWhatIf, c = _closureOf(run);
            var p = (w && _isNum(w.p)) ? w.p : (c.mode === 'single' ? c.value : (c.medians && c.medians[0]));
            return _isNum(p) ? ax.toX(p) : null;
        }
        var cp = test().picks.closure, pc = (cp && cp.source === 'user' && _isNum(cp.p)) ? cp.p : _closureP(test().summary);
        if (!_isNum(pc)) return null;
        var x = _xOfPick(key, run.derivs, { p: pc });
        return _isNum(x) ? ax.toX(x) : null;
    }
    // x on an after-closure plot <-> injection-clock time (h); null when the plot has no window axis
    function _acaConv(key, run) {
        var A = _aca(run);
        if (!A) return null;
        var t0 = _isNum(A.t0) ? A.t0 : 0, tc = _isNum(A.tcInj) ? A.tcInj : null;
        if (key === 'dfitAcaLogLog') return { toT: function (x) { return x > 0 ? t0 + x : null; }, fromT: function (t) { return t > t0 ? t - t0 : null; } };
        if (key === 'dfitImpLin') return { toT: function (x) { return x > 0 ? t0 + 1 / (x * x) : null; }, fromT: function (t) { return t > t0 ? 1 / Math.sqrt(t - t0) : null; } };
        if (key === 'dfitImpRad') return { toT: function (x) { return x > 0 ? t0 + 1 / x : null; }, fromT: function (t) { return t > t0 ? 1 / (t - t0) : null; } };
        if (key === 'dfitFL' && tc) return { toT: function (x) { var sn = Math.sin(Math.PI * Math.min(1, x) / 2); return (x > 0 && sn > 0) ? tc / (sn * sn) : null; },
                                            fromT: function (t) { return t >= tc ? (2 / Math.PI) * Math.asin(Math.sqrt(tc / t)) : null; } };
        if (key === 'dfitFR') {
            var b = B.dfitFR(run), a = _afterClosure(run);
            if (!b || !b.data || !a) return null;
            var X = b.data.series[0].x;
            return { toT: function (x) { var i = _nearestIdx(X, x); return i < 0 ? null : a.tInj[i]; }, fromT: function (t) { var i = _nearestIdx(a.tInj, t); return i < 0 ? null : X[i]; } };
        }
        return null;
    }
    function _acaWin(run, which) {
        var w = test().picks.aca && test().picks.aca[which + 'Win'];
        if (_arr(w) && _isNum(w[0]) && _isNum(w[1])) return w;
        var A = _aca(run), n = A && A.nolte && A.nolte[which];
        return (n && _arr(n.win) && _isNum(n.win[0]) && _isNum(n.win[1])) ? n.win : null;
    }
    function _winShade(run, key) {
        var cv = _acaConv(key, run), out = [];
        if (!cv) return out;
        (WIN_PLOTS[key] || []).forEach(function (which) {
            var w = _acaWin(run, which);
            if (!w) return;
            var a = cv.fromT(w[0]), b = cv.fromT(w[1]);
            if (_isNum(a) && _isNum(b)) out.push({ x0: a, x1: b, color: which === 'lin' ? 'rgba(63,185,80,0.12)' : 'rgba(88,166,255,0.12)' });
        });
        return out;
    }
    function _evTime(run, k) { var I = test().inputs.events; return _isNum(I[k]) ? I[k] : (run && run.events && _isNum(run.events[k]) ? run.events[k] : null); }
    // the draggable handles of a canvas: [{id, X (px)}]
    function _handles(canvas, key) {
        var ax = canvas._prismAxes, run = _run(), out = [];
        if (!ax || typeof ax.toX !== 'function' || !run) return out;
        if (key === 'dfitHistory') {
            EV_KEYS.forEach(function (e) { var t = _evTime(run, e[0]); if (_isNum(t)) out.push({ id: 'ev.' + e[0], X: ax.toX(t) }); });
            return out;
        }
        if (WIN_PLOTS[key]) {
            var cv = _acaConv(key, run);
            if (!cv) return out;
            WIN_PLOTS[key].forEach(function (which) {
                var w = _acaWin(run, which);
                if (!w) return;
                [0, 1].forEach(function (j) { var x = cv.fromT(w[j]); if (_isNum(x)) out.push({ id: which + j, X: ax.toX(x) }); });
            });
            return out;
        }
        var mx = _markerX(canvas, key);
        if (_isNum(mx)) out.push({ id: key === 'dfitStrip' ? 'whatif' : 'closure', X: mx });
        return out;
    }
    function _pickFromX(key, xData) {
        var run = _run(), d = run && run.derivs;
        if (!d) return null;
        if (key === 'dfitG') return _pickAtG(d, xData);
        if (key === 'dfitSqrt') return _pickAtDt(d, Math.pow(Math.max(0, xData), 2) / 60);
        if (key === 'dfitLogLog') return _pickAtDt(d, xData / 60);
        return null;
    }
    function _attachOwner(canvas, key) {
        if (!canvas || !DRAG_KEYS[key]) return;
        canvas._dfitPlotKey = key;
        if (canvas._prismPointerOwner && canvas._prismPointerOwner._dfit) return;
        var owner = function (ev) {
            var k = canvas._dfitPlotKey;
            if (!ev || !DRAG_KEYS[k]) return false;
            var x0 = _localX(canvas, ev), hs = _handles(canvas, k), best = null;
            hs.forEach(function (hd) { var dd = Math.abs(x0 - hd.X); if (_isNum(dd) && dd <= HIT_PX && (!best || dd < best.d)) best = { id: hd.id, d: dd }; });
            if (!best) return false;
            var drag = canvas._dfitDrag = { key: k, id: best.id, x: x0, moved: false };
            var move = function (e) { if (canvas._dfitDrag !== drag) return; drag.x = _localX(canvas, e); drag.moved = true; _previewDrag(canvas, drag); };
            var up = function (e) {
                canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel);
                if (canvas._dfitDrag !== drag) return;
                canvas._dfitDrag = null;
                if (e && e.type !== 'pointercancel') drag.x = _localX(canvas, e);
                _commitDrag(canvas, drag);
            };
            var cancel = function () { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel); canvas._dfitDrag = null; drawPlot(canvas, k); };
            drag.move = move; drag.up = up; drag.cancel = cancel;
            canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', cancel);
            return true;
        };
        owner._dfit = true;
        canvas._prismPointerOwner = owner;
    }
    function _dragLabel(canvas, drag) {
        var ax = canvas._prismAxes, xd = ax.fromX(drag.x);
        if (drag.id === 'whatif') return _f(xd, 0) + ' psia';
        if (/^ev\./.test(drag.id)) return _f(xd, 4) + ' h';
        if (/^(lin|rad)[01]$/.test(drag.id)) { var cv = _acaConv(drag.key, _run()), t = cv ? cv.toT(xd) : null; return _isNum(t) ? _f(t, 2) + ' h' : ''; }
        return _f((_pickFromX(drag.key, xd) || {}).p, 0);
    }
    function _previewDrag(canvas, drag) {
        var ax = canvas._prismAxes;
        if (!ax || typeof ax.fromX !== 'function') return;
        var lbl = _dragLabel(canvas, drag);
        var draw = function (ctx, a) { _vline(ctx, (a || ax).plot || ax.plot, drag.x, '#ff7b72', [6, 2], lbl); };
        if (typeof G.PRiSM_plot_overlay === 'function') { try { if (G.PRiSM_plot_overlay(canvas, draw)) return; } catch (e) { /* fall through */ } }
        drawPlot(canvas, drag.key);
        try { draw(canvas.getContext('2d'), ax); } catch (e) { /* cosmetic */ }
    }
    // one event override (typed or dragged): stored in T.inputs.events, logged, the fast pipeline re-runs
    function setEvent(k, value, reason) {
        var T = test();
        if (!/^(tStart|tb|ts)$/.test(String(k))) return { ok: false, code: 'BAD_ITEM', errors: ['Unknown event ' + _txt(k) + '.'], bad: ['event'] };
        var nv = (_isNum(value) && value >= 0 && value < 1e6) ? value : null, old = T.inputs.events[k];
        if (old === nv) return { ok: true, changed: false };
        _batch('begin');
        try {
            T.inputs.events[k] = nv;
            logEntry(T, 'events.' + k, old, nv, reason || 'Event override');
            if (T.summary) T.summary.stale = true;
            _emit('prism:dfit-updated', { what: 'events', source: 'user' });
            runFast('events');
        } finally { _batch('end'); }
        _refreshUI();
        return { ok: true, changed: true, value: nv };
    }
    function _commitDrag(canvas, drag) {
        var ax = canvas._prismAxes;
        if (!ax || typeof ax.fromX !== 'function') return null;
        var xd = ax.fromX(drag.x), run = _run();
        if (drag.id === 'whatif') {
            if (!_isNum(xd)) return null;
            _st()._dfitWhatIf = { p: xd };
            runFast('what-if');
            _refreshUI();
            return { whatIf: xd };
        }
        if (/^ev\./.test(drag.id)) {
            if (!_isNum(xd)) { drawPlot(canvas, drag.key); return null; }
            var lab = '';
            EV_KEYS.forEach(function (e) { if ('ev.' + e[0] === drag.id) lab = e[1]; });
            return setEvent(drag.id.slice(3), xd, 'The ' + lab + ' marker dragged on the history plot');
        }
        var wm = /^(lin|rad)([01])$/.exec(drag.id);
        if (wm) {
            var cv = _acaConv(drag.key, run), w = _acaWin(run, wm[1]), t = cv && _isNum(xd) ? cv.toT(xd) : null;
            if (!w || !_isNum(t)) { drawPlot(canvas, drag.key); return null; }
            var nw = [w[0], w[1]]; nw[+wm[2]] = t; nw.sort(function (a, b) { return a - b; });
            if (!(nw[1] > nw[0])) { drawPlot(canvas, drag.key); return null; }
            var pv = {}; pv[wm[1] + 'Win'] = nw;
            return setPick('aca', pv, { source: 'user', reason: (wm[1] === 'lin' ? 'Linear' : 'Radial') + ' window edge dragged on the ' + ((PLOT_ENTRIES[drag.key] || {}).label || 'plot') });
        }
        var pk = _pickFromX(drag.key, xd);
        if (!pk || !_isNum(pk.p)) { drawPlot(canvas, drag.key); return null; }
        return setPick('closure', { mode: 'user', family: null, method: 'user', p: pk.p, dt: pk.dt, G: pk.G }, { source: 'user', reason: 'Closure marker dragged on the ' + ((PLOT_ENTRIES[drag.key] || {}).label || 'plot') });
    }
    // nearest-index helpers on the derivative arrays
    function _nearestIdx(xs, x) { var best = -1, bd = Infinity; for (var i = 0; i < (xs ? xs.length : 0); i++) { var dd = Math.abs(xs[i] - x); if (_isNum(dd) && dd < bd) { bd = dd; best = i; } } return best; }
    function _tangentAt(d, Gc) {
        var i0 = _nearestIdx(d.G, Gc);
        if (i0 < 0) return null;
        var s = 0;
        for (var i = Math.max(0, i0 - 10); i <= Math.min(d.G.length - 1, i0 + 10); i++) if (d.G[i] > 0 && _isNum(d.GdPdG[i])) s = Math.max(s, d.GdPdG[i] / d.G[i]);
        if (!(s > 0)) return null;
        // from the click window on: the last G where G·dP/dG still lies within ε of the tangent s·G (left for three points in a row)
        var eps = (test().inputs.options.eps && test().inputs.options.eps.tangent) || 0.02, last = i0, off = 0;
        for (var j = Math.max(0, i0 - 10); j < d.G.length; j++) {
            if (!(d.G[j] > 0) || !_isNum(d.GdPdG[j])) continue;
            if (Math.abs(d.GdPdG[j] - s * d.G[j]) <= eps * s * d.G[j]) { last = j; off = 0; }
            else if (++off >= 3) break;
        }
        return { G: d.G[last], dt: d.dt[last], p: d.p[last], value: d.p[last], slope: s };
    }
    function _pickAtG(d, Gc) { var i = _nearestIdx(d.G, Gc); return i < 0 ? null : { G: d.G[i], dt: d.dt[i], p: d.p[i], value: d.p[i] }; }
    function _pickAtDt(d, dtH) { var i = _nearestIdx(d.dt, dtH); return i < 0 ? null : { G: d.G[i], dt: d.dt[i], p: d.p[i], value: d.p[i] }; }
    function _toolAction(key, fnPick) {
        return function (pts) {
            var run = _run();
            if (!run || !run.derivs) return { error: 'Run ▶ Analyse first: the DFIT tools work on the analysed falloff.' };
            var r = fnPick(run.derivs, pts, run);
            if (!r || !_isNum(r.p)) return { error: 'No pick near the click — click on the data.' };
            var res = setPick(key, r, { source: 'user', reason: 'Line tool on the plot' });
            if (!res.ok) return { error: res.errors[0] };
            return { values: { p: r.p, G: r.G }, note: 'DFIT pick ' + _f(r.p, 0) + ' psia stored (undo with Ctrl-Z).' };
        };
    }
    // after-closure window from two clicks: x of the plot → injection-clock time (h) → picks.aca.linWin / radWin
    function _winTool(which, pts, cx, defKey) {
        var run = _run();
        if (!run || !_aca(run)) return { error: 'Run ▶ Analyse first: the window tools work on the after-closure data.' };
        var key = (cx && cx.plotKey && WIN_PLOTS[cx.plotKey]) ? cx.plotKey : (((G.PRiSM_state || {}).activePlot && WIN_PLOTS[G.PRiSM_state.activePlot]) ? G.PRiSM_state.activePlot : defKey);
        var cv = _acaConv(key, run), a = cv ? cv.toT(pts[0].x) : null, b = cv ? cv.toT(pts[1].x) : null;
        if (!_isNum(a) || !_isNum(b) || a === b) return { error: 'Click two different points on the after-closure data.' };
        var pv = {}; pv[which + 'Win'] = [Math.min(a, b), Math.max(a, b)];
        var r = setPick('aca', pv, { source: 'user', reason: (which === 'lin' ? 'Linear' : 'Radial') + ' window drawn on the plot' });
        return r.ok ? { values: {}, note: (which === 'lin' ? 'Linear' : 'Radial') + ' window ' + _f(pv[which + 'Win'][0], 2) + '–' + _f(pv[which + 'Win'][1], 2) + ' h stored.' } : { error: r.errors[0] };
    }
    var LINE_TOOLS = {
        dfitIsipLine: { label: 'ISIP from the early G line', plot: 'dfitG', clicks: 2, prompts: ['Click the start of the early straight line', 'Click its end'],
            action: _toolAction('dfitIsipLine', function (d, pts) {
                var a = _pickAtG(d, pts[0].x), b = _pickAtG(d, pts[1].x);
                if (!a || !b || a.G === b.G) return null;
                var m = (b.p - a.p) / (b.G - a.G), isip = a.p - m * a.G;
                return { G: 0, dt: 0, p: isip, value: isip };
            }) },
        dfitTangent: { label: 'Tangent through the origin', plot: 'dfitG', clicks: 1, prompts: ['Click near where G·dP/dG leaves the tangent'],
            action: _toolAction('dfitTangent', function (d, pts) { return _tangentAt(d, pts[0].x); }) },
        dfitCompliance: { label: 'Compliance line and departure', plot: 'dfitG', clicks: 2, prompts: ['Click on the early G·dP/dG line', 'Click the departure'],
            action: _toolAction('dfitCompliance', function (d, pts) { return _pickAtG(d, pts[1].x); }) },
        dfitClosure: { label: 'User closure', plot: ['dfitG', 'dfitSqrt', 'dfitLogLog'], clicks: 1, prompts: ['Click the closure point'],
            action: _toolAction('dfitClosure', function (d, pts) {
                var pk = (G.PRiSM_state && G.PRiSM_state.activePlot) || 'dfitG';
                if (pk === 'dfitSqrt') return _pickAtDt(d, Math.pow(pts[0].x, 2) / 60);
                if (pk === 'dfitLogLog') return _pickAtDt(d, pts[0].x / 60);
                return _pickAtG(d, pts[0].x);
            }) },
        dfitSqrtInfl: { label: '√t inflection', plot: 'dfitSqrt', clicks: 1, prompts: ['Click the inflection'],
            action: _toolAction('dfitSqrtInfl', function (d, pts) { return _pickAtDt(d, Math.pow(pts[0].x, 2) / 60); }) },
        dfitAcaLinear: { label: 'After-closure linear window', plot: ['dfitFL', 'dfitImpLin'], clicks: 2, prompts: ['Click the window start', 'Click the window end'],
            action: function (pts, cx) { return _winTool('lin', pts, cx, 'dfitFL'); } },
        dfitAcaRadial: { label: 'After-closure radial window', plot: ['dfitFR', 'dfitImpRad'], clicks: 2, prompts: ['Click the window start', 'Click the window end'],
            action: function (pts, cx) { return _winTool('rad', pts, cx, 'dfitFR'); } },
        dfitPiLevel: { label: 'p_i level', plot: 'dfitPiTraj', clicks: 1, prompts: ['Click the p_i level'],
            action: function (pts) { var r = setPick('aca', { piLevel: pts[0].y }, { source: 'user', reason: 'p_i level picked on the trajectory' }); return r.ok ? { values: { pi: pts[0].y }, note: 'p_i level stored.' } : { error: r.errors[0] }; } },
        dfitRampKnee: { label: 'User reopening knee', plot: 'dfitCycles', clicks: 1, prompts: ['Click the knee'],
            action: function (pts) { var r = setPick('dfitRampKnee', { V: pts[0].x, p: pts[0].y, value: pts[0].y }, { source: 'user', reason: 'Reopening knee picked on the cycles plot' }); return r.ok ? { values: { p: pts[0].y }, note: 'Reopening pick stored.' } : { error: r.errors[0] }; } }
    };
    Object.keys(LINE_TOOLS).forEach(function (k) { LINE_TOOLS[k].group = 'DFIT'; LINE_TOOLS[k].store = false; LINE_TOOLS[k].hint = LINE_TOOLS[k].prompts[0]; });

    // =========================================================================
    // SECTION 9 — HTML HELPERS (capture classes: .card/.fg-item inputs, .rbox/.rrow results, table.dtable, .chart-wrap)
    // =========================================================================
    function _rrow(label, value) { return '<div class="rrow"><span class="rl">' + _esc(label) + '</span><span class="rv">' + _esc(value) + '</span></div>'; }
    function _rbox(title, rows, extra) { return '<div class="rbox"><div class="rbox-title">' + _esc(title) + '</div>' + rows.join('') + (extra || '') + '</div>'; }
    function _table(head, rows, id) {
        return '<div class="dtable-wrap"><table class="dtable"' + (id ? ' id="' + _esc(id) + '"' : '') + '><thead><tr>' + head.map(function (h) { return '<th>' + _esc(h) + '</th>'; }).join('') +
               '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + _esc(c == null ? '—' : c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    }
    function _verdict(level, text) {
        var sym = level === 'ok' ? '✓' : (level === 'bad' ? '✗' : '⚠');
        var t = _txt(text);
        if (t.charAt(0) !== sym) t = sym + ' ' + t;
        return '<div class="prism-dfit-verdict prism-dfit-verdict--' + (level || 'warn') + '">' + _esc(t.slice(0, 299)) + '</div>';
    }
    function _chart(key, h) {
        return '<div class="chart-wrap prism-dfit-chart"><canvas id="prism_dfit_cv_' + _esc(key) + '" data-dfit-plot="' + _esc(key) + '" style="width:100%;height:' + (h || 260) + 'px" role="img" aria-label="' + _esc((PLOT_ENTRIES[key] && PLOT_ENTRIES[key].label) || key) + '"></canvas></div>';
    }
    function _numInput(path, label) {
        var T = test(), v = _getPath(T.inputs, path), u = _unitOf(path);
        return '<div class="fg-item"><label for="' + _id(path) + '">' + _esc(label) + (u && u !== '–' ? ' (' + _esc(u) + ')' : '') + '</label>' +
               '<input type="text" inputmode="decimal" id="' + _id(path) + '" data-dfit-path="' + _esc(path) + '" value="' + _esc(_displayOf(path, v)) + '" autocomplete="off"></div>';
    }
    function _select(path, label) {
        var T = test(), v = String(_getPath(T.inputs, path));
        return '<div class="fg-item"><label for="' + _selId(path) + '">' + _esc(label) + '</label><select id="' + _selId(path) + '" data-dfit-path="' + _esc(path) + '">' +
               SELECTS[path].map(function (o) { return '<option value="' + _esc(o[0]) + '"' + (o[0] === v ? ' selected' : '') + '>' + _esc(o[1]) + '</option>'; }).join('') + '</select></div>';
    }
    function _check(path, id, label) {
        var on = !!_getPath(test().inputs, path);
        return '<label class="prism-dfit-check"><input type="checkbox" id="' + _esc(id) + '" data-dfit-path="' + _esc(path) + '"' + (on ? ' checked' : '') + '> ' + _esc(label) + '</label>';
    }
    function _fields(list) { return '<div class="fg">' + list.map(function (f) { return _numInput(f[0], f[1]); }).join('') + '</div>'; }
    function _btn(id, label, act, cls) { return '<button type="button" class="btn ' + (cls || 'btn-secondary') + '" id="' + _esc(id) + '" data-dfit-act="' + _esc(act) + '">' + _esc(label) + '</button>'; }
    function _note(text) { return '<div class="prism-dfit-note">' + _esc(_txt(text)) + '</div>'; }
    function _warnLine(id, text) { return '<div class="prism-dfit-warn" id="' + _esc(id) + '"' + (text ? '' : ' style="display:none"') + '>' + _esc(text ? '⚠ ' + _txt(text) : '') + '</div>'; }

    // input change handler shared by every DFIT container (delegated)
    function _onInputChange(e) {
        var t = e && e.target;
        if (!t || !t.getAttribute) return;
        var path = t.getAttribute('data-dfit-path');
        if (!path) return;
        var raw = (t.type === 'checkbox') ? !!t.checked : t.value;
        _batch('begin');
        var r = setInput(path, raw);
        _batch('end');
        if (t.type !== 'checkbox' && !SELECTS[path]) t.value = _displayOf(path, r.value);
        if (path === 'options.axisLock' && !r.value) _axisLock = null;
        var w = _byId('prism_dfit_input_warn');
        if (w) {
            if (r.warning && r.warning.text) { w.style.display = ''; w.textContent = '⚠ ' + _txt(r.warning.text); }
            else { w.style.display = 'none'; w.textContent = ''; }
        }
        if (path === 'options.ppd' || path === 'options.axisLock') redrawAll();
    }
    function _onMatchModel(e) {
        var t = e && e.target, k = t && t.getAttribute ? t.getAttribute('data-dfit-mm') : null;
        if (!k) return;
        var sel = _matchSel(), i = sel.indexOf(k);
        if (t.checked && i === -1) sel.push(k);
        if (!t.checked && i !== -1) sel.splice(i, 1);
    }
    function _wire(root) {
        if (!root || root._dfitWired) return;
        root._dfitWired = true;
        root.addEventListener('change', _onMatchModel);
        root.addEventListener('change', _onInputChange);
        root.addEventListener('click', _onAction);
    }

    // =========================================================================
    // SECTION 10 — ACTIONS (data-dfit-act buttons)
    // =========================================================================
    function _onAction(e) {
        var t = e && e.target, b = (t && t.closest) ? t.closest('[data-dfit-act]') : null;
        if (!b) return;
        var act = b.getAttribute('data-dfit-act'), arg = b.getAttribute('data-dfit-arg');
        var fn = ACTIONS[act];
        if (fn) { try { fn(arg, b); } catch (err) { _setStatus('⚠ ' + _txt(err && err.message), 'warn'); } }
    }
    function _need(cond, msg) { if (!cond) { _setStatus('⚠ ' + msg, 'warn'); _toast(msg); } return !!cond; }
    function _toast(msg) { var el = _byId('prism_dfit_msg'); if (el) { el.style.display = ''; el.textContent = '⚠ ' + _txt(msg); } }
    var ACTIONS = {
        analyse: function () { analyse(); },
        cancel: function () { if (!cancelAnalyse('Cancelled — previous results kept.')) _toast('Nothing is running.'); },
        demo: function () { var s = _byId('prism_dfit_demo'); var n = s ? s.value : 'reference'; if (loadDemo(n)) analyse(); },
        addTest: function () { var r = addTest({}); if (!r.ok) _toast(r.errors[0]); },
        openTest: function (id) { var r = selectTest(id); if (!r.ok) _toast(r.errors[0]); },
        deleteTest: function (id) {
            var ok = (typeof G.confirm === 'function') ? G.confirm('Delete DFIT test ' + id + '? (Undo restores it.)') : true;
            if (!ok) return;
            var r = deleteTest(id); if (!r.ok) _toast(r.errors[0]);
        },
        rebind: function () { var r = rebind(); if (!r.ok) _toast(r.errors[0]); else _refreshUI(); },
        zone: function () {
            var T = test(), z = (typeof G.prompt === 'function') ? G.prompt('Zone label for test ' + T.id, T.zone || '') : null;
            if (z == null) return;
            var old = T.zone; T.zone = _txt(z).slice(0, 40); logEntry(T, 'zone', old, T.zone, 'Zone renamed');
            _emit('prism:dfit-updated', { what: 'test', source: 'user' }); _refreshUI();
        },
        strAdd: function () {
            var T = test();
            if (!_need(T.inputs.strings.length < 10, 'A flow path holds at most 10 strings.')) return;
            var last = T.inputs.strings[T.inputs.strings.length - 1];
            var top = last ? last.botMd : 0, bot = _num(T.inputs.datumMd) || _num(T.inputs.datumTvd) || (top + 1000);
            if (!(bot > top)) bot = top + 1000;
            T.inputs.strings.push({ tubKey: null, id: 4.778, od: 5.5, wall: 0.361, topMd: top, botMd: bot });
            logEntry(T, 'inputs.strings', null, T.inputs.strings.length, 'String added');
            _emit('prism:dfit-updated', { what: 'test', source: 'user' }); _refreshUI();
        },
        strDel: function (i) {
            var T = test(); i = parseInt(i, 10);
            if (!(i >= 0 && i < T.inputs.strings.length)) return;
            T.inputs.strings.splice(i, 1); logEntry(T, 'inputs.strings', i, null, 'String removed');
            _emit('prism:dfit-updated', { what: 'test', source: 'user' }); _refreshUI();
        },
        survey: function () {
            var T = test(), box = _byId('prism_dfit_survey'), txt = box ? String(box.value || '') : '';
            var rows = [];
            txt.split(/\r?\n/).forEach(function (ln) { var a = ln.split(/[\s;\t]+/).map(_parse); if (a.length >= 2 && _isNum(a[0]) && _isNum(a[1])) rows.push([a[0], a[1]]); });
            if (!_need(rows.length > 0 || T.inputs.survey, 'Paste the survey first: one MD and TVD pair (ft) per line, ascending MD.')) return;
            var cl = _clampInputs((function () { var x = _clone(T.inputs); x.survey = rows.length ? rows : null; return x; })());
            _setStatus(cl.survey ? '✓ Survey applied: ' + cl.survey.length + ' stations.' : 'Survey cleared: the well is treated as vertical.', 'ok');
            T.inputs.survey = cl.survey;
            logEntry(T, 'inputs.survey', null, cl.survey ? cl.survey.length : 0, 'Survey pasted');
            _emit('prism:dfit-updated', { what: 'test', source: 'user' }); _refreshUI();
        },
        override: function () { openOverride(); },
        overrideSave: function () { _saveOverride(); },
        overrideClose: function () { _closeOverride(); },
        familyEnd: function (fam) {
            var run = _run(), c = run && run.consensus, f = c && c.families && c.families[fam];
            if (!_need(f && _isNum(f.p50), 'No ' + fam + ' family reading in this run.')) return;
            setPick('closure', { mode: 'family', family: fam, method: fam === 'F1' ? 'compliance' : 'tangent', p: f.p50, dt: null }, { source: 'user', reason: 'Use the ' + fam + ' end for hand-offs' });
        },
        clearOverride: function () { setPick('closure', null, { source: 'user', reason: 'Override removed' }); },
        why: function (method, btn) {
            var map = { tangent: 'dfitG', compliance: 'dfitG', crel: 'dfitCompliance', loglog: 'dfitLogLog', sqrt: 'dfitSqrt', maxdpdg: 'dfitG', varcomp: 'dfitG', fissure: 'dfitG', reopening: 'dfitCycles', model: 'dfitG', user: 'dfitG' };
            var st = _st(); st.activePlot = map[method] || 'dfitG';
            if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
            notes(method, btn);
        },
        note: function (key, btn) { notes(key, btn); },
        s4: function (tab) { _s4Tab = tab || 'aca'; var h = _byId('prism_dfit_step4'); if (h) _renderStep4Into(h); },
        whatIf: function () {
            var inp = _byId('prism_dfit_whatif_p'), p = inp ? _parse(inp.value) : NaN;
            if (!_need(_isNum(p) && p > 0 && p < 1e5, 'Enter a what-if closure pressure in psia.')) return;
            _st()._dfitWhatIf = { p: p };
            runFast('what-if'); _refreshUI();
        },
        whatIfClear: function () { delete _st()._dfitWhatIf; runFast('what-if'); _refreshUI(); },
        handoff: function (target) { applyHandoff(target || 'pta', {}); },
        handoffF: function (fam) { applyHandoff('pta', { family: fam }); },
        copyGrad: function () {
            var s = results(), g = _grad(_closureP(s), test());
            if (!_need(_isNum(g), 'No closure gradient yet.')) return;
            var txt = 'Closure gradient ' + _f(g, 3) + ' psi/ft (' + _f(g / 0.052, 2) + ' ppg equivalent)';
            try { if (G.navigator && G.navigator.clipboard && G.navigator.clipboard.writeText) G.navigator.clipboard.writeText(txt); } catch (e) { /* ignore */ }
            _setStatus('Copied: ' + txt, 'ok');
        },
        copyIsipGrad: function () {
            var s = results(), T = test(), run = _run();
            var p = (s && s.isip && _isNum(s.isip.value)) ? s.isip.value : (run && run.isip ? run.isip.value : null), g = _grad(p, T);
            if (!_need(_isNum(g), _isNum(p) ? 'Enter the datum TVD (step ①) for the ISIP gradient.' : 'No ISIP yet — press ▶ Analyse.')) return;
            var txt = 'ISIP gradient ' + _f(g, 3) + ' psi/ft (' + _f(g / 0.052, 2) + ' ppg equivalent)';
            try { if (G.navigator && G.navigator.clipboard && G.navigator.clipboard.writeText) G.navigator.clipboard.writeText(txt); } catch (e) { /* ignore */ }
            _setStatus('Copied: ' + txt, 'ok');
        },
        exportText: function () { _exportText(); },
        exportSheet: function () { _exportSheet(); },
        lkSim: function () { _lkSimulate(); },
        lkFit: function () { _lkFit(); },
        lkStruct: function () { _lkFit({ structural: true }); },
        acaMatch: function () { _acaMatch(); },
        lkCancel: function () { if (_lkJob) { _lkJob.cancelled = true; _setStatus('Cancelled — previous model kept.', 'warn'); } else _toast('Nothing is running.'); },
        design: function () { _design(); },
        replay: function () { _replay(); },
        sandbox: function () { openSandbox(); },
        plan: function () { if (typeof G.PRiSM_openTools === 'function') { try { G.PRiSM_openTools('dfit-designer'); return; } catch (e) { /* ignore */ } } _toast('Open Tools → DFIT designer.'); },
        gauge: function () { _toast('Build the analysis set from gauge records in the Data step (gauge manager), then press ▶ Analyse.'); }
    };

    // =========================================================================
    // SECTION 11 — PANELS (C7, §2.8)
    // =========================================================================
    function _panelHost(body, id) {
        body.innerHTML = '<div id="prism_dfit_panel_' + id + '" class="prism-dfit-panel"></div>';
        var h = body.firstChild || _byId('prism_dfit_panel_' + id);
        _wire(h);
        return h;
    }
    function _staleLine(T) {
        var s = T.summary;
        if (s && s.forOtherDataset) return _verdict('warn', 'Decisions belong to another dataset: load it, or re-bind this test to the loaded data.') + _btn('prism_dfit_rebind', 'Re-bind to the loaded data', 'rebind');
        if (s && s.stale) return _verdict('warn', 'Results stale — press ▶ Analyse.');
        return '';
    }
    var PANEL_RENDER = {};
    PANEL_RENDER.tests = function (h) {
        var d = dstate(), T = test(), ds = G.PRiSM_dataset;
        var html = '<div class="prism-dfit-bar">' + _btn('prism_dfit_analyse', '▶ Analyse DFIT', 'analyse', 'btn-primary') + _btn('prism_dfit_cancel', 'Cancel', 'cancel') +
                   '<span id="prism_dfit_progress" class="prism-dfit-progress" style="display:none"></span>' +
                   '<span id="prism_dfit_status" class="prism-dfit-status prism-dfit-status--' + _status.level + '">' + _esc(_status.text) + '</span></div>' +
                   '<div id="prism_dfit_msg" class="prism-dfit-warn" style="display:none"></div>';
        if (!_hasData(ds)) {
            html += '<div class="card"><div class="card-title">Start a DFIT</div>' +
                    _note('Load a DFIT record on the Data step (time, pressure, rate in bbl/min; surface pressure and temperature optional), or start from a demo.') +
                    '<div class="fg"><div class="fg-item"><label for="prism_dfit_demo">Demo DFIT</label><select id="prism_dfit_demo">' +
                    DEMOS.map(function (x) { return '<option value="' + x[0] + '">' + _esc(x[1]) + '</option>'; }).join('') + '</select></div></div>' +
                    '<div class="prism-dfit-bar">' + _btn('prism_dfit_demo_btn', 'Load demo DFIT', 'demo', 'btn-primary') + _btn('prism_dfit_gauge_btn', 'Build from gauge records', 'gauge') +
                    _btn('prism_dfit_plan_btn', 'Plan a DFIT', 'plan') + _btn('prism_dfit_sandbox_btn', 'Leak-off sandbox', 'sandbox') + '</div></div>';
        } else {
            html += '<div class="fg"><div class="fg-item"><label for="prism_dfit_demo">Demo DFIT</label><select id="prism_dfit_demo">' +
                    DEMOS.map(function (x) { return '<option value="' + x[0] + '">' + _esc(x[1]) + '</option>'; }).join('') + '</select></div></div>' +
                    '<div class="prism-dfit-bar">' + _btn('prism_dfit_demo_btn', 'Load demo DFIT', 'demo') + '</div>';
        }
        html += _staleLine(T);
        var rows = d.tests.map(function (t) {
            var s = t.summary, c = s && s.closure, z = _num(t.inputs.datumTvd);
            var cg = (c && c.mode === 'range' && c.families) ? [c.families.F1, c.families.F2].filter(function (x) { return x && _isNum(x.p50); }).map(function (x) { return z ? _f(x.p50 / z, 3) : '—'; }).join(' / ') : (z ? _f((_closureP(s) || NaN) / z, 3) : '—');
            var status = !t.dsRef ? 'no data' : (_hasData(ds) && t.dsRef.hash === dsHash(ds) ? 'loaded' : 'other data');
            return [t.id + (t.id === d.active ? ' (active)' : ''), t.zone || '—', z ? _f(z, 0) : '—', (t.dsRef ? t.dsRef.name : '—') + ' · ' + status,
                    s && s.isip && z ? _f(s.isip.value / z, 3) : '—', cg || '—', s && s.pi && z && _isNum(s.pi.value) ? _f(s.pi.value / z, 3) : '—', (s && s.grade) || '—'];
        });
        html += _table(['Test', 'Zone', 'Datum TVD (ft)', 'Dataset', 'ISIP (psi/ft)', 'Closure (psi/ft)', 'p_i (psi/ft)', 'Grade'], rows, 'prism_dfit_tests_tbl');
        html += '<div class="prism-dfit-bar">' + _btn('prism_dfit_test_add', '+ Add test', 'addTest') + _btn('prism_dfit_zone', 'Rename zone', 'zone') +
                d.tests.filter(function (t) { return t.id !== d.active; }).map(function (t) { return _btn('prism_dfit_open_' + t.id, 'Open ' + t.id, 'openTest').replace('data-dfit-act="openTest"', 'data-dfit-act="openTest" data-dfit-arg="' + t.id + '"'); }).join('') +
                (d.tests.length > 1 ? _btn('prism_dfit_del_' + T.id, 'Delete ' + T.id, 'deleteTest').replace('data-dfit-act="deleteTest"', 'data-dfit-act="deleteTest" data-dfit-arg="' + T.id + '"') : '') + '</div>';
        if (d.tests.length >= 2) html += _chart('dfitStress', 240) + _chart('dfitOverlay', 240);
        h.innerHTML = html;
    };
    PANEL_RENDER.well = function (h) {
        var T = test(), I = T.inputs, w = _well(), run = _run();
        var TB = G.WTS_tubulars, list = [];
        if (TB && typeof TB.all === 'function') { try { list = TB.all() || []; } catch (e) { list = []; } }
        var tubOpts = function (sel) {
            var o = '<option value=""' + (sel ? '' : ' selected') + '>custom</option>';
            for (var i = 0; i < list.length && i < 300; i++) { var x = list[i]; if (x && x.key) o += '<option value="' + _esc(x.key) + '"' + (x.key === sel ? ' selected' : '') + '>' + _esc(x.label || x.key) + '</option>'; }
            return o;
        };
        var cell = function (i, f, v, dp) { return '<input type="text" inputmode="decimal" id="prism_dfit_str_' + i + '_' + f + '" data-dfit-str="' + i + ':' + f + '" value="' + _esc(_isNum(v) ? String(Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp)) : '') + '" aria-label="String ' + (i + 1) + ' ' + f + '">'; };
        var strRows = I.strings.map(function (s, i) { return i; });
        var strHTML = strRows.length ? '<div class="dtable-wrap"><table class="dtable" id="prism_dfit_strings_tbl"><thead><tr><th>#</th><th>Tubular</th><th>ID (in)</th><th>OD (in)</th><th>Top MD (ft)</th><th>Bottom MD (ft)</th></tr></thead><tbody>' +
            I.strings.map(function (s, i) {
                return '<tr><td>' + (i + 1) + '</td><td><select id="prism_dfit_str_' + i + '_key" data-dfit-str="' + i + ':key" aria-label="String ' + (i + 1) + ' tubular">' + tubOpts(s.tubKey) + '</select></td><td>' +
                       cell(i, 'id', s.id, 3) + '</td><td>' + cell(i, 'od', s.od, 3) + '</td><td>' + cell(i, 'top', s.topMd, 0) + '</td><td>' + cell(i, 'bot', s.botMd, 0) + '</td></tr>';
            }).join('') + '</tbody></table></div>' : '';
        var html = '<div class="card"><div class="card-title">Datum and gauge</div>' + _fields(FIELDS.well) +
                   (!_num(I.datumTvd) ? _verdict('warn', 'Enter the datum TVD: gradients and the bottomhole conversion are disabled without it.') : '') +
                   '<div class="fg"><div class="fg-item"><label for="prism_dfit_survey">Survey (MD TVD per line, ft)</label><textarea id="prism_dfit_survey" rows="3">' +
                   _esc((I.survey || []).map(function (r) { return r[0] + ' ' + r[1]; }).join('\n')) + '</textarea></div></div>' +
                   '<div class="prism-dfit-bar">' + _btn('prism_dfit_survey_apply', 'Apply survey', 'survey') + '</div></div>';
        html += '<div class="card"><div class="card-title">Flow path (strings, top → perforations)</div>' +
                (strRows.length ? strHTML : _note('No strings: the conversion uses a constant gradient and no pipe friction.')) +
                '<div class="prism-dfit-bar">' + _btn('prism_dfit_str_add', '+ String', 'strAdd') +
                (strRows.length ? _btn('prism_dfit_str_del', '− Last string', 'strDel').replace('data-dfit-act="strDel"', 'data-dfit-act="strDel" data-dfit-arg="' + (strRows.length - 1) + '"') : '') + '</div></div>';
        html += '<div class="card"><div class="card-title">Injected fluid and temperature</div><div class="fg">' + _select('fluid.kind', 'Fluid') + _select('temp.model', 'Temperature model') + '</div>' +
                _fields(FIELDS.fluid) + _fields(FIELDS.temp) + '</div>';
        html += '<div class="card"><div class="card-title">Perforations and rock</div>' + _fields(FIELDS.perfs) + '<div class="fg">' + _select('rock.EpSource', 'E′ source') + '</div>' + _fields(FIELDS.rock) + _fields(FIELDS.priors) + '</div>';
        var ev = run && run.events, fr = run && run.frac && run.frac.chosen;
        html += _rbox('System compressibility and wellbore storage', [
            _rrow('V_w·c_w from the ramp (bbl/psi)', ev ? _sig(ev.VwCwMeasured, 3) : '—'),
            _rrow('V_w·c_w used (bbl/psi)', fr ? _sig(fr.VwCw, 3) : '—'),
            _rrow('C_sys (bbl/psi)', fr ? _sig(fr.Csys, 3) : '—')]);
        var prov = (G.PRiSM_pvt && G.PRiSM_pvt.provenance) || {};
        var pv = function (k) { return prov[k] ? ' [' + prov[k] + ']' : ''; };
        html += _rbox('Reservoir (PRiSM well inputs, C1)', [
            _rrow('p_i (psia)' + pv('pi'), _f(w.pi, 0)), _rrow('φ' + pv('phi'), _f(w.phi, 3)), _rrow('c_t (1/psi)' + pv('ct'), _sig(w.ct, 3)),
            _rrow('μ_res (cp)' + pv('mu'), _f(w.mu, 3)), _rrow('h (ft)' + pv('h'), _f(w.h, 1)), _rrow('Test type', w.testType || '—')],
            _note('Edit the reservoir inputs in Well & Test (transient mode); DFIT reads them through PRiSM_getWell and writes only the test type, shut-in time, tp and pwf0.'));
        html += '<div class="card"><div class="card-title">Events and time base</div><div class="fg">' + _select('options.tp', 'Producing time tp') + _select('options.alpha', 'Leak-off exponent α') + '</div>' +
                _fields([['options.L', 'Bourdet window L'], ['options.alphaGeneral', 'General α']]) +
                _table(['Event', 'Detected (h)', 'Override (h)'], [
                    ['Pump start', ev ? _f(ev.tStart, 4) : '—', _f(I.events.tStart, 4)], ['Breakdown', ev ? _f(ev.tb, 4) : '—', _f(I.events.tb, 4)],
                    ['Shut-in', ev ? _f(ev.ts, 4) : '—', _f(I.events.ts, 4)]], 'prism_dfit_events_tbl') +
                '<div class="fg">' + ['tStart', 'tb', 'ts'].map(function (k) {
                    var id = 'prism_dfit_ev_' + k.toLowerCase();
                    return '<div class="fg-item"><label for="' + id + '">Override ' + (k === 'tStart' ? 'pump start' : (k === 'tb' ? 'breakdown' : 'shut-in')) + ' (h)</label><input type="text" inputmode="decimal" id="' + id + '" data-dfit-ev="' + k + '" value="' + _esc(_isNum(I.events[k]) ? I.events[k] : '') + '"></div>';
                }).join('') + '</div>' +
                (ev && ev.tp ? _note('tp: pump ' + _f(ev.tp.pump * 60, 2) + ' min, from breakdown ' + _f(ev.tp.breakdown * 60, 2) + ' min, volume-equivalent ' + _f(ev.tp.veq * 60, 2) + ' min.') : '') + '</div>';
        html += _warnLine('prism_dfit_input_warn', '');
        h.innerHTML = html;
        Array.prototype.forEach.call(h.querySelectorAll ? h.querySelectorAll('[data-dfit-str]') : [], function (inp) {
            inp.addEventListener('change', function () {
                var a = String(inp.getAttribute('data-dfit-str')).split(':'), i = parseInt(a[0], 10), f = a[1], T2 = test(), row = T2.inputs.strings[i];
                if (!row) return;
                var next = _clone(row);
                if (f === 'key') {
                    var e = (TB && typeof TB.find === 'function') ? TB.find(inp.value) : null;
                    next.tubKey = e ? e.key : null;
                    if (e) { next.id = e.id; next.od = e.od; next.wall = e.wall; }
                } else {
                    var v = _parse(inp.value), k = { id: 'id', od: 'od', top: 'topMd', bot: 'botMd' }[f];
                    if (_isNum(v)) next[k] = v;
                    if (f === 'id' || f === 'od') { next.tubKey = null; next.wall = (next.od - next.id) / 2; }
                }
                var trial = _clone(T2.inputs);
                trial.strings[i] = next;
                var cl = _clampInputs(trial);
                var ok = cl.strings.length === trial.strings.length;
                _batch('begin');
                if (ok) { T2.inputs.strings = cl.strings; logEntry(T2, 'inputs.strings[' + i + '].' + f, null, inp.value, 'String edited'); if (T2.summary) T2.summary.stale = true; _emit('prism:dfit-updated', { what: 'test', source: 'user' }); }
                _batch('end');
                var w = _byId('prism_dfit_input_warn');
                if (w) { w.style.display = ok ? 'none' : ''; w.textContent = ok ? '' : '⚠ String ' + (i + 1) + ' needs ID < OD and top MD < bottom MD: the change was not applied.'; }
                PANEL_RENDER.well(h);
            });
        });
        var evs = h.querySelectorAll ? h.querySelectorAll('[data-dfit-ev]') : [];
        Array.prototype.forEach.call(evs, function (inp) {
            inp.addEventListener('change', function () {
                var k = inp.getAttribute('data-dfit-ev'), v = _parse(inp.value);
                var r = setEvent(k, v, 'Event override typed');
                var el = _byId(inp.id) || inp;
                if (r.ok) el.value = _isNum(test().inputs.events[k]) ? String(test().inputs.events[k]) : '';
            });
        });
    };
    PANEL_RENDER.channels = function (h) {
        var T = test(), I = T.inputs, ds = G.PRiSM_dataset, run = _run();
        var conv = (ds && ds.meta && ds.meta.psigConverted) || {};
        var html = '<div class="card"><div class="card-title">Channels</div><div class="fg">' + _select('channels.primary', 'Primary channel') + '</div>' +
                   '<div class="prism-dfit-checks">' +
                   ['p', 'pSurf', 'pAnn'].map(function (k) {
                       return _check('channels.psig.' + k, 'prism_dfit_psig_' + k.toLowerCase(), (k === 'p' ? 'Primary' : (k === 'pSurf' ? 'Surface' : 'Annulus')) + ' recorded in psig' + (conv[k] ? ' (already converted on import)' : ''));
                   }).join('') + '</div>' + _fields(FIELDS.channels) +
                   (I.channels.mask && I.channels.mask.length ? _table(['Mask from (h)', 'to (h)', 'Why'], I.channels.mask.map(function (m) { return [_f(m[0], 3), _f(m[1], 3), m[2] || '—']; })) : _note('No masked intervals.')) + '</div>';
        var pr = run && run.prep;
        html += _rbox('Bottomhole conversion', [
            _rrow('Source', pr ? (pr.src === 'surface-converted' ? 'surface, converted' : 'bottomhole gauge') : '—'),
            _rrow('Gauge noise σ (psi)', pr ? _sig(pr.sigma, 3) : '—'),
            _rrow('Atmospheric correction applied (psi)', pr && pr.applied ? _f(pr.applied.atmDelta, 3) : '—'),
            _rrow('Masked samples', pr && pr.applied ? _f(pr.applied.masked, 0) : '—')]);
        (pr && pr.flags || []).slice(0, 6).forEach(function (f) { if (f && f.text) html += _verdict(f.level === 'bad' ? 'bad' : (f.level === 'info' ? 'ok' : 'warn'), f.text); });
        html += _chart('dfitConv', 240) + _chart('dfitHistory', 260);
        if (!_hasData(ds)) html = _note('Load a DFIT first.') + html;
        h.innerHTML = html;
    };
    PANEL_RENDER.triage = function (h) {
        var run = _run(), tr = run && run.triage;
        var html = '';
        if (!tr || tr.ok === false) html += _note(_hasData(G.PRiSM_dataset) ? 'Press ▶ Analyse to run the data-health checks.' : 'Load a DFIT first.');
        else {
            var lvl = tr.light === 'green' ? 'ok' : (tr.light === 'red' ? 'bad' : 'warn');
            var g = run.grade || tr.grade || {};
            html += _verdict(lvl, (tr.light === 'green' ? 'Test interpretable' : (tr.light === 'red' ? 'Test not interpretable as it stands' : 'Test partly interpretable')) + (g.letter ? ' (grade ' + g.letter + ')' : '') + ': ' + ((g.why && g.why[0]) || tr.verdict || ''));
            html += _table(['Check', 'Status', 'Value', 'Threshold', 'Note', 'Ev.'], (tr.checks || []).map(function (c) {
                return [c.title, c.level, _isNum(c.value) ? _sig(c.value, 3) : '—', _isNum(c.threshold) ? _sig(c.threshold, 3) : '—', c.text, (c.ev || []).join(' ')];
            }), 'prism_dfit_triage_tbl');
            if (tr.repump) html += _rbox('Re-pump verdict', [_rrow('Verdict', tr.repump.verdict)].concat((tr.repump.rules || []).slice(0, 6).map(function (r) { return _rrow(r.id, r.text); })));
            (tr.blunders || []).slice(0, 4).forEach(function (b) { if (b && b.text) html += _verdict('warn', b.text); });
        }
        html += _chart('dfitGradient', 220);
        h.innerHTML = html;
    };
    PANEL_RENDER.board = function (h) {
        var run = _run(), T = test();
        var html = '<div class="prism-dfit-checks">' + _check('options.axisLock', 'prism_dfit_axislock', 'Lock derivative axis') + _check('options.ppd', 'prism_dfit_ppd', 'Show primary pressure derivative (PPD)') + '</div>';
        html += _chart('dfitStrip', 140);
        if (!run || !run.consensus && !run.consensusLite) { h.innerHTML = html + _note(_hasData(G.PRiSM_dataset) ? 'Press ▶ Analyse to build the closure board.' : 'Load a DFIT first.'); return; }
        var c = run.consensus || run.consensusLite, cl = _closureOf(run), z = _num(T.inputs.datumTvd), lab = c.confidence || 'stale';
        var val = cl.mode === 'single' ? _f(cl.value, 0) + ' psia' : (cl.mode === 'range' ? _f(cl.lo, 0) + '–' + _f(cl.hi, 0) + ' psia (medians ' + cl.medians.map(function (m) { return _f(m, 0); }).join(' / ') + ')' : 'not reached');
        var rows = [_rrow('Closure', val), _rrow('Mode', cl.mode || 'none'), _rrow('Label', lab + (c.calibrated ? '' : ' (uncalibrated rule label)')),
                    _rrow('Gradient (psi/ft)', z && _isNum(_closureP(T.summary)) ? _f(_closureP(T.summary) / z, 3) : '—'), _rrow('Tolerance τ (psi)', _f(c.tau, 0))];
        var cp = T.picks.closure;
        if (cp && cp.source === 'user') rows.push(_rrow('User override', (cp.mode === 'family' ? cp.family + ' end' : _f(cp.p, 0) + ' psia') + (cp.reason ? ' — ' + cp.reason : '')));
        html += _rbox('Closure', rows);
        if (cl.mode === 'single') html += _verdict(lab === 'high' ? 'ok' : 'warn', 'Closure ' + _f(cl.value, 0) + ' psia' + (z ? ' (' + _f(cl.value / z, 3) + ' psi/ft)' : '') + ', ' + lab + ' confidence (uncalibrated rule label): ' + (c.preferredWhy || 'families agree') + ' (tolerance ' + _f(c.tau, 0) + ' psi).');
        else if (cl.mode === 'range') html += _verdict('warn', 'Closure range ' + _f(cl.lo, 0) + '–' + _f(cl.hi, 0) + ' psia (medians ' + cl.medians.map(function (m) { return _f(m, 0); }).join(' and ') + '; ' + lab + '): every downstream number is shown for both readings.');
        else html += _verdict('warn', 'No closure yet: dP/dG has not departed.' + (c.forecast && c.forecast.length ? ' Forecast: ' + c.forecast.map(function (f) { return _f(f.sigma, 0) + ' psia at ' + _f(f.dtc, 2) + ' h'; }).join(', ') + '.' : ''));
        html += _table(['Method', 'Family', 'Vote', 'Closure (psia)', 'G', 'Why', 'Ev.'], (run.picks || []).map(function (p) {
            return [p.method, p.family, p.vote ? 'yes' : (p.sameEvidenceAs ? 'same evidence' : 'no'), _f(p.p, 0), _f(p.G, 2), 'why', (p.ev || []).join ? p.ev.join(' ') : p.ev];
        }), 'prism_dfit_picks_tbl');
        html += '<div class="prism-dfit-bar">' + (run.picks || []).filter(function (p, i, a) { return a.map(function (x) { return x.method; }).indexOf(p.method) === i; }).map(function (p) {
            return _btn('prism_dfit_why_' + p.method, 'Why ' + p.method + '?', 'why').replace('data-dfit-act="why"', 'data-dfit-act="why" data-dfit-arg="' + _esc(p.method) + '"');
        }).join('') + '</div>';
        if (c.counterfactual && c.counterfactual.text) html += _note(c.counterfactual.text);
        if (c.stability && c.stability.grid && c.stability.grid.F1) {
            var g = c.stability.grid.F1;
            html += '<div class="prism-dfit-sub">Stability of the F1 median (rows L, columns tp)</div>' + _table(['L \\ tp'].concat(c.stability.tp || []), (c.stability.L || []).map(function (L, i) { return [L].concat((g[i] || []).map(function (v) { return _f(v, 0); })); }), 'prism_dfit_stab_tbl');
        }
        if (c.rules && c.rules.length) html += '<details class="prism-dfit-rules"><summary>Label rules</summary>' + _table(['Rule', 'Fired', 'Value', 'Threshold', 'Text'], c.rules.map(function (r) { return [r.id, r.fired ? 'yes' : 'no', _isNum(r.value) ? _sig(r.value, 3) : '—', _isNum(r.threshold) ? _sig(r.threshold, 3) : '—', r.text]; })) + '</details>';
        html += '<div class="prism-dfit-bar">' + _btn('prism_dfit_override_btn', 'Use another value', 'override') +
                (cl.mode === 'range' ? _btn('prism_dfit_fam_F1', 'Use the F1 end for hand-offs', 'familyEnd').replace('data-dfit-act="familyEnd"', 'data-dfit-act="familyEnd" data-dfit-arg="F1"') +
                                       _btn('prism_dfit_fam_F2', 'Use the F2 end for hand-offs', 'familyEnd').replace('data-dfit-act="familyEnd"', 'data-dfit-act="familyEnd" data-dfit-arg="F2"') : '') +
                (cp && cp.source === 'user' ? _btn('prism_dfit_override_clear', 'Remove override', 'clearOverride') : '') +
                _btn('prism_dfit_notes_btn', 'Method notes', 'note').replace('data-dfit-act="note"', 'data-dfit-act="note" data-dfit-arg="index"') + '</div>';
        // keyboard equivalent of the closure-marker drag (§7.14): ← / → move by one resampled point (Shift × 10), Enter commits
        // one pick-log entry, Escape restores the marker
        var d = run.derivs, i0 = d && _arr(d.p) ? _nearestIdx(d.p, (cp && cp.source === 'user' && _isNum(cp.p)) ? cp.p : _closureP(T.summary)) : -1;
        if (i0 >= 0) html += '<div class="prism-dfit-bar"><button type="button" class="btn btn-secondary" id="prism_dfit_marker" data-dfit-idx="' + i0 + '" aria-describedby="prism_dfit_marker_help">Closure marker: ' +
            _esc(_f(d.p[i0], 0)) + ' psia</button><span id="prism_dfit_marker_help" class="prism-dfit-note">Arrow keys move the marker (Shift × 10); Enter keeps it.</span></div>';
        h.innerHTML = html;
        var mk = h.querySelector ? h.querySelector('#prism_dfit_marker') : null;
        if (mk) {
            mk.addEventListener('keydown', function (e) { _markerKey(mk, e); });
            mk.addEventListener('click', function () {
                var on = mk.getAttribute('aria-pressed') !== 'true';
                mk.setAttribute('aria-pressed', on ? 'true' : 'false');
                if (on && mk.focus) { try { mk.focus(); } catch (e) { /* ignore */ } }
                var hp = _byId('prism_dfit_marker_help');
                if (hp) hp.textContent = on ? 'Marker selected: ← → move it by one point (Shift × 10), Enter keeps it, Esc cancels.' : 'Arrow keys move the marker (Shift × 10); Enter keeps it.';
            });
        }
    };
    function _markerKey(mk, e) {
        var run = _run(), d = run && run.derivs;
        if (!d || !e) return;
        var i = parseInt(mk.getAttribute('data-dfit-idx'), 10), n = d.p.length, step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') i = Math.max(0, i - step);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') i = Math.min(n - 1, i + step);
        else if (e.key === 'Enter') {
            if (e.preventDefault) e.preventDefault();
            setPick('closure', { mode: 'user', family: null, method: 'user', p: d.p[i], dt: d.dt[i], G: d.G[i] }, { source: 'user', reason: 'Closure marker moved with the keyboard' });
            return;
        } else if (e.key === 'Escape' || e.key === 'Esc') { var hst = _byId('prism_dfit_panel_board'); if (hst) PANEL_RENDER.board(hst); return; }
        else return;
        if (e.preventDefault) e.preventDefault();
        mk.setAttribute('data-dfit-idx', String(i));
        mk.textContent = 'Closure marker: ' + _f(d.p[i], 0) + ' psia (Enter keeps it)';
    }
    PANEL_RENDER.classify = function (h) {
        var run = _run(), k = run && run.classification;
        if (!k || k.ok === false) { h.innerHTML = _note('Press ▶ Analyse to classify the leak-off type.'); return; }
        var sc = k.scores || {};
        var html = _rbox('Leak-off type', [_rrow('Type', k.type), _rrow('Alternatives', (k.alt || []).join(', ') || '—'),
                    _rrow('R_vis (closure visibility)', _f(k.features && k.features.Rvis, 3)), _rrow('D / D_ref at closure', _f(k.features && k.features.DoverDref, 3))]);
        html += _table(['Type', 'Score'], Object.keys(sc).map(function (x) { return [x, _f(sc[x], 2)]; }), 'prism_dfit_class_tbl');
        (k.evidence || []).slice(0, 6).forEach(function (e) { html += _note(e); });
        if (k.features && k.features.unitSlopeSink) html += _verdict('warn', 'The log-log derivative keeps a unit slope past ΔtD 1: a near-constant leak (valve, casing, packer or another zone) is likely. Check the leak plot and the annulus.');
        html += '<div class="prism-dfit-bar">' + _btn('prism_dfit_note_type', 'About this type', 'note').replace('data-dfit-act="note"', 'data-dfit-act="note" data-dfit-arg="' + _esc(k.type) + '"') + '</div>';
        h.innerHTML = html;
    };
    PANEL_RENDER.frac = function (h) {
        var run = _run(), fr = run && run.frac && run.frac.chosen;
        if (!fr) { h.innerHTML = _note('Press ▶ Analyse to compute efficiency, net pressure and geometry.'); return; }
        var g = fr.geometry || {}, bm = g.byModel || {};
        var html = _rbox('Efficiency and net pressure', [
            _rrow('Closure used (psia)', _f(fr.pClosure, 0) + (fr.family ? ' (' + fr.family + ')' : '')), _rrow('G_c', _f(fr.Gc, 2)), _rrow('Δt_c (h)', _f(fr.dtc, 3)),
            _rrow('η_G (α = ½ / α = 1)', _f(fr.eta && fr.eta.a05, 3) + ' / ' + _f(fr.eta && fr.eta.a1, 3)), _rrow('η_f (fracture)', _f(fr.eta && fr.eta.etaF, 3)),
            _rrow('Net pressure p_n (psi)', _f(fr.pn, 0)), _rrow('Consistency ratio χ', _f(fr.chi, 2)),
            _rrow('ISIP gradient (psi/ft)', _f(fr.gradIsip, 3)), _rrow('Closure gradient (psi/ft)', _f(fr.gradClosure, 3))]);
        html += _rbox('Storage-consistent closure balance', [_rrow('C_sys (bbl/psi)', _sig(fr.Csys, 4)), _rrow('A_f·c_f (bbl/psi)', _sig(fr.AfCf, 4)), _rrow('R_vis', _f(fr.Rvis, 3)),
            _rrow('Γ (psi/√min)', _f(fr.Gamma, 2)), _rrow('Γ_PKN', _f(fr.GammaPKN, 2))]);
        html += _table(['Geometry', 'xf or R (ft)', 'A_f (ft²)', 'w̄ (in)', 'CL (ft/√min)'], ['PKN', 'KGD', 'radial'].map(function (k) {
            var x = bm[k] || {}; return [k + (k === g.model ? ' (chosen)' : ''), _f(x.xf != null ? x.xf : x.R, 1), _f(x.Af, 0), _f(x.wAvg, 3), _sig(x.CL, 3)];
        }), 'prism_dfit_geom_tbl');
        (g.msgs || []).slice(0, 4).forEach(function (s) { html += _note(s); });
        if (fr.spurt && fr.spurt.note) html += _note(fr.spurt.note);
        if (fr.kBefore && fr.kBefore.kCL) html += _rbox('Before-closure k estimates (indicative)', [_rrow('k from CL (md)', _sig(fr.kBefore.kCL.k, 3) + ' (factor ' + _f(fr.kBefore.kCL.factor, 1) + ')')]);
        if (fr.padFraction) html += _rbox('Pad fraction (indicative)', [_rrow('Range', _f(fr.padFraction.lo, 3) + '–' + _f(fr.padFraction.hi, 3))]);
        if (fr.stressCal) html += _rbox('Stress-log calibration offset', [_rrow('Δσ_tect (psi)', _f(fr.stressCal.dSigmaTect, 0)), _rrow('Biot', _f(fr.stressCal.biot, 2))]);
        html += _chart('dfitQL', 200);
        h.innerHTML = html;
    };
    PANEL_RENDER.whatif = function (h) {
        var run = _run(), W = run && run.whatIf;
        var wp = _st()._dfitWhatIf;
        var html = '<div class="fg"><div class="fg-item"><label for="prism_dfit_whatif_p">What-if closure (psia)</label><input type="text" inputmode="decimal" id="prism_dfit_whatif_p" value="' + _esc(wp && _isNum(wp.p) ? wp.p : '') + '"></div></div>' +
                   '<div class="prism-dfit-bar">' + _btn('prism_dfit_whatif_go', 'Compute', 'whatIf') + (wp ? _btn('prism_dfit_whatif_clear', 'Clear', 'whatIfClear') : '') + '</div>';
        if (!W || !W.length) { h.innerHTML = html + _note('Press ▶ Analyse for the what-if table.'); return; }
        html += _table(['Candidate', 'Family', 'Method', 'σ_c (psia)', 'G_c', 'Δt_c (h)', 'η (½)', 'η (1)', 'p_n (psi)', 'χ', 'R_vis', 'CL (ft/√min)', 'xf (ft)'], W.map(function (w) {
            var bm = (w.geometry && w.geometry.byModel) || {}, x = bm[(w.geometry && w.geometry.model) || 'PKN'] || {};
            return [w.label || '—', w.family || '—', w.method || '—', _f(w.pClosure, 0), _f(w.Gc, 2), _f(w.dtc, 3), _f(w.eta && w.eta.a05, 3), _f(w.eta && w.eta.a1, 3), _f(w.pn, 0), _f(w.chi, 2), _f(w.Rvis, 3), _sig(x.CL, 3), _f(x.xf != null ? x.xf : x.R, 1)];
        }), 'prism_dfit_whatif_tbl');
        h.innerHTML = html;
    };
    PANEL_RENDER['report-opts'] = function (h) {
        var d = dstate();
        if (!_isObj(d.report)) d.report = { groups: {}, familyColumns: true, log: true, appendix: true, template: 'default', who: '' };
        var R = d.report;
        var html = '<div class="card"><div class="card-title">DFIT report options</div><div class="prism-dfit-checks">' +
                   SECTIONS.map(function (s) { return '<label class="prism-dfit-check"><input type="checkbox" id="prism_dfit_rg_' + s[0] + '" data-dfit-rg="' + s[0] + '"' + (R.groups[s[0]] === false ? '' : ' checked') + '> ' + _esc(s[1]) + '</label>'; }).join('') +
                   '<label class="prism-dfit-check"><input type="checkbox" id="prism_dfit_rg_famcols" data-dfit-ro="familyColumns"' + (R.familyColumns ? ' checked' : '') + '> Per-family columns (range mode)</label>' +
                   '<label class="prism-dfit-check"><input type="checkbox" id="prism_dfit_rg_log" data-dfit-ro="log"' + (R.log ? ' checked' : '') + '> Include the pick log</label>' +
                   '<label class="prism-dfit-check"><input type="checkbox" id="prism_dfit_rg_appx" data-dfit-ro="appendix"' + (R.appendix ? ' checked' : '') + '> Include the evidence appendix</label></div>' +
                   '<div class="fg"><div class="fg-item"><label for="prism_dfit_who">Analyst name</label><input type="text" id="prism_dfit_who" value="' + _esc(R.who || '') + '" maxlength="60"></div></div>' +
                   '<div class="prism-dfit-bar">' + _btn('prism_dfit_export_txt', 'DFIT data + picks (ASCII)', 'exportText') + _btn('prism_dfit_export_sheet', 'Frac-design sheet (CSV)', 'exportSheet') + '</div></div>';
        h.innerHTML = html;
        Array.prototype.forEach.call(h.querySelectorAll ? h.querySelectorAll('[data-dfit-rg],[data-dfit-ro]') : [], function (inp) {
            inp.addEventListener('change', function () {
                var g = inp.getAttribute('data-dfit-rg'), o = inp.getAttribute('data-dfit-ro');
                if (g) R.groups[g] = !!inp.checked; else if (o) R[o] = !!inp.checked;
                _emit('prism:dfit-updated', { what: 'test', source: 'user' });
            });
        });
        var who = h.querySelector ? h.querySelector('#prism_dfit_who') : null;
        if (who) who.addEventListener('change', function () { R.who = _txt(who.value).slice(0, 60); });
    };
    var PANELS = [
        [1, 'dfit-tests', 'Tests in this well', 5, 'tests'], [1, 'dfit-well', 'DFIT well, wellbore and fluid', 10, 'well'],
        [1, 'dfit-channels', 'Channels and bottomhole conversion', 20, 'channels'], [1, 'dfit-triage', 'Test triage', 30, 'triage'],
        [2, 'dfit-board', 'Closure consensus', 10, 'board'], [2, 'dfit-classify', 'Leak-off type', 20, 'classify'],
        [2, 'dfit-frac', 'Efficiency, net pressure, CL and geometry', 30, 'frac'], [2, 'dfit-whatif', 'What-if closure table', 40, 'whatif'],
        [7, 'dfit-report-opts', 'DFIT report options (sections, family columns, pick log, export template)', 10, 'report-opts']
    ];
    var PANEL_SPECS = {};
    PANELS.forEach(function (p) {
        var name = p[4];
        PANEL_SPECS[p[1]] = { tab: p[0], id: p[1], title: p[2], order: p[3], modes: ['dfit'],
            when: function () { return !!(G.PRiSM && G.PRiSM.mode === 'dfit'); },
            render: function (body) { var hst = _panelHost(body, name); PANEL_RENDER[name](hst); _drawIn(hst); } };
    });
    function _rerenderPanels() {
        Object.keys(PANEL_RENDER).forEach(function (name) {
            var hst = _byId('prism_dfit_panel_' + name);
            if (hst && hst.isConnected !== false) { try { PANEL_RENDER[name](hst); _drawIn(hst); } catch (e) { /* a panel must not break the others */ } }
        });
    }

    // =========================================================================
    // SECTION 12 — STEP VIEWS ② and ④ (§7.3, §7.5)
    // =========================================================================
    function _drawIn(host) {
        if (!host || !host.querySelectorAll) return;
        Array.prototype.forEach.call(host.querySelectorAll('canvas[data-dfit-plot]'), function (cv) { drawPlot(cv, cv.getAttribute('data-dfit-plot')); });
    }
    function redrawAll() {
        if (!HAS_DOC || !document.querySelectorAll) return 0;
        var n = 0;
        Array.prototype.forEach.call(document.querySelectorAll('canvas[data-dfit-plot]'), function (cv) { if (cv.isConnected !== false) { drawPlot(cv, cv.getAttribute('data-dfit-plot')); n++; } });
        var st = _st();
        if (hooksReady() && _inDfit() && st.activePlot && PLOT_ENTRIES[st.activePlot] && typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
        return n;
    }
    function renderStep2(host) {
        if (!host) return null;
        host.innerHTML = '<div id="prism_dfit_step2" class="prism-dfit-step"></div>';
        var h = host.firstChild || _byId('prism_dfit_step2');
        _wire(h);
        _renderStep2Into(h);
        return h;
    }
    function _renderStep2Into(h) {
        var run = _run(), T = test(), I = run && run.isip;
        var html = _staleLine(T);
        html += '<div class="card"><div class="card-title">ISIP</div>';
        if (!I || I.ok === false) html += _note(_hasData(G.PRiSM_dataset) ? 'Press ▶ Analyse to estimate the ISIP.' : 'Load a DFIT first (step ①).');
        else {
            html += _table(['Method', 'Family', 'ISIP (psia)', 'se (psi)', 'Status', 'Bleed-off at end (psi)'], (I.candidates || []).map(function (c) {
                return [c.method, c.family, _f(c.value, 1), _f(c.se, 1), !c.ok ? 'failed' : (c.upper ? 'upper estimate' : 'accepted'), _f(c.bleedAtEnd, 1)];
            }), 'prism_dfit_isip_tbl');
            html += _rbox('Consensus', [_rrow('ISIP (psia)', _f(I.value, 1) + ' ± ' + _f(I.spread, 1)), _rrow('Label', I.confidence)]);
            html += _verdict(I.confidence === 'high' ? 'ok' : 'warn', 'ISIP ' + _f(I.value, 0) + ' psia (' + I.confidence + '): ' + ((I.why && I.why[0]) || ''));
            (I.candidates || []).filter(function (c) { return c.upper; }).forEach(function (c) { html += _verdict('warn', 'The ' + c.method + ' ISIP ' + _f(c.value, 0) + ' psia is an upper estimate' + (_isNum(c.bleedAtEnd) ? ': the friction bleed-off had not died out at the end of the fit window (' + _f(c.bleedAtEnd, 0) + ' psi predicted).' : '.')); });
            var ip = T.picks.isip;
            if (ip && ip.source === 'user') html += _rrow('User ISIP', _f(ip.value, 1) + ' psia — ' + (ip.reason || ''));
        }
        html += '<div class="prism-dfit-bar">' + _btn('prism_dfit_isip_override', 'Use another ISIP', 'override').replace('data-dfit-act="override"', 'data-dfit-act="override" data-dfit-arg="isip"') +
                _btn('prism_dfit_note_isip', 'ISIP method notes', 'note').replace('data-dfit-act="note"', 'data-dfit-act="note" data-dfit-arg="isip-wh"') + '</div>' + _chart('dfitIsip', 240) + '</div>';
        html += '<div class="card"><div class="card-title">Water hammer</div>' + _hammerHTML(run, false) + '</div>';
        var sd = run ? _stepResult('down', run) : null;
        html += '<div class="card"><div class="card-title">Step-down</div>' + (sd ? _stepDownHTML(sd) + _chart('dfitStepDown', 220) : _note('No step-down in this record.')) + '</div>';
        var sr = run ? _stepResult('up', run) : null;
        html += '<div class="card"><div class="card-title">Step-rate</div>' + (sr ? _stepRateHTML(sr) + _chart('dfitStepRate', 220) : _note('No step-rate sequence in this record.')) + '</div>';
        var hasCyc = run && run.events && _arr(run.events.cycles) && run.events.cycles.some(function (c) { return c.rampWin; });
        html += '<div class="card"><div class="card-title">Cycles and reopening</div>' + (hasCyc ? _chart('dfitCycles', 220) : _note('No re-pressurisation ramp (later cycle, pump-in or LOT) in this record.')) + '</div>';
        html += '<div class="card"><div class="card-title">Injection net pressure (indicative)</div>' + _chart('dfitInjNet', 200) + '</div>';
        (G.PRiSM_dfit_hooks && _arr(G.PRiSM_dfit_hooks.step2Cards) ? G.PRiSM_dfit_hooks.step2Cards : []).forEach(function (fn) {
            if (typeof fn !== 'function') return;
            try { var x = fn(run, T); if (typeof x === 'string') html += x; } catch (e) { /* 3.4b card failed */ }
        });
        h.innerHTML = html;
        _drawIn(h);
    }
    function _stepDownHTML(sd) {
        var r = sd.res;
        if (!r) return _note('Step-down found (' + sd.steps.length + ' steps); the wellbore engine is needed for the friction split.');
        var rows = [_rrow('p_frac (psia)', _f(r.pFrac, 1)), _rrow('Perforation coefficient a', _sig(r.a, 3)), _rrow('Near-wellbore coefficient b', _sig(r.b, 3)), _rrow('β', _f(r.beta, 2)), _rrow('Label', r.label || '—')];
        if (r.nOpenBand) rows.push(_rrow('Open perforations P10/P50/P90', _f(r.nOpenBand.p10, 1) + ' / ' + _f(r.nOpenBand.p50, 1) + ' / ' + _f(r.nOpenBand.p90, 1)));
        return _rbox('Step-down', rows) + (r.refused ? _verdict('warn', r.refused) : '');
    }
    function _stepRateHTML(sr) {
        var r = sr.res;
        if (!r) return _note('Step-rate steps found (' + sr.steps.length + '); the wellbore engine is needed for the hinge.');
        return _rbox('Step-rate', [_rrow('Parting rate q* (bbl/min)', _f(r.qStar, 2)), _rrow('Fracture extension pressure (psia)', _f(r.fep, 0)), _rrow('F-test p', _sig(r.fTest && r.fTest.p, 2))]) +
               _table(['q (bbl/min)', 'p_end (psia)', 'dp/dt', 'Stabilised'], (r.steps || []).map(function (s) { return [_f(s.q, 2), _f(s.pEnd, 0), _sig(s.dpdt, 2), s.stabilised ? 'yes' : 'no']; })) +
               (r.breakFound ? '' : _verdict('warn', 'No break: the F-test does not support a parting point.'));
    }
    var _s4Tab = 'aca';
    var S4_TABS = [['aca', 'After-closure'], ['lk', 'Leak-off model'], ['unc', 'Uncertainty'], ['tell', 'What this test can tell']];
    function renderStep4(host, tab) {
        if (!host) return null;
        if (tab) _s4Tab = tab;
        host.innerHTML = '<div id="prism_dfit_step4" class="prism-dfit-step"></div>';
        var h = host.firstChild || _byId('prism_dfit_step4');
        _wire(h);
        _renderStep4Into(h);
        return h;
    }
    function _renderStep4Into(h) {
        var T = test();
        var html = '<div id="prism_dfit_s4_tabs" class="prism-dfit-seg" role="tablist">' + S4_TABS.map(function (t) {
            return '<button type="button" role="tab" class="btn ' + (t[0] === _s4Tab ? 'btn-primary' : 'btn-secondary') + '" id="prism_dfit_s4_' + t[0] + '" aria-selected="' + (t[0] === _s4Tab) + '" data-dfit-act="s4" data-dfit-arg="' + t[0] + '">' + _esc(t[1]) + '</button>';
        }).join('') + '</div>' + _staleLine(T) + '<div id="prism_dfit_msg" class="prism-dfit-warn" style="display:none"></div>';
        if (_s4Tab === 'lk') html += _lkHTML();
        else if (_s4Tab === 'unc') html += _uncHTML();
        else if (_s4Tab === 'tell') html += _tellHTML();
        else html += _acaHTML();
        h.innerHTML = html;
        _drawIn(h);
    }
    function _acaHTML() {
        var run = _run(), A = run && run.aca;
        var html = '<div class="card"><div class="card-title">After-closure options</div><div class="fg">' + _select('options.aca.origin', 'Time origin') + _select('options.aca.tideRemove', 'Tide removal') + '</div>' +
                   _fields(FIELDS.aca) + '<div class="prism-dfit-checks">' + _check('options.aca.carterExactFR', 'prism_dfit_aca_frc', 'Carter-exact F_R') + _check('options.ppd', 'prism_dfit_ppd4', 'Show PPD') + '</div></div>';
        if (!A || A.ok === false) return html + _note(_hasData(G.PRiSM_dataset) ? 'After-closure analysis needs data after closure — press ▶ Analyse.' : 'Load a DFIT first (step ①).');
        var b = A.brackets || {}, br = function (x) { return x ? _f(x[0], 0) + ' – ' + _f(x[1], 0) : '—'; };
        html += _rbox('After-closure summary', [_rrow('Regime', A.regimeSummary), _rrow('p_i (psia)', _f(A.pi && A.pi.value, 0) + ' (' + ((A.pi && A.pi.label) || '—') + ')'),
                    _rrow('kh/μ (md·ft/cp)', A.kh ? _sig(A.kh.khmu, 3) : '—'), _rrow('k (md)', A.kh ? _sig(A.kh.k, 3) : (A.nolte && A.nolte.lin ? _sig(A.nolte.lin.k, 3) + ' (F_L line)' : '—')),
                    _rrow('k bounds (md)', A.bounds ? _sig(A.bounds.kLo, 3) + ' – ' + _sig(A.bounds.kHi, 3) : '—')]);
        html += _table(['Bracket', 'Lower (psia)', 'Upper (psia)'], [['Cartesian', br(b.cart).split(' – ')[0], (br(b.cart).split(' – ')[1] || '—')], ['Impulse', br(b.imp).split(' – ')[0], (br(b.imp).split(' – ')[1] || '—')],
                    ['Derivative', br(b.deriv).split(' – ')[0], (br(b.deriv).split(' – ')[1] || '—')], ['Combined', br(b.combined).split(' – ')[0], (br(b.combined).split(' – ')[1] || '—')]], 'prism_dfit_brackets_tbl');
        if (A.pi && A.pi.label === 'high') html += _verdict('ok', 'p_i ' + _f(A.pi.value, 0) + ' psia, bracket ' + _f(A.pi.lo, 0) + '–' + _f(A.pi.hi, 0) + ' psia (high).');
        else if (A.pi) html += _verdict('warn', 'p_i ' + _f(A.pi.value, 0) + ' psia, bracket ' + _f(A.pi.lo, 0) + '–' + _f(A.pi.hi, 0) + ' psia (' + (A.pi.label || 'low') + ').');
        if (!A.kh && A.bounds) html += _verdict('warn', 'Radial flow not reached: k between ' + _sig(A.bounds.kLo, 3) + ' and ' + _sig(A.bounds.kHi, 3) + ' md.');
        (A.warnings || []).slice(0, 4).forEach(function (w) { if (w && w.text) html += _verdict(w.level === 'bad' ? 'bad' : 'warn', w.text); });
        var L = run.leak;
        if (L && L.ok !== false) html += _rbox('Leak check', [_rrow('Verdict', L.verdict), _rrow('Leak rate (bbl/d)', _sig(L.qk, 3)), _rrow('Tolerance (bbl/d)', _sig(L.qkMax, 3))]);
        html += _chart('dfitAcaLogLog', 240) + _chart('dfitFlowDim', 180) + _chart('dfitFL', 220) + _chart('dfitImpLin', 200) + _chart('dfitPiTraj', 200);
        html += _matchHTML(run);
        var c = _closureOf(run);
        html += '<div class="card"><div class="card-title">Hand-offs</div><div class="prism-dfit-bar">' +
                (c.mode === 'range' ? _btn('prism_dfit_handoff_F1', 'Open in PTA (F1 chain)', 'handoffF').replace('data-dfit-act="handoffF"', 'data-dfit-act="handoffF" data-dfit-arg="F1"') +
                                      _btn('prism_dfit_handoff_F2', 'Open in PTA (F2 chain)', 'handoffF').replace('data-dfit-act="handoffF"', 'data-dfit-act="handoffF" data-dfit-arg="F2"')
                                    : _btn('prism_dfit_handoff_pta', 'Open in PTA (transient)', 'handoff').replace('data-dfit-act="handoff"', 'data-dfit-act="handoff" data-dfit-arg="pta"')) +
                _btn('prism_dfit_handoff_frac', 'Frac-design sheet (CSV)', 'exportSheet') + _btn('prism_dfit_copy_grad', 'Copy closure gradient', 'copyGrad') + _btn('prism_dfit_copy_isip_grad', 'Copy ISIP gradient', 'copyIsipGrad') + '</div></div>';
        return html;
    }
    // ── "Model match" card (§6.8): the PRiSM model library on the constant-rate-equivalent derivative, p_i bounded by the bracket.
    //    The match itself is 57's PRiSM_dfit_acaMatch(Job) (resolved at call time); the result is kept in memory (st._dfitAcaMatch,
    //    keyed by the run's dataset and inputs hashes) like the what-if, and run.aca.match is shown when the pipeline carries one.
    var MATCH_MODELS = [['infiniteFrac', 'Fracture, uniform flux'], ['finiteFrac', 'Fracture, finite conductivity'], ['homogeneous', 'Radial homogeneous'], ['radialComposite', 'Radial composite']];
    var _mmJob = null;
    function _matchSel() {
        var st = _st();
        if (!_arr(st._dfitMatchModels)) st._dfitMatchModels = MATCH_MODELS.map(function (m) { return m[0]; });
        return st._dfitMatchModels;
    }
    function _matchOf(run) {
        var m = _st()._dfitAcaMatch;
        if (m && run && m.dsHash === run.dsHash && m.inputsHash === run.inputsHash && m.res) return m.res;
        var A = _aca(run);
        return (A && _isObj(A.match)) ? A.match : null;
    }
    function _matchHTML(run) {
        var sel = _matchSel(), m = _matchOf(run);
        var html = '<div class="card"><div class="card-title">Model match</div>' +
                   _note('Matches PRiSM models to the after-closure constant-rate-equivalent derivative from the centroid origin; p_i stays inside the bracket. The result seeds the PTA hand-off.') +
                   '<div class="prism-dfit-checks">' + MATCH_MODELS.map(function (o) {
                       var id = 'prism_dfit_mm_' + o[0];
                       return '<label class="prism-dfit-check"><input type="checkbox" id="' + id + '" data-dfit-mm="' + o[0] + '"' + (sel.indexOf(o[0]) !== -1 ? ' checked' : '') + '> ' + _esc(o[1]) + '</label>';
                   }).join('') + '</div><div class="prism-dfit-bar">' + _btn('prism_dfit_aca_match', 'Match', 'acaMatch', 'btn-primary') + '</div>' + _chart('dfitCrDeriv', 200);
        if (m && m.ok !== false && m.best) {
            var b = m.best, ci = b.ci95 || {};
            var nm = ''; MATCH_MODELS.forEach(function (o) { if (o[0] === b.model) nm = o[1]; });
            html += _rbox('Best match', [_rrow('Model', nm || b.model || '—'), _rrow('k (md)', _sig(b.k, 3) + (ci.k ? ' (' + _sig(ci.k[0], 3) + ' – ' + _sig(ci.k[1], 3) + ')' : '')),
                       _rrow('L (ft)', _f(b.L, 1) + (ci.L ? ' (' + _f(ci.L[0], 1) + ' – ' + _f(ci.L[1], 1) + ')' : '')), _rrow('p_i (psia)', _f(b.pi, 0)), _rrow('BIC', _f(b.bic, 1))]);
            if (_arr(m.candidates) && m.candidates.length) html += _table(['Model', 'k (md)', 'L (ft)', 'p_i (psia)', 'BIC'], m.candidates.map(function (c) {
                return [c.model || '—', _sig(c.k, 3), _f(c.L, 1), _f(c.pi, 0), _f(c.bic, 1)];
            }), 'prism_dfit_mm_tbl');
        } else if (m && m.ok === false) html += _verdict('warn', 'The model match failed: ' + _txt((m.errors && m.errors[0]) || m.why || 'no result'));
        return html + '</div>';
    }
    function _acaMatch() {
        var run = _run(), A = _aca(run);
        if (!_need(run && A && A.ok !== false, 'The model match needs after-closure results — press ▶ Analyse.')) return null;
        var sel = _matchSel().slice();
        if (!_need(sel.length > 0, 'Tick at least one model to match.')) return null;
        var mk = _fn('PRiSM_dfit_acaMatchJob'), f1 = _fn('PRiSM_dfit_acaMatch');
        if (!_need(mk || f1, 'The after-closure model match is not available in this build yet.')) return null;
        var T = test();
        var ctx = { run: run, aca: A, prep: run.prep, events: run.events, inputs: T.inputs, well: _well(), ds: G.PRiSM_dataset };
        var opts = { models: sel, piBracket: (A.pi && _isNum(A.pi.lo) && _isNum(A.pi.hi)) ? [A.pi.lo, A.pi.hi] : null, seed: 1 };
        var me = _mmJob = { cancelled: false };
        var finish = function (res) {
            if (_mmJob === me) _mmJob = null;
            if (!res) { _setStatus('⚠ The model match did not return a result.', 'warn'); return null; }
            _st()._dfitAcaMatch = { dsHash: run.dsHash, inputsHash: run.inputsHash, res: res };
            if (res.ok !== false && res.best) logEntry(T, 'aca.match', null, res.best.model || null, 'After-closure model match');
            _emit('prism:dfit-updated', { what: 'aca', source: 'user' });
            _refreshUI();
            return res;
        };
        var job = null;
        if (mk) { try { job = mk(ctx, opts); } catch (e) { job = null; } }
        var AI = G.PRiSM_autoInterp;
        if (job && typeof job.step === 'function') {
            if (AI && typeof AI.drive === 'function') return AI.drive(job, { shouldCancel: function () { return me.cancelled; } }).then(finish, function () { if (_mmJob === me) _mmJob = null; return null; });
            try { return finish(_runJobSync(job, function () { return me.cancelled; })); } catch (e) { _mmJob = null; return null; }
        }
        var r = null;
        try { r = f1(ctx, opts); } catch (e) { r = { ok: false, errors: [_txt(e && e.message)] }; }
        return finish(r);
    }
    var _nAnalyse = 0;   // ▶ Analyse runs in this session (status line)
    var _lkJob = null;
    function _sandboxCfg() {
        var f = _fn('PRiSM_dfit_lkDefaults'), cfg = null;
        if (f) { try { cfg = f(); } catch (e) { cfg = null; } }
        if (!_okRes(cfg) || cfg.code) return null;
        var sb = dstate().sandbox || {};
        var V = _num(sb.V) || 25, q = _num(sb.q) || 5, tEnd = _num(sb.tEnd) || 300;
        cfg.schedule = [{ t: 0, q: q }, { t: V / q / 60, q: 0 }];
        cfg.tEnd = tEnd;
        return cfg;
    }
    function _lkHTML() {
        var d = dstate();
        if (!_isObj(d.sandbox)) d.sandbox = { V: 25, q: 5, tEnd: 300 };
        var sb = d.sandbox;
        var inp = function (k, label, unit) { return '<div class="fg-item"><label for="prism_dfit_sb_' + k + '">' + _esc(label) + ' (' + unit + ')</label><input type="text" inputmode="decimal" id="prism_dfit_sb_' + k + '" data-dfit-sb="' + k + '" value="' + _esc(_isNum(sb[k]) ? sb[k] : '') + '"></div>'; };
        var html = '<div class="card"><div class="card-title">Leak-off sandbox</div>' + _note('What leak-off rate does a fracture of this size give? The mini-model runs without data; with data, the history match fits it to the falloff.') +
                   '<div class="fg">' + inp('V', 'Injected volume', 'bbl') + inp('q', 'Rate', 'bbl/min') + inp('tEnd', 'Shut-in to', 'h') + '</div>' +
                   '<div class="prism-dfit-bar">' + _btn('prism_dfit_lk_sim', 'Simulate', 'lkSim', 'btn-primary') + '</div>';
        var cfg = _sandboxCfg(), qf = _fn('PRiSM_dfit_lkQuick'), qr = null;
        if (cfg && qf) { try { qr = qf(cfg); } catch (e) { qr = null; } }
        if (qr && _arr(qr.rows)) html += _table(['After', 'Δt (min)', 'Leak-off rate (bbl/min)'], qr.rows.map(function (r) { return [r.label, _f(r.dtMin, 1), _sig(r.qL, 3)]; }), 'prism_dfit_lk_quick') +
                                         _rbox('Quick answers', [_rrow('Leaked volume (bbl)', _f(qr.VL, 2)), _rrow('Efficiency η', _f(qr.eta, 3)), _rrow('Closure time (h)', _f(qr.tc, 2)), _rrow('xf (ft)', _f(qr.xf, 1))]);
        else if (!cfg) html += _verdict('warn', 'The leak-off model is not available in this build yet.');
        html += '</div>';
        html += '<div class="card"><div class="card-title">History match</div><div class="fg"><div class="fg-item"><label for="prism_dfit_lk_preset">Preset</label><select id="prism_dfit_lk_preset">' +
                [['falloff', 'Falloff only'], ['full', 'Full record'], ['geometry', 'Geometry'], ['pdl', 'Pressure-dependent leak-off'], ['spurt', 'Spurt']].map(function (o) { return '<option value="' + o[0] + '">' + _esc(o[1]) + '</option>'; }).join('') +
                '</select></div></div><div class="prism-dfit-bar">' + _btn('prism_dfit_lk_fit', 'Fit', 'lkFit', 'btn-primary') + _btn('prism_dfit_lk_struct', 'Structural spread', 'lkStruct') + _btn('prism_dfit_lk_cancel', 'Cancel', 'lkCancel') + '</div>';
        var T = test(), fit = T.lk && T.lk.fit;
        if (fit && fit.params) html += _table(['Parameter', 'Value', '95 % CI', 'Inflated CI'], Object.keys(fit.params).map(function (k) {
            var ci = fit.ci95 && fit.ci95[k], cj = fit.ci95Inflated && fit.ci95Inflated[k];
            return [k, _sig(fit.params[k], 4), ci ? _sig(ci[0], 4) + ' – ' + _sig(ci[1], 4) : '—', cj ? _sig(cj[0], 4) + ' – ' + _sig(cj[1], 4) : '—'];
        }), 'prism_dfit_lk_fit_tbl');
        var SS = fit && fit.groups && fit.groups.structural;
        if (_isObj(SS)) {
            var rr = function (k, lab, dp) { var v = SS[k]; return [lab, _arr(v) && _isNum(v[0]) && _isNum(v[1]) ? (dp == null ? _sig(v[0], 3) + ' – ' + _sig(v[1], 3) : _f(v[0], dp) + ' – ' + _f(v[1], dp)) : '—']; };
            html += _table(['Structural spread (aperture laws, PDL on/off; χ² ≤ 1.5 × best)', 'Range'], [rr('sigmaC', 'σ_c (psia)', 0), rr('pr', 'p_r (psia)', 0), rr('k', 'k (md)'), rr('CLeq', 'CL equivalent (ft/√min)')], 'prism_dfit_lk_struct_tbl');
        }
        if (fit && fit.groups && fit.groups.text) html += _note(_txt(fit.groups.text));
        html += '</div>' + _chart('dfitLkP', 220) + _chart('dfitLkQ', 200) + _chart('dfitLkGeom', 200) + _chart('dfitLkRes', 180);
        return html;
    }
    function _uncHTML() {
        var run = _run(), U = run && run.unc;
        if (!U || U.ok === false) return _note(run ? 'The uncertainty runs with the full ▶ Analyse (not with fast updates): press ▶ Analyse.' : 'Press ▶ Analyse first.');
        var rows = Object.keys(U.outputs || {}).map(function (k) {
            var o = U.outputs[k];
            if (o.bimodal && o.byFamily) return [k, 'F1 ' + _f(o.byFamily.F1 && o.byFamily.F1.p50, 3) + ' / F2 ' + _f(o.byFamily.F2 && o.byFamily.F2.p50, 3), '—', '—', o.unit || ''];
            return [k, _sig(o.p10, 4), _sig(o.p50, 4), _sig(o.p90, 4), o.unit || ''];
        });
        return _rbox('Uncertainty', [_rrow('Draws', _f(U.n, 0)), _rrow('Seed', _f(U.seed, 0)), _rrow('Mode', U.mode)]) + _table(['Output', 'P10', 'P50', 'P90', 'Unit'], rows, 'prism_dfit_unc_tbl') +
               _table(['Input', 'Distribution', 'Provenance'], (U.inputs || []).map(function (i) { return [i.name, i.dist, i.provenance || '—']; }));
    }
    function _tellHTML() {
        var T = test(), fit = T.lk && T.lk.fit, f = _fn('PRiSM_dfit_identify'), id = null;
        if (fit && f) { try { id = f(fit, {}); } catch (e) { id = null; } }
        if (!id || !_arr(id.rows)) return _note('Run the history match (Leak-off model) to see which parameters this test determines.');
        return _table(['Parameter', 'Status', '±', 'Sentence'], id.rows.map(function (r) { return [r.param, r.status, _sig(r.pm, 3), r.text]; }), 'prism_dfit_tell_tbl') +
               (id.sloppyText ? _note(id.sloppyText) : '') +
               (_arr(id.voi) ? _table(['Information', 'Reduction', 'Sentence'], id.voi.map(function (v) { return [v.source, _f(v.reduction, 2), v.text]; })) : '') +
               (_arr(id.extend) ? _table(['Shut-in (d)', 'σ(p_i) (psi)', 'k range (md)', 'P(radial)'], id.extend.map(function (x) { return [_f(x.tEndD, 1), _f(x.sdPi, 0), x.kRange ? _sig(x.kRange[0], 2) + ' – ' + _sig(x.kRange[1], 2) : '—', _f(x.pRadial, 2)]; })) : '');
    }
    function _readSandbox() {
        var d = dstate(); if (!_isObj(d.sandbox)) d.sandbox = { V: 25, q: 5, tEnd: 300 };
        ['V', 'q', 'tEnd'].forEach(function (k) { var el = _byId('prism_dfit_sb_' + k); if (el) { var r = clampField('sandbox.' + k, el.value); d.sandbox[k] = r.value; el.value = _isNum(r.value) ? String(r.value) : ''; } });
        return d.sandbox;
    }
    function _lkSimulate() {
        _readSandbox();
        var cfg = _sandboxCfg(), f = _fn('PRiSM_dfit_lkSimulate');
        if (!_need(cfg && f, 'The leak-off model is not available in this build yet.')) return null;
        var r = null;
        try { r = f(cfg, { grid: 'display' }); } catch (e) { r = null; }
        if (!_need(r && r.ok !== false, 'The leak-off model run failed: ' + _txt((r && (r.why || (r.errors && r.errors[0]))) || 'no result'))) return null;
        _st()._dfitLk = r;
        _emit('prism:dfit-model-updated', { kind: 'simulate', ok: true });
        _refreshUI();
        return r;
    }
    function _lkFit(o) {
        o = o || {};
        var run = _run(), ds = G.PRiSM_dataset, mk = G.PRiSM_dfit_lkFitJob, cfg = _sandboxCfg();
        if (!_need(_hasData(ds) && run, 'Load a DFIT and press ▶ Analyse before the history match.')) return null;
        if (!_need(typeof mk === 'function' && !mk._dfitStub && cfg, 'The history match is not available in this build yet.')) return null;
        var sel = _byId('prism_dfit_lk_preset'), preset = sel ? sel.value : 'falloff';
        var t0 = (run.events && run.events.tStart) || 0;
        var job = null;
        try { job = mk({ t: ds.t.map(function (t) { return t - t0; }), p: ds.p }, cfg, preset, o.structural ? { seed: 1, structural: true } : { seed: 1 }); } catch (e) { job = null; }
        if (!_need(job && typeof job.step === 'function', 'The history match could not start.')) return null;
        var me = _lkJob = { cancelled: false };
        var T = test();
        var finish = function (fit) {
            if (_lkJob === me) _lkJob = null;
            if (!fit || fit.ok === false) { _setStatus('⚠ The history match failed.', 'warn'); return fit; }
            _batch('begin');
            var grp = _clone(fit.groups) || {};
            if (o.structural && _isObj(fit.structural)) grp.structural = _clone(fit.structural);
            T.lk = { cfg: cfg, preset: preset, fit: { params: fit.params, ci95: fit.ci95, ci95Inflated: fit.ci95Inflated, groups: grp, chi2: fit.chi2, at: _nowISO() }, gridN: null };
            logEntry(T, 'lk.fit', null, preset, o.structural ? 'History match with the structural spread' : 'History match');
            _emit('prism:dfit-model-updated', { kind: 'fit', ok: true });
            _emit('prism:dfit-updated', { what: 'all', source: 'user' });
            _batch('end');
            _refreshUI();
            return fit;
        };
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.drive === 'function') return AI.drive(job, { shouldCancel: function () { return me.cancelled; } }).then(finish, function () { if (_lkJob === me) _lkJob = null; return null; });
        try { return finish(_runJobSync(job, function () { return me.cancelled; })); } catch (e) { _lkJob = null; return null; }
    }

    // =========================================================================
    // SECTION 13 — OVERRIDE DIALOG, METHOD NOTES, EXPORTS, HAND-OFF
    // =========================================================================
    var _ovItem = 'closure';
    function openOverride(item) {
        if (!HAS_DOC) return null;
        _ovItem = (item === 'isip') ? 'isip' : 'closure';
        _closeOverride();
        var run = _run(), cur = _ovItem === 'isip' ? (run && run.isip && run.isip.value) : _closureP(results());
        var dlg = document.createElement('dialog');
        dlg.id = 'prism_dfit_override';
        dlg.className = 'rp-skip';
        dlg.setAttribute('data-rp-nosnap', '');
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-modal', 'true');
        dlg.setAttribute('aria-labelledby', 'prism_dfit_override_title');
        dlg.innerHTML = '<div class="prism-dfit-dlg"><h3 id="prism_dfit_override_title">' + (_ovItem === 'isip' ? 'Use another ISIP' : 'Use another closure') + '</h3>' +
            '<div class="fg-item"><label for="prism_dfit_ov_value">Value (psia)</label><input type="text" inputmode="decimal" id="prism_dfit_ov_value" value="' + _esc(_isNum(cur) ? Math.round(cur) : '') + '"></div>' +
            (_ovItem === 'closure' ? '<div class="fg-item"><label for="prism_dfit_ov_family">Family</label><select id="prism_dfit_ov_family"><option value="user">User</option><option value="F1">F1</option><option value="F2">F2</option><option value="F4">F4</option></select></div>' : '') +
            '<div class="fg-item"><label for="prism_dfit_ov_reason">Reason (required)</label><textarea id="prism_dfit_ov_reason" rows="2" maxlength="299"></textarea></div>' +
            '<div id="prism_dfit_ov_msg" class="prism-dfit-warn" style="display:none"></div>' +
            '<div class="prism-dfit-bar">' + _btn('prism_dfit_ov_save', 'Save', 'overrideSave', 'btn-primary') + _btn('prism_dfit_ov_close', 'Cancel', 'overrideClose') + '</div></div>';
        var host = _byId('pgBody') || document.body;
        host.appendChild(dlg);
        dlg.addEventListener('click', _onAction);
        dlg.addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.key === 'Esc') { if (e.preventDefault) e.preventDefault(); _closeOverride(); } });
        dlg.addEventListener('cancel', function (e) { if (e.preventDefault) e.preventDefault(); _closeOverride(); });
        var modal = false;
        if (typeof dlg.showModal === 'function') { try { dlg.showModal(); modal = true; } catch (e) { modal = false; } }
        if (!modal) dlg.setAttribute('open', '');
        return dlg;
    }
    function _closeOverride() { var d = _byId('prism_dfit_override'); if (d) { try { if (d.open && d.close) d.close(); } catch (e) { /* ignore */ } if (d.parentNode) d.parentNode.removeChild(d); } }
    function _saveOverride() {
        var v = _byId('prism_dfit_ov_value'), r = _byId('prism_dfit_ov_reason'), fsel = _byId('prism_dfit_ov_family'), msg = _byId('prism_dfit_ov_msg');
        var p = v ? _parse(v.value) : NaN, reason = r ? _txt(r.value).trim() : '';
        var bad = !(_isNum(p) && p > 0 && p < 1e5) ? 'Enter a pressure in psia.' : (!reason ? 'A reason is required.' : '');
        if (bad) { if (msg) { msg.style.display = ''; msg.textContent = '⚠ ' + bad; } return false; }
        var res;
        if (_ovItem === 'isip') res = setPick('isip', { value: p, method: 'user' }, { source: 'user', reason: reason });
        else {
            var fam = fsel ? fsel.value : 'user';
            var d = _run() && _run().derivs;
            res = setPick('closure', { mode: 'user', family: fam === 'user' ? null : fam, method: 'user', p: p, dt: d ? _interp(d.p, d.dt, p) : null }, { source: 'user', reason: reason });
        }
        _closeOverride();
        return res && res.ok;
    }
    function notes(key, opener) {
        var I = G.WTS_dfitInfo;
        if (I && typeof I.open === 'function' && !I.open._dfitStub) { var r = I.open(key || 'index', opener || null); if (r) return r; }
        _toast('Method notes are not available in this build.');
        return null;
    }
    function _download(name, text, type) {
        if (!HAS_DOC) return false;
        try {
            var blob = new Blob([text], { type: type || 'text/plain' });
            var url = (G.URL && G.URL.createObjectURL) ? G.URL.createObjectURL(blob) : null;
            if (!url) return false;
            var a = document.createElement('a');
            a.href = url; a.download = name; a.style.display = 'none';
            (document.body || _byId('pgBody')).appendChild(a);
            a.click();
            if (a.parentNode) a.parentNode.removeChild(a);
            return true;
        } catch (e) { return false; }
    }
    function _exportText() {
        var run = _run(), f = _fn('PRiSM_dfit_exportText');
        if (!_need(run, 'Press ▶ Analyse before exporting the DFIT data and picks.')) return null;
        if (!_need(f, 'The DFIT export is not available in this build yet.')) return null;
        var r = null; try { r = f(run, 'default'); } catch (e) { r = null; }
        if (!_need(r && typeof r.text === 'string', 'The DFIT export failed.')) return null;
        _download(r.filename || 'dfit.txt', r.text, 'text/plain');
        return r;
    }
    function _exportSheet() {
        var run = _run(), f = _fn('PRiSM_dfit_fracSheet');
        if (!_need(run, 'Press ▶ Analyse before exporting the frac-design sheet.')) return null;
        if (!_need(f, 'The frac-design sheet is not available in this build yet.')) return null;
        var r = null; try { r = f(run); } catch (e) { r = null; }
        if (!_need(r && typeof r.csv === 'string', 'The frac-design sheet failed.')) return null;
        _download('dfit-frac-design.csv', r.csv, 'text/csv');
        return r;
    }
    function applyHandoff(target, o) {
        o = o || {};
        var run = _run(), f = _fn('PRiSM_dfit_handoff');
        if (!run) return { ok: false, code: 'NO_RUN', errors: ['Press ▶ Analyse before the hand-off.'], bad: [] };
        if (!f) { _toast('The hand-off is not available in this build yet.'); return { ok: false, code: 'NO_ENGINE', errors: ['No hand-off engine.'], bad: [] }; }
        var pk = null;
        try { pk = f(run, target || 'pta', { family: o.family || null }); } catch (e) { pk = null; }
        if (!pk || pk.ok === false) return { ok: false, code: 'HANDOFF_FAILED', errors: ['The hand-off packet could not be built.'], bad: [] };
        if ((target || 'pta') !== 'pta') return { ok: true, packet: pk };
        var lines = [];
        if (pk.setWell) Object.keys(pk.setWell).forEach(function (k) { lines.push(k + ' = ' + (_isNum(pk.setWell[k]) ? _f(pk.setWell[k], 4) : pk.setWell[k])); });
        lines.push('model ' + pk.model);
        if (pk.blockers && pk.blockers.length) lines.push(pk.blockers.join(' '));
        var ok = (o.confirm === false || typeof G.confirm !== 'function') ? true : G.confirm('Open this DFIT in PTA (transient)?\n' + lines.join('\n'));
        if (!ok) return { ok: false, code: 'DECLINED', errors: ['Declined.'], bad: [] };
        var T = test();
        _batch('begin');
        try {
            if (pk.setWell && typeof G.PRiSM_setWell === 'function') G.PRiSM_setWell(pk.setWell, { source: 'dfit' });
            if (_arr(pk.multiRate) && pk.multiRate.length) { _P().multiRate = pk.multiRate.map(function (r) { return { t: r.t, q: r.q }; }); var ls = _ls(); if (ls) { try { ls.setItem('wts_prism_mrate', JSON.stringify(_P().multiRate)); } catch (e) { /* quota */ } } }
            if (pk.model && typeof G.PRiSM_setModel === 'function') { try { G.PRiSM_setModel(pk.model); } catch (e) { /* ignore */ } }
            var st = _st();
            if (pk.seeds) { st.phys = _isObj(st.phys) ? st.phys : {}; if (_isNum(pk.seeds.xf)) st.phys.xf = pk.seeds.xf; if (_isNum(pk.seeds.k)) st.phys.k = pk.seeds.k; }
            logEntry(T, 'handoff.pta', null, pk.model, 'Opened in PTA' + (o.family ? ' (' + o.family + ' chain)' : ''));
            if (G.PRiSM && typeof G.PRiSM.setMode === 'function') G.PRiSM.setMode('transient');
            if (typeof G.PRiSM_gotoStep === 'function') { try { G.PRiSM_gotoStep(3); } catch (e) { /* ignore */ } }
        } finally { _batch('end'); }
        return { ok: true, packet: pk };
    }

    // =========================================================================
    // SECTION 14 — RAIL (§7.8), STATUS TICKS, REPORT (§2.10), TOOLS (§7.7)
    // =========================================================================
    function railRows() {
        var d = dstate(), T = test(), s = T.summary, run = _run(), z = _num(T.inputs.datumTvd), rows = [];
        if (d.tests.length > 1) rows.push(['Test', T.id + (T.zone ? ' · ' + T.zone : '') + ' (' + d.tests.length + ' tests)']);
        if (!s) { rows.push(['DFIT', _hasData(G.PRiSM_dataset) ? 'press ▶ Analyse' : 'load a DFIT']); return rows; }
        var c = s.closure || {};
        rows.push(['ISIP', s.isip ? _f(s.isip.value, 0) + ' ± ' + _f(s.isip.spread, 0) + ' psia' : '—']);
        var ctext = c.mode === 'single' ? _f(c.value, 0) + ' psia (' + (c.label || '—') + ')' :
                    (c.mode === 'range' ? _f(c.lo, 0) + '–' + _f(c.hi, 0) + ' psia (' + (c.label || '—') + '; medians ' + [c.families && c.families.F1, c.families && c.families.F2].filter(function (x) { return x && _isNum(x.p50); }).map(function (x) { return _f(x.p50, 0); }).join(' / ') + ')' : 'not reached');
        var cp = T.picks.closure;
        if (cp && cp.source === 'user') ctext += ' · user override';
        if (_st()._dfitWhatIf) ctext += ' · what-if';
        rows.push(['Closure', ctext]);
        var g = _grad(_closureP(s), T);
        rows.push(['Closure gradient', _isNum(g) ? _f(g, 3) + ' psi/ft (' + _f(g / 0.052, 2) + ' ppg)' : (z ? '—' : 'enter the datum TVD')]);
        rows.push(['Net pressure', _isNum(s.pn) ? _f(s.pn, 0) + ' psi' : '—']);
        rows.push(['Efficiency η', _isNum(s.eta) ? _f(s.eta, 3) : '—']);
        rows.push(['Γ / CL', (_isNum(s.Gamma) ? _f(s.Gamma, 2) + ' psi/√min' : '—') + ' / ' + (_isNum(s.CL) ? _sig(s.CL, 3) + ' ft/√min (conditional)' : '—')]);
        rows.push([s.model === 'radial' ? 'R' : 'xf', _isNum(s.xf) ? _f(s.xf, 1) + ' ft (' + (s.model || '—') + ')' : (_isNum(s.R) ? _f(s.R, 1) + ' ft (radial)' : '—')]);
        rows.push(['p_i', s.pi && _isNum(s.pi.value) ? _f(s.pi.value, 0) + ' psia [' + _f(s.pi.lo, 0) + '–' + _f(s.pi.hi, 0) + '] (' + (s.pi.label || '—') + ')' : '—']);
        rows.push(['k', _isNum(s.khmu) ? 'kh/μ ' + _sig(s.khmu, 3) + ' md·ft/cp' : (_isNum(s.kLo) && _isNum(s.kHi) ? '[' + _sig(s.kLo, 3) + ', ' + _sig(s.kHi, 3) + '] md' : (_isNum(s.k) ? _sig(s.k, 3) + ' md' : '—'))]);
        rows.push(['Triage / grade', (s.triage || '—') + ' / ' + (s.grade || '—')]);
        var fr = run && run.frac && run.frac.chosen;
        if (fr && fr.stressCal && _isNum(fr.stressCal.dSigmaTect)) rows.push(['Stress-log offset', _f(fr.stressCal.dSigmaTect, 0) + ' psi']);
        if (run && run.fast) rows.push(['Bands', 'stale — ▶ Analyse refreshes them']);
        if (s.stale) rows.push(['Results', 'stale — ▶ Analyse']);
        if (s.forOtherDataset) rows.push(['Decisions', 'belong to another dataset']);
        var H = G.PRiSM_dfit_hooks;
        if (H && typeof H.liveVerdict === 'function') { try { var lv = H.liveVerdict(); if (lv && lv.text) rows.push(['Live', _txt(lv.text)]); } catch (e) { /* 3.4b */ } }
        (H && _arr(H.railRows) ? H.railRows : []).forEach(function (fn) { if (typeof fn !== 'function') return; try { var r = fn(s, run); if (_arr(r) && r.length === 2) rows.push([_txt(r[0]), _txt(r[1])]); } catch (e) { /* 3.4b */ } });
        return rows;
    }
    function rail(el) {
        if (!el) return false;
        var rows = railRows();
        el.innerHTML = '<div id="prism_dfit_rail" class="prism-dfit-rail"><div class="prism-rail-title">DFIT results</div>' + rows.map(function (r) { return _rrow(r[0], r[1]); }).join('') +
                       '<div class="prism-dfit-bar">' + _btn('prism_dfit_rail_analyse', '▶ Analyse', 'analyse', 'btn-primary') + _btn('prism_dfit_rail_copy', 'Copy closure gradient', 'copyGrad') + _btn('prism_dfit_rail_copy_isip', 'Copy ISIP gradient', 'copyIsipGrad') + '</div></div>';
        _wire(el.firstChild || el);
        return true;
    }
    function status(snap) {
        var T = test(), s = T.summary, run = _run();
        var tri = run && run.triage ? run.triage.light : (s && s.triage);
        return { 1: !!(_hasData(G.PRiSM_dataset) && run && run.prep && run.prep.ok !== false && tri !== 'red'),
                 2: !!((run && run.isip && run.isip.ok !== false && _isNum(run.isip.value)) || (T.picks.isip && _isNum(T.picks.isip.value))),
                 3: !!((s && s.closure && s.closure.mode && s.closure.mode !== 'none') || (T.picks.closure && T.picks.closure.source === 'user')),
                 4: !!((run && run.aca && run.aca.ok !== false) || (T.picks.aca && T.picks.aca.closureOnly)), 5: true };
    }
    // Report sections (36): one per DFIT group, fn.modes = ['dfit']; content from run.report (ReportModel, §3.6)
    var SECTIONS = [['dfit-headline', 'DFIT headline', 10], ['dfit-board', 'Closure board', 11], ['dfit-whatif', 'What-if', 12], ['dfit-aca', 'After-closure analysis', 13],
                    ['dfit-classify', 'Leak-off type', 14], ['dfit-triage', 'Triage', 15], ['dfit-steps', 'Step tests', 16], ['dfit-lk', 'Leak-off model', 17],
                    ['dfit-unc', 'Uncertainty', 18], ['dfit-handoff', 'Hand-off and geomechanics', 19], ['dfit-log', 'Pick log and evidence', 20]];
    function _reportModel() {
        var run = _run();
        if (!run) return null;
        if (run.report && _arr(run.report.sections)) return run.report;
        var f = _fn('PRiSM_dfit_reportModel');
        if (f) { try { var m = f(run, dstate().report || {}); if (m && _arr(m.sections)) return m; } catch (e) { /* none */ } }
        return null;
    }
    function _blockCell(c) { if (_isNum(c)) return _f(c, Math.abs(c) < 10 ? 3 : (Math.abs(c) < 1000 ? 1 : 0)); return c == null ? '—' : String(c); }
    function _sectionFn(id, title, order) {
        var fn = function () {
            if (!_inDfit()) return null;
            var d = dstate(), R = d.report || {};
            if (R.groups && R.groups[id] === false) return null;
            var m = _reportModel(), sec = null;
            if (m) for (var i = 0; i < m.sections.length; i++) if (m.sections[i].id === id) sec = m.sections[i];
            if (id === 'dfit-log' && R.log !== false) {
                var T = test(), logBlocks = [];
                if (T.log.length) logBlocks.push({ kind: 'table', head: ['#', 'When', 'Who', 'Item', 'Old', 'New', 'Reason'], rows: T.log.slice(-60).map(function (l) { return [l.seq, l.at, l.who || '—', l.item, JSON.stringify(l.old), JSON.stringify(l.new), l.reason || '—']; }), ev: false });
                if (sec) sec = { id: id, title: sec.title, order: order, blocks: (sec.blocks || []).concat(logBlocks) };
                else if (logBlocks.length) sec = { id: id, title: title, order: order, blocks: logBlocks };
            }
            if (!sec || !_arr(sec.blocks) || !sec.blocks.length) return null;
            var kv = [], table = null, notesOut = [];
            sec.blocks.forEach(function (b) {
                if (b.kind === 'kv' && _arr(b.rows)) b.rows.forEach(function (r) { kv.push([_txt(r[0]), _txt(_blockCell(r[1]))]); });
                else if (b.kind === 'kpi' && _arr(b.items)) b.items.forEach(function (it) { kv.push([_txt(it.label), _txt(_blockCell(it.value))]); });
                else if (b.kind === 'table' && !table && _arr(b.head)) table = { head: b.head.map(_txt), rows: (b.rows || []).map(function (r) { return r.map(function (c) { return _txt(_blockCell(c)); }); }) };
                else if (b.kind === 'verdict' || b.kind === 'notes') notesOut.push(_txt(b.text));
            });
            return { id: id, title: _txt(sec.title || title), order: order, kv: kv, table: table, notes: notesOut, blocks: _clone(sec.blocks) };
        };
        fn.modes = ['dfit'];
        fn._prismId = id;
        return fn;
    }
    var SECTION_FNS = SECTIONS.map(function (s) { return _sectionFn(s[0], s[1], s[2]); });
    function reportHeader(model) {
        var m = _reportModel(), T = test();
        var well = (G.WTS_wells && typeof G.WTS_wells.list === 'function') ? (function () {
            try { var L = G.WTS_wells.list() || []; for (var i = 0; i < L.length; i++) if (L[i] && L[i].active) return L[i].name; } catch (e) { /* no wells */ }
            return null;
        })() : null;
        var title = 'DFIT interpretation — ' + (well || 'well') + (T.zone ? ' · ' + T.zone : '');
        var rows = railRows().filter(function (r) { return r[0] !== 'Bands' && r[0] !== 'Test'; });
        return { title: _txt(title), keyRows: rows.map(function (r) { return [_txt(r[0]), _txt(r[1])]; }), keyLine: keyLine() || (m ? _txt(m.keyLine) : '') };
    }
    function keyLine() {
        var s = results();
        if (!s || !s.closure) return '';
        var c = s.closure, out = 'DFIT';
        if (c.mode === 'single') out += ' · closure ' + _f(c.value, 0) + ' psia (single, ' + (c.label || '—') + ')';
        else if (c.mode === 'range') out += ' · closure range ' + _f(c.lo, 0) + '–' + _f(c.hi, 0) + ' psia (medians ' + [c.families && c.families.F2, c.families && c.families.F1].filter(function (x) { return x && _isNum(x.p50); }).map(function (x) { return _f(x.p50, 0); }).join(' / ') + '; ' + (c.label || '—') + ')';
        else out += ' · no closure yet';
        if (s.pi && _isNum(s.pi.value)) out += ' · p_i ' + _f(s.pi.value, 0) + ' ±' + _f(_isNum(s.pi.hi) && _isNum(s.pi.lo) ? (s.pi.hi - s.pi.lo) / 2 : null, 0) + ' psia';
        return _txt(out);
    }
    var REPORT_PLOTS = [{ key: 'dfitHistory', title: 'DFIT history' }, { key: 'dfitG', title: 'G-function plot' }, { key: 'dfitSqrt', title: 'Square-root of time' },
                        { key: 'dfitLogLog', title: 'Log-log diagnostic' }, { key: 'dfitStrip', title: 'Closure strip' }, { key: 'dfitAcaLogLog', title: 'After-closure log-log' },
                        { key: 'dfitPiTraj', title: 'p_i trajectory' }];
    function reportPlots() {
        var out = REPORT_PLOTS.slice(), T = test();
        if (T.lk && T.lk.fit && _st()._dfitLk) out.push({ key: 'dfitLkP', title: 'Leak-off model' });
        if (dstate().tests.length >= 2) out.push({ key: 'dfitStress', title: 'Gradients against depth' });
        return out;
    }
    // Tools drawer (§7.7)
    function _toolHost(host, id, html) { if (!host) return null; host.innerHTML = '<div id="' + id + '" class="prism-dfit-tool">' + html + '</div>'; var h = host.firstChild; _wire(h); return h; }
    function renderDesignerTool(host) {
        var pl = dstate().plan;
        var h = _toolHost(host, 'prism_dfit_designer', '<div class="card"><div class="card-title">DFIT designer (pre-job)</div>' +
            _note('Plans the injection volume, rate, shut-in duration and gauge from ranges of the reservoir and rock properties (seeded ensemble).') +
            '<div class="fg"><div class="fg-item"><label for="prism_dfit_design_n">Draws</label><input type="text" inputmode="decimal" id="prism_dfit_design_n" value="500"></div>' +
            '<div class="fg-item"><label for="prism_dfit_design_seed">Seed</label><input type="text" inputmode="decimal" id="prism_dfit_design_seed" value="1"></div></div>' +
            '<div class="prism-dfit-bar">' + _btn('prism_dfit_design_go', 'Design', 'design', 'btn-primary') + '</div>' +
            '<div id="prism_dfit_design_out">' + (pl && pl.summary ? _designHTML(pl.summary) : '') + '</div>' + _chart('dfitPlan', 220) + '</div>');
        _drawIn(h);
        return h;
    }
    function _designHTML(D) {
        if (!D || D.ok === false) return '';
        var html = _rbox('Design', [_rrow('Outcome', D.outcome ? D.outcome.label : '—'), _rrow('Closure time P50 (h)', _f(D.tc && D.tc.p50, 1)),
                    _rrow('Shut-in P50 (h)', _f(D.shutIn && D.shutIn.p50, 0) + (D.shutIn ? ' (' + D.shutIn.binding + ')' : '')), _rrow('Minimum volume (bbl)', _f(D.Vmin, 1))]);
        if (D.outcome && D.outcome.text) html += _note(D.outcome.text);
        if (_arr(D.checklist)) html += _table(['#', 'Checklist'], D.checklist.map(function (c) { return [c.id, c.text]; }));
        return html;
    }
    function _design() {
        var f = _fn('PRiSM_dfit_design');
        if (!_need(f, 'The DFIT designer is not available in this build yet.')) return null;
        var n = clampField('designer.n', (_byId('prism_dfit_design_n') || {}).value).value, seed = clampField('designer.seed', (_byId('prism_dfit_design_seed') || {}).value).value;
        var T = test(), w = _well(), ranges = (dstate().plan && dstate().plan.ranges) || null;
        if (!ranges) {
            var k = _num(w.k) || 0.01, z = _num(T.inputs.datumTvd) || 10000;
            ranges = { k: { p10: k / 10, p90: k * 10 }, phi: { p10: 0.04, p90: 0.1 }, ct: { p10: 5e-6, p90: 2e-5 }, muRes: { p10: 0.3, p90: 1 }, h: { p10: 30, p90: 80 },
                       hf: { p10: 40, p90: 100 }, hp: 40, Ep: { p50: 5e6, sdLn: 0.25 }, nu: 0.25, sigmaGrad: { p50: 0.7, sd: 0.02 }, piGrad: { p50: 0.45, sd: 0.02 }, datumTvd: z,
                       strings: T.inputs.strings, fluid: { kind: T.inputs.fluid.kind, rhoPpg: T.inputs.fluid.rhoPpg, muCp: T.inputs.fluid.muCp },
                       gauge: { kind: T.inputs.channels.primary === 'surface' ? 'surface' : 'bh', sigma: 0.05, resolution: 0.01, hz: 1, driftPsiPerDay: 0.1 },
                       V: null, q: null, suggest: true, allowedShutInD: 10, targetW: null, repressurise: false, epsMax: 0.05, leakEps: 0.05 };
        }
        var D = null;
        try { D = f(ranges, { n: n, seed: seed, grid: 'coarse' }); } catch (e) { D = null; }
        if (!_need(D && D.ok !== false, 'The design failed for these ranges.')) return null;
        var c = D.corridor || {};
        var cap = function (a) { return _arr(a) ? a.slice(0, 60) : []; };
        dstate().plan = { ranges: ranges, summary: { ok: true, outcome: D.outcome, tc: D.tc, shutIn: D.shutIn, Vmin: D.Vmin, checklist: (D.checklist || []).slice(0, 20) },
                          corridor: { t: cap(c.t), p10: cap(c.p10), p50: cap(c.p50), p90: cap(c.p90) }, ticks: {} };
        _emit('prism:dfit-updated', { what: 'all', source: 'user' });
        var out = _byId('prism_dfit_design_out'); if (out) out.innerHTML = _designHTML(dstate().plan.summary);
        redrawAll();
        return D;
    }
    function renderSandboxTool(host) {
        // switches to DFIT mode (one undo step) and opens step ④ → Leak-off model
        openSandbox();
        if (host) host.innerHTML = '<div id="prism_dfit_sandbox_tool" class="prism-dfit-tool">' + _note('The leak-off sandbox opened in step ④ → Leak-off model.') + '</div>';
        return host ? host.firstChild : null;
    }
    function openSandbox() {
        _s4Tab = 'lk';
        if (hooksReady() && G.PRiSM && typeof G.PRiSM.setMode === 'function') {
            _batch('begin');
            try { if (G.PRiSM.mode !== 'dfit') G.PRiSM.setMode('dfit'); if (typeof G.PRiSM_gotoStep === 'function') G.PRiSM_gotoStep(4); } finally { _batch('end'); }
            if (typeof G.PRiSM_closeTools === 'function') { try { G.PRiSM_closeTools(); } catch (e) { /* ignore */ } }
        }
        var h = _byId('prism_dfit_step4');
        if (h) _renderStep4Into(h);
        return true;
    }
    function renderReplayTool(host) {
        var h = _toolHost(host, 'prism_dfit_replay', '<div class="card"><div class="card-title">Replay a recorded DFIT</div>' +
            _note('Replays the loaded record as if it were arriving live and lists when each answer first became available.') +
            '<div class="prism-dfit-bar">' + _btn('prism_dfit_replay_go', 'Replay', 'replay', 'btn-primary') + '</div><div id="prism_dfit_replay_out"></div></div>');
        return h;
    }
    function _replay() {
        var f = _fn('PRiSM_dfit_replay'), ds = G.PRiSM_dataset;
        if (!_need(_hasData(ds), 'Load a DFIT first.')) return null;
        if (!_need(f, 'The replay is not available in this build yet.')) return null;
        var T = test(), r = null;
        try { r = f(ds, { test: T, inputs: T.inputs, well: _well() }); } catch (e) { r = null; }
        if (!_need(r && r.firsts, 'The replay failed.')) return null;
        var F = r.firsts, lab = { closureProvisional: 'Provisional closure', closureConfirmed: 'Confirmed closure', piW25: 'p_i bracket within 25 psi', piW10: 'p_i bracket within 10 psi', radialSeen: 'Radial flow seen' };
        var out = _byId('prism_dfit_replay_out');
        if (out) out.innerHTML = _table(['Answer', 'First available (h after shut-in)'], Object.keys(lab).map(function (k) { return [lab[k], _isNum(F[k]) ? _f(F[k], 2) : 'not reached']; }), 'prism_dfit_replay_tbl');
        return r;
    }
    function renderHammerTool(host) {
        var run = _run();
        var h = _toolHost(host, 'prism_dfit_hammer', '<div class="card"><div class="card-title">Water hammer (detail)</div>' +
            _hammerHTML(run, true) + '</div>');
        _drawIn(h);
        return h;
    }
    function renderNotesTool(host) {
        var I = G.WTS_dfitInfo, c = (I && typeof I.content === 'function') ? I.content('index') : null;
        var html = '<div class="card"><div class="card-title">DFIT method notes</div>';
        if (c && c.index) c.index.forEach(function (g) {
            html += '<div class="prism-dfit-sub">' + _esc(g.title) + '</div><div class="prism-dfit-bar">' + g.items.map(function (it) {
                return '<button type="button" class="btn btn-secondary" data-dfit-act="note" data-dfit-arg="' + _esc(it.key) + '">' + _esc(it.title) + '</button>';
            }).join('') + '</div>';
        });
        else html += _note('Method notes are not available in this build.');
        return _toolHost(host, 'prism_dfit_notes', html + '</div>');
    }
    var TOOLS = [
        { id: 'dfit-sandbox', fn: 'PRiSM_renderDfitSandboxTool', group: 'DFIT', title: 'Leak-off sandbox', sub: 'Mini-model: what leak-off rate does this fracture give?', modes: '*' },
        { id: 'dfit-designer', fn: 'PRiSM_renderDfitDesignerTool', group: 'DFIT', title: 'DFIT designer (pre-job)', sub: 'Volume, rate, shut-in and gauge from ranges', modes: ['dfit'] },
        { id: 'dfit-replay', fn: 'PRiSM_renderDfitReplayTool', group: 'DFIT', title: 'Replay a recorded DFIT', sub: 'When each answer first became available', modes: ['dfit'] },
        { id: 'dfit-hammer', fn: 'PRiSM_renderDfitHammerTool', group: 'DFIT', title: 'Water hammer (detail)', sub: 'Period, damping, reflector depth', modes: ['dfit'] },
        { id: 'dfit-notes', fn: 'PRiSM_renderDfitNotesTool', group: 'DFIT', title: 'Method notes', sub: 'Assumptions, failure modes, references', modes: ['dfit'] }
    ];
    var TOOL_FNS = { PRiSM_renderDfitSandboxTool: renderSandboxTool, PRiSM_renderDfitDesignerTool: renderDesignerTool, PRiSM_renderDfitReplayTool: renderReplayTool,
                     PRiSM_renderDfitHammerTool: renderHammerTool, PRiSM_renderDfitNotesTool: renderNotesTool };

    // =========================================================================
    // SECTION 15 — REFRESH, CSS
    // =========================================================================
    var CSS_ID = 'prism-dfit-css';
    var CSS = '.prism-dfit-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}' +
        '.prism-dfit-status{font-size:12px;color:var(--text2)}.prism-dfit-status--ok{color:var(--green)}.prism-dfit-status--warn{color:var(--yellow)}' +
        '.prism-dfit-progress{font-size:12px;color:var(--accent)}' +
        '.prism-dfit-warn{margin:6px 0;padding:6px 8px;border-left:3px solid var(--yellow);background:rgba(210,153,34,.08);font-size:12.5px}' +
        '.prism-dfit-note{margin:6px 0;font-size:12.5px;color:var(--text2)}' +
        '.prism-dfit-sub{margin:10px 0 4px;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3)}' +
        '.prism-dfit-verdict{margin:6px 0;padding:6px 8px;border-radius:6px;font-size:13px;background:var(--bg3)}' +
        '.prism-dfit-verdict--ok{border-left:3px solid var(--green)}.prism-dfit-verdict--warn{border-left:3px solid var(--yellow)}.prism-dfit-verdict--bad{border-left:3px solid var(--red)}' +
        '.prism-dfit-checks{display:flex;flex-wrap:wrap;gap:4px 14px;margin:6px 0}.prism-dfit-check{font-size:12.5px}' +
        '.prism-dfit-seg{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}' +
        '.prism-dfit-chart{margin:8px 0}.prism-dfit-chart canvas{display:block;width:100%}' +
        '.dtable-wrap{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}' +
        '#prism_dfit_override{position:fixed;inset:0;z-index:10050;display:none;align-items:center;justify-content:center;box-sizing:border-box;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:16px;border:0;background:rgba(1,4,9,.72);color:var(--text)}' +
        '#prism_dfit_override[open]{display:flex}#prism_dfit_override::backdrop{background:transparent}' +
        '#prism_dfit_override .prism-dfit-dlg{width:min(480px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow-y:auto;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px 16px}' +
        '#prism_dfit_override h3{margin:0 0 8px;font-size:16px;color:var(--accent)}#prism_dfit_override textarea{width:100%;box-sizing:border-box}' +
        '@media (max-width:600px){#prism_dfit_cv_dfitStrip{height:160px!important}.prism-dfit-chart canvas{height:auto;aspect-ratio:4/3}.prism-dfit-seg .btn{flex:1 1 45%}}';
    function _ensureCss() {
        if (!HAS_DOC || _byId(CSS_ID)) return;
        try {
            var s = document.createElement('style');
            s.id = CSS_ID;
            s.textContent = CSS;
            (document.head || document.body).appendChild(s);
        } catch (e) { /* styles are a nicety */ }
    }
    var _refreshing = false;
    function _refreshUI() {
        if (!HAS_DOC || _refreshing) return;
        _refreshing = true;
        try {
            _ensureCss();
            _rerenderPanels();
            var h2 = _byId('prism_dfit_step2'); if (h2 && h2.isConnected !== false) _renderStep2Into(h2);
            var h4 = _byId('prism_dfit_step4'); if (h4 && h4.isConnected !== false) _renderStep4Into(h4);
            var r = _byId('prism_dfit_rail'); if (r && r.parentNode && r.isConnected !== false) rail(r.parentNode);
            var st = _st();
            if (hooksReady() && _inDfit() && st.activePlot && PLOT_ENTRIES[st.activePlot] && typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
        } finally { _refreshing = false; }
    }

    // =========================================================================
    // SECTION 16 — MODE EXTENSION (§3.8, §3.12), UNDO EXTRA, EVENTS
    // =========================================================================
    function onEnter(prev) {
        _batch('begin');
        try {
            var w = _well();
            if (w.testType !== 'falloff' && typeof G.PRiSM_setWell === 'function') { try { G.PRiSM_setWell({ testType: 'falloff' }, { source: 'dfit' }); } catch (e) { /* ignore */ } }
            dstate();
            var st = _st();
            if (!st.activePlot || !PLOT_ENTRIES[st.activePlot]) st.activePlot = 'dfitG';
            var b = _checkBinding();
            if (b !== 'none' && b !== 'other') runFast('enter');
            if (!_run() && typeof G.PRiSM_dfit_pipeline === 'function') { /* no result yet: the rail asks for ▶ Analyse */ }
        } finally { _batch('end'); }
        _ensureCss();
        return prev;
    }
    function onLeave(next) { cancelAnalyse(); if (_lkJob) _lkJob.cancelled = true; _closeOverride(); return next; }
    var EXT = {
        label: 'DFIT (fracture injection)', testType: 'falloff',
        steps: { 1: 'Data & events', 2: 'ISIP & friction', 3: 'Pre-closure', 4: 'After-closure & model', 5: 'Report' },
        tabs: { 1: 1, 3: 2, 5: 7 },
        stepView: { 2: function (host) { return G.PRiSM_dfit_renderStep2(host); }, 4: function (host) { return G.PRiSM_dfit_renderStep4(host); } },
        defaultPlot: 'dfitG',
        showsPlot: function (entry, key) { return !!(entry && entry.mode === 'dfit' && STEP3_PLOTS.indexOf(key) !== -1); },
        showsModel: function () { return false; },
        showsPanel: function (n, spec) {
            if (!spec) return false;
            if (spec.modes && (spec.modes instanceof Array || _arr(spec.modes))) return Array.prototype.indexOf.call(spec.modes, 'dfit') !== -1;
            return EXT.panelAllow.indexOf(String(spec.id)) !== -1;
        },
        panelAllow: ['crop', 'gauges', 'linetools'],
        plotsTab: { hide: ['period', 'timeFn', 'overlay'] },
        note: 'DFIT is field-unit only (psia, psi/ft, ft, bbl, bbl/min, cp, md).',
        rail: function (el) { return rail(el); },
        status: function (snap) { return status(snap); },
        analyse: function (opts) { return G.PRiSM_dfit_analyse(opts); },
        onEnter: onEnter, onLeave: onLeave,
        reportHeader: reportHeader,
        reportPlots: REPORT_PLOTS,
        reportLegacySections: false,
        exportItems: [{ id: 'dfit-text', label: 'DFIT data + picks (ASCII)', fn: function () { return _exportText(); } },
                      { id: 'dfit-sheet', label: 'Frac-design sheet (CSV)', fn: function () { return _exportSheet(); } }]
    };
    // reportPlots is read as a property: keep it current (two-test and leak-off-model plots)
    try { Object.defineProperty(EXT, 'reportPlots', { enumerable: true, configurable: true, get: reportPlots }); } catch (e) { EXT.reportPlots = REPORT_PLOTS; }
    var UNDO_EXTRA = {
        get: function () {
            var d = dstate(), T = test();
            return { active: d.active, test: { id: T.id, inputs: _clone(T.inputs), picks: _clone(T.picks) } };
        },
        set: function (v) {
            if (!_isObj(v) || !_isObj(v.test)) return;
            var d = dstate();
            var T = _findTest(v.test.id);
            if (!T) return;
            if (typeof v.active === 'string' && _findTest(v.active)) d.active = v.active;
            if (_isObj(v.test.inputs)) T.inputs = _clampInputs(_clone(v.test.inputs));
            if (_isObj(v.test.picks)) T.picks = _clone(v.test.picks);
            if (T.summary) T.summary.stale = true;
            _dropRun();
            var f = G.PRiSM_dfit_pipeline;
            if (typeof f === 'function' && _hasData(G.PRiSM_dataset)) {
                var run = null;
                try { run = f.apply(null, _pipeArgs(true)); } catch (e) { run = null; }
                if (run && run.ok !== false) _apply(run, { fast: true, what: 'all', source: 'undo' });
            } else _emit('prism:dfit-updated', { what: 'all', source: 'undo' });
            _refreshUI();
        },
        events: ['prism:dfit-updated']
    };
    function _onDatasetLoaded() {
        var b = _checkBinding();
        if (b === 'other' || b === 'none') { _dropRun(); _refreshUI(); return; }
        if (_inDfit()) runFast('dataset');
        else _refreshUI();
    }
    function _onProject(e) {
        cancelAnalyse();
        _dropRun();
        delete _st()._dfitLk;
        if (e && e.type === 'wts:project-new') { var st = _st(); delete st.dfit; }
        else { dstate(); _checkBinding(); }
        _publish();
    }
    function _onPage() { var sh = _shell(); if (!sh || sh.isConnected === false) { cancelAnalyse(); if (_lkJob) _lkJob.cancelled = true; } }
    // linked cursor: the hovered x on one DFIT canvas drawn on the other visible DFIT canvases (02's overlay frame)
    // Linked cursor (§7.4): a hover on one shut-in plot draws the same shut-in time on the other DFIT canvases through 02's
    // overlay frame (no redraw). x ↔ Δt (h): dfitG nearest G, dfitSqrt √(Δt·60), dfitLogLog Δt·60, dfitHistory t_s + Δt.
    var LINK_KEYS = { dfitG: 1, dfitSqrt: 1, dfitLogLog: 1, dfitHistory: 1 };
    function _dtOfX(key, x, run) {
        var d = run && run.derivs;
        if (!_isNum(x)) return null;
        if (key === 'dfitG') { if (!d || !_arr(d.G)) return null; var i = _nearestIdx(d.G, x); return i < 0 ? null : d.dt[i]; }
        if (key === 'dfitSqrt') return x > 0 ? x * x / 60 : null;
        if (key === 'dfitLogLog') return x > 0 ? x / 60 : null;
        if (key === 'dfitHistory') return (run.events && _isNum(run.events.ts) && x >= run.events.ts) ? x - run.events.ts : null;
        return null;
    }
    function _xOfDt(key, dt, run) {
        var d = run && run.derivs;
        if (!_isNum(dt)) return null;
        if (key === 'dfitG') { if (!d || !_arr(d.dt)) return null; var i = _nearestIdx(d.dt, dt); return i < 0 ? null : d.G[i]; }
        if (key === 'dfitSqrt') return Math.sqrt(dt * 60);
        if (key === 'dfitLogLog') return dt > 0 ? dt * 60 : null;
        if (key === 'dfitHistory') return (run.events && _isNum(run.events.ts)) ? run.events.ts + dt : null;
        return null;
    }
    function _onHover(e) {
        var d = e && e.detail;
        if (!d || !LINK_KEYS[d.plotKey] || typeof G.PRiSM_plot_overlay !== 'function' || !HAS_DOC || !document.querySelectorAll) return;
        var run = _run(), dt = _dtOfX(d.plotKey, d.x, run);
        if (!_isNum(dt)) return;
        Array.prototype.forEach.call(document.querySelectorAll('canvas[data-dfit-plot]'), function (cv) {
            if (cv === e.target || cv.isConnected === false || cv._dfitDrag) return;
            var key = cv.getAttribute('data-dfit-plot');
            if (!LINK_KEYS[key]) return;
            var x = _xOfDt(key, dt, run);
            if (!_isNum(x)) return;
            try { G.PRiSM_plot_overlay(cv, function (ctx, ax) { if (ax && ax.toX) _vline(ctx, ax.plot || { x: 0, y: 0, w: 1, h: 1 }, ax.toX(x), '#c9d1d9', [2, 2], 'Δt ' + _f(dt * 60, 1) + ' min'); }); } catch (err) { /* cosmetic */ }
        });
    }
    // Escape cancels a drag in progress (an armed line tool is cancelled by 11)
    function _onKey(e) {
        if (!e || (e.key !== 'Escape' && e.key !== 'Esc') || !HAS_DOC) return;
        Array.prototype.forEach.call(document.querySelectorAll('canvas[data-dfit-plot]'), function (cv) { if (cv._dfitDrag && cv._dfitDrag.cancel) cv._dfitDrag.cancel(); });
        var mc = _byId('prism_plot_canvas'); if (mc && mc._dfitDrag && mc._dfitDrag.cancel) mc._dfitDrag.cancel();
    }
    var _listening = false;
    function _listen() {
        if (_listening || typeof G.addEventListener !== 'function') return;
        _listening = true;
        G.addEventListener('prism:dataset-loaded', _onDatasetLoaded);
        G.addEventListener('prism:plot-hover', _onHover);
        if (HAS_DOC && typeof document.addEventListener === 'function') {
            document.addEventListener('wts:project-loaded', _onProject);
            document.addEventListener('wts:project-new', _onProject);
            document.addEventListener('h2oil:pagechange', _onPage);
            document.addEventListener('keydown', _onKey);
        }
    }

    // =========================================================================
    // SECTION 17 — REGISTRATION AND EXPORTS
    // =========================================================================
    G.PRiSM_plot_dfitDual = PRiSM_plot_dfitDual;
    G.PRiSM_plot_dfitStrip = PRiSM_plot_dfitStrip;
    G.PRiSM_plot_dfitStack = PRiSM_plot_dfitStack;
    G.PRiSM_dfit_state = function () { return dstate(); };
    G.PRiSM_dfit_test = function () { return test(); };
    G.PRiSM_dfit_selectTest = selectTest;
    G.PRiSM_dfit_addTest = addTest;
    G.PRiSM_dfit_deleteTest = deleteTest;
    G.PRiSM_dfit_setPick = setPick;
    G.PRiSM_dfit_applyHandoff = applyHandoff;
    G.PRiSM_dfit_results = results;
    G.PRiSM_dfit_analyse = analyse;
    G.PRiSM_dfit_renderStep2 = renderStep2;
    G.PRiSM_dfit_renderStep4 = renderStep4;
    var H = G.PRiSM_dfit_hooks = G.PRiSM_dfit_hooks || {};    // read-only hook points for the 3.4b files: merged, never replaced
    if (!('liveVerdict' in H)) H.liveVerdict = null;
    if (!(H.railRows instanceof Array) && !_arr(H.railRows)) H.railRows = [];
    if (!(H.step2Cards instanceof Array) && !_arr(H.step2Cards)) H.step2Cards = [];

    var installed = { modeExt: false, plots: false, panels: false, tools: false, lineTools: false, sections: false, undo: false, hook: false };
    // Register in the shared registries. Items that would leak into the built-in modes before the WPH hooks exist (plot
    // registry entries — 04 shows every entry in combined mode; line tools — 11 stores them; Tools functions — 37 lists
    // every PRiSM_render*Tool under "More") wait for the hooks; install({force:true}) registers them anyway (tests).
    function install(o) {
        o = o || {};
        var ready = hooksReady() || o.force === true;
        var MX = G.PRiSM_modeExt = _isObj(G.PRiSM_modeExt) ? G.PRiSM_modeExt : {};
        MX.dfit = EXT; installed.modeExt = true;
        var UX = G.PRiSM_undoExtras = _isObj(G.PRiSM_undoExtras) ? G.PRiSM_undoExtras : {};
        UX.dfit = UNDO_EXTRA; installed.undo = true;
        _registerPicksHook(); installed.hook = true;
        var reg = G.PRiSM_reportSections = (G.PRiSM_reportSections instanceof Array || _arr(G.PRiSM_reportSections)) ? G.PRiSM_reportSections : [];
        SECTION_FNS.forEach(function (fn) {
            for (var i = 0; i < reg.length; i++) if (reg[i] && reg[i]._prismId === fn._prismId) { reg[i] = fn; return; }
            reg.push(fn);
        });
        installed.sections = true;
        if (typeof G.PRiSM_registerTabPanel === 'function' || _isObj(G.PRiSM_tabPanels)) {
            Object.keys(PANEL_SPECS).forEach(function (id) {
                var s = PANEL_SPECS[id];
                if (typeof G.PRiSM_registerTabPanel === 'function') { try { G.PRiSM_registerTabPanel(s.tab, s); return; } catch (e) { /* fall through */ } }
                var T = G.PRiSM_tabPanels = _isObj(G.PRiSM_tabPanels) ? G.PRiSM_tabPanels : {};
                if (!(T[s.tab] instanceof Array) && !_arr(T[s.tab])) T[s.tab] = [];
                var arr = T[s.tab], j;
                for (j = 0; j < arr.length; j++) if (arr[j] && arr[j].id === s.id) { arr[j] = s; break; }
                if (j === arr.length) arr.push(s);
            });
            installed.panels = true;
        }
        if (!ready) return installed;
        var R = G.PRiSM_PLOT_REGISTRY = _isObj(G.PRiSM_PLOT_REGISTRY) ? G.PRiSM_PLOT_REGISTRY : {};
        Object.keys(PLOT_ENTRIES).forEach(function (k) { R[k] = PLOT_ENTRIES[k]; });
        installed.plots = true;
        if (_isObj(G.PRiSM_analysisKeys)) { Object.keys(LINE_TOOLS).forEach(function (k) { G.PRiSM_analysisKeys[k] = LINE_TOOLS[k]; }); installed.lineTools = true; }
        var cat = G.PRiSM_toolCatalogueExtra = (G.PRiSM_toolCatalogueExtra instanceof Array || _arr(G.PRiSM_toolCatalogueExtra)) ? G.PRiSM_toolCatalogueExtra : [];
        TOOLS.forEach(function (t) {
            G[t.fn] = TOOL_FNS[t.fn];
            for (var i = 0; i < cat.length; i++) if (cat[i] && cat[i].id === t.id) { cat[i] = t; return; }
            cat.push(t);
        });
        installed.tools = true;
        return installed;
    }

    G.PRiSM_dfit_ui = {
        version: '1.0', hooksReady: hooksReady, install: install, installed: installed,
        fields: FIELDS, selects: SELECTS, id: _id, clampField: clampField, setInput: setInput,
        plots: PLOT_ENTRIES, plotKeys: function () { return PLOTS.map(function (p) { return p[0]; }); }, step3Plots: STEP3_PLOTS.slice(),
        buildPlot: buildPlot, drawPlot: drawPlot, redrawAll: redrawAll, picksHook: picksHook,
        panels: PANEL_SPECS, tools: TOOLS, toolFns: TOOL_FNS, lineTools: LINE_TOOLS, sections: SECTION_FNS, sectionIds: SECTIONS.map(function (s) { return s[0]; }),
        ext: EXT, undo: UNDO_EXTRA, railRows: railRows, rail: rail, status: status, keyLine: keyLine, reportHeader: reportHeader,
        runFast: runFast, cancel: cancelAnalyse, loadDemo: loadDemo, demos: DEMOS.map(function (d) { return d[0]; }), rebind: rebind, notes: notes,
        openOverride: openOverride, saveOverride: _saveOverride, closeOverride: _closeOverride, openSandbox: openSandbox,
        lkSimulate: _lkSimulate, lkFit: _lkFit, design: _design, replay: _replay, exportText: _exportText, exportSheet: _exportSheet,
        publish: _publish, schedule: _schedule, storeHf: _storeHf, dsHash: dsHash, refresh: _refreshUI, css: function () { return CSS; }, s4Tabs: S4_TABS.map(function (t) { return t[0]; }),
        statusText: function () { return _status.text; },
        handles: _handles, acaConv: _acaConv, acaWin: _acaWin, setEvent: setEvent, hammer: _hammerOf, dtOfX: _dtOfX, xOfDt: _xOfDt, acaMatch: _acaMatch
    };

    install();
    _listen();
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var U = G.PRiSM_dfit_ui, bad = [];
    if (!U) return;
    if (U.id('datumTvd') !== 'prism_dfit_datum_tvd') bad.push('id');
    if (!G.PRiSM_modeExt || !G.PRiSM_modeExt.dfit || G.PRiSM_modeExt.dfit.label !== 'DFIT (fracture injection)') bad.push('modeExt');
    var s = U.schedule({ events: { ts: 0.1166666667, tp: { veq: 0.0833333333 }, qEq: 5 } });
    if (!s || Math.abs(s[0].q - 7200) > 1e-9 || s[1].q !== 0) bad.push('schedule');
    if (bad.length && typeof console !== 'undefined') console.warn('[59-prism-dfit-ui self-test] ' + bad.join(', '));
})();
