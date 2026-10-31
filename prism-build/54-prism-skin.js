// =============================================================================
// PRiSM — 54-prism-skin.js  (Round 8)
// -----------------------------------------------------------------------------
// Skin maths shared by the Build-up Surveillance page (Round 9) and the PRiSM
// Skin-check card: window.PRiSM_skinCheck.
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §3.4 (interfaces), D23, §4.7 (T7, T8,
// T14, T15), §6.11 (card), §11 Q7.
//
// MILESTONE M1 (pure, no DOM, no storage, no timers, no events):
//   perforationSkin(i)   Karakas–Tariq perforation skin (S_H + S_V + S_wb)
//   mechanicalSkin(i)    S_mech on the pressure-drop basis and the local damage
//                        skin S_d = S_mech·h_w/h (D23)
//   rateSkin(rows, opts) guarded rate-dependent skin S′ = S + D·q (M§A19)
//   products(i)          Δp_skin, m, X, PI ratio, FE, DR (T7, T8, M§A27)
//
// -----------------------------------------------------------------------------
// KARAKAS–TARIQ COEFFICIENT TABLE — VERIFICATION RECORD (plan §11 Q7)
//   Status: UNVERIFIED (KT.verified = false). perforationSkin() returns
//   {ok:false, code:'UNVERIFIED'} and mechanicalSkin() says "perforation skin
//   not split" until this record is completed.
//   Checked on 2026-10-31 (WP7): the paper itself (Karakas & Tariq 1991,
//   "Semianalytical productivity models for perforated completions",
//   SPE 18247, SPE Production Engineering, January 1991) could not be read:
//   it is not openly available, so the table could not be checked against
//   the paper's own page. Two later publications that reproduce the table
//   were read instead:
//     • a 2022 doctoral thesis on perforation skin (its Tables 4.1 and 4.2)
//       agrees with every one of the 42 values below;
//     • a journal article agrees with 41 of them and prints c2 = 5.42 for
//       120° phasing where the thesis (and the table below) has 5.320.
//   The disagreement shows that copies of this table carry transcription
//   errors, so corroboration by copies is not treated as verification.
//   TO VERIFY: compare every row with the table in SPE 18247 itself, record
//   the page here, set KT.verified = true. Test SK1 then checks the plan's
//   vectors through the public function (rw 0.406 ft, lp 8 in, rp 0.25 in,
//   kh/kv 3, 2 spf: 180° 2.19, 0° 3.09, 90° 2.03, 60° 2.29); they are already
//   checked against the internal routine so the switch is one line.
//
//   S_p = S_H + S_V + S_wb
//   S_H = ln(rw / rw′(θ)),  rw′ = lp/4 (θ = 0°), a_θ·(rw + lp) otherwise
//   S_V = 10^a · hD^(b−1) · rD^b,  hD = (hs/lp)·√(kh/kv),  rD = rp/(2hs)·(1 + √(kv/kh)),
//         a = a1·log10 rD + a2,  b = b1·rD + b2,  hs = 1/spf (ft)
//   S_wb = c1·exp(c2·rwD),  rwD = rw/(lp + rw)
//   Correlation range: hD ≤ 10 and rD ≥ 0.01 (a warning outside it).
//
// REFERENCES (author, year, title; SPE numbers only where verified in plan §14)
//   Karakas & Tariq 1991, "Semianalytical productivity models for perforated
//     completions", SPE 18247.
//   Papatzacos 1987, "Approximate partial-penetration pseudoskin for
//     infinite-conductivity wells", SPE 13956 — partial penetration with the
//     interval anywhere in the layer:
//       S_pp = (1/hpD − 1)·ln(π/(2rD)) + (1/hpD)·ln[ hpD/(2 + hpD) · ((A − 1)/(B − 1))^½ ],
//       hpD = hp/h, rD = (rw/h)·√(kv/kh), h1D = htop/h,
//       A = 1/(h1D + hpD/4), B = 1/(h1D + 3hpD/4).
//   Brons & Marting 1961, "The effect of restricted fluid entry on well
//     productivity", SPE 1322-G — cross-check for an interval at the top or
//     the bottom of the layer (PRiSM_pseudoSkin.bronsMarting).
//   Cinco-Ley, Ramey & Miller 1975, "Pseudo-skin factors for
//     partially-penetrating directionally-drilled wells" — slanted well,
//     valid for θ ≤ 75° (PRiSM_pseudoSkin.cincoLey).
//   Swift & Kiel 1962, "The prediction of gas-well performance including the
//     effect of non-Darcy flow", SPE 143 — S′ = S + D·q. Expected D from
//     D = 2.222e-15·γg·k·h·β/(μg·rw·hp²) [1/(Mscf/d)] with
//     β = 2.6e10·k^−1.2 [1/ft] (Firoozabadi & Katz 1979); β correlations
//     scatter widely, so the expected range is ×1/3 … ×3.
//
// UNITS — field units: ft, in (perforation length and radius), md, cp,
//   RB/STB (or RB/Mscf), STB/d | Mscf/d | bbl/d, psia, psi/cycle, days.
// Every output number is finite or null; text never says null/undefined/NaN.
// Load rules: no document, no timers, no other PRiSM symbol needed at load.
// The namespace object is merged, never replaced.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var SC = G.PRiSM_skinCheck = G.PRiSM_skinCheck || {};

    // =========================================================================
    // SECTION 1 — HELPERS
    // =========================================================================
    var LN10 = Math.LN10;
    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function pos(v) { return isNum(v) && v > 0; }
    function fin(v) { return isNum(v) ? v : null; }
    function num(v) {
        if (isNum(v)) return v;
        if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v;
        return null;
    }
    function sq(x) { return x * x; }
    // Plain-text number (never "NaN"/"null").
    function fmt(v, dp) {
        if (!isNum(v)) return '—';
        var d = (dp == null) ? 2 : dp;
        var s = v.toFixed(d);
        return (s === '-0' || /^-0\.0*$/.test(s)) ? s.slice(1) : s;
    }
    function warning(code, level, text) { return { code: code, level: level || 'warn', text: String(text).slice(0, 299), ev: [] }; }
    function fail(code, errors, bad, extra) {
        var o = { ok: false, code: code, errors: errors || [], bad: bad || [] };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
        return o;
    }

    // =========================================================================
    // SECTION 2 — PERFORATION SKIN (Karakas & Tariq)
    // =========================================================================
    function row(aT, a1, a2, b1, b2, c1, c2) {
        return Object.freeze({ a_theta: aT, a1: a1, a2: a2, b1: b1, b2: b2, c1: c1, c2: c2 });
    }
    var KT = Object.freeze({
        verified: false,     // see the verification record in the file header (plan §11 Q7)
        source: 'Karakas & Tariq 1991, Semianalytical productivity models for perforated completions (SPE 18247); ' +
                'coefficients corroborated by later reproductions, not yet checked against the paper',
        page: null,          // the table's page in SPE 18247, recorded when verified
        phases: Object.freeze([0, 45, 60, 90, 120, 180]),
        rows: Object.freeze({
            0:   row(0.250, -2.091, 0.0453, 5.1313, 1.8672, 1.6e-1, 2.675),
            180: row(0.500, -2.025, 0.0943, 3.0373, 1.8115, 2.6e-2, 4.532),
            120: row(0.648, -2.018, 0.0634, 1.6136, 1.7770, 6.6e-3, 5.320),
            90:  row(0.726, -1.905, 0.1038, 1.5674, 1.6935, 1.9e-3, 6.155),
            60:  row(0.813, -1.898, 0.1023, 1.3654, 1.6490, 3.0e-4, 7.509),
            45:  row(0.860, -1.788, 0.2398, 1.1915, 1.6392, 4.6e-5, 8.791)
        }),
        range: Object.freeze({ hDMax: 10, rDMin: 0.01 })
    });

    // The Karakas–Tariq arithmetic, independent of the verification flag.
    // Internal (exposed as _ktCompute for the table-consistency test only);
    // pages and the card call perforationSkin().
    function ktCompute(i) {
        i = i || {};
        var rw = num(i.rw_ft), lpIn = num(i.lp_in), rpIn = num(i.rp_in), spf = num(i.spf);
        var ph = num(i.phase_deg), kvkh = num(i.kvkh);
        if (ph === 360) ph = 0;
        var bad = [], errors = [];
        if (!pos(rw)) { bad.push('rw_ft'); errors.push('Wellbore radius must be positive.'); }
        if (!pos(lpIn)) { bad.push('lp_in'); errors.push('Perforation length must be positive.'); }
        if (!pos(rpIn)) { bad.push('rp_in'); errors.push('Perforation radius must be positive.'); }
        if (!pos(spf)) { bad.push('spf'); errors.push('Shot density must be positive.'); }
        if (!isNum(ph) || !KT.rows[ph]) { bad.push('phase_deg'); errors.push('Phasing must be 0, 45, 60, 90, 120 or 180 degrees.'); }
        if (kvkh == null) kvkh = 1;
        if (!pos(kvkh)) { bad.push('kvkh'); errors.push('kv/kh must be positive.'); }
        if (bad.length) return fail('BAD_INPUT', errors, bad);
        var c = KT.rows[ph];
        var lp = lpIn / 12, rp = rpIn / 12, hs = 1 / spf;
        var rwPrime = (ph === 0) ? lp / 4 : c.a_theta * (rw + lp);
        var S_H = Math.log(rw / rwPrime);
        var hD = (hs / lp) * Math.sqrt(1 / kvkh);
        var rD = (rp / (2 * hs)) * (1 + Math.sqrt(kvkh));
        var a = c.a1 * Math.log(rD) / LN10 + c.a2;
        var b = c.b1 * rD + c.b2;
        var S_V = Math.pow(10, a) * Math.pow(hD, b - 1) * Math.pow(rD, b);
        var rwD = rw / (lp + rw);
        var S_wb = c.c1 * Math.exp(c.c2 * rwD);
        var warnings = [];
        if (hD > KT.range.hDMax) warnings.push(warning('ktHd', 'warn', 'Perforation spacing is large for the correlation (hD ' + fmt(hD, 2) + ' > 10): the vertical skin is extrapolated.'));
        if (rD < KT.range.rDMin) warnings.push(warning('ktRd', 'warn', 'Perforation radius is small for the correlation (rD ' + fmt(rD, 4) + ' < 0.01): the vertical skin is extrapolated.'));
        if (kvkh > 1) warnings.push(warning('ktKv', 'info', 'kv/kh is above 1.'));
        var S = S_H + S_V + S_wb;
        if (!isNum(S)) return fail('BAD_INPUT', ['The perforation skin could not be computed from these inputs.'], ['lp_in', 'rp_in', 'spf']);
        return {
            ok: true, verified: KT.verified,
            S_H: S_H, S_V: S_V, S_wb: S_wb, S_perf: S,
            rwPrime_ft: rwPrime, hD: hD, rD: rD, rwD: rwD, a: a, b: b, phase_deg: ph,
            warnings: warnings
        };
    }

    // perforationSkin({rw_ft, lp_in, rp_in, spf, phase_deg, kvkh})
    //   → {ok, S_H, S_V, S_wb, S_perf, verified, warnings}
    //   → {ok:false, code:'UNVERIFIED'} while the coefficient table is unverified.
    function perforationSkin(i) {
        if (!KT.verified) {
            return fail('UNVERIFIED', ['The perforation-skin coefficients are not verified against the paper: perforation skin is not split.'], [],
                        { verified: false, S_H: null, S_V: null, S_wb: null, S_perf: null, warnings: [] });
        }
        return ktCompute(i);
    }

    // =========================================================================
    // SECTION 3 — MECHANICAL SKIN (D23)
    // =========================================================================
    var THETA_MAX = 75;

    // Papatzacos (1987): partial penetration, interval anywhere in the layer.
    function papatzacos(hpD, h1D, rD) {
        if (!(hpD > 0) || !(rD > 0)) return null;
        if (hpD >= 1) return 0;
        var A = 1 / (h1D + hpD / 4), B = 1 / (h1D + 3 * hpD / 4);
        var r = (A - 1) / (B - 1);
        if (!(r > 0)) return null;
        var v = (1 / hpD - 1) * Math.log(Math.PI / (2 * rD)) + (1 / hpD) * Math.log((hpD / (2 + hpD)) * Math.sqrt(r));
        return isNum(v) ? v : null;
    }
    // Brons & Marting (1961), interval at the top or bottom (cross-check).
    function bronsMarting(b, hD) {
        var lib = G.PRiSM_pseudoSkin;
        if (lib && typeof lib.bronsMarting === 'function') {
            try { var v = lib.bronsMarting(b, hD); if (isNum(v)) return v; } catch (e) { /* local */ }
        }
        if (!(b > 0) || !(hD > 0)) return null;
        if (b >= 1) return 0;
        var Gb = 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b * b * b;
        return (1 / b - 1) * (Math.log(hD) - Gb);
    }
    // Cinco-Ley, Ramey & Miller (1975): slanted well.
    function cincoLey(thetaDeg, kvkh, hRw) {
        var lib = G.PRiSM_pseudoSkin;
        if (lib && typeof lib.cincoLey === 'function') {
            try { var v = lib.cincoLey(thetaDeg, kvkh, hRw); if (isNum(v)) return v; } catch (e) { /* local */ }
        }
        if (!isNum(thetaDeg) || thetaDeg === 0) return 0;
        var th = Math.min(Math.abs(thetaDeg), 89.999);
        var thP = Math.atan(Math.sqrt(kvkh) * Math.tan(th * Math.PI / 180)) * 180 / Math.PI;
        var hD = hRw * Math.sqrt(1 / kvkh);
        return -Math.pow(thP / 41, 2.06) - Math.pow(thP / 56, 1.865) * (Math.log(hD / 100) / LN10);
    }

    // mechanicalSkin({S_total, Serr, h, rw, completion:{hp_ft, htop_ft, theta_deg,
    //   kvkh:[lo,hi], perf|null}, D|null, q|null})
    //   → {available, S_geo, S_geo_lo, S_geo_hi, parts:{pp, ppMethod, theta, perf|null},
    //      S_mech, S_mech_err, S_d_local, validity:[{code,text}], warnings}
    // S_mech = S_total − S_geo − D·q is the pressure-drop basis (referred to h):
    // what alerts and production loss use. S_d_local = S_mech·hp/h is the skin of
    // the open interval itself (treatment design). S_geo is evaluated at the
    // geometric mean of the kv/kh range; S_geo_lo/hi span the range.
    function mechanicalSkin(i) {
        i = i || {};
        var out = {
            ok: true, available: false, reason: '', basis: 'pressureDrop',
            S_geo: null, S_geo_lo: null, S_geo_hi: null,
            parts: { pp: null, ppMethod: 'none', theta: null, perf: null, perfLocal: null, ppBronsMarting: null, Dq: null },
            S_mech: null, S_mech_err: null, S_d_local: null, kvkh: null,
            validity: [], warnings: []
        };
        function stop(reason) { out.reason = reason; return out; }
        var St = num(i.S_total), Serr = num(i.Serr), h = num(i.h), rw = num(i.rw), c = i.completion;
        if (!isNum(St)) return stop('Total skin is not available.');
        if (!pos(h) || !pos(rw)) return stop('Net thickness and wellbore radius are needed to split the skin.');
        if (!c || typeof c !== 'object') return stop('No completion data: the total skin is not split.');
        if (!isNum(Serr) || Serr < 0) {
            Serr = 0;
            out.warnings.push(warning('noSerr', 'info', 'Skin uncertainty not given: the mechanical-skin range covers kv/kh only.'));
        }
        var hp = num(c.hp_ft), htop = num(c.htop_ft), theta = num(c.theta_deg);
        if (hp == null) hp = h;
        if (htop == null) htop = 0;
        if (theta == null) theta = 0;
        if (!pos(hp)) return stop('The open interval must be positive.');
        if (htop < 0) return stop('The distance from the top of the layer to the open interval cannot be negative.');
        var tol = 1e-6 * h;
        if (htop + hp > h + tol) {
            out.validity.push({ code: 'intervalOutside', text: 'The open interval (' + fmt(htop, 1) + ' + ' + fmt(hp, 1) + ' ft) extends below the layer (' + fmt(h, 1) + ' ft): the total skin is not split.' });
            return stop('The open interval does not fit inside the layer.');
        }
        if (hp > h) hp = h;
        theta = Math.abs(theta);
        if (theta > THETA_MAX) {
            out.validity.push({ code: 'thetaRange', text: 'Well deviation ' + fmt(theta, 0) + '° is above the 75° limit of the slanted-well correlation: the total skin is not split.' });
            return stop('Deviation above 75°: the slanted-well pseudo-skin is outside its validity range.');
        }
        // kv/kh range.
        var kv = Array.isArray(c.kvkh) ? c.kvkh : (isNum(c.kvkh) ? [c.kvkh, c.kvkh] : null);
        var lo = kv ? num(kv[0]) : null, hi = kv ? num(kv[1]) : null;
        if (!pos(lo) || !pos(hi)) {
            lo = 0.1; hi = 1;
            out.warnings.push(warning('kvkhDefault', 'info', 'kv/kh range not given: 0.1 to 1 assumed.'));
        }
        if (lo > hi) { var t = lo; lo = hi; hi = t; }
        var mid = Math.sqrt(lo * hi);
        out.kvkh = [lo, hi];

        var partial = hp < h * (1 - 1e-9);
        var h1D = htop / h, hpD = hp / h;
        var perfIn = c.perf && typeof c.perf === 'object' ? c.perf : null;
        var perfStatus = null;
        function geo(K) {
            var pp = 0, th = 0, pf = 0, pfLocal = null;
            if (partial) {
                pp = papatzacos(hpD, h1D, (rw / h) * Math.sqrt(K));
                if (pp == null) return null;
            }
            if (theta > 0) {
                th = cincoLey(theta, K, h / rw);
                if (!isNum(th)) return null;
            }
            if (perfIn) {
                var r = perforationSkin({ rw_ft: rw, lp_in: perfIn.lp_in, rp_in: perfIn.rp_in, spf: perfIn.spf, phase_deg: perfIn.phase_deg, kvkh: K });
                if (r.ok) { pfLocal = r.S_perf; pf = r.S_perf * h / hp; perfStatus = perfStatus || r; }
                else { perfStatus = r; pf = 0; }
            }
            return { pp: pp, theta: th, perf: pfLocal == null ? null : pf, perfLocal: pfLocal, total: pp + th + pf };
        }
        var gMid = geo(mid), gLo = geo(lo), gHi = geo(hi);
        if (!gMid || !gLo || !gHi) return stop('The geometric pseudo-skin could not be computed from these completion inputs.');
        out.parts.pp = gMid.pp;
        out.parts.ppMethod = partial ? 'papatzacos' : 'none';
        out.parts.theta = gMid.theta;
        out.parts.perf = gMid.perf;
        out.parts.perfLocal = gMid.perfLocal;
        if (partial && (htop <= tol || htop + hp >= h - tol)) {
            out.parts.ppBronsMarting = fin(bronsMarting(hpD, (h / rw) * Math.sqrt(1 / mid)));
        }
        if (perfIn && perfStatus && !perfStatus.ok) {
            if (perfStatus.code === 'UNVERIFIED') {
                out.validity.push({ code: 'perfNotSplit', text: 'Perforation skin not split: the perforation-skin coefficients are not verified. S_mech includes the perforation skin.' });
            } else {
                out.validity.push({ code: 'perfBadInput', text: 'Perforation data incomplete: perforation skin not split. ' + (perfStatus.errors[0] || '') });
            }
        } else if (perfIn && perfStatus && perfStatus.ok) {
            perfStatus.warnings.forEach(function (w) { out.warnings.push(w); });
        }
        if (partial && theta > 0) {
            out.validity.push({ code: 'ppTheta', text: 'Partial penetration and deviation pseudo-skins are added (an approximation when both apply).' });
        }
        if (theta > 0 && (h / rw) * Math.sqrt(1 / hi) < 40) {
            out.validity.push({ code: 'thetaHd', text: 'Thin layer for the slanted-well correlation (h/rw·√(kh/kv) below 40): the deviation skin is approximate.' });
        }
        var vals = [gLo.total, gMid.total, gHi.total];
        out.S_geo = gMid.total;
        out.S_geo_lo = Math.min.apply(null, vals);
        out.S_geo_hi = Math.max.apply(null, vals);
        var D = num(i.D), q = num(i.q), Dq = 0;
        if (isNum(D) && isNum(q)) Dq = D * Math.abs(q);
        else if (isNum(D)) out.warnings.push(warning('noRate', 'info', 'D given without a rate: D·q not removed.'));
        out.parts.Dq = Dq;
        out.S_mech = St - out.S_geo - Dq;
        out.S_mech_err = Math.sqrt(sq(Serr) + sq((out.S_geo_hi - out.S_geo_lo) / 2));
        out.S_d_local = out.S_mech * hp / h;
        out.available = true;
        out.reason = '';
        return out;
    }

    // =========================================================================
    // SECTION 4 — RATE-DEPENDENT SKIN (M§A19)
    // =========================================================================
    var RATE_DEFAULTS = Object.freeze({ qRatioMin: 1.5, maxDays: 60, joint: true, corrMax: 0.8, dOverSeMin: 2, jointMinN: 4, serrMin: 0.05, serrDefault: 0.2, expectedFactor: 3 });

    // Weighted least squares y = X·beta with weights w; returns {beta, cov, chi2, dof}.
    function wls(X, y, w) {
        var n = y.length, p = X[0].length, A = [], bv = [], r, c, k;
        for (r = 0; r < p; r++) { A.push(new Array(p).fill(0)); bv.push(0); }
        for (k = 0; k < n; k++) {
            for (r = 0; r < p; r++) {
                bv[r] += w[k] * X[k][r] * y[k];
                for (c = 0; c < p; c++) A[r][c] += w[k] * X[k][r] * X[k][c];
            }
        }
        var inv = invert(A);
        if (!inv) return null;
        var beta = [];
        for (r = 0; r < p; r++) { var s = 0; for (c = 0; c < p; c++) s += inv[r][c] * bv[c]; beta.push(s); }
        var chi2 = 0;
        for (k = 0; k < n; k++) { var f = 0; for (r = 0; r < p; r++) f += X[k][r] * beta[r]; chi2 += w[k] * sq(y[k] - f); }
        return { beta: beta, cov: inv, chi2: chi2, dof: n - p };
    }
    function invert(M) {
        var n = M.length, A = M.map(function (r, i) { var e = new Array(n).fill(0); e[i] = 1; return r.slice().concat(e); });
        var scale = 0;
        for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) scale = Math.max(scale, Math.abs(M[a][b]));
        for (var col = 0; col < n; col++) {
            var piv = col;
            for (var r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
            if (!(Math.abs(A[piv][col]) > 1e-12 * (scale || 1))) return null;
            var tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
            var d = A[col][col];
            for (var j = 0; j < 2 * n; j++) A[col][j] /= d;
            for (var r2 = 0; r2 < n; r2++) {
                if (r2 === col) continue;
                var f = A[r2][col];
                if (f === 0) continue;
                for (var j2 = 0; j2 < 2 * n; j2++) A[r2][j2] -= f * A[col][j2];
            }
        }
        return A.map(function (r) { return r.slice(n); });
    }
    function pearson(x, y) {
        var n = x.length;
        if (n < 2) return null;
        var mx = 0, my = 0, i;
        for (i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
        mx /= n; my /= n;
        var sxy = 0, sxx = 0, syy = 0;
        for (i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += sq(x[i] - mx); syy += sq(y[i] - my); }
        if (!(sxx > 0) || !(syy > 0)) return null;
        return sxy / Math.sqrt(sxx * syy);
    }
    // Expected D for a gas well (1/(Mscf/d)) and its range.
    function expectedD(e) {
        if (!e || typeof e !== 'object') return null;
        var k = num(e.k), h = num(e.h), hp = num(e.hp), rw = num(e.rw), sg = num(e.sg), mu = num(e.mu_g);
        if (hp == null) hp = h;
        if (!pos(k) || !pos(h) || !pos(hp) || !pos(rw) || !pos(sg) || !pos(mu)) return null;
        var beta = 2.6e10 * Math.pow(k, -1.2);
        var D = 2.222e-15 * sg * k * h * beta / (mu * rw * hp * hp);
        if (!pos(D)) return null;
        var f = RATE_DEFAULTS.expectedFactor;
        return { D: D, lo: D / f, hi: D * f, beta: beta, unit: '1/(Mscf/d)',
                 method: 'D = 2.222e-15·γg·k·h·β/(μg·rw·hp²), β = 2.6e10·k^-1.2; range ×1/3 to ×3' };
    }

    // rateSkin(rows [{id, t_days, q, S, Serr}], opts {qRatioMin, maxDays, joint, expected})
    //   → {resolved, S, D, seD, n, qRatio, joint:null|{S0, r_per30d, D, seD}, expectedD,
    //      consistent, reason, ev:['T15']}
    // Rows are sorted by time and split where two consecutive tests are more than
    // maxDays apart; the group with the most tests (the latest on a tie) is used.
    // D needs q_max/q_min ≥ qRatioMin, |corr(q, t)| < 0.8 (two tests are always
    // collinear) and D/se ≥ 2. A joint fit S′ = S0 + r·t/30 + D·q runs with ≥ 4
    // tests; when its time term is significant (|r|/se ≥ 2) D comes from it.
    function rateSkin(rows, opts) {
        var o = {};
        var k;
        for (k in RATE_DEFAULTS) if (Object.prototype.hasOwnProperty.call(RATE_DEFAULTS, k)) o[k] = RATE_DEFAULTS[k];
        if (opts && typeof opts === 'object') for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k) && opts[k] != null) o[k] = opts[k];
        var out = { resolved: false, S: null, D: null, seD: null, n: 0, qRatio: null, joint: null, expectedD: null, consistent: null,
                    corrQT: null, ids: [], reason: '', ev: ['T15'] };
        out.expectedD = expectedD(o.expected);
        var list = [];
        (Array.isArray(rows) ? rows : []).forEach(function (r) {
            if (!r || typeof r !== 'object') return;
            var q = num(r.q), S = num(r.S), t = num(r.t_days), se = num(r.Serr);
            if (!isNum(q) || q === 0 || !isNum(S) || !isNum(t)) return;
            if (!isNum(se) || se < 0) se = o.serrDefault;
            list.push({ id: r.id == null ? '' : String(r.id), q: Math.abs(q), S: S, t: t, se: Math.max(se, o.serrMin) });
        });
        list.sort(function (a, b) { return a.t - b.t; });
        // Split at gaps > maxDays; keep the largest (latest on a tie) group.
        var groups = [], cur = [];
        list.forEach(function (r) {
            if (cur.length && r.t - cur[cur.length - 1].t > o.maxDays) { groups.push(cur); cur = []; }
            cur.push(r);
        });
        if (cur.length) groups.push(cur);
        var g = [];
        groups.forEach(function (x) { if (x.length >= g.length) g = x; });
        out.n = g.length;
        out.ids = g.map(function (r) { return r.id; });
        if (g.length < 2) { out.reason = 'Fewer than two tests within ' + fmt(o.maxDays, 0) + ' days: D cannot be separated from S; S′ is the apparent skin including D·q.'; return out; }
        var qs = g.map(function (r) { return r.q; }), ts = g.map(function (r) { return r.t; });
        var qMax = Math.max.apply(null, qs), qMin = Math.min.apply(null, qs);
        out.qRatio = qMax / qMin;
        if (out.qRatio < o.qRatioMin) {
            out.reason = 'Rate ratio ' + fmt(out.qRatio, 2) + ' is below ' + fmt(o.qRatioMin, 1) + ': D cannot be separated from S; S′ is the apparent skin including D·q.';
            return out;
        }
        var corr = (g.length === 2) ? 1 : pearson(qs, ts);
        if (corr == null) corr = (g.length === 2) ? 1 : 0;
        out.corrQT = corr;
        if (Math.abs(corr) >= o.corrMax) {
            out.reason = 'Rate and time are collinear (|corr| ' + fmt(Math.abs(corr), 2) + ' ≥ ' + fmt(o.corrMax, 1) + '): D cannot be separated from a skin trend; joint fit refused.';
            return out;
        }
        var w = g.map(function (r) { return 1 / sq(r.se); });
        var fit = wls(g.map(function (r) { return [1, r.q]; }), g.map(function (r) { return r.S; }), w);
        if (!fit) { out.reason = 'The rate-skin fit is singular.'; return out; }
        var infl = fit.dof > 0 ? Math.max(1, fit.chi2 / fit.dof) : 1;
        var S = fit.beta[0], D = fit.beta[1], seD = Math.sqrt(fit.cov[1][1] * infl);
        var trendNote = '';
        if (o.joint && g.length >= o.jointMinN) {
            var jf = wls(g.map(function (r) { return [1, r.t / 30, r.q]; }), g.map(function (r) { return r.S; }), w);
            if (jf) {
                var ji = jf.dof > 0 ? Math.max(1, jf.chi2 / jf.dof) : 1;
                var seR = Math.sqrt(jf.cov[1][1] * ji), seDj = Math.sqrt(jf.cov[2][2] * ji);
                out.joint = { S0: fin(jf.beta[0]), r_per30d: fin(jf.beta[1]), D: fin(jf.beta[2]), seD: fin(seDj), seR: fin(seR) };
                if (isNum(seR) && seR > 0 && Math.abs(jf.beta[1]) / seR >= o.dOverSeMin) {
                    var tMean = ts.reduce(function (a, b) { return a + b; }, 0) / ts.length;
                    S = jf.beta[0] + jf.beta[1] * tMean / 30;
                    D = jf.beta[2]; seD = seDj;
                    trendNote = ' A skin trend of ' + fmt(jf.beta[1], 2) + ' per 30 days was fitted jointly.';
                }
            }
        }
        out.S = fin(S); out.D = fin(D); out.seD = fin(seD);
        if (!isNum(D) || !isNum(seD)) { out.reason = 'The rate-skin fit failed.'; out.S = out.D = out.seD = null; return out; }
        if (D <= 0) {
            out.reason = 'Fitted D is not positive (' + fmt(D, 6) + '): not physical; S′ is the apparent skin.' + trendNote;
        } else if (!(seD > 0) || D / seD >= o.dOverSeMin) {
            out.resolved = true;
            out.reason = 'D resolved: D/se ' + (seD > 0 ? fmt(D / seD, 1) : 'large') + ' from ' + g.length + ' tests with a rate ratio of ' + fmt(out.qRatio, 2) + '.' + trendNote;
        } else {
            out.reason = 'D/se ' + fmt(D / seD, 1) + ' is below 2: D not resolved; S′ is the apparent skin including D·q.' + trendNote;
        }
        if (out.resolved && out.expectedD) out.consistent = D >= out.expectedD.lo && D <= out.expectedD.hi;
        return out;
    }

    // =========================================================================
    // SECTION 5 — SKIN PRODUCTS (T7, T8, M§A27)
    // =========================================================================
    // products({S, k, h, B, mu, q, Dq, rw, re_ft, reSource, pbar|null, pwf})
    //   → {dpSkin_psi, m, X, reAssumed, piRatio, piRatioLowerBound, rateAtStakeUpperBound,
    //      FE|null, DR|null, guard}
    // m = 162.6·Dq·B·μ/(k·h) [psi/cycle]; Δp_skin = 0.8686·m·S; X = ln(r_e/rw) − 0.75;
    // PI ratio X/(X + S) (pseudo-steady state); guard = X + S < 1 (not computable).
    // dpPerSkin_psi = 141.2·q·B·μ/(k·h) is the constant-rate extra drawdown per unit
    // skin at the current rate q: a different quantity from Δp_skin, never equated.
    function products(i) {
        i = i || {};
        var S = num(i.S), k = num(i.k), h = num(i.h), B = num(i.B), mu = num(i.mu), q = num(i.q), Dq = num(i.Dq);
        var rw = num(i.rw), re = num(i.re_ft), pbar = num(i.pbar), pwf = num(i.pwf);
        var reSource = i.reSource === 'rinv' ? 'rinv' : 'input';
        var out = {
            dpSkin_psi: null, m: null, X: null, reAssumed: reSource === 'rinv', reSource: reSource,
            piRatio: null, piRatioLowerBound: reSource === 'rinv', rateAtStakeUpperBound: reSource === 'rinv',
            FE: null, DR: null, guard: false, dpPerSkin_psi: null, qIdealFactor: null, drawdown_psi: null,
            labels: {
                basis: 'pseudo-steady-state estimate',
                piRatio: reSource === 'rinv' ? 'lower bound (r_e assumed from r_inv)' : 'pseudo-steady-state estimate',
                rateAtStake: reSource === 'rinv' ? 'upper bound (r_e assumed from r_inv)' : 'pseudo-steady-state estimate'
            },
            warnings: []
        };
        if (isNum(Dq)) Dq = Math.abs(Dq);
        if (isNum(q)) q = Math.abs(q);
        if (pos(k) && pos(h) && pos(B) && pos(mu)) {
            if (pos(Dq)) out.m = 162.6 * Dq * B * mu / (k * h);
            if (pos(q)) out.dpPerSkin_psi = 141.2 * q * B * mu / (k * h);
        } else out.warnings.push(warning('noKh', 'info', 'k, h, B or μ missing: m and the skin pressure drop are not computed.'));
        if (isNum(out.m) && isNum(S)) out.dpSkin_psi = 0.8686 * out.m * S;
        if (pos(re) && pos(rw) && re > rw) {
            out.X = Math.log(re / rw) - 0.75;
            if (isNum(S)) {
                if (out.X + S < 1) {
                    out.guard = true;
                    out.warnings.push(warning('guard', 'warn', 'PI ratio not computable (strongly negative skin: X + S < 1).'));
                } else {
                    out.piRatio = out.X / (out.X + S);
                    out.qIdealFactor = (out.X + S) / out.X;
                }
            }
        } else out.warnings.push(warning('noRe', 'info', 'Drainage radius not available: PI ratio not computed.'));
        if (isNum(pbar) && isNum(pwf)) {
            var dd = Math.abs(pbar - pwf);
            if (dd > 0) {
                out.drawdown_psi = dd;
                if (isNum(out.dpSkin_psi)) {
                    out.FE = (dd - out.dpSkin_psi) / dd;
                    out.DR = out.FE !== 0 ? fin(1 / out.FE) : null;
                }
            }
        }
        return out;
    }

    // =========================================================================
    // SECTION 9 — EXPORTS
    // =========================================================================
    SC.version = '1.0';
    SC.KT = KT;
    SC.perforationSkin = perforationSkin;
    SC.mechanicalSkin = mechanicalSkin;
    SC.rateSkin = rateSkin;
    SC.products = products;
    SC.expectedD = expectedD;
    SC.RATE_DEFAULTS = RATE_DEFAULTS;
    SC._ktCompute = ktCompute;          // table-consistency test only
    SC._papatzacos = papatzacos;        // tests only
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var SC = G.PRiSM_skinCheck;
    if (!SC || typeof SC.products !== 'function') return;
    var checks = [];
    function near(name, a, b, tol) { checks.push([name, typeof a === 'number' && Math.abs(a - b) <= tol]); }
    // Karakas–Tariq arithmetic (rw 0.406 ft, lp 8 in, rp 0.25 in, kh/kv 3, 2 spf).
    var base = { rw_ft: 0.406, lp_in: 8, rp_in: 0.25, spf: 2, kvkh: 1 / 3 };
    function kt(ph) { var o = {}; for (var k in base) o[k] = base[k]; o.phase_deg = ph; return SC._ktCompute(o).S_perf; }
    near('KT 180', kt(180), 2.19, 0.006); near('KT 0', kt(0), 3.09, 0.006);
    near('KT 90', kt(90), 2.03, 0.006); near('KT 60', kt(60), 2.29, 0.006);
    checks.push(['perforationSkin gated', SC.KT.verified || SC.perforationSkin(base).code === 'UNVERIFIED']);
    // Papatzacos: full penetration → 0.
    near('papatzacos full', SC._papatzacos(1, 0, 0.01), 0, 1e-12);
    // Products: m, Δp_skin, PI ratio.
    var p = SC.products({ S: 7.4, k: 45, h: 50, B: 1.2, mu: 1, q: 800, Dq: 800, rw: 0.354, re_ft: 0.354 * Math.exp(8.43) });
    near('m', p.m, 162.6 * 800 * 1.2 / 2250, 1e-9);
    near('X', p.X, 7.68, 1e-9);
    near('PI ratio', p.piRatio, 7.68 / 15.08, 1e-9);
    // Rate skin: exact S′ = 1 + 1e-4·q on 3 + 3 tests at q 10000 / 5000.
    var rows = [], qs = [10000, 5000, 10000, 5000, 10000, 5000];
    for (var j = 0; j < 6; j++) rows.push({ id: 'B' + (j + 1), t_days: 7 * j, q: qs[j], S: 1 + 1e-4 * qs[j], Serr: 0.2 });
    var rs = SC.rateSkin(rows);
    checks.push(['rateSkin resolved', rs.resolved === true]);
    near('rateSkin D', rs.D, 1e-4, 1e-12);
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[54-prism-skin self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.PRiSM_skinCheck_selfTest = checks;
})();
