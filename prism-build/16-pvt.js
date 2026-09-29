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
    // === SELF-TEST ===
    //  1. Standing Bo at API=35, SG_g=0.65, Rs=500, T=180  → ~1.27 RB/STB
    //  2. DAK Z at SG_g=0.65, P=4000, T=180                → ~0.9 (sensible 0.7-1.1)
    //  3. ct on default oil reservoir                      → ~10e-6 to 30e-6 1/psi
    //  4. dimensionalize(homogeneous,{Cd:100,S:0,kh})      → finite k, C
    //  5. nondimensionalize(homogeneous,{k:100,h:50,S:0})  → Cd > 0
    //  6. m_p(4000, 180, 0.65)                             → > 0
    //  7. Bg(4000 psia, 180 °F, SG 0.65)                   → 0.750 ± 0.01 RB/Mscf
    //  8. m(p) table monotone, matches m_p
    //  9. setWell aliases + provenance + nullable clear; ct override wins
    (function PRiSM_pvtSelfTest() {
        var log = (typeof console !== 'undefined' && console.log)   ? console.log.bind(console)   : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];
        function _check(name, ok, info) { checks.push({ name: name, ok: !!ok, info: info }); }

        var savedPVT = G.PRiSM_pvt, savedDS = G.PRiSM_dataset, savedState = G.PRiSM_state;
        try {
            var Bo = Bo_standing(35, 0.65, 500, 180);
            _check('1. Standing Bo', Bo >= 1.20 && Bo <= 1.40, 'Bo=' + Bo.toFixed(4));

            var Tpc = Tpc_sutton(0.65), Ppc = Ppc_sutton(0.65);
            var Z = Z_dranchukAbouKassem((180 + 459.67) / Tpc, 4000 / Ppc);
            _check('2. DAK Z', Z >= 0.70 && Z <= 1.10, 'Z=' + Z.toFixed(4));

            G.PRiSM_pvt = _defaultPVT();
            G.PRiSM_pvt_compute();
            var ct_val = G.PRiSM_pvt._computed.ct;
            _check('3. ct on default oil reservoir', ct_val >= 5e-6 && ct_val <= 5e-5, 'ct=' + ct_val.toExponential(3));

            G.PRiSM_dataset = null;
            G.PRiSM_state = { model: 'homogeneous', params: { Cd: 100, S: 0 } };
            var dim = G.PRiSM_dimensionalize('homogeneous', { Cd: 100, S: 0, kh_md_ft: 5000 });
            _check('4. dimensionalize → finite C, k', dim && dim.ok && _isPos(dim.Cs) && _isPos(dim.k),
                   'k=' + (dim && dim.k) + ' C=' + (dim && dim.Cs));

            var nd = G.PRiSM_nondimensionalize('homogeneous', { k: 100, h: 50, S: 0, Cs: 0.01 });
            _check('5. nondimensionalize → Cd > 0', nd && nd.ok && _isPos(nd.Cd), 'Cd=' + (nd && nd.Cd));

            var mp = m_p(4000, 180, 0.65);
            _check('6. m(p) > 0', mp > 0 && isFinite(mp), 'm=' + mp);

            var bg = Bg(4000, 180, Z);
            _check('7. Bg = 0.750 RB/Mscf', Math.abs(bg - 0.750) <= 0.01, 'Bg=' + bg);

            var tbl = G.PRiSM_mpTable({ T_F: 180, SG_g: 0.65, pmax: 4800 });
            var mono = true;
            for (var i = 1; i < tbl.m.length; i++) if (!(tbl.m[i] > tbl.m[i - 1])) { mono = false; break; }
            var rel = Math.abs(tbl.mOf(4000) / mp - 1);
            var back = tbl.pOf(tbl.mOf(3123.4));
            _check('8. m(p) table monotone + accurate', mono && rel < 1e-3 && Math.abs(back - 3123.4) < 1e-3,
                   'rel=' + rel + ' back=' + back);

            G.PRiSM_pvt = _defaultPVT();
            G.PRiSM_setWell({ pi: 4200, B: 1.25, mu: 1.1, ct: 1.2e-5, testType: 'drawdown', tp: 24 }, { source: 'sample' });
            var s = G.PRiSM_pvt, eff = G.PRiSM_pvt_effective();
            var ok9 = s.p_res === 4200 && s.provenance.p_res === 'sample' && s.Bo === 1.25 && s.mu_o === 1.1 &&
                      eff.ct === 1.2e-5 && s._computed.ct === 1.2e-5 && s.testType === 'drawdown' && s.tp === 24;
            G.PRiSM_setWell({ tp: null });
            ok9 = ok9 && s.tp === null && s.provenance.tp === 'default';
            G.PRiSM_acceptWellDefaults(['h']);
            ok9 = ok9 && s.provenance.h === 'user' && s.h === 50;
            _check('9. setWell aliases/provenance/override', ok9, JSON.stringify(s.provenance));
        } catch (e) {
            _check('self-test threw', false, e && e.message);
        } finally {
            G.PRiSM_pvt = savedPVT; G.PRiSM_dataset = savedDS; G.PRiSM_state = savedState;
            if (savedPVT) { try { G.PRiSM_pvt_compute(); } catch (e2) { /* ignore */ } }
        }

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) err('PRiSM PVT self-test FAILED:', fails);
        else log('✓ PRiSM PVT self-test passed (' + checks.length + ' checks).');
        G.PRiSM_pvt_selfTestResults = checks;
    })();

})();
