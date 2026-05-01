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
//     4. Maximum allowable working pressure based on yield + measured WT
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
    //   tensile_psi     — UTS, used as an upper bound on MAWP
    //   yield_psi       — Sy, used in Barlow MAWP (factor 0.875 for mill tol.)
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
        '4': { '40': 0.237, '80': 0.337, '160': 0.531, '180': 0.674, 'XXH': 0.812 },
        '6': { '40': 0.280, '80': 0.432, '160': 0.719, '180': 0.864, 'XXH': 0.875 },
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
    // Salama (2000) erosion-rate model
    //
    //   E_mils_per_year = c * W_sand * v^2 / D^2
    //
    //   where:
    //     W_sand  = sand concentration (lb sand / MMscf gas)
    //     v       = mixture velocity (ft/s)
    //     D       = inner pipe diameter (inches)
    //     c       = empirical constant (~300 for steel + cushion-tee /
    //               machined elbow geometry per Salama 2000)
    //
    //   The constant c bundles the material erosion-resistance factor
    //   and the geometry factor for a clean Tee-style elbow. For a
    //   regular Long Radius Elbow the user should bump c by ~3-5x to
    //   account for the focused outer-radius impingement.
    // ───────────────────────────────────────────────────────────────
    function erosion_rate_salama(W_sand_lbMMscf, v_fps, D_in, c) {
        var W = Math.max(_num(W_sand_lbMMscf, 0), 0);
        var v = Math.max(_num(v_fps, 0), 0);
        var D = Math.max(_num(D_in, 0.5), 0.1);
        var cc = _num(c, 300);
        if (W === 0 || v === 0) return 0;
        return cc * W * v * v / (D * D);
    }
    G.WTS_erosion_rate_salama = erosion_rate_salama;

    // ───────────────────────────────────────────────────────────────
    // Maximum allowable working pressure (Barlow + 0.875 mill-tolerance)
    //
    //   P_allow = 2 * Sy * 0.875 * t_measured / OD     (psig)
    //
    //   * Cap at material UTS / 2 to keep clearly outside fracture range.
    //   * For Coflex hose return the typical 5000 psi WP rating.
    // ───────────────────────────────────────────────────────────────
    function maxAllowablePressure(material_key, measured_WT_in, nps_in) {
        var m = MATERIALS[material_key] || MATERIALS['A333gr6'];
        if (!m.erodes) return 5000; // hose rated WP (typical)
        var od = getOD(nps_in);
        var Sy = m.yield_psi;
        var Sut = m.tensile_psi;
        var t = Math.max(_num(measured_WT_in, 0), 0);
        var p = 2 * Sy * 0.875 * t / od;
        var cap = Sut / 2;
        return Math.min(p, cap);
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
        var T_std = 519.67;
        var Qg_acfs = Qg * 1e6 / 86400 * (14.696 / Math.max(P_abs, 14.696)) * (T_abs / T_std);
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
            warnings.push('Max allowable pressure (' + _fmt(out.max_allowable_pressure_psig, 0) +
                          ' psig) is below design ' + _fmt(design_p, 0) + ' psig.');
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
            warnings.push('Sand poundage > 100 lb/MMscf — verify desander efficiency.');
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
    //   1. Title + sub
    //   2. Banner: "elbow + valve geometry assumptions"
    //   3. Operating-conditions card (sand rate, c, gas/oil/water rates)
    //   4. Six segment cards in a horizontal flow with measured-WT
    //      sub-card per segment.
    //   5. Banner: "separator bypass note"
    //   6. Footer: limiting segment / overall min life.
    // ───────────────────────────────────────────────────────────────
    function _formatDays(days) {
        if (!isFinite(days)) return '— days';
        if (days >= 365.25 * 10) return _fmt(days / 365.25, 1) + ' yr';
        if (days >= 365.25)      return _fmt(days, 0) + ' days  (' + _fmt(days / 365.25, 2) + ' yr)';
        return _fmt(days, 1) + ' days';
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

    function _segmentCard(seg, idx) {
        var m = MATERIALS[seg.material] || MATERIALS['A333gr6'];
        var hose = !m.erodes;
        return '' +
        '<div class="card pl-seg" data-seg-idx="' + idx + '" style="min-width:240px;flex:1 1 240px;display:flex;flex-direction:column;gap:6px;padding:8px">' +
            '<div class="card-title" style="font-size:12px;font-weight:700;border-bottom:1px solid var(--bd, #2a2f3a);padding-bottom:4px">' +
                _esc(seg.label) +
            '</div>' +
            '<div class="fg-item"><label style="font-size:11px;color:var(--text2)">Material</label>' +
                '<select id="wts_pl_seg' + idx + '_mat" style="width:100%">' + _materialOptions(seg.material) + '</select>' +
            '</div>' +
            '<div id="wts_pl_seg' + idx + '_results" style="padding:6px 4px;background:var(--bg0, #0d1117);border-radius:4px;margin:4px 0">' +
                (hose
                    ? '<div style="font-weight:700;color:var(--orange, #e0b020);font-size:13px">NOT APPLICABLE TO HOSE</div>' +
                      '<div style="font-size:10px;color:var(--text3)">flexible-wall hose — sand erosion not modelled</div>'
                    : '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">Remaining Service Life</div>' +
                      '<div id="wts_pl_seg' + idx + '_rsl" style="font-size:18px;font-weight:700;color:var(--green, #4caf50)">— days</div>' +
                      '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-top:4px">Time to failure at current flowing conditions</div>' +
                      '<div id="wts_pl_seg' + idx + '_ttf" style="font-size:13px;font-weight:600;color:var(--text2)">— days</div>' +
                      '<div id="wts_pl_seg' + idx + '_rate" style="font-size:10px;color:var(--text3);margin-top:4px">erosion: — mpy</div>'
                ) +
            '</div>' +
            '<div class="card" style="padding:6px;background:var(--bg1, #161b22);font-size:11px">' +
                '<div style="font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Wall Thickness Inputs</div>' +
                '<div class="fg" style="display:grid;grid-template-columns:1fr 1fr;gap:4px">' +
                    '<div class="fg-item"><label style="font-size:10px">Measured WT (in)</label>' +
                        '<input type="number" id="wts_pl_seg' + idx + '_meas" step="0.001" min="0" value="' + seg.measured_WT_in + '"></div>' +
                    '<div class="fg-item"><label style="font-size:10px">Min-spec WT (in)</label>' +
                        '<input type="number" id="wts_pl_seg' + idx + '_minspec" step="0.001" min="0" value="' + seg.min_spec_WT_in + '"></div>' +
                    '<div class="fg-item"><label style="font-size:10px">Failure WT (in)</label>' +
                        '<input type="number" id="wts_pl_seg' + idx + '_fail" step="0.001" min="0" value="' + seg.failure_WT_in + '"></div>' +
                    '<div class="fg-item"><label style="font-size:10px">Size (NPS)</label>' +
                        '<select id="wts_pl_seg' + idx + '_nps">' + _npsOptions(seg.nps_in) + '</select></div>' +
                    '<div class="fg-item"><label style="font-size:10px">Schedule</label>' +
                        '<select id="wts_pl_seg' + idx + '_sch">' + _scheduleOptions(seg.sch) + '</select></div>' +
                    '<div class="fg-item"><label style="font-size:10px">Length (ft)</label>' +
                        '<input type="number" id="wts_pl_seg' + idx + '_len" step="1" min="0" value="' + seg.length_ft + '"></div>' +
                    '<div class="fg-item"><label style="font-size:10px">Design P (psig)</label>' +
                        '<input type="number" id="wts_pl_seg' + idx + '_dp" step="50" min="0" value="' + seg.design_p_psig + '"></div>' +
                    '<div class="fg-item"><label style="font-size:10px">Design T (°F)</label>' +
                        '<input type="number" id="wts_pl_seg' + idx + '_dt" step="5" min="-50" value="' + seg.design_T_F + '"></div>' +
                '</div>' +
                '<div id="wts_pl_seg' + idx + '_warn" style="font-size:10px;color:var(--orange, #e0b020);margin-top:4px"></div>' +
            '</div>' +
        '</div>';
    }

    function renderPipeLife(body) {
        if (!body) return;
        var titleEl = (typeof document !== 'undefined') ? document.getElementById('pgTitle') : null;
        var subEl   = (typeof document !== 'undefined') ? document.getElementById('pgSub')   : null;
        if (titleEl) titleEl.textContent = 'Pipe Remaining Service Life';
        if (subEl)   subEl.textContent   = 'Sand erosion-based time-to-failure (Salama 2000) per pipe segment.';

        var cardsHtml = '';
        for (var i = 0; i < DEFAULT_SEGMENTS.length; i++) {
            cardsHtml += _segmentCard(DEFAULT_SEGMENTS[i], i);
        }

        body.innerHTML = '' +
        '<div style="display:flex;flex-direction:column;gap:10px">' +
            // Banner — elbow + valve assumption
            '<div class="card" style="padding:8px;border-left:3px solid var(--orange, #e0b020);background:rgba(224,176,32,0.05)">' +
                '<div style="font-size:11px;color:var(--text2)">' +
                    '<strong>Important:</strong> These estimations assume that <em>Cushion Tees</em> and/or ' +
                    '<em>Machined Block Elbows</em> are used and all valves are <em>Full Port</em>. Regular Long ' +
                    'and Short Radius Elbows will concentrate the sand poundage to the outer radius of the elbow ' +
                    'and increase local erosion rate. Regular and Reduced Port Valves will increase fluid velocity ' +
                    'through the valve also increasing local erosion rate.' +
                '</div>' +
            '</div>' +

            // Top operating conditions
            '<div class="card" style="padding:8px">' +
                '<div class="card-title">Operating Conditions</div>' +
                '<div class="fg" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:8px">' +
                    '<div class="fg-item"><label>Sand Production (lbs/MMscf)</label>' +
                        '<input type="number" id="wts_pl_sand" step="1" min="0" value="50"></div>' +
                    '<div class="fg-item"><label>Empirical Constant "c"</label>' +
                        '<input type="number" id="wts_pl_c" step="10" min="50" max="2000" value="300"></div>' +
                    '<div class="fg-item"><label>Gas Rate (MMscfd)</label>' +
                        '<input type="number" id="wts_pl_qg" step="0.5" min="0" value="25"></div>' +
                    '<div class="fg-item"><label>Oil Rate (bpd)</label>' +
                        '<input type="number" id="wts_pl_qo" step="50" min="0" value="2500"></div>' +
                    '<div class="fg-item"><label>Water Rate (bpd)</label>' +
                        '<input type="number" id="wts_pl_qw" step="50" min="0" value="400"></div>' +
                    '<div class="fg-item"><label>Gas SG (air=1)</label>' +
                        '<input type="number" id="wts_pl_sg" step="0.01" min="0.55" max="1.20" value="0.78"></div>' +
                    '<div class="fg-item"><label>Separator Bypass</label>' +
                        '<select id="wts_pl_bypass"><option value="0" selected>No</option><option value="1">Yes</option></select></div>' +
                '</div>' +
            '</div>' +

            // Segment grid (horizontal flow, will wrap on narrow screens)
            '<div style="display:flex;flex-wrap:wrap;gap:8px">' + cardsHtml + '</div>' +

            // Separator note (right-aligned per spec, but full-width for readability)
            '<div class="card" style="padding:8px;border-left:3px solid var(--blue, #4a90e2);background:rgba(74,144,226,0.05)">' +
                '<div style="font-size:11px;color:var(--text2)">' +
                    '<strong>Note:</strong> It is assumed that any residual sand fines will drop out in the separator. ' +
                    'Hence changes to Sand Poundage and Filter Efficiency will have no effect on erosion in the ' +
                    'Separator -> Flare line unless the Separator is Bypassed.' +
                '</div>' +
            '</div>' +

            // Footer summary
            '<div class="card" style="padding:8px">' +
                '<div class="card-title">System Summary</div>' +
                '<div id="wts_pl_summary" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:8px;font-size:12px">' +
                    '<div><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Limiting Segment</div>' +
                        '<div id="wts_pl_lim" style="font-weight:700">—</div></div>' +
                    '<div><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Overall min RSL</div>' +
                        '<div id="wts_pl_minlife" style="font-weight:700">—</div></div>' +
                    '<div><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Status</div>' +
                        '<div id="wts_pl_status" style="font-weight:700">—</div></div>' +
                '</div>' +
            '</div>' +
        '</div>';

        _wirePipeLife();
        _calcPipeLife();
    }
    G.renderPipeLife = renderPipeLife;

    // ───────────────────────────────────────────────────────────────
    // Wire all inputs to recompute on change.
    // ───────────────────────────────────────────────────────────────
    function _wirePipeLife() {
        if (typeof document === 'undefined') return;
        var ids = ['wts_pl_sand','wts_pl_c','wts_pl_qg','wts_pl_qo','wts_pl_qw','wts_pl_sg','wts_pl_bypass'];
        for (var i = 0; i < DEFAULT_SEGMENTS.length; i++) {
            ids.push('wts_pl_seg' + i + '_mat');
            ids.push('wts_pl_seg' + i + '_meas');
            ids.push('wts_pl_seg' + i + '_minspec');
            ids.push('wts_pl_seg' + i + '_fail');
            ids.push('wts_pl_seg' + i + '_nps');
            ids.push('wts_pl_seg' + i + '_sch');
            ids.push('wts_pl_seg' + i + '_len');
            ids.push('wts_pl_seg' + i + '_dp');
            ids.push('wts_pl_seg' + i + '_dt');
        }
        var t = null;
        var fire = function () {
            if (t) clearTimeout(t);
            t = setTimeout(_calcPipeLife, 150);
        };
        for (var k = 0; k < ids.length; k++) {
            var el = _$(ids[k]);
            if (!el) continue;
            // Auto-update min-spec when material/sch change.
            if (/_mat$/.test(ids[k]) || /_sch$/.test(ids[k]) || /_nps$/.test(ids[k])) {
                el.addEventListener('change', _autoFillMinSpec);
            }
            el.addEventListener('input',  fire);
            el.addEventListener('change', fire);
        }
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
            var matEl = _$('wts_pl_seg' + i + '_mat');
            var meas  = _$('wts_pl_seg' + i + '_meas');
            var minsp = _$('wts_pl_seg' + i + '_minspec');
            var fail  = _$('wts_pl_seg' + i + '_fail');
            var nps   = _$('wts_pl_seg' + i + '_nps');
            var sch   = _$('wts_pl_seg' + i + '_sch');
            var len   = _$('wts_pl_seg' + i + '_len');
            var dp    = _$('wts_pl_seg' + i + '_dp');
            var dt    = _$('wts_pl_seg' + i + '_dt');
            segs.push({
                key: d.key,
                label: d.label,
                material: matEl ? matEl.value : d.material,
                nps_in: nps ? _num(nps.value, d.nps_in) : d.nps_in,
                sch:    sch ? sch.value : d.sch,
                length_ft: len ? _num(len.value, d.length_ft) : d.length_ft,
                measured_WT_in: meas ? _num(meas.value, d.measured_WT_in) : d.measured_WT_in,
                min_spec_WT_in: minsp ? _num(minsp.value, d.min_spec_WT_in) : d.min_spec_WT_in,
                failure_WT_in:  fail ? _num(fail.value, d.failure_WT_in) : d.failure_WT_in,
                design_p_psig:  dp ? _num(dp.value, d.design_p_psig) : d.design_p_psig,
                design_T_F:     dt ? _num(dt.value, d.design_T_F) : d.design_T_F,
                // Operating-state proxies for the velocity calc — the typical
                // along-the-string flowing values are baked into DEFAULT_SEGMENTS.
                p_seg_psig:     _num(d.p_seg_psig, d.design_p_psig * 0.5),
                t_seg_F:        _num(d.t_seg_F, 100)
            });
        }
        return segs;
    }

    function _calcPipeLife() {
        if (typeof document === 'undefined') return;
        if (!_$('wts_pl_sand')) return;
        var sand   = _num((_$('wts_pl_sand') || {}).value, 50);
        var c      = _num((_$('wts_pl_c') || {}).value, 300);
        var qg     = _num((_$('wts_pl_qg') || {}).value, 25);
        var qo     = _num((_$('wts_pl_qo') || {}).value, 2500);
        var qw     = _num((_$('wts_pl_qw') || {}).value, 400);
        var sg     = _num((_$('wts_pl_sg') || {}).value, 0.78);
        var bypEl  = _$('wts_pl_bypass');
        var bypass = bypEl ? (bypEl.value === '1' || bypEl.value === 'true') : false;

        var inputs = {
            sand_production_lbMMscf: sand,
            c_constant: c,
            gas_rate_MMscfd: qg,
            oil_rate_bpd: qo,
            water_rate_bpd: qw,
            gasSG: sg,
            bypass_separator: bypass,
            segments: _readSegmentInputs()
        };
        var report = pipelife_compute(inputs);
        G.WTS_pipelife_lastReport = report;

        // Paint per-segment.
        for (var i = 0; i < report.segments.length; i++) {
            var r = report.segments[i];
            var rslEl  = _$('wts_pl_seg' + i + '_rsl');
            var ttfEl  = _$('wts_pl_seg' + i + '_ttf');
            var rateEl = _$('wts_pl_seg' + i + '_rate');
            var warnEl = _$('wts_pl_seg' + i + '_warn');
            if (!r.applicable) {
                if (rslEl) rslEl.textContent = 'N/A';
                if (ttfEl) ttfEl.textContent = 'N/A';
                if (rateEl) rateEl.textContent = '';
                if (warnEl) warnEl.textContent = '';
                continue;
            }
            if (rslEl) {
                rslEl.textContent = _formatDays(r.remaining_service_life_days);
                rslEl.style.color = r.remaining_service_life_days < 30  ? 'var(--red, #ef4444)'
                                  : r.remaining_service_life_days < 90  ? 'var(--orange, #e0b020)'
                                  : 'var(--green, #4caf50)';
            }
            if (ttfEl) ttfEl.textContent = _formatDays(r.time_to_failure_at_current_days);
            if (rateEl) rateEl.textContent =
                'erosion: ' + _fmt(r.erosion_rate_mils_yr, 1) + ' mpy  •  v=' +
                _fmt(r.mixture_velocity_fps, 0) + ' ft/s  •  MAWP ' +
                _fmt(r.max_allowable_pressure_psig, 0) + ' psig';
            if (warnEl) {
                warnEl.textContent = (r.warnings && r.warnings.length) ? r.warnings.join(' • ') : '';
            }
        }

        // Summary footer.
        var limEl = _$('wts_pl_lim'), minLifeEl = _$('wts_pl_minlife'), statEl = _$('wts_pl_status');
        if (limEl) limEl.textContent = report.limiting_segment ? report.limiting_segment.label : '—';
        if (minLifeEl) minLifeEl.textContent = _formatDays(report.overall_min_life_days);
        if (statEl) {
            var ok = true;
            for (var s = 0; s < report.segments.length; s++) {
                if (report.segments[s].applicable && !report.segments[s].ok_to_operate) { ok = false; break; }
            }
            statEl.textContent = ok ? 'OK' : 'ATTENTION';
            statEl.style.color = ok ? 'var(--green, #4caf50)' : 'var(--red, #ef4444)';
        }
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
