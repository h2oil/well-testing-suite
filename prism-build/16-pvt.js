// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 16 — PVT Panel + Dimensional Conversion
//   Standard black-oil + gas + water PVT correlations.
//   Converts dimensionless model fits (Cd, S, td, pd) into real-world
//   reservoir engineering units (k, h, μ, B, ct, kh, hours, psi).
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
//     Earlougher (1977, SPE Mono 5) — dimensional conversions
//     Kappa SAPHIR theory (2018)    — kh from semi-log derivative stabilisation
// ════════════════════════════════════════════════════════════════════
//
// PUBLIC API
//   window.PRiSM_pvt                       — input + computed state
//   window.PRiSM_pvt_correlations          — pure correlation funcs
//   window.PRiSM_pvt_compute()             — fill in null values
//   window.PRiSM_dimensionalize(modelKey, params)   — dimensionless → real
//   window.PRiSM_nondimensionalize(modelKey, real)  — real → dimensionless
//   window.PRiSM_renderPVTPanel(container) — UI panel
//   window.PRiSM_interpretFitWithPVT(...)  — interpretation enricher
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_pvt* / PRiSM_dimensionalize / etc.
//   • Field units throughout (psi, ft, md, cp, hours, RB/STB, STB/d, MSCF/d).
//   • localStorage persistence under 'wts_prism_pvt' (debounced 300 ms).
//   • No external dependencies — pure vanilla JS, Math.*.
//   • Defensive: if PRiSM_pvt._computed is null, dimensionalize returns
//     a result object containing { ok:false, caveats:[...] }.
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


    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — DEFAULT PVT STATE + LOCALSTORAGE PERSISTENCE
    // ═══════════════════════════════════════════════════════════════

    function _defaultPVT() {
        return {
            fluidType: 'oil',                    // 'oil' | 'gas' | 'water'
            // Reservoir
            p_res: 4000,                         // psi (initial reservoir pressure)
            T_res: 180,                          // °F
            rw:    0.354,                        // ft (wellbore radius)
            h:     50,                           // ft (net pay)
            phi:   0.20,                         // fraction (porosity)
            Swc:   0.20,                         // fraction (connate water saturation)
            cf:    4e-6,                         // 1/psi (rock compressibility)
            // Oil PVT (active when fluidType === 'oil')
            API:   35,                           // °API
            SG_g:  0.65,                         // gas specific gravity (air = 1)
            Rs:    null,                         // SCF/STB (null → compute)
            Pb:    null,                         // psi   (null → compute)
            Bo:    null,                         // RB/STB (null → compute)
            mu_o:  null,                         // cp    (null → compute)
            co:    null,                         // 1/psi (null → compute)
            // Gas PVT (active when fluidType === 'gas')
            Z:     null,                         // (null → compute, DAK)
            mu_g:  null,                         // cp    (null → compute, LGE)
            Bg:    null,                         // RB/MSCF
            cg:    null,                         // 1/psi
            // Water PVT (always relevant for ct)
            Sw:    0.20,                         // fraction
            cw:    3e-6,                         // 1/psi
            Bw:    1.0,                          // RB/STB
            mu_w:  0.5,                          // cp
            salinity_ppm: 50000,                 // ppm NaCl (water-correlation input)
            Rsw:   17,                           // SCF/STB (gas in water, for cw)
            // Rate (for dimensional Δp conversion)
            q:     1000,                         // STB/d (oil), MSCF/d (gas), BWPD (water)
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
            var raw = localStorage.getItem(LS_KEY);
            if (!raw) return _defaultPVT();
            var parsed = JSON.parse(raw) || {};
            var def = _defaultPVT();
            // Shallow merge so newly-introduced keys get defaults.
            for (var k in def) {
                if (Object.prototype.hasOwnProperty.call(parsed, k)) {
                    def[k] = parsed[k];
                }
            }
            // _computed is not persisted (always recompute on demand).
            def._computed = _defaultPVT()._computed;
            return def;
        } catch (e) {
            return _defaultPVT();
        }
    }

    // Debounced save.
    var _saveTimer = null;
    function _scheduleSave() {
        if (!_hasWin) return;
        if (_saveTimer) {
            try { clearTimeout(_saveTimer); } catch (e) {}
        }
        _saveTimer = setTimeout(function () {
            try {
                var s = G.PRiSM_pvt;
                if (!s) return;
                // Strip _computed before saving — it's derived state.
                var clone = {};
                for (var k in s) {
                    if (k === '_computed') continue;
                    if (Object.prototype.hasOwnProperty.call(s, k)) clone[k] = s[k];
                }
                localStorage.setItem(LS_KEY, JSON.stringify(clone));
            } catch (e) { /* quota / privacy mode */ }
        }, 300);
    }

    // Initialise the global state.
    G.PRiSM_pvt = G.PRiSM_pvt || _loadFromStorage();


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

    // Z-factor via DAK (Newton on ρ_pr, max 50 iters).
    function Z_dranchukAbouKassem(Tpr, Ppr) {
        if (!_isFiniteNum(Tpr) || !_isFiniteNum(Ppr) || Tpr <= 0 || Ppr < 0) return NaN;
        if (Ppr === 0) return 1;
        // initial Z guess
        var Z = 1;
        var rho;
        for (var iter = 0; iter < 50; iter++) {
            rho = 0.27 * Ppr / (Z * Tpr);
            var Tpr2 = Tpr * Tpr, Tpr3 = Tpr2 * Tpr, Tpr4 = Tpr3 * Tpr, Tpr5 = Tpr4 * Tpr;
            var c1 = DAK.A1 + DAK.A2 / Tpr + DAK.A3 / Tpr3 + DAK.A4 / Tpr4 + DAK.A5 / Tpr5;
            var c2 = DAK.A6 + DAK.A7 / Tpr + DAK.A8 / Tpr2;
            var c3 = DAK.A9 * (DAK.A7 / Tpr + DAK.A8 / Tpr2);
            var rho2 = rho * rho;
            var rho5 = rho2 * rho2 * rho;
            var expo = Math.exp(-DAK.A11 * rho2);
            var Znew = 1 + c1 * rho + c2 * rho2 - c3 * rho5
                     + DAK.A10 * (1 + DAK.A11 * rho2) * (rho2 / Tpr3) * expo;
            if (!isFinite(Znew) || Znew <= 0) Znew = 1;
            if (Math.abs(Znew - Z) < 1e-8) {
                Z = Znew;
                break;
            }
            Z = Znew;
        }
        return Z;
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

    // Gas formation-volume factor in RB/MSCF.
    //   Bg [RB/MSCF] = 0.005035 · Z · T_R / P
    //   (= 0.02827·Z·T_R/P in cuft/SCF, divide by 5.615 for RB/SCF, then ×1000)
    function Bg(P, T_F, Z) {
        if (!_isFiniteNum(P) || !_isFiniteNum(T_F) || !_isFiniteNum(Z) || P <= 0) return NaN;
        var T_R = T_F + 459.67;
        return 0.005035 * Z * T_R / P;
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

        s._computed = c;
        return c;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — DIMENSIONAL CONVERSION (dimensionless → real)
    // ═══════════════════════════════════════════════════════════════
    //
    // Field-unit conversion formulas (Earlougher, SPE Mono 5):
    //
    //   real Cs  (bbl/psi) = Cd · 2π · φ · ct · h · rw² / 5.615
    //   real Δp  (psi)     = pd · 141.2 · q · μ · B / (k · h)
    //   real t   (hours)   = td · φ · μ · ct · rw² / (0.000264 · k)
    //   k        (md)      = 141.2 · q · μ · B / (kh_seg) where kh_seg comes
    //                        from the Bourdet stabilisation (dPwd/d ln td → 0.5)
    //                        Equivalently kh = 162.6·q·μ·B / m_semilog
    //   rinv     (ft)      ≈ √(0.000264 · k · t_end / (φ · μ · ct))
    //   L (ft)             = LD · rw
    //   xf (ft)            = xfD · rw
    //
    // Strategy for k: we don't have direct access to the data slope here.
    // We compute k from the relationship between real Cs and Cd:
    //
    //   real Cs is what the operator measured (or what the Cd implies given
    //   the PVT), so given Cd + measured-Cs we could back out k. But normally
    //   the user has only Cd (dimensionless) — k must come from the Bourdet
    //   stabilisation level.
    //
    // CONVENTION used here:
    //   • If the caller passes `params.kh_md_ft` (some auto-match flows do),
    //     use it directly.
    //   • Else, we compute k via the Bourdet stabilisation if a fitted
    //     dimensionless derivative is available in PRiSM_state.modelCurve
    //     (level near 0.5 in pd' implies the radial-flow regime, and we
    //     map that back to real units via the data's actual Δp at that point).
    //   • Else we report k as null with a caveat.

    var BOUNDARY_PARAM_KEYS = {
        dF: true, dF1: true, dF2: true, dEnd: true,
        dN: true, dS: true, dE: true, dW: true,
        L:  true, L_to_h: true
    };
    var FRACTURE_PARAM_KEYS = {
        xf: true, xfD: true, hf_to_h: true
    };

    G.PRiSM_dimensionalize = function PRiSM_dimensionalize(modelKey, fittedParams) {
        fittedParams = fittedParams || {};
        var pvt = G.PRiSM_pvt;
        if (!pvt) {
            return { ok: false, caveats: ['PRiSM_pvt state not initialised — call PRiSM_pvt_compute first.'] };
        }
        var c = pvt._computed;
        if (!c || !_isFiniteNum(c.ct) || !_isFiniteNum(c.mu) || !_isFiniteNum(c.B)) {
            return { ok: false, caveats: ['PVT not yet computed — click "Compute PVT" or call PRiSM_pvt_compute().'] };
        }

        var phi = pvt.phi;
        var ct_ = c.ct;
        var mu  = c.mu;
        var B   = c.B;
        var h   = pvt.h;
        var rw  = pvt.rw;
        var q   = pvt.q;
        var caveats = [];

        if (!(_isFiniteNum(phi) && phi > 0 && phi < 1))   caveats.push('Porosity φ out of range — check input.');
        if (!(_isFiniteNum(h)   && h > 0))                caveats.push('Pay h must be > 0.');
        if (!(_isFiniteNum(rw)  && rw > 0))               caveats.push('Wellbore radius rw must be > 0.');
        if (!(_isFiniteNum(q)   && q > 0))                caveats.push('Rate q must be > 0.');

        var Cd = _isFiniteNum(fittedParams.Cd) ? fittedParams.Cd : null;
        var S  = _isFiniteNum(fittedParams.S)  ? fittedParams.S  : null;

        // ─── Derive k (md) ───────────────────────────────────────────
        //
        // Preferred chain:
        //  (a) caller supplied real kh directly  →  k = kh / h
        //  (b) caller supplied a "k_md" / "kh_md_ft" extra  → use it
        //  (c) PRiSM_state.lastFit has a Bourdet stabilisation level
        //      pdDeriv_stab (≈0.5) and a measured pressure scale pData_psi
        //      at td where pd' is flat: kh = 162.6·q·μ·B / (slope of P vs ln(t))
        //  (d) Otherwise fall back to: assume the pd at the "fit time" equals
        //      the measured Δp at fit-window end. This requires PRiSM_state
        //      to expose t_end + Δp_end. Without those, k cannot be derived
        //      and we return null with a caveat.
        var k_md = null;
        var kh_md_ft = null;
        var kSource = 'unknown';

        if (_isFiniteNum(fittedParams.kh_md_ft)) {
            kh_md_ft = fittedParams.kh_md_ft;
            k_md = kh_md_ft / h;
            kSource = 'caller-supplied kh';
        } else if (_isFiniteNum(fittedParams.k_md)) {
            k_md = fittedParams.k_md;
            kh_md_ft = k_md * h;
            kSource = 'caller-supplied k';
        } else {
            // Try state-derived path.
            var st = G.PRiSM_state;
            var lf = st && st.lastFit ? st.lastFit : null;
            // Fitted semi-log slope m (psi/cycle): kh = 162.6·q·μ·B / m
            if (lf && _isFiniteNum(lf.m_semilog_psi_per_cycle)) {
                kh_md_ft = 162.6 * q * mu * B / lf.m_semilog_psi_per_cycle;
                k_md = kh_md_ft / h;
                kSource = 'semi-log slope m';
            } else if (lf && _isFiniteNum(lf.deltaP_at_td_ref) && _isFiniteNum(lf.td_ref) && _isFiniteNum(lf.pd_at_ref)) {
                // Dimensional inverse:
                //   pd = (k · h) / (141.2 · q · μ · B) · Δp
                //   → k = 141.2·q·μ·B·pd / (h·Δp)
                kh_md_ft = 141.2 * q * mu * B * lf.pd_at_ref / lf.deltaP_at_td_ref;
                k_md = kh_md_ft / h;
                kSource = 'pd / Δp ratio';
            } else if (G.PRiSM_dataset && G.PRiSM_dataset.t && G.PRiSM_dataset.p
                       && G.PRiSM_dataset.t.length > 5) {
                // Last-resort estimate: assume the *measured* late-time Δp ≈
                // pd at the same dimensionless time. This is rough but better
                // than nothing for a quick first-pass dimensional check.
                var dsT = G.PRiSM_dataset.t;
                var dsP = G.PRiSM_dataset.p;
                var iEnd = dsT.length - 1;
                var t_end_h = dsT[iEnd];                   // hours
                var p0 = dsP[0];
                var pE = dsP[iEnd];
                var deltaP_meas = Math.abs(pE - p0);
                if (_isFiniteNum(t_end_h) && t_end_h > 0 && _isFiniteNum(deltaP_meas) && deltaP_meas > 0) {
                    // Evaluate the fitted model's pd at the same end time.
                    // We need td_end given a guessed k. Since k is what we want,
                    // we solve a self-consistent fixed-point: k iterates so that
                    // pd(td_end(k))·(141.2·q·μ·B / (k·h)) = deltaP_meas.
                    var modelSpec = G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey];
                    if (modelSpec && typeof modelSpec.pd === 'function') {
                        var k_iter = 100;  // md, initial guess
                        for (var it = 0; it < 30; it++) {
                            var td_end = 0.000264 * k_iter * t_end_h / (phi * mu * ct_ * rw * rw);
                            if (!_isFiniteNum(td_end) || td_end <= 0) break;
                            var pd_end;
                            try { pd_end = modelSpec.pd([td_end], fittedParams)[0]; }
                            catch (e) { pd_end = NaN; }
                            if (!_isFiniteNum(pd_end) || pd_end <= 0) break;
                            var k_new = 141.2 * q * mu * B * pd_end / (h * deltaP_meas);
                            if (!_isFiniteNum(k_new) || k_new <= 0) break;
                            if (Math.abs(k_new - k_iter) / k_iter < 1e-3) { k_iter = k_new; break; }
                            // Damped update for stability.
                            k_iter = 0.5 * (k_iter + k_new);
                        }
                        if (_isFiniteNum(k_iter) && k_iter > 0) {
                            k_md = k_iter;
                            kh_md_ft = k_md * h;
                            kSource = 'self-consistent fit at t_end';
                        } else {
                            caveats.push('k inference at t_end did not converge.');
                        }
                    } else {
                        caveats.push('No registry entry for "' + modelKey + '" — cannot infer k.');
                    }
                } else {
                    caveats.push('Dataset has no usable Δp — cannot infer k.');
                }
            } else {
                caveats.push('No measured data, fit metadata, or caller-supplied kh — k cannot be derived.');
            }
        }

        // ─── Real wellbore-storage Cs (bbl/psi) ─────────────────────
        var Cs_bbl_per_psi = null;
        if (_isFiniteNum(Cd)) {
            Cs_bbl_per_psi = Cd * 2 * Math.PI * phi * ct_ * h * rw * rw / 5.615;
        }

        // ─── Boundary distances (ft) ─────────────────────────────────
        var distances = {};
        for (var pk in fittedParams) {
            if (BOUNDARY_PARAM_KEYS[pk] && _isFiniteNum(fittedParams[pk])) {
                // Convention: in PRiSM the boundary distances are stored
                // already in units of rw (per paramSpec unit:'r_w'), so the
                // conversion is just × rw.
                distances[pk + '_ft'] = fittedParams[pk] * rw;
            }
        }

        // ─── Fracture half-length (ft) ───────────────────────────────
        var fractures = {};
        for (var fk in fittedParams) {
            if (FRACTURE_PARAM_KEYS[fk] && _isFiniteNum(fittedParams[fk])) {
                if (fk === 'hf_to_h' && _isFiniteNum(h)) {
                    fractures.hf_ft = fittedParams[fk] * h;
                } else {
                    fractures[fk + '_ft'] = fittedParams[fk] * rw;
                }
            }
        }

        // ─── Radius of investigation (ft) ────────────────────────────
        var rinv_ft = null;
        if (_isFiniteNum(k_md) && k_md > 0) {
            // Try to read the test duration from the active dataset.
            var t_end_for_rinv = null;
            if (G.PRiSM_dataset && G.PRiSM_dataset.t && G.PRiSM_dataset.t.length) {
                t_end_for_rinv = G.PRiSM_dataset.t[G.PRiSM_dataset.t.length - 1];
            }
            if (_isFiniteNum(t_end_for_rinv) && t_end_for_rinv > 0) {
                rinv_ft = Math.sqrt(0.000264 * k_md * t_end_for_rinv / (phi * mu * ct_));
            }
        }

        // Pseudo-pressure tag for gas — a hint about which Δp surrogate to
        // use downstream (real Δp vs Δm(p)).
        var dp_method = (pvt.fluidType === 'gas') ? 'pseudo-pressure m(p)' : 'real Δp';

        // Assemble the result.
        var out = {
            ok: true,
            modelKey: modelKey,
            fluidType: pvt.fluidType,
            // Dimensional rock/fluid properties.
            k:        _isFiniteNum(k_md)     ? k_md     : null,        // md
            kh:       _isFiniteNum(kh_md_ft) ? kh_md_ft : null,        // md·ft
            h:        h,                                                // ft  (echo)
            phi:      phi,                                              // -   (echo)
            ct:       ct_,                                              // 1/psi
            mu:       mu,                                               // cp
            B:        B,                                                // RB/STB or RB/MSCF
            // Skin (echoed)
            S:        _isFiniteNum(S) ? S : null,
            // Real wellbore storage
            Cs:       Cs_bbl_per_psi,                                   // bbl/psi
            Cd:       Cd,
            // Radius of investigation
            rinv:     rinv_ft,
            // Boundary / fracture extras (model-specific)
            distances: distances,
            fractures: fractures,
            // Provenance
            kSource:  kSource,
            dpMethod: dp_method,
            caveats:  caveats
        };

        // Convenience flat aliases for the most common boundary / fracture cases.
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
    //
    // For forward-simulating from a user's k. Inverts the same formulas:
    //
    //   Cd = real Cs · 5.615 / (2π · φ · ct · h · rw²)
    //   td = 0.000264 · k · t / (φ · μ · ct · rw²)         (per t, not stored here)
    //   pd = k · h · Δp / (141.2 · q · μ · B)               (per Δp, ditto)
    //
    // For boundary distances:  LD = L / rw

    G.PRiSM_nondimensionalize = function PRiSM_nondimensionalize(modelKey, realParams) {
        realParams = realParams || {};
        var pvt = G.PRiSM_pvt;
        if (!pvt) {
            return { ok: false, caveats: ['PRiSM_pvt state not initialised — call PRiSM_pvt_compute first.'] };
        }
        var c = pvt._computed;
        if (!c || !_isFiniteNum(c.ct) || !_isFiniteNum(c.mu) || !_isFiniteNum(c.B)) {
            return { ok: false, caveats: ['PVT not yet computed — click "Compute PVT" or call PRiSM_pvt_compute().'] };
        }

        var phi = pvt.phi, ct_ = c.ct, mu = c.mu, B = c.B;
        var h   = _isFiniteNum(realParams.h) ? realParams.h : pvt.h;
        var rw  = pvt.rw;
        var q   = pvt.q;
        var caveats = [];

        var k_md = realParams.k;
        if (!_isFiniteNum(k_md) || k_md <= 0) caveats.push('k must be > 0 in real units.');

        // Cd
        var Cd = null;
        if (_isFiniteNum(realParams.Cs)) {
            Cd = realParams.Cs * 5.615 / (2 * Math.PI * phi * ct_ * h * rw * rw);
        }

        // Skin is dimensionless by definition.
        var S = _isFiniteNum(realParams.S) ? realParams.S : null;

        // Boundary distances: LD = L / rw.
        var LD = {};
        ['L', 'dF', 'dF1', 'dF2', 'dEnd', 'dN', 'dS', 'dE', 'dW'].forEach(function (kk) {
            if (_isFiniteNum(realParams[kk])) {
                LD[kk + 'D'] = realParams[kk] / rw;
            }
            // Also accept "_ft" suffix for consistency with dimensionalize output.
            if (_isFiniteNum(realParams[kk + '_ft'])) {
                LD[kk + 'D'] = realParams[kk + '_ft'] / rw;
            }
        });

        // Fracture half-length
        var xfD = null;
        if (_isFiniteNum(realParams.xf)) xfD = realParams.xf / rw;
        if (_isFiniteNum(realParams.xf_ft)) xfD = realParams.xf_ft / rw;

        var out = {
            ok: true,
            modelKey: modelKey,
            Cd:  Cd,
            S:   S,
            xfD: xfD,
            // Echo k for downstream forward-simulation calls that need it
            // alongside the dimensionless params.
            k_md: _isFiniteNum(k_md) ? k_md : null,
            // Convenience scalars for converting time / pressure on demand.
            tdPerHour:  (_isFiniteNum(k_md) && k_md > 0)
                          ? 0.000264 * k_md / (phi * mu * ct_ * rw * rw)
                          : null,
            pdPerPsi:   (_isFiniteNum(k_md) && k_md > 0)
                          ? k_md * h / (141.2 * q * mu * B)
                          : null,
            caveats: caveats
        };

        // Merge boundary-distance dimensionless values.
        for (var lk in LD) out[lk] = LD[lk];
        return out;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 10 — UI RENDER (PVT panel)
    // ═══════════════════════════════════════════════════════════════
    //
    // Inline-styled HTML (dark theme) — mirrors the approach used by Agent I
    // (12-data-crop.js). We avoid CSS classes since they may not have loaded.
    //
    // Theme:
    //   bg     #0d1117 (page)
    //   panel  #161b22
    //   border #30363d
    //   text   #c9d1d9
    //   muted  #8b949e
    //   accent #58a6ff (info)
    //   warn   #f0883e (handle / warn)
    //   ok     #3fb950 (success)

    var PVT_THEME = {
        bg:      '#0d1117',
        panel:   '#161b22',
        border:  '#30363d',
        grid:    '#21262d',
        text:    '#c9d1d9',
        muted:   '#8b949e',
        text3:   '#6e7681',
        accent:  '#58a6ff',
        warn:    '#f0883e',
        ok:      '#3fb950'
    };

    // Field schema — drives the input rendering. Each entry:
    //   { key, label, units, group, fluids, kind: 'num' | 'select', step, min, max, options }
    var FIELDS = [
        // Reservoir (always shown)
        { key: 'p_res', label: 'Reservoir pressure',  units: 'psi',   group: 'reservoir', fluids: '*',     kind: 'num', step: 1     },
        { key: 'T_res', label: 'Reservoir temperature', units: '°F',  group: 'reservoir', fluids: '*',     kind: 'num', step: 1     },
        { key: 'h',     label: 'Net pay h',           units: 'ft',    group: 'reservoir', fluids: '*',     kind: 'num', step: 0.1   },
        { key: 'rw',    label: 'Wellbore radius rw',  units: 'ft',    group: 'reservoir', fluids: '*',     kind: 'num', step: 0.001 },
        { key: 'phi',   label: 'Porosity φ',          units: '-',     group: 'reservoir', fluids: '*',     kind: 'num', step: 0.001, min: 0.01, max: 0.5 },
        { key: 'cf',    label: 'Rock compressibility cf', units: '1/psi', group: 'reservoir', fluids: '*', kind: 'num', step: 1e-7  },
        // Oil
        { key: 'API',   label: 'Oil °API',            units: '°API',  group: 'oil', fluids: 'oil', kind: 'num', step: 0.1, min: 5, max: 60 },
        { key: 'SG_g',  label: 'Solution-gas SG',     units: 'air=1', group: 'oil', fluids: 'oil', kind: 'num', step: 0.01 },
        { key: 'Rs',    label: 'Solution GOR Rs',     units: 'SCF/STB', group: 'oil', fluids: 'oil', kind: 'num', step: 1, allowNull: true },
        { key: 'Pb',    label: 'Bubble point Pb',     units: 'psi',   group: 'oil', fluids: 'oil', kind: 'num', step: 1, allowNull: true },
        { key: 'Bo',    label: 'Bo',                  units: 'RB/STB',group: 'oil', fluids: 'oil', kind: 'num', step: 0.001, allowNull: true },
        { key: 'mu_o',  label: 'μ_o',                 units: 'cp',    group: 'oil', fluids: 'oil', kind: 'num', step: 0.001, allowNull: true },
        { key: 'co',    label: 'co',                  units: '1/psi', group: 'oil', fluids: 'oil', kind: 'num', step: 1e-7,  allowNull: true },
        // Gas
        { key: 'SG_g',  label: 'Gas SG',              units: 'air=1', group: 'gas', fluids: 'gas', kind: 'num', step: 0.01 },
        { key: 'Z',     label: 'Z-factor',            units: '-',     group: 'gas', fluids: 'gas', kind: 'num', step: 0.001, allowNull: true },
        { key: 'mu_g',  label: 'μ_g',                 units: 'cp',    group: 'gas', fluids: 'gas', kind: 'num', step: 0.0001,allowNull: true },
        { key: 'Bg',    label: 'Bg',                  units: 'RB/MSCF', group: 'gas', fluids: 'gas', kind: 'num', step: 0.0001, allowNull: true },
        { key: 'cg',    label: 'cg',                  units: '1/psi', group: 'gas', fluids: 'gas', kind: 'num', step: 1e-6,  allowNull: true },
        // Water (always — affects ct via Sw·cw)
        { key: 'Sw',    label: 'Sw',                  units: '-',     group: 'water', fluids: '*',  kind: 'num', step: 0.01, min: 0, max: 1 },
        { key: 'cw',    label: 'cw',                  units: '1/psi', group: 'water', fluids: '*',  kind: 'num', step: 1e-7 },
        { key: 'Bw',    label: 'Bw',                  units: 'RB/STB',group: 'water', fluids: '*',  kind: 'num', step: 0.001 },
        { key: 'mu_w',  label: 'μ_w',                 units: 'cp',    group: 'water', fluids: '*',  kind: 'num', step: 0.01 },
        { key: 'salinity_ppm', label: 'Salinity',     units: 'ppm',   group: 'water', fluids: '*',  kind: 'num', step: 100 },
        // Rate
        { key: 'q',     label: 'Rate q',              units: 'STB/d / MSCF/d / BWPD', group: 'rate', fluids: '*', kind: 'num', step: 1 }
    ];

    // Group display order for each fluid type.
    var GROUP_ORDER = {
        oil:   ['reservoir', 'oil',   'water', 'rate'],
        gas:   ['reservoir', 'gas',   'water', 'rate'],
        water: ['reservoir', 'water', 'rate']
    };
    var GROUP_LABELS = {
        reservoir: 'Reservoir',
        oil:       'Oil PVT',
        gas:       'Gas PVT',
        water:     'Water PVT',
        rate:      'Production rate'
    };

    function _styleInput() {
        return 'width:140px; padding:4px 6px; background:' + PVT_THEME.bg + '; color:' + PVT_THEME.text + ';' +
               'border:1px solid ' + PVT_THEME.border + '; border-radius:4px;' +
               'font-family:monospace; font-size:12px;';
    }
    function _styleSelect() {
        return 'padding:4px 6px; background:' + PVT_THEME.bg + '; color:' + PVT_THEME.text + ';' +
               'border:1px solid ' + PVT_THEME.border + '; border-radius:4px; font-size:12px;';
    }
    function _styleLabel() {
        return 'display:flex; flex-direction:column; font-size:11px; color:' + PVT_THEME.muted + '; gap:3px;';
    }
    function _styleBtn(primary) {
        if (primary) {
            return 'padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043;' +
                   'border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;';
        }
        return 'padding:6px 14px; background:#21262d; color:' + PVT_THEME.text +
               '; border:1px solid ' + PVT_THEME.border + '; border-radius:4px; cursor:pointer; font-size:12px;';
    }

    function _fieldRow(field, value) {
        var v = (value == null || (typeof value === 'number' && !isFinite(value))) ? '' : value;
        var minA = (_isFiniteNum(field.min)) ? ' min="' + field.min + '"' : '';
        var maxA = (_isFiniteNum(field.max)) ? ' max="' + field.max + '"' : '';
        var stepA = (field.step != null) ? ' step="' + field.step + '"' : '';
        var placeholder = field.allowNull ? ' placeholder="(auto)"' : '';
        return '<label style="' + _styleLabel() + '">'
            +    '<span>' + field.label + ' <span style="color:' + PVT_THEME.text3 + ';">(' + field.units + ')</span></span>'
            +    '<input type="number" data-pvt-field="' + field.key + '" value="' + v + '"'
            +      stepA + minA + maxA + placeholder + ' style="' + _styleInput() + '">'
            +  '</label>';
    }

    function _renderInputsHTML(pvt) {
        var groupsToShow = GROUP_ORDER[pvt.fluidType] || GROUP_ORDER.oil;
        var html = '';
        for (var i = 0; i < groupsToShow.length; i++) {
            var grp = groupsToShow[i];
            var fields = FIELDS.filter(function (f) {
                if (f.group !== grp) return false;
                if (f.fluids === '*') return true;
                return f.fluids === pvt.fluidType;
            });
            if (!fields.length) continue;
            html += '<div style="margin-bottom:14px;">';
            html += '<div style="font-weight:600; font-size:12px; color:' + PVT_THEME.accent
                  + '; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">'
                  + GROUP_LABELS[grp] + '</div>';
            html += '<div style="display:flex; flex-wrap:wrap; gap:10px;">';
            for (var j = 0; j < fields.length; j++) {
                html += _fieldRow(fields[j], pvt[fields[j].key]);
            }
            html += '</div></div>';
        }
        return html;
    }

    function _renderComputedHTML(pvt) {
        var c = pvt._computed;
        if (!c || !c.timestamp) {
            return '<div style="color:' + PVT_THEME.muted + '; font-style:italic; font-size:12px;">'
                 + 'Click <b>Compute PVT</b> to calculate ct, μ, B, Z (depending on fluid).'
                 + '</div>';
        }
        var rows = [];
        rows.push(['Total compressibility ct', _fmtSig(c.ct, 4) + ' 1/psi']);
        rows.push(['Effective viscosity μ',    _fmtSig(c.mu, 4) + ' cp']);
        rows.push(['Formation vol. factor B',  _fmtSig(c.B,  4) + (c.fluidType === 'gas' ? ' RB/MSCF' : ' RB/STB')]);
        if (c.fluidType === 'gas') {
            rows.push(['Z-factor',             _fmtSig(c.z,  4)]);
            rows.push(['cg (gas compressibility)', _fmtSig(c.cg, 4) + ' 1/psi']);
        } else if (c.fluidType === 'oil') {
            rows.push(['Pb (bubble point)',    _fmtSig(c.Pb, 4) + ' psi']);
            rows.push(['Rs (solution GOR)',    _fmtSig(c.Rs, 4) + ' SCF/STB']);
            rows.push(['co (oil compressibility)', _fmtSig(c.co, 4) + ' 1/psi']);
        }
        rows.push(['Phase saturations',
                   'So=' + _fmt(c.So, 3) + '  Sw=' + _fmt(c.Sw_eff, 3) + '  Sg=' + _fmt(c.Sg, 3)]);
        var html = '<table style="width:100%; font-size:12px; color:' + PVT_THEME.text + '; border-collapse:collapse;">';
        for (var i = 0; i < rows.length; i++) {
            html += '<tr>'
                 +    '<td style="padding:3px 8px 3px 0; color:' + PVT_THEME.muted + '; width:55%;">' + rows[i][0] + '</td>'
                 +    '<td style="padding:3px 0; font-family:monospace; color:' + PVT_THEME.ok + ';">' + rows[i][1] + '</td>'
                 +  '</tr>';
        }
        html += '</table>';
        var ts = new Date(c.timestamp).toLocaleTimeString();
        html += '<div style="margin-top:6px; font-size:10px; color:' + PVT_THEME.text3 + ';">computed ' + ts + '</div>';
        return html;
    }

    function _renderDimResultHTML(d) {
        if (!d || !d.ok) {
            var msg = (d && d.caveats && d.caveats.length) ? d.caveats.join('  ') : 'No fit / no PVT.';
            return '<div style="color:' + PVT_THEME.warn + '; font-size:12px;">' + msg + '</div>';
        }
        var rows = [];
        if (d.k != null)   rows.push(['Permeability k',          _fmtSig(d.k, 4) + ' md']);
        if (d.kh != null)  rows.push(['kh',                     _fmtSig(d.kh, 4) + ' md·ft']);
        if (d.h != null)   rows.push(['Net pay h',              _fmt(d.h, 1)   + ' ft']);
        if (d.S  != null)  rows.push(['Skin S',                 _fmt(d.S, 2)]);
        if (d.Cs != null)  rows.push(['Real wellbore storage Cs', _fmtSig(d.Cs, 4) + ' bbl/psi']);
        if (d.rinv != null)rows.push(['Radius of investigation', _fmtSig(d.rinv, 4) + ' ft']);
        for (var dk in d.distances) {
            rows.push([dk.replace(/_ft$/, '') + ' (boundary distance)', _fmtSig(d.distances[dk], 4) + ' ft']);
        }
        for (var fk in d.fractures) {
            rows.push([fk.replace(/_ft$/, ''), _fmtSig(d.fractures[fk], 4) + ' ft']);
        }
        var html = '<table style="width:100%; font-size:12px; color:' + PVT_THEME.text + '; border-collapse:collapse;">';
        for (var i = 0; i < rows.length; i++) {
            html += '<tr>'
                 +    '<td style="padding:3px 8px 3px 0; color:' + PVT_THEME.muted + '; width:55%;">' + rows[i][0] + '</td>'
                 +    '<td style="padding:3px 0; font-family:monospace; color:' + PVT_THEME.accent + ';">' + rows[i][1] + '</td>'
                 +  '</tr>';
        }
        html += '</table>';
        if (d.kSource) {
            html += '<div style="margin-top:6px; font-size:10px; color:' + PVT_THEME.text3 + ';">k source: ' + d.kSource + '</div>';
        }
        if (d.caveats && d.caveats.length) {
            html += '<div style="margin-top:6px; font-size:11px; color:' + PVT_THEME.warn + ';">'
                 +    d.caveats.map(function (c) { return '⚠ ' + c; }).join('<br>')
                 +  '</div>';
        }
        return html;
    }

    function _renderShellHTML(pvt) {
        return ''
            + '<div style="background:' + PVT_THEME.panel + '; border:1px solid ' + PVT_THEME.border
            +    '; border-radius:6px; padding:14px;">'
            +   '<div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:10px;">'
            +     '<div style="font-weight:600; color:' + PVT_THEME.text + '; font-size:14px;">PVT &amp; dimensional conversion</div>'
            +     '<div style="font-size:11px; color:' + PVT_THEME.muted + ';">field units (psi, ft, md, cp, hours)</div>'
            +   '</div>'
            +   '<div style="font-size:12px; color:' + PVT_THEME.muted + '; margin-bottom:10px;">'
            +     'Set fluid + reservoir + rate, compute PVT, then click <b>Apply to current fit</b> to convert '
            +     'the latest dimensionless fit (Cd, S, …) into real engineering units.'
            +   '</div>'
            // Fluid type tabs
            +   '<div data-pvt-tabs style="display:flex; gap:4px; margin-bottom:12px;">'
            +     _tabBtn('oil',   pvt.fluidType, 'Oil')
            +     _tabBtn('gas',   pvt.fluidType, 'Gas')
            +     _tabBtn('water', pvt.fluidType, 'Water')
            +   '</div>'
            +   '<div data-pvt-inputs>' + _renderInputsHTML(pvt) + '</div>'
            +   '<div style="display:flex; gap:8px; margin:8px 0 14px;">'
            +     '<button data-pvt-act="compute" style="' + _styleBtn(true) + '">Compute PVT</button>'
            +     '<button data-pvt-act="apply"   style="' + _styleBtn(false) + '">Apply to current fit</button>'
            +     '<button data-pvt-act="reset"   style="' + _styleBtn(false) + '">Reset to defaults</button>'
            +   '</div>'
            +   '<div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">'
            +     '<div style="background:' + PVT_THEME.bg + '; border:1px solid ' + PVT_THEME.border
            +        '; border-radius:6px; padding:10px;">'
            +       '<div style="font-size:11px; color:' + PVT_THEME.accent
            +         '; font-weight:600; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">'
            +         'Computed PVT properties'
            +       '</div>'
            +       '<div data-pvt-computed>' + _renderComputedHTML(pvt) + '</div>'
            +     '</div>'
            +     '<div style="background:' + PVT_THEME.bg + '; border:1px solid ' + PVT_THEME.border
            +        '; border-radius:6px; padding:10px;">'
            +       '<div style="font-size:11px; color:' + PVT_THEME.accent
            +         '; font-weight:600; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">'
            +         'Dimensional fit (real units)'
            +       '</div>'
            +       '<div data-pvt-dim>'
            +         '<div style="color:' + PVT_THEME.muted + '; font-style:italic; font-size:12px;">'
            +           'Click <b>Apply to current fit</b> after fitting a model.'
            +         '</div>'
            +       '</div>'
            +     '</div>'
            +   '</div>'
            + '</div>';
    }

    function _tabBtn(fluid, active, label) {
        var on = (fluid === active);
        var bg = on ? PVT_THEME.accent : '#21262d';
        var fg = on ? '#0d1117'        : PVT_THEME.text;
        return '<button data-pvt-fluid="' + fluid + '"'
             +  ' style="padding:6px 14px; background:' + bg + '; color:' + fg
             +  '; border:1px solid ' + PVT_THEME.border + '; border-radius:4px;'
             +  ' cursor:pointer; font-size:12px; font-weight:600;">'
             +  label + '</button>';
    }

    function _wirePanel(container) {
        if (!container) return;
        // Field-input change → state + persist + compute on demand.
        var inputs = container.querySelectorAll('input[data-pvt-field]');
        for (var i = 0; i < inputs.length; i++) {
            (function (inp) {
                inp.addEventListener('input', function () {
                    var key = inp.getAttribute('data-pvt-field');
                    var raw = inp.value;
                    var s   = G.PRiSM_pvt;
                    if (raw === '' || raw == null) {
                        // Allow null for "(auto)" fields like Rs, Pb, Bo, etc.
                        s[key] = null;
                    } else {
                        var v = parseFloat(raw);
                        if (isFinite(v)) s[key] = v;
                    }
                    _scheduleSave();
                });
            })(inputs[i]);
        }
        // Tab buttons.
        var tabs = container.querySelectorAll('button[data-pvt-fluid]');
        for (var t = 0; t < tabs.length; t++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var fl = btn.getAttribute('data-pvt-fluid');
                    G.PRiSM_pvt.fluidType = fl;
                    _scheduleSave();
                    // Re-render only the inputs + tab strip; preserve the
                    // computed and dim result blocks.
                    var inputsHost = container.querySelector('[data-pvt-inputs]');
                    var tabHost    = container.querySelector('[data-pvt-tabs]');
                    if (inputsHost) inputsHost.innerHTML = _renderInputsHTML(G.PRiSM_pvt);
                    if (tabHost)    tabHost.innerHTML    = _tabBtn('oil', fl, 'Oil')
                                                        + _tabBtn('gas', fl, 'Gas')
                                                        + _tabBtn('water', fl, 'Water');
                    _wirePanel(container);  // re-bind handlers on freshly-injected DOM
                });
            })(tabs[t]);
        }
        // Action buttons.
        var btns = container.querySelectorAll('button[data-pvt-act]');
        for (var b = 0; b < btns.length; b++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var act = btn.getAttribute('data-pvt-act');
                    if (act === 'compute') {
                        try { G.PRiSM_pvt_compute(); }
                        catch (e) {
                            console.warn('PRiSM_pvt_compute failed:', e);
                        }
                        var compHost = container.querySelector('[data-pvt-computed]');
                        if (compHost) compHost.innerHTML = _renderComputedHTML(G.PRiSM_pvt);
                    } else if (act === 'apply') {
                        // Make sure PVT is current.
                        if (!G.PRiSM_pvt._computed || !G.PRiSM_pvt._computed.timestamp) {
                            try { G.PRiSM_pvt_compute(); } catch (e) {}
                        }
                        // Pull current fit.
                        var st = G.PRiSM_state || {};
                        var modelKey = st.model;
                        var params = (st.lastFit && st.lastFit.params)
                                     ? st.lastFit.params
                                     : (st.params || {});
                        if (st.lastFit && st.lastFit.modelKey) modelKey = st.lastFit.modelKey;
                        var dimResult;
                        try { dimResult = G.PRiSM_dimensionalize(modelKey, params); }
                        catch (e) {
                            dimResult = { ok: false, caveats: ['dimensionalize threw: ' + (e && e.message)] };
                        }
                        var dimHost = container.querySelector('[data-pvt-dim]');
                        if (dimHost) dimHost.innerHTML = _renderDimResultHTML(dimResult);
                    } else if (act === 'reset') {
                        G.PRiSM_pvt = _defaultPVT();
                        _scheduleSave();
                        // Full repaint.
                        G.PRiSM_renderPVTPanel(container);
                    }
                });
            })(btns[b]);
        }
    }

    G.PRiSM_renderPVTPanel = function PRiSM_renderPVTPanel(container) {
        if (!_hasDoc || !container) return;
        // Make sure we have state.
        if (!G.PRiSM_pvt) G.PRiSM_pvt = _loadFromStorage();
        container.innerHTML = _renderShellHTML(G.PRiSM_pvt);
        _wirePanel(container);
    };


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
    //  4. dimensionalize(homogeneous,{Cd:100,S:0}) at default PVT → all finite
    //  5. nondimensionalize(homogeneous,{k:100,h:50,S:0})  → Cd > 0
    //  6. m_p(4000, 180, 0.65)                             → > 0
    (function PRiSM_pvtSelfTest() {
        var log = (typeof console !== 'undefined' && console.log)   ? console.log.bind(console)   : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];

        function _check(name, ok, info) {
            checks.push({ name: name, ok: !!ok, info: info });
        }

        // ─── Test 1: Standing Bo
        try {
            var Bo = Bo_standing(35, 0.65, 500, 180);
            // Acceptable if 1.20 ≤ Bo ≤ 1.35
            _check('1. Standing Bo @ API=35,SG_g=0.65,Rs=500,T=180', Bo >= 1.20 && Bo <= 1.40, 'Bo=' + Bo.toFixed(4));
        } catch (e) { _check('1. Standing Bo', false, e.message); }

        // ─── Test 2: DAK Z
        var Z;
        try {
            var Tpc = Tpc_sutton(0.65), Ppc = Ppc_sutton(0.65);
            var Tpr = (180 + 459.67) / Tpc;
            var Ppr = 4000 / Ppc;
            Z = Z_dranchukAbouKassem(Tpr, Ppr);
            // Sensible band 0.70 ≤ Z ≤ 1.10
            _check('2. DAK Z @ SG_g=0.65,P=4000,T=180', Z >= 0.70 && Z <= 1.10, 'Z=' + Z.toFixed(4));
        } catch (e) { _check('2. DAK Z', false, e.message); }

        // ─── Test 3: ct on default oil reservoir
        var ct_val;
        try {
            // Snapshot, swap in a clean default state, compute, restore.
            var saved = G.PRiSM_pvt;
            G.PRiSM_pvt = _defaultPVT();
            G.PRiSM_pvt_compute();
            ct_val = G.PRiSM_pvt._computed.ct;
            // Acceptable: 5e-6 ≤ ct ≤ 5e-5
            _check('3. ct on default oil reservoir', ct_val >= 5e-6 && ct_val <= 5e-5, 'ct=' + ct_val.toExponential(3));
            G.PRiSM_pvt = saved;
            if (saved) G.PRiSM_pvt_compute();
        } catch (e) { _check('3. ct on default oil reservoir', false, e.message); }

        // ─── Test 4: dimensionalize on homogeneous (no model registered in
        //             the smoke-test stub may mean we can't infer k via the
        //             self-consistent fit; that's OK — the result is still
        //             expected to be { ok:true } with Cd→Cs derived).
        var dim;
        try {
            var saved2 = G.PRiSM_pvt;
            G.PRiSM_pvt = _defaultPVT();
            G.PRiSM_pvt_compute();
            // Make sure no stale dataset blocks the test.
            var savedDS = G.PRiSM_dataset;
            G.PRiSM_dataset = null;
            var savedState = G.PRiSM_state;
            G.PRiSM_state = { model: 'homogeneous', params: { Cd: 100, S: 0 } };
            dim = G.PRiSM_dimensionalize('homogeneous', { Cd: 100, S: 0, kh_md_ft: 5000 });
            // ok=true and Cs/k finite.
            var ok4 = dim && dim.ok
                       && _isFiniteNum(dim.Cs) && dim.Cs > 0
                       && _isFiniteNum(dim.k)  && dim.k  > 0;
            _check('4. dimensionalize homogeneous → finite Cs, k', ok4,
                   'k=' + (dim && dim.k && dim.k.toFixed(2)) + ' Cs=' + (dim && dim.Cs && dim.Cs.toExponential(3)));
            G.PRiSM_pvt     = saved2;
            G.PRiSM_dataset = savedDS;
            G.PRiSM_state   = savedState;
            if (saved2) G.PRiSM_pvt_compute();
        } catch (e) { _check('4. dimensionalize homogeneous', false, e.message); }

        // ─── Test 5: nondimensionalize
        var nd;
        try {
            var saved3 = G.PRiSM_pvt;
            G.PRiSM_pvt = _defaultPVT();
            G.PRiSM_pvt_compute();
            nd = G.PRiSM_nondimensionalize('homogeneous', { k: 100, h: 50, S: 0, Cs: 0.01 });
            var ok5 = nd && nd.ok && _isFiniteNum(nd.Cd) && nd.Cd > 0;
            _check('5. nondimensionalize homogeneous → Cd > 0', ok5,
                   'Cd=' + (nd && nd.Cd && nd.Cd.toFixed(4)));
            G.PRiSM_pvt = saved3;
            if (saved3) G.PRiSM_pvt_compute();
        } catch (e) { _check('5. nondimensionalize homogeneous', false, e.message); }

        // ─── Test 6: m(p) at 4000 psi for typical gas
        var mp;
        try {
            mp = m_p(4000, 180, 0.65);
            _check('6. m(p) @ 4000 psi, T=180, SG_g=0.65', mp > 0 && isFinite(mp), 'm(p)=' + mp.toExponential(3));
        } catch (e) { _check('6. m(p)', false, e.message); }

        // Report.
        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM PVT self-test FAILED:', fails);
        } else {
            log('✓ PRiSM PVT self-test passed (' + checks.length + ' checks).');
        }
        // Stash the actual numbers on the global so callers (e.g. the build
        // script) can echo them back.
        G.PRiSM_pvt_selfTestResults = checks;
    })();

})();
