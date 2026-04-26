
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
//     PRiSM_deconvolve_lcurve(t, p, q, lambdas, opts) → L-curve sweep
//     PRiSM_renderDeconvolutionPanel(container)    → UI render
//     PRiSM_convolve_rate_response(t_eval, t_rate, q, g, tau) → number[]
//     PRiSM_invert_to_unit_rate(t, p, q)           → { t_unit, p_unit }
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
    //   τ_min ≈ smallest meaningful elapsed-time-since-last-rate-step.
    //          Default: half the median sampling interval (or absolute
    //          minimum of 1e-6 hr).
    //   τ_max ≈ longest possible elapsed time = total test duration.
    //          (Anything beyond is unobservable in principle.)
    //
    // ═══════════════════════════════════════════════════════════════

    function _buildGrid(tArr, opts) {
        var n = tArr.length;
        if (n < 2) throw new Error('PRiSM_deconvolve: need at least 2 time samples');
        var tTotal = tArr[n - 1] - tArr[0];
        if (!(tTotal > 0)) throw new Error('PRiSM_deconvolve: time history must be increasing');

        // Median dt for tau_min auto-pick.
        var dts = [];
        for (var i = 1; i < n; i++) {
            var d = tArr[i] - tArr[i - 1];
            if (d > 0) dts.push(d);
        }
        dts.sort(function (a, b) { return a - b; });
        var dtMed = dts.length ? dts[Math.floor(dts.length / 2)] : tTotal / Math.max(n - 1, 1);

        var tauMin = (opts && isFinite(opts.tauMin) && opts.tauMin > 0)
            ? opts.tauMin
            : Math.max(dtMed * 0.5, 1e-6);
        var tauMax = (opts && isFinite(opts.tauMax) && opts.tauMax > 0)
            ? opts.tauMax
            : tTotal * 1.10;
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
    // The first step always has t_start = tArr[0] and dq = q (since
    // q(0-) = 0 by convention). If the first sample has q=0, an
    // initial "no-flow" step is still emitted so bookkeeping stays
    // consistent — its dq is 0 and it contributes nothing.
    function _compactRateSteps(tArr, qArr, tolFrac) {
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
                steps.push({
                    t_start: tArr[k],
                    q:       qk,
                    dq:      qk - qBefore
                });
                qPrev = qk;
            }
        }
        return { steps: steps, qMax: qMax };
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
    //   τ < τ_min      → use g_0 (clamp; deconvolution can't resolve here)
    //   τ > τ_max      → use g_{N-1} (clamp; same reasoning)
    //
    // ═══════════════════════════════════════════════════════════════

    // Interpolate g at a single elapsed time τ. Pre-built indices
    // (idxLo[k], wLo[k]) make this fast inside the tight LM loop.
    function _interpG(g, idxLo, wLo) {
        return wLo * g[idxLo] + (1 - wLo) * g[idxLo + 1];
    }

    // Build index/weight tables for all (eval-sample, rate-step) pairs.
    //
    //   For each observation t_k and each rate step i with t_step_i < t_k,
    //   compute τ = t_k - t_step_i and find:
    //     • idxLo : largest j such that τ_j ≤ τ
    //     • wLo   : weight on τ_j (1−wLo on τ_{j+1})
    //
    // This is O(M·R) once, then each LM iteration only does the dot
    // product. M = #observations, R = #rate steps.
    //
    // Returned arrays are RAGGED:
    //   idxLo[k]   = number[] (length = nActiveStepsForK)
    //   wLo[k]     = number[]
    //   dq[k]      = number[]
    function _buildConvIdx(tObs, steps, lnTau, tauMin, tauMax) {
        var M = tObs.length;
        var R = steps.length;
        var nN = lnTau.length;
        var idxLo = new Array(M);
        var wLo   = new Array(M);
        var dqArr = new Array(M);
        var lnLo = lnTau[0], lnHi = lnTau[nN - 1];
        var dLn  = (nN > 1) ? (lnHi - lnLo) / (nN - 1) : 1.0;

        for (var k = 0; k < M; k++) {
            var rowI = [], rowW = [], rowD = [];
            var tK = tObs[k];
            for (var i = 0; i < R; i++) {
                var step = steps[i];
                if (step.dq === 0) continue;
                var dt = tK - step.t_start;
                if (dt <= 0) continue;
                var lnDt = Math.log(dt);
                var u    = (lnDt - lnLo) / dLn;     // fractional index
                var jLo, w;
                if (lnDt <= lnLo) {
                    jLo = 0; w = 1.0;               // clamp low
                } else if (lnDt >= lnHi) {
                    jLo = nN - 2; w = 0.0;          // clamp high
                } else {
                    jLo = Math.floor(u);
                    if (jLo < 0) jLo = 0;
                    if (jLo > nN - 2) jLo = nN - 2;
                    w = 1.0 - (u - jLo);            // weight on jLo
                    if (w < 0) w = 0; else if (w > 1) w = 1;
                }
                rowI.push(jLo);
                rowW.push(w);
                rowD.push(step.dq);
            }
            idxLo[k] = rowI;
            wLo[k]   = rowW;
            dqArr[k] = rowD;
        }

        return { idxLo: idxLo, wLo: wLo, dq: dqArr, M: M, R: R, nNodes: nN };
    }

    // Compute predicted pressure: p_pred[k] = p_i − Σ_i Δq_i · g(τ_ik)
    //
    //   convIdx : output of _buildConvIdx
    //   g       : length-N response samples
    //   p_i     : initial pressure
    function _forwardP(convIdx, g, p_i) {
        var M = convIdx.M;
        var idxLo = convIdx.idxLo, wLo = convIdx.wLo, dq = convIdx.dq;
        var pred = new Array(M);
        for (var k = 0; k < M; k++) {
            var rowI = idxLo[k], rowW = wLo[k], rowD = dq[k];
            var sum = 0;
            for (var s = 0; s < rowI.length; s++) {
                var jLo = rowI[s];
                var gv = rowW[s] * g[jLo] + (1 - rowW[s]) * g[jLo + 1];
                sum += rowD[s] * gv;
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
    // Let p_pred[k] = p_i − Σ_i Δq_i · ( w_ik · g_{j_ik} + (1−w_ik) · g_{j_ik+1} )
    //
    // ∂p_pred[k] / ∂z_m
    //   = − Σ_i Δq_i · ( w_ik · δ_{m,j_ik} · g_m + (1−w_ik) · δ_{m,j_ik+1} · g_m )
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
            var rowW = convIdx.wLo[k];
            var rowD = convIdx.dq[k];
            for (var s = 0; s < rowI.length; s++) {
                var jLo  = rowI[s];
                var w    = rowW[s];
                var dqs  = rowD[s];
                // Column jLo: weight w on g_{jLo}. Sign is NEGATIVE.
                J[k][jLo]     -= dqs * w * g[jLo];
                // Column jLo+1: weight (1-w) on g_{jLo+1}. Sign NEGATIVE.
                J[k][jLo + 1] -= dqs * (1 - w) * g[jLo + 1];
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
        if (opts && Array.isArray(opts.initialZ) && opts.initialZ.length === tau.length) {
            return { z: opts.initialZ.slice(), p_i: pObs[0] };
        }
        var nObs = pObs.length;
        // Initial guess for p_i: maximum observed pressure plus a small
        // buffer (since g > 0, predicted p never exceeds p_i).
        var pMax = pObs[0];
        for (var k = 1; k < nObs; k++) if (pObs[k] > pMax) pMax = pObs[k];
        var p_i = pMax + 1.0;

        // Magnitude scale: peak pressure drop divided by max |q|.
        // We use the largest |Δp| seen, not the endpoint value, because
        // a buildup or recovery may push the endpoint back up.
        var pMin = pObs[0];
        for (var k2 = 1; k2 < nObs; k2++) if (pObs[k2] < pMin) pMin = pObs[k2];
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

        // ─── Validate input ────────────────────────────────────────
        if (!Array.isArray(t) || !Array.isArray(p) || !Array.isArray(q)) {
            // Allow source from window.PRiSM_dataset if no args given.
            var ds = G.PRiSM_dataset;
            if (ds && Array.isArray(ds.t) && Array.isArray(ds.p) && Array.isArray(ds.q)) {
                t = ds.t; p = ds.p; q = ds.q;
            } else {
                throw new Error('PRiSM_deconvolve: t, p, q arrays are required');
            }
        }
        if (t.length !== p.length || t.length !== q.length) {
            throw new Error('PRiSM_deconvolve: t, p, q must have the same length');
        }
        if (t.length < 3) throw new Error('PRiSM_deconvolve: need at least 3 samples');

        // ─── Implicit downsample for very long datasets ────────────
        // The deconvolution itself doesn't need every sample — log-spaced
        // subsampling preserves all the time-domain information at a
        // small fraction of the cost. Re-evaluation onto the original
        // grid happens after the solve so the user still gets g(τ) at
        // the input τ values for plotting.
        var tDS = t, pDS = p, qDS = q;
        var didDownsample = false;
        if (t.length > 2000 && opts.noDownsample !== true) {
            var sub = _logSubsample(t, p, q, 2000);
            tDS = sub.t; pDS = sub.p; qDS = sub.q;
            didDownsample = true;
        }

        // ─── Build grid + compact rate steps ───────────────────────
        var grid = _buildGrid(tDS, opts);
        var rate = _compactRateSteps(tDS, qDS);

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
            onProgress: opts.onProgress
        });

        // ─── Build response on the FULL τ grid ─────────────────────
        // (Even if we downsampled the data, we evaluate g on the
        // user's grid for display fidelity.)
        var g = lmRes.g;            // already on the τ grid
        var p_initial = lmRes.x[grid.nNodes];

        // Bourdet derivative of g(τ) on the log-time axis.
        var gPrime = _bourdet(grid.tau, g, opts.smoothL || 0.10);

        // ─── Re-evaluate residuals on FULL data grid ───────────────
        // Ensures `residuals` always covers the user's input even
        // when we downsampled internally.
        var convFull = didDownsample
            ? _buildConvIdx(t, rate.steps, grid.lnTau, grid.tauMin, grid.tauMax)
            : convIdx;
        var pFullPred = _forwardP(convFull, g, p_initial);
        var residuals = new Array(t.length);
        var sumSq = 0;
        for (var i = 0; i < t.length; i++) {
            residuals[i] = p[i] - pFullPred[i];
            sumSq += residuals[i] * residuals[i];
        }
        var rmse = Math.sqrt(sumSq / Math.max(t.length, 1));

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

        return {
            tau:        grid.tau,
            g:          g,
            gPrime:     gPrime,
            p_initial:  p_initial,
            residuals:  residuals,
            rmse:       rmse,
            converged:  lmRes.converged,
            iterations: lmRes.iter,
            lambda:     lambdaUsed,
            rationale:  rationale,
            diagnostics: {
                nNodes:        grid.nNodes,
                rateChanges:   rate.steps.length,
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

    // Log-spaced subsample helper. Picks ~target indices from t such that
    // they are roughly evenly spaced in log-time.
    function _logSubsample(t, p, q, target) {
        var n = t.length;
        if (n <= target) return { t: t.slice(), p: p.slice(), q: q.slice() };
        var t0 = t[0], t1 = t[n - 1];
        var lnLo = Math.log(Math.max(t0, 1e-12));
        var lnHi = Math.log(t1);
        var step = (lnHi - lnLo) / (target - 1);
        var keep = [0];
        var lastTarget = lnLo;
        for (var i = 1; i < n - 1; i++) {
            var ln = Math.log(Math.max(t[i], 1e-12));
            if (ln - lastTarget >= step) {
                keep.push(i);
                lastTarget = ln;
            }
        }
        keep.push(n - 1);
        var tOut = new Array(keep.length), pOut = new Array(keep.length), qOut = new Array(keep.length);
        for (var k = 0; k < keep.length; k++) {
            tOut[k] = t[keep[k]];
            pOut[k] = p[keep[k]];
            qOut[k] = q[keep[k]];
        }
        return { t: tOut, p: pOut, q: qOut };
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
        for (var i = 0; i < res.tau.length; i++) {
            p_unit[i] = res.p_initial - res.g[i];
        }
        return { t_unit: t_unit, p_unit: p_unit, full: res };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 12 — UI RENDER (PRiSM_renderDeconvolutionPanel)
    // ═══════════════════════════════════════════════════════════════
    //
    // Standard panel layout used elsewhere in PRiSM (#161b22 background,
    // #30363d border, GitHub dark palette). Lays out:
    //   • Inputs row: nNodes (default 80), λ (auto / value), tauMin/Max
    //   • Run button + L-curve toggle
    //   • Iteration progress line (live updated via opts.onProgress)
    //   • Result canvas: log-log plot of g and g'
    //   • "Save as PRiSM_dataset" — writes window.PRiSM_dataset for
    //     downstream regression.
    //
    // ═══════════════════════════════════════════════════════════════

    function _esc(s) {
        if (s == null) return '';
        return ('' + s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    G.PRiSM_renderDeconvolutionPanel = function PRiSM_renderDeconvolutionPanel(container) {
        if (!_hasDoc) return;
        var host = (typeof container === 'string')
            ? document.getElementById(container)
            : container;
        if (!host) return;

        var ds = G.PRiSM_dataset || null;
        var hasFullDataset = !!(ds && Array.isArray(ds.t) && Array.isArray(ds.p) && Array.isArray(ds.q));

        var html = [];
        html.push('<div style="border:1px solid #30363d; border-radius:6px; padding:12px 14px; '
            + 'background:#161b22; margin-top:8px; font:12px sans-serif; color:#c9d1d9;">');
        html.push('<div style="display:flex; align-items:center; justify-content:space-between; '
            + 'margin-bottom:10px; gap:12px; flex-wrap:wrap;">');
        html.push('<div style="font-weight:700; font-size:14px;">Advanced Deconvolution</div>');
        html.push('<div style="font-size:10.5px; color:#8b949e;">'
            + 'von Schroeter-Levitan unit-rate response from variable-rate history</div>');
        html.push('</div>');

        if (!hasFullDataset) {
            html.push('<div style="padding:10px; background:#0d1117; border-left:3px solid #d29922; '
                + 'border-radius:4px; color:#a6a39a;">No dataset with rate column loaded. '
                + 'Use the Data tab to upload t, p, q.</div>');
            html.push('</div>');
            host.innerHTML = html.join('');
            return;
        }

        // Inputs row.
        html.push('<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); '
            + 'gap:10px; margin-bottom:10px;">');
        html.push('<label style="display:flex; flex-direction:column; gap:3px;"><span style="font-size:10.5px; '
            + 'color:#8b949e; text-transform:uppercase; letter-spacing:.5px;">Nodes (N)</span>'
            + '<input type="number" id="prism_dec_nNodes" value="80" min="20" max="200" step="10" '
            + 'style="padding:4px 6px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px;"></label>');
        html.push('<label style="display:flex; flex-direction:column; gap:3px;"><span style="font-size:10.5px; '
            + 'color:#8b949e; text-transform:uppercase; letter-spacing:.5px;">λ (regularisation)</span>'
            + '<input type="text" id="prism_dec_lambda" value="auto" placeholder="auto or 1e-2" '
            + 'style="padding:4px 6px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px;"></label>');
        html.push('<label style="display:flex; flex-direction:column; gap:3px;"><span style="font-size:10.5px; '
            + 'color:#8b949e; text-transform:uppercase; letter-spacing:.5px;">τ_min (hr)</span>'
            + '<input type="text" id="prism_dec_tauMin" value="auto" '
            + 'style="padding:4px 6px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px;"></label>');
        html.push('<label style="display:flex; flex-direction:column; gap:3px;"><span style="font-size:10.5px; '
            + 'color:#8b949e; text-transform:uppercase; letter-spacing:.5px;">τ_max (hr)</span>'
            + '<input type="text" id="prism_dec_tauMax" value="auto" '
            + 'style="padding:4px 6px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px;"></label>');
        html.push('</div>');

        // Run button + actions.
        html.push('<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">');
        html.push('<button class="btn btn-primary" id="prism_dec_run" style="padding:6px 14px;">Run deconvolution</button>');
        html.push('<button class="btn btn-secondary" id="prism_dec_save" style="padding:6px 14px;" disabled>Save as PRiSM_dataset</button>');
        html.push('</div>');

        // Status / progress.
        html.push('<div id="prism_dec_status" style="font-size:11px; color:#8b949e; min-height:14px; margin-bottom:8px;"></div>');

        // Result plot.
        html.push('<canvas id="prism_dec_canvas" width="720" height="380" '
            + 'style="display:block; width:100%; max-width:720px; height:auto; '
            + 'background:#0d1117; border:1px solid #30363d; border-radius:4px;"></canvas>');

        // Diagnostics box.
        html.push('<div id="prism_dec_diag" style="margin-top:10px; padding:8px 10px; background:#0d1117; '
            + 'border-left:3px solid #58a6ff; border-radius:4px; font-size:11.5px; color:#c9d1d9; '
            + 'min-height:20px; display:none;"></div>');

        html.push('</div>');
        host.innerHTML = html.join('');

        // Wire up.
        var btnRun  = host.querySelector('#prism_dec_run');
        var btnSave = host.querySelector('#prism_dec_save');
        var status  = host.querySelector('#prism_dec_status');
        var diag    = host.querySelector('#prism_dec_diag');
        var canvas  = host.querySelector('#prism_dec_canvas');

        var lastResult = null;

        if (btnRun && btnRun.addEventListener) {
            btnRun.addEventListener('click', function () {
                if (!G.PRiSM_dataset || !G.PRiSM_dataset.q) {
                    if (status) status.textContent = 'No rate (q) data — load a dataset with q column first.';
                    return;
                }
                var nNodes = parseInt(host.querySelector('#prism_dec_nNodes').value, 10) || 80;
                var lamRaw = host.querySelector('#prism_dec_lambda').value.trim();
                var tauMinRaw = host.querySelector('#prism_dec_tauMin').value.trim();
                var tauMaxRaw = host.querySelector('#prism_dec_tauMax').value.trim();
                var opts = { nNodes: nNodes };
                if (lamRaw && lamRaw.toLowerCase() !== 'auto') {
                    var lv = parseFloat(lamRaw);
                    if (isFinite(lv)) opts.lambda = lv;
                }
                if (tauMinRaw && tauMinRaw.toLowerCase() !== 'auto') {
                    var tn = parseFloat(tauMinRaw);
                    if (isFinite(tn) && tn > 0) opts.tauMin = tn;
                }
                if (tauMaxRaw && tauMaxRaw.toLowerCase() !== 'auto') {
                    var tx = parseFloat(tauMaxRaw);
                    if (isFinite(tx) && tx > 0) opts.tauMax = tx;
                }
                opts.onProgress = function (it, ssr) {
                    if (status) {
                        status.textContent = 'Iter ' + it + ' — SSR=' + ssr.toExponential(3);
                    }
                };
                if (status) status.textContent = 'Running…';

                // Defer to allow status update to paint.
                setTimeout(function () {
                    var t0 = (typeof performance !== 'undefined' && performance.now)
                        ? performance.now() : Date.now();
                    var res;
                    try {
                        res = PRiSM_deconvolve(G.PRiSM_dataset.t, G.PRiSM_dataset.p,
                                                G.PRiSM_dataset.q, opts);
                    } catch (e) {
                        if (status) status.textContent = 'Error: ' + (e && e.message);
                        return;
                    }
                    var dt = ((typeof performance !== 'undefined' && performance.now)
                        ? performance.now() : Date.now()) - t0;

                    lastResult = res;
                    btnSave.disabled = false;
                    if (status) {
                        status.textContent = (res.converged ? 'Converged' : 'Did not converge')
                            + ' in ' + res.iterations + ' iter • RMSE=' + res.rmse.toFixed(3)
                            + ' • ' + dt.toFixed(0) + ' ms • λ=' + res.lambda.toExponential(2);
                    }
                    if (diag) {
                        diag.style.display = 'block';
                        diag.innerHTML =
                            '<b>p_initial</b> = ' + res.p_initial.toFixed(2) + ' &nbsp;•&nbsp; '
                            + '<b>nodes</b> = ' + res.diagnostics.nNodes + ' &nbsp;•&nbsp; '
                            + '<b>rate steps</b> = ' + res.diagnostics.rateChanges + ' &nbsp;•&nbsp; '
                            + '<b>τ ∈</b> [' + res.diagnostics.tauMin.toExponential(2)
                            + ', ' + res.diagnostics.tauMax.toExponential(2) + '] &nbsp;•&nbsp; '
                            + '<b>TV(z)</b> = ' + res.diagnostics.smoothness.toFixed(2)
                            + '<br><span style="color:#8b949e;">' + _esc(res.rationale) + '</span>';
                    }
                    _drawDeconvCanvas(canvas, res);
                }, 30);
            });
        }

        if (btnSave && btnSave.addEventListener) {
            btnSave.addEventListener('click', function () {
                if (!lastResult) return;
                G.PRiSM_dataset = {
                    t: lastResult.tau.slice(),
                    p: lastResult.tau.map(function (_, i) {
                        return lastResult.p_initial - lastResult.g[i];
                    }),
                    q: null,    // unit-rate so q is implicit
                    source: 'deconvolution',
                    deconv: { lambda: lastResult.lambda, p_initial: lastResult.p_initial }
                };
                if (status) status.textContent = 'Saved deconvolved response as PRiSM_dataset.';
                _ga4('prism_deconvolution_save', { nNodes: lastResult.diagnostics.nNodes });
            });
        }
    };

    // Light-weight log-log plot for g(τ) and g'(τ). We don't depend on
    // the layer-2 plot suite to avoid coupling — this is a self-contained
    // canvas renderer with the same colour palette.
    function _drawDeconvCanvas(canvas, res) {
        if (!canvas || !canvas.getContext) return;
        var ctx = canvas.getContext('2d');
        if (!ctx) return;

        var W = canvas.width, H = canvas.height;
        var pad = { top: 24, right: 64, bottom: 44, left: 60 };
        var pw = W - pad.left - pad.right;
        var ph = H - pad.top - pad.bottom;

        // Bg.
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, W, H);

        var tau = res.tau;
        var g   = res.g;
        var gp  = res.gPrime;

        // Build plot points (only positive values for log axes).
        var pts1 = [], pts2 = [];
        var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (var i = 0; i < tau.length; i++) {
            if (tau[i] > 0 && isFinite(g[i]) && g[i] > 0) {
                pts1.push([tau[i], g[i]]);
                if (tau[i] < xMin) xMin = tau[i];
                if (tau[i] > xMax) xMax = tau[i];
                if (g[i] < yMin) yMin = g[i];
                if (g[i] > yMax) yMax = g[i];
            }
            if (tau[i] > 0 && isFinite(gp[i]) && gp[i] > 0) {
                pts2.push([tau[i], gp[i]]);
                if (gp[i] < yMin) yMin = gp[i];
                if (gp[i] > yMax) yMax = gp[i];
            }
        }
        if (!pts1.length && !pts2.length) {
            ctx.fillStyle = '#8b949e';
            ctx.font = '12px sans-serif';
            ctx.fillText('No positive g(τ) values to plot', pad.left + 10, pad.top + 20);
            return;
        }

        // Pad y range a bit.
        if (yMin === yMax) { yMin = yMin / 10; yMax = yMax * 10; }
        yMin *= 0.5; yMax *= 2;

        var lnXmin = Math.log10(xMin), lnXmax = Math.log10(xMax);
        var lnYmin = Math.log10(yMin), lnYmax = Math.log10(yMax);

        function tx(x) { return pad.left + (Math.log10(x) - lnXmin) / (lnXmax - lnXmin) * pw; }
        function ty(y) { return pad.top + ph - (Math.log10(y) - lnYmin) / (lnYmax - lnYmin) * ph; }

        // Grid (decade lines).
        ctx.strokeStyle = '#21262d';
        ctx.lineWidth = 1;
        for (var dx = Math.floor(lnXmin); dx <= Math.ceil(lnXmax); dx++) {
            var xv = Math.pow(10, dx);
            if (xv < xMin || xv > xMax) continue;
            var xp = tx(xv);
            ctx.beginPath();
            ctx.moveTo(xp, pad.top);
            ctx.lineTo(xp, pad.top + ph);
            ctx.stroke();
        }
        for (var dy = Math.floor(lnYmin); dy <= Math.ceil(lnYmax); dy++) {
            var yv = Math.pow(10, dy);
            if (yv < yMin || yv > yMax) continue;
            var yp = ty(yv);
            ctx.beginPath();
            ctx.moveTo(pad.left, yp);
            ctx.lineTo(pad.left + pw, yp);
            ctx.stroke();
        }

        // Axes.
        ctx.strokeStyle = '#30363d';
        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top);
        ctx.lineTo(pad.left, pad.top + ph);
        ctx.lineTo(pad.left + pw, pad.top + ph);
        ctx.stroke();

        // g(τ) line — blue.
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
        // g'(τ) markers — orange.
        if (pts2.length) {
            ctx.fillStyle = '#f0883e';
            for (var k2 = 0; k2 < pts2.length; k2++) {
                var px2 = tx(pts2[k2][0]), py2 = ty(pts2[k2][1]);
                ctx.beginPath();
                ctx.arc(px2, py2, 2.4, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Labels.
        ctx.fillStyle = '#c9d1d9';
        ctx.font = '11px sans-serif';
        ctx.fillText('τ (hr)', pad.left + pw - 30, H - 12);
        ctx.save();
        ctx.translate(14, pad.top + ph / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('g(τ), g′(τ)', -30, 0);
        ctx.restore();

        // Decade labels along x.
        ctx.fillStyle = '#8b949e';
        for (var dx2 = Math.floor(lnXmin); dx2 <= Math.ceil(lnXmax); dx2++) {
            var xv2 = Math.pow(10, dx2);
            if (xv2 < xMin || xv2 > xMax) continue;
            ctx.fillText('1e' + dx2, tx(xv2) - 12, pad.top + ph + 14);
        }
        for (var dy2 = Math.floor(lnYmin); dy2 <= Math.ceil(lnYmax); dy2++) {
            var yv2 = Math.pow(10, dy2);
            if (yv2 < yMin || yv2 > yMax) continue;
            ctx.fillText('1e' + dy2, 6, ty(yv2) + 4);
        }

        // Legend.
        ctx.fillStyle = '#58a6ff';
        ctx.fillText('— g(τ)', pad.left + pw - 60, pad.top + 14);
        ctx.fillStyle = '#f0883e';
        ctx.fillText('• g′(τ)', pad.left + pw - 60, pad.top + 28);

        // Title.
        ctx.fillStyle = '#c9d1d9';
        ctx.font = '12px sans-serif';
        ctx.fillText('Unit-rate response (deconvolution)', pad.left, pad.top - 8);
    }


    // ═══════════════════════════════════════════════════════════════
    // EXPORTS
    // ═══════════════════════════════════════════════════════════════
    G.PRiSM_deconvolve              = PRiSM_deconvolve;
    G.PRiSM_deconvolve_lcurve       = PRiSM_deconvolve_lcurve;
    G.PRiSM_convolve_rate_response  = PRiSM_convolve_rate_response;
    G.PRiSM_invert_to_unit_rate     = PRiSM_invert_to_unit_rate;
    // PRiSM_renderDeconvolutionPanel already attached above.


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
//   PRiSM_applyTideCorrection()            → corrected dataset (or null)
//   PRiSM_resetTideCorrection()            → restored dataset (or null)
//   PRiSM_renderTidePanel(container)       → void   (UI host helper)
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

        // Compare against PVT-derived ct (Layer 16) when available.
        var pvtComparison = '';
        try {
            var pvt_ct = G.PRiSM_pvt && G.PRiSM_pvt._computed && G.PRiSM_pvt._computed.ct;
            if (ct != null && isFinite(pvt_ct) && pvt_ct > 0) {
                var pct = Math.abs(ct - pvt_ct) / pvt_ct * 100;
                pvtComparison = ' Tide-derived ct = ' + ct.toExponential(2)
                              + ' 1/psi vs PVT ct = ' + pvt_ct.toExponential(2)
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
    // We snapshot the pre-correction dataset once, then replace .p
    // with the corrected series. PRiSM_resetTideCorrection restores
    // from the snapshot. The snapshot is held on
    //     window.PRiSM_tideCorrectionState
    // so it survives across module-internal calls without leaking
    // a private closure variable.
    // ═══════════════════════════════════════════════════════════════

    function _ensureTideState() {
        if (!G.PRiSM_tideCorrectionState) {
            G.PRiSM_tideCorrectionState = {
                snapshot:        null,
                lastResult:      null,
                lastOpts:        null,
                applied:         false
            };
        }
        return G.PRiSM_tideCorrectionState;
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
        if (!st.snapshot) st.snapshot = _snapshotForTide(ds);

        // Always run analysis on the snapshot pressures (so re-applies
        // are idempotent) — never on the already-corrected series.
        var snap = st.snapshot;
        var res = G.PRiSM_tideAnalysis(snap.t, snap.p, opts || st.lastOpts || undefined);
        st.lastResult = res;
        st.lastOpts   = opts || st.lastOpts;

        if (!res || !Array.isArray(res.p_corrected) || !res.p_corrected.length) {
            return null;
        }

        // Build new dataset with corrected p; preserve every other key.
        var newDs = _snapshotForTide(snap);
        newDs.p = res.p_corrected.slice();
        newDs.tideCorrected = true;
        newDs.tideOriginalP = snap.p.slice();
        newDs.tideFitted    = res.p_tide.slice();

        G.PRiSM_dataset = newDs;
        st.applied = true;

        try {
            _ga4('prism_tide_correction_applied', {
                n_samples: snap.t.length,
                m2_amp_psi: (res.constituents && res.constituents[0] && res.constituents[0].name === 'M2')
                            ? Math.round(res.constituents[0].amplitude * 1000) / 1000 : null
            });
        } catch (e) { /* swallow */ }

        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }

        return newDs;
    };

    G.PRiSM_resetTideCorrection = function PRiSM_resetTideCorrection() {
        var st = _ensureTideState();
        if (!st.snapshot) return null;
        var restored = _snapshotForTide(st.snapshot);
        // Keep snapshot around in case the user wants to re-apply.
        G.PRiSM_dataset = restored;
        st.applied = false;

        try { _ga4('prism_tide_correction_reset', {}); } catch (e) { /* swallow */ }

        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
        return restored;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — UI: PRiSM_renderTidePanel(container)
    // ═══════════════════════════════════════════════════════════════
    // Paints a self-contained tide-analysis panel into `container`
    // (a DOM element). Mirrors the style of PRiSM_renderCropTool /
    // PRiSM_renderInterpretationPanel.
    //
    // Sections:
    //   - Inputs: depth_ft, theoreticalM2_psi, constituent checklist,
    //             minDuration_h.
    //   - "Run tide analysis" button → calls PRiSM_tideAnalysis on
    //             the live dataset and paints results.
    //   - Constituent table (name, period, amplitude, phase°).
    //   - Decomposition canvas (raw / fitted-tide / corrected).
    //   - Apply / Reset correction buttons.
    //   - Estimated ct + Bredehoeft formula footnote.
    //   - Rationale block.
    // ═══════════════════════════════════════════════════════════════

    var _PANEL_STYLE   = 'background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:14px; color:#c9d1d9; font-size:13px; line-height:1.5;';
    var _HEADING_STYLE = 'font-weight:600; font-size:12px; color:#8b949e; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;';
    var _CARD_STYLE    = 'background:#161b22; border:1px solid #30363d; border-radius:6px; padding:12px; margin-bottom:12px;';
    var _INPUT_STYLE   = 'width:120px; padding:4px 6px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;';
    var _LABEL_STYLE   = 'display:flex; flex-direction:column; font-size:11px; color:#8b949e; gap:2px;';
    var _BTN_PRIMARY   = 'padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;';
    var _BTN_SECONDARY = 'padding:6px 14px; background:#21262d; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; cursor:pointer; font-size:12px;';
    var _BTN_BLUE      = 'padding:6px 14px; background:#1f6feb; color:#fff; border:1px solid #388bfd; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;';

    function _byId(id) {
        return _hasDoc ? document.getElementById(id) : null;
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

    function _readNumberInput(id, fallback) {
        var el = _byId(id);
        if (!el) return fallback;
        var v = parseFloat(el.value);
        return isFinite(v) ? v : fallback;
    }

    function _renderResultTable(constArr) {
        if (!constArr || !constArr.length) {
            return '<div style="font-style:italic; color:#8b949e;">No constituents fitted.</div>';
        }
        var h = [];
        h.push('<table style="width:100%; border-collapse:collapse; font-size:12px;">');
        h.push('<thead><tr style="border-bottom:1px solid #30363d; color:#8b949e; text-align:left;">');
        h.push('<th style="padding:6px 8px;">Constituent</th>');
        h.push('<th style="padding:6px 8px;">Period (h)</th>');
        h.push('<th style="padding:6px 8px;">Amplitude (psi)</th>');
        h.push('<th style="padding:6px 8px;">Phase (°)</th>');
        h.push('<th style="padding:6px 8px;">Description</th>');
        h.push('</tr></thead><tbody>');
        for (var i = 0; i < constArr.length; i++) {
            var c = constArr[i];
            var phaseDeg = c.phase * 180 / Math.PI;
            h.push('<tr style="border-bottom:1px solid #21262d;">'
                + '<td style="padding:6px 8px; font-weight:600; color:#58a6ff;">' + _esc(c.name) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + c.period.toFixed(4) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + _fmt(c.amplitude, 3) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + _fmt(phaseDeg, 1) + '</td>'
                + '<td style="padding:6px 8px; color:#8b949e;">' + _esc(c.desc) + '</td>'
                + '</tr>');
        }
        h.push('</tbody></table>');
        return h.join('');
    }

    function _renderCtBlock(ct, depth_ft, theoreticalM2_psi) {
        if (ct == null || !isFinite(ct)) {
            return '<div style="padding:10px; background:#161b22; border-radius:4px; color:#8b949e; font-style:italic;">'
                 + 'ct estimate not available — supply depth_ft &amp; theoreticalM2_psi (both &gt; 0) and ensure M2 is fitted.</div>';
        }
        return '<div style="padding:10px; background:#161b22; border-left:3px solid #3fb950; border-radius:4px;">'
             +    '<div style="font-size:11px; color:#8b949e; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">'
             +      'Total compressibility (Bredehoeft 1967)'
             +    '</div>'
             +    '<div style="font-size:18px; font-weight:600; color:#3fb950; font-family:monospace;">'
             +      'c<sub>t</sub> ≈ ' + ct.toExponential(3) + ' psi<sup>−1</sup>'
             +    '</div>'
             +    '<div style="font-size:11px; color:#8b949e; margin-top:6px; line-height:1.4;">'
             +      'Formula: c<sub>t</sub> = R<sub>obs</sub> / (R<sub>th</sub> · ρ<sub>w</sub>g · h · ξ)<br>'
             +      'where R<sub>th</sub>=' + _esc(theoreticalM2_psi) + ' psi, h=' + _esc(depth_ft) + ' ft, '
             +      'ρ<sub>w</sub>g=' + FRESH_WATER_GRADIENT_PSI_PER_FT + ' psi/ft, ξ=' + BREDEHOEFT_LOVE_FACTOR
             +      ' (Love factor h₂−1.16·k₂).<br>'
             +      'For confined saturated formations; treat as a sanity bound on PVT-derived c<sub>t</sub> in oil/gas zones.'
             +    '</div>'
             + '</div>';
    }

    function _renderResults(container, res, opts) {
        var host = container.querySelector
                 ? container.querySelector('.prism-tide-results')
                 : null;
        if (!host) return;
        if (!res) {
            host.innerHTML = '<div style="color:#8b949e; font-style:italic;">No results yet.</div>';
            return;
        }
        var h = [];

        // Constituent table.
        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Fitted constituents</div>');
        h.push(_renderResultTable(res.constituents));
        h.push('</div>');

        // Decomposition canvas.
        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Decomposition (raw → fitted tide → corrected)</div>');
        h.push('<canvas id="prism_tide_canvas" width="800" height="380" '
            +  'style="display:block; background:#0d1117; border:1px solid #30363d; '
            +  'border-radius:6px; max-width:100%;"></canvas>');
        h.push('</div>');

        // Diagnostics + ct.
        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Diagnostics</div>');
        h.push('<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px; margin-bottom:12px;">');
        h.push('<div><span style="color:#8b949e; font-size:11px;">Residual RMS</span><div style="font-family:monospace; color:#c9d1d9;">'
              + _fmt(res.residual_rms, 3) + ' psi</div></div>');
        h.push('<div><span style="color:#8b949e; font-size:11px;">M2 SNR</span><div style="font-family:monospace; color:#c9d1d9;">'
              + _fmt(res.snr, 2) + '</div></div>');
        h.push('<div><span style="color:#8b949e; font-size:11px;">Variance reduction</span><div style="font-family:monospace; color:#c9d1d9;">'
              + _fmt(res.variance_reduction_pct, 1) + ' %</div></div>');
        h.push('<div><span style="color:#8b949e; font-size:11px;">Duration</span><div style="font-family:monospace; color:#c9d1d9;">'
              + _fmt(res.duration_h, 1) + ' h</div></div>');
        h.push('<div><span style="color:#8b949e; font-size:11px;">Samples</span><div style="font-family:monospace; color:#c9d1d9;">'
              + (res.n_samples || 0) + '</div></div>');
        h.push('</div>');
        h.push(_renderCtBlock(res.ct_estimate, opts.depth_ft, opts.theoreticalM2_psi));
        h.push('</div>');

        // Rationale.
        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Rationale</div>');
        h.push('<div style="color:#c9d1d9; line-height:1.55;">' + _esc(res.rationale || '') + '</div>');
        h.push('</div>');

        host.innerHTML = h.join('');

        // Paint the decomposition plot.
        var canvas = _byId('prism_tide_canvas');
        if (canvas && canvas.getContext) {
            try {
                G.PRiSM_plot_tide_decomposition(canvas, {
                    t:           opts._lastT || (G.PRiSM_dataset ? G.PRiSM_dataset.t : []),
                    p_raw:       opts._lastP || (G.PRiSM_dataset ? G.PRiSM_dataset.p : []),
                    p_tide:      res.p_tide,
                    p_corrected: res.p_corrected
                });
            } catch (e) { /* swallow */ }
        }
    }

    function _runFromUI(container) {
        var ds = G.PRiSM_dataset;
        var msg = container.querySelector ? container.querySelector('.prism-tide-msg') : null;
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || !ds.t.length) {
            if (msg) msg.innerHTML = '<span style="color:#f85149;">No dataset loaded — go to the Data tab and load a pressure history first.</span>';
            return;
        }
        // If a tide correction is already applied, run the analysis on
        // the *original* snapshot (not the already-cleaned series).
        var st = _ensureTideState();
        var srcT = ds.t, srcP = ds.p;
        if (st.applied && st.snapshot) {
            srcT = st.snapshot.t; srcP = st.snapshot.p;
        }

        var depth = _readNumberInput('prism_tide_depth', null);
        var theo  = _readNumberInput('prism_tide_theom2', 1.0);
        var minD  = _readNumberInput('prism_tide_minDur', 48);
        var sel   = _selectedConstituents(container);

        var opts = {
            constituents:      sel,
            detrend:           true,
            depth_ft:          depth,
            theoreticalM2_psi: theo,
            minDuration_h:     minD
        };

        var res;
        try {
            res = G.PRiSM_tideAnalysis(srcT, srcP, opts);
        } catch (e) {
            if (msg) msg.innerHTML = '<span style="color:#f85149;">Analysis failed: ' + _esc(e && e.message) + '</span>';
            return;
        }
        st.lastResult = res;
        st.lastOpts   = opts;
        opts._lastT = srcT; opts._lastP = srcP;
        if (msg) msg.innerHTML = '<span style="color:#3fb950;">Analysis complete (' + (res.constituents.length) + ' constituents fitted).</span>';
        _renderResults(container, res, opts);
    }

    G.PRiSM_renderTidePanel = function PRiSM_renderTidePanel(container) {
        if (!_hasDoc || !container) return;

        var st = _ensureTideState();

        var html = [];
        html.push('<div class="prism-tide-panel" style="' + _PANEL_STYLE + '">');

        // Header.
        html.push('<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; gap:12px; flex-wrap:wrap;">');
        html.push('<div style="font-weight:700; font-size:14px; color:#c9d1d9;">Tide Analysis (offshore wells)</div>');
        html.push('<div style="font-size:11px; color:#8b949e;">Bredehoeft 1967 · Van der Kamp 1990</div>');
        html.push('</div>');

        // Description.
        html.push('<div style="margin-bottom:12px; padding:10px; background:#161b22; border-left:3px solid #58a6ff; border-radius:4px; font-size:12px; color:#8b949e; line-height:1.55;">'
              +     'Detects astronomical tide harmonics in your pressure-gauge data, fits their amplitudes / phases by linear least-squares, '
              +     'and produces a corrected pressure record cleaned of the periodic tidal signal. From the M2 amplitude an in-situ estimate of '
              +     'formation total compressibility c<sub>t</sub> is computed.'
              +   '</div>');

        // Inputs card.
        html.push('<div style="' + _CARD_STYLE + '">');
        html.push('<div style="' + _HEADING_STYLE + '">Inputs</div>');
        html.push('<div style="display:flex; flex-wrap:wrap; gap:14px; margin-bottom:10px;">');
        html.push('<label style="' + _LABEL_STYLE + '">Depth (ft)'
              +     '<input type="number" id="prism_tide_depth" step="any" min="0" placeholder="e.g. 10000" '
              +       'style="' + _INPUT_STYLE + '"></label>');
        html.push('<label style="' + _LABEL_STYLE + '">Theoretical M2 amplitude (psi)'
              +     '<input type="number" id="prism_tide_theom2" step="0.05" min="0" value="1.0" '
              +       'style="' + _INPUT_STYLE + '"></label>');
        html.push('<label style="' + _LABEL_STYLE + '">Min duration (h)'
              +     '<input type="number" id="prism_tide_minDur" step="1" min="1" value="48" '
              +       'style="' + _INPUT_STYLE + '"></label>');
        html.push('</div>');
        // Constituent checklist.
        html.push('<div style="' + _HEADING_STYLE + '; margin-top:6px;">Constituents</div>');
        html.push('<div style="display:flex; flex-wrap:wrap; gap:10px; font-size:12px;">');
        for (var i = 0; i < PRiSM_TIDE_CONSTITUENTS.length; i++) {
            var c = PRiSM_TIDE_CONSTITUENTS[i];
            var checked = c.isMajor ? ' checked' : '';
            html.push('<label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; padding:3px 8px; background:#0d1117; border:1px solid #30363d; border-radius:14px;" title="' + _esc(c.desc) + ' (period ' + c.period.toFixed(2) + ' h)">'
                  +     '<input type="checkbox" data-prism-tide-c="' + _esc(c.name) + '"' + checked + ' style="margin:0;">'
                  +     '<span style="color:#c9d1d9; font-weight:600;">' + _esc(c.name) + '</span>'
                  +     '<span style="color:#6e7681; font-size:10px;">' + c.period.toFixed(1) + ' h</span>'
                  +   '</label>');
        }
        html.push('</div>');
        // Action buttons.
        html.push('<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; align-items:center;">');
        html.push('<button id="prism_tide_run"   type="button" style="' + _BTN_BLUE + '">Run tide analysis</button>');
        html.push('<button id="prism_tide_apply" type="button" style="' + _BTN_PRIMARY + '">Apply correction</button>');
        html.push('<button id="prism_tide_reset" type="button" style="' + _BTN_SECONDARY + '">Reset</button>');
        html.push('<span class="prism-tide-msg" style="font-size:12px; color:#8b949e; margin-left:6px;"></span>');
        html.push('</div>');
        html.push('</div>');

        // Results region (filled after run).
        html.push('<div class="prism-tide-results"></div>');

        html.push('</div>');
        container.innerHTML = html.join('');

        // Wire buttons. Use direct DOM properties — addEventListener is
        // also fine but we mirror the simpler PRiSM_renderCropTool style.
        var btnRun   = _byId('prism_tide_run');
        var btnApply = _byId('prism_tide_apply');
        var btnReset = _byId('prism_tide_reset');
        if (btnRun)   btnRun.onclick   = function () { _runFromUI(container); };
        if (btnApply) btnApply.onclick = function () {
            var depth = _readNumberInput('prism_tide_depth', null);
            var theo  = _readNumberInput('prism_tide_theom2', 1.0);
            var minD  = _readNumberInput('prism_tide_minDur', 48);
            var sel   = _selectedConstituents(container);
            var ds = G.PRiSM_applyTideCorrection({
                constituents: sel, depth_ft: depth,
                theoreticalM2_psi: theo, minDuration_h: minD,
                detrend: true
            });
            var msg = container.querySelector('.prism-tide-msg');
            if (msg) {
                if (ds) msg.innerHTML = '<span style="color:#3fb950;">Correction applied — pressure series replaced with tide-cleaned values.</span>';
                else    msg.innerHTML = '<span style="color:#f85149;">Could not apply — no dataset loaded.</span>';
            }
            // Repaint results so the diagnostics reflect the new state.
            var s = _ensureTideState();
            if (s.lastResult) {
                var optsCopy = {};
                for (var k in s.lastOpts) optsCopy[k] = s.lastOpts[k];
                optsCopy._lastT = s.snapshot ? s.snapshot.t : (G.PRiSM_dataset ? G.PRiSM_dataset.t : []);
                optsCopy._lastP = s.snapshot ? s.snapshot.p : (G.PRiSM_dataset ? G.PRiSM_dataset.p : []);
                _renderResults(container, s.lastResult, optsCopy);
            }
        };
        if (btnReset) btnReset.onclick = function () {
            var ds = G.PRiSM_resetTideCorrection();
            var msg = container.querySelector('.prism-tide-msg');
            if (msg) {
                if (ds) msg.innerHTML = '<span style="color:#3fb950;">Reset — original pressure series restored.</span>';
                else    msg.innerHTML = '<span style="color:#8b949e;">Nothing to reset (no prior correction).</span>';
            }
        };

        // If we've already run an analysis this session, repaint it.
        if (st.lastResult) {
            var optsCopy2 = {};
            for (var k2 in (st.lastOpts || {})) optsCopy2[k2] = st.lastOpts[k2];
            if (!optsCopy2.depth_ft) optsCopy2.depth_ft = null;
            if (!optsCopy2.theoreticalM2_psi) optsCopy2.theoreticalM2_psi = 1.0;
            optsCopy2._lastT = st.snapshot ? st.snapshot.t : (G.PRiSM_dataset ? G.PRiSM_dataset.t : []);
            optsCopy2._lastP = st.snapshot ? st.snapshot.p : (G.PRiSM_dataset ? G.PRiSM_dataset.p : []);
            _renderResults(container, st.lastResult, optsCopy2);
        }

        try { _ga4('prism_tide_panel_open', {}); } catch (e) { /* swallow */ }
    };


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
        var cssW = opts.width  || canvas.clientWidth  || canvas.width  || 800;
        var cssH = opts.height || canvas.clientHeight || canvas.height || 380;
        if (canvas.style) {
            canvas.style.width  = cssW + 'px';
            canvas.style.height = cssH + 'px';
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
//   PRiSM_renderProjectToolbar(container)  — UI for File menu
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

function _put(id, kind, blob) {
    var rec = {
        id: id,
        kind: kind,
        createdAt: blob.createdAt || _now(),
        metadata: blob.metadata || {},
        provenance: blob.provenance || null,
        data: blob.data || null
    };
    if (_backend === 'indexedDB')   return _idbPut(rec);
    if (_backend === 'localStorage') return _lsPut(rec);
    if (!_memStore) _memStore = new Map();
    return _memPut(rec);
}
function _get(id) {
    if (_backend === 'indexedDB')   return _idbGet(id);
    if (_backend === 'localStorage') return _lsGet(id);
    if (!_memStore) _memStore = new Map();
    return _memGet(id);
}
function _del(id) {
    if (_backend === 'indexedDB')   return _idbDelete(id);
    if (_backend === 'localStorage') return _lsDelete(id);
    if (!_memStore) _memStore = new Map();
    return _memDel(id);
}
function _list(kind) {
    if (_backend === 'indexedDB')   return _idbListByKind(kind);
    if (_backend === 'localStorage') return _lsListByKind(kind);
    if (!_memStore) _memStore = new Map();
    return _memList(kind);
}

// Kick off init at load — caller can await PRiSM_storage.init() too.
try { G.PRiSM_storage.init(); } catch (e) { /* ignore */ }


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
    }
};

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
                if (_activeAnalysisId === analysisId) {
                    _activeAnalysisId = null;
                    G.PRiSM_dataset = null;
                }
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
            G.PRiSM_dataset = { t: a.t, p: a.p, q: a.q };
            _activeAnalysisId = analysisId;
            // Reflect activation in the host UI if a re-render hook is wired.
            if (typeof G.PRiSM_drawActivePlot === 'function') {
                try { G.PRiSM_drawActivePlot(); } catch (e) { /* swallow */ }
            }
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
            // 2) Snapshot host state.
            _projectMeta.modifiedAt = _now();
            var st = G.PRiSM_state || {};
            var stateSnap = {
                activeAnalysisId: _activeAnalysisId,
                model: st.model || null,
                params: st.params || {},
                paramFreeze: st.paramFreeze || {},
                lastFit: st.lastFit || null,
                presets: st.presets || [],
                pvt: G.PRiSM_pvt || st.pvt || null,
                activePlot: st.activePlot || null
            };
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
        return _ensureInit().then(function () {
            // Wipe existing data then reinsert.
            return _wipeAll();
        }).then(function () {
            var gaugePuts = (proj.gaugeData || []).map(function (g) {
                return G.PRiSM_storage.putGauge(g.id, {
                    metadata: g.metadata,
                    createdAt: (g.metadata && g.metadata.createdAt) || _now(),
                    data: g.dataB64 ? {
                        t: _b64ToBuf(g.dataB64.t),
                        p: _b64ToBuf(g.dataB64.p),
                        q: g.dataB64.q ? _b64ToBuf(g.dataB64.q) : null
                    } : null
                });
            });
            var analysisPuts = (proj.analysisData || []).map(function (a) {
                return G.PRiSM_storage.putAnalysis(a.id, {
                    metadata: a.metadata,
                    provenance: a.provenance,
                    createdAt: (a.provenance && a.provenance.createdAt) || _now(),
                    data: a.dataB64 ? {
                        t: _b64ToBuf(a.dataB64.t),
                        p: _b64ToBuf(a.dataB64.p),
                        q: a.dataB64.q ? _b64ToBuf(a.dataB64.q) : null
                    } : null
                });
            });
            return _Promise.all(gaugePuts.concat(analysisPuts));
        }).then(function () {
            // Restore state.
            _projectMeta = proj.meta || _projectMeta;
            _projectMeta.modifiedAt = _now();
            var st = proj.state || {};
            G.PRiSM_state = G.PRiSM_state || {};
            if (st.model)        G.PRiSM_state.model = st.model;
            if (st.params)       G.PRiSM_state.params = st.params;
            if (st.paramFreeze)  G.PRiSM_state.paramFreeze = st.paramFreeze;
            if (st.lastFit)      G.PRiSM_state.lastFit = st.lastFit;
            if (st.presets)      G.PRiSM_state.presets = st.presets;
            if (st.pvt)          { G.PRiSM_pvt = st.pvt; G.PRiSM_state.pvt = st.pvt; }
            if (st.activePlot)   G.PRiSM_state.activePlot = st.activePlot;
            // Re-activate analysis if specified.
            if (st.activeAnalysisId) {
                return G.PRiSM_analysisData.activate(st.activeAnalysisId).catch(function () { /* silent */ });
            }
            return null;
        }).then(function () {
            _ga4('prism_project_loaded', {
                gauge_count: (proj.gaugeData || []).length,
                analysis_count: (proj.analysisData || []).length
            });
        });
    },

    new: function () {
        return _ensureInit().then(function () { return _wipeAll(); }).then(function () {
            _activeAnalysisId = null;
            G.PRiSM_dataset = null;
            _projectMeta = {
                name: 'Untitled project',
                createdAt: _now(),
                modifiedAt: _now()
            };
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
    d.innerHTML = '<span style="color:' + _theme().text3 + ';min-width:90px;">' + label + ':</span>' +
                  '<span style="color:' + _theme().text + ';">' + value + '</span>';
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
    listHost.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
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
    inp.accept = '.csv,.tsv,.txt,.dat,.asc,.xlsx,.xls';
    inp.style.display = 'none';
    inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        // Use PRiSM_loadFile if available; otherwise read as text and use a
        // very permissive CSV parser.
        var name = f.name;
        if (typeof G.PRiSM_loadFile === 'function') {
            G.PRiSM_loadFile(f).then(function () {
                // After PRiSM_loadFile parses, the dataset is on PRiSM_dataset.
                var ds = G.PRiSM_dataset;
                if (ds && ds.t && ds.t.length) {
                    G.PRiSM_gaugeData.add({
                        name: name.replace(/\.[^.]+$/, ''),
                        source: name,
                        well: ''
                    }, ds.t, ds.p, ds.q).then(function () {
                        G.PRiSM_renderGaugeManager(rootContainer);
                    });
                }
            }).catch(function (e) {
                alert('Import failed: ' + (e && e.message || e));
            });
        } else {
            // Inline minimal CSV reader
            var r = new FileReader();
            r.onload = function (ev) {
                var data = _quickCSV(ev.target.result);
                if (data.t.length) {
                    G.PRiSM_gaugeData.add({ name: name.replace(/\.[^.]+$/, ''), source: name },
                                          data.t, data.p, data.q).then(function () {
                        G.PRiSM_renderGaugeManager(rootContainer);
                    });
                } else {
                    alert('No data rows found in ' + name);
                }
            };
            r.readAsText(f);
        }
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
    listHost.style.gridTemplateColumns = 'repeat(auto-fill, minmax(300px, 1fr))';
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
// SECTION 7 — UI: PROJECT TOOLBAR
// ═══════════════════════════════════════════════════════════════════════

G.PRiSM_renderProjectToolbar = function (container) {
    if (!_hasDoc || !container) return;
    container.innerHTML = '';
    var T = _theme();
    var bar = document.createElement('div');
    bar.style.display = 'flex'; bar.style.alignItems = 'center';
    bar.style.gap = '6px'; bar.style.padding = '8px';
    bar.style.background = T.panel; bar.style.border = '1px solid ' + T.border;
    bar.style.borderRadius = '6px';

    var pName = document.createElement('span');
    pName.style.color = T.accent; pName.style.fontWeight = '600';
    pName.style.marginRight = '12px';
    pName.textContent = _projectMeta.name;
    bar.appendChild(pName);

    bar.appendChild(_mkBtn('New', null, function () {
        if (confirm('Discard current project? All unsaved data will be lost.')) {
            G.PRiSM_project.new().then(function () {
                pName.textContent = _projectMeta.name;
                if (typeof G.PRiSM_renderGaugeManager === 'function') {
                    var gh = document.getElementById('prism_gauge_manager');
                    if (gh) G.PRiSM_renderGaugeManager(gh);
                }
                if (typeof G.PRiSM_renderAnalysisManager === 'function') {
                    var ah = document.getElementById('prism_analysis_manager');
                    if (ah) G.PRiSM_renderAnalysisManager(ah);
                }
            });
        }
    }));
    bar.appendChild(_mkBtn('Open…', null, function () {
        var inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.prism,.json';
        inp.style.display = 'none';
        inp.addEventListener('change', function () {
            var f = inp.files && inp.files[0];
            if (!f) return;
            G.PRiSM_project.load(f).then(function () {
                pName.textContent = _projectMeta.name;
                if (typeof G.PRiSM_renderGaugeManager === 'function') {
                    var gh = document.getElementById('prism_gauge_manager');
                    if (gh) G.PRiSM_renderGaugeManager(gh);
                }
                if (typeof G.PRiSM_renderAnalysisManager === 'function') {
                    var ah = document.getElementById('prism_analysis_manager');
                    if (ah) G.PRiSM_renderAnalysisManager(ah);
                }
            }).catch(function (err) {
                alert('Load failed: ' + (err && err.message || err));
            });
        });
        document.body.appendChild(inp); inp.click();
        setTimeout(function () { try { document.body.removeChild(inp); } catch (e) {} }, 1000);
    }));
    bar.appendChild(_mkBtn('Save', null, function () {
        G.PRiSM_project.save().catch(function (err) {
            alert('Save failed: ' + (err && err.message || err));
        });
    }));
    bar.appendChild(_mkBtn('Save As…', null, function () {
        var nm = prompt('Project name', _projectMeta.name);
        if (nm) {
            G.PRiSM_project.setName(nm);
            pName.textContent = nm;
            G.PRiSM_project.save(nm + '.prism');
        }
    }));
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
    box.style.maxWidth = '640px'; box.style.width = '90%';
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
//   window.PRiSM_syntheticPLT(modelKey, params, t, q_total)
//                                         → { layers, totalRate, cumulative,
//                                             diagnostics }
//   window.PRiSM_renderPLTPanel(container) → void
//   window.PRiSM_inverseSim(modelKey, params, t, p)
//                                         → { q, converged, iterations,
//                                             rmse, diagnostics }
//   window.PRiSM_renderInverseSimPanel(container) → void
//   window.PRiSM_unitRateResponse(modelKey, params, tEval) → number[]
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • No external dependencies — pure vanilla JS, Math.*.
//   • Defensive: degenerate inputs return a clearly-flagged result instead
//     of throwing. Inverse sim returns {converged:false, ...} on failure
//     rather than throwing.
//   • PVT-aware: if window.PRiSM_pvt._computed is filled, the unit-rate
//     response is dimensionalised to real pressure (psi per STB/d) so the
//     recovered q from inverse sim is in real units (STB/d or MSCF/d).
//     Otherwise the result is in dimensionless td/pd.
//
// FOUNDATION PRIMITIVES IN SCOPE
//   PRiSM_MODELS[modelKey].pd(td, params)            forward pressure
//   PRiSM_logspace(min, max, n)                      log spaced grid
//   PRiSM_compute_bourdet(t, dp, L)                  Bourdet derivative
//   PRiSM_lm(modelFn, data, p0, bounds, freeze, opts)  LM solver
//   PRiSM_state.lastFit / .model / .params           live UI state
//   PRiSM_pvt._computed                              PVT block (Layer 16)
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

// Get current PVT computed state (or null).
function _pvtComputed() {
    var pvt = G.PRiSM_pvt;
    if (!pvt || !pvt._computed) return null;
    var c = pvt._computed;
    if (!_isNum(c.ct) || !_isNum(c.mu) || !_isNum(c.B)) return null;
    if (!_isNum(pvt.h) || !_isNum(pvt.rw) || pvt.h <= 0 || pvt.rw <= 0) return null;
    return {
        h:   pvt.h, rw: pvt.rw, phi: pvt.phi,
        ct:  c.ct, mu: c.mu,   B:   c.B,
        q:   pvt.q,
        fluidType: pvt.fluidType
    };
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
    // kh per layer = perm × thickness × kh-fraction (proxy units).
    var pvt = _pvtComputed();
    var hTot = pvt ? pvt.h : 1.0;
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
 * PRiSM_syntheticPLT(modelKey, params, t, q_total)
 *
 * Reconstruct per-layer rate contribution as a function of time.
 *
 * @param {string}   modelKey   e.g. 'multiLayerNoXF', 'multiLayerXF',
 *                              'homogeneous', 'radialComposite'.
 * @param {object}   params     fitted parameter set
 * @param {number[]} t          time array (hours, monotonically increasing)
 * @param {number[]} q_total    total wellbore rate at each t (same length)
 * @return {object}             { layers, totalRate, cumulative, diagnostics }
 */
G.PRiSM_syntheticPLT = function PRiSM_syntheticPLT(modelKey, params, t, q_total) {
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
            var f = _xfFractionAt(t[ix], lyrX);
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
            var f2 = _xfFractionAt(t[i2], lyr2);
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
// SECTION 3 — Convolution matrix builder + unit-rate response
// ════════════════════════════════════════════════════════════════════
//
// Forward simulation in a constant-rate test:
//   Δp(t) = q · g_unit(t)             where g_unit(t) = pwd(td(t)) × kh-conv
// Multi-rate convolution (Duhamel superposition):
//   Δp(t_n) = Σ_{i=1}^{n} (q_i - q_{i-1}) · g_unit(t_n - t_{i-1})
// In matrix form for a strictly piecewise-constant rate q with q_0 := 0:
//   p(t_n) - p_initial = Σ_{i=1}^{n} g_unit(t_n - t_{i-1}) · (q_i - q_{i-1})
// or (after re-arranging into a direct rate decomposition):
//   p(t_n) - p_initial = Σ_{i=1}^{n} A_{n,i} · q_i
//   where A_{n,i} = g_unit(t_n - t_{i-1}) - g_unit(t_n - t_i)
//                                          (with g_unit(0) := 0 by convention)
// A is lower-triangular.

/**
 * PRiSM_unitRateResponse(modelKey, params, tEval) → number[]
 *
 * Compute the dimensional unit-rate pressure response g_unit(t) = pd(td(t))
 * scaled by the dimensional factor 141.2·μ·B/(k·h) (psi per STB/d) when
 * PVT is available, or returns the dimensionless pd(td(t)) when not.
 *
 * @param {string}   modelKey  registry key
 * @param {object}   params    parameter set
 * @param {number[]} tEval     time grid (hours)
 * @return {number[]}          unit-rate response, same length as tEval
 */
G.PRiSM_unitRateResponse = function PRiSM_unitRateResponse(modelKey, params, tEval) {
    if (!Array.isArray(tEval)) throw new Error('PRiSM_unitRateResponse: tEval must be an array');
    var spec = _model(modelKey);
    if (!spec || typeof spec.pd !== 'function') {
        throw new Error('PRiSM_unitRateResponse: unknown model "' + modelKey + '"');
    }
    var pvt = _pvtComputed();
    // Dimensionless: td = 0.000264 · k · t / (φ · μ · ct · rw²)
    // We need k to non-dimensionalise. Try param.k_md → state.lastFit → fallback.
    var k_md = null;
    if (params && _isNum(params.k_md)) k_md = params.k_md;
    var st = G.PRiSM_state;
    if (!_isNum(k_md) && st && st.lastFit && _isNum(st.lastFit.k_md)) k_md = st.lastFit.k_md;
    if (!_isNum(k_md) && st && st.lastFit && _isNum(st.lastFit.kh_md_ft) && pvt) {
        k_md = st.lastFit.kh_md_ft / pvt.h;
    }
    var dimensional = !!pvt && _isNum(k_md) && k_md > 0;
    // td factor (1/hr): td = factor · t   (when t is in hours)
    var tdFactor;
    if (dimensional) {
        tdFactor = 0.000264 * k_md / (pvt.phi * pvt.mu * pvt.ct * pvt.rw * pvt.rw);
    } else {
        // Use t directly as td (caller-supplied dimensionless time grid).
        tdFactor = 1;
    }
    // Build td array, skipping non-positive entries (we'll pad with 0).
    var td = new Array(tEval.length);
    for (var i = 0; i < tEval.length; i++) {
        var tv = tEval[i];
        if (!_isNum(tv) || tv <= 0) {
            td[i] = null;
        } else {
            td[i] = tdFactor * tv;
        }
    }
    // Evaluate pd at every td > 0 in one pass (some models accept arrays).
    var pdArr;
    var validIdx = [];
    var validTd = [];
    for (var j = 0; j < td.length; j++) {
        if (td[j] !== null) {
            validIdx.push(j);
            validTd.push(td[j]);
        }
    }
    if (validTd.length === 0) {
        return new Array(tEval.length).fill(0);
    }
    try {
        pdArr = spec.pd(validTd, params);
        if (!Array.isArray(pdArr)) {
            // If single-value returned, wrap.
            pdArr = [pdArr];
        }
    } catch (e) {
        // Fallback: evaluate point-by-point so a single bad td doesn't kill
        // the whole batch.
        pdArr = new Array(validTd.length);
        for (var p = 0; p < validTd.length; p++) {
            try { pdArr[p] = spec.pd([validTd[p]], params)[0]; }
            catch (e2) { pdArr[p] = NaN; }
        }
    }
    // Reassemble a same-length output, dimensionalising.
    var out = new Array(tEval.length);
    for (var z = 0; z < tEval.length; z++) out[z] = 0;
    var dimFactor = 1;
    if (dimensional) {
        // psi per STB/d at unit rate q=1: 141.2·μ·B / (k·h)
        dimFactor = 141.2 * pvt.mu * pvt.B / (k_md * pvt.h);
    }
    for (var v = 0; v < validIdx.length; v++) {
        var idx = validIdx[v];
        var pdv = pdArr[v];
        if (!_isNum(pdv)) pdv = 0;
        out[idx] = dimFactor * pdv;
    }
    return out;
};

// Build the lower-triangular convolution matrix A[n][i] from the unit-rate
// response g_unit:
//   A[n][i] = g_unit(t_n - t_{i-1}) - g_unit(t_n - t_i)
//   with g_unit(0) := 0.
// Returns { A: Array<Array<number>>, gUnit: number[] } where gUnit is the
// raw unit-rate response evaluated at the difference times.
function _buildConvMatrix(modelKey, params, t) {
    var n = t.length;
    if (n === 0) return { A: [], gUnit: [] };
    // We need g_unit at all unique time-difference values (t_n - t_{i-1}).
    // For an arbitrary irregular grid, the cheapest approach is to compute
    // the full upper-triangular set of (t_n - t_i) values and evaluate
    // g_unit at the union. We just compute A directly: for each row n,
    // we evaluate g_unit at (t_n - t_0), (t_n - t_1), ..., (t_n - t_{n-1}).
    // This is O(n^2) evaluations of the model. For n up to a few hundred
    // this is fine (each pd call is a Stehfest sum of 12 terms).
    var A = new Array(n);
    for (var i = 0; i < n; i++) A[i] = new Array(n).fill(0);
    // Pre-compute g_unit at each unique difference. We collect them per row
    // and do a batched call. Simpler: evaluate row-by-row.
    for (var nRow = 0; nRow < n; nRow++) {
        // Build array of differences t_nRow - t_k for k = 0..nRow.
        var diffs = new Array(nRow + 1);
        var diffIdx = new Array(nRow + 1);  // map back to original "lag" index
        for (var k = 0; k <= nRow; k++) {
            diffs[k] = t[nRow] - t[k];
            diffIdx[k] = k;
        }
        // diffs[nRow] = 0 (last entry). We need g_unit at strictly positive
        // arguments; we set g_unit(0) := 0.
        var gAtDiff;
        try {
            gAtDiff = G.PRiSM_unitRateResponse(modelKey, params, diffs);
        } catch (e) {
            // Bubble up — the inverse-sim caller will trap and report.
            throw e;
        }
        // gAtDiff[k] = g_unit(t_n - t_k). For the matrix A[n][i] (i = 1..n)
        // we want g_unit(t_n - t_{i-1}) - g_unit(t_n - t_i). With i ∈ [1,n]
        // running over the SAMPLES, the "sample index" in our 0-based grid
        // is i' = i - 1 ∈ [0, n-1]. We allow rate updates AT every sample,
        // so q_i defines the rate from t_{i-1} to t_i. The convolution
        // contribution of q_i to row n is:
        //   A[n][i'] = g_unit(t_n - t_{i-1}) - g_unit(t_n - t_i)
        //            = gAtDiff[i-1] - gAtDiff[i]  for i = 1..n
        // (gAtDiff[i] is only defined for i ≤ nRow; for i > nRow the rate
        // hasn't started yet — A[n][i'] = 0 by causality).
        for (var iCol = 0; iCol < n; iCol++) {
            if (iCol > nRow) {
                A[nRow][iCol] = 0;
                continue;
            }
            // i = iCol + 1, i-1 = iCol  (sample indices are 0-based)
            var lagPrev = iCol;        // i - 1
            var lagCurr = iCol + 1;    // i
            var gPrev = (lagPrev <= nRow) ? gAtDiff[lagPrev] : 0;
            var gCurr = (lagCurr <= nRow) ? gAtDiff[lagCurr] : 0;
            // gAtDiff was sized to nRow+1, so lagCurr can equal nRow+1 only
            // when iCol == nRow → lagCurr > nRow.length-1; in that case gCurr = 0.
            if (!_isNum(gPrev)) gPrev = 0;
            if (!_isNum(gCurr)) gCurr = 0;
            A[nRow][iCol] = gPrev - gCurr;
        }
    }
    return { A: A, gUnit: null };
}


// ════════════════════════════════════════════════════════════════════
// SECTION 4 — Inverse simulation
// ════════════════════════════════════════════════════════════════════
//
// Given p(t) and a model + params, recover q(t) by solving the linear
// system A · q = (p_initial - p) where A is the lower-triangular Duhamel
// convolution matrix from SECTION 3.
//
// Algorithm:
//   1. Build A and the RHS = (p[0] - p[i]).
//   2. Solve (Aᵀ A + α I) q = Aᵀ RHS  (Tikhonov-regularised normal eqn).
//      The α regularisation kills the high-frequency oscillation that a
//      naive direct solve develops at the late-time tail.
//   3. Clip negative q values to zero (NNLS-light enforcement; for a
//      production well sustained negative rate is non-physical and almost
//      always a numerical artefact of the late-time tail).
//   4. Forward-simulate p_predicted from the recovered q and report RMSE.

/**
 * PRiSM_inverseSim(modelKey, params, t, p) → result
 *
 * @param {string}   modelKey
 * @param {object}   params
 * @param {number[]} t        time array (hours)
 * @param {number[]} p        pressure array (psi or dimensionless), same length
 * @return {object}           {
 *     q: number[],         recovered rate at each t
 *     converged: boolean,
 *     iterations: number,
 *     rmse: number,
 *     diagnostics: { method, regularisation, notes }
 * }
 */
G.PRiSM_inverseSim = function PRiSM_inverseSim(modelKey, params, t, p) {
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
    // Build convolution matrix.
    var A;
    try {
        var built = _buildConvMatrix(modelKey, params, t);
        A = built.A;
    } catch (e) {
        return _inverseFail('build convolution matrix failed: ' + (e && e.message), t.length);
    }
    var n = t.length;
    // RHS = (p[0] - p[i]); for a producing well (drawdown), p decreases so
    // the RHS is non-negative.
    var rhs = new Array(n);
    for (var i = 0; i < n; i++) rhs[i] = (p[0] - p[i]);

    // Tikhonov α — choose ~1e-8 of the matrix scale. Compute the matrix
    // norm squared (Frobenius²) as a proxy.
    var fro2 = 0;
    for (var ri = 0; ri < n; ri++) {
        for (var rj = 0; rj <= ri; rj++) {
            fro2 += A[ri][rj] * A[ri][rj];
        }
    }
    var alpha = 1e-8 * Math.max(1e-30, fro2);

    // Solve normal equations (AᵀA + αI) q = Aᵀ rhs.
    // We assemble M = AᵀA + αI and v = Aᵀ rhs explicitly.
    var M = new Array(n);
    for (var mi = 0; mi < n; mi++) M[mi] = new Array(n).fill(0);
    var v = new Array(n).fill(0);
    for (var col = 0; col < n; col++) {
        for (var col2 = col; col2 < n; col2++) {
            var dot = 0;
            // A[r][col] is non-zero only for r >= col (lower-tri).
            for (var r = Math.max(col, col2); r < n; r++) {
                dot += A[r][col] * A[r][col2];
            }
            M[col][col2] = dot;
            if (col !== col2) M[col2][col] = dot;
        }
        // v[col] = Σ_r A[r][col] · rhs[r]
        var dotV = 0;
        for (var rr = col; rr < n; rr++) dotV += A[rr][col] * rhs[rr];
        v[col] = dotV;
        // Tikhonov diagonal.
        M[col][col] += alpha;
    }
    var q;
    try {
        q = _solveLinear(M, v);
    } catch (e) {
        return _inverseFail('linear solve failed: ' + (e && e.message), n);
    }
    // Non-negativity clip (NNLS-light). Most physically meaningful for
    // single-rate drawdown; for a buildup the user can disable this by
    // setting params.allowNegative = true (advanced).
    var allowNeg = !!(params && params.allowNegative);
    var clippedCount = 0;
    if (!allowNeg) {
        for (var iC = 0; iC < n; iC++) {
            if (q[iC] < 0) {
                q[iC] = 0;
                clippedCount++;
            }
        }
    }
    // Forward-simulate p_predicted = A · q + p[0] and compute RMSE.
    var pPred = new Array(n);
    for (var rR = 0; rR < n; rR++) {
        var s2 = 0;
        for (var cC = 0; cC <= rR; cC++) s2 += A[rR][cC] * q[cC];
        pPred[rR] = p[0] - s2;
    }
    var sse = 0;
    for (var iR = 0; iR < n; iR++) {
        var d = (p[iR] - pPred[iR]);
        sse += d * d;
    }
    var rmse = Math.sqrt(sse / n);
    var converged = isFinite(rmse);

    var notes = 'Tikhonov-regularised linear deconvolution (α = '
              + _fmtSig(alpha, 3) + '). ';
    if (clippedCount > 0) {
        notes += clippedCount + ' negative q value' +
                 (clippedCount === 1 ? '' : 's') + ' clipped to zero. ';
    }
    var pvt = _pvtComputed();
    if (pvt) {
        notes += 'Recovered q in real units (' +
                 (pvt.fluidType === 'gas' ? 'MSCF/d' :
                  pvt.fluidType === 'water' ? 'BWPD' : 'STB/d') + '). ';
    } else {
        notes += 'PVT not computed — recovered q in dimensionless units. ';
    }

    return {
        q:           q,
        converged:   converged,
        iterations:  1,
        rmse:        rmse,
        pPredicted:  pPred,
        diagnostics: {
            method:         'linear-deconvolution',
            regularisation: 'tikhonov',
            alpha:          alpha,
            clipped:        clippedCount,
            dimensional:    !!pvt,
            notes:          notes
        }
    };
};

function _inverseFail(reason, n) {
    return {
        q:          new Array(Math.max(1, n)).fill(0),
        converged:  false,
        iterations: 0,
        rmse:       NaN,
        pPredicted: [],
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
// Layout (top-to-bottom):
//   1. Header + status line (model + N layers detected)
//   2. Stacked-area canvas (per-layer rate vs time)
//   3. Per-layer table (label | kh | initial frac | final frac | EUR)
//   4. Action row: Compute | Export CSV
// ════════════════════════════════════════════════════════════════════

var _PLT_CANVAS_ID = 'prism_plt_canvas';
var _PLT_TABLE_ID  = 'prism_plt_table';
var _PLT_MSG_ID    = 'prism_plt_msg';
var _PLT_NOTE_ID   = 'prism_plt_note';
var _pltLastResult = null;

G.PRiSM_renderPLTPanel = function PRiSM_renderPLTPanel(container) {
    if (!_hasDoc || !container) return;
    var T = _theme();
    container.innerHTML =
          '<div class="prism-plt-card" style="background:' + T.panel + '; border:1px solid ' + T.border + '; border-radius:6px; padding:14px;">'
        +   '<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:8px;">'
        +     '<div style="font-weight:600; color:' + T.text + '; font-size:14px;">Synthetic PLT — per-layer rate</div>'
        +     '<div style="display:flex; gap:8px;">'
        +       '<button id="prism_plt_compute" type="button" '
        +         'style="padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043; '
        +         'border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Compute</button>'
        +       '<button id="prism_plt_export" type="button" '
        +         'style="padding:6px 14px; background:#21262d; color:' + T.text + '; border:1px solid ' + T.border + '; '
        +         'border-radius:4px; cursor:pointer; font-size:12px;">Export CSV</button>'
        +     '</div>'
        +   '</div>'
        +   '<div id="' + _PLT_MSG_ID + '" style="font-size:12px; color:' + T.text2 + '; margin-bottom:10px;">'
        +     'Click <b>Compute</b> to derive per-layer rate contributions from the active fit.'
        +   '</div>'
        +   '<canvas id="' + _PLT_CANVAS_ID + '" width="800" height="320" '
        +     'style="display:block; background:' + T.bg + '; border:1px solid ' + T.border + '; border-radius:6px; max-width:100%;"></canvas>'
        +   '<div id="' + _PLT_TABLE_ID + '" style="margin-top:12px; overflow-x:auto;">'
        +     '<div style="color:' + T.text3 + '; font-size:12px;">No layer data yet.</div>'
        +   '</div>'
        +   '<div id="' + _PLT_NOTE_ID + '" style="margin-top:8px; font-size:11px; color:' + T.text3 + '; line-height:1.5;"></div>'
        + '</div>';
    var btnC = document.getElementById('prism_plt_compute');
    var btnE = document.getElementById('prism_plt_export');
    if (btnC) btnC.onclick = _pltCompute;
    if (btnE) btnE.onclick = _pltExport;
};

function _pltCompute() {
    var T = _theme();
    var msg = document.getElementById(_PLT_MSG_ID);
    var st = G.PRiSM_state || {};
    var ds = G.PRiSM_dataset || null;
    var lf = st.lastFit || null;
    var modelKey = (lf && lf.modelKey) || st.model;
    var params = (lf && lf.params) || st.params || {};
    var multiKeys = { multiLayerNoXF: 1, multiLayerXF: 1, twoLayerXF: 1,
                      mlHorizontalXF: 1, mlHorizontalNoXF: 1,
                      multiLatMLXF: 1, multiLatMLNoXF: 1 };
    if (!modelKey || !multiKeys[modelKey]) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">PLT requires a multi-layer model. Active model: <b>'
            + _esc(modelKey || 'none') + '</b>. Switch to multiLayerXF / multiLayerNoXF / twoLayerXF and re-fit.</span>';
        _pltLastResult = null;
        _drawPLTChart([]);
        _renderPLTTable(null);
        return;
    }
    if (!ds || !Array.isArray(ds.t) || ds.t.length < 2) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">No active dataset — load data on the Data tab first.</span>';
        return;
    }
    // Derive q_total from dataset rate column if present, else assume the
    // user-entered PVT q is the constant well rate.
    var t = ds.t.slice();
    var qTot;
    if (Array.isArray(ds.q) && ds.q.length === t.length) {
        qTot = ds.q.slice();
    } else {
        var pvt = G.PRiSM_pvt;
        var qConst = (pvt && _isNum(pvt.q)) ? pvt.q : 1000;
        qTot = new Array(t.length);
        for (var i = 0; i < t.length; i++) qTot[i] = qConst;
    }
    var result;
    try {
        result = G.PRiSM_syntheticPLT(modelKey, params, t, qTot);
    } catch (e) {
        if (msg) msg.innerHTML = '<span style="color:' + T.red + ';">PLT computation failed: '
            + _esc(e && e.message) + '</span>';
        return;
    }
    _pltLastResult = { result: result, t: t };
    if (msg) {
        msg.innerHTML = '<span style="color:' + T.green + ';">'
            + result.diagnostics.nLayers + ' layer'
            + (result.diagnostics.nLayers === 1 ? '' : 's') + ' over '
            + t.length + ' time samples. Total kh (proxy units): '
            + _fmtSig(result.diagnostics.totalKh, 3)
            + '. Rate-balance residual: ' + _fmtSig(result.diagnostics.rateCheck, 3) + '.</span>';
    }
    _drawPLTChart(result.layers, t);
    _renderPLTTable(result);
    var noteEl = document.getElementById(_PLT_NOTE_ID);
    if (noteEl) noteEl.textContent = result.diagnostics.notes || '';
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_plt_compute', { model: modelKey, n_layers: result.diagnostics.nLayers }); }
        catch (e) { /* swallow */ }
    }
}

// Stacked-area chart of per-layer rate contribution vs time.
function _drawPLTChart(layers, t) {
    if (!_hasDoc) return;
    var canvas = document.getElementById(_PLT_CANVAS_ID);
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var T = _theme();
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Background.
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
    var pad = { top: 24, right: 90, bottom: 38, left: 60 };
    if (!Array.isArray(layers) || !layers.length || !Array.isArray(t) || !t.length) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No PLT data yet.', w / 2, h / 2);
        return;
    }
    // Plot area.
    var plotX = pad.left;
    var plotY = pad.top;
    var plotW = w - pad.left - pad.right;
    var plotH = h - pad.top - pad.bottom;
    // X scale — log if t spans more than a decade, else linear.
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
    // Y scale = total rate at every sample.
    var yMax = 0;
    for (var ti = 0; ti < t.length; ti++) {
        var s = 0;
        for (var li = 0; li < layers.length; li++) {
            s += (layers[li].rate[ti] || 0);
        }
        if (s > yMax) yMax = s;
    }
    if (yMax <= 0) yMax = 1;
    function yMap(qv) {
        return plotY + plotH * (1 - qv / yMax);
    }
    // Grid + axes.
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // Y-grid + labels (5 lines).
    for (var g = 0; g <= 5; g++) {
        var yp = plotY + plotH * g / 5;
        ctx.beginPath(); ctx.moveTo(plotX, yp); ctx.lineTo(plotX + plotW, yp); ctx.stroke();
        var qLabel = yMax * (1 - g / 5);
        ctx.fillText(_fmtSig(qLabel, 3), plotX - 6, yp);
    }
    // X-grid + labels.
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var nXTicks = 5;
    for (var xt = 0; xt <= nXTicks; xt++) {
        var frac = xt / nXTicks;
        var tv;
        if (useLog) {
            var lo = Math.log10(tMin), hi = Math.log10(tMax);
            tv = Math.pow(10, lo + frac * (hi - lo));
        } else {
            tv = tMin + frac * (tMax - tMin);
        }
        var xp = xMap(tv);
        ctx.beginPath(); ctx.moveTo(xp, plotY); ctx.lineTo(xp, plotY + plotH); ctx.stroke();
        ctx.fillText(_fmtSig(tv, 3), xp, plotY + plotH + 4);
    }
    // Axis labels.
    ctx.fillStyle = T.text;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('time (hr)', plotX + plotW / 2, h - 6);
    ctx.save();
    ctx.translate(14, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('rate', 0, 0);
    ctx.restore();
    // Plot stacked areas. Build cumulative arrays bottom-up.
    var cum = new Array(t.length).fill(0);
    for (var lk = 0; lk < layers.length; lk++) {
        var lyr = layers[lk];
        var color = _LAYER_COLORS[lk % _LAYER_COLORS.length];
        // Build polygon: (t, cum[i] + r[i]) along the top, (t, cum[i]) along
        // the bottom (in reverse).
        ctx.beginPath();
        // Top edge (left → right).
        for (var jj = 0; jj < t.length; jj++) {
            var top = cum[jj] + (lyr.rate[jj] || 0);
            var xp2 = xMap(t[jj]);
            var yp2 = yMap(top);
            if (jj === 0) ctx.moveTo(xp2, yp2);
            else ctx.lineTo(xp2, yp2);
        }
        // Bottom edge (right → left).
        for (var kk = t.length - 1; kk >= 0; kk--) {
            ctx.lineTo(xMap(t[kk]), yMap(cum[kk]));
        }
        ctx.closePath();
        ctx.fillStyle = color + '99';     // 60 % opacity
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        // Update cumulative.
        for (var ic = 0; ic < t.length; ic++) cum[ic] += (lyr.rate[ic] || 0);
    }
    // Legend.
    var lx = plotX + plotW + 14;
    var ly = plotY + 4;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (var le = 0; le < layers.length; le++) {
        var c2 = _LAYER_COLORS[le % _LAYER_COLORS.length];
        ctx.fillStyle = c2;
        ctx.fillRect(lx, ly + le * 16 + 2, 10, 10);
        ctx.fillStyle = T.text;
        var lbl = layers[le].label;
        if (lbl.length > 12) lbl = lbl.slice(0, 11) + '…';
        ctx.fillText(lbl, lx + 14, ly + le * 16);
    }
}

function _renderPLTTable(result) {
    if (!_hasDoc) return;
    var host = document.getElementById(_PLT_TABLE_ID);
    if (!host) return;
    if (!result || !result.layers || !result.layers.length) {
        host.innerHTML = '<div style="color:#6e7681; font-size:12px;">No layer data yet.</div>';
        return;
    }
    var T = _theme();
    var pvt = _pvtComputed();
    var rateUnit = pvt ? (pvt.fluidType === 'gas' ? 'MSCF/d' : pvt.fluidType === 'water' ? 'BWPD' : 'STB/d') : '(rel.)';
    var khUnit = pvt ? 'md·ft' : '(rel.)';
    var h = '<table style="width:100%; border-collapse:collapse; font-size:12px; color:' + T.text + ';">';
    h += '<thead><tr style="background:' + T.bg + '; border-bottom:1px solid ' + T.border + ';">'
       + '<th style="text-align:left; padding:6px 8px;">Layer</th>'
       + '<th style="text-align:right; padding:6px 8px;">kh (' + khUnit + ')</th>'
       + '<th style="text-align:right; padding:6px 8px;">Initial frac</th>'
       + '<th style="text-align:right; padding:6px 8px;">Final frac</th>'
       + '<th style="text-align:right; padding:6px 8px;">Mean frac</th>'
       + '<th style="text-align:right; padding:6px 8px;">EUR (cum, ' + rateUnit + '·hr)</th>'
       + '</tr></thead><tbody>';
    for (var i = 0; i < result.layers.length; i++) {
        var L = result.layers[i];
        var swatch = _LAYER_COLORS[i % _LAYER_COLORS.length];
        h += '<tr style="border-bottom:1px solid ' + T.border + ';">'
           + '<td style="padding:6px 8px;"><span style="display:inline-block; width:10px; height:10px; '
           + 'background:' + swatch + '; vertical-align:middle; margin-right:6px;"></span>'
           + _esc(L.label) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmtSig(L.kh, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.initialFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.finalFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.rateFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmtSig(L.cumulative, 4) + '</td>'
           + '</tr>';
    }
    h += '</tbody></table>';
    host.innerHTML = h;
}

function _pltExport() {
    if (!_pltLastResult || !_pltLastResult.result) {
        var msg = document.getElementById(_PLT_MSG_ID);
        if (msg) {
            var T = _theme();
            msg.innerHTML = '<span style="color:' + T.yellow + ';">Compute first, then export.</span>';
        }
        return;
    }
    var t = _pltLastResult.t;
    var layers = _pltLastResult.result.layers;
    var lines = [];
    var hdr = ['t_hr'];
    for (var k = 0; k < layers.length; k++) hdr.push('q_layer_' + (k + 1) + ' (' + layers[k].label + ')');
    hdr.push('q_total');
    lines.push(hdr.join(','));
    for (var i = 0; i < t.length; i++) {
        var row = [t[i]];
        var sum = 0;
        for (var lk = 0; lk < layers.length; lk++) {
            var rv = layers[lk].rate[i] || 0;
            row.push(rv);
            sum += rv;
        }
        row.push(sum);
        lines.push(row.join(','));
    }
    var csv = lines.join('\n');
    if (typeof Blob === 'function' && _hasDoc) {
        try {
            var blob = new Blob([csv], { type: 'text/csv' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'prism-synthetic-plt.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        } catch (e) {
            // Fallback: dump to a textarea.
            var ta = document.createElement('textarea');
            ta.value = csv;
            ta.style.cssText = 'width:100%; height:200px;';
            var host = document.getElementById(_PLT_TABLE_ID);
            if (host) {
                host.appendChild(ta);
                ta.select();
            }
        }
    }
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_plt_export', { n_rows: t.length, n_layers: layers.length }); }
        catch (e) { /* swallow */ }
    }
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6 — UI: inverse-simulation panel
// ════════════════════════════════════════════════════════════════════
//
// Layout:
//   1. Header + status line (model + dataset summary)
//   2. "Run inverse simulation" button + "Save as analysis-data" button
//   3. Two stacked canvases (top: input p(t); bottom: recovered q(t))
//   4. Status / RMSE line
// ════════════════════════════════════════════════════════════════════

var _INV_CANVAS_P_ID = 'prism_inv_canvas_p';
var _INV_CANVAS_Q_ID = 'prism_inv_canvas_q';
var _INV_MSG_ID      = 'prism_inv_msg';
var _INV_NOTE_ID     = 'prism_inv_note';
var _invLastResult   = null;

G.PRiSM_renderInverseSimPanel = function PRiSM_renderInverseSimPanel(container) {
    if (!_hasDoc || !container) return;
    var T = _theme();
    container.innerHTML =
          '<div class="prism-inv-card" style="background:' + T.panel + '; border:1px solid ' + T.border + '; border-radius:6px; padding:14px;">'
        +   '<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:8px;">'
        +     '<div style="font-weight:600; color:' + T.text + '; font-size:14px;">Inverse simulation — recover q(t) from p(t)</div>'
        +     '<div style="display:flex; gap:8px;">'
        +       '<button id="prism_inv_run" type="button" '
        +         'style="padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043; '
        +         'border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Run inverse simulation</button>'
        +       '<button id="prism_inv_save" type="button" '
        +         'style="padding:6px 14px; background:#21262d; color:' + T.text + '; border:1px solid ' + T.border + '; '
        +         'border-radius:4px; cursor:pointer; font-size:12px;">Save as analysis-data</button>'
        +     '</div>'
        +   '</div>'
        +   '<div id="' + _INV_MSG_ID + '" style="font-size:12px; color:' + T.text2 + '; margin-bottom:10px;">'
        +     'Click <b>Run</b> to deconvolve the rate history from the active dataset using the active model.'
        +   '</div>'
        +   '<div style="display:flex; flex-direction:column; gap:8px;">'
        +     '<canvas id="' + _INV_CANVAS_P_ID + '" width="800" height="180" '
        +       'style="display:block; background:' + T.bg + '; border:1px solid ' + T.border + '; border-radius:6px; max-width:100%;"></canvas>'
        +     '<canvas id="' + _INV_CANVAS_Q_ID + '" width="800" height="180" '
        +       'style="display:block; background:' + T.bg + '; border:1px solid ' + T.border + '; border-radius:6px; max-width:100%;"></canvas>'
        +   '</div>'
        +   '<div id="' + _INV_NOTE_ID + '" style="margin-top:8px; font-size:11px; color:' + T.text3 + '; line-height:1.5;"></div>'
        + '</div>';
    var btnR = document.getElementById('prism_inv_run');
    var btnS = document.getElementById('prism_inv_save');
    if (btnR) btnR.onclick = _invRun;
    if (btnS) btnS.onclick = _invSave;
};

function _invRun() {
    var T = _theme();
    var msg = document.getElementById(_INV_MSG_ID);
    var st = G.PRiSM_state || {};
    var ds = G.PRiSM_dataset || null;
    var lf = st.lastFit || null;
    var modelKey = (lf && lf.modelKey) || st.model;
    var params = (lf && lf.params) || st.params || {};
    if (!modelKey || !_model(modelKey)) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">No active model — pick one on the Model tab and re-fit.</span>';
        return;
    }
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || ds.t.length < 4) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">No active dataset (need ≥ 4 (t, p) samples).</span>';
        return;
    }
    var t = ds.t.slice();
    var p = ds.p.slice();
    var result;
    try {
        result = G.PRiSM_inverseSim(modelKey, params, t, p);
    } catch (e) {
        if (msg) msg.innerHTML = '<span style="color:' + T.red + ';">Inverse-sim threw: ' + _esc(e && e.message) + '</span>';
        return;
    }
    _invLastResult = { result: result, t: t, p: p, modelKey: modelKey };
    if (!result.converged) {
        if (msg) msg.innerHTML = '<span style="color:' + T.red + ';">Inverse simulation did NOT converge: '
            + _esc(result.diagnostics.error || 'unknown reason') + '</span>';
    } else {
        if (msg) msg.innerHTML = '<span style="color:' + T.green + ';">Recovered q(t) for '
            + t.length + ' samples. RMSE(p) = ' + _fmtSig(result.rmse, 4) + '.</span>';
    }
    _drawInvCharts(t, p, result);
    var noteEl = document.getElementById(_INV_NOTE_ID);
    if (noteEl) noteEl.textContent = result.diagnostics.notes || '';
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_inverse_sim_run', { model: modelKey, n: t.length, rmse: result.rmse }); }
        catch (e) { /* swallow */ }
    }
}

function _invSave() {
    var T = _theme();
    var msg = document.getElementById(_INV_MSG_ID);
    if (!_invLastResult || !_invLastResult.result || !_invLastResult.result.converged) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">Run inverse simulation first.</span>';
        return;
    }
    var t = _invLastResult.t;
    var q = _invLastResult.result.q;
    var p = _invLastResult.p;
    // Save as a new analysis-data entry. Different host integrations expose
    // analysis-data differently — try the documented options in order.
    var saved = false;
    var modelKey = _invLastResult.modelKey;
    if (G.PRiSM_analysisData && typeof G.PRiSM_analysisData.add === 'function') {
        try {
            G.PRiSM_analysisData.add({
                kind:    'rate-recovered',
                modelKey: modelKey,
                t:       t.slice(),
                q:       q.slice(),
                p:       p.slice(),
                rmse:    _invLastResult.result.rmse,
                source:  'PRiSM_inverseSim',
                created: new Date().toISOString()
            });
            saved = true;
        } catch (e) { /* fall through to next strategy */ }
    }
    if (!saved && Array.isArray(G.PRiSM_analysisData)) {
        try {
            G.PRiSM_analysisData.push({
                kind:    'rate-recovered',
                modelKey: modelKey,
                t:       t.slice(),
                q:       q.slice(),
                rmse:    _invLastResult.result.rmse,
                created: new Date().toISOString()
            });
            saved = true;
        } catch (e) { /* fall through */ }
    }
    if (!saved) {
        // Fallback: stash on the dataset.
        if (G.PRiSM_dataset) {
            G.PRiSM_dataset.q_recovered = q.slice();
            G.PRiSM_dataset.q_recovered_meta = {
                modelKey: modelKey,
                rmse: _invLastResult.result.rmse,
                created: new Date().toISOString()
            };
            saved = true;
        }
    }
    if (msg) {
        if (saved) {
            msg.innerHTML = '<span style="color:' + T.green + ';">Recovered q saved as analysis-data ('
                + t.length + ' points).</span>';
        } else {
            msg.innerHTML = '<span style="color:' + T.yellow + ';">Could not locate an analysis-data sink. Recovered q is still available on _invLastResult for export.</span>';
        }
    }
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_inverse_sim_save', { model: modelKey, n: t.length, saved: saved }); }
        catch (e) { /* swallow */ }
    }
}

function _drawInvCharts(t, p, result) {
    if (!_hasDoc) return;
    var canvasP = document.getElementById(_INV_CANVAS_P_ID);
    var canvasQ = document.getElementById(_INV_CANVAS_Q_ID);
    if (canvasP) _drawInvSeries(canvasP, t, p, result.pPredicted, 'pressure', 'p (psi or dimensionless)');
    if (canvasQ) _drawInvSeries(canvasQ, t, result.q, null, 'rate', 'q (rate units)');
}

// Draw a single (t, y) series — optionally with a model overlay.
function _drawInvSeries(canvas, t, y, overlay, kind, ylabel) {
    var ctx = canvas.getContext('2d');
    var T = _theme();
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
    var pad = { top: 22, right: 60, bottom: 32, left: 60 };
    var plotX = pad.left, plotY = pad.top;
    var plotW = w - pad.left - pad.right;
    var plotH = h - pad.top - pad.bottom;
    if (!t.length || !y.length) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('No data', w / 2, h / 2);
        return;
    }
    var tMin = Infinity, tMax = -Infinity;
    var yMin = Infinity, yMax = -Infinity;
    for (var i = 0; i < t.length; i++) {
        var tv = t[i], yv = y[i];
        if (_isNum(tv)) {
            if (tv < tMin) tMin = tv;
            if (tv > tMax) tMax = tv;
        }
        if (_isNum(yv)) {
            if (yv < yMin) yMin = yv;
            if (yv > yMax) yMax = yv;
        }
    }
    if (overlay && overlay.length) {
        for (var j = 0; j < overlay.length; j++) {
            var ov = overlay[j];
            if (_isNum(ov)) {
                if (ov < yMin) yMin = ov;
                if (ov > yMax) yMax = ov;
            }
        }
    }
    if (!isFinite(tMin) || tMin >= tMax) { tMin = 0; tMax = 1; }
    if (!isFinite(yMin) || yMin >= yMax) { yMin = -1; yMax = 1; }
    var span = yMax - yMin;
    yMin -= 0.05 * span; yMax += 0.05 * span;
    function xMap(tv) { return plotX + plotW * (tv - tMin) / (tMax - tMin); }
    function yMap(yv) { return plotY + plotH * (1 - (yv - yMin) / (yMax - yMin)); }
    // Grid + axes.
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = T.text2;
    // Y axis.
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
        var yp = plotY + plotH * g / 4;
        ctx.beginPath(); ctx.moveTo(plotX, yp); ctx.lineTo(plotX + plotW, yp); ctx.stroke();
        var yLabel = yMax - g * (yMax - yMin) / 4;
        ctx.fillText(_fmtSig(yLabel, 3), plotX - 6, yp);
    }
    // X axis.
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var x = 0; x <= 5; x++) {
        var frac = x / 5;
        var tv2 = tMin + frac * (tMax - tMin);
        var xp = xMap(tv2);
        ctx.beginPath(); ctx.moveTo(xp, plotY); ctx.lineTo(xp, plotY + plotH); ctx.stroke();
        ctx.fillText(_fmtSig(tv2, 3), xp, plotY + plotH + 4);
    }
    // Axis labels.
    ctx.fillStyle = T.text;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('time (hr)', plotX + plotW / 2, h - 4);
    ctx.save();
    ctx.translate(14, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(ylabel, 0, 0);
    ctx.restore();
    // Data series.
    var color = (kind === 'pressure') ? T.blue : T.accent;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    var started = false;
    for (var k = 0; k < t.length; k++) {
        if (!_isNum(t[k]) || !_isNum(y[k])) continue;
        var xp2 = xMap(t[k]);
        var yp2 = yMap(y[k]);
        if (!started) { ctx.moveTo(xp2, yp2); started = true; }
        else ctx.lineTo(xp2, yp2);
    }
    ctx.stroke();
    // Markers.
    ctx.fillStyle = color;
    for (var m = 0; m < t.length; m++) {
        if (!_isNum(t[m]) || !_isNum(y[m])) continue;
        var xpm = xMap(t[m]), ypm = yMap(y[m]);
        ctx.beginPath();
        ctx.arc(xpm, ypm, 1.6, 0, 2 * Math.PI);
        ctx.fill();
    }
    // Overlay (predicted) — dashed.
    if (overlay && overlay.length) {
        ctx.strokeStyle = T.green;
        ctx.lineWidth = 1.2;
        if (ctx.setLineDash) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        var started2 = false;
        for (var ov2 = 0; ov2 < overlay.length; ov2++) {
            if (!_isNum(t[ov2]) || !_isNum(overlay[ov2])) continue;
            var xpv = xMap(t[ov2]);
            var ypv = yMap(overlay[ov2]);
            if (!started2) { ctx.moveTo(xpv, ypv); started2 = true; }
            else ctx.lineTo(xpv, ypv);
        }
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);
        // Legend.
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

})();

// ─── END 20-plt-inverse ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 21-plot-utilities ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 21 — Plot Utilities (overlays + diff + XML + clipboard)
//   • Plot overlays for multi-period / multi-dataset comparison
//   • Two-dataset diff plot (interpolation + 2-panel render)
//   • XML project export (one-file portable export)
//   • Copy plot / data to clipboard via navigator.clipboard
//
// PUBLIC API (all on window.*)
//
//   PRiSM_overlays                          — state container
//     .items                                — current overlay list
//     .add(source, label?, color?) → string (id)
//     .remove(id)                           → void
//     .toggle(id)                           → void
//     .clear()                              → void
//     .list()                               → array (defensive copy)
//
//   PRiSM_drawOverlays(canvas, plotKey, baseAxes?) → void
//   PRiSM_renderOverlayManager(container)         → void
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
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • Pure vanilla JS — no external dependencies.
//   • Defensive against missing helpers (PRiSM_pvt, PRiSM_gaugeData,
//     PRiSM_analysisData, PRiSM_drawActivePlot may not be loaded).
//   • Modern browsers only for clipboard (Clipboard API + ClipboardItem) —
//     graceful fallback otherwise.
//   • XML is well-formed: 5-entity escaping for <, >, &, ", '.
//   • Self-test is non-destructive — does not write to the real clipboard
//     (that requires a user gesture).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims — module loads in browser AND in the smoke-test
    // stub (see prism-build/smoke-test.js).
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _theme() {
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
    // 'source' is a colon-prefixed string. Supported forms:
    //   'period:N'    — flow period N from window.PRiSM_dataset
    //   'analysis:ID' — uses PRiSM_analysisData if loaded
    //   'gauge:ID'    — uses PRiSM_gaugeData if loaded
    //   'model:KEY'   — type-curve from PRiSM_MODELS[KEY] with defaults
    //   'fit:KEY'     — fitted curve from PRiSM_state.history[KEY]
    //
    // The container is created once on first load and survives re-loads
    // of this layer (idempotency via window.PRiSM_overlays guard).
    // ═══════════════════════════════════════════════════════════════

    var _overlayCounter = 0;
    function _genOverlayId() {
        _overlayCounter += 1;
        return 'overlay_' + _overlayCounter + '_' + (Date.now() % 100000);
    }

    function _nextColor() {
        var existing = (G.PRiSM_overlays && G.PRiSM_overlays.items) || [];
        for (var i = 0; i < OVERLAY_PALETTE.length; i++) {
            var c = OVERLAY_PALETTE[i];
            var used = false;
            for (var j = 0; j < existing.length; j++) {
                if (existing[j].color === c) { used = true; break; }
            }
            if (!used) return c;
        }
        // All used — cycle on count
        return OVERLAY_PALETTE[existing.length % OVERLAY_PALETTE.length];
    }

    function _autoLabel(source) {
        if (!source || typeof source !== 'string') return 'Overlay';
        var parts = source.split(':');
        var kind = parts[0], id = parts.slice(1).join(':');
        switch (kind) {
            case 'period':   return 'Period #' + (parseInt(id, 10) + 1);
            case 'analysis': return 'Analysis: ' + id;
            case 'gauge':    return 'Gauge: ' + id;
            case 'model':    return 'Model: ' + id;
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
                this.items.push({
                    id:      id,
                    source:  source,
                    label:   label || _autoLabel(source),
                    color:   color || _nextColor(),
                    visible: true
                });
                _ga4('prism_overlay_add', { source: source });
                return id;
            },
            remove: function (id) {
                for (var i = 0; i < this.items.length; i++) {
                    if (this.items[i].id === id) {
                        this.items.splice(i, 1);
                        return;
                    }
                }
            },
            toggle: function (id) {
                for (var i = 0; i < this.items.length; i++) {
                    if (this.items[i].id === id) {
                        this.items[i].visible = !this.items[i].visible;
                        return;
                    }
                }
            },
            clear: function () { this.items.length = 0; },
            list:  function () { return this.items.slice(); }
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — OVERLAY DATA RESOLUTION + DRAWING
    // ═══════════════════════════════════════════════════════════════
    //
    // Resolve a 'source' string into a {t, p} or {t, dp/dp'} pair we
    // can plot on the active canvas. Returns null on miss (silently —
    // the overlay just doesn't paint).
    //
    // Drawing uses the host plot's stashed axis transform if available
    // (canvas._prismAxes), else re-derives a sensible transform from
    // the data range, mirroring layer-2's tick generator.
    // ═══════════════════════════════════════════════════════════════

    function _resolveOverlay(source) {
        if (!source || typeof source !== 'string') return null;
        var parts = source.split(':');
        var kind = parts[0], id = parts.slice(1).join(':');
        var ds   = G.PRiSM_dataset;
        try {
            switch (kind) {
                case 'period': {
                    if (!ds || !Array.isArray(ds.t)) return null;
                    var pIdx = parseInt(id, 10);
                    if (!isFinite(pIdx) || pIdx < 0) return null;
                    var pers = ds.periods || [];
                    if (typeof G.PRiSM_detectPeriods === 'function' && (!pers || !pers.length) && ds.q) {
                        pers = G.PRiSM_detectPeriods(ds.t, ds.q);
                    }
                    if (!pers[pIdx]) return null;
                    var pp = pers[pIdx];
                    var t = [], p = [], q = [];
                    for (var i = 0; i < ds.t.length; i++) {
                        if (ds.t[i] >= pp.t0 && ds.t[i] <= pp.t1) {
                            t.push(ds.t[i] - pp.t0);
                            if (ds.p) p.push(ds.p[i]);
                            if (ds.q) q.push(ds.q[i]);
                        }
                    }
                    return { t: t, p: p.length ? p : null, q: q.length ? q : null };
                }
                case 'analysis': {
                    var ad = G.PRiSM_analysisData;
                    if (!ad) return null;
                    var item = (typeof ad.get === 'function')   ? ad.get(id)
                              : (ad.items && ad.items[id])      ? ad.items[id]
                              : (Array.isArray(ad) && ad.find)  ? ad.find(function (x) { return x.id === id; })
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
                    var g = (typeof gd.get === 'function')        ? gd.get(id)
                          : (gd.items && gd.items[id])            ? gd.items[id]
                          : (Array.isArray(gd) && gd.find)        ? gd.find(function (x) { return x.id === id; })
                          : null;
                    if (!g) return null;
                    return {
                        t: g.t || (g.samples && g.samples.t) || [],
                        p: g.p || (g.samples && g.samples.p) || null,
                        q: g.q || (g.samples && g.samples.q) || null
                    };
                }
                case 'model': {
                    var reg = G.PRiSM_MODELS;
                    if (!reg || !reg[id] || typeof reg[id].pd !== 'function') return null;
                    // Generate a canonical type-curve over 4 decades.
                    var td = [];
                    for (var k = -2; k <= 4; k += 0.05) td.push(Math.pow(10, k));
                    var defaults = reg[id].defaults || {};
                    var pd = reg[id].pd(td, defaults);
                    return { t: td, p: pd, dp: pd };
                }
                case 'fit': {
                    var st = G.PRiSM_state || {};
                    var hist = st.history || st.fitHistory || {};
                    var fit = hist[id];
                    if (!fit) return null;
                    if (fit.curve && fit.curve.t && fit.curve.p) {
                        return { t: fit.curve.t.slice(), p: fit.curve.p.slice() };
                    }
                    if (fit.td && fit.pd) {
                        return { t: fit.td.slice(), p: fit.pd.slice() };
                    }
                    return null;
                }
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    function _plotRect(canvas) {
        var cssW = (canvas && canvas.clientWidth)  || (canvas && canvas.width)  || 600;
        var cssH = (canvas && canvas.clientHeight) || (canvas && canvas.height) || 400;
        if (canvas && canvas.style) {
            var w = parseInt(canvas.style.width, 10);
            if (isFinite(w) && w > 0) cssW = w;
            var h = parseInt(canvas.style.height, 10);
            if (isFinite(h) && h > 0) cssH = h;
        }
        var pad = _defaultPad();
        return {
            x: pad.left,
            y: pad.top,
            w: Math.max(1, cssW - pad.left - pad.right),
            h: Math.max(1, cssH - pad.top - pad.bottom),
            cssW: cssW,
            cssH: cssH,
            pad: pad
        };
    }

    // Pull the active axis transform off the canvas. Tries the modern
    // _prismAxes shape first (planned by layer 11), then the older
    // _prismOriginalScale shape (set by layer 2). Else null.
    function _getCanvasAxes(canvas, plotKey) {
        if (canvas && canvas._prismAxes) {
            var ax = canvas._prismAxes;
            return {
                plotRect: { x: ax.x0, y: ax.y0, w: (ax.x1 - ax.x0), h: (ax.y1 - ax.y0) },
                xLog: !!ax.xLog,
                yLog: !!ax.yLog,
                xMin: ax.dx0, xMax: ax.dx1,
                yMin: ax.dy0, yMax: ax.dy1
            };
        }
        if (canvas && canvas._prismOriginalScale) {
            var s = canvas._prismOriginalScale;
            var pr = _plotRect(canvas);
            return {
                plotRect: pr,
                xLog: (s.x && s.x.kind === 'log'),
                yLog: (s.y && s.y.kind === 'log'),
                xMin: s.x && s.x.min, xMax: s.x && s.x.max,
                yMin: s.y && s.y.min, yMax: s.y && s.y.max
            };
        }
        return null;
    }

    // Build a world->pixel function pair from an axis spec.
    function _makeTransforms(axes) {
        var pr = axes.plotRect;
        var toX = axes.xLog
            ? function (v) {
                if (!isFinite(v) || v <= 0) return NaN;
                var lmin = Math.log10(axes.xMin), lmax = Math.log10(axes.xMax);
                if (lmax === lmin) return pr.x;
                return pr.x + (Math.log10(v) - lmin) / (lmax - lmin) * pr.w;
            }
            : function (v) {
                if (!isFinite(v)) return NaN;
                if (axes.xMax === axes.xMin) return pr.x;
                return pr.x + (v - axes.xMin) / (axes.xMax - axes.xMin) * pr.w;
            };
        var toY = axes.yLog
            ? function (v) {
                if (!isFinite(v) || v <= 0) return NaN;
                var lmin = Math.log10(axes.yMin), lmax = Math.log10(axes.yMax);
                if (lmax === lmin) return pr.y + pr.h;
                return pr.y + pr.h - (Math.log10(v) - lmin) / (lmax - lmin) * pr.h;
            }
            : function (v) {
                if (!isFinite(v)) return NaN;
                if (axes.yMax === axes.yMin) return pr.y + pr.h;
                return pr.y + pr.h - (v - axes.yMin) / (axes.yMax - axes.yMin) * pr.h;
            };
        return { toX: toX, toY: toY };
    }

    // Pick which series field to plot for a given plotKey. Most diagnostic
    // plots want pressure or Δp. Bourdet wants Δp + Δp'. The mapper is
    // best-effort — overlay drawing is non-critical.
    function _seriesForPlot(data, plotKey) {
        if (!data || !data.t || !data.t.length) return [];
        var t = data.t;
        var arr = [];
        if (plotKey === 'cartesian' || plotKey === 'horner' ||
            plotKey === 'sqrt' || plotKey === 'quarter' || plotKey === 'spherical') {
            var p = data.p || data.dp;
            if (!p) return [];
            for (var i = 0; i < t.length; i++) arr.push([t[i], p[i]]);
            return arr;
        }
        if (plotKey === 'rateCart' || plotKey === 'rateSemi' || plotKey === 'rateLog') {
            var q = data.q;
            if (!q) return [];
            for (var j = 0; j < t.length; j++) arr.push([t[j], q[j]]);
            return arr;
        }
        // Default: Bourdet/log-log → Δp series.
        var dp = data.dp;
        if (!dp && data.p && data.p.length) {
            var p0 = data.p[0];
            dp = data.p.map(function (v) { return v - p0; });
        }
        if (!dp) return [];
        for (var k = 0; k < t.length; k++) arr.push([t[k], dp[k]]);
        return arr;
    }

    G.PRiSM_drawOverlays = function PRiSM_drawOverlays(canvas, plotKey, baseAxes) {
        if (!canvas || !canvas.getContext) return;
        var items = (G.PRiSM_overlays && G.PRiSM_overlays.items) || [];
        if (!items.length) return;
        try {
            // Prefer baseAxes argument; else read off canvas.
            var axes = baseAxes || _getCanvasAxes(canvas, plotKey);
            if (!axes || !isFinite(axes.xMin) || !isFinite(axes.xMax) ||
                !isFinite(axes.yMin) || !isFinite(axes.yMax)) {
                return; // can't compute transform — silent skip
            }
            var tr  = _makeTransforms(axes);
            var ctx = canvas.getContext('2d');
            if (!ctx) return;
            var pr  = axes.plotRect;
            ctx.save();
            try {
                // Clip to plot area to avoid spilling into tick margins.
                ctx.beginPath();
                ctx.rect(pr.x, pr.y, pr.w, pr.h);
                ctx.clip();
            } catch (e) { /* clip not strictly required */ }
            ctx.lineWidth = 2;

            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it.visible) continue;
                var resolved = _resolveOverlay(it.source);
                if (!resolved) continue;
                var pts = _seriesForPlot(resolved, plotKey);
                if (!pts.length) continue;
                ctx.strokeStyle = it.color || '#58a6ff';
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                var started = false;
                for (var k = 0; k < pts.length; k++) {
                    var p = pts[k];
                    if (!p || !isFinite(p[0]) || !isFinite(p[1])) { started = false; continue; }
                    var px = tr.toX(p[0]), py = tr.toY(p[1]);
                    if (!isFinite(px) || !isFinite(py)) { started = false; continue; }
                    if (!started) { ctx.moveTo(px, py); started = true; }
                    else ctx.lineTo(px, py);
                }
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();

            // Draw a small overlay legend chip in the bottom-left corner.
            var visibleItems = items.filter(function (x) { return x.visible; });
            if (visibleItems.length) {
                ctx.save();
                ctx.font = '11px sans-serif';
                ctx.textBaseline = 'middle';
                var th = _theme();
                var lineH = 14, padXL = 6, padYL = 4;
                var maxW = 0;
                for (var m = 0; m < visibleItems.length; m++) {
                    var w = ctx.measureText(visibleItems[m].label || '').width;
                    if (w > maxW) maxW = w;
                }
                var boxW = 20 + maxW + padXL * 2;
                var boxH = visibleItems.length * lineH + padYL * 2;
                var bx = pr.x + 8, by = pr.y + pr.h - boxH - 8;
                ctx.fillStyle = 'rgba(13,17,23,0.85)';
                ctx.fillRect(bx, by, boxW, boxH);
                ctx.strokeStyle = th.border || '#30363d';
                ctx.lineWidth = 1;
                ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
                for (var n = 0; n < visibleItems.length; n++) {
                    var iy = by + padYL + n * lineH + lineH / 2;
                    ctx.strokeStyle = visibleItems[n].color;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([4, 3]);
                    ctx.beginPath();
                    ctx.moveTo(bx + padXL, iy);
                    ctx.lineTo(bx + padXL + 14, iy);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = th.text || '#c9d1d9';
                    ctx.textAlign = 'left';
                    ctx.fillText(String(visibleItems[n].label || ''), bx + padXL + 18, iy);
                }
                ctx.restore();
            }
        } catch (e) {
            // Overlays are non-critical — never throw upward.
            try { console.warn('PRiSM_drawOverlays:', e && e.message); } catch (_) {}
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — OVERLAY MANAGER UI
    // ═══════════════════════════════════════════════════════════════
    //
    // Renders a small panel into `container` with:
    //   - one row per current overlay (visibility checkbox + colour
    //     swatch + label + remove button)
    //   - "+ Add overlay" select listing all currently-resolvable sources
    // ═══════════════════════════════════════════════════════════════

    function _enumerateSources() {
        var out = [];
        var ds = G.PRiSM_dataset;
        if (ds && Array.isArray(ds.t)) {
            var pers = ds.periods || [];
            if (typeof G.PRiSM_detectPeriods === 'function' && (!pers || !pers.length) && ds.q) {
                pers = G.PRiSM_detectPeriods(ds.t, ds.q);
            }
            for (var i = 0; i < pers.length; i++) {
                out.push({ source: 'period:' + i, label: 'Period #' + (i + 1) });
            }
        }
        var ad = G.PRiSM_analysisData;
        if (ad) {
            var adList = [];
            if (typeof ad.list === 'function') adList = ad.list();
            else if (Array.isArray(ad)) adList = ad;
            else if (ad.items) {
                for (var k in ad.items) if (Object.prototype.hasOwnProperty.call(ad.items, k)) {
                    adList.push({ id: k, name: ad.items[k].name });
                }
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
                for (var kk in gd.items) if (Object.prototype.hasOwnProperty.call(gd.items, kk)) {
                    gdList.push({ id: kk, name: gd.items[kk].name });
                }
            }
            for (var g = 0; g < gdList.length; g++) {
                var gid = gdList[g].id || gdList[g].name || ('g' + g);
                out.push({ source: 'gauge:' + gid, label: 'Gauge: ' + (gdList[g].name || gid) });
            }
        }
        var reg = G.PRiSM_MODELS;
        if (reg) {
            for (var key in reg) if (Object.prototype.hasOwnProperty.call(reg, key)) {
                if (reg[key] && typeof reg[key].pd === 'function') {
                    out.push({ source: 'model:' + key, label: 'Model: ' + key });
                }
            }
        }
        var st = G.PRiSM_state || {};
        var hist = st.history || st.fitHistory || {};
        for (var fk in hist) if (Object.prototype.hasOwnProperty.call(hist, fk)) {
            out.push({ source: 'fit:' + fk, label: 'Fit: ' + fk });
        }
        return out;
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    G.PRiSM_renderOverlayManager = function PRiSM_renderOverlayManager(container) {
        if (!container || !_hasDoc) return;
        var th = _theme();
        var items = G.PRiSM_overlays.list();
        var sources = _enumerateSources();
        var sourceOpts = '<option value="">— Add overlay…</option>';
        for (var i = 0; i < sources.length; i++) {
            sourceOpts += '<option value="' + _esc(sources[i].source) + '">' +
                          _esc(sources[i].label) + '</option>';
        }

        var rows = '';
        if (!items.length) {
            rows = '<div style="font-size:12px; color:' + th.text3 +
                   '; padding:8px 4px;">No overlays. Use the picker below.</div>';
        } else {
            for (var k = 0; k < items.length; k++) {
                var it = items[k];
                rows += '<div data-overlay-id="' + _esc(it.id) +
                        '" style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid ' +
                        th.border + ';">' +
                    '<input type="checkbox" data-overlay-toggle="' + _esc(it.id) + '"' +
                        (it.visible ? ' checked' : '') + '>' +
                    '<span style="display:inline-block; width:14px; height:14px; border-radius:3px; background:' +
                        _esc(it.color) + '; border:1px solid ' + th.border + ';"></span>' +
                    '<span style="flex:1; font-size:12px; color:' + th.text + ';">' +
                        _esc(it.label) + '</span>' +
                    '<span style="font-size:10px; color:' + th.text3 + ';">' +
                        _esc(it.source) + '</span>' +
                    '<button type="button" data-overlay-remove="' + _esc(it.id) +
                        '" style="background:none; border:none; color:' + th.red +
                        '; cursor:pointer; font-size:14px; padding:2px 6px;">×</button>' +
                '</div>';
            }
        }

        container.innerHTML =
            '<div style="background:' + th.panel + '; border:1px solid ' + th.border +
                '; border-radius:6px; padding:10px;">' +
                '<div style="font-size:11px; font-weight:700; color:' + th.text2 +
                    '; text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px;">' +
                    'Plot overlays (' + items.length + ')</div>' +
                '<div data-overlay-list>' + rows + '</div>' +
                '<div style="display:flex; gap:8px; align-items:center; margin-top:10px;">' +
                    '<select data-overlay-add style="flex:1; padding:5px 8px; background:' + th.bg +
                        '; color:' + th.text + '; border:1px solid ' + th.border +
                        '; border-radius:4px; font-size:12px;">' + sourceOpts + '</select>' +
                    '<button type="button" data-overlay-clear style="padding:5px 10px; background:' + th.bg +
                        '; color:' + th.text2 + '; border:1px solid ' + th.border +
                        '; border-radius:4px; font-size:12px; cursor:pointer;">Clear all</button>' +
                '</div>' +
            '</div>';

        function redraw() {
            G.PRiSM_renderOverlayManager(container);
            if (typeof G.PRiSM_drawActivePlot === 'function') {
                try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
            }
        }

        var sel = container.querySelector('[data-overlay-add]');
        if (sel) sel.addEventListener('change', function (ev) {
            var v = ev.target.value;
            if (!v) return;
            G.PRiSM_overlays.add(v);
            redraw();
        });
        var clr = container.querySelector('[data-overlay-clear]');
        if (clr) clr.addEventListener('click', function () {
            G.PRiSM_overlays.clear();
            redraw();
        });
        var toggles = container.querySelectorAll('[data-overlay-toggle]');
        for (var tt = 0; tt < toggles.length; tt++) {
            (function (el) {
                el.addEventListener('change', function () {
                    G.PRiSM_overlays.toggle(el.getAttribute('data-overlay-toggle'));
                    if (typeof G.PRiSM_drawActivePlot === 'function') {
                        try { G.PRiSM_drawActivePlot(); } catch (e) {}
                    }
                });
            })(toggles[tt]);
        }
        var rms = container.querySelectorAll('[data-overlay-remove]');
        for (var rr = 0; rr < rms.length; rr++) {
            (function (el) {
                el.addEventListener('click', function () {
                    G.PRiSM_overlays.remove(el.getAttribute('data-overlay-remove'));
                    redraw();
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

    // Auto-register the plot if a registry exists on window.
    if (G.PRISM_PLOT_REGISTRY && !G.PRISM_PLOT_REGISTRY.datasetDiff) {
        try {
            G.PRISM_PLOT_REGISTRY.datasetDiff = {
                fn:    'PRiSM_plot_dataset_diff',
                label: 'Dataset diff (A − B)',
                mode:  'transient'
            };
        } catch (e) { /* registry may be const-frozen, ignore */ }
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5b — DIFF PICKER UI
    // ═══════════════════════════════════════════════════════════════

    function _diffSourceList() {
        var out = [];
        var ds = G.PRiSM_dataset;
        if (ds && Array.isArray(ds.t)) {
            out.push({ id: 'current', name: 'Current dataset', resolve: function () { return ds; } });
        }
        var gd = G.PRiSM_gaugeData;
        if (gd) {
            var list = (typeof gd.list === 'function') ? gd.list()
                     : Array.isArray(gd) ? gd
                     : (gd.items ? Object.keys(gd.items).map(function (k) {
                         return Object.assign({ id: k }, gd.items[k]);
                       }) : []);
            for (var i = 0; i < list.length; i++) {
                (function (g) {
                    var gid = g.id || g.name || ('g' + i);
                    out.push({
                        id:   'gauge:' + gid,
                        name: 'Gauge: ' + (g.name || gid),
                        resolve: function () {
                            return _resolveOverlay('gauge:' + gid);
                        }
                    });
                })(list[i]);
            }
        }
        var ad = G.PRiSM_analysisData;
        if (ad) {
            var alist = (typeof ad.list === 'function') ? ad.list()
                      : Array.isArray(ad) ? ad
                      : (ad.items ? Object.keys(ad.items).map(function (k) {
                          return Object.assign({ id: k }, ad.items[k]);
                        }) : []);
            for (var j = 0; j < alist.length; j++) {
                (function (a) {
                    var aid = a.id || a.name || ('a' + j);
                    out.push({
                        id:   'analysis:' + aid,
                        name: 'Analysis: ' + (a.name || aid),
                        resolve: function () {
                            return _resolveOverlay('analysis:' + aid);
                        }
                    });
                })(alist[j]);
            }
        }
        var st = G.PRiSM_state || {};
        var saved = st.savedSets || st.snapshots || {};
        for (var sk in saved) if (Object.prototype.hasOwnProperty.call(saved, sk)) {
            (function (key, snap) {
                out.push({
                    id:   'saved:' + key,
                    name: 'Saved: ' + key,
                    resolve: function () { return snap; }
                });
            })(sk, saved[sk]);
        }
        return out;
    }

    G.PRiSM_renderDiffPicker = function PRiSM_renderDiffPicker(container) {
        if (!container || !_hasDoc) return;
        var th = _theme();
        var sources = _diffSourceList();
        function buildOpts(sel) {
            var opts = '<option value="">— pick dataset —</option>';
            for (var i = 0; i < sources.length; i++) {
                opts += '<option value="' + _esc(sources[i].id) + '"' +
                        (sources[i].id === sel ? ' selected' : '') + '>' +
                        _esc(sources[i].name) + '</option>';
            }
            return opts;
        }
        container.innerHTML =
            '<div style="background:' + th.panel + '; border:1px solid ' + th.border +
                '; border-radius:6px; padding:10px;">' +
                '<div style="font-size:11px; font-weight:700; color:' + th.text2 +
                    '; text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px;">' +
                    'Two-dataset diff</div>' +
                '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">' +
                    '<label style="font-size:12px; color:' + th.text2 + ';">A: ' +
                        '<select data-diff-a style="padding:4px 8px; background:' + th.bg + '; color:' + th.text +
                            '; border:1px solid ' + th.border + '; border-radius:4px; font-size:12px;">' +
                            buildOpts('current') + '</select></label>' +
                    '<label style="font-size:12px; color:' + th.text2 + ';">B: ' +
                        '<select data-diff-b style="padding:4px 8px; background:' + th.bg + '; color:' + th.text +
                            '; border:1px solid ' + th.border + '; border-radius:4px; font-size:12px;">' +
                            buildOpts('') + '</select></label>' +
                    '<button type="button" data-diff-go style="padding:5px 12px; background:' + th.accent +
                        '; color:#fff; border:none; border-radius:4px; font-size:12px; cursor:pointer;">' +
                        'Compute diff</button>' +
                '</div>' +
                '<canvas data-diff-canvas style="width:100%; height:380px; display:block; ' +
                    'background:' + th.bg + '; border:1px solid ' + th.border + '; border-radius:4px;"></canvas>' +
                '<div data-diff-summary style="margin-top:6px; font-size:11px; color:' + th.text2 + ';"></div>' +
            '</div>';
        var btn = container.querySelector('[data-diff-go]');
        if (btn) btn.addEventListener('click', function () {
            var aSel = container.querySelector('[data-diff-a]');
            var bSel = container.querySelector('[data-diff-b]');
            var idA = aSel && aSel.value, idB = bSel && bSel.value;
            if (!idA || !idB) {
                container.querySelector('[data-diff-summary]').textContent = 'Pick two datasets.';
                return;
            }
            var a = sources.filter(function (x) { return x.id === idA; })[0];
            var b = sources.filter(function (x) { return x.id === idB; })[0];
            if (!a || !b) return;
            var dA = a.resolve(), dB = b.resolve();
            var canvas = container.querySelector('[data-diff-canvas]');
            G.PRiSM_plot_dataset_diff(canvas, {
                dataA: dA, dataB: dB, labelA: a.name, labelB: b.name
            }, { title: 'Diff: ' + a.name + ' − ' + b.name });
            var diff = G.PRiSM_datasetDiff(dA, dB);
            var sum = container.querySelector('[data-diff-summary]');
            if (sum) {
                sum.textContent = 'Common samples: ' + diff.nCommon +
                    '  •  RMS Δp = ' + (isFinite(diff.rms) ? diff.rms.toPrecision(4) : '—') +
                    '  •  max |Δp| = ' + (isFinite(diff.maxAbs) ? diff.maxAbs.toPrecision(4) : '—');
            }
            _ga4('prism_diff_compute', { idA: idA, idB: idB, n: diff.nCommon });
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

    function _serializeModel(b, includeFitHistory) {
        var st = G.PRiSM_state || {};
        var children = [];
        children.push(b('Active', null, _xmlEscape(st.model || ''), 2));
        // Params
        var params = st.params || {};
        var paramChildren = [];
        for (var pk in params) if (Object.prototype.hasOwnProperty.call(params, pk)) {
            var pv = params[pk];
            paramChildren.push(b('Param', { name: pk, frozen: !!(st.paramFreeze && st.paramFreeze[pk]) },
                _xmlEscape(String(pv)), 3));
        }
        children.push(b('Params', null, paramChildren.length ? paramChildren : null, 2));
        // Last fit
        var lf = st.lastFit;
        if (lf) {
            var lfChildren = [];
            if (lf.params) {
                var lfp = [];
                for (var fk in lf.params) if (Object.prototype.hasOwnProperty.call(lf.params, fk)) {
                    lfp.push(b('Param', { name: fk }, _xmlEscape(String(lf.params[fk])), 4));
                }
                lfChildren.push(b('Params', null, lfp, 3));
            }
            if (lf.ci95) {
                var ci = [];
                for (var ck in lf.ci95) if (Object.prototype.hasOwnProperty.call(lf.ci95, ck)) {
                    var rng = lf.ci95[ck] || [];
                    ci.push(b('CI', { name: ck, low: rng[0], high: rng[1] }, null, 4));
                }
                lfChildren.push(b('CI95', null, ci, 3));
            }
            if (isFinite(lf.aic))  lfChildren.push(b('AIC',  null, _xmlEscape(String(lf.aic)),  3));
            if (isFinite(lf.r2))   lfChildren.push(b('R2',   null, _xmlEscape(String(lf.r2)),   3));
            if (isFinite(lf.rmse)) lfChildren.push(b('RMSE', null, _xmlEscape(String(lf.rmse)), 3));
            if (isFinite(lf.ssr))  lfChildren.push(b('SSR',  null, _xmlEscape(String(lf.ssr)),  3));
            if (isFinite(lf.iterations)) lfChildren.push(b('Iterations', null, _xmlEscape(String(lf.iterations)), 3));
            if (lf.converged != null)    lfChildren.push(b('Converged',  null, _xmlEscape(String(!!lf.converged)),  3));
            children.push(b('LastFit', null, lfChildren, 2));
        }
        // Fit history (optional)
        if (includeFitHistory) {
            var hist = st.history || st.fitHistory || {};
            var histChildren = [];
            for (var hk in hist) if (Object.prototype.hasOwnProperty.call(hist, hk)) {
                var f = hist[hk] || {};
                var attrs = {
                    key:   hk,
                    aic:   isFinite(f.aic) ? f.aic : null,
                    r2:    isFinite(f.r2)  ? f.r2  : null,
                    model: f.model || null
                };
                histChildren.push(b('Fit', attrs, null, 3));
            }
            if (histChildren.length) {
                children.push(b('FitHistory', { count: histChildren.length }, histChildren, 2));
            }
        }
        return b('Model', null, children, 1);
    }

    function _serializeDataset(b, includeRaw) {
        var ds = G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t)) {
            return b('Dataset', { available: 'false' }, null, 1);
        }
        var attrs = { available: 'true', samples: ds.t.length };
        var children = [];
        if (ds.periods && ds.periods.length) {
            var pc = [];
            for (var i = 0; i < ds.periods.length; i++) {
                var pr = ds.periods[i];
                pc.push(b('Period', { index: i, t0: pr.t0, t1: pr.t1, q: pr.q }, null, 3));
            }
            children.push(b('Periods', { count: pc.length }, pc, 2));
        }
        if (includeRaw && ds.t.length) {
            children.push(b('Samples', { count: ds.t.length }, [
                b('t', null, _arrCompact(ds.t), 3),
                ds.p ? b('p', null, _arrCompact(ds.p), 3) : '',
                ds.q ? b('q', null, _arrCompact(ds.q), 3) : '',
                ds.dp ? b('dp', null, _arrCompact(ds.dp), 3) : ''
            ].filter(Boolean), 2));
        } else {
            children.push(b('Samples', { count: ds.t.length, includeRaw: 'false' }, null, 2));
        }
        return b('Dataset', attrs, children, 1);
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
        sections.push(_serializePVT(b));
        sections.push(_serializeDataset(b, includeRawDataset));
        sections.push(_serializeGauges(b, includeRawGauge));
        if (includeAnalysis) sections.push(_serializeAnalysis(b));
        sections.push(_serializeModel(b, includeFitHistory));

        var rootAttrs = { version: '1.0', exportedAt: _now(), generator: 'PRiSM' };
        var body = b('PRiSMProject', rootAttrs, sections, 0);
        var xml = '<?xml version="1.0" encoding="UTF-8"?>' + nl + body;

        var filename = 'prism-export-' + _formatStamp() + '.xml';
        var blob = null;
        try {
            if (typeof Blob === 'function' || typeof Blob === 'object') {
                blob = new Blob([xml], { type: 'application/xml' });
            }
        } catch (e) {
            blob = null;
        }
        _ga4('prism_xml_export', { sizeBytes: xml.length });
        return { blob: blob, filename: filename, xmlString: xml };
    };

    G.PRiSM_exportXMLDownload = function PRiSM_exportXMLDownload(opts) {
        var res = G.PRiSM_exportXML(opts);
        if (!_hasDoc) return res;
        try {
            var url;
            if (res.blob && typeof URL !== 'undefined' && URL.createObjectURL) {
                url = URL.createObjectURL(res.blob);
            } else {
                url = 'data:application/xml;charset=utf-8,' + encodeURIComponent(res.xmlString);
            }
            var a = document.createElement('a');
            a.href = url;
            a.download = res.filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (url && url.indexOf('blob:') === 0 && URL.revokeObjectURL) {
                setTimeout(function () { URL.revokeObjectURL(url); }, 0);
            }
        } catch (e) {
            try { console.warn('PRiSM_exportXMLDownload:', e && e.message); } catch (_) {}
        }
        return res;
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — DOWNLOAD HELPER (general)
    // ═══════════════════════════════════════════════════════════════

    function _downloadText(text, filename, mime) {
        if (!_hasDoc) return false;
        try {
            var url, blob = null;
            if (typeof Blob !== 'undefined') {
                blob = new Blob([text], { type: mime || 'text/plain' });
            }
            if (blob && typeof URL !== 'undefined' && URL.createObjectURL) {
                url = URL.createObjectURL(blob);
            } else {
                url = 'data:' + (mime || 'text/plain') + ';charset=utf-8,' + encodeURIComponent(text);
            }
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

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — CLIPBOARD HELPERS (PNG + TSV/CSV/JSON)
    // ═══════════════════════════════════════════════════════════════

    function _hasClipboardImageAPI() {
        try {
            return _hasWin && G.navigator && G.navigator.clipboard &&
                   typeof G.navigator.clipboard.write === 'function' &&
                   typeof G.ClipboardItem === 'function';
        } catch (e) { return false; }
    }

    function _hasClipboardTextAPI() {
        try {
            return _hasWin && G.navigator && G.navigator.clipboard &&
                   typeof G.navigator.clipboard.writeText === 'function';
        } catch (e) { return false; }
    }

    // Render a target plot to an offscreen canvas at exportW × exportH.
    // If plotKey is null, just snapshot the current visible canvas.
    function _renderPlotToCanvas(plotKey, exportW, exportH) {
        if (!_hasDoc) return null;
        exportW = exportW || 1200;
        exportH = exportH || 800;
        var off = document.createElement('canvas');
        off.width = exportW;
        off.height = exportH;
        if (off.style) {
            off.style.width = exportW + 'px';
            off.style.height = exportH + 'px';
        }
        var key = plotKey || (G.PRiSM_state && G.PRiSM_state.activePlot) || null;
        var registry = G.PRISM_PLOT_REGISTRY;
        var fn = null;
        if (registry && key && registry[key]) {
            fn = G[registry[key].fn];
        }
        var ds = G.PRiSM_dataset;
        var data = null;
        if (ds && Array.isArray(ds.t)) {
            data = { t: ds.t, p: ds.p, q: ds.q };
            if (ds.dp) data.dp = ds.dp;
            if (ds.periods) data.periods = ds.periods;
        }
        if (typeof fn === 'function' && data) {
            try {
                fn(off, data, { width: exportW, height: exportH, hover: false, dragZoom: false });
            } catch (e) {
                // Fall through to snapshot fallback
            }
        }
        return off;
    }

    // Snapshot the live plot canvas if rendering off-screen failed/unavailable.
    function _snapshotLivePlot(exportW, exportH) {
        if (!_hasDoc) return null;
        var live = document.getElementById('prism_plot_canvas');
        if (!live) return null;
        var off = document.createElement('canvas');
        off.width  = exportW || live.width  || 1200;
        off.height = exportH || live.height || 800;
        try {
            var ctx = off.getContext('2d');
            ctx.drawImage(live, 0, 0, off.width, off.height);
            return off;
        } catch (e) { return null; }
    }

    G.PRiSM_copyPlotToClipboard = function PRiSM_copyPlotToClipboard(plotKey) {
        return new Promise(function (resolve) {
            try {
                var off = _renderPlotToCanvas(plotKey, 1200, 800);
                if (!off) off = _snapshotLivePlot(1200, 800);
                if (!off || !off.toBlob) {
                    resolve({ success: false, error: 'No canvas available' });
                    return;
                }
                if (!_hasClipboardImageAPI()) {
                    // Graceful fallback — emit data URL so caller can use it.
                    var url = '';
                    try { url = off.toDataURL('image/png'); } catch (e) {}
                    resolve({
                        success: false,
                        error:   'Clipboard image API unavailable in this context',
                        dataUrl: url
                    });
                    return;
                }
                off.toBlob(function (blob) {
                    if (!blob) {
                        resolve({ success: false, error: 'toBlob returned null' });
                        return;
                    }
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

    function _serializeDataset_TSV(ds, sep) {
        if (!ds || !Array.isArray(ds.t)) return '';
        var cols = ['t'];
        if (ds.p) cols.push('p');
        if (ds.q) cols.push('q');
        if (ds.dp) cols.push('dp');
        var lines = [cols.join(sep)];
        for (var i = 0; i < ds.t.length; i++) {
            var row = [String(ds.t[i])];
            if (ds.p) row.push(String(ds.p[i]));
            if (ds.q) row.push(String(ds.q[i]));
            if (ds.dp) row.push(String(ds.dp[i]));
            lines.push(row.join(sep));
        }
        return lines.join('\n');
    }

    function _serializeDataset_JSON(ds) {
        if (!ds) return '{}';
        var out = { t: ds.t || [], p: ds.p || null, q: ds.q || null };
        if (ds.dp) out.dp = ds.dp;
        if (ds.periods) out.periods = ds.periods;
        return JSON.stringify(out);
    }

    G.PRiSM_copyDataToClipboard = function PRiSM_copyDataToClipboard(format) {
        format = (format || 'tsv').toLowerCase();
        return new Promise(function (resolve) {
            try {
                var ds = G.PRiSM_dataset;
                if (!ds || !Array.isArray(ds.t) || !ds.t.length) {
                    resolve({ success: false, error: 'No dataset loaded' });
                    return;
                }
                var text = '';
                if (format === 'tsv') text = _serializeDataset_TSV(ds, '\t');
                else if (format === 'csv') text = _serializeDataset_TSV(ds, ',');
                else if (format === 'json') text = _serializeDataset_JSON(ds);
                else { resolve({ success: false, error: 'Unsupported format: ' + format }); return; }

                if (!_hasClipboardTextAPI()) {
                    resolve({
                        success: false,
                        error:   'Clipboard text API unavailable in this context',
                        text:    text
                    });
                    return;
                }
                G.navigator.clipboard.writeText(text).then(function () {
                    _ga4('prism_copy_data', { format: format, length: text.length });
                    resolve({ success: true, length: text.length });
                }, function (err) {
                    resolve({ success: false, error: (err && err.message) || String(err) });
                });
            } catch (e) {
                resolve({ success: false, error: e && e.message });
            }
        });
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — COMBINED CLIPBOARD TOOLBAR UI
    // ═══════════════════════════════════════════════════════════════

    G.PRiSM_renderClipboardToolbar = function PRiSM_renderClipboardToolbar(container) {
        if (!container || !_hasDoc) return;
        var th = _theme();
        container.innerHTML =
            '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">' +
                '<button type="button" data-cb-plot style="padding:5px 12px; background:' + th.bg +
                    '; color:' + th.text + '; border:1px solid ' + th.border +
                    '; border-radius:4px; font-size:12px; cursor:pointer;">Copy plot</button>' +
                '<button type="button" data-cb-data style="padding:5px 12px; background:' + th.bg +
                    '; color:' + th.text + '; border:1px solid ' + th.border +
                    '; border-radius:4px; font-size:12px; cursor:pointer;">Copy data (TSV)</button>' +
                '<button type="button" data-cb-xml style="padding:5px 12px; background:' + th.bg +
                    '; color:' + th.text + '; border:1px solid ' + th.border +
                    '; border-radius:4px; font-size:12px; cursor:pointer;">Export XML</button>' +
                '<span data-cb-msg style="font-size:11px; color:' + th.text2 + '; margin-left:8px;"></span>' +
            '</div>';
        var msg = container.querySelector('[data-cb-msg]');
        function flash(text, isErr) {
            if (!msg) return;
            msg.style.color = isErr ? th.red : th.green;
            msg.textContent = text;
            setTimeout(function () { if (msg) msg.textContent = ''; }, 2500);
        }
        var pBtn = container.querySelector('[data-cb-plot]');
        if (pBtn) pBtn.addEventListener('click', function () {
            G.PRiSM_copyPlotToClipboard().then(function (r) {
                if (r.success) flash('Plot copied to clipboard.');
                else flash('Copy plot failed: ' + (r.error || 'unknown'), true);
            });
        });
        var dBtn = container.querySelector('[data-cb-data]');
        if (dBtn) dBtn.addEventListener('click', function () {
            G.PRiSM_copyDataToClipboard('tsv').then(function (r) {
                if (r.success) flash('Data copied (' + r.length + ' chars).');
                else flash('Copy data failed: ' + (r.error || 'unknown'), true);
            });
        });
        var xBtn = container.querySelector('[data-cb-xml]');
        if (xBtn) xBtn.addEventListener('click', function () {
            try {
                G.PRiSM_exportXMLDownload();
                flash('XML export downloaded.');
            } catch (e) {
                flash('Export failed: ' + (e && e.message), true);
            }
        });
    };

    // ═══════════════════════════════════════════════════════════════

})();

// ─── END 21-plot-utilities ─────────────────────────────────────────────

