// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in page — Build-up Surveillance (route `buildup`, ids bu_*)
//
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §6 (page UI), §3.11–§3.12, §8 (WP6).
//
//   One scrolling page (no tabs, so reports capture every visible block):
//   data sources, well and fluid, depth and completion, settings, Analyse /
//   Cancel with a progress line, the stale banner, #bu_res (the review's
//   ReportModel rendered as .rbox sections S1–S12 with charts drawn one per
//   yielded unit), a "Questions, sign-off and export" card and three static
//   Notes boxes. One <dialog id="bu_dlg"> holds every action form (overrides,
//   finding decisions, a missed shut-in).
//
//   The page never runs an analysis on its own: opening it renders the stored
//   analysis (wts_buildup_state) and calcBuildup() only re-renders. Analyse runs
//   WTS_buildup.run.analyseAsync through PRiSM_autoInterp.drive with a cancel
//   test that stops on Cancel, navigation (detached #bu_root), a well switch,
//   project Open / New and a newer run (token). A result for another well or
//   token is discarded.
//
// ENGINES (looked up at call time, never captured)
//   WTS_buildup.data (WP2: sniff, parseJob, parseAllocation, resolveZone,
//   fromHistorian, fromPRiSM), WTS_buildup.run (WP2: analyseAsync, inputHash,
//   job), WTS_buildup.review (WP5: evidence, run, report, ask, status, canSign,
//   signoff, aiExport), WTS_buildup.synth (WP4: demo, IN_APP, caseFromSeed,
//   generateJob, score), WTS_buildup.store / .plot (this WP), PRiSM_autoInterp
//   (WP1: drive, compactHistory, canon, hash16), PRiSM_skinCheck (WP7),
//   PRiSM_autoInterpCal (file 55), PRiSM_openExternalBuildup (WP1, Open in PRiSM).
//   A missing engine disables its buttons or shows a ✗ line; the page itself
//   always loads (smoke stub: no document, no WTS_units, no drawLineChart).
//
// PUBLIC
//   window.renderBuildup(body), window.calcBuildup(), WTS_calcRegistry.buildup
//   (hooks.silent: the host restores values without events, hooks.after runs one
//   calc), window.WTS_state.buildup, document event 'wts:buildup-updated'.
//   WTS_buildup.page: calcs(), state(), isRunning(), cancel(), fmt(v, cat, dp),
//   gather() (AnalysisInput, tests), pageHash(input), reportModel(), ranges.
//
// UNIT CATEGORIES added at module load when absent: pressureGradient, wbStorage,
//   pseudoPressure, pressurePerDay, pricePerVolume, gasPI.
// Rules: listeners on #bu_root only (plus guarded module-level document
// listeners that check #bu_root first); timers only through the drive chain;
// every text from storage, files, tags or people is escaped.
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var B = G.WTS_buildup = G.WTS_buildup || {};
    var PG = B.page = B.page || {};

    var PG_KEY = 'buildup';
    var PG_TITLE = 'Build-up Surveillance';
    var PG_SUB = 'Automatic interpretation of every shut-in, skin trend and alerts, with review and sign-off';
    var MODEL_LABEL = { homogeneous: 'Homogeneous', linearBoundary: 'Sealing fault', composite2: 'Radial composite', closedCircle: 'Closed circle' };
    var DETAIL_MISSING = 'Per-test detail and charts are not available on this device (the stored build-ups were not found): the results below come from the per-test summaries. Press Analyse to recompute them (re-import the gauge data first if asked).';

    // ── unit categories (merge-if-absent, so a Metric first paint has them) ──
    (function _cats() {
        var U = G.WTS_units, C = U && U.CATEGORIES;
        if (!C) return;
        function add(k, iu, il, f, mu, ml) {
            if (!C[k]) C[k] = { imperial: { unit: iu, label: il, factor: f, offset: 0 }, metric: { unit: mu, label: ml, factor: 1, offset: 0 } };
        }
        add('pressureGradient', 'psi/ft', 'psi/ft', 22.6206, 'kPa/m', 'kPa/m');
        add('wbStorage', 'bbl/psi', 'bbl/psi', 0.0230592, 'm3/kPa', 'm³/kPa');
        add('pseudoPressure', 'psi2/cp', 'psi²/cp', 47.5377, 'kPa2/mPas', 'kPa²/(mPa·s)');
        add('pressurePerDay', 'psi/d', 'psi/d', 6.894757, 'kPa/d', 'kPa/d');
        add('pricePerVolume', 'per bbl', 'per bbl', 6.28981, 'per m3', 'per m³');
        add('gasPI', 'Mscf/d/psi', 'Mscf/d/psi', 4.10697, 'Sm3/d/kPa', 'Sm³/d/kPa');
        // ct is entered in 10⁻⁶/psi: the host shows Metric inputs to 4 decimals, so 1/kPa values (≈1e-6) would read 0
        add('compressibilityMicro', '1e-6/psi', '10⁻⁶/psi', 1 / 6.894757, '1e-6/kPa', '10⁻⁶/kPa');
    })();

    // ── controls: [default, unit category, lo, hi, kind] ─────────────
    //   phys  validated (blank or out of range blocks Analyse, input-err)
    //   opt   validated when given (blank = not given)
    //   set   clamped on read (blank = default), echoed in S2 "Settings used"
    //   setopt clamped when given (blank = not given)
    var NUM = {
        bu_h: [50, 'length', 1, 2000, 'phys'], bu_rw: [0.3, 'length', 0.1, 2, 'phys'], bu_re: ['', 'length', 1, 1e6, 'opt'],
        bu_phi: [0.15, null, 0.01, 0.5, 'phys'], bu_mu: [1.0, 'viscosity', 0.01, 1000, 'phys'], bu_B: [1.2, null, 0.5, 5, 'phys'],
        bu_ct: [12, 'compressibilityMicro', 0.1, 1000, 'phys'], bu_pb: ['', 'pressure', 14.7, 20000, 'opt'], bu_rs: ['', 'gor', 0, 50000, 'opt'],
        bu_sg: [0.65, null, 0.55, 3, 'phys'], bu_tres: [200, 'temperature', 32, 500, 'phys'], bu_co2: [0, null, 0, 100, 'phys'],
        bu_h2s: [0, null, 0, 100, 'phys'], bu_n2: [0, null, 0, 100, 'phys'], bu_pdew: ['', 'pressure', 14.7, 20000, 'opt'],
        bu_api: ['', null, 10, 90, 'opt'], bu_mo: ['', null, 50, 300, 'opt'], bu_bw: [1.02, null, 0.9, 1.5, 'phys'], bu_muw: [0.5, 'viscosity', 0.05, 5, 'phys'],
        bu_alloc_acc: [5, null, 0.5, 50, 'phys'], bu_drift: [0.01, 'pressurePerDay', 0, 10, 'phys'], bu_patm: [14.696, 'pressureBase', 10, 16, 'phys'],
        bu_dep_g: ['', 'length', 0, 40000, 'phys'], bu_dep_d: ['', 'length', 0, 40000, 'phys'], bu_dep_grad: [0.35, 'pressureGradient', 0.01, 0.6, 'phys'],
        bu_dep_gradf: ['', 'pressureGradient', 0.01, 0.6, 'opt'], bu_cmp_hp: ['', 'length', 0.1, 2000, 'opt'], bu_cmp_htop: [0, 'length', 0, 2000, 'phys'],
        bu_cmp_theta: [0, null, 0, 75, 'phys'], bu_cmp_kvlo: [0.1, null, 0.001, 1, 'phys'], bu_cmp_kvhi: [1, null, 0.001, 1, 'phys'],
        bu_cmp_spf: [4, null, 0.5, 60, 'phys'], bu_cmp_lp: [12, 'lengthSmall', 1, 60, 'phys'], bu_cmp_rp: [0.2, 'lengthSmall', 0.05, 1, 'phys'],
        bu_hist_cumo: ['', 'volume', 0, 1e10, 'opt'], bu_hist_cumg: ['', 'gasVolume', 0, 1e8, 'opt'],
        bu_sr_h: [20, null, 0, 100, 'set'], bu_sr_phi: [10, null, 0, 100, 'set'], bu_sr_ct: [30, null, 0, 100, 'set'], bu_sr_rw: [5, null, 0, 100, 'set'],
        bu_sr_B: [5, null, 0, 100, 'set'], bu_sr_mu: [20, null, 0, 100, 'set'], bu_sr_q: [10, null, 0, 100, 'set'],
        bu_d_win: [5, null, 1, 60, 'set'], bu_d_rise: [5, 'pressure', 0.5, 500, 'set'], bu_d_sig: [10, null, 2, 50, 'set'], bu_d_persist: [30, null, 5, 240, 'set'],
        bu_d_mindur: [2, null, 0.5, 48, 'set'], bu_d_gapn: [5, null, 2, 50, 'set'],
        bu_i_L: [0.1, null, 0.05, 0.3, 'set'], bu_i_band: [10, null, 5, 25, 'set'], bu_i_slope: [0.03, null, 0.01, 0.1, 'set'], bu_i_mincyc: [0.5, null, 0.3, 1, 'set'],
        bu_t_base: [3, null, 1, 5, 'set'], bu_t_delta: [2, null, 0.5, 10, 'set'], bu_t_abs: [5, null, 0, 50, 'set'], bu_t_price: ['', 'pricePerVolume', 0, 1e7, 'setopt'],
        bu_pd_start: [0, null, 0, 23, 'set'], bu_g_tzoff: [0, null, -12, 14, 'set'], bu_pd_tzoff: [0, null, -12, 14, 'set']
    };
    var INT_IDS = { bu_t_base: 1, bu_pd_start: 1, bu_d_gapn: 1 };
    var LABEL = {
        bu_h: 'Net pay h (ft)', bu_rw: 'Wellbore radius rw (ft)', bu_re: 'Drainage radius, blank = lower bound from radius of investigation (ft)',
        bu_phi: 'Porosity (fraction)', bu_mu: 'Viscosity (cp)', bu_B: 'Formation volume factor (res/std)', bu_ct: 'Total compressibility (10⁻⁶/psi)',
        bu_pb: 'Bubble point, blank = not checked (psi)', bu_rs: 'Solution GOR (SCF/STB)', bu_sg: 'Gas specific gravity (air = 1)',
        bu_tres: 'Reservoir temperature (°F)', bu_co2: 'CO2 (mol %)', bu_h2s: 'H2S (mol %)', bu_n2: 'N2 (mol %)', bu_pdew: 'Dew point, blank = none (psi)',
        bu_api: 'Condensate gravity (°API)', bu_mo: 'Condensate molecular weight', bu_bw: 'Water formation volume factor (res/std)', bu_muw: 'Water viscosity (cp)',
        bu_alloc_acc: 'Allocation accuracy (%)', bu_drift: 'Gauge drift (psi/d)', bu_patm: 'Atmospheric pressure (psia)',
        bu_dep_g: 'Gauge depth TVD (ft)', bu_dep_d: 'Datum depth TVD (ft)', bu_dep_grad: 'Static gradient (psi/ft)', bu_dep_gradf: 'Flowing gradient, blank = static (psi/ft)',
        bu_cmp_hp: 'Open interval, blank = net pay (ft)', bu_cmp_htop: 'Top of reservoir to top of interval (ft)', bu_cmp_theta: 'Well deviation (degrees)',
        bu_cmp_kvlo: 'Vertical to horizontal permeability kv/kh, low', bu_cmp_kvhi: 'Vertical to horizontal permeability kv/kh, high', bu_cmp_spf: 'Shots per foot',
        bu_cmp_lp: 'Perforation length (in)', bu_cmp_rp: 'Perforation radius (in)', bu_hist_cumo: 'Cumulative liquid before the data (bbl)',
        bu_hist_cumg: 'Cumulative gas before the data (MMSCF)', bu_sr_h: 'Typical uncertainty of h (%)', bu_sr_phi: 'Typical uncertainty of porosity (%)',
        bu_sr_ct: 'Typical uncertainty of ct (%)', bu_sr_rw: 'Typical uncertainty of rw (%)', bu_sr_B: 'Typical uncertainty of the volume factor (%)',
        bu_sr_mu: 'Typical uncertainty of viscosity (%)', bu_sr_q: 'Typical uncertainty of the rate (%)', bu_d_win: 'Detection window (min)',
        bu_d_rise: 'Minimum rise (psi)', bu_d_sig: 'Rise in noise units (σ)', bu_d_persist: 'Persistence (min)', bu_d_mindur: 'Minimum duration (h)',
        bu_d_gapn: 'Gap (samples)', bu_i_L: 'Bourdet smoothing L (log cycle)', bu_i_band: 'IARF band (%)', bu_i_slope: 'IARF slope tolerance',
        bu_i_mincyc: 'Minimum IARF length (log cycles)', bu_t_base: 'Baseline tests', bu_t_delta: 'Delta skin alert (skin units)',
        bu_t_abs: 'Absolute skin alert (skin units)', bu_t_price: 'Value per unit volume, blank = not shown (per bbl)',
        bu_pd_start: 'Production day starts at (hour)', bu_g_tzoff: 'Gauge fixed offset from UTC (h)', bu_pd_tzoff: 'Production-day fixed offset from UTC (h)'
    };
    var DISPLAY_ONLY = { bu_test_sel: 1, bu_rep_detail: 1, bu_qa_q: 1, bu_ai_deid: 1, bu_ai_free: 1, bu_so_name: 1, bu_so_role: 1, bu_so_ok: 1, bu_eng: 1 };
    // WellInput / gas keys reported in well.defaulted when the field still holds its default and was never edited
    // (only for the fields that apply to the well type).
    var DEFAULTED_KEYS = { h: 'bu_h', phi: 'bu_phi', mu: 'bu_mu', B: 'bu_B', ct: 'bu_ct', rw: 'bu_rw', sg: 'bu_sg', T_F: 'bu_tres', Bw: 'bu_bw', muw: 'bu_muw' };
    var DEFAULTED_NAMES = { h: 'net pay', phi: 'porosity', mu: 'viscosity', B: 'volume factor', ct: 'compressibility', rw: 'wellbore radius',
        sg: 'gas gravity', T_F: 'reservoir temperature', Bw: 'water volume factor', muw: 'water viscosity' };

    // ── small helpers ────────────────────────────────────────────────
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
    function _byId(id) { try { return (typeof document !== 'undefined' && document && document.getElementById) ? document.getElementById(id) : null; } catch (e) { return null; } }
    function _root() { var r = _byId('bu_root'); return (r && r.isConnected !== false) ? r : null; }
    function _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function _each(list, fn) { for (var i = 0; list && i < list.length; i++) fn(list[i], i); }
    function _isM() { var U = G.WTS_units; return !!(U && typeof U.getSystem === 'function' && U.getSystem() === 'metric'); }
    function _cat(c) { var U = G.WTS_units; return !!(c && U && U.CATEGORIES && U.CATEGORIES[c]); }
    function _canonRun(fn) { var U = G.WTS_units; return (U && typeof U.runCanonical === 'function') ? U.runCanonical(fn) : fn(); }
    function _AI() { return G.PRiSM_autoInterp || null; }
    function _store() { return B.store || null; }
    function _wellId() {
        try { var W = G.WTS_wells; var a = W && typeof W.active === 'function' ? W.active() : null; if (a) return String(a); } catch (e) { /* default */ }
        return 'default';
    }
    function _appVer() {
        try { if (typeof G.WTS_appVersion === 'function') { var v = G.WTS_appVersion(); if (v) return String(v); } } catch (e) { /* label */ }
        var l = _byId('appVersionLabel'), m = l ? /v[0-9.]+/.exec(String(l.textContent || '')) : null;
        return m ? m[0] : '';
    }
    function _nowIso() { return new Date().toISOString(); }
    function _nf(v, d) {
        if (!_fin(v)) return '—';
        if (v !== 0 && Math.abs(v) < 1e-3) return Number(v.toPrecision(3)).toExponential().replace(/e\+?/, 'e');
        var dd = _fin(d) ? Math.max(0, Math.min(8, d)) : 2;
        try { return (typeof G.WTS_fmtNum === 'function') ? G.WTS_fmtNum(v, 0, dd) : Number(v).toLocaleString(undefined, { maximumFractionDigits: dd }); }
        catch (e) { return Number(v).toFixed(dd); }
    }
    function _ul(cat) {
        if (!_cat(cat)) return '';
        var C = G.WTS_units.CATEGORIES[cat];
        return _isM() ? C.metric.label : C.imperial.label;
    }
    function _cv(v, cat) {
        if (!_fin(v) || !_cat(cat) || !_isM()) return v;
        try { var f = G.WTS_units.format(v, cat); return _fin(f.value) ? f.value : v; } catch (e) { return v; }
    }
    // Value formatter handed to the review (fmt(v, cat, dp)): converts with the units layer.
    function fmt(v, cat, dp) {
        if (v == null) return '—';
        if (typeof v === 'string') return v;
        if (typeof v === 'boolean') return v ? 'yes' : 'no';
        if (!_fin(v)) return '—';
        var d = _fin(dp) ? dp : 2, val = v, lab = '';
        if (_cat(cat)) {
            var C = G.WTS_units.CATEGORIES[cat];
            if (_isM()) {
                val = _cv(v, cat); lab = C.metric.label;
                if (val !== 0 && Math.abs(val) < Math.pow(10, -d) * 5 && Math.abs(v) >= Math.pow(10, -d) * 5) d = Math.min(8, d + 2);
            } else lab = C.imperial.label;
        }
        return _nf(val, d) + (lab ? ' ' + lab : '');
    }
    function _fmtNoUnit(v, cat, dp) {
        if (v == null || typeof v === 'string') return v == null ? '—' : v;
        if (!_fin(v)) return '—';
        return _nf(_cat(cat) ? _cv(v, cat) : v, _fin(dp) ? dp : 2);
    }
    function _val(id) { var e = _byId(id); return e ? String(e.value == null ? '' : e.value) : ''; }
    function _checked(id) { var e = _byId(id); return !!(e && e.checked); }
    function _parse(s) {
        s = String(s == null ? '' : s).trim();
        if (s === '') return null;
        var n = (typeof G.WTS_parseNumber === 'function') ? G.WTS_parseNumber(s) : parseFloat(s);
        if (!_fin(n)) n = Number(s);
        return _fin(n) ? n : NaN;
    }
    function _setVal(id, v) { var e = _byId(id); if (e && v != null && _fin(v)) e.value = String(Number(Number(v).toPrecision(6))); }
    function _status(id, level, text) {
        var e = _byId(id);
        if (!e) return;
        if (!text) { e.innerHTML = ''; return; }
        var sym = level === 'ok' ? '✓' : level === 'bad' ? '✗' : level === 'warn' ? '⚠' : '';
        var col = level === 'ok' ? 'green' : level === 'bad' ? 'red' : level === 'warn' ? 'yellow' : '';
        e.innerHTML = '<div' + (col ? ' style="color:var(--' + col + ')"' : '') + '>' + (sym ? sym + ' ' : '') + _esc(String(text).slice(0, 290)) + '</div>';
    }
    function _setDisabled(id, off) { var e = _byId(id); if (e) e.disabled = !!off; }
    function _vis(id, on) {
        var e = _byId(id);
        if (!e) return;
        var w = (e.closest && e.closest('.fg-item')) || e;
        if (w && w.style) w.style.display = on ? '' : 'none';
    }
    function _median(a) {
        var b = a.filter(_fin).slice().sort(function (x, y) { return x - y; });
        if (!b.length) return null;
        var m = Math.floor(b.length / 2);
        return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
    }
    function _hash(obj) {
        var A = _AI();
        var s = (A && typeof A.canon === 'function') ? A.canon(obj, 'inputs') : JSON.stringify(obj);
        if (A && typeof A.hash16 === 'function') return A.hash16(s);
        var h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
        return ('0000000' + h.toString(16)).slice(-8);
    }

    // ── state ────────────────────────────────────────────────────────
    var _st = null;          // {analysis, review, signoff, qa, overrides, input, pageHash, zones, lastStatus, uiSel, touched, ovSeq, partial}
    var _mem = { wellId: null, record: null, recordText: null, sniff: null, allocation: null, allocText: null, rateTable: null, rawChecked: false, rawStored: null };
    var _run = null;         // {token, wellId, cancelled}
    var _token = 0, _chartTok = 0, _calcs = 0, _idxCache = null, _lastPub = null, _dlgCtx = null;

    function _freshSt() {
        return { analysis: null, review: null, signoff: null, qa: [], overrides: [], input: null, pageHash: null, zones: { g: '', pd: '' },
            lastStatus: null, uiSel: {}, touched: {}, ovSeq: 0, partial: false, missingTests: false };
    }
    function _freshMem(id) { return { wellId: id || null, record: null, recordText: null, sniff: null, allocation: null, allocText: null, rateTable: null, rawChecked: false, rawStored: null }; }
    function _loadSt() {
        var S = _store(), st = _freshSt(), raw = null;
        try { raw = S && typeof S.loadState === 'function' ? S.loadState() : null; } catch (e) { raw = null; }
        if (raw) {
            ['analysis', 'review', 'signoff', 'input', 'pageHash', 'lastStatus'].forEach(function (k) { if (_own(raw, k)) st[k] = raw[k]; });
            if (Array.isArray(raw.qa)) st.qa = raw.qa.slice(-20);
            if (Array.isArray(raw.overrides)) st.overrides = raw.overrides.slice();
            if (raw.zones && typeof raw.zones === 'object') st.zones = { g: String(raw.zones.g || ''), pd: String(raw.zones.pd || '') };
            if (raw.uiSel && typeof raw.uiSel === 'object') st.uiSel = raw.uiSel;
            if (raw.touched && typeof raw.touched === 'object') st.touched = raw.touched;
            if (_fin(raw.ovSeq)) st.ovSeq = raw.ovSeq;
            if (raw.detailMissing) st.missingTests = true;
            if (raw.overflow) { st.partial = true; st._raw = raw; }
        }
        if (st.analysis && !Array.isArray(st.analysis.tests)) st.analysis = null;
        return st;
    }
    function _ensure() {
        var id = _wellId();
        if (_mem.wellId !== id) { _mem = _freshMem(id); _st = null; }
        if (!_st) _st = _loadSt();
        if (_st.input && !_mem.allocation && _st.input.allocation) _mem.allocation = _st.input.allocation;
        if (_st.input && !_mem.rateTable && _st.input.rateTable) _mem.rateTable = _st.input.rateTable;
        return _st;
    }
    function _save() {
        var S = _store();
        if (!S || !_st || typeof S.saveState !== 'function') return { ok: false };
        if (_st.partial) return { ok: true, deferred: true };   // parked build-ups still loading: never overwrite them with summaries
        var st = { v: 1, appVersion: _appVer(), savedAt: _nowIso(), input: _st.input, analysis: _st.analysis, review: _st.review,
            qa: (_st.qa || []).slice(-20), uiSel: _st.uiSel || {}, signoff: _st.signoff || null, overrides: _st.overrides || [],
            pageHash: _st.pageHash || null, zones: _st.zones || { g: '', pd: '' }, lastStatus: _st.lastStatus || null,
            touched: _st.touched || {}, ovSeq: _st.ovSeq || 0, detailMissing: !!_st.missingTests };
        var r = { ok: false };
        try { r = S.saveState(st, { wellId: _wellId() }); } catch (e) { r = { ok: false }; }
        if (!r.ok) _status('bu_progress', 'warn', 'Device storage is full: this analysis could not be saved on the device. Use File → Save to keep it.');
        // An overflowed state keeps only per-test summaries in localStorage: say so when the parked detail did not reach
        // the browser database (none, private mode, storage full), since it is then missing after a reload.
        var tok = ++_saveTok, wid = _wellId();
        if (r && r.overflowWrite && typeof r.overflowWrite.then === 'function') {
            r.overflowWrite.then(function (w) {
                if (tok !== _saveTok || _wellId() !== wid) return;
                _status('bu_store_note', w && w.ok ? '' : 'warn', w && w.ok ? '' : STORE_NOTE);
            }, function () { if (tok === _saveTok && _wellId() === wid) _status('bu_store_note', 'warn', STORE_NOTE); });
        } else _status('bu_store_note', '', '');
        return r;
    }
    var STORE_NOTE = 'The per-test detail could not be stored in this browser\'s database (not available, private mode or storage full): it will be missing after a reload. Use File → Save to keep it.';
    var _saveTok = 0;
    var AUDIT_FAIL = 'The audit trail could not be saved (device storage full) — nothing was changed. Free space or use File → Save.';
    function _auditStatus() {
        var S = _store();
        try { return (S && S.audit && typeof S.audit.status === 'function') ? S.audit.status() : null; } catch (e) { return null; }
    }
    function _audit(e) {
        var S = _store();
        if (!S || !S.audit || typeof S.audit.append !== 'function') return null;
        var a = _st && _st.analysis;
        var ent = { at: _nowIso(), who: _val('bu_eng'), kind: e.kind, target: e.target == null ? null : e.target, value: e.value === undefined ? null : e.value,
            reason: e.reason || '', appVersion: _appVer(), inputsHash: e.inputsHash || (a ? a.inputHash : null), resultsHash: e.resultsHash || (a ? a.resultHash : null) };
        if (e.who) ent.who = e.who;
        try { return S.audit.append(ent); } catch (x) { return null; }
    }
    function _auditList() {
        var S = _store(), list = [];
        try { list = (S && S.audit) ? S.audit.list() : []; } catch (e) { list = []; }
        var arr = list.slice();
        arr.entries = list;                                       // array and object form in one value
        try { arr.summary = S && S.audit ? S.audit.summary() : null; arr.chainHash = S && S.audit ? S.audit.chainHash() : ''; } catch (e) { arr.summary = null; arr.chainHash = ''; }
        var ast = _auditStatus();                                 // S10 shows an earlier log that could not be read
        arr.lost = ast ? (ast.lost || (ast.state === 'unreadable' ? { key: null } : null)) : null;
        return arr;
    }

    // ── engines ──────────────────────────────────────────────────────
    function _R() { var R = B.review; return (R && typeof R.report === 'function') ? R : null; }
    function _Run() { var R = B.run; return (R && typeof R.analyseAsync === 'function') ? R : null; }
    function _D() { return B.data || null; }
    function _Syn() { var S = B.synth; return (S && typeof S.demo === 'function') ? S : null; }
    function _drive(job, opts) {
        var A = _AI();
        if (A && typeof A.drive === 'function') return A.drive(job, opts || {});
        opts = opts || {};
        return new G.Promise(function (res, rej) {
            function tick() {
                var s;
                try { s = job.step(); } catch (e) { rej(e); return; }
                if (opts.onProgress) { try { opts.onProgress(s.progress, s.label); } catch (e) { /* progress is cosmetic */ } }
                if (s.done) { res(job.result()); return; }
                setTimeout(function () {
                    if (opts.shouldCancel && opts.shouldCancel()) { try { job.cancel(); } catch (e) { /* ignore */ } rej({ code: 'CANCELLED' }); return; }
                    tick();
                }, 0);
            }
            tick();
        });
    }
    function _idx() {
        var a = _st && _st.analysis, R = _R();
        if (!a || !R || typeof R.evidence !== 'function') return null;
        if (_idxCache && _idxCache.a === a) return _idxCache.idx;
        var idx = null;
        try { idx = R.evidence(a); } catch (e) { idx = null; }
        _idxCache = { a: a, idx: idx };
        return idx;
    }
    function _status2() {
        var a = _st && _st.analysis, R = _R();
        if (!a) return null;
        if (R && typeof R.status === 'function' && _st.review) { try { return R.status(a, _st.review, _st.signoff); } catch (e) { /* draft */ } }
        return _st.signoff ? 'SIGNED' : 'DRAFT';
    }

    // ── markup ───────────────────────────────────────────────────────
    function _lab(id, t) { return '<label for="' + id + '">' + _esc(t) + '</label>'; }
    function _fnum(id, attr) {
        var d = NUM[id], v = d ? d[0] : '';
        return '<div class="fg-item">' + _lab(id, LABEL[id] || id) + '<input type="number" id="' + id + '" step="any" value="' + _esc(v) + '"' + (attr || '') + '></div>';
    }
    function _ftxt(id, label, attr, type) {
        return '<div class="fg-item">' + _lab(id, label) + '<input type="' + (type || 'text') + '" id="' + id + '"' + (attr || '') + '></div>';
    }
    function _opts(pairs, sel) {
        return pairs.map(function (p) { return '<option value="' + _esc(p[0]) + '"' + (String(p[0]) === String(sel) ? ' selected' : '') + '>' + _esc(p[1]) + '</option>'; }).join('');
    }
    function _fsel(id, label, pairs, sel, attr) {
        return '<div class="fg-item">' + _lab(id, label) + '<select id="' + id + '"' + (attr || '') + '>' + _opts(pairs, sel) + '</select></div>';
    }
    function _fchk(id, label, on, attr) {
        return '<div class="fg-item bu-chk"><label for="' + id + '"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + (attr || '') + '> ' + _esc(label) + '</label></div>';
    }
    function _btn(id, label, cls, attr) { return '<button type="button" class="btn ' + (cls || 'btn-secondary') + '" id="' + id + '"' + (attr || '') + '>' + _esc(label) + '</button>'; }
    var TZ = [['device', "This device's time zone"], ['utc', 'UTC'], ['fixed', 'Fixed offset from UTC']];
    var CSS = '<style>' +
        '#bu_root .bu-jump{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}' +
        '#bu_root .bu-jump a{font-size:12px;font-weight:600;padding:5px 11px;border-radius:14px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);text-decoration:none}' +
        '#bu_root .bu-jump a:hover,#bu_root .bu-jump a:focus{border-color:var(--accent);color:var(--accent)}' +
        '#bu_root .bu-sub{margin:14px 0 6px;font-size:11.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px}' +
        '#bu_root .bu-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}' +
        '#bu_root .bu-chk label{display:flex;align-items:center;gap:8px;cursor:pointer}' +
        '#bu_root .bu-chk input{width:16px;height:16px;margin:0;flex:none;accent-color:var(--accent)}' +
        '#bu_root .bu-status{margin-top:8px;font-size:12.5px;color:var(--text2);overflow-wrap:anywhere}' +
        '#bu_root .bu-run{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:14px 0 6px}' +
        '#bu_root .bu-run .bu-status{margin-top:0}' +
        '#bu_root .bu-view{max-width:420px;margin:8px 0}' +
        '#bu_root #bu_res.bu-stale{opacity:.55}' +
        '#bu_root .bu-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:6px 0 10px}' +
        '#bu_root .bu-kpis .kpi{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 10px;min-width:0}' +
        '#bu_root .bu-kpis .kpi-l{font-size:11px;color:var(--text3)}#bu_root .bu-kpis .kpi-v{font-size:15px;font-weight:700;color:var(--text);overflow-wrap:anywhere}' +
        '#bu_root .bu-ev{color:var(--text3);font-weight:400;font-size:11px}' +
        '#bu_root .bu-tw{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}' +
        '#bu_root .bu-tw table{min-width:100%}' +
        '#bu_root .bu-act{padding:2px 8px;font-size:11px;margin-left:6px}' +
        '#bu_root td.bu-evc{white-space:nowrap;font-size:11px;color:var(--text3)}#bu_root td.bu-nw{white-space:nowrap}' +
        '#bu_root tr.bu-older td{color:var(--text3);font-style:italic}#bu_root .fg-item.bu-wide{grid-column:1/-1}' +
        '#bu_root .bu-note{margin:8px 0;font-size:12.5px;line-height:1.5;color:var(--text2)}#bu_root .bu-note b{color:var(--text)}' +
        '#bu_root .bu-notes{margin-top:12px;font-size:12.5px;line-height:1.5;color:var(--text2)}#bu_root .bu-notes b{color:var(--text)}' +
        '#bu_root .bu-qa{margin-top:8px;font-size:12.5px;color:var(--text2)}#bu_root .bu-qa .bu-q{color:var(--text);font-weight:600}' +
        '#bu_root canvas{touch-action:pan-y;max-width:100%}' +
        '#bu_root .chart-wrap canvas{width:100%;height:auto}' +
        '#bu_root .bu-dlg{position:fixed;inset:0;z-index:10050;display:none;align-items:center;justify-content:center;box-sizing:border-box;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:16px;border:0;background:rgba(1,4,9,.72);color:var(--text)}' +
        '#bu_root .bu-dlg[open]{display:flex}#bu_root .bu-dlg::backdrop{background:transparent}' +
        '#bu_root .bu-dlg-box{display:flex;flex-direction:column;box-sizing:border-box;width:min(560px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow-y:auto;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
        '#bu_root .bu-dlg-hd{display:flex;align-items:flex-start;gap:12px}#bu_root .bu-dlg-hd h3{flex:1;margin:0;font-size:16px;color:var(--accent)}' +
        '#bu_root .bu-dlg-x{flex:none;width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:var(--text2);font-size:22px;line-height:1;cursor:pointer}' +
        '#bu_root .bu-dlg-bd{margin:8px 0;font-size:13px;color:var(--text2);overflow-wrap:anywhere}' +
        '#bu_root .bu-dlg-ft{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}' +
        '@media (max-width:600px){#bu_root .bu-dlg{padding:8px}#bu_root .bu-dlg-box{width:100%}#bu_root .bu-act{min-height:28px;padding:4px 10px}}' +
        '</style>';
    var NOTES = [
        'Method: every shut-in in the gauge record is found and interpreted automatically on the Bourdet derivative of the superposition-equivalent time (L = 0.1 log cycle). The IARF window is the earliest qualifying plateau after the storage hump; the semilog line and a homogeneous match (rival models only when a trigger fires) give k, S and C with a skin uncertainty and a calibrated confidence label. Skin is then tracked against a baseline with delta and absolute alerts.',
        'Units: inputs and results follow the app unit system; engines work in field units (psia, hours, STB/d, Mscf/d, md, ft, cp, 1/psi). Skin, ΔBIC, log cycles and confidence labels are dimensionless. Times are read in the resolved gauge time zone and production days in the resolved production-day zone, both shown by name.',
        'Limitations: partial rate cuts are classified and listed but not interpreted; deconvolution is not run on this page (Open in PRiSM passes the full history); two-phase near-well skin is flagged, not quantified; with an unknown production start p* is reported as a range and not trended. The automated review checks consistency and plausibility, not the physics model, and the signature checks integrity, not the identity of the signer.'
    ];
    function _markup() {
        var jump = [['bu_card_data', 'Data'], ['bu_card_well', 'Well'], ['bu_card_cmp', 'Depth & completion'], ['bu_card_set', 'Settings'],
            ['bu_s_S4', 'Tests'], ['bu_s_S5', 'Trend'], ['bu_s_S9', 'Review'], ['bu_res', 'Report']];
        var nd = ' data-no-decimal-comma', np = ' data-no-persist';
        return '<div id="bu_root">' + CSS +
            '<nav class="bu-jump rp-skip" aria-label="Jump to a section of this page">' +
            jump.map(function (a) { return '<a href="#' + a[0] + '">' + _esc(a[1]) + '</a>'; }).join('') + '</nav>' +
            '<div class="cols-2">' +
            // ── Data sources ──
            '<div class="card" id="bu_card_data"><div class="card-title">Data sources</div><div class="fg">' +
            _ftxt('bu_eng', 'Engineer', nd + ' maxlength="80" autocomplete="off"') +
            _fsel('bu_src', 'Gauge data source', [['file', 'File (CSV or text)'], ['paste', 'Paste'], ['historian', 'Historian tag'], ['prism', 'Current PRiSM dataset'], ['demo', 'Demo data']], 'file') +
            '<div class="fg-item">' + _lab('bu_g_file', 'Gauge file (.csv, .txt, .xlsx)') + '<input type="file" id="bu_g_file" accept=".csv,.txt,.tsv,.dat,.xlsx,text/csv,text/plain"></div>' +
            '<div class="fg-item">' + _lab('bu_g_paste', 'Paste gauge data') + '<textarea id="bu_g_paste" rows="4"' + np + nd + ' spellcheck="false" placeholder="time, pressure"></textarea></div>' +
            _fsel('bu_h_tag', 'Historian tag', [['', '—']], '', np) +
            _ftxt('bu_h_from', 'Historian data from (gauge time zone)', '', 'datetime-local') +
            _ftxt('bu_h_to', 'Historian data to (gauge time zone)', '', 'datetime-local') +
            _fsel('bu_demo_kind', 'Demo', [['oil', 'Oil producer (9 build-ups, skin rising)'], ['gas', 'Gas producer (two rate levels)']], 'oil') +
            _fsel('bu_g_tfmt', 'Time format', [['auto', 'Detect automatically'], ['iso', 'ISO date and time'], ['dmy', 'Day/month/year'], ['mdy', 'Month/day/year'],
                ['elapsed_h', 'Elapsed hours'], ['elapsed_min', 'Elapsed minutes'], ['elapsed_s', 'Elapsed seconds'], ['serial', 'Spreadsheet serial days']], 'auto') +
            _ftxt('bu_g_t0', 'Start of elapsed time (gauge time zone)', ' value="2026-01-01T00:00"', 'datetime-local') +
            _fsel('bu_g_tz', 'Gauge time zone', TZ, 'device') + _fnum('bu_g_tzoff') +
            _ftxt('bu_g_tzname', 'Gauge time zone (resolved)', ' readonly tabindex="-1" placeholder="set at the first analysis"') +
            _fsel('bu_g_punit', 'Pressure unit in the file', [['psia', 'psia'], ['psig', 'psig'], ['kPa', 'kPa (absolute)'], ['kPag', 'kPa (gauge)'], ['bar', 'bar (absolute)'], ['barg', 'bar (gauge)'], ['MPa', 'MPa (absolute)']], 'psia') +
            _fnum('bu_patm') +
            '</div><div class="bu-btns">' +
            _btn('bu_g_load', 'Load gauge data', 'btn-primary') + _btn('bu_h_load', 'Load from historian') + _btn('bu_p_load', 'Use the current PRiSM dataset') +
            _btn('bu_demo_load', 'Load demo') + _btn('bu_tz_reset', "Use this device's zone") +
            '</div><div id="bu_g_map" class="fg" data-no-persist style="display:none">' +
            ['bu_g_ct', 'bu_g_cp', 'bu_g_cT', 'bu_g_cq'].map(function (id, i) { return _fsel(id, ['Time column', 'Pressure column', 'Temperature column', 'Rate column'][i], [['-1', '—']], '-1'); }).join('') +
            '</div><div id="bu_g_status" class="bu-status" role="status"></div>' +
            '<div class="bu-sub">Rates</div><div class="fg">' +
            _fsel('bu_rate_mode', 'Rate source', [['daily', 'Daily allocation'], ['table', 'Time-stamped rate table']], 'daily') +
            '<div class="fg-item">' + _lab('bu_a_file', 'Allocation file (.csv, .txt)') + '<input type="file" id="bu_a_file" accept=".csv,.txt,.tsv,text/csv,text/plain"></div>' +
            '<div class="fg-item">' + _lab('bu_a_paste', 'Paste daily allocation') + '<textarea id="bu_a_paste" rows="3"' + np + nd + ' spellcheck="false" placeholder="date, oil, gas, water, hours"></textarea></div>' +
            _fsel('bu_a_gunit', 'Gas volume unit', [['Mscf', 'Mscf'], ['MMscf', 'MMscf'], ['Sm3', 'Sm³']], 'Mscf') +
            _fchk('bu_a_dayfirst', 'Dates are day-first', false) + _fchk('bu_a_wcond', 'Water column is condensed water', false) +
            _fnum('bu_pd_start') + _fsel('bu_pd_tz', 'Production-day time zone', TZ, 'device') + _fnum('bu_pd_tzoff') +
            _ftxt('bu_pd_tzname', 'Production-day time zone (resolved)', ' readonly tabindex="-1" placeholder="set at the first analysis"') +
            _fsel('bu_hist_mode', 'History before the data', [['unknown', 'Unknown (estimated, flagged)'], ['date', 'Production start date'], ['cum', 'Cumulative before the data']], 'unknown') +
            _ftxt('bu_hist_date', 'Production start', '', 'date') + _fnum('bu_hist_cumo', ' min="0"') + _fnum('bu_hist_cumg', ' min="0"') +
            '</div><div class="bu-btns">' + _btn('bu_a_load', 'Load allocation') + '</div>' +
            '<div id="bu_a_map" class="fg" data-no-persist style="display:none">' +
            ['bu_a_cd', 'bu_a_co', 'bu_a_cg', 'bu_a_cw', 'bu_a_ch'].map(function (id, i) { return _fsel(id, ['Date column', 'Oil column', 'Gas column', 'Water column', 'Hours column'][i], [['-1', '—']], '-1'); }).join('') +
            '</div><div id="bu_a_status" class="bu-status" role="status"></div></div>' +
            // ── Well, depth and completion ──
            '<div><div class="card" id="bu_card_well"><div class="card-title">Well and fluid</div><div class="fg">' +
            _fsel('bu_fluid', 'Well type', [['oil', 'Oil producer'], ['gas', 'Gas producer'], ['water_inj', 'Water injector']], 'oil') +
            ['bu_h', 'bu_phi', 'bu_mu', 'bu_B', 'bu_ct', 'bu_rw', 'bu_re', 'bu_pb', 'bu_rs', 'bu_sg', 'bu_tres', 'bu_co2', 'bu_h2s', 'bu_n2'].map(function (id) { return _fnum(id); }).join('') +
            _fchk('bu_ptime', 'Use pseudo-time for the build-up', false) +
            ['bu_pdew', 'bu_api', 'bu_mo', 'bu_bw', 'bu_muw', 'bu_alloc_acc', 'bu_drift'].map(function (id) { return _fnum(id); }).join('') +
            '</div><div class="bu-btns">' + _btn('bu_well_prism', 'Copy from PRiSM well inputs') + '</div>' +
            '<div id="bu_defaults_note" class="bu-status"></div><div id="bu_well_status" class="bu-status" role="status"></div></div>' +
            '<div class="card" id="bu_card_cmp"><div class="card-title">Gauge depth &amp; completion (optional)</div><div class="fg">' +
            _fchk('bu_dep_on', 'Depth correction', false) + ['bu_dep_g', 'bu_dep_d', 'bu_dep_grad', 'bu_dep_gradf'].map(function (id) { return _fnum(id); }).join('') +
            _fchk('bu_cmp_on', 'Completion data', false) + ['bu_cmp_hp', 'bu_cmp_htop', 'bu_cmp_theta', 'bu_cmp_kvlo', 'bu_cmp_kvhi'].map(function (id) { return _fnum(id); }).join('') +
            _fchk('bu_cmp_perf', 'Perforation data', false) + ['bu_cmp_spf', 'bu_cmp_lp', 'bu_cmp_rp'].map(function (id) { return _fnum(id); }).join('') +
            _fsel('bu_cmp_phase', 'Perforation phasing (degrees)', [['0', '0'], ['180', '180'], ['120', '120'], ['90', '90'], ['60', '60'], ['45', '45']], '90') +
            _ftxt('bu_wo', 'Workover / stimulation dates (YYYY-MM-DD, …)', nd + ' maxlength="400" placeholder="2026-05-14, 2026-08-02"') +
            '</div><div id="bu_perf_note" class="bu-status"></div></div></div>' +
            '</div>' +
            // ── Settings ──
            '<div class="card" id="bu_card_set"><div class="card-title">Settings</div><div class="fg">' +
            _fchk('bu_adv', 'Show advanced settings', false) +
            _fsel('bu_rep_detail', 'Test detail in the report', [['selected', 'Selected test'], ['all', 'All tests (up to 12)']], 'selected') +
            _fsel('bu_t_enabled', 'Trend and alerts', [['auto', 'Automatic (off for rate tables or tests less than a day apart)'], ['on', 'On'], ['off', 'Off']], 'auto') +
            _fnum('bu_t_delta') + _fnum('bu_t_abs') +
            '</div><div id="bu_adv_box" style="display:none">' +
            '<div class="bu-sub">Detection</div><div class="fg">' +
            ['bu_d_win', 'bu_d_rise', 'bu_d_sig', 'bu_d_persist', 'bu_d_mindur', 'bu_d_gapn'].map(function (id) { return _fnum(id); }).join('') +
            _fsel('bu_d_spike', 'Spikes', [['off', 'Off'], ['flag', 'Flag'], ['filter', 'Filter']], 'off') + _fchk('bu_d_partial', 'Classify partial rate cuts', true) +
            '</div><div class="bu-sub">Interpretation</div><div class="fg">' +
            ['bu_i_L', 'bu_i_band', 'bu_i_slope', 'bu_i_mincyc'].map(function (id) { return _fnum(id); }).join('') +
            _fsel('bu_i_rivals', 'Rival models', [['auto', 'When a trigger fires'], ['none', 'None'], ['all', 'All']], 'auto') +
            _fsel('bu_i_cheld', 'Storage-held refits', [['auto', 'Automatic'], ['off', 'Off'], ['extended', 'Extended']], 'auto') +
            _fsel('bu_i_kheld', 'Permeability-held fits for short tests', [['auto', 'Automatic'], ['off', 'Off']], 'auto') +
            _fsel('bu_i_tide', 'Tide removal', [['auto', 'Automatic'], ['off', 'Off']], 'auto') +
            '</div><div class="bu-sub">Trend</div><div class="fg">' +
            _fnum('bu_t_base') + _fchk('bu_t_basevar', 'Include the baseline uncertainty in the delta alert', false) +
            _fsel('bu_t_confirm', 'Alert confirmation', [['next', 'By the next test'], ['immediate', 'Immediate']], 'next') + _fnum('bu_t_price', ' min="0"') +
            '</div><div class="bu-sub">Typical input uncertainty</div><div class="fg">' +
            ['bu_sr_h', 'bu_sr_phi', 'bu_sr_ct', 'bu_sr_rw', 'bu_sr_B', 'bu_sr_mu', 'bu_sr_q'].map(function (id) { return _fnum(id); }).join('') +
            '</div></div></div>' +
            // ── run row ──
            '<div class="bu-run rp-skip">' + _btn('bu_run', 'Analyse', 'btn-primary') + _btn('bu_cancel', 'Cancel', 'btn-secondary', ' disabled') +
            _btn('bu_ev_add', 'Add a missed shut-in…', 'btn-secondary', ' disabled') +
            '<div id="bu_progress" class="bu-status" role="status" aria-live="polite"></div></div>' +
            '<div id="bu_val"></div>' +
            '<div id="bu_stale" style="color:var(--yellow);display:none">⚠ Inputs changed since the last analysis — press Analyse</div>' +
            '<div id="bu_raw_note" class="bu-status"></div><div id="bu_store_note" class="bu-status rp-skip" role="status"></div><div id="bu_ov_note" class="bu-status rp-skip" role="status"></div>' +
            '<div class="bu-view rp-skip">' + _fsel('bu_test_sel', 'Test shown in detail', [['', 'Latest test']], '') + '</div>' +
            '<div id="bu_res"></div>' +
            // ── questions, sign-off and export ──
            '<div class="card rp-skip" id="bu_card_act"><div class="card-title">Questions, sign-off and export</div><div class="fg">' +
            '<div class="fg-item bu-wide">' + _lab('bu_qa_q', 'Ask about the analysis') + '<input type="text" id="bu_qa_q"' + np + nd + ' maxlength="300" placeholder="Why this model? What if h is 20 % higher?" autocomplete="off"></div>' +
            '</div><div class="bu-btns">' + _btn('bu_qa_go', 'Ask', 'btn-secondary', ' disabled') + '</div><div id="bu_qa_out" class="bu-qa" aria-live="polite"></div>' +
            '<div class="bu-sub">Sign-off</div><div class="fg">' +
            _ftxt('bu_so_name', 'Signed by', nd + ' maxlength="80" autocomplete="off"') + _ftxt('bu_so_role', 'Role', nd + ' maxlength="80" autocomplete="off"') +
            '<div class="fg-item bu-chk" data-no-persist><label for="bu_so_ok"><input type="checkbox" id="bu_so_ok"> I have reviewed the analysis and the findings</label></div>' +
            '</div><div class="bu-btns">' + _btn('bu_so_sign', 'Sign off', 'btn-primary', ' disabled') + _btn('bu_so_unsign', 'Withdraw sign-off', 'btn-secondary', ' disabled') + '</div>' +
            '<div id="bu_so_status" class="bu-status" role="status"></div>' +
            '<div class="bu-sub">Export and checks</div><div class="fg">' +
            // privacy controls are never autosaved (nor carried in project files): every session starts de-identified, no free text
            _fchk('bu_ai_deid', 'De-identify', true, np) + _fchk('bu_ai_free', 'Include free text (notes, reasons, file and tag names)', false, np) +
            '</div><div class="bu-btns">' + _btn('bu_ai_copy', 'Copy for your AI assistant', 'btn-secondary', ' disabled') + _btn('bu_ai_dl', 'Download', 'btn-secondary', ' disabled') +
            _btn('bu_open_prism', 'Open this build-up in PRiSM', 'btn-secondary', ' disabled') + _btn('bu_val_run', 'Re-run 24-case check', 'btn-secondary', ' disabled') + '</div>' +
            '<div id="bu_ai_status" class="bu-status" role="status"></div><div id="bu_val_out" class="bu-status" role="status"></div></div>' +
            NOTES.map(function (n) { return '<div class="bu-notes"><b>Notes</b> ' + _esc(n) + '</div>'; }).join('') +
            // ── dialog ──
            '<dialog id="bu_dlg" class="bu-dlg rp-skip" data-rp-nosnap data-no-persist aria-labelledby="bu_dlg_title" aria-modal="true"><div class="bu-dlg-box">' +
            '<div class="bu-dlg-hd"><h3 id="bu_dlg_title">Actions</h3><button type="button" class="bu-dlg-x" id="bu_dlg_x" aria-label="Close">×</button></div>' +
            '<div id="bu_dlg_body" class="bu-dlg-bd"></div><div class="fg">' +
            _fsel('bu_dlg_act', 'Action', [['', '—']], '') +
            '<div class="fg-item">' + _lab('bu_dlg_t0', 'IARF window start, shut-in time (h)') + '<input type="number" id="bu_dlg_t0" step="any" min="0"></div>' +
            '<div class="fg-item">' + _lab('bu_dlg_t1', 'IARF window end, shut-in time (h)') + '<input type="number" id="bu_dlg_t1" step="any" min="0"></div>' +
            _fsel('bu_dlg_model', 'Model', [['homogeneous', 'Homogeneous'], ['linearBoundary', 'Sealing fault'], ['composite2', 'Radial composite'], ['closedCircle', 'Closed circle']], 'homogeneous') +
            _ftxt('bu_dlg_time', 'Closing time (gauge time zone)', '', 'datetime-local') +
            _ftxt('bu_dlg_reason', 'Reason (at least 5 characters)', nd + ' maxlength="290" autocomplete="off"') +
            '</div><div id="bu_dlg_msg" class="bu-status" role="status"></div>' +
            '<div class="bu-dlg-ft">' + _btn('bu_dlg_cancel', 'Cancel') + _btn('bu_dlg_ok', 'OK', 'btn-primary') + '</div>' +
            '</div></dialog>' +
            '</div>';
    }
    var TAGS = {
        bu_h: 'length', bu_rw: 'length', bu_re: 'length', bu_mu: 'viscosity', bu_ct: 'compressibilityMicro', bu_pb: 'pressure', bu_rs: 'gor',
        bu_tres: 'temperature', bu_pdew: 'pressure', bu_muw: 'viscosity', bu_drift: 'pressurePerDay', bu_patm: 'pressureBase',
        bu_dep_g: 'length', bu_dep_d: 'length', bu_dep_grad: 'pressureGradient', bu_dep_gradf: 'pressureGradient', bu_cmp_hp: 'length',
        bu_cmp_htop: 'length', bu_cmp_lp: 'lengthSmall', bu_cmp_rp: 'lengthSmall', bu_hist_cumo: 'volume', bu_hist_cumg: 'gasVolume',
        bu_d_rise: 'pressure', bu_t_price: 'pricePerVolume'
    };

    // ── visibility and button state ──────────────────────────────────
    function _perfOK() {
        var K = G.PRiSM_skinCheck;
        if (!K || typeof K.perforationSkin !== 'function') return false;
        try { var r = K.perforationSkin({ rw_ft: 0.354, lp_in: 12, rp_in: 0.2, spf: 4, phase_deg: 90, kvkh: 1 }); return !!(r && r.ok !== false && r.verified === true); }
        catch (e) { return false; }
    }
    function _syncUi() {
        if (!_root()) return;
        var src = _val('bu_src'), fl = _val('bu_fluid'), rate = _val('bu_rate_mode'), hist = _val('bu_hist_mode');
        var tf = _val('bu_g_tfmt');
        _vis('bu_g_file', src === 'file'); _vis('bu_g_paste', src === 'paste');
        ['bu_h_tag', 'bu_h_from', 'bu_h_to', 'bu_h_load'].forEach(function (id) { _vis(id, src === 'historian'); });
        _vis('bu_p_load', src === 'prism'); _vis('bu_demo_kind', src === 'demo'); _vis('bu_demo_load', src === 'demo');
        _vis('bu_g_load', src === 'file' || src === 'paste');
        ['bu_g_tfmt', 'bu_g_punit', 'bu_patm'].forEach(function (id) { _vis(id, src === 'file' || src === 'paste'); });
        _vis('bu_g_t0', (src === 'file' || src === 'paste') && (tf === 'auto' || /^elapsed/.test(tf)));
        _vis('bu_g_tzoff', _val('bu_g_tz') === 'fixed'); _vis('bu_pd_tzoff', _val('bu_pd_tz') === 'fixed');
        ['bu_a_file', 'bu_a_paste', 'bu_a_gunit', 'bu_a_dayfirst', 'bu_a_load'].forEach(function (id) { _vis(id, rate === 'daily'); });
        _vis('bu_a_wcond', rate === 'daily' && fl === 'gas');
        _vis('bu_hist_date', hist === 'date'); _vis('bu_hist_cumo', hist === 'cum' && fl !== 'gas'); _vis('bu_hist_cumg', hist === 'cum' && fl === 'gas');
        _vis('bu_pb', fl === 'oil'); _vis('bu_rs', fl === 'oil');
        ['bu_sg', 'bu_tres', 'bu_co2', 'bu_h2s', 'bu_n2', 'bu_ptime', 'bu_pdew', 'bu_api', 'bu_mo'].forEach(function (id) { _vis(id, fl === 'gas'); });
        _vis('bu_bw', fl === 'water_inj'); _vis('bu_muw', fl === 'water_inj');
        var dep = _checked('bu_dep_on'), cmp = _checked('bu_cmp_on'), pok = _perfOK();
        ['bu_dep_g', 'bu_dep_d', 'bu_dep_grad', 'bu_dep_gradf'].forEach(function (id) { _vis(id, dep); });
        ['bu_cmp_hp', 'bu_cmp_htop', 'bu_cmp_theta', 'bu_cmp_kvlo', 'bu_cmp_kvhi'].forEach(function (id) { _vis(id, cmp); });
        _vis('bu_cmp_perf', cmp && pok);
        var perf = cmp && pok && _checked('bu_cmp_perf');
        ['bu_cmp_spf', 'bu_cmp_lp', 'bu_cmp_rp', 'bu_cmp_phase'].forEach(function (id) { _vis(id, perf); });
        var pn = _byId('bu_perf_note');
        if (pn) pn.textContent = (cmp && !pok) ? 'Perforation skin is not split: its coefficient table is not verified, so the decomposition covers partial penetration and deviation only.' : '';
        var adv = _byId('bu_adv_box');
        if (adv && adv.style) adv.style.display = _checked('bu_adv') ? '' : 'none';
        var tn = _byId('bu_rate_mode');
        if (tn) {
            var as = _byId('bu_a_status');
            if (as && rate === 'table' && !as.getAttribute('data-msg')) as.textContent = 'Rate-table mode: rates come from the rate column of the gauge data.';
            else if (as && rate === 'daily' && !as.getAttribute('data-msg')) as.textContent = '';
        }
        _buttons();
    }
    function _buttons() {
        var has = !!(_st && _st.analysis), R = _R(), running = !!_run;
        _setDisabled('bu_cancel', !running);
        _setDisabled('bu_run', running);
        _setDisabled('bu_ev_add', !has || running);
        _setDisabled('bu_qa_go', !has || !R || typeof R.ask !== 'function');
        _setDisabled('bu_so_sign', !has || !R || typeof R.signoff !== 'function' || !!(_st && _st.signoff && _status2() === 'SIGNED'));
        _setDisabled('bu_so_unsign', !(_st && _st.signoff));
        _setDisabled('bu_ai_copy', !has || !R || typeof R.aiExport !== 'function');
        _setDisabled('bu_ai_dl', !has || !R || typeof R.aiExport !== 'function');
        _setDisabled('bu_open_prism', !has || typeof G.PRiSM_openExternalBuildup !== 'function');
        // The 24-case check compares outcomes with the calibrated expectations in file 55 (§5.6). The placeholder file
        // (calibrated:false) has none, so the check stays disabled, with the reason shown, until WP8 calibrates it.
        var S = B.synth, valReady = !!(S && Array.isArray(S.IN_APP) && S.IN_APP.length && typeof S.caseFromSeed === 'function' && _Run()), calOk = _calReady();
        _setDisabled('bu_val_run', running || !valReady || !calOk);
        var vo = _byId('bu_val_out');
        if (vo && (!vo.textContent || vo.getAttribute('data-note') === '1')) {
            if (valReady && !calOk) { vo.setAttribute('data-note', '1'); vo.textContent = 'The 24-case check becomes available once the confidence labels are calibrated (this version uses the provisional thresholds).'; }
            else if (vo.getAttribute('data-note') === '1') { vo.removeAttribute('data-note'); vo.textContent = ''; }
        }
        _setDisabled('bu_demo_load', !_Syn());
        _setDisabled('bu_h_load', !(G.WTS_historian && _D() && typeof _D().fromHistorian === 'function'));
        _setDisabled('bu_p_load', !(_D() && typeof _D().fromPRiSM === 'function'));
        _setDisabled('bu_well_prism', typeof G.PRiSM_getWell !== 'function');
        var ds = _D();
        _setDisabled('bu_g_load', !(ds && (typeof ds.parseJob === 'function' || typeof ds.parse === 'function')));
        _setDisabled('bu_a_load', !(ds && typeof ds.parseAllocation === 'function'));
    }
    function _fillTestSel() {
        var sel = _byId('bu_test_sel');
        if (!sel) return;
        var a = _st && _st.analysis, cur = sel.value || (_st && _st.uiSel && _st.uiSel.test) || '';
        var pairs = [['', 'Latest test']];
        (a && a.tests || []).forEach(function (t) { if (t && t.id) pairs.push([t.id, t.id + ' · ' + (t.date || '') + (t.status !== 'interpreted' ? ' (' + String(t.status).replace('_', ' ') + ')' : '')]); });
        sel.innerHTML = _opts(pairs, cur);
        sel.value = pairs.some(function (p) { return p[0] === cur; }) ? cur : '';
    }

    // ── reading the inputs (canonical imperial) ──────────────────────
    function _isActive(id, fl) {
        if (/^bu_(pb|rs)$/.test(id)) return fl === 'oil';
        if (/^bu_(sg|tres|co2|h2s|n2|pdew|api|mo)$/.test(id)) return fl === 'gas';
        if (/^bu_(bw|muw)$/.test(id)) return fl === 'water_inj';
        if (id === 'bu_patm') return _val('bu_src') === 'file' || _val('bu_src') === 'paste';
        if (/^bu_dep_/.test(id)) return _checked('bu_dep_on');
        if (/^bu_cmp_(hp|htop|theta|kvlo|kvhi)$/.test(id)) return _checked('bu_cmp_on');
        if (/^bu_cmp_(spf|lp|rp)$/.test(id)) return _checked('bu_cmp_on') && _checked('bu_cmp_perf') && _perfOK();
        if (id === 'bu_hist_cumo') return _val('bu_hist_mode') === 'cum' && fl !== 'gas';
        if (id === 'bu_hist_cumg') return _val('bu_hist_mode') === 'cum' && fl === 'gas';
        return true;
    }
    function _labelText(id) {
        var el = _byId(id), w = el && el.closest ? el.closest('.fg-item') : null;
        var l = w && w.querySelector ? w.querySelector('label') : null;
        var t = l ? String(l.textContent || '') : (LABEL[id] || id);
        return t.replace(/\s*\([^()]*\)\s*$/, '').replace(/, blank = .*$/, '').trim();
    }
    // returns {v (number|null), err: null|'blank'|'range'}
    function _readNum(id, fl) {
        var d = NUM[id], kind = d[4], raw = _parse(_val(id));
        if (kind === 'set' || kind === 'setopt') {
            if (raw === null || isNaN(raw)) return { v: kind === 'setopt' ? null : d[0], err: null };
            var c = Math.min(d[3], Math.max(d[2], raw));
            if (INT_IDS[id]) c = Math.round(c);
            return { v: c, err: null };
        }
        if (!_isActive(id, fl)) return { v: (kind === 'opt' || d[0] === '') ? null : d[0], err: null, inactive: true };
        if (raw === null) return kind === 'opt' ? { v: null, err: null } : { v: null, err: 'blank' };
        if (isNaN(raw) || raw < d[2] || raw > d[3]) return { v: null, err: 'range' };
        return { v: raw, err: null };
    }
    function _zoneOf(which) {
        var mode = _val(which === 'g' ? 'bu_g_tz' : 'bu_pd_tz'), name = _val(which === 'g' ? 'bu_g_tzname' : 'bu_pd_tzname') || (_st && _st.zones ? _st.zones[which] : '');
        if (mode === 'utc') return { mode: 'utc' };
        if (mode === 'fixed') { var o = _readNum(which === 'g' ? 'bu_g_tzoff' : 'bu_pd_tzoff').v; return { mode: 'fixed', offset_h: o }; }
        return name ? { mode: 'iana', tz: name } : { mode: 'device' };
    }
    function _deviceZone() {
        var D = _D();
        if (D && typeof D.resolveZone === 'function') { try { var z = D.resolveZone({ mode: 'device' }); if (z && z.mode === 'iana' && z.tz) return z.tz; } catch (e) { /* Intl below */ } }
        try { var tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tz) return String(tz); } catch (e) { /* none */ }
        return '';
    }
    // ── wall-clock date-times in a resolved zone ─────────────────────
    // Typed and shown date-times (closing time, missed shut-ins, start of elapsed time, historian period) use the
    // resolved gauge zone — the zone the review shows event times in (S3) and the data reader reads ISO times in.
    var _dtfC = {};
    function _dtf(tz) {
        if (_own(_dtfC, tz)) return _dtfC[tz];
        var f = null;
        try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch (e) { f = null; }
        _dtfC[tz] = f;
        return f;
    }
    function _offMs(zone, ms) {                 // zone wall clock minus UTC at the instant ms
        if (!zone || zone.mode === 'utc' || !_fin(ms)) return 0;
        if (zone.mode === 'fixed') return _fin(zone.offset_h) ? Math.round(zone.offset_h * 3600000) : 0;
        var f = zone.tz ? _dtf(zone.tz) : null;
        if (!f || typeof f.formatToParts !== 'function') return 0;
        var p = {};
        try { f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; }); } catch (e) { return 0; }
        var wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
        return _fin(wall) ? wall - Math.floor(ms / 1000) * 1000 : 0;
    }
    function _msToLocal(ms, zone) { return _fin(ms) ? new Date(ms + _offMs(zone, ms)).toISOString().slice(0, 16) : ''; }
    function _localToMs(s, zone) {
        var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s == null ? '' : s).trim());
        if (!m) return NaN;
        var g = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        if (!_fin(g)) return NaN;
        // One rule with the gauge-data reader (data.localToUtc): in a DST gap the later offset, in a repeated hour the
        // first occurrence, so a typed closing time lines up with the parsed sample times.
        var D = _D();
        if (D && typeof D.localToUtc === 'function' && zone && zone.mode && zone.mode !== 'device') {
            try { var u = D.localToUtc(zone, g); if (_fin(u)) return u; } catch (e) { /* fallback below */ }
        }
        return g - _offMs(zone, g - _offMs(zone, g));     // fallback (no data module): two passes
    }
    function _zoneName(z) {
        if (!z || z.mode === 'utc') return 'UTC';
        if (z.mode === 'fixed') { var o = _fin(z.offset_h) ? z.offset_h : 0; return 'UTC' + (o >= 0 ? '+' : '−') + Math.abs(o) + ' h'; }
        return String(z.tz || 'UTC');
    }
    // The analysis's resolved gauge zone (event times), else the zone the inputs resolve to now.
    function _gaugeZone(useAnalysis) {
        var a = useAnalysis !== false && _st && _st.analysis, z = a && a.zones && a.zones.gauge;
        if (z && z.mode && z.mode !== 'device') return z;
        z = _zoneOf('g');
        if (z.mode === 'device') { var n = _deviceZone(); z = n ? { mode: 'iana', tz: n } : { mode: 'utc' }; }
        return z;
    }
    function _resolveZones() {
        var changed = false;
        [['g', 'bu_g_tz', 'bu_g_tzname'], ['pd', 'bu_pd_tz', 'bu_pd_tzname']].forEach(function (z) {
            if (_val(z[1]) !== 'device') return;
            var cur = _val(z[2]) || (_st.zones && _st.zones[z[0]]) || '';
            if (!cur) { cur = _deviceZone(); changed = true; }
            _st.zones[z[0]] = cur;
            var e = _byId(z[2]); if (e) e.value = cur;
        });
        return changed;
    }
    function _workovers() {
        var out = [];
        String(_val('bu_wo')).split(/[\s,;]+/).forEach(function (s) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return;
            var d = new Date(s + 'T00:00:00Z');
            if (!isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && out.indexOf(s) === -1) out.push(s);
        });
        return out.sort();
    }
    function _wellName() {
        try { var ci = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('h2oil_client_info')) || '{}'); if (ci && ci.well) return String(ci.well).slice(0, 60); } catch (e) { /* none */ }
        try { var W = G.WTS_wells, l = W && W.list ? W.list() : []; for (var i = 0; i < l.length; i++) if (l[i].active) return String(l[i].name || ''); } catch (e) { /* none */ }
        return '';
    }
    // {input, bad:[ids], errors:[text]} — AnalysisInput (§3.7) from the controls
    function _gatherImpl() {
        _ensure();
        var fl = _val('bu_fluid') || 'oil', bad = [], errors = [], v = {};
        Object.keys(NUM).forEach(function (id) {
            var r = _readNum(id, fl);
            v[id] = r.v;
            if (r.err) { bad.push(id); errors.push(r.err === 'blank' ? 'Enter a value for ' + _labelText(id) + '.' : _labelText(id) + ' is outside its range.'); }
        });
        if (_fin(v.bu_re) && _fin(v.bu_rw) && v.bu_re < 10 * v.bu_rw && bad.indexOf('bu_re') === -1) { bad.push('bu_re'); errors.push('The drainage radius must be at least 10 times the wellbore radius.'); }
        if (fl === 'gas' && (v.bu_co2 || 0) + (v.bu_h2s || 0) + (v.bu_n2 || 0) > 100) { bad.push('bu_co2'); errors.push('CO2, H2S and N2 add up to more than 100 mol %.'); }
        var cmp = _checked('bu_cmp_on');
        if (cmp && _fin(v.bu_cmp_kvlo) && _fin(v.bu_cmp_kvhi) && v.bu_cmp_kvlo > v.bu_cmp_kvhi) { bad.push('bu_cmp_kvhi'); errors.push('The high kv/kh must not be below the low one.'); }
        if (cmp && _fin(v.bu_h) && ((v.bu_cmp_hp || v.bu_h) + (v.bu_cmp_htop || 0) > v.bu_h * 1.0001)) { bad.push('bu_cmp_htop'); errors.push('The open interval and its top offset do not fit inside the net pay.'); }
        var defaulted = [];
        Object.keys(DEFAULTED_KEYS).forEach(function (k) {
            var id = DEFAULTED_KEYS[k];
            if (!_isActive(id, fl)) return;
            if (!(_st.touched && _st.touched[id]) && _fin(v[id]) && Math.abs(v[id] - NUM[id][0]) <= Math.abs(NUM[id][0]) * 1e-9) defaulted.push(k);
        });
        var gas = null;
        if (fl === 'gas') gas = { sg: v.bu_sg, T_F: v.bu_tres, co2: v.bu_co2 || 0, h2s: v.bu_h2s || 0, n2: v.bu_n2 || 0, pseudoTime: _checked('bu_ptime'), pdew: v.bu_pdew, apiCond: v.bu_api, Mo: v.bu_mo };
        var well = { fluid: fl, h: v.bu_h, phi: v.bu_phi, mu: v.bu_mu, B: v.bu_B, ct: _fin(v.bu_ct) ? Number((v.bu_ct * 1e-6).toPrecision(12)) : v.bu_ct, rw: v.bu_rw, re_ft: v.bu_re, Pb: fl === 'oil' ? v.bu_pb : null,
            Rs: fl === 'oil' ? v.bu_rs : null, gas: gas, Bw: _fin(v.bu_bw) ? v.bu_bw : 1.02, muw: _fin(v.bu_muw) ? v.bu_muw : 0.5, allocAccPct: v.bu_alloc_acc,
            driftPsiPerDay: v.bu_drift, defaulted: defaulted,
            sens: { h: v.bu_sr_h / 100, phi: v.bu_sr_phi / 100, ct: v.bu_sr_ct / 100, rw: v.bu_sr_rw / 100, B: v.bu_sr_B / 100, mu: v.bu_sr_mu / 100, q: v.bu_sr_q / 100 } };
        var completion = cmp ? { hp_ft: _fin(v.bu_cmp_hp) ? v.bu_cmp_hp : v.bu_h, htop_ft: v.bu_cmp_htop || 0, theta_deg: v.bu_cmp_theta || 0,
            kvkh: [v.bu_cmp_kvlo, v.bu_cmp_kvhi],
            perf: (_checked('bu_cmp_perf') && _perfOK()) ? { spf: v.bu_cmp_spf, lp_in: v.bu_cmp_lp, rp_in: v.bu_cmp_rp, phase_deg: Number(_val('bu_cmp_phase')) || 0 } : null } : null;
        var depth = _checked('bu_dep_on') ? { gaugeTVD: v.bu_dep_g, datumTVD: v.bu_dep_d, grad: v.bu_dep_grad, gradFlow: v.bu_dep_gradf } : null;
        var hm = _val('bu_hist_mode');
        var hdate = /^\d{4}-\d{2}-\d{2}$/.test(_val('bu_hist_date')) ? _val('bu_hist_date') : null;
        if (hm === 'date' && !hdate) { bad.push('bu_hist_date'); errors.push('Enter the production start date, or choose another history option.'); }
        // history.cum is in the rate's field volume unit (§3.0): STB (bbl for injectors) or Mscf. The gas field is
        // tagged gasVolume, whose canonical unit is MMscf, so it is scaled to Mscf here.
        var cumG = _fin(v.bu_hist_cumg) ? Number((v.bu_hist_cumg * 1000).toPrecision(12)) : v.bu_hist_cumg;
        var history = { mode: hm === 'date' || hm === 'cum' ? hm : 'unknown', date: hm === 'date' ? hdate : null, cum: hm === 'cum' ? (fl === 'gas' ? cumG : v.bu_hist_cumo) : null };
        if (hm === 'cum' && !_fin(history.cum)) { bad.push(fl === 'gas' ? 'bu_hist_cumg' : 'bu_hist_cumo'); errors.push('Enter the cumulative production before the data, or choose another history option.'); }
        var settings = {
            detect: { winMin: v.bu_d_win, riseMin: v.bu_d_rise, riseSig: v.bu_d_sig, persistMin: v.bu_d_persist, minDur_h: v.bu_d_mindur, gapN: v.bu_d_gapn,
                spike: ({ off: 1, flag: 1, filter: 1 })[_val('bu_d_spike')] ? _val('bu_d_spike') : 'off', partial: _checked('bu_d_partial') },
            interp: { Lcyc: v.bu_i_L, band: v.bu_i_band / 100, slope: v.bu_i_slope, minCycles: v.bu_i_mincyc,
                rivals: ({ auto: 1, none: 1, all: 1 })[_val('bu_i_rivals')] ? _val('bu_i_rivals') : 'auto',
                cheld: ({ auto: 1, off: 1, extended: 1 })[_val('bu_i_cheld')] ? _val('bu_i_cheld') : 'auto',
                kHeld: _val('bu_i_kheld') === 'off' ? 'off' : 'auto', tide: _val('bu_i_tide') === 'off' ? 'off' : 'auto' },
            trend: { baseN: v.bu_t_base, delta: v.bu_t_delta, abs: v.bu_t_abs, basevar: _checked('bu_t_basevar'),
                confirm: _val('bu_t_confirm') === 'immediate' ? 'immediate' : 'next', price: _fin(v.bu_t_price) ? v.bu_t_price : null,
                enabled: ({ auto: 1, on: 1, off: 1 })[_val('bu_t_enabled')] ? _val('bu_t_enabled') : 'auto' },
            report: { detail: _val('bu_rep_detail') === 'all' ? 'all' : 'selected' }
        };
        var rate = _val('bu_rate_mode') === 'table' ? 'table' : 'daily';
        var a = _st.analysis;
        var stored = null;
        if (!_mem.record && a && Array.isArray(a.tests) && !_st.missingTests && !_st.partial) {   // summaries cannot be re-run
            // record (its summary and hash) and missed travel too, so a stored re-run keeps the same record hash, inputHash
            // and missed list as the run that detected the build-ups
            stored = { events: a.events || [], rates: a.rates || null, qc: a.qc || null, record: a.record || null, missed: a.missed || null,
                tests: a.tests.map(function (t) { return { id: t.id, eventId: t.eventId, spec: t.spec }; }) };
        }
        var input = {
            record: _mem.record || null,
            stored: stored,
            allocation: rate === 'daily' ? (_mem.allocation || null) : null,
            rateTable: rate === 'table' ? (_mem.rateTable || null) : null,
            well: well, completion: completion, depth: depth, history: history,
            zones: { gauge: _zoneOf('g'), day: { zone: _zoneOf('pd'), startHour: v.bu_pd_start } },
            settings: settings, overrides: (_st.overrides || []).slice(), workovers: _workovers(),
            meta: { wellName: _wellName(), engineer: String(_val('bu_eng')).slice(0, 80), appVersion: _appVer() }
        };
        return { input: input, bad: bad, errors: errors };
    }
    function gather() { return _canonRun(_gatherImpl); }
    // Canonical copies of the allocation and rate-table rows: only the fields that change numbers, never any key an
    // engine adds to a row it was given, so a run can never make the page look stale.
    function _numOrNull(x) { return _fin(x) ? x : null; }
    function _canonRows(rows) {
        return Array.isArray(rows) ? rows.map(function (r) {
            return r ? { date: String(r.date == null ? '' : r.date), oil: _numOrNull(r.oil), gas: _numOrNull(r.gas), water: _numOrNull(r.water), hours: _numOrNull(r.hours) } : null;
        }) : null;
    }
    function _canonAlloc(al) {
        if (!al) return null;
        var res = al.resolution || {};
        return { rows: _canonRows(al.rows) || [], gUnit: al.gUnit || 'Mscf', resolution: { oil: _numOrNull(res.oil), gas: _numOrNull(res.gas), water: _numOrNull(res.water) } };
    }
    function _canonRt(rt) { return Array.isArray(rt) ? rt.map(function (r) { return r ? { t_ms: _numOrNull(r.t_ms), q: _numOrNull(r.q) } : null; }) : null; }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    // The AnalysisInput handed to the engines: a deep copy (typed record arrays sliced), so nothing an engine
    // writes into its input reaches the page's memory, its state or its hashes.
    function _engineInput(input) {
        var c = {}, k;
        for (k in input) if (_own(input, k) && k !== 'record' && k !== 'allocation' && k !== 'rateTable') c[k] = _clone(input[k]);
        c.allocation = _canonAlloc(input.allocation);
        c.rateTable = _canonRt(input.rateTable);
        var r = input.record;
        if (r) {
            var rc = {};
            for (k in r) if (_own(r, k)) rc[k] = (r[k] && typeof r[k] === 'object' && typeof r[k].slice === 'function') ? r[k].slice() : (r[k] && typeof r[k] === 'object' ? _clone(r[k]) : r[k]);
            c.record = rc;
        } else c.record = null;
        return c;
    }
    // Page-level hash of everything that changes numbers (canonical imperial, 6 s.f.; display-only keys out).
    function pageHash(input) {
        if (!input) return null;
        var a = _st && _st.analysis;
        var recHash = input.record ? (input.record.hash || null) : (a && a.record ? a.record.hash : null);
        var s = {}, k;
        for (k in input.settings) if (_own(input.settings, k) && k !== 'report') s[k] = input.settings[k];
        var alloc = input.allocation ? { rows: _canonRows(input.allocation.rows), gUnit: input.allocation.gUnit } : null;
        return _hash({ rec: recHash, alloc: alloc, rt: _canonRt(input.rateTable), well: _wellNoDefaulted(input.well), completion: input.completion,
            depth: input.depth, history: input.history, zones: input.zones, settings: s, overrides: input.overrides, workovers: input.workovers });
    }
    function _wellNoDefaulted(w) {
        var c = {}, k;
        for (k in w) if (_own(w, k) && k !== 'defaulted') c[k] = w[k];
        return c;
    }
    function _forState(input) {
        var c = {}, k;
        for (k in input) if (_own(input, k) && k !== 'record' && k !== 'stored') c[k] = _clone(input[k]);
        c.allocation = _canonAlloc(input.allocation);
        c.rateTable = _canonRt(input.rateTable);
        var r = input.record;
        if (!r && input.stored && _st && _st.analysis && _st.analysis.record) r = _st.analysis.record;   // reproduced from the stored build-ups: same record
        c.record = r ? { hash: r.hash || null, name: String(r.name || ''), source: r.source || '', n: r.n || 0, origin_ms: r.origin_ms || null } : null;
        return c;
    }
    function _flat(o, pre, out) {
        out = out || {};
        if (o === null || typeof o !== 'object' || Array.isArray(o)) { out[pre] = JSON.stringify(o); return out; }
        Object.keys(o).forEach(function (k) { _flat(o[k], pre ? pre + '.' + k : k, out); });
        return out;
    }
    function _inputDiff(prev, next) {
        if (!prev || !next) return [];
        var skip = { 'meta.appVersion': 1, 'meta.engineer': 1, 'settings.report.detail': 1, 'well.defaulted': 1 };
        var A = _flat({ well: prev.well, completion: prev.completion, depth: prev.depth, history: prev.history, zones: prev.zones, settings: prev.settings, workovers: prev.workovers, rec: prev.record && prev.record.hash,
            alloc: prev.allocation && _hash(_canonRows(prev.allocation.rows) || []), rt: prev.rateTable && _hash(_canonRt(prev.rateTable)) }, '');
        var Bn = _flat({ well: next.well, completion: next.completion, depth: next.depth, history: next.history, zones: next.zones, settings: next.settings, workovers: next.workovers, rec: next.record && next.record.hash,
            alloc: next.allocation && _hash(_canonRows(next.allocation.rows) || []), rt: next.rateTable && _hash(_canonRt(next.rateTable)) }, '');
        var keys = {}, out = [];
        Object.keys(A).forEach(function (k) { keys[k] = 1; });
        Object.keys(Bn).forEach(function (k) { keys[k] = 1; });
        Object.keys(keys).sort().forEach(function (k) {
            if (skip[k]) return;
            var a = A[k], b = Bn[k];
            var na = a != null ? Number(JSON.parse(a)) : NaN, nb = b != null ? Number(JSON.parse(b)) : NaN;
            if (a === b || (_fin(na) && _fin(nb) && Math.abs(na - nb) <= 1e-6 * Math.max(Math.abs(na), Math.abs(nb)))) return;
            if (out.length < 40) out.push({ field: k, from: a == null ? null : JSON.parse(a), to: b == null ? null : JSON.parse(b) });
        });
        return out;
    }

    // ── exact canonical values after a Metric restore ────────────────
    // The host restores a tagged input in Metric mode as its metric value rounded to 4 decimals (1 decimal from
    // 100 up), so reading it back gives an imperial value a few parts in 1e5 off the one analysed — enough to look
    // like an input change at 6 significant figures. A field that still shows what the restore of the analysed
    // value shows is rewritten with that exact value (a canonical write keeps the exact text in the units memo).
    var SNAP = {
        bu_h: ['well', 'h'], bu_rw: ['well', 'rw'], bu_re: ['well', 're_ft'], bu_mu: ['well', 'mu'], bu_ct: ['well', 'ct', 1e6], bu_pb: ['well', 'Pb'],
        bu_rs: ['well', 'Rs'], bu_tres: ['well', 'gas', 'T_F'], bu_pdew: ['well', 'gas', 'pdew'], bu_muw: ['well', 'muw'], bu_drift: ['well', 'driftPsiPerDay'],
        bu_dep_g: ['depth', 'gaugeTVD'], bu_dep_d: ['depth', 'datumTVD'], bu_dep_grad: ['depth', 'grad'], bu_dep_gradf: ['depth', 'gradFlow'],
        bu_cmp_hp: ['completion', 'hp_ft'], bu_cmp_htop: ['completion', 'htop_ft'], bu_cmp_lp: ['completion', 'perf', 'lp_in'], bu_cmp_rp: ['completion', 'perf', 'rp_in'],
        bu_hist_cumo: ['history', 'cum'], bu_hist_cumg: ['history', 'cum', 0.001], bu_d_rise: ['settings', 'detect', 'riseMin'], bu_t_price: ['settings', 'trend', 'price']
    };
    function _snapToAnalysed() {
        var U = G.WTS_units, inp = _st && _st.input;
        if (!inp || !_isM() || !U || typeof U.convertCategory !== 'function') return 0;
        var n = 0;
        _canonRun(function () {
            Object.keys(SNAP).forEach(function (id) {
                var el = _byId(id), cat = TAGS[id], path = SNAP[id], ref = inp, i;
                if (!el || !cat || !_cat(cat)) return;
                for (i = 0; i < path.length && typeof path[i] === 'string'; i++) ref = ref == null ? null : ref[path[i]];
                if (typeof path[path.length - 1] === 'number' && _fin(ref)) ref = Number((ref * path[path.length - 1]).toPrecision(12));
                var cur = _parse(el.value);
                if (!_fin(ref) || !_fin(cur) || cur === ref) return;
                var dm = U.convertCategory(ref, cat, 'imperial', 'metric');
                var u = Math.abs(dm) >= 100 ? 0.05 : 0.00005;
                var tol = Math.abs(U.convertCategory(dm + u, cat, 'metric', 'imperial') - ref) * 1.01 + Math.abs(ref) * 1e-12;
                if (Math.abs(cur - ref) <= tol) { el.value = String(ref); n++; }
            });
        });
        return n;
    }

    // ── stale marking ────────────────────────────────────────────────
    function _setSub() {
        var s = _byId('pgSub');
        if (!s || !_root()) return;
        var a = _st && _st.analysis, txt = PG_SUB;
        if (a) {
            var stt = _status2(), stale = _isStale;
            if (stale) txt += ' · DRAFT (stale)';
            else if (stt === 'SIGNED') txt += ' · Signed off ' + String((_st.signoff && _st.signoff.at) || '').slice(0, 10);
            else if (stt === 'CHANGED') txt += ' · DRAFT (changed after sign-off)';
            else txt += ' · DRAFT';
        }
        s.textContent = txt;
    }
    var _isStale = false;
    function _snap() {
        if (typeof G.WTS_snapshotNow === 'function') { try { G.WTS_snapshotNow(); } catch (e) { /* best effort */ } return; }
        var r = _byId('bu_res');
        if (r && typeof r.dispatchEvent === 'function' && typeof Event === 'function') { try { r.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* best effort */ } }
    }
    function _checkStale(quiet) {
        if (!_root() || !_st) return false;
        var g = gather();
        _defaultsNote(g.input);
        var was = _isStale;
        _isStale = !!(_st.analysis && _st.pageHash && pageHash(g.input) !== _st.pageHash);
        var b = _byId('bu_stale'), res = _byId('bu_res');
        if (b && b.style) b.style.display = _isStale ? '' : 'none';
        if (res && res.classList) { if (_isStale) res.classList.add('bu-stale'); else res.classList.remove('bu-stale'); }
        _setSub();
        if (!quiet && was !== _isStale) _snap();
        return _isStale;
    }
    function _defaultsNote(input) {
        var n = _byId('bu_defaults_note');
        if (!n) return;
        var d = (input && input.well && input.well.defaulted) || [];
        n.textContent = d.length ? 'Inputs left at default: ' + d.map(function (k) { return DEFAULTED_NAMES[k] || k; }).join(', ') + '.' : '';
    }

    // ── report rendering ─────────────────────────────────────────────
    function _isVal(x) { return !!x && typeof x === 'object' && _own(x, 'v') && (_own(x, 'dp') || _own(x, 'cat') || _own(x, 'ref')); }
    function _fill(tpl, values) {
        var vals = values || {};
        return String(tpl == null ? '' : tpl).replace(/\{([A-Za-z0-9_]+)\}/g, function (m, k) {
            if (!_own(vals, k)) return '—';
            var x = vals[k];
            if (_isVal(x)) return fmt(x.v, x.cat, x.dp);
            if (x && typeof x === 'object' && _own(x, 'template')) return _fill(x.template, x.values);
            if (x == null) return '—';
            return typeof x === 'number' ? fmt(x, null, 2) : String(x);
        });
    }
    function _evOf(x) { return (x && typeof x.ref === 'string') ? x.ref.split(':')[0] : null; }
    function _refs(ev) { return (ev && ev.length) ? ' [' + ev.join(', ') + ']' : ''; }
    function _cut(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function _cleanTxt(s) { return String(s).replace(/\b(null|undefined|NaN|Infinity)\b/g, '—').replace(/\[object Object\]/g, '—'); }
    var SYM = { ok: ['✓', 'green'], warn: ['⚠', 'yellow'], bad: ['✗', 'red'] };
    function _blockHtml(b, sec, charts) {
        if (!b || typeof b !== 'object') return '';
        var h = '';
        if (b.kind === 'verdict') {
            var sy = SYM[b.level] || SYM.warn;
            // the review's templates start with their own glyph: one symbol per verdict (the level's), never two
            var t = _cleanTxt(_fill(b.template, b.values)).replace(/^\s*[✓⚠✗×]\s*/, '') + _refs(b.ev);
            return '<div style="color:var(--' + sy[1] + ')">' + sy[0] + ' ' + _esc(_cut(t, 296)) + '</div>';
        }
        if (b.kind === 'kv') {
            (b.rows || []).forEach(function (r) {
                var val = r.value, txt;
                if (_isVal(val)) txt = fmt(val.v, val.cat, val.dp);
                else if (val && typeof val === 'object' && _own(val, 'template')) txt = _fill(val.template, val.values);
                else txt = val == null ? '—' : String(val);
                h += '<div class="rrow"><span class="rl">' + _esc(r.label) + '</span><span class="rv">' + _esc(_cleanTxt(txt)) +
                    (r.ev && r.ev.length ? '<span class="bu-ev">' + _esc(_refs(r.ev)) + '</span>' : '') + '</span></div>';
            });
            return h;
        }
        if (b.kind === 'kpi') {
            h = '<div class="bu-kpis">';
            (b.items || []).forEach(function (it) {
                var val = it.value, txt = _isVal(val) ? fmt(val.v, val.cat, val.dp) : (val && val.template ? _fill(val.template, val.values) : (val == null ? '—' : String(val)));
                h += '<div class="kpi"><div class="kpi-l">' + _esc(it.label) + '</div><div class="kpi-v">' + _esc(_cleanTxt(txt)) +
                    (it.ev && it.ev.length ? ' <span class="bu-ev">' + _esc(_refs(it.ev)) + '</span>' : '') + '</div></div>';
            });
            return h + '</div>';
        }
        if (b.kind === 'notes') {
            var nt = _cleanTxt(_fill(b.template, b.values)) + _refs(b.ev);
            return '<div class="bu-note"><b>' + _esc(b.head || 'Notes') + '</b> ' + _esc(_cut(nt, 590 - String(b.head || 'Notes').length)) + '</div>';
        }
        if (b.kind === 'table') {
            var noStack = sec === 'S4' || sec === 'S9';
            var head = (b.head || []).map(function (c) {
                var text = (c && typeof c === 'object') ? c.text : c, u = (c && typeof c === 'object') ? _ul(c.cat) : '';
                return '<th>' + _esc(text) + (u ? ' (' + _esc(u) + ')' : '') + '</th>';
            }).join('');
            var anyEv = (b.rows || []).some(function (r) { return (r || []).some(function (c) { return !!_evOf(c); }); });
            var nCol = (b.head || []).length + (anyEv ? 1 : 0), nw = {};
            (b.head || []).forEach(function (c, ci) { var text = (c && typeof c === 'object') ? c.text : c; if (/^Labels\b/.test(String(text || ''))) nw[ci] = 1; });
            h = '<div class="bu-tw"' + (noStack ? ' data-no-stack' : '') + '><table class="dtable"' + (b.id ? ' id="' + _esc(b.id) + '"' : '') + '><thead><tr>' + head + (anyEv ? '<th>Ev.</th>' : '') + '</tr></thead><tbody>';
            (b.rows || []).forEach(function (r) {
                var ev = [];
                // "N older tests / events / earlier days not shown": one cell across the table, not a data row
                if (r && r.length > 1 && typeof r[1] === 'string' && / not shown$/.test(r[1]) && _isVal(r[0])) {
                    h += '<tr class="bu-older"><td colspan="' + nCol + '">' + _esc(_cleanTxt(_fmtNoUnit(r[0].v, r[0].cat, r[0].dp) + ' ' + r[1])) + '</td></tr>';
                    return;
                }
                h += '<tr>' + (r || []).map(function (c, ci) {
                    var txt, act = '';
                    if (_isVal(c)) { txt = _fmtNoUnit(c.v, c.cat, c.dp); var e = _evOf(c); if (e && ev.indexOf(e) === -1) ev.push(e); }
                    else txt = c == null ? '—' : String(c);
                    if (ci === 0 && typeof c === 'string') {
                        if (sec === 'S4' && /^B\d+$/.test(c)) act = '<button type="button" class="btn btn-secondary bu-act rp-skip" data-act="menu" data-test="' + _esc(c) + '" aria-label="Actions for ' + _esc(c) + '">Actions…</button>';
                        if (sec === 'S9' && /^V\d+$/.test(c)) {
                            var fids = ((_st.review && _st.review.findings) || []).filter(function (f) { return f && f.rule === c; }).map(function (f) { return f.id; });
                            if (fids.length) act = '<button type="button" class="btn btn-secondary bu-act rp-skip" data-act="menu" data-f="' + _esc(fids.join(',')) + '" aria-label="Decide the ' + _esc(c) + ' findings">Actions…</button>';
                        }
                    }
                    return '<td' + (nw[ci] ? ' class="bu-nw"' : '') + '>' + _esc(_cleanTxt(txt)) + act + '</td>';
                }).join('') + (anyEv ? '<td class="bu-evc">' + _esc(ev.join(', ')) + '</td>' : '') + '</tr>';
            });
            return h + '</tbody></table></div>';
        }
        if (b.kind === 'chart' && b.id) {
            if (_st && _st.missingTests && _isDetailChart(b.id)) return '';   // per-test detail not on this device
            charts.push({ id: String(b.id), block: b });
            return _canvasHtml(String(b.id));
        }
        return '';
    }
    function _canvasSize() {
        var r = _root(), w = r ? (r.clientWidth || 900) : 900;
        return w < 600 ? [600, 400] : [720, 300];
    }
    function _canvasHtml(id) {
        var sz = _canvasSize();
        return '<div class="chart-wrap"><canvas id="' + _esc(id) + '" width="' + sz[0] + '" height="' + sz[1] + '" role="img" aria-label="Chart"></canvas></div>';
    }
    function _selTest() {
        var a = _st && _st.analysis;
        if (!a) return null;
        var id = _val('bu_test_sel') || '';
        var ok = (a.tests || []).filter(function (t) { return t && t.status === 'interpreted' && t.result; });
        if (id) { var f = (a.tests || []).filter(function (t) { return t && t.id === id; })[0]; if (f) return f; }
        return ok.length ? ok[ok.length - 1] : ((a.tests || [])[a.tests.length - 1] || null);
    }
    function _viewAnalysis(a) {
        var sel = _selTest(), c = {}, k;
        for (k in a) if (_own(a, k)) c[k] = a[k];
        var s = {};
        for (k in (a.settings || {})) if (_own(a.settings, k)) s[k] = a.settings[k];
        s.report = { detail: _val('bu_rep_detail') === 'all' ? 'all' : 'selected', selected: sel ? sel.id : null };
        c.settings = s;
        return c;
    }
    // Report from the per-test summaries alone (no review module, a report that cannot be built, or the per-test
    // detail missing on this device): summary, tests, trend and alerts, sign-off status.
    function _fallbackReport(a, why) {
        var V = function (v, cat, dp, ref) { return { v: _fin(v) ? v : (typeof v === 'string' ? v : null), cat: cat || null, dp: dp, ref: ref }; };
        var tests = (a.tests || []), ok = tests.filter(function (t) { return t && t.status === 'interpreted' && t.result && t.result.final; });
        var last = ok.length ? ok[ok.length - 1] : null, lf = last ? last.result.final : null;
        var tr = a.trend || {}, al = tr.alerts || {}, d = al.delta || {}, ab = al.absolute || {}, bS = tr.baseline && _fin(tr.baseline.S) ? tr.baseline.S : null;
        var rows = tests.slice(-30).map(function (t) {
            var r = t.result || {}, f = r.final;
            return [t.id, t.date || '—', String(t.status || '—').replace('_', ' '), f ? V(f.k, 'permeability', 1, t.id + '·A2:k') : '—', f ? V(f.S, null, 2, t.id + '·A2:S') : '—',
                r.sErr ? V(r.sErr.value, null, 2, t.id + '·U1:value') : '—', r.confidence ? String(r.confidence.headline || '—') : '—'];
        });
        var stt = _status2() || 'DRAFT', ex = tr.excludedLow || { n: 0 };
        var alertTxt = function (x) { return String(x.status || 'none') + (x.raisedAt ? ', raised at ' + x.raisedAt : '') + (x.confirmedAt ? ', confirmed at ' + x.confirmedAt : ''); };
        return { title: PG_TITLE, subtitle: '', status: stt, signature: null, reproducibility: null, _fallback: true,
            sections: [
                { id: 'S1', title: 'Summary', blocks: [
                    { kind: 'verdict', level: 'warn', template: why || 'The automated review is not loaded: the numbers are shown without it.', values: {}, ev: [] },
                    { kind: 'kpi', items: [{ label: 'Latest skin', value: V(lf ? lf.S : null, null, 2, last ? last.id + '·A2:S' : 'A2:S'), ev: last ? [last.id + '·A2'] : [] },
                        { label: 'Latest permeability', value: V(lf ? lf.k : null, 'permeability', 1, last ? last.id + '·A2:k' : 'A2:k'), ev: last ? [last.id + '·A2'] : [] },
                        { label: 'Baseline skin', value: V(bS, null, 2, 'T1:S'), ev: ['T1'] }] }] },
                { id: 'S4', title: 'Build-up tests', blocks: [{ kind: 'table', id: 'bu_tbl_tests', head: [{ text: 'Test', cat: null }, { text: 'Date', cat: null }, { text: 'Status', cat: null },
                    { text: 'k', cat: 'permeability' }, { text: 'S', cat: null }, { text: 'S_err', cat: null }, { text: 'Confidence', cat: null }], rows: rows, ev: [] }] },
                { id: 'S5', title: 'Trend and alerts', blocks: [{ kind: 'kv', rows: [
                    { label: 'Baseline skin', value: V(bS, null, 2, 'T1:S'), ev: ['T1'] },
                    { label: 'Delta skin alert', value: alertTxt(d), ev: ['T2'] },
                    { label: 'Absolute skin alert', value: alertTxt(ab) + (ab.basis ? ' (' + ab.basis + ' skin)' : ''), ev: ['T3'] },
                    { label: 'Low tests excluded', value: _fin(ex.n) && ex.n ? String(ex.n) : 'none', ev: ['T16'] }] }] },
                { id: 'S11', title: 'Sign-off', blocks: [{ kind: 'verdict', level: stt === 'SIGNED' ? 'ok' : 'warn',
                    template: stt === 'SIGNED' ? 'Signed off.' : (stt === 'CHANGED' ? 'DRAFT — changed after sign-off.' : 'DRAFT — not signed off.'), values: {}, ev: [] }] }
            ] };
    }
    function _isDetailChart(id) { return /^bu_ch_(ll|sl|ov)(_|$)/i.test(String(id)); }
    function reportModel() {
        var a = _st && _st.analysis;
        if (!a) return null;
        var R = _R();
        if (!R) return _fallbackReport(a, _st.missingTests ? DETAIL_MISSING : null);
        try {
            if (!_st.review && typeof R.run === 'function' && !_st.missingTests) _st.review = R.run(a, _idx());
            if (_st.missingTests && !_st.review) return _fallbackReport(a, DETAIL_MISSING);
            // the evidence index of the stored analysis (the view only adds settings.report, which no evidence quotes)
            return R.report(_viewAnalysis(a), _st.review, _auditList(), _st.signoff || null, fmt, { idx: _idx() });
        } catch (e) {
            if (!_st.missingTests && typeof console !== 'undefined' && console.error) console.error('[buildup] report failed', e);
            return _fallbackReport(a, _st.missingTests ? DETAIL_MISSING : 'The report could not be built from this analysis; press Analyse to recompute it.');
        }
    }
    // charts each section should hold (added when the report model has no chart block for them)
    function _wantedCharts(a) {
        var w = { S3: ['bu_ch_rate'], S4: [], S5: ['bu_ch_skin', 'bu_ch_k', 'bu_ch_pi', 'bu_ch_J', 'bu_ch_ov'] };
        if (a && a.well && a.well.fluid === 'oil') w.S5.splice(4, 0, 'bu_ch_pwf');
        if (_st && _st.missingTests) { w.S5 = w.S5.filter(function (id) { return !_isDetailChart(id); }); return w; }
        if (_val('bu_rep_detail') === 'all') {
            (a.tests || []).filter(function (t) { return t && t.status === 'interpreted' && t.result; }).slice(-12).forEach(function (t) { w.S4.push('bu_ch_ll_' + t.id, 'bu_ch_sl_' + t.id); });
        } else w.S4.push('bu_ch_ll', 'bu_ch_sl');
        return w;
    }
    function _renderResults(opts) {
        opts = opts || {};
        var res = _byId('bu_res');
        if (!res) return;
        var a = _st && _st.analysis;
        _buttons();
        if (!a) { res.innerHTML = ''; res.removeAttribute('data-done'); _setSub(); _ovNote(null); return; }
        if (_st.partial) {
            res.innerHTML = '<div class="rbox" id="bu_s_S1"><div class="rbox-title" tabindex="-1">Summary</div><div class="bu-note"><b>Notes</b> Loading the stored build-ups of this analysis…</div></div>';
            _setSub();
            return;
        }
        var rm = reportModel(), charts = [], h = '';
        var want = _wantedCharts(a), have = {};
        (rm && rm.sections || []).forEach(function (sec) {
            if (!sec || !sec.id) return;
            var inner = '';
            (sec.blocks || []).forEach(function (b) { inner += _blockHtml(b, sec.id, charts); });
            charts.forEach(function (c) { have[String(c.id).toLowerCase()] = 1; });   // chart ids compare without case (the report may write bu_ch_j for bu_ch_J)
            (want[sec.id] || []).forEach(function (id) {
                if (have[id.toLowerCase()]) return;
                charts.push({ id: id, block: null }); have[id.toLowerCase()] = 1;
                inner += _canvasHtml(id);
            });
            if (_st.missingTests && (sec.id === 'S4' || (sec.id === 'S1' && !(rm && rm._fallback)))) inner = '<div class="bu-detail-missing" style="color:var(--yellow)">⚠ ' + _esc(_cut(DETAIL_MISSING, 296)) + '</div>' + inner;
            h += '<div class="rbox" id="bu_s_' + _esc(sec.id) + '" data-sec="' + _esc(sec.id) + '"><div class="rbox-title" tabindex="-1">' + _esc(sec.title || sec.id) + '</div>' + inner + '</div>';
        });
        if (rm && rm.reproducibility && rm.reproducibility.kind === 'notes' && !/id="bu_s_S10"/.test(h)) h += '<div class="rbox" id="bu_s_repro"><div class="rbox-title">Reproducibility</div>' + _blockHtml(rm.reproducibility, 'S10', charts) + '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
        if (typeof G.WTS_stackTables === 'function') { try { G.WTS_stackTables(res); } catch (e) { /* layout only */ } }
        _setSub();
        _ovNote(a);
        if (opts.charts !== false) _drawChartsAsync(charts);
    }
    // What became of each event-level override at the last Analyse: a refused one with the engine's reason (its
    // OVERRIDE_NOT_APPLIED warning), an added shut-in with the event it created and whether a build-up was interpreted.
    var EV_KIND_TXT = { shutin: 'a shut-in', falloff: 'a fall-off', partial: 'a partial rate cut', substep: 'a small rate step' };
    var EV_STATUS_TXT = { too_short: 'too short to interpret', not_confirmed: 'not confirmed as a shut-in', gap_at_closing: 'a data gap at the closing', excluded: 'excluded', intervention: 'a suspected intervention', partial: 'a partial cut' };
    function _ovOutcomes(a) {
        var out = [], gz = _gaugeZone();
        ((a && a.overrides) || []).forEach(function (o) {
            if (!o || !o.id) return;
            var ws = Array.isArray(o.warnings) ? o.warnings.filter(function (w) { return w && w.code === 'OVERRIDE_NOT_APPLIED' && w.text; }) : [];
            if (ws.length) { out.push({ lvl: 'warn', text: ws.map(function (w) { return String(w.text); }).join(' ') }); return; }
            if (o.kind !== 'event_add') return;
            var e = ((a.events || []).filter(function (x) { return x && (x.overrideIds || []).indexOf(o.id) !== -1; }))[0];
            if (!e) return;
            var t = ((a.tests || []).filter(function (x) { return x && x.eventId === e.id; }))[0];
            var interp = !!(t && t.status === 'interpreted');
            out.push({ lvl: interp ? 'ok' : 'warn', text: 'Override ' + o.id + ' added event ' + e.id + ' at ' + _msToLocal(e.tc_ms, gz).replace('T', ' ') + ' ' + _zoneName(gz) + ': ' +
                (EV_KIND_TXT[e.kind] || String(e.kind)) + (EV_STATUS_TXT[e.status] ? ', ' + EV_STATUS_TXT[e.status] : '') +
                (interp ? '; interpreted as build-up ' + t.id + '.' : (t ? '; build-up ' + t.id + ' ' + String(t.status).replace(/_/g, ' ') + '.' : '; no build-up was interpreted from it.')) });
        });
        return out;
    }
    function _ovNote(a) {
        var n = _byId('bu_ov_note');
        if (!n) return;
        var list = _ovOutcomes(a);
        n.innerHTML = list.map(function (x) {
            return '<div style="color:var(--' + (x.lvl === 'ok' ? 'green' : 'yellow') + ')">' + (x.lvl === 'ok' ? '✓ ' : '⚠ ') + _esc(String(x.text).slice(0, 290)) + '</div>';
        }).join('');
    }

    // ── charts ───────────────────────────────────────────────────────
    function _tDays(t_ms, a) {
        var t0 = null;
        (a.tests || []).forEach(function (t) { if (t && _fin(t.tc_ms) && (t0 === null || t.tc_ms < t0)) t0 = t.tc_ms; });
        if (t0 === null) t0 = a.record ? a.record.origin_ms : 0;
        return (t_ms - t0) / 86400000;
    }
    function _testTp(a, t) {
        var steps = a.rates && a.rates.steps, sr = t.spec && t.spec.stepRef;
        if (!Array.isArray(steps) || !sr || !_fin(sr.to)) return null;
        var vol = 0, last = 0;
        for (var i = Math.max(0, sr.from || 0); i < sr.to && i + 1 < steps.length; i++) {
            var dt = (steps[i + 1].t_ms - steps[i].t_ms) / 3600000;
            if (_fin(dt) && dt > 0) vol += steps[i].q * dt;
            if (steps[i].q > 0) last = steps[i].q;
        }
        var q = _fin(t.Dq) && t.Dq > 0 ? t.Dq : last;
        return q > 0 && vol > 0 ? vol / q : null;
    }
    function _llChart(cv, t) {
        var P = B.plot, r = t && t.result;
        if (!P || !r || !r.bins) { if (P) P.loglog(cv, { series: [] }); return; }
        var bins = r.bins, dt = bins.dt || [], pu = 'pressure';
        var dp = (bins.dp || []).map(function (v) { return _fin(v) ? _cv(Math.abs(v), pu) : null; });
        var full = bins.full || [], der = (bins.deriv || []).map(function (v, i) { return (_fin(v) && v > 0 && full[i] !== false) ? _cv(v, pu) : null; });
        var neg = [];
        (bins.deriv || []).forEach(function (v, i) { if (_fin(v) && v < 0 && full[i] !== false) neg.push({ dt: dt[i], y: _cv(-v, pu) }); });
        var series = [{ dt: dt, y: dp, kind: 'dp', color: '#58a6ff', label: 'Δp' }, { dt: dt, y: der, kind: 'deriv', color: '#f0883e', label: 'Derivative' }];
        var cu = r.curves;
        if (cu && Array.isArray(cu.dt)) {
            if (cu.hom) series.push({ dt: cu.dt, y: (cu.hom.dp || []).map(function (v) { return _cv(v, pu); }), kind: 'model', color: '#3fb950', label: 'Homogeneous' },
                { dt: cu.dt, y: (cu.hom.deriv || []).map(function (v) { return _cv(v, pu); }), kind: 'model', color: '#3fb950', dash: [5, 4] });
            if (cu.chosen && r.chosen && r.chosen.key !== 'homogeneous') series.push({ dt: cu.dt, y: (cu.chosen.dp || []).map(function (v) { return _cv(v, pu); }), kind: 'model', color: '#d2a8ff', label: MODEL_LABEL[r.chosen.key] || 'Chosen model' },
                { dt: cu.dt, y: (cu.chosen.deriv || []).map(function (v) { return _cv(v, pu); }), kind: 'model', color: '#d2a8ff', dash: [5, 4] });
        }
        var band = (r.iarf && r.iarf.found && _fin(r.iarf.dt0_h) && _fin(r.iarf.dt1_h)) ? { dt0: r.iarf.dt0_h, dt1: r.iarf.dt1_h } : null;
        P.loglog(cv, { series: series, band: band, markersNeg: neg, xLabel: 'Shut-in time Δt (h)', yLabel: 'Δp and derivative (' + _ul(pu) + ')' });
        cv.setAttribute('aria-label', String(cv.getAttribute('aria-label') || '').replace(/^Log-log chart/, 'Log-log diagnostic of ' + t.id));
    }
    // Superposition-equivalent time Δt_e of a test's display bins: bins.dte in memory; after a reload (the stored
    // copy drops it) recomputed from the stored spec and the analysis rate steps with PRiSM_autoInterp.prepare;
    // null when neither is possible (the chart then falls back to single-rate Horner and says so).
    var _dteMemo = {}, _dteMemoN = 0;
    function _interpLog(xt, xs, ys) {
        var lx = xs.map(function (v) { return v > 0 ? Math.log(v) : NaN; }), ly = ys.map(function (v) { return v > 0 ? Math.log(v) : NaN; });
        return xt.map(function (v) {
            if (!(v > 0)) return null;
            var l = Math.log(v);
            for (var i = 0; i + 1 < lx.length; i++) {
                if (_fin(lx[i]) && _fin(lx[i + 1]) && _fin(ly[i]) && _fin(ly[i + 1]) && l >= lx[i] - 1e-12 && l <= lx[i + 1] + 1e-12) {
                    var f = lx[i + 1] > lx[i] ? (l - lx[i]) / (lx[i + 1] - lx[i]) : 0;
                    return Math.exp(ly[i] + f * (ly[i + 1] - ly[i]));
                }
            }
            return null;
        });
    }
    function _dteFor(t, a) {
        var r = t && t.result, dt = r && r.bins && r.bins.dt;
        if (!Array.isArray(dt)) return null;
        if (Array.isArray(r.bins.dte) && r.bins.dte.length === dt.length) return r.bins.dte;
        var key = t.id + '|' + (r.inputHash || '') + '|' + (a.resultHash || '');
        if (_own(_dteMemo, key)) return _dteMemo[key];
        var A = _AI(), out = null, sp = t.spec, steps = a.rates && a.rates.steps, ref = sp && sp.stepRef;
        if (A && typeof A.prepare === 'function' && sp && Array.isArray(sp.dt) && sp.dt.length > 2 && Array.isArray(steps) && ref && _fin(ref.to) && steps[ref.to] && _fin(sp.tc_h)) {
            try {
                var s = _clone(sp), origin = steps[ref.to].t_ms - sp.tc_h * 3600000;      // the q = 0 step at index `to` is at tc_h
                delete s.stepRef;
                s.steps = steps.slice(Math.max(0, ref.from || 0), ref.to + 1).map(function (x) { return { t: (x.t_ms - origin) / 3600000, q: x.q }; });
                var pr = A.prepare(s);
                if (pr && pr.ok !== false && pr.bins && Array.isArray(pr.bins.dt) && Array.isArray(pr.bins.dte)) out = _interpLog(dt, pr.bins.dt, pr.bins.dte);
                if (out && !out.some(_fin)) out = null;
            } catch (e) { out = null; }
        }
        if (++_dteMemoN > 200) { _dteMemo = {}; _dteMemoN = 1; }
        _dteMemo[key] = out;
        return out;
    }
    function _slChart(cv, t, a) {
        var P = B.plot, r = t && t.result;
        if (!P || !r || !r.bins) { if (P) P.trend(cv, { datasets: [] }); return; }
        var dt = r.bins.dt || [], dp = r.bins.dp || [], dte = _dteFor(t, a), tp = _testTp(a, t), pu = 'pressure', approx = false;
        var xs = dt.map(function (d, i) {
            var e = (dte && _fin(dte[i])) ? dte[i] : null;
            if (e === null) { approx = true; e = (_fin(tp) && tp > 0 ? tp * d / (tp + d) : d); }
            return _fin(e) && e > 0 ? Math.log(e) / Math.LN10 : null;
        });
        var pts = [], win = [], ln = r.line || null;
        var i0 = ln && _fin(ln.dt0_h) ? ln.dt0_h : (r.iarf && _fin(r.iarf.dt0_h) ? r.iarf.dt0_h : null);
        var i1 = ln && _fin(ln.dt1_h) ? ln.dt1_h : (r.iarf && _fin(r.iarf.dt1_h) ? r.iarf.dt1_h : null);
        xs.forEach(function (x, i) {
            if (x == null || !_fin(dp[i])) return;
            pts.push({ x: x, y: _cv(Math.abs(dp[i]), pu) });
            if (i0 != null && i1 != null && dt[i] >= i0 * (1 - 1e-9) && dt[i] <= i1 * (1 + 1e-9)) win.push({ x: x, y: _cv(Math.abs(dp[i]), pu) });
        });
        var ds = [{ label: 'Δp', color: '#58a6ff', data: pts, points: true, width: 1 }];
        // the engine's semilog line (m, p1hr): Δp = |p1hr − pwf0| + |m|·(X − X(1 h)), X = log10 Δt_e. For gas the line
        // lives in pseudo-pressure, so it is drawn with the engine's slope through the window instead.
        if (ln && _fin(ln.m) && pts.length >= 2) {
            var m = Math.abs(ln.m), pw0 = t.spec && _fin(t.spec.pwf0) ? t.spec.pwf0 : t.pwf0, b0 = null, x1 = null;
            var gas = a.well && a.well.fluid === 'gas';
            if (!gas && _fin(ln.p1hr) && _fin(pw0)) {
                var lt = dt.map(function (d) { return d > 0 ? Math.log(d) / Math.LN10 : null; });
                for (var i = 0; i + 1 < dt.length && x1 === null; i++) if (lt[i] != null && lt[i + 1] != null && xs[i] != null && xs[i + 1] != null && lt[i] <= 0 && lt[i + 1] >= 0) x1 = xs[i] + (xs[i + 1] - xs[i]) * (0 - lt[i]) / ((lt[i + 1] - lt[i]) || 1);
                if (x1 === null) { var j0 = dt[0] > 1 ? 0 : dt.length - 1; if (xs[j0] != null && lt[j0] != null) x1 = xs[j0] - lt[j0]; }   // Δt_e ≈ Δt away from the data
                b0 = Math.abs(ln.p1hr - pw0);
            }
            if ((b0 === null || x1 === null) && win.length) {
                var mx = 0, my = 0;
                win.forEach(function (p) { mx += p.x; my += p.y; });
                mx /= win.length; my /= win.length;
                var mC = _cv(m, pu) - _cv(0, pu);           // a pressure difference per cycle
                ds.push({ label: 'Semilog line (engine slope m)', color: '#3fb950', data: [{ x: pts[0].x, y: my + mC * (pts[0].x - mx) }, { x: pts[pts.length - 1].x, y: my + mC * (pts[pts.length - 1].x - mx) }], points: false, width: 2 });
            } else if (b0 !== null && x1 !== null) {
                var xa = pts[0].x, xb = pts[pts.length - 1].x;
                ds.push({ label: 'Semilog line (m, p1hr)', color: '#3fb950', data: [{ x: xa, y: _cv(b0 + m * (xa - x1), pu) }, { x: xb, y: _cv(b0 + m * (xb - x1), pu) }], points: false, width: 2 });
            }
        }
        if (win.length) ds.push({ label: 'IARF window', color: '#f0883e', data: win, points: true, width: 0.5 });
        P.trend(cv, { datasets: ds, xLabel: 'log10 equivalent time (h)' + (approx ? ', single-rate approximation' : ''), yLabel: 'Δp (' + _ul(pu) + ')', xDec: 1, yDec: 1 });
    }
    function _seriesOf(a) { return (a.trend && Array.isArray(a.trend.series)) ? a.trend.series : []; }
    function _skinChart(cv, a) {
        var tr = a.trend || {}, ser = _seriesOf(a), used = [], hi = [], lo = [], exc = [], low = [], sm = [], uS = [], uW = [];
        var al = tr.alerts || {}, ab = al.absolute || {}, mech = ab.basis === 'mechanical';
        var lowIds = {}, seen = {};
        ((tr.excludedLow && tr.excludedLow.ids) || []).forEach(function (id) { lowIds[id] = 1; });
        ser.forEach(function (s) {
            if (!_fin(s.tDays) || !_fin(s.S)) return;
            seen[s.id] = 1;
            var u = s.used && s.used.trend !== false;
            if (lowIds[s.id]) low.push({ x: s.tDays, y: s.S });
            else (u ? used : exc).push({ x: s.tDays, y: s.S });
            if (u && !lowIds[s.id]) { uS.push(s); uW.push(1 / Math.pow(Math.max(_fin(s.Serr) ? s.Serr : 0.3, 0.05), 2)); }
            if (u && _fin(s.Serr)) { hi.push({ x: s.tDays, y: s.S + s.Serr }); lo.push({ x: s.tDays, y: s.S - s.Serr }); }
            if (mech && _fin(s.Smech)) sm.push({ x: s.tDays, y: s.Smech });
        });
        Object.keys(lowIds).forEach(function (id) {          // excluded low tests that the series does not carry
            if (seen[id]) return;
            var t = (a.tests || []).filter(function (x) { return x && x.id === id; })[0], f = t && t.result && t.result.final;
            if (f && _fin(f.S) && _fin(t.tc_ms)) low.push({ x: _tDays(t.tc_ms, a), y: f.S });
        });
        var th = [], bS = tr.baseline && _fin(tr.baseline.S) ? tr.baseline.S : null;
        if (bS != null) th.push({ label: 'Baseline', y: bS, color: '#8b949e' });
        if (bS != null && al.delta && _fin(al.delta.threshold)) th.push({ label: 'Baseline + delta threshold', y: bS + al.delta.threshold, color: '#e3b341' });
        if (_fin(ab.threshold)) th.push({ label: mech ? 'Absolute threshold (on mechanical skin)' : 'Absolute threshold', y: ab.threshold, color: '#ff7b72' });
        var ds = [{ label: 'Skin S', color: '#58a6ff', data: used, points: true }, { label: 'S ± S_err', color: '#58a6ff', data: hi, points: false, dash: [3, 3], width: 1 },
            { label: '', color: '#58a6ff', data: lo, points: false, dash: [3, 3], width: 1 }];   // one dashed band, one legend entry
        // the absolute alert is judged on mechanical skin when its basis says so: plot that series against its threshold
        if (sm.length) ds.push({ label: 'Mechanical skin', color: '#ffa657', data: sm, points: true });
        if (exc.length) ds.push({ label: 'Tests not used', color: '#6e7681', data: exc, points: true, width: 0.01 });
        if (low.length) ds.push({ label: 'Low tests excluded', color: '#8b949e', data: low, hollow: true });
        // hinge fit (onset model) through the used tests, weighted by 1/S_err²
        var on = tr.onset, Tm = B.trend;
        if (on && on.model === 'hinge' && uS.length >= 4 && Tm && typeof Tm.hinge === 'function') {
            try {
                var hg = Tm.hinge(uS.map(function (s) { return s.tDays; }), uS.map(function (s) { return s.S; }), uW);
                if (hg && hg.model === 'hinge' && _fin(hg.tau) && _fin(hg.a) && _fin(hg.b)) {
                    var j = _fin(hg.jump) ? hg.jump : 0, x0 = uS[0].tDays, xN = uS[uS.length - 1].tDays, hp = [{ x: x0, y: hg.a }, { x: hg.tau, y: hg.a }];
                    if (j) hp.push({ x: hg.tau, y: hg.a + j });
                    hp.push({ x: xN, y: hg.a + j + hg.b * Math.max(0, xN - hg.tau) });
                    ds.push({ label: 'Hinge fit (onset)', color: '#56d364', data: hp, points: false, width: 1.5 });
                }
            } catch (e) { /* display only */ }
        }
        var rec = tr.recent;
        if (rec && _fin(rec.slopePer30d) && used.length >= 2) {
            var xl = used[used.length - 1].x, yl = used[used.length - 1].y, xa = used[Math.max(0, used.length - (rec.n || 3))].x;
            ds.push({ label: 'Recent trend (Theil–Sen)', color: '#d2a8ff', data: [{ x: xa, y: yl - rec.slopePer30d * (xl - xa) / 30 }, { x: xl, y: yl }], points: false, width: 1.5 });
        }
        // dashed forecast from the latest point to the absolute threshold at the forecast date
        var fc = tr.forecast, base = sm.length ? sm : used;
        if (fc && fc.show && fc.date && /^\d{4}-\d{2}-\d{2}$/.test(String(fc.date)) && _fin(ab.threshold) && base.length) {
            var xf = _tDays(Date.parse(fc.date + 'T12:00:00Z'), a), lp = base[base.length - 1];
            if (_fin(xf) && xf > lp.x) ds.push({ label: 'Forecast to the absolute threshold', color: '#ff7b72', data: [{ x: lp.x, y: lp.y }, { x: xf, y: ab.threshold }], points: false, dash: [6, 4], width: 1.5 });
        }
        B.plot.trend(cv, { datasets: ds, thresholds: th, xLabel: 'Days since the first test', yLabel: mech ? 'Skin S and mechanical skin' : 'Skin S', yDec: 1 });
    }
    function _kChart(cv, a) {
        var ser = _seriesOf(a), pts = ser.filter(function (s) { return _fin(s.tDays) && _fin(s.k); }).map(function (s) { return { x: s.tDays, y: _cv(s.k, 'permeability') }; });
        var med = _median(pts.map(function (p) { return p.y; })), acc = (a.well && _fin(a.well.allocAccPct) ? a.well.allocAccPct : 5) / 100, th = [];
        if (med != null) th.push({ label: 'Median', y: med, color: '#8b949e' }, { label: 'Median + allocation accuracy', y: med * (1 + acc), color: '#6e7681' }, { label: 'Median − allocation accuracy', y: med * (1 - acc), color: '#6e7681' });
        B.plot.trend(cv, { datasets: [{ label: 'Permeability k', color: '#3fb950', data: pts, points: true }], thresholds: th, xLabel: 'Days since the first test', yLabel: 'k (' + _ul('permeability') + ')', yDec: 1 });
    }
    function _piChart(cv, a) {
        var ser = _seriesOf(a), pts = ser.filter(function (s) { return _fin(s.tDays) && _fin(s.pExt); }).map(function (s) { return { x: s.tDays, y: _cv(s.pExt, 'pressure') }; });
        var ds = [{ label: 'Extrapolated pressure at datum', color: '#58a6ff', data: pts, points: true }];
        var pt = a.trend && a.trend.pTrend;
        if (pt && pt.assessable && _fin(pt.slopePer30d) && pts.length >= 2) {
            var xm = _median(pts.map(function (p) { return p.x; })), ym = _median(pts.map(function (p) { return p.y; }));
            var s = (_cv(pt.slopePer30d, 'pressure') - _cv(0, 'pressure')) / 30, xa = pts[0].x, xb = pts[pts.length - 1].x;
            ds.push({ label: 'Theil–Sen line', color: '#d2a8ff', data: [{ x: xa, y: ym + s * (xa - xm) }, { x: xb, y: ym + s * (xb - xm) }], points: false, width: 1.5 });
        }
        // p* range bars when the production history before the data is estimated (pStarRangeDatum, or the test's
        // gauge-depth range moved to the datum by the test's own p*/p_ext depth shift)
        var bars = [], byId = {};
        ser.forEach(function (s) { byId[s.id] = s; });
        (a.tests || []).forEach(function (t) {
            var s = t && byId[t.id], r = t && t.result, f = r && r.final;
            if (!s || !_fin(s.tDays)) return;
            var rg = s.pStarRangeDatum || t.pStarRangeDatum || null, shift = 0;
            if (!rg && f) {
                rg = f.pStarRange || (r.line && r.line.pStarRange) || null;
                shift = (_fin(t.pStarDatum) && _fin(f.pStar)) ? t.pStarDatum - f.pStar : ((_fin(t.pExtDatum) && _fin(f.pExt)) ? t.pExtDatum - f.pExt : 0);
            }
            if (rg && _fin(rg.lo) && _fin(rg.hi)) bars.push({ x: s.tDays, lo: _cv(rg.lo + shift, 'pressure'), hi: _cv(rg.hi + shift, 'pressure') });
        });
        B.plot.trend(cv, { datasets: ds, bars: bars, barsLabel: 'p* range (estimated history)', barsColor: '#79c0ff', xLabel: 'Days since the first test', yLabel: 'Pressure (' + _ul('pressure') + ')' });   // tick decimals follow the p* scatter
    }
    function _jChart(cv, a) {
        var pc = a.trend && a.trend.piCheck, rows = pc && Array.isArray(pc.rows) ? pc.rows : [], pts = [];
        var byId = {};
        _seriesOf(a).forEach(function (s) { byId[s.id] = s.tDays; });
        rows.forEach(function (r) { var x0 = byId[r.from], x1 = byId[r.to]; if (_fin(x0) && _fin(x1) && _fin(r.RJ)) pts.push({ x: (x0 + x1) / 2, y: r.RJ }); });
        B.plot.trend(cv, { datasets: [{ label: 'PI ratio (observed / predicted)', color: '#3fb950', data: pts, points: true }],
            thresholds: [{ label: 'Lower limit 0.8', y: 0.8, color: '#e3b341' }, { label: 'Upper limit 1.25', y: 1.25, color: '#e3b341' }],
            xLabel: 'Days since the first test', yLabel: 'PI ratio (observed / predicted)', yDec: 2 });
    }
    function _pwfChart(cv, a) {
        var bub = a.trend && a.trend.bubble, rows = bub && Array.isArray(bub.rows) ? bub.rows : [], byId = {}, lo = [], hi = [];
        _seriesOf(a).forEach(function (s) { byId[s.id] = s.tDays; });
        rows.forEach(function (r) { var x = byId[r.id]; if (!_fin(x)) return; if (_fin(r.pwfSand_lo)) lo.push({ x: x, y: _cv(r.pwfSand_lo, 'pressure') }); if (_fin(r.pwfSand_hi)) hi.push({ x: x, y: _cv(r.pwfSand_hi, 'pressure') }); });
        var th = (a.well && _fin(a.well.Pb)) ? [{ label: 'Bubble point', y: _cv(a.well.Pb, 'pressure'), color: '#ff7b72' }] : [];
        B.plot.trend(cv, { datasets: [{ label: 'Sandface pressure at closing, low', color: '#58a6ff', data: lo, points: true }, { label: 'Sandface pressure at closing, high', color: '#d2a8ff', data: hi, points: true, dash: [4, 3] }],
            thresholds: th, xLabel: 'Days since the first test', yLabel: 'Pressure (' + _ul('pressure') + ')' });
    }
    function _ovChart(cv, a) {
        var used = {}, list = [];
        _seriesOf(a).forEach(function (s) { if (s.used && s.used.trend !== false) used[s.id] = 1; });
        var qc = (a.tests && a.tests[0] && a.tests[0].qUnit === 'Mscf/d') ? 'gasRateSmall' : 'liquidRate';
        (a.tests || []).forEach(function (t) {
            var r = t && t.result;
            if (!r || !r.bins || t.status !== 'interpreted' || (Object.keys(used).length && !used[t.id]) || !_fin(t.Dq) || t.Dq <= 0) return;
            var q = _cv(t.Dq, qc), full = r.bins.full || [];
            list.push({ id: t.id, dt: r.bins.dt || [], dpq: (r.bins.dp || []).map(function (v) { return _fin(v) ? _cv(Math.abs(v), 'pressure') / q : null; }),
                derivq: (r.bins.deriv || []).map(function (v, i) { return (_fin(v) && v > 0 && full[i] !== false) ? _cv(v, 'pressure') / q : null; }) });
        });
        B.plot.overlay(cv, list, { xLabel: 'Shut-in time Δt (h)', yLabel: 'Δp/q and derivative/q (' + _ul('pressure') + ' per ' + _ul(qc) + ')' });
    }
    function _rateChart(cv, a) {
        var pr = [], rq = [], ev = [];
        var rec = _mem.record && a.record && _mem.record.hash === a.record.hash ? _mem.record : null;
        var t0 = null;
        (a.tests || []).forEach(function (t) { if (t && _fin(t.tc_ms) && (t0 === null || t.tc_ms < t0)) t0 = t.tc_ms; });
        if (t0 === null) t0 = a.record ? a.record.origin_ms : 0;
        if (rec && rec.n) {
            var step = Math.max(1, Math.ceil(rec.n / 1500));
            for (var i = 0; i < rec.n; i += step) pr.push({ x: (rec.t[i] - t0) / 86400000, y: _cv(rec.p[i], 'pressure') });
        } else {
            (a.rates && a.rates.days || []).forEach(function (d) { if (_fin(d.pwfMean_psia)) pr.push({ x: ((d.t0_ms + d.t1_ms) / 2 - t0) / 86400000, y: _cv(d.pwfMean_psia, 'pressure') }); });
        }
        var ys = pr.map(function (p) { return p.y; }), pmin = ys.length ? Math.min.apply(null, ys) : 0, pmax = ys.length ? Math.max.apply(null, ys) : 1;
        var unit = a.rates && a.rates.unit === 'Mscf/d' ? 'gasRateSmall' : 'liquidRate';
        var qs = (a.rates && a.rates.days || []).map(function (d) { return d.q; }).filter(_fin), qmax = qs.length ? Math.max.apply(null, qs) : 0;
        if (qmax > 0) (a.rates.days || []).forEach(function (d) { if (_fin(d.q)) rq.push({ x: ((d.t0_ms + d.t1_ms) / 2 - t0) / 86400000, y: pmin + (d.q / qmax) * (pmax - pmin) * 0.9 }); });
        (a.tests || []).forEach(function (t) { if (t && _fin(t.tc_ms) && _fin(t.pwf0)) ev.push({ x: (t.tc_ms - t0) / 86400000, y: _cv(t.pwf0, 'pressure') }); });
        B.plot.trend(cv, { datasets: [{ label: 'Gauge pressure', color: '#58a6ff', data: pr, points: false, width: 1 },
            { label: 'Allocated rate (scaled, maximum ' + _nf(_cv(qmax, unit), 0) + ' ' + _ul(unit) + ')', color: '#3fb950', data: rq, points: false, width: 1.5 },
            { label: 'Closings', color: '#f0883e', data: ev, points: true, width: 0.01 }], xLabel: 'Days since the first test', yLabel: 'Pressure (' + _ul('pressure') + ')' });
    }
    function _blockChart(cv, b) {
        var ds = (b && b.series || []).map(function (s, i) {
            var pts = [];
            (s.x || []).forEach(function (x, j) { var y = s.y && s.y[j]; if (_fin(x) && _fin(y)) pts.push({ x: x, y: _cv(y, s.cat) }); });
            return { label: String(s.name || ''), color: (B.plot.PALETTE || [])[i % 12], data: pts, points: true };
        });
        B.plot.trend(cv, { datasets: ds, xLabel: 'Days since the first test', yLabel: (b && b.series && b.series[0] && b.series[0].name) || 'Value' });
    }
    function _drawOne(c) {
        var cv = _byId(c.id), a = _st && _st.analysis;
        if (!cv || !a || !B.plot) return;
        var m = /^bu_ch_(ll|sl)(?:_(B\d+))?$/i.exec(c.id);
        if (m) {
            var t = m[2] ? (a.tests || []).filter(function (x) { return x && String(x.id).toUpperCase() === m[2].toUpperCase(); })[0] : _selTest();
            if (m[1].toLowerCase() === 'll') _llChart(cv, t); else _slChart(cv, t, a);
            return;
        }
        var f = { bu_ch_skin: _skinChart, bu_ch_k: _kChart, bu_ch_pi: _piChart, bu_ch_j: _jChart, bu_ch_pwf: _pwfChart, bu_ch_ov: _ovChart, bu_ch_rate: _rateChart }[String(c.id).toLowerCase()];
        if (f) f(cv, a); else if (c.block) _blockChart(cv, c.block);
    }
    function _drawChartsAsync(list) {
        var tok = ++_chartTok, i = 0, n = list.length;
        if (!n) return;
        var job = {
            step: function () {
                if (tok === _chartTok && i < n) { try { _drawOne(list[i]); } catch (e) { if (typeof console !== 'undefined' && console.error) console.error('[buildup] chart ' + list[i].id, e); } }
                i++;
                return { done: i >= n || tok !== _chartTok, progress: Math.min(1, i / n), label: 'Drawing charts' };
            },
            result: function () { return null; }, cancel: function () { i = n; }
        };
        _drive(job, { shouldCancel: function () { return tok !== _chartTok || !_root(); } }).then(null, function () { /* superseded */ });
    }

    // ── publishing ───────────────────────────────────────────────────
    var RANK = { none: 0, possible: 1, provisional: 2, confirmed: 3 };
    function _publish(force) {
        var a = _st && _st.analysis;
        if (!a) return;
        var tests = (a.tests || []).filter(function (t) { return t && t.status === 'interpreted' && t.result && t.result.final; });
        var last = tests.length ? tests[tests.length - 1] : null, tr = a.trend || {}, al = tr.alerts || {}, d = al.delta || {}, ab = al.absolute || {};
        var code = (RANK[ab.status] || 0) > (RANK[d.status] || 0) ? ab.status : (d.status || 'none');
        var bS = tr.baseline && _fin(tr.baseline.S) ? tr.baseline.S : null;
        var ks = tests.map(function (t) { return t.result.final.k; });
        var stt = _status2();
        var st = {
            ok: !!a.ok, ts: Date.now(), wellId: _wellId(), nTests: (a.tests || []).length,
            latest: last ? { id: last.id, date: last.date, S: last.result.final.S, Serr: last.result.sErr ? last.result.sErr.value : null, k: last.result.final.k,
                conf: last.result.confidence ? last.result.confidence.headline : null } : null,
            baseline: { S: bS }, dS: (last && bS != null && _fin(last.result.final.S)) ? last.result.final.S - bS : null,
            delta: { status: d.status || 'none', at: d.confirmedAt || d.raisedAt || null },
            absolute: { status: ab.status || 'none', at: ab.confirmedAt || ab.raisedAt || null, basis: ab.basis || 'total' },
            alertCode: RANK[code] != null ? code : 'none', onsetDate: tr.onset ? tr.onset.date || null : null,
            recentPer30d: tr.recent && _fin(tr.recent.slopePer30d) ? tr.recent.slopePer30d : null,
            signed: stt === 'SIGNED', hash8: String(a.resultHash || '').slice(0, 8),
            kMedian: a.baseline && _fin(a.baseline.k) ? a.baseline.k : _median(ks)
        };
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.buildup = st;
        var key = JSON.stringify([st.latest, st.dS, st.alertCode, st.kMedian, st.signed, st.hash8]);
        if (force || key !== _lastPub) {
            _lastPub = key;
            var AS = G.WTS_pageAutosave;
            if (AS && typeof AS.flush === 'function' && typeof AS.page === 'function' && AS.page() === PG_KEY) { try { AS.flush(); } catch (e) { /* autosave is best effort */ } }
        }
    }
    function _emit(name, detail) {
        try { if (typeof document !== 'undefined' && document && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); } catch (e) { /* none */ }
    }
    function _emitUpdated() {
        var s = G.WTS_state && G.WTS_state.buildup;
        _emit('wts:buildup-updated', { wellId: _wellId(), ok: !!(s && s.ok), nTests: s ? s.nTests : 0, delta: s ? s.delta : null, absolute: s ? s.absolute : null, signed: !!(s && s.signed) });
    }
    // After any change of results, decisions or sign-off: transitions, save, render, publish, snapshot.
    function _afterChange(o) {
        o = o || {};
        var stt = _status2();
        if (_st.signoff && stt === 'CHANGED' && _st.lastStatus !== 'CHANGED') _audit({ kind: 'changed_after_signoff', target: null, value: { signedAt: _st.signoff.at || null } });
        _st.lastStatus = stt;
        _save();
        _fillTestSel();
        _renderResults({ charts: true });
        _checkStale(true);
        _publish(true);
        if (o.emit !== false) _emitUpdated();
        _snap();
    }

    // ── Analyse ──────────────────────────────────────────────────────
    function _clearErr() {
        var r = _root();
        if (r) _each(r.querySelectorAll('.input-err'), function (el) { el.classList.remove('input-err'); });
        var v = _byId('bu_val'); if (v) v.innerHTML = '';
    }
    function _showErr(g) {
        g.bad.forEach(function (id) { var e = _byId(id); if (e && e.classList) e.classList.add('input-err'); });
        var names = [];
        g.bad.forEach(function (id) { var n = _labelText(id); if (names.indexOf(n) === -1) names.push(n); });
        _status('bu_val', 'bad', 'Check these inputs before Analyse: ' + names.join(', ') + '. ' + (g.errors[0] || ''));
    }
    function _cancelRun() { if (_run) _run.cancelled = true; }
    function _shouldCancel(run, root) {
        return function () { return run.cancelled || !root.isConnected || run.token !== _token || _wellId() !== run.wellId; };
    }
    function analyse() {
        if (_run) return G.Promise.resolve(null);
        var root = _root();
        if (!root) return G.Promise.resolve(null);
        _ensure();
        _clearErr();
        var R = _Run();
        if (!R) { _status('bu_val', 'bad', 'The analysis engine is not loaded in this version, so the build-ups cannot be interpreted.'); return G.Promise.resolve(null); }
        var g0 = gather();
        if (g0.bad.length) { _showErr(g0); return G.Promise.resolve(null); }
        if (!g0.input.record && !g0.input.stored) {
            _status('bu_val', 'bad', (_st.analysis && (_st.missingTests || _st.partial)) ? 'The stored build-ups of this analysis are not on this device: re-import the gauge data (or open the project file that holds it), then press Analyse.'
                : 'Load gauge data first: a file, pasted data, a historian tag, the PRiSM dataset or the demo.');
            return G.Promise.resolve(null);
        }
        if (g0.input.rateTable === null && _val('bu_rate_mode') === 'table' && g0.input.record) { _status('bu_val', 'bad', 'Rate-table mode needs a rate column in the gauge data. Load a file with a rate column or use the daily allocation.'); return G.Promise.resolve(null); }
        _resolveZones();
        var g = gather(), input = g.input, ph = pageHash(input);
        var prevInput = _st.input, diff = _inputDiff(prevInput, _forState(input)), reason = '';
        if (_st.signoff && diff.length && typeof G.prompt === 'function') {
            try { reason = String(G.prompt('The inputs changed after the sign-off. Reason for the change (optional):', '') || '').slice(0, 290); } catch (e) { reason = ''; }
        }
        var wellId = _wellId(), run = { token: ++_token, wellId: wellId, cancelled: false };
        _run = run;
        _status('bu_progress', '', 'Analysing… 0 %');
        _buttons();
        var cancel = _shouldCancel(run, root), S = _store();
        var P = G.Promise.resolve();
        var rawStored = !input.record ? null : (_mem.rawStored && _mem.rawStored.hash === input.record.hash) ? _mem.rawStored.as
            : ((S && typeof S.engine === 'function' && S.engine() === 'idb' && S.rawHash(wellId) === input.record.hash) ? 'idb' : 'memory');
        if (input.record && S && typeof S.encodeJob === 'function' && S.rawHash(wellId) !== input.record.hash) {
            var rh = input.record.hash;
            P = _drive(S.encodeJob(input.record), { shouldCancel: cancel, onProgress: function (f) { _status('bu_progress', '', 'Analysing… 0 % — storing the raw gauge data (' + Math.round(f * 100) + ' %)'); } })
                .then(function (enc) { return S.putRaw(wellId, enc); })
                .then(function (r) {
                    rawStored = (r && r.ok) ? 'idb' : 'memory';
                    if (_wellId() === wellId) _mem.rawStored = { hash: rh, as: rawStored };
                });
        }
        // The engines get their own deep copy: they may annotate what they are given (allocation rows, overrides).
        var engIn = _engineInput(input);
        return P.then(function () {
            if (cancel()) throw { code: 'CANCELLED' };
            return R.analyseAsync(engIn, {
                cache: _st.analysis || null, shouldCancel: cancel,
                onProgress: function (f, lab) { _status('bu_progress', '', 'Analysing… ' + Math.round((_fin(f) ? f : 0) * 100) + ' %' + (lab ? ' — ' + lab : '')); }
            });
        }).then(function (analysis) {
            if (run.token !== _token || run.cancelled || _wellId() !== wellId || !root.isConnected) {   // discarded
                if (_run === run) { _run = null; _buttons(); }
                return null;
            }
            if (!analysis || analysis.ok === false) {
                _run = null;
                _status('bu_progress', 'bad', 'The analysis failed: ' + String((analysis && analysis.errors && analysis.errors[0]) || 'no result') + '. Previous results kept.');
                _buttons();
                return null;
            }
            if (analysis.record) analysis.record.rawStored = input.record ? rawStored : (analysis.record.rawStored || 'none');
            return _completeAsync(analysis, input, ph, diff, reason, run, cancel);
        }).then(null, function (e) {
            var mine = (_run === run);
            if (mine) _run = null;
            if (e && e.code === 'CANCELLED') { if (mine && _root()) _status('bu_progress', 'warn', 'Cancelled — previous results kept.'); }
            else if (mine && _root()) {
                if (typeof console !== 'undefined' && console.error) console.error('[buildup] analysis failed', e);
                _status('bu_progress', 'bad', 'The analysis stopped with an error; previous results kept.');
            }
            _buttons();
            return null;
        });
    }
    function _carryDecisions(prev, next) {
        if (!prev || !next || !Array.isArray(prev.findings) || !Array.isArray(next.findings)) return;
        // A decision follows its finding only while the finding quotes the same numbers (6 significant figures):
        // after a re-run that changes a value, the finding is open again for the reviewer.
        var vals = function (f) {
            var o = {}, vs = f.values || {};
            Object.keys(vs).forEach(function (k) { var x = vs[k]; o[k] = (x && typeof x === 'object' && _own(x, 'v')) ? x.v : x; });
            return _hash(o);
        };
        var key = function (f) { return f.rule + '|' + (f.where || '') + '|' + (f.ev || []).join(',') + '|' + vals(f); }, map = {};
        prev.findings.forEach(function (f) { if (f && f.decision) map[key(f)] = f.decision; });
        next.findings.forEach(function (f) { if (f && !f.decision && map[key(f)] && f.acceptable !== false) f.decision = map[key(f)]; });
    }
    // The end of Analyse in yielded units through the drive chain (plan §4.8: no long block after the last engine unit):
    //   1 review (evidence index + rules)   2 state applied, audit entries, saved   3 test list and report sections
    //   (charts follow one per unit)   4 publish, event, Quick Report snapshot, status line.
    // Units 1-2 discard the result on Cancel, navigation, a well switch or a newer run, as before; from unit 2 on the
    // result is applied and saved, so later units stop only for a well switch or a newer state (the render is then moot).
    var COMPLETE_LABELS = ['Reviewing the analysis', 'Saving', 'Rendering the report', 'Publishing'];
    function _completeAsync(analysis, input, ph, diff, reason, run, cancel) {
        var R = _R(), wellId = run.wellId, k = 0, stopped = false, st0 = null, rv = null, idx = null;
        var units = [
            function () {
                if (R && typeof R.evidence === 'function') { try { idx = R.evidence(analysis); } catch (e) { idx = null; } }
                if (R && typeof R.run === 'function') { try { rv = R.run(analysis, idx); } catch (e) { rv = null; } }
            },
            function () {
                _st.analysis = analysis;
                _st.partial = false;
                _st.missingTests = false;
                delete _st._raw;
                _idxCache = idx ? { a: analysis, idx: idx } : null;
                _carryDecisions(_st.review, rv);
                _st.review = rv;
                _st.input = _forState(input);
                _st.pageHash = ph;
                st0 = _st;
                _audit({ kind: 'run', target: null, value: { nTests: (analysis.tests || []).length, inputHash: analysis.inputHash, resultHash: analysis.resultHash } });
                if (diff && diff.length) _audit({ kind: 'input', target: null, value: diff, reason: reason || '' });
                var stt = _status2();
                if (_st.signoff && stt === 'CHANGED' && _st.lastStatus !== 'CHANGED') _audit({ kind: 'changed_after_signoff', target: null, value: { signedAt: _st.signoff.at || null } });
                _st.lastStatus = stt;
                _save();
            },
            function () {
                if (!_root()) return;
                _fillTestSel();
                _renderResults({ charts: true });
                _checkStale(true);
            },
            function () {
                _publish(true);
                _emitUpdated();
                if (!_root()) return;
                _snap();
                _status('bu_progress', 'ok', 'Analysis complete: ' + (analysis.tests || []).length + ' build-up tests.');
                var t = _byId('bu_s_S1');
                var tt = t && t.querySelector ? t.querySelector('.rbox-title') : null;
                if (tt && typeof tt.focus === 'function') { try { tt.focus(); } catch (e) { /* focus is best effort */ } }
            }
        ];
        var job = {
            step: function () {
                if (!stopped && k < units.length) { units[k](); k++; }
                return { done: stopped || k >= units.length, progress: k / units.length, label: COMPLETE_LABELS[Math.min(k, units.length - 1)] };
            },
            result: function () { return analysis; },
            cancel: function () { stopped = true; }
        };
        var shouldCancel = function () { return k < 2 ? cancel() : (_st !== st0 || _wellId() !== wellId || run.token !== _token); };
        return _drive(job, {
            shouldCancel: shouldCancel,
            onProgress: function (f, lab) { if (k < units.length && _root()) _status('bu_progress', '', 'Analysing… 100 % — ' + (lab || '')); }
        }).then(function () {
            if (_run === run) _run = null;
            _buttons();
            return analysis;
        }, function (e) {
            if (k >= 2) {             // applied and saved: a later stop only skips the render
                if (_run === run) _run = null;
                _buttons();
                return analysis;
            }
            throw e;                  // before the apply: discarded, as a cancelled run
        });
    }

    // ── data loading ─────────────────────────────────────────────────
    function _readFile(inp) {
        var f = inp && inp.files && inp.files[0];
        if (!f) return G.Promise.resolve(null);
        if (typeof f.text === 'function') return f.text().then(function (t) { return { name: f.name, text: t }; });
        return new G.Promise(function (res) {
            try {
                var fr = new FileReader();
                fr.onload = function () { res({ name: f.name, text: String(fr.result || '') }); };
                fr.onerror = function () { res(null); };
                fr.readAsText(f);
            } catch (e) { res(null); }
        });
    }
    function _fillMap(prefix, ids, headers, cols) {
        var box = _byId(prefix);
        if (!box) return;
        var pairs = [['-1', '—']].concat((headers || []).map(function (h, i) { return [String(i), String(h || ('Column ' + (i + 1))).slice(0, 60)]; }));
        ids.forEach(function (id, k) {
            var s = _byId(id[0]);
            if (!s) return;
            var c = cols && _fin(cols[id[1]]) ? String(cols[id[1]]) : '-1';
            s.innerHTML = _opts(pairs, c);
            s.value = c;
        });
        if (box.style) box.style.display = '';
    }
    var GMAP = [['bu_g_ct', 't'], ['bu_g_cp', 'p'], ['bu_g_cT', 'T'], ['bu_g_cq', 'q']];
    var AMAP = [['bu_a_cd', 'date'], ['bu_a_co', 'oil'], ['bu_a_cg', 'gas'], ['bu_a_cw', 'water'], ['bu_a_ch', 'hours']];
    function _mapCols(map) {
        var o = {}, any = false;
        map.forEach(function (m) { var v = parseInt(_val(m[0]), 10); o[m[1]] = _fin(v) ? v : -1; if (o[m[1]] >= 0) any = true; });
        return any ? o : null;
    }
    // A per-sample rate column becomes steps, so a rate table read from a long gauge file stays small in
    // wts_buildup_state. Consecutive rows within a tolerance of their segment's time-weighted mean rate merge into
    // one step at that mean (a measured, noisy rate column); zero-rate rows (shut-ins) never merge with flowing
    // ones; piecewise-constant rates are kept exactly. The tolerance grows (0.5 % → 10 %) until at most
    // RT_CAP steps remain. The last row is kept as the end of the table.
    var RT_TOLS = [0.005, 0.01, 0.02, 0.05, 0.1], RT_CAP = 2000;
    function _compactRatesTol(rows, tol) {
        var out = [], seg = null;
        var close = function () {
            if (!seg) return;
            var q = seg.same ? seg.q0 : (seg.dur > 0 ? seg.area / seg.dur : seg.q0);
            out.push({ t_ms: seg.t, q: seg.same ? q : Number(q.toPrecision(6)) });
        };
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i], nx = rows[i + 1], dur = nx ? Math.max(0, nx.t_ms - r.t_ms) : 0, zero = !(r.q > 0);
            if (seg) {
                var mean = seg.dur > 0 ? seg.area / seg.dur : seg.q0;
                var join = zero ? seg.zero : (!seg.zero && Math.abs(r.q - mean) <= tol * Math.abs(mean));
                if (join) { seg.area += r.q * dur; seg.dur += dur; if (r.q !== seg.q0) seg.same = false; continue; }
                close();
            }
            seg = { t: r.t_ms, q0: r.q, area: r.q * dur, dur: dur, zero: zero, same: true };
        }
        close();
        var last = rows[rows.length - 1];
        if (out.length && out[out.length - 1].t_ms !== last.t_ms) out.push({ t_ms: last.t_ms, q: out[out.length - 1].q });
        return out;
    }
    // Last resort for a column too noisy to merge within 10 %: time-weighted means over blocks of n rows (a block
    // still ends at every shut-in or reopening).
    function _blockRates(rows, n) {
        var out = [], seg = null;
        var close = function () { if (seg) out.push({ t_ms: seg.t, q: seg.zero ? 0 : Number((seg.dur > 0 ? seg.area / seg.dur : seg.q0).toPrecision(6)) }); };
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i], nx = rows[i + 1], dur = nx ? Math.max(0, nx.t_ms - r.t_ms) : 0, zero = !(r.q > 0);
            if (seg && seg.zero === zero && seg.k < n) { seg.area += r.q * dur; seg.dur += dur; seg.k++; continue; }
            close();
            seg = { t: r.t_ms, q0: r.q, area: r.q * dur, dur: dur, zero: zero, k: 1 };
        }
        close();
        var last = rows[rows.length - 1];
        if (out.length && out[out.length - 1].t_ms !== last.t_ms) out.push({ t_ms: last.t_ms, q: out[out.length - 1].q });
        return out;
    }
    function _compactRates(rt) {
        if (!rt || !rt.length) return null;
        var rows = [];
        for (var i = 0; i < rt.length; i++) { var r = rt[i]; if (r && _fin(r.t_ms) && _fin(r.q)) rows.push({ t_ms: r.t_ms, q: r.q }); }
        if (!rows.length) return null;
        var out = rows;
        for (var k = 0; k < RT_TOLS.length; k++) { out = _compactRatesTol(rows, RT_TOLS[k]); if (out.length <= RT_CAP) break; }
        for (var n = Math.ceil(rows.length / (0.8 * RT_CAP)); out.length > RT_CAP && n <= rows.length; n *= 2) out = _blockRates(rows, n);
        return out.length ? out : null;
    }
    PG._compactRates = _compactRates;
    function _setRecord(rec, rateTable, name, hasRate) {
        _ensure();
        _mem.record = rec;
        _mem.rateTable = _compactRates(rateTable);
        _mem.rawChecked = true;
        var rn = _byId('bu_raw_note'); if (rn) rn.textContent = '';
        _audit({ kind: 'import', target: null, value: { name: String(name || rec.name || '').slice(0, 80), n: rec.n || 0, hash: rec.hash || null, source: rec.source || '' } });
        var proposed = false;
        if ((_mem.rateTable || hasRate) && !_mem.allocation && _val('bu_rate_mode') !== 'table') {
            var rm = _byId('bu_rate_mode'); if (rm) rm.value = 'table';
            proposed = true;
        }
        var n = rec.n || (rec.t ? rec.t.length : 0);
        var txt = 'Loaded ' + _nf(n, 0) + ' samples' + (rec.name ? ' from ' + rec.name : '') + '.' +
            (proposed ? ' The data has a rate column, so rate-table mode is proposed (switch back to the daily allocation if you have one).' : '');
        _status('bu_g_status', 'ok', txt);
        _syncUi();
        _checkStale();
    }
    function _parseGauge(text, name, source) {
        var D = _D();
        if (!D || !(typeof D.parseJob === 'function' || typeof D.parse === 'function')) { _status('bu_g_status', 'bad', 'The data reader is not loaded in this version.'); return G.Promise.resolve(null); }
        if (!text || !String(text).trim()) { _status('bu_g_status', 'bad', 'No gauge data: choose a file or paste the data first.'); return G.Promise.resolve(null); }
        var sn = null, sameText = _mem.recordText === text;
        try { sn = (typeof D.sniff === 'function') ? D.sniff(String(text).slice(0, 65536)) : null; } catch (e) { sn = null; }
        if (sn && !sameText) _fillMap('bu_g_map', GMAP, sn.headers, sn.cols);
        var cols = sameText ? (_mapCols(GMAP) || (sn && sn.cols)) : (sn && sn.cols) || _mapCols(GMAP);
        var tf = _val('bu_g_tfmt');
        _ensure();
        var zone = _gaugeZone(false);                                  // the zone this record is read in
        var t0 = _localToMs(String(_val('bu_g_t0') || '2026-01-01T00:00'), zone);   // elapsed-time start: wall clock in that zone
        var opts = { cols: cols || null, timeFormat: tf === 'auto' ? ((sn && sn.timeFormat) || null) : tf, t0_ms: _fin(t0) ? t0 : Date.UTC(2026, 0, 1) - _offMs(zone, Date.UTC(2026, 0, 1)),
            zone: zone, pUnit: _val('bu_g_punit') || 'psia', patm: _readNum('bu_patm').v || 14.696, source: source || 'csv', name: name || '' };
        _mem.recordText = text;
        _status('bu_g_status', '', 'Reading the gauge data… 0 %');
        var P;
        if (typeof D.parseJob === 'function') {
            P = _drive(D.parseJob(text, opts), { shouldCancel: function () { return !_root(); }, onProgress: function (f) { _status('bu_g_status', '', 'Reading the gauge data… ' + Math.round((f || 0) * 100) + ' %'); } });
        } else {
            P = new G.Promise(function (res) { res(D.parse(text, opts)); });
        }
        return P.then(function (r) {
            var rec = r && (r.record || (r.ok && r.t ? r : null));
            if (!rec || rec.ok === false || !(rec.n || (rec.t && rec.t.length))) {
                _status('bu_g_status', 'bad', 'The gauge data could not be read: ' + ((r && r.errors && r.errors[0]) || (rec && rec.errors && rec.errors[0]) || 'check the columns and the time format') + '.');
                return null;
            }
            if (!rec.source) rec.source = source || 'csv';
            if (!rec.name) rec.name = name || '';
            _setRecord(rec, r.rateTable || null, name, !!(sn && sn.hasRate));
            return rec;
        }, function (e) {
            if (e && e.code === 'CANCELLED') return null;
            _status('bu_g_status', 'bad', 'The gauge data could not be read.');
            return null;
        });
    }
    function _loadGauge() {
        var src = _val('bu_src');
        if (src === 'paste') return _parseGauge(_val('bu_g_paste'), 'pasted data', 'paste');
        var inp = _byId('bu_g_file'), f = inp && inp.files && inp.files[0];
        if (f && /\.xlsx$/i.test(f.name || '')) { _status('bu_g_status', 'warn', 'Spreadsheets need the online spreadsheet reader; save the sheet as CSV (CSV works offline).'); return G.Promise.resolve(null); }
        return _readFile(inp).then(function (r) {
            if (!r) { _status('bu_g_status', 'bad', 'Choose a gauge file first.'); return null; }
            return _parseGauge(r.text, r.name, 'csv');
        });
    }
    function _loadHistorian() {
        var D = _D(), tag = _val('bu_h_tag');
        if (!D || typeof D.fromHistorian !== 'function') return;
        if (!tag) { _status('bu_g_status', 'bad', 'Choose a historian tag first.'); return; }
        var gz = _gaugeZone(false), to = _localToMs(_val('bu_h_to'), gz), from = _localToMs(_val('bu_h_from'), gz);   // typed in the gauge zone
        if (!_fin(to)) to = Date.now();
        if (!_fin(from)) from = to - 30 * 86400000;
        _status('bu_g_status', '', 'Reading the historian…');
        G.Promise.resolve(D.fromHistorian({ tag: tag, from_ms: from, to_ms: to, patm: _readNum('bu_patm').v || 14.696 })).then(function (rec) {
            if (!rec || rec.ok === false) { _status('bu_g_status', 'bad', 'No historian data for that tag and period.'); return; }
            var badge = _byId('bu_h_load'); if (badge) badge.textContent = 'Load from historian';
            _setRecord(rec, null, tag);
        }, function () { _status('bu_g_status', 'bad', 'The historian could not be read.'); });
    }
    function _loadPrism() {
        var D = _D();
        if (!D || typeof D.fromPRiSM !== 'function') return;
        var r = null;
        _ensure();
        var t0 = _localToMs(String(_val('bu_g_t0') || '2026-01-01T00:00'), _gaugeZone(false));
        try { r = D.fromPRiSM({ t0_ms: _fin(t0) ? t0 : Date.UTC(2026, 0, 1) }); } catch (e) { r = null; }
        if (!r || !r.record || r.record.ok === false) { _status('bu_g_status', 'bad', 'PRiSM has no dataset loaded.'); return; }
        _setRecord(r.record, r.rateTable || null, 'PRiSM dataset');
    }
    function _applyWell(w) {
        if (!w) return;
        var set = function (id, v) { if (_fin(v)) { _setVal(id, v); _st.touched[id] = 1; } };
        if (w.fluid) { var f = _byId('bu_fluid'); if (f) f.value = ({ oil: 'oil', gas: 'gas', water_inj: 'water_inj', water: 'water_inj' })[w.fluid] || 'oil'; }
        set('bu_h', w.h); set('bu_phi', w.phi); set('bu_mu', w.mu); set('bu_B', w.B); set('bu_ct', _fin(w.ct) ? w.ct * 1e6 : null); set('bu_rw', w.rw); set('bu_re', w.re_ft);
        set('bu_pb', w.Pb); set('bu_rs', w.Rs); set('bu_bw', w.Bw); set('bu_muw', w.muw); set('bu_alloc_acc', w.allocAccPct); set('bu_drift', w.driftPsiPerDay);
        if (w.gas) { set('bu_sg', w.gas.sg); set('bu_tres', w.gas.T_F); set('bu_co2', w.gas.co2); set('bu_h2s', w.gas.h2s); set('bu_n2', w.gas.n2); set('bu_pdew', w.gas.pdew); var pt = _byId('bu_ptime'); if (pt) pt.checked = !!w.gas.pseudoTime; }
    }
    // The demo's history option and zones (synth metadata, §3.7 AnalysisInput.history / zones) → page inputs, so a
    // loaded demo always passes the input check: a history mode is applied only with what it needs (a production
    // start date, or a cumulative in the rate's field unit: STB, or Mscf shown as MMscf), otherwise "unknown".
    // The production days and gauge times of a demo are in its own zones (UTC), whatever this device's zone is.
    function _applyDemoMeta(d) {
        var h = (d && d.history) || {}, fl = _val('bu_fluid') || 'oil', mode = 'unknown';
        var hdate = typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date) ? h.date : '';
        if (h.mode === 'date' && hdate) {
            mode = 'date';
            var de = _byId('bu_hist_date'); if (de) de.value = hdate;
        } else if (h.mode === 'cum' && _fin(h.cum) && h.cum >= 0) {
            mode = 'cum';
            if (fl === 'gas') _setVal('bu_hist_cumg', h.cum / 1000); else _setVal('bu_hist_cumo', h.cum);
        }
        var hm = _byId('bu_hist_mode'); if (hm) hm.value = mode;
        var z = (d && d.zones) || {}, day = z.day || {};
        var zsel = function (selId, offId, zone) {
            if (!zone || !zone.mode) return;
            var e = _byId(selId);
            if (!e) return;
            if (zone.mode === 'utc') e.value = 'utc';
            else if (zone.mode === 'fixed' && _fin(zone.offset_h)) { e.value = 'fixed'; _setVal(offId, zone.offset_h); }
        };
        zsel('bu_g_tz', 'bu_g_tzoff', z.gauge);
        zsel('bu_pd_tz', 'bu_pd_tzoff', day.zone);
        if (_fin(day.startHour)) _setVal('bu_pd_start', day.startHour);
        // a short note for the allocation status: what was set (fixed strings and a validated date only)
        var note = [];
        if (mode === 'date') note.push('production start ' + hdate);
        if (day.zone && (day.zone.mode === 'utc' || day.zone.mode === 'fixed')) note.push('production days in ' + _zoneName(day.zone));
        return note.join('; ');
    }
    function _loadDemo() {
        var S = _Syn();
        if (!S) return;
        var kind = _val('bu_demo_kind') === 'gas' ? 'gas' : 'oil', d = null;
        _status('bu_g_status', '', 'Building the demo data…');
        try { d = S.demo(kind); } catch (e) { d = null; }
        if (!d || !d.record) { _status('bu_g_status', 'bad', 'The demo data could not be built.'); return; }
        _ensure();
        var rec = d.record;
        if (!rec.source) rec.source = 'demo';
        var al = d.allocation;
        _mem.allocation = Array.isArray(al) ? { rows: al, gUnit: 'Mscf', resolution: { oil: null, gas: null, water: null } } : (al && al.rows ? { rows: al.rows, gUnit: al.gUnit || 'Mscf', resolution: al.resolution || { oil: null, gas: null, water: null } } : null);
        var rm = _byId('bu_rate_mode'); if (rm) rm.value = _mem.allocation ? 'daily' : 'table';
        _applyWell(d.well);
        var c = d.completion;
        if (c) {
            var cb = _byId('bu_cmp_on'); if (cb) cb.checked = true;
            _setVal('bu_cmp_hp', c.hp_ft); _setVal('bu_cmp_htop', c.htop_ft); _setVal('bu_cmp_theta', c.theta_deg);
            if (c.kvkh) { _setVal('bu_cmp_kvlo', c.kvkh[0]); _setVal('bu_cmp_kvhi', c.kvkh[1]); }
        }
        var meta = _applyDemoMeta(d);
        var as = _byId('bu_a_status');
        if (as) { as.setAttribute('data-msg', '1'); _status('bu_a_status', 'ok', (_mem.allocation ? 'Demo allocation: ' + _mem.allocation.rows.length + ' days' : 'Demo rates come from the rate table') + (meta ? ' (' + meta + ').' : '.')); }
        _setRecord(rec, d.rateTable || null, d.name || ('Demo ' + kind));
    }
    function _parseAlloc(text, name) {
        var D = _D();
        if (!D || typeof D.parseAllocation !== 'function') return;
        if (!text || !String(text).trim()) { _status('bu_a_status', 'bad', 'No allocation data: choose a file or paste the data first.'); return; }
        var same = _mem.allocText === text, r = null;
        try {
            r = D.parseAllocation(text, { cols: same ? _mapCols(AMAP) : null, gUnit: _val('bu_a_gunit') || 'Mscf', dayFirst: _checked('bu_a_dayfirst'),
                waterCondensed: _val('bu_fluid') === 'gas' && _checked('bu_a_wcond') });
        } catch (e) { r = null; }
        _mem.allocText = text;
        var as = _byId('bu_a_status'); if (as) as.setAttribute('data-msg', '1');
        if (!r || !r.ok || !r.rows || !r.rows.length) { _status('bu_a_status', 'bad', 'The allocation could not be read: ' + ((r && r.errors && r.errors[0] && (r.errors[0].text || r.errors[0])) || 'check the date and volume columns') + '.'); return; }
        if (r.cols || r.headers) _fillMap('bu_a_map', AMAP, r.headers || [], r.cols || {});
        _ensure();
        _mem.allocation = { rows: r.rows, gUnit: r.gUnit || _val('bu_a_gunit') || 'Mscf', resolution: r.resolution || { oil: null, gas: null, water: null } };
        _status('bu_a_status', r.errors && r.errors.length ? 'warn' : 'ok', 'Loaded ' + r.rows.length + ' days of allocation' + (name ? ' from ' + name : '') + (r.errors && r.errors.length ? '; ' + r.errors.length + ' lines skipped' : '') + '.');
        var rm = _byId('bu_rate_mode'); if (rm) rm.value = 'daily';
        _syncUi();
        _checkStale();
    }
    function _loadAlloc() {
        if (_val('bu_a_paste').trim()) { _parseAlloc(_val('bu_a_paste'), 'pasted data'); return; }
        _readFile(_byId('bu_a_file')).then(function (r) {
            if (!r) { _status('bu_a_status', 'bad', 'Choose an allocation file or paste the data first.'); return; }
            _parseAlloc(r.text, r.name);
        });
    }
    function _copyPrismWell() {
        if (typeof G.PRiSM_getWell !== 'function') return;
        var w = null;
        try { w = G.PRiSM_getWell(); } catch (e) { w = null; }
        if (!w) return;
        var got = { fluid: w.fluid === 'gas' ? 'gas' : (w.testType === 'falloff' ? 'water_inj' : 'oil'), h: w.h, phi: w.phi, mu: w.mu, B: w.B, ct: w.ct, rw: w.rw };
        _applyWell(got);
        var names = { h: 'net pay', phi: 'porosity', mu: 'viscosity', B: 'volume factor', ct: 'compressibility', rw: 'wellbore radius' }, copied = Object.keys(names).filter(function (k) { return _fin(got[k]); });
        _status('bu_well_status', copied.length ? 'ok' : 'warn', copied.length ? 'Copied from the PRiSM well inputs: ' + copied.map(function (k) { return names[k]; }).join(', ') + '.' : 'The PRiSM well inputs hold no values to copy.');
        _syncUi();
        _checkStale();
    }
    function _loadRawAsync() {
        var S = _store(), a = _st && _st.analysis, wid = _wellId();
        if (!S || typeof S.getRaw !== 'function') return;
        if (_mem.record) { _mem.rawChecked = true; return; }
        S.getRaw(wid).then(function (rec) {
            if (!_root() || _wellId() !== wid || _mem.record) return;
            var cur = _st && _st.analysis;
            // getRaw re-hashes the decoded samples (hashVerified): a stored label alone never makes a record "the analysis's"
            if (rec && rec.hashVerified === true && cur && cur.record && rec.hash && rec.hash === cur.record.hash) {
                _mem.record = rec; _mem.rawChecked = true;
                _mem.rawStored = { hash: rec.hash, as: (typeof S.engine === 'function' && S.engine() === 'idb') ? 'idb' : 'memory' };
                return;
            }
            _mem.rawChecked = true;
            var n = _byId('bu_raw_note');
            if (n && cur) n.textContent = 'Raw gauge data is not embedded for this well — re-import it to re-run detection; interpretation and trend reproduce from the stored build-ups.';
        }, function () { /* memory only */ });
        return a;
    }
    function _rehydrateAsync() {
        var S = _store();
        if (!_st || !_st.partial || !S || typeof S.rehydrate !== 'function') return;
        var wid = _wellId(), raw = _st._raw;
        S.rehydrate(raw).then(function (st) {
            if (!_st || _st._raw !== raw || _wellId() !== wid) return;
            _st.partial = false;
            delete _st._raw;
            _idxCache = null;
            if (st && st.analysis && !st.overflowMissing) { _st.analysis = st.analysis; _st.missingTests = false; }
            else {
                // The parked per-test detail is not on this device (no IndexedDB, another device, cleared site data):
                // keep the analysis and render it from the per-test summaries the state holds.
                _st.missingTests = true;
            }
            if (!_root()) return;
            if (_st.missingTests) _status('bu_progress', 'warn', DETAIL_MISSING);
            _fillTestSel();
            _renderResults({ charts: true });
            _publish();
        }, function () { if (_st && _st._raw === raw) { _st.partial = false; delete _st._raw; _st.missingTests = true; if (_root()) { _renderResults({ charts: true }); _publish(); } } });
    }
    function _loadTags() {
        var H = G.WTS_historian, sel = _byId('bu_h_tag');
        if (!H || typeof H.listTags !== 'function' || !sel) return;
        G.Promise.resolve(H.listTags()).then(function (tags) {
            if (!_root() || !Array.isArray(tags)) return;
            var cur = sel.value;
            var pairs = [['', '—']].concat(tags.map(function (t) { var n = (t && typeof t === 'object') ? (t.name || t.tag) : t; return [String(n), String(n)]; }).filter(function (p) { return p[0]; }));
            sel.innerHTML = _opts(pairs, cur);
        }, function () { /* no historian */ });
    }

    // ── dialog: overrides, decisions, missed shut-ins ────────────────
    function _who() {
        var n = String(_val('bu_eng')).trim();
        if (n) return n;
        if (typeof G.prompt === 'function') {
            var p = null;
            try { p = G.prompt('Your name for the audit trail:', ''); } catch (e) { p = null; }
            p = String(p || '').trim().slice(0, 80);
            if (p) { var e = _byId('bu_eng'); if (e) e.value = p; return p; }
        }
        return '';
    }
    function _testById(id) { var a = _st && _st.analysis; return a ? (a.tests || []).filter(function (t) { return t && t.id === id; })[0] || null : null; }
    function _dlgOpen(ctx, opener) {
        var d = _byId('bu_dlg');
        if (!d) return;
        _dlgCtx = { ctx: ctx, opener: opener || null };
        var title = _byId('bu_dlg_title'), body = _byId('bu_dlg_body'), act = _byId('bu_dlg_act');
        var pairs = [], gz = _gaugeZone();
        var tl = _byId('bu_dlg_time'), tlw = tl && tl.closest ? tl.closest('.fg-item') : null, tll = tlw && tlw.querySelector ? tlw.querySelector('label') : null;
        if (tll) tll.textContent = 'Closing time (' + _zoneName(gz) + ')';
        if (ctx.kind === 'test') {
            var t = _testById(ctx.test);
            if (title) title.textContent = 'Build-up ' + ctx.test;
            var excluded = t && t.status === 'excluded';
            pairs.push(excluded ? ['include', 'Include this test'] : ['exclude', 'Exclude this test']);
            pairs.push(['window', 'Edit the IARF window'], ['model', 'Force a model'], ['event_drop', 'Drop this shut-in'], ['tc', 'Set the closing time']);
            (_st.overrides || []).forEach(function (o) { if (o && (o.target === ctx.test || (t && o.target === t.eventId))) pairs.push(['remove:' + o.id, 'Remove override ' + o.id + ' (' + o.kind + ')']); });
            if (body) body.textContent = t ? (t.date || '') + ' · ' + String(t.status).replace('_', ' ') + (t.statusReason ? ' · ' + t.statusReason : '') : '';
            var r = t && t.result;
            var e0 = _byId('bu_dlg_t0'), e1 = _byId('bu_dlg_t1');
            if (e0) e0.value = r && r.iarf && _fin(r.iarf.dt0_h) ? String(Number(r.iarf.dt0_h.toPrecision(4))) : '';
            if (e1) e1.value = r && r.iarf && _fin(r.iarf.dt1_h) ? String(Number(r.iarf.dt1_h.toPrecision(4))) : '';
            var md = _byId('bu_dlg_model'); if (md) md.value = r && r.chosen && MODEL_LABEL[r.chosen.key] ? r.chosen.key : 'homogeneous';
            var tm = _byId('bu_dlg_time'); if (tm) tm.value = t && _fin(t.tc_ms) ? _msToLocal(t.tc_ms, gz) : '';
        } else if (ctx.kind === 'findings') {
            if (title) title.textContent = 'Review findings ' + ctx.f.join(', ');
            pairs.push(['accept', 'Accept'], ['reject', 'Reject (with a note)'], ['note', 'Add a note']);
            var fs = ((_st.review && _st.review.findings) || []).filter(function (f) { return f && ctx.f.indexOf(f.id) !== -1; });
            if (body) body.textContent = fs.map(function (f) { return f.id + ' (' + f.rule + ', ' + f.severity + '): ' + _cleanTxt(_fill(f.template, f.values)); }).join(' · ').slice(0, 600);
        } else {
            if (title) title.textContent = 'Add a missed shut-in';
            pairs.push(['event_add', 'Typed closing time']);
            var m = _st.analysis && _st.analysis.missed;
            (m && m.subThreshold || []).slice(0, 20).forEach(function (s, i) { if (_fin(s.t_ms)) pairs.push(['missed:' + s.t_ms, 'Possible shut-in ' + _msToLocal(s.t_ms, gz).replace('T', ' ') + ' ' + _zoneName(gz) + ' (rise ' + fmt(s.dp_psi, 'pressure', 1) + ')']); });
            if (body) body.textContent = 'The next Analyse adds the shut-in as a new event and interprets it.';
            var tm2 = _byId('bu_dlg_time'); if (tm2) tm2.value = '';
        }
        if (act) { act.innerHTML = _opts(pairs, pairs[0] ? pairs[0][0] : ''); act.value = pairs[0] ? pairs[0][0] : ''; }
        var rs = _byId('bu_dlg_reason'); if (rs) rs.value = '';
        _status('bu_dlg_msg', '', '');
        _dlgFields();
        var modal = false;
        if (typeof d.showModal === 'function') { try { d.showModal(); modal = true; } catch (e) { modal = false; } }
        if (!modal) d.setAttribute('open', '');
        if (act && typeof act.focus === 'function') { try { act.focus(); } catch (e) { /* best effort */ } }
    }
    function _dlgFields() {
        var a = _val('bu_dlg_act');
        _vis('bu_dlg_t0', a === 'window'); _vis('bu_dlg_t1', a === 'window'); _vis('bu_dlg_model', a === 'model');
        _vis('bu_dlg_time', a === 'tc' || a === 'event_add');
    }
    function _dlgClose() {
        var d = _byId('bu_dlg'), c = _dlgCtx;
        _dlgCtx = null;
        if (d) {
            if (typeof d.close === 'function' && d.open) { try { d.close(); } catch (e) { /* attribute below */ } }
            d.removeAttribute('open');
        }
        var op = c && c.opener;
        if (op && op.isConnected === false && op.getAttribute) {   // the row may have been re-rendered: find its new button
            var safe = function (s) { return String(s || '').replace(/[^A-Za-z0-9,_·-]/g, ''); };
            var sel = op.getAttribute('data-test') ? '[data-act="menu"][data-test="' + safe(op.getAttribute('data-test')) + '"]' : (op.getAttribute('data-f') ? '[data-act="menu"][data-f="' + safe(op.getAttribute('data-f')) + '"]' : null);
            var r = _root(); op = sel && r ? r.querySelector(sel) : (op.id ? _byId(op.id) : null);
            if (!op && c.ctx && c.ctx.kind === 'findings') op = _byId('bu_s_S9') && _byId('bu_s_S9').querySelector('.rbox-title');   // the findings were decided away
        }
        if (op && typeof op.focus === 'function') { try { op.focus(); } catch (e) { /* best effort */ } }
    }
    function _nextOv() {
        var n = _st.ovSeq || 0;
        (_st.overrides || []).forEach(function (o) { var m = /^O(\d+)$/.exec(o.id || ''); if (m) n = Math.max(n, +m[1]); });
        _st.ovSeq = n + 1;
        return 'O' + (n + 1);
    }
    function _dlgOk() {
        var c = _dlgCtx;
        if (!c) { _dlgClose(); return; }
        var act = _val('bu_dlg_act'), reason = String(_val('bu_dlg_reason')).trim();
        var ctx = c.ctx;
        if (ctx.kind === 'findings') {
            if ((act === 'reject' || act === 'note') && reason.length < 5) { _status('bu_dlg_msg', 'bad', 'A note of at least 5 characters is required.'); return; }
            var who = _who();
            if (!who) { _status('bu_dlg_msg', 'bad', 'Enter your name in the Engineer field first.'); return; }
            var at = _nowIso(), targets = ((_st.review && _st.review.findings) || []).filter(function (f) {
                return f && ctx.f.indexOf(f.id) !== -1 && !(f.acceptable === false && act === 'accept');   // a V14 finding cannot be accepted
            });
            if (!targets.length) { _status('bu_dlg_msg', 'bad', 'This finding cannot be accepted: re-run the analysis to clear it.'); return; }
            // the audit entry is written first: without it nothing is changed
            if (!_audit({ kind: 'decision', target: targets.map(function (f) { return f.id; }).join(','), value: act, reason: reason, who: who })) { _status('bu_dlg_msg', 'bad', AUDIT_FAIL); return; }
            targets.forEach(function (f) { f.decision = { d: act, note: reason, who: who, at: at }; });
            _afterChange({});     // re-render first, so the focus goes to the re-rendered Actions… button
            _dlgClose();
            return;
        }
        if (reason.length < 5) { _status('bu_dlg_msg', 'bad', 'A reason of at least 5 characters is required.'); return; }
        var who2 = _who();
        if (!who2) { _status('bu_dlg_msg', 'bad', 'Enter your name in the Engineer field first.'); return; }
        if (/^remove:/.test(act)) {
            var oid = act.slice(7), o = (_st.overrides || []).filter(function (x) { return x.id === oid; })[0];
            if (!_audit({ kind: 'override_removed', target: o ? o.target : null, value: oid, reason: reason, who: who2 })) { _status('bu_dlg_msg', 'bad', AUDIT_FAIL); return; }
            _st.overrides = (_st.overrides || []).filter(function (x) { return x.id !== oid; });
        } else {
            var t = ctx.kind === 'test' ? _testById(ctx.test) : null, ov = { id: '', kind: act, target: null, value: true, reason: reason.slice(0, 290), who: who2, at: _nowIso(), appVersion: _appVer() };
            if (act === 'exclude' || act === 'include') ov.target = ctx.test;
            else if (act === 'window') {
                var t0 = _parse(_val('bu_dlg_t0')), t1 = _parse(_val('bu_dlg_t1'));
                if (!(_fin(t0) && _fin(t1) && t0 > 0 && t1 > t0 * 1.2)) { _status('bu_dlg_msg', 'bad', 'Enter a window start and an end at least 20 % later, in hours of shut-in time.'); return; }
                ov.target = ctx.test; ov.value = { dt0_h: t0, dt1_h: t1 };
            } else if (act === 'model') { ov.target = ctx.test; ov.value = MODEL_LABEL[_val('bu_dlg_model')] ? _val('bu_dlg_model') : 'homogeneous'; }
            else if (act === 'event_drop') ov.target = t ? t.eventId : null;
            else if (act === 'tc' || act === 'event_add' || /^missed:/.test(act)) {
                var listed = /^missed:/.test(act);
                var tm = listed ? Number(act.slice(7)) : _localToMs(_val('bu_dlg_time'), _gaugeZone());   // typed in the gauge zone
                if (!_fin(tm)) { _status('bu_dlg_msg', 'bad', 'Enter the closing time.'); return; }
                if (act === 'tc') { ov.target = t ? t.eventId : null; ov.value = { tc_ms: tm }; }
                else { ov.kind = 'event_add'; ov.target = null; ov.value = listed ? { t_ms: tm } : { t_ms: tm, exact: true }; }   // a listed step is refined
            }
            if (ov.kind !== 'event_add' && !ov.target) { _status('bu_dlg_msg', 'bad', 'This action needs a test.'); return; }
            var seq0 = _st.ovSeq;
            ov.id = _nextOv();
            if (!_audit({ kind: 'override', target: ov.target, value: { id: ov.id, kind: ov.kind, value: ov.value }, reason: ov.reason, who: who2 })) {
                _st.ovSeq = seq0;
                _status('bu_dlg_msg', 'bad', AUDIT_FAIL);
                return;
            }
            _st.overrides = (_st.overrides || []).concat([ov]);
        }
        _save();
        _checkStale();
        _renderResults({ charts: false });
        _status('bu_progress', 'warn', 'Override recorded: press Analyse to apply it (only the affected tests are re-run).');
        _dlgClose();          // after the re-render: focus returns to the new Actions… button of the row
    }

    // ── sign-off, questions, export, validation, PRiSM ───────────────
    function _signOff() {
        var R = _R(), a = _st && _st.analysis;
        if (!R || !a) return;
        var form = { name: String(_val('bu_so_name')).trim().slice(0, 80), role: String(_val('bu_so_role')).trim().slice(0, 80), statement: _checked('bu_so_ok') };
        if (!form.name) { _status('bu_so_status', 'bad', 'Enter the name of the person signing off.'); return; }
        if (!form.statement) { _status('bu_so_status', 'bad', 'Tick the statement that the analysis and the findings were reviewed.'); return; }
        if (_isStale) { _status('bu_so_status', 'bad', 'The inputs changed since the last analysis: press Analyse before signing off.'); return; }
        var cs = typeof R.canSign === 'function' ? R.canSign(_st.review) : { ok: true, open: [] };
        if (!cs || !cs.ok) { _status('bu_so_status', 'bad', 'Decide the open findings first (critical and major findings need a decision, a rejection needs a note): ' + ((cs && cs.open) || []).join(', ') + '.'); return; }
        // A chain that does not verify (S10 ⚠) blocks a sign-off until the analysis has been re-run after the damaged entry.
        var ast = _auditStatus();
        if (ast && ast.state === 'broken' && !(_fin(ast.lastRunSeq) && _fin(ast.brokenAt) && ast.lastRunSeq > ast.brokenAt)) {
            _status('bu_so_status', 'bad', 'The audit trail does not verify at entry #' + (_fin(ast.brokenAt) ? ast.brokenAt : '?') + ' (edited or damaged after it was written): press Analyse to re-run the analysis, then sign off.');
            return;
        }
        var so = null;
        try { so = R.signoff(form, a, _st.review); } catch (e) { so = null; }
        if (!so || so.ok === false) {
            var why = { OPEN_FINDINGS: 'open findings remain', EVIDENCE_CHECK_FAILED: 'the evidence check failed; re-run the analysis', NO_NAME: 'a name is required', NO_STATEMENT: 'the statement is required' }[so && so.code] || 'the sign-off was refused';
            _status('bu_so_status', 'bad', 'Not signed: ' + why + '.');
            return;
        }
        // the audit entry is written first: without it the sign-off is not applied
        if (!_audit({ kind: 'signoff', target: null, value: { hash: so.hash || null, decisionsHash: so.decisionsHash || null, name: form.name, role: form.role }, who: form.name, inputsHash: so.inputsHash, resultsHash: so.resultsHash })) {
            _status('bu_so_status', 'bad', AUDIT_FAIL);
            return;
        }
        _st.signoff = so;
        _st.lastStatus = 'SIGNED';
        var ok = _byId('bu_so_ok'); if (ok) ok.checked = false;
        _status('bu_so_status', 'ok', 'Signed off by ' + form.name + (form.role ? ' (' + form.role + ')' : '') + ' · hash ' + String(so.hash || '').slice(0, 16) + '.');
        _afterChange({});
    }
    function _unsign() {
        if (!_st || !_st.signoff) return;
        var r = null;
        if (typeof G.prompt === 'function') { try { r = G.prompt('Reason for withdrawing the sign-off (at least 5 characters):', ''); } catch (e) { r = null; } }
        r = String(r || '').trim();
        if (r.length < 5) { _status('bu_so_status', 'bad', 'A reason of at least 5 characters is required to withdraw the sign-off.'); return; }
        if (!_audit({ kind: 'unsign', target: null, value: { hash: _st.signoff.hash || null }, reason: r.slice(0, 290) })) { _status('bu_so_status', 'bad', AUDIT_FAIL); return; }
        _st.signoff = null;
        _st.lastStatus = 'DRAFT';
        _status('bu_so_status', 'warn', 'Sign-off withdrawn: the report is a DRAFT again.');
        _afterChange({});
    }
    function _ask() {
        var R = _R(), a = _st && _st.analysis, q = String(_val('bu_qa_q')).trim().slice(0, 300);
        if (!R || !a || typeof R.ask !== 'function' || !q) return;
        var ans = null;
        try { ans = R.ask(q, a, _idx(), fmt); } catch (e) { ans = null; }
        if (!ans) { _status('bu_qa_out', 'bad', 'This question could not be answered.'); return; }
        _st.qa = (_st.qa || []).concat([{ q: q, intent: ans.intent, template: ans.template, values: ans.values, ev: ans.ev, grounded: ans.grounded, check: ans.check, followUps: ans.followUps }]).slice(-20);
        _renderQa();
        _save();
    }
    function _renderQa() {
        var out = _byId('bu_qa_out');
        if (!out) return;
        var list = (_st && _st.qa || []).slice(-3).reverse();
        out.innerHTML = list.map(function (x) {
            var body = (x.check && x.check.ok === false) ? 'This answer failed its evidence check; the numbers are withheld.' : _cleanTxt(_fill(x.template, x.values)) + _refs(x.ev);
            var fu = (x.followUps || []).slice(0, 3).map(function (f) { return _esc(String(f).slice(0, 120)); }).join(' · ');
            return '<div class="bu-ans"><div class="bu-q">' + _esc(x.q) + '</div><div>' + _esc(_cut(body, 600)) + '</div>' + (fu ? '<div class="bu-ev">Try: ' + fu + '</div>' : '') + '</div>';
        }).join('');
    }
    function _aiText() {
        var R = _R(), a = _st && _st.analysis;
        if (!R || !a || typeof R.aiExport !== 'function') return null;
        try { return R.aiExport(a, _st.review, { deidentify: _checked('bu_ai_deid'), includeDates: false, includeFreeText: _checked('bu_ai_free'), idx: _idx(), signoff: _st.signoff || null, names: _knownNames() }); } catch (e) { return null; }
    }
    // Every name the page knows of, for de-identification: well names (this well, the well list, the client info) and
    // people (engineer, signer, audit trail).
    function _knownNames() {
        var out = [];
        var push = function (s, role) { s = String(s == null ? '' : s).trim(); if (s) out.push({ s: s.slice(0, 80), role: role }); };
        push(_wellName(), 'well');
        try { var W = G.WTS_wells, l = W && typeof W.list === 'function' ? W.list() : []; (l || []).forEach(function (w) { if (w) push(w.name, 'well'); }); } catch (e) { /* single well */ }
        push(_val('bu_eng'), 'person'); push(_val('bu_so_name'), 'person');
        if (_st && _st.signoff) push(_st.signoff.name, 'person');
        _each(_auditList(), function (e) { if (e) push(e.who, 'person'); });
        return out;
    }
    function _download(text, name) {
        try {
            var blob = new Blob([text], { type: 'text/plain' }), url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = name; a.style.display = 'none';
            (document.body || _root()).appendChild(a); a.click(); a.parentNode.removeChild(a);
            if (URL.revokeObjectURL) URL.revokeObjectURL(url);
            return true;
        } catch (e) { return false; }
    }
    function _aiCopy() {
        var r = _aiText();
        if (!r || !r.text) { _status('bu_ai_status', 'bad', 'The summary could not be built.'); return; }
        var nav = (typeof navigator !== 'undefined') ? navigator : null;
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
            nav.clipboard.writeText(r.text).then(function () { _status('bu_ai_status', 'ok', 'Copied: paste it into your AI assistant yourself. Nothing was sent from the app.'); },
                function () { if (_download(r.text, r.filename)) _status('bu_ai_status', 'ok', 'Clipboard not available: the summary was downloaded as ' + r.filename + '.'); });
        } else if (_download(r.text, r.filename)) _status('bu_ai_status', 'ok', 'Clipboard not available: the summary was downloaded as ' + r.filename + '.');
    }
    function _aiDl() {
        var r = _aiText();
        if (r && r.text && _download(r.text, r.filename || 'buildup-review.txt')) _status('bu_ai_status', 'ok', 'Downloaded ' + (r.filename || 'buildup-review.txt') + '. Nothing was sent from the app.');
        else _status('bu_ai_status', 'bad', 'The summary could not be built.');
    }
    function _openPrism() {
        var a = _st && _st.analysis, t = _selTest(), f = G.PRiSM_openExternalBuildup;
        if (!a || typeof f !== 'function') return;
        if (!t || !t.result || !t.spec) { _status('bu_ai_status', 'bad', 'Choose an interpreted build-up first.'); return; }
        if (typeof G.confirm === 'function' && !G.confirm('This replaces the PRiSM dataset and well inputs with build-up ' + t.id + ' and its rate history. Continue?')) return;
        var dtEnd = _fin(t.dtEnd_h) ? t.dtEnd_h : 24, MAXROWS = 3000;
        var rec = (_mem.record && a.record && _mem.record.hash === a.record.hash) ? _mem.record : null;
        // build-up: the stored samples binned at 20 per log cycle (PRiSM_autoInterp.bin), else thinned to ≤ 2,000
        var sp = t.spec, dt0 = [], p0 = [], A0 = _AI();
        for (var j = 0; j < (sp.dt || []).length && j < (sp.p || []).length; j++) if (_fin(sp.dt[j]) && sp.dt[j] > 0 && _fin(sp.p[j])) { dt0.push(sp.dt[j]); p0.push(sp.p[j]); }
        var bu = null;
        if (A0 && typeof A0.bin === 'function' && dt0.length > 1) { try { var bb = A0.bin(dt0, p0, { perCycle: 20 }); if (bb && Array.isArray(bb.dt) && bb.dt.length && bb.dt.length === (bb.p || []).length) bu = { dt: bb.dt, p: bb.p }; } catch (e) { bu = null; } }
        if (!bu) { var st0 = Math.max(1, Math.ceil(dt0.length / 2000)); bu = { dt: dt0.filter(function (x, k) { return k % st0 === 0 || k === dt0.length - 1; }), p: p0.filter(function (x, k) { return k % st0 === 0 || k === p0.length - 1; }) }; }
        var buRows = bu.dt.map(function (d, k) { return [t.tc_ms + d * 3600000, bu.p[k]]; }).filter(function (r) { return _fin(r[0]) && _fin(r[1]); });
        // flowing: the last sample of each 15-min window counted back from the closing over the last 10·Δt_end, so the
        // last flowing point is the last flowing sample; thinned further if the total would pass 3,000 rows
        var fl = [];
        if (rec && rec.n) {
            var from = t.tc_ms - 10 * dtEnd * 3600000, bucket = 15 * 60000, lastB = null;
            for (var i = rec.n - 1; i >= 0; i--) {
                var tt = rec.t[i];
                if (tt >= t.tc_ms) continue;
                if (tt < from) break;
                var bk = Math.floor((t.tc_ms - tt) / bucket);
                if (bk !== lastB && _fin(rec.p[i])) { fl.push([tt, rec.p[i]]); lastB = bk; }
            }
            fl.reverse();
            var room = Math.max(1, MAXROWS - buRows.length);
            if (fl.length > room) { var stf = Math.ceil(fl.length / room), nF = fl.length; fl = fl.filter(function (r, k) { return (nF - 1 - k) % stf === 0; }); }
        }
        if (!fl.length && _fin(t.pwf0)) fl.push([t.tc_ms, t.pwf0]);   // no raw record: start at the closing (flowing pressure pwf0)
        var rows = fl.concat(buRows);
        if (rows.length > MAXROWS) rows = rows.slice(rows.length - MAXROWS);
        rows.sort(function (x, y) { return x[0] - y[0]; });
        if (!rows.length) { _status('bu_ai_status', 'bad', 'This build-up has no stored samples.'); return; }
        var t0 = rows[0][0];
        var th = rows.map(function (r) { return (r[0] - t0) / 3600000; }), ph = rows.map(function (r) { return r[1]; });
        var pasteText = 't_hr,p_psia\n' + rows.map(function (r, k) { return Number(th[k].toFixed(6)) + ',' + Number(r[1].toFixed(3)); }).join('\n');
        var steps = (a.rates && a.rates.steps) || [], sr = sp.stepRef || {}, mr = [];
        for (var s = 0; s < steps.length && (!_fin(sr.to) || s <= sr.to); s++) if (steps[s] && _fin(steps[s].t_ms)) mr.push({ t: (steps[s].t_ms - t0) / 3600000, q: steps[s].q });
        var tShut = (t.tc_ms - t0) / 3600000, A = _AI();
        if (A && typeof A.compactHistory === 'function' && mr.length > 2) {
            try { var cp = A.compactHistory(mr, tShut, dtEnd, {}); if (cp && Array.isArray(cp.steps) && cp.steps.length) mr = cp.steps; } catch (e) { /* full history */ }
        }
        var w = a.well || {}, inj = w.fluid === 'water_inj';
        var o = { ds: { t: th, p: ph, q: null, name: 'Build-up ' + t.id, source: 'buildup' }, pasteText: pasteText, multiRate: mr,
            well: { q: t.Dq, B: inj ? w.Bw : w.B, mu: inj ? w.muw : w.mu, ct: w.ct, h: w.h, phi: w.phi, rw: w.rw, fluid: w.fluid, testType: inj ? 'falloff' : 'buildup' },
            tShut: tShut, pwf0: t.pwf0, modelKey: t.result.chosen ? t.result.chosen.key : 'homogeneous', fitC4: t.result.fitC4 || null };
        var res = null;
        try { res = f(o); } catch (e) { res = { ok: false }; }
        if (!res || res.ok === false) { _status('bu_ai_status', 'bad', 'PRiSM could not open this build-up.'); return; }
        if (typeof G.WTS_nav === 'function') G.WTS_nav('prism');
        if (typeof G.PRiSM_gotoStep === 'function') { try { G.PRiSM_gotoStep(3); } catch (e) { /* PRiSM decides */ } }
    }
    // file 55 carries calibrated expectations for the in-app cases (not the placeholder)
    function _calReady() {
        var cal = G.PRiSM_autoInterpCal;
        return !!(cal && cal.calibrated === true && Array.isArray(cal.inApp) && cal.inApp.length);
    }
    function _validate() {
        var S = B.synth, R = _Run(), cal = G.PRiSM_autoInterpCal, root = _root();
        if (!S || !R || !_calReady() || !root || _run) return;
        var vo = _byId('bu_val_out'); if (vo) vo.removeAttribute('data-note');
        var cases = cal.inApp.slice(0, 24), i = 0, done = 0, same = 0, nears = [], diffs = [], sub = null;
        var run = { token: ++_token, wellId: _wellId(), cancelled: false };
        _run = run; _buttons();
        var cancel = _shouldCancel(run, root);
        _status('bu_val_out', '', 'Checking 0 of ' + cases.length + ' cases…');
        var job = {
            step: function () {
                if (i >= cases.length) return { done: true, progress: 1, label: '' };
                var c = cases[i];
                try {
                    // one work unit per step: the case is generated through synth.generateJob (§3.9), then analysed.
                    // The check repeats the calibration run exactly (buildup-validate.js --lite): the lite case
                    // (60 s sampling, ≤ 30 days), the generator's own AnalysisInput (synth.toInput: its history,
                    // zones, allocation resolution and the default settings, not the page's) and synth.scoreAnalysis
                    // (the test matched to the true closing within 1 h).
                    if (!sub) {
                        var spec = S.caseFromSeed(c.seed, { lite: true });
                        sub = { gen: typeof S.generateJob === 'function' ? S.generateJob(spec) : null, spec: spec, sc: null, job: null };
                        if (!sub.gen) sub.sc = S.generate(spec);
                        if (sub.gen) return { done: false, progress: i / cases.length, label: 'Case ' + (i + 1) + ': generating' };
                    }
                    if (!sub.sc) {
                        var gs = sub.gen.step();
                        if (!gs.done) return { done: false, progress: i / cases.length, label: 'Case ' + (i + 1) + ': generating' };
                        sub.sc = sub.gen.result();
                        if (!sub.sc) throw new Error('no case');
                        return { done: false, progress: i / cases.length, label: 'Case ' + (i + 1) + ': generated' };
                    }
                    if (!sub.job) {
                        var inp = S.toInput(sub.sc, { appVersion: _appVer() });
                        inp.meta.wellName = 'Check case';
                        sub.job = R.job(inp, {});
                    }
                    var st = sub.job.step();
                    if (st.done) {
                        var an = sub.job.result(), m = S.scoreAnalysis(an, sub.sc), sco = m ? m.score : null, ex = c.expect || {};
                        var lab = sco && sco.label ? sco.label : {};
                        var ok = !!sco && sco.status === ex.status && (lab.ks || null) === (ex.ks || null) && (lab.headline || null) === (ex.headline || null);
                        // a difference is "near a threshold" (§5.6) only when the status matches, the recomputed evidence
                        // lies within the selection margin (0.1) of a calibrated threshold AND moving that one threshold
                        // by 0.1 reproduces the expected labels (PRiSM_autoInterp.nearThreshold); any other difference is
                        // listed as different. Either way the check is not a pass (no ✓).
                        var ev = m && m.test && m.test.result ? m.test.result.evidence : null, AI = G.PRiSM_autoInterp;
                        var nt = (!ok && sco && sco.status === ex.status && ev && AI && typeof AI.nearThreshold === 'function') ? AI.nearThreshold(ev, cal, ex) : null;
                        if (ok) same++; else if (nt && nt.near) nears.push(String(c.seed)); else diffs.push(String(c.seed));
                        done++; i++; sub = null;
                    }
                } catch (e) { diffs.push(String(c.seed)); done++; i++; sub = null; }
                return { done: i >= cases.length, progress: i / cases.length, label: 'Case ' + Math.min(i + 1, cases.length) };
            },
            result: function () { return null; }, cancel: function () { i = cases.length; }
        };
        _drive(job, { shouldCancel: cancel, onProgress: function (f) { _status('bu_val_out', '', 'Checking… ' + Math.round(f * 100) + ' %'); } }).then(function () {
            if (_run === run) _run = null;
            _status('bu_val_out', (diffs.length || nears.length) ? 'warn' : 'ok', same + ' of ' + cases.length + ' cases as expected' +
                (nears.length ? ', ' + nears.length + ' near a threshold (seeds ' + nears.slice(0, 8).join(', ') + ')' : '') +
                (diffs.length ? '; different: seeds ' + diffs.slice(0, 8).join(', ') : '') + '.');
            _buttons();
        }, function () { if (_run === run) _run = null; _status('bu_val_out', 'warn', 'Check cancelled.'); _buttons(); });
    }

    // ── events on #bu_root ───────────────────────────────────────────
    function _inDialog(t) { return !!(t && t.closest && t.closest('#bu_dlg')); }
    function _onInput(e) {
        var t = e.target;
        if (!t || !t.id || _inDialog(t)) return;
        if (_st) _st.touched[t.id] = 1;
        if (DISPLAY_ONLY[t.id] || /^bu_(g|a)_c[a-zA-Z]$/.test(t.id) || /^bu_(g|a)_paste$/.test(t.id)) return;
        _checkStale();
    }
    function _onChange(e) {
        var t = e.target;
        if (!t || !t.id) return;
        if (t.id === 'bu_dlg_act') { _dlgFields(); return; }
        if (_inDialog(t)) return;
        if (t.id === 'bu_test_sel') { if (_st) _st.uiSel = { test: t.value || '' }; G.calcBuildup(); _snap(); return; }
        if (t.id === 'bu_rep_detail') { G.calcBuildup(); _snap(); return; }
        _syncUi();
        if (DISPLAY_ONLY[t.id]) return;
        if (_st) _st.touched[t.id] = 1;
        // text and number fields were already compared on their 'input' event
        if (t.localName === 'input' && /^(text|number|date|datetime-local|)$/.test(String(t.type || ''))) return;
        _checkStale();
    }
    function _onClick(e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var m = t.closest('[data-act="menu"]');
        if (m) {
            var test = m.getAttribute('data-test'), f = m.getAttribute('data-f');
            if (test) _dlgOpen({ kind: 'test', test: test }, m);
            else if (f) _dlgOpen({ kind: 'findings', f: f.split(',') }, m);
            return;
        }
        var b = t.closest('button');
        if (!b || !b.id) return;
        switch (b.id) {
            case 'bu_run': analyse(); break;
            case 'bu_cancel': _cancelRun(); _status('bu_progress', '', 'Cancelling…'); break;
            case 'bu_g_load': _loadGauge(); break;
            case 'bu_h_load': _loadHistorian(); break;
            case 'bu_p_load': _loadPrism(); break;
            case 'bu_demo_load': _loadDemo(); break;
            case 'bu_a_load': _loadAlloc(); break;
            case 'bu_tz_reset': (function () {
                _ensure();
                var n = _deviceZone();
                ['bu_g_tzname', 'bu_pd_tzname'].forEach(function (id) { var el = _byId(id); if (el) el.value = n; });
                _st.zones = { g: n, pd: n };
                _save();
                _status('bu_g_status', '', n ? 'Time zones set to ' + n + '.' : 'This device reports no time zone; UTC is used.');
                _checkStale();
            })(); break;
            case 'bu_well_prism': _copyPrismWell(); break;
            case 'bu_ev_add': _dlgOpen({ kind: 'missed' }, b); break;
            case 'bu_qa_go': _ask(); break;
            case 'bu_so_sign': _signOff(); break;
            case 'bu_so_unsign': _unsign(); break;
            case 'bu_ai_copy': _aiCopy(); break;
            case 'bu_ai_dl': _aiDl(); break;
            case 'bu_open_prism': _openPrism(); break;
            case 'bu_val_run': _validate(); break;
            case 'bu_dlg_ok': _dlgOk(); break;
            case 'bu_dlg_cancel': case 'bu_dlg_x': _dlgClose(); break;
            default: break;
        }
    }
    function _onKey(e) {
        if ((e.key === 'Escape' || e.key === 'Esc') && _dlgCtx && _inDialog(e.target)) { if (e.preventDefault) e.preventDefault(); _dlgClose(); }
        if (e.key === 'Enter' && e.target && e.target.id === 'bu_qa_q') { if (e.preventDefault) e.preventDefault(); _ask(); }
    }

    // ── render / calc ────────────────────────────────────────────────
    function _calcImpl() {
        var root = _root();
        if (!root) return null;
        _calcs++;
        _ensure();
        _syncUi();
        _renderResults({ charts: true });
        _renderQa();
        _checkStale(true);
        _publish();
        return _st.analysis ? { ok: true, nTests: (_st.analysis.tests || []).length } : null;
    }
    G.calcBuildup = function () { return _canonRun(_calcImpl); };
    function renderBuildup(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = PG_TITLE;
        if (s) s.textContent = PG_SUB;
        _ensure();        // keeps the in-memory analysis (with its model curves) across navigation within one well
        var S0 = _store();
        if (S0 && typeof S0.init === 'function') { try { S0.init(); } catch (e) { /* memory engine */ } }   // opens IndexedDB, warms the mirrors
        body.innerHTML = _markup();
        var U = G.WTS_units;
        if (U && typeof U.tagInput === 'function') for (var k in TAGS) if (_own(TAGS, k)) U.tagInput(k, TAGS[k]);
        var root = _byId('bu_root');
        if (root && root.addEventListener) {
            root.addEventListener('input', _onInput);
            root.addEventListener('change', _onChange);
            root.addEventListener('click', _onClick);
            root.addEventListener('keydown', _onKey);
            var d = _byId('bu_dlg');
            if (d && d.addEventListener) d.addEventListener('cancel', function (e) { if (e.preventDefault) e.preventDefault(); _dlgClose(); });
        }
        var cal = G.PRiSM_autoInterpCal, bv = _byId('bu_t_basevar');
        if (bv && cal && cal.thresholds && cal.thresholds.deltaForm === 'basevar') bv.checked = true;
        ['g', 'pd'].forEach(function (z) { var e = _byId(z === 'g' ? 'bu_g_tzname' : 'bu_pd_tzname'); if (e) e.value = _st.zones[z] || ''; });
        if (_st.uiSel && _st.uiSel.test) { var ts = _byId('bu_test_sel'); if (ts) ts.setAttribute('data-want', _st.uiSel.test); }
        _fillTestSel();
        _syncUi();
        _renderResults({ charts: false });
        _renderQa();
        if (_mem.record) _status('bu_g_status', 'ok', 'Gauge data in memory: ' + _nf(_mem.record.n || 0, 0) + ' samples' + (_mem.record.name ? ' from ' + _mem.record.name : '') + '.');
        _loadRawAsync();
        _rehydrateAsync();
        _loadTags();
        var AS = G.WTS_pageAutosave;
        var hostRestores = !!(AS && typeof AS.page === 'function' && AS.page() === PG_KEY && typeof AS.enabled === 'function' && AS.enabled(PG_KEY) && body.id === 'pgBody');
        if (!hostRestores) { _snapToAnalysed(); G.calcBuildup(); }
    }
    G.renderBuildup = renderBuildup;

    // ── page API (tests) ─────────────────────────────────────────────
    PG.calcs = function () { return _calcs; };
    PG.state = function () { return _st; };
    PG.mem = function () { return _mem; };
    PG.isRunning = function () { return !!_run; };
    PG.cancel = _cancelRun;
    PG.analyse = analyse;
    PG.fmt = fmt;
    PG.gather = gather;
    PG.pageHash = pageHash;
    PG.reportModel = reportModel;
    PG.ranges = NUM;
    PG.stale = function () { return _isStale; };
    PG.status = _status2;
    PG._carryDecisions = _carryDecisions;
    PG._zone = { offMs: _offMs, msToLocal: _msToLocal, localToMs: _localToMs, gaugeZone: _gaugeZone };

    // ── registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.buildup = {
        key: PG_KEY, title: PG_TITLE, sub: PG_SUB, group: 'Production & Reservoir', icon: '&#128200;',
        desc: 'Find every shut-in in gauge data, interpret each build-up, track skin over time and get a reviewed, signed report.',
        hooks: { silent: true, after: function (body) { _syncUi(body); _snapToAnalysed(); var ts = _byId('bu_test_sel'); if (ts && ts.getAttribute('data-want') && !ts.value) { ts.value = ts.getAttribute('data-want'); } G.calcBuildup(); } },
        render: function (body) { return G.renderBuildup(body); }
    };

    // ── module-level listeners (guarded; each checks #bu_root first) ──
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('wts:unit-system-changed', function () {
            if (!_root()) return;
            _isStale = false;
            G.calcBuildup();
        });
        ['wts:well-changed', 'wts:project-loaded', 'wts:project-new'].forEach(function (ev) {
            document.addEventListener(ev, function () {
                _cancelRun();
                _run = null;
                _st = null;
                _mem = _freshMem(null);
                _idxCache = null;
                _lastPub = null;
                _chartTok++;
            });
        });
        document.addEventListener('wts:historian-updated', function (e) {
            if (!_root() || _val('bu_src') !== 'historian') return;
            var tag = e && e.detail && (e.detail.tag || (e.detail.tags && e.detail.tags[0]));
            if (tag && _val('bu_h_tag') && String(tag) !== _val('bu_h_tag')) return;
            var b = _byId('bu_h_load');
            if (b) b.textContent = 'Load from historian (new data)';
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var P = G.WTS_buildup && G.WTS_buildup.page, fails = [];
    if (!P || typeof P.fmt !== 'function') return;
    if (P.fmt(null) !== '—' || P.fmt(1.234, null, 2) !== (1.23).toLocaleString(undefined, { maximumFractionDigits: 2 }) && P.fmt(1.234, null, 2) !== '1.23') fails.push('fmt');
    if (!G.WTS_calcRegistry || !G.WTS_calcRegistry.buildup || G.WTS_calcRegistry.buildup.group !== 'Production & Reservoir') fails.push('registry');
    if (fails.length && typeof console !== 'undefined') console.error('[buildup page self-test] FAILED: ' + fails.join('; '));
})();
