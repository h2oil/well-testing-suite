// =============================================================================
// WTS — 48-calc-wellbore.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// window.WTS_wellbore — shared surface ↔ bottomhole, step-test, ramp and water-hammer engine (docs/DFIT-PLAN.md §3.4,
// §4.1–§4.4, §4.14–§4.17; owner WP1). Pure: no DOM, storage, timers or events; no unseeded randomness. Resolved at call
// time by the Round-8 DFIT files (Round 9 loads after Round 8). 3.4b items go into 48-calc-wellbore-field.js and merge
// into this namespace.
//
// Units (§3.0): time h on the record clock (wave quantities T / tau in s), pressure psia (psi for differences), DFIT rates
// bbl/min (dataset rates bbl/d), volumes bbl, storage bbl/psi, compressibility 1/psi, depths ft (TVD unless the name ends in
// Md), pipe and perforation diameters in, density ppg, temperature °F. Engine internals: ft, s / min, psi, ft³ where stated.
//
// 3.4a functions (shapes: prism-build/tests/_dfit-shapes.js StepDown, StepRate, Ramp, Hammer):
//   column(spec)                         survey + strings → TVD/MD maps, capacity, segments, V_w
//   surveyMC(rows)                       v4.3 (Well Performance WP4): minimum curvature [[md, inc, azi]] → stations (TVD, N, E,
//                                        departure, dogleg, DLS) + at(md) on the arcs; column() takes such rows too (key mc)
//   csys(column, fluid, T)               the one system compressibility c_fluid + ψ·D/(E_s·e), V_w·c_w, wave speed
//   tempProfile(column, opts)            static geotherm or displaced (DFIT) column, relaxing with e^(−t/τ)
//   flowingTemp(column, opts)            v4.4 (Well Performance WP14): steady flowing temperature, Ramey / Hasan-Kabir relaxation,
//                                        direction 'produce' | 'inject'; geotherm on TVD, relaxation along MD (true inclination);
//                                        opts {w lbm/hr, cp, U_to | U_ti + r_ti, r_to ft, ke, alpha, rwb ft, t_hr, direction, Tin,
//                                        geo, fromMd, toMd, stepFt} → {A, fTD, tD, tAt(md), teAt(md), tOut, profile, …}.
//                                        flowingTempFitU(column, opts, {T, md?}) fits U_to (Brent on ln U); flowingTempF(tD) = f(t_D).
//                                        `_ramey` is NOT defined here: it stays reserved for DFIT 3.4b (which may call flowingTemp with
//                                        direction 'inject', owner Q16)
//   hydrostatic(pK, tvdK, tvdT, col, T)  ρ(p,T) column, RK2 at 10 ft (or a constant gradient)
//   pipeFriction(q, seg, fluid, T)       Newtonian / friction-reduced (Virk cap) / power law
//   perfFriction, nwbLoss, bleedOff      perforation, near-wellbore and the friction bleed-off after shut-in
//   convert(ds, prepCtx, opts)           surface → bottomhole with a first-order band and vacuum masking
//   vacuum(pi, column, T, atm)           surface pressure at p_i
//   stepDown, stepDownDesignCheck        step-down fit, identifiability, open perforations (seeded Monte Carlo)
//   stepRate                             continuous hinge on end-of-step pressures, F-test, bootstrap, stabilisation
//   ramp                                 pump-in ramp hinge in p vs V (knee, stiffness, onset, near-wellbore correction)
//   hammerQuick                          water-hammer period, reflector, Joukowsky, bleed-aware midline ISIP (upper:true unless the
//                                        bleed-off is fitted or predicted below max(2 psi, 3σ); ctx.fitBleed:true with no step-down
//                                        fits b from a default seed); a matched ctx.reflectorMd calibrates c; delta = T/τ
//   align                                rate ↔ pressure clock offset (cross-correlation of first differences, scored only over
//                                        the pressure samples that can see a rate change)
// Options beyond §3.4 rows: stepRate opts.dpdtMax (psi/h, extra stabilisation limit); ramp opts.VwCw → storageRatio;
// stepDown / ramp / stepRate return their seed (§3.0); convert flips the perforation / near-wellbore signs in flowback.
// Extra helpers (not in §3.4, used by the tests and by 56): pipeDp, perfConstant, salinityFromPpg, rhoScPpg, rhoAt,
// vwcwFromPeriod, hinge.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var BBL = 5.614583;                 // ft³ per bbl
    var BPM = BBL / 60;                 // ft³/s per bbl/min (0.0935764)
    var SLUG_PER_PPG = 7.48052 / 32.174;  // slug/ft³ per ppg (0.232502)
    var GAL_PER_FT3 = 7.48052;
    var E_STEEL = 30e6;                 // psi
    var K_WATER = 3.2e5;                // psi, handbook bulk modulus of water (c_fluid 3.125e-6 1/psi)
    var PERF_C = 0.2369;                // the field perforation constant (§4.2)
    var Z1281 = 1.2815516;              // P10 / P90 of a normal
    var DCHI2_95 = 3.841459;            // χ²(1) 95 % quantile: one-parameter profile interval

    // ── small helpers ────────────────────────────────────────────────────────
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _num(v, d) {
        var x = v;
        if (typeof x === 'string' && x.trim() !== '' && /^[\s+-]*[0-9.eE+-]+\s*$/.test(x)) x = +x;
        return _fin(x) ? x : d;
    }
    function _nn(v) { return _fin(v) ? v : null; }
    function _fail(code, msg, bad) { return { ok: false, code: code, errors: [String(msg).slice(0, 299)], bad: bad || [] }; }
    function _warn(code, level, text) { return { code: code, level: level, text: String(text).slice(0, 299), ev: [] }; }
    function _f(x, dp) {
        if (!_fin(x)) return '–';
        var s = (dp == null ? x : +x.toFixed(dp)).toFixed(dp == null ? 0 : dp);
        var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
        var parts = s.split('.'), ip = parts[0], out = '';
        while (ip.length > 3) { out = ',' + ip.slice(-3) + out; ip = ip.slice(0, -3); }
        return (neg ? '−' : '') + ip + out + (parts[1] ? '.' + parts[1] : '');
    }
    function _safe(name, fn) {
        return function () {
            try { return fn.apply(null, arguments); }
            catch (e) { return _fail('INTERNAL', 'WTS_wellbore.' + name + ' failed: ' + (e && e.message ? e.message : 'error')); }
        };
    }
    function _median(a) {
        var b = []; for (var i = 0; i < a.length; i++) if (_fin(a[i])) b.push(a[i]);
        if (!b.length) return NaN;
        b.sort(function (x, y) { return x - y; });
        var m = b.length >> 1;
        return (b.length & 1) ? b[m] : 0.5 * (b[m - 1] + b[m]);
    }
    function _pct(sorted, f) {
        if (!sorted.length) return null;
        var i = Math.min(sorted.length - 1, Math.max(0, Math.floor(f * sorted.length)));
        return sorted[i];
    }
    // seeded generator: PRiSM_rng (05, mulberry32) when present, else the same mulberry32 here
    function _rng(seed) {
        var s0 = (_fin(seed) ? seed : 1);
        if (typeof G.PRiSM_rng === 'function') { var r = G.PRiSM_rng(s0); if (typeof r === 'function') return r; }
        var s = (s0 | 0) || 1;
        return function () {
            s |= 0; s = (s + 0x6D2B79F5) | 0;
            var t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
        };
    }
    // m standard normals (Box–Muller) from an inline xorshift32 stream seeded by the seeded generator: one call, no
    // closure call per draw (a call per draw is slow inside the vm-evaluated app script)
    function _normals(seed, m) {
        var out = (typeof Float64Array === 'function') ? new Float64Array(m) : new Array(m);
        var x = ((_rng(seed)() * 4294967296) >>> 0) || 2463534242, i = 0;
        while (i < m) {
            x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
            var u = (x + 1) / 4294967297;
            x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
            var v = x / 4294967296, rr = Math.sqrt(-2 * Math.log(u));
            out[i++] = rr * Math.cos(2 * Math.PI * v);
            if (i < m) out[i++] = rr * Math.sin(2 * Math.PI * v);
        }
        return out;
    }

    // dense linear algebra (small systems)
    function _invert(M) {
        var n = M.length, A = [], i, j, c, r;
        for (i = 0; i < n; i++) { A.push(M[i].slice()); for (j = 0; j < n; j++) A[i].push(i === j ? 1 : 0); }
        for (c = 0; c < n; c++) {
            var piv = c;
            for (r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
            var tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
            var d = A[c][c];
            if (!(Math.abs(d) > 1e-300)) return null;
            for (j = 0; j < 2 * n; j++) A[c][j] /= d;
            for (r = 0; r < n; r++) if (r !== c) { var f = A[r][c]; if (f) for (j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
        }
        var out = []; for (i = 0; i < n; i++) out.push(A[i].slice(n));
        return out;
    }
    // weighted least squares: X rows, y, w (optional) → {beta, inv (XᵀWX)⁻¹, sse (weighted), fit}
    function _lsq(X, y, w) {
        var n = X.length, p = X[0].length, A = [], b = [], i, j, k;
        for (j = 0; j < p; j++) { A.push([]); b.push(0); for (k = 0; k < p; k++) A[j].push(0); }
        for (i = 0; i < n; i++) {
            var wi = w ? w[i] : 1;
            for (j = 0; j < p; j++) { b[j] += wi * X[i][j] * y[i]; for (k = 0; k < p; k++) A[j][k] += wi * X[i][j] * X[i][k]; }
        }
        var inv = _invert(A);
        if (!inv) return null;
        var beta = [];
        for (j = 0; j < p; j++) { var s = 0; for (k = 0; k < p; k++) s += inv[j][k] * b[k]; beta.push(s); }
        var sse = 0, fit = [];
        for (i = 0; i < n; i++) {
            var fv = 0; for (j = 0; j < p; j++) fv += X[i][j] * beta[j];
            fit.push(fv); sse += (w ? w[i] : 1) * (y[i] - fv) * (y[i] - fv);
        }
        return { beta: beta, inv: inv, sse: sse, fit: fit };
    }
    // 3×3 symmetric solve by Cramer's rule (no allocation in the hinge scan)
    function _solve3(A, b) {
        var a = A[0][0], bb = A[0][1], c = A[0][2], d = A[1][1], e = A[1][2], f = A[2][2];
        var c00 = d * f - e * e, c01 = c * e - bb * f, c02 = bb * e - c * d;
        var det = a * c00 + bb * c01 + c * c02;
        if (!(Math.abs(det) > 1e-300)) return null;
        var c11 = a * f - c * c, c12 = bb * c - a * e, c22 = a * d - bb * bb;
        return [(c00 * b[0] + c01 * b[1] + c02 * b[2]) / det, (c01 * b[0] + c11 * b[1] + c12 * b[2]) / det, (c02 * b[0] + c12 * b[1] + c22 * b[2]) / det];
    }
    // Levenberg–Marquardt on a residual vector (numeric Jacobian, box bounds); used for the hammer variable projection
    function _lmVec(resFn, p0, lo, hi, opts) {
        var o = opts || {}, maxIter = o.maxIter || 60, np = p0.length;
        var p = p0.slice(), r = resFn(p), sse = _ss(r), lam = 1e-3, iter = 0, conv = false;
        function _clip(v) { for (var i = 0; i < np; i++) { if (lo && _fin(lo[i]) && v[i] < lo[i]) v[i] = lo[i]; if (hi && _fin(hi[i]) && v[i] > hi[i]) v[i] = hi[i]; } return v; }
        for (iter = 0; iter < maxIter; iter++) {
            var J = [], i, j, k;
            for (j = 0; j < np; j++) {
                var h = 1e-6 * Math.max(Math.abs(p[j]), o.scale ? o.scale[j] : 1e-3);
                var pj = p.slice(); pj[j] += h;
                var rj = resFn(pj), col = [];
                for (i = 0; i < r.length; i++) col.push((rj[i] - r[i]) / h);
                J.push(col);
            }
            var JTJ = [], g = [];
            for (j = 0; j < np; j++) {
                JTJ.push([]); var gs = 0;
                for (i = 0; i < r.length; i++) gs += J[j][i] * r[i];
                g.push(gs);
                for (k = 0; k < np; k++) { var s = 0; for (i = 0; i < r.length; i++) s += J[j][i] * J[k][i]; JTJ[j].push(s); }
            }
            var improved = false;
            for (var tries = 0; tries < 12; tries++) {
                var M = [];
                for (j = 0; j < np; j++) { M.push(JTJ[j].slice()); M[j][j] *= (1 + lam); if (!(M[j][j] > 0)) M[j][j] = lam; }
                var inv = _invert(M);
                if (!inv) { lam *= 10; continue; }
                var pn = p.slice();
                for (j = 0; j < np; j++) { var dj = 0; for (k = 0; k < np; k++) dj -= inv[j][k] * g[k]; pn[j] += dj; }
                _clip(pn);
                var rn = resFn(pn), sn = _ss(rn);
                if (_fin(sn) && sn < sse) {
                    var rel = (sse - sn) / Math.max(sse, 1e-300);
                    p = pn; r = rn; sse = sn; lam = Math.max(1e-12, lam * 0.2); improved = true;
                    if (rel < 1e-10) conv = true;
                    break;
                }
                lam *= 10;
            }
            if (!improved || conv) { conv = true; break; }
        }
        return { p: p, sse: sse, r: r, iter: iter, converged: conv };
    }
    function _ss(r) { var s = 0; for (var i = 0; i < r.length; i++) { if (!_fin(r[i])) return Infinity; s += r[i] * r[i]; } return s; }

    // ── water properties (16-pvt resolved at call time; local copies of the same correlations otherwise) ──
    function _pvt() { return G.PRiSM_pvt_correlations || null; }
    function _BwLocal(P, T) {
        var dT = -1.0001e-2 + 1.33391e-4 * T + 5.50654e-7 * T * T;
        var dP = -1.95301e-9 * P * T - 1.72834e-13 * P * P * T - 3.58922e-7 * P - 2.25341e-10 * P * P;
        return (1 + dT) * (1 + dP);
    }
    function _Bw(P, T) {
        var c = _pvt();
        if (c && typeof c.Bw_meehan === 'function') { var v = c.Bw_meehan(P, T); if (_fin(v) && v > 0) return v; }
        return _BwLocal(P, T);
    }
    function _muWater(T, S, P) {
        var c = _pvt();
        if (c && typeof c.mu_w_meehan === 'function') { var v = c.mu_w_meehan(T, (S || 0) * 1e4, P); if (_fin(v) && v > 0) return v; }
        return 1.0;
    }
    function rhoScLbFt3(S) { return 62.368 + 0.438603 * S + 1.60074e-3 * S * S; }
    function rhoScPpg(S) { return rhoScLbFt3(_num(S, 0)) / GAL_PER_FT3; }
    function salinityFromPpg(ppg) {
        var c = 62.368 - GAL_PER_FT3 * ppg, a = 1.60074e-3, b = 0.438603, d = b * b - 4 * a * c;
        if (!(d >= 0)) return 0;
        var S = (-b + Math.sqrt(d)) / (2 * a);
        return S > 0 ? S : 0;
    }
    function _fluid(f) {
        f = f || {};
        var kind = (f.kind === 'oil' || f.kind === 'gel' || f.kind === 'slickwater') ? f.kind : 'water';
        var rho = _num(f.rhoPpg, 8.43);
        var S = _fin(f.salinityWt) ? f.salinityWt : salinityFromPpg(rho);
        return { kind: kind, rhoPpg: rho, S: S, muCp: _fin(f.muCp) && f.muCp > 0 ? f.muCp : null, fr: Math.max(0, Math.min(0.85, _num(f.fr, 0))),
                 nPrime: _fin(f.nPrime) && f.nPrime > 0 ? f.nPrime : null, kPrime: _fin(f.kPrime) && f.kPrime > 0 ? f.kPrime : null,
                 tInjF: _num(f.tInjF, 70), cFluid: _fin(f.cFluid) && f.cFluid > 0 ? f.cFluid : null, cFluidModel: f.cFluidModel || null };
    }
    // density (ppg) at p psia, T °F: ρ_sc(S)/B_w(p,T) for water-based fluids; oil keeps its stated density
    function rhoAt(p, T, fluid) {
        var fl = (fluid && fluid.S != null && fluid.kind) ? fluid : _fluid(fluid);
        if (fl.kind === 'oil') return fl.rhoPpg;
        return rhoScLbFt3(fl.S) / _Bw(p, T) / GAL_PER_FT3;
    }

    // ── column (§3.4) ────────────────────────────────────────────────────────
    function _tubLookup(key) {
        var T = G.WTS_tubulars;
        if (!key || !T || typeof T.find !== 'function') return null;
        var e = T.find(key);
        return (e && _fin(e.id) && _fin(e.od)) ? e : null;
    }
    // ── minimum curvature (v4.3 WP4, docs/WELL-PERFORMANCE-PLAN.md §2.3) ──────
    // rows [[md ft, inc °, azi °]] ascending MD (inc 0–180 from vertical, azi 0–360 from north) → stations with TVD, N, E,
    // closure departure, along-hole horizontal length hd, dogleg ° and DLS °/100 ft; a tie-in [0, 0, azi] is prepended when the
    // first row is below the surface (the hole is taken as vertical from the surface to it only if its inclination is 0).
    // Between stations the hole is the circular arc of the method: ΔTVD = ΔMD/2·(cos I1 + cos I2)·RF, ΔN = ΔMD/2·(sin I1 cos A1 +
    // sin I2 cos A2)·RF, ΔE likewise with sin A, RF = (2/β)·tan(β/2), β the dogleg; at(md) interpolates on that arc (the tangent is
    // the slerp of the two station tangents), so TVD, N, E and the inclination are exact for a constant-curvature hole. Below the
    // last station at(md) continues along its tangent; above the surface it is undefined (NaN).
    function _mcTan(inc, azi) {
        var i = inc * Math.PI / 180, a = azi * Math.PI / 180;
        return [Math.sin(i) * Math.cos(a), Math.sin(i) * Math.sin(a), Math.cos(i)];
    }
    function _mcDogleg(i1, a1, i2, a2) {
        var r = Math.PI / 180, s1 = Math.sin((i2 - i1) * r / 2), s2 = Math.sin((a2 - a1) * r / 2);
        var x = s1 * s1 + Math.sin(i1 * r) * Math.sin(i2 * r) * s2 * s2;
        return 2 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, x))));
    }
    // displacement and tangent at the fraction f of an interval of length L with end tangents t1, t2 and dogleg b (rad)
    function _mcArc(t1, t2, b, L, f) {
        var c1, c2, d1, d2;
        if (b < 1e-7) { c1 = f - f * f / 2; c2 = f * f / 2; d1 = 1 - f; d2 = f; }
        else {
            var sb = Math.sin(b);
            c1 = (Math.cos((1 - f) * b) - Math.cos(b)) / (b * sb); c2 = (1 - Math.cos(f * b)) / (b * sb);
            d1 = Math.sin((1 - f) * b) / sb; d2 = Math.sin(f * b) / sb;
        }
        var d = [0, 0, 0], t = [0, 0, 0];
        for (var k = 0; k < 3; k++) { d[k] = L * (c1 * t1[k] + c2 * t2[k]); t[k] = d1 * t1[k] + d2 * t2[k]; }
        var n = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]) || 1;
        return { d: d, t: [t[0] / n, t[1] / n, t[2] / n] };
    }
    function _mcAngles(t) {
        var inc = Math.acos(Math.max(-1, Math.min(1, t[2]))) * 180 / Math.PI;
        var azi = Math.atan2(t[1], t[0]) * 180 / Math.PI; if (azi < 0) azi += 360;
        return { inc: inc, azi: inc < 1e-9 ? 0 : azi };
    }
    function surveyMC(rows) {
        var warnings = [], st = [];
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
            if (!row || !_fin(+row[0]) || !_fin(+row[1]) || !_fin(+row[2])) { warnings.push(_warn('SURVEY_ROW_DROPPED', 'warn', 'A survey row that is not three numbers (MD, inclination, azimuth) was dropped.')); return; }
            var md = +row[0], inc = +row[1], azi = ((+row[2] % 360) + 360) % 360;
            var last = st.length ? st[st.length - 1] : null;
            if (md < 0 || inc < 0 || inc > 180 || (last && !(md > last.md))) {
                warnings.push(_warn('SURVEY_ROW_DROPPED', 'warn', 'A survey row at ' + _f(md, 0) + ' ft MD was dropped (MD must rise, inclination 0–180°).'));
                return;
            }
            st.push({ md: md, inc: inc, azi: azi });
        });
        if (!st.length) return _fail('NO_SURVEY', 'The survey needs at least one row of MD, inclination and azimuth.', ['survey']);
        if (st[0].md > 0) {
            if (st[0].inc > 0) warnings.push(_warn('SURVEY_TIE_IN', 'info', 'The survey starts at ' + _f(st[0].md, 0) + ' ft MD; it is tied in at the surface (0 ft, vertical).'));
            st.unshift({ md: 0, inc: 0, azi: st[0].azi });
        }
        var out = [], maxInc = 0, maxDls = 0;
        st.forEach(function (s, i) {
            var o = { md: s.md, inc: s.inc, azi: s.azi, tvd: 0, n: 0, e: 0, dep: 0, hd: 0, dogleg: 0, dls: 0 };
            if (i > 0) {
                var p = out[i - 1], L = s.md - p.md, b = _mcDogleg(p.inc, p.azi, s.inc, s.azi);
                var a = _mcArc(_mcTan(p.inc, p.azi), _mcTan(s.inc, s.azi), b, L, 1);
                o.n = p.n + a.d[0]; o.e = p.e + a.d[1]; o.tvd = p.tvd + a.d[2];
                o.dep = Math.sqrt(o.n * o.n + o.e * o.e); o.hd = p.hd + Math.sqrt(a.d[0] * a.d[0] + a.d[1] * a.d[1]);
                o.dogleg = b * 180 / Math.PI; o.dls = L > 0 ? o.dogleg / L * 100 : 0;
            }
            if (o.inc > maxInc) maxInc = o.inc;
            if (o.dls > maxDls) maxDls = o.dls;
            out.push(o);
        });
        function at(md) {
            if (!_fin(md) || md < 0) return { md: md, tvd: NaN, n: NaN, e: NaN, dep: NaN, hd: NaN, inc: NaN, azi: NaN };
            var lo = 0, hi = out.length - 1;
            if (md >= out[hi].md) {
                var z = out[hi], t = _mcTan(z.inc, z.azi), dl = md - z.md, n = z.n + dl * t[0], e = z.e + dl * t[1];
                return { md: md, tvd: z.tvd + dl * t[2], n: n, e: e, dep: Math.sqrt(n * n + e * e), hd: z.hd + dl * Math.sqrt(t[0] * t[0] + t[1] * t[1]), inc: z.inc, azi: z.azi };
            }
            while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (out[mid].md <= md) lo = mid; else hi = mid; }
            var p = out[lo], q = out[hi], L = q.md - p.md, f = L > 0 ? (md - p.md) / L : 0;
            var b = q.dogleg * Math.PI / 180, a = _mcArc(_mcTan(p.inc, p.azi), _mcTan(q.inc, q.azi), b, L, f), ang = _mcAngles(a.t);
            var nn = p.n + a.d[0], ee = p.e + a.d[1];
            // along-hole horizontal length: the horizontal arc length is not closed form; the fraction of the interval's hd is used
            return { md: md, tvd: p.tvd + a.d[2], n: nn, e: ee, dep: Math.sqrt(nn * nn + ee * ee), hd: p.hd + f * (q.hd - p.hd), inc: ang.inc, azi: ang.azi };
        }
        return { ok: true, stations: out, at: at, tdMd: out[out.length - 1].md, maxInc: maxInc, maxDls: maxDls, warnings: warnings };
    }
    function _isMcRows(rows) {
        if (!Array.isArray(rows) || !rows.length) return false;
        for (var i = 0; i < rows.length; i++) if (!Array.isArray(rows[i]) || rows[i].length < 3 || !_fin(+rows[i][2])) return false;
        return true;
    }

    function column(spec) {
        spec = spec || {};
        var warnings = [];
        var datumTvd = _num(spec.datumTvd, null);
        if (!(_fin(datumTvd) && datumTvd > 0)) return _fail('NO_DATUM', 'The datum depth (mid-perforation TVD) is needed for the wellbore column.', ['datumTvd']);
        // survey [[md, tvd]] ascending MD; [0, 0] prepended. v4.3: [[md, inc, azi]] rows (every row three numbers) go through
        // surveyMC; the column then interpolates TVD on the minimum-curvature arcs (key mc). Two-column input is unchanged.
        var sv = [[0, 0]], mc = _isMcRows(spec.survey) ? surveyMC(spec.survey) : null;
        if (mc && !mc.ok) mc = null;
        if (mc) {
            mc.warnings.forEach(function (w) { warnings.push(w); });
            mc.stations.forEach(function (s) {
                var last = sv[sv.length - 1];
                if (s.md === 0) return;
                if (s.tvd >= last[1] - 1e-9) sv.push([s.md, s.tvd]);
                else warnings.push(_warn('SURVEY_ROW_DROPPED', 'warn', 'The station at ' + _f(s.md, 0) + ' ft MD rises (inclination above 90°); the column keeps TVD-monotone stations only.'));
            });
        } else if (Array.isArray(spec.survey)) {
            spec.survey.forEach(function (row) {
                if (!row || !_fin(+row[0]) || !_fin(+row[1])) return;
                var md = +row[0], tvd = +row[1], last = sv[sv.length - 1];
                if (md > last[0] && tvd >= last[1] - 1e-9 && tvd - last[1] <= md - last[0] + 1e-6) sv.push([md, tvd]);
                else if (md === 0 && tvd === 0) { /* the origin */ }
                else warnings.push(_warn('SURVEY_ROW_DROPPED', 'warn', 'A survey row at ' + _f(md, 0) + ' ft MD was dropped (MD must rise and TVD may not rise faster than MD).'));
            });
        }
        function tvdAt(md) {
            if (!_fin(md)) return NaN;
            if (mc && md >= 0) return mc.at(md).tvd;
            if (sv.length === 1) return md;
            for (var i = 1; i < sv.length; i++) if (md <= sv[i][0]) {
                var a = sv[i - 1], b = sv[i];
                return a[1] + (b[1] - a[1]) * (md - a[0]) / (b[0] - a[0]);
            }
            var p = sv[sv.length - 2], q = sv[sv.length - 1];
            return q[1] + (md - q[0]) * (q[1] - p[1]) / (q[0] - p[0]);
        }
        function mdAt(tvd) {
            if (!_fin(tvd)) return NaN;
            if (sv.length === 1) return tvd;
            for (var i = 1; i < sv.length; i++) if (tvd <= sv[i][1] && sv[i][1] > sv[i - 1][1]) {
                var a = sv[i - 1], b = sv[i];
                if (tvd < a[1]) continue;
                if (mc) {          // bisection on the arc (TVD rises monotonically between TVD-monotone stations)
                    var lo = a[0], hi = b[0];
                    for (var it = 0; it < 60 && hi - lo > 1e-7; it++) { var m = 0.5 * (lo + hi); if (tvdAt(m) < tvd) lo = m; else hi = m; }
                    return 0.5 * (lo + hi);
                }
                return a[0] + (b[0] - a[0]) * (tvd - a[1]) / (b[1] - a[1]);
            }
            var p = sv[sv.length - 2], q = sv[sv.length - 1];
            var dz = q[1] - p[1];
            if (!(dz > 0)) return q[0];
            return q[0] + (tvd - q[1]) * (q[0] - p[0]) / dz;
        }
        var datumMd = _num(spec.datumMd, null);
        if (!_fin(datumMd)) datumMd = mdAt(datumTvd);
        // strings top → perforations
        var segs = [];
        (Array.isArray(spec.strings) ? spec.strings : []).forEach(function (s, i) {
            if (!s) return;
            var e = _tubLookup(s.tubKey);
            var id = _num(s.id, e ? e.id : null), od = _num(s.od, e ? e.od : null);
            var wall = _num(s.wall, (e && _fin(e.wall)) ? e.wall : (_fin(id) && _fin(od) ? (od - id) / 2 : null));
            var top = _num(s.topMd, i === 0 ? 0 : null), bot = _num(s.botMd, null);
            if (!(_fin(id) && id > 0 && _fin(od) && od > id && _fin(wall) && wall > 0 && _fin(top) && _fin(bot) && bot > top)) {
                warnings.push(_warn('STRING_DROPPED', 'warn', 'String row ' + (i + 1) + ' was dropped (it needs id < od, a wall and topMd < botMd).'));
                return;
            }
            segs.push({ topMd: top, botMd: bot, id: id, od: od, wall: wall, area: Math.PI / 4 * id * id / 144, rough: _fin(s.rough) ? s.rough : null,
                        tubKey: e ? s.tubKey : null });
        });
        segs.sort(function (a, b) { return a.topMd - b.topMd; });
        var Vw = null;
        if (segs.length) {
            Vw = 0;
            var covered = 0;
            for (var k = 0; k < segs.length; k++) {
                var s0 = segs[k], a0 = Math.max(s0.topMd, covered), b0 = Math.min(s0.botMd, datumMd);
                if (s0.topMd > covered + 1) warnings.push(_warn('STRING_GAP', 'warn', 'The strings leave a gap between ' + _f(covered, 0) + ' and ' + _f(s0.topMd, 0) + ' ft MD.'));
                if (b0 > a0) { Vw += (b0 - a0) * s0.area / BBL; covered = b0; }
            }
            if (covered < datumMd - 1) warnings.push(_warn('STRING_SHORT', 'warn', 'The strings end at ' + _f(covered, 0) + ' ft MD, above the datum at ' + _f(datumMd, 0) + ' ft MD; the last string is extended.'));
            if (covered < datumMd) {
                var last = segs[segs.length - 1];
                Vw += (datumMd - covered) * last.area / BBL;
                last.botMd = Math.max(last.botMd, datumMd);
            }
        } else {
            warnings.push(_warn('NO_STRINGS', 'warn', 'No flow string is given: capacity, storage and pipe friction are not available.'));
        }
        function segAt(md) {
            for (var i = 0; i < segs.length; i++) if (md >= segs[i].topMd - 1e-9 && md <= segs[i].botMd + 1e-9) return segs[i];
            return segs.length ? segs[segs.length - 1] : null;
        }
        function capacityAt(md) { var s = segAt(md); return s ? s.area / BBL : null; }
        // MD at which a cumulative volume (bbl) from the surface is reached (displaced column)
        function mdAtVolume(V) {
            if (!segs.length || !_fin(V) || V <= 0) return 0;
            var acc = 0;
            for (var i = 0; i < segs.length; i++) {
                var s = segs[i], cap = s.area / BBL, len = Math.min(s.botMd, datumMd) - s.topMd;
                if (len <= 0) continue;
                if (acc + cap * len >= V) return s.topMd + (V - acc) / cap;
                acc += cap * len;
            }
            return datumMd;
        }
        var fl = _fluid(spec.fluid);
        var tp = spec.temp || {};
        var colOut = {
            ok: true, tvdAt: tvdAt, mdAt: mdAt, capacityAt: capacityAt, mdAtVolume: mdAtVolume, segAt: segAt,
            segments: segs, Vw: _nn(Vw), warnings: warnings,
            datumTvd: datumTvd, datumMd: datumMd, survey: sv, fluid: fl,
            temp: { model: tp.model === 'displaced' ? 'displaced' : 'static', surfF: _num(tp.surfF, 70), gradFper100: _num(tp.gradFper100, 1.5),
                    tauLoH: _num(tp.tauLoH, 0.5), tauHiH: _num(tp.tauHiH, 5) }
        };
        if (mc) colOut.mc = { stations: mc.stations, at: mc.at, maxInc: mc.maxInc, maxDls: mc.maxDls };   // only with [md, inc, azi] rows
        return colOut;
    }
    function _col(c) { if (c && typeof c.tvdAt === 'function') return c; if (c && typeof c === 'object') { var k = column(c); return k.ok ? k : null; } return null; }

    // ── system compressibility (§4.3) ────────────────────────────────────────
    function csys(col, fluid, T, opts) {
        var c = _col(col);
        if (!c) return _fail('NO_COLUMN', 'A wellbore column is needed for the system compressibility.', ['column']);
        var o = opts || {};
        var fl = _fluid(fluid || c.fluid);
        var cFluid = fl.cFluid, src = 'given';
        if (!cFluid) {
            if (fl.kind === 'oil') { cFluid = 1e-5; src = 'default-oil'; }
            else if (fl.cFluidModel === 'dodson' && _pvt() && typeof _pvt().cw_dodson === 'function') {
                var Tm = _fin(T) ? T : c.temp.surfF + c.temp.gradFper100 / 100 * c.datumTvd / 2;
                var pm = _num(o.pMean, 0.052 * fl.rhoPpg * c.datumTvd / 2 + 14.7);
                cFluid = _pvt().cw_dodson(pm, Tm, 0); src = 'dodson';
                if (!(_fin(cFluid) && cFluid > 0)) { cFluid = 1 / K_WATER; src = 'default-water'; }
            } else { cFluid = 1 / K_WATER; src = 'default-water'; }
        }
        var psi = _num(o.psi, 1), Es = _num(o.Es, E_STEEL);
        var vSum = 0, vcp = 0;
        c.segments.forEach(function (s) {
            var len = Math.min(s.botMd, c.datumMd) - s.topMd;
            if (len <= 0) return;
            var v = len * s.area;
            vSum += v; vcp += v * psi * s.id / (Es * s.wall);
        });
        var cPipe = vSum > 0 ? vcp / vSum : 0;
        var cS = cFluid + cPipe;
        var rhoSlug = fl.rhoPpg * SLUG_PER_PPG;
        var wave = Math.sqrt(144 / (rhoSlug * cS));
        var Vw = c.Vw;
        return { ok: true, cSys: cS, cFluid: cFluid, cPipe: cPipe, VwCw: _fin(Vw) ? Vw * cS : null, VwCwFt3: _fin(Vw) ? Vw * BBL * cS : null,
                 waveSpeed: wave, rhoSlug: rhoSlug, cFluidSource: src };
    }

    // ── temperature profiles (§4.2) ──────────────────────────────────────────
    function tempProfile(col, opts) {
        var c = _col(col);
        var o = opts || {};
        var base = c ? c.temp : { surfF: 70, gradFper100: 1.5, tauLoH: 0.5, tauHiH: 5 };
        var surfF = _num(o.surfF, base.surfF), grad = _num(o.gradFper100, base.gradFper100) / 100;
        var model = o.model || (c ? c.temp.model : 'static');
        function geo(tvd) { return surfF + grad * tvd; }
        if (model === 'ramey') {
            if (typeof G.WTS_wellbore._ramey === 'function') return G.WTS_wellbore._ramey(c, o);
            return _fail('NOT_AVAILABLE', 'The Ramey temperature model belongs to the field tools (3.4b).', ['model']);
        }
        if (model !== 'displaced') return { ok: true, model: 'static', T: geo, Tmd: function (md) { return geo(c ? c.tvdAt(md) : md); } };
        if (!c) return _fail('NO_COLUMN', 'The displaced temperature model needs the wellbore column.', ['column']);
        var tInj = _num(o.tInjF, c.fluid.tInjF);
        var Vinj = _num(o.Vinj, 0);
        var D = c.mdAtVolume(Vinj);
        var tau = _num(o.tauH, Math.sqrt(_num(o.tauLoH, base.tauLoH) * _num(o.tauHiH, base.tauHiH)));
        var t = _num(o.t, 0);       // h since shut-in (≤ 0: at or before shut-in, fully displaced)
        var r = t > 0 ? Math.exp(-t / Math.max(tau, 1e-6)) : 1;
        function Tmd(md) {
            var g0 = geo(c.tvdAt(md));
            var td = md < D ? tInj : geo(c.tvdAt(md - D));
            return g0 + r * (td - g0);
        }
        return { ok: true, model: 'displaced', T: function (tvd) { return Tmd(c.mdAt(tvd)); }, Tmd: Tmd, D: D, tau: tau, relax: r };
    }
    function _Tfn(T, c) {
        if (typeof T === 'function') return T;
        if (_fin(T)) return function () { return T; };
        if (T && typeof T.T === 'function') return T.T;
        if (c) return tempProfile(c, { model: 'static' }).T;
        return function () { return 60; };
    }

    // ── flowing temperature: steady relaxation (v4.4, Well Performance WP14; docs/WELL-PERFORMANCE-PLAN.md §4.6, D7, Q16) ──────
    // Ramey (1962) / Hasan & Kabir (1994) steady relaxation, decoupled from pressure. z = length ALONG THE HOLE in the flow
    // direction (production: upward from the inlet, normally the mid-perforations; injection: downward from the wellhead). The
    // earth temperature T_ei comes from the geotherm on TVD (piecewise linear points or a gradient), so along the hole its slope is
    // s = dT_ei/dz = ±g_G·sinθ (θ from horizontal: the true inclination of the survey). The energy balance w·c_p·dT_f/dz =
    // −(2π r_to U_to k_e / (k_e + r_to U_to f(t_D)))·(T_f − T_ei) = −w·c_p (T_f − T_ei) / A gives on every piece where s is constant
    //   T_f(z) = T_ei(z) + (T_f0 − T_ei0)·e^(−z/A) − s·A·(1 − e^(−z/A))
    // i.e. the plan's T_f = T_ei + (T_bh − T_ebh) e^(−z/A) + g_G A sinθ (1 − e^(−z/A)) for production (s = −g_G sinθ); applied piece by
    // piece (pieces end at survey stations, geotherm points and at most every stepFt ft), so the march is exact for a piecewise-linear
    // T_ei(z). A = (w c_p / 2π)·(k_e + r_to U_to f(t_D)) / (r_to U_to k_e) [ft]: w lbm/hr, c_p Btu/lbm·°F, k_e Btu/hr·ft·°F, r_to ft,
    // U_to Btu/hr·ft²·°F on the OUTSIDE-tubing-radius basis (a U on the inside radius is converted, U_to = U_ti·r_ti / r_to).
    // f(t_D) = 1.1281 √t_D (1 − 0.3 √t_D) for t_D ≤ 1.5, (0.4063 + 0.5 ln t_D)(1 + 0.6 / t_D) otherwise (Hasan & Kabir), t_D = α t / r_wb².
    // As U → ∞, A → w c_p f(t_D) / (2π k_e) (the earth resistance alone: the plain Ramey line source).
    function flowingTempF(tD) {
        if (!(_fin(tD) && tD > 0)) return NaN;
        if (tD <= 1.5) { var s = Math.sqrt(tD); return 1.1281 * s * (1 - 0.3 * s); }
        return (0.4063 + 0.5 * Math.log(tD)) * (1 + 0.6 / tD);
    }
    function _geoFn(o, c) {
        var g = o.geo;
        if (typeof g === 'function') return g;
        if (g && Array.isArray(g.points)) {
            var pts = g.points.map(function (p) { return [_num(p && p[0], NaN), _num(p && p[1], NaN)]; }).filter(function (p) { return _fin(p[0]) && _fin(p[1]); })
                .sort(function (a, b) { return a[0] - b[0]; });
            var sf = _num(g.surfT_F, _num(g.surfF, null));
            if (_fin(sf) && !(pts.length && pts[0][0] === 0)) pts.unshift([0, sf]);
            if (pts.length >= 2) return function (tvd) {
                var k = 1; while (k < pts.length - 1 && tvd > pts[k][0]) k++;
                var a = pts[k - 1], b = pts[k]; return b[0] > a[0] ? a[1] + (b[1] - a[1]) * (tvd - a[0]) / (b[0] - a[0]) : a[1];
            };
            if (pts.length === 1 && _fin(_num(g.gradFper100, null))) { var p0 = pts[0], gg = g.gradFper100 / 100; return function (tvd) { return p0[1] + gg * (tvd - p0[0]); }; }
            return null;
        }
        var base = (c && c.temp) || { surfF: 70, gradFper100: 1.5 };
        var surf = _num(g && g.surfF, _num(o.surfF, base.surfF)), grad = _num(g && g.gradFper100, _num(o.gradFper100, base.gradFper100)) / 100;
        return function (tvd) { return surf + grad * tvd; };
    }
    function flowingTemp(col, opts) {
        var c = _col(col);
        if (!c) return _fail('NO_COLUMN', 'A wellbore column (survey and datum) is needed for the flowing temperature.', ['column']);
        var o = opts || {}, warnings = [];
        var dir = o.direction === 'inject' ? 'inject' : 'produce';
        var w = _num(o.w, NaN), cp = _num(o.cp, NaN);
        if (!(w > 0)) return _fail('NO_RATE', 'The mass rate w (lbm/hr) must be above zero.', ['w']);
        if (!(cp > 0)) return _fail('NO_CP', 'The heat capacity c_p (Btu/lbm·°F) must be above zero.', ['cp']);
        var rto = _num(o.r_to, NaN);
        if (!(rto > 0)) return _fail('NO_RADIUS', 'The outside tubing radius r_to (ft) is needed.', ['r_to']);
        var U = _num(o.U_to, NaN), basis = 'to';
        if (!_fin(U) && _fin(_num(o.U_ti, NaN))) {
            var rti = _num(o.r_ti, NaN);
            if (!(rti > 0 && rti <= rto)) return _fail('NO_RADIUS', 'A U on the inside-radius basis needs the inside tubing radius r_ti (ft, at most r_to).', ['r_ti']);
            U = o.U_ti * rti / rto; basis = 'ti';
        }
        if (!(U > 0)) return _fail('NO_U', 'The overall heat-transfer coefficient U (Btu/hr·ft²·°F) must be above zero.', ['U_to']);
        var ke = _num(o.ke, 1.4), alpha = _num(o.alpha, 0.04), tHr = _num(o.t_hr, 720);
        var rwb = _num(o.rwb, NaN), rwbSrc = 'input';
        if (!(rwb > 0)) {
            var odMax = 0; (c.segments || []).forEach(function (s) { if (s.od > odMax) odMax = s.od; });
            rwb = odMax > 0 ? Math.max(odMax / 24, rto) : 0.354; rwbSrc = odMax > 0 ? 'largest string OD' : 'default 8.5 in hole';
        }
        if (!(ke > 0 && alpha > 0 && tHr > 0)) return _fail('BAD_INPUT', 'k_e, α and the producing time must be above zero.', ['ke', 'alpha', 't_hr']);
        if (rwb < rto) { warnings.push(_warn('RWB_SMALL', 'warn', 'The wellbore radius is below the tubing radius; r_wb = r_to is used.')); rwb = rto; }
        var tD = alpha * tHr / (rwb * rwb), fT = flowingTempF(tD);
        var A = (w * cp / (2 * Math.PI)) * (ke + rto * U * fT) / (rto * U * ke);
        var geo = _geoFn(o, c);
        if (!geo) return _fail('NO_GEOTHERM', 'A geotherm (surface temperature and gradient, or TVD-temperature points) is needed.', ['geo']);
        var tvdOf = function (md) { return md <= 0 ? 0 : c.tvdAt(md); };
        var teAt = function (md) { return geo(tvdOf(md)); };
        var inMd = _num(o.fromMd, dir === 'produce' ? c.datumMd : 0), outMd = _num(o.toMd, dir === 'produce' ? 0 : c.datumMd);
        if (!(_fin(inMd) && _fin(outMd)) || inMd === outMd) return _fail('BAD_INPUT', 'fromMd and toMd must be two different depths.', ['fromMd', 'toMd']);
        var up = outMd < inMd;
        if ((dir === 'produce') !== up) warnings.push(_warn('DIRECTION', 'info', dir === 'produce' ? 'Production normally flows up the hole (fromMd below toMd).' : 'Injection normally flows down the hole (fromMd above toMd).'));
        var Tin = _num(o.Tin, NaN), te0 = teAt(inMd);
        if (!_fin(Tin)) Tin = dir === 'produce' ? te0 : teAt(0);
        // piece ends: survey stations, geotherm breakpoints (as MD) and at most stepFt along the hole
        var lo = Math.min(inMd, outMd), hi = Math.max(inMd, outMd), step = Math.max(5, _num(o.stepFt, 50)), cuts = [lo, hi];
        for (var m = Math.ceil(lo / step) * step; m < hi; m += step) cuts.push(m);
        (c.survey || []).forEach(function (s) { if (s[0] > lo && s[0] < hi) cuts.push(s[0]); });
        if (c.mc) c.mc.stations.forEach(function (s) { if (s.md > lo && s.md < hi) cuts.push(s.md); });
        if (o.geo && Array.isArray(o.geo.points)) o.geo.points.forEach(function (p) { var t = _num(p && p[0], NaN); if (t > 0) { var mdp = c.mdAt(t); if (mdp > lo && mdp < hi) cuts.push(mdp); } });
        cuts.sort(function (a, b) { return a - b; });
        var mds = [];
        cuts.forEach(function (x) { if (!mds.length || x - mds[mds.length - 1] > 1e-6) mds.push(x); });
        if (up) mds.reverse();
        // the exact march, piece by piece in the flow direction
        var pieces = [], T = Tin, z = 0, prof = [{ md: mds[0], tvd: tvdOf(mds[0]), z: 0, te: teAt(mds[0]), t: T }];
        for (var i = 1; i < mds.length; i++) {
            var a = mds[i - 1], b = mds[i], L = Math.abs(b - a), tea = teAt(a), teb = teAt(b), s = (teb - tea) / L, e = Math.exp(-L / A);
            pieces.push({ md0: a, md1: b, z0: z, L: L, T0: T, te0: tea, s: s });
            T = teb + (T - tea) * e - s * A * (1 - e);
            z += L;
            prof.push({ md: b, tvd: tvdOf(b), z: z, te: teb, t: T });
        }
        var p0 = pieces[0], pN = pieces[pieces.length - 1];
        function tAt(md) {
            if (!_fin(md)) return NaN;
            if (up ? md >= p0.md0 : md <= p0.md0) return Tin;                    // upstream of the inlet: the inlet temperature
            if (up ? md <= pN.md1 : md >= pN.md1) return T;                      // beyond the outlet: the outlet temperature
            var k0 = 0, k1 = pieces.length - 1;
            while (k1 > k0) { var km = (k0 + k1) >> 1; var pk = pieces[km]; if (up ? md >= pk.md1 : md <= pk.md1) k1 = km; else k0 = km + 1; }
            var p = pieces[k0], l = Math.abs(md - p.md0), ee = Math.exp(-l / A), tem = p.te0 + p.s * l;
            return tem + (p.T0 - p.te0) * ee - p.s * A * (1 - ee);
        }
        return { ok: true, direction: dir, A: A, fTD: fT, tD: tD, U_to: U, Ubasis: basis, r_to: rto, rwb: rwb, rwbSource: rwbSrc, ke: ke, alpha: alpha,
                 t_hr: tHr, w: w, cp: cp, fromMd: inMd, toMd: outMd, Tin: Tin, tOut: T, teOut: teAt(outMd), teIn: te0,
                 offsetOut: -pN.s * A, tAt: tAt, teAt: teAt, profile: prof, pieces: pieces.length, warnings: warnings };
    }
    // U_to that makes the flowing temperature at target.md equal target.T (°F): Brent on ln U in [Umin, Umax] (default 0.01–1000).
    // The temperature at the outlet falls monotonically with U for production (more heat lost), rises for injection; a target
    // outside the reachable range returns OUT_OF_RANGE with that range (U → 0: the inlet temperature carried up adiabatically;
    // U → ∞: the earth-resistance limit).
    function flowingTempFitU(col, opts, target) {
        var o = opts || {}, tg = target || {};
        var T = _num(tg.T, NaN);
        if (!_fin(T)) return _fail('NO_TARGET', 'A measured temperature (target.T, °F) is needed for the U fit.', ['T']);
        var Umin = _num(tg.Umin, 0.01), Umax = _num(tg.Umax, 1000);
        var base = flowingTemp(col, Object.assign({}, o, { U_to: 1, U_ti: undefined }));
        if (!base.ok) return base;
        var md = _num(tg.md, base.toMd), n = 0;
        function at(lnU) { n++; var r = flowingTemp(col, Object.assign({}, o, { U_to: Math.exp(lnU), U_ti: undefined })); return r.ok ? r.tAt(md) : NaN; }
        var a = Math.log(Umin), b = Math.log(Umax), fa = at(a) - T, fb = at(b) - T;
        var range = { Umin: Umin, Umax: Umax, tAtUmin: fa + T, tAtUmax: fb + T };
        if (!(_fin(fa) && _fin(fb))) return _fail('FIT_FAILED', 'The flowing temperature could not be evaluated for the U fit.');
        if (fa * fb > 0) {
            var near = Math.abs(fa) < Math.abs(fb) ? Umin : Umax;
            var r0 = _fail('OUT_OF_RANGE', 'The measured ' + _f(T, 1) + ' °F is outside the reachable range ' + _f(Math.min(range.tAtUmin, range.tAtUmax), 1) + '–' + _f(Math.max(range.tAtUmin, range.tAtUmax), 1) + ' °F for U ' + Umin + '–' + Umax + ' Btu/hr·ft²·°F.');
            r0.range = range; r0.nearest = near; return r0;
        }
        // Brent (zeroin) on ln U. A second small zeroin besides the private _brent of 49-calc-wp-system.js (review note, kept on
        // purpose): this file loads first, and that solver's tolerances (TOL_Q / TOL_P on rate and pressure) and result shape are its own.
        var c2 = a, fc = fa, d = b - a, e = d;
        for (var it = 0; it < 100; it++) {
            if ((fb > 0) === (fc > 0)) { c2 = a; fc = fa; d = b - a; e = d; }
            if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c2; c2 = a; fa = fb; fb = fc; fc = fa; }
            var tol = 1e-10 * Math.max(1, Math.abs(b)), mm = 0.5 * (c2 - b);
            if (Math.abs(fb) < 1e-9 || Math.abs(mm) <= tol) break;
            if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
                var sx = fb / fa, p, q, r;
                if (a === c2) { p = 2 * mm * sx; q = 1 - sx; }
                else { q = fa / fc; r = fb / fc; p = sx * (2 * mm * q * (q - r) - (b - a) * (r - 1)); q = (q - 1) * (r - 1) * (sx - 1); }
                if (p > 0) q = -q; else p = -p;
                if (2 * p < Math.min(3 * mm * q - Math.abs(tol * q), Math.abs(e * q))) { e = d; d = p / q; } else { d = mm; e = mm; }
            } else { d = mm; e = mm; }
            a = b; fa = fb;
            b += Math.abs(d) > tol ? d : (mm > 0 ? tol : -tol);
            fb = at(b) - T;
        }
        var U = Math.exp(b), fin = flowingTemp(col, Object.assign({}, o, { U_to: U, U_ti: undefined }));
        return { ok: true, U_to: U, T: fin.ok ? fin.tAt(md) : NaN, md: md, resid: fb, evals: n, range: range, A: fin.A, result: fin, warnings: fin.warnings || [] };
    }

    // ── hydrostatics (§4.2) ──────────────────────────────────────────────────
    function hydrostatic(pKnown, tvdKnown, tvdTarget, col, T, opts) {
        var o = opts || {};
        pKnown = _num(pKnown, NaN); tvdKnown = _num(tvdKnown, NaN); tvdTarget = _num(tvdTarget, NaN);
        if (!_fin(pKnown) || !_fin(tvdKnown) || !_fin(tvdTarget)) return _fail('BAD_INPUT', 'Hydrostatics needs a pressure and two depths.', ['pKnown']);
        var c = _col(col);
        var fl = _fluid(o.fluid || (c ? c.fluid : null));
        var dz = tvdTarget - tvdKnown;
        if (o.model === 'constant' || _fin(o.grad) || fl.kind === 'oil') {
            var gr = _num(o.grad, 0.052 * fl.rhoPpg);
            return { ok: true, p: pKnown + gr * dz, rhoBar: gr / 0.052, dp: gr * dz, rangeNote: null, model: 'constant' };
        }
        var Tf = _Tfn(T, c);
        var n = Math.max(1, Math.ceil(Math.abs(dz) / _num(o.stepFt, 10))), h = dz / n, p = pKnown, pMax = p, tMax = -1e9;
        var rhoSc = rhoScLbFt3(fl.S);
        for (var k = 0; k < n; k++) {
            var zm = tvdKnown + (k + 0.5) * h, Tm = Tf(zm);
            var pm = p + 0.052 * rhoSc / _Bw(p, Tm) / GAL_PER_FT3 * h / 2;
            p = p + 0.052 * rhoSc / _Bw(pm, Tm) / GAL_PER_FT3 * h;
            if (p > pMax) pMax = p;
            if (Tm > tMax) tMax = Tm;
        }
        var dp = p - pKnown;
        var note = (pMax > 5000 || tMax > 260) ? 'Water density correlation used beyond its fitted range (p ≤ 5,000 psia, T ≤ 260 °F).' : null;
        return { ok: true, p: p, rhoBar: dz !== 0 ? dp / (0.052 * dz) : rhoAt(pKnown, Tf(tvdKnown), fl), dp: dp, rangeNote: note, model: 'rho(p,T)' };
    }

    // ── pipe friction (§4.2) ─────────────────────────────────────────────────
    function _fanColebrook(re, rr) {
        if (re < 2100) return 16 / re;
        var F = G.WTS_flowline_friction;
        if (F && typeof F.colebrook === 'function') { var fd = F.colebrook(re, rr); if (_fin(fd) && fd > 0) return fd / 4; }
        var x = -4 * Math.log10(rr / 3.7 + 5.74 / Math.pow(re, 0.9));
        for (var k = 0; k < 80; k++) { var xn = -4 * Math.log10(rr / 3.7 + 1.255 * x / re); if (Math.abs(xn - x) < 1e-13) { x = xn; break; } x = xn; }
        return 1 / (x * x);
    }
    function _virk(re) {
        var f = 0.002;
        for (var k = 0; k < 200; k++) { var x = 19 * Math.log10(re * Math.sqrt(f)) - 32.4; var fn = 1 / (x * x); if (Math.abs(fn - f) < 1e-14) return fn; f = fn; }
        return f;
    }
    function _dodgeMetzner(re, n) {
        var f = 0.005;
        for (var k = 0; k < 200; k++) {
            var rhs = (4 / Math.pow(n, 0.75)) * Math.log10(re * Math.pow(f, 1 - n / 2)) - 0.395 / Math.pow(n, 1.2);
            var fn = 1 / (rhs * rhs);
            if (Math.abs(fn - f) < 1e-12) { f = fn; break; }
            f = fn;
        }
        return f;
    }
    function pipeFriction(q, seg, fluid, T) {
        q = Math.abs(_num(q, NaN));
        var d = seg ? _num(seg.id, NaN) : NaN;
        if (!_fin(q) || !(d > 0)) return _fail('BAD_INPUT', 'Pipe friction needs a rate and a pipe inside diameter.', ['q', 'id']);
        var fl = _fluid(fluid);
        var rough = (seg && _fin(seg.rough) && seg.rough >= 0) ? seg.rough : 0.0018;
        var v = 17.157 * q / (d * d);
        var rho = fl.rhoPpg;
        if (q === 0) return { ok: true, dpdl: 0, v: 0, re: 0, regime: 'laminar', f: null, model: fl.nPrime && fl.kPrime ? 'powerlaw' : (fl.fr > 0 ? 'fr' : 'newtonian') };
        if (fl.nPrime && fl.kPrime) {
            var n = fl.nPrime, Kcp = fl.kPrime * 47880.26;
            var reMR = 89100 * rho * Math.pow(v, 2 - n) / Kcp * Math.pow(0.0416 * d / (3 + 1 / n), n);
            var reC = 3470 - 1370 * n, grad, f;
            if (reMR < reC) { grad = Kcp * Math.pow(v, n) * Math.pow((3 + 1 / n) / 0.0416, n) / (144000 * Math.pow(d, 1 + n)); f = 16 / reMR;
                return { ok: true, dpdl: grad, v: v, re: reMR, regime: 'laminar', f: f, model: 'powerlaw', reCrit: reC }; }
            f = _dodgeMetzner(reMR, n);
            return { ok: true, dpdl: f * rho * v * v / (25.8 * d), v: v, re: reMR, regime: 'turbulent', f: f, model: 'powerlaw', reCrit: reC };
        }
        var mu = fl.muCp != null ? fl.muCp : _muWater(_fin(T) ? T : 70, fl.S, 14.7);
        var re = 928 * rho * v * d / mu;
        var fw = _fanColebrook(re, rough / d);
        if (fl.fr > 0 && re >= 2100) {
            var fv = _virk(re), ffr = Math.max((1 - fl.fr) * fw, fv);
            return { ok: true, dpdl: ffr * rho * v * v / (25.8 * d), v: v, re: re, regime: 'turbulent', f: ffr, model: 'fr',
                     fWater: fw, fVirk: fv, frEff: 1 - ffr / fw, frCapped: (1 - fl.fr) * fw < fv };
        }
        return { ok: true, dpdl: fw * rho * v * v / (25.8 * d), v: v, re: re, regime: re < 2100 ? 'laminar' : 'turbulent', f: fw,
                 model: fl.fr > 0 ? 'fr' : 'newtonian' };
    }
    // total pipe friction (psi) along the strings from the surface to the datum, friction on MD
    function pipeDp(q, col, fluid, T) {
        var c = _col(col);
        if (!c) return _fail('NO_COLUMN', 'Pipe friction along the well needs the column.', ['column']);
        var fl = fluid || c.fluid, Tf = _Tfn(T, c), dp = 0, per = [];
        for (var i = 0; i < c.segments.length; i++) {
            var s = c.segments[i], len = Math.min(s.botMd, c.datumMd) - s.topMd;
            if (len <= 0) continue;
            var r = pipeFriction(q, s, fl, Tf(c.tvdAt(0.5 * (s.topMd + Math.min(s.botMd, c.datumMd)))));
            if (!r.ok) return r;
            dp += r.dpdl * len; per.push({ topMd: s.topMd, botMd: s.botMd, dp: r.dpdl * len, regime: r.regime, re: r.re });
        }
        return { ok: true, dp: dp, segments: per };
    }

    // ── perforations, near-wellbore loss, bleed-off (§4.2) ───────────────────
    function perfConstant() {
        // ρv²/(2·144) for 1 bbl/min through one 1-in hole, 1 ppg, C_d 1 (first principles)
        var A = Math.PI / 4 / 144, v = BPM / A;
        return SLUG_PER_PPG * v * v / 2 / 144;
    }
    function perfFriction(q, perfs, rhoPpg) {
        var p = perfs || {};
        var n = _num(p.n, NaN), d = _num(p.dIn, 0.40), cd = _num(p.cd, 0.62), rho = _num(rhoPpg, 8.43);
        q = _num(q, NaN);
        if (!(n > 0) || !(d > 0) || !(cd > 0) || !_fin(q)) return null;
        return PERF_C * q * q * rho / (n * n * Math.pow(d, 4) * cd * cd);
    }
    function nwbLoss(q, o) {
        o = o || {};
        var b = _num(o.b, NaN), beta = _num(o.beta, 0.5), qt = _num(o.qt, 0.1);
        q = _num(q, NaN);
        if (!_fin(b) || !_fin(q)) return null;
        var aq = Math.abs(q), s = q < 0 ? -1 : 1;
        if (qt > 0 && aq < qt) return s * b * Math.pow(qt, beta) * (aq / qt);
        return s * b * Math.pow(aq, beta);
    }
    // V_w·c_w·dΔ/dt = −q(Δ); Δ = b·q^β above q_t, linear below. VwCw bbl/psi, q bbl/min; curve(dt h) → psi
    function bleedOff(o) {
        o = o || {};
        var b = _num(o.b, NaN), beta = _num(o.beta, 0.5), qt = Math.max(0, _num(o.qt, 0.1)), VC = _num(o.VwCw, NaN);
        var d0 = _num(o.d0, _fin(o.q0) && _fin(b) ? b * Math.pow(Math.abs(o.q0), beta) : NaN);
        if (!(b > 0) || !(VC > 0) || !(d0 >= 0) || !(beta > 0 && beta <= 1)) return _fail('BAD_INPUT', 'Bleed-off needs b, β in (0, 1], V_w·c_w and the loss at shut-in.', ['b', 'VwCw', 'd0']);
        var k = 1 / beta;
        var Dt = qt > 0 ? b * Math.pow(qt, beta) : 0;          // loss at the branch rate
        var tau2 = qt > 0 ? VC * Dt / qt : null;                // min, linear branch
        // time (min) on the power branch from d0 down to x (x ≥ Dt)
        function tPow(x) {
            if (k === 1) return VC * b * Math.log(d0 / x);
            return VC * Math.pow(b, k) * (Math.pow(x, 1 - k) - Math.pow(d0, 1 - k)) / (k - 1);
        }
        var tA = (d0 > Dt) ? tPow(Math.max(Dt, 1e-300)) : 0;    // time to reach the branch
        if (!(Dt > 0)) tA = Infinity;
        function curveMin(t) {
            if (!(t > 0)) return d0;
            if (d0 > Dt && t < tA) {
                if (k === 1) return d0 * Math.exp(-t / (VC * b));
                var base = Math.pow(d0, 1 - k) + (k - 1) * Math.pow(b, -k) * t / VC;
                return Math.pow(base, 1 / (1 - k));
            }
            var start = d0 > Dt ? Dt : d0, t0 = d0 > Dt ? tA : 0;
            return start * Math.exp(-(t - t0) / tau2);
        }
        function tTo(x) {
            if (!(x > 0)) return null;
            if (d0 <= x) return 0;
            if (x >= Dt) return tPow(x);
            var start = d0 > Dt ? Dt : d0, t0 = d0 > Dt ? tA : 0;
            return t0 + tau2 * Math.log(start / x);
        }
        var t1 = tTo(1), t10 = tTo(10);
        return { ok: true, t1psi: _fin(t1) ? t1 / 60 : null, t10psi: _fin(t10) ? t10 / 60 : null,
                 curve: function (dtH) { return curveMin(_num(dtH, 0) * 60); }, d0: d0, tauLinearMin: _nn(tau2), branch: { dPsi: Dt, tMin: _nn(tA) } };
    }

    // ── surface → bottomhole conversion (§4.2) ───────────────────────────────
    function _interp1(xs, ys, x) {
        if (xs.length === 1) return ys[0];
        if (x <= xs[0]) return ys[0] + (ys[1] - ys[0]) * (x - xs[0]) / (xs[1] - xs[0]);
        for (var i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
        var n = xs.length;
        return ys[n - 2] + (ys[n - 1] - ys[n - 2]) * (x - xs[n - 2]) / (xs[n - 1] - xs[n - 2]);
    }
    // 3-point Lagrange interpolation on the pressure nodes (the column Δp is smooth in p)
    function _interpQ(xs, ys, x) {
        var n = xs.length;
        if (n < 3) return _interp1(xs, ys, x);
        var i = 1;
        while (i < n - 2 && x > xs[i]) i++;
        var x0 = xs[i - 1], x1 = xs[i], x2 = xs[i + 1];
        return ys[i - 1] * (x - x1) * (x - x2) / ((x0 - x1) * (x0 - x2)) + ys[i] * (x - x0) * (x - x2) / ((x1 - x0) * (x1 - x2))
             + ys[i + 1] * (x - x0) * (x - x1) / ((x2 - x0) * (x2 - x1));
    }
    function convert(ds, prepCtx, opts) {
        var ctx = prepCtx || {}, o = opts || {};
        if (!ds || !Array.isArray(ds.t)) return _fail('BAD_INPUT', 'The dataset needs a time array.', ['t']);
        var c = _col(ctx.column);
        if (!c) return _fail('NO_COLUMN', 'Converting a surface pressure needs the wellbore column (datum, strings).', ['column']);
        var ps = ds.pSurf || (o.channel === 'p' ? ds.p : null);
        if (!Array.isArray(ps) || ps.length !== ds.t.length) return _fail('NO_SURFACE', 'The dataset has no surface-pressure channel of the same length as the time.', ['pSurf']);
        var fl = _fluid(ctx.fluid || c.fluid);
        var temp = ctx.temp || c.temp;
        var tModel = temp.model === 'displaced' ? 'displaced' : 'static';
        var atm = _num(ctx.atmPsia, 14.696), gaugeTvd = _num(ctx.gaugeTvd, 0), datum = c.datumTvd;
        var n = ds.t.length, t = ds.t, flags = [], i;
        var qm = [], qfb = [];
        for (i = 0; i < n; i++) {
            var qq = ds.q && _fin(ds.q[i]) ? ds.q[i] / 1440 : 0;
            qm.push(qq > 0 ? qq : 0);
            qfb.push(ds.qFb && _fin(ds.qFb[i]) && ds.qFb[i] > 0 ? ds.qFb[i] / 1440 : 0);
        }
        if (!ds.q) flags.push(_warn('NO_RATE', 'info', 'No rate channel: pipe friction and the column displacement are not applied.'));
        // events
        var qMax = 0; for (i = 0; i < n; i++) if (qm[i] > qMax) qMax = qm[i];
        var ts = _num(ctx.ts, null);
        if (!_fin(ts)) { ts = null; for (i = n - 1; i >= 0; i--) if (qm[i] > 0.05 * qMax && qMax > 0) { ts = i + 1 < n ? t[i + 1] : t[i]; break; } }
        var Vcum = [0];
        for (i = 1; i < n; i++) Vcum.push(Vcum[i - 1] + 0.5 * (qm[i] + qm[i - 1]) * (t[i] - t[i - 1]) * 60);
        var Vinj = _num(ctx.Vinj, _fin(ts) ? _interp1(t, Vcum, ts) : Vcum[n - 1]);
        if (!_fin(ts)) ts = t[0];
        // p nodes
        var pMin = Infinity, pMax = -Infinity;
        for (i = 0; i < n; i++) if (_fin(ps[i])) { if (ps[i] < pMin) pMin = ps[i]; if (ps[i] > pMax) pMax = ps[i]; }
        if (!_fin(pMin)) return _fail('NO_SURFACE', 'The surface-pressure channel has no finite sample.', ['pSurf']);
        var pN = [];
        var lo = Math.max(pMin, 0.1);
        if (pMax - lo < 1) pN = [lo, lo + 1];
        else for (var k = 0; k < 5; k++) pN.push(lo + (pMax - lo) * k / 4);
        var noteRange = null, rangeHit = false;
        var cache = {};
        function hydroTable(Tf, fluidX) {
            var out = [];
            for (var j = 0; j < pN.length; j++) {
                var h = hydrostatic(pN[j], gaugeTvd, datum, c, Tf, { fluid: fluidX, stepFt: 25 });
                if (h.rangeNote) { rangeHit = true; noteRange = h.rangeNote; }
                out.push(h.p - pN[j]);
            }
            return out;
        }
        function pipeQ(q, scale, fluidX) {
            if (!(q > 0) || !c.segments.length) return 0;
            var key = q.toFixed(5) + '|' + scale + '|' + fluidX.rhoPpg;
            if (cache[key] == null) {
                var r = pipeDp(q, c, fluidX, tempProfile(c, { model: 'static' }).T);
                cache[key] = r.ok ? r.dp * scale : 0;
            }
            return cache[key];
        }
        var fricBand = fl.nPrime && fl.kPrime ? 0.30 : (fl.fr > 0 || fl.kind === 'slickwater' ? 0.25 : 0.10);
        var sd = ctx.stepDown || ctx.nwb || null;
        var perfs = ctx.perfs || null;
        var tables = {};   // column tables depend only on the density and the temperature model: shared by the band runs
        function tablesFor(P, fluidX) {
            var key = P.drho + '|' + P.model;
            if (tables[key]) return tables[key];
            var geoT = tempProfile(c, { model: 'static', surfF: temp.surfF, gradFper100: temp.gradFper100 }).T;
            var out = { dpGeo: hydroTable(geoT, fluidX), vdN: null, dpDisp: null };
            if (P.model === 'displaced') {
                out.vdN = []; out.dpDisp = [];
                (t[0] < ts ? [0, 0.25, 0.5, 0.75, 1] : [1]).forEach(function (f) {
                    var V = f * Vinj;
                    out.vdN.push(V);
                    var prof = tempProfile(c, { model: 'displaced', surfF: temp.surfF, gradFper100: temp.gradFper100, tInjF: fluidX.tInjF, Vinj: V, t: 0 });
                    out.dpDisp.push(hydroTable(prof.T, fluidX));
                });
            }
            tables[key] = out;
            return out;
        }
        function once(P) {
            var fluidX = _fluid(fl);
            if (P.drho) { fluidX.rhoPpg = fl.rhoPpg + P.drho; fluidX.S = salinityFromPpg(fluidX.rhoPpg); }
            var TB = tablesFor(P, fluidX), dpGeo = TB.dpGeo, vdN = TB.vdN, dpDisp = TB.dpDisp, tau = P.tau;
            var pw = [], hyd = [], pipe = [], perf = [], nwb = [];
            for (var ii = 0; ii < n; ii++) {
                var p0 = ps[ii];
                if (!_fin(p0)) { pw.push(null); hyd.push(null); pipe.push(null); perf.push(null); nwb.push(null); continue; }
                var hg = _interpQ(pN, dpGeo, p0), hv = hg;
                if (dpDisp) {
                    var vd = t[ii] < ts ? Vcum[ii] : Vinj, rr = t[ii] <= ts ? 1 : Math.exp(-(t[ii] - ts) / tau);
                    var col0 = [];
                    for (var jj = 0; jj < dpDisp.length; jj++) col0.push(_interpQ(pN, dpDisp[jj], p0));
                    var hd = vdN.length > 1 ? _interp1(vdN, col0, vd) : col0[0];
                    hv = hg + rr * (hd - hg);
                }
                var fr0 = qm[ii] > 0 ? -pipeQ(qm[ii], P.fric, fluidX) : (qfb[ii] > 0 ? pipeQ(qfb[ii], P.fric, fluidX) : 0);
                // perforation and near-wellbore terms: + while injecting (p_f = p_w − Δp), − during flowback (p_f = p_w + Δp(q_fb), §4.2, §4.16)
                var qx = qm[ii] > 0 ? qm[ii] : (qfb[ii] > 0 ? qfb[ii] : 0), sgn = qm[ii] > 0 ? 1 : -1;
                var pf = 0, nw = 0;
                if (qx > 0) {
                    var pfr = perfs && _fin(perfs.n) ? perfFriction(qx, { n: perfs.n, dIn: (perfs.dIn || 0.4) * P.dScale, cd: P.cd != null ? P.cd : perfs.cd }, fluidX.rhoPpg)
                        : (sd && _fin(sd.a) ? sd.a * qx * qx * (P.aScale || 1) : 0);
                    pf = sgn * (_fin(pfr) ? pfr : 0);
                    nw = sgn * (sd && _fin(sd.b) ? nwbLoss(qx, { b: sd.b + (P.db || 0), beta: _num(sd.beta, 0.5), qt: _num(sd.qt, 0.1) }) : 0);
                }
                hyd.push(hv); pipe.push(fr0); perf.push(pf); nwb.push(nw);
                pw.push(p0 + hv + fr0);
            }
            return { pw: pw, hyd: hyd, pipe: pipe, perf: perf, nwb: nwb };
        }
        var tauMid = Math.sqrt(_num(temp.tauLoH, 0.5) * _num(temp.tauHiH, 5));
        var cdBase = perfs && _fin(perfs.cd) ? perfs.cd : 0.62;
        var B0 = { model: tModel, tau: tauMid, fric: 1, drho: 0, dScale: 1, cd: cdBase, db: 0 };
        var base = once(B0);
        // vacuum: surface ≤ 0 psig → masked from then on
        var vacuumAt = null, warnAt = null;
        for (i = 0; i < n; i++) {
            if (!_fin(ps[i])) continue;
            if (ps[i] - atm < 15 && warnAt == null && t[i] >= ts) warnAt = t[i];
            if (ps[i] - atm <= 0 && t[i] >= ts) { vacuumAt = t[i]; break; }
        }
        if (vacuumAt != null) {
            flags.push(_warn('VACUUM', 'bad', 'The surface pressure reached 0 psig at ' + _f(vacuumAt, 2) + ' h: the column is no longer liquid-supported, so converted data after that time are masked (after-closure analysis needs a bottomhole gauge).'));
        } else if (warnAt != null) {
            flags.push(_warn('VACUUM_WARN', 'warn', 'The surface pressure fell below 15 psig at ' + _f(warnAt, 2) + ' h: the conversion is close to the vacuum limit.'));
        }
        if (rangeHit && noteRange) flags.push(_warn('CONVERT_RANGE', 'info', noteRange));
        var pfArr = [];
        for (i = 0; i < n; i++) {
            if (vacuumAt != null && t[i] >= vacuumAt) { base.pw[i] = null; }
            pfArr.push(base.pw[i] == null ? null : base.pw[i] - base.perf[i] - base.nwb[i]);
        }
        // index of the last pumping sample (shut-in)
        var iS = 0; for (i = 0; i < n; i++) if (t[i] < ts) iS = i;
        var terms = [{ name: 'hydrostatic', dpAtShutIn: _nn(base.hyd[iS]) }, { name: 'pipe friction', dpAtShutIn: _nn(base.pipe[iS]) },
                     { name: 'perforation friction', dpAtShutIn: _nn(base.perf[iS]) }, { name: 'near-wellbore loss', dpAtShutIn: _nn(base.nwb[iS]) }];
        var band = null, bandF = null, bandTerms = [];
        if (o.band) {
            var devW = [], devF = [];
            function addDev(name, alt, affectsW) {
                var dW = [], dF = [], mx = 0;
                for (var ii = 0; ii < n; ii++) {
                    if (base.pw[ii] == null || alt.pw[ii] == null) { dW.push(0); dF.push(0); continue; }
                    var w1 = alt.pw[ii] - base.pw[ii];
                    var f1 = (alt.pw[ii] - alt.perf[ii] - alt.nwb[ii]) - pfArr[ii];
                    dW.push(affectsW ? w1 : 0); dF.push(f1);
                }
                mx = Math.abs(dF[iS] || 0);
                if (affectsW) devW.push(dW);
                devF.push(dF);
                bandTerms.push({ name: name, dpAtShutIn: mx });
            }
            addDev('fluid density ±0.05 ppg', once(Object.assign({}, B0, { drho: 0.05 })), true);
            addDev('temperature model', once(Object.assign({}, B0, { model: tModel === 'displaced' ? 'static' : 'displaced' })), true);
            if (tModel === 'displaced') {
                var aLo = once(Object.assign({}, B0, { tau: _num(temp.tauLoH, 0.5) })), aHi = once(Object.assign({}, B0, { tau: _num(temp.tauHiH, 5) }));
                var pick = aLo;
                var sLo = 0, sHi = 0;
                for (i = 0; i < n; i++) if (base.pw[i] != null && aLo.pw[i] != null && aHi.pw[i] != null) { sLo += Math.abs(aLo.pw[i] - base.pw[i]); sHi += Math.abs(aHi.pw[i] - base.pw[i]); }
                if (sHi > sLo) pick = aHi;
                addDev('temperature relaxation time', pick, true);
            }
            if (c.segments.length && ds.q) addDev('pipe friction ±' + Math.round(fricBand * 100) + ' %', once(Object.assign({}, B0, { fric: 1 + fricBand })), true);
            if (perfs && _fin(perfs.n)) {
                addDev('perforation discharge coefficient', once(Object.assign({}, B0, { cd: cdBase + 0.04 })), false);
                addDev('perforation diameter ±8 %', once(Object.assign({}, B0, { dScale: 1.08 })), false);
            }
            if (sd && _fin(sd.b) && sd.se && _fin(sd.se.b)) addDev('near-wellbore coefficient b', once(Object.assign({}, B0, { db: sd.se.b })), false);
            band = { p10: [], p90: [] }; bandF = { p10: [], p90: [] };
            for (i = 0; i < n; i++) {
                if (base.pw[i] == null) { band.p10.push(null); band.p90.push(null); bandF.p10.push(null); bandF.p90.push(null); continue; }
                var sw = 0, sf = 0, j;
                for (j = 0; j < devW.length; j++) sw += devW[j][i] * devW[j][i];
                for (j = 0; j < devF.length; j++) sf += devF[j][i] * devF[j][i];
                sw = Math.sqrt(sw); sf = Math.sqrt(sf);
                band.p10.push(base.pw[i] - Z1281 * sw); band.p90.push(base.pw[i] + Z1281 * sw);
                bandF.p10.push(pfArr[i] - Z1281 * sf); bandF.p90.push(pfArr[i] + Z1281 * sf);
            }
        }
        return { ok: true, pw: base.pw, pf: pfArr, parts: { hyd: base.hyd, pipe: base.pipe, perf: base.perf, nwb: base.nwb }, band: band, bandF: bandF,
                 terms: terms, bandTerms: bandTerms, flags: flags, vacuumAt: vacuumAt, model: tModel, ts: ts, Vinj: Vinj };
    }

    // ── vacuum predictor (§4.2) ──────────────────────────────────────────────
    function vacuum(piPsia, col, T, atm) {
        var c = _col(col);
        if (!c) return _fail('NO_COLUMN', 'The vacuum check needs the wellbore column.', ['column']);
        var pi = _num(piPsia, NaN);
        if (!(pi > 0)) return _fail('BAD_INPUT', 'The vacuum check needs the reservoir pressure.', ['pi']);
        var a = _num(atm, 14.696);
        var h = hydrostatic(pi, c.datumTvd, 0, c, T);
        if (!h.ok) return h;
        var ps = h.p, g = ps - a, risk = g < 15 ? 'surface-zero' : 'none', level = g < 0 ? 'fail' : (g < 15 ? 'warn' : 'ok');
        var text = level === 'ok' ? 'At p_i the surface pressure stays at ' + _f(ps, 1) + ' psia: the column stays liquid-supported and a surface gauge can follow the falloff.'
            : (level === 'warn' ? 'At p_i the surface pressure would be only ' + _f(g, 1) + ' psig: the surface gauge will be near the vacuum limit late in the falloff.'
            : 'At p_i the column cannot be liquid-supported (surface ' + _f(g, 1) + ' psig): the surface gauge goes to vacuum before p_i, so after-closure analysis needs a bottomhole gauge.');
        return { ok: true, risk: risk, level: level, pSurfAtPi: ps, text: text };
    }

    // ── step-down (§4.14) ────────────────────────────────────────────────────
    function _sdCols(q, beta, hasDrift, dt) { var r = [1, q * q, Math.pow(q, beta)]; if (hasDrift) r.push(dt); return r; }
    function stepDownDesignCheck(steps, opts) {
        var o = opts || {}, sig = _num(o.sigma, 2), beta = _num(o.beta, 0.5);
        var qs = (Array.isArray(steps) ? steps : []).map(function (s) { return _num(s && s.q != null ? s.q : s, NaN); }).filter(function (q) { return q > 0; });
        var se = { pFrac: null, a: null, b: null };
        if (qs.length >= 3) {
            var r = _lsq(qs.map(function (q) { return _sdCols(q, beta, false, 0); }), qs.map(function () { return 0; }));
            if (r) se = { pFrac: sig * Math.sqrt(r.inv[0][0]), a: sig * Math.sqrt(r.inv[1][1]), b: sig * Math.sqrt(r.inv[2][2]) };
        }
        var qMax = qs.length ? Math.max.apply(null, qs) : 0, qMin = qs.length ? Math.min.apply(null, qs) : 0;
        var range = qMax > 0 ? (qMax - qMin) / qMax : 0, why = null;
        if (qs.length < 3) why = 'A step-down needs at least three rate steps to split perforation and near-wellbore friction.';
        else if (range < 0.3) why = 'The rate range is only ' + Math.round(range * 100) + ' % of the top rate (at least 30 % is needed): the split is not identifiable' + (_fin(se.pFrac) ? ' (standard error of the intercept ' + _f(se.pFrac, 0) + ' psi).' : '.');
        if (why) return { ok: false, code: 'REFUSED', errors: [why], bad: ['steps'], se: se, why: why, range: range, n: qs.length };
        return { ok: true, se: se, why: null, range: range, n: qs.length, sigma: sig };
    }
    function stepDown(steps, opts) {
        var o = opts || {};
        var st = (Array.isArray(steps) ? steps : []).filter(function (s) { return s && _fin(+s.q) && +s.q > 0 && _fin(+s.p); })
            .map(function (s) { return { q: +s.q, p: +s.p, n: _fin(+s.n) && +s.n > 0 ? +s.n : 1, t: _fin(+s.t) ? +s.t : null, sigma: _fin(+s.sigma) && +s.sigma > 0 ? +s.sigma : null }; });
        var sig = _num(o.sigma, 2);
        var chk = stepDownDesignCheck(st, { sigma: sig });
        var nullAt = { dpPerf: null, dpNwb: null, dpPipe: null };
        if (!chk.ok) {
            return { ok: true, pFrac: null, se: { pFrac: _nn(chk.se.pFrac), a: _nn(chk.se.a), b: _nn(chk.se.b) }, a: null, b: null, beta: 0.5, drift: 0, nOpen: null,
                     nOpenBand: { p10: null, p50: null, p90: null, driver: 'not determinable' }, at: nullAt, label: 'refused', refused: chk.why, resid: [], corr: null,
                     regime: null, notes: [], seed: _num(o.seed, 1), nMc: 0 };
        }
        var pipeFn = typeof o.pipe === 'function' ? o.pipe : null;
        var y = st.map(function (s) { var pp = pipeFn ? pipeFn(s.q) : 0; return s.p - (_fin(pp) ? pp : 0); });
        var w = st.map(function (s) { var sg = s.sigma != null ? s.sigma : sig; return s.n / (sg * sg); });
        var tLast = null; st.forEach(function (s) { if (s.t != null && (tLast == null || s.t > tLast)) tLast = s.t; });
        var hasDrift = o.drift !== false && st.every(function (s) { return s.t != null; }) && st.length >= 5;
        var notes = [];
        if (o.drift === true && !hasDrift) notes.push('The drift term needs five steps with times; it was not fitted.');
        function fitBeta(beta) {
            var X = st.map(function (s) { return _sdCols(s.q, beta, hasDrift, s.t != null ? s.t - tLast : 0); });
            return _lsq(X, y, w);
        }
        var beta = 0.5, best = fitBeta(0.5), betaCI = null;
        if (!best) return _fail('SINGULAR', 'The step-down fit is singular (repeated rates).', ['steps']);
        if (o.beta === 'free') {
            var bb = null, grid = [];
            for (var kb = 20; kb <= 100; kb++) { var bt = kb / 100, rr = fitBeta(bt); grid.push({ bt: bt, sse: rr ? rr.sse : Infinity }); if (rr && (!bb || rr.sse < bb.r.sse)) bb = { bt: bt, r: rr }; }
            if (bb) {
                var dof = Math.max(1, st.length - (hasDrift ? 5 : 4));
                var s2 = DCHI2_95 * Math.max(1, bb.r.sse / dof);       // profile Δχ² ≤ 3.84 (one parameter, 95 %), scaled by χ²_r
                var inC = grid.filter(function (g) { return g.sse <= bb.r.sse + s2; });
                var bLo = Math.min.apply(null, inC.map(function (g) { return g.bt; })), bHi = Math.max.apply(null, inC.map(function (g) { return g.bt; }));
                betaCI = [bLo, bHi];
                if ((bHi - bLo) / 2 <= 0.15) { beta = bb.bt; best = bb.r; }
                else notes.push('β is not determined by these steps (95 % range ' + _f(bLo, 2) + '–' + _f(bHi, 2) + '); β = 0.5 is used.');
            }
        } else if (_fin(o.beta) && o.beta > 0 && o.beta <= 1) { beta = o.beta; best = fitBeta(beta) || best; }
        var np = hasDrift ? 4 : 3, dofR = st.length - np;
        var chi2r = dofR > 0 ? best.sse / dofR : 0;
        var infl = Math.sqrt(Math.max(1, chi2r));
        var se = { pFrac: Math.sqrt(best.inv[0][0]) * infl, a: Math.sqrt(best.inv[1][1]) * infl, b: Math.sqrt(best.inv[2][2]) * infl };
        var pFrac = best.beta[0], a = best.beta[1], b = best.beta[2], drift = hasDrift ? best.beta[3] : 0;
        var resid = st.map(function (s, i) { return y[i] - best.fit[i]; });
        var corr = { ab: best.inv[1][2] / Math.sqrt(best.inv[1][1] * best.inv[2][2]), pa: best.inv[0][1] / Math.sqrt(best.inv[0][0] * best.inv[1][1]),
                     pb: best.inv[0][2] / Math.sqrt(best.inv[0][0] * best.inv[2][2]) };
        var qTop = Math.max.apply(null, st.map(function (s) { return s.q; }));
        var dpPerf = a * qTop * qTop, dpNwb = b * Math.pow(qTop, beta), dpPipe = pipeFn ? pipeFn(qTop) : null;
        // open perforations
        var perfs = o.perfs || {}, rho = _num(o.rhoPpg, 8.43), dIn = _num(perfs.dIn, 0.40), cd = _num(perfs.cd, 0.62);
        var nOpen = null, band = { p10: null, p50: null, p90: null, driver: 'not determinable' }, nText = null;
        var mcSeed = _num(o.seed, 1), nMc = 0;          // the open-perforation Monte Carlo (§3.0 determinism: the seed is returned)
        var pipeDominates = _fin(dpPipe) && dpPipe > 3 * Math.max(dpPerf, 0);
        if (pipeDominates) {
            nText = 'not determinable';
            band.driver = 'not determinable: pipe friction at the top rate (' + _f(dpPipe, 0) + ' psi) exceeds three times the perforation term';
            notes.push('Open perforations are not determinable: the pipe friction at the top rate is more than three times the perforation friction, and the two terms correlate (r ≈ 0.999).');
        } else if (a > 0) {
            nOpen = Math.sqrt(PERF_C * rho / (a * Math.pow(dIn, 4) * cd * cd));
            var N = Math.max(500, Math.min(50000, _num(o.nMc, 20000) | 0)), arr = [], z = _normals(mcSeed, 3 * N);
            nMc = N;
            var cdM = _num(o.cdMean, 0.62), cdS = _num(o.cdSd, 0.04);
            for (var k2 = 0; k2 < N; k2++) {
                var cdk = Math.min(0.95, Math.max(0.5, cdM + cdS * z[3 * k2]));
                var dk = dIn * (1 + 0.08 * z[3 * k2 + 1]);
                var ak = Math.max(0.05, a + se.a * z[3 * k2 + 2]);
                arr.push(Math.sqrt(PERF_C * rho / (ak * Math.pow(dk, 4) * cdk * cdk)));
            }
            arr.sort(function (x1, x2) { return x1 - x2; });
            var cA = 0.5 * se.a / a, cD = 2 * 0.08, cC = cdS / cdM;
            var drv = (cD >= cA && cD >= cC) ? 'perforation entrance-hole diameter (d⁴)' : (cA >= cC ? 'perforation coefficient a of the fit' : 'perforation discharge coefficient');
            band = { p10: _pct(arr, 0.1), p50: _pct(arr, 0.5), p90: _pct(arr, 0.9), driver: drv };
        } else {
            nText = 'not determinable';
            notes.push('The perforation coefficient a is not positive: the pipe friction may be overestimated.');
        }
        // connection regime and label
        var invalid = a < 0 || b < 0 || resid.some(function (r, i) { return Math.abs(r) > 3 * Math.sqrt(1 / w[i]) * Math.max(1, infl); });
        var regime;
        if (invalid) regime = 'fit invalid';
        else if (dpPerf + dpNwb < 100) regime = 'good connection';
        else if (dpPerf > 200 && dpNwb > 200) regime = 'mixed';
        else if (dpNwb > 200 && dpNwb > 2 * dpPerf) regime = 'tortuosity dominated';
        else if (dpPerf > 2 * dpNwb && _fin(perfs.n) && _fin(band.p90) && band.p90 < 0.5 * perfs.n) regime = 'perforation limited';
        else regime = 'mixed';
        var label = invalid ? 'low' : (se.pFrac <= 15 ? 'high' : (se.pFrac <= 40 ? 'medium' : 'low'));
        notes.push('The in-fracture viscous term (∝ q^¼) aliases into b·q^½; p_frac is the fracture-entrance pressure.');
        return { ok: true, pFrac: pFrac, se: se, a: a, b: b, beta: beta, drift: drift, nOpen: _nn(nOpen),
                 nOpenBand: { p10: _nn(band.p10), p50: _nn(band.p50), p90: _nn(band.p90), driver: band.driver }, nOpenText: nText,
                 at: { dpPerf: dpPerf, dpNwb: dpNwb, dpPipe: _nn(dpPipe) }, label: label, refused: null, resid: resid, corr: corr,
                 regime: regime, betaCI: betaCI, chi2r: chi2r, notes: notes, seed: mcSeed, nMc: nMc };
    }

    // ── shared hinge (step-rate §4.15, ramp §4.15b): y = α + b1·min(x, x*) + b2·max(0, x − x*) ──
    function _hingeCore(x, y, w, nGrid) {
        var n = x.length, i;
        var x0 = x[0], xs = (x[n - 1] - x[0]) || 1, ym = 0, ws = 0;
        for (i = 0; i < n; i++) { ym += w[i] * y[i]; ws += w[i]; }
        ym /= ws;
        var FA = (typeof Float64Array === 'function') ? Float64Array : Array;
        var X = new FA(n), c = new FA(n + 1), cx = new FA(n + 1), cxx = new FA(n + 1), cy = new FA(n + 1), cxy = new FA(n + 1), cyy = new FA(n + 1);
        c[0] = cx[0] = cxx[0] = cy[0] = cxy[0] = cyy[0] = 0;
        for (i = 0; i < n; i++) {
            var Xi = (x[i] - x0) / xs, Yi = y[i] - ym, wi = w[i];
            X[i] = Xi;
            c[i + 1] = c[i] + wi; cx[i + 1] = cx[i] + wi * Xi; cxx[i + 1] = cxx[i] + wi * Xi * Xi;
            cy[i + 1] = cy[i] + wi * Yi; cxy[i + 1] = cxy[i] + wi * Xi * Yi; cyy[i + 1] = cyy[i] + wi * Yi * Yi;
        }
        var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rhs = [0, 0, 0];
        // single line in the scaled coordinates (for the F-test)
        var dL = c[n] * cxx[n] - cx[n] * cx[n];
        var lb = dL > 0 ? (c[n] * cxy[n] - cx[n] * cy[n]) / dL : 0, la = (cy[n] - lb * cx[n]) / c[n];
        var sse1 = Math.max(0, cyy[n] - la * cy[n] - lb * cxy[n]);
        function fitAt(qs) {
            // split index k = number of X ≤ qs (binary search)
            var lo = 0, hi = n;
            while (lo < hi) { var m = (lo + hi) >> 1; if (X[m] <= qs) lo = m + 1; else hi = m; }
            var k = lo;
            var nL = c[k], SxL = cx[k], SxxL = cxx[k], SyL = cy[k], SxyL = cxy[k];
            var nR = c[n] - nL, SxR = cx[n] - SxL, SxxR = cxx[n] - SxxL, SyR = cy[n] - SyL, SxyR = cxy[n] - SxyL;
            var Su = SxL + nR * qs, Suu = SxxL + nR * qs * qs, Sv = SxR - nR * qs, Svv = SxxR - 2 * qs * SxR + nR * qs * qs, Suv = qs * Sv;
            var Sy = cy[n], Suy = SxyL + qs * SyR, Svy = SxyR - qs * SyR;
            A[0][0] = c[n]; A[0][1] = Su; A[0][2] = Sv; A[1][1] = Suu; A[1][2] = Suv; A[2][2] = Svv;
            rhs[0] = Sy; rhs[1] = Suy; rhs[2] = Svy;
            var beta = _solve3(A, rhs);
            if (!beta) return null;
            var sse = cyy[n] - (beta[0] * Sy + beta[1] * Suy + beta[2] * Svy);
            return { qs: qs, beta: beta, sse: Math.max(0, sse), k: k };
        }
        return { fitAt: fitAt, X: X, x0: x0, xs: xs, ym: ym, sse1: sse1, syy: cyy[n], line: { a: ym + la - lb / xs * x0, b: lb / xs } };
    }
    // x ascending; w weights (optional); opts {lo, hi} index-based scan range (default 2nd .. 2nd-to-last point)
    function hinge(x, y, w, opts) {
        var o = opts || {}, n = x.length, i;
        if (n < 4) return null;
        if (!w) { w = []; for (i = 0; i < n; i++) w.push(1); }
        var core = _hingeCore(x, y, w);
        var X = core.X, loX = X[_num(o.iLo, 1)], hiX = X[n - 1 - _num(o.iHiBack, 1)];
        if (_fin(o.xLo)) loX = Math.max(loX, (o.xLo - core.x0) / core.xs);
        if (_fin(o.xHi)) hiX = Math.min(hiX, (o.xHi - core.x0) / core.xs);
        if (!(hiX > loX)) return null;
        var nG = _num(o.nGrid, 256), bestF = null, bestI = -1, cand = [];
        for (i = 0; i <= nG; i++) cand.push(loX + (hiX - loX) * i / nG);
        for (i = 0; i < n; i++) if (X[i] > loX && X[i] < hiX && (o.nGrid == null || n <= 600)) cand.push(X[i]);
        cand.sort(function (a, b) { return a - b; });
        for (i = 0; i < cand.length; i++) { var f = core.fitAt(cand[i]); if (f && (!bestF || f.sse < bestF.sse)) { bestF = f; bestI = i; } }
        if (!bestF) return null;
        // golden-section refine between the neighbours
        var a0 = cand[Math.max(0, bestI - 1)], b0 = cand[Math.min(cand.length - 1, bestI + 1)], gr = 0.6180339887;
        var c1 = b0 - gr * (b0 - a0), c2 = a0 + gr * (b0 - a0), f1 = core.fitAt(c1), f2 = core.fitAt(c2);
        for (var it = 0; it < 40 && f1 && f2; it++) {
            if (f1.sse < f2.sse) { b0 = c2; c2 = c1; f2 = f1; c1 = b0 - gr * (b0 - a0); f1 = core.fitAt(c1); }
            else { a0 = c1; c1 = c2; f1 = f2; c2 = a0 + gr * (b0 - a0); f2 = core.fitAt(c2); }
        }
        [f1, f2].forEach(function (ff) { if (ff && ff.sse < bestF.sse) bestF = ff; });
        // back to physical units
        var qStar = core.x0 + bestF.qs * core.xs;
        var b1 = bestF.beta[1] / core.xs, b2 = bestF.beta[2] / core.xs;
        var alpha = core.ym + bestF.beta[0] - b1 * core.x0;   // y = α + b1·min(x,x*) + b2·max(0,x−x*), α at x = 0
        // single line
        // round-off floor: an exact line must not produce a break from rounding noise
        var floor = 1e-10 * core.syy + n * Math.pow(1e-9 * (Math.abs(core.ym) + Math.abs(y[n - 1] - y[0]) + 1), 2);
        var sse1 = Math.max(core.sse1, floor), sse2 = Math.max(bestF.sse, floor), d2 = n - 4;
        var F = d2 > 0 ? Math.max(0, (sse1 - sse2) / 2) / (sse2 / d2) : 0;
        if (!(F >= 0)) F = 0;
        var pF = d2 > 0 ? Math.pow(1 + 2 * F / d2, -d2 / 2) : 1;
        var fitFn = function (v) { return alpha + b1 * Math.min(v, qStar) + b2 * Math.max(0, v - qStar); };
        return { qStar: qStar, alpha: alpha, b1: b1, b2: b2, sse: sse2, sse1: sse1, F: F, p: Math.min(1, Math.max(0, pF)),
                 breakFound: d2 > 0 && pF < 0.05 && b2 < b1, yStar: fitFn(qStar), fit: fitFn, line: core.line };
    }
    function _bootHinge(x, y, h, nBoot, seed, hopts) {
        var rng = _rng(seed), res = [], i, n = x.length;
        for (i = 0; i < n; i++) res.push(y[i] - h.fit(x[i]));
        var ys = [], qs = [], fx = [];
        for (i = 0; i < n; i++) fx.push(h.fit(x[i]));
        var yb = (typeof Float64Array === 'function') ? new Float64Array(n) : new Array(n);
        // resample indices from an inline xorshift32 stream seeded by the seeded generator (no call per draw)
        var xs32 = ((rng() * 4294967296) >>> 0) || 2463534242;
        for (var r = 0; r < nBoot; r++) {
            for (i = 0; i < n; i++) {
                xs32 ^= xs32 << 13; xs32 >>>= 0; xs32 ^= xs32 >>> 17; xs32 ^= xs32 << 5; xs32 >>>= 0;
                yb[i] = fx[i] + res[(xs32 % n)];
            }
            var hb = hinge(x, yb, null, hopts);
            if (hb) { ys.push(hb.yStar); qs.push(hb.qStar); }
        }
        ys.sort(function (a, b) { return a - b; }); qs.sort(function (a, b) { return a - b; });
        if (!ys.length) return null;
        return { y: { p10: _pct(ys, 0.1), p50: _pct(ys, 0.5), p90: _pct(ys, 0.9) }, x: { p10: _pct(qs, 0.1), p50: _pct(qs, 0.5), p90: _pct(qs, 0.9) }, n: ys.length };
    }

    // ── step-rate test (§4.15, 3.4a) ─────────────────────────────────────────
    function _slope(ts, ps) {
        var n = ts.length; if (n < 2) return 0;
        var mt = 0, mp = 0, i; for (i = 0; i < n; i++) { mt += ts[i]; mp += ps[i]; } mt /= n; mp /= n;
        var sxy = 0, sxx = 0; for (i = 0; i < n; i++) { sxy += (ts[i] - mt) * (ps[i] - mp); sxx += (ts[i] - mt) * (ts[i] - mt); }
        return sxx > 0 ? sxy / sxx : 0;
    }
    function stepRate(steps, a2, a3, a4) {
        var t = null, p = null, o;
        if (Array.isArray(a2)) { t = a2; p = a3; o = a4 || {}; } else { o = a2 || {}; t = o.t || null; p = o.p || null; }
        var stabFrac = _num(o.stabFrac, 0.3), stabPsi = _num(o.stabPsi, 5), stabRise = _num(o.stabRiseFrac, 0.1);
        var nBoot = Math.max(50, Math.min(5000, _num(o.nBoot, 500) | 0)), seed = _num(o.seed, 1);
        var dpdtMax = _fin(o.dpdtMax) && o.dpdtMax > 0 ? o.dpdtMax : null;
        var rows = [];
        (Array.isArray(steps) ? steps : []).forEach(function (s, i) {
            if (!s || !_fin(+s.q)) return;
            var q = +s.q, pEnd = _fin(+s.pEnd) ? +s.pEnd : null, dpdt = 0, stab = true, rise = null, pStart = null;
            if (pEnd == null && Array.isArray(t) && Array.isArray(p) && _fin(+s.t0) && _fin(+s.t1) && s.t1 > s.t0) {
                var tt = [], pp = [], j;
                for (j = 0; j < t.length; j++) if (t[j] >= s.t0 && t[j] <= s.t1 && _fin(p[j])) { tt.push(t[j]); pp.push(p[j]); }
                if (tt.length < 3) return;
                var cut = s.t1 - stabFrac * (s.t1 - s.t0), lt = [], lp = [];
                for (j = 0; j < tt.length; j++) if (tt[j] >= cut) { lt.push(tt[j]); lp.push(pp[j]); }
                if (lt.length < 2) { lt = tt.slice(-2); lp = pp.slice(-2); }
                pEnd = _median(lp); dpdt = _slope(lt, lp); pStart = pp[0];
                var drift = Math.abs(dpdt) * (s.t1 - s.t0);
                rows.push({ q: q, pEnd: pEnd, dpdt: dpdt, stabilised: true, _drift: drift, _pStart: pStart, t0: +s.t0, t1: +s.t1, idx: i });
                return;
            }
            if (pEnd != null) rows.push({ q: q, pEnd: pEnd, dpdt: _num(s.dpdt, 0), stabilised: s.stabilised !== false, idx: i });
        });
        if (rows.length < 3) return _fail('TOO_FEW_STEPS', 'A step-rate test needs at least three steps with an end pressure.', ['steps']);
        // stabilisation (needs the previous step's end pressure)
        for (var r = 0; r < rows.length; r++) {
            var R = rows[r];
            if (R._drift != null) {
                var prev = r > 0 ? rows[r - 1].pEnd : R._pStart;
                var riseP = Math.abs(R.pEnd - prev);
                R.stabilised = R._drift < Math.max(stabPsi, stabRise * riseP);
            }
            // optional extra limit on the end-of-step slope (psi/h)
            if (dpdtMax != null && _fin(R.dpdt) && Math.abs(R.dpdt) > dpdtMax) R.stabilised = false;
        }
        var order = rows.slice().sort(function (a, b) { return a.q - b.q; });
        function solve(list) {
            var x = list.map(function (s) { return s.q; }), y = list.map(function (s) { return s.pEnd; });
            if (x.length < 5) return { h: null, x: x, y: y };
            return { h: hinge(x, y), x: x, y: y };
        }
        function pack(sol, seedX) {
            var h = sol.h;
            if (!h) return { qStar: null, fep: null, band: { p10: null, p50: null, p90: null }, qStarBand: null, b1: null, b2: null, fTest: { F: 0, p: 1 }, breakFound: false,
                             why: 'At least five steps are needed for the hinge fit and its F-test.' };
            var bt = h.breakFound ? _bootHinge(sol.x, sol.y, h, nBoot, seedX) : null;
            var why = h.breakFound ? null : (h.b2 >= h.b1 ? 'No break: the upper slope is not below the lower one (matrix convexity, plugging or rising friction).'
                : 'No break: a single line fits as well (F-test p = ' + _f(h.p, 3) + ').');
            var nb = { p10: null, p50: null, p90: null };
            return { qStar: h.breakFound ? h.qStar : null, fep: h.breakFound ? h.yStar : null, band: bt ? bt.y : nb, qStarBand: bt ? bt.x : null,
                     b1: h.b1, b2: h.b2, fTest: { F: h.F, p: h.p }, breakFound: h.breakFound, why: why, alpha: h.alpha };
        }
        var all = pack(solve(order), seed);
        var unst = order.filter(function (s) { return !s.stabilised; });
        var stableOnly = null;
        if (unst.length) {
            stableOnly = pack(solve(order.filter(function (s) { return s.stabilised; })), seed);
            stableOnly.excluded = unst.map(function (s) { return s.q; });
        }
        var why = all.why;
        if (unst.length) why = (why ? why + ' ' : '') + unst.length + ' step' + (unst.length > 1 ? 's are' : ' is') + ' not stabilised (drawn hollow); the band is also given without ' + (unst.length > 1 ? 'them' : 'it') + '.';
        return { ok: true, qStar: _nn(all.qStar), fep: _nn(all.fep), band: all.band, qStarBand: all.qStarBand, b1: _nn(all.b1), b2: _nn(all.b2),
                 fTest: { F: _nn(all.fTest.F), p: _nn(all.fTest.p) }, breakFound: all.breakFound,
                 steps: rows.map(function (s) { return { q: s.q, pEnd: s.pEnd, dpdt: s.dpdt, stabilised: s.stabilised }; }),
                 stableOnly: stableOnly, why: why ? why.slice(0, 299) : null, seed: seed, nBoot: nBoot };
    }

    // ── pump-in ramp analyser (§4.15b) ───────────────────────────────────────
    function ramp(t, p, q, win, opts) {
        var o = opts || {};
        var kind = (o.kind === 'reopening' || o.kind === 'lot' || o.kind === 'pump-in') ? o.kind : 'pre-breakdown';
        if (!Array.isArray(t) || !Array.isArray(p) || t.length !== p.length) return _fail('BAD_INPUT', 'The ramp needs time and pressure arrays of one length.', ['t', 'p']);
        var t0 = -Infinity, t1 = Infinity;
        if (Array.isArray(win)) { t0 = _num(win[0], t0); t1 = _num(win[1], t1); } else if (win) { t0 = _num(win.t0, t0); t1 = _num(win.t1, t1); }
        var qScale = o.qUnit === 'bbl/d' ? 1 / 1440 : 1;
        var tt = [], pp = [], qq = [], i;
        for (i = 0; i < t.length; i++) {
            if (!(t[i] >= t0 && t[i] <= t1) || !_fin(p[i])) continue;
            var qi = Array.isArray(q) ? q[i] : q;
            if (!_fin(qi)) continue;
            tt.push(t[i]); pp.push(p[i]); qq.push(qi * qScale);
        }
        if (tt.length < 8) return _fail('TOO_FEW_POINTS', 'The ramp window holds fewer than eight samples.', ['win']);
        var V = [0];
        for (i = 1; i < tt.length; i++) V.push(V[i - 1] + 0.5 * (qq[i] + qq[i - 1]) * (tt[i] - tt[i - 1]) * 60);
        if (!(V[V.length - 1] > 0)) return _fail('NO_VOLUME', 'No volume was pumped in the ramp window.', ['q']);
        var qRamp = _median(qq);
        var h = hinge(V, pp, null, { iLo: Math.max(2, Math.floor(0.03 * V.length)), iHiBack: Math.max(2, Math.floor(0.03 * V.length)), nGrid: 256 });
        var line = _lsq(V.map(function (v) { return [1, v]; }), pp);
        var knee = null, band = null, s1, s2 = null, stiff = null, label, why = null;
        var hasKnee = h && h.breakFound && h.b1 > 0;
        var rampBoot = Math.max(50, Math.min(2000, _num(o.nBoot, 500) | 0)), rampSeed = _num(o.seed, 1);
        if (hasKnee) {
            s1 = h.b1; s2 = h.b2;
            stiff = s2 > 0 ? s1 / s2 : null;
            knee = { p: h.yStar, V: h.qStar, t: _interp1(V, tt, h.qStar) };
            var bt = _bootHinge(V, pp, h, rampBoot, rampSeed,
                { iLo: Math.max(2, Math.floor(0.03 * V.length)), iHiBack: Math.max(2, Math.floor(0.03 * V.length)), nGrid: 48,
                  xLo: h.qStar - 0.25 * V[V.length - 1], xHi: h.qStar + 0.25 * V[V.length - 1] });
            band = bt ? bt.y : null;
            label = (stiff != null && stiff < 1.2) ? 'low visibility' : 'knee';
        } else {
            s1 = line ? line.beta[1] : null;
            label = 'no knee';
            why = 'No knee: one straight line describes the ramp (F-test).';
        }
        // σ from the s1 segment, onset = first of three consecutive points 3σ below the s1 line
        var aLine = hasKnee ? h.alpha : (line ? line.beta[0] : 0), sL = s1;
        var rs = [];
        for (i = 0; i < V.length; i++) if (!hasKnee || V[i] <= knee.V) rs.push(pp[i] - (aLine + sL * V[i]));
        var sig = 1.4826 * _median(rs.map(function (r) { return Math.abs(r - _median(rs)); }));
        if (!(sig > 0)) sig = 1e-6;
        var onset = null, run = 0;
        for (i = 0; i < V.length; i++) {
            var dv = pp[i] - (aLine + sL * V[i]);
            if (dv < -3 * sig) { run++; if (run === 3) { var j0 = i - 2; onset = { p: pp[j0], V: V[j0], t: tt[j0] }; break; } } else run = 0;
        }
        var nwbCorr = null;
        var sd = o.stepDown || null;
        if (sd && (_fin(sd.a) || _fin(sd.b))) {
            nwbCorr = (_fin(sd.a) ? sd.a * qRamp * qRamp : 0) + (_fin(sd.b) ? nwbLoss(qRamp, { b: sd.b, beta: _num(sd.beta, 0.5), qt: _num(sd.qt, 0.1) }) : 0);
            if (knee) knee.pCorr = knee.p - nwbCorr;
        } else if (knee && kind === 'reopening') {
            why = 'Reopening reads high by the near-wellbore loss (no step-down to correct it): an upper bound on closure.';
        }
        var VwCwRamp = s1 > 0 ? 1 / s1 : null;
        // opts.VwCw (bbl/psi, the theory value of csys): storage ratio ramp / theory (> 2 → air or gas in the column, triage §6.3)
        var VCth = _fin(o.VwCw) && o.VwCw > 0 ? o.VwCw : null;
        return { ok: true, kind: kind, VwCwRamp: _nn(VwCwRamp), knee: knee, band: band, slopes: { s1: _nn(s1), s2: _nn(s2) }, stiffRatio: _nn(stiff),
                 nwbCorr: _nn(nwbCorr), label: label, why: why, onset: onset, sigma: sig, qRamp: qRamp, fTest: h ? { F: h.F, p: h.p } : null,
                 AfCf: (hasKnee && s2 > 0 && s1 > 0) ? (1 / s2 - 1 / s1) : null,
                 storageRatio: (VCth && _fin(VwCwRamp)) ? VwCwRamp / VCth : null, VwCwTheory: VCth,
                 seed: rampSeed, nBoot: hasKnee ? rampBoot : 0 };
    }

    // ── water hammer (§4.17, §4.4 item 1) ────────────────────────────────────
    function vwcwFromPeriod(T, L, Aft2, rhoPpg, mode) {
        if (!(T > 0 && L > 0 && Aft2 > 0)) return null;
        var c = (mode === 'half' ? 2 : 4) * L / T, rho = _num(rhoPpg, 8.43) * SLUG_PER_PPG;
        return L * Aft2 * 144 / (rho * c * c) / BBL;
    }
    function _gHalf(dtD) {
        if (!(dtD > 0)) return 0;
        var a = 1 + dtD;
        return (4 / Math.PI) * (a * Math.asin(1 / Math.sqrt(a)) + Math.sqrt(dtD) - Math.PI / 2);
    }
    function hammerQuick(tHz, p, ts, ctx) {
        var cx = ctx || {};
        if (!Array.isArray(tHz) || !Array.isArray(p) || tHz.length !== p.length) return _fail('BAD_INPUT', 'The high-rate window needs time and pressure arrays of one length.', ['tHz']);
        ts = _num(ts, NaN);
        if (!_fin(ts)) return _fail('BAD_INPUT', 'The shut-in time is needed.', ['ts']);
        var c = _col(cx.column);
        var fl = _fluid(cx.fluid || (c ? c.fluid : null));
        var cs = c ? csys(c, fl) : null;
        var cw = _fin(cx.c) && cx.c > 0 ? cx.c : (cs && cs.ok ? cs.waveSpeed : 4500);
        var cSource = cx.cCalibrated ? 'calibrated' : 'korteweg';
        // L = the expected reflector (a known packer / tubing tail / liner top when given, else the perforation datum): it sets the
        // sampling test and the period seed; the match is always reported against the perforation datum (Ld)
        var Lref = _fin(cx.reflectorMd) && cx.reflectorMd > 0 ? cx.reflectorMd : null;
        var Ld = c ? c.datumMd : Lref;
        var L = Lref || Ld;
        var tClose = Math.max(0, _num(cx.tClose, 0));            // s
        var winS = _num(cx.windowS, 60);
        var s = [], y = [], i;
        for (i = 0; i < tHz.length; i++) {
            var si = (tHz[i] - ts) * 3600;
            if (si > tClose && si <= tClose + winS && _fin(p[i])) { s.push(si); y.push(p[i]); }
        }
        var dts = []; for (i = 1; i < s.length; i++) dts.push(s[i] - s[i - 1]);
        var hz = dts.length ? 1 / _median(dts) : 0;
        var twoLc = L ? 2 * L / cw : null;
        var per2Lc = twoLc ? hz * twoLc : 0;
        var sampling = { hz: hz > 0 ? hz : 1e-6, per2Lc: per2Lc, ok: per2Lc >= 10 };
        if (!sampling.ok || s.length < 40) {
            var r0 = _fail('NOT_RESOLVABLE', 'Water hammer not resolvable: ' + (L ? 'fewer than 10 samples per 2L/c (' + _f(per2Lc, 1) + ').' : 'the reflector depth is unknown.'), ['tHz']);
            r0.sampling = sampling; r0.why = r0.errors[0];
            return r0;
        }
        // period seed: centred moving average over 4L/c removed, autocorrelation
        var n = s.length, dtS = 1 / hz;
        var W = Math.max(2, Math.round(2 * twoLc / dtS / 2));
        var cum = [0]; for (i = 0; i < n; i++) cum.push(cum[i] + y[i]);
        var d = [];
        for (i = 0; i < n; i++) { var a0 = Math.max(0, i - W), b0 = Math.min(n, i + W + 1); d.push(y[i] - (cum[b0] - cum[a0]) / (b0 - a0)); }
        var e0 = Math.min(n, Math.round(n - W)), st0 = Math.min(W, n >> 2);
        var lagLo = Math.max(2, Math.round(0.6 * twoLc / dtS)), lagHi = Math.min(n >> 1, Math.round(2.6 * twoLc / dtS));
        var ac = [], lag, bestLag = -1, bestR = -1;
        var den = 0; for (i = st0; i < e0; i++) den += d[i] * d[i];
        for (lag = lagLo; lag <= lagHi; lag++) {
            var num = 0; for (i = st0; i + lag < e0; i++) num += d[i] * d[i + lag];
            ac.push(den > 0 ? num / den : 0);
        }
        // the strongest peak; the quarter-wave (4L/c) peak is preferred when it is at least 80 % of a 2L/c peak
        for (i = 1; i + 1 < ac.length; i++) if (ac[i] >= ac[i - 1] && ac[i] >= ac[i + 1] && ac[i] > bestR) { bestR = ac[i]; bestLag = lagLo + i; }
        var T0 = bestLag > 0 ? bestLag * dtS : 2 * twoLc;
        if (bestLag > 0) {
            var k0 = bestLag - lagLo;
            if (k0 > 0 && k0 + 1 < ac.length) { var den2 = ac[k0 - 1] - 2 * ac[k0] + ac[k0 + 1]; if (den2 < 0) T0 = (bestLag + 0.5 * (ac[k0 - 1] - ac[k0 + 1]) / den2) * dtS; }
        }
        var tpH = _fin(cx.tp) && cx.tp > 0 ? cx.tp : null;
        var xS = s.map(function (v) { return tpH ? _gHalf(v / 3600 / tpH) : v / 60; });
        // bleed term
        var bl = cx.bleed || null, VC = _fin(cx.VwCw) ? cx.VwCw : (cs && cs.ok ? cs.VwCw : null);
        var q0 = _num(cx.qShut, NaN);
        // no step-down coefficients: fitBleed:true asks for a free fit of b from the default seed (b 100, β ½, q_t 0.1). It is opt-in
        // (a seed far from the truth costs LM iterations); otherwise the wave ISIP cannot be accepted (§4.4) and is an upper estimate
        var bleedSeeded = 'step-down';
        if (!(bl && _fin(bl.b) && bl.b > 0) && cx.fitBleed === true) { bl = { b: 100, beta: 0.5, qt: 0.1 }; bleedSeeded = 'default'; }
        var canBleed = !!(bl && _fin(bl.b) && bl.b > 0 && VC > 0 && q0 > 0);
        var fitBleed = canBleed && cx.fitBleed !== false;
        function bleedCurve(b) {
            var bo = bleedOff({ b: b, beta: _num(bl.beta, 0.5), qt: _num(bl.qt, 0.1), VwCw: VC, q0: q0 });
            return bo.ok ? bo : null;
        }
        function design(T, tau, b) {
            var bo = fitBleed ? bleedCurve(b) : null, cols = [];
            for (var k = 0; k < n; k++) {
                var e = Math.exp(-s[k] / tau), w = 2 * Math.PI * s[k] / T;
                var row = [1, -xS[k], e * Math.cos(w), -e * Math.sin(w)];
                cols.push({ row: row, bleed: bo ? bo.curve(s[k] / 3600) : 0 });
            }
            return cols;
        }
        function proj(theta) {
            var T = theta[0], tau = theta[1], b = fitBleed ? theta[2] : 0;
            var D = design(T, tau, b), X = [], yy = [];
            for (var k = 0; k < n; k++) { X.push(D[k].row); yy.push(y[k] - D[k].bleed); }
            var r = _lsq(X, yy);
            if (!r) return null;
            var res = []; for (k = 0; k < n; k++) res.push(yy[k] - r.fit[k]);
            return { lin: r.beta, res: res, sse: r.sse, D: D };
        }
        var th0 = [T0, 2 * T0], lo = [0.5 * T0, 0.2 * T0], hi = [2 * T0, 50 * T0], sc = [T0, T0];
        if (fitBleed) { th0.push(bl.b); lo.push(0.05 * bl.b); hi.push(20 * bl.b); sc.push(bl.b); }
        // τ seed grid
        var bestTh = th0, bestS = Infinity;
        [0.5, 1, 2, 4, 8].forEach(function (f) {
            var th = th0.slice(); th[1] = f * T0;
            var pr = proj(th);
            if (pr && pr.sse < bestS) { bestS = pr.sse; bestTh = th; }
        });
        var lm = _lmVec(function (th) { var pr = proj(th); return pr ? pr.res : [Infinity]; }, bestTh, lo, hi, { maxIter: 60, scale: sc });
        var fin = proj(lm.p);
        if (!fin) return _fail('FIT_FAILED', 'The water-hammer fit did not converge.', ['tHz']);
        var T = lm.p[0], tau = lm.p[1], bFit = fitBleed ? lm.p[2] : null;
        var isip = fin.lin[0], mG = fin.lin[1], ac0 = fin.lin[2], as0 = fin.lin[3];
        var A = Math.sqrt(ac0 * ac0 + as0 * as0), phi = Math.atan2(as0, ac0);
        var sigmaFit = Math.sqrt(fin.sse / Math.max(1, n - (fitBleed ? 7 : 6)));
        // gauge noise from second differences (independent of the model misfit): σ = 1.4826·MAD(Δ²p)/√6
        var d2 = []; for (i = 1; i + 1 < n; i++) d2.push(y[i + 1] - 2 * y[i] + y[i - 1]);
        var md2 = _median(d2), sigma = 1.4826 * _median(d2.map(function (v) { return Math.abs(v - md2); })) / Math.sqrt(6);
        if (!(sigma > 0)) sigma = sigmaFit;
        // acceptance of the wave ISIP (§4.4): bleed fitted, or predicted Δ at the window end below max(2 psi, 3σ)
        var dEnd = null, upper = false, whyB = null;
        if (fitBleed) { var bo2 = bleedCurve(bFit); dEnd = bo2 ? bo2.curve(s[n - 1] / 3600) : null; }
        else if (canBleed) {
            var bo3 = bleedCurve(bl.b); dEnd = bo3 ? bo3.curve(s[n - 1] / 3600) : null;
            if (dEnd != null && dEnd >= Math.max(2, 3 * sigma)) {
                upper = true;
                whyB = 'Upper estimate: the friction bleed-off is not in the fit and still ' + _f(dEnd, 1) + ' psi at the end of the window.';
            }
        } else {
            // §4.4: neither acceptance condition can be shown without the bleed-off law → upper estimate
            upper = true;
            whyB = 'Upper estimate: the friction bleed-off is not modelled (' + (!(bl && _fin(bl.b) && bl.b > 0) ? 'no step-down coefficients'
                : (!(q0 > 0) ? 'no shut-in rate' : 'no wellbore storage V_w·c_w')) + '), so a decaying bleed-off may still lift the midline.';
        }
        // regime and reflector. 'staircase': the fitted period is ≈ 2L/c — a closed-end (Γ > 0) termination steps toward p_f every
        // 2L/c, and with the midline removed those steps are a 2L/c-periodic component; 'ringing': ≈ 4L/c (open end, Γ < 0)
        var regime, match = 'unknown';
        if (A < 3 * sigma) regime = 'none';
        else if (tau < T / 2) regime = 'single';
        else regime = (L && Math.abs(T / (2 * twoLc) - 0.5) < Math.abs(T / (2 * twoLc) - 1)) ? 'staircase' : 'ringing';
        var wf = regime === 'staircase' ? 2 : 4, Lr = cw * T / wf, onRef = false, onPerfs = false;
        if (Ld && regime !== 'none') {
            onPerfs = Math.abs(Lr - Ld) / Ld <= 0.1;
            onRef = !onPerfs && Lref != null && Math.abs(Lr - Lref) / Lref <= 0.1;
            match = onPerfs ? 'perfs' : (Lr < Ld ? 'shallower' : 'deeper');
        }
        // the depth that rings when it is known: the perforations, or the given reflector
        var Lring = onPerfs ? Ld : (onRef ? Lref : null);
        // a known reflector that the ring matches calibrates c (§4.17): c = 4L/T (2L/T for the half wave)
        if (onRef) { cw = wf * Lref / T; cSource = 'calibrated'; }
        var Lq = cw * T / 4, Lh = cw * T / 2;
        var gDecay = regime === 'staircase' ? Math.exp(-T / tau) : Math.exp(-T / (2 * tau));
        // Joukowsky (expected at the shut-in rate, scaled by the closure duration; measured = first peak-to-trough)
        var seg0 = c && c.segments.length ? c.segments[0] : null, rho = fl.rhoPpg * SLUG_PER_PPG;
        var jExp = null;
        if (seg0 && q0 > 0) { jExp = rho * cw * (q0 * BPM / seg0.area) / 144; if (tClose > 0 && twoLc) jExp *= Math.min(1, twoLc / tClose); }
        var mx = -Infinity, mn = Infinity;
        for (i = 0; i < n && s[i] <= s[0] + T; i++) { var dd = A * Math.exp(-s[i] / tau) * Math.cos(2 * Math.PI * s[i] / T + phi); if (dd > mx) mx = dd; if (dd < mn) mn = dd; }
        var jMeas = _fin(mx) ? mx - mn : null;
        // V_w·c_w = L·A/(ρc²) from the period, over the section that rings (surface → the matched known depth) only
        var VwCwH = null;
        if (Lring && regime !== 'none') {
            var cMeas = wf * Lring / T, Vft3 = null;
            if (c && c.segments.length) {
                Vft3 = 0;
                c.segments.forEach(function (sg) { var len = Math.min(sg.botMd, Lring) - sg.topMd; if (len > 0) Vft3 += len * sg.area; });
            } else if (seg0) Vft3 = seg0.area * Lring;
            if (Vft3 > 0) VwCwH = Vft3 * 144 / (rho * cMeas * cMeas) / BBL;
        }
        var why = whyB;
        if (regime === 'none') why = 'No water-hammer signal above the noise in the window.';
        // delta = T/τ, the logarithmic decrement of the ring per fitted period
        return { ok: true, why: why ? why.slice(0, 299) : null, c: cw, cSource: cSource, T: T, tau: tau, delta: T / tau, A: A, phi: phi, isip: isip,
                 regime: regime, Lquarter: Lq, Lhalf: Lh, reflectorMatch: match, gammaDecay: gDecay,
                 joukowsky: { expected: _nn(jExp), measured: _nn(jMeas), ratio: (_fin(jExp) && jExp > 0 && _fin(jMeas)) ? jMeas / jExp : null },
                 VwCwHammer: _nn(VwCwH), tEnd: ts + s[n - 1] / 3600, sampling: sampling,
                 upper: upper, bleed: { fitted: !!fitBleed, b: _nn(bFit), dEnd: _nn(dEnd), seed: canBleed ? bleedSeeded : null }, slope: mG, sigma: sigma, sigmaFit: sigmaFit, n: n, converged: lm.converged };
    }

    // ── rate ↔ pressure clock alignment (§4.1) ───────────────────────────────
    function align(tp, p, tq, q, opts) {
        var o = opts || {};
        if (!Array.isArray(tp) || !Array.isArray(p) || !Array.isArray(tq) || !Array.isArray(q) || tp.length < 4 || tq.length < 4)
            return _fail('BAD_INPUT', 'Clock alignment needs pressure and rate records.', ['tp', 'tq']);
        var maxLag = _num(o.maxLagS, 1800), i;
        var Tp = [], P = [], Tq = [], Q = [];
        for (i = 0; i < tp.length; i++) if (_fin(tp[i]) && _fin(p[i])) { Tp.push(tp[i] * 3600); P.push(p[i]); }
        for (i = 0; i < tq.length; i++) if (_fin(tq[i]) && _fin(q[i])) { Tq.push(tq[i] * 3600); Q.push(q[i]); }
        var nP = Tp.length, nQ = Tq.length;
        var dp = []; for (i = 1; i < nP; i++) dp.push(P[i] - P[i - 1]);
        // event method: the last rate drop below 5 % of the preceding rate vs the largest negative pressure difference
        var tShQ = null, qMx = 0;
        for (i = 0; i < nQ; i++) if (Q[i] > qMx) qMx = Q[i];
        for (i = nQ - 1; i >= 1; i--) {
            var thr = Math.max(0.05 * Q[i - 1], 0.02 * qMx);
            if (Q[i - 1] > 0.1 * qMx && Q[i] < thr) { tShQ = Tq[i - 1] + (Q[i - 1] - thr) / (Q[i - 1] - Q[i]) * (Tq[i] - Tq[i - 1]); break; }
        }
        var iMin = 0; for (i = 1; i < dp.length; i++) if (dp[i] < dp[iMin]) iMin = i;
        var offEvent = tShQ != null ? tShQ - 0.5 * (Tp[iMin] + Tp[iMin + 1]) : null;
        // scan ±maxLag around 0 and, when the event offset lies outside that, around it too; the better score wins
        var centres = [0];
        if (offEvent != null && Math.abs(offEvent) > maxLag) centres.push(Math.round(offEvent));
        function lowerBound(arr, n, v) { var lo = 0, hi = n; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
        function score(lag, k0, k1) {
            var ka = k0 || 0, kb = k1 || nP, s = 0, qPrev = null;
            var j = Math.max(0, lowerBound(Tq, nQ, Tp[ka] + lag) - 1);
            for (var k = ka; k < kb; k++) {
                var tt = Tp[k] + lag;
                while (j + 1 < nQ && Tq[j + 1] < tt) j++;
                var qv;
                if (tt <= Tq[0]) qv = Q[0]; else if (tt >= Tq[nQ - 1]) qv = Q[nQ - 1];
                else { var f = (tt - Tq[j]) / (Tq[j + 1] - Tq[j]); qv = Q[j] + f * (Q[j + 1] - Q[j]); }
                if (k > ka) s += dp[k - 1] * (qv - qPrev);
                qPrev = qv;
            }
            return s;
        }
        // the pressure-sample ranges that can see a rate change for some lag in [lagA, lagB]: outside them the interpolated rate is
        // constant and adds nothing to the score, so scoring only these is exact and costs O(samples near changes) per lag
        function ranges(lagA, lagB) {
            var iv = [], j, out = [];
            for (j = 0; j + 1 < nQ; j++) {
                if (Q[j + 1] === Q[j]) continue;
                var a = Tq[j] - lagB, b = Tq[j + 1] - lagA;
                if (iv.length && a <= iv[iv.length - 1][1]) { if (b > iv[iv.length - 1][1]) iv[iv.length - 1][1] = b; } else iv.push([a, b]);
            }
            for (j = 0; j < iv.length; j++) {
                var k0 = Math.max(0, lowerBound(Tp, nP, iv[j][0]) - 1), k1 = Math.min(nP, lowerBound(Tp, nP, iv[j][1]) + 1);
                if (k1 - k0 < 2) continue;
                if (out.length && k0 <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], k1); else out.push([k0, k1]);
            }
            return out;
        }
        function scoreR(lag, rs) { var s = 0; for (var r = 0; r < rs.length; r++) s += score(lag, rs[r][0], rs[r][1]); return s; }
        var dtP = _median(Tp.slice(1).map(function (v, k) { return v - Tp[k]; }));
        var coarse = Math.max(0.5, Math.min(5, _fin(dtP) ? dtP : 1));
        var best = null;
        centres.forEach(function (centre) {
            var rs = ranges(centre - maxLag - 1, centre + maxLag + 1);
            for (var lag = centre - maxLag; lag <= centre + maxLag + 1e-9; lag += coarse) { var sc = scoreR(lag, rs); if (!best || sc > best.s) best = { lag: lag, s: sc }; }
        });
        var lag;
        var fineStep = 0.1, fb = null, fineList = [], rsF = ranges(best.lag - 2 * coarse - 1, best.lag + 2 * coarse + 1);
        for (lag = best.lag - 2 * coarse; lag <= best.lag + 2 * coarse + 1e-9; lag += fineStep) { var sf = scoreR(lag, rsF); fineList.push([lag, sf]); if (!fb || sf > fb.s) fb = { lag: lag, s: sf, k: fineList.length - 1 }; }
        var off = fb.lag;
        if (fb.k > 0 && fb.k + 1 < fineList.length) {
            var y0 = fineList[fb.k - 1][1], y1 = fineList[fb.k][1], y2 = fineList[fb.k + 1][1], den = y0 - 2 * y1 + y2;
            if (den < 0) off = fb.lag + 0.5 * fineStep * (y0 - y2) / den;
        }
        // normalised score
        var sdp = 0; for (i = 0; i < dp.length; i++) sdp += dp[i] * dp[i];
        var sdq = 0; for (i = 1; i < nQ; i++) sdq += (Q[i] - Q[i - 1]) * (Q[i] - Q[i - 1]);
        var norm = (sdp > 0 && sdq > 0) ? fb.s / Math.sqrt(sdp * sdq) : 0;
        var method = 'xcorr';
        if (!(fb.s > 0) && offEvent != null) { off = offEvent; method = 'event'; }
        // clock drift: offsets of the two halves of the rate-change energy, when their centroids are ≥ 1 h apart
        var drift = 0, driftEstimated = false;
        if (method === 'xcorr') {
            // split at the longest quiet gap between rate changes (pressure clock), each side carrying ≥ 20 % of the change energy
            var ev = [], tot = 0, eMax = 0;
            for (i = 1; i < nQ; i++) { var e = Math.abs(Q[i] - Q[i - 1]); if (e > eMax) eMax = e; }
            for (i = 1; i < nQ; i++) { var e2 = Math.abs(Q[i] - Q[i - 1]); if (e2 > 0.1 * eMax) { ev.push({ t: 0.5 * (Tq[i] + Tq[i - 1]) - off, e: e2 }); tot += e2; } }
            var tSplit = null, gap = 0, c1 = 0, w1 = 0, c2 = 0, w2 = 0;
            for (i = 1; i < ev.length; i++) if (ev[i].t - ev[i - 1].t > gap) { gap = ev[i].t - ev[i - 1].t; tSplit = 0.5 * (ev[i].t + ev[i - 1].t); }
            if (tSplit != null) ev.forEach(function (x) { if (x.t < tSplit) { c1 += x.e * x.t; w1 += x.e; } else { c2 += x.e * x.t; w2 += x.e; } });
            if (!(w1 >= 0.2 * tot && w2 >= 0.2 * tot)) tSplit = null;
            if (tSplit != null && w1 > 0 && w2 > 0 && (c2 / w2 - c1 / w1) >= 3600) {
                var kS = 0; while (kS < nP && Tp[kS] < tSplit) kS++;
                var fine = function (k0, k1) {
                    var bc = null, lg;
                    for (lg = off - 120; lg <= off + 120 + 1e-9; lg += coarse) { var vc = score(lg, k0, k1); if (!bc || vc > bc.s) bc = { lag: lg, s: vc }; }
                    var bl = null, list = [];
                    for (lg = bc.lag - 2 * coarse; lg <= bc.lag + 2 * coarse + 1e-9; lg += fineStep) { var v = score(lg, k0, k1); list.push([lg, v]); if (!bl || v > bl.s) bl = { lag: lg, s: v, k: list.length - 1 }; }
                    var o2 = bl.lag;
                    if (bl.k > 0 && bl.k + 1 < list.length) { var a1 = list[bl.k - 1][1], a2 = list[bl.k][1], a3 = list[bl.k + 1][1], dn = a1 - 2 * a2 + a3; if (dn < 0) o2 = bl.lag + 0.5 * fineStep * (a1 - a3) / dn; }
                    return bl.s > 0 ? o2 : null;
                };
                var oA = fine(0, kS), oB = fine(Math.max(0, kS - 1), nP);
                if (oA != null && oB != null) { drift = (oB - oA) / ((c2 / w2 - c1 / w1) / 86400); driftEstimated = true; }
            }
        }
        var hrs = Math.round(off / 3600);
        var hourShift = hrs !== 0 && Math.abs(off - 3600 * hrs) < 5;
        var events = [];
        if (tShQ != null) events.push({ kind: 'shut-in', tRate: tShQ / 3600, tPressure: 0.5 * (Tp[iMin] + Tp[iMin + 1]) / 3600, offsetS: offEvent });
        return { ok: true, offsetS: off, driftSPerDay: drift, driftEstimated: driftEstimated, score: norm, events: events, hourShift: hourShift, method: method,
                 confirm: Math.abs(off) > 2, text: (Math.abs(off) > 2 ? 'The rate clock is offset by ' + _f(off, 1) + ' s from the pressure clock' + (hourShift ? ' (a whole number of hours: time zone or daylight saving)' : '') + '; apply after confirmation.'
                     : 'The rate and pressure clocks agree within 2 s.') };
    }

    // ── namespace (merge, never replace) ─────────────────────────────────────
    var W = G.WTS_wellbore = G.WTS_wellbore || {};
    var API = { column: column, csys: csys, tempProfile: tempProfile, hydrostatic: hydrostatic, pipeFriction: pipeFriction, perfFriction: perfFriction,
                nwbLoss: nwbLoss, bleedOff: bleedOff, convert: convert, vacuum: vacuum, stepDown: stepDown, stepDownDesignCheck: stepDownDesignCheck,
                stepRate: stepRate, ramp: ramp, hammerQuick: hammerQuick, align: align,
                pipeDp: pipeDp, vwcwFromPeriod: vwcwFromPeriod, surveyMC: surveyMC, flowingTemp: flowingTemp, flowingTempFitU: flowingTempFitU };
    Object.keys(API).forEach(function (k) { W[k] = _safe(k, API[k]); });
    W.flowingTempF = flowingTempF;
    W.perfConstant = perfConstant;
    W.salinityFromPpg = salinityFromPpg;
    W.rhoScPpg = rhoScPpg;
    W.rhoAt = function (pp, T, fluid) { return rhoAt(pp, T, fluid); };
    W.hinge = function (x, y, w, o) { try { return hinge(x, y, w, o); } catch (e) { return null; } };
    W.version = '3.4a-1';
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var W = G.WTS_wellbore, bad = [];
    function chk(name, v, ref, tol) { if (!(typeof v === 'number' && Math.abs(v - ref) <= tol)) bad.push(name + ' ' + v + ' vs ' + ref); }
    try {
        chk('velocity 1 bbl/min in 1 in', W.pipeFriction(1, { id: 1, rough: 0 }, { rhoPpg: 8.43, muCp: 1 }).v, 17.157, 1e-3);
        chk('perforation 12 x 0.40 in', W.perfFriction(5, { n: 12, dIn: 0.4, cd: 0.6 }, 8.43), 37.6, 0.1);
        chk('salinity of 8.43 ppg', W.salinityFromPpg(8.43), 1.571, 0.002);
        chk('casing Re', W.pipeFriction(5, { id: 4.778, rough: 0 }, { rhoPpg: 8.43, muCp: 1 }).re, 140456, 2);
        var bo = W.bleedOff({ b: 140, beta: 0.5, qt: 0, VwCw: 4.98e-3 / 5.614583, d0: 315 });
        chk('bleed-off 1 psi (old storage)', bo.t1psi * 60, 17.33, 0.02);
        var h = W.hinge([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 4.5, 5, 5.5, 6]);
        chk('hinge break', h && h.qStar, 4, 1e-6);
    } catch (e) { bad.push('threw ' + (e && e.message)); }
    if (bad.length && typeof console !== 'undefined') console.warn('[48-calc-wellbore self-test] ' + bad.join('; '));
})();
