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
// Increment B (WP24; every model verified:false, provisional, never a default — Q9):
//   B keys (B_KEYS)           wcComposite {J, fw? (default F.wc)} · joshi {k, h, L, kvkh, rw, re = r_eh, S} · babuOdeh {k, h, L, kvkh, rw,
//                             boxA, boxB, xPos? (x0), zPos? (z0), yMid?, S} · furui {k, h, L, kvkh, rw, yb, S} (L blank = the perforated MD interval of
//                             spec.perf) · frac {k, h, rw, re, xf, FcD | kfw, S} · fracGas (+ D, sg) · transient {k, h, phi, ct, rw, tFlow h,
//                             S, re?} · multilayer (spec.layers rows {name, topMd, botMd, tvdTop?, tvdBot?, pr, J | a, b | k, h, S, pb?}, rw, re)
//                             · injector {II | k, h, rw, re, S (water); a, b | k, h, S, D (gas, m(p)); pfrac}
//   curve(spec, F, o)         o.tvdAt(md) / o.refMd: the well path for the multilayer layer depths (the solver and the page pass it)
//   I extras                  horizontal {L, Iani} · frac {xf, FcD, sf} · transient {t, tPss, kh, jOfT(t)} · layers [..], layerRates(pwf)
//                             → [{name, md, tvd, pr, pLayer, q (< 0 crossflow), crossflow}], crossflow {pws, rate, thief[], layers}, prInput
//                             (I.pr = the commingled static pressure p_ws) · inj true, pFrac, qLimit (= aof, the rate at the pressure
//                             limit), II, injector {fluid, II, pfrac, pLim, qLim, limitIsFrac}; I.kind 'oil' | 'gas' | 'inj'; I.future null
//                             for multilayer and injector
//   fromBuildup(state?, o?)   Build-up Surveillance hand-off (§2.10) → {ok, spec:{model, pr, params:{k, h, S, rw?, re?}, provenance}, test,
//                             warnings}; state defaults to WTS_buildup.store.loadState(); o.midPerfTvd moves p_ext from the datum
//   fracSkin(o), babuOdehX(o), transientJ(o)   the closed forms (exported for the tests and wellperf-validate)
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
        var pmin = _fin(extra.curveTo) ? extra.curveTo : (_fin(extra.pAof) ? extra.pAof : 0);   // an injector's curve runs up to its pressure limit
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

    // ═════════════════════════════════════════════════════════════════════════
    // Increment B (WP24, docs/WELL-PERFORMANCE-PLAN.md §4.2 "Increment B", §3.3): water-cut composite, horizontal (Joshi, Babu-Odeh,
    // Furui), fractured (Prats / Cinco-Ley-Samaniego F_cD), transient (line source), multilayer with crossflow, injector. Q9: no
    // textbooks — every B model ships verified:false with the provisional label (D17) and none is a default. Oil below pb: the
    // delegated composite (WTS_oilipr_model) with the model's J, as darcyOil. Field units: k md, h / L / rw / re / xf ft, μ cp,
    // B rb/STB, ct 1/psi, t h, q STB/d (oil, water) or Mscf/d (gas), p psia.
    // ═════════════════════════════════════════════════════════════════════════
    function _bmu(P, F, spec, w, water) {          // Bo / μo (or Bw / μw) from the inputs, else the fluid at p̄r
        var B = _n(water ? P.Bw : P.Bo), mu = _n(water ? P.muw : P.muo), src = 'input';
        if ((!_pos(B) || !_pos(mu)) && F && F.ok && typeof F.at === 'function') {
            var pp = null;
            try { pp = F.at(spec.pr, _n(spec.T_F)); } catch (e) { pp = null; }
            if (pp) {
                if (!_pos(B)) B = _n(water ? pp.bw : pp.bo);
                if (!_pos(mu)) mu = _n(water ? pp.muw : pp.muo);
                src = 'fluid at p̄r';
            }
        }
        if (water) { if (!_pos(B)) B = 1.0; if (!_pos(mu)) { mu = 0.5; w.push(_w('MUW_DEFAULT', 'Water viscosity not available: 0.5 cp used.', 'info')); } }
        return (_pos(B) && _pos(mu)) ? { B: B, mu: mu, src: src } : null;
    }
    // J → the delegated oil curve (composite below pb when the bubble point is known; straight line otherwise)
    function _oilFromJ(spec, F, w, J, form, extra) {
        var pb = _pbOf(spec, F, w), m;
        if (_fin(pb) && pb > 0) m = _oil({ mode: 'composite', pr: spec.pr, pb: pb, J: J });
        else { m = _oil({ mode: 'pi', pr: spec.pr, J: J }); w.push(_w('NO_PB', 'No bubble point: straight-line PI from J.', 'info')); }
        if (!m.ok) return m;
        var o = { ev: m, J: J, pb: m.pb, form: form, engine: 'WTS_oilipr_model (' + (m.mode === 'composite' ? 'composite' : 'PI') + ')' };
        if (extra) for (var k in extra) o[k] = extra[k];
        return o;
    }
    function _perfLen(spec) { var pf = spec.perf || {}; var a = _n(pf.topMd), b = _n(pf.botMd); return (_fin(a) && _fin(b) && b > a) ? b - a : NaN; }
    function _kv(P) { var r = _first(P.kvkh, 0.1); return (r > 0 && r <= 10) ? r : NaN; }
    // monotone inverse q(pwf) of a decreasing pwf(q) on [0, qMax] (bisection to 1e-14·qMax, then the exact inverse holds to 1e-9)
    function _invQ(pwfOf, qMax, pwf) {
        var lo = 0, hi = qMax;
        for (var i = 0; i < 200 && hi - lo > 1e-14 * qMax; i++) { var mid = 0.5 * (lo + hi); if (pwfOf(mid) > pwf) lo = mid; else hi = mid; }
        return 0.5 * (lo + hi);
    }

    // ── water-cut composite three-phase IPR (the water-cut-weighted composite as given by Brown 1984): oil composite (PI above pb, Vogel below)
    // and water PI weighted by the fractional flow f_w = WC; beyond the oil Vogel maximum q_o,max a straight line with the
    // slope of the weighted curve at q_o,max (exact limit: dpwf/dq = −(f_w + 9·f_o)/J) to pwf = 0 at q_t,max.
    reg({ key: 'wcComposite', label: 'Water-cut composite (oil Vogel + water PI)', kind: 'oil', needs: ['J', 'pb'], verified: false,
        build: function (spec, P, w, F) {
            var J = _n(P.J);
            if (!_pos(J)) return _fail('NEEDS', 'The water-cut composite IPR needs the liquid productivity index J (above the bubble point).');
            var pb = _pbOf(spec, F, w);
            if (!_fin(pb)) return _fail('PB_NEEDED', 'Bubble-point pressure is needed for the water-cut composite IPR.');
            var pr = spec.pr; if (pb > pr) pb = pr;
            var fw = _n(P.fw);
            if (!_fin(fw)) fw = (F && F.ok && _fin(F.wc)) ? F.wc : 0;
            if (!(fw >= 0 && fw <= 1)) return _fail('BAD_WC', 'The water cut must be 0–100 %.');
            var fo = 1 - fw, oil = _oil({ mode: 'composite', pr: pr, pb: pb, J: J });
            if (!oil.ok) return oil;
            var qb = J * (pr - pb), qom = qb + J * pb / 1.8, slope = -(fw + 9 * fo) / J;
            var pAtQom = fw * (pr - qom / J);                      // the oil branch is at pwf = 0 there
            var qtm = qom + pAtQom / -slope;
            var pwfOf = function (q) {
                if (q <= qb) return pr - q / J;
                if (q <= qom) return fw * (pr - q / J) + fo * oil.pwfAt(q);
                return Math.max(0, pAtQom + slope * (q - qom));
            };
            var ev = {
                aof: qtm,
                pwfAt: function (q) { q = +q; if (!_fin(q)) return null; if (q <= 0) return pr; if (q > qtm * (1 + 1e-12)) return null; return pwfOf(Math.min(q, qtm)); },
                qAt: function (pwf) { pwf = +pwf; if (!_fin(pwf)) return NaN; if (pwf >= pr) return 0; if (pwf <= 0) return qtm;
                    if (pwf >= pb) return J * (pr - pwf); return _invQ(pwfOf, qtm, pwf); }
            };
            P.fw = fw;
            return { ev: ev, J: J, pb: pb, form: { fw: fw, qb: qb, qoMax: qom, qtMax: qtm, slope: slope, label: 'water-cut-weighted composite (Brown 1984)' },
                engine: 'WTS_oilipr_model (composite oil) + water PI' };
        } });

    // ── horizontal wells. L = the lateral (default: the perforated MD length, so the deviated survey sets it) ───────────
    function _hzCommon(spec, P, w, F) {
        var k = _n(P.k), h = _n(P.h), rw = _n(P.rw), L = _n(P.L), kv = _kv(P);
        if (!_pos(L)) { L = _perfLen(spec); if (_pos(L)) w.push(_w('L_FROM_PERFS', 'Lateral length L = the perforated MD interval (' + _fix(L, 0) + ' ft).', 'info')); }
        if (!_pos(k) || !_pos(h)) return _fail('NEEDS', 'Horizontal inflow needs the horizontal permeability k and the thickness h.');
        if (!_pos(rw)) return _fail('NEEDS_RW', 'Wellbore radius rw is needed.');
        if (!_pos(L)) return _fail('NEEDS_L', 'The lateral length L is needed (or the perforation interval in step ③).');
        if (!_fin(kv)) return _fail('BAD_KVKH', 'kv/kh must be above 0 (at most 10).');
        var bm = _bmu(P, F, spec, w);
        if (!bm) return _fail('NEEDS', 'Horizontal oil inflow needs Bo and μo (enter them or build the fluid).');
        var S = _n(P.S); if (!_fin(S)) S = 0;
        return { ok: true, k: k, h: h, rw: rw, L: L, kv: kv, Iani: Math.sqrt(1 / kv), B: bm.B, mu: bm.mu, BmuSource: bm.src, S: S };
    }
    // Joshi (1988), steady state with p_e at r_eh; anisotropy term in the form of Economides et al. (I_ani = √(kh/kv)):
    // J = k·h / (141.2·Bo·μo·{ln[(a + √(a² − (L/2)²)) / (L/2)] + (I_ani·h/L)·ln[I_ani·h / (rw·(I_ani + 1))] + S}),
    // a = (L/2)·[0.5 + √(0.25 + (2·r_eh/L)⁴)]^0.5
    reg({ key: 'joshi', label: 'Horizontal well — Joshi (1988)', kind: 'oil', needs: ['k', 'h', 'L', 'kvkh', 'rw', 're', 'S'], verified: false, horizontal: true,
        build: function (spec, P, w, F) {
            var c = _hzCommon(spec, P, w, F); if (!c.ok) return c;
            var reh = _n(P.re);
            if (!_pos(reh)) return _fail('NEEDS_RE', 'Drainage radius r_eh is needed for the Joshi IPR.');
            if (!(c.L / 2 < 0.9 * reh)) return _fail('L_TOO_LONG', 'Joshi needs L/2 < 0.9·r_eh (the lateral is too long for this drainage radius).');
            var a = (c.L / 2) * Math.sqrt(0.5 + Math.sqrt(0.25 + Math.pow(2 * reh / c.L, 4)));
            var t1 = Math.log((a + Math.sqrt(a * a - c.L * c.L / 4)) / (c.L / 2)), t2 = (c.Iani * c.h / c.L) * Math.log(c.Iani * c.h / (c.rw * (c.Iani + 1)));
            var X = t1 + t2;
            if (!(X + c.S > 0)) return _fail('BAD_SKIN', 'The skin is too negative for this geometry (denominator ≤ 0).');
            var J = c.k * c.h / (C_DARCY_OIL * c.B * c.mu * (X + c.S));
            var Jv = (_pos(c.rw) && reh > c.rw) ? c.k * c.h / (C_DARCY_OIL * c.B * c.mu * Math.log(reh / c.rw)) : null;
            if (c.L > 0.8 * 2 * reh) w.push(_w('HZ_LONG', 'The lateral is close to the drainage diameter: the Joshi ellipse is stretched.', 'info'));
            P.L = c.L; P.S = c.S;
            return _oilFromJ(spec, F, w, J, { a: a, t1: t1, t2: t2, X: X, L: c.L, Iani: c.Iani, reh: reh, BmuSource: c.BmuSource, Jvertical: Jv, ratio: Jv ? J / Jv : null,
                label: 'Joshi (1988), steady state, p_e at r_eh' }, { horizontal: { L: c.L, Iani: c.Iani } });
        } });
    // Babu & Odeh (1989), pseudo-steady state in a box a (x, across the well) × b (y, along the well) × h, well at (x0, z0), centre y_mid:
    // J = 0.00708·b·√(kx·kz) / (Bo·μo·[ln(√A/rw) + ln C_H − 0.75 + s_R + S]), A = a·h (0.00708 = 1/141.2)
    // ln C_H = 6.28·(a/h)·√(kz/kx)·[1/3 − x0/a + (x0/a)²] − ln(sin(π·z0/h)) − 0.5·ln[(a/h)·√(kz/kx)] − 1.088
    // s_R (partial penetration, L < b): case 1 (a/√kx ≥ 0.75·b/√ky ≥ 0.75·h/√kz) s_R = P_xyz + P'_xy; case 2 (b/√ky ≥ 1.33·a/√kx ≥ h/√kz)
    // s_R = P_xyz + P_y + P_xy, with the published P terms and F(x) (code below). kx = ky = k, kz = (kv/kh)·k.
    function _boF(x) {
        if (!(x > 0)) return 0;
        if (x <= 1) return -x * (0.145 + Math.log(x) - 0.137 * x * x);
        var y = 2 - x; if (!(y > 0)) return 0;
        return y * (0.145 + Math.log(y) - 0.137 * y * y);
    }
    function babuOdehX(o) {
        var a = o.a, b = o.b, h = o.h, L = o.L, rw = o.rw, kx = o.kx, ky = o.ky, kz = o.kz;
        var x0 = _fin(o.x0) ? o.x0 : a / 2, z0 = _fin(o.z0) ? o.z0 : h / 2, ym = _fin(o.ymid) ? o.ymid : b / 2;
        var r = Math.sqrt(kz / kx), A = a * h, s = Math.sin(Math.PI * z0 / h);
        var lnCH = 6.28 * (a / h) * r * (1 / 3 - x0 / a + (x0 / a) * (x0 / a)) - Math.log(s) - 0.5 * Math.log((a / h) * r) - 1.088;
        var sR = 0, kase = 'full';
        if (L < b * (1 - 1e-9)) {
            var Pxyz = (b / L - 1) * (Math.log(h / rw) + 0.25 * Math.log(kx / kz) - Math.log(s) - 1.84);
            var A1 = a / Math.sqrt(kx), B1 = b / Math.sqrt(ky), H1 = h / Math.sqrt(kz);
            if (B1 >= 1.33 * A1 && A1 >= H1) {
                var Py = (6.28 * b * b / (a * h)) * (Math.sqrt(kx * kz) / ky) * ((1 / 3 - ym / b + ym * ym / (b * b)) + (L / (24 * b)) * (L / b - 3));
                var Pxy = (b / L - 1) * (6.28 * a / h) * r * (1 / 3 - x0 / a + (x0 / a) * (x0 / a));
                sR = Pxyz + Py + Pxy; kase = 'case 2';
            } else {
                var Pxy1 = (2 * b * b / (L * h)) * Math.sqrt(kz / ky) * (_boF(L / (2 * b)) + 0.5 * (_boF((4 * ym + L) / (2 * b)) - _boF((4 * ym - L) / (2 * b))));
                sR = Pxyz + Pxy1; kase = (A1 >= 0.75 * B1 && 0.75 * B1 >= 0.75 * H1) ? 'case 1' : 'case 1 (outside both published cases)';
            }
        }
        var X = Math.log(Math.sqrt(A) / rw) + lnCH - 0.75 + sR;
        return { X: X, lnCH: lnCH, sR: sR, kase: kase, A: A, x0: x0, z0: z0, ymid: ym };
    }
    reg({ key: 'babuOdeh', label: 'Horizontal well — Babu-Odeh (1989), box', kind: 'oil', needs: ['k', 'h', 'L', 'kvkh', 'rw', 'boxA', 'boxB', 'xPos', 'zPos', 'yMid', 'S'], verified: false, horizontal: true,
        build: function (spec, P, w, F) {
            var c = _hzCommon(spec, P, w, F); if (!c.ok) return c;
            var a = _n(P.boxA), b = _n(P.boxB);
            if (!_pos(a) || !_pos(b)) return _fail('NEEDS_BOX', 'Babu-Odeh needs the drainage box: a (across the well) and b (along the well).');
            if (c.L > b * (1 + 1e-9)) return _fail('L_GT_B', 'The lateral L must not exceed the box length b.');
            var x0 = _n(P.xPos), z0 = _n(P.zPos), ym = _n(P.yMid);
            if (_fin(x0) && !(x0 > 0 && x0 < a)) return _fail('BAD_X0', 'x0 must lie inside the box (0 < x0 < a).');
            if (_fin(z0) && !(z0 > 0 && z0 < c.h)) return _fail('BAD_Z0', 'z0 must lie inside the layer (0 < z0 < h).');
            if (_fin(ym) && !(ym - c.L / 2 >= -1e-9 && ym + c.L / 2 <= b + 1e-9)) return _fail('BAD_YMID', 'The lateral must lie inside the box along y (L/2 ≤ y_mid ≤ b − L/2).');
            var kx = c.k, kz = c.k * c.kv, bo = babuOdehX({ a: a, b: b, h: c.h, L: c.L, rw: c.rw, kx: kx, ky: kx, kz: kz, x0: x0, z0: z0, ymid: ym });
            if (/outside/.test(bo.kase)) w.push(_w('BO_CASE', 'Babu-Odeh: the box is outside both published partial-penetration cases; case 1 is used.'));
            if (!(bo.X + c.S > 0)) return _fail('BAD_SKIN', 'The skin is too negative for this geometry (denominator ≤ 0).');
            var J = b * Math.sqrt(kx * kz) / (C_DARCY_OIL * c.B * c.mu * (bo.X + c.S));
            P.L = c.L; P.S = c.S;
            return _oilFromJ(spec, F, w, J, { X: bo.X, lnCH: bo.lnCH, sR: bo.sR, kase: bo.kase, A: bo.A, a: a, b: b, L: c.L, Iani: c.Iani, x0: bo.x0, z0: bo.z0, yMid: bo.ymid,
                BmuSource: c.BmuSource, label: 'Babu & Odeh (1989), pseudo-steady state, p̄r' }, { horizontal: { L: c.L, Iani: c.Iani } });
        } });
    // Furui, Zhu & Hill (2003), a lateral between constant-pressure boundaries y_b from the well:
    // J = k·L / (141.2·Bo·μo·[ln(h·I_ani / (rw·(I_ani + 1))) + π·y_b / (h·I_ani) − 1.224 + S])
    reg({ key: 'furui', label: 'Horizontal well — Furui et al. (2003)', kind: 'oil', needs: ['k', 'h', 'L', 'kvkh', 'rw', 'yb', 'S'], verified: false, horizontal: true,
        build: function (spec, P, w, F) {
            var c = _hzCommon(spec, P, w, F); if (!c.ok) return c;
            var yb = _n(P.yb);
            if (!_pos(yb)) return _fail('NEEDS_YB', 'Furui needs y_b, the distance from the lateral to the constant-pressure boundary.');
            var X = Math.log(c.h * c.Iani / (c.rw * (c.Iani + 1))) + Math.PI * yb / (c.h * c.Iani) - 1.224;
            if (!(X + c.S > 0)) return _fail('BAD_SKIN', 'The skin is too negative for this geometry (denominator ≤ 0).');
            var J = c.k * c.L / (C_DARCY_OIL * c.B * c.mu * (X + c.S));
            P.L = c.L; P.S = c.S;
            return _oilFromJ(spec, F, w, J, { X: X, yb: yb, L: c.L, Iani: c.Iani, BmuSource: c.BmuSource, label: 'Furui, Zhu & Hill (2003), steady state, p_e at y_b' },
                { horizontal: { L: c.L, Iani: c.Iani } });
        } });

    // ── fractured wells: Prats r_w' = x_f/2 (infinite conductivity) and the Cinco-Ley & Samaniego (1981) F_cD curve as the closed-form
    // fit f(F_cD) = s_f + ln(x_f/rw) = (1.65 − 0.328u + 0.116u²) / (1 + 0.180u + 0.064u² + 0.005u³), u = ln F_cD, 0.1 ≤ F_cD ≤ 1,000
    // (F_cD = k_f·w / (k·x_f)). The fracture skin s_f joins the other skin S in the Darcy form.
    function fracSkin(o) {
        o = o || {};
        var xf = _n(o.xf), rw = _n(o.rw), k = _n(o.k), fcd = _n(o.FcD), kfw = _n(o.kfw), warnings = [];
        if (!_pos(xf) || !_pos(rw)) return _fail('NEEDS', 'The fracture skin needs x_f and rw.');
        if (!_pos(fcd) && _pos(kfw) && _pos(k)) fcd = kfw / (k * xf);
        var f, basis;
        if (!_pos(fcd)) { f = Math.log(2); basis = 'infinite conductivity (Prats r_w′ = x_f/2)'; }
        else {
            var fc = fcd;
            if (fc < 0.1) { fc = 0.1; warnings.push(_w('FCD_LOW', 'F_cD below 0.1: the fit is held at 0.1 (outside its range).')); }
            if (fc > 1000) { fc = 1000; warnings.push(_w('FCD_HIGH', 'F_cD above 1,000: the fit is held at 1,000 (≈ infinite conductivity).', 'info')); }
            var u = Math.log(fc);
            f = (1.65 - 0.328 * u + 0.116 * u * u) / (1 + 0.180 * u + 0.064 * u * u + 0.005 * u * u * u);
            basis = 'Cinco-Ley & Samaniego F_cD curve (closed-form fit), F_cD = ' + _fix(fcd, 2);
        }
        var sf = f - Math.log(xf / rw);
        return { ok: true, sf: sf, f: f, FcD: _pos(fcd) ? fcd : null, rwEff: rw * Math.exp(-sf), basis: basis, warnings: warnings, errors: [] };
    }
    function _fracBuild(gasKind) {
        return function (spec, P, w, F) {
            var fs = fracSkin({ xf: P.xf, rw: P.rw, k: P.k, FcD: P.FcD, kfw: P.kfw });
            if (!fs.ok) return fs;
            fs.warnings.forEach(function (x) { w.push(x); });
            var re = _n(P.re), xf = _n(P.xf);
            if (_pos(re) && xf > 0.5 * re) w.push(_w('XF_LONG', 'x_f is more than half the drainage radius: the radial Darcy form with an effective radius is only approximate.'));
            var S0 = _n(P.S); if (!_fin(S0)) S0 = 0;
            var P2 = _plainParams(P); delete P2.xf; P2.S = S0 + fs.sf;
            var b = MODELS[gasKind ? 'darcyGas' : 'darcyOil'].build(spec, P2, w, F);
            if (!b || b.ok === false) return b;
            ['a', 'b', 'aMp', 'bMp', 'D', 'sg', 'Bo', 'muo'].forEach(function (k) { if (P2[k] != null) P[k] = P2[k]; });
            P.S = S0;
            b.form = Object.assign({}, b.form || {}, { sf: fs.sf, f: fs.f, FcD: fs.FcD, rwEff: fs.rwEff, fracBasis: fs.basis, Sother: S0, Stotal: S0 + fs.sf });
            b.frac = { xf: xf, FcD: fs.FcD, sf: fs.sf };
            return b;
        };
    }
    reg({ key: 'frac', label: 'Fractured well — Prats / Cinco-Ley F_cD (oil)', kind: 'oil', needs: ['k', 'h', 'rw', 're', 'xf', 'FcD', 'S'], verified: false, build: _fracBuild(false) });
    reg({ key: 'fracGas', label: 'Fractured well — Prats / Cinco-Ley F_cD (gas)', kind: 'gas', needs: ['k', 'h', 'rw', 're', 'xf', 'FcD', 'S', 'D'], verified: false, build: _fracBuild(true) });

    // ── transient IPR (line-source log approximation, infinite acting, at a flowing time t):
    // pwf = p_i − 162.6·q·B·μ/(k·h)·[log10(k·t/(φ·μ·ct·rw²)) − 3.23 + 0.87·S]  →  J(t) = k·h / (162.6·B·μ·[…]); p̄r field = p_i
    function transientJ(o) {
        var k = _n(o.k), h = _n(o.h), phi = _n(o.phi), ct = _n(o.ct), rw = _n(o.rw), t = _n(o.t), B = _n(o.B), mu = _n(o.mu), S = _fin(_n(o.S)) ? _n(o.S) : 0;
        if (!_pos(k) || !_pos(h) || !(phi > 0 && phi < 1) || !_pos(ct) || !_pos(rw) || !_pos(t) || !_pos(B) || !_pos(mu)) return null;
        var X = Math.log(k * t / (phi * mu * ct * rw * rw)) / Math.LN10 - 3.23 + 0.87 * S;
        return X > 0 ? { J: k * h / (162.6 * B * mu * X), X: X } : null;
    }
    reg({ key: 'transient', label: 'Transient (line source at a flowing time)', kind: 'oil', needs: ['k', 'h', 'phi', 'ct', 'rw', 'tFlow', 'S', 're'], verified: false,
        build: function (spec, P, w, F) {
            var bm = _bmu(P, F, spec, w);
            if (!bm) return _fail('NEEDS', 'The transient IPR needs Bo and μo (enter them or build the fluid).');
            var t = _n(P.tFlow);
            if (!_pos(t)) return _fail('NEEDS_T', 'The flowing time t (hours) is needed for the transient IPR.');
            var o = { k: P.k, h: P.h, phi: P.phi, ct: P.ct, rw: P.rw, t: t, B: bm.B, mu: bm.mu, S: P.S };
            var r = transientJ(o);
            if (!r) return _fail('NEEDS', 'The transient IPR needs k, h, φ (0–1), ct and rw, with a log term above 0 (a longer time or a smaller skin).');
            var tD = 0.0002637 * _n(P.k) * t / (_n(P.phi) * bm.mu * _n(P.ct) * _n(P.rw) * _n(P.rw));
            if (tD < 100) w.push(_w('TD_SMALL', 'Dimensionless time t_D ' + _fix(tD, 0) + ' < 100: the log approximation of the line source is inaccurate this early.', 'info'));
            var re = _n(P.re), tPss = null;
            if (_pos(re)) {
                tPss = 0.1 * _n(P.phi) * bm.mu * _n(P.ct) * Math.PI * re * re / (0.0002637 * _n(P.k));   // t_DA = 0.1 (circle)
                if (t > tPss) w.push(_w('T_GT_PSS', 'The flowing time is beyond the end of infinite-acting flow (≈ ' + _fix(tPss, 0) + ' h for r_e): use the pseudo-steady Darcy model.'));
            }
            var kh = _n(P.k) * _n(P.h);
            var jOfT = function (tt) { var x = transientJ(Object.assign({}, o, { t: tt })); return x ? x.J : null; };
            return _oilFromJ(spec, F, w, r.J, { X: r.X, t: t, tD: tD, tPss: tPss, BmuSource: bm.src, label: 'line-source log approximation, p_i = p̄r field' },
                { transient: { t: t, tPss: tPss, kh: kh, jOfT: jOfT } });
        } });

    // ── multilayer commingled IPR with crossflow (res.layers; §4.2 B): every layer at its own mid TVD; the wellbore pressure at a
    // layer = pwf at the reference depth + the static gradient of the wellbore fluid × (TVD_layer − TVD_ref). A layer whose
    // wellbore pressure exceeds its p̄r takes fluid (crossflow, a negative rate on its injectivity = its PI). Layer models: oil —
    // J (composite below the layer pb) or Darcy k·h·S; gas — LIT in p² a, b or Darcy k·h·S (p² form, μ̄z̄ at the layer p̄r).
    function _layerRows(spec) { return (Array.isArray(spec.layers) ? spec.layers : []).filter(function (r) { return r && r.use !== false && _pos(_n(r.pr)); }).slice(0, 10); }
    reg({ key: 'multilayer', label: 'Multilayer commingled (crossflow reported)', kind: 'any', needs: ['layers', 'rw', 're'], verified: false,
        build: function (spec, P, w, F, o) {
            o = o || {};
            var rows = _layerRows(spec);
            if (!rows.length) return _fail('NEEDS_LAYERS', 'Enter at least one layer with its reservoir pressure (layers table, step ②).');
            var gas = !!(F && F.ok && (F.type === 'gas' || F.type === 'condensate' || F.type === 'gasinj'));
            var T = _n(spec.T_F), tvdAt = typeof o.tvdAt === 'function' ? o.tvdAt : null, pf = spec.perf || {};
            var refMd = _first(o.refMd, pf.midMd, NaN), noTvd = false;
            var tvdOf = function (md, stored) {
                if (tvdAt && _fin(md)) { var v = tvdAt(md); if (_fin(v)) return v; }
                if (_fin(stored)) return stored;
                noTvd = true; return md;
            };
            var layers = [], pmean = 0;
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i], top = _n(r.topMd), bot = _n(r.botMd);
                if (!_fin(top) || !_fin(bot) || !(bot > top)) return _fail('BAD_LAYER', 'Layer ' + (i + 1) + ': top MD and bottom MD (bottom below top) are needed.');
                var mid = 0.5 * (top + bot), tv = tvdOf(mid, _fin(_n(r.tvdTop)) && _fin(_n(r.tvdBot)) ? 0.5 * (_n(r.tvdTop) + _n(r.tvdBot)) : null);
                layers.push({ i: i, name: String(r.name == null || r.name === '' ? 'L' + (i + 1) : r.name).slice(0, 24), topMd: top, botMd: bot, midMd: mid, tvd: tv, pr: _n(r.pr), raw: r });
                pmean += _n(r.pr) / rows.length;
            }
            if (!_fin(refMd)) refMd = layers.reduce(function (a, l) { return a + l.midMd; }, 0) / layers.length;
            var refTvd = tvdOf(refMd, null);
            if (noTvd) w.push(_w('LAYER_TVD', 'No well path for the layer depths: TVD = MD is assumed (vertical well).', 'info'));
            // static gradient of the wellbore fluid (psi/ft) at the mean layer pressure and the reservoir temperature
            var grad = gas ? 0.05 : 0.35, gsrc = 'assumed';
            if (F && F.ok && typeof F.at === 'function' && _fin(T)) {
                var pp = null; try { pp = F.at(pmean, T); } catch (e) { pp = null; }
                if (pp) {
                    var rho = gas ? _n(pp.rhoG) : (1 - (_fin(F.wc) ? F.wc : 0)) * _n(pp.rhoO) + (_fin(F.wc) ? F.wc : 0) * _n(pp.rhoW);
                    if (F.type === 'water' || F.type === 'waterinj') rho = _n(pp.rhoW);
                    if (_pos(rho)) { grad = rho / 144; gsrc = 'fluid at ' + _fix(pmean, 0) + ' psia'; }
                }
            }
            var bm = gas ? null : _bmu(P, F, spec, w);
            var Xd = darcyX(P);
            // each layer's q(p_layer) (positive = production) and its injectivity for crossflow
            for (var j = 0; j < layers.length; j++) {
                var L = layers[j], R0 = L.raw, J = _n(R0.J), a = _n(R0.a), b = _n(R0.b), k = _n(R0.k), h = _n(R0.h), S = _fin(_n(R0.S)) ? _n(R0.S) : 0;
                L.dz = L.tvd - refTvd;
                if (!gas) {
                    var src = 'J';
                    if (!_pos(J) && _pos(k) && _pos(h)) {
                        if (!Xd.ok) return _fail('NEEDS_RE', 'Layer ' + L.name + ': the Darcy layer needs rw and re (inflow card).');
                        if (!bm) return _fail('NEEDS', 'Darcy layers need Bo and μo (build the fluid).');
                        if (!(Xd.X + S > 0)) return _fail('BAD_SKIN', 'Layer ' + L.name + ': the skin is too negative.');
                        J = k * h / (C_DARCY_OIL * bm.B * bm.mu * (Xd.X + S)); src = 'Darcy k·h';
                    }
                    if (!_pos(J)) return _fail('NEEDS', 'Layer ' + L.name + ': enter J, or k and h.');
                    var pbl = _n(R0.pb), m = (_fin(pbl) && pbl > 0) ? _oil({ mode: 'composite', pr: L.pr, pb: Math.min(pbl, L.pr), J: J }) : _oil({ mode: 'pi', pr: L.pr, J: J });
                    if (!m.ok) return m;
                    L.J = J; L.src = src; L.model = m.mode; L.ev = m;
                    L.q = (function (L0) { return function (pl) { return pl >= L0.pr ? -L0.J * (pl - L0.pr) : L0.ev.qAt(Math.max(0, pl)); }; })(L);
                } else {
                    var src2 = 'LIT p²';
                    if (!(_pos(a) && b >= 0) && _pos(k) && _pos(h)) {
                        if (!Xd.ok) return _fail('NEEDS_RE', 'Layer ' + L.name + ': the Darcy layer needs rw and re (inflow card).');
                        var sgx = _sgOf(P, F), st = sgx ? _gasState(sgx.sg, T, L.pr) : null;
                        if (!st) return _fail('NEEDS', 'Darcy gas layers need the gas gravity and the reservoir temperature.');
                        if (!(Xd.X + S > 0)) return _fail('BAD_SKIN', 'Layer ' + L.name + ': the skin is too negative.');
                        a = C_DARCY_GAS * (T + RANK) * st.mu * st.z * (Xd.X + S) / (k * h); b = 0; src2 = 'Darcy k·h (p², μ̄z̄ at the layer p̄r)';
                    }
                    if (!(_pos(a) && (b >= 0 || !_fin(b)))) return _fail('NEEDS', 'Layer ' + L.name + ': enter LIT a and b (p²), or k and h.');
                    if (!_fin(b)) b = 0;
                    L.a = a; L.b = b; L.src = src2; L.model = 'litP2';
                    L.q = (function (L0) {
                        var root = function (d) { return L0.b > 0 ? (-L0.a + Math.sqrt(L0.a * L0.a + 4 * L0.b * d)) / (2 * L0.b) : d / L0.a; };
                        return function (pl) { var d = L0.pr * L0.pr - pl * pl; return d >= 0 ? root(d) : -root(-d); };
                    })(L);
                }
            }
            var pAof = gas ? (_fin(_n(P.pAof)) ? _n(P.pAof) : P_AOF) : 0;
            var Qof = function (pwf) { var s = 0; for (var k2 = 0; k2 < layers.length; k2++) s += layers[k2].q(Math.max(0, pwf + grad * layers[k2].dz)); return s; };
            // the commingled static pressure p_ws (total rate 0) by bisection between the extreme layer pressures referred to the datum
            var lo = Infinity, hi = -Infinity;
            layers.forEach(function (L) { var pr0 = L.pr - grad * L.dz; if (pr0 < lo) lo = pr0; if (pr0 > hi) hi = pr0; });
            lo = Math.max(pAof, lo - 1); hi = hi + 1;
            for (var it = 0; it < 200 && hi - lo > 1e-10 * hi; it++) { var mm = 0.5 * (lo + hi); if (Qof(mm) > 0) lo = mm; else hi = mm; }
            var pws = 0.5 * (lo + hi), aof = Qof(pAof);
            if (!(aof > 0) || !(pws > pAof)) return _fail('NO_FLOW', 'The layers give no positive commingled rate.');
            var ev = {
                aof: aof,
                qAt: function (pwf) { pwf = +pwf; if (!_fin(pwf)) return NaN; if (pwf >= pws) return 0; if (pwf <= pAof) return aof; return Qof(pwf); },
                pwfAt: function (q) {
                    q = +q; if (!_fin(q)) return null; if (q <= 0) return pws; if (q > aof * (1 + 1e-12)) return null; if (q >= aof) return pAof;
                    var a2 = pAof, b2 = pws;
                    for (var n = 0; n < 200 && b2 - a2 > 1e-12 * pws; n++) { var c2 = 0.5 * (a2 + b2); if (Qof(c2) > q) a2 = c2; else b2 = c2; }
                    return 0.5 * (a2 + b2);
                }
            };
            var rates = function (pwf) {
                return layers.map(function (L) {
                    var pl = Math.max(0, pwf + grad * L.dz), q = L.q(pl);
                    return { name: L.name, topMd: L.topMd, botMd: L.botMd, midMd: L.midMd, tvd: L.tvd, pr: L.pr, pLayer: pl, q: q, crossflow: q < 0 };
                });
            };
            var shut = rates(pws), xIn = 0;
            shut.forEach(function (r) { if (r.q > 0) xIn += r.q; });
            var thief = shut.filter(function (r) { return r.q < -1e-9; }).map(function (r) { return r.name; });
            if (thief.length) w.push(_w('CROSSFLOW_SHUTIN', 'Shut in, ' + _fix(xIn, gas ? 0 : 1) + (gas ? ' Mscf/d' : ' STB/d') + ' flow from the higher-pressure layers into ' + thief.join(', ') + ' (crossflow in the wellbore).'));
            var summary = layers.map(function (L) { return { name: L.name, topMd: L.topMd, botMd: L.botMd, midMd: L.midMd, tvd: L.tvd, dz: L.dz, pr: L.pr, J: L.J || null, a: L.a || null, b: _fin(L.b) ? L.b : null, model: L.model, src: L.src }; });
            return { ev: ev, pAof: pAof, J: gas ? null : layers.reduce(function (s, L) { return s + (L.J || 0); }, 0), pb: null, prOverride: pws, kindOverride: gas ? 'gas' : 'oil',
                form: { pws: pws, grad: grad, gradSource: gsrc, refMd: refMd, refTvd: refTvd, n: layers.length, label: 'commingled layers with crossflow' },
                multilayer: { layers: summary, rates: rates, crossflow: { pws: pws, rate: xIn, thief: thief, layers: shut } }, engine: gas ? 'WTS_gasdeliv-form LIT per layer' : 'WTS_oilipr_model per layer' };
        } });

    // ── injector (water or gas injection well; fluid type waterinj / gasinj, or water): the injectivity index above p̄r with a
    // fracture-pressure limit. Water: q = II·(pwf − p̄r), II input or Darcy k·h / (141.2·Bw·μw·(X + S)). Gas: LIT in m(p) reversed,
    // m(pwf) − m(p̄r) = a·q + b·q², a / b input or Darcy (a = 1422·T·(X + S)/(k·h), b = 1422·T·D/(k·h)). pfrac (psia at the mid-
    // perforations) caps the plot and the maximum rate; without it the solver may take the DFIT closure (WTS_wp_inj).
    reg({ key: 'injector', label: 'Injector — injectivity index with a fracture-pressure limit', kind: 'inj', needs: ['II', 'k', 'h', 'rw', 're', 'S', 'pfrac', 'a', 'b', 'D'], verified: false,
        build: function (spec, P, w, F) {
            var pr = spec.pr, gas = !!(F && F.ok && (F.type === 'gasinj' || F.type === 'gas'));
            var pfrac = _n(P.pfrac);
            if (_fin(pfrac) && !(pfrac > pr)) return _fail('BAD_PFRAC', 'The fracture pressure must be above p̄r.');
            var pLim = _fin(pfrac) ? pfrac : pr + Math.max(2000, 0.5 * pr), qAt, pwfAt, II = null, form = {};
            if (!gas) {
                II = _n(P.II); var src = 'input';
                if (!_pos(II)) {
                    var k = _n(P.k), h = _n(P.h), x = darcyX(P), bm = _bmu(P, F, spec, w, true), S = _fin(_n(P.S)) ? _n(P.S) : 0;
                    if (!_pos(k) || !_pos(h)) return _fail('NEEDS', 'Enter the injectivity index II, or k and h.');
                    if (!x.ok) return x;
                    if (!(x.X + S > 0)) return _fail('BAD_SKIN', 'ln-term + S must be above 0.');
                    II = k * h / (C_DARCY_OIL * bm.B * bm.mu * (x.X + S)); src = 'Darcy k·h (Bw ' + _fix(bm.B, 3) + ', μw ' + _fix(bm.mu, 3) + ' cp, ' + bm.src + ')';
                    form = { X: x.X, ref: x.ref, S: S };
                }
                qAt = function (pwf) { pwf = +pwf; if (!_fin(pwf)) return NaN; return pwf <= pr ? 0 : II * (pwf - pr); };
                pwfAt = function (q) { q = +q; if (!_fin(q)) return null; return q <= 0 ? pr : pr + q / II; };
                form.IIsource = src;
            } else {
                var c = _gasCtx(Object.assign({}, spec, { pr: pLim }), P, F);
                if (!c.ok) return c;
                var a = _n(P.a), b = _n(P.b), src3 = 'LIT m(p) input';
                if (!_pos(a)) {
                    var k3 = _n(P.k), h3 = _n(P.h), x3 = darcyX(P), S3 = _fin(_n(P.S)) ? _n(P.S) : 0, D3 = _fin(_n(P.D)) ? _n(P.D) : 0;
                    if (!_pos(k3) || !_pos(h3)) return _fail('NEEDS', 'Enter LIT a and b in m(p), or k and h.');
                    if (!x3.ok) return x3;
                    a = C_DARCY_GAS * (c.T + RANK) * (x3.X + S3) / (k3 * h3); b = C_DARCY_GAS * (c.T + RANK) * D3 / (k3 * h3); src3 = 'Darcy k·h (m(p))';
                    form = { X: x3.X, ref: x3.ref, S: S3, D: D3 };
                }
                if (!_fin(b) || b < 0) b = 0;
                var tb = c.tb, mpr = tb.mOf(pr);
                qAt = function (pwf) { pwf = +pwf; if (!_fin(pwf)) return NaN; if (pwf <= pr) return 0; var d = tb.mOf(pwf) - mpr; return b > 0 ? (-a + Math.sqrt(a * a + 4 * b * d)) / (2 * b) : d / a; };
                pwfAt = function (q) { q = +q; if (!_fin(q)) return null; if (q <= 0) return pr; return tb.pOf(mpr + a * q + b * q * q); };
                P.a = a; P.b = b; P.sg = c.sg;
                form.IIsource = src3; form.a = a; form.b = b;
                II = qAt(pr + 100) / 100;                      // the secant injectivity over the first 100 psi, Mscf/d per psi
            }
            var qLim = qAt(pLim);
            if (!(qLim > 0)) return _fail('NO_INJ', 'The injectivity gives no rate below the pressure limit.');
            return { ev: { aof: qLim, qAt: qAt, pwfAt: pwfAt }, J: II, pb: null, pAof: null, kindOverride: 'inj', form: form,
                injector: { fluid: gas ? 'gas' : 'water', II: II, pfrac: _fin(pfrac) ? pfrac : null, pLim: pLim, qLim: qLim, limitIsFrac: _fin(pfrac) },
                engine: gas ? 'm(p) LIT reversed (PRiSM_mpTable)' : 'injectivity index' };
        } });

    // ── Build-up Surveillance hand-off (§2.10): the latest interpreted build-up of this well → k, h, S and p̄r ────────────────
    // state = WTS_buildup.store.loadState() (localStorage, well-scoped; the per-test summaries keep result.final even after an
    // overflow). The extrapolated pressure is at the Build-up datum TVD: o.midPerfTvd moves it to the mid-perforations with the
    // Build-up static gradient (depth.grad, psi/ft). p̄r = pExt when it is the average pressure; a p* is passed with a caution.
    function fromBuildup(state, o) {
        o = o || {};
        var warnings = [];
        if (state === undefined) {
            var BS = G.WTS_buildup && G.WTS_buildup.store;
            state = (BS && typeof BS.loadState === 'function') ? BS.loadState() : null;
        }
        var A = state && state.analysis;
        if (!A || !Array.isArray(A.tests)) return _fail('NO_BUILDUP', 'No build-up result for this well (run Build-up Surveillance first).');
        var cand = A.tests.filter(function (t) { return t && t.status === 'interpreted' && t.result && t.result.final && _pos(_n(t.result.final.k)); });
        if (!cand.length) return _fail('NO_BUILDUP', 'No interpreted build-up with a permeability for this well.');
        cand.sort(function (x, y) { return (_n(x.tc_ms) || 0) - (_n(y.tc_ms) || 0) || String(x.date || '').localeCompare(String(y.date || '')); });
        var t = cand[cand.length - 1], f = t.result.final, wl = A.well || {}, dep = A.depth || {}, P = {}, prov = {};
        var src = 'Build-up ' + t.id + (t.date ? ' (' + t.date + ')' : '');
        var k = _n(f.k), kh = _n(f.kh), h = _n(wl.h);
        if (!_pos(h) && _pos(kh)) h = kh / k;
        P.k = k; prov.k = src;
        if (_pos(h)) { P.h = h; prov.h = src + (_pos(_n(wl.h)) ? ' well input' : ' kh/k'); }
        if (_fin(_n(f.S))) { P.S = _n(f.S); prov.S = src; }
        if (_pos(_n(wl.rw))) { P.rw = _n(wl.rw); prov.rw = src + ' well input'; }
        if (_pos(_n(wl.re_ft))) { P.re = _n(wl.re_ft); prov.re = src + ' well input'; }
        var gas = wl.fluid === 'gas';
        if (gas && f.gas && _fin(_n(f.gas.Sprime))) warnings.push(_w('BU_SPRIME', 'Gas well: the build-up skin is the apparent skin S′ = S + D·q at the test rate.', 'info'));
        var pExt = _first(t.pExtDatum, f.pExt), kind = f.pExtKind || (_fin(_n(t.pStarDatum)) ? 'pStar' : null), pr = null;
        if (!_fin(pExt) && _fin(_n(t.pStarDatum))) { pExt = _n(t.pStarDatum); kind = 'pStar'; }
        if (_fin(pExt)) {
            pr = pExt;
            var dTvd = _n(dep.datumTVD), g = _n(dep.grad), mt = _n(o.midPerfTvd);
            if (_fin(dTvd) && _fin(g) && _fin(mt) && Math.abs(mt - dTvd) > 0.5) { pr = pExt + g * (mt - dTvd); warnings.push(_w('BU_DATUM', 'Pressure moved from the Build-up datum ' + _fix(dTvd, 0) + ' ft TVD to the mid-perforations ' + _fix(mt, 0) + ' ft TVD (' + _fix(g, 3) + ' psi/ft).', 'info')); }
            prov.pr = src + (kind === 'pbar' ? ' p̄r' : ' p*');
            if (kind !== 'pbar') warnings.push(_w('BU_PSTAR', 'The build-up gives p* (the extrapolated pressure), not p̄r: in a bounded or depleting reservoir p̄r is lower — check it.'));
        } else warnings.push(_w('PR_NEEDED', 'The build-up has no extrapolated pressure: p̄r is not imported (never defaulted).'));
        if (t.result.confidence && t.result.confidence.headline === 'low') warnings.push(_w('BU_LOW', 'The build-up interpretation has a low confidence label.'));
        return { ok: true, spec: { model: gas ? 'darcyGas' : 'darcyOil', pr: pr, params: P, provenance: prov }, provenance: prov,
            test: { id: t.id, date: t.date || null, k: k, kh: kh, S: _n(f.S), pExt: pExt, pExtKind: kind, conf: t.result.confidence ? t.result.confidence.headline : null, source: f.source || null },
            warnings: warnings, errors: [] };
    }

    function curve(spec, F, o) {
        spec = spec || {};
        o = o || {};
        var key = String(spec.model || '');
        var def = MODELS[key];
        if (!def) return _fail('UNKNOWN_MODEL', 'Unknown inflow model "' + key.slice(0, 40) + '".');
        var pr = _n(spec.pr);
        if (!_pos(pr)) return _fail('PR_NEEDED', 'p̄r needed: enter the average reservoir pressure (it is never defaulted).', { key: key, kind: def.kind });
        var warnings = [], P = _plainParams(spec.params);
        var s = { model: key, pr: pr, T_F: spec.T_F, pb: spec.pb, params: P, points: spec.points, layers: spec.layers, perf: spec.perf };
        var hasCoef = def.needs.filter(function (n) { return n !== 'pb' && n !== 'sg'; }).every(function (n) { return _fin(_n(P[n])); });
        if (!hasCoef && def.fit) {
            var f = _autoFit(key, s, warnings);
            if (f && f.ok) {
                for (var k in f.params) if (!_fin(_n(P[k]))) P[k] = f.params[k];
            } else if (f && !f.ok) return _fail('FIT_FAILED', f.errors.length ? f.errors : ['The fit failed.'], { key: key, kind: def.kind });
        }
        var b = def.build(s, P, warnings, F || null, o);
        if (!b || b.ok === false) { b = b || _fail('BAD_PARAMS', 'Inflow could not be built.'); b.key = key; b.kind = def.kind; b.warnings = (b.warnings || []).concat(warnings); return b; }
        var kind = b.kindOverride || def.kind, prI = _fin(b.prOverride) ? b.prOverride : pr;
        var I = _mkI(key, { pr: prI, warnings: warnings }, b.ev, {
            pb: b.pb, J: b.J, pAof: kind === 'gas' ? b.pAof : 0, skin: b.skin, params: P, D: b.D, Dsource: b.Dsource, form: b.form, engine: b.engine,
            curveTo: b.injector ? b.injector.pLim : null });
        I.kind = kind;
        // increment B (WP24) extras: horizontal geometry, fracture, transient time, layers with crossflow, injector limits
        ['horizontal', 'frac', 'transient', 'multilayer', 'injector'].forEach(function (k) { if (b[k]) I[k] = b[k]; });
        if (b.multilayer) { I.layers = b.multilayer.layers; I.layerRates = b.multilayer.rates; I.crossflow = b.multilayer.crossflow; I.prInput = pr; }
        if (b.injector) { I.inj = true; I.pFrac = b.injector.pfrac; I.qLimit = b.injector.qLim; I.II = b.injector.II; }
        if (!I.skin && def.kind && !b.injector && !b.multilayer) {
            var sk = skin(Object.assign({}, P, { pbar: pr, kind: kind, T_F: spec.T_F }));
            if (sk.ok && sk.parts.length) I.skin = sk;
        }
        I.future = (b.injector || b.multilayer) ? null : _future(spec, F, o, I);
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
            provisional: d.verified ? null : PROVISIONAL, fittable: !!d.fit, horizontal: !!d.horizontal,
            curve: (function (key) { return function (spec, F, o) { return curve(Object.assign({}, spec || {}, { model: key }), F, o); }; })(k) };
    });
    api.curve = curve;
    api.fit = fit;
    api.fromWell = fromWell;
    api.skin = skin;
    api.estimateD = estimateD;
    api.fromBuildup = fromBuildup;
    api.fracSkin = fracSkin;
    api.babuOdehX = babuOdehX;
    api.transientJ = transientJ;
    api.B_KEYS = ['wcComposite', 'joshi', 'babuOdeh', 'furui', 'frac', 'fracGas', 'transient', 'multilayer', 'injector'];
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
