// ════════════════════════════════════════════════════════════════════
// WTS — Layer 27 — Pipe Remaining Service Life (Sand-Erosion)
//
// PURPOSE
//   Salama (2000) sand-erosion screening calculator for the H2Oil Well
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
//   WTS_erosion_rate_salama(W_sand_lbMMscf, v_fps, D_in, c)
//        — returns erosion rate in mils/year.
//
//   WTS_pipelife_segment(input)
//        — single-segment compute:
//            input  = { material, schedule_in, nps_in,
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
//        — read-only reference data (materials + ANSI B36.10 wall table).
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

    // ANSI B36.10 — wall thickness in inches by NPS + schedule.
    // Covers the common test-pipework sizes (2" through 8") and schedules
    // including the heavy 180/XXH grades commonly seen on choke manifolds.
    var SCHEDULES = {
        '2': { '40': 0.154, '80': 0.218, '160': 0.344, '180': 0.436, 'XXH': 0.436 },
        '3': { '40': 0.216, '80': 0.300, '160': 0.438, '180': 0.552, 'XXH': 0.600 },
        // XXH (XXS) per B36.10: 4" = 0.674 in, 6" = 0.864 in (were 0.812 / 0.875).
        '4': { '40': 0.237, '80': 0.337, '160': 0.531, '180': 0.674, 'XXH': 0.674 },
        '6': { '40': 0.280, '80': 0.432, '160': 0.719, '180': 0.864, 'XXH': 0.864 },
        '8': { '40': 0.322, '80': 0.500, '160': 0.906, '180': 1.000, 'XXH': 0.875 }
    };

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
        { key: 'ssv_choke', label: 'SSV -> Choke',            material: '5L-X52',  nps_in: 4, sch: 180,
          length_ft: 50,  measured_WT_in: 0.674, min_spec_WT_in: 0.590, failure_WT_in: 0.067,
          design_p_psig: 10000,design_T_F: 250, p_seg_psig: 2900, t_seg_F: 170 },
        { key: 'choke_htr', label: 'Choke -> Heater',         material: 'A333gr6', nps_in: 3, sch: 180,
          length_ft: 100, measured_WT_in: 0.552, min_spec_WT_in: 0.483, failure_WT_in: 0.067,
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
        var nKey = String(nps_in), sKey = String(sch);
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
    // Salama (2000) erosion-rate model — CALIBRATED FORM
    //
    //   E_mils_per_year = K_eff * W_sand * v^2 / D^2
    //
    //   where:
    //     W_sand  = sand concentration (lb sand / MMscf gas)
    //     v       = mixture velocity (ft/s)
    //     D       = inner pipe diameter (inches)
    //     K_eff   = effective material/geometry constant in
    //               (mpy)·(in^2)/((lb/MMscf)·(ft/s)^2)
    //
    //   The user-facing input c is a DIMENSIONLESS scale in the screening-
    //   sheet notation where c = 300 corresponds to "typical carbon steel
    //   + cushion-tee / machined elbow geometry". We calibrate the c=300
    //   case to give field-typical service-life values:
    //
    //     reference case  : 4" SCH 80 (WT=0.39, fail WT=0.067),
    //                       W=50 lb/MMscf, v=30 ft/s, c=300
    //     allowable loss  : 0.323 in = 323 mils
    //     reference RSL   : ~15 days
    //     => required E   : 323 mils / (15 / 365) ≈ 7860 mpy
    //     dimensional grp : W·v^2/D^2 = 50·900/16 ≈ 2812
    //     => K_eff(c=300) : ~2.8
    //
    //   The "raw" Salama c=300 used directly produced ~840,000 mpy
    //   (i.e. wall would erode through in hours), which is physically
    //   impossible. The calibration constant absorbs the unit conversions
    //   and material-density factors that the raw textbook form does not
    //   carry through to mils/year.
    //
    //   For higher-impingement geometry (regular LR elbow vs cushion-tee)
    //   the user should bump c upward by ~3-5x.
    // ───────────────────────────────────────────────────────────────

    // Calibration: c = 300 in the screening-sheet convention maps to
    // K ≈ 2.8 in real mpy units. Derivation:
    //   reference TTF ~15 days, allowable loss 323 mils (measured →
    //   failure WT) for default 4" SCH80 segment;
    //   E_required = 323 / (15/365.25) ≈ 7866 mpy;
    //   dimensional_grp = W·v²/D² = 50·900/16 ≈ 2812;
    //   K_eff(c=300) = 7866 / 2812 ≈ 2.8 ✓
    // (Earlier draft used K=7.5 which contradicted its own derivation
    // and produced TTF/RSL values 2.7× too short. Fixed 2026-04-28.)
    var SALAMA_K_AT_C300 = 2.8;

    function erosion_rate_salama(W_sand_lbMMscf, v_fps, D_in, c) {
        var W = Math.max(_num(W_sand_lbMMscf, 0), 0);
        var v = Math.max(_num(v_fps, 0), 0);
        var D = Math.max(_num(D_in, 0.5), 0.1);
        var cc = _num(c, 300);
        if (W === 0 || v === 0) return 0;
        var K_eff = (cc / 300) * SALAMA_K_AT_C300;
        return K_eff * W * v * v / (D * D);
    }
    G.WTS_erosion_rate_salama = erosion_rate_salama;

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

    // ───────────────────────────────────────────────────────────────
    // Single-segment compute
    // ───────────────────────────────────────────────────────────────
    function pipelife_segment(input) {
        input = input || {};
        var matKey = input.material || 'A333gr6';
        var mat = MATERIALS[matKey] || MATERIALS['A333gr6'];
        var nps  = _num(input.nps_in, 4);
        var sch  = input.schedule_in || input.sch || 80;
        var measured = Math.max(_num(input.measured_WT_in, getNominalWT(nps, sch)), 0);
        var minspec  = Math.max(_num(input.min_spec_WT_in, getNominalWT(nps, sch) * 0.875), 0);
        var failWT   = Math.max(_num(input.failure_WT_in, Math.max(measured - 0.05, 0.024)), 0);
        var design_p = _num(input.design_pressure_psig, 5000);
        var design_T = _num(input.design_temp_F, 250);
        var W_sand   = Math.max(_num(input.sand_rate_lbMMscf, 0), 0);
        var c        = Math.max(_num(input.c_constant, 300), 0);
        var v_fps    = Math.max(_num(input.mixture_velocity_fps, 0), 0);

        var warnings = [];
        var ID = getInnerDiameter(nps, sch, measured);

        var out = {
            material: matKey,
            material_label: mat.label,
            erodes: mat.erodes,
            nps_in: nps, sch: sch, OD_in: getOD(nps), ID_in: ID,
            measured_WT_in: measured, min_spec_WT_in: minspec, failure_WT_in: failWT,
            mixture_velocity_fps: v_fps,
            sand_rate_lbMMscf: W_sand, c_constant: c,
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
        var E_mpy = erosion_rate_salama(W_sand, v_fps, ID, c);
        out.erosion_rate_mils_yr = E_mpy;

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
            gasSG:           _num(inputs.gasSG, 0.65)
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
                mixture_velocity_fps: v
            });

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
    var PL_OP_IDS = ['wts_pl_sand','wts_pl_c','wts_pl_qg','wts_pl_qo','wts_pl_qw','wts_pl_sg','wts_pl_bypass'];
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
        var schs = ['40', '80', '160', '180', 'XXH'];
        var html = '';
        for (var i = 0; i < schs.length; i++) {
            html += '<option value="' + schs[i] + '"' +
                    (String(schs[i]) === String(selected) ? ' selected' : '') + '>SCH ' + schs[i] + '</option>';
        }
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
        if (subEl)   subEl.textContent   = 'Sand erosion-based time-to-failure (Salama 2000) per pipe segment.';

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
                    '<strong style="color:var(--text)">Geometry assumption:</strong> estimates assume <em>cushion tees</em> and/or ' +
                    '<em>machined block elbows</em> with <em>full-port</em> valves. Long/short-radius elbows concentrate sand on the ' +
                    'outer radius and reduced-port valves raise local velocity; both increase local erosion (raise "c" 3–5×).' +
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
                    '<div class="fg-item"><label>Empirical Constant "c"</label>' +
                        '<input type="number" id="wts_pl_c" step="10" min="50" max="2000" value="300"></div>' +
                    '<div class="fg-item"><label>Gas Rate (MMscfd)</label>' +
                        '<input type="number" id="wts_pl_qg" step="0.5" min="0" value="10"></div>' +
                    '<div class="fg-item"><label>Oil / Condensate Rate (bpd)</label>' +
                        '<input type="number" id="wts_pl_qo" step="50" min="0" value="1000"></div>' +
                    '<div class="fg-item"><label>Water Rate (bpd)</label>' +
                        '<input type="number" id="wts_pl_qw" step="50" min="0" value="200"></div>' +
                    '<div class="fg-item"><label>Gas SG (air = 1)</label>' +
                        '<input type="number" id="wts_pl_sg" step="0.01" min="0.55" max="1.20" value="0.65"></div>' +
                    '<div class="fg-item"><label>Separator Bypass</label>' +
                        '<select id="wts_pl_bypass"><option value="0" selected>No</option><option value="1">Yes (sand to flare)</option></select></div>' +
                '</div>' +
                '<div id="wts_pl_import_msg" style="font-size:11px;color:var(--text3);margin-top:6px"></div>' +
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
                '<div id="wts_pl_warns" style="margin-top:10px"></div>' +
            '</div>' +

            '<div class="card" style="padding:10px 14px;border-left:3px solid var(--blue, #58a6ff)">' +
                '<div style="font-size:12px;color:var(--text2);line-height:1.55">' +
                    '<strong style="color:var(--text)">Separator note:</strong> residual sand fines are assumed to drop out in the separator, ' +
                    'so sand rate has no effect on the Separator → Flare line unless the separator is bypassed. ' +
                    'MAWP is per ASME B31.3. Gas rates are standard volumes at <span id="wts_pl_basis">' + _esc(_basis().label) + '</span>.' +
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
            bypass_separator: bypass,
            segments: segIn
        });
        G.WTS_pipelife_lastReport = report;
        _savePipeLifeState();

        var warnHtml = [];
        var set = function (id, txt, color) { var el = _$(id); if (!el) return; el.textContent = txt; if (color !== undefined) el.style.color = color; };
        for (var i = 0; i < report.segments.length; i++) {
            var r = report.segments[i], p = 'wts_pl_seg' + i + '_';
            set(p + 'pipe', r.nps_in + '" SCH ' + r.sch + ' · ' + (_metric() ? _fmt(_uval(r.ID_in, 'lengthSmall'), 1) + ' mm' : _fmt(r.ID_in, 3) + '"'));
            set(p + 'mawp', _fmt(_uval(r.max_allowable_pressure_psig, 'pressureG'), 0));
            if (!r.applicable) {
                set(p + 'vel', '—'); set(p + 'ero', '—');
                set(p + 'rsl', 'N/A (hose)', 'var(--text3)'); set(p + 'ttf', '—');
                set(p + 'stat', 'HOSE', 'var(--text3)');
                continue;
            }
            set(p + 'vel', _fmt(_uval(r.mixture_velocity_fps, 'velocity'), 1));
            set(p + 'ero', r.erosion_rate_mils_yr > 0 ? _fmt(_uval(r.erosion_rate_mils_yr, 'erosionRate'), _metric() ? 3 : 1) : '0');
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
            var rate = G.WTS_erosion_rate_salama(50, 30, 4, 300);
            checks.push({ n: 'erosion rate > 0', ok: rate > 0 });
            checks.push({ n: 'erosion rate scales with v^2',
                          ok: G.WTS_erosion_rate_salama(50, 60, 4, 300) > 3 * rate });
            checks.push({ n: 'erosion rate scales with sand load',
                          ok: G.WTS_erosion_rate_salama(100, 30, 4, 300) > rate * 1.99 &&
                              G.WTS_erosion_rate_salama(100, 30, 4, 300) < rate * 2.01 });
            checks.push({ n: 'erosion rate inverse-square with D',
                          ok: G.WTS_erosion_rate_salama(50, 30, 2, 300) > rate * 3.99 &&
                              G.WTS_erosion_rate_salama(50, 30, 2, 300) < rate * 4.01 });

            var seg = G.WTS_pipelife_segment({
                material: 'A333gr6', schedule_in: 80, nps_in: 4,
                measured_WT_in: 0.39, min_spec_WT_in: 0.34, failure_WT_in: 0.067,
                design_pressure_psig: 5000, design_temp_F: 250,
                sand_rate_lbMMscf: 50, c_constant: 300, mixture_velocity_fps: 30
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
                    { label: 'SSV->Choke', material: '5L-X52', nps_in: 4, sch: 180, length_ft: 50,
                      measured_WT_in: 0.5, min_spec_WT_in: 0.337, failure_WT_in: 0.024,
                      design_p_psig: 5000, design_T_F: 250, p_seg_psig: 1971, t_seg_F: 100 },
                    { label: 'Choke->Heater', material: 'A333gr6', nps_in: 3, sch: 180, length_ft: 25,
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
