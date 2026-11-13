// =============================================================================
// WTS — 49-calc-wd-res.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Dynamics — the reservoir boundary of the transient well simulator (lane WD1). docs/WELL-DYNAMICS-PLAN.md §4.7, §3.1
// (opts.reservoir), §4.14 (res_ipr, res_back, res_ls, res_sup), §5.2 (RS1–RS12). Engine only: no DOM, no storage, no timers.
// Field units: psia, h for the reservoir time functions (the engine API is in s), STB/d (oil basis = liquid STB/d) or Mscf/d (gas),
// md, ft, cp, 1/psi.
//
//   WTS_wd_res.create(I, M, o) → R | {ok:false, code, errors}
//     I  the solve's inflow (WTS_wp_system.context(M).C.I): qAt(pwf), pwfAt(q), pr, aof, key, kind, params, D, form
//     o  { mode: 'ipr' | 'transient', k, h, phi, ct, mu, B, rw, re, S, potential: 'auto'|'p'|'p2'|'mp',
//          prior: {kind: 'steady'|'none'|'shutin', t_h, shut_h}, backflow: true, qOp (the steady rate for the prior), F (the fluid) }
//     R  { ok, mode, kind, pr, potential, params, eta, rwe, Se, den, warnings[], provisional[],
//          begin(t_s, dt_s)  the past superposition sum at t + dt (once per step attempt),
//          qAt(p0)           the sandface rate (IPR basis; < 0 = back-flow into the formation) for this step,
//          commit(q, t_s)    the step's rate becomes the new superposition term (start of the step),
//          f(tau_h), u(q), uD(q), uND(q), Phi(p), Jr, snapshot() → JSON, restore(json), terms() }
//   WTS_wd_res.f(tau_h, P)            the normalised line-source time function (below)
//   WTS_wd_res.derivative(t, p)       the Bourdet derivative t·dp/dln t (L = 0, central in ln t; for the build-up checks)
//   WTS_wd_res.horner(tp, dt)         the Horner time ratio (tp + dt) / dt
//
// MODE 'ipr' (default; identity with the nodal solve): q = I.qAt(p0), instantaneous. Back-flow (option, default on, provisional
// key res_back): when p0 > p̄r the formation takes fluid, q = −J_r (p0 − p̄r), J_r = the IPR slope at p̄r (|dq/dpwf| as q → 0⁺, by a
// one-psi difference of I.qAt) — the pressure difference is used for every potential (the p² / m(p) slope at p̄r is the same
// linearisation for small differences; stated in the record). Off: q is clamped at 0 and the caller raises RES_NO_BACKFLOW.
//
// MODE 'transient' (line source with superposition of the IPR's drawdown; provisional res_sup, the E1 line source itself res_ls is
// exact): with the potential Φ (p for oil and linear models, p² for back-pressure / LIT p², m(p) for LIT m(p) and Darcy gas),
// u(q) = Φ(p̄r) − Φ(I.pwfAt(q)) is split into u_D (Darcy, time-dependent) and u_ND (non-Darcy b·q² / D·q, instantaneous):
//     Φ(p̄r) − Φ(p_wf(t)) = Σ_j [u_D(q_j) − u_D(q_j−1)] · f(t − t_j) + u_ND(q(t))
//     f(τ) = clamp( [½ E1(r_we² / (4 η τ)) + S_e] / [ln(r_e / r_we) − 0.75 + S_e], 0, 1 ),   η = 0.0002637 k / (φ μ c_t)  ft²/h, τ h
// r_we = r_w, S_e = S for S ≥ 0; r_we = r_w e^(−S), S_e = 0 for S < 0 (a stimulated well never gets f ≤ 0). E1 = PRiSM_E1. Negative
// rates (back-flow) use the linear extension u_D(q) = u_D'(0)·q. Terms whose f has reached 1 merge into the base; at most 400 terms
// (the same-sign pair closest in log-age merges at its Δu-weighted log-mean age).
//
// Units of the time functions: τ in hours (the engine passes seconds; this file converts).
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WD_STUBS = G.__WD_STUBS || [];
    ['WTS_wd_res.create', 'WTS_wd_res.f', 'WTS_wd_res.derivative', 'WTS_wd_res.horner'].forEach(function (n) { var i = STUBS.indexOf(n); if (i !== -1) STUBS.splice(i, 1); });

    var ETA_C = 0.0002637;            // ft²/h per (md / (cp · 1/psi)) — the field-unit diffusivity constant
    var MAX_TERMS = 400;
    var PROVISIONAL = 'provisional — not verified against a published example';

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _pos(v) { return _fin(v) && v > 0; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _fail(code, errors) { return { ok: false, code: code, errors: errors || [], warnings: [] }; }

    // E1(x), x > 0: PRiSM_E1 when loaded, else the A&S 5.1.11 series / 5.1.56 rational form (the same two branches)
    function _E1(x) {
        if (typeof G.PRiSM_E1 === 'function') return G.PRiSM_E1(x);
        if (!(x > 0)) return Infinity;
        if (x <= 1) {
            var s = -0.57721566490153286 - Math.log(x), term = 1;
            for (var k = 1; k < 60; k++) { term *= -x / k; var d = -term / k; s += d; if (Math.abs(d) < 1e-17 * Math.abs(s)) break; }
            return s;
        }
        var a1 = 8.5733287401, a2 = 18.0590169730, a3 = 8.6347608925, a4 = 0.2677737343, b1 = 9.5733223454, b2 = 25.6329561486, b3 = 21.0996530827, b4 = 3.9584969228;
        return (x * x * x * x + a1 * x * x * x + a2 * x * x + a3 * x + a4) / (x * x * x * x + b1 * x * x * x + b2 * x * x + b3 * x + b4) / (x * Math.exp(x));
    }

    // the line-source constants of a parameter set P {k, h, phi, ct, mu, rw, re, S}
    function lsConst(P) {
        var S = _fin(P.S) ? P.S : 0, rw = P.rw, re = P.re;
        var rwe = S < 0 ? rw * Math.exp(-S) : rw, Se = S < 0 ? 0 : S;
        var eta = ETA_C * P.k / (P.phi * P.mu * P.ct);
        var den = Math.log(re / rwe) - 0.75 + Se;
        return { eta: eta, rwe: rwe, Se: Se, den: den };
    }
    // f(τ h): the normalised constant-rate drawdown of the line source (§4.7); 0 at τ ≤ 0, 1 once stabilised
    function fOf(tau_h, K) {
        if (!(tau_h > 0)) return 0;
        var x = K.rwe * K.rwe / (4 * K.eta * tau_h);
        var v = (0.5 * _E1(x) + K.Se) / K.den;
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    function f(tau_h, P) { var K = lsConst(P); if (!(K.eta > 0) || !(K.den > 0)) return NaN; return fOf(tau_h, K); }

    // Bourdet derivative (L = 0): central difference in ln t over the neighbours; ends one-sided
    function derivative(t, p) {
        var n = Math.min(t.length, p.length), out = new Array(n);
        for (var i = 0; i < n; i++) {
            var a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
            if (b === a || !(t[a] > 0) || !(t[b] > 0)) { out[i] = NaN; continue; }
            if (a === i || b === i) { out[i] = (p[b] - p[a]) / (Math.log(t[b]) - Math.log(t[a])); continue; }
            var x1 = Math.log(t[i]) - Math.log(t[a]), x2 = Math.log(t[b]) - Math.log(t[i]);
            var d1 = (p[i] - p[a]) / x1, d2 = (p[b] - p[i]) / x2;
            out[i] = (d1 * x2 + d2 * x1) / (x1 + x2);
        }
        return out;
    }
    function horner(tp, dt) { return dt > 0 ? (tp + dt) / dt : NaN; }

    // the potential of the inflow model (auto: by the IPR's own form)
    function _potKind(I, want) {
        if (want === 'p' || want === 'p2' || want === 'mp') return want;
        var k = I && I.key;
        if (k === 'litMp' || k === 'darcyGas') return 'mp';
        if (k === 'litP2' || k === 'backPressure') return 'p2';
        return 'p';
    }
    function _mpTable(T_F, sg, pr) {
        if (typeof G.PRiSM_mpTable !== 'function') return null;
        var t = null;
        try { t = G.PRiSM_mpTable({ T_F: T_F, sg: sg, pmax: Math.max(1.2 * pr, pr + 500) }); } catch (e) { t = null; }
        return (t && typeof t.mOf === 'function') ? t : null;
    }

    function create(I, M, o) {
        o = o || {};
        if (!I || !I.ok || typeof I.qAt !== 'function' || typeof I.pwfAt !== 'function') return _fail('NEEDS_IPR', ['the inflow is not built']);
        var pr = +I.pr, aof = +I.aof;
        if (!(pr > 0) || !(aof > 0)) return _fail('NEEDS_IPR', ['the inflow has no p̄r or open-flow rate']);
        var warnings = [], prov = [];
        var kind = I.kind === 'gas' ? 'gas' : 'oil';
        var mode = o.mode === 'transient' ? 'transient' : 'ipr';
        var backflow = o.backflow !== false;
        // the back-flow slope at p̄r: |dq/dpwf| as q → 0⁺ (one-psi difference; a flat IPR at p̄r gets the slope of the first 1 % of AOF)
        var Jr = (I.qAt(pr - 1) - I.qAt(pr)) / 1;
        if (!(Jr > 0)) { var pq = I.pwfAt(0.01 * aof); Jr = (pr - pq) > 0 ? 0.01 * aof / (pr - pq) : 0; }
        var R = { ok: true, mode: mode, kind: kind, key: I.key, pr: pr, aof: aof, Jr: Jr, backflow: backflow, warnings: warnings, provisional: prov,
            potential: null, params: null, eta: null, rwe: null, Se: null, den: null, prior: null };

        // ── IPR mode ───────────────────────────────────────────────────────────────────────────────────────────────────
        var qPrev = 0, base = 0, terms = [], past = 0, f1 = 1, tNext = 0;
        if (mode === 'ipr') {
            R.qAt = function (p0) {
                if (p0 >= pr) return backflow ? -Jr * (p0 - pr) : 0;
                var q = I.qAt(p0);
                return _fin(q) ? q : 0;
            };
            R.begin = function () { };
            R.commit = function (q) { qPrev = q; };
            R.snapshot = function () { return { mode: 'ipr', qPrev: qPrev }; };
            R.restore = function (j) { qPrev = j && _fin(j.qPrev) ? j.qPrev : 0; return { ok: true }; };
            R.terms = function () { return []; };
            R.f = function () { return 1; };
            R.qPrev = function () { return qPrev; };
            return R;
        }

        // ── transient mode: parameters ─────────────────────────────────────────────────────────────────────────────────
        var ip = I.params || {}, dynRes = (M && M.dyn && M.dyn.res) || {};
        function pick(k, alt) { var v = _n(o[k]); if (v == null) v = _n(dynRes[k]); if (v == null && alt) for (var i = 0; i < alt.length && v == null; i++) v = _n(ip[alt[i]]); return v; }
        var P = { k: pick('k', ['k']), h: pick('h', ['h']), phi: pick('phi', ['phi']), ct: pick('ct', ['ct']), mu: pick('mu', ['muo', 'mu']),
            B: pick('B', ['Bo', 'B']), rw: pick('rw', ['rw']), re: pick('re', ['re']), S: pick('S', ['S']) };
        if (P.S == null) P.S = 0;
        // gas: μ at p̄r from the fluid when not given (η at p̄r — pseudo-time not used, provisional)
        if (!_pos(P.mu) && o.F && typeof o.F.at === 'function') {
            try { var pp = o.F.at(pr, M && M.res ? +M.res.T_F : 200); if (pp) P.mu = kind === 'gas' ? pp.mug : pp.muo; } catch (e) { /* keep null */ }
        }
        var missing = ['k', 'h', 'phi', 'ct', 'mu', 'rw', 're'].filter(function (k) { return !_pos(P[k]); });
        if (missing.length) {
            // a missing parameter keeps the mode 'ipr' and says so (RS9)
            var R2 = create(I, M, Object.assign({}, o, { mode: 'ipr' }));
            R2.warnings.push(_w('RES_PARAMS_MISSING', 'Transient reservoir: ' + missing.join(', ') + ' missing — the instantaneous IPR inflow is used.', 'warn'));
            R2.missing = missing;
            return R2;
        }
        var K = lsConst(P);
        if (!(K.den > 0) || !(K.eta > 0)) return _fail('BAD_RES', ['ln(re/rw) − 0.75 + S must be above 0 and η positive']);
        R.params = P; R.eta = K.eta; R.rwe = K.rwe; R.Se = K.Se; R.den = K.den;
        prov.push('res_sup');
        // potential
        var pot = _potKind(I, o.potential), mp = null;
        if (pot === 'mp') {
            var sg = _n(ip.sg) || (o.F && _pos(o.F.sgg) ? o.F.sgg : 0.65);
            mp = _mpTable(M && M.res ? +M.res.T_F : 200, sg, pr);
            if (!mp) { pot = 'p2'; warnings.push(_w('MP_FALLBACK', 'The m(p) table is not available: the p² potential is used.', 'info')); }
        }
        R.potential = pot;
        var Phi = pot === 'p' ? function (p) { return p; } : pot === 'p2' ? function (p) { return p * p; } : function (p) { return mp.mOf(Math.max(p, 1)); };
        var PhiR = Phi(pr);
        // the drawdown split: u = Φ(p̄r) − Φ(pwf(q)), u_ND the non-Darcy part
        var a = _n(ip.a), b = _n(ip.b), Dnd = _fin(I.D) ? I.D : _n(ip.D), X = I.form && _fin(I.form.X) ? I.form.X : null;
        function u(q) { if (!(q > 0)) return 0; var pw = I.pwfAt(Math.min(q, aof)); return PhiR - Phi(Math.max(pw, 0)); }
        function uND(q) {
            if (!(q > 0)) return 0;
            if ((I.key === 'litP2' || I.key === 'litMp') && _fin(b)) return b * q * q;
            if (I.key === 'jbgOil' && _fin(_n(ip.B))) return _n(ip.B) * q * q;
            if (I.key === 'darcyGas' && _fin(Dnd) && Dnd > 0 && _fin(X)) { var uu = u(q); return uu * Dnd * q / (X + P.S + Dnd * q); }
            return 0;
        }
        var hq = Math.max(1e-6 * aof, 1e-6), s0 = (u(hq) - uND(hq)) / hq;      // u_D'(0⁺) for the linear back-flow extension
        function uD(q) { return q > 0 ? u(q) - uND(q) : s0 * q; }
        R.u = u; R.uND = uND; R.uD = uD; R.Phi = Phi; R.f = function (tau_h) { return fOf(tau_h, K); };
        // a monotone table of u_D, u_ND for the starting guesses of the inversion
        var NT = 200, tq = new Float64Array(NT + 1), tD = new Float64Array(NT + 1), tN = new Float64Array(NT + 1);
        for (var i = 0; i <= NT; i++) { var qq = aof * Math.pow(i / NT, 2); tq[i] = qq; tN[i] = uND(qq); tD[i] = uD(qq); }
        // prior history (R15)
        var qOp = _pos(o.qOp) ? o.qOp : 0, pk = (o.prior && o.prior.kind) || 'none';
        var th = _pos(_n(o.prior && o.prior.t_h)) ? +o.prior.t_h : 720, sh = _pos(_n(o.prior && o.prior.shut_h)) ? +o.prior.shut_h : 0;
        if (pk === 'steady' && qOp > 0) { terms.push({ t: -th * 3600, du: uD(qOp) }); qPrev = qOp; }
        else if (pk === 'shutin' && qOp > 0) { terms.push({ t: -(th + sh) * 3600, du: uD(qOp) }); terms.push({ t: -sh * 3600, du: -uD(qOp) }); qPrev = 0; }
        else pk = 'none';
        R.prior = { kind: pk, t_h: th, shut_h: sh, qOp: qOp };
        function _compact(tNow) {
            // terms with f = 1 merge into the base
            for (var j = terms.length - 1; j >= 0; j--) if (fOf((tNow - terms[j].t) / 3600, K) >= 1 - 1e-12) { base += terms[j].du; terms.splice(j, 1); }
            // over the cap: merge the same-sign pair closest in log-age at its Δu-weighted log-mean age — exact while f is linear in
            // ln τ (the infinite-acting part), so the error stays at the curvature of f between the two ages (RS8)
            while (terms.length > MAX_TERMS) {
                var bi = -1, bk = -1, bg = Infinity;
                for (var i2 = 0; i2 < terms.length; i2++) {
                    var ai = Math.max(tNow - terms[i2].t, 1e-9);
                    for (var k2 = i2 + 1; k2 < Math.min(terms.length, i2 + 6); k2++) {
                        if ((terms[i2].du >= 0) !== (terms[k2].du >= 0)) continue;
                        var gap = Math.abs(Math.log(ai / Math.max(tNow - terms[k2].t, 1e-9)));
                        if (gap < bg) { bg = gap; bi = i2; bk = k2; }
                        break;
                    }
                }
                if (bi < 0) { bi = 0; bk = 1; }
                var x = terms[bi], y = terms[bk], ax = Math.max(tNow - x.t, 1e-9), ay = Math.max(tNow - y.t, 1e-9), du = x.du + y.du;
                var age = du !== 0 ? Math.exp((x.du * Math.log(ax) + y.du * Math.log(ay)) / du) : Math.sqrt(ax * ay);
                if (!(age > 0) || !isFinite(age)) age = Math.sqrt(ax * ay);
                terms[bi] = { t: tNow - age, du: du };
                terms.splice(bk, 1);
            }
        }
        _compact(0);
        R.begin = function (t_s, dt_s) {
            tNext = t_s + dt_s;
            past = base;
            for (var j = 0; j < terms.length; j++) past += terms[j].du * fOf((tNext - terms[j].t) / 3600, K);
            f1 = Math.max(fOf(dt_s / 3600, K), 1e-3);
        };
        // solve the step's rate at p0: target = [u_D(q) − u_D(q_prev)]·f1 + u_ND(q)
        R.qAt = function (p0) {
            var rhs = PhiR - Phi(Math.max(p0, 1)) - past + uD(qPrev) * f1;
            var hfun = function (q) { return uD(q) * f1 + uND(q); };
            if (rhs <= 0) {
                if (!backflow) return 0;
                return rhs / (s0 * f1);                               // the linear (Darcy) extension below q = 0
            }
            // table bracket, then secant / bisection on the exact u
            var lo = 0, hi = aof, hlo = 0, hhi = hfun(aof);
            if (rhs >= hhi) return aof;
            var k0 = 0; while (k0 < NT && tD[k0 + 1] * f1 + tN[k0 + 1] < rhs) k0++;
            lo = tq[k0]; hi = tq[Math.min(NT, k0 + 1)]; hlo = hfun(lo); hhi = hfun(hi);
            var q = lo;
            for (var it = 0; it < 60; it++) {
                q = (hhi > hlo && it % 4 !== 3) ? lo + (rhs - hlo) * (hi - lo) / (hhi - hlo) : 0.5 * (lo + hi);
                if (!(q > lo && q < hi)) q = 0.5 * (lo + hi);
                var hq2 = hfun(q);
                if (Math.abs(hq2 - rhs) <= 1e-11 * Math.max(1, Math.abs(rhs)) || hi - lo <= 1e-12 * Math.max(1, hi)) break;
                if (hq2 < rhs) { lo = q; hlo = hq2; } else { hi = q; hhi = hq2; }
            }
            return q;
        };
        R.commit = function (q, t_s) {
            var du = uD(q) - uD(qPrev);
            if (du !== 0) terms.push({ t: t_s, du: du });
            qPrev = q;
            _compact(tNext > t_s ? tNext : t_s);
        };
        R.qPrev = function () { return qPrev; };
        R.terms = function () { return terms.map(function (x) { return [x.t, x.du]; }); };
        R.base = function () { return base; };
        R.snapshot = function () { return { mode: 'transient', qPrev: qPrev, base: base, terms: terms.map(function (x) { return [x.t, x.du]; }), prior: R.prior }; };
        R.restore = function (j) {
            if (!j || j.mode !== 'transient') return { ok: false, code: 'RES_MODE' };
            qPrev = +j.qPrev || 0; base = +j.base || 0;
            terms = (j.terms || []).map(function (x) { return { t: +x[0], du: +x[1] }; });
            return { ok: true };
        };
        R.provisionalText = PROVISIONAL;
        return R;
    }

    var NS = G.WTS_wd_res = G.WTS_wd_res || {};
    NS.create = create; NS.f = f; NS.derivative = derivative; NS.horner = horner; NS.lsConst = lsConst; NS.E1 = _E1;
    NS.VERSION = '1.0.0';
})();
// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, R = G.WTS_wd_res;
    if (!R) return;
    var P = { k: 50, h: 50, phi: 0.2, ct: 1.5e-5, mu: 1, rw: 0.354, re: 1500, S: 2 };
    var a = R.f(1e9, P), b = R.f(1, P);
    if (!(Math.abs(a - 1) < 1e-12) || !(b > 0 && b < 1)) throw new Error('WTS_wd_res self-test: f');
})();
