
// ═══════════════════════════════════════════════════════════════════════
// PRiSM Round-3 expansion — auto-injected from prism-build/
//   • 16-pvt                 (PVT correlations + dimensional conversion)
//   • 17-deconvolution       (von Schroeter-Levitan deconvolution)
//   • 18-tide-analysis       (tidal harmonic regression + ct estimate)
//   • 19-data-managers       (gauge-data + analysis-data + project file)
//   • 20-plt-inverse         (synthetic PLT + inverse rate-from-pressure sim)
//   • 21-plot-utilities      (overlays + diff + XML export + clipboard)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 16-pvt ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 16 — Well & Test store, PVT correlations, "Well & Test"
//   card and dimensional conversion.
//   Standard black-oil + gas + water PVT correlations.
//   The single source of truth for well, fluid and test inputs is
//   window.PRiSM_pvt (persisted as 'wts_prism_pvt'), extended with test
//   fields and per-field provenance (contract C1 of the gap-closure plan).
//
//   References:
//     Standing (1947)               — Bo, Pb, Rs (black-oil)
//     Vasquez-Beggs (1980)          — co (oil compressibility)
//     Beggs-Robinson (1975)         — μ_oD (dead oil), μ_o (live oil)
//     Sutton (1985)                 — gas pseudocriticals (high-MW correction)
//     Dranchuk-Abou-Kassem (1975)   — Z-factor (DAK 11-coefficient EOS)
//     Hall-Yarborough (1973)        — Z-factor (alternative)
//     Lee-Gonzalez-Eakin (1966)     — μ_g (gas viscosity)
//     Meehan (1980)                 — Bw, μ_w (water)
//     Dodson-Standing (1944)        — cw (water compressibility)
//     Al-Hussainy, Ramey (1966)     — real-gas pseudo-pressure m(p)
//     Earlougher (1977, SPE Mono 5) — dimensional conversions
//     Bourdet (2002)                — kh from the derivative stabilisation
// ════════════════════════════════════════════════════════════════════
//
// PUBLIC API
//   window.PRiSM_pvt                       — input + computed state (C1 store)
//   window.PRiSM_pvt_correlations          — pure correlation funcs
//   window.PRiSM_pvt_compute()             — fill in null values
//   window.PRiSM_pvt_effective()           — B, μ, ct actually used (override → correlation)
//   window.PRiSM_setWell(patch, {source})  — C1 writer (provenance, persist, 'prism:well-changed')
//   window.PRiSM_acceptWellDefaults(keys?) — mark defaulted inputs as accepted (provenance 'user')
//   window.PRiSM_mpTable(fluid?)           — cached m(p) table + monotone interpolator
//   window.PRiSM_dimensionalize(modelKey, params)   — dimensionless → real
//   window.PRiSM_nondimensionalize(modelKey, real)  — real → dimensionless
//   window.PRiSM_renderPVTPanel(container) — the "Well & Test" card (Tab 1 panel)
//   window.PRiSM_renderWellCard(container) — alias
//   window.PRiSM_interpretFitWithPVT(...)  — interpretation enricher
//   (PRiSM_getWell — the C1 resolver — lives in 33-pta-core.js.)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • Field units throughout (psia, ft, md, cp, hours, RB/STB, RB/Mscf, STB/d, Mscf/d).
//   • localStorage persistence under 'wts_prism_pvt'.
//   • No external dependencies — pure vanilla JS, Math.*.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims so the module can load in node smoke-tests.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    var LS_KEY = 'wts_prism_pvt';

    function _isFiniteNum(v) { return (typeof v === 'number') && isFinite(v); }
    function _isPos(v) { return _isFiniteNum(v) && v > 0; }
    function _fmt(n, dp) {
        if (n == null || !isFinite(n)) return '—';
        return Number(n).toFixed(dp == null ? 4 : dp);
    }
    function _fmtSig(n, sig) {
        if (n == null || !isFinite(n)) return '—';
        if (n === 0) return '0';
        sig = sig || 4;
        var a = Math.abs(n);
        if (a >= 1e6 || a < 1e-3) return Number(n).toExponential(sig - 1);
        return Number(n).toPrecision(sig).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }
    function _storage() {
        try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* denied */ }
        return null;
    }
    function _dispatch(name, detail) {
        try {
            var CE = G.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
            if (typeof G.dispatchEvent === 'function' && CE) G.dispatchEvent(new CE(name, { detail: detail }));
        } catch (e) { /* no event system */ }
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — DEFAULT STATE + LOCALSTORAGE PERSISTENCE
    // ═══════════════════════════════════════════════════════════════

    function _defaultPVT() {
        return {
            fluidType: 'oil',                    // 'oil' | 'gas' | 'water'
            // Test (C1)
            testType: 'auto',                    // 'auto'|'drawdown'|'buildup'|'injection'|'falloff'
            tp:    null,                         // hr  producing time before shut-in (null → from rate history)
            tShut: null,                         // hr  shut-in time (null → from rate history)
            pwf0:  null,                         // psia flowing pressure at shut-in (null → from data)
            // Reservoir
            p_res: 4000,                         // psia initial reservoir pressure pi (also PVT pressure)
            T_res: 180,                          // °F
            rw:    0.354,                        // ft (wellbore radius)
            h:     50,                           // ft (net pay)
            phi:   0.20,                         // fraction (porosity)
            Swc:   0.20,                         // fraction (connate water saturation)
            cf:    4e-6,                         // 1/psi (rock compressibility)
            ct:    null,                         // 1/psi total compressibility — direct entry (null → correlations)
            // Oil PVT (active when fluidType === 'oil')
            API:   35,                           // °API
            SG_g:  0.65,                         // gas specific gravity (air = 1)
            Rs:    null,                         // SCF/STB (null → compute)
            Pb:    null,                         // psia  (null → compute)
            Bo:    null,                         // RB/STB (null → compute)
            mu_o:  null,                         // cp    (null → compute)
            co:    null,                         // 1/psi (null → compute)
            // Gas PVT (active when fluidType === 'gas')
            Z:     null,                         // (null → compute, DAK)
            mu_g:  null,                         // cp    (null → compute, LGE)
            Bg:    null,                         // RB/Mscf
            cg:    null,                         // 1/psi
            // Water PVT (always relevant for ct)
            Sw:    0.20,                         // fraction
            cw:    3e-6,                         // 1/psi
            Bw:    1.0,                          // RB/STB
            mu_w:  0.5,                          // cp
            salinity_ppm: 50000,                 // ppm NaCl (water-correlation input)
            Rsw:   17,                           // SCF/STB (gas in water, for cw)
            // Rate (for dimensional Δp conversion)
            q:     1000,                         // STB/d (oil), Mscf/d (gas), STB/d water
            qFromData: true,                     // use the dataset's rate when it has one
            // Provenance per store field: 'default'|'user'|'sample'|'dataset'|'deconvolution'|'correlation'
            // (a missing key means 'default').
            provenance: {},
            // Computed (filled by PRiSM_pvt_compute)
            _computed: {
                ct: null, mu: null, B: null, z: null, Pb: null, Rs: null,
                co: null, cg: null, Bg: null, Bo: null, mu_o: null, mu_g: null,
                Sg: null, So: null, Sw_eff: null,
                timestamp: null, fluidType: null
            }
        };
    }

    // Restore from localStorage if present, else seed defaults.
    function _loadFromStorage() {
        if (!_hasWin) return _defaultPVT();
        try {
            var ls = _storage();
            var raw = ls ? ls.getItem(LS_KEY) : null;
            if (!raw) return _defaultPVT();
            var parsed = JSON.parse(raw) || {};
            var def = _defaultPVT();
            // Shallow merge so newly-introduced keys get defaults.
            for (var k in def) {
                if (Object.prototype.hasOwnProperty.call(parsed, k)) {
                    def[k] = parsed[k];
                }
            }
            if (!def.provenance || typeof def.provenance !== 'object') def.provenance = {};
            // _computed is not persisted (always recompute on demand).
            def._computed = _defaultPVT()._computed;
            return def;
        } catch (e) {
            return _defaultPVT();
        }
    }

    function _saveNow() {
        var ls = _storage();
        if (!ls) return;
        try {
            var s = G.PRiSM_pvt;
            if (!s) return;
            // Strip _computed before saving — it's derived state.
            var clone = {};
            for (var k in s) {
                if (k === '_computed') continue;
                if (Object.prototype.hasOwnProperty.call(s, k)) clone[k] = s[k];
            }
            ls.setItem(LS_KEY, JSON.stringify(clone));
        } catch (e) { /* quota / privacy mode */ }
    }

    // Initialise the global state.
    G.PRiSM_pvt = G.PRiSM_pvt || _loadFromStorage();
    if (!G.PRiSM_pvt.provenance || typeof G.PRiSM_pvt.provenance !== 'object') G.PRiSM_pvt.provenance = {};


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — CORRELATIONS (OIL)
    // ═══════════════════════════════════════════════════════════════
    //
    // Standing (1947) — bubble-point and FVF for "California crudes":
    //   Pb = 18.2 · [ (Rs/SG_g)^0.83 · 10^(0.00091·T - 0.0125·API) - 1.4 ]
    //   Bo = 0.972 + 0.000147 · F^1.175,  F = Rs · √(SG_g/SG_o) + 1.25·T
    //
    // Beggs-Robinson (1975) — viscosity:
    //   μ_oD = 10^x − 1,  x = (T − 460)^(−1.163) · 10^(3.0324 − 0.02023·API)
    //                              ^ but T_F here, the formula is
    //   μ_oD = 10^z − 1,  z = T_F^(−1.163) · 10^Y,  Y = 3.0324 − 0.02023·API
    //   μ_o  = A · μ_oD^B,  A = 10.715·(Rs+100)^(−0.515),  B = 5.44·(Rs+150)^(−0.338)
    //
    // Vasquez-Beggs (1980) — oil compressibility above Pb:
    //   co = (-1433 + 5·Rs + 17.2·T - 1180·SG_g + 12.61·API) / (1e5 · P)
    //
    // All inputs in field units.

    // Standing bubble-point pressure.
    function Pb_standing(API, SG_g, Rs, T_F) {
        if (!_isFiniteNum(API) || !_isFiniteNum(SG_g) || !_isFiniteNum(Rs) || !_isFiniteNum(T_F)) return NaN;
        if (Rs <= 0 || SG_g <= 0) return 14.7;
        var ratio = Math.pow(Rs / SG_g, 0.83);
        var exp10 = Math.pow(10, 0.00091 * T_F - 0.0125 * API);
        return 18.2 * (ratio * exp10 - 1.4);
    }

    // Standing solution-gas-oil ratio at pressure P (≤ Pb).
    function Rs_standing(API, SG_g, P, T_F) {
        if (!_isFiniteNum(API) || !_isFiniteNum(SG_g) || !_isFiniteNum(P) || !_isFiniteNum(T_F)) return NaN;
        if (P <= 0) return 0;
        var inner = (P / 18.2 + 1.4) * Math.pow(10, 0.0125 * API - 0.00091 * T_F);
        // inner = (Rs/SG_g)^0.83  →  Rs = SG_g · inner^(1/0.83)
        return SG_g * Math.pow(inner, 1 / 0.83);
    }

    // Standing oil formation-volume factor at saturation (= at Pb if P ≥ Pb).
    function Bo_standing(API, SG_g, Rs, T_F) {
        if (!_isFiniteNum(API) || !_isFiniteNum(SG_g) || !_isFiniteNum(Rs) || !_isFiniteNum(T_F)) return NaN;
        var SG_o = 141.5 / (API + 131.5);
        var F = Rs * Math.sqrt(SG_g / SG_o) + 1.25 * T_F;
        return 0.972 + 0.000147 * Math.pow(F, 1.175);
    }

    // Beggs-Robinson dead-oil viscosity (gas-free).
    function mu_oD_beggsRobinson(API, T_F) {
        if (!_isFiniteNum(API) || !_isFiniteNum(T_F) || T_F <= 0) return NaN;
        var Y = 3.0324 - 0.02023 * API;
        var X = Math.pow(T_F, -1.163) * Math.pow(10, Y);
        return Math.pow(10, X) - 1;
    }

    // Beggs-Robinson live-oil viscosity (with solution gas).
    function mu_o_beggsRobinson(mu_oD, Rs) {
        if (!_isFiniteNum(mu_oD) || !_isFiniteNum(Rs) || mu_oD <= 0) return NaN;
        if (Rs < 0) Rs = 0;
        var A = 10.715 * Math.pow(Rs + 100, -0.515);
        var B = 5.44   * Math.pow(Rs + 150, -0.338);
        return A * Math.pow(mu_oD, B);
    }

    // Vasquez-Beggs oil compressibility (P ≥ Pb).
    function co_vasquezBeggs(API, SG_g, Rs, P, T_F /*, Pb */) {
        if (!_isFiniteNum(API) || !_isFiniteNum(SG_g) || !_isFiniteNum(Rs) ||
            !_isFiniteNum(P) || !_isFiniteNum(T_F) || P <= 0) return NaN;
        var num = -1433 + 5 * Rs + 17.2 * T_F - 1180 * SG_g + 12.61 * API;
        return num / (1e5 * P);
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — CORRELATIONS (GAS)
    // ═══════════════════════════════════════════════════════════════
    //
    // Sutton (1985) — high-MW pseudocritical correlations for natural gas:
    //   Tpc (°R)  = 169.2 + 349.5·SG − 74.0·SG²
    //   Ppc (psia)= 756.8 − 131.0·SG − 3.6·SG²
    //
    // Dranchuk-Abou-Kassem (1975) — 11-coefficient explicit EOS for Z:
    //   Z = 1 + (A1+A2/Tpr+A3/Tpr³+A4/Tpr⁴+A5/Tpr⁵)·ρpr
    //         + (A6+A7/Tpr+A8/Tpr²)·ρpr²
    //         − A9·(A7/Tpr+A8/Tpr²)·ρpr⁵
    //         + A10·(1+A11·ρpr²)·(ρpr²/Tpr³)·exp(−A11·ρpr²)
    //   ρpr = 0.27·Ppr / (Z·Tpr)
    //   solved iteratively for Z.
    //
    // Hall-Yarborough (1973) — alternative EOS using reduced density.
    //
    // Lee-Gonzalez-Eakin (1966) — gas viscosity:
    //   K = (9.4 + 0.02·M)·T^1.5 / (209 + 19·M + T)
    //   X = 3.5 + 986/T + 0.01·M
    //   Y = 2.4 − 0.2·X
    //   ρ_g (g/cc) = 1.4935e−3 · (P·M)/(Z·T)  [T in °R]
    //   μ_g = 1e−4 · K · exp(X · ρ_g^Y)         [cp]

    function Tpc_sutton(SG_g) {
        if (!_isFiniteNum(SG_g) || SG_g <= 0) return NaN;
        return 169.2 + 349.5 * SG_g - 74.0 * SG_g * SG_g;
    }

    function Ppc_sutton(SG_g) {
        if (!_isFiniteNum(SG_g) || SG_g <= 0) return NaN;
        return 756.8 - 131.0 * SG_g - 3.6 * SG_g * SG_g;
    }

    // DAK constants.
    var DAK = {
        A1:  0.3265,    A2: -1.0700,    A3: -0.5339,    A4:  0.01569,
        A5: -0.05165,   A6:  0.5475,    A7: -0.7361,    A8:  0.1844,
        A9:  0.1056,    A10: 0.6134,    A11: 0.7210
    };

    // Z-factor via DAK: Newton on ρ_pr with a bisection safeguard.
    //   f(ρ) = Z_EOS(ρ) − 0.27·Ppr/(ρ·Tpr) = 0
    // (The earlier successive substitution Z ← Z_EOS(0.27·Ppr/(Z·Tpr)) diverged
    //  at low Tpr / high Ppr — e.g. Tpr 1.5, Ppr 8 gave 1.60 instead of ≈ 0.99.
    //  Where it converged, the root is the same.)
    function Z_dranchukAbouKassem(Tpr, Ppr) {
        if (!_isFiniteNum(Tpr) || !_isFiniteNum(Ppr) || Tpr <= 0 || Ppr < 0) return NaN;
        if (Ppr === 0) return 1;
        var Tpr2 = Tpr * Tpr, Tpr3 = Tpr2 * Tpr, Tpr4 = Tpr3 * Tpr, Tpr5 = Tpr4 * Tpr;
        var c1 = DAK.A1 + DAK.A2 / Tpr + DAK.A3 / Tpr3 + DAK.A4 / Tpr4 + DAK.A5 / Tpr5;
        var c2 = DAK.A6 + DAK.A7 / Tpr + DAK.A8 / Tpr2;
        var c3 = DAK.A9 * (DAK.A7 / Tpr + DAK.A8 / Tpr2);
        var k = 0.27 * Ppr / Tpr;
        var a10 = DAK.A10 / Tpr3, a11 = DAK.A11;
        var fr = 0, dfr = 0;
        function evalF(r) {              // sets fr = f(ρ), dfr = f'(ρ)
            var r2 = r * r, r4 = r2 * r2, e = Math.exp(-a11 * r2);
            fr = 1 + c1 * r + c2 * r2 - c3 * r4 * r + a10 * (r2 + a11 * r4) * e - k / r;
            dfr = c1 + 2 * c2 * r - 5 * c3 * r4
                + a10 * e * (2 * r + 2 * a11 * r2 * r - 2 * a11 * a11 * r4 * r) + k / r2;
        }
        // Newton from the ideal-gas density ρ = 0.27·Ppr/Tpr, kept inside a
        // bracket [lo, hi] (f → −∞ as ρ → 0; hi found by stepping up on demand).
        var lo = 0, hi = Infinity, r = k;
        for (var iter = 0; iter < 100; iter++) {
            evalF(r);
            if (!isFinite(fr)) { hi = r; r = 0.5 * (lo + hi); continue; }
            if (fr < 0) lo = r; else hi = r;
            var rn = (isFinite(dfr) && dfr > 0) ? r - fr / dfr : NaN;
            if (!(rn > lo && rn < hi)) rn = isFinite(hi) ? 0.5 * (lo + hi) : 2 * r;
            if (Math.abs(rn - r) <= 1e-11 * r) { r = rn; break; }
            r = rn;
        }
        var Z = k / r;
        return (_isFiniteNum(Z) && Z > 0) ? Z : NaN;
    }

    // Z-factor via Hall-Yarborough — alternative EOS.
    // Solves f(y)=0 where y is reduced density, then Z = 0.06125·Ppr·t·exp(-1.2·(1-t)²)/y, t=1/Tpr.
    function Z_hallYarborough(Tpr, Ppr) {
        if (!_isFiniteNum(Tpr) || !_isFiniteNum(Ppr) || Tpr <= 0 || Ppr < 0) return NaN;
        if (Ppr === 0) return 1;
        var t = 1 / Tpr;
        var A = 0.06125 * Ppr * t * Math.exp(-1.2 * (1 - t) * (1 - t));
        var B = 14.76 * t - 9.76 * t * t + 4.58 * t * t * t;
        var C = 90.7 * t - 242.2 * t * t + 42.4 * t * t * t;
        var D = 2.18 + 2.82 * t;
        // Newton solve for y.
        var y = 0.001;
        for (var iter = 0; iter < 50; iter++) {
            var y2 = y * y, y3 = y2 * y, y4 = y3 * y;
            var num1 = (y + y2 + y3 - y4);
            var den1 = Math.pow(1 - y, 3);
            var f = -A + num1 / den1 - B * y2 + C * Math.pow(y, D);
            // df/dy
            var d_num1 = 1 + 2 * y + 3 * y2 - 4 * y3;
            var d_den1 = -3 * Math.pow(1 - y, 2);  // d/dy of (1-y)^3 is -3(1-y)^2
            // d(num1/den1)/dy
            var dRatio = (d_num1 * den1 - num1 * d_den1) / (den1 * den1);
            var df = dRatio - 2 * B * y + C * D * Math.pow(y, D - 1);
            if (!isFinite(df) || df === 0) break;
            var ynew = y - f / df;
            if (ynew <= 0) ynew = y * 0.5;
            if (ynew >= 1) ynew = (y + 1) * 0.5;
            if (Math.abs(ynew - y) < 1e-9) { y = ynew; break; }
            y = ynew;
        }
        if (!_isFiniteNum(y) || y <= 0 || y >= 1) return NaN;
        return A / y;
    }

    // Lee-Gonzalez-Eakin gas viscosity (cp).
    // SG_g (air=1), T_F (°F), Z (-), P (psia)
    function mu_g_leeGonzalezEakin(SG_g, T_F, Z, P) {
        if (!_isFiniteNum(SG_g) || !_isFiniteNum(T_F) || !_isFiniteNum(Z) || !_isFiniteNum(P)) return NaN;
        var M = 28.9647 * SG_g;  // apparent molecular weight
        var T_R = T_F + 459.67;  // Rankine
        if (T_R <= 0 || Z <= 0) return NaN;
        var K = (9.4 + 0.02 * M) * Math.pow(T_R, 1.5) / (209 + 19 * M + T_R);
        var X = 3.5 + 986 / T_R + 0.01 * M;
        var Y = 2.4 - 0.2 * X;
        // ρ_g in g/cc — see Lee 1966 / McCain text.
        var rho_g = 1.4935e-3 * (P * M) / (Z * T_R);
        return 1e-4 * K * Math.exp(X * Math.pow(rho_g, Y));
    }

    // Gas formation-volume factor in RB/Mscf (q is in Mscf/d, so q·Bg is RB/d).
    //   Bg [RB/Mscf] = 5.035 · Z · T_R / P
    //   (= 0.02827·Z·T_R/P in ft³/scf, ÷ 5.615 for RB/scf, × 1000 for RB/Mscf)
    function Bg(P, T_F, Z) {
        if (!_isFiniteNum(P) || !_isFiniteNum(T_F) || !_isFiniteNum(Z) || P <= 0) return NaN;
        var T_R = T_F + 459.67;
        return 5.035 * Z * T_R / P;
    }

    // Real-gas compressibility cg = 1/P − (1/Z)·dZ/dP, evaluated numerically.
    function cg_realGas(P, T_F, Z, SG_g) {
        if (!_isFiniteNum(P) || !_isFiniteNum(T_F) || !_isFiniteNum(Z) || P <= 0) return NaN;
        // If SG_g supplied, compute dZ/dP locally; otherwise approximate as 1/P.
        if (!_isFiniteNum(SG_g)) return 1 / P;
        var Tpc = Tpc_sutton(SG_g), Ppc = Ppc_sutton(SG_g);
        if (!_isFiniteNum(Tpc) || !_isFiniteNum(Ppc) || Ppc <= 0) return 1 / P;
        var Tpr = (T_F + 459.67) / Tpc;
        var dP = Math.max(P * 1e-3, 1.0);
        var Z1 = Z_dranchukAbouKassem(Tpr, (P + dP) / Ppc);
        var Z0 = Z_dranchukAbouKassem(Tpr, Math.max(1e-6, (P - dP) / Ppc));
        if (!_isFiniteNum(Z1) || !_isFiniteNum(Z0)) return 1 / P;
        var dZdP = (Z1 - Z0) / (2 * dP);
        return 1 / P - (1 / Z) * dZdP;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — CORRELATIONS (WATER)
    // ═══════════════════════════════════════════════════════════════
    //
    // Meehan (1980) — Bw and μ_w from correlations:
    //   Bw = (1 + dVwT) · (1 + dVwP)
    //   dVwT = -1.0001e-2 + 1.33391e-4·T + 5.50654e-7·T²
    //   dVwP = -1.95301e-9·P·T - 1.72834e-13·P²·T - 3.58922e-7·P - 2.25341e-10·P²
    //   μ_w (60°F freshwater) ≈ 1.002 cp; correlation includes salinity effect.
    //
    // Dodson-Standing (1944) — water compressibility cw, modified for dissolved gas:
    //   cw_pure ≈ (3.8546 - 0.01052·T + 3.92e-5·T²)e-6 / (1 + 8.9e-3·P + 6.5e-7·P²)·...
    //   Field-units quick form: cw ≈ (a + b·T + c·T²) · (1 + 8.9e-3·Rsw)  · 1e-6
    //   where Rsw is dissolved-gas content in SCF/STB.

    function Bw_meehan(P, T_F) {
        if (!_isFiniteNum(P) || !_isFiniteNum(T_F)) return NaN;
        var dVwT = -1.0001e-2 + 1.33391e-4 * T_F + 5.50654e-7 * T_F * T_F;
        var dVwP = -1.95301e-9 * P * T_F
                   - 1.72834e-13 * P * P * T_F
                   - 3.58922e-7 * P
                   - 2.25341e-10 * P * P;
        return (1 + dVwT) * (1 + dVwP);
    }

    // McCain water viscosity, with salinity correction.
    function mu_w_meehan(T_F, salinity_ppm) {
        if (!_isFiniteNum(T_F)) return NaN;
        var S = (_isFiniteNum(salinity_ppm) ? salinity_ppm : 0) / 1e4;  // wt %
        // Reference fresh-water viscosity from McCain (1991) approximation:
        //   μ_w_ref (cp) = exp(1.003 - 1.479e-2·T + 1.982e-5·T²)
        // Salinity scale factor:
        //   A = 109.574 - 8.40564·S + 0.313314·S² + 8.72213e-3·S³
        //   B = -1.12166 + 2.63951e-2·S - 6.79461e-4·S² - 5.47119e-5·S³ + 1.55586e-6·S⁴
        var A = 109.574 - 8.40564 * S + 0.313314 * S * S + 8.72213e-3 * S * S * S;
        var B = -1.12166 + 2.63951e-2 * S - 6.79461e-4 * S * S
                - 5.47119e-5 * S * S * S + 1.55586e-6 * S * S * S * S;
        var mu_w = A * Math.pow(T_F, B);
        if (!_isFiniteNum(mu_w) || mu_w <= 0) return 0.5;
        return mu_w;
    }

    // Dodson-Standing water compressibility, with dissolved-gas correction.
    function cw_dodson(P, T_F, Rsw) {
        if (!_isFiniteNum(P) || !_isFiniteNum(T_F)) return NaN;
        // Pure-water cw at (P, T) — Osif (1988) / Dodson-Standing form:
        //   cw_pure (1/psi) = 1 / (7.033·P + 0.5415·S - 537.0·T + 403300)
        //   (S in mg/L; here we use the simplified P,T form)
        var cw_pure = 1 / (7.033 * P - 537.0 * T_F + 403300);
        // Gas-correction: cw = cw_pure · (1 + 8.9e-3 · Rsw)
        var Rs_use = _isFiniteNum(Rsw) ? Rsw : 0;
        var corr = 1 + 8.9e-3 * Rs_use;
        return cw_pure * corr;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — PSEUDO-PRESSURE m(p) FOR GAS
    // ═══════════════════════════════════════════════════════════════
    //
    // Al-Hussainy / Ramey (1966) pseudo-pressure:
    //   m(p) = 2 ∫₀^P  (P' / (μ_g(P') · Z(P'))) dP'
    // Field units → psi²/cp.
    //
    // Numerical integration (Simpson's rule, 40 intervals).

    function m_p(P, T_F, SG_g) {
        if (!_isFiniteNum(P) || !_isFiniteNum(T_F) || !_isFiniteNum(SG_g) || P <= 0) return NaN;
        var Tpc = Tpc_sutton(SG_g), Ppc = Ppc_sutton(SG_g);
        if (!_isFiniteNum(Tpc) || !_isFiniteNum(Ppc) || Ppc <= 0) return NaN;
        var Tpr = (T_F + 459.67) / Tpc;

        var N = 40;       // even
        var dP = P / N;

        function integrand(Pi) {
            if (Pi <= 0) return 0;
            var Ppr = Pi / Ppc;
            var Z   = Z_dranchukAbouKassem(Tpr, Ppr);
            var mu  = mu_g_leeGonzalezEakin(SG_g, T_F, Z, Pi);
            if (!_isFiniteNum(Z) || !_isFiniteNum(mu) || mu <= 0 || Z <= 0) return 0;
            return Pi / (mu * Z);
        }

        // Composite Simpson.
        var s = integrand(0) + integrand(P);
        for (var i = 1; i < N; i++) {
            var Pi = i * dP;
            s += (i % 2 === 0 ? 2 : 4) * integrand(Pi);
        }
        return 2 * (dP / 3) * s;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — TOTAL COMPRESSIBILITY ct
    // ═══════════════════════════════════════════════════════════════
    //
    //   ct = So·co + Sw·cw + Sg·cg + cf
    // Phase saturations should sum to 1.

    function ct(So, co, Sw, cw, Sg, cg, cf) {
        var c1 = (_isFiniteNum(So) && _isFiniteNum(co)) ? So * co : 0;
        var c2 = (_isFiniteNum(Sw) && _isFiniteNum(cw)) ? Sw * cw : 0;
        var c3 = (_isFiniteNum(Sg) && _isFiniteNum(cg)) ? Sg * cg : 0;
        var c4 = (_isFiniteNum(cf)) ? cf : 0;
        return c1 + c2 + c3 + c4;
    }


    // Expose the correlation library.
    G.PRiSM_pvt_correlations = {
        // Oil
        Pb_standing:          Pb_standing,
        Rs_standing:          Rs_standing,
        Bo_standing:          Bo_standing,
        mu_oD_beggsRobinson:  mu_oD_beggsRobinson,
        mu_o_beggsRobinson:   mu_o_beggsRobinson,
        co_vasquezBeggs:      co_vasquezBeggs,
        // Gas
        Tpc_sutton:           Tpc_sutton,
        Ppc_sutton:           Ppc_sutton,
        Z_dranchukAbouKassem: Z_dranchukAbouKassem,
        Z_hallYarborough:     Z_hallYarborough,
        mu_g_leeGonzalezEakin: mu_g_leeGonzalezEakin,
        Bg:                   Bg,
        cg_realGas:           cg_realGas,
        // Water
        Bw_meehan:            Bw_meehan,
        mu_w_meehan:          mu_w_meehan,
        cw_dodson:            cw_dodson,
        // Pseudo-pressure
        m_p:                  m_p,
        // Total compressibility
        ct:                   ct
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — COMPUTE ORCHESTRATOR
    // ═══════════════════════════════════════════════════════════════
    //
    // Reads window.PRiSM_pvt, fills any null fluid properties via correlations,
    // computes phase saturations, total compressibility, and effective μ/B.
    // Result is written to PRiSM_pvt._computed and also returned.

    G.PRiSM_pvt_compute = function PRiSM_pvt_compute() {
        var s = G.PRiSM_pvt;
        if (!s) {
            G.PRiSM_pvt = _defaultPVT();
            s = G.PRiSM_pvt;
        }
        var P  = s.p_res;
        var T  = s.T_res;
        var c  = {
            ct: null, mu: null, B: null, z: null, Pb: null, Rs: null,
            co: null, cg: null, Bg: null, Bo: null, mu_o: null, mu_g: null,
            Sg: null, So: null, Sw_eff: null,
            timestamp: Date.now(),
            fluidType: s.fluidType
        };

        if (s.fluidType === 'oil') {
            // 1. Bubble point.
            var Pb = _isFiniteNum(s.Pb) ? s.Pb : Pb_standing(s.API, s.SG_g, s.Rs != null ? s.Rs : 500, T);
            // 2. Solution GOR at reservoir pressure.
            var Rs;
            if (_isFiniteNum(s.Rs)) {
                Rs = s.Rs;
            } else {
                if (P >= Pb) {
                    // Saturated GOR is the value at P=Pb (Standing inverse).
                    Rs = Rs_standing(s.API, s.SG_g, Pb, T);
                } else {
                    Rs = Rs_standing(s.API, s.SG_g, P, T);
                }
            }
            // 3. Bo.
            var Bo = _isFiniteNum(s.Bo) ? s.Bo : Bo_standing(s.API, s.SG_g, Rs, T);
            // 4. Dead + live oil viscosity.
            var mu_oD = mu_oD_beggsRobinson(s.API, T);
            var mu_o  = _isFiniteNum(s.mu_o) ? s.mu_o : mu_o_beggsRobinson(mu_oD, Rs);
            // 5. Oil compressibility.
            var co_   = _isFiniteNum(s.co) ? s.co : co_vasquezBeggs(s.API, s.SG_g, Rs, P, T);
            if (!_isFiniteNum(co_) || co_ <= 0) co_ = 10e-6;
            // 6. Water properties (always needed for ct).
            var Bw  = _isFiniteNum(s.Bw)   ? s.Bw   : Bw_meehan(P, T);
            var mu_w_ = _isFiniteNum(s.mu_w)? s.mu_w : mu_w_meehan(T, s.salinity_ppm);
            var cw_   = _isFiniteNum(s.cw) ? s.cw   : cw_dodson(P, T, s.Rsw);
            // 7. Phase saturations.
            // Above bubble point — no free gas.
            var Sw   = _isFiniteNum(s.Sw)  ? s.Sw  : 0.20;
            var Sg, So;
            if (P >= Pb) {
                Sg = 0;
                So = 1 - Sw;
            } else {
                // Below bubble point — small free-gas saturation. Use a simple
                // approximation; user can override by setting cg directly.
                Sg = Math.min(0.10, 0.05);
                So = Math.max(0, 1 - Sw - Sg);
            }
            // 8. Gas compressibility (only matters if Sg > 0).
            var cg_ = (Sg > 0)
                ? (_isFiniteNum(s.cg) ? s.cg : 1 / Math.max(P, 1))
                : 0;
            // 9. Total compressibility.
            var ct_total = ct(So, co_, Sw, cw_, Sg, cg_, s.cf);

            c.Pb = Pb; c.Rs = Rs; c.Bo = Bo; c.mu_o = mu_o; c.co = co_;
            c.Sg = Sg; c.So = So; c.Sw_eff = Sw;
            c.ct = ct_total;
            c.mu = mu_o;
            c.B  = Bo;
            c.z  = null;

        } else if (s.fluidType === 'gas') {
            // 1. Pseudocriticals + reduced.
            var Tpc = Tpc_sutton(s.SG_g);
            var Ppc = Ppc_sutton(s.SG_g);
            var Tpr = (T + 459.67) / Tpc;
            var Ppr = P / Ppc;
            // 2. Z-factor.
            var Z = _isFiniteNum(s.Z) ? s.Z : Z_dranchukAbouKassem(Tpr, Ppr);
            // 3. Gas viscosity.
            var mu_g = _isFiniteNum(s.mu_g) ? s.mu_g : mu_g_leeGonzalezEakin(s.SG_g, T, Z, P);
            // 4. Bg.
            var Bg_ = _isFiniteNum(s.Bg) ? s.Bg : Bg(P, T, Z);
            // 5. cg.
            var cg_ = _isFiniteNum(s.cg) ? s.cg : cg_realGas(P, T, Z, s.SG_g);
            // 6. Water for ct.
            var cw_g = _isFiniteNum(s.cw) ? s.cw : cw_dodson(P, T, s.Rsw);
            var Sw_g = _isFiniteNum(s.Sw) ? s.Sw : 0.20;
            // 7. Saturations (gas reservoir): Sg = 1 − Sw, So = 0.
            var Sg_g = 1 - Sw_g;
            // 8. Total compressibility.
            var ct_total = ct(0, 0, Sw_g, cw_g, Sg_g, cg_, s.cf);

            c.cg = cg_; c.Bg = Bg_; c.mu_g = mu_g;
            c.So = 0; c.Sg = Sg_g; c.Sw_eff = Sw_g;
            c.z  = Z;
            c.ct = ct_total;
            c.mu = mu_g;
            c.B  = Bg_;     // RB/MSCF — note the unit!

        } else if (s.fluidType === 'water') {
            // Water producer / injector — single-phase water.
            var Bw_w = _isFiniteNum(s.Bw)  ? s.Bw  : Bw_meehan(P, T);
            var mu_w = _isFiniteNum(s.mu_w)? s.mu_w: mu_w_meehan(T, s.salinity_ppm);
            var cw_w = _isFiniteNum(s.cw)  ? s.cw  : cw_dodson(P, T, s.Rsw);
            // ct for full water: cw + cf
            var ct_total = ct(0, 0, 1, cw_w, 0, 0, s.cf);
            c.So = 0; c.Sg = 0; c.Sw_eff = 1;
            c.ct = ct_total;
            c.mu = mu_w;
            c.B  = Bw_w;
        }

        // Sanity-clip ct to a reasonable engineering range so a bogus correlation
        // can't poison downstream conversions. 1e-7 .. 5e-4 covers everything
        // from depleted gas to undersaturated oil to active aquifer.
        if (!_isFiniteNum(c.ct) || c.ct < 1e-7) c.ct = 1e-6;
        if (c.ct > 5e-4) c.ct = 5e-4;
        // A direct ct entry (C1) overrides the correlation sum.
        if (_isPos(s.ct)) c.ct = s.ct;

        s._computed = c;
        return c;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7b — EFFECTIVE FLUID PROPERTIES + C1 WRITER (setWell)
    // ═══════════════════════════════════════════════════════════════
    //
    // B, μ and ct used by every analysis: a direct entry (override) wins,
    // otherwise the correlation value from PRiSM_pvt_compute.

    function _fieldB(fl)  { return fl === 'gas' ? 'Bg'   : (fl === 'water' ? 'Bw'   : 'Bo'); }
    function _fieldMu(fl) { return fl === 'gas' ? 'mu_g' : (fl === 'water' ? 'mu_w' : 'mu_o'); }

    G.PRiSM_pvt_effective = function PRiSM_pvt_effective() {
        var s = G.PRiSM_pvt || (G.PRiSM_pvt = _loadFromStorage());
        var c = s._computed;
        if (!c || !c.timestamp) {
            try { c = G.PRiSM_pvt_compute(); } catch (e) { c = {}; }
        }
        c = c || {};
        var fl = s.fluidType || 'oil';
        var fB = _fieldB(fl), fM = _fieldMu(fl);
        return {
            fluid: fl, fieldB: fB, fieldMu: fM,
            B:  _isPos(s[fB]) ? s[fB] : c.B,
            mu: _isPos(s[fM]) ? s[fM] : c.mu,
            ct: _isPos(s.ct)  ? s.ct  : c.ct,
            overB: _isPos(s[fB]), overMu: _isPos(s[fM]), overCt: _isPos(s.ct),
            computed: c
        };
    };

    var WELL_FIELD_ALIAS = { pi: 'p_res', fluid: 'fluidType', T_F: 'T_res', sg: 'SG_g' };
    var TEST_TYPES = { auto: 1, drawdown: 1, buildup: 1, injection: 1, falloff: 1 };
    var FLUIDS = { oil: 1, gas: 1, water: 1 };
    var NULLABLE = { tp: 1, tShut: 1, pwf0: 1, ct: 1, Bo: 1, mu_o: 1, Bg: 1, mu_g: 1, Rs: 1, Pb: 1, co: 1, Z: 1, cg: 1 };
    var STORE_KEYS = (function () {
        var o = {}, d = _defaultPVT();
        for (var k in d) if (k !== '_computed' && k !== 'provenance') o[k] = 1;
        return o;
    })();

    function _fieldFor(key, fl) {
        if (key === 'B')  return _fieldB(fl);
        if (key === 'mu') return _fieldMu(fl);
        return WELL_FIELD_ALIAS[key] || key;
    }

    // PRiSM_setWell(patch, {source, origin}) — accepts C1 names (pi, q, B, mu,
    // ct, h, phi, rw, fluid, testType, tp, tShut, pwf0) and raw store names
    // (p_res, Bo, mu_o, …). null / '' clears a nullable field back to 'default'.
    // Fresh store defaults (used to reset inputs the demo sample had set).
    G.PRiSM_pvt_defaults = function PRiSM_pvt_defaults() {
        var d = _defaultPVT();
        delete d._computed; delete d.provenance;
        return d;
    };

    G.PRiSM_setWell = function PRiSM_setWell(patch, opts) {
        var s = G.PRiSM_pvt || (G.PRiSM_pvt = _loadFromStorage());
        if (!patch || typeof patch !== 'object') return s;
        opts = opts || {};
        var source = opts.source || 'user';
        if (!s.provenance || typeof s.provenance !== 'object') s.provenance = {};
        var changed = [];
        var fl = (patch.fluidType != null) ? patch.fluidType : patch.fluid;
        if (fl != null && FLUIDS[fl]) {
            s.fluidType = fl;
            s.provenance.fluidType = source;
            changed.push('fluidType');
        }
        for (var key in patch) {
            if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
            if (key === 'fluidType' || key === 'fluid') continue;
            var field = _fieldFor(key, s.fluidType);
            var v = patch[key];
            if (field === 'testType') {
                if (!TEST_TYPES[v]) continue;
                s.testType = v; s.provenance.testType = source; changed.push(field);
                continue;
            }
            if (field === 'qFromData') { s.qFromData = !!v; changed.push(field); continue; }
            if (!STORE_KEYS[field]) continue;
            if (v === null || v === '' || v === undefined) {
                if (NULLABLE[field]) { s[field] = null; s.provenance[field] = 'default'; changed.push(field); }
                continue;
            }
            if (typeof v === 'string') v = parseFloat(v);
            if (!_isFiniteNum(v)) continue;
            s[field] = v;
            s.provenance[field] = source;
            changed.push(field);
        }
        try { G.PRiSM_pvt_compute(); } catch (e) { /* keep store */ }
        _saveNow();
        _dispatch('prism:well-changed', { keys: changed, source: source, origin: opts.origin || null });
        return s;
    };

    // Mark defaulted inputs as accepted (provenance → 'user'). Correlation
    // values for B/μ/ct are written as direct entries so they stay fixed.
    G.PRiSM_acceptWellDefaults = function PRiSM_acceptWellDefaults(keys, opts) {
        var s = G.PRiSM_pvt || (G.PRiSM_pvt = _loadFromStorage());
        if (keys == null) {
            var w = (typeof G.PRiSM_getWell === 'function') ? G.PRiSM_getWell() : null;
            keys = (w && w.defaulted) ? w.defaulted : ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw', 'pi'];
        }
        if (typeof keys === 'string') keys = [keys];
        var eff = G.PRiSM_pvt_effective();
        var patch = {};
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var field = _fieldFor(k, s.fluidType);
            var v = s[field];
            if ((k === 'B' || k === 'mu' || k === 'ct') && !_isPos(v)) v = eff[k];
            if (_isFiniteNum(v)) patch[k] = v;
            else if (field === 'testType') patch[k] = s.testType;
        }
        return G.PRiSM_setWell(patch, { source: 'user', origin: (opts && opts.origin) || null });
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7c — PSEUDO-PRESSURE TABLE m(p)
    // ═══════════════════════════════════════════════════════════════
    //
    // 200-point table from 14.7 psia to pmax (default 1.2·pi), built by
    // cumulative Simpson integration of 2p/(μZ). Interpolation is cubic
    // Hermite with the exact slopes dm/dp = 2p/(μZ) > 0, so m(p) is
    // monotone. Cached per (T, SG, pmax).

    var _mpCache = {};
    G.PRiSM_mpTable = function PRiSM_mpTable(fluid) {
        fluid = fluid || {};
        var s = G.PRiSM_pvt || {};
        var T_F = _isFiniteNum(fluid.T_F) ? fluid.T_F : (_isFiniteNum(fluid.T_res) ? fluid.T_res : s.T_res);
        var sg  = _isFiniteNum(fluid.SG_g) ? fluid.SG_g : (_isFiniteNum(fluid.sg) ? fluid.sg : s.SG_g);
        var pi  = _isFiniteNum(fluid.pi) ? fluid.pi : (_isFiniteNum(fluid.p_res) ? fluid.p_res : s.p_res);
        var pmax = _isFiniteNum(fluid.pmax) ? fluid.pmax : 1.2 * (_isPos(pi) ? pi : 5000);
        var p0 = 14.7;
        if (!(pmax > 2 * p0)) pmax = 2 * p0 + 100;
        if (!_isFiniteNum(T_F) || !_isPos(sg)) throw new Error('PRiSM_mpTable: temperature and gas gravity are required');
        var key = T_F.toFixed(3) + '|' + sg.toFixed(5) + '|' + pmax.toFixed(2);
        if (_mpCache[key]) return _mpCache[key];

        var Tpc = Tpc_sutton(sg), Ppc = Ppc_sutton(sg);
        var Tpr = (T_F + 459.67) / Tpc;
        function f(P) {                      // dm/dp = 2p/(μ Z)
            if (!(P > 0)) return 0;
            var Z = Z_dranchukAbouKassem(Tpr, P / Ppc);
            var mu = mu_g_leeGonzalezEakin(sg, T_F, Z, P);
            if (!_isPos(Z) || !_isPos(mu)) return 0;
            return 2 * P / (mu * Z);
        }
        var N = 200;
        var p = new Array(N), m = new Array(N), d = new Array(N);
        var h = (pmax - p0) / (N - 1);
        p[0] = p0;
        m[0] = m_p(p0, T_F, sg);
        d[0] = f(p0);
        for (var i = 1; i < N; i++) {
            p[i] = p0 + i * h;
            d[i] = f(p[i]);
            var mid = f(p[i] - 0.5 * h);
            m[i] = m[i - 1] + (h / 6) * (d[i - 1] + 4 * mid + d[i]);
        }
        function mOf(P) {
            if (!_isFiniteNum(P)) return NaN;
            if (P <= p0) return m[0] * (P > 0 ? (P / p0) * (P / p0) : 0);
            if (P >= pmax) return m[N - 1] + d[N - 1] * (P - pmax);
            var j = Math.min(N - 2, Math.floor((P - p0) / h));
            var u = (P - p[j]) / h, u2 = u * u, u3 = u2 * u;
            return (2 * u3 - 3 * u2 + 1) * m[j] + (u3 - 2 * u2 + u) * h * d[j] +
                   (-2 * u3 + 3 * u2) * m[j + 1] + (u3 - u2) * h * d[j + 1];
        }
        function pOf(M) {
            if (!_isFiniteNum(M)) return NaN;
            if (M <= m[0]) return M > 0 ? p0 * Math.sqrt(M / m[0]) : 0;
            if (M >= m[N - 1]) return pmax + (M - m[N - 1]) / d[N - 1];
            var lo = 0, hi = N - 1;
            while (hi - lo > 1) { var md = (lo + hi) >> 1; if (m[md] <= M) lo = md; else hi = md; }
            var a = p[lo], b = p[lo + 1];
            for (var it = 0; it < 60; it++) {
                var c = 0.5 * (a + b);
                if (mOf(c) < M) a = c; else b = c;
                if (b - a < 1e-9 * pmax) break;
            }
            return 0.5 * (a + b);
        }
        var tbl = { T_F: T_F, SG_g: sg, pmin: p0, pmax: pmax, n: N, p: p, m: m, dmdp: d, mOf: mOf, pOf: pOf };
        _mpCache[key] = tbl;
        return tbl;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — DIMENSIONAL CONVERSION (dimensionless → real)
    // ═══════════════════════════════════════════════════════════════
    //
    // Field-unit conversion formulas (Earlougher, SPE Mono 5):
    //   C  (bbl/psi) = Cd · φ · ct · h · rw² / 0.8936
    //   Δp (psi)     = pd · 141.2 · q · B · μ / (k · h)      (gas Δm: 1422 q T/(kh))
    //   tD           = 0.0002637 · k · t / (φ · μ · ct · rw²)
    //   rinv (ft)    = √(k · t / (948 · φ · μ · ct))
    //
    // k comes from, in order: a caller-supplied k/kh; the last fit's physical
    // result (lastFit.phys.k); the semilog analysis (st.semilog kh/k/m); a
    // least-squares fit of k over every analysed point (PRiSM_getAnalysisData
    // Δp with the given dimensionless parameters held).

    var BOUNDARY_PARAM_KEYS = {
        dF: true, dF1: true, dF2: true, dEnd: true,
        dN: true, dS: true, dE: true, dW: true,
        L:  true, L_to_h: true
    };
    var FRACTURE_PARAM_KEYS = {
        xf: true, xfD: true, hf_to_h: true
    };

    function _wellForDim() {
        if (typeof G.PRiSM_getWell === 'function') {
            try { var w = G.PRiSM_getWell(); if (w) return w; } catch (e) { /* fallback */ }
        }
        var s = G.PRiSM_pvt || {};
        var eff = G.PRiSM_pvt_effective();
        return {
            fluid: eff.fluid, q: s.q, B: eff.B, mu: eff.mu, ct: eff.ct, h: s.h, phi: s.phi, rw: s.rw,
            T_R: _isFiniteNum(s.T_res) ? s.T_res + 459.67 : null
        };
    }

    // Least-squares k with the dimensionless parameters held (1-D search on log k).
    function _lsK(modelKey, fittedParams, well, adata) {
        if (typeof G.PRiSM_physicalModel !== 'function' || !adata || !adata.ok) return null;
        var pm;
        try { pm = G.PRiSM_physicalModel(modelKey, well, adata, { mode: 'physical' }); } catch (e) { return null; }
        if (!pm || !pm.ok || pm.mode !== 'physical') return null;
        var base = {};
        for (var k in fittedParams) if (Object.prototype.hasOwnProperty.call(fittedParams, k)) base[k] = fittedParams[k];
        var Lref = well.rw;
        if (pm.refLength !== 'rw') {
            Lref = _isPos(fittedParams[pm.refLength]) ? fittedParams[pm.refLength]
                 : (_isPos(fittedParams[pm.refLength + '_ft']) ? fittedParams[pm.refLength + '_ft'] : null);
            if (!_isPos(Lref)) return null;
            base[pm.refLength] = Lref;
        }
        if (pm.hasCd) {
            if (!_isPos(fittedParams.Cd)) return null;
            base.C = fittedParams.Cd * well.phi * well.ct * well.h * Lref * Lref / 0.8936;
        }
        if (pm.hasS) base.S = _isFiniteNum(fittedParams.S) ? fittedParams.S : 0;
        var t = adata.t, y = adata.dp;
        function sse(lk) {
            var ph = {};
            for (var kk in base) ph[kk] = base[kk];
            ph.k = Math.pow(10, lk);
            var m = pm.dp(t, ph), s2 = 0, n = 0;
            for (var i = 0; i < t.length; i++) {
                if (!_isFiniteNum(m[i])) continue;
                var r = y[i] - m[i];
                s2 += r * r; n++;
            }
            return n >= Math.max(3, 0.5 * t.length) ? s2 / n : Infinity;
        }
        var best = null, bestV = Infinity;
        for (var lk = -3; lk <= 5.0001; lk += 0.125) {
            var v = sse(lk);
            if (v < bestV) { bestV = v; best = lk; }
        }
        if (best == null || !isFinite(bestV)) return null;
        var a = best - 0.125, b = best + 0.125, gr = 0.6180339887498949;
        var c = b - gr * (b - a), d = a + gr * (b - a), fc = sse(c), fd = sse(d);
        for (var it = 0; it < 50 && (b - a) > 1e-7; it++) {
            if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = sse(c); }
            else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = sse(d); }
        }
        var lkBest = 0.5 * (a + b);
        return { k: Math.pow(10, lkBest), rmse: Math.sqrt(sse(lkBest)), pRefSource: adata.pRefSource };
    }

    G.PRiSM_dimensionalize = function PRiSM_dimensionalize(modelKey, fittedParams) {
        fittedParams = fittedParams || {};
        if (!G.PRiSM_pvt) G.PRiSM_pvt = _loadFromStorage();
        var pvt = G.PRiSM_pvt;
        var well = _wellForDim();
        var phi = well.phi, ct_ = well.ct, mu = well.mu, B = well.B, h = well.h, rw = well.rw, q = well.q;
        if (!_isPos(ct_) || !_isPos(mu) || !_isPos(B)) {
            return { ok: false, caveats: ['Fluid properties B, μ and ct are not available — enter them in Well & Test or use "Estimate from PVT…".'] };
        }
        var caveats = [];
        if (!(_isFiniteNum(phi) && phi > 0 && phi < 1))   caveats.push('Porosity φ out of range — check input.');
        if (!(_isFiniteNum(h)   && h > 0))                caveats.push('Pay h must be > 0.');
        if (!(_isFiniteNum(rw)  && rw > 0))               caveats.push('Wellbore radius rw must be > 0.');
        if (!(_isFiniteNum(q)   && q > 0))                caveats.push('Rate q must be > 0.');
        if (well.defaulted && well.defaulted.length) {
            caveats.push('Defaulted inputs (not yet confirmed): ' + well.defaulted.join(', ') + '.');
        }

        var Cd = _isFiniteNum(fittedParams.Cd) ? fittedParams.Cd : null;
        var S  = _isFiniteNum(fittedParams.S)  ? fittedParams.S  : null;

        var k_md = null, kh_md_ft = null, kSource = 'unknown', pRefSource = null;
        var adata = null;
        if (typeof G.PRiSM_getAnalysisData === 'function') {
            try { adata = G.PRiSM_getAnalysisData(); } catch (e) { adata = null; }
            if (adata && adata.ok) pRefSource = adata.pRefSource;
        }
        var gasPseudo = !!(adata && adata.ok && adata.pseudo);
        var st = G.PRiSM_state || {};
        var lf = st.lastFit || null;
        var sl = st.semilog || null;

        if (_isFiniteNum(fittedParams.kh_md_ft)) {
            kh_md_ft = fittedParams.kh_md_ft; k_md = kh_md_ft / h; kSource = 'caller-supplied kh';
        } else if (_isFiniteNum(fittedParams.k_md)) {
            k_md = fittedParams.k_md; kh_md_ft = k_md * h; kSource = 'caller-supplied k';
        } else if (lf && lf.phys && _isPos(lf.phys.k) && (!modelKey || !lf.modelKey || lf.modelKey === modelKey)) {
            k_md = lf.phys.k; kh_md_ft = k_md * h; kSource = 'fit (' + (lf.source || 'regression') + ')';
            if (lf.pRefSource) pRefSource = lf.pRefSource;
        } else if (sl && (_isPos(sl.kh) || _isPos(sl.k) || (_isFiniteNum(sl.m) && sl.m !== 0))) {
            if (_isPos(sl.kh)) kh_md_ft = sl.kh;
            else if (_isPos(sl.k)) kh_md_ft = sl.k * h;
            else kh_md_ft = (gasPseudo || sl.pseudo) ? 1637 * q * well.T_R / Math.abs(sl.m)
                                                     : 162.6 * q * B * mu / Math.abs(sl.m);
            k_md = kh_md_ft / h; kSource = 'semilog';
        } else if (adata && adata.ok) {
            var ls = _lsK(modelKey, fittedParams, well, adata);
            if (ls && _isPos(ls.k)) {
                k_md = ls.k; kh_md_ft = k_md * h;
                kSource = 'least squares on Δp (dimensionless parameters held)';
                pRefSource = ls.pRefSource;
            } else {
                caveats.push('k could not be derived: the model could not be evaluated against the analysed data.');
            }
        } else {
            caveats.push('No measured data, fit result or semilog analysis — k cannot be derived.');
        }
        if (pRefSource && pRefSource !== 'pi' && pRefSource !== 'pwf0' && pRefSource !== 't0-row') {
            caveats.push('Δp reference is "' + pRefSource + '" (pi not set): skin-dependent results are biased.');
        }

        // Real wellbore storage (bbl/psi).
        var Cs_bbl_per_psi = null;
        if (_isFiniteNum(Cd)) Cs_bbl_per_psi = Cd * phi * ct_ * h * rw * rw / 0.8936;

        // Boundary distances (ft) — dimensionless distances are in rw units.
        var distances = {};
        for (var pk in fittedParams) {
            if (BOUNDARY_PARAM_KEYS[pk] && _isFiniteNum(fittedParams[pk])) {
                if (pk === 'L_to_h') continue;
                distances[pk + '_ft'] = fittedParams[pk] * rw;
            }
        }
        // Fracture half-length (ft).
        var fractures = {};
        for (var fk in fittedParams) {
            if (FRACTURE_PARAM_KEYS[fk] && _isFiniteNum(fittedParams[fk])) {
                if (fk === 'hf_to_h' && _isFiniteNum(h)) fractures.hf_ft = fittedParams[fk] * h;
                else fractures[fk + '_ft'] = fittedParams[fk] * rw;
            }
        }

        // Radius of investigation at the end of the analysed period.
        var rinv_ft = null;
        if (_isPos(k_md)) {
            var tEnd = null;
            if (adata && adata.ok && adata.t.length) tEnd = Math.max.apply(null, adata.t);
            else if (G.PRiSM_dataset && G.PRiSM_dataset.t && G.PRiSM_dataset.t.length) tEnd = G.PRiSM_dataset.t[G.PRiSM_dataset.t.length - 1];
            if (_isPos(tEnd)) rinv_ft = Math.sqrt(k_md * tEnd / (948 * phi * mu * ct_));
        }

        var out = {
            ok: true,
            modelKey: modelKey,
            fluidType: well.fluid || pvt.fluidType,
            k:        _isFiniteNum(k_md)     ? k_md     : null,        // md
            kh:       _isFiniteNum(kh_md_ft) ? kh_md_ft : null,        // md·ft
            h: h, phi: phi, ct: ct_, mu: mu, B: B,
            S:        _isFiniteNum(S) ? S : null,
            Cs:       Cs_bbl_per_psi,                                   // bbl/psi
            C:        Cs_bbl_per_psi,
            Cd:       Cd,
            rinv:     rinv_ft,
            distances: distances,
            fractures: fractures,
            kSource:  kSource,
            pRefSource: pRefSource,
            dpMethod: gasPseudo ? 'pseudo-pressure m(p)' : 'real Δp',
            caveats:  caveats
        };
        if (_isFiniteNum(distances.dF_ft))  out.L  = distances.dF_ft;
        if (_isFiniteNum(distances.dF1_ft)) out.L1 = distances.dF1_ft;
        if (_isFiniteNum(distances.dF2_ft)) out.L2 = distances.dF2_ft;
        if (_isFiniteNum(fractures.xfD_ft)) out.xf = fractures.xfD_ft;
        if (_isFiniteNum(fractures.xf_ft))  out.xf = fractures.xf_ft;
        return out;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — INVERSE CONVERSION (real → dimensionless)
    // ═══════════════════════════════════════════════════════════════
    //   Cd = C · 0.8936 / (φ · ct · h · rw²)
    //   tD = 0.0002637 · k · t / (φ · μ · ct · rw²)          (per t)
    //   pD = k · h · Δp / (141.2 · q · B · μ)                 (per Δp)
    //   LD = L / rw

    G.PRiSM_nondimensionalize = function PRiSM_nondimensionalize(modelKey, realParams) {
        realParams = realParams || {};
        if (!G.PRiSM_pvt) G.PRiSM_pvt = _loadFromStorage();
        var pvt = G.PRiSM_pvt;
        var eff = G.PRiSM_pvt_effective();
        if (!_isPos(eff.ct) || !_isPos(eff.mu) || !_isPos(eff.B)) {
            return { ok: false, caveats: ['Fluid properties B, μ and ct are not available.'] };
        }
        var phi = pvt.phi, ct_ = eff.ct, mu = eff.mu, B = eff.B;
        var h   = _isFiniteNum(realParams.h) ? realParams.h : pvt.h;
        var rw  = pvt.rw;
        var q   = pvt.q;
        if (typeof G.PRiSM_getWell === 'function') {
            try { var w = G.PRiSM_getWell(); if (w && _isPos(w.q)) q = w.q; } catch (e) { /* keep store q */ }
        }
        var caveats = [];
        var k_md = realParams.k;
        if (!_isFiniteNum(k_md) || k_md <= 0) caveats.push('k must be > 0 in real units.');

        var Cd = null;
        var Creal = _isFiniteNum(realParams.C) ? realParams.C : realParams.Cs;
        if (_isFiniteNum(Creal)) Cd = Creal * 0.8936 / (phi * ct_ * h * rw * rw);
        var S = _isFiniteNum(realParams.S) ? realParams.S : null;

        var LD = {};
        ['L', 'dF', 'dF1', 'dF2', 'dEnd', 'dN', 'dS', 'dE', 'dW'].forEach(function (kk) {
            if (_isFiniteNum(realParams[kk])) LD[kk + 'D'] = realParams[kk] / rw;
            if (_isFiniteNum(realParams[kk + '_ft'])) LD[kk + 'D'] = realParams[kk + '_ft'] / rw;
        });
        var xfD = null;
        if (_isFiniteNum(realParams.xf)) xfD = realParams.xf / rw;
        if (_isFiniteNum(realParams.xf_ft)) xfD = realParams.xf_ft / rw;

        var out = {
            ok: true, modelKey: modelKey, Cd: Cd, S: S, xfD: xfD,
            k_md: _isFiniteNum(k_md) ? k_md : null,
            tdPerHour: (_isFiniteNum(k_md) && k_md > 0) ? 0.0002637 * k_md / (phi * mu * ct_ * rw * rw) : null,
            pdPerPsi:  (_isFiniteNum(k_md) && k_md > 0) ? k_md * h / (141.2 * q * mu * B) : null,
            caveats: caveats
        };
        for (var lk in LD) out[lk] = LD[lk];
        return out;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 10 — UI: "WELL & TEST" CARD (Tab 1 panel)
    // ═══════════════════════════════════════════════════════════════
    //
    // Styled with the host app's theme variables (--bg1, --bg2, --border,
    // --text, --text2, --text3, --accent, --green, --red, --yellow, --blue).
    // Responsive: auto-fill grid (2 columns at 375 px), inputs width 100 %.
    // Element ids: prism_well_<key>. Edits commit on 'change' through
    // PRiSM_setWell (fires 'prism:well-changed').

    var PVT_THEME = {
        bg:     'var(--bg1, #0d1117)',
        panel:  'var(--bg2, #161b22)',
        border: 'var(--border, #30363d)',
        text:   'var(--text, #c9d1d9)',
        muted:  'var(--text2, #8b949e)',
        text3:  'var(--text3, #6e7681)',
        accent: 'var(--accent, #58a6ff)',
        warn:   'var(--yellow, #d29922)',
        ok:     'var(--green, #3fb950)',
        bad:    'var(--red, #f85149)',
        blue:   'var(--blue, #58a6ff)'
    };

    function _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    // Correlation inputs shown in the "Estimate from PVT…" drawer.
    var FIELDS = [
        { key: 'T_res', label: 'Reservoir temperature', units: '°F',     group: 'reservoir', fluids: '*',     step: 1 },
        { key: 'cf',    label: 'Rock compressibility cf', units: '1/psi', group: 'reservoir', fluids: '*',   step: 1e-7 },
        { key: 'API',   label: 'Oil gravity',          units: '°API',    group: 'oil', fluids: 'oil', step: 0.1, min: 5, max: 60 },
        { key: 'SG_g',  label: 'Solution-gas SG',      units: 'air=1',   group: 'oil', fluids: 'oil', step: 0.01 },
        { key: 'Rs',    label: 'Solution GOR Rs',      units: 'SCF/STB', group: 'oil', fluids: 'oil', step: 1, allowNull: true },
        { key: 'Pb',    label: 'Bubble point Pb',      units: 'psia',    group: 'oil', fluids: 'oil', step: 1, allowNull: true },
        { key: 'co',    label: 'Oil compressibility co', units: '1/psi', group: 'oil', fluids: 'oil', step: 1e-7, allowNull: true },
        { key: 'SG_g',  label: 'Gas SG',               units: 'air=1',   group: 'gas', fluids: 'gas', step: 0.01 },
        { key: 'Z',     label: 'Z-factor',             units: '-',       group: 'gas', fluids: 'gas', step: 0.001, allowNull: true },
        { key: 'cg',    label: 'Gas compressibility cg', units: '1/psi', group: 'gas', fluids: 'gas', step: 1e-6, allowNull: true },
        { key: 'Sw',    label: 'Water saturation Sw',  units: '-',       group: 'water', fluids: '*', step: 0.01, min: 0, max: 1 },
        { key: 'cw',    label: 'Water compressibility cw', units: '1/psi', group: 'water', fluids: '*', step: 1e-7 },
        { key: 'salinity_ppm', label: 'Salinity',      units: 'ppm',     group: 'water', fluids: '*', step: 100 }
    ];
    var GROUP_ORDER = {
        oil:   ['reservoir', 'oil',   'water'],
        gas:   ['reservoir', 'gas',   'water'],
        water: ['reservoir', 'water']
    };
    var GROUP_LABELS = { reservoir: 'Reservoir', oil: 'Oil', gas: 'Gas', water: 'Water' };

    var PROV_STYLE = {
        'default':     { label: 'default',  color: PVT_THEME.warn },
        sample:        { label: 'sample',   color: PVT_THEME.blue },
        dataset:       { label: 'from data', color: PVT_THEME.blue },
        correlation:   { label: 'PVT',      color: PVT_THEME.accent },
        deconvolution: { label: 'deconv.',  color: PVT_THEME.accent }
    };

    var S_INPUT  = 'width:100%; box-sizing:border-box; min-width:0; padding:6px 8px; background:' + PVT_THEME.bg + '; color:' + PVT_THEME.text +
                   '; border:1px solid ' + PVT_THEME.border + '; border-radius:4px; font-family:monospace; font-size:13px;';
    var S_LABEL  = 'display:flex; flex-direction:column; gap:3px; min-width:0; font-size:11px; color:' + PVT_THEME.muted + ';';
    var S_GRID   = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:10px;';
    var S_SECT   = 'font-weight:600; font-size:11px; color:' + PVT_THEME.accent + '; margin:12px 0 6px; text-transform:uppercase; letter-spacing:0.5px;';
    var S_BTN    = 'padding:6px 12px; background:' + PVT_THEME.panel + '; color:' + PVT_THEME.text + '; border:1px solid ' + PVT_THEME.border +
                   '; border-radius:4px; cursor:pointer; font-size:12px; min-height:32px;';
    var S_BTN_SM = 'padding:1px 7px; background:transparent; color:' + PVT_THEME.warn + '; border:1px solid ' + PVT_THEME.warn +
                   '; border-radius:10px; cursor:pointer; font-size:10px; line-height:16px;';

    function _badgeHTML(key, prov) {
        if (!prov || prov === 'user') return '';
        var st = PROV_STYLE[prov] || { label: prov, color: PVT_THEME.text3 };
        var html = '<span class="prism-prov prism-prov--' + _esc(prov) + '" data-prov="' + _esc(prov) + '"' +
                   ' style="border:1px solid ' + st.color + '; color:' + st.color +
                   '; border-radius:10px; padding:0 6px; font-size:10px; line-height:16px; white-space:nowrap;">' + _esc(st.label) + '</span>';
        if (prov === 'default') {
            html += ' <button type="button" class="prism-accept" data-well-accept="' + _esc(key) + '" style="' + S_BTN_SM + '"' +
                    ' title="Confirm this value">Accept</button>';
        }
        return html;
    }

    function _cardContext() {
        var pvt = G.PRiSM_pvt || (G.PRiSM_pvt = _loadFromStorage());
        var w = null, ad = null;
        if (typeof G.PRiSM_getWell === 'function') { try { w = G.PRiSM_getWell(); } catch (e) { w = null; } }
        if (!w) {
            var eff = G.PRiSM_pvt_effective();
            var pv = pvt.provenance || {};
            w = { fluid: eff.fluid, q: pvt.q, B: eff.B, mu: eff.mu, ct: eff.ct, h: pvt.h, phi: pvt.phi, rw: pvt.rw,
                  pi: pv.p_res && pv.p_res !== 'default' ? pvt.p_res : null, testType: pvt.testType || 'auto',
                  qFromData: pvt.qFromData !== false, qData: null,
                  provenance: { q: pv.q || 'default', B: eff.overB ? (pv[eff.fieldB] || 'default') : 'default',
                                mu: eff.overMu ? (pv[eff.fieldMu] || 'default') : 'default',
                                ct: eff.overCt ? (pv.ct || 'default') : 'default',
                                h: pv.h || 'default', phi: pv.phi || 'default', rw: pv.rw || 'default', pi: pv.p_res || 'default' },
                  missing: [], defaulted: [] };
            ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'].forEach(function (k) {
                if (!_isPos(w[k])) w.missing.push(k);
                if (w.provenance[k] === 'default') w.defaulted.push(k);
            });
            if (w.provenance.pi === 'default') w.defaulted.push('pi');
            w.complete = !w.missing.length;
        }
        if (typeof G.PRiSM_getAnalysisData === 'function' && G.PRiSM_dataset) {
            try { ad = G.PRiSM_getAnalysisData(); } catch (e2) { ad = null; }
        }
        return { pvt: pvt, w: w, ad: ad, eff: G.PRiSM_pvt_effective() };
    }

    var CARD = { host: null, drawerOpen: false };   // mounted card host + drawer state

    var TT_LABEL = { drawdown: 'Drawdown', buildup: 'Buildup', injection: 'Injection', falloff: 'Falloff', auto: 'Auto-detect' };

    function _chipHTML(ctx) {
        var set = ctx.pvt.testType || 'auto';
        var res = (ctx.ad && ctx.ad.ok) ? ctx.ad.testType : (ctx.w.testTypeResolved || null);
        var label = res ? (TT_LABEL[res] || res) : (set === 'auto' ? 'Test type: auto' : (TT_LABEL[set] || set));
        var sub = (set === 'auto') ? ' · detected' : ' · set';
        return '<span id="prism_well_testtype_chip" class="prism-chip" data-testtype="' + _esc(res || set) + '"' +
               ' style="display:inline-block; padding:2px 10px; border-radius:12px; font-size:12px; font-weight:600;' +
               ' background:' + PVT_THEME.bg + '; color:' + PVT_THEME.accent + '; border:1px solid ' + PVT_THEME.accent + ';">' +
               _esc(label) + '<span style="font-weight:400; color:' + PVT_THEME.muted + ';">' + (res ? sub : '') + '</span></span>';
    }

    function _summaryHTML(ctx) {
        var w = ctx.w;
        var main = w.complete
            ? '<span style="color:' + PVT_THEME.ok + ';">Well inputs complete ✓</span>'
            : '<span style="color:' + PVT_THEME.bad + ';">Missing: ' + _esc(w.missing.join(', ')) + '</span>';
        var nDef = (w.defaulted || []).length;
        var extra = '';
        if (nDef) {
            extra = ' <span style="color:' + PVT_THEME.warn + ';">· ' + nDef + ' default' + (nDef > 1 ? 's' : '') +
                    ' to review (' + _esc(w.defaulted.join(', ')) + ')</span>' +
                    ' <button type="button" id="prism_well_accept_all" style="' + S_BTN_SM + '">Accept all</button>';
        }
        return main + extra;
    }

    function _notesHTML(ctx) {
        var ad = ctx.ad;
        if (!ad) return '';
        var list = ad.ok ? (ad.warnings || []) : [ad.reason].concat(ad.warnings || []);
        list = list.filter(Boolean).slice(0, 3);
        if (!list.length) return '';
        return list.map(function (m) {
            return '<div style="color:' + PVT_THEME.warn + '; font-size:11px; margin-top:4px; overflow-wrap:anywhere;">⚠ ' + _esc(m) + '</div>';
        }).join('');
    }

    function _autoText(key, ctx) {
        var ad = ctx.ad;
        if (!ad || !ad.ok) return '';
        var isShut = ad.testType === 'buildup' || ad.testType === 'falloff';
        if (key === 'tp')    return isShut ? (_isPos(ad.tp) ? 'auto: ' + _fmtSig(ad.tp, 4) + ' h (from data)' : 'needed for buildups') : 'buildups only';
        if (key === 'tShut') return isShut ? 'auto: ' + _fmtSig(ad.tShut, 4) + ' h (from data)' : 'buildups only';
        if (key === 'pwf0')  return isShut ? 'auto: ' + _fmtSig(ad.pwf0, 5) + ' psia (from data)' : 'buildups only';
        return '';
    }

    function _numField(key, label, unit, value, opts) {
        opts = opts || {};
        var v = _isFiniteNum(value) ? String(value) : '';
        return '<label style="' + S_LABEL + '">' +
               '<span style="display:flex; flex-wrap:wrap; align-items:center; gap:4px;">' +
                 '<span>' + label + ' <span style="color:' + PVT_THEME.text3 + ';">(' + unit + ')</span></span>' +
                 '<span data-badge-for="' + key + '">' + _badgeHTML(key, opts.prov) + '</span>' +
               '</span>' +
               '<input type="number" inputmode="decimal" id="prism_well_' + key + '" data-well-key="' + key + '"' +
                 ' value="' + _esc(v) + '"' + (opts.step != null ? ' step="' + opts.step + '"' : '') +
                 ' placeholder="' + _esc(opts.placeholder || '') + '"' + (opts.disabled ? ' disabled' : '') +
                 ' style="' + S_INPUT + (opts.disabled ? ' opacity:0.7;' : '') + '">' +
               '</label>';
    }

    function _selectField(key, label, options, value, prov) {
        var html = '<label style="' + S_LABEL + '">' +
                   '<span style="display:flex; flex-wrap:wrap; align-items:center; gap:4px;"><span>' + label + '</span>' +
                   '<span data-badge-for="' + key + '">' + _badgeHTML(key, prov) + '</span></span>' +
                   '<select id="prism_well_' + key + '" data-well-key="' + key + '" style="' + S_INPUT + '">';
        for (var i = 0; i < options.length; i++) {
            html += '<option value="' + options[i][0] + '"' + (options[i][0] === value ? ' selected' : '') + '>' + options[i][1] + '</option>';
        }
        return html + '</select></label>';
    }

    function _renderDrawerInputsHTML(pvt) {
        var groups = GROUP_ORDER[pvt.fluidType] || GROUP_ORDER.oil;
        var html = '';
        for (var i = 0; i < groups.length; i++) {
            var grp = groups[i];
            var fields = FIELDS.filter(function (f) {
                return f.group === grp && (f.fluids === '*' || f.fluids === pvt.fluidType);
            });
            if (!fields.length) continue;
            html += '<div style="' + S_SECT + ' margin-top:8px;">' + GROUP_LABELS[grp] + '</div><div style="' + S_GRID + '">';
            for (var j = 0; j < fields.length; j++) {
                var f = fields[j], v = pvt[f.key];
                html += '<label style="' + S_LABEL + '"><span>' + f.label + ' <span style="color:' + PVT_THEME.text3 + ';">(' + f.units + ')</span></span>' +
                        '<input type="number" inputmode="decimal" data-pvt-field="' + f.key + '" value="' + (_isFiniteNum(v) ? v : '') + '"' +
                        (f.step != null ? ' step="' + f.step + '"' : '') + (f.allowNull ? ' placeholder="(auto)"' : '') +
                        ' style="' + S_INPUT + '"></label>';
            }
            html += '</div>';
        }
        return html;
    }

    function _renderComputedHTML(pvt) {
        var c = pvt._computed;
        if (!c || !c.timestamp) {
            return '<div style="color:' + PVT_THEME.muted + '; font-style:italic; font-size:12px;">Click <b>Compute</b> to evaluate the correlations.</div>';
        }
        var rows = [];
        rows.push(['Total compressibility ct', _fmtSig(c.ct, 4) + ' 1/psi']);
        rows.push(['Viscosity μ',              _fmtSig(c.mu, 4) + ' cp']);
        rows.push(['Formation volume factor B', _fmtSig(c.B,  4) + (c.fluidType === 'gas' ? ' RB/Mscf' : ' RB/STB')]);
        if (c.fluidType === 'gas') {
            rows.push(['Z-factor', _fmtSig(c.z, 4)]);
            rows.push(['cg', _fmtSig(c.cg, 4) + ' 1/psi']);
        } else if (c.fluidType === 'oil') {
            rows.push(['Pb (bubble point)', _fmtSig(c.Pb, 4) + ' psia']);
            rows.push(['Rs (solution GOR)', _fmtSig(c.Rs, 4) + ' SCF/STB']);
            rows.push(['co', _fmtSig(c.co, 4) + ' 1/psi']);
        }
        rows.push(['Saturations', 'So=' + _fmt(c.So, 3) + ' Sw=' + _fmt(c.Sw_eff, 3) + ' Sg=' + _fmt(c.Sg, 3)]);
        var html = '<table style="width:100%; font-size:12px; color:' + PVT_THEME.text + '; border-collapse:collapse;">';
        for (var i = 0; i < rows.length; i++) {
            html += '<tr><td style="padding:3px 8px 3px 0; color:' + PVT_THEME.muted + ';">' + rows[i][0] + '</td>' +
                    '<td style="padding:3px 0; font-family:monospace; color:' + PVT_THEME.ok + '; overflow-wrap:anywhere;">' + rows[i][1] + '</td></tr>';
        }
        return html + '</table>';
    }

    function _renderDimResultHTML(d) {
        if (!d || !d.ok) {
            var msg = (d && d.caveats && d.caveats.length) ? d.caveats.join('  ') : 'No fit / no PVT.';
            return '<div style="color:' + PVT_THEME.warn + '; font-size:12px;">' + _esc(msg) + '</div>';
        }
        var rows = [];
        if (d.k != null)    rows.push(['Permeability k', _fmtSig(d.k, 4) + ' md']);
        if (d.kh != null)   rows.push(['kh', _fmtSig(d.kh, 4) + ' md·ft']);
        if (d.S  != null)   rows.push(['Skin S', _fmt(d.S, 2)]);
        if (d.Cs != null)   rows.push(['Wellbore storage C', _fmtSig(d.Cs, 4) + ' bbl/psi']);
        if (d.rinv != null) rows.push(['Radius of investigation', _fmtSig(d.rinv, 4) + ' ft']);
        for (var dk in d.distances) rows.push([dk.replace(/_ft$/, '') + ' (distance)', _fmtSig(d.distances[dk], 4) + ' ft']);
        for (var fk in d.fractures) rows.push([fk.replace(/_ft$/, ''), _fmtSig(d.fractures[fk], 4) + ' ft']);
        var html = '<table style="width:100%; font-size:12px; color:' + PVT_THEME.text + '; border-collapse:collapse;">';
        for (var i = 0; i < rows.length; i++) {
            html += '<tr><td style="padding:3px 8px 3px 0; color:' + PVT_THEME.muted + ';">' + rows[i][0] + '</td>' +
                    '<td style="padding:3px 0; font-family:monospace; color:' + PVT_THEME.accent + ';">' + rows[i][1] + '</td></tr>';
        }
        html += '</table>';
        if (d.kSource) html += '<div style="margin-top:6px; font-size:10px; color:' + PVT_THEME.text3 + ';">k source: ' + _esc(d.kSource) + '</div>';
        if (d.caveats && d.caveats.length) {
            html += '<div style="margin-top:6px; font-size:11px; color:' + PVT_THEME.warn + ';">' +
                    d.caveats.map(function (c) { return '⚠ ' + _esc(c); }).join('<br>') + '</div>';
        }
        return html;
    }

    function _cardHTML(ctx) {
        var pvt = ctx.pvt, w = ctx.w, eff = ctx.eff, prov = w.provenance || {};
        var fl = pvt.fluidType || 'oil';
        var qUnit = fl === 'gas' ? 'Mscf/d' : 'STB/d';
        var bUnit = fl === 'gas' ? 'RB/Mscf' : 'RB/STB';
        var c = eff.computed || {};
        var qData = _isPos(w.qData) ? w.qData : null;
        var qFromData = pvt.qFromData !== false && qData != null;
        var html = '';
        html += '<div id="prism_well_card" class="prism-well-card" style="color:' + PVT_THEME.text + '; font-size:13px; min-width:0; max-width:100%; overflow-wrap:anywhere;">';
        // Header: chip + summary + notes.
        html += '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">' +
                  '<span data-well-chip>' + _chipHTML(ctx) + '</span>' +
                  '<span id="prism_well_summary" style="font-size:12px;">' + _summaryHTML(ctx) + '</span>' +
                '</div>';
        html += '<div id="prism_well_notes">' + _notesHTML(ctx) + '</div>';

        // Test.
        html += '<div style="' + S_SECT + '">Test</div><div style="' + S_GRID + '">';
        html += _selectField('testType', 'Test type',
                             [['auto', 'Auto-detect'], ['drawdown', 'Drawdown'], ['buildup', 'Buildup'],
                              ['injection', 'Injection'], ['falloff', 'Falloff']], pvt.testType || 'auto', null);
        html += _numField('pi', 'Initial reservoir pressure pi', 'psia', pvt.p_res, { prov: prov.pi, step: 1 });
        html += _numField('tp', 'Producing time tp', 'h', pvt.tp, { placeholder: _autoText('tp', ctx), step: 'any' });
        html += _numField('tShut', 'Shut-in time', 'h', pvt.tShut, { placeholder: _autoText('tShut', ctx), step: 'any' });
        html += _numField('pwf0', 'pwf at shut-in', 'psia', pvt.pwf0, { placeholder: _autoText('pwf0', ctx), step: 'any' });
        html += '</div>';

        // Well.
        html += '<div style="' + S_SECT + '">Well</div><div style="' + S_GRID + '">';
        html += '<div style="display:flex; flex-direction:column; gap:3px; min-width:0;">' +
                  _numField('q', 'Rate q', qUnit, qFromData ? qData : pvt.q,
                            { prov: prov.q, step: 'any', disabled: qFromData, placeholder: qFromData ? '' : 'rate before shut-in' }) +
                  '<label style="font-size:11px; color:' + PVT_THEME.muted + '; display:flex; align-items:center; gap:4px;">' +
                    '<input type="checkbox" id="prism_well_q_fromdata"' + (pvt.qFromData !== false ? ' checked' : '') + '> from data' +
                    (qData == null ? ' <span style="color:' + PVT_THEME.text3 + ';">(no rate column)</span>' : '') +
                  '</label>' +
                '</div>';
        html += _numField('rw', 'Wellbore radius rw', 'ft', pvt.rw, { prov: prov.rw, step: 'any' });
        html += _numField('h', 'Net pay h', 'ft', pvt.h, { prov: prov.h, step: 'any' });
        html += _numField('phi', 'Porosity φ', 'fraction', pvt.phi, { prov: prov.phi, step: 'any' });
        html += '</div>';

        // Fluid.
        html += '<div style="' + S_SECT + '">Fluid</div><div style="' + S_GRID + '">';
        html += _selectField('fluidType', 'Fluid', [['oil', 'Oil'], ['gas', 'Gas'], ['water', 'Water']], fl, null);
        html += _numField('B', 'Formation volume factor B', bUnit, eff.overB ? pvt[eff.fieldB] : null,
                          { prov: prov.B, step: 'any', placeholder: _isPos(c.B) ? 'auto: ' + _fmtSig(c.B, 4) + ' (PVT)' : '' });
        html += _numField('mu', 'Viscosity μ', 'cp', eff.overMu ? pvt[eff.fieldMu] : null,
                          { prov: prov.mu, step: 'any', placeholder: _isPos(c.mu) ? 'auto: ' + _fmtSig(c.mu, 4) + ' (PVT)' : '' });
        html += _numField('ct', 'Total compressibility ct', '1/psi', eff.overCt ? pvt.ct : null,
                          { prov: prov.ct, step: 'any', placeholder: _isPos(c.ct) ? 'auto: ' + _fmtSig(c.ct, 3) + ' (PVT)' : '' });
        html += '</div>';
        html += '<div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;">' +
                  '<button type="button" id="prism_well_pvt_btn" style="' + S_BTN + '" aria-expanded="' + (CARD.drawerOpen ? 'true' : 'false') + '">' +
                    (CARD.drawerOpen ? 'Hide PVT estimate' : 'Estimate from PVT…') + '</button>' +
                '</div>';

        // Drawer (correlations + dimensional check).
        html += '<div id="prism_well_pvt_drawer" style="margin-top:10px; padding:10px; border:1px solid ' + PVT_THEME.border +
                '; border-radius:6px; background:' + PVT_THEME.bg + ';' + (CARD.drawerOpen ? '' : ' display:none;') + '">';
        html += '<div style="font-size:12px; color:' + PVT_THEME.muted + ';">Correlations at pi and reservoir temperature. ' +
                '"Use estimates" copies B, μ and ct into the fields above.</div>';
        html += '<div data-pvt-inputs>' + _renderDrawerInputsHTML(pvt) + '</div>';
        html += '<div style="display:flex; flex-wrap:wrap; gap:8px; margin:10px 0;">' +
                  '<button type="button" data-pvt-act="compute" style="' + S_BTN + '">Compute</button>' +
                  '<button type="button" id="prism_well_pvt_use" style="' + S_BTN + '">Use estimates for B, μ, ct</button>' +
                  '<button type="button" data-pvt-act="apply" style="' + S_BTN + '">Convert current fit</button>' +
                  '<button type="button" data-pvt-act="reset" style="' + S_BTN + '">Reset to defaults</button>' +
                '</div>';
        html += '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">' +
                  '<div data-pvt-computed>' + _renderComputedHTML(pvt) + '</div>' +
                  '<div data-pvt-dim><div style="color:' + PVT_THEME.muted + '; font-size:12px; font-style:italic;">' +
                    '"Convert current fit" turns the latest dimensionless fit into field units.</div></div>' +
                '</div>';
        html += '</div>';
        html += '</div>';
        return html;
    }

    function _attached(el) {
        if (!el) return false;
        if (typeof el.isConnected === 'boolean') return el.isConnected;
        var n = el;
        while (n) { if (typeof document !== 'undefined' && n === document) return true; n = n.parentNode; }
        return false;
    }

    // In-place refresh of badges, summary, chip, notes and placeholders
    // (keeps focus in the field being edited).
    function _refreshMeta(host) {
        if (!host || !host.querySelector) return;
        var ctx = _cardContext();
        var prov = ctx.w.provenance || {};
        var badges = host.querySelectorAll('[data-badge-for]');
        for (var i = 0; i < badges.length; i++) {
            var key = badges[i].getAttribute('data-badge-for');
            badges[i].innerHTML = _badgeHTML(key, prov[key]);
        }
        var sum = host.querySelector('#prism_well_summary');
        if (sum) sum.innerHTML = _summaryHTML(ctx);
        var chip = host.querySelector('[data-well-chip]');
        if (chip) chip.innerHTML = _chipHTML(ctx);
        var notes = host.querySelector('#prism_well_notes');
        if (notes) notes.innerHTML = _notesHTML(ctx);
        var c = ctx.eff.computed || {};
        var ph = { B: _isPos(c.B) ? 'auto: ' + _fmtSig(c.B, 4) + ' (PVT)' : '',
                   mu: _isPos(c.mu) ? 'auto: ' + _fmtSig(c.mu, 4) + ' (PVT)' : '',
                   ct: _isPos(c.ct) ? 'auto: ' + _fmtSig(c.ct, 3) + ' (PVT)' : '',
                   tp: _autoText('tp', ctx), tShut: _autoText('tShut', ctx), pwf0: _autoText('pwf0', ctx) };
        for (var k in ph) {
            var inp = host.querySelector('#prism_well_' + k);
            if (inp) inp.setAttribute('placeholder', ph[k]);
        }
        var comp = host.querySelector('[data-pvt-computed]');
        if (comp) comp.innerHTML = _renderComputedHTML(ctx.pvt);
    }

    function _onChange(host, ev) {
        var el = ev && ev.target;
        if (!el || !el.getAttribute) return;
        if (el.id === 'prism_well_q_fromdata') {
            G.PRiSM_setWell({ qFromData: !!el.checked }, { source: 'user', origin: 'card-structure' });
            return;
        }
        var key = el.getAttribute('data-well-key');
        if (key) {
            var raw = el.value, patch = {};
            if (key === 'testType' || key === 'fluidType') {
                patch[key] = raw;
                G.PRiSM_setWell(patch, { source: 'user', origin: 'card-structure' });
                return;
            }
            var nullable = (key === 'tp' || key === 'tShut' || key === 'pwf0' || key === 'B' || key === 'mu' || key === 'ct');
            if (raw === '' || raw == null) {
                if (!nullable) { _refreshMeta(host); return; }
                patch[key] = null;
            } else {
                var v = parseFloat(raw);
                if (!_isFiniteNum(v)) return;
                patch[key] = v;
            }
            G.PRiSM_setWell(patch, { source: 'user', origin: 'card' });
            return;
        }
        var pkey = el.getAttribute('data-pvt-field');
        if (pkey) {
            var praw = el.value, pp = {};
            if (praw === '' || praw == null) pp[pkey] = null;
            else { var pv = parseFloat(praw); if (!_isFiniteNum(pv)) return; pp[pkey] = pv; }
            G.PRiSM_setWell(pp, { source: 'user', origin: 'card' });
        }
    }

    function _onClick(host, ev) {
        var el = ev && ev.target;
        if (!el || !el.closest) return;
        var acc = el.closest('[data-well-accept]');
        if (acc) {
            G.PRiSM_acceptWellDefaults([acc.getAttribute('data-well-accept')], { origin: 'card' });
            return;
        }
        if (el.closest('#prism_well_accept_all')) {
            G.PRiSM_acceptWellDefaults(null, { origin: 'card' });
            return;
        }
        if (el.closest('#prism_well_pvt_btn')) {
            CARD.drawerOpen = !CARD.drawerOpen;
            var dr = host.querySelector('#prism_well_pvt_drawer');
            if (dr) dr.style.display = CARD.drawerOpen ? '' : 'none';
            var b = host.querySelector('#prism_well_pvt_btn');
            if (b) {
                b.textContent = CARD.drawerOpen ? 'Hide PVT estimate' : 'Estimate from PVT…';
                b.setAttribute('aria-expanded', CARD.drawerOpen ? 'true' : 'false');
            }
            return;
        }
        if (el.closest('#prism_well_pvt_use')) {
            var c;
            try { c = G.PRiSM_pvt_compute(); } catch (e) { c = null; }
            if (c) {
                var patch = {};
                if (_isPos(c.B)) patch.B = c.B;
                if (_isPos(c.mu)) patch.mu = c.mu;
                if (_isPos(c.ct)) patch.ct = c.ct;
                G.PRiSM_setWell(patch, { source: 'correlation', origin: 'card' });
            }
            return;
        }
        var act = el.closest('[data-pvt-act]');
        if (!act) return;
        var a = act.getAttribute('data-pvt-act');
        if (a === 'compute') {
            try { G.PRiSM_pvt_compute(); } catch (e2) { /* shown as empty */ }
            var ch = host.querySelector('[data-pvt-computed]');
            if (ch) ch.innerHTML = _renderComputedHTML(G.PRiSM_pvt);
        } else if (a === 'apply') {
            var st = G.PRiSM_state || {};
            var modelKey = st.model, params = st.params || {};
            if (st.lastFit && st.lastFit.params) params = st.lastFit.params;
            if (st.lastFit && st.lastFit.modelKey) modelKey = st.lastFit.modelKey;
            var dim;
            try { dim = G.PRiSM_dimensionalize(modelKey, params); }
            catch (e3) { dim = { ok: false, caveats: ['Conversion failed: ' + (e3 && e3.message)] }; }
            var dh = host.querySelector('[data-pvt-dim]');
            if (dh) dh.innerHTML = _renderDimResultHTML(dim);
        } else if (a === 'reset') {
            G.PRiSM_pvt = _defaultPVT();
            try { G.PRiSM_pvt_compute(); } catch (e4) { /* ignore */ }
            _saveNow();
            _dispatch('prism:well-changed', { keys: ['*'], source: 'default', origin: 'card-structure' });
        }
    }

    G.PRiSM_renderPVTPanel = function PRiSM_renderPVTPanel(container) {
        if (!_hasDoc || !container) return;
        if (!G.PRiSM_pvt) G.PRiSM_pvt = _loadFromStorage();
        var ctx = _cardContext();
        container.innerHTML = _cardHTML(ctx);
        CARD.host = container;
        if (!container.__prismWellWired && container.addEventListener) {
            container.__prismWellWired = true;
            container.addEventListener('change', function (ev) { _onChange(container, ev); });
            container.addEventListener('click', function (ev) { _onClick(container, ev); });
        }
    };
    G.PRiSM_renderWellCard = G.PRiSM_renderPVTPanel;

    // One set of window listeners (registered once at load): keep the mounted
    // card in sync with store / dataset changes made elsewhere.
    if (_hasWin && typeof G.addEventListener === 'function' && !G.__PRiSM_wellCardListeners) {
        G.__PRiSM_wellCardListeners = true;
        G.addEventListener('prism:well-changed', function (ev) {
            var host = CARD.host;
            if (!host || !_attached(host)) return;
            var d = (ev && ev.detail) || {};
            if (d.origin === 'card') _refreshMeta(host);
            else G.PRiSM_renderPVTPanel(host);
        });
        G.addEventListener('prism:dataset-loaded', function () {
            var host = CARD.host;
            if (host && _attached(host)) G.PRiSM_renderPVTPanel(host);
        });
    }

    // Register the card as a Tab 1 panel (contract C7; merge, never replace).
    (function _registerWellPanel() {
        var spec = {
            id: 'prism_well_test', title: 'Well & Test', order: 10, collapsed: false,
            render: function (host) { G.PRiSM_renderPVTPanel(host); }
        };
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(1, spec); return; } catch (e) { /* fall back to direct merge */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var list = G.PRiSM_tabPanels[1] = G.PRiSM_tabPanels[1] || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === spec.id) { list[i] = spec; return; }
        }
        list.push(spec);
    })();


    // ═══════════════════════════════════════════════════════════════
    // SECTION 11 — INTERPRETATION ENRICHMENT HOOK
    // ═══════════════════════════════════════════════════════════════
    //
    // Wraps PRiSM_interpretFit (Agent K) by appending dimensional tags.
    // Falls back to the raw dimensionless interpretation if PVT isn't
    // computed yet.

    G.PRiSM_interpretFitWithPVT = function PRiSM_interpretFitWithPVT(modelKey, params, CI95, fitMeta) {
        var base = (typeof G.PRiSM_interpretFit === 'function')
                    ? G.PRiSM_interpretFit(modelKey, params, CI95, fitMeta)
                    : { tags: [], narrative: '', actions: [], cautions: [], confidence: null };

        var pvt = G.PRiSM_pvt;
        if (!pvt || !pvt._computed || !pvt._computed.timestamp) {
            base.cautions = (base.cautions || []).slice();
            base.cautions.push('Dimensional units unavailable — compute PVT to add real-units tags.');
            return base;
        }

        var dim = G.PRiSM_dimensionalize(modelKey, params);
        if (!dim || !dim.ok) {
            base.cautions = (base.cautions || []).slice();
            base.cautions.push('PVT computed but dimensional conversion failed: '
                              + ((dim && dim.caveats && dim.caveats.join('; ')) || 'unknown'));
            return base;
        }

        // Append dimensional tags. We keep the original tag schema simple:
        // { param, value, range, severity, prose }.
        var newTags = (base.tags || []).slice();

        function _push(param, value, units, sevHint, label) {
            newTags.push({
                param: param,
                value: value,
                units: units,
                range: [NaN, NaN],
                severity: sevHint,
                prose: (label || param) + ' = ' + _fmtSig(value, 4) + ' ' + units
            });
        }

        if (_isFiniteNum(dim.kh)) {
            var khSev = dim.kh > 5000 ? 'good'
                       : dim.kh > 500 ? 'normal'
                       : 'caution';
            var khLabel = dim.kh > 5000 ? 'kh (high productivity)'
                        : dim.kh > 500  ? 'kh'
                        : 'kh (low productivity)';
            _push('kh', dim.kh, 'md·ft', khSev, khLabel);
        }
        if (_isFiniteNum(dim.k)) {
            var kSev = dim.k > 100 ? 'good'
                      : dim.k > 1   ? 'normal'
                      : 'caution';
            var kLabel = dim.k > 100 ? 'k (high permeability)'
                       : dim.k > 1   ? 'k (moderate permeability)'
                       : 'k (low permeability)';
            _push('k', dim.k, 'md', kSev, kLabel);
        }
        if (_isFiniteNum(dim.Cs)) {
            _push('Cs', dim.Cs, 'bbl/psi', 'normal', 'real Cs');
        }
        if (_isFiniteNum(dim.rinv)) {
            _push('rinv', dim.rinv, 'ft', 'normal', 'radius of investigation');
        }
        for (var dk in dim.distances) {
            var v = dim.distances[dk];
            if (_isFiniteNum(v)) _push(dk, v, 'ft', 'normal', dk.replace(/_ft$/, ''));
        }
        for (var fk in dim.fractures) {
            var fv = dim.fractures[fk];
            if (_isFiniteNum(fv)) _push(fk, fv, 'ft', 'normal', fk.replace(/_ft$/, ''));
        }

        base.tags = newTags;

        // Append a one-line dimensional summary onto the narrative.
        var summary = [];
        if (_isFiniteNum(dim.k))    summary.push('k ≈ '   + _fmtSig(dim.k, 3)   + ' md');
        if (_isFiniteNum(dim.kh))   summary.push('kh ≈ '  + _fmtSig(dim.kh, 3)  + ' md·ft');
        if (_isFiniteNum(dim.Cs))   summary.push('Cs ≈ '  + _fmtSig(dim.Cs, 3)  + ' bbl/psi');
        if (_isFiniteNum(dim.rinv)) summary.push('rinv ≈ '+ _fmtSig(dim.rinv, 3)+ ' ft');
        if (summary.length) {
            base.narrative = (base.narrative ? (base.narrative + '  ') : '')
                           + 'Dimensional: ' + summary.join(' · ') + '.';
        }
        if (dim.caveats && dim.caveats.length) {
            base.cautions = (base.cautions || []).slice();
            for (var ci = 0; ci < dim.caveats.length; ci++) {
                base.cautions.push(dim.caveats[ci]);
            }
        }
        // Echo the dim object so callers can render the table directly.
        base.dimensional = dim;
        return base;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 12 — SELF-TEST
    // ═══════════════════════════════════════════════════════════════

})();

// ─── END 16-pvt ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 17-deconvolution ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 17 — Deconvolution (von Schroeter-Levitan)
//   Constructs the constant-rate unit pressure response from a long
//   variable-rate test. Total-variation regularised, non-negative
//   derivative enforced via exponential parameterisation.
//
//   References:
//     von Schroeter, Hollaender, Gringarten (SPE 71574, 2002)
//     Levitan (SPE 84290, 2003)
//     Levitan, Crawford, Hardwick (SPEREE Aug 2006) — gas depletion fix
//
//   PUBLIC API (all on window.*)
//     PRiSM_deconvolve(t, p, q, opts)              → result object
//        opts.steps   [{t,q}] explicit rate history (q may then be null)
//        opts.tStart  time production started (first step start)
//        opts.injector true → rates are injection (pressure rises)
//        opts.pInit   starting guess for p_i (e.g. the well's pi)
//     PRiSM_deconvolveDataset(ds?, opts)           → result + .inputs
//        Builds the inputs from PRiSM_dataset + the shared contracts
//        (C1 well, C2 analysis data: test type, pi, rate history).
//     PRiSM_applyDeconvolvedPi(pi?)                → writes the estimated
//        p_i to the well store with provenance 'deconvolution' (C1).
//     PRiSM_useDeconvolvedResponse(res?)           → makes the rate-normalised
//        response the working dataset (dispatches prism:dataset-loaded).
//     PRiSM_restoreDeconvolutionSource()           → puts the original back.
//     PRiSM_deconvolve_lcurve(t, p, q, lambdas, opts) → L-curve sweep
//     PRiSM_renderDeconvolutionPanel(container, opts) → UI render
//        (registered as the Tab 2 panel "Advanced: deconvolution", C7)
//     PRiSM_convolve_rate_response(t_eval, t_rate, q, g, tau) → number[]
//     PRiSM_invert_to_unit_rate(t, p, q)           → { t_unit, p_unit }
//
//   UNITS: t in hours, p in psia, q in STB/d (Mscf/d gas). g(τ) is the
//   unit-rate pressure change in psi per (STB/d).
//
//   CONVENTIONS
//     • Single outer IIFE, 'use strict'.
//     • Pure vanilla JS, no external libraries. Math.* only.
//     • Defensive against missing primitives — stubs PRiSM_lm,
//       PRiSM_logspace, PRiSM_compute_bourdet so the file loads + tests
//       in the smoke-test stub harness.
//     • Failure-tolerant — non-converged fits return converged:false +
//       best-iteration result, never throw.
//     • Expensive bits use precomputed elapsed-time matrices keyed on
//       the rate-step compaction so each LM iteration is O(M·R) where
//       R = number of distinct rate steps (tens, not thousands).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // ENV SHIMS — make this loadable in the smoke-test stub harness.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // logspace fallback (mirrors layer-1 implementation).
    function _logspace(lo, hi, n) {
        if (typeof G.PRiSM_logspace === 'function') {
            try { return G.PRiSM_logspace(lo, hi, n); } catch (e) { /* fall through */ }
        }
        if (!(n >= 2)) throw new Error('logspace: n must be ≥ 2');
        if (lo >= hi) throw new Error('logspace: lo must be < hi');
        var out = new Array(n);
        var step = (hi - lo) / (n - 1);
        for (var i = 0; i < n; i++) out[i] = Math.pow(10, lo + i * step);
        return out;
    }

    // Bourdet derivative (used to compute g'(tau)).
    function _bourdet(t, dp, L) {
        if (typeof G.PRiSM_compute_bourdet === 'function') {
            try { return G.PRiSM_compute_bourdet(t, dp, L != null ? L : 0.10); }
            catch (e) { /* fall through */ }
        }
        L = L || 0.10;
        var n = t.length;
        var d = new Array(n);
        for (var k = 0; k < n; k++) d[k] = NaN;
        if (n < 3) return d;
        for (var i = 1; i < n - 1; i++) {
            if (!isFinite(t[i]) || t[i] <= 0 || !isFinite(dp[i])) continue;
            var i1 = i - 1, i2 = i + 1;
            if (L > 0) {
                while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
                while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
            }
            var t1 = t[i1], t2 = t[i2], ti = t[i];
            if (!isFinite(t1) || !isFinite(t2) || t1 <= 0 || t2 <= 0) continue;
            var dl1 = Math.log(ti) - Math.log(t1);
            var dl2 = Math.log(t2) - Math.log(ti);
            var dlT = Math.log(t2) - Math.log(t1);
            if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
            var aTerm = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT);
            var bTerm = (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
            d[i] = aTerm + bTerm;
        }
        return d;
    }

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 0 — SHARED-CONTRACT ADAPTERS (C1 well, C2 data, C7 panels)
    // ═══════════════════════════════════════════════════════════════
    // Every cross-module call is guarded; each adapter has a local
    // fallback so this file also works on its own.

    function _num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

    // C1 — well & test inputs. Fallback reads window.PRiSM_pvt directly.
    function _getWell() {
        if (typeof G.PRiSM_getWell === 'function') {
            try { var w = G.PRiSM_getWell(); if (w && typeof w === 'object') return w; }
            catch (e) { /* fall through */ }
        }
        var pvt = G.PRiSM_pvt || {};
        var prov = pvt.provenance || {};
        var piSrc = prov.p_res;
        var piOk = (piSrc === 'user' || piSrc === 'sample' || piSrc === 'deconvolution');
        return {
            testType: pvt.testType || 'auto',
            pi: piOk ? _num(pvt.p_res) : null,
            q: _num(pvt.q),
            fluid: pvt.fluidType || 'oil'
        };
    }

    // C2 — analysis data (test type, reference pressure, rate history).
    function _getAnalysisData(ds) {
        if (typeof G.PRiSM_getAnalysisData !== 'function') return null;
        try {
            var a = G.PRiSM_getAnalysisData(ds);
            return (a && a.ok !== false) ? a : null;
        } catch (e) { return null; }
    }

    // Window CustomEvent (C7 events).
    function _dispatch(name, detail) {
        try {
            if (_hasWin && typeof G.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                G.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
            }
        } catch (e) { /* ignore */ }
    }

    // Every dataset mutation: publish, announce, redraw — through the single
    // commit path (PRiSM_commitDataset) when it is loaded, so the demo-input
    // release and the event contract (C7) apply to this module too.
    function _commitDataset(ds, source) {
        if (ds && ds.t && ds.t.length && typeof G.PRiSM_commitDataset === 'function') {
            G.PRiSM_commitDataset(ds, { source: source });
        } else {
            G.PRiSM_dataset = ds;
            _dispatch('prism:dataset-loaded', { source: source, n: (ds && ds.t) ? ds.t.length : 0 });
        }
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
    }

    // C7 — tab panel registry (merge; replace an entry with the same id).
    function _registerPanel(n, spec) {
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall through */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var list = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === spec.id) { list[i] = spec; return; }
        }
        list.push(spec);
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — DISCRETISATION (log-time grid + rate-step compaction)
    // ═══════════════════════════════════════════════════════════════
    //
    // The deconvolution problem is posed on:
    //
    //   • A log-spaced grid of "response times" τ_j (j = 0..N-1) at
    //     which the unknown unit-rate response g(τ_j) is sampled.
    //
    //   • A compacted list of rate steps (t_step_i, q_i, Δq_i) extracted
    //     from the input variable-rate trace. Adjacent samples with the
    //     same q are merged so we only carry distinct flow periods.
    //
    // Bounds:
    //   τ_min = smallest elapsed time between an observation and the
    //          rate step that precedes it (so the earliest data after
    //          every rate change is resolved). Floor: 1e-7·τ_max, 1e-6 hr.
    //          Fallback without steps: half the median sampling interval.
    //   τ_max = longest elapsed time since the first rate step (+5 %).
    //          (Anything beyond is unobservable in principle.)
    //   Below τ_min the response is extrapolated linearly to g(0) = 0.
    //
    // ═══════════════════════════════════════════════════════════════

    function _buildGrid(tArr, opts, steps) {
        var n = tArr.length;
        if (n < 2) throw new Error('PRiSM_deconvolve: need at least 2 time samples');
        var tTotal = tArr[n - 1] - tArr[0];
        if (!(tTotal > 0)) throw new Error('PRiSM_deconvolve: time history must be increasing');

        // Median dt (fallback tau_min pick).
        var dts = [];
        for (var i = 1; i < n; i++) {
            var d = tArr[i] - tArr[i - 1];
            if (d > 0) dts.push(d);
        }
        dts.sort(function (a, b) { return a - b; });
        var dtMed = dts.length ? dts[Math.floor(dts.length / 2)] : tTotal / Math.max(n - 1, 1);

        // Elapsed-time range actually sampled by the data.
        var minEl = Infinity, maxEl = 0;
        if (Array.isArray(steps) && steps.length) {
            var active = [];
            for (var s = 0; s < steps.length; s++) if (steps[s].dq !== 0) active.push(steps[s].t_start);
            if (active.length) {
                var first = active[0];
                for (var k = 0; k < n; k++) {
                    var tk = tArr[k];
                    var last = null;
                    for (var a = 0; a < active.length; a++) {
                        if (active[a] < tk) last = active[a]; else break;
                    }
                    if (last !== null) {
                        var el = tk - last;
                        if (el > 0 && el < minEl) minEl = el;
                    }
                    if (tk - first > maxEl) maxEl = tk - first;
                }
            }
        }
        var autoMax = (maxEl > 0) ? maxEl * 1.05 : tTotal * 1.10;
        var autoMin = isFinite(minEl)
            ? Math.max(minEl, autoMax * 1e-7, 1e-6)
            : Math.max(dtMed * 0.5, 1e-6);

        var tauMin = (opts && isFinite(opts.tauMin) && opts.tauMin > 0)
            ? opts.tauMin
            : autoMin;
        var tauMax = (opts && isFinite(opts.tauMax) && opts.tauMax > 0)
            ? opts.tauMax
            : autoMax;
        if (tauMax <= tauMin) {
            // Pathological — force a usable range.
            tauMax = tauMin * 100;
        }
        var nNodes = (opts && opts.nNodes != null) ? Math.max(8, opts.nNodes | 0) : 80;

        // log10-spaced grid.
        var logLo = Math.log10(tauMin);
        var logHi = Math.log10(tauMax);
        var tau = _logspace(logLo, logHi, nNodes);
        var lnTau = new Array(nNodes);
        for (var k = 0; k < nNodes; k++) lnTau[k] = Math.log(tau[k]);

        return {
            tau:    tau,
            lnTau:  lnTau,
            nNodes: nNodes,
            tauMin: tauMin,
            tauMax: tauMax,
            tTotal: tTotal,
            dtMed:  dtMed
        };
    }

    // Compact a per-sample rate trace into a list of distinct rate steps.
    // q may be null — caller should not call this in that case.
    //
    //   tArr, qArr  : same-length input arrays
    //   tolFrac     : merge adjacent steps when |q_i - q_{i-1}| < tolFrac · max|q|
    //
    // Returns:
    //   { steps: [{ t_start, q, dq }], qMax: number }
    //
    // The first step starts at tStart (when given and ≤ tArr[0]) else at
    // tArr[0], with dq = q (since q(0-) = 0 by convention). If the first
    // sample has q=0, an initial "no-flow" step is still emitted so
    // bookkeeping stays consistent — its dq is 0 and it contributes nothing.
    function _compactRateSteps(tArr, qArr, tolFrac, tStart) {
        if (tolFrac == null) tolFrac = 1e-6;
        var n = tArr.length;
        var qMax = 0;
        for (var i = 0; i < n; i++) {
            var qa = Math.abs(qArr[i] || 0);
            if (qa > qMax) qMax = qa;
        }
        var tol = qMax * tolFrac + 1e-12;

        var steps = [];
        var qPrev = null;
        for (var k = 0; k < n; k++) {
            var qk = qArr[k];
            if (!isFinite(qk)) qk = 0;
            if (qPrev === null || Math.abs(qk - qPrev) > tol) {
                var qBefore = (qPrev === null) ? 0 : qPrev;
                var ts = tArr[k];
                if (qPrev === null && isFinite(tStart) && tStart <= ts) ts = tStart;
                steps.push({
                    t_start: ts,
                    q:       qk,
                    dq:      qk - qBefore
                });
                qPrev = qk;
            }
        }
        return { steps: steps, qMax: qMax };
    }

    // Normalise an explicit rate history into steps. Accepts
    // [{t,q}] / [{t0,q}] / [{tStart,q}] / [{start,q}] (start = time the
    // rate began), sorted or not. Equal consecutive rates are merged.
    function _stepsFromHistory(hist, sign) {
        if (!Array.isArray(hist) || !hist.length) return null;
        var rows = [];
        for (var i = 0; i < hist.length; i++) {
            var h = hist[i];
            if (!h) continue;
            var ts = _num(h.t0);
            if (ts === null) ts = _num(h.tStart);
            if (ts === null) ts = _num(h.t);
            if (ts === null && typeof h.start === 'number' && !('end' in h)) ts = _num(h.start);
            var qv = _num(h.q);
            if (ts === null || qv === null) continue;
            rows.push({ t: ts, q: (sign || 1) * qv });
        }
        if (!rows.length) return null;
        rows.sort(function (a, b) { return a.t - b.t; });
        var steps = [], qPrev = 0, qMax = 0;
        for (var k = 0; k < rows.length; k++) {
            if (Math.abs(rows[k].q) > qMax) qMax = Math.abs(rows[k].q);
            if (steps.length && Math.abs(rows[k].q - qPrev) <= 1e-9 * Math.max(1, Math.abs(qPrev))) continue;
            steps.push({ t_start: rows[k].t, q: rows[k].q, dq: rows[k].q - qPrev });
            qPrev = rows[k].q;
        }
        return { steps: steps, qMax: qMax };
    }

    // Heuristic production start when no rate history says otherwise:
    // well-test data normally count hours from the start of production,
    // so a first sample that sits close to zero implies tStart = 0.
    function _autoStart(tArr) {
        var n = tArr.length;
        if (n < 2) return tArr[0];
        var t0 = tArr[0], span = tArr[n - 1] - t0;
        if (t0 > 0 && span > 0 && t0 <= 0.1 * span) return 0;
        return t0;
    }

    // Reference (normalising) rate: the last non-zero rate magnitude.
    function _refRate(steps) {
        for (var i = steps.length - 1; i >= 0; i--) {
            if (steps[i].q !== 0) return Math.abs(steps[i].q);
        }
        return 1;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — CONVOLUTION (Duhamel superposition)
    // ═══════════════════════════════════════════════════════════════
    //
    // For piecewise-constant rates:
    //
    //     p(t_k) − p_initial = − Σ_{i: t_step_i < t_k}  Δq_i · G(t_k − t_step_i)
    //
    // where G(τ) is the unit-rate pressure DROP response. (Sign: a
    // production rate q > 0 causes pressure to fall, so we subtract.)
    //
    // G(τ) is sampled on the log-grid as g_j = G(τ_j). Between grid
    // points we use LOG-LINEAR interpolation in τ — i.e. linear in
    // log-time, which is the correct shape for diffusive responses.
    //
    // Key constraints:
    //   τ < τ_min      → g_0 · τ/τ_min (linear to g(0) = 0; a sample taken
    //                    just after a rate change sees almost no response)
    //   τ > τ_max      → use g_{N-1} (clamp; unobservable beyond τ_max)
    //
    // ═══════════════════════════════════════════════════════════════

    // Interpolate g at a single elapsed time τ from the pre-built node
    // index and the two node weights.
    function _interpG(g, jLo, wA, wB) {
        return wA * g[jLo] + wB * g[jLo + 1];
    }

    // Build index/weight tables for all (eval-sample, rate-step) pairs.
    //
    //   For each observation t_k and each rate step i with t_step_i < t_k,
    //   compute τ = t_k - t_step_i and find:
    //     • idxLo : largest j such that τ_j ≤ τ
    //     • wLo   : weight on g_j
    //     • wHi   : weight on g_{j+1}   (wLo + wHi = 1 inside the grid)
    //
    // This is O(M·R) once, then each LM iteration only does the dot
    // product. M = #observations, R = #rate steps.
    //
    // Returned arrays are RAGGED:
    //   idxLo[k]   = number[] (length = nActiveStepsForK)
    //   wLo[k], wHi[k], dq[k] = number[]
    function _buildConvIdx(tObs, steps, lnTau, tauMin, tauMax) {
        var M = tObs.length;
        var R = steps.length;
        var nN = lnTau.length;
        var idxLo = new Array(M);
        var wLo   = new Array(M);
        var wHi   = new Array(M);
        var dqArr = new Array(M);
        var lnLo = lnTau[0], lnHi = lnTau[nN - 1];
        var dLn  = (nN > 1) ? (lnHi - lnLo) / (nN - 1) : 1.0;

        for (var k = 0; k < M; k++) {
            var rowI = [], rowA = [], rowB = [], rowD = [];
            var tK = tObs[k];
            for (var i = 0; i < R; i++) {
                var step = steps[i];
                if (step.dq === 0) continue;
                var dt = tK - step.t_start;
                if (dt <= 0) continue;
                var lnDt = Math.log(dt);
                var u    = (lnDt - lnLo) / dLn;     // fractional index
                var jLo, wA, wB;
                if (lnDt <= lnLo) {
                    jLo = 0; wA = Math.exp(lnDt - lnLo); wB = 0;   // τ/τ_min · g_0
                } else if (lnDt >= lnHi) {
                    jLo = nN - 2; wA = 0; wB = 1;                  // clamp high
                } else {
                    jLo = Math.floor(u);
                    if (jLo < 0) jLo = 0;
                    if (jLo > nN - 2) jLo = nN - 2;
                    wA = 1.0 - (u - jLo);                          // weight on jLo
                    if (wA < 0) wA = 0; else if (wA > 1) wA = 1;
                    wB = 1 - wA;
                }
                rowI.push(jLo);
                rowA.push(wA);
                rowB.push(wB);
                rowD.push(step.dq);
            }
            idxLo[k] = rowI;
            wLo[k]   = rowA;
            wHi[k]   = rowB;
            dqArr[k] = rowD;
        }

        return { idxLo: idxLo, wLo: wLo, wHi: wHi, dq: dqArr, M: M, R: R, nNodes: nN };
    }

    // Compute predicted pressure: p_pred[k] = p_i − Σ_i Δq_i · g(τ_ik)
    //
    //   convIdx : output of _buildConvIdx
    //   g       : length-N response samples
    //   p_i     : initial pressure
    function _forwardP(convIdx, g, p_i) {
        var M = convIdx.M;
        var idxLo = convIdx.idxLo, wLo = convIdx.wLo, wHi = convIdx.wHi, dq = convIdx.dq;
        var pred = new Array(M);
        for (var k = 0; k < M; k++) {
            var rowI = idxLo[k], rowA = wLo[k], rowB = wHi[k], rowD = dq[k];
            var sum = 0;
            for (var s = 0; s < rowI.length; s++) {
                sum += rowD[s] * _interpG(g, rowI[s], rowA[s], rowB[s]);
            }
            pred[k] = p_i - sum;
        }
        return pred;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — FORWARD MODEL (predict p given z, p_i, q)
    // ═══════════════════════════════════════════════════════════════
    //
    // The unknowns vector is x = [z_0, z_1, ..., z_{N-1}, p_i].
    // We map z → g via g_j = exp(z_j). This enforces g > 0
    // unconditionally (the pressure drop response is monotone-positive
    // for production tests).
    //
    // For LM we provide a residual vector that combines:
    //
    //     r_data[k]  = p_obs[k] − p_pred[k]                    (M entries)
    //     r_reg[j]   = sqrt(λ_eff) · ψ(z_{j+1} − z_j)          (N−1 entries)
    //     r_tik[j]   = sqrt(ν_eff) · z_j                       (N entries)
    //
    // where ψ() is a smooth Huber-like surrogate for |·|:
    //
    //     ψ(d) = sqrt(d² + ε²) − ε             — differentiable, ≈|d| for |d| >> ε
    //
    // so the augmented SSR = ||r||² automatically equals
    //     ||p−p_pred||² + λ·TV_smooth(z) + ν·||z||².
    //
    // ε is small (1e-3) so ψ closely approximates the true total
    // variation, but stays gradient-friendly at the kinks.
    //
    // ═══════════════════════════════════════════════════════════════

    var TV_EPS = 1e-3;
    function _psi(d) { return Math.sqrt(d * d + TV_EPS * TV_EPS) - TV_EPS; }
    function _psiSq(d) { return _psi(d); /* the residual */ }

    // Build the augmented residual vector.
    //   x        : full unknowns array [z_0..z_{N-1}, p_i]
    //   convIdx  : precomputed convolution indices
    //   pObs     : observed pressures (length M)
    //   nN       : number of grid nodes
    //   sqrtLam  : sqrt(λ) — applied to TV residuals
    //   sqrtNu   : sqrt(ν) — applied to Tikhonov residuals
    function _buildResidual(x, convIdx, pObs, nN, sqrtLam, sqrtNu) {
        var p_i = x[nN];
        var g = new Array(nN);
        for (var j = 0; j < nN; j++) g[j] = Math.exp(x[j]);

        var M = convIdx.M;
        var pred = _forwardP(convIdx, g, p_i);

        // Total residual length: M (data) + (nN − 1) (TV) + nN (Tikhonov).
        var totalLen = M + (nN - 1) + nN;
        var r = new Array(totalLen);
        // Data block.
        for (var k = 0; k < M; k++) r[k] = pObs[k] - pred[k];
        // TV block: λ·ψ(z_{j+1} − z_j).
        var off = M;
        for (var j2 = 0; j2 < nN - 1; j2++) {
            r[off + j2] = sqrtLam * _psi(x[j2 + 1] - x[j2]);
        }
        // Tikhonov block: ν·z_j.
        var off2 = off + (nN - 1);
        for (var j3 = 0; j3 < nN; j3++) {
            r[off2 + j3] = sqrtNu * x[j3];
        }
        return { r: r, pred: pred, g: g };
    }

    // Compute scalar misfit components from a residual vector.
    function _splitMisfit(r, M, nN) {
        var dataSS = 0, tvSS = 0, tikSS = 0;
        for (var k = 0; k < M; k++) dataSS += r[k] * r[k];
        var off = M;
        for (var j = 0; j < nN - 1; j++) tvSS += r[off + j] * r[off + j];
        var off2 = off + (nN - 1);
        for (var j2 = 0; j2 < nN; j2++) tikSS += r[off2 + j2] * r[off2 + j2];
        return { dataSS: dataSS, tvSS: tvSS, tikSS: tikSS };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — JACOBIAN (analytical, prediction-side)
    // ═══════════════════════════════════════════════════════════════
    //
    // CONVENTION USED HERE
    //   The Jacobian J holds ∂pred/∂x   (the prediction-side Jacobian).
    //   The residual r holds (obs − pred).
    //   Gauss-Newton step: JᵀJ·Δx = Jᵀr  ⇒  Δx = +(JᵀJ)⁻¹·Jᵀr
    //   This matches the convention used in window.PRiSM_lm.
    //
    // Because the parameter mapping is so structured we can write the
    // Jacobian analytically and skip finite-differencing — much faster
    // for the >80-parameter problems we're solving here.
    //
    // Let p_pred[k] = p_i − Σ_i Δq_i · ( a_ik · g_{j_ik} + b_ik · g_{j_ik+1} )
    //   (a, b = wLo, wHi from _buildConvIdx)
    //
    // ∂p_pred[k] / ∂z_m
    //   = − Σ_i Δq_i · ( a_ik · δ_{m,j_ik} · g_m + b_ik · δ_{m,j_ik+1} · g_m )
    //
    //   (g = exp(z) so ∂g_m/∂z_m = g_m)
    //
    // ∂p_pred[k] / ∂p_i = +1
    //
    // For the TV "pseudo-prediction" r_reg[j] / sqrt(λ) = ψ(z_{j+1} − z_j):
    //   we model r_reg as obs(=0) − pred(=−sqrt(λ)·ψ), so residual is
    //   stored as +sqrt(λ)·ψ and the prediction-side Jacobian is the
    //   NEGATIVE of d ψ / d z. This gives:
    //     ∂pred_reg[j] / ∂z_j     = + sqrt(λ) · ψ'(Δ_j)
    //     ∂pred_reg[j] / ∂z_{j+1} = − sqrt(λ) · ψ'(Δ_j)
    //   ψ'(d) = d / sqrt(d² + ε²)
    //
    // For the Tikhonov pseudo-prediction r_tik[j] / sqrt(ν) = z_j:
    //   ∂pred_tik[j] / ∂z_j = − sqrt(ν)
    //
    // Sanity:
    //   r_reg = +sqrt(λ)·ψ ≥ 0, gradient of ½||r_reg||² is Jᵀ·r_reg.
    //   For the regulariser to PUSH ψ toward zero, the descent direction
    //   on z_j must be sign(d_j). Verify: if d > 0 (so z_{j+1} > z_j),
    //   ψ' > 0 and we have J[reg_j][z_j] = +sqrt(λ)·ψ', J[reg_j][z_{j+1}] =
    //   −sqrt(λ)·ψ'. Step direction Δz = (JᵀJ)⁻¹·Jᵀr. Approximating with
    //   diagonal Hessian, Δz_j ≈ (Jᵀr)_j / (JᵀJ)_jj has same sign as
    //   J[reg_j][z_j] · r_reg_j > 0 (so z_j increases) and Δz_{j+1} < 0.
    //   This MOVES the two values toward each other → reduces TV. ✓
    //
    // The Jacobian is (M + N−1 + N) × (N + 1). Since most of the data
    // block columns are sparse (each k touches only the rate-steps
    // already in convIdx, and within those touches only 2 g-columns),
    // we walk the structure rather than building a dense matrix.
    //
    // ═══════════════════════════════════════════════════════════════

    function _zerosMatrix(rows, cols) {
        var M = new Array(rows);
        for (var i = 0; i < rows; i++) {
            var row = new Array(cols);
            for (var j = 0; j < cols; j++) row[j] = 0;
            M[i] = row;
        }
        return M;
    }

    function _buildJacobian(x, convIdx, nN, sqrtLam, sqrtNu) {
        var totalRows = convIdx.M + (nN - 1) + nN;
        var totalCols = nN + 1;
        var J = _zerosMatrix(totalRows, totalCols);

        // Pre-compute g.
        var g = new Array(nN);
        for (var j = 0; j < nN; j++) g[j] = Math.exp(x[j]);

        // ─── Data block: rows 0..M-1 ────────────────────────────────
        // J = ∂pred/∂x  (NOT ∂r/∂x)
        // ∂pred[k]/∂z_m = − Σ_{i: contributes m as j_lo} Δq_i · w_ik · g_m
        //               − Σ_{i: contributes m as j_lo+1} Δq_i · (1-w_ik) · g_m
        // ∂pred[k]/∂p_i = +1
        for (var k = 0; k < convIdx.M; k++) {
            var rowI = convIdx.idxLo[k];
            var rowA = convIdx.wLo[k];
            var rowB = convIdx.wHi[k];
            var rowD = convIdx.dq[k];
            for (var s = 0; s < rowI.length; s++) {
                var jLo  = rowI[s];
                var dqs  = rowD[s];
                // Column jLo: weight wLo on g_{jLo}. Sign is NEGATIVE.
                J[k][jLo]     -= dqs * rowA[s] * g[jLo];
                // Column jLo+1: weight wHi on g_{jLo+1}. Sign NEGATIVE.
                J[k][jLo + 1] -= dqs * rowB[s] * g[jLo + 1];
            }
            J[k][nN] = +1;
        }

        // ─── TV block: rows M..M+N-2 ───────────────────────────────
        // pred_reg[j] = −sqrt(λ)·ψ(d_j)  (so residual = +sqrt(λ)·ψ)
        // d_j = z_{j+1} − z_j ;  ψ'(d) = d / sqrt(d² + ε²)
        // ∂pred_reg/∂z_j = +sqrt(λ)·ψ'   (chain rule with d∂/∂z_j = -1)
        // ∂pred_reg/∂z_{j+1} = −sqrt(λ)·ψ'
        var off = convIdx.M;
        for (var j2 = 0; j2 < nN - 1; j2++) {
            var d = x[j2 + 1] - x[j2];
            var psip = d / Math.sqrt(d * d + TV_EPS * TV_EPS);
            J[off + j2][j2]     =  sqrtLam * psip;
            J[off + j2][j2 + 1] = -sqrtLam * psip;
        }

        // ─── Tikhonov block: rows M+N-1..M+2N-2 ────────────────────
        // pred_tik[j] = −sqrt(ν)·z_j  (residual = +sqrt(ν)·z_j)
        // ∂pred_tik/∂z_j = −sqrt(ν)
        var off2 = off + (nN - 1);
        for (var j3 = 0; j3 < nN; j3++) {
            J[off2 + j3][j3] = -sqrtNu;
        }

        return J;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — TV REGULARISATION (helpers)
    // ═══════════════════════════════════════════════════════════════
    //
    // Total Variation on z (since g = exp(z), TV in z is the standard
    // formulation per von Schroeter §4 "encoding equation"). We expose
    // a couple of helpers for diagnostics and the L-curve.
    // ═══════════════════════════════════════════════════════════════

    // Strict TV (uses absolute values, not the smooth ψ).
    function _tvStrict(z) {
        var tv = 0;
        for (var j = 0; j < z.length - 1; j++) tv += Math.abs(z[j + 1] - z[j]);
        return tv;
    }

    // Smooth TV (matches ψ used in residuals).
    function _tvSmooth(z) {
        var tv = 0;
        for (var j = 0; j < z.length - 1; j++) tv += _psi(z[j + 1] - z[j]);
        return tv;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — OBJECTIVE + GRADIENT (built-in LM solver)
    // ═══════════════════════════════════════════════════════════════
    //
    // We use the host's Levenberg-Marquardt only as an outer solver
    // contract guide. The structure of THIS problem (block-sparse
    // Jacobian, augmented residuals) is so different from the standard
    // PRiSM_lm interface (modelFn returns a single y vector, params is
    // an object with named keys) that we ship a dedicated LM kernel
    // here that operates directly on the residual / Jacobian bundle.
    //
    // The kernel:
    //
    //   For each iteration:
    //     1. Build r and J at current x.
    //     2. Form Jᵀ·J + λ · diag(Jᵀ·J) and Jᵀ·r.
    //     3. Solve the normal equations for Δx (Cholesky-style via
    //        Gauss-Jordan inversion of the SPD system).
    //     4. Trial x' = x + Δx, evaluate r' = ||r'||².
    //     5. If improved, accept and shrink λ; else reject and grow λ.
    //
    // This mirrors PRiSM_lm's strategy but skips its parameter-object
    // book-keeping and finite-difference Jacobian — both of which would
    // be costly here.
    //
    // ═══════════════════════════════════════════════════════════════

    // Gauss-Jordan inversion of an n×n SPD matrix (with partial pivoting,
    // since the diagonal damping makes things non-singular but not
    // necessarily well-pivoted on the diagonal). Returns null if singular.
    function _invertSPD(A) {
        var n = A.length;
        var M = new Array(n);
        for (var r = 0; r < n; r++) {
            var row = new Array(2 * n);
            for (var c = 0; c < n; c++) row[c] = A[r][c];
            for (var c2 = 0; c2 < n; c2++) row[n + c2] = (r === c2) ? 1 : 0;
            M[r] = row;
        }
        for (var i = 0; i < n; i++) {
            // Partial pivot.
            var maxRow = i, maxAbs = Math.abs(M[i][i]);
            for (var k = i + 1; k < n; k++) {
                var av = Math.abs(M[k][i]);
                if (av > maxAbs) { maxAbs = av; maxRow = k; }
            }
            if (maxAbs < 1e-15) return null;
            if (maxRow !== i) {
                var tmp = M[i]; M[i] = M[maxRow]; M[maxRow] = tmp;
            }
            var pivot = M[i][i];
            for (var c3 = 0; c3 < 2 * n; c3++) M[i][c3] /= pivot;
            for (var k2 = 0; k2 < n; k2++) {
                if (k2 === i) continue;
                var f = M[k2][i];
                if (f === 0) continue;
                for (var c4 = 0; c4 < 2 * n; c4++) M[k2][c4] -= f * M[i][c4];
            }
        }
        var inv = new Array(n);
        for (var ri = 0; ri < n; ri++) {
            var rowOut = new Array(n);
            for (var ci = 0; ci < n; ci++) rowOut[ci] = M[ri][n + ci];
            inv[ri] = rowOut;
        }
        return inv;
    }

    // Solve A·x = b for x given precomputed inverse.
    function _matVec(A, b) {
        var n = A.length;
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
            var s = 0;
            var row = A[i];
            for (var j = 0; j < b.length; j++) s += row[j] * b[j];
            out[i] = s;
        }
        return out;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — LM SOLVER (deconvolution-specific)
    // ═══════════════════════════════════════════════════════════════
    //
    // The dedicated LM kernel for the deconvolution problem.
    //
    //   x         : [z_0..z_{N-1}, p_i]
    //   convIdx   : precomputed indices
    //   pObs      : observed pressures
    //   nN        : grid size
    //   lambdaReg : λ (regularisation strength; NOT the LM damping)
    //   nu        : ν (Tikhonov)
    //   onIter    : callback(iter, ssr, lambdaLM)
    //   maxIter, tol
    //
    // Returns:
    //   { x, ssr, dataSS, tvSS, tikSS, history, converged, iter }
    //
    // ═══════════════════════════════════════════════════════════════

    function _lmKernel(x0, convIdx, pObs, nN, lambdaReg, nu, opts) {
        opts = opts || {};
        var maxIter = (opts.maxIter != null) ? opts.maxIter | 0 : 200;
        var tol     = (opts.tolerance != null) ? +opts.tolerance : 1e-6;
        var lamLM   = (opts.lambda0   != null) ? +opts.lambda0   : 1e-2;
        var lamUp   = (opts.lambdaUp  != null) ? +opts.lambdaUp  : 4;
        var lamDown = (opts.lambdaDown != null) ? +opts.lambdaDown : 0.4;
        var lamMax  = (opts.lambdaMax != null) ? +opts.lambdaMax : 1e10;
        // Floor lamMin a touch above zero so even fully-converged
        // problems retain enough damping to avoid Newton overshoot in
        // the next outer iteration.
        var lamMin  = (opts.lambdaMin != null) ? +opts.lambdaMin : 1e-7;
        var maxInner = (opts.maxInner != null) ? opts.maxInner | 0 : 50;
        var onIter  = (typeof opts.onProgress === 'function') ? opts.onProgress : null;

        var sqrtLam = Math.sqrt(Math.max(lambdaReg, 0));
        var sqrtNu  = Math.sqrt(Math.max(nu, 0));

        var x = x0.slice();
        var nVar = x.length;

        // Initial residual.
        var bundle = _buildResidual(x, convIdx, pObs, nN, sqrtLam, sqrtNu);
        var r = bundle.r;
        var ssr = 0;
        for (var i0 = 0; i0 < r.length; i0++) ssr += r[i0] * r[i0];
        var history = [ssr];

        var converged = false;
        var bestX = x.slice(), bestSSR = ssr, bestPred = bundle.pred.slice(), bestG = bundle.g.slice();
        var iter = 0;

        for (iter = 1; iter <= maxIter; iter++) {
            // Re-arm LM damping at each outer iteration so we don't get
            // stuck at the floor after a sequence of accepted Newton
            // steps. We never let it sit below 10·lamMin entering an
            // iteration — gives the inner loop room to find a step.
            if (lamLM < 10 * lamMin) lamLM = 10 * lamMin;

            // 1. Build Jacobian.
            var J = _buildJacobian(x, convIdx, nN, sqrtLam, sqrtNu);
            var nRows = J.length;

            // 2. Form Jᵀ·J (nVar × nVar) and Jᵀ·r (nVar).
            var JtJ = _zerosMatrix(nVar, nVar);
            var Jtr = new Array(nVar);
            for (var ic = 0; ic < nVar; ic++) Jtr[ic] = 0;
            for (var ir = 0; ir < nRows; ir++) {
                var row = J[ir];
                var rval = r[ir];
                for (var a = 0; a < nVar; a++) {
                    var Ja = row[a];
                    if (Ja === 0) continue;
                    Jtr[a] += Ja * rval;
                    for (var b = a; b < nVar; b++) {
                        var Jb = row[b];
                        if (Jb === 0) continue;
                        JtJ[a][b] += Ja * Jb;
                    }
                }
            }
            // Symmetrise.
            for (var aa = 0; aa < nVar; aa++) {
                for (var bb = aa + 1; bb < nVar; bb++) JtJ[bb][aa] = JtJ[aa][bb];
            }
            // Held p_i (single flow period with a known pi): no step on it.
            if (opts.fixPi) {
                for (var fc = 0; fc < nVar; fc++) { JtJ[nN][fc] = 0; JtJ[fc][nN] = 0; }
                JtJ[nN][nN] = 1;
                Jtr[nN] = 0;
            }

            // Snapshot diagonal for Marquardt scaling.
            var diagJtJ = new Array(nVar);
            for (var d2 = 0; d2 < nVar; d2++) diagJtJ[d2] = Math.max(JtJ[d2][d2], 1e-30);

            // 3. Inner loop — adaptive lamLM.
            var accepted = false;
            var inner = 0;
            var newSSR = ssr, newX = x, newBundle = bundle;

            while (!accepted && inner < maxInner) {
                inner++;

                // Build A = JtJ + lamLM · diag(JtJ).
                var A = new Array(nVar);
                for (var rr = 0; rr < nVar; rr++) {
                    var rowA = new Array(nVar);
                    for (var cc = 0; cc < nVar; cc++) rowA[cc] = JtJ[rr][cc];
                    rowA[rr] += lamLM * diagJtJ[rr];
                    A[rr] = rowA;
                }

                var Ainv = _invertSPD(A);
                if (!Ainv) {
                    lamLM *= lamUp;
                    if (lamLM > lamMax) break;
                    continue;
                }
                var dx = _matVec(Ainv, Jtr);
                // Note: we computed Jᵀ·r directly (not Jᵀ·(p_obs - p_pred)).
                // The standard Gauss-Newton step is Δx = (JtJ)^{-1} · Jᵀ·r,
                // *with* r defined as (obs − pred). Our r definition matches
                // that, so the step is x ← x + Δx (sign preserved by setting
                // ∂r/∂z = +g (etc.) in _buildJacobian).

                // Cap |Δz_j| to 1.5 to prevent runaway exp() growth in any
                // single iteration. p_i (the last entry) has its own
                // magnitude check below — we cap that to 5% of |p_i|.
                var zCap = 1.5;
                for (var iz0 = 0; iz0 < nN; iz0++) {
                    if (dx[iz0] >  zCap) dx[iz0] =  zCap;
                    if (dx[iz0] < -zCap) dx[iz0] = -zCap;
                }
                var pCap = Math.max(Math.abs(x[nN]) * 0.05, 5.0);
                if (dx[nN] >  pCap) dx[nN] =  pCap;
                if (dx[nN] < -pCap) dx[nN] = -pCap;

                // Trial update.
                var trialX = new Array(nVar);
                for (var ix = 0; ix < nVar; ix++) trialX[ix] = x[ix] + dx[ix];

                // Box-clip z entries to a reasonable range to keep exp(z)
                // numerically sane: −50 < z < 50 → 2e-22 < g < 5e21.
                for (var iz = 0; iz < nN; iz++) {
                    if (trialX[iz] >  50) trialX[iz] =  50;
                    if (trialX[iz] < -50) trialX[iz] = -50;
                }

                var trialBundle = _buildResidual(trialX, convIdx, pObs, nN, sqrtLam, sqrtNu);
                var trialSSR = 0;
                for (var iy = 0; iy < trialBundle.r.length; iy++) {
                    trialSSR += trialBundle.r[iy] * trialBundle.r[iy];
                }

                if (isFinite(trialSSR) && trialSSR < ssr) {
                    accepted = true;
                    newSSR    = trialSSR;
                    newX      = trialX;
                    newBundle = trialBundle;
                    lamLM = Math.max(lamLM * lamDown, lamMin);
                } else {
                    lamLM *= lamUp;
                    if (lamLM > lamMax) break;
                }
            }

            if (!accepted) {
                history.push(ssr);
                if (onIter) { try { onIter(iter, ssr, lamLM); } catch (e) {} }
                // Couldn't make progress. Bail with best-so-far.
                break;
            }

            // Convergence: relative SSR change.
            var relChg = Math.abs(ssr - newSSR) / Math.max(Math.abs(ssr), 1e-12);

            x      = newX;
            bundle = newBundle;
            r      = bundle.r;
            ssr    = newSSR;
            history.push(ssr);

            if (ssr < bestSSR) {
                bestSSR = ssr;
                bestX   = x.slice();
                bestPred = bundle.pred.slice();
                bestG   = bundle.g.slice();
            }

            if (onIter) { try { onIter(iter, ssr, lamLM); } catch (e) {} }

            if (relChg < tol) {
                converged = true;
                break;
            }
        }

        // Final misfit decomposition for diagnostics.
        var split = _splitMisfit(r, convIdx.M, nN);

        return {
            x:         bestX,
            g:         bestG,
            pred:      bestPred,
            ssr:       bestSSR,
            dataSS:    split.dataSS,
            tvSS:      split.tvSS,
            tikSS:     split.tikSS,
            history:   history,
            converged: converged,
            iter:      iter
        };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7B — INITIAL GUESS
    // ═══════════════════════════════════════════════════════════════
    //
    // We default to a Theis-line-source-flavoured first guess:
    //
    //     g(τ) ≈ a + b · ln(τ)               (slope = b)
    //
    // i.e. log-linear in τ. The amplitude/intercept are chosen so the
    // initial average pressure drop matches the observed average. This
    // gets LM into the right basin in a few iterations even on long,
    // noisy histories.
    //
    // ═══════════════════════════════════════════════════════════════

    function _initialGuess(tObs, pObs, steps, tau, lnTau, opts) {
        var nObs = pObs.length;
        var pMax = -Infinity, pMin = Infinity;
        for (var k = 0; k < nObs; k++) {
            if (pObs[k] > pMax) pMax = pObs[k];
            if (pObs[k] < pMin) pMin = pObs[k];
        }
        // Initial guess for p_i: the well's pi when known (C1), else the
        // extreme observed pressure plus a small buffer — since g > 0,
        // a producer's predicted p never exceeds p_i (an injector's never
        // falls below it).
        var qFirst = 0;
        for (var s0 = 0; s0 < steps.length; s0++) {
            if (steps[s0].q !== 0) { qFirst = steps[s0].q; break; }
        }
        var p_i = (opts && isFinite(opts.pInit)) ? +opts.pInit
                : (qFirst < 0 ? pMin - 1.0 : pMax + 1.0);
        if (opts && Array.isArray(opts.initialZ) && opts.initialZ.length === tau.length) {
            return { z: opts.initialZ.slice(), p_i: p_i };
        }

        // Magnitude scale: peak pressure change divided by max |q|.
        // We use the largest |Δp| seen, not the endpoint value, because
        // a buildup or recovery may push the endpoint back up.
        var dpPeak = Math.max(pMax - pMin, 1e-3);
        var qMag = 0;
        for (var s2 = 0; s2 < steps.length; s2++) qMag = Math.max(qMag, Math.abs(steps[s2].q));
        if (qMag === 0) qMag = 1;
        // Amp ≈ unit-rate pressure drop at the longest τ that the data has
        // seen with reasonable rate. Order of magnitude is enough — LM
        // refines the rest.
        var amp = dpPeak / qMag;
        if (amp < 1e-6) amp = 1e-6;

        // Build a Theis-line-source-style guess: g(τ) = a + m·ln(τ)
        // with the amplitude chosen so g(τ_max) ≈ amp.
        var nN = tau.length;
        var z = new Array(nN);
        // Slope: pick m so total g spans ~1 decade in g-space across the
        // full τ range. Concretely: g varies from amp/10 at τ_min to amp
        // at τ_max → ln(g) varies by ln(10)≈2.3 over the full ln(τ) range.
        var lnTauSpan = lnTau[nN - 1] - lnTau[0];
        if (lnTauSpan < 1e-6) lnTauSpan = 1e-6;
        var slopeLnG = Math.log(10) / lnTauSpan;       // ln(g) per ln(τ)
        var lnAmpHigh = Math.log(amp);
        for (var j = 0; j < nN; j++) {
            var distFromHigh = lnTau[nN - 1] - lnTau[j];
            // ln(g_j) = lnAmpHigh - slopeLnG · distFromHigh
            z[j] = lnAmpHigh - slopeLnG * distFromHigh;
        }
        return { z: z, p_i: p_i };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — L-CURVE λ AUTO-PICKER (max-curvature corner)
    // ═══════════════════════════════════════════════════════════════
    //
    // For each candidate λ, run deconvolution and record:
    //
    //     misfit_λ     = ||p_obs − p_pred||²        (data fit)
    //     smoothness_λ = TV(z)                       (model roughness)
    //
    // On a log-log plot of (smoothness, misfit) the "L-curve" has a
    // pronounced corner at the regularisation that best balances the
    // two. We detect the corner using the discrete curvature
    // (κ_i = | x'·y'' − y'·x'' | / (x'² + y'²)^{3/2}) on the log-log
    // points and pick the index of maximum curvature, ignoring the
    // endpoints (which can have spurious curvature spikes).
    //
    // For very smooth L-curves (no clear corner) we fall back to the
    // "knee" by minimising the distance to the origin in normalised
    // log-log coordinates.
    //
    // ═══════════════════════════════════════════════════════════════

    function _lCurveCorner(misfit, smoothness) {
        var n = misfit.length;
        if (n < 3) return n - 1;

        // Convert to log-log, after guarding against zeros.
        var X = new Array(n), Y = new Array(n);
        for (var i = 0; i < n; i++) {
            X[i] = Math.log10(Math.max(smoothness[i], 1e-30));
            Y[i] = Math.log10(Math.max(misfit[i],     1e-30));
        }

        // Discrete second-derivative-based curvature.
        var bestK = -Infinity, bestIdx = Math.floor(n / 2);
        for (var k = 1; k < n - 1; k++) {
            var dx1 = X[k] - X[k - 1], dy1 = Y[k] - Y[k - 1];
            var dx2 = X[k + 1] - X[k], dy2 = Y[k + 1] - Y[k];
            // Use triangle-area form for curvature on three points:
            //   κ ≈ 2 · | (x1·y2 − x2·y1) | / (|p1|·|p2|·|p1−p2|)
            // Equivalent to the discrete version; avoids needing a
            // monotone parameterisation.
            var cross = Math.abs(dx1 * dy2 - dy1 * dx2);
            var den = Math.pow(dx1 * dx1 + dy1 * dy1, 0.5)
                    * Math.pow(dx2 * dx2 + dy2 * dy2, 0.5)
                    * Math.pow((X[k + 1] - X[k - 1]) * (X[k + 1] - X[k - 1]) +
                                (Y[k + 1] - Y[k - 1]) * (Y[k + 1] - Y[k - 1]), 0.5);
            var kappa = (den > 1e-30) ? (cross / den) : 0;
            if (kappa > bestK) { bestK = kappa; bestIdx = k; }
        }
        // Sanity fallback: if curvature picker came up empty (all colinear)
        // fall back to the closest-to-origin point on normalised axes.
        if (!isFinite(bestK) || bestK <= 0) {
            var Xmin = Infinity, Xmax = -Infinity, Ymin = Infinity, Ymax = -Infinity;
            for (var iy = 0; iy < n; iy++) {
                if (X[iy] < Xmin) Xmin = X[iy];
                if (X[iy] > Xmax) Xmax = X[iy];
                if (Y[iy] < Ymin) Ymin = Y[iy];
                if (Y[iy] > Ymax) Ymax = Y[iy];
            }
            var dxR = Xmax - Xmin || 1, dyR = Ymax - Ymin || 1;
            var bestD = Infinity;
            for (var ix2 = 0; ix2 < n; ix2++) {
                var nx = (X[ix2] - Xmin) / dxR;
                var ny = (Y[ix2] - Ymin) / dyR;
                var dist = nx * nx + ny * ny;
                if (dist < bestD) { bestD = dist; bestIdx = ix2; }
            }
        }
        return bestIdx;
    }

    // Public L-curve scan.
    function PRiSM_deconvolve_lcurve(t, p, q, lambdas, opts) {
        opts = opts || {};
        if (!Array.isArray(lambdas) || !lambdas.length) {
            // Default sweep: 1e-8 to 1e0, 12 points.
            lambdas = _logspace(-8, 0, 12);
        }
        var nL = lambdas.length;
        var misfit     = new Array(nL);
        var smoothness = new Array(nL);
        for (var i = 0; i < nL; i++) {
            var sub = {};
            for (var kk in opts) if (opts.hasOwnProperty(kk)) sub[kk] = opts[kk];
            sub.lambda = lambdas[i];
            sub.skipLCurve = true;          // don't recurse
            sub.silent = true;              // suppress per-λ logs
            var res;
            try { res = PRiSM_deconvolve(t, p, q, sub); }
            catch (e) {
                misfit[i] = NaN; smoothness[i] = NaN; continue;
            }
            misfit[i]     = res.diagnostics ? res.diagnostics.dataSS : Math.pow(res.rmse, 2) * t.length;
            smoothness[i] = res.diagnostics ? res.diagnostics.smoothness : NaN;
        }
        var cornerIdx = _lCurveCorner(misfit, smoothness);
        return {
            lambdas:      lambdas.slice(),
            misfit:       misfit,
            smoothness:   smoothness,
            cornerIdx:    cornerIdx,
            cornerLambda: lambdas[cornerIdx]
        };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — LEVITAN GAS-DEPLETION CORRECTION (P̄(t) tracking)
    // ═══════════════════════════════════════════════════════════════
    //
    // The 2006 Levitan-Crawford-Hardwick fix addresses the case where
    // the average reservoir pressure P̄ drifts during the test (gas
    // wells, tight oil, depleted intervals). The standard von
    // Schroeter formulation assumes p_initial is constant; with
    // depletion it becomes a slowly-varying function P̄(t).
    //
    // SIMPLIFICATION USED HERE
    //   We model P̄(t) as PIECEWISE-LINEAR between rate steps, which is
    //   the textbook approximation that captures the main effect
    //   (slow tank-pressure drift between flow periods) without
    //   requiring a full material-balance solver.
    //
    //   P̄(t) = P̄_i − k · ∫₀ᵗ q(s) ds   where k is the depletion
    //                                    constant (psi per produced bbl)
    //
    //   We expose this as an OPTIONAL feature. opts.gasDepletion = {
    //     enabled: true|false,
    //     k:       null         // null = estimated jointly as a free param
    //   }
    //
    //   When enabled, the predicted pressure becomes
    //     p_pred[k] = P̄(t_k) − Σ_i Δq_i · g(t_k − t_step_i)
    //
    //   The mathematical machinery is identical to the standard form
    //   except p_initial is replaced with P̄(t_k); we just substitute
    //   that in the residual / Jacobian. For the simplified linear
    //   model only one extra unknown (k) needs to be added.
    //
    //   THIS BLOCK PROVIDES THE HELPERS — the main PRiSM_deconvolve
    //   call uses the standard (constant-P̄) form by default and sets
    //   `gasDepletion: false` in the result diagnostics.
    //
    //   FULL implementation (joint estimation of k via LM) is left as
    //   a documented stub: enable opts.gasDepletion.enabled=true and
    //   you'll get a notice + the standard solve. A complete fit
    //   requires extending the unknowns vector and the Jacobian by
    //   one column; the structure is straightforward but adds 100+
    //   lines we've intentionally deferred.
    //
    // ═══════════════════════════════════════════════════════════════

    // Cumulative production at time t given step list (for diagnostics).
    function _cumProduction(t, steps) {
        // Σ q_i · (min(t, t_{i+1}) − t_i) over rate periods that have started.
        var R = steps.length;
        var Q = 0;
        for (var i = 0; i < R; i++) {
            var ts = steps[i].t_start;
            if (ts >= t) break;
            var te = (i + 1 < R) ? steps[i + 1].t_start : t;
            if (te > t) te = t;
            Q += steps[i].q * (te - ts);
        }
        return Q;
    }

    // Apply depletion correction to predicted pressures (linear in
    // cumulative production). Returns a new array.
    function _applyDepletion(pred, tObs, steps, kDepl) {
        var n = pred.length;
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
            var Q = _cumProduction(tObs[i], steps);
            out[i] = pred[i] - kDepl * Q;
        }
        return out;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 10 — MAIN ENTRY POINT (PRiSM_deconvolve)
    // ═══════════════════════════════════════════════════════════════

    function PRiSM_deconvolve(t, p, q, opts) {
        opts = opts || {};
        var hasSteps = Array.isArray(opts.steps) && opts.steps.length > 0;

        // ─── Validate input ────────────────────────────────────────
        if (!Array.isArray(t) || !Array.isArray(p) || (!Array.isArray(q) && !hasSteps)) {
            // Allow source from window.PRiSM_dataset if no args given.
            var ds = G.PRiSM_dataset;
            if (ds && Array.isArray(ds.t) && Array.isArray(ds.p) && Array.isArray(ds.q)) {
                t = ds.t; p = ds.p; q = ds.q;
            } else {
                throw new Error('PRiSM_deconvolve: t, p and q arrays (or opts.steps) are required');
            }
        }
        if (t.length !== p.length || (Array.isArray(q) && t.length !== q.length)) {
            throw new Error('PRiSM_deconvolve: t, p, q must have the same length');
        }
        if (t.length < 3) throw new Error('PRiSM_deconvolve: need at least 3 samples');

        var injector = !!opts.injector;
        var warnings = [];

        // ─── Rate steps (full-resolution data, before any subsample) ─
        // Producers keep the sign of the rate column; injectors are
        // forced negative so the unit response g stays positive.
        var rate;
        if (hasSteps) {
            var hist = [];
            for (var hs = 0; hs < opts.steps.length; hs++) {
                var st0 = opts.steps[hs];
                if (!st0) continue;
                hist.push((st0.t_start != null) ? { t: st0.t_start, q: st0.q } : st0);
            }
            rate = _stepsFromHistory(hist, 1);
            if (!rate || !rate.steps.length) throw new Error('PRiSM_deconvolve: opts.steps has no usable {t, q} entries');
            if (injector) {
                var qPrevI = 0;
                for (var si = 0; si < rate.steps.length; si++) {
                    rate.steps[si].q = -Math.abs(rate.steps[si].q);
                    rate.steps[si].dq = rate.steps[si].q - qPrevI;
                    qPrevI = rate.steps[si].q;
                }
            }
        } else {
            var qs = new Array(q.length);
            for (var iq = 0; iq < q.length; iq++) {
                var qv = isFinite(q[iq]) ? +q[iq] : 0;
                qs[iq] = injector ? -Math.abs(qv) : qv;
            }
            var tStart = isFinite(opts.tStart) ? +opts.tStart : _autoStart(t);
            rate = _compactRateSteps(t, qs, 1e-6, tStart);
        }
        var nChanges = 0;
        for (var ic = 0; ic < rate.steps.length; ic++) if (rate.steps[ic].dq !== 0) nChanges++;
        if (!nChanges) throw new Error('PRiSM_deconvolve: the rate history is zero everywhere');
        var piIdentifiable = nChanges >= 2;
        // With one flow period p_i trades off against the response level;
        // hold it at the known pi when there is one (opts.fixPi forces it).
        var fixPi = (opts.fixPi === true && isFinite(opts.pInit)) ||
                    (opts.fixPi !== false && !piIdentifiable && isFinite(opts.pInit));
        if (!piIdentifiable) {
            warnings.push(fixPi
                ? 'Only one flow period: p_i is held at the well value (' + (+opts.pInit).toFixed(1) +
                  ' psia) and only the response is rebuilt.'
                : 'Only one flow period: the initial pressure is not determined independently ' +
                  '(it trades off against the response level). Use a test with a rate change or shut-in.');
        }

        // ─── Automatic smoothing (default rule: discrepancy) ───────
        // The data misfit barely changes over many decades of λ while the
        // roughness of g collapses, so pick the LARGEST λ whose RMSE stays
        // within 1.25·RMSE_min + 1e-4·(pressure range). Too small a λ leaves
        // g oscillating between nodes the data do not constrain (the
        // derivative becomes noise) even though p_i is already right.
        // opts.lambdaRule = 'lcurve' selects the max-curvature corner instead.
        if (opts.lambda == null && opts.skipLCurve !== true && opts.lambdaRule !== 'lcurve') {
            var lams = (Array.isArray(opts.lcurveLambdas) && opts.lcurveLambdas.length)
                ? opts.lcurveLambdas : _logspace(-1, 4, 6);
            var runs = [];
            for (var li = 0; li < lams.length; li++) {
                var subO = {};
                for (var kk in opts) if (Object.prototype.hasOwnProperty.call(opts, kk)) subO[kk] = opts[kk];
                subO.lambda = lams[li]; subO.skipLCurve = true; subO.silent = true; subO.onProgress = null;
                try { runs.push({ lambda: lams[li], res: PRiSM_deconvolve(t, p, q, subO) }); }
                catch (e) { /* skip this λ */ }
            }
            if (!runs.length) throw new Error('PRiSM_deconvolve: no smoothing level produced a solution');
            var rMin = Infinity, pHiA = -Infinity, pLoA = Infinity;
            for (var ri = 0; ri < runs.length; ri++) if (runs[ri].res.rmse < rMin) rMin = runs[ri].res.rmse;
            for (var pa = 0; pa < p.length; pa++) {
                if (p[pa] > pHiA) pHiA = p[pa];
                if (p[pa] < pLoA) pLoA = p[pa];
            }
            var allow = 1.25 * rMin + 1e-4 * Math.max(pHiA - pLoA, 0);
            var pick = null;
            for (var rj = 0; rj < runs.length; rj++) {
                if (runs[rj].res.rmse <= allow && (!pick || runs[rj].lambda > pick.lambda)) pick = runs[rj];
            }
            if (!pick) pick = runs[0];
            var chosen = pick.res;
            chosen.rationale = 'automatic smoothing λ=' + pick.lambda.toExponential(1)
                + ' (largest with RMSE ≤ ' + allow.toFixed(3) + ' psi; best ' + rMin.toFixed(3) + ' psi)';
            chosen.lambdaSweep = runs.map(function (r) { return { lambda: r.lambda, rmse: r.res.rmse, p_initial: r.res.p_initial }; });
            if (!opts.silent) {
                _ga4('prism_deconvolution_run', {
                    nNodes: chosen.diagnostics.nNodes, converged: chosen.converged,
                    iter: chosen.iterations, rmse: chosen.rmse, lambda: chosen.lambda
                });
            }
            return chosen;
        }

        // ─── Implicit downsample for very long datasets ────────────
        // The deconvolution itself doesn't need every sample — log-spaced
        // (per flow period) subsampling preserves the time-domain
        // information at a small fraction of the cost. Residuals are
        // re-evaluated on the original samples after the solve.
        var tDS = t, pDS = p;
        var didDownsample = false;
        if (t.length > 2000 && opts.noDownsample !== true) {
            var sub = _logSubsample(t, p, rate.steps, 2000);
            tDS = sub.t; pDS = sub.p;
            didDownsample = true;
        }

        // ─── Build grid ────────────────────────────────────────────
        var grid = _buildGrid(tDS, opts, rate.steps);

        // Build convolution indices.
        var convIdx = _buildConvIdx(tDS, rate.steps, grid.lnTau, grid.tauMin, grid.tauMax);

        // ─── Initial guess ─────────────────────────────────────────
        var init = _initialGuess(tDS, pDS, rate.steps, grid.tau, grid.lnTau, opts);
        var x0 = init.z.concat([init.p_i]);

        // ─── Choose λ (regularisation) ─────────────────────────────
        var lambdaUsed, rationale;
        var nu = (opts.nu != null) ? +opts.nu : 1e-6;

        if (opts.lambda == null && opts.skipLCurve !== true) {
            // Auto-pick via L-curve. To avoid recursion, we run a
            // mini-sweep with skipLCurve=true on each candidate.
            var lSweepLambdas = (opts.lcurveLambdas) || _logspace(-6, -1, 8);
            var sweep = PRiSM_deconvolve_lcurve(t, p, q, lSweepLambdas,
                Object.assign({}, opts, { skipLCurve: true, lambda: null }));
            lambdaUsed = sweep.cornerLambda;
            rationale  = 'L-curve corner at λ=' + lambdaUsed.toExponential(2);
        } else if (opts.lambda != null) {
            lambdaUsed = +opts.lambda;
            rationale  = 'used user-specified λ=' + lambdaUsed.toExponential(2);
        } else {
            // skipLCurve is true and no λ supplied — use a sane default.
            lambdaUsed = 1e-2;
            rationale  = 'default λ=1e-2 (skipLCurve set, none supplied)';
        }

        // ─── Run LM ────────────────────────────────────────────────
        var lmRes = _lmKernel(x0, convIdx, pDS, grid.nNodes, lambdaUsed, nu, {
            maxIter:    (opts.maxIter != null) ? opts.maxIter : 200,
            tolerance:  (opts.tolerance != null) ? opts.tolerance : 1e-7,
            onProgress: opts.onProgress,
            fixPi:      fixPi
        });

        // ─── Response on the τ grid ────────────────────────────────
        var g = lmRes.g;
        var p_initial = lmRes.x[grid.nNodes];

        // Bourdet derivative of g(τ) on the log-time axis.
        var gPrime = _bourdet(grid.tau, g, opts.smoothL || 0.10);

        // ─── Re-evaluate residuals on FULL data grid ───────────────
        var convFull = didDownsample
            ? _buildConvIdx(t, rate.steps, grid.lnTau, grid.tauMin, grid.tauMax)
            : convIdx;
        var pFullPred = _forwardP(convFull, g, p_initial);
        var residuals = new Array(t.length);
        var sumSq = 0, pHi = -Infinity, pLo = Infinity;
        for (var i = 0; i < t.length; i++) {
            residuals[i] = p[i] - pFullPred[i];
            sumSq += residuals[i] * residuals[i];
            if (p[i] > pHi) pHi = p[i];
            if (p[i] < pLo) pLo = p[i];
        }
        var rmse = Math.sqrt(sumSq / Math.max(t.length, 1));
        if (isFinite(pHi - pLo) && pHi > pLo && rmse > 0.02 * (pHi - pLo)) {
            warnings.push('Poor reconstruction of the pressure history (RMSE ' + rmse.toFixed(2) +
                          ' psi). Check the rate history and the time origin.');
        }
        // Near-exact data can stop on the iteration cap with a negligible
        // misfit; only flag non-convergence when the misfit matters.
        if (!lmRes.converged && isFinite(pHi - pLo) && rmse > 0.002 * (pHi - pLo)) {
            warnings.push('The solver stopped before converging; treat the result as indicative.');
        }

        // ─── Build final z for diagnostics & smoothness ────────────
        var zFinal = lmRes.x.slice(0, grid.nNodes);
        var smoothness = _tvStrict(zFinal);

        // ─── Done ──────────────────────────────────────────────────
        if (!opts.silent) {
            _ga4('prism_deconvolution_run', {
                nNodes:    grid.nNodes,
                converged: lmRes.converged,
                iter:      lmRes.iter,
                rmse:      rmse,
                lambda:    lambdaUsed
            });
        }

        var stepsOut = [];
        for (var so = 0; so < rate.steps.length; so++) {
            stepsOut.push({ t: rate.steps[so].t_start, q: rate.steps[so].q });
        }

        return {
            tau:        grid.tau,
            g:          g,
            gPrime:     gPrime,
            p_initial:  p_initial,
            pi_est:     p_initial,
            piIdentifiable: piIdentifiable,
            piFixed:    fixPi,
            injector:   injector,
            qRef:       _refRate(rate.steps),
            tStart:     rate.steps[0].t_start,
            steps:      stepsOut,
            residuals:  residuals,
            rmse:       rmse,
            converged:  lmRes.converged,
            iterations: lmRes.iter,
            lambda:     lambdaUsed,
            rationale:  rationale,
            warnings:   warnings,
            diagnostics: {
                nNodes:        grid.nNodes,
                rateChanges:   nChanges,
                smoothness:    smoothness,
                dataSS:        lmRes.dataSS,
                tvSS:          lmRes.tvSS,
                tikSS:         lmRes.tikSS,
                tauMin:        grid.tauMin,
                tauMax:        grid.tauMax,
                downsampled:   didDownsample,
                qMax:          rate.qMax,
                ssrHistory:    lmRes.history
            }
        };
    }

    // Log-spaced subsample helper. Keeps the first and last sample of
    // every flow period and picks the rest so they are roughly evenly
    // spaced in log(elapsed time since the period's rate change).
    function _logSubsample(t, p, steps, target) {
        var n = t.length;
        if (n <= target) return { t: t.slice(), p: p.slice() };
        var starts = [];
        for (var s = 0; s < steps.length; s++) if (steps[s].dq !== 0) starts.push(steps[s].t_start);
        var el = new Array(n), per = new Array(n);
        var a = -1, lo = Infinity, hi = -Infinity;
        for (var i = 0; i < n; i++) {
            while (a + 1 < starts.length && starts[a + 1] < t[i]) a++;
            per[i] = a;
            el[i] = (a >= 0) ? t[i] - starts[a] : NaN;
            if (el[i] > 0) { if (el[i] < lo) lo = el[i]; if (el[i] > hi) hi = el[i]; }
        }
        var nPer = Math.max(1, starts.length);
        var dl = (isFinite(lo) && hi > lo)
            ? (Math.log(hi) - Math.log(lo)) * nPer / Math.max(target - 2 * nPer, 10)
            : 0;
        var keep = [];
        var lastLn = null;
        for (var k = 0; k < n; k++) {
            var edge = (k === 0 || k === n - 1 || per[k] !== per[k - 1] || per[k + 1] !== per[k]);
            var ln = (el[k] > 0) ? Math.log(el[k]) : null;
            if (edge) { keep.push(k); lastLn = ln; continue; }
            if (ln === null) continue;
            if (lastLn === null || ln - lastLn >= dl) { keep.push(k); lastLn = ln; }
        }
        var tOut = new Array(keep.length), pOut = new Array(keep.length);
        for (var m = 0; m < keep.length; m++) {
            tOut[m] = t[keep[m]];
            pOut[m] = p[keep[m]];
        }
        return { t: tOut, p: pOut };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 11 — CONVENIENCE WRAPPERS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Compute Σ Δq_i · g(t_eval - t_i) at each t_eval.
     *
     * @param {number[]} t_eval  Times at which to evaluate convolution.
     * @param {number[]} t_rate  Times at which rate steps START.
     * @param {number[]} q       Rate values at each step.
     * @param {number[]} g       Unit-rate response samples on tau grid.
     * @param {number[]} tau     Grid of response times.
     * @returns {number[]}       Convolved response.
     */
    function PRiSM_convolve_rate_response(t_eval, t_rate, q, g, tau) {
        if (!Array.isArray(t_eval) || !Array.isArray(t_rate) || !Array.isArray(q)
            || !Array.isArray(g) || !Array.isArray(tau)) {
            throw new Error('PRiSM_convolve_rate_response: arrays required');
        }
        if (t_rate.length !== q.length) {
            throw new Error('PRiSM_convolve_rate_response: t_rate and q must match length');
        }
        if (g.length !== tau.length) {
            throw new Error('PRiSM_convolve_rate_response: g and tau must match length');
        }

        // Build a steps list from t_rate / q.
        var steps = [];
        var qPrev = 0;
        for (var i = 0; i < t_rate.length; i++) {
            steps.push({ t_start: t_rate[i], q: q[i], dq: q[i] - qPrev });
            qPrev = q[i];
        }
        var lnTau = new Array(tau.length);
        for (var j = 0; j < tau.length; j++) lnTau[j] = Math.log(tau[j]);
        var convIdx = _buildConvIdx(t_eval, steps, lnTau, tau[0], tau[tau.length - 1]);
        // forwardP returns p_i − Σ Δq · g, so Σ Δq · g = p_i − p_pred.
        // Set p_i = 0 → result is the negation of what we want.
        var pPred = _forwardP(convIdx, g, 0);
        var out = new Array(pPred.length);
        for (var k = 0; k < pPred.length; k++) out[k] = -pPred[k];
        return out;
    }

    /**
     * One-call convenience: deconvolve and return the unit-rate
     * pressure response in standard PRiSM dataset format.
     *
     * @returns {{ t_unit: number[], p_unit: number[] }}
     *   t_unit = tau grid
     *   p_unit = absolute pressure at unit-rate (p_initial − g(τ))
     *            so it looks like a constant-rate drawdown.
     */
    function PRiSM_invert_to_unit_rate(t, p, q, opts) {
        var res = PRiSM_deconvolve(t, p, q, opts);
        var t_unit = res.tau.slice();
        var p_unit = new Array(res.tau.length);
        var sgn = res.injector ? -1 : 1;
        for (var i = 0; i < res.tau.length; i++) {
            p_unit[i] = res.p_initial - sgn * res.g[i];
        }
        return { t_unit: t_unit, p_unit: p_unit, full: res };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 11B — DATASET WORKFLOW (shared contracts C1 / C2)
    // ═══════════════════════════════════════════════════════════════
    // State lives on window.PRiSM_deconvState so a panel re-render keeps
    // the last result:
    //   { lastResult, sourceDs, original, responseDs }

    function _state() {
        if (!G.PRiSM_deconvState || typeof G.PRiSM_deconvState !== 'object') {
            G.PRiSM_deconvState = { lastResult: null, sourceDs: null, original: null, responseDs: null };
        }
        return G.PRiSM_deconvState;
    }

    function _firstStart(h) {
        if (!h) return null;
        var v = _num(h.t0);
        if (v === null) v = _num(h.tStart);
        if (v === null) v = _num(h.t);
        return v;
    }

    // Describe what a run on `ds` would use (panel summary + guards).
    function _dataSummary(ds) {
        var out = { ok: false, n: 0, nChanges: 0, stepsSource: null, qRef: null,
                    testType: 'auto', reason: '' };
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || ds.t.length < 3) {
            out.reason = 'Load a dataset with time and pressure on the Data step first.';
            return out;
        }
        out.n = ds.t.length;
        var ad = _getAnalysisData(ds);
        var well = _getWell() || {};
        out.testType = (well.testType && well.testType !== 'auto') ? well.testType
                     : (ad && ad.testType) || 'auto';
        var rate = null;
        if (Array.isArray(ds.q) && ds.q.length === ds.t.length) {
            rate = _compactRateSteps(ds.t, ds.q, 1e-6, _autoStart(ds.t));
            out.stepsSource = 'rate column';
        } else if (ad) {
            rate = _stepsFromHistory((ad.periods && ad.periods.length) ? ad.periods : ad.rateHistory, 1);
            if (rate) out.stepsSource = 'flow periods';
        }
        if (!rate || !rate.steps.length) {
            out.reason = 'No rate history: the dataset has no rate column and no flow periods are defined.';
            return out;
        }
        for (var i = 0; i < rate.steps.length; i++) if (rate.steps[i].dq !== 0) out.nChanges++;
        out.qRef = _refRate(rate.steps);
        if (!out.nChanges) { out.reason = 'The rate history is zero everywhere.'; return out; }
        out.ok = true;
        return out;
    }

    /**
     * Deconvolve the working dataset (or `ds`). Inputs come from the
     * shared contracts: the rate column (else the C2 flow periods /
     * rate history), the test type (injection / falloff → injector),
     * and the well's pi (C1) as the starting guess for p_i. p_i itself
     * is always solved for.
     */
    function PRiSM_deconvolveDataset(ds, opts) {
        opts = opts || {};
        ds = ds || G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || ds.t.length < 3) {
            throw new Error('Load a dataset with time and pressure first.');
        }
        var ad = _getAnalysisData(ds);
        var well = _getWell() || {};
        var hasQ = Array.isArray(ds.q) && ds.q.length === ds.t.length;
        var t = [], p = [], q = hasQ ? [] : null;
        for (var i = 0; i < ds.t.length; i++) {
            var ti = +ds.t[i], pi = +ds.p[i];
            if (!isFinite(ti) || !isFinite(pi)) continue;
            if (t.length && ti <= t[t.length - 1]) continue;       // strictly increasing time
            t.push(ti); p.push(pi);
            if (hasQ) q.push(isFinite(+ds.q[i]) ? +ds.q[i] : 0);
        }
        if (t.length < 3) throw new Error('Need at least 3 valid (t, p) samples.');

        var sub = {};
        for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) sub[k] = opts[k];
        var stepsSource = 'rate column';
        if (!hasQ) {
            var hist = ad ? ((ad.periods && ad.periods.length) ? ad.periods : ad.rateHistory) : null;
            if (!Array.isArray(hist) || !hist.length) {
                throw new Error('No rate history: the dataset has no rate column and no flow periods are defined.');
            }
            sub.steps = hist;
            stepsSource = 'flow periods';
        } else if (sub.tStart == null && ad) {
            // Time origin of production from the rate history when it has one.
            var per = (ad.periods && ad.periods[0]) || (ad.rateHistory && ad.rateHistory[0]);
            var ts = _firstStart(per);
            if (ts !== null && ts <= t[0]) sub.tStart = ts;
        }
        var testType = (well.testType && well.testType !== 'auto') ? well.testType
                     : (ad && ad.testType) || 'auto';
        if (sub.injector == null) sub.injector = (testType === 'injection' || testType === 'falloff');
        var pInitSource = 'data';
        if (sub.pInit == null && _num(well.pi) !== null) { sub.pInit = well.pi; pInitSource = 'well'; }

        var res = PRiSM_deconvolve(t, p, q, sub);
        res.inputs = {
            n: t.length, testType: testType, injector: !!sub.injector,
            stepsSource: stepsSource, pInitSource: pInitSource,
            wellPi: _num(well.pi), fluid: well.fluid || 'oil'
        };
        var S = _state();
        S.lastResult = res;
        S.sourceDs = ds;
        return res;
    }

    /**
     * Write the estimated initial pressure to the well store (C1) with
     * provenance 'deconvolution'. Returns the value written (or null).
     */
    function PRiSM_applyDeconvolvedPi(piEst) {
        var S = _state();
        if (piEst == null && S.lastResult) piEst = S.lastResult.p_initial;
        var v = _num(piEst == null ? null : +piEst);
        if (v === null) return null;
        v = Math.round(v * 100) / 100;
        if (typeof G.PRiSM_setWell === 'function') {
            try {
                G.PRiSM_setWell({ p_res: v }, { source: 'deconvolution' });
                _ga4('prism_deconvolution_apply_pi', { pi: v });
                return v;
            } catch (e) { /* fall back to the direct write */ }
        }
        var pvt = G.PRiSM_pvt = G.PRiSM_pvt || {};
        pvt.p_res = v;
        if (!pvt.provenance || typeof pvt.provenance !== 'object') pvt.provenance = {};
        pvt.provenance.p_res = 'deconvolution';
        if (typeof G.PRiSM_pvt_compute === 'function') {
            try { G.PRiSM_pvt_compute(); } catch (e) { /* ignore */ }
        }
        _dispatch('prism:well-changed', { keys: ['p_res'], source: 'deconvolution' });
        _ga4('prism_deconvolution_apply_pi', { pi: v });
        return v;
    }

    /**
     * Make the deconvolved response the working dataset: an equivalent
     * constant-rate test at q_ref (the last non-zero rate), p = p_i ∓ q_ref·g.
     * The measured data are kept for PRiSM_restoreDeconvolutionSource().
     */
    function PRiSM_useDeconvolvedResponse(res) {
        var S = _state();
        res = res || S.lastResult;
        if (!res || !Array.isArray(res.tau) || !Array.isArray(res.g)) return null;
        var qRef = res.qRef || 1;
        var sgn = res.injector ? -1 : 1;
        var t = [], p = [], q = [];
        for (var i = 0; i < res.tau.length; i++) {
            if (!(res.tau[i] > 0) || !isFinite(res.g[i])) continue;
            t.push(res.tau[i]);
            p.push(res.p_initial - sgn * qRef * res.g[i]);
            q.push(qRef);
        }
        if (t.length < 3) return null;
        var cur = G.PRiSM_dataset;
        if (!S.original || cur !== S.responseDs) S.original = cur || null;
        var ds = {
            t: t, p: p, q: q, timeUnit: 'h', source: 'deconvolution',
            deconv: { lambda: res.lambda, p_initial: res.p_initial, qRef: qRef, injector: !!res.injector }
        };
        S.responseDs = ds;
        _commitDataset(ds, 'deconvolution');
        _ga4('prism_deconvolution_save', { nNodes: t.length });
        return ds;
    }

    /** Put back the measured data replaced by PRiSM_useDeconvolvedResponse. */
    function PRiSM_restoreDeconvolutionSource() {
        var S = _state();
        if (!S.original) return null;
        if (G.PRiSM_dataset !== S.responseDs) {       // other data loaded since — nothing to restore
            S.original = null; S.responseDs = null;
            return null;
        }
        var ds = S.original;
        S.original = null; S.responseDs = null;
        _commitDataset(ds, 'deconvolution-restore');
        return ds;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 12 — UI RENDER (PRiSM_renderDeconvolutionPanel)
    // ═══════════════════════════════════════════════════════════════
    //
    // Host-themed (CSS variables) and usable at 375 px. Mounted as the
    // Tab 2 panel "Advanced: deconvolution" (C7). Every element is looked
    // up inside the container, so the same panel can also be shown in a
    // tools drawer.
    //   • data summary: points, rate changes, test type, q_ref
    //   • solver settings (nodes, λ, τ range) — collapsed
    //   • Run → Δp and derivative of the equivalent constant-rate test
    //   • p_i estimate → "Apply estimated pi" (C1, provenance deconvolution)
    //   • "Use response as analysis data" / "Restore measured data"
    //
    // ═══════════════════════════════════════════════════════════════

    var C = {
        bg: 'var(--bg1,#0d1117)', panel: 'var(--bg2,#161b22)', border: 'var(--border,#30363d)',
        text: 'var(--text,#e6edf3)', text2: 'var(--text2,#8b949e)', text3: 'var(--text3,#6e7681)',
        accent: 'var(--accent,#f0883e)', green: 'var(--green,#3fb950)', red: 'var(--red,#f85149)',
        yellow: 'var(--yellow,#d29922)', blue: 'var(--blue,#58a6ff)'
    };

    function _esc(s) {
        if (s == null) return '';
        return ('' + s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function _fmt1(v) { return (_num(v) === null) ? '—' : v.toFixed(1); }

    var _INPUT = 'width:100%; box-sizing:border-box; padding:5px 6px; background:' + C.bg + '; color:' + C.text
               + '; border:1px solid ' + C.border + '; border-radius:4px; font-size:12px;';
    var _LTXT  = 'font-size:10.5px; color:' + C.text2 + '; text-transform:uppercase; letter-spacing:.4px;';

    function _btn(id, label, kind, disabled, title) {
        var primary = (kind === 'primary');
        return '<button type="button" id="' + id + '" class="btn ' + (primary ? 'btn-primary' : 'btn-secondary') + '"'
            + (disabled ? ' disabled' : '') + (title ? ' title="' + _esc(title) + '"' : '')
            + ' style="padding:6px 12px; min-height:32px; border-radius:4px; font-size:12px; font-weight:600; cursor:pointer;'
            + ' border:1px solid ' + (primary ? C.accent : C.border) + '; background:' + (primary ? C.accent : C.panel)
            + '; color:' + (primary ? '#0d1117' : C.text) + ';' + (disabled ? ' opacity:.55; cursor:default;' : '') + '">'
            + _esc(label) + '</button>';
    }

    function _q(host, id) {
        var el = (host && host.querySelector) ? host.querySelector('#' + id) : null;
        return el || null;
    }

    function _summaryHTML(sum) {
        if (!sum.ok) return '<span style="color:' + C.yellow + ';">' + _esc(sum.reason) + '</span>';
        var tt = sum.testType === 'auto' ? 'auto-detected' : sum.testType;
        var s = '<b>' + sum.n + '</b> points · <b>' + sum.nChanges + '</b> rate change'
              + (sum.nChanges === 1 ? '' : 's') + ' (' + _esc(sum.stepsSource) + ') · test: ' + _esc(tt)
              + ' · reference rate q<sub>ref</sub> = ' + _esc(sum.qRef);
        if (sum.nChanges < 2) {
            s += '<div style="margin-top:4px; color:' + C.yellow + ';">Only one flow period: the response can be'
               + ' rebuilt but p<sub>i</sub> cannot be estimated independently. A rate change or a shut-in is needed.</div>';
        }
        return s;
    }

    function _readSettings(host) {
        var o = {};
        var nEl = _q(host, 'prism_dec_nNodes');
        var n = nEl ? parseInt(nEl.value, 10) : NaN;
        if (isFinite(n)) o.nNodes = Math.max(20, Math.min(200, n));
        var lEl = _q(host, 'prism_dec_lambda');
        var lam = lEl ? String(lEl.value || '').trim() : '';
        if (lam && lam.toLowerCase() !== 'auto' && isFinite(parseFloat(lam))) o.lambda = parseFloat(lam);
        var a = _q(host, 'prism_dec_tauMin'), b = _q(host, 'prism_dec_tauMax');
        var tn = a ? parseFloat(a.value) : NaN, tx = b ? parseFloat(b.value) : NaN;
        if (isFinite(tn) && tn > 0) o.tauMin = tn;
        if (isFinite(tx) && tx > 0) o.tauMax = tx;
        return o;
    }

    function _setMsg(host, html) {
        var m = _q(host, 'prism_dec_msg');
        if (m) m.innerHTML = html;
    }

    function _renderResult(host, res) {
        var box = _q(host, 'prism_dec_result');
        if (!box || !res) return;
        var S = _state();
        var well = _getWell() || {};
        var wellPi = _num(well.pi);
        var h = [];
        h.push('<canvas id="prism_dec_canvas" width="720" height="380" style="display:block; width:100%; max-width:720px;'
            + ' height:auto; background:' + C.bg + '; border:1px solid ' + C.border + '; border-radius:4px;"></canvas>');
        h.push('<div id="prism_dec_diag" style="margin-top:10px; padding:10px; background:' + C.bg + '; border-left:3px solid '
            + (res.piIdentifiable ? C.green : C.yellow) + '; border-radius:4px; line-height:1.5;">');
        h.push('<div style="display:flex; flex-wrap:wrap; gap:4px 16px; align-items:baseline;">');
        h.push('<div><span style="color:' + C.text2 + ';">'
            + (res.piFixed ? 'Initial pressure p<sub>i</sub> (held at the well value)' : 'Estimated initial pressure p<sub>i</sub>')
            + '</span> <b id="prism_dec_pi" style="font-size:16px; font-family:monospace;">' + _fmt1(res.p_initial) + '</b> psia</div>');
        h.push('<div style="color:' + C.text2 + ';">Well p<sub>i</sub>: '
            + (wellPi === null ? 'not set' : _fmt1(wellPi) + ' psia (Δ ' + ((res.p_initial - wellPi) >= 0 ? '+' : '')
               + (res.p_initial - wellPi).toFixed(1) + ' psi)') + '</div>');
        h.push('</div>');
        for (var w = 0; w < (res.warnings || []).length; w++) {
            h.push('<div style="margin-top:4px; color:' + C.yellow + ';">⚠ ' + _esc(res.warnings[w]) + '</div>');
        }
        var canRestore = !!(S.original && G.PRiSM_dataset === S.responseDs);
        h.push('<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">');
        h.push(_btn('prism_dec_apply_pi', 'Apply estimated pi', 'primary', !res.piIdentifiable,
            res.piIdentifiable ? 'Write p_i to the Well & Test inputs' : 'Needs at least two flow periods'));
        h.push(_btn('prism_dec_save', 'Use response as analysis data', null, false,
            'Replace the working data with the equivalent constant-rate test'));
        h.push(_btn('prism_dec_restore', 'Restore measured data', null, !canRestore));
        h.push('</div>');
        h.push('<div id="prism_dec_msg" style="margin-top:6px; min-height:14px; font-size:11.5px; color:' + C.text2 + ';"></div>');
        h.push('<details style="margin-top:6px;"><summary style="cursor:pointer; color:' + C.text2 + ';">Solver details</summary>'
            + '<div style="margin-top:4px; color:' + C.text2 + '; font-size:11.5px;">'
            + (res.converged ? 'Converged' : 'Not converged') + ' in ' + res.iterations + ' iterations · RMSE '
            + res.rmse.toFixed(3) + ' psi · nodes ' + res.diagnostics.nNodes + ' · rate changes '
            + res.diagnostics.rateChanges + ' · Δt range ' + res.diagnostics.tauMin.toPrecision(3) + '–'
            + res.diagnostics.tauMax.toPrecision(4) + ' h · ' + _esc(res.rationale)
            + (res.inputs ? ' · rates from ' + _esc(res.inputs.stepsSource) + ' · start guess from ' + _esc(res.inputs.pInitSource) : '')
            + '</div></details>');
        h.push('</div>');
        box.innerHTML = h.join('');

        _drawDeconvCanvas(_q(host, 'prism_dec_canvas'), res);

        var bApply = _q(host, 'prism_dec_apply_pi');
        var bSave = _q(host, 'prism_dec_save');
        var bRest = _q(host, 'prism_dec_restore');
        if (bApply) bApply.addEventListener('click', function () {
            if (!res.piIdentifiable) return;
            var v = PRiSM_applyDeconvolvedPi(res.p_initial);
            _renderResult(host, res);
            _setMsg(host, v === null
                ? '<span style="color:' + C.red + ';">Could not write the initial pressure.</span>'
                : '<span style="color:' + C.green + ';">Initial pressure set to ' + _fmt1(v)
                  + ' psia (source: deconvolution). Δp is now measured from it.</span>');
        });
        if (bSave) bSave.addEventListener('click', function () {
            var ds = PRiSM_useDeconvolvedResponse(res);
            _renderResult(host, res);
            _setMsg(host, ds
                ? '<span style="color:' + C.green + ';">The working data is now the deconvolved response ('
                  + ds.t.length + ' points at q<sub>ref</sub> = ' + _esc(res.qRef) + '). The measured data can be restored.</span>'
                : '<span style="color:' + C.red + ';">Nothing to use — run the deconvolution first.</span>');
        });
        if (bRest) bRest.addEventListener('click', function () {
            var ds = PRiSM_restoreDeconvolutionSource();
            _renderResult(host, res);
            _setMsg(host, ds
                ? '<span style="color:' + C.green + ';">Measured data restored.</span>'
                : '<span style="color:' + C.text2 + ';">Nothing to restore.</span>');
        });
    }

    function PRiSM_renderDeconvolutionPanel(container, opts) {
        if (!_hasDoc) return;
        opts = opts || {};
        var host = (typeof container === 'string') ? document.getElementById(container) : container;
        if (!host) return;

        var S = _state();
        var ds = G.PRiSM_dataset || null;
        var sum = _dataSummary(ds);

        var h = [];
        h.push('<div class="prism-deconv" style="font-size:12px; color:' + C.text + '; max-width:100%; box-sizing:border-box;'
            + (opts.embedded ? '' : ' border:1px solid ' + C.border + '; border-radius:6px; padding:12px; background:' + C.panel + ';')
            + '">');
        if (!opts.embedded) h.push('<div style="font-weight:700; font-size:14px; margin-bottom:6px;">Advanced: deconvolution</div>');
        h.push('<div style="color:' + C.text2 + '; line-height:1.5; margin-bottom:8px;">Rebuilds the constant-rate pressure'
            + ' response and the initial reservoir pressure p<sub>i</sub> from a test with several flow periods'
            + ' (for example a drawdown followed by a shut-in).</div>');
        h.push('<div id="prism_dec_summary" style="padding:8px 10px; background:' + C.bg + '; border-left:3px solid '
            + ((sum.ok && sum.nChanges >= 2) ? C.blue : C.yellow) + '; border-radius:4px; margin-bottom:10px; line-height:1.5;">'
            + _summaryHTML(sum) + '</div>');
        if (!sum.ok) {
            h.push('</div>');
            host.innerHTML = h.join('');
            return;
        }
        h.push('<details style="margin-bottom:10px;"><summary style="cursor:pointer; color:' + C.text2 + ';">Solver settings</summary>');
        h.push('<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:8px; margin-top:8px;">');
        h.push('<label style="display:flex; flex-direction:column; gap:3px; min-width:0;"><span style="' + _LTXT + '">Nodes</span>'
            + '<input type="number" id="prism_dec_nNodes" value="80" min="20" max="200" step="10" style="' + _INPUT + '"></label>');
        h.push('<label style="display:flex; flex-direction:column; gap:3px; min-width:0;"><span style="' + _LTXT + '">Smoothing λ</span>'
            + '<input type="text" id="prism_dec_lambda" value="auto" placeholder="auto or 1e-3" style="' + _INPUT + '"></label>');
        h.push('<label style="display:flex; flex-direction:column; gap:3px; min-width:0;"><span style="' + _LTXT + '">Δt min (h)</span>'
            + '<input type="text" id="prism_dec_tauMin" value="auto" style="' + _INPUT + '"></label>');
        h.push('<label style="display:flex; flex-direction:column; gap:3px; min-width:0;"><span style="' + _LTXT + '">Δt max (h)</span>'
            + '<input type="text" id="prism_dec_tauMax" value="auto" style="' + _INPUT + '"></label>');
        h.push('</div></details>');
        h.push('<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">'
            + _btn('prism_dec_run', 'Run deconvolution', 'primary') + '</div>');
        h.push('<div id="prism_dec_status" style="font-size:11.5px; color:' + C.text2 + '; min-height:14px; margin-bottom:8px;"></div>');
        h.push('<div id="prism_dec_result"></div>');
        h.push('</div>');
        host.innerHTML = h.join('');

        var btnRun = _q(host, 'prism_dec_run');
        if (btnRun) btnRun.addEventListener('click', function () {
            var status = _q(host, 'prism_dec_status');
            var o = _readSettings(host);
            o.onProgress = function (it, ssr) {
                var s = _q(host, 'prism_dec_status');
                if (s) s.textContent = 'Iteration ' + it + ' · SSR ' + ssr.toExponential(2);
            };
            if (status) status.textContent = 'Running…';
            // One-shot deferral so the status line can paint first.
            setTimeout(function () {
                var nowFn = (typeof performance !== 'undefined' && performance.now)
                    ? function () { return performance.now(); } : function () { return Date.now(); };
                var t0 = nowFn();
                var res;
                try { res = PRiSM_deconvolveDataset(G.PRiSM_dataset, o); }
                catch (e) {
                    var s1 = _q(host, 'prism_dec_status');
                    if (s1) s1.innerHTML = '<span style="color:' + C.red + ';">' + _esc(e && e.message) + '</span>';
                    return;
                }
                var s2 = _q(host, 'prism_dec_status');
                if (s2) {
                    s2.textContent = (res.converged ? 'Converged' : 'Stopped') + ' after ' + res.iterations
                        + ' iterations · RMSE ' + res.rmse.toFixed(2) + ' psi · ' + Math.round(nowFn() - t0) + ' ms';
                }
                _renderResult(host, res);
            }, 20);
        });

        // Keep the last result on re-render (same source data, or its response).
        if (S.lastResult && (S.sourceDs === ds || (S.responseDs && S.responseDs === ds))) {
            _renderResult(host, S.lastResult);
        }
    }

    function _fmtTick(e) {
        if (e < -3 || e > 5) return '1e' + e;
        return (e < 0) ? Math.pow(10, e).toFixed(-e) : String(Math.round(Math.pow(10, e)));
    }

    // Log-log plot of the rate-normalised response Δp = q_ref·g(Δt) and its
    // derivative (psi), i.e. the equivalent constant-rate test. Self-contained
    // canvas renderer (dark palette of the host theme).
    function _drawDeconvCanvas(canvas, res) {
        if (!canvas || !canvas.getContext || !res) return;
        var ctx = canvas.getContext('2d');
        if (!ctx) return;

        var W = canvas.width, H = canvas.height;
        var pad = { top: 26, right: 20, bottom: 44, left: 58 };
        var pw = W - pad.left - pad.right;
        var ph = H - pad.top - pad.bottom;

        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, W, H);

        var tau = res.tau || [];
        var g   = res.g || [];
        var gp  = res.gPrime || [];
        var sc  = res.qRef || 1;

        var pts1 = [], pts2 = [];
        var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (var i = 0; i < tau.length; i++) {
            var y1 = sc * g[i], y2 = sc * gp[i];
            if (tau[i] > 0 && isFinite(y1) && y1 > 0) {
                pts1.push([tau[i], y1]);
                if (tau[i] < xMin) xMin = tau[i];
                if (tau[i] > xMax) xMax = tau[i];
                if (y1 < yMin) yMin = y1;
                if (y1 > yMax) yMax = y1;
            }
            if (tau[i] > 0 && isFinite(y2) && y2 > 0) {
                pts2.push([tau[i], y2]);
                if (y2 < yMin) yMin = y2;
                if (y2 > yMax) yMax = y2;
            }
        }
        if (!pts1.length && !pts2.length) {
            ctx.fillStyle = '#8b949e';
            ctx.font = '12px sans-serif';
            ctx.fillText('No positive response values to plot', pad.left + 10, pad.top + 20);
            return;
        }
        if (!(xMax > xMin)) { xMin = xMin / 10; xMax = xMax * 10; }
        if (yMin === yMax) { yMin = yMin / 10; yMax = yMax * 10; }
        yMin *= 0.5; yMax *= 2;

        var lxMin = Math.log10(xMin), lxMax = Math.log10(xMax);
        var lyMin = Math.log10(yMin), lyMax = Math.log10(yMax);
        function tx(x) { return pad.left + (Math.log10(x) - lxMin) / (lxMax - lxMin) * pw; }
        function ty(y) { return pad.top + ph - (Math.log10(y) - lyMin) / (lyMax - lyMin) * ph; }

        ctx.strokeStyle = '#21262d';
        ctx.lineWidth = 1;
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#8b949e';
        for (var dx = Math.ceil(lxMin); dx <= Math.floor(lxMax); dx++) {
            var xp = tx(Math.pow(10, dx));
            ctx.beginPath(); ctx.moveTo(xp, pad.top); ctx.lineTo(xp, pad.top + ph); ctx.stroke();
            ctx.textAlign = 'center';
            ctx.fillText(_fmtTick(dx), xp, pad.top + ph + 14);
        }
        for (var dy = Math.ceil(lyMin); dy <= Math.floor(lyMax); dy++) {
            var yp = ty(Math.pow(10, dy));
            ctx.beginPath(); ctx.moveTo(pad.left, yp); ctx.lineTo(pad.left + pw, yp); ctx.stroke();
            ctx.textAlign = 'right';
            ctx.fillText(_fmtTick(dy), pad.left - 6, yp + 4);
        }
        ctx.textAlign = 'left';

        ctx.strokeStyle = '#30363d';
        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top);
        ctx.lineTo(pad.left, pad.top + ph);
        ctx.lineTo(pad.left + pw, pad.top + ph);
        ctx.stroke();

        if (pts1.length) {
            ctx.strokeStyle = '#58a6ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (var k = 0; k < pts1.length; k++) {
                var px = tx(pts1[k][0]), py = ty(pts1[k][1]);
                if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }
        if (pts2.length) {
            ctx.fillStyle = '#f0883e';
            for (var k2 = 0; k2 < pts2.length; k2++) {
                ctx.beginPath();
                ctx.arc(tx(pts2[k2][0]), ty(pts2[k2][1]), 2.4, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        ctx.fillStyle = '#e6edf3';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Elapsed time Δt (h)', pad.left + pw / 2, H - 10);
        ctx.save();
        ctx.translate(14, pad.top + ph / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('Δp, Δp′ (psi)', 0, 0);
        ctx.restore();
        ctx.textAlign = 'left';

        ctx.fillStyle = '#58a6ff';
        ctx.fillText('— Δp', pad.left + pw - 70, pad.top + 14);
        ctx.fillStyle = '#f0883e';
        ctx.fillText('• Δp′', pad.left + pw - 70, pad.top + 28);

        ctx.fillStyle = '#e6edf3';
        ctx.font = '12px sans-serif';
        ctx.fillText('Constant-rate response at q_ref = ' + sc, pad.left, pad.top - 9);
    }


    // ═══════════════════════════════════════════════════════════════
    // EXPORTS + PANEL REGISTRATION (C7)
    // ═══════════════════════════════════════════════════════════════
    G.PRiSM_deconvolve                  = PRiSM_deconvolve;
    G.PRiSM_deconvolve_lcurve           = PRiSM_deconvolve_lcurve;
    G.PRiSM_convolve_rate_response      = PRiSM_convolve_rate_response;
    G.PRiSM_invert_to_unit_rate         = PRiSM_invert_to_unit_rate;
    G.PRiSM_deconvolveDataset           = PRiSM_deconvolveDataset;
    G.PRiSM_applyDeconvolvedPi          = PRiSM_applyDeconvolvedPi;
    G.PRiSM_useDeconvolvedResponse      = PRiSM_useDeconvolvedResponse;
    G.PRiSM_restoreDeconvolutionSource  = PRiSM_restoreDeconvolutionSource;
    G.PRiSM_renderDeconvolutionPanel    = PRiSM_renderDeconvolutionPanel;

    _registerPanel(2, {
        id: 'prism_deconvolution',
        title: 'Advanced: deconvolution',
        order: 80,
        collapsed: true,
        tool: true,
        description: 'Constant-rate response and initial pressure from a test with several flow periods',
        render: function (hostEl) { PRiSM_renderDeconvolutionPanel(hostEl, { embedded: true }); }
    });


    // ═══════════════════════════════════════════════════════════════

})();

// ─── END 17-deconvolution ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 18-tide-analysis ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 18 — Tide Analysis (ocean-tide pressure correction
//                                    + ct estimate)
//   Detects astronomical tide harmonics in offshore pressure-gauge
//   data, fits their amplitudes/phases via linear least-squares, and
//   produces a corrected pressure record cleaned of the periodic
//   tidal signal. From the M2 amplitude response, an in-situ estimate
//   of the formation total compressibility ct can be obtained
//   (Bredehoeft 1967; Van der Kamp & Gale 1983; Van der Kamp 1990).
//
// PHYSICAL BACKGROUND
//   Solid-Earth tides cause a periodic dilatational strain that loads
//   the formation. The principal lunar semi-diurnal constituent (M2,
//   period 12.4206 h) is the strongest and dominates most offshore
//   pressure records. The amplitude of the M2 pressure response (R_M2,
//   in psi) divided by the theoretical M2 strain-induced load gives
//   a barometric/areal-strain efficiency, from which ct can be backed
//   out for a saturated, confined formation:
//
//       ct ≈ R_obs_M2 / ( R_theoretical_M2 · ρ_w·g · h · ξ )
//
//   where ξ ≈ 0.6 is the combined Love-number factor (h - 1.16·k₂)
//   and ρ_w·g ≈ 0.433 psi/ft for fresh water. The relation is
//   well-established for water-bearing intervals; in oil/gas zones it
//   provides a useful order-of-magnitude check against the PVT-derived
//   ct (window.PRiSM_pvt._computed.ct, when present).
//
// PUBLIC API (all on window.*)
//   PRiSM_tideAnalysis(t, p, opts)         → result object
//   PRiSM_applyTideCorrection(opts)        → corrected dataset (or null)
//   PRiSM_resetTideCorrection()            → restored dataset (or null)
//      Both replace window.PRiSM_dataset, dispatch 'prism:dataset-loaded'
//      and redraw through window.PRiSM_drawActivePlot. A correction is
//      always computed from the measured (uncorrected) pressures of the
//      dataset it was applied to; loading other data starts afresh.
//   PRiSM_renderTidePanel(container, opts) → void   (UI host helper;
//      registered as the Tab 1 panel "Tide correction", C7)
//   PRiSM_plot_tide_decomposition(canvas, data, opts) → void
//   PRiSM_TIDE_CONSTITUENTS                → constant table (10 entries)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • Pure vanilla JS, Math.*. No external dependencies.
//   • Time in HOURS (matches PRiSM convention). Tide periods in hours.
//   • Detrending: linear LS removes long-period reservoir drift before
//     harmonic fitting. Without it the fit chases the trend instead
//     of the tide.
//   • Quality-of-fit guard: if data duration < 2 × longest constituent
//     period, that constituent is skipped and a clear caveat appears
//     in `rationale`. Datasets shorter than minDuration_h skip the
//     fit entirely.
//   • Defensive output — returns ct_estimate: null when depth or
//     theoreticalM2_psi is missing/invalid; never throws on user input.
//   • Self-test at end (synthetic M2/S2/noise recovery + ct sanity).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims so the module loads in the smoke-test stub.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window
                          : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _theme() {
        if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
        return {
            bg:        '#0d1117', panel: '#161b22', border: '#30363d',
            grid:      '#21262d', gridMajor: '#30363d',
            text:      '#c9d1d9', text2: '#8b949e', text3: '#6e7681',
            accent:    '#f0883e', blue: '#58a6ff', green: '#3fb950',
            red:       '#f85149', yellow: '#d29922', cyan: '#39c5cf',
            purple:    '#bc8cff'
        };
    }

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }

    function _esc(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        d = (d == null) ? 3 : d;
        var a = Math.abs(v);
        if (a !== 0 && (a < 1e-3 || a >= 1e6)) return Number(v).toExponential(2);
        return Number(v).toFixed(d);
    }


    // ───────────────────────────────────────────────────────────────
    // Shared-contract adapters (C1 well, C7 panels + events). Guarded,
    // with local fallbacks, so the file also works on its own.
    // ───────────────────────────────────────────────────────────────

    // C1 total compressibility (user override, else correlations).
    function _wellCt() {
        if (typeof G.PRiSM_getWell === 'function') {
            try {
                var w = G.PRiSM_getWell();
                if (w && isFinite(w.ct) && w.ct > 0) return w.ct;
            } catch (e) { /* fall through */ }
        }
        var pvt = G.PRiSM_pvt;
        if (pvt && isFinite(pvt.ct) && pvt.ct > 0) return pvt.ct;
        var c = pvt && pvt._computed && pvt._computed.ct;
        return (isFinite(c) && c > 0) ? c : null;
    }

    function _dispatch(name, detail) {
        try {
            if (_hasWin && typeof G.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                G.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
            }
        } catch (e) { /* ignore */ }
    }

    // Every dataset mutation: publish, announce, redraw — through the single
    // commit path (PRiSM_commitDataset) when it is loaded, so the demo-input
    // release and the event contract (C7) apply to this module too.
    function _commitDataset(ds, source) {
        if (ds && ds.t && ds.t.length && typeof G.PRiSM_commitDataset === 'function') {
            G.PRiSM_commitDataset(ds, { source: source });
        } else {
            G.PRiSM_dataset = ds;
            _dispatch('prism:dataset-loaded', { source: source, n: (ds && ds.t) ? ds.t.length : 0 });
        }
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
    }

    // C7 — tab panel registry (merge; replace an entry with the same id).
    function _registerPanel(n, spec) {
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall through */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var list = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === spec.id) { list[i] = spec; return; }
        }
        list.push(spec);
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — ASTRONOMICAL TIDE CONSTITUENTS
    // ═══════════════════════════════════════════════════════════════
    // Ten principal constituents covering the semi-diurnal (~12 h),
    // diurnal (~24 h), and long-period (fortnightly / monthly) bands.
    // Periods are sidereal/synodic in mean solar hours; frequencies
    // are derived as 1 / period (cycles per hour) so that the
    // harmonic-regression basis is cos(2π·f·t) and sin(2π·f·t) with
    // t in hours.
    //
    // Source: Doodson constants tabulated in standard tide tables
    // (Pugh 1987, "Tides, Surges and Mean Sea-Level"; IHO 2006).
    // ═══════════════════════════════════════════════════════════════

    var PRiSM_TIDE_CONSTITUENTS = [
        { name: 'M2', desc: 'Principal lunar semi-diurnal',     period: 12.4206, type: 'semi-diurnal', isMajor: true  },
        { name: 'S2', desc: 'Principal solar semi-diurnal',     period: 12.0000, type: 'semi-diurnal', isMajor: true  },
        { name: 'N2', desc: 'Larger lunar elliptic semi-diurnal', period: 12.6583, type: 'semi-diurnal', isMajor: false },
        { name: 'K2', desc: 'Lunar-solar declinational semi-diurnal', period: 11.9672, type: 'semi-diurnal', isMajor: false },
        { name: 'K1', desc: 'Lunar-solar diurnal',              period: 23.9345, type: 'diurnal',      isMajor: true  },
        { name: 'O1', desc: 'Principal lunar diurnal',          period: 25.8193, type: 'diurnal',      isMajor: true  },
        { name: 'P1', desc: 'Principal solar diurnal',          period: 24.0659, type: 'diurnal',      isMajor: false },
        { name: 'Q1', desc: 'Larger lunar elliptic diurnal',    period: 26.8684, type: 'diurnal',      isMajor: false },
        { name: 'Mf', desc: 'Lunar fortnightly',                period: 327.86,  type: 'long-period',  isMajor: false },
        { name: 'Mm', desc: 'Lunar monthly',                    period: 661.31,  type: 'long-period',  isMajor: false }
    ];
    // Add freq (cycles/hr) for each.
    for (var _ci = 0; _ci < PRiSM_TIDE_CONSTITUENTS.length; _ci++) {
        PRiSM_TIDE_CONSTITUENTS[_ci].freq = 1.0 / PRiSM_TIDE_CONSTITUENTS[_ci].period;
    }
    G.PRiSM_TIDE_CONSTITUENTS = PRiSM_TIDE_CONSTITUENTS;

    // The 4 default majors — plenty of resolving power on multi-day
    // surveys and avoids ill-conditioning when N2/K2 collide with M2/S2.
    var DEFAULT_CONSTITUENT_NAMES = ['M2', 'S2', 'K1', 'O1'];

    function _constituentByName(name) {
        for (var i = 0; i < PRiSM_TIDE_CONSTITUENTS.length; i++) {
            if (PRiSM_TIDE_CONSTITUENTS[i].name === name) return PRiSM_TIDE_CONSTITUENTS[i];
        }
        return null;
    }

    // Resolve user list (strings or constituent objects) → constituent objects.
    function _resolveConstituents(list) {
        if (!Array.isArray(list) || !list.length) {
            list = DEFAULT_CONSTITUENT_NAMES;
        }
        var out = [];
        var seen = {};
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var c = null;
            if (typeof entry === 'string') {
                c = _constituentByName(entry);
            } else if (entry && typeof entry === 'object' && entry.name) {
                c = _constituentByName(entry.name);
            }
            if (c && !seen[c.name]) { out.push(c); seen[c.name] = true; }
        }
        return out;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — DETRENDING UTILITY
    // ═══════════════════════════════════════════════════════════════
    // Reservoir pressure has long-term drift (depletion, build-up
    // approaching shut-in pressure, etc.) at frequencies far below the
    // tide band. If left in the signal, the harmonic regression
    // chases the drift and reports inflated/biased amplitudes for
    // the longer-period constituents (Mf, Mm) and a wandering DC
    // offset that affects the conditioning of the design matrix.
    //
    // We remove a simple linear (a + b·t) least-squares fit. For
    // very long surveys a polynomial detrend would be better, but
    // linear is sufficient for the typical 1–14 day windows used
    // for tide analysis.
    // ═══════════════════════════════════════════════════════════════

    function _linearDetrend(t, p) {
        var n = (t && p) ? Math.min(t.length, p.length) : 0;
        if (n < 2) return { y: p ? p.slice() : [], a: 0, b: 0, mean: 0 };
        var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
        var i;
        for (i = 0; i < n; i++) {
            var ti = t[i], pi = p[i];
            if (!isFinite(ti) || !isFinite(pi)) continue;
            sx += ti; sy += pi; sxx += ti * ti; sxy += ti * pi; m++;
        }
        if (m < 2) return { y: p.slice(), a: 0, b: 0, mean: sy / Math.max(1, m) };
        var denom = m * sxx - sx * sx;
        var b = 0, a = sy / m;
        if (Math.abs(denom) > 1e-15) {
            b = (m * sxy - sx * sy) / denom;
            a = (sy - b * sx) / m;
        }
        var y = new Array(n);
        for (i = 0; i < n; i++) {
            y[i] = (isFinite(t[i]) && isFinite(p[i])) ? (p[i] - (a + b * t[i])) : 0;
        }
        return { y: y, a: a, b: b, mean: sy / m };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — HARMONIC REGRESSION
    // ═══════════════════════════════════════════════════════════════
    // Fit p_detrended(t) ≈ Σ_i [ A_i · cos(2π·f_i·t) + B_i · sin(2π·f_i·t) ]
    //
    // Linear in [A_1, B_1, ..., A_K, B_K] → ordinary least squares
    // via the normal equations:
    //
    //     (X^T X) · θ = X^T y
    //
    // The design matrix X is N × 2K. We assemble X^T X (2K × 2K)
    // and X^T y (2K) directly, then solve with Gauss-Jordan with
    // partial pivoting. K is small (≤ 10), so this is O(K^3) and
    // numerically stable for well-separated frequencies.
    //
    // Amplitude / phase recovery:
    //     R_i = √(A_i² + B_i²)
    //     φ_i = atan2(B_i, A_i)         (radians; range −π … π)
    //
    // Reconstruct fitted tide signal at each sample:
    //     p_tide(t) = Σ_i [ A_i · cos(2π·f_i·t) + B_i · sin(2π·f_i·t) ]
    // ═══════════════════════════════════════════════════════════════

    // Solve A·x = b in place. Returns x (length n) or null on singular.
    function _solveLinear(A, b) {
        var n = b.length;
        // Build augmented matrix.
        var M = new Array(n);
        for (var i = 0; i < n; i++) {
            M[i] = new Array(n + 1);
            for (var j = 0; j < n; j++) M[i][j] = A[i][j];
            M[i][n] = b[i];
        }
        // Gauss-Jordan with partial pivoting.
        for (var k = 0; k < n; k++) {
            // Pivot.
            var piv = k, max = Math.abs(M[k][k]);
            for (var r = k + 1; r < n; r++) {
                var v = Math.abs(M[r][k]);
                if (v > max) { max = v; piv = r; }
            }
            if (max < 1e-14) return null; // singular
            if (piv !== k) {
                var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp;
            }
            // Normalise pivot row.
            var div = M[k][k];
            for (var c = k; c <= n; c++) M[k][c] /= div;
            // Eliminate other rows.
            for (var r2 = 0; r2 < n; r2++) {
                if (r2 === k) continue;
                var f = M[r2][k];
                if (f === 0) continue;
                for (var c2 = k; c2 <= n; c2++) M[r2][c2] -= f * M[k][c2];
            }
        }
        var x = new Array(n);
        for (var ii = 0; ii < n; ii++) x[ii] = M[ii][n];
        return x;
    }

    // Fit harmonic coefficients [A_1, B_1, ..., A_K, B_K] for the
    // given list of frequencies (cycles/hr) against y(t).
    // Returns { theta, fitted, residual } or null on failure.
    function _harmonicFit(t, y, freqs) {
        var n = (t && y) ? Math.min(t.length, y.length) : 0;
        var K = freqs.length;
        if (n < 2 * K + 1 || K === 0) return null;

        var TWO_PI = 2 * Math.PI;
        var dim = 2 * K;

        // Build X^T X and X^T y in a single pass.
        var XtX = new Array(dim);
        for (var r = 0; r < dim; r++) {
            XtX[r] = new Array(dim);
            for (var c = 0; c < dim; c++) XtX[r][c] = 0;
        }
        var Xty = new Array(dim);
        for (var d = 0; d < dim; d++) Xty[d] = 0;

        // Cache 2π·f for each constituent.
        var w = new Array(K);
        for (var ki = 0; ki < K; ki++) w[ki] = TWO_PI * freqs[ki];

        // Row-by-row accumulation.
        var row = new Array(dim);
        var i, k, c2;
        for (i = 0; i < n; i++) {
            var ti = t[i], yi = y[i];
            if (!isFinite(ti) || !isFinite(yi)) continue;
            for (k = 0; k < K; k++) {
                var arg = w[k] * ti;
                row[2 * k]     = Math.cos(arg);
                row[2 * k + 1] = Math.sin(arg);
            }
            for (var rr = 0; rr < dim; rr++) {
                Xty[rr] += row[rr] * yi;
                for (c2 = rr; c2 < dim; c2++) {
                    XtX[rr][c2] += row[rr] * row[c2];
                }
            }
        }
        // Mirror upper triangle into lower.
        for (var rr2 = 0; rr2 < dim; rr2++) {
            for (var cc = 0; cc < rr2; cc++) {
                XtX[rr2][cc] = XtX[cc][rr2];
            }
        }

        var theta = _solveLinear(XtX, Xty);
        if (!theta) return null;

        // Reconstruct fitted signal + residual.
        var fitted = new Array(n);
        var residual = new Array(n);
        for (i = 0; i < n; i++) {
            var ti2 = t[i];
            var f = 0;
            if (isFinite(ti2)) {
                for (k = 0; k < K; k++) {
                    var arg2 = w[k] * ti2;
                    f += theta[2 * k] * Math.cos(arg2)
                       + theta[2 * k + 1] * Math.sin(arg2);
                }
            } else {
                f = NaN;
            }
            fitted[i] = f;
            residual[i] = isFinite(y[i]) ? (y[i] - f) : NaN;
        }
        return { theta: theta, fitted: fitted, residual: residual };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — ct ESTIMATION (Bredehoeft 1967)
    // ═══════════════════════════════════════════════════════════════
    // Areal-strain efficiency (Bredehoeft 1967; Van der Kamp & Gale 1983):
    //
    //     ct ≈ R_obs / ( R_th · ρ_w·g · h · ξ )
    //
    //   R_obs : observed M2 amplitude in the well (psi)
    //   R_th  : theoretical M2 strain-induced pressure (psi)
    //   ρ_w·g : 0.433 psi/ft for fresh water
    //   h     : reservoir depth (ft)
    //   ξ     : Love-number combination ≈ h₂ - 1.16·k₂ ≈ 0.6
    //
    // Returns ct in 1/psi. The formula is for a saturated, confined
    // aquifer; in oil/gas zones it should be treated as a sanity
    // bound on the PVT-derived ct rather than a ground truth.
    //
    // CAVEATS
    //   - R_th depends on latitude and local Earth-tide harmonic constants.
    //     The user-supplied default is 1.0 psi (ballpark for mid-latitude
    //     reservoirs at ~10 000 ft). Calibrate against published
    //     Earth-tide tables for higher fidelity.
    //   - The constant 0.6 (=ξ) varies between 0.55 and 0.65 for typical
    //     elastic Love-number assumptions.
    //   - This estimator captures matrix + pore-fluid bulk compressibility;
    //     it does NOT separate rock from fluid contributions.
    // ═══════════════════════════════════════════════════════════════

    var BREDEHOEFT_LOVE_FACTOR = 0.6;        // ξ = h₂ − 1.16·k₂
    var FRESH_WATER_GRADIENT_PSI_PER_FT = 0.433;

    function _estimate_ct(R_obs_M2, R_theoretical_M2, depth_ft) {
        if (!isFinite(R_obs_M2) || !isFinite(R_theoretical_M2) || !isFinite(depth_ft)) return null;
        if (R_theoretical_M2 <= 0 || depth_ft <= 0) return null;
        var denom = R_theoretical_M2 * FRESH_WATER_GRADIENT_PSI_PER_FT * depth_ft * BREDEHOEFT_LOVE_FACTOR;
        if (denom <= 0) return null;
        return R_obs_M2 / denom;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — CORE ENTRY POINT  PRiSM_tideAnalysis
    // ═══════════════════════════════════════════════════════════════

    // Compute relative noise (RMS residual / |mean p|) — small helper
    // for diagnostic SNR reporting.
    function _rms(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += arr[i] * arr[i]; n++; }
        }
        return n > 0 ? Math.sqrt(s / n) : 0;
    }
    function _meanAbs(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += Math.abs(arr[i]); n++; }
        }
        return n > 0 ? s / n : 0;
    }
    function _variance(arr) {
        var n = 0, s = 0, ss = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += arr[i]; ss += arr[i] * arr[i]; n++; }
        }
        if (n < 2) return 0;
        var m = s / n;
        return (ss - n * m * m) / (n - 1);
    }

    G.PRiSM_tideAnalysis = function PRiSM_tideAnalysis(t, p, opts) {
        opts = opts || {};
        var DEFAULTS = {
            constituents:      DEFAULT_CONSTITUENT_NAMES,
            detrend:           true,
            depth_ft:          null,
            theoreticalM2_psi: 1.0,
            minDuration_h:     48
        };
        // Merge.
        var o = {};
        for (var k in DEFAULTS) o[k] = (opts[k] === undefined) ? DEFAULTS[k] : opts[k];

        // Input validation.
        var nIn = (Array.isArray(t) && Array.isArray(p)) ? Math.min(t.length, p.length) : 0;
        var caveats = [];
        if (nIn < 4) {
            return {
                constituents: [],
                p_tide: [],
                p_corrected: (p || []).slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'Insufficient samples (n=' + nIn + '). Tide analysis requires at least a few dozen samples spanning several tide periods.'
            };
        }

        // Compact arrays of finite samples (preserve original order).
        var tt = [], pp = [], idx = [];
        for (var i = 0; i < nIn; i++) {
            if (isFinite(t[i]) && isFinite(p[i])) {
                tt.push(t[i]); pp.push(p[i]); idx.push(i);
            }
        }
        if (tt.length < 4) {
            return {
                constituents: [],
                p_tide: new Array(nIn).fill(0),
                p_corrected: p.slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'No finite samples after filtering NaNs.'
            };
        }

        // Duration.
        var t0 = tt[0], tN = tt[tt.length - 1];
        var duration_h = tN - t0;
        if (!isFinite(duration_h) || duration_h <= 0) {
            return {
                constituents: [],
                p_tide: new Array(nIn).fill(0),
                p_corrected: p.slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'Time array is not strictly increasing — tide analysis requires monotonic time in hours.'
            };
        }
        if (duration_h < o.minDuration_h) {
            caveats.push('Survey duration ' + duration_h.toFixed(1) + ' h is below the configured minimum (' + o.minDuration_h.toFixed(0) + ' h). Results may be poorly resolved.');
        }

        // Resolve requested constituents and drop those whose period
        // exceeds half the survey duration (Nyquist-like rule —
        // need ≥ 2 cycles to resolve amplitude+phase reliably).
        var requested = _resolveConstituents(o.constituents);
        if (!requested.length) {
            requested = _resolveConstituents(DEFAULT_CONSTITUENT_NAMES);
        }
        var fitList = [];
        var skipped = [];
        for (var ri = 0; ri < requested.length; ri++) {
            var c = requested[ri];
            if (c.period * 2 > duration_h) {
                skipped.push(c);
                caveats.push(c.name + ' (period ' + c.period.toFixed(2) + ' h) skipped — survey too short to resolve (need ≥ ' + (2 * c.period).toFixed(1) + ' h).');
                continue;
            }
            fitList.push(c);
        }
        if (!fitList.length) {
            return {
                constituents: [],
                p_tide: new Array(nIn).fill(0),
                p_corrected: p.slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'Survey duration ' + duration_h.toFixed(1) + ' h is too short for any requested constituent. ' + caveats.join(' ')
            };
        }

        // Detrend (linear LS) — operates on (tt, pp).
        var det = o.detrend ? _linearDetrend(tt, pp)
                            : { y: pp.slice(), a: 0, b: 0, mean: pp.reduce(function (s, v) { return s + v; }, 0) / pp.length };
        var y = det.y;

        // Harmonic regression on the detrended series.
        var freqs = fitList.map(function (c) { return c.freq; });
        var fit = _harmonicFit(tt, y, freqs);
        if (!fit) {
            return {
                constituents: [],
                p_tide: new Array(nIn).fill(0),
                p_corrected: p.slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'Harmonic regression failed (singular normal-equations matrix). Try fewer constituents or a longer dataset. ' + caveats.join(' ')
            };
        }

        // Extract amplitude / phase per constituent.
        var constOut = [];
        var TWO_PI = 2 * Math.PI;
        for (var fi = 0; fi < fitList.length; fi++) {
            var A = fit.theta[2 * fi];
            var B = fit.theta[2 * fi + 1];
            var R = Math.sqrt(A * A + B * B);
            var phi = Math.atan2(B, A);
            constOut.push({
                name:      fitList[fi].name,
                desc:      fitList[fi].desc,
                period:    fitList[fi].period,
                freq:      fitList[fi].freq,
                amplitude: R,
                phase:     phi,
                A:         A,
                B:         B,
                type:      fitList[fi].type
            });
        }

        // Build full-length p_tide and p_corrected aligned to original t/p.
        // The harmonic basis is evaluated at the original t for *all*
        // samples (not just the finite ones) so plot overlays line up.
        var p_tide = new Array(nIn).fill(0);
        var w = freqs.map(function (f) { return TWO_PI * f; });
        for (var ii = 0; ii < nIn; ii++) {
            var ti3 = t[ii];
            if (!isFinite(ti3)) { p_tide[ii] = 0; continue; }
            var v = 0;
            for (var jj = 0; jj < freqs.length; jj++) {
                v += fit.theta[2 * jj] * Math.cos(w[jj] * ti3)
                   + fit.theta[2 * jj + 1] * Math.sin(w[jj] * ti3);
            }
            p_tide[ii] = v;
        }
        var p_corrected = new Array(nIn);
        for (var ii2 = 0; ii2 < nIn; ii2++) {
            p_corrected[ii2] = isFinite(p[ii2]) ? (p[ii2] - p_tide[ii2]) : p[ii2];
        }

        // Diagnostics.
        var residual_rms = _rms(fit.residual);
        // SNR for M2 specifically: amplitude / RMS(residual).
        var m2 = null;
        for (var mi = 0; mi < constOut.length; mi++) {
            if (constOut[mi].name === 'M2') { m2 = constOut[mi]; break; }
        }
        var snr = (m2 && residual_rms > 0) ? (m2.amplitude / residual_rms) : 0;

        // Variance reduction sanity (corrected vs raw, on the
        // *detrended* data to avoid penalising long-term drift).
        var var_y    = _variance(y);
        var var_resid = _variance(fit.residual);
        var var_reduction_pct = (var_y > 0) ? (1 - var_resid / var_y) * 100 : 0;

        // ct estimate from M2.
        var ct = null;
        var ct_caveat = '';
        if (m2 && isFinite(o.depth_ft) && o.depth_ft > 0
                && isFinite(o.theoreticalM2_psi) && o.theoreticalM2_psi > 0) {
            ct = _estimate_ct(m2.amplitude, o.theoreticalM2_psi, o.depth_ft);
        } else {
            if (m2) {
                ct_caveat = 'ct estimation requires depth_ft and theoreticalM2_psi (both > 0).';
            } else {
                ct_caveat = 'ct estimation requires the M2 constituent in the fit list.';
            }
        }

        // Compare against the well's ct (C1: user value or PVT correlations).
        var pvtComparison = '';
        try {
            var pvt_ct = _wellCt();
            if (ct != null && isFinite(pvt_ct) && pvt_ct > 0) {
                var pct = Math.abs(ct - pvt_ct) / pvt_ct * 100;
                pvtComparison = ' Tide-derived ct = ' + ct.toExponential(2)
                              + ' 1/psi vs well ct = ' + pvt_ct.toExponential(2)
                              + ' 1/psi (Δ = ' + pct.toFixed(0) + '%).';
            }
        } catch (e) { /* swallow */ }

        // Compose rationale.
        var rationaleParts = [];
        rationaleParts.push('Fitted ' + fitList.length + ' constituent' + (fitList.length === 1 ? '' : 's')
                           + ' (' + fitList.map(function (c) { return c.name; }).join(', ')
                           + ') over ' + duration_h.toFixed(1) + ' h of data.');
        if (m2) {
            rationaleParts.push('M2 amplitude = ' + m2.amplitude.toFixed(3) + ' psi, residual RMS = '
                              + residual_rms.toFixed(3) + ' psi → SNR ≈ ' + snr.toFixed(1) + '.');
        }
        rationaleParts.push('Variance reduction (detrended): ' + var_reduction_pct.toFixed(0) + '%.');
        if (ct != null) {
            rationaleParts.push('ct ≈ ' + ct.toExponential(2)
                + ' 1/psi (Bredehoeft 1967, depth ' + o.depth_ft + ' ft, theoretical M2 '
                + o.theoreticalM2_psi + ' psi, Love factor ξ=' + BREDEHOEFT_LOVE_FACTOR + ').');
            if (pvtComparison) rationaleParts.push(pvtComparison.trim());
        } else if (ct_caveat) {
            rationaleParts.push(ct_caveat);
        }
        if (skipped.length) {
            rationaleParts.push('Skipped: ' + skipped.map(function (c) { return c.name; }).join(', ') + ' (period vs duration).');
        }
        if (caveats.length) {
            rationaleParts.push('Caveats: ' + caveats.join(' '));
        }

        try {
            _ga4('prism_tide_analysis', {
                n_samples:          nIn,
                duration_h:         Math.round(duration_h * 10) / 10,
                fitted_count:       fitList.length,
                m2_amp_psi:         m2 ? Math.round(m2.amplitude * 1000) / 1000 : null,
                snr:                Math.round(snr * 10) / 10,
                ct_estimate:        ct,
                has_depth:          isFinite(o.depth_ft) && o.depth_ft > 0
            });
        } catch (e) { /* swallow */ }

        return {
            constituents:        constOut,
            p_tide:              p_tide,
            p_corrected:         p_corrected,
            residual_rms:        residual_rms,
            snr:                 snr,
            ct_estimate:         ct,
            variance_reduction_pct: var_reduction_pct,
            duration_h:          duration_h,
            n_samples:           nIn,
            n_finite:            tt.length,
            detrend:             { a: det.a, b: det.b, applied: !!o.detrend },
            skipped:             skipped.map(function (c) { return c.name; }),
            rationale:           rationaleParts.join(' ')
        };
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — APPLY / RESET CORRECTION ON window.PRiSM_dataset
    // ═══════════════════════════════════════════════════════════════
    // We snapshot the pre-correction dataset, then replace .p with the
    // corrected series. PRiSM_resetTideCorrection restores from the
    // snapshot. The snapshot is held on
    //     window.PRiSM_tideCorrectionState
    //       { snapshot, sourceDs, appliedDs, applied, lastResult, lastOpts }
    // sourceDs / appliedDs are the dataset objects the snapshot came
    // from / the correction produced. If window.PRiSM_dataset is neither
    // (new data were loaded), the snapshot is stale and is retaken —
    // a re-apply must never bring back an older dataset.
    // ═══════════════════════════════════════════════════════════════

    function _ensureTideState() {
        if (!G.PRiSM_tideCorrectionState) {
            G.PRiSM_tideCorrectionState = {
                snapshot:        null,
                sourceDs:        null,
                appliedDs:       null,
                lastResult:      null,
                lastOpts:        null,
                applied:         false
            };
        }
        return G.PRiSM_tideCorrectionState;
    }

    // Does the snapshot still describe the working dataset?
    function _snapshotCurrent(st, ds) {
        return !!(st.snapshot && ds && (ds === st.sourceDs || ds === st.appliedDs));
    }

    // Measured (uncorrected) t / p of the working dataset.
    function _measuredSeries(ds) {
        var st = _ensureTideState();
        if (st.applied && _snapshotCurrent(st, ds) && ds === st.appliedDs) {
            return { t: st.snapshot.t, p: st.snapshot.p };
        }
        return { t: ds.t, p: ds.p };
    }

    function _snapshotForTide(ds) {
        if (!ds) return null;
        var s = {
            t: (ds.t || []).slice(),
            p: ds.p ? ds.p.slice() : null,
            q: ds.q ? ds.q.slice() : null
        };
        // Carry through any other simple keys.
        for (var k in ds) {
            if (s[k] !== undefined) continue;
            if (k === 't' || k === 'p' || k === 'q') continue;
            try { s[k] = ds[k]; } catch (e) { /* ignore */ }
        }
        return s;
    }

    G.PRiSM_applyTideCorrection = function PRiSM_applyTideCorrection(opts) {
        var ds = G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || !ds.t.length) {
            return null;
        }
        var st = _ensureTideState();
        if (!_snapshotCurrent(st, ds)) {
            // New working data since the last snapshot → start afresh.
            st.snapshot   = _snapshotForTide(ds);
            st.sourceDs   = ds;
            st.appliedDs  = null;
            st.applied    = false;
            st.lastResult = null;
        }

        // Always run analysis on the snapshot pressures (so re-applies
        // are idempotent) — never on the already-corrected series.
        var snap = st.snapshot;
        var res = G.PRiSM_tideAnalysis(snap.t, snap.p, opts || st.lastOpts || undefined);
        st.lastResult = res;
        st.lastOpts   = opts || st.lastOpts;

        if (!res || !Array.isArray(res.p_corrected) || !res.p_corrected.length || !res.constituents.length) {
            return null;
        }

        // Build new dataset with corrected p; preserve every other key.
        var newDs = _snapshotForTide(snap);
        newDs.p = res.p_corrected.slice();
        newDs.tideCorrected = true;
        newDs.tideOriginalP = snap.p.slice();
        newDs.tideFitted    = res.p_tide.slice();

        st.applied   = true;
        st.appliedDs = newDs;
        _commitDataset(newDs, 'tide-correction');

        try {
            _ga4('prism_tide_correction_applied', {
                n_samples: snap.t.length,
                m2_amp_psi: (res.constituents && res.constituents[0] && res.constituents[0].name === 'M2')
                            ? Math.round(res.constituents[0].amplitude * 1000) / 1000 : null
            });
        } catch (e) { /* swallow */ }

        return newDs;
    };

    G.PRiSM_resetTideCorrection = function PRiSM_resetTideCorrection() {
        var st = _ensureTideState();
        if (!st.snapshot || !st.applied) return null;
        if (G.PRiSM_dataset !== st.appliedDs) {
            // Other data were loaded after the correction: nothing to undo.
            st.snapshot = null; st.sourceDs = null; st.appliedDs = null;
            st.applied = false; st.lastResult = null;
            return null;
        }
        var restored = _snapshotForTide(st.snapshot);
        // Keep the snapshot so the user can re-apply.
        st.applied   = false;
        st.appliedDs = null;
        st.sourceDs  = restored;
        _commitDataset(restored, 'tide-reset');

        try { _ga4('prism_tide_correction_reset', {}); } catch (e) { /* swallow */ }
        return restored;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — UI: PRiSM_renderTidePanel(container, opts)
    // ═══════════════════════════════════════════════════════════════
    // Paints a self-contained tide-analysis panel into `container`.
    // Registered as the Tab 1 panel "Tide correction" (C7); opts.embedded
    // drops the outer frame + title (the panel card provides them).
    // Host theme (CSS variables); works at 375 px. All elements are
    // looked up inside the container, so the panel can be mounted in
    // more than one place (tab panel, tools drawer).
    //
    // Sections:
    //   - Inputs: depth_ft, theoreticalM2_psi, constituent checklist,
    //             minDuration_h.
    //   - "Run tide analysis" → PRiSM_tideAnalysis on the measured
    //             pressures of the working dataset.
    //   - Constituent table (name, period, amplitude, phase°).
    //   - Decomposition canvas (raw / fitted-tide / corrected).
    //   - Apply / Reset correction buttons.
    //   - Estimated ct + Bredehoeft formula footnote.
    //   - Rationale block.
    // ═══════════════════════════════════════════════════════════════

    var T = {
        bg: 'var(--bg1,#0d1117)', panel: 'var(--bg2,#161b22)', border: 'var(--border,#30363d)',
        text: 'var(--text,#e6edf3)', text2: 'var(--text2,#8b949e)', text3: 'var(--text3,#6e7681)',
        accent: 'var(--accent,#f0883e)', green: 'var(--green,#3fb950)', red: 'var(--red,#f85149)',
        yellow: 'var(--yellow,#d29922)', blue: 'var(--blue,#58a6ff)'
    };
    var _HEADING_STYLE = 'font-weight:600; font-size:11px; color:' + T.text2 + '; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;';
    var _CARD_STYLE    = 'background:' + T.panel + '; border:1px solid ' + T.border + '; border-radius:6px; padding:10px; margin-bottom:10px; max-width:100%; box-sizing:border-box;';
    var _INPUT_STYLE   = 'width:120px; max-width:100%; box-sizing:border-box; padding:5px 6px; background:' + T.bg + '; color:' + T.text + '; border:1px solid ' + T.border + '; border-radius:4px; font-family:monospace; font-size:12px;';
    var _LABEL_STYLE   = 'display:flex; flex-direction:column; font-size:11px; color:' + T.text2 + '; gap:2px; min-width:0;';

    function _btnStyle(kind) {
        var primary = (kind === 'primary');
        return 'padding:6px 12px; min-height:32px; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;'
             + ' border:1px solid ' + (primary ? T.accent : T.border) + '; background:' + (primary ? T.accent : T.panel)
             + '; color:' + (primary ? '#0d1117' : T.text) + ';';
    }

    function _el(container, id) {
        return (container && container.querySelector) ? container.querySelector('#' + id) : null;
    }

    function _selectedConstituents(container) {
        if (!container) return DEFAULT_CONSTITUENT_NAMES.slice();
        var boxes = container.querySelectorAll
                  ? container.querySelectorAll('input[data-prism-tide-c]')
                  : [];
        var sel = [];
        for (var i = 0; i < boxes.length; i++) {
            if (boxes[i].checked) sel.push(boxes[i].getAttribute('data-prism-tide-c'));
        }
        if (!sel.length) sel = DEFAULT_CONSTITUENT_NAMES.slice();
        return sel;
    }

    function _readNumberInput(container, id, fallback) {
        var el = _el(container, id);
        if (!el) return fallback;
        var v = parseFloat(el.value);
        return isFinite(v) ? v : fallback;
    }

    // Current panel inputs → PRiSM_tideAnalysis options (and remember them
    // so a re-render shows the same values).
    function _readOpts(container) {
        var o = {
            constituents:      _selectedConstituents(container),
            detrend:           true,
            depth_ft:          _readNumberInput(container, 'prism_tide_depth', null),
            theoreticalM2_psi: _readNumberInput(container, 'prism_tide_theom2', 1.0),
            minDuration_h:     _readNumberInput(container, 'prism_tide_minDur', 48)
        };
        _ensureTideState().inputs = {
            depth_ft: o.depth_ft, theoreticalM2_psi: o.theoreticalM2_psi,
            minDuration_h: o.minDuration_h, constituents: o.constituents.slice()
        };
        return o;
    }

    function _renderResultTable(constArr) {
        if (!constArr || !constArr.length) {
            return '<div style="font-style:italic; color:' + T.text2 + ';">No constituents fitted.</div>';
        }
        var h = [];
        h.push('<div style="overflow-x:auto; max-width:100%;">');
        h.push('<table style="width:100%; border-collapse:collapse; font-size:12px;">');
        h.push('<thead><tr style="border-bottom:1px solid ' + T.border + '; color:' + T.text2 + '; text-align:left;">');
        h.push('<th style="padding:6px 8px;">Constituent</th>');
        h.push('<th style="padding:6px 8px;">Period (h)</th>');
        h.push('<th style="padding:6px 8px;">Amplitude (psi)</th>');
        h.push('<th style="padding:6px 8px;">Phase (°)</th>');
        h.push('<th style="padding:6px 8px;">Description</th>');
        h.push('</tr></thead><tbody>');
        for (var i = 0; i < constArr.length; i++) {
            var c = constArr[i];
            var phaseDeg = c.phase * 180 / Math.PI;
            h.push('<tr style="border-bottom:1px solid ' + T.border + ';">'
                + '<td style="padding:6px 8px; font-weight:600; color:' + T.blue + ';">' + _esc(c.name) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + c.period.toFixed(4) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + _fmt(c.amplitude, 3) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + _fmt(phaseDeg, 1) + '</td>'
                + '<td style="padding:6px 8px; color:' + T.text2 + ';">' + _esc(c.desc) + '</td>'
                + '</tr>');
        }
        h.push('</tbody></table></div>');
        return h.join('');
    }

    function _renderCtBlock(ct, depth_ft, theoreticalM2_psi) {
        if (ct == null || !isFinite(ct)) {
            return '<div style="padding:10px; background:' + T.bg + '; border-radius:4px; color:' + T.text2 + '; font-style:italic;">'
                 + 'c<sub>t</sub> estimate not available — enter the depth and the theoretical M2 amplitude (both &gt; 0) and keep M2 in the fit.</div>';
        }
        return '<div style="padding:10px; background:' + T.bg + '; border-left:3px solid ' + T.green + '; border-radius:4px;">'
             +    '<div style="font-size:11px; color:' + T.text2 + '; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">'
             +      'Total compressibility (Bredehoeft 1967)'
             +    '</div>'
             +    '<div style="font-size:18px; font-weight:600; color:' + T.green + '; font-family:monospace;">'
             +      'c<sub>t</sub> ≈ ' + ct.toExponential(3) + ' psi<sup>−1</sup>'
             +    '</div>'
             +    '<div style="font-size:11px; color:' + T.text2 + '; margin-top:6px; line-height:1.4;">'
             +      'Formula: c<sub>t</sub> = R<sub>obs</sub> / (R<sub>th</sub> · ρ<sub>w</sub>g · h · ξ)<br>'
             +      'where R<sub>th</sub>=' + _esc(theoreticalM2_psi) + ' psi, h=' + _esc(depth_ft) + ' ft, '
             +      'ρ<sub>w</sub>g=' + FRESH_WATER_GRADIENT_PSI_PER_FT + ' psi/ft, ξ=' + BREDEHOEFT_LOVE_FACTOR
             +      ' (Love factor h₂−1.16·k₂).<br>'
             +      'For confined saturated formations; treat as a sanity bound on the well c<sub>t</sub> in oil/gas zones.'
             +    '</div>'
             + '</div>';
    }

    function _renderResults(container, res, opts) {
        var host = container.querySelector ? container.querySelector('.prism-tide-results') : null;
        if (!host) return;
        if (!res) {
            host.innerHTML = '<div style="color:' + T.text2 + '; font-style:italic;">No results yet.</div>';
            return;
        }
        var h = [];

        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Fitted constituents</div>');
        h.push(_renderResultTable(res.constituents));
        h.push('</div>');

        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Decomposition (raw → fitted tide → corrected)</div>');
        h.push('<canvas class="prism-tide-canvas" id="prism_tide_canvas" width="800" height="380" '
            +  'style="display:block; width:100%; max-width:100%; height:auto; background:' + T.bg + '; border:1px solid ' + T.border + '; '
            +  'border-radius:6px;"></canvas>');
        h.push('</div>');

        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Diagnostics</div>');
        h.push('<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; margin-bottom:12px;">');
        h.push('<div><span style="color:' + T.text2 + '; font-size:11px;">Residual RMS</span><div style="font-family:monospace;">'
              + _fmt(res.residual_rms, 3) + ' psi</div></div>');
        h.push('<div><span style="color:' + T.text2 + '; font-size:11px;">M2 SNR</span><div style="font-family:monospace;">'
              + _fmt(res.snr, 2) + '</div></div>');
        h.push('<div><span style="color:' + T.text2 + '; font-size:11px;">Variance reduction</span><div style="font-family:monospace;">'
              + _fmt(res.variance_reduction_pct, 1) + ' %</div></div>');
        h.push('<div><span style="color:' + T.text2 + '; font-size:11px;">Duration</span><div style="font-family:monospace;">'
              + _fmt(res.duration_h, 1) + ' h</div></div>');
        h.push('<div><span style="color:' + T.text2 + '; font-size:11px;">Samples</span><div style="font-family:monospace;">'
              + (res.n_samples || 0) + '</div></div>');
        h.push('</div>');
        h.push(_renderCtBlock(res.ct_estimate, opts.depth_ft, opts.theoreticalM2_psi));
        h.push('</div>');

        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Rationale</div>');
        h.push('<div style="line-height:1.55;">' + _esc(res.rationale || '') + '</div>');
        h.push('</div>');

        host.innerHTML = h.join('');

        var canvas = host.querySelector('.prism-tide-canvas');
        if (canvas && canvas.getContext) {
            try {
                G.PRiSM_plot_tide_decomposition(canvas, {
                    t:           opts._lastT || [],
                    p_raw:       opts._lastP || [],
                    p_tide:      res.p_tide,
                    p_corrected: res.p_corrected
                });
            } catch (e) { /* swallow */ }
        }
    }

    function _setMsg(container, html) {
        var msg = container.querySelector ? container.querySelector('.prism-tide-msg') : null;
        if (msg) msg.innerHTML = html;
    }

    function _repaintLast(container) {
        var st = _ensureTideState();
        if (!st.lastResult || !st.lastSeries) return;
        var o = {};
        for (var k in (st.lastOpts || {})) o[k] = st.lastOpts[k];
        o._lastT = st.lastSeries.t;
        o._lastP = st.lastSeries.p;
        _renderResults(container, st.lastResult, o);
    }

    function _runFromUI(container) {
        var ds = G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || !ds.t.length) {
            _setMsg(container, '<span style="color:' + T.red + ';">No dataset loaded — load a pressure history on the Data step first.</span>');
            return;
        }
        // Analyse the MEASURED pressures (the snapshot when a correction
        // is applied to this dataset), never the already-cleaned series.
        var src = _measuredSeries(ds);
        var opts = _readOpts(container);
        var res;
        try {
            res = G.PRiSM_tideAnalysis(src.t, src.p, opts);
        } catch (e) {
            _setMsg(container, '<span style="color:' + T.red + ';">Analysis failed: ' + _esc(e && e.message) + '</span>');
            return;
        }
        var st = _ensureTideState();
        st.lastResult = res;
        st.lastOpts   = opts;
        st.lastSeries = { t: src.t, p: src.p };
        st.lastDs     = ds;
        _setMsg(container, res.constituents.length
            ? '<span style="color:' + T.green + ';">Analysis complete (' + res.constituents.length + ' constituents fitted).</span>'
            : '<span style="color:' + T.yellow + ';">No constituent could be fitted — see the rationale.</span>');
        _repaintLast(container);
    }

    G.PRiSM_renderTidePanel = function PRiSM_renderTidePanel(container, panelOpts) {
        if (!_hasDoc || !container) return;
        panelOpts = panelOpts || {};

        var st = _ensureTideState();
        var inp = st.inputs || {};
        var selNames = {};
        if (Array.isArray(inp.constituents) && inp.constituents.length) {
            for (var s = 0; s < inp.constituents.length; s++) selNames[inp.constituents[s]] = true;
        }

        var html = [];
        html.push('<div class="prism-tide-panel" style="color:' + T.text + '; font-size:13px; line-height:1.5; max-width:100%; box-sizing:border-box;'
            + (panelOpts.embedded ? '' : ' background:' + T.bg + '; border:1px solid ' + T.border + '; border-radius:6px; padding:12px;') + '">');

        if (!panelOpts.embedded) {
            html.push('<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:12px; flex-wrap:wrap;">');
            html.push('<div style="font-weight:700; font-size:14px;">Tide correction</div>');
            html.push('<div style="font-size:11px; color:' + T.text2 + ';">Bredehoeft 1967 · Van der Kamp 1990</div>');
            html.push('</div>');
        }

        html.push('<div style="margin-bottom:10px; padding:10px; background:' + T.panel + '; border-left:3px solid ' + T.blue + '; border-radius:4px; font-size:12px; color:' + T.text2 + '; line-height:1.55;">'
              +     'Finds the astronomical tide in offshore gauge pressures, fits amplitude and phase by least squares, '
              +     'and can replace the pressures with the tide-cleaned record. The M2 amplitude also gives an in-situ estimate of '
              +     'total compressibility c<sub>t</sub>. Works best on long, steady records (observation gauges, late buildups); '
              +     'the drift is removed with a straight line.'
              +   '</div>');

        html.push('<div style="' + _CARD_STYLE + '">');
        html.push('<div style="' + _HEADING_STYLE + '">Inputs</div>');
        html.push('<div style="display:flex; flex-wrap:wrap; gap:12px; margin-bottom:10px;">');
        html.push('<label style="' + _LABEL_STYLE + '">Depth (ft)'
              +     '<input type="number" id="prism_tide_depth" step="any" min="0" placeholder="e.g. 10000"'
              +       (isFinite(inp.depth_ft) && inp.depth_ft > 0 ? ' value="' + inp.depth_ft + '"' : '')
              +       ' style="' + _INPUT_STYLE + '"></label>');
        html.push('<label style="' + _LABEL_STYLE + '">Theoretical M2 amplitude (psi)'
              +     '<input type="number" id="prism_tide_theom2" step="0.05" min="0" value="'
              +       (isFinite(inp.theoreticalM2_psi) ? inp.theoreticalM2_psi : 1.0) + '"'
              +       ' style="' + _INPUT_STYLE + '"></label>');
        html.push('<label style="' + _LABEL_STYLE + '">Min duration (h)'
              +     '<input type="number" id="prism_tide_minDur" step="1" min="1" value="'
              +       (isFinite(inp.minDuration_h) ? inp.minDuration_h : 48) + '"'
              +       ' style="' + _INPUT_STYLE + '"></label>');
        html.push('</div>');
        html.push('<div style="' + _HEADING_STYLE + ' margin-top:6px;">Constituents</div>');
        html.push('<div style="display:flex; flex-wrap:wrap; gap:8px; font-size:12px;">');
        var anySel = false;
        for (var k0 in selNames) { if (selNames[k0]) { anySel = true; break; } }
        for (var i = 0; i < PRiSM_TIDE_CONSTITUENTS.length; i++) {
            var c = PRiSM_TIDE_CONSTITUENTS[i];
            var checked = (anySel ? selNames[c.name] : c.isMajor) ? ' checked' : '';
            html.push('<label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; padding:3px 8px; background:' + T.bg + '; border:1px solid ' + T.border + '; border-radius:14px;" title="' + _esc(c.desc) + ' (period ' + c.period.toFixed(2) + ' h)">'
                  +     '<input type="checkbox" data-prism-tide-c="' + _esc(c.name) + '"' + checked + ' style="margin:0;">'
                  +     '<span style="font-weight:600;">' + _esc(c.name) + '</span>'
                  +     '<span style="color:' + T.text3 + '; font-size:10px;">' + c.period.toFixed(1) + ' h</span>'
                  +   '</label>');
        }
        html.push('</div>');
        html.push('<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; align-items:center;">');
        html.push('<button id="prism_tide_run"   type="button" class="btn btn-primary" style="' + _btnStyle('primary') + '">Run tide analysis</button>');
        html.push('<button id="prism_tide_apply" type="button" class="btn btn-secondary" style="' + _btnStyle() + '">Apply correction</button>');
        html.push('<button id="prism_tide_reset" type="button" class="btn btn-secondary" style="' + _btnStyle() + '">Reset</button>');
        html.push('</div>');
        html.push('<div class="prism-tide-msg" style="font-size:12px; color:' + T.text2 + '; margin-top:6px; min-height:14px;">'
              + (st.applied && G.PRiSM_dataset === st.appliedDs
                 ? '<span style="color:' + T.green + ';">A tide correction is applied to the working data.</span>' : '')
              + '</div>');
        html.push('</div>');

        html.push('<div class="prism-tide-results"></div>');
        html.push('</div>');
        container.innerHTML = html.join('');

        var btnRun   = _el(container, 'prism_tide_run');
        var btnApply = _el(container, 'prism_tide_apply');
        var btnReset = _el(container, 'prism_tide_reset');
        if (btnRun) btnRun.onclick = function () { _runFromUI(container); };
        if (btnApply) btnApply.onclick = function () {
            var opts = _readOpts(container);
            var had = !!G.PRiSM_dataset;
            var ds = G.PRiSM_applyTideCorrection(opts);
            var s2 = _ensureTideState();
            if (ds) {
                s2.lastSeries = { t: s2.snapshot.t, p: s2.snapshot.p };
                _setMsg(container, '<span style="color:' + T.green + ';">Correction applied — the working pressures are now tide-cleaned.</span>');
                _repaintLast(container);
            } else {
                _setMsg(container, '<span style="color:' + T.red + ';">'
                    + (had ? 'Could not apply — no constituent could be fitted (see the rationale).'
                           : 'Could not apply — no dataset loaded.') + '</span>');
                if (had && s2.lastResult) {
                    s2.lastSeries = s2.snapshot ? { t: s2.snapshot.t, p: s2.snapshot.p } : s2.lastSeries;
                    _repaintLast(container);
                }
            }
        };
        if (btnReset) btnReset.onclick = function () {
            var ds = G.PRiSM_resetTideCorrection();
            _setMsg(container, ds
                ? '<span style="color:' + T.green + ';">Reset — measured pressures restored.</span>'
                : '<span style="color:' + T.text2 + ';">Nothing to reset (no correction applied to the working data).</span>');
        };

        // Repaint the last analysis when it belongs to the working data.
        if (st.lastResult && st.lastSeries && G.PRiSM_dataset &&
            (st.lastDs === G.PRiSM_dataset || _snapshotCurrent(st, G.PRiSM_dataset))) {
            _repaintLast(container);
        }

        try { _ga4('prism_tide_panel_open', {}); } catch (e) { /* swallow */ }
    };

    _registerPanel(1, {
        id: 'prism_tide',
        title: 'Tide correction',
        order: 40,
        collapsed: true,
        tool: true,
        description: 'Remove the ocean-tide signal from offshore gauge pressures; in-situ c_t estimate',
        render: function (hostEl) { G.PRiSM_renderTidePanel(hostEl, { embedded: true }); }
    });


    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — PLOT: PRiSM_plot_tide_decomposition(canvas, data)
    // ═══════════════════════════════════════════════════════════════
    // Three-panel decomposition stacked vertically:
    //   Top:    raw pressure (orange)
    //   Middle: fitted tide signal (blue)
    //   Bottom: corrected pressure (green)
    //
    // Uses a HiDPI-safe context and a minimal axis (we don't draw
    // gridlines for the middle panel — its scale is much smaller
    // than the raw / corrected panels).
    //
    // data = { t: number[], p_raw: number[], p_tide: number[], p_corrected: number[] }
    // ═══════════════════════════════════════════════════════════════

    function _setupCanvas(canvas, opts) {
        opts = opts || {};
        var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
        var parentW = (canvas.parentNode && canvas.parentNode.clientWidth) || 0;
        var cssW = opts.width  || canvas.clientWidth  || parentW || canvas.width  || 800;
        var cssH = opts.height || canvas.clientHeight || canvas.height || 380;
        if (canvas.style) {
            // Width capped by the container (no horizontal page scroll at
            // 375 px even when the canvas was measured while hidden);
            // height follows the drawing-buffer aspect ratio.
            canvas.style.width    = cssW + 'px';
            canvas.style.maxWidth = '100%';
            canvas.style.height   = 'auto';
        }
        canvas.width  = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        var ctx = canvas.getContext('2d');
        if (!ctx) return null;
        if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: ctx, w: cssW, h: cssH };
    }

    function _autoRange(arr, padPct) {
        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) {
                if (arr[i] < lo) lo = arr[i];
                if (arr[i] > hi) hi = arr[i];
            }
        }
        if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
        if (lo === hi) { lo -= 1; hi += 1; }
        var pad = (hi - lo) * (padPct || 0.05);
        return [lo - pad, hi + pad];
    }

    function _drawSubplotFrame(ctx, x, y, w, h, title) {
        var th = _theme();
        ctx.fillStyle = th.panel; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = th.border; ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        if (title) {
            ctx.fillStyle = th.text2;
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(title, x + 6, y + 4);
        }
    }

    function _drawSeries(ctx, x, y, w, h, t, v, color) {
        if (!t || !v || !t.length) return;
        var n = Math.min(t.length, v.length);
        var tLo = Infinity, tHi = -Infinity;
        for (var i = 0; i < n; i++) {
            if (isFinite(t[i])) { if (t[i] < tLo) tLo = t[i]; if (t[i] > tHi) tHi = t[i]; }
        }
        if (!isFinite(tLo) || !isFinite(tHi) || tLo === tHi) return;
        var yr = _autoRange(v, 0.08);
        var yLo = yr[0], yHi = yr[1];
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1.2;
        ctx.beginPath();
        var first = true;
        for (var j = 0; j < n; j++) {
            if (!isFinite(t[j]) || !isFinite(v[j])) { first = true; continue; }
            var px = x + (t[j] - tLo) / (tHi - tLo) * w;
            var py = y + h - (v[j] - yLo) / (yHi - yLo) * h;
            if (first) { ctx.moveTo(px, py); first = false; }
            else        { ctx.lineTo(px, py); }
        }
        ctx.stroke();

        // Y-range tick labels (compact, right-aligned outside the panel).
        var th = _theme();
        ctx.fillStyle = th.text3;
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(_fmt(yHi, 2), x + w + 4, y);
        ctx.textBaseline = 'bottom';
        ctx.fillText(_fmt(yLo, 2), x + w + 4, y + h);
    }

    function _drawTimeAxis(ctx, x, y, w, t) {
        if (!t || !t.length) return;
        var th = _theme();
        var tLo = Infinity, tHi = -Infinity;
        for (var i = 0; i < t.length; i++) {
            if (isFinite(t[i])) { if (t[i] < tLo) tLo = t[i]; if (t[i] > tHi) tHi = t[i]; }
        }
        if (!isFinite(tLo) || !isFinite(tHi) || tLo === tHi) return;
        // 6 evenly-spaced ticks.
        ctx.fillStyle = th.text2;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        var nTicks = 6;
        for (var k = 0; k < nTicks; k++) {
            var frac = k / (nTicks - 1);
            var tv = tLo + frac * (tHi - tLo);
            var px = x + frac * w;
            ctx.fillText(_fmt(tv, 1), px, y + 2);
        }
        ctx.textAlign = 'right';
        ctx.fillText('time (h)', x + w, y + 14);
    }

    G.PRiSM_plot_tide_decomposition = function PRiSM_plot_tide_decomposition(canvas, data, opts) {
        if (!canvas || !canvas.getContext) return;
        var setup = _setupCanvas(canvas, opts);
        if (!setup) return;
        var ctx = setup.ctx, W = setup.w, H = setup.h;
        var th = _theme();

        // Background.
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, 0, W, H);

        if (!data || !Array.isArray(data.t) || data.t.length < 2) {
            ctx.fillStyle = th.text3;
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('No tide-decomposition data', W / 2, H / 2);
            return;
        }

        var pad = { left: 50, right: 60, top: 8, bottom: 28 };
        var plotW = W - pad.left - pad.right;
        var plotH = H - pad.top - pad.bottom;
        var subH = Math.floor((plotH - 12) / 3); // 3 panels + small gaps

        var x = pad.left, y = pad.top;
        var t = data.t;
        var p_raw = data.p_raw || [];
        var p_tide = data.p_tide || [];
        var p_corr = data.p_corrected || [];

        _drawSubplotFrame(ctx, x, y, plotW, subH, 'Raw pressure (psi)');
        _drawSeries(ctx, x, y, plotW, subH, t, p_raw, th.accent);

        var y2 = y + subH + 6;
        _drawSubplotFrame(ctx, x, y2, plotW, subH, 'Fitted tide signal (psi)');
        _drawSeries(ctx, x, y2, plotW, subH, t, p_tide, th.blue);

        var y3 = y2 + subH + 6;
        _drawSubplotFrame(ctx, x, y3, plotW, subH, 'Corrected pressure (psi)');
        _drawSeries(ctx, x, y3, plotW, subH, t, p_corr, th.green);

        _drawTimeAxis(ctx, x, y3 + subH, plotW, t);
    };


    // ═══════════════════════════════════════════════════════════════

})();

// ─── END 18-tide-analysis ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 19-data-managers ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 19 — Multi-Dataset Workflow
//   Gauge-Data Manager: store many raw gauge files in one project,
//     up to multi-million samples each, IndexedDB-backed when available.
//   Analysis-Data Manager: derive sampled subsets from gauge data with
//     filter / decimation / time-range options; activate one as the
//     current PRiSM_dataset; manage many analysis presets per project.
//   Project File: save/load entire PRiSM state as a single .prism JSON.
//
// PUBLIC API (all on window.*)
//   PRiSM_storage          — backend abstraction (IDB / localStorage / memory)
//   PRiSM_gaugeData        — gauge-data CRUD + diff
//   PRiSM_analysisData     — analysis-data CRUD + activate + sampler
//   PRiSM_project          — project save / load / new / info
//   PRiSM_renderGaugeManager(container)    — UI for gauge-data manager
//   PRiSM_renderAnalysisManager(container) — UI for analysis-data manager
//   PRiSM_renderDatasetsPanel(container)   — Tab 1 panel "Gauges & analysis
//                                            datasets" (C7): both managers +
//                                            .prism import/export inside
//   PRiSM_renderProjectToolbar(container)  — compact .prism import / export +
//                                            info (tools drawer). No New / Save:
//                                            the header project file (29) owns
//                                            the whole-project New / Open / Save
//   PRiSM_gaugeData.importText(text, meta) — parse a text file into a gauge
//   PRiSM_gaugeData.addFromDataset(ds?, m) — store the working data as a gauge
//
// PROJECT INTEGRATION
//   The gauge / analysis records are registered with the header project
//   file (window.WTS_project, module 'prism_gauges') so Save / Open / New
//   there carry them too. With the localStorage backend the records are
//   already wts_* keys (saved by the 'storage' module), so the module
//   reports nothing to avoid storing them twice.
//
// DATASET EVENTS
//   Activating an analysis replaces window.PRiSM_dataset, dispatches
//   'prism:dataset-loaded' and redraws via window.PRiSM_drawActivePlot.
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • Pure vanilla JS — no external dependencies. Uses built-in
//     indexedDB / localStorage / Blob / URL.createObjectURL / Float32Array.
//   • Async/Promise-based for storage operations.
//   • Defensive: falls back from IDB → localStorage → in-memory if either
//     is unavailable (or the IDB open call rejects, e.g. private mode).
//   • Compact storage: t/p/q stored as Float32Array buffers (12 bytes/sample
//     for triplets) rather than JSON arrays (~20–30 bytes/sample).
//   • Backwards-compatible: analysisData.activate(id) populates
//     window.PRiSM_dataset = { t, p, q } so the existing PRiSM workflow
//     continues to work unchanged.
//   • Failure-tolerant UI: every render fn swallows errors and prints a
//     compact "<storage unavailable>" message in the host container.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

// -----------------------------------------------------------------------
// Tiny env shims — let the module load in the smoke-test stub harness.
// -----------------------------------------------------------------------
var _hasDoc = (typeof document !== 'undefined');
var _hasWin = (typeof window !== 'undefined');
var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

function _ga4(eventName, params) {
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
    }
}

function _now() {
    return new Date().toISOString();
}

function _id(prefix) {
    var s = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    return (prefix || 'id') + '_' + s;
}

function _theme() {
    if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
    return {
        bg:        '#0d1117', panel: '#161b22', border: '#30363d',
        grid:      '#21262d', gridMajor: '#30363d',
        text:      '#c9d1d9', text2: '#8b949e', text3: '#6e7681',
        accent:    '#f0883e', blue: '#58a6ff', green: '#3fb950',
        red:       '#f85149', yellow: '#d29922', cyan: '#39c5cf',
        purple:    '#bc8cff'
    };
}

function _hasIDB() {
    try { return (typeof indexedDB !== 'undefined') && indexedDB !== null; }
    catch (e) { return false; }
}

function _hasLS() {
    try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false;
        var k = '__prism_ls_probe__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return true;
    } catch (e) { return false; }
}

// ── Shared-contract adapters (C7 panels + events). Guarded. ──
function _dispatch(name, detail) {
    try {
        if (_hasWin && typeof G.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            G.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
        }
    } catch (e) { /* ignore */ }
}

// Every dataset mutation: publish, announce, redraw — through the single
// commit path (PRiSM_commitDataset) when it is loaded, so the demo-input
// release and the event contract (C7) apply to this module too.
function _commitDataset(ds, source) {
    if (ds && ds.t && ds.t.length && typeof G.PRiSM_commitDataset === 'function') {
        G.PRiSM_commitDataset(ds, { source: source });
    } else {
        G.PRiSM_dataset = ds;
        _dispatch('prism:dataset-loaded', { source: source, n: (ds && ds.t) ? ds.t.length : 0 });
    }
    if (typeof G.PRiSM_drawActivePlot === 'function') {
        try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
    }
}

function _registerPanel(n, spec) {
    if (typeof G.PRiSM_registerTabPanel === 'function') {
        try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall through */ }
    }
    G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
    var list = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === spec.id) { list[i] = spec; return; }
    }
    list.push(spec);
}

function _clone(v) {
    if (v == null) return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
}

// Promise polyfill check — just bail if Promise isn't available.
var _Promise = (typeof Promise !== 'undefined') ? Promise : null;
function _resolved(v) { return _Promise ? _Promise.resolve(v) : { then: function (cb) { cb(v); return this; } }; }
function _rejected(e) { return _Promise ? _Promise.reject(e)  : { then: function (_, cb) { if (cb) cb(e); return this; } }; }


// ═══════════════════════════════════════════════════════════════════════
// SECTION 1 — STORAGE BACKEND (IDB + localStorage fallback + in-memory)
// ═══════════════════════════════════════════════════════════════════════
//
// One object store ('records') keyed by id. Each record is
//   { id: string, kind: 'gauge'|'analysis'|'meta', metadata: {...},
//     data: { t: ArrayBuffer, p: ArrayBuffer, q: ArrayBuffer|null },
//     provenance: {...} (analysis only) }
//
// Two indices:
//   - 'kind' index → fast list of all gauges or all analyses
//   - 'createdAt' index → for chronological listing
//
// The localStorage fallback uses one key per record under
//   wts_prism_rec_<id>
// plus an index key
//   wts_prism_rec_index = [ { id, kind, ts }, ... ]
//
// In-memory fallback: a JS Map keyed by id.
// ═══════════════════════════════════════════════════════════════════════

var DB_NAME      = 'wts_prism';
var DB_VERSION   = 1;
var STORE_NAME   = 'records';
var LS_PREFIX    = 'wts_prism_rec_';
var LS_INDEX_KEY = 'wts_prism_rec_index';
var META_KEY     = '__prism_project_meta__';

var _idb = null;        // IDBDatabase handle, set after init
var _backend = null;    // 'indexedDB' | 'localStorage' | 'memory'
var _memStore = null;   // Map for in-memory backend
var _initPromise = null;

function _openIDB() {
    return new _Promise(function (resolve, reject) {
        try {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    var os = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    os.createIndex('kind', 'kind', { unique: false });
                    os.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror   = function () { reject(req.error || new Error('IDB open failed')); };
            req.onblocked = function () { reject(new Error('IDB blocked')); };
        } catch (e) { reject(e); }
    });
}

function _txStore(mode) {
    var tx = _idb.transaction(STORE_NAME, mode);
    return tx.objectStore(STORE_NAME);
}

function _idbPut(rec) {
    return new _Promise(function (resolve, reject) {
        try {
            var os = _txStore('readwrite');
            var req = os.put(rec);
            req.onsuccess = function () { resolve(); };
            req.onerror   = function () { reject(req.error); };
        } catch (e) { reject(e); }
    });
}

function _idbGet(id) {
    return new _Promise(function (resolve, reject) {
        try {
            var os = _txStore('readonly');
            var req = os.get(id);
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror   = function () { reject(req.error); };
        } catch (e) { reject(e); }
    });
}

function _idbDelete(id) {
    return new _Promise(function (resolve, reject) {
        try {
            var os = _txStore('readwrite');
            var req = os.delete(id);
            req.onsuccess = function () { resolve(); };
            req.onerror   = function () { reject(req.error); };
        } catch (e) { reject(e); }
    });
}

function _idbListByKind(kind) {
    return new _Promise(function (resolve, reject) {
        try {
            var os = _txStore('readonly');
            var idx = os.index('kind');
            var out = [];
            var req = idx.openCursor(IDBKeyRange.only(kind));
            req.onsuccess = function () {
                var cur = req.result;
                if (cur) {
                    var v = cur.value;
                    out.push({ id: v.id, metadata: v.metadata,
                               metaSize: v.data ? _byteLen(v.data) : 0 });
                    cur.continue();
                } else {
                    resolve(out);
                }
            };
            req.onerror = function () { reject(req.error); };
        } catch (e) { reject(e); }
    });
}

function _byteLen(blob) {
    var n = 0;
    if (blob.t && blob.t.byteLength) n += blob.t.byteLength;
    if (blob.p && blob.p.byteLength) n += blob.p.byteLength;
    if (blob.q && blob.q.byteLength) n += blob.q.byteLength;
    return n;
}

// localStorage fallback: store as base64-encoded JSON.
function _lsIndex() {
    try {
        var raw = localStorage.getItem(LS_INDEX_KEY);
        return raw ? (JSON.parse(raw) || []) : [];
    } catch (e) { return []; }
}
function _lsSetIndex(idx) {
    try { localStorage.setItem(LS_INDEX_KEY, JSON.stringify(idx)); }
    catch (e) { /* ignore */ }
}

function _bufToB64(buf) {
    if (!buf) return null;
    try {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    } catch (e) { return null; }
}
function _b64ToBuf(s) {
    if (!s) return null;
    try {
        var bin = atob(s);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    } catch (e) { return null; }
}

function _serialiseRec(rec) {
    return {
        id: rec.id, kind: rec.kind, createdAt: rec.createdAt,
        metadata: rec.metadata,
        provenance: rec.provenance || null,
        data: rec.data ? {
            t: _bufToB64(rec.data.t),
            p: _bufToB64(rec.data.p),
            q: rec.data.q ? _bufToB64(rec.data.q) : null
        } : null
    };
}
function _deserialiseRec(o) {
    if (!o) return null;
    return {
        id: o.id, kind: o.kind, createdAt: o.createdAt,
        metadata: o.metadata,
        provenance: o.provenance || null,
        data: o.data ? {
            t: _b64ToBuf(o.data.t),
            p: _b64ToBuf(o.data.p),
            q: o.data.q ? _b64ToBuf(o.data.q) : null
        } : null
    };
}

function _lsPut(rec) {
    try {
        localStorage.setItem(LS_PREFIX + rec.id, JSON.stringify(_serialiseRec(rec)));
        var idx = _lsIndex();
        var found = false;
        for (var i = 0; i < idx.length; i++) {
            if (idx[i].id === rec.id) { idx[i] = { id: rec.id, kind: rec.kind, ts: rec.createdAt }; found = true; break; }
        }
        if (!found) idx.push({ id: rec.id, kind: rec.kind, ts: rec.createdAt });
        _lsSetIndex(idx);
        return _resolved();
    } catch (e) {
        // Quota exceeded — fall back to memory for THIS record.
        if (!_memStore) _memStore = new Map();
        _memStore.set(rec.id, rec);
        return _resolved();
    }
}
function _lsGet(id) {
    try {
        var raw = localStorage.getItem(LS_PREFIX + id);
        if (raw) return _resolved(_deserialiseRec(JSON.parse(raw)));
        if (_memStore && _memStore.has(id)) return _resolved(_memStore.get(id));
        return _resolved(null);
    } catch (e) { return _resolved(null); }
}
function _lsDelete(id) {
    try {
        localStorage.removeItem(LS_PREFIX + id);
        var idx = _lsIndex().filter(function (e) { return e.id !== id; });
        _lsSetIndex(idx);
        if (_memStore) _memStore.delete(id);
        return _resolved();
    } catch (e) { return _resolved(); }
}
function _lsListByKind(kind) {
    var idx = _lsIndex();
    var out = [];
    for (var i = 0; i < idx.length; i++) {
        if (idx[i].kind !== kind) continue;
        try {
            var raw = localStorage.getItem(LS_PREFIX + idx[i].id);
            if (raw) {
                var rec = _deserialiseRec(JSON.parse(raw));
                out.push({ id: rec.id, metadata: rec.metadata,
                           metaSize: rec.data ? _byteLen(rec.data) : 0 });
            }
        } catch (e) { /* ignore */ }
    }
    if (_memStore) {
        _memStore.forEach(function (v) {
            if (v.kind === kind) {
                out.push({ id: v.id, metadata: v.metadata, metaSize: v.data ? _byteLen(v.data) : 0 });
            }
        });
    }
    return _resolved(out);
}

// In-memory backend
function _memPut(rec) { _memStore.set(rec.id, rec); return _resolved(); }
function _memGet(id)   { return _resolved(_memStore.get(id) || null); }
function _memDel(id)   { _memStore.delete(id); return _resolved(); }
function _memList(kind) {
    var out = [];
    _memStore.forEach(function (v) {
        if (v.kind === kind) out.push({ id: v.id, metadata: v.metadata, metaSize: v.data ? _byteLen(v.data) : 0 });
    });
    return _resolved(out);
}

// Project meta blob (small JSON of state). Uses one fixed key.
function _putMeta(meta) {
    if (_backend === 'indexedDB') {
        return _idbPut({ id: META_KEY, kind: 'meta', createdAt: _now(), metadata: meta, data: null });
    }
    if (_backend === 'localStorage') {
        try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* ignore */ }
        return _resolved();
    }
    if (!_memStore) _memStore = new Map();
    _memStore.set(META_KEY, { id: META_KEY, kind: 'meta', metadata: meta });
    return _resolved();
}
function _getMeta() {
    if (_backend === 'indexedDB') {
        return _idbGet(META_KEY).then(function (r) { return r ? r.metadata : null; });
    }
    if (_backend === 'localStorage') {
        try { var raw = localStorage.getItem(META_KEY); return _resolved(raw ? JSON.parse(raw) : null); }
        catch (e) { return _resolved(null); }
    }
    if (_memStore && _memStore.has(META_KEY)) return _resolved(_memStore.get(META_KEY).metadata);
    return _resolved(null);
}

function _quotaEstimate() {
    try {
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
            return navigator.storage.estimate().then(function (e) { return e.quota || 0; });
        }
    } catch (e) { /* ignore */ }
    // Conservative defaults: IDB ~ 1 GB, localStorage ~ 5 MB, memory unbounded
    if (_backend === 'indexedDB')   return _resolved(1024 * 1024 * 1024);
    if (_backend === 'localStorage') return _resolved(5  * 1024 * 1024);
    return _resolved(Number.MAX_SAFE_INTEGER);
}

G.PRiSM_storage = {
    backend: 'memory',
    init: function () {
        if (_initPromise) return _initPromise;
        if (!_Promise) {
            _backend = 'memory';
            _memStore = new Map();
            this.backend = _backend;
            return { then: function (cb) { cb(); return this; } };
        }
        var self = this;
        _initPromise = new _Promise(function (resolve) {
            if (_hasIDB()) {
                _openIDB().then(function (db) {
                    _idb = db;
                    _backend = 'indexedDB';
                    self.backend = _backend;
                    resolve();
                }).catch(function () {
                    if (_hasLS()) {
                        _backend = 'localStorage';
                    } else {
                        _backend = 'memory';
                        _memStore = new Map();
                    }
                    self.backend = _backend;
                    resolve();
                });
            } else if (_hasLS()) {
                _backend = 'localStorage';
                self.backend = _backend;
                resolve();
            } else {
                _backend = 'memory';
                _memStore = new Map();
                self.backend = _backend;
                resolve();
            }
        });
        return _initPromise;
    },
    putGauge: function (id, blob) {
        return _put(id, 'gauge', blob);
    },
    getGauge: function (id) { return _get(id); },
    listGauges: function () { return _list('gauge'); },
    deleteGauge: function (id) { return _del(id); },
    putAnalysis: function (id, blob) {
        return _put(id, 'analysis', blob);
    },
    getAnalysis: function (id) { return _get(id); },
    listAnalyses: function () { return _list('analysis'); },
    deleteAnalysis: function (id) { return _del(id); },
    putProjectMeta: function (meta) { return _putMeta(meta); },
    getProjectMeta: function () { return _getMeta(); },
    estimatedQuotaBytes: function () { return _quotaEstimate(); }
};

// ── In-memory mirror of every record (raw buffers), kept in step with
// each put / delete, so the header project file (29, synchronous read())
// can include the gauge + analysis sets without an async round-trip.
// Base64 encoding happens only when a project file is actually written. ──
var _mirror = { gauge: {}, analysis: {} };
var MIRROR_MAX_BYTES = 18 * 1024 * 1024;   // beyond this: metadata only

function _recToFile(rec) {
    return {
        id: rec.id, metadata: rec.metadata, provenance: rec.provenance || null,
        createdAt: rec.createdAt || null,
        dataB64: rec.data ? {
            t: _bufToB64(rec.data.t),
            p: _bufToB64(rec.data.p),
            q: rec.data.q ? _bufToB64(rec.data.q) : null
        } : null
    };
}
function _mirrorPut(rec) {
    if (!rec || !_mirror[rec.kind] || _backend === 'localStorage') return;
    _mirror[rec.kind][rec.id] = {
        id: rec.id, kind: rec.kind, metadata: rec.metadata, provenance: rec.provenance || null,
        createdAt: rec.createdAt || null, data: rec.data || null
    };
}
function _mirrorDel(id) { delete _mirror.gauge[id]; delete _mirror.analysis[id]; }
function _mirrorList(kind) {
    var out = [], m = _mirror[kind] || {};
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) out.push(m[k]);
    return out;
}
function _mirrorFill() {
    if (_backend === 'localStorage' || !_Promise) return _resolved();
    return _Promise.all([_list('gauge'), _list('analysis')]).then(function (pair) {
        var ids = pair[0].concat(pair[1]).map(function (e) { return e.id; });
        return _Promise.all(ids.map(function (id) { return _get(id); }));
    }).then(function (recs) {
        recs.forEach(function (r) { if (r) _mirrorPut(r); });
    }).catch(function () { /* ignore */ });
}

function _put(id, kind, blob) {
    var rec = {
        id: id,
        kind: kind,
        createdAt: blob.createdAt || _now(),
        metadata: blob.metadata || {},
        provenance: blob.provenance || null,
        data: blob.data || null
    };
    var p;
    if (_backend === 'indexedDB')        p = _idbPut(rec);
    else if (_backend === 'localStorage') p = _lsPut(rec);
    else { if (!_memStore) _memStore = new Map(); p = _memPut(rec); }
    return p.then(function (r) { _mirrorPut(rec); return r; });
}
function _get(id) {
    if (_backend === 'indexedDB')   return _idbGet(id);
    if (_backend === 'localStorage') return _lsGet(id);
    if (!_memStore) _memStore = new Map();
    return _memGet(id);
}
function _del(id) {
    var p;
    if (_backend === 'indexedDB')        p = _idbDelete(id);
    else if (_backend === 'localStorage') p = _lsDelete(id);
    else { if (!_memStore) _memStore = new Map(); p = _memDel(id); }
    return p.then(function (r) { _mirrorDel(id); return r; });
}
function _list(kind) {
    if (_backend === 'indexedDB')   return _idbListByKind(kind);
    if (_backend === 'localStorage') return _lsListByKind(kind);
    if (!_memStore) _memStore = new Map();
    return _memList(kind);
}

// Kick off init at load — caller can await PRiSM_storage.init() too.
// Then build the project-file mirror (IndexedDB / memory backends).
try { G.PRiSM_storage.init().then(function () { return _mirrorFill(); }); } catch (e) { /* ignore */ }


// ═══════════════════════════════════════════════════════════════════════
// SECTION 2 — GAUGE-DATA MANAGER
// ═══════════════════════════════════════════════════════════════════════
//
// Stores raw pressure/rate measurements. Each entry contains:
//   id          — auto-generated 'gauge_xxx'
//   metadata    — { name, well, dateStart, dateEnd, sampleCount, source, notes }
//   t, p, q     — the raw arrays (q optional)
//
// On disk, t/p/q are stored as Float32Array buffers — 4 bytes/sample each,
// so triplets cost 12 bytes/sample vs ~20-30 bytes/sample for JSON arrays.
// ═══════════════════════════════════════════════════════════════════════

function _toF32(arr) {
    if (!arr) return null;
    if (arr instanceof Float32Array) return arr;
    if (arr.buffer && arr.byteLength) {
        // Likely a typed array — copy into Float32 to normalise.
        var f = new Float32Array(arr.length);
        for (var i = 0; i < arr.length; i++) f[i] = arr[i];
        return f;
    }
    var n = arr.length, fa = new Float32Array(n);
    for (var k = 0; k < n; k++) fa[k] = +arr[k];
    return fa;
}

function _f32ToArray(f) {
    if (!f) return null;
    var n = f.byteLength / 4;
    var view = (f instanceof Float32Array) ? f : new Float32Array(f);
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = view[i];
    return out;
}

function _toBuffer(f32) {
    if (!f32) return null;
    if (f32.buffer && f32.byteOffset === 0 && f32.byteLength === f32.buffer.byteLength) return f32.buffer;
    return new Float32Array(f32).buffer;
}

function _normMeta(metadata, t, p, q) {
    var m = {};
    metadata = metadata || {};
    m.name        = metadata.name || 'Untitled gauge';
    m.well        = metadata.well || '';
    m.source      = metadata.source || '';
    m.notes       = metadata.notes || '';
    m.sampleCount = (t && t.length) ? t.length : 0;
    if (metadata.dateStart) m.dateStart = metadata.dateStart;
    if (metadata.dateEnd)   m.dateEnd   = metadata.dateEnd;
    if (!m.dateStart && t && t.length) m.dateStart = String(t[0]);
    if (!m.dateEnd   && t && t.length) m.dateEnd   = String(t[t.length - 1]);
    return m;
}

function _ensureInit() {
    return G.PRiSM_storage.init();
}

G.PRiSM_gaugeData = {

    add: function (metadata, t, p, q, options) {
        return _ensureInit().then(function () {
            if (!t || !t.length) throw new Error('PRiSM_gaugeData.add: empty t array');
            if (!p || p.length !== t.length) throw new Error('PRiSM_gaugeData.add: p length mismatch');
            if (q && q.length !== t.length) throw new Error('PRiSM_gaugeData.add: q length mismatch');
            var id = (options && options.id) || _id('gauge');
            var meta = _normMeta(metadata, t, p, q);
            var data = {
                t: _toBuffer(_toF32(t)),
                p: _toBuffer(_toF32(p)),
                q: q ? _toBuffer(_toF32(q)) : null
            };
            return G.PRiSM_storage.putGauge(id, {
                metadata: meta, data: data, createdAt: _now()
            }).then(function () {
                _ga4('prism_gauge_added', { sample_count: meta.sampleCount, has_rate: !!q });
                return id;
            });
        });
    },

    get: function (gaugeId) {
        return _ensureInit().then(function () {
            return G.PRiSM_storage.getGauge(gaugeId).then(function (rec) {
                if (!rec) return null;
                return {
                    id: rec.id,
                    metadata: rec.metadata,
                    t: rec.data ? _f32ToArray(rec.data.t) : [],
                    p: rec.data ? _f32ToArray(rec.data.p) : [],
                    q: (rec.data && rec.data.q) ? _f32ToArray(rec.data.q) : null
                };
            });
        });
    },

    list: function () {
        return _ensureInit().then(function () { return G.PRiSM_storage.listGauges(); });
    },

    delete: function (gaugeId) {
        return _ensureInit().then(function () {
            // Also unlink any analyses that reference it (we don't auto-delete
            // the analyses — but we set a 'gaugeMissing' flag in their provenance
            // when next read).
            return G.PRiSM_storage.deleteGauge(gaugeId).then(function () {
                _ga4('prism_gauge_deleted', {});
            });
        });
    },

    rename: function (gaugeId, newName) {
        return G.PRiSM_gaugeData.get(gaugeId).then(function (g) {
            if (!g) return;
            g.metadata.name = newName;
            return G.PRiSM_storage.putGauge(gaugeId, {
                metadata: g.metadata,
                createdAt: _now(),
                data: {
                    t: _toBuffer(_toF32(g.t)),
                    p: _toBuffer(_toF32(g.p)),
                    q: g.q ? _toBuffer(_toF32(g.q)) : null
                }
            });
        });
    },

    duplicate: function (gaugeId, newName) {
        return G.PRiSM_gaugeData.get(gaugeId).then(function (g) {
            if (!g) throw new Error('Gauge ' + gaugeId + ' not found');
            var meta = {};
            for (var k in g.metadata) meta[k] = g.metadata[k];
            meta.name = newName || (g.metadata.name + ' (copy)');
            return G.PRiSM_gaugeData.add(meta, g.t, g.p, g.q);
        });
    },

    diff: function (gaugeIdA, gaugeIdB) {
        return _Promise.all([G.PRiSM_gaugeData.get(gaugeIdA), G.PRiSM_gaugeData.get(gaugeIdB)])
            .then(function (pair) {
                var a = pair[0], b = pair[1];
                if (!a || !b) throw new Error('PRiSM_gaugeData.diff: gauge missing');
                return _diffPair(a, b);
            });
    },

    // Parse a delimited text file (time in hours, pressure, optional rate)
    // into a new gauge. The working dataset is not touched.
    importText: function (text, metadata) {
        var data = _parseGaugeText(text);
        if (!data.t.length) return _rejected(new Error('No numeric (time, pressure) rows found'));
        var meta = {};
        for (var k in (metadata || {})) meta[k] = metadata[k];
        if (data.note) meta.notes = meta.notes ? meta.notes + ' ' + data.note : data.note;
        return G.PRiSM_gaugeData.add(meta, data.t, data.p, data.q);
    },

    // Store the working dataset (or `ds`) as a gauge.
    addFromDataset: function (ds, metadata) {
        ds = ds || G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t) || !ds.t.length || !Array.isArray(ds.p) || ds.p.length !== ds.t.length) {
            return _rejected(new Error('No working data with time and pressure to store'));
        }
        var meta = {};
        for (var k in (metadata || {})) meta[k] = metadata[k];
        if (!meta.name) meta.name = 'Working data ' + _now().slice(0, 16).replace('T', ' ');
        if (!meta.source) meta.source = ds.source || 'working data';
        var q = (Array.isArray(ds.q) && ds.q.length === ds.t.length) ? ds.q : null;
        return G.PRiSM_gaugeData.add(meta, ds.t, ds.p, q);
    }
};

// Text → { t, p, q|null } using the Data-step parser + column mapper when
// present (07), else a permissive numeric reader. Time is taken as hours.
function _parseGaugeText(text) {
    if (typeof G.PRiSM_parseTextEnhanced === 'function') {
        try {
            var res = G.PRiSM_parseTextEnhanced(String(text || ''));
            var rows = (res && Array.isArray(res.rows)) ? res.rows : [];
            if (rows.length) {
                var map = (typeof G.PRiSM_autoMapColumns === 'function')
                    ? G.PRiSM_autoMapColumns(res.headers, rows) : [];
                var it = -1, ip = -1, iq = -1;
                for (var c = 0; c < (map || []).length; c++) {
                    if (map[c] === 'time' && it < 0) it = c;
                    else if (map[c] === 'pressure' && ip < 0) ip = c;
                    else if (/^rate/.test(map[c] || '') && iq < 0) iq = c;
                }
                if (it < 0) it = 0;
                if (ip < 0) ip = (it === 0) ? 1 : 0;
                var t = [], p = [], q = (iq >= 0) ? [] : null;
                for (var r = 0; r < rows.length; r++) {
                    var tv = +rows[r][it], pv = +rows[r][ip];
                    if (!isFinite(tv) || !isFinite(pv)) continue;
                    t.push(tv); p.push(pv);
                    if (q) q.push(isFinite(+rows[r][iq]) ? +rows[r][iq] : 0);
                }
                if (t.length) {
                    var note = (res.headers && res.headers[it]) ? 'Columns: ' + [res.headers[it], res.headers[ip]]
                        .concat(iq >= 0 ? [res.headers[iq]] : []).join(', ') + ' (time read as hours).' : '';
                    return { t: t, p: p, q: q, note: note };
                }
            }
        } catch (e) { /* fall back */ }
    }
    return _quickCSV(text);
}

// Compute pA - pB at common times via linear interpolation onto the union
// of the two time sets restricted to overlap. Returns the diff arrays plus
// summary stats (RMS, common range).
function _diffPair(a, b) {
    var startCommon = Math.max(a.t[0], b.t[0]);
    var endCommon   = Math.min(a.t[a.t.length - 1], b.t[b.t.length - 1]);
    if (endCommon <= startCommon) {
        return { t: [], dp: [], dq: [], startCommon: startCommon,
                 endCommon: endCommon, nCommon: 0, rmsDiff: 0 };
    }
    // Build a merged sorted time vector inside [startCommon, endCommon],
    // unique to ~1e-9 tolerance.
    var ts = [];
    for (var i = 0; i < a.t.length; i++) {
        var ti = a.t[i];
        if (ti >= startCommon && ti <= endCommon) ts.push(ti);
    }
    for (var j = 0; j < b.t.length; j++) {
        var tj = b.t[j];
        if (tj >= startCommon && tj <= endCommon) ts.push(tj);
    }
    ts.sort(function (x, y) { return x - y; });
    var uniq = [];
    for (var k = 0; k < ts.length; k++) {
        if (!uniq.length || ts[k] - uniq[uniq.length - 1] > 1e-9) uniq.push(ts[k]);
    }
    // Cap to a reasonable size for diff plotting.
    if (uniq.length > 10000) {
        var stride = Math.ceil(uniq.length / 10000);
        var thinned = [];
        for (var u = 0; u < uniq.length; u += stride) thinned.push(uniq[u]);
        uniq = thinned;
    }
    var dp = new Array(uniq.length);
    var dq = a.q && b.q ? new Array(uniq.length) : null;
    var ssr = 0, nValid = 0;
    for (var m = 0; m < uniq.length; m++) {
        var pa = _interp(a.t, a.p, uniq[m]);
        var pb = _interp(b.t, b.p, uniq[m]);
        var d  = pa - pb;
        dp[m] = d;
        if (isFinite(d)) { ssr += d * d; nValid++; }
        if (dq) {
            var qa = _interp(a.t, a.q, uniq[m]);
            var qb = _interp(b.t, b.q, uniq[m]);
            dq[m] = qa - qb;
        }
    }
    var rmsDiff = nValid > 0 ? Math.sqrt(ssr / nValid) : 0;
    return { t: uniq, dp: dp, dq: dq, startCommon: startCommon,
             endCommon: endCommon, nCommon: uniq.length, rmsDiff: rmsDiff };
}

// Linear interp; assumes ts is sorted ascending.
function _interp(ts, ys, x) {
    if (!ts || !ts.length) return NaN;
    if (x <= ts[0]) return ys[0];
    if (x >= ts[ts.length - 1]) return ys[ts.length - 1];
    var lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (ts[mid] <= x) lo = mid; else hi = mid;
    }
    var dt = ts[hi] - ts[lo];
    if (dt === 0) return ys[lo];
    var f = (x - ts[lo]) / dt;
    return ys[lo] + f * (ys[hi] - ys[lo]);
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 3 — ANALYSIS-DATA MANAGER (CRUD + activate + sampler)
// ═══════════════════════════════════════════════════════════════════════
//
// Each analysis-data entry:
//   id            — auto-generated 'ana_xxx'
//   metadata      — { name, notes, sampleCount, ... }
//   t, p, q       — the sampled arrays
//   provenance    — { gaugeIds, filter, decimate, decimateParam, timeRange, createdAt, notes }
//
// activate(id) sets window.PRiSM_dataset = { t, p, q } so the existing
// PRiSM workflow (regression, plots) keeps working unchanged.
// ═══════════════════════════════════════════════════════════════════════

var _activeAnalysisId = null;

G.PRiSM_analysisData = {

    add: function (metadata, gaugeIds, t, p, q) {
        return _ensureInit().then(function () {
            if (!t || !t.length) throw new Error('PRiSM_analysisData.add: empty t array');
            if (!p || p.length !== t.length) throw new Error('PRiSM_analysisData.add: p length mismatch');
            var id = _id('ana');
            var meta = _normMeta(metadata, t, p, q);
            var prov = {
                gaugeIds: gaugeIds || [],
                filter: (metadata && metadata.filter) || null,
                decimate: (metadata && metadata.decimate) || 'none',
                decimateParam: (metadata && metadata.decimateParam) || null,
                timeRange: (metadata && metadata.timeRange) || null,
                createdAt: _now(),
                notes: meta.notes
            };
            var data = {
                t: _toBuffer(_toF32(t)),
                p: _toBuffer(_toF32(p)),
                q: q ? _toBuffer(_toF32(q)) : null
            };
            return G.PRiSM_storage.putAnalysis(id, {
                metadata: meta, data: data, provenance: prov, createdAt: _now()
            }).then(function () {
                _ga4('prism_analysis_added', { sample_count: meta.sampleCount, source_count: prov.gaugeIds.length });
                return id;
            });
        });
    },

    get: function (analysisId) {
        return _ensureInit().then(function () {
            return G.PRiSM_storage.getAnalysis(analysisId).then(function (rec) {
                if (!rec) return null;
                return {
                    id: rec.id,
                    metadata: rec.metadata,
                    t: rec.data ? _f32ToArray(rec.data.t) : [],
                    p: rec.data ? _f32ToArray(rec.data.p) : [],
                    q: (rec.data && rec.data.q) ? _f32ToArray(rec.data.q) : null,
                    provenance: rec.provenance || null
                };
            });
        });
    },

    list: function () {
        return _ensureInit().then(function () { return G.PRiSM_storage.listAnalyses(); });
    },

    delete: function (analysisId) {
        return _ensureInit().then(function () {
            return G.PRiSM_storage.deleteAnalysis(analysisId).then(function () {
                // Deleting the stored copy leaves the working data alone;
                // it simply is no longer linked to a stored analysis.
                if (_activeAnalysisId === analysisId) _activeAnalysisId = null;
                _ga4('prism_analysis_deleted', {});
            });
        });
    },

    rename: function (analysisId, newName) {
        return G.PRiSM_analysisData.get(analysisId).then(function (a) {
            if (!a) return;
            a.metadata.name = newName;
            return G.PRiSM_storage.putAnalysis(analysisId, {
                metadata: a.metadata,
                provenance: a.provenance,
                createdAt: _now(),
                data: {
                    t: _toBuffer(_toF32(a.t)),
                    p: _toBuffer(_toF32(a.p)),
                    q: a.q ? _toBuffer(_toF32(a.q)) : null
                }
            });
        });
    },

    duplicate: function (analysisId, newName) {
        return G.PRiSM_analysisData.get(analysisId).then(function (a) {
            if (!a) throw new Error('Analysis ' + analysisId + ' not found');
            var meta = {};
            for (var k in a.metadata) meta[k] = a.metadata[k];
            meta.name = newName || (a.metadata.name + ' (copy)');
            return G.PRiSM_analysisData.add(meta,
                a.provenance ? a.provenance.gaugeIds : [],
                a.t, a.p, a.q);
        });
    },

    activate: function (analysisId) {
        return G.PRiSM_analysisData.get(analysisId).then(function (a) {
            if (!a) throw new Error('Analysis ' + analysisId + ' not found');
            _activeAnalysisId = analysisId;
            // Working dataset (hours), then prism:dataset-loaded + redraw.
            _commitDataset({
                t: a.t, p: a.p, q: a.q, timeUnit: 'h',
                source: 'analysis-data', analysisId: analysisId,
                name: (a.metadata && a.metadata.name) || ''
            }, 'analysis-data');
            _ga4('prism_analysis_activated', { sample_count: a.t.length });
        });
    },

    activeId: function () { return _activeAnalysisId; },

    sample: function (gaugeIds, options) {
        options = options || {};
        var ids = Array.isArray(gaugeIds) ? gaugeIds : [gaugeIds];
        return _Promise.all(ids.map(function (id) { return G.PRiSM_gaugeData.get(id); }))
            .then(function (gauges) {
                gauges = gauges.filter(function (g) { return g && g.t && g.t.length; });
                if (!gauges.length) throw new Error('PRiSM_analysisData.sample: no source gauges');
                // Concatenate sources by time (assume each gauge has its own
                // time axis; we sort the union ascending).
                var t = [], p = [], q = [], hasQ = true;
                for (var i = 0; i < gauges.length; i++) {
                    var g = gauges[i];
                    if (!g.q) hasQ = false;
                    for (var k = 0; k < g.t.length; k++) {
                        t.push(g.t[k]); p.push(g.p[k]);
                        q.push(g.q ? g.q[k] : 0);
                    }
                }
                // Sort by time
                var order = t.map(function (_, i) { return i; }).sort(function (a, b) { return t[a] - t[b]; });
                var ts = new Array(t.length), ps = new Array(p.length), qs = new Array(q.length);
                for (var j = 0; j < order.length; j++) { ts[j] = t[order[j]]; ps[j] = p[order[j]]; qs[j] = q[order[j]]; }
                if (!hasQ) qs = null;

                // Apply time range
                if (options.timeRange) {
                    var lo = options.timeRange.start, hi = options.timeRange.end;
                    var ti = [], pi = [], qi = qs ? [] : null;
                    for (var m = 0; m < ts.length; m++) {
                        if ((lo == null || ts[m] >= lo) && (hi == null || ts[m] <= hi)) {
                            ti.push(ts[m]); pi.push(ps[m]); if (qs) qi.push(qs[m]);
                        }
                    }
                    ts = ti; ps = pi; qs = qi;
                }
                // Apply filter
                if (options.filter && ps.length > 5) {
                    if (options.filter === 'mad' && typeof G.PRiSM_filterMAD === 'function') {
                        try { ps = G.PRiSM_filterMAD(ps).filtered || ps; } catch (e) {}
                    } else if (options.filter === 'movingAvg' && typeof G.PRiSM_filterMovingAvg === 'function') {
                        try { ps = G.PRiSM_filterMovingAvg(ps, 5) || ps; } catch (e) {}
                    } else if (options.filter === 'hampel' && typeof G.PRiSM_filterHampel === 'function') {
                        try { ps = G.PRiSM_filterHampel(ps).filtered || ps; } catch (e) {}
                    } else {
                        // Inline simple moving-average fallback (window=5)
                        ps = _smoothMA(ps, 5);
                    }
                }
                // Apply decimation
                if (options.decimate && options.decimate !== 'none') {
                    var dp = options.decimateParam || {};
                    if (options.decimate === 'nth') {
                        var every = Math.max(1, dp.every | 0);
                        var td = [], pd = [], qd = qs ? [] : null;
                        for (var d = 0; d < ts.length; d += every) {
                            td.push(ts[d]); pd.push(ps[d]); if (qs) qd.push(qs[d]);
                        }
                        ts = td; ps = pd; qs = qd;
                    } else if (options.decimate === 'log') {
                        var nPerDec = dp.nPerDecade || 50;
                        var picks   = _logDecimate(ts, nPerDec);
                        var td2 = picks.map(function (i) { return ts[i]; });
                        var pd2 = picks.map(function (i) { return ps[i]; });
                        var qd2 = qs ? picks.map(function (i) { return qs[i]; }) : null;
                        ts = td2; ps = pd2; qs = qd2;
                    } else if (options.decimate === 'timeBin') {
                        var binMin = dp.binMinutes || 1;
                        var binH   = binMin / 60;
                        var bins = _timeBin(ts, ps, qs, binH);
                        ts = bins.t; ps = bins.p; qs = bins.q;
                    }
                }

                var meta = {
                    name: options.name || ('Sample ' + new Date().toISOString().slice(0, 19)),
                    notes: options.notes || '',
                    filter: options.filter || null,
                    decimate: options.decimate || 'none',
                    decimateParam: options.decimateParam || null,
                    timeRange: options.timeRange || null
                };
                return G.PRiSM_analysisData.add(meta, ids, ts, ps, qs);
            });
    }
};

function _smoothMA(arr, win) {
    var n = arr.length, out = new Array(n);
    var half = Math.max(1, Math.floor(win / 2));
    for (var i = 0; i < n; i++) {
        var i0 = Math.max(0, i - half), i1 = Math.min(n - 1, i + half);
        var s = 0, c = 0;
        for (var j = i0; j <= i1; j++) {
            if (isFinite(arr[j])) { s += arr[j]; c++; }
        }
        out[i] = c > 0 ? s / c : NaN;
    }
    return out;
}

// Pick log-spaced indices into a sorted ascending t array.
function _logDecimate(ts, nPerDec) {
    var n = ts.length;
    if (n < 4) return ts.map(function (_, i) { return i; });
    var t0 = ts[0], tN = ts[n - 1];
    if (t0 <= 0) {
        // Find first positive time to start log scale
        var k0 = 0;
        while (k0 < n && ts[k0] <= 0) k0++;
        if (k0 >= n - 1) return ts.map(function (_, i) { return i; });
        t0 = ts[k0];
    }
    var lt0 = Math.log10(t0), ltN = Math.log10(tN);
    var decades = Math.max(0.01, ltN - lt0);
    var nPicks = Math.max(4, Math.ceil(decades * nPerDec));
    var picks = [];
    var seen = {};
    for (var i = 0; i < nPicks; i++) {
        var lt = lt0 + decades * (i / (nPicks - 1));
        var target = Math.pow(10, lt);
        // Binary search for nearest index
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (ts[mid] <= target) lo = mid; else hi = mid;
        }
        var pick = (Math.abs(ts[lo] - target) < Math.abs(ts[hi] - target)) ? lo : hi;
        if (!seen[pick]) { seen[pick] = true; picks.push(pick); }
    }
    picks.sort(function (a, b) { return a - b; });
    return picks;
}

// Bin (t, p, q) into uniform time bins of width binWidth (in t units).
function _timeBin(t, p, q, binWidth) {
    if (!t.length) return { t: [], p: [], q: q ? [] : null };
    var t0 = t[0], tN = t[t.length - 1];
    var nBins = Math.max(1, Math.ceil((tN - t0) / binWidth));
    var sumT = new Array(nBins), sumP = new Array(nBins), sumQ = q ? new Array(nBins) : null, cnt = new Array(nBins);
    for (var b = 0; b < nBins; b++) { sumT[b] = 0; sumP[b] = 0; if (sumQ) sumQ[b] = 0; cnt[b] = 0; }
    for (var i = 0; i < t.length; i++) {
        var bIdx = Math.min(nBins - 1, Math.max(0, Math.floor((t[i] - t0) / binWidth)));
        sumT[bIdx] += t[i]; sumP[bIdx] += p[i]; if (sumQ && q) sumQ[bIdx] += q[i];
        cnt[bIdx]++;
    }
    var ot = [], op = [], oq = sumQ ? [] : null;
    for (var k = 0; k < nBins; k++) {
        if (cnt[k] > 0) {
            ot.push(sumT[k] / cnt[k]);
            op.push(sumP[k] / cnt[k]);
            if (sumQ) oq.push(sumQ[k] / cnt[k]);
        }
    }
    return { t: ot, p: op, q: oq };
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 4 — PROJECT FILE (save / load / new / info)
// ═══════════════════════════════════════════════════════════════════════
//
// A project is the entire PRiSM state — gaugeData, analysisData, model,
// params, lastFit, presets, PVT, etc. Saved as JSON; large datasets are
// embedded as base64-encoded Float32Array buffers for compactness.
//
// File format:
//   { version: '1.0', meta: { name, createdAt, modifiedAt, ... },
//     gaugeData: [ { id, metadata, dataB64: { t, p, q } }, ... ],
//     analysisData: [ { id, metadata, provenance, dataB64: {...} }, ... ],
//     state: { activeAnalysisId, model, params, lastFit, presets, pvt, ... } }
// ═══════════════════════════════════════════════════════════════════════

var _projectMeta = {
    name: 'Untitled project',
    createdAt: _now(),
    modifiedAt: _now()
};

G.PRiSM_project = {

    save: function (filename) {
        return _ensureInit().then(function () {
            // 1) Gather all gauge & analysis records (full data, not just metadata).
            var gaugeListP    = G.PRiSM_storage.listGauges().then(function (lst) {
                return _Promise.all(lst.map(function (e) { return G.PRiSM_storage.getGauge(e.id); }));
            });
            var analysisListP = G.PRiSM_storage.listAnalyses().then(function (lst) {
                return _Promise.all(lst.map(function (e) { return G.PRiSM_storage.getAnalysis(e.id); }));
            });
            return _Promise.all([gaugeListP, analysisListP]);
        }).then(function (pair) {
            var gauges = pair[0].filter(Boolean), analyses = pair[1].filter(Boolean);
            var gaugeData = gauges.map(function (g) {
                return {
                    id: g.id, metadata: g.metadata,
                    dataB64: g.data ? {
                        t: _bufToB64(g.data.t),
                        p: _bufToB64(g.data.p),
                        q: g.data.q ? _bufToB64(g.data.q) : null
                    } : null
                };
            });
            var analysisData = analyses.map(function (a) {
                return {
                    id: a.id, metadata: a.metadata, provenance: a.provenance,
                    dataB64: a.data ? {
                        t: _bufToB64(a.data.t),
                        p: _bufToB64(a.data.p),
                        q: a.data.q ? _bufToB64(a.data.q) : null
                    } : null
                };
            });
            // 2) Snapshot host state (the C8 key set + well inputs + data).
            _projectMeta.modifiedAt = _now();
            var stateSnap = _stateSnapshot();
            var project = {
                version: '1.0',
                meta: _projectMeta,
                gaugeData: gaugeData,
                analysisData: analysisData,
                state: stateSnap
            };
            var json = JSON.stringify(project);
            var blob;
            try {
                blob = new Blob([json], { type: 'application/json' });
            } catch (e) {
                blob = json;
            }
            var name = filename || (_projectMeta.name.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.prism');
            if (!/\.prism$/i.test(name)) name += '.prism';
            // Trigger browser download if we have URL.createObjectURL.
            if (_hasDoc && typeof URL !== 'undefined' && URL.createObjectURL && blob instanceof Blob) {
                try {
                    var url = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = url; a.download = name; a.style.display = 'none';
                    document.body.appendChild(a); a.click();
                    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 100);
                } catch (e) { /* silent */ }
            }
            _ga4('prism_project_saved', { gauge_count: gaugeData.length, analysis_count: analysisData.length, size_bytes: json.length });
            return { blob: blob, filename: name, sizeBytes: json.length };
        });
    },

    load: function (file) {
        if (!file) return _rejected(new Error('PRiSM_project.load: no file'));
        return _readFileAsText(file).then(function (text) {
            var proj;
            try { proj = JSON.parse(text); }
            catch (e) { throw new Error('PRiSM_project.load: invalid JSON'); }
            if (!proj || !proj.version) throw new Error('PRiSM_project.load: not a PRiSM project file');
            return G.PRiSM_project.loadFromObject(proj);
        });
    },

    // Programmatic load — used by self-test and round-trip.
    loadFromObject: function (proj) {
        return _restoreRecords(proj).then(function () {
            // Restore state.
            _projectMeta = proj.meta || _projectMeta;
            _projectMeta.modifiedAt = _now();
            var st = proj.state || {};
            _applyState(st);
            // Re-activate analysis if specified (commits the dataset);
            // else bring back the saved working data.
            if (st.activeAnalysisId) {
                return G.PRiSM_analysisData.activate(st.activeAnalysisId).catch(function () {
                    if (st.dataset && Array.isArray(st.dataset.t)) _commitDataset(st.dataset, 'project');
                });
            }
            _activeAnalysisId = null;
            if (st.dataset && Array.isArray(st.dataset.t)) _commitDataset(st.dataset, 'project');
            return null;
        }).then(function () {
            _refreshMounted();
            _ga4('prism_project_loaded', {
                gauge_count: (proj.gaugeData || []).length,
                analysis_count: (proj.analysisData || []).length
            });
        });
    },

    new: function () {
        return _ensureInit().then(function () { return _wipeAll(); }).then(function () {
            _activeAnalysisId = null;
            _commitDataset(null, 'project-new');
            _projectMeta = {
                name: 'Untitled project',
                createdAt: _now(),
                modifiedAt: _now()
            };
            _refreshMounted();
            _ga4('prism_project_new', {});
        });
    },

    info: function () {
        // Synchronous best-effort — uses cached counts.
        return {
            name:      _projectMeta.name,
            createdAt: _projectMeta.createdAt,
            modifiedAt: _projectMeta.modifiedAt,
            gaugeCount: G.PRiSM_project._lastCounts ? G.PRiSM_project._lastCounts.gauges : 0,
            analysisCount: G.PRiSM_project._lastCounts ? G.PRiSM_project._lastCounts.analyses : 0,
            sizeBytes: G.PRiSM_project._lastCounts ? G.PRiSM_project._lastCounts.sizeBytes : 0,
            backend: _backend || 'unknown'
        };
    },

    refreshInfo: function () {
        // Async refresh of cached counts (for UI).
        return _ensureInit().then(function () {
            return _Promise.all([G.PRiSM_storage.listGauges(), G.PRiSM_storage.listAnalyses()]);
        }).then(function (pair) {
            var sz = 0;
            pair[0].forEach(function (e) { sz += e.metaSize || 0; });
            pair[1].forEach(function (e) { sz += e.metaSize || 0; });
            G.PRiSM_project._lastCounts = {
                gauges: pair[0].length,
                analyses: pair[1].length,
                sizeBytes: sz
            };
            return G.PRiSM_project.info();
        });
    },

    setName: function (name) {
        _projectMeta.name = String(name || 'Untitled project');
        _projectMeta.modifiedAt = _now();
    }
};

function _wipeAll() {
    return _Promise.all([G.PRiSM_storage.listGauges(), G.PRiSM_storage.listAnalyses()])
        .then(function (pair) {
            var dels = [];
            pair[0].forEach(function (e) { dels.push(G.PRiSM_storage.deleteGauge(e.id)); });
            pair[1].forEach(function (e) { dels.push(G.PRiSM_storage.deleteAnalysis(e.id)); });
            return _Promise.all(dels);
        });
}

// Replace every stored gauge / analysis record with those of a project
// object ({ gaugeData, analysisData } with dataB64 buffers).
function _restoreRecords(proj) {
    return _ensureInit().then(function () {
        return _wipeAll();
    }).then(function () {
        var gaugePuts = (proj.gaugeData || []).filter(function (g) { return g && g.id; }).map(function (g) {
            return G.PRiSM_storage.putGauge(g.id, {
                metadata: g.metadata,
                createdAt: g.createdAt || (g.metadata && g.metadata.createdAt) || _now(),
                data: g.dataB64 ? {
                    t: _b64ToBuf(g.dataB64.t),
                    p: _b64ToBuf(g.dataB64.p),
                    q: g.dataB64.q ? _b64ToBuf(g.dataB64.q) : null
                } : null
            });
        });
        var analysisPuts = (proj.analysisData || []).filter(function (a) { return a && a.id; }).map(function (a) {
            return G.PRiSM_storage.putAnalysis(a.id, {
                metadata: a.metadata,
                provenance: a.provenance,
                createdAt: a.createdAt || (a.provenance && a.provenance.createdAt) || _now(),
                data: a.dataB64 ? {
                    t: _b64ToBuf(a.dataB64.t),
                    p: _b64ToBuf(a.dataB64.p),
                    q: a.dataB64.q ? _b64ToBuf(a.dataB64.q) : null
                } : null
            });
        });
        return _Promise.all(gaugePuts.concat(analysisPuts));
    });
}

// PRiSM state carried by a .prism file: the C8 persistence key set, the
// fit (C4), the well inputs (C1, without the computed block) and the
// working dataset (when it is not huge).
var STATE_KEYS = ['model', 'params', 'paramFreeze', 'phys', 'tcMatch', 'activePlot', 'activePeriod',
                  'bourdetL', 'timeFn', 'semilog', 'analysisKeyResults', 'mode', 'tab', 'presets'];

function _stateSnapshot() {
    var st = G.PRiSM_state || {};
    var out = { activeAnalysisId: _activeAnalysisId };
    for (var i = 0; i < STATE_KEYS.length; i++) {
        var k = STATE_KEYS[i];
        if (st[k] !== undefined) out[k] = _clone(st[k]);
    }
    var lf = null;
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; }
    }
    if (!lf) lf = st.lastFit || null;
    out.lastFit = _clone(lf);
    if (out.lastFit && typeof out.lastFit === 'object') delete out.lastFit.stale;
    if (G.PRiSM_pvt) {
        var pv = _clone(G.PRiSM_pvt);
        if (pv) delete pv._computed;
        out.pvt = pv;
    }
    var ds = G.PRiSM_dataset;
    if (ds && Array.isArray(ds.t) && ds.t.length && ds.t.length <= 200000) out.dataset = _clone(ds);
    return out;
}

// Restore through the shared setters when present: model first (it resets
// defaults), then params / state keys, then the fit, then the well inputs.
function _applyState(st) {
    if (!st || typeof st !== 'object') return;
    var S = G.PRiSM_state = G.PRiSM_state || {};
    var model = st.model || st.activeModel;              // legacy key accepted
    if (model) {
        if (typeof G.PRiSM_setModel === 'function') {
            try { G.PRiSM_setModel(model); } catch (e) { S.model = model; }
        } else {
            S.model = model;
        }
    }
    for (var i = 0; i < STATE_KEYS.length; i++) {
        var k = STATE_KEYS[i];
        if (k === 'model') continue;
        if (st[k] !== undefined && st[k] !== null) S[k] = _clone(st[k]);
    }
    if (st.lastFit) {
        if (typeof G.PRiSM_setLastFit === 'function') {
            try { G.PRiSM_setLastFit(_clone(st.lastFit)); } catch (e) { S.lastFit = _clone(st.lastFit); }
        } else {
            S.lastFit = _clone(st.lastFit);
        }
    }
    if (st.pvt && typeof st.pvt === 'object') {
        var pvt = G.PRiSM_pvt = G.PRiSM_pvt || {};           // extend, never replace
        for (var pk in st.pvt) {
            if (Object.prototype.hasOwnProperty.call(st.pvt, pk) && pk !== '_computed') pvt[pk] = _clone(st.pvt[pk]);
        }
        if (typeof G.PRiSM_pvt_compute === 'function') {
            try { G.PRiSM_pvt_compute(); } catch (e) { /* ignore */ }
        }
        var announced = false;
        if (typeof G.PRiSM_setWell === 'function') {
            try { G.PRiSM_setWell({}, { source: 'user' }); announced = true; } catch (e) { /* fall back */ }
        }
        if (!announced) _dispatch('prism:well-changed', { source: 'project' });
    }
    if (typeof G.PRiSM_saveState === 'function') {
        try { G.PRiSM_saveState(); } catch (e) { /* ignore */ }
    }
}

// ── Header project file (29) integration ────────────────────────────
// Module 'prism_gauges': read() is synchronous, served from the mirror.
// Registered once 29 has loaded (it loads after this file).
var _projModDone = false;
function _registerProjectModule() {
    if (_projModDone) return true;
    var P = G.WTS_project;
    if (!P || typeof P.registerModule !== 'function') return false;
    _projModDone = !!P.registerModule('prism_gauges', {
        read: function () {
            if (!_backend || _backend === 'localStorage') return null;   // covered by the 'storage' module
            var g = _mirrorList('gauge'), a = _mirrorList('analysis');
            if (!g.length && !a.length) return null;
            var size = 0;
            g.concat(a).forEach(function (r) { if (r.data) size += _byteLen(r.data); });
            if (size > MIRROR_MAX_BYTES) {
                var metaOnly = function (r) { return { id: r.id, metadata: r.metadata, provenance: r.provenance }; };
                return { truncated: true, activeAnalysisId: _activeAnalysisId,
                         gaugeData: g.map(metaOnly), analysisData: a.map(metaOnly) };
            }
            return { activeAnalysisId: _activeAnalysisId, gaugeData: g.map(_recToFile), analysisData: a.map(_recToFile) };
        },
        write: function (state) {
            if (!_Promise) return;
            if (state === null) {                                     // New
                _ensureInit().then(function () { return _wipeAll(); }).then(function () {
                    _activeAnalysisId = null;
                    _refreshMounted();
                }).catch(function () { /* ignore */ });
                return;
            }
            if (!state || typeof state !== 'object' || state.truncated) return;
            _restoreRecords(state).then(function () {
                _activeAnalysisId = state.activeAnalysisId || null;
                _refreshMounted();
            }).catch(function () { /* ignore */ });
        }
    });
    return _projModDone;
}
if (!_registerProjectModule() && _hasDoc && typeof document.addEventListener === 'function') {
    // One-shot: 29 is defined by the time the document has loaded.
    var _onDocReady = function () { _registerProjectModule(); };
    document.addEventListener('DOMContentLoaded', _onDocReady);
    if (_hasWin && typeof G.addEventListener === 'function') G.addEventListener('load', _onDocReady);
}

// Re-render every mounted datasets panel that is still in the document.
var _mountedHosts = [];
function _refreshMounted() {
    var hosts = _mountedHosts.slice();
    _mountedHosts = [];
    for (var i = 0; i < hosts.length; i++) {
        var h = hosts[i];
        if (!h || h.isConnected === false) continue;
        try { G.PRiSM_renderDatasetsPanel(h, h.__prismPanelOpts || {}); } catch (e) { /* ignore */ }
    }
}

function _readFileAsText(file) {
    return new _Promise(function (resolve, reject) {
        try {
            if (typeof FileReader === 'undefined') {
                reject(new Error('FileReader unavailable'));
                return;
            }
            var r = new FileReader();
            r.onload  = function (e) { resolve(e.target.result); };
            r.onerror = function ()  { reject(new Error('FileReader failed')); };
            r.readAsText(file);
        } catch (e) { reject(e); }
    });
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 5 — UI: GAUGE-DATA MANAGER
// ═══════════════════════════════════════════════════════════════════════
//
// Renders a card-style list of gauge entries with import/view/diff actions.
// Uses the host CSS classes (.card, .btn, etc.) when present; otherwise
// falls back to inline styles so it still looks correct on a bare page.
// ═══════════════════════════════════════════════════════════════════════

function _mkBtn(label, color, onClick) {
    if (!_hasDoc) return null;
    var b = document.createElement('button');
    b.className = 'btn ' + (color === 'primary' ? 'btn-primary' : 'btn-secondary');
    b.textContent = label;
    b.style.padding = '4px 10px';
    b.style.marginRight = '6px';
    b.style.fontSize = '12px';
    b.style.cursor = 'pointer';
    if (color === 'danger') {
        b.style.background = _theme().red;
        b.style.color = '#fff';
        b.style.border = '1px solid ' + _theme().red;
    }
    if (onClick) b.addEventListener('click', onClick);
    return b;
}

function _mkRow(label, value) {
    if (!_hasDoc) return null;
    var d = document.createElement('div');
    d.style.display = 'flex'; d.style.gap = '8px'; d.style.fontSize = '12px';
    // Built with textContent: label / value carry file names and .prism
    // metadata (user- or file-controlled strings), never markup.
    var a = document.createElement('span');
    a.style.color = _theme().text3; a.style.minWidth = '90px';
    a.textContent = String(label == null ? '' : label) + ':';
    var b = document.createElement('span');
    b.style.color = _theme().text;
    b.textContent = String(value == null ? '' : value);
    d.appendChild(a); d.appendChild(b);
    return d;
}

function _emptyHint(host, msg) {
    var d = document.createElement('div');
    d.style.padding = '16px'; d.style.textAlign = 'center';
    d.style.color = _theme().text3; d.style.fontSize = '13px';
    d.textContent = msg;
    host.appendChild(d);
}

G.PRiSM_renderGaugeManager = function (container) {
    if (!_hasDoc || !container) return;
    container.innerHTML = '';
    var T = _theme();
    var head = document.createElement('div');
    head.style.display = 'flex'; head.style.justifyContent = 'space-between';
    head.style.alignItems = 'center'; head.style.marginBottom = '12px';
    head.style.flexWrap = 'wrap'; head.style.gap = '8px';
    var title = document.createElement('div');
    title.innerHTML = '<span style="font-size:16px;font-weight:600;color:' + T.text + ';">Gauge Data</span>' +
                      '<span style="font-size:12px;color:' + T.text3 + ';margin-left:10px;">' +
                      'Raw imported pressure / rate measurements</span>';
    head.appendChild(title);
    var actions = document.createElement('div');
    var importBtn = _mkBtn('+ Import', 'primary', function () {
        _openImportPicker(container);
    });
    actions.appendChild(importBtn);
    head.appendChild(actions);
    container.appendChild(head);

    var listHost = document.createElement('div');
    listHost.style.display = 'grid';
    listHost.style.gridTemplateColumns = 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))';
    listHost.style.gap = '10px';
    container.appendChild(listHost);

    G.PRiSM_gaugeData.list().then(function (entries) {
        if (!entries || !entries.length) {
            _emptyHint(listHost, 'No gauge data yet. Click "+ Import" to add a CSV / TXT / XLSX file.');
            return;
        }
        entries.forEach(function (e) {
            listHost.appendChild(_renderGaugeTile(e, container));
        });
    }).catch(function (err) {
        _emptyHint(listHost, 'Storage error: ' + (err && err.message || err));
    });
};

function _renderGaugeTile(entry, rootContainer) {
    var T = _theme();
    var card = document.createElement('div');
    card.className = 'card';
    card.style.background = T.panel;
    card.style.border = '1px solid ' + T.border;
    card.style.borderRadius = '6px';
    card.style.padding = '12px';
    var name = document.createElement('div');
    name.style.fontWeight = '600'; name.style.color = T.accent;
    name.style.fontSize = '14px'; name.style.marginBottom = '8px';
    name.textContent = entry.metadata.name || 'Untitled';
    card.appendChild(name);
    if (entry.metadata.well) card.appendChild(_mkRow('Well', entry.metadata.well));
    card.appendChild(_mkRow('Samples', String(entry.metadata.sampleCount || 0)));
    if (entry.metadata.dateStart) card.appendChild(_mkRow('Start',
        String(entry.metadata.dateStart).slice(0, 19)));
    if (entry.metadata.dateEnd) card.appendChild(_mkRow('End',
        String(entry.metadata.dateEnd).slice(0, 19)));
    if (entry.metadata.source) card.appendChild(_mkRow('Source', entry.metadata.source));
    if (entry.metaSize) card.appendChild(_mkRow('Bytes', String(entry.metaSize)));
    if (entry.metadata.notes) {
        var n = document.createElement('div');
        n.style.fontSize = '11px'; n.style.color = T.text2;
        n.style.marginTop = '6px'; n.style.fontStyle = 'italic';
        n.textContent = entry.metadata.notes;
        card.appendChild(n);
    }
    var btnRow = document.createElement('div');
    btnRow.style.marginTop = '10px';
    btnRow.style.display = 'flex'; btnRow.style.flexWrap = 'wrap'; btnRow.style.gap = '4px';
    btnRow.appendChild(_mkBtn('Rename', null, function () {
        var newName = prompt('Rename gauge', entry.metadata.name);
        if (newName) {
            G.PRiSM_gaugeData.rename(entry.id, newName).then(function () {
                G.PRiSM_renderGaugeManager(rootContainer);
            });
        }
    }));
    btnRow.appendChild(_mkBtn('Duplicate', null, function () {
        G.PRiSM_gaugeData.duplicate(entry.id).then(function () {
            G.PRiSM_renderGaugeManager(rootContainer);
        });
    }));
    btnRow.appendChild(_mkBtn('Diff vs…', null, function () {
        _openDiffPicker(entry.id, rootContainer);
    }));
    btnRow.appendChild(_mkBtn('Delete', 'danger', function () {
        if (confirm('Delete gauge "' + entry.metadata.name + '"?')) {
            G.PRiSM_gaugeData.delete(entry.id).then(function () {
                G.PRiSM_renderGaugeManager(rootContainer);
            });
        }
    }));
    card.appendChild(btnRow);
    return card;
}

function _openImportPicker(rootContainer) {
    if (!_hasDoc) return;
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,.tsv,.txt,.dat,.asc';
    inp.style.display = 'none';
    inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        // Parse the file on its own (Data-step parser + column mapper when
        // present) — importing a gauge never replaces the working data.
        var name = f.name;
        if (/\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(name)) {
            alert('Spreadsheet gauges: load the file on the Data step, then use "Save working data as gauge".');
            return;
        }
        _readFileAsText(f).then(function (text) {
            return G.PRiSM_gaugeData.importText(text, { name: name.replace(/\.[^.]+$/, ''), source: name });
        }).then(function () {
            G.PRiSM_renderGaugeManager(rootContainer);
        }).catch(function (e) {
            alert('Import failed: ' + (e && e.message || e));
        });
    });
    document.body.appendChild(inp);
    inp.click();
    setTimeout(function () { try { document.body.removeChild(inp); } catch (e) {} }, 1000);
}

// Minimal CSV fallback: assume first numeric column = t, second = p, third = q.
function _quickCSV(text) {
    var t = [], p = [], q = [];
    var lines = String(text || '').split(/\r?\n/);
    var hasQ = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || /^[a-zA-Z#]/.test(line)) continue;
        var parts = line.split(/[\s,;\t]+/);
        var n = parts.map(parseFloat).filter(function (x) { return isFinite(x); });
        if (n.length >= 2) {
            t.push(n[0]); p.push(n[1]);
            if (n.length >= 3) { q.push(n[2]); hasQ = true; }
        }
    }
    return { t: t, p: p, q: hasQ ? q : null };
}

function _openDiffPicker(gaugeIdA, rootContainer) {
    if (!_hasDoc) return;
    G.PRiSM_gaugeData.list().then(function (entries) {
        var others = entries.filter(function (e) { return e.id !== gaugeIdA; });
        if (!others.length) { alert('Need at least 2 gauges to diff.'); return; }
        var modal = _modal();
        var h = document.createElement('div');
        h.style.fontSize = '15px'; h.style.fontWeight = '600';
        h.style.marginBottom = '10px'; h.style.color = _theme().accent;
        h.textContent = 'Diff gauges';
        modal.body.appendChild(h);
        var sel = document.createElement('select');
        sel.style.width = '100%'; sel.style.padding = '6px'; sel.style.marginBottom = '10px';
        sel.style.background = _theme().bg; sel.style.color = _theme().text;
        sel.style.border = '1px solid ' + _theme().border;
        others.forEach(function (e) {
            var opt = document.createElement('option');
            opt.value = e.id; opt.textContent = e.metadata.name + ' (' + e.metadata.sampleCount + ' samples)';
            sel.appendChild(opt);
        });
        modal.body.appendChild(sel);
        var canvas = document.createElement('canvas');
        canvas.width = 600; canvas.height = 280;
        canvas.style.width = '100%'; canvas.style.background = _theme().bg;
        canvas.style.border = '1px solid ' + _theme().border;
        modal.body.appendChild(canvas);
        var summary = document.createElement('div');
        summary.style.fontSize = '12px'; summary.style.color = _theme().text2;
        summary.style.marginTop = '8px';
        modal.body.appendChild(summary);

        var go = _mkBtn('Compute', 'primary', function () {
            G.PRiSM_gaugeData.diff(gaugeIdA, sel.value).then(function (d) {
                G.PRiSM_drawDiff(canvas, d);
                summary.textContent = 'n=' + d.nCommon + ' common samples, RMS Δp = ' + d.rmsDiff.toFixed(3) +
                                      ', range t = [' + d.startCommon.toFixed(3) + ', ' + d.endCommon.toFixed(3) + ']';
            }).catch(function (err) {
                summary.textContent = 'Error: ' + (err && err.message || err);
            });
        });
        modal.body.appendChild(go);
        modal.body.appendChild(_mkBtn('Close', null, function () { modal.close(); }));
    });
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 6 — UI: ANALYSIS-DATA MANAGER
// ═══════════════════════════════════════════════════════════════════════

G.PRiSM_renderAnalysisManager = function (container) {
    if (!_hasDoc || !container) return;
    container.innerHTML = '';
    var T = _theme();
    var head = document.createElement('div');
    head.style.display = 'flex'; head.style.justifyContent = 'space-between';
    head.style.alignItems = 'center'; head.style.marginBottom = '12px';
    head.style.flexWrap = 'wrap'; head.style.gap = '8px';
    var title = document.createElement('div');
    title.innerHTML = '<span style="font-size:16px;font-weight:600;color:' + T.text + ';">Analysis Data</span>' +
                      '<span style="font-size:12px;color:' + T.text3 + ';margin-left:10px;">' +
                      'Sampled subsets prepared for interpretation</span>';
    head.appendChild(title);
    var actions = document.createElement('div');
    actions.appendChild(_mkBtn('+ Sample from gauge', 'primary', function () {
        _openSamplerModal(container);
    }));
    head.appendChild(actions);
    container.appendChild(head);

    var listHost = document.createElement('div');
    listHost.style.display = 'grid';
    listHost.style.gridTemplateColumns = 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))';
    listHost.style.gap = '10px';
    container.appendChild(listHost);

    G.PRiSM_analysisData.list().then(function (entries) {
        if (!entries || !entries.length) {
            _emptyHint(listHost, 'No analysis subsets yet. Import a gauge first, then click "+ Sample from gauge".');
            return;
        }
        entries.forEach(function (e) {
            listHost.appendChild(_renderAnalysisTile(e, container));
        });
    }).catch(function (err) {
        _emptyHint(listHost, 'Storage error: ' + (err && err.message || err));
    });
};

function _renderAnalysisTile(entry, rootContainer) {
    var T = _theme();
    var card = document.createElement('div');
    card.className = 'card';
    card.style.background = T.panel;
    card.style.border = '1px solid ' + T.border;
    card.style.borderRadius = '6px';
    card.style.padding = '12px';
    var isActive = (G.PRiSM_analysisData.activeId() === entry.id);
    if (isActive) {
        card.style.border = '2px solid ' + T.green;
    }
    var name = document.createElement('div');
    name.style.fontWeight = '600'; name.style.color = isActive ? T.green : T.accent;
    name.style.fontSize = '14px'; name.style.marginBottom = '8px';
    name.textContent = (isActive ? '● ' : '') + (entry.metadata.name || 'Untitled');
    card.appendChild(name);
    card.appendChild(_mkRow('Samples', String(entry.metadata.sampleCount || 0)));
    if (entry.metadata.filter) card.appendChild(_mkRow('Filter', entry.metadata.filter));
    if (entry.metadata.decimate && entry.metadata.decimate !== 'none') {
        card.appendChild(_mkRow('Decimate', entry.metadata.decimate));
    }
    var btnRow = document.createElement('div');
    btnRow.style.marginTop = '10px';
    btnRow.style.display = 'flex'; btnRow.style.flexWrap = 'wrap'; btnRow.style.gap = '4px';
    if (!isActive) {
        btnRow.appendChild(_mkBtn('Activate', 'primary', function () {
            G.PRiSM_analysisData.activate(entry.id).then(function () {
                G.PRiSM_renderAnalysisManager(rootContainer);
            });
        }));
    }
    btnRow.appendChild(_mkBtn('Rename', null, function () {
        var nm = prompt('Rename analysis', entry.metadata.name);
        if (nm) {
            G.PRiSM_analysisData.rename(entry.id, nm).then(function () {
                G.PRiSM_renderAnalysisManager(rootContainer);
            });
        }
    }));
    btnRow.appendChild(_mkBtn('Duplicate', null, function () {
        G.PRiSM_analysisData.duplicate(entry.id).then(function () {
            G.PRiSM_renderAnalysisManager(rootContainer);
        });
    }));
    btnRow.appendChild(_mkBtn('Delete', 'danger', function () {
        if (confirm('Delete analysis "' + entry.metadata.name + '"?')) {
            G.PRiSM_analysisData.delete(entry.id).then(function () {
                G.PRiSM_renderAnalysisManager(rootContainer);
            });
        }
    }));
    card.appendChild(btnRow);
    return card;
}

function _openSamplerModal(rootContainer) {
    if (!_hasDoc) return;
    G.PRiSM_gaugeData.list().then(function (gauges) {
        if (!gauges || !gauges.length) {
            alert('Import a gauge file first.');
            return;
        }
        var modal = _modal();
        var T = _theme();
        var h = document.createElement('div');
        h.style.fontSize = '15px'; h.style.fontWeight = '600';
        h.style.marginBottom = '10px'; h.style.color = T.accent;
        h.textContent = 'Sample new analysis from gauge';
        modal.body.appendChild(h);

        function _label(t) {
            var d = document.createElement('div');
            d.style.fontSize = '12px'; d.style.color = T.text3;
            d.style.marginTop = '8px'; d.textContent = t;
            return d;
        }

        modal.body.appendChild(_label('Source gauge'));
        var sel = document.createElement('select');
        sel.style.width = '100%'; sel.style.padding = '6px';
        sel.style.background = T.bg; sel.style.color = T.text;
        sel.style.border = '1px solid ' + T.border;
        gauges.forEach(function (g) {
            var opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = g.metadata.name + ' (' + g.metadata.sampleCount + ' samples)';
            sel.appendChild(opt);
        });
        modal.body.appendChild(sel);

        modal.body.appendChild(_label('Name'));
        var nameInp = document.createElement('input');
        nameInp.type = 'text'; nameInp.value = 'Sample ' + new Date().toISOString().slice(0, 16);
        nameInp.style.width = '100%'; nameInp.style.padding = '6px';
        nameInp.style.background = T.bg; nameInp.style.color = T.text;
        nameInp.style.border = '1px solid ' + T.border;
        modal.body.appendChild(nameInp);

        modal.body.appendChild(_label('Time range (start, end) — leave blank for full range'));
        var rangeWrap = document.createElement('div');
        rangeWrap.style.display = 'flex'; rangeWrap.style.gap = '6px';
        var rStart = document.createElement('input');
        var rEnd   = document.createElement('input');
        [rStart, rEnd].forEach(function (e) {
            e.type = 'number'; e.style.flex = '1'; e.style.padding = '6px';
            e.style.background = T.bg; e.style.color = T.text;
            e.style.border = '1px solid ' + T.border;
        });
        rStart.placeholder = 'start'; rEnd.placeholder = 'end';
        rangeWrap.appendChild(rStart); rangeWrap.appendChild(rEnd);
        modal.body.appendChild(rangeWrap);

        modal.body.appendChild(_label('Filter'));
        var fSel = document.createElement('select');
        ['none', 'mad', 'movingAvg', 'hampel'].forEach(function (v) {
            var o = document.createElement('option'); o.value = v; o.textContent = v; fSel.appendChild(o);
        });
        fSel.style.width = '100%'; fSel.style.padding = '6px';
        fSel.style.background = T.bg; fSel.style.color = T.text;
        fSel.style.border = '1px solid ' + T.border;
        modal.body.appendChild(fSel);

        modal.body.appendChild(_label('Decimate'));
        var dSel = document.createElement('select');
        ['none', 'nth', 'log', 'timeBin'].forEach(function (v) {
            var o = document.createElement('option'); o.value = v; o.textContent = v; dSel.appendChild(o);
        });
        dSel.style.width = '100%'; dSel.style.padding = '6px';
        dSel.style.background = T.bg; dSel.style.color = T.text;
        dSel.style.border = '1px solid ' + T.border;
        modal.body.appendChild(dSel);

        modal.body.appendChild(_label('Decimate parameter (every-N | nPerDecade | binMinutes)'));
        var dParam = document.createElement('input');
        dParam.type = 'number'; dParam.value = '50';
        dParam.style.width = '100%'; dParam.style.padding = '6px';
        dParam.style.background = T.bg; dParam.style.color = T.text;
        dParam.style.border = '1px solid ' + T.border;
        modal.body.appendChild(dParam);

        var msg = document.createElement('div');
        msg.style.fontSize = '12px'; msg.style.color = T.text2;
        msg.style.marginTop = '8px'; msg.style.minHeight = '16px';
        modal.body.appendChild(msg);

        var btnRow = document.createElement('div');
        btnRow.style.marginTop = '10px';
        btnRow.appendChild(_mkBtn('Save', 'primary', function () {
            var opts = {
                name: nameInp.value,
                filter: fSel.value === 'none' ? null : fSel.value,
                decimate: dSel.value,
                decimateParam: dSel.value === 'nth'      ? { every: parseInt(dParam.value, 10) || 1 } :
                               dSel.value === 'log'      ? { nPerDecade: parseFloat(dParam.value) || 50 } :
                               dSel.value === 'timeBin'  ? { binMinutes: parseFloat(dParam.value) || 1 } :
                               null
            };
            if (rStart.value !== '' || rEnd.value !== '') {
                opts.timeRange = {
                    start: rStart.value !== '' ? parseFloat(rStart.value) : null,
                    end:   rEnd.value   !== '' ? parseFloat(rEnd.value)   : null
                };
            }
            msg.textContent = 'Sampling…';
            G.PRiSM_analysisData.sample([sel.value], opts).then(function () {
                modal.close();
                G.PRiSM_renderAnalysisManager(rootContainer);
            }).catch(function (err) {
                msg.textContent = 'Error: ' + (err && err.message || err);
            });
        }));
        btnRow.appendChild(_mkBtn('Cancel', null, function () { modal.close(); }));
        modal.body.appendChild(btnRow);
    });
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 6B — UI: "Gauges & analysis datasets" panel (Tab 1, C7)
// ═══════════════════════════════════════════════════════════════════════
// Both managers plus the .prism import / export. There is deliberately no
// New / Save / Open project toolbar here: the header project file (29)
// owns those, and carries these records through the 'prism_gauges' module.

function _workingLine() {
    var ds = G.PRiSM_dataset;
    if (!ds || !Array.isArray(ds.t) || !ds.t.length) return 'Working data: none loaded.';
    var t0 = ds.t[0], t1 = ds.t[ds.t.length - 1];
    var fmt = function (v) { return (isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : +v.toPrecision(3)) : '?'); };
    var s = 'Working data: ' + ds.t.length + ' points · ' + fmt(t0) + '–' + fmt(t1) + ' h'
          + (Array.isArray(ds.q) ? ' · with rates' : '');
    if (ds.analysisId && ds.analysisId === _activeAnalysisId) s += ' · from analysis set "' + (ds.name || ds.analysisId) + '"';
    else if (ds.source && ds.source !== 'analysis-data') s += ' · ' + ds.source;
    return s;
}

function _updateWorkingLines() {
    for (var i = 0; i < _mountedHosts.length; i++) {
        var h = _mountedHosts[i];
        var el = (h && h.querySelector) ? h.querySelector('.prism-dsets-working') : null;
        if (el) el.textContent = _workingLine();
    }
}
if (_hasWin && typeof G.addEventListener === 'function') {
    G.addEventListener('prism:dataset-loaded', _updateWorkingLines);
}

G.PRiSM_renderDatasetsPanel = function (container, opts) {
    if (!_hasDoc || !container) return;
    opts = opts || {};
    container.__prismPanelOpts = opts;
    if (_mountedHosts.indexOf(container) === -1) _mountedHosts.push(container);
    _registerProjectModule();

    container.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'prism-datasets';
    wrap.style.cssText = 'color:var(--text,#e6edf3); font-size:12px; line-height:1.5; max-width:100%; box-sizing:border-box;'
        + (opts.embedded ? '' : ' border:1px solid var(--border,#30363d); border-radius:6px; padding:12px; background:var(--bg2,#161b22);');
    if (!opts.embedded) {
        var ttl = document.createElement('div');
        ttl.style.cssText = 'font-weight:700; font-size:14px; margin-bottom:6px;';
        ttl.textContent = 'Gauges & analysis datasets';
        wrap.appendChild(ttl);
    }
    var intro = document.createElement('div');
    intro.style.cssText = 'color:var(--text2,#8b949e); margin-bottom:8px;';
    intro.textContent = 'Keep several gauge records and prepared analysis sets in one project. '
        + 'Activating an analysis set makes it the working data.';
    wrap.appendChild(intro);

    var working = document.createElement('div');
    working.className = 'prism-dsets-working';
    working.style.cssText = 'padding:6px 10px; background:var(--bg1,#0d1117); border-left:3px solid var(--blue,#58a6ff); border-radius:4px; margin-bottom:8px;';
    working.textContent = _workingLine();
    wrap.appendChild(working);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:6px;';
    var msg = document.createElement('div');
    msg.className = 'prism-dsets-msg';
    msg.style.cssText = 'min-height:14px; font-size:11.5px; color:var(--text2,#8b949e); margin-bottom:8px;';
    var say = function (text, kind) {
        msg.style.color = kind === 'err' ? 'var(--red,#f85149)' : kind === 'ok' ? 'var(--green,#3fb950)' : 'var(--text2,#8b949e)';
        msg.textContent = text;
    };

    var gHost = document.createElement('div');
    gHost.id = 'prism_gauge_manager';
    gHost.style.marginTop = '6px';
    var aHost = document.createElement('div');
    aHost.id = 'prism_analysis_manager';
    aHost.style.marginTop = '14px';

    var bAdd = _mkBtn('Save working data as gauge', 'primary', function () {
        G.PRiSM_gaugeData.addFromDataset(null).then(function () {
            say('Working data stored as a gauge.', 'ok');
            G.PRiSM_renderGaugeManager(gHost);
        }).catch(function (e) { say(String(e && e.message || e), 'err'); });
    });
    bAdd.id = 'prism_dsets_add_working';
    var bImp = _mkBtn('Import .prism', null, function () {
        var inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.prism,.json';
        inp.style.display = 'none';
        inp.addEventListener('change', function () {
            var f = inp.files && inp.files[0];
            if (!f) return;
            say('Loading ' + f.name + '…');
            G.PRiSM_project.load(f).then(function () {
                say('Loaded ' + f.name + '.', 'ok');
            }).catch(function (err) { say('Load failed: ' + (err && err.message || err), 'err'); });
        });
        document.body.appendChild(inp); inp.click();
        setTimeout(function () { try { document.body.removeChild(inp); } catch (e) { /* ignore */ } }, 1000);
    });
    bImp.id = 'prism_dsets_import';
    var bExp = _mkBtn('Export .prism', null, function () {
        G.PRiSM_project.save().then(function (out) {
            say('Saved ' + out.filename + ' (' + Math.max(1, Math.round(out.sizeBytes / 1024)) + ' KB).', 'ok');
        }).catch(function (err) { say('Save failed: ' + (err && err.message || err), 'err'); });
    });
    bExp.id = 'prism_dsets_export';
    [bAdd, bImp, bExp].forEach(function (b) { b.style.marginRight = '0'; b.style.minHeight = '32px'; actions.appendChild(b); });
    wrap.appendChild(actions);
    wrap.appendChild(msg);
    wrap.appendChild(gHost);
    wrap.appendChild(aHost);
    container.appendChild(wrap);

    G.PRiSM_renderGaugeManager(gHost);
    G.PRiSM_renderAnalysisManager(aHost);
};


// ═══════════════════════════════════════════════════════════════════════
// SECTION 7 — UI: .prism FILE TOOLBAR (import / export / info only — the
// header project file of 29 owns New / Open / Save of the whole project)
// ═══════════════════════════════════════════════════════════════════════

G.PRiSM_renderProjectToolbar = function (container) {
    if (!_hasDoc || !container) return;
    container.innerHTML = '';
    var T = _theme();
    var bar = document.createElement('div');
    bar.style.display = 'flex'; bar.style.alignItems = 'center'; bar.style.flexWrap = 'wrap';
    bar.style.gap = '6px'; bar.style.padding = '8px';
    bar.style.background = T.panel; bar.style.border = '1px solid ' + T.border;
    bar.style.borderRadius = '6px'; bar.style.maxWidth = '100%'; bar.style.boxSizing = 'border-box';

    var pName = document.createElement('span');
    pName.style.color = T.accent; pName.style.fontWeight = '600';
    pName.style.marginRight = '12px';
    pName.textContent = _projectMeta.name;
    bar.appendChild(pName);

    var note = document.createElement('div');
    note.style.cssText = 'flex-basis:100%; font-size:11px; color:' + T.text2 + ';';
    note.textContent = '.prism files carry the gauge / analysis sets and the PRiSM state. '
        + 'New / Save / Open of the whole project are in the page header.';

    var bImp = _mkBtn('Import .prism', null, function () {
        var inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.prism,.json';
        inp.style.display = 'none';
        inp.addEventListener('change', function () {
            var f = inp.files && inp.files[0];
            if (!f) return;
            G.PRiSM_project.load(f).then(function () {
                pName.textContent = _projectMeta.name;
            }).catch(function (err) {
                alert('Load failed: ' + (err && err.message || err));
            });
        });
        document.body.appendChild(inp); inp.click();
        setTimeout(function () { try { document.body.removeChild(inp); } catch (e) {} }, 1000);
    });
    bImp.id = 'prism_prj_import';
    bar.appendChild(bImp);
    var bExp = _mkBtn('Export .prism', null, function () {
        G.PRiSM_project.save().catch(function (err) {
            alert('Save failed: ' + (err && err.message || err));
        });
    });
    bExp.id = 'prism_prj_export';
    bar.appendChild(bExp);
    bar.appendChild(_mkBtn('Info', null, function () {
        G.PRiSM_project.refreshInfo().then(function (info) {
            alert('Project: ' + info.name +
                  '\nGauges: ' + info.gaugeCount +
                  '\nAnalyses: ' + info.analysisCount +
                  '\nSize: ~' + info.sizeBytes + ' bytes' +
                  '\nBackend: ' + info.backend +
                  '\nCreated: ' + info.createdAt +
                  '\nModified: ' + info.modifiedAt);
        });
    }));
    bar.appendChild(note);

    container.appendChild(bar);
};


// ═══════════════════════════════════════════════════════════════════════
// SECTION 8 — DIFF PLOT (uses canvas) + tiny modal helper
// ═══════════════════════════════════════════════════════════════════════

G.PRiSM_drawDiff = function (canvas, diff) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width || 600, H = canvas.height || 280;
    var T = _theme();
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    if (!diff || !diff.t || !diff.t.length) {
        ctx.fillStyle = T.text3; ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No common samples — gauges do not overlap in time', W / 2, H / 2);
        return;
    }
    var pad = { l: 50, r: 16, t: 16, b: 28 };
    var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    var t = diff.t, dp = diff.dp;
    var tMin = t[0], tMax = t[t.length - 1];
    var dpMin = Infinity, dpMax = -Infinity;
    for (var i = 0; i < dp.length; i++) {
        if (isFinite(dp[i])) {
            if (dp[i] < dpMin) dpMin = dp[i];
            if (dp[i] > dpMax) dpMax = dp[i];
        }
    }
    if (!isFinite(dpMin)) { dpMin = -1; dpMax = 1; }
    if (dpMin === dpMax) { dpMin -= 1; dpMax += 1; }
    var dpRange = dpMax - dpMin;
    dpMin -= dpRange * 0.05; dpMax += dpRange * 0.05;
    var tRange = tMax - tMin;
    if (tRange === 0) tRange = 1;

    function _xT(x) { return pad.l + ((x - tMin) / tRange) * pw; }
    function _yT(y) { return pad.t + ph - ((y - dpMin) / (dpMax - dpMin)) * ph; }

    // Axes
    ctx.strokeStyle = T.border; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + ph);
    ctx.lineTo(pad.l + pw, pad.t + ph); ctx.stroke();

    // Zero line
    if (dpMin < 0 && dpMax > 0) {
        ctx.strokeStyle = T.gridMajor; ctx.beginPath();
        ctx.moveTo(pad.l, _yT(0)); ctx.lineTo(pad.l + pw, _yT(0));
        ctx.stroke();
    }

    // Plot dp(t)
    ctx.strokeStyle = T.cyan; ctx.lineWidth = 1.5;
    ctx.beginPath();
    var started = false;
    for (var k = 0; k < t.length; k++) {
        if (!isFinite(dp[k])) continue;
        var x = _xT(t[k]), y = _yT(dp[k]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Labels
    ctx.fillStyle = T.text2; ctx.font = '11px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Δp (psi)', pad.l + 4, pad.t + 2);
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('t', pad.l + pw - 2, pad.t + ph + 4);

    // Y tick labels (min, mid, max)
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(dpMax.toFixed(2), pad.l - 4, pad.t + 4);
    ctx.fillText(dpMin.toFixed(2), pad.l - 4, pad.t + ph - 4);
    ctx.fillText(((dpMin + dpMax) / 2).toFixed(2), pad.l - 4, pad.t + ph / 2);
};

function _modal() {
    if (!_hasDoc) return { body: null, close: function () {} };
    var T = _theme();
    var bg = document.createElement('div');
    bg.style.position = 'fixed'; bg.style.left = '0'; bg.style.top = '0';
    bg.style.right = '0'; bg.style.bottom = '0';
    bg.style.background = 'rgba(0,0,0,0.65)';
    bg.style.zIndex = '9999';
    bg.style.display = 'flex'; bg.style.alignItems = 'center'; bg.style.justifyContent = 'center';
    var box = document.createElement('div');
    box.style.background = T.panel; box.style.border = '1px solid ' + T.border;
    box.style.borderRadius = '6px'; box.style.padding = '16px';
    box.style.maxWidth = '640px'; box.style.width = '92%'; box.style.boxSizing = 'border-box';
    box.style.maxHeight = '80vh'; box.style.overflow = 'auto';
    bg.appendChild(box);
    document.body.appendChild(bg);
    function close() {
        try { document.body.removeChild(bg); } catch (e) {}
    }
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    return { body: box, close: close };
}


// ═══════════════════════════════════════════════════════════════════════
// PANEL REGISTRATION (C7) — Tab 1, after Well & Test, crop and tide.
// ═══════════════════════════════════════════════════════════════════════
_registerPanel(1, {
    id: 'prism_datasets',
    title: 'Gauges & analysis datasets',
    order: 50,
    collapsed: true,
    tool: true,
    description: 'Several gauge records and analysis sets per project; .prism import / export',
    render: function (hostEl) { G.PRiSM_renderDatasetsPanel(hostEl, { embedded: true }); }
});


// ═══════════════════════════════════════════════════════════════════════

})();

// ─── END 19-data-managers ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 20-plt-inverse ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 20 — Synthetic PLT + Inverse Simulation
//   Synthetic PLT: per-layer rate contribution from a multi-layer fit
//   Inverse Sim: reconstruct rate history q(t) from pressure p(t)
//                given a forward-simulation model
// ════════════════════════════════════════════════════════════════════
//
// PUBLIC API (all on window.*)
//   window.PRiSM_syntheticPLT(modelKey, params, t, q_total, opts?)
//                                         → { layers, totalRate, cumulative,
//                                             diagnostics }
//        opts.khTotal  — scale layer kh to the fitted kh (md·ft)
//        opts.tdFactor — td = tdFactor·t for the cross-flow transition
//   window.PRiSM_renderPLTPanel(container, opts?) → void
//   window.PRiSM_inverseSim(modelKey, params, t, p, opts?)
//                                         → { q, converged, iterations,
//                                             rmse, pRef, pRefSource, ... }
//        opts.pRef / pRefSource  reference (initial) pressure; default the
//                                well's pi (C1), else extrapolated to tStart
//        opts.tStart             time the flow started (default 0 when the
//                                data start near 0)
//        opts.injector           Δp = p − pRef (injection) instead of pRef − p
//        opts.k                  permeability override (md)
//   window.PRiSM_inverseSimDataset(ds?, opts?) → same, inputs from C1/C2/C4
//   window.PRiSM_renderInverseSimPanel(container, opts?) → void
//   window.PRiSM_renderPLTInversePanel(container, opts?) → Tab 6 panel
//        "PLT & inverse simulation" (C7)
//   window.PRiSM_unitRateResponse(modelKey, params, tEval, opts?) → number[]
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • No external dependencies — pure vanilla JS, Math.*.
//   • Defensive: degenerate inputs return a clearly-flagged result instead
//     of throwing. Inverse sim returns {converged:false, ...} on failure
//     rather than throwing.
//   • Real units when possible: with the well inputs (C1: μ, B, ct, h, φ, rw)
//     and a fitted permeability (C4: lastFit.phys.k, else phys.kh / h) the
//     unit-rate response is in psi per STB/d (Mscf/d gas) and the recovered
//     q is in rate units. Otherwise it falls back to dimensionless td/pd.
//
// FOUNDATION PRIMITIVES IN SCOPE
//   PRiSM_MODELS[modelKey].pd(td, params)            forward pressure
//   PRiSM_logspace(min, max, n)                      log spaced grid
//   PRiSM_compute_bourdet(t, dp, L)                  Bourdet derivative
//   PRiSM_getWell() (C1) / PRiSM_getAnalysisData() (C2) / PRiSM_getLastFit() (C4)
//   PRiSM_state.lastFit / .model / .params           fallbacks
//   PRiSM_pvt                                        fallback well inputs
//   PRiSM_dataset                                    active dataset {t,p,q}
//
// REFERENCES
//   • Lefkovits, Hazebroek, Allen, Matthews — "A Study of the Behavior of
//     Bounded Reservoirs Composed of Stratified Layers", SPEJ March 1961
//     (per-layer rate fraction = kh_i / Σkh in commingled / no-XF case).
//   • Kuchuk, F.J. — "Pressure-Transient Behavior of Multilayered Composite
//     Reservoirs", SPE 18125 (1991).
//   • von Schroeter, Hollaender, Gringarten — "Deconvolution of Well Test
//     Data as a Nonlinear Total Least Squares Problem", SPE 71574 (2001)
//     (the deconvolution / inverse-rate framework).
//   • Levitan, M.M. — "Practical Application of Pressure/Rate Deconvolution
//     to Analysis of Real Well Tests", SPE 84290 (2003).
//   • Earlougher, R.C. — "Advances in Well Test Analysis", SPE Mono 5
//     (1977) — dimensional conversions: Δp = 141.2·q·μ·B/(k·h)·pd.
//
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

// ───────────────────────────────────────────────────────────────
// Tiny env shims so the module can load in node smoke-tests.
// ───────────────────────────────────────────────────────────────
var _hasDoc = (typeof document !== 'undefined');
var _hasWin = (typeof window !== 'undefined');
var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

// ───────────────────────────────────────────────────────────────
// Tiny formatting helpers (mirror the look used in 14/15-tabs).
// ───────────────────────────────────────────────────────────────
function _isNum(v) { return (typeof v === 'number') && isFinite(v); }
function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function _fmt(v, dp) {
    if (!_isNum(v)) return '—';
    var d = (dp == null) ? 4 : dp;
    return Number(v).toFixed(d);
}
function _fmtSig(v, sig) {
    if (!_isNum(v)) return '—';
    if (v === 0) return '0';
    sig = sig || 4;
    var a = Math.abs(v);
    if (a >= 1e6 || a < 1e-3) return Number(v).toExponential(sig - 1);
    return Number(v).toPrecision(sig).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// Theme palette — matches PRiSM_THEME if available.
function _theme() {
    if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
    return {
        bg:        '#0d1117', panel: '#161b22', border: '#30363d',
        grid:      '#21262d', gridMajor: '#30363d',
        text:      '#c9d1d9', text2: '#8b949e', text3: '#6e7681',
        accent:    '#f0883e', blue: '#58a6ff', green: '#3fb950',
        red:       '#f85149', yellow: '#d29922', cyan: '#39c5cf',
        purple:    '#bc8cff'
    };
}

// Per-layer colours for the stacked-area chart (cycle if N > LEN).
var _LAYER_COLORS = ['#58a6ff', '#3fb950', '#f0883e', '#bc8cff', '#39c5cf',
                     '#f85149', '#d29922', '#ff7b72', '#a5d6ff', '#7ee787'];

// Locate Bourdet helper (foundation or fallback).
function _bourdet(t, dp, L) {
    if (typeof G.PRiSM_compute_bourdet === 'function') {
        return G.PRiSM_compute_bourdet(t, dp, L);
    }
    // Fallback inline (mirrors layer-2 implementation).
    L = L || 0;
    var n = t.length;
    var d = new Array(n);
    for (var k = 0; k < n; k++) d[k] = NaN;
    if (n < 3) return d;
    for (var i = 1; i < n - 1; i++) {
        if (!_isNum(t[i]) || t[i] <= 0 || !_isNum(dp[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
        }
        var t1 = t[i1], t2 = t[i2], ti = t[i];
        if (!_isNum(t1) || !_isNum(t2) || t1 <= 0 || t2 <= 0) continue;
        var dl1 = Math.log(ti) - Math.log(t1);
        var dl2 = Math.log(t2) - Math.log(ti);
        var dlT = Math.log(t2) - Math.log(t1);
        if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
        var a = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT);
        var b = (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
        d[i] = a + b;
    }
    return d;
}

// Resolve the registry entry, returning null on miss.
function _model(modelKey) {
    var reg = G.PRiSM_MODELS;
    if (!reg) return null;
    return reg[modelKey] || null;
}

// ───────────────────────────────────────────────────────────────
// Shared-contract adapters (C1 well, C2 analysis data, C4 fit, C7
// panels). Every cross-module call is guarded with a local fallback.
// ───────────────────────────────────────────────────────────────
function _num(v) { return _isNum(v) ? v : null; }

// C1 well & fluid inputs → { mu, B, ct, h, phi, rw, q, pi, fluid, testType }.
function _wellDims() {
    var w = null;
    if (typeof G.PRiSM_getWell === 'function') {
        try { w = G.PRiSM_getWell(); } catch (e) { w = null; }
    }
    if (w && typeof w === 'object') {
        return {
            mu: _num(w.mu), B: _num(w.B), ct: _num(w.ct), h: _num(w.h), phi: _num(w.phi),
            rw: _num(w.rw), q: _num(w.q), pi: _num(w.pi), fluid: w.fluid || 'oil',
            testType: w.testType || 'auto', source: 'well'
        };
    }
    var pvt = G.PRiSM_pvt || {}, c = pvt._computed || {};
    var fluid = pvt.fluidType || 'oil';
    var B  = _num(fluid === 'gas' ? pvt.Bg : (fluid === 'water' ? pvt.Bw : pvt.Bo));
    var mu = _num(fluid === 'gas' ? pvt.mu_g : (fluid === 'water' ? pvt.mu_w : pvt.mu_o));
    var ct = _num(pvt.ct);
    if (B === null) B = _num(c.B);
    if (mu === null) mu = _num(c.mu);
    if (ct === null) ct = _num(c.ct);
    var prov = pvt.provenance || {};
    var piOk = (prov.p_res === 'user' || prov.p_res === 'sample' || prov.p_res === 'deconvolution');
    return {
        mu: mu, B: B, ct: ct, h: _num(pvt.h), phi: _num(pvt.phi), rw: _num(pvt.rw),
        q: _num(pvt.q), pi: piOk ? _num(pvt.p_res) : null, fluid: fluid,
        testType: pvt.testType || 'auto', source: 'pvt'
    };
}
function _dimsOK(w) {
    return !!(w && w.mu > 0 && w.B > 0 && w.ct > 0 && w.h > 0 && w.phi > 0 && w.rw > 0);
}
function _rateUnit(w) {
    var f = w && w.fluid;
    return f === 'gas' ? 'Mscf/d' : (f === 'water' ? 'BWPD' : 'STB/d');
}

// C4 last fit (normalised copy when the setter/getter exists).
function _getLastFit() {
    var lf = null;
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; }
    }
    if (!lf) {
        var st = G.PRiSM_state;
        lf = (st && st.lastFit && typeof st.lastFit === 'object') ? st.lastFit : null;
    }
    return lf;
}

// Fitted model + physical results: { modelKey, params, phys, k, kh, kSource }.
// k comes from lastFit.phys.k, else phys.kh / h (legacy k_md / kh_md_ft last).
function _fitInfo(w) {
    var st = G.PRiSM_state || {};
    var lf = _getLastFit();
    var modelKey = (lf && (lf.modelKey || lf.model)) || st.model || null;
    var params = (lf && lf.params) || st.params || {};
    var phys = (lf && lf.phys && typeof lf.phys === 'object') ? lf.phys : null;
    var h = w ? w.h : null;
    var k = null, kh = null, kSource = null;
    if (phys) {
        if (_num(phys.k) > 0) { k = phys.k; kSource = 'fit'; }
        if (_num(phys.kh) > 0) kh = phys.kh;
        if (k === null && kh !== null && h > 0) { k = kh / h; kSource = 'fit (kh / h)'; }
    }
    if (k === null && lf) {
        if (_num(lf.k_md) > 0) { k = lf.k_md; kSource = 'fit'; }
        else if (_num(lf.kh_md_ft) > 0 && h > 0) { k = lf.kh_md_ft / h; kSource = 'fit (kh / h)'; }
    }
    if (kh === null && k !== null && h > 0) kh = k * h;
    return { modelKey: modelKey, params: params, phys: phys, k: k, kh: kh, kSource: kSource,
             source: lf ? (lf.source || 'fit') : null };
}

// C2 analysis data (test type, reference pressure, periods).
function _getAnalysisData(ds) {
    if (typeof G.PRiSM_getAnalysisData !== 'function') return null;
    try {
        var a = G.PRiSM_getAnalysisData(ds);
        return (a && a.ok !== false) ? a : null;
    } catch (e) { return null; }
}

// C7 — tab panel registry (merge; replace an entry with the same id).
function _registerPanel(n, spec) {
    if (typeof G.PRiSM_registerTabPanel === 'function') {
        try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall through */ }
    }
    G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
    var list = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === spec.id) { list[i] = spec; return; }
    }
    list.push(spec);
}

// Dimensionless time per hour for the fitted model: 0.0002637·k/(φμct·Lref²),
// Lref = rw, or xf / Lh when the model is referenced to those (C3 metadata).
function _tdFactor(modelKey, w, fit) {
    if (!_dimsOK(w) || !(fit && fit.k > 0)) return null;
    var Lref = w.rw;
    var spec = _model(modelKey);
    var ref = spec && spec.refLength;
    if (fit.phys && (ref === 'xf' || ref === 'Lh')) {
        var L = _num(fit.phys[ref]);
        if (L > 0) Lref = L;
    }
    return 0.0002637 * fit.k / (w.phi * w.mu * w.ct * Lref * Lref);
}

// Production start when nothing better is known: test data normally count
// hours from the start of flow, so a first sample near zero means tStart = 0.
function _autoStart(t) {
    var n = t.length;
    if (!n) return 0;
    var t0 = t[0], span = t[n - 1] - t0;
    return (t0 > 0 && span > 0 && t0 <= 0.1 * span) ? 0 : t0;
}

// Solve a small dense linear system A·x = b in-place via Gaussian
// elimination with partial pivoting. A is N×N (array of arrays). Returns
// the solution vector or throws if the system is singular.
function _solveLinear(A, b) {
    var n = b.length;
    // Make copies so we don't trash the caller's matrix.
    var M = new Array(n);
    var rhs = new Array(n);
    for (var i = 0; i < n; i++) {
        M[i] = A[i].slice();
        rhs[i] = b[i];
    }
    for (var k = 0; k < n; k++) {
        // Pivot.
        var piv = k, vmax = Math.abs(M[k][k]);
        for (var r = k + 1; r < n; r++) {
            if (Math.abs(M[r][k]) > vmax) { vmax = Math.abs(M[r][k]); piv = r; }
        }
        if (vmax < 1e-30) throw new Error('PRiSM_solveLinear: singular');
        if (piv !== k) {
            var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp;
            var tmpb = rhs[k]; rhs[k] = rhs[piv]; rhs[piv] = tmpb;
        }
        // Eliminate.
        for (var rr = k + 1; rr < n; rr++) {
            var factor = M[rr][k] / M[k][k];
            for (var c = k; c < n; c++) M[rr][c] -= factor * M[k][c];
            rhs[rr] -= factor * rhs[k];
        }
    }
    // Back-substitute.
    var x = new Array(n);
    for (var i2 = n - 1; i2 >= 0; i2--) {
        var s = rhs[i2];
        for (var j = i2 + 1; j < n; j++) s -= M[i2][j] * x[j];
        x[i2] = s / M[i2][i2];
    }
    return x;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 1 — Per-layer admittance helpers
//   No-XF (commingled): rate fraction = kh_i / Σkh, time-invariant.
//   XF (cross-flow):    fractions evolve in time as cross-flow develops.
//                       We use the PSS factor f(s) and a per-layer
//                       admittance proxy that converges to the no-XF
//                       fractions at very late time.
// ════════════════════════════════════════════════════════════════════

// Build the canonical "layer table" from a multiLayerNoXF param block:
//   { N, perms[], khFracs[] }
// Each layer is described by its (kh-fraction, perm-ratio). The kh value
// returned is in arbitrary kh units = (PVT.h × kh-fraction × perm-ratio)
// when PVT is available, else just kh-fraction × perm-ratio (relative).
function _layersFromNoXF(params) {
    var N = (params && params.N) ? Math.max(2, Math.min(5, params.N | 0)) : 3;
    var khFracs = (params && Array.isArray(params.khFracs) && params.khFracs.length === N)
        ? params.khFracs.slice() : null;
    var perms = (params && Array.isArray(params.perms) && params.perms.length === N)
        ? params.perms.slice() : null;
    if (!khFracs) {
        khFracs = []; for (var i = 0; i < N; i++) khFracs.push(1 / N);
    }
    if (!perms) {
        perms = []; for (var j = 0; j < N; j++) perms.push(1);
    }
    // Normalise khFracs.
    var sum = 0;
    for (var k = 0; k < N; k++) {
        if (!_isNum(khFracs[k]) || khFracs[k] <= 0) khFracs[k] = 1 / N;
        sum += khFracs[k];
    }
    if (sum <= 0) sum = 1;
    for (var m = 0; m < N; m++) khFracs[m] = khFracs[m] / sum;
    // kh per layer = perm × kh-fraction (relative units; PRiSM_syntheticPLT
    // scales them to the fitted kh when opts.khTotal is given).
    var hTot = 1.0;
    var khArr = new Array(N);
    for (var n2 = 0; n2 < N; n2++) {
        // Use perm ratio × kh-fraction × total-h as a relative kh number.
        khArr[n2] = perms[n2] * khFracs[n2] * hTot;
    }
    return {
        N: N,
        khFracs: khFracs,
        perms: perms,
        kh: khArr
    };
}

// Build the canonical "layer table" from a multiLayerXF param block:
//   { N, omegas[], kappas[], lambda }
// We approximate per-layer kh weight using kappas[i] × omegas[i]; kappas
// is the per-layer perm ratio and omegas is the per-layer storativity
// fraction (sum to 1). At late time the admittance converges to a
// kh-weighted contribution exactly like the no-XF case.
function _layersFromXF(params) {
    var N = (params && params.N) ? Math.max(2, Math.min(5, params.N | 0)) : 3;
    var omegas = (params && Array.isArray(params.omegas) && params.omegas.length === N)
        ? params.omegas.slice() : null;
    var kappas = (params && Array.isArray(params.kappas) && params.kappas.length === N)
        ? params.kappas.slice() : null;
    if (!omegas) {
        omegas = []; for (var i = 0; i < N; i++) omegas.push(1 / N);
    }
    if (!kappas) {
        kappas = []; for (var j = 0; j < N; j++) kappas.push(1 / N);
    }
    // Normalise (defensive).
    var oSum = 0, kSum = 0;
    for (var k = 0; k < N; k++) {
        if (!_isNum(omegas[k]) || omegas[k] <= 0) omegas[k] = 1 / N;
        if (!_isNum(kappas[k]) || kappas[k] <= 0) kappas[k] = 1 / N;
        oSum += omegas[k]; kSum += kappas[k];
    }
    if (oSum <= 0) oSum = 1;
    if (kSum <= 0) kSum = 1;
    for (var m = 0; m < N; m++) {
        omegas[m] = omegas[m] / oSum;
        kappas[m] = kappas[m] / kSum;
    }
    // Late-time per-layer kh fraction = kappas[i] × omegas[i] / Σ
    // (more precisely the rigorous Park-Horne late-time fractions reduce to
    // the kh fraction = (k_i h_i) / Σ k_j h_j; we approximate kh_i ∝
    // kappas[i]·omegas[i] when storativity tracks thickness fraction).
    var khLate = new Array(N);
    var khSum = 0;
    for (var n2 = 0; n2 < N; n2++) {
        khLate[n2] = kappas[n2] * omegas[n2];
        khSum += khLate[n2];
    }
    if (khSum <= 0) khSum = 1;
    for (var p = 0; p < N; p++) khLate[p] = khLate[p] / khSum;
    var lambda = _isNum(params.lambda) ? params.lambda : 1e-5;
    return {
        N: N,
        omegas: omegas,
        kappas: kappas,
        khLate: khLate,
        lambda: lambda
    };
}

// Time-evolving per-layer rate fraction for the XF model.  Rationale:
//  (a) at very early time (td → 0) every layer behaves as an isolated
//      single-layer well, and the rate share is set by the layer's
//      storativity fraction ω_i (because dimensional storage controls the
//      depth of the early-time dimensionless pressure draw-down)
//  (b) at very late time the fractions converge to kh-weighted (κ·ω)
//  (c) the transition is driven by the cross-flow coefficient λ: the
//      higher λ, the earlier the equilibration. We use a Warren-Root-
//      style transition variable τ(t) = 1 - exp(-λ · td) bounded to (0, 1)
//      and interpolate between early and late fractions.
// This is a faithful engineering approximation that reproduces the
// well-known cross-flow transient signature (early storativity-driven →
// late kh-driven). Fully rigorous per-layer Laplace decomposition (Park-
// Horne 1989 NxN) would replace this interpolation; the chosen form
// honours the two correct asymptotes and the λ-controlled time scale.
function _xfFractionAt(td, layers) {
    var N = layers.N;
    var lambda = layers.lambda;
    var tau = 1 - Math.exp(-Math.max(0, lambda * Math.max(0, td)));
    if (!_isNum(tau)) tau = 0;
    if (tau < 0) tau = 0;
    if (tau > 1) tau = 1;
    var out = new Array(N);
    for (var i = 0; i < N; i++) {
        out[i] = (1 - tau) * layers.omegas[i] + tau * layers.khLate[i];
    }
    return out;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 2 — Synthetic PLT computation
// ════════════════════════════════════════════════════════════════════

/**
 * PRiSM_syntheticPLT(modelKey, params, t, q_total, opts)
 *
 * Reconstruct per-layer rate contribution as a function of time.
 *
 * @param {string}   modelKey   e.g. 'multiLayerNoXF', 'multiLayerXF',
 *                              'homogeneous', 'radialComposite'.
 * @param {object}   params     fitted parameter set
 * @param {number[]} t          time array (hours, monotonically increasing)
 * @param {number[]} q_total    total wellbore rate at each t (same length)
 * @param {object}   [opts]     { khTotal: fitted kh (md·ft) → layer kh in md·ft,
 *                                tdFactor: td per hour for the cross-flow
 *                                transition (default: t is used as td) }
 * @return {object}             { layers, totalRate, cumulative, diagnostics }
 */
G.PRiSM_syntheticPLT = function PRiSM_syntheticPLT(modelKey, params, t, q_total, opts) {
    opts = opts || {};
    var tdF = (_isNum(opts.tdFactor) && opts.tdFactor > 0) ? opts.tdFactor : 1;
    if (!Array.isArray(t) || !Array.isArray(q_total)) {
        return _degeneratePLT(modelKey, 'invalid t / q_total arrays');
    }
    if (t.length !== q_total.length) {
        return _degeneratePLT(modelKey, 't and q_total must be the same length');
    }
    if (t.length === 0) {
        return _degeneratePLT(modelKey, 'empty t array');
    }
    var spec = _model(modelKey);
    var modelType;
    var nLayers;
    var rates;     // 2D: rates[layer][i]
    var fractionsT; // 2D: fractions[layer][i]
    var labels;
    var khArr;
    var nonMulti = false;

    if (modelKey === 'multiLayerNoXF') {
        modelType = 'multiLayerNoXF';
        var lyrN = _layersFromNoXF(params || {});
        nLayers = lyrN.N;
        khArr = lyrN.kh;
        labels = _layerLabels(nLayers);
        // No-XF: rate fraction = (kh_i / Σkh), time-invariant.
        var khSumN = 0;
        for (var ki = 0; ki < nLayers; ki++) khSumN += khArr[ki];
        if (khSumN <= 0) khSumN = 1;
        var fracN = new Array(nLayers);
        for (var jj = 0; jj < nLayers; jj++) fracN[jj] = khArr[jj] / khSumN;
        // Build constant fractions × time.
        rates = []; fractionsT = [];
        for (var L = 0; L < nLayers; L++) {
            var rL = new Array(t.length);
            var fL = new Array(t.length);
            for (var ii = 0; ii < t.length; ii++) {
                fL[ii] = fracN[L];
                rL[ii] = fracN[L] * (q_total[ii] || 0);
            }
            rates.push(rL);
            fractionsT.push(fL);
        }
    } else if (modelKey === 'multiLayerXF') {
        modelType = 'multiLayerXF';
        var lyrX = _layersFromXF(params || {});
        nLayers = lyrX.N;
        labels = _layerLabels(nLayers);
        // Compute kh = κ·ω (proportional units) per layer for table display.
        khArr = new Array(nLayers);
        for (var kk = 0; kk < nLayers; kk++) {
            khArr[kk] = lyrX.kappas[kk] * lyrX.omegas[kk];
        }
        rates = []; fractionsT = [];
        for (var Lx = 0; Lx < nLayers; Lx++) {
            rates.push(new Array(t.length));
            fractionsT.push(new Array(t.length));
        }
        for (var ix = 0; ix < t.length; ix++) {
            var f = _xfFractionAt(tdF * t[ix], lyrX);
            // Renormalise (defensive — interpolation should already sum to 1).
            var fSum = 0;
            for (var fk = 0; fk < nLayers; fk++) fSum += f[fk];
            if (fSum <= 0) fSum = 1;
            for (var fl = 0; fl < nLayers; fl++) {
                fractionsT[fl][ix] = f[fl] / fSum;
                rates[fl][ix] = (f[fl] / fSum) * (q_total[ix] || 0);
            }
        }
    } else if (modelKey === 'twoLayerXF') {
        // Two-layer XF: emulate as N=2 XF with omegas={omega, 1-omega} and
        // kappas={kappa, 1} (relative). lambda from params.
        modelType = 'twoLayerXF';
        var omega = _isNum(params && params.omega) ? params.omega : 0.5;
        var kappaR = _isNum(params && params.kappa) ? params.kappa : 1;
        var lam2 = _isNum(params && params.lambda) ? params.lambda : 1e-5;
        var lyr2 = {
            N: 2,
            omegas: [omega, 1 - omega],
            kappas: [kappaR / (kappaR + 1), 1 / (kappaR + 1)],
            khLate: null,
            lambda: lam2
        };
        // khLate from kappa·omega — need to renormalise.
        var khL = [lyr2.kappas[0] * lyr2.omegas[0], lyr2.kappas[1] * lyr2.omegas[1]];
        var khLs = khL[0] + khL[1];
        if (khLs <= 0) khLs = 1;
        lyr2.khLate = [khL[0] / khLs, khL[1] / khLs];
        nLayers = 2;
        labels = _layerLabels(2);
        khArr = khL;
        rates = []; fractionsT = [];
        for (var L2 = 0; L2 < 2; L2++) {
            rates.push(new Array(t.length));
            fractionsT.push(new Array(t.length));
        }
        for (var i2 = 0; i2 < t.length; i2++) {
            var f2 = _xfFractionAt(tdF * t[i2], lyr2);
            var f2S = f2[0] + f2[1];
            if (f2S <= 0) f2S = 1;
            for (var lk = 0; lk < 2; lk++) {
                fractionsT[lk][i2] = f2[lk] / f2S;
                rates[lk][i2] = (f2[lk] / f2S) * (q_total[i2] || 0);
            }
        }
    } else {
        // Single-layer / composite / fracture / etc. — degenerate.
        nonMulti = true;
        modelType = modelKey || 'unknown';
        nLayers = 1;
        labels = ['Single layer (degenerate)'];
        khArr = [1];
        rates = [new Array(t.length)];
        fractionsT = [new Array(t.length)];
        for (var iz = 0; iz < t.length; iz++) {
            fractionsT[0][iz] = 1;
            rates[0][iz] = q_total[iz] || 0;
        }
    }

    // Total rate (sum over layers) and per-layer cumulative.
    var totalRate = new Array(t.length);
    var rateCheck = 0;
    for (var ti = 0; ti < t.length; ti++) {
        var s = 0;
        for (var lr = 0; lr < nLayers; lr++) s += rates[lr][ti];
        totalRate[ti] = s;
        var diff = Math.abs(s - (q_total[ti] || 0));
        if (diff > rateCheck) rateCheck = diff;
    }
    // Per-layer cumulative production (trapezoid integration of rate × dt).
    var cumulative = new Array(nLayers);
    for (var lc = 0; lc < nLayers; lc++) cumulative[lc] = 0;
    if (t.length >= 2) {
        for (var ic = 1; ic < t.length; ic++) {
            var dt = (t[ic] - t[ic - 1]);
            if (!_isNum(dt) || dt <= 0) continue;
            for (var lk2 = 0; lk2 < nLayers; lk2++) {
                cumulative[lk2] += 0.5 * dt * (rates[lk2][ic] + rates[lk2][ic - 1]);
            }
        }
    }

    // Build the layer descriptors. For the table view we want INITIAL and
    // FINAL fractions explicitly, plus EUR (cumulative production over
    // the supplied time span).
    var totalKh = 0;
    for (var tk = 0; tk < nLayers; tk++) totalKh += khArr[tk];
    // Fitted kh → per-layer kh in md·ft (same split, real units).
    var khUnits = 'relative';
    if (_isNum(opts.khTotal) && opts.khTotal > 0 && totalKh > 0) {
        var khScale = opts.khTotal / totalKh;
        for (var tk2 = 0; tk2 < nLayers; tk2++) khArr[tk2] *= khScale;
        totalKh = opts.khTotal;
        khUnits = 'md·ft';
    }
    var layerObjs = [];
    for (var iL = 0; iL < nLayers; iL++) {
        // Mean rate fraction over the dataset (used as the headline number).
        var meanFrac = 0;
        for (var fi = 0; fi < t.length; fi++) meanFrac += fractionsT[iL][fi];
        meanFrac = (t.length > 0) ? meanFrac / t.length : 0;
        var initFrac = (t.length > 0) ? fractionsT[iL][0] : 0;
        var finalFrac = (t.length > 0) ? fractionsT[iL][t.length - 1] : 0;
        layerObjs.push({
            id:           iL,
            label:        labels[iL],
            kh:           khArr[iL],
            rateFraction: meanFrac,
            initialFraction: initFrac,
            finalFraction:   finalFrac,
            rate:         rates[iL],
            cumulative:   cumulative[iL]
        });
    }

    var notes;
    if (nonMulti) {
        notes = 'Synthetic PLT degenerate for non-multi-layer model "'
              + modelType + '" — reported as a single-layer well with '
              + 'rateFraction = 1.0. Fit a multi-layer model first to '
              + 'recover per-layer rate contributions.';
    } else if (modelType === 'multiLayerXF' || modelType === 'twoLayerXF') {
        notes = 'Cross-flow rate fractions evolve in time. Early-time '
              + 'fractions ≈ storativity ω_i; late-time fractions ≈ '
              + 'kh fractions (κ_i·ω_i). Transition controlled by λ.';
    } else {
        notes = 'Commingled (no-XF) rate fractions are time-invariant '
              + '= (kh_i / Σkh).';
    }

    return {
        layers:     layerObjs,
        totalRate:  totalRate,
        cumulative: cumulative,
        diagnostics: {
            modelType:  modelType,
            nLayers:    nLayers,
            totalKh:    totalKh,
            khUnits:    khUnits,
            tdFactor:   tdF,
            rateCheck:  rateCheck,
            notes:      notes
        }
    };
};

function _layerLabels(N) {
    if (N === 1) return ['Layer 1'];
    if (N === 2) return ['Layer 1 (top)', 'Layer 2 (base)'];
    var out = [];
    for (var i = 0; i < N; i++) {
        if (i === 0) out.push('Layer ' + (i + 1) + ' (top)');
        else if (i === N - 1) out.push('Layer ' + (i + 1) + ' (base)');
        else out.push('Layer ' + (i + 1));
    }
    return out;
}

function _degeneratePLT(modelKey, reason) {
    return {
        layers: [{
            id: 0, label: 'Single layer (degenerate)',
            kh: 1, rateFraction: 1, initialFraction: 1, finalFraction: 1,
            rate: [], cumulative: 0
        }],
        totalRate: [],
        cumulative: [0],
        diagnostics: {
            modelType: modelKey || 'unknown',
            nLayers:   1,
            totalKh:   1,
            rateCheck: 0,
            notes:     'Degenerate: ' + reason
        }
    };
}


// ════════════════════════════════════════════════════════════════════
// SECTION 3 — Unit-rate response + convolution matrix
// ════════════════════════════════════════════════════════════════════
//
// Constant-rate response: Δp(t) = q · g(t), g = unit-rate response
//   g(t) = 141.2·μ·B/(k·h) · pd(td),  td = 0.0002637·k·t/(φ·μ·ct·Lref²)
// (psi per STB/d, or per Mscf/d with B in RB/Mscf — liquid-equivalent Δp).
//
// Piecewise-constant rates, one rate per sample interval (backward form):
//   q_k acts on (t_{k−1}, t_k],  t_{−1} = tStart (start of flow)
//   Δp(t_n) = Σ_{k=0..n} q_k · [ g(t_n − t_{k−1}) − g(t_n − t_k) ],  g(0) = 0
// so A is lower-triangular with A[n][n] = g(t_n − t_{n−1}) > 0 and every
// sample carries its own rate. Δp is measured from the reference pressure
// (pi), never from the first sample.

/**
 * PRiSM_unitRateResponse(modelKey, params, tEval, opts) → number[]
 *
 * Dimensional unit-rate pressure response (psi per rate unit) when the well
 * inputs (C1) and a permeability are available — opts.k, else the fit
 * (C4: lastFit.phys.k or phys.kh / h), else legacy params.k_md — otherwise
 * the dimensionless pd(td) with td = t.
 *
 * @param {string}   modelKey  registry key
 * @param {object}   params    dimensionless model parameters
 * @param {number[]} tEval     time grid (hours)
 * @param {object}   [opts]    { k, info: {} (filled with dimensional, k, kSource, tdFactor, A) }
 * @return {number[]}          unit-rate response, same length as tEval
 */
G.PRiSM_unitRateResponse = function PRiSM_unitRateResponse(modelKey, params, tEval, opts) {
    if (!Array.isArray(tEval)) throw new Error('PRiSM_unitRateResponse: tEval must be an array');
    opts = opts || {};
    var spec = _model(modelKey);
    if (!spec || typeof spec.pd !== 'function') {
        throw new Error('PRiSM_unitRateResponse: unknown model "' + modelKey + '"');
    }
    var w = _wellDims();
    var fit = _fitInfo(w);
    var k = null, kSource = null;
    if (_num(opts.k) > 0) { k = opts.k; kSource = 'given'; }
    else if (params && _num(params.k_md) > 0) { k = params.k_md; kSource = 'params'; }
    else if (fit.k > 0) { k = fit.k; kSource = fit.kSource; }
    var fitK = { k: k, phys: fit.phys };
    var tdF = _tdFactor(modelKey, w, fitK);
    var dimensional = tdF !== null;
    var A = dimensional ? 141.2 * w.mu * w.B / (k * w.h) : 1;
    if (!dimensional) tdF = 1;                // caller-supplied dimensionless grid
    var P = {};
    for (var pk in (params || {})) if (Object.prototype.hasOwnProperty.call(params, pk)) P[pk] = params[pk];
    if (dimensional && P.__h_rw == null) P.__h_rw = w.h / w.rw;   // C3 injected geometry

    // Evaluate pd at every td > 0 in one pass (some models accept arrays).
    var validIdx = [], validTd = [];
    for (var j = 0; j < tEval.length; j++) {
        var tv = tEval[j];
        if (_isNum(tv) && tv > 0) { validIdx.push(j); validTd.push(tdF * tv); }
    }
    var out = new Array(tEval.length);
    for (var z = 0; z < tEval.length; z++) out[z] = 0;
    if (opts.info && typeof opts.info === 'object') {
        opts.info.dimensional = dimensional; opts.info.k = k; opts.info.kSource = kSource;
        opts.info.tdFactor = tdF; opts.info.A = A; opts.info.rateUnit = dimensional ? _rateUnit(w) : null;
    }
    if (!validTd.length) return out;
    var pdArr;
    try {
        pdArr = spec.pd(validTd, P);
        if (!Array.isArray(pdArr) && !(pdArr && typeof pdArr.length === 'number')) pdArr = [pdArr];
    } catch (e) {
        // Point-by-point so a single bad td doesn't kill the whole batch.
        pdArr = new Array(validTd.length);
        for (var p = 0; p < validTd.length; p++) {
            try { pdArr[p] = spec.pd([validTd[p]], P)[0]; }
            catch (e2) { pdArr[p] = NaN; }
        }
    }
    // Very small td can make the Laplace inversion fail (NaN): extend the
    // first finite value linearly to zero (storage-dominated start).
    var firstK = -1;
    for (var f0 = 0; f0 < validTd.length; f0++) {
        if (_isNum(pdArr[f0]) && pdArr[f0] > 0) { firstK = f0; break; }
    }
    for (var v = 0; v < validIdx.length; v++) {
        var pdv = pdArr[v];
        if (!_isNum(pdv)) {
            pdv = (firstK >= 0 && validTd[v] < validTd[firstK])
                ? pdArr[firstK] * validTd[v] / validTd[firstK] : 0;
        }
        out[validIdx[v]] = A * pdv;
    }
    return out;
};

// Unit response on a log grid spanning [tauMin, tauMax], interpolated
// log-log (exact for power laws) → gAt(τ), with g(τ ≤ 0) = 0 and a linear
// start below the grid.
function _responseInterp(modelKey, params, tauMin, tauMax, uopts) {
    var lo = Math.log10(Math.max(tauMin * 0.999, 1e-9));
    var hi = Math.log10(Math.max(tauMax * 1.001, tauMin * 1.01));
    var n = Math.max(40, Math.min(400, Math.ceil(30 * (hi - lo)) + 1));
    var grid = new Array(n);
    for (var i = 0; i < n; i++) grid[i] = Math.pow(10, lo + (hi - lo) * i / (n - 1));
    var g = G.PRiSM_unitRateResponse(modelKey, params, grid, uopts);
    var lnT0 = Math.log(grid[0]), dLn = (Math.log(grid[n - 1]) - lnT0) / (n - 1);
    var lnG = g.map(function (v) { return v > 0 ? Math.log(v) : NaN; });
    return function gAt(tau) {
        if (!(tau > 0)) return 0;
        if (tau <= grid[0]) return g[0] * tau / grid[0];
        if (tau >= grid[n - 1]) return g[n - 1];
        var u = (Math.log(tau) - lnT0) / dLn;
        var j = Math.floor(u);
        if (j < 0) j = 0;
        if (j > n - 2) j = n - 2;
        var f = u - j;
        if (_isNum(lnG[j]) && _isNum(lnG[j + 1])) return Math.exp(lnG[j] + f * (lnG[j + 1] - lnG[j]));
        return g[j] + f * (g[j + 1] - g[j]);
    };
}

// Lower-triangular convolution matrix (backward form, see the header).
function _buildConvMatrix(modelKey, params, t, tStart, uopts) {
    var n = t.length;
    if (n === 0) return { A: [] };
    var minD = Infinity, maxD = t[n - 1] - tStart;
    for (var i = 0; i < n; i++) {
        var d = t[i] - (i === 0 ? tStart : t[i - 1]);
        if (d > 0 && d < minD) minD = d;
    }
    if (!(maxD > 0) || !isFinite(minD)) throw new Error('time must increase after the start of flow');
    var gAt = _responseInterp(modelKey, params, minD, maxD, uopts);
    var A = new Array(n);
    for (var r = 0; r < n; r++) {
        var row = new Array(n);
        for (var c = 0; c < n; c++) {
            if (c > r) { row[c] = 0; continue; }
            var tPrev = (c === 0) ? tStart : t[c - 1];
            var gA = gAt(t[r] - tPrev);
            var gB = (c < r) ? gAt(t[r] - t[c]) : 0;
            var a = gA - gB;
            row[c] = _isNum(a) ? a : 0;
        }
        A[r] = row;
    }
    return { A: A };
}

// Straight line through the first samples, evaluated at the start of flow
// (used only when no initial pressure is known — flagged in the result).
function _extrapolateRef(t, p, t0) {
    var m = Math.min(3, t.length);
    if (m < 2) return p.length ? p[p.length - 1] : NaN;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < m; i++) { sx += t[i]; sy += p[i]; sxx += t[i] * t[i]; sxy += t[i] * p[i]; }
    var den = m * sxx - sx * sx;
    if (Math.abs(den) < 1e-30) return sy / m;
    var b = (m * sxy - sx * sy) / den, a = (sy - b * sx) / m;
    return a + b * t0;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 4 — Inverse simulation
// ════════════════════════════════════════════════════════════════════
//
// Given p(t), a model + params and a reference pressure pRef (pi), recover
// q(t) from   A · q = Δp,   Δp = pRef − p   (producer)  or  p − pRef (injector).
//
// Algorithm:
//   1. Build A (SECTION 3) and Δp from pRef.
//   2. Solve (Aᵀ A + α I) q = Aᵀ Δp  (Tikhonov-regularised normal equations);
//      α damps the high-frequency oscillation of a naive solve.
//   3. Clip negative q values to zero (NNLS-light) unless allowNegative.
//   4. Forward-simulate p_predicted = pRef ∓ A·q and report RMSE.

/**
 * PRiSM_inverseSim(modelKey, params, t, p, opts) → result
 *
 * @param {string}   modelKey
 * @param {object}   params     dimensionless model parameters
 * @param {number[]} t          time array (hours)
 * @param {number[]} p          pressure array (psia), same length
 * @param {object}   [opts]     { pRef, pRefSource, tStart, injector, k, allowNegative, alpha }
 * @return {object}  { q, converged, iterations, rmse, pPredicted, pRef, pRefSource,
 *                     tStart, injector, dimensional, k, kSource, rateUnit, warnings,
 *                     diagnostics }
 */
G.PRiSM_inverseSim = function PRiSM_inverseSim(modelKey, params, t, p, opts) {
    opts = opts || {};
    if (!Array.isArray(t) || !Array.isArray(p)) {
        return _inverseFail('t and p must be arrays', t ? t.length : 0);
    }
    if (t.length !== p.length) {
        return _inverseFail('t and p must be the same length', t.length);
    }
    if (t.length < 3) {
        return _inverseFail('need at least 3 samples', t.length);
    }
    var spec = _model(modelKey);
    if (!spec || typeof spec.pd !== 'function') {
        return _inverseFail('unknown model "' + modelKey + '"', t.length);
    }
    var warnings = [];
    var n = t.length;
    var tStart = _isNum(opts.tStart) ? opts.tStart : _autoStart(t);
    if (tStart > t[0]) tStart = t[0];
    var injector = !!opts.injector;

    // Reference pressure: given → well pi (C1) → extrapolated (flagged).
    var pRef = _num(opts.pRef), pRefSource = opts.pRefSource || (pRef !== null ? 'given' : null);
    if (pRef === null) {
        var w = _wellDims();
        if (w.pi !== null) { pRef = w.pi; pRefSource = 'pi'; }
    }
    if (pRef === null) {
        pRef = _extrapolateRef(t, p, tStart);
        pRefSource = 'extrapolated';
    }
    if (pRefSource === 'extrapolated' || pRefSource === 'first-sample') {
        warnings.push('No initial pressure is set: Δp is measured from '
            + (pRefSource === 'first-sample' ? 'the first sample' : 'the early data extrapolated to the start of flow')
            + ', so the rates may be biased. Enter pi on the Well & Test inputs.');
    }
    if (!_isNum(pRef)) return _inverseFail('no usable reference pressure', n);

    var info = {};
    var A;
    try {
        A = _buildConvMatrix(modelKey, params, t, tStart, { k: opts.k, info: info }).A;
    } catch (e) {
        return _inverseFail('build convolution matrix failed: ' + (e && e.message), n);
    }
    var sgn = injector ? -1 : 1;
    var rhs = new Array(n);
    for (var i = 0; i < n; i++) rhs[i] = sgn * (pRef - p[i]);

    // Tikhonov α relative to the matrix scale (Frobenius² / n).
    var fro2 = 0;
    for (var ri = 0; ri < n; ri++) {
        for (var rj = 0; rj <= ri; rj++) fro2 += A[ri][rj] * A[ri][rj];
    }
    var alpha = _isNum(opts.alpha) ? opts.alpha : 1e-8 * Math.max(1e-30, fro2) / n;

    // Normal equations (AᵀA + αI) q = Aᵀ rhs.
    var M = new Array(n);
    for (var mi = 0; mi < n; mi++) M[mi] = new Array(n).fill(0);
    var v = new Array(n).fill(0);
    for (var col = 0; col < n; col++) {
        for (var col2 = col; col2 < n; col2++) {
            var dot = 0;
            for (var r = Math.max(col, col2); r < n; r++) dot += A[r][col] * A[r][col2];
            M[col][col2] = dot;
            if (col !== col2) M[col2][col] = dot;
        }
        var dotV = 0;
        for (var rr = col; rr < n; rr++) dotV += A[rr][col] * rhs[rr];
        v[col] = dotV;
        M[col][col] += alpha;
    }
    var q;
    try {
        q = _solveLinear(M, v);
    } catch (e) {
        return _inverseFail('linear solve failed: ' + (e && e.message), n);
    }
    // Non-negativity clip (rates are magnitudes here; producer or injector).
    var allowNeg = !!(opts.allowNegative || (params && params.allowNegative));
    var clippedCount = 0;
    if (!allowNeg) {
        for (var iC = 0; iC < n; iC++) {
            if (q[iC] < 0) { q[iC] = 0; clippedCount++; }
        }
    }
    var pPred = new Array(n);
    var sse = 0;
    for (var rR = 0; rR < n; rR++) {
        var s2 = 0;
        for (var cC = 0; cC <= rR; cC++) s2 += A[rR][cC] * q[cC];
        pPred[rR] = pRef - sgn * s2;
        var d = p[rR] - pPred[rR];
        sse += d * d;
    }
    var rmse = Math.sqrt(sse / n);
    var converged = isFinite(rmse);

    var notes = 'Tikhonov-regularised linear deconvolution (α = ' + _fmtSig(alpha, 3) + '). '
              + 'Δp measured from ' + (pRefSource === 'pi' ? 'the initial pressure pi' : pRefSource === 'extrapolated'
                  ? 'an extrapolated start pressure' : 'the reference pressure') + ' = ' + _fmtSig(pRef, 6) + ' psia. ';
    if (clippedCount > 0) {
        notes += clippedCount + ' negative q value' + (clippedCount === 1 ? '' : 's') + ' clipped to zero. ';
    }
    if (info.dimensional) {
        notes += 'Rates in ' + info.rateUnit + ' (k = ' + _fmtSig(info.k, 4) + ' md from the ' + info.kSource + '). ';
    } else {
        notes += 'No fitted permeability or incomplete well inputs — rates are dimensionless (td = t). ';
        warnings.push('Rates are dimensionless: fit a model (regression or auto-match) and complete the '
            + 'well inputs to get rates in field units.');
    }

    return {
        q:           q,
        converged:   converged,
        iterations:  1,
        rmse:        rmse,
        pPredicted:  pPred,
        pRef:        pRef,
        pRefSource:  pRefSource,
        tStart:      tStart,
        injector:    injector,
        dimensional: !!info.dimensional,
        k:           info.k,
        kSource:     info.kSource,
        rateUnit:    info.dimensional ? info.rateUnit : 'dimensionless',
        warnings:    warnings,
        diagnostics: {
            method:         'linear-deconvolution',
            regularisation: 'tikhonov',
            alpha:          alpha,
            clipped:        clippedCount,
            dimensional:    !!info.dimensional,
            notes:          notes
        }
    };
};

/**
 * PRiSM_inverseSimDataset(ds?, opts?) — inverse simulation of the working
 * dataset with the fitted model (C4), the well pi (C1) and the test type /
 * flow start (C2). Long records are thinned (log-spaced) to ≤ opts.maxPoints
 * (default 300) to keep the O(n²) matrix small.
 */
G.PRiSM_inverseSimDataset = function PRiSM_inverseSimDataset(ds, opts) {
    opts = opts || {};
    ds = ds || G.PRiSM_dataset;
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p)) return _inverseFail('no dataset with t and p', 0);
    var w = _wellDims();
    var fit = _fitInfo(w);
    var modelKey = opts.modelKey || fit.modelKey;
    var params = opts.params || fit.params || {};
    if (!modelKey || !_model(modelKey)) return _inverseFail('no fitted model', 0);
    var t = [], p = [];
    for (var i = 0; i < ds.t.length; i++) {
        var ti = +ds.t[i], pi = +ds.p[i];
        if (!isFinite(ti) || !isFinite(pi)) continue;
        if (t.length && ti <= t[t.length - 1]) continue;
        t.push(ti); p.push(pi);
    }
    var maxPts = opts.maxPoints || 300;
    if (t.length > maxPts) {
        var keep = [0], lo = Math.log(Math.max(t[0] - _autoStart(t), 1e-9) || 1e-9);
        var hi = Math.log(Math.max(t[t.length - 1] - _autoStart(t), 1e-9));
        var step = (hi - lo) / (maxPts - 1), last = lo;
        for (var k = 1; k < t.length - 1; k++) {
            var l = Math.log(Math.max(t[k] - _autoStart(t), 1e-9));
            if (l - last >= step) { keep.push(k); last = l; }
        }
        keep.push(t.length - 1);
        t = keep.map(function (j) { return t[j]; });
        p = keep.map(function (j) { return p[j]; });
    }
    var ad = _getAnalysisData(ds);
    var testType = (w.testType && w.testType !== 'auto') ? w.testType : (ad && ad.testType) || 'auto';
    var o = {};
    for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) o[key] = opts[key];
    if (o.injector == null) o.injector = (testType === 'injection' || testType === 'falloff');
    if (o.pRef == null && w.pi === null && ad && _isNum(ad.pRef) &&
        (ad.testType === 'drawdown' || ad.testType === 'injection')) {
        o.pRef = ad.pRef; o.pRefSource = ad.pRefSource || 'analysis data';
    }
    if (o.tStart == null && ad) {
        var per = (ad.periods && ad.periods[0]) || (ad.rateHistory && ad.rateHistory[0]);
        var ts = per ? (_num(per.t0) !== null ? per.t0 : _num(per.t)) : null;
        if (ts !== null && ts <= t[0]) o.tStart = ts;
    }
    var res = G.PRiSM_inverseSim(modelKey, params, t, p, o);
    res.t = t; res.p = p; res.modelKey = modelKey; res.testType = testType;
    return res;
};

function _inverseFail(reason, n) {
    return {
        q:          new Array(Math.max(1, n)).fill(0),
        converged:  false,
        iterations: 0,
        rmse:       NaN,
        pPredicted: [],
        warnings:   [],
        diagnostics: {
            method:         'linear-deconvolution',
            regularisation: 'tikhonov',
            error:          reason,
            notes:          'Inverse simulation failed: ' + reason
        }
    };
}


// ════════════════════════════════════════════════════════════════════
// SECTION 5 — UI: synthetic PLT panel
// ════════════════════════════════════════════════════════════════════
//
// Host theme (CSS variables), usable at 375 px. All elements are looked
// up inside the container (the panel can be mounted in the Tab 6 panel
// area and in a tools drawer at the same time).
//   1. Status line (model + layers)
//   2. Stacked-area canvas (per-layer rate vs time)
//   3. Per-layer table (label | kh | initial / final / mean fraction | cum.)
//   4. Actions: Compute | Export CSV
// ════════════════════════════════════════════════════════════════════

var TV = {
    bg: 'var(--bg1,#0d1117)', panel: 'var(--bg2,#161b22)', border: 'var(--border,#30363d)',
    text: 'var(--text,#e6edf3)', text2: 'var(--text2,#8b949e)', text3: 'var(--text3,#6e7681)',
    accent: 'var(--accent,#f0883e)', green: 'var(--green,#3fb950)', red: 'var(--red,#f85149)',
    yellow: 'var(--yellow,#d29922)', blue: 'var(--blue,#58a6ff)'
};

function _q(container, id) {
    return (container && container.querySelector) ? container.querySelector('#' + id) : null;
}
function _btnHTML(id, label, primary) {
    return '<button id="' + id + '" type="button" class="btn ' + (primary ? 'btn-primary' : 'btn-secondary') + '" '
        + 'style="padding:6px 12px; min-height:32px; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;'
        + ' border:1px solid ' + (primary ? TV.accent : TV.border) + '; background:' + (primary ? TV.accent : TV.panel)
        + '; color:' + (primary ? '#0d1117' : TV.text) + ';">' + _esc(label) + '</button>';
}
function _say(container, id, html) {
    var el = _q(container, id);
    if (el) el.innerHTML = html;
}

var _PLT_MULTI = { multiLayerNoXF: 1, multiLayerXF: 1, twoLayerXF: 1 };
var _pltLastResult = null;

G.PRiSM_renderPLTPanel = function PRiSM_renderPLTPanel(container, opts) {
    if (!_hasDoc || !container) return;
    opts = opts || {};
    container.innerHTML =
          '<div class="prism-plt-card" style="max-width:100%; box-sizing:border-box; color:' + TV.text + '; font-size:12px;'
        +   (opts.embedded ? '' : ' background:' + TV.panel + '; border:1px solid ' + TV.border + '; border-radius:6px; padding:12px;') + '">'
        +   '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">'
        +     '<div style="font-weight:600; font-size:13px;">Layer contributions (synthetic PLT)</div>'
        +     '<div style="display:flex; gap:8px; flex-wrap:wrap;">'
        +       _btnHTML('prism_plt_compute', 'Compute', true)
        +       _btnHTML('prism_plt_export', 'Export CSV', false)
        +     '</div>'
        +   '</div>'
        +   '<div id="prism_plt_msg" style="color:' + TV.text2 + '; margin-bottom:8px;">'
        +     'Splits the well rate between layers using the fitted multi-layer model.'
        +   '</div>'
        +   '<canvas id="prism_plt_canvas" width="800" height="320" '
        +     'style="display:block; width:100%; max-width:100%; height:auto; background:' + TV.bg + '; border:1px solid ' + TV.border + '; border-radius:6px;"></canvas>'
        +   '<div id="prism_plt_table" style="margin-top:10px; overflow-x:auto; max-width:100%;">'
        +     '<div style="color:' + TV.text3 + ';">No layer data yet.</div>'
        +   '</div>'
        +   '<div id="prism_plt_note" style="margin-top:6px; font-size:11px; color:' + TV.text3 + '; line-height:1.5;"></div>'
        + '</div>';
    var btnC = _q(container, 'prism_plt_compute');
    var btnE = _q(container, 'prism_plt_export');
    if (btnC) btnC.onclick = function () { _pltCompute(container); };
    if (btnE) btnE.onclick = function () { _pltExport(container); };
    if (_pltLastResult) _pltPaint(container, _pltLastResult);
    else _drawPLTChart(_q(container, 'prism_plt_canvas'), [], []);
};

function _pltPaint(container, last) {
    _drawPLTChart(_q(container, 'prism_plt_canvas'), last.result.layers, last.t);
    _renderPLTTable(_q(container, 'prism_plt_table'), last);
    var noteEl = _q(container, 'prism_plt_note');
    if (noteEl) noteEl.textContent = last.result.diagnostics.notes || '';
}

function _pltCompute(container) {
    var w = _wellDims();
    var fit = _fitInfo(w);
    var ds = G.PRiSM_dataset || null;
    if (!fit.modelKey || !_PLT_MULTI[fit.modelKey]) {
        _say(container, 'prism_plt_msg', '<span style="color:' + TV.yellow + ';">Layer contributions need a fitted multi-layer model '
            + '(two-layer or multi-layer, with or without cross-flow). Current model: <b>' + _esc(fit.modelKey || 'none') + '</b>.</span>');
        _pltLastResult = null;
        _drawPLTChart(_q(container, 'prism_plt_canvas'), [], []);
        _renderPLTTable(_q(container, 'prism_plt_table'), null);
        return;
    }
    if (!ds || !Array.isArray(ds.t) || ds.t.length < 2) {
        _say(container, 'prism_plt_msg', '<span style="color:' + TV.yellow + ';">No working data — load data on the Data step first.</span>');
        return;
    }
    var t = ds.t.slice();
    var qTot, qNote = '';
    if (Array.isArray(ds.q) && ds.q.length === t.length) {
        qTot = ds.q.map(function (v) { return _isNum(+v) ? +v : 0; });
    } else {
        var qc = (w.q > 0) ? w.q : 1;
        if (!(w.q > 0)) qNote = ' No rate is known — fractions only (unit total rate).';
        qTot = t.map(function () { return qc; });
    }
    var o = {};
    if (fit.kh > 0) o.khTotal = fit.kh;
    var tdF = _tdFactor(fit.modelKey, w, fit);
    if (tdF) o.tdFactor = tdF;
    var result;
    try {
        result = G.PRiSM_syntheticPLT(fit.modelKey, fit.params, t, qTot, o);
    } catch (e) {
        _say(container, 'prism_plt_msg', '<span style="color:' + TV.red + ';">Layer split failed: ' + _esc(e && e.message) + '</span>');
        return;
    }
    _pltLastResult = { result: result, t: t, rateUnit: _rateUnit(w), modelKey: fit.modelKey };
    var d = result.diagnostics;
    _say(container, 'prism_plt_msg', '<span style="color:' + TV.green + ';">' + d.nLayers + ' layer' + (d.nLayers === 1 ? '' : 's')
        + ' over ' + t.length + ' samples. Total kh ' + _fmtSig(d.totalKh, 4) + ' ' + (d.khUnits === 'md·ft' ? 'md·ft (from the fit)' : '(relative — no fitted kh yet)')
        + '.' + _esc(qNote) + '</span>');
    _pltPaint(container, _pltLastResult);
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_plt_compute', { model: fit.modelKey, n_layers: d.nLayers }); }
        catch (e) { /* swallow */ }
    }
}

// Stacked-area chart of per-layer rate contribution vs time.
function _drawPLTChart(canvas, layers, t) {
    if (!_hasDoc || !canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var T = _theme();
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
    var pad = { top: 24, right: 110, bottom: 38, left: 60 };
    if (!Array.isArray(layers) || !layers.length || !Array.isArray(t) || !t.length) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No layer data yet.', w / 2, h / 2);
        return;
    }
    var plotX = pad.left, plotY = pad.top;
    var plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
    var tMin = Infinity, tMax = -Infinity;
    for (var i = 0; i < t.length; i++) {
        if (t[i] > 0) {
            if (t[i] < tMin) tMin = t[i];
            if (t[i] > tMax) tMax = t[i];
        }
    }
    if (!isFinite(tMin) || !isFinite(tMax) || tMin >= tMax) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Time grid is degenerate.', w / 2, h / 2);
        return;
    }
    var useLog = (tMax / tMin) > 50;
    function xMap(tv) {
        if (useLog) {
            return plotX + plotW * (Math.log10(Math.max(tv, tMin)) - Math.log10(tMin)) /
                                  (Math.log10(tMax) - Math.log10(tMin));
        }
        return plotX + plotW * (tv - tMin) / (tMax - tMin);
    }
    var yMax = 0;
    for (var ti = 0; ti < t.length; ti++) {
        var s = 0;
        for (var li = 0; li < layers.length; li++) s += (layers[li].rate[ti] || 0);
        if (s > yMax) yMax = s;
    }
    if (yMax <= 0) yMax = 1;
    function yMap(qv) { return plotY + plotH * (1 - qv / yMax); }
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var g = 0; g <= 5; g++) {
        var yp = plotY + plotH * g / 5;
        ctx.beginPath(); ctx.moveTo(plotX, yp); ctx.lineTo(plotX + plotW, yp); ctx.stroke();
        ctx.fillText(_fmtSig(yMax * (1 - g / 5), 3), plotX - 6, yp);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var xt = 0; xt <= 5; xt++) {
        var frac = xt / 5;
        var tv = useLog ? Math.pow(10, Math.log10(tMin) + frac * (Math.log10(tMax) - Math.log10(tMin)))
                        : tMin + frac * (tMax - tMin);
        var xp = xMap(tv);
        ctx.beginPath(); ctx.moveTo(xp, plotY); ctx.lineTo(xp, plotY + plotH); ctx.stroke();
        ctx.fillText(_fmtSig(tv, 3), xp, plotY + plotH + 4);
    }
    ctx.fillStyle = T.text;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('time (h)', plotX + plotW / 2, h - 6);
    ctx.save();
    ctx.translate(14, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('rate', 0, 0);
    ctx.restore();
    var cum = new Array(t.length).fill(0);
    for (var lk = 0; lk < layers.length; lk++) {
        var lyr = layers[lk];
        var color = _LAYER_COLORS[lk % _LAYER_COLORS.length];
        ctx.beginPath();
        for (var jj = 0; jj < t.length; jj++) {
            var top = cum[jj] + (lyr.rate[jj] || 0);
            if (jj === 0) ctx.moveTo(xMap(t[jj]), yMap(top));
            else ctx.lineTo(xMap(t[jj]), yMap(top));
        }
        for (var kk = t.length - 1; kk >= 0; kk--) ctx.lineTo(xMap(t[kk]), yMap(cum[kk]));
        ctx.closePath();
        ctx.fillStyle = color + '99';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        for (var ic = 0; ic < t.length; ic++) cum[ic] += (lyr.rate[ic] || 0);
    }
    var lx = plotX + plotW + 14, ly = plotY + 4;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (var le = 0; le < layers.length; le++) {
        ctx.fillStyle = _LAYER_COLORS[le % _LAYER_COLORS.length];
        ctx.fillRect(lx, ly + le * 16 + 2, 10, 10);
        ctx.fillStyle = T.text;
        var lbl = layers[le].label;
        if (lbl.length > 14) lbl = lbl.slice(0, 13) + '…';
        ctx.fillText(lbl, lx + 14, ly + le * 16);
    }
}

function _renderPLTTable(host, last) {
    if (!_hasDoc || !host) return;
    if (!last || !last.result || !last.result.layers || !last.result.layers.length) {
        host.innerHTML = '<div style="color:' + TV.text3 + ';">No layer data yet.</div>';
        return;
    }
    var result = last.result;
    var khUnit = result.diagnostics.khUnits === 'md·ft' ? 'md·ft' : 'relative';
    var volUnit = last.rateUnit === 'Mscf/d' ? 'Mscf' : (last.rateUnit === 'BWPD' ? 'bbl water' : 'STB');
    var h = '<table style="width:100%; border-collapse:collapse; font-size:12px; color:' + TV.text + ';">';
    h += '<thead><tr style="background:' + TV.bg + '; border-bottom:1px solid ' + TV.border + ';">'
       + '<th style="text-align:left; padding:6px 8px;">Layer</th>'
       + '<th style="text-align:right; padding:6px 8px;">kh (' + khUnit + ')</th>'
       + '<th style="text-align:right; padding:6px 8px;">Initial</th>'
       + '<th style="text-align:right; padding:6px 8px;">Final</th>'
       + '<th style="text-align:right; padding:6px 8px;">Mean</th>'
       + '<th style="text-align:right; padding:6px 8px;">Cum. (' + volUnit + ')</th>'
       + '</tr></thead><tbody>';
    for (var i = 0; i < result.layers.length; i++) {
        var L = result.layers[i];
        var swatch = _LAYER_COLORS[i % _LAYER_COLORS.length];
        h += '<tr style="border-bottom:1px solid ' + TV.border + ';">'
           + '<td style="padding:6px 8px; white-space:nowrap;"><span style="display:inline-block; width:10px; height:10px; '
           + 'background:' + swatch + '; vertical-align:middle; margin-right:6px;"></span>' + _esc(L.label) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmtSig(L.kh, 4) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.initialFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.finalFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.rateFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmtSig(L.cumulative / 24, 4) + '</td>'
           + '</tr>';
    }
    h += '</tbody></table>';
    host.innerHTML = h;
}

function _pltExport(container) {
    if (!_pltLastResult || !_pltLastResult.result) {
        _say(container, 'prism_plt_msg', '<span style="color:' + TV.yellow + ';">Compute first, then export.</span>');
        return;
    }
    var t = _pltLastResult.t;
    var layers = _pltLastResult.result.layers;
    var lines = [];
    var hdr = ['t_hr'];
    for (var k = 0; k < layers.length; k++) hdr.push('q_layer_' + (k + 1));
    hdr.push('q_total');
    lines.push(hdr.join(','));
    for (var i = 0; i < t.length; i++) {
        var row = [t[i]], sum = 0;
        for (var lk = 0; lk < layers.length; lk++) {
            var rv = layers[lk].rate[i] || 0;
            row.push(rv);
            sum += rv;
        }
        row.push(sum);
        lines.push(row.join(','));
    }
    _download('prism-layer-rates.csv', lines.join('\n'), 'text/csv');
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_plt_export', { n_rows: t.length, n_layers: layers.length }); }
        catch (e) { /* swallow */ }
    }
}

function _download(name, text, type) {
    if (!_hasDoc || typeof Blob !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL) return false;
    try {
        var url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 5000);
        return true;
    } catch (e) { return false; }
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6 — UI: inverse-simulation panel
// ════════════════════════════════════════════════════════════════════
//
//   1. Inputs line (fitted model, k and its source, reference pressure)
//   2. "Run" + "Save as analysis set"
//   3. Two stacked canvases (top: p(t) observed vs predicted; bottom: q(t))
//   4. Notes / warnings
// ════════════════════════════════════════════════════════════════════

var _invLastResult = null;

function _invInputsLine() {
    var w = _wellDims();
    var fit = _fitInfo(w);
    var parts = [];
    parts.push('Model: <b>' + _esc(fit.modelKey || 'none') + '</b>');
    parts.push(fit.k > 0 ? 'k = <b>' + _fmtSig(fit.k, 4) + ' md</b> (' + _esc(fit.kSource) + ')'
                         : '<span style="color:' + TV.yellow + ';">no fitted k — dimensionless rates</span>');
    parts.push(w.pi !== null ? 'Δp from p<sub>i</sub> = ' + _fmtSig(w.pi, 6) + ' psia'
                             : '<span style="color:' + TV.yellow + ';">p<sub>i</sub> not set — extrapolated</span>');
    if (!_dimsOK(w)) parts.push('<span style="color:' + TV.yellow + ';">well inputs incomplete</span>');
    return parts.join(' · ');
}

G.PRiSM_renderInverseSimPanel = function PRiSM_renderInverseSimPanel(container, opts) {
    if (!_hasDoc || !container) return;
    opts = opts || {};
    container.innerHTML =
          '<div class="prism-inv-card" style="max-width:100%; box-sizing:border-box; color:' + TV.text + '; font-size:12px;'
        +   (opts.embedded ? '' : ' background:' + TV.panel + '; border:1px solid ' + TV.border + '; border-radius:6px; padding:12px;') + '">'
        +   '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">'
        +     '<div style="font-weight:600; font-size:13px;">Rate from pressure (inverse simulation)</div>'
        +     '<div style="display:flex; gap:8px; flex-wrap:wrap;">'
        +       _btnHTML('prism_inv_run', 'Run', true)
        +       _btnHTML('prism_inv_save', 'Save as analysis set', false)
        +     '</div>'
        +   '</div>'
        +   '<div class="prism-inv-inputs" style="color:' + TV.text2 + '; margin-bottom:4px; line-height:1.5;">' + _invInputsLine() + '</div>'
        +   '<div id="prism_inv_msg" style="color:' + TV.text2 + '; margin-bottom:8px; min-height:14px;">'
        +     'Recovers the rate history implied by the pressures and the fitted model.'
        +   '</div>'
        +   '<div style="display:flex; flex-direction:column; gap:8px;">'
        +     '<canvas id="prism_inv_canvas_p" width="800" height="180" '
        +       'style="display:block; width:100%; max-width:100%; height:auto; background:' + TV.bg + '; border:1px solid ' + TV.border + '; border-radius:6px;"></canvas>'
        +     '<canvas id="prism_inv_canvas_q" width="800" height="180" '
        +       'style="display:block; width:100%; max-width:100%; height:auto; background:' + TV.bg + '; border:1px solid ' + TV.border + '; border-radius:6px;"></canvas>'
        +   '</div>'
        +   '<div id="prism_inv_note" style="margin-top:6px; font-size:11px; color:' + TV.text3 + '; line-height:1.5;"></div>'
        + '</div>';
    var btnR = _q(container, 'prism_inv_run');
    var btnS = _q(container, 'prism_inv_save');
    if (btnR) btnR.onclick = function () { _invRun(container); };
    if (btnS) btnS.onclick = function () { _invSave(container); };
    if (_invLastResult) _invPaint(container, _invLastResult);
};

function _median(a) {
    var v = a.filter(_isNum).slice().sort(function (x, y) { return x - y; });
    return v.length ? v[v.length >> 1] : NaN;
}

function _invPaint(container, last) {
    var r = last.result;
    var cp = _q(container, 'prism_inv_canvas_p'), cq = _q(container, 'prism_inv_canvas_q');
    if (cp) _drawInvSeries(cp, last.t, last.p, r.pPredicted, 'pressure', 'p (psia)');
    if (cq) _drawInvSeries(cq, last.t, r.q, null, 'rate', 'q (' + (r.rateUnit || 'rate') + ')');
    var noteEl = _q(container, 'prism_inv_note');
    if (noteEl) {
        noteEl.textContent = (r.diagnostics && r.diagnostics.notes) || '';
        (r.warnings || []).forEach(function (wtxt) {
            var d = document.createElement('div');
            d.style.color = 'var(--yellow,#d29922)';
            d.textContent = '⚠ ' + wtxt;
            noteEl.appendChild(d);
        });
    }
}

function _invRun(container) {
    var ds = G.PRiSM_dataset || null;
    var inputs = container.querySelector ? container.querySelector('.prism-inv-inputs') : null;
    if (inputs) inputs.innerHTML = _invInputsLine();
    var fit = _fitInfo(_wellDims());
    if (!fit.modelKey || !_model(fit.modelKey)) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.yellow + ';">No model yet — choose and fit a model first.</span>');
        return;
    }
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || ds.t.length < 4) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.yellow + ';">No working data (need at least 4 time / pressure samples).</span>');
        return;
    }
    var result;
    try {
        result = G.PRiSM_inverseSimDataset(ds);
    } catch (e) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.red + ';">Inverse simulation failed: ' + _esc(e && e.message) + '</span>');
        return;
    }
    if (!result.converged) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.red + ';">Inverse simulation failed: '
            + _esc((result.diagnostics && result.diagnostics.error) || 'unknown reason') + '</span>');
        return;
    }
    _invLastResult = { result: result, t: result.t, p: result.p, modelKey: result.modelKey };
    _say(container, 'prism_inv_msg', '<span style="color:' + TV.green + ';">Recovered rates for ' + result.t.length
        + ' samples · median q = ' + _fmtSig(_median(result.q), 4) + ' ' + _esc(result.rateUnit)
        + ' · RMSE(p) = ' + _fmtSig(result.rmse, 3) + ' psi.</span>');
    _invPaint(container, _invLastResult);
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_inverse_sim_run', { model: result.modelKey, n: result.t.length, rmse: result.rmse }); }
        catch (e) { /* swallow */ }
    }
}

function _invSave(container) {
    var last = _invLastResult;
    if (!last || !last.result || !last.result.converged) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.yellow + ';">Run the inverse simulation first.</span>');
        return;
    }
    var AD = G.PRiSM_analysisData;
    if (AD && typeof AD.add === 'function') {
        var r = last.result;
        AD.add({
            name: 'Recovered rate (' + last.modelKey + ')',
            source: 'inverse simulation',
            notes: 'Rates recovered from pressure with the ' + last.modelKey + ' model; RMSE ' + _fmtSig(r.rmse, 3)
                 + ' psi; rates in ' + r.rateUnit + '.'
        }, [], last.t.slice(), last.p.slice(), r.q.slice()).then(function () {
            _say(container, 'prism_inv_msg', '<span style="color:' + TV.green + ';">Saved as an analysis set ('
                + last.t.length + ' points) — see "Gauges &amp; analysis datasets" on the Data step.</span>');
        }).catch(function (e) {
            _say(container, 'prism_inv_msg', '<span style="color:' + TV.red + ';">Could not save: ' + _esc(e && e.message) + '</span>');
        });
    } else {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.yellow + ';">Analysis-set storage is not available in this build.</span>');
    }
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_inverse_sim_save', { model: last.modelKey, n: last.t.length }); }
        catch (e) { /* swallow */ }
    }
}

// Draw a single (t, y) series — optionally with a model overlay.
function _drawInvSeries(canvas, t, y, overlay, kind, ylabel) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var T = _theme();
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
    var pad = { top: 22, right: 20, bottom: 32, left: 64 };
    var plotX = pad.left, plotY = pad.top;
    var plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
    if (!t || !y || !t.length || !y.length) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('No data', w / 2, h / 2);
        return;
    }
    var tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (var i = 0; i < t.length; i++) {
        if (_isNum(t[i])) { if (t[i] < tMin) tMin = t[i]; if (t[i] > tMax) tMax = t[i]; }
        if (_isNum(y[i])) { if (y[i] < yMin) yMin = y[i]; if (y[i] > yMax) yMax = y[i]; }
    }
    if (overlay && overlay.length) {
        for (var j = 0; j < overlay.length; j++) {
            if (_isNum(overlay[j])) { if (overlay[j] < yMin) yMin = overlay[j]; if (overlay[j] > yMax) yMax = overlay[j]; }
        }
    }
    if (!isFinite(tMin) || tMin >= tMax) { tMin = 0; tMax = 1; }
    if (!isFinite(yMin) || yMin >= yMax) { yMin = (isFinite(yMin) ? yMin : 0) - 1; yMax = (isFinite(yMax) ? yMax : 0) + 1; }
    var span = yMax - yMin;
    yMin -= 0.05 * span; yMax += 0.05 * span;
    function xMap(tv) { return plotX + plotW * (tv - tMin) / (tMax - tMin); }
    function yMap(yv) { return plotY + plotH * (1 - (yv - yMin) / (yMax - yMin)); }
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
        var yp = plotY + plotH * g / 4;
        ctx.beginPath(); ctx.moveTo(plotX, yp); ctx.lineTo(plotX + plotW, yp); ctx.stroke();
        ctx.fillText(_fmtSig(yMax - g * (yMax - yMin) / 4, 4), plotX - 6, yp);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var x = 0; x <= 5; x++) {
        var tv2 = tMin + (x / 5) * (tMax - tMin);
        var xp = xMap(tv2);
        ctx.beginPath(); ctx.moveTo(xp, plotY); ctx.lineTo(xp, plotY + plotH); ctx.stroke();
        ctx.fillText(_fmtSig(tv2, 3), xp, plotY + plotH + 4);
    }
    ctx.fillStyle = T.text;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('time (h)', plotX + plotW / 2, h - 4);
    ctx.save();
    ctx.translate(12, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(ylabel, 0, 0);
    ctx.restore();
    var color = (kind === 'pressure') ? T.blue : T.accent;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    var started = false;
    for (var k = 0; k < t.length; k++) {
        if (!_isNum(t[k]) || !_isNum(y[k])) continue;
        if (!started) { ctx.moveTo(xMap(t[k]), yMap(y[k])); started = true; }
        else ctx.lineTo(xMap(t[k]), yMap(y[k]));
    }
    ctx.stroke();
    ctx.fillStyle = color;
    for (var m = 0; m < t.length; m++) {
        if (!_isNum(t[m]) || !_isNum(y[m])) continue;
        ctx.beginPath();
        ctx.arc(xMap(t[m]), yMap(y[m]), 1.6, 0, 2 * Math.PI);
        ctx.fill();
    }
    if (overlay && overlay.length) {
        ctx.strokeStyle = T.green;
        ctx.lineWidth = 1.2;
        if (ctx.setLineDash) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        var started2 = false;
        for (var ov = 0; ov < overlay.length; ov++) {
            if (!_isNum(t[ov]) || !_isNum(overlay[ov])) continue;
            if (!started2) { ctx.moveTo(xMap(t[ov]), yMap(overlay[ov])); started2 = true; }
            else ctx.lineTo(xMap(t[ov]), yMap(overlay[ov]));
        }
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = color;
        ctx.fillRect(plotX + plotW - 90, plotY + 6, 10, 4);
        ctx.fillStyle = T.text;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('observed', plotX + plotW - 76, plotY + 8);
        ctx.fillStyle = T.green;
        ctx.fillRect(plotX + plotW - 90, plotY + 18, 10, 4);
        ctx.fillStyle = T.text;
        ctx.fillText('predicted', plotX + plotW - 76, plotY + 20);
    }
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6B — Tab 6 panel "PLT & inverse simulation" (C7)
// ════════════════════════════════════════════════════════════════════

G.PRiSM_renderPLTInversePanel = function PRiSM_renderPLTInversePanel(container, opts) {
    if (!_hasDoc || !container) return;
    opts = opts || {};
    container.innerHTML =
          '<div class="prism-pltinv" style="max-width:100%; box-sizing:border-box; color:' + TV.text + '; font-size:12px;'
        +   (opts.embedded ? '' : ' background:' + TV.panel + '; border:1px solid ' + TV.border + '; border-radius:6px; padding:12px;') + '">'
        +   (opts.embedded ? '' : '<div style="font-weight:700; font-size:14px; margin-bottom:6px;">PLT &amp; inverse simulation</div>')
        +   '<div style="color:' + TV.text2 + '; margin-bottom:10px; line-height:1.5;">Uses the current fit: the rate split between '
        +     'layers of a multi-layer model, and the rate history implied by the pressures. Results are in field units when the '
        +     'well inputs are complete and the fit gives a permeability.</div>'
        +   '<div class="prism-plt-host"></div>'
        +   '<div class="prism-inv-host" style="margin-top:16px; padding-top:12px; border-top:1px solid ' + TV.border + ';"></div>'
        + '</div>';
    G.PRiSM_renderPLTPanel(container.querySelector('.prism-plt-host'), { embedded: true });
    G.PRiSM_renderInverseSimPanel(container.querySelector('.prism-inv-host'), { embedded: true });
};

_registerPanel(6, {
    id: 'prism_plt_inverse',
    title: 'PLT & inverse simulation',
    order: 80,
    collapsed: true,
    tool: true,
    description: 'Layer rate split from a multi-layer fit; rate history recovered from pressure',
    render: function (hostEl) { G.PRiSM_renderPLTInversePanel(hostEl, { embedded: true }); }
});


// ════════════════════════════════════════════════════════════════════

})();

// ─── END 20-plt-inverse ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 21-plot-utilities ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 21 — Plot utilities (overlays + diff + XML + clipboard)
//   • Plot overlays for multi-period / multi-dataset / model comparison
//   • Two-dataset diff plot (interpolation + 2-panel render)
//   • XML project export (one-file portable export)
//   • Copy plot / data to the clipboard
//   • Tab 2 panel "Plot tools" that hosts all of the above plus PNG / PDF export
//
// PUBLIC API (all on window.*)
//
//   PRiSM_overlays                          — state container
//     .items / .add(source, label?, color?) → id / .remove(id) / .toggle(id)
//     .clear() / .list()
//     Sources: 'period:N', 'analysis:ID', 'gauge:ID', 'model:KEY', 'fit:KEY'
//
//   PRiSM_drawOverlays(canvas, plotKey, axes?, opts?) → void   (also a post-draw hook)
//   PRiSM_renderOverlayManager(container)             → void
//
//   PRiSM_datasetDiff(dataA, dataB)               → diff result object
//   PRiSM_plot_dataset_diff(canvas, data, opts)   → void  (2-panel plot)
//   PRiSM_renderDiffPicker(container)             → void
//
//   PRiSM_exportXML(opts)                  → { blob, filename, xmlString }
//   PRiSM_exportXMLDownload(opts)          → void  (triggers <a download>)
//
//   PRiSM_copyPlotToClipboard(plotKey?)    → Promise<{ success, error? }>
//   PRiSM_copyDataToClipboard(format?)     → Promise<{ success, error? }>
//   PRiSM_renderClipboardToolbar(container) → void
//   PRiSM_renderPlotToolsPanel(container)   → void  (Tab 2 panel body)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'. Pure vanilla JS — no dependencies.
//   • Mounting through C7 only: Tab 2 panel registry + PRiSM_postDrawHooks.
//     No polling, no function wrapping.
//   • Overlays are drawn with the host plot's own transform
//     (canvas._prismAxes: toX/toY or scaleX/scaleY/plot, C6).
//   • Exported analysis data uses C2 (PRiSM_getAnalysisData): Δt [hr],
//     dp_psi (sign-aware Δp) and dp_deriv_psi (Bourdet derivative).
//   • XML is well-formed: 5-entity escaping for <, >, &, ", '.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined') && !!document && typeof document.createElement === 'function';
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _theme() {
        /* global PRiSM_THEME */
        if (typeof PRiSM_THEME !== 'undefined' && PRiSM_THEME && typeof PRiSM_THEME === 'object') return PRiSM_THEME;
        if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
        return {
            bg: '#0d1117', panel: '#161b22', border: '#30363d',
            grid: '#21262d', gridMajor: '#30363d',
            text: '#c9d1d9', text2: '#8b949e', text3: '#6e7681',
            accent: '#f0883e', blue: '#58a6ff', green: '#3fb950',
            red: '#f85149', yellow: '#d29922', cyan: '#39c5cf',
            purple: '#bc8cff'
        };
    }

    function _defaultPad() {
        return { top: 30, right: 80, bottom: 48, left: 64 };
    }

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }

    function _num(v) { return typeof v === 'number' && isFinite(v); }

    function _on(target, type, fn) {
        try { if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn); }
        catch (e) { /* stub environments */ }
    }

    function _registerTabPanel(n, spec) {
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall back */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var arr = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === spec.id) { arr[i] = spec; return; }
        arr.push(spec);
    }

    function _registerPostDraw(fn) {
        var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === fn._prismId) { hooks[i] = fn; return; }
        hooks.push(fn);
    }

    function _redraw() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
    }

    function _toArr(a) {
        if (!a) return null;
        if (Array.isArray(a)) return a;
        try { return Array.prototype.slice.call(a); } catch (e) { return null; }
    }

    // Bourdet derivative (3-point, window L in ln t).
    function _bourdet(t, y, L) {
        if (typeof G.PRiSM_compute_bourdet === 'function') {
            try { var r = G.PRiSM_compute_bourdet(t, y, L); if (r && r.length === t.length) return r; } catch (e) { /* inline */ }
        }
        var n = t.length, d = new Array(n), i;
        for (i = 0; i < n; i++) d[i] = NaN;
        for (i = 1; i < n - 1; i++) {
            var i1 = i - 1, i2 = i + 1;
            if (L > 0) {
                while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
                while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
            }
            var dl1 = Math.log(t[i]) - Math.log(t[i1]), dl2 = Math.log(t[i2]) - Math.log(t[i]), dlT = Math.log(t[i2]) - Math.log(t[i1]);
            if (!(dl1 > 0) || !(dl2 > 0) || !(dlT > 0)) continue;
            d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
        }
        return d;
    }

    function _currentL() {
        var st = G.PRiSM_state || {};
        return _num(st.bourdetL) ? st.bourdetL : 0.15;
    }

    // Sign-aware Δp (CLAUDE.md) + derivative for a raw {t, p} series; t re-zeroed.
    function _localDelta(t, p, t0) {
        var tt = [], pp = [], tAbs = [];
        for (var i = 0; i < t.length; i++) {
            if (!_num(t[i]) || !_num(p[i])) continue;
            var dt = t[i] - (t0 || 0);
            if (!(dt > 0)) continue;
            tt.push(dt); pp.push(p[i]); tAbs.push(t[i]);
        }
        if (tt.length < 3) return null;
        var n = pp.length, sign = (pp[n - 1] - pp[0]) >= 0 ? 1 : -1, dp = [];
        for (var k = 0; k < n; k++) dp.push(sign * (pp[k] - pp[0]));
        return { t: tt, tAbs: tAbs, p: pp, dp: dp, deriv: _bourdet(tt, dp, _currentL()), pRefSource: 'first-sample' };
    }

    // Analysis data (C2) for the whole dataset or one period.
    function _analysisData(period) {
        var st = G.PRiSM_state || {};
        if (typeof G.PRiSM_getAnalysisData === 'function') {
            try {
                var o = { L: _currentL() };
                if (_num(period) && period >= 0) o.period = period;
                else if (_num(st.activePeriod) && st.activePeriod >= 0) o.period = st.activePeriod;
                if (st.timeFn) o.timeFn = st.timeFn;
                var ad = G.PRiSM_getAnalysisData(G.PRiSM_dataset, o);
                if (ad && ad.ok && ad.t && ad.t.length) return ad;
            } catch (e) { /* fall back */ }
        }
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t || !ds.p) return null;
        var loc = _localDelta(_toArr(ds.t), _toArr(ds.p), 0);
        if (!loc) return null;
        loc.ok = true;
        return loc;
    }

    // Pretty palette for fresh overlay colours, cycling through.
    var OVERLAY_PALETTE = [
        '#58a6ff', '#3fb950', '#d29922', '#bc8cff',
        '#39c5cf', '#f85149', '#f0883e', '#c9d1d9'
    ];

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — OVERLAY STATE CONTAINER
    // ═══════════════════════════════════════════════════════════════
    //
    // window.PRiSM_overlays.items is a flat list. Each entry:
    //   { id, source, label, color, visible }
    //
    // 'source' is a colon-prefixed string:
    //   'period:N'    — flow period N of the loaded dataset (C2, Δt re-zeroed,
    //                   rate-normalised to the analysed period on Δp plots)
    //   'analysis:ID' — PRiSM_analysisData item
    //   'gauge:ID'    — PRiSM_gaugeData item
    //   'model:KEY'   — model curve via PRiSM_evalModelCurve (C7)
    //   'fit:KEY'     — fitted curve from PRiSM_state.history[KEY]
    // ═══════════════════════════════════════════════════════════════

    var _overlayCounter = 0;
    function _genOverlayId() {
        _overlayCounter += 1;
        return 'overlay_' + _overlayCounter + '_' + (Date.now() % 100000);
    }

    function _nextColor() {
        var existing = (G.PRiSM_overlays && G.PRiSM_overlays.items) || [];
        for (var i = 0; i < OVERLAY_PALETTE.length; i++) {
            var c = OVERLAY_PALETTE[i], used = false;
            for (var j = 0; j < existing.length; j++) if (existing[j].color === c) { used = true; break; }
            if (!used) return c;
        }
        return OVERLAY_PALETTE[existing.length % OVERLAY_PALETTE.length];
    }

    function _modelName(key) {
        var e = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
        return (e && (e.label || e.name)) || key;
    }

    function _autoLabel(source) {
        if (!source || typeof source !== 'string') return 'Overlay';
        var parts = source.split(':');
        var kind = parts[0], id = parts.slice(1).join(':');
        switch (kind) {
            case 'period':   return 'Period #' + (parseInt(id, 10) + 1);
            case 'analysis': return 'Analysis: ' + id;
            case 'gauge':    return 'Gauge: ' + id;
            case 'model':    return 'Model: ' + _modelName(id);
            case 'fit':      return 'Fit: ' + id;
            default:         return source;
        }
    }

    if (!G.PRiSM_overlays) {
        G.PRiSM_overlays = {
            items: [],
            add: function (source, label, color) {
                if (typeof source !== 'string' || !source) {
                    throw new Error('PRiSM_overlays.add: source must be a non-empty string');
                }
                var id = _genOverlayId();
                this.items.push({ id: id, source: source, label: label || _autoLabel(source),
                                  color: color || _nextColor(), visible: true });
                _ga4('prism_overlay_add', { source: source.split(':')[0] });
                return id;
            },
            remove: function (id) {
                for (var i = 0; i < this.items.length; i++) {
                    if (this.items[i].id === id) { this.items.splice(i, 1); return; }
                }
            },
            toggle: function (id) {
                for (var i = 0; i < this.items.length; i++) {
                    if (this.items[i].id === id) { this.items[i].visible = !this.items[i].visible; return; }
                }
            },
            clear: function () { this.items.length = 0; },
            list:  function () { return this.items.slice(); }
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — OVERLAY DATA RESOLUTION + DRAWING
    // ═══════════════════════════════════════════════════════════════
    // A resolved overlay is { t (Δt hr), tAbs?, p?, dp?, deriv?, q?, tp?,
    // qRef?, dimensionless? }. Drawing maps it onto the active plot's own
    // abscissa (Δt, √Δt, Δt^¼, Δt^−½, Horner ratio, days) and ordinate.
    // ═══════════════════════════════════════════════════════════════

    function _periodBounds(pp) {
        var a = _num(pp.t0) ? pp.t0 : pp.start, b = _num(pp.t1) ? pp.t1 : pp.end;
        return (_num(a) && _num(b)) ? { t0: a, t1: b } : null;
    }

    function _datasetPeriods(ds) {
        var pers = (ds && ds.periods) || [];
        if ((!pers || !pers.length) && ds && ds.q && typeof G.PRiSM_detectPeriods === 'function') {
            try { pers = G.PRiSM_detectPeriods(ds.t, ds.q) || []; } catch (e) { pers = []; }
        }
        return pers || [];
    }

    function _evalModel(key) {
        var reg = G.PRiSM_MODELS, st = G.PRiSM_state || {};
        var entry = reg && reg[key];
        if (!entry) return null;
        var params = (key === st.model && st.params) ? st.params : (entry.defaults || {});
        var curve = null;
        if (typeof G.PRiSM_evalModelCurve === 'function') {
            // The dispatcher may cache its curve on the state — keep the active one intact.
            var keep = { a: st.modelCurveData, b: st.modelCurve }, had = { a: 'modelCurveData' in st, b: 'modelCurve' in st };
            try { curve = G.PRiSM_evalModelCurve(key, params, { store: false }); } catch (e) { curve = null; }
            if (had.a) st.modelCurveData = keep.a; else delete st.modelCurveData;
            if (had.b) st.modelCurve = keep.b; else delete st.modelCurve;
        }
        if (curve && curve.t && curve.dp) {
            return { t: _toArr(curve.t), dp: _toArr(curve.dp), deriv: _toArr(curve.deriv), p: _toArr(curve.p), model: true };
        }
        if (!(curve && curve.td && curve.pd) && typeof entry.pd === 'function') {
            var td = [];
            for (var e10 = -2; e10 <= 5.0001; e10 += 0.05) td.push(Math.pow(10, e10));
            try {
                var pd = entry.pd(td, params);
                var pdp = (typeof entry.pdPrime === 'function') ? entry.pdPrime(td, params) : null;
                curve = { td: td, pd: _toArr(pd), pdPrime: _toArr(pdp) };
            } catch (e2) { curve = null; }
        }
        if (!curve || !curve.td || !curve.pd) return null;
        if (st.tcMatch && typeof G.PRiSM_applyTypeCurveMatch === 'function') {
            try {
                var m = G.PRiSM_applyTypeCurveMatch(curve, st.tcMatch);
                if (m && m.t && m.dp) return { t: _toArr(m.t), dp: _toArr(m.dp), deriv: _toArr(m.deriv), model: true };
            } catch (e3) { /* dimensionless */ }
        }
        return { t: _toArr(curve.td), dp: _toArr(curve.pd), deriv: _toArr(curve.pdPrime), dimensionless: true, model: true };
    }

    function _resolveOverlay(source) {
        if (!source || typeof source !== 'string') return null;
        var parts = source.split(':');
        var kind = parts[0], id = parts.slice(1).join(':');
        var ds = G.PRiSM_dataset;
        try {
            switch (kind) {
                case 'period': {
                    if (!ds || !ds.t) return null;
                    var pIdx = parseInt(id, 10);
                    if (!isFinite(pIdx) || pIdx < 0) return null;
                    var pers = _datasetPeriods(ds);
                    var qRef = (pers[pIdx] && _num(pers[pIdx].q)) ? pers[pIdx].q : null;
                    if (typeof G.PRiSM_getAnalysisData === 'function') {
                        try {
                            var ad = G.PRiSM_getAnalysisData(ds, { period: pIdx, L: _currentL() });
                            if (ad && ad.ok && ad.t && ad.t.length) {
                                return { t: _toArr(ad.t), tAbs: _toArr(ad.tAbs), p: _toArr(ad.p), dp: _toArr(ad.dp),
                                         deriv: _toArr(ad.deriv), tp: ad.tp, qRef: _num(ad.qRef) ? ad.qRef : qRef };
                            }
                        } catch (e) { /* local fallback */ }
                    }
                    if (!pers[pIdx]) return null;
                    var b = _periodBounds(pers[pIdx]);
                    if (!b || !ds.p) return null;
                    var ts = [], ps = [];
                    for (var i = 0; i < ds.t.length; i++) {
                        if (ds.t[i] >= b.t0 && ds.t[i] <= b.t1) { ts.push(ds.t[i]); ps.push(ds.p[i]); }
                    }
                    var loc = _localDelta(ts, ps, b.t0);
                    if (!loc) return null;
                    loc.qRef = qRef;
                    return loc;
                }
                case 'analysis': {
                    var adm = G.PRiSM_analysisData;
                    if (!adm) return null;
                    var item = (typeof adm.get === 'function') ? adm.get(id)
                             : (adm.items && adm.items[id]) ? adm.items[id]
                             : (Array.isArray(adm) && adm.find) ? adm.find(function (x) { return x.id === id; })
                             : null;
                    if (!item) return null;
                    return {
                        t:  item.t  || (item.data && item.data.t)  || [],
                        p:  item.p  || (item.data && item.data.p)  || null,
                        dp: item.dp || (item.data && item.data.dp) || null,
                        q:  item.q  || (item.data && item.data.q)  || null
                    };
                }
                case 'gauge': {
                    var gd = G.PRiSM_gaugeData;
                    if (!gd) return null;
                    var g = (typeof gd.get === 'function') ? gd.get(id)
                          : (gd.items && gd.items[id]) ? gd.items[id]
                          : (Array.isArray(gd) && gd.find) ? gd.find(function (x) { return x.id === id; })
                          : null;
                    if (!g) return null;
                    return {
                        t: g.t || (g.samples && g.samples.t) || [],
                        p: g.p || (g.samples && g.samples.p) || null,
                        q: g.q || (g.samples && g.samples.q) || null
                    };
                }
                case 'model':
                    return _evalModel(id);
                case 'fit': {
                    var st = G.PRiSM_state || {};
                    var hist = st.history || st.fitHistory || {};
                    var fit = hist[id];
                    if (!fit) return null;
                    if (fit.curve && fit.curve.t && (fit.curve.dp || fit.curve.p)) {
                        return { t: _toArr(fit.curve.t), dp: _toArr(fit.curve.dp), deriv: _toArr(fit.curve.deriv), p: _toArr(fit.curve.p) };
                    }
                    if (fit.td && fit.pd) return { t: fit.td.slice(), dp: fit.pd.slice(), dimensionless: true };
                    return null;
                }
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    // Axis transform of the host plot (C6), with an older-shape fallback.
    function _axisFwd(sc, off, len, flip) {
        if (!sc || !_num(sc.min) || !_num(sc.max) || !(len > 0)) return null;
        if (sc.kind === 'log') {
            if (!(sc.min > 0 && sc.max > 0)) return null;
            var a = Math.log10(sc.min), b = Math.log10(sc.max);
            return function (v) { if (!(v > 0)) return NaN; var f = (Math.log10(v) - a) / (b - a); return flip ? off + len - f * len : off + f * len; };
        }
        return function (v) { if (!_num(v)) return NaN; var f = (v - sc.min) / (sc.max - sc.min); return flip ? off + len - f * len : off + f * len; };
    }

    function _plotRect(canvas) {
        var cssW = (canvas && canvas.clientWidth) || (canvas && canvas.width) || 600;
        var cssH = (canvas && canvas.clientHeight) || (canvas && canvas.height) || 400;
        if (canvas && canvas.style) {
            var w = parseInt(canvas.style.width, 10);
            if (isFinite(w) && w > 0) cssW = w;
            var h = parseInt(canvas.style.height, 10);
            if (isFinite(h) && h > 0) cssH = h;
        }
        var pad = _defaultPad();
        return { x: pad.left, y: pad.top, w: Math.max(1, cssW - pad.left - pad.right),
                 h: Math.max(1, cssH - pad.top - pad.bottom), cssW: cssW, cssH: cssH, pad: pad };
    }

    // → { toX, toY, plotRect, xKind, yKind } or null
    function _getCanvasAxes(canvas, axes) {
        var ax = axes || (canvas && canvas._prismAxes) || null;
        if (ax && typeof ax.toX === 'function' && typeof ax.toY === 'function' && ax.plot) {
            return { toX: ax.toX, toY: ax.toY, plotRect: ax.plot,
                     xKind: (ax.scaleX && ax.scaleX.kind) || 'lin', yKind: (ax.scaleY && ax.scaleY.kind) || 'lin' };
        }
        if (ax && ax.scaleX && ax.scaleY && ax.plot) {
            var fx = _axisFwd(ax.scaleX, ax.plot.x, ax.plot.w, false), fy = _axisFwd(ax.scaleY, ax.plot.y, ax.plot.h, true);
            if (fx && fy) return { toX: fx, toY: fy, plotRect: ax.plot, xKind: ax.scaleX.kind, yKind: ax.scaleY.kind };
        }
        if (ax && ax.plotRect && _num(ax.xMin) && _num(ax.xMax) && _num(ax.yMin) && _num(ax.yMax)) {   // older argument shape
            var gx = _axisFwd({ kind: ax.xLog ? 'log' : 'lin', min: ax.xMin, max: ax.xMax }, ax.plotRect.x, ax.plotRect.w, false);
            var gy = _axisFwd({ kind: ax.yLog ? 'log' : 'lin', min: ax.yMin, max: ax.yMax }, ax.plotRect.y, ax.plotRect.h, true);
            if (gx && gy) return { toX: gx, toY: gy, plotRect: ax.plotRect, xKind: ax.xLog ? 'log' : 'lin', yKind: ax.yLog ? 'log' : 'lin' };
        }
        if (canvas && canvas._prismOriginalScale && canvas._prismOriginalScale.x && canvas._prismOriginalScale.y) {
            var s = canvas._prismOriginalScale, pr = _plotRect(canvas);
            var hx = _axisFwd(s.x, pr.x, pr.w, false), hy = _axisFwd(s.y, pr.y, pr.h, true);
            if (hx && hy) return { toX: hx, toY: hy, plotRect: pr, xKind: s.x.kind, yKind: s.y.kind };
        }
        return null;
    }

    var _PRESSURE_X = {
        cartesian: function (r) { return r.tAbs || r.t; },
        mdh:       function (r) { return r.t; },
        sqrt:      function (r) { return r.t.map(Math.sqrt); },
        quarter:   function (r) { return r.t.map(function (v) { return Math.pow(v, 0.25); }); },
        spherical: function (r) { return r.t.map(function (v) { return v > 0 ? Math.pow(v, -0.5) : NaN; }); }
    };

    // Series [{pts:[[x,y]], dash, dots}] to draw for a resolved overlay on plotKey.
    function _seriesForPlot(data, plotKey, opts) {
        opts = opts || {};
        if (!data || !data.t || !data.t.length) return [];
        var t = _toArr(data.t), out = [], i;
        function zip(xs, ys, scale) {
            var pts = [];
            if (!xs || !ys) return pts;
            for (var k = 0; k < xs.length && k < ys.length; k++) pts.push([xs[k], ys[k] * (scale || 1)]);
            return pts;
        }
        if (plotKey === 'bourdet' || plotKey === 'sandface') {
            var dp = data.dp ? _toArr(data.dp) : null, deriv = data.deriv ? _toArr(data.deriv) : null;
            if (!dp && data.p) {
                var loc = _localDelta(t, _toArr(data.p), 0);
                if (loc) { t = loc.t; dp = loc.dp; deriv = loc.deriv; }
            }
            if (!dp) return [];
            if (!deriv && !data.model) deriv = _bourdet(t, dp, _currentL());
            // Rate-normalise another flow period to the analysed period.
            var scale = 1;
            if (_num(data.qRef) && data.qRef !== 0 && _num(opts.qRef) && opts.qRef !== 0) scale = Math.abs(opts.qRef / data.qRef);
            out.push({ pts: zip(t, dp, scale) });
            if (deriv) out.push({ pts: zip(t, deriv, scale), dash: [2, 3] });
            return out;
        }
        if (data.dimensionless) return [];
        if (plotKey === 'horner') {
            var tp = _num(data.tp) ? data.tp : opts.tp;
            if (!_num(tp) || !data.p) return [];
            var hx = t.map(function (v) { return v > 0 ? (tp + v) / v : NaN; });
            return [{ pts: zip(hx, _toArr(data.p)) }];
        }
        if (_PRESSURE_X[plotKey]) {
            if (!data.p) return [];
            return [{ pts: zip(_PRESSURE_X[plotKey](data), _toArr(data.p)) }];
        }
        if (plotKey === 'rateCart' || plotKey === 'rateSemi' || plotKey === 'rateLog') {
            if (!data.q) return [];
            var tt = t;
            if (opts.timeUnit === 'd') { tt = []; for (i = 0; i < t.length; i++) tt.push(t[i] / 24); }
            return [{ pts: zip(tt, _toArr(data.q)) }];
        }
        return [];
    }

    G.PRiSM_drawOverlays = function PRiSM_drawOverlays(canvas, plotKey, baseAxes, opts) {
        if (!canvas || !canvas.getContext) return;
        var items = (G.PRiSM_overlays && G.PRiSM_overlays.items) || [];
        if (!items.length) return;
        try {
            var st = G.PRiSM_state || {};
            plotKey = plotKey || st.activePlot || 'bourdet';
            var axes = _getCanvasAxes(canvas, baseAxes);
            if (!axes) return;                                  // no transform — silent skip
            var ctx = canvas.getContext('2d');
            if (!ctx) return;
            var pr = axes.plotRect;
            var sopts = { timeUnit: opts && opts.timeUnit, tp: opts && opts.tp };
            var cur = null;
            if (plotKey === 'bourdet' || plotKey === 'horner') {
                cur = _analysisData();
                if (cur) { sopts.qRef = cur.qRef; if (!_num(sopts.tp)) sopts.tp = cur.tp; }
            }
            var drawn = [];
            ctx.save();
            try { ctx.beginPath(); ctx.rect(pr.x, pr.y, pr.w, pr.h); ctx.clip(); } catch (e) { /* optional */ }
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it.visible) continue;
                var series = _seriesForPlot(_resolveOverlay(it.source), plotKey, sopts);
                if (!series.length) continue;
                drawn.push(it);
                for (var s = 0; s < series.length; s++) {
                    var pts = series[s].pts;
                    ctx.strokeStyle = it.color || '#58a6ff';
                    ctx.lineWidth = series[s].dash ? 1.5 : 2;
                    ctx.setLineDash(series[s].dash || [5, 3]);
                    ctx.beginPath();
                    var started = false;
                    for (var k = 0; k < pts.length; k++) {
                        var p = pts[k];
                        if (!p || !_num(p[0]) || !_num(p[1])) { started = false; continue; }
                        var px = axes.toX(p[0]), py = axes.toY(p[1]);
                        if (!_num(px) || !_num(py)) { started = false; continue; }
                        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
                    }
                    ctx.stroke();
                }
            }
            ctx.setLineDash([]);
            ctx.restore();
            canvas._prismOverlaysDrawn = drawn.map(function (x) { return x.id; });

            // Legend chip, bottom-left of the plot box.
            if (drawn.length) {
                ctx.save();
                ctx.font = '11px sans-serif';
                ctx.textBaseline = 'middle';
                var th = _theme(), lineH = 14, padXL = 6, padYL = 4, maxW = 0;
                for (var m = 0; m < drawn.length; m++) {
                    var w = ctx.measureText(drawn[m].label || '').width || 0;
                    if (w > maxW) maxW = w;
                }
                var boxW = Math.min(pr.w - 16, 20 + maxW + padXL * 2), boxH = drawn.length * lineH + padYL * 2;
                var bx = pr.x + 8, by = pr.y + pr.h - boxH - 8;
                ctx.fillStyle = 'rgba(13,17,23,0.85)';
                ctx.fillRect(bx, by, boxW, boxH);
                ctx.strokeStyle = th.border || '#30363d';
                ctx.lineWidth = 1;
                ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
                for (var n = 0; n < drawn.length; n++) {
                    var iy = by + padYL + n * lineH + lineH / 2;
                    ctx.strokeStyle = drawn[n].color;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([4, 3]);
                    ctx.beginPath(); ctx.moveTo(bx + padXL, iy); ctx.lineTo(bx + padXL + 14, iy); ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = th.text || '#c9d1d9';
                    ctx.textAlign = 'left';
                    ctx.fillText(String(drawn[n].label || ''), bx + padXL + 18, iy);
                }
                ctx.restore();
            }
        } catch (e) {
            try { console.warn('PRiSM_drawOverlays:', e && e.message); } catch (_) { /* ignore */ }
        }
    };

    function _overlaysPostDraw(info) {
        if (!info || !info.canvas) return;
        G.PRiSM_drawOverlays(info.canvas, info.plotKey, info.axes || null, info.opts || null);
    }
    _overlaysPostDraw._prismId = 'plot-overlays';
    _registerPostDraw(_overlaysPostDraw);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — OVERLAY MANAGER UI
    // ═══════════════════════════════════════════════════════════════

    function _enumerateSources() {
        var out = [];
        var ds = G.PRiSM_dataset;
        if (ds && ds.t) {
            var pers = _datasetPeriods(ds);
            for (var i = 0; i < pers.length; i++) out.push({ source: 'period:' + i, label: 'Period #' + (i + 1) });
        }
        var ad = G.PRiSM_analysisData;
        if (ad) {
            var adList = [];
            if (typeof ad.list === 'function') adList = ad.list();
            else if (Array.isArray(ad)) adList = ad;
            else if (ad.items) {
                for (var k in ad.items) if (Object.prototype.hasOwnProperty.call(ad.items, k)) adList.push({ id: k, name: ad.items[k].name });
            }
            for (var a = 0; a < adList.length; a++) {
                var aid = adList[a].id || adList[a].name || ('a' + a);
                out.push({ source: 'analysis:' + aid, label: 'Analysis: ' + (adList[a].name || aid) });
            }
        }
        var gd = G.PRiSM_gaugeData;
        if (gd) {
            var gdList = [];
            if (typeof gd.list === 'function') gdList = gd.list();
            else if (Array.isArray(gd)) gdList = gd;
            else if (gd.items) {
                for (var kk in gd.items) if (Object.prototype.hasOwnProperty.call(gd.items, kk)) gdList.push({ id: kk, name: gd.items[kk].name });
            }
            for (var g = 0; g < gdList.length; g++) {
                var gid = gdList[g].id || gdList[g].name || ('g' + g);
                out.push({ source: 'gauge:' + gid, label: 'Gauge: ' + (gdList[g].name || gid) });
            }
        }
        var reg = G.PRiSM_MODELS;
        if (reg) {
            for (var key in reg) if (Object.prototype.hasOwnProperty.call(reg, key)) {
                if (reg[key] && typeof reg[key].pd === 'function' && reg[key].kind !== 'rate') {
                    out.push({ source: 'model:' + key, label: 'Model: ' + _modelName(key) });
                }
            }
        }
        var st = G.PRiSM_state || {};
        var hist = st.history || st.fitHistory || {};
        for (var fk in hist) if (Object.prototype.hasOwnProperty.call(hist, fk)) out.push({ source: 'fit:' + fk, label: 'Fit: ' + fk });
        return out;
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var _CTRL_CSS = 'padding:6px 8px; background:var(--bg1, #0d1117); color:var(--text, #e6edf3); ' +
                    'border:1px solid var(--border, #30363d); border-radius:4px; font-size:12px; max-width:100%; box-sizing:border-box;';

    G.PRiSM_renderOverlayManager = function PRiSM_renderOverlayManager(container) {
        if (!container || !_hasDoc) return;
        var items = G.PRiSM_overlays.list();
        var sources = _enumerateSources();
        var st = G.PRiSM_state || {};
        var plotKey = st.activePlot || 'bourdet';
        var sourceOpts = '<option value="">Add overlay…</option>';
        for (var i = 0; i < sources.length; i++) {
            sourceOpts += '<option value="' + _esc(sources[i].source) + '">' + _esc(sources[i].label) + '</option>';
        }
        var rows = '';
        if (!items.length) {
            rows = '<div style="font-size:12px; color:var(--text3, #6e7681); padding:6px 0;">No overlays yet.</div>';
        } else {
            for (var k = 0; k < items.length; k++) {
                var it = items[k];
                var res = _resolveOverlay(it.source);
                var canDraw = _seriesForPlot(res, plotKey, { tp: 1 }).length > 0;
                var why = !res ? 'not available' : (res.dimensionless ? 'needs a type-curve match or complete well inputs' : 'not shown on this plot');
                rows += '<div data-overlay-id="' + _esc(it.id) + '" style="display:flex; align-items:center; gap:8px; padding:4px 0; ' +
                            'border-bottom:1px solid var(--border, #30363d); min-width:0;">' +
                    '<input type="checkbox" data-overlay-toggle="' + _esc(it.id) + '"' + (it.visible ? ' checked' : '') + ' aria-label="Show overlay">' +
                    '<span style="flex:0 0 auto; width:14px; height:14px; border-radius:3px; background:' + _esc(it.color) + ';"></span>' +
                    '<span style="flex:1 1 auto; min-width:0; font-size:12px; color:var(--text, #e6edf3); overflow-wrap:anywhere;">' + _esc(it.label) +
                        (canDraw ? '' : ' <span style="color:var(--yellow, #d29922); font-size:11px;">(' + _esc(why) + ')</span>') + '</span>' +
                    '<button type="button" data-overlay-remove="' + _esc(it.id) + '" aria-label="Remove overlay" ' +
                        'style="background:none; border:none; color:var(--red, #f85149); cursor:pointer; font-size:16px; padding:2px 6px;">×</button>' +
                '</div>';
            }
        }
        container.innerHTML =
            '<div style="max-width:100%; box-sizing:border-box;">' +
                '<div data-overlay-list>' + rows + '</div>' +
                '<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:8px;">' +
                    '<select data-overlay-add aria-label="Add overlay" style="flex:1 1 180px; min-width:0; ' + _CTRL_CSS + '">' + sourceOpts + '</select>' +
                    '<button type="button" data-overlay-clear style="' + _CTRL_CSS + ' cursor:pointer;">Clear all</button>' +
                '</div>' +
            '</div>';

        function refresh() { G.PRiSM_renderOverlayManager(container); _redraw(); }
        var sel = container.querySelector('[data-overlay-add]');
        if (sel) sel.addEventListener('change', function (ev) {
            var v = ev.target.value;
            if (!v) return;
            G.PRiSM_overlays.add(v);
            refresh();
        });
        var clr = container.querySelector('[data-overlay-clear]');
        if (clr) clr.addEventListener('click', function () { G.PRiSM_overlays.clear(); refresh(); });
        var toggles = container.querySelectorAll('[data-overlay-toggle]');
        for (var tt = 0; tt < toggles.length; tt++) {
            (function (el) {
                el.addEventListener('change', function () {
                    G.PRiSM_overlays.toggle(el.getAttribute('data-overlay-toggle'));
                    _redraw();
                });
            })(toggles[tt]);
        }
        var rms = container.querySelectorAll('[data-overlay-remove]');
        for (var rr = 0; rr < rms.length; rr++) {
            (function (el) {
                el.addEventListener('click', function () {
                    G.PRiSM_overlays.remove(el.getAttribute('data-overlay-remove'));
                    refresh();
                });
            })(rms[rr]);
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — TWO-DATASET DIFF (interpolation + summary stats)
    // ═══════════════════════════════════════════════════════════════
    //
    // PRiSM_datasetDiff(dataA, dataB) interpolates B onto A's time grid
    // (intersected with B's range) and returns:
    //   { t, dp, dq?, rms, maxAbs, nCommon }
    //
    // Linear interpolation, monotonic-time assumption. Skips NaNs.
    // ═══════════════════════════════════════════════════════════════

    function _interp(t, p, x) {
        if (!t || !t.length) return NaN;
        if (x <= t[0]) return p[0];
        if (x >= t[t.length - 1]) return p[t.length - 1];
        // Binary search for the bracket.
        var lo = 0, hi = t.length - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (t[mid] <= x) lo = mid; else hi = mid;
        }
        var t0 = t[lo], t1 = t[hi];
        if (t1 === t0) return p[lo];
        var f = (x - t0) / (t1 - t0);
        return p[lo] + f * (p[hi] - p[lo]);
    }

    G.PRiSM_datasetDiff = function PRiSM_datasetDiff(dataA, dataB) {
        if (!dataA || !dataB || !Array.isArray(dataA.t) || !Array.isArray(dataB.t)) {
            return { t: [], dp: [], dq: null, rms: NaN, maxAbs: NaN, nCommon: 0 };
        }
        var hasP = (dataA.p && dataB.p);
        var hasQ = (dataA.q && dataB.q);
        if (!hasP) {
            return { t: [], dp: [], dq: null, rms: NaN, maxAbs: NaN, nCommon: 0 };
        }
        var tBmin = dataB.t[0], tBmax = dataB.t[dataB.t.length - 1];
        var tt = [], dpArr = [], dqArr = hasQ ? [] : null;
        var sumSq = 0, maxAbs = 0, n = 0;
        for (var i = 0; i < dataA.t.length; i++) {
            var ti = dataA.t[i];
            if (!isFinite(ti) || ti < tBmin || ti > tBmax) continue;
            var pa = dataA.p[i];
            var pb = _interp(dataB.t, dataB.p, ti);
            if (!isFinite(pa) || !isFinite(pb)) continue;
            var d = pa - pb;
            tt.push(ti);
            dpArr.push(d);
            sumSq += d * d;
            var a = Math.abs(d);
            if (a > maxAbs) maxAbs = a;
            n++;
            if (hasQ) {
                var qa = dataA.q[i];
                var qb = _interp(dataB.t, dataB.q, ti);
                dqArr.push((isFinite(qa) && isFinite(qb)) ? (qa - qb) : NaN);
            }
        }
        return {
            t:       tt,
            dp:      dpArr,
            dq:      dqArr,
            rms:     n ? Math.sqrt(sumSq / n) : NaN,
            maxAbs:  n ? maxAbs : NaN,
            nCommon: n
        };
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — DIFF PLOT (2-panel: superimposed + delta)
    // ═══════════════════════════════════════════════════════════════
    //
    // PRiSM_plot_dataset_diff(canvas, data, opts)
    //   data = { dataA: {t,p,q}, dataB: {t,p,q}, labelA?, labelB? }
    //   opts = { width, height, title, padding }
    //
    // Top panel: pA(t) and pB(t) on a shared linear/log time axis.
    // Bottom panel: dp = pA − pB (interpolated to A's grid).
    // ═══════════════════════════════════════════════════════════════

    function _setupCanvas(canvas, opts) {
        opts = opts || {};
        if (typeof G.PRiSM_plot_setup === 'function') {
            return G.PRiSM_plot_setup(canvas, opts);
        }
        // Inline mini-setup mirroring layer 2.
        var dpr = (typeof G !== 'undefined' && G.devicePixelRatio) || 1;
        var cssW = opts.width || (canvas && canvas.clientWidth) || (canvas && canvas.width) || 600;
        var cssH = opts.height || (canvas && canvas.clientHeight) || (canvas && canvas.height) || 400;
        if (canvas && canvas.style) {
            canvas.style.width = cssW + 'px';
            canvas.style.height = cssH + 'px';
        }
        if (canvas) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
        }
        var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
        if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var pad = Object.assign({}, _defaultPad(), opts.padding || {});
        return {
            ctx: ctx,
            plot: {
                x: pad.left, y: pad.top,
                w: cssW - pad.left - pad.right,
                h: cssH - pad.top - pad.bottom,
                cssW: cssW, cssH: cssH, pad: pad
            },
            dpr: dpr
        };
    }

    function _rangeOf(arr, padFrac) {
        var min = Infinity, max = -Infinity;
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i];
            if (!isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
        if (min === max) {
            if (min === 0) return { min: -1, max: 1 };
            min = min - Math.abs(min) * 0.1;
            max = max + Math.abs(max) * 0.1;
        }
        var span = max - min;
        var pf = padFrac == null ? 0.05 : padFrac;
        return { min: min - span * pf, max: max + span * pf };
    }

    G.PRiSM_plot_dataset_diff = function PRiSM_plot_dataset_diff(canvas, data, opts) {
        opts = opts || {};
        if (!canvas || !canvas.getContext) return;
        var setup = _setupCanvas(canvas, opts);
        var ctx = setup.ctx, plot = setup.plot;
        if (!ctx) return;
        var th = _theme();
        var dataA = data && data.dataA, dataB = data && data.dataB;
        // Background
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, 0, plot.cssW, plot.cssH);
        if (!dataA || !dataB || !dataA.t || !dataB.t || !dataA.t.length || !dataB.t.length) {
            ctx.fillStyle = th.text3;
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Select two datasets to diff', plot.cssW / 2, plot.cssH / 2);
            return;
        }
        var labelA = (data.labelA || 'Dataset A');
        var labelB = (data.labelB || 'Dataset B');

        var diff = G.PRiSM_datasetDiff(dataA, dataB);

        // Split the plot region into top (60%) and bottom (35%) with a gutter.
        var gutter = 14;
        var topH = Math.floor(plot.h * 0.60);
        var botH = plot.h - topH - gutter;
        var topPlot = { x: plot.x, y: plot.y, w: plot.w, h: topH };
        var botPlot = { x: plot.x, y: plot.y + topH + gutter, w: plot.w, h: botH };

        // Shared X range (union of both, padded).
        var xMinA = dataA.t[0], xMaxA = dataA.t[dataA.t.length - 1];
        var xMinB = dataB.t[0], xMaxB = dataB.t[dataB.t.length - 1];
        var xMin = Math.min(xMinA, xMinB);
        var xMax = Math.max(xMaxA, xMaxB);
        if (xMax <= xMin) xMax = xMin + 1;

        // Top Y range (both pressures).
        var pAll = (dataA.p || []).concat(dataB.p || []);
        var yT = _rangeOf(pAll, 0.05);
        // Bottom Y range (delta).
        var yB = _rangeOf(diff.dp, 0.10);

        function panelFrame(pp) {
            ctx.fillStyle = th.panel;
            ctx.fillRect(pp.x, pp.y, pp.w, pp.h);
            ctx.strokeStyle = th.border;
            ctx.lineWidth = 1;
            ctx.strokeRect(pp.x + 0.5, pp.y + 0.5, pp.w, pp.h);
        }

        function lineSeries(pp, t, p, xMn, xMx, yMn, yMx, color, dash) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(pp.x, pp.y, pp.w, pp.h);
            ctx.clip();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            if (dash) ctx.setLineDash(dash);
            ctx.beginPath();
            var started = false;
            for (var i = 0; i < t.length; i++) {
                if (!isFinite(t[i]) || !isFinite(p[i])) { started = false; continue; }
                var x = pp.x + (t[i] - xMn) / (xMx - xMn) * pp.w;
                var y = pp.y + pp.h - (p[i] - yMn) / (yMx - yMn) * pp.h;
                if (!isFinite(x) || !isFinite(y)) { started = false; continue; }
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }

        // Top panel
        panelFrame(topPlot);
        lineSeries(topPlot, dataA.t, dataA.p, xMin, xMax, yT.min, yT.max, th.accent);
        lineSeries(topPlot, dataB.t, dataB.p, xMin, xMax, yT.min, yT.max, th.blue, [6, 4]);

        // Top y-axis labels (3 ticks)
        ctx.fillStyle = th.text2;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (var t = 0; t <= 4; t++) {
            var v = yT.min + (yT.max - yT.min) * (t / 4);
            var py = topPlot.y + topPlot.h - (v - yT.min) / (yT.max - yT.min) * topPlot.h;
            ctx.fillText(v.toPrecision(3), topPlot.x - 4, py);
        }

        // Top legend
        ctx.fillStyle = 'rgba(13,17,23,0.85)';
        ctx.fillRect(topPlot.x + 8, topPlot.y + 8, 130, 36);
        ctx.strokeStyle = th.border;
        ctx.strokeRect(topPlot.x + 8.5, topPlot.y + 8.5, 130, 36);
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(topPlot.x + 14, topPlot.y + 18);
        ctx.lineTo(topPlot.x + 30, topPlot.y + 18);
        ctx.stroke();
        ctx.fillStyle = th.text;
        ctx.textAlign = 'left';
        ctx.fillText(labelA, topPlot.x + 36, topPlot.y + 18);
        ctx.strokeStyle = th.blue;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(topPlot.x + 14, topPlot.y + 32);
        ctx.lineTo(topPlot.x + 30, topPlot.y + 32);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = th.text;
        ctx.fillText(labelB, topPlot.x + 36, topPlot.y + 32);

        // Title
        if (opts.title) {
            ctx.fillStyle = th.text;
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(opts.title, topPlot.x, 8);
        }

        // Bottom panel — Δp
        panelFrame(botPlot);
        // Zero line if range crosses
        if (yB.min < 0 && yB.max > 0) {
            ctx.strokeStyle = th.text3;
            ctx.setLineDash([3, 3]);
            var zy = botPlot.y + botPlot.h - (0 - yB.min) / (yB.max - yB.min) * botPlot.h;
            ctx.beginPath();
            ctx.moveTo(botPlot.x, zy);
            ctx.lineTo(botPlot.x + botPlot.w, zy);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        lineSeries(botPlot, diff.t, diff.dp, xMin, xMax, yB.min, yB.max, th.green);

        // Y-axis labels for bottom
        ctx.fillStyle = th.text2;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (var bt = 0; bt <= 2; bt++) {
            var bv = yB.min + (yB.max - yB.min) * (bt / 2);
            var bpy = botPlot.y + botPlot.h - (bv - yB.min) / (yB.max - yB.min) * botPlot.h;
            ctx.fillText(bv.toPrecision(3), botPlot.x - 4, bpy);
        }

        // X-axis ticks shared at bottom of bottom panel.
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (var xt = 0; xt <= 5; xt++) {
            var xv = xMin + (xMax - xMin) * (xt / 5);
            var xpx = botPlot.x + (xv - xMin) / (xMax - xMin) * botPlot.w;
            ctx.fillText(xv.toPrecision(3), xpx, botPlot.y + botPlot.h + 4);
        }

        // Y-labels (rotated)
        ctx.fillStyle = th.text;
        ctx.font = '11px sans-serif';
        ctx.save();
        ctx.translate(14, topPlot.y + topPlot.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Pressure', 0, 0);
        ctx.restore();
        ctx.save();
        ctx.translate(14, botPlot.y + botPlot.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('ΔP', 0, 0);
        ctx.restore();

        // Stats footer
        ctx.fillStyle = th.text2;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
            'n=' + diff.nCommon + '  RMS=' + (isFinite(diff.rms) ? diff.rms.toPrecision(3) : '—') +
            '  max|Δp|=' + (isFinite(diff.maxAbs) ? diff.maxAbs.toPrecision(3) : '—'),
            botPlot.x + botPlot.w, plot.cssH - 4
        );
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5b — DIFF PICKER UI
    // ═══════════════════════════════════════════════════════════════

    function _diffSourceList() {
        var out = [];
        var ds = G.PRiSM_dataset;
        if (ds && ds.t) {
            out.push({ id: 'current', name: 'Current dataset', resolve: function () { return ds; } });
        }
        var gd = G.PRiSM_gaugeData;
        if (gd) {
            var list = (typeof gd.list === 'function') ? gd.list()
                     : Array.isArray(gd) ? gd
                     : (gd.items ? Object.keys(gd.items).map(function (k) { return Object.assign({ id: k }, gd.items[k]); }) : []);
            for (var i = 0; i < list.length; i++) {
                (function (g, idx) {
                    var gid = g.id || g.name || ('g' + idx);
                    out.push({ id: 'gauge:' + gid, name: 'Gauge: ' + (g.name || gid),
                               resolve: function () { return _resolveOverlay('gauge:' + gid); } });
                })(list[i], i);
            }
        }
        var ad = G.PRiSM_analysisData;
        if (ad) {
            var alist = (typeof ad.list === 'function') ? ad.list()
                      : Array.isArray(ad) ? ad
                      : (ad.items ? Object.keys(ad.items).map(function (k) { return Object.assign({ id: k }, ad.items[k]); }) : []);
            for (var j = 0; j < alist.length; j++) {
                (function (a, idx) {
                    var aid = a.id || a.name || ('a' + idx);
                    out.push({ id: 'analysis:' + aid, name: 'Analysis: ' + (a.name || aid),
                               resolve: function () { return _resolveOverlay('analysis:' + aid); } });
                })(alist[j], j);
            }
        }
        var st = G.PRiSM_state || {};
        var saved = st.savedSets || st.snapshots || {};
        for (var sk in saved) if (Object.prototype.hasOwnProperty.call(saved, sk)) {
            (function (key, snap) {
                out.push({ id: 'saved:' + key, name: 'Saved: ' + key, resolve: function () { return snap; } });
            })(sk, saved[sk]);
        }
        return out;
    }

    G.PRiSM_renderDiffPicker = function PRiSM_renderDiffPicker(container) {
        if (!container || !_hasDoc) return;
        var sources = _diffSourceList();
        function buildOpts(sel) {
            var opts = '<option value="">Pick a dataset…</option>';
            for (var i = 0; i < sources.length; i++) {
                opts += '<option value="' + _esc(sources[i].id) + '"' + (sources[i].id === sel ? ' selected' : '') + '>' +
                        _esc(sources[i].name) + '</option>';
            }
            return opts;
        }
        container.innerHTML =
            '<div style="max-width:100%; box-sizing:border-box;">' +
                (sources.length < 2
                    ? '<div style="font-size:12px; color:var(--text3, #6e7681); margin-bottom:6px;">Load a second gauge or analysis dataset (Tab 1) to compare it with the current data.</div>'
                    : '') +
                '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">' +
                    '<label style="flex:1 1 150px; min-width:0; font-size:12px; color:var(--text2, #8b949e); display:flex; gap:6px; align-items:center;">A ' +
                        '<select data-diff-a style="flex:1 1 auto; min-width:0; ' + _CTRL_CSS + '">' + buildOpts('current') + '</select></label>' +
                    '<label style="flex:1 1 150px; min-width:0; font-size:12px; color:var(--text2, #8b949e); display:flex; gap:6px; align-items:center;">B ' +
                        '<select data-diff-b style="flex:1 1 auto; min-width:0; ' + _CTRL_CSS + '">' + buildOpts('') + '</select></label>' +
                    '<button type="button" data-diff-go class="btn btn-secondary" style="font-size:12px; padding:6px 12px;">Compare</button>' +
                '</div>' +
                '<canvas data-diff-canvas style="width:100%; height:300px; display:block; ' +
                    'background:var(--bg1, #0d1117); border:1px solid var(--border, #30363d); border-radius:4px;"></canvas>' +
                '<div data-diff-summary role="status" style="margin-top:6px; font-size:11px; color:var(--text2, #8b949e);"></div>' +
            '</div>';
        var btn = container.querySelector('[data-diff-go]');
        if (btn) btn.addEventListener('click', function () {
            var aSel = container.querySelector('[data-diff-a]');
            var bSel = container.querySelector('[data-diff-b]');
            var idA = aSel && aSel.value, idB = bSel && bSel.value;
            var sum = container.querySelector('[data-diff-summary]');
            if (!idA || !idB) { if (sum) sum.textContent = 'Pick two datasets.'; return; }
            var a = sources.filter(function (x) { return x.id === idA; })[0];
            var b = sources.filter(function (x) { return x.id === idB; })[0];
            if (!a || !b) return;
            var dA = a.resolve(), dB = b.resolve();
            var canvas = container.querySelector('[data-diff-canvas]');
            G.PRiSM_plot_dataset_diff(canvas, { dataA: dA, dataB: dB, labelA: a.name, labelB: b.name },
                                      { title: a.name + ' − ' + b.name });
            var diff = G.PRiSM_datasetDiff(dA, dB);
            if (sum) {
                sum.textContent = 'Common samples: ' + diff.nCommon +
                    ' · RMS Δp = ' + (isFinite(diff.rms) ? diff.rms.toPrecision(4) : '—') + ' psi' +
                    ' · max |Δp| = ' + (isFinite(diff.maxAbs) ? diff.maxAbs.toPrecision(4) : '—') + ' psi';
            }
            _ga4('prism_diff_compute', { n: diff.nCommon });
        });
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — XML EXPORT
    // ═══════════════════════════════════════════════════════════════
    //
    // Serialise the PRiSM project into a single XML document.
    // Number arrays are space-separated (compact, but still parseable).
    // String content gets the standard 5-entity escape.
    // ═══════════════════════════════════════════════════════════════

    function _xmlEscape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g,  '&amp;')
            .replace(/</g,  '&lt;')
            .replace(/>/g,  '&gt;')
            .replace(/"/g,  '&quot;')
            .replace(/'/g,  '&apos;');
    }

    function _xmlAttrs(attrs) {
        if (!attrs) return '';
        var out = '';
        for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
            if (attrs[k] == null) continue;
            out += ' ' + k + '="' + _xmlEscape(attrs[k]) + '"';
        }
        return out;
    }

    function _arrCompact(arr) {
        if (!arr || !arr.length) return '';
        var parts = [];
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i];
            if (v == null || !isFinite(v)) parts.push('NaN');
            else parts.push(String(v));
        }
        return parts.join(' ');
    }

    // Lightweight XML builder. _b(name, attrs, children) where children
    // is either: a string (raw text — must already be escaped or be an
    // array-compact string), an array of more _b() outputs, or null.
    function _xmlBuilder(pretty) {
        var nl = pretty ? '\n' : '';
        function indent(n) {
            if (!pretty) return '';
            var s = ''; for (var i = 0; i < n; i++) s += '  '; return s;
        }
        function build(name, attrs, children, depth) {
            depth = depth || 0;
            var pre = indent(depth);
            var openTag = '<' + name + _xmlAttrs(attrs);
            if (children == null || children === '' || (Array.isArray(children) && !children.length)) {
                return pre + openTag + '/>' + nl;
            }
            if (typeof children === 'string') {
                // Inline content — keep on one line if short, else block
                if (children.length < 80 && children.indexOf('\n') < 0) {
                    return pre + openTag + '>' + children + '</' + name + '>' + nl;
                }
                return pre + openTag + '>' + nl + indent(depth + 1) + children + nl +
                       pre + '</' + name + '>' + nl;
            }
            // Array of pre-built strings (each already includes newline if pretty)
            var inner = children.join('');
            return pre + openTag + '>' + nl + inner + pre + '</' + name + '>' + nl;
        }
        return build;
    }

    function _now() {
        try { return (new Date()).toISOString(); } catch (e) { return ''; }
    }

    function _formatStamp() {
        try {
            var d = new Date();
            var yyyy = d.getFullYear();
            var mm = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            var hh = String(d.getHours()).padStart(2, '0');
            var mi = String(d.getMinutes()).padStart(2, '0');
            var ss = String(d.getSeconds()).padStart(2, '0');
            return yyyy + mm + dd + '-' + hh + mi + ss;
        } catch (e) { return 'export'; }
    }

    function _serializeMeta(b) {
        return b('Meta', null, [
            b('Name',      null, _xmlEscape((G.PRiSM_state && G.PRiSM_state.projectName) || 'PRiSM Project'), 2),
            b('CreatedAt', null, _xmlEscape(_now()), 2),
            b('Notes',     null, _xmlEscape((G.PRiSM_state && G.PRiSM_state.notes) || ''), 2)
        ], 1);
    }

    function _serializePVT(b) {
        var pvt = G.PRiSM_pvt;
        if (!pvt) return b('PVT', { available: 'false' }, null, 1);
        var children = [];
        var keysToSerialise = ['inputs', 'computed', 'fluidType', 'units'];
        for (var i = 0; i < keysToSerialise.length; i++) {
            var k = keysToSerialise[i];
            if (pvt[k] == null) continue;
            var section = pvt[k];
            if (typeof section === 'object' && !Array.isArray(section)) {
                var fields = [];
                for (var fk in section) if (Object.prototype.hasOwnProperty.call(section, fk)) {
                    var v = section[fk];
                    if (v == null) continue;
                    if (typeof v === 'object') continue; // skip nested
                    fields.push(b(fk, null, _xmlEscape(String(v)), 3));
                }
                children.push(b(k.charAt(0).toUpperCase() + k.slice(1), null, fields, 2));
            } else if (typeof section !== 'object') {
                children.push(b(k.charAt(0).toUpperCase() + k.slice(1), null, _xmlEscape(String(section)), 2));
            }
        }
        if (!children.length) return b('PVT', { available: 'true', empty: 'true' }, null, 1);
        return b('PVT', { available: 'true' }, children, 1);
    }

    function _serializeGauges(b, includeRaw) {
        var gd = G.PRiSM_gaugeData;
        if (!gd) return b('GaugeData', { available: 'false' }, null, 1);
        var list = (typeof gd.list === 'function') ? gd.list()
                 : Array.isArray(gd) ? gd
                 : (gd.items ? Object.keys(gd.items).map(function (k) {
                     return Object.assign({ id: k }, gd.items[k]);
                   }) : []);
        if (!list.length) return b('GaugeData', { available: 'true', empty: 'true' }, null, 1);
        var children = [];
        for (var i = 0; i < list.length; i++) {
            var g = list[i];
            var gid = g.id || g.name || ('gauge_' + i);
            var attrs = { id: gid, name: (g.name || gid) };
            var inner = [];
            if (g.metadata && typeof g.metadata === 'object') {
                var meta = [];
                for (var mk in g.metadata) if (Object.prototype.hasOwnProperty.call(g.metadata, mk)) {
                    if (typeof g.metadata[mk] === 'object') continue;
                    meta.push(b(mk, null, _xmlEscape(String(g.metadata[mk])), 4));
                }
                if (meta.length) inner.push(b('Metadata', null, meta, 3));
            }
            var t = g.t || (g.samples && g.samples.t) || [];
            var p = g.p || (g.samples && g.samples.p) || [];
            var q = g.q || (g.samples && g.samples.q) || null;
            inner.push(b('Samples', { count: t.length, includeRaw: !!includeRaw }, includeRaw && t.length ? [
                b('t', null, _arrCompact(t), 4),
                p.length ? b('p', null, _arrCompact(p), 4) : '',
                (q && q.length) ? b('q', null, _arrCompact(q), 4) : ''
            ].filter(Boolean) : null, 3));
            children.push(b('Gauge', attrs, inner, 2));
        }
        return b('GaugeData', { available: 'true', count: list.length }, children, 1);
    }

    function _serializeAnalysis(b) {
        var ad = G.PRiSM_analysisData;
        if (!ad) return b('AnalysisData', { available: 'false' }, null, 1);
        var list = (typeof ad.list === 'function') ? ad.list()
                 : Array.isArray(ad) ? ad
                 : (ad.items ? Object.keys(ad.items).map(function (k) {
                     return Object.assign({ id: k }, ad.items[k]);
                   }) : []);
        if (!list.length) return b('AnalysisData', { available: 'true', empty: 'true' }, null, 1);
        var children = [];
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            var aid = a.id || a.name || ('analysis_' + i);
            var attrs = {
                id:          aid,
                name:        (a.name || aid),
                derivedFrom: (a.derivedFrom || a.source || '')
            };
            var inner = [];
            var t = a.t || (a.data && a.data.t) || [];
            var p = a.p || (a.data && a.data.p) || [];
            var dp = a.dp || (a.data && a.data.dp) || [];
            inner.push(b('Samples', { count: t.length },
                (t.length ? [
                    b('t', null, _arrCompact(t), 4),
                    p.length  ? b('p',  null, _arrCompact(p),  4) : '',
                    dp.length ? b('dp', null, _arrCompact(dp), 4) : ''
                ].filter(Boolean) : null), 3));
            if (a.notes) inner.push(b('Notes', null, _xmlEscape(String(a.notes)), 3));
            children.push(b('Analysis', attrs, inner, 2));
        }
        return b('AnalysisData', { available: 'true', count: list.length }, children, 1);
    }

    function _serializeWell(b) {
        var w = null;
        if (typeof G.PRiSM_getWell === 'function') { try { w = G.PRiSM_getWell(); } catch (e) { w = null; } }
        if (!w || typeof w !== 'object') return b('Well', { available: 'false' }, null, 1);
        var gas = w.fluid === 'gas';
        var units = { q: gas ? 'Mscf/d' : 'STB/d', B: gas ? 'RB/Mscf' : 'RB/STB', mu: 'cp', ct: '1/psi', h: 'ft',
                      phi: 'fraction', rw: 'ft', pi: 'psia', T_R: 'degF', tp: 'hr', tShut: 'hr', pwf0: 'psia' };
        var keys = ['fluid', 'testType', 'q', 'B', 'mu', 'ct', 'h', 'phi', 'rw', 'pi', 'T_R', 'sg', 'tp', 'tShut', 'pwf0'];
        var dflt = Array.isArray(w.defaulted) ? w.defaulted : [];
        var children = [];
        keys.forEach(function (k) {
            if (w[k] == null || (typeof w[k] === 'number' && !isFinite(w[k]))) return;
            children.push(b('Input', { name: k, unit: units[k] || null, defaulted: dflt.indexOf(k) !== -1 ? 'true' : null },
                            _xmlEscape(String(w[k])), 2));
        });
        return b('Well', { available: 'true', complete: w.complete ? 'true' : 'false' }, children.length ? children : null, 1);
    }

    // C2 analysis data: Δt, p, sign-aware Δp and its Bourdet derivative.
    function _serializeDerivative(b) {
        var ad = _analysisData();
        if (!ad || !ad.ok) return b('DerivativeData', { available: 'false' }, null, 1);
        var attrs = {
            available: 'true', count: ad.t.length,
            pRef: _num(ad.pRef) ? ad.pRef : null, pRefSource: ad.pRefSource || null,
            testType: ad.testType || null, timeFn: ad.timeFn || null, L: _num(ad.L) ? ad.L : null
        };
        return b('DerivativeData', attrs, [
            b('dt_hr', null, _arrCompact(_toArr(ad.t)), 2),
            ad.p ? b('p_psia', null, _arrCompact(_toArr(ad.p)), 2) : '',
            b('dp_psi', null, _arrCompact(_toArr(ad.dp)), 2),
            ad.deriv ? b('dp_deriv_psi', null, _arrCompact(_toArr(ad.deriv)), 2) : ''
        ].filter(Boolean), 1);
    }

    function _serializeLineTools(b) {
        if (typeof G.PRiSM_analysisKeyReportRows !== 'function') return b('LineTools', { available: 'false' }, null, 1);
        var rows = [];
        try { rows = G.PRiSM_analysisKeyReportRows() || []; } catch (e) { rows = []; }
        if (!rows.length) return b('LineTools', { available: 'true', count: 0 }, null, 1);
        var byKey = {}, order = [];
        rows.forEach(function (r) {
            if (!byKey[r.key]) { byKey[r.key] = { label: r.tool, defaulted: r.defaulted, rows: [] }; order.push(r.key); }
            byKey[r.key].rows.push(r);
        });
        var children = order.map(function (k) {
            var e = byKey[k];
            return b('Tool', { key: k, label: e.label, defaultInputs: e.defaulted ? 'true' : null },
                     e.rows.map(function (r) {
                         return b('Value', { name: r.quantity, unit: r.unit || null }, _xmlEscape(String(r.value)), 3);
                     }), 2);
        });
        return b('LineTools', { available: 'true', count: order.length }, children, 1);
    }

    function _lastFit() {
        var lf = null;
        if (typeof G.PRiSM_getLastFit === 'function') { try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; } }
        if (!lf) lf = (G.PRiSM_state || {}).lastFit || null;
        return lf;
    }

    function _kvChildren(b, obj, depth, tag) {
        var out = [];
        for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
            var v = obj[k];
            if (v == null || typeof v === 'object' || typeof v === 'function') continue;
            out.push(b(tag || 'Param', { name: k }, _xmlEscape(String(v)), depth));
        }
        return out;
    }

    function _serializeModel(b, includeFitHistory) {
        var st = G.PRiSM_state || {};
        var children = [];
        children.push(b('Active', null, _xmlEscape(st.model || ''), 2));
        var params = st.params || {}, paramChildren = [];
        for (var pk in params) if (Object.prototype.hasOwnProperty.call(params, pk)) {
            if (params[pk] == null || typeof params[pk] === 'object') continue;
            paramChildren.push(b('Param', { name: pk, frozen: !!(st.paramFreeze && st.paramFreeze[pk]) },
                                 _xmlEscape(String(params[pk])), 3));
        }
        children.push(b('Params', null, paramChildren.length ? paramChildren : null, 2));
        if (st.tcMatch && typeof st.tcMatch === 'object') {
            children.push(b('TypeCurveMatch', { logPM: _num(st.tcMatch.logPM) ? st.tcMatch.logPM : null,
                                                logTM: _num(st.tcMatch.logTM) ? st.tcMatch.logTM : null,
                                                source: st.tcMatch.source || null }, null, 2));
        }
        var lf = _lastFit();
        if (lf) {
            var lfChildren = [];
            if (lf.params) lfChildren.push(b('Params', null, _kvChildren(b, lf.params, 4), 3));
            if (lf.phys) lfChildren.push(b('Physical', null, _kvChildren(b, lf.phys, 4, 'Value'), 3));
            if (lf.ci95) {
                var ci = [];
                for (var ck in lf.ci95) if (Object.prototype.hasOwnProperty.call(lf.ci95, ck)) {
                    var rng = lf.ci95[ck] || [];
                    ci.push(b('CI', { name: ck, low: rng[0], high: rng[1] }, null, 4));
                }
                if (ci.length) lfChildren.push(b('CI95', null, ci, 3));
            }
            var r2 = _num(lf.r2) ? lf.r2 : lf.R2, rmse = _num(lf.rmse) ? lf.rmse : lf.RMSE, aic = _num(lf.aic) ? lf.aic : lf.AIC;
            if (_num(aic))  lfChildren.push(b('AIC',  null, _xmlEscape(String(aic)),  3));
            if (_num(r2))   lfChildren.push(b('R2',   null, _xmlEscape(String(r2)),   3));
            if (_num(rmse)) lfChildren.push(b('RMSE', null, _xmlEscape(String(rmse)), 3));
            if (_num(lf.iterations)) lfChildren.push(b('Iterations', null, _xmlEscape(String(lf.iterations)), 3));
            if (lf.converged != null) lfChildren.push(b('Converged', null, _xmlEscape(String(!!lf.converged)), 3));
            children.push(b('LastFit', { model: lf.modelKey || lf.model || null, source: lf.source || null },
                            lfChildren.length ? lfChildren : null, 2));
        }
        if (st.semilog && typeof st.semilog === 'object') {
            children.push(b('Semilog', { method: st.semilog.method || null }, _kvChildren(b, st.semilog, 3, 'Value'), 2));
        }
        if (includeFitHistory) {
            var hist = st.history || st.fitHistory || {}, histChildren = [];
            for (var hk in hist) if (Object.prototype.hasOwnProperty.call(hist, hk)) {
                var f = hist[hk] || {};
                histChildren.push(b('Fit', { key: hk, aic: _num(f.aic) ? f.aic : null, r2: _num(f.r2) ? f.r2 : null,
                                             model: f.model || f.modelKey || null }, null, 3));
            }
            if (histChildren.length) children.push(b('FitHistory', { count: histChildren.length }, histChildren, 2));
        }
        return b('Model', null, children, 1);
    }

    function _serializeDataset(b, includeRaw) {
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t) return b('Dataset', { available: 'false' }, null, 1);
        var children = [];
        if (ds.periods && ds.periods.length) {
            var pc = [];
            for (var i = 0; i < ds.periods.length; i++) {
                var pr = ds.periods[i], bb = _periodBounds(pr) || {};
                pc.push(b('Period', { index: i, t0: bb.t0, t1: bb.t1, q: pr.q }, null, 3));
            }
            children.push(b('Periods', { count: pc.length }, pc, 2));
        }
        if (includeRaw && ds.t.length) {
            children.push(b('Samples', { count: ds.t.length }, [
                b('t_hr', null, _arrCompact(_toArr(ds.t)), 3),
                ds.p ? b('p_psia', null, _arrCompact(_toArr(ds.p)), 3) : '',
                ds.q ? b('q', null, _arrCompact(_toArr(ds.q)), 3) : ''
            ].filter(Boolean), 2));
        } else {
            children.push(b('Samples', { count: ds.t.length, includeRaw: 'false' }, null, 2));
        }
        return b('Dataset', { available: 'true', samples: ds.t.length }, children, 1);
    }

    G.PRiSM_exportXML = function PRiSM_exportXML(opts) {
        opts = opts || {};
        var pretty            = opts.pretty !== false;
        var includeRawGauge   = !!opts.includeRawGaugeData;
        var includeAnalysis   = opts.includeAnalysisData !== false;
        var includeFitHistory = opts.includeFitHistory   !== false;
        var includeRawDataset = opts.includeRawDataset   !== false;

        var b = _xmlBuilder(pretty);
        var nl = pretty ? '\n' : '';
        var sections = [];
        sections.push(_serializeMeta(b));
        sections.push(_serializeWell(b));
        sections.push(_serializePVT(b));
        sections.push(_serializeDataset(b, includeRawDataset));
        sections.push(_serializeDerivative(b));
        sections.push(_serializeGauges(b, includeRawGauge));
        if (includeAnalysis) sections.push(_serializeAnalysis(b));
        sections.push(_serializeModel(b, includeFitHistory));
        sections.push(_serializeLineTools(b));

        var body = b('PRiSMProject', { version: '1.1', exportedAt: _now(), generator: 'PRiSM' }, sections, 0);
        var xml = '<?xml version="1.0" encoding="UTF-8"?>' + nl + body;
        var filename = 'prism-export-' + _formatStamp() + '.xml';
        var blob = null;
        try { if (typeof Blob === 'function' || typeof Blob === 'object') blob = new Blob([xml], { type: 'application/xml' }); }
        catch (e) { blob = null; }
        _ga4('prism_xml_export', { sizeBytes: xml.length });
        return { blob: blob, filename: filename, xmlString: xml };
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — DOWNLOAD HELPER (general)
    // ═══════════════════════════════════════════════════════════════

    function _downloadText(text, filename, mime) {
        if (!_hasDoc) return false;
        try {
            var url, blob = null;
            if (typeof Blob !== 'undefined') blob = new Blob([text], { type: mime || 'text/plain' });
            if (blob && typeof URL !== 'undefined' && URL.createObjectURL) url = URL.createObjectURL(blob);
            else url = 'data:' + (mime || 'text/plain') + ';charset=utf-8,' + encodeURIComponent(text);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (url && url.indexOf('blob:') === 0 && URL.revokeObjectURL) {
                setTimeout(function () { URL.revokeObjectURL(url); }, 0);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    G.PRiSM_exportXMLDownload = function PRiSM_exportXMLDownload(opts) {
        var res = G.PRiSM_exportXML(opts);
        if (!_downloadText(res.xmlString, res.filename, 'application/xml')) {
            try { console.warn('PRiSM_exportXMLDownload: download not available'); } catch (_) { /* ignore */ }
        }
        return res;
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — CLIPBOARD HELPERS (PNG + TSV/CSV/JSON)
    // ═══════════════════════════════════════════════════════════════

    function _hasClipboardImageAPI() {
        try {
            return _hasWin && G.navigator && G.navigator.clipboard &&
                   typeof G.navigator.clipboard.write === 'function' && typeof G.ClipboardItem === 'function';
        } catch (e) { return false; }
    }

    function _hasClipboardTextAPI() {
        try {
            return _hasWin && G.navigator && G.navigator.clipboard && typeof G.navigator.clipboard.writeText === 'function';
        } catch (e) { return false; }
    }

    // Off-screen render (11: PRiSM_renderPlotToCanvas uses PRiSM_buildPlotData)
    // or, failing that, a snapshot of the live plot canvas.
    function _plotCanvas(plotKey, w, h) {
        var key = plotKey || (G.PRiSM_state && G.PRiSM_state.activePlot) || 'bourdet';
        if (typeof G.PRiSM_renderPlotToCanvas === 'function') {
            try { var c = G.PRiSM_renderPlotToCanvas(key, w, h); if (c) return c; } catch (e) { /* snapshot */ }
        }
        if (!_hasDoc) return null;
        var live = document.getElementById('prism_plot_canvas');
        if (!live) return null;
        var off = document.createElement('canvas');
        off.width = w || live.width || 1200;
        off.height = h || live.height || 800;
        try { off.getContext('2d').drawImage(live, 0, 0, off.width, off.height); return off; } catch (e2) { return null; }
    }

    G.PRiSM_copyPlotToClipboard = function PRiSM_copyPlotToClipboard(plotKey) {
        return new Promise(function (resolve) {
            try {
                var off = _plotCanvas(plotKey, 1200, 800);
                if (!off || !off.toBlob) { resolve({ success: false, error: 'No plot available' }); return; }
                if (!_hasClipboardImageAPI()) {
                    var url = '';
                    try { url = off.toDataURL('image/png'); } catch (e) { /* ignore */ }
                    resolve({ success: false, error: 'Copying images is not supported here — use Export PNG', dataUrl: url });
                    return;
                }
                off.toBlob(function (blob) {
                    if (!blob) { resolve({ success: false, error: 'Could not encode the image' }); return; }
                    try {
                        var item = new G.ClipboardItem({ 'image/png': blob });
                        G.navigator.clipboard.write([item]).then(function () {
                            _ga4('prism_copy_plot', { sizeBytes: blob.size });
                            resolve({ success: true });
                        }, function (err) {
                            resolve({ success: false, error: (err && err.message) || String(err) });
                        });
                    } catch (e) {
                        resolve({ success: false, error: e && e.message });
                    }
                }, 'image/png');
            } catch (e) {
                resolve({ success: false, error: e && e.message });
            }
        });
    };

    // Raw samples: t [hr], p [psia], q.
    function _rawTable(ds, sep) {
        if (!ds || !ds.t) return '';
        var cols = ['t_hr'];
        if (ds.p) cols.push('p_psia');
        if (ds.q) cols.push('q');
        var lines = [cols.join(sep)];
        for (var i = 0; i < ds.t.length; i++) {
            var row = [String(ds.t[i])];
            if (ds.p) row.push(String(ds.p[i]));
            if (ds.q) row.push(String(ds.q[i]));
            lines.push(row.join(sep));
        }
        return lines.join('\n');
    }

    // Analysis data (C2): Δt, t, p, Δp and Δp′ in psi.
    function _analysisTable(ad, sep) {
        if (!ad || !ad.ok || !ad.t) return '';
        var t = _toArr(ad.t), tAbs = _toArr(ad.tAbs), p = _toArr(ad.p), dp = _toArr(ad.dp), dv = _toArr(ad.deriv);
        var cols = ['dt_hr'];
        if (tAbs) cols.push('t_hr');
        if (p) cols.push('p_psia');
        cols.push('dp_psi', 'dp_deriv_psi');
        var lines = [cols.join(sep)];
        for (var i = 0; i < t.length; i++) {
            var row = [String(t[i])];
            if (tAbs) row.push(String(tAbs[i]));
            if (p) row.push(String(p[i]));
            row.push(String(dp[i]), (dv && _num(dv[i])) ? String(dv[i]) : '');
            lines.push(row.join(sep));
        }
        return lines.join('\n');
    }

    function _dataJSON(ds, ad) {
        var out = { units: { t: 'hr', p: 'psia', dp: 'psi' } };
        if (ds && ds.t) out.raw = { t_hr: _toArr(ds.t), p_psia: _toArr(ds.p) || null, q: _toArr(ds.q) || null, periods: ds.periods || null };
        if (ad && ad.ok) {
            out.analysis = { dt_hr: _toArr(ad.t), p_psia: _toArr(ad.p) || null, dp_psi: _toArr(ad.dp), dp_deriv_psi: _toArr(ad.deriv) || null,
                             pRef: ad.pRef, pRefSource: ad.pRefSource || null, testType: ad.testType || null };
        }
        return JSON.stringify(out);
    }

    // format: 'tsv' | 'csv' (analysis data when available, else raw) | 'raw-tsv' | 'raw-csv' | 'json'
    G.PRiSM_copyDataToClipboard = function PRiSM_copyDataToClipboard(format) {
        format = (format || 'tsv').toLowerCase();
        return new Promise(function (resolve) {
            try {
                var ds = G.PRiSM_dataset;
                if (!ds || !ds.t || !ds.t.length) { resolve({ success: false, error: 'No dataset loaded' }); return; }
                var ad = (format === 'raw-tsv' || format === 'raw-csv') ? null : _analysisData();
                var sep = (format === 'csv' || format === 'raw-csv') ? ',' : '\t';
                var text;
                if (format === 'json') text = _dataJSON(ds, ad);
                else if (format === 'tsv' || format === 'csv' || format === 'raw-tsv' || format === 'raw-csv') {
                    text = (ad && ad.ok) ? _analysisTable(ad, sep) : _rawTable(ds, sep);
                } else { resolve({ success: false, error: 'Unsupported format: ' + format }); return; }
                if (!_hasClipboardTextAPI()) {
                    resolve({ success: false, error: 'Clipboard text API unavailable in this context', text: text });
                    return;
                }
                G.navigator.clipboard.writeText(text).then(function () {
                    _ga4('prism_copy_data', { format: format, length: text.length });
                    resolve({ success: true, length: text.length, text: text });
                }, function (err) {
                    resolve({ success: false, error: (err && err.message) || String(err) });
                });
            } catch (e) {
                resolve({ success: false, error: e && e.message });
            }
        });
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — EXPORT/COPY TOOLBAR + TAB 2 "PLOT TOOLS" PANEL
    // ═══════════════════════════════════════════════════════════════

    var _BTN = 'class="btn btn-secondary" style="font-size:12px; padding:6px 10px; max-width:100%; box-sizing:border-box;"';

    G.PRiSM_renderClipboardToolbar = function PRiSM_renderClipboardToolbar(container) {
        if (!container || !_hasDoc) return;
        container.innerHTML =
            '<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; max-width:100%;">' +
                '<button type="button" data-cb-png ' + _BTN + '>Export PNG</button>' +
                '<button type="button" data-cb-pdf ' + _BTN + '>Export PDF report</button>' +
                '<button type="button" data-cb-plot ' + _BTN + '>Copy plot</button>' +
                '<button type="button" data-cb-data ' + _BTN + '>Copy data (TSV)</button>' +
                '<button type="button" data-cb-xml ' + _BTN + '>Export XML</button>' +
            '</div>' +
            '<div data-cb-msg role="status" style="font-size:11px; color:var(--text2, #8b949e); margin-top:6px; min-height:14px;"></div>';
        var msg = container.querySelector('[data-cb-msg]');
        function flash(text, isErr) {
            if (!msg) return;
            msg.style.color = isErr ? 'var(--red, #f85149)' : 'var(--green, #3fb950)';
            msg.textContent = text;
            setTimeout(function () { if (msg && msg.textContent === text) msg.textContent = ''; }, 4000);
        }
        function activePlot() { return (G.PRiSM_state && G.PRiSM_state.activePlot) || 'bourdet'; }
        var png = container.querySelector('[data-cb-png]');
        if (png) png.addEventListener('click', function () {
            if (typeof G.PRiSM_exportPlotPNG !== 'function') { flash('PNG export is not available.', true); return; }
            var ok = G.PRiSM_exportPlotPNG(activePlot());
            flash(ok === false ? 'PNG export failed.' : 'PNG saved.', ok === false);
        });
        var pdf = container.querySelector('[data-cb-pdf]');
        if (pdf) pdf.addEventListener('click', function () {
            if (typeof G.PRiSM_exportReportPDF !== 'function') { flash('PDF export is not available.', true); return; }
            var r = G.PRiSM_exportReportPDF();
            flash(r ? 'Report opened for printing / saving as PDF.' : 'PDF export failed.', !r);
        });
        var pBtn = container.querySelector('[data-cb-plot]');
        if (pBtn) pBtn.addEventListener('click', function () {
            G.PRiSM_copyPlotToClipboard(activePlot()).then(function (r) {
                if (r.success) flash('Plot copied to the clipboard.');
                else flash('Copy plot failed: ' + (r.error || 'unknown'), true);
            });
        });
        var dBtn = container.querySelector('[data-cb-data]');
        if (dBtn) dBtn.addEventListener('click', function () {
            G.PRiSM_copyDataToClipboard('tsv').then(function (r) {
                if (r.success) flash('Data copied (' + r.length + ' characters).');
                else flash('Copy data failed: ' + (r.error || 'unknown'), true);
            });
        });
        var xBtn = container.querySelector('[data-cb-xml]');
        if (xBtn) xBtn.addEventListener('click', function () {
            try { G.PRiSM_exportXMLDownload(); flash('XML export downloaded.'); }
            catch (e) { flash('Export failed: ' + (e && e.message), true); }
        });
    };

    function _section(title, attr) {
        return '<div style="margin-top:10px;">' +
                 '<div style="font-size:11px; font-weight:600; color:var(--text2, #8b949e); text-transform:uppercase; ' +
                   'letter-spacing:.4px; margin-bottom:6px;">' + _esc(title) + '</div>' +
                 '<div ' + attr + '></div>' +
               '</div>';
    }

    G.PRiSM_renderPlotToolsPanel = function PRiSM_renderPlotToolsPanel(container) {
        if (!container || !_hasDoc) return;
        container.innerHTML =
            '<div class="prism-plottools" style="max-width:100%; box-sizing:border-box; color:var(--text, #e6edf3);">' +
                _section('Export & copy', 'data-pt-export') +
                _section('Overlays', 'data-pt-overlays') +
                _section('Compare two datasets', 'data-pt-diff') +
            '</div>';
        G.PRiSM_renderClipboardToolbar(container.querySelector('[data-pt-export]'));
        G.PRiSM_renderOverlayManager(container.querySelector('[data-pt-overlays]'));
        G.PRiSM_renderDiffPicker(container.querySelector('[data-pt-diff]'));
    };

    _registerTabPanel(2, {
        id: 'plottools',
        title: 'Plot tools',
        order: 40,
        collapsed: true,
        render: function (host) { G.PRiSM_renderPlotToolsPanel(host); }
    });

    function _refreshOverlayManagers() {
        if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
        var hosts;
        try { hosts = document.querySelectorAll('[data-pt-overlays]'); } catch (e) { return; }
        for (var i = 0; i < hosts.length; i++) { try { G.PRiSM_renderOverlayManager(hosts[i]); } catch (e2) { /* ignore */ } }
    }
    _on(G, 'prism:plot-changed', _refreshOverlayManagers);
    _on(G, 'prism:dataset-loaded', _refreshOverlayManagers);

    // ═══════════════════════════════════════════════════════════════

})();

// ─── END 21-plot-utilities ─────────────────────────────────────────────

