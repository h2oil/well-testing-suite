// =============================================================================
// WTS — 49-calc-wp-ipr.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance inflow: IPR models, fitting, the PRiSM import and the skin table (docs/WELL-PERFORMANCE-PLAN.md §3.3, §4.2,
// §4.3; WP2). Delegates, never re-implements (D4): the oil curves are WTS_oilipr_model (42-calc-oilipr.js), the gas curves
// WTS_gasdeliv_model (41-calc-gasdeliv.js), the two-term fits WTS_gasdeliv_fitAB, m(p) is PRiSM_mpTable (16-pvt.js), the
// geometric skins PRiSM_skinDecomposition (34), the rate-dependent skin PRiSM_rateDependentSkin (34), Δp_skin / FE / PI ratio
// PRiSM_skinCheck.products (54) and the perforation skin PRiSM_skinCheck.perforationSkin (54; disabled while UNVERIFIED, D11).
//
// Units (field, §3.0): p psia, q STB/d (oil) or Mscf/d (gas), k md, h / rw / re ft, μ cp, T °F in (°R inside the gas
// equations), perforation and gravel-pack lengths and diameters in inches (named *_in), D in d/Mscf (gas) or d/STB (oil).
//
// API (window.WTS_wp_ipr; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data)
//   models                    registry {key: {key, label, kind:'oil'|'gas', needs:[…], verified, provisional?, curve(spec, F)}}
//                             A1 keys: pi, vogel, composite, fetkovich, jbgOil, darcyOil, backPressure, litP2, litMp, darcyGas
//   curve(spec /*M.res*/, F?, o?)
//       → I = {ok, key, label, kind, verified, pr, pb, aof, J, pAof, qAt(pwf), pwfAt(q), curve:[{q, pwf}], skin: SkinTable|null,
//              params (resolved), D, warnings, errors, future(prf) → I}
//       spec.params by model (res.params; the page sets them through the wp_ip_<name> controls):
//         pi {J} · vogel {qmax (FE = 1), FE} · composite {J} + spec.pb (or F.pb(T)) · fetkovich {C, n}
//         jbgOil {A psi/(STB/d), B psi/(STB/d)²}: p̄r − pwf = A·q + B·q²
//         darcyOil {k, h, rw, re | A_acres + CA, S, ref 'pss'|'ss'|'ssPe' (or 0 / 1 / 2), Bo, muo (else F.at(p̄r, T))} (+ skin parts)
//         backPressure {C, n} · litP2 {a, b} (p̄r² − pwf² = a·q + b·q²) · litMp {a, b} (m(p̄r) − m(pwf), psi²/cp)
//         darcyGas {k, h, rw, re, S, D | Dest = 1 (Geertsma estimate: phi, hp, pD), p2 = 1 (p² form, μ̄z̄ at pMean, default p̄r)}
//         gas models: sg (else F.sgWell | F.sg | F.sgg — the reservoir / recombined gravity, D14), pAof (default 14.65 psia)
//       With no coefficients but spec.points [{q, pwf}] the curve is fitted first (fit()).
//   fit(kind, points, opts)   delegates: pi / vogel / composite / fetkovich → WTS_oilipr_compute; backPressure / litP2 →
//                             WTS_gasdeliv_compute; jbgOil / litMp → WTS_gasdeliv_fitAB → {ok, kind, params, r2, source, warnings}
//   fromWell(o?)              → {ok, spec, provenance:{key: source}, warnings} from PRiSM_getWell / PRiSM_getLastFit and the stored
//                             gas-deliverability summary (PRiSM_state.deliverability for the current dataset). Read only; a p̄r
//                             with 'default' provenance stays null (never defaulted).
//   skin(spec)                → SkinTable {ok, parts:[{key, label, S, basis:'h'|'hp', Sh, source}], total, Sconst, D, dpSkin(q, pwf?),
//                             FE, h, hp, warnings, notes}; S_t = S_pp + S_θ + S_f + (h/h_p)(S_d + S_perf + S_dp + S_gp) + D·q
//   estimateD(o)              Geertsma β (1/ft) and D (d/Mscf) → {ok, beta, D, label} — an estimate, provisional
//   darcyX(params)            the ln term of the Darcy forms → {ok, X, ref, label}
//   PROVISIONAL               the label of a method with no verified published example (D17)
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var PROVISIONAL = 'provisional — not verified against a published example';
    var P_AOF = 14.65, NCURVE = 41, RANK = 459.67;
    var C_DARCY_OIL = 141.2, C_DARCY_GAS = 1422;          // field units: q STB/d (B rb/STB, μ cp) and q Mscf/d (T °R, m psi²/cp)
    var C_FORCH = 3.161e-12;                              // Forchheimer Δ(p²)_nD = 3.161e-12·β·γg·z·T·q²/(h²·rw), β 1/ft, q Mscf/d
    var C_D = C_FORCH / C_DARCY_GAS;                      // D = 2.2229e-15·β·k·γg/(μg·h_p·rw)  [d/Mscf]
    var C_BETA = 4.85e4;                                  // Geertsma (1974): β = 0.005/(φ^5.5·√k[cm²]) cm⁻¹ = 4.85e4/(φ^5.5·√k_md) ft⁻¹

    // ── helpers ──────────────────────────────────────────────────────────────
    function _n(v) {
        if (typeof v === 'number') return isFinite(v) ? v : NaN;
        if (typeof v === 'string' && v.trim() !== '') { var x = +v; return isFinite(x) ? x : NaN; }
        return NaN;
    }
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _pos(v) { return _fin(v) && v > 0; }
    function _first() { for (var i = 0; i < arguments.length; i++) { var x = _n(arguments[i]); if (_fin(x)) return x; } return NaN; }
    function _w(code, msg, sev) { return { code: code, msg: msg, sev: sev || 'warn' }; }
    function _fix(v, d) { return _fin(v) ? Number(v).toFixed(d == null ? 1 : d) : '—'; }
    function _fail(code, msgs, extra) {
        var o = { ok: false, code: code, errors: [].concat(msgs), warnings: [] };
        if (extra) for (var k in extra) o[k] = extra[k];
        return o;
    }
    function _plainParams(p) { var o = {}; if (p && typeof p === 'object') for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = p[k]; return o; }
    function _lib() { return G.PRiSM_pvt_correlations || null; }

    // drop this module's names from the WP0 stub list (the file replaces the stub)
    (function () {
        var S = G.__WP_STUBS = G.__WP_STUBS || [];
        ['WTS_wp_ipr.curve', 'WTS_wp_ipr.fit', 'WTS_wp_ipr.fromWell', 'WTS_wp_ipr.skin'].forEach(function (n) {
            var i = S.indexOf(n); if (i !== -1) S.splice(i, 1);
        });
    })();

    // ── gas properties (shared correlations; nothing re-implemented) ─────────
    function _gasState(sg, T_F, p) {
        var L = _lib();
        if (!L || !_pos(sg) || !_fin(T_F) || !_pos(p)) return null;
        var Tpr = (T_F + RANK) / L.Tpc_sutton(sg), Ppr = p / L.Ppc_sutton(sg);
        var z = L.Z_dranchukAbouKassem(Tpr, Ppr), mu = L.mu_g_leeGonzalezEakin(sg, T_F, z, p);
        return (_pos(z) && _pos(mu)) ? { z: z, mu: mu } : null;
    }
    // PRiSM's m(p) table with a polished inverse (its bisection to 1e-9·pmax, then Newton on the table) so q(pwf(q)) = q to 1e-9.
    function _mpTable(T_F, sg, pr) {
        if (typeof G.PRiSM_mpTable !== 'function') return null;
        var t = null;
        try { t = G.PRiSM_mpTable({ T_F: T_F, sg: sg, pmax: Math.max(1.2 * pr, pr + 500) }); } catch (e) { t = null; }
        if (!t || typeof t.mOf !== 'function' || typeof t.pOf !== 'function') return null;
        return {
            tbl: t, mOf: t.mOf,
            pOf: function (M) {
                var p = t.pOf(M);
                if (!_pos(p)) return p;
                for (var i = 0; i < 4; i++) {
                    var hh = Math.max(1e-4, 1e-7 * p), d = (t.mOf(p + hh) - t.mOf(p - hh)) / (2 * hh);
                    if (!_pos(d)) break;
                    var step = (t.mOf(p) - M) / d;
                    p -= step;
                    if (Math.abs(step) < 1e-13 * p) break;
                }
                return p;
            }
        };
    }
    function _sgOf(params, F) {
        var s = _n(params.sg);
        if (_pos(s)) return { sg: s, src: 'input' };
        if (F && F.ok) {
            var f = _first(F.sgWell, F.sgRes, F.sg, F.sgg);
            if (_pos(f)) return { sg: f, src: 'fluid' };
        }
        return null;
    }

    // ── Darcy forms (§4.2) ───────────────────────────────────────────────────
    // pss with p̄r: ln(re/rw) − 0.75 (or ½·ln(10.06·A/(C_A·rw²)) − 0.75, A ft²); ss with p̄r: ln(re/rw) − 0.5; ss with p_e: ln(re/rw)
    var REF = { 0: 'pss', 1: 'ss', 2: 'ssPe', pss: 'pss', ss: 'ss', ssPe: 'ssPe' };
    var REF_LABEL = { pss: 'pseudo-steady state, p̄r', ss: 'steady state, p̄r', ssPe: 'steady state, p_e at r_e' };
    function darcyX(p) {
        p = p || {};
        var ref = REF[p.ref == null || p.ref === '' ? 'pss' : p.ref];
        if (!ref) return _fail('BAD_REF', 'Unknown Darcy reference form.');
        var rw = _n(p.rw), re = _n(p.re), A = _n(p.A_acres), CA = _n(p.CA);
        if (!_pos(rw)) return _fail('NEEDS_RW', 'Wellbore radius rw is needed.');
        var X;
        if (ref === 'pss' && _pos(A) && _pos(CA)) {
            X = 0.5 * Math.log(10.06 * A * 43560 / (CA * rw * rw)) - 0.75;
        } else {
            if (!_pos(re) || !(re > rw)) return _fail('NEEDS_RE', 'Drainage radius re (above rw) is needed.');
            X = Math.log(re / rw) - (ref === 'pss' ? 0.75 : ref === 'ss' ? 0.5 : 0);
        }
        return { ok: true, X: X, ref: ref, label: REF_LABEL[ref], errors: [], warnings: [] };
    }
    // Geertsma (1974) β and the non-Darcy coefficient D (§4.2): β = 4.85e4/(φ^5.5·√k) 1/ft; D = 2.2229e-15·β·k·γg/(μg·h_p·rw) d/Mscf
    function estimateD(o) {
        o = o || {};
        var k = _n(o.k), phi = _n(o.phi), sg = _n(o.sg), mu = _n(o.mu), hp = _first(o.hp, o.h), rw = _n(o.rw);
        if (!_pos(k) || !(phi > 0 && phi < 1) || !_pos(sg) || !_pos(mu) || !_pos(hp) || !_pos(rw)) {
            return _fail('NEEDS', 'The D estimate needs k, φ (0–1), gas gravity, μg, h_p and rw.');
        }
        var beta = C_BETA / (Math.pow(phi, 5.5) * Math.sqrt(k));
        return { ok: true, beta: beta, D: C_D * beta * k * sg / (mu * hp * rw), label: 'estimate (Geertsma β; ' + PROVISIONAL + ')',
            errors: [], warnings: [_w('D_ESTIMATE', 'D is an estimate from the Geertsma β correlation (' + PROVISIONAL + ').', 'info')] };
    }

    // ── I builder: wraps a delegated evaluator {qAt, pwfAt, aof} ──────────────
    function _mkI(key, base, ev, extra) {
        var def = MODELS[key];
        var I = {
            ok: true, key: key, label: def.label, kind: def.kind, verified: !!def.verified, provisional: def.verified ? null : PROVISIONAL,
            pr: base.pr, pb: _fin(extra.pb) ? extra.pb : null, aof: ev.aof, J: _fin(extra.J) ? extra.J : null, pAof: extra.pAof,
            qAt: ev.qAt, pwfAt: ev.pwfAt, curve: [], skin: extra.skin || null, params: extra.params, D: _fin(extra.D) ? extra.D : null,
            Dsource: extra.Dsource || null, form: extra.form || null, warnings: base.warnings, errors: [], engine: extra.engine || null,
            future: null
        };
        if (!def.verified) I.warnings.push(_w('PROVISIONAL', def.label + ': ' + PROVISIONAL + '.', 'info'));
        var pmin = _fin(extra.pAof) ? extra.pAof : 0;
        for (var i = 0; i < NCURVE; i++) {
            var pw = base.pr - (base.pr - pmin) * i / (NCURVE - 1);
            I.curve.push({ q: ev.qAt(pw), pwf: pw });
        }
        return I;
    }

    function _future(spec, F, o, I) {
        return function (prf) {
            prf = _n(prf);
            if (!_pos(prf)) return _fail('BAD_PRF', 'Future p̄r must be above 0.');
            var p = _plainParams(I.params), note;
            if (I.key === 'vogel') { p.qmax = p.qmax * Math.pow(prf / I.pr, 3); note = 'Future IPR: Vogel cube rule qmax·(p̄r,f/p̄r)³.'; }
            else if (I.key === 'fetkovich') { p.C = p.C * (prf / I.pr); note = 'Future IPR: Fetkovich C·(p̄r,f/p̄r).'; }
            else note = 'Future IPR: p̄r changed only, the other coefficients (J, C, a, b) held.';
            var s2 = { model: I.key, pr: prf, T_F: spec.T_F, pb: spec.pb, params: p, points: [] };
            var J = curve(s2, F, o);
            if (J.ok) { J.warnings.push(_w('FUTURE_RULE', note, 'info')); J.prBase = I.pr; }
            return J;
        };
    }

    // ── models (§3.3, §4.2) ───────────────────────────────────────────────────
    function _oil(mspec) {
        if (typeof G.WTS_oilipr_model !== 'function') return _fail('MISSING_ENGINE', 'The oil IPR engine (WTS_oilipr_model) is not loaded.', { name: 'WTS_oilipr_model' });
        var m = G.WTS_oilipr_model(mspec);
        if (!m.ok) return _fail('BAD_PARAMS', m.errors);
        return m;
    }
    function _gas(gspec) {
        if (typeof G.WTS_gasdeliv_model !== 'function') return _fail('MISSING_ENGINE', 'The gas deliverability engine (WTS_gasdeliv_model) is not loaded.', { name: 'WTS_gasdeliv_model' });
        var m = G.WTS_gasdeliv_model(gspec);
        if (!m.ok) return _fail('BAD_PARAMS', m.errors);
        return m;
    }
    function _pbOf(spec, F, warnings) {
        var pb = _n(spec.pb);
        if (_fin(pb) && pb >= 0) return pb;
        if (F && F.ok && typeof F.pb === 'function') {
            try { pb = _n(F.pb(_n(spec.T_F))); } catch (e) { pb = NaN; }
            if (_fin(pb) && pb >= 0) { warnings.push(_w('PB_FLUID', 'Bubble point from the fluid model: ' + _fix(pb, 1) + ' psia.', 'info')); return pb; }
        }
        return NaN;
    }
    function _autoFit(key, spec, warnings) {
        var pts = Array.isArray(spec.points) ? spec.points : [];
        if (!pts.length || !MODELS[key].fit) return null;
        var r = fit(key, pts, { pr: spec.pr, pb: spec.pb, FE: (spec.params || {}).FE, pAof: (spec.params || {}).pAof, n: (spec.params || {}).n,
            T_F: spec.T_F, sg: (spec.params || {}).sg });
        if (r.ok) warnings.push(_w('FITTED', MODELS[key].label + ' fitted to ' + pts.length + ' test point' + (pts.length === 1 ? '' : 's') + '.', 'info'));
        return r;
    }

    var MODELS = {};
    function reg(def) { MODELS[def.key] = def; }

    reg({ key: 'pi', label: 'Straight-line PI', kind: 'oil', needs: ['J'], verified: true, fit: true,
        build: function (spec, P, w) {
            var m = _oil({ mode: 'pi', pr: spec.pr, J: P.J });
            return m.ok ? { ev: m, J: m.J, engine: 'WTS_oilipr_model' } : m;
        } });
    reg({ key: 'vogel', label: 'Vogel (1968) with Standing flow efficiency', kind: 'oil', needs: ['qmax'], verified: true, fit: true,
        build: function (spec, P, w) {
            var pb = _n(spec.pb);
            if (_fin(pb) && pb < spec.pr) w.push(_w('VOGEL_UNDERSAT', 'p̄r is above the bubble point: Vogel assumes a saturated reservoir — the composite IPR fits better.'));
            var m = _oil({ mode: 'vogel', pr: spec.pr, qmax: P.qmax, FE: P.FE });
            return m.ok ? { ev: m, pb: spec.pr, engine: 'WTS_oilipr_model' } : m;
        } });
    reg({ key: 'composite', label: 'Composite (PI above pb, Vogel below)', kind: 'oil', needs: ['J', 'pb'], verified: true, fit: true,
        build: function (spec, P, w, F) {
            var pb = _pbOf(spec, F, w);
            if (!_fin(pb)) return _fail('PB_NEEDED', 'Bubble-point pressure is needed for the composite IPR.');
            var m = _oil({ mode: 'composite', pr: spec.pr, pb: pb, J: P.J });
            return m.ok ? { ev: m, J: m.J, pb: m.pb, engine: 'WTS_oilipr_model' } : m;
        } });
    reg({ key: 'fetkovich', label: 'Fetkovich (1973) C and n', kind: 'oil', needs: ['C', 'n'], verified: true, fit: true,
        build: function (spec, P) {
            var m = _oil({ mode: 'fetkovich', pr: spec.pr, C: P.C, n: P.n });
            return m.ok ? { ev: m, engine: 'WTS_oilipr_model' } : m;
        } });
    reg({ key: 'jbgOil', label: 'Jones-Blount-Glaze (1976) two-term oil', kind: 'oil', needs: ['A', 'B'], verified: false, fit: true,
        build: function (spec, P) {
            var pr = spec.pr;
            var m = _gas({ lit: { a: P.A, b: P.B }, pr: pr, pAof: 0,
                delta: { d: function (pwf) { return pr - pwf; }, inv: function (d) { return pr - d; } } });
            return m.ok ? { ev: m, J: 1 / _n(P.A), engine: 'WTS_gasdeliv_model (Δ = p̄r − pwf)' } : m;
        } });
    reg({ key: 'darcyOil', label: 'Darcy radial oil (k·h, skin)', kind: 'oil', needs: ['k', 'h', 'rw', 're', 'S'], verified: false,
        build: function (spec, P, w, F) {
            var k = _n(P.k), h = _n(P.h);
            if (!_pos(k) || !_pos(h)) return _fail('NEEDS', 'Darcy inflow needs k and h.');
            var x = darcyX(P);
            if (!x.ok) return x;
            var Bo = _n(P.Bo), mu = _n(P.muo), src = 'input';
            if ((!_pos(Bo) || !_pos(mu)) && F && F.ok && typeof F.at === 'function') {
                var pp = null;
                try { pp = F.at(spec.pr, _n(spec.T_F)); } catch (e) { pp = null; }
                if (pp) { if (!_pos(Bo)) Bo = _n(pp.bo); if (!_pos(mu)) mu = _n(pp.muo); src = 'fluid at p̄r'; }
            }
            if (!_pos(Bo) || !_pos(mu)) return _fail('NEEDS', 'Darcy oil inflow needs Bo and μo (enter them or build the fluid).');
            var sk = skin(Object.assign({}, P, { Bo: Bo, muo: mu, pbar: spec.pr }));
            var S = _n(P.S), Ssrc = 'input';
            if (!_fin(S)) {
                if (sk.ok && sk.parts.length) { S = sk.Sconst; Ssrc = 'skin table'; }
                else { S = 0; Ssrc = 'none'; w.push(_w('S_ZERO', 'No skin entered: S = 0.', 'info')); }
            }
            if (!(x.X + S > 0)) return _fail('BAD_SKIN', 'ln-term + S must be above 0 (the skin is too negative for this drainage radius).');
            var J = k * h / (C_DARCY_OIL * Bo * mu * (x.X + S));
            var pb = _pbOf(spec, F, w), m;
            if (_fin(pb) && pb > 0) m = _oil({ mode: 'composite', pr: spec.pr, pb: pb, J: J });
            else { m = _oil({ mode: 'pi', pr: spec.pr, J: J }); w.push(_w('NO_PB', 'No bubble point: straight-line PI from the Darcy J.', 'info')); }
            if (!m.ok) return m;
            P.Bo = Bo; P.muo = mu; P.S = S;
            return { ev: m, J: J, pb: m.pb, skin: sk.ok ? sk : null, form: { ref: x.ref, label: x.label, X: x.X, Ssource: Ssrc, BmuSource: src },
                engine: 'WTS_oilipr_model (' + (m.mode === 'composite' ? 'composite' : 'PI') + ')' };
        } });
    reg({ key: 'backPressure', label: 'Back-pressure C and n (Rawlins-Schellhardt)', kind: 'gas', needs: ['C', 'n'], verified: true, fit: true,
        build: function (spec, P) {
            var m = _gas({ cn: { C: P.C, n: P.n }, pr: spec.pr, pAof: P.pAof });
            return m.ok ? { ev: m, pAof: m.pAof, engine: 'WTS_gasdeliv_model' } : m;
        } });
    reg({ key: 'litP2', label: 'LIT in p² (Houpeurt)', kind: 'gas', needs: ['a', 'b'], verified: true, fit: true,
        build: function (spec, P) {
            var m = _gas({ lit: { a: P.a, b: P.b }, pr: spec.pr, pAof: P.pAof });
            return m.ok ? { ev: m, pAof: m.pAof, engine: 'WTS_gasdeliv_model' } : m;
        } });
    function _mpDelta(tb, pr) {
        var mpr = tb.mOf(pr);
        return { d: function (pwf) { return mpr - tb.mOf(pwf); }, inv: function (d) { return tb.pOf(mpr - d); } };
    }
    function _gasCtx(spec, P, F) {
        var T = _n(spec.T_F);
        if (!_fin(T)) return _fail('NEEDS_T', 'Reservoir temperature is needed for the gas m(p) relation.');
        var sg = _sgOf(P, F);
        if (!sg) return _fail('NEEDS_SG', 'Gas gravity is needed for the m(p) relation (enter sg or build the fluid).');
        var tb = _mpTable(T, sg.sg, spec.pr);
        if (!tb) return _fail('MISSING_ENGINE', 'The m(p) table (PRiSM_mpTable) is not available.', { name: 'PRiSM_mpTable' });
        return { ok: true, T: T, sg: sg.sg, sgSrc: sg.src, tb: tb };
    }
    reg({ key: 'litMp', label: 'LIT in m(p) (pseudo-pressure)', kind: 'gas', needs: ['a', 'b', 'sg'], verified: false, fit: true,
        build: function (spec, P, w, F) {
            var c = _gasCtx(spec, P, F);
            if (!c.ok) return c;
            var m = _gas({ lit: { a: P.a, b: P.b }, pr: spec.pr, pAof: P.pAof, delta: _mpDelta(c.tb, spec.pr) });
            P.sg = c.sg;
            return m.ok ? { ev: m, pAof: m.pAof, engine: 'WTS_gasdeliv_model (Δ = m(p̄r) − m(pwf), PRiSM_mpTable)' } : m;
        } });
    reg({ key: 'darcyGas', label: 'Darcy radial gas with non-Darcy D', kind: 'gas', needs: ['k', 'h', 'rw', 're', 'S', 'D'], verified: false,
        build: function (spec, P, w, F) {
            var k = _n(P.k), h = _n(P.h);
            if (!_pos(k) || !_pos(h)) return _fail('NEEDS', 'Darcy inflow needs k and h.');
            var x = darcyX(P);
            if (!x.ok) return x;
            var c = _gasCtx(spec, P, F);
            if (!c.ok) return c;
            var TR = c.T + RANK;
            var sk = skin(Object.assign({}, P, { T_F: c.T, sg: c.sg, kind: 'gas', pbar: spec.pr }));
            var S = _n(P.S), Ssrc = 'input';
            if (!_fin(S)) {
                if (sk.ok && sk.parts.length) { S = sk.Sconst; Ssrc = 'skin table'; }
                else { S = 0; Ssrc = 'none'; w.push(_w('S_ZERO', 'No skin entered: S = 0.', 'info')); }
            }
            var D = _n(P.D), Dsrc = 'input';
            if (!_fin(D)) {
                if (+P.Dest === 1 || P.Dest === true) {
                    var pD = _pos(_n(P.pD)) ? _n(P.pD) : spec.pr, gs = _gasState(c.sg, c.T, pD);
                    var e = estimateD({ k: k, phi: P.phi, sg: c.sg, mu: gs ? gs.mu : NaN, hp: _first(P.hp, h), rw: P.rw });
                    if (!e.ok) return e;
                    D = e.D; Dsrc = 'estimate (Geertsma β, μg at ' + _fix(pD, 0) + ' psia; ' + PROVISIONAL + ')'; w.push(e.warnings[0]);
                } else if (sk.ok && _fin(sk.D)) { D = sk.D; Dsrc = 'skin table'; }
                else { D = 0; Dsrc = 'none'; w.push(_w('D_ZERO', 'No non-Darcy coefficient: D = 0.', 'info')); }
            }
            if (!(x.X + S > 0)) return _fail('BAD_SKIN', 'ln-term + S must be above 0 (the skin is too negative for this drainage radius).');
            if (D < 0) return _fail('BAD_D', 'D must be 0 or more.');
            // m(p̄r) − m(pwf) = 1422·T·q/(k·h)·[X + S + D·q] → a = 1422·T·(X + S)/(k·h), b = 1422·T·D/(k·h)
            var a = C_DARCY_GAS * TR * (x.X + S) / (k * h), b = C_DARCY_GAS * TR * D / (k * h), m, form = 'm(p)';
            var aMp = a, bMp = b, units = { a: 'psi²/cp per Mscf/d', b: 'psi²/cp per (Mscf/d)²' };
            if (+P.p2 === 1 || P.p2 === true) {
                var pM = _pos(_n(P.pMean)) ? _n(P.pMean) : spec.pr, st = _gasState(c.sg, c.T, pM);
                if (!st) return _fail('NEEDS', 'μg and Z are not available at the mean pressure.');
                var mz = st.mu * st.z;
                // the p² coefficients actually used (a·μ̄z̄, b·μ̄z̄) are the ones stored; the m(p) ones stay as aMp / bMp
                a = aMp * mz; b = bMp * mz; units = { a: 'psi² per Mscf/d', b: 'psi² per (Mscf/d)²' };
                m = _gas({ lit: { a: a, b: b }, pr: spec.pr, pAof: P.pAof });
                form = 'p² with μ̄z̄ = ' + _fix(mz, 5) + ' cp at ' + _fix(pM, 0) + ' psia';
                w.push(_w('P2_APPROX', 'p² form: μ̄z̄ evaluated at ' + _fix(pM, 0) + ' psia (an approximation; the m(p) form is exact).', 'info'));
            } else m = _gas({ lit: { a: a, b: b }, pr: spec.pr, pAof: P.pAof, delta: _mpDelta(c.tb, spec.pr) });
            if (!m.ok) return m;
            P.S = S; P.D = D; P.sg = c.sg; P.a = a; P.b = b; P.aMp = aMp; P.bMp = bMp;
            return { ev: m, pAof: m.pAof, D: D, Dsource: Dsrc, skin: sk.ok ? sk : null,
                form: { ref: x.ref, label: x.label, X: x.X, Ssource: Ssrc, delta: form, a: a, b: b, aMp: aMp, bMp: bMp, units: units },
                engine: 'WTS_gasdeliv_model (' + form + ')' };
        } });

    function curve(spec, F, o) {
        spec = spec || {};
        o = o || {};
        var key = String(spec.model || '');
        var def = MODELS[key];
        if (!def) return _fail('UNKNOWN_MODEL', 'Unknown inflow model "' + key.slice(0, 40) + '".');
        var pr = _n(spec.pr);
        if (!_pos(pr)) return _fail('PR_NEEDED', 'p̄r needed: enter the average reservoir pressure (it is never defaulted).', { key: key, kind: def.kind });
        var warnings = [], P = _plainParams(spec.params);
        var s = { model: key, pr: pr, T_F: spec.T_F, pb: spec.pb, params: P, points: spec.points };
        var hasCoef = def.needs.filter(function (n) { return n !== 'pb' && n !== 'sg'; }).every(function (n) { return _fin(_n(P[n])); });
        if (!hasCoef && def.fit) {
            var f = _autoFit(key, s, warnings);
            if (f && f.ok) {
                for (var k in f.params) if (!_fin(_n(P[k]))) P[k] = f.params[k];
            } else if (f && !f.ok) return _fail('FIT_FAILED', f.errors.length ? f.errors : ['The fit failed.'], { key: key, kind: def.kind });
        }
        var b = def.build(s, P, warnings, F || null, o);
        if (!b || b.ok === false) { b = b || _fail('BAD_PARAMS', 'Inflow could not be built.'); b.key = key; b.kind = def.kind; b.warnings = (b.warnings || []).concat(warnings); return b; }
        var I = _mkI(key, { pr: pr, warnings: warnings }, b.ev, {
            pb: b.pb, J: b.J, pAof: def.kind === 'gas' ? b.pAof : 0, skin: b.skin, params: P, D: b.D, Dsource: b.Dsource, form: b.form, engine: b.engine });
        if (!I.skin && def.kind) {
            var sk = skin(Object.assign({}, P, { pbar: pr, kind: def.kind, T_F: spec.T_F }));
            if (sk.ok && sk.parts.length) I.skin = sk;
        }
        I.future = _future(spec, F, o, I);
        return I;
    }

    // ── fit (delegated, §3.3) ─────────────────────────────────────────────────
    function fit(kind, points, opts) {
        opts = opts || {};
        var pr = _n(opts.pr), warnings = [];
        var pts = (Array.isArray(points) ? points : []).filter(function (p) { return p && _pos(_n(p.q)) && _fin(_n(p.pwf)); })
            .map(function (p) { return { q: _n(p.q), pwf: _n(p.pwf), pws: _n(p.pws), kind: p.kind }; });
        var out = { ok: false, kind: kind, params: {}, r2: null, source: null, warnings: warnings, errors: [] };
        if (!_pos(pr)) { out.code = 'PR_NEEDED'; out.errors.push('p̄r needed for the fit.'); return out; }
        if (!pts.length) { out.code = 'NO_POINTS'; out.errors.push('No test point with a rate and a flowing pressure.'); return out; }
        if (kind === 'pi' || kind === 'vogel' || kind === 'composite' || kind === 'fetkovich') {
            if (typeof G.WTS_oilipr_compute !== 'function') { out.code = 'MISSING_ENGINE'; out.errors.push('WTS_oilipr_compute is not loaded.'); return out; }
            var pb = _n(opts.pb);
            var inp = { method: kind === 'fetkovich' ? 'fetk' : (kind === 'pi' ? 'pi' : 'vogel'), pr: pr,
                pb: kind === 'vogel' ? Math.max(pr, _fin(pb) ? pb : pr) : pb, fe: opts.FE, points: pts.slice(0, 4) };
            if (kind === 'composite' && !_fin(pb)) { out.code = 'PB_NEEDED'; out.errors.push('Bubble-point pressure is needed for the composite fit.'); return out; }
            var r = G.WTS_oilipr_compute(inp);
            if (!r.ok) { out.code = 'FIT_FAILED'; out.errors = r.errors.slice(); return out; }
            if (kind === 'pi') out.params = { J: r.J };
            else if (kind === 'vogel') out.params = { qmax: r.qmaxFE1, FE: _fin(_n(opts.FE)) ? _n(opts.FE) : 1 };
            else if (kind === 'composite') {
                if (r.mode !== 'composite') warnings.push(_w('SATURATED', 'pb ≥ p̄r: the composite fit is the saturated Vogel curve.', 'info'));
                out.params = { J: r.mode === 'composite' ? r.J : r.qmaxFE1 * 1.8 / pr };
            } else { out.params = { C: r.C, n: r.n }; out.r2 = r.r2; }
            (r.warnings || []).forEach(function (t) { warnings.push(_w('ENGINE', String(t).replace(/^[✓⚠✗]\s*/, ''))); });
            out.source = 'WTS_oilipr_compute'; out.ok = true; return out;
        }
        if (kind === 'backPressure' || kind === 'litP2') {
            if (typeof G.WTS_gasdeliv_compute !== 'function') { out.code = 'MISSING_ENGINE'; out.errors.push('WTS_gasdeliv_compute is not loaded.'); return out; }
            var type = opts.type || (pts.length === 1 ? 'single' : 'faf');
            var g = G.WTS_gasdeliv_compute({ type: type, pr: pr, pb: _fin(_n(opts.pAof)) ? _n(opts.pAof) : P_AOF, nAssumed: _fin(_n(opts.n)) ? _n(opts.n) : 0.85,
                points: pts.map(function (p, i) { return { kind: p.kind === 'trans' ? 'trans' : 'stab', q: p.q, pwf: p.pwf, pws: _fin(p.pws) ? p.pws : null, row: i + 1 }; }) });
            if (!g.ok) { out.code = 'FIT_FAILED'; out.errors = g.errors.slice(); return out; }
            if (kind === 'backPressure') { out.params = { C: g.cn.C, n: g.cn.n }; out.r2 = g.cn.r2; }
            else {
                if (!g.lit.ok) { out.code = 'FIT_FAILED'; out.errors.push('LIT fit: ' + (g.lit.reason || 'not available')); return out; }
                out.params = { a: g.lit.a, b: g.lit.b };
            }
            (g.warnings || []).forEach(function (t) { warnings.push(_w('ENGINE', String(t).replace(/^[✓⚠✗]\s*/, ''))); });
            out.source = 'WTS_gasdeliv_compute'; out.ok = true; return out;
        }
        if (kind === 'jbgOil' || kind === 'litMp') {
            if (typeof G.WTS_gasdeliv_fitAB !== 'function') { out.code = 'MISSING_ENGINE'; out.errors.push('WTS_gasdeliv_fitAB is not loaded.'); return out; }
            var dFn;
            if (kind === 'jbgOil') dFn = function (p) { return pr - p.pwf; };
            else {
                var T = _n(opts.T_F), sg = _n(opts.sg);
                if (!_fin(T) || !_pos(sg)) { out.code = 'NEEDS'; out.errors.push('The m(p) fit needs the reservoir temperature and the gas gravity.'); return out; }
                var tb = _mpTable(T, sg, pr);
                if (!tb) { out.code = 'MISSING_ENGINE'; out.errors.push('PRiSM_mpTable is not available.'); return out; }
                var mpr = tb.mOf(pr);
                dFn = function (p) { return mpr - tb.mOf(p.pwf); };
            }
            var fo = { b: opts.b };
            var ab = G.WTS_gasdeliv_fitAB(pts, dFn, fo);
            if (!ab.ok) { out.code = 'FIT_FAILED'; out.errors.push(ab.reason || 'The two-term fit failed.'); return out; }
            out.params = kind === 'jbgOil' ? { A: ab.a, B: ab.b } : { a: ab.a, b: ab.b };
            out.r2 = ab.r2; out.source = 'WTS_gasdeliv_fitAB'; out.ok = true; return out;
        }
        out.code = 'NOT_FITTABLE';
        out.errors.push('The ' + ((MODELS[kind] || {}).label || kind) + ' model is not fitted to rates here (use "IPR from a test" for p̄r, J or S).');
        return out;
    }

    // ── PRiSM import (§2.10, US3) ─────────────────────────────────────────────
    function fromWell(o) {
        o = o || {};
        var warnings = [], prov = {};
        if (typeof G.PRiSM_getWell !== 'function') return _fail('MISSING_ENGINE', 'PRiSM is not loaded (PRiSM_getWell).', { name: 'PRiSM_getWell' });
        var w = null, lf = null;
        try { w = G.PRiSM_getWell(); } catch (e) { w = null; }
        if (!w) return _fail('NO_WELL', 'PRiSM has no well inputs.');
        if (typeof G.PRiSM_getLastFit === 'function') { try { lf = G.PRiSM_getLastFit(); } catch (e2) { lf = null; } }
        var wp = w.provenance || {}, gas = w.fluid === 'gas', P = {};
        function put(key, v, src) { v = _n(v); if (_fin(v)) { P[key] = v; prov[key] = src; } }
        function wsrc(k) { return 'PRiSM well (' + (wp[k] || 'default') + ')'; }
        put('h', w.h, wsrc('h')); put('rw', w.rw, wsrc('rw')); put('phi', w.phi, wsrc('phi')); put('ct', w.ct, wsrc('ct'));
        if (gas) { put('Bg', w.B, wsrc('B')); put('mug', w.mu, wsrc('mu')); put('sg', w.sg, 'PRiSM well'); }
        else { put('Bo', w.B, wsrc('B')); put('muo', w.mu, wsrc('mu')); }
        var ph = lf && lf.phys ? lf.phys : null;
        if (ph) {
            var fsrc = 'PRiSM fit' + (lf.modelKey ? ' (' + lf.modelKey + ')' : '');
            put('k', ph.k, fsrc); put('S', _fin(_n(ph.S)) ? ph.S : (lf.params || {}).S, fsrc); put('D', ph.D, fsrc); put('xf', ph.xf, fsrc);
            if (!_fin(_n(ph.S)) && _fin(_n((lf.params || {}).S))) prov.S = fsrc;
        } else warnings.push(_w('NO_FIT', 'No PRiSM model fit: k and S are not imported.', 'info'));
        var pr = _n(w.pi);
        if (_fin(pr)) prov.pr = 'PRiSM well (' + (wp.pi || 'user') + ')';
        else { pr = null; warnings.push(_w('PR_NEEDED', 'p̄r needed: PRiSM\'s reservoir pressure is a default value, so it is not imported (never defaulted).')); }
        var T = _n(w.T_F);
        if (_fin(T)) prov.T_F = 'PRiSM well';
        var model = gas ? 'darcyGas' : 'darcyOil', deliv = null;
        var st = G.PRiSM_state && G.PRiSM_state.deliverability;
        if (st && st.summary) {
            var hashNow = null;
            try { hashNow = typeof G.PRiSM_datasetHash === 'function' ? G.PRiSM_datasetHash() : null; } catch (e3) { hashNow = null; }
            if (!st.datasetHash || st.datasetHash === hashNow) deliv = st;
            else warnings.push(_w('DELIV_STALE', 'The stored deliverability result belongs to another dataset: not imported.', 'info'));
        }
        if (deliv && deliv.kind === 'gas') {
            var s = deliv.summary, dsrc = 'PRiSM gas deliverability (' + (s.type || 'test') + ')';
            put('C', s.C, dsrc); put('n', s.n, dsrc); put('a', s.a, dsrc); put('b', s.b, dsrc); put('aofCn', s.aofCn, dsrc); put('aofLit', s.aofLit, dsrc);
            put('pAof', s.pb, dsrc);
            model = _fin(_n(s.a)) && _fin(_n(s.b)) ? 'litP2' : 'backPressure';
            if (pr == null && _pos(_n(s.pr))) warnings.push(_w('DELIV_PR', 'The deliverability analysis used p̄r = ' + _fix(s.pr, 1) + ' psia; enter it if it is the current reservoir pressure.', 'info'));
        } else if (deliv && deliv.kind !== 'gas' && deliv.summary) {
            var so = deliv.summary, osrc = 'PRiSM oil deliverability (' + (so.mode || 'IPR') + ')';
            if (so.mode === 'pi' || so.mode === 'composite') { put('J', so.J, osrc); }
            if (so.mode === 'vogel-sat') { put('qmax', so.qmax, osrc); put('FE', so.fe, osrc); }
            if (so.mode === 'fetkovich') { put('C', so.C, osrc); put('n', so.n, osrc); }
            if (!(_pos(P.k) && _pos(P.h))) model = { pi: 'pi', composite: 'composite', 'vogel-sat': 'vogel', fetkovich: 'fetkovich' }[so.mode] || model;
        }
        if ((model === 'darcyOil' || model === 'darcyGas') && !(_pos(P.k) && _pos(P.h))) warnings.push(_w('NEEDS_KH', 'k or h is missing: complete them before the Darcy inflow can be drawn.'));
        if (!_pos(P.re)) warnings.push(_w('NEEDS_RE', 'PRiSM does not carry a drainage radius: enter re.', 'info'));
        return { ok: true, spec: { model: model, pr: pr, T_F: _fin(T) ? T : null, pb: null, params: P, points: [], provenance: prov },
            provenance: prov, warnings: warnings, errors: [] };
    }

    // ── skin table (§4.3) ─────────────────────────────────────────────────────
    function skin(spec) {
        spec = spec || {};
        var P = spec.params ? Object.assign({}, spec.params, { pbar: _first(spec.params.pbar, spec.pr), T_F: _first(spec.params.T_F, spec.T_F) }) : spec;
        var warnings = [], notes = [], parts = [];
        var k = _n(P.k), h = _n(P.h), rw = _n(P.rw), hp = _n(P.hp), kvkh = _first(P.kvkh, 1);
        if (!_pos(h)) return { ok: false, code: 'NEEDS_H', errors: ['The skin table needs the formation thickness h.'], warnings: [], parts: [], total: 0, Sconst: 0, D: null,
            dpSkin: function () { return null; }, FE: null };
        if (!_pos(hp)) hp = h;
        if (hp > h) { warnings.push(_w('HP_GT_H', 'h_p is larger than h: h_p = h used.')); hp = h; }
        var hr = h / hp;
        function part(key, label, S, basis, source) {
            if (!_fin(S)) return;
            parts.push({ key: key, label: label, S: S, basis: basis, Sh: basis === 'hp' ? S * hr : S, source: source });
        }
        function needK(what) { warnings.push(_w('NEEDS_K', what + ' needs the formation permeability k.')); }
        // geometric skins on h (PRiSM_skinDecomposition)
        var theta = _n(P.theta), xf = _n(P.xf);
        if (hp < h || (_fin(theta) && theta !== 0) || _pos(xf)) {
            if (typeof G.PRiSM_skinDecomposition === 'function' && _pos(rw)) {
                var d = G.PRiSM_skinDecomposition({ S_total: 0, geom: { h: h, rw: rw, hp: hp < h ? hp : null, kvkh: kvkh, theta: _fin(theta) ? theta : null, xf: _pos(xf) ? xf : null } });
                var used = (d && d.used) || [];
                if (hp < h && used.some(function (u) { return /partial/.test(u); })) part('pp', 'Partial penetration (Brons-Marting)', d.S_pp, 'h', 'PRiSM_skinDecomposition');
                if (used.some(function (u) { return /deviation/.test(u); })) part('theta', 'Well deviation (Cinco-Ley, Ramey & Miller)', d.S_theta, 'h', 'PRiSM_skinDecomposition');
                if (used.some(function (u) { return /fracture/.test(u); })) part('frac', 'Fracture (r_w′ = x_f/2)', d.S_f, 'h', 'PRiSM_skinDecomposition');
            } else warnings.push(_w('NO_GEOM', 'Partial penetration, deviation and fracture skins need rw and PRiSM_skinDecomposition.'));
        }
        // damage (Hawkins 1956) on h_p
        var ks = _n(P.ks), rs = _n(P.rs);
        if (_pos(ks) || _pos(rs)) {
            if (!_pos(k)) needK('The damage skin');
            else if (!_pos(ks) || !_pos(rs) || !_pos(rw) || !(rs > rw)) warnings.push(_w('NEEDS_DAMAGE', 'The damage skin needs k_s, r_s above rw and rw.'));
            else part('damage', 'Damage (Hawkins)', (k / ks - 1) * Math.log(rs / rw), 'hp', 'Hawkins (1956)');
        }
        // perforation: user-entered while the Karakas-Tariq table is unverified (D11)
        var nperf = _first(P.nperf, _pos(_n(P.spf)) ? _n(P.spf) * hp : NaN);
        if (_fin(_n(P.Sperf))) part('perf', 'Perforation (user-entered)', _n(P.Sperf), 'hp', 'user');
        else if (_pos(_n(P.Lp_in)) && _pos(_n(P.rp_in)) && _pos(_n(P.spf))) {
            var SC = G.PRiSM_skinCheck, kt = SC && typeof SC.perforationSkin === 'function'
                ? SC.perforationSkin({ rw_ft: rw, lp_in: _n(P.Lp_in), rp_in: _n(P.rp_in), spf: _n(P.spf), phase_deg: _first(P.phase_deg, 90), kvkh: kvkh }) : null;
            if (kt && kt.ok) part('perf', 'Perforation (Karakas-Tariq)', kt.S_perf, 'hp', 'PRiSM_skinCheck.perforationSkin');
            else warnings.push(_w('KT_DISABLED', 'Karakas-Tariq perforation skin is disabled while its coefficient table is unverified: enter the perforation skin.'));
        }
        // crushed zone (McLeod 1983) on h_p: S_dp = (h_p/(L_p·n))·(k/k_dp − k/k_d)·ln(r_dp/r_p), L_p ft
        var kdp = _n(P.kdp);
        if (_pos(kdp)) {
            var Lp = _n(P.Lp_in) / 12, rdp = _n(P.rdp_in), rp = _n(P.rp_in), kd = _first(P.kd, k);
            if (!_pos(k)) needK('The crushed-zone skin');
            else if (!_pos(Lp) || !_pos(rp) || !(rdp > rp) || !_pos(nperf) || !_pos(kd)) warnings.push(_w('NEEDS_CRUSHED', 'The crushed-zone skin needs L_p, r_p, r_dp above r_p and the shot density (or the number of perforations).'));
            else part('crushed', 'Crushed zone (McLeod)', (hp / (Lp * nperf)) * (k / kdp - k / kd) * Math.log(rdp / rp), 'hp', 'McLeod (1983)');
        }
        // gravel pack in perforation tunnels on h_p: S_gp = 96·k·h_p·L_g/(k_g·n·d_p²), h_p ft, L_g and d_p in
        var kg = _n(P.kg);
        if (_pos(kg)) {
            var Lg = _n(P.Lg_in), dpi = _n(P.dp_in);
            if (!_pos(k)) needK('The gravel-pack skin');
            else if (!_pos(Lg) || !_pos(dpi) || !_pos(nperf)) warnings.push(_w('NEEDS_GP', 'The gravel-pack skin needs the tunnel length L_g, the tunnel diameter d_p and the number of open perforations.'));
            else part('gravel', 'Gravel pack in the tunnels', 96 * k * hp * Lg / (kg * nperf * dpi * dpi), 'hp', 'linear Darcy flow in the tunnels (' + PROVISIONAL + ')');
        }
        // rate-dependent skin D·q on h
        var D = _n(P.D), Dsrc = 'input';
        if (!_fin(D) && Array.isArray(P.rateRows) && typeof G.PRiSM_rateDependentSkin === 'function') {
            var rd = G.PRiSM_rateDependentSkin(P.rateRows);
            if (rd && rd.ok) { D = rd.D; Dsrc = 'PRiSM_rateDependentSkin'; notes.push('S′ = S + D·q fitted to ' + rd.n + ' rates (S = ' + _fix(rd.S, 3) + ').'); }
        }
        var qRef = _n(P.q);
        if (_fin(D) && _pos(qRef)) part('nonDarcy', 'Non-Darcy D·q at ' + _fix(qRef, 0), D * qRef, 'h', Dsrc);
        var total = 0, Dq = 0;
        parts.forEach(function (p) { total += p.Sh; if (p.key === 'nonDarcy') Dq = p.Sh; });
        var Sconst = total - Dq;
        if (parts.filter(function (p) { return p.basis === 'hp'; }).length > 1) {
            notes.push('Near-well parts are summed; the overlap of damage, crushed zone and perforations ending inside the damaged zone is not modelled.');
        }
        if (hr !== 1) notes.push('Parts on the open interval are referred to h by h/h_p = ' + _fix(hr, 3) + '.');
        var gas = P.kind === 'gas';
        var SC2 = G.PRiSM_skinCheck, B = _first(P.Bo, P.B), mu = _first(P.muo, P.mu), re = _n(P.re), pbar = _n(P.pbar);
        function Sof(q) { return Sconst + (_fin(D) ? D * Math.abs(q) : 0); }
        var dpSkin = function (q, pwf) {
            q = _n(q);
            if (!_pos(q) || !_pos(k)) return null;
            var S = Sof(q);
            if (gas) {
                var T = _n(P.T_F), sg = _n(P.sg);
                pwf = _n(pwf);
                if (!_fin(T) || !_pos(sg) || !_pos(pwf)) return null;
                var tb = _mpTable(T, sg, _pos(pbar) ? pbar : 2 * pwf);
                if (!tb) return null;
                var m0 = tb.mOf(pwf), dm = C_DARCY_GAS * q * (T + RANK) * S / (k * h);
                if (!(m0 + dm > 0)) return null;
                return tb.pOf(m0 + dm) - pwf;
            }
            if (!SC2 || typeof SC2.products !== 'function') return null;
            var pr0 = SC2.products({ S: S, k: k, h: h, B: B, mu: mu, Dq: q });
            return _fin(pr0.dpSkin_psi) ? pr0.dpSkin_psi : null;
        };
        var FE = null, FEbasis = null;
        if (SC2 && typeof SC2.products === 'function' && !gas) {
            var pwf0 = _n(P.pwf), q0 = _n(P.q);
            if (_pos(k) && _pos(B) && _pos(mu) && _pos(q0) && _fin(pbar) && _fin(pwf0)) {
                var pa = SC2.products({ S: Sof(q0), k: k, h: h, B: B, mu: mu, Dq: q0, pbar: pbar, pwf: pwf0, rw: rw, re_ft: re });
                if (_fin(pa.FE)) { FE = pa.FE; FEbasis = 'at the test point'; }
            }
            if (FE == null && _pos(re) && _pos(rw)) {
                var pb2 = SC2.products({ S: Sconst, rw: rw, re_ft: re });
                if (_fin(pb2.piRatio)) { FE = pb2.piRatio; FEbasis = 'PI ratio X/(X + S), pseudo-steady state'; }
            }
        }
        return { ok: true, parts: parts, total: total, Sconst: Sconst, D: _fin(D) ? D : null, Dsource: _fin(D) ? Dsrc : null,
            dpSkin: dpSkin, FE: FE, FEbasis: FEbasis, h: h, hp: hp, hOverHp: hr, warnings: warnings, notes: notes, errors: [] };
    }

    // ── public ────────────────────────────────────────────────────────────────
    var api = G.WTS_wp_ipr = G.WTS_wp_ipr || {};
    api.models = api.models || {};
    Object.keys(MODELS).forEach(function (k) {
        var d = MODELS[k];
        api.models[k] = { key: d.key, label: d.label, kind: d.kind, needs: d.needs.slice(), verified: !!d.verified,
            provisional: d.verified ? null : PROVISIONAL, fittable: !!d.fit,
            curve: (function (key) { return function (spec, F, o) { return curve(Object.assign({}, spec || {}, { model: key }), F, o); }; })(k) };
    });
    api.curve = curve;
    api.fit = fit;
    api.fromWell = fromWell;
    api.skin = skin;
    api.estimateD = estimateD;
    api.darcyX = darcyX;
    api.PROVISIONAL = PROVISIONAL;
    api.CONST = { P_AOF: P_AOF, C_DARCY_OIL: C_DARCY_OIL, C_DARCY_GAS: C_DARCY_GAS, C_FORCH: C_FORCH, C_D: C_D, C_BETA: C_BETA };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var W = G.WTS_wp_ipr, bad = [];
    if (!W || typeof W.curve !== 'function') return;
    if (typeof G.WTS_oilipr_model === 'function') {
        var I = W.curve({ model: 'pi', pr: 3000, params: { J: 2 } });
        if (!I.ok || Math.abs(I.aof - 6000) > 1e-9 || Math.abs(I.pwfAt(I.qAt(1234)) - 1234) > 1e-9) bad.push('pi');
    }
    var x = W.darcyX({ rw: 0.354, re: 1490 });
    if (!x.ok || Math.abs(x.X - (Math.log(1490 / 0.354) - 0.75)) > 1e-12) bad.push('darcyX');
    var sk = W.skin({ k: 100, h: 50, rw: 0.354, ks: 10, rs: 2 });
    if (!sk.ok || Math.abs(sk.total - 9 * Math.log(2 / 0.354)) > 1e-12) bad.push('hawkins');
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-ipr.js self-test] ' + bad.join('; '));
})();
