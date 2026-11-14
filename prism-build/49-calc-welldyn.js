// =============================================================================
// WTS — 49-calc-welldyn.js  (Round 9) — Well Dynamics page, route `welldyn` (lane WD3)
// -----------------------------------------------------------------------------
// docs/WELL-DYNAMICS-PLAN.md §2.1, §3.4–§3.8, §6, §7. Its own sidebar row in Production & Reservoir, right after the Well Performance
// hub row (owner 2026-11-13: "just build it into menu") — not a hub member; a dashboard tile from the registry.
//
// Contract
//   registry  WTS_calcRegistry.welldyn {key, title 'Well Dynamics', navTitle, sub, group 'Production & Reservoir', icon '&#8767;', badge,
//             bc, desc, hooks: {silent: true, after: → one calcWellDyn()}, render}
//   window.renderWellDyn(body), window.calcWellDyn() — re-reads the shared model (WTS_wp_model.read(); no copy is kept), rebuilds the
//             simulator only when the model hash (M without dyn) or the scenario settings changed and no run has data; the steady
//             reference is cached per model hash (sim.ref → opts.ref); it never starts a run (the page opens paused)
//   WTS_state.welldyn = {v:1, ok, playing, t, state, summary, model:{ok, notes}}
//   WTS_welldyn_page  test hook {state, sim, rec, play, pause, frame(ts), step, csv, runFile, load, scenario, scrub, cont, mark, …}
//   events    listens to 'wts:well-changed' / 'wts:project-loaded' (stop and discard the run), 'wts:wellperf-model-changed' (banner
//             "the well model changed — Rebuild"; ignored when detail.keys is exactly ['dyn'] — the page's own case save),
//             'wts:unit-system-changed' (re-render readouts), document 'visibilitychange' (hidden → pause; visible never resumes)
//   markup    #wd_root; header (#wd_go_wellperf, model status); #wd_toolbar (role toolbar, .rp-skip); #wd_timeline (.rp-skip: scrub slider,
//             marks, state strip, Continue from here); #wd_kpis; the wellbore (#wd_cv_well, #wd_cv_nav) and the chart tabs (.rp-skip);
//             cards Scenario and Cases; #wd_res = the compact report block, always visible (inputs, run summary, KPI chips, wellbore and
//             trend canvases at fixed sizes, state timeline, provisional methods, verdicts, Notes)
//
// Run loop (WD-D9): requestAnimationFrame only while playing; paused, hidden, ended or off the page → no frame is requested. No
// setInterval, no polling, no function wrapping (setTimeout(frame, 16) only while playing, and only without requestAnimationFrame).
// The loop keeps a simulated-time target (target += speed · Δwall) and runs the engine with run(target − t, {maxWallMs: 10}); the
// engine never splits a step, so the overshoot is carried; after a wall-limited frame the target may lead the engine by at most
// speed × 0.1 s (the deficit is dropped and the achieved speed is shown: "running slower than ×N").
// Engines are resolved at call time (WTS_wd_engine, WTS_wd_rec, WTS_wd_view); a missing engine shows a plain "not available" state.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var KEY = 'welldyn', TITLE = 'Well Dynamics';
    var SUB = 'Transient well simulation: loading, unloading, shut-in, start-up and lift in time';
    var PATM = 14.696, SPEEDS = [1, 10, 60, 300, 1000], DEF_SPEED = 60;
    var PROVISIONAL_TXT = 'provisional — not verified against a published example';
    var TABS = [['rates', 'Rates'], ['press', 'Pressures'], ['nodal', 'IPR / VLP'], ['whp', 'WHP vs rate'], ['depth', 'Depth log'], ['lift', 'Lift'], ['close', 'Close-up']];
    var LAYERS = [['phase', 'Phase'], ['regime', 'Flow regime'], ['pressure', 'Pressure'], ['holdup', 'Holdup'], ['velocity', 'Velocity']];
    var PRESETS = [['steady', 'Steady flow'], ['beanup', 'Bean-up steps'], ['shutin', 'Shut-in build-up'], ['gasload', 'Gas-well loading'],
        ['foamer', 'Foamer'], ['cycle', 'Intermittent'], ['glunload', 'Gas-lift unloading'], ['espstart', 'ESP start']];
    var EV_TYPES = [['bean', 'Bean (/64 in)'], ['shutin', 'Shut in'], ['open', 'Open'], ['psep', 'Separator (psig)'], ['foamer', 'Foamer (ppm)'], ['gl', 'Lift gas (Mscf/d)'], ['esp', 'ESP (Hz)']];
    var calcs = 0;
    var ST = {
        M: null, mHash: null, optsHash: null, refs: {}, sim: null, rec: null, err: null, playing: false, ended: false, speed: DEF_SPEED, target: 0,
        lastTs: null, raf: 0, rafKind: null, frameN: 0, ach: { t0: null, s0: 0, w0: 0, val: null }, scrubT: null, wb: null, nav: null, tab: 'rates',
        layer: 'phase', modelStale: false, settingsStale: false, run: null, runNote: null, markStart: null, trail: [], events: [], openCmd: true,
        endT: 4 * 3600, lastState: null, live: '', note: '', closeInfo: null, csvOpen: false
    };

    // ── helpers ───────────────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _now() { try { return (G.performance && typeof G.performance.now === 'function') ? G.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
    function _emit(name, detail) {
        try {
            if (typeof document === 'undefined' || !document.dispatchEvent) return;
            var ev = (typeof CustomEvent === 'function') ? new CustomEvent(name, { detail: detail }) : null;
            if (ev) document.dispatchEvent(ev);
        } catch (e) { /* smoke stub */ }
    }
    function _NS(n) { var o = G[n]; return (o && typeof o === 'object') ? o : null; }
    function _E() { var E = _NS('WTS_wd_engine'); return (E && typeof E.create === 'function') ? E : null; }
    function _REC() { var R = _NS('WTS_wd_rec'); return (R && typeof R.create === 'function') ? R : null; }
    function _V() { var V = _NS('WTS_wd_view'); return (V && typeof V.wellbore === 'function') ? V : null; }
    function _pref(k, v) {
        var key = 'wtspref_wd_' + k;
        try {
            if (v === undefined) { var s = G.localStorage ? G.localStorage.getItem(key) : null; return s == null ? null : s; }   /* ls-raw: device pref */
            if (typeof G.WTS_lsSet === 'function') G.WTS_lsSet(key, String(v));
            else if (G.localStorage) G.localStorage.setItem(key, String(v));   /* ls-raw: fallback (no host WTS_lsSet: smoke stub, tests) */
        } catch (e) { /* private window, blocked storage */ }
        return null;
    }
    function _hms(t) {
        if (!_fin(t)) return '—';
        var s = Math.max(0, Math.round(t)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
        return h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
    }
    function _hmin(t) {
        if (!_fin(t)) return '—';
        var m = Math.round(Math.max(0, t) / 60), h = Math.floor(m / 60); m = m % 60;
        return h ? h + ' h ' + m + ' min' : m + ' min';
    }

    // ── units (display) — the categories and helpers the Well Performance page uses ──
    function _U() { return G.WTS_units; }
    function _metric() { var U = _U(); return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _hasCat(cat) { var U = _U(); return !!(U && U.CATEGORIES && U.CATEGORIES[cat]); }
    function _dv(v, cat) { var U = _U(); return (_fin(v) && _metric() && _hasCat(cat) && U.convertCategory) ? U.convertCategory(v, cat, 'imperial', 'metric') : v; }
    function _lab(cat, imp) { var U = _U(); return (_metric() && _hasCat(cat)) ? U.CATEGORIES[cat].metric.label : imp; }
    function _fmt(v, d) {
        if (v == null || !_fin(v)) return '—';
        var s = Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
        return s === '-0' ? '0' : s;
    }
    function _u(v, cat, d, imp, dMet) { if (!_fin(v)) return '—'; return _fmt(_dv(v, cat), _metric() ? (dMet == null ? d : dMet) : d) + ' ' + _lab(cat, imp); }
    function _canon(fn) { var U = _U(); return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _decComma() { return !!(G.WTS_a11y && typeof G.WTS_a11y.decimalComma === 'function' && G.WTS_a11y.decimalComma()); }
    function _isGas(M) { return !!(M && M.fluid && /gas|condensate/.test(M.fluid.type) && M.fluid.type !== 'gasinj'); }
    function _rateCat(M) { return _isGas(M) ? ['gasRateSmall', 'Mscf/d'] : ['liquidRate', 'STB/d']; }
    function _reduced() { try { return !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
    function _phone() { var w = G.innerWidth; return _fin(w) && w <= 600; }

    // ── the shared model ──────────────────────────────────────────────────────
    function _read() {
        var W = G.WTS_wp_model; if (!W || typeof W.read !== 'function') return null;
        try { return W.read(); } catch (e) { return null; }
    }
    function _hash(o) { var R = _REC(); if (R && R.hash) return R.hash(o); var E = _E(); if (E && E.hash) return E.hash(o); return JSON.stringify(o).length + ':' + JSON.stringify(o).slice(0, 64); }
    function _modelHash(M) { if (!M) return null; var c = _clone(M); delete c.dyn; delete c.meta; return _hash(c); }
    function _modelStatus(M) {
        var notes = [], ok = true;
        if (!M) return { ok: false, notes: ['the Well Performance model is not available'] };
        if (!_fin(M.res.pr)) { ok = false; notes.push('average reservoir pressure p̄r needed'); }
        if (!M.well.strings || !M.well.strings.length) notes.push('no strings: the default tubing is used');
        if (!_fin(M.well.midPerfMd)) notes.push('mid-perforation depth not set');
        if (M.fluid.type === 'waterinj' || M.fluid.type === 'gasinj') { ok = false; notes.push('injection wells are not simulated in time'); }
        if (M.fluid.rv && M.fluid.rv.mode && M.fluid.rv.mode !== 'none') { ok = false; notes.push('a vaporised-condensate (Rv) fluid is not simulated in time'); }
        return { ok: ok, notes: notes };
    }
    function _modelSummary(M) {
        if (!M) return '—';
        var ft = { oil: 'Oil', gas: 'Gas', condensate: 'Gas-condensate', water: 'Water', gasinj: 'Gas injector', waterinj: 'Water injector' }[M.fluid.type] || M.fluid.type;
        var sv = M.well.survey || [], td = sv.length ? sv[sv.length - 1][0] : null;
        var lift = { none: 'natural flow', gaslift: 'gas lift', esp: 'ESP' }[M.lift.type] || M.lift.type;
        return ft + ' · inflow ' + (M.res.model || '—') + ' · ' + (_fin(M.well.midPerfMd) ? 'mid-perf ' + _u(M.well.midPerfMd, 'length', 0, 'ft') + ' MD' : (td ? 'TD ' + _u(td, 'length', 0, 'ft') : 'well —')) +
            ' · ' + (sv.length ? sv.length + ' survey stations' : 'vertical') + ' · ' + lift;
    }
    function _wellName() {
        var W = G.WTS_wells;
        try {
            if (W && typeof W.list === 'function') { var l = W.list() || [], a = l.filter(function (x) { return x && x.active; })[0]; if (a && a.name) return String(a.name); }
        } catch (e) { /* ignore */ }
        return 'Well';
    }
    // the model as a replay file carries it (§3.7): the Well Performance scalars (wp_*) and the table record
    function _modelForFile() {
        var sc = {}, tb = {};
        try {
            var s = G.localStorage ? G.localStorage.getItem('wts_page_wellperf') : null;   /* ls-raw: read-only copy of the shared scalars */
            var p = s ? JSON.parse(s) : null;
            if (p && _isObj(p.f)) Object.keys(p.f).forEach(function (k) { if (/^wp_/.test(k)) sc[k] = p.f[k]; });
        } catch (e) { sc = {}; }
        var W = G.WTS_wp_model;
        if (W && typeof W.readRaw === 'function') {
            var r = W.readRaw();
            // the §3.7 table list plus tests and cases (additive): they are part of M, so the engine's model hash of a file-built
            // simulator equals the live one and a file snapshot can be continued
            if (r && r.status === 'ok' && r.rec) ['survey', 'strings', 'restrictions', 'geo', 'flowline', 'rating', 'beans', 'lab', 'pump', 'corrSections', 'layers', 'glValves', 'tests', 'cases'].forEach(function (k) {
                if (r.rec[k] !== undefined) tb[k] = _clone(r.rec[k]);
            });
        }
        return { scalars: sc, tables: tb };
    }
    function _modelFromFile(model) {
        var W = G.WTS_wp_model; if (!W || typeof W.read !== 'function' || typeof W.empty !== 'function') return null;
        var rec = W.empty();
        Object.keys((model && model.tables) || {}).forEach(function (k) { if (k !== 'dyn' && model.tables[k] != null) rec[k] = _clone(model.tables[k]); });
        var d = { wts_wellperf_model: JSON.stringify(rec) };
        var mem = { getItem: function (k) { return k in d ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; } };
        try { return W.read({ storage: mem, scalars: (model && model.scalars) || {} }); } catch (e) { return null; }
    }

    // ── settings (scenario scalars wd_*) ──────────────────────────────────────
    var DEFS = { wd_start: 'steady', wd_static: 'liquid', wd_liquid: 'water', wd_level: 4000, wd_dur: 4, wd_cells: 60, wd_resmode: 'ipr', wd_prior: 'auto',
        wd_prior_h: 720, wd_closure: 'corr', wd_fallback: false, wd_belfroid: false, wd_backflow: true, wd_temp: 'frozen', wd_preset: 'steady',
        wd_k: '', wd_h: '', wd_phi: '', wd_ct: '', wd_mu: '', wd_B: '', wd_rw: '', wd_re: '', wd_S: '' };
    function _val(id) {
        var e = _byId(id); if (!e) return DEFS[id];
        if (e.type === 'checkbox') return !!e.checked;
        return e.value;
    }
    function _numv(id) { var v = parseFloat(_val(id)); return _fin(v) ? v : null; }
    function _settings() {
        return _canon(function () {
            var start = _val('wd_start') === 'static' ? 'static' : 'steady';
            var res = { mode: _val('wd_resmode') === 'transient' ? 'transient' : 'ipr', backflow: _val('wd_backflow') !== false };
            ['k', 'h', 'phi', 'ct', 'mu', 'B', 'rw', 're', 'S'].forEach(function (k) { var v = _numv('wd_' + k); if (v !== null) res[k] = v; });
            var pk = _val('wd_prior'); if (pk === 'auto' || !pk) pk = start === 'steady' ? 'steady' : 'none';
            res.prior = { kind: pk, t_h: _numv('wd_prior_h') || 720, shut_h: 0 };
            var st = { kind: ['gas', 'liquid', 'level'].indexOf(_val('wd_static')) !== -1 ? _val('wd_static') : 'liquid', liquidTopMd: null, liquid: _val('wd_liquid') === 'oil' ? 'oil' : 'water' };
            if (st.kind === 'level') st.liquidTopMd = _numv('wd_level');
            return {
                cells: Math.max(20, Math.min(200, Math.round(_numv('wd_cells') || 60))), start: start, static: start === 'static' ? st : null, reservoir: res,
                closure: _val('wd_closure') === 'driftflux' ? 'driftflux' : 'corr', fallback: !!_val('wd_fallback'), loading: { belfroid: !!_val('wd_belfroid') },
                temperature: _val('wd_temp') === 'relax' ? 'relax' : 'frozen', duration_s: Math.max(60, (_numv('wd_dur') || 4) * 3600)
            };
        });
    }
    function _optsOf(set) {
        var o = _clone(set); delete o.duration_s;
        if (!o.static) delete o.static;
        o.events = _clone(ST.events) || [];
        return o;
    }
    // the parameters the transient reservoir still lacks, resolved as WTS_wd_res resolves them: the Scenario → Reservoir entries, then the
    // well's dyn.res, then the IPR parameters (μ comes from the fluid at p̄r when not entered; B is not used by the line source)
    function _resComplete(r) {
        var M = ST.M || _read(), dr = (M && M.dyn && M.dyn.res) || {}, ip = (M && M.res && M.res.params) || {};
        var ALT = { k: ['k'], h: ['h'], phi: ['phi'], ct: ['ct'], rw: ['rw'], re: ['re'] };
        return ['k', 'h', 'phi', 'ct', 'rw', 're'].filter(function (k) {
            if (_fin(r[k]) && r[k] > 0) return false;
            if (_fin(+dr[k]) && +dr[k] > 0) return false;
            return !ALT[k].some(function (a) { return _fin(+ip[a]) && +ip[a] > 0; });
        });
    }

    // ── simulator life cycle ──────────────────────────────────────────────────
    function _dispose() {
        _pause('reset');
        if (ST.rec && ST.rec.detach) ST.rec.detach();
        if (ST.sim && typeof ST.sim.dispose === 'function') { try { ST.sim.dispose(); } catch (e) { /* ignore */ } }
        ST.sim = null; ST.rec = null; ST.trail = []; ST.scrubT = null; ST.ended = false; ST.markStart = null; ST.lastState = null;
    }
    function _hasData() { return !!(ST.rec && ST.rec.count && ST.rec.count() > 1); }
    function _build(why) {
        _dispose();
        ST.run = null; ST.runNote = null;
        ST.M = _read(); ST.mHash = _modelHash(ST.M);
        var set = _settings(), E = _E(), RC = _REC();
        ST.endT = set.duration_s;
        ST.optsHash = _hash(_optsOf(set));
        ST.modelStale = false; ST.settingsStale = false;
        if (!ST.M) { ST.err = { code: 'NO_MODEL', msg: 'The Well Performance model is not available.' }; return false; }
        if (!E) { ST.err = { code: 'MISSING_ENGINE', msg: 'The Well Dynamics engine is not available in this build.' }; return false; }
        var ms = _modelStatus(ST.M);
        if (!ms.ok) { ST.err = { code: 'MODEL', msg: 'Set up this well in Well Performance first: ' + ms.notes.join('; ') + '.' }; return false; }
        var opts = _optsOf(set);
        ST.createOpts = _clone(opts);                                   // the settings of this simulator (a replay file carries them)
        var ref = ST.refs[ST.mHash]; if (ref) opts.ref = ref;
        var t0 = _now(), sim;
        try { sim = E.create(ST.M, opts); } catch (e) { if (typeof console !== 'undefined') console.error('[welldyn] create', e); sim = { ok: false, code: 'ENGINE_ERROR', errors: [String(e && e.message)] }; }
        ST.createMs = _now() - t0;
        if (!sim || sim.ok === false) {
            var code = sim && sim.code || 'ENGINE_ERROR';
            ST.err = { code: code, msg: _refusal(code, sim) };
            return false;
        }
        ST.err = null;
        if (sim.ref && ST.mHash) ST.refs = (function () { var o = {}; o[ST.mHash] = sim.ref; return o; })();   // one cached reference (C7)
        ST.sim = sim; ST.openCmd = !!(sim.state && sim.state.open);
        if (RC) { ST.rec = RC.create({ every_s: 10, snapEvery_s: 60, capMB: 32 }); ST.rec.attach(sim); }
        sim.on('state', _onState);
        ST.target = sim.state.t; ST.lastState = sim.state.well && sim.state.well.state;
        _mountViews();
        return true;
    }
    function _refusal(code, r) {
        var m = {
            NO_STEADY: 'No stable operating point for this well at these settings: start from a static well (Scenario → Start).',
            RV_NOT_IN_TRANSIENT: 'A vaporised-condensate (Rv) fluid is not simulated in time; switch the fluid to the wet-gas model in Well Performance.',
            INJECTOR: 'Injection wells are not simulated in time.',
            GL_NOT_APPLICABLE: 'Gas lift does not apply to this well (see Well Performance step ④).',
            ESP_NOT_APPLICABLE: 'The ESP does not apply to this well (see Well Performance step ④).',
            MISSING_ENGINE: 'A shared engine is not available in this build.',
            NOT_BUILT: 'The Well Dynamics engine is being built.'
        }[code];
        return m || ('The simulator could not start' + (r && r.errors && r.errors.length ? ': ' + String(r.errors[0]).slice(0, 200) : '.'));
    }
    function _onState(d) {
        if (!d || !d.to) return;
        var E = _E(), lab = (E && E.STATES && E.STATES[d.to] && E.STATES[d.to].label) || d.to;
        ST.live = 'Well state: ' + lab + ' at ' + _hms(d.t);
        var lr = _byId('wd_live'); if (lr) lr.textContent = ST.live;
    }

    // ── run loop (WD-D9) ─────────────────────────────────────────────────────
    function _req() {
        if (ST.raf) return;
        if (typeof G.requestAnimationFrame === 'function') { ST.rafKind = 'raf'; ST.raf = G.requestAnimationFrame(_frame); }
        else if (typeof G.setTimeout === 'function') { ST.rafKind = 'to'; ST.raf = G.setTimeout(function () { _frame(_now()); }, 16); }
    }
    function _cancel() {
        if (!ST.raf) return;
        try { if (ST.rafKind === 'raf' && typeof G.cancelAnimationFrame === 'function') G.cancelAnimationFrame(ST.raf); else if (typeof G.clearTimeout === 'function') G.clearTimeout(ST.raf); } catch (e) { /* ignore */ }
        ST.raf = 0;
    }
    function _play() {
        if (ST.playing) return true;
        if (!ST.sim && !_build('play')) { _renderAll(); return false; }
        if (ST.scrubT !== null) { ST.scrubT = null; }
        var S = ST.sim.state;
        if (S.t >= ST.endT - 1e-9) { ST.endT = S.t + _settings().duration_s; ST.ended = false; }
        ST.playing = true; ST.lastTs = null; ST.target = S.t; ST.ach = { t0: null, s0: S.t, w0: 0, val: null };
        _syncToolbar();
        _req();
        _publish();
        return true;
    }
    function _pause(why) {
        ST.playing = false; _cancel(); ST.lastTs = null;
        if (why === 'end') ST.ended = true;
        _syncToolbar();
        if (why !== 'reset') {
            _renderSlow(); _publish();
            // the Quick Report snapshot of the current state and the run summary (the host's own debounce waits for a click)
            if (_byId('wd_root') && typeof G.WTS_snapshotNow === 'function') { try { G.WTS_snapshotNow(); } catch (e) { /* ignore */ } }
        }
    }
    function _frame(ts) {
        ST.raf = 0;
        if (!_byId('wd_root') || (typeof document !== 'undefined' && document.hidden) || !ST.playing || !ST.sim) { if (ST.playing && !_byId('wd_root')) ST.playing = false; return; }
        var sim = ST.sim, S = sim.state;
        var dw = ST.lastTs == null ? 0 : Math.max(0, Math.min(100, ts - ST.lastTs));
        ST.lastTs = ts;
        ST.target += ST.speed * dw / 1000;
        if (ST.target > ST.endT) ST.target = ST.endT;
        var r = null;
        if (ST.target > S.t + 1e-9) {
            try { r = sim.run(ST.target - S.t, { maxWallMs: 10 }); } catch (e) { if (typeof console !== 'undefined') console.error('[welldyn] run', e); r = { ok: false, code: 'ENGINE_ERROR' }; }
        }
        if (ST.target > S.t + ST.speed * 0.1) ST.target = S.t + ST.speed * 0.1;          // the target may not run away after a wall-limited frame
        // achieved speed: simulated / wall over the last second
        var a = ST.ach;
        if (a.t0 == null) { a.t0 = ts; a.s0 = S.t; }
        else if (ts - a.t0 >= 1000) { a.val = (S.t - a.s0) / ((ts - a.t0) / 1000); a.t0 = ts; a.s0 = S.t; }
        ST.frameN++;
        _drawLive(dw / 1000);
        if (ST.frameN % 6 === 0) { _renderKpis(); _renderTimeline(); _renderChart(); }
        if (r && r.ok === false) { ST.note = 'The run stopped: ' + (r.code || 'engine error') + '.'; _pause('error'); return; }
        if (S.t >= ST.endT - 1e-9) { _pause('end'); return; }
        _req();
    }

    // ── controls → events (WD-D8) ─────────────────────────────────────────────
    function _act(fn) { if (!ST.sim && !_build('control')) { _renderAll(); return null; } var r = fn(ST.sim); _renderAll(); return r; }
    function _shutToggle() {
        return _act(function (sim) {
            ST.openCmd = !ST.openCmd;
            return ST.openCmd ? sim.open() : sim.shutIn();
        });
    }
    function _beanApply() { var b = parseFloat(_val('wd_bean')); if (!_fin(b)) return null; return _act(function (sim) { return sim.setChoke(b); }); }
    function _psepApply() { var p = _canon(function () { return _numv('wd_psep'); }); if (!_fin(p)) return null; return _act(function (sim) { return sim.setSeparator(p); }); }
    function _foamApply(on) { var ppm = _numv('wd_foam') || 0; return _act(function (sim) { return sim.setFoamer({ on: !!on && ppm > 0, ppm: ppm, injMd: null }); }); }
    function _liftApply() {
        var M = ST.M; if (!M) return null;
        if (M.lift.type === 'esp') { var hz = _numv('wd_hz'), rp = _numv('wd_ramp'); return _act(function (sim) { return sim.setLift({ type: 'esp', on: _fin(hz) && hz > 0, freq: hz || 0, ramp_Hz_s: _fin(rp) && rp > 0 ? rp : 1 }); }); }
        if (M.lift.type === 'gaslift') { var q = _canon(function () { return _numv('wd_glq'); }); return _act(function (sim) { return sim.setLift({ type: 'gaslift', qinj_Mscfd: q || 0, mode: 'valves' }); }); }
        return null;
    }
    // WD4: an intermittent programme started now (timer or pressure trigger) or stopped (mode off)
    function _cycleApply(off) {
        var a = off ? { mode: 'off' } : _canon(function () {
            return { mode: _val('wd_cyc_mode') === 'pressure' ? 'pressure' : 'timer', open_h: _numv('wd_cyc_open'), shut_h: _numv('wd_cyc_shut'), cycles: _numv('wd_cyc_n'),
                pOpen_psig: _numv('wd_cyc_pon'), pClose_psig: _numv('wd_cyc_poff'), qClose_Mscfd: _numv('wd_cyc_qoff'), minOpen_h: _numv('wd_cyc_minon'), minShut_h: _numv('wd_cyc_minoff') };
        });
        return _act(function (sim) { return sim.schedule([{ t: sim.state.t, type: 'cycle', args: a, src: 'user' }]); });
    }
    // the lift rows (label, value in display units) and the valve table of the simulator shown — the Lift status box and the report
    function _liftRows(s) {
        var S = s && s.state, L = S && S.lift, rows = [], M = (s && s.M) || ST.M, lift = M && M.lift ? M.lift.type : 'none', tbl = '';
        var rr = function (l, v) { rows.push([l, v]); };
        if (!S) return { rows: rows, tbl: tbl, none: true };
        if (L && L.gl) {
            var g = L.gl;
            rr('Gas lift', g.mode === 'nodal' ? 'nodal injection point, ' + _u(g.injMd, 'length', 0, 'ft') + ' MD' : 'installed valves (annulus to ' + _u(g.packerMd, 'length', 0, 'ft') + ' MD)');
            rr('Casing pressure / lift gas', _u(g.pcs_psig, 'pressureG', 0, 'psig') + ' / ' + _u(g.qinj, 'gasRateSmall', 0, 'Mscf/d'));
            if (g.mode !== 'nodal') {
                rr('Annulus liquid', _u(g.annLiq_bbl, 'volume', 1, 'bbl') + ' · top ' + _u(g.liqTopMd, 'length', 0, 'ft') + ' MD');
                rr('Operating valve', g.opValve ? 'valve ' + g.opValve + (g.multi ? ' (more than one valve passing)' : '') : 'none passing gas');
                tbl = '<div class="wd-tw"><table class="dtable"><thead><tr><th>Valve</th><th>MD</th><th>State</th><th>Passing</th><th>Rate</th><th>Casing</th><th>Tubing</th><th>Opens at</th></tr></thead><tbody>' +
                    (g.valves || []).map(function (v) {
                        return '<tr><td>' + v.n + (v.kind !== 'ipo' ? ' (' + _esc(v.kind) + ')' : '') + '</td><td>' + _u(v.md, 'length', 0, 'ft') + '</td><td>' + (v.open ? 'open' : 'closed') + '</td><td>' + _esc(v.passing || '—') + '</td><td>' +
                            (v.passing === 'gas' ? _u(v.q, 'gasRateSmall', 0, 'Mscf/d') : v.passing === 'liquid' ? _u(v.q, 'liquidRate', 0, 'bbl/d') : '—') + '</td><td>' + _u(v.pc_psig, 'pressureG', 0, 'psig') + '</td><td>' + _u(v.pt_psig, 'pressureG', 0, 'psig') + '</td><td>' + _u(v.pvo_psig, 'pressureG', 0, 'psig') + '</td></tr>';
                    }).join('') + '</tbody></table></div>';
            }
        }
        if (L && L.esp) {
            var e = L.esp;
            rr('ESP frequency', _fmt(e.freq, 1) + ' Hz (command ' + _fmt(e.fCmd, 1) + ' Hz)' + (e.tripped ? ' · tripped: ' + e.tripped : ''));
            rr('Intake / discharge', _u(e.pint, 'pressure', 0, 'psia') + ' / ' + _u(e.pdis, 'pressure', 0, 'psia') + ' · rise ' + _u(e.dp, 'pressure', 0, 'psi'));
            rr('Motor load / intake gas', _fmt(100 * (e.load || 0), 0) + ' %' + (e.motorAssumed ? ' (motor power assumed)' : '') + ' / ' + _fmt(100 * (e.gvf || 0), 1) + ' %' + (e.vent_Mscfd > 0 ? ' · vented ' + _u(e.vent_Mscfd, 'gasRateSmall', 0, 'Mscf/d') : ''));
        }
        if (S.foamer && (S.foamer.on || S.foamer.dosed_lbm > 0)) rr('Foamer', (S.foamer.on ? _fmt(S.foamer.ppm, 0) + ' ppm' : 'off') + ' · at the end of the tubing ' + _fmt(S.foamer.cBottom_ppm || 0, 0) + ' ppm, surface-tension factor ' + _fmt(_fin(S.foamer.eff) ? S.foamer.eff : 1, 2));
        if (L && L.cycle && L.cycle.mode && L.cycle.mode !== 'off') {
            var c = L.cycle, last = c.hist && c.hist.length ? c.hist[c.hist.length - 1] : null;
            rr('Intermittent (' + (c.mode === 'pressure' ? 'by pressure' : 'timer') + ')', 'cycle ' + c.n + ', ' + (c.phase === 'open' ? 'open' : 'shut in') + (c.next ? ' · next ' + (c.next.type === 'open' ? 'open' : 'shut-in') + ' at ' + _hms(c.next.t) : ''));
            if (last) rr('Last cycle', _u(last.liq_bbl, 'volume', 1, 'bbl') + ' liquid produced · ' + _u(last.removed_bbl, 'volume', 1, 'bbl') + ' removed from the tubing · ' + _fmt(last.gas_Mscf, 0) + ' Mscf gas');
        }
        if (L && L.heading) rr('Heading check', L.heading.heading ? 'heading: ' + L.heading.pairs + ' THP peak pairs, period ' + _fmt((L.heading.period_s || 0) / 60, 0) + ' min' : 'no heading (' + (L.heading.pairs || 0) + ' peak pairs in ' + _hmin(Math.min(Math.max(0, S.t - (_fin(S.tOpen) ? S.tOpen : 0)), 10800)) + ')');
        return { rows: rows, tbl: tbl, lift: lift };
    }
    function _renderLift() {
        var h = _byId('wd_liftstat'); if (!h) return;
        var r = _liftRows(_vsim());
        if (r.none) { h.innerHTML = '<div class="rbox-title">Lift status</div><div class="wd-hint">Press Play or Step: the lift state appears with the run.</div>'; return; }
        if (!r.rows.length) r.rows.push(['Lift', r.lift === 'none' ? 'natural flow — add foamer or an intermittent programme below' : '—']);
        h.innerHTML = '<div class="rbox-title">Lift status</div>' + r.rows.map(function (x) { return '<div class="rrow"><span class="rl">' + _esc(x[0]) + '</span><span class="rv">' + _esc(x[1]) + '</span></div>'; }).join('') + r.tbl;
    }
    function _stepOnce() {
        if (!ST.sim && !_build('step')) { _renderAll(); return null; }
        if (ST.playing) _pause('step');
        ST.scrubT = null;
        var r; try { r = ST.sim.step(); } catch (e) { r = { ok: false, code: 'ENGINE_ERROR' }; }
        ST.target = ST.sim.state.t;
        _renderAll();
        return r;
    }
    function _setSpeed(v) {
        v = +v; if (SPEEDS.indexOf(v) === -1) v = DEF_SPEED;
        ST.speed = v; _pref('speed', v);
        var s = _byId('wd_speed'); if (s && String(s.value) !== String(v)) s.value = String(v);
        _renderKpis();
    }
    function _speedStep(d) { var i = SPEEDS.indexOf(ST.speed); i = Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + d)); _setSpeed(SPEEDS[i]); }

    // ── timeline, scrub, continue, marks ──────────────────────────────────────
    function _span() { return ST.rec ? ST.rec.span() : [0, 0]; }
    function _curT() { return ST.scrubT !== null ? ST.scrubT : (ST.sim ? ST.sim.state.t : 0); }
    function _scrub(t) {
        if (!ST.rec || !ST.rec.count()) return;
        if (ST.playing) _pause('scrub');
        var sp = _span(); t = Math.max(sp[0], Math.min(sp[1], t));
        ST.scrubT = (ST.sim && Math.abs(t - ST.sim.state.t) < 1e-6 && !ST.run) ? null : t;
        _renderAll();
    }
    function _cont() {
        if (ST.scrubT === null || !ST.rec) return { ok: false, code: 'LIVE' };
        var sn = ST.rec.snapAt(ST.scrubT);
        if (!sn) { ST.note = 'No snapshot at or before this moment: the recording can be viewed, not continued.'; _renderAll(); return { ok: false, code: 'NO_SNAPSHOT' }; }
        var later = _span()[1] > sn.t + 1e-6;
        if (later && typeof G.confirm === 'function' && !G.confirm('Continue from ' + _hms(sn.t) + '? The recording after this moment is discarded.')) return { ok: false, code: 'CANCELLED' };
        if (ST.run && !ST.sim) {                                       // a replay file: build its own simulator from the file's model
            var M = _modelFromFile(ST.run.model), E = _E();
            if (!M || !E) return { ok: false, code: 'MISSING_ENGINE' };
            var o = _clone(ST.run.settings) || {};                   // the same options → the same model hash → the snapshot restores
            var sim = E.create(M, o);
            if (!sim || sim.ok === false) { ST.note = _refusal(sim && sim.code, sim); _renderAll(); return { ok: false, code: sim && sim.code }; }
            ST.sim = sim; ST.M = M; sim.on('state', _onState);
        }
        var r = ST.sim.restore(sn);
        if (!r || !r.ok) {
            ST.note = r && r.code === 'MODEL_MISMATCH' ? 'This snapshot belongs to another model or settings: Continue is not possible.' : 'The snapshot could not be restored (' + (r && r.code) + ').';
            _renderAll(); return r || { ok: false };
        }
        ST.rec.truncate(sn.t);
        ST.rec.attach(ST.sim);
        ST.scrubT = null; ST.target = sn.t; ST.ended = false; ST.endT = Math.max(ST.endT, sn.t + 60);
        ST.openCmd = !!ST.sim.state.open;
        if (ST.run) ST.runNote = 'Continued from the replay file at ' + _hms(sn.t) + '.';
        _mountViews();
        _renderAll();
        return { ok: true, t: sn.t };
    }
    function _mark() {
        if (!ST.rec) return null;
        var t = _curT();
        if (ST.markStart === null) { ST.markStart = t; _syncToolbar(); return { started: t }; }
        var t0 = ST.markStart; ST.markStart = null;
        var id = ST.rec.mark(t0, t, 'Mark ' + (ST.rec.marks().length + 1));
        _syncToolbar(); _renderTimeline(); _renderChart();
        return { id: id };
    }

    // ── presets (§6.1) ────────────────────────────────────────────────────────
    function _beans(M) { var b = (M && M.surface && M.surface.beans && M.surface.beans.length) ? M.surface.beans.slice() : [16, 20, 24, 32, 40, 48]; return b.sort(function (x, y) { return x - y; }); }
    function _setCtl(id, v) {
        var e = _byId(id); if (!e) return;
        if (e.type === 'checkbox') e.checked = !!v; else e.value = String(v == null ? '' : v);
    }
    function _preset(key) {
        var M = ST.M || _read(), gas = _isGas(M), b0 = (M && M.surface.choke.bean64) || 32, beans = _beans(M), H = 3600, ev = [], set = {};
        set.wd_start = 'steady'; set.wd_fallback = false; set.wd_resmode = 'ipr'; set.wd_prior = 'auto';
        var note = '';
        switch (key) {
            case 'beanup':
                var lo = beans.filter(function (b) { return b < b0; }), b1 = lo.length ? lo[Math.max(0, lo.length - 2)] : Math.max(8, b0 / 2), b2 = lo.length ? lo[lo.length - 1] : (b1 + b0) / 2;
                ev = [{ t: 0, type: 'bean', args: { bean64: b1 } }, { t: 1 * H, type: 'bean', args: { bean64: b2 } }, { t: 2 * H, type: 'bean', args: { bean64: b0 } }];
                set.wd_dur = 4; break;
            case 'shutin':
                ev = [{ t: 2 * H, type: 'shutin', args: {} }]; set.wd_dur = 10;
                var miss = _resComplete(_settings().reservoir);
                if (!miss.length) { set.wd_resmode = 'transient'; set.wd_prior = 'steady'; }
                else note = 'Transient reservoir needs ' + miss.join(', ') + ' (Scenario → Reservoir): the build-up uses the IPR until they are entered.';
                break;
            case 'gasload':
                set.wd_fallback = true;
                var half = beans.filter(function (b) { return b <= b0 / 2; }); ev = [{ t: 1 * H, type: 'bean', args: { bean64: half.length ? half[half.length - 1] : Math.max(8, Math.round(b0 / 2)) } }];
                set.wd_dur = 8; if (!gas) note = 'This preset is meant for a gas well.'; break;
            case 'foamer':
                set.wd_fallback = true; ev = [{ t: 4 * H, type: 'foamer', args: { on: true, ppm: 1000, injMd: null } }]; set.wd_dur = 10;
                if (!gas) note = 'This preset is meant for a gas well.'; break;
            case 'cycle':
                ev = [{ t: 0, type: 'cycle', args: { mode: 'timer', open_h: 2, shut_h: 2, cycles: 3 } }]; set.wd_dur = 12; break;
            case 'glunload':
                // WD4: killed to the static water level of the reservoir pressure (a column above it drains into the formation), opened with
                // the lift gas on from t = 0 (WTS_wd_lift.balanceLevel)
                var LFT = G.WTS_wd_lift, bl = LFT && typeof LFT.balanceLevel === 'function' && M ? LFT.balanceLevel(M) : null;
                set.wd_start = 'static'; set.wd_static = bl ? 'level' : 'liquid'; set.wd_liquid = 'water'; set.wd_prior = 'none'; if (bl) set.wd_level = Math.round(_dv(bl.md, 'length'));   // the tagged input shows display units
                var q = M && M.lift.gl && M.lift.gl.qinj_Mscfd ? M.lift.gl.qinj_Mscfd : 600;
                ev = [{ t: 0, type: 'open', args: {} }, { t: 0, type: 'gl', args: { qinj_Mscfd: q, mode: 'valves' } }]; set.wd_dur = 12;
                if (!M || M.lift.type !== 'gaslift') note = 'Set gas lift in Well Performance step ④ first.'; break;
            case 'espstart':
                set.wd_start = 'static'; set.wd_static = 'liquid'; set.wd_liquid = 'water'; set.wd_prior = 'none';
                ev = [{ t: 0, type: 'open', args: {} }, { t: 0, type: 'esp', args: { on: true, freq: M && M.lift.esp && M.lift.esp.freq ? M.lift.esp.freq : 60, ramp_Hz_s: 1 } }]; set.wd_dur = 2;
                if (!M || M.lift.type !== 'esp') note = 'Set an ESP in Well Performance step ④ first.'; break;
            default:
                key = 'steady'; set.wd_dur = 2;
        }
        Object.keys(set).forEach(function (id) { _setCtl(id, set[id]); });
        _setCtl('wd_preset', key);
        ST.events = ev.map(function (e) { e.src = 'scenario'; return e; });
        ST.note = note;
        _syncScenario();
        var C = G.WTS_wd_cases; if (C && typeof C.setRes === 'function' && G.WTS_wp_model && G.WTS_wp_model.TABLE_KEYS && G.WTS_wp_model.TABLE_KEYS.indexOf('dyn') !== -1) { try { C.setRes(undefined, key); } catch (e) { /* ignore */ } }
        _build('preset');
        _renderAll();
        return { ok: true, key: key, events: _clone(ST.events), note: note };
    }

    // ── CSV, replay file, cases ───────────────────────────────────────────────
    function _download(text, name, type) {
        try {
            var blob = new Blob([text], { type: type }), a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = name; a.click();
            if (URL.revokeObjectURL) URL.revokeObjectURL(a.href);
            return true;
        } catch (e) { return false; }
    }
    function _fname(ext) { return 'well_dynamics_' + _wellName().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) + '_' + new Date().toISOString().slice(0, 10) + ext; }
    function _csvOpts() {
        var cols = [];
        Array.prototype.forEach.call((typeof document !== 'undefined' && document.querySelectorAll) ? document.querySelectorAll('#wd_csvcols input[data-col]') : [], function (c) { if (c.checked) cols.push(c.getAttribute('data-col')); });
        var from = _numv('wd_csv_from'), to = _numv('wd_csv_to'), ev = _numv('wd_csv_every');
        return { cols: cols.length ? cols : null, from: _fin(from) ? from * 3600 : null, to: _fin(to) ? to * 3600 : null, every_s: _fin(ev) && ev > 0 ? ev : null,
            system: _val('wd_csv_sys') === 'metric' ? 'metric' : 'field', decimalComma: _decComma(), hms: true, stateNames: true,
            title: 'Well Dynamics — ' + _wellName() + ' — ' + new Date().toISOString().slice(0, 16).replace('T', ' ') };
    }
    function _csv(o, download) {
        if (!ST.rec || !ST.rec.count()) return '';
        var co = Object.assign(_csvOpts(), o || {});
        if (co.cols) _pref('cols', co.cols.join(','));
        var s = ST.rec.csv(co);
        ST.lastCsv = s;
        if (download !== false) _download(s, _fname('.csv'), 'text/csv');
        return s;
    }
    function _runFile(download) {
        if (!ST.rec || !ST.rec.count()) return null;
        // §3.7: settings = the create options (their scenario events included); events = the applied log
        var set = ST.run ? _clone(ST.run.settings) : (_clone(ST.createOpts) || _optsOf(_settings()));
        var meta = { model: ST.run ? _clone(ST.run.model) : _modelForFile(), settings: set, events: ST.rec.events(), well: { name: ST.run ? ST.run.well.name : _wellName() },
            engine: ST.sim && ST.sim.version, summary: _summary() };
        var RC = _REC(), run = ST.rec.toFile(meta);
        ST.lastRun = run;
        if (download !== false) _download(JSON.stringify(run), _fname(RC ? RC.EXT : '.wdrun'), 'application/json');
        return run;
    }
    function _load(src) {
        var RC = _REC(); if (!RC) return { ok: false, code: 'MISSING_ENGINE' };
        var r = RC.fromFile(src);
        if (!r.ok) { ST.note = 'The replay file could not be opened: ' + (r.errors && r.errors[0] || r.code) + '.'; _renderAll(); return r; }
        _dispose();
        ST.run = r.run; ST.rec = r.rec; ST.err = null;
        var sp = r.rec.span(); ST.scrubT = sp[1];
        ST.endT = Math.max(sp[1], r.run.duration_s || 0);
        ST.runNote = 'Replay of "' + r.run.well.name + '" (' + _hmin(sp[1] - sp[0]) + ', recorded ' + String(r.run.created || '').slice(0, 10) + '). The stored well model is not changed.' +
            (r.warnings.length ? ' ' + r.warnings.map(function (w) { return w.msg; }).join(' ') : '');
        ST.runWarnings = r.warnings;
        // the grid for the wellbore comes from a simulator of the file's model (no run); without an engine the recording still plays
        var M = _modelFromFile(r.run.model), E = _E();
        if (M && E) {
            var o = _clone(r.run.settings) || {}; o.events = [];
            try { var s = E.create(M, o); if (s && s.ok !== false) { ST.viewSim = s; ST.M = M; } } catch (e) { /* ignore */ }
        }
        _mountViews();
        _renderAll();
        return r;
    }
    // the replay re-run (R25): a fresh simulator of the file's model and settings replays the file's events; compared at the samples
    function _rerun(maxWallMs) {
        if (!ST.run) return { ok: false, code: 'NO_RUN' };
        var M = _modelFromFile(ST.run.model), E = _E(), RC = _REC();
        if (!M || !E || !RC) return { ok: false, code: 'MISSING_ENGINE' };
        var o = _clone(ST.run.settings) || {};
        // the scenario events of the settings plus the interactive ones of the log (controller events are re-made by the engine)
        o.events = (Array.isArray(o.events) ? o.events : []).concat((ST.run.events || []).filter(function (e) { return e && e.src === 'user'; }));
        var sim = E.create(M, o); if (!sim || sim.ok === false) return { ok: false, code: sim && sim.code };
        var rec = RC.create({ every_s: ST.rec.every_s, snapEvery_s: 1e9 }); rec.attach(sim);
        var dur = ST.run.duration_s || _span()[1], w0 = _now();
        var r = sim.run(dur - sim.state.t, { maxWallMs: _fin(maxWallMs) ? maxWallMs : 15000 });
        var cmp = RC.compare(ST.rec, rec, {});
        var sameEngine = !ST.run.engineId || ST.run.engineId === RC.engineId();
        var full = sim.state.t >= dur - 1e-6;
        var msg;
        if (cmp.identical && sameEngine) msg = 'Re-run: identical to the recording' + (full ? '.' : ' up to ' + _hms(sim.state.t) + ' (stopped there).');
        else if (cmp.ok) msg = 'Re-run: equal to the recording within 0.5 % in rates and 1 psi in pressures' + (sameEngine ? '' : ' (made with a different JavaScript engine)') + (full ? '.' : ' up to ' + _hms(sim.state.t) + '.');
        else msg = sameEngine ? 'Re-run: the re-run differs from the recording after ' + _hms(cmp.firstDiff_t) + ' (the model or the engine version changed).'
            : 'Made with a different JavaScript engine: the re-run differs from the recording after ' + _hms(cmp.firstDiff_t) + '.';
        ST.runNote = msg;
        rec.detach(); if (sim.dispose) sim.dispose();
        _renderAll();
        return { ok: true, cmp: cmp, msg: msg, sameEngine: sameEngine, wallMs: _now() - w0, complete: full, stopped: r && r.stopped };
    }
    function _cases() { var C = G.WTS_wd_cases; return (C && typeof C.list === 'function') ? C.list(_read()) : []; }
    function _caseSave(name) {
        var C = G.WTS_wd_cases; if (!C) return { ok: false, code: 'MISSING_ENGINE' };
        var set = _settings(), raw = {};
        Object.keys(DEFS).forEach(function (id) { raw[id] = _val(id); });
        var c = C.make({ name: name != null ? name : _val('wd_case_name'), settings: { opts: _optsOf(set), controls: raw }, events: _clone(ST.events) || [], duration_s: set.duration_s,
            summary: _hasData() ? _summary() : null, note: '' });
        var r = C.save(c);
        if (r && r.ok) { ST.note = 'Case "' + (c.name || 'unnamed') + '" saved with this well' + (r.dropped && r.dropped.length ? ' (' + r.dropped.length + ' older case(s) dropped to stay within 20 cases / 24 kB)' : '') + '.'; _setCtl('wd_case_name', ''); }
        else ST.note = 'The case was not saved: ' + ((r && r.errors && r.errors[0]) || (r && r.code) || 'unknown') + '.';
        _renderCases(); _renderNote();
        return r;
    }
    function _caseLoad(id) {
        var c = _cases().filter(function (x) { return x.id === id; })[0]; if (!c) return { ok: false, code: 'NOT_FOUND' };
        var ctl = c.settings && c.settings.controls;
        if (_isObj(ctl)) Object.keys(ctl).forEach(function (k) { if (k in DEFS) _setCtl(k, ctl[k]); });
        ST.events = _clone(c.events) || [];
        _syncScenario();
        _build('case');
        ST.note = 'Case "' + (c.name || 'unnamed') + '" loaded: press Play.';
        _renderAll();
        return { ok: true };
    }
    function _caseRemove(id) {
        var C = G.WTS_wd_cases; if (!C) return { ok: false };
        var c = _cases().filter(function (x) { return x.id === id; })[0];
        if (c && typeof G.confirm === 'function' && !G.confirm('Delete the case "' + (c.name || 'unnamed') + '"?')) return { ok: false, code: 'CANCELLED' };
        var r = C.remove(id); _renderCases(); return r;
    }
    function _summary() {
        var RC = _REC(); if (!RC || !ST.rec || !ST.rec.count()) return null;
        try { return RC.summarize(ST.rec, ST.sim || ST.viewSim || null); } catch (e) { return null; }
    }
    function _importPrism() {
        var W = typeof G.PRiSM_getWell === 'function' ? G.PRiSM_getWell() : null, F = typeof G.PRiSM_getLastFit === 'function' ? G.PRiSM_getLastFit() : null;
        if (!W && !F) { ST.note = 'PRiSM has no well inputs or fit to import.'; _renderNote(); return { ok: false }; }
        var map = { mu: W && W.mu, B: W && W.B, ct: W && W.ct, h: W && W.h, phi: W && W.phi, rw: W && W.rw, k: F && F.phys && F.phys.k, S: F && F.phys && F.phys.S };
        var n = 0; Object.keys(map).forEach(function (k) { if (_fin(map[k])) { _setCtl('wd_' + k, map[k]); n++; } });
        _resWrite('prism');
        ST.note = n ? 'Imported ' + n + ' reservoir value(s) from PRiSM.' : 'PRiSM has no reservoir values to import.';
        _onSettings();
        return { ok: n > 0, n: n };
    }
    function _resWrite(src) {
        var C = G.WTS_wd_cases, Wm = G.WTS_wp_model;
        if (!C || typeof C.setRes !== 'function' || !Wm || !Wm.TABLE_KEYS || Wm.TABLE_KEYS.indexOf('dyn') === -1) return;
        var r = _settings().reservoir, o = { source: src || 'user' };
        ['k', 'h', 'phi', 'ct', 'mu', 'B', 'rw', 're', 'S'].forEach(function (k) { o[k] = _fin(r[k]) ? r[k] : null; });
        try { C.setRes(o); } catch (e) { /* ignore */ }
    }

    // ── views ────────────────────────────────────────────────────────────────
    function _vsim() { return ST.sim || ST.viewSim || null; }
    function _mountViews() {
        var V = _V(), s = _vsim();
        if (ST.wb && ST.wb.destroy) { try { ST.wb.destroy(); } catch (e) { /* ignore */ } }
        if (ST.nav && ST.nav.destroy) { try { ST.nav.destroy(); } catch (e) { /* ignore */ } }
        ST.wb = null; ST.nav = null;
        var cv = _byId('wd_cv_well'), nv = _byId('wd_cv_nav');
        if (!V || !s || !s.grid || !cv) return;
        var M = s.M || ST.M;
        try {
            ST.wb = V.wellbore(cv, { grid: s.grid, traj: s.grid.traj, strings: M && M.well ? M.well.strings : [], layer: ST.layer, exaggerate: 25, aspect: 'true', labels: true,
                particles: { on: true, max: 300 }, reduced: _reduced(), liquid: _isGas(M) ? 'condensate' : 'oil', w: _phone() ? 240 : 360, h: _phone() ? 360 : 480,
                onHover: function (info) { _hover(info); }, onSelect: function (i) { _select(i); }, onZoom: function (a, b) { if (ST.nav && ST.nav.setWindow) ST.nav.setWindow(a, b); } });
            if (nv && V.navigator) ST.nav = V.navigator(nv, { grid: s.grid, traj: s.grid.traj, w: _phone() ? 56 : 72, h: _phone() ? 360 : 480, onWindow: function (a, b) { if (ST.wb && ST.wb.setZoom) ST.wb.setZoom(a, b); } });
        } catch (e) { if (typeof console !== 'undefined') console.error('[welldyn] view', e); ST.wb = null; }
    }
    function _markers(s) {
        var g = s && s.grid, M = s && s.M, out = [];
        if (!g) return out;
        if (M && _fin(M.well.midPerfMd)) out.push({ md: M.well.midPerfMd, kind: 'perf', label: 'perforations' });
        if (g.cells && g.cells[g.eotCell]) out.push({ md: g.cells[g.eotCell].md0, kind: 'eot', label: 'end of tubing' });
        (g.valveCells || []).forEach(function (v) { out.push({ md: v.md, kind: 'valve', label: 'valve ' + v.n }); });
        if (g.pumpFace >= 0 && g.faces && g.faces[g.pumpFace]) out.push({ md: g.faces[g.pumpFace].md, kind: 'pump', label: 'pump' });
        (g.gaugeCells || []).forEach(function (x) { out.push({ md: x.md, kind: 'gauge', label: 'gauge' }); });
        return out;
    }
    // the frame shown: live engine state, or a recorded moment (scrub) from the recorder's display copies
    function _frameData(dtWall) {
        var s = _vsim();
        if (ST.scrubT !== null && ST.rec) {
            var f = ST.rec.frameAt ? ST.rec.frameAt(ST.scrubT) : null;
            if (f) return { t: ST.scrubT, tFrame: f.t, cells: f.cells, faces: {}, markers: _markers(s), gasCapMd: f.gasCapMd, liquidTopMd: f.liquidTopMd, dtWall: 0, playing: false };
            return null;
        }
        if (!ST.sim) return null;
        var S = ST.sim.state, inv = S.inventory || {};
        return { t: S.t, cells: S.cells, faces: S.faces, markers: _markers(ST.sim), gasCapMd: S.open ? null : inv.gasCapBottomMd, liquidTopMd: inv.liquidTopMd, dtWall: dtWall || 0, playing: ST.playing };
    }
    function _drawLive(dtWall) {
        var fr = _frameData(dtWall);
        if (fr && ST.wb && ST.wb.draw) { try { ST.wb.draw(fr); } catch (e) { /* drawing never stops the run */ } }
        if (fr && ST.nav && ST.nav.draw) { try { ST.nav.draw(fr); } catch (e) { /* ignore */ } }
        var tr = _byId('wd_tread'); if (tr) tr.textContent = _hms(_curT());
    }
    function _hover(info) {
        var h = _byId('wd_hover'); if (!h) return;
        if (!info) { h.textContent = 'Hover the well for MD, TVD, pressure, temperature, holdups, velocities and the flow regime; click a cell for its close-up.'; return; }
        var lines = (ST.wb && ST.wb.infoLines) ? ST.wb.infoLines(info) : [];
        h.textContent = lines.length ? lines.join(' · ') : '';
    }
    function _select(i) {
        ST.closeInfo = (ST.wb && ST.wb.info) ? ST.wb.info(i) : { i: i };
        _setTab('close');
    }

    // ── rendering ────────────────────────────────────────────────────────────
    function _kpiHtml(label, val, sub, st) {
        return '<div class="kpi wd-kpi st-' + (st || 'none') + '" role="group" title="' + _esc(label + ': ' + val + (sub ? ' — ' + String(sub).replace(/\n/g, ' · ') : '')) + '" aria-label="' + _esc(label + ' ' + val) + '"><div class="kpi-l">' + _esc(label) + '</div><div class="kpi-v">' + _esc(val) + '</div>' +
            (sub ? '<div class="kpi-s">' + _esc(sub) + '</div>' : '') + '</div>';
    }
    function _stateInfo(key) {
        var E = _E(), s = E && E.STATES && E.STATES[key];
        var LBL = { stable: 'Stable', startup: 'Start-up', unloading: 'Unloading', marginal: 'Marginal', loading: 'Loading', heading: 'Heading', dying: 'Dying', dead: 'Dead', shutin: 'Shut in' };
        var lab = (s && s.label) || LBL[key] || (key ? String(key).replace(/_/g, ' ') : '—');
        var sev = (s && s.sev) || ({ stable: 'ok', dead: 'fail', loading: 'warn', marginal: 'warn', heading: 'warn', dying: 'warn' }[key]) || 'info';
        return { label: lab, st: sev === 'fail' ? 'fail' : sev === 'warn' ? 'warn' : sev === 'ok' ? 'ok' : 'info' };
    }
    function _vals() {
        // the values shown: the recorded moment when scrubbed (or a replay), else the live state through the recorder's channel map
        if (ST.rec && (ST.scrubT !== null || !ST.sim)) { var a = ST.rec.at(_curT()); return a.values; }
        if (ST.rec && ST.sim) { var b = ST.rec.at(ST.sim.state.t); if (ST.rec.count()) { var sp = ST.rec.span(); if (sp[1] >= ST.sim.state.t - 1e-6) return b.values; } }
        if (ST.sim) {
            var S = ST.sim.state, su = S.surface || {}, bo = S.bottom || {}, lo = S.loading || {}, inv = S.inventory || {}, li = S.lift || {};
            var E = _E(), so = (E && E.STATE_ORDER) || [];
            return { t: S.t, thp: su.thp_psig, pwf: bo.pwf, pr: bo.pr, qo: su.qo, qw: su.qw, qL: su.qL, qg: su.qg, qgForm: su.qgForm, lratio: lo.ratio, qc: lo.qc_MMscfd,
                qcVert: lo.qcVert_MMscfd, qcBelfroid: lo.qcBelfroid_MMscfd, liq: inv.liqTubing_bbl, state: so.indexOf(S.well && S.well.state), open: S.open ? 1 : 0, bean: S.bean64,
                pcs: li.gl ? li.gl.pcs_psig : NaN, pint: li.esp ? li.esp.pint : NaN, freq: li.esp ? li.esp.freq : NaN, qinj: su.qinj, gor: su.gor, wc: su.wc };
        }
        return null;
    }
    function _stateKey(v) {
        var E = _E(), RC = _REC(), so = (E && E.STATE_ORDER) || (RC && RC.STATE_ORDER_FALLBACK) || [];
        if (ST.scrubT === null && ST.sim && ST.sim.state.well) return ST.sim.state.well.state;
        return v && _fin(v.state) ? so[v.state] : null;
    }
    function _kpis() {
        var M = _vsim() ? (_vsim().M || ST.M) : ST.M, v = _vals(), gas = _isGas(M), out = [], rc = _rateCat(M);
        if (!v) return [{ l: 'Well state', v: ST.err ? 'Not running' : 'Paused', s: ST.err ? ST.err.code : 'press Play', st: ST.err ? 'fail' : 'none' }];
        var sk = _stateKey(v), si = _stateInfo(sk);
        var chk0 = !!(M && M.surface && M.surface.choke && M.surface.choke.present !== false);
        // review fix: no 'bean 0/64' on a well with no surface choke (gas lift / ESP examples)
        out.push({ l: 'Well state', v: si.label, s: (v.open === 0 ? 'choke closed' : (chk0 && _fin(v.bean) && v.bean > 0 ? 'bean ' + _fmt(v.bean, 0) + '/64' : 'no choke')), st: si.st });
        if (gas) out.push({ l: 'Gas rate', v: _u(v.qg, 'gasRateSmall', 0, 'Mscf/d'), s: _fin(v.qo) ? 'cond. ' + _u(v.qo, 'liquidRate', 0, 'STB/d') : '' });
        else out.push({ l: 'Liquid rate', v: _u(v.qL, 'liquidRate', 0, 'STB/d'), s: _fin(v.qo) ? 'oil ' + _u(v.qo, 'liquidRate', 0, 'STB/d') : '' });
        out.push({ l: 'THP', v: _u(v.thp, 'pressureG', 0, 'psig'), s: '' });
        out.push({ l: 'BHP', v: _u(v.pwf, 'pressure', 0, 'psia'), s: _fin(v.pr) ? 'p̄r ' + _u(v.pr, 'pressure', 0, 'psia') : '' });
        var lift = M && M.lift ? M.lift.type : 'none';
        if (lift === 'gaslift') out.push({ l: 'Casing pressure', v: _u(v.pcs, 'pressureG', 0, 'psig'), s: _fin(v.qinj) ? 'lift gas ' + _u(v.qinj, 'gasRateSmall', 0, 'Mscf/d') : '' });
        else if (lift === 'esp') out.push({ l: 'Pump intake', v: _u(v.pint, 'pressure', 0, 'psia'), s: _fin(v.freq) ? _fmt(v.freq, 1) + ' Hz' : '' });
        else if (gas) {
            var r = v.lratio, belf = !!_val('wd_belfroid');
            out.push({ l: 'Rate / critical rate', v: _fin(r) ? _fmt(r, 2) : '—', st: _fin(r) ? (r < 0.9 ? 'fail' : r < 1.1 ? 'warn' : 'ok') : 'none',
                s: 'q_c ' + _u(v.qcVert, 'gasRate', 2, 'MMscf/d') + ' vertical\n' + _u(v.qcBelfroid, 'gasRate', 2, 'MMscf/d') + ' Belfroid' + (belf ? ' (in use)' : '') });
        }
        out.push({ l: 'Liquid in the well', v: _u(v.liq, 'volume', 1, 'bbl'), s: '' });
        var ach = ST.ach && ST.ach.val, slow = ST.playing && _fin(ach) && ach < 0.8 * ST.speed;
        out.push({ l: 'Time', v: _hms(_curT()), s: ST.scrubT !== null ? 'recorded moment' : (ST.playing ? '×' + ST.speed + (_fin(ach) ? ' · achieved ×' + _fmt(ach, 0) : '') : 'paused · ×' + ST.speed),
            st: slow ? 'warn' : 'none' });
        if (slow) out[out.length - 1].s = 'running slower than ×' + ST.speed + ' (×' + _fmt(ach, 0) + ')';
        return out;
    }
    function _renderKpis() {
        _renderLift();
        var h = _byId('wd_kpis'); if (!h) return;
        h.innerHTML = _kpis().map(function (k) { return _kpiHtml(k.l, k.v, k.s, k.st); }).join('');
    }
    function _syncToolbar() {
        var p = _byId('wd_play');
        if (p) { p.textContent = ST.playing ? '❚❚ Pause' : '▶ Play'; p.setAttribute('aria-pressed', ST.playing ? 'true' : 'false'); p.disabled = !!(ST.run && !ST.sim); }
        var s = _byId('wd_shut'); if (s) { s.textContent = ST.openCmd ? 'Shut in' : 'Open'; s.disabled = !!(ST.run && !ST.sim); }
        var m = _byId('wd_mark'); if (m) { m.textContent = ST.markStart === null ? 'Mark' : 'End mark'; m.setAttribute('aria-pressed', ST.markStart === null ? 'false' : 'true'); }
        var st = _byId('wd_step'); if (st) st.disabled = !!(ST.run && !ST.sim);
        var M = ST.M, lift = M && M.lift ? M.lift.type : 'none';
        var gl = _byId('wd_lift_gl'), es = _byId('wd_lift_esp');
        if (gl) gl.style.display = lift === 'gaslift' ? '' : 'none';
        if (es) es.style.display = lift === 'esp' ? '' : 'none';
        var fo = _byId('wd_foam_w'); if (fo) fo.style.display = _isGas(M) ? '' : 'none';
        ['wd_ramp_w', 'wd_ramp_w0'].forEach(function (id) { var r = _byId(id); if (r) r.style.display = lift === 'esp' ? '' : 'none'; });
    }
    function _renderTimeline() {
        var sl = _byId('wd_scrub'), sp = _span(), t = _curT();
        if (sl) {
            var f = sp[1] > sp[0] ? (t - sp[0]) / (sp[1] - sp[0]) : 1;
            sl.value = String(Math.round(1000 * Math.max(0, Math.min(1, f))));
            sl.disabled = !(ST.rec && ST.rec.count() > 1);
            var sk = _stateKey(_vals());
            sl.setAttribute('aria-valuetext', _hmin(t) + (sk ? ' — ' + _stateInfo(sk).label.toLowerCase() : ''));
        }
        var rd = _byId('wd_tread'); if (rd) rd.textContent = _hms(t);
        var rng = _byId('wd_trange'); if (rng) rng.textContent = 'recorded ' + _hms(sp[0]) + ' – ' + _hms(sp[1]) + (ST.scrubT !== null ? ' · viewing a recorded moment' : '');
        var c = _byId('wd_cont'); if (c) c.style.display = (ST.scrubT !== null && ST.rec && ST.rec.snapAt(ST.scrubT) && (ST.sim || ST.run)) ? '' : 'none';
        var ml = _byId('wd_marks');
        if (ml) {
            var mk = ST.rec ? ST.rec.marks() : [];
            ml.innerHTML = mk.length ? mk.map(function (m) {
                return '<span class="wd-mk"><button type="button" class="wd-chip" data-act="gomark" data-id="' + _esc(m.id) + '">' + _esc(m.label) + ' ' + _hms(m.t0) + '–' + _hms(m.t1) + '</button>' +
                    '<button type="button" class="wd-x" data-act="csvmark" data-id="' + _esc(m.id) + '" aria-label="Export ' + _esc(m.label) + ' as CSV" title="Export as CSV">CSV</button>' +
                    '<button type="button" class="wd-x" data-act="unmark" data-id="' + _esc(m.id) + '" aria-label="Remove ' + _esc(m.label) + '" title="Remove">&#10005;</button></span>';
            }).join('') : '<span class="wd-hint">No marked windows. Press <b>Mark</b> (or M) at the start and at the end of a window.</span>';
        }
        var V = _V(), sc = _byId('wd_cv_strip');
        if (V && sc && ST.rec && V.stateStrip) { try { V.stateStrip(sc, ST.rec, { window: sp, cursor: t, onScrub: function (tt) { _scrub(tt); } }); } catch (e) { /* ignore */ } }
    }
    function _setTab(k) {
        if (!TABS.some(function (t) { return t[0] === k; })) k = 'rates';
        ST.tab = k; _pref('tab', k);
        Array.prototype.forEach.call(document.querySelectorAll('#wd_tabs [data-tab]'), function (b) { var on = b.getAttribute('data-tab') === k; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.setAttribute('tabindex', on ? '0' : '-1'); });
        var ts = _byId('wd_tabsel'); if (ts && ts.value !== k) ts.value = k;
        TABS.forEach(function (t) { var w = _byId('wd_cw_' + t[0]); if (w) w.style.display = t[0] === k ? '' : 'none'; });
        _renderChart();
    }
    function _trendKeys(tab, M) {
        var gas = _isGas(M), lift = M && M.lift ? M.lift.type : 'none';
        if (tab === 'rates') return gas ? ['qg', 'qgForm', 'qg_res', 'qo'] : ['qL', 'qo', 'qw', 'qo_res', 'qg'];
        if (tab === 'press') return ['thp', 'pwf', 'pr'].concat(lift === 'gaslift' ? ['pcs'] : lift === 'esp' ? ['pint'] : []);
        // WD4: one y axis per chart — channels of one magnitude (casing / tubing-head pressure with the lift-gas rate; the drive frequency)
        if (tab === 'lift') return lift === 'gaslift' ? ['pcs', 'thp', 'qinj'] : lift === 'esp' ? ['freq'] : (gas ? ['lratio', 'liq', 'foam'] : ['liq', 'gor']);
        return ['qL'];
    }
    function _renderChart(force) {
        var V = _V(), s = _vsim(), M = s ? (s.M || ST.M) : ST.M, k = ST.tab, cv = _byId('wd_cv_' + k), msg = _byId('wd_chartmsg');
        if (!cv) return;
        if (!V || !ST.rec) { if (msg) msg.textContent = !V ? 'The charts are not available in this build.' : 'Press Play to record the run.'; return; }
        if (msg) msg.textContent = '';
        var sp = _span(), t = _curT();
        try {
            if (k === 'rates' || k === 'press' || k === 'lift') V.trend(cv, ST.rec, { keys: _trendKeys(k, M), window: [sp[0], Math.max(sp[1], sp[0] + 60)], cursor: t, marks: ST.rec.marks(), onScrub: function (tt) { _scrub(tt); } });
            else if (k === 'nodal') {
                var R0 = s && s.R0, v = _vals() || {}, gas = R0 && R0.rates && R0.rates.basis === 'gas';
                var q = gas ? (ST.rec.at(t).values.qg_res) : ((ST.rec.at(t).values.qo_res || 0) + (ST.rec.at(t).values.qw_res || 0));
                if (ST.scrubT === null && _fin(q) && _fin(v.pwf)) { var last = ST.trail[ST.trail.length - 1]; if (!last || last[0] !== q || last[1] !== v.pwf) { ST.trail.push([q, v.pwf]); if (ST.trail.length > 120) ST.trail.shift(); } }
                V.nodal(cv, { curves: R0 && R0.curves ? R0.curves : null, op: R0 && R0.op ? { q: R0.op.q, p: R0.op.p } : null, live: _fin(q) && _fin(v.pwf) ? { q: q, p: v.pwf } : null, trail: ST.trail.slice(), gas: !!gas });
            }
            else if (k === 'whp') V.whpRate(cv, ST.rec, { gas: _isGas(M), qKey: _isGas(M) ? 'qg' : 'qL', cursor: t, op: s && s.R0 && s.R0.op ? { q: s.R0.op.q, thp_psig: s.R0.surface && s.R0.surface.thp_psig } : null });
            else if (k === 'depth') { var fr = _frameData(0); if (fr && s) V.depthLog(cv, fr, { grid: s.grid, track: 'pressure', markers: fr.markers }); }
            else if (k === 'close') {
                var info = ST.closeInfo || (ST.wb && ST.wb.info ? ST.wb.info(0) : null);
                if (info && V.closeUp) V.closeUp(cv, info, { reduced: _reduced() });
            }
        } catch (e) { if (msg) msg.textContent = 'The chart could not be drawn.'; if (typeof console !== 'undefined') console.error('[welldyn] chart', e); }
    }
    function _banner() {
        var b = _byId('wd_banner'); if (!b) return;
        var h = [];
        if (ST.err) h.push(_vOpen('fail') + '✗ ' + _esc(ST.err.msg) + (ST.err.code === 'NO_STEADY' ? ' <button type="button" class="btn btn-secondary" data-act="static">Start from a static well</button>' : '') +
            (ST.err.code === 'MODEL' || ST.err.code === 'NO_MODEL' ? ' <button type="button" class="btn btn-secondary" data-act="gowp">Open Well Performance</button>' : '') + '</div>');
        if (ST.modelStale) h.push(_vOpen('warn') + '⚠ The well model changed in Well Performance. <button type="button" class="btn btn-secondary" data-act="rebuild">Rebuild</button> (the recorded run is discarded)</div>');
        if (ST.settingsStale) h.push(_vOpen('warn') + '⚠ The scenario settings changed. <button type="button" class="btn btn-secondary" data-act="rebuild">Reset to apply</button> (the recorded run is discarded)</div>');
        if (ST.runNote) h.push(_vOpen('info') + 'ℹ ' + _esc(ST.runNote) + (ST.run ? ' <button type="button" class="btn btn-secondary" data-act="rerun">Re-run and compare</button> <button type="button" class="btn btn-secondary" data-act="closerun">Close the replay</button>' : '') + '</div>');
        b.innerHTML = h.join('');
    }
    var V_COL = { ok: 'green', warn: 'yellow', fail: 'red', info: 'text2' };
    function _vOpen(st) { return '<div class="wd-v ' + st + '" style="color:var(--' + (V_COL[st] || 'text2') + ')">'; }
    function _renderNote() { var n = _byId('wd_note'); if (n) n.textContent = ST.note || ''; }
    function _renderHeader() {
        var M = ST.run ? (_vsim() && _vsim().M) : ST.M, ms = _modelStatus(M);
        var h = _byId('wd_model');
        if (h) h.innerHTML = '<span class="wd-wn">' + _esc(ST.run ? ST.run.well.name : _wellName()) + '</span> · ' + _esc(_modelSummary(M)) + ' · ' +
            (ms.ok ? '<span class="wd-ok">✓ from Well Performance</span>' : '<span class="wd-bad">✗ set up in Well Performance</span>');
    }
    function _renderEvents() {
        var tb = _byId('wd_evbody'); if (!tb) return;
        var t = ST.sim ? ST.sim.state.t : 0, rows = [];
        var log = ST.rec ? ST.rec.events() : [];
        log.forEach(function (e) { rows.push('<tr class="ro"><td>' + _hms(e.t) + '</td><td>' + _esc(_evLabel(e)) + '</td><td>' + _esc(e.src || '') + '</td><td>applied</td></tr>'); });
        ST.events.forEach(function (e, i) {
            if (e.t < t - 1e-9 && ST.sim && t > 0) return;
            rows.push('<tr><td>' + _hms(e.t) + '</td><td>' + _esc(_evLabel(e)) + '</td><td>' + _esc(e.src || 'scenario') + '</td><td><button type="button" class="btn btn-secondary wd-x" data-act="evdel" data-i="' + i + '" aria-label="Delete event">&#10005;</button></td></tr>');
        });
        tb.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="4" class="wd-hint">No events: the well runs at its settings. Add events below or pick a preset.</td></tr>';
    }
    function _evLabel(e) {
        var a = e.args || {};
        switch (e.type) {
            case 'bean': return 'Bean ' + _fmt(a.bean64, 1) + '/64';
            case 'shutin': return 'Shut in';
            case 'open': return 'Open';
            case 'psep': return 'Separator ' + _u(a.psig, 'pressureG', 0, 'psig');
            case 'foamer': return a.on === false ? 'Foamer off' : 'Foamer ' + _fmt(a.ppm, 0) + ' ppm';
            case 'gl': return 'Lift gas ' + _u(a.qinj_Mscfd, 'gasRateSmall', 0, 'Mscf/d');
            case 'esp': return a.on === false ? 'ESP off' : 'ESP ' + _fmt(a.freq, 1) + ' Hz';
            case 'cycle': return 'Intermittent: ' + (a.mode === 'pressure' ? 'by pressure' : _fmt(a.open_h, 1) + ' h open / ' + _fmt(a.shut_h, 1) + ' h shut × ' + _fmt(a.cycles, 0));
            case 'mark': return 'Mark ' + String(a.label || '').slice(0, 40);
            case 'end': return 'End';
            default: return String(e.type || '').slice(0, 20);
        }
    }
    function _evAdd() {
        var th = _numv('wd_ev_t'), ty = _val('wd_ev_type'), v = _canon(function () { return _numv('wd_ev_v'); });
        if (!_fin(th) || th < 0) { ST.note = 'Enter the event time in hours (0 or more).'; _renderNote(); return null; }
        var t = th * 3600, now = ST.sim ? ST.sim.state.t : 0;
        if (ST.sim && t < now - 1e-9) { ST.note = 'Events in the past cannot be added: scrub back and continue from there, or add a later time.'; _renderNote(); return null; }
        var args = {};
        if (ty === 'bean') { if (!_fin(v)) { ST.note = 'Enter the bean in /64 in.'; _renderNote(); return null; } args.bean64 = v; }
        else if (ty === 'psep') { if (!_fin(v)) { ST.note = 'Enter the separator pressure.'; _renderNote(); return null; } args.psig = v; }
        else if (ty === 'foamer') args = { on: _fin(v) && v > 0, ppm: _fin(v) ? v : 0, injMd: null };
        else if (ty === 'gl') args = { qinj_Mscfd: _fin(v) ? v : 0, mode: 'valves' };
        else if (ty === 'esp') args = { on: _fin(v) && v > 0, freq: _fin(v) ? v : 0, ramp_Hz_s: 1 };
        var e = { t: t, type: ty, args: args, src: 'user' };
        ST.events.push(e); ST.events.sort(function (a, b) { return a.t - b.t; });
        if (ST.sim) ST.sim.schedule([e]);
        ST.note = '';
        _renderEvents(); _renderNote();
        return e;
    }
    function _renderCases() {
        var h = _byId('wd_cases'); if (!h) return;
        var Wm = G.WTS_wp_model, okKey = !!(Wm && Wm.TABLE_KEYS && Wm.TABLE_KEYS.indexOf('dyn') !== -1);
        var L = okKey ? _cases() : [];
        h.innerHTML = !okKey ? '<div class="wd-hint">Cases need the Well Dynamics key of the well model (not in this build).</div>' :
            (L.length ? '<div class="wd-tw"><table class="dtable wd-ct"><thead><tr><th>Case</th><th>Saved</th><th>Duration</th><th>End state</th><th></th></tr></thead><tbody>' + L.slice().reverse().map(function (c) {
                var es = c.summary && c.summary.endState ? _stateInfo(c.summary.endState).label : '—';
                return '<tr><td>' + _esc(c.name || 'Unnamed') + '</td><td>' + _esc(c.created || '') + '</td><td>' + _hmin(c.duration_s) + '</td><td>' + _esc(es) + '</td><td class="wd-nw">' +
                    '<button type="button" class="btn btn-secondary" data-act="caseload" data-id="' + _esc(c.id) + '">Load</button> ' +
                    '<button type="button" class="btn btn-secondary wd-x" data-act="casedel" data-id="' + _esc(c.id) + '" aria-label="Delete case ' + _esc(c.name || 'Unnamed') + '">&#10005;</button></td></tr>';
            }).join('') + '</tbody></table></div>' : '<div class="wd-hint">No saved cases for this well. A case keeps the scenario (start, reservoir, events) and the run summary; it travels with the well in the project file.</div>');
    }
    function _syncScenario() {
        var st = _val('wd_start'), sk = _val('wd_static'), rm = _val('wd_resmode');
        var a = _byId('wd_static_w'), b = _byId('wd_level_w'), c = _byId('wd_res_t'), d = _byId('wd_liq_w');
        if (a) a.style.display = st === 'static' ? '' : 'none';
        if (d) d.style.display = st === 'static' && sk !== 'gas' ? '' : 'none';
        if (b) b.style.display = st === 'static' && sk === 'level' ? '' : 'none';
        if (c) c.style.display = rm === 'transient' ? '' : 'none';
        var miss = _byId('wd_res_miss');
        if (miss) { var m = rm === 'transient' ? _resComplete(_settings().reservoir) : []; miss.textContent = m.length ? 'Needed for the transient reservoir: ' + m.join(', ') + '.' : ''; }
        _renderEvents();
    }
    function _verdicts(sum) {
        var out = [], s = _vsim();
        if (ST.err) out.push({ st: 'fail', t: '✗ ' + ST.err.msg });
        var gt = sum && sum.gate;
        if (gt && gt.nodal && _fin(gt.nodal.dq) && _fin(gt.nodal.dp)) {
            // the distance of the last 10-min means from the nodal operating point (review fix: not the drift between windows)
            var dq = gt.nodal.dq * 100, dp = gt.nodal.dp * 100, ok = !gt.changed && dq <= 2 && dp <= 1;
            out.push({ st: ok ? 'ok' : 'warn', t: (ok ? '✓ ' : '⚠ ') + 'Distance from the nodal operating point: rate ' + _fmt(dq, 2) + ' %, BHP ' + _fmt(dp, 2) + ' %' +
                (gt.changed ? ' (the run changed the well: not gated)' : ' (gate 2 % / 1 %)') });
        }
        if (gt && _fin(gt.dq) && _fin(gt.dp))
            out.push({ st: 'info', t: (gt.steady ? 'Settled' : 'Still changing') + ' — drift over the last 10 min: rate ' + _fmt(Math.abs(gt.dq) * 100, 2) + ' %, BHP ' + _u(Math.abs(gt.dp), 'pressure', 2, 'psi') });
        if (sum && _fin(sum.massErr)) out.push({ st: Math.abs(sum.massErr) < 1e-6 ? 'ok' : 'warn', t: (Math.abs(sum.massErr) < 1e-6 ? '✓ ' : '⚠ ') + 'Mass balance error ' + sum.massErr.toExponential(1) + ' (cumulative, relative)' });
        if (sum && sum.endState) { var si = _stateInfo(sum.endState); out.push({ st: si.st === 'fail' ? 'fail' : si.st === 'warn' ? 'warn' : 'ok', t: (si.st === 'fail' ? '✗ ' : si.st === 'warn' ? '⚠ ' : '✓ ') + 'Well state at the end: ' + si.label }); }
        if (s && s.mock) out.push({ st: 'warn', t: '⚠ Stand-in engine: not a simulation' });
        return out;
    }
    function _renderReport() {
        var h = _byId('wd_rsum'); if (!h) return;
        var sum = _summary(), s = _vsim(), M = s ? (s.M || ST.M) : ST.M, rc = _rateCat(M), set = ST.run ? (ST.run.settings || {}) : _settings();
        var rows = [];
        var rr = function (l, v) { rows.push('<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv">' + _esc(v) + '</span></div>'); };
        // inputs
        var ih = _byId('wd_rinp');
        if (ih) {
            var res = set.reservoir || {}, inp = [];
            var ir = function (l, v) { inp.push('<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv wd-rvt">' + _esc(v) + '</span></div>'); };
            ir('Well', (ST.run ? ST.run.well.name : _wellName()) + ' — ' + _modelSummary(M));
            ir('Start', set.start === 'static' ? 'static well (' + ((set.static && set.static.kind) || 'liquid') + ')' : 'steady flow at the nodal operating point');
            ir('Reservoir', res.mode === 'transient' ? 'transient (radial, superposition; prior ' + ((res.prior && res.prior.kind) || '—') + ')' : 'steady inflow (IPR)');
            ir('Closure / cells', (set.closure === 'driftflux' ? 'drift flux everywhere' : 'gradient correlation, drift flux at low velocity') + ' · ' + (set.cells || 60) + ' cells');
            ir('Options', [set.fallback ? 'liquid fallback' : null, set.loading && set.loading.belfroid ? 'Belfroid inclination correction' : null, set.temperature === 'relax' ? 'temperature relaxation' : 'frozen temperature', res.backflow === false ? 'no back-flow' : 'back-flow into the formation'].filter(Boolean).join(' · '));
            if (s && s.R0 && s.R0.op) ir('Nodal operating point', _u(s.R0.op.q, rc[0], 0, rc[1]) + ' at ' + _u(s.R0.op.p, 'pressure', 0, 'psia'));
            ih.innerHTML = '<div class="rbox-title">Inputs</div>' + inp.join('');
        }
        if (sum) {
            var gas = _isGas(M);
            rr('Duration', _hmin(sum.duration_s));
            rr('State at the end', sum.endState ? _stateInfo(sum.endState).label : '—');
            if (gas) rr('Gas rate at the end', _u(sum.qg, 'gasRateSmall', 0, 'Mscf/d') + (_fin(sum.qgForm) && Math.abs(sum.qgForm - sum.qg) > 0.5 ? ' (formation ' + _u(sum.qgForm, 'gasRateSmall', 0, 'Mscf/d') + ')' : ''));
            else rr('Oil / water at the end', _u(sum.qo, 'liquidRate', 0, 'STB/d') + ' / ' + _u(sum.qw, 'liquidRate', 0, 'STB/d'));
            rr('THP / BHP at the end', _u(sum.thp_psig, 'pressureG', 0, 'psig') + ' / ' + _u(sum.pwf, 'pressure', 0, 'psia'));
            rr('Rate range', _u(sum.qMin, rc[0], 0, rc[1]) + ' – ' + _u(sum.qMax, rc[0], 0, rc[1]));
            rr('Highest THP / BHP', _u(sum.thpMax_psig, 'pressureG', 0, 'psig') + ' / ' + _u(sum.pwfMax, 'pressure', 0, 'psia'));
            rr('Most liquid in the well', _u(sum.liqMax_bbl, 'volume', 1, 'bbl'));
            if (sum.tLoading_h > 0 || sum.tDead_h > 0) rr('Time loading / dead', _fmt(sum.tLoading_h, 2) + ' h / ' + _fmt(sum.tDead_h, 2) + ' h');
            rr('Cumulative oil / water / gas', _u(sum.cumO_STB, 'liquidVolume', 0, 'STB') + ' / ' + _u(sum.cumW_STB, 'liquidVolume', 0, 'STB') + ' / ' + _fmt(sum.cumG_MMscf, 3) + ' MMscf');
            _liftRows(s).rows.slice(0, 6).forEach(function (x) { rr(x[0], x[1]); });
            if (sum.buildup) rr('Build-up', 'p_ws ' + _u(sum.buildup.pws_end, 'pressure', 0, 'psia') + ' · dp/dln Δt ' + _u(sum.buildup.dpdlnDt, 'pressure', 1, 'psi') + (_fin(sum.buildup.k_est) ? ' · k ≈ ' + _fmt(sum.buildup.k_est, 1) + ' md' : ''));
        }
        h.innerHTML = '<div class="rbox-title">Run summary</div>' + (rows.length ? rows.join('') : '<div class="wd-hint">The summary appears once the run has data (press Play).</div>');
        var kc = _byId('wd_rkpi'); if (kc) kc.innerHTML = _kpis().slice(0, 6).map(function (k) { return _kpiHtml(k.l, k.v, k.s, k.st); }).join('');
        var stl = _byId('wd_rstates');
        if (stl) {
            var states = sum ? sum.states : [];
            stl.innerHTML = '<div class="rbox-title">State timeline</div>' + (states.length ? '<table class="dtable"><thead><tr><th>From</th><th>To</th><th>State</th></tr></thead><tbody>' +
                states.slice(-12).map(function (x) { return '<tr><td>' + _hms(x.from) + '</td><td>' + _hms(x.to) + '</td><td>' + _esc(_stateInfo(x.key).label) + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="wd-hint">—</div>');
        }
        var pv = _byId('wd_rprov');
        if (pv) {
            var pl = (sum && sum.provisional && sum.provisional.length) ? sum.provisional : (s && s.state && s.state.provisional) || [];
            pv.innerHTML = '<div class="rbox-title">Provisional methods in this run</div>' + (pl.length ? _vOpen('info') + '⚠ ' + _esc(pl.join(', ')) + ': ' + PROVISIONAL_TXT + '.</div>' : _vOpen('ok') + '✓ None active so far.</div>');
        }
        var vd = _byId('wd_rverd'); if (vd) { var vs = _verdicts(sum); vd.innerHTML = '<div class="rbox-title">Checks</div>' + (vs.length ? vs.map(function (v) { return _vOpen(v.st) + _esc(v.t) + '</div>'; }).join('') : '<div class="wd-hint">The checks appear once the run has data.</div>'); }
        var nb = _byId('wd_notesbox');
        if (nb) nb.innerHTML = '<b>Notes</b> ' + _esc('A time-stepping model of one well on the shared Well Performance model (fluid, inflow, survey, strings, choke, lift). ' +
            'A steady flowing run settles on the nodal operating point; the methods listed as provisional are labelled until they are verified. ' + (String(_val('wd_notes') || '').slice(0, 600)));
        _reportCanvases();
    }
    function _reportCanvases() {
        var V = _V(), s = _vsim();
        var cw = _byId('wd_cv_rwell'), ct = _byId('wd_cv_rtrend');
        if (!V || !s || !s.grid) return;
        var fr = _frameData(0);
        if (cw && fr) {
            try {
                // fixed report size (WD-D15: 360 × 480 CSS px); a phone draws it at 270 × 360
                var ph = _phone(), key = (ph ? 'p' : 'd');
                if (!ST.rwb || ST.rwb.__grid !== s.grid || ST.rwb.__key !== key) {
                    if (ST.rwb && ST.rwb.destroy) ST.rwb.destroy();
                    ST.rwb = V.wellbore(cw, { grid: s.grid, traj: s.grid.traj, strings: (s.M || ST.M).well.strings, layer: 'phase', exaggerate: 25, aspect: 'fit', labels: true, particles: { on: false, max: 0 }, reduced: true, liquid: _isGas(s.M || ST.M) ? 'condensate' : 'oil', w: ph ? 270 : 360, h: ph ? 360 : 480, fixed: true });
                }
                ST.rwb.__grid = s.grid; ST.rwb.__key = key;
                fr.playing = false; fr.dtWall = 0; ST.rwb.draw(fr);
            } catch (e) { /* ignore */ }
        }
        if (ct && ST.rec && ST.rec.count()) {
            var sp = _span(), M = s.M || ST.M;
            try { V.trend(ct, ST.rec, { keys: _isGas(M) ? ['qg', 'thp', 'pwf'] : ['qL', 'thp', 'pwf'], window: [sp[0], Math.max(sp[1], sp[0] + 60)], cursor: _curT(), marks: ST.rec.marks(), w: 640, h: 220, fixed: !_phone() }); } catch (e) { /* ignore */ }
        }
    }
    function _renderSlow() { _renderKpis(); _renderTimeline(); _renderChart(); _renderReport(); _renderEvents(); }
    function _renderAll() {
        _renderHeader(); _banner(); _renderNote(); _syncToolbar(); _drawLive(0); _renderSlow(); _renderCases();
    }
    function _publish() {
        var s = _vsim(), S = ST.sim && ST.sim.state, sum = null;
        try { sum = _hasData() ? _summary() : null; } catch (e) { sum = null; }
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.welldyn = { v: 1, ok: !!(s && !ST.err), playing: ST.playing, t: S ? S.t : (ST.scrubT || 0), state: S && S.well ? S.well.state : null, summary: sum,
            model: _modelStatus(ST.M), replay: !!ST.run, mock: !!(s && s.mock) };
    }

    // ── markup ───────────────────────────────────────────────────────────────
    function _card(title, body, o) {
        o = o || {};
        return '<div class="card wd-card' + (o.cls ? ' ' + o.cls : '') + '"' + (o.id ? ' id="' + o.id + '"' : '') + '><div class="card-title">' + _esc(title) + '</div>' + body + '</div>';
    }
    function _fg(id, label, o) {
        o = o || {};
        var d = o.def != null ? o.def : DEFS[id], lab = '<label for="' + id + '">' + _esc(label) + (o.unit ? ' (' + _esc(o.unit) + ')' : '') + '</label>';
        if (o.options) return '<div class="fg-item"' + (o.wid ? ' id="' + o.wid + '"' : '') + '>' + lab + '<select id="' + id + '">' + o.options.map(function (op) { return '<option value="' + _esc(op[0]) + '"' + (String(op[0]) === String(d) ? ' selected' : '') + '>' + _esc(op[1]) + '</option>'; }).join('') + '</select></div>';
        if (o.check) return '<div class="fg-item wd-chk"' + (o.wid ? ' id="' + o.wid + '"' : '') + '><label><input type="checkbox" id="' + id + '"' + (d ? ' checked' : '') + '> ' + _esc(label) + '</label></div>';
        return '<div class="fg-item"' + (o.wid ? ' id="' + o.wid + '"' : '') + '>' + lab + '<input type="number" step="any" inputmode="decimal" id="' + id + '" value="' + _esc(d == null ? '' : d) + '"' + (o.ph ? ' placeholder="' + _esc(o.ph) + '"' : '') + '></div>';
    }
    var CSS = '<style>' +
        '#wd_root{--wd-gap:14px;--wd-ok:var(--green,#3fb950);--wd-warn:var(--yellow,#d29922);--wd-fail:var(--red,#f85149)}' +
        '#wd_root .wd-head{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:0 0 10px}#wd_root .wd-model{flex:1 1 320px;min-width:0;font-size:12.5px;color:var(--text2)}' +
        '#wd_root .wd-wn{font-weight:700;color:var(--text)}#wd_root .wd-ok{color:var(--wd-ok);font-weight:600}#wd_root .wd-bad{color:var(--wd-fail);font-weight:600}' +
        '#wd_root .wd-tb{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;padding:8px 10px;margin:0 0 10px;background:var(--bg3);border:1px solid var(--border);border-radius:10px}' +
        '#wd_root .wd-tb .btn{padding:6px 11px;font-size:12.5px}#wd_root .wd-tb label{font-size:11.5px;color:var(--text2);font-weight:600}#wd_root .wd-tb select,#wd_root .wd-tb input{font-size:12.5px;padding:4px 6px;max-width:92px}' +
        '#wd_root .wd-grp{display:inline-flex;gap:5px;align-items:center;flex-wrap:nowrap}#wd_root .wd-sep{width:1px;align-self:stretch;background:var(--border);margin:0 2px}' +
        '#wd_root .wd-play{min-width:92px;font-weight:700}#wd_root .wd-play[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}' +
        '#wd_root .wd-more{position:relative}#wd_root .wd-more>summary{list-style:none;cursor:pointer;padding:6px 11px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;font-weight:600;background:var(--bg2)}' +
        '#wd_root .wd-more>summary::-webkit-details-marker{display:none}#wd_root .wd-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:210px;padding:6px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:4px}' +
        '#wd_root .wd-menu .btn{text-align:left}' +
        '#wd_root .wd-more:not([open]) .wd-menu{display:none}@media (max-width:600px){#wd_root .wd-more[open]{flex-basis:100%}#wd_root .wd-menu{position:static;margin-top:4px;min-width:0;box-shadow:none}}' +
        '#wd_root .wd-tl{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px 10px;align-items:center;margin:0 0 10px}#wd_root .wd-tl input[type=range]{width:100%;margin:0}' +
        '#wd_root .wd-tread{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px}#wd_root .wd-trange{font-size:11px;color:var(--text3);grid-column:1/-1}' +
        '#wd_root .wd-strip{grid-column:1/-1;width:100%;height:26px;display:block}#wd_root .wd-marks{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
        '#wd_root .wd-mk{display:inline-flex;gap:2px;align-items:center}#wd_root .wd-chip{padding:3px 9px;border-radius:12px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);font-size:11.5px;cursor:pointer}' +
        '#wd_root .wd-x{padding:2px 7px;font-size:11px;min-width:0}' +
        '#wd_root .wd-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:0 0 var(--wd-gap)}' +
        '#wd_root .wd-kpi{background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--text3);border-radius:8px;padding:8px 11px;min-width:0}' +
        '#wd_root .wd-kpi.st-ok{border-left-color:var(--wd-ok)}#wd_root .wd-kpi.st-warn{border-left-color:var(--wd-warn)}#wd_root .wd-kpi.st-fail{border-left-color:var(--wd-fail)}#wd_root .wd-kpi.st-info{border-left-color:var(--accent)}' +
        '#wd_root .wd-kpi .kpi-l{font-size:10.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;white-space:normal;overflow-wrap:anywhere}' +
        '#wd_root .wd-kpi .kpi-v{font-size:17px;font-weight:700;color:var(--text);margin-top:3px;font-variant-numeric:tabular-nums;white-space:normal;overflow-wrap:anywhere;line-height:1.2}' +
        '#wd_root .wd-kpi .kpi-s{font-size:11px;color:var(--text3);margin-top:1px;white-space:pre-line;overflow-wrap:anywhere}' +
        '#wd_root .wd-main{display:grid;grid-template-columns:minmax(0,500px) minmax(0,1fr);gap:var(--wd-gap);margin:0 0 var(--wd-gap)}' +
        '#wd_root .wd-wbw{display:flex;gap:8px;align-items:flex-start}#wd_root .wd-wbw canvas{display:block;max-width:100%;border-radius:6px}' +
        '#wd_root #wd_cv_well{width:360px;height:480px}#wd_root #wd_cv_nav{width:72px;height:480px}' +
        '#wd_root .wd-hover{font-size:11.5px;color:var(--text2);margin-top:6px;min-height:30px;font-variant-numeric:tabular-nums}' +
        '#wd_root .wd-tabs{display:flex;flex-wrap:wrap;gap:4px}#wd_root .wd-tabs button{padding:4px 10px;border-radius:14px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);font-size:11.5px;font-weight:600;cursor:pointer}' +
        '#wd_root .wd-tabs button.active{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}#wd_root .wd-tabsel{display:none}' +
        '#wd_root .wd-cw canvas{width:100%;display:block}#wd_root .wd-chartmsg{font-size:12px;color:var(--text3);min-height:16px}' +
        '#wd_root .wd-cards{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:var(--wd-gap);margin:0 0 var(--wd-gap)}' +
        '#wd_root .wd-card .fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 12px}#wd_root .wd-chk label{display:flex;gap:6px;align-items:center;font-size:12.5px}' +
        '#wd_root .wd-sub{font-size:11.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin:12px 0 6px}' +
        '#wd_root .wd-tw{overflow-x:auto;max-width:100%}#wd_root .wd-ct td,#wd_root .wd-et td{font-size:12px;padding:4px 6px}#wd_root .wd-et tr.ro td{color:var(--text3)}#wd_root .wd-nw{white-space:nowrap}' +
        '#wd_root .wd-evadd{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;margin-top:8px}#wd_root .wd-evadd .fg-item{min-width:110px;flex:1 1 110px}' +
        '#wd_root .wd-hint{font-size:11.5px;color:var(--text3)}#wd_root .wd-note{font-size:12px;color:var(--text2);min-height:0;margin:0 0 8px}' +
        '#wd_root .wd-v{font-size:12.5px;margin:3px 0}#wd_root .wd-v.ok{color:var(--wd-ok)}#wd_root .wd-v.warn{color:var(--wd-warn)}#wd_root .wd-v.fail{color:var(--wd-fail)}#wd_root .wd-v.info{color:var(--text2)}' +
        '#wd_root .wd-banner .wd-v{padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg3);margin:0 0 8px}#wd_root .wd-banner .btn{padding:3px 9px;font-size:11.5px;margin-left:6px}' +
        '#wd_root .wd-res{margin:var(--wd-gap) 0}#wd_root .wd-rvt{font-family:inherit;font-size:12.5px;font-weight:600;text-align:right}#wd_root .wd-rgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--wd-gap)}' +
        '#wd_root .wd-rkpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:0 0 var(--wd-gap)}' +
        '#wd_root .wd-rcv{display:flex;flex-wrap:wrap;gap:var(--wd-gap);align-items:flex-start}#wd_root #wd_cv_rwell{width:360px;height:480px}#wd_root #wd_cv_rtrend{width:640px;height:220px}' +
        '#wd_root .wd-rcv .chart-wrap{max-width:100%;overflow:hidden}#wd_root .wd-csv{margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg3)}' +
        '#wd_root .wd-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:2px 10px;max-height:160px;overflow:auto;font-size:12px;margin:6px 0}' +
        '#wd_root button:focus-visible,#wd_root select:focus-visible,#wd_root input:focus-visible,#wd_root canvas:focus-visible,#wd_root summary:focus-visible{outline:2px solid var(--focus,#58a6ff);outline-offset:2px}' +
        '@media (max-width:1100px){#wd_root .wd-main,#wd_root .wd-cards,#wd_root .wd-rgrid{grid-template-columns:minmax(0,1fr)}}' +
        '@media (max-width:600px){#wd_root .wd-tb{padding:6px}#wd_root .wd-tb .wd-opt{display:none}#wd_root .wd-tabs{display:none}#wd_root .wd-tabsel{display:block;width:100%}' +
        '#wd_root #wd_cv_well{width:240px;height:360px}#wd_root #wd_cv_nav{width:56px;height:360px}' +
        '#wd_root #wd_cv_rwell{width:270px;height:360px}#wd_root #wd_cv_rtrend{width:100%;height:200px}#wd_root .wd-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}#wd_root .wd-kpi .kpi-v{font-size:15px}' +
        '#wd_root .wd-tl{grid-template-columns:auto minmax(0,1fr)}}' +
        '@media (prefers-reduced-motion:reduce){#wd_root *{transition:none!important;animation:none!important}}' +
        '</style>';
    function _toolbarHtml() {
        var sp = parseInt(_pref('speed'), 10); ST.speed = SPEEDS.indexOf(sp) !== -1 ? sp : DEF_SPEED;
        var M = ST.M, beans = _beans(M), b0 = M && M.surface.choke.bean64;
        return '<div class="wd-tb rp-skip" id="wd_toolbar" role="toolbar" aria-label="Simulation controls">' +
            '<button type="button" class="btn btn-primary wd-play" id="wd_play" aria-pressed="false" aria-keyshortcuts="Space">▶ Play</button>' +
            '<button type="button" class="btn btn-secondary" id="wd_step" aria-keyshortcuts=".">Step</button>' +
            '<button type="button" class="btn btn-secondary" id="wd_shut" aria-keyshortcuts="S">Shut in</button>' +
            '<span class="wd-grp"><label for="wd_speed">Speed</label><select id="wd_speed" aria-label="Speed" aria-keyshortcuts="+ -">' + SPEEDS.map(function (s) { return '<option value="' + s + '"' + (s === ST.speed ? ' selected' : '') + '>×' + s + '</option>'; }).join('') + '</select></span>' +
            '<span class="wd-sep" aria-hidden="true"></span>' +
            '<span class="wd-grp"><label for="wd_bean">Bean</label><select id="wd_bean" aria-label="Bean (/64 in)">' + beans.map(function (b) { return '<option value="' + b + '"' + (b === b0 ? ' selected' : '') + '>' + b + '/64</option>'; }).join('') + '</select>' +
            '<button type="button" class="btn btn-secondary" id="wd_bean_go" title="Change the bean now">Set</button></span>' +
            '<span class="wd-grp wd-opt"><label for="wd_psep">Separator</label><input type="number" step="any" id="wd_psep" aria-label="Separator pressure" value="' + _esc(M ? M.surface.psep_psig : 100) + '"><button type="button" class="btn btn-secondary" id="wd_psep_go">Set</button></span>' +
            '<span class="wd-grp wd-opt" id="wd_foam_w"><label for="wd_foam">Foamer ppm</label><input type="number" step="any" id="wd_foam" aria-label="Foamer concentration (ppm)" value="1000"><button type="button" class="btn btn-secondary" id="wd_foam_on">On</button><button type="button" class="btn btn-secondary" id="wd_foam_off">Off</button></span>' +
            '<span class="wd-grp" id="wd_lift_gl" style="display:none"><label for="wd_glq">Lift gas</label><input type="number" step="any" id="wd_glq" aria-label="Lift-gas rate" value="' + _esc(M && M.lift.gl && M.lift.gl.qinj_Mscfd ? M.lift.gl.qinj_Mscfd : 600) + '"><button type="button" class="btn btn-secondary" id="wd_lift_go">Set</button></span>' +
            '<span class="wd-grp" id="wd_lift_esp" style="display:none"><label for="wd_hz">ESP Hz</label><input type="number" step="any" id="wd_hz" aria-label="ESP frequency (Hz)" value="60"><button type="button" class="btn btn-secondary" id="wd_esp_go">Set</button></span>' +
            '<span class="wd-sep" aria-hidden="true"></span>' +
            '<button type="button" class="btn btn-secondary" id="wd_mark" aria-pressed="false" aria-keyshortcuts="M">Mark</button>' +
            '<details class="wd-more" id="wd_export"><summary aria-label="Export, replay files">Export ▾</summary><div class="wd-menu">' +
            '<button type="button" class="btn btn-secondary" data-act="csvopen">CSV of the run…</button>' +
            '<button type="button" class="btn btn-secondary" data-act="saverun">Save replay file (.wdrun)</button>' +
            '<button type="button" class="btn btn-secondary" data-act="openrun">Open replay file…</button>' +
            '<input type="file" id="wd_file" accept=".wdrun,.json,application/json" style="display:none" aria-label="Open a replay file"></div></details>' +
            '<button type="button" class="btn btn-secondary" id="wd_reset" title="Rebuild the simulator from the model and the scenario (the recording is discarded)">Reset</button>' +
            '</div>';
    }
    function _csvHtml() {
        var RC = _REC(), keys = RC ? (typeof RC.channelKeys === 'function' ? RC.channelKeys() : RC.CHANNELS_FALLBACK) : [], saved = String(_pref('cols') || '').split(',').filter(Boolean);
        var def = ['t', 'thp', 'pwf', 'qo', 'qw', 'qg', 'bean', 'open', 'state', 'liq'];
        var on = function (k) { return saved.length ? saved.indexOf(k) !== -1 : def.indexOf(k) !== -1; };
        return '<div class="wd-csv rp-skip" id="wd_csvbox" style="display:none" role="group" aria-label="CSV export">' +
            '<div class="wd-sub" style="margin-top:0">CSV of the run</div>' +
            '<div class="wd-cols" id="wd_csvcols">' + keys.filter(function (k) { return k !== 't'; }).map(function (k) { var m = RC.channelMeta(k); return '<label><input type="checkbox" data-col="' + k + '"' + (on(k) ? ' checked' : '') + '> ' + _esc(m.label) + '</label>'; }).join('') + '</div>' +
            '<div class="fg">' + _fg('wd_csv_from', 'From', { unit: 'h', def: '' }) + _fg('wd_csv_to', 'To', { unit: 'h', def: '' }) + _fg('wd_csv_every', 'Every', { unit: 's', def: '' }) +
            _fg('wd_csv_sys', 'Units', { options: [['field', 'Field units'], ['metric', 'Metric']], def: _metric() ? 'metric' : 'field' }) + '</div>' +
            '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="btn btn-primary" data-act="csvgo">Download CSV</button><button type="button" class="btn btn-secondary" data-act="csvall">All columns</button><button type="button" class="btn btn-secondary" data-act="csvclose">Close</button></div></div>';
    }
    function _bodyHtml() {
        var tab = _pref('tab'); if (tab && TABS.some(function (t) { return t[0] === tab; })) ST.tab = tab;
        var ly = _pref('layer'); if (ly && LAYERS.some(function (l) { return l[0] === ly; })) ST.layer = ly;
        var s1 = '<div class="wd-head"><div class="wd-model" id="wd_model"></div>' +
            '<button type="button" class="btn btn-secondary rp-skip" id="wd_go_wellperf">◀ Back to nodal analysis</button></div>' +
            '<div class="wd-banner rp-skip" id="wd_banner"></div>' + _toolbarHtml() + _csvHtml() +
            '<div class="wd-note rp-skip" id="wd_note" role="status"></div>' +
            '<div class="wd-tl rp-skip" id="wd_timeline"><span class="wd-tread" id="wd_tread">0:00:00</span>' +
            '<input type="range" id="wd_scrub" min="0" max="1000" step="1" value="1000" aria-label="Timeline: scrub to a recorded moment" aria-keyshortcuts="ArrowLeft ArrowRight Home End">' +
            '<button type="button" class="btn btn-secondary" id="wd_cont" style="display:none">Continue from here</button>' +
            '<canvas class="wd-strip" id="wd_cv_strip" aria-label="Well state along the run"></canvas>' +
            '<span class="wd-trange" id="wd_trange"></span><div class="wd-marks" id="wd_marks"></div></div>' +
            '<div class="wd-kpis" id="wd_kpis"></div>' +
            '<div class="sr-only" id="wd_live" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></div>';
        var main = '<div class="wd-main rp-skip">' +
            _card('Wellbore', '<div class="fg" style="margin-bottom:8px">' + _fg('wd_layer', 'Colour by', { options: LAYERS, def: ST.layer }) + '</div>' +
                '<div class="wd-wbw"><canvas id="wd_cv_well" tabindex="0" role="img" aria-label="Wellbore along the true trajectory: cells coloured by phase, the flow regime, liquid film, droplets and slugs moving at the local velocity"></canvas>' +
                '<canvas id="wd_cv_nav" tabindex="0" role="img" aria-label="Navigator: the whole well with the zoom window"></canvas></div><div class="wd-hover" id="wd_hover"></div>') +
            _card('Charts', '<div class="wd-tabs" id="wd_tabs" role="tablist" aria-keyshortcuts="[ ]">' + TABS.map(function (t) { return '<button type="button" role="tab" id="wd_tab_' + t[0] + '" data-tab="' + t[0] + '" aria-controls="wd_cw_' + t[0] + '" aria-selected="' + (t[0] === ST.tab ? 'true' : 'false') + '" tabindex="' + (t[0] === ST.tab ? '0' : '-1') + '">' + _esc(t[1]) + '</button>'; }).join('') + '</div>' +
                '<select class="wd-tabsel" id="wd_tabsel" aria-label="Chart">' + TABS.map(function (t) { return '<option value="' + t[0] + '">' + _esc(t[1]) + '</option>'; }).join('') + '</select>' +
                '<div class="wd-chartmsg" id="wd_chartmsg"></div>' +
                TABS.map(function (t) { return '<div class="wd-cw chart-wrap" id="wd_cw_' + t[0] + '" role="tabpanel" aria-labelledby="wd_tab_' + t[0] + '"' + (t[0] === ST.tab ? '' : ' style="display:none"') + '><canvas id="wd_cv_' + t[0] + '" tabindex="0" role="img" aria-label="' + _esc(t[1]) + ' chart"></canvas></div>'; }).join('')) +
            '</div>';
        var res = '<div id="wd_res" class="wd-res">' +
            '<div class="wd-rkpi" id="wd_rkpi"></div>' +
            '<div class="wd-rgrid"><div class="rbox" id="wd_rinp"></div><div class="rbox" id="wd_rsum"></div></div>' +
            _card('Wellbore and run trend', '<div class="wd-rcv"><div class="chart-wrap"><canvas id="wd_cv_rwell" role="img" aria-label="Wellbore at the moment shown"></canvas></div>' +
                '<div class="chart-wrap"><canvas id="wd_cv_rtrend" role="img" aria-label="Run trend: rate and pressures against time"></canvas></div></div>') +
            '<div class="wd-rgrid"><div class="rbox" id="wd_rstates"></div><div><div class="rbox" id="wd_rverd"></div><div class="rbox" id="wd_rprov"></div></div></div>' +
            '<div class="wd-notes" id="wd_notesbox" style="margin:var(--wd-gap) 0"></div></div>';
        var scen = _card('Scenario', '<div class="fg">' +
                _fg('wd_preset', 'Preset', { options: PRESETS }) +
                '<div class="fg-item rp-skip"><label>&nbsp;</label><button type="button" class="btn btn-secondary" data-act="preset">Apply preset</button></div>' +
                _fg('wd_start', 'Start', { options: [['steady', 'Steady flow (nodal point)'], ['static', 'Static well']] }) +
                _fg('wd_static', 'Static well', { options: [['liquid', 'Full of liquid'], ['gas', 'Gas-filled'], ['level', 'Liquid level']], wid: 'wd_static_w' }) +
                _fg('wd_liquid', 'Liquid', { options: [['water', 'Water (the model\'s)'], ['oil', 'Oil']], wid: 'wd_liq_w' }) +
                _fg('wd_level', 'Liquid top (MD)', { unit: 'ft', wid: 'wd_level_w' }) +
                _fg('wd_dur', 'Duration', { unit: 'h' }) + _fg('wd_cells', 'Cells', { unit: '20–200' }) +
                _fg('wd_closure', 'Closure', { options: [['corr', 'Gradient correlation (default)'], ['driftflux', 'Drift flux everywhere']] }) +
                _fg('wd_temp', 'Temperature', { options: [['frozen', 'Frozen (default)'], ['relax', 'Relaxation (provisional)']] }) +
                _fg('wd_fallback', 'Liquid fallback (provisional)', { check: true }) +
                _fg('wd_belfroid', 'Belfroid correction (provisional)', { check: true }) +
                _fg('wd_backflow', 'Back-flow to the formation (provisional)', { check: true }) +
                '</div><div class="wd-sub">Reservoir</div><div class="fg">' +
                _fg('wd_resmode', 'Inflow in time', { options: [['ipr', 'Steady inflow (IPR, default)'], ['transient', 'Transient radial (superposition)']] }) +
                _fg('wd_prior', 'Prior history', { options: [['auto', 'From the start'], ['steady', 'Steady'], ['none', 'None'], ['shutin', 'Shut in']] }) +
                _fg('wd_prior_h', 'Prior time', { unit: 'h' }) +
                '<div class="fg-item rp-skip"><label>&nbsp;</label><button type="button" class="btn btn-secondary" data-act="prism">Import from PRiSM</button></div></div>' +
                '<div class="fg" id="wd_res_t">' + _fg('wd_k', 'Permeability k', { unit: 'md', ph: '—' }) + _fg('wd_h', 'Net thickness h', { unit: 'ft', ph: '—' }) + _fg('wd_phi', 'Porosity φ', { unit: 'fraction', ph: '—' }) +
                _fg('wd_ct', 'Total compressibility c_t', { unit: '1/psi', ph: '—' }) + _fg('wd_mu', 'Viscosity μ', { unit: 'cp', ph: '—' }) + _fg('wd_B', 'Formation volume factor B', { unit: 'rb/STB', ph: '—' }) +
                _fg('wd_rw', 'Wellbore radius r_w', { unit: 'ft', ph: '—' }) + _fg('wd_re', 'Drainage radius r_e', { unit: 'ft', ph: '—' }) + _fg('wd_S', 'Skin S', { ph: '—' }) +
                '<div class="wd-hint" id="wd_res_miss" style="grid-column:1/-1"></div></div>' +
                '<div class="wd-sub">Events</div><div class="wd-tw"><table class="dtable wd-et"><thead><tr><th>Time</th><th>Event</th><th>Source</th><th></th></tr></thead><tbody id="wd_evbody"></tbody></table></div>' +
                '<div class="wd-evadd rp-skip">' + _fg('wd_ev_t', 'At', { unit: 'h', def: '' }) + _fg('wd_ev_type', 'Event', { options: EV_TYPES, def: 'bean' }) + _fg('wd_ev_v', 'Value', { def: '' }) +
                '<div class="fg-item"><label>&nbsp;</label><button type="button" class="btn btn-secondary" data-act="evadd">Add event</button></div></div>' +
                '<div class="fg" style="margin-top:10px"><div class="fg-item" style="grid-column:1/-1"><label for="wd_notes">Engineer notes (printed in the Notes)</label><textarea id="wd_notes" rows="2" placeholder="Assumptions, data sources, decisions…"></textarea></div></div>', { id: 'wd_scen' });
        var liftc = _card('Lift and intermittent production', '<div class="rbox" id="wd_liftstat"></div>' +
                '<div class="wd-sub rp-skip">Intermittent production (provisional controller)</div><div class="fg rp-skip">' +
                _fg('wd_cyc_mode', 'Trigger', { options: [['timer', 'Timer (open / shut times)'], ['pressure', 'Pressure (open at / shut below)']], def: 'timer' }) +
                _fg('wd_cyc_open', 'Open for', { unit: 'h', def: 2 }) + _fg('wd_cyc_shut', 'Shut for', { unit: 'h', def: 2 }) + _fg('wd_cyc_n', 'Cycles', { def: 3 }) +
                _fg('wd_cyc_pon', 'Open when THP (CHP) reaches', { unit: 'psig', def: '' }) + _fg('wd_cyc_poff', 'Shut when THP falls below', { unit: 'psig', def: '' }) +
                _fg('wd_cyc_qoff', 'or the gas rate below', { unit: 'Mscf/d', def: '' }) + _fg('wd_cyc_minon', 'Minimum open', { unit: 'h', def: 0.5 }) + _fg('wd_cyc_minoff', 'Minimum shut', { unit: 'h', def: 0.5 }) +
                '<div class="fg-item"><label>&nbsp;</label><button type="button" class="btn btn-secondary" data-act="cycgo">Start the cycle now</button></div>' +
                '<div class="fg-item"><label>&nbsp;</label><button type="button" class="btn btn-secondary" data-act="cycoff">Stop the cycle</button></div></div>' +
                '<div class="wd-sub rp-skip" id="wd_ramp_w0">ESP drive</div><div class="fg rp-skip" id="wd_ramp_w">' + _fg('wd_ramp', 'Frequency ramp', { unit: 'Hz/s', def: 1 }) +
                '<div class="wd-hint" style="grid-column:1/-1">Set the frequency on the toolbar (ESP Hz → Set); Set again after a trip restarts the pump.</div></div>', { id: 'wd_liftcard' });
        var cases = _card('Cases', '<div class="fg rp-skip"><div class="fg-item"><label for="wd_case_name">Case name</label><input type="text" id="wd_case_name" maxlength="60" placeholder="e.g. Bean-up to 32/64"></div>' +
                '<div class="fg-item"><label>&nbsp;</label><button type="button" class="btn btn-secondary" data-act="casesave">Save case with this well</button></div></div><div id="wd_cases" class="rp-skip"></div>', { id: 'wd_casecard' });
        return '<div id="wd_root" tabindex="-1">' + s1 + main + res + '<div class="wd-cards">' + scen + cases + '</div>' + liftc + '</div>';
    }

    // ── events on #wd_root ───────────────────────────────────────────────────
    function _onSettings() {
        _syncScenario();
        var h = _hash(_optsOf(_settings()));
        if (h !== ST.optsHash) {
            if (_hasData() || ST.run) ST.settingsStale = true;
            else _build('settings');
        }
        ST.endT = Math.max(ST.sim ? ST.sim.state.t : 0, _settings().duration_s);
        _renderAll(); _publish();
    }
    function _bind() {
        var root = _byId('wd_root'); if (!root) return;
        root.addEventListener('click', function (e) {
            var t = e.target, b = t && t.closest ? t.closest('button,[data-act]') : null;
            if (!b || !root.contains(b)) return;
            var id = b.id, act = b.getAttribute('data-act');
            if (id === 'wd_play') { if (ST.playing) _pause('user'); else _play(); return; }
            if (id === 'wd_step') { _stepOnce(); return; }
            if (id === 'wd_shut') { _shutToggle(); return; }
            if (id === 'wd_bean_go') { _beanApply(); return; }
            if (id === 'wd_psep_go') { _psepApply(); return; }
            if (id === 'wd_foam_on') { _foamApply(true); return; }
            if (id === 'wd_foam_off') { _foamApply(false); return; }
            if (id === 'wd_lift_go' || id === 'wd_esp_go') { _liftApply(); return; }
            if (id === 'wd_mark') { _mark(); return; }
            if (id === 'wd_cont') { _cont(); return; }
            if (id === 'wd_reset') { _build('reset'); _renderAll(); _publish(); return; }
            if (id === 'wd_go_wellperf') { _nav('wellperf'); return; }
            if (b.hasAttribute('data-tab')) { _setTab(b.getAttribute('data-tab')); return; }
            var ex = _byId('wd_export');
            switch (act) {
                case 'preset': _preset(_val('wd_preset')); break;
                case 'static': _setCtl('wd_start', 'static'); _onSettings(); break;
                case 'gowp': _nav('wellperf'); break;
                case 'rebuild': _build('rebuild'); _renderAll(); _publish(); break;
                case 'rerun': _rerun(); break;
                case 'closerun': ST.run = null; ST.runNote = null; ST.viewSim = null; _build('closerun'); _renderAll(); break;
                case 'csvopen': if (ex) ex.open = false; var cb = _byId('wd_csvbox'); if (cb) cb.style.display = ''; ST.csvOpen = true; break;
                case 'csvclose': var cb2 = _byId('wd_csvbox'); if (cb2) cb2.style.display = 'none'; ST.csvOpen = false; break;
                case 'csvall': Array.prototype.forEach.call(document.querySelectorAll('#wd_csvcols input[data-col]'), function (c) { c.checked = true; }); break;
                case 'csvgo': _csv(); break;
                case 'saverun': if (ex) ex.open = false; _runFile(); break;
                case 'openrun': if (ex) ex.open = false; var f = _byId('wd_file'); if (f && f.click) f.click(); break;
                case 'gomark': var m = (ST.rec ? ST.rec.marks() : []).filter(function (x) { return x.id === b.getAttribute('data-id'); })[0]; if (m) _scrub(m.t0); break;
                case 'csvmark': var m2 = (ST.rec ? ST.rec.marks() : []).filter(function (x) { return x.id === b.getAttribute('data-id'); })[0]; if (m2) _csv({ from: m2.t0, to: m2.t1 }); break;
                case 'unmark': if (ST.rec) ST.rec.unmark(b.getAttribute('data-id')); _renderTimeline(); _renderChart(); break;
                case 'evadd': _evAdd(); break;
                case 'cycgo': _cycleApply(false); break;
                case 'cycoff': _cycleApply(true); break;
                case 'evdel': var i = +b.getAttribute('data-i'); if (ST.events[i]) { ST.events.splice(i, 1); if (!_hasData()) _build('events'); else ST.note = 'The event is removed from the scenario; the running simulator keeps the events already scheduled (Reset to apply).'; _renderAll(); } break;
                case 'casesave': _caseSave(); break;
                case 'caseload': _caseLoad(b.getAttribute('data-id')); break;
                case 'casedel': _caseRemove(b.getAttribute('data-id')); break;
                case 'prism': _importPrism(); break;
                default: break;
            }
        });
        root.addEventListener('change', function (e) {
            var t = e.target, id = t && t.id; if (!id) return;
            if (id === 'wd_speed') { _setSpeed(t.value); return; }
            if (id === 'wd_layer') { ST.layer = t.value; _pref('layer', t.value); if (ST.wb && ST.wb.setLayer) ST.wb.setLayer(t.value); _drawLive(0); return; }
            if (id === 'wd_tabsel') { _setTab(t.value); return; }
            if (id === 'wd_file') {
                var fl = t.files && t.files[0]; if (!fl) return;
                try { var rd = new FileReader(); rd.onload = function () { _load(String(rd.result || '')); }; rd.readAsText(fl); } catch (er) { /* no FileReader */ }
                t.value = ''; return;
            }
            if (/^wd_(k|h|phi|ct|mu|B|rw|re|S)$/.test(id)) _resWrite('user');
            if (id in DEFS && id !== 'wd_preset') _onSettings();
        });
        root.addEventListener('input', function (e) {
            var t = e.target; if (!t || t.id !== 'wd_scrub') return;
            var sp = _span(); _scrub(sp[0] + (sp[1] - sp[0]) * (+t.value) / 1000);
        });
        root.addEventListener('keydown', function (e) {
            var t = e.target, tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
            if (tag === 'INPUT' && t.type !== 'range' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            // review fix (WCAG 2.1.4): a chart tab moves between the tabs (roving tabindex); a focused button, summary or link keeps its own keys;
            // the shortcuts act only with the focus on the page itself, a canvas or the timeline
            var role = t && t.getAttribute ? t.getAttribute('role') : null;
            if (role === 'tab') {
                var ks = e.key, ix = TABS.map(function (x) { return x[0]; }).indexOf(t.getAttribute('data-tab')), nx = -1;
                if (ks === 'ArrowRight') nx = (ix + 1) % TABS.length; else if (ks === 'ArrowLeft') nx = (ix + TABS.length - 1) % TABS.length;
                else if (ks === 'Home') nx = 0; else if (ks === 'End') nx = TABS.length - 1;
                if (nx >= 0 && ix >= 0) { _setTab(TABS[nx][0]); var nb = _byId('wd_tab_' + TABS[nx][0]); if (nb && nb.focus) nb.focus(); if (e.preventDefault) e.preventDefault(); }
                return;
            }
            if (t !== root && tag !== 'CANVAS' && !(tag === 'INPUT' && t.type === 'range')) return;
            if (tag === 'CANVAS' && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Escape' || e.key === '0' || ((e.key === '+' || e.key === '-') && t.id === 'wd_cv_well'))) return;   // the wellbore's own keys
            var k = e.key, sp = _span(), w = sp[1] - sp[0], cur = _curT(), done = true;
            if (k === ' ' || k === 'Spacebar') { if (tag === 'BUTTON') return; if (ST.playing) _pause('user'); else _play(); }
            else if (k === '.') _stepOnce();
            else if (k === 'ArrowLeft' || k === 'ArrowRight') { if (tag === 'INPUT' && t.type === 'range') return; _scrub(cur + (k === 'ArrowLeft' ? -1 : 1) * w * (e.shiftKey ? 0.1 : 0.01)); }
            else if (k === 'Home') _scrub(sp[0]);
            else if (k === 'End') { ST.scrubT = null; _renderAll(); }
            else if (k === '+' || k === '=') _speedStep(1);
            else if (k === '-') _speedStep(-1);
            else if (k === 's' || k === 'S') _shutToggle();
            else if (k === 'm' || k === 'M') _mark();
            else if (k === '[' || k === ']') { var i = TABS.map(function (x) { return x[0]; }).indexOf(ST.tab); _setTab(TABS[(i + (k === ']' ? 1 : TABS.length - 1)) % TABS.length][0]); }
            else done = false;
            if (done && e.preventDefault) e.preventDefault();
        });
    }
    function _nav(route) {
        if (typeof G.WTS_nav === 'function') { G.WTS_nav(route); return true; }
        var b = (typeof document !== 'undefined') ? document.querySelector('#sidebar .nav-btn[data-p="' + route + '"]') : null;
        if (b && b.click) { b.click(); return true; }
        if (G.__WTS_TEST__ && typeof G.__WTS_TEST__.nav === 'function') { G.__WTS_TEST__.nav(route); return true; }
        return false;
    }

    // ── page entry points ────────────────────────────────────────────────────
    function render(body) {
        _pause('reset'); _cancel();
        ST.M = _read();
        body.innerHTML = CSS + _bodyHtml();
        var U = _U();
        if (U && U.tagInput) [['wd_psep', 'pressureG'], ['wd_level', 'length'], ['wd_h', 'length'], ['wd_rw', 'length'], ['wd_re', 'length'], ['wd_glq', 'gasRateSmall'], ['wd_cyc_pon', 'pressureG'], ['wd_cyc_poff', 'pressureG'], ['wd_cyc_qoff', 'gasRateSmall']].forEach(function (x) { if (_byId(x[0])) U.tagInput(x[0], x[1]); });
        _bind();
        ST.wb = null; ST.nav = null; ST.rwb = null;
        _setTab(ST.tab);
        // the host restores the autosaved scenario values silently and then calls hooks.after → one calcWellDyn() per open
    }
    function calcWellDyn() {
        calcs++;
        if (!_byId('wd_root')) return;
        var M = _read(), h = _modelHash(M);
        _syncScenario();
        if (ST.run) { _renderAll(); _publish(); return; }
        var oh = _hash(_optsOf(_settings()));
        if (!ST.sim || h !== ST.mHash || oh !== ST.optsHash) {
            if (ST.sim && _hasData() && h !== ST.mHash) ST.modelStale = true;
            else if (ST.sim && _hasData() && oh !== ST.optsHash) ST.settingsStale = true;
            else _build('calc');
        }
        if (!ST.sim) ST.M = M;
        if (ST.sim && !ST.wb) _mountViews();
        _renderAll();
        _publish();
    }
    G.renderWellDyn = function (body) { return render(body); };
    G.calcWellDyn = function () { return calcWellDyn(); };

    if (typeof document !== 'undefined' && document.addEventListener) {
        var gone = function () {
            if (!ST.sim && !ST.run) return;
            _dispose(); ST.run = null; ST.runNote = null; ST.viewSim = null; ST.mHash = null; ST.optsHash = null; ST.events = [];
            ST.note = 'The well changed: the previous run was discarded.';
        };
        document.addEventListener('wts:well-changed', gone);
        document.addEventListener('wts:project-loaded', gone);
        document.addEventListener('wts:wellperf-model-changed', function (e) {
            var k = e && e.detail && e.detail.keys;
            if (Array.isArray(k) && k.length === 1 && k[0] === 'dyn') return;     // the page's own case save (R17)
            if (!_byId('wd_root')) { ST.mHash = null; return; }
            if (_hasData() || ST.playing) { ST.modelStale = true; _banner(); }
            else G.calcWellDyn();
        });
        document.addEventListener('wts:unit-system-changed', function () { if (_byId('wd_root')) { _renderAll(); } });
        document.addEventListener('visibilitychange', function () { if (document.hidden && ST.playing) { _pause('hidden'); ST.note = 'Paused: the page was hidden.'; _renderNote(); } });
    }

    // ── registry and test hook ───────────────────────────────────────────────
    G.WTS_welldyn_page = {
        state: function () { return ST; },
        sim: function () { return ST.sim; },
        rec: function () { return ST.rec; },
        calcs: function () { return calcs; },
        play: _play, pause: function () { _pause('user'); }, frame: function (ts) { _cancel(); _frame(ts); }, step: _stepOnce,
        csv: function (o) { return _csv(o, false); }, runFile: function () { return _runFile(false); }, load: _load, rerun: _rerun,
        scenario: _preset, scrub: _scrub, cont: _cont, mark: _mark, shut: _shutToggle, speed: _setSpeed, build: function () { var r = _build('test'); _renderAll(); return r; },
        caseSave: _caseSave, caseLoad: _caseLoad, caseRemove: _caseRemove, cases: _cases, evAdd: _evAdd, importPrism: _importPrism,
        kpis: _kpis, summary: _summary, settings: _settings, tab: _setTab, verdicts: function () { return _verdicts(_summary()); }
    };
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.welldyn = {
        key: KEY,
        title: TITLE,
        navTitle: 'Well Dynamics',
        sub: SUB,
        group: 'Production & Reservoir',
        icon: '&#8767;',
        badge: 'Production',
        bc: 'dc-b-green',
        desc: 'Play a Well Performance well in time: start-up, choke changes, shut-in and build-up, gas-well loading and unloading, foamer, intermittent production, gas-lift unloading and ESP start-up, with a recorder, replay files and cases.',
        hooks: { silent: true, after: function () { G.calcWellDyn(); } },
        render: function (body) { return G.renderWellDyn(body); }
    };
    if (Array.isArray(G.__WD_STUBS)) G.__WD_STUBS = G.__WD_STUBS.filter(function (s) { return !/^(renderWellDyn|calcWellDyn|WTS_welldyn_page|welldyn)\b/.test(String(s)); });
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var e = G.WTS_calcRegistry && G.WTS_calcRegistry.welldyn;
    if (!(e && e.key === 'welldyn' && typeof e.render === 'function' && e.hooks && e.hooks.silent === true) && typeof console !== 'undefined') console.error('[welldyn self-test] registry entry malformed');
})();
