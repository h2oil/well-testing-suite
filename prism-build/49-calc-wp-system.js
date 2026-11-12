// =============================================================================
// WTS — 49-calc-wp-system.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance system solver (WP5, increment A1) — docs/WELL-PERFORMANCE-PLAN.md §3.5, §4.7–§4.14, §15.2, §15.3, §16, D6.
//
// Couples the inflow (WTS_wp_ipr), the well path on the true inclination of every segment (WTS_wp_well: hydrostatic on TVD,
// friction on MD), the vertical lift (WTS_wp_vlp on the ONE marcher of 49-calc-flowline.js, D3), the surface choke
// (WTS_chokeperf_multiphaseRate / WTS_chokeperf_gasRate, called directly, D4) and the flowline (WTS_flowline_march, reverse from
// the separator, §4.8). Nothing here re-implements a correlation or a march: the solver only drives them.
//
// OPERATING POINT (§4.9; D6). Bottom-hole node (default): p_in(q) = IPR pwf at the mid-perforations, p_out(q) = the pressure marched
// down the well from the top boundary condition (fixed THP, or choke + flowline + separator). Δ(q) = p_out − p_in.
//   1. Scan: p_out on a 12-point COARSE grid (double step, frozen step layout) between 0.5 % and 99.5 % of AOF (log-spaced below
//      10 %, linear above); a lost march marks "cannot lift" (Δ = +∞). Between the points p_out is a monotone cubic (Fritsch-Carlson),
//      sampled densely for sign changes of Δ.
//   2. Every sign change → a fine-march root: a Newton step on the coarse slope finds a bracket, then Brent (|Δ| < 0.1 psi or
//      Δq < 1e-4·q; cap 20 evaluations). All fine marches of one solve share one FROZEN step / sub-step layout (opt.grid, §4.5),
//      so p_out(q) is smooth and a warm start equals a cold start.
//   3. dΔ/dq at each root by central differences at ±1 % q on the frozen grid; a root is statically stable when dΔ/dq > 0.
//   4. A Δ minimum close to zero without a sign change is reported "marginal"; a sign change whose |Δ| stays above the
//      tolerance at both ends of a collapsed bracket is a DISCONTINUITY (with q and the jump), never a root (§4.7).
//   5. The operating point = the stable root with the highest rate; every root is listed.
//   Wellhead node: p_in = THP available (march up from the IPR pwf), p_out = THP required; same machinery (WS4: same answer).
//   The separator node is solved at the wellhead node (A1) and says so.
// STABILITY (§4.10). q_s, the static stability limit, is where dΔ/dq = 0 below the operating point (bracketed on the coarse curve,
//   polished by a secant step on fine central differences); only q < q_s is shaded. The tubing-curve minimum (dp_out/dq = 0) comes
//   from a parabola through the three coarse points around the smallest p_out — the conventional, more conservative rule; it lies
//   right of q_s. Heading flag: the operating point within 10 % above q_s. The static criterion does not predict heading dynamics.
// CHOKE (§4.7; A2, WP15). Multiphase: critical correlations (Gilbert, Ros, Baxendell, Achong) through WTS_chokeperf_multiphaseRate,
//   p1_crit(q) psig = q·a·GLR^c / S^b. The regime comes from the Sachdeva et al. (1986) critical ratio y_c (WTS_chokeperf_sachdeva,
//   fixed point ≤ 30 iterations) at the correlation's p1: critical (p2/p1 ≤ y_c) → p1 = p1_crit exactly; sub-critical → the Sachdeva
//   sub-critical mass rate scaled by the rate factor that makes it equal the correlation's rate at its critical point (continuous at
//   y_c; regime 'subcritical', model 'sachdeva-scaled'). surface.choke.corr 'sachdeva' = the Sachdeva model alone on both sides (Cd,
//   default 0.75, × surface.choke.rateFactor, default 1; model 'sachdeva'; it also carries the condensate and water of a gas well
//   through the bean). surface.choke.subcritical 'bound' keeps the A1 rule: the continuous conservative bound p1(q) =
//   max(p1_crit(q), p2 / y_c) with y_c = 0.588 (regime 'subcritical-bound'). Every Sachdeva use is provisional (D17). Gas and condensate:
//   the isentropic nozzle WTS_chokeperf_gasRate (critical and sub-critical, continuous), inverted for p1 by bisection; the liquids
//   of a wet gas are not in the nozzle (info). A liquid with no gas (GLR < 10 scf/STB): the incompressible orifice
//   q(bbl/d) = 1022.7·Cd·d²·√(Δp/SG) (d in, Δp psi; = 29.84 gal/min × 34.2857 = 8074/√62.4: Torricelli's 19.636 gal/min is for
//   head in FEET, and 1 psi = 2.31/SG ft of liquid).
// SURFACE (§4.8). Flowline marched back from the separator (Beggs & Brill by default, its own frozen grid) at one temperature (A1: no
//   line heat loss): the THT, or for a choked gas well the choke-downstream isenthalpic temperature (one more line march at the
//   temperature of the first pass); separator at a fixed pressure.
// LIQUID LOADING (§4.11). v_c = C·σ^¼·(ρ_L − ρ_g)^¼ / ρ_g^½ (ft/s; σ dyn/cm, ρ lbm/ft³), C = 1.912 Turner et al. (1969, with the
//   20 % uplift), 1.593 Coleman et al. (1991), 0.7241 Li et al. (2001, flat droplet); q_c (MMscf/d) = 3.067·p·v_c·A / ((T + 460)·z)
//   (p psia, A ft², T °F) at every traverse node from the wellhead to the tubing shoe (the node takes the conduit above it); the limiting
//   point is where q_c is largest; margin = q_op / q_c,max − 1. The casing / liner section below the end of tubing is reported apart
//   (belowEot, information) unless M.system.loadingRathole is true (then every node, the strict §4.11 reading). Liquid:
//   water when the well makes water, else condensate. Suggested method by the flowing wellhead pressure: Coleman below 500 psia,
//   Turner above 1,000 psia, both shown in between (Appendix A: the ranges of their data, to verify — Q9).
// EROSION (§4.12). API RP 14E V_e = C/√ρ_m (ft/s, lbm/ft³), C = M.system.eroC (default 100), at every step of the marcher — the
//   tubing traverse AND the flowline march; R.velocities reports the higher of the two and where (velocities.where).
// TEMPERATURE (§4.6). Linear THT → BHT along MD (A1), or with M.well.heat.mode 'relax' (A2, WP14) one relaxation profile per rate
//   from WTS_wp_well.relax (geotherm on TVD, relaxation along MD, decoupled from pressure) handed to the march as tProfile and used
//   for the THT of that rate (choke gas temperature, flowline temperature); R.heat summarises it at the operating point (A, f(t_D),
//   w, c_p, U, THT) and every traverse row carries te (the static earth temperature at its TVD).
// HYDRATE. THT_hyd (WTS_wp_well.temperature: J-T corrected for gas wells when the THT is not measured) and the choke-downstream
//   temperature (WTS_flowline_isenthalp) against WTS_hydrate_temp(p, sg); sg = the well-stream gravity for gas and condensate wells
//   (R.surface.sgHyd). ✗ below 0, ⚠ within 10 °F at either place.
// SHUT-IN (§4.14). (a) gas-filled from p̄r with the well-stream gas gravity (WTS_gradient_compute, average Z iterated with
//   WTS_gaspvt_z); (b) the actual fluid: a live-liquid column (oil + water by WC, densities from the fluid engine at the local p and T)
//   marched up from p̄r — for gas wells the gas column; (c) partly liquid-filled columns for liquid levels at 25 / 50 / 75 % of the
//   mid-perforation TVD (or o.levels). ✓ / ⚠ (within 10 %) / ✗ against rating.wellhead_psi; no verdict without a rating (Q20).
//
// EVALUATIONS (§16, D16). One fine evaluation E = one well traverse at the fine step + the flowline march + the choke; a coarse
//   evaluation counts ½ E. R.evals is in E; R.counts = {fine, coarse, line}. Budget for one solve: ≤ 16 E with one root (+ 4 E for
//   q_s), ≤ 20 E with two roots; wellperf-validate.js --time reports them per operation.
//
// Interfaces (field units, §3.0; psia inside, psig at surface inputs/outputs named *_psig; every result {ok, errors[], warnings[]}):
//   WTS_wp_system
//     .solve(M, ctx /*{warm: R.grid | {grid}, coarseOnly, live, node}*/)
//         → R = {ok, code?, node, mode, corr:{well, line}, roots:[{q, p, stable, dDdq}], op, qs, vlpMin, pwf, traverse,
//                breakdown:[{key, dp}], surface:{thp psia, thp_psig, tht, thtHyd (THT of the hydrate check), tHyd (hydrate T at
//                the THP), hydMargin, pChokeDn psia, pChokeDn_psig, tChokeDn, tHydDn, choke:{present, regime:'critical'|
//                'subcritical-bound'|'subcritical'|'liquid'|'none', ratio, yc, bean, corr, p1crit_psig, dp; A2: model 'sachdeva'|
//                'sachdeva-scaled'|null, rateFactor, x1, ycIt, cv, subcritical 'sachdeva'|'bound', cd, fallback}},
//                rates:{qo, qw, qg Mscf/d, qL}, velocities:{vmMax, eroMax, eroC, qEro}, curves:{ipr:[{q, p}], vlp:[{q, p}]},
//                scan:[{q, pOut, pIn, lost}], flags[], discontinuities[], loading, atTarget?, warnings, errors, evals, counts, grid,
//                heat:{mode:'relax'|'linear'|'static', tht, …relax: q, A, fTD, tD, U, U_to, Ubasis, r_to, rwb, ke, alpha, tProd_d, w, cp,
//                frac, teTop, offsetTop, verified:false, provisional} (A2)}; traverse rows also carry te (earth temperature, A2);
//                A2 (WP18, M.lift.type 'gaslift' with lift.gl.qinj_Mscfd > 0): rates.qinj / qgTotal, lift:{type, qinj, sginj, pinj_psig,
//                dpValve, packerMd, packerTvd, injMd, injTvd, pTub psia, pCas psia, atPacker, casing:[{md, tvd, p psia}]}, traverse rows
//                carry lift: true above the injection point}
//     .designFor(M, target /*{bean: q} | {thp: q} | {tubingId: q} | {qinj: q} (A2)*/) → Job: result() → {ok, bean | thp (psig), q, R, solves};
//                tubingId: {ok, tubingId in, tubKey, od, label, q, rows:[{key, label, id, od, ok, q, stable, loadingMargin, ero, thp, pwf,
//                regime}], current, solves, evals} — the smallest catalogue size whose stable rate reaches the target
//     .maxRate(M)   → {ok, q, thp_psig, tht, thtMax, rating:{verdict, margin}, R}
//     .shutIn(M, o?) → {ok, gasFilled, actualFluid, partLiquid:[{liquidTopMd, liquidTopTvd, sithp}], liquidLevelMd, sgCol, zAvg,
//                       sithp (worst), rating:{verdict:'ok'|'warn'|'fail'|'none', margin}, notes[]}   (pressures psig)
//     .chokeCurve(M, {R?}) → {ok, p1, p1_psig, tht, bean, corr, model, regime, yc, ycCorr, ycSachdeva, op:{y, q}, rateUnit,
//                              series:{sachdeva:[{y, q}], corr:[{y, q}], nozzle:[{y, q}]}, rateFactor, x1}   (A2: the choke tab)
//     .chokeFactor(M, corrKey, {R?}) → {ok, factor, corr, q, p1_psig, yc, cd}   the rate factor that scales the Sachdeva model to a
//                              critical correlation at the operating point's critical rate (§4.7)
//     .beanSchedule(M, beans) → Job: result() → [{bean, q, thp, tht, dpChoke, regime, stable, loadingMargin, ok}]
//     .job(steps)   the small Job helper (step / done / result / cancel / progress) used by the three Jobs
//   WTS_wp_loading(R, F, W) → {ok, applicable, method, suggested, qc_MMscfd, limitingMd, limitingTvd, margin, verdict,
//                              methods:{turner, coleman, li → {coef, qc_MMscfd, limitingMd, margin}}, perDepth:[{md, tvd, vg, vc, qc}]}
//   WTS_wp_check(M) → {ok, errors[] (text), warnings[{code, msg, sev, field}], items[{code, sev, field, msg}], validity:[{corr,
//                     label, inRange, msg, provisional}]}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    // WP5 replaces the WP0 stub file: its names leave window.__WP_STUBS
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    ['WTS_wp_system.solve', 'WTS_wp_system.designFor', 'WTS_wp_system.maxRate', 'WTS_wp_system.shutIn', 'WTS_wp_system.beanSchedule',
        'WTS_wp_loading', 'WTS_wp_check'].forEach(function (n) { var i = STUBS.indexOf(n); if (i !== -1) STUBS.splice(i, 1); });

    var PATM = 14.696, RANK = 459.67;
    var GILBERT_YC = 0.588;               // p2/p1 (absolute) critical ratio of the Gilbert family (49-calc-chokeperf.js GILBERT_CRIT)
    var TOL_P = 0.1;                      // psi, Brent |Δ| tolerance
    var TOL_Q = 1e-4;                     // relative Δq tolerance
    var MAX_ROOT_EVALS = 20;
    var N_DENSE = 320;                    // samples of the coarse interpolant for sign changes
    var HEADING_FRAC = 0.10;              // ⚠ within 10 % above q_s
    var SCAN_FRACS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2286, 0.3571, 0.4857, 0.6143, 0.7429, 0.8714, 0.995];
    var REF_INDEX = 7;                    // the scan point that records the coarse frozen grid
    var LOAD = { turner: { coef: 1.912, label: 'Turner et al. (1969)' }, coleman: { coef: 1.593, label: 'Coleman et al. (1991)' },
        li: { coef: 0.7241, label: 'Li et al. (2001)' } };
    var BIG = 1e6;
    var LIQ_ORIFICE = 1022.7;             // bbl/d per (in² · √(psi/SG)): incompressible orifice, q = 1022.7·Cd·d²·√(Δp/SG)
    var BD = { reservoir: 'reservoir', completion: 'completion', gravity: 'gravity', friction: 'friction', acceleration: 'acceleration',
        restrictions: 'restrictions', choke: 'choke', wellhead: 'wellhead', flowline: 'flowline' };
    var PROVISIONAL = 'provisional — not verified against a published example';
    var SACH_LABEL = 'Sachdeva et al. (1986)', SACH_RANGE = [8, 40];   // Appendix A: bean 8–40/64 in, the data range of the paper
    var CK_NAMES = { gilbert: 'Gilbert', ros: 'Ros', baxendell: 'Baxendell', achong: 'Achong', sachdeva: 'Sachdeva et al.' };
    function _corrName(k) { return CK_NAMES[k] || String(k || ''); }
    var DEF_LEVELS = [0.25, 0.5, 0.75];

    // ── helpers ──────────────────────────────────────────────────────────────
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev, field) { var o = { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; if (field) o.field = field; return o; }
    function _f(x, dp) {
        if (!_fin(x)) return '–';
        var s = (+x.toFixed(dp || 0)).toFixed(dp || 0), neg = s.charAt(0) === '-';
        if (neg) s = s.slice(1);
        var parts = s.split('.'), ip = parts[0], out = '';
        while (ip.length > 3) { out = ',' + ip.slice(-3) + out; ip = ip.slice(0, -3); }
        return (neg ? '−' : '') + ip + out + (parts[1] ? '.' + parts[1] : '');
    }
    function _clone(o) { return JSON.parse(JSON.stringify(o)); }
    function _get(o, path, d) { var c = o; for (var i = 0; i < path.length; i++) { if (c == null) return d; c = c[path[i]]; } return c === undefined ? d : c; }
    function _isGas(t) { return t === 'gas' || t === 'condensate' || t === 'gasinj'; }
    function _gasOnly(e) { return !!(e && (e.key === 'gasTZ' || (e.range && e.range.note === 'gas only'))); }
    function _fn(path) { var p = path.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]]; return typeof f === 'function' && (G.__WP_STUBS || []).indexOf(path) === -1 ? f : null; }
    function _fail(code, errors, extra) {
        var r = { ok: false, code: code, node: 'bottom', roots: [], op: null, qs: null, vlpMin: null, traverse: null, breakdown: [], surface: {},
            rates: {}, flags: [], discontinuities: [], warnings: [], errors: [].concat(errors || []), evals: 0, counts: { fine: 0, coarse: 0, line: 0 } };
        if (extra) for (var k in extra) r[k] = extra[k];
        return r;
    }

    // ── monotone cubic (Fritsch-Carlson) ─────────────────────────────────────
    function _pchip(xs, ys) {
        var n = xs.length, h = [], d = [], m = new Array(n), i;
        for (i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
        if (n === 1) return { f: function () { return ys[0]; }, df: function () { return 0; } };
        if (n === 2) return { f: function (x) { return ys[0] + d[0] * (x - xs[0]); }, df: function () { return d[0]; } };
        function endSlope(h0, h1, d0, d1) {
            var s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
            if (s * d0 <= 0) s = 0; else if (d0 * d1 <= 0 && Math.abs(s) > Math.abs(3 * d0)) s = 3 * d0;
            return s;
        }
        m[0] = endSlope(h[0], h[1], d[0], d[1]);
        m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
        for (i = 1; i < n - 1; i++) {
            if (d[i - 1] * d[i] <= 0) m[i] = 0;
            else { var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
        }
        function seg(x) { var k = 0; while (k < n - 2 && x > xs[k + 1]) k++; return k; }
        return {
            f: function (x) {
                var k = seg(x), t = (x - xs[k]) / h[k], t2 = t * t, t3 = t2 * t;
                return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1];
            },
            df: function (x) {
                var k = seg(x), t = (x - xs[k]) / h[k], t2 = t * t;
                return ((6 * t2 - 6 * t) * ys[k] + (3 * t2 - 4 * t + 1) * h[k] * m[k] + (-6 * t2 + 6 * t) * ys[k + 1] + (3 * t2 - 2 * t) * h[k] * m[k + 1]) / h[k];
            }
        };
    }

    // ── Brent (zeroin) on a bracket [a, b] with f(a)·f(b) < 0 ────────────────
    function _brent(f, a, b, fa, fb, maxIt) {
        var c = a, fc = fa, d = b - a, e = d, it = 0, conv = 'max';
        for (; it < maxIt; it++) {
            if ((fb > 0) === (fc > 0)) { c = a; fc = fa; d = b - a; e = d; }
            if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
            var tol = Math.max(TOL_Q * Math.abs(b), 1e-9), m = 0.5 * (c - b);
            if (Math.abs(fb) < TOL_P) { conv = 'f'; break; }
            if (Math.abs(m) <= tol) { conv = 'x'; break; }
            if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
                var s = fb / fa, p, q, r;
                if (a === c) { p = 2 * m * s; q = 1 - s; }
                else { q = fa / fc; r = fb / fc; p = s * (2 * m * q * (q - r) - (b - a) * (r - 1)); q = (q - 1) * (r - 1) * (s - 1); }
                if (p > 0) q = -q; else p = -p;
                if (2 * p < Math.min(3 * m * q - Math.abs(tol * q), Math.abs(e * q))) { e = d; d = p / q; }
                else { d = m; e = m; }
            } else { d = m; e = m; }
            a = b; fa = fb;
            b += Math.abs(d) > tol ? d : (m > 0 ? tol : -tol);
            fb = f(b);
        }
        return { x: b, fx: fb, other: c, fother: fc, it: it, conv: conv };
    }

    // ── the Job helper (PRiSM_autoInterp.drive protocol: step() → {done, progress, label}) ───────────────────────────────
    function job(spec) {
        var st = { done: false, i: 0, res: null, cancelled: false };
        return {
            step: function () {
                if (!st.done && !st.cancelled) {
                    var r = spec.next(st.i++);
                    if (r === true) { st.done = true; st.res = spec.finish(); }
                } else if (!st.res) { st.done = true; st.res = spec.finish(); }
                var pr = spec.progress ? spec.progress(st.i) : (st.done ? 1 : 0);
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, pr), label: spec.label ? spec.label(st.i) : '' };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : (spec.progress ? spec.progress(st.i) : 0); },
            result: function () { if (!st.res) st.res = spec.finish(); return st.res; },
            cancel: function () { st.cancelled = true; }
        };
    }

    // ── context: fluid, inflow, well, correlations ───────────────────────────
    function _ctx(M, o) {
        o = o || {};
        var errs = [], need = ['WTS_wp_fluid.build', 'WTS_wp_ipr.curve', 'WTS_wp_well.build', 'WTS_wp_vlp.traverse'];
        for (var i = 0; i < need.length; i++) if (!_fn(need[i])) return { fail: _fail('MISSING_ENGINE', [need[i] + ' is not available'], { name: need[i] }) };
        if (typeof G.WTS_flowline_march !== 'function') return { fail: _fail('MISSING_ENGINE', ['WTS_flowline_march is not available'], { name: 'WTS_flowline_march' }) };
        if (!M || !M.fluid || !M.res || !M.well) return { fail: _fail('NO_MODEL', ['the model is incomplete']) };
        var type = M.fluid.type || 'oil';
        if (type === 'waterinj' || type === 'gasinj') return { fail: _fail('INJECTOR', ['Injection wells are solved in a later release (this release solves producers).']) };
        // the (p, T)-binned property table of the marcher (§4.5, WP0b FI9: < 0.05 % in BHP) — built once per solve; o.table false = exact props
        var F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F, table: o.table !== false });
        if (!F || !F.ok) return { fail: _fail('NEEDS_FLUID', (F && F.errors && F.errors.length) ? F.errors : ['the fluid is incomplete'], { F: F }) };
        var I = G.WTS_wp_ipr.curve(M.res, F);
        if (!I || !I.ok) return { fail: _fail('NEEDS_IPR', (I && I.errors && I.errors.length) ? I.errors : ['the inflow is incomplete (p̄r and the model parameters)'], { F: F, I: I }) };
        if (!(I.aof > 0)) return { fail: _fail('NEEDS_IPR', ['the inflow has no open-flow rate'], { F: F, I: I }) };
        var W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: type, tests: M.tests, surface: M.surface });
        if (!W || !W.ok || !W.segments || !W.segments.length) return { fail: _fail('NEEDS_WELL', (W && W.errors && W.errors.length) ? W.errors : ['the well has no flow path (survey and strings)'], { F: F, I: I, W: W }) };
        var sys = M.system || {}, V = G.WTS_wp_vlp;
        var corrWell = (sys.corr && sys.corr.well) ? String(sys.corr.well) : (V.defaultCorr ? V.defaultCorr(F).key : 'bb');
        var corrLine = (sys.corr && sys.corr.line) ? String(sys.corr.line) : 'bb';
        var REG = G.WTS_flowline_corr || {};
        if (!REG[corrWell]) return { fail: _fail('UNKNOWN_CORR', ['unknown correlation key ' + String(corrWell).slice(0, 40)], { F: F, I: I, W: W }) };
        if (!REG[corrLine]) return { fail: _fail('UNKNOWN_CORR', ['unknown flowline correlation key ' + String(corrLine).slice(0, 40)], { F: F, I: I, W: W }) };
        // a dry-gas-only method (the liquids are ignored) is not applicable to an oil or water well: refused, never a silent answer
        if (!_isGas(type) && (_gasOnly(REG[corrWell]) || _gasOnly(REG[corrLine])))
            return { fail: _fail('CORR_NOT_APPLICABLE', ['The dry-gas method (' + (_gasOnly(REG[corrWell]) ? REG[corrWell].label || corrWell : REG[corrLine].label || corrLine) + ') ignores the oil and water columns: it is not applicable to a ' + type + ' well. Choose another correlation.'], { F: F, I: I, W: W }) };
        var mode = o.mode || sys.mode || 'rate';
        var choke = M.surface && M.surface.choke ? M.surface.choke : { present: false };
        var mult = sys.mult && (+sys.mult.hl !== 1 || +sys.mult.f !== 1) ? { hl: _fin(+sys.mult.hl) ? +sys.mult.hl : 1, f: _fin(+sys.mult.f) ? +sys.mult.f : 1 } : null;
        var node = o.node || sys.node || 'bottom';
        var C = {
            M: M, F: F, I: I, W: W, type: type, gas: _isGas(type), corrWell: corrWell, corrLine: corrLine, mode: mode,
            node: node === 'separator' ? 'wellhead' : (node === 'wellhead' ? 'wellhead' : 'bottom'), nodeAsked: node,
            stepFt: +sys.stepFt > 0 ? +sys.stepFt : 100, stepFtLine: +sys.stepFtLine > 0 ? +sys.stepFtLine : 50,
            refine: sys.refine !== false, eroC: +sys.eroC > 0 ? +sys.eroC : 100, mult: mult,
            pr: +I.pr, aof: +I.aof, psep: _fin(_n(_get(M, ['surface', 'psep_psig']))) ? +M.surface.psep_psig : 100,
            choke: { present: mode !== 'max' && !!choke.present && !o.noChoke, bean: _n(choke.bean64), corr: choke.corr || 'gilbert', cd: _n(choke.cd),
                sub: choke.subcritical === 'bound' ? 'bound' : 'sachdeva', rateFactor: _n(choke.rateFactor), cdS: (_n(choke.cd) >= 0.3 && _n(choke.cd) <= 1.2) ? _n(choke.cd) : 0.75 },
            thpFix: _n(sys.thp_psig), flowline: (M.surface && Array.isArray(M.surface.flowline) ? M.surface.flowline : []).filter(function (s) { return s && +s.len > 0 && +s.id > 0; }),
            tht: (W.temp && _fin(W.temp.tht)) ? W.temp.tht : (W.tAt ? W.tAt(0) : 100),
            grids: { coarse: null, fine: null, line: null }, cache: {}, counts: { fine: 0, coarse: 0, line: 0 }, warnings: [], lostSeen: {}, trWarn: null,
            // A2 (WP14, §4.6): the relaxation model — one flowing-temperature profile per rate, before the march (tProfile)
            relax: !!(M.well.heat && M.well.heat.mode === 'relax') && _fn('WTS_wp_well.relax') !== null, tCache: {}
        };
        C.pMax = Math.max(2 * C.pr, C.pr + 3000);
        // gas lift (A2, WP18; §7.1): M.lift.type 'gaslift' with an injection rate lift.gl.qinj_Mscfd > 0 (0 or blank = natural flow, the
        // exact natural-flow path). Single injection point: the shallower of the packer depth and the depth where the casing gas column
        // (WTS_gaslift_casingP from the surface injection pressure) less the valve ΔP equals the tubing pressure; above it the lift gas
        // is free gas only (fluid.pvt.injGas, WP0b), below it the formation fluid.
        var lf = M.lift || {}, glS = lf.gl || {}, qinj = _n(glS.qinj_Mscfd);
        if (lf.type === 'gaslift' && qinj > 0 && !o.noLift) {
            if (_isGas(type)) return { fail: _fail('GL_NOT_APPLICABLE', ['Gas lift is a quick look for oil wells; this well is a ' + type + ' well.'], { F: F, I: I, W: W }) };
            var pinj = _n(glS.pinj_psig);
            if (!(pinj > 0)) return { fail: _fail('NEEDS_PINJ', ['Gas lift: the surface injection (casing) pressure is needed (step ④).'], { F: F, I: I, W: W }) };
            if (typeof G.WTS_gaslift_casingP !== 'function') return { fail: _fail('MISSING_ENGINE', ['WTS_gaslift_casingP is not available'], { name: 'WTS_gaslift_casingP' }) };
            var shoe = W.nodes && _fin(W.nodes.tubingShoeMd) ? W.nodes.tubingShoeMd : null, mid = W.nodes.midPerfMd;
            var pk = _n(glS.packerMd), pkMax = Math.min(_fin(shoe) ? shoe : mid, mid);
            if (!(pk > 0)) pk = pkMax;
            if (pk > pkMax) { C.warnings.push(_w('GL_PACKER_DEEP', 'Gas lift: the packer depth is below the end of the tubing; the injection point is limited to ' + _f(pkMax, 0) + ' ft MD.', 'info')); pk = pkMax; }
            var sgi = _n(glS.sginj) > 0.5 && _n(glS.sginj) < 2 ? _n(glS.sginj) : 0.65, dpv = _n(glS.dpValve), pvtLift = {};
            Object.keys(F.pvt || {}).forEach(function (k) { pvtLift[k] = F.pvt[k]; });
            pvtLift.injGas = { qg_MMscfd: qinj / 1000, sg: sgi };
            var Finj = {}; Object.keys(F).forEach(function (k) { Finj[k] = F[k]; }); Finj.pvt = pvtLift;
            C.gl = { qinj: qinj, sg: sgi, pinj: pinj, dpv: _fin(dpv) && dpv >= 0 ? dpv : 100, packerMd: pk, packerTvd: W.tvdAt ? W.tvdAt(pk) : null, Finj: Finj, cas: {} };
        }
        if (C.choke.present && !(C.choke.bean > 0)) return { fail: _fail('NEEDS_BEAN', ['the choke bean size is needed (or take the choke out of line)'], { F: F, I: I, W: W }) };
        if (!C.choke.present && mode !== 'max' && !_fin(C.thpFix)) { C.maxBC = true; C.warnings.push(_w('NO_THP', 'No wellhead pressure entered: the lowest admissible THP (separator + flowline) is used.', 'info', 'wp_thp')); }
        if (mode === 'max') C.maxBC = true;
        var warm = o.warm && (o.warm.grid || o.warm);
        if (warm && warm.dir === C.node) { C.grids.coarse = warm.coarse || null; C.grids.fine = warm.fine || null; C.grids.line = warm.line || null; }
        return { C: C };
    }

    // the flowing-temperature profile at a rate (relaxation mode; null = the linear profile W.tAt) and the THT at that rate
    function _tProf(C, q) {
        if (!C.relax || !(q > 0)) return null;
        var k = String(q);
        if (C.tCache[k] !== undefined) return C.tCache[k];
        var r = G.WTS_wp_well.relax(C.W, C.F, q);
        if (!r || !r.ok) {
            if (!C.relaxFail) { C.relaxFail = true; C.warnings.push(_w('RELAX_FALLBACK', 'Relaxation model not available (' + ((r && r.errors && r.errors[0]) || 'failed') + '): the linear THT → BHT profile is used.', 'warn', 'wp_heat')); }
            C.relax = false; return null;
        }
        C.tCache[k] = r;
        return r;
    }
    function _thtQ(C, q) { var r = _tProf(C, q); return r ? r.tht : C.tht; }

    // ── surface boundary: THP required at a rate (choke + flowline + separator, or fixed) ─────────────────────────────
    function _line(C, q, tLine) {
        if (!C.flowline.length) return { p2: C.psep + PATM, dp: 0, eroMax: null, vmMax: null };
        var ff = _ffs(C, q);
        var segs = C.flowline.map(function (s) { return { name: s.name || 'Flowline', len: +s.len, id: +s.id, dz: +s.dz || 0 }; });
        var mo = { reverse: true, corr: C.corrLine, stepFt: C.stepFtLine, rough: 0.0018, accel: true, payne: true, refine: C.refine, eroC: C.eroC };
        mo.grid = C.grids.line || true;
        var tl = _fin(tLine) ? tLine : _thtQ(C, q);
        var m = G.WTS_flowline_march(segs, ff, C.psep, tl, tl, mo);
        C.counts.line++;
        if (!m || m.ok === false) return { lost: true, reason: (m && m.code) || 'failed' };
        if (!C.grids.line && m.grid) C.grids.line = m.grid;
        if (m.lost) return { lost: true, reason: m.lost.reason };
        // the erosion check covers the flowline too (§4.12): the segment maxima of the march
        var ero = null, vm = null;
        (m.segments || []).forEach(function (sg) { if (_fin(sg.eroMax) && (ero == null || sg.eroMax > ero)) ero = sg.eroMax; if (_fin(sg.vmMax) && (vm == null || sg.vmMax > vm)) vm = sg.vmMax; });
        return { p2: m.pOut + PATM, dp: m.pOut - C.psep, eroMax: ero, vmMax: vm, tLine: tl };
    }
    // Cp/Cv of the choke gas: one value per solve (ideal-gas heat capacity at the THT, WTS_gaspvt_state; 1.28 without it)
    function _kGas(C, T) {
        if (_fin(C.kGas)) return C.kGas;
        var st = typeof G.WTS_gaspvt_state === 'function' ? G.WTS_gaspvt_state(C.F.sgg, 1000, T) : null;
        C.kGas = (st && st.k > 1 && st.k < 1.7) ? st.k : 1.28;
        return C.kGas;
    }
    // ── gas lift helpers (A2, WP18) ───────────────────────────────────────────
    // the surface stream: the formation fluid, plus the lift gas above the injection point (and in the choke and flowline)
    function _ffs(C, q) { return G.WTS_wp_fluid.flowlineFluid(C.gl ? C.gl.Finj : C.F, q); }
    // casing pressure (psia) at a measured depth: the static lift-gas column from the surface injection pressure (WTS_gaslift_casingP,
    // DAK Z) over the TVD, at the flowing-temperature profile; cached per 25 ft of MD for one solve (the column does not depend on q)
    function _pCas(C, md) {
        var k = Math.round(md / 25), c = C.gl.cas[k];
        if (c != null) return c;
        var m = k * 25, tvd = C.W.tvdAt ? C.W.tvdAt(Math.max(0, m)) : m, t0 = C.W.tAt ? C.W.tAt(0) : C.tht, t1 = C.W.tAt ? C.W.tAt(Math.max(0, m)) : t0;
        var r = G.WTS_gaslift_casingP(C.gl.pinj, Math.max(0, tvd), C.gl.sg, t0, t1);
        c = C.gl.cas[k] = (r && _fin(r.p)) ? r.p + PATM : NaN;
        return c;
    }
    function _pCasAt(C, md) { var a = Math.floor(md / 25) * 25, f = (md - a) / 25; return _pCas(C, a) * (1 - f) + _pCas(C, a + 25) * f; }
    function _wPart(C, fromMd, toMd) {
        var sg = G.WTS_wp_well.segmentsFor(C.W, { from: fromMd, toMd: toMd });
        return { segments: Array.isArray(sg) ? sg : [], tAt: C.W.tAt, nodes: C.W.nodes };
    }
    // the injection depth on a profile of {md, p} rows (MD order): the first MD where p_tub ≥ p_cas − ΔP_valve (top-down: the gas can
    // enter above it), or the deepest MD ≤ the packer where p_tub ≤ p_cas − ΔP_valve (bottom-up); linear between the rows
    function _injOn(C, prof, dir) {
        var rows = prof.filter(function (r) { return !r.restr && r.md <= C.gl.packerMd + 1e-6; }), g = function (r) { return r.p - (_pCasAt(C, r.md) - C.gl.dpv); };
        if (!rows.length) return null;
        if (dir === 'down') {
            if (g(rows[0]) >= 0) return { none: true };
            for (var i = 1; i < rows.length; i++) { var a = g(rows[i - 1]), b = g(rows[i]); if (b >= 0) { var f = a / (a - b); return { md: rows[i - 1].md + f * (rows[i].md - rows[i - 1].md), p: rows[i - 1].p + f * (rows[i].p - rows[i - 1].p), balance: true }; } }
            var l = rows[rows.length - 1]; return { md: l.md, p: l.p, balance: false };
        }
        for (var j = rows.length - 1; j >= 0; j--) {
            if (g(rows[j]) <= 0) {
                if (j === rows.length - 1) return { md: rows[j].md, p: rows[j].p, balance: false };
                var a2 = g(rows[j]), b2 = g(rows[j + 1]), f2 = a2 / (a2 - b2);
                return { md: rows[j].md + f2 * (rows[j + 1].md - rows[j].md), p: rows[j].p + f2 * (rows[j + 1].p - rows[j].p), balance: true };
            }
        }
        return { none: true };
    }
    // one gas-lifted well evaluation at q: the tubing in two marches (lift gas above the injection point, formation fluid below);
    // the frozen step layout is not used (the injection depth moves with q). → a traverse-like object (profile, segments, pEnd, …)
    function _glTraverse(C, q, p0, dir, keep) {
        var V = G.WTS_wp_vlp, o = { corr: C.corrWell, stepFt: C.stepFt, eroC: C.eroC, refine: C.refine, pMax: C.pMax };
        if (C.mult) o.mult = C.mult;
        var tpg = _tProf(C, q); if (tpg) o.tProfile = tpg.tAt;     // relaxation mode (WP14): the formation-fluid profile at q
        var mid = C.W.nodes.midPerfMd, inj, up, lo;
        if (dir === 'down') {
            up = V.traverse(C.gl.Finj, _wPart(C, C.gl.packerMd, 0), q, Object.assign({}, o, { from: 'top', p0: p0 }));
            if (!up.ok) return up;
            inj = _injOn(C, up.profile, 'down');
            if (!inj || inj.none) return { ok: false, lost: { reason: 'injection' }, warnings: up.warnings, code: 'GL_NO_INJECTION' };
            if (keep && inj.md < C.gl.packerMd - 1) { up = V.traverse(C.gl.Finj, _wPart(C, inj.md, 0), q, Object.assign({}, o, { from: 'top', p0: p0 })); if (up.ok) inj.p = up.pEnd; C.counts.fine += 0.5; }
            lo = inj.md < mid - 1 ? V.traverse(C.F, _wPart(C, mid, inj.md), q, Object.assign({}, o, { from: 'top', p0: inj.p })) : { ok: true, profile: [], segments: [], pEnd: inj.p, vmMax: 0, eroMax: 0, restrictionsDp: 0, warnings: [] };
            if (!lo.ok) return lo;
        } else {
            var full = V.traverse(C.F, C.W, q, Object.assign({}, o, { from: 'bottom', p0: p0 }));
            if (!full.ok) return full;
            inj = _injOn(C, full.profile, 'up');
            if (!inj || inj.none) return { ok: false, lost: { reason: 'injection' }, warnings: full.warnings, code: 'GL_NO_INJECTION' };
            // below the injection point the full formation march is the lower part already (same fluid, same start): its pressure at
            // the injection depth starts the lifted march up (the wellhead node's reported traverse is re-marched top-down in _atOp)
            lo = { ok: true, profile: full.profile, segments: [], pEnd: inj.p, vmMax: full.vmMax, eroMax: full.eroMax, restrictionsDp: 0, warnings: [] };
            up = V.traverse(C.gl.Finj, _wPart(C, inj.md, 0), q, Object.assign({}, o, { from: 'bottom', p0: inj.p }));
            if (!up.ok) return up;
        }
        var upRows = up.profile.filter(function (r) { return r.md <= inj.md + 1e-6; });
        var prof = upRows.concat(lo.profile.filter(function (r) { return r.md > inj.md + 1e-6; }));
        prof.forEach(function (r) { r.lift = r.md <= inj.md + 1e-6; });
        var upSegs = keep || dir !== 'down' ? up.segments : up.segments.filter(function (s) { return s.mdBot <= inj.md + 1e-6; });
        var injTvd = C.W.tvdAt ? C.W.tvdAt(inj.md) : null;
        return { ok: true, profile: prof, segments: upSegs.concat(lo.segments || []), pEnd: dir === 'down' ? lo.pEnd : up.pEnd, pBottom: dir === 'down' ? lo.pEnd : p0,
            vmMax: Math.max(up.vmMax || 0, lo.vmMax || 0), eroMax: Math.max(up.eroMax || 0, lo.eroMax || 0), restrictionsDp: (up.restrictionsDp || 0) + (lo.restrictionsDp || 0),
            warnings: (up.warnings || []).concat(lo.warnings || []), lost: null, corr: up.corr,
            lift: { qinj: C.gl.qinj, injMd: inj.md, injTvd: injTvd, pTub: inj.p, pCas: _pCasAt(C, inj.md), balance: !!inj.balance, packerMd: C.gl.packerMd } };
    }

    // the upstream pressure p1 (psia) that passes q Mscf/d through the nozzle to p2 psia: WTS_chokeperf_gasRate is linear in p1/√z(p1)
    // when critical (fixed point on z), and monotone in p1 below the critical ratio (regula falsi, Illinois, on [p2, p2/r_c])
    function _gasP1(C, q, p2, T) {
        var gr = G.WTS_chokeperf_gasRate, s64 = C.choke.bean, cd = (C.choke.cd >= 0.5 && C.choke.cd <= 1.2) ? C.choke.cd : 0.85, tR = T + RANK, sg = C.F.sgg;
        if (typeof gr !== 'function') return null;
        var k = _kGas(C, T), rc = Math.pow(2 / (k + 1), k / (k - 1));
        var zAt = function (p) { var pr = C.F.at(Math.max(p, 15), T); return (pr && pr.z > 0) ? pr.z : 0.9; };
        var rate = function (p1, z) { return gr({ s64: s64, cd: cd, p1a: p1, p2a: p2, tR: tR, sg: sg, k: k, z: z == null ? zAt(p1) : z }); };
        if (!(q > 0)) return { p1: p2, regime: 'subcritical', yc: rc };
        // critical branch: q = K·p1/√z  →  p1 = q·√z / K, K from one call at z = 1
        var K1 = rate(Math.max(p2 / rc * 1.5, p2 + 10), 1) / Math.max(p2 / rc * 1.5, p2 + 10);
        if (!(K1 > 0)) return null;
        var z = 0.9, p1 = q * Math.sqrt(z) / K1;
        for (var it = 0; it < 8; it++) { var zn = zAt(p1), pn = q * Math.sqrt(zn) / K1; if (Math.abs(pn - p1) < 1e-8 * pn) { p1 = pn; break; } p1 = pn; z = zn; }
        if (p2 / p1 <= rc) return { p1: p1, regime: 'critical', yc: rc };
        // sub-critical: f(p1) = rate(p1) − q on [p2, p2/rc], rate(p2) = 0 < q ≤ rate(p2/rc)
        var a = p2, fa = -q, b = p2 / rc, fb = rate(b) - q, side = 0;
        if (fb < 0) return { p1: b, regime: 'critical', yc: rc };
        for (var j = 0; j < 40; j++) {
            var x = (a * fb - b * fa) / (fb - fa), fx = rate(x) - q;
            if (Math.abs(fx) < 1e-6 * q || Math.abs(b - a) < 1e-7 * b) { a = b = x; break; }
            if ((fx > 0) === (fb > 0)) { b = x; fb = fx; if (side === -1) fa /= 2; side = -1; }
            else { a = x; fa = fx; if (side === 1) fb /= 2; side = 1; }
        }
        return { p1: 0.5 * (a + b), regime: 'subcritical', yc: rc };
    }
    // ── Sachdeva et al. (1986) choke node (A2, WP15; §4.7) ────────────────────
    // The inlet mixture at (p psia, T °F) for the rate q: the free-gas mass fraction x1, the liquid and gas densities, the total mass
    // rate (lbm/s; conserved along the stream: the oil density carries its dissolved gas) and the liquid heat capacity (oil 0.5,
    // water 1.0 Btu/lbm·°F, mass weighted).
    function _mixAt(C, q, p, T) {
        var pr = C.gl ? G.WTS_flowline_props(_ffs(C, q), Math.max(p, 15), T) : C.F.at(Math.max(p, 15), T, q);
        if (!pr) return null;
        var wO = pr.qL * pr.fo * pr.rhoO, wW = pr.qL * pr.fw * pr.rhoW, wL = wO + wW, wG = pr.qG * pr.rhoG, w = wL + wG;
        if (!(w > 0)) return null;
        return { x1: wG / w, rhoL: pr.rhoL > 0 ? pr.rhoL : (pr.rhoO || pr.rhoW || 50), rhoG1: pr.rhoG, w: w, cL: wL > 0 ? (0.5 * wO + 1.0 * wW) / wL : 0.5, sg: pr.sgGas > 0 ? pr.sgGas : C.F.sgg };
    }
    function _sachAt(C, q, p1, p2, T) {
        var m = _mixAt(C, q, p1, T), sd = G.WTS_chokeperf_sachdeva;
        if (!m || typeof sd !== 'function') return null;
        var cd = _fin(C.choke.cdS) ? C.choke.cdS : 0.75;
        var r = sd({ s64: C.choke.bean, cd: cd, p1a: p1, p2a: p2, x1: m.x1, rhoL: m.rhoL, rhoG1: m.rhoG1, k: _kGas(C, T), sg: m.sg, cL: m.cL });
        if (!r || !r.ok) return null;
        r.mix = m;
        return r;
    }
    // the upstream pressure p1 (psia) that passes q through the bean to p2 psia: fac·w_Sachdeva(p1, p2) = w(q), Illinois on [p2, hi]
    // (w_Sachdeva rises with p1). empKey: a critical correlation the model is scaled to at its critical point (the rate factor of §4.7):
    // in critical flow p1 is the correlation's p1 exactly, below the Sachdeva critical ratio the scaled sub-critical branch continues it.
    function _sachTop(C, q, p2, T, empKey, glr, qL) {
        var m0 = _mixAt(C, q, p2, T);
        if (!m0) return null;
        var W = m0.w, fac = _fin(C.choke.rateFactor) && C.choke.rateFactor > 0 ? C.choke.rateFactor : 1, p1e = null, sc = null;
        if (empKey) {
            var mp = G.WTS_chokeperf_multiphaseRate, per = typeof mp === 'function' && glr > 0 ? mp(empKey, 1, C.choke.bean, glr) : NaN;
            if (!(per > 0)) return null;
            p1e = qL / per + PATM;
            sc = _sachAt(C, q, p1e, p1e * 1e-6, T);                         // the critical (choked) Sachdeva rate at the correlation's p1
            if (!sc || !(sc.w > 0)) return null;
            fac = W / sc.w;
            if (p2 / p1e <= sc.yc) return { p1: p1e, regime: 'critical', yc: sc.yc, fac: fac, x1: sc.mix.x1, it: sc.it, p1crit: p1e - PATM, model: 'sachdeva-scaled' };
        }
        var f = function (p1) { var s = _sachAt(C, q, p1, p2, T); return s ? { v: fac * s.w - W, s: s } : null; };
        var a = p2 * (1 + 1e-9), fa = -W, b = empKey ? p1e : Math.max(p2 * 1.25, p2 + 20), rb = f(b), side = 0, last = rb;
        if (!rb) return null;
        for (var dbl = 0; rb.v < 0 && dbl < 30; dbl++) { a = b; fa = rb.v; b *= 1.6; rb = f(b); if (!rb) return null; last = rb; }
        if (rb.v < 0) return null;
        var fb = rb.v;
        for (var j = 0; j < 80; j++) {
            var x = (a * fb - b * fa) / (fb - fa), fx = f(x);
            if (!fx) return null;
            last = fx;
            if (Math.abs(fx.v) <= 1e-11 * W || Math.abs(b - a) <= 1e-11 * b) { a = b = x; break; }
            if ((fx.v > 0) === (fb > 0)) { b = x; fb = fx.v; if (side === -1) fa /= 2; side = -1; }
            else { a = x; fa = fx.v; if (side === 1) fb /= 2; side = 1; }
        }
        var p1 = 0.5 * (a + b), sl = last.s;
        return { p1: p1, regime: sl.critical ? 'critical' : 'subcritical', yc: sl.yc, fac: fac, x1: sl.mix.x1, it: sl.it, p1crit: p1e != null ? p1e - PATM : null, model: empKey ? 'sachdeva-scaled' : 'sachdeva' };
    }
    function _top(C, q) {
        var tht = _thtQ(C, q);
        var ln = _line(C, q);
        if (ln.lost) return { lost: true, reason: 'flowline ' + ln.reason };
        var out = { p2: ln.p2, lineDp: ln.dp, regime: 'none', ratio: null, yc: null, p1crit: null, lineEro: ln.eroMax, lineVm: ln.vmMax, tLine: ln.tLine != null ? ln.tLine : null };
        if (C.maxBC) { out.thp = ln.p2; return out; }
        if (!C.choke.present) { out.thp = C.thpFix + PATM; out.fixed = true; return out; }
        if (C.gas && C.choke.corr === 'sachdeva') {
            // the continuous two-phase model carries the condensate and water through the bean too (the gas nozzle does not)
            var sg0 = _sachTop(C, q, ln.p2, C.tht, null);
            if (!sg0) return { lost: true, reason: 'choke' };
            out.thp = sg0.p1; out.regime = sg0.regime; out.yc = sg0.yc; out.ratio = ln.p2 / sg0.p1; out.model = sg0.model; out.rateFactor = sg0.fac; out.x1 = sg0.x1; out.ycIt = sg0.it;
            return out;
        }
        if (C.gas) {
            var g = _gasP1(C, q, ln.p2, tht);
            if (!g) return { lost: true, reason: 'choke' };
            // the flowline runs at the choke-downstream (isenthalpic) temperature, not at the THT: exactly one more line march at the
            // temperature of the first pass (deterministic, so p_out(q) stays smooth)
            if (C.flowline.length && typeof G.WTS_flowline_isenthalp === 'function') {
                var tdR = G.WTS_flowline_isenthalp(_sgHyd(C), g.p1, tht, ln.p2), td = tdR && _fin(tdR.t) ? tdR.t : null;
                if (_fin(td) && td < tht) {
                    var ln2 = _line(C, q, td), g2 = ln2.lost ? null : _gasP1(C, q, ln2.p2, tht);
                    if (g2) { ln = ln2; g = g2; out.p2 = ln.p2; out.lineDp = ln.dp; out.lineEro = ln.eroMax; out.lineVm = ln.vmMax; out.tLine = td; }
                }
            }
            out.thp = g.p1; out.regime = g.regime; out.yc = g.yc; out.ratio = ln.p2 / g.p1;
            return out;
        }
        var ff = G.WTS_wp_fluid.flowlineFluid(C.F, q), qL = ff.qo + ff.qw, glr = qL > 0 ? (ff.qg_MMscfd * 1e6 + (C.gl ? C.gl.qinj * 1000 : 0)) / qL : 0;
        if (glr < 10) {
            var cd = (C.choke.cd >= 0.5 && C.choke.cd <= 1.2) ? C.choke.cd : 0.85, d = C.choke.bean / 64, sgL = ff.qw > 0 && ff.qo > 0 ? (ff.qw * C.F.sgw + ff.qo * 141.5 / (131.5 + C.F.api)) / qL : (ff.qw > 0 ? C.F.sgw : 141.5 / (131.5 + C.F.api));
            // the liquid valve-coefficient law of the choke file (A2, WTS_chokeperf_liquidCv: the same 1022.7 orifice constant)
            var lc = typeof G.WTS_chokeperf_liquidCv === 'function' ? G.WTS_chokeperf_liquidCv({ s64: C.choke.bean, cd: cd, sg: sgL, q_bpd: qL }) : null;
            var dp = (lc && lc.ok) ? lc.dp_psi : sgL * Math.pow(qL / (LIQ_ORIFICE * cd * d * d), 2);
            out.thp = ln.p2 + dp; out.regime = 'liquid'; out.ratio = ln.p2 / out.thp; if (lc && lc.ok) out.cv = lc.cv;
            return out;
        }
        if (C.choke.corr === 'sachdeva') {
            var sp = _sachTop(C, q, ln.p2, C.tht, null);
            if (!sp) return { lost: true, reason: 'choke' };
            out.thp = sp.p1; out.regime = sp.regime; out.yc = sp.yc; out.ratio = ln.p2 / sp.p1; out.model = sp.model; out.rateFactor = sp.fac; out.x1 = sp.x1; out.ycIt = sp.it;
            return out;
        }
        var mp = G.WTS_chokeperf_multiphaseRate;
        if (typeof mp !== 'function') return { lost: true, reason: 'choke engine missing' };
        var per = mp(C.choke.corr, 1, C.choke.bean, glr);           // q per psig of p1 (linear in p1)
        if (!(per > 0)) return { lost: true, reason: 'choke' };
        var p1crit = qL / per, pBound = ln.p2 / GILBERT_YC - PATM;
        out.p1crit = p1crit; out.yc = GILBERT_YC;
        if (C.choke.sub !== 'bound') {
            // A2 (§4.7): one regime criterion, the Sachdeva et al. (1986) critical ratio y_c at the correlation's p1. Critical: the
            // correlation's p1 exactly; sub-critical: the Sachdeva sub-critical branch scaled to the correlation at its critical point
            // (rate factor) — continuous with it. The A1 conservative bound p1 ≥ p2 / 0.588 stays available as choke.subcritical 'bound'.
            var hs = _sachTop(C, q, ln.p2, C.tht, C.choke.corr, glr, qL);
            if (hs) { out.thp = hs.p1; out.regime = hs.regime; out.yc = hs.yc; out.model = hs.model; out.rateFactor = hs.fac; out.x1 = hs.x1; out.ycIt = hs.it; out.ratio = ln.p2 / out.thp; return out; }
            out.fallback = true;                                         // the Sachdeva inlet state failed: the A1 bound, flagged
        }
        if (p1crit >= pBound) { out.thp = p1crit + PATM; out.regime = 'critical'; }
        else { out.thp = pBound + PATM; out.regime = 'subcritical-bound'; }
        out.ratio = ln.p2 / out.thp;
        return out;
    }

    // ── one evaluation at q: Δ at the node ───────────────────────────────────
    function _eval(C, q, fine, keep) {
        var key = (fine ? 'f' : 'c') + q;
        if (C.cache[key]) return C.cache[key];
        var V = G.WTS_wp_vlp, r = { q: q, fine: fine };
        var top = _top(C, q);
        r.top = top;
        var pwfI = C.I.pwfAt(q);
        var gkey = fine ? 'fine' : 'coarse';
        var o = { corr: C.corrWell, stepFt: C.stepFt, coarse: !fine, eroC: C.eroC, refine: C.refine, pMax: C.pMax };
        if (C.mult) o.mult = C.mult;
        var tpr = _tProf(C, q); if (tpr) o.tProfile = tpr.tAt;
        o.grid = C.grids[gkey] || true;
        if (fine) C.counts.fine++; else C.counts.coarse++;
        if (top.lost) { r.lost = { reason: top.reason }; r.delta = BIG; r.pOut = null; r.pIn = C.node === 'bottom' ? pwfI : null; C.cache[key] = r; return r; }
        var tr;
        if (C.gl) {
            if (C.node === 'bottom') { tr = _glTraverse(C, q, top.thp, 'down', keep); r.pIn = pwfI; r.pOut = tr.ok ? tr.pEnd : null; }
            else { tr = (pwfI > PATM) ? _glTraverse(C, q, pwfI, 'up', keep) : { ok: false, lost: { reason: 'pressure' }, warnings: [] }; r.pOut = top.thp; r.pIn = tr.ok ? tr.pEnd : null; }
            if (fine) C.counts.fine += 0.5; else C.counts.coarse += 0.5;      // two partial marches (≈ 1.5 traverses of the path)
        } else if (C.node === 'bottom') {
            o.from = 'top'; o.p0 = top.thp;
            tr = V.traverse(C.F, C.W, q, o);
            r.pIn = pwfI; r.pOut = tr.ok ? tr.pEnd : null;
        } else {
            o.from = 'bottom'; o.p0 = pwfI;
            if (!(pwfI > PATM)) tr = { ok: false, lost: { reason: 'pressure' }, warnings: [] };
            else tr = V.traverse(C.F, C.W, q, o);
            r.pOut = top.thp; r.pIn = tr.ok ? tr.pEnd : null;
        }
        if (tr && tr.grid && !C.grids[gkey] && !C.gl) C.grids[gkey] = tr.grid;
        if (!C.trWarn && tr && tr.warnings) C.trWarn = tr.warnings;
        if (!tr.ok) { r.lost = tr.lost || { reason: tr.code || 'failed' }; r.delta = BIG; C.lostSeen[r.lost.reason] = q; }
        else r.delta = r.pOut - r.pIn;
        r.eroMax = tr.ok ? tr.eroMax : null; r.vmMax = tr.ok ? tr.vmMax : null;
        if (tr.ok && _fin(top.lineEro) && top.lineEro > r.eroMax) r.eroMax = top.lineEro;      // tubing or flowline, whichever is higher
        if (keep || fine) r.tr = tr;
        C.cache[key] = r;
        return r;
    }
    function _evalsE(C) { return C.counts.fine + 0.5 * C.counts.coarse; }

    // ── scan, roots, stability ────────────────────────────────────────────────
    function _scan(C, fracs) {
        var fr = (Array.isArray(fracs) && fracs.length >= 3) ? fracs.slice().sort(function (a, b) { return a - b; }) : SCAN_FRACS;
        var qs = fr.map(function (f) { return f * C.aof; });
        // the reference point first (≈ 49 % of AOF): it records the coarse frozen grid
        var ref = 0; qs.forEach(function (q, i) { if (Math.abs(fr[i] - SCAN_FRACS[REF_INDEX]) < Math.abs(fr[ref] - SCAN_FRACS[REF_INDEX])) ref = i; });
        var pts = new Array(qs.length);
        pts[ref] = _eval(C, qs[ref], false);
        for (var i = 0; i < qs.length; i++) if (i !== ref) pts[i] = _eval(C, qs[i], false);
        return pts;
    }
    // runs of consecutive valid scan points, each with a monotone cubic of the node outflow / inflow pressure
    function _runs(C, pts) {
        var runs = [], cur = null;
        pts.forEach(function (p, i) {
            if (p.lost || !_fin(p.delta) || p.delta >= BIG) { cur = null; return; }
            if (!cur) { cur = { i0: i, xs: [], yOut: [], yIn: [] }; runs.push(cur); }
            cur.xs.push(p.q); cur.yOut.push(p.pOut); cur.yIn.push(p.pIn); cur.i1 = i;
        });
        runs.forEach(function (r) {
            r.out = _pchip(r.xs, r.yOut);
            if (C.node === 'bottom') { r.pin = function (q) { return C.I.pwfAt(q); }; r.dpin = function (q) { var h = Math.max(1e-6 * C.aof, 1e-3 * q); return (C.I.pwfAt(q + h) - C.I.pwfAt(q - h)) / (2 * h); }; }
            else { var ip = _pchip(r.xs, r.yIn); r.pin = ip.f; r.dpin = ip.df; }
            r.D = function (q) { return r.out.f(q) - r.pin(q); };
            r.dD = function (q) { return r.out.df(q) - r.dpin(q); };
        });
        return runs;
    }
    function _bracketsFrom(C, pts, runs) {
        var out = [], tang = [];
        runs.forEach(function (r) {
            var a = r.xs[0], b = r.xs[r.xs.length - 1];
            if (r.xs.length === 1) return;
            var n = Math.max(40, Math.round(N_DENSE * (b - a) / C.aof)), prevQ = a, prevD = r.D(a), minD = { q: a, d: Math.abs(prevD), s: prevD };
            for (var k = 1; k <= n; k++) {
                var q = a + (b - a) * k / n, d = r.D(q);
                if ((d > 0) !== (prevD > 0)) {
                    var qe = prevQ + (q - prevQ) * prevD / (prevD - d);
                    out.push({ est: qe, lo: prevQ, hi: q, run: r, kind: 'interp' });
                }
                if (Math.abs(d) < minD.d) minD = { q: q, d: Math.abs(d), s: d };
                prevQ = q; prevD = d;
            }
            tang.push({ run: r, q: minD.q, d: minD.s });
        });
        // a valid point next to a lost one (cannot lift beyond): a sign change into "+∞"
        for (var i = 0; i < pts.length - 1; i++) {
            var p0 = pts[i], p1 = pts[i + 1];
            var l0 = p0.delta >= BIG, l1 = p1.delta >= BIG;
            if (l0 !== l1 && ((l0 ? p1.delta : p0.delta) < 0)) out.push({ est: l0 ? p1.q : p0.q, lo: p0.q, hi: p1.q, kind: 'lost', run: null });
        }
        // above the last scan point: Δ(AOF) = p_out(AOF) − p_AOF > 0
        var last = pts[pts.length - 1];
        if (!(last.delta >= BIG) && last.delta < 0) out.push({ est: last.q, lo: last.q, hi: C.aof * 0.99999, kind: 'end', run: runs[runs.length - 1] || null });
        return { brackets: out, tangencies: tang };
    }
    function _fineD(C) { return function (q) { var e = _eval(C, q, true); return e.delta; }; }
    function _refineRoot(C, br) {
        var f = _fineD(C), start = C.counts.fine, lo = br.lo, hi = br.hi;
        var q0 = Math.min(Math.max(br.est, lo), hi), f0 = f(q0);
        if (Math.abs(f0) < TOL_P) return { q: q0, fq: f0, conv: 'f', evals: C.counts.fine - start };
        var s = br.run ? br.run.dD(q0) : (_fin(br.slope) ? br.slope : NaN);
        if (!_fin(s) || s === 0) s = (br.run ? (br.run.D(hi) - br.run.D(lo)) / (hi - lo) : (f0 > 0 ? -1 : 1));
        var step = -f0 / s, wid = Math.max(hi - lo, 0.002 * q0);
        if (!_fin(step)) step = (f0 > 0 ? -1 : 1) * 0.01 * q0;
        var minStep = Math.max(2e-3 * q0, 1e-4 * C.aof);
        if (Math.abs(step) < minStep) step = step < 0 ? -minStep : minStep;
        step *= 1.2;                                       // overshoot so the bracket closes on the first try
        var qa = q0, fa = f0, qb = null, fb = null;
        var qMin = 1e-4 * C.aof, qMax = C.aof * 0.99999;
        for (var t = 0; t < 4; t++) {
            var q1 = Math.min(Math.max(q0 + step, qMin), qMax);
            if (q1 === qa) break;
            var f1 = f(q1);
            if ((f1 > 0) !== (fa > 0)) { qb = q1; fb = f1; break; }
            qa = q1; fa = f1; step *= 2;
            if (Math.abs(step) > 4 * wid + 0.1 * C.aof) break;
        }
        if (qb === null && br.noFallback) return null;
        if (qb === null) {
            // fall back to the scan bracket ends
            var fl = f(lo), fh = f(hi);
            if ((fl > 0) === (fh > 0)) return null;
            qa = lo; fa = fl; qb = hi; fb = fh;
        }
        if (Math.abs(fb) < TOL_P) return { q: qb, fq: fb, conv: 'f', evals: C.counts.fine - start };
        var sBr = (fa < BIG && fb < BIG && qb !== qa) ? Math.abs((fb - fa) / (qb - qa)) : 0;
        var left = Math.max(1, MAX_ROOT_EVALS - (C.counts.fine - start));
        var b = _brent(f, qa, qb, fa, fb, left);
        var res = { q: b.x, fq: b.fx, conv: b.conv, evals: C.counts.fine - start, other: b.other, fother: b.fother };
        if (b.conv === 'x' && Math.abs(b.fx) >= TOL_P && Math.abs(b.fother) >= TOL_P && (b.fx > 0) !== (b.fother > 0)) {
            var width = Math.abs(b.other - b.x) || TOL_Q * b.x, jump = b.fother - b.fx;
            // the expected local slope: the coarse interpolant, the slope hint, the secant of the bracket Brent started from
            var sc = Math.max(br.run ? Math.abs(br.run.dD(b.x)) : 0, _fin(br.slope) ? Math.abs(br.slope) : 0, sBr);
            var lost = (b.fx >= BIG || b.fother >= BIG);
            if (lost || (Math.abs(jump) > 0.5 && Math.abs(jump) > 10 * Math.max(sc, 1e-6) * width)) {
                res.discontinuity = { q: b.x, jump: lost ? null : Math.abs(jump), kind: lost ? 'lift-limit' : 'jump', dDdqCoarse: br.run ? br.run.dD(b.x) : null,
                    side: br.run ? (br.run.dD(b.x) > 0 ? 'stable' : 'unstable') : null };
            }
        }
        return res;
    }
    function _deriv(C, q) {
        var h = 0.01 * q, f = _fineD(C);
        var a = f(q - h), b = f(q + h);
        if (a >= BIG || b >= BIG) return null;
        return (b - a) / (2 * h);
    }
    function _qs(C, runs, opQ) {
        // last − → + zero of dΔ/dq below the operating point, on the coarse interpolant
        var cand = null;
        runs.forEach(function (r) {
            var a = r.xs[0], b = Math.min(r.xs[r.xs.length - 1], opQ);
            if (!(b > a)) return;
            var n = Math.max(40, Math.round(N_DENSE * (b - a) / C.aof)), prevQ = a, prevG = r.dD(a);
            for (var k = 1; k <= n; k++) {
                var q = a + (b - a) * k / n, g = r.dD(q);
                if (prevG < 0 && g >= 0) cand = { lo: prevQ, hi: q, est: prevQ + (q - prevQ) * (-prevG) / (g - prevG), run: r };
                prevQ = q; prevG = g;
            }
        });
        if (!cand) return null;
        // polish: one secant step on fine central differences (4 E)
        var q0 = cand.est, g0 = _deriv(C, q0), q1 = q0 * (g0 > 0 ? 0.97 : 1.03), g1 = (g0 == null) ? null : _deriv(C, q1);
        var q = q0;
        if (g0 != null && g1 != null && g1 !== g0) {
            q = q0 - g0 * (q1 - q0) / (g1 - g0);
            var lo = Math.min(cand.lo, q0, q1) * 0.9, hi = Math.max(cand.hi, q0, q1) * 1.1;
            if (!_fin(q) || q < lo || q > hi) q = (Math.abs(g0) < Math.abs(g1)) ? q0 : q1;
        }
        if (q >= opQ) q = Math.min(q0, opQ * 0.999);
        return { q: q, p: cand.run.out.f(Math.min(Math.max(q, cand.run.xs[0]), cand.run.xs[cand.run.xs.length - 1])) };
    }
    function _vlpMin(pts) {
        var v = pts.filter(function (p) { return !p.lost && _fin(p.pOut) && p.delta < BIG; });
        if (v.length < 3) return null;
        var k = 0;
        for (var i = 1; i < v.length; i++) if (v[i].pOut < v[k].pOut) k = i;
        if (k === 0 || k === v.length - 1) return null;
        var x0 = v[k - 1].q, x1 = v[k].q, x2 = v[k + 1].q, y0 = v[k - 1].pOut, y1 = v[k].pOut, y2 = v[k + 1].pOut;
        var den = (x0 - x1) * (x0 - x2) * (x1 - x2);
        var A = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / den, B = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / den;
        var Cc = y0 - A * x0 * x0 - B * x0;
        if (!(A > 0)) return { q: x1, p: y1 };
        var q = -B / (2 * A);
        if (q < x0 || q > x2) q = x1;
        return { q: q, p: A * q * q + B * q + Cc };
    }

    // ── results at the operating point ───────────────────────────────────────
    // gas gravity of the hydrate check and the choke isenthalp: the well-stream gravity for gas and condensate wells (as shut-in uses),
    // the separator gas gravity otherwise
    function _sgHyd(C) { if (C.gas && _fin(C.F.sgWell) && C.F.sgWell > 0) return C.F.sgWell; return C.F.sgg > 0 ? C.F.sgg : 0.65; }
    function _hydT(C, pA) { var h = G.WTS_hydrate_temp; if (typeof h !== 'function' || !(pA > 0)) return null; var t = h(pA, _sgHyd(C)); return _fin(t) ? t : null; }
    function _hasGas(C) { return C.gas || (C.type === 'oil' && (+C.F.gor > 0)); }
    function _atOp(C, R, opQ) {
        var e = _eval(C, opQ, true, true), V = G.WTS_wp_vlp;
        var tr = e.tr;
        // the reported traverse is always the wellhead → bottom march at the operating point (bottom node: e.tr already)
        if (C.node !== 'bottom' && e.top && !e.top.lost) {
            var o = { corr: C.corrWell, stepFt: C.stepFt, eroC: C.eroC, refine: C.refine, from: 'top', p0: e.top.thp, pMax: C.pMax };
            if (C.mult) o.mult = C.mult;
            var tpo = _tProf(C, opQ); if (tpo) o.tProfile = tpo.tAt;
            tr = C.gl ? _glTraverse(C, opQ, e.top.thp, 'down', true) : V.traverse(C.F, C.W, opQ, o); C.counts.fine++;
        }
        var pwf = C.I.pwfAt(opQ), thpA = e.top && !e.top.lost ? e.top.thp : null;
        if (tr && tr.ok) {
            var gas = _hasGas(C);
            tr.profile.forEach(function (row) { row.tHyd = gas ? _hydT(C, row.p) : null; });
            R.traverse = tr;
        }
        var ff = G.WTS_wp_fluid.flowlineFluid(C.F, opQ);
        R.rates = { q: opQ, qo: ff.qo, qw: ff.qw, qg: ff.qg_MMscfd * 1000, qL: ff.qo + ff.qw, basis: C.F.rateBasis };
        R.pwf = pwf;
        if (C.gl) {
            R.rates.qinj = C.gl.qinj; R.rates.qgTotal = R.rates.qg + C.gl.qinj;
            var lt = tr && tr.ok && tr.lift ? tr.lift : null, casProf = [];
            for (var cm = 0; cm <= C.gl.packerMd + 1e-6; cm += Math.max(100, C.gl.packerMd / 40)) casProf.push({ md: cm, tvd: C.W.tvdAt ? C.W.tvdAt(cm) : cm, p: _pCasAt(C, cm) });
            R.lift = { type: 'gaslift', qinj: C.gl.qinj, sginj: C.gl.sg, pinj_psig: C.gl.pinj, dpValve: C.gl.dpv, packerMd: C.gl.packerMd, packerTvd: C.gl.packerTvd,
                injMd: lt ? lt.injMd : null, injTvd: lt ? lt.injTvd : null, pTub: lt ? lt.pTub : null, pCas: lt ? lt.pCas : null, atPacker: lt ? !lt.balance : null, casing: casProf };
        }
        // breakdown: p̄r − pwf (skin split) + tubing (gravity / friction / acceleration / restrictions) + choke + flowline
        var bd = [], dpSkin = null;
        if (C.I.skin && typeof C.I.skin.dpSkin === 'function') { try { dpSkin = C.I.skin.dpSkin(opQ, pwf); } catch (x) { dpSkin = null; } }
        if (!_fin(dpSkin) || dpSkin < 0 || dpSkin > C.pr - pwf) dpSkin = null;
        bd.push({ key: BD.reservoir, dp: C.pr - pwf - (dpSkin || 0) });
        if (dpSkin) bd.push({ key: BD.completion, dp: dpSkin });
        if (R.traverse) {
            var el = 0, fr = 0, ac = 0;
            R.traverse.segments.forEach(function (s) { el += s.dpEl || 0; fr += s.dpF || 0; ac += s.dpAcc || 0; });
            // the marcher's segments sum to the tubing Δp exactly; the restriction losses are booked separately
            var tub = pwf - thpA, rs = R.traverse.restrictionsDp || 0, resid = tub - (el + fr + ac + rs);
            bd.push({ key: BD.gravity, dp: el + resid }, { key: BD.friction, dp: fr }, { key: BD.acceleration, dp: ac });
            if (rs) bd.push({ key: BD.restrictions, dp: rs });
        }
        if (e.top && !e.top.lost) {
            // (keys from BD: a literal route-like key string would tie this file to that page's help guide review hash)
            if (!C.maxBC && (C.choke.present)) bd.push({ key: BD.choke, dp: e.top.thp - e.top.p2 });
            else if (!C.maxBC && e.top.fixed) bd.push({ key: BD.wellhead, dp: e.top.thp - e.top.p2 });
            if (C.flowline.length) bd.push({ key: BD.flowline, dp: e.top.p2 - (C.psep + PATM) });
        }
        R.breakdown = bd;
        // surface
        var rxo = _tProf(C, opQ);
        var Wt = (typeof G.WTS_wp_well.temperature === 'function') ? G.WTS_wp_well.temperature(C.W, { F: C.F, fluidType: C.type, pwf: pwf, thp: thpA, q: rxo ? opQ : undefined, mode: rxo ? 'relax' : (C.W.heat && C.W.heat.mode === 'relax' ? 'linear' : undefined) }) : null;
        // the earth (static geotherm) temperature along the traverse, and the relaxation summary (A2, WP14)
        var geoAt = C.W.temp && typeof C.W.temp.geoAt === 'function' ? C.W.temp.geoAt : null;
        if (R.traverse && geoAt) R.traverse.profile.forEach(function (row) { var te = _fin(row.tvd) ? geoAt(row.tvd) : null; row.te = _fin(te) ? te : null; });
        R.heat = rxo ? { mode: 'relax', q: opQ, tht: rxo.tht, teTop: rxo.teTop, bht: rxo.bht, A: rxo.A, fTD: rxo.fTD, tD: rxo.tD, U: rxo.U_in, U_to: rxo.U_to, Ubasis: rxo.Ubasis,
            r_to: rxo.r_to, rwb: rxo.rwb, rwbSource: rxo.rwbSource, ke: rxo.ke, alpha: rxo.alpha, tProd_d: rxo.tProd_d, w: rxo.w, cp: rxo.cp, frac: rxo.frac,
            offsetTop: rxo.offsetTop, verified: false, provisional: rxo.provisional }
            : { mode: (Wt && Wt.mode) || 'linear', tht: Wt && Wt.ok ? Wt.tht : C.tht, fallback: !!(C.W.heat && C.W.heat.mode === 'relax') };
        if (C.relaxFail) C.warnings.forEach(function (w) { if (w.code === 'RELAX_FALLBACK' && !R.warnings.some(function (x) { return x.code === 'RELAX_FALLBACK'; })) R.warnings.push(w); });
        var tht = Wt && Wt.ok ? Wt.tht : C.tht, thtHyd = Wt && Wt.ok && _fin(Wt.thtHyd) ? Wt.thtHyd : tht;
        var gasy = _hasGas(C), p2 = e.top && e.top.p2;
        var tDnR = (gasy && _fin(p2) && _fin(thpA) && typeof G.WTS_flowline_isenthalp === 'function' && C.choke.present) ? G.WTS_flowline_isenthalp(_sgHyd(C), thpA, tht, p2) : null;
        var tDn = tDnR && _fin(tDnR.t) ? tDnR.t : tht;
        if (!_fin(tDn)) tDn = tht;
        var tHyd = gasy ? _hydT(C, thpA) : null, tHydDn = gasy ? _hydT(C, p2) : null;
        R.surface = { thp: thpA, thp_psig: _fin(thpA) ? thpA - PATM : null, tht: tht, thtHyd: thtHyd, thtVerdict: Wt && Wt.verdict, thtVerdictText: Wt && Wt.verdictText,
            muJT: Wt && Wt.muJT, tHyd: tHyd, hydMargin: (_fin(thtHyd) && _fin(tHyd)) ? thtHyd - tHyd : null,
            pChokeDn: _fin(p2) ? p2 : null, pChokeDn_psig: _fin(p2) ? p2 - PATM : null, tChokeDn: tDn, tHydDn: tHydDn,
            hydMarginDn: (_fin(tDn) && _fin(tHydDn)) ? tDn - tHydDn : null,
            choke: { present: C.choke.present, bean: C.choke.bean, corr: (C.gas && C.choke.corr !== 'sachdeva') ? 'gasNozzle' : C.choke.corr, regime: e.top ? e.top.regime : 'none',
                ratio: e.top ? e.top.ratio : null, yc: e.top ? e.top.yc : null, p1crit_psig: e.top ? e.top.p1crit : null, dp: (e.top && C.choke.present) ? e.top.thp - e.top.p2 : null,
                // A2 (WP15): the model behind the regime ('sachdeva' | 'sachdeva-scaled' | null), its rate factor, the inlet gas mass fraction,
                // the fixed-point iterations of y_c, the liquid Cv, the sub-critical rule and whether the Sachdeva state failed (A1 bound used)
                model: e.top && e.top.model ? e.top.model : null, rateFactor: e.top && _fin(e.top.rateFactor) ? e.top.rateFactor : null, x1: e.top && _fin(e.top.x1) ? e.top.x1 : null,
                ycIt: e.top && _fin(e.top.ycIt) ? e.top.ycIt : null, cv: e.top && _fin(e.top.cv) ? e.top.cv : null, subcritical: C.choke.sub, cd: C.choke.corr === 'sachdeva' ? C.choke.cdS : C.choke.cd,
                fallback: !!(e.top && e.top.fallback) },
            lineDp: e.top ? e.top.lineDp : null };
        if (Wt && Wt.warnings) Wt.warnings.forEach(function (w) { R.warnings.push(w); });
        // velocities and the erosional rate (interpolated on the scan)
        var eroQ = null;
        var sp = R.scan.filter(function (p) { return _fin(p.eroMax); });
        for (var i = 0; i < sp.length - 1; i++) if (sp[i].eroMax < 1 && sp[i + 1].eroMax >= 1) { eroQ = sp[i].q + (sp[i + 1].q - sp[i].q) * (1 - sp[i].eroMax) / (sp[i + 1].eroMax - sp[i].eroMax); break; }
        var vT = R.traverse ? R.traverse.vmMax : null, eT = R.traverse ? R.traverse.eroMax : null;
        var vL = e.top && !e.top.lost ? e.top.lineVm : null, eL = e.top && !e.top.lost ? e.top.lineEro : null;
        var lineWins = _fin(eL) && (!_fin(eT) || eL > eT);
        R.velocities = { vmMax: lineWins ? vL : vT, eroMax: lineWins ? eL : eT, eroC: C.eroC, qEro: eroQ, where: lineWins ? 'flowline' : 'tubing',
            tubing: { vmMax: vT, eroMax: eT }, flowline: C.flowline.length ? { vmMax: vL, eroMax: eL } : null };
        R.surface.tLine = e.top && !e.top.lost && _fin(e.top.tLine) ? e.top.tLine : (C.flowline.length ? tht : null);
        R.surface.sgHyd = _sgHyd(C);
    }

    function _flags(C, R) {
        var F = [];
        var ch = R.surface && R.surface.choke;
        if (ch && ch.regime === 'subcritical-bound') F.push(_w('SUBCRITICAL_BOUND', ch.fallback ? 'Sub-critical choke flow and the continuous sub-critical model has no inlet state at this rate: the rate shown is the conservative bound p1 ≥ p2 / 0.588 of the critical correlation.'
            : 'Sub-critical choke flow — the critical correlation does not apply; the rate shown is the conservative bound p1 ≥ p2 / 0.588 (the A1 rule chosen in the choke settings).'));
        if (ch && ch.model === 'sachdeva-scaled' && ch.regime === 'subcritical') F.push(_w('CHOKE_SUBCRITICAL', 'Sub-critical choke flow (p2/p1 ' + _f(ch.ratio, 3) + ' above the critical ratio ' + _f(ch.yc, 3) + '): the rate follows the ' + SACH_LABEL +
            ' sub-critical branch scaled to the ' + _corrName(ch.corr) + ' correlation at its critical point (rate factor ' + _f(ch.rateFactor, 3) + ') — ' + PROVISIONAL + '.', 'info'));
        if (ch && ch.model === 'sachdeva') F.push(_w('CHOKE_PROVISIONAL', 'Choke: the ' + SACH_LABEL + ' continuous two-phase model (Cd ' + _f(ch.cd, 2) + ', rate factor ' + _f(ch.rateFactor, 3) + ', ' + ch.regime + ', y_c ' + _f(ch.yc, 3) + ') — ' + PROVISIONAL + '.', 'info'));
        if (ch && ch.present && ch.model === 'sachdeva' && _fin(ch.bean) && (ch.bean < SACH_RANGE[0] || ch.bean > SACH_RANGE[1])) F.push(_w('CHOKE_RANGE', 'The bean ' + _f(ch.bean, 0) + '/64 in is outside the ' + SACH_LABEL + ' data range (' + SACH_RANGE[0] + '–' + SACH_RANGE[1] + '/64 in): extrapolation.', 'info'));
        if (ch && ch.present && C.gas && ch.corr !== 'sachdeva' && C.F && (+C.F.cgr > 0 || +C.F.wgr > 0)) F.push(_w('NOZZLE_GAS_ONLY', 'The gas choke nozzle carries the gas only; the condensate and water through the choke are not included (the ' + SACH_LABEL + ' choke model in the choke settings carries them).', 'info'));
        if (R.lift && R.lift.type === 'gaslift') {
            var lf = R.lift;
            F.push(_w('GL_POINT', 'Gas lift: ' + _f(lf.qinj, 0) + ' Mscf/d injected at ' + _f(lf.injMd, 0) + ' ft MD (' + _f(lf.injTvd, 0) + ' ft TVD), ' + (lf.atPacker ? 'at the packer' : 'the point of balance above the packer') +
                '; casing ' + _f(lf.pCas - PATM, 0) + ' psig against tubing ' + _f(lf.pTub - PATM, 0) + ' psig. Quick look: one injection point, no valve mechanics.', 'info'));
        }
        if (ch && ch.regime === 'liquid') F.push(_w('CHOKE_LIQUID', 'Liquid with no free gas: the choke is an incompressible orifice.', 'info'));
        R.discontinuities.forEach(function (d) {
            F.push(_w('DISCONTINUITY', d.kind === 'lift-limit' ? 'The outflow curve ends at about ' + _f(d.q, 0) + ' (the march cannot carry a higher rate): no root there.'
                : 'Discontinuity in the outflow curve at about ' + _f(d.q, 0) + ' (jump ' + _f(d.jump, 1) + ' psi, a correlation pattern switch): reported, not a root.'));
        });
        if (R.op && R.qs && R.op.q <= R.qs.q * (1 + HEADING_FRAC)) F.push(_w('HEADING', 'The operating point is within 10 % above the static stability limit q_s: the well may head or load up.'));
        if (R.op && R.vlpMin && R.op.q < R.vlpMin.q && R.op.stable) F.push(_w('LEFT_OF_MIN', 'The operating point lies left of the tubing-curve minimum (conventional, more conservative rule) while statically stable.', 'info'));
        (R.marginal || []).forEach(function (m) { F.push(_w('MARGINAL', 'The inflow and outflow curves nearly touch at about ' + _f(m.q, 0) + ' (Δ ' + _f(m.d, 1) + ' psi): a marginal flowing condition.')); });
        var s = R.surface || {};
        if (_fin(s.hydMarginDn) && s.hydMarginDn < 0) F.push(_w('HYDRATE_DN', 'Hydrate risk downstream of the choke: ' + _f(s.tChokeDn, 0) + ' °F against a hydrate temperature of ' + _f(s.tHydDn, 0) + ' °F.'));
        else if (_fin(s.hydMarginDn) && s.hydMarginDn < 10) F.push(_w('HYDRATE_DN_NEAR', 'Downstream of the choke the temperature is within 10 °F of hydrate formation (' + _f(s.tChokeDn, 0) + ' °F against ' + _f(s.tHydDn, 0) + ' °F).'));
        if (_fin(s.hydMargin) && s.hydMargin < 0) F.push(_w('HYDRATE_WH', 'Hydrate risk at the wellhead (THT for the check ' + _f(s.thtHyd, 0) + ' °F, hydrate ' + _f(s.tHyd, 0) + ' °F).'));
        var v = R.velocities || {};
        if (_fin(v.eroMax) && v.eroMax > 0.8) F.push(_w('EROSION', 'Mixture velocity reaches ' + _f(v.eroMax * 100, 0) + ' % of the API RP 14E erosional velocity (C = ' + _f(C.eroC, 0) + ') in the ' + (v.where === 'flowline' ? 'flowline' : 'tubing') + '.', v.eroMax > 1 ? 'warn' : 'info'));
        if (R.loading && _fin(R.loading.margin) && R.loading.margin < 0) F.push(_w('LOADING', 'The gas rate is below the critical (liquid-loading) rate.'));
        (C.trWarn || []).forEach(function (w) { if (w && w.code !== 'LOST' && w.code !== 'PROVISIONAL') F.push(_w(w.code, w.msg, w.sev)); });
        var E = (G.WTS_flowline_corr || {})[C.corrWell];
        if (E && E.verified !== true) F.push(_w('PROVISIONAL', (E.label || C.corrWell) + ': provisional — not verified against a published example.', 'info'));
        if (R.heat && R.heat.mode === 'relax') F.push(_w('PROVISIONAL_TEMP', 'Flowing temperature (heat-transfer relaxation, Ramey / Hasan-Kabir): ' + PROVISIONAL + '.', 'info'));
        if (C.nodeAsked === 'separator') F.push(_w('NODE_SEPARATOR', 'The separator node is solved at the wellhead node in this release (same operating point).', 'info'));
        R.flags = F;
    }

    // ── tracking solve (warm Jobs: design, bean schedule, sensitivity): the stable root continued from a neighbouring setting ──
    // No scan: a fine evaluation at the previous rate, a Newton step on the previous slope, Brent; the slope at the root from the
    // final bracket (or central differences). q_s and the tubing-curve minimum are not computed (R.tracked = true). Returns null
    // (→ the full solve) when no bracket is found or the root is not statically stable.
    function _track(C, M, o) {
        var q0 = Math.min(Math.max(+o.track.q, 1e-3 * C.aof), 0.999 * C.aof);
        var sl = _fin(+o.track.slope) && +o.track.slope > 0 ? +o.track.slope : NaN;
        var r = _refineRoot(C, { est: q0, lo: q0 * 0.9, hi: Math.min(q0 * 1.1, 0.99999 * C.aof), run: null, slope: sl, noFallback: true });
        if (!r || r.discontinuity || !(r.q > 0)) return null;
        var d = null, w = _fin(r.other) ? Math.abs(r.other - r.q) : 0;
        if (w >= 1e-4 * r.q && w <= 0.05 * r.q && r.fother < BIG && r.fq < BIG) d = (r.fother - r.fq) / (r.other - r.q);
        else d = _deriv(C, r.q);
        if (!_fin(d) || d <= 0) return null;
        var R = { ok: false, tracked: true, node: C.node, nodeAsked: C.nodeAsked, mode: C.mode, corr: { well: C.corrWell, line: C.corrLine },
            roots: [{ q: r.q, p: C.node === 'bottom' ? C.I.pwfAt(r.q) : _eval(C, r.q, true).pOut, dDdq: d, stable: true, conv: r.conv, evals: r.evals }],
            op: null, qs: null, vlpMin: null, pwf: null, traverse: null, breakdown: [], surface: {}, rates: {}, velocities: {}, flags: [], discontinuities: [], marginal: [],
            loading: null, warnings: C.warnings.slice(), errors: [], aof: C.aof, pr: C.pr, choke: { present: C.choke.present }, scan: [], curves: { ipr: [], vlp: [] } };
        R.op = { q: r.q, p: R.roots[0].p, stable: true, dDdq: d };
        // a live drag carries the curves, q_s and the tubing-curve minimum of the last full solve until the release (R.carried)
        if (o.track.curves) { R.curves = { ipr: C.node === 'bottom' ? [] : (o.track.curves.ipr || []), vlp: o.track.curves.vlp || [] }; R.qs = o.track.qs || null; R.vlpMin = o.track.vlpMin || null; R.carried = true; }
        _atOp(C, R, r.q);
        if (C.gas) { var L = loading(R, C.F, C.W, { rathole: _get(M, ['system', 'loadingRathole'], false) === true }); R.loading = L && L.ok ? L : null; }
        R.ok = !!R.traverse;
        if (!R.ok) return null;
        _flags(C, R);
        R.counts = { fine: C.counts.fine, coarse: C.counts.coarse, line: C.counts.line };
        R.evals = _evalsE(C);
        R.grid = { dir: C.node, coarse: C.grids.coarse, fine: C.grids.fine, line: C.grids.line };
        R.I = { aof: C.aof, pr: C.pr, kind: C.I.kind, key: C.I.key };
        return R;
    }

    // ── solve ─────────────────────────────────────────────────────────────────
    function solve(M, o) {
        o = o || {};
        var cx = _ctx(M, o);
        if (cx.fail) return cx.fail;
        var C = cx.C;
        if (o.track && _fin(+o.track.q) && +o.track.q > 0 && !o.coarseOnly) {
            var Rt = _track(C, M, o);
            if (Rt) return Rt;
            cx = _ctx(M, Object.assign({}, o, { warm: null }));       // fall back to the full solve on a fresh context
            C = cx.C;
        }
        var R = { ok: false, node: C.node, nodeAsked: C.nodeAsked, mode: C.mode, corr: { well: C.corrWell, line: C.corrLine }, roots: [], op: null, qs: null,
            vlpMin: null, pwf: null, traverse: null, breakdown: [], surface: {}, rates: {}, velocities: {}, flags: [], discontinuities: [], marginal: [],
            loading: null, warnings: C.warnings.slice(), errors: [], aof: C.aof, pr: C.pr, choke: { present: C.choke.present } };
        var pts = _scan(C, o.scanFracs);
        R.scan = pts.map(function (p) { return { q: p.q, pOut: p.pOut, pIn: p.pIn, lost: p.lost ? p.lost.reason : null, eroMax: p.eroMax }; });
        var runs = _runs(C, pts);
        var bt = _bracketsFrom(C, pts, runs);
        var roots = [];
        if (o.coarseOnly) {
            bt.brackets.forEach(function (b) { if (b.kind === 'interp') roots.push({ q: b.est, p: b.run.pin(b.est), dDdq: b.run.dD(b.est), stable: b.run.dD(b.est) > 0, coarse: true }); });
        } else {
            bt.brackets.forEach(function (b) {
                var r = _refineRoot(C, b);
                if (!r) return;
                if (r.discontinuity) { R.discontinuities.push(r.discontinuity); return; }
                if (roots.some(function (x) { return Math.abs(x.q - r.q) < 1e-3 * Math.max(1, r.q); })) return;
                var d = _deriv(C, r.q);
                if (d == null && b.run) d = b.run.dD(r.q);
                var pNode = C.node === 'bottom' ? C.I.pwfAt(r.q) : _eval(C, r.q, true).pOut;
                roots.push({ q: r.q, p: pNode, dDdq: _fin(d) ? d : 0, stable: _fin(d) ? d > 0 : false, conv: r.conv, evals: r.evals });
            });
        }
        roots.sort(function (a, b) { return a.q - b.q; });
        R.roots = roots;
        // marginal: Δ minimum near zero with no sign change in that run
        bt.tangencies.forEach(function (t) {
            var near = Math.max(5, 0.002 * C.pr);
            if (t.d > 0 && t.d < near && !bt.brackets.some(function (b) { return Math.abs(b.est - t.q) < 0.05 * C.aof; })) R.marginal.push({ q: t.q, d: t.d });
        });
        var stable = roots.filter(function (r) { return r.stable; });
        if (stable.length) { var s = stable[stable.length - 1]; R.op = { q: s.q, p: s.p, stable: true, dDdq: s.dDdq }; }
        R.vlpMin = C.node === 'bottom' ? _vlpMin(pts) : null;
        if (R.op && !o.coarseOnly) R.qs = _qs(C, runs, R.op.q);
        else if (R.op) { var cq = null; runs.forEach(function (r) { var a = r.xs[0], b = Math.min(r.xs[r.xs.length - 1], R.op.q), n = 80, pg = r.dD(a), pq = a; for (var k = 1; k <= n; k++) { var q = a + (b - a) * k / n, g = r.dD(q); if (pg < 0 && g >= 0) cq = { q: pq, p: r.out.f(pq) }; pg = g; pq = q; } }); R.qs = cq; }
        if (R.qs && R.vlpMin && R.qs.q > R.vlpMin.q) R.qs.q = Math.min(R.qs.q, R.vlpMin.q);   // q_s lies left of the tubing-curve minimum (dp_out/dq = −1/J < 0)
        // curves for the plot (the coarse interpolant, the IPR)
        var cur = { ipr: [], vlp: [] };
        if (C.node === 'bottom') { for (var k = 0; k <= 40; k++) { var qk = C.aof * k / 40; cur.ipr.push({ q: qk, p: C.I.pwfAt(qk) }); } }
        runs.forEach(function (r) {
            var a = r.xs[0], b = r.xs[r.xs.length - 1], n = r.xs.length > 1 ? 40 : 0;
            for (var j = 0; j <= n; j++) { var q = a + (b - a) * j / (n || 1); cur.vlp.push({ q: q, p: r.out.f(q) }); if (C.node !== 'bottom') cur.ipr.push({ q: q, p: r.pin(q) }); }
            if (!n) cur.vlp.push({ q: a, p: r.yOut[0] });
        });
        R.curves = cur;
        if (R.op && !o.coarseOnly) {
            _atOp(C, R, R.op.q);
            if (C.gas) { var L = loading(R, C.F, C.W, { rathole: _get(M, ['system', 'loadingRathole'], false) === true }); R.loading = L && L.ok ? L : null; }
            R.ok = !!(R.traverse);
            if (!R.ok) R.errors.push('the traverse at the operating point failed');
        } else if (R.op) {
            R.ok = true;
            var ffc = G.WTS_wp_fluid.flowlineFluid(C.F, R.op.q);
            R.rates = { q: R.op.q, qo: ffc.qo, qw: ffc.qw, qg: ffc.qg_MMscfd * 1000, qL: ffc.qo + ffc.qw, basis: C.F.rateBasis }; R.pwf = C.I.pwfAt(R.op.q);
        } else {
            if (roots.length) { R.code = 'UNSTABLE_ONLY'; R.errors.push('Only statically unstable intersections: the well does not flow steadily at these settings.'); }
            else if (R.discontinuities.length) { R.code = 'DISCONTINUITY'; R.errors.push('The outflow curve jumps across the inflow curve (a correlation discontinuity): no operating point.'); }
            else if (pts.every(function (p) { return p.delta >= BIG; })) { R.code = 'CANNOT_LIFT'; R.errors.push('The well cannot lift at any rate with this outflow (every march was lost: ' + Object.keys(C.lostSeen).join(', ') + ').'); }
            else { R.code = 'NO_FLOW'; R.errors.push('The outflow curve lies above the inflow curve: the well does not flow at these settings.'); }
            R.warnings.push(_w('NO_OP', R.errors[0]));
        }
        // 'pressure' mode: the node pressures at the target rate
        var tq = _n(_get(M, ['system', 'target', 'q']));
        if (C.mode === 'pressure' && tq > 0 && tq < C.aof && !o.coarseOnly) {
            var et = _eval(C, tq, true, true);
            R.atTarget = { q: tq, pwfVlp: C.node === 'bottom' ? et.pOut : null, pwfIpr: C.I.pwfAt(tq), thp_psig: et.top && !et.top.lost ? et.top.thp - PATM : null,
                flows: _fin(et.delta) ? et.delta <= 0 : false, lost: !!et.lost };
        }
        _flags(C, R);
        R.counts = { fine: C.counts.fine, coarse: C.counts.coarse, line: C.counts.line };
        R.evals = _evalsE(C);
        R.grid = { dir: C.node, coarse: C.grids.coarse, fine: C.grids.fine, line: C.grids.line };
        R.I = { aof: C.aof, pr: C.pr, kind: C.I.kind, key: C.I.key };
        return R;
    }

    // ── liquid loading ────────────────────────────────────────────────────────
    // o.rathole true: the verdict is the maximum over EVERY node including the section below the end of tubing (the strict reading of
    // §4.11). Default: the verdict is the tubing (wellhead → tubing shoe) critical rate; the casing / liner section between the shoe and
    // the mid-perforations is reported separately (out.belowEot) as an information line (decision recorded in the plan §4.11 and help).
    function loading(R, F, W, o) {
        o = o || {};
        var out = { ok: true, applicable: false, method: null, suggested: null, qc_MMscfd: null, limitingMd: null, limitingTvd: null, margin: null, verdict: 'none',
            methods: {}, perDepth: [], warnings: [], errors: [] };
        if (!F || !F.ok || !_isGas(F.type)) { out.note = 'Liquid loading applies to gas and condensate wells.'; return out; }
        var tr = R && R.traverse;
        if (!tr || !Array.isArray(tr.profile) || !tr.profile.length) return { ok: false, code: 'NO_TRAVERSE', errors: ['loading needs the traverse at the operating point'], warnings: [], perDepth: [] };
        var segs = tr.segments || [];
        // the conduit at a node: the segment ABOVE the node (the flow arrives from below and leaves upwards through it), so the tubing shoe
        // node carries the tubing ID, not the casing below it; the top node takes the first segment
        var areaAt = function (md) {
            var best = null, i, s;
            for (i = 0; i < segs.length; i++) { s = segs[i]; if (md > s.mdTop + 1e-6 && md <= s.mdBot + 1e-6) { best = s; break; } }
            if (!best) for (i = 0; i < segs.length; i++) { s = segs[i]; if (md >= s.mdTop - 1e-6 && md <= s.mdBot + 1e-6) { if (!best || s.id < best.id) best = s; } }
            if (!best) best = segs[0] || { id: 2.441 };
            return { id: best.id, A: Math.PI * best.id * best.id / 4 / 144 };
        };
        var shoe = (W && W.nodes && _fin(W.nodes.tubingShoeMd) && (!W.path || W.path === 'tubing')) ? +W.nodes.tubingShoeMd : null;
        var isBelow = function (md) { return shoe != null && md > shoe + 1e-6; };
        var water = (+F.wgr > 0) || (+F.wc > 0);
        var qOp = R.rates && _fin(R.rates.qg) ? R.rates.qg / 1000 : null;
        var best = {}, below = {}, keys = Object.keys(LOAD);
        keys.forEach(function (k) { best[k] = { qc: -1, md: null, tvd: null }; below[k] = { qc: -1, md: null, tvd: null, id: null }; });
        tr.profile.forEach(function (row, idx) {
            if (row.restr) return;
            var pr = F.at(row.p, row.t);
            if (!pr) return;
            var rhoL = water ? pr.rhoW : pr.rhoO, sig = water ? pr.sigW : pr.sigO, rhoG = pr.rhoG, z = pr.z;
            if (!(rhoL > rhoG && rhoG > 0 && sig > 0 && z > 0)) return;
            var a = areaAt(row.md), base = Math.pow(sig, 0.25) * Math.pow(rhoL - rhoG, 0.25) / Math.sqrt(rhoG);
            var qcOf = function (coef) { return 3.067 * row.p * coef * base * a.A / ((row.t + 460) * z); };
            var bl = isBelow(row.md);
            keys.forEach(function (k) {
                var qc = qcOf(LOAD[k].coef);
                if (bl) { if (qc > below[k].qc) below[k] = { qc: qc, md: row.md, tvd: row.tvd, id: a.id }; if (!o.rathole) return; }
                if (qc > best[k].qc) best[k] = { qc: qc, md: row.md, tvd: row.tvd };
            });
            if (idx % 2 === 0 || idx === tr.profile.length - 1 || bl || (shoe != null && Math.abs(row.md - shoe) < 1e-6)) out.perDepth.push({ md: row.md, tvd: row.tvd, id: a.id, vg: row.vsg, vc: LOAD.turner.coef * base, vcColeman: LOAD.coleman.coef * base, vcLi: LOAD.li.coef * base,
                qc: qcOf(LOAD.turner.coef), qcColeman: qcOf(LOAD.coleman.coef), qcLi: qcOf(LOAD.li.coef), belowEot: bl });
        });
        keys.forEach(function (k) {
            var b = best[k];
            out.methods[k] = { key: k, label: LOAD[k].label, coef: LOAD[k].coef, qc_MMscfd: b.qc > 0 ? b.qc : null, limitingMd: b.md, limitingTvd: b.tvd,
                margin: (qOp != null && b.qc > 0) ? qOp / b.qc - 1 : null };
        });
        var whp = R.surface && _fin(R.surface.thp) ? R.surface.thp : (tr.pTop || null);
        var sug = !_fin(whp) ? 'turner' : (whp < 500 ? 'coleman' : 'turner');
        out.applicable = true;
        out.suggested = sug; out.method = sug; out.both = _fin(whp) && whp >= 500 && whp <= 1000;
        out.whp = whp;
        var m = out.methods[sug];
        out.qc_MMscfd = m.qc_MMscfd; out.limitingMd = m.limitingMd; out.limitingTvd = m.limitingTvd; out.margin = m.margin;
        out.basis = o.rathole ? 'all' : (shoe != null ? 'tubing' : 'all'); out.tubingShoeMd = shoe;
        var bs = below[sug];
        if (shoe != null && bs.qc > 0) {
            out.belowEot = { fromMd: shoe, toMd: bs.md, id: bs.id, qc_MMscfd: bs.qc, margin: qOp != null ? qOp / bs.qc - 1 : null, inVerdict: !!o.rathole,
                methods: {} };
            keys.forEach(function (k) { if (below[k].qc > 0) out.belowEot.methods[k] = { qc_MMscfd: below[k].qc, margin: qOp != null ? qOp / below[k].qc - 1 : null }; });
            if (out.belowEot.margin != null && out.belowEot.margin < 0)
                out.belowEot.note = 'Liquid may accumulate below the end of tubing: q_c in the ' + _f(bs.id, 3) + ' in casing / liner below ' + _f(shoe, 0) + ' ft MD is ' + _f(bs.qc, 2) + ' MMscf/d' + (o.rathole ? ' (included in the verdict).' : ' (information; the verdict is the tubing critical rate).');
        }
        out.verdict = m.margin == null ? 'none' : (m.margin < 0 ? 'fail' : m.margin < 0.1 ? 'warn' : 'ok');
        // D17 / §15.1: the critical-rate methods have no verified published example yet (Q9) → provisional
        out.verified = false; out.provisional = PROVISIONAL;
        out.methodText = sug === 'coleman' ? 'Coleman et al. suggested: flowing wellhead pressure below 500 psia (the range of its data).'
            : (out.both ? 'Wellhead pressure between 500 and 1,000 psia: Turner et al. and Coleman et al. are both shown.' : 'Turner et al. suggested: flowing wellhead pressure above 1,000 psia (the range of its data).');
        if (m.margin != null && m.margin < 0.1) out.recommendations = ['a smaller tubing string that keeps the gas velocity above the critical velocity', 'a foamer (surfactant) treatment', 'artificial lift (plunger or gas lift)'];
        return out;
    }

    // ── checks ────────────────────────────────────────────────────────────────
    function check(M) {
        var items = [], validity = [];
        var add = function (code, sev, field, msg) { items.push({ code: code, sev: sev, field: field || null, msg: String(msg).slice(0, 299) }); };
        if (!M || !M.fluid) return { ok: false, errors: ['the model is incomplete'], warnings: [], items: [], validity: [] };
        var fl = M.fluid, res = M.res || {}, well = M.well || {}, sys = M.system || {}, sf = M.surface || {};
        var gas = _isGas(fl.type);
        // survey
        var sv = Array.isArray(well.survey) ? well.survey : [];
        if (!sv.length) add('SURVEY_MISSING', 'error', 'wp_survey', 'A survey (at least the TD row) is needed.');
        var three = sv.some(function (r) { return r && r.length >= 3; });
        for (var i = 0; i < sv.length; i++) {
            var r = sv[i] || [];
            if (i && !(+r[0] > +sv[i - 1][0])) { add('SURVEY_MD', 'error', 'wp_survey', 'Survey MD must increase strictly (row ' + (i + 1) + ').'); break; }
            if (!three && +r[1] > +r[0] + 1e-6) { add('SURVEY_TVD', 'error', 'wp_survey', 'TVD cannot exceed MD (row ' + (i + 1) + ').'); break; }
            if (three && !(+r[1] >= 0 && +r[1] <= 180)) { add('SURVEY_INC', 'error', 'wp_survey', 'Inclination must be 0–180° (row ' + (i + 1) + ').'); break; }
        }
        var td = sv.length ? +sv[sv.length - 1][0] : null;
        var mid = _n(well.midPerfMd);
        if (!_fin(mid)) add('MIDPERF', 'error', 'wp_midPerf', 'The mid-perforation depth is needed.');
        else if (_fin(td) && mid > td + 1e-6) add('MIDPERF_TD', 'error', 'wp_midPerf', 'The mid-perforation MD ' + _f(mid, 0) + ' ft is below the survey TD ' + _f(td, 0) + ' ft.');
        // strings
        var strs = Array.isArray(well.strings) ? well.strings : [];
        if (!strs.length) add('STRINGS', 'error', 'wp_strings', 'At least one tubing string is needed.');
        var cas = strs.filter(function (s) { return s && s.kind !== 'tubing'; }), tub = strs.filter(function (s) { return s && s.kind === 'tubing'; });
        tub.forEach(function (t) {
            if (+t.id >= +t.od) add('STRING_ID', 'error', 'wp_strings', 'Tubing ID must be below its OD.');
            cas.forEach(function (c) { if (+t.od > +c.id + 1e-6 && +t.topMd < +c.botMd && +t.botMd > +c.topMd) add('STRING_FIT', 'warn', 'wp_strings', 'Tubing OD ' + _f(+t.od, 3) + ' in does not fit inside the casing ID ' + _f(+c.id, 3) + ' in where they overlap.'); });
        });
        (Array.isArray(well.restrictions) ? well.restrictions : []).forEach(function (rr) {
            var md = +rr.md, host = strs.filter(function (s) { return md >= +s.topMd && md <= +s.botMd; })[0];
            if (!host) add('RESTR_OUT', 'warn', 'wp_restr', 'A restriction at MD ' + _f(md, 0) + ' ft is outside every string.');
            else if (+rr.id >= +host.id) add('RESTR_ID', 'warn', 'wp_restr', 'A restriction at MD ' + _f(md, 0) + ' ft is not smaller than its string ID.');
        });
        // fluid
        var wc = _n(fl.wc);
        if (wc != null && !(wc >= 0 && wc <= 1)) add('WC_RANGE', 'error', 'wp_wc', 'Water cut must be 0–100 %.');
        var pr = _n(res.pr);
        if (pr == null) add('PR_MISSING', 'error', 'wp_pr', 'p̄r needed: the average reservoir pressure is never defaulted.');
        // saturated reservoir
        var F = _fn('WTS_wp_fluid.build') ? G.WTS_wp_fluid.build(fl, { T_F: res.T_F }) : null, pb = null;
        if (F && F.ok && fl.type === 'oil') {
            pb = _n(res.pb); if (pb == null && typeof F.pb === 'function' && _fin(+res.T_F)) pb = F.pb(+res.T_F);
            if (_fin(pr) && _fin(pb) && pr < pb) add('SATURATED', res.model === 'pi' ? 'warn' : 'info', 'wp_ipr', 'p̄r ' + _f(pr, 0) + ' psia is below the bubble point ' + _f(pb, 0) + ' psia (saturated reservoir)' + (res.model === 'pi' ? ': a straight-line PI over-states the rate — Vogel or composite inflow is recommended.' : '.'));
            if (_fin(pb)) {
                if (_fin(_n(fl.pbUser)) && _fin(F.rsb) && +fl.gor < F.rsb - 1e-6 && _fin(pr) && pr < pb) add('GOR_LT_RSB', 'warn', 'wp_gor', 'The producing GOR is below Rsb at the user bubble point for a saturated reservoir.');
                else if (!_fin(_n(fl.pbUser))) add('GOR_LT_RSB_NA', 'info', 'wp_gor', 'GOR ≥ Rsb check: not applicable (the bubble point follows the producing GOR; enter a lab bubble point to check it).');
            }
        }
        if (F && !F.ok) (F.errors || []).forEach(function (e) { add('FLUID', 'error', 'wp_ftype', e); });
        // pressures
        var thp = _n(sys.thp_psig);
        if (_fin(pr) && _fin(thp) && !(sf.choke && sf.choke.present) && thp + PATM >= pr) add('THP_GE_PR', 'error', 'wp_thp', 'The wellhead pressure must be below p̄r.');
        if (_fin(pr) && _fin(_n(sf.psep_psig)) && +sf.psep_psig + PATM >= pr) add('PSEP_GE_PR', 'error', 'wp_psep', 'The separator pressure must be below p̄r.');
        (Array.isArray(M.tests) ? M.tests : []).forEach(function (t) {
            if (_fin(pr) && _fin(+t.gauge_psia) && +t.gauge_psia >= pr) add('TEST_PWF_GE_PR', 'warn', 'wp_tests', 'Test ' + (t.id || '') + ': the gauge pressure is not below p̄r.');
        });
        var I = null;
        if (F && F.ok && _fin(pr) && _fn('WTS_wp_ipr.curve')) { I = G.WTS_wp_ipr.curve(res, F); if (I && !I.ok) (I.errors || []).forEach(function (e) { add('IPR', 'error', 'wp_ipr', e); }); }
        if (I && I.ok && _fin(I.aof)) (M.tests || []).forEach(function (t) {
            var q = gas ? +t.q_g : (+t.q_o || 0) + (+t.q_w || 0);
            if (q > I.aof) add('TEST_GT_AOF', 'warn', 'wp_tests', 'Test ' + (t.id || '') + ': the rate is above the AOF of the inflow model.');
        });
        // correlation validity (Appendix A), each correlation actually used
        if (F && F.ok) (F.validity || []).forEach(function (v) { if (v && v.used !== false) validity.push({ corr: v.corr, label: v.label || v.corr, inRange: v.inRange !== false, msg: String(v.msg || v.label || v.corr).replace(/^[✓⚠✗]\s*/, ''), provisional: false }); });
        var REG = G.WTS_flowline_corr || {}, V = G.WTS_wp_vlp;
        var ck = (sys.corr && sys.corr.well) || (V && V.defaultCorr && F && F.ok ? V.defaultCorr(F).key : 'bb');
        var E = REG[ck];
        if (E && !gas && _gasOnly(E)) {
            add('CORR_NOT_APPLICABLE', 'error', 'wp_corr_well', (E.label || ck) + ' ignores the oil and water columns: not applicable to a ' + (fl.type || 'oil') + ' well.');
            validity.push({ corr: ck, label: E.label || ck, inRange: false, provisional: E.verified !== true, msg: (E.label || ck) + ': not applicable — a dry-gas method for gas wells only.' });
            E = null;
        }
        if (E) {
            var dMax = 0; strs.forEach(function (s) { if (s.kind === 'tubing' && +s.id > dMax) dMax = +s.id; });
            var Rg = E.range || {}, outs = [];
            if (Rg.dMaxIn && dMax > Rg.dMaxIn) outs.push('tubing ID ' + _f(dMax, 3) + ' in above ' + Rg.dMaxIn + ' in');
            if (Rg.cgrMax != null && +fl.cgr > Rg.cgrMax) outs.push('condensate ratio above ' + Rg.cgrMax + ' bbl/MMscf');
            if (Rg.wgrMax != null && +fl.wgr > Rg.wgrMax) outs.push('water ratio above ' + Rg.wgrMax + ' bbl/MMscf');
            var incMax = 0; if (three) sv.forEach(function (r2) { if (+r2[1] > incMax && +r2[1] <= 180) incMax = +r2[1]; });
            if (E.vertical && incMax > 30) outs.push('a vertical-well correlation in a well reaching ' + _f(incMax, 0) + '° (Beggs & Brill suggested)');
            validity.push({ corr: ck, label: E.label || ck, inRange: !outs.length, provisional: E.verified !== true,
                msg: (E.label || ck) + (outs.length ? ': outside the data range — ' + outs.join('; ') + ' (extrapolation).' : ': inside the published data range.') });
        }
        var lk = (sys.corr && sys.corr.line) || 'bb', EL = REG[lk];
        if (EL && (sf.flowline || []).length) validity.push({ corr: lk, label: (EL.label || lk) + ' (flowline)', inRange: true, provisional: EL.verified !== true,
            msg: (EL.label || lk) + ' (flowline): any inclination; data from 1–1.5 in test pipe, commonly used beyond.' });
        // gas lift (A2, WP18): oil / water producers only; the surface injection pressure is needed once a rate is injected
        var lfc = M.lift || {}, glc = lfc.gl || {};
        if (lfc.type === 'gaslift') {
            if (gas) add('GL_NOT_APPLICABLE', 'error', 'wp_lift', 'Gas lift is a quick look for oil wells; choose natural flow for a ' + fl.type + ' well.');
            else if (_n(glc.qinj_Mscfd) > 0 && !(_n(glc.pinj_psig) > 0)) add('GL_PINJ', 'error', 'wp_gl_pinj', 'Gas lift: enter the surface injection (casing) pressure.');
            if (_n(glc.packerMd) > 0 && _n(well.midPerfMd) > 0 && _n(glc.packerMd) > _n(well.midPerfMd)) add('GL_PACKER', 'warn', 'wp_gl_packer', 'Gas lift: the packer is below the mid-perforations; the injection point is limited to the end of the tubing.');
        }
        // the surface choke (A2, WP15): the Sachdeva et al. (1986) model — the whole choke ('sachdeva') or the sub-critical branch of a
        // critical correlation (the default) — is provisional (D17) and its data range is bean 8–40/64 in (Appendix A)
        var chk = sf.choke || {};
        if (chk.present && !(sys.mode === 'max')) {
            var bean = _n(chk.bean64), sachUsed = chk.corr === 'sachdeva' || (!gas && chk.subcritical !== 'bound');
            if (sachUsed) {
                var inR = !(_fin(bean) && (bean < SACH_RANGE[0] || bean > SACH_RANGE[1]));
                validity.push({ corr: 'sachdeva', label: SACH_LABEL + ' choke', inRange: inR, provisional: true,
                    msg: SACH_LABEL + (chk.corr === 'sachdeva' ? ' choke model' : ' sub-critical choke branch') + (inR ? ': inside the published data range (bean 8–40/64 in).' : ': outside the data range — bean ' + _f(bean, 0) + '/64 in, data 8–40/64 in (extrapolation).') });
            }
        }
        var errors = items.filter(function (x) { return x.sev === 'error'; }).map(function (x) { return x.msg; });
        // warnings = the ⚠ items the page lists; the information notes (e.g. "not applicable") stay in items / infos
        var warnings = items.filter(function (x) { return x.sev === 'warn'; }).map(function (x) { return _w(x.code, x.msg, 'warn', x.field); });
        var infos = items.filter(function (x) { return x.sev === 'info'; }).map(function (x) { return _w(x.code, x.msg, 'info', x.field); });
        return { ok: errors.length === 0, errors: errors, warnings: warnings, infos: infos, items: items, validity: validity };
    }

    // ── shut-in ───────────────────────────────────────────────────────────────
    function _zAvg(sg, p, t, imp) {
        if (typeof G.WTS_gaspvt_z === 'function') {
            var r = G.WTS_gaspvt_z({ sg: Math.min(Math.max(sg, 0.55), 3), p: Math.max(p, 15), t: t, co2: imp ? imp.co2 : 0, h2s: imp ? imp.h2s : 0, n2: imp ? imp.n2 : 0 });
            if (r && r.ok && r.z > 0) return r.z;
        }
        return 0.9;
    }
    function shutIn(M, o) {
        o = o || {};
        if (!M || !M.res || !M.well || !M.fluid) return { ok: false, code: 'NO_MODEL', errors: ['the model is incomplete'], warnings: [] };
        var pr = _n(M.res.pr);
        if (!_fin(pr)) return { ok: false, code: 'NEEDS_PR', errors: ['p̄r needed for the shut-in pressures'], warnings: [] };
        if (!_fn('WTS_wp_fluid.build') || !_fn('WTS_wp_well.build') || typeof G.WTS_gradient_compute !== 'function') return { ok: false, code: 'MISSING_ENGINE', errors: ['the shut-in engines are not loaded'], warnings: [] };
        var F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
        if (!F || !F.ok) return { ok: false, code: 'NEEDS_FLUID', errors: (F && F.errors) || ['the fluid is incomplete'], warnings: [] };
        var W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: F.type });
        if (!W || !W.ok) return { ok: false, code: 'NEEDS_WELL', errors: (W && W.errors) || ['the well is incomplete'], warnings: [] };
        var tvd = W.nodes.midPerfTvd, mid = W.nodes.midPerfMd, notes = [];
        var tBot = _fin(+M.res.T_F) ? +M.res.T_F : (W.bht || 200);
        var tTop = (W.geo && _fin(_n(W.geo.surfT_F))) ? +W.geo.surfT_F : (_fin(_n(_get(M, ['well', 'geo', 'surfT_F']))) ? +M.well.geo.surfT_F : 60);
        if (W.temp && typeof W.temp.geoAt === 'function') { var gt = W.temp.geoAt(0); if (_fin(gt)) tTop = gt; }
        var tAvg = 0.5 * (tTop + tBot);
        var gasT = _isGas(F.type);
        var sgCol = gasT ? (_fin(F.sgWell) ? F.sgWell : F.sgg) : (F.sgg > 0 ? F.sgg : 0.65);
        var imp = F.pvt && F.pvt.imp ? F.pvt.imp : null;
        var gasCol = function (sg, len, pBotPsig, liqTop, rhoPpg) {
            var z = 0.9, r = null, pS = pBotPsig;
            for (var it = 0; it < 8; it++) {
                r = G.WTS_gradient_compute({ dir: 'b2s', p: pBotPsig, tvd: tvd, gasLen: len, mixLen: 0, hl: 0, rho: rhoPpg || 8.33, sg: sg, t: tAvg, z: z });
                if (!r || !r.ok) return null;
                var pm = 0.5 * ((r.pSurf + PATM) + (r.sections[0].pBot + PATM));
                var zn = _zAvg(sg, pm, tAvg, imp);
                if (Math.abs(zn - z) < 1e-6) { z = zn; break; }
                z = zn; pS = r.pSurf;
            }
            r = G.WTS_gradient_compute({ dir: 'b2s', p: pBotPsig, tvd: tvd, gasLen: len, mixLen: 0, hl: 0, rho: rhoPpg || 8.33, sg: sg, t: tAvg, z: z });
            return r && r.ok ? { sithp: r.pSurf, z: z } : null;
        };
        var gf = gasCol(sgCol, tvd, pr - PATM);
        if (!gf) return { ok: false, code: 'GAS_COLUMN', errors: ['the gas column could not be evaluated'], warnings: [] };
        // live-liquid column density (oil + water by WC) at the local p and T, marched up from p̄r (oil wells)
        var liqRho = function (p, t) {
            var pr0 = F.at(Math.max(p, PATM), t);
            if (!pr0) return 8.33 * 7.48052;
            var wc = _fin(+F.wc) ? +F.wc : 0;
            if (F.type === 'water') return pr0.rhoW;
            if (gasT) return (+F.wgr > 0 && !(+F.cgr > 0)) ? pr0.rhoW : (pr0.rhoL || pr0.rhoO);
            return wc * pr0.rhoW + (1 - wc) * pr0.rhoO;
        };
        var actual = null, level = null;
        if (gasT) { actual = gf.sithp; notes.push('Gas well: the actual-fluid column is the gas column (condensate and water segregate at the bottom; their volume is not modelled).'); }
        else {
            var n = Math.max(20, Math.ceil(tvd / 100)), dz = tvd / n, p = pr;
            for (var k = 0; k < n; k++) {
                var z0 = tvd - k * dz, tz = tTop + (tBot - tTop) * (z0 - dz / 2) / tvd;
                var r1 = liqRho(p, tz), pm = p - r1 * dz / 144 / 2, r2 = liqRho(Math.max(pm, PATM), tz), pBefore = p;
                p -= r2 * dz / 144;
                if (p <= PATM) { level = Math.max(0, z0 - (pBefore - PATM) / (r2 / 144)); break; }
            }
            if (level != null) { actual = 0; notes.push('The liquid column is heavier than p̄r can hold: the static liquid level stands at about ' + _f(level, 0) + ' ft TVD (the well needs lift to flow).'); }
            else actual = p - PATM;
            notes.push('Actual fluid: a live-liquid column (oil and water by the water cut) marched up from p̄r; gas liberated above the bubble point is not given a separate cap (the gas-filled column is the bound).');
        }
        // partly liquid-filled columns
        var rhoMean = gasT ? (+F.wgr > 0 ? 62.4 * F.sgw : 62.4 * 141.5 / (131.5 + (F.api || 55))) : liqRho(0.5 * pr, tAvg);
        var levels = Array.isArray(o.levels) && o.levels.length ? o.levels : DEF_LEVELS.map(function (f) { return f * tvd; });
        var part = [];
        levels.forEach(function (lt) {
            var lv = +lt; if (!(lv >= 0 && lv <= tvd)) return;
            var c = gasCol(sgCol, lv, pr - PATM, lv, rhoMean / (144 * 0.052));      // ppg such that 0.052·ppg = ρ/144 exactly
            part.push({ liquidTopTvd: lv, liquidTopMd: typeof W.mdAt === 'function' ? W.mdAt(lv) : lv, sithp: c ? Math.max(0, c.sithp) : null });
        });
        var worst = Math.max(gf.sithp, _fin(actual) ? actual : -Infinity);
        var rate = _n(_get(M, ['surface', 'rating', 'wellhead_psi'])), rating = { verdict: 'none', margin: null, rating: rate };
        if (_fin(rate)) { var mg = rate - worst; rating.margin = mg; rating.verdict = mg < 0 ? 'fail' : (mg < 0.1 * rate ? 'warn' : 'ok'); }
        return { ok: true, gasFilled: gf.sithp, actualFluid: actual, partLiquid: part, liquidLevelTvd: level, sgCol: sgCol, zAvg: gf.z, tAvg: tAvg, tvd: tvd, midMd: mid,
            sithp: worst, rating: rating, notes: notes, warnings: [], errors: [] };
    }

    // ── max rate, design, bean schedule ──────────────────────────────────────
    function maxRate(M) {
        var R = solve(M, { mode: 'max' });
        var rate = _n(_get(M, ['surface', 'rating', 'tht_max_F']));
        var tht = R.ok && R.surface ? R.surface.tht : null;
        var rt = { verdict: 'none', margin: null };
        if (_fin(rate) && _fin(tht)) { rt.margin = rate - tht; rt.verdict = tht > rate ? 'fail' : (rate - tht < 10 ? 'warn' : 'ok'); }
        return { ok: !!R.ok, code: R.ok ? undefined : R.code, q: R.ok ? R.op.q : null, thp_psig: R.ok ? R.surface.thp_psig : null, tht: tht, thtMax: tht,
            thtNote: 'A1: the flowing THT is the entered value (the linear temperature model does not vary with rate); the A2 relaxation model makes it rate dependent.',
            rating: rt, R: R, errors: R.errors || [], warnings: R.warnings || [] };
    }
    function _setPath(M, path, v) { var o = M; for (var i = 0; i < path.length - 1; i++) { if (o[path[i]] == null || typeof o[path[i]] !== 'object') o[path[i]] = {}; o = o[path[i]]; } o[path[path.length - 1]] = v; }
    // Design (§4.9): the bean (8–128/64 in) or the fixed THP that gives the target rate. Monotone q(x): one full solve at the current
    // setting, a first guess from the choke law (critical rate ∝ S^1.89) or from the root slope (dq/dTHP ≈ −1/(dΔ/dq)), then secant /
    // Illinois steps; every later solve is a TRACKING solve warm-started from the nearest setting (≈ 5 E). Reverse communication: one
    // solve per Job step.
    // Tubing-ID design (A2, WP16; §4.9): a discrete scan over the WTS_tubulars tubing catalogue (every tubing size whose OD fits
    // inside the casing / liner around the tubing). One solve per size, smallest first, each a tracking solve warm-started from the
    // previous size's root (a full solve when the bracket fails). The answer is the SMALLEST size whose stable rate reaches the target
    // (tubing is sized for the rate it must carry, the smallest string keeps the highest velocity against loading); every size is
    // listed with its rate, stability, loading margin (gas) and erosion ratio. Not reachable: the size with the highest rate, and why.
    function _tubingCands(M) {
        var T = G.WTS_tubulars; if (!T || typeof T.list !== 'function') return [];
        var strs = (_get(M, ['well', 'strings'], []) || []), tub = strs.filter(function (x) { return x && (x.kind || 'tubing') === 'tubing'; });
        var top = tub.length ? Math.min.apply(null, tub.map(function (x) { return +x.topMd || 0; })) : 0, bot = tub.length ? Math.max.apply(null, tub.map(function (x) { return +x.botMd || 0; })) : 0;
        var dMin = Infinity; strs.forEach(function (c) { if (c && c.kind !== 'tubing' && +c.id > 0 && +c.topMd < bot && +c.botMd > top) dMin = Math.min(dMin, +c.id); });
        var seen = {}, out = [];
        T.list('tubing').slice().sort(function (a, b) { return a.id - b.id || a.od - b.od; }).forEach(function (e) {
            if (!(e.id > 0) || e.od >= dMin - 0.25 || seen[e.id.toFixed(3)]) return;
            seen[e.id.toFixed(3)] = 1; out.push({ key: e.key, id: e.id, od: e.od, wall: e.wall, label: e.label || e.key });
        });
        return out;
    }
    function _tubingDesign(M, qT) {
        var base = M ? _clone(M) : null, cands = base ? _tubingCands(base) : [];
        var tub = base ? (base.well.strings || []).filter(function (x) { return x && (x.kind || 'tubing') === 'tubing'; }) : [];
        if (!base || !tub.length || !cands.length) return job({ next: function () { return true; }, finish: function () { return { ok: false, code: 'NO_TUBING', errors: [!tub.length ? 'The well has no tubing string to size.' : 'No catalogue tubing fits inside the casing.'], warnings: [], rows: [] }; } });
        if (base.system.mode === 'design' || base.system.mode === 'max') base.system.mode = 'rate';
        var rows = [], prev = null, ev = 0;
        return job({
            label: function (i) { return 'tubing ' + (i < cands.length ? cands[i].label : '') + ' (' + Math.min(i + 1, cands.length) + ' of ' + cands.length + ')'; },
            progress: function (i) { return i / cands.length; },
            next: function (i) {
                if (i >= cands.length) return true;
                var c = cands[i], Mx = _clone(base);
                Mx.well.strings.forEach(function (x) { if (x && (x.kind || 'tubing') === 'tubing') { x.tubKey = c.key; x.id = c.id; x.od = c.od; x.wall = c.wall; } });
                var o = {};
                if (prev && prev.R.ok) o = { track: { q: prev.R.op.q * Math.pow(c.id / prev.id, 1.5), slope: prev.R.op.dDdq } };   // a new path: no warm grid
                var R = solve(Mx, o), ok = !!(R && R.ok && R.op);
                ev += R ? (R.evals || 0) : 0;
                if (ok) prev = { id: c.id, R: R };
                rows.push({ key: c.key, label: c.label, id: c.id, od: c.od, ok: ok, q: ok ? R.op.q : null, stable: ok ? !!R.op.stable : false,
                    loadingMargin: ok && R.loading ? R.loading.margin : null, ero: ok && R.velocities ? R.velocities.eroMax : null,
                    thp: ok ? R.surface.thp_psig : null, pwf: ok ? R.pwf : null, regime: ok ? (R.surface.choke && R.surface.choke.regime) : ((R && R.code) || 'no flow'), R: R });
                return i + 1 >= cands.length;
            },
            finish: function () {
                var hit = rows.filter(function (r) { return r.ok && r.stable && r.q >= qT * (1 - 1e-3); }), best = hit[0] || null;
                var top = rows.filter(function (r) { return r.ok; }).sort(function (a, b) { return b.q - a.q; })[0] || null;
                var cur = _n(tub[0].id), plain = rows.map(function (r) { var o = {}; Object.keys(r).forEach(function (k) { if (k !== 'R') o[k] = r[k]; }); return o; });
                if (best) return { ok: true, kind: 'tubingId', tubingId: best.id, tubKey: best.key, od: best.od, label: best.label, q: best.q, target: qT, R: best.R, rows: plain, current: cur, solves: rows.length, evals: ev, errors: [], warnings: [] };
                var why = top ? 'The largest rate of the catalogue sizes is ' + _f(top.q, 0) + ' with ' + top.label + ': the inflow or the surface limits the rate, not the tubing.' : 'No catalogue size flows.';
                return { ok: false, code: 'NOT_REACHABLE', kind: 'tubingId', target: qT, best: top ? { x: top.id, q: top.q, key: top.key } : null, rows: plain, current: cur, solves: rows.length, evals: ev,
                    errors: ['No catalogue tubing reaches the target rate ' + _f(qT, 0) + '.', why], warnings: [] };
            }
        });
    }
    function designFor(M, target) {
        target = target || {};
        if (target.tubingId != null) return _tubingDesign(M, +target.tubingId);
        // A2 (WP18): {qinj: q} — the lift-gas rate (Mscf/d, 0–5,000 or the largest of the GLPC list) that gives the target rate
        var kind = target.bean != null ? 'bean' : (target.thp != null ? 'thp' : (target.qinj != null ? 'qinj' : null)), qT = kind ? +target[kind] : NaN;
        var base = M ? _clone(M) : null;
        if (!kind || !(qT > 0) || !base || !base.surface || !base.system) return job({ next: function () { return true; }, finish: function () { return { ok: false, code: 'BAD_TARGET', errors: ['a target rate {bean: q}, {thp: q} or {qinj: q} is needed'], warnings: [] }; } });
        if (kind !== 'qinj') base.surface.choke.present = kind === 'bean';
        base.system.mode = 'rate';
        var gl0 = (base.lift && base.lift.gl) || {}, qlMax = Math.max.apply(null, [5000].concat((gl0.qinjList_Mscfd || []).map(Number).filter(_fin)));
        var LO = kind === 'bean' ? 8 : (kind === 'qinj' ? 0 : Math.max(0, _n(base.surface.psep_psig) || 0));
        var HI = kind === 'bean' ? 128 : (kind === 'qinj' ? qlMax : Math.max(LO + 50, (_n(base.res.pr) || 3000) - PATM - 10));
        var x0 = kind === 'bean' ? (_n(base.surface.choke.bean64) || 32) : (kind === 'qinj' ? (_n(gl0.qinj_Mscfd) || 500) : (_n(base.system.thp_psig) || LO + 100));
        x0 = Math.min(Math.max(x0, LO), HI);
        var pts = [], S = { solves: 0, best: null, fail: null, warm: null }, maxSolves = 16;
        var tolQ = Math.max(1e-3 * qT, 0.5), tolX = kind === 'bean' ? 0.05 : (kind === 'qinj' ? 5 : 0.5);
        function at(x) {
            var Mx = _clone(base);
            if (kind === 'bean') Mx.surface.choke.bean64 = x;
            else if (kind === 'qinj') { Mx.lift = Mx.lift || {}; Mx.lift.type = x > 0 ? 'gaslift' : 'none'; Mx.lift.gl = Mx.lift.gl || {}; Mx.lift.gl.qinj_Mscfd = x; }
            else Mx.system.thp_psig = x;
            // warm start from the evaluated setting nearest to x
            var near = null; pts.forEach(function (p) { if (p.R && p.R.ok && (!near || Math.abs(p.x - x) < Math.abs(near.x - x))) near = p; });
            var o = {};
            if (near) {
                o.warm = near.R.grid;
                var qe = near.q;
                var br = _bracketPts(x);
                if (br) qe = br.a.q + (br.b.q - br.a.q) * (x - br.a.x) / (br.b.x - br.a.x);
                o.track = { q: Math.max(qe, 1e-3), slope: near.R.op ? near.R.op.dDdq : null };
            }
            var R = solve(Mx, o);
            S.solves++;
            var q = R && R.ok && R.op ? R.op.q : 0;
            var p = { x: x, q: q, f: q - qT, R: R };
            pts.push(p);
            if (!S.best || Math.abs(p.f) < Math.abs(S.best.f)) S.best = p;
            return p;
        }
        function _bracketPts(x) {
            var lo = null, hi = null;
            pts.forEach(function (p) { if (!(p.q > 0)) return; if (p.x <= x && (!lo || p.x > lo.x)) lo = p; if (p.x >= x && (!hi || p.x < hi.x)) hi = p; });
            return (lo && hi && hi.x > lo.x) ? { a: lo, b: hi } : null;
        }
        // the bracket on f: the closest pair (in x) of a point above and a point below the target. A no-flow point (q = 0, past the
        // stability cliff) is a one-sided bound, never a value for the secant: such a bracket is bisected.
        function bracket() {
            var P = pts.filter(function (p) { return p.f > 0; }), N = pts.filter(function (p) { return p.f < 0; }), bestPair = null;
            P.forEach(function (a) { N.forEach(function (b) { var w = Math.abs(a.x - b.x); if (!bestPair || w < bestPair.w) bestPair = { pos: a, neg: b, w: w }; }); });
            return bestPair;
        }
        function _seen(x) { return pts.some(function (p) { return Math.abs(p.x - x) < Math.max(1e-9, 0.25 * tolX); }); }
        function nextX() {
            var last = pts[pts.length - 1];
            var br = bracket();
            if (br) {
                var lo = Math.min(br.pos.x, br.neg.x), hi = Math.max(br.pos.x, br.neg.x), mid = 0.5 * (lo + hi);
                if (!(br.neg.q > 0)) return mid;                                   // no-flow side: bisect
                var xs = (br.neg.x * br.pos.f - br.pos.x * br.neg.f) / (br.pos.f - br.neg.f);
                // keep the secant strictly inside the bracket and away from its ends; else bisect
                var guard = 0.05 * (hi - lo);
                if (!_fin(xs) || xs <= lo + guard || xs >= hi - guard || _seen(xs)) return mid;
                return xs;
            }
            if (pts.length === 1) {
                if (kind === 'qinj') return (!(last.q > 0) || last.q < qT) ? Math.min(HI, last.x * 2 + 250) : last.x * 0.5;
                if (!(last.q > 0)) return kind === 'bean' ? Math.min(HI, last.x * 2) : Math.max(LO, last.x * 0.5);
                if (kind === 'bean') return last.x * Math.pow(qT / last.q, 1 / 1.89);
                var sl = last.R && last.R.op ? last.R.op.dDdq : null;
                return last.x - (qT - last.q) * (_fin(sl) && sl > 0 ? sl : 1);
            }
            // two or more points on one side: secant on the two latest flowing points, else expand towards the bound
            var p1 = pts[pts.length - 1], p2 = pts[pts.length - 2];
            if (p1.q > 0 && p2.q > 0 && p1.x !== p2.x && p1.f !== p2.f) {
                var xn = p1.x - p1.f * (p1.x - p2.x) / (p1.f - p2.f);
                if (_fin(xn) && !_seen(xn)) return xn;
            }
            var up = (kind === 'bean' || kind === 'qinj') === (last.f < 0);
            var bound = up ? HI : LO;
            // no-flow on the far side: half-way back towards the flowing side rather than to the bound
            if (!(last.q > 0)) { var fl = pts.filter(function (p) { return p.q > 0; }); if (fl.length) { var nb = fl.reduce(function (a, b) { return Math.abs(b.x - last.x) < Math.abs(a.x - last.x) ? b : a; }); return 0.5 * (nb.x + last.x); } }
            return _seen(bound) ? 0.5 * (bound + last.x) : bound;
        }
        return job({
            label: function (i) { return 'solve ' + (i + 1); },
            progress: function (i) { return Math.min(0.95, i / maxSolves); },
            next: function (i) {
                var x = i === 0 ? x0 : nextX();
                if (!_fin(x)) x = 0.5 * (LO + HI);
                x = Math.min(Math.max(x, LO), HI);
                if (i > 0 && _seen(x)) {
                    // the guess repeats a setting: never "converged" unless the target is met (|f| ≤ tolQ)
                    if (Math.abs(S.best.f) <= tolQ) return true;
                    var brr = bracket();
                    if (brr && brr.w > tolX) x = 0.5 * (brr.pos.x + brr.neg.x);
                    else { S.fail = brr ? 'NOT_REACHABLE_GAP' : 'NOT_REACHABLE'; return true; }
                }
                var p = at(x);
                if (Math.abs(p.f) < tolQ) return true;
                var bw = bracket();
                if (bw && bw.w <= tolX) { if (Math.abs(S.best.f) > tolQ) S.fail = 'NOT_REACHABLE_GAP'; return true; }
                return S.solves >= maxSolves;
            },
            finish: function () {
                var b = S.best;
                // why a target is out of reach: the conservative sub-critical bound (choke.subcritical 'bound') of the critical choke correlation caps the bean
                // rate (the no-choke maximum is shown next to it), or the target lies in the rates the well cannot hold (stability cliff)
                var why = function () {
                    var notes = [], bnd = pts.filter(function (p) { return p.R && p.R.ok && p.R.surface && p.R.surface.choke && p.R.surface.choke.regime === 'subcritical-bound'; });
                    if (kind === 'bean' && bnd.length) {
                        var qb = Math.max.apply(null, bnd.map(function (p) { return p.q; })), mr = maxRate(base);
                        notes.push('The critical choke correlation caps the rate at its conservative sub-critical bound (about ' + _f(qb, 0) + '): the bound p1 ≥ p2 / ' + GILBERT_YC + ' applies to every larger bean.' +
                            (mr && mr.ok ? ' Without a choke the well can deliver ' + _f(mr.q, 0) + ' (maximum rate); the continuous sub-critical model (the choke settings) lifts this cap.' : ''));
                        S.maxQ = mr && mr.ok ? mr.q : null;
                    }
                    if (S.fail === 'NOT_REACHABLE_GAP') notes.push('The target lies in the rates the well cannot hold steadily: the rate drops to no flow across the stability limit between the closest settings.');
                    return notes;
                };
                if (!b || (S.fail && Math.abs(b.f) > Math.max(0.01 * qT, 1))) return { ok: false, code: S.fail || 'FAILED', errors: ['No ' + (kind === 'bean' ? 'bean between 8/64 and 128/64 in' : kind === 'qinj' ? 'lift-gas rate up to ' + _f(HI, 0) + ' Mscf/d' : 'wellhead pressure') + ' reaches the target rate ' + _f(qT, 0) + '.'].concat(why()), warnings: [], solves: S.solves, best: b ? { x: b.x, q: b.q } : null, maxRate: S.maxQ != null ? S.maxQ : null };
                var out = { ok: Math.abs(b.f) <= Math.max(0.01 * qT, 1), q: b.q, R: b.R, solves: S.solves, target: qT, kind: kind, evals: pts.reduce(function (a, p) { return a + (p.R && p.R.evals || 0); }, 0), errors: [], warnings: [] };
                out[kind] = b.x;
                if (!out.ok) { out.errors.push('the closest setting gives ' + _f(b.q, 0) + ' against the target ' + _f(qT, 0)); why().forEach(function (t) { out.errors.push(t); }); out.maxRate = S.maxQ != null ? S.maxQ : null; }
                return out;
            }
        });
    }
    function beanSchedule(M, beans) {
        var list = (Array.isArray(beans) && beans.length ? beans : (_get(M, ['surface', 'beans'], null) || [16, 20, 24, 32, 40, 48])).map(Number).filter(function (b) { return b >= 2 && b <= 192; });
        list.sort(function (a, b) { return a - b; });
        var rows = [], prev = null, base = M ? _clone(M) : null;
        if (base && base.surface && base.system) { base.surface.choke.present = true; base.system.mode = 'rate'; } else base = null;
        return job({
            label: function (i) { return 'bean ' + (i < list.length ? list[i] : list[list.length - 1]) + '/64'; },
            progress: function (i) { return list.length ? i / list.length : 1; },
            next: function (i) {
                if (!base || i >= list.length) return true;
                var Mx = _clone(base); Mx.surface.choke.bean64 = list[i];
                var o = {};
                if (prev && prev.R && prev.R.ok) o = { warm: prev.R.grid, track: { q: prev.R.op.q * Math.pow(list[i] / prev.bean, 1.2), slope: prev.R.op.dDdq } };
                var R = solve(Mx, o);
                var ok = !!(R && R.ok);
                if (ok) prev = { bean: list[i], R: R };
                rows.push({ bean: list[i], ok: ok, q: ok ? R.op.q : null, thp: ok ? R.surface.thp_psig : null, tht: ok ? R.surface.tht : null,
                    dpChoke: ok ? R.surface.choke.dp : null, regime: ok ? R.surface.choke.regime : (R && R.code) || 'no flow', stable: ok ? !!R.op.stable : false,
                    loadingMargin: ok && R.loading ? R.loading.margin : null, pwf: ok ? R.pwf : null, evals: R ? R.evals : 0, tracked: !!(R && R.tracked) });
                return i + 1 >= list.length;
            },
            finish: function () { return rows; }
        });
    }

    // test / tool hooks: the surface boundary and one node evaluation at a rate, on a fresh context (or a given frozen grid)
    function boundary(M, q, o) {
        var cx = _ctx(M, o || {});
        if (cx.fail) return cx.fail;
        var t = _top(cx.C, q);
        if (t.lost) return { ok: false, code: 'LOST', reason: t.reason, errors: ['the surface boundary is lost (' + t.reason + ')'], warnings: [] };
        return { ok: true, thp: t.thp, thp_psig: t.thp - PATM, p2: t.p2, p2_psig: t.p2 - PATM, regime: t.regime, ratio: t.ratio, yc: t.yc,
            p1crit_psig: t.p1crit, lineDp: t.lineDp, warnings: [], errors: [] };
    }
    // ── the choke performance curve at the operating point (A2, WP15; the page's "Choke" tab) ──────────────────────────────
    // At the operating THP p1 (psia) and THT: the rate through the bean against the pressure ratio y = p2/p1 — the Sachdeva et al.
    // (1986) curve (scaled by the rate factor, or to the critical correlation at its critical point), the critical correlation's
    // rate (flat, valid below its critical ratio 0.588) and, for gas wells, the isentropic nozzle; the operating point (y, q) on it.
    // chokeCurve(M, {R}) → {ok, p1 psia, p1_psig, tht, bean, corr, model, regime, yc, ycCorr, op:{y, q}, rateUnit,
    //                        series:{sachdeva:[{y, q}], corr:[{y, q}], nozzle:[{y, q}]}, rateFactor, x1}
    function chokeCurve(M, o) {
        o = o || {};
        var R = o.R && o.R.ok ? o.R : solve(M);
        if (!R || !R.ok || !R.op) return { ok: false, code: (R && R.code) || 'NO_SOLUTION', errors: (R && R.errors && R.errors.length) ? R.errors : ['no operating point'], warnings: [] };
        var ch = R.surface && R.surface.choke;
        if (!ch || !ch.present) return { ok: false, code: 'NO_CHOKE', errors: ['no surface choke in line'], warnings: [] };
        var cx = _ctx(M, {}); if (cx.fail) return cx.fail;
        var C = cx.C, q0 = R.op.q, p1 = R.surface.thp, T = R.surface.tht, ff = G.WTS_wp_fluid.flowlineFluid(C.F, q0);
        var qL = ff.qo + ff.qw, glr = qL > 0 ? ff.qg_MMscfd * 1e6 / qL : 0;
        var m = _mixAt(C, q0, p1, T); if (!m) return { ok: false, code: 'NO_STATE', errors: ['the choke inlet state could not be evaluated'], warnings: [] };
        var perQ = m.w / q0, ys = [];
        for (var i = 1; i <= 40; i++) ys.push(Math.min(0.999, 0.025 * i));
        var out = { ok: true, p1: p1, p1_psig: p1 - PATM, tht: T, bean: C.choke.bean, corr: ch.corr, model: ch.model, regime: ch.regime, yc: ch.yc, ycCorr: null,
            op: { y: ch.ratio, q: q0 }, rateUnit: C.gas ? 'Mscf/d' : 'STB/d liquid', series: { sachdeva: [], corr: [], nozzle: [] }, rateFactor: ch.rateFactor, x1: m.x1, warnings: [], errors: [] };
        var fac = _fin(ch.rateFactor) ? ch.rateFactor : 1, ycS = null;
        if (!C.gas && glr >= 10 && C.choke.corr !== 'sachdeva') {
            var per = G.WTS_chokeperf_multiphaseRate(C.choke.corr, 1, C.choke.bean, glr), qc = per * (p1 - PATM);
            out.ycCorr = GILBERT_YC;
            ys.filter(function (y) { return y <= GILBERT_YC + 1e-12; }).concat([GILBERT_YC]).forEach(function (y) { out.series.corr.push({ y: y, q: qc }); });
            var scC = _sachAt(C, qc, p1, p1 * 1e-6, T); if (scC && scC.w > 0) fac = (qc * perQ) / scC.w;   // scaled to the correlation's critical rate at p1
        }
        if (!C.gas && glr < 10) return Object.assign(out, { model: 'liquid' });
        if (C.gas && C.choke.corr !== 'sachdeva') {
            var gr = G.WTS_chokeperf_gasRate, k = _kGas(C, T), z = (C.F.at(p1, T, q0) || {}).z || 0.9, cd = (C.choke.cd >= 0.5 && C.choke.cd <= 1.2) ? C.choke.cd : 0.85;
            if (typeof gr === 'function') ys.forEach(function (y) { out.series.nozzle.push({ y: y, q: gr({ s64: C.choke.bean, cd: cd, p1a: p1, p2a: y * p1, tR: T + RANK, sg: C.F.sgg, k: k, z: z }) }); });
            out.ycCorr = Math.pow(2 / (k + 1), k / (k - 1));
        }
        if (C.choke.corr === 'sachdeva' || !C.gas) {
            ys.forEach(function (y) { var s = _sachAt(C, q0, p1, y * p1, T); if (s) { if (ycS == null) ycS = s.yc; out.series.sachdeva.push({ y: y, q: fac * s.w / perQ }); } });
            if (_fin(ycS)) out.ycSachdeva = ycS;
        }
        return out;
    }
    // the rate factor that makes the Sachdeva model equal a critical correlation at the operating point's critical rate (§4.7):
    // factor = w(q_op) / w_Sachdeva,critical(p1_corr(q_op)) — the number the page writes into the rate factor control
    function chokeFactor(M, corrKey, o) {
        o = o || {};
        var R = o.R && o.R.ok ? o.R : solve(M);
        if (!R || !R.ok || !R.op) return { ok: false, code: 'NO_SOLUTION', errors: ['no operating point'], warnings: [] };
        var cx = _ctx(M, {}); if (cx.fail) return cx.fail;
        var C = cx.C, q = R.op.q, T = R.surface.tht, ff = G.WTS_wp_fluid.flowlineFluid(C.F, q), qL = ff.qo + ff.qw, glr = qL > 0 ? ff.qg_MMscfd * 1e6 / qL : 0;
        if (C.gas || glr < 10) return { ok: false, code: 'NOT_APPLICABLE', errors: ['the critical multiphase correlations apply to oil wells with free gas (GLR ≥ 10 scf/STB)'], warnings: [] };
        var per = typeof G.WTS_chokeperf_multiphaseRate === 'function' ? G.WTS_chokeperf_multiphaseRate(corrKey, 1, C.choke.bean, glr) : NaN;
        if (!(per > 0)) return { ok: false, code: 'UNKNOWN_CORR', errors: ['unknown critical correlation ' + String(corrKey).slice(0, 30)], warnings: [] };
        var p1e = qL / per + PATM, sc = _sachAt(C, q, p1e, p1e * 1e-6, T), m = _mixAt(C, q, p1e, T);
        if (!sc || !m || !(sc.w > 0)) return { ok: false, code: 'NO_STATE', errors: ['the choke inlet state could not be evaluated'], warnings: [] };
        var fac = m.w / sc.w;                       // relative to the Cd in the model (w_Sachdeva ∝ Cd)
        return { ok: true, factor: fac, corr: corrKey, q: q, p1_psig: p1e - PATM, yc: sc.yc, cd: C.choke.cdS, warnings: [], errors: [] };
    }
    function evalAt(M, q, o) {
        o = o || {};
        var cx = _ctx(M, o);
        if (cx.fail) return cx.fail;
        var C = cx.C;
        if (o.grid) { C.grids.fine = o.grid.fine || null; C.grids.coarse = o.grid.coarse || null; C.grids.line = o.grid.line || null; }
        var e = _eval(C, q, o.coarse ? false : true, true);
        return { ok: !e.lost, q: q, pOut: e.pOut, pIn: e.pIn, delta: e.delta, thp: e.top && !e.top.lost ? e.top.thp : null, regime: e.top && e.top.regime,
            lost: e.lost || null, tr: e.tr || null, grid: { dir: C.node, fine: C.grids.fine, coarse: C.grids.coarse, line: C.grids.line }, counts: C.counts, warnings: [], errors: [] };
    }

    var NS = G.WTS_wp_system = G.WTS_wp_system || {};
    NS.solve = solve; NS.designFor = designFor; NS.maxRate = maxRate; NS.shutIn = shutIn; NS.beanSchedule = beanSchedule; NS.job = job;
    NS.boundary = boundary; NS.evalAt = evalAt; NS.chokeCurve = chokeCurve; NS.chokeFactor = chokeFactor;
    NS._pchip = _pchip; NS._brent = _brent;
    NS.SCAN_FRACS = SCAN_FRACS.slice(); NS.TOL_P = TOL_P; NS.TOL_Q = TOL_Q; NS.GILBERT_YC = GILBERT_YC; NS.LOAD = LOAD; NS.HEADING_FRAC = HEADING_FRAC;
    G.WTS_wp_loading = loading;
    G.WTS_wp_check = check;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, S = G.WTS_wp_system, bad = [];
    if (!S || typeof S.solve !== 'function' || typeof G.WTS_wp_loading !== 'function' || typeof G.WTS_wp_check !== 'function') bad.push('namespace');
    else {
        var p = S._pchip([0, 1, 2, 3], [0, 1, 1, 2]);
        if (Math.abs(p.f(1.5) - 1) > 1e-12) bad.push('pchip flat');
        var b = S._brent(function (x) { return x * x - 2; }, 1, 2, -1, 2, 50);
        if (Math.abs(b.x - Math.SQRT2) > 1e-3) bad.push('brent');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-system.js self-test] ' + bad.join('; '));
})();
