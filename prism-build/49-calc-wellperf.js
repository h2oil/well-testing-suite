// =============================================================================
// WTS — 49-calc-wellperf.js  (Round 9) — Well Performance (nodal analysis) page, route `wellperf`
// -----------------------------------------------------------------------------
// docs/WELL-PERFORMANCE-PLAN.md §2.6–§2.10, §3.10, §10, §12, §13 and the owner GUI requirement of 2026-11-11 (deviation first
// class; interactive well schematic; interactive plots with drag handles; KPI strip; results drawer). WP9.
// Member of the sidebar hub "Well Performance" (hub key `perf`, members wellperf, oilipr, gasdeliv, gaslift — WP0 host edits).
//
// Contract (unchanged from WP0):
//   registry  WTS_calcRegistry.wellperf {key, title, navTitle, sub, group 'Production & Reservoir', icon, badge, bc, desc, render,
//             hooks: {silent: true, after: → _syncUi() + one calcWellPerf()}}
//   window.renderWellPerf(body), window.calcWellPerf() (the units layer wraps calc* in a canonical context)
//   WTS_state.wellperf = {v, ok, op, roots, qs, vlpMin, traverse, breakdown, shutIn, flags, loading, sens, match, …} (recomputed)
//   events    document 'wts:wellperf-solved' {ok} after each solve; listens to 'wts:well-changed' / 'wts:project-loaded' (re-read the
//             model through WTS_wp_model.read(); no cache), 'wts:wellperf-model-changed' (a table write → one solve) and
//             'wts:unit-system-changed' (re-render in the display units)
//   markup    #wp_root; #wp_steps (the step strip, .rp-skip, sticky); #wp_res = the compact report block, always rendered and visible:
//             KPI strip (.kpi), the well schematic (SVG), the system plot (IPR / outflow with drag handles), operating point, Δp
//             breakdown, verdicts, validity verdicts, the traverse card and the Notes; the results drawer #wp_drawer (.rp-skip);
//             step sections #wp_step_1 … #wp_step_7 (only the active one shown; inputs card + results card each).
//
// Engines are called at call time (WP1–WP7: WTS_wp_model / _fluid / _ipr / _vlp / _well / _system / _loading / _check / _sens /
// _match / _qc); a WP0 stub or a missing engine shows a plain "not available" state, never an exception. The page holds no
// engine numerics of its own: it reads M, calls the engines, draws their results and writes tables through WTS_wp_model.write.
//
// Interactivity (no timers, no polling, no function wrapping): committed input changes ('change') solve at once; drag handles on
// the system plot (p̄r, wellhead pressure, choke bean, water cut) re-solve on every pointer move while the measured solve time is
// below LIVE_MS, else on release; when a solve takes longer than BUDGET_MS the page switches to a Solve button (§2.6).
// Design, bean schedule, sensitivity and comparison run on their buttons as Jobs (PRiSM_autoInterp.drive when present).
// A2 (WP13): step ① offers the correlation families of 16-pvt (Vasquez-Beggs, Glasø, Petrosky-Farshad Pb / Rs / Bo; Egbogah,
// Bergman-Sutton μod; Chew-Connally μo; Petrosky-Farshad co; Hall-Yarborough Z; Abdul-Majeed σ), each unverified one labelled
// provisional (D17); the "Fluid properties" card plots Rs / Bo / μo / Z / μg / Bg / Bw / density against pressure at the reservoir
// temperature with every family overlaid (WTS_wp_fluid.compare), family chips (bubble point, data-range state, click to select),
// a drag handle on the bubble point (the one-point shift wp_pbUser: previewed live, committed on release) and a comparison table.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var TITLE = 'Well Performance (Nodal Analysis)';
    var SUB = 'Inflow and outflow through the completion, tubing, choke and flowline to the separator: operating point, stability, choke sizing, shut-in and liquid loading';
    // BUDGET_MS: §16 page recompute ≤ 300 ms on the container × the phone factor 3 ≈ 1 s on the device, else the Solve button.
    // LIVE_MS: a drag re-solves on every move while the measured (or estimated) live solve stays below it — the live solve is the
    // engine's warm tracking solve (≈ 5 evaluations instead of ≈ 20).
    var PATM = 14.696, BUDGET_MS = 1000, LIVE_MS = 150;
    var STEPS = [
        { n: 1, sid: 'fluid', label: 'Fluid' }, { n: 2, sid: 'res', label: 'Reservoir' }, { n: 3, sid: 'well', label: 'Well' },
        { n: 4, sid: 'lift', label: 'Lift' }, { n: 5, sid: 'system', label: 'System' }, { n: 6, sid: 'match', label: 'Match' }, { n: 7, sid: 'report', label: 'Report' }
    ];
    var CIRC = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦'];
    var calcs = 0, budgetMs = BUDGET_MS;
    var ST = { M: null, R: null, W: null, SC: null, I: null, F: null, chk: null, shut: null, loading: null, solveMs: 0, slow: false, stale: false,
               live: false, job: null, sens: null, beans: null, design: null, match: null, qc: null, prov: {}, lastErr: null, tune: null, tuneTests: null, tunePrev: null, tuneKey: null, untuned: null,
               pvtm: null, pvtmEdit: null, pvtmKey: null, pvtmCache: null };

    // ── small helpers ─────────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _emit(name, detail) {
        try {
            if (typeof document === 'undefined' || !document.dispatchEvent) return;
            var ev = (typeof CustomEvent === 'function') ? new CustomEvent(name, { detail: detail }) : null;
            if (!ev && document.createEvent) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent(name, false, false, detail); }
            if (ev) document.dispatchEvent(ev);
        } catch (e) { /* smoke stub */ }
    }
    function _now() { try { return (G.performance && typeof G.performance.now === 'function') ? G.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
    function _fn(path) {                       // resolve an engine function at call time (a WP0 stub answers {ok:false, code:'STUB'})
        var p = path.split('.'), o = G[p[0]], f = p.length > 1 ? (o && o[p[1]]) : o;
        if (typeof f !== 'function') return null;
        return function () { return f.apply(p.length > 1 ? o : G, arguments); };
    }
    function _call(path) {
        var f = _fn(path); if (!f) return { ok: false, code: 'MISSING_ENGINE', name: path, errors: [path + ' is not available'], warnings: [] };
        try { return f.apply(null, Array.prototype.slice.call(arguments, 1)); }
        catch (e) { if (typeof console !== 'undefined') console.error('[wellperf] ' + path, e); return { ok: false, code: 'ENGINE_ERROR', name: path, errors: [path + ': ' + (e && e.message)], warnings: [] }; }
    }
    function _isStub(r) { return !!(r && r.ok === false && (r.code === 'STUB' || r.code === 'MISSING_ENGINE')); }
    function _get(o, path) { var ks = path.split('.'); for (var i = 0; i < ks.length; i++) { if (o == null) return undefined; o = o[ks[i]]; } return o; }

    // ── units (display) ───────────────────────────────────────────────────────
    (function _cats() {
        var U = G.WTS_units, C = U && U.CATEGORIES;
        if (!C) return;
        function add(k, iu, il, f, mu, ml) { if (!C[k]) C[k] = { imperial: { unit: iu, label: il, factor: f, offset: 0 }, metric: { unit: mu, label: ml, factor: 1, offset: 0 } }; }
        add('pressureGradient', 'psi/ft', 'psi/ft', 6.894757 / 0.3048, 'kPa/m', 'kPa/m');
        add('nonDarcyD', 'd/Mscf', 'd/Mscf', 1 / 28.3168, 'd/sm3', 'd/sm³');
        add('heatTransferCoef', 'Btu/hr/ft2/F', 'Btu/hr·ft²·°F', 5.678263, 'W/m2/K', 'W/m²·K');
        add('thermalConductivity', 'Btu/hr/ft/F', 'Btu/hr·ft·°F', 1.730735, 'W/m/K', 'W/m·K');
        add('specificHeat', 'Btu/lb/F', 'Btu/lb·°F', 4.1868, 'kJ/kg/K', 'kJ/kg·K');
        add('tempDiff', 'dF', '°F', 5 / 9, 'dC', '°C');
    })();
    function _U() { return G.WTS_units; }
    function _metric() { var U = _U(); return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _hasCat(cat) { var U = _U(); return !!(U && U.CATEGORIES && U.CATEGORIES[cat]); }
    function _dv(v, cat) { var U = _U(); return (_fin(v) && _metric() && _hasCat(cat) && U.convertCategory) ? U.convertCategory(v, cat, 'imperial', 'metric') : v; }
    function _fromDisp(v, cat) { var U = _U(); return (_fin(v) && _metric() && _hasCat(cat) && U.convertCategory) ? U.convertCategory(v, cat, 'metric', 'imperial') : v; }
    function _lab(cat, imp) { var U = _U(); return (_metric() && _hasCat(cat)) ? U.CATEGORIES[cat].metric.label : imp; }
    function _fvfLab() { return _metric() ? 'rm³/sm³' : 'rb/STB'; }   // a volume ratio: the same number in both systems
    function _fmt(v, d) {
        if (v == null || !_fin(v)) return '—';
        var s = Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
        return s === '-0' ? '0' : s;
    }
    // field-unit numbers inside an engine message, shown in the display units (review fix v4.5: the B engine flags read 'ft', 'ft/s',
    // 'bbl/d', 'psig' in Metric); identity in field units
    var MSG_U = { 'ft/s': 'velocity', 'ft': 'length', 'bbl/d': 'liquidRate', 'STB/d': 'liquidRate', 'psig': 'pressureG', 'psia': 'pressure', 'psi': 'pressure', '°F': 'temperature', 'hp': 'power' };
    function _msgU(s) {
        s = String(s == null ? '' : s);
        if (!_metric()) return s;
        return s.replace(/(-?\d[\d,]*(?:\.\d+)?)\s?(ft\/s|bbl\/d|STB\/d|psig|psia|psi|°F|ft|hp)(?![\w\/])/g, function (m, num, un) {
            var v = parseFloat(num.replace(/,/g, '')), dp = (num.split('.')[1] || '').length; if (!_fin(v)) return m;
            return _u(v, MSG_U[un], dp, un);
        }).replace(/(\d+(?:\.\d+)?)°\/100 ft/g, function (m, num) { return _dls(parseFloat(num)); });
    }
    // dogleg severity: °/100 ft in field units, °/30 m in Metric
    function _dls(v) { if (!_fin(v)) return '—'; return _metric() ? _fmt(v * 30 / 30.48, 1) + '°/30 m' : _fmt(v, 1) + '°/100 ft'; }
    function _u(v, cat, d, imp, dMet) { if (!_fin(v)) return '—'; return _fmt(_dv(v, cat), _metric() ? (dMet == null ? d : dMet) : d) + ' ' + _lab(cat, imp); }
    function _canon(fn) { var U = _U(); return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _tag(map) { var U = _U(); if (!U || !U.tagInput) return; Object.keys(map).forEach(function (id) { if (_byId(id)) U.tagInput(id, map[id]); }); }
    function _tempDiff(dF) { return _metric() ? _fmt(dF * 5 / 9, 1) + ' °C' : _fmt(dF, 1) + ' °F'; }
    function _eta(v) { return _metric() ? _fmt(v * 5 / 9 * 14.5038, 4) + ' °C/bar' : _fmt(v, 4) + ' °F/psi'; }   // J-T coefficient (B, WP22)
    function _tdS(dF) { return (dF >= 0 ? '+' : '−') + _tempDiff(Math.abs(dF)); }
    // the flowing-temperature summary of a solve when a heat-transfer model ran (relaxation A2, enthalpy balance B / WP22)
    function _hx(R) { return R && R.ok && R.heat && (R.heat.mode === 'relax' || R.heat.mode === 'enthalpy') ? R.heat : null; }
    function _heatAsked(M) { var m = M && M.well && M.well.heat && M.well.heat.mode; return m === 'relax' || m === 'enthalpy'; }

    var UNITS = {
        wp_fpsep: 'pressureG', wp_ftsep: 'temperature', wp_gor: 'gor', wp_cgr: 'cgr', wp_wgr: 'cgr', wp_pbUser: 'pressure',
        wp_pr: 'pressure', wp_tres: 'temperature', wp_respb: 'pressure', wp_datumOff: 'length', wp_perfTop: 'length', wp_perfBot: 'length',
        wp_midPerf: 'length', wp_surfT: 'temperature', wp_tht: 'temperature', wp_Uto: 'heatTransferCoef', wp_ke: 'thermalConductivity',
        wp_psep: 'pressureG', wp_tamb: 'temperature', wp_thp: 'pressureG', wp_stepFt: 'length', wp_gl_packer: 'length', wp_gl_pinj: 'pressureG', wp_gl_qinj: 'gasRateSmall', wp_gl_incgor: 'gor',
        wp_gl_dpv: 'pressure', wp_ip_J: 'productivityIndex', wp_ip_qmax: 'liquidRate', wp_ip_k: 'permeability', wp_ip_h: 'length',
        wp_ip_rw: 'length', wp_ip_re: 'length', wp_ip_D: 'nonDarcyD', wp_dwb: 'lengthSmall',
        wp_pdew: 'pressure', wpl_T: 'temperature', wpl_pb: 'pressure', wpl_rsbF: 'gor',
        wp_ip_L: 'length', wp_ip_boxA: 'length', wp_ip_boxB: 'length', wp_ip_xPos: 'length', wp_ip_zPos: 'length', wp_ip_yMid: 'length', wp_ip_yb: 'length',
        wp_ip_xf: 'length', wp_ip_ct: 'compressibility', wp_ip_II: 'productivityIndex', wp_ip_pfrac: 'pressure',
        // B (WP25): the gas-lift unloading design (49-calc-wp-glui.js draws the controls; tagged here so the host restore converts them)
        wp_gld_pko: 'pressureG', wp_gld_gs: 'pressureGradient', wp_gld_minsp: 'length', wp_gld_dpdrop: 'pressure', wp_gld_qL: 'liquidRate', wp_gld_dmax: 'length'
    };

    // ── model scalars (defaults from WTS_wp_model.DEFAULTS; Appendix B) ───────
    function _def(id) {
        var Mm = G.WTS_wp_model, spec = Mm && Mm.SCALARS && Mm.SCALARS[id];
        if (!spec || !Mm.DEFAULTS) return '';
        var v = _get(Mm.DEFAULTS, spec.path);
        if (v == null) return '';
        if (spec.kind === 'bool') return !!v;
        if (spec.kind === 'list') return Array.isArray(v) ? v.join(' ') : '';
        if (typeof v === 'number' && spec.scale) return String(Math.round(v / spec.scale * 1e6) / 1e6);
        return String(v);
    }
    function _ctrls() {
        var root = _byId('wp_root'); if (!root || !root.querySelectorAll) return [];
        return Array.prototype.filter.call(root.querySelectorAll('input,select,textarea'), function (e) { return e.id && e.id.indexOf('wp_') === 0; });
    }
    function _liveScalars() {
        var out = {};
        _canon(function () {
            _ctrls().forEach(function (e) { out[e.id] = (e.type === 'checkbox') ? !!e.checked : e.value; });
        });
        // the gas-lift rate list is typed in the display units and the decimal-comma convention: parsed here (review fix) and handed
        // to the model as field units (Mscf/d)
        if (typeof out.wp_gl_qlist === 'string') out.wp_gl_qlist = _parseList(out.wp_gl_qlist).map(function (v) { return _fromDisp(v, 'gasRateSmall'); });
        return out;
    }
    // a typed list of numbers: split on whitespace and ';'; on ',' only when there is no whitespace and decimal comma is off.
    // A token 'd,ddd' (normal) or 'd.ddd,d' (decimal comma) is a thousands-grouped number; with decimal comma 'd,d' is a decimal.
    function _decComma() { return !!(G.WTS_a11y && typeof G.WTS_a11y.decimalComma === 'function' && G.WTS_a11y.decimalComma()); }
    function _listTokens(sraw) {
        sraw = String(sraw == null ? '' : sraw).trim();
        if (!sraw) return [];
        var dc = _decComma();
        return ((/[;\s]/.test(sraw) || dc) ? sraw.split(/[;\s]+/) : sraw.split(',')).filter(function (x) { return x !== ''; });
    }
    function _listNum(t) {
        t = String(t).trim();
        if (_decComma()) {
            if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '');
            t = t.replace(',', '.');
        } else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
        if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return NaN;
        return parseFloat(t);
    }
    function _parseList(sraw) { return _listTokens(sraw).map(_listNum).filter(_fin); }
    function _fmtListNum(v) { var t = String(+(+v).toPrecision(6)); return _decComma() ? t.replace('.', ',') : t; }
    // on a unit-system change the rate list box is rewritten in the new display units (it is not a tagged input)
    function _qlistUnits() {
        var e = _byId('wp_gl_qlist'), U = _U(); if (!e || !U || !U.convertCategory || !_hasCat('gasRateSmall')) return;
        var vals = _parseList(e.value); if (!vals.length) return;
        var to = _metric() ? 'metric' : 'imperial', from = to === 'metric' ? 'imperial' : 'metric';
        e.value = vals.map(function (v) { return _fmtListNum(U.convertCategory(v, 'gasRateSmall', from, to)); }).join(' ');
    }
    function _relabelUntagged() {
        var l = document.querySelector && document.querySelector('label[for="wp_gl_qlist"]');
        if (l) l.textContent = 'Performance-curve rates (' + _lab('gasRateSmall', 'Mscf/d') + ')';
    }
    function _setCtrl(id, v, canonical) {
        var e = _byId(id); if (!e) return false;
        if (e.type === 'checkbox') { e.checked = !!v; return true; }
        if (canonical) _canon(function () { e.value = String(v); }); else e.value = String(v);
        return true;
    }
    function _commit(id) {                 // a committed change through the normal event path (autosave, snapshot, one solve)
        var e = _byId(id); if (!e) return;
        try {
            var ev = (typeof Event === 'function') ? new Event('change', { bubbles: true }) : null;
            if (!ev && document.createEvent) { ev = document.createEvent('Event'); ev.initEvent('change', true, false); }
            if (ev) e.dispatchEvent(ev);
        } catch (x) { /* ignore */ }
    }

    // ── preferences (device) ──────────────────────────────────────────────────
    function _prefGet(k, d) { try { var s = (typeof localStorage !== 'undefined') ? localStorage.getItem(k) : null; return s == null ? d : JSON.parse(s); } catch (e) { return d; } }
    function _prefSet(k, v) { try { if (typeof G.WTS_lsSet === 'function') G.WTS_lsSet(k, JSON.stringify(v)); } catch (e) { /* device pref only */ } }
    function _plots() { var p = _prefGet('wtspref_wp_plots', null); return (p && typeof p === 'object') ? p : {}; }
    function _plotsSet(patch) { var p = _plots(); Object.keys(patch).forEach(function (k) { p[k] = patch[k]; }); _prefSet('wtspref_wp_plots', p); }
    function _step() { var s = +_prefGet('wtspref_wp_step', 1); return (s >= 1 && s <= 7) ? s : 1; }

    // ── IPR parameters (union of the A1 models; the registry of WTS_wp_ipr decides which ones a model needs) ─────────
    var IP = {
        J: { l: 'Productivity index J', cat: 'productivityIndex', u: 'STB/d/psi' }, qmax: { l: 'Vogel q max', cat: 'liquidRate', u: 'STB/d' },
        FE: { l: 'Flow efficiency FE', u: '' }, C: { l: 'Coefficient C', u: 'field units' }, n: { l: 'Exponent n', u: '' },
        A: { l: 'Laminar term A', u: 'psi/(STB/d)' }, B: { l: 'Turbulent term B', u: 'psi/(STB/d)²' },
        a: { l: 'LIT a', u: 'field units' }, b: { l: 'LIT b', u: 'field units' }, k: { l: 'Permeability k', cat: 'permeability', u: 'md' },
        h: { l: 'Net thickness h', cat: 'length', u: 'ft' }, rw: { l: 'Wellbore radius rw', cat: 'length', u: 'ft' },
        re: { l: 'Drainage radius re', cat: 'length', u: 'ft' }, S: { l: 'Skin S', u: '' }, D: { l: 'Non-Darcy D', cat: 'nonDarcyD', u: 'd/Mscf' },
        // B (WP24): horizontal, fractured, transient, injector parameters (wp_ip_<name> → res.params.<name>); 'layers' is a table
        L: { l: 'Lateral length L', cat: 'length', u: 'ft', ph: 'perforated MD' }, kvkh: { l: 'kv/kh', u: '', ph: '0.1' },
        boxA: { l: 'Box width a (across the well)', cat: 'length', u: 'ft' }, boxB: { l: 'Box length b (along the well)', cat: 'length', u: 'ft' },
        xPos: { l: 'Well position x0 in the box', cat: 'length', u: 'ft', ph: 'a/2' }, zPos: { l: 'Well height z0 above the base', cat: 'length', u: 'ft', ph: 'h/2' },
        yMid: { l: 'Lateral centre y_mid', cat: 'length', u: 'ft', ph: 'b/2' }, yb: { l: 'Distance to the constant-pressure boundary y_b', cat: 'length', u: 'ft' },
        xf: { l: 'Fracture half-length x_f', cat: 'length', u: 'ft' }, FcD: { l: 'Fracture conductivity F_cD', u: '', ph: 'blank = infinite' },
        phi: { l: 'Porosity φ', u: 'fraction' }, ct: { l: 'Total compressibility ct', cat: 'compressibility', u: '1/psi' }, tFlow: { l: 'Flowing time t', u: 'h' },
        II: { l: 'Injectivity index II', cat: 'productivityIndex', u: 'BWPD/psi' }, pfrac: { l: 'Fracture pressure at the mid-perforations', cat: 'pressure', u: 'psia', ph: 'DFIT closure' },
        layers: { l: 'Layers', table: true }
    };
    var IPR_FALLBACK = [
        ['pi', 'Straight-line PI', 'oil', ['J']], ['vogel', 'Vogel with flow efficiency', 'oil', ['qmax', 'FE']], ['composite', 'Composite (PI above pb, Vogel below)', 'oil', ['J']],
        ['fetkovich', 'Fetkovich C and n', 'oil', ['C', 'n']], ['jbgOil', 'Jones-Blount-Glaze two-term oil', 'oil', ['A', 'B']], ['darcyOil', 'Darcy radial oil (k·h, skin)', 'oil', ['k', 'h', 'rw', 're', 'S']],
        ['backPressure', 'Back-pressure C and n', 'gas', ['C', 'n']], ['litP2', 'LIT in p²', 'gas', ['a', 'b']], ['litMp', 'LIT in m(p)', 'gas', ['a', 'b']],
        ['darcyGas', 'Darcy radial gas with non-Darcy D', 'gas', ['k', 'h', 'rw', 're', 'S', 'D']],
        // B (WP24), all provisional (D17)
        ['wcComposite', 'Water-cut composite (oil Vogel + water PI)', 'oil', ['J']], ['joshi', 'Horizontal well — Joshi (1988)', 'oil', ['k', 'h', 'L', 'kvkh', 'rw', 're', 'S']],
        ['babuOdeh', 'Horizontal well — Babu-Odeh (1989), box', 'oil', ['k', 'h', 'L', 'kvkh', 'rw', 'boxA', 'boxB', 'xPos', 'zPos', 'yMid', 'S']],
        ['furui', 'Horizontal well — Furui et al. (2003)', 'oil', ['k', 'h', 'L', 'kvkh', 'rw', 'yb', 'S']],
        ['frac', 'Fractured well — Prats / Cinco-Ley F_cD (oil)', 'oil', ['k', 'h', 'rw', 're', 'xf', 'FcD', 'S']], ['fracGas', 'Fractured well — Prats / Cinco-Ley F_cD (gas)', 'gas', ['k', 'h', 'rw', 're', 'xf', 'FcD', 'S', 'D']],
        ['transient', 'Transient (line source at a flowing time)', 'oil', ['k', 'h', 'phi', 'ct', 'rw', 'tFlow', 'S', 're']],
        ['multilayer', 'Multilayer commingled (crossflow reported)', 'any', ['layers', 'rw', 're']],
        ['injector', 'Injector — injectivity index with a fracture-pressure limit', 'inj', ['II', 'k', 'h', 'rw', 're', 'S', 'pfrac', 'a', 'b', 'D']]
    ];
    function _iprModels() {
        var reg = G.WTS_wp_ipr && G.WTS_wp_ipr.models, out = [];
        IPR_FALLBACK.forEach(function (r) {
            var m = reg && reg[r[0]];
            out.push({ key: r[0], label: (m && m.label) || r[1], kind: (m && m.kind) || r[2], needs: (m && Array.isArray(m.needs)) ? m.needs.filter(function (k) { return IP[k]; }) : r[3],
                       verified: m ? m.verified !== false : IPR_FALLBACK.indexOf(r) < 10 });
        });
        return out;
    }
    function _corrList(kindWanted) {
        var reg = G.WTS_flowline_corr || {}, out = [];
        Object.keys(reg).forEach(function (k) {
            var c = reg[k]; if (!c || typeof c.grad !== 'function') return;
            if (kindWanted === 'line' && c.kind === 'well') return;
            out.push({ key: k, label: c.label || k, verified: c.verified !== false });
        });
        if (!out.length) out.push({ key: 'bb', label: 'Beggs & Brill', verified: true });
        return out;
    }

    // correlation options of a fluid slot (WTS_wp_fluid.families; 'family' = the families that cover both Rs and Bo)
    var FAM_FALLBACK = { family: ['standing', 'Standing'], rs: ['standing', 'Standing'], bo: ['standing', 'Standing'], co: ['vasquezBeggs', 'Vasquez-Beggs'], muod: ['beggsRobinson', 'Beggs-Robinson'],
        muo: ['beggsRobinson', 'Beggs-Robinson'], z: ['dranchukAbouKassem', 'Dranchuk-Abou-Kassem'], mug: ['leeGonzalezEakin', 'Lee-Gonzalez-Eakin'], sigma: ['bakerSwerdloff', 'Baker-Swerdloff'] };
    function _famList(slot) {
        var W = G.WTS_wp_fluid, list = null;
        try {
            if (W && typeof W.families === 'function') {
                if (slot === 'family') { var bo = W.families('bo'); list = W.families('rs').filter(function (o) { return bo.some(function (b) { return b.key === o.key; }); }); }
                else list = W.families(slot);
            }
        } catch (e) { list = null; }
        return (list && list.length) ? list : [{ key: FAM_FALLBACK[slot][0], label: FAM_FALLBACK[slot][1], verified: true }];
    }
    function _famOpts(slot) { return _famList(slot).map(function (o) { return [o.key, o.label + (o.verified ? '' : ' — provisional')]; }); }
    function _famLabel(slot, key) { var o = _famList(slot).filter(function (x) { return x.key === key; })[0]; return o ? o.label + (o.verified ? '' : ' (provisional)') : String(key || ''); }

    // ── markup builders ───────────────────────────────────────────────────────
    function _fg(id, label, o) {
        o = o || {};
        var d = (o.def != null) ? o.def : _def(id), attrs = ' id="' + id + '"' + (o.title ? ' title="' + _esc(o.title) + '"' : '');
        var cls = 'fg-item' + (o.cls ? ' ' + o.cls : ''), data = o.data ? ' ' + o.data : '';
        var lab = '<label for="' + id + '">' + _esc(label) + (o.unit ? ' (' + _esc(o.unit) + ')' : '') + '</label>';
        if (o.options) {
            return '<div class="' + cls + '"' + data + '>' + lab + '<select' + attrs + '>' + o.options.map(function (op) {
                var v = Array.isArray(op) ? op[0] : op, t = Array.isArray(op) ? op[1] : op;
                return '<option value="' + _esc(v) + '"' + (String(v) === String(d) ? ' selected' : '') + (Array.isArray(op) && op[2] ? ' disabled' : '') + '>' + _esc(t) + '</option>';
            }).join('') + '</select>' + (o.hint ? '<div class="wp-hint">' + o.hint + '</div>' : '') + '</div>';
        }
        if (o.check) {
            return '<div class="' + cls + ' wp-check"' + data + '><label for="' + id + '"><input type="checkbox"' + attrs + (d === true || d === 'true' ? ' checked' : '') + '> ' + _esc(label) + '</label>' + (o.hint ? '<div class="wp-hint">' + o.hint + '</div>' : '') + '</div>';
        }
        if (o.area) return '<div class="' + cls + '"' + data + '>' + lab + '<textarea' + attrs + ' rows="' + (o.rows || 3) + '" placeholder="' + _esc(o.ph || '') + '">' + _esc(d) + '</textarea></div>';
        return '<div class="' + cls + '"' + data + '>' + lab + '<input' + attrs + ' type="' + (o.text ? 'text' : 'number') + '"' + (o.step ? ' step="' + o.step + '"' : ' step="any"') +
            ' inputmode="decimal" value="' + _esc(d) + '"' + (o.ph ? ' placeholder="' + _esc(o.ph) + '"' : '') + '>' + (o.hint ? '<div class="wp-hint">' + o.hint + '</div>' : '') + '</div>';
    }
    function _card(title, body, o) {
        o = o || {};
        // the tools sit beside the title, not inside .card-title: the report collector takes the whole title element's text
        var head = o.tools ? '<div class="wp-card-h"><div class="card-title">' + _esc(title) + '</div><span class="wp-tools rp-skip">' + o.tools + '</span></div>' : '<div class="card-title">' + _esc(title) + '</div>';
        return '<div class="card wp-card' + (o.cls ? ' ' + o.cls : '') + '"' + (o.id ? ' id="' + o.id + '"' : '') + '>' + head + body + '</div>';
    }

    var CSS = '<style>' +
        '#wp_root{--wp-gap:14px;--wp-ok:var(--green,#3fb950);--wp-warn:var(--yellow,#d29922);--wp-fail:var(--red,#f85149)}' +
        '#wp_root .wp-steps{position:sticky;top:-24px;z-index:5;display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:-6px 0 14px;padding:8px 0;background:var(--bg1);overflow-x:auto;scrollbar-width:thin}' +
        // review fix (v4.5): the example chips wrap as one group to a second line on desktop (they ran off-screen at 1280 px)
        '#wp_root .wp-exs{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;flex:0 1 auto;justify-content:flex-end;margin-left:auto}#wp_root .wp-exs button{padding:5px 10px;font-size:11.5px}' +
        '#wp_root .wp-steps button{flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:18px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);font-size:12px;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s,color .15s}' +
        '#wp_root .wp-steps button:hover{border-color:var(--border-light);color:var(--text)}' +
        '#wp_root .wp-steps button.active{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}' +
        '#wp_root .wp-dot{width:8px;height:8px;border-radius:50%;background:var(--text3)}' +
        '#wp_root .wp-dot.ok{background:var(--wp-ok)}#wp_root .wp-dot.warn{background:var(--wp-warn)}#wp_root .wp-dot.fail{background:var(--wp-fail)}' +
        '#wp_root .wp-steps .wp-sp{flex:1 1 auto}' +
        '#wp_root .wp-ex{font-size:12px}' +
        '#wp_root button:focus-visible,#wp_root select:focus-visible,#wp_root input:focus-visible,#wp_root canvas:focus-visible,#wp_root summary:focus-visible,#wp_root .wp-comp:focus-visible{outline:2px solid var(--focus,#58a6ff);outline-offset:2px}' +
        '#wp_root .wp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:8px;margin:0 0 var(--wp-gap)}' +
        '#wp_root .wp-kpi{position:relative;background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--text3);border-radius:8px;padding:9px 12px 9px 12px;min-width:0;transition:border-color .2s}' +
        '#wp_root .wp-kpi .kpi-l{font-size:10.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:16px}' +
        '#wp_root .wp-kpi .kpi-v{font-size:17px;font-weight:700;color:var(--text);margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#wp_root .wp-kpi .kpi-s{font-size:11px;color:var(--text3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#wp_root .wp-kpi::after{position:absolute;top:8px;right:9px;font-size:12px;font-weight:800}' +
        '#wp_root .wp-kpi.st-ok{border-left-color:var(--wp-ok)}#wp_root .wp-kpi.st-ok::after{content:"\\2713";color:var(--wp-ok)}' +
        '#wp_root .wp-kpi.st-warn{border-left-color:var(--wp-warn)}#wp_root .wp-kpi.st-warn::after{content:"!";color:var(--wp-warn)}' +
        '#wp_root .wp-kpi.st-fail{border-left-color:var(--wp-fail)}#wp_root .wp-kpi.st-fail::after{content:"\\2715";color:var(--wp-fail)}' +
        '#wp_root .wp-kpi.st-info{border-left-color:var(--blue)}' +
        '#wp_root .wp-banner{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-radius:8px;margin:0 0 var(--wp-gap);font-size:13px;border:1px solid var(--border);background:var(--bg3)}' +
        '#wp_root .wp-banner.warn{border-color:rgba(210,153,34,.45);background:rgba(210,153,34,.08)}#wp_root .wp-banner.fail{border-color:rgba(248,81,73,.45);background:rgba(248,81,73,.07)}' +
        '#wp_root .wp-banner:empty{display:none}' +
        '#wp_root .wp-bench{display:grid;grid-template-columns:minmax(300px,0.85fr) minmax(360px,1.25fr);gap:var(--wp-gap);align-items:start}' +
        '#wp_root .wp-row3{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr) minmax(0,1fr);gap:var(--wp-gap);align-items:start}' +
        '#wp_root .wp-card{margin-bottom:var(--wp-gap);padding:16px}' +
        '#wp_root .wp-card .card-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
        '#wp_root .wp-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}#wp_root .wp-card-h .card-title{margin-bottom:0}' +
        '#wp_root .rrow{gap:12px}#wp_root .rrow .rl{min-width:0;flex:0 1 auto;max-width:45%}#wp_root .rrow .rv{flex:1 1 0;min-width:0;text-align:right;overflow-wrap:anywhere}' +
        '#wp_root .wp-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}' +
        '#wp_root .wp-stalechip{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:10px;background:rgba(210,153,34,.15);color:var(--wp-warn);margin:6px 0}' +
        '#wp_root .wp-tools{margin-left:auto;display:inline-flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-weight:600}' +
        '#wp_root .wp-tools select,#wp_root .wp-seg button{font-size:11.5px;padding:4px 8px;border-radius:6px}' +
        '#wp_root .wp-seg{display:inline-flex;border:1px solid var(--border);border-radius:7px;overflow:hidden}' +
        '#wp_root .wp-seg button{border:0;background:transparent;color:var(--text2);cursor:pointer;border-radius:0}' +
        '#wp_root .wp-seg button.on{background:var(--bg4);color:var(--text)}' +
        '#wp_root .wp-schw{position:relative}#wp_root .wp-schw svg{display:block;border-radius:8px}' +
        '#wp_root .wp-comp{cursor:pointer}#wp_root .wp-comp:hover{filter:brightness(1.35)}' +
        '#wp_root .wp-tip{position:absolute;pointer-events:none;z-index:4;min-width:150px;max-width:240px;background:var(--bg0);border:1px solid var(--border-light);border-radius:8px;padding:8px 10px;font-size:11.5px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;transition:opacity .12s}' +
        '#wp_root .wp-tip.on{opacity:1}#wp_root .wp-tip b{color:var(--accent)}#wp_root .wp-tip .k{color:var(--text2)}' +
        '#wp_root .chart-wrap{margin-top:0;padding:8px}#wp_root .chart-wrap canvas{touch-action:pan-y;border-radius:6px;cursor:crosshair}#wp_root .chart-wrap canvas.wp-cv-live{touch-action:none}' +
        '#wp_root .wp-legend-hint{font-size:11px;color:var(--text3);margin-top:6px;line-height:1.45}' +
        '#wp_root .wp-v{font-size:12.5px;line-height:1.45;padding:6px 0;border-bottom:1px solid var(--border)}#wp_root .wp-v:last-child{border-bottom:0}' +
        '#wp_root .wp-v.ok{color:var(--wp-ok)}#wp_root .wp-v.warn{color:var(--wp-warn)}#wp_root .wp-v.fail{color:var(--wp-fail)}#wp_root .wp-v.info{color:var(--text2)}' +
        '#wp_root .wp-tabs{display:flex;gap:4px;flex-wrap:wrap}#wp_root .wp-tabs button{font-size:11.5px;padding:5px 10px;border-radius:14px;border:1px solid var(--border);background:transparent;color:var(--text2);cursor:pointer}' +
        '#wp_root .wp-tabs button.on{background:var(--bg4);color:var(--text);border-color:var(--border-light)}' +
        '#wp_root .wp-notes{font-size:12px;color:var(--text2);line-height:1.55;margin-top:4px}#wp_root .wp-notes b{color:var(--text)}' +
        '#wp_root details.wp-drawer{background:var(--bg3);border:1px solid var(--border);border-radius:8px;margin-bottom:var(--wp-gap)}' +
        '#wp_root details.wp-drawer>summary{cursor:pointer;padding:12px 16px;font-size:13px;font-weight:700;color:var(--text);list-style:none;display:flex;align-items:center;gap:8px}' +
        '#wp_root details.wp-drawer>summary::before{content:"\\25B8";color:var(--accent);transition:transform .15s}#wp_root details.wp-drawer[open]>summary::before{transform:rotate(90deg)}' +
        '#wp_root .wp-drawer-b{padding:0 16px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}#wp_root .wp-drawer-b>*{min-width:0}' +
        '#wp_root .wp-tw{overflow-x:auto;max-width:100%}#wp_root .wp-tw .dtable td,#wp_root .wp-tw .dtable th{white-space:nowrap}' +
        '#wp_root .wp-tw .dtable td.num{text-align:right;font-variant-numeric:tabular-nums}' +
        '#wp_root .wp-ed td{padding:3px 4px}#wp_root .wp-ed input,#wp_root .wp-ed select{width:100%;min-width:64px}#wp_root .wp-ed select{min-width:104px}' +
        '#wp_root .wp-ed td.ro{color:var(--text2);font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums}' +
        '#wp_root .wp-ed tr.wp-flash td{animation:wpflash 1.4s ease-out}@keyframes wpflash{0%{background:rgba(240,136,62,.35)}100%{background:transparent}}' +
        '#wp_root .wp-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}#wp_root .wp-btns .btn{padding:7px 13px;font-size:12px}' +
        '#wp_root .wp-hint{font-size:11px;color:var(--text3);margin-top:4px;line-height:1.4}' +
        '#wp_root .wp-off{display:none!important}' +
        '#wp_root .wp-check label{display:flex;align-items:center;gap:8px;text-transform:none;font-size:12.5px;color:var(--text);letter-spacing:0;margin-top:20px}' +
        '#wp_root .wp-chip{display:inline-block;font-size:10px;font-weight:700;padding:1px 7px;border-radius:9px;background:rgba(88,166,255,.14);color:var(--blue);margin-left:6px;text-transform:none;letter-spacing:0;vertical-align:middle}' +
        '#wp_root .wp-chip.prov{background:rgba(210,153,34,.15);color:var(--wp-warn)}' +
        '#wp_root .wp-cmpk{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:10px 0 8px}' +
        '#wp_root .wp-cmpc{background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--text3);border-radius:8px;padding:7px 10px;min-width:0;transition:border-color .2s}' +
        '#wp_root .wp-cmpc .kpi-l{display:block;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#wp_root .wp-cmpc .kpi-v{display:block;font-size:15px;font-weight:700;color:var(--text);margin-top:2px;font-variant-numeric:tabular-nums}#wp_root .wp-cmpc .kpi-s{display:block;font-style:normal;font-size:11px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#wp_root .wp-cmpc.st-ok{border-left-color:var(--wp-ok)}#wp_root .wp-cmpc.st-warn{border-left-color:var(--wp-warn)}' +
        '#wp_root .wp-cdot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:0}' +
        '#wp_root .wp-cmpt tr.wp-sel td{background:rgba(240,136,62,.08)}#wp_root .wp-cmpt tr.wp-sel td:first-child{box-shadow:inset 3px 0 0 var(--accent)}#wp_root .wp-cmpt tr.wp-cf td{color:var(--text2)}' +
        '#wp_root .wp-cmpt td:first-child{white-space:normal;min-width:190px}#wp_root .wp-cmpt td:nth-child(5){white-space:normal}' +
        // v4.5 WP21: pattern strips along the well (comparison rows), the map-kind switch, the per-section editor and its chips
        '#wp_root .wp-pstrip{display:block;width:100%;min-width:96px;height:16px;border-radius:4px;overflow:hidden;background:var(--bg3)}#wp_root .wp-pstrip rect{transition:opacity .15s}#wp_root .wp-pstrip:hover rect{opacity:.85}' +
        '#wp_root .wp-mapk{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 8px}#wp_root .wp-mapk button{font-size:11.5px;padding:4px 10px}' +
        '#wp_root .wp-secbar{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:6px 0 4px;border:1px solid var(--border);background:var(--bg3)}#wp_root .wp-secbar i{display:block;height:100%;min-width:2px;transition:flex-grow .25s ease}' +
        '#wp_root .wp-seclg{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--text2);margin-bottom:6px}#wp_root .wp-seclg b{color:var(--text);font-weight:600}' +
        '#wp_root td.wp-seccov{white-space:normal;min-width:150px;font-size:11.5px;line-height:1.35}' +
        '#wp_root #wp_tbl_corrSections select[data-c="by"]{width:74px}#wp_root #wp_tbl_corrSections input{width:76px}#wp_root #wp_tbl_corrSections select[data-c="corr"]{min-width:128px}' +
        '@media (prefers-reduced-motion: reduce){#wp_root .wp-secbar i,#wp_root .wp-pstrip rect{transition:none}}' +
        '#wp_root .wp-cmpt .wp-use{padding:3px 10px;font-size:11.5px}#wp_root .wp-cmpt tbody tr{transition:background .15s}#wp_root .wp-cmpt tbody tr:hover td{background:rgba(139,148,158,.08)}' +
        '#wp_root .wp-heat{margin:12px 0 4px;padding:10px 12px;border:1px solid var(--border);border-left:3px solid var(--red,#f85149);border-radius:8px;background:var(--bg3);transition:border-color .2s,opacity .2s}' +
        '#wp_root .wp-heat .wp-heat-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:6px 14px;margin:6px 0 8px}' +
        '#wp_root .wp-heat .wp-hk{font-size:10.5px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em}#wp_root .wp-heat .wp-hv{font-size:14px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}' +
        '#wp_root .wp-heat .wp-hbar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:2px 0 6px;background:var(--bg2)}#wp_root .wp-heat .wp-hbar i{display:block;height:100%;transition:width .25s}' +
        '#wp_root .wp-relaxleg{margin-top:4px;color:var(--text2)}' +
        '#wp_root .wp-bud{display:flex;flex-direction:column;gap:5px;margin:6px 0 4px}#wp_root .wp-bud-r{display:grid;grid-template-columns:118px 1fr 76px;gap:8px;align-items:center;font-size:11.5px;color:var(--text2)}' +
        '#wp_root .wp-bud-k{text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#wp_root .wp-bud-v{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}' +
        '#wp_root .wp-bud-t{position:relative;height:13px;border-radius:4px;background:var(--bg2)}#wp_root .wp-bud-t i{position:absolute;top:0;bottom:0;border-radius:4px;transition:left .25s,width .25s}' +
        '@media (max-width:600px){#wp_root .wp-bud-r{grid-template-columns:96px 1fr 66px;font-size:11px}}#wp_root .wp-comp.wp-layer{cursor:pointer}#wp_root .wp-comp.wp-layer:focus{outline:none}#wp_root .wp-comp.wp-layer:focus path,#wp_root .wp-comp.wp-layer:hover path{stroke-opacity:.9}' +
        '@media (prefers-reduced-motion: reduce){#wp_root .wp-bud-t i{transition:none}}' +
        '#wp_root .wp-qc td.qc{text-align:center;padding:4px 6px}#wp_root .wp-qcb{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;border-radius:10px;font-size:11px;font-weight:800;background:var(--bg4);color:var(--text3);cursor:help}' +
        '#wp_root .wp-qcb.ok{background:rgba(63,185,80,.15);color:var(--wp-ok)}#wp_root .wp-qcb.warn{background:rgba(210,153,34,.17);color:var(--wp-warn)}#wp_root .wp-qcb.fail{background:rgba(248,81,73,.17);color:var(--wp-fail)}' +
        '#wp_root .wp-score{display:inline-block;min-width:34px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}' +
        '#wp_root .wp-bar{position:relative;height:8px;border-radius:4px;background:var(--bg4);min-width:90px;overflow:hidden}#wp_root .wp-bar i{position:absolute;top:0;bottom:0;border-radius:4px;transition:width .2s,left .2s}' +
        '#wp_root .wp-mres{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:var(--wp-gap);align-items:start;margin-top:12px}' +
        '@media (max-width:1000px){#wp_root .wp-mres{grid-template-columns:minmax(0,1fr)}}' +
        '#wp_root .wp-kpis.wp-k11{grid-template-columns:repeat(auto-fit,minmax(138px,1fr))}#wp_root .wp-tune:empty{display:none}#wp_root .wp-tkpis{margin:8px 0 10px;grid-template-columns:repeat(auto-fit,minmax(138px,1fr))}#wp_root .wp-tplots{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:var(--wp-gap);align-items:start;margin-top:12px}' +
        '#wp_root .wp-tcorr{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:10px}#wp_root .wp-tcorr .wp-hint{flex:1 1 260px;margin:0}' +
        '@media (max-width:1000px){#wp_root .wp-tplots{grid-template-columns:minmax(0,1fr)}}' +
        '#wp_root .wp-prog{height:4px;border-radius:2px;background:var(--bg4);overflow:hidden;margin-top:8px}#wp_root .wp-prog i{display:block;height:100%;background:var(--accent);transition:width .2s}' +
        '#wp_root .wp-paste{display:none;margin-top:8px}#wp_root .wp-paste.on{display:block}#wp_root .wp-paste textarea{width:100%;min-height:90px;font-family:monospace;font-size:12px}' +
        '#wp_root .wp-studies>div:empty{display:none}#wp_root .wp-studies:not(:has(>div:not(:empty))){display:none}#wp_root .wp-studies{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:4px 16px 14px;margin-bottom:var(--wp-gap)}' +
        '#wp_root .wp-heat td.wp-hc{padding:0;transition:background .2s}#wp_root .wp-heat td.wp-hc button{display:block;width:100%;min-width:52px;padding:6px 8px;border:0;background:transparent;color:var(--text);font:inherit;font-variant-numeric:tabular-nums;text-align:right;cursor:pointer;border-radius:4px}' +
        '#wp_root .wp-heat td.wp-hc button:hover{box-shadow:inset 0 0 0 1px var(--border-light)}#wp_root .wp-heat td.wp-hc.on button{box-shadow:inset 0 0 0 2px var(--accent);font-weight:700}' +
        '#wp_root .wp-heat th{white-space:nowrap}#wp_root table.wp-heat thead th:first-child,#wp_root table.wp-heat tbody th,#wp_root table.wp-sumgrid thead th:first-child,#wp_root table.wp-sumgrid tbody th{width:1%;white-space:nowrap}#wp_root .wp-heatleg{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text2);margin-top:8px;flex-wrap:wrap}#wp_root .wp-heatleg i{display:inline-block;width:140px;height:8px;border-radius:4px}' +
        '#wp_root .wp-sec{animation:wpfade .18s ease-out}@keyframes wpfade{from{opacity:.4;transform:translateY(4px)}to{opacity:1;transform:none}}' +
        '#wp_root .wp-sec-h{display:flex;align-items:baseline;gap:10px;margin:4px 0 12px;font-size:15px;font-weight:700;color:var(--text)}#wp_root .wp-sec-h span{font-size:12px;font-weight:500;color:var(--text3)}' +
        '#wp_root .wp-col{display:flex;flex-direction:column;min-width:0}' +
        '#wp_root .wp-fchips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 6px}' +
        '#wp_root .wp-fchip{flex:1 1 190px;max-width:280px;display:inline-flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:118px;padding:6px 10px 6px 9px;border-radius:8px;border:1px solid var(--border);border-left:3px solid var(--text3);background:var(--bg3);color:var(--text);font-size:11.5px;cursor:pointer;text-align:left;transition:border-color .15s,background .15s,box-shadow .15s}' +
        '#wp_root .wp-fchip:hover{border-color:var(--border-light)}' +
        '#wp_root .wp-fchip .n{font-weight:700;display:flex;align-items:center;gap:6px}#wp_root .wp-fchip .n i{width:9px;height:9px;border-radius:50%;display:inline-block}' +
        '#wp_root .wp-fchip .v{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}#wp_root .wp-fchip .s{font-size:10.5px;color:var(--text2)}' +
        '#wp_root .wp-fchip.st-ok{border-left-color:var(--wp-ok)}#wp_root .wp-fchip.st-warn{border-left-color:var(--wp-warn)}' +
        '#wp_root .wp-fchip.sel{background:rgba(240,136,62,.10);border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}' +
        '#wp_root .wp-dense th,#wp_root .wp-dense td{padding:6px 7px;font-size:12px}#wp_root .wp-dense th{font-size:10px;text-transform:none;letter-spacing:.2px}' +
        '#wp_root .wp-pvtbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px}' +
        '#wp_root .wp-2c{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--wp-gap);align-items:start}#wp_root .wp-2c>*{min-width:0}' +
        '#wp_root .rbox{margin-top:0}' +
        '#wp_root .wp-pvtmg{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--wp-gap);align-items:start;padding-top:12px}#wp_root .wp-pvtmg>:first-child{grid-column:1/-1}#wp_root .wp-pvtmg .wp-cmpt td:first-child{min-width:150px}' +
        '@media (max-width:900px){#wp_root .wp-pvtmg{grid-template-columns:minmax(0,1fr)}}' +
        '#wp_root .wp-stale #wp_bench,#wp_root .wp-stale .wp-kpis{opacity:.55;transition:opacity .2s}' +
        '@media (max-width:1180px){#wp_root .wp-row3{grid-template-columns:repeat(2,minmax(0,1fr))}#wp_root .wp-row3>:last-child{grid-column:1/-1}}' +
        '@media (max-width:1000px){#wp_root .wp-bench,#wp_root .wp-2c{grid-template-columns:minmax(0,1fr)}}' +
        '@media (max-width:640px){#wp_root .wp-row3{grid-template-columns:minmax(0,1fr)}#wp_root .wp-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}#wp_root .wp-kpi .kpi-v{font-size:15px}' +
        '#wp_root .wp-card{padding:12px}#wp_root .wp-steps{top:-14px;flex-wrap:nowrap}#wp_root .wp-exs{flex-wrap:nowrap;margin-left:0}#wp_root .wp-tools{margin-left:0;width:100%}#wp_root .wp-drawer-b{grid-template-columns:minmax(0,1fr)}}' +
        // B (WP28): the all-wells card
        '#wp_root .wp-wells-cta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 14px;margin:0 0 var(--wp-gap);border:1px dashed var(--border-light);border-radius:8px;font-size:12.5px;color:var(--text2)}' +
        '#wp_root .wp-wells-host:empty{display:none}#wp_root .wp-wkpis{margin:10px 0 8px;grid-template-columns:repeat(auto-fit,minmax(136px,1fr))}#wp_root #wp_wsel:empty{display:none}' +
        '#wp_root .wp-wtbl tr.wp-wrow{cursor:pointer}#wp_root .wp-wtbl tr.wp-wrow:focus-visible{outline:2px solid var(--focus,#58a6ff);outline-offset:-2px}#wp_root .wp-wtbl td:first-child{min-width:0;width:1%}' +
        '#wp_root .wp-wtbl td:nth-child(2){white-space:nowrap}#wp_root .wp-wtbl td:nth-child(9){white-space:normal;min-width:140px}' +
        '#wp_root .wp-wsel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;padding:8px 12px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);font-size:12.5px;animation:wpfade .18s ease-out}' +
        '#wp_root .wp-wsel .wp-wsel-t{color:var(--text2);flex:1 1 240px}#wp_root .wp-wsel .btn{padding:5px 11px;font-size:12px}' +
        '@media (max-width:640px){#wp_root .wp-wkpis{grid-template-columns:repeat(2,minmax(0,1fr))}#wp_root .wp-wells .wp-tools{flex-wrap:wrap}}' +
        '@media (prefers-reduced-motion:reduce){#wp_root *,#wp_root *::before,#wp_root *::after{animation:none!important;transition:none!important}}' +
        '</style>';

    // ── examples (a vertical oil well and a deviated wet-gas well; the user's own data replaces them) ────────────
    var EXAMPLES = {
        oil: {
            label: 'Vertical oil well',
            scalars: { wp_ftype: 'oil', wp_api: 35, wp_sgg: 0.65, wp_gor: 500, wp_wc: 30, wp_ipr: 'pi', wp_pr: 3000, wp_tres: 200, wp_ip_J: 2,
                       wp_perfTop: 7980, wp_perfBot: 8020, wp_midPerf: 8000, wp_tht: 120, wp_surfT: 60, wp_choke: true, wp_bean: 32, wp_psep: 100 },
            tables: { survey: [[0, 0, 0], [8000, 0, 0], [8100, 0, 0]],
                      strings: [{ kind: 'tubing', od: 2.875, id: 2.441, rough: 0.0006, topMd: 0, botMd: 7950 }, { kind: 'casing', od: 7, id: 6.276, rough: 0.0006, topMd: 0, botMd: 8100 }],
                      restrictions: [{ kind: 'sssv', md: 1000, id: 2.313 }, { kind: 'nipple', md: 7900, id: 2.205 }],
                      geo: { points: [[0, 60], [8000, 200]] }, flowline: [{ name: 'Flowline', len: 2000, id: 3, dz: 0 }],
                      tests: [{ id: 'T1', date: '2026-11-01', q_o: 700, q_w: 300, q_g: 350, thp_psig: 250, tht_F: 120, bean64: 32, gaugeMd: 7900, gauge_psia: 2500, use: true }] }
        },
        gas: {
            label: 'Deviated gas-condensate well',
            scalars: { wp_ftype: 'condensate', wp_api: 55, wp_sgg: 0.65, wp_gor: 0, wp_cgr: 20, wp_wgr: 2, wp_wc: 0, wp_ipr: 'litP2', wp_pr: 5000, wp_tres: 230,
                       wp_ip_a: 500, wp_ip_b: 0.05, wp_perfTop: 9900, wp_perfBot: 10000, wp_midPerf: 9950, wp_tht: 140, wp_surfT: 70, wp_choke: true, wp_bean: 24, wp_psep: 800 },
            tables: { survey: [[0, 0, 0], [2000, 0, 120], [2500, 10, 120], [3000, 20, 120], [3500, 30, 120], [6000, 30, 120], [6500, 20, 120], [7000, 10, 120], [7500, 0, 120], [10000, 0, 120]],
                      strings: [{ kind: 'tubing', od: 3.5, id: 2.992, rough: 0.0006, topMd: 0, botMd: 5000 }, { kind: 'tubing', od: 2.875, id: 2.441, rough: 0.0006, topMd: 5000, botMd: 9850 },
                                { kind: 'casing', od: 9.625, id: 8.681, rough: 0.0006, topMd: 0, botMd: 6500 }, { kind: 'liner', od: 7, id: 6.276, rough: 0.0006, topMd: 6300, botMd: 10100 }],
                      restrictions: [{ kind: 'sssv', md: 1500, id: 2.75 }, { kind: 'xo', md: 5000, id: 2.441 }],
                      geo: { points: [[0, 70], [9300, 230]] }, flowline: [{ name: 'Flowline', len: 1500, id: 3, dz: 0 }],
                      tests: [{ id: 'G1', date: '2026-10-20', q_o: 120, q_w: 12, q_g: 6000, thp_psig: 2300, tht_F: 140, bean64: 24, gaugeMd: 9800, gauge_psia: 3900, use: true }] }
        },
        // B (WP24): a horizontal oil well (the lateral from the survey and the perforations), a two-layer well, a deviated water injector
        hz: {
            label: 'Horizontal oil well',
            scalars: { wp_ftype: 'oil', wp_api: 35, wp_sgg: 0.65, wp_gor: 500, wp_wc: 20, wp_ipr: 'joshi', wp_pr: 3000, wp_tres: 200, wp_respb: 1800, wp_ip_k: 20, wp_ip_h: 60, wp_ip_kvkh: 0.1,
                       wp_ip_rw: 0.354, wp_ip_re: 2000, wp_ip_S: 0, wp_ip_L: '', wp_perfTop: 9400, wp_perfBot: 11400, wp_midPerf: 10400, wp_tht: 125, wp_surfT: 60, wp_choke: true, wp_bean: 40, wp_psep: 100 },
            tables: { survey: [[0, 0, 0], [6000, 0, 45], [6500, 15, 45], [7000, 30, 45], [7500, 45, 45], [8000, 60, 45], [8500, 75, 45], [9000, 88, 45], [9400, 90, 45], [11500, 90, 45]],
                      strings: [{ kind: 'tubing', od: 3.5, id: 2.992, rough: 0.0006, topMd: 0, botMd: 8800 }, { kind: 'casing', od: 9.625, id: 8.681, rough: 0.0006, topMd: 0, botMd: 9000 }, { kind: 'liner', od: 5.5, id: 4.892, rough: 0.0006, topMd: 8700, botMd: 11500 }],
                      restrictions: [{ kind: 'sssv', md: 1000, id: 2.813 }], geo: { points: [[0, 60], [8000, 200]] }, flowline: [{ name: 'Flowline', len: 2000, id: 4, dz: 0 }], tests: [], layers: [] }
        },
        ml: {
            label: 'Two-layer oil well',
            scalars: { wp_ftype: 'oil', wp_api: 35, wp_sgg: 0.65, wp_gor: 500, wp_wc: 30, wp_ipr: 'multilayer', wp_pr: 3000, wp_tres: 200, wp_ip_rw: 0.354, wp_ip_re: 1490,
                       wp_perfTop: 7800, wp_perfBot: 8250, wp_midPerf: 8000, wp_tht: 120, wp_surfT: 60, wp_choke: true, wp_bean: 32, wp_psep: 100 },
            tables: { survey: [[0, 0, 0], [3000, 0, 90], [4000, 20, 90], [8400, 20, 90]],
                      strings: [{ kind: 'tubing', od: 2.875, id: 2.441, rough: 0.0006, topMd: 0, botMd: 7700 }, { kind: 'casing', od: 7, id: 6.276, rough: 0.0006, topMd: 0, botMd: 8400 }],
                      restrictions: [{ kind: 'sssv', md: 1000, id: 2.313 }], geo: { points: [[0, 60], [8000, 200]] }, flowline: [{ name: 'Flowline', len: 2000, id: 3, dz: 0 }], tests: [],
                      layers: [{ name: 'Upper', topMd: 7800, botMd: 7860, pr: 3100, J: 1.2, use: true }, { name: 'Lower (depleted)', topMd: 8190, botMd: 8250, pr: 2450, J: 0.9, use: true }] }
        },
        inj: {
            label: 'Deviated water injector',
            scalars: { wp_ftype: 'waterinj', wp_sgw: 1.05, wp_wc: 0, wp_ipr: 'injector', wp_pr: 3200, wp_tres: 200, wp_ip_II: 4, wp_ip_pfrac: 5200, wp_thp: 1200,
                       wp_perfTop: 8900, wp_perfBot: 9050, wp_midPerf: 8975, wp_tht: 80, wp_surfT: 60, wp_choke: false, wp_psep: 100 },
            tables: { survey: [[0, 0, 0], [1500, 0, 200], [2500, 20, 200], [3500, 35, 200], [7000, 35, 200], [9200, 35, 200]],
                      strings: [{ kind: 'tubing', od: 3.5, id: 2.992, rough: 0.0006, topMd: 0, botMd: 8850 }, { kind: 'casing', od: 7, id: 6.276, rough: 0.0006, topMd: 0, botMd: 9200 }],
                      restrictions: [], geo: { points: [[0, 60], [7700, 200]] }, flowline: [], tests: [], layers: [] }
        },
        // B (WP26): a deviated oil well on an ESP — high water cut, depleted; the generic example pump set in the 35° tangent
        esp: {
            label: 'Deviated oil well on an ESP',
            scalars: { wp_ftype: 'oil', wp_api: 30, wp_sgg: 0.7, wp_gor: 250, wp_wc: 75, wp_ipr: 'pi', wp_pr: 2400, wp_tres: 210, wp_ip_J: 3,
                       wp_perfTop: 8930, wp_perfBot: 8990, wp_midPerf: 8960, wp_tht: 130, wp_surfT: 70, wp_choke: false, wp_thp: 150, wp_psep: 100,
                       wp_lift: 'esp', wp_esp_md: 8450, wp_esp_freq: 60, wp_esp_stages: 236, wp_esp_sep: 0, wp_esp_nat: false, wp_esp_visc: false, wp_esp_od: 4.56,
                       wp_esp_hp: 120, wp_esp_volt: 2100, wp_esp_amp: 36, wp_esp_awg: '2' },
            tables: { survey: [[0, 0, 45], [1500, 0, 45], [2000, 10, 45], [2500, 20, 45], [3000, 30, 45], [3250, 35, 45], [9100, 35, 45]],
                      strings: [{ kind: 'tubing', od: 3.5, id: 2.992, rough: 0.0006, topMd: 0, botMd: 8450 }, { kind: 'casing', od: 7, id: 6.276, rough: 0.0006, topMd: 0, botMd: 9100 }],
                      restrictions: [], geo: { points: [[0, 70], [7750, 210]] }, flowline: [{ name: 'Flowline', len: 1500, id: 3, dz: 0 }], tests: [], layers: [],
                      pump: 'example' }
        },
        // review fix (v4.5): a deviated oil well on continuous gas lift — injection pressure, rate and packer set; loading it designs the
        // unloading valves (a Job) so the deviated-valve chart, the mandrels on the schematic and the KPIs show straight away
        gl: {
            label: 'Deviated oil well on gas lift',
            scalars: { wp_ftype: 'oil', wp_api: 35, wp_sgg: 0.7, wp_gor: 300, wp_wc: 60, wp_ipr: 'pi', wp_pr: 2600, wp_tres: 200, wp_ip_J: 2,
                       wp_perfTop: 8930, wp_perfBot: 8990, wp_midPerf: 8960, wp_tht: 120, wp_surfT: 70, wp_choke: false, wp_thp: 150, wp_psep: 100,
                       wp_lift: 'gaslift', wp_gl_pinj: 1200, wp_gl_qinj: 800, wp_gl_packer: 8400, wp_gl_sg: 0.65, wp_gl_dpv: 100 },
            tables: { survey: [[0, 0, 45], [1500, 0, 45], [2000, 10, 45], [2500, 20, 45], [3000, 30, 45], [3250, 35, 45], [9100, 35, 45]],
                      strings: [{ kind: 'tubing', od: 2.875, id: 2.441, rough: 0.0006, topMd: 0, botMd: 8500 }, { kind: 'casing', od: 7, id: 6.276, rough: 0.0006, topMd: 0, botMd: 9100 }],
                      restrictions: [{ kind: 'sssv', md: 1000, id: 2.313 }], geo: { points: [[0, 70], [7750, 200]] }, flowline: [{ name: 'Flowline', len: 1500, id: 3, dz: 0 }], tests: [], layers: [], glValves: [] },
            design: true
        }
    };

    // ── table editors (wts_wellperf_model, written through WTS_wp_model.write) ───────────────────────────
    function _surveyMode(M) { var s = M && M.well && M.well.survey; if (s && s.length && s[0].length === 2) return 'mdtvd'; var p = _plots().surveyMode; return (s && s.length) ? 'mdinc' : (p === 'mdtvd' ? 'mdtvd' : 'mdinc'); }
    var TABLES = {
        survey: function (M) {
            return _surveyMode(M) === 'mdtvd' ? [{ k: 0, l: 'MD', cat: 'length', u: 'ft' }, { k: 1, l: 'TVD', cat: 'length', u: 'ft' }]
                : [{ k: 0, l: 'MD', cat: 'length', u: 'ft' }, { k: 1, l: 'Inc', u: '°' }, { k: 2, l: 'Azi', u: '°' }];
        },
        strings: function () { return [{ k: 'kind', l: 'Kind', opts: [['tubing', 'Tubing'], ['casing', 'Casing'], ['liner', 'Liner']] }, { k: 'od', l: 'OD', cat: 'lengthSmall', u: 'in' }, { k: 'id', l: 'ID', cat: 'lengthSmall', u: 'in' }, { k: 'rough', l: 'Rough.', cat: 'lengthSmall', u: 'in' }, { k: 'topMd', l: 'Top MD', cat: 'length', u: 'ft' }, { k: 'botMd', l: 'Bottom MD', cat: 'length', u: 'ft' }]; },
        restrictions: function () { return [{ k: 'kind', l: 'Kind', opts: [['sssv', 'SSSV'], ['nipple', 'Nipple'], ['sleeve', 'Sleeve'], ['xo', 'Cross-over'], ['downholeChoke', 'Downhole choke']] }, { k: 'md', l: 'MD', cat: 'length', u: 'ft' }, { k: 'id', l: 'ID', cat: 'lengthSmall', u: 'in' }, { k: 'k', l: 'K (opt.)', u: '' }]; },
        geo: function () { return [{ k: 0, l: 'TVD', cat: 'length', u: 'ft' }, { k: 1, l: 'Temperature', cat: 'temperature', u: '°F' }]; },
        hlayers: function () { return [{ k: 0, l: 'Top MD', cat: 'length', u: 'ft' }, { k: 1, l: 'Bottom MD', cat: 'length', u: 'ft' }, { k: 2, l: 'U', cat: 'heatTransferCoef', u: 'Btu/hr·ft²·°F' }, { k: 3, l: 'k_e (opt.)', cat: 'thermalConductivity', u: 'Btu/hr·ft·°F' }]; },
        flowline: function () { return [{ k: 'name', l: 'Name', text: true }, { k: 'len', l: 'Length', cat: 'length', u: 'ft' }, { k: 'id', l: 'ID', cat: 'lengthSmall', u: 'in' }, { k: 'dz', l: 'Rise', cat: 'length', u: 'ft' }]; },
        // B (WP23): the lab table, the Rv table and the emulsion table (all inside the model key lab)
        lab: function () { return [{ k: 'p', l: 'p', cat: 'pressure', u: 'psia' }, { k: 'rs', l: 'Rs', cat: 'gor', u: 'scf/STB' }, { k: 'bo', l: 'Bo', u: _fvfLab() }, { k: 'muo', l: 'Viscosity', u: 'cp' }]; },
        rv: function () { return [{ k: 0, l: 'p', cat: 'pressure', u: 'psia' }, { k: 1, l: 'Rv', cat: 'cgr', u: 'STB/MMscf' }]; },
        emul: function () { return [{ k: 0, l: 'Water', u: '%', pct: true }, { k: 1, l: 'Viscosity ratio', u: 'emulsion / oil' }]; },
        // v4.5 WP21: per-section correlations — 'From' / 'To' are MD (length) on an MD-interval row and degrees from vertical on an
        // inclination-band row (catOf: the unit follows the row's By cell)
        corrSections: function (M) {
            var gas = M && _isGasType(M.fluid.type);
            return [{ k: 'by', l: 'By', opts: [['md', 'MD'], ['inc', 'Incl.']] }, { k: 'from', l: 'From', catOf: _secCat, uh: _secU }, { k: 'to', l: 'To', catOf: _secCat, uh: _secU },
                    { k: 'corr', l: 'Correlation', opts: _corrList('well').filter(function (c) { return gas || (c.key !== 'gasTZ' && c.key !== 'gasCS'); }).map(function (c) { return [c.key, _corrShortL(c.key).replace(/\s*\(.*$/, '') + (c.verified ? '' : ' (prov.)')]; }) }];
        },
        layers: function (M) {
            var gas = M && _isGasType(M.fluid.type);
            return [{ k: 'name', l: 'Layer', text: true }, { k: 'topMd', l: 'Top MD', cat: 'length', u: 'ft' }, { k: 'botMd', l: 'Bottom MD', cat: 'length', u: 'ft' }, { k: 'pr', l: 'p̄r', cat: 'pressure', u: 'psia' }]
                .concat(gas ? [{ k: 'a', l: 'LIT a (p²)', u: '' }, { k: 'b', l: 'LIT b (p²)', u: '' }] : [{ k: 'J', l: 'J', cat: 'productivityIndex', u: 'STB/d/psi' }, { k: 'pb', l: 'pb', cat: 'pressure', u: 'psia' }])
                .concat([{ k: 'k', l: 'k', cat: 'permeability', u: 'md' }, { k: 'h', l: 'h', cat: 'length', u: 'ft' }, { k: 'S', l: 'S', u: '' }]);
        },
        tests: function () {
            return [{ k: 'id', l: 'Test', text: true }, { k: 'date', l: 'Date', text: true }, { k: 'q_o', l: 'Oil', cat: 'liquidRate', u: 'STB/d' }, { k: 'q_w', l: 'Water', cat: 'liquidRate', u: 'BWPD' },
                    { k: 'q_g', l: 'Gas', cat: 'gasRateSmall', u: 'Mscf/d' }, { k: 'thp_psig', l: 'THP', cat: 'pressureG', u: 'psig' }, { k: 'tht_F', l: 'THT', cat: 'temperature', u: '°F' },
                    { k: 'bean64', l: 'Bean', u: '/64' }, { k: 'gaugeMd', l: 'Gauge MD', cat: 'length', u: 'ft' }, { k: 'gauge_psia', l: 'Gauge p', cat: 'pressure', u: 'psia' },
                    // B (WP25): the casing pressure and the metered lift gas of a gas-lifted test (the gas-lift diagnosis reads them)
                    { k: 'chp_psig', l: 'CHP', cat: 'pressureG', u: 'psig' }, { k: 'qinj_Mscfd', l: 'Lift gas', cat: 'gasRateSmall', u: 'Mscf/d' }];
        }
    };
    function _tableRows(M, t) {
        if (!M) return [];
        if (t === 'survey') return (M.well.survey || []).map(function (r) { return r.slice(); });
        if (t === 'strings') return (M.well.strings || []).map(function (r) { return Object.assign({}, r); });
        if (t === 'restrictions') return (M.well.restrictions || []).map(function (r) { return Object.assign({}, r); });
        if (t === 'geo') return ((M.well.geo && M.well.geo.points) || []).map(function (r) { return r.slice(); });
        if (t === 'hlayers') return ((M.well.heat && M.well.heat.layers) || []).map(function (l) { return [l.topMd, l.botMd, l.U, l.ke]; });
        if (t === 'flowline') return (M.surface.flowline || []).map(function (r) { return Object.assign({}, r); });
        if (t === 'tests') return (M.tests || []).map(function (r) { return Object.assign({}, r); });
        var Lb = M.fluid && M.fluid.lab;
        if (t === 'lab') return ((Lb && Lb.rows) || []).map(function (r) { return Object.assign({}, r); });
        if (t === 'rv') return ((Lb && Lb.rv) || []).map(function (r) { return r.slice(); });
        if (t === 'emul') return ((Lb && Lb.emul) || []).map(function (r) { return r.slice(); });
        if (t === 'corrSections') return ((M.system.corr && M.system.corr.sections) || []).map(function (r) { return Object.assign({}, r); });
        if (t === 'layers') return ((M.res && M.res.layers) || []).map(function (r) { return Object.assign({}, r); });
        return [];
    }
    function _secCat(r) { return r && r.by === 'inc' ? null : 'length'; }
    function _secU() { return _lab('length', 'ft') + ' or °'; }
    function _cCat(c, r) { return c.catOf ? c.catOf(r) : c.cat; }
    function _cellVal(c, v, r) {
        if (c.opts || c.text) return v == null ? '' : String(v);
        if (!_fin(v)) return '';
        if (c.pct) return String(Math.round(v * 1e6) / 1e4);
        var d = _dv(v, _cCat(c, r));
        return String(Math.round(d * 1e4) / 1e4);
    }
    function _renderTable(t) {
        var host = _byId('wp_tbl_' + t); if (!host) return;
        var M = ST.M || _read(), cols = TABLES[t](M), rows = _tableRows(M, t), extra = _extraCols(t, M);
        var h = '<div class="wp-tw"><table class="dtable wp-ed" data-t="' + t + '"><thead><tr>' + cols.map(function (c) {
            return '<th' + (c.nocase ? ' style="text-transform:none"' : '') + '>' + _esc(c.l) + (c.uh ? ' <span class="wp-u">(' + _esc(c.uh()) + ')</span>' : (c.u ? ' <span class="wp-u">(' + _esc(c.cat ? _lab(c.cat, c.u) : c.u) + ')</span>' : '')) + '</th>';
        }).join('') + (extra ? extra.head.map(function (x) { return '<th>' + x + '</th>'; }).join('') : '') + '<th></th></tr></thead><tbody>';
        var rowHtml = function (r, i) {
            return '<tr data-r="' + i + '">' + cols.map(function (c) {
                var v = r ? (Array.isArray(r) ? r[c.k] : r[c.k]) : null;
                if (c.opts) return '<td><select data-t="' + t + '" data-c="' + c.k + '" aria-label="' + _esc(c.l) + '">' + c.opts.map(function (o) { return '<option value="' + o[0] + '"' + (String(v) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></td>';
                return '<td><input data-t="' + t + '" data-c="' + c.k + '" aria-label="' + _esc(c.l) + '" ' + (c.text ? 'type="text"' : 'type="number" step="any" inputmode="decimal"') + ' value="' + _esc(_cellVal(c, v, r)) + '"></td>';
            }).join('') + (extra ? extra.cells(r, i) : '') + '<td><button type="button" class="btn btn-secondary wp-del" data-del="' + t + '" data-r="' + i + '" aria-label="Delete row" title="Delete row">&#10005;</button></td></tr>';
        };
        rows.forEach(function (r, i) { h += rowHtml(r, i); });
        if (!rows.length) h += rowHtml(null, 0);
        h += '</tbody></table></div>';
        host.innerHTML = h;
    }
    // computed read-only TVD columns of the strings and restrictions tables (every depth shows MD and TVD)
    function _tvdAt(md) { var W = ST.W; if (!_fin(md) || !W || !W.ok || typeof W.tvdAt !== 'function') return null; try { var v = W.tvdAt(md); return _fin(v) ? v : null; } catch (e) { return null; } }
    function _tvdCell(md) { var v = _tvdAt(md); return '<td class="ro">' + (_fin(v) ? _fmt(_dv(v, 'length'), 1) : '—') + '</td>'; }
    function _extraCols(t, M) {
        if (t === 'survey') return _surveyExtra(M);
        if (t === 'strings') return { n: 2, head: ['Top TVD (' + _lab('length', 'ft') + ')', 'Bottom TVD (' + _lab('length', 'ft') + ')'], cells: function (r) { return _tvdCell(r ? r.topMd : null) + _tvdCell(r ? r.botMd : null); } };
        if (t === 'restrictions') return { n: 1, head: ['TVD (' + _lab('length', 'ft') + ')'], cells: function (r) { return _tvdCell(r ? r.md : null); } };
        if (t === 'tests') return { n: 1, head: ['Gauge TVD (' + _lab('length', 'ft') + ')'], cells: function (r) { return _tvdCell(r ? r.gaugeMd : null); } };
        if (t === 'corrSections') return { n: 1, head: ['Covers (MD · TVD, inclination)'], cells: function (r, i) { return '<td class="ro wp-seccov">' + _secCover(i) + '</td>'; } };
        if (t === 'hlayers') return { n: 2, head: ['Top TVD (' + _lab('length', 'ft') + ')', 'Bottom TVD (' + _lab('length', 'ft') + ')'], cells: function (r) { return _tvdCell(r ? r[0] : null) + _tvdCell(r ? r[1] : null); } };
        if (t === 'layers') return { n: 3, head: ['Top TVD (' + _lab('length', 'ft') + ')', 'Bottom TVD (' + _lab('length', 'ft') + ')', 'Rate at the operating point'], cells: function (r, i) {
            var lr = ST.R && ST.R.ok && ST.R.layers ? ST.R.layers.rates[i] : null, rc = _rateCat();
            return _tvdCell(r ? r.topMd : null) + _tvdCell(r ? r.botMd : null) + '<td class="ro"' + (lr && lr.crossflow ? ' style="color:var(--red)"' : '') + '>' + (lr ? _fmt(_dv(lr.q, rc[0]), 0) + ' ' + _lab(rc[0], rc[1]) : '—') + '</td>';
        } };
        return null;
    }
    function _surveyExtra(M) {
        var W = ST.W, stn = (W && W.ok && Array.isArray(W.stations)) ? W.stations : [];
        var three = _surveyMode(M) !== 'mdtvd';
        return {
            n: three ? 3 : 2,
            head: three ? ['TVD (' + _lab('length', 'ft') + ')', 'Departure (' + _lab('length', 'ft') + ')', 'DLS (°/100 ft)'] : ['Inc (°)', 'Departure (' + _lab('length', 'ft') + ')'],
            cells: function (r) {
                var md = r ? r[0] : null, s = _fin(md) ? stn.filter(function (x) { return Math.abs(x.md - md) < 0.01; })[0] : null;
                if (!s) return three ? '<td class="ro">—</td><td class="ro">—</td><td class="ro">—</td>' : '<td class="ro">—</td><td class="ro">—</td>';
                return three ? '<td class="ro">' + _fmt(_dv(s.tvd, 'length'), 1) + '</td><td class="ro">' + _fmt(_dv(s.dep, 'length'), 1) + '</td><td class="ro">' + _fmt(s.dls, 2) + '</td>'
                    : '<td class="ro">' + _fmt(s.inc, 1) + '</td><td class="ro">' + _fmt(_dv(s.dep, 'length'), 1) + '</td>';
            }
        };
    }
    function _refreshTvdCells() {
        var keys = { strings: ['topMd', 'botMd'], restrictions: ['md'], tests: ['gaugeMd'], hlayers: ['0', '1'], layers: ['topMd', 'botMd'] };
        Object.keys(keys).forEach(function (t) {
            var tbl = _byId('wp_tbl_' + t); if (!tbl || !tbl.querySelectorAll) return;
            Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr) {
                var ro = tr.querySelectorAll('td.ro');
                keys[t].forEach(function (k, i) {
                    var e = tr.querySelector('[data-c="' + k + '"]'), raw = e ? String(e.value == null ? '' : e.value).trim() : '', v = raw === '' ? null : parseFloat(raw.replace(',', '.'));
                    var tv = _fin(v) ? _tvdAt(_fromDisp(v, 'length')) : null;
                    if (ro[i]) ro[i].textContent = _fin(tv) ? _fmt(_dv(tv, 'length'), 1) : '—';
                });
            });
        });
        // B (WP24): the layer rates at the operating point (read-only column; negative = crossflow, red)
        var lt = _byId('wp_tbl_layers'), lr = ST.R && ST.R.ok && ST.R.layers ? ST.R.layers.rates : null, rcx = _rateCat();
        if (lt && lt.querySelectorAll) Array.prototype.forEach.call(lt.querySelectorAll('tbody tr'), function (tr, i) {
            var ro = tr.querySelectorAll('td.ro'), r = lr ? lr[i] : null; if (!ro[2]) return;
            ro[2].textContent = r ? _fmt(_dv(r.q, rcx[0]), 0) + ' ' + _lab(rcx[0], rcx[1]) : '—';
            if (ro[2].style) ro[2].style.color = r && r.crossflow ? 'var(--red)' : '';
        });
    }
    function _collectTable(t) {
        var tbl = _byId('wp_tbl_' + t), M = ST.M || _read(), cols = TABLES[t](M), out = [];
        if (!tbl) return out;
        Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr) {
            var arr = cols.every(function (c) { return typeof c.k === 'number'; }), row = arr ? [] : {}, any = false;
            cols.forEach(function (c) {
                var e = tr.querySelector('[data-c="' + c.k + '"]'); if (!e) return;
                var raw = String(e.value == null ? '' : e.value).trim(), v;
                if (c.opts || c.text) v = raw; else { v = raw === '' ? null : parseFloat(raw.replace(',', '.')); if (!_fin(v)) v = null; else v = c.pct ? v / 100 : _fromDisp(v, _cCat(c, row)); }
                if (v !== null && v !== '' && !c.opts) any = true;
                row[c.k] = v;
            });
            if (t === 'tests' && row) row.use = true;
            if (any) out.push(row);
        });
        return out;
    }
    function _writeTable(t, rows) {
        var Mm = G.WTS_wp_model; if (!Mm || typeof Mm.write !== 'function') return null;
        var patch = {};
        if (t === 'lab' || t === 'rv' || t === 'emul') { var lp = {}; lp[t === 'lab' ? 'rows' : t] = rows; if (t === 'lab') lp.example = false; return _labWrite(lp); }
        // geo carries the heat layers too (B, WP22): writing one keeps the other
        var cur = ST.M || _read(), curGeo = (cur && cur.well && cur.well.geo && cur.well.geo.points) || [], curLy = ((cur && cur.well && cur.well.heat && cur.well.heat.layers) || []).map(function (l) { return [l.topMd, l.botMd, l.U, l.ke]; });
        if (t === 'geo') patch.geo = { points: rows, layers: curLy };
        else if (t === 'hlayers') patch.geo = { points: curGeo.map(function (r) { return r.slice(); }), layers: rows.map(function (r) { return [r[0], r[1], r[2], r[3] == null ? null : r[3]]; }) };
        else if (t === 'layers') patch.layers = _layerTvds(rows);
        else patch[t] = rows;
        var r = Mm.write(patch);
        if (r && !r.ok) _banner('fail', 'The table was not saved: ' + ((r.errors || []).join(' ') || r.code));
        ST.M = _read() || ST.M;                  // the tables render from ST.M: keep it current even when the write did not solve (batched)
        if (t === 'tests') _syncMatchTests();
        return r;
    }

    // ── read / engines ────────────────────────────────────────────────────────
    function _read() {
        var Mm = G.WTS_wp_model;
        if (!Mm || typeof Mm.read !== 'function') return null;
        var M0; try { M0 = Mm.read({ scalars: _byId('wp_root') ? _liveScalars() : undefined }); } catch (e) { return null; }
        // v4.5 WP21: while a section boundary is dragged on the traverse plot, the dragged rows stand in for the stored ones (the
        // release writes them through WTS_wp_model.write)
        if (M0 && ST.secLive) { M0 = JSON.parse(JSON.stringify(M0)); M0.system.corr.sections = ST.secLive; }
        return M0;
    }
    function _isGasType(t) { return t === 'gas' || t === 'condensate' || t === 'gasinj'; }

    function _solve(M, live) {
        var out = { M: M, chk: null, F: null, I: null, W: null, R: null, SC: null, shut: null, loading: null, stubs: [] };
        if (!M) return out;
        out.chk = _call('WTS_wp_check', M);
        out.F = _call('WTS_wp_fluid.build', M.fluid, { T_F: M.res.T_F });   // T_F: the one-point bubble-point shift (as the solver's fluid)
        out.W = _call('WTS_wp_well.build', M.well, { res: M.res, fluidType: M.fluid.type, tests: M.tests, surface: M.surface });   // test gauges reach the schematic
        // B (WP24): the inflow gets the well path (multilayer: each layer at its TVD, referred to the mid-perforations)
        out.I = _call('WTS_wp_ipr.curve', M.res, out.F && out.F.ok ? out.F : undefined, out.W && out.W.ok ? { tvdAt: out.W.tvdAt, refMd: out.W.nodes ? out.W.nodes.midPerfMd : null } : undefined);
        var t0 = _now(), so = { live: !!live };
        // live drag: continue the last full solve's stable root (tracking solve) and carry its curves / q_s until the release
        var P = ST.R && ST.R.ok && ST.R.op && !ST.R.tracked ? ST.R : (ST.Rfull && ST.Rfull.ok ? ST.Rfull : null);
        if (live && P && P.grid) so = { live: true, warm: P.grid, track: { q: P.op.q, slope: P.op.dDdq, curves: P.curves, qs: P.qs, vlpMin: P.vlpMin } };
        out.R = _call('WTS_wp_system.solve', M, so);
        out.ms = _now() - t0;
        out.SC = _call('WTS_wp_well.schematic', out.W, out.R && out.R.ok ? out.R : null);
        if (out.R && out.R.ok) {
            out.loading = (out.R.loading && typeof out.R.loading === 'object') ? out.R.loading : null;
            if (!out.loading && _isGasType(M.fluid.type)) { var L = _call('WTS_wp_loading', out.R, out.F, out.W); out.loading = (L && L.ok !== false) ? L : null; }
        }
        if (!live) out.shut = _call('WTS_wp_system.shutIn', M);
        ['chk', 'F', 'I', 'W', 'R', 'SC', 'shut'].forEach(function (k) { if (_isStub(out[k])) out.stubs.push(out[k].name || k); });
        return out;
    }

    // ── calc ──────────────────────────────────────────────────────────────────
    var _force = false, _liveCall = false;
    function _calc() {
        calcs++;
        var root = _byId('wp_root');
        var M = _read();
        ST.M = M;
        var S = G.WTS_state = (G.WTS_state && typeof G.WTS_state === 'object') ? G.WTS_state : {};
        if (ST.slow && !_force && !_liveCall) {
            ST.stale = true;
            _renderStale();
            S.wellperf = Object.assign({}, S.wellperf || {}, { stale: true });
            _emit('wts:wellperf-solved', { ok: false, stale: true });
            return S.wellperf;
        }
        var live = _liveCall;
        var X = _solve(M, live);
        ST.chk = X.chk; ST.F = X.F; ST.I = X.I; ST.W = X.W; ST.R = X.R; ST.SC = X.SC; ST.loading = X.loading;
        if (!live) ST.shut = X.shut;
        ST.solveMs = X.ms || 0; ST.stale = false; ST.stubs = X.stubs;
        if (!live) ST.slow = ST.solveMs > budgetMs;
        if (live) ST.liveMs = ST.solveMs;
        else { ST.liveMs = null; if (X.R && X.R.ok && !X.R.tracked) ST.Rfull = X.R; ST.lastKey = _mkey(M); }
        // sensitivity / bean-schedule results made on other inputs are marked stale (dimmed, with a re-run chip)
        var mk = _mkey(M);
        if (ST.sens) ST.sens.stale = !!(ST.sensKey && ST.sensKey !== mk);
        if (ST.beans) ST.beans.stale = !!(ST.beansKey && ST.beansKey !== mk);
        if (ST.gl) ST.gl.stale = !!(ST.glKey && ST.glKey !== _glKey(M));
        if (!live) { if (_multOf(M).tuned && X.R && X.R.ok) _untunedRef(); else if (!_multOf(M).tuned) ST.untuned = null; }
        var R = (X.R && X.R.ok !== undefined) ? X.R : null, ok = !!(R && R.ok);
        S.wellperf = {
            v: 1, ok: ok, code: R && !ok ? (R.code || 'NO_SOLUTION') : null, op: ok ? R.op : null, roots: (R && R.roots) || [], qs: ok ? R.qs : null,
            vlpMin: ok ? R.vlpMin : null, traverse: ok ? R.traverse : null, breakdown: (ok && R.breakdown) || [], shutIn: (ST.shut && ST.shut.ok !== false) ? ST.shut : null,
            flags: (R && R.flags) || [], loading: ST.loading, sens: ST.sens, match: ST.match, surface: ok ? R.surface : null, rates: ok ? R.rates : null,
            model: M ? M.v : null, solveMs: ST.solveMs, slow: ST.slow, stubs: X.stubs, ts: Date.now(),
            tune: _tuneSummary(), mult: M ? { hl: _multOf(M).hl, f: _multOf(M).f } : null, untuned: ST.untuned && ST.untuned.op ? { op: ST.untuned.op } : null,
            wells: G.WTS_wp_wellsUi ? G.WTS_wp_wellsUi.summary() : null                                      // B (WP28)
        };
        if (root) _renderAll(live);
        _emit('wts:wellperf-solved', { ok: ok });
        return S.wellperf;
    }
    // the model identity used to tell whether a solve is needed again and whether study results are stale
    function _mkey(M) { if (!M) return ''; try { return JSON.stringify([M.fluid, M.res, M.well, M.surface, M.system, M.lift]); } catch (e) { return String(Math.random()); } }
    G.calcWellPerf = function () {
        var U = _U();
        return (U && typeof U.runCanonical === 'function') ? U.runCanonical(_calc) : _calc();
    };
    // the expected live-solve time: measured during this drag, else the last full solve scaled by its evaluation count (≈ 5 E live)
    function _liveMs() {
        if (_fin(ST.liveMs)) return ST.liveMs;
        var R = ST.R;
        return (R && R.ok && _fin(R.evals) && R.evals > 5) ? ST.solveMs * 5 / R.evals : ST.solveMs;
    }
    function _solveNow() { _force = true; try { G.calcWellPerf(); } finally { _force = false; } }
    function _solveLive() { _liveCall = true; try { G.calcWellPerf(); } finally { _liveCall = false; } }

    // ── rendering of results ──────────────────────────────────────────────────
    function _banner(kind, html) {
        var b = _byId('wp_banner'); if (!b) return;
        b.className = 'wp-banner rp-skip' + (kind ? ' ' + kind : '');
        if (kind === 'fail' || kind === 'warn') b.setAttribute('style', 'color:var(--' + (kind === 'fail' ? 'red' : 'yellow') + ')'); else b.removeAttribute('style');
        b.innerHTML = html || '';
    }
    function _renderStale() {
        var root = _byId('wp_root'); if (root && root.classList) root.classList.add('wp-stale');
        _banner('warn', '<span>⚠ Inputs changed. A solve takes about ' + _fmt(ST.solveMs, 0) + ' ms on this device, so the page waits for the Solve button.</span>' +
            '<button type="button" class="btn btn-primary" id="wp_solve" data-act="solve">Solve</button>');
    }
    function _renderAll(live) {
        var root = _byId('wp_root');
        if (root && root.classList) root.classList.remove('wp-stale');
        var R = ST.R, M = ST.M, ok = !!(R && R.ok);
        // banner
        if (ST.stubs && ST.stubs.length && !ok) _banner('warn', '<span>⚙ The calculation engines of this module are being installed (' + _esc(ST.stubs.slice(0, 3).join(', ')) + (ST.stubs.length > 3 ? ' …' : '') + '). Inputs are kept and the results appear as soon as they are available.</span>');
        else if (ST.slow) _banner('warn', '<span>⏱ A solve took ' + _fmt(ST.solveMs, 0) + ' ms on this device, longer than the interactive budget: changes now wait for the Solve button.</span><button type="button" class="btn btn-primary" id="wp_solve" data-act="solve">Solve</button>');
        else if (R && !ok && !_isStub(R)) _banner('fail', '<span>✗ ' + _esc(((R.errors || [])[0]) || (R.warnings && R.warnings[0] && R.warnings[0].msg) || 'No operating point for these inputs.') + '</span>');
        else if (ST.chk && ST.chk.errors && ST.chk.errors.length) _banner('warn', '<span>⚠ ' + _esc(ST.chk.errors.slice(0, 3).join(' · ')) + '</span>');
        else _banner('', '');
        _renderKpis();
        _renderSystemPlot();
        if (!live) {
            _renderSchematic();
            _renderOp();
            _renderBreakdown();
            _renderVerdicts();
            _renderTraverseCard();
            _renderDrawer();
            _renderStepResults();
            _renderHeat();
            _renderDots();
            _renderNotes();
            _renderCase();
            if (ST.sens) _renderSensTable();
            if (ST.beans) _renderBeans();
            _renderGl();
            if (ST.tune) _renderTune();
            _ext('render', false);
            if (G.WTS_wp_wellsUi) G.WTS_wp_wellsUi.render();
        } else { _renderOp(); _renderGl(); if (ST.heatDrag) _renderTraverseCard(); _ext('render', true); }
    }

    // KPI strip
    function _kpiHtml(label, val, sub, st, title) {
        return '<div class="kpi wp-kpi st-' + (st || 'none') + '"' + (title ? ' title="' + _esc(title) + '"' : '') + ' role="group" aria-label="' + _esc(label + ' ' + val + (st && st !== 'none' && st !== 'info' ? ' (' + { ok: 'within limits', warn: 'warning', fail: 'limit exceeded' }[st] + ')' : '')) + '">' +
            '<div class="kpi-l">' + _esc(label) + '</div><div class="kpi-v">' + _esc(val) + '</div>' + (sub ? '<div class="kpi-s">' + _esc(sub) + '</div>' : '') + '</div>';
    }
    function _kpis() {
        if (_isInj(ST.M)) return _kpisInj();
        var R = ST.R, M = ST.M, ok = !!(R && R.ok), gas = M && _isGasType(M.fluid.type), out = [];
        var rates = ok ? (R.rates || {}) : {}, op = ok ? R.op : null;
        var pwf = ok ? (_fin(R.pwf) ? R.pwf : (R.node === 'bottom' && op ? op.p : null)) : null;
        var thp = ok && R.surface ? (_fin(R.surface.thp_psig) ? R.surface.thp_psig : (_fin(R.surface.thp) ? R.surface.thp - PATM : null)) : null;
        // hydrate: the THT of the check (J-T corrected for gas wells, WTS_wp_well.temperature) against the hydrate temperature at the THP
        var tht = ok && R.surface ? R.surface.tht : null, thtChk = ok && R.surface ? (_fin(R.surface.thtHyd) ? R.surface.thtHyd : tht) : null, tHyd = ok && R.surface ? R.surface.tHyd : null;
        var pr = M ? M.res.pr : null;
        if (gas) out.push({ k: 'rate', l: 'Gas rate', v: _fin(rates.qg) ? _u(rates.qg / 1000, 'gasRate', 2, 'MMscf/d') : '—', s: _fin(rates.qo) ? 'Cond. ' + _u(rates.qo, 'liquidRate', 0, 'STB/d') : '', st: ok ? 'ok' : (R ? 'fail' : 'none') });
        else out.push({ k: 'rate', l: 'Liquid rate', v: _fin(rates.qL) ? _u(rates.qL, 'liquidRate', 0, 'STB/d') : '—', s: _fin(rates.qo) ? 'Oil ' + _u(rates.qo, 'liquidRate', 0, 'STB/d') : '', st: ok ? (op && op.stable === false ? 'fail' : 'ok') : (R && !_isStub(R) ? 'fail' : 'none') });
        var nd = ST.W && ST.W.ok && ST.W.nodes;
        out.push({ k: 'bhp', l: 'Flowing BHP', v: _u(pwf, 'pressure', 0, 'psia'), s: (nd && _fin(nd.midPerfTvd)) ? '@ ' + (_fin(nd.midPerfMd) ? _u(nd.midPerfMd, 'length', 0, 'ft') + ' MD · ' : '') + _u(nd.midPerfTvd, 'length', 0, 'ft') + ' TVD' : '' });
        out.push({ k: 'thp', l: 'THP', v: _u(thp, 'pressureG', 0, 'psig'), s: ok && R.surface && R.surface.choke && R.surface.choke.regime && R.surface.choke.regime !== 'none' ? 'choke ' + R.surface.choke.regime : (M && M.surface.choke.present === false ? 'fixed' : ''),
                   st: (ok && M && _fin(M.surface.rating.wellhead_psi) && _fin(thp)) ? (thp > M.surface.rating.wellhead_psi ? 'fail' : 'ok') : 'none' });
        var hx = ok ? _hx(R) : null;
        out.push({ k: 'tht', l: 'THT', v: _u(tht, 'temperature', 0, '°F'), s: hx ? (hx.mode === 'enthalpy' ? 'enthalpy · J-T etc. ' + _tdS(hx.dT) : 'relaxation · U ' + _u(hx.U, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F')) : (M && M.well.heat.thtMeasured ? 'measured' : (ok ? 'estimated' : '')),
                   st: (ok && M && _fin(M.surface.rating.tht_max_F) && _fin(tht)) ? (tht > M.surface.rating.tht_max_F ? 'fail' : 'ok') : 'none' });
        out.push({ k: 'dd', l: 'Drawdown', v: (_fin(pr) && _fin(pwf)) ? _u(pr - pwf, 'pressure', 0, 'psi') : '—', s: _fin(pr) ? 'p̄r ' + _u(pr, 'pressure', 0, 'psia') : 'p̄r needed', st: _fin(pr) ? 'none' : 'warn' });
        if (gas) {
            out.push({ k: 'cgr', l: 'CGR', v: M ? _u(M.fluid.cgr, 'cgr', 1, 'STB/MMscf') : '—', s: M ? 'WGR ' + _u(M.fluid.wgr, 'cgr', 1, 'STB/MMscf') : '' });
        } else {
            out.push({ k: 'gor', l: 'GOR', v: M ? _u(M.fluid.gor, 'gor', 0, 'scf/STB') : '—', s: M && M.fluid.api != null ? _fmt(M.fluid.api, 1) + ' °API' : '' });
            out.push({ k: 'wc', l: 'Water cut', v: M && _fin(M.fluid.wc) ? _fmt(M.fluid.wc * 100, 1) + ' %' : '—', s: _fin(rates.qw) ? _u(rates.qw, 'liquidRate', 0, 'BWPD') : '' });
        }
        if (ok && R.lift && R.lift.type === 'gaslift') out.push({ k: 'gl', l: 'Lift gas', v: _u(R.lift.qinj, 'gasRateSmall', 0, 'Mscf/d'), s: _fin(R.lift.injMd) ? '@ ' + _u(R.lift.injMd, 'length', 0, 'ft') + ' MD · ' + _u(R.lift.injTvd, 'length', 0, 'ft') + ' TVD' : '', st: R.lift.atPacker ? 'info' : 'ok', title: 'Gas lift: injection point ' + (R.lift.atPacker ? 'at the packer' : 'at the point of balance') });
        // B (WP26): the pump — stages, frequency, motor load or TDH; ✓ / ! / ✕ from its checks
        if (ok && R.lift && R.lift.type === 'esp') { var el = R.lift, ew = (el.flags || []).some(function (x) { return x.sev === 'fail'; }) ? 'fail' : ((el.flags || []).some(function (x) { return x.sev === 'warn'; }) ? 'warn' : 'ok');
            out.push({ k: 'esp', l: 'ESP', v: _fmt(el.stages, 0) + ' st · ' + _fmt(el.freq, 1) + ' Hz', s: (el.motor && el.motor.ok ? 'motor ' + _fmt(el.motor.load * 100, 0) + ' % · ' : '') + 'TDH ' + _u(el.tdh, 'length', 0, 'ft'), st: ew, title: 'ESP at ' + _mdTvdTxt(el.pumpMd, el.pumpTvd) }); }
        var L = ST.loading, mg = L && _fin(L.margin) ? L.margin : null, lifted = ok && R.lift && (R.lift.type === 'gaslift' || R.lift.type === 'esp');
        // a gas-lifted oil well shows the lift gas in place of the (not applicable) loading margin: the strip keeps ten KPIs
        if (!(lifted && !gas)) out.push({ k: 'load', l: 'Loading margin', v: mg == null ? (gas ? '—' : 'n/a') : (mg >= 0 ? '+' : '') + _fmt(mg * 100, 0) + ' %', s: L && L.method ? String(L.method).replace(/^./, function (c) { return c.toUpperCase(); }) + (_fin(L.qc_MMscfd) ? ' q_c ' + _u(L.qc_MMscfd, 'gasRate', 2, 'MMscf/d') : '') : (gas ? '' : 'oil well'),
                   st: mg == null ? 'none' : (mg < 0 ? 'fail' : mg < 0.1 ? 'warn' : 'ok') });
        var ero = ok ? _eroMax(R) : null, eroWhere = ok && R.velocities && R.velocities.where === 'flowline' ? 'flowline' : 'tubing';
        out.push({ k: 'ero', l: 'Erosion ratio', v: _fin(ero) ? _fmt(ero, 2) : '—', s: M ? 'C = ' + _fmt(M.system.eroC, 0) + (_fin(ero) ? ' · ' + eroWhere : '') : '', st: _fin(ero) ? (ero > 1 ? 'fail' : ero > 0.8 ? 'warn' : 'ok') : 'none' });
        // the smaller of the wellhead margin and the margin downstream of the choke, and where it is
        var mu = _multOf(M);
        if (mu.tuned) out.push({ k: 'tune', l: 'VLP m_h / m_f', v: _fx(mu.hl, 3) + ' / ' + _fx(mu.f, 3), s: CORR_NAME((R && R.corr && R.corr.well) || (M.system.corr && M.system.corr.well) || 'bb'), st: (_tuneBand(mu.hl) === 'warn' || _tuneBand(mu.f) === 'warn') ? 'warn' : 'ok' });
        var hz = _hydMin(R);
        var kb = _kpiB(); if (kb) out.push(kb);
        out.push({ k: 'hyd', l: 'Hydrate margin', v: hz ? _tempDiff(hz.m) : '—', s: hz ? (hz.where === 'dn' ? 'downstream of the choke' : 'at the wellhead') + ' · hydrate ' + _u(hz.tHyd, 'temperature', 0, '°F') : (M && M.fluid.type === 'water' ? 'no gas' : ''), st: hz ? (hz.m < 0 ? 'fail' : hz.m < 10 ? 'warn' : 'ok') : 'none' });
        return out;
    }
    function _hydMin(R) {
        var sf = R && R.ok && R.surface; if (!sf) return null;
        var thc = _fin(sf.thtHyd) ? sf.thtHyd : sf.tht, a = (_fin(thc) && _fin(sf.tHyd)) ? { m: thc - sf.tHyd, where: 'wh', tHyd: sf.tHyd, t: thc } : null;
        var b = (_fin(sf.hydMarginDn) && _fin(sf.tHydDn)) ? { m: sf.hydMarginDn, where: 'dn', tHyd: sf.tHydDn, t: sf.tChokeDn } : null;
        if (a && b) return b.m < a.m ? b : a;
        return a || b;
    }
    function _eroMax(R) {
        if (R && R.velocities && _fin(R.velocities.eroMax)) return R.velocities.eroMax;
        var p = R && R.traverse && R.traverse.profile; if (!p || !p.length) return null;
        var m = null; p.forEach(function (r) { if (_fin(r.ero) && (m == null || r.ero > m)) m = r.ero; });
        return m;
    }
    function _renderKpis() {
        var h = _byId('wp_kpis'); if (!h) return;
        var ks = _kpis();
        if (h.classList) h.classList.toggle('wp-k11', ks.length === 11 || ks.length === 12);     // a sixth column keeps the strip in two full rows
        h.innerHTML = ks.map(function (k) { return _kpiHtml(k.l, k.v, k.s, k.st); }).join('');
    }

    // System plot (IPR / outflow) with the drag handles
    function _curves() {
        var R = ST.R, I = ST.I, out = { ipr: [], vlp: [] };
        if (R && R.curves) {
            out.ipr = (R.curves.ipr || []).map(function (c) { return [c.q, _fin(c.p) ? c.p : c.pwf]; });
            out.vlp = (R.curves.vlp || []).map(function (c) { return [c.q, _fin(c.p) ? c.p : c.pwf]; });
        }
        if (!out.ipr.length && I && I.ok && Array.isArray(I.curve)) out.ipr = I.curve.map(function (c) { return [c.q, c.pwf]; }).sort(function (a, b) { return a[0] - b[0]; });
        if (!out.vlp.length && R && R.ok && ST.M && ST.M.surface.choke.present === false && ST.F && ST.W && ST.W.ok && _fn('WTS_wp_vlp.curve') && I && I.ok && _fin(I.aof)) {
            var qList = []; for (var i = 1; i <= 16; i++) qList.push(I.aof * i / 17);
            var thp = ST.M.system.thp_psig, c = _call('WTS_wp_vlp.curve', ST.F, ST.W, { qList: qList, p0: _fin(thp) ? thp + PATM : null, corr: ST.M.system.corr.well, sections: ST.M.system.corr.sections, coarse: true });
            if (Array.isArray(c)) out.vlp = c.filter(function (x) { return _fin(x.pwf); }).map(function (x) { return [x.q, x.pwf]; });
        }
        return out;
    }
    function _rateCat() { return (ST.M && ST.M.fluid.type === 'waterinj') ? ['liquidRate', 'BWPD'] : (ST.M && _isGasType(ST.M.fluid.type)) ? ['gasRateSmall', 'Mscf/d'] : ['liquidRate', 'STB/d']; }
    function _renderSystemPlot() {
        var cv = _byId('wp_cv_sys'), V = G.WTS_wp_view; if (!cv || !V) return;
        var R = ST.R, M = ST.M, ok = !!(R && R.ok), rc = _rateCat(), T = V.theme();
        var X = function (q) { return _dv(q, rc[0]); }, Y = function (p) { return _dv(p, 'pressure'); };
        var C = _curves(), series = [], markers = [], bands = [], vlines = [];
        var injW = _isInj(M);
        series.push({ key: 'ipr', label: injW ? 'Injectivity (reservoir)' : 'Inflow (IPR)', color: T.green, width: 2.6, pts: C.ipr.map(function (p) { return [X(p[0]), Y(p[1])]; }) });
        series.push({ key: 'vlp', label: injW ? 'Injection outflow' : (M && M.system.node === 'wellhead') ? 'Outflow' : 'Outflow (tubing + surface)', color: T.blue, width: 2.6, pts: C.vlp.map(function (p) { return [X(p[0]), Y(p[1])]; }) });
        var UR = ok && _multOf(M).tuned ? ST.untuned : null;
        if (UR && UR.curve.length > 1) series.push({ key: UR.node === 'bottom' ? 'vlpU' : 'iprU', label: (UR.node === 'bottom' ? 'Outflow' : 'Inflow at the wellhead') + ' — untuned (m = 1)', color: T.text2, width: 1.6, dash: [7, 4], pts: UR.curve.map(function (c) { return [X(c.q), Y(UR.node === 'bottom' ? c.pOut : c.pIn)]; }).filter(function (p) { return _fin(p[1]); }) });
        var sens = ST.sens && ST.sens.ok !== false && Array.isArray(ST.sens.cases) ? ST.sens : null;
        if (sens) sens.cases.forEach(function (c, i) {
            var cur = c.R && (c.R.curve || c.R.vlp);
            // a family from other inputs is drawn faint (thin, dotted) and labelled as such until the sensitivity is re-run
            if (Array.isArray(cur) && cur.length) series.push({ key: 'sens' + i, label: _sensLabel(sens, c), stale: !!sens.stale, color: sens.stale ? T.text2 : V.ramp(sens.cases.length > 1 ? i / (sens.cases.length - 1) : 0.5), width: sens.stale ? 1 : 1.4, dash: sens.stale ? [2, 4] : [6, 4],
                pts: cur.map(function (p) { return [X(p.q), Y(_fin(p.p) ? p.p : p.pwf)]; }).filter(function (p) { return _fin(p[1]); }) });
        });
        if (ok) {
            if (R.qs && _fin(R.qs.q)) { bands.push({ x0: 0, x1: X(R.qs.q), color: 'rgba(248,81,73,0.09)', label: 'statically unstable (q < q_s)' }); vlines.push({ x: X(R.qs.q), color: T.red, label: 'q_s' }); }
            if (R.vlpMin && _fin(R.vlpMin.q)) vlines.push({ x: X(R.vlpMin.q), color: T.text2, label: 'tubing-curve min.', dash: [2, 4] });
            var L = ST.loading; if (L && _fin(L.qc_MMscfd)) vlines.push({ x: X(L.qc_MMscfd * 1000), color: T.yellow, label: 'loading q_c' });
            if (R.velocities && _fin(R.velocities.qEro)) vlines.push({ x: X(R.velocities.qEro), color: T.purple, label: 'erosional rate' });
            if (UR && UR.op) markers.push({ x: X(UR.op.q), y: Y(UR.op.p), kind: 'hollow', color: T.text2, r: 5, label: '', untuned: true });
            (R.roots || []).forEach(function (r) {
                var isOp = R.op && Math.abs(r.q - R.op.q) < 1e-6 * Math.max(1, r.q);
                markers.push({ x: X(r.q), y: Y(r.p), kind: r.stable ? 'filled' : 'hollow', color: r.stable ? T.accent : T.red, r: isOp ? 7 : 5.5, halo: isOp,
                               label: isOp ? _fmt(X(r.q), 0) + ' ' + _lab(rc[0], rc[1]) + ' · ' + _fmt(Y(r.p), 0) + ' ' + _lab('pressure', 'psia') : (r.stable ? '' : 'unstable') });
            });
        }
        _corrOpMarkers(markers, X, Y, T);                      // WP12: the operating point of each correlation (after its Job)
        // B (WP24): an injector shows the fracture pressure, the rate there and the limit band above it
        var hlinesB = [];
        if (injW && ok && R.inj) {
            if (_fin(R.inj.pFrac)) hlinesB.push({ y: Y(R.inj.pFrac), color: T.red, label: 'fracture pressure' + (R.inj.pFracProvisional ? ' (DFIT, provisional)' : ''), dash: [6, 4] });
            if (_fin(R.inj.qFrac)) vlines.push({ x: X(R.inj.qFrac), color: T.red, label: 'q at p_frac', dash: [2, 4] });
        }
        _ext('sysPlot', { series: series, markers: markers, vlines: vlines, bands: bands, X: X, Y: Y, T: T });
        // drag handles
        var handles = [];
        if (M) {
            var gas = _isGasType(M.fluid.type), pr = M.res.pr;
            if (_fin(pr)) handles.push({ key: 'pr', kind: 'point', x: 0, value: Y(pr), min: Y(200), max: Y(20000), step: _metric() ? 10 : 5, label: 'p̄r', color: T.green, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } });
            if (M.surface.choke.present === false || injW) {
                var thp = _fin(M.system.thp_psig) ? M.system.thp_psig : 100;
                handles.push({ key: 'thp', kind: 'railY', value: Y(thp + PATM), min: Y(PATM), max: Y(15000), step: _metric() ? 10 : 5, label: 'THP', railLabel: 'THP', color: T.blue, fmt: function (v) { return _fmt(_dv(_fromDisp(v, 'pressure') - PATM, 'pressureG'), 0) + ' ' + _lab('pressureG', 'psig'); } });
            } else {
                handles.push({ key: 'bean', kind: 'railX', value: _fin(M.surface.choke.bean64) ? M.surface.choke.bean64 : 32, min: 8, max: 128, step: 1, label: 'Bean', railLabel: 'BEAN', rail: [0, 0.5], color: T.accent, fmt: function (v) { return _fmt(v, 0) + '/64"'; } });
            }
            if (!gas && !injW) handles.push({ key: 'wc', kind: 'railX', value: _fin(M.fluid.wc) ? M.fluid.wc * 100 : 0, min: 0, max: 98, step: 1, label: 'WC', railLabel: 'WC', rail: [0.5, 1], color: T.purple, fmt: function (v) { return _fmt(v, 0) + ' %'; } });
        }
        var emptyMsg = (!M) ? 'The model module is not available.' : (ST.stubs && ST.stubs.length && !ok) ? 'The inflow / outflow curves appear here once the engines are installed.' : (!_fin(M.res.pr) ? 'Enter the reservoir pressure (step ②) to draw the inflow curve.' : 'No curve for these inputs.');
        V.chart(cv, {
            key: 'sys:' + rc[0] + ':' + (_metric() ? 'm' : 'i'), aspect: 0.8, minH: 280, maxH: 560, w: 640,
            x: { label: (injW ? 'Injection rate' : _isGasType(M && M.fluid.type) ? 'Gas rate' : 'Liquid rate') + ' (' + _lab(rc[0], rc[1]) + ')', min: 0, short: 'q', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab(rc[0], rc[1]); } },
            y: { label: (M && M.system.node === 'wellhead' ? 'Pressure at the node' : 'Bottom-hole pressure') + ' (' + _lab('pressure', 'psia') + ')', min: 0, max: (M && _fin(M.res.pr)) ? Y(Math.max(M.res.pr, ok ? R.op.p : 0, injW && ok && R.inj && _fin(R.inj.pFrac) ? R.inj.pFrac : 0) * (injW ? 1.15 : 1.3)) : undefined, short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
            series: series, markers: markers, bands: bands, vlines: vlines, hlines: hlinesB, handles: handles, readout: 'x', empty: emptyMsg,
            legendNote: sens && sens.stale ? STALE_NOTE : null,
            hidden: _plots().sysHidden || null,
            onLegend: function (hid) { _plotsSet({ sysHidden: hid }); },
            onHandle: _onHandle
        });
    }
    // ── v4.5 WP21: per-section correlations on the page ──
    function _secRows(M) { return ((M && M.system.corr && M.system.corr.sections) || []).map(function (r) { return Object.assign({}, r); }); }
    function _secRuns() { var R = ST.R; return (R && R.ok && R.traverse && R.traverse.sections) || null; }
    function _secSummary(runs) {
        if (!runs || !runs.length) return '';
        return runs.map(function (x) { return _corrShort(x.corr) + ' ' + _fmt(_dv(x.mdTop, 'length'), 0) + '–' + _fmt(_dv(x.mdBot, 'length'), 0); }).join(' · ') + ' ' + _lab('length', 'ft') + ' MD';
    }
    // the "Covers" cell of section row i: the MD · TVD intervals and inclinations its correlation got on the solved path
    function _secCover(i) {
        var runs = _secRuns(); if (!runs) return '—';
        var mine = runs.filter(function (x) { return x.row === i; });
        if (!mine.length) return ST.R && ST.R.ok ? '<span title="this row covers no part of the flow path, or an earlier row covers it">none</span>' : '—';
        return mine.map(function (x) { return _esc(_fmt(_dv(x.mdTop, 'length'), 0) + '–' + _fmt(_dv(x.mdBot, 'length'), 0) + ' MD · ' + _fmt(_dv(x.tvdTop, 'length'), 0) + '–' + _fmt(_dv(x.tvdBot, 'length'), 0) + ' TVD ' + _lab('length', 'ft') + ', ' + _fmt(x.incMin, 0) + (Math.abs(x.incMax - x.incMin) >= 0.5 ? '–' + _fmt(x.incMax, 0) : '') + '°'); }).join('<br>');
    }
    function _refreshSecCover() {
        var tbl = _byId('wp_tbl_corrSections'); if (tbl && tbl.querySelectorAll) Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr, i) { var c = tr.querySelector('td.wp-seccov'); if (c) c.innerHTML = _secCover(i); });
        var bar = _byId('wp_secbar'); if (!bar) return;
        var runs = _secRuns(), R = ST.R;
        var all = runs || (R && R.ok && R.traverse && R.traverse.profile.length ? [{ corr: _selCorr(), mdTop: R.traverse.profile[0].md, mdBot: R.traverse.profile[R.traverse.profile.length - 1].md, verified: true }] : []);
        var span = all.length ? (all[all.length - 1].mdBot - all[0].mdTop) || 1 : 1, seen = {};
        bar.innerHTML = all.length ? '<div class="wp-secbar" role="img" aria-label="' + _esc('Correlations along the flow path: ' + (runs ? _secSummary(runs) : _corrShortL(all[0].corr) + ' throughout')) + '">' +
            all.map(function (x) { return '<i style="flex-grow:' + Math.max(0.001, (x.mdBot - x.mdTop) / span).toFixed(4) + ';background:' + _corrCol(x.corr) + '" title="' + _esc(_corrShortL(x.corr) + ': ' + _fmt(_dv(x.mdTop, 'length'), 0) + '–' + _fmt(_dv(x.mdBot, 'length'), 0) + ' ' + _lab('length', 'ft') + ' MD' + (_fin(x.tvdTop) ? ' · ' + _fmt(_dv(x.tvdTop, 'length'), 0) + '–' + _fmt(_dv(x.tvdBot, 'length'), 0) + ' TVD' : '')) + '"></i>'; }).join('') + '</div>' +
            '<div class="wp-seclg">' + all.filter(function (x) { if (seen[x.corr]) return false; seen[x.corr] = 1; return true; }).map(function (x) { var e = (G.WTS_flowline_corr || {})[x.corr]; return '<span><i class="wp-cdot" style="background:' + _corrCol(x.corr) + '"></i><b>' + _esc(_corrShortL(x.corr)) + '</b>' + (e && e.verified !== true ? ' <span class="wp-chip prov">prov.</span>' : '') + '</span>'; }).join('') +
            '<span>wellhead → bottom along MD' + (runs ? '' : ' (one correlation)') + '</span></div>' : '';
    }
    function _secPreset(v) {
        var rows = v === 'dev' ? [{ by: 'inc', from: 30, to: 180, corr: 'mb' }] : v === 'mech' ? [{ by: 'inc', from: 0, to: 30, corr: 'ansari' }, { by: 'inc', from: 30, to: 180, corr: 'hk' }] : [];
        _writeTable('corrSections', rows); _renderTable('corrSections');
    }
    // dragging a section boundary (MD interval rows) on the traverse plot: live tracking solves, the release writes the table
    function _secHandle(key, v, phase) {
        var m = /^sec(\d+)([ft])$/.exec(key); if (!m) return;
        var i = +m[1], fld = m[2] === 'f' ? 'from' : 'to', rows = ST.secLive ? ST.secLive.map(function (r) { return Object.assign({}, r); }) : _secRows(ST.M);
        if (!rows[i]) return;
        var dft = _fromDisp(v, 'length'), mdv = _plots().depth === 'md' ? dft : _mdFromTvd(dft), md = Math.max(0, Math.round((_fin(mdv) ? mdv : dft) / 10) * 10);
        if (fld === 'from' && _fin(rows[i].to)) md = Math.min(md, rows[i].to - 10);
        if (fld === 'to' && _fin(rows[i].from)) md = Math.max(md, rows[i].from + 10);
        rows[i][fld] = md;
        if (phase === 'end') { ST.secLive = null; _writeTable('corrSections', rows); _renderTable('corrSections'); return; }
        ST.secLive = rows;
        if (!ST.slow && _liveMs() <= LIVE_MS) _solveLive();
    }
    function _onHandle(key, v, phase) {
        if (_ext('handle', key, v, phase).some(Boolean)) return;          // B (WP25): handles of an extension's plots (gas-lift valves)
        if (/^sec\d+[ft]$/.test(key)) { _secHandle(key, v, phase); return; }
        var id = { pr: 'wp_pr', thp: 'wp_thp', bean: 'wp_bean', wc: 'wp_wc', hU: 'wp_Uto', hT: 'wp_tprod', qinj: 'wp_gl_qinj', packer: 'wp_gl_packer', tFlow: 'wp_ip_tFlow', L: 'wp_ip_L', xf: 'wp_ip_xf', thpI: 'wp_thp' }[key]; if (!id) return;
        var canon;
        if (key === 'hU' || key === 'hT') canon = +Math.pow(10, v).toPrecision(3);   // the heat rails are on log10 scales
        else if (key === 'pr') canon = Math.round(_fromDisp(v, 'pressure'));
        else if (key === 'qinj') canon = Math.max(0, Math.round(_fromDisp(v, 'gasRateSmall') / 5) * 5);
        else if (key === 'packer') { var dft = _fromDisp(v, 'length'), mdv = _plots().depth === 'md' ? dft : _mdFromTvd(dft); canon = Math.round(_fin(mdv) ? mdv : dft); }
        else if (key === 'thp') canon = Math.round(_fromDisp(v, 'pressure') - PATM);
        else if (key === 'thpI') canon = Math.max(0, Math.round(_fromDisp(v, 'pressureG')));
        else if (key === 'tFlow') canon = +v.toPrecision(3);
        else if (key === 'L' || key === 'xf') canon = Math.max(1, Math.round(_fromDisp(v, 'length')));
        else canon = Math.round(v);
        _setCtrl(id, canon, true);
        ST.heatDrag = (key === 'hU' || key === 'hT') && phase !== 'end';
        if (phase === 'end') { _commit(id); return; }
        if (!ST.slow && _liveMs() <= LIVE_MS) _solveLive();
    }

    // Schematic
    function _depthFmt(v) { return _fmt(_dv(v, 'length'), 0); }
    // every depth readout gives MD and TVD with the length unit (TVD from the trajectory when the caller has none)
    function _mdTvdTxt(md, tvd) { var t = _fin(tvd) ? tvd : _tvdAt(md); return _u(md, 'length', 0, 'ft') + ' MD' + (_fin(t) ? ' · ' + _u(t, 'length', 0, 'ft') + ' TVD' : ''); }
    // B (WP28) schematic inputs, read defensively from what the B engines supply (contract in the plan record §18.3.1):
    //   R.lift.marks [{md, kind:'esp'|'mandrel'|'gl'|'packer', label, state}] (any lift engine), else R.lift.valves [{md, state, label}]
    //   (gas-lift design) and R.lift.pumpMd / M.lift.esp.pumpMd (ESP); M.res.layers [{topMd, botMd | topTvd, botTvd, label | name}];
    //   R.corr.sections / M.system.corr.sections [{fromMd, toMd, key}] (the correlation per section)
    // the solve's injection point: the point of balance (the system solve does not yet inject at the installed valves, plan §18.3.9) —
    // said so on the schematic when valves are installed, with a warning when it lies below the deepest one (review fix v4.5)
    function _glMarkLabel() {
        var L = ST.R.lift, vs = (ST.M && ST.M.lift && ST.M.lift.gl && Array.isArray(ST.M.lift.gl.valves)) ? ST.M.lift.gl.valves.filter(function (v) { return v && _fin(+v.md); }) : [];
        if (!vs.length) return 'gas lift ' + _mdTvdTxt(L.injMd, L.injTvd);
        var deep = Math.max.apply(null, vs.map(function (v) { return +v.md; }));
        return 'point of balance ' + _mdTvdTxt(L.injMd, L.injTvd) + (L.injMd > deep + 1 ? ' — below the deepest valve' : '');
    }
    function _schLiftMarks() {
        var R = ST.R, M = ST.M, out = [], L = R && R.ok && R.lift ? R.lift : null;
        if (L && Array.isArray(L.marks)) return L.marks.filter(function (m) { return m && _fin(m.md); }).map(function (m) { return Object.assign({}, m, { label: m.label || (m.kind === 'esp' ? 'ESP ' + (_fin(m.stages) ? _fmt(m.stages, 0) + ' st · ' + _fmt(m.hz, 1) + ' Hz · ' : '') : 'valve ') + _mdTvdTxt(m.md) }); });
        if (L && Array.isArray(L.valves)) L.valves.forEach(function (v, i) { if (v && _fin(v.md)) out.push({ md: v.md, kind: 'mandrel', state: v.state || (v.operating ? 'operating' : 'closed'), label: v.label || ('valve ' + (i + 1) + (v.operating || v.state === 'operating' ? ' · operating' : '')) }); });
        var esp = M && M.lift && M.lift.type === 'esp' ? (M.lift.esp || {}) : null, pmd = L && _fin(L.pumpMd) ? L.pumpMd : (esp && _fin(+esp.pumpMd) ? +esp.pumpMd : null);
        if (esp && _fin(pmd)) out.push({ md: pmd, kind: 'esp', label: 'ESP ' + _mdTvdTxt(pmd, L && L.pumpTvd), comp: 'esp' });
        return out;
    }
    function _schLayers() {
        var M = ST.M, ls = M && M.res && Array.isArray(M.res.layers) ? M.res.layers : [];
        return ls.map(function (l, i) {
            if (!l) return null;
            var t = _fin(+l.topMd) ? +l.topMd : (_fin(+l.topTvd) ? _mdFromTvd(+l.topTvd) : null), b = _fin(+l.botMd) ? +l.botMd : (_fin(+l.botTvd) ? _mdFromTvd(+l.botTvd) : null);
            return (_fin(t) && _fin(b) && b > t) ? { topMd: t, botMd: b, label: String(l.label || l.name || ('Layer ' + (i + 1))).slice(0, 24) } : null;
        }).filter(Boolean);
    }
    function _schSections(prop) {
        // the per-section correlation runs of the solved traverse (WP21: {corr, mdTop, mdBot}); drawn as the rail with Colour by → Correlation
        // (otherwise the WP21 band beside the path shows them)
        var runs = _secRuns(), src = runs ? runs.map(function (x) { return { fromMd: x.mdTop, toMd: x.mdBot, key: x.corr }; }) : null;
        if (prop !== 'correlation') { ST.schSections = []; return []; }
        var lab = function (k) { var e = (G.WTS_flowline_corr || {})[k]; return { label: e ? String(e.label || k).replace(/\s*\(.*$/, '') : String(k || ''), provisional: !(e && e.verified === true) }; };
        var secs = (src || []).filter(function (x) { return x && _fin(+x.fromMd) && _fin(+x.toMd) && +x.toMd > +x.fromMd; }).map(function (x) { var l = lab(x.key || x.corr); return { fromMd: +x.fromMd, toMd: +x.toMd, key: x.key || x.corr, label: l.label, provisional: l.provisional }; });
        if (!secs.length && prop === 'correlation') {      // one section: the well correlation from the wellhead to the mid-perforation
            var nd = ST.W && ST.W.ok && ST.W.nodes, k = _selCorr(), l2 = lab(k);
            if (nd && _fin(nd.midPerfMd)) secs = [{ fromMd: 0, toMd: nd.midPerfMd, key: k, label: l2.label, provisional: l2.provisional }];
        }
        ST.schSections = secs;
        return secs;
    }
    function _renderSchematic() {
        var host = _byId('wp_sch'), V = G.WTS_wp_view; if (!host || !V) return;
        var S = ST.SC && ST.SC.ok !== false && !_isStub(ST.SC) ? ST.SC : null, prop = _plots().prop || 'pressure';
        var sel = _byId('wpv_prop'); if (sel && sel.value !== prop) sel.value = prop;
        var w = (host.clientWidth > 260 && host.clientWidth < 900) ? host.clientWidth : 460, narrow = w < 520;
        var closure = '';
        if (S && S.trajectory && S.trajectory.length) {
            var l = S.trajectory[S.trajectory.length - 1];
            closure = 'TD ' + _u(l.md, 'length', 0, 'ft') + ' MD · ' + _u(l.tvd, 'length', 0, 'ft') + ' TVD · departure ' + _u(_fin(l.dep) ? l.dep : 0, 'length', 0, 'ft');
        }
        var o = {
            prop: prop, width: w, height: narrow ? Math.round(w * 1.2) + Math.round(Math.min(w * 0.5, 230)) : Math.round(Math.max(470, w * 1.18)),
            fmt: { depthTick: _depthFmt, md: function (v) { return _u(v, 'length', 0, 'ft'); }, p: function (v) { return _fmt(_dv(v, 'pressure'), 0); }, t: function (v) { return _fmt(_dv(v, 'temperature'), 0); }, dte: function (v) { return _tempDiff(v); }, djt: function (v) { return _tdS(v); }, U: function (v) { return _fmt(_dv(v, 'heatTransferCoef'), 2); }, hl: function (v) { return _fmt(v, 2); }, vm: function (v) { return _fmt(_dv(v, 'velocity'), 1); } },
            labels: { tvd: 'TVD (' + _lab('length', 'ft') + ')', vs: 'Vertical section (' + _lab('length', 'ft') + '), equal scale', closure: '', earth: 'halo: earth (geotherm)', prop: { pressure: 'Pressure (' + _lab('pressure', 'psia') + ')', temperature: 'Temperature (' + _lab('temperature', '°F') + ')', heatloss: 'Fluid − earth (' + _lab('tempDiff', '°F') + ')', jt: 'Enthalpy − relaxation (' + _lab('tempDiff', '°F') + ')', holdup: 'Liquid holdup (–)', velocity: 'Mixture velocity (' + _lab('velocity', 'ft/s') + ')', pattern: 'Flow pattern', none: '' }[prop] },
            empty: (ST.stubs && ST.stubs.indexOf('WTS_wp_well.build') !== -1) || _isStub(ST.SC) ? 'The well path engine draws the deviated well here once it is installed.' : 'Enter a survey and the strings (step ③) to draw the well.',
            bands: prop === 'correlation' ? [] : (_secRuns() || []).map(function (x) { return { mdTop: x.mdTop, mdBot: x.mdBot, color: _corrCol(x.corr), label: _corrShort(x.corr), title: _corrShortL(x.corr) + ' ' + _mdTvdTxt(x.mdTop, x.tvdTop) + ' to ' + _mdTvdTxt(x.mdBot, x.tvdBot) }; }),
            marks: ((ST.R && ST.R.ok && ST.R.lift && _fin(ST.R.lift.injMd)) ? [{ md: ST.R.lift.injMd, kind: 'gl', comp: 'gl', label: _glMarkLabel(), color: '#58a6ff' }].concat(_fin(ST.R.lift.packerMd) ? [{ md: ST.R.lift.packerMd, kind: 'packer', label: 'packer' }] : []) : []).concat(_schLiftMarks()),
            layers: _schLayers(), sections: _schSections(prop),
            aria: 'Well schematic: vertical section and plan view, coloured by ' + prop
        };
        var ob = _schB(); Object.keys(ob).forEach(function (k) { o[k] = ob[k]; });
        _ext('marks').forEach(function (ms) { if (Array.isArray(ms)) o.marks = o.marks.concat(ms); });
        var out = V.schematic(S || {}, o);
        ST.schPts = out.pts; ST.schW = out.width; ST.schH = out.height;
        // deviation in the caption (B, WP28): maximum inclination, kick-off point and the horizontal length
        var dv = out.dev;
        if (dv && dv.incMax >= 5) {
            closure += ' · max inclination ' + _fmt(dv.incMax, 1) + '°' + (_fin(dv.incMaxMd) ? ' at ' + _mdTvdTxt(dv.incMaxMd) : '') + (_fin(dv.kopMd) ? ' · KOP ' + _mdTvdTxt(dv.kopMd, dv.kopTvd) : '');
            if (dv.hz && dv.hz.length) closure += ' · horizontal ' + _u(dv.hz.reduce(function (a, h) { return a + h.md1 - h.md0; }, 0), 'length', 0, 'ft') + ' MD';
        }
        host.innerHTML = out.svg;
        var mt = _multOf(ST.M), tr0 = ST.tune && ST.tune.ok ? ST.tune : null;
        if (mt.tuned) closure += (closure ? ' · ' : '') + 'VLP tuned: m_h ' + _fx(mt.hl, 3) + ', m_f ' + _fx(mt.f, 3) + (tr0 && Math.abs(tr0.mult.hl - mt.hl) < 1e-5 && Math.abs(tr0.mult.f - mt.f) < 1e-5 ? ' (RMS ' + _fx(_dv(tr0.rms.tuned, 'pressure'), 1) + ' ' + _lab('pressure', 'psi') + ' at the gauge' + (tr0.residuals.length === 1 && _fin(tr0.residuals[0].gauge.tvd) ? ', ' + _u(tr0.residuals[0].gauge.md, 'length', 0, 'ft') + ' MD · ' + _u(tr0.residuals[0].gauge.tvd, 'length', 0, 'ft') + ' TVD' : '') + ')' : '');
        var sr0 = _secRuns(); if (sr0) closure += (closure ? ' · ' : '') + 'correlations by section: ' + _secSummary(sr0);
        var cap = _byId('wp_sch_cap'); if (cap) cap.textContent = closure;
    }
    function _schAt(md) {
        var S = ST.SC, res = { md: md };
        if (!S || !S.trajectory) return res;
        var tr = S.trajectory;
        for (var i = 1; i < tr.length; i++) if (md <= tr[i].md) { var a = tr[i - 1], b = tr[i], t = (md - a.md) / ((b.md - a.md) || 1); res.tvd = a.tvd + t * (b.tvd - a.tvd); res.inc = _fin(b.inc) ? (_fin(a.inc) ? a.inc + t * (b.inc - a.inc) : b.inc) : null; break; }
        var pr = (S.profile || []).slice().sort(function (x, y) { return x.md - y.md; });
        for (var j = 1; j < pr.length; j++) if (md <= pr[j].md) { var c = pr[j - 1], d = pr[j], f = (md - c.md) / ((d.md - c.md) || 1); ['p', 't', 'te', 'hl', 'vm'].forEach(function (k) { if (_fin(c[k]) && _fin(d[k])) res[k] = c[k] + f * (d[k] - c[k]); }); res.pattern = f < 0.5 ? c.pattern : d.pattern; break; }
        return res;
    }
    // a depth-axis readout (display units, MD or TVD) printed with the other depth too, from the trajectory
    function _mdFromTvd(tvd) {
        var tr = ST.SC && ST.SC.trajectory; if (!tr || tr.length < 2) return null;
        for (var i = 1; i < tr.length; i++) { var a = tr[i - 1], b = tr[i]; if ((tvd - a.tvd) * (tvd - b.tvd) <= 0 && b.tvd !== a.tvd) return a.md + (tvd - a.tvd) / (b.tvd - a.tvd) * (b.md - a.md); }
        return null;
    }
    function _depthPair(vDisp, dax) {
        var v = _fromDisp(vDisp, 'length'), dl = _lab('length', 'ft');
        var md = dax === 'md' ? v : _mdFromTvd(v), tvd = dax === 'md' ? _schAt(v).tvd : v;
        var f = function (x) { return _fin(x) ? _fmt(_dv(x, 'length'), 0) + ' ' + dl : '—'; };
        return dax === 'md' ? f(md) + ' MD · ' + f(tvd) + ' TVD' : f(tvd) + ' TVD · ' + f(md) + ' MD';
    }
    function _schHover(e) {
        var host = _byId('wp_sch'), tip = _byId('wp_tip'); if (!host || !tip || !ST.schPts || !ST.schPts.length) return;
        var svg = host.querySelector('svg'); if (!svg || !svg.getBoundingClientRect) return;
        var r = svg.getBoundingClientRect(); if (!(r.width > 0)) return;
        var vx = (e.clientX - r.left) * ST.schW / r.width, vy = (e.clientY - r.top) * ST.schH / r.height, best = null, bd = 1e9;
        ST.schPts.forEach(function (p) { var d = Math.hypot(p.x - vx, p.y - vy); if (d < bd) { bd = d; best = p; } });
        var mk = host.querySelector('.wp-hover');
        if (!best || bd > 28) { tip.className = 'wp-tip'; if (mk) mk.style.display = 'none'; return; }
        if (mk) { mk.style.display = ''; mk.setAttribute('transform', 'translate(' + best.x.toFixed(1) + ' ' + best.y.toFixed(1) + ')'); }
        var a = _schAt(best.md), rows = ['<b>' + _u(best.md, 'length', 0, 'ft') + ' MD</b>'];
        if (_fin(a.tvd)) rows.push('<span class="k">TVD</span> ' + _u(a.tvd, 'length', 0, 'ft'));
        if (_fin(a.inc)) rows.push('<span class="k">Inclination</span> ' + _fmt(a.inc, 1) + '°');
        if (_fin(a.p)) rows.push('<span class="k">Pressure</span> ' + _u(a.p, 'pressure', 0, 'psia'));
        if (_fin(a.t)) rows.push('<span class="k">Temperature</span> ' + _u(a.t, 'temperature', 1, '°F'));
        if (_fin(a.te)) rows.push('<span class="k">Earth</span> ' + _u(a.te, 'temperature', 1, '°F') + (_fin(a.t) ? ' (fluid ' + (a.t >= a.te ? '+' : '−') + _tempDiff(Math.abs(a.t - a.te)) + ')' : ''));
        if (_fin(a.hl)) rows.push('<span class="k">Holdup</span> ' + _fmt(a.hl, 3));
        if (_fin(a.vm)) rows.push('<span class="k">Velocity</span> ' + _u(a.vm, 'velocity', 1, 'ft/s'));
        if (a.pattern) rows.push('<span class="k">Pattern</span> ' + _esc(a.pattern));
        var sc0 = (ST.schSections || []).filter(function (x) { return best.md >= x.fromMd && best.md <= x.toMd; })[0];
        if (sc0 && (ST.schSections.length > 1 || (_plots().prop === 'correlation'))) rows.push('<span class="k">Correlation</span> ' + _esc(sc0.label + (sc0.provisional ? ' (provisional)' : '')));
        var ly0 = _schLayers().filter(function (x) { return best.md >= x.topMd && best.md <= x.botMd; })[0];
        if (ly0) rows.push('<span class="k">Layer</span> ' + _esc(ly0.label));
        tip.innerHTML = rows.join('<br>');
        var wr = host.getBoundingClientRect(), lx = e.clientX - wr.left + 16, ly = e.clientY - wr.top + 12;
        if (lx > wr.width - 170) lx = e.clientX - wr.left - 176;
        tip.style.left = Math.max(4, lx) + 'px'; tip.style.top = Math.max(4, ly) + 'px';
        tip.className = 'wp-tip on';
    }
    function _editComp(comp) {
        var m = /^(string|restr|gauge):(\d+)$/.exec(comp || ''), step = 3, focusSel = null;
        if (m) {
            var t = { string: 'strings', restr: 'restrictions', gauge: 'tests' }[m[1]], r = +m[2];
            if (m[1] === 'gauge') {      // the schematic lists the gauges by depth: find the test row that carries that gauge MD
                var gg = ST.SC && ST.SC.gauges && ST.SC.gauges[r], ts = (ST.M && ST.M.tests) || [];
                if (gg && _fin(gg.md)) for (var k = 0; k < ts.length; k++) if (_fin(+ts[k].gaugeMd) && Math.abs(+ts[k].gaugeMd - gg.md) < 0.5) { r = k; break; }
            }
            step = m[1] === 'gauge' ? 6 : 3; focusSel = { t: t, r: r };
        }
        else if (/^layer:\d+$/.test(comp || '')) { step = 3; focusSel = { t: 'hlayers', r: +comp.split(':')[1] }; }
        else if (comp === 'perf') { step = 3; focusSel = { id: 'wp_perfTop' }; }
        else if (comp === 'choke') { step = 5; focusSel = { id: 'wp_bean' }; }
        else if (comp === 'wellhead') { step = 5; focusSel = { id: 'wp_psep' }; }
        else if (comp === 'gl') { step = 4; focusSel = { id: 'wp_gl_qinj' }; }
        else if (/^(esp|mandrel)(:\d+)?$/.test(comp || '')) { step = 4; _goStep(step, true); _ext('comp', comp); return; }   // B (WP25): the extension focuses the valve row
        _goStep(step, true);
        if (focusSel && focusSel.id) { var e = _byId(focusSel.id); if (e && e.focus) e.focus(); }
        else if (focusSel) {
            var tbl = _byId('wp_tbl_' + focusSel.t), tr = tbl && tbl.querySelector('tr[data-r="' + focusSel.r + '"]');
            if (tr) { if (tr.classList) { tr.classList.remove('wp-flash'); tr.classList.add('wp-flash'); } var inp = tr.querySelector('input,select'); if (inp && inp.focus) inp.focus(); if (tr.scrollIntoView) { try { tr.scrollIntoView({ block: 'center', behavior: _reduced() ? 'auto' : 'smooth' }); } catch (x) { /* ignore */ } } }
        }
    }
    function _phone() { try { return !!(G.matchMedia && G.matchMedia('(max-width: 600px)').matches); } catch (e) { return false; } }
    function _reduced() { try { return !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

    // Operating point card
    function _renderOp() {
        var h = _byId('wp_op'); if (!h) return;
        var R = ST.R, M = ST.M, ok = !!(R && R.ok), rows = [];
        var row = function (l, v) { rows.push('<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv">' + _esc(v) + '</span></div>'); };
        if (!ok) { h.innerHTML = '<div class="rbox-title">Operating point</div><div class="wp-v info">' + _esc(R && !_isStub(R) ? (((R.errors || [])[0]) || 'No operating point.') : 'Waiting for the system solver.') + '</div>'; return; }
        var rt = R.rates || {}, sf = R.surface || {}, gas = _isGasType(M.fluid.type);
        if (R.injector) { _opInj(row); h.innerHTML = '<div class="rbox-title">Operating point (injection)</div>' + rows.join(''); return; }
        if (gas) row('Gas rate', _u(rt.qg / 1000, 'gasRate', 3, 'MMscf/d'));
        row(gas ? 'Condensate rate' : 'Oil rate', _u(rt.qo, 'liquidRate', 0, 'STB/d'));
        row('Water rate', _u(rt.qw, 'liquidRate', 0, 'BWPD'));
        if (!gas) row('Gas rate', _u(rt.qg, 'gasRateSmall', 0, 'Mscf/d'));
        row('Flowing bottom-hole pressure', _u(_fin(R.pwf) ? R.pwf : R.op.p, 'pressure', 0, 'psia'));
        row('Wellhead pressure (THP)', _u(_fin(sf.thp_psig) ? sf.thp_psig : (_fin(sf.thp) ? sf.thp - PATM : null), 'pressureG', 0, 'psig'));
        row('Wellhead temperature (THT)', _u(sf.tht, 'temperature', 0, '°F'));
        row('Stability', R.op.stable ? 'stable' : 'unstable');
        // q_s and the tubing-curve minimum in the same category and scale as the rate above (MMscf/d for gas wells)
        var qf = function (q) { return gas ? _u(q / 1000, 'gasRate', 3, 'MMscf/d') : _u(q, 'liquidRate', 0, 'STB/d'); };
        row('Static stability limit q_s', R.qs ? qf(R.qs.q) : 'none in range');
        if (R.vlpMin) row('Tubing-curve minimum', qf(R.vlpMin.q));
        if (sf.choke && sf.choke.regime && sf.choke.regime !== 'none') row('Choke regime', sf.choke.regime + (sf.choke.model === 'sachdeva-scaled' && sf.choke.regime === 'subcritical' ? ' (Sachdeva branch, provisional)' : sf.choke.model === 'sachdeva' ? ' (Sachdeva, provisional)' : ''));
        if (sf.choke && _fin(sf.choke.ratio)) row('Choke pressure ratio p2/p1', _fmt(sf.choke.ratio, 2) + (_fin(sf.choke.yc) ? ' (critical ratio ' + _fmt(sf.choke.yc, 3) + ')' : ''));
        if (sf.choke && _fin(sf.choke.rateFactor) && sf.choke.model) row('Choke rate factor', _fmt(sf.choke.rateFactor, 3));
        if (R.lift && R.lift.type === 'gaslift') {
            row('Lift gas', _u(R.lift.qinj, 'gasRateSmall', 0, 'Mscf/d') + ' at ' + _u(R.lift.pinj_psig, 'pressureG', 0, 'psig'));
            row('Injection point', _u(R.lift.injMd, 'length', 0, 'ft') + ' MD · ' + _u(R.lift.injTvd, 'length', 0, 'ft') + ' TVD' + (R.lift.atPacker ? ' (packer)' : ''));
        }
        _opRowsB(row);
        h.innerHTML = '<div class="rbox-title">Operating point</div>' + rows.join('');
    }

    // ── ① Fluid properties card (A2, WP13) ─────────────────────────────────────
    // the family selector sets Pb, Rs and Bo together; Rs alone moves the family selector (the bubble point follows Rs)
    function _hasOpt(id, v) { var e = _byId(id); return !!(e && e.options && Array.prototype.some.call(e.options, function (o) { return o.value === v; })); }
    function _famSync(id) {
        var v = (_byId(id) || {}).value; if (!v) return;
        if (id === 'wp_corr_pb') { ['wp_corr_rs', 'wp_corr_bo'].forEach(function (k) { if (_hasOpt(k, v)) _setCtrl(k, v); }); }
        else if (id === 'wp_corr_rs' && _hasOpt('wp_corr_pb', v)) _setCtrl('wp_corr_pb', v);
    }
    var PVT_PROPS = {
        oil: [['rs', 'Rs'], ['bo', 'Bo'], ['muo', 'μo'], ['z', 'Z'], ['mug', 'μg'], ['rho', 'Density']],
        gas: [['z', 'Z'], ['mug', 'μg'], ['bg', 'Bg'], ['rho', 'Density']],
        water: [['bw', 'Bw'], ['muw', 'μw'], ['rho', 'Density']]
    };
    var FAM_COL = { standing: 'blue', vasquezBeggs: 'green', glaso: 'purple', petrosky: 'yellow', beggsRobinson: 'blue', egbogah: 'green', bergmanSutton: 'purple',
        dranchukAbouKassem: 'blue', hallYarborough: 'purple' };
    function _pvtKind(t) { return t === 'oil' ? 'oil' : (t === 'water' || t === 'waterinj') ? 'water' : 'gas'; }
    function _pvtVal(prop, r) {
        if (!r) return null;
        switch (prop) {
            case 'rs': return _dv(r.rs, 'gor'); case 'bo': return r.bo; case 'muo': return r.muo; case 'z': return r.z; case 'mug': return r.mug;
            case 'bg': return r.bgRB; case 'bw': return r.bw; case 'muw': return r.muw; default: return null;
        }
    }
    function _pvtYLabel(prop) {
        return { rs: 'Rs (' + _lab('gor', 'scf/STB') + ')', bo: 'Bo (' + _fvfLab() + ')', muo: 'μo (cp)', z: 'Z factor (–)', mug: 'μg (cp)', bg: 'Bg (rb/Mscf)', bw: 'Bw (' + _fvfLab() + ')', muw: 'μw (cp)',
            rho: 'Density (' + _lab('density', 'lbm/ft³') + ')' }[prop] || '';
    }
    // the comparison tables are recomputed only when the fluid, the reservoir pressure or temperature change
    function _pvtData(M) {
        var W = G.WTS_wp_fluid, T = M.res.T_F, pr = M.res.pr, kind = _pvtKind(M.fluid.type);
        var key; try { key = JSON.stringify([M.fluid, T, pr]); } catch (e) { key = String(Math.random()); }
        if (ST.pvtData && ST.pvtData.key === key) return ST.pvtData;
        var base = Object.assign({}, M.fluid, { pbUser: null, match: null }), d = { key: key, kind: kind, fam: null, z: null, muod: null, grid: [] };   // the published families (the lab match is drawn from the selected fluid)
        var top = Math.max(_fin(pr) ? pr : 0, 1500) * 1.25;
        if (kind === 'oil' && typeof W.compare === 'function') {
            var f0 = W.compare(base, { T_F: T, pList: [top], pr: pr });
            var pbs = ((f0 && f0.rows) || []).map(function (r) { return r.pb; }).filter(_fin);
            if (pbs.length) top = Math.max(top, Math.max.apply(null, pbs) * 1.2);
        }
        top = Math.ceil(top / 100) * 100;
        for (var i = 0; i <= 44; i++) d.grid.push(PATM + (top - PATM) * i / 44);
        d.top = top;
        if (typeof W.compare === 'function') {
            if (kind === 'oil') { d.fam = W.compare(base, { T_F: T, pList: d.grid, pr: pr }); d.muod = W.compare(base, { T_F: T, pList: d.grid, pr: pr, slot: 'muod' }); }
            if (kind !== 'water') d.z = W.compare(base, { T_F: T, pList: d.grid, pr: pr, slot: 'z' });
        }
        ST.pvtData = d;
        return d;
    }
    function _renderPvtCard(preview) {
        var cv = _byId('wp_cv_pvt'), V = G.WTS_wp_view, W = G.WTS_wp_fluid; if (!cv || !V) return;
        var M = ST.M, F = ST.F, Tm = V.theme(), kind = _pvtKind(M && M.fluid.type), props = PVT_PROPS[kind], cur = _plots().pvtProp;
        if (!props.some(function (p) { return p[0] === cur; })) cur = props[0][0];
        var seg = _byId('wp_pvtseg');
        if (seg) seg.innerHTML = props.map(function (p) { return '<button type="button" data-act="pvtprop" data-k="' + p[0] + '" class="' + (p[0] === cur ? 'on' : '') + '" aria-pressed="' + (p[0] === cur) + '">' + _esc(p[1]) + '</button>'; }).join('');
        var hc = _byId('wp_pvtchips'), hv = _byId('wp_pvtverd'), ht = _byId('wp_pvtcmp'), hclr = _byId('wp_pvtclr');
        var T = M && M.res.T_F, ok = !!(F && F.ok && W && _fin(T));
        if (!ok) {
            V.chart(cv, { key: 'pvt', aspect: 0.62, minH: 220, maxH: 340, w: 520, x: { label: 'Pressure (' + _lab('pressure', 'psia') + ')' }, y: { label: _pvtYLabel(cur) }, series: [],
                empty: _isStub(F) ? 'The fluid engine draws the properties here once it is installed.' : 'Enter the fluid and the reservoir temperature (step ②) to plot the properties.' });
            [hc, hv, ht, hclr].forEach(function (h) { if (h) h.innerHTML = ''; });
            return;
        }
        var d = _pvtData(M), X = function (p) { return _dv(p, 'pressure'); }, cr = M.fluid.corr || {}, series = [], markers = [], vlines = [], handles = [];
        // the selected fluid (with the user's bubble point, or the dragged one) on the same grid
        var Fs = F, pbUser = _fin(preview) ? preview : M.fluid.pbUser, matched = !!(F.match && F.match.applied);
        if (_fin(preview)) { var Fp = W.build(Object.assign({}, M.fluid, { pbUser: preview }), { T_F: T }); if (Fp && Fp.ok) Fs = Fp; }
        var sel = (W.table(Fs, d.grid, T) || {}).rows || [], pbSel = Fs.pb(T);
        var slot = (cur === 'rs' || cur === 'bo') ? 'fam' : cur === 'muo' ? 'muod' : cur === 'z' ? 'z' : null;
        var cmp = slot ? d[slot] : null, selKey = slot === 'fam' ? cr.rs : slot === 'muod' ? cr.muod : slot === 'z' ? cr.z : null;
        var colOf = function (k) { return Tm[FAM_COL[k] || 'text2'] || Tm.text2; };
        if (cmp && cmp.rows) cmp.rows.forEach(function (r) {
            if (!r.ok || !r.table) return;
            var isSel = r.key === selKey;
            if (isSel && !(slot === 'fam' && (_fin(pbUser) || matched)) && !(slot === 'muod' && matched)) return;    // drawn below from the selected fluid
            series.push({ key: 'c_' + r.key, label: r.label + (isSel ? (matched ? ' (published)' : ' (correlation pb)') : '') + (r.verified ? '' : ' (prov.)'), color: colOf(r.key), width: 1.5, dash: r.verified ? (isSel ? [2, 3] : null) : [6, 4],
                pts: r.table.map(function (t) { return [X(t.p), _pvtVal(cur, t)]; }).filter(function (p) { return _fin(p[1]); }) });
            if (slot === 'fam' && _fin(r.pb) && r.at && r.at.pb) markers.push({ x: X(r.pb), y: _pvtVal(cur, r.at.pb), kind: 'diamond', color: colOf(r.key), r: 4.5 });
        });
        var selLabel = (slot === 'fam' ? _famLabel('rs', cr.rs) : slot === 'muod' ? _famLabel('muod', cr.muod) + ' μod' : slot === 'z' ? _famLabel('z', cr.z) : 'Selected correlations') + (matched && (cur === 'rs' || cur === 'bo' || cur === 'muo') ? ' — lab-matched' : '');
        // the lab points (B, WP23) when the lab temperature is within 5 °F of the reservoir temperature
        var LB = M.fluid.lab;
        if (kind === 'oil' && LB && Array.isArray(LB.rows) && LB.rows.length && _fin(LB.T_F) && Math.abs(LB.T_F - T) <= 5 && (cur === 'rs' || cur === 'bo' || cur === 'muo')) {
            var lp = LB.rows.filter(function (r) { return _fin(r[cur]); }).map(function (r) { return [X(r.p), cur === 'rs' ? _dv(r.rs, 'gor') : r[cur]]; });
            if (lp.length) series.push({ key: 'lab', label: 'lab' + (LB.example ? ' (example)' : '') + (LB.basis === 'differential' ? ' (differential)' : ''), color: Tm.green, kind: 'points', pts: lp });
        }
        if (cur === 'rho') {
            var wantO = kind === 'oil' || F.cgr > 0, wantW = kind === 'water' || sel.some(function (r) { return _fin(r.rsw); }) || F.wc > 0 || F.wgr > 0;
            if (wantO) series.push({ key: 'rhoO', label: kind === 'oil' ? 'Oil (live)' : 'Condensate', color: Tm.green, width: 2.6, pts: sel.map(function (r) { return [X(r.p), _dv(r.rhoO, 'density')]; }) });
            if (kind !== 'water') series.push({ key: 'rhoG', label: 'Gas', color: Tm.red, width: 2.6, pts: sel.map(function (r) { return [X(r.p), _dv(r.rhoG, 'density')]; }) });
            if (wantW) series.push({ key: 'rhoW', label: 'Water', color: Tm.blue, width: 2.6, pts: sel.map(function (r) { return [X(r.p), _dv(r.rhoW, 'density')]; }) });
        } else {
            series.push({ key: 'sel', label: selLabel + (slot === 'fam' && _fin(pbUser) ? ' (pb shifted)' : ''), color: Tm.accent, width: 3, pts: sel.map(function (r) { return [X(r.p), _pvtVal(cur, r)]; }).filter(function (p) { return _fin(p[1]); }) });
        }
        var pr = M.res.pr;
        if (_fin(pr)) vlines.push({ x: X(pr), color: Tm.text2, label: 'p̄r', dash: [2, 4] });
        // bubble-point handle (oil): drag to shift the selected correlation (one point), previewed live, committed on release
        if (kind === 'oil' && _fin(pbSel) && (cur === 'rs' || cur === 'bo' || cur === 'muo')) {
            var selAtPb = (W.table(Fs, [pbSel], T).rows || [])[0];
            if (cur !== 'rho' && selAtPb && _fin(_pvtVal(cur, selAtPb))) markers.push({ x: X(pbSel), y: _pvtVal(cur, selAtPb), kind: 'filled', color: Tm.accent, r: 5.5, halo: true });
            handles.push({ key: 'pb', kind: 'pointX', value: X(pbSel), min: X(100), max: X(d.top), step: _metric() ? 10 : 5, label: 'pb', color: Tm.accent,
                fmt: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia') + (_fin(pbUser) ? ' (shifted)' : ''); } });
        }
        V.chart(cv, {
            key: 'pvt:' + cur + ':' + kind + ':' + (_metric() ? 'm' : 'i'), aspect: 0.62, minH: 230, maxH: 360, w: 520,
            x: { label: 'Pressure (' + _lab('pressure', 'psia') + ') at ' + _u(T, 'temperature', 0, '°F'), min: 0, max: X(d.top), short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
            y: { label: _pvtYLabel(cur), min: (cur === 'z' || cur === 'bo' || cur === 'bw') ? undefined : 0, short: cur, fmtR: function (v) { return _fmt(v, cur === 'mug' ? 4 : cur === 'rs' || cur === 'rho' ? 1 : 3); } },
            series: series, markers: markers, vlines: vlines, handles: handles, readout: 'x',
            hidden: _plots().pvtHidden || null, onLegend: function (hid) { _plotsSet({ pvtHidden: hid }); },
            onHandle: function (key, v, phase) {
                if (key !== 'pb') return;
                var pbC = Math.round(_fromDisp(v, 'pressure'));
                _setCtrl('wp_pbUser', pbC, true);
                if (phase === 'end') { _commit('wp_pbUser'); return; }
                _renderPvtCard(pbC);
            },
            empty: 'No property for these inputs.'
        });
        if (hclr) hclr.innerHTML = (kind === 'oil' && _fin(M.fluid.pbUser)) ? '<button type="button" class="btn btn-secondary" data-act="pbclear" style="font-size:11.5px;padding:4px 10px" title="Remove the bubble-point shift">Clear pb shift (' + _esc(_u(M.fluid.pbUser, 'pressure', 0, 'psia')) + ')</button>' : '<span class="wp-hint" style="margin:0">Drag the pb handle, or use [ ] and the arrow keys on the plot, to shift the bubble point.</span>';
        if (kind !== 'oil') { if (hclr) hclr.innerHTML = ''; }
        // family chips, spread verdict and the comparison table
        var fam = d.fam && d.fam.rows ? d.fam.rows.filter(function (r) { return r.ok; }) : [];
        if (hc) hc.innerHTML = fam.map(function (r) {
            var isSel = r.key === cr.rs;
            return '<button type="button" class="wp-fchip ' + (r.inRange ? 'st-ok' : 'st-warn') + (isSel ? ' sel' : '') + '" data-act="pvtfam" data-k="' + _esc(r.key) + '" aria-pressed="' + isSel + '" title="Use the ' + _esc(r.label) + ' family for Pb, Rs and Bo">' +
                '<span class="n"><i style="background:' + (isSel ? Tm.accent : colOf(r.key)) + '"></i>' + _esc(r.label) + (r.verified ? '' : ' <span class="wp-chip prov" style="margin-left:0">provisional</span>') + '</span> ' +
                '<span class="v">pb ' + _esc(_u(r.pb, 'pressure', 0, 'psia')) + '</span> <span class="s">' + (r.inRange ? 'inside its data range' : 'outside its data range') + '</span></button>';
        }).join('');
        if (hv) {
            var vs = [];
            if (fam.length > 1 && _fin(d.fam.spreadPb)) {
                var sp = d.fam.spreadPb * 100;
                vs.push(sp > 15 ? { st: 'warn', t: '⚠ The bubble-point correlations differ by ' + _fmt(sp, 0) + ' % for this oil: enter a measured bubble point (or drag pb) to shift the selected one.' }
                    : { st: 'info', t: 'ℹ The bubble-point correlations agree within ' + _fmt(sp, 0) + ' % for this oil.' });
            }
            if ((F.provisional || []).length) vs.push({ st: 'info', t: ('ℹ Provisional (not verified against a published example): ' + F.provisional.join(', ') + '.').slice(0, 290) });
            hv.innerHTML = vs.map(_vHtml).join('');
        }
        if (ht) {
            if (fam.length) {
                ht.innerHTML = '<div class="wp-tw"><table class="dtable wp-dense"><thead><tr><th>Black-oil family</th><th>pb<br>' + _lab('pressure', 'psia') + '</th><th>Rs at p̄r<br>' + _lab('gor', 'scf/STB') + '</th><th>Bo at pb<br>' + _fvfLab() + '</th><th>μo at pb<br>cp</th><th>Data range</th></tr></thead><tbody>' +
                    fam.map(function (r) {
                        var a = r.at || {}, isSel = r.key === cr.rs;
                        return '<tr' + (isSel ? ' style="font-weight:700"' : '') + '><td>' + (isSel ? '● ' : '') + _esc(r.label) + (r.verified ? '' : '<div style="font-size:10.5px;font-weight:600;color:var(--wp-warn)"> (provisional)</div>') + '</td><td class="num">' + _fmt(_dv(r.pb, 'pressure'), 0) + '</td><td class="num">' + (a.pr ? _fmt(_dv(a.pr.rs, 'gor'), 0) : '—') +
                            '</td><td class="num">' + (a.pb ? _fmt(a.pb.bo, 4) : '—') + '</td><td class="num">' + (a.pb ? _fmt(a.pb.muo, 3) : '—') + '</td><td>' + (r.inRange ? 'inside' : 'outside') + '</td></tr>';
                    }).join('') + '</tbody></table></div>';
            } else if (kind === 'gas' && d.z && d.z.rows && _fin(pr)) {
                ht.innerHTML = '<div class="wp-tw"><table class="dtable"><thead><tr><th>Z correlation at p̄r</th><th>Z</th><th>μg (cp)</th><th>Bg (rb/Mscf)</th><th>ρg (' + _lab('density', 'lbm/ft³') + ')</th></tr></thead><tbody>' +
                    d.z.rows.filter(function (r) { return r.ok && r.at && r.at.pr; }).map(function (r) { var a = r.at.pr; return '<tr><td>' + (r.key === cr.z ? '● ' : '') + _esc(r.label) + (r.verified ? '' : ' (provisional)') + '</td><td class="num">' + _fmt(a.z, 4) + '</td><td class="num">' + _fmt(a.mug, 4) + '</td><td class="num">' + _fmt(a.bgRB, 4) + '</td><td class="num">' + _fmt(_dv(a.rhoG, 'density'), 2) + '</td></tr>'; }).join('') + '</tbody></table></div>';
            } else if (kind === 'water' && _fin(pr)) {
                var wr = (W.table(F, [pr], T).rows || [])[0];
                ht.innerHTML = wr ? '<div class="rbox-title">Water at p̄r (McCain)</div><div class="rrow"><span class="rl">Bw</span><span class="rv">' + _fmt(wr.bw, 4) + ' ' + _fvfLab() + '</span></div><div class="rrow"><span class="rl">μw</span><span class="rv">' + _fmt(wr.muw, 3) + ' cp</span></div>' +
                    '<div class="rrow"><span class="rl">ρw in situ</span><span class="rv">' + _u(wr.rhoW, 'density', 2, 'lbm/ft³') + '</span></div><div class="rrow"><span class="rl">γw (standard)</span><span class="rv">' + _fmt(F.sgw, 4) + '</span></div>' : '';
            } else ht.innerHTML = '';
        }
        _renderStudies();
    }

    // ── ① PVT lab match, modified black oil (Rv) and emulsion (B, WP23) ───────────────────────────────────
    // The lab record (conditions, table, Rv and emulsion tables, the adopted match) is the model key `lab` (WTS_wp_model); the fit is
    // a Job (WTS_wp_pvtmatch.job via the existing driver) and Apply writes lab.adopt, so every solve uses the matched set (US14).
    var PVTM_PROPS = [['rs', 'Rs'], ['bo', 'Bo'], ['muo', 'μo']];
    var LAB_IN = { wpl_T: 'temperature', wpl_pb: 'pressure', wpl_rsbF: 'gor' };
    function _labRec(M) { var L = M && M.fluid && M.fluid.lab; return L && typeof L === 'object' ? JSON.parse(JSON.stringify(L)) : { v: 1, T_F: null, basis: 'flash', pb: null, rsbF: null, bobF: null, rows: [], rv: [], emul: [] }; }
    function _labKey(L) { try { return String(JSON.stringify([L.T_F, L.basis, L.pb, L.rsbF, L.bobF, L.rows]).length) + ':' + JSON.stringify([L.T_F, L.basis, L.pb, L.rsbF, L.bobF, L.rows]).split('').reduce(function (h, c) { return (h * 31 + c.charCodeAt(0)) >>> 0; }, 7).toString(36); } catch (e) { return ''; } }
    function _labWrite(patch, batch) {
        var Mm = G.WTS_wp_model; if (!Mm || typeof Mm.write !== 'function') return null;
        var L = Object.assign(_labRec(ST.M || _read()), patch || {});
        if (batch) ST.batch = (ST.batch || 0) + 1;
        var r; try { r = Mm.write({ lab: L }); } finally { if (batch) ST.batch--; }
        if (r && !r.ok) _banner('fail', 'The lab data were not saved: ' + ((r.errors || []).join(' ') || r.code));
        ST.M = _read() || ST.M;
        return r;
    }
    function _labInputsFill() {
        var L = _labRec(ST.M || _read());
        var put = function (id, v) { var e = _byId(id); if (e) _canon(function () { e.value = _fin(v) ? String(+(+v).toPrecision(8)) : ''; }); };
        put('wpl_T', L.T_F); put('wpl_pb', L.pb); put('wpl_rsbF', L.rsbF); put('wpl_bobF', L.bobF);
        var b = _byId('wpl_basis'); if (b) b.value = L.basis === 'differential' ? 'differential' : 'flash';
    }
    function _labInputsWrite() {
        var v = {}; _canon(function () { ['wpl_T', 'wpl_pb', 'wpl_rsbF', 'wpl_bobF'].forEach(function (id) { var e = _byId(id), x = e ? parseFloat(String(e.value).replace(',', '.')) : NaN; v[id] = _fin(x) ? x : null; }); });
        _labWrite({ T_F: v.wpl_T, pb: v.wpl_pb, rsbF: v.wpl_rsbF, bobF: v.wpl_bobF, basis: (_byId('wpl_basis') || {}).value === 'differential' ? 'differential' : 'flash', example: false });
        _renderPvtLab();
    }
    function _pvtmOn() { var M = ST.M; return !!(M && M.fluid.type === 'oil'); }
    function _pvtmAdopted(M) { var L = M && M.fluid && M.fluid.lab; return L && L.adopt && L.adopt.on ? L.adopt : null; }
    function _pvtmAct(act, btn) {
        var M = ST.M || _read(), P = G.WTS_wp_pvtmatch, h = _byId('wp_pvtmjob');
        if (!M || !P) { if (h) h.innerHTML = _vHtml({ st: 'warn', t: '⚠ The PVT match engine is not available.' }); return; }
        if (act === 'pvtmatch') {
            var L = _labRec(M), n = P.normLab(L);
            if (!n.ok) { if (h) h.innerHTML = _vHtml({ st: 'warn', t: '⚠ ' + n.errors.join(' ') }); return; }
            ST.pvtmEdit = null;
            _drive(P.job(M.fluid, L), function (r) {
                ST.pvtm = r && typeof r === 'object' ? r : null; ST.pvtmKey = _labKey(L) + '|' + JSON.stringify(M.fluid.corr || {}) + '|' + M.fluid.api + '|' + M.fluid.sgg;
                if (G.WTS_state && G.WTS_state.wellperf) G.WTS_state.wellperf.pvtmatch = _pvtmSummary();
                _renderPvtLab(); _renderStudies();
            }, 'PVT lab match', 'wp_pvtmjob');
            return;
        }
        if (act === 'pvtadopt') {
            var f = ST.pvtm && ST.pvtm.fit; if (!f || !f.ok) return;
            var m = ST.pvtmEdit ? ST.pvtmEdit.match : f.match, Lr = _labRec(M);
            _labWrite({ adopt: { on: true, pbFactor: m.pbFactor, mult: m.mult, shift: m.shift, rsPb: m.rsPb || null, corr: m.corr, T_F: f.T_F, mare: ST.pvtmEdit ? null : m.mare, ts: Date.now(), edited: !!ST.pvtmEdit, labKey: _labKey(Lr) } });
            if (h) h.innerHTML = _vHtml({ st: 'ok', t: '✓ The matched black-oil set is applied: every solve, table and plot on this page now uses it.' });
            _renderPvtLab(); return;
        }
        if (act === 'pvtunadopt') { _labWrite({ adopt: null }); if (h) h.innerHTML = _vHtml({ st: 'info', t: 'ℹ The lab match is removed: the published correlations are used.' }); _renderPvtLab(); return; }
        if (act === 'pvtmprop') { _plotsSet({ pvtmProp: btn.getAttribute('data-k') }); _drawPvtm(); return; }
        if (act === 'pvtusefam') { var fk = btn.getAttribute('data-k'); _setCtrl('wp_corr_pb', fk); _famSync('wp_corr_pb'); _commit('wp_corr_pb'); if (h) h.innerHTML = _vHtml({ st: 'info', t: 'ℹ ' + _famLabel('rs', fk) + ' selected for Pb, Rs and Bo: run the match again for its multipliers.' }); _renderPvtLab(); return; }
        if (act === 'pvtusevisc') { _setCtrl('wp_corr_muod', btn.getAttribute('data-d')); _setCtrl('wp_corr_muo', btn.getAttribute('data-l')); _commit('wp_corr_muo'); if (h) h.innerHTML = _vHtml({ st: 'info', t: 'ℹ Viscosity pair selected: run the match again.' }); _renderPvtLab(); return; }
        if (act === 'labex') {
            var ex = P.example(M.fluid, M.res.T_F); if (!ex) { if (h) h.innerHTML = _vHtml({ st: 'warn', t: '⚠ Enter the oil (API, gas gravity, GOR) and the reservoir temperature first.' }); return; }
            var Lx = _labRec(M); Lx.T_F = ex.T_F; Lx.basis = 'flash'; Lx.pb = ex.pb; Lx.rsbF = ex.rsbF; Lx.bobF = null; Lx.rows = ex.rows; Lx.example = true; Lx.adopt = null;
            _labWrite(Lx); _labInputsFill(); _renderTable('lab'); ST.pvtm = null; ST.pvtmEdit = null;
            if (h) h.innerHTML = _vHtml({ st: 'info', t: 'ℹ Example lab data loaded (synthetic: the oil with a known distortion of the Standing family) — replace them with the lab report.' });
            _renderPvtLab(); return;
        }
        if (act === 'rvex') {
            var pd = _fin(M.fluid.rv && M.fluid.rv.pd) ? M.fluid.rv.pd : Math.round((_fin(M.res.pr) ? M.res.pr : 5000) * 0.84 / 50) * 50;
            _labWrite({ rv: P.exampleRv(M.fluid.cgr, pd) }, true); _renderTable('rv');
            if (!_fin(M.fluid.rv && M.fluid.rv.pd)) _setCtrl('wp_pdew', pd, true);
            if ((M.fluid.rv || {}).mode !== 'table') _setCtrl('wp_rvmode', 'table');
            _syncUi(); _commit('wp_pdew'); return;
        }
        if (act === 'emulex') { _labWrite({ emul: P.exampleEmul() }, true); _renderTable('emul'); if ((_byId('wp_emul') || {}).value !== 'table') _setCtrl('wp_emul', 'table'); _syncUi(); _commit('wp_emul'); return; }
    }
    function _pvtmSummary() {
        var r = ST.pvtm, f = r && r.fit; if (!f || !f.ok) return r ? { ok: false, code: (f && f.code) || r.code || null } : null;
        var a = _pvtmAdopted(ST.M), best = r.rank && r.rank.families && r.rank.families[0];
        return { ok: true, corr: f.corr, pb: f.pb, props: Object.keys(f.props).reduce(function (o, k) { var p = f.props[k]; o[k] = { a: p.a, b: p.b, n: p.n, mareBefore: p.mareBefore, mareAfter: p.mareAfter }; return o; }, {}),
                 best: best ? best.key : null, applied: !!a, flags: (f.flags || []).map(function (x) { return x.code; }) };
    }
    function _pvtmStale() { var M = ST.M, r = ST.pvtm; if (!M || !r) return false; return ST.pvtmKey !== (_labKey(_labRec(M)) + '|' + JSON.stringify(M.fluid.corr || {}) + '|' + M.fluid.api + '|' + M.fluid.sgg); }
    function _mareTxt(v) { return _fin(v) ? (v < 0.1 ? _fmt(v, 3) : _fmt(v, v < 10 ? 2 : 1)) + ' %' : '—'; }
    function _renderPvtLab() {
        var h = _byId('wp_pvtmres'); if (!h) return;
        var M = ST.M, r = ST.pvtm, f = r && r.fit, ad = _pvtmAdopted(M), F = ST.F, out = [];
        var stF = F && F.match;
        var ht0 = _byId('wp_pvtmtab'); if (ht0) ht0.innerHTML = '';
        if (!M || M.fluid.type !== 'oil') { h.innerHTML = ''; return; }
        // status line of the model's match
        if (ad) {
            var fresh = ad.labKey && ad.labKey === _labKey(_labRec(M));
            out.push(_vHtml(stF && stF.stale ? { st: 'warn', t: '⚠ An adopted match is stored but not applied: it was fitted to ' + [ad.corr.rs, ad.corr.bo, ad.corr.muod, ad.corr.muo].filter(Boolean).map(function (k) { return _famLabel('rs', k).replace(/ \(provisional\)$/, ''); }).join(' / ') + ' — run the match again for the selected correlations.' }
                : { st: fresh ? 'ok' : 'warn', t: (fresh ? '✓ Matched set applied' : '⚠ Matched set applied, but the lab data changed since — run the match again') + ' (Rs ' + _fx(ad.mult.rs, 3) + '·x' + (ad.shift.rs ? (ad.shift.rs > 0 ? ' + ' : ' − ') + _fmt(Math.abs(_dv(ad.shift.rs, 'gor')), 1) : '') + ', Bo ' + _fx(ad.mult.bo, 3) + '·x' + (ad.shift.bo ? (ad.shift.bo > 0 ? ' + ' : ' − ') + _fx(Math.abs(ad.shift.bo), 4) : '') + ', μo ' + _fx(ad.mult.muo, 3) + '·x' + (_fin(ad.pbFactor) && ad.pbFactor !== 1 ? ', pb factor ' + _fx(ad.pbFactor, 4) : '') + (ad.edited ? ', adjusted by hand' : '') + ').' }));
        }
        if (!r) { h.innerHTML = out.join('') + '<div class="wp-v info">Enter the lab table (or load the example) and press Match: every black-oil family is ranked against the lab points and the selected one is matched (a·y + b per property, Levenberg-Marquardt).</div>'; return; }
        if (!f || !f.ok) { h.innerHTML = out.join('') + _vHtml({ st: (r.code === 'CANCELLED' ? 'info' : 'warn'), t: (r.code === 'CANCELLED' ? 'ℹ The match was cancelled.' : '⚠ ' + (((f && f.errors) || r.errors || [])[0] || 'The match could not be run.')) }); return; }
        if (_pvtmStale()) out.push('<div class="wp-stalechip" role="status">The match is from the previous lab data or correlations — run it again</div>');
        var best = r.rank && r.rank.families ? r.rank.families.filter(function (x) { return x.ok; })[0] : null, sel = f.corr.rs;
        var k = [], pbE = f.pb.errPct;
        k.push(_kpiHtml('Bubble point', _fin(f.pb.lab) ? _u(f.pb.lab, 'pressure', 0, 'psia') : '—', _fin(pbE) ? _famLabel('rs', sel).replace(/ \(provisional\)$/, '') + ' ' + (pbE >= 0 ? '+' : '') + _fmt(pbE, 1) + ' %' : 'no lab value', _fin(pbE) ? (Math.abs(pbE) <= 5 ? 'ok' : Math.abs(pbE) <= 15 ? 'warn' : 'fail') : 'none', 'Lab bubble point and the error of the selected correlation before the match (matched by the one-point factor).'));
        var ed = ST.pvtmEdit;
        PVTM_PROPS.forEach(function (p) {
            var q = f.props[p[0]]; if (!q) return;
            var after = ed && ed.mare && _fin(ed.mare[p[0]]) ? ed.mare[p[0]] : q.mareAfter;
            k.push(_kpiHtml({ rs: 'Rs error', bo: 'Bo error', muo: 'Viscosity error' }[p[0]], _mareTxt(after), 'was ' + _mareTxt(q.mareBefore) + ' · a ' + _fx(ed && ed.match ? ed.match.mult[p[0]] : q.a, 3), (function () { var a = ed && ed.match ? ed.match.mult[p[0]] : q.a; return a < 0.8 || a > 1.25 ? 'fail' : a < 0.9 || a > 1.1 ? 'warn' : 'ok'; })(),
                'Mean absolute relative error against the ' + q.n + ' lab point(s): after the match (was, unmatched). a = the multiplier; inside 0.9–1.1 the correlation is close, outside 0.8–1.25 it is stretched.'));
        });
        if (best) k.push(_kpiHtml('Best family', best.label, 'mean error ' + _mareTxt(best.score) + (best.key === sel ? ' · selected' : ''), best.key === sel ? 'ok' : 'info', 'Ranked by the mean absolute relative error of the unmatched Pb, Rs and Bo against the lab points.'));
        out.push('<div class="wp-kpis wp-tkpis" aria-live="polite">' + k.join('') + '</div>');
        (f.flags || []).forEach(function (x) { out.push(_vHtml({ st: x.sev === 'fail' ? 'fail' : x.sev === 'warn' ? 'warn' : 'info', t: (x.sev === 'fail' ? '✗ ' : x.sev === 'warn' ? '⚠ ' : 'ℹ ') + x.msg })); });
        (f.warnings || []).filter(function (w) { return w.code === 'DIFF_FLASH' || w.code === 'DIFF_NO_SEP' || w.code === 'DIFF_NO_PB'; }).forEach(function (w) { out.push(_vHtml({ st: w.sev === 'info' ? 'info' : 'warn', t: (w.sev === 'info' ? 'ℹ ' : '⚠ ') + w.msg })); });
        var cur = ad && !(stF && stF.stale), same = cur && Math.abs(ad.mult.rs - f.match.mult.rs) < 1e-9 && Math.abs(ad.mult.bo - f.match.mult.bo) < 1e-9 && Math.abs(ad.mult.muo - f.match.mult.muo) < 1e-9 && !ad.edited && !ed;
        out.push('<div class="wp-btns rp-skip" style="align-items:center">' + (same ? '<span class="wp-chip" style="margin:0;font-size:11.5px;padding:5px 11px;background:rgba(63,185,80,.15);color:var(--wp-ok)">✓ Applied to the model</span>' : '<button type="button" class="btn btn-primary" data-act="pvtadopt">' + (ed ? 'Apply the adjusted match' : 'Apply the match to the model') + '</button>') + (ad ? '<button type="button" class="btn btn-secondary" data-act="pvtunadopt">Remove the match</button>' : '') + '</div>');
        // plot (property tabs, lab points, unmatched and matched curves, a / b rails)
        var cp = _plots().pvtmProp; if (!f.props[cp]) cp = PVTM_PROPS.filter(function (p) { return f.props[p[0]]; }).map(function (p) { return p[0]; })[0] || 'rs';
        out.push('<div class="wp-pvtbar rp-skip" style="margin-top:10px"><span class="wp-seg" role="group" aria-label="Property to plot">' + PVTM_PROPS.filter(function (p) { return f.props[p[0]]; }).map(function (p) { return '<button type="button" data-act="pvtmprop" data-k="' + p[0] + '" class="' + (p[0] === cp ? 'on' : '') + '" aria-pressed="' + (p[0] === cp) + '">' + p[1] + '</button>'; }).join('') + '</span></div>' +
            '<div class="chart-wrap"><canvas id="wp_cv_pvtm" tabindex="0" aria-label="Lab points against the correlation before and after the match; drag the a and b rails to adjust the match by hand"></canvas></div>' +
            '<div class="wp-hint rp-skip">Drag <b>a</b> (multiplier) or <b>b</b> (shift) on the top rails: the curve and the error follow live; Apply keeps the adjusted values. Keyboard: [ and ] pick a rail, arrows move it, Enter commits.</div>');
        h.innerHTML = out.join('');
        _drawPvtm();
        // parameters and rankings (full width, below the two cards)
        out = [];
        out.push('<div class="wp-pvtmg"><div><div class="rbox-title" style="margin:0 0 4px">Matched parameters (y = a·y_corr + b)</div><div class="wp-tw"><table class="dtable wp-dense"><thead><tr><th>Property</th><th>Points</th><th>a</th><th>b</th><th>95 % of a</th><th>Error before</th><th>Error after</th></tr></thead><tbody>' +
            PVTM_PROPS.filter(function (p) { return f.props[p[0]]; }).map(function (p) {
                var q = f.props[p[0]], bU = p[0] === 'rs' ? ' ' + _lab('gor', 'scf/STB') : p[0] === 'muo' ? ' cp' : '';
                return '<tr><td>' + p[1] + '</td><td class="num">' + q.n + '</td><td class="num">' + _fx(q.a, 4) + '</td><td class="num">' + (q.fixedB ? '0 (held)' : _fx(p[0] === 'rs' ? _dv(q.b, 'gor') : q.b, p[0] === 'bo' ? 4 : 2) + bU) + '</td><td class="num">' + (q.ci95 && q.ci95.a ? _fx(q.ci95.a[0], 3) + '–' + _fx(q.ci95.a[1], 3) : '—') + '</td><td class="num">' + _mareTxt(q.mareBefore) + '</td><td class="num">' + _mareTxt(q.mareAfter) + '</td></tr>';
            }).join('') + (_fin(f.pb.lab) ? '<tr><td>pb</td><td class="num">1</td><td class="num" colspan="2">factor ' + _fx(f.pb.factor, 4) + '</td><td class="num">—</td><td class="num">' + (_fin(pbE) ? _fmt(Math.abs(pbE), 1) + ' %' : '—') + '</td><td class="num">' + (_fin(f.pb.after) ? _fmt(Math.abs(100 * (f.pb.after / f.pb.lab - 1)), 2) + ' %' : '—') + '</td></tr>' : '') + '</tbody></table></div></div>');
        // ranking
        var fam = (r.rank && r.rank.families || []).filter(function (x) { return x.ok; });
        if (fam.length) out.push('<div><div class="rbox-title" style="margin:0 0 4px">Black-oil families against the lab table (unmatched)</div><div class="wp-tw"><table class="dtable wp-dense wp-cmpt"><thead><tr><th>Family</th><th>pb error</th><th>Rs error</th><th>Bo error</th><th>Mean</th><th></th></tr></thead><tbody>' +
            fam.map(function (x, i) {
                var isS = x.key === sel;
                return '<tr' + (isS ? ' class="wp-sel"' : '') + '><td>' + (i === 0 ? '★ ' : '') + _esc(x.label) + (x.verified ? '' : ' <span class="wp-chip prov" style="margin-left:4px">provisional</span>') + '</td><td class="num">' + (_fin(x.pbErrPct) ? (x.pbErrPct >= 0 ? '+' : '') + _fmt(x.pbErrPct, 1) + ' %' : '—') + '</td><td class="num">' + _mareTxt(x.mare.rs) + '</td><td class="num">' + _mareTxt(x.mare.bo) + '</td><td class="num"><b>' + _mareTxt(x.score) + '</b></td><td>' +
                    (isS ? '<span class="wp-hint" style="margin:0">selected</span>' : '<button type="button" class="btn btn-secondary wp-use rp-skip" data-act="pvtusefam" data-k="' + _esc(x.key) + '">Use</button>') + '</td></tr>';
            }).join('') + '</tbody></table></div></div>');
        var vis = (r.rank && r.rank.viscosity || []).filter(function (x) { return x.ok && _fin(x.mare); }).slice(0, 6), cr = M.fluid.corr || {};
        if (vis.length) out.push('<div><div class="rbox-title" style="margin:0 0 4px">Viscosity pairs (dead + live oil) against the lab μo</div><div class="wp-tw"><table class="dtable wp-dense wp-cmpt"><thead><tr><th>Dead + live oil</th><th>Viscosity error</th><th></th></tr></thead><tbody>' +
            vis.map(function (x, i) { var isS = x.muod === cr.muod && x.muo === cr.muo; return '<tr' + (isS ? ' class="wp-sel"' : '') + '><td>' + (i === 0 ? '★ ' : '') + _esc(x.label) + (x.verified ? '' : ' <span class="wp-chip prov" style="margin-left:4px">provisional</span>') + '</td><td class="num">' + _mareTxt(x.mare) + '</td><td>' + (isS ? '<span class="wp-hint" style="margin:0">selected</span>' : '<button type="button" class="btn btn-secondary wp-use rp-skip" data-act="pvtusevisc" data-d="' + _esc(x.muod) + '" data-l="' + _esc(x.muo) + '">Use</button>') + '</td></tr>'; }).join('') + '</tbody></table></div></div>');
        var ht = _byId('wp_pvtmtab'); if (ht) ht.innerHTML = out.join('') + '</div>';
    }
    function _pvtmCurve(match) {
        var r = ST.pvtm, f = r && r.fit, M = ST.M, P = G.WTS_wp_pvtmatch; if (!f || !f.ok || !P || !M) return [];
        var L = _labRec(M), pMax = Math.max.apply(null, f.points.map(function (q) { return q.p; }).concat([f.pb.lab || 0])) * 1.08, grid = [];
        for (var i = 0; i <= 40; i++) grid.push(PATM + (pMax - PATM) * i / 40);
        var pr = P.predict(M.fluid, L, match || null, grid); return pr && pr.ok ? pr.rows : [];
    }
    function _drawPvtm() {
        var cv = _byId('wp_cv_pvtm'), V = G.WTS_wp_view, r = ST.pvtm, f = r && r.fit; if (!cv || !V || !f || !f.ok) return;
        var T = V.theme(), cp = _plots().pvtmProp; if (!f.props[cp]) cp = PVTM_PROPS.filter(function (p) { return f.props[p[0]]; }).map(function (p) { return p[0]; })[0] || 'rs';
        var ed = ST.pvtmEdit, m = ed ? ed.match : f.match, X = function (p) { return _dv(p, 'pressure'); };
        var Y = function (v) { return cp === 'rs' ? _dv(v, 'gor') : v; };
        var key = 'unm|' + JSON.stringify(f.corr) + f.T_F;
        if (!ST.pvtmCache || ST.pvtmCache.key !== key + JSON.stringify(f.match.mult) + JSON.stringify(f.match.shift)) ST.pvtmCache = { key: key + JSON.stringify(f.match.mult) + JSON.stringify(f.match.shift), unm: _pvtmCurve(null), mat: _pvtmCurve(f.match) };
        var unm = ST.pvtmCache.unm, mat = ed ? (ed.curve || _pvtmCurve(m)) : ST.pvtmCache.mat;
        var pts = f.points.filter(function (q) { return _fin(q.lab[cp]); });
        var series = [
            { key: 'unm', label: _famLabel('rs', f.corr.rs).replace(/ \(provisional\)$/, '') + ' (unmatched)', color: T.text2, width: 1.6, dash: [6, 4], pts: unm.map(function (q) { return [X(q.p), Y(q[cp])]; }).filter(function (p) { return _fin(p[1]); }) },
            { key: 'mat', label: ed ? 'matched (adjusted by hand)' : 'matched a·y + b', color: ed ? T.yellow : T.accent, width: 2.8, pts: mat.map(function (q) { return [X(q.p), Y(q[cp])]; }).filter(function (p) { return _fin(p[1]); }) },
            { key: 'lab', label: 'lab' + (f.example ? ' (example)' : '') + (f.flash && f.flash.applied ? ', flash-adjusted' : ''), color: T.green, kind: 'points', pts: pts.map(function (q) { return [X(q.p), Y(q.lab[cp])]; }) }
        ];
        var q = f.props[cp], aV = m.mult[cp], bV = m.shift[cp], B = (G.WTS_wp_pvtmatch && G.WTS_wp_pvtmatch.BOUNDS[cp]) || { a: [0.5, 2] };
        var yLab = pts.map(function (z) { return z.lab[cp]; }), span = yLab.length ? Math.max.apply(null, yLab) : 1;
        var bR = cp === 'bo' ? [-0.15, 0.15] : [-0.3 * span, 0.3 * span];
        var handles = [{ key: 'a', kind: 'railX', value: aV, min: B.a[0], max: B.a[1], step: 0.002, label: 'a', railLabel: 'a', rail: [0, 0.5], color: T.accent, fmt: function (v) { return 'a ' + _fx(v, 3); } }];
        if (q && !q.fixedB) handles.push({ key: 'b', kind: 'railX', value: Math.max(bR[0], Math.min(bR[1], bV)), min: bR[0], max: bR[1], step: cp === 'bo' ? 0.0005 : span / 500, label: 'b', railLabel: 'b', rail: [0.5, 1], color: T.purple, fmt: function (v) { return 'b ' + (cp === 'bo' ? _fx(v, 4) : _fmt(Y(v), 1)); } });
        var vl = []; if (_fin(f.pb.lab)) vl.push({ x: X(f.pb.lab), color: T.green, label: 'pb lab', dash: [3, 3] });
        if (_fin(f.pb.corr)) vl.push({ x: X(f.pb.corr), color: T.text2, label: 'pb corr.', dash: [2, 5] });
        var yl = { rs: 'Rs (' + _lab('gor', 'scf/STB') + ')', bo: 'Bo (' + _fvfLab() + ')', muo: 'μo (cp)' }[cp];
        V.chart(cv, { key: 'pvtm:' + cp + (_metric() ? 'm' : 'i'), aspect: 0.62, minH: 230, maxH: 380, w: 520, readout: 'x',
            x: { label: 'Pressure (' + _lab('pressure', 'psia') + ') at ' + _u(f.T_F, 'temperature', 0, '°F') + ' (lab)', min: 0, short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
            y: { label: yl, min: cp === 'bo' ? undefined : 0, short: cp, fmtR: function (v) { return _fmt(v, cp === 'bo' ? 4 : cp === 'muo' ? 3 : 1); } },
            series: series, vlines: vl, handles: handles, onHandle: _pvtmHandle, hidden: _plots().pvtmHidden || null, onLegend: function (hid) { _plotsSet({ pvtmHidden: hid }); },
            empty: 'The lab points and the matched curve appear after a match.' });
    }
    function _pvtmHandle(key, v, phase) {
        var r = ST.pvtm, f = r && r.fit, M = ST.M, P = G.WTS_wp_pvtmatch; if (!f || !f.ok || !P || !M) return;
        var cp = _plots().pvtmProp; if (!f.props[cp]) cp = PVTM_PROPS.filter(function (p) { return f.props[p[0]]; }).map(function (p) { return p[0]; })[0];
        var base = ST.pvtmEdit ? ST.pvtmEdit.match : f.match, e = { key: cp, a: base.mult[cp], b: base.shift[cp] };
        e[key] = key === 'a' ? Math.round(v * 1000) / 1000 : v;
        var pv = P.preview(M.fluid, _labRec(M), Object.assign({}, f, { match: base }), e);
        if (!pv) return;
        ST.pvtmEdit = { match: pv.match, mare: pv.mare, curve: phase === 'end' ? _pvtmCurve(pv.match) : null };
        if (phase === 'end') { _renderPvtLab(); return; }
        ST.pvtmEdit.curve = _pvtmCurve(pv.match);
        var hk = document.querySelector && document.querySelector('#wp_pvtmres .wp-tkpis'); if (hk) { /* the chips follow on release */ }
        _drawPvtm();
    }

    // condensate drop-out (modified black oil, Rv) — the Rv table against pressure and the free condensate along the operating traverse
    function _rvInfo() {
        var M = ST.M, F = ST.F, R = ST.R; if (!M || !F || !F.ok || !F.rv) return null;
        var prof = R && R.ok && R.traverse && R.traverse.profile ? R.traverse.profile.filter(function (x) { return !x.restr; }) : [], cgr = F.cgr, pd = F.rv.pd;
        var rows = prof.map(function (x) { var v = G.WTS_flowline_rvAt ? G.WTS_flowline_rvAt(F.rv, x.p, cgr) : null; return { md: x.md, tvd: x.tvd, p: x.p, rv: v, free: _fin(v) ? Math.max(0, cgr - v) : null }; });
        var deep = null; rows.forEach(function (x) { if (_fin(pd) && x.p < pd && (deep == null || x.md > deep.md)) deep = x; });
        return { rows: rows, pd: pd, cgr: cgr, deep: deep, prAbove: _fin(M.res.pr) && _fin(pd) ? M.res.pr > pd : null, wh: rows.length ? rows[0] : null };
    }
    function _renderRv() {
        var hk = _byId('wp_rvk'), M = ST.M, F = ST.F; if (!hk) return;
        var gas = M && _isGasType(M.fluid.type) && M.fluid.cgr > 0, on = !!(F && F.ok && F.rv);
        if (!gas) { hk.innerHTML = ''; return; }
        var I = _rvInfo(), k = [];
        if (!on) {
            hk.innerHTML = '<div class="wp-v info">' + ((M.fluid.rv || {}).mode === 'table' ? 'Enter the Rv table (or load the example) to use the modified black oil.' : 'Wet gas (default, D14): all the condensate is liquid along the well. Choose "Modified black oil" to carry part of it vaporised in the gas by an Rv table (lab constant-volume depletion).') + '</div>';
        } else {
            k.push(_kpiHtml('Dew point', _u(I.pd, 'pressure', 0, 'psia'), I.prAbove == null ? '' : I.prAbove ? 'below p̄r: single phase in the reservoir' : 'above p̄r: condensate in the reservoir', I.prAbove === false ? 'warn' : 'info'));
            k.push(_kpiHtml('Drop-out starts', I.deep ? _u(I.deep.md, 'length', 0, 'ft') + ' MD' : (I.rows.length ? 'not in the well' : '—'), I.deep ? _u(I.deep.tvd, 'length', 0, 'ft') + ' TVD · ' + _u(I.deep.p, 'pressure', 0, 'psia') : (I.rows.length ? 'p above the dew point everywhere' : 'after a solve'), I.deep ? 'info' : 'ok'));
            if (I.wh && _fin(I.wh.free)) k.push(_kpiHtml('Free condensate at the wellhead', _u(I.wh.free, 'cgr', 1, 'STB/MMscf'), 'of ' + _u(I.cgr, 'cgr', 1, 'STB/MMscf') + ' (' + _fmt(100 * I.wh.free / I.cgr, 0) + ' %)', 'info'));
            hk.innerHTML = '<div class="wp-kpis wp-tkpis">' + k.join('') + '</div>' + _vHtml({ st: 'info', t: 'ℹ Modified black oil (Rv) — ' + PROVISIONAL_TXT + '. The wet-gas model (D14) stays the default.' });
        }
        _drawRv(I);
    }
    function _drawRv(I) {
        var V = G.WTS_wp_view, M = ST.M, F = ST.F, T = V && V.theme(); if (!V || !M) return;
        var cv = _byId('wp_cv_rv'), cv2 = _byId('wp_cv_rvd'), on = !!(F && F.ok && F.rv), cgr = M.fluid.cgr, X = function (p) { return _dv(p, 'pressure'); };
        var rows = (M.fluid.rv && M.fluid.rv.rows) || [], pd = on ? F.rv.pd : (M.fluid.rv && M.fluid.rv.pd);
        if (cv) {
            var pMax = Math.max(_fin(M.res.pr) ? M.res.pr : 0, _fin(pd) ? pd * 1.2 : 0, rows.length ? rows[rows.length - 1][0] * 1.2 : 0, 1000);
            var cur = on && G.WTS_wp_pvtmatch ? G.WTS_wp_pvtmatch.rvCurve(F.rv, cgr, { pMax: pMax, n: 80 }) : [];
            var ser = [{ key: 'cgr', label: 'CGR (total)', color: T.text2, width: 1.4, dash: [4, 4], pts: [[0, _dv(cgr, 'cgr')], [X(pMax), _dv(cgr, 'cgr')]] }];
            if (cur.length) ser.push({ key: 'rv', label: 'Rv vaporised', color: T.accent, width: 2.8, pts: cur.map(function (q) { return [X(q.p), _dv(q.rv, 'cgr')]; }) }, { key: 'free', label: 'free condensate', color: T.blue, width: 2, kind: 'area', pts: cur.map(function (q) { return [X(q.p), _dv(q.free, 'cgr')]; }) });
            if (rows.length) ser.push({ key: 'tab', label: 'Rv table', color: T.green, kind: 'points', pts: rows.map(function (r) { return [X(r[0]), _dv(r[1], 'cgr')]; }) });
            var vl = []; if (_fin(M.res.pr)) vl.push({ x: X(M.res.pr), color: T.text2, label: 'p̄r', dash: [2, 4] });
            var hs = _fin(pd) ? [{ key: 'pd', kind: 'pointX', value: X(pd), min: X(200), max: X(pMax), step: 10, label: 'dew point', color: T.accent, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } }] : [];
            V.chart(cv, { key: 'rv' + (_metric() ? 'm' : 'i'), aspect: 0.6, minH: 210, maxH: 340, w: 520, readout: 'x',
                x: { label: 'Pressure (' + _lab('pressure', 'psia') + ')', min: 0, max: X(pMax), short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
                y: { label: 'Condensate (' + _lab('cgr', 'STB/MMscf') + ')', min: 0, short: 'Rv', fmtR: function (v) { return _fmt(v, 2); } },
                series: ser, vlines: vl, handles: hs, onHandle: function (key, v, phase) {
                    if (key !== 'pd') return;
                    var pc = Math.round(_fromDisp(v, 'pressure'));
                    _setCtrl('wp_pdew', pc, true);
                    if (phase === 'end') { _commit('wp_pdew'); return; }
                    var Fp = _call('WTS_wp_fluid.build', Object.assign({}, M.fluid, { rv: Object.assign({}, M.fluid.rv, { pd: pc }) }), { T_F: M.res.T_F });
                    if (Fp && Fp.ok && Fp.rv) { ST.rvPrev = Fp; var keepF = ST.F; ST.F = Fp; try { _drawRv(_rvInfo()); } finally { ST.F = keepF; } }
                }, empty: 'Enter the Rv table to plot the vaporised and free condensate.' });
        }
        if (cv2) {
            var dax = _plots().depth === 'md' ? 'md' : 'tvd', rr = I && I.rows ? I.rows : [];
            var dk = function (x) { return _dv(dax === 'md' ? x.md : x.tvd, 'length'); };
            var s2 = rr.length ? [{ key: 'free', label: 'free condensate', color: T.blue, width: 2.6, pts: rr.filter(function (x) { return _fin(x.free); }).map(function (x) { return [_dv(x.free, 'cgr'), dk(x)]; }) },
                { key: 'cgr', label: 'CGR', color: T.text2, width: 1.2, dash: [4, 4], pts: [[_dv(cgr, 'cgr'), dk(rr[0])], [_dv(cgr, 'cgr'), dk(rr[rr.length - 1])]] }] : [];
            var mk = I && I.deep ? [{ x: _dv(I.deep.free, 'cgr'), y: dk(I.deep), kind: 'diamond', color: T.accent, r: 6, label: 'dew point' }] : [];
            V.chart(cv2, { key: 'rvd:' + dax + (_metric() ? 'm' : 'i'), aspect: 0.62, minH: 230, maxH: 380, w: 520, readout: 'y',
                x: { label: 'Free condensate (' + _lab('cgr', 'STB/MMscf') + ')', min: 0, short: 'free', fmtR: function (v) { return _fmt(v, 2); } },
                y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + _lab('length', 'ft') + ')', invert: true, min: 0, short: 'Depth', fmtR: function (v) { return _depthPair(v, dax); } },
                series: s2, markers: mk, empty: on ? 'The free condensate along the well appears after a solve.' : 'With the modified black oil the free condensate along the well is drawn here.' });
        }
    }

    // emulsion viscosity — μ_em / μo against the water cut, the inversion point handle and the stream's water cut
    function _emulAt() {
        var M = ST.M, F = ST.F, R = ST.R; if (!M || !F || !F.ok || M.fluid.type !== 'oil' || !(M.fluid.wc > 0)) return null;
        var q = R && R.ok && R.op ? R.op.q : F.refQ, pts = [];
        var prof = R && R.ok && R.traverse && R.traverse.profile ? R.traverse.profile.filter(function (x) { return !x.restr; }) : [];
        if (prof.length) [prof[0], prof[prof.length - 1]].forEach(function (x, i) { var a = F.at(x.p, x.t, q); if (a) pts.push({ where: i ? 'bottom' : 'wellhead', md: x.md, tvd: x.tvd, p: x.p, t: x.t, muL: a.muL, mix: a.fo * a.muo + a.fw * a.muw, muo: a.muo, muw: a.muw, fw: a.fw, ratio: a.emulRatio, cont: a.emulCont }); });
        return { q: q, pts: pts };
    }
    function _renderEmul(previewInv) {
        var hk = _byId('wp_emulk'), M = ST.M, F = ST.F, V = G.WTS_wp_view, P = G.WTS_wp_pvtmatch; if (!hk || !M) return;
        if (M.fluid.type !== 'oil') { hk.innerHTML = ''; return; }
        var em = M.fluid.emul || {}, on = !!(F && F.ok && F.emul), A = _emulAt(), k = [];
        if (!(M.fluid.wc > 0)) hk.innerHTML = '<div class="wp-v info">The emulsion viscosity needs a water cut (step ①).</div>';
        else if (!on) hk.innerHTML = '<div class="wp-v info">Liquid viscosity: the volume-weighted oil + water mixture (default). Choose an emulsion model for a stable water-in-oil emulsion.</div>';
        else {
            (A ? A.pts : []).forEach(function (x) { k.push(_kpiHtml(x.where === 'bottom' ? 'Bottom-hole liquid' : 'Wellhead liquid', _fmt(x.muL, x.muL < 10 ? 2 : 1) + ' cp', '×' + _fmt(x.muL / x.mix, 2) + ' the mixture · ' + (x.cont === 'water' ? 'water-continuous' : x.cont === 'oil' ? 'oil-continuous' : 'table') + ' · ' + _u(x.md, 'length', 0, 'ft') + ' MD', x.muL / x.mix > 5 ? 'warn' : 'info')); });
            hk.innerHTML = (k.length ? '<div class="wp-kpis wp-tkpis">' + k.join('') + '</div>' : '') + (em.model !== 'table' ? _vHtml({ st: 'info', t: 'ℹ ' + (em.model === 'woelflin' ? 'Woelflin emulsion curves (chart readings to verify)' : 'Brinkman emulsion') + ' — ' + PROVISIONAL_TXT + '. The volume-weighted mixture stays the default.' }) : '');
        }
        var cv = _byId('wp_cv_emul'); if (!cv || !V || !P) return;
        var T = V.theme(), b = A && A.pts.length ? A.pts[A.pts.length - 1] : null, muo = b ? b.muo : 5, muw = b ? b.muw : 0.5, inv = _fin(previewInv) ? previewInv : (_fin(em.inv) ? em.inv : 0.6);
        var curve = function (spec) { return P.emulCurve(spec, { muo: muo, muw: muw, n: 80 }).map(function (z) { return [100 * z.fw, z.ratio]; }); };
        var ser = [{ key: 'mix', label: 'mixture (default)', color: T.text2, width: 1.4, dash: [4, 4], pts: curve(null) }];
        [['woelflin', 'loose'], ['woelflin', 'medium'], ['woelflin', 'tight'], ['brinkman', null]].forEach(function (c) {
            var sel = on && em.model === c[0] && (c[1] == null || em.tight === c[1]);
            ser.push({ key: c[0] + (c[1] || ''), label: (c[0] === 'woelflin' ? 'Woelflin ' + c[1] : 'Brinkman') + ' (prov.)', color: sel ? T.accent : (c[0] === 'brinkman' ? T.purple : T.blue), width: sel ? 3 : 1.4, dash: sel ? null : [6, 4], pts: curve({ model: c[0], tight: c[1], inv: inv }) });
        });
        var rows = (em.rows || []);
        if (rows.length) ser.push({ key: 'tab', label: 'user table', color: em.model === 'table' ? T.accent : T.green, width: em.model === 'table' ? 3 : 1.6, pts: curve({ model: 'table', rows: rows }) }, { key: 'tabp', label: '', legend: false, kind: 'points', color: T.green, pts: rows.map(function (r) { return [100 * r[0], r[1]]; }) });
        var vl = [{ x: 100 * (M.fluid.wc || 0), color: T.green, label: 'WC', dash: [3, 3] }];
        if (A && A.pts.length) vl.push({ x: 100 * A.pts[A.pts.length - 1].fw, color: T.text2, label: 'in situ', dash: [2, 5] });
        var hs = (em.model === 'woelflin' || em.model === 'brinkman') ? [{ key: 'inv', kind: 'lineX', value: 100 * inv, min: 10, max: 90, step: 1, label: 'inversion', color: T.accent, fmt: function (v) { return _fmt(v, 0) + ' %'; } }] : [];
        V.chart(cv, { key: 'emul' + (_metric() ? 'm' : 'i'), aspect: 0.6, minH: 210, maxH: 340, w: 520, readout: 'x',
            x: { label: 'Water fraction of the liquid (%)', min: 0, max: 100, short: 'water', fmtR: function (v) { return _fmt(v, 1) + ' %'; } },
            y: { label: 'Liquid viscosity / oil viscosity (–)', log: true, short: 'μ ratio', fmtR: function (v) { return '×' + _fmt(v, 2); } },
            series: ser, vlines: vl, handles: hs, hidden: _plots().emulHidden || null, onLegend: function (hid) { _plotsSet({ emulHidden: hid }); },
            onHandle: function (key, v, phase) {
                if (key !== 'inv') return;
                var pc = Math.round(v);
                _setCtrl('wp_emulInv', pc);
                if (phase === 'end') { _commit('wp_emulInv'); return; }
                _renderEmul(pc / 100);
            }, empty: 'No viscosity for these inputs.' });
    }
    function _renderPvtB() { _renderPvtLab(); _renderRv(); _renderEmul(null); }

    // Case summary: the inputs that produced the operating point, always rendered inside #wp_res so the page PDF and the Quick
    // Report carry them whichever step is open (the step input sections are hidden except the active one)
    var CORR_NAME = function (k) { var e = (G.WTS_flowline_corr || {})[k]; return e ? String(e.label || k).replace(/\s*\(.*$/, '') + (e.verified === true ? '' : ' (provisional)') : String(k || ''); };
    function _renderCase() {
        var h = _byId('wp_case'); if (!h) return;
        var M = ST.M; if (!M) { h.innerHTML = ''; return; }
        var rows = [], row = function (l, v) { if (v != null && v !== '') rows.push('<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv">' + _esc(v) + '</span></div>'); };
        var fl = M.fluid, gas = _isGasType(fl.type), TYPE = { oil: 'Oil', gas: 'Dry gas', condensate: 'Gas-condensate', water: 'Water' };
        row('Fluid', (TYPE[fl.type] || fl.type) + (gas ? ' · SG ' + _fmt(fl.sgg, 3) + ' · CGR ' + _u(fl.cgr, 'cgr', 1, 'STB/MMscf') + ' · WGR ' + _u(fl.wgr, 'cgr', 1, 'STB/MMscf')
            : ' · ' + _fmt(fl.api, 1) + ' °API · GOR ' + _u(fl.gor, 'gor', 0, 'scf/STB') + ' · WC ' + _fmt(100 * (fl.wc || 0), 1) + ' %'));
        var cr = fl.corr || {}, isOil = fl.type === 'oil', water = fl.type === 'water' || fl.type === 'waterinj';
        if (!water) row('PVT correlations', (isOil ? 'Pb / Rs ' + _famLabel('rs', cr.rs) + ' · Bo ' + _famLabel('bo', cr.bo) + ' · co ' + _famLabel('co', cr.co) + ' · μod ' + _famLabel('muod', cr.muod) + ' · μo ' + _famLabel('muo', cr.muo) + ' · σ ' + _famLabel('sigma', cr.sigma) + ' · '
            : (fl.cgr > 0 ? 'condensate μod ' + _famLabel('muod', cr.muod) + ' · ' : '')) + 'Z ' + _famLabel('z', cr.z) + ' · μg ' + _famLabel('mug', cr.mug) + (isOil && _fin(fl.pbUser) ? ' · pb shifted to ' + _u(fl.pbUser, 'pressure', 0, 'psia') : '') +
            (ST.F && ST.F.match && ST.F.match.applied ? ' · matched to the lab table' : '') + (ST.F && ST.F.rv ? ' · condensate by the Rv table (provisional)' : '') + (ST.F && ST.F.emul ? ' · emulsion viscosity ' + ST.F.emul.model + (ST.F.emul.model === 'table' ? '' : ' (provisional)') : ''));
        var I = ST.I, mods = _iprModels(), md = mods.filter(function (x) { return x.key === M.res.model; })[0];
        row('Reservoir', 'p̄r ' + _u(M.res.pr, 'pressure', 0, 'psia') + ' · T ' + _u(M.res.T_F, 'temperature', 0, '°F'));
        var par = Object.keys(M.res.params || {}).filter(function (k) { return IP[k] && _fin(+M.res.params[k]) && (!md || md.needs.indexOf(k) !== -1); }).map(function (k) { return k + ' ' + _fmt(+M.res.params[k], 4); }).join(', ');
        row('Inflow model', (md ? md.label : M.res.model) + (par ? ' (' + par + ')' : '') + (I && I.ok && _fin(I.aof) ? ' · AOF ' + (gas ? _u(I.aof / 1000, 'gasRate', 2, 'MMscf/d') : _u(I.aof, 'liquidRate', 0, 'STB/d')) : ''));
        var sv = M.well.survey || [], W = ST.W, stn = W && W.ok && Array.isArray(W.stations) ? W.stations : [], last = stn.length ? stn[stn.length - 1] : null;
        var incMax = stn.reduce(function (a, x) { return _fin(x.inc) && x.inc > a ? x.inc : a; }, 0);
        row('Survey', sv.length + ' stations' + (last ? ' · TD ' + _u(last.md, 'length', 0, 'ft') + ' MD · ' + _u(last.tvd, 'length', 0, 'ft') + ' TVD · departure ' + _u(last.dep || 0, 'length', 0, 'ft') + ' · max. inclination ' + _fmt(incMax, 1) + '°' : ''));
        (M.well.strings || []).forEach(function (st0) { row(String(st0.kind || 'string').replace(/^./, function (c) { return c.toUpperCase(); }), _fmt(_dv(st0.od, 'lengthSmall'), 3) + ' × ' + _fmt(_dv(st0.id, 'lengthSmall'), 3) + ' ' + _lab('lengthSmall', 'in') + ', ' + _u(st0.topMd, 'length', 0, 'ft') + ' – ' + _u(st0.botMd, 'length', 0, 'ft') + ' MD'); });
        var rs = M.well.restrictions || [];
        if (rs.length) row('Restrictions', rs.map(function (r) { return String(r.kind || '') + ' ' + _fmt(_dv(r.id, 'lengthSmall'), 3) + ' ' + _lab('lengthSmall', 'in') + ' at ' + _u(r.md, 'length', 0, 'ft') + ' MD'; }).join('; '));
        var nd = W && W.ok && W.nodes;
        row('Perforations', _u(M.well.perfTopMd, 'length', 0, 'ft') + ' – ' + _u(M.well.perfBotMd, 'length', 0, 'ft') + ' MD; mid ' + _u(nd ? nd.midPerfMd : M.well.midPerfMd, 'length', 0, 'ft') + ' MD' + (nd && _fin(nd.midPerfTvd) ? ' · ' + _u(nd.midPerfTvd, 'length', 0, 'ft') + ' TVD' : ''));
        var ckc = M.surface.choke, ckN = { gilbert: 'Gilbert', ros: 'Ros', baxendell: 'Baxendell', achong: 'Achong', sachdeva: 'Sachdeva et al. (1986), provisional' }[ckc.corr] || String(ckc.corr || 'gilbert');
        row('Wellhead', ckc.present !== false ? 'choke ' + _fmt(ckc.bean64, 0) + '/64 in (' + (gas && ckc.corr !== 'sachdeva' ? 'gas nozzle' : ckN + (ckc.corr !== 'sachdeva' && !gas ? (ckc.subcritical === 'sachdeva' ? ', sub-critical: Sachdeva branch (provisional)' : ', sub-critical: conservative bound') : '')) + ')' : (_fin(M.system.thp_psig) ? 'fixed THP ' + _u(M.system.thp_psig, 'pressureG', 0, 'psig') : 'lowest admissible THP'));
        if (M.lift && M.lift.type === 'gaslift') { var gls = M.lift.gl || {}; row('Lift', 'gas lift ' + (_fin(gls.qinj_Mscfd) && gls.qinj_Mscfd > 0 ? _u(gls.qinj_Mscfd, 'gasRateSmall', 0, 'Mscf/d') : 'off (0)') + ', casing ' + _u(gls.pinj_psig, 'pressureG', 0, 'psig') + ', ΔP valve ' + _u(gls.dpValve, 'pressure', 0, 'psi') + ', SG ' + _fmt(gls.sginj, 2) + (_fin(gls.packerMd) ? ', packer ' + _u(gls.packerMd, 'length', 0, 'ft') + ' MD' : '')); }
        var fls = M.surface.flowline || [];
        row('Surface', 'separator ' + _u(M.surface.psep_psig, 'pressureG', 0, 'psig') + (fls.length ? ' · flowline ' + fls.map(function (f) { return _u(f.len, 'length', 0, 'ft') + ' × ' + _fmt(_dv(f.id, 'lengthSmall'), 3) + ' ' + _lab('lengthSmall', 'in'); }).join(' + ') : ' · no flowline'));
        var R = ST.R, cw = R && R.corr ? R.corr.well : (M.system.corr && M.system.corr.well), cl = R && R.corr ? R.corr.line : (M.system.corr && M.system.corr.line);
        var hx = _hx(R);
        row('Temperature', hx ? (hx.mode === 'enthalpy' ? 'enthalpy balance (J-T, gravity, kinetic; Alves et al. / Hasan & Kabir), THT ' + _u(hx.tht, 'temperature', 0, '°F') + ' (' + _tdS(hx.dT) + ' against the relaxation)' + (hx.layers && hx.layers.length ? ', ' + hx.layers.length + ' U layer(s)' : '') + ', ' : 'relaxation (Ramey / Hasan-Kabir), ') + 'U ' + _u(hx.U, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F') + ' (' + (hx.Ubasis === 'ti' ? 'inside' : 'outside') + ' radius), ' + _fmt(hx.tProd_d, 0) + ' d, k_e ' + _u(hx.ke, 'thermalConductivity', 2, 'Btu/hr·ft·°F') + ', α ' + _fmt(hx.alpha, 3) + ' ft²/hr, A ' + _u(hx.A, 'length', 0, 'ft') + ' · geotherm ' + _u(M.well.geo.surfT_F, 'temperature', 0, '°F') + ' at surface'
            : (_heatAsked(M) ? (M.well.heat.mode === 'enthalpy' ? 'enthalpy balance' : 'relaxation') + ' asked, linear used (no geotherm)' : 'linear, THT ' + (_fin(M.well.heat.tht_F) ? _u(M.well.heat.tht_F, 'temperature', 0, '°F') + (M.well.heat.thtMeasured ? ' measured' : ' estimated') : 'not entered (static geotherm)') + ' → BHT'));
        var srn0 = _secRuns();
        row('Correlations', 'well ' + CORR_NAME(cw || 'bb') + (srn0 ? ' (elsewhere) · sections ' + _secSummary(srn0) : '') + ' · flowline ' + CORR_NAME(cl || 'bb') + ' · node ' + (M.system.node || 'bottom'));
        var srn = _secRuns(); if (srn) row('Per-section correlations', srn.map(function (x) { return CORR_NAME(x.corr) + ' ' + _u(x.mdTop, 'length', 0, 'ft') + '–' + _u(x.mdBot, 'length', 0, 'ft') + ' MD (' + _fmt(_dv(x.tvdTop, 'length'), 0) + '–' + _fmt(_dv(x.tvdBot, 'length'), 0) + ' TVD, ' + _fmt(x.incMin, 0) + '–' + _fmt(x.incMax, 0) + '°)'; }).join('; '));
        var mc = _multOf(M); if (mc.tuned) row('VLP multipliers', 'holdup m_h ' + _fx(mc.hl, 3) + ' · friction m_f ' + _fx(mc.f, 3) + (ST.tune && ST.tune.ok && Math.abs(ST.tune.mult.hl - mc.hl) < 1e-5 && Math.abs(ST.tune.mult.f - mc.f) < 1e-5 ? ' (tuned to ' + (ST.tune.tests || []).join(', ') + ')' : ''));
        h.innerHTML = '<div class="rbox-title">Case summary</div>' + rows.join('');
        _renderStudies();
    }

    // Studies summary (review fix): the A2 results that live in the step sections (gas lift, VLP tuning, the sensitivity heat map,
    // the U fit, the PVT families) summarised inside #wp_res, so the page PDF / PNG and the Quick Report carry them whichever step is
    // open (collectPageReport skips hidden sections). Plain .rbox / .rrow / table.dtable markup; empty when no study was run.
    function _renderStudies() {
        var h = _byId('wp_studies'); if (!h) return;
        var M = ST.M; if (!M) { h.innerHTML = ''; return; }
        var rows = [], row = function (l, v) { if (v != null && v !== '') rows.push('<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv">' + _esc(v) + '</span></div>'); };
        var R = ST.R, qc = ['gasRateSmall', 'Mscf/d'], lc = ['liquidRate', 'STB/d'], rc = _rateCat(), extra = '';
        // PVT families (oil): the selected black-oil family and the spread of the bubble point across the families
        var fl = M.fluid, cr = fl.corr || {};
        if (fl.type === 'oil') {
            var pd = ST.pvtData && ST.pvtData.fam && ST.pvtData.fam.rows ? ST.pvtData.fam : null, okF = pd ? pd.rows.filter(function (r) { return r.ok; }) : [];
            row('PVT family (Pb / Rs / Bo)', _famLabel('rs', cr.rs) + (okF.length > 1 && _fin(pd.spreadPb) ? ' · pb across ' + okF.length + ' families ' + okF.map(function (r) { return _fmt(_dv(r.pb, 'pressure'), 0); }).join(' / ') + ' ' + _lab('pressure', 'psia') + ' (spread ' + _fmt(100 * pd.spreadPb, 0) + ' %)' : ''));
        }
        // B (WP23): the PVT lab match, the modified black oil and the emulsion viscosity
        var ad = fl.lab && fl.lab.adopt && fl.lab.adopt.on ? fl.lab.adopt : null, fmt3 = ST.F && ST.F.ok ? ST.F : null, pmf = ST.pvtm && ST.pvtm.fit && ST.pvtm.fit.ok ? ST.pvtm.fit : null;
        if (fl.type === 'oil' && (ad || pmf)) {
            var mm = ad || pmf.match, ab = function (k, d) { var a = mm.mult[k], b = mm.shift[k]; return _fx(a, 3) + (b ? (b > 0 ? ' + ' : ' − ') + _fx(Math.abs(k === 'rs' ? _dv(b, 'gor') : b), d) : ''); };
            row('PVT lab match' + (ad ? (fmt3 && fmt3.match && fmt3.match.stale ? ' (stored, not applied: other correlations)' : ' (applied)') : ' (not applied)'),
                'Rs ' + ab('rs', 1) + ' · Bo ' + ab('bo', 4) + ' · μo ' + ab('muo', 3) + (_fin(mm.pbFactor) && mm.pbFactor !== 1 ? ' · pb factor ' + _fx(mm.pbFactor, 4) : '') +
                (pmf ? ' · error ' + ['rs', 'bo', 'muo'].filter(function (k) { return pmf.props[k]; }).map(function (k) { return { rs: 'Rs', bo: 'Bo', muo: 'μo' }[k] + ' ' + _mareTxt(pmf.props[k].mareBefore) + ' → ' + _mareTxt(pmf.props[k].mareAfter); }).join(', ') : '') + (ad && ad.edited ? ' · adjusted by hand' : ''));
            var bf = ST.pvtm && ST.pvtm.rank && ST.pvtm.rank.families ? ST.pvtm.rank.families.filter(function (x) { return x.ok; })[0] : null;
            if (bf) row('Best black-oil family against the lab', bf.label + (bf.verified ? '' : ' (provisional)') + ' · mean error ' + _mareTxt(bf.score) + ' (selected ' + _famLabel('rs', cr.rs) + ')');
        }
        if (fmt3 && fmt3.rv) { var RI = _rvInfo(); row('Condensate: modified black oil (provisional)', 'dew point ' + _u(fmt3.rv.pd, 'pressure', 0, 'psia') + (RI && RI.deep ? ' · drop-out from ' + _u(RI.deep.md, 'length', 0, 'ft') + ' MD · ' + _u(RI.deep.tvd, 'length', 0, 'ft') + ' TVD' : (RI && RI.rows.length ? ' · no drop-out in the well' : '')) + (RI && RI.wh && _fin(RI.wh.free) ? ' · free at the wellhead ' + _u(RI.wh.free, 'cgr', 1, 'STB/MMscf') : '')); }
        if (fmt3 && fmt3.emul) { var EA = _emulAt(), EN = { woelflin: 'Woelflin ' + fmt3.emul.tight + ' (chart readings, provisional)', brinkman: 'Brinkman (provisional)', table: 'user table' }[fmt3.emul.model];
            row('Liquid viscosity: emulsion', EN + (fmt3.emul.model !== 'table' ? ', inversion ' + _fmt(100 * fmt3.emul.inv, 0) + ' % water' : '') + (EA && EA.pts.length ? ' · ' + EA.pts.map(function (x) { return x.where + ' ' + _fmt(x.muL, 2) + ' cp (×' + _fmt(x.muL / x.mix, 2) + ')'; }).join(', ') : '')); }
        // temperature model and the U fitted to the test THT
        var hx = _hx(R), uf = ST.ufit;
        row('Temperature model', hx ? (hx.mode === 'enthalpy' ? 'enthalpy balance' : 'relaxation') + ', U ' + _u(hx.U, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F') + ', THT ' + _u(hx.tht, 'temperature', 0, '°F') + (hx.mode === 'enthalpy' ? ' (J-T etc. ' + _tdS(hx.dT) + ')' : '') + ' (provisional)' : (_heatAsked(M) ? (M.well.heat.mode === 'enthalpy' ? 'enthalpy balance' : 'relaxation') + ' asked, linear used' : 'linear'));
        if (uf && uf.ok && _fin(uf.U)) row('U fitted to the test THT', _u(uf.U, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F') + (uf.n > 1 ? ' (geometric mean of ' + uf.n + ' tests)' : '') + (_fin(M.well.heat.U_to) && Math.abs(M.well.heat.U_to / uf.U - 1) < 1e-3 ? ' · applied' : ' · not applied'));
        // gas lift
        var g = ST.gl;
        if (M.lift && M.lift.type === 'gaslift' && R && R.ok && R.lift) row('Gas-lift injection point', _u(R.lift.injMd, 'length', 0, 'ft') + ' MD · ' + _u(R.lift.injTvd, 'length', 0, 'ft') + ' TVD' + (R.lift.atPacker ? ' (packer)' : ' (balance)') + ' at ' + _u(M.lift.gl.qinj_Mscfd, qc[0], 0, qc[1]));
        if (g && g.ok) {
            var st = g.stale ? ' (previous inputs)' : '';
            if (g.optimum) row('Gas-lift optimum' + st, _u(g.optimum.qL, lc[0], 0, lc[1]) + ' at ' + _u(g.optimum.qinj, qc[0], 0, qc[1]) + (g.natural && g.natural.ok ? ' · natural ' + _u(g.natural.qL, lc[0], 0, lc[1]) : ' · no natural flow'));
            if (g.economic && g.economic.rule === 'slope') row('Gas-lift economic point (' + _u(g.incGor, 'gor', 0, 'scf/STB') + ')', _u(g.economic.qL, lc[0], 0, lc[1]) + ' at ' + _u(g.economic.qinj, qc[0], 0, qc[1]));
            if (_fin(g.gain)) row('Gas-lift gain · gas for 90 %', _u(g.gain, lc[0], 0, lc[1]) + (g.gas90 ? ' · ' + _u(g.gas90.qinj, qc[0], 0, qc[1]) : ''));
        }
        // VLP tuning
        var tn = ST.tune, mc = _multOf(M);
        if (tn && tn.ok) {
            var applied = Math.abs(mc.hl - tn.mult.hl) < 1e-5 && Math.abs(mc.f - tn.mult.f) < 1e-5;
            row('VLP tuning (' + CORR_NAME(tn.corr) + ')', 'm_h ' + _fx(tn.mult.hl, 3) + ' · m_f ' + _fx(tn.mult.f, 3) + ' · RMS ' + _fx(_dv(tn.rms.tuned, 'pressure'), 1) + ' ' + _lab('pressure', 'psi') + ' (untuned ' + _u(tn.rms.untuned, 'pressure', 0, 'psi') + ') · ' + (applied ? 'applied' : 'not applied'));
        } else if (mc.tuned) row('VLP multipliers', 'm_h ' + _fx(mc.hl, 3) + ' · m_f ' + _fx(mc.f, 3));
        // sensitivity: the one-variable list, or the two-variable grid as a table (the model cell marked ●)
        var s = ST.sens;
        if (s && s.two && s.grid) {
            var gr = s.grid, l1 = _sensVarLabel(s.key), l2 = _sensVarLabel(s.key2);
            var isB = function (v, b) { return b && _fin(b.value) && b.inList && Math.abs(v - b.value) <= 1e-9 * Math.max(1, Math.abs(b.value)); };
            row('Sensitivity' + (s.stale ? ' (previous inputs)' : ''), l1 + ' × ' + l2 + ', rate in ' + _lab(rc[0], rc[1]) + ' (● = the model)');
            extra = '<div class="wp-tw"><table class="dtable wp-sumgrid" aria-label="Two-variable sensitivity: rate for each pair of values"><thead><tr><th>' + _esc(l2.replace(/ \(.*\)$/, '')) + ' / ' + _esc(l1.replace(/ \(.*\)$/, '')) + '</th>' +
                gr.x.map(function (x, i) { return '<th class="num">' + _esc(_sv(s.key, x, gr.labelsX[i])) + '</th>'; }).join('') + '</tr></thead><tbody>' +
                gr.y.map(function (y, j) {
                    return '<tr><th>' + _esc(_sv(s.key2, y, gr.labelsY[j])) + '</th>' + gr.x.map(function (x, i) {
                        var q = gr.q[j][i], b = isB(x, s.base) && isB(y, s.base2);
                        return '<td class="num">' + (b ? '● ' : '') + (_fin(q) ? _fmt(_dv(q, rc[0]), 0) + (gr.stable[j][i] === false ? ' ✗' : '') : '—') + '</td>';
                    }).join('') + '</tr>';
                }).join('') + '</tbody></table></div>';
        } else if (s && s.cases && s.cases.length) {
            row('Sensitivity' + (s.stale ? ' (previous inputs)' : ''), _sensVarLabel(s.key) + ': ' + s.cases.map(function (c) { var v = +_sensVal(c), Rc = c.R || {}; return (c.label || _fmt(_sensDv(s.key, v), 3)) + ' → ' + (Rc.ok ? _fmt(_dv(Rc.q, rc[0]), 0) : '—'); }).join(' · ') + ' ' + _lab(rc[0], rc[1]));
        }
        var bRows = (ST.I && ST.I.ok && _bKey(ST.I.key)) ? _iprBRows(ST.I) : [];
        bRows.forEach(function (r) { row('Inflow: ' + r[0], r[1]); });
        var nx0 = rows.length;
        _ext('studies').forEach(function (x) { (x.rows || []).forEach(function (r) { row(r[0], r[1]); }); if (x.html) extra += x.html; });
        h.innerHTML = (rows.length > 1 || rows.length > nx0 || extra || (g && g.ok) || (tn && tn.ok) || uf) ? '<div class="rbox-title">Studies and tuning</div>' + rows.join('') + extra : '';
    }

    // Δp breakdown (canvas bars)
    var BD_LABEL = { reservoir: 'Reservoir (drawdown)', completion: 'Completion (skin)', skin: 'Completion (skin)', gravity: 'Tubing gravity', friction: 'Tubing friction', acceleration: 'Tubing acceleration',
                     restrictions: 'Downhole restrictions', choke: 'Surface choke', flowline: 'Flowline', separator: 'Separator', pump: 'ESP (pressure added)' };
    function _renderBreakdown() {
        var cv = _byId('wp_cv_bd'); if (!cv || !cv.getContext) return;
        var V = G.WTS_wp_view, T = V ? V.theme() : {}, R = ST.R, items = (R && R.ok && R.breakdown) ? R.breakdown.filter(function (b) { return _fin(b.dp); }) : [];
        var cw = (cv.clientWidth > 160) ? Math.min(cv.clientWidth, 900) : 420, rowH = 32;
        // the footer sentence wraps to the width (review fix v4.5: it was cut off on the ESP example)
        var tot0 = items.reduce(function (a, b) { return a + Math.max(0, b.dp); }, 0) || 1, foot;
        if (R && R.injector) { var gain0 = items.filter(function (b) { return b.dp < 0; }).reduce(function (a, b) { return a - b.dp; }, 0); foot = 'Injection: THP − p̄r ' + _fmt(_dv(R.surface.thp - R.pr, 'pressure'), 0) + ' ' + _lab('pressure', 'psi') + '; the column adds ' + _fmt(_dv(gain0, 'pressure'), 0) + ' ' + _lab('pressure', 'psi'); }
        else { var pg0 = items.filter(function (b) { return b.key === 'pump'; }).reduce(function (a, b) { return a - b.dp; }, 0); foot = pg0 > 0 ? 'Losses ' + _fmt(_dv(tot0, 'pressure'), 0) + ' ' + _lab('pressure', 'psi') + ' = p̄r − p_sep ' + _fmt(_dv(tot0 - pg0, 'pressure'), 0) + ' ' + _lab('pressure', 'psi') + ' + the pump ' + _fmt(_dv(pg0, 'pressure'), 0) + ' ' + _lab('pressure', 'psi') : 'Total p̄r − p_sep: ' + _fmt(_dv(tot0, 'pressure'), 0) + ' ' + _lab('pressure', 'psi'); }
        var fWords = foot.split(' '), fLines = [], cur = '', maxCh = Math.max(20, Math.floor((cw - 20) / 6.4));
        fWords.forEach(function (wd) { if ((cur + ' ' + wd).trim().length > maxCh && cur) { fLines.push(cur); cur = wd; } else cur = (cur + ' ' + wd).trim(); }); if (cur) fLines.push(cur);
        var ch = Math.max(120, items.length * rowH + 16 + 15 * fLines.length);
        var dpr = Math.min(2, Math.max(1, G.devicePixelRatio || 1));
        cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
        var c = cv.getContext('2d'); if (!c) return;
        if (c.setTransform) c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.fillStyle = T.bg || '#0d1117'; c.fillRect(0, 0, cw, ch);
        c.font = '600 11.5px -apple-system, Segoe UI, Roboto, sans-serif';
        if (!items.length) { c.fillStyle = T.text2 || '#8b949e'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('The pressure losses appear after a solve.', cw / 2, ch / 2); return; }
        var tot = items.reduce(function (a, b) { return a + Math.max(0, b.dp); }, 0) || 1, lw = 10, bw = cw - 20;
        var cols = [T.green, '#2dd4bf', T.blue, '#7dd3fc', T.purple, T.yellow, T.accent, T.red, T.text2];
        items.forEach(function (b, i) {
            var y = 8 + i * rowH, w = Math.max(1.5, bw * Math.abs(b.key === 'pump' ? b.dp : Math.max(0, b.dp)) / tot);
            c.fillStyle = T.text2 || '#8b949e'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
            c.fillText(BD_LABEL[b.key] || b.key, lw, y + 11);
            c.fillStyle = T.text || '#e6edf3'; c.textAlign = 'right';
            c.fillText(b.key === 'pump' ? '+' + _fmt(_dv(-b.dp, 'pressure'), 0) + ' ' + _lab('pressure', 'psi') : _fmt(_dv(b.dp, 'pressure'), 0) + ' ' + _lab('pressure', 'psi') + '  ' + _fmt(100 * b.dp / tot, 0) + ' %', lw + bw, y + 11);
            c.fillStyle = T.panel || '#161b22'; c.fillRect(lw, y + 15, bw, 8);
            c.fillStyle = b.key === 'pump' ? (T.green || '#3fb950') : cols[i % cols.length]; c.fillRect(lw, y + 15, w, 8);
        });
        c.fillStyle = T.text2 || '#8b949e'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        fLines.forEach(function (ln, k) { c.fillText(ln, lw, 8 + items.length * rowH + 14 + 15 * k); });
        cv.setAttribute && cv.setAttribute('data-foot', foot);
        cv.__h2oilSnapshot = null;
    }

    // Verdicts (report-captured ✓ / ⚠ / ✗ lines) + validity
    function _verdicts() {
        var R = ST.R, M = ST.M, out = [], ok = !!(R && R.ok);
        var add = function (st, t) { t = String(t); if (/^[✓⚠✗ℹ]?\s?ESP[: ]/.test(t)) t = _msgU(t); out.push({ st: st, t: t.slice(0, 290) }); };   // ESP engine lines in display units (review fix v4.5)
        if (!M) return out;
        if (!ok) { if (R && !_isStub(R)) add('fail', '✗ No operating point: ' + (((R.errors || [])[0]) || 'the outflow curve lies above the inflow curve.')); return out; }
        var gasW = _isGasType(M.fluid.type), qv = function (q) { return gasW ? _u(q / 1000, 'gasRate', 3, 'MMscf/d') : _u(q, 'liquidRate', 0, 'STB/d'); };
        if (R.injector) {
            var ri = _injRateCat();
            add('ok', '✓ Injecting ' + _u(R.op.q, ri[0], 0, ri[1]) + ' at ' + _u(R.surface.thp_psig, 'pressureG', 0, 'psig') + ' wellhead pressure (bottom hole ' + _u(R.pwf, 'pressure', 0, 'psia') + ').');
            _verdictsB(add);
            var eroI = _eroMax(R); if (_fin(eroI)) add(eroI > 1 ? 'fail' : eroI > 0.8 ? 'warn' : 'ok', (eroI > 1 ? '✗' : eroI > 0.8 ? '⚠' : '✓') + ' Maximum velocity is ' + _fmt(eroI * 100, 0) + ' % of the erosional velocity (C = ' + _fmt(M.system.eroC, 0) + ').');
            return out;
        }
        _verdictsB(add);
        add(R.op.stable ? 'ok' : 'fail', (R.op.stable ? '✓ Stable operating point at ' : '✗ Unstable operating point at ') + qv(R.op.q) + ', ' + _u(R.op.p, 'pressure', 0, 'psia') + '.');
        if (R.qs && _fin(R.qs.q)) {
            var mgq = R.op.q / R.qs.q - 1;
            if (mgq < 0.1) add('warn', '⚠ The operating point is within 10 % of the static stability limit q_s (' + qv(R.qs.q) + '): the well may head or load up.');
            else add('ok', '✓ ' + _fmt(mgq * 100, 0) + ' % above the static stability limit q_s (' + qv(R.qs.q) + ').');
        }
        if (R.vlpMin && _fin(R.vlpMin.q) && R.op.q < R.vlpMin.q && R.op.stable) add('info', 'ℹ The operating point lies left of the tubing-curve minimum (conventional, more conservative rule) while statically stable.');
        var sh = ST.shut;
        if (sh && sh.ok !== false && !_isStub(sh)) {
            // the worst case of the gas-filled and actual-fluid columns is checked against the rating (§4.14)
            var si = _fin(sh.sithp) ? sh.sithp : (_fin(sh.gasFilled) ? sh.gasFilled : sh.actualFluid);
            var both = (_fin(sh.gasFilled) && _fin(sh.actualFluid) && Math.abs(sh.gasFilled - sh.actualFluid) > 0.5) ? ' (gas-filled ' + _u(sh.gasFilled, 'pressureG', 0, 'psig') + ', actual fluid ' + _u(sh.actualFluid, 'pressureG', 0, 'psig') + ')' : '';
            if (sh.rating && _fin(sh.rating.margin)) add(sh.rating.margin < 0 ? 'fail' : (sh.rating.verdict === 'warn' ? 'warn' : 'ok'), (sh.rating.margin < 0 ? '✗' : sh.rating.verdict === 'warn' ? '⚠' : '✓') + ' Shut-in wellhead pressure ' + _u(si, 'pressureG', 0, 'psig') + both + (sh.rating.margin >= 0 ? ' is within' : ' exceeds') + ' the wellhead rating by ' + _u(Math.abs(sh.rating.margin), 'pressure', 0, 'psi') + '.');
            else if (_fin(si)) add('info', 'ℹ Shut-in wellhead pressure up to ' + _u(si, 'pressureG', 0, 'psig') + both + '; enter the wellhead rating to check it.');
        }
        var tmax = M.surface.rating.tht_max_F, tht = R.surface && R.surface.tht;
        if (_fin(tmax) && _fin(tht)) add(tht <= tmax ? 'ok' : 'fail', (tht <= tmax ? '✓' : '✗') + ' Flowing wellhead temperature ' + _u(tht, 'temperature', 0, '°F') + (tht <= tmax ? ' is within' : ' exceeds') + ' the rating ' + _u(tmax, 'temperature', 0, '°F') + '.');
        var L = ST.loading;
        if (L && _fin(L.margin)) add(L.margin < 0 ? 'fail' : L.margin < 0.1 ? 'warn' : 'ok', (L.margin < 0 ? '✗ Liquid loading: the rate is ' + _fmt(-L.margin * 100, 0) + ' % below' : L.margin < 0.1 ? '⚠ Close to loading: only ' + _fmt(L.margin * 100, 0) + ' % above' : '✓ ' + _fmt(L.margin * 100, 0) + ' % above') +
            ' the critical rate' + (_fin(L.qc_MMscfd) ? ' ' + _u(L.qc_MMscfd, 'gasRate', 2, 'MMscf/d') : '') + (L.method ? ' (' + L.method + (L.verified === false ? ', provisional' : '') + ')' : '') + (_fin(L.limitingMd) ? ', limiting at ' + _u(L.limitingMd, 'length', 0, 'ft') + ' MD' + (_fin(L.limitingTvd) ? ' · ' + _u(L.limitingTvd, 'length', 0, 'ft') + ' TVD' : '') : '') + (L.basis === 'tubing' ? ', wellhead to the tubing shoe' : '') + '.');
        if (L && L.belowEot && _fin(L.belowEot.margin) && L.belowEot.margin < 0 && !L.belowEot.inVerdict)
            add('info', 'ℹ Liquid may accumulate below the end of tubing: q_c in the ' + _fmt(_dv(L.belowEot.id, 'lengthSmall'), 3) + ' ' + _lab('lengthSmall', 'in') + ' casing / liner below ' + _u(L.belowEot.fromMd, 'length', 0, 'ft') + ' MD is ' + _u(L.belowEot.qc_MMscfd, 'gasRate', 2, 'MMscf/d') + ' (information; the verdict above is the tubing critical rate).');
        var ero = _eroMax(R), ew = R.velocities && R.velocities.where === 'flowline' ? 'flowline' : 'tubing';
        if (_fin(ero)) add(ero > 1 ? 'fail' : ero > 0.8 ? 'warn' : 'ok', (ero > 1 ? '✗' : ero > 0.8 ? '⚠' : '✓') + ' Maximum velocity is ' + _fmt(ero * 100, 0) + ' % of the erosional velocity (C = ' + _fmt(M.system.eroC, 0) + '), in the ' + ew + '.');
        var sfc = R.surface || {}, thc = _fin(sfc.thtHyd) ? sfc.thtHyd : sfc.tht;
        if (_fin(thc) && _fin(sfc.tHyd)) {
            var hm = thc - sfc.tHyd;
            add(hm < 0 ? 'fail' : hm < 10 ? 'warn' : 'ok', (hm < 0 ? '✗ Hydrate risk at the wellhead: THT is ' : hm < 10 ? '⚠ Hydrate margin only ' : '✓ Hydrate margin ') + _tempDiff(Math.abs(hm)) + (hm < 0 ? ' below the hydrate temperature' : ' at the wellhead') + ' (hydrate ' + _u(sfc.tHyd, 'temperature', 0, '°F') + (_fin(sfc.thtHyd) && _fin(sfc.tht) && Math.abs(sfc.thtHyd - sfc.tht) > 0.05 ? '; THT ' + _u(sfc.thtHyd, 'temperature', 0, '°F') + ' after J-T cooling' : '') + ').');
        }
        if (_fin(sfc.hydMarginDn) && _fin(sfc.tHydDn)) {
            var hd = sfc.hydMarginDn;
            add(hd < 0 ? 'fail' : hd < 10 ? 'warn' : 'ok', (hd < 0 ? '✗ Hydrate risk downstream of the choke: ' : hd < 10 ? '⚠ Hydrate margin downstream of the choke only ' : '✓ Hydrate margin downstream of the choke ') + _tempDiff(Math.abs(hd)) + (hd < 0 ? ' below the hydrate temperature' : '') + ' (' + _u(sfc.tChokeDn, 'temperature', 0, '°F') + ' against ' + _u(sfc.tHydDn, 'temperature', 0, '°F') + ' at ' + _u(sfc.pChokeDn_psig, 'pressureG', 0, 'psig') + ').');
        }
        var mv = _multOf(M);
        if (mv.tuned) add(_tuneBand(mv.hl) === 'warn' || _tuneBand(mv.f) === 'warn' ? 'warn' : 'info', (_tuneBand(mv.hl) === 'warn' || _tuneBand(mv.f) === 'warn' ? '⚠ VLP multipliers outside 0.9–1.1: ' : 'ℹ Tuned VLP: ') + 'holdup m_h ' + _fx(mv.hl, 3) + ', friction m_f ' + _fx(mv.f, 3) + ' on ' + CORR_NAME((R.corr && R.corr.well) || 'bb') + (ST.untuned && ST.untuned.op ? '; untuned the well would make about ' + qv(ST.untuned.op.q) : '') + '.');
        // flags the checks above already state are not repeated
        var hx = _hx(R);
        if (hx && hx.mode === 'enthalpy') {
            var bg = hx.budget;
            add('info', 'ℹ Flowing temperature from the enthalpy balance (Joule-Thomson, gravity and kinetic terms): THT ' + _u(hx.tht, 'temperature', 0, '°F') + ' at this rate, ' + _tdS(hx.dT) + ' against the relaxation' +
                (bg ? ' (J-T ' + _tdS(bg.jt) + ', gravity ' + _tdS(bg.grav) + ')' : '') + '; the hydrate check uses it as it is — provisional, not verified against a published example.');
            if (_fin(hx.passCheck) && hx.passCheck > 1) add('warn', '⚠ The enthalpy profile moves by ' + _tempDiff(hx.passCheck) + ' when re-run on the reported traverse: the predictor pressures differ from the solution (check the step length).');
        }
        if (hx && hx.mode === 'relax') {
            add('info', 'ℹ Flowing temperature from the heat-transfer relaxation (Ramey / Hasan-Kabir): THT ' + _u(hx.tht, 'temperature', 0, '°F') + ' at this rate with U ' + _u(hx.U, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F') + ' and ' + _fmt(hx.tProd_d, 0) + ' d producing — provisional, not verified against a published example.');
            var tm = (M.tests || []).filter(function (t) { return t.use !== false && _fin(+t.tht_F); })[0];
            if (tm && ST.ufit && ST.ufit.ok && _fin(ST.ufit.U) && Math.abs(ST.ufit.U / hx.U - 1) > 0.25) add('warn', '⚠ U ' + _u(hx.U, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F') + ' differs from the U matched to the test THT (' + _u(ST.ufit.U, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F') + '): adopt it in step ③.');
        }
        if (!hx && R.heat && R.heat.fallback) add('warn', '⚠ The ' + (R.heat.enthFallback ? 'enthalpy balance' : 'relaxation model') + ' could not run (it needs a geotherm): the linear THT → BHT profile is used.');
        (R.warnings || []).filter(function (w) { return w && w.code === 'ENTH_FALLBACK'; }).slice(0, 1).forEach(function (w) { add('info', 'ℹ ' + w.msg); });
        var SKIP = { EROSION: 1, HEADING: 1, LEFT_OF_MIN: 1, LOADING: 1, HYDRATE_WH: 1, HYDRATE_DN: 1, HYDRATE_DN_NEAR: 1, PROVISIONAL: 1, PROVISIONAL_TEMP: 1, RELAX_FALLBACK: 1, ENTH_FALLBACK: 1 };
        (R.flags || []).filter(function (f) { return f && f.msg && !SKIP[f.code]; }).slice(0, 6).forEach(function (f) { add(f.sev === 'warn' ? 'warn' : 'info', (f.sev === 'warn' ? '⚠ ' : 'ℹ ') + f.msg); });
        return out;
    }
    function _validity() {
        var c = ST.chk, out = [];
        if (!c || _isStub(c)) return out;
        (c.validity || []).forEach(function (v) {
            if (!v) return;
            var prov = v.provisional || v.verified === false;
            // review fix (v4.5): the provisional label once (a message may carry it already) and the info style for a provisional entry
            var msg = v.msg || (v.corr + (v.inRange === false ? ': outside the data range (extrapolation)' : ': inside the data range'));
            var st = v.inRange === false ? 'warn' : (prov ? 'info' : 'ok');
            out.push({ st: st, t: ((st === 'warn' ? '⚠ ' : st === 'info' ? 'ℹ ' : '✓ ') + msg + (prov && !/provisional/i.test(msg) ? ' — provisional — not verified against a published example.' : '')).slice(0, 290) });
        });
        (c.warnings || []).slice(0, 4).forEach(function (w) { var m = w && (w.msg || w); if (m) out.push({ st: 'warn', t: ('⚠ ' + m).slice(0, 290) }); });
        return out;
    }
    // ✓ / ⚠ / ✗ verdicts carry the app's verdict colour inline (the report / UX convention: color:var(--green|yellow|red))
    var V_COL = { ok: 'green', warn: 'yellow', fail: 'red' };
    function _vHtml(v) { return '<div class="wp-v ' + v.st + '"' + (V_COL[v.st] ? ' style="color:var(--' + V_COL[v.st] + ')"' : '') + '>' + _esc(v.t) + '</div>'; }
    function _renderVerdicts() {
        var h = _byId('wp_verd'); if (h) { var vs = _verdicts(); h.innerHTML = '<div class="rbox-title">Checks</div>' + (vs.length ? vs.map(_vHtml).join('') : '<div class="wp-v info">The checks appear after a solve.</div>'); }
        var hv = _byId('wp_valid'); if (hv) { var va = _validity(); hv.innerHTML = '<div class="rbox-title">Correlation validity</div>' + (va.length ? va.map(_vHtml).join('') : '<div class="wp-v info">The validity ranges of the correlations in use are checked after a solve.</div>'); }
    }

    // ── gas lift (A2, WP18) ───────────────────────────────────────────────────
    // the model identity of a performance curve (the operating injection rate itself does not make the curve stale)
    function _glKey(M) { if (!M) return ''; try { var l = JSON.parse(JSON.stringify(M.lift || {})); if (l.gl) delete l.gl.qinj_Mscfd; return JSON.stringify([M.fluid, M.res, M.well, M.surface, M.system, l]); } catch (e) { return ''; } }
    function _glOn() { var M = ST.M; return !!(M && M.lift && M.lift.type === 'gaslift'); }
    // the performance curve (q_L vs q_inj): natural flow, optimum, economic point, unstable points, the operating injection rate as a
    // draggable line that re-solves the well; the injection depth per point (MD and TVD, depth down) with the packer; the summary
    function _renderGl() { _renderGlBody(); _renderStudies(); }
    function _renderGlBody() {
        var cv = _byId('wp_cv_glpc'), cd = _byId('wp_cv_gldepth'), V = G.WTS_wp_view, M = ST.M, box = _byId('wp_glres'); if (!cv || !V || !M) return;
        var T = V.theme(), g = ST.gl, R = ST.R, ok = !!(R && R.ok), pts = (g && g.points) || [], qc = ['gasRateSmall', 'Mscf/d'], lc = ['liquidRate', 'STB/d'];
        var X = function (q) { return _dv(q, qc[0]); }, Y = function (q) { return _dv(q, lc[0]); };
        var good = pts.filter(function (p) { return p.ok && _fin(p.qL); }), ser = [], mk = [], vl = [];
        var col = g && g.stale ? T.text2 : T.accent;
        ser.push({ key: 'glpc', label: 'Liquid rate with lift gas', stale: !!(g && g.stale), color: col, width: 2.6, dash: g && g.stale ? [3, 4] : null, pts: good.map(function (p) { return [X(p.qinj), Y(p.qL)]; }) });
        ser.push({ key: 'glp', label: '', legend: false, kind: 'points', color: col, pts: good.map(function (p) { return [X(p.qinj), Y(p.qL)]; }) });
        pts.filter(function (p) { return !p.ok || p.stable === false; }).forEach(function (p) { mk.push({ x: X(p.qinj), y: p.ok ? Y(p.qL) : 0, kind: 'hollow', color: T.red, label: p.ok ? 'unstable' : 'no flow' }); });
        if (g && g.natural && g.natural.ok) mk.push({ x: 0, y: Y(g.natural.qL), kind: 'diamond', color: T.green, r: 6, label: 'natural ' + _fmt(Y(g.natural.qL), 0) });
        if (g && g.optimum) mk.push({ x: X(g.optimum.qinj), y: Y(g.optimum.qL), kind: 'filled', color: T.yellow, r: 7, halo: true, label: 'optimum ' + _fmt(Y(g.optimum.qL), 0) + ' ' + _lab(lc[0], lc[1]) });
        if (g && g.economic && g.economic.rule === 'slope' && (!g.optimum || g.economic.qinj !== g.optimum.qinj)) mk.push({ x: X(g.economic.qinj), y: Y(g.economic.qL), kind: 'diamond', color: T.purple, r: 6, label: '' });
        if (g && g.gas90) vl.push({ x: X(g.gas90.qinj), color: T.purple, label: '90 % of the gain', dash: [2, 4] });
        var qOp = _fin(M.lift.gl.qinj_Mscfd) ? M.lift.gl.qinj_Mscfd : 0;
        var atOpt = g && g.optimum && Math.abs(g.optimum.qinj - qOp) < 1;
        if (ok && _glOn() && R.lift) mk.push({ x: X(qOp), y: Y(R.rates.qL), kind: 'filled', color: T.blue, r: 6, label: atOpt ? '' : 'now ' + _fmt(Y(R.rates.qL), 0) });
        var qLTop = Math.max.apply(null, [0].concat(good.map(function (p) { return p.qL; })).concat(ok && R.rates && _fin(R.rates.qL) ? [R.rates.qL] : []));
        var qMax = Math.max(5000, pts.length ? Math.max.apply(null, pts.map(function (p) { return p.qinj; })) : 0, qOp * 1.1);
        var handles = _glOn() ? [{ key: 'qinj', kind: 'lineX', value: X(qOp), min: 0, max: X(qMax), step: _metric() ? 1 : 25, label: 'q_inj', color: T.blue, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab(qc[0], qc[1]); } }] : [];
        V.chart(cv, { key: 'glpc:' + (_metric() ? 'm' : 'i'), aspect: 0.58, minH: 230, maxH: 380, w: 560, readout: 'x',
            x: { label: 'Lift-gas rate q_inj (' + _lab(qc[0], qc[1]) + ')', min: 0, max: X(qMax), short: 'q_inj', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab(qc[0], qc[1]); } },
            y: { label: 'Liquid rate (' + _lab(lc[0], lc[1]) + ')', min: 0, max: qLTop > 0 ? Y(qLTop * 1.3) : undefined, short: 'q_L', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab(lc[0], lc[1]); } },
            series: ser, markers: mk, vlines: vl, handles: handles, onHandle: _onHandle, legendNote: g && g.stale ? STALE_NOTE : null,
            empty: !_glOn() ? 'Choose gas lift to see the performance curve.' : 'Run the gas-lift performance curve (12 points, about 2–4 s).' });
        if (cd) {
            var dax = _plots().depth === 'md' ? 'md' : 'tvd', dk = function (p) { return _dv(dax === 'md' ? p.injMd : p.injTvd, 'length'); }, dp = pts.filter(function (p) { return p.ok && _fin(p.injMd) && p.qinj > 0; });
            var pk = M.lift.gl.packerMd, W = ST.W, pkMd = _fin(pk) ? pk : (W && W.ok && W.nodes && _fin(W.nodes.tubingShoeMd) ? W.nodes.tubingShoeMd : null), pkTvd = _fin(pkMd) ? _tvdAt(pkMd) : null;
            var hl = _fin(pkMd) ? [{ y: _dv(dax === 'md' ? pkMd : (_fin(pkTvd) ? pkTvd : pkMd), 'length'), label: 'packer', color: T.text2, dash: [4, 4] }] : [];
            V.chart(cd, { key: 'gldepth:' + dax, aspect: 0.42, minH: 170, maxH: 260, w: 560, readout: 'x',
                x: { label: 'Lift-gas rate q_inj (' + _lab(qc[0], qc[1]) + ')', min: 0, max: X(qMax), short: 'q_inj' },
                y: { label: 'Injection ' + (dax === 'md' ? 'MD' : 'TVD') + ' (' + _lab('length', 'ft') + ')', invert: true, min: 0, max: hl.length ? hl[0].y * 1.08 : undefined, short: 'depth', fmtR: function (v) { return _depthPair(v, dax); } },
                series: [{ key: 'inj', label: 'Injection depth', color: T.blue, width: 2.2, pts: dp.map(function (p) { return [X(p.qinj), dk(p)]; }) }, { key: 'injp', label: '', legend: false, kind: 'points', color: T.blue, pts: dp.map(function (p) { return [X(p.qinj), dk(p)]; }) }],
                hlines: hl, markers: dp.filter(function (p) { return p.atPacker; }).map(function (p) { return { x: X(p.qinj), y: dk(p), kind: 'diamond', color: T.text2, r: 4 }; }),
                empty: 'The injection depth per rate appears with the performance curve.' });
        }
        if (box) {
            var rows = [], row = function (l, v) { rows.push('<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv">' + _esc(v) + '</span></div>'); };
            if (ok && R.lift) {
                row('Operating point', _u(qOp, qc[0], 0, qc[1]) + ' → ' + _u(R.rates.qL, lc[0], 0, lc[1]));
                row(R.lift.atPacker ? 'Injection point (packer)' : 'Injection point (balance)', _u(R.lift.injMd, 'length', 0, 'ft') + ' MD · ' + _u(R.lift.injTvd, 'length', 0, 'ft') + ' TVD');
                row('Casing / tubing at the point', _u(R.lift.pCas - PATM, 'pressureG', 0, 'psig') + ' / ' + _u(R.lift.pTub - PATM, 'pressureG', 0, 'psig'));
            }
            if (g && g.ok) {
                row('Natural flow', g.natural.ok ? _u(g.natural.qL, lc[0], 0, lc[1]) : 'does not flow');
                if (g.optimum) row('Optimum (maximum rate)', _u(g.optimum.qL, lc[0], 0, lc[1]) + ' at ' + _u(g.optimum.qinj, qc[0], 0, qc[1]));
                if (g.economic && g.economic.rule === 'slope') row('Economic point (' + _u(g.incGor, 'gor', 0, 'scf/STB') + ')', _u(g.economic.qL, lc[0], 0, lc[1]) + ' at ' + _u(g.economic.qinj, qc[0], 0, qc[1]));
                if (_fin(g.gain)) row('Rate gain over natural flow', _u(g.gain, lc[0], 0, lc[1]));
                if (g.gas90) row('Lift gas for 90 % of the gain', _u(g.gas90.qinj, qc[0], 0, qc[1]));
            }
            var warn = g ? (g.warnings || []).map(function (w) { return _vHtml({ st: w.sev === 'info' ? 'info' : 'warn', t: (w.sev === 'info' ? 'ℹ ' : '⚠ ') + w.msg }); }).join('') : '';
            var btns = g && g.optimum && _glOn() ? '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="glopt" data-v="' + g.optimum.qinj + '" data-prov="the optimum">Use the optimum</button>' +
                (g.economic && g.economic.rule === 'slope' && g.economic.qinj !== g.optimum.qinj ? '<button type="button" class="btn btn-secondary" data-act="glopt" data-v="' + g.economic.qinj + '" data-prov="the economic point">Use the economic point</button>' : '') + '</div>' : '';
            box.innerHTML = (g && g.stale ? '<div class="wp-stalechip" role="status">Curve from the previous inputs — re-run the performance curve</div>' : '') +
                (rows.length ? '<div class="rbox"><div class="rbox-title">Gas-lift quick look</div>' + rows.join('') + '</div>' : '') + warn + btns;
        }
    }

    // Two-variable sensitivity (A2, WP16): the rate against the primary variable, one line per value of the second (a colour ramp),
    // hollow markers where a case does not flow or is unstable, the selected heat-map cell as a ringed marker
    // one note under the legend instead of a suffix on every entry (review fix: long entries were cut at the canvas edge at 390 px)
    var STALE_NOTE = 'Faint curves: previous inputs — re-run';
    function _sv(k, v, lab) { return lab ? String(lab) : _fmt(_sensDv(k, v), 3); }
    function _sens2Spec(T) {
        var s = ST.sens, V = G.WTS_wp_view, rc = _rateCat(), g = s.grid, ser = [], mk = [], ny = g.y.length;
        g.y.forEach(function (y, j) {
            var col = V.ramp(ny > 1 ? j / (ny - 1) : 0.5), pts = [];
            g.x.forEach(function (x, i) { if (_fin(g.q[j][i])) pts.push([_sensDv(s.key, x), _dv(g.q[j][i], rc[0])]); });
            ser.push({ key: 'r' + j, label: _sensVarLabel(s.key2).replace(/ \(.*\)$/, '') + ' ' + _sv(s.key2, y, g.labelsY[j]) + (s.unit2 && !g.labelsY[j] ? ' ' + _sensUnit(s.key2, s.unit2) : ''), stale: !!s.stale, color: s.stale ? T.text2 : col, width: 2.2, dash: s.stale ? [2, 4] : null, pts: pts });
            ser.push({ key: 'p' + j, label: '', legend: false, kind: 'points', color: s.stale ? T.text2 : col, r: 3.2, pts: pts });
            g.x.forEach(function (x, i) { if (!_fin(g.q[j][i]) || g.stable[j][i] === false) mk.push({ x: _sensDv(s.key, x), y: _fin(g.q[j][i]) ? _dv(g.q[j][i], rc[0]) : 0, kind: 'hollow', color: T.red, r: 4.5 }); });
        });
        var sel = ST.sensSel;
        if (sel && g.y[sel.j] != null && _fin(g.q[sel.j][sel.i])) mk.push({ x: _sensDv(s.key, g.x[sel.i]), y: _dv(g.q[sel.j][sel.i], rc[0]), kind: 'filled', color: T.accent, r: 7, halo: true, label: _fmt(_dv(g.q[sel.j][sel.i], rc[0]), 0) + ' ' + _lab(rc[0], rc[1]) });
        return { key: 'sens2:' + s.key + ':' + s.key2, aspect: 0.55, minH: 230, maxH: 400, w: 640, readout: 'x',
            x: { label: _sensVarLabel(s.key), short: 'x' }, y: { label: 'Rate (' + _lab(rc[0], rc[1]) + ')', min: 0, short: 'q', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab(rc[0], rc[1]); } },
            series: ser, markers: mk, legendNote: s.stale ? STALE_NOTE : null, empty: 'No case of the two-variable sensitivity flows.' };
    }

    // Choke tab (A2, WP15): the rate through the bean against the pressure ratio y = p2/p1 at the operating THP — the continuous
    // Sachdeva et al. (1986) curve, the critical correlation (valid left of its 0.588), the gas nozzle for gas wells; the critical ratios
    // as vertical lines, the operating point as the marker; the bean handle on the top rail re-solves the well like the system plot
    function _chokeCurve() {
        var R = ST.R, M = ST.M;
        if (!(R && R.ok && !R.tracked && M && M.surface.choke.present !== false)) return ST.ckc && ST.ckc.R === R ? ST.ckc.c : null;
        if (ST.ckc && ST.ckc.R === R) return ST.ckc.c;
        var c = _call('WTS_wp_system.chokeCurve', M, { R: R });
        ST.ckc = { R: R, c: c };
        return c;
    }
    function _chokeSpec(T) {
        var M = ST.M, c = _chokeCurve(), V = G.WTS_wp_view, gas = M && _isGasType(M.fluid.type), rc = gas ? ['gasRateSmall', 'Mscf/d'] : ['liquidRate', 'STB/d'];
        var ok = !!(c && c.ok), ser = [], vl = [], mk = [], handles = [], qTop = 0;
        if (ok) ['sachdeva', 'corr', 'nozzle'].forEach(function (k) { c.series[k].forEach(function (p2) { if (_fin(p2.q) && p2.q > qTop) qTop = p2.q; }); });
        var Y = function (q) { return _dv(q, rc[0]); };
        // the default sub-critical rule (the A1 conservative bound): the regime switches at the correlation's 0.588; the Sachdeva curve
        // is then drawn for comparison only (provisional, D17)
        var bnd = ok && !gas && c.corr !== 'sachdeva' && c.sub !== 'sachdeva' && _fin(c.ycCorr);
        if (ok) {
            if (c.series.sachdeva.length) ser.push({ key: 'sach', label: 'Sachdeva et al. (1986)' + (c.model === 'sachdeva-scaled' ? ', scaled' : '') + ' — provisional' + (bnd ? ', comparison only' : ''), color: T.accent, width: 2.6, pts: c.series.sachdeva.map(function (p) { return [p.y, Y(p.q)]; }) });
            if (c.series.corr.length) ser.push({ key: 'corr', label: String(c.corr || '').replace(/^./, function (x) { return x.toUpperCase(); }) + ' (critical only)', color: T.blue, width: 2, dash: [6, 4], pts: c.series.corr.map(function (p) { return [p.y, Y(p.q)]; }) });
            if (c.series.nozzle.length) ser.push({ key: 'noz', label: 'Isentropic gas nozzle', color: T.blue, width: 2, pts: c.series.nozzle.map(function (p) { return [p.y, Y(p.q)]; }) });
            if (bnd) vl.push({ x: c.ycCorr, color: T.blue, label: 'bound y_c ' + _fmt(c.ycCorr, 3), dash: [3, 3] });
            else if (_fin(c.ycSachdeva)) vl.push({ x: c.ycSachdeva, color: T.accent, label: 'y_c ' + _fmt(c.ycSachdeva, 3), dash: [3, 3] });
            // the correlation's own critical ratio is where its dashed (critical-only) line ends; the gas nozzle's gets a line of its own
            if (_fin(c.ycCorr) && !c.series.sachdeva.length) vl.push({ x: c.ycCorr, color: T.blue, label: 'nozzle y_c ' + _fmt(c.ycCorr, 3), dash: [2, 5] });
            if (c.op && _fin(c.op.y)) mk.push({ x: c.op.y, y: Y(c.op.q), kind: 'filled', color: T.green, r: 7, halo: true, label: _fmt(Y(c.op.q), 0) + ' ' + _lab(rc[0], rc[1]) + ' (' + c.regime + ')' });
        }
        if (M && M.surface.choke.present !== false) handles.push({ key: 'bean', kind: 'railX', value: _fin(M.surface.choke.bean64) ? M.surface.choke.bean64 : 32, min: 8, max: 128, step: 1, label: 'Bean', railLabel: 'BEAN', rail: [0, 1], color: T.accent, fmt: function (v) { return _fmt(v, 0) + '/64"'; } });
        return { key: 'choke:' + rc[0] + (_metric() ? 'm' : 'i'), aspect: 0.58, minH: 240, maxH: 400, w: 640, readout: 'x',
            x: { label: 'Pressure ratio p2/p1 (downstream / upstream, absolute)', min: 0, max: 1, short: 'y', fmtR: function (v) { return _fmt(v, 3); } },
            y: { label: 'Rate through the bean at the operating THP (' + _lab(rc[0], rc[1]) + ')', min: 0, max: qTop > 0 ? Y(qTop * 1.32) : undefined, short: 'q', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab(rc[0], rc[1]); } },
            series: ser, vlines: vl, markers: mk, handles: handles, onHandle: _onHandle,
            bands: ok && _fin(c.ycSachdeva || c.ycCorr) ? [{ x0: 0, x1: bnd ? c.ycCorr : _fin(c.ycSachdeva) ? c.ycSachdeva : c.ycCorr, color: 'rgba(88,166,255,0.06)', label: 'critical' }] : [],
            empty: (M && M.surface.choke.present === false) ? 'No surface choke in line (step ⑤).' : (c && !c.ok && c.errors ? String(c.errors[0]) : 'The choke curve appears after a solve.') };
    }

    // Traverse / loading / choke / sensitivity / bean schedule card
    function _renderTraverseCard() {
        var cv = _byId('wp_cv_tr'), V = G.WTS_wp_view; if (!cv || !V) return;
        var tab = _plots().trTab || 'traverse', T = V.theme(), dax = _plots().depth === 'md' ? 'md' : 'tvd';
        Array.prototype.forEach.call(document.querySelectorAll('#wp_trtabs button'), function (b) { if (b.classList) b.classList.toggle('on', b.getAttribute('data-tab') === tab); b.setAttribute('aria-pressed', b.getAttribute('data-tab') === tab ? 'true' : 'false'); });
        Array.prototype.forEach.call(document.querySelectorAll('#wp_depthseg button'), function (b) { if (b.classList) b.classList.toggle('on', b.getAttribute('data-depth') === dax); });
        var seg = _byId('wp_depthseg'); if (seg && seg.classList) seg.classList.toggle('wp-off', !(tab === 'traverse' || tab === 'loading' || tab === 'corr'));
        var ctb = _byId('wp_corrtbl'); if (ctb && tab !== 'corr' && tab !== 'map') ctb.innerHTML = '';
        if (tab === 'corr' || tab === 'map') {                  // WP12 (A2): correlation comparison / Duns & Ros flow-regime map
            if (tab === 'corr') _renderCorrTab(cv, V, T, dax); else _renderMapTab(cv, V, T);
            var lg = _byId('wp_trleg');
            if (lg) lg.innerHTML = tab === 'corr' ? 'Thick line = the correlation in use; dashed = provisional (no verified published example yet); dots = the Cullender-Smith closed form (gas wells). Hover for the pressure of every correlation at a depth.' : '';
            return;
        }
        var R = ST.R, ok = !!(R && R.ok), dl = _lab('length', 'ft');
        var spec;
        if (tab === 'loading') {
            var L = ST.loading, pd = (L && L.perDepth) || [];
            spec = { key: 'load:' + dax, aspect: 0.62, minH: 240, maxH: 420, w: 640, readout: 'y',
                     x: { label: 'Gas velocity (' + _lab('velocity', 'ft/s') + ')', min: 0, short: 'v' }, y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + dl + ')', invert: true, min: 0, short: 'Depth', fmtR: function (v) { return _depthPair(v, dax); } },
                     series: [{ key: 'vg', label: 'Gas velocity', color: T.blue, pts: pd.map(function (r) { return [_dv(r.vg, 'velocity'), _dv(dax === 'md' ? r.md : (_fin(r.tvd) ? r.tvd : r.md), 'length')]; }) },
                              { key: 'vc', label: 'Critical velocity', color: T.yellow, dash: [6, 4], pts: pd.map(function (r) { return [_dv(r.vc, 'velocity'), _dv(dax === 'md' ? r.md : (_fin(r.tvd) ? r.tvd : r.md), 'length')]; }) }],
                     empty: (ST.M && !_isGasType(ST.M.fluid.type)) ? 'Liquid loading applies to gas and gas-condensate wells.' : 'The loading profile appears after a solve.' };
        } else if (tab === 'choke') {
            spec = _chokeSpec(T);
        } else if (tab === 'sens' && ST.sens && ST.sens.two) {
            spec = _sens2Spec(T);
        } else if (tab === 'sens') {
            var s = ST.sens, cs = (s && s.cases) || [], rc = _rateCat();
            spec = { key: 'sens:' + (s && s.key), aspect: 0.55, minH: 220, maxH: 380, w: 640, readout: 'x',
                     x: { label: _sensVarLabel(s && s.key), short: 'x' }, y: { label: 'Rate (' + _lab(rc[0], rc[1]) + ')', min: 0, short: 'q' },
                     series: [{ key: 'q', label: 'Operating rate', color: T.accent, pts: cs.map(function (c) { return [_sensDv(s.key, +_sensVal(c)), _dv(c.R && c.R.q, rc[0])]; }).filter(function (p) { return _fin(p[0]) && _fin(p[1]); }) },
                              { key: 'qp', label: '', legend: false, kind: 'points', color: T.accent, pts: cs.map(function (c) { return [_sensDv(s.key, +_sensVal(c)), _dv(c.R && c.R.q, rc[0])]; }).filter(function (p) { return _fin(p[0]) && _fin(p[1]); }) }],
                     markers: cs.filter(function (c) { return !(c.R && c.R.ok) || (c.R && c.R.stable === false); }).map(function (c) { return { x: _sensDv(s.key, +_sensVal(c)), y: c.R && c.R.ok ? _dv(c.R.q, rc[0]) : 0, kind: 'hollow', color: T.red, label: c.R && c.R.ok ? 'unstable' : 'no flow' }; }).filter(function (m) { return _fin(m.x); }),
                     empty: 'Run a sensitivity (step ⑤) to see the rate against the parameter.' };
        } else if (tab === 'beans') {
            var bs = (ST.beans && Array.isArray(ST.beans.rows)) ? ST.beans.rows : [], rc2 = _rateCat();
            spec = { key: 'beans', aspect: 0.55, minH: 220, maxH: 380, w: 640, readout: 'x',
                     x: { label: 'Bean (/64 in)', short: 'bean' }, y: { label: 'Rate (' + _lab(rc2[0], rc2[1]) + ')', min: 0, short: 'q' },
                     series: [{ key: 'q', label: 'Rate', color: T.accent, pts: bs.map(function (b) { return [b.bean, _dv(b.q, rc2[0])]; }).filter(function (p) { return _fin(p[1]); }) },
                              { key: 'qp', label: '', legend: false, kind: 'points', color: T.accent, pts: bs.map(function (b) { return [b.bean, _dv(b.q, rc2[0])]; }).filter(function (p) { return _fin(p[1]); }) }],
                     markers: bs.filter(function (b) { return b.stable === false && _fin(b.q); }).map(function (b) { return { x: b.bean, y: _dv(b.q, rc2[0]), kind: 'hollow', color: T.red }; }),
                     empty: 'Run the bean schedule (step ⑤) to see the rate at each bean.' };
        } else {
            var prof = (ok && R.traverse && R.traverse.profile) || [], dk = function (r) { return _dv(dax === 'md' ? r.md : (_fin(r.tvd) ? r.tvd : r.md), 'length'); };
            var hb = [], last = null;
            prof.forEach(function (r, i) {
                var k = V.patternKey(r.pattern);
                if (!last || last.k !== k) { if (last) last.y1 = dk(r); last = { k: k, y0: dk(r), y1: dk(r), color: V.PATTERN_COLORS[k] }; hb.push(last); }
                else last.y1 = dk(r);
                if (i === prof.length - 1) last.y1 = dk(r);
            });
            var hx = ok ? _hx(R) : null, hxE = hx && hx.mode === 'enthalpy';
            var ser = [{ key: 'p', label: 'Pressure', color: T.accent, width: 2.6, pts: prof.map(function (r) { return [_dv(r.p, 'pressure'), dk(r)]; }) },
                       { key: 't', label: hx ? (hxE ? 'Temperature (enthalpy balance)' : 'Temperature (relaxation)') : 'Temperature', color: T.red, axis: 'x2', width: 2.2, pts: prof.map(function (r) { return [_dv(r.t, 'temperature'), dk(r)]; }) }];
            // B (WP22): the relaxation profile without the J-T, gravity and kinetic terms, so their effect reads as the gap between the two
            if (hxE && prof.some(function (r) { return _fin(r.tRelax); })) ser.push({ key: 'trx', label: 'Relaxation (no J-T)', color: T.red, axis: 'x2', dash: [3, 3], width: 1.3, pts: prof.filter(function (r) { return _fin(r.tRelax); }).map(function (r) { return [_dv(r.tRelax, 'temperature'), dk(r)]; }) });
            // the static earth temperature (geotherm on TVD) and, in the relaxation mode, the linear A1 profile for comparison and the
            // measured test THTs at the wellhead (A2, WP14)
            if (prof.some(function (r) { return _fin(r.te); })) ser.push({ key: 'te', label: 'Earth (geotherm)', color: T.yellow, axis: 'x2', dash: [2, 4], width: 1.6, pts: prof.filter(function (r) { return _fin(r.te); }).map(function (r) { return [_dv(r.te, 'temperature'), dk(r)]; }) });
            var thtIn = ST.M && ST.M.well.heat.tht_F, bhtIn = ST.W && ST.W.ok ? ST.W.bht : null, midIn = ST.W && ST.W.ok && ST.W.nodes ? ST.W.nodes.midPerfMd : null;
            if (hx && _fin(thtIn) && _fin(bhtIn) && _fin(midIn) && prof.length) ser.push({ key: 'tl', label: 'Linear THT → BHT', color: T.text2, axis: 'x2', dash: [6, 5], width: 1.2, pts: prof.map(function (r) { return [_dv(thtIn + (bhtIn - thtIn) * Math.min(1, Math.max(0, r.md / midIn)), 'temperature'), dk(r)]; }) });
            var tt = (ST.M && ST.M.tests || []).filter(function (t) { return t.use !== false && _fin(+t.tht_F); });
            if (hx && tt.length) ser.push({ key: 'tt', label: 'Test THT', kind: 'points', color: T.purple, axis: 'x2', r: 5, pts: tt.map(function (t) { return [_dv(+t.tht_F, 'temperature'), 0]; }) });
            var URt = ok && _multOf(ST.M).tuned && ST.untuned && ST.untuned.traverse;
            if (URt) ser.push({ key: 'pu', label: 'Pressure — untuned (m = 1)', color: T.text2, width: 1.5, dash: [7, 4], pts: URt.map(function (r) { return [_dv(r.p, 'pressure'), dk(r)]; }) });
            if (prof.some(function (r) { return _fin(r.tHyd); })) ser.push({ key: 'thyd', label: 'Hydrate temperature', color: T.blue, axis: 'x2', dash: [5, 4], width: 1.6, pts: prof.filter(function (r) { return _fin(r.tHyd); }).map(function (r) { return [_dv(r.tHyd, 'temperature'), dk(r)]; }) });
            // gas lift (A2): the casing gas column and the injection point on the traverse; the packer depth on the right rail
            var gl = ok && R.lift && R.lift.type === 'gaslift' ? R.lift : null, trH = [], trHl = [];
            if (gl) {
                ser.push({ key: 'cas', label: 'Casing (lift gas)', color: T.purple, width: 2, dash: [9, 4], pts: (gl.casing || []).map(function (r) { return [_dv(r.p, 'pressure'), _dv(dax === 'md' ? r.md : r.tvd, 'length')]; }) });
                if (_fin(gl.injMd)) {
                    trHl.push({ y: _dv(dax === 'md' ? gl.injMd : gl.injTvd, 'length'), label: 'injection ' + _u(gl.injMd, 'length', 0, 'ft') + ' MD · ' + _u(gl.injTvd, 'length', 0, 'ft') + ' TVD', color: T.purple, dash: [2, 3] });
                    ser.push({ key: 'injpt', label: '', legend: false, kind: 'points', color: T.purple, r: 5, pts: [[_dv(gl.pTub, 'pressure'), _dv(dax === 'md' ? gl.injMd : gl.injTvd, 'length')], [_dv(gl.pCas, 'pressure'), _dv(dax === 'md' ? gl.injMd : gl.injTvd, 'length')]] });
                }
                if (_fin(gl.packerMd)) trH.push({ key: 'packer', kind: 'railY', value: _dv(dax === 'md' ? gl.packerMd : (_fin(gl.packerTvd) ? gl.packerTvd : gl.packerMd), 'length'), min: 0, max: _dv(dax === 'md' ? gl.packerMd * 1.5 + 1000 : (gl.packerTvd || gl.packerMd) * 1.5 + 1000, 'length'), step: _metric() ? 5 : 10, label: 'Packer', railLabel: 'PKR', color: T.text2, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab('length', 'ft') + ' ' + (dax === 'md' ? 'MD' : 'TVD'); } });
            }
            // v4.5 WP21: per-section correlations — a line at each change of correlation (MD · TVD, the correlation below) and a knob on
            // the right rail for each MD-interval end inside the path (drag: the boundary moves and the well re-solves live)
            var sruns = ok ? _secRuns() : null;
            if (sruns) {
                var mdEnd = prof.length ? prof[prof.length - 1].md : 0, knobAt = {};
                _secRows(ST.M).forEach(function (r) { if (r.by === 'md') [r.from, r.to].forEach(function (v) { if (_fin(v) && v > 0 && v < mdEnd) knobAt[Math.round(v)] = 1; }); });
                // a boundary with a knob is named by the knob (no second label on the line)
                sruns.forEach(function (x, j) { if (j === 0) return; trHl.push({ y: _dv(dax === 'md' ? x.mdTop : x.tvdTop, 'length'), label: (knobAt[Math.round(x.mdTop)] || _phone()) ? '' : '↓ ' + _corrShort(x.corr) + ' from ' + _u(x.mdTop, 'length', 0, 'ft') + ' MD · ' + _u(x.tvdTop, 'length', 0, 'ft') + ' TVD', color: _corrCol(x.corr), dash: [6, 3] }); });
                _secRows(ST.M).forEach(function (r, i) {
                    if (r.by !== 'md' || trH.length >= 4) return;
                    [['f', r.from], ['t', r.to]].forEach(function (e2) {
                        if (!_fin(e2[1]) || e2[1] <= 0 || e2[1] >= mdEnd || trH.length >= 4) return;
                        var yv = dax === 'md' ? e2[1] : _tvdAt(e2[1]);
                        if (!_fin(yv)) return;
                        trH.push({ key: 'sec' + i + e2[0], kind: 'railY', value: _dv(yv, 'length'), min: 0, max: _dv(dax === 'md' ? mdEnd : (_tvdAt(mdEnd) || mdEnd), 'length'), step: _metric() ? 3 : 10,
                            label: _corrShort(r.corr) + (e2[0] === 'f' ? ' top' : ' bottom'), railLabel: 'SEC', color: _corrCol(r.corr),
                            fmt: function (v2) { var d2 = _fromDisp(v2, 'length'), mdv = dax === 'md' ? d2 : _mdFromTvd(d2), tv = _tvdAt(_fin(mdv) ? mdv : d2); return _fmt(_dv(_fin(mdv) ? mdv : d2, 'length'), 0) + ' MD' + (_phone() ? '' : ' · ' + (_fin(tv) ? _fmt(_dv(tv, 'length'), 0) : '—') + ' TVD') + ' ' + _lab('length', 'ft'); } });
                    });
                });
            }
            _ext('trPlot', { series: ser, hlines: trHl, dax: dax, T: T });     // B (WP25): gas-lift valves and a flowing gradient survey on the traverse
            var gp = (ST.M && ST.M.tests || []).filter(function (t) { return t.use !== false && _fin(t.gaugeMd) && _fin(t.gauge_psia); });
            if (gp.length && ST.SC && ST.SC.trajectory) ser.push({ key: 'g', label: 'Gauge (tests)', kind: 'points', color: T.green, r: 5, pts: gp.map(function (t) { return [_dv(t.gauge_psia, 'pressure'), _dv(dax === 'md' ? t.gaugeMd : (_fin(_schAt(t.gaugeMd).tvd) ? _schAt(t.gaugeMd).tvd : t.gaugeMd), 'length')]; }) });
            spec = { key: 'trav:' + dax + (_metric() ? 'm' : 'i'), aspect: 0.62, minH: 260, maxH: 440, w: 640, readout: 'y',
                     x: { label: 'Pressure (' + _lab('pressure', 'psia') + ')', short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
                     x2: { label: 'Temperature (' + _lab('temperature', '°F') + ')', fmtR: function (v) { return _fmt(v, 1) + ' ' + _lab('temperature', '°F'); } },
                     y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + dl + ')', invert: true, min: 0, short: 'Depth', fmtR: function (v) { return _depthPair(v, dax); } },
                     series: ser, hbands: hb.map(function (b) { return { y0: b.y0, y1: b.y1, color: b.color }; }), hlines: trHl, handles: trH, onHandle: _onHandle,
                     hidden: _plots().trHidden || null, onLegend: function (hid) { _plotsSet({ trHidden: hid }); },
                     empty: 'The pressure and temperature traverse appears after a solve.' };
            if (hx) {
                // drag U and the producing time on the top rails: the relaxation profile, the THT and the operating point re-solve live
                spec.key += ':relax';
                spec.handles = [
                    { key: 'hU', kind: 'railX', value: Math.log(Math.max(0.05, Math.min(200, hx.U))) / Math.LN10, min: Math.log(0.1) / Math.LN10, max: Math.log(100) / Math.LN10, step: 0.02, label: 'U', railLabel: 'U', rail: [0, 0.5], color: T.red,
                      fmt: function (v) { return _u(Math.pow(10, v), 'heatTransferCoef', Math.pow(10, v) < 10 ? 2 : 1, 'Btu/hr·ft²·°F'); } },
                    { key: 'hT', kind: 'railX', value: Math.log(Math.max(0.1, Math.min(3650, hx.tProd_d))) / Math.LN10, min: Math.log(0.1) / Math.LN10, max: Math.log(3650) / Math.LN10, step: 0.02, label: 'Time', railLabel: 'TIME', rail: [0.5, 1], color: T.yellow,
                      fmt: function (v) { var d = Math.pow(10, v); return d < 1 ? _fmt(d * 24, 0) + ' h' : _fmt(d, d < 10 ? 1 : 0) + ' d'; } }];
                // a phone-width chart has room for one rail: U across the full width (the producing time stays a step ③ input)
                if (_phone()) { spec.handles = spec.handles.slice(0, 1); spec.handles[0].rail = [0, 1]; }
                spec.handles = spec.handles.concat(trH.filter(function (h) { return /^sec/.test(h.key); }));      // the section knobs stay (WP21)
                spec.onHandle = _onHandle;
            }
        }
        V.chart(cv, spec);
        var leg = _byId('wp_trleg');
        if (leg) {
            if (tab === 'traverse') {
                var seen = {}, items = [];
                ((ok && R.traverse && R.traverse.profile) || []).forEach(function (r) { var k = V.patternKey(r.pattern); if (!seen[k]) { seen[k] = 1; items.push(k); } });
                leg.innerHTML = (items.length ? 'Flow pattern (left strip): ' + items.map(function (k) { return '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + V.PATTERN_COLORS[k] + ';margin:0 4px 0 8px;vertical-align:-1px"></span>' + _esc(k); }).join('') : '') +
                    (ok && R.heat && R.heat.mode === 'enthalpy' ? '<div class="wp-relaxleg">Enthalpy balance: THT ' + _esc(_u(R.heat.tht, 'temperature', 1, '°F')) + ', ' + _esc(_tdS(R.heat.dT)) + ' against the relaxation' +
                        (R.heat.budget ? ' (J-T ' + _esc(_tdS(R.heat.budget.jt)) + ', gravity ' + _esc(_tdS(R.heat.budget.grav)) + ', kinetic ' + _esc(_tdS(R.heat.budget.kin)) + ')' : '') +
                        ' · mixture J-T η ' + _esc(_eta(R.heat.eta.bottom)) + ' at the perforations → ' + _esc(_eta(R.heat.eta.top)) + ' at the wellhead · A ' + _esc(_u(R.heat.A, 'length', 0, 'ft')) + ' along the hole' +
                        (R.heat.layers && R.heat.layers.length ? ' · ' + R.heat.layers.length + ' U layer(s)' : '') + ' <span class="wp-chip prov">provisional</span><span class="rp-skip"> — drag <b>U</b> and <b>TIME</b> on the top rails.</span></div>' : '') +
                    (ok && R.heat && R.heat.mode === 'relax' ? '<div class="wp-relaxleg">Relaxation: A ' + _esc(_u(R.heat.A, 'length', 0, 'ft')) + ' along the hole · f(t_D) ' + _esc(_fmt(R.heat.fTD, 2)) + ' · w ' + _esc(_fmt(R.heat.w, 0)) + ' lbm/hr · c_p ' + _esc(_u(R.heat.cp, 'specificHeat', 3, 'Btu/lb·°F')) +
                        ' · at the wellhead the fluid is ' + _esc(_tempDiff(R.heat.tht - R.heat.teTop)) + ' above the earth (limit far from the inlet g_G·A·sinθ ' + _esc(_tempDiff(R.heat.offsetTop)) + ') <span class="wp-chip prov">provisional</span><span class="rp-skip"> — drag <b>U</b> and <b>TIME</b> on the top rails.</span></div>' : '');
            } else leg.innerHTML = '';
        }
    }
    // ── WP12 (A2): the correlations compared at the operating point, and the Duns & Ros flow-regime map (traverse-card tabs) ──
    // "Correlations": every applicable well correlation marched down from the solved wellhead pressure at the operating rate with
    // the system engine's own evaluation (WTS_wp_system.evalAt: same fluid table, same surveyed path, hydrostatic on TVD and friction
    // on MD), the dry-gas closed forms (average T-Z and Cullender-Smith) as cross-check points for gas wells, a table with the BHP of
    // each, its difference from the selected correlation and the gravity / friction split, a "Use" button per row, and on a button the
    // operating point of each correlation (a Job of warm tracking solves) drawn as diamonds on the system plot. Computed when the tab
    // is opened and cached per solve (≈ 1 evaluation per correlation).
    // "Flow-regime map": the operating-point traverse of the selected correlation placed on the Ros map (N_Lv, N_gv; WTS_wp_vlp.drMap)
    // with the region boundaries at the median N_d; hover a station for its MD / TVD, groups and region.
    var CORR_SHORT = { bb: 'B&B', hb: 'H&B', gray: 'Gray', nsl: 'No-slip', dr: 'D&R', gasTZ: 'T-Z', gasCS: 'C-S', single: '1-phase', ork: 'Ork', agf: 'AGF', mb: 'M&B', ansari: 'Ansari', hk: 'H&K', __sec: 'Per-section' };
    var CORR_SHORT_L = { bb: 'Beggs & Brill', hb: 'Hagedorn & Brown', gray: 'Gray', nsl: 'No-slip', dr: 'Duns & Ros', gasTZ: 'Average T-Z (gas)', gasCS: 'Cullender-Smith (gas)', single: 'Single phase',
        ork: 'Orkiszewski', agf: 'Aziz-Govier-Fogarasi', mb: 'Mukherjee-Brill', ansari: 'Ansari (mechanistic)', hk: 'Hasan-Kabir (drift flux)' };
    function _corrShortL(k) { return CORR_SHORT_L[k] || String(_corrLabel(k) || k || '').replace(/\s*\(.*$/, ''); }
    // one stable colour per correlation key (the schematic section band, the section bar and the boundary labels)
    var CORR_COL = { bb: '#f0883e', hb: '#58a6ff', gray: '#bc8cff', nsl: '#8b949e', single: '#8b949e', dr: '#3fb950', gasTZ: '#d29922', gasCS: '#e6edf3', ork: '#39c5cf', agf: '#ff7b72', mb: '#d2a8ff', ansari: '#7ee787', hk: '#ffa657' };
    function _corrCol(k) { return CORR_COL[k] || '#6e7681'; }
    var REGION_TXT = { I: 'Region I — bubble / plug', II: 'Region II — slug', transition: 'Transition', III: 'Region III — mist', single: 'Single phase' };
    var REGION_PAT = { I: 'bubble', II: 'slug', transition: 'transition', III: 'mist', single: 'single' };
    function _corrShort(k) { return CORR_SHORT[k] || String(k).slice(0, 8); }
    function _corrPal(T) { return [T.accent, T.blue, T.purple, T.green, T.yellow, T.red, '#39c5cf', T.text2, '#ff7b72', '#d2a8ff', '#7ee787', '#ffa657', '#79c0ff', '#f778ba']; }
    function _corrLabel(k) { var e = (G.WTS_flowline_corr || {})[k]; return (e && e.label) || k; }
    function _gasOnlyCorr(e) { return !!(e && (e.key === 'gasTZ' || e.key === 'gasCS' || (e.range && e.range.note === 'gas only'))); }
    function _cmpSet(M) {
        var V = G.WTS_wp_vlp, gas = _isGasType(M.fluid.type), out = [];
        ((V && typeof V.list === 'function') ? V.list() : []).forEach(function (e) { var k = e.kind || 'any'; if (k === 'any' || k === 'well' || (gas && k === 'gas')) out.push(e); });
        return out;
    }
    function _selCorr() { var R = ST.R, M = ST.M; return (R && R.corr && R.corr.well) || (M && M.system.corr && M.system.corr.well) || 'bb'; }
    function _cmpKey() { var R = ST.R; return (ST.lastKey || '') + '|' + (R && R.op ? R.op.q : ''); }
    function _decim(prof, n) {
        var a = (prof || []).filter(function (r) { return !r.restr && _fin(r.p); }), step = Math.max(1, Math.ceil(a.length / (n || 90))), out = [];
        for (var i = 0; i < a.length; i += step) out.push({ md: a[i].md, tvd: a[i].tvd, p: a[i].p });
        if (a.length && out[out.length - 1].md !== a[a.length - 1].md) out.push({ md: a[a.length - 1].md, tvd: a[a.length - 1].tvd, p: a[a.length - 1].p });
        return out;
    }
    // the flow-pattern runs of a traverse along MD (top → bottom) and their strip (an inline SVG: MD left → right; the per-section row
    // carries the correlation runs as a thin bar above its patterns)
    function _patRuns(prof) {
        var V = G.WTS_wp_view, out = [];
        (prof || []).forEach(function (r) {
            if (r.restr || !_fin(r.md)) return;
            var k = V ? V.patternKey(r.pattern) : String(r.pattern || ''), l = out[out.length - 1];
            if (l && l.k === k) l.b = r.md; else out.push({ a: l ? l.b : r.md, b: r.md, k: k });
        });
        return out.filter(function (x) { return x.b > x.a; });
    }
    function _patStrip(r) {
        var V = G.WTS_wp_view, pr = r.pruns || [];
        if (!V || !pr.length) return '';
        var a0 = pr[0].a, z = pr[pr.length - 1].b, span = (z - a0) || 1, top = r.cruns && r.cruns.length ? 5 : 0, g = '', tip = [];
        (r.cruns || []).forEach(function (c) { g += '<rect x="' + (100 * (c.a - a0) / span).toFixed(2) + '" y="0" width="' + Math.max(0.4, 100 * (c.b - c.a) / span).toFixed(2) + '" height="4" fill="' + _corrCol(c.k) + '"/>'; });
        pr.forEach(function (x) {
            g += '<rect x="' + (100 * (x.a - a0) / span).toFixed(2) + '" y="' + top + '" width="' + Math.max(0.4, 100 * (x.b - x.a) / span).toFixed(2) + '" height="' + (16 - top) + '" fill="' + (V.PATTERN_COLORS[x.k] || '#6e7681') + '"/>';
            tip.push(x.k + ' ' + _fmt(_dv(x.a, 'length'), 0) + '–' + _fmt(_dv(x.b, 'length'), 0) + ' ' + _lab('length', 'ft') + ' MD');
        });
        return '<svg class="wp-pstrip" viewBox="0 0 100 16" preserveAspectRatio="none" role="img" aria-label="' + _esc('Flow pattern along the well: ' + tip.join('; ')) + '"><title>' + _esc(tip.join('\n')) + '</title>' + g + '</svg>';
    }
    function _corrCmp() {
        var R = ST.R, M = ST.M; if (!(R && R.ok && R.op && R.traverse && R.traverse.ok && M)) return null;
        var key = _cmpKey();
        if (ST.cmp && ST.cmp.key === key) return ST.cmp;
        var sel0 = _selCorr(), q = R.op.q, thp = R.traverse.pTop, rows = [], t0 = _now();
        // v4.5 WP21: with per-section correlations in use the solve's own traverse is the "Per-section" row and every correlation row is
        // marched pure (one correlation over the whole path)
        var secRuns = (R.traverse.sections && R.traverse.sections.length) ? R.traverse.sections : null, sel = secRuns ? '__sec' : sel0;
        if (secRuns) {
            var dE = 0, dFs = 0, dAs = 0, pz = {}; (R.traverse.segments || []).forEach(function (s0) { dE += +s0.dpEl || 0; dFs += +s0.dpF || 0; dAs += +s0.dpAcc || 0; });
            R.traverse.profile.forEach(function (p0) { if (p0.pattern) pz[p0.pattern] = (pz[p0.pattern] || 0) + 1; });
            rows.push({ key: '__sec', label: 'Per-section correlations (in use)', verified: secRuns.every(function (x) { return x.verified; }), vertical: false, gasOnly: false, sel: true,
                pwf: R.traverse.pEnd, dpEl: dE, dpF: dFs, dpAcc: dAs, patterns: Object.keys(pz).sort(function (a, b) { return pz[b] - pz[a]; }).slice(0, 2),
                profile: _decim(R.traverse.profile, 90), pruns: _patRuns(R.traverse.profile), cruns: secRuns.map(function (x) { return { a: x.mdTop, b: x.mdBot, k: x.corr }; }), err: null });
        }
        _cmpSet(M).forEach(function (e) {
            var tr = null, err = null;
            if (e.key === sel) tr = R.traverse;
            else {
                var Mc = JSON.parse(JSON.stringify(M)); Mc.system.corr.well = e.key; Mc.system.node = 'bottom'; Mc.system.corr.sections = [];
                var r = _call('WTS_wp_system.evalAt', Mc, q);
                if (r && r.tr && r.tr.ok) tr = r.tr; else err = (r && ((r.errors || [])[0] || (r.lost && 'the traverse is lost (' + r.lost.reason + ')'))) || 'no traverse';
            }
            var dEl = 0, dF = 0, dA = 0;
            if (tr) (tr.segments || []).forEach(function (s) { dEl += +s.dpEl || 0; dF += +s.dpF || 0; dA += +s.dpAcc || 0; });
            var pats = {}; if (tr) tr.profile.forEach(function (p) { if (p.pattern) pats[p.pattern] = (pats[p.pattern] || 0) + 1; });
            rows.push({ key: e.key, label: e.label, verified: e.verified === true, vertical: !!e.vertical, gasOnly: _gasOnlyCorr(e), sel: e.key === sel,
                pwf: tr ? tr.pEnd : null, dpEl: tr ? dEl : null, dpF: tr ? dF : null, dpAcc: tr ? dA : null, patterns: Object.keys(pats).sort(function (a, b) { return pats[b] - pats[a]; }).slice(0, 2),
                profile: tr ? _decim(tr.profile, 90) : [], pruns: tr ? _patRuns(tr.profile) : [], err: err });
        });
        var selRow = rows.filter(function (r) { return r.sel; })[0], pSel = selRow && _fin(selRow.pwf) ? selRow.pwf : null;
        rows.forEach(function (r) { r.dp = (_fin(r.pwf) && _fin(pSel)) ? r.pwf - pSel : null; r.dpPct = (_fin(r.dp) && pSel > 0) ? 100 * r.dp / (pSel - thp) : null; });
        var multi = rows.filter(function (r) { return !r.gasOnly && _fin(r.pwf); }).map(function (r) { return r.pwf; });
        var cf = null;
        if (_isGasType(M.fluid.type) && ST.F && ST.F.ok && ST.W && ST.W.ok) {
            var tz = _call('WTS_wp_vlp.gasDry', ST.F, ST.W, q, { from: 'top', p0: thp }), cs = _call('WTS_wp_vlp.gasDry', ST.F, ST.W, q, { from: 'top', p0: thp, method: 'cs' });
            cf = { tz: tz && tz.ok ? { pwf: tz.pwf, segs: tz.segments } : null, cs: cs && cs.ok ? { pwf: cs.pwf, stations: cs.stations } : null };
        }
        ST.cmp = { key: key, q: q, thp: thp, sel: sel, pSel: pSel, rows: rows, cf: cf, spread: multi.length > 1 ? Math.max.apply(null, multi) - Math.min.apply(null, multi) : null,
            spreadPct: (multi.length > 1 && pSel > thp) ? 100 * (Math.max.apply(null, multi) - Math.min.apply(null, multi)) / (pSel - thp) : null, ms: _now() - t0 };
        if (!(ST.cmpOp && ST.cmpOp.key === key)) ST.cmpOp = null;
        return ST.cmp;
    }
    // the operating point of every correlation: a Job of warm tracking solves (≈ 5 evaluations each) from the current operating point
    function _corrOpJob() {
        var R = ST.R, M = ST.M, C = _corrCmp(); if (!C) return null;
        var list = C.rows.filter(function (r) { return !r.sel && r.key !== '__sec'; }).map(function (r) { return r.key; }), i = 0, out = {};
        out[C.sel] = { ok: true, q: R.op.q, p: R.op.p, stable: R.op.stable !== false };
        return {
            step: function () {
                if (i < list.length) {
                    var k = list[i++], Mc = JSON.parse(JSON.stringify(M)); Mc.system.corr.well = k; Mc.system.corr.sections = [];
                    var r = _call('WTS_wp_system.solve', Mc, { track: { q: R.op.q, slope: R.op.dDdq } });
                    out[k] = (r && r.ok && r.op) ? { ok: true, q: r.op.q, p: r.op.p, stable: r.op.stable !== false } : { ok: false, msg: (r && ((r.errors || [])[0] || r.code)) || 'no operating point' };
                }
                return { done: i >= list.length, progress: list.length ? i / list.length : 1, label: i < list.length ? _corrShort(list[i]) + ' (' + (i + 1) + ' of ' + list.length + ')' : 'done' };
            },
            done: function () { return i >= list.length; }, progress: function () { return list.length ? i / list.length : 1; },
            result: function () { return { key: C.key, ops: out }; }
        };
    }
    function _corrOpMarkers(markers, X, Y, T) {
        var C = ST.cmp, O = ST.cmpOp; if (!C || !O || O.key !== _cmpKey()) return;
        var pal = _corrPal(T);
        C.rows.forEach(function (r, i) { var o = O.ops[r.key]; if (!o || !o.ok || r.sel) return; markers.push({ x: X(o.q), y: Y(o.p), kind: 'diamond', color: pal[i % pal.length], r: 5 }); });
    }
    function _renderCorrTab(cv, V, T, dax) {
        var C = _corrCmp(), R = ST.R, M = ST.M, dl = _lab('length', 'ft'), pal = _corrPal(T), ser = [], markers = [];
        var dk = function (r) { return _dv(dax === 'md' ? r.md : (_fin(r.tvd) ? r.tvd : r.md), 'length'); };
        if (C) {
            // a phone-width chart keeps the legend to the selected row (the table below carries every colour)
            var ph = _phone();
            C.rows.forEach(function (r, i) { if (r.profile.length) ser.push({ key: 'c_' + r.key, label: _corrShort(r.key) + (r.sel ? ' (selected)' : '') + (r.verified ? '' : ' · prov.'), legend: !ph || r.sel, color: pal[i % pal.length], width: r.sel ? 3 : 1.7, dash: r.verified ? null : [6, 3], pts: r.profile.map(function (p) { return [_dv(p.p, 'pressure'), dk(p)]; }) }); });
            if (C.cf && C.cf.cs && C.cf.cs.stations) {
                var st = C.cf.cs.stations, stp = Math.max(1, Math.ceil(st.length / 24)), pts = [];
                for (var j = 0; j < st.length; j += stp) pts.push([_dv(st[j].p, 'pressure'), dk(st[j])]);
                pts.push([_dv(st[st.length - 1].p, 'pressure'), dk(st[st.length - 1])]);
                ser.push({ key: 'cf_cs', label: 'Cullender-Smith closed form', legend: !_phone(), kind: 'points', color: T.text, r: 3, pts: pts });
            }
            markers.push({ x: _dv(C.thp, 'pressure'), y: 0, kind: 'filled', color: T.text, r: 5, halo: false });
            var selR = C.rows.filter(function (r) { return r.sel; })[0];
            if (selR && selR.profile.length) { var lp = selR.profile[selR.profile.length - 1]; markers.push({ x: _dv(lp.p, 'pressure'), y: dk(lp), kind: 'filled', color: T.accent, r: 6, label: 'pwf ' + _fmt(_dv(lp.p, 'pressure'), 0) }); }
        }
        V.chart(cv, { key: 'corr:' + dax + (_metric() ? 'm' : 'i'), aspect: 0.62, minH: 260, maxH: 440, w: 640, readout: 'y',
            x: { label: 'Pressure (' + _lab('pressure', 'psia') + ')', short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
            y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + dl + ')', invert: true, min: 0, short: 'Depth', fmtR: function (v) { return _depthPair(v, dax); } },
            series: ser, markers: markers, hidden: _plots().cHidden || null, onLegend: function (hid) { _plotsSet({ cHidden: hid }); },
            empty: (R && R.ok) ? 'No correlation traverse for these inputs.' : 'The correlations are compared at the operating point once the well solves.' });
        var h = _byId('wp_corrtbl'); if (!h) return;
        if (!C) { h.innerHTML = ''; return; }
        var rc = _rateCat(), O = ST.cmpOp && ST.cmpOp.key === C.key ? ST.cmpOp : null, sp = C.spreadPct;
        var chips = '<div class="wp-cmpk">' +
            '<div class="kpi wp-cmpc st-' + (sp == null ? 'none' : sp > 15 ? 'warn' : 'ok') + '"><span class="kpi-l">BHP spread (multiphase)</span><b class="kpi-v">' + (_fin(C.spread) ? _u(C.spread, 'pressure', 0, 'psi') : '—') + '</b><i class="kpi-s">' + (_fin(sp) ? _fmt(sp, 1) + ' % of the tubing Δp' : '') + '</i></div>' +
            '<div class="kpi wp-cmpc' + (C.sel === '__sec' ? ' st-ok' : '') + '"><span class="kpi-l">Selected</span><b class="kpi-v">' + _esc(_corrShort(C.sel)) + '</b><i class="kpi-s">' + _esc(C.sel === '__sec' ? _secSummary(R.traverse.sections) : _corrLabel(C.sel).replace(/\s*\(.*$/, '')) + '</i></div>' +
            '<div class="kpi wp-cmpc"><span class="kpi-l">At the operating rate</span><b class="kpi-v">' + _u(C.q, rc[0], 0, rc[1]) + '</b><i class="kpi-s">THP ' + _u(C.thp - PATM, 'pressureG', 0, 'psig') + '</i></div>' +
            (C.cf && C.cf.tz && C.cf.cs ? '<div class="kpi wp-cmpc st-' + (Math.abs(C.cf.cs.pwf / C.cf.tz.pwf - 1) < 0.01 ? 'ok' : 'warn') + '"><span class="kpi-l">Dry-gas closed forms</span><b class="kpi-v">' + (100 * (C.cf.cs.pwf / C.cf.tz.pwf - 1)).toFixed(2).replace(/^-(0\.00)$/, '$1') + ' %</b><i class="kpi-s">Cullender-Smith vs average T-Z</i></div>' : '') + '</div>';
        var rows = C.rows.map(function (r, i) {
            var o = O && O.ops[r.key], dot = '<span class="wp-cdot" style="background:' + pal[i % pal.length] + '"></span>';
            if (r.key === '__sec') dot = '<span class="wp-cdot" style="background:conic-gradient(' + (r.cruns || []).map(function (c, j, a) { return _corrCol(c.k) + ' ' + (100 * j / a.length).toFixed(0) + '% ' + (100 * (j + 1) / a.length).toFixed(0) + '%'; }).join(',') + ')"></span>';
            return '<tr' + (r.sel ? ' class="wp-sel"' : '') + '><td>' + dot + _esc(r.key === '__sec' ? r.label : r.label.replace(/\s*\(.*$/, '')) + (r.verified ? '' : ' <span class="wp-chip prov" title="' + _esc(PROVISIONAL_TXT) + '">provisional</span>') + (r.gasOnly ? ' <span class="wp-chip" title="gas phase only: the liquids are ignored">gas only</span>' : '') + '</td>' +
                '<td class="num">' + (_fin(r.pwf) ? _fmt(_dv(r.pwf, 'pressure'), 0) : '<span title="' + _esc(r.err || '') + '">lost</span>') + '</td>' +
                '<td class="num">' + (r.sel ? '—' : (_fin(r.dp) ? (r.dp >= 0 ? '+' : '') + _fmt(_dv(r.dp, 'pressure'), 0) + (_fin(r.dpPct) ? ' (' + (r.dpPct >= 0 ? '+' : '') + _fmt(r.dpPct, 1) + ' %)' : '') : '—')) + '</td>' +
                '<td class="num">' + (_fin(r.dpEl) ? _fmt(_dv(r.dpEl, 'pressure'), 0) + ' / ' + _fmt(_dv(r.dpF, 'pressure'), 0) : '—') + '</td>' +
                '<td>' + _patStrip(r) + '<span class="wp-u">' + _esc(r.patterns.join(', ')) + '</span></td>' +
                '<td class="num">' + (o ? (o.ok ? _fmt(_dv(o.q, rc[0]), 0) + (o.stable ? '' : ' ⚠') : '<span title="' + _esc(o.msg || '') + '">no flow</span>') : '·') + '</td>' +
                '<td class="rp-skip">' + (r.sel ? '<span class="wp-chip">in use</span>' : '<button type="button" class="btn btn-secondary wp-use" data-act="usecorr" data-v="' + _esc(r.key) + '" aria-label="Use ' + _esc(r.label) + '">Use</button>') + '</td></tr>';
        }).join('');
        if (C.cf) [['tz', 'Average T-Z (closed form)'], ['cs', 'Cullender-Smith (closed form)']].forEach(function (x) {
            var c = C.cf[x[0]]; if (!c) return;
            var d = _fin(C.pSel) ? c.pwf - C.pSel : null;
            rows += '<tr class="wp-cf"><td><span class="wp-cdot" style="background:' + (x[0] === 'cs' ? 'var(--text)' : 'var(--text3)') + '"></span>' + x[1] + ' <span class="wp-chip prov" title="' + _esc(PROVISIONAL_TXT) + '">provisional</span></td><td class="num">' + _fmt(_dv(c.pwf, 'pressure'), 0) + '</td><td class="num">' + (_fin(d) ? (d >= 0 ? '+' : '') + _fmt(_dv(d, 'pressure'), 0) : '—') + '</td><td colspan="3" class="wp-hint" style="margin:0">gas phase only, cross-check</td><td class="rp-skip"></td></tr>';
        });
        h.innerHTML = chips + '<div class="wp-tw"><table class="dtable wp-cmpt"><thead><tr><th>Correlation</th><th>BHP (' + _lab('pressure', 'psia') + ')</th><th>Δ vs selected</th><th>Gravity / friction Δp</th><th>Flow pattern along the well (top → bottom)</th><th>Own op. rate (' + _lab(rc[0], rc[1]) + ')</th><th class="rp-skip"></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
            '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="corrop">' + (O ? 'Re-run' : 'Find') + ' the operating point of each correlation</button></div>' +
            '<div class="wp-hint">Each correlation is marched down the surveyed path from the solved wellhead pressure at the operating rate (hydrostatic on TVD, friction on MD). Provisional correlations have no verified published example yet. The operating points appear on the system plot as diamonds in the colours of this table.</div>';
    }
    // v4.5 WP21: the map switch — the Ros map (Duns & Ros regions, A2) or the map of Aziz-Govier-Fogarasi, Mukherjee-Brill or the
    // mechanistic superficial-velocity map (Ansari, or Hasan-Kabir when that is the correlation in use); the default follows the
    // correlation in use (its registry entry's map)
    var MAP_KINDS = [['ros', 'Duns & Ros (Ros map)'], ['agf', 'Aziz-Govier-Fogarasi'], ['mb', 'Mukherjee-Brill'], ['mech', 'Mechanistic (v_sg · v_sl)']];
    function _mapKind() {
        var k = _plots().mapKind; if (k && MAP_KINDS.some(function (x) { return x[0] === k; })) return k;
        var sc = ST.R && ST.R.traverse && ST.R.traverse.sections, ck = sc && sc.length ? sc[sc.length - 1].corr : _selCorr(), e = (G.WTS_flowline_corr || {})[ck];
        return (e && e.map) || 'ros';
    }
    function _mapSwitch(kind) {
        return '<div class="wp-tabs wp-mapk rp-skip" role="tablist" aria-label="Flow-pattern map">' + MAP_KINDS.map(function (x) { return '<button type="button" data-mapk="' + x[0] + '" role="tab" aria-selected="' + (x[0] === kind) + '" class="' + (x[0] === kind ? 'on' : '') + '">' + x[1] + '</button>'; }).join('') + '</div>';
    }
    var PM_TXT = {
        agf: 'Aziz, Govier &amp; Fogarasi map: N_x = v_sg·(ρ_g/0.0764)^⅓·[(ρ_L/62.4)(72/σ)]^¼, N_y = v_sl·[(ρ_L/62.4)(72/σ)]^¼; boundaries N1, N2, N3 and N_x = 26.5.',
        mb: 'Mukherjee &amp; Brill map: N_Lv, N_gv as Duns &amp; Ros; the boundaries move with the inclination — drawn at the median station.',
        mech: 'Mechanistic map in superficial velocities: bubble / slug, dispersed bubble and annular boundaries at the median station.'
    };
    function _renderPatternMap(cv, V, T, kind) {
        var R = ST.R, ok = !!(R && R.ok && R.traverse && R.traverse.ok), mp = null, sel = _selCorr();
        if (ok) {
            var key = _cmpKey() + '|' + kind + '|' + sel;
            if (!(ST.pmap && ST.pmap.key === key)) { var m0 = _call('WTS_wp_vlp.patternMap', ST.F, R.op.q, R.traverse, { kind: kind, corr: sel }); ST.pmap = { key: key, m: (m0 && m0.ok) ? m0 : null }; }
            mp = ST.pmap.m;
        }
        var vel = kind === 'mech', cx = function (v) { return vel ? _dv(v, 'velocity') : v; };
        var ser = [], markers = [], mn = { x: 1e9, y: 1e9 }, mxv = { x: 0, y: 0 };
        var BCOL = ['#58a6ff', '#bc8cff', '#f0883e', '#3fb950', '#d29922'];
        if (mp) {
            mp.points.forEach(function (p) { mn.x = Math.min(mn.x, p.x); mn.y = Math.min(mn.y, p.y); mxv.x = Math.max(mxv.x, p.x); mxv.y = Math.max(mxv.y, p.y); });
            var x0 = Math.max(1e-3, Math.min(mn.x / 3, kind === 'mb' ? 1e-2 : 0.05)), y0 = Math.max(1e-3, Math.min(mn.y / 3, kind === 'mb' ? 0.1 : 0.05));
            var x1 = Math.max(mxv.x * 3, kind === 'agf' ? 600 : (kind === 'mb' ? 30 : 200)), y1 = Math.max(mxv.y * 3, kind === 'mb' ? 2000 : 30);
            var inb = function (q) { return q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1 && _fin(q[0]) && _fin(q[1]); };
            mp.lines.forEach(function (l, i) { var pts = l.pts.filter(inb).map(function (q) { return [cx(q[0]), cx(q[1])]; }); if (pts.length > 1) ser.push({ key: 'b' + l.key, label: l.label, color: BCOL[i % BCOL.length], width: 1.4, dash: [5, 4], pts: pts }); });
            mp.labels.forEach(function (lb) { if (inb([lb.x, lb.y])) markers.push({ x: cx(lb.x), y: cx(lb.y), kind: 'hollow', r: 0.1, color: V.PATTERN_COLORS[V.patternKey(lb.pattern)] || T.text2, label: lb.text }); });
            var runs = [], cur = null;
            mp.points.forEach(function (p) {
                var k = V.patternKey(p.pattern);
                if (!cur || cur.k !== k) { cur = { k: k, pat: p.pattern, pts: cur ? [cur.pts[cur.pts.length - 1]] : [], info: cur ? [cur.info[cur.info.length - 1]] : [] }; runs.push(cur); }
                cur.pts.push([cx(p.x), cx(p.y)]);
                cur.info.push([_mdTvdTxt(p.md, p.tvd) + (_fin(p.inc) ? ' · ' + _fmt(p.inc, 1) + '°' : ''), mp.axes.x.label + ' ' + _fmt(cx(p.x), 3) + ' · ' + mp.axes.y.label + ' ' + _fmt(cx(p.y), 3), String(p.pattern) + ' · p ' + _fmt(_dv(p.p, 'pressure'), 0) + ' ' + _lab('pressure', 'psia')]);
            });
            var seen = {};
            runs.forEach(function (r, i) { ser.push({ key: 'run' + i, label: seen[r.k] ? '' : r.pat, legend: !seen[r.k], color: V.PATTERN_COLORS[r.k] || T.text2, width: 3.2, pts: r.pts, info: r.info }); seen[r.k] = 1; });
            if (mp.points.length) {
                var a = mp.points[0], z = mp.points[mp.points.length - 1];
                markers.push({ x: cx(a.x), y: cx(a.y), kind: 'filled', color: T.text, r: 5, halo: false, label: 'Wellhead' });
                markers.push({ x: cx(z.x), y: cx(z.y), kind: 'diamond', color: T.accent, r: 6, label: 'Bottom ' + _mdTvdTxt(z.md, z.tvd) });
            }
            mn.x = x0; mn.y = y0;
        }
        var ax = function (a) { return vel ? (a.label === 'v_sg' ? 'Superficial gas velocity v_sg' : 'Superficial liquid velocity v_sl') + ' (' + _lab('velocity', 'ft/s') + ')' : (a.label === 'N_x' ? 'Gas number N_x' : a.label === 'N_y' ? 'Liquid number N_y' : a.label === 'N_Lv' ? 'Liquid velocity number N_Lv' : 'Gas velocity number N_gv'); };
        V.chart(cv, { key: 'pmap:' + kind + (_metric() ? 'm' : 'i'), aspect: 0.62, minH: 260, maxH: 440, w: 640, readout: 'near',
            x: { label: mp ? ax(mp.axes.x) : '', log: true, min: mp ? cx(mn.x) : 0.01, short: mp ? mp.axes.x.label : 'x' }, y: { label: mp ? ax(mp.axes.y) : '', log: true, min: mp ? cx(mn.y) : 0.01, short: mp ? mp.axes.y.label : 'y' },
            series: ser, markers: markers, hidden: _plots().pmapHidden || null, onLegend: function (hid) { _plotsSet({ pmapHidden: hid }); },
            empty: ok ? 'No two-phase station on this traverse (single-phase flow throughout).' : 'The flow-pattern map appears after a solve.' });
        var h = _byId('wp_corrtbl'); if (!h) return;
        var cnt = mp ? mp.counts : {}, tot = 0; Object.keys(cnt).forEach(function (k) { tot += cnt[k]; });
        var mc = kind === 'mech' ? (mp && mp.corr === 'hk' ? 'hk' : 'ansari') : kind, E = (G.WTS_flowline_corr || {})[mc];
        h.innerHTML = _mapSwitch(kind) + (mp ? '<div class="wp-cmpk">' + Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).map(function (k) {
            var pk = V.patternKey(k);
            return '<div class="kpi wp-cmpc"><span class="kpi-l"><i class="wp-cdot" style="background:' + (V.PATTERN_COLORS[pk] || T.text2) + '"></i>' + _esc(k) + '</span><b class="kpi-v">' + _fmt(100 * cnt[k] / (tot || 1), 0) + ' %</b><i class="kpi-s">' + cnt[k] + ' of ' + tot + ' stations</i></div>';
        }).join('') + '</div>' +
            '<div class="wp-hint">' + PM_TXT[kind] + ' The ' + _esc(R.traverse.sections && R.traverse.sections.length ? 'per-section' : _corrShort(sel)) + ' traverse at the operating point, each station classified by ' + _esc(E ? E.label.replace(/\s*\(.*$/, '') : mc) +
            ' with its own properties' + (mp.ref ? ' (boundaries at ' + _fmt(mp.ref.inc, 0) + '° from vertical, ID ' + _fmt(_dv(mp.ref.d, 'lengthSmall'), 3) + ' ' + _lab('lengthSmall', 'in') + ')' : '') + (E && E.verified !== true ? ' — <span class="wp-chip prov">provisional</span>' : '') + '. Hover the path for each station (MD · TVD).</div>' : '');
    }
    function _renderMapTab(cv, V, T) {
        var kind = _mapKind();
        if (kind !== 'ros') { _renderPatternMap(cv, V, T, kind); return; }
        var R = ST.R, ok = !!(R && R.ok && R.traverse && R.traverse.ok), mp = null;
        if (ok) {
            var key = _cmpKey();
            if (!(ST.drmap && ST.drmap.key === key)) { var m0 = _call('WTS_wp_vlp.drMap', ST.F, R.op.q, R.traverse); ST.drmap = { key: key, m: (m0 && m0.ok) ? m0 : null }; }
            mp = ST.drmap.m;
        }
        var ser = [], markers = [], mn = { x: 0.1, y: 0.1 };
        if (mp) {
            mp.points.forEach(function (p) { if (p.NLv > 0) mn.x = Math.max(1e-3, Math.min(mn.x, p.NLv / 1.5)); if (p.Ngv > 0) mn.y = Math.max(1e-3, Math.min(mn.y, p.Ngv / 1.5)); });
            var B = mp.boundaries, lim = function (pts) { return pts.filter(function (p) { return p[0] <= 100.01; }); };
            if (B) {
                ser.push({ key: 'b1', label: 'I / II', color: '#58a6ff', width: 1.4, dash: [5, 4], pts: lim(B.lines.bs) });
                ser.push({ key: 'b2', label: 'II / transition', color: '#bc8cff', width: 1.4, dash: [5, 4], pts: lim(B.lines.st) });
                ser.push({ key: 'b3', label: 'transition / III', color: '#f0883e', width: 1.4, dash: [5, 4], pts: lim(B.lines.tm) });
                var x0 = 0.2, L1 = B.L1, L2 = B.L2;
                markers.push({ x: x0, y: Math.max(0.12, (L1 + L2 * x0) / 4), kind: 'hollow', r: 0.1, color: V.PATTERN_COLORS.bubble, label: 'I bubble' });
                markers.push({ x: x0, y: Math.sqrt((L1 + L2 * x0) * (50 + 36 * x0)), kind: 'hollow', r: 0.1, color: V.PATTERN_COLORS.slug, label: 'II slug' });
                markers.push({ x: x0, y: Math.sqrt((50 + 36 * x0) * (75 + 84 * Math.pow(x0, 0.75))), kind: 'hollow', r: 0.1, color: V.PATTERN_COLORS.transition, label: 'transition' });
                markers.push({ x: x0, y: 4 * (75 + 84 * Math.pow(x0, 0.75)), kind: 'hollow', r: 0.1, color: V.PATTERN_COLORS.mist, label: 'III mist' });
            }
            // the traverse path, one run per region (coloured as the flow-pattern strip), every station hoverable
            var pts = mp.points.filter(function (p) { return p.NLv > 0 && p.Ngv > 0; }), runs = [], cur = null;
            pts.forEach(function (p) { if (!cur || cur.reg !== p.region) { cur = { reg: p.region, pts: cur ? [cur.pts[cur.pts.length - 1]] : [], info: cur ? [cur.info[cur.info.length - 1]] : [] }; runs.push(cur); } cur.pts.push([p.NLv, p.Ngv]); cur.info.push(_mapInfo(p)); });
            var seen = {};
            runs.forEach(function (r, i) { var c = V.PATTERN_COLORS[REGION_PAT[r.reg]] || T.text2; ser.push({ key: 'run' + i, label: seen[r.reg] ? '' : REGION_TXT[r.reg], legend: !seen[r.reg], color: c, width: 3.2, pts: r.pts, info: r.info }); seen[r.reg] = 1; });
            if (pts.length) {
                var a = pts[0], z = pts[pts.length - 1];
                markers.push({ x: a.NLv, y: a.Ngv, kind: 'filled', color: T.text, r: 5, halo: false, label: 'Wellhead' });
                markers.push({ x: z.NLv, y: z.Ngv, kind: 'diamond', color: T.accent, r: 6, label: 'Bottom ' + _mdTvdTxt(z.md, z.tvd) });
            }
        }
        V.chart(cv, { key: 'drmap', aspect: 0.62, minH: 260, maxH: 440, w: 640, readout: 'near',
            x: { label: 'Liquid velocity number N_Lv', log: true, min: mn.x, short: 'N_Lv' }, y: { label: 'Gas velocity number N_gv', log: true, min: mn.y, short: 'N_gv' },
            series: ser, markers: markers, hidden: _plots().mapHidden || null, onLegend: function (hid) { _plotsSet({ mapHidden: hid }); },
            empty: ok ? 'No two-phase station on this traverse (single-phase flow throughout).' : 'The flow-regime map appears after a solve.' });
        var h = _byId('wp_corrtbl'); if (!h) return;
        if (!mp) { h.innerHTML = _mapSwitch('ros'); return; }
        var tot = mp.points.length || 1, cnt = mp.counts;
        h.innerHTML = _mapSwitch('ros') + '<div class="wp-cmpk">' + ['I', 'II', 'transition', 'III', 'single'].filter(function (k) { return cnt[k] > 0; }).map(function (k) {
            return '<div class="kpi wp-cmpc"><span class="kpi-l"><i class="wp-cdot" style="background:' + (V.PATTERN_COLORS[REGION_PAT[k]] || T.text2) + '"></i>' + _esc(REGION_TXT[k]) + '</span><b class="kpi-v">' + _fmt(100 * cnt[k] / tot, 0) + ' %</b><i class="kpi-s">' + cnt[k] + ' of ' + tot + ' stations</i></div>';
        }).join('') + '</div>' +
            '<div class="wp-hint">Duns &amp; Ros (Ros) flow-pattern map of the ' + _esc(_corrShort(mp.corr || _selCorr())) + ' traverse at the operating point. N_Lv = 1.938·v_sl·(ρ_L/σ)^¼, N_gv = 1.938·v_sg·(ρ_L/σ)^¼; the region I / II boundary is drawn for N_d = ' + _fmt(mp.NdRef, 1) +
            (mp.NdMin && mp.NdMax && mp.NdMax - mp.NdMin > 1 ? ' (stations ' + _fmt(mp.NdMin, 1) + '–' + _fmt(mp.NdMax, 1) + ', each classified with its own N_d)' : '') + ' — L1 = ' + _fmt(mp.boundaries.L1, 2) + ', L2 = ' + _fmt(mp.boundaries.L2, 2) + ' (chart readings, provisional). Hover the path for each station.</div>';
    }
    function _mapInfo(p) {
        return [_fmt(_dv(p.md, 'length'), 0) + ' ' + _lab('length', 'ft') + ' MD · ' + _fmt(_dv(p.tvd, 'length'), 0) + ' ' + _lab('length', 'ft') + ' TVD' + (_fin(p.inc) ? ' · ' + _fmt(p.inc, 1) + '°' : ''),
                'N_Lv ' + _fmt(p.NLv, 3) + ' · N_gv ' + _fmt(p.Ngv, 2) + ' · N_d ' + _fmt(p.Nd, 1), REGION_TXT[p.region] + ' · p ' + _fmt(_dv(p.p, 'pressure'), 0) + ' ' + _lab('pressure', 'psia')];
    }
    var PROVISIONAL_TXT = 'provisional — not verified against a published example';

    // Sensitivity variables (WTS_wp_sens.VARS, WP6): [key, label, field unit]; the fallback list keeps the page usable without the engine.
    // Values are typed in display units (SENS_CAT converts Metric entries to the field units of the engine); WC is in %.
    var SENS_FALLBACK = [['wc', 'Water cut', '%'], ['pr', 'Reservoir pressure p̄r', 'psia'], ['bean', 'Choke bean', '/64 in'], ['thp', 'Wellhead pressure (fixed, choke out of line)', 'psig'], ['gor', 'Producing GOR', 'scf/STB'], ['psep', 'Separator pressure', 'psig'], ['J', 'Productivity index J', 'STB/d/psi']];
    var SENS_CAT = { pr: 'pressure', thp: 'pressureG', psep: 'pressureG', tubingId: 'lengthSmall', gor: 'gor', glr: 'gor', J: 'productivityIndex' };
    function _sensDefs() {
        var SN = G.WTS_wp_sens;
        if (SN && SN.VARS && Array.isArray(SN.ORDER) && (G.__WP_STUBS || []).indexOf('WTS_wp_sens.job') === -1) return SN.ORDER.map(function (k) { return [k, SN.VARS[k].label, SN.VARS[k].unit]; });
        return SENS_FALLBACK;
    }
    function _sensUnit(k, imp) { return SENS_CAT[k] ? _lab(SENS_CAT[k], imp) : imp; }
    function _sensVarLabel(k) { var r = _sensDefs().filter(function (x) { return x[0] === k; })[0]; return r ? r[1] + (r[2] ? ' (' + _sensUnit(k, r[2]) + ')' : '') : (k || 'Parameter'); }
    function _sensVal(c) { var v = c && c.values; if (!v) return null; if (_fin(v.value)) return v.value; var ks = Object.keys(v); return ks.length ? v[ks[0]] : null; }
    function _sensDv(k, v) { return SENS_CAT[k] ? _dv(v, SENS_CAT[k]) : v; }
    function _sensLabel(s, c) { return c.label ? String(c.label) : _sensVarLabel(s.key).replace(/ \(.*\)$/, '') + ' ' + _fmt(_sensDv(s.key, +_sensVal(c)), 2); }
    // the values box: suggestions around the model value (WTS_wp_sens.suggest), shown in display units
    function _sensSuggest(which) {
        var two = which === 2, SN = G.WTS_wp_sens, sel = _byId(two ? 'wpv_svar2' : 'wpv_svar'), box = _byId(two ? 'wpv_svals2' : 'wpv_svals'); if (!sel || !box || !SN || typeof SN.suggest !== 'function') return;
        var M = ST.M || _read(), k = sel.value, why = null;
        if (two && !k) { box.value = ''; return; }
        try { var row = (SN.vars(M) || []).filter(function (x) { return x.key === k; })[0]; why = row && !row.applicable ? row.why : null; } catch (e) { why = null; }
        var sg = SN.suggest(M, k, two ? 3 : 5);
        if (sg && sg.ok) box.value = sg.values.map(function (v) { var d = _sensDv(k, v); return String(+(+d).toPrecision(4)); }).join(' ');
        var jb = _byId('wp_jobbox'); if (jb) jb.innerHTML = why ? _vHtml({ st: 'info', t: 'ℹ ' + _sensVarLabel(k).replace(/ \(.*\)$/, '') + ': ' + why + '.' }) : '';
    }

    // the values box must fit the variable (range and fluid type): on render / restore the stored values are replaced by suggestions
    // when one of them falls outside the variable's validity range (e.g. the water-cut placeholder with p̄r selected)
    function _sensParse(key, sraw) {
        // the same tokens and number rules as the gas-lift list (thousands groups, decimal comma); a non-number stays a string
        // (tubing sizes by name)
        return _listTokens(sraw).slice(0, 10).map(function (x) { var n = _listNum(x); return _fin(n) ? _fromDisp(n, SENS_CAT[key]) : x; });
    }
    function _sensFit() {
        var SN = G.WTS_wp_sens; if (!SN || !SN.VARS) return;
        var M0 = _read() || ST.M, prBase = M0 && M0.res && _fin(M0.res.pr) ? M0.res.pr : null;
        [1, 2].forEach(function (w) {
            var sel = _byId(w === 2 ? 'wpv_svar2' : 'wpv_svar'), box = _byId(w === 2 ? 'wpv_svals2' : 'wpv_svals'); if (!sel || !box) return;
            var V = SN.VARS[sel.value]; if (!V) return;
            var vals = _sensParse(sel.value, box.value);
            var bad = !vals.length || vals.some(function (v) { return typeof v === 'string' ? sel.value !== 'tubingId' : (!_fin(v) || (_fin(V.lo) && v < V.lo) || (_fin(V.hi) && v > V.hi)); });
            // values suggested for another model (review fix): p̄r values all below 0.3 × the model's p̄r are stale
            if (!bad && sel.value === 'pr' && _fin(prBase) && prBase > 0 && vals.every(function (v) { return _fin(v) && v < 0.3 * prBase; })) bad = true;
            if (bad) _sensSuggest(w);
        });
    }

    // Results drawer (full tables, .rp-skip)
    function _renderDrawer() {
        var h = _byId('wp_drawer_b'); if (!h) return;
        var R = ST.R, ok = !!(R && R.ok), parts = [], rc = _rateCat();
        var tbl = function (title, head, rows) { return '<div><div class="wp-sec-h" style="font-size:13px">' + _esc(title) + '</div><div class="wp-tw"><table class="dtable"><thead><tr>' + head.map(function (x) { return '<th>' + x + '</th>'; }).join('') + '</tr></thead><tbody>' + (rows.length ? rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i ? ' class="num"' : '') + '>' + _esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') : '<tr><td colspan="' + head.length + '">—</td></tr>') + '</tbody></table></div></div>'; };
        parts.push(tbl('Roots of Δ(q) = p_out − p_in', ['Rate (' + _lab(rc[0], rc[1]) + ')', 'Pressure (' + _lab('pressure', 'psia') + ')', 'dΔ/dq', 'Stable'], ((R && R.roots) || []).map(function (r) { return [_fmt(_dv(r.q, rc[0]), 1), _fmt(_dv(r.p, 'pressure'), 1), _fmt(r.dDdq, 4), r.stable ? 'yes' : 'no']; })));
        parts.push(tbl('Pressure-loss breakdown', ['Component', 'Δp (' + _lab('pressure', 'psi') + ')'], ((ok && R.breakdown) || []).map(function (b) { return [BD_LABEL[b.key] || b.key, _fmt(_dv(b.dp, 'pressure'), 1)]; })));
        var prof = (ok && R.traverse && R.traverse.profile) || [], rows = [], lastMd = -1e9;
        prof.forEach(function (r, i) { if (r.md - lastMd >= 499.99 || i === prof.length - 1 || (i && r.pattern !== prof[i - 1].pattern)) { lastMd = r.md; rows.push([_fmt(_dv(r.md, 'length'), 0), _fmt(_dv(r.tvd, 'length'), 0), _fmt(r.inc, 1), _fmt(_dv(r.p, 'pressure'), 0), _fmt(_dv(r.t, 'temperature'), 1), _fmt(r.hl, 3), _fmt(_dv(r.vm, 'velocity'), 2), String(r.pattern || '')]); } });
        parts.push(tbl('Traverse (every 500 ft and at each pattern change; full table in the CSV)', ['MD', 'TVD', 'Inc (°)', 'p', 'T', 'H_L', 'v_m', 'Pattern'], rows));
        var sh = ST.shut;
        if (sh && sh.ok !== false && !_isStub(sh)) parts.push(tbl('Shut-in', ['Case', 'SITHP (' + _lab('pressureG', 'psig') + ')'], [['Gas-filled tubing', _fmt(_dv(sh.gasFilled, 'pressureG'), 0)], ['Actual fluid', _fmt(_dv(sh.actualFluid, 'pressureG'), 0)]].concat((sh.partLiquid || []).map(function (p) { return ['Liquid top at ' + _fmt(_dv(p.liquidTopMd, 'length'), 0) + ' MD', _fmt(_dv(p.sithp, 'pressureG'), 0)]; }))));
        h.innerHTML = parts.join('');
        var sm = _byId('wp_drawer_sum'); if (sm) sm.textContent = ok ? (R.roots || []).length + ' root(s), ' + prof.length + ' traverse stations · solved in ' + _fmt(ST.solveMs, 0) + ' ms' : '';
    }

    // Step results (fluid table, IPR plot, survey extras, segments)
    function _renderStepResults() {
        var M = ST.M;
        // ① PVT table at six pressures
        var hf = _byId('wp_pvt');
        if (hf) {
            var F = ST.F, T = M ? M.res.T_F : null;
            if (F && F.ok && _fin(T) && _fin(M.res.pr)) {
                var pl = []; for (var i = 0; i < 6; i++) pl.push(Math.round(PATM + (M.res.pr - PATM) * i / 5));
                var tb = _call('WTS_wp_fluid.table', F, pl, T), rows = (tb && tb.rows) || [];
                var hasCo = rows.some(function (r) { return _fin(r.co); }), hasW = rows.some(function (r) { return _fin(r.rsw); });
                hf.innerHTML = '<div class="wp-tw"><table class="dtable wp-dense"><thead><tr><th>p (' + _lab('pressure', 'psia') + ')</th><th>Rs (' + _lab('gor', 'scf/STB') + ')</th><th>Bo (' + _fvfLab() + ')</th><th>μo (cp)</th><th>Z</th><th>μg (cp)</th>' +
                    (hasCo ? '<th>co (1e-6/psi)</th>' : '') + (hasW ? '<th>ρw (' + _lab('density', 'lbm/ft³') + ')</th><th>Rsw (' + _lab('gor', 'scf/STB') + ')</th>' : '') + '</tr></thead><tbody>' +
                    rows.map(function (r) { return '<tr><td>' + _fmt(_dv(r.p, 'pressure'), 0) + '</td><td class="num">' + _fmt(_dv(r.rs, 'gor'), 0) + '</td><td class="num">' + _fmt(r.bo, 3) + '</td><td class="num">' + _fmt(r.muo, 3) + '</td><td class="num">' + _fmt(r.z, 3) + '</td><td class="num">' + _fmt(r.mug, 4) + '</td>' +
                        (hasCo ? '<td class="num">' + (_fin(r.co) ? _fmt(r.co * 1e6, 2) : '—') + '</td>' : '') + (hasW ? '<td class="num">' + _fmt(_dv(r.rhoW, 'density'), 2) + '</td><td class="num">' + (_fin(r.rsw) ? _fmt(_dv(r.rsw, 'gor'), 1) : '—') + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></div>' +
                    ((F.validity || []).map(function (v) { return _vHtml({ st: v.inRange === false ? 'warn' : 'ok', t: (v.inRange === false ? '⚠ ' : '✓ ') + String(v.msg || v.corr).replace(/^[✓⚠✗]\s*/, '') }); }).join(''));
            } else hf.innerHTML = '<div class="wp-v info">' + (_isStub(F) ? 'The fluid engine shows the PVT table here once it is installed.' : 'Enter the fluid, the reservoir pressure and temperature to see the PVT table.') + '</div>';
        }
        _renderPvtCard(null);
        _renderPvtB();
        // ② IPR plot
        var cv = _byId('wp_cv_ipr'), V = G.WTS_wp_view;
        if (cv && V) {
            var I = ST.I, Tm = V.theme(), rc = _rateCat(), pts = (I && I.ok && I.curve) ? I.curve.map(function (c) { return [_dv(c.q, rc[0]), _dv(c.pwf, 'pressure')]; }).sort(function (a, b) { return a[0] - b[0]; }) : [];
            var tp = ((M && M.res.points) || []).map(function (p) { return [_dv(p.q, rc[0]), _dv(p.pwf, 'pressure')]; });
            if (_isInj(M)) rc = _injRateCat();
            var bx = _iprBExtras(I, function (q) { return _dv(q, rc[0]); }, function (p) { return _dv(p, 'pressure'); }, Tm);
            V.chart(cv, { key: 'ipr:' + rc[0], aspect: 0.6, minH: 220, maxH: 360, w: 520, readout: 'x', x: { label: (_isInj(M) ? 'Injection rate' : 'Rate') + ' (' + _lab(rc[0], rc[1]) + ')', min: (I && I.layers) ? undefined : 0, short: 'q' }, y: { label: 'pwf (' + _lab('pressure', 'psia') + ')', min: 0, short: 'pwf' },
                series: [{ key: 'ipr', label: (I && I.inj) ? 'Injectivity' : (I && I.layers) ? 'Total (commingled)' : 'IPR', color: Tm.green, width: 2.4, pts: pts }, { key: 'pts', label: 'Test points', kind: 'points', color: Tm.accent, pts: tp }].concat(bx.series),
                hlines: ((I && I.ok && _fin(I.pb)) ? [{ y: _dv(I.pb, 'pressure'), label: 'pb', color: Tm.yellow }] : []).concat(bx.hlines), vlines: bx.vlines, markers: bx.markers,
                empty: _isStub(I) ? 'The inflow engine draws the IPR here once it is installed.' : 'Enter p̄r and the model parameters to draw the IPR.' });
            var is = _byId('wp_iprsum');
            if (is) is.innerHTML = (I && I.ok) ? '<div class="rrow"><span class="rl">' + (I.inj ? 'Rate at the pressure limit' : 'AOF') + '</span><span class="rv">' + _u(I.aof, rc[0], 0, rc[1]) + '</span></div>' + (_fin(I.J) && !I.inj ? '<div class="rrow"><span class="rl">Productivity index</span><span class="rv">' + _u(I.J, 'productivityIndex', 3, 'STB/d/psi') + '</span></div>' : '') +
                _iprBRows(I).map(function (r) { return '<div class="rrow"><span class="rl">' + _esc(r[0]) + '</span><span class="rv">' + _esc(r[1]) + '</span></div>'; }).join('') +
                (I.verified === false ? _vHtml({ st: 'warn', t: '⚠ ' + (I.label || 'This inflow model') + ': provisional — not verified against a published example.' }) : '') : '';
            _renderIprStudy();
        }
        // ③ survey extras + segments; the TVD cells of the other tables are refreshed in place (no re-render: the focus stays)
        _renderTable('survey');
        _refreshTvdCells();
        _refreshSecCover();
        var pt = _byId('wp_perftvd');
        if (pt) {
            var nd = ST.W && ST.W.ok && ST.W.nodes, f = function (md, tv) { return _fin(md) ? _u(md, 'length', 0, 'ft') + ' MD · ' + (_fin(tv) ? _u(tv, 'length', 0, 'ft') : '—') + ' TVD' : '—'; };
            pt.innerHTML = nd ? '<div class="rrow"><span class="rl">Top perforation</span><span class="rv">' + _esc(f(nd.perfTopMd, nd.perfTopTvd)) + '</span></div>' +
                '<div class="rrow"><span class="rl">Mid-perforation (bottom node)</span><span class="rv">' + _esc(f(nd.midPerfMd, nd.midPerfTvd)) + '</span></div>' +
                '<div class="rrow"><span class="rl">Bottom perforation</span><span class="rv">' + _esc(f(nd.perfBotMd, nd.perfBotTvd)) + '</span></div>' +
                (_fin(nd.tubingShoeMd) ? '<div class="rrow"><span class="rl">Tubing shoe</span><span class="rv">' + _esc(f(nd.tubingShoeMd, nd.tubingShoeTvd)) + '</span></div>' : '') : '';
        }
        var hs = _byId('wp_segs');
        if (hs) {
            var W = ST.W;
            if (W && W.ok && Array.isArray(W.segments)) {
                hs.innerHTML = '<div class="wp-tw"><table class="dtable"><thead><tr><th>MD top–bottom (' + _lab('length', 'ft') + ')</th><th>TVD top–bottom</th><th>Inc (°)</th><th>ID (' + _lab('lengthSmall', 'in') + ')</th></tr></thead><tbody>' +
                    W.segments.slice(0, 60).map(function (s) { return '<tr><td>' + _fmt(_dv(s.md0, 'length'), 0) + ' – ' + _fmt(_dv(s.md1, 'length'), 0) + '</td><td class="num">' + _fmt(_dv(s.tvd0, 'length'), 0) + ' – ' + _fmt(_dv(s.tvd1, 'length'), 0) + '</td><td class="num">' + _fmt(s.inc, 1) + '</td><td class="num">' + _fmt(_dv(s.id, 'lengthSmall'), 3) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
                    (W.warnings || []).map(function (w) { return _vHtml({ st: 'warn', t: '⚠ ' + (w.msg || w) }); }).join('');
            } else hs.innerHTML = '<div class="wp-v info">' + (_isStub(W) ? 'The well path engine lists the flow segments (MD, TVD, inclination) here once it is installed.' : _esc((W && (W.errors || [])[0]) || 'Enter the survey and the strings.')) + '</div>';
        }
    }

    // ③ temperature: the relaxation summary at the operating point and the U fit (A2, WP14)
    function _renderHeat() { _renderHeatBody(); _renderStudies(); }
    function _renderHeatBody() {
        var R = ST.R, M = ST.M, hx = _hx(R), html = '';
        var cell = function (k, v, t) { return '<div' + (t ? ' title="' + _esc(t) + '"' : '') + '><div class="wp-hk">' + _esc(k) + '</div><div class="wp-hv">' + _esc(v) + '</div></div>'; };
        if (hx) {
            var fr = hx.frac || {}, pc = function (x) { return _fmt(100 * (x || 0), 0) + ' %'; };
            if (hx.mode === 'enthalpy') html += _enthHtml(hx, cell);
            html += '<div class="rbox-title" style="margin:' + (hx.mode === 'enthalpy' ? '12px 0 0' : '0') + '">Relaxation at the operating point <span class="wp-chip prov">provisional</span></div><div class="wp-heat-g">' +
                cell(hx.mode === 'enthalpy' ? 'THT without J-T' : 'THT at this rate', _u(hx.mode === 'enthalpy' ? hx.thtRelax : hx.tht, 'temperature', 1, '°F'), 'The wellhead end of the relaxation profile') +
                cell('Earth at surface', _u(hx.teTop, 'temperature', 1, '°F')) +
                cell('Relaxation distance A', _u(hx.A, 'length', 0, 'ft') + ' MD', 'A = (w c_p / 2π)·(k_e + r_to U_to f(t_D)) / (r_to U_to k_e), measured along the hole') +
                cell('f(t_D)', _fmt(hx.fTD, 3) + ' (t_D ' + _fmt(hx.tD, 0) + ')', 'Hasan-Kabir dimensionless time function, t_D = α t / r_wb²') +
                cell('Mass rate w', _fmt(hx.w, 0) + ' lbm/hr') +
                cell('Heat capacity c_p', _u(hx.cp, 'specificHeat', 3, 'Btu/lb·°F'), 'Mass-weighted: oil (Gambill), water 1.0, gas (real-gas)') +
                cell('U_to (outside radius)', _u(hx.U_to, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F') + (hx.Ubasis === 'ti' ? ' (from U_ti ' + _fmt(hx.U, 2) + ')' : '')) +
                cell('r_to · r_wb', _fmt(_dv(hx.r_to * 12, 'lengthSmall'), 3) + ' · ' + _fmt(_dv(hx.rwb * 12, 'lengthSmall'), 2) + ' ' + _lab('lengthSmall', 'in'), 'Hole radius: ' + (hx.rwbSource || '')) +
                '</div><div class="wp-hk">Mass fractions — oil ' + pc(fr.oil) + ' · water ' + pc(fr.water) + ' · gas ' + pc(fr.gas) + '</div>' +
                '<div class="wp-hbar" role="img" aria-label="Mass fractions: oil ' + pc(fr.oil) + ', water ' + pc(fr.water) + ', gas ' + pc(fr.gas) + '"><i style="width:' + (100 * (fr.oil || 0)).toFixed(1) + '%;background:var(--accent)"></i><i style="width:' + (100 * (fr.water || 0)).toFixed(1) + '%;background:var(--blue)"></i><i style="width:' + (100 * (fr.gas || 0)).toFixed(1) + '%;background:var(--green)"></i></div>' +
                _heatSvg(R);
        } else if (_heatAsked(M)) html += '<div class="wp-v info">' + (R && R.ok && R.heat && R.heat.fallback ? '⚠ The ' + (M.well.heat.mode === 'enthalpy' ? 'enthalpy balance' : 'relaxation model') + ' needs a geotherm (the surface temperature and the reservoir temperature, or geothermal points): the linear profile is used.' : 'ℹ The relaxation profile appears after a solve (it depends on the rate).') + '</div>';
        var tests = ((M && M.tests) || []).filter(function (t) { return t.use !== false && _fin(+t.tht_F); });
        html += '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="fitU"' + (tests.length ? '' : ' disabled title="Add a production test with a wellhead temperature (step ⑥)"') + '>Fit U to the test THT' + (tests.length > 1 ? 's' : '') + '</button></div>';
        var uf = _ufitHtml();
        var hb = _byId('wp_heatbox'); if (hb) hb.innerHTML = html + uf;
        var h6 = _byId('wp_ufit6'); if (h6) h6.innerHTML = uf;
    }
    // B (WP22): the enthalpy-balance summary — KPI cells, the energy budget from the reservoir temperature to the THT as a waterfall
    // (heat lost to the earth, J-T, gravity, kinetic; each term's share by linear superposition) and the mixture η along the well
    function _enthHtml(hx, cell) {
        var b = hx.budget, eta = hx.eta || {};
        var h = '<div class="rbox-title" style="margin:0">Enthalpy balance at the operating point <span class="wp-chip prov">provisional</span></div><div class="wp-heat-g">' +
            cell('THT (enthalpy)', _u(hx.tht, 'temperature', 1, '°F'), 'The wellhead end of the enthalpy-balance profile: heat loss to the earth plus the Joule-Thomson, gravity and kinetic terms') +
            cell('Against the relaxation', _tdS(hx.dT), 'THT (enthalpy) − THT (relaxation without the J-T, gravity and kinetic terms)') +
            cell('J-T coefficient, perforations', _eta(eta.bottom), 'Mixture η = Σ x_i c_p,i η_i / c_p with in-situ mass fractions; below zero the stream warms as the pressure falls (liquid)') +
            cell('J-T coefficient, wellhead', _eta(eta.top), 'Mixture η at the top of the tubing') +
            cell('U layers', hx.layers && hx.layers.length ? String(hx.layers.length) + ' · A ' + _fmt(_dv(hx.Amin, 'length'), 0) + '–' + _u(hx.Amax, 'length', 0, 'ft') : 'none (one U)', 'Heat-transfer layers by depth (table below); outside them the scalar U. A is the relaxation distance along MD.') +
            cell('Pass check', _fin(hx.passCheck) ? _tempDiff(hx.passCheck) : '—', 'THT re-run on the reported traverse pressures against the predictor pressures the march used') +
            '</div>';
        if (b) h += _budgetSvg(b);
        return h;
    }
    // the energy budget as a waterfall of HTML bars (readable at any width; bars move with CSS transitions): the absolute rows (reservoir,
    // THT) from the axis start, each term from the running temperature
    function _budgetSvg(b) {
        var V = G.WTS_wp_view, T = V && V.theme ? V.theme() : { red: '#f85149', yellow: '#d29922', blue: '#58a6ff', green: '#3fb950', purple: '#bc8cff' };
        var steps = [{ k: 'Reservoir', v: b.tIn, abs: true, c: T.red }, { k: 'Heat to the earth', v: b.loss, c: T.blue }, { k: 'Joule-Thomson', v: b.jt, c: T.purple },
                     { k: 'Gravity', v: b.grav, c: T.yellow }, { k: 'Kinetic', v: b.kin, c: T.green }, { k: 'Wellhead (THT)', v: b.tOut, abs: true, c: T.red }];
        var lo = Math.min(b.tOut, b.tIn), hi = Math.max(b.tOut, b.tIn), run = b.tIn;
        steps.forEach(function (st) { if (!st.abs) { run += st.v; lo = Math.min(lo, run); hi = Math.max(hi, run); } });
        lo = Math.floor((lo - 0.25 * (hi - lo)) / 10) * 10; hi = hi + 0.02 * (hi - lo);
        var X = function (t) { return 100 * (t - lo) / (hi - lo); }, cur = b.tIn;
        var rows = steps.map(function (st) {
            var x0, x1;
            if (st.abs) { x0 = 0; x1 = X(st.v); } else { x0 = X(Math.min(cur, cur + st.v)); x1 = X(Math.max(cur, cur + st.v)); cur += st.v; }
            var val = st.abs ? _u(st.v, 'temperature', 1, '°F') : (Math.abs(st.v) < 0.05 ? '< ' + _tempDiff(0.05) : _tdS(st.v));
            return '<div class="wp-bud-r" role="listitem"><span class="wp-bud-k">' + _esc(st.k) + '</span><span class="wp-bud-t"><i style="left:' + x0.toFixed(2) + '%;width:' + Math.max(0.6, x1 - x0).toFixed(2) + '%;background:' + st.c + (st.abs ? ';opacity:.55' : '') + '"></i></span><span class="wp-bud-v">' + _esc(val) + '</span></div>';
        }).join('');
        return '<div class="wp-hk" style="margin-top:10px">Energy budget along the well, reservoir → wellhead (axis from ' + _esc(_u(lo, 'temperature', 0, '°F')) + ')</div><div class="wp-bud" role="list" aria-label="' +
            _esc('Energy budget: reservoir ' + _fmt(b.tIn, 1) + ' °F, heat to the earth ' + _fmt(b.loss, 1) + ', Joule-Thomson ' + _fmt(b.jt, 1) + ', gravity ' + _fmt(b.grav, 1) + ', kinetic ' + _fmt(b.kin, 2) + ', THT ' + _fmt(b.tOut, 1) + ' °F') + '">' + rows + '</div>';
    }
    // compact profile of the fluid (relaxation) against the earth along MD, the heat lost shaded between them; depth ticks MD with TVD
    function _heatSvg(R) {
        var prof = ((R.traverse && R.traverse.profile) || []).filter(function (r) { return _fin(r.md) && _fin(r.t) && _fin(r.te); }).slice().sort(function (a, b) { return a.md - b.md; });
        if (prof.length < 3) return '';
        var V = G.WTS_wp_view, T = V && V.theme ? V.theme() : { red: '#f85149', yellow: '#d29922', text2: '#8b949e', border: '#30363d' };
        var W0 = 420, H0 = 150, mL = 44, mR = 10, mT = 16, mB = 24, aw = W0 - mL - mR, ah = H0 - mT - mB;
        var lo = Infinity, hi = -Infinity, mdMax = prof[prof.length - 1].md;
        prof.forEach(function (r) { lo = Math.min(lo, r.t, r.te); hi = Math.max(hi, r.t, r.te); });
        if (!(hi - lo > 1e-6) || !(mdMax > 0)) return '';
        var X = function (t) { return (mL + aw * (t - lo) / (hi - lo)).toFixed(1); }, Y = function (md) { return (mT + ah * md / mdMax).toFixed(1); };
        var fl = prof.map(function (r, i) { return (i ? 'L' : 'M') + X(r.t) + ' ' + Y(r.md); }).join('');
        var el = prof.map(function (r, i) { return (i ? 'L' : 'M') + X(r.te) + ' ' + Y(r.md); }).join('');
        var area = fl + prof.slice().reverse().map(function (r) { return 'L' + X(r.te) + ' ' + Y(r.md); }).join('') + 'Z';
        var ticks = [0, 0.5, 1].map(function (f) {
            var md = f * mdMax, r = prof.reduce(function (a, b) { return Math.abs(b.md - md) < Math.abs(a.md - md) ? b : a; });
            return '<text x="' + (mL - 4) + '" y="' + (+Y(md) + 3) + '" text-anchor="end" font-size="9" fill="' + T.text2 + '">' + _esc(_fmt(_dv(md, 'length'), 0)) + '</text>' +
                (f > 0 && _fin(r.tvd) ? '<text x="' + (mL - 4) + '" y="' + (+Y(md) + 12) + '" text-anchor="end" font-size="8" fill="' + T.text2 + '" opacity=".75">' + _esc(_fmt(_dv(r.tvd, 'length'), 0)) + ' TVD</text>' : '');
        }).join('');
        var top = prof[0];
        return '<svg class="wp-heatsvg" viewBox="0 0 ' + W0 + ' ' + H0 + '" width="100%" height="' + H0 + '" role="img" aria-label="Flowing temperature against the earth temperature along MD; the shaded band is the heat the fluid carries above the earth">' +
            '<rect x="' + mL + '" y="' + mT + '" width="' + aw + '" height="' + ah + '" fill="none" stroke="' + (T.border || '#30363d') + '"/>' +
            '<path d="' + area + '" fill="' + T.red + '" fill-opacity=".13"/>' +
            '<path d="' + el + '" fill="none" stroke="' + T.yellow + '" stroke-width="1.6" stroke-dasharray="2 3"/>' +
            '<path d="' + fl + '" fill="none" stroke="' + T.red + '" stroke-width="2.2"/>' +
            '<circle cx="' + X(top.t) + '" cy="' + Y(0) + '" r="3.5" fill="' + T.red + '"/>' +
            ticks +
            '<text x="' + mL + '" y="' + (mT - 5) + '" font-size="9" fill="' + T.text2 + '">' + _esc(_fmt(_dv(lo, 'temperature'), 0)) + '</text>' +
            '<text x="' + (mL + aw) + '" y="' + (mT - 5) + '" font-size="9" text-anchor="end" fill="' + T.text2 + '">' + _esc(_fmt(_dv(hi, 'temperature'), 0) + ' ' + _lab('temperature', '°F')) + '</text>' +
            '<text x="' + (mL + aw / 2) + '" y="' + (H0 - 6) + '" font-size="9" text-anchor="middle" fill="' + T.text2 + '">' + _esc((R.heat && R.heat.mode === 'enthalpy' ? '— fluid (enthalpy balance)' : '— fluid (relaxation)') + '   ··· earth (geotherm on TVD)   MD (' + _lab('length', 'ft') + ')') + '</text>' +
            '</svg>';
    }
    function _ufitHtml() {
        var f = ST.ufit; if (!f) return '';
        if (f.ok === false && !(f.rows && f.rows.length)) return _vHtml({ st: 'warn', t: '⚠ ' + ((f.errors || [])[0] || 'U fit not available.') });
        var rows = (f.rows || []).map(function (r) {
            return '<tr><td>' + _esc(r.id) + '</td><td class="num">' + (_fin(r.q) ? _fmt(r.q, 0) : '—') + '</td><td class="num">' + _fmt(_dv(r.tht, 'temperature'), 1) + '</td><td class="num">' + (r.ok ? _fmt(_dv(r.U, 'heatTransferCoef'), 2) : '—') + '</td><td>' + (r.ok ? '✓' : '⚠ ' + _esc(String(r.msg || '').slice(0, 120))) + '</td></tr>';
        }).join('');
        var out = '<div class="wp-tw" style="margin-top:8px"><table class="dtable"><thead><tr><th>Test</th><th>Rate</th><th>THT (' + _lab('temperature', '°F') + ')</th><th>U (' + _lab('heatTransferCoef', 'Btu/hr·ft²·°F') + ')</th><th>Fit</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        if ((f.rows || []).some(function (r) { return r.code === 'OUT_OF_RANGE'; })) out += _vHtml({ st: 'info', t: 'ℹ A THT outside the reachable range cannot be matched by U alone: below it the earth itself limits the cooling (a shorter producing time or a higher k_e cools more); above it even an insulated tubing (U → 0) would not reach it — check the THT, the rates and the reservoir temperature.' });
        if (f.ok && _fin(f.U)) {
            var ur = f.uRange || [f.U, f.U];
            out += _vHtml({ st: 'ok', t: '✓ U ' + _u(f.U, 'heatTransferCoef', 2, 'Btu/hr·ft²·°F') + (f.n > 1 ? ' (geometric mean of ' + f.n + ' tests, range ' + _fmt(_dv(ur[0], 'heatTransferCoef'), 2) + '–' + _fmt(_dv(ur[1], 'heatTransferCoef'), 2) + ')' : '') + ' reproduces the measured THT (1-D Brent on ln U' + ((f.rows || []).some(function (r) { return r.model === 'enthalpy'; }) ? ', with the J-T, gravity and kinetic source' : '') + ') — provisional.' }) +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="adoptU" data-v="' + (+f.U.toPrecision(4)) + '">Use U = ' + _esc(_fmt(_dv(f.U, 'heatTransferCoef'), 2)) + '</button></div>';
        }
        return out;
    }

    // step status dots
    function _stepStatus() {
        var M = ST.M, R = ST.R, st = {};
        if (!M) return st;
        var gas = _isGasType(M.fluid.type);
        st[1] = (gas ? _fin(M.fluid.sgg) : (_fin(M.fluid.api) && _fin(M.fluid.gor))) ? ((ST.F && ST.F.validity || []).some(function (v) { return v.inRange === false; }) ? 'warn' : 'ok') : 'none';
        st[2] = _fin(M.res.pr) ? ((ST.I && ST.I.ok) ? 'ok' : (_isStub(ST.I) ? 'warn' : 'fail')) : 'none';
        st[3] = (M.well.survey.length >= 2 && M.well.strings.length) ? ((ST.W && ST.W.ok) ? ((ST.W.warnings || []).length ? 'warn' : 'ok') : (_isStub(ST.W) ? 'warn' : 'fail')) : 'none';
        st[4] = 'ok';
        st[5] = (R && R.ok) ? (_verdicts().some(function (v) { return v.st === 'fail'; }) ? 'fail' : _verdicts().some(function (v) { return v.st === 'warn'; }) ? 'warn' : 'ok') : (R && !_isStub(R) ? 'fail' : 'none');
        st[6] = M.tests.length ? (ST.match ? 'ok' : 'warn') : 'none';
        st[7] = (R && R.ok) ? 'ok' : 'none';
        return st;
    }
    var DOT_TXT = { ok: 'complete', warn: 'has warnings', fail: 'has a failed check', none: 'not started' };
    function _renderDots() {
        var s = _stepStatus(), vs = null;
        STEPS.forEach(function (x) {
            var d = _byId('wp_dot_' + x.n), st = s[x.n] || 'none'; if (d) d.className = 'wp-dot ' + st;
            var t = DOT_TXT[st];
            if (x.n === 5 && (st === 'fail' || st === 'warn')) { vs = vs || _verdicts(); var nf = vs.filter(function (v) { return v.st === st; }).length; t = nf + ' check' + (nf === 1 ? '' : 's') + (st === 'fail' ? ' failed' : ' with a warning'); }
            var sr = _byId('wp_dotsr_' + x.n); if (sr) sr.textContent = ' — ' + t;
            var b = document.querySelector ? document.querySelector('#wp_steps [data-step="' + x.n + '"]') : null;
            if (b && b.setAttribute) b.setAttribute('title', CIRC[x.n] + ' ' + x.label + ' — ' + t);
        });
    }
    function _renderNotes() {
        var h = _byId('wp_notesbox'); if (!h) return;
        var M = ST.M, gas = M && _isGasType(M.fluid.type), user = '';
        var ue = _byId('wp_notes'); if (ue && ue.value && String(ue.value).trim()) user = String(ue.value).trim().slice(0, 560);
        var box = function (t) { return '<div style="margin-bottom:6px"><b>Notes</b> ' + _esc(t) + '</div>'; };
        h.innerHTML = box('Steady-state nodal analysis: the operating point is where the inflow (IPR) meets the outflow of the tubing, restrictions, choke and flowline to the separator. ' +
                'The vertical lift marches on the true inclination of every segment (hydrostatic on TVD, friction on MD); ' + (_secRuns() ? 'per-section correlations by MD / inclination (' + _secSummary(_secRuns()) + ').' : 'one correlation for the whole well.')) +
            box('Black-oil fluid model' + (gas ? '; the gas-condensate well is a wet gas with a constant condensate volume (no retrograde dropout)' : '') + '. ' +
                'Correlations outside their data range are extrapolations; those without a verified published example are labelled provisional. Restrictions use a homogeneous loss coefficient.') +
            box('The stability verdict is a static criterion (q_s): it does not predict heading or slugging. ' + (M && M.well.heat.mode === 'enthalpy'
                ? 'The flowing temperature is a steady enthalpy balance per rate (Alves et al. unified form): heat loss to the earth (Hasan-Kabir relaxation, U by depth layers), Joule-Thomson (mixture η from in-situ mass fractions, real-gas Z for the gas, assumed liquid expansion coefficients), gravity and kinetic terms on the pressures of a coarse predictor traverse; geotherm on TVD, marched along MD; no J-T across the drawdown at the sandface; gas lift uses the relaxation; provisional — not verified against a published example.'
                : M && M.well.heat.mode === 'relax'
                ? 'The flowing temperature is the steady heat-transfer relaxation (Ramey / Hasan-Kabir) per rate: geotherm on TVD, relaxation along MD, decoupled from pressure, with a constant producing time and a single U; no Joule-Thomson or kinetic term in the profile (the J-T correction applies to the hydrate check); provisional — not verified against a published example.'
                : 'The temperature is linear from the wellhead temperature entered; the J-T correction applies to the hydrate check only.')) +
            (M && M.surface.choke.present !== false && (M.surface.choke.corr === 'sachdeva' || (!gas && M.surface.choke.subcritical === 'sachdeva')) ? box('Choke: the Sachdeva et al. (1986) two-phase model' + (M.surface.choke.corr === 'sachdeva' ? ' (critical and sub-critical, with the rate factor)' : ' sets the critical ratio and carries the sub-critical branch, scaled to the critical correlation at its critical point') + '; provisional — not verified against a published example; its data range is bean 8–40/64 in.') : '') +
            (M && M.lift && M.lift.type === 'gaslift' ? box('Gas lift (quick look): one injection point — the shallower of the packer and the point of balance of the static casing gas column (less the valve ΔP) with the tubing; the lift gas is free gas only above it; valve mechanics, unloading and diagnosis are in the gas-lift design card; the stability check is static (no heading dynamics).') : '') +
            _ext('notes').map(function (a) { return (Array.isArray(a) ? a : [a]).map(function (t) { return t ? box(t) : ''; }).join(''); }).join('') +
            (user ? '<div><b>Notes</b> ' + _esc(user) + '</div>' : '');
    }

    // ── steps ─────────────────────────────────────────────────────────────────
    function _goStep(n, scroll) {
        n = (n >= 1 && n <= 7) ? n : 1;
        STEPS.forEach(function (x) {
            var s = _byId('wp_step_' + x.n); if (s) s.style.display = (x.n === n) ? '' : 'none';
            var b = document.querySelector ? document.querySelector('#wp_steps [data-step="' + x.n + '"]') : null; if (b) { if (b.classList) b.classList.toggle('active', x.n === n); b.setAttribute('aria-current', x.n === n ? 'step' : 'false'); }
        });
        _prefSet('wtspref_wp_step', n);
        if (n === 2 || n === 1) _renderStepResults();
        if (scroll) { var s2 = _byId('wp_step_' + n); if (s2 && s2.scrollIntoView) { try { s2.scrollIntoView({ block: 'start', behavior: _reduced() ? 'auto' : 'smooth' }); } catch (e) { /* ignore */ } } }
    }
    function _syncUi() {
        var root = _byId('wp_root'); if (!root) return;
        _relabelUntagged();
        var type = (_byId('wp_ftype') || {}).value || 'oil', gas = _isGasType(type), model = (_byId('wp_ipr') || {}).value || 'pi';
        var m = _iprModels().filter(function (x) { return x.key === model; })[0], need = m ? m.needs : [];
        var choke = !!(_byId('wp_choke') || {}).checked, mode = (_byId('wp_mode') || {}).value || 'rate', ck = (_byId('wp_ckcorr') || {}).value || 'gilbert';
        var lift = (_byId('wp_lift') || {}).value || 'none', sv2 = (_byId('wpv_svar2') || {}).value || '';
        var hv = (_byId('wp_heat') || {}).value, heat = hv === 'relax' || hv === 'enthalpy' ? hv : 'linear';
        var rvm = (_byId('wp_rvmode') || {}).value || 'none', emm = (_byId('wp_emul') || {}).value || 'none';
        // one visibility rule per element: every condition it carries must hold (fluid type, IPR parameter, choke in line, solve mode,
        // choke model, lift type, a second sensitivity variable, temperature model)
        Array.prototype.forEach.call(root.querySelectorAll('[data-for],[data-ip],[data-choke],[data-mode],[data-ck],[data-lift],[data-sv2],[data-heat],[data-rv],[data-emul]'), function (e) {
            var on = true, a;
            if ((a = e.getAttribute('data-for')) != null) { var list = String(a).split(' '); on = on && (list.indexOf(gas ? 'gas' : 'oil') !== -1 || list.indexOf(type) !== -1); }
            if ((a = e.getAttribute('data-ip')) != null) on = on && need.indexOf(a) !== -1;
            if ((a = e.getAttribute('data-choke')) != null) on = on && ((a === 'on') === choke);
            if ((a = e.getAttribute('data-mode')) != null) on = on && String(a).split(' ').indexOf(mode) !== -1;
            if ((a = e.getAttribute('data-ck')) != null) on = on && (a === 'sach' ? ck === 'sachdeva' : ck !== 'sachdeva');
            if ((a = e.getAttribute('data-lift')) != null) on = on && String(a).split(' ').indexOf(lift) !== -1;
            if ((a = e.getAttribute('data-sv2')) != null) on = on && ((a === 'on') === !!sv2);
            if ((a = e.getAttribute('data-heat')) != null) on = on && (String(a).split(' ').indexOf(heat) !== -1 || (a === 'relax' && heat === 'enthalpy'));   // relaxation inputs serve the enthalpy balance too (B)
            if ((a = e.getAttribute('data-rv')) != null) on = on && String(a).split(' ').indexOf(rvm) !== -1;
            if ((a = e.getAttribute('data-emul')) != null) on = on && String(a).split(' ').indexOf(emm) !== -1;
            if (e.classList) e.classList.toggle('wp-off', !on);
        });
        // dry-gas-only lift methods are not applicable to oil and water wells (WTS_wp_check raises ✗ if one is still selected)
        ['wp_corr_well', 'wp_corr_line'].forEach(function (id) { var sel = _byId(id); if (!sel || !sel.options) return; Array.prototype.forEach.call(sel.options, function (o) { if (o.value === 'gasTZ' || o.value === 'gasCS') { o.disabled = !gas; o.title = gas ? '' : 'Not applicable: a dry-gas method for gas wells only'; } }); });
        var ic = _byId('wp_iprchip'); if (ic) ic.innerHTML = m && m.verified === false ? '<span class="wp-chip prov">provisional</span>' : '';
        Object.keys(ST.prov).forEach(function (id) { var lab = root.querySelector('label[for="' + id + '"]'); if (lab && !lab.querySelector('.wp-chip')) lab.insertAdjacentHTML('beforeend', '<span class="wp-chip">' + _esc(ST.prov[id]) + '</span>'); });
        _goStep(_step(), false);
    }

    // ── jobs (design, bean schedule, sensitivity, comparison) ────────────────
    function _drive(job, onDone, label, boxId) {
        var box = _byId(boxId || 'wp_jobbox');
        if (!job || typeof job.step !== 'function') { if (box) box.innerHTML = _vHtml({ st: 'warn', t: '⚠ ' + ((job && (job.errors || [])[0]) || (label + ' is not available yet.')) }); return; }
        var cancelled = false; ST.job = { cancel: function () { cancelled = true; } };
        var show = function (p, l) { if (box) box.innerHTML = '<div class="wp-v info">' + _esc(label + ' — ' + (l || 'running')) + ' <button type="button" class="btn btn-secondary" data-act="cancel" style="padding:3px 9px;margin-left:8px">Cancel</button></div><div class="wp-prog"><i style="width:' + Math.round(100 * (p || 0)) + '%"></i></div>'; };
        show(0);
        var fin = function (res, err) { ST.job = null; if (box) box.innerHTML = err ? _vHtml({ st: err.code === 'CANCELLED' ? 'info' : 'fail', t: (err.code === 'CANCELLED' ? 'ℹ ' + label + ' cancelled.' : '✗ ' + label + ' failed: ' + (err.message || err.code || err)) }) : ''; if (!err) onDone(res); };
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.drive === 'function') {
            AI.drive(job, { shouldCancel: function () { return cancelled; }, onProgress: show }).then(function (r) { fin(r); }, function (e) { fin(null, e || { code: 'FAILED' }); });
        } else {
            try { var s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 100000 && !cancelled); fin(job.result()); } catch (e) { fin(null, e); }
        }
    }
    function _act(act, btn) {
        if (_ext('act', act, btn).some(Boolean)) return;
        var M = ST.M || _read();
        if (act === 'solve') { _solveNow(); return; }
        if (act === 'cancel') { if (ST.job) ST.job.cancel(); return; }
        if (/^wells/.test(act)) { if (G.WTS_wp_wellsUi) G.WTS_wp_wellsUi.act(act, btn); return; }       // B (WP28)
        if (act === 'example') { _loadExample(btn.getAttribute('data-ex')); return; }
        if (act === 'csv') { _csv(); return; }
        if (act === 'bu') { _importBuildup(); return; }
        if (act === 'design') {
            var tk = M.system.target.kind, q = M.system.target.q, tgt = {}; tgt[tk === 'thp' ? 'thp' : tk === 'tubingId' ? 'tubingId' : tk === 'qinj' ? 'qinj' : 'bean'] = q;
            // the message sits next to the design button (review fix: it appeared in the Studies box of the other card)
            var b0 = _byId('wp_designmsg');
            if (!_fin(q)) { if (b0) b0.innerHTML = _vHtml({ st: 'warn', t: '⚠ Enter the target rate first.' }); return; }
            if (b0) b0.innerHTML = '';
            _drive(_jobOf(_call('WTS_wp_system.designFor', M, tgt)), function (r) {
                ST.design = r;
                if (tk === 'tubingId' || (r && r.kind === 'tubingId')) { _renderTubDesign(); return; }
                var b = _byId('wp_design');
                if (b && tk === 'qinj' && r && r.ok) { b.innerHTML = _vHtml({ st: 'ok', t: '✓ Lift gas ' + _u(r.qinj, 'gasRateSmall', 0, 'Mscf/d') + ' gives the target rate.' }) + '<div class="wp-btns"><button type="button" class="btn btn-primary" data-act="glopt" data-v="' + Math.round(r.qinj) + '" data-prov="the design">Use this lift-gas rate</button></div>'; return; }
                if (b) b.innerHTML = (r && r.ok) ? _vHtml({ st: 'ok', t: '✓ ' + (tk === 'thp' ? 'Wellhead pressure ' + _u(r.thp, 'pressureG', 0, 'psig') : 'Bean ' + _fmt(r.bean, 1) + '/64 in') + ' gives the target rate.' }) +
                    '<div class="wp-btns"><button type="button" class="btn btn-primary" data-act="adopt" data-id="' + (tk === 'thp' ? 'wp_thp' : 'wp_bean') + '" data-v="' + (tk === 'thp' ? Math.round(r.thp) : Math.round(r.bean)) + '">Use this ' + (tk === 'thp' ? 'THP' : 'bean') + '</button></div>'
                    : ((r && r.errors && r.errors.length) ? r.errors.slice(0, 3).map(function (e, i) { return _vHtml({ st: i ? 'info' : 'warn', t: (i ? 'ℹ ' : '⚠ ') + e }); }).join('') : _vHtml({ st: 'warn', t: '⚠ No setting reaches the target rate.' }));
            }, 'Design');
            return;
        }
        if (act === 'beans') {
            _drive(_jobOf(_call('WTS_wp_system.beanSchedule', M, M.surface.beans)), function (rows) {
                ST.beans = { rows: Array.isArray(rows) ? rows : (rows && rows.rows) || [] };
                ST.beansKey = _mkey(M);
                ST.maxQ = null;
                if (ST.beans.rows.some(function (r) { return r.ok && r.regime === 'subcritical-bound'; })) { var mr = _call('WTS_wp_system.maxRate', M); ST.maxQ = mr && mr.ok ? mr.q : null; }
                _plotsSet({ trTab: 'beans' }); _renderBeans(); _renderTraverseCard();
            }, 'Bean schedule');
            return;
        }
        if (act === 'sens') {
            var key = (_byId('wpv_svar') || {}).value || 'wc', sraw = String((_byId('wpv_svals') || {}).value || '').trim(), vals = _sensParse(key, sraw).filter(function (x) { return _fin(x) || (key === 'tubingId' && typeof x === 'string'); });
            if (!vals.length) { var b1 = _byId('wp_jobbox'); if (b1) b1.innerHTML = _vHtml({ st: 'warn', t: '⚠ Enter up to 10 values for the sensitivity.' }); return; }
            var key2 = (_byId('wpv_svar2') || {}).value || '', vars = [{ key: key, values: vals }];
            if (key2) {
                if (key2 === key) { var b3 = _byId('wp_jobbox'); if (b3) b3.innerHTML = _vHtml({ st: 'warn', t: '⚠ Pick a second variable different from the first.' }); return; }
                var vals2 = _sensParse(key2, String((_byId('wpv_svals2') || {}).value || '').trim()).filter(function (x) { return _fin(x) || (key2 === 'tubingId' && typeof x === 'string'); });
                if (!vals2.length) { var b2 = _byId('wp_jobbox'); if (b2) b2.innerHTML = _vHtml({ st: 'warn', t: '⚠ Enter up to 10 values for the second variable.' }); return; }
                vars.push({ key: key2, values: vals2 });
            }
            ST.sensSel = null;
            _drive(_jobOf(_call('WTS_wp_sens.job', M, vars)), function (r) {
                if (!r || r.ok === false) {          // e.g. BAD_VARS: the values do not fit the variable — say so, never stay silent
                    var eb = _byId('wp_jobbox'), em = ((r && r.errors) || []).slice(0, 3).join(' · ') || (r && r.code) || 'no result';
                    if (eb) eb.innerHTML = _vHtml({ st: 'fail', t: '✗ Sensitivity not run: ' + em });
                    var stb = _byId('wp_senstbl'); if (stb) stb.innerHTML = '';
                    return;
                }
                ST.sens = r && typeof r === 'object' ? Object.assign({ key: key }, r) : null;
                if (ST.sens && ST.sens.two) _plotsSet({ trTab: 'sens' });
                ST.sensKey = _mkey(M);
                if (G.WTS_state && G.WTS_state.wellperf) G.WTS_state.wellperf.sens = ST.sens;
                _plotsSet({ trTab: 'sens' }); _renderTraverseCard(); _renderSystemPlot(); _renderSensTable();
            }, 'Sensitivity');
            return;
        }
        if (act === 'match') { _runMatch(); return; }
        if (/^pvt(match|adopt|unadopt|mprop|usefam|usevisc)$/.test(act) || act === 'labex' || act === 'rvex' || act === 'emulex') { _pvtmAct(act, btn); return; }
        if (act === 'pvtprop') { _plotsSet({ pvtProp: btn.getAttribute('data-k') }); _renderPvtCard(null); return; }
        if (act === 'pvtfam') { var fk = btn.getAttribute('data-k'); _setCtrl('wp_corr_pb', fk); _famSync('wp_corr_pb'); _commit('wp_corr_pb'); return; }
        if (act === 'pbclear') { _setCtrl('wp_pbUser', ''); _commit('wp_pbUser'); return; }
        if (act === 'secpreset') { _secPreset(btn.getAttribute('data-v')); return; }
        if (act === 'usecorr') { var ck = btn.getAttribute('data-v'), sw = _byId('wp_corr_well'); if (ck && sw) { _setCtrl('wp_corr_well', ck, true); _commit('wp_corr_well'); } return; }
        if (act === 'corrop') {
            _drive(_corrOpJob(), function (r) { if (r && r.key === _cmpKey()) { ST.cmpOp = r; _renderTraverseCard(); _renderSystemPlot(); } }, 'Operating point per correlation');
            return;
        }
        if (act === 'fitU') {
            var tl = (M.tests || []).filter(function (t) { return t.use !== false; });
            var Mf = JSON.parse(JSON.stringify(M)); Mf.well.heat.mode = M.well.heat.mode === 'enthalpy' ? 'enthalpy' : 'relax';   // B (WP22): the enthalpy fit holds the J-T source
            ST.ufit = _call('WTS_wp_match.thtFit', Mf, tl);
            _renderHeat(); _renderVerdicts();
            return;
        }
        if (act === 'adoptU') {
            var uv = +btn.getAttribute('data-v');
            if (_fin(uv) && uv > 0 && _byId('wp_Uto')) { _setCtrl('wp_Uto', uv, true); ST.prov.wp_Uto = 'matched to the test THT'; _syncUi(); _commit('wp_Uto'); }
            return;
        }
        if (act === 'glpc') {
            if (!_fn('WTS_wp_gl.glpc')) { var gm = _byId('wp_glmsg'); if (gm) gm.innerHTML = _vHtml({ st: 'warn', t: '⚠ The gas-lift engine is not available.' }); return; }
            _drive(_jobOf(_call('WTS_wp_gl.glpc', M)), function (r) {
                var gm2 = _byId('wp_glmsg');
                if (!r || r.ok === false && !(r.points && r.points.length)) { if (gm2) gm2.innerHTML = _vHtml({ st: 'fail', t: '✗ ' + (((r && r.errors) || [])[0] || 'The performance curve could not be run.') }); ST.gl = null; _renderGl(); return; }
                if (gm2) gm2.innerHTML = '';
                ST.gl = r; ST.glKey = _glKey(M);
                if (G.WTS_state && G.WTS_state.wellperf) G.WTS_state.wellperf.gl = r;
                _renderGl();
            }, 'Gas-lift performance curve');
            return;
        }
        if (act === 'glopt') { var vv = +btn.getAttribute('data-v'); if (_fin(vv)) { if ((_byId('wp_lift') || {}).value !== 'gaslift') _setCtrl('wp_lift', 'gaslift'); _setCtrl('wp_gl_qinj', Math.round(vv), true); ST.prov.wp_gl_qinj = btn.getAttribute('data-prov') || 'from the performance curve'; _syncUi(); _commit('wp_gl_qinj'); } return; }
        if (act === 'usetub') {
            var tkey = btn.getAttribute('data-key'), e2 = G.WTS_tubulars && G.WTS_tubulars.find ? G.WTS_tubulars.find(tkey) : null, Mm = G.WTS_wp_model;
            if (!e2 || !Mm) return;
            var strs = JSON.parse(JSON.stringify(M.well.strings || []));
            strs.forEach(function (x) { if (x && (x.kind || 'tubing') === 'tubing') { x.tubKey = tkey; x.id = e2.id; x.od = e2.od; x.wall = e2.wall; } });
            Mm.write({ strings: strs });
            _renderTable('strings');
            var dm = _byId('wp_design'); if (dm) dm.insertAdjacentHTML('afterbegin', _vHtml({ st: 'ok', t: '✓ The tubing strings now use ' + (e2.label || tkey) + '.' }));
            return;
        }
        if (act === 'sens2cell') {
            var ci = +btn.getAttribute('data-i'), cj = +btn.getAttribute('data-j');
            ST.sensSel = (ST.sensSel && ST.sensSel.i === ci && ST.sensSel.j === cj) ? null : { i: ci, j: cj };
            _renderSensTable(); _plotsSet({ trTab: 'sens' }); _renderTraverseCard();
            var nb2 = document.querySelector && document.querySelector('#wp_senstbl [data-act="sens2cell"][data-i="' + ci + '"][data-j="' + cj + '"]'); if (nb2 && nb2.focus) nb2.focus();
            return;
        }
        if (act === 'ckfit') {
            var ck = (_byId('wpv_ckfit') || {}).value || 'gilbert', fm = _byId('wp_ckfitmsg');
            var Mg = JSON.parse(JSON.stringify(M)); Mg.surface.choke.corr = ck; Mg.surface.choke.subcritical = 'sachdeva';
            var cf = _call('WTS_wp_system.chokeFactor', Mg, ck);
            if (cf && cf.ok) { _setCtrl('wp_ckrf', +cf.factor.toPrecision(4), true); ST.prov.wp_ckrf = 'fitted to ' + ck; _syncUi(); _commit('wp_ckrf'); if (fm) fm.innerHTML = _vHtml({ st: 'ok', t: '✓ Rate factor ' + _fmt(cf.factor, 3) + ': the Sachdeva rate equals ' + ck.replace(/^./, function (x) { return x.toUpperCase(); }) + ' at its critical point (' + _u(cf.p1_psig, 'pressureG', 0, 'psig') + ').' }); }
            else if (fm) fm.innerHTML = _vHtml({ st: 'warn', t: '⚠ ' + (((cf && cf.errors) || [])[0] || 'The rate factor could not be fitted.') });
            return;
        }
        if (act === 'tune' || act === 'tuneapply' || act === 'tunereset') { _tuneAct(act); return; }
        if (act === 'adopt') {
            var ids = String(btn.getAttribute('data-ids') || btn.getAttribute('data-id') || '').split(','), vs = String(btn.getAttribute('data-vs') || btn.getAttribute('data-v') || '').split(','), done = [];
            var pv = btn.getAttribute('data-prov');
            ids.forEach(function (id, i) { var v = +vs[i]; if (id && _byId(id) && _fin(v)) { _setCtrl(id, +v.toPrecision(6), true); ST.prov[id] = pv || ('matched to test ' + ((ST.match && ST.match.test) || '')); done.push(id); } });
            if (done.length) { _syncUi(); _commit(done[done.length - 1]); }
            return;
        }
        if (act === 'prism') { _importPrism(); return; }
        if (act === 'dfit') { _importDfit(); return; }
        if (act === 'sqc') { var sq = G.WTS_state && G.WTS_state.sepqc; var g = sq && (sq.gor || (sq.result && sq.result.gor)); if (_fin(g)) { _setCtrl('wp_gor', g, true); _commit('wp_gor'); } else { var hb = _byId('wp_fluidmsg'); if (hb) hb.innerHTML = _vHtml({ st: 'info', t: 'ℹ No Separator QC result in this project yet.' }); } return; }
        if (act === 'add') { _addRow(btn.getAttribute('data-t')); return; }
        if (act === 'paste') { var p = _byId('wp_paste_' + btn.getAttribute('data-t')); if (p && p.classList) p.classList.toggle('on'); return; }
        if (act === 'pasteok') { _pasteApply(btn.getAttribute('data-t')); return; }
        if (act === 'svmode') { _surveyModeSet(btn.getAttribute('data-m')); return; }
        if (act === 'svundo') { var u = ST.svUndo; if (u) _surveyModeSet(u.mode, u.rows); return; }
    }
    function _jobOf(r) { return (r && typeof r.step === 'function') ? r : (r && r.job && typeof r.job.step === 'function' ? r.job : r); }
    // ── page extensions (B, WP27): optional page parts registered by other Round-9 files in window.WTS_wellperf_ext[name] =
    // {resHtml(), stepHtml(n), render(live), act(act, btn) → true when handled, change(el) / input(el) → true, studies() → {rows:[[l, v]],
    // html}, marks() → [schematic marks], sysPlot({series, markers, vlines, X, Y, T}), csv() → [lines], notes() → [text], reset(), resize()};
    // called in name order at call time (load order does not matter); an extension error is logged and never breaks the page
    function _exts() { var E = G.WTS_wellperf_ext; if (!E || typeof E !== 'object') return []; return Object.keys(E).sort().map(function (k) { return E[k]; }).filter(function (x) { return x && typeof x === 'object'; }); }
    function _ext(fn) {
        var a = Array.prototype.slice.call(arguments, 1), out = [];
        _exts().forEach(function (x) { if (typeof x[fn] !== 'function') return; try { var r = x[fn].apply(x, a); if (r != null) out.push(r); } catch (e) { if (typeof console !== 'undefined') console.error('[wellperf ext] ' + fn + ': ' + (e && e.message)); } });
        return out;
    }
    function _renderBeans() {
        var h = _byId('wp_beans'); if (!h) return;
        var rows = (ST.beans && ST.beans.rows) || [], rc = _rateCat();
        var stale = ST.beans && ST.beans.stale ? '<div class="wp-stalechip" role="status">Results are from the previous inputs — re-run the bean schedule</div>' : '';
        var bnd = rows.some(function (r) { return r.ok && r.regime === 'subcritical-bound'; });
        var bnote = bnd ? _vHtml({ st: 'info', t: 'ℹ At the beans marked subcritical-bound the critical choke correlation caps the rate at its conservative sub-critical bound (p1 ≥ p2 / 0.588), so larger beans give the same rate' + (_fin(ST.maxQ) ? '; without a choke the well can deliver ' + (_isGasType(ST.M && ST.M.fluid.type) ? _u(ST.maxQ / 1000, 'gasRate', 2, 'MMscf/d') : _u(ST.maxQ, 'liquidRate', 0, 'STB/d')) : '') + '. Choose the continuous sub-critical model in the choke settings to lift this cap.' }) : '';
        h.innerHTML = rows.length ? stale + bnote + '<div class="wp-tw"><table class="dtable"><thead><tr><th>Bean (/64)</th><th>Rate (' + _lab(rc[0], rc[1]) + ')</th><th>THP (' + _lab('pressureG', 'psig') + ')</th><th>THT (' + _lab('temperature', '°F') + ')</th><th>Choke Δp</th><th>Regime</th><th>Stable</th></tr></thead><tbody>' +
            rows.map(function (r) { return '<tr><td>' + _fmt(r.bean, 0) + '</td><td class="num">' + _fmt(_dv(r.q, rc[0]), 0) + '</td><td class="num">' + _fmt(_dv(r.thp, 'pressureG'), 0) + '</td><td class="num">' + _fmt(_dv(r.tht, 'temperature'), 0) + '</td><td class="num">' + _fmt(_dv(r.dpChoke, 'pressure'), 0) + '</td><td>' + _esc(r.regime || '') + '</td><td>' + (r.stable ? '✓' : '✗') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '';
    }
    // Tubing-size design result (A2, WP16): every catalogue size with its rate, the target line and the chosen size; "Use this
    // tubing" writes the size into the strings table (WTS_wp_model.write → one solve)
    function _renderTubDesign() {
        var b = _byId('wp_design'), r = ST.design, V = G.WTS_wp_view; if (!b || !r) return;
        var rc = _rateCat(), gas = !!(ST.M && _isGasType(ST.M.fluid.type)), rows = r.rows || [];
        var head = r.ok ? _vHtml({ st: 'ok', t: '✓ ' + r.label + ' is the smallest catalogue tubing that gives the target rate (' + _u(r.q, rc[0], 0, rc[1]) + ' against ' + _u(r.target, rc[0], 0, rc[1]) + ').' })
            : (r.errors || []).slice(0, 2).map(function (e, i) { return _vHtml({ st: i ? 'info' : 'warn', t: (i ? 'ℹ ' : '⚠ ') + e }); }).join('');
        var tb = rows.length ? '<div class="wp-tw" style="margin-top:8px"><table class="dtable"><thead><tr><th>Tubing</th><th>ID (' + _esc(_lab('lengthSmall', 'in')) + ')</th><th>Rate (' + _esc(_lab(rc[0], rc[1])) + ')</th><th>Stable</th>' + (gas ? '<th>Loading margin</th>' : '') + '<th>Erosion ratio</th><th></th></tr></thead><tbody>' +
            rows.map(function (x) {
                var pick = r.ok && x.key === r.tubKey, cur = _fin(r.current) && Math.abs(x.id - r.current) < 1e-3;
                return '<tr' + (pick ? ' style="font-weight:700;color:var(--accent)"' : '') + '><td>' + _esc(String(x.label).replace(/\s*\(ID [^)]*\)/, '').replace(/ tubing$/, '')) + (cur ? ' (now)' : '') + '</td><td class="num">' + _fmt(_dv(x.id, 'lengthSmall'), 3) + '</td><td class="num">' + (x.ok ? _fmt(_dv(x.q, rc[0]), 0) : '—') + '</td><td>' + (x.ok ? (x.stable ? '✓' : '✗') : '—') + '</td>' +
                    (gas ? '<td class="num">' + (_fin(x.loadingMargin) ? (x.loadingMargin >= 0 ? '+' : '') + _fmt(100 * x.loadingMargin, 0) + ' %' : '—') + '</td>' : '') + '<td class="num">' + (_fin(x.ero) ? _fx(x.ero, 2) : '—') + '</td>' +
                    '<td class="rp-skip">' + (x.ok && !cur ? '<button type="button" class="btn btn-secondary" data-act="usetub" data-key="' + _esc(x.key) + '" style="padding:3px 9px">Use</button>' : '') + '</td></tr>';
            }).join('') + '</tbody></table></div>' : '';
        b.innerHTML = head + '<div class="chart-wrap rp-skip" style="margin-top:8px"><canvas id="wp_cv_tub" aria-label="Rate against the tubing inside diameter"></canvas></div>' + tb;
        var cv = _byId('wp_cv_tub'); if (!cv || !V) return;
        var T = V.theme(), pts = rows.filter(function (x) { return x.ok; }).map(function (x) { return [_dv(x.id, 'lengthSmall'), _dv(x.q, rc[0])]; });
        var qTop = Math.max.apply(null, [r.target || 0].concat(rows.filter(function (x) { return x.ok; }).map(function (x) { return x.q; })));
        V.chart(cv, { key: 'tub:' + rc[0], aspect: 0.58, minH: 210, maxH: 340, w: 560, readout: 'x',
            x: { label: 'Tubing ID (' + _lab('lengthSmall', 'in') + ')', short: 'ID', fmtR: function (v) { return _fmt(v, 3) + ' ' + _lab('lengthSmall', 'in'); } }, y: { label: 'Rate (' + _lab(rc[0], rc[1]) + ')', min: 0, max: qTop > 0 ? _dv(qTop * 1.25, rc[0]) : undefined, short: 'q', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab(rc[0], rc[1]); } },
            series: [{ key: 'q', label: 'Operating rate', color: T.blue, width: 2.4, pts: pts }, { key: 'qp', label: '', legend: false, kind: 'points', color: T.blue, pts: pts }],
            hlines: _fin(r.target) ? [{ y: _dv(r.target, rc[0]), label: 'target', color: T.yellow, dash: [6, 4] }] : [],
            markers: rows.filter(function (x) { return x.ok && (!x.stable || (r.ok && x.key === r.tubKey)); }).map(function (x) { var pk = r.ok && x.key === r.tubKey; return { x: _dv(x.id, 'lengthSmall'), y: _dv(x.q, rc[0]), kind: pk ? 'filled' : 'hollow', color: pk ? T.accent : T.red, r: pk ? 7 : 5, halo: pk, label: pk ? String(r.label).replace(/\s*\(ID [^)]*\)/, '').replace(/ tubing$/, '') : 'unstable' }; }),
            empty: 'No catalogue size flows.' });
    }

    // the 2-D table of a two-variable sensitivity: rows = the second variable, columns = the primary one, each cell coloured by its
    // rate (the heat map; grey = no operating point, ✗ = unstable). A cell is a button: it selects the case on the rate plot and
    // shows its numbers with "Use these values" (the inputs change through the normal event path). The table is report-captured.
    var SENS_ID = { pr: 'wp_pr', wc: 'wp_wc', gor: 'wp_gor', thp: 'wp_thp', psep: 'wp_psep', bean: 'wp_bean', J: 'wp_ip_J', skin: 'wp_ip_S', cgr: 'wp_cgr', wgr: 'wp_wgr' };
    function _renderSens2Table() {
        var h = _byId('wp_senstbl'); if (!h) return;
        var s = ST.sens, g = s.grid, rc = _rateCat(), V = G.WTS_wp_view, all = [];
        g.q.forEach(function (r) { r.forEach(function (q) { if (_fin(q)) all.push(q); }); });
        var lo = all.length ? Math.min.apply(null, all) : 0, hi = all.length ? Math.max.apply(null, all) : 1, n = s.cases.filter(function (c) { return c.R && c.R.ok; }).length;
        var l1 = _sensVarLabel(s.key), l2 = _sensVarLabel(s.key2), sel = ST.sensSel;
        var head = '<div class="wp-sec-h" style="font-size:13px;margin-top:12px">Sensitivity — ' + _esc(l1) + ' × ' + _esc(l2) + ' <span>' + n + ' of ' + s.cases.length + ' cases flow; rate (' + _esc(_lab(rc[0], rc[1])) + ') in each cell</span></div>' +
            (s.stale ? '<div class="wp-stalechip" role="status">Results are from the previous inputs — re-run the sensitivity</div>' : '') +
            (s.warnings || []).filter(function (w) { return w && w.code !== 'CASE_NA'; }).map(function (w) { return _vHtml({ st: w.sev === 'info' ? 'info' : 'warn', t: (w.sev === 'info' ? 'ℹ ' : '⚠ ') + w.msg }); }).join('');
        var isB = function (k, v, b) { return b && _fin(b.value) && b.inList && Math.abs(v - b.value) <= 1e-9 * Math.max(1, Math.abs(b.value)); };
        var tb = '<div class="wp-tw"><table class="dtable wp-heat" aria-label="Rate for each pair of values"><thead><tr><th>' + _esc(l2.replace(/ \(.*\)$/, '')) + ' ↓ / ' + _esc(l1.replace(/ \(.*\)$/, '')) + ' →</th>' +
            g.x.map(function (x, i) { return '<th class="num"' + (isB(s.key, x, s.base) ? ' style="color:var(--accent)"' : '') + '>' + _esc(_sv(s.key, x, g.labelsX[i])) + '</th>'; }).join('') + '</tr></thead><tbody>' +
            g.y.map(function (y, j) {
                return '<tr><th' + (isB(s.key2, y, s.base2) ? ' style="color:var(--accent)"' : '') + '>' + _esc(_sv(s.key2, y, g.labelsY[j])) + '</th>' + g.x.map(function (x, i) {
                    var q = g.q[j][i], f = _fin(q) && hi > lo ? (q - lo) / (hi - lo) : 0.5, on = sel && sel.i === i && sel.j === j;
                    var bg = _fin(q) ? V.ramp(0.08 + 0.84 * f).replace('rgb(', 'rgba(').replace(')', ',0.42)') : 'transparent';
                    return '<td class="num wp-hc' + (on ? ' on' : '') + '" style="background:' + bg + '"><button type="button" data-act="sens2cell" data-i="' + i + '" data-j="' + j + '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + _esc(l1 + ' ' + _sv(s.key, x, g.labelsX[i]) + ', ' + l2 + ' ' + _sv(s.key2, y, g.labelsY[j])) + '">' +
                        (_fin(q) ? _fmt(_dv(q, rc[0]), 0) + (g.stable[j][i] === false ? ' ✗' : '') : '—') + '</button></td>';
                }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>';
        var leg = '<div class="wp-heatleg"><span>' + _esc(_fmt(_dv(lo, rc[0]), 0)) + '</span><i style="background:linear-gradient(90deg,' + [0.08, 0.3, 0.5, 0.7, 0.92].map(function (f) { return V.ramp(f); }).join(',') + ')"></i><span>' + _esc(_fmt(_dv(hi, rc[0]), 0) + ' ' + _lab(rc[0], rc[1])) + '</span><span class="wp-hint" style="margin:0 0 0 8px">— no flow · ✗ unstable · accent = the model value</span></div>';
        var det = '';
        if (sel) {
            var c = s.cases.filter(function (x) { return x.i === sel.i && x.j === sel.j; })[0], R = c && c.R;
            if (R) {
                var v1 = g.x[sel.i], v2 = g.y[sel.j], ids = [], vs = [];
                [[s.key, v1], [s.key2, v2]].forEach(function (kv) { var id = SENS_ID[kv[0]]; if (id && _byId(id)) { ids.push(id); vs.push(kv[0] === 'wc' ? kv[1] : kv[1]); } });
                det = '<div class="rbox" style="margin-top:10px"><div class="rbox-title">Selected case</div>' +
                    '<div class="rrow"><span class="rl">' + _esc(l1) + ' · ' + _esc(l2) + '</span><span class="rv">' + _esc(_sv(s.key, v1, g.labelsX[sel.i]) + ' · ' + _sv(s.key2, v2, g.labelsY[sel.j])) + '</span></div>' +
                    (R.ok ? '<div class="rrow"><span class="rl">Rate</span><span class="rv">' + _esc(_u(R.q, rc[0], 0, rc[1])) + (R.stable ? '' : ' (unstable)') + '</span></div><div class="rrow"><span class="rl">pwf · THP</span><span class="rv">' + _esc(_u(R.pwf, 'pressure', 0, 'psia') + ' · ' + _u(R.thp, 'pressureG', 0, 'psig')) + '</span></div>'
                        : _vHtml({ st: 'info', t: 'ℹ ' + (R.error || R.code || 'No operating point.') })) +
                    (ids.length && R.ok ? '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="adopt" data-prov="from the sensitivity" data-ids="' + ids.join(',') + '" data-vs="' + vs.join(',') + '">Use these values</button></div>' : '') + '</div>';
            }
        }
        h.innerHTML = head + tb + leg + det;
    }
    function _renderSensTable() { _renderSensTableBody(); _renderStudies(); }
    function _renderSensTableBody() {
        var h = _byId('wp_senstbl'); if (!h) return;
        if (ST.sens && ST.sens.two && ST.sens.grid) { _renderSens2Table(); return; }
        var s = ST.sens, rc = _rateCat();
        if (!(s && s.cases && s.cases.length)) { h.innerHTML = ''; return; }
        var gas = !!(ST.M && _isGasType(ST.M.fluid.type)), bv = s.base && _fin(s.base.value) ? s.base.value : null;
        var nOk = s.cases.filter(function (c) { return c.R && c.R.ok; }).length;
        var head = '<div class="wp-sec-h" style="font-size:13px;margin-top:12px">Sensitivity — ' + _esc(_sensVarLabel(s.key)) + ' <span>' + nOk + ' of ' + s.cases.length + ' cases flow' + (s.family === 'ipr' ? '; one inflow curve per value' : '; one outflow curve per value') + ' on the system plot</span></div>';
        var warn = (s.warnings || []).filter(function (w) { return w && w.code !== 'CASE_NA'; }).map(function (w) {
            var m = w.code === 'NO_BASE_CASE' && bv != null ? 'The model value ' + _fmt(_sensDv(s.key, bv), 3) + ' ' + _sensVarLabel(s.key).replace(/^.*\((.*)\)$/, '$1') + ' is not in the list: the sensitivity has no base case.' : w.msg;
            return _vHtml({ st: w.sev === 'info' ? 'info' : 'warn', t: (w.sev === 'info' ? 'ℹ ' : '⚠ ') + m });
        }).join('');
        if (s.stale) head += '<div class="wp-stalechip" role="status">Results are from the previous inputs — re-run the sensitivity</div>';
        h.innerHTML = head + warn + '<div class="wp-tw"><table class="dtable"><thead><tr><th>' + _esc(_sensVarLabel(s.key)) + '</th><th>Rate (' + _lab(rc[0], rc[1]) + ')</th>' +
            (gas ? '<th>Condensate (' + _lab('liquidRate', 'STB/d') + ')</th>' : '<th>Oil (' + _lab('liquidRate', 'STB/d') + ')</th><th>Gas (' + _lab('gasRateSmall', 'Mscf/d') + ')</th>') + '<th>Water (' + _lab('liquidRate', 'BWPD') + ')</th>' +
            '<th>pwf (' + _lab('pressure', 'psia') + ')</th><th>THP (' + _lab('pressureG', 'psig') + ')</th><th>THT (' + _lab('temperature', '°F') + ')</th><th>Stable</th>' + (gas ? '<th>Loading margin</th>' : '') + '<th>Note</th></tr></thead><tbody>' +
            s.cases.map(function (c) {
                var R = c.R || {}, v = +_sensVal(c), isBase = bv != null && Math.abs(v - bv) <= 1e-9 * Math.max(1, Math.abs(bv));
                return '<tr' + (isBase ? ' style="font-weight:600"' : '') + '><td>' + _esc(c.label || _fmt(_sensDv(s.key, v), 3)) + (isBase ? ' (model)' : '') + '</td><td class="num">' + _fmt(_dv(R.q, rc[0]), 0) + '</td>' +
                    (gas ? '<td class="num">' + _fmt(_dv(R.qo, 'liquidRate'), 1) + '</td>' : '<td class="num">' + _fmt(_dv(R.qo, 'liquidRate'), 0) + '</td><td class="num">' + _fmt(_dv(R.qg, 'gasRateSmall'), 0) + '</td>') + '<td class="num">' + _fmt(_dv(R.qw, 'liquidRate'), 0) + '</td>' +
                    '<td class="num">' + _fmt(_dv(R.pwf, 'pressure'), 0) + '</td><td class="num">' + _fmt(_dv(R.thp, 'pressureG'), 0) + '</td><td class="num">' + _fmt(_dv(R.tht, 'temperature'), 0) + '</td>' +
                    '<td>' + (R.ok ? (R.stable ? '✓' : '✗') : '—') + '</td>' + (gas ? '<td class="num">' + (_fin(R.loadingMargin) ? _fmt(100 * R.loadingMargin, 0) + ' %' : '—') + '</td>' : '') +
                    '<td>' + _esc(R.ok ? (R.regime ? 'choke ' + R.regime : '') : (R.error || R.code || 'no flow')) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
    }
    var QC_SYM = { ok: '✓', warn: '!', fail: '✕', na: '–' };
    function _matchTests(M) { return (M.tests || []).filter(function (t) { return t && t.use !== false; }); }
    function _syncMatchTests() {
        var sel = _byId('wpv_mtest'), M = ST.M || _read(); if (!sel) return;
        var cur = sel.value, ts = _matchTests(M), opts = ts.map(function (t, i) { var id = t.id != null && String(t.id) !== '' ? String(t.id) : 'test ' + (i + 1); return [String(i), id + (t.date ? ' (' + t.date + ')' : '')]; });
        if (ts.length > 1) opts.push(['all', 'All used tests (RMS)']);
        sel.innerHTML = opts.length ? opts.map(function (o) { return '<option value="' + _esc(o[0]) + '">' + _esc(o[1]) + '</option>'; }).join('') : '<option value="">no test</option>';
        if (cur && opts.some(function (o) { return o[0] === cur; })) sel.value = cur;
    }
    function _runMatch() {
        var M = ST.M || _read(), h = _byId('wp_matchres'); if (!h) return;
        var tests = _matchTests(M);
        if (!tests.length) { ST.match = null; h.innerHTML = _vHtml({ st: 'info', t: 'ℹ Add a production test (rates, THP, gauge MD and pressure) first.' }); _renderDots(); return; }
        _syncMatchTests();
        var corrs = Array.prototype.filter.call(document.querySelectorAll('#wp_corrset input[data-corr]'), function (e) { return e.checked; }).map(function (e) { return e.getAttribute('data-corr'); });
        var pick = (_byId('wpv_mtest') || {}).value || '0', all = pick === 'all', t = all ? tests[0] : (tests[+pick] || tests[0]);
        var sf = (_byId('wp_m_solve') || {}).value || 'pr';
        var cmp = _call('WTS_wp_match.compare', M, all ? tests : t, corrs), qc = _call('WTS_wp_qc', M, M.tests || [], { corrKeys: corrs.length ? corrs : undefined }), ip = _call('WTS_wp_match.iprFromTest', M, t, sf);
        ST.match = { compare: cmp, qc: qc, ipr: ip, test: all ? 'all' : t.id, solveFor: sf, all: all };
        if (G.WTS_state && G.WTS_state.wellperf) G.WTS_state.wellperf.match = ST.match;
        _renderMatch();
        _renderDots();
    }
    function _renderMatch() {
        var h = _byId('wp_matchres'), m = ST.match; if (!h || !m) return;
        var cmp = m.compare, qc = m.qc, ip = m.ipr, reg = G.WTS_flowline_corr || {}, out = [], tid = m.all ? 'all used tests' : 'test ' + m.test;
        // QC matrix: a chip per check, the score and the rank
        if (qc && qc.ok !== false && Array.isArray(qc.rows) && qc.rows.length) {
            var codes = (qc.codes || []).slice(), lab = qc.labels || {};
            out.push('<div class="rbox-title">Production-test QC</div><div class="wp-tw"><table class="dtable wp-qc"><thead><tr><th>Test</th>' + codes.map(function (c) { return '<th title="' + _esc(c) + '">' + _esc(lab[c] || c) + '</th>'; }).join('') + '<th>Score</th><th>Rank</th></tr></thead><tbody>' +
                qc.rows.map(function (r) {
                    var byC = {}; (r.checks || []).forEach(function (c) { byC[c.code] = c; });
                    return '<tr' + (r.use === false ? ' style="opacity:.6"' : '') + '><td>' + _esc(r.id) + (r.use === false ? ' <span class="wp-chip">not used</span>' : '') + '</td>' + codes.map(function (c) {
                        var k = byC[c] || { st: 'na', msg: '' };
                        return '<td class="qc"><span class="wp-qcb ' + _esc(k.st) + '" title="' + _esc(k.msg) + '" aria-label="' + _esc((lab[c] || c) + ': ' + k.st + '. ' + k.msg) + '">' + QC_SYM[k.st] + '</span></td>';
                    }).join('') + '<td class="num"><span class="wp-score" style="color:var(--' + (r.score >= 90 ? 'green' : r.score >= 70 ? 'yellow' : 'red') + ')">' + _fmt(r.score, 0) + '</span></td><td class="num">' + _fmt(r.rank, 0) + '</td></tr>';
                }).join('') + '</tbody></table></div><div class="wp-hint">Hover a chip for the check. ✓ passed · ! warning · ✕ failed · – not applicable. Score = 100 − 30 per failure − 10 per warning.</div>');
            qc.rows.forEach(function (r) { (r.flags || []).forEach(function (f) { if (f.sev === 'warn' || f.sev === 'fail') out.push(_vHtml({ st: f.sev, t: (f.sev === 'fail' ? '✗ ' : '⚠ ') + r.id + ' · ' + (lab[f.code] || f.code) + ': ' + f.msg })); }); });
        } else if (qc) out.push(_vHtml({ st: 'warn', t: '⚠ ' + (((qc && qc.errors) || [])[0] || 'The QC engine is not available yet.') }));
        // correlation comparison: plot (left) and ranking (right)
        var rk = '';
        if (cmp && cmp.ok !== false && Array.isArray(cmp.rows)) {
            var maxE = 0; cmp.rows.forEach(function (r) { if (_fin(r.errPct)) maxE = Math.max(maxE, Math.abs(r.errPct)); });
            rk = '<div class="rbox-title">Correlation ranking — ' + _esc(tid) + (m.all ? ' (RMS)' : '') + '</div><div class="wp-tw"><table class="dtable"><thead><tr><th>#</th><th>Correlation</th>' + (m.all ? '' : '<th>Calculated (' + _lab('pressure', 'psia') + ')</th>') + '<th>' + (m.all ? 'RMS error' : 'Error') + ' (' + _lab('pressure', 'psi') + ')</th><th>Error %</th><th></th></tr></thead><tbody>' +
                cmp.rows.map(function (r) {
                    var e = _fin(r.errPct) ? r.errPct : null, w = e == null || !(maxE > 0) ? 0 : Math.min(100, 100 * Math.abs(e) / maxE), col = e == null ? 'text3' : Math.abs(e) <= 5 ? 'green' : Math.abs(e) <= 10 ? 'yellow' : 'red';
                    return '<tr><td>' + r.rank + '</td><td>' + _esc((reg[r.corr] && reg[r.corr].label) || r.label || r.corr) + (r.verified ? '' : ' <span class="wp-chip prov" title="' + _esc(r.provisional || '') + '">provisional</span>') + '</td>' +
                        (m.all ? '' : '<td class="num">' + (r.pCalc == null ? 'lost' : _fmt(_dv(r.pCalc, 'pressure'), 0)) + '</td>') + '<td class="num">' + (r.err == null ? '—' : _fmt(_dv(r.err, 'pressure'), 0)) + '</td><td class="num">' + (e == null ? '—' : _fmt(e, 1)) + '</td>' +
                        '<td><div class="wp-bar" aria-hidden="true"><i style="left:0;width:' + w.toFixed(1) + '%;background:var(--' + col + ')"></i></div></td></tr>';
                }).join('') + '</tbody></table></div>' + (cmp.gauge ? '<div class="wp-hint">Gauge ' + _u(cmp.gauge.p, 'pressure', 0, 'psia') + ' at ' + _u(cmp.gauge.md, 'length', 0, 'ft') + ' MD / ' + _u(cmp.gauge.tvd, 'length', 0, 'ft') + ' TVD; each correlation is marched down from the THP along the surveyed path at the test rates.</div>' : '');
        } else rk = _vHtml({ st: 'warn', t: '⚠ ' + (((cmp && cmp.errors) || [])[0] || 'The comparison engine is not available yet.') });
        var dax = _plots().mdepth === 'md' ? 'md' : 'tvd';
        out.push('<div class="wp-mres"><div class="wp-card" style="margin:0"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px"><div class="rbox-title" style="margin:0">Traverses against the gauge</div><div class="wp-tabs rp-skip" id="wp_mdepth" style="margin-left:auto" role="group" aria-label="Depth axis"><button type="button" data-mdepth="tvd" class="' + (dax === 'tvd' ? 'on' : '') + '">TVD</button><button type="button" data-mdepth="md" class="' + (dax === 'md' ? 'on' : '') + '">MD</button></div></div>' +
            '<div class="chart-wrap"><canvas id="wp_cv_match" tabindex="0" aria-label="Correlation comparison: pressure against depth for each correlation, with the measured gauge and wellhead pressures"></canvas></div><div class="wp-hint">Click a legend entry to hide a correlation; wheel or pinch to zoom, drag to pan, double-click to reset.</div></div><div>' + rk + '</div></div>');
        // back-calculated inflow value
        var NAME = { pr: 'reservoir pressure p̄r', J: 'productivity (PI equivalent)', S: 'skin S' };
        if (ip && ip.ok !== false && _fin(ip.value)) {
            var vtxt = m.solveFor === 'pr' ? _u(ip.value, 'pressure', 0, 'psia') : m.solveFor === 'J' ? (_isGasType((ST.M || {}).fluid && ST.M.fluid.type) ? _fmt(ip.value, 3) + ' Mscf/d/psi' : _u(ip.value, 'productivityIndex', 3, 'STB/d/psi')) : _fmt(ip.value, 2);
            var ids = Object.keys(ip.adopt || {}), vs = ids.map(function (k) { return ip.adopt[k]; });
            out.push(_vHtml({ st: 'ok', t: '✓ Back-calculated ' + NAME[m.solveFor] + ' from test ' + (ST.match.all ? (ST.match.compare && ST.match.compare.tests ? ST.match.compare.tests[0] : '') : ST.match.test) + ': ' + vtxt + ' (pwf ' + _u(ip.pwf, 'pressure', 0, 'psia') + ' at the mid-perforations, ' + ip.method + (ip.param && ip.param !== 'pr' && ip.param !== m.solveFor ? '; model coefficient ' + ip.param : '') + ').' }) +
                (ids.length ? '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="adopt" data-ids="' + _esc(ids.join(',')) + '" data-vs="' + _esc(vs.join(',')) + '">Adopt into step ②</button></div>' : ''));
        } else if (ip) out.push(_vHtml({ st: 'warn', t: '⚠ Back-calculation: ' + (((ip && ip.errors) || [])[0] || 'not available.') }));
        h.innerHTML = out.join('');
        _drawMatchPlot();
    }
    function _drawMatchPlot() {
        var cv = _byId('wp_cv_match'), V = G.WTS_wp_view, m = ST.match; if (!cv || !V || !m) return;
        var T = V.theme(), dax = _plots().mdepth === 'md' ? 'md' : 'tvd', dl = _lab('length', 'ft'), cmp = m.compare;
        var pal = [T.accent, T.blue, T.purple, T.green, T.yellow, T.red, T.text2];
        var dk = function (r) { return _dv(dax === 'md' ? r.md : (_fin(r.tvd) ? r.tvd : r.md), 'length'); };
        var ser = [], markers = [], reg = G.WTS_flowline_corr || {};
        if (cmp && cmp.ok !== false && !m.all) {
            (cmp.rows || []).forEach(function (r, i) { if (r.profile && r.profile.length) ser.push({ key: r.corr, label: ((reg[r.corr] && reg[r.corr].label) || r.corr).replace(/\s*\(.*$/, '') + (r.verified ? '' : ' (prov.)'), color: pal[i % pal.length], width: i === 0 ? 2.6 : 1.8, dash: r.verified ? null : [6, 3], pts: r.profile.map(function (p) { return [_dv(p.p, 'pressure'), dk(p)]; }) }); });
            if (cmp.gauge) markers.push({ x: _dv(cmp.gauge.p, 'pressure'), y: dk(cmp.gauge), kind: 'diamond', color: T.green, r: 7, label: 'Gauge' });
            if (_fin(cmp.thp)) markers.push({ x: _dv(cmp.thp, 'pressure'), y: 0, kind: 'filled', color: T.text, r: 5, label: 'THP' });
        }
        var ip = m.ipr;
        if (ip && ip.ok !== false && _fin(ip.pwf) && ST.SC && ST.SC.perfs && _fin(ST.SC.perfs.midMd)) markers.push({ x: _dv(ip.pwf, 'pressure'), y: _dv(dax === 'md' ? ST.SC.perfs.midMd : (_fin(ST.SC.perfs.midTvd) ? ST.SC.perfs.midTvd : ST.SC.perfs.midMd), 'length'), kind: 'hollow', color: T.accent, r: 6, label: 'pwf' });
        V.chart(cv, { key: 'match:' + dax + (_metric() ? 'm' : 'i'), aspect: 0.72, minH: 260, maxH: 460, w: 560, readout: 'y',
            x: { label: 'Pressure (' + _lab('pressure', 'psia') + ')', short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
            y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + dl + ')', invert: true, min: 0, short: 'Depth', fmtR: function (v) { return _depthPair(v, dax); } },
            series: ser, markers: markers, hidden: _plots().mHidden || null, onLegend: function (hid) { _plotsSet({ mHidden: hid }); },
            empty: m.all ? 'Pick one test to see its traverses (the RMS ranking is on the right).' : 'The traverses appear when the comparison has a gauge pressure.' });
    }
    // ── VLP tuning (WP17, A2; plan §5.2, D10) ────────────────────────────────
    // WTS_wp_match.tuneJob fits the holdup multiplier m_h (and the friction multiplier m_f when the used tests span ≥ 2:1 in rate)
    // with PRiSM_lm against the gauge pressures; the result card shows the multipliers as KPI chips, the flags, the parameter
    // correlation, the residual table, the tuned against the untuned traverses with the gauges (drag the m_h / m_f rails: the test
    // traverses re-march live, the release writes the multiplier and the well re-solves) and the RMS objective along m_h. "Apply"
    // writes wp_mult_hl / wp_mult_f through the normal input path (autosave, report, one solve); "Reset" writes 1 / 1. With
    // multipliers in the model the system plot and the traverse also show the untuned curves (m = 1) for comparison.
    function _fx(v, d) { if (!_fin(v)) return '—'; var t = Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); return t === '-0' ? '0' : t; }
    function _multOf(M) { var m = M && M.system && M.system.mult; var hl = m && _fin(+m.hl) ? +m.hl : 1, f = m && _fin(+m.f) ? +m.f : 1; return { hl: hl, f: f, tuned: hl !== 1 || f !== 1 }; }
    function _tuneCorr(M) { var v = (_byId('wpv_tcorr') || {}).value; if (v) return v; var c = M && M.system && M.system.corr && M.system.corr.well; if (c) return c; var R = ST.R; return R && R.corr && R.corr.well ? R.corr.well : 'bb'; }
    function _tuneBand(v) { return v < 0.9 || v > 1.1 ? 'warn' : 'ok'; }
    function _tuneAct(act) {
        var M = ST.M || _read(), h = _byId('wp_tuneres'); if (!M) return;
        if (act === 'tune') {
            var tests = _matchTests(M), fr = (_byId('wpv_tfree') || {}).value || 'auto';
            if (!tests.length) { if (h) h.innerHTML = _vHtml({ st: 'info', t: 'ℹ Add a production test with a gauge depth and pressure first.' }); return; }
            var corr = _tuneCorr(M), o = { start: { hl: 1, f: 1 } };
            if (fr === 'hl') o.free = ['hl']; else if (fr === 'hlf') o.free = ['hl', 'f'];
            _drive(_jobOf(_call('WTS_wp_match.tuneJob', M, tests, corr, o)), function (r) {
                ST.tune = r && typeof r === 'object' ? r : null; ST.tuneTests = tests; ST.tunePrev = null; ST.tuneKey = _mkeyU(M);
                if (G.WTS_state && G.WTS_state.wellperf) G.WTS_state.wellperf.tune = _tuneSummary();
                _renderTune(); _renderDots();
            }, 'VLP tuning', 'wp_tunebox');
            return;
        }
        if (act === 'tuneapply' || act === 'tunereset') {
            var r = ST.tune, v = act === 'tunereset' ? { hl: 1, f: 1 } : (r && r.ok ? r.mult : null); if (!v) return;
            _setCtrl('wp_mult_hl', +(+v.hl).toPrecision(6), true); _setCtrl('wp_mult_f', +(+v.f).toPrecision(6), true);
            if (act === 'tuneapply') { var lab = 'tuned to ' + (r.tests || []).slice(0, 3).join(', '); ST.prov.wp_mult_hl = lab; ST.prov.wp_mult_f = lab; }
            else { delete ST.prov.wp_mult_hl; delete ST.prov.wp_mult_f; Array.prototype.forEach.call(document.querySelectorAll('label[for="wp_mult_hl"] .wp-chip,label[for="wp_mult_f"] .wp-chip'), function (c) { if (c.parentNode) c.parentNode.removeChild(c); }); }
            ST.tunePrev = null;
            _syncUi(); _commit('wp_mult_f');
            _renderTune();
        }
    }
    function _tuneSummary() {
        var r = ST.tune; if (!r || !r.ok) return r ? { ok: false, code: r.code || null } : null;
        return { ok: true, corr: r.corr, free: r.free.slice(), mult: { hl: r.mult.hl, f: r.mult.f }, rms: r.rms, rho: r.rho, separable: r.separable, rateSpan: r.rateSpan,
            tests: (r.tests || []).slice(), flags: r.flags.map(function (f) { return f.code; }), applied: (function () { var m = _multOf(ST.M); return Math.abs(m.hl - r.mult.hl) < 1e-5 && Math.abs(m.f - r.mult.f) < 1e-5; })() };
    }
    // the model identity without the multipliers (an untuned reference stays valid while only m_h / m_f change)
    function _mkeyU(M) { if (!M) return ''; try { var s = JSON.parse(JSON.stringify(M.system || {})); delete s.mult; return JSON.stringify([M.fluid, M.res, M.well, M.surface, s, M.lift, M.tests]); } catch (e) { return ''; } }
    // live preview of the test traverses at multipliers m (one compare march per test, ≤ 4 tests)
    function _tunePreview(m) {
        var M = ST.M || _read(), r = ST.tune; if (!M || !r || !r.ok || !ST.tuneTests) return null;
        var ids = (r.profiles || []).map(function (p) { return p.id; }), out = { hl: m.hl, f: m.f, profiles: [] };
        ST.tuneTests.forEach(function (t, i) {
            var id = t.id != null && String(t.id) !== '' ? String(t.id) : 'test ' + (i + 1); if (ids.indexOf(id) === -1 || out.profiles.length >= 4) return;
            var c = _call('WTS_wp_match.compare', M, t, [r.corr], { mult: { hl: m.hl, f: m.f } }), row = c && c.ok && c.rows && c.rows[0];
            out.profiles.push({ id: id, p: row ? row.pCalc : null, err: row ? row.err : null, errPct: row ? row.errPct : null, profile: row ? row.profile : null });
        });
        return out;
    }
    function _tuneHandle(key, v, phase) {
        var r = ST.tune; if (!r || !r.ok) return;
        var cur = ST.tunePrev ? { hl: ST.tunePrev.hl, f: ST.tunePrev.f } : _multOf(ST.M);
        var b = (r.bounds && r.bounds[key]) || [0.5, 2];
        cur[key] = Math.round(Math.min(b[1], Math.max(b[0], v)) * 1000) / 1000;
        if (phase === 'end') {
            _setCtrl('wp_mult_hl', cur.hl, true); _setCtrl('wp_mult_f', cur.f, true);
            var lab = 'set on the tuning plot'; ST.prov.wp_mult_hl = lab; ST.prov.wp_mult_f = lab;
            ST.tunePrev = _tunePreview(cur); _syncUi(); _commit(key === 'f' ? 'wp_mult_f' : 'wp_mult_hl'); _renderTune(); return;
        }
        ST.tunePrev = _tunePreview(cur);
        _renderTuneKpis(); _drawTunePlot(); _drawTuneObj();
    }
    function _renderTuneKpis() {
        var h = _byId('wp_tunekpi'), r = ST.tune; if (!h || !r || !r.ok) return;
        var m = ST.tunePrev ? ST.tunePrev : null, fitF = r.free.indexOf('f') !== -1, mod = _multOf(ST.M);
        var prevRms = null; if (m && m.profiles.length) { var s = 0, n = 0; m.profiles.forEach(function (p) { if (_fin(p.err)) { s += p.err * p.err; n++; } }); prevRms = n ? Math.sqrt(s / n) : null; }
        var k = [];
        k.push(_kpiHtml('Holdup m_h', _fx(r.mult.hl, 3), 'fitted, ' + r.bounds.hl[0] + '–' + r.bounds.hl[1], _tuneBand(r.mult.hl), 'Fitted within the bounds ' + r.bounds.hl[0] + '–' + r.bounds.hl[1] + (r.lm && r.lm.ci95 && r.lm.ci95.hl ? '; 95 % interval ' + _fx(r.lm.ci95.hl[0], 3) + '–' + _fx(r.lm.ci95.hl[1], 3) : '') + '. Outside 0.9–1.1 the correlation is being stretched.'));
        k.push(_kpiHtml('Friction m_f', _fx(r.mult.f, 3), fitF ? 'fitted, ' + r.bounds.f[0] + '–' + r.bounds.f[1] : 'held (rule D10)', fitF ? _tuneBand(r.mult.f) : 'info', fitF ? 'Fitted within the bounds ' + r.bounds.f[0] + '–' + r.bounds.f[1] + '.' : 'Held: m_f is fitted only when the used tests span at least 2:1 in rate (rule D10).'));
        k.push(_kpiHtml('RMS error', _fx(_dv(r.rms.tuned, 'pressure'), 1) + ' ' + _lab('pressure', 'psi'), 'untuned ' + _u(r.rms.untuned, 'pressure', 0, 'psi'), _fin(r.rms.tunedPct) ? (r.rms.tunedPct > 5 ? 'warn' : 'ok') : 'none'));
        k.push(_kpiHtml('|ρ| m_h · m_f', _fin(r.rho) ? _fx(Math.abs(r.rho), 3) : '—', r.separable === false ? 'not separable' : (r.separable ? 'separable' : ''), r.separable === false ? (fitF ? 'warn' : 'info') : (r.separable ? 'ok' : 'none')));
        k.push(_kpiHtml('Rate span', r.nTests > 1 ? _fx(r.rateSpan, 2) + ' : 1' : '—', r.nTests > 1 ? r.nTests + ' tests with a gauge' + (r.rateSpan >= 2 ? '' : ' · below 2:1') : 'one test with a gauge', r.nTests > 1 && r.rateSpan >= 2 ? 'ok' : 'info'));
        if (m) k.push(_kpiHtml('Plot m_h / m_f', _fx(m.hl, 3) + ' / ' + _fx(m.f, 3), _fin(prevRms) ? 'RMS ' + _fx(_dv(prevRms, 'pressure'), 1) + ' ' + _lab('pressure', 'psi') : '', _tuneBand(Math.min(m.hl, m.f)) === 'warn' || _tuneBand(Math.max(m.hl, m.f)) === 'warn' ? 'warn' : 'ok'));
        else k.push(_kpiHtml('Model m_h / m_f', _fx(mod.hl, 3) + ' / ' + _fx(mod.f, 3), (Math.abs(mod.hl - r.mult.hl) < 1e-5 && Math.abs(mod.f - r.mult.f) < 1e-5) ? 'fitted values applied' : (mod.tuned ? 'not the fitted values' : 'untuned'), mod.tuned ? 'info' : 'none'));
        h.innerHTML = k.join('');
    }
    function _renderTune() { _renderTuneBody(); _renderStudies(); }
    function _renderTuneBody() {
        var h = _byId('wp_tuneres'); if (!h) return;
        var r = ST.tune, reg = G.WTS_flowline_corr || {};
        if (!r) { h.innerHTML = ''; return; }
        if (!r.ok) { h.innerHTML = _vHtml({ st: r.code === 'CANCELLED' ? 'info' : 'warn', t: (r.code === 'CANCELLED' ? 'ℹ ' : '⚠ ') + 'VLP tuning: ' + (((r.errors || [])[0]) || 'not available.') }); return; }
        var stale = ST.tuneKey && ST.tuneKey !== _mkeyU(ST.M || _read()) ? '<div class="wp-stalechip" role="status">The tuning is from the previous inputs — tune again</div>' : '';
        var lab = (reg[r.corr] && reg[r.corr].label) || r.label || r.corr, out = [];
        out.push('<div class="rbox-title">VLP tuning — ' + _esc(lab) + (r.verified ? '' : ' <span class="wp-chip prov" title="' + _esc(r.provisional || '') + '">provisional</span>') + '</div>' + stale);
        out.push('<div class="wp-kpis wp-tkpis" id="wp_tunekpi" aria-live="polite"></div>');
        (r.flags || []).forEach(function (f) { if (f.code !== 'PROVISIONAL') out.push(_vHtml({ st: f.sev === 'warn' ? 'warn' : 'info', t: (f.sev === 'warn' ? '⚠ ' : 'ℹ ') + f.msg })); });
        if (!(r.flags || []).some(function (f) { return f.sev === 'warn'; })) out.push(_vHtml({ st: 'ok', t: '✓ Tuned: m_h ' + _fx(r.mult.hl, 3) + ', m_f ' + _fx(r.mult.f, 3) + ' bring the RMS error at the gauge from ' + _u(r.rms.untuned, 'pressure', 0, 'psi') + ' to ' + _fx(_dv(r.rms.tuned, 'pressure'), 1) + ' ' + _lab('pressure', 'psi') + ' (' + r.lm.iterations + ' LM iterations).' }));
        out.push('<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="tuneapply">Apply to the model</button><button type="button" class="btn btn-secondary" data-act="tunereset">Reset to 1 (untuned)</button></div>');
        // plots: traverses (handles) | objective
        out.push('<div class="wp-tplots"><div class="wp-card" style="margin:0"><div class="rbox-title" style="margin:0 0 6px">Tuned and untuned traverses against the gauges</div><div class="chart-wrap"><canvas id="wp_cv_tune" tabindex="0" aria-label="Tuned and untuned pressure traverses against depth for each test, with the gauge pressures; drag the m_h and m_f rails to re-march the tests"></canvas></div>' +
            '<div class="wp-hint rp-skip">Drag <b>m_h</b> or <b>m_f</b> on the top rails: the tests re-march live; on release the multiplier goes into the model and the well re-solves. Keyboard: [ and ] pick a rail, arrows move it, Enter commits.</div></div>' +
            '<div class="wp-card" style="margin:0"><div class="rbox-title" style="margin:0 0 6px">RMS error at the gauge along m_h</div><div class="chart-wrap"><canvas id="wp_cv_tobj" tabindex="0" aria-label="Objective: RMS pressure error at the gauge against the holdup multiplier, with the fitted value and the 0.9 to 1.1 range"></canvas></div>' +
            '<div class="wp-hint">m_f held at ' + _fx(r.mult.f, 3) + '. The shaded band is 0.9–1.1: outside it the correlation is being stretched.</div></div></div>');
        // residuals per test
        out.push('<div class="wp-tw" style="margin-top:10px"><table class="dtable"><thead><tr><th>Test</th><th>Rate</th><th>Gauge MD / TVD (' + _lab('length', 'ft') + ')</th><th>Gauge (' + _lab('pressure', 'psia') + ')</th><th>Untuned</th><th>Error</th><th>Tuned</th><th>Error</th></tr></thead><tbody>' +
            r.residuals.map(function (x) {
                var ec = function (e) { return !_fin(e) ? 'text3' : Math.abs(e) <= 2 ? 'green' : Math.abs(e) <= 5 ? 'yellow' : 'red'; };
                return '<tr><td>' + _esc(x.id) + '</td><td class="num">' + _esc(_isGasType((ST.M || {}).fluid && ST.M.fluid.type) ? _u(x.q, 'gasRateSmall', 0, 'Mscf/d') : _u(x.q, 'liquidRate', 0, 'STB/d')) + '</td><td class="num">' + _fmt(_dv(x.gauge.md, 'length'), 0) + ' / ' + (_fin(x.gauge.tvd) ? _fmt(_dv(x.gauge.tvd, 'length'), 0) : '—') + '</td><td class="num">' + _fmt(_dv(x.gauge.p, 'pressure'), 0) + '</td>' +
                    '<td class="num">' + _fmt(_dv(x.pUntuned, 'pressure'), 0) + '</td><td class="num" style="color:var(--' + ec(x.errPctUntuned) + ')">' + _fmt(_dv(x.errUntuned, 'pressure'), 0) + ' (' + _fmt(x.errPctUntuned, 1) + ' %)</td>' +
                    '<td class="num">' + (_fin(x.pTuned) ? _fmt(_dv(x.pTuned, 'pressure'), 0) : 'lost') + '</td><td class="num" style="color:var(--' + ec(x.errPctTuned) + ')">' + (_fin(x.errTuned) ? _fmt(_dv(x.errTuned, 'pressure'), 1) + ' (' + _fmt(x.errPctTuned, 2) + ' %)' : '—') + '</td></tr>';
            }).join('') + '</tbody></table></div>');
        // parameter correlation matrix (a coloured cell per entry)
        if (r.corrMatrix) {
            var cell = function (v, d) { var a = Math.abs(v), bg = d ? 'var(--bg4)' : (a > 0.9 ? 'rgba(248,81,73,.22)' : a > 0.7 ? 'rgba(210,153,34,.2)' : 'rgba(63,185,80,.16)'); return '<td class="num" style="background:' + bg + ';text-align:center">' + _fx(v, 3) + '</td>'; };
            out.push('<div class="wp-tcorr"><table class="dtable" style="width:auto"><thead><tr><th>Correlation ρ</th><th>m_h</th><th>m_f</th></tr></thead><tbody><tr><td>m_h</td>' + cell(1, true) + cell(r.corrMatrix[0][1]) + '</tr><tr><td>m_f</td>' + cell(r.corrMatrix[1][0]) + cell(1, true) + '</tr></tbody></table>' +
                '<div class="wp-hint">' + (r.corrBasis === 'lm' ? 'From the LM covariance of the two fitted multipliers.' : 'From the Jacobian of both multipliers at the answer (m_h alone is fitted).') + ' |ρ| above 0.9: the two multipliers cannot be separated with these tests.</div></div>');
        }
        h.innerHTML = out.join('');
        _renderTuneKpis(); _drawTunePlot(); _drawTuneObj();
    }
    function _drawTunePlot() {
        var cv = _byId('wp_cv_tune'), V = G.WTS_wp_view, r = ST.tune; if (!cv || !V || !r || !r.ok) return;
        var T = V.theme(), dax = _plots().mdepth === 'md' ? 'md' : 'tvd', pal = [T.accent, T.blue, T.purple, T.green];
        var dk = function (p) { return _dv(dax === 'md' ? p.md : (_fin(p.tvd) ? p.tvd : p.md), 'length'); };
        var ser = [], markers = [], prev = ST.tunePrev, mod = _multOf(ST.M);
        (r.profiles || []).slice(0, 4).forEach(function (p, i) {
            var col = pal[i % pal.length], tag = (r.profiles.length > 1 ? p.id + ' · ' : '');
            if (p.untuned) ser.push({ key: 'u' + i, label: tag + 'untuned (m = 1)', color: T.text2, width: 1.4, dash: [6, 4], pts: p.untuned.map(function (q) { return [_dv(q.p, 'pressure'), dk(q)]; }) });
            if (p.tuned) ser.push({ key: 't' + i, label: tag + 'tuned (fitted)', color: col, width: 2.6, pts: p.tuned.map(function (q) { return [_dv(q.p, 'pressure'), dk(q)]; }) });
            var pv = prev && prev.profiles.filter(function (x) { return x.id === p.id; })[0];
            if (pv && pv.profile) ser.push({ key: 'm' + i, label: tag + 'm_h ' + _fx(prev.hl, 3) + ', m_f ' + _fx(prev.f, 3), color: T.yellow, width: 2, dash: [2, 3], pts: pv.profile.map(function (q) { return [_dv(q.p, 'pressure'), dk(q)]; }) });
            markers.push({ x: _dv(p.gauge.p, 'pressure'), y: dk(p.gauge), kind: 'diamond', color: T.green, r: 7, label: (r.profiles.length > 1 ? p.id + ' ' : '') + 'gauge' });
            if (_fin(p.thp) && i === 0) markers.push({ x: _dv(p.thp, 'pressure'), y: 0, kind: 'filled', color: T.text, r: 5, label: 'THP' });
        });
        var cur = prev ? { hl: prev.hl, f: prev.f } : (mod.tuned ? mod : r.mult);
        var handles = [{ key: 'hl', kind: 'railX', value: cur.hl, min: r.bounds.hl[0], max: r.bounds.hl[1], step: 0.005, label: 'm_h', railLabel: 'm_h', rail: [0, 0.5], color: T.accent, fmt: function (v) { return 'm_h ' + _fx(v, 3); } },
                       { key: 'f', kind: 'railX', value: cur.f, min: r.bounds.f[0], max: r.bounds.f[1], step: 0.005, label: 'm_f', railLabel: 'm_f', rail: [0.5, 1], color: T.purple, fmt: function (v) { return 'm_f ' + _fx(v, 3); } }];
        V.chart(cv, { key: 'tune:' + dax + (_metric() ? 'm' : 'i'), aspect: 0.72, minH: 260, maxH: 440, w: 560, readout: 'y',
            x: { label: 'Pressure (' + _lab('pressure', 'psia') + ')', short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
            y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + _lab('length', 'ft') + ')', invert: true, min: 0, short: 'Depth', fmtR: function (v) { return _depthPair(v, dax); } },
            series: ser, markers: markers, handles: handles, onHandle: _tuneHandle, hidden: _plots().tHidden || null, onLegend: function (hid) { _plotsSet({ tHidden: hid }); },
            empty: 'The traverses appear after a tuning with a gauge pressure.' });
    }
    function _drawTuneObj() {
        var cv = _byId('wp_cv_tobj'), V = G.WTS_wp_view, r = ST.tune; if (!cv || !V || !r || !r.ok) return;
        var T = V.theme(), pts = (r.scan || []).filter(function (s) { return _fin(s.rms); }).map(function (s) { return [s.hl, _dv(s.rms, 'pressure')]; });
        var prev = ST.tunePrev, mod = _multOf(ST.M), cur = prev ? prev.hl : (mod.tuned ? mod.hl : r.mult.hl);
        var prevRms = null; if (prev && prev.profiles.length) { var s2 = 0, n2 = 0; prev.profiles.forEach(function (x) { if (_fin(x.err)) { s2 += x.err * x.err; n2++; } }); prevRms = n2 ? Math.sqrt(s2 / n2) : null; }
        var vl = [{ x: r.mult.hl, color: T.accent, label: 'fitted ' + _fx(r.mult.hl, 3) }, { x: 1, color: T.text2, label: 'published', dash: [2, 4] }];
        if (Math.abs(cur - r.mult.hl) > 1e-4) vl.push({ x: cur, color: T.yellow, label: 'm_h ' + _fx(cur, 3), dash: [4, 3] });
        V.chart(cv, { key: 'tobj' + (_metric() ? 'm' : 'i'), aspect: 0.72, minH: 220, maxH: 400, w: 420, readout: 'x',
            x: { label: 'Holdup multiplier m_h', min: r.bounds.hl[0], max: r.bounds.hl[1], short: 'm_h', fmtR: function (v) { return _fx(v, 3); } },
            y: { label: 'RMS error at the gauge (' + _lab('pressure', 'psi') + ')', min: 0, short: 'RMS', fmtR: function (v) { return _fmt(v, 1) + ' ' + _lab('pressure', 'psi'); } },
            series: [{ key: 'obj', label: 'RMS error', color: T.blue, width: 2.4, pts: pts }, { key: 'objp', label: '', legend: false, kind: 'points', color: T.blue, pts: pts }],
            bands: [{ x0: 0.9, x1: 1.1, color: 'rgba(63,185,80,0.09)', label: '0.9–1.1' }], vlines: vl,
            markers: [{ x: r.mult.hl, y: _dv(r.rms.tuned, 'pressure'), kind: 'filled', color: T.accent, r: 6, halo: true, label: 'LM optimum' }].concat(prevRms != null ? [{ x: prev.hl, y: _dv(prevRms, 'pressure'), kind: 'hollow', color: T.yellow, r: 6, label: '' }] : []),
            handles: [{ key: 'hl', kind: 'railX', value: cur, min: r.bounds.hl[0], max: r.bounds.hl[1], step: 0.005, label: 'm_h', railLabel: 'm_h', rail: [0, 1], color: T.accent, fmt: function (v) { return 'm_h ' + _fx(v, 3); } }],
            onHandle: _tuneHandle, empty: 'The objective appears after a tuning.' });
    }
    // the untuned reference curves (m = 1) of the current model: outflow (or the wellhead inflow) on the coarse grid, the traverse at
    // the operating point and the untuned operating point by interpolation; kept while only the multipliers change
    function _untunedRef() {
        var M = ST.M, R = ST.R; if (!M || !R || !R.ok || !_multOf(M).tuned || ST.slow) return null;
        var k = _mkeyU(M); if (ST.untuned && ST.untuned.key === k) return ST.untuned;
        var Mu = JSON.parse(JSON.stringify(M)); Mu.system = Mu.system || {}; Mu.system.mult = { hl: 1, f: 1 };
        var qs = ((R.curves && R.curves.vlp) || []).map(function (c) { return c.q; }).filter(_fin), q0 = qs.length ? Math.min.apply(null, qs) : null, q1 = qs.length ? Math.max.apply(null, qs) : null;
        var out = { key: k, curve: [], traverse: null, op: null, node: R.node === 'wellhead' ? 'wellhead' : 'bottom' };
        if (_fin(q0) && q1 > q0) for (var i = 0; i <= 7; i++) {
            var q = q0 + (q1 - q0) * i / 7, e = _call('WTS_wp_system.evalAt', Mu, q, { coarse: true });
            if (e && e.ok) out.curve.push({ q: q, pOut: e.pOut, pIn: e.pIn });
        }
        for (var j = 1; j < out.curve.length; j++) {
            var a = out.curve[j - 1], b = out.curve[j], da = a.pOut - a.pIn, db = b.pOut - b.pIn;
            if (_fin(da) && _fin(db) && da <= 0 && db > 0) { var f = da / (da - db); out.op = { q: a.q + f * (b.q - a.q), p: (out.node === 'bottom' ? a.pIn + f * (b.pIn - a.pIn) : a.pOut + f * (b.pOut - a.pOut)) }; }
        }
        var et = _call('WTS_wp_system.evalAt', Mu, R.op.q, {});
        out.traverse = et && et.ok && et.tr && et.tr.profile ? et.tr.profile : null;
        ST.untuned = out;
        return out;
    }

    function _importPrism() {
        var r = _call('WTS_wp_ipr.fromWell'), h = _byId('wp_prismmsg');
        if (!r || r.ok === false) { if (h) h.innerHTML = _vHtml({ st: 'warn', t: '⚠ ' + (((r && r.errors) || [])[0] || 'No PRiSM result to import.') }); return; }
        var sp = r.spec || {}, prov = r.provenance || {}, set = [];
        var put = function (id, v, src) { if (_fin(v) || (typeof v === 'string' && v)) { _setCtrl(id, v, typeof v === 'number'); ST.prov[id] = src || 'PRiSM'; set.push(id); } };
        if (sp.model) put('wp_ipr', sp.model, prov.model);
        put('wp_pr', sp.pr, prov.pr); put('wp_tres', sp.T_F, prov.T_F);
        Object.keys(sp.params || {}).forEach(function (k) { if (IP[k]) put('wp_ip_' + k, sp.params[k], prov[k]); });
        if (h) h.innerHTML = _vHtml({ st: set.length ? 'ok' : 'info', t: set.length ? '✓ Imported ' + set.length + ' value(s) from PRiSM (read only; nothing is written back).' + (sp.pr == null ? ' p̄r was not imported (default provenance): enter it.' : '') : 'ℹ Nothing to import.' });
        _syncUi();
        if (set.length) _commit(set[set.length - 1]);
    }
    function _importDfit() {
        var Mm = G.WTS_wp_model, sel = _byId('wpv_dfit'), h = _byId('wp_dfitmsg');
        if (!Mm || !sel || !sel.value) { if (h) h.innerHTML = _vHtml({ st: 'info', t: 'ℹ No DFIT test with a well record in this project.' }); return; }
        var r = Mm.fromDfit(sel.value);
        if (!r || !r.ok) { if (h) h.innerHTML = _vHtml({ st: 'warn', t: '⚠ ' + ((r && (r.errors || [])[0]) || 'The DFIT test has no survey or strings.') }); return; }
        var mid = r.scalars && _fin(r.scalars.wp_midPerf), w;
        ST.batch = (ST.batch || 0) + (mid ? 1 : 0);          // with a mid-perforation to commit, that commit runs the one solve
        try { w = Mm.write(r.patch); } finally { if (mid) ST.batch--; }
        ST.M = _read() || ST.M;
        if (mid) _setCtrl('wp_midPerf', r.scalars.wp_midPerf, true);
        ['survey', 'strings'].forEach(_renderTable);
        if (h) h.innerHTML = _vHtml({ st: w && w.ok ? 'ok' : 'warn', t: w && w.ok ? '✓ Well geometry imported from DFIT test ' + sel.value + ' (' + (r.patch.survey || []).length + ' survey stations, ' + (r.patch.strings || []).length + ' strings).' : '⚠ The import was not saved.' });
        if (r.scalars && _fin(r.scalars.wp_midPerf)) _commit('wp_midPerf');
    }
    function _loadExample(k) {
        var ex = EXAMPLES[k], Mm = G.WTS_wp_model; if (!ex || !Mm) return;
        var conf = (typeof G.confirm === 'function') ? G.confirm('Load the example "' + ex.label + '"? It replaces this well\'s Well Performance inputs.') : true;
        if (!conf) return;
        // the table write is batched (its model-changed event does not solve): the one committed change below runs the one solve
        ST.batch = (ST.batch || 0) + 1;
        var tb = JSON.parse(JSON.stringify(ex.tables));
        if (tb.pump === 'example') tb.pump = G.WTS_wp_esp && typeof G.WTS_wp_esp.example === 'function' ? G.WTS_wp_esp.example() : null;   // B (WP26): the generic example pump
        try { Mm.write(tb); } finally { ST.batch--; }
        ST.M = _read() || ST.M;
        // B (WP26): an example without a lift type leaves an ESP selection behind it (its pump belongs to the ESP example)
        if (!('wp_lift' in ex.scalars) && (_byId('wp_lift') || {}).value === 'esp') _setCtrl('wp_lift', 'none', false);
        // B (WPI3): a control that another example sets but this one does not goes back to its page default, so an example
        // loads the same state whatever was loaded before it (e.g. the injector's THP after the Oil example); wp_lift keeps the rule above
        var dflt = {};
        Object.keys(EXAMPLES).forEach(function (k2) { Object.keys(EXAMPLES[k2].scalars || {}).forEach(function (id) { if (id !== 'wp_lift' && !(id in ex.scalars)) dflt[id] = 1; }); });
        Object.keys(dflt).forEach(function (id) {
            var e = _byId(id); if (!e || e.type === 'checkbox') return;
            var d = e.tagName === 'SELECT' ? (Array.prototype.filter.call(e.options || [], function (o) { return o.defaultSelected; })[0] || (e.options || [])[0] || { value: '' }).value : e.defaultValue;
            if (d != null && String(e.value) !== String(d)) e.value = String(d);
        });
        // the study lists suggested for the previous model are suggested again for the example (empty → re-suggested on render)
        ['wpv_fc_steps', 'wpv_mxv1', 'wpv_mxv2', 'wpv_mxv3', 'wpv_mxv4'].forEach(function (id) { var e = _byId(id); if (e) e.value = ''; });
        Object.keys(ex.scalars).forEach(function (id) { _setCtrl(id, ex.scalars[id], typeof ex.scalars[id] === 'number'); });
        ST.sens = null; ST.beans = null; ST.match = null; ST.prov = {};
        _renderAllTables();
        _syncUi();
        _commit('wp_ftype');
        // the sensitivity values were suggested for the previous model (review fix): suggest them again for the example
        _sensSuggest(1); _sensSuggest(2);
        // the gas-lift example designs its valves straight away (a Job through the driver, like the button)
        if (ex.design) { var gx = (G.WTS_wellperf_ext || {}).gldesign; if (gx && typeof gx.act === 'function' && ST.R && ST.R.ok) { _goStep(4, false); gx.act('wpg_design', null); } }
    }
    function _addRow(t) {
        var tbl = _byId('wp_tbl_' + t), tb = tbl && tbl.querySelector('tbody'); if (!tb) return;
        var n = tb.querySelectorAll('tr').length, M = ST.M || _read(), cols = TABLES[t](M);
        var ex = _extraCols(t, M), extra = ex ? ex.n : 0;
        tb.insertAdjacentHTML('beforeend', '<tr data-r="' + n + '">' + cols.map(function (c) {
            if (c.opts) return '<td><select data-t="' + t + '" data-c="' + c.k + '" aria-label="' + _esc(c.l) + '">' + c.opts.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select></td>';
            return '<td><input data-t="' + t + '" data-c="' + c.k + '" aria-label="' + _esc(c.l) + '" ' + (c.text ? 'type="text"' : 'type="number" step="any" inputmode="decimal"') + ' value=""></td>';
        }).join('') + new Array(extra + 1).join('<td class="ro">—</td>') + '<td><button type="button" class="btn btn-secondary wp-del" data-del="' + t + '" data-r="' + n + '" aria-label="Delete row" title="Delete row">&#10005;</button></td></tr>');
        var first = tb.querySelector('tr[data-r="' + n + '"] input, tr[data-r="' + n + '"] select'); if (first && first.focus) first.focus();
    }
    function _pasteApply(t) {
        var ta = _byId('wp_pastet_' + t), M = ST.M || _read(), cols = TABLES[t](M); if (!ta) return;
        var lines = String(ta.value || '').split(/\r?\n/), rows = [], odd = 0;
        var dc = !!(G.WTS_a11y && typeof G.WTS_a11y.decimalComma === 'function' && G.WTS_a11y.decimalComma());
        lines.forEach(function (ln) {
            var cells = _pasteCells(ln, dc);
            if (!cells.length || !cells.some(function (x) { return /^[-+]?\d/.test(x) || /^[-+]?[.,]\d/.test(x); })) return;      // header lines are skipped
            if (cells.length !== cols.length) odd++;
            var arr = cols.every(function (c) { return typeof c.k === 'number'; }), row = arr ? [] : {};
            cols.forEach(function (c, i) { var raw = cells[i]; if (c.opts || c.text) row[c.k] = raw == null ? (c.opts ? c.opts[0][0] : '') : raw; else { var v = _pasteNum(raw, dc); row[c.k] = _fin(v) ? (c.pct ? v / 100 : _fromDisp(v, _cCat(c, row))) : null; } });
            rows.push(row);
        });
        var r = _writeTable(t, rows), msg = _byId('wp_pastemsg_' + t);
        var oddTxt = odd ? ' ⚠ ' + odd + ' row(s) had ' + 'a different number of cells than the ' + cols.length + ' columns: check the columns.' : '';
        if (msg) msg.innerHTML = _vHtml({ st: r && r.ok && !odd ? 'ok' : 'warn', t: r && r.ok ? (odd ? '⚠ ' : '✓ ') + rows.length + ' row(s) pasted' + ((r.warnings || []).length ? ' — ' + r.warnings.map(function (w) { return w.msg; }).join(' ') : '.') + oddTxt : '⚠ Nothing was pasted.' });
        ta.value = '';
        var p = _byId('wp_paste_' + t); if (p && p.classList) p.classList.remove('on');
        _renderTable(t);
    }
    // switching the survey form converts the stations (no rows are lost): MD·Inc·Azi → MD·TVD from the minimum-curvature stations;
    // MD·TVD → MD·Inc·Azi with the inclination of each straight segment and the last known azimuth. The previous rows stay one click
    // away (Undo) in the message under the table — no browser confirm.
    // one pasted line → cells. A row with tabs or semicolons is split on those only (so "30,5" stays one decimal-comma cell);
    // otherwise commas between numbers split cells unless the app's decimal-comma setting is on, and runs of spaces split cells.
    function _pasteCells(ln, dc) {
        ln = String(ln || '').trim(); if (!ln) return [];
        var parts;
        if (/\t/.test(ln)) parts = ln.split('\t');
        else if (/;/.test(ln)) parts = ln.split(';');
        else if (!dc && /,/.test(ln)) parts = ln.split(/\s*,\s*/);
        else parts = ln.split(/\s+/);
        return parts.map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
    }
    function _pasteNum(raw, dc) {
        var t = String(raw == null ? '' : raw).trim(); if (t === '') return NaN;
        if (dc) return (G.WTS_a11y && typeof G.WTS_a11y.parseNumber === 'function') ? G.WTS_a11y.parseNumber(t.replace(/\.(?=\d{3}(\D|$))/g, '')) : parseFloat(t.replace(/\./g, '').replace(',', '.'));
        if (/^[-+]?\d*,\d+$/.test(t) && !/^[-+]?\d{1,3}(,\d{3})+$/.test(t)) return parseFloat(t.replace(',', '.'));     // "30,5" in a tab / semicolon row
        return parseFloat(t.replace(/,(?=\d{3}(\D|$))/g, ''));
    }
    function _surveyConvert(rows, to) {
        if (!rows.length) return [];
        if (to === 'mdtvd') {
            var W = ST.W, stn = (W && W.ok && Array.isArray(W.stations)) ? W.stations : [];
            var tvdOf = function (md) { var s0 = stn.filter(function (x) { return Math.abs(x.md - md) < 0.01; })[0]; return s0 ? s0.tvd : _tvdAt(md); };
            var out = rows.map(function (r) { var tv = tvdOf(r[0]); return [r[0], _fin(tv) ? Math.round(tv * 100) / 100 : null]; });
            return out.some(function (r) { return !_fin(r[1]); }) ? null : out;
        }
        var azi = _fin(_plots().surveyAzi) ? _plots().surveyAzi : 0, res = [[rows[0][0], 0, azi]];
        for (var i = 1; i < rows.length; i++) {
            var dmd = rows[i][0] - rows[i - 1][0], dtv = rows[i][1] - rows[i - 1][1];
            var inc = dmd > 0 ? Math.acos(Math.max(-1, Math.min(1, dtv / dmd))) * 180 / Math.PI : 0;
            res.push([rows[i][0], Math.round(inc * 100) / 100, azi]);
        }
        return res;
    }
    function _surveyModeSet(m, rowsOverride) {
        var M = ST.M || _read(), cur = _surveyMode(M);
        if (m === cur && !rowsOverride) return;
        var old = (M.well.survey || []).map(function (r) { return r.slice(); }), msg = _byId('wp_svmsg');
        var conv = rowsOverride || _surveyConvert(old, m);
        if (old.length && !conv) { if (msg) msg.innerHTML = _vHtml({ st: 'warn', t: '⚠ The survey cannot be converted until the well solves (TVD of every station). Fix the survey first.' }); return; }
        if (cur === 'mdinc' && old.length && old[old.length - 1].length >= 3 && _fin(old[old.length - 1][2])) _plotsSet({ surveyAzi: old[old.length - 1][2] });
        _plotsSet({ surveyMode: m });
        ST.svUndo = rowsOverride ? null : { mode: cur, rows: old };
        if (old.length || conv.length) _writeTable('survey', conv);
        ST.M = _read();
        _renderTable('survey'); _renderSvMode();
        if (msg) msg.innerHTML = rowsOverride ? _vHtml({ st: 'info', t: 'ℹ The previous survey rows are back.' }) : (old.length ? _vHtml({ st: 'ok', t: '✓ ' + conv.length + ' station(s) converted to ' + (m === 'mdtvd' ? 'MD · TVD' : 'MD · Inc · Azi') + '.' }) + '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="svundo">Undo</button></div>' : '');
    }
    function _renderSvMode() { var m = _surveyMode(ST.M || _read()); Array.prototype.forEach.call(document.querySelectorAll('#wp_svmode button'), function (b) { if (b.classList) b.classList.toggle('on', b.getAttribute('data-m') === m); }); }
    function _renderAllTables() { ['survey', 'strings', 'restrictions', 'geo', 'hlayers', 'flowline', 'tests', 'layers', 'lab', 'rv', 'emul', 'corrSections'].forEach(_renderTable); _labInputsFill(); _renderRatings(); _renderSvMode(); _renderDfitList(); _syncMatchTests(); }
    function _renderRatings() {
        var M = _read(); if (!M) return;
        var a = _byId('wpt_rate_wh'), b = _byId('wpt_rate_tht'), c = _byId('wpt_beans');
        if (a) a.value = _fin(M.surface.rating.wellhead_psi) ? String(Math.round(_dv(M.surface.rating.wellhead_psi, 'pressure'))) : '';
        if (b) b.value = _fin(M.surface.rating.tht_max_F) ? String(Math.round(_dv(M.surface.rating.tht_max_F, 'temperature'))) : '';
        if (c) c.value = (M.surface.beans || []).join(' ');
    }
    function _renderDfitList() {
        var sel = _byId('wpv_dfit'), Mm = G.WTS_wp_model; if (!sel || !Mm || typeof Mm.dfitTests !== 'function') return;
        var list = []; try { list = Mm.dfitTests() || []; } catch (e) { list = []; }
        sel.innerHTML = list.length ? list.map(function (t) { return '<option value="' + _esc(t.id) + '">' + _esc(t.id + (t.zone ? ' — ' + t.zone : '') + ' (' + t.survey + ' stations, ' + t.strings + ' strings)') + '</option>'; }).join('') : '<option value="">No DFIT test in this well</option>';
    }

    // CSV (display units, unit headers)
    function _csv() {
        var R = ST.R, rc = _rateCat(), L = [];
        var q = function (s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        L.push('Well Performance (Nodal Analysis)');
        if (R && R.ok) {
            L.push(''); L.push('Operating point'); L.push(['Rate (' + _lab(rc[0], rc[1]) + ')', 'pwf (' + _lab('pressure', 'psia') + ')', 'Stable'].map(q).join(','));
            L.push([_dv(R.op.q, rc[0]), _dv(R.op.p, 'pressure'), R.op.stable].join(','));
            L.push(''); L.push('Traverse'); L.push(['MD (' + _lab('length', 'ft') + ')', 'TVD (' + _lab('length', 'ft') + ')', 'Inclination (deg)', 'p (' + _lab('pressure', 'psia') + ')', 'T (' + _lab('temperature', '°F') + ')', 'Holdup', 'vm (' + _lab('velocity', 'ft/s') + ')', 'Pattern'].map(q).join(','));
            ((R.traverse && R.traverse.profile) || []).forEach(function (r) { L.push([_dv(r.md, 'length'), _dv(r.tvd, 'length'), r.inc, _dv(r.p, 'pressure'), _dv(r.t, 'temperature'), r.hl, _dv(r.vm, 'velocity'), q(r.pattern)].join(',')); });
            L.push(''); L.push('Breakdown'); (R.breakdown || []).forEach(function (b) { L.push([q(BD_LABEL[b.key] || b.key), _dv(b.dp, 'pressure')].join(',')); });
            var C = _curves(); L.push(''); L.push('System curves'); L.push(['Rate', 'IPR pwf', 'Outflow pwf'].map(q).join(','));
            C.ipr.forEach(function (p, i) { L.push([_dv(p[0], rc[0]), _dv(p[1], 'pressure'), C.vlp[i] && Math.abs(C.vlp[i][0] - p[0]) < 1e-9 ? _dv(C.vlp[i][1], 'pressure') : ''].join(',')); });
        }
        if (ST.sens && ST.sens.two && ST.sens.grid) {
            var s2 = ST.sens, g2 = s2.grid;
            L.push(''); L.push(q('Sensitivity: rate (' + _lab(rc[0], rc[1]) + '), rows ' + _sensVarLabel(s2.key2) + ', columns ' + _sensVarLabel(s2.key)));
            L.push([''].concat(g2.x.map(function (x, i) { return g2.labelsX[i] || _sensDv(s2.key, x); })).map(q).join(','));
            g2.y.forEach(function (y, j) { L.push([q(g2.labelsY[j] || _sensDv(s2.key2, y))].concat(g2.q[j].map(function (v) { return _fin(v) ? _dv(v, rc[0]) : ''; })).join(',')); });
        } else if (ST.sens && ST.sens.cases) {
            var sk = ST.sens.key;
            L.push(''); L.push(q('Sensitivity: ' + _sensVarLabel(sk)));
            L.push([_sensVarLabel(sk), 'Rate (' + _lab(rc[0], rc[1]) + ')', 'q_o (' + _lab('liquidRate', 'STB/d') + ')', 'q_w (' + _lab('liquidRate', 'BWPD') + ')', 'q_g (' + _lab('gasRateSmall', 'Mscf/d') + ')',
                'pwf (' + _lab('pressure', 'psia') + ')', 'THP (' + _lab('pressureG', 'psig') + ')', 'THT (' + _lab('temperature', '°F') + ')', 'Stable', 'Loading margin (%)', 'Note'].map(q).join(','));
            ST.sens.cases.forEach(function (c) { var R = c.R || {}; L.push([q(c.label || _sensDv(sk, _sensVal(c))), _dv(R.q, rc[0]), _dv(R.qo, 'liquidRate'), _dv(R.qw, 'liquidRate'), _dv(R.qg, 'gasRateSmall'), _dv(R.pwf, 'pressure'), _dv(R.thp, 'pressureG'), _dv(R.tht, 'temperature'),
                R.ok ? R.stable : '', _fin(R.loadingMargin) ? 100 * R.loadingMargin : '', q(R.ok ? (R.regime || '') : (R.error || R.code || ''))].map(function (x) { return x == null ? '' : x; }).join(',')); });
            var fam = ST.sens.cases.filter(function (c) { return c.R && Array.isArray(c.R.curve) && c.R.curve.length; });
            if (fam.length) {
                L.push(''); L.push(q('Sensitivity family curves (' + (ST.sens.family === 'ipr' ? 'inflow' : 'outflow') + ')')); L.push([_sensVarLabel(sk), 'Rate (' + _lab(rc[0], rc[1]) + ')', 'pwf (' + _lab('pressure', 'psia') + ')'].map(q).join(','));
                fam.forEach(function (c) { var lab = q(c.label || _sensDv(sk, _sensVal(c))); c.R.curve.forEach(function (p) { L.push([lab, _dv(p.q, rc[0]), _dv(p.p, 'pressure')].join(',')); }); });
            }
        }
        if (ST.gl && ST.gl.points) {
            L.push(''); L.push('Gas-lift performance curve');
            L.push(['q_inj (' + _lab('gasRateSmall', 'Mscf/d') + ')', 'q_L (' + _lab('liquidRate', 'STB/d') + ')', 'pwf (' + _lab('pressure', 'psia') + ')', 'THP (' + _lab('pressureG', 'psig') + ')', 'Injection MD (' + _lab('length', 'ft') + ')', 'Injection TVD (' + _lab('length', 'ft') + ')', 'Stable', 'Note'].map(q).join(','));
            ST.gl.points.forEach(function (p) { L.push([_dv(p.qinj, 'gasRateSmall'), p.ok ? _dv(p.qL, 'liquidRate') : '', p.ok ? _dv(p.pwf, 'pressure') : '', p.ok ? _dv(p.thp, 'pressureG') : '', _fin(p.injMd) ? _dv(p.injMd, 'length') : '', _fin(p.injTvd) ? _dv(p.injTvd, 'length') : '', p.ok ? p.stable : '', q(p.ok ? (p.atPacker ? 'packer' : '') : (p.error || p.code || ''))].join(',')); });
        }
        var pmc = ST.pvtm && ST.pvtm.fit && ST.pvtm.fit.ok ? ST.pvtm.fit : null;
        if (pmc) {
            L.push(''); L.push(q('PVT lab match at ' + _u(pmc.T_F, 'temperature', 0, '°F') + ' (lab basis ' + pmc.basis + (pmc.flash.applied ? ', adjusted to flash' : '') + ')'));
            L.push(['p (' + _lab('pressure', 'psia') + ')', 'Rs lab', 'Rs correlation', 'Rs matched', 'Bo lab', 'Bo correlation', 'Bo matched', 'muo lab (cp)', 'muo correlation', 'muo matched'].map(q).join(','));
            var gv = function (o, k) { var v = o && o[k]; return _fin(v) ? (k === 'rs' ? _dv(v, 'gor') : v) : ''; };
            pmc.points.forEach(function (x) { L.push([_dv(x.p, 'pressure'), gv(x.lab, 'rs'), gv(x.before, 'rs'), gv(x.after, 'rs'), gv(x.lab, 'bo'), gv(x.before, 'bo'), gv(x.after, 'bo'), gv(x.lab, 'muo'), gv(x.before, 'muo'), gv(x.after, 'muo')].join(',')); });
            L.push(['property', 'a', 'b', 'points', 'error before (%)', 'error after (%)'].map(q).join(','));
            Object.keys(pmc.props).forEach(function (k) { var x = pmc.props[k]; L.push([k, x.a, k === 'rs' ? _dv(x.b, 'gor') : x.b, x.n, x.mareBefore, x.mareAfter].join(',')); });
        }
        if (G.WTS_wp_wellsUi) L = L.concat(G.WTS_wp_wellsUi.csvLines(q));                                  // B (WP28): all wells
        if (ST.beans && ST.beans.rows) { L.push(''); L.push('Bean schedule'); ST.beans.rows.forEach(function (b) { L.push([b.bean, _dv(b.q, rc[0]), _dv(b.thp, 'pressureG'), _dv(b.tht, 'temperature'), b.stable].join(',')); }); }
        _ext('csv').forEach(function (ls) { (Array.isArray(ls) ? ls : [ls]).forEach(function (l) { if (l != null && l !== '') { L.push(''); L.push(String(l)); } }); });
        var csv = L.join('\n');
        ST.lastCsv = csv;
        try {
            var blob = new Blob([csv], { type: 'text/csv' }), a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = 'well_performance_' + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
            if (URL.revokeObjectURL) URL.revokeObjectURL(a.href);
        } catch (e) { /* no download in this environment */ }
        return csv;
    }

    // ── increment B inflow (WP24): water-cut composite, horizontal, fractured, transient, multilayer with crossflow, injector ──
    // Every model is drawn from the engine's I object (WTS_wp_ipr.curve) and the solver's R (WTS_wp_system.solve → WTS_wp_inj for
    // injectors); the page adds no numerics of its own beyond re-evaluating the inflow (no march) for the study curves. The step ②
    // "Inflow study" plot carries a drag handle on the natural variable of the model (flowing time, lateral length, half-length,
    // water cut, injection pressure) that re-solves the well live, like the system plot.
    function _isInj(M) { var t = M && M.fluid && M.fluid.type; return t === 'waterinj' || t === 'gasinj'; }
    function _injR() { var R = ST.R; return !!(R && R.injector); }
    function _injRateCat() { return (ST.M && ST.M.fluid.type === 'gasinj') ? ['gasRateSmall', 'Mscf/d'] : ['liquidRate', 'BWPD']; }
    // the IPR of one parameter value (no march; the model's other inputs held)
    function _iprWith(patch) {
        var M = ST.M; if (!M || !_fn('WTS_wp_ipr.curve')) return null;
        var spec = JSON.parse(JSON.stringify(M.res)); spec.params = Object.assign({}, spec.params || {}, patch);
        var W = ST.W, o = W && W.ok ? { tvdAt: W.tvdAt, refMd: W.nodes ? W.nodes.midPerfMd : null } : undefined;
        var I = _call('WTS_wp_ipr.curve', spec, ST.F && ST.F.ok ? ST.F : undefined, o);
        return I && I.ok ? I : null;
    }
    // extra series and lines of the step ② IPR plot for the B models
    function _iprBExtras(I, X, Y, Tm) {
        var out = { series: [], hlines: [], vlines: [], markers: [] };
        if (!I || !I.ok) return out;
        var R = ST.R, op = R && R.ok ? R.op : null;
        if (I.layerRates && I.layers) {
            var pal = [Tm.blue, Tm.purple, Tm.yellow, '#39c5cf', Tm.accent, Tm.red, Tm.text2], pws = I.pr, pTop = Math.max.apply(null, I.layers.map(function (l) { return l.pr; })) + 200;
            var grid = []; for (var g = 0; g <= 40; g++) grid.push(Math.max(0, pTop - (pTop) * g / 40));
            I.layers.forEach(function (L, li) {
                var pts = grid.map(function (p) { var r = I.layerRates(p)[li]; return [X(r.q), Y(p)]; });
                out.series.push({ key: 'lay' + li, label: L.name + ' (p̄r ' + _fmt(_dv(L.pr, 'pressure'), 0) + ')', color: pal[li % pal.length], width: 1.6, dash: [5, 4], pts: pts });
            });
            out.hlines.push({ y: Y(pws), label: 'p_ws (commingled)', color: Tm.text2, dash: [2, 4] });
            if (I.crossflow && I.crossflow.rate > 0) out.vlines.push({ x: X(0), label: '', color: Tm.text2 });
        }
        if (I.inj) {
            if (_fin(I.pFrac)) out.hlines.push({ y: Y(I.pFrac), label: 'fracture pressure', color: Tm.red, dash: [6, 4] });
            else if (R && R.inj && _fin(R.inj.pFrac)) out.hlines.push({ y: Y(R.inj.pFrac), label: 'fracture (DFIT, provisional)', color: Tm.red, dash: [6, 4] });
            var qf = R && R.inj ? R.inj.qFrac : null;
            if (_fin(qf)) out.vlines.push({ x: X(qf), label: 'q at p_frac', color: Tm.red, dash: [2, 4] });
        }
        if (op && R.ok) out.markers.push({ x: X(op.q), y: Y(op.p), kind: 'filled', color: Tm.accent, r: 6, label: 'operating point' });
        return out;
    }
    // the inflow-study plot: one variable per model, with a live drag handle
    function _iprStudy() {
        var M = ST.M, I = ST.I, V = G.WTS_wp_view; if (!M || !I || !I.ok || !V) return null;
        var Tm = V.theme(), P = M.res.params || {}, key = M.res.model, pi = _lab('productivityIndex', 'STB/d/psi');
        var Jd = function (j) { return _dv(j, 'productivityIndex'); };
        if (I.transient && typeof I.transient.jOfT === 'function') {
            var t0 = I.transient.t, tp = I.transient.tPss, tmax = Math.max(1e3, (tp || 0) * 3, t0 * 10), pts = [];
            for (var e = -1; e <= Math.log(tmax) / Math.LN10 + 1e-9; e += 0.1) { var tt = Math.pow(10, e), j = I.transient.jOfT(tt); if (_fin(j)) pts.push([tt, Jd(j)]); }
            return { title: 'Productivity index against flowing time', x: { label: 'Flowing time (h)', log: true, min: 0.1, max: tmax, short: 't' }, y: { label: 'J (' + pi + ')', min: 0, short: 'J' },
                series: [{ key: 'jt', label: 'J(t), line source', color: Tm.green, width: 2.4, pts: pts }],
                vlines: _fin(tp) ? [{ x: tp, label: 'end of infinite-acting flow', color: Tm.yellow, dash: [6, 4] }] : [],
                handle: { key: 'tFlow', label: 't', value: t0, min: 0.1, max: tmax, color: Tm.accent, fmt: function (v) { return _fmt(v, v < 10 ? 1 : 0) + ' h'; } },
                note: 'Drag t: the IPR and the operating point follow the flowing time (infinite acting until the boundary is felt).' };
        }
        if (I.horizontal) {
            var L0 = I.horizontal.L, Lmax = key === 'babuOdeh' ? +P.boxB : (key === 'joshi' && _fin(+P.re) ? 1.75 * +P.re : 3 * L0), ser = [];
            if (!(Lmax > L0)) Lmax = L0 * 1.5;
            for (var i = 1; i <= 24; i++) { var Li = Lmax * i / 24, Ii = _iprWith({ L: Li }); if (Ii && _fin(Ii.J)) ser.push([_dv(Li, 'length'), Jd(Ii.J)]); }
            var jv = I.form && _fin(I.form.Jvertical) ? I.form.Jvertical : null;
            return { title: 'Productivity index against lateral length', x: { label: 'Lateral length L (' + _lab('length', 'ft') + ')', min: 0, short: 'L' }, y: { label: 'J (' + pi + ')', min: 0, short: 'J' },
                series: [{ key: 'jl', label: (I.label || key).replace(/^Horizontal well — /, ''), color: Tm.green, width: 2.4, pts: ser }],
                hlines: jv ? [{ y: Jd(jv), label: 'vertical well, same r_e', color: Tm.text2, dash: [3, 4] }] : [],
                handle: { key: 'L', label: 'L', value: _dv(L0, 'length'), min: _dv(50, 'length'), max: _dv(Lmax, 'length'), color: Tm.accent, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab('length', 'ft'); } },
                note: 'Drag L along the lateral: the perforated MD interval sets it when L is blank (deviation survey, step ③).' };
        }
        if (I.frac) {
            var xf0 = I.frac.xf, xmax = Math.max(xf0 * 2.5, 100), s1 = [], s2 = [];
            for (var k = 1; k <= 24; k++) {
                var xk = xmax * k / 24, a = _iprWith({ xf: xk }), b = _iprWith({ xf: xk, FcD: null, kfw: null });
                if (a && _fin(a.J)) s1.push([_dv(xk, 'length'), Jd(a.J)]);
                if (b && _fin(b.J)) s2.push([_dv(xk, 'length'), Jd(b.J)]);
            }
            var ser2 = [{ key: 'jx', label: 'F_cD ' + (_fin(I.frac.FcD) ? _fmt(I.frac.FcD, 1) : '∞'), color: Tm.green, width: 2.4, pts: s1 }];
            if (_fin(I.frac.FcD)) ser2.push({ key: 'jinf', label: 'infinite conductivity', color: Tm.blue, width: 1.6, dash: [6, 4], pts: s2 });
            return { title: 'Productivity index against fracture half-length', x: { label: 'x_f (' + _lab('length', 'ft') + ')', min: 0, short: 'x_f' }, y: { label: 'J (' + pi + ')', min: 0, short: 'J' },
                series: ser2, handle: { key: 'xf', label: 'x_f', value: _dv(xf0, 'length'), min: _dv(10, 'length'), max: _dv(xmax, 'length'), color: Tm.accent, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab('length', 'ft'); } },
                note: 'Drag x_f: s_f from the F_cD curve (Cinco-Ley & Samaniego, closed-form fit) moves the IPR.' };
        }
        if (key === 'wcComposite' && I.form) {
            var rc = _rateCat(), oilI = _iprWith({ fw: 0 }), watI = _iprWith({ fw: 1 }), cur = function (J0) { return J0 ? J0.curve.map(function (c) { return [_dv(c.q, rc[0]), _dv(c.pwf, 'pressure')]; }).sort(function (x, y) { return x[0] - y[0]; }) : []; };
            return { title: 'Water-cut composite: oil, water and the weighted curve', x: { label: 'Liquid rate (' + _lab(rc[0], rc[1]) + ')', min: 0, short: 'q' }, y: { label: 'pwf (' + _lab('pressure', 'psia') + ')', min: 0, short: 'pwf' },
                series: [{ key: 'oil', label: 'oil (WC 0 %)', color: Tm.green, width: 1.6, dash: [6, 4], pts: cur(oilI) }, { key: 'wat', label: 'water (WC 100 %)', color: Tm.blue, width: 1.6, dash: [6, 4], pts: cur(watI) },
                    { key: 'mix', label: 'WC ' + _fmt(100 * I.form.fw, 0) + ' %', color: Tm.accent, width: 2.6, pts: cur(I) }],
                handle: { key: 'wc', kind: 'railX', label: 'WC', value: 100 * I.form.fw, min: 0, max: 98, step: 1, color: Tm.purple, fmt: function (v) { return _fmt(v, 0) + ' %'; } },
                note: 'Drag WC: the weighted curve moves between the oil Vogel curve and the water PI line.' };
        }
        if (I.layers && ST.R && ST.R.ok && ST.R.layers) {
            var lr = ST.R.layers.rates, rcm = _rateCat(), serL = [], mk = [];
            lr.forEach(function (r) {
                var y = _dv(r.tvd, 'length'), c = r.q < 0 ? Tm.red : Tm.green;
                serL.push({ key: 'b' + r.name, label: r.name, legend: false, color: c, width: 12, pts: [[0, y], [_dv(r.q, rcm[0]), y]] });
                mk.push({ x: _dv(r.q, rcm[0]), y: y, kind: 'filled', color: c, r: 4, label: r.name + ' ' + _fmt(_dv(r.q, rcm[0]), 0) + (r.q < 0 ? ' (crossflow)' : '') });
            });
            var cf = ST.R.layers.crossflow; if (cf && cf.layers) cf.layers.forEach(function (r) { mk.push({ x: _dv(r.q, rcm[0]), y: _dv(r.tvd, 'length'), kind: 'hollow', color: Tm.text2, r: 4, label: '' }); });
            return { title: 'Layer rates at the operating point (shut-in crossflow hollow)', x: { label: 'Layer rate (' + _lab(rcm[0], rcm[1]) + '; < 0 = crossflow into the layer)', short: 'q' },
                y: (function () { var tv = lr.map(function (r) { return _dv(r.tvd, 'length'); }), lo = Math.min.apply(null, tv), hi = Math.max.apply(null, tv), pad = Math.max(60, 0.35 * (hi - lo)); return { label: 'TVD (' + _lab('length', 'ft') + ')', invert: true, short: 'TVD', min: lo - pad, max: hi + pad }; })(), series: serL, markers: mk, vlines: [{ x: 0, color: Tm.text2, label: '' }],
                note: 'Each bar is a layer at its true vertical depth; red = the layer takes fluid. Hollow markers: the rates with the well shut in.' };
        }
        if (_injR() && ST.R.ok && ST.R.curves && ST.R.curves.vlp && ST.R.curves.vlp.length > 2) {
            var Rr = ST.R, vl = Rr.curves.vlp.slice().sort(function (x, y) { return x.q - y.q; }), thp0 = Rr.surface.thp_psig, rcI = _injRateCat(), Ip = I;
            var pv = function (q) { for (var a = 1; a < vl.length; a++) if (q <= vl[a].q) { var f = (q - vl[a - 1].q) / ((vl[a].q - vl[a - 1].q) || 1); return vl[a - 1].p + f * (vl[a].p - vl[a - 1].p); } return vl[vl.length - 1].p + (q - vl[vl.length - 1].q) * (vl[vl.length - 1].p - vl[vl.length - 2].p) / ((vl[vl.length - 1].q - vl[vl.length - 2].q) || 1); };
            var qOf = function (thp) { var d = thp - thp0, lo = 0, hi = vl[vl.length - 1].q * 4; if (pv(0) + d - Ip.pwfAt(0) <= 0) return 0; for (var n = 0; n < 60; n++) { var m = 0.5 * (lo + hi); if (pv(m) + d - Ip.pwfAt(m) > 0) lo = m; else hi = m; } return 0.5 * (lo + hi); };
            var tmx = Math.max(_fin(Rr.inj.thpFrac_psig) ? Rr.inj.thpFrac_psig * 1.3 : 0, thp0 * 2, 500), sI = [];
            for (var s = 0; s <= 30; s++) { var th = tmx * s / 30; sI.push([_dv(th, 'pressureG'), _dv(qOf(th), rcI[0])]); }
            return { title: 'Injection rate against wellhead pressure', x: { label: 'Wellhead injection pressure (' + _lab('pressureG', 'psig') + ')', min: 0, short: 'THP' }, y: { label: 'Injection rate (' + _lab(rcI[0], rcI[1]) + ')', min: 0, short: 'q' },
                series: [{ key: 'qthp', label: 'rate', color: Tm.blue, width: 2.4, pts: sI }],
                vlines: _fin(Rr.inj.thpFrac_psig) ? [{ x: _dv(Rr.inj.thpFrac_psig, 'pressureG'), label: 'fracture limit', color: Tm.red, dash: [6, 4] }] : [],
                handle: { key: 'thpI', label: 'THP', value: _dv(thp0, 'pressureG'), min: 0, max: _dv(tmx, 'pressureG'), color: Tm.accent, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab('pressureG', 'psig'); } },
                note: 'Drag the THP: the well re-solves. The curve shifts the outflow by the pressure change (' + (ST.M.fluid.type === 'gasinj' ? 'approximate for gas' : 'exact for an incompressible water column') + ').' };
        }
        return null;
    }
    function _renderIprStudy() {
        var box = _byId('wp_iprsbox'), cv = _byId('wp_cv_iprs'), V = G.WTS_wp_view; if (!box || !cv || !V) return;
        var sp = _iprStudy();
        if (box.classList) box.classList.toggle('wp-off', !sp);
        if (!sp) return;
        var tt = _byId('wp_iprs_t'); if (tt) tt.textContent = sp.title;
        var nt = _byId('wp_iprs_n'); if (nt) nt.textContent = sp.note || '';
        var h = sp.handle ? [Object.assign({ kind: 'lineX', rail: [0, 1] }, sp.handle)] : [];
        V.chart(cv, { key: 'iprs:' + (ST.M ? ST.M.res.model : '') + ':' + (_metric() ? 'm' : 'i'), aspect: 0.58, minH: 210, maxH: 340, w: 520, readout: 'x', x: sp.x, y: sp.y,
            series: sp.series, hlines: sp.hlines || [], vlines: sp.vlines || [], markers: sp.markers || [], handles: h, onHandle: _onHandle, empty: 'No study for this inflow model.' });
    }
    // step ② summary rows of the B models (and the report rows of #wp_studies)
    function _iprBRows(I) {
        var out = [], row = function (l, v) { if (v != null && v !== '') out.push([l, v]); };
        if (!I || !I.ok) return out;
        var f = I.form || {}, rc = _rateCat();
        if (I.horizontal) {
            row('Lateral length', _u(I.horizontal.L, 'length', 0, 'ft') + ' (anisotropy I_ani ' + _fmt(I.horizontal.Iani, 2) + ')');
            if (_fin(f.ratio)) row('J horizontal / J vertical', _fmt(f.ratio, 2) + ' × (same drainage radius)');
            if (f.kase) row('Partial penetration', f.kase + (_fin(f.sR) ? ', s_R ' + _fmt(f.sR, 2) : '') + (_fin(f.lnCH) ? ', ln C_H ' + _fmt(f.lnCH, 2) : ''));
        }
        if (I.frac) row('Fracture', 'x_f ' + _u(I.frac.xf, 'length', 0, 'ft') + ', F_cD ' + (_fin(I.frac.FcD) ? _fmt(I.frac.FcD, 1) : '∞') + ', s_f ' + _fmt(I.frac.sf, 2) + (_fin(f.rwEff) ? ', r_w′ ' + _u(f.rwEff, 'length', 1, 'ft') : ''));
        if (I.transient) row('Transient', 'J at ' + _fmt(I.transient.t, 1) + ' h = ' + _u(I.J, 'productivityIndex', 3, 'STB/d/psi') + (_fin(I.transient.tPss) ? '; infinite acting until ≈ ' + _fmt(I.transient.tPss, 0) + ' h' : ''));
        if (M_key(I) === 'wcComposite') row('Composite', 'WC ' + _fmt(100 * f.fw, 0) + ' % · q_o,max ' + _u(f.qoMax, rc[0], 0, rc[1]) + ' · q_t,max ' + _u(f.qtMax, rc[0], 0, rc[1]));
        if (I.layers) {
            row('Layers', I.layers.length + ' · commingled p_ws ' + _u(I.pr, 'pressure', 0, 'psia') + ' at ' + _u(f.refMd, 'length', 0, 'ft') + ' MD · ' + _u(f.refTvd, 'length', 0, 'ft') + ' TVD · gradient ' + _fmt(_dv(f.grad, 'pressureGradient'), 3) + ' ' + _lab('pressureGradient', 'psi/ft'));
            var cf = I.crossflow; if (cf) row('Shut-in crossflow', cf.thief && cf.thief.length ? _u(cf.rate, rc[0], 0, rc[1]) + ' into ' + cf.thief.join(', ') : 'none');
        }
        if (I.inj) {
            var ru = _injRateCat();
            row('Injectivity', (ST.M && ST.M.fluid.type === 'gasinj' ? _fmt(I.II, 2) + ' Mscf/d/psi (secant, first 100 psi)' : _u(I.II, 'productivityIndex', 3, 'BWPD/psi')) + (f.IIsource ? ' · ' + f.IIsource : ''));
            row('Pressure limit', _fin(I.pFrac) ? 'fracture ' + _u(I.pFrac, 'pressure', 0, 'psia') + ' (input) · rate there ' + _u(I.qLimit, ru[0], 0, ru[1]) : 'no fracture pressure entered');
        }
        return out;
    }
    function M_key(I) { return I && I.key; }
    function _bKey(k) { return (G.WTS_wp_ipr && (G.WTS_wp_ipr.B_KEYS || []).indexOf(k) !== -1); }
    // KPIs of an injection well (replaces the producer strip)
    function _kpisInj() {
        var R = ST.R, M = ST.M, ok = !!(R && R.ok), out = [], rc = _injRateCat(), inj = R && R.inj ? R.inj : {};
        var nd = ST.W && ST.W.ok && ST.W.nodes;
        out.push({ k: 'rate', l: 'Injection rate', v: ok ? _u(R.op.q, rc[0], 0, rc[1]) : '—', s: M ? (M.fluid.type === 'gasinj' ? 'gas injector' : 'water injector') : '', st: ok ? 'ok' : (R ? 'fail' : 'none') });
        out.push({ k: 'bhp', l: 'Injection BHP', v: ok ? _u(R.pwf, 'pressure', 0, 'psia') : '—', s: nd && _fin(nd.midPerfTvd) ? '@ ' + _u(nd.midPerfMd, 'length', 0, 'ft') + ' MD · ' + _u(nd.midPerfTvd, 'length', 0, 'ft') + ' TVD' : '' });
        out.push({ k: 'thp', l: 'Injection THP', v: _u(M ? M.system.thp_psig : null, 'pressureG', 0, 'psig'), s: _fin(inj.thpStart_psig) ? 'starts at ' + _u(inj.thpStart_psig, 'pressureG', 0, 'psig') : 'wellhead (boundary)',
            st: (ok && M && _fin(M.surface.rating.wellhead_psi)) ? (M.system.thp_psig > M.surface.rating.wellhead_psi ? 'fail' : 'ok') : 'none' });
        out.push({ k: 'frac', l: 'Fracture margin', v: _fin(inj.margin) ? _u(inj.margin, 'pressure', 0, 'psi') : '—', s: _fin(inj.pFrac) ? 'p_frac ' + _u(inj.pFrac, 'pressure', 0, 'psia') + (inj.pFracProvisional ? ' (DFIT)' : '') : 'enter p_frac',
            st: inj.verdict === 'fail' ? 'fail' : inj.verdict === 'warn' ? 'warn' : inj.verdict === 'ok' ? 'ok' : 'none' });
        out.push({ k: 'qfrac', l: 'Max rate (no frac)', v: _fin(inj.qFrac) ? _u(inj.qFrac, rc[0], 0, rc[1]) : '—', s: _fin(inj.thpFrac_psig) ? 'THP ≤ ' + _u(inj.thpFrac_psig, 'pressureG', 0, 'psig') : '' });
        out.push({ k: 'ii', l: 'Injectivity', v: _fin(inj.II) ? (M && M.fluid.type === 'gasinj' ? _fmt(inj.II, 1) + ' Mscf/d/psi' : _u(inj.II, 'productivityIndex', 2, 'BWPD/psi')) : '—', s: 'p̄r ' + _u(M ? M.res.pr : null, 'pressure', 0, 'psia') });
        out.push({ k: 'tht', l: 'Injection temperature', v: _u(ok && R.surface ? R.surface.tht : null, 'temperature', 0, '°F'), s: 'at the wellhead' });
        var ero = ok ? _eroMax(R) : null;
        out.push({ k: 'ero', l: 'Erosion ratio', v: _fin(ero) ? _fmt(ero, 2) : '—', s: M ? 'C = ' + _fmt(M.system.eroC, 0) + ' · tubing' : '', st: _fin(ero) ? (ero > 1 ? 'fail' : ero > 0.8 ? 'warn' : 'ok') : 'none' });
        return out;
    }
    // one extra KPI for the B producer models (the A1 / A2 strip is unchanged for the other models)
    function _kpiB() {
        var I = ST.I, R = ST.R; if (!I || !I.ok) return null;
        if (I.layers) {
            var th = R && R.ok && R.layers ? R.layers.thief : [], cf = I.crossflow, rc = _rateCat();
            return { k: 'xflow', l: 'Crossflow', v: th && th.length ? th.join(', ') : (cf && cf.thief && cf.thief.length ? 'shut-in only' : 'none'), s: cf && cf.rate > 0 ? 'shut in ' + _u(cf.rate, rc[0], 0, rc[1]) : I.layers.length + ' layers',
                st: th && th.length ? 'fail' : (cf && cf.thief && cf.thief.length ? 'warn' : 'ok') };
        }
        if (I.horizontal) return { k: 'hz', l: 'Lateral', v: _u(I.horizontal.L, 'length', 0, 'ft'), s: I.form && _fin(I.form.ratio) ? 'J ' + _fmt(I.form.ratio, 1) + '× vertical' : (I.label || '').replace(/^Horizontal well — /, ''), st: 'info' };
        if (I.frac) return { k: 'frac', l: 'Fracture', v: 'x_f ' + _u(I.frac.xf, 'length', 0, 'ft'), s: 's_f ' + _fmt(I.frac.sf, 2) + ' · F_cD ' + (_fin(I.frac.FcD) ? _fmt(I.frac.FcD, 1) : '∞'), st: 'info' };
        if (I.transient) return { k: 'tr', l: 'Flowing time', v: _fmt(I.transient.t, 1) + ' h', s: 'J ' + _u(I.J, 'productivityIndex', 2, 'STB/d/psi'), st: _fin(I.transient.tPss) && I.transient.t > I.transient.tPss ? 'warn' : 'info' };
        return null;
    }
    // operating-point rows and verdicts of the B models
    function _opRowsB(row) {
        var R = ST.R, rc = _rateCat();
        if (R && R.ok && R.layers) R.layers.rates.forEach(function (r) {
            row('Layer ' + r.name + ' (' + _u(r.midMd, 'length', 0, 'ft') + ' MD · ' + _u(r.tvd, 'length', 0, 'ft') + ' TVD)', _u(r.q, rc[0], 0, rc[1]) + (r.crossflow ? ' — crossflow into the layer' : (_fin(r.share) ? ' (' + _fmt(100 * r.share, 0) + ' %)' : '')));
        });
    }
    function _opInj(row) {
        var R = ST.R, inj = R.inj || {}, rc = _injRateCat();
        row('Injection rate', _u(R.op.q, rc[0], 0, rc[1]));
        row('Bottom-hole injection pressure', _u(R.pwf, 'pressure', 0, 'psia'));
        row('Wellhead injection pressure', _u(R.surface.thp_psig, 'pressureG', 0, 'psig'));
        row('Injection drive pwf − p̄r', _u(R.pwf - R.pr, 'pressure', 0, 'psi'));
        if (_fin(inj.pFrac)) row('Fracture pressure', _u(inj.pFrac, 'pressure', 0, 'psia') + (inj.pFracSource && inj.pFracSource !== 'input' ? ' (' + inj.pFracSource + ', provisional)' : ''));
        if (_fin(inj.qFrac)) row('Rate at the fracture pressure', _u(inj.qFrac, rc[0], 0, rc[1]));
        if (_fin(inj.thpFrac_psig)) row('Highest THP without fracturing', _u(inj.thpFrac_psig, 'pressureG', 0, 'psig'));
        if (_fin(inj.thpStart_psig)) row('THP to start injecting', _u(inj.thpStart_psig, 'pressureG', 0, 'psig'));
    }
    function _verdictsB(add) {
        var R = ST.R, I = ST.I, rc = _rateCat();
        if (R && R.injector && R.ok) {
            var inj = R.inj || {};
            if (inj.verdict === 'fail') add('fail', '✗ Injection BHP ' + _u(R.pwf, 'pressure', 0, 'psia') + ' is above the fracture pressure ' + _u(inj.pFrac, 'pressure', 0, 'psia') + ': keep the THP below ' + _u(inj.thpFrac_psig, 'pressureG', 0, 'psig') + '.');
            else if (inj.verdict === 'warn') add('warn', '⚠ Injection BHP within 5 % of the fracture pressure ' + _u(inj.pFrac, 'pressure', 0, 'psia') + ' (margin ' + _u(inj.margin, 'pressure', 0, 'psi') + ').');
            else if (inj.verdict === 'ok') add('ok', '✓ Injection BHP ' + _u(inj.margin, 'pressure', 0, 'psi') + ' below the fracture pressure; up to ' + _u(inj.thpFrac_psig, 'pressureG', 0, 'psig') + ' THP without fracturing.');
            else add('info', 'ℹ No fracture pressure: enter it in step ② or run a DFIT on this well.');
            return;
        }
        if (R && R.ok && R.layers) {
            if (R.layers.thief && R.layers.thief.length) add('warn', '⚠ Crossflow while flowing: ' + R.layers.thief.join(', ') + (R.layers.thief.length === 1 ? ' takes' : ' take') + ' fluid at the operating point.');
            else add('ok', '✓ Every layer produces at the operating point (no crossflow while flowing).');
            var cf = R.layers.crossflow; if (cf && cf.thief && cf.thief.length) add('info', 'ℹ Shut in, ' + _u(cf.rate, rc[0], 0, rc[1]) + ' cross-flows into ' + cf.thief.join(', ') + ' (commingled p_ws ' + _u(cf.pws, 'pressure', 0, 'psia') + ').');
        }
        if (I && I.ok && I.transient && _fin(I.transient.tPss) && I.transient.t > I.transient.tPss) add('warn', '⚠ The flowing time is past the end of infinite-acting flow: the transient IPR over-states the productivity.');
    }
    // Build-up Surveillance hand-off (§2.10): the latest interpreted build-up of this well → k, h, S, p̄r with provenance chips
    function _importBuildup() {
        var h = _byId('wp_bumsg'), BS = G.WTS_buildup && G.WTS_buildup.store;
        var show = function (st, t) { if (h) h.innerHTML = _vHtml({ st: st, t: t }); };
        if (!BS || typeof BS.loadState !== 'function' || !_fn('WTS_wp_ipr.fromBuildup')) { show('warn', '⚠ Build-up Surveillance is not available.'); return; }
        var go = function () {
            var nd = ST.W && ST.W.ok && ST.W.nodes, r = _call('WTS_wp_ipr.fromBuildup', BS.loadState(), { midPerfTvd: nd ? nd.midPerfTvd : null });
            if (!r || !r.ok) { show('warn', '⚠ ' + (((r && r.errors) || [])[0] || 'No build-up result.')); return; }
            var sp = r.spec, prov = r.provenance || {}, cur = (_byId('wp_ipr') || {}).value, usesK = /^(darcyOil|darcyGas|joshi|babuOdeh|furui|frac|fracGas|transient)$/.test(cur || '');
            var put = function (id, v, src) { if (v == null || !_fin(+v)) return; _setCtrl(id, v, true); ST.prov[id] = 'Build-up'; };
            if (!usesK) _setCtrl('wp_ipr', sp.model, false);
            Object.keys(sp.params || {}).forEach(function (k) { if (IP[k]) put('wp_ip_' + k, sp.params[k], prov[k]); });
            if (_fin(sp.pr)) put('wp_pr', Math.round(sp.pr), prov.pr);
            _syncUi(); _commit('wp_ipr');
            var t = r.test || {};
            show(r.warnings.some(function (w) { return w.sev === 'warn'; }) ? 'warn' : 'ok', (r.warnings.some(function (w) { return w.sev === 'warn'; }) ? '⚠ ' : '✓ ') + 'Imported build-up ' + t.id + (t.date ? ' (' + t.date + ')' : '') + ': k ' + _u(t.k, 'permeability', 2, 'md') + ', S ' + _fmt(t.S, 2) +
                (_fin(sp.pr) ? ', p̄r ' + _u(sp.pr, 'pressure', 0, 'psia') : '') + (t.conf ? ' · confidence ' + t.conf : '') + (r.warnings.length ? ' — ' + r.warnings.map(function (w) { return w.msg; }).join(' ') : ''));
        };
        show('info', 'ℹ Reading the build-up results…');
        var P0 = typeof BS.init === 'function' ? BS.init() : null;
        if (P0 && typeof P0.then === 'function') P0.then(go, go); else go();
    }
    // the layers table writes the TVD of every layer from the current well path (the engines prefer the live path when they have it)
    function _layerTvds(rows) {
        return rows.map(function (r) { var o = Object.assign({}, r); o.tvdTop = _tvdAt(r.topMd); o.tvdBot = _tvdAt(r.botMd); o.use = true; return o; });
    }
    // schematic options of the B models: the layers as beds across the section (rate and crossflow), the flow direction of an
    // injector, the fracture wings at the mid-perforations
    function _schB() {
        var o = {}, I = ST.I, R = ST.R, rc = _rateCat();
        if (I && I.ok && I.layers) {
            var rates = R && R.ok && R.layers ? R.layers.rates : null;
            o.layers = I.layers.map(function (L, i) {
                var r = rates ? rates[i] : null;
                return { topMd: L.topMd, botMd: L.botMd, name: L.name, q: r ? r.q : null, crossflow: !!(r && r.crossflow), label: String(L.name).replace(/\s*\(.*\)$/, '').slice(0, 12) + (r ? ' ' + _fmt(_dv(r.q, rc[0]), 0) + ' ' + _lab(rc[0], rc[1]) : '') };
            });
        }
        if (_isInj(ST.M)) o.inject = true;
        if (I && I.ok && I.frac && ST.W && ST.W.ok && ST.W.nodes) o.frac = { md: ST.W.nodes.midPerfMd, label: 'x_f ' + _u(I.frac.xf, 'length', 0, 'ft') };
        if (I && I.ok && I.horizontal) o.lateral = { label: 'lateral ' + _u(I.horizontal.L, 'length', 0, 'ft') };
        return o;
    }

    // ── render ────────────────────────────────────────────────────────────────
    function _stepsHtml() {
        return '<nav class="wp-steps rp-skip" id="wp_steps" aria-label="Well performance steps">' + STEPS.map(function (s) {
            return '<button type="button" data-step="' + s.n + '"><span class="wp-dot" id="wp_dot_' + s.n + '" aria-hidden="true"></span>' + CIRC[s.n] + ' ' + s.label + '<span class="wp-sr" id="wp_dotsr_' + s.n + '"></span></button>';
        }).join('') + '<span class="wp-exs" role="group" aria-label="Examples"><span class="wp-ex">Examples: </span>' +
            '<button type="button" data-act="example" data-ex="oil" title="Load the example vertical oil well">Oil</button><button type="button" data-act="example" data-ex="gas" title="Load the example deviated gas-condensate well">Gas</button>' +
            '<button type="button" data-act="example" data-ex="hz" title="Load the example horizontal oil well (Joshi inflow on the surveyed lateral)">Horizontal</button><button type="button" data-act="example" data-ex="ml" title="Load the example two-layer oil well with crossflow">Layers</button><button type="button" data-act="example" data-ex="inj" title="Load the example deviated water injector with a fracture-pressure limit">Injector</button><button type="button" data-act="example" data-ex="esp" title="Load the example deviated oil well on an electrical submersible pump">ESP</button><button type="button" data-act="example" data-ex="gl" title="Load the example deviated oil well on gas lift and design its unloading valves">Gas lift</button></span></nav>';
    }
    function _tableBlock(t, title, hint, o) {
        o = o || {};
        return '<div class="wp-tblock rp-skip"><div class="wp-sec-h" style="font-size:13px">' + _esc(title) + (o.head || '') + '</div>' + (hint ? '<div class="wp-hint" style="margin:-6px 0 8px">' + hint + '</div>' : '') +
            '<div id="wp_tbl_' + t + '"></div><div class="wp-btns"><button type="button" class="btn btn-secondary" data-act="add" data-t="' + t + '">+ Add row</button>' +
            '<button type="button" class="btn btn-secondary" data-act="paste" data-t="' + t + '">Paste from a spreadsheet</button>' + (o.btns || '') + '</div>' +
            '<div class="wp-paste" id="wp_paste_' + t + '"><textarea id="wp_pastet_' + t + '" aria-label="Paste rows" placeholder="Paste rows copied from a spreadsheet (columns in the order above, tab, comma or semicolon separated; header lines are skipped). The rows replace the table."></textarea>' +
            '<div class="wp-btns"><button type="button" class="btn btn-primary" data-act="pasteok" data-t="' + t + '">Replace the table with these rows</button></div></div><div id="wp_pastemsg_' + t + '"></div></div>';
    }
    // ① B (WP23): the PVT lab match (oil), the condensate drop-out (wet gas) and the emulsion viscosity (oil with water)
    function _pvtBHtml() {
        var lab = '<div class="fg">' + _fg('wpl_T', 'Lab temperature', { unit: '°F', ph: 'required' }) + _fg('wpl_basis', 'Lab basis', { options: [['flash', 'Flash (separator) values'], ['differential', 'Differential liberation']] }) +
            _fg('wpl_pb', 'Lab bubble point', { unit: 'psia' }) + _fg('wpl_rsbF', 'Separator-test Rsb (flash)', { unit: 'scf/STB', hint: 'The lab oil\'s solution GOR; blank = the highest Rs of the table.' }) +
            _fg('wpl_bobF', 'Separator-test Bob (flash)', { unit: _fvfLab(), hint: 'With differential data: adjusts the table to flash (provisional).' }) + '</div>';
        return '<div class="wp-2c" data-for="oil">' +
            _card('PVT lab data', lab + _tableBlock('lab', 'Lab table', 'Pressure with any of Rs, Bo and μo at the lab temperature; Rs above the bubble point is the Rsb. Pressures in absolute units.',
                { btns: '<button type="button" class="btn btn-secondary" data-act="labex" title="Synthetic example data for trying the match">Example lab data</button>' }) +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="pvtmatch">Match to the lab data</button></div><div id="wp_pvtmjob" class="rp-skip" role="status"></div>' +
                '<div class="wp-hint">Pb by a one-point factor, then Rs (below pb), Bo and μo each as a·y + b on the model matched so far (Levenberg-Marquardt, relative errors); every black-oil family and viscosity pair is ranked against the lab points. Apply sends the matched set into every solve.</div>') +
            _card('PVT lab match', '<div id="wp_pvtmres" aria-live="polite"></div>') + '</div>' +
            '<div class="wp-studies" data-for="oil"><div id="wp_pvtmtab"></div></div>' +
            '<div class="wp-2c" data-for="gas condensate">' +
            _card('Condensate drop-out', '<div class="fg">' + _fg('wp_rvmode', 'Condensate model', { options: [['none', 'Wet gas — no mass transfer (default)'], ['table', 'Modified black oil — Rv table (provisional)']] }) +
                _fg('wp_pdew', 'Dew point', { unit: 'psia', data: 'data-rv="table"', ph: 'from the table', hint: 'Blank = where the Rv table reaches the CGR. Drag it on the plot.' }) + '</div>' +
                '<div data-rv="table">' + _tableBlock('rv', 'Vaporised condensate Rv', 'Lab constant-volume depletion: pressure and the condensate still in the gas (Rv ≤ CGR). Above the dew point all the condensate is vaporised.',
                    { btns: '<button type="button" class="btn btn-secondary" data-act="rvex">Example Rv table</button>' }) + '</div>') + '</div>' +
            '<div class="wp-2c" data-for="oil">' +
            _card('Emulsion', '<div class="fg">' + _fg('wp_emul', 'Liquid viscosity', { options: [['none', 'Oil + water mixture (default)'], ['woelflin', 'Woelflin emulsion curves (provisional)'], ['brinkman', 'Brinkman emulsion (provisional)'], ['table', 'Emulsion table (μ_em / μo)']] }) +
                _fg('wp_emulT', 'Emulsion', { options: [['loose', 'Loose'], ['medium', 'Medium'], ['tight', 'Tight']], data: 'data-emul="woelflin"' }) +
                _fg('wp_emulInv', 'Inversion point', { unit: '% water', data: 'data-emul="woelflin brinkman"', hint: 'Water-continuous above it (Brinkman in water). Drag it on the plot.' }) + '</div>' +
                '<div data-emul="table">' + _tableBlock('emul', 'Emulsion viscosity ratio', 'Water fraction of the liquid (%) and μ_emulsion / μ_oil from a lab or field measurement; held constant beyond the last row.',
                    { btns: '<button type="button" class="btn btn-secondary" data-act="emulex">Example table</button>' }) + '</div>') +
            _card('Liquid viscosity', '<div id="wp_emulk" aria-live="polite"></div><div class="chart-wrap" style="margin-top:8px"><canvas id="wp_cv_emul" tabindex="0" aria-label="Liquid viscosity over the oil viscosity against the water fraction for each emulsion model; drag the inversion point"></canvas></div>') + '</div>';
    }
    function _sectionsHtml() {
        var models = _iprModels(), wellCorr = _corrList('well'), lineCorr = _corrList('line');
        var ipFields = Object.keys(IP).filter(function (k) { return !IP[k].table; }).map(function (k) { var d = IP[k]; return _fg('wp_ip_' + k, d.l, { unit: d.u || '', data: 'data-ip="' + k + '"', ph: d.ph }); }).join('');
        var s1 = '<section id="wp_step_1" class="wp-sec"><div class="wp-sec-h">① Fluid <span>black-oil properties, gas gravity, water and impurities</span></div><div class="wp-2c">' +
            _card('Fluid', '<div class="fg">' +
                _fg('wp_ftype', 'Fluid type', { options: [['oil', 'Oil'], ['gas', 'Dry gas'], ['condensate', 'Gas-condensate (wet gas)'], ['water', 'Water'], ['gasinj', 'Gas injector'], ['waterinj', 'Water injector']] }) +
                _fg('wp_api', 'Oil / condensate gravity', { unit: '°API', data: 'data-for="oil condensate"' }) + _fg('wp_sgg', 'Gas specific gravity', { unit: 'air = 1' }) +
                _fg('wp_sggBasis', 'Gas gravity basis', { options: [['separator', 'Separator gas'], ['total', 'Total (well stream)']] }) +
                _fg('wp_gor', 'Producing GOR', { unit: 'scf/STB', data: 'data-for="oil"' }) + _fg('wp_wc', 'Water cut', { unit: '%', data: 'data-for="oil water"' }) +
                _fg('wp_cgr', 'Condensate-gas ratio', { unit: 'STB/MMscf', data: 'data-for="gas condensate"' }) + _fg('wp_wgr', 'Water-gas ratio', { unit: 'STB/MMscf', data: 'data-for="gas condensate"' }) +
                _fg('wp_fpsep', 'Separator pressure (fluid)', { unit: 'psig' }) + _fg('wp_ftsep', 'Separator temperature', { unit: '°F' }) +
                _fg('wp_sgw', 'Water specific gravity', { unit: 'water = 1' }) + _fg('wp_sal', 'Salinity', { unit: 'ppm' }) +
                _fg('wp_n2', 'N₂', { unit: 'mol %' }) + _fg('wp_co2', 'CO₂', { unit: 'mol %' }) + _fg('wp_h2s', 'H₂S', { unit: 'mol %' }) +
                _fg('wp_pbUser', 'Bubble point (optional)', { unit: 'psia', data: 'data-for="oil"', hint: 'Shifts the correlation to this pb (one point).' }) +
                _fg('wp_bc', 'Condensate FVF B_c', { unit: _fvfLab(), data: 'data-for="condensate"' }) +
                '</div><details class="rp-skip" style="margin-top:12px"><summary style="cursor:pointer;font-size:12px;color:var(--text2)">PVT correlations</summary><div class="fg" style="margin-top:10px">' +
                _fg('wp_corr_pb', 'Black-oil family (Pb, Rs, Bo)', { options: _famOpts('family'), data: 'data-for="oil"' }) + _fg('wp_corr_rs', 'Solution GOR and bubble point', { options: _famOpts('rs'), data: 'data-for="oil"' }) +
                _fg('wp_corr_bo', 'Oil FVF', { options: _famOpts('bo'), data: 'data-for="oil"' }) + _fg('wp_corr_co', 'Undersaturated compressibility (Bo above pb)', { options: _famOpts('co'), data: 'data-for="oil"' }) +
                _fg('wp_corr_muod', 'Dead-oil viscosity', { options: _famOpts('muod'), data: 'data-for="oil condensate"' }) + _fg('wp_corr_muo', 'Live-oil viscosity', { options: _famOpts('muo'), data: 'data-for="oil"' }) +
                _fg('wp_corr_muou', 'Undersaturated viscosity', { options: [['vasquezBeggs', 'Vasquez-Beggs']], data: 'data-for="oil"' }) + _fg('wp_corr_sigma', 'Gas-oil surface tension', { options: _famOpts('sigma'), data: 'data-for="oil condensate"' }) +
                _fg('wp_corr_z', 'Gas Z factor', { options: _famOpts('z') }) + _fg('wp_corr_mug', 'Gas viscosity', { options: _famOpts('mug') }) +
                '</div><div class="wp-hint" style="margin-top:4px">Options marked provisional have not been checked against a published worked example; the defaults are not provisional. The family selector sets Pb, Rs and Bo together.</div></details>' +
                '<div class="wp-btns rp-skip" data-for="oil"><button type="button" class="btn btn-secondary" data-act="sqc">Use the Separator QC GOR</button></div><div id="wp_fluidmsg"></div>') +
            '<div class="wp-col">' + _card('Fluid properties', '<div class="wp-pvtbar rp-skip"><span class="wp-seg" id="wp_pvtseg" role="group" aria-label="Property to plot"></span><span id="wp_pvtclr"></span></div>' +
                '<div class="chart-wrap"><canvas id="wp_cv_pvt" tabindex="0" aria-label="Fluid properties against pressure at the reservoir temperature, every correlation family overlaid; drag the pb handle to shift the bubble point"></canvas></div>' +
                '<div class="wp-fchips rp-skip" id="wp_pvtchips" role="group" aria-label="Black-oil correlation families"></div><div id="wp_pvtverd"></div><div id="wp_pvtcmp" style="margin-top:8px"></div>') +
            _card('PVT at six pressures', '<div id="wp_pvt"></div>') + '</div></div>' + _pvtBHtml() + '</section>';
        var s2 = '<section id="wp_step_2" class="wp-sec" style="display:none"><div class="wp-sec-h">② Reservoir <span>inflow model, reservoir pressure and its parameters</span></div><div class="wp-2c">' +
            _card('Inflow', '<div class="fg">' +
                _fg('wp_ipr', 'Inflow model', { options: models.map(function (m) { return [m.key, m.label + (m.kind === 'gas' ? ' (gas)' : '') + (m.verified ? '' : ' — provisional')]; }) }) +
                _fg('wp_pr', 'Average reservoir pressure p̄r', { unit: 'psia', ph: 'required' }) + _fg('wp_tres', 'Reservoir temperature', { unit: '°F' }) +
                _fg('wp_respb', 'Bubble point (composite)', { unit: 'psia' }) + ipFields + '</div><div id="wp_iprchip" class="rp-skip" style="margin-top:6px"></div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="prism">Import from PRiSM</button><button type="button" class="btn btn-secondary" data-act="bu" title="k, h, skin and p̄r from the latest interpreted build-up of this well">Import from Build-up Surveillance</button></div><div id="wp_prismmsg"></div><div id="wp_bumsg"></div>') +
            '<div class="wp-col">' + _card('Inflow performance', '<div class="chart-wrap"><canvas id="wp_cv_ipr" aria-label="Inflow performance relationship plot"></canvas></div><div id="wp_iprsum" style="margin-top:8px"></div>') +
            '<div data-ip="layers">' + _card('Layers', _tableBlock('layers', 'Layers (commingled)', 'Top / bottom MD and p̄r per layer; J (oil) or LIT a, b (gas, p²), or k, h and S with rw and re from the inflow card. TVD comes from the deviation survey; the rate column is the operating point (negative = crossflow into the layer).')) + '</div>' +
            '</div></div></section>';
        var s3 = '<section id="wp_step_3" class="wp-sec" style="display:none"><div class="wp-sec-h">③ Well <span>deviation survey, strings, restrictions, perforations and temperature</span></div>' +
            _card('Deviation survey', _tableBlock('survey', 'Survey stations', 'Minimum curvature gives TVD, departure and dog-leg severity for every station. Every depth on this page shows MD and TVD.',
                { head: ' <span class="wp-seg" id="wp_svmode" style="margin-left:auto"><button type="button" data-act="svmode" data-m="mdinc">MD · Inc · Azi</button><button type="button" data-act="svmode" data-m="mdtvd">MD · TVD</button></span>',
                  btns: '<select id="wpv_dfit" aria-label="DFIT test" style="max-width:260px"></select><button type="button" class="btn btn-secondary" data-act="dfit">Import well geometry from a DFIT test</button>' }) + '<div id="wp_svmsg" class="rp-skip"></div><div id="wp_dfitmsg"></div>') +
            '<div class="wp-2c">' + _card('Strings and flow path', _tableBlock('strings', 'Tubing, casing and liners', 'OD / ID in inches; roughness defaults to new steel (0.0006 in).') +
                '<div class="fg" style="margin-top:12px">' + _fg('wp_path', 'Flow path', { options: [['tubing', 'Tubing'], ['annulus', 'Annulus']] }) + _fg('wp_datum', 'Depth datum', { options: [['RKB', 'RKB'], ['GL', 'Ground level'], ['MSL', 'Mean sea level']] }) + _fg('wp_datumOff', 'Datum offset', { unit: 'ft' }) + '</div>') +
            _card('Restrictions and perforations', _tableBlock('restrictions', 'SSSV, nipples, sleeves, cross-overs, downhole chokes', 'Applied at the restriction depth with a homogeneous loss coefficient (K from β when blank).') +
                '<div class="fg" style="margin-top:12px">' + _fg('wp_perfTop', 'Top perforation (MD)', { unit: 'ft' }) + _fg('wp_perfBot', 'Bottom perforation (MD)', { unit: 'ft' }) + _fg('wp_midPerf', 'Mid-perforation (MD) — the bottom node', { unit: 'ft' }) + '</div><div id="wp_perftvd" class="wp-perftvd" aria-live="polite" style="margin-top:8px"></div>') + '</div>' +
            '<div class="wp-2c">' + _card('Temperature', '<div class="fg">' +
                _fg('wp_heat', 'Temperature model', { options: [['linear', 'Linear between THT and the reservoir'], ['relax', 'Heat-transfer relaxation (Ramey / Hasan-Kabir)'], ['enthalpy', 'Enthalpy balance (J-T, gravity, kinetic; U by depth)']] }) +
                _fg('wp_surfT', 'Surface temperature', { unit: '°F' }) +
                _fg('wp_tht', 'Flowing wellhead temperature', { unit: '°F', data: 'data-heat="linear"' }) + _fg('wp_thtMeas', 'THT measured', { check: true, data: 'data-heat="linear"' }) +
                _fg('wp_Uto', 'Overall heat-transfer coefficient U', { unit: 'Btu/hr·ft²·°F', data: 'data-heat="relax"', hint: 'Drag U on the traverse, or fit it to a test THT.' }) +
                _fg('wp_Ubasis', 'U basis', { options: [['to', 'Outside tubing radius (r_to·U_to)'], ['ti', 'Inside tubing radius (converted)']], data: 'data-heat="relax"' }) +
                _fg('wp_tprod', 'Producing time', { unit: 'd', data: 'data-heat="relax"' }) +
                _fg('wp_ke', 'Earth conductivity k_e', { unit: 'Btu/hr·ft·°F', data: 'data-heat="relax"' }) +
                _fg('wp_alpha', 'Earth diffusivity α', { unit: 'ft²/hr', data: 'data-heat="relax"' }) +
                _fg('wp_dwb', 'Hole diameter (optional)', { unit: 'in', data: 'data-heat="relax"', ph: 'largest string OD' }) + '</div>' +
                '<div id="wp_heatbox" class="wp-heat" data-heat="relax" aria-live="polite"></div>' +
                _tableBlock('geo', 'Geothermal points', 'TVD and static temperature; at least the surface and the reservoir. The relaxation model reads the geotherm on TVD and relaxes along MD.') +
                '<div data-heat="relax">' + _tableBlock('hlayers', 'Heat-transfer layers (U by depth)', 'Optional MD ranges with their own U (same basis as U above) and k_e — for example an insulated or a riser section. Outside the layers the U above applies. TVD shown.') + '</div>') +
            _card('Flow segments', '<div id="wp_segs"></div>') + '</div></section>';
        var s4 = '<section id="wp_step_4" class="wp-sec" style="display:none"><div class="wp-sec-h">④ Lift <span>natural flow, the gas-lift quick look or an ESP</span></div><div class="wp-2c">' +
            _card('Artificial lift', '<div class="fg">' + _fg('wp_lift', 'Lift type', { options: [['none', 'Natural flow'], ['gaslift', 'Gas lift (quick look)'], ['esp', 'ESP (electrical submersible pump)']] }) +
                _fg('wp_gl_qinj', 'Lift-gas injection rate', { unit: 'Mscf/d', data: 'data-lift="gaslift"', hint: 'The operating point uses it; 0 = natural flow. Drag the line on the performance curve.' }) +
                _fg('wp_gl_pinj', 'Surface injection (casing) pressure', { unit: 'psig', data: 'data-lift="gaslift"', ph: 'required' }) +
                _fg('wp_gl_sg', 'Lift-gas specific gravity', { unit: 'air = 1', data: 'data-lift="gaslift"' }) +
                _fg('wp_gl_dpv', 'Valve pressure drop ΔP', { unit: 'psi', data: 'data-lift="gaslift"', hint: 'Casing less tubing pressure needed to inject.' }) +
                _fg('wp_gl_packer', 'Packer (deepest injection) MD', { unit: 'ft', data: 'data-lift="gaslift"', hint: 'Blank = the end of the tubing.' }) +
                _fg('wp_gl_qlist', 'Performance-curve rates', { text: true, unit: _lab('gasRateSmall', 'Mscf/d'), data: 'data-lift="gaslift"', ph: '0 250 500 … 5000 (12 points)' }) +
                _fg('wp_gl_incgor', 'Incremental GOR limit (economic point)', { unit: 'scf/STB', data: 'data-lift="gaslift"', hint: '0 = the maximum rate.' }) + '</div>' +
                '<div class="wp-btns rp-skip" data-lift="gaslift"><button type="button" class="btn btn-primary" data-act="glpc">Run the gas-lift performance curve</button></div><div id="wp_glmsg" class="rp-skip"></div>' +
                '<div id="wp_glres" data-lift="gaslift" style="margin-top:12px"></div>' +
                '<div class="wp-hint" data-lift="esp" style="margin-top:10px">ESP: set the pump depth, frequency and stages and enter the pump curve below; the pump becomes a node of the system solve, and its plot (with the frequency and stages rails) sits in the results above.</div>' +
                '<div class="wp-hint" data-lift="none" style="margin-top:10px">Choose gas lift for the quick look: the injection depth solved at every rate on the deviated path, the lift-gas performance curve with the optimum and economic points and the rate gain over natural flow. Unloading valves, valve throughput, diagnosis from a test and a gradient survey: the gas-lift design card of this step.</div>') +
            _card('Gas-lift performance', '<div data-lift="gaslift"><div class="chart-wrap"><canvas id="wp_cv_glpc" aria-label="Gas-lift performance curve: liquid rate against the lift-gas rate; drag the line to change the injection rate"></canvas></div>' +
                '<div class="chart-wrap" style="margin-top:8px"><canvas id="wp_cv_gldepth" aria-label="Injection depth against the lift-gas rate"></canvas></div>' +
                '<div class="wp-legend-hint rp-skip">Drag the dashed <b>q_inj</b> line (or focus the plot, [ / ] then the arrows) and the well re-solves with that much lift gas.</div></div>' +
                '<div class="wp-v info" data-lift="none">The performance curve appears here with gas lift selected.</div>') + '</div>' + _ext('stepHtml', 4).join('') + '</section>';
        var s5 = '<section id="wp_step_5" class="wp-sec" style="display:none"><div class="wp-sec-h">⑤ System <span>node, surface boundary, correlations, ratings and studies</span></div><div class="wp-2c">' +
            _card('Surface and solve', '<div class="fg">' +
                _fg('wp_mode', 'Solve for', { options: [['rate', 'Rate at these settings'], ['pressure', 'Pressures for a rate'], ['max', 'Maximum rate (no choke)'], ['design', 'Bean or THP for a target rate']] }) +
                _fg('wp_node', 'Solution node', { options: [['bottom', 'Bottom hole (mid-perf)'], ['wellhead', 'Wellhead'], ['separator', 'Separator']] }) +
                _fg('wp_choke', 'Surface choke in line', { check: true }) +
                _fg('wp_bean', 'Choke bean', { unit: '/64 in', data: 'data-choke="on"' }) +
                _fg('wp_ckcorr', 'Choke model', { options: [['gilbert', 'Gilbert (critical)'], ['ros', 'Ros (critical)'], ['baxendell', 'Baxendell (critical)'], ['achong', 'Achong (critical)'], ['sachdeva', 'Sachdeva et al. (1986) — provisional']], data: 'data-choke="on"',
                    hint: '<span data-for="oil water">Critical correlations; below the critical ratio the rule underneath applies.</span><span data-for="gas condensate">Gas wells use the isentropic gas nozzle unless the two-phase Sachdeva model is chosen.</span>' }) +
                _fg('wp_cksub', 'Sub-critical flow', { options: [['bound', 'Conservative bound p1 ≥ p2 / 0.588'], ['sachdeva', 'Continuous — Sachdeva (provisional)']], data: 'data-choke="on" data-for="oil water" data-ck="crit"',
                    hint: 'Default: the critical correlation with the conservative bound. The provisional Sachdeva option sets the regime from its critical ratio and scales its sub-critical branch to the correlation at the critical point.' }) +
                _fg('wp_ckcd', 'Discharge coefficient Cd', { data: 'data-choke="on"', hint: 'Sachdeva 0.75 (to verify); gas nozzle 0.85 when outside 0.5–1.2.' }) +
                _fg('wp_ckrf', 'Rate factor', { data: 'data-choke="on" data-ck="sach"', ph: '1', hint: 'Multiplies the Sachdeva rate; Fit matches it to a critical correlation at the operating point.' }) +
                '<div class="fg-item rp-skip" data-choke="on" data-ck="sach"><label for="wpv_ckfit">Fit the rate factor to</label><div style="display:flex;gap:6px"><select id="wpv_ckfit" aria-label="Critical correlation to match">' +
                [['gilbert', 'Gilbert'], ['ros', 'Ros'], ['baxendell', 'Baxendell'], ['achong', 'Achong']].map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') +
                '</select><button type="button" class="btn btn-secondary" data-act="ckfit" style="padding:6px 10px">Fit</button></div><div id="wp_ckfitmsg"></div></div>' +
                _fg('wp_thp', 'Wellhead pressure (fixed)', { unit: 'psig', data: 'data-choke="off"' }) +
                _fg('wp_psep', 'Separator pressure', { unit: 'psig' }) + _fg('wp_tamb', 'Ambient temperature', { unit: '°F' }) +
                _fg('wp_tkind', 'Design variable', { options: [['bean', 'Bean'], ['thp', 'Wellhead pressure'], ['tubingId', 'Tubing size (catalogue scan)'], ['qinj', 'Lift-gas rate (gas lift)']], data: 'data-mode="design pressure"' }) + _fg('wp_tq', 'Target rate', { unit: 'STB/d or Mscf/d', data: 'data-mode="design pressure"' }) +
                '</div>' + _tableBlock('flowline', 'Flowline to the separator', 'Marched with the flowline correlation below.') +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="design" data-mode="design pressure">Solve the design</button><button type="button" class="btn btn-secondary" data-act="solve">Solve now</button></div><div id="wp_designmsg" class="rp-skip" role="status"></div><div id="wp_design"></div>') +
            _card('Correlations and numerics', '<div class="fg">' +
                _fg('wp_corr_well', 'Well (vertical lift)', { options: [['', 'Default for the fluid']].concat(wellCorr.map(function (c) { return [c.key, c.label + (c.verified ? '' : ' — provisional')]; })), hint: 'Compare every correlation at the operating point, and see the flow-regime map, on the Traverse card (Correlations · Flow-regime map).' }) +
                _fg('wp_corr_line', 'Flowline', { options: lineCorr.map(function (c) { return [c.key, c.label + (c.verified ? '' : ' — provisional')]; }) }) +
                _fg('wp_mult_hl', 'Holdup multiplier m_h', { hint: '1 = as published; fitted to the tests in ⑥ Match (VLP tuning, 0.8–1.25).' }) + _fg('wp_mult_f', 'Friction multiplier m_f', { hint: 'Fitted only when the tests span at least 2:1 in rate (0.7–1.5).' }) +
                _fg('wp_eroC', 'Erosional C', { unit: 'API RP 14E' }) + _fg('wp_stepFt', 'Step length', { unit: 'ft' }) + _fg('wp_refine', 'Refine steps', { check: true }) + '</div>' +
                '<div id="wp_secbar" class="wp-secwrap"></div>' +
                _tableBlock('corrSections', 'Per-section correlations', 'Rows in order: the first row that covers a part of the path sets its correlation (an MD interval, or an inclination band in degrees from vertical); the well correlation above applies elsewhere. Drag a boundary on the Traverse plot.',
                    { btns: '<button type="button" class="btn btn-secondary" data-act="secpreset" data-v="dev" title="Mukherjee-Brill where the hole is 30° or more from vertical">Deviated → Mukherjee-Brill</button>' +
                        '<button type="button" class="btn btn-secondary" data-act="secpreset" data-v="mech" title="Ansari below 30°, Hasan-Kabir above">Mechanistic by inclination</button>' +
                        '<button type="button" class="btn btn-secondary" data-act="secpreset" data-v="clear">Clear</button>' }) +
                '<div class="wp-sec-h" style="font-size:13px;margin-top:14px">Equipment ratings</div><div class="fg rp-skip">' +
                '<div class="fg-item"><label for="wpt_rate_wh">Wellhead rating (' + _esc(_lab('pressure', 'psi')) + ')</label><input id="wpt_rate_wh" data-rt="wellhead_psi" type="number" step="any" inputmode="decimal" placeholder="no default"></div>' +
                '<div class="fg-item"><label for="wpt_rate_tht">Maximum THT (' + _esc(_lab('temperature', '°F')) + ')</label><input id="wpt_rate_tht" data-rt="tht_max_F" type="number" step="any" inputmode="decimal" placeholder="no default"></div>' +
                '<div class="fg-item"><label for="wpt_beans">Bean list (/64 in)</label><input id="wpt_beans" data-rt="beans" type="text" placeholder="16 20 24 32 40 48"></div></div>' +
                '<div class="wp-sec-h" style="font-size:13px;margin-top:14px">Studies</div><div class="fg rp-skip">' +
                '<div class="fg-item"><label for="wpv_svar">Sensitivity variable</label><select id="wpv_svar">' + _sensDefs().map(function (v) { return '<option value="' + _esc(v[0]) + '">' + _esc(_sensVarLabel(v[0])) + '</option>'; }).join('') + '</select></div>' +
                '<div class="fg-item"><label for="wpv_svals">Values (up to 10, in the variable\'s units)</label><input id="wpv_svals" type="text" value="0 20 40 60 80" spellcheck="false" autocomplete="off"></div>' +
                '<div class="fg-item"><label for="wpv_svar2">Second variable (optional)</label><select id="wpv_svar2"><option value="">— none: one variable —</option>' + _sensDefs().map(function (v) { return '<option value="' + _esc(v[0]) + '">' + _esc(_sensVarLabel(v[0])) + '</option>'; }).join('') + '</select></div>' +
                '<div class="fg-item" data-sv2="on"><label for="wpv_svals2">Second values (a rate line each)</label><input id="wpv_svals2" type="text" value="" spellcheck="false" autocomplete="off"></div></div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="sens">Run sensitivity</button><button type="button" class="btn btn-secondary" data-act="beans">Bean schedule</button><button type="button" class="btn btn-secondary" data-act="csv">Export CSV</button></div>' +
                '<div id="wp_jobbox" class="rp-skip"></div>') + '</div>' +
            // study results full width (the two-variable heat map and the bean schedule need the room)
            '<div class="wp-studies"><div id="wp_senstbl"></div><div id="wp_beans"></div></div>' + _ext('stepHtml', 5).join('') + '</section>';
        var s6 = '<section id="wp_step_6" class="wp-sec" style="display:none"><div class="wp-sec-h">⑥ Match <span>production tests, correlation comparison, QC and IPR from a test</span></div>' +
            _card('Production tests', _tableBlock('tests', 'Tests', 'Gauge MD and gauge pressure let the comparison rank the correlations at the gauge.') +
                '<div class="fg rp-skip" style="margin-top:12px"><div class="fg-item"><label>Correlations to compare</label><div id="wp_corrset" style="display:flex;flex-wrap:wrap;gap:10px;font-size:12.5px">' +
                wellCorr.map(function (c) { return '<label style="display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;color:var(--text)"><input type="checkbox" data-corr="' + _esc(c.key) + '" checked> ' + _esc(c.label) + '</label>'; }).join('') + '</div></div>' +
                '<div class="fg-item"><label for="wpv_mtest">Test to compare</label><select id="wpv_mtest"><option value="0">first used test</option></select></div>' +
                _fg('wp_m_solve', 'Back-calculate from the test', { options: [['pr', 'Reservoir pressure p̄r (coefficients held)'], ['J', 'Productivity (p̄r held)'], ['S', 'Skin S (k·h held, Darcy)']], def: 'pr' }) + '</div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="match">Compare and QC</button><button type="button" class="btn btn-secondary" data-act="fitU" data-heat="relax">Fit U to the test THTs</button></div><div id="wp_ufit6" class="rp-skip" data-heat="relax"></div><div class="wp-hint">Each correlation is marched from the measured THP down the surveyed path at the test\'s own rates and THT; the QC checks every test (used or not).</div><div id="wp_matchres" style="margin-top:10px"></div>') +
            _card('VLP tuning', '<div class="fg rp-skip">' +
                '<div class="fg-item"><label for="wpv_tcorr">Correlation to tune</label><select id="wpv_tcorr"><option value="">The model\'s well correlation</option>' + wellCorr.map(function (c) { return '<option value="' + _esc(c.key) + '">' + _esc(c.label + (c.verified ? '' : ' — provisional')) + '</option>'; }).join('') + '</select></div>' +
                '<div class="fg-item"><label for="wpv_tfree">Multipliers to fit</label><select id="wpv_tfree"><option value="auto">Automatic (rule D10)</option><option value="hl">Holdup m_h only</option><option value="hlf">Holdup m_h and friction m_f</option></select></div></div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="tune">Tune to the tests</button></div>' +
                '<div class="wp-hint">Levenberg-Marquardt fits the holdup multiplier (H_L\' = clamp(m_h·H_L, λ_L, 1)) and, when the tests span at least 2:1 in rate, the friction multiplier to the gauge pressures of the used tests; density, friction and acceleration are rebuilt inside the march on the surveyed path. Apply sends the multipliers into every solve.</div>' +
                '<div id="wp_tunebox" class="rp-skip"></div><div class="rbox wp-tune" id="wp_tuneres" style="margin-top:10px"></div>') + '</section>';
        var s7 = '<section id="wp_step_7" class="wp-sec" style="display:none"><div class="wp-sec-h">⑦ Report <span>what the page report and the Quick Report carry</span></div>' +
            _card('Report', '<div class="wp-notes">The page report (PDF / PNG from the page export bar) and the Quick Report carry the block at the top of this page: the KPI strip, the well schematic, the system plot, the operating point, the pressure-loss breakdown, the checks, the traverse card, the correlation validity, the case summary, the studies and tuning summary (PVT family, the PVT lab match, the condensate and emulsion models, temperature model and fitted U, gas-lift injection point, optimum, economic point and gain, VLP tuning m_h / m_f and RMS, the sensitivity grid), the last lift-curve table and the Notes. ' +
                'Full tables (traverse, curves, sensitivity, bean schedule) are in the CSV.</div>' +
                '<div class="fg" style="margin-top:12px">' + _fg('wp_notes', 'Engineer notes (printed in the Notes)', { area: true, rows: 4, def: '', ph: 'Assumptions, data sources, decisions…' }) + '</div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="csv">Export CSV bundle</button></div>') +
            // B (WP20): lift-curve tables and PVT tables (49-calc-wp-tables.js; its summary #wp_ltsum sits in #wp_res)
            (G.WTS_wp_tables && typeof G.WTS_wp_tables.html === 'function' ? G.WTS_wp_tables.html() : '') +
            (G.WTS_wp_wellsUi ? G.WTS_wp_wellsUi.stepHtml() : '') + '</section>';
        return s1 + s2 + s3 + s4 + s5 + s6 + s7;
    }
    function _resHtml() {
        var prop = _plots().prop || 'pressure';
        return '<div id="wp_res">' +
            '<div class="wp-banner rp-skip" id="wp_banner"></div>' +
            '<div class="wp-kpis" id="wp_kpis" aria-live="polite"></div>' +
            '<div class="wp-bench" id="wp_bench">' +
            _card('Well', '<div class="wp-schw" id="wp_schw"><div id="wp_sch"></div><div class="wp-tip" id="wp_tip" role="status"></div></div><div class="wp-legend-hint" id="wp_sch_cap"></div>' +
                '<div class="wp-legend-hint rp-skip">Hover the well for MD, TVD, inclination, pressure, temperature and holdup; click a string, restriction, the perforations, a gauge or the choke to edit it.</div>',
                { tools: '<label for="wpv_prop" style="font-size:11px;color:var(--text2)">Colour by</label><select id="wpv_prop" aria-label="Colour the well by">' +
                    [['pressure', 'Pressure'], ['temperature', 'Temperature'], ['heatloss', 'Fluid − earth ΔT'], ['jt', 'J-T + gravity ΔT'], ['holdup', 'Holdup'], ['velocity', 'Velocity'], ['pattern', 'Flow pattern'], ['correlation', 'Correlation'], ['none', 'None']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === prop ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' }) +
            _card('System — inflow and outflow', '<div class="chart-wrap"><canvas id="wp_cv_sys" aria-label="System plot: inflow and outflow curves, operating point; drag the handles to change the reservoir pressure, the wellhead pressure, the bean or the water cut"></canvas></div>' +
                '<div class="wp-legend-hint rp-skip">Drag a handle — <b>p̄r</b> on the inflow curve, <b>THP</b> on the right rail, <b>bean</b> and <b>WC</b> on the top rails — and the well re-solves. Wheel or pinch to zoom, drag to pan, double-click to reset; click the legend to hide a curve. Keyboard: [ and ] pick a handle, arrows move it, Enter commits.</div>') +
            '</div>' +
            '<div class="wp-row3">' +
            '<div class="rbox" id="wp_op"></div>' +
            _card('Pressure-loss breakdown', '<div class="chart-wrap"><canvas id="wp_cv_bd" aria-label="Pressure-loss breakdown"></canvas></div>', { cls: 'wp-bdcard' }) +
            '<div class="rbox" id="wp_verd"></div>' +
            '</div>' +
            _card('Traverse', '<div class="chart-wrap"><canvas id="wp_cv_tr" aria-label="Gradient traverse: pressure and temperature against depth"></canvas></div><div class="wp-legend-hint" id="wp_trleg"></div><div id="wp_corrtbl" class="wp-corrtbl"></div>',
                { tools: '<span class="wp-tabs" id="wp_trtabs" role="tablist">' + [['traverse', 'Pressure & temperature'], ['corr', 'Correlations'], ['map', 'Flow-regime map'], ['loading', 'Liquid loading'], ['choke', 'Choke'], ['sens', 'Sensitivity'], ['beans', 'Bean schedule']].map(function (t) { return '<button type="button" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</span>' +
                    '<span class="wp-seg" id="wp_depthseg"><button type="button" data-depth="tvd">TVD</button><button type="button" data-depth="md">MD</button></span>' }) +
            _ext('resHtml').join('') +
            // review fix (v4.5): the inflow-study plot and the condensate plots are results — inside #wp_res, so the page report and the
            // Quick Report carry them from any step (their inputs stay in steps ① / ②)
            '<div id="wp_iprsbox" class="wp-off">' + _card('Inflow study', '<div class="wp-hint" id="wp_iprs_t" style="margin:0 0 6px;font-weight:700;color:var(--text2)"></div><div class="chart-wrap"><canvas id="wp_cv_iprs" tabindex="0" aria-label="Inflow study plot with a drag handle on the model variable"></canvas></div><div class="wp-legend-hint rp-skip" id="wp_iprs_n"></div>', {}) + '</div>' +
            '<div data-for="gas condensate" data-rv="table">' + _card('Condensate along the well', '<div id="wp_rvk" aria-live="polite"></div><div class="chart-wrap" style="margin-top:8px"><canvas id="wp_cv_rv" tabindex="0" aria-label="Vaporised and free condensate against pressure, with the dew point handle"></canvas></div>' +
                '<div class="chart-wrap" style="margin-top:8px"><canvas id="wp_cv_rvd" tabindex="0" aria-label="Free condensate along the well at the operating point against depth"></canvas></div>' +
                '<div class="wp-hint rp-skip">Drag the dew point on the left plot: the drop-out depth follows on release. The right plot reads MD and TVD along the deviated well (the TVD / MD switch of the traverse card).</div>') + '</div>' +
            '<div class="rbox" id="wp_valid"></div>' +
            '<div class="rbox wp-case" id="wp_case"></div>' +
            '<div class="rbox wp-case" id="wp_studies"></div>' +
            '<div class="rbox wp-case" id="wp_ltsum"></div>' +
            (G.WTS_wp_wellsUi ? G.WTS_wp_wellsUi.html() : '') +                       // B (WP28): all wells — map of operating points
            '<div class="wp-notes" id="wp_notesbox" style="margin:var(--wp-gap) 0"></div>' +
            '</div>' +
            '<details class="wp-drawer rp-skip" id="wp_drawer"><summary>Full results <span class="wp-hint" id="wp_drawer_sum" style="margin:0 0 0 6px"></span></summary><div class="wp-drawer-b" id="wp_drawer_b"></div></details>';
    }

    function render(body) {
        body.innerHTML = CSS + '<div id="wp_root">' + _stepsHtml() + _resHtml() + _sectionsHtml() + '</div>';
        // checkbox defaults (the model defaults; restore applies the saved values)
        _tag(UNITS);
        ST.M = _read();
        _renderAllTables();
        _syncUi();
        _sensFit();
        _bindRoot();
        if (G.WTS_wp_tables && typeof G.WTS_wp_tables.bind === 'function') G.WTS_wp_tables.bind();
        // With autosave on, the host restores the saved values silently right after this render and then calls hooks.after,
        // which runs the one calc (as 49-calc-cheminj.js); otherwise calc now.
        var AS = G.WTS_pageAutosave;
        var hostRestores = !!(AS && typeof AS.page === 'function' && AS.page() === 'wellperf' && typeof AS.enabled === 'function' && AS.enabled('wellperf') && body.id === 'pgBody');
        if (!hostRestores) G.calcWellPerf();
    }
    G.renderWellPerf = render;

    function _bindRoot() {
        var root = _byId('wp_root'); if (!root || !root.addEventListener) return;
        root.addEventListener('change', function (e) {
            var t = e.target; if (!t) return;
            if (t.getAttribute && t.getAttribute('data-t')) {
                var name = t.getAttribute('data-t');
                if (/^wp_pastet_/.test(t.id || '')) return;
                _writeTable(name, _collectTable(name));
                return;
            }
            if (t.getAttribute && t.getAttribute('data-rt')) { _ratingWrite(); return; }
            if (t.id && t.id.indexOf('wpv_') === 0 && _ext('change', t).some(Boolean)) return;
            if (t.id === 'wpv_prop') { _plotsSet({ prop: t.value }); _renderSchematic(); return; }
            if (t.id === 'wpv_svar') { _sensSuggest(); return; }
            if (t.id === 'wpv_svar2') { _sensSuggest(2); _syncUi(); return; }
            if (t.getAttribute && t.getAttribute('data-corr')) return;
            if (t.id && t.id.indexOf('wpl_') === 0) { _labInputsWrite(); return; }
            if (!t.id || t.id.indexOf('wp_') !== 0) return;
            if (t.id === 'wp_corr_pb' || t.id === 'wp_corr_rs') _famSync(t.id);
            if (t.id === 'wp_ipr' || t.id === 'wp_ftype' || t.id === 'wp_choke' || t.id === 'wp_mode' || t.id === 'wp_heat' || t.id === 'wp_ckcorr' || t.id === 'wp_lift' || t.id === 'wp_rvmode' || t.id === 'wp_emul') _syncUi();
            if (t.id === 'wp_ftype') _renderTable('corrSections');        // the dry-gas keys are offered for gas wells only (WP21)
            if (e.isTrusted && ST.prov[t.id]) { delete ST.prov[t.id]; var lab = root.querySelector('label[for="' + t.id + '"] .wp-chip'); if (lab && lab.parentNode) lab.parentNode.removeChild(lab); }
            G.calcWellPerf();
        });
        root.addEventListener('click', function (e) {
            if (G.WTS_wp_wellsUi && G.WTS_wp_wellsUi.onClick(e)) return;           // a row of the all-wells table (B, WP28)
            var t = e.target, b = t && t.closest ? t.closest('button,[data-comp]') : null;
            if (!b || !root.contains(b)) return;
            if (b.getAttribute('data-step')) { _goStep(+b.getAttribute('data-step'), true); return; }
            if (b.getAttribute('data-comp')) { _editComp(b.getAttribute('data-comp')); return; }
            if (b.getAttribute('data-del')) {
                var tn = b.getAttribute('data-del'), tr = b.closest('tr'); if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
                _writeTable(tn, _collectTable(tn)); _renderTable(tn); return;
            }
            if (b.getAttribute('data-tab')) { _plotsSet({ trTab: b.getAttribute('data-tab') }); _renderTraverseCard(); return; }
            if (b.getAttribute('data-mapk')) { _plotsSet({ mapKind: b.getAttribute('data-mapk') }); _renderTraverseCard(); return; }
            if (b.getAttribute('data-depth')) { _plotsSet({ depth: b.getAttribute('data-depth') }); _renderTraverseCard(); return; }
            if (b.getAttribute('data-mdepth')) { _plotsSet({ mdepth: b.getAttribute('data-mdepth') }); Array.prototype.forEach.call(document.querySelectorAll('#wp_mdepth button'), function (x) { if (x.classList) x.classList.toggle('on', x === b); }); _drawMatchPlot(); _drawTunePlot(); return; }
            var act = b.getAttribute('data-act'); if (act) _act(act, b);
        });
        root.addEventListener('input', function (e) { var t = e.target; if (t && t.id && t.id.indexOf('wpv_') === 0) _ext('input', t); });
        root.addEventListener('keydown', function (e) {
            if (G.WTS_wp_wellsUi && G.WTS_wp_wellsUi.onKey(e)) return;
            var t = e.target;
            if ((e.key === 'Enter' || e.key === ' ') && t && t.getAttribute && t.getAttribute('data-comp')) { if (e.preventDefault) e.preventDefault(); _editComp(t.getAttribute('data-comp')); }
        });
        var sw = _byId('wp_schw');
        if (sw) {
            sw.addEventListener('pointermove', _schHover);
            sw.addEventListener('pointerleave', function () { var tip = _byId('wp_tip'); if (tip) tip.className = 'wp-tip'; var mk = sw.querySelector('.wp-hover'); if (mk) mk.style.display = 'none'; });
        }
    }
    function _ratingWrite() {
        var Mm = G.WTS_wp_model; if (!Mm) return;
        var a = parseFloat((_byId('wpt_rate_wh') || {}).value), b = parseFloat((_byId('wpt_rate_tht') || {}).value), c = String((_byId('wpt_beans') || {}).value || '');
        Mm.write({ rating: { wellhead_psi: _fin(a) ? _fromDisp(a, 'pressure') : null, tht_max_F: _fin(b) ? _fromDisp(b, 'temperature') : null },
                   beans: c.split(/[;\s,]+/).map(parseFloat).filter(_fin) });
    }

    // ── registry ──────────────────────────────────────────────────────────────
    G.WTS_wellperf_page = {
        calcs: function () { return calcs; },
        budget: function (ms) { if (_fin(ms)) { budgetMs = ms; ST.slow = false; } return budgetMs; },
        state: function () { return ST; },
        csv: function () { return _csv(); },
        handle: function (key, v, phase) { _onHandle(key, v, phase || 'move'); },
        goStep: function (n) { _goStep(n, false); },
        examples: function () { return JSON.parse(JSON.stringify(EXAMPLES)); },
        resetJobs: function () { _ext('reset'); if (G.WTS_wp_wellsUi) G.WTS_wp_wellsUi.reset(); ST.sens = null; ST.beans = null; ST.match = null; ST.design = null; ST.gl = null; ST.sensSel = null; ST.prov = {}; ST.slow = false; ST.tune = null; ST.tuneTests = null; ST.tunePrev = null; ST.untuned = null; ST.pvtm = null; ST.pvtmEdit = null; ST.pvtmKey = null; ST.pvtmCache = null; },
        pvtmHandle: function (key, v, phase) { _pvtmHandle(key, v, phase || 'move'); },
        tuneHandle: function (key, v, phase) { _tuneHandle(key, v, phase || 'move'); },
        // the page helpers an extension (window.WTS_wellperf_ext) draws with — display units, cards, Jobs, the input path — ui() returns them all;
        // the same object's WP28 subset is also on ui itself (49-calc-wp-wells.js reads WTS_wellperf_page.ui.u …)
        ui: (function () {
            var f = function () {
                return { ST: ST, PATM: PATM, PROVISIONAL: PROVISIONAL_TXT, byId: _byId, esc: _esc, fin: _fin, fmt: _fmt, fx: _fx, u: _u, dv: _dv, fromDisp: _fromDisp, lab: _lab, metric: _metric,
                    rateCat: _rateCat, isGas: _isGasType, read: _read, card: _card, fg: _fg, kpiHtml: _kpiHtml, vHtml: _vHtml, drive: _drive, jobOf: _jobOf, call: _call, fn: _fn,
                    setCtrl: _setCtrl, commit: _commit, syncUi: _syncUi, liveScalars: _liveScalars, plots: _plots, plotsSet: _plotsSet, mdTvdTxt: _mdTvdTxt, tvdAt: _tvdAt,
                    tempDiff: _tempDiff, msgU: _msgU, dls: _dls, phone: _phone, reduced: _reduced, parseList: _parseList, fmtListNum: _fmtListNum, decComma: _decComma, sensVarLabel: _sensVarLabel, sensDv: _sensDv,
                    renderSystemPlot: _renderSystemPlot, renderStudies: _renderStudies, renderSchematic: _renderSchematic, renderNotes: _renderNotes, renderAllTables: _renderAllTables,
                    goStep: function (n) { _goStep(n, true); }, solveNow: _solveNow, mkey: _mkey,
                    solveLive: function () { if (!ST.slow && _liveMs() <= LIVE_MS) { _solveLive(); return true; } return false; } };
            };
            var w = { u: _u, dv: _dv, lab: _lab, fmt: _fmt, esc: _esc, vHtml: _vHtml, drive: function (job, onDone, label, boxId) { _drive(job, onDone, label, boxId); },
              liveScalars: function () { return _byId('wp_root') ? _liveScalars() : null; }, reduced: _reduced, phone: _phone };
            Object.keys(w).forEach(function (k) { f[k] = w[k]; });
            return f;
        })(),
        publishWells: function () { var S0 = G.WTS_state && G.WTS_state.wellperf; if (S0 && typeof S0 === 'object') S0.wells = G.WTS_wp_wellsUi ? G.WTS_wp_wellsUi.summary() : null; }
    };
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.wellperf = {
        key: 'wellperf',
        title: TITLE,
        navTitle: 'Nodal Analysis',
        sub: SUB,
        group: 'Production & Reservoir',
        icon: '&#8645;',
        badge: 'Production',
        bc: 'dc-b-green',
        desc: 'Nodal analysis of a well: inflow, vertical lift with deviation, choke and flowline to the separator; operating point and stability, choke sizing, shut-in pressure and liquid loading.',
        hooks: { silent: true, after: function () { _syncUi(); _renderAllTables(); _sensFit(); G.calcWellPerf(); } },
        render: function (body) { return G.renderWellPerf(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        // a well switch or a project open (one solve per switch, §2.6). 29-multiwell (_after) and 29-project-save (open) emit
        // 'wts:project-loaded' {loaded, …} and 'wts:well-changed' {id, list} and then re-render the open page, whose silent restore
        // (hooks.after) solves the new model with its restored controls. So a host event only clears the study results here: solving
        // now would read the previous well's controls (a wrong, wasted solve). Any other dispatch re-reads the model and solves when it
        // differs from the last solve.
        var again = function (e) {
            if (!_byId('wp_root')) return;
            _ext('reset');
            ST.sens = null; ST.beans = null; ST.match = null; ST.prov = {}; ST.tune = null; ST.tunePrev = null; ST.untuned = null; var mr = _byId('wp_matchres'); if (mr) mr.innerHTML = ''; var tr0 = _byId('wp_tuneres'); if (tr0) tr0.innerHTML = '';
            var b1 = _byId('wp_senstbl'); if (b1) b1.innerHTML = ''; var b2 = _byId('wp_beans'); if (b2) b2.innerHTML = '';
            var d = e && e.detail, hostRerenders = !!(d && (Array.isArray(d.loaded) || Array.isArray(d.list)) && typeof G.WTS_rerender === 'function');
            if (hostRerenders) return;
            _renderAllTables();
            var M = _read();
            if (ST.R && !ST.stale && ST.lastKey && _mkey(M) === ST.lastKey) { ST.M = M; _renderAll(false); return; }
            G.calcWellPerf();
        };
        document.addEventListener('wts:well-changed', again);
        document.addEventListener('wts:project-loaded', again);
        document.addEventListener('wts:wellperf-model-changed', function (e) { if (_byId('wp_root')) { if (!ST.batch) G.calcWellPerf(); if (!e || !e.detail || !e.detail.keys || e.detail.keys.indexOf('tests') !== -1) _syncMatchTests();
            // B (WP22): a geo write from elsewhere (an import, a script) shows in the geotherm and heat-layer tables unless one is being edited
            var ae = document.activeElement; if (e && e.detail && e.detail.keys && e.detail.keys.indexOf('geo') !== -1 && !(ae && ae.closest && ae.closest('#wp_tbl_geo,#wp_tbl_hlayers'))) ['geo', 'hlayers'].forEach(_renderTable); } });
        document.addEventListener('wts:unit-system-changed', function () {
            if (!_byId('wp_root')) return;
            _qlistUnits(); _relabelUntagged();
            _renderAllTables();
            G.calcWellPerf();
            _renderMatch();
            _renderTune();
        });
    }
    if (typeof G.addEventListener === 'function') {
        G.addEventListener('resize', function () {
            if (!_byId('wp_root') || !G.WTS_wp_view) return;
            ['wp_cv_sys', 'wp_cv_tr', 'wp_cv_ipr', 'wp_cv_iprs', 'wp_cv_match', 'wp_cv_glpc', 'wp_cv_gldepth', 'wp_cv_tub', 'wp_cv_tune', 'wp_cv_tobj', 'wp_cv_pvtm', 'wp_cv_rv', 'wp_cv_rvd', 'wp_cv_emul'].forEach(function (id) { var c = _byId(id); if (c) G.WTS_wp_view.redraw(c); });
            _renderBreakdown(); _renderSchematic(); _ext('resize');
            if (G.WTS_wp_wellsUi) G.WTS_wp_wellsUi.redraw();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var e = G.WTS_calcRegistry && G.WTS_calcRegistry.wellperf;
    if (!(e && e.key === 'wellperf' && typeof e.render === 'function' && e.hooks && e.hooks.silent === true) && typeof console !== 'undefined') console.error('[wellperf self-test] registry entry malformed');
})();
