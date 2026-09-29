// ════════════════════════════════════════════════════════════════════
// WTS — Layer 27 — Pipe Remaining Service Life (Sand-Erosion)
//
// PURPOSE
//   Sand-erosion screening calculator (DNV-RP-O501 / Salama 2000) for the H2Oil Well
//   Testing Suite. For each pipe segment between the wellhead and the
//   flare tip the layer estimates:
//
//     1. Erosion rate              (mils/year)
//     2. Remaining Service Life    (days, measured WT -> minimum-spec WT)
//     3. Time-to-failure           (days, measured WT -> failure WT)
//     4. Maximum allowable working pressure (ASME B31.3 Eq. 3a, measured WT)
//
//   Coflex flexible hoses are tagged "NOT APPLICABLE" because their wall
//   architecture does not erode in the same way as rigid line pipe.
//
// PUBLIC API (all on window.*)
//
//   renderPipeLife(body)
//        — paints the calculator into the supplied container.
//
//   WTS_sandErosion_compute(input)
//        — sand erosion rate (mm/y and mpy): DNV-RP-O501 pipe bend (default),
//          DNV-RP-O501 straight pipe, Salama (2000) elbow, or the legacy
//          calibrated fit. See "SAND-EROSION MODELS" below.
//   WTS_erosion_rate_legacy(W_sand_lbMMscf, v_fps, D_in, c)
//        — the v1.8 calibrated fit in mils/year (WTS_erosion_rate_salama is
//          a deprecated alias with the same numbers).
//
//   WTS_pipelife_segment(input)
//        — single-segment compute:
//            input  = { material, schedule_in, nps_in, erosion_model,
//                       gas_rate_MMscfd | sand_lb_d, rho_m_lbft3, mu_m_cp,
//                       particle_um, bend_RD, GF,
//                       measured_WT_in, min_spec_WT_in, failure_WT_in,
//                       design_pressure_psig, design_temp_F,
//                       sand_rate_lbMMscf, c_constant,
//                       mixture_velocity_fps }
//            output = { erosion_rate_mils_yr,
//                       remaining_service_life_days,
//                       time_to_failure_at_current_days,
//                       max_allowable_pressure_psig,
//                       warnings, ok_to_operate }
//
//   WTS_pipelife_compute(inputs)
//        — full system compute, returns { segments, overall_min_life_days,
//          limiting_segment, sand_rate_lbMMscf, c_constant }.
//
//   WTS_PIPELIFE_MATERIALS, WTS_PIPELIFE_SCHEDULES
//        — read-only reference data (materials + ASME B36.10M wall table).
//
// IMPORTANT NOTES (also surfaced in UI)
//   * Estimations assume Cushion Tees and/or Machined Block Elbows are
//     used and all valves are Full Port. Regular long/short-radius
//     elbows concentrate sand to the outer radius; reduced-port valves
//     accelerate local velocity.
//   * Residual sand fines are assumed to drop out in the separator, so
//     downstream of the separator changes to sand poundage / filter
//     efficiency have no effect unless the separator is bypassed.
//
// CONVENTIONS
//   - Single outer IIFE, 'use strict'.
//   - Pure vanilla JS, no external deps.
//   - Defensive: every input is sanity-clamped before arithmetic.
//   - Field units throughout (psig, °F, ft/s, inches, lbs/MMscf, days).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // ───────────────────────────────────────────────────────────────
    // Tiny env helpers
    // ───────────────────────────────────────────────────────────────
    function _log() {
        if (typeof console !== 'undefined' && console.log) {
            try { console.log.apply(console, arguments); } catch (e) {}
        }
    }
    function _err() {
        if (typeof console !== 'undefined' && console.error) {
            try { console.error.apply(console, arguments); } catch (e) {}
        }
    }
    function _num(v, dflt) {
        var n = (typeof v === 'number') ? v : parseFloat(v);
        if (!isFinite(n)) return (dflt === undefined ? 0 : dflt);
        return n;
    }
    function _fmt(n, p) {
        if (!isFinite(n)) return '—';
        var d = (p === undefined) ? 2 : p;
        if (Math.abs(n) >= 10000) return n.toFixed(0);
        if (Math.abs(n) >= 100)   return n.toFixed(Math.min(d, 1));
        return n.toFixed(d);
    }
    // Display in the active unit system (22-units.js); calcs stay imperial.
    function _metric() {
        var U = G.WTS_units;
        return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format);
    }
    function _uval(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _ulab(cat, impLabel) { return _metric() ? G.WTS_units.format(0, cat).label : impLabel; }
    function _u(v, cat, dp, impLabel, dpMet) {
        if (!isFinite(v)) return '—';
        return _fmt(_uval(v, cat), _metric() && dpMet != null ? dpMet : dp) + ' ' + _ulab(cat, impLabel);
    }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    // Standard conditions of the gas rate: the standard-conditions setting
    // when one is chosen, else 14.696 psia / 60 °F.
    function _basis() {
        var B = G.WTS_baseConditions;
        if (B && B.resolve) return B.resolve(60, 14.696);
        return { Tb_F: 60, Tb_R: 519.67, Pb_psia: 14.696, label: '60 °F / 14.696 psia', fromSetting: false };
    }
    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function _$(id) {
        if (typeof document === 'undefined') return null;
        return document.getElementById(id);
    }

    // ───────────────────────────────────────────────────────────────
    // Reference data
    // ───────────────────────────────────────────────────────────────
    // Material database — typical test-pipework grades.
    //   density_lbft3   — for mass / specific-weight calcs (informational)
    //   tensile_psi     — UTS  } B31.3 allowable S = min(UTS/3, 2·Sy/3)
    //   yield_psi       — Sy   }
    //   erodes          — false for hose / non-metallic
    //   notes           — short note for tooltip / UI
    var MATERIALS = {
        '5L-X52':   { label: 'API 5L X52',  density_lbft3: 490, tensile_psi: 66700,  yield_psi: 52000, erodes: true,  notes: 'standard line pipe' },
        '5L-X60':   { label: 'API 5L X60',  density_lbft3: 490, tensile_psi: 75000,  yield_psi: 60000, erodes: true,  notes: 'higher-grade line pipe' },
        '5L-X65':   { label: 'API 5L X65',  density_lbft3: 490, tensile_psi: 77100,  yield_psi: 65300, erodes: true,  notes: 'sour-service compatible' },
        'A106-B':   { label: 'A106 Gr B',   density_lbft3: 490, tensile_psi: 60000,  yield_psi: 35000, erodes: true,  notes: 'mild carbon, ambient service' },
        'A333gr6':  { label: 'A333 Gr 6',   density_lbft3: 490, tensile_psi: 60000,  yield_psi: 35000, erodes: true,  notes: 'low-temperature service' },
        '316SS':    { label: '316 SS',      density_lbft3: 501, tensile_psi: 75000,  yield_psi: 30000, erodes: true,  notes: 'sour-service stainless' },
        'Inconel625':{ label: 'Inconel 625', density_lbft3: 525, tensile_psi: 120000, yield_psi: 60000, erodes: true,  notes: 'premium sour / CRA' },
        'Coflex':   { label: 'Coflex hose', density_lbft3: 96,  tensile_psi: 50000,  yield_psi: 30000, erodes: false, notes: 'flexible — no erosion calc' }
    };

    // ASME B36.10M — wall thickness in inches by NPS + schedule / weight class
    // for the common test-pipework sizes (2" through 8"): Sch 40, 80, 160 and
    // XXS (double extra strong, the heavy wall used on choke manifolds).
    // "Schedule 180" is NOT a B36.10M designation. v1.0-v1.8 listed it with
    // 2"/4"/6" walls equal to XXS and two values that are in no table
    // (3" 0.552 in, 8" 1.000 in); saved "180" (and the old "XXH" label)
    // now load as XXS — see normSchedule() and the page note.
    var SCHEDULES = {
        '2': { '40': 0.154, '80': 0.218, '160': 0.344, 'XXS': 0.436 },
        '3': { '40': 0.216, '80': 0.300, '160': 0.438, 'XXS': 0.600 },
        '4': { '40': 0.237, '80': 0.337, '160': 0.531, 'XXS': 0.674 },
        '6': { '40': 0.280, '80': 0.432, '160': 0.719, 'XXS': 0.864 },
        '8': { '40': 0.322, '80': 0.500, '160': 0.906, 'XXS': 0.875 }
    };
    var SCHEDULE_KEYS = ['40', '80', '160', 'XXS'];
    // Saved / imported schedule → a B36.10M key. Returns { sch, migrated }.
    function normSchedule(s) {
        var k = String(s == null ? '' : s).trim().toUpperCase().replace(/^SCH\s*/, '');
        if (k === '180' || k === 'XXH') return { sch: 'XXS', migrated: k === '180' ? '180' : null };
        return { sch: k, migrated: null };
    }
    G.WTS_pipelife_normSchedule = normSchedule;

    // Outside diameter (NPS -> OD inches), ANSI B36.10.
    var ODS = { '2': 2.375, '3': 3.500, '4': 4.500, '6': 6.625, '8': 8.625 };

    // Default segments for the test-string layout (wellhead -> flare).
    // p_seg_psig / t_seg_F are TYPICAL flowing values along the path —
    // upstream of choke ~3000 psig, downstream of choke ~500 psig,
    // separator ~150 psig, flare line ~50 psig — used as the velocity proxy.
    var DEFAULT_SEGMENTS = [
        { key: 'wh_hose',   label: 'Wellhead -> Coflex Hose', material: 'Coflex',  nps_in: 4, sch: 80,
          length_ft: 50,  measured_WT_in: 0.337, min_spec_WT_in: 0.295, failure_WT_in: 0.080,
          design_p_psig: 5000, design_T_F: 250, p_seg_psig: 3000, t_seg_F: 180 },
        { key: 'hose_ssv',  label: 'Hose -> SSV',             material: 'A333gr6', nps_in: 4, sch: 80,
          length_ft: 30,  measured_WT_in: 0.337, min_spec_WT_in: 0.295, failure_WT_in: 0.067,
          design_p_psig: 5000, design_T_F: 250, p_seg_psig: 2950, t_seg_F: 175 },
        { key: 'ssv_choke', label: 'SSV -> Choke',            material: '5L-X52',  nps_in: 4, sch: 'XXS',
          length_ft: 50,  measured_WT_in: 0.674, min_spec_WT_in: 0.590, failure_WT_in: 0.067,
          design_p_psig: 10000,design_T_F: 250, p_seg_psig: 2900, t_seg_F: 170 },
        // Was "SCH 180" 0.552 / 0.483 in (not a B36.10M wall): 3" XXS = 0.600 in,
        // min-spec 87.5 % = 0.525 in.
        { key: 'choke_htr', label: 'Choke -> Heater',         material: 'A333gr6', nps_in: 3, sch: 'XXS',
          length_ft: 100, measured_WT_in: 0.600, min_spec_WT_in: 0.525, failure_WT_in: 0.067,
          design_p_psig: 5000, design_T_F: 250, p_seg_psig: 500, t_seg_F: 100 },
        { key: 'htr_sep',   label: 'Heater -> Separator',     material: 'A333gr6', nps_in: 4, sch: 80,
          length_ft: 100, measured_WT_in: 0.337, min_spec_WT_in: 0.295, failure_WT_in: 0.067,
          design_p_psig: 1440, design_T_F: 250, p_seg_psig: 250, t_seg_F: 150 },
        { key: 'sep_flare', label: 'Separator -> Flare Tip',  material: 'A333gr6', nps_in: 4, sch: 40,
          length_ft: 300, measured_WT_in: 0.237, min_spec_WT_in: 0.207, failure_WT_in: 0.067,
          design_p_psig: 285,  design_T_F: 250, p_seg_psig: 50,  t_seg_F: 100 }
    ];

    // ───────────────────────────────────────────────────────────────
    // Helpers — pipe geometry
    // ───────────────────────────────────────────────────────────────
    function getOD(nps_in) {
        var key = String(nps_in);
        return ODS[key] || (Math.max(0.5, _num(nps_in, 4)) + 0.5);
    }
    function getNominalWT(nps_in, sch) {
        var nKey = String(nps_in), sKey = normSchedule(sch).sch;
        if (SCHEDULES[nKey] && SCHEDULES[nKey][sKey] != null) {
            return SCHEDULES[nKey][sKey];
        }
        // Fallback: SCH 40 of next-larger NPS
        if (SCHEDULES[nKey] && SCHEDULES[nKey]['40'] != null) return SCHEDULES[nKey]['40'];
        return 0.237;
    }
    function getInnerDiameter(nps_in, sch, wt_override) {
        var od = getOD(nps_in);
        var wt = (wt_override != null && isFinite(wt_override) && wt_override > 0)
            ? wt_override : getNominalWT(nps_in, sch);
        return Math.max(od - 2 * wt, 0.25);
    }

    // ───────────────────────────────────────────────────────────────
    // SAND-EROSION MODELS
    //
    // Default: DNV-RP-O501 (DNVGL-RP-O501, Aug 2015, §4.7 "Pipe bends";
    // the same steps are DNV-RP-O501 Rev 4.2 (2007) §8.4, eqs 8.15-8.21):
    //
    //   α   = arctan( 1 / (2·R) )            R = bend radius / pipe ID   (4.28)
    //   A   = ρm²·tan α·Up·D / (ρp·μm)                                      (4.29)
    //   γc  = ρm / (ρp·[1.88·ln A − 6.04])   if 0 < γc < 0.1, else 0.1      (4.30)
    //   G   = γ/γc if γ < γc, else 1         γ = dp / D                     (4.31)
    //   F(α)= 0.6·[sin α + 7.2(sin α − sin²α)]^0.6·[1 − exp(−20α)]  ductile (3.3)
    //   EL  = K·F(α)·Up^n·sin α·G·C1·GF·ṁp·Cunit / (ρt·Apipe)   [mm/year]
    //   K = 2.0e-9 (m/s)^-n, n = 2.6, ρt = 7800 kg/m³ (steel grades: 2015
    //   Table 3-1, 2007 Table 7-2), C1 = 2.5, Cunit = 3.15e10 (m/s → mm/y),
    //   ρp = 2650 kg/m³ (quartz sand), GF = 1 (≥ 10 D of straight pipe
    //   upstream) or 2 (components < 10 D apart, 2015 §4.3 example).
    //
    // Straight pipe (2015 eq 4.22 / 2007 eq 8.9):  EL = 2.5e-5·Up^2.6·D^-2·ṁp
    //   [mm/y, D in m, ṁp in kg/s]; the 2015 relative form 8.0e-10·Up^2.6·D^-2
    //   [mm/ton] is the same law (1 t/y = 3.171e-5 kg/s).
    //
    // Salama (2000), "An alternative to API 14E erosional velocity limits for
    //   sand-laden fluids", J. Energy Resour. Technol. 122(2):71-77:
    //   ER = W·V²·d / (Sm·D²·ρm)   [mm/y]; W kg/day, V m/s, d µm, D mm,
    //   ρm kg/m³, Sm = 5.5 (elbows).
    //
    // All three scale LINEARLY with the sand mass rate, and as V^2.6 (DNV) or
    // V² (Salama). Up = mixture velocity (2015 eq 4.6). The DNV constants are
    // for steel grades (carbon steel and CRAs agree within ~10-20 %, 2007 §7);
    // the page applies them to every rigid segment.
    //
    // Legacy calibrated fit (the v1.0-v1.8 default, kept selectable so saved
    // projects reproduce): E [mpy] = 2.8·(c/300)·W·v²/D², W lb/MMscf, v ft/s,
    // D in. It was calibrated to a "~15 day" reference life, not to a
    // published model, and reads two to three orders of magnitude above DNV.
    // ───────────────────────────────────────────────────────────────
    var DNV = { K: 2.0e-9, n: 2.6, rhoT: 7800, C1: 2.5, Cunit: 3.15e10, rhoP: 2650 };
    var EROSION_MODELS = {
        dnv_bend:     'DNV-RP-O501 pipe bend',
        dnv_straight: 'DNV-RP-O501 straight pipe',
        salama:       'Salama (2000) elbow',
        legacy:       'Legacy calibrated fit (v1.8)'
    };
    var LB_TO_KG = 0.45359237, FT_TO_M = 0.3048, IN_TO_M = 0.0254, LBFT3_TO_KGM3 = 16.018463;

    var SALAMA_K_AT_C300 = 2.8;
    function erosion_rate_legacy(W_sand_lbMMscf, v_fps, D_in, c) {
        var W = Math.max(_num(W_sand_lbMMscf, 0), 0);
        var v = Math.max(_num(v_fps, 0), 0);
        var D = Math.max(_num(D_in, 0.5), 0.1);
        var cc = _num(c, 300);
        if (W === 0 || v === 0) return 0;
        var K_eff = (cc / 300) * SALAMA_K_AT_C300;
        return K_eff * W * v * v / (D * D);
    }
    G.WTS_erosion_rate_legacy = erosion_rate_legacy;
    // Deprecated alias: the v1.8 name of the calibrated fit (same numbers, same
    // signature). New code calls WTS_sandErosion_compute.
    G.WTS_erosion_rate_salama = erosion_rate_legacy;

    // DNV ductile impact-angle function (2015 eq 3.3), α in radians.
    function dnvF(alpha) {
        var s = Math.sin(alpha);
        var b = s + 7.2 * (s - s * s);
        if (!(b > 0)) return 0;
        return 0.6 * Math.pow(b, 0.6) * (1 - Math.exp(-20 * alpha));
    }
    G.WTS_dnv_F = dnvF;

    // input (field units): { model, sand_lb_d | sand_kg_s, v_fps, D_in,
    //   rho_m_lbft3, mu_m_cp, particle_um, bend_RD, GF,
    //   sand_lbMMscf + c (legacy only) }
    // → { model, label, E_mm_y, E_mpy, …intermediates }
    function sandErosion_compute(input) {
        input = input || {};
        var model = Object.prototype.hasOwnProperty.call(EROSION_MODELS, input.model) ? input.model : 'dnv_bend';
        var out = { model: model, label: EROSION_MODELS[model], E_mm_y: 0, E_mpy: 0 };
        var v = Math.max(_num(input.v_fps, 0), 0), Up = v * FT_TO_M;
        var Din = Math.max(_num(input.D_in, 0), 0), D = Din * IN_TO_M;
        if (model === 'legacy') {
            out.E_mpy = erosion_rate_legacy(input.sand_lbMMscf, v, Din, input.c);
            out.E_mm_y = out.E_mpy * 0.0254;
            return out;
        }
        var mp = (input.sand_kg_s != null && isFinite(input.sand_kg_s)) ? Math.max(+input.sand_kg_s, 0)
               : Math.max(_num(input.sand_lb_d, 0), 0) * LB_TO_KG / 86400;        // kg/s
        out.sand_kg_s = mp;
        if (!(mp > 0) || !(Up > 0) || !(D > 0)) return out;
        var E;
        if (model === 'dnv_straight') {
            E = 2.5e-5 * Math.pow(Up, 2.6) * Math.pow(D, -2) * mp;
        } else {
            var rhoM = Math.max(_num(input.rho_m_lbft3, 0), 1e-6) * LBFT3_TO_KGM3;   // kg/m³
            var dp_um = Math.max(_num(input.particle_um, 250), 0);
            out.rho_m_kgm3 = rhoM;
            if (model === 'salama') {
                out.Sm = 5.5;
                E = (mp * 86400) * Up * Up * dp_um / (out.Sm * Math.pow(D * 1000, 2) * rhoM);
            } else {
                var R = Math.max(_num(input.bend_RD, 1.5), 0.5);
                var GF = Math.max(_num(input.GF, 1), 1);
                var muM = Math.max(_num(input.mu_m_cp, 0.012), 1e-6) * 1e-3;          // Pa·s
                var alpha = Math.atan(1 / (2 * R));
                var A = rhoM * rhoM * Math.tan(alpha) * Up * D / (DNV.rhoP * muM);
                var den = 1.88 * Math.log(A) - 6.04;
                var gc = den > 0 ? rhoM / (DNV.rhoP * den) : 0.1;
                if (!(gc > 0 && gc < 0.1)) gc = 0.1;
                var gam = dp_um * 1e-6 / D;
                var Gc = gam < gc ? gam / gc : 1;
                var F = dnvF(alpha);
                var Apipe = Math.PI / 4 * D * D;
                E = DNV.K * F * Math.pow(Up, DNV.n) * Math.sin(alpha) * Gc * DNV.C1 * GF * mp * DNV.Cunit / (DNV.rhoT * Apipe);
                out.alpha_deg = alpha * 180 / Math.PI; out.A = A; out.gammaC = gc; out.gamma = gam;
                out.G = Gc; out.F = F; out.GF = GF; out.R = R; out.mu_m_Pas = muM;
            }
        }
        out.E_mm_y = E;
        out.E_mpy = E / 0.0254;
        return out;
    }
    G.WTS_sandErosion_compute = sandErosion_compute;
    G.WTS_EROSION_MODELS = EROSION_MODELS;

    // ───────────────────────────────────────────────────────────────
    // Maximum allowable working pressure — ASME B31.3 §304.1.2 Eq. (3a)
    // solved for P with the MEASURED wall (no mill tolerance / corrosion
    // allowance — the UT reading is the actual wall):
    //
    //   P = 2·S·E·W·t / (D − 2·Y·t),   E = W = 1, Y = 0.4
    //   S = min(UTS/3, 2·Sy/3)   (B31.3 §302.3.2 basis; e.g. A106-B /
    //                             A333-6 → 20 ksi, X52 → 22.2 ksi)
    //
    // The previous form (2·Sy·0.875·t/OD) used the full YIELD stress with no
    // design factor — a yield-onset pressure, ~1.5× higher than an allowable.
    // Temperature derating above ~400 °F is not applied (screening).
    //   * For Coflex hose return the typical 5000 psi WP rating.
    // ───────────────────────────────────────────────────────────────
    function maxAllowablePressure(material_key, measured_WT_in, nps_in) {
        var m = MATERIALS[material_key] || MATERIALS['A333gr6'];
        if (!m.erodes) return 5000; // hose rated WP (typical)
        var od = getOD(nps_in);
        var S = Math.min(m.tensile_psi / 3, 2 * m.yield_psi / 3);
        var t = Math.max(_num(measured_WT_in, 0), 0);
        var den = od - 2 * 0.4 * t;
        if (!(den > 0)) return 0;
        return 2 * S * t / den;
    }

    // ───────────────────────────────────────────────────────────────
    // Mixture velocity for a segment given pressure / temperature
    //
    //   v_mix [ft/s] = ( Q_gas_actual + Q_liq ) / cross-section
    //   Q_gas_actual = Qg_MMscfd * 1e6 / 86400 * (P_atm / P_seg) * (T_seg / T_std)
    //   Q_liq        = (Qo_bpd + Qw_bpd) * 5.615 / 86400
    //
    // Conservative — neglects compressibility Z (~0.85-1.0 in field range,
    // small relative to other approximations in this screening).
    // ───────────────────────────────────────────────────────────────
    function mixtureVelocity(seg, sys) {
        var Qg = _num(sys.gas_rate_MMscfd, 0);
        var Qo = _num(sys.oil_rate_bpd, 0);
        var Qw = _num(sys.water_rate_bpd, 0);
        var Pseg = Math.max(_num(seg.p_seg_psig, 100), 0);
        var Tseg = _num(seg.t_seg_F, 70);
        var P_abs = Pseg + 14.696;
        var T_abs = Tseg + 459.67;
        var bc = _basis();                      // standard conditions of Qg
        var Qg_acfs = Qg * 1e6 / 86400 * (bc.Pb_psia / Math.max(P_abs, 14.696)) * (T_abs / bc.Tb_R);
        var Qliq_cfs = (Qo + Qw) * 5.615 / 86400;
        var ID = getInnerDiameter(seg.nps_in, seg.sch, seg.measured_WT_in);
        var Dft = ID / 12;
        var A = Math.PI / 4 * Dft * Dft;
        if (A <= 0) return 0;
        return (Qg_acfs + Qliq_cfs) / A;
    }
    G.WTS_pipelife_mixture_velocity = mixtureVelocity;

    // In-situ mixture density / viscosity for the erosion models, weighted by
    // superficial velocity (DNVGL-RP-O501 2015 eqs 4.9-4.10). Same ideal-gas
    // in-situ volume as mixtureVelocity (Z = 1): ρg = P·28.9647·SG/(10.7316·T).
    // Liquids: water 62.37 lb/ft³ × SG (oil SG input, water SG 1.0).
    // Screening viscosities (the page has no viscosity inputs): gas 0.012 cP,
    // oil 1 cP, water 1 cP — low values are conservative in the DNV bend model
    // (a larger A gives a smaller critical particle size, so G → 1).
    var MU_GAS_CP = 0.012, MU_OIL_CP = 1.0, MU_WATER_CP = 1.0;
    function mixtureProps(seg, sys) {
        var Qg = _num(sys.gas_rate_MMscfd, 0), Qo = _num(sys.oil_rate_bpd, 0), Qw = _num(sys.water_rate_bpd, 0);
        var SGg = _num(sys.gasSG, 0.65), SGo = _num(sys.oilSG, 0.80);
        var P_abs = Math.max(Math.max(_num(seg.p_seg_psig, 100), 0) + 14.696, 14.696);
        var T_R = _num(seg.t_seg_F, 70) + 459.67;
        var bc = _basis();
        var qg = Qg * 1e6 / 86400 * (bc.Pb_psia / P_abs) * (T_R / bc.Tb_R);    // acf/s
        var qo = Qo * 5.615 / 86400, qw = Qw * 5.615 / 86400;                   // ft³/s
        var q = qg + qo + qw;
        var rhoG = P_abs * 28.9647 * SGg / (10.7316 * T_R);
        var rhoO = 62.37 * SGo, rhoW = 62.37;
        var out = { qg_acfs: qg, ql_cfs: qo + qw, rho_g_lbft3: rhoG, rho_m_lbft3: 0, mu_m_cp: 0 };
        if (q > 0) {
            out.rho_m_lbft3 = (rhoG * qg + rhoO * qo + rhoW * qw) / q;
            out.mu_m_cp = (MU_GAS_CP * qg + MU_OIL_CP * qo + MU_WATER_CP * qw) / q;
        }
        return out;
    }
    G.WTS_pipelife_mixture_props = mixtureProps;

    // ───────────────────────────────────────────────────────────────
    // Single-segment compute
    // ───────────────────────────────────────────────────────────────
    function pipelife_segment(input) {
        input = input || {};
        var matKey = input.material || 'A333gr6';
        var mat = MATERIALS[matKey] || MATERIALS['A333gr6'];
        var nps  = _num(input.nps_in, 4);
        var schN = normSchedule(input.schedule_in || input.sch || 80);
        var sch  = schN.sch;
        var measured = Math.max(_num(input.measured_WT_in, getNominalWT(nps, sch)), 0);
        var minspec  = Math.max(_num(input.min_spec_WT_in, getNominalWT(nps, sch) * 0.875), 0);
        var failWT   = Math.max(_num(input.failure_WT_in, Math.max(measured - 0.05, 0.024)), 0);
        var design_p = _num(input.design_pressure_psig, 5000);
        var design_T = _num(input.design_temp_F, 250);
        var W_sand   = Math.max(_num(input.sand_rate_lbMMscf, 0), 0);
        var c        = Math.max(_num(input.c_constant, 300), 0);
        var v_fps    = Math.max(_num(input.mixture_velocity_fps, 0), 0);
        var model    = Object.prototype.hasOwnProperty.call(EROSION_MODELS, input.erosion_model) ? input.erosion_model : 'dnv_bend';
        var Qg       = Math.max(_num(input.gas_rate_MMscfd, 0), 0);
        var sand_lb_d = (input.sand_lb_d != null && isFinite(input.sand_lb_d)) ? Math.max(+input.sand_lb_d, 0) : W_sand * Qg;

        var warnings = [];
        var ID = getInnerDiameter(nps, sch, measured);

        var out = {
            material: matKey,
            material_label: mat.label,
            erodes: mat.erodes,
            nps_in: nps, sch: sch, OD_in: getOD(nps), ID_in: ID,
            measured_WT_in: measured, min_spec_WT_in: minspec, failure_WT_in: failWT,
            mixture_velocity_fps: v_fps,
            sand_rate_lbMMscf: W_sand, c_constant: c, sand_lb_d: sand_lb_d,
            erosion_model: model, erosion_model_label: EROSION_MODELS[model], erosion: null,
            schedule_migrated_from: schN.migrated,
            design_pressure_psig: design_p, design_temp_F: design_T,
            erosion_rate_mils_yr: 0,
            remaining_service_life_days: Infinity,
            time_to_failure_at_current_days: Infinity,
            max_allowable_pressure_psig: maxAllowablePressure(matKey, measured, nps),
            warnings: warnings,
            ok_to_operate: true,
            applicable: mat.erodes
        };

        // Hose: erosion calc not applicable.
        if (!mat.erodes) {
            warnings.push('Coflex hose — sand-erosion service-life calc not applicable.');
            out.note = 'NOT APPLICABLE TO HOSE';
            return out;
        }

        // Sanity warnings.
        if (failWT >= measured) {
            warnings.push('Failure wall thickness >= measured WT — segment is already at/below failure.');
            out.ok_to_operate = false;
        }
        if (minspec > measured) {
            warnings.push('Measured WT is below minimum-spec — segment is below allowable.');
            out.ok_to_operate = false;
        }
        if (out.max_allowable_pressure_psig < design_p) {
            warnings.push('Max allowable pressure (' + _u(out.max_allowable_pressure_psig, 'pressureG', 0, 'psig') +
                          ') is below design ' + _u(design_p, 'pressureG', 0, 'psig') + '.');
            out.ok_to_operate = false;
        }

        // Erosion rate.
        var ero = sandErosion_compute({
            model: model, v_fps: v_fps, D_in: ID,
            sand_lb_d: sand_lb_d, sand_lbMMscf: W_sand, c: c,
            rho_m_lbft3: input.rho_m_lbft3, mu_m_cp: input.mu_m_cp,
            particle_um: input.particle_um, bend_RD: input.bend_RD, GF: input.GF
        });
        out.erosion = ero;
        var E_mpy = ero.E_mpy;
        out.erosion_rate_mils_yr = E_mpy;
        out.erosion_rate_mm_yr = ero.E_mm_y;

        // Remaining service life: measured -> minspec (conservative).
        if (E_mpy > 0) {
            var allow_RSL_in = Math.max(measured - minspec, 0);
            var allow_RSL_mils = allow_RSL_in * 1000;
            var rsl_yr = allow_RSL_mils / E_mpy;
            out.remaining_service_life_days = rsl_yr * 365.25;

            // Time to failure at current flow: measured -> failure WT (less conservative).
            var allow_TTF_in = Math.max(measured - failWT, 0);
            var allow_TTF_mils = allow_TTF_in * 1000;
            var ttf_yr = allow_TTF_mils / E_mpy;
            out.time_to_failure_at_current_days = ttf_yr * 365.25;
        } else {
            // No erosion -> infinite life. Cap at 50 years for display sanity.
            out.remaining_service_life_days = 50 * 365.25;
            out.time_to_failure_at_current_days = 50 * 365.25;
        }

        if (out.remaining_service_life_days < 30) {
            warnings.push('Remaining service life < 30 days — recommend immediate inspection / shutdown.');
            out.ok_to_operate = false;
        } else if (out.remaining_service_life_days < 90) {
            warnings.push('Remaining service life < 90 days — schedule mitigation.');
        }
        if (W_sand > 100) {
            warnings.push('Sand poundage > ' + _u(100, 'sandLoading', 0, 'lb/MMscf') + ' — verify desander efficiency.');
        }

        return out;
    }
    G.WTS_pipelife_segment = pipelife_segment;

    // ───────────────────────────────────────────────────────────────
    // Whole-system compute
    //
    // Notes on separator-bypass behaviour:
    //   * Default operating mode assumes the separator is in service.
    //   * Sand drops out in the separator, so any segment after the
    //     separator (typically Sep -> Flare Tip) sees zero sand load.
    //   * Caller can override by setting seg.bypass_separator = true to
    //     force sand all the way to flare for sensitivity studies.
    // ───────────────────────────────────────────────────────────────
    function pipelife_compute(inputs) {
        inputs = inputs || {};
        var W_sand = _num(inputs.sand_production_lbMMscf, 50);
        var c = _num(inputs.c_constant, 300);
        var bypassSep = !!inputs.bypass_separator;
        var segments = (inputs.segments && inputs.segments.length) ? inputs.segments : DEFAULT_SEGMENTS.slice();
        var sysQ = {
            gas_rate_MMscfd: _num(inputs.gas_rate_MMscfd, 0),
            oil_rate_bpd:    _num(inputs.oil_rate_bpd, 0),
            water_rate_bpd:  _num(inputs.water_rate_bpd, 0),
            gasSG:           _num(inputs.gasSG, 0.65),
            oilSG:           _num(inputs.oilSG, 0.80)
        };
        var model = Object.prototype.hasOwnProperty.call(EROSION_MODELS, inputs.erosion_model) ? inputs.erosion_model : 'dnv_bend';
        var ero = {
            particle_um: _num(inputs.particle_um, 250),
            bend_RD:     _num(inputs.bend_RD, 1.5),
            GF:          _num(inputs.GF, 1)
        };

        // Find the index of the FIRST segment that starts AFTER the separator —
        // i.e. a label whose left-hand side is "Separator" (e.g. "Separator -> Flare Tip"),
        // or any segment explicitly flagged with is_after_separator.
        var sepIdx = -1;
        for (var i = 0; i < segments.length; i++) {
            var lbl = (segments[i].label || segments[i].key || '').toLowerCase().trim();
            var lhs = lbl.split('->')[0].trim();
            if (lhs.indexOf('separator') === 0 || lhs === 'sep') { sepIdx = i; break; }
            if (segments[i].is_after_separator) { sepIdx = i; break; }
        }

        var results = [];
        var minLife = Infinity;
        var minSeg  = null;

        for (var j = 0; j < segments.length; j++) {
            var s = segments[j];
            var afterSep = (sepIdx >= 0 && j >= sepIdx) || !!s.is_after_separator;
            var W_eff = (afterSep && !bypassSep) ? 0 : W_sand;

            var v = (s.mixture_velocity_fps != null && isFinite(s.mixture_velocity_fps))
                ? _num(s.mixture_velocity_fps, 0) : mixtureVelocity(s, sysQ);

            var mix = mixtureProps(s, sysQ);
            var r = pipelife_segment({
                material: s.material,
                schedule_in: s.sch || s.schedule_in,
                nps_in: s.nps_in,
                measured_WT_in: s.measured_WT_in,
                min_spec_WT_in: s.min_spec_WT_in,
                failure_WT_in: s.failure_WT_in,
                design_pressure_psig: s.design_p_psig || s.design_pressure_psig,
                design_temp_F: s.design_T_F || s.design_temp_F,
                sand_rate_lbMMscf: W_eff,
                c_constant: c,
                mixture_velocity_fps: v,
                erosion_model: model,
                gas_rate_MMscfd: sysQ.gas_rate_MMscfd,
                rho_m_lbft3: mix.rho_m_lbft3, mu_m_cp: mix.mu_m_cp,
                particle_um: ero.particle_um, bend_RD: ero.bend_RD, GF: ero.GF
            });
            r.rho_m_lbft3 = mix.rho_m_lbft3; r.mu_m_cp = mix.mu_m_cp;

            r.label = s.label || s.key || ('Segment ' + (j + 1));
            r.key = s.key || ('seg_' + j);
            r.length_ft = _num(s.length_ft, 0);
            r.is_after_separator = afterSep;
            r.sand_rate_applied_lbMMscf = W_eff;

            if (r.applicable && r.remaining_service_life_days < minLife) {
                minLife = r.remaining_service_life_days;
                minSeg = { key: r.key, label: r.label, days: r.remaining_service_life_days };
            }
            results.push(r);
        }

        return {
            segments: results,
            overall_min_life_days: isFinite(minLife) ? minLife : 0,
            limiting_segment: minSeg,
            sand_rate_lbMMscf: W_sand,
            c_constant: c,
            erosion_model: model,
            erosion_model_label: EROSION_MODELS[model],
            particle_um: ero.particle_um, bend_RD: ero.bend_RD, GF: ero.GF,
            separator_bypassed: bypassSep
        };
    }
    G.WTS_pipelife_compute = pipelife_compute;

    // Expose reference data on window for downstream consumers.
    G.WTS_PIPELIFE_MATERIALS = MATERIALS;
    G.WTS_PIPELIFE_SCHEDULES = SCHEDULES;
    G.WTS_PIPELIFE_DEFAULT_SEGMENTS = DEFAULT_SEGMENTS;

    // ───────────────────────────────────────────────────────────────
    // UI rendering
    //
    // Layout (top-to-bottom):
    //   1. Geometry-assumption banner
    //   2. Operating-conditions card (+ "use Well Test Simulator" import)
    //   3. Pipe-segment INPUT table — one row per segment, including the
    //      flowing P/T that drives the mixture-velocity calc
    //   4. RESULTS table — velocity, erosion, RSL, TTF, MAWP, status
    //   5. System summary + warnings
    // Inputs persist to localStorage ('wts_pipelife') and WTS_state.pipelife
    // so they survive navigation and are captured by project Save.
    // ───────────────────────────────────────────────────────────────
    var PL_LS_KEY = 'wts_pipelife';
    var PL_OP_IDS = ['wts_pl_sand','wts_pl_c','wts_pl_qg','wts_pl_qo','wts_pl_qw','wts_pl_sg','wts_pl_bypass',
                     'wts_pl_model','wts_pl_dp','wts_pl_rd','wts_pl_gf','wts_pl_osg'];
    var PL_SEG_FIELDS = ['mat','nps','sch','len','pseg','tseg','meas','minspec','fail','dp','dt'];

    function _allInputIds() {
        var ids = PL_OP_IDS.slice();
        for (var i = 0; i < DEFAULT_SEGMENTS.length; i++) {
            for (var f = 0; f < PL_SEG_FIELDS.length; f++) ids.push('wts_pl_seg' + i + '_' + PL_SEG_FIELDS[f]);
        }
        return ids;
    }

    function _formatDays(days) {
        if (!isFinite(days)) return '—';
        if (days >= 50 * 365.25 - 1) return '> 50 yr';
        if (days >= 365.25 * 10) return _fmt(days / 365.25, 1) + ' yr';
        if (days >= 365.25)      return _fmt(days, 0) + ' d (' + _fmt(days / 365.25, 1) + ' yr)';
        if (days >= 1)           return _fmt(days, 1) + ' days';
        var hrs = days * 24;
        if (hrs >= 1)            return _fmt(hrs, 1) + ' hours';
        return _fmt(hrs * 60, 0) + ' min';
    }

    function _lifeColor(days) {
        return days < 30 ? 'var(--red, #f85149)'
             : days < 90 ? 'var(--yellow, #d29922)'
             : 'var(--green, #3fb950)';
    }

    function _materialOptions(selected) {
        var keys = Object.keys(MATERIALS);
        var html = '';
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i], m = MATERIALS[k];
            html += '<option value="' + _esc(k) + '"' +
                    (k === selected ? ' selected' : '') + '>' +
                    _esc(m.label) + '</option>';
        }
        return html;
    }

    function _scheduleOptions(selected) {
        var schs = SCHEDULE_KEYS, sel = normSchedule(selected).sch;
        var html = '';
        for (var i = 0; i < schs.length; i++) {
            html += '<option value="' + schs[i] + '"' +
                    (schs[i] === sel ? ' selected' : '') + '>' + (schs[i] === 'XXS' ? 'XXS' : 'SCH ' + schs[i]) + '</option>';
        }
        // Hidden legacy values so a restored v1.8 value ('180', 'XXH') still
        // lands in the select; _migrateSchedules() then maps it to XXS.
        html += '<option value="180" hidden>SCH 180 (legacy)</option><option value="XXH" hidden>XXH (legacy)</option>';
        return html;
    }

    function _npsOptions(selected) {
        var ns = ['2', '3', '4', '6', '8'];
        var html = '';
        for (var i = 0; i < ns.length; i++) {
            html += '<option value="' + ns[i] + '"' +
                    (String(ns[i]) === String(selected) ? ' selected' : '') + '>' + ns[i] + '"</option>';
        }
        return html;
    }

    function _numCell(id, val, step, min, w) {
        return '<td><input type="number" id="' + id + '" step="' + step + '"' +
               (min != null ? ' min="' + min + '"' : '') + ' value="' + val + '"' +
               ' style="width:100%;min-width:' + (w || 70) + 'px"></td>';
    }

    function _segmentInputRow(seg, idx) {
        var p = 'wts_pl_seg' + idx + '_';
        return '<tr data-seg-idx="' + idx + '">' +
            '<td style="font-weight:600;white-space:nowrap;color:var(--text)">' + _esc(seg.label.replace('->', '→')) + '</td>' +
            '<td><select id="' + p + 'mat" style="width:100%;min-width:150px">' + _materialOptions(seg.material) + '</select></td>' +
            '<td><select id="' + p + 'nps" style="width:100%;min-width:62px">' + _npsOptions(seg.nps_in) + '</select></td>' +
            '<td><select id="' + p + 'sch" style="width:100%;min-width:92px">' + _scheduleOptions(seg.sch) + '</select></td>' +
            _numCell(p + 'len', seg.length_ft, 1, 0, 64) +
            _numCell(p + 'pseg', seg.p_seg_psig, 10, 0, 76) +
            _numCell(p + 'tseg', seg.t_seg_F, 5, -50, 64) +
            _numCell(p + 'meas', seg.measured_WT_in, 0.001, 0, 74) +
            _numCell(p + 'minspec', seg.min_spec_WT_in, 0.001, 0, 74) +
            _numCell(p + 'fail', seg.failure_WT_in, 0.001, 0, 74) +
            _numCell(p + 'dp', seg.design_p_psig, 50, 0, 76) +
            _numCell(p + 'dt', seg.design_T_F, 5, -50, 64) +
        '</tr>';
    }

    function _segmentResultRow(seg, idx) {
        var p = 'wts_pl_seg' + idx + '_';
        return '<tr>' +
            '<td style="font-weight:600;white-space:nowrap;color:var(--text)">' + _esc(seg.label.replace('->', '→')) + '</td>' +
            '<td id="' + p + 'pipe" style="white-space:nowrap">—</td>' +
            '<td id="' + p + 'vel">—</td>' +
            '<td id="' + p + 'ero">—</td>' +
            '<td id="' + p + 'rsl" style="font-weight:700;white-space:nowrap">—</td>' +
            '<td id="' + p + 'ttf" style="white-space:nowrap">—</td>' +
            '<td id="' + p + 'mawp">—</td>' +
            '<td id="' + p + 'stat" style="font-weight:700;white-space:nowrap">—</td>' +
        '</tr>';
    }

    function _kpi(label, id) {
        return '<div class="kpi" style="background:var(--bg1, #0d1117);border:1px solid var(--border, #30363d);border-radius:8px;padding:10px 12px">' +
                   '<div class="kpi-l" style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;font-weight:700">' + label + '</div>' +
                   '<div class="kpi-v" id="' + id + '" style="font-size:18px;font-weight:700;margin-top:4px;color:var(--text)">—</div>' +
               '</div>';
    }

    function renderPipeLife(body) {
        if (!body) return;
        var titleEl = (typeof document !== 'undefined') ? document.getElementById('pgTitle') : null;
        var subEl   = (typeof document !== 'undefined') ? document.getElementById('pgSub')   : null;
        if (titleEl) titleEl.textContent = 'Pipe Remaining Service Life';
        if (subEl)   subEl.textContent   = 'Sand-erosion remaining life per pipe segment (DNV-RP-O501 / Salama 2000).';

        var inRows = '', resRows = '';
        for (var i = 0; i < DEFAULT_SEGMENTS.length; i++) {
            inRows  += _segmentInputRow(DEFAULT_SEGMENTS[i], i);
            resRows += _segmentResultRow(DEFAULT_SEGMENTS[i], i);
        }
        // sub = [imperial caption, units category] → shown in the active system
        // (re-labelled on a unit flip via data-pl-unit).
        var th = function (t, sub) {
            var cap = sub, attr = '';
            if (sub && typeof sub === 'object') { cap = _ulab(sub[1], sub[0]); attr = ' data-pl-unit="' + sub[1] + '" data-pl-imp="' + _esc(sub[0]) + '"'; }
            return '<th style="white-space:nowrap">' + t + (cap ? '<div' + attr + ' style="font-weight:500;text-transform:none;letter-spacing:0;color:var(--text3)">' + cap + '</div>' : '') + '</th>';
        };

        body.innerHTML = '' +
        '<div style="display:flex;flex-direction:column;gap:14px">' +
            '<div class="card" style="padding:10px 14px;border-left:3px solid var(--yellow, #d29922)">' +
                '<div style="font-size:12px;color:var(--text2);line-height:1.55">' +
                    '<strong style="color:var(--text)">Geometry assumption:</strong> the default model is the DNV-RP-O501 <em>pipe bend</em> ' +
                    '(the most erosion-prone component of a spread) at the bend radius entered below, applied to every rigid segment. ' +
                    'Cushion (blind) tees and machined block elbows erode less than bends; reduced-port valves and closely spaced bends ' +
                    '(&lt; 10 D apart: geometry factor 2) erode more. <strong style="color:var(--text)">v3.0:</strong> the default changed from the ' +
                    'v1.8 calibrated fit to DNV-RP-O501, which gives erosion rates about two orders of magnitude lower on the default case; ' +
                    'select "Legacy calibrated fit" to reproduce v1.8 results.' +
                '</div>' +
            '</div>' +

            '<div class="card">' +
                '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
                    '<span>Operating Conditions</span>' +
                    '<button type="button" class="btn btn-secondary" id="wts_pl_import" style="padding:5px 12px;font-size:12px">' +
                        '&#8635; Use Well Test Simulator conditions</button>' +
                '</div>' +
                '<div class="fg">' +
                    '<div class="fg-item"><label>Sand Production (lb/MMscf)</label>' +
                        '<input type="number" id="wts_pl_sand" step="1" min="0" value="50"></div>' +
                    '<div class="fg-item"><label>Erosion Model</label>' +
                        '<select id="wts_pl_model">' +
                            '<option value="dnv_bend" selected>DNV-RP-O501 pipe bend (default)</option>' +
                            '<option value="dnv_straight">DNV-RP-O501 straight pipe</option>' +
                            '<option value="salama">Salama (2000) elbow</option>' +
                            '<option value="legacy">Legacy calibrated fit (v1.8)</option>' +
                        '</select></div>' +
                    '<div class="fg-item"><label>Sand Particle Size (µm)</label>' +
                        '<input type="number" id="wts_pl_dp" step="10" min="1" value="250"></div>' +
                    '<div class="fg-item"><label>Bend Radius R/D (pipe diameters)</label>' +
                        '<input type="number" id="wts_pl_rd" step="0.5" min="0.5" value="1.5"></div>' +
                    '<div class="fg-item"><label>Geometry Factor GF</label>' +
                        '<select id="wts_pl_gf"><option value="1" selected>1 — ≥ 10 D straight pipe upstream</option>' +
                        '<option value="2">2 — bends / components &lt; 10 D apart</option></select></div>' +
                    '<div class="fg-item"><label>Legacy Fit Constant "c" (legacy model only)</label>' +
                        '<input type="number" id="wts_pl_c" step="10" min="50" max="2000" value="300"></div>' +
                    '<div class="fg-item"><label>Gas Rate (MMscfd)</label>' +
                        '<input type="number" id="wts_pl_qg" step="0.5" min="0" value="10"></div>' +
                    '<div class="fg-item"><label>Oil / Condensate Rate (bpd)</label>' +
                        '<input type="number" id="wts_pl_qo" step="50" min="0" value="1000"></div>' +
                    '<div class="fg-item"><label>Water Rate (bpd)</label>' +
                        '<input type="number" id="wts_pl_qw" step="50" min="0" value="200"></div>' +
                    '<div class="fg-item"><label>Gas SG (air = 1)</label>' +
                        '<input type="number" id="wts_pl_sg" step="0.01" min="0.55" max="1.20" value="0.65"></div>' +
                    '<div class="fg-item"><label>Oil / Condensate SG (water = 1)</label>' +
                        '<input type="number" id="wts_pl_osg" step="0.01" min="0.5" max="1.1" value="0.80"></div>' +
                    '<div class="fg-item"><label>Separator Bypass</label>' +
                        '<select id="wts_pl_bypass"><option value="0" selected>No</option><option value="1">Yes (sand to flare)</option></select></div>' +
                '</div>' +
                '<div id="wts_pl_import_msg" style="font-size:11px;color:var(--text3);margin-top:6px"></div>' +
                '<div id="wts_pl_schnote" style="font-size:11px;color:var(--yellow, #d29922);margin-top:6px"></div>' +
            '</div>' +

            '<div class="card">' +
                '<div class="card-title">Pipe Segments — Inputs</div>' +
                '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">' +
                    '<table class="dtable" style="min-width:1080px">' +
                        '<thead><tr>' + th('Segment') + th('Material') + th('NPS') + th('Schedule') + th('Length', ['ft', 'length']) +
                            th('Flowing P', ['psig', 'pressureG']) + th('Flowing T', ['°F', 'temperature']) + th('Measured WT', ['in', 'lengthSmall']) +
                            th('Min-spec WT', ['in', 'lengthSmall']) +
                            th('Failure WT', ['in', 'lengthSmall']) + th('Design P', ['psig', 'pressureG']) + th('Design T', ['°F', 'temperature']) + '</tr></thead>' +
                        '<tbody>' + inRows + '</tbody>' +
                    '</table>' +
                '</div>' +
                '<div style="font-size:11px;color:var(--text3);margin-top:8px">Flowing P/T set the in-situ gas volume and therefore mixture velocity — ' +
                    'the dominant term in erosion (∝ v²). Changing NPS / schedule auto-fills min-spec WT at 87.5 % of nominal.</div>' +
            '</div>' +

            '<div class="card" id="wts_pl_res">' +
                '<div class="card-title">Results — Remaining Service Life</div>' +
                '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:12px">' +
                    _kpi('Limiting segment', 'wts_pl_lim') + _kpi('Overall min RSL', 'wts_pl_minlife') + _kpi('Status', 'wts_pl_status') +
                '</div>' +
                '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">' +
                    '<table class="dtable" style="min-width:820px">' +
                        '<thead><tr>' + th('Segment') + th('Pipe', 'NPS / SCH · ID') + th('Velocity', ['ft/s', 'velocity']) + th('Erosion', ['mpy', 'erosionRate']) +
                            th('Remaining life', 'to min-spec WT') + th('Time to failure', 'to failure WT') + th('MAWP', ['psig', 'pressureG']) + th('Status') + '</tr></thead>' +
                        '<tbody>' + resRows + '</tbody>' +
                    '</table>' +
                '</div>' +
                '<div id="wts_pl_model_line" style="font-size:11px;color:var(--text3);margin-top:8px"></div>' +
                '<div id="wts_pl_warns" style="margin-top:10px"></div>' +
            '</div>' +

            '<div class="card" style="padding:10px 14px;border-left:3px solid var(--blue, #58a6ff)">' +
                '<div style="font-size:12px;color:var(--text2);line-height:1.55">' +
                    '<strong style="color:var(--text)">Separator note:</strong> residual sand fines are assumed to drop out in the separator, ' +
                    'so sand rate has no effect on the Separator → Flare line unless the separator is bypassed. ' +
                    'MAWP is per ASME B31.3. Gas rates are standard volumes at <span id="wts_pl_basis">' + _esc(_basis().label) + '</span>.' +
                '</div>' +
                '<div style="font-size:12px;color:var(--text2);line-height:1.55;margin-top:6px"><b>Notes</b> ' +
                    'DNV-RP-O501 (2015) bend: E = K·F(α)·U<sup>2.6</sup>·sin α·G·C1·GF·ṁ<sub>p</sub>·3.15e10/(ρ<sub>t</sub>·A<sub>pipe</sub>) mm/y, ' +
                    'α = arctan(1/(2R)), K = 2.0e-9, ρ<sub>t</sub> = 7800 kg/m³ (steel), C1 = 2.5, sand 2650 kg/m³, G from the critical particle size. ' +
                    'Straight pipe: E = 2.5e-5·U<sup>2.6</sup>·D<sup>−2</sup>·ṁ<sub>p</sub>. Salama (2000): E = W·V²·d/(5.5·D²·ρ<sub>m</sub>). ' +
                    'Sand mass rate = sand production × gas rate; U = mixture velocity; ρ<sub>m</sub>, μ<sub>m</sub> are velocity-weighted ' +
                    '(screening viscosities gas 0.012 cP, liquids 1 cP). Schedules and walls per ASME B36.10M (Sch 40 / 80 / 160, XXS); ' +
                    '"Sch 180" is not a B36.10M schedule and loads as XXS.' +
                '</div>' +
            '</div>' +
        '</div>';

        _loadPipeLifeState();
        _wirePipeLife();
        _calcPipeLife();
    }
    G.renderPipeLife = renderPipeLife;

    // ───────────────────────────────────────────────────────────────
    // Persistence — localStorage + WTS_state.pipelife (project Save)
    // ───────────────────────────────────────────────────────────────
    function _savePipeLifeState() {
        if (typeof document === 'undefined') return;
        var ids = _allInputIds(), vals = {};
        for (var i = 0; i < ids.length; i++) {
            var el = _$(ids[i]);
            if (el) vals[ids[i]] = el.value;
        }
        try { localStorage.setItem(PL_LS_KEY, JSON.stringify(vals)); } catch (e) {}
        if (!G.WTS_state || typeof G.WTS_state !== 'object') G.WTS_state = {};
        G.WTS_state.pipelife = { values: vals };
    }

    function _loadPipeLifeState() {
        if (typeof document === 'undefined') return;
        var vals = null;
        try { vals = JSON.parse(localStorage.getItem(PL_LS_KEY) || 'null'); } catch (e) { vals = null; }
        if (!vals && G.WTS_state && G.WTS_state.pipelife && G.WTS_state.pipelife.values) vals = G.WTS_state.pipelife.values;
        if (!vals || typeof vals !== 'object') return;
        for (var id in vals) {
            if (!Object.prototype.hasOwnProperty.call(vals, id)) continue;
            var el = _$(id);
            if (el && vals[id] != null) el.value = vals[id];
        }
    }

    // Pull solved conditions from the Well Test Simulator (window.WTS_lastCalc,
    // published by calcWTS). WTS segment order: WH→SSV, SSV→Choke,
    // Choke→Heater, Heater→Sep, Sep→Flare, Surge→Atm Tank.
    function _importFromWTS() {
        var msg = _$('wts_pl_import_msg');
        var lc = G.WTS_lastCalc;
        if (!lc || !lc.segs || !lc.inputs) {
            if (msg) { msg.style.color = 'var(--yellow, #d29922)'; msg.textContent = 'Open the Well Test Simulator once so it can solve the flow path, then import.'; }
            return;
        }
        var s = lc.segs, inp = lc.inputs;
        var setV = function (id, v, dp) { var el = _$(id); if (el && isFinite(v)) el.value = (dp != null) ? Number(v).toFixed(dp) : v; };
        setV('wts_pl_qg', inp.Qg); setV('wts_pl_qo', inp.Qo); setV('wts_pl_qw', inp.Qw); setV('wts_pl_sg', inp.SGg);
        // [pipe-life segment idx, WTS segment, use outlet?]
        var map = [[0, s[0], false], [1, s[0], true], [2, s[1], false], [3, s[2], false], [4, s[3], false], [5, s[4], false]];
        for (var i = 0; i < map.length; i++) {
            var idx = map[i][0], sg = map[i][1], out = map[i][2];
            if (!sg) continue;
            setV('wts_pl_seg' + idx + '_pseg', out ? sg.Pout : sg.P0, 0);
            setV('wts_pl_seg' + idx + '_tseg', out ? sg.Tout : sg.T0, 0);
            // Only carry pipe size across for rigid segments whose NPS/SCH exist here.
            if (idx >= 2) {
                var npsEl = _$('wts_pl_seg' + idx + '_nps'), schEl = _$('wts_pl_seg' + idx + '_sch');
                var hasOpt = function (sel, v) { if (!sel) return false; for (var k = 0; k < sel.options.length; k++) if (sel.options[k].value === String(v)) return true; return false; };
                if (hasOpt(npsEl, sg.nps) && hasOpt(schEl, sg.sch) &&
                    (npsEl.value !== String(sg.nps) || schEl.value !== String(sg.sch))) {
                    npsEl.value = String(sg.nps); schEl.value = String(sg.sch);
                    // A different pipe makes the old UT reading meaningless —
                    // start from nominal wall for the new size.
                    var measEl = _$('wts_pl_seg' + idx + '_meas');
                    if (measEl) measEl.value = getNominalWT(sg.nps, sg.sch).toFixed(3);
                    _autoFillMinSpec({ target: schEl });
                }
            }
        }
        if (msg) { msg.style.color = 'var(--green, #3fb950)'; msg.textContent = '✓ Imported rates, flowing P/T and pipe sizes from the Well Test Simulator.'; }
        _calcPipeLife();
    }

    // ───────────────────────────────────────────────────────────────
    // Wire all inputs to recompute on change.
    // ───────────────────────────────────────────────────────────────
    function _wirePipeLife() {
        if (typeof document === 'undefined') return;
        var ids = _allInputIds();
        var t = null;
        var fire = function () {
            if (t) clearTimeout(t);
            // Timer callbacks run outside any canonical context — open one so
            // tagged inputs read (and _savePipeLifeState stores) imperial values.
            t = setTimeout(function () { t = null; _canon(_calcPipeLife); }, 150);
        };
        for (var k = 0; k < ids.length; k++) {
            var el = _$(ids[k]);
            if (!el) continue;
            // Auto-update min-spec when nps/sch change.
            if (/_sch$/.test(ids[k]) || /_nps$/.test(ids[k])) {
                el.addEventListener('change', _autoFillMinSpec);
            }
            el.addEventListener('input',  fire);
            el.addEventListener('change', fire);
        }
        var imp = _$('wts_pl_import');
        if (imp) imp.addEventListener('click', _importFromWTS);
    }

    function _autoFillMinSpec(ev) {
        var src = ev && ev.target ? ev.target.id : '';
        var m = src.match(/^wts_pl_seg(\d+)_/);
        if (!m) return;
        var idx = parseInt(m[1], 10);
        var npsEl  = _$('wts_pl_seg' + idx + '_nps');
        var schEl  = _$('wts_pl_seg' + idx + '_sch');
        var msEl   = _$('wts_pl_seg' + idx + '_minspec');
        if (!npsEl || !schEl || !msEl) return;
        var nominal = getNominalWT(npsEl.value, schEl.value);
        msEl.value = (nominal * 0.875).toFixed(3);
    }

    // ───────────────────────────────────────────────────────────────
    // Read DOM -> compute -> paint results
    // ───────────────────────────────────────────────────────────────
    // v1.8 saves may hold schedule '180' (not an ASME B36.10M schedule) or the
    // old 'XXH' label: map both to XXS and say so on the page (measured and
    // min-spec walls are the user's values and are left as entered).
    function _migrateSchedules() {
        var notes = [];
        for (var i = 0; i < DEFAULT_SEGMENTS.length; i++) {
            var el = _$('wts_pl_seg' + i + '_sch');
            if (!el) continue;
            var n = normSchedule(el.value);
            if (n.sch !== el.value && SCHEDULES['4'][n.sch] != null) {
                el.value = n.sch;
                if (n.migrated === '180') {
                    var npsEl = _$('wts_pl_seg' + i + '_nps');
                    var nom = getNominalWT(npsEl ? npsEl.value : 4, 'XXS');
                    notes.push(DEFAULT_SEGMENTS[i].label.replace('->', '→') + ' (XXS nominal ' +
                        _u(nom, 'lengthSmall', 3, 'in', 2) + ', 87.5 % = ' + _u(nom * 0.875, 'lengthSmall', 3, 'in', 2) + ')');
                }
            }
        }
        if (notes.length) {
            var box = _$('wts_pl_schnote');
            if (box) box.textContent = '⚠ Schedule 180 is not an ASME B36.10M schedule: loaded as XXS on ' + notes.join('; ') +
                '. Check the min-spec wall against the XXS nominal.';
        }
        return notes.length;
    }

    function _readSegmentInputs() {
        var segs = [];
        for (var i = 0; i < DEFAULT_SEGMENTS.length; i++) {
            var d = DEFAULT_SEGMENTS[i];
            var v = function (f) { var el = _$('wts_pl_seg' + i + '_' + f); return el ? el.value : undefined; };
            segs.push({
                key: d.key,
                label: d.label,
                material: v('mat') || d.material,
                nps_in: _num(v('nps'), d.nps_in),
                sch:    v('sch') || d.sch,
                length_ft: _num(v('len'), d.length_ft),
                measured_WT_in: _num(v('meas'), d.measured_WT_in),
                min_spec_WT_in: _num(v('minspec'), d.min_spec_WT_in),
                failure_WT_in:  _num(v('fail'), d.failure_WT_in),
                design_p_psig:  _num(v('dp'), d.design_p_psig),
                design_T_F:     _num(v('dt'), d.design_T_F),
                // Flowing conditions drive the in-situ gas volume (velocity).
                p_seg_psig:     _num(v('pseg'), d.p_seg_psig),
                t_seg_F:        _num(v('tseg'), d.t_seg_F)
            });
        }
        return segs;
    }

    function _calcPipeLife() {
        if (typeof document === 'undefined') return;
        if (!_$('wts_pl_sand')) return;
        var sand   = _num((_$('wts_pl_sand') || {}).value, 50);
        var c      = _num((_$('wts_pl_c') || {}).value, 300);
        var qg     = _num((_$('wts_pl_qg') || {}).value, 10);
        var qo     = _num((_$('wts_pl_qo') || {}).value, 1000);
        var qw     = _num((_$('wts_pl_qw') || {}).value, 200);
        var sg     = _num((_$('wts_pl_sg') || {}).value, 0.65);
        var osg    = _num((_$('wts_pl_osg') || {}).value, 0.80);
        var model  = ((_$('wts_pl_model') || {}).value) || 'dnv_bend';
        var dpum   = _num((_$('wts_pl_dp') || {}).value, 250);
        var rd     = _num((_$('wts_pl_rd') || {}).value, 1.5);
        var gf     = _num((_$('wts_pl_gf') || {}).value, 1);
        _migrateSchedules();
        var bypEl  = _$('wts_pl_bypass');
        var bypass = bypEl ? (bypEl.value === '1' || bypEl.value === 'true') : false;

        var segIn = _readSegmentInputs();
        var report = pipelife_compute({
            sand_production_lbMMscf: sand,
            c_constant: c,
            gas_rate_MMscfd: qg,
            oil_rate_bpd: qo,
            water_rate_bpd: qw,
            gasSG: sg,
            oilSG: osg,
            erosion_model: model,
            particle_um: dpum, bend_RD: rd, GF: gf,
            bypass_separator: bypass,
            segments: segIn
        });
        G.WTS_pipelife_lastReport = report;
        _savePipeLifeState();
        // Result summary for the Quick Report / project file (values stay the inputs).
        if (G.WTS_state && G.WTS_state.pipelife) {
            var st = G.WTS_state.pipelife, limSeg = null;
            for (var q = 0; q < report.segments.length; q++) if (report.limiting_segment && report.segments[q].key === report.limiting_segment.key) limSeg = report.segments[q];
            st.erosion_model = report.erosion_model; st.erosion_model_label = report.erosion_model_label;
            st.overall_min_life_days = report.overall_min_life_days; st.sand_rate_lbMMscf = report.sand_rate_lbMMscf;
            st.c_constant = report.c_constant;
            st.limiting_segment = limSeg ? { key: limSeg.key, label: limSeg.label, erosion_rate_mils_yr: limSeg.erosion_rate_mils_yr,
                time_to_failure_at_current_days: limSeg.time_to_failure_at_current_days } : null;
            st.segments = report.segments.map(function (x) { return { label: x.label, erosion_rate_mils_yr: x.applicable ? x.erosion_rate_mils_yr : null,
                remaining_service_life_days: x.applicable ? x.remaining_service_life_days : null,
                time_to_failure_at_current_days: x.applicable ? x.time_to_failure_at_current_days : null,
                max_allowable_pressure_psig: x.max_allowable_pressure_psig }; });
        }

        var warnHtml = [];
        var set = function (id, txt, color) { var el = _$(id); if (!el) return; el.textContent = txt; if (color !== undefined) el.style.color = color; };
        for (var i = 0; i < report.segments.length; i++) {
            var r = report.segments[i], p = 'wts_pl_seg' + i + '_';
            set(p + 'pipe', r.nps_in + '" ' + (r.sch === 'XXS' ? 'XXS' : 'SCH ' + r.sch) + ' · ' + (_metric() ? _fmt(_uval(r.ID_in, 'lengthSmall'), 1) + ' mm' : _fmt(r.ID_in, 3) + '"'));
            set(p + 'mawp', _fmt(_uval(r.max_allowable_pressure_psig, 'pressureG'), 0));
            if (!r.applicable) {
                set(p + 'vel', '—'); set(p + 'ero', '—');
                set(p + 'rsl', 'N/A (hose)', 'var(--text3)'); set(p + 'ttf', '—');
                set(p + 'stat', 'HOSE', 'var(--text3)');
                continue;
            }
            set(p + 'vel', _fmt(_uval(r.mixture_velocity_fps, 'velocity'), 1));
            var eShown = _uval(r.erosion_rate_mils_yr, 'erosionRate');
            set(p + 'ero', r.erosion_rate_mils_yr > 0 ? (eShown < 0.001 ? eShown.toExponential(2) : _fmt(eShown, eShown < 1 ? 3 : (_metric() ? 3 : 1))) : '0');
            set(p + 'rsl', _formatDays(r.remaining_service_life_days), _lifeColor(r.remaining_service_life_days));
            set(p + 'ttf', _formatDays(r.time_to_failure_at_current_days), _lifeColor(r.time_to_failure_at_current_days));
            var st = !r.ok_to_operate ? ['INSPECT NOW', 'var(--red, #f85149)']
                   : r.remaining_service_life_days < 90 ? ['MITIGATE', 'var(--yellow, #d29922)']
                   : ['OK', 'var(--green, #3fb950)'];
            set(p + 'stat', st[0], st[1]);
            if (r.warnings && r.warnings.length) {
                for (var w = 0; w < r.warnings.length; w++) {
                    warnHtml.push('<div style="padding:6px 12px;border-left:3px solid ' + (r.ok_to_operate ? 'var(--yellow, #d29922)' : 'var(--red, #f85149)') +
                        ';background:rgba(248,81,73,.06);border-radius:4px;margin-bottom:4px;font-size:12px;color:var(--text2)">' +
                        '<strong style="color:var(--text)">' + _esc(r.label.replace('->', '→')) + ':</strong> ' + _esc(r.warnings[w]) + '</div>');
                }
            }
        }
        var ml = _$('wts_pl_model_line');
        if (ml) ml.textContent = 'Erosion model: ' + report.erosion_model_label +
            (report.erosion_model === 'dnv_bend' ? ' — R/D ' + _fmt(report.bend_RD, 1) + ', GF ' + _fmt(report.GF, 0) + ', particles ' + _fmt(report.particle_um, 0) + ' µm'
             : report.erosion_model === 'salama' ? ' — particles ' + _fmt(report.particle_um, 0) + ' µm, Sm 5.5'
             : report.erosion_model === 'legacy' ? ' — c = ' + _fmt(report.c_constant, 0) + ' (v1.8 screening fit, not a published model)' : '') +
            '; sand ' + _u(sand, 'sandLoading', 1, 'lb/MMscf') + ' × gas rate.';
        var wEl = _$('wts_pl_warns');
        if (wEl) wEl.innerHTML = warnHtml.join('');

        // Summary KPIs.
        set('wts_pl_lim', report.limiting_segment ? report.limiting_segment.label.replace('->', '→') : '—');
        set('wts_pl_minlife', report.limiting_segment ? _formatDays(report.overall_min_life_days) : '—',
            report.limiting_segment ? _lifeColor(report.overall_min_life_days) : undefined);
        var ok = true;
        for (var s = 0; s < report.segments.length; s++) {
            if (report.segments[s].applicable && !report.segments[s].ok_to_operate) { ok = false; break; }
        }
        set('wts_pl_status', ok ? 'OK' : 'ATTENTION', ok ? 'var(--green, #3fb950)' : 'var(--red, #f85149)');
    }

    // Unit flip / standard-conditions change: re-label the unit captions and
    // repaint the results (canonical context → tagged inputs read imperial).
    function _onUnitsOrBasis() {
        if (typeof document === 'undefined' || !_$('wts_pl_sand')) return;
        var caps = document.querySelectorAll ? document.querySelectorAll('[data-pl-unit]') : [];
        for (var i = 0; i < caps.length; i++) {
            caps[i].textContent = _ulab(caps[i].getAttribute('data-pl-unit'), caps[i].getAttribute('data-pl-imp'));
        }
        var b = _$('wts_pl_basis');
        if (b) b.textContent = _basis().label;
        _canon(_calcPipeLife);
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', _onUnitsOrBasis);
        document.addEventListener('wts:base-conditions-changed', _onUnitsOrBasis);
    }

    // === SELF-TEST ===

    (function () {
        try {
            var checks = [];
            // DNV bend: linear in sand rate, ∝ U^2.6 (G = 1 for 250 µm in 4")
            var dnv = function (lbd, v) { return G.WTS_sandErosion_compute({ model: 'dnv_bend', sand_lb_d: lbd, v_fps: v, D_in: 4,
                rho_m_lbft3: 3, mu_m_cp: 0.02, particle_um: 250, bend_RD: 1.5, GF: 1 }).E_mm_y; };
            checks.push({ n: 'DNV bend linear in sand', ok: Math.abs(dnv(200, 60) / dnv(100, 60) - 2) < 1e-9 });
            checks.push({ n: 'DNV bend ∝ U^2.6', ok: Math.abs(dnv(100, 120) / dnv(100, 60) - Math.pow(2, 2.6)) < 1e-9 });
            checks.push({ n: 'schedule 180 → XXS', ok: G.WTS_pipelife_normSchedule('180').sch === 'XXS' });
            var rate = G.WTS_erosion_rate_legacy(50, 30, 4, 300);
            checks.push({ n: 'erosion rate > 0', ok: rate > 0 });
            checks.push({ n: 'erosion rate scales with v^2',
                          ok: G.WTS_erosion_rate_legacy(50, 60, 4, 300) > 3 * rate });
            checks.push({ n: 'erosion rate scales with sand load',
                          ok: G.WTS_erosion_rate_legacy(100, 30, 4, 300) > rate * 1.99 &&
                              G.WTS_erosion_rate_legacy(100, 30, 4, 300) < rate * 2.01 });
            checks.push({ n: 'erosion rate inverse-square with D',
                          ok: G.WTS_erosion_rate_legacy(50, 30, 2, 300) > rate * 3.99 &&
                              G.WTS_erosion_rate_legacy(50, 30, 2, 300) < rate * 4.01 });

            var seg = G.WTS_pipelife_segment({
                material: 'A333gr6', schedule_in: 80, nps_in: 4,
                measured_WT_in: 0.39, min_spec_WT_in: 0.34, failure_WT_in: 0.067,
                design_pressure_psig: 5000, design_temp_F: 250,
                sand_rate_lbMMscf: 50, c_constant: 300, mixture_velocity_fps: 30, erosion_model: 'legacy'
            });
            checks.push({ n: 'remaining_life_days > 0',
                          ok: seg.remaining_service_life_days > 0 });
            checks.push({ n: 'time_to_failure > remaining_life',
                          ok: seg.time_to_failure_at_current_days > seg.remaining_service_life_days });
            checks.push({ n: 'erosion rate > 0', ok: seg.erosion_rate_mils_yr > 0 });
            checks.push({ n: 'MAWP > 0', ok: seg.max_allowable_pressure_psig > 0 });

            var hose = G.WTS_pipelife_segment({
                material: 'Coflex', schedule_in: 80, nps_in: 4,
                measured_WT_in: 0.337, min_spec_WT_in: 0.295, failure_WT_in: 0.080,
                design_pressure_psig: 5000, design_temp_F: 250,
                sand_rate_lbMMscf: 50, c_constant: 300, mixture_velocity_fps: 30
            });
            checks.push({ n: 'hose marked not-applicable', ok: hose.applicable === false });

            var full = G.WTS_pipelife_compute({
                sand_production_lbMMscf: 50, c_constant: 300,
                gas_rate_MMscfd: 25, oil_rate_bpd: 2500, water_rate_bpd: 400, gasSG: 0.78,
                segments: [
                    { label: 'SSV->Choke', material: '5L-X52', nps_in: 4, sch: 'XXS', length_ft: 50,
                      measured_WT_in: 0.5, min_spec_WT_in: 0.337, failure_WT_in: 0.024,
                      design_p_psig: 5000, design_T_F: 250, p_seg_psig: 1971, t_seg_F: 100 },
                    { label: 'Choke->Heater', material: 'A333gr6', nps_in: 3, sch: '180', length_ft: 25,
                      measured_WT_in: 0.6, min_spec_WT_in: 0.438, failure_WT_in: 0.024,
                      design_p_psig: 5000, design_T_F: 250, p_seg_psig: 885, t_seg_F: 41 }
                ]
            });
            checks.push({ n: 'overall_min_life is finite', ok: isFinite(full.overall_min_life_days) });
            checks.push({ n: 'limiting_segment populated',
                          ok: !!(full.limiting_segment && full.limiting_segment.label) });
            checks.push({ n: 'segments returned', ok: full.segments.length === 2 });

            // Default-segment + sep dropout test.
            var dflt = G.WTS_pipelife_compute({
                sand_production_lbMMscf: 50, c_constant: 300,
                gas_rate_MMscfd: 25, oil_rate_bpd: 2500, water_rate_bpd: 400, gasSG: 0.78
            });
            // Sep -> Flare segment should see zero sand, so erosion == 0.
            var sepFlare = null;
            for (var i = 0; i < dflt.segments.length; i++) {
                if ((dflt.segments[i].label || '').indexOf('Separator') === 0) sepFlare = dflt.segments[i];
            }
            checks.push({ n: 'sep dropout zeroes sand on Sep->Flare',
                          ok: !sepFlare || sepFlare.sand_rate_applied_lbMMscf === 0 });

            // Stash numbers for the build script to echo.
            G.WTS_pipelife_selfTestResults = {
                checks: checks,
                rate_default: rate,
                seg_default_RSL_days: seg.remaining_service_life_days,
                seg_default_TTF_days: seg.time_to_failure_at_current_days
            };

            var fails = checks.filter(function (c) { return !c.ok; });
            if (fails.length) _err('Pipe Service Life self-test FAILED:', fails);
            else _log('✓ Pipe Service Life self-test passed (' + checks.length + ' checks).');
        } catch (e) {
            _err('Pipe Service Life self-test threw:', e && e.message ? e.message : e);
        }
    })();

})();
