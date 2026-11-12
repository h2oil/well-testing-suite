// =============================================================================
// WTS — 49-calc-wp-batch.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// window.WTS_wp_batch — Well Performance over every well of the project (docs/WELL-PERFORMANCE-PLAN.md §18.3 WP28, §1.4 K1 / K2,
// §2.8, §3.10, §16; increment B, v4.5). One Job (PRiSM_autoInterp.drive) that walks the WTS_wells list, reads each well's model
// READ-ONLY (the active well from storage plus the page's live controls, a parked well from its blob through WTS_wells.captureWell)
// and solves it with the shared engines (WTS_wp_model.read → WTS_wp_well.build → WTS_wp_system.solve). Nothing is written: no
// storage write, no well switch, no event. The engines are not duplicated; the summary of one solve follows WTS_wp_sens's R-summary.
//
// API (field units, §3.0; nothing throws for user data)
//   sources(o?)          → {ok, wells:[{id, name, active, origin:'live'|'parked'|'single', get(key)}], warnings}
//                          o.wells (tests) = [{id, name, active, keys:{storageKey: raw string}}] replaces the WTS_wells list
//   readWell(src, o?)    → {ok, has:{page, model}, M (frozen) | null, code?}      o.scalars = live controls for the active well
//   summarise(M, R, W, L?) → the batch row of one solved well (see ROW below)
//   job(o?)              → Job {step() → {done, progress, label}, done(), progress(), result(), cancel()}; one well per step
//                          o = {ids?: [well ids, the order of the list], liveScalars?, wells? (tests)}
//                          result() → {ok, v, rows:[ROW], totals, counts:{n, solved, stable, unstable, failed, none, warn},
//                                      evals, ms, cancelled?, errors[], warnings[], ts}
//   table(result)        → {head[], rows[][]}  (field units; numbers unformatted)
//   csv(result)          → string
//   storedFrom(M)        → {wts_page_wellperf, wts_wellperf_model} raw strings: a model as a well stores it (injected wells, X28a)
//   ROW = {id, name, active, status:'ok'|'none'|'fail', verdict:'ok'|'warn'|'fail'|'none', code, error, fluid, gas (bool),
//          q (main rate: gas Mscf/d for a gas well, liquid STB/d otherwise), qo, qw, qg, qL, pwf, thp, tht, pr, aof, ddFrac, qFrac,
//          stable, qs, marginQs (q / q_s − 1), loadingMargin, regime, bean, choke (bool), corr, provisional, lift, flags[], nWarn,
//          well:{midMd, midTvd, tdMd, tdTvd, incMax, hzMd (length at ≥ 80°), dep, traj:[[vs, tvd]] (≤ 60 points)},
//          curves:{ipr:[[q, p]], vlp:[[q, p]]} (decimated), op:{q, p}, evals, ms, key}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var VERSION = '1.0.0';
    var PAGE_KEY = 'wts_page_wellperf', MODEL_KEY = 'wts_wellperf_model';
    var HZ_INC = 80;            // a section at ≥ 80° inclination counts as horizontal (the schematic uses the same rule)
    var MAX_TRAJ = 60, MAX_CURVE = 40, MAX_WELLS = 200;

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _w(code, msg) { return { code: code, msg: String(msg).slice(0, 299), sev: 'warn' }; }
    function _fn(path) {
        var p = path.split('.'), o = G[p[0]], f = p.length > 1 ? (o && o[p[1]]) : o;
        return typeof f === 'function' ? function () { return f.apply(p.length > 1 ? o : G, arguments); } : null;
    }
    function _now() { try { return (G.performance && typeof G.performance.now === 'function') ? G.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
    function _parse(s) { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } }
    function _isGas(t) { return t === 'gas' || t === 'condensate' || t === 'gasinj'; }
    function _ls() { try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; } }
    function _decim(arr, n) {
        if (!Array.isArray(arr) || arr.length <= n) return Array.isArray(arr) ? arr.slice() : [];
        var out = [], st = (arr.length - 1) / (n - 1);
        for (var i = 0; i < n; i++) out.push(arr[Math.round(i * st)]);
        return out;
    }
    // a short, stable key of a model (the page tells a stale row by it)
    function _hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619) | 0; } return ('00000000' + (h >>> 0).toString(16)).slice(-8); }
    function key(M) { if (!M) return ''; try { return _hash(JSON.stringify([M.fluid, M.res, M.well, M.surface, M.system, M.lift])); } catch (e) { return ''; } }

    // ── the wells and a read-only getter per well ──────────────────────────────────────────────────────────────────────
    function _getFromKeys(keys) { return function (k) { return (keys && Object.prototype.hasOwnProperty.call(keys, k)) ? String(keys[k]) : null; }; }
    function sources(o) {
        o = o || {};
        var warnings = [], out = [];
        if (Array.isArray(o.wells)) {
            o.wells.slice(0, MAX_WELLS).forEach(function (w, i) {
                if (!w) return;
                out.push({ id: w.id != null ? String(w.id) : 'w' + (i + 1), name: String(w.name || w.id || ('Well ' + (i + 1))), active: !!w.active, origin: w.active ? 'live' : 'parked', get: _getFromKeys(w.keys || {}) });
            });
            return { ok: out.length > 0, wells: out, warnings: warnings };
        }
        var WS = G.WTS_wells, ls = _ls();
        var liveGet = function (k) { if (!ls) return null; try { return ls.getItem(k); } catch (e) { return null; } };
        var list = [];
        try { list = (WS && typeof WS.list === 'function') ? (WS.list() || []) : []; } catch (e) { list = []; }
        if (!list.length) return { ok: true, wells: [{ id: null, name: 'This well', active: true, origin: 'single', get: liveGet }], warnings: warnings };
        list.slice(0, MAX_WELLS).forEach(function (w) {
            if (w.active) { out.push({ id: w.id, name: w.name, active: true, origin: list.length > 1 ? 'live' : 'single', get: liveGet }); return; }
            // a parked well: its blob (captureWell returns a copy and writes nothing for a parked well)
            var blob = null;
            try { if (typeof WS.captureWell === 'function') blob = WS.captureWell(w.id); } catch (e) { blob = null; }
            if (!blob) blob = _parse(liveGet('wts_well_' + w.id));
            if (!blob || typeof blob.keys !== 'object') { warnings.push(_w('WELL_UNREADABLE', w.name + ': the stored well could not be read')); blob = { keys: {} }; }
            out.push({ id: w.id, name: w.name, active: false, origin: 'parked', get: _getFromKeys(blob.keys) });
        });
        if (list.length > MAX_WELLS) warnings.push(_w('TOO_MANY_WELLS', 'only the first ' + MAX_WELLS + ' wells are included'));
        return { ok: true, wells: out, warnings: warnings };
    }
    function readWell(src, o) {
        o = o || {};
        if (!src || typeof src.get !== 'function') return { ok: false, code: 'NO_SOURCE', has: { page: false, model: false }, M: null };
        var Mm = G.WTS_wp_model;
        if (!Mm || typeof Mm.read !== 'function') return { ok: false, code: 'MISSING_ENGINE', has: { page: false, model: false }, M: null };
        var pg = src.get(PAGE_KEY), md = src.get(MODEL_KEY), live = src.active && o.scalars && typeof o.scalars === 'object';
        var has = { page: pg != null && pg !== '', model: md != null && md !== '' };
        if (!has.page && !has.model && !live) return { ok: false, code: 'NO_INPUTS', has: has, M: null };
        var storage = { getItem: function (k) { return src.get(k); }, setItem: function () { throw new Error('read-only'); }, removeItem: function () { throw new Error('read-only'); } };
        var M = null;
        try { M = Mm.read({ storage: storage, scalars: live ? o.scalars : undefined }); } catch (e) { M = null; }
        return M ? { ok: true, has: has, M: M } : { ok: false, code: 'READ_FAILED', has: has, M: null };
    }

    // ── the row of one well ────────────────────────────────────────────────────────────────────────────────────────────
    function _wellGeo(W) {
        var g = { midMd: null, midTvd: null, tdMd: null, tdTvd: null, incMax: 0, hzMd: 0, dep: 0, traj: [] };
        if (!W || !W.ok || !W.nodes) return g;
        g.midMd = _fin(W.nodes.midPerfMd) ? W.nodes.midPerfMd : null; g.midTvd = _fin(W.nodes.midPerfTvd) ? W.nodes.midPerfTvd : null;
        var sch = _fn('WTS_wp_well.schematic'), S = null;
        try { S = sch ? sch(W, null) : null; } catch (e) { S = null; }
        var tr = S && Array.isArray(S.trajectory) ? S.trajectory.filter(function (p) { return _fin(p.md) && _fin(p.tvd); }) : [];
        if (!tr.length) return g;
        var last = tr[tr.length - 1];
        g.tdMd = last.md; g.tdTvd = last.tvd; g.dep = _fin(last.dep) ? last.dep : 0;
        for (var i = 0; i < tr.length; i++) {
            var inc = _fin(tr[i].inc) ? tr[i].inc : 0;
            if (inc > g.incMax) g.incMax = inc;
            if (i && inc >= HZ_INC && _fin(tr[i - 1].inc) && tr[i - 1].inc >= HZ_INC) g.hzMd += tr[i].md - tr[i - 1].md;
        }
        g.traj = _decim(tr, MAX_TRAJ).map(function (p) { return [_fin(p.vs) ? p.vs : (_fin(p.dep) ? p.dep : 0), p.tvd, p.md]; });
        return g;
    }
    function summarise(M, R, W, L) {
        var ok = !!(R && R.ok && R.op), gas = !!(M && _isGas(M.fluid.type));
        var row = { status: ok ? 'ok' : 'fail', verdict: 'fail', code: ok ? null : ((R && R.code) || 'NO_SOLUTION'), error: ok ? null : ((R && R.errors && R.errors[0]) || 'no operating point'),
            fluid: M ? M.fluid.type : null, gas: gas, q: null, qo: null, qw: null, qg: null, qL: null, pwf: null, thp: null, tht: null,
            pr: M && _fin(M.res.pr) ? M.res.pr : null, aof: R && _fin(R.aof) ? R.aof : null, ddFrac: null, qFrac: null, stable: false, qs: null, marginQs: null,
            loadingMargin: null, regime: null, bean: M && M.surface.choke.present !== false && _fin(M.surface.choke.bean64) ? M.surface.choke.bean64 : null,
            choke: !!(M && M.surface.choke.present !== false), corr: (R && R.corr && R.corr.well) || (M && M.system.corr && M.system.corr.well) || null, provisional: false,
            lift: M && M.lift ? M.lift.type || 'none' : 'none', flags: [], nWarn: 0, well: _wellGeo(W), curves: { ipr: [], vlp: [] }, op: null, evals: R ? (R.evals || 0) : 0, key: key(M) };
        var ce = row.corr && G.WTS_flowline_corr ? G.WTS_flowline_corr[row.corr] : null;
        row.provisional = !!(ce && ce.verified !== true);
        if (R && R.curves) {
            row.curves.ipr = _decim((R.curves.ipr || []).map(function (c) { return [c.q, _fin(c.p) ? c.p : c.pwf]; }).filter(function (c) { return _fin(c[0]) && _fin(c[1]); }), MAX_CURVE);
            row.curves.vlp = _decim((R.curves.vlp || []).map(function (c) { return [c.q, _fin(c.p) ? c.p : c.pwf]; }).filter(function (c) { return _fin(c[0]) && _fin(c[1]); }), MAX_CURVE);
        }
        if (!ok) return row;
        var rt = R.rates || {}, sf = R.surface || {};
        row.qo = _fin(rt.qo) ? rt.qo : null; row.qw = _fin(rt.qw) ? rt.qw : null; row.qg = _fin(rt.qg) ? rt.qg : null; row.qL = _fin(rt.qL) ? rt.qL : null;
        row.q = R.op.q;
        row.pwf = _fin(R.pwf) ? R.pwf : (R.node === 'bottom' ? R.op.p : null);
        row.thp = _fin(sf.thp_psig) ? sf.thp_psig : (_fin(sf.thp) ? sf.thp - 14.696 : null);
        row.tht = _fin(sf.tht) ? sf.tht : null;
        row.regime = sf.choke && sf.choke.present !== false ? (sf.choke.regime || null) : null;
        row.stable = !!R.op.stable;
        row.qs = R.qs && _fin(R.qs.q) ? R.qs.q : null;
        row.marginQs = _fin(row.qs) && row.qs > 0 ? row.q / row.qs - 1 : null;
        var LL = (R.loading && typeof R.loading === 'object') ? R.loading : (L && L.ok !== false ? L : null);
        row.loadingMargin = LL && _fin(LL.margin) ? LL.margin : null;
        row.op = { q: R.op.q, p: _fin(row.pwf) ? row.pwf : R.op.p };
        if (_fin(row.pr) && _fin(row.pwf) && row.pr > 0) row.ddFrac = (row.pr - row.pwf) / row.pr;
        if (_fin(row.aof) && row.aof > 0) row.qFrac = row.q / row.aof;
        row.flags = (R.flags || []).filter(function (f) { return f && f.sev === 'warn'; }).map(function (f) { return f.code; }).slice(0, 8);
        row.nWarn = row.flags.length;
        row.verdict = !row.stable ? 'fail' : (row.nWarn || (_fin(row.loadingMargin) && row.loadingMargin < 0.1) || (_fin(row.marginQs) && row.marginQs < 0.1)) ? 'warn' : 'ok';
        return row;
    }

    // ── the Job ────────────────────────────────────────────────────────────────────────────────────────────────────────
    function _failJob(code, errors) {
        var res = { ok: false, v: 1, code: code, rows: [], totals: {}, counts: {}, evals: 0, ms: 0, errors: errors, warnings: [], ts: Date.now() };
        return { step: function () { return { done: true, progress: 1, label: '' }; }, done: function () { return true; }, progress: function () { return 1; },
                 result: function () { return res; }, cancel: function () { }, code: code, errors: errors };
    }
    function job(o) {
        o = o || {};
        if (!_fn('WTS_wp_system.solve') || !_fn('WTS_wp_model.read')) return _failJob('MISSING_ENGINE', ['the well performance engines are not available']);
        var src = sources(o), list = src.wells;
        if (Array.isArray(o.ids) && o.ids.length) { var want = o.ids.map(String); list = list.filter(function (w) { return want.indexOf(String(w.id)) !== -1; }); }
        if (!list.length) return _failJob('NO_WELLS', ['no well to run']);
        var st = { i: 0, done: false, cancelled: false, rows: [], evals: 0, ms: 0, res: null, warnings: src.warnings.slice() };
        function one(w) {
            var t0 = _now(), base = { id: w.id, name: w.name, active: !!w.active, origin: w.origin };
            var rd = readWell(w, { scalars: w.active ? o.liveScalars : null });
            if (!rd.ok) return Object.assign(base, { status: 'none', verdict: 'none', code: rd.code, error: rd.code === 'NO_INPUTS' ? 'no Well Performance inputs in this well' : 'the inputs could not be read', well: _wellGeo(null), curves: { ipr: [], vlp: [] }, flags: [], nWarn: 0, evals: 0, ms: 0 });
            var M = rd.M, W = null, R = null;
            try { W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: M.fluid.type, surface: M.surface }); } catch (e) { W = null; }
            try { R = G.WTS_wp_system.solve(M); } catch (e) { R = { ok: false, code: 'ENGINE_ERROR', errors: [String(e && e.message)] }; }
            // a gas well's loading margin as the page computes it (WTS_wp_loading when the solve carries none)
            var L = null;
            if (R && R.ok && !R.loading && _isGas(M.fluid.type) && _fn('WTS_wp_loading') && _fn('WTS_wp_fluid.build')) {
                try { L = G.WTS_wp_loading(R, G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W); } catch (e) { L = null; }
            }
            var row = Object.assign(base, summarise(M, R, W, L));
            row.ms = _now() - t0;
            return row;
        }
        function finish() {
            if (st.res) return st.res;
            var rows = st.rows, c = { n: rows.length, solved: 0, stable: 0, unstable: 0, failed: 0, none: 0, warn: 0 };
            var tot = { qo: 0, qw: 0, qg: 0, nOil: 0, nGas: 0 };
            rows.forEach(function (r) {
                if (r.status === 'none') { c.none++; return; }
                if (r.status !== 'ok') { c.failed++; return; }
                c.solved++;
                if (r.stable) c.stable++; else c.unstable++;
                if (r.verdict === 'warn') c.warn++;
                if (!r.stable) return;
                if (r.gas) tot.nGas++; else tot.nOil++;
                if (_fin(r.qo)) tot.qo += r.qo; if (_fin(r.qw)) tot.qw += r.qw; if (_fin(r.qg)) tot.qg += r.qg;
            });
            st.res = { ok: !st.cancelled && c.solved > 0, v: 1, code: st.cancelled ? 'CANCELLED' : (c.solved ? null : 'NO_SOLUTION'), rows: rows, totals: tot, counts: c,
                       evals: st.evals, ms: st.ms, cancelled: st.cancelled || undefined, errors: st.cancelled ? ['cancelled'] : (c.solved ? [] : ['no well could be solved']), warnings: st.warnings, ts: Date.now() };
            return st.res;
        }
        return {
            step: function () {
                if (!st.done && !st.cancelled) {
                    var r = one(list[st.i]);
                    st.rows.push(r); st.evals += r.evals || 0; st.ms += r.ms || 0; st.i++;
                    if (st.i >= list.length) st.done = true;
                } else st.done = true;
                var nx = list[st.i];
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / list.length), label: st.done ? 'done' : (nx.name + ' (' + (st.i + 1) + ' of ' + list.length + ')') };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / list.length; },
            result: function () { return finish(); },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; },
            wells: list.map(function (w) { return { id: w.id, name: w.name, active: w.active }; })
        };
    }

    // ── table / CSV ────────────────────────────────────────────────────────────────────────────────────────────────────
    var HEAD = ['Well', 'Fluid', 'Status', 'Rate (STB/d liquid | Mscf/d gas)', 'Oil (STB/d)', 'Water (BWPD)', 'Gas (Mscf/d)', 'Flowing BHP (psia)', 'THP (psig)', 'THT (°F)',
                'Bean (/64 in)', 'Stable', 'q / q_s − 1', 'Loading margin', 'Mid-perf MD (ft)', 'Mid-perf TVD (ft)', 'Max inclination (°)', 'Horizontal length (ft)', 'Correlation', 'Warnings'];
    function table(res) {
        var rows = ((res && res.rows) || []).map(function (r) {
            var g = r.well || {};
            return [r.name, r.fluid, r.status === 'ok' ? (r.verdict || 'ok') : (r.status === 'none' ? 'no inputs' : 'no solution'), r.q, r.qo, r.qw, r.qg, r.pwf, r.thp, r.tht, r.bean,
                    r.status === 'ok' ? (r.stable ? 'yes' : 'no') : '', r.marginQs, r.loadingMargin, g.midMd, g.midTvd, g.incMax, g.hzMd, r.corr ? r.corr + (r.provisional ? ' (provisional)' : '') : '', (r.flags || []).join(' ')];
        });
        return { head: HEAD.slice(), rows: rows };
    }
    function csv(res) {
        var T = table(res), q = function (v) { if (v == null) return ''; if (typeof v === 'number') return isFinite(v) ? String(+v.toPrecision(8)) : ''; var s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        return [T.head.map(q).join(',')].concat(T.rows.map(function (r) { return r.map(q).join(','); })).join('\n') + '\n';
    }

    // ── a model as a well stores it (the inverse of WTS_wp_model.read: page scalars + the table record) — for injected wells
    //    (tests, wellperf-validate X28a) ────────────────────────────────────────────────────────────────────────────────
    function _getPath(o, path) { var ks = path.split('.'); for (var i = 0; i < ks.length; i++) { if (o == null) return undefined; o = o[ks[i]]; } return o; }
    function storedFrom(M) {
        var Mm = G.WTS_wp_model, f = {};
        if (!Mm || !Mm.SCALARS || !M) return null;
        Object.keys(Mm.SCALARS).forEach(function (id) {
            var sp = Mm.SCALARS[id], v = _getPath(M, sp.path);
            if (v == null) return;
            if (sp.kind === 'num') { if (_fin(v)) f[id] = String(sp.scale ? v / sp.scale : v); }
            else if (sp.kind === 'bool') f[id] = !!v;
            else if (sp.kind === 'list') f[id] = Array.isArray(v) ? v.slice() : v;
            else f[id] = String(v);
        });
        var pr = (M.res && M.res.params) || {};
        Object.keys(pr).forEach(function (k) { if (_fin(pr[k])) f[(Mm.IP_PREFIX || 'wp_ip_') + k] = String(pr[k]); });
        var W0 = M.well || {}, Sf = M.surface || {};
        var rec = { v: 1, survey: W0.survey || [], strings: W0.strings || [], restrictions: W0.restrictions || [], geo: { points: (W0.geo && W0.geo.points) || [] },
                    flowline: Sf.flowline || [], rating: Sf.rating || {}, beans: Sf.beans || [], tests: M.tests || [] };
        var out = {}; out[PAGE_KEY] = JSON.stringify({ f: f }); out[MODEL_KEY] = JSON.stringify(rec);
        return out;
    }

    var NS = G.WTS_wp_batch = G.WTS_wp_batch || {};
    NS.storedFrom = storedFrom;
    NS.VERSION = VERSION; NS.HZ_INC = HZ_INC; NS.sources = sources; NS.readWell = readWell; NS.summarise = summarise; NS.job = job;
    NS.table = table; NS.csv = csv; NS.key = key;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, B = G.WTS_wp_batch, bad = [];
    try {
        var s = B.sources({ wells: [{ id: 'w1', name: 'A', active: true, keys: {} }, { id: 'w2', name: 'B', keys: { wts_page_wellperf: '{"f":{}}' } }] });
        if (!s.ok || s.wells.length !== 2 || s.wells[1].get('wts_page_wellperf') !== '{"f":{}}' || s.wells[0].get('x') !== null) bad.push('sources');
        if (B.readWell(s.wells[0]).code !== 'NO_INPUTS' && G.WTS_wp_model) bad.push('readWell NO_INPUTS');
        if (B.table({ rows: [] }).head.length !== 20) bad.push('table head');
    } catch (e) { bad.push('threw ' + e.message); }
    if (bad.length && typeof console !== 'undefined') console.error('[wp-batch self-test] ' + bad.join('; '));
})();
