// =============================================================================
// WTS — 49-calc-wp-cases.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance cases and depletion forecast (WP27, increment B) — docs/WELL-PERFORMANCE-PLAN.md §1.3 US18, §1.4 A3 / I1 / I2,
// §2.8 (cases[] in wts_wellperf_model), §8 (prediction), §16, D9, D17.
//
// CASES. A case is a named snapshot of the whole model: the page's scalar controls (the WTS_wp_model.SCALARS contract and the
//   wp_ip_<name> parameters, canonical field units) and the model tables (survey, strings, restrictions, geo, flowline, rating, beans,
//   lab, pump — never the tests or the cases themselves), with the summary of the solve it was saved with. Cases live in the model
//   record (wts_wellperf_model.cases, ≤ 20, per well, carried in project files); only the page writes them, through WTS_wp_model.write.
//   model(c) rebuilds the frozen model M of a case through WTS_wp_model.read on an in-memory record, so a case is solved by the same
//   reader and the same solver as the page. compare(cases) is a Job: one cold WTS_wp_system.solve per case (the models differ in any
//   input, so no warm start), the first case is the reference; each row carries its R-summary, its IPR and outflow curves, the rate
//   change against the reference and the inputs that differ (diff).
// DEPLETION FORECAST (§8). Two modes, both driven by WTS_wp_system.solve (nothing here marches or roots by itself):
//   'steps' (the default): a list of future p̄r (optionally WC, GOR, WGR, CGR per step) → the operating point per step (the first
//     step a cold solve — the single solve exactly when its p̄r is the model's; every later step a tracking solve warm-started from the
//     step before on the same frozen step layout), the onset of liquid loading (gas wells: the first step with a loading margin < 0,
//     with the limiting depth MD and TVD) and the step where lift is needed (the first step with no stable operating point).
//   'tank': rate against time and the cumulative by explicit stepping on a tank model — production over a step at the rate of its
//     start (forward Euler), p̄r at the end of the step from the material balance:
//       gas (volumetric, dry or wet gas): p/Z = (p_i/Z_i)·(1 − G_p/G), Z of the well-stream gas (WTS_gaspvt_z with the impurities),
//         G_p = separator gas × the well-stream gas factor of a wet gas (WTS_wp_fluid.recombine: condensate vapour equivalent);
//       oil (Havlena & Odeh 1963 straight line with the user's N, no aquifer): F = N·(E_o + m·E_g + E_f,w) with
//         F = N_p·[B_o + (R_p − R_s)·B_g] + W_p·B_w, E_o = (B_o − B_oi) + (R_si − R_s)·B_g, E_g = B_oi·(B_g/B_gi − 1),
//         E_f,w = (1 + m)·B_oi·(c_w·S_wi + c_f)/(1 − S_wi)·Δp; PVT from the model's fluid (WTS_wp_fluid.table, the same correlations as
//         the march); R_p = the model's producing GOR, held (no relative-permeability gas breakthrough: optimistic below p_b).
//     The tank models have no verified published example yet (Q9): every tank result is verified:false with the provisional label
//     and the tank mode is never the default (D17; wellperf-validate BENCH forecast gasTank / oilTank 'pending').
//   Decline / EUR cross-check against 35-rta-dca: when PRiSM_declineResults() has a decline fit ({ok, eur, remaining, units}), the
//   forecast cumulative is set next to the decline's remaining volume (information only).
// EVALUATIONS (§16). One cold solve (≈ 16–22 E) + ≈ 4–6 E per tracked step; 24 steps ≤ 160 E (wellperf-validate --time).
//
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_cases
//     .KINDS ['base', 'matched', 'proposed', 'other'], .MAX 20, .TABLES (the table keys a case carries)
//     .make({name, kind, note, scalars, tables, R?, date?}) → {ok, case:{id, name, kind, note, date, v:1, scalars, tables, summary}, …}
//     .summary(R)                  → the R-summary {ok, code, q, qo, qw, qg, qL, pwf, thp, tht, stable, qs, loadingMargin, regime, ero, corr}
//     .model(c)                    → the frozen model M of the case (WTS_wp_model.read on an in-memory record) or null
//     .add(list, c) / .remove(list, id) / .rename(list, id, name) → {ok, list, errors}   (pure list operations; a case with the same
//                                    name (any letter case) is replaced; ≤ MAX)
//     .diff(a, b)                  → {scalars:[{id, a, b}], tables:[{key, a, b}]}   (a, b = cases)
//     .compare(cases, o?)          → Job: result() → {ok, ref, rows:[{id, name, kind, R, curves:{ipr:[{q, p}], vlp:[{q, p}]}, dq, dqPct,
//                                    diff}], rateUnit, evals, cancelled?}
//     .csv(result)                 → string
//   WTS_wp_forecast
//     .PROVISIONAL, .MODES ['steps', 'tank'], .DEFAULT_MODE 'steps'
//     .tank(M, spec)               → {ok, kind:'gas'|'oil', verified:false, provisional, pi, cum0, pAt(cum) → p̄r | null, at(p) → MB terms,
//                                    G | N, …}   pure material balance (no solve)
//     .job(M, spec)                → Job: result() → {ok, mode, kind, rows:[{i, t_d, pr, ok, q, qo, qw, qg, qL, pwf, thp, tht, stable,
//                                    loadingMargin, limitingMd, limitingTvd, regime, Np, Gp, Wp, phase:'flowing'|'loading'|'dead', tracked,
//                                    mb?}], events:{loading, lift, abandon}, totals, tank, decline, rateUnit, evals, verified, provisional}
//                                    spec = {mode, steps:[{pr, wc?, gor?, wgr?, cgr?}] | tank:{G_Bscf | N_MMstb, cum0, pi, m, swi, cw, cf},
//                                    horizon_d, n (≤ 60), pAband, qAband}
//     .csv(result)                 → string
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var PROVISIONAL = 'provisional — not verified against a published example';
    var KINDS = ['base', 'matched', 'proposed', 'other'];
    var MAX = 20, MAX_STEPS = 60, PATM = 14.696;
    var TABLES = ['survey', 'strings', 'restrictions', 'geo', 'flowline', 'rating', 'beans', 'lab', 'pump'];
    var GAS = ['gas', 'condensate', 'gasinj'];

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _get(o, path, d) { var c = o; for (var i = 0; i < path.length; i++) { if (c == null) return d; c = c[path[i]]; } return c === undefined ? d : c; }
    function _fn(path) { var p = path.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]]; return typeof f === 'function' && (G.__WP_STUBS || []).indexOf(path) === -1 ? f : null; }
    function _f(x, dp) { if (!_fin(x)) return '–'; return (+x.toFixed(dp == null ? 2 : dp)).toString(); }
    function _isGas(t) { return GAS.indexOf(t) !== -1; }
    function _type(M) { return _get(M, ['fluid', 'type'], 'oil') || 'oil'; }
    function _rateUnit(t) { return t === 'oil' ? 'STB/d liquid' : t === 'water' || t === 'waterinj' ? 'BWPD' : 'Mscf/d'; }
    function _mainQ(t, s) { return !s || !s.ok ? null : (_isGas(t) ? s.qg : s.q); }
    function _cell(x) {
        if (x == null) return '';
        if (typeof x === 'number') return isFinite(x) ? String(+x.toPrecision(10)) : '';
        var s = String(x); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function _failJob(code, errors, warnings) {
        var res = { ok: false, code: code, rows: [], evals: 0, errors: errors, warnings: warnings || [] };
        return { step: function () { return { done: true, progress: 1, label: '' }; }, done: function () { return true; }, progress: function () { return 1; },
            result: function () { return res; }, cancel: function () { }, errors: errors, code: code };
    }
    // a small reverse-communication Job (one solve per step): spec = {n, next(i) → true when done, finish(), label(i)}
    function _job(spec) {
        var st = { i: 0, done: false, cancelled: false, res: null };
        return {
            n: spec.n,
            step: function () {
                if (!st.done && !st.cancelled) { var r = spec.next(st.i); st.i++; if (r === true || st.i >= spec.n) st.done = true; }
                else st.done = true;
                if (st.done && !st.res) st.res = st.cancelled ? spec.cancelled() : spec.finish();
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / Math.max(1, spec.n)), label: st.done ? 'done' : spec.label(st.i) };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / Math.max(1, spec.n); },
            result: function () { if (!st.res) st.res = st.cancelled ? spec.cancelled() : spec.finish(); return st.res; },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
    }

    // ── the R-summary (the fields the cases, the forecast and the page read) ─────────────────────────────────────────────────
    function summary(R) {
        var ok = !!(R && R.ok && R.op);
        var s = { ok: ok, code: ok ? null : ((R && R.code) || 'FAILED'), error: ok ? null : ((R && R.errors && R.errors[0]) || 'no operating point'),
            q: ok ? R.op.q : null, qo: null, qw: null, qg: null, qL: null, pwf: ok ? (_fin(R.pwf) ? R.pwf : R.op.p) : null, thp: null, tht: null,
            stable: ok ? !!R.op.stable : false, qs: ok && R.qs && _fin(R.qs.q) ? R.qs.q : null, loadingMargin: null, limitingMd: null, limitingTvd: null,
            regime: null, ero: null, corr: R && R.corr ? R.corr.well || null : null, tracked: !!(R && R.tracked), evals: R ? (R.evals || 0) : 0 };
        if (ok) {
            var rt = R.rates || {}, sf = R.surface || {};
            ['qo', 'qw', 'qg', 'qL'].forEach(function (k) { s[k] = _fin(rt[k]) ? rt[k] : null; });
            s.thp = _fin(sf.thp_psig) ? sf.thp_psig : null; s.tht = _fin(sf.tht) ? sf.tht : null;
            s.regime = sf.choke && sf.choke.present !== false ? (sf.choke.regime || null) : null;
            if (R.loading && _fin(R.loading.margin)) { s.loadingMargin = R.loading.margin; s.limitingMd = _fin(R.loading.limitingMd) ? R.loading.limitingMd : null; s.limitingTvd = _fin(R.loading.limitingTvd) ? R.loading.limitingTvd : null; }
            s.ero = R.velocities && _fin(R.velocities.eroMax) ? R.velocities.eroMax : null;
        }
        return s;
    }

    // ── cases ────────────────────────────────────────────────────────────────
    function _cleanName(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40); }
    function _id() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
    function _scalarsOk(o) {
        var W = G.WTS_wp_model, S = (W && W.SCALARS) || {}, P = (W && W.IP_PREFIX) || 'wp_ip_', out = {};
        Object.keys(o || {}).forEach(function (id) {
            if (!(S[id] || (id.indexOf(P) === 0 && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id.slice(P.length))))) return;
            var v = o[id];
            if (v == null || typeof v === 'number' || typeof v === 'boolean') out[id] = (typeof v === 'number' && !isFinite(v)) ? null : v;
            else if (Array.isArray(v)) out[id] = v.map(_n).filter(_fin).slice(0, 50);
            else out[id] = String(v).slice(0, 200);
        });
        return out;
    }
    function make(o) {
        o = o || {};
        var errors = [], warnings = [], name = _cleanName(o.name);
        if (!name) errors.push('a case needs a name');
        var kind = KINDS.indexOf(o.kind) !== -1 ? o.kind : 'other';
        var sc = _scalarsOk(o.scalars);
        if (!Object.keys(sc).length) errors.push('the case has no input values');
        var tb = {};
        TABLES.forEach(function (k) { if (o.tables && o.tables[k] !== undefined) tb[k] = _clone(o.tables[k]); });
        if (errors.length) return { ok: false, errors: errors, warnings: warnings };
        var c = { v: 1, id: (typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(o.id)) ? o.id : _id(), name: name, kind: kind,
            note: _cleanName(o.note).slice(0, 40), date: typeof o.date === 'string' ? o.date.slice(0, 24) : new Date().toISOString().slice(0, 16).replace('T', ' '),
            scalars: sc, tables: tb, summary: o.R ? summary(o.R) : null };
        return { ok: true, case: c, errors: [], warnings: warnings };
    }
    function _mem(rec) { var d = {}; d.wts_wellperf_model = JSON.stringify(rec); return { getItem: function (k) { return k in d ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; } }; }
    function model(c) {
        var W = G.WTS_wp_model;
        if (!c || typeof c !== 'object' || !W || typeof W.read !== 'function' || typeof W.empty !== 'function') return null;
        var rec = W.empty();
        TABLES.forEach(function (k) { if (c.tables && c.tables[k] !== undefined && c.tables[k] !== null) rec[k] = _clone(c.tables[k]); });
        try { return W.read({ storage: _mem(rec), scalars: c.scalars || {} }); } catch (e) { return null; }
    }
    function add(list, c) {
        var L = Array.isArray(list) ? _clone(list) : [];
        if (!c || !c.name) return { ok: false, list: L, errors: ['not a case'] };
        var i = L.findIndex ? L.findIndex(function (x) { return x && String(x.name).toLowerCase() === String(c.name).toLowerCase(); }) : -1;
        if (i !== -1) { var keepId = L[i].id; L[i] = _clone(c); L[i].id = keepId; return { ok: true, list: L, replaced: true, errors: [] }; }
        if (L.length >= MAX) return { ok: false, list: L, code: 'FULL', errors: ['at most ' + MAX + ' cases per well: delete one first'] };
        L.push(_clone(c));
        return { ok: true, list: L, replaced: false, errors: [] };
    }
    function remove(list, id) { var L = (Array.isArray(list) ? list : []).filter(function (x) { return x && x.id !== id; }); return { ok: true, list: _clone(L), errors: [] }; }
    function rename(list, id, name) {
        var nm = _cleanName(name), L = Array.isArray(list) ? _clone(list) : [];
        if (!nm) return { ok: false, list: L, errors: ['a case needs a name'] };
        if (L.some(function (x) { return x && x.id !== id && String(x.name).toLowerCase() === nm.toLowerCase(); })) return { ok: false, list: L, errors: ['another case has that name'] };
        L.forEach(function (x) { if (x && x.id === id) x.name = nm; });
        return { ok: true, list: L, errors: [] };
    }
    function _same(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
    function diff(a, b) {
        var out = { scalars: [], tables: [] };
        if (!a || !b) return out;
        var sa = a.scalars || {}, sb = b.scalars || {}, ids = {};
        Object.keys(sa).concat(Object.keys(sb)).forEach(function (k) { ids[k] = 1; });
        Object.keys(ids).sort().forEach(function (id) {
            var x = sa[id], y = sb[id];
            var nx = _n(x), ny = _n(y);
            if (_fin(nx) && _fin(ny) ? Math.abs(nx - ny) > 1e-9 * Math.max(1, Math.abs(nx)) : !_same(x === '' ? null : x, y === '' ? null : y)) out.scalars.push({ id: id, a: x == null ? null : x, b: y == null ? null : y });
        });
        TABLES.forEach(function (k) {
            var x = a.tables ? a.tables[k] : undefined, y = b.tables ? b.tables[k] : undefined;
            if (!_same(x, y)) out.tables.push({ key: k, a: Array.isArray(x) ? x.length : (x == null ? 0 : 1), b: Array.isArray(y) ? y.length : (y == null ? 0 : 1) });
        });
        return out;
    }
    function compare(cases, o) {
        o = o || {};
        var list = (Array.isArray(cases) ? cases : []).filter(function (c) { return c && c.scalars; }).slice(0, MAX);
        if (!_fn('WTS_wp_system.solve')) return _failJob('MISSING_ENGINE', ['WTS_wp_system.solve is not available']);
        if (list.length < 1) return _failJob('NO_CASES', ['select at least one case to compare']);
        var SY = G.WTS_wp_system, rows = [], evals = 0;
        return _job({
            n: list.length,
            next: function (i) {
                var c = list[i], M = model(c), R = M ? SY.solve(M) : { ok: false, code: 'NO_MODEL', errors: ['the case could not be read'] };
                evals += (R && R.evals) || 0;
                var s = summary(R), cur = { ipr: [], vlp: [] };
                if (R && R.curves) {
                    cur.ipr = (R.curves.ipr || []).map(function (p) { return { q: p.q, p: _fin(p.p) ? p.p : p.pwf }; }).filter(function (p) { return _fin(p.p); });
                    cur.vlp = (R.curves.vlp || []).map(function (p) { return { q: p.q, p: _fin(p.p) ? p.p : p.pwf }; }).filter(function (p) { return _fin(p.p); });
                }
                rows.push({ id: c.id, name: c.name, kind: c.kind, R: s, curves: cur, node: R && R.node, op: s.ok ? { q: s.q, p: R.op.p } : null,
                    fluidType: M ? _type(M) : null, saved: c.summary || null });
                return false;
            },
            label: function (i) { return 'case ' + (list[Math.min(i, list.length - 1)].name) + ' (' + (i + 1) + ' of ' + list.length + ')'; },
            cancelled: function () { return { ok: false, code: 'CANCELLED', cancelled: true, rows: [], evals: 0, errors: ['cancelled'], warnings: [] }; },
            finish: function () {
                var ref = rows[0], t = ref && ref.fluidType ? ref.fluidType : 'oil', warnings = [];
                var mixed = rows.some(function (r) { return r.fluidType && _isGas(r.fluidType) !== _isGas(t); });
                if (mixed) warnings.push(_w('MIXED_FLUIDS', 'The cases mix oil and gas wells: their rates are on different bases.'));
                var qRef = _mainQ(t, ref && ref.R);
                rows.forEach(function (r, i) {
                    var q = _mainQ(r.fluidType || t, r.R);
                    r.dq = (i && _fin(q) && _fin(qRef)) ? q - qRef : null;
                    r.dqPct = (i && _fin(q) && _fin(qRef) && qRef > 0) ? 100 * (q / qRef - 1) : null;
                    r.diff = i ? diff(list[0], list[i]) : { scalars: [], tables: [] };
                });
                return { ok: rows.some(function (r) { return r.R.ok; }), ref: ref ? ref.id : null, rows: rows, rateUnit: _rateUnit(t), fluidType: t, evals: evals,
                    errors: rows.some(function (r) { return r.R.ok; }) ? [] : ['no case has an operating point'], warnings: warnings };
            }
        });
    }
    function csvCases(res) {
        if (!res || !Array.isArray(res.rows) || !res.rows.length) return '';
        var L = [_cell('Well Performance cases compared — field units; reference: ' + res.rows[0].name)];
        L.push(['Case', 'Kind', 'Rate (' + res.rateUnit + ')', 'Δ vs reference (%)', 'q_o (STB/d)', 'q_w (BWPD)', 'q_g (Mscf/d)', 'pwf (psia)', 'THP (psig)', 'THT (°F)', 'Stable', 'q_s', 'Loading margin (%)', 'Choke regime', 'Inputs that differ'].map(_cell).join(','));
        res.rows.forEach(function (r) {
            var s = r.R || {};
            L.push([r.name, r.kind, _mainQ(r.fluidType || res.fluidType, s), r.dqPct, s.qo, s.qw, s.qg, s.pwf, s.thp, s.tht, s.ok ? (s.stable ? 'yes' : 'no') : (s.error || ''), s.qs,
                _fin(s.loadingMargin) ? 100 * s.loadingMargin : null, s.regime || '', r.diff ? r.diff.scalars.map(function (d) { return d.id; }).concat(r.diff.tables.map(function (d) { return d.key; })).join(' ') : ''].map(_cell).join(','));
        });
        return L.join('\n');
    }

    // ── material balance (tank) ──────────────────────────────────────────────
    function _bisect(f, lo, hi, n) {
        var flo = f(lo), fhi = f(hi);
        if (!_fin(flo) || !_fin(fhi) || flo * fhi > 0) return null;
        for (var i = 0; i < (n || 80); i++) {
            var mid = 0.5 * (lo + hi), fm = f(mid);
            if (!_fin(fm)) return null;
            if (fm === 0) return mid;
            if (fm * flo < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
            if (hi - lo < 1e-7 * Math.max(1, hi)) break;
        }
        return 0.5 * (lo + hi);
    }
    function tank(M, spec) {
        spec = spec || {};
        var errors = [], warnings = [], t = _type(M);
        if (!M || !M.fluid || !M.res) return { ok: false, code: 'NO_MODEL', errors: ['the model is incomplete'], warnings: [] };
        if (t === 'water' || t === 'waterinj' || t === 'gasinj') return { ok: false, code: 'NOT_APPLICABLE', errors: ['the tank forecast applies to oil, gas and gas-condensate producers'], warnings: [] };
        if (!_fn('WTS_wp_fluid.build')) return { ok: false, code: 'MISSING_ENGINE', errors: ['WTS_wp_fluid.build is not available'], warnings: [] };
        var T = _n(M.res.T_F), pr = _n(M.res.pr);
        if (!_fin(T)) errors.push('the reservoir temperature is needed');
        var pi = _fin(_n(spec.pi)) ? _n(spec.pi) : pr, cum0 = _fin(_n(spec.cum0)) ? Math.max(0, _n(spec.cum0)) : 0;
        if (!_fin(pi) || pi <= PATM) errors.push('the initial reservoir pressure p_i (or p̄r) is needed');
        if (cum0 > 0 && !_fin(_n(spec.pi))) errors.push('with a cumulative to date, enter the initial reservoir pressure p_i');
        var F = errors.length ? null : G.WTS_wp_fluid.build(M.fluid, { T_F: T });
        if (!errors.length && !(F && F.ok)) errors.push((F && F.errors && F.errors[0]) || 'the fluid could not be built');
        if (errors.length) return { ok: false, code: 'BAD_INPUT', errors: errors, warnings: warnings };
        var base = { ok: true, verified: false, provisional: PROVISIONAL, T_F: T, pi: pi, cum0: cum0, warnings: warnings, errors: [] };
        if (_isGas(t)) {
            var Gb = _n(spec.G_Bscf);
            if (!(Gb > 0)) return { ok: false, code: 'BAD_INPUT', errors: ['the gas in place G (Bscf) is needed'], warnings: [] };
            var Gs = Gb * 1e6;                                       // Mscf
            if (!_fn('WTS_gaspvt_z')) return { ok: false, code: 'MISSING_ENGINE', errors: ['WTS_gaspvt_z is not available'], warnings: [] };
            var sg = _fin(F.sgWell) ? F.sgWell : F.sgg, imp = F.imp || null, wgf = 1;
            if (t === 'condensate' && _fn('WTS_wp_fluid.recombine') && +F.cgr > 0) { var rc = G.WTS_wp_fluid.recombine({ sgSep: F.sgg, apiST: F.api, cgr: F.cgr }); if (rc && rc.ok && _fin(rc.wellGasFactor)) wgf = rc.wellGasFactor; }
            var zAt = function (p) { var o = { sg: sg, p: p, t: T }; if (imp) { o.n2 = imp.n2; o.co2 = imp.co2; o.h2s = imp.h2s; } var r = G.WTS_gaspvt_z(o); return r && r.ok && _fin(r.z) ? r.z : null; };
            var zi = zAt(pi); if (!_fin(zi)) return { ok: false, code: 'Z_FAILED', errors: ['Z could not be evaluated at p_i'], warnings: [] };
            var poz = function (p) { var z = zAt(p); return _fin(z) ? p / z : null; };
            var piz = pi / zi;
            if (cum0 >= Gs) return { ok: false, code: 'BAD_INPUT', errors: ['the cumulative to date is not below the gas in place'], warnings: [] };
            return Object.assign(base, { kind: 'gas', G: Gs, G_Bscf: Gb, sgWell: sg, wellGasFactor: wgf, piz: piz, zi: zi, cumUnit: 'Mscf (well-stream)',
                pAt: function (Gp) {
                    var target = piz * (1 - Gp / Gs);
                    if (!(target > 0)) return null;
                    return _bisect(function (p) { var v = poz(p); return _fin(v) ? v - target : NaN; }, 15, pi * 1.0000001, 90);
                },
                at: function (p) { var z = zAt(p); return { p: p, z: z, poz: _fin(z) ? p / z : null, GpFrac: _fin(z) ? 1 - (p / z) / piz : null }; },
                step: function (st0, dGp) { var Gp = st0.cum + dGp, p = this.pAt(Gp); return _fin(p) ? { p: p, cum: Gp } : null; },
                prodRate: function (s) { return s && s.ok && _fin(s.qg) ? s.qg * wgf : 0; }
            });
        }
        var Nm = _n(spec.N_MMstb);
        if (!(Nm > 0)) return { ok: false, code: 'BAD_INPUT', errors: ['the oil in place N (MMSTB) is needed'], warnings: [] };
        var N = Nm * 1e6, m = _fin(_n(spec.m)) ? Math.max(0, _n(spec.m)) : 0, swi = _fin(_n(spec.swi)) ? Math.min(0.9, Math.max(0, _n(spec.swi))) : 0.2;
        var cw = _fin(_n(spec.cw)) ? Math.max(0, _n(spec.cw)) : 3e-6, cf = _fin(_n(spec.cf)) ? Math.max(0, _n(spec.cf)) : 4e-6;
        var retained = spec.gas === 'retained';
        var sgc = _fin(_n(spec.sgc)) ? Math.min(0.5, Math.max(0, _n(spec.sgc))) : 0.05, nO = _fin(_n(spec.no)) && _n(spec.no) > 0 ? _n(spec.no) : 3, nG = _fin(_n(spec.ng)) && _n(spec.ng) > 0 ? _n(spec.ng) : 2;
        var row = function (p) { var tb = F.table([p], T); var r = tb && tb.ok ? tb.rows[0] : null; if (!(r && _fin(r.bo) && _fin(r.rs) && _fin(r.bg))) return null; r.bgB = r.bg / 5.614583; return r; };   // B_g in rb/scf
        var r0 = row(pi); if (!r0) return { ok: false, code: 'PVT_FAILED', errors: ['the PVT could not be evaluated at p_i'], warnings: [] };
        var Boi = r0.bo, Rsi = r0.rs, Bgi = r0.bgB, pb = F.pb(T);
        var cEff = (1 + m) * Boi * (cw * swi + cf) / (1 - swi);
        var terms = function (p) {
            var r = row(p); if (!r) return null;
            var Eo = (r.bo - Boi) + (Rsi - r.rs) * r.bgB, Eg = Boi * (r.bgB / Bgi - 1), Efw = cEff * (pi - p);
            return { p: p, bo: r.bo, rs: r.rs, bg: r.bgB, bw: r.bw, muo: r.muo, mug: r.mug, Eo: Eo, Eg: Eg, Efw: Efw, Et: Eo + m * Eg + Efw };
        };
        // Havlena-Odeh with the cumulatives: F = N_p·B_o + (G_p − N_p·R_s)·B_g + W_p·B_w = N·E_t
        var Fof = function (tt, Np, Gp, Wp) { return Np * tt.bo + (Gp - Np * tt.rs) * tt.bg + (Wp || 0) * (_fin(tt.bw) ? tt.bw : 1); };
        var gMB = function (Np, Gp, Wp) { return function (p) { var tt = terms(p); return tt ? N * tt.Et - Fof(tt, Np, Gp, Wp) : NaN; }; };
        var pAtGp = function (Np, Gp, Wp, hi) { if (!(Np > 0) && !(Wp > 0)) return pi; return _bisect(gMB(Np, Gp, Wp), 20, _fin(hi) ? Math.min(pi, hi * 1.0000001) : pi, 80); };
        // the oil-zone saturations from the material balance (S_o = (1 − S_wi)(1 − N_p/N)·B_o/B_oi) and the instantaneous producing GOR
        // R = R_s + (k_rg/k_ro)·(μ_o·B_o)/(μ_g·B_g) with Corey curves k_ro = (S_o/(1 − S_wi))^n_o, k_rg = ((S_g − S_gc)/(1 − S_wi − S_gc))^n_g
        var satOf = function (tt, Np) { var So = Math.max(0, Math.min(1 - swi, (1 - swi) * (1 - Np / N) * tt.bo / Boi)); return { so: So, sg: Math.max(0, 1 - swi - So) }; };
        var gorOf = function (tt, Np) {
            var sa = satOf(tt, Np);
            if (retained || sa.sg <= sgc) return { R: tt.rs, so: sa.so, sg: sa.sg, krg: 0, kro: 1 };
            var kro = Math.pow(Math.max(1e-9, sa.so / (1 - swi)), nO), krg = Math.pow(Math.min(1, (sa.sg - sgc) / Math.max(1e-9, 1 - swi - sgc)), nG);
            var R = tt.rs + (krg / kro) * (tt.muo * tt.bo) / (tt.mug * tt.bg);
            return { R: Math.min(R, 1e6), so: sa.so, sg: sa.sg, krg: krg, kro: kro };
        };
        warnings.push(_w('SGC', retained ? 'The liberated gas stays in the reservoir (no free gas produced): below the bubble point the forecast pressure decline is optimistic.'
            : 'Solution-gas drive: below the bubble point the producing GOR = R_s + (k_rg/k_ro)·(μ_o·B_o)/(μ_g·B_g) with Corey curves (S_gc ' + _f(100 * sgc, 1) + ' %, n_o ' + _f(nO, 1) + ', n_g ' + _f(nG, 1) + ') on the material-balance saturations.', 'info'));
        return Object.assign(base, { kind: 'oil', N: N, N_MMstb: Nm, m: m, swi: swi, cw: cw, cf: cf, sgc: sgc, no: nO, ng: nG, gas: retained ? 'retained' : 'corey', Boi: Boi, Rsi: Rsi, Bgi: Bgi, pb: pb, cumUnit: 'STB',
            pAtGp: pAtGp,
            // one explicit step: the oil and water of the step (STB) at the state's producing GOR → the new state (p from Havlena-Odeh)
            step: function (st0, dNp, dWp) {
                var t0 = terms(st0.p); if (!t0) return null;
                var g0 = gorOf(t0, st0.cum), Np = st0.cum + dNp, Wp = (st0.wp || 0) + (dWp || 0), Gp = (st0.gp || 0) + g0.R * dNp;
                var p = pAtGp(Np, Gp, Wp, st0.p);
                if (!_fin(p)) return null;
                var t1 = terms(p), g1 = t1 ? gorOf(t1, Np) : null;
                return { p: p, cum: Np, gp: Gp, wp: Wp, sg: g1 ? g1.sg : null, gor: g1 ? g1.R : null, gorStep: g0.R };
            },
            gorAt: function (p, Np) { var tt = terms(p); return tt ? gorOf(tt, Np || 0) : null; },
            at: function (p, Np, Gp, Wp) { var tt = terms(p); if (!tt) return null; tt.F = Fof(tt, Np || 0, Gp || 0, Wp || 0); tt.N = N; tt.sg = satOf(tt, Np || 0).sg; return tt; },
            prodRate: function (s) { return s && s.ok && _fin(s.qo) ? s.qo : 0; }
        });
    }

    // ── the forecast Job ─────────────────────────────────────────────────────
    function _num(list, k) { return list.map(function (s) { return s ? _n(s[k]) : null; }); }
    function job(M, spec) {
        spec = spec || {};
        if (!_fn('WTS_wp_system.solve')) return _failJob('MISSING_ENGINE', ['WTS_wp_system.solve is not available']);
        if (!M || !M.res || !M.fluid || !M.surface || !M.system) return _failJob('NO_MODEL', ['the model is incomplete']);
        var mode = spec.mode === 'tank' ? 'tank' : 'steps', t = _type(M), gas = _isGas(t), SY = G.WTS_wp_system, warnings = [];
        var steps = [], TK = null, n, dt = null;
        if (mode === 'steps') {
            steps = (Array.isArray(spec.steps) ? spec.steps : []).map(function (s) { return (typeof s === 'number' || typeof s === 'string') ? { pr: _n(s) } : s; })
                .filter(function (s) { return s && _fin(_n(s.pr)) && _n(s.pr) > PATM; }).slice(0, MAX_STEPS);
            if (!steps.length) return _failJob('NO_STEPS', ['enter the future reservoir pressures (psia), one per step']);
            n = steps.length;
        } else {
            TK = tank(M, spec.tank || {});
            if (!TK.ok) return _failJob(TK.code || 'BAD_TANK', TK.errors || ['the tank model could not be built'], TK.warnings);
            var hz = _n(spec.horizon_d); n = Math.round(_n(spec.n) || 24);
            if (!(hz > 0)) return _failJob('BAD_INPUT', ['the forecast horizon (days) is needed']);
            n = Math.max(2, Math.min(MAX_STEPS, n));
            dt = hz / n; n = n + 1;                                   // rows at t = 0, dt, …, horizon
            warnings = warnings.concat(TK.warnings || []);
        }
        var pAband = _n(spec.pAband), qAband = _n(spec.qAband), base = _clone(M), modelPr = _n(M.res.pr);
        var rows = [], st = { grid: null, prev: null, cum: TK ? TK.cum0 : 0, wp: 0, gp: 0, sg: 0, dead: false, stop: null, evals: 0, tk: null };
        var ev = { loading: null, lift: null, abandon: null };
        function solveAt(i, pr, extra) {
            var Mx = _clone(base);
            Mx.res.pr = pr;
            if (extra) ['wc', 'gor', 'wgr', 'cgr'].forEach(function (k) { var v = _n(extra[k]); if (_fin(v)) Mx.fluid[k] = k === 'wc' ? (v > 1 ? v / 100 : v) : v; });
            var R, exactBase = i === 0 && _fin(modelPr) && Math.abs(pr - modelPr) <= 1e-9 * modelPr && !(extra && ['wc', 'gor', 'wgr', 'cgr'].some(function (k) { return _fin(_n(extra[k])); }));
            if (i === 0 || !st.prev || !st.prev.ok) R = SY.solve(exactBase ? base : Mx);
            else { var o = {}; if (st.grid) o.warm = st.grid; o.track = { q: st.prev.q, slope: st.prev.dDdq }; R = SY.solve(Mx, o); }
            if (!st.grid && R && R.grid && (R.grid.fine || R.grid.coarse)) st.grid = R.grid;
            st.evals += (R && R.evals) || 0;
            var s = summary(R);
            s.dDdq = R && R.op ? R.op.dDdq : null;
            return s;
        }
        function record(i, tDay, pr, s, extra) {
            var phase = !s.ok || !s.stable ? 'dead' : (_fin(s.loadingMargin) && s.loadingMargin < 0 ? 'loading' : 'flowing');
            var r = { i: i, t_d: tDay, pr: pr, ok: s.ok, q: s.q, qo: s.qo, qw: s.qw, qg: s.qg, qL: s.qL, pwf: s.pwf, thp: s.thp, tht: s.tht, stable: s.stable,
                loadingMargin: s.loadingMargin, limitingMd: s.limitingMd, limitingTvd: s.limitingTvd, regime: s.regime, ero: s.ero, tracked: s.tracked, evals: s.evals,
                phase: phase, error: s.ok ? null : s.error, Np: null, Gp: null, Wp: null };
            if (extra) { r.wc = _n(extra.wc); r.gor = _n(extra.gor); }
            if (TK) { if (gas) r.Gp = st.cum; else { r.Np = st.cum; r.Wp = st.wp; r.Gp = st.gp; r.sg = st.sg; } }
            if (phase === 'loading' && !ev.loading) ev.loading = { i: i, t_d: tDay, pr: pr, md: s.limitingMd, tvd: s.limitingTvd, margin: s.loadingMargin };
            if (phase === 'dead' && !ev.lift) ev.lift = { i: i, t_d: tDay, pr: pr, reason: s.ok ? 'the operating point is statically unstable' : (s.error || 'no operating point') };
            if (TK && gas) { var a = TK.at(pr); r.mb = a ? { poz: a.poz, z: a.z } : null; }
            else if (TK) { var b = TK.at(pr, st.cum, st.gp, st.wp); r.mb = b ? { Et: b.Et, Eo: b.Eo, Eg: b.Eg, Efw: b.Efw, F: b.F, sg: b.sg } : null; }
            rows.push(r);
            return r;
        }
        var label = function (i) { var k = Math.min(i, n - 1); return mode === 'steps' ? 'p̄r ' + _f(_n(steps[k].pr), 0) + ' psia (' + (k + 1) + ' of ' + n + ')' : 'day ' + _f(k * dt, 0) + ' (' + (k + 1) + ' of ' + n + ')'; };
        return _job({
            n: n,
            next: function (i) {
                if (mode === 'steps') {
                    var sp = steps[i], prS = _n(sp.pr), s = solveAt(i, prS, sp);
                    record(i, null, prS, s, sp);
                    st.prev = s.ok && s.stable ? s : st.prev;
                    if (_fin(pAband) && prS <= pAband && !ev.abandon) ev.abandon = { i: i, pr: prS, reason: 'p̄r at the abandonment pressure' };
                    return false;
                }
                // tank: the state at the start of this step (explicit stepping: the step before produced at its start rate)
                if (i === 0) {
                    var p0 = TK.pi;
                    if (TK.cum0 > 0) p0 = gas ? TK.pAt(TK.cum0) : TK.pAtGp(TK.cum0, _fin(_n((spec.tank || {}).gp0)) ? _n(spec.tank.gp0) : TK.cum0 * TK.Rsi, 0);
                    st.tk = _fin(p0) ? { p: p0, cum: TK.cum0, gp: gas ? 0 : (_fin(_n((spec.tank || {}).gp0)) ? _n(spec.tank.gp0) : TK.cum0 * TK.Rsi), wp: 0, sg: 0, gor: null } : null;
                }
                var p = st.tk ? st.tk.p : null;
                if (i === 0 && _fin(modelPr) && _fin(p) && Math.abs(p / modelPr - 1) > 0.02) warnings.push(_w('TANK_PR', 'The tank pressure at the start (' + _f(p, 0) + ' psia from p_i and the cumulative to date) differs from the model p̄r (' + _f(modelPr, 0) + ' psia) by more than 2 %: the forecast starts from the tank pressure.'));
                if (!_fin(p)) { st.stop = 'TANK_EMPTY'; ev.abandon = ev.abandon || { i: i, t_d: i * dt, pr: null, reason: 'the tank is depleted (the cumulative exceeds the material balance)' }; return true; }
                st.cum = st.tk.cum; st.wp = st.tk.wp || 0; st.gp = st.tk.gp || 0; st.sg = st.tk.sg || 0;
                // oil: the producing GOR of the step before (dissolved gas, plus the free gas above S_gc) goes into the outflow
                var ex = (!gas && _fin(st.tk.gor) && Math.abs(st.tk.gor - (_n(base.fluid.gor) || 0)) > 0.5) ? { gor: Math.max(0, Math.min(50000, st.tk.gor)) } : null;
                var sT = solveAt(i, p, ex);
                var rec = record(i, i * dt, p, sT, ex);
                if (sT.ok && sT.stable) st.prev = sT;
                if (!sT.ok || !sT.stable) st.dead = true;
                var qMain = gas ? sT.qg : (t === 'oil' ? sT.qL : sT.q);
                if (!ev.abandon && ((_fin(pAband) && p <= pAband) || (_fin(qAband) && sT.ok && _fin(qMain) && qMain < qAband))) ev.abandon = { i: i, t_d: i * dt, pr: p, reason: _fin(pAband) && p <= pAband ? 'p̄r at the abandonment pressure' : 'rate below the abandonment rate' };
                if (st.dead) { rec.phase = 'dead'; st.stop = 'DEAD'; return true; }
                if (ev.abandon && ev.abandon.i === i) return true;
                // produce over the step at the start rate (forward Euler) → the state at the end of the step
                var nx = gas ? TK.step(st.tk, TK.prodRate(sT) * dt) : TK.step(st.tk, TK.prodRate(sT) * dt, _fin(sT.qw) ? sT.qw * dt : 0);
                if (!nx) { ev.abandon = ev.abandon || { i: i + 1, t_d: (i + 1) * dt, pr: null, reason: 'the tank is depleted (the cumulative exceeds the material balance)' }; st.stop = 'TANK_EMPTY'; return true; }
                st.tk = nx; st.cum = nx.cum;
                return false;
            },
            label: label,
            cancelled: function () { return { ok: false, code: 'CANCELLED', cancelled: true, rows: [], evals: 0, errors: ['cancelled'], warnings: [] }; },
            finish: function () {
                var okN = rows.filter(function (r) { return r.ok; }).length, last = rows[rows.length - 1] || {};
                var res = { ok: okN > 0, mode: mode, kind: TK ? TK.kind : (gas ? 'gas' : 'oil'), fluidType: t, rows: rows, events: ev, rateUnit: _rateUnit(t), evals: st.evals,
                    totals: TK ? { cum: st.cum, cum0: TK.cum0, produced: st.cum - TK.cum0, Wp: st.wp, unit: TK.cumUnit, days: last.t_d } : null,
                    tank: TK ? { kind: TK.kind, pi: TK.pi, cum0: TK.cum0, G_Bscf: TK.G_Bscf || null, N_MMstb: TK.N_MMstb || null, m: TK.m, swi: TK.swi, cw: TK.cw, cf: TK.cf, Rp: TK.Rp || null, Boi: TK.Boi || null, pb: TK.pb || null,
                        wellGasFactor: TK.wellGasFactor || null, piz: TK.piz || null, recovery: TK.kind === 'gas' ? st.cum / TK.G : st.cum / TK.N } : null,
                    dt: dt, verified: mode === 'tank' ? false : null, provisional: mode === 'tank' ? PROVISIONAL : null,
                    decline: null, errors: okN ? [] : ['no step has an operating point'], warnings: warnings };
                if (mode === 'tank') res.warnings.push(_w('PROVISIONAL', 'Tank material balance (' + (TK.kind === 'gas' ? 'p/Z' : 'Havlena-Odeh') + '): ' + PROVISIONAL + '.', 'info'));
                // the decline / EUR cross-check against 35-rta-dca (information only)
                if (typeof G.PRiSM_declineResults === 'function') {
                    try {
                        var d = G.PRiSM_declineResults();
                        if (d && d.ok) res.decline = { ok: true, model: d.modelName || d.modelKey || '', eur: _fin(d.eur) ? d.eur : null, remaining: _fin(d.remaining) ? d.remaining : null, units: d.units || null,
                            ratio: (res.totals && _fin(d.remaining) && d.remaining > 0) ? res.totals.produced / d.remaining : null };
                        else res.decline = { ok: false, reason: (d && d.reason) || 'no decline fit in PRiSM' };
                    } catch (e) { res.decline = { ok: false, reason: 'the decline results could not be read' }; }
                }
                return res;
            }
        });
    }
    function csvForecast(res) {
        if (!res || !Array.isArray(res.rows) || !res.rows.length) return '';
        var L = [_cell('Well Performance depletion forecast (' + (res.mode === 'tank' ? 'tank, ' + res.kind + (res.provisional ? ', ' + res.provisional : '') : 'p̄r steps') + ') — field units')];
        L.push(['Step', 'Time (d)', 'p̄r (psia)', 'Rate (' + res.rateUnit + ')', 'q_o (STB/d)', 'q_w (BWPD)', 'q_g (Mscf/d)', 'pwf (psia)', 'THP (psig)', 'THT (°F)', 'Stable', 'Loading margin (%)', 'Np (STB)', 'Gp (Mscf)', 'Wp (STB)', 'Phase', 'Note'].map(_cell).join(','));
        res.rows.forEach(function (r) {
            L.push([r.i + 1, r.t_d, r.pr, _isGas(res.fluidType) ? r.qg : r.q, r.qo, r.qw, r.qg, r.pwf, r.thp, r.tht, r.ok ? (r.stable ? 'yes' : 'no') : '', _fin(r.loadingMargin) ? 100 * r.loadingMargin : null,
                r.Np, r.Gp, r.Wp, r.phase, r.error || ''].map(_cell).join(','));
        });
        return L.join('\n');
    }

    var NS = G.WTS_wp_cases = G.WTS_wp_cases || {};
    NS.KINDS = KINDS.slice(); NS.MAX = MAX; NS.TABLES = TABLES.slice();
    NS.make = make; NS.summary = summary; NS.model = model; NS.add = add; NS.remove = remove; NS.rename = rename; NS.diff = diff; NS.compare = compare; NS.csv = csvCases;
    var FC = G.WTS_wp_forecast = G.WTS_wp_forecast || {};
    FC.PROVISIONAL = PROVISIONAL; FC.MODES = ['steps', 'tank']; FC.DEFAULT_MODE = 'steps'; FC.MAX_STEPS = MAX_STEPS;
    FC.tank = tank; FC.job = job; FC.csv = csvForecast; FC._num = _num;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, C = G.WTS_wp_cases, F = G.WTS_wp_forecast, bad = [];
    if (!C || typeof C.make !== 'function' || typeof C.compare !== 'function' || !F || typeof F.job !== 'function' || typeof F.tank !== 'function') bad.push('namespace');
    else {
        var a = C.add([], { id: 'x1', name: 'Base', scalars: {} }), b = C.add(a.list, { id: 'x2', name: 'base', scalars: { wp_pr: 1 } });
        if (!(a.ok && b.ok && b.replaced && b.list.length === 1 && b.list[0].id === 'x1')) bad.push('add replaces by name');
        var d = C.diff({ scalars: { wp_pr: 3000, wp_wc: 30 }, tables: {} }, { scalars: { wp_pr: 2500, wp_wc: 30 }, tables: {} });
        if (d.scalars.length !== 1 || d.scalars[0].id !== 'wp_pr') bad.push('diff');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-cases.js self-test] ' + bad.join('; '));
})();
