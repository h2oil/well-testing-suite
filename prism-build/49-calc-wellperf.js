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
               live: false, job: null, sens: null, beans: null, design: null, match: null, qc: null, prov: {}, lastErr: null };

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
    function _fmt(v, d) {
        if (v == null || !_fin(v)) return '—';
        var s = Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
        return s === '-0' ? '0' : s;
    }
    function _u(v, cat, d, imp, dMet) { if (!_fin(v)) return '—'; return _fmt(_dv(v, cat), _metric() ? (dMet == null ? d : dMet) : d) + ' ' + _lab(cat, imp); }
    function _canon(fn) { var U = _U(); return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _tag(map) { var U = _U(); if (!U || !U.tagInput) return; Object.keys(map).forEach(function (id) { if (_byId(id)) U.tagInput(id, map[id]); }); }
    function _tempDiff(dF) { return _metric() ? _fmt(dF * 5 / 9, 1) + ' °C' : _fmt(dF, 1) + ' °F'; }

    var UNITS = {
        wp_fpsep: 'pressureG', wp_ftsep: 'temperature', wp_gor: 'gor', wp_cgr: 'cgr', wp_wgr: 'cgr', wp_pbUser: 'pressure',
        wp_pr: 'pressure', wp_tres: 'temperature', wp_respb: 'pressure', wp_datumOff: 'length', wp_perfTop: 'length', wp_perfBot: 'length',
        wp_midPerf: 'length', wp_surfT: 'temperature', wp_tht: 'temperature', wp_Uto: 'heatTransferCoef', wp_ke: 'thermalConductivity',
        wp_psep: 'pressureG', wp_tamb: 'temperature', wp_thp: 'pressureG', wp_stepFt: 'length', wp_gl_packer: 'length', wp_gl_pinj: 'pressureG',
        wp_gl_dpv: 'pressure', wp_ip_J: 'productivityIndex', wp_ip_qmax: 'liquidRate', wp_ip_k: 'permeability', wp_ip_h: 'length',
        wp_ip_rw: 'length', wp_ip_re: 'length', wp_ip_D: 'nonDarcyD'
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
        return out;
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
        re: { l: 'Drainage radius re', cat: 'length', u: 'ft' }, S: { l: 'Skin S', u: '' }, D: { l: 'Non-Darcy D', cat: 'nonDarcyD', u: 'd/Mscf' }
    };
    var IPR_FALLBACK = [
        ['pi', 'Straight-line PI', 'oil', ['J']], ['vogel', 'Vogel with flow efficiency', 'oil', ['qmax', 'FE']], ['composite', 'Composite (PI above pb, Vogel below)', 'oil', ['J']],
        ['fetkovich', 'Fetkovich C and n', 'oil', ['C', 'n']], ['jbgOil', 'Jones-Blount-Glaze two-term oil', 'oil', ['A', 'B']], ['darcyOil', 'Darcy radial oil (k·h, skin)', 'oil', ['k', 'h', 'rw', 're', 'S']],
        ['backPressure', 'Back-pressure C and n', 'gas', ['C', 'n']], ['litP2', 'LIT in p²', 'gas', ['a', 'b']], ['litMp', 'LIT in m(p)', 'gas', ['a', 'b']],
        ['darcyGas', 'Darcy radial gas with non-Darcy D', 'gas', ['k', 'h', 'rw', 're', 'S', 'D']]
    ];
    function _iprModels() {
        var reg = G.WTS_wp_ipr && G.WTS_wp_ipr.models, out = [];
        IPR_FALLBACK.forEach(function (r) {
            var m = reg && reg[r[0]];
            out.push({ key: r[0], label: (m && m.label) || r[1], kind: (m && m.kind) || r[2], needs: (m && Array.isArray(m.needs)) ? m.needs.filter(function (k) { return IP[k]; }) : r[3],
                       verified: m ? m.verified !== false : true });
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
        return '<div class="card wp-card' + (o.cls ? ' ' + o.cls : '') + '"' + (o.id ? ' id="' + o.id + '"' : '') + '><div class="card-title">' + _esc(title) + (o.tools ? '<span class="wp-tools rp-skip">' + o.tools + '</span>' : '') + '</div>' + body + '</div>';
    }

    var CSS = '<style>' +
        '#wp_root{--wp-gap:14px;--wp-ok:var(--green,#3fb950);--wp-warn:var(--yellow,#d29922);--wp-fail:var(--red,#f85149)}' +
        '#wp_root .wp-steps{position:sticky;top:-24px;z-index:5;display:flex;gap:6px;align-items:center;margin:-6px 0 14px;padding:8px 0;background:var(--bg1);overflow-x:auto;scrollbar-width:thin}' +
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
        '#wp_root .wp-row3{display:grid;grid-template-columns:1fr 1.15fr 1fr;gap:var(--wp-gap);align-items:start}' +
        '#wp_root .wp-card{margin-bottom:var(--wp-gap);padding:16px}' +
        '#wp_root .wp-card .card-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
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
        '#wp_root .wp-drawer-b{padding:0 16px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}' +
        '#wp_root .wp-tw{overflow-x:auto;max-width:100%}#wp_root .wp-tw .dtable td,#wp_root .wp-tw .dtable th{white-space:nowrap}' +
        '#wp_root .wp-tw .dtable td.num{text-align:right;font-variant-numeric:tabular-nums}' +
        '#wp_root .wp-ed td{padding:3px 4px}#wp_root .wp-ed input,#wp_root .wp-ed select{width:100%;min-width:64px}' +
        '#wp_root .wp-ed td.ro{color:var(--text2);font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums}' +
        '#wp_root .wp-ed tr.wp-flash td{animation:wpflash 1.4s ease-out}@keyframes wpflash{0%{background:rgba(240,136,62,.35)}100%{background:transparent}}' +
        '#wp_root .wp-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}#wp_root .wp-btns .btn{padding:7px 13px;font-size:12px}' +
        '#wp_root .wp-hint{font-size:11px;color:var(--text3);margin-top:4px;line-height:1.4}' +
        '#wp_root .wp-off{display:none!important}' +
        '#wp_root .wp-check label{display:flex;align-items:center;gap:8px;text-transform:none;font-size:12.5px;color:var(--text);letter-spacing:0;margin-top:20px}' +
        '#wp_root .wp-chip{display:inline-block;font-size:10px;font-weight:700;padding:1px 7px;border-radius:9px;background:rgba(88,166,255,.14);color:var(--blue);margin-left:6px;text-transform:none;letter-spacing:0;vertical-align:middle}' +
        '#wp_root .wp-chip.prov{background:rgba(210,153,34,.15);color:var(--wp-warn)}' +
        '#wp_root .wp-qc td.qc{text-align:center;padding:4px 6px}#wp_root .wp-qcb{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;border-radius:10px;font-size:11px;font-weight:800;background:var(--bg4);color:var(--text3);cursor:help}' +
        '#wp_root .wp-qcb.ok{background:rgba(63,185,80,.15);color:var(--wp-ok)}#wp_root .wp-qcb.warn{background:rgba(210,153,34,.17);color:var(--wp-warn)}#wp_root .wp-qcb.fail{background:rgba(248,81,73,.17);color:var(--wp-fail)}' +
        '#wp_root .wp-score{display:inline-block;min-width:34px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}' +
        '#wp_root .wp-bar{position:relative;height:8px;border-radius:4px;background:var(--bg4);min-width:90px;overflow:hidden}#wp_root .wp-bar i{position:absolute;top:0;bottom:0;border-radius:4px;transition:width .2s,left .2s}' +
        '#wp_root .wp-mres{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:var(--wp-gap);align-items:start;margin-top:12px}' +
        '@media (max-width:1000px){#wp_root .wp-mres{grid-template-columns:1fr}}' +
        '#wp_root .wp-prog{height:4px;border-radius:2px;background:var(--bg4);overflow:hidden;margin-top:8px}#wp_root .wp-prog i{display:block;height:100%;background:var(--accent);transition:width .2s}' +
        '#wp_root .wp-paste{display:none;margin-top:8px}#wp_root .wp-paste.on{display:block}#wp_root .wp-paste textarea{width:100%;min-height:90px;font-family:monospace;font-size:12px}' +
        '#wp_root .wp-sec{animation:wpfade .18s ease-out}@keyframes wpfade{from{opacity:.4;transform:translateY(4px)}to{opacity:1;transform:none}}' +
        '#wp_root .wp-sec-h{display:flex;align-items:baseline;gap:10px;margin:4px 0 12px;font-size:15px;font-weight:700;color:var(--text)}#wp_root .wp-sec-h span{font-size:12px;font-weight:500;color:var(--text3)}' +
        '#wp_root .wp-2c{display:grid;grid-template-columns:1fr 1fr;gap:var(--wp-gap);align-items:start}' +
        '#wp_root .rbox{margin-top:0}' +
        '#wp_root .wp-stale #wp_bench,#wp_root .wp-stale .wp-kpis{opacity:.55;transition:opacity .2s}' +
        '@media (max-width:1180px){#wp_root .wp-row3{grid-template-columns:1fr 1fr}#wp_root .wp-row3>:last-child{grid-column:1/-1}}' +
        '@media (max-width:1000px){#wp_root .wp-bench,#wp_root .wp-2c{grid-template-columns:1fr}}' +
        '@media (max-width:640px){#wp_root .wp-row3{grid-template-columns:1fr}#wp_root .wp-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}#wp_root .wp-kpi .kpi-v{font-size:15px}' +
        '#wp_root .wp-card{padding:12px}#wp_root .wp-steps{top:-14px}#wp_root .wp-tools{margin-left:0;width:100%}#wp_root .wp-drawer-b{grid-template-columns:1fr}}' +
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
        flowline: function () { return [{ k: 'name', l: 'Name', text: true }, { k: 'len', l: 'Length', cat: 'length', u: 'ft' }, { k: 'id', l: 'ID', cat: 'lengthSmall', u: 'in' }, { k: 'dz', l: 'Rise', cat: 'length', u: 'ft' }]; },
        tests: function () {
            return [{ k: 'id', l: 'Test', text: true }, { k: 'date', l: 'Date', text: true }, { k: 'q_o', l: 'Oil', cat: 'liquidRate', u: 'STB/d' }, { k: 'q_w', l: 'Water', cat: 'liquidRate', u: 'BWPD' },
                    { k: 'q_g', l: 'Gas', cat: 'gasRateSmall', u: 'Mscf/d' }, { k: 'thp_psig', l: 'THP', cat: 'pressureG', u: 'psig' }, { k: 'tht_F', l: 'THT', cat: 'temperature', u: '°F' },
                    { k: 'bean64', l: 'Bean', u: '/64' }, { k: 'gaugeMd', l: 'Gauge MD', cat: 'length', u: 'ft' }, { k: 'gauge_psia', l: 'Gauge p', cat: 'pressure', u: 'psia' }];
        }
    };
    function _tableRows(M, t) {
        if (!M) return [];
        if (t === 'survey') return (M.well.survey || []).map(function (r) { return r.slice(); });
        if (t === 'strings') return (M.well.strings || []).map(function (r) { return Object.assign({}, r); });
        if (t === 'restrictions') return (M.well.restrictions || []).map(function (r) { return Object.assign({}, r); });
        if (t === 'geo') return ((M.well.geo && M.well.geo.points) || []).map(function (r) { return r.slice(); });
        if (t === 'flowline') return (M.surface.flowline || []).map(function (r) { return Object.assign({}, r); });
        if (t === 'tests') return (M.tests || []).map(function (r) { return Object.assign({}, r); });
        return [];
    }
    function _cellVal(c, v) {
        if (c.opts || c.text) return v == null ? '' : String(v);
        if (!_fin(v)) return '';
        var d = _dv(v, c.cat);
        return String(Math.round(d * 1e4) / 1e4);
    }
    function _renderTable(t) {
        var host = _byId('wp_tbl_' + t); if (!host) return;
        var M = ST.M || _read(), cols = TABLES[t](M), rows = _tableRows(M, t), extra = (t === 'survey') ? _surveyExtra(M) : null;
        var h = '<div class="wp-tw"><table class="dtable wp-ed" data-t="' + t + '"><thead><tr>' + cols.map(function (c) {
            return '<th>' + _esc(c.l) + (c.u ? ' <span class="wp-u">(' + _esc(c.cat ? _lab(c.cat, c.u) : c.u) + ')</span>' : '') + '</th>';
        }).join('') + (extra ? extra.head.map(function (x) { return '<th>' + x + '</th>'; }).join('') : '') + '<th></th></tr></thead><tbody>';
        var rowHtml = function (r, i) {
            return '<tr data-r="' + i + '">' + cols.map(function (c) {
                var v = r ? (Array.isArray(r) ? r[c.k] : r[c.k]) : null;
                if (c.opts) return '<td><select data-t="' + t + '" data-c="' + c.k + '" aria-label="' + _esc(c.l) + '">' + c.opts.map(function (o) { return '<option value="' + o[0] + '"' + (String(v) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></td>';
                return '<td><input data-t="' + t + '" data-c="' + c.k + '" aria-label="' + _esc(c.l) + '" ' + (c.text ? 'type="text"' : 'type="number" step="any" inputmode="decimal"') + ' value="' + _esc(_cellVal(c, v)) + '"></td>';
            }).join('') + (extra ? extra.cells(r, i) : '') + '<td><button type="button" class="btn btn-secondary wp-del" data-del="' + t + '" data-r="' + i + '" aria-label="Delete row" title="Delete row">&#10005;</button></td></tr>';
        };
        rows.forEach(function (r, i) { h += rowHtml(r, i); });
        if (!rows.length) h += rowHtml(null, 0);
        h += '</tbody></table></div>';
        host.innerHTML = h;
    }
    function _surveyExtra(M) {
        var W = ST.W, stn = (W && W.ok && Array.isArray(W.stations)) ? W.stations : [];
        var three = _surveyMode(M) !== 'mdtvd';
        return {
            head: three ? ['TVD (' + _lab('length', 'ft') + ')', 'Departure (' + _lab('length', 'ft') + ')', 'DLS (°/100 ft)'] : ['Inc (°)', 'Departure (' + _lab('length', 'ft') + ')'],
            cells: function (r) {
                var md = r ? r[0] : null, s = _fin(md) ? stn.filter(function (x) { return Math.abs(x.md - md) < 0.01; })[0] : null;
                if (!s) return three ? '<td class="ro">—</td><td class="ro">—</td><td class="ro">—</td>' : '<td class="ro">—</td><td class="ro">—</td>';
                return three ? '<td class="ro">' + _fmt(_dv(s.tvd, 'length'), 1) + '</td><td class="ro">' + _fmt(_dv(s.dep, 'length'), 1) + '</td><td class="ro">' + _fmt(s.dls, 2) + '</td>'
                    : '<td class="ro">' + _fmt(s.inc, 1) + '</td><td class="ro">' + _fmt(_dv(s.dep, 'length'), 1) + '</td>';
            }
        };
    }
    function _collectTable(t) {
        var tbl = _byId('wp_tbl_' + t), M = ST.M || _read(), cols = TABLES[t](M), out = [];
        if (!tbl) return out;
        Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr) {
            var arr = cols.every(function (c) { return typeof c.k === 'number'; }), row = arr ? [] : {}, any = false;
            cols.forEach(function (c) {
                var e = tr.querySelector('[data-c="' + c.k + '"]'); if (!e) return;
                var raw = String(e.value == null ? '' : e.value).trim(), v;
                if (c.opts || c.text) v = raw; else { v = raw === '' ? null : parseFloat(raw.replace(',', '.')); if (!_fin(v)) v = null; else v = _fromDisp(v, c.cat); }
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
        if (t === 'geo') patch.geo = { points: rows }; else patch[t] = rows;
        var r = Mm.write(patch);
        if (r && !r.ok) _banner('fail', 'The table was not saved: ' + ((r.errors || []).join(' ') || r.code));
        if (t === 'tests') { ST.M = _read() || ST.M; _syncMatchTests(); }
        return r;
    }

    // ── read / engines ────────────────────────────────────────────────────────
    function _read() {
        var Mm = G.WTS_wp_model;
        if (!Mm || typeof Mm.read !== 'function') return null;
        try { return Mm.read({ scalars: _byId('wp_root') ? _liveScalars() : undefined }); } catch (e) { return null; }
    }
    function _isGasType(t) { return t === 'gas' || t === 'condensate' || t === 'gasinj'; }

    function _solve(M, live) {
        var out = { M: M, chk: null, F: null, I: null, W: null, R: null, SC: null, shut: null, loading: null, stubs: [] };
        if (!M) return out;
        out.chk = _call('WTS_wp_check', M);
        out.F = _call('WTS_wp_fluid.build', M.fluid);
        out.I = _call('WTS_wp_ipr.curve', M.res, out.F && out.F.ok ? out.F : undefined);
        out.W = _call('WTS_wp_well.build', M.well, {});
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
        else { ST.liveMs = null; if (X.R && X.R.ok && !X.R.tracked) ST.Rfull = X.R; }
        var R = (X.R && X.R.ok !== undefined) ? X.R : null, ok = !!(R && R.ok);
        S.wellperf = {
            v: 1, ok: ok, code: R && !ok ? (R.code || 'NO_SOLUTION') : null, op: ok ? R.op : null, roots: (R && R.roots) || [], qs: ok ? R.qs : null,
            vlpMin: ok ? R.vlpMin : null, traverse: ok ? R.traverse : null, breakdown: (ok && R.breakdown) || [], shutIn: (ST.shut && ST.shut.ok !== false) ? ST.shut : null,
            flags: (R && R.flags) || [], loading: ST.loading, sens: ST.sens, match: ST.match, surface: ok ? R.surface : null, rates: ok ? R.rates : null,
            model: M ? M.v : null, solveMs: ST.solveMs, slow: ST.slow, stubs: X.stubs, ts: Date.now()
        };
        if (root) _renderAll(live);
        _emit('wts:wellperf-solved', { ok: ok });
        return S.wellperf;
    }
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
            _renderDots();
            _renderNotes();
        } else { _renderOp(); }
    }

    // KPI strip
    function _kpiHtml(label, val, sub, st, title) {
        return '<div class="kpi wp-kpi st-' + (st || 'none') + '"' + (title ? ' title="' + _esc(title) + '"' : '') + ' role="group" aria-label="' + _esc(label + ' ' + val + (st && st !== 'none' && st !== 'info' ? ' (' + { ok: 'within limits', warn: 'warning', fail: 'limit exceeded' }[st] + ')' : '')) + '">' +
            '<div class="kpi-l">' + _esc(label) + '</div><div class="kpi-v">' + _esc(val) + '</div>' + (sub ? '<div class="kpi-s">' + _esc(sub) + '</div>' : '') + '</div>';
    }
    function _kpis() {
        var R = ST.R, M = ST.M, ok = !!(R && R.ok), gas = M && _isGasType(M.fluid.type), out = [];
        var rates = ok ? (R.rates || {}) : {}, op = ok ? R.op : null;
        var pwf = ok ? (_fin(R.pwf) ? R.pwf : (R.node === 'bottom' && op ? op.p : null)) : null;
        var thp = ok && R.surface ? (_fin(R.surface.thp_psig) ? R.surface.thp_psig : (_fin(R.surface.thp) ? R.surface.thp - PATM : null)) : null;
        // hydrate: the THT of the check (J-T corrected for gas wells, WTS_wp_well.temperature) against the hydrate temperature at the THP
        var tht = ok && R.surface ? R.surface.tht : null, thtChk = ok && R.surface ? (_fin(R.surface.thtHyd) ? R.surface.thtHyd : tht) : null, tHyd = ok && R.surface ? R.surface.tHyd : null;
        var pr = M ? M.res.pr : null;
        if (gas) out.push({ k: 'rate', l: 'Gas rate', v: _fin(rates.qg) ? _u(rates.qg / 1000, 'gasRate', 2, 'MMscf/d') : '—', s: _fin(rates.qo) ? 'Cond. ' + _u(rates.qo, 'liquidRate', 0, 'STB/d') : '', st: ok ? 'ok' : (R ? 'fail' : 'none') });
        else out.push({ k: 'rate', l: 'Liquid rate', v: _fin(rates.qL) ? _u(rates.qL, 'liquidRate', 0, 'STB/d') : '—', s: _fin(rates.qo) ? 'Oil ' + _u(rates.qo, 'liquidRate', 0, 'STB/d') : '', st: ok ? (op && op.stable === false ? 'fail' : 'ok') : (R && !_isStub(R) ? 'fail' : 'none') });
        out.push({ k: 'bhp', l: 'Flowing BHP', v: _u(pwf, 'pressure', 0, 'psia'), s: (ST.W && ST.W.ok && ST.W.nodes && _fin(ST.W.nodes.midPerfTvd)) ? '@ ' + _u(ST.W.nodes.midPerfTvd, 'length', 0, 'ft') + ' TVD' : '' });
        out.push({ k: 'thp', l: 'THP', v: _u(thp, 'pressureG', 0, 'psig'), s: ok && R.surface && R.surface.choke && R.surface.choke.regime && R.surface.choke.regime !== 'none' ? 'choke ' + R.surface.choke.regime : (M && M.surface.choke.present === false ? 'fixed' : ''),
                   st: (ok && M && _fin(M.surface.rating.wellhead_psi) && _fin(thp)) ? (thp > M.surface.rating.wellhead_psi ? 'fail' : 'ok') : 'none' });
        out.push({ k: 'tht', l: 'THT', v: _u(tht, 'temperature', 0, '°F'), s: M && M.well.heat.thtMeasured ? 'measured' : (ok ? 'estimated' : ''),
                   st: (ok && M && _fin(M.surface.rating.tht_max_F) && _fin(tht)) ? (tht > M.surface.rating.tht_max_F ? 'fail' : 'ok') : 'none' });
        out.push({ k: 'dd', l: 'Drawdown', v: (_fin(pr) && _fin(pwf)) ? _u(pr - pwf, 'pressure', 0, 'psi') : '—', s: _fin(pr) ? 'p̄r ' + _u(pr, 'pressure', 0, 'psia') : 'p̄r needed', st: _fin(pr) ? 'none' : 'warn' });
        if (gas) {
            out.push({ k: 'cgr', l: 'CGR', v: M ? _u(M.fluid.cgr, 'cgr', 1, 'STB/MMscf') : '—', s: M ? 'WGR ' + _u(M.fluid.wgr, 'cgr', 1, 'STB/MMscf') : '' });
        } else {
            out.push({ k: 'gor', l: 'GOR', v: M ? _u(M.fluid.gor, 'gor', 0, 'scf/STB') : '—', s: M && M.fluid.api != null ? _fmt(M.fluid.api, 1) + ' °API' : '' });
            out.push({ k: 'wc', l: 'Water cut', v: M && _fin(M.fluid.wc) ? _fmt(M.fluid.wc * 100, 1) + ' %' : '—', s: _fin(rates.qw) ? _u(rates.qw, 'liquidRate', 0, 'BWPD') : '' });
        }
        var L = ST.loading, mg = L && _fin(L.margin) ? L.margin : null;
        out.push({ k: 'load', l: 'Loading margin', v: mg == null ? (gas ? '—' : 'n/a') : (mg >= 0 ? '+' : '') + _fmt(mg * 100, 0) + ' %', s: L && L.method ? String(L.method).replace(/^./, function (c) { return c.toUpperCase(); }) + (_fin(L.qc_MMscfd) ? ' q_c ' + _u(L.qc_MMscfd, 'gasRate', 2, 'MMscf/d') : '') : (gas ? '' : 'oil well'),
                   st: mg == null ? 'none' : (mg < 0 ? 'fail' : mg < 0.1 ? 'warn' : 'ok') });
        var ero = ok ? _eroMax(R) : null;
        out.push({ k: 'ero', l: 'Erosion ratio', v: _fin(ero) ? _fmt(ero, 2) : '—', s: M ? 'C = ' + _fmt(M.system.eroC, 0) : '', st: _fin(ero) ? (ero > 1 ? 'fail' : ero > 0.8 ? 'warn' : 'ok') : 'none' });
        var hm = (_fin(thtChk) && _fin(tHyd)) ? thtChk - tHyd : null;
        out.push({ k: 'hyd', l: 'Hydrate margin', v: _fin(hm) ? _tempDiff(hm) : '—', s: _fin(tHyd) ? 'hydrate ' + _u(tHyd, 'temperature', 0, '°F') : (M && M.fluid.type === 'water' ? 'no gas' : ''), st: _fin(hm) ? (hm < 0 ? 'fail' : hm < 10 ? 'warn' : 'ok') : 'none' });
        return out;
    }
    function _eroMax(R) {
        if (R && R.velocities && _fin(R.velocities.eroMax)) return R.velocities.eroMax;
        var p = R && R.traverse && R.traverse.profile; if (!p || !p.length) return null;
        var m = null; p.forEach(function (r) { if (_fin(r.ero) && (m == null || r.ero > m)) m = r.ero; });
        return m;
    }
    function _renderKpis() {
        var h = _byId('wp_kpis'); if (!h) return;
        h.innerHTML = _kpis().map(function (k) { return _kpiHtml(k.l, k.v, k.s, k.st); }).join('');
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
            var thp = ST.M.system.thp_psig, c = _call('WTS_wp_vlp.curve', ST.F, ST.W, { qList: qList, p0: _fin(thp) ? thp + PATM : null, corr: ST.M.system.corr.well, coarse: true });
            if (Array.isArray(c)) out.vlp = c.filter(function (x) { return _fin(x.pwf); }).map(function (x) { return [x.q, x.pwf]; });
        }
        return out;
    }
    function _rateCat() { return (ST.M && _isGasType(ST.M.fluid.type)) ? ['gasRateSmall', 'Mscf/d'] : ['liquidRate', 'STB/d']; }
    function _renderSystemPlot() {
        var cv = _byId('wp_cv_sys'), V = G.WTS_wp_view; if (!cv || !V) return;
        var R = ST.R, M = ST.M, ok = !!(R && R.ok), rc = _rateCat(), T = V.theme();
        var X = function (q) { return _dv(q, rc[0]); }, Y = function (p) { return _dv(p, 'pressure'); };
        var C = _curves(), series = [], markers = [], bands = [], vlines = [];
        series.push({ key: 'ipr', label: 'Inflow (IPR)', color: T.green, width: 2.6, pts: C.ipr.map(function (p) { return [X(p[0]), Y(p[1])]; }) });
        series.push({ key: 'vlp', label: (M && M.system.node === 'wellhead') ? 'Outflow' : 'Outflow (tubing + surface)', color: T.blue, width: 2.6, pts: C.vlp.map(function (p) { return [X(p[0]), Y(p[1])]; }) });
        var sens = ST.sens && ST.sens.ok !== false && Array.isArray(ST.sens.cases) ? ST.sens : null;
        if (sens) sens.cases.forEach(function (c, i) {
            var cur = c.R && (c.R.curve || c.R.vlp);
            if (Array.isArray(cur) && cur.length) series.push({ key: 'sens' + i, label: _sensLabel(sens, c), color: V.ramp(sens.cases.length > 1 ? i / (sens.cases.length - 1) : 0.5), width: 1.4, dash: [6, 4],
                pts: cur.map(function (p) { return [X(p.q), Y(_fin(p.p) ? p.p : p.pwf)]; }).filter(function (p) { return _fin(p[1]); }) });
        });
        if (ok) {
            if (R.qs && _fin(R.qs.q)) { bands.push({ x0: 0, x1: X(R.qs.q), color: 'rgba(248,81,73,0.09)', label: 'statically unstable (q < q_s)' }); vlines.push({ x: X(R.qs.q), color: T.red, label: 'q_s' }); }
            if (R.vlpMin && _fin(R.vlpMin.q)) vlines.push({ x: X(R.vlpMin.q), color: T.text2, label: 'tubing-curve min.', dash: [2, 4] });
            var L = ST.loading; if (L && _fin(L.qc_MMscfd)) vlines.push({ x: X(L.qc_MMscfd * 1000), color: T.yellow, label: 'loading q_c' });
            if (R.velocities && _fin(R.velocities.qEro)) vlines.push({ x: X(R.velocities.qEro), color: T.purple, label: 'erosional rate' });
            (R.roots || []).forEach(function (r) {
                var isOp = R.op && Math.abs(r.q - R.op.q) < 1e-6 * Math.max(1, r.q);
                markers.push({ x: X(r.q), y: Y(r.p), kind: r.stable ? 'filled' : 'hollow', color: r.stable ? T.accent : T.red, r: isOp ? 7 : 5.5, halo: isOp,
                               label: isOp ? _fmt(X(r.q), 0) + ' ' + _lab(rc[0], rc[1]) + ' · ' + _fmt(Y(r.p), 0) + ' ' + _lab('pressure', 'psia') : (r.stable ? '' : 'unstable') });
            });
        }
        // drag handles
        var handles = [];
        if (M) {
            var gas = _isGasType(M.fluid.type), pr = M.res.pr;
            if (_fin(pr)) handles.push({ key: 'pr', kind: 'point', x: 0, value: Y(pr), min: Y(200), max: Y(20000), step: _metric() ? 10 : 5, label: 'p̄r', color: T.green, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } });
            if (M.surface.choke.present === false) {
                var thp = _fin(M.system.thp_psig) ? M.system.thp_psig : 100;
                handles.push({ key: 'thp', kind: 'railY', value: Y(thp + PATM), min: Y(PATM), max: Y(15000), step: _metric() ? 10 : 5, label: 'THP', railLabel: 'THP', color: T.blue, fmt: function (v) { return _fmt(_dv(_fromDisp(v, 'pressure') - PATM, 'pressureG'), 0) + ' ' + _lab('pressureG', 'psig'); } });
            } else {
                handles.push({ key: 'bean', kind: 'railX', value: _fin(M.surface.choke.bean64) ? M.surface.choke.bean64 : 32, min: 8, max: 128, step: 1, label: 'Bean', railLabel: 'BEAN', rail: [0, 0.5], color: T.accent, fmt: function (v) { return _fmt(v, 0) + '/64"'; } });
            }
            if (!gas) handles.push({ key: 'wc', kind: 'railX', value: _fin(M.fluid.wc) ? M.fluid.wc * 100 : 0, min: 0, max: 98, step: 1, label: 'WC', railLabel: 'WC', rail: [0.5, 1], color: T.purple, fmt: function (v) { return _fmt(v, 0) + ' %'; } });
        }
        var emptyMsg = (!M) ? 'The model module is not available.' : (ST.stubs && ST.stubs.length && !ok) ? 'The inflow / outflow curves appear here once the engines are installed.' : (!_fin(M.res.pr) ? 'Enter the reservoir pressure (step ②) to draw the inflow curve.' : 'No curve for these inputs.');
        V.chart(cv, {
            key: 'sys:' + rc[0] + ':' + (_metric() ? 'm' : 'i'), aspect: 0.8, minH: 280, maxH: 560, w: 640,
            x: { label: (_isGasType(M && M.fluid.type) ? 'Gas rate' : 'Liquid rate') + ' (' + _lab(rc[0], rc[1]) + ')', min: 0, short: 'q', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab(rc[0], rc[1]); } },
            y: { label: (M && M.system.node === 'wellhead' ? 'Pressure at the node' : 'Bottom-hole pressure') + ' (' + _lab('pressure', 'psia') + ')', min: 0, max: (M && _fin(M.res.pr)) ? Y(Math.max(M.res.pr, ok ? R.op.p : 0) * 1.3) : undefined, short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
            series: series, markers: markers, bands: bands, vlines: vlines, handles: handles, readout: 'x', empty: emptyMsg,
            hidden: _plots().sysHidden || null,
            onLegend: function (hid) { _plotsSet({ sysHidden: hid }); },
            onHandle: _onHandle
        });
    }
    function _onHandle(key, v, phase) {
        var id = { pr: 'wp_pr', thp: 'wp_thp', bean: 'wp_bean', wc: 'wp_wc' }[key]; if (!id) return;
        var canon;
        if (key === 'pr') canon = Math.round(_fromDisp(v, 'pressure'));
        else if (key === 'thp') canon = Math.round(_fromDisp(v, 'pressure') - PATM);
        else canon = Math.round(v);
        _setCtrl(id, canon, true);
        if (phase === 'end') { _commit(id); return; }
        if (!ST.slow && _liveMs() <= LIVE_MS) _solveLive();
    }

    // Schematic
    function _depthFmt(v) { return _fmt(_dv(v, 'length'), 0); }
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
            fmt: { depthTick: _depthFmt, md: function (v) { return _u(v, 'length', 0, 'ft'); }, p: function (v) { return _fmt(_dv(v, 'pressure'), 0); }, t: function (v) { return _fmt(_dv(v, 'temperature'), 0); }, hl: function (v) { return _fmt(v, 2); }, vm: function (v) { return _fmt(_dv(v, 'velocity'), 1); } },
            labels: { tvd: 'TVD (' + _lab('length', 'ft') + ')', vs: 'Vertical section (' + _lab('length', 'ft') + '), equal scale', closure: '', prop: { pressure: 'Pressure (' + _lab('pressure', 'psia') + ')', temperature: 'Temperature (' + _lab('temperature', '°F') + ')', holdup: 'Liquid holdup (–)', velocity: 'Mixture velocity (' + _lab('velocity', 'ft/s') + ')', pattern: 'Flow pattern', none: '' }[prop] },
            empty: (ST.stubs && ST.stubs.indexOf('WTS_wp_well.build') !== -1) || _isStub(ST.SC) ? 'The well path engine draws the deviated well here once it is installed.' : 'Enter a survey and the strings (step ③) to draw the well.',
            aria: 'Well schematic: vertical section and plan view, coloured by ' + prop
        };
        var out = V.schematic(S || {}, o);
        ST.schPts = out.pts; ST.schW = out.width; ST.schH = out.height;
        host.innerHTML = out.svg;
        var cap = _byId('wp_sch_cap'); if (cap) cap.textContent = closure;
    }
    function _schAt(md) {
        var S = ST.SC, res = { md: md };
        if (!S || !S.trajectory) return res;
        var tr = S.trajectory;
        for (var i = 1; i < tr.length; i++) if (md <= tr[i].md) { var a = tr[i - 1], b = tr[i], t = (md - a.md) / ((b.md - a.md) || 1); res.tvd = a.tvd + t * (b.tvd - a.tvd); res.inc = _fin(b.inc) ? (_fin(a.inc) ? a.inc + t * (b.inc - a.inc) : b.inc) : null; break; }
        var pr = (S.profile || []).slice().sort(function (x, y) { return x.md - y.md; });
        for (var j = 1; j < pr.length; j++) if (md <= pr[j].md) { var c = pr[j - 1], d = pr[j], f = (md - c.md) / ((d.md - c.md) || 1); ['p', 't', 'hl', 'vm'].forEach(function (k) { if (_fin(c[k]) && _fin(d[k])) res[k] = c[k] + f * (d[k] - c[k]); }); res.pattern = f < 0.5 ? c.pattern : d.pattern; break; }
        return res;
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
        if (_fin(a.hl)) rows.push('<span class="k">Holdup</span> ' + _fmt(a.hl, 3));
        if (_fin(a.vm)) rows.push('<span class="k">Velocity</span> ' + _u(a.vm, 'velocity', 1, 'ft/s'));
        if (a.pattern) rows.push('<span class="k">Pattern</span> ' + _esc(a.pattern));
        tip.innerHTML = rows.join('<br>');
        var wr = host.getBoundingClientRect(), lx = e.clientX - wr.left + 16, ly = e.clientY - wr.top + 12;
        if (lx > wr.width - 170) lx = e.clientX - wr.left - 176;
        tip.style.left = Math.max(4, lx) + 'px'; tip.style.top = Math.max(4, ly) + 'px';
        tip.className = 'wp-tip on';
    }
    function _editComp(comp) {
        var m = /^(string|restr|gauge):(\d+)$/.exec(comp || ''), step = 3, focusSel = null;
        if (m) { var t = { string: 'strings', restr: 'restrictions', gauge: 'tests' }[m[1]]; step = m[1] === 'gauge' ? 6 : 3; focusSel = { t: t, r: +m[2] }; }
        else if (comp === 'perf') { step = 3; focusSel = { id: 'wp_perfTop' }; }
        else if (comp === 'choke') { step = 5; focusSel = { id: 'wp_bean' }; }
        else if (comp === 'wellhead') { step = 5; focusSel = { id: 'wp_psep' }; }
        _goStep(step, true);
        if (focusSel && focusSel.id) { var e = _byId(focusSel.id); if (e && e.focus) e.focus(); }
        else if (focusSel) {
            var tbl = _byId('wp_tbl_' + focusSel.t), tr = tbl && tbl.querySelector('tr[data-r="' + focusSel.r + '"]');
            if (tr) { if (tr.classList) { tr.classList.remove('wp-flash'); tr.classList.add('wp-flash'); } var inp = tr.querySelector('input,select'); if (inp && inp.focus) inp.focus(); if (tr.scrollIntoView) { try { tr.scrollIntoView({ block: 'center', behavior: _reduced() ? 'auto' : 'smooth' }); } catch (x) { /* ignore */ } } }
        }
    }
    function _reduced() { try { return !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

    // Operating point card
    function _renderOp() {
        var h = _byId('wp_op'); if (!h) return;
        var R = ST.R, M = ST.M, ok = !!(R && R.ok), rows = [];
        var row = function (l, v) { rows.push('<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv">' + _esc(v) + '</span></div>'); };
        if (!ok) { h.innerHTML = '<div class="rbox-title">Operating point</div><div class="wp-v info">' + _esc(R && !_isStub(R) ? (((R.errors || [])[0]) || 'No operating point.') : 'Waiting for the system solver.') + '</div>'; return; }
        var rt = R.rates || {}, sf = R.surface || {}, gas = _isGasType(M.fluid.type);
        if (gas) row('Gas rate', _u(rt.qg / 1000, 'gasRate', 3, 'MMscf/d'));
        row('Oil / condensate rate', _u(rt.qo, 'liquidRate', 0, 'STB/d'));
        row('Water rate', _u(rt.qw, 'liquidRate', 0, 'BWPD'));
        if (!gas) row('Gas rate', _u(rt.qg, 'gasRateSmall', 0, 'Mscf/d'));
        row('Flowing bottom-hole pressure', _u(_fin(R.pwf) ? R.pwf : R.op.p, 'pressure', 0, 'psia'));
        row('Wellhead pressure (THP)', _u(_fin(sf.thp_psig) ? sf.thp_psig : (_fin(sf.thp) ? sf.thp - PATM : null), 'pressureG', 0, 'psig'));
        row('Wellhead temperature (THT)', _u(sf.tht, 'temperature', 0, '°F'));
        row('Stability', R.op.stable ? 'stable' : 'unstable');
        row('Static stability limit q_s', R.qs ? _u(R.qs.q, _rateCat()[0], 0, _rateCat()[1]) : 'none in range');
        if (R.vlpMin) row('Tubing-curve minimum', _u(R.vlpMin.q, _rateCat()[0], 0, _rateCat()[1]));
        if (sf.choke && sf.choke.regime && sf.choke.regime !== 'none') row('Choke regime', sf.choke.regime);
        if (sf.choke && _fin(sf.choke.ratio)) row('Choke pressure ratio p2/p1', _fmt(sf.choke.ratio, 2));
        h.innerHTML = '<div class="rbox-title">Operating point</div>' + rows.join('');
    }

    // Δp breakdown (canvas bars)
    var BD_LABEL = { reservoir: 'Reservoir (drawdown)', completion: 'Completion (skin)', skin: 'Completion (skin)', gravity: 'Tubing gravity', friction: 'Tubing friction', acceleration: 'Tubing acceleration',
                     restrictions: 'Downhole restrictions', choke: 'Surface choke', flowline: 'Flowline', separator: 'Separator' };
    function _renderBreakdown() {
        var cv = _byId('wp_cv_bd'); if (!cv || !cv.getContext) return;
        var V = G.WTS_wp_view, T = V ? V.theme() : {}, R = ST.R, items = (R && R.ok && R.breakdown) ? R.breakdown.filter(function (b) { return _fin(b.dp); }) : [];
        var cw = (cv.clientWidth > 160) ? Math.min(cv.clientWidth, 900) : 420, rowH = 32, ch = Math.max(120, items.length * rowH + 30);
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
            var y = 8 + i * rowH, w = Math.max(1.5, bw * Math.max(0, b.dp) / tot);
            c.fillStyle = T.text2 || '#8b949e'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
            c.fillText(BD_LABEL[b.key] || b.key, lw, y + 11);
            c.fillStyle = T.text || '#e6edf3'; c.textAlign = 'right';
            c.fillText(_fmt(_dv(b.dp, 'pressure'), 0) + ' ' + _lab('pressure', 'psi') + '  ' + _fmt(100 * b.dp / tot, 0) + ' %', lw + bw, y + 11);
            c.fillStyle = T.panel || '#161b22'; c.fillRect(lw, y + 15, bw, 8);
            c.fillStyle = cols[i % cols.length]; c.fillRect(lw, y + 15, w, 8);
        });
        c.fillStyle = T.text2 || '#8b949e'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        c.fillText('Total p̄r − p_sep: ' + _fmt(_dv(tot, 'pressure'), 0) + ' ' + _lab('pressure', 'psi'), lw, 8 + items.length * rowH + 14);
        cv.__h2oilSnapshot = null;
    }

    // Verdicts (report-captured ✓ / ⚠ / ✗ lines) + validity
    function _verdicts() {
        var R = ST.R, M = ST.M, out = [], ok = !!(R && R.ok);
        var add = function (st, t) { out.push({ st: st, t: String(t).slice(0, 290) }); };
        if (!M) return out;
        if (!ok) { if (R && !_isStub(R)) add('fail', '✗ No operating point: ' + (((R.errors || [])[0]) || 'the outflow curve lies above the inflow curve.')); return out; }
        var rc = _rateCat();
        add(R.op.stable ? 'ok' : 'fail', (R.op.stable ? '✓ Stable operating point at ' : '✗ Unstable operating point at ') + _u(R.op.q, rc[0], 0, rc[1]) + ', ' + _u(R.op.p, 'pressure', 0, 'psia') + '.');
        if (R.qs && _fin(R.qs.q)) {
            var mgq = R.op.q / R.qs.q - 1;
            if (mgq < 0.1) add('warn', '⚠ The operating point is within 10 % of the static stability limit q_s (' + _u(R.qs.q, rc[0], 0, rc[1]) + '): the well may head or load up.');
            else add('ok', '✓ ' + _fmt(mgq * 100, 0) + ' % above the static stability limit q_s (' + _u(R.qs.q, rc[0], 0, rc[1]) + ').');
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
            ' the critical rate' + (_fin(L.qc_MMscfd) ? ' ' + _u(L.qc_MMscfd, 'gasRate', 2, 'MMscf/d') : '') + (L.method ? ' (' + L.method + (L.verified === false ? ', provisional' : '') + ')' : '') + (_fin(L.limitingMd) ? ', limiting at ' + _u(L.limitingMd, 'length', 0, 'ft') + ' MD' : '') + '.');
        var ero = _eroMax(R);
        if (_fin(ero)) add(ero > 1 ? 'fail' : ero > 0.8 ? 'warn' : 'ok', (ero > 1 ? '✗' : ero > 0.8 ? '⚠' : '✓') + ' Maximum velocity is ' + _fmt(ero * 100, 0) + ' % of the erosional velocity (C = ' + _fmt(M.system.eroC, 0) + ').');
        var sfc = R.surface || {}, thc = _fin(sfc.thtHyd) ? sfc.thtHyd : sfc.tht;
        if (_fin(thc) && _fin(sfc.tHyd)) {
            var hm = thc - sfc.tHyd;
            add(hm < 0 ? 'fail' : hm < 10 ? 'warn' : 'ok', (hm < 0 ? '✗ Hydrate risk at the wellhead: THT is ' : hm < 10 ? '⚠ Hydrate margin only ' : '✓ Hydrate margin ') + _tempDiff(Math.abs(hm)) + (hm < 0 ? ' below the hydrate temperature' : ' at the wellhead') + ' (hydrate ' + _u(sfc.tHyd, 'temperature', 0, '°F') + (_fin(sfc.thtHyd) && _fin(sfc.tht) && Math.abs(sfc.thtHyd - sfc.tht) > 0.05 ? '; THT ' + _u(sfc.thtHyd, 'temperature', 0, '°F') + ' after J-T cooling' : '') + ').');
        }
        // flags the checks above already state are not repeated
        var SKIP = { EROSION: 1, HEADING: 1, LEFT_OF_MIN: 1, LOADING: 1, HYDRATE_WH: 1, PROVISIONAL: 1 };
        (R.flags || []).filter(function (f) { return f && f.msg && !SKIP[f.code]; }).slice(0, 6).forEach(function (f) { add(f.sev === 'warn' ? 'warn' : 'info', (f.sev === 'warn' ? '⚠ ' : 'ℹ ') + f.msg); });
        return out;
    }
    function _validity() {
        var c = ST.chk, out = [];
        if (!c || _isStub(c)) return out;
        (c.validity || []).forEach(function (v) {
            if (!v) return;
            var prov = v.provisional || v.verified === false;
            out.push({ st: v.inRange === false ? 'warn' : 'ok', t: ((v.inRange === false ? '⚠ ' : '✓ ') + (v.msg || (v.corr + (v.inRange === false ? ': outside the data range (extrapolation)' : ': inside the data range'))) + (prov ? ' — provisional — not verified against a published example.' : '')).slice(0, 290) });
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

    // Traverse / loading / sensitivity / bean schedule card
    function _renderTraverseCard() {
        var cv = _byId('wp_cv_tr'), V = G.WTS_wp_view; if (!cv || !V) return;
        var tab = _plots().trTab || 'traverse', T = V.theme(), dax = _plots().depth === 'md' ? 'md' : 'tvd';
        Array.prototype.forEach.call(document.querySelectorAll('#wp_trtabs button'), function (b) { if (b.classList) b.classList.toggle('on', b.getAttribute('data-tab') === tab); b.setAttribute('aria-pressed', b.getAttribute('data-tab') === tab ? 'true' : 'false'); });
        Array.prototype.forEach.call(document.querySelectorAll('#wp_depthseg button'), function (b) { if (b.classList) b.classList.toggle('on', b.getAttribute('data-depth') === dax); });
        var seg = _byId('wp_depthseg'); if (seg && seg.classList) seg.classList.toggle('wp-off', !(tab === 'traverse' || tab === 'loading'));
        var R = ST.R, ok = !!(R && R.ok), dl = _lab('length', 'ft');
        var spec;
        if (tab === 'loading') {
            var L = ST.loading, pd = (L && L.perDepth) || [];
            spec = { key: 'load:' + dax, aspect: 0.62, minH: 240, maxH: 420, w: 640, readout: 'y',
                     x: { label: 'Gas velocity (' + _lab('velocity', 'ft/s') + ')', min: 0, short: 'v' }, y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + dl + ')', invert: true, min: 0, short: dax.toUpperCase(), fmtR: function (v) { return _fmt(v, 0) + ' ' + dl; } },
                     series: [{ key: 'vg', label: 'Gas velocity', color: T.blue, pts: pd.map(function (r) { return [_dv(r.vg, 'velocity'), _dv(dax === 'md' ? r.md : (_fin(r.tvd) ? r.tvd : r.md), 'length')]; }) },
                              { key: 'vc', label: 'Critical velocity', color: T.yellow, dash: [6, 4], pts: pd.map(function (r) { return [_dv(r.vc, 'velocity'), _dv(dax === 'md' ? r.md : (_fin(r.tvd) ? r.tvd : r.md), 'length')]; }) }],
                     empty: (ST.M && !_isGasType(ST.M.fluid.type)) ? 'Liquid loading applies to gas and gas-condensate wells.' : 'The loading profile appears after a solve.' };
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
            var ser = [{ key: 'p', label: 'Pressure', color: T.accent, width: 2.6, pts: prof.map(function (r) { return [_dv(r.p, 'pressure'), dk(r)]; }) },
                       { key: 't', label: 'Temperature', color: T.red, axis: 'x2', width: 2, pts: prof.map(function (r) { return [_dv(r.t, 'temperature'), dk(r)]; }) }];
            if (prof.some(function (r) { return _fin(r.tHyd); })) ser.push({ key: 'thyd', label: 'Hydrate temperature', color: T.blue, axis: 'x2', dash: [5, 4], width: 1.6, pts: prof.filter(function (r) { return _fin(r.tHyd); }).map(function (r) { return [_dv(r.tHyd, 'temperature'), dk(r)]; }) });
            var gp = (ST.M && ST.M.tests || []).filter(function (t) { return t.use !== false && _fin(t.gaugeMd) && _fin(t.gauge_psia); });
            if (gp.length && ST.SC && ST.SC.trajectory) ser.push({ key: 'g', label: 'Gauge (tests)', kind: 'points', color: T.green, r: 5, pts: gp.map(function (t) { return [_dv(t.gauge_psia, 'pressure'), _dv(dax === 'md' ? t.gaugeMd : (_fin(_schAt(t.gaugeMd).tvd) ? _schAt(t.gaugeMd).tvd : t.gaugeMd), 'length')]; }) });
            spec = { key: 'trav:' + dax + (_metric() ? 'm' : 'i'), aspect: 0.62, minH: 260, maxH: 440, w: 640, readout: 'y',
                     x: { label: 'Pressure (' + _lab('pressure', 'psia') + ')', short: 'p', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
                     x2: { label: 'Temperature (' + _lab('temperature', '°F') + ')', fmtR: function (v) { return _fmt(v, 1) + ' ' + _lab('temperature', '°F'); } },
                     y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + dl + ')', invert: true, min: 0, short: dax.toUpperCase(), fmtR: function (v) { return _fmt(v, 0) + ' ' + dl; } },
                     series: ser, hbands: hb.map(function (b) { return { y0: b.y0, y1: b.y1, color: b.color }; }),
                     hidden: _plots().trHidden || null, onLegend: function (hid) { _plotsSet({ trHidden: hid }); },
                     empty: 'The pressure and temperature traverse appears after a solve.' };
        }
        V.chart(cv, spec);
        var leg = _byId('wp_trleg');
        if (leg) {
            if (tab === 'traverse') {
                var seen = {}, items = [];
                ((ok && R.traverse && R.traverse.profile) || []).forEach(function (r) { var k = V.patternKey(r.pattern); if (!seen[k]) { seen[k] = 1; items.push(k); } });
                leg.innerHTML = items.length ? 'Flow pattern (left strip): ' + items.map(function (k) { return '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + V.PATTERN_COLORS[k] + ';margin:0 4px 0 8px;vertical-align:-1px"></span>' + _esc(k); }).join('') : '';
            } else leg.innerHTML = '';
        }
    }
    // Sensitivity variables (WTS_wp_sens.VARS, WP6): [key, label, field unit]; the fallback list keeps the page usable without the engine.
    // Values are typed in display units (SENS_CAT converts Metric entries to the field units of the engine); WC is in %.
    var SENS_FALLBACK = [['wc', 'Water cut', '%'], ['pr', 'Reservoir pressure p̄r', 'psia'], ['bean', 'Choke bean', '/64 in'], ['thp', 'Wellhead pressure (fixed, choke out of line)', 'psig'], ['gor', 'Producing GOR', 'scf/STB'], ['psep', 'Separator pressure', 'psig'], ['J', 'Productivity index J', 'STB/d/psi']];
    var SENS_CAT = { pr: 'pressure', thp: 'pressureG', psep: 'pressureG', tubingId: 'lengthSmall', gor: 'gor', glr: 'gor' };
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
    function _sensSuggest() {
        var SN = G.WTS_wp_sens, sel = _byId('wpv_svar'), box = _byId('wpv_svals'); if (!sel || !box || !SN || typeof SN.suggest !== 'function') return;
        var M = ST.M || _read(), k = sel.value, why = null;
        try { var row = (SN.vars(M) || []).filter(function (x) { return x.key === k; })[0]; why = row && !row.applicable ? row.why : null; } catch (e) { why = null; }
        var sg = SN.suggest(M, k, 5);
        if (sg && sg.ok) box.value = sg.values.map(function (v) { var d = _sensDv(k, v); return String(+(+d).toPrecision(4)); }).join(' ');
        var jb = _byId('wp_jobbox'); if (jb) jb.innerHTML = why ? _vHtml({ st: 'info', t: 'ℹ ' + _sensVarLabel(k).replace(/ \(.*\)$/, '') + ': ' + why + '.' }) : '';
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
                hf.innerHTML = '<div class="wp-tw"><table class="dtable"><thead><tr><th>p (' + _lab('pressure', 'psia') + ')</th><th>Rs (' + _lab('gor', 'scf/STB') + ')</th><th>Bo (rb/STB)</th><th>μo (cp)</th><th>Z</th><th>μg (cp)</th></tr></thead><tbody>' +
                    rows.map(function (r) { return '<tr><td>' + _fmt(_dv(r.p, 'pressure'), 0) + '</td><td class="num">' + _fmt(_dv(r.rs, 'gor'), 0) + '</td><td class="num">' + _fmt(r.bo, 3) + '</td><td class="num">' + _fmt(r.muo, 3) + '</td><td class="num">' + _fmt(r.z, 3) + '</td><td class="num">' + _fmt(r.mug, 4) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
                    ((F.validity || []).map(function (v) { return _vHtml({ st: v.inRange === false ? 'warn' : 'ok', t: (v.inRange === false ? '⚠ ' : '✓ ') + (v.msg || v.corr) }); }).join(''));
            } else hf.innerHTML = '<div class="wp-v info">' + (_isStub(F) ? 'The fluid engine shows the PVT table here once it is installed.' : 'Enter the fluid, the reservoir pressure and temperature to see the PVT table.') + '</div>';
        }
        // ② IPR plot
        var cv = _byId('wp_cv_ipr'), V = G.WTS_wp_view;
        if (cv && V) {
            var I = ST.I, Tm = V.theme(), rc = _rateCat(), pts = (I && I.ok && I.curve) ? I.curve.map(function (c) { return [_dv(c.q, rc[0]), _dv(c.pwf, 'pressure')]; }).sort(function (a, b) { return a[0] - b[0]; }) : [];
            var tp = ((M && M.res.points) || []).map(function (p) { return [_dv(p.q, rc[0]), _dv(p.pwf, 'pressure')]; });
            V.chart(cv, { key: 'ipr:' + rc[0], aspect: 0.6, minH: 220, maxH: 360, w: 520, readout: 'x', x: { label: 'Rate (' + _lab(rc[0], rc[1]) + ')', min: 0, short: 'q' }, y: { label: 'pwf (' + _lab('pressure', 'psia') + ')', min: 0, short: 'pwf' },
                series: [{ key: 'ipr', label: 'IPR', color: Tm.green, width: 2.4, pts: pts }, { key: 'pts', label: 'Test points', kind: 'points', color: Tm.accent, pts: tp }],
                hlines: (I && I.ok && _fin(I.pb)) ? [{ y: _dv(I.pb, 'pressure'), label: 'pb', color: Tm.yellow }] : [],
                empty: _isStub(I) ? 'The inflow engine draws the IPR here once it is installed.' : 'Enter p̄r and the model parameters to draw the IPR.' });
            var is = _byId('wp_iprsum');
            if (is) is.innerHTML = (I && I.ok) ? '<div class="rrow"><span class="rl">AOF</span><span class="rv">' + _u(I.aof, rc[0], 0, rc[1]) + '</span></div>' + (_fin(I.J) ? '<div class="rrow"><span class="rl">Productivity index</span><span class="rv">' + _u(I.J, 'productivityIndex', 3, 'STB/d/psi') + '</span></div>' : '') +
                (I.verified === false ? _vHtml({ st: 'warn', t: '⚠ ' + (I.label || 'This inflow model') + ': provisional — not verified against a published example.' }) : '') : '';
        }
        // ③ survey extras + segments
        _renderTable('survey');
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
    function _renderDots() {
        var s = _stepStatus();
        STEPS.forEach(function (x) { var d = _byId('wp_dot_' + x.n); if (d) d.className = 'wp-dot ' + (s[x.n] || 'none'); });
    }
    function _renderNotes() {
        var h = _byId('wp_notesbox'); if (!h) return;
        var M = ST.M, gas = M && _isGasType(M.fluid.type), user = '';
        var ue = _byId('wp_notes'); if (ue && ue.value && String(ue.value).trim()) user = String(ue.value).trim().slice(0, 560);
        var box = function (t) { return '<div style="margin-bottom:6px"><b>Notes</b> ' + _esc(t) + '</div>'; };
        h.innerHTML = box('Steady-state nodal analysis: the operating point is where the inflow (IPR) meets the outflow of the tubing, restrictions, choke and flowline to the separator. ' +
                'The vertical lift marches on the true inclination of every segment (hydrostatic on TVD, friction on MD); one correlation for the whole well.') +
            box('Black-oil fluid model' + (gas ? '; the gas-condensate well is a wet gas with a constant condensate volume (no retrograde dropout)' : '') + '. ' +
                'Correlations outside their data range are extrapolations; those without a verified published example are labelled provisional. Restrictions use a homogeneous loss coefficient.') +
            box('The stability verdict is a static criterion (q_s): it does not predict heading or slugging. The temperature is linear from the wellhead temperature entered; the J-T correction applies to the hydrate check only.') +
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
        var type = (_byId('wp_ftype') || {}).value || 'oil', gas = _isGasType(type), model = (_byId('wp_ipr') || {}).value || 'pi';
        Array.prototype.forEach.call(root.querySelectorAll('[data-for]'), function (e) { var list = String(e.getAttribute('data-for')).split(' '); if (e.classList) e.classList.toggle('wp-off', list.indexOf(gas ? 'gas' : 'oil') === -1 && list.indexOf(type) === -1); });
        var m = _iprModels().filter(function (x) { return x.key === model; })[0], need = m ? m.needs : [];
        Array.prototype.forEach.call(root.querySelectorAll('[data-ip]'), function (e) { if (e.classList) e.classList.toggle('wp-off', need.indexOf(e.getAttribute('data-ip')) === -1); });
        var choke = !!(_byId('wp_choke') || {}).checked;
        Array.prototype.forEach.call(root.querySelectorAll('[data-choke]'), function (e) { var want = e.getAttribute('data-choke') === 'on'; if (e.classList) e.classList.toggle('wp-off', want !== choke); });
        var mode = (_byId('wp_mode') || {}).value || 'rate';
        Array.prototype.forEach.call(root.querySelectorAll('[data-mode]'), function (e) { if (e.classList) e.classList.toggle('wp-off', String(e.getAttribute('data-mode')).split(' ').indexOf(mode) === -1); });
        var ic = _byId('wp_iprchip'); if (ic) ic.innerHTML = m && m.verified === false ? '<span class="wp-chip prov">provisional</span>' : '';
        Object.keys(ST.prov).forEach(function (id) { var lab = root.querySelector('label[for="' + id + '"]'); if (lab && !lab.querySelector('.wp-chip')) lab.insertAdjacentHTML('beforeend', '<span class="wp-chip">' + _esc(ST.prov[id]) + '</span>'); });
        _goStep(_step(), false);
    }

    // ── jobs (design, bean schedule, sensitivity, comparison) ────────────────
    function _drive(job, onDone, label) {
        var box = _byId('wp_jobbox');
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
        var M = ST.M || _read();
        if (act === 'solve') { _solveNow(); return; }
        if (act === 'cancel') { if (ST.job) ST.job.cancel(); return; }
        if (act === 'example') { _loadExample(btn.getAttribute('data-ex')); return; }
        if (act === 'csv') { _csv(); return; }
        if (act === 'design') {
            var tk = M.system.target.kind, q = M.system.target.q, tgt = {}; tgt[tk === 'thp' ? 'thp' : 'bean'] = q;
            if (!_fin(q)) { var b0 = _byId('wp_jobbox'); if (b0) b0.innerHTML = _vHtml({ st: 'warn', t: '⚠ Enter the target rate first.' }); return; }
            _drive(_jobOf(_call('WTS_wp_system.designFor', M, tgt)), function (r) {
                ST.design = r;
                var b = _byId('wp_design');
                if (b) b.innerHTML = (r && r.ok) ? _vHtml({ st: 'ok', t: '✓ ' + (tk === 'thp' ? 'Wellhead pressure ' + _u(r.thp, 'pressureG', 0, 'psig') : 'Bean ' + _fmt(r.bean, 1) + '/64 in') + ' gives the target rate.' }) +
                    '<div class="wp-btns"><button type="button" class="btn btn-primary" data-act="adopt" data-id="' + (tk === 'thp' ? 'wp_thp' : 'wp_bean') + '" data-v="' + (tk === 'thp' ? Math.round(r.thp) : Math.round(r.bean)) + '">Use this ' + (tk === 'thp' ? 'THP' : 'bean') + '</button></div>' : _vHtml({ st: 'warn', t: '⚠ No setting reaches the target rate.' });
            }, 'Design');
            return;
        }
        if (act === 'beans') {
            _drive(_jobOf(_call('WTS_wp_system.beanSchedule', M, M.surface.beans)), function (rows) {
                ST.beans = { rows: Array.isArray(rows) ? rows : (rows && rows.rows) || [] };
                _plotsSet({ trTab: 'beans' }); _renderBeans(); _renderTraverseCard();
            }, 'Bean schedule');
            return;
        }
        if (act === 'sens') {
            var key = (_byId('wpv_svar') || {}).value || 'wc', sraw = String((_byId('wpv_svals') || {}).value || '').trim(), vals = (/[;\s]/.test(sraw) ? sraw.split(/[;\s]+/) : sraw.split(',')).filter(function (x) { return x !== ''; }).slice(0, 10).map(function (x) { var n = parseFloat(x.replace(/,/g, '.')); return _fin(n) ? _fromDisp(n, SENS_CAT[key]) : x; }).filter(function (x) { return _fin(x) || (key === 'tubingId' && typeof x === 'string'); });
            if (!vals.length) { var b1 = _byId('wp_jobbox'); if (b1) b1.innerHTML = _vHtml({ st: 'warn', t: '⚠ Enter up to 10 values for the sensitivity.' }); return; }
            _drive(_jobOf(_call('WTS_wp_sens.job', M, [{ key: key, values: vals }])), function (r) {
                ST.sens = r && typeof r === 'object' ? Object.assign({ key: key }, r) : null;
                if (G.WTS_state && G.WTS_state.wellperf) G.WTS_state.wellperf.sens = ST.sens;
                _plotsSet({ trTab: 'sens' }); _renderTraverseCard(); _renderSystemPlot(); _renderSensTable();
            }, 'Sensitivity');
            return;
        }
        if (act === 'match') { _runMatch(); return; }
        if (act === 'adopt') {
            var ids = String(btn.getAttribute('data-ids') || btn.getAttribute('data-id') || '').split(','), vs = String(btn.getAttribute('data-vs') || btn.getAttribute('data-v') || '').split(','), done = [];
            ids.forEach(function (id, i) { var v = +vs[i]; if (id && _byId(id) && _fin(v)) { _setCtrl(id, +v.toPrecision(6), true); ST.prov[id] = 'matched to test ' + ((ST.match && ST.match.test) || ''); done.push(id); } });
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
    }
    function _jobOf(r) { return (r && typeof r.step === 'function') ? r : (r && r.job && typeof r.job.step === 'function' ? r.job : r); }
    function _renderBeans() {
        var h = _byId('wp_beans'); if (!h) return;
        var rows = (ST.beans && ST.beans.rows) || [], rc = _rateCat();
        h.innerHTML = rows.length ? '<div class="wp-tw"><table class="dtable"><thead><tr><th>Bean (/64)</th><th>Rate (' + _lab(rc[0], rc[1]) + ')</th><th>THP (' + _lab('pressureG', 'psig') + ')</th><th>THT (' + _lab('temperature', '°F') + ')</th><th>Choke Δp</th><th>Regime</th><th>Stable</th></tr></thead><tbody>' +
            rows.map(function (r) { return '<tr><td>' + _fmt(r.bean, 0) + '</td><td class="num">' + _fmt(_dv(r.q, rc[0]), 0) + '</td><td class="num">' + _fmt(_dv(r.thp, 'pressureG'), 0) + '</td><td class="num">' + _fmt(_dv(r.tht, 'temperature'), 0) + '</td><td class="num">' + _fmt(_dv(r.dpChoke, 'pressure'), 0) + '</td><td>' + _esc(r.regime || '') + '</td><td>' + (r.stable ? '✓' : '✗') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '';
    }
    function _renderSensTable() {
        var h = _byId('wp_senstbl'); if (!h) return;
        var s = ST.sens, rc = _rateCat();
        if (!(s && s.cases && s.cases.length)) { h.innerHTML = ''; return; }
        var gas = !!(ST.M && _isGasType(ST.M.fluid.type)), bv = s.base && _fin(s.base.value) ? s.base.value : null;
        var nOk = s.cases.filter(function (c) { return c.R && c.R.ok; }).length;
        var head = '<div class="wp-sec-h" style="font-size:13px;margin-top:12px">Sensitivity — ' + _esc(_sensVarLabel(s.key)) + ' <span>' + nOk + ' of ' + s.cases.length + ' cases flow' + (s.family === 'ipr' ? '; one inflow curve per value' : '; one outflow curve per value') + ' on the system plot</span></div>';
        var warn = (s.warnings || []).filter(function (w) { return w && w.code !== 'CASE_NA'; }).map(function (w) {
            var m = w.code === 'NO_BASE_CASE' && bv != null ? 'The model value ' + _fmt(_sensDv(s.key, bv), 3) + ' ' + _sensVarLabel(s.key).replace(/^.*\((.*)\)$/, '$1') + ' is not in the list: the sensitivity has no base case.' : w.msg;
            return _vHtml({ st: w.sev === 'info' ? 'info' : 'warn', t: (w.sev === 'info' ? 'ℹ ' : '⚠ ') + m });
        }).join('');
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
            y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + dl + ')', invert: true, min: 0, short: dax.toUpperCase(), fmtR: function (v) { return _fmt(v, 0) + ' ' + dl; } },
            series: ser, markers: markers, hidden: _plots().mHidden || null, onLegend: function (hid) { _plotsSet({ mHidden: hid }); },
            empty: m.all ? 'Pick one test to see its traverses (the RMS ranking is on the right).' : 'The traverses appear when the comparison has a gauge pressure.' });
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
        var w = Mm.write(r.patch);
        if (r.scalars && _fin(r.scalars.wp_midPerf)) _setCtrl('wp_midPerf', r.scalars.wp_midPerf, true);
        ['survey', 'strings'].forEach(_renderTable);
        if (h) h.innerHTML = _vHtml({ st: w && w.ok ? 'ok' : 'warn', t: w && w.ok ? '✓ Well geometry imported from DFIT test ' + sel.value + ' (' + (r.patch.survey || []).length + ' survey stations, ' + (r.patch.strings || []).length + ' strings).' : '⚠ The import was not saved.' });
        if (r.scalars && _fin(r.scalars.wp_midPerf)) _commit('wp_midPerf');
    }
    function _loadExample(k) {
        var ex = EXAMPLES[k], Mm = G.WTS_wp_model; if (!ex || !Mm) return;
        var conf = (typeof G.confirm === 'function') ? G.confirm('Load the example "' + ex.label + '"? It replaces this well\'s Well Performance inputs.') : true;
        if (!conf) return;
        Mm.write(JSON.parse(JSON.stringify(ex.tables)));
        Object.keys(ex.scalars).forEach(function (id) { _setCtrl(id, ex.scalars[id], typeof ex.scalars[id] === 'number'); });
        ST.sens = null; ST.beans = null; ST.match = null; ST.prov = {};
        _renderAllTables();
        _syncUi();
        _commit('wp_ftype');
    }
    function _addRow(t) {
        var tbl = _byId('wp_tbl_' + t), tb = tbl && tbl.querySelector('tbody'); if (!tb) return;
        var n = tb.querySelectorAll('tr').length, M = ST.M || _read(), cols = TABLES[t](M);
        var extra = t === 'survey' ? (_surveyMode(M) === 'mdtvd' ? 2 : 3) : 0;
        tb.insertAdjacentHTML('beforeend', '<tr data-r="' + n + '">' + cols.map(function (c) {
            if (c.opts) return '<td><select data-t="' + t + '" data-c="' + c.k + '" aria-label="' + _esc(c.l) + '">' + c.opts.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select></td>';
            return '<td><input data-t="' + t + '" data-c="' + c.k + '" aria-label="' + _esc(c.l) + '" ' + (c.text ? 'type="text"' : 'type="number" step="any" inputmode="decimal"') + ' value=""></td>';
        }).join('') + new Array(extra + 1).join('<td class="ro">—</td>') + '<td><button type="button" class="btn btn-secondary wp-del" data-del="' + t + '" data-r="' + n + '" aria-label="Delete row" title="Delete row">&#10005;</button></td></tr>');
        var first = tb.querySelector('tr[data-r="' + n + '"] input, tr[data-r="' + n + '"] select'); if (first && first.focus) first.focus();
    }
    function _pasteApply(t) {
        var ta = _byId('wp_pastet_' + t), M = ST.M || _read(), cols = TABLES[t](M); if (!ta) return;
        var lines = String(ta.value || '').split(/\r?\n/), rows = [];
        lines.forEach(function (ln) {
            var cells = ln.trim().split(/\t|;|,(?=\s*[-\d.])|\s{2,}|\s(?=[-\d.])/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
            if (!cells.length || !cells.some(function (x) { return /^[-+]?\d/.test(x); })) return;      // header lines are skipped
            var arr = cols.every(function (c) { return typeof c.k === 'number'; }), row = arr ? [] : {};
            cols.forEach(function (c, i) { var raw = cells[i]; if (c.opts || c.text) row[c.k] = raw == null ? (c.opts ? c.opts[0][0] : '') : raw; else { var v = parseFloat(String(raw == null ? '' : raw).replace(/,/g, '')); row[c.k] = _fin(v) ? _fromDisp(v, c.cat) : null; } });
            rows.push(row);
        });
        var r = _writeTable(t, rows), msg = _byId('wp_pastemsg_' + t);
        if (msg) msg.innerHTML = _vHtml({ st: r && r.ok ? 'ok' : 'warn', t: r && r.ok ? '✓ ' + rows.length + ' row(s) pasted' + ((r.warnings || []).length ? ' — ' + r.warnings.map(function (w) { return w.msg; }).join(' ') : '.') : '⚠ Nothing was pasted.' });
        ta.value = '';
        var p = _byId('wp_paste_' + t); if (p && p.classList) p.classList.remove('on');
        _renderTable(t);
    }
    function _surveyModeSet(m) {
        var M = ST.M || _read(), cur = _surveyMode(M);
        if (m === cur) return;
        if ((M.well.survey || []).length && typeof G.confirm === 'function' && !G.confirm('Switching the survey form clears the survey rows. Continue?')) return;
        _plotsSet({ surveyMode: m });
        if ((M.well.survey || []).length) _writeTable('survey', []);
        ST.M = _read();
        _renderTable('survey'); _renderSvMode();
    }
    function _renderSvMode() { var m = _surveyMode(ST.M || _read()); Array.prototype.forEach.call(document.querySelectorAll('#wp_svmode button'), function (b) { if (b.classList) b.classList.toggle('on', b.getAttribute('data-m') === m); }); }
    function _renderAllTables() { ['survey', 'strings', 'restrictions', 'geo', 'flowline', 'tests'].forEach(_renderTable); _renderRatings(); _renderSvMode(); _renderDfitList(); _syncMatchTests(); }
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
        if (ST.sens && ST.sens.cases) {
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
        if (ST.beans && ST.beans.rows) { L.push(''); L.push('Bean schedule'); ST.beans.rows.forEach(function (b) { L.push([b.bean, _dv(b.q, rc[0]), _dv(b.thp, 'pressureG'), _dv(b.tht, 'temperature'), b.stable].join(',')); }); }
        var csv = L.join('\n');
        ST.lastCsv = csv;
        try {
            var blob = new Blob([csv], { type: 'text/csv' }), a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = 'well_performance_' + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
            if (URL.revokeObjectURL) URL.revokeObjectURL(a.href);
        } catch (e) { /* no download in this environment */ }
        return csv;
    }

    // ── render ────────────────────────────────────────────────────────────────
    function _stepsHtml() {
        return '<nav class="wp-steps rp-skip" id="wp_steps" aria-label="Well performance steps">' + STEPS.map(function (s) {
            return '<button type="button" data-step="' + s.n + '"><span class="wp-dot" id="wp_dot_' + s.n + '"></span>' + CIRC[s.n] + ' ' + s.label + '</button>';
        }).join('') + '<span class="wp-sp"></span><span class="wp-ex">Examples: </span>' +
            '<button type="button" data-act="example" data-ex="oil" title="Load the example vertical oil well">Oil</button><button type="button" data-act="example" data-ex="gas" title="Load the example deviated gas-condensate well">Gas</button></nav>';
    }
    function _tableBlock(t, title, hint, o) {
        o = o || {};
        return '<div class="wp-tblock rp-skip"><div class="wp-sec-h" style="font-size:13px">' + _esc(title) + (o.head || '') + '</div>' + (hint ? '<div class="wp-hint" style="margin:-6px 0 8px">' + hint + '</div>' : '') +
            '<div id="wp_tbl_' + t + '"></div><div class="wp-btns"><button type="button" class="btn btn-secondary" data-act="add" data-t="' + t + '">+ Add row</button>' +
            '<button type="button" class="btn btn-secondary" data-act="paste" data-t="' + t + '">Paste from a spreadsheet</button>' + (o.btns || '') + '</div>' +
            '<div class="wp-paste" id="wp_paste_' + t + '"><textarea id="wp_pastet_' + t + '" aria-label="Paste rows" placeholder="Paste rows copied from a spreadsheet (columns in the order above, tab, comma or semicolon separated; header lines are skipped). The rows replace the table."></textarea>' +
            '<div class="wp-btns"><button type="button" class="btn btn-primary" data-act="pasteok" data-t="' + t + '">Replace the table with these rows</button></div></div><div id="wp_pastemsg_' + t + '"></div></div>';
    }
    function _sectionsHtml() {
        var models = _iprModels(), wellCorr = _corrList('well'), lineCorr = _corrList('line');
        var ipFields = Object.keys(IP).map(function (k) { var d = IP[k]; return _fg('wp_ip_' + k, d.l, { unit: d.u || '', data: 'data-ip="' + k + '"' }); }).join('');
        var s1 = '<section id="wp_step_1" class="wp-sec"><div class="wp-sec-h">① Fluid <span>black-oil properties, gas gravity, water and impurities</span></div><div class="wp-2c">' +
            _card('Fluid', '<div class="fg">' +
                _fg('wp_ftype', 'Fluid type', { options: [['oil', 'Oil'], ['gas', 'Dry gas'], ['condensate', 'Gas-condensate (wet gas)'], ['water', 'Water'], ['gasinj', 'Gas injector', true], ['waterinj', 'Water injector', true]] }) +
                _fg('wp_api', 'Oil / condensate gravity', { unit: '°API', data: 'data-for="oil condensate"' }) + _fg('wp_sgg', 'Gas specific gravity', { unit: 'air = 1' }) +
                _fg('wp_sggBasis', 'Gas gravity basis', { options: [['separator', 'Separator gas'], ['total', 'Total (well stream)']] }) +
                _fg('wp_gor', 'Producing GOR', { unit: 'scf/STB', data: 'data-for="oil"' }) + _fg('wp_wc', 'Water cut', { unit: '%', data: 'data-for="oil water"' }) +
                _fg('wp_cgr', 'Condensate-gas ratio', { unit: 'STB/MMscf', data: 'data-for="gas condensate"' }) + _fg('wp_wgr', 'Water-gas ratio', { unit: 'STB/MMscf', data: 'data-for="gas condensate"' }) +
                _fg('wp_fpsep', 'Separator pressure (fluid)', { unit: 'psig' }) + _fg('wp_ftsep', 'Separator temperature', { unit: '°F' }) +
                _fg('wp_sgw', 'Water specific gravity', { unit: 'water = 1' }) + _fg('wp_sal', 'Salinity', { unit: 'ppm' }) +
                _fg('wp_n2', 'N₂', { unit: 'mol %' }) + _fg('wp_co2', 'CO₂', { unit: 'mol %' }) + _fg('wp_h2s', 'H₂S', { unit: 'mol %' }) +
                _fg('wp_pbUser', 'Bubble point (optional)', { unit: 'psia', data: 'data-for="oil"', hint: 'Shifts the correlation to this pb (one point).' }) +
                _fg('wp_bc', 'Condensate FVF B_c', { unit: 'rb/STB', data: 'data-for="condensate"' }) +
                '</div><details class="rp-skip" style="margin-top:12px"><summary style="cursor:pointer;font-size:12px;color:var(--text2)">PVT correlations</summary><div class="fg" style="margin-top:10px">' +
                _fg('wp_corr_pb', 'Bubble point / Rs', { options: [['standing', 'Standing']] }) + _fg('wp_corr_rs', 'Solution GOR', { options: [['standing', 'Standing']] }) + _fg('wp_corr_bo', 'Oil FVF', { options: [['standing', 'Standing']] }) +
                _fg('wp_corr_muod', 'Dead-oil viscosity', { options: [['beggsRobinson', 'Beggs-Robinson']] }) + _fg('wp_corr_muo', 'Live-oil viscosity', { options: [['beggsRobinson', 'Beggs-Robinson']] }) +
                _fg('wp_corr_muou', 'Undersaturated viscosity', { options: [['vasquezBeggs', 'Vasquez-Beggs']] }) + _fg('wp_corr_z', 'Gas Z factor', { options: [['dranchukAbouKassem', 'Dranchuk-Abou-Kassem']] }) +
                _fg('wp_corr_mug', 'Gas viscosity', { options: [['leeGonzalezEakin', 'Lee-Gonzalez-Eakin']] }) + '</div></details>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="sqc">Use the Separator QC GOR</button></div><div id="wp_fluidmsg"></div>') +
            _card('PVT at six pressures', '<div id="wp_pvt"></div>') + '</div></section>';
        var s2 = '<section id="wp_step_2" class="wp-sec" style="display:none"><div class="wp-sec-h">② Reservoir <span>inflow model, reservoir pressure and its parameters</span></div><div class="wp-2c">' +
            _card('Inflow', '<div class="fg">' +
                _fg('wp_ipr', 'Inflow model', { options: models.map(function (m) { return [m.key, m.label + (m.kind === 'gas' ? ' (gas)' : '')]; }) }) +
                _fg('wp_pr', 'Average reservoir pressure p̄r', { unit: 'psia', ph: 'required' }) + _fg('wp_tres', 'Reservoir temperature', { unit: '°F' }) +
                _fg('wp_respb', 'Bubble point (composite)', { unit: 'psia' }) + ipFields + '</div><div id="wp_iprchip" class="rp-skip" style="margin-top:6px"></div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="prism">Import from PRiSM</button></div><div id="wp_prismmsg"></div>') +
            _card('Inflow performance', '<div class="chart-wrap"><canvas id="wp_cv_ipr" aria-label="Inflow performance relationship plot"></canvas></div><div id="wp_iprsum" style="margin-top:8px"></div>') + '</div></section>';
        var s3 = '<section id="wp_step_3" class="wp-sec" style="display:none"><div class="wp-sec-h">③ Well <span>deviation survey, strings, restrictions, perforations and temperature</span></div>' +
            _card('Deviation survey', _tableBlock('survey', 'Survey stations', 'Minimum curvature gives TVD, departure and dog-leg severity for every station. Every depth on this page shows MD and TVD.',
                { head: ' <span class="wp-seg" id="wp_svmode" style="margin-left:auto"><button type="button" data-act="svmode" data-m="mdinc">MD · Inc · Azi</button><button type="button" data-act="svmode" data-m="mdtvd">MD · TVD</button></span>',
                  btns: '<select id="wpv_dfit" aria-label="DFIT test" style="max-width:260px"></select><button type="button" class="btn btn-secondary" data-act="dfit">Import well geometry from a DFIT test</button>' }) + '<div id="wp_dfitmsg"></div>') +
            '<div class="wp-2c">' + _card('Strings and flow path', _tableBlock('strings', 'Tubing, casing and liners', 'OD / ID in inches; roughness defaults to new steel (0.0006 in).') +
                '<div class="fg" style="margin-top:12px">' + _fg('wp_path', 'Flow path', { options: [['tubing', 'Tubing'], ['annulus', 'Annulus']] }) + _fg('wp_datum', 'Depth datum', { options: [['RKB', 'RKB'], ['GL', 'Ground level'], ['MSL', 'Mean sea level']] }) + _fg('wp_datumOff', 'Datum offset', { unit: 'ft' }) + '</div>') +
            _card('Restrictions and perforations', _tableBlock('restrictions', 'SSSV, nipples, sleeves, cross-overs, downhole chokes', 'Applied at the restriction depth with a homogeneous loss coefficient (K from β when blank).') +
                '<div class="fg" style="margin-top:12px">' + _fg('wp_perfTop', 'Top perforation (MD)', { unit: 'ft' }) + _fg('wp_perfBot', 'Bottom perforation (MD)', { unit: 'ft' }) + _fg('wp_midPerf', 'Mid-perforation (MD) — the bottom node', { unit: 'ft' }) + '</div>') + '</div>' +
            '<div class="wp-2c">' + _card('Temperature', '<div class="fg">' + _fg('wp_surfT', 'Surface temperature', { unit: '°F' }) + _fg('wp_tht', 'Flowing wellhead temperature', { unit: '°F' }) + _fg('wp_thtMeas', 'THT measured', { check: true }) +
                _fg('wp_heat', 'Temperature model', { options: [['linear', 'Linear between THT and the reservoir'], ['relax', 'Heat-transfer relaxation (release 4.4)', true]] }) + '</div>' + _tableBlock('geo', 'Geothermal points', 'TVD and static temperature; at least the surface and the reservoir.')) +
            _card('Flow segments', '<div id="wp_segs"></div>') + '</div></section>';
        var s4 = '<section id="wp_step_4" class="wp-sec" style="display:none"><div class="wp-sec-h">④ Lift <span>natural flow in this release</span></div>' +
            _card('Artificial lift', '<div class="fg">' + _fg('wp_lift', 'Lift type', { options: [['none', 'Natural flow'], ['gaslift', 'Gas lift (release 4.4)', true], ['esp', 'ESP (release 4.5)', true]] }) + '</div>' +
                '<div class="wp-hint" style="margin-top:10px">Gas-lift quick look (injection depth, lift-gas performance curve, optimum and economic points) arrives in release 4.4; the Gas Lift Design page of this hub designs the unloading valves today.</div>') + '</section>';
        var s5 = '<section id="wp_step_5" class="wp-sec" style="display:none"><div class="wp-sec-h">⑤ System <span>node, surface boundary, correlations, ratings and studies</span></div><div class="wp-2c">' +
            _card('Surface and solve', '<div class="fg">' +
                _fg('wp_mode', 'Solve for', { options: [['rate', 'Rate at these settings'], ['pressure', 'Pressures for a rate'], ['max', 'Maximum rate (no choke)'], ['design', 'Bean or THP for a target rate']] }) +
                _fg('wp_node', 'Solution node', { options: [['bottom', 'Bottom hole (mid-perf)'], ['wellhead', 'Wellhead'], ['separator', 'Separator']] }) +
                _fg('wp_choke', 'Surface choke in line', { check: true }) +
                _fg('wp_bean', 'Choke bean', { unit: '/64 in', data: 'data-choke="on"' }) + _fg('wp_ckcorr', 'Choke correlation', { options: [['gilbert', 'Gilbert'], ['ros', 'Ros'], ['baxendell', 'Baxendell'], ['achong', 'Achong']], data: 'data-choke="on"' }) +
                _fg('wp_thp', 'Wellhead pressure (fixed)', { unit: 'psig', data: 'data-choke="off"' }) +
                _fg('wp_psep', 'Separator pressure', { unit: 'psig' }) + _fg('wp_tamb', 'Ambient temperature', { unit: '°F' }) +
                _fg('wp_tkind', 'Design variable', { options: [['bean', 'Bean'], ['thp', 'Wellhead pressure']], data: 'data-mode="design pressure"' }) + _fg('wp_tq', 'Target rate', { unit: 'STB/d or Mscf/d', data: 'data-mode="design pressure"' }) +
                '</div>' + _tableBlock('flowline', 'Flowline to the separator', 'Marched with the flowline correlation below.') +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="design" data-mode="design pressure">Solve the design</button><button type="button" class="btn btn-secondary" data-act="solve">Solve now</button></div><div id="wp_design"></div>') +
            _card('Correlations and numerics', '<div class="fg">' +
                _fg('wp_corr_well', 'Well (vertical lift)', { options: [['', 'Default for the fluid']].concat(wellCorr.map(function (c) { return [c.key, c.label + (c.verified ? '' : ' — provisional')]; })) }) +
                _fg('wp_corr_line', 'Flowline', { options: lineCorr.map(function (c) { return [c.key, c.label + (c.verified ? '' : ' — provisional')]; }) }) +
                _fg('wp_mult_hl', 'Holdup multiplier', { hint: '1 = as published (tuning in release 4.4).' }) + _fg('wp_mult_f', 'Friction multiplier') +
                _fg('wp_eroC', 'Erosional C', { unit: 'API RP 14E' }) + _fg('wp_stepFt', 'Step length', { unit: 'ft' }) + _fg('wp_refine', 'Refine steps', { check: true }) + '</div>' +
                '<div class="wp-sec-h" style="font-size:13px;margin-top:14px">Equipment ratings</div><div class="fg rp-skip">' +
                '<div class="fg-item"><label for="wpt_rate_wh">Wellhead rating (' + _esc(_lab('pressure', 'psi')) + ')</label><input id="wpt_rate_wh" data-rt="wellhead_psi" type="number" step="any" inputmode="decimal" placeholder="no default"></div>' +
                '<div class="fg-item"><label for="wpt_rate_tht">Maximum THT (' + _esc(_lab('temperature', '°F')) + ')</label><input id="wpt_rate_tht" data-rt="tht_max_F" type="number" step="any" inputmode="decimal" placeholder="no default"></div>' +
                '<div class="fg-item"><label for="wpt_beans">Bean list (/64 in)</label><input id="wpt_beans" data-rt="beans" type="text" placeholder="16 20 24 32 40 48"></div></div>' +
                '<div class="wp-sec-h" style="font-size:13px;margin-top:14px">Studies</div><div class="fg rp-skip">' +
                '<div class="fg-item"><label for="wpv_svar">Sensitivity variable</label><select id="wpv_svar">' + _sensDefs().map(function (v) { return '<option value="' + _esc(v[0]) + '">' + _esc(_sensVarLabel(v[0])) + '</option>'; }).join('') + '</select></div>' +
                '<div class="fg-item"><label for="wpv_svals">Values (up to 10, in the variable\'s units)</label><input id="wpv_svals" type="text" value="0 20 40 60 80" spellcheck="false" autocomplete="off"></div></div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="sens">Run sensitivity</button><button type="button" class="btn btn-secondary" data-act="beans">Bean schedule</button><button type="button" class="btn btn-secondary" data-act="csv">Export CSV</button></div>' +
                '<div id="wp_jobbox" class="rp-skip"></div><div id="wp_senstbl"></div><div id="wp_beans"></div>') + '</div></section>';
        var s6 = '<section id="wp_step_6" class="wp-sec" style="display:none"><div class="wp-sec-h">⑥ Match <span>production tests, correlation comparison, QC and IPR from a test</span></div>' +
            _card('Production tests', _tableBlock('tests', 'Tests', 'Gauge MD and gauge pressure let the comparison rank the correlations at the gauge.') +
                '<div class="fg rp-skip" style="margin-top:12px"><div class="fg-item"><label>Correlations to compare</label><div id="wp_corrset" style="display:flex;flex-wrap:wrap;gap:10px;font-size:12.5px">' +
                wellCorr.map(function (c) { return '<label style="display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;color:var(--text)"><input type="checkbox" data-corr="' + _esc(c.key) + '" checked> ' + _esc(c.label) + '</label>'; }).join('') + '</div></div>' +
                '<div class="fg-item"><label for="wpv_mtest">Test to compare</label><select id="wpv_mtest"><option value="0">first used test</option></select></div>' +
                _fg('wp_m_solve', 'Back-calculate from the test', { options: [['pr', 'Reservoir pressure p̄r (coefficients held)'], ['J', 'Productivity (p̄r held)'], ['S', 'Skin S (k·h held, Darcy)']], def: 'pr' }) + '</div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="match">Compare and QC</button></div><div class="wp-hint">Each correlation is marched from the measured THP down the surveyed path at the test\'s own rates and THT; the QC checks every test (used or not).</div><div id="wp_matchres" style="margin-top:10px"></div>') + '</section>';
        var s7 = '<section id="wp_step_7" class="wp-sec" style="display:none"><div class="wp-sec-h">⑦ Report <span>what the page report and the Quick Report carry</span></div>' +
            _card('Report', '<div class="wp-notes">The page report (PDF / PNG from the page export bar) and the Quick Report carry the block at the top of this page: the KPI strip, the well schematic, the system plot, the operating point, the pressure-loss breakdown, the checks, the correlation validity, the traverse card and the Notes. ' +
                'Full tables (traverse, curves, sensitivity, bean schedule) are in the CSV.</div>' +
                '<div class="fg" style="margin-top:12px">' + _fg('wp_notes', 'Engineer notes (printed in the Notes)', { area: true, rows: 4, def: '', ph: 'Assumptions, data sources, decisions…' }) + '</div>' +
                '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="csv">Export CSV bundle</button></div>') + '</section>';
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
                    [['pressure', 'Pressure'], ['temperature', 'Temperature'], ['holdup', 'Holdup'], ['velocity', 'Velocity'], ['pattern', 'Flow pattern'], ['none', 'None']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === prop ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' }) +
            _card('System — inflow and outflow', '<div class="chart-wrap"><canvas id="wp_cv_sys" aria-label="System plot: inflow and outflow curves, operating point; drag the handles to change the reservoir pressure, the wellhead pressure, the bean or the water cut"></canvas></div>' +
                '<div class="wp-legend-hint rp-skip">Drag a handle — <b>p̄r</b> on the inflow curve, <b>THP</b> on the right rail, <b>bean</b> and <b>WC</b> on the top rails — and the well re-solves. Wheel or pinch to zoom, drag to pan, double-click to reset; click the legend to hide a curve. Keyboard: [ and ] pick a handle, arrows move it, Enter commits.</div>') +
            '</div>' +
            '<div class="wp-row3">' +
            '<div class="rbox" id="wp_op"></div>' +
            _card('Pressure-loss breakdown', '<div class="chart-wrap"><canvas id="wp_cv_bd" aria-label="Pressure-loss breakdown"></canvas></div>', { cls: 'wp-bdcard' }) +
            '<div class="rbox" id="wp_verd"></div>' +
            '</div>' +
            _card('Traverse', '<div class="chart-wrap"><canvas id="wp_cv_tr" aria-label="Gradient traverse: pressure and temperature against depth"></canvas></div><div class="wp-legend-hint" id="wp_trleg"></div>',
                { tools: '<span class="wp-tabs" id="wp_trtabs" role="tablist">' + [['traverse', 'Pressure & temperature'], ['loading', 'Liquid loading'], ['sens', 'Sensitivity'], ['beans', 'Bean schedule']].map(function (t) { return '<button type="button" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</span>' +
                    '<span class="wp-seg" id="wp_depthseg"><button type="button" data-depth="tvd">TVD</button><button type="button" data-depth="md">MD</button></span>' }) +
            '<div class="rbox" id="wp_valid"></div>' +
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
        _bindRoot();
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
            if (t.id === 'wpv_prop') { _plotsSet({ prop: t.value }); _renderSchematic(); return; }
            if (t.id === 'wpv_svar') { _sensSuggest(); return; }
            if (t.getAttribute && t.getAttribute('data-corr')) return;
            if (!t.id || t.id.indexOf('wp_') !== 0) return;
            if (t.id === 'wp_ipr' || t.id === 'wp_ftype' || t.id === 'wp_choke' || t.id === 'wp_mode') _syncUi();
            if (e.isTrusted && ST.prov[t.id]) { delete ST.prov[t.id]; var lab = root.querySelector('label[for="' + t.id + '"] .wp-chip'); if (lab && lab.parentNode) lab.parentNode.removeChild(lab); }
            G.calcWellPerf();
        });
        root.addEventListener('click', function (e) {
            var t = e.target, b = t && t.closest ? t.closest('button,[data-comp]') : null;
            if (!b || !root.contains(b)) return;
            if (b.getAttribute('data-step')) { _goStep(+b.getAttribute('data-step'), true); return; }
            if (b.getAttribute('data-comp')) { _editComp(b.getAttribute('data-comp')); return; }
            if (b.getAttribute('data-del')) {
                var tn = b.getAttribute('data-del'), tr = b.closest('tr'); if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
                _writeTable(tn, _collectTable(tn)); _renderTable(tn); return;
            }
            if (b.getAttribute('data-tab')) { _plotsSet({ trTab: b.getAttribute('data-tab') }); _renderTraverseCard(); return; }
            if (b.getAttribute('data-depth')) { _plotsSet({ depth: b.getAttribute('data-depth') }); _renderTraverseCard(); return; }
            if (b.getAttribute('data-mdepth')) { _plotsSet({ mdepth: b.getAttribute('data-mdepth') }); Array.prototype.forEach.call(document.querySelectorAll('#wp_mdepth button'), function (x) { if (x.classList) x.classList.toggle('on', x === b); }); _drawMatchPlot(); return; }
            var act = b.getAttribute('data-act'); if (act) _act(act, b);
        });
        root.addEventListener('keydown', function (e) {
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
        resetJobs: function () { ST.sens = null; ST.beans = null; ST.match = null; ST.design = null; ST.prov = {}; ST.slow = false; }
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
        hooks: { silent: true, after: function () { _syncUi(); _renderAllTables(); G.calcWellPerf(); } },
        render: function (body) { return G.renderWellPerf(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        var again = function () { if (_byId('wp_root')) { ST.sens = null; ST.beans = null; ST.match = null; ST.prov = {}; var mr = _byId('wp_matchres'); if (mr) mr.innerHTML = ''; _renderAllTables(); G.calcWellPerf(); } };
        document.addEventListener('wts:well-changed', again);
        document.addEventListener('wts:project-loaded', again);
        document.addEventListener('wts:wellperf-model-changed', function (e) { if (_byId('wp_root')) { G.calcWellPerf(); if (!e || !e.detail || !e.detail.keys || e.detail.keys.indexOf('tests') !== -1) _syncMatchTests(); } });
        document.addEventListener('wts:unit-system-changed', function () {
            if (!_byId('wp_root')) return;
            _renderAllTables();
            G.calcWellPerf();
            _renderMatch();
        });
    }
    if (typeof G.addEventListener === 'function') {
        G.addEventListener('resize', function () {
            if (!_byId('wp_root') || !G.WTS_wp_view) return;
            ['wp_cv_sys', 'wp_cv_tr', 'wp_cv_ipr', 'wp_cv_match'].forEach(function (id) { var c = _byId(id); if (c) G.WTS_wp_view.redraw(c); });
            _renderBreakdown(); _renderSchematic();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var e = G.WTS_calcRegistry && G.WTS_calcRegistry.wellperf;
    if (!(e && e.key === 'wellperf' && typeof e.render === 'function' && e.hooks && e.hooks.silent === true) && typeof console !== 'undefined') console.error('[wellperf self-test] registry entry malformed');
})();
