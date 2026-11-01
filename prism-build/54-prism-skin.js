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
// SKIN-CHECK CARD (plan §6.11):
//   run(opts)            SkinCheck card model for PRiSM's current analysis. Pure:
//                        reads C1/C2/C4 (PRiSM_getWell, PRiSM_getAnalysisData,
//                        PRiSM_getLastFit) and calls the PRiSM_autoInterp pieces
//                        (prepare, storage, iarf, line, reach, triggers,
//                        agreement, sErr, sensitivity, confidence). No fit runs.
//   renderPanel(el)      the card (Tab 6 panel 'prism_skincheck', order 8).
//                        Tools drawer: listed from the Tab-6 registration under
//                        "Step panels" with its written title; exported as
//                        window.PRiSM_renderSkinCheckPanel once 37's
//                        TOOL_CATALOGUE lists that name (see SECTION 9). Render
//                        writes no state and fires no event. Every DOM lookup
//                        stays inside the card's own root, so a hidden Tab-6
//                        copy and a Tools-drawer copy never cross-update.
//   reportSection(model) the PRiSM report section {id:'skincheck', order 45}.
//   User actions only: "Use this window in the straight-line panel"
//   (PRiSM_semilogAnalysis(null, null, {window, store:true}); the window is
//   converted to PRiSM's pseudo-time axis when gas pseudo-time is on), "Run
//   C-held refits" (a homogeneous fit seeded from the match, then cHeldJob,
//   both through PRiSM_autoInterp.drive — the only timers, owned by 53), and
//   the completion inputs (saved in wts_prism_skincheck, a per-well key).
//   PRiSM's rate is entered or tabled, so the rate checks are 'n/a' (no KC4).
//   Drawdowns and injection periods from pi are passed to the build-up engine
//   as a build-up after a very long producing time (Δt_e = Δt, the drawdown Δp
//   mirrored about pi): the labels are calibrated on build-ups and are
//   indicative there, as the card says. p* is not shown for them; pwf for the
//   flow efficiency is the last sample of the period (lowest for a drawdown,
//   highest for an injection).
//   Build-ups with neither a rate history nor tp: the producing time is
//   estimated as in D13 (max(30 d, 10·Δt_end) at the entered rate,
//   history.estimated = true, source 'default'). p* is then not shown (the
//   engine's p* range is, when it gives one), the flow efficiency uses pi
//   (never p*), and the history sensitivity (plan §4.6 item 14) is checked
//   analytically: doubling the producing time tp changes the derivative at
//   the end of the IARF window by Δt1/(2·tp + Δt1); more than 2 % → KC1.
//   Gas: the engine gets real Δt (adata.tReal when pseudo-time is on; the
//   engine applies pseudo-time itself through spec.gas.pseudoTime) and pressure
//   in psia; Δp_skin is Δm_S = 0.8686·m·S′ (m = 1637·q·T/kh) converted to psi
//   through PRiSM's m(p) table, or not shown when no table is available.
//   Expensive engine steps (prepare, storage, IARF, line) are cached by the
//   analysed period and well inputs, so a fit-only change re-runs only the
//   cheap parts.
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
//   RB/STB (or RB/Mscf), STB/d | Mscf/d | bbl/d, psia, psi/cycle, days, hours.
//   PRiSM is field-unit only, so the card shows field units in Metric mode too.
// Every output number is finite or null; text never says null/undefined/NaN.
// Load rules: no document, no timers, no other PRiSM symbol needed at load;
// listeners are attached only behind typeof document !== 'undefined' &&
// typeof document.addEventListener === 'function' (plan §3.0; they listen on
// window, where 34 and 33 dispatch) and every handler first checks that a card
// is mounted.
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
    var RATE_DEFAULTS = Object.freeze({ qRatioMin: 1.5, maxDays: 60, joint: true, stable: null, corrMax: 0.8, dOverSeMin: 2, jointMinN: 4, serrMin: 0.05, serrDefault: 0.2, expectedFactor: 3 });

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
    // Expected D for a gas well (1/(Mscf/d)): {D (central), lo, hi, beta, unit, method} or null.
    // rateSkin reports the central value as the number expectedD and this object as expectedDRange.
    function expectedDRange(e) {
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

    // rateSkin(rows [{id, t_days, q, S, Serr}], opts {qRatioMin, maxDays, joint, stable, expected})
    //   → {resolved, S, D, seD, n, qRatio, joint:null|{S0, r_per30d, D, seD, seR}, expectedD:number|null,
    //      expectedDRange:null|{D, lo, hi, beta, unit, method}, consistent, corrQT, ids, reason, ev:['T15']}
    // Window: the tests inside the span of at most maxDays (first to last test) that holds
    // the most tests, the latest such window on a tie. A chain of weekly tests over a year
    // is therefore never one group (a skin trend would be confounded with D).
    // D needs q_max/q_min ≥ qRatioMin and D/se ≥ 2. Collinearity of rate and time
    // (|corr(q, t)| ≥ 0.8; two tests count as collinear) refuses:
    //   • the joint fit with a time term, always (plan §4.7 T15, resolution 9);
    //   • the plain (S, D) fit too, unless the caller states opts.stable === true, i.e.
    //     it has checked that S′ shows no significant time trend in these rows (for
    //     example Mann–Kendall over a stable-skin segment). Without that statement a
    //     skin trend cannot be told from D when rate and time move together.
    // A joint fit S′ = S0 + r·t/30 + D·q runs with ≥ 4 tests and low collinearity; when its
    // time term is significant (|r|/se ≥ 2) D comes from it.
    // expectedD is the central value of the correlation (a number, as plan §3.0 requires
    // for every output number); expectedDRange carries its ×1/3 … ×3 range.
    function rateSkin(rows, opts) {
        var o = {};
        var k;
        for (k in RATE_DEFAULTS) if (Object.prototype.hasOwnProperty.call(RATE_DEFAULTS, k)) o[k] = RATE_DEFAULTS[k];
        if (opts && typeof opts === 'object') for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k) && opts[k] != null) o[k] = opts[k];
        var out = { resolved: false, S: null, D: null, seD: null, n: 0, qRatio: null, joint: null, expectedD: null, expectedDRange: null,
                    consistent: null, corrQT: null, ids: [], stable: o.stable === true, reason: '', ev: ['T15'] };
        out.expectedDRange = expectedDRange(o.expected);
        out.expectedD = out.expectedDRange ? fin(out.expectedDRange.D) : null;
        var list = [];
        (Array.isArray(rows) ? rows : []).forEach(function (r) {
            if (!r || typeof r !== 'object') return;
            var q = num(r.q), S = num(r.S), t = num(r.t_days), se = num(r.Serr);
            if (!isNum(q) || q === 0 || !isNum(S) || !isNum(t)) return;
            if (!isNum(se) || se < 0) se = o.serrDefault;
            list.push({ id: r.id == null ? '' : String(r.id), q: Math.abs(q), S: S, t: t, se: Math.max(se, o.serrMin) });
        });
        list.sort(function (a, b) { return a.t - b.t; });
        // The window of span ≤ maxDays with the most tests (the latest on a tie).
        var g = [], i0 = 0;
        for (var j = 0; j < list.length; j++) {
            while (list[j].t - list[i0].t > o.maxDays + 1e-9) i0++;
            if (j - i0 + 1 >= g.length) g = list.slice(i0, j + 1);
        }
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
        var collinear = Math.abs(corr) >= o.corrMax;
        if (collinear && !out.stable) {
            out.reason = 'Rate and time are collinear (|corr| ' + fmt(Math.abs(corr), 2) + ' ≥ ' + fmt(o.corrMax, 1) + ') and skin stability was not assessed: D cannot be separated from a skin trend; joint fit refused.';
            return out;
        }
        var w = g.map(function (r) { return 1 / sq(r.se); });
        var fit = wls(g.map(function (r) { return [1, r.q]; }), g.map(function (r) { return r.S; }), w);
        if (!fit) { out.reason = 'The rate-skin fit is singular.'; return out; }
        var infl = fit.dof > 0 ? Math.max(1, fit.chi2 / fit.dof) : 1;
        var S = fit.beta[0], D = fit.beta[1], seD = Math.sqrt(fit.cov[1][1] * infl);
        var trendNote = collinear ? ' Rate and time are collinear (|corr| ' + fmt(Math.abs(corr), 2) + '): joint fit with a time term refused; skin stability as stated by the caller.' : '';
        if (o.joint && !collinear && g.length >= o.jointMinN) {
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
        if (out.resolved && out.expectedDRange) out.consistent = D >= out.expectedDRange.lo && D <= out.expectedDRange.hi;
        return out;
    }

    // =========================================================================
    // SECTION 5 — SKIN PRODUCTS (T7, T8, M§A27)
    // =========================================================================
    // products({S, k, h, B, mu, q, Dq, rw, re_ft, reSource, pbar|null, pwf, dpSkin_psi?})
    //   → {dpSkin_psi, m, X, reAssumed, piRatio, piRatioLowerBound, piRatioUpperBound,
    //      rateAtStakeUpperBound, rateAtStakeLowerBound, FE|null, DR|null, guard, labels}
    // m = 162.6·Dq·B·μ/(k·h) [psi/cycle]; Δp_skin = 0.8686·m·S; X = ln(r_e/rw) − 0.75;
    // PI ratio X/(X + S) (pseudo-steady state); guard = X + S < 1 (not computable).
    // A finite dpSkin_psi input replaces 0.8686·m·S (gas: Δm_S converted to psi through
    // the m(p) table by the caller).
    // dpPerSkin_psi = 141.2·q·B·μ/(k·h) is the constant-rate extra drawdown per unit
    // skin at the current rate q: a different quantity from Δp_skin, never equated.
    // Bounds when r_e is assumed from r_inv (r_inv ≤ r_e, so X is low): X/(X + S) rises
    // with X when S ≥ 0 and falls when S < 0, so the PI ratio is a lower bound for S ≥ 0
    // and an upper bound for S < 0; the rate at stake (X + S)/X − 1 = S/X is an upper
    // bound for S ≥ 0 and a lower bound (too negative) for S < 0. For a change from
    // S_base to S_now the same holds with the sign of S_now − S_base (WP3, §4.7).
    function products(i) {
        i = i || {};
        var S = num(i.S), k = num(i.k), h = num(i.h), B = num(i.B), mu = num(i.mu), q = num(i.q), Dq = num(i.Dq);
        var rw = num(i.rw), re = num(i.re_ft), pbar = num(i.pbar), pwf = num(i.pwf), dpIn = num(i.dpSkin_psi);
        var reSource = i.reSource === 'rinv' ? 'rinv' : 'input';
        var rinv = reSource === 'rinv', negS = isNum(S) && S < 0;
        var RINV = ' (r_e assumed from r_inv)';
        var out = {
            dpSkin_psi: null, m: null, X: null, reAssumed: rinv, reSource: reSource,
            piRatio: null, piRatioLowerBound: rinv && !negS, piRatioUpperBound: rinv && negS,
            rateAtStakeUpperBound: rinv && !negS, rateAtStakeLowerBound: rinv && negS,
            FE: null, DR: null, guard: false, dpPerSkin_psi: null, qIdealFactor: null, drawdown_psi: null, dpSkinSource: null,
            labels: {
                basis: 'pseudo-steady-state estimate',
                piRatio: rinv ? (negS ? 'upper bound' : 'lower bound') + RINV : 'pseudo-steady-state estimate',
                rateAtStake: rinv ? (negS ? 'lower bound' : 'upper bound') + RINV : 'pseudo-steady-state estimate'
            },
            warnings: []
        };
        if (isNum(Dq)) Dq = Math.abs(Dq);
        if (isNum(q)) q = Math.abs(q);
        if (pos(k) && pos(h) && pos(B) && pos(mu)) {
            if (pos(Dq)) out.m = 162.6 * Dq * B * mu / (k * h);
            if (pos(q)) out.dpPerSkin_psi = 141.2 * q * B * mu / (k * h);
        } else if (!isNum(dpIn)) out.warnings.push(warning('noKh', 'info', 'k, h, B or μ missing: m and the skin pressure drop are not computed.'));
        if (isNum(dpIn)) { out.dpSkin_psi = dpIn; out.dpSkinSource = 'input'; }
        else if (isNum(out.m) && isNum(S)) { out.dpSkin_psi = 0.8686 * out.m * S; out.dpSkinSource = 'liquid'; }
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
    // SECTION 6 — SKIN-CHECK MODEL: run(opts)  (pure)
    // =========================================================================
    var ENGINE_KEYS = { homogeneous: 'homogeneous', linearBoundary: 'linearBoundary', closedCircle: 'closedCircle', radialComposite: 'composite2', composite2: 'composite2' };
    var REQ_RANGES = Object.freeze({ h: 0.2, phi: 0.2, ct: 0.2, rw: 0.2, B: 0.2, mu: 0.2, q: 0.1 });
    var TYP_RANGES = Object.freeze({ h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 });
    var DISTRACTORS = { valley: 1, halfLate: 1, earlyQuarter: 1, earlyHalf: 1, fracHalf: 1 };
    var HUMPS = { humpDp: 1, steepStorage: 1 };
    var TP_LONG_H = 1e6;     // drawdown / injection → build-up after a very long producing time
    var TP_DEFAULT_MIN_H = 720, TP_DEFAULT_FACTOR = 10;   // D13: unknown tp → max(30 d, 10·Δt_end)
    var CHELD_NOTE = 'Calibrated on build-ups; indicative for drawdowns.';

    function AIns() { var a = G.PRiSM_autoInterp; return (a && typeof a === 'object') ? a : null; }
    function engineReady(a) {
        return !!(a && ['prepare', 'iarf', 'line'].every(function (k) { return typeof a[k] === 'function'; }));
    }
    function call(name, fn) {
        try { return { v: fn(), err: null }; }
        catch (e) {
            if (typeof console !== 'undefined' && console.warn) console.warn('[PRiSM skin check] ' + name + ' failed:', e);
            return { v: null, err: name };
        }
    }
    function median(a) {
        var b = a.filter(isNum).sort(function (x, y) { return x - y; });
        if (!b.length) return null;
        var m = b.length >> 1;
        return b.length % 2 ? b[m] : 0.5 * (b[m - 1] + b[m]);
    }
    function toArr(v) { return (v && typeof v.length === 'number') ? Array.prototype.slice.call(v) : []; }
    // Robust gauge noise from second differences (white noise: var(d2) = 6σ²), late half.
    function noiseOf(p) {
        var n = p.length;
        if (n < 8) return 0.01;
        var d2 = [];
        for (var i = Math.max(1, n >> 1); i < n - 1; i++) d2.push(p[i + 1] - 2 * p[i] + p[i - 1]);
        var md = median(d2);
        var mad = median(d2.map(function (x) { return Math.abs(x - md); }));
        var s = 1.4826 * (mad || 0) / Math.sqrt(6);
        return Math.max(isNum(s) ? s : 0, 1e-4);
    }
    function linSlope(x, y) {
        var n = x.length;
        if (n < 3) return null;
        var mx = 0, my = 0, i;
        for (i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
        mx /= n; my /= n;
        var sxx = 0, sxy = 0;
        for (i = 0; i < n; i++) { sxx += sq(x[i] - mx); sxy += (x[i] - mx) * (y[i] - my); }
        return sxx > 0 ? sxy / sxx : null;
    }
    function fluidOf(well, adata) {
        var f = (adata && adata.fluid) || (well && well.fluid) || 'oil';
        if (f === 'gas') return 'gas';
        if ((adata && (adata.testType === 'falloff' || adata.testType === 'injection')) || f === 'water') return 'water_inj';
        return 'oil';
    }
    function qUnitOf(fluid) { return fluid === 'gas' ? 'Mscf/d' : (fluid === 'water_inj' ? 'bbl/d' : 'STB/d'); }

    // BuildupSpec (plan §3.1) from PRiSM's C2 analysis data and C1 well.
    function specFromAdata(adata, well) {
        var tt = adata.testType;
        var shut = tt === 'buildup' || tt === 'falloff';
        var fromPi = adata.dRef === 'pi' || adata.pRefSource === 'pi';
        var steps0 = toArr(adata.rateHistory);
        var nIdx = isNum(adata.stepIndex) ? adata.stepIndex : steps0.length - 1;
        if (!shut && nIdx > 0) return { ok: false, reason: 'The automatic checks need a build-up, a fall-off or the first flow period from pi; this is a later flow period.' };
        // Gas pseudo-time: C2 puts t_a in adata.t and keeps the real Δt in adata.tReal. The engine
        // takes real Δt (like spec.steps) and applies pseudo-time itself (spec.gas.pseudoTime).
        // adata.p is always psia (m(p) only lives in adata.dp / pRef).
        var pseudoT = hasRealTime(adata);
        if (adata.pseudoTime && !pseudoT) return { ok: false, reason: 'Gas pseudo-time is on but the real elapsed time is not available: turn pseudo-time off for the skin check.' };
        var T = toArr(pseudoT ? adata.tReal : adata.t), P = toArr(adata.p);
        var pRef = num(adata.pRefPressure);
        if (pRef == null) pRef = num(adata.pRef);
        if (!pos(pRef)) return { ok: false, reason: 'The reference pressure of the analysed period is unknown.' };
        var fluid = fluidOf(well, adata);
        if (!shut && fluid === 'gas') return { ok: false, reason: 'For gas wells the automatic checks need a build-up or a fall-off period.' };
        var dt = [], p = [], last = -Infinity;
        for (var i = 0; i < T.length; i++) {
            if (!(T[i] > last) || !isNum(P[i])) continue;
            last = T[i];
            dt.push(T[i]);
            p.push(shut || tt === 'injection' ? P[i] : 2 * pRef - P[i]);   // drawdown: Δp mirrored about pi
        }
        if (dt.length < 10) return { ok: false, reason: 'Fewer than 10 samples in the analysed period.' };
        var Dq = num(adata.qRef);
        if (!pos(Dq)) Dq = pos(well.q) ? well.q : null;
        if (!pos(Dq)) return { ok: false, reason: 'The rate before the analysed period is unknown: enter q in Well & Test.' };
        var tc = num(adata.tStart);
        if (tc == null) tc = 0;
        var dtEnd = dt[dt.length - 1];
        var steps, tpUnknown = false, history = { estimated: false, tPrepend_h: 0, source: 'data' };
        if (shut && steps0.length >= 2) {
            steps = steps0.map(function (s) { return { t: s.t, q: Math.abs(s.q) }; });
            steps[steps.length - 1] = { t: tc, q: 0 };
        } else if (shut) {
            // No rate history and no tp: estimate the producing time as D13 does
            // (max(30 d, 10·Δt_end) at the entered rate) and flag the history as estimated,
            // so p* is reported as a range only and the history sensitivity is checked.
            var tPre = Math.max(TP_DEFAULT_MIN_H, TP_DEFAULT_FACTOR * dtEnd);
            steps = [{ t: tc - tPre, q: Dq }, { t: tc, q: 0 }];
            history = { estimated: true, tPrepend_h: tPre, source: 'default' };
            tpUnknown = true;
        } else {
            // Drawdown / injection from pi: a build-up after a very long producing time
            // (Δt_e = Δt). A modelling device, not an estimate of the history.
            steps = [{ t: tc - TP_LONG_H, q: Dq }, { t: tc, q: 0 }];
        }
        var sigma = noiseOf(p);
        var dts = [];
        for (var j = 1; j < dt.length; j++) dts.push(dt[j] - dt[j - 1]);
        // Flowing-trend slope at the closing (buildups with flowing samples in the dataset).
        var dpdt = 0, ds = G.PRiSM_dataset;
        if (shut && ds && ds.t && ds.p) {
            var DT = toArr(ds.t), DP = toArr(ds.p), fx = [], fy = [];
            for (var k = DT.length - 1; k >= 0 && fx.length < 12; k--) {
                if (DT[k] <= tc + 1e-12 && DT[k] >= tc - 2 && isNum(DP[k])) { fx.unshift(DT[k]); fy.unshift(DP[k]); }
            }
            var sl = linSlope(fx, fy);
            if (isNum(sl)) dpdt = sl;
        }
        // pwf0 uncertainty: entered → 0; a data row → σ; extrapolated / first sample → a trend value.
        var src = adata.pRefSource, pwf0SE = 0, pwfTrend = false;
        if (shut) {
            var entered = pos(well.pwf0) && well.provenance && well.provenance.pwf0 && well.provenance.pwf0 !== 'default';
            if (entered) pwf0SE = 0;
            else if (src === 'pwf0') pwf0SE = sigma;
            else { pwf0SE = Math.max(sigma, p.length > 1 ? 0.5 * Math.abs(p[1] - p[0]) : sigma); pwfTrend = true; }
        }
        var spec = {
            id: 'PRiSM', testType: tt === 'falloff' ? 'falloff' : 'buildup',
            tc_h: tc, dtc_h: 0, pwf0: pRef, pwf0SE: pwf0SE, dpdt_flow: dpdt,
            dt: dt, p: p, n: null, steps: steps, qUnit: qUnitOf(fluid), Dq: Dq, fRate: 1,
            rateQC: { source: /dataset/.test(String(adata.rateSource || '')) ? 'table' : 'measured', r3: null, r3Status: 'n/a', r4: null, r4Status: 'n/a',
                      dqKnown: true, dqSource: 'table', equalRateAssumed: false, ignoresShutin: false, allocAccPct: 5 },
            well: { fluid: fluid, h: well.h, phi: well.phi, mu: well.mu, B: well.B, ct: well.ct, rw: well.rw,
                    T_R: pos(well.T_R) ? well.T_R : null, re_ft: null,
                    defaulted: toArr(well.defaulted).filter(function (k) { return ['h', 'phi', 'mu', 'B', 'ct', 'rw'].indexOf(k) !== -1; }) },
            gas: fluid === 'gas' ? { sg: pos(well.sg) ? well.sg : 0.65, T_F: pos(well.T_F) ? well.T_F : 200, co2: 0, h2s: 0, n2: 0,
                                     pseudoTime: pseudoT, pdew: null } : null,
            sigma_psi: sigma, sigmaFlow_psi: sigma, sigmaLF_psi: null,
            dtSample_h: median(dts) || 0.01, driftPsiPerDay: 0.01,
            history: history,
            overrides: { window: null, model: null, excludeRivals: [] },
            opts: { Lcyc: 0.1, binsPerCycle: 20, fitBinsPerCycle: 12, rivals: 'none', cheld: 'off', tide: 'off' }
        };
        return { ok: true, spec: spec, shut: shut, indicative: !shut, tpUnknown: tpUnknown, fromPi: fromPi, pwfTrend: pwfTrend, sigma: sigma,
                 dtEnd_h: dtEnd, pseudoTime: pseudoT };
    }

    // Plan §4.6 item 14 for a single-rate estimated history (the only estimated history the
    // card builds): in radial flow the response to a history twice as long, differentiated
    // with the assumed time function, changes by Δt/(2·tp + Δt). Evaluated at the end of
    // the IARF window (the largest change inside it); > maxDerivPct (2 %) → sensitive (KC1).
    function historyCheck(spec, iarf, AI) {
        var h = spec && spec.history;
        var out = { estimated: !!(h && h.estimated), tPrepend_h: h ? fin(h.tPrepend_h) : null, dDerivPct: null, sensitive: false, ev: ['R5'] };
        if (!out.estimated) return out;
        var maxPct = (AI && AI.DEFAULTS && AI.DEFAULTS.history && isNum(AI.DEFAULTS.history.maxDerivPct)) ? AI.DEFAULTS.history.maxDerivPct : 2;
        var tp = h.tPrepend_h, dt1 = iarf && iarf.found ? num(iarf.dt1_h) : null;
        if (!pos(tp) || !pos(dt1)) return out;
        out.dDerivPct = 100 * dt1 / (2 * tp + dt1);
        out.sensitive = out.dDerivPct > maxPct;
        return out;
    }

    // C2 with gas pseudo-time: adata.t = t_a and adata.tReal = the real Δt, sample for sample.
    function hasRealTime(adata) {
        return !!(adata && adata.pseudoTime && adata.tReal && adata.t && adata.tReal.length === adata.t.length);
    }
    // Real shut-in Δt → PRiSM's analysis time (pseudo-time t_a when it is on): log-log
    // interpolation along (adata.tReal, adata.t), both ascending. null outside the data.
    function toPrismTime(adata, dtReal) {
        if (!hasRealTime(adata)) return pos(dtReal) ? dtReal : null;
        var R = toArr(adata.tReal), A = toArr(adata.t);
        if (!pos(dtReal) || R.length < 2) return null;
        if (dtReal < R[0] * (1 - 1e-9) || dtReal > R[R.length - 1] * (1 + 1e-9)) return null;
        for (var i = 1; i < R.length; i++) {
            if (R[i] >= dtReal) {
                var r0 = R[i - 1], r1 = R[i], a0 = A[i - 1], a1 = A[i];
                if (!pos(r0) || !pos(r1) || !pos(a0) || !pos(a1) || !(r1 > r0)) return dtReal <= r0 ? fin(a0) : fin(a1);
                var u = (Math.log(dtReal) - Math.log(r0)) / (Math.log(r1) - Math.log(r0));
                return fin(Math.exp(Math.log(a0) + Math.max(0, Math.min(1, u)) * (Math.log(a1) - Math.log(a0))));
            }
        }
        return fin(A[A.length - 1]);
    }

    // Gas Δp_skin (plan §4.6 item 13): Δm_S = 0.8686·m·S′ with m = 1637·q·T_R/(k·h)
    // (so Δm_S = 1422·q·T_R·S′/(k·h), psi²/cp), converted to psi at the flowing
    // pressure with PRiSM's m(p) table: Δp_skin = p(m(pwf) + Δm_S) − pwf. null when the
    // table or an input is missing (the card then does not show Δp_skin or FE).
    function gasDpSkin(adata, well, k, S, q, pwf) {
        var spec = adata && adata.mpSpec;
        if (!spec || typeof G.PRiSM_mpTable !== 'function') return null;
        var TF = num(spec.T_F);
        if (!isNum(TF)) TF = num(well && well.T_F);
        var h = num(well && well.h);
        if (!isNum(TF) || !pos(k) || !pos(h) || !pos(q) || !isNum(S) || !pos(pwf)) return null;
        var tbl = null;
        try { tbl = G.PRiSM_mpTable(spec); } catch (e) { tbl = null; }
        if (!tbl || typeof tbl.mOf !== 'function' || typeof tbl.pOf !== 'function') return null;
        var dm = 1422 * q * (TF + 459.67) * S / (k * h);
        var m0 = tbl.mOf(pwf);
        if (!isNum(m0) || !(m0 + dm > 0)) return null;
        var p1 = tbl.pOf(m0 + dm);
        return isNum(p1) ? fin(p1 - pwf) : null;
    }

    // PRiSM C4 fit → a ModelFit-like object for the engine (homogeneous base for
    // the storage/IARF checks; the engine key when the model is in its set).
    function matchFromFit(fit, engineKey) {
        if (!fit || !fit.phys) return null;
        var ph = fit.phys, pr = fit.params || {};
        var k = num(ph.k), S = isNum(num(ph.S)) ? num(ph.S) : num(pr.S), C = num(ph.C);
        if (!pos(k) || !isNum(S)) return null;
        var ci = fit.ci95 || {};
        function se(key) {
            var c = ci[key];
            return (c && isNum(c[0]) && isNum(c[1])) ? Math.abs(c[1] - c[0]) / (2 * 1.96) : null;
        }
        function ci95(key) { var c = ci[key]; return (c && isNum(c[0]) && isNum(c[1])) ? [c[0], c[1]] : null; }
        var params = {};
        Object.keys(pr).forEach(function (kk) { var v = pr[kk]; if (isNum(v) || typeof v === 'string' || typeof v === 'boolean') params[kk] = v; });
        return {
            key: engineKey || 'homogeneous', base: fit.modelKey || 'homogeneous', ok: true, converged: fit.converged !== false,
            stopReason: 'prism', iterations: 0, slices: 0, nEval: 0,
            phys: { k: k, S: S, C: pos(C) ? C : null }, params: params,
            se: { k: se('k'), S: se('S'), C: se('C') }, ci95: { k: ci95('k'), S: ci95('S'), C: ci95('C') },
            corr: { CS: null, kS: null }, ssrLog: null, nDp: 0, rmseDp: null, bic: null, p: 3, eligible: true, why: [],
            fullySeen: { status: 'n/a', value: null, bound: null, text: 'Not assessed for a PRiSM match.' }
        };
    }

    // S_win from the shifted lines (bias-corrected in "bias explained" mode), plan §4.6 item 15.
    function sWinOf(line, agreement) {
        var sh = (line && Array.isArray(line.shifts)) ? line.shifts : [];
        var bias = !!(agreement && agreement.mode === 'bias');
        function c(S, bS) { return (bias && isNum(bS)) ? S - bS : S; }
        var S0 = line ? c(line.S, agreement ? agreement.biasDS : null) : null;
        if (sh.length >= 2 && isNum(sh[0].S) && isNum(sh[1].S)) return Math.abs(c(sh[0].S, sh[0].bS) - c(sh[1].S, sh[1].bS)) / 2;
        if (sh.length === 1 && isNum(sh[0].S) && isNum(S0)) return Math.abs(c(sh[0].S, sh[0].bS) - S0);
        return 0;
    }
    function rinvOf(AI, k, dt, well) {
        if (AI && typeof AI.rinv === 'function') { try { var r = AI.rinv(k, dt, well); if (isNum(r)) return r; } catch (e) { /* formula */ } }
        if (!pos(k) || !pos(dt) || !pos(well.phi) || !pos(well.mu) || !pos(well.ct)) return null;
        return 0.0325 * Math.sqrt(k * dt / (well.phi * well.mu * well.ct));
    }
    function sigOf(adata, fit, well) {
        var w = well || {};
        return [adata && adata.hash, adata && adata.periodIndex, adata && adata.testType, adata && adata.n,
                fit && fit.modelKey, fit && fit.timestamp, fit && fit.phys && fit.phys.k, fit && fit.phys && fit.phys.S,
                w.q, w.B, w.mu, w.ct, w.h, w.phi, w.rw, w.pwf0].join('|');
    }

    // One-entry cache of the expensive engine steps (prepare, storage, IARF, line), keyed by
    // the BuildupSpec itself and the engine functions in use: a fit-only change (or a second
    // card copy, or the report) re-runs only the cheap parts. Results are never mutated
    // (run() copies the line before it edits p*); a step that threw is not cached.
    var _cache = { key: null, AI: null, fns: null, v: null };
    function engineSteps(AI, spec) {
        var key = null;
        try { key = JSON.stringify(spec); } catch (e) { key = null; }
        var fns = [AI.prepare, AI.storage, AI.iarf, AI.line];
        if (key !== null && _cache.key === key && _cache.AI === AI &&
            fns.every(function (f, i) { return f === _cache.fns[i]; })) return _cache.v;
        var v = { prep: null, prepErr: null, storage: null, iarf: null, line: null, errors: [] };
        var r = call('prepare', function () { return AI.prepare(spec); });
        v.prep = r.v; v.prepErr = r.err;
        if (v.prep && v.prep.ok !== false) {
            if (typeof AI.storage === 'function') { r = call('storage', function () { return AI.storage(v.prep); }); v.storage = r.v; if (r.err) v.errors.push(r.err); }
            r = call('iarf', function () { return AI.iarf(v.prep, {}); }); v.iarf = r.v; if (r.err) v.errors.push(r.err);
            if (v.iarf && v.iarf.found) { r = call('line', function () { return AI.line(v.prep, v.iarf); }); v.line = r.v; if (r.err) v.errors.push(r.err); }
        }
        if (key !== null && !v.prepErr && !v.errors.length) _cache = { key: key, AI: AI, fns: fns, v: v };
        return v;
    }
    function shallow(o) {
        if (!o || typeof o !== 'object') return o;
        var c = {};
        for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
        return c;
    }

    // Completion inputs (card; wts_prism_skincheck).
    var LS_KEY = 'wts_prism_skincheck';
    var COMP_DEFAULT = { on: false, hp_ft: null, htop_ft: 0, theta_deg: 0, kvlo: 0.1, kvhi: 1,
                         perf: { on: false, spf: 4, lp_in: 12, rp_in: 0.2, phase_deg: 90 } };
    function normComp(o) {
        var c = JSON.parse(JSON.stringify(COMP_DEFAULT));
        if (!o || typeof o !== 'object') return c;
        c.on = !!o.on;
        ['hp_ft', 'htop_ft', 'theta_deg', 'kvlo', 'kvhi'].forEach(function (k) { var v = num(o[k]); if (v != null) c[k] = v; });
        if (o.perf && typeof o.perf === 'object') {
            c.perf.on = !!o.perf.on;
            ['spf', 'lp_in', 'rp_in', 'phase_deg'].forEach(function (k) { var v = num(o.perf[k]); if (v != null) c.perf[k] = v; });
        }
        return c;
    }
    function loadComp() {
        try {
            var ls = G.localStorage;
            var raw = ls ? ls.getItem(LS_KEY) : null;
            return normComp(raw ? JSON.parse(raw).completion : null);
        } catch (e) { return normComp(null); }
    }
    function saveComp(c) {
        var txt = JSON.stringify({ v: 1, completion: normComp(c) });
        try {
            if (typeof G.WTS_lsSet === 'function') { G.WTS_lsSet(LS_KEY, txt); return; }
            if (G.localStorage) G.localStorage.setItem(LS_KEY, txt);
        } catch (e) { /* storage optional */ }
    }
    function completionFor(c, h) {
        c = normComp(c);
        if (!c.on) return null;
        return { hp_ft: pos(c.hp_ft) ? c.hp_ft : h, htop_ft: isNum(c.htop_ft) ? c.htop_ft : 0, theta_deg: isNum(c.theta_deg) ? c.theta_deg : 0,
                 kvkh: [c.kvlo, c.kvhi],
                 perf: c.perf.on ? { spf: c.perf.spf, lp_in: c.perf.lp_in, rp_in: c.perf.rp_in, phase_deg: c.perf.phase_deg } : null };
    }

    // run(opts {adata?, fit?, well?, completion?, cheld?}) → SkinCheck card model.
    function run(opts) {
        opts = opts || {};
        var AI = AIns();
        var m = {
            ok: false, reason: '', version: SC.version, engine: engineReady(AI), indicative: false, testType: null,
            sig: '', fitKey: null, engineKey: null, matchAvailable: false,
            well: null, iarf: null, line: null, plateau: null, storage: null, reach: null, triggers: null, flags: [],
            agreement: null, final: null, sErr: null, sensitivity: null, confidence: null, evidence: null,
            products: null, mech: null, completion: null, cheld: null, cheldAvailable: false,
            tpUnknown: false, pseudoTime: false, history: null, window: null, pbarSource: null,
            rate: { status: 'n/a', source: 'measured', text: 'Entered or tabled rate: rate checks do not apply.' },
            calibrated: false, notes: [], warnings: [], errors: []
        };
        var adata = opts.adata, well = opts.well, fit = opts.fit;
        try {
            if (!adata && typeof G.PRiSM_getAnalysisData === 'function') adata = G.PRiSM_getAnalysisData();
            if (!well && typeof G.PRiSM_getWell === 'function') well = G.PRiSM_getWell();
            if (fit === undefined && typeof G.PRiSM_getLastFit === 'function') fit = G.PRiSM_getLastFit();
        } catch (e) { m.reason = 'PRiSM inputs could not be read.'; return m; }
        well = well || {};
        if (fit && fit.kind === 'rate') fit = null;
        m.sig = sigOf(adata, fit, well);
        m.completion = normComp(opts.completion !== undefined ? opts.completion : loadComp());
        m.well = { q: fin(well.q), B: fin(well.B), mu: fin(well.mu), ct: fin(well.ct), h: fin(well.h), phi: fin(well.phi), rw: fin(well.rw), fluid: well.fluid || 'oil' };
        m.notes.push(CHELD_NOTE);
        if (!adata || !adata.ok) { m.reason = (adata && adata.reason) || 'No analysis data.'; return m; }
        m.testType = adata.testType;
        var missing = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'].filter(function (k) { return !pos(well[k]); });
        if (missing.length) { m.reason = 'Well inputs missing: ' + missing.join(', ') + '. Enter them in Well & Test.'; return m; }
        if (fit) {
            m.fitKey = fit.modelKey || null;
            m.engineKey = ENGINE_KEYS[m.fitKey] || null;
        }
        if (!m.engine) { m.reason = 'The automatic interpretation engine is not loaded in this build.'; return m; }
        var sp = specFromAdata(adata, well);
        if (!sp.ok) { m.reason = sp.reason; return m; }
        m.indicative = sp.indicative;
        m.tpUnknown = sp.tpUnknown;
        m.pseudoTime = sp.pseudoTime;
        var spec = sp.spec;
        var es = engineSteps(AI, spec);
        var r;
        var prep = es.prep;
        if (!prep || prep.ok === false) {
            m.reason = (prep && prep.errors && prep.errors[0]) || es.prepErr || 'The analysed period could not be prepared for the automatic checks.';
            return m;
        }
        m.ok = true;
        var match = matchFromFit(fit, 'homogeneous');
        m.matchAvailable = !!match;
        if (fit && !match) m.warnings.push(warning('noPhys', 'info', 'The current fit has no physical k and S: line vs match not checked.'));
        if (fit && fit.stale) m.warnings.push(warning('stale', 'warn', 'The fit is for another dataset or model: re-run the fit.'));
        if (sp.tpUnknown) {
            m.warnings.push(warning('tpUnknown', 'warn', 'Producing time unknown: the checks assume ' + sig(spec.history.tPrepend_h) +
                ' h at the entered rate (30 days or 10 × the shut-in, the longer). p* is not shown and the flow efficiency uses pi. Enter tp or the rate history in Well & Test.'));
        }
        if (sp.indicative) m.warnings.push(warning('indicative', 'info', 'Drawdown or injection period: checks run as for a build-up after a long producing time; indicative only, p* not shown.'));
        m.storage = es.storage;
        m.iarf = es.iarf;
        m.line = es.line ? shallow(es.line) : null;      // a copy: the cached line is never edited
        es.errors.forEach(function (e) { m.errors.push(e); });
        // p*: not shown for drawdowns/injections (indicative) nor with an estimated producing
        // time (D13: only the range, when the engine gives one, and no rule uses p*).
        if (m.line && sp.indicative) { m.line.pStar = null; m.line.pStarRange = null; }
        if (m.line && sp.tpUnknown) {
            m.line.pStar = null;
            var pr0 = m.line.pStarRange;
            if (!(pr0 && isNum(pr0.lo) && isNum(pr0.hi)) && typeof AI.pStarRange === 'function') {
                r = call('pStarRange', function () { return AI.pStarRange(prep, es.line, spec); });
                pr0 = r.v; if (r.err) m.errors.push(r.err);
            }
            m.line.pStarRange = (pr0 && isNum(pr0.lo) && isNum(pr0.hi)) ? { lo: Math.min(pr0.lo, pr0.hi), hi: Math.max(pr0.lo, pr0.hi) } : null;
        }
        // History sensitivity (D13, plan §4.6 item 14) → KC1 through the evidence vector.
        m.history = historyCheck(spec, m.iarf, AI);
        if (m.history.estimated && isNum(m.history.dDerivPct)) {
            m.notes.push('Producing time estimated: doubling it changes the derivative at the end of the IARF window by ' + fmt(m.history.dDerivPct, 1) +
                         ' %' + (m.history.sensitive ? ' (more than 2 %: k/S label capped at medium).' : ' (within 2 %).'));
        }
        // "Use this window": the IARF window on PRiSM's own time axis (pseudo-time when on).
        m.window = null;
        if (m.iarf && m.iarf.found) {
            var w0 = toPrismTime(adata, m.iarf.dt0_h), w1 = toPrismTime(adata, m.iarf.dt1_h);
            m.window = (pos(w0) && pos(w1) && w1 > w0) ? { t0: w0, t1: w1, pseudoTime: !!sp.pseudoTime } : null;
            if (!m.window && sp.pseudoTime) m.notes.push('The IARF window could not be converted to PRiSM\'s pseudo-time axis: "Use this window" is not available.');
            else if (sp.pseudoTime) m.notes.push('Gas pseudo-time is on: the window is found on real Δt and passed to the straight-line panel in pseudo-time.');
        }
        m.plateau = m.line && m.line.plateauCheck ? m.line.plateauCheck : null;
        // Homogeneous k, S, C for the numeric reach: the match, else the line with C from storage.
        var hom = match;
        if (!hom && m.line) {
            var Cs = m.storage && pos(m.storage.C_us) ? m.storage.C_us : null;
            hom = matchFromFit({ modelKey: 'homogeneous', phys: { k: m.line.k, S: m.line.S, C: Cs } }, 'homogeneous');
        }
        if (hom && typeof AI.reach === 'function') { r = call('reach', function () { return AI.reach(prep, hom); }); m.reach = r.v; if (r.err) m.errors.push(r.err); }
        if (typeof AI.triggers === 'function') {
            r = call('triggers', function () { return AI.triggers(prep, m.iarf, m.reach); });
            if (r.v) { m.triggers = r.v.triggers || null; m.flags = Array.isArray(r.v.flags) ? r.v.flags : []; }
            if (r.err) m.errors.push(r.err);
        }
        // Line vs match (DEFAULTS.agree, D9). Engine bias check for its own model set.
        var agreeDef = (AI.DEFAULTS && AI.DEFAULTS.agree) || { kPct: 5, dS: 0.5 };
        if (m.line && match) {
            if (m.engineKey && typeof AI.agreement === 'function') {
                var em = matchFromFit(fit, m.engineKey);
                r = call('agreement', function () { return AI.agreement(m.line, em, prep); });
                m.agreement = r.v; if (r.err) m.errors.push(r.err);
            }
            if (!m.agreement) {
                var dk = (m.line.k / match.phys.k - 1) * 100, dS = m.line.S - match.phys.S;
                var ok = Math.abs(dk) <= agreeDef.kPct && Math.abs(dS) <= agreeDef.dS;
                m.agreement = { agree: ok, mode: ok ? 'raw' : 'none', dkPct: dk, dS: dS, biasKPct: null, biasDS: null, ev: ['A1'] };
                if (!m.engineKey) m.notes.push('The bias check of the line runs for homogeneous, sealing-fault, composite and closed-circle matches; this match is compared raw.');
            }
        }
        // Final k, S: the match when line and match agree, else the line, else the match.
        var agreeOK = !!(m.agreement && m.agreement.agree);
        if (match && (agreeOK || !m.line)) m.final = { k: match.phys.k, S: match.phys.S, C: match.phys.C, source: m.line ? 'match' : 'model' };
        else if (m.line) m.final = { k: m.line.k, S: m.line.S, C: match ? match.phys.C : (m.storage ? fin(m.storage.C_us) : null), source: 'line' };
        if (m.final) { m.final.kh = m.final.k * well.h; m.final.m = 162.6 * spec.Dq * well.B * well.mu / m.final.kh; }
        // Sensitivity (analytic, plan §4.6 item 16).
        if (m.final && typeof AI.sensitivity === 'function') {
            r = call('sensitivity', function () { return AI.sensitivity(m.final, spec.well, { req: REQ_RANGES, typ: TYP_RANGES }); });
            m.sensitivity = r.v; if (r.err) m.errors.push(r.err);
        }
        // C-held result from a user run on the same inputs.
        var ch = opts.cheld && opts.cheld.sig === m.sig ? opts.cheld.result : null;
        m.cheld = ch || null;
        m.cheldAvailable = typeof AI.cHeldJob === 'function' && typeof AI.drive === 'function' && !!hom;
        // S_err (D10, plan §4.6 item 15).
        var cal = G.PRiSM_autoInterpCal || null;
        m.calibrated = !!(cal && cal.calibrated);
        var floor = (cal && cal.calibrated && cal.thresholds && isNum(cal.thresholds.sErrFloor)) ? cal.thresholds.sErrFloor
                  : ((AI.DEFAULTS && AI.DEFAULTS.sErr && isNum(AI.DEFAULTS.sErr.floor)) ? AI.DEFAULTS.sErr.floor : 0.2);
        var mAbs = m.line && isNum(m.line.m) ? Math.abs(m.line.m) : (m.final ? m.final.m : null);
        if (m.final && typeof AI.sErr === 'function') {
            var parts = {
                mode: m.line ? 'line' : 'model',
                seS: match && isNum(match.se.S) ? match.se.S : 0,
                sLine: m.line ? m.line.S : null, sMatch: match ? match.phys.S : (m.line ? m.line.S : null),
                sWin: m.line ? sWinOf(m.line, m.agreement) : 0,
                sTc: (pos(mAbs) ? 1.1513 * Math.abs(spec.dpdt_flow) * spec.dtc_h / mAbs : 0),
                sPwf: (pos(mAbs) ? 1.1513 * spec.pwf0SE / mAbs : 0),
                sK: 0, sC: ch && isNum(ch.S_C) ? ch.S_C : 0,
                sSens: m.sensitivity && isNum(m.sensitivity.sSens) ? m.sensitivity.sSens : 0,
                floor: floor
            };
            r = call('sErr', function () { return AI.sErr(parts); });
            m.sErr = r.v; if (r.err) m.errors.push(r.err);
            m.sErrParts = parts;
            if (sp.pwfTrend) m.notes.push('pwf at shut-in is a trend value (extrapolated or first sample): S_pwf is included in S_err.');
        }
        // Evidence vector and labels (§5.1); PRiSM's rate → R3/R4 'n/a' (no KC4).
        if (m.iarf && typeof AI.confidence === 'function') {
            var iw = m.iarf;
            var dte = prep.bins && Array.isArray(prep.bins.dte) && prep.bins.dte.length ? prep.bins.dte[prep.bins.dte.length - 1] : sp.dtEnd_h;
            var flags = m.flags.map(function (f) { return f.code; });
            var distractor = m.flags.some(function (f) { return DISTRACTORS[f.code] && (!iw.found || f.dt0_h <= iw.dt1_h); });
            var humpAfter = m.flags.some(function (f) { return HUMPS[f.code] && iw.found && f.dt1_h >= iw.dt0_h; });
            var rejBoth = !!(ch && Array.isArray(ch.refits) && ch.refits.filter(function (x) { return (x.f === 0.8 || x.f === 1.25) && x.rejected; }).length >= 2);
            var outside = false;
            if (cal && cal.envelope && m.final) {
                var env = cal.envelope;
                if (env.k && (m.final.k < env.k[0] || m.final.k > env.k[1])) outside = true;
                if (env.S && (m.final.S < env.S[0] || m.final.S > env.S[1])) outside = true;
                if (env.dtEnd_h && (sp.dtEnd_h < env.dtEnd_h[0] || sp.dtEnd_h > env.dtEnd_h[1])) outside = true;
            }
            m.evidence = {
                grade: iw.grade, noiseWidened: !!iw.noiseWidened, span: fin(iw.cycles) || 0, pointSkinSpread: iw.pointSkin ? fin(iw.pointSkin.spread) || 0 : 0,
                agree: agreeOK, agreeMode: m.agreement ? m.agreement.mode : 'none',
                dkPct: m.agreement ? fin(m.agreement.dkPct) : null, dS: m.agreement ? fin(m.agreement.dS) : null,
                sErr: m.sErr ? fin(m.sErr.value) : null, sErrMode: m.sErr ? m.sErr.mode : (m.line ? 'line' : 'model'),
                unitSlope: !!(m.storage && m.storage.unitSlope), cheldRejectedBoth: rejBoth,
                rateSource: spec.rateQC.source, r3: null, r3Status: 'n/a', r4: null, r4Status: 'n/a', dqKnown: true, fRate: 1,
                equalRateAssumed: false, snrD: fin(prep.snrD), rDrift: fin(prep.rDrift), rTide: fin(prep.rTide), tideRemoved: !!prep.tideRemoved,
                flags: flags, distractorAtOrBeforeIarf: distractor, humpAfterIarf: humpAfter,
                dtEnd_h: sp.dtEnd_h, dteEnd_h: isNum(dte) ? dte : sp.dtEnd_h,
                t10_h: m.reach ? fin(m.reach.t10_h) : null, t5_h: m.reach ? fin(m.reach.t5_h) : null,
                historySensitive: !!(m.history && m.history.sensitive), outsideEnvelope: outside, kHeld: false, kHeldConverged: null, kHeldCorrCS: null, kHeldRmsRatio: null,
                partialSuspect: null, windowLevelInconsistent: null,
                chosenKey: m.engineKey || 'homogeneous', chosenFullySeen: 'n/a',
                triggers: m.triggers && Array.isArray(m.triggers.fired) ? m.triggers.fired : [],
                dBicChosen: null, dBicNext: null, boundaryDepends: null
            };
            r = call('confidence', function () { return AI.confidence(m.evidence, cal); });
            m.confidence = r.v; if (r.err) m.errors.push(r.err);
            if (!m.engineKey && m.confidence) m.notes.push('The model label applies to the automatic model set; for this PRiSM model read the k/S label only.');
        }
        // Skin products (T7, T8): r_e from r_inv at the end of the test → bounds.
        // p̄ for FE: p* from a build-up with a known history (never an estimated one), else pi.
        // pwf: pwf0 for a shut-in; for a drawdown / injection from pi the last sample of the
        // period (its lowest pressure for a drawdown, its highest for an injection).
        if (m.final) {
            var dtE = sp.dtEnd_h;
            var re = rinvOf(AI, m.final.k, dtE, well);
            var pbar = null, pwf = null;
            if (sp.shut) {
                pbar = (!sp.tpUnknown && m.line && isNum(m.line.pStar)) ? m.line.pStar : (pos(well.pi) ? well.pi : null);
                pwf = spec.pwf0;
            } else if (pos(well.pi)) {
                var PP = toArr(adata.p).filter(isNum);
                pbar = well.pi;
                pwf = PP.length ? PP[PP.length - 1] : null;
            }
            m.pbarSource = pbar == null ? null : ((sp.shut && !sp.tpUnknown && m.line && isNum(m.line.pStar)) ? 'pStar' : 'pi');
            var gas = spec.well.fluid === 'gas', dpGas = null;
            if (gas) dpGas = gasDpSkin(adata, well, m.final.k, m.final.S, spec.Dq, pwf);
            m.products = products({ S: m.final.S, k: m.final.k, h: well.h, B: well.B, mu: well.mu, q: well.q, Dq: spec.Dq,
                                    rw: well.rw, re_ft: re, reSource: 'rinv', pbar: pbar, pwf: pwf, dpSkin_psi: dpGas });
            if (gas && !isNum(dpGas)) {
                // The liquid formula does not apply to gas: hide Δp_skin and FE rather than mislead.
                m.products.dpSkin_psi = null; m.products.FE = null; m.products.DR = null; m.products.dpSkinSource = null;
                m.notes.push('Gas: Δp skin and flow efficiency need the m(p) table (gas gravity and temperature in Well & Test); not shown.');
            } else if (gas) {
                m.notes.push('Gas: Δp skin is Δm_S = 0.8686·m·S′ converted to psi through the m(p) table at pwf; S′ includes D·q.');
            }
            m.rinv_ft = fin(re);
        }
        // Mechanical skin (both bases) with the kv/kh range.
        if (m.final) {
            m.mech = mechanicalSkin({ S_total: m.final.S, Serr: m.sErr ? m.sErr.value : null, h: well.h, rw: well.rw,
                                      completion: completionFor(m.completion, well.h), D: null, q: null });
            if (fluidOf(well, adata) === 'gas' && m.mech.available) m.notes.push('Gas: the skin includes D·q (rate-dependent skin is not removed here).');
        }
        if (cal && !cal.calibrated) m.notes.push('Labels not yet calibrated: every label is capped at medium.');
        return m;
    }

    // =========================================================================
    // SECTION 7 — THE CARD (Tab 6 panel, Tools drawer)
    // =========================================================================
    // hosts: the elements the card was painted into (a Tab-6 body, the Tools drawer panel …);
    // jobHost: the host whose button started the running C-held job.
    var _ui = { model: null, cheld: null, running: false, cancel: false, progress: '', sig: '', hosts: [], jobHost: null };
    var CSS_ID = 'prism_skc_css';
    var CSS = '.prism-skc{display:grid;gap:10px;min-width:0}' +
        '.prism-skc-sec{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;min-width:0}' +
        '.prism-skc-sec h4{margin:0 0 6px;font-size:13px;color:var(--text)}' +
        '.prism-skc-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px}' +
        '.prism-skc-kv div{background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:5px 8px;min-width:0}' +
        '.prism-skc-kv span{display:block;font-size:11px;color:var(--text2)}' +
        '.prism-skc-kv b{font-size:13px;color:var(--text);word-break:break-word}' +
        '.prism-skc-note{font-size:12px;color:var(--text2);margin:4px 0}' +
        '.prism-skc-warn{font-size:12px;color:var(--yellow);margin:4px 0}' +
        '.prism-skc-verdict{font-size:13px;font-weight:600;margin:2px 0 6px}' +
        '.prism-skc-tw{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}' +
        '.prism-skc table{border-collapse:collapse;width:100%;font-size:12px}' +
        '.prism-skc th,.prism-skc td{border-bottom:1px solid var(--border);padding:4px 6px;text-align:left;vertical-align:top}' +
        '.prism-skc-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}' +
        '.prism-skc-btn{appearance:none;background:var(--bg3,var(--bg2));border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 11px;font:inherit;font-size:12px;cursor:pointer;min-height:34px;touch-action:manipulation}' +
        '.prism-skc-btn[disabled]{opacity:.55;cursor:default}' +
        '.prism-skc-f{display:flex;flex-direction:column;gap:2px;min-width:110px;flex:1 1 110px}' +
        '.prism-skc-f label{font-size:11px;color:var(--text2)}' +
        '.prism-skc-f input,.prism-skc-f select{width:100%;box-sizing:border-box;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:5px 6px;font-size:12px}';

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function sig(v, n) { return isNum(v) ? String(+v.toPrecision(n || 3)) : '—'; }
    function kvHTML(pairs) {
        return '<div class="prism-skc-kv">' + pairs.map(function (p) { return '<div><span>' + esc(p[0]) + '</span><b>' + esc(p[1]) + '</b></div>'; }).join('') + '</div>';
    }
    function tableHTML(head, rows) {
        return '<div class="prism-skc-tw"><table><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }
    function sec(id, title, body) { return '<div class="prism-skc-sec" id="' + id + '"><h4>' + esc(title) + '</h4>' + body + '</div>'; }
    function lvl(v) { return v === 'high' || v === 'medium' || v === 'low' ? v : '—'; }
    function verdictText(c) {
        if (!c) return 'Confidence: not assessed';
        return 'Confidence: ' + lvl(c.ks) + ' (k/S) · ' + lvl(c.headline) + ' (test)';
    }
    function rateText(c) {
        if (!c || !c.rates || !c.rates.ks) return '';
        var r = c.rates.ks, sg = r.single;
        // the pooled rate is dominated by the tests of the sequence wells; a single build-up is quoted with the single-case
        // row of the same label next to it (§5.1, §5.7)
        return 'k and S right in ' + fmt(100 * r.rate, 0) + ' % of calibration cases labelled ' + lvl(c.ks) + ' (' + fmt(100 * r.lo, 0) + '–' + fmt(100 * r.hi, 0) + ' %)' +
            (sg && isNum(sg.rate) ? '; in ' + fmt(100 * sg.rate, 0) + ' % of single build-ups (' + fmt(100 * sg.lo, 0) + '–' + fmt(100 * sg.hi, 0) + ' %, ' + sg.n + ' cases).' : '.');
    }
    var GRADE_TEXT = { good: 'good', fair: 'fair', none: 'none' };
    function iarfText(iw) {
        if (!iw) return 'not assessed';
        if (!iw.found) return 'none (' + (iw.status === 'tooShort' ? 'test too short' : 'expected but not found') + ')';
        return (GRADE_TEXT[iw.grade] || iw.grade) + (iw.noiseWidened ? ' (noise-widened)' : '') + ', ' + fmt(iw.cycles, 2) + ' cycle';
    }
    function lineSummary(l) { return l ? 'k ' + sig(l.k) + ' md, S ' + fmt(l.S, 2) : '—'; }
    function agreeText(a) {
        if (!a) return 'not checked';
        var t = a.agree ? (a.mode === 'bias' ? 'agree (bias explained)' : 'agree') : 'disagree';
        return t + ': Δk ' + fmt(a.dkPct, 1) + ' %, ΔS ' + fmt(a.dS, 2);
    }
    function plateauText(pc) {
        if (!pc) return 'not checked';
        return (pc.pass ? 'pass' : 'fail') + ': kh ' + fmt(pc.khDiffPct, 1) + ' %, ΔS ' + fmt(pc.dS, 2);
    }
    function reachText(r) {
        if (!r) return '—';
        var s = 'fair ' + sig(r.fair_h) + ' h, good ' + sig(r.good_h) + ' h (equivalent time)';
        if (r.reachable && isNum(r.fairShut_h)) s += '; shut-in ' + sig(r.fairShut_h) + ' h / ' + (isNum(r.goodShut_h) ? sig(r.goodShut_h) + ' h' : '—');
        return s;
    }
    var DRIVER = { floor: 'floor', se: 'fit standard error', lineMatch: 'line vs match', window: 'window shift', tc: 'closing time', pwf: 'pwf at shut-in', kHeld: 'held k' };
    var INPUT_NAME = { h: 'h', phi: 'φ', ct: 'ct', rw: 'rw', B: 'B', mu: 'μ', q: 'q' };

    function compInputsHTML(c, verified) {
        var on = c.on ? ' checked' : '';
        var p = c.perf;
        function f(id, label, val, step) {
            return '<div class="prism-skc-f"><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" type="number" inputmode="decimal" step="' + step + '" value="' + esc(isNum(val) ? val : '') + '"></div>';
        }
        var h = '<div class="prism-skc-row"><label><input type="checkbox" id="prism_skc_cmp_on"' + on + '> Completion data</label></div>';
        h += '<div class="prism-skc-row">' +
            f('prism_skc_hp', 'Open interval h_w (ft, blank = h)', c.hp_ft, 'any') +
            f('prism_skc_htop', 'Top of layer to interval (ft)', c.htop_ft, 'any') +
            f('prism_skc_theta', 'Deviation θ (°, ≤ 75)', c.theta_deg, 'any') +
            f('prism_skc_kvlo', 'kv/kh low', c.kvlo, 'any') +
            f('prism_skc_kvhi', 'kv/kh high', c.kvhi, 'any') + '</div>';
        if (verified) {
            var opt = [0, 180, 120, 90, 60, 45].map(function (v) { return '<option value="' + v + '"' + (p.phase_deg === v ? ' selected' : '') + '>' + v + '°</option>'; }).join('');
            h += '<div class="prism-skc-row"><label><input type="checkbox" id="prism_skc_perf_on"' + (p.on ? ' checked' : '') + '> Perforation data</label></div>' +
                '<div class="prism-skc-row">' + f('prism_skc_spf', 'Shots per foot', p.spf, 'any') + f('prism_skc_lp', 'Perforation length (in)', p.lp_in, 'any') +
                f('prism_skc_rp', 'Perforation radius (in)', p.rp_in, 'any') +
                '<div class="prism-skc-f"><label for="prism_skc_phase">Phasing</label><select id="prism_skc_phase">' + opt + '</select></div></div>';
        } else {
            h += '<div class="prism-skc-note">Perforation skin not split: the perforation-skin coefficients are not yet verified.</div>';
        }
        return h;
    }
    function mechHTML(m) {
        var x = m.mech;
        if (!x) return '<div class="prism-skc-note">Needs a skin value from the line or the match.</div>';
        if (!x.available) {
            return '<div class="prism-skc-note">' + esc(x.reason || 'Not split.') + '</div>' +
                x.validity.map(function (v) { return '<div class="prism-skc-warn">⚠ ' + esc(v.text) + '</div>'; }).join('');
        }
        var pairs = [
            ['S total', fmt(m.final.S, 2)],
            ['Geometric pseudo-skin', fmt(x.S_geo, 2) + ' (' + fmt(x.S_geo_lo, 2) + ' to ' + fmt(x.S_geo_hi, 2) + ')'],
            ['  partial penetration', fmt(x.parts.pp, 2)],
            ['  deviation', fmt(x.parts.theta, 2)],
            ['S_mech (pressure-drop basis)', fmt(x.S_mech, 2) + ' ± ' + fmt(x.S_mech_err, 2)],
            ['S_d local (open interval)', fmt(x.S_d_local, 2)],
            ['kv/kh range', fmt(x.kvkh[0], 2) + ' to ' + fmt(x.kvkh[1], 2)]
        ];
        if (isNum(x.parts.perf)) pairs.splice(4, 0, ['  perforations', fmt(x.parts.perf, 2)]);
        return kvHTML(pairs) + x.validity.map(function (v) { return '<div class="prism-skc-warn">⚠ ' + esc(v.text) + '</div>'; }).join('');
    }
    function cheldHTML(m) {
        var h = '';
        var ch = m.cheld;
        if (ch) {
            if (!ch.triggered && (!ch.refits || !ch.refits.length)) h += '<div class="prism-skc-note">C-held refits not needed: the unit slope was sampled.</div>';
            else {
                h += kvHTML([['C range (bbl/psi)', sig(ch.range.C[0]) + ' to ' + sig(ch.range.C[1])], ['k range (md)', sig(ch.range.k[0]) + ' to ' + sig(ch.range.k[1])],
                             ['S range', fmt(ch.range.S[0], 2) + ' to ' + fmt(ch.range.S[1], 2)], ['S_C (half range)', fmt(ch.S_C, 2)]]);
                h += tableHTML(['C × f', 'k (md)', 'S', 'C (bbl/psi)', 'ΔBIC', 'Rejected'],
                    (ch.refits || []).map(function (x) { return [fmt(x.f, 2), sig(x.k), fmt(x.S, 2), sig(x.C), fmt(x.dBic, 1), x.rejected ? 'yes' : 'no']; }));
            }
        }
        var dis = (!m.cheldAvailable || _ui.running) ? ' disabled' : '';
        h += '<div class="prism-skc-row"><button type="button" class="prism-skc-btn" id="prism_skc_cheld"' + dis + '>Run C-held refits</button>' +
             '<button type="button" class="prism-skc-btn" id="prism_skc_cheld_cancel"' + (_ui.running ? '' : ' disabled') + '>Cancel</button>' +
             '<span class="prism-skc-note" id="prism_skc_cheld_status" role="status" aria-live="polite">' + esc(_ui.progress) + '</span></div>';
        if (!m.cheldAvailable) h += '<div class="prism-skc-note">C-held refits need the automatic engine and k, S and C from a match or the line.</div>';
        return h;
    }

    function cardHTML(m) {
        if (!m.ok) {
            return '<div id="prism_skc_root" class="prism-skc"><div class="prism-skc-note">' + esc(m.reason || 'The skin check is not available.') + '</div>' +
                   '<div class="prism-skc-note">' + esc(CHELD_NOTE) + '</div></div>';
        }
        var h = '<div id="prism_skc_root" class="prism-skc">';
        var c = m.confidence;
        h += '<div class="prism-skc-sec" id="prism_skc_head"><div class="prism-skc-verdict">' + esc(verdictText(c)) + '</div>' +
             (rateText(c) ? '<div class="prism-skc-note">' + esc(rateText(c)) + '</div>' : '') +
             m.notes.map(function (n) { return '<div class="prism-skc-note">' + esc(n) + '</div>'; }).join('') +
             m.warnings.map(function (w) { return '<div class="prism-skc-warn">⚠ ' + esc(w.text) + '</div>'; }).join('') +
             (m.errors.length ? '<div class="prism-skc-warn">⚠ Not available in this build: ' + esc(m.errors.join(', ')) + '.</div>' : '') + '</div>';
        // IARF window.
        var iw = m.iarf;
        var ip = [['Grade', iarfText(iw)]];
        if (iw && iw.found) {
            ip.push(['Window Δt', sig(iw.dt0_h) + ' to ' + sig(iw.dt1_h) + ' h']);
            ip.push(['Derivative level', sig(iw.level_psi, 4) + ' psi']);
            if (iw.longest) ip.push(['Longest qualifying window', sig(iw.longest.dt0_h) + ' to ' + sig(iw.longest.dt1_h) + ' h (' + fmt(iw.longest.cycles, 2) + ' cycle)']);
            if (iw.pointSkin) ip.push(['Point-skin spread', fmt(iw.pointSkin.spread, 2)]);
        }
        h += sec('prism_skc_iarf', 'Automatic IARF window (L = 0.1 cycle)', kvHTML(ip) +
            (iw && iw.reason ? '<div class="prism-skc-note">' + esc(iw.reason) + '</div>' : '') +
            '<div class="prism-skc-row"><button type="button" class="prism-skc-btn" id="prism_skc_usewin"' + (m.window ? '' : ' disabled') +
            '>Use this window in the straight-line panel</button></div>');
        // Line.
        var l = m.line;
        var linePairs = l ? [
            ['Method', l.method === 'horner' ? 'Horner' : 'Superposition'], ['k', sig(l.k) + ' md'], ['kh', sig(l.kh) + ' md·ft'], ['S', fmt(l.S, 2)],
            ['m', sig(Math.abs(l.m), 4) + ' psi/cycle'],
            ['p*', isNum(l.pStar) ? fmt(l.pStar, 1) + ' psia' : (m.tpUnknown ? 'not shown (producing time estimated)' : (m.indicative ? 'not shown (not a shut-in)' : '—'))],
            ['R²', fmt(l.r2, 4)]
        ] : null;
        if (l && l.pStarRange && isNum(l.pStarRange.lo) && isNum(l.pStarRange.hi)) {
            linePairs.splice(6, 0, ['p* range (estimated history)', fmt(l.pStarRange.lo, 1) + ' to ' + fmt(l.pStarRange.hi, 1) + ' psia']);
        }
        h += sec('prism_skc_line', 'Straight line through the window', l ? kvHTML(linePairs) : '<div class="prism-skc-note">No line: no IARF window.</div>');
        // Agreement.
        h += sec('prism_skc_agree', 'Line vs match', kvHTML([
            ['Line vs match', agreeText(m.agreement)],
            ['Match', m.matchAvailable && m.final ? (m.fitKey || 'fit') : 'no match'],
            ['Line vs derivative plateau (sanity check)', plateauText(m.plateau)]
        ]) + '<div class="prism-skc-note">Agreement rule: k within 5 % and S within 0.5, or the difference explained by the unsettled-window bias within 3 % and 0.3.</div>');
        // S_err.
        var se = m.sErr;
        if (se) {
            var comp = [['Floor', fmt(se.floor, 2)], ['Fit standard error', fmt(se.seS, 2)], ['Line vs match', fmt(se.dLineMatch, 2)],
                        ['Window shift', fmt(se.sWin, 2)], ['Closing time', fmt(se.sTc, 2)], ['pwf at shut-in', fmt(se.sPwf, 2)]];
            h += sec('prism_skc_serr', 'Skin uncertainty S_err', kvHTML([['S_err', '± ' + fmt(se.value, 2)], ['Largest term', DRIVER[se.driver] || String(se.driver || '—')],
                ['With the C-held range', '± ' + fmt(se.ext && se.ext.value, 2)], ['Inputs (typical ranges)', '± ' + fmt(se.sSens, 2)], ['Total with inputs', '± ' + fmt(se.sAbs, 2)]]) +
                tableHTML(['Term', 'ΔS'], comp));
        }
        // Sensitivity.
        var sv = m.sensitivity;
        if (sv && Array.isArray(sv.req)) {
            h += sec('prism_skc_sens', 'Input sensitivity (analytic)', tableHTML(['Input', 'Factor', 'k (md)', 'Δk %', 'ΔS'],
                sv.req.map(function (x) { return [INPUT_NAME[x.input] || x.input, '× ' + fmt(x.f, 2), sig(x.k), fmt(x.dkPct, 1), fmt(x.dS, 3)]; })) +
                '<div class="prism-skc-note">Dominant for k: ' + esc(INPUT_NAME[sv.dominantK && sv.dominantK.req] || '—') + '; for S: ' +
                esc(INPUT_NAME[sv.dominantS && sv.dominantS.req] || '—') + ' (±20 %, q ±10 %). μ has no effect on S.</div>');
        }
        // Confidence reasons.
        if (c) {
            h += sec('prism_skc_conf', 'Confidence', '<div class="prism-skc-verdict">' + esc(verdictText(c)) + '</div>' +
                (Array.isArray(c.reasons) && c.reasons.length ? tableHTML(['Rule', 'Kind', 'Reason', 'Evidence'],
                    c.reasons.map(function (x) { return [x.rule, x.kind, x.text, (x.ev || []).join(', ')]; })) : '<div class="prism-skc-note">Every rule for this label is met.</div>') +
                '<div class="prism-skc-note">Rate checks: ' + esc(m.rate.status) + ' (' + esc(m.rate.text) + ')</div>' +
                '<div class="prism-skc-note">' + esc(CHELD_NOTE) + '</div>');
        }
        // Products.
        var pr = m.products;
        if (pr) {
            h += sec('prism_skc_prod', 'Skin pressure drop and productivity', kvHTML([
                ['Δp skin', isNum(pr.dpSkin_psi) ? fmt(pr.dpSkin_psi, 1) + ' psi' : '—'],
                ['Flow efficiency', isNum(pr.FE) ? fmt(pr.FE, 3) + (m.pbarSource === 'pi' ? ' (from pi)' : (m.pbarSource === 'pStar' ? ' (from p*)' : '')) : '—'],
                ['PI ratio X/(X + S)', isNum(pr.piRatio) ? fmt(pr.piRatio, 3) + ', ' + pr.labels.piRatio : (pr.guard ? 'not computable (X + S < 1)' : '—')],
                ['r_e used', isNum(m.rinv_ft) ? sig(m.rinv_ft) + ' ft (r_inv at the end of the test)' : '—']
            ]) + '<div class="prism-skc-note">Pseudo-steady-state estimates.</div>');
        }
        // Mechanical skin.
        h += sec('prism_skc_mech', 'Mechanical skin', compInputsHTML(m.completion, KT.verified) + '<div id="prism_skc_mech_res">' + mechHTML(m) + '</div>');
        // Reach.
        h += sec('prism_skc_reach', 'Expected IARF reach (from the fitted model)', kvHTML([['Reach', reachText(m.reach)], ['This test', sig(m.evidence ? m.evidence.dtEnd_h : null) + ' h']]) +
            '<div class="prism-skc-note">Hours of equivalent time for a fair (0.5 cycle) and a good (1 cycle) IARF, allowing for the derivative window.</div>');
        // C-held.
        h += sec('prism_skc_cheld_sec', 'C-held refits (storage sensitivity)', cheldHTML(m));
        h += '</div>';
        return h;
    }
    function ensureCss() {
        if (typeof document === 'undefined' || !document.getElementById || document.getElementById(CSS_ID)) return;
        try {
            var st = document.createElement('style');
            st.id = CSS_ID;
            st.textContent = CSS;
            (document.head || document.body || document.documentElement).appendChild(st);
        } catch (e) { /* cosmetic */ }
    }
    // Every lookup goes through a host's own root, never document.getElementById: a hidden
    // Tab-6 copy (display:none, still in the DOM) and a Tools-drawer copy carry the same ids.
    function rootOf(host) {
        try { return (host && host.querySelector) ? host.querySelector('#prism_skc_root') : null; } catch (e) { return null; }
    }
    function inDocument(el) {
        if (typeof document === 'undefined' || !el) return false;
        for (var n = el; n; n = n.parentNode) if (n === document.body || n === document.documentElement) return true;
        return false;
    }
    // A host is live while it is in the document and still holds a card root.
    function live(host) { var r = rootOf(host); return !!(r && inDocument(r)); }
    function liveHosts() {
        _ui.hosts = _ui.hosts.filter(live);
        return _ui.hosts.slice();
    }
    function q(root, id) { try { return root ? root.querySelector('#' + id) : null; } catch (e) { return null; } }

    function paint(el, m) {
        el.innerHTML = cardHTML(m);
        wire(el);
        if (_ui.hosts.indexOf(el) === -1) _ui.hosts.push(el);
    }
    // renderPanel(el): paint the card. No storage writes, no events.
    function renderPanel(el) {
        if (!el || typeof el !== 'object') return null;
        ensureCss();
        var m = run({ cheld: _ui.cheld });
        if (_ui.running && m.sig !== _ui.sig) _ui.cancel = true;
        _ui.model = m;
        paint(el, m);
        return m;
    }
    // Re-paint the given hosts (default: every live host) from one run().
    function rerender(hosts) {
        var list = (hosts || liveHosts()).filter(live);
        if (!list.length) return null;
        ensureCss();
        var m = run({ cheld: _ui.cheld });
        if (_ui.running && m.sig !== _ui.sig) _ui.cancel = true;
        _ui.model = m;
        list.forEach(function (h) { paint(h, m); });
        return m;
    }
    function compFromInputs(root) {
        function v(id) { var e = root.querySelector('#' + id); return e ? e.value : null; }
        function chk(id) { var e = root.querySelector('#' + id); return !!(e && e.checked); }
        var c = normComp(_ui.model ? _ui.model.completion : loadComp());
        c.on = chk('prism_skc_cmp_on');
        var hp = num(v('prism_skc_hp'));
        c.hp_ft = pos(hp) ? hp : null;
        ['htop_ft:prism_skc_htop', 'theta_deg:prism_skc_theta', 'kvlo:prism_skc_kvlo', 'kvhi:prism_skc_kvhi'].forEach(function (p) {
            var a = p.split(':'), x = num(v(a[1]));
            if (x != null) c[a[0]] = x;
        });
        if (root.querySelector('#prism_skc_perf_on')) {
            c.perf.on = chk('prism_skc_perf_on');
            ['spf:prism_skc_spf', 'lp_in:prism_skc_lp', 'rp_in:prism_skc_rp', 'phase_deg:prism_skc_phase'].forEach(function (p) {
                var a = p.split(':'), x = num(v(a[1]));
                if (x != null) c.perf[a[0]] = x;
            });
        }
        return c;
    }
    function onCompChange(root) {
        var c = compFromInputs(root);
        saveComp(c);
        var m = _ui.model;
        if (!m || !m.final || !m.well) return;
        m.completion = c;
        m.mech = mechanicalSkin({ S_total: m.final.S, Serr: m.sErr ? m.sErr.value : null, h: m.well.h, rw: m.well.rw,
                                  completion: completionFor(c, m.well.h), D: null, q: null });
        var res = root.querySelector('#prism_skc_mech_res');
        if (res) res.innerHTML = mechHTML(m);
    }
    // "Use this window": the IARF window on PRiSM's own time axis (m.window: pseudo-time when
    // gas pseudo-time is on; null — button disabled — when it cannot be converted).
    function useWindow() {
        var m = _ui.model;
        if (!m || !m.window || typeof G.PRiSM_semilogAnalysis !== 'function') return null;
        return G.PRiSM_semilogAnalysis(null, null, { window: { t0: m.window.t0, t1: m.window.t1 }, store: true });
    }
    // A homogeneous fit seeded from the match (engine ModelFit with BIC), then the C-held refits.
    // A step that throws ends the job with failed = the step's name (drive then resolves null).
    function cheldJob(AI, prep, seed) {
        var phase = 0, fitJ = null, chJ = null, base = seed, res = null, cancelled = false, failed = null;
        if (typeof AI.fitJob === 'function') {
            fitJ = AI.fitJob('homogeneous', prep, { start: { phys: { k: seed.phys.k, S: seed.phys.S, C: seed.phys.C } } });
        } else phase = 1;
        function stepInner() {
            if (phase === 0) {
                var s0 = fitJ.step();
                if (s0.done) { var f = fitJ.result(); if (f && f.ok !== false && f.phys) base = f; phase = 1; }
                return { done: false, progress: 0.4 * (s0.progress || 0), label: 'Homogeneous fit' };
            }
            if (phase === 1) { chJ = AI.cHeldJob(prep, base, { mode: 'auto' }); phase = 2; return { done: false, progress: 0.4, label: 'C-held refits' }; }
            var s = chJ.step();
            if (s.done) { res = chJ.result(); return { done: true, progress: 1, label: 'Done' }; }
            return { done: false, progress: 0.4 + 0.6 * (s.progress || 0), label: s.label || 'C-held refits' };
        }
        return {
            step: function () {
                if (cancelled || failed) return { done: true, progress: 1, label: cancelled ? 'Cancelled' : 'Failed' };
                try { return stepInner(); }
                catch (e) {
                    failed = phase === 0 ? 'fitJob' : 'cHeldJob';
                    if (typeof console !== 'undefined' && console.warn) console.warn('[PRiSM skin check] ' + failed + ' failed:', e);
                    res = null;
                    return { done: true, progress: 1, label: 'Failed' };
                }
            },
            result: function () { return res; },
            failed: function () { return failed; },
            cancel: function () { cancelled = true; if (fitJ && fitJ.cancel) fitJ.cancel(); if (chJ && chJ.cancel) chJ.cancel(); }
        };
    }
    // Status text of the C-held row, in the given root (default: the job's host) only.
    function setStatus(text, root) {
        _ui.progress = text;
        var e = q(root || rootOf(_ui.jobHost), 'prism_skc_cheld_status');
        if (e) e.textContent = text;
    }
    // startCheld(root): root = the card root whose button was clicked (default: the first live card).
    function startCheld(root) {
        var AI = AIns(), m = _ui.model;
        if (_ui.running || !m || !m.ok || !m.cheldAvailable || !AI) return null;
        if (!root) { var hs = liveHosts(); root = hs.length ? rootOf(hs[0]) : null; }
        var host = root && root.parentNode ? root.parentNode : null;
        function unavailable(text) { setStatus(text, root); return null; }
        var setup = call('prepare', function () {
            var well = G.PRiSM_getWell ? G.PRiSM_getWell() : {};
            var adata = G.PRiSM_getAnalysisData ? G.PRiSM_getAnalysisData() : null;
            var sp = adata && adata.ok ? specFromAdata(adata, well || {}) : null;
            if (!sp || !sp.ok) return { prep: null };
            var es = engineSteps(AI, sp.spec);
            if (es.prepErr) throw new Error('prepare failed');
            return { prep: es.prep };
        });
        if (setup.err) return unavailable('C-held refits are not available: ' + setup.err + ' failed.');
        var prep = setup.v && setup.v.prep;
        if (!prep || prep.ok === false) return unavailable('C-held refits are not available for this period.');
        var fit = G.PRiSM_getLastFit ? G.PRiSM_getLastFit() : null;
        var seed = matchFromFit(fit, 'homogeneous');
        if (!seed && m.final) seed = matchFromFit({ modelKey: 'homogeneous', phys: { k: m.final.k, S: m.final.S, C: m.final.C } }, 'homogeneous');
        if (!seed || !pos(seed.phys.C)) return unavailable('C-held refits need wellbore storage C from the match or the unit slope.');
        var jr = call('fitJob', function () { return cheldJob(AI, prep, seed); });
        if (jr.err || !jr.v) return unavailable('C-held refits are not available: ' + (jr.err || 'fitJob') + ' failed.');
        var job = jr.v;
        var sigNow = m.sig;
        _ui.running = true; _ui.cancel = false; _ui.sig = sigNow; _ui.jobHost = host;
        setStatus('Running…', root);
        var b1 = q(root, 'prism_skc_cheld'), b2 = q(root, 'prism_skc_cheld_cancel');
        if (b1) b1.disabled = true;
        if (b2) b2.disabled = false;
        function done(text) {
            _ui.running = false; _ui.cancel = false; _ui.progress = text;
            var h = _ui.jobHost; _ui.jobHost = null;
            // Re-paint the card that ran the job (and any other live copy) from one run().
            var hosts = liveHosts();
            if (h && live(h) && hosts.indexOf(h) === -1) hosts.push(h);
            rerender(hosts);
        }
        var dr = call('drive', function () {
            return AI.drive(job, {
                shouldCancel: function () { return _ui.cancel || !live(host); },
                onProgress: function (f, label) { setStatus((label || 'Working') + ' ' + fmt(100 * (f || 0), 0) + ' %'); }
            });
        });
        if (dr.err || !dr.v || typeof dr.v.then !== 'function') { done('C-held refits are not available: drive failed.'); return null; }
        return dr.v.then(function (res) {
            var bad = job.failed && job.failed();
            _ui.cheld = (res && !bad) ? { sig: sigNow, result: res } : null;
            done(bad ? 'C-held refits failed: ' + bad + '.' : (res ? 'C-held refits finished.' : 'C-held refits returned no result.'));
            return bad ? null : res;
        }, function (e) {
            done(e && e.code === 'CANCELLED' ? 'Cancelled.' : 'C-held refits failed.');
            return null;
        });
    }
    function wire(el) {
        var root = rootOf(el);
        if (!root) return;
        root.addEventListener('click', function (ev) {
            var t = ev.target;
            while (t && t !== root && !(t.id && /^prism_skc_/.test(t.id) && t.tagName === 'BUTTON')) t = t.parentNode;
            if (!t || t === root || t.disabled) return;
            if (t.id === 'prism_skc_usewin') useWindow();
            else if (t.id === 'prism_skc_cheld') startCheld(root);
            else if (t.id === 'prism_skc_cheld_cancel') { _ui.cancel = true; setStatus('Cancelling…', root); }
        });
        root.addEventListener('change', function (ev) {
            var t = ev.target;
            if (t && t.id && /^prism_skc_(cmp_on|hp|htop|theta|kvlo|kvhi|perf_on|spf|lp|rp|phase)$/.test(t.id)) onCompChange(root);
        });
    }

    // Tab 6 panel (C7): shown when a pressure fit or a semilog result exists, not in decline mode.
    function panelWhen() {
        if (G.PRiSM && G.PRiSM.mode === 'decline') return false;
        var st = G.PRiSM_state || {};
        var fitOk = !!(st.lastFit && typeof st.lastFit === 'object' && st.lastFit.kind !== 'rate');
        var slOk = !!(st.semilog && st.semilog.ok);
        return fitOk || slOk;
    }
    // render is the same function as window.PRiSM_renderSkinCheckPanel, so the Tools drawer
    // lists the card once (37 drops a step panel whose render equals a listed tool).
    var PANEL = { id: 'prism_skincheck', title: 'Skin check: IARF window, line vs match, uncertainty, confidence', order: 8,
                  when: panelWhen, render: renderPanel };
    (function registerPanel() {
        try { if (typeof G.PRiSM_registerTabPanel === 'function') { G.PRiSM_registerTabPanel(6, PANEL); return; } } catch (e) { /* raw registry */ }
        G.PRiSM_tabPanels = (G.PRiSM_tabPanels && typeof G.PRiSM_tabPanels === 'object') ? G.PRiSM_tabPanels : {};
        var list = G.PRiSM_tabPanels[6] = Array.isArray(G.PRiSM_tabPanels[6]) ? G.PRiSM_tabPanels[6] : [];
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === PANEL.id) { list[i] = PANEL; return; }
        list.push(PANEL);
    })();

    // Re-render every mounted copy on the C7 events (no polling). Attached only when a
    // document exists (plan §3.0); the events are dispatched on window (33, 34), so the
    // listeners sit there. Engine steps are cached by the spec, so a fit-only event re-runs
    // the cheap parts only. A running C-held job for other inputs is cancelled by rerender.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' &&
        typeof G.addEventListener === 'function' && !G.__PRiSM_skinCheckListeners) {
        G.__PRiSM_skinCheckListeners = true;
        ['prism:fit-updated', 'prism:period-changed', 'prism:well-changed', 'prism:dataset-loaded'].forEach(function (type) {
            G.addEventListener(type, function () {
                var hosts = liveHosts();
                if (!hosts.length) return;
                if (type !== 'prism:fit-updated') _ui.cheld = null;
                rerender(hosts);
            });
        });
    }

    // =========================================================================
    // SECTION 8 — REPORT SECTION (36-report.js PRiSM_reportSections, order 45)
    // =========================================================================
    function reportSection(model) {
        var st = G.PRiSM_state || {};
        if (G.PRiSM && G.PRiSM.mode === 'decline') return null;
        if (!(st.lastFit && st.lastFit.kind !== 'rate') && !(st.semilog && st.semilog.ok)) return null;
        var m = run({ cheld: _ui.cheld });
        if (!m.ok) return null;
        var kv = [];
        var iw = m.iarf;
        kv.push(['IARF window (L = 0.1 cycle)', iarfText(iw) + (iw && iw.found ? ', Δt ' + sig(iw.dt0_h) + ' to ' + sig(iw.dt1_h) + ' h' : '')]);
        if (iw && iw.longest && iw.found) kv.push(['Longest qualifying window', sig(iw.longest.dt0_h) + ' to ' + sig(iw.longest.dt1_h) + ' h']);
        kv.push(['Line through the window', lineSummary(m.line)]);
        if (m.line && m.line.pStarRange && isNum(m.line.pStarRange.lo) && isNum(m.line.pStarRange.hi)) {
            kv.push(['p* range (estimated history)', fmt(m.line.pStarRange.lo, 1) + ' to ' + fmt(m.line.pStarRange.hi, 1) + ' psia']);
        }
        if (m.history && m.history.estimated) {
            kv.push(['Producing time', 'estimated, ' + sig(m.history.tPrepend_h) + ' h' + (isNum(m.history.dDerivPct) ? '; doubling it changes the derivative by ' +
                     fmt(m.history.dDerivPct, 1) + ' %' + (m.history.sensitive ? ' (label capped at medium)' : '') : '')]);
        }
        kv.push(['Line vs match', agreeText(m.agreement)]);
        kv.push(['Line vs derivative plateau (sanity check)', plateauText(m.plateau)]);
        if (m.sErr) kv.push(['Skin uncertainty S_err', '± ' + fmt(m.sErr.value, 2) + ' (largest term: ' + (DRIVER[m.sErr.driver] || String(m.sErr.driver || '—')) + ')']);
        if (m.final) kv.push(['Final k and S', 'k ' + sig(m.final.k) + ' md, S ' + fmt(m.final.S, 2) + ' (from the ' + m.final.source + ')']);
        kv.push(['Confidence', verdictText(m.confidence).replace(/^Confidence: /, '')]);
        if (m.products) {
            kv.push(['Δp skin', isNum(m.products.dpSkin_psi) ? fmt(m.products.dpSkin_psi, 1) + ' psi' : '—']);
            kv.push(['Flow efficiency', isNum(m.products.FE) ? fmt(m.products.FE, 3) + (m.pbarSource === 'pi' ? ' (from pi)' : (m.pbarSource === 'pStar' ? ' (from p*)' : '')) : '—']);
            kv.push(['PI ratio', isNum(m.products.piRatio) ? fmt(m.products.piRatio, 3) + ', ' + m.products.labels.piRatio : '—']);
        }
        if (m.mech) {
            kv.push(['Mechanical skin', m.mech.available ? 'S_mech ' + fmt(m.mech.S_mech, 2) + ' ± ' + fmt(m.mech.S_mech_err, 2) + ' (pressure-drop basis), S_d local ' + fmt(m.mech.S_d_local, 2) +
                     ', kv/kh ' + fmt(m.mech.kvkh[0], 2) + ' to ' + fmt(m.mech.kvkh[1], 2) : String(m.mech.reason || 'not split')]);
        }
        kv.push(['Expected IARF reach', reachText(m.reach)]);
        if (m.cheld && m.cheld.range) kv.push(['C-held S range', fmt(m.cheld.range.S[0], 2) + ' to ' + fmt(m.cheld.range.S[1], 2) + ' (S_C ' + fmt(m.cheld.S_C, 2) + ')']);
        var c = m.confidence;
        var rows = (c && Array.isArray(c.reasons)) ? c.reasons.map(function (x) { return [x.rule, x.kind, x.text, (x.ev || []).join(', ')]; }) : [];
        var notes = m.notes.slice();
        if (m.mech && m.mech.validity) m.mech.validity.forEach(function (v) { notes.push(v.text); });
        m.warnings.forEach(function (w) { notes.push(w.text); });
        return { id: 'skincheck', title: 'Skin check', order: 45, kv: kv.map(function (p) { return [p[0], String(p[1]).slice(0, 299)]; }),
                 table: rows.length ? { head: ['Rule', 'Kind', 'Reason', 'Evidence'], rows: rows } : null,
                 notes: notes.map(function (n) { return String(n).slice(0, 299); }) };
    }
    (function registerReport() {
        var reg = G.PRiSM_reportSections = Array.isArray(G.PRiSM_reportSections) ? G.PRiSM_reportSections : [];
        reportSection._prismId = 'skin-check';
        for (var i = 0; i < reg.length; i++) if (reg[i] && reg[i]._prismId === reportSection._prismId) { reg[i] = reportSection; return; }
        reg.push(reportSection);
    })();

    // =========================================================================
    // SECTION 9 — EXPORTS
    // =========================================================================
    SC.version = '1.0';
    SC.KT = KT;
    SC.perforationSkin = perforationSkin;
    SC.mechanicalSkin = mechanicalSkin;
    SC.rateSkin = rateSkin;
    SC.products = products;
    SC.expectedDRange = expectedDRange;
    SC.RATE_DEFAULTS = RATE_DEFAULTS;
    SC.historyCheck = historyCheck;     // tests and the integrator
    SC.gasDpSkin = gasDpSkin;           // tests
    SC._ktCompute = ktCompute;          // table-consistency test only
    SC._papatzacos = papatzacos;        // tests only
    SC.run = run;
    SC.renderPanel = renderPanel;
    SC.reportSection = reportSection;
    SC.specFromAdata = specFromAdata;   // tests and the integrator
    SC.useWindow = useWindow;
    SC.runCheld = startCheld;
    SC.PANEL = PANEL;
    SC._ui = _ui;
    // Tools drawer (plan §3.4, §6.11): window.PRiSM_renderSkinCheckPanel = renderPanel, exported
    // once 37's TOOL_CATALOGUE lists that name in a group (one entry, group 'Diagnose', the
    // card's written title). Until then the card is listed through its Tab-6 registration
    // ("Step panels", written title) and the name is not exported: 37 auto-lists every other
    // exported PRiSM_render*Panel under "More" with a machine-made title, which the wp16 test
    // forbids. 37 is loaded before 54 (Round 8 FILES), so the check runs at load.
    (function exportDrawerName() {
        try {
            if (typeof G.PRiSM_listTools !== 'function') return;
            var listed = G.PRiSM_listTools().some(function (t) {
                return t && t.fn === 'PRiSM_renderSkinCheckPanel' && t.group && t.group !== 'More';
            });
            if (listed) G.PRiSM_renderSkinCheckPanel = renderPanel;
        } catch (e) { /* the drawer is optional */ }
    })();
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
