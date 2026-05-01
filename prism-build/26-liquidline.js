// ════════════════════════════════════════════════════════════════════
// WTS ─ Layer 26 — Liquid Line / Restrictive Orifice (RO) Sizing
//
// PURPOSE
//   Analyses the gas-blowby risk through a separator's liquid control
//   valve (LCV) toward an atmospheric storage tank, and sizes a
//   restrictive orifice (RO) to throttle the gas flow such that the
//   tank's vent line can vent it without exceeding the tank pressure
//   rating.
//
//   In a typical surface test system, the separator drains oil + water
//   to an atmospheric storage tank via an LCV regulating liquid level.
//   If the LCV fails open or the separator runs dry while gas pressure
//   is at design, gas blows by through the LCV at a much higher mass
//   rate than liquid would, potentially over-pressuring the tank. An
//   RO is installed downstream of the LCV to throttle this gas flow.
//
// PUBLIC API (all on window.*)
//
//   window.renderLiquidLine(body)            — paints the calculator UI
//                                              into the host body div
//
//   window.WTS_lcv_blowby(Cv, P1_psia, gasSG, T_R)
//       → Q_gas_MMscfd  (choked-flow gas rate through an LCV with given
//                        Cv at P1 upstream, gas SG, T in °R)
//
//   window.WTS_ro_size(Q_target_MMscfd, P1_psia, gasSG, T_R)
//       → { d_64ths, d_inch, regime }
//                       (RO bore diameter — in 64ths and inches — that
//                        passes Q_target at choked conditions; regime is
//                        always 'critical' for screening purposes)
//
//   window.WTS_vent_capacity(line_NPS, line_sch, line_length_ft,
//                            tank_max_psig, gasSG, T_F)
//       → Q_max_MMscfd  (maximum gas rate the tank vent line can pass
//                        without lifting tank pressure above its rating —
//                        simplified Crane TP-410 short-pipe form)
//
//   window.WTS_flammability_radii(Q_vent_MMscfd, wind_mph)
//       → { x_ft, y_ft, s_ft }
//                       (lean-flammability footprint — vertical, downwind
//                        horizontal, axial — at the RO/vent exit)
//
//   window.WTS_liquidline_compute(inputs)    — full screening calc
//       → { max_gas_through_lcv_MMscfd, ro_required, ro_max_throughput_MMscfd,
//           vent_max_capacity_MMscfd, ro_required_size_64ths,
//           protection_status, flammability, rationale, p_downstream_ro_psig }
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.WTS_* / window.renderLiquidLine.
//   • No external runtime dependencies — pure vanilla JS, Math.*.
//   • Field units throughout (psi, °F, °R, bbl/d, MMscf/d, ft, in).
//   • Defensive against missing inputs / DOM elements.
//   • Self-test at end of file (stripped during concat by sentinel).
//
// APPROXIMATIONS
//   • LCV gas blowby uses Fisher-style choked Cv form
//       Q [SCFD] = 1360·Cv·P1·sqrt(1 / (SG·T_R))
//     adequate for screening at critical pressure ratio (~0.5).
//   • RO sizing assumes critical flow:
//       Q [MMscfd] = 0.0001875·d²·P1 / sqrt(SG·T_R)   d in 64ths
//   • Vent capacity is a simplified incompressible-equivalent
//       Q [MMscfd] = 1.10 · K · A_pipe · sqrt(2·ΔP_tank / ρ_gas)
//     in lieu of full TP-410 Fanning compressible integration.
//   • Flammability radii are scaled from a baseline footprint
//       y0=20, x0=36, s0=45 ft   at Q=25 MMscfd, wind=20 mph
//     using sqrt(Q) and small wind-tilt correction.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasWin = (typeof window !== 'undefined');
    var G = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // ────────────────────────────────────────────────────────────
    // 1. Constants & lookup tables
    // ────────────────────────────────────────────────────────────

    // Typical Cv values for full-port equal-percentage trim LCVs.
    // Represent fully-open Cv at line size — screening defaults only.
    var LCV_CV_TABLE = {
        1: 17,
        2: 60,
        3: 130,
        4: 230,
        6: 500
    };

    // Inside-diameter (inches) lookup for common NPS / Schedule combos.
    // Schedule 40 / 80 / 160 standard wall thickness from ASME B36.10.
    var PIPE_ID_TABLE = {
        '2-40':  2.067,  '2-80':  1.939,  '2-160': 1.687,
        '3-40':  3.068,  '3-80':  2.900,  '3-160': 2.624,
        '4-40':  4.026,  '4-80':  3.826,  '4-160': 3.438,
        '6-40':  6.065,  '6-80':  5.761,  '6-160': 5.187,
        '8-40':  7.981,  '8-80':  7.625,  '8-160': 6.813,
        '10-40': 10.020, '10-80': 9.562,  '10-160': 8.500,
        '12-40': 11.938, '12-80': 11.374, '12-160': 10.126
    };

    function _pipeID(nps, sch) {
        var key = String(nps) + '-' + String(sch);
        if (PIPE_ID_TABLE[key]) return PIPE_ID_TABLE[key];
        // Fallback: use NPS as nominal ID (conservative)
        var n = Number(nps);
        return isFinite(n) && n > 0 ? n : 4;
    }

    // ────────────────────────────────────────────────────────────
    // 2. Engineering primitives (pure functions)
    // ────────────────────────────────────────────────────────────

    /**
     * Gas blowby through a control valve at choked conditions.
     * Uses a simplified Fisher Cv-based form for critical flow.
     *
     *   Q [SCFD] = 1360·Cv·P1·sqrt(1 / (SG·T_R))
     *   Q [MMscfd] = Q[SCFD] · 1e-6
     *
     * @param {number} Cv      valve flow coefficient (gpm @ 1 psi for liquid)
     * @param {number} P1_psia upstream absolute pressure (psia)
     * @param {number} gasSG   gas specific gravity (air = 1)
     * @param {number} T_R     gas temperature (°Rankine)
     * @returns {number} Q_gas in MMscfd
     */
    function WTS_lcv_blowby(Cv, P1_psia, gasSG, T_R) {
        Cv      = Number(Cv);
        P1_psia = Number(P1_psia);
        gasSG   = Number(gasSG);
        T_R     = Number(T_R);
        if (!(Cv > 0) || !(P1_psia > 0) || !(gasSG > 0) || !(T_R > 0)) return 0;
        // Critical-flow simplified Fisher form
        var Q_scfd = 1360 * Cv * P1_psia * Math.sqrt(1 / (gasSG * T_R));
        return Q_scfd * 1e-6; // MMscfd
    }

    /**
     * Restrictive Orifice sizing — find bore diameter that passes Q_target
     * at choked flow.
     *
     *   Q [MMscfd] = 0.0001875 · d² · P1 / sqrt(SG·T_R)    (d in 64ths)
     *
     * @param {number} Q_target_MMscfd  target gas rate
     * @param {number} P1_psia          upstream absolute pressure
     * @param {number} gasSG            gas specific gravity
     * @param {number} T_R              gas temperature (°Rankine)
     * @returns {{d_64ths:number, d_inch:number, regime:string}}
     */
    function WTS_ro_size(Q_target_MMscfd, P1_psia, gasSG, T_R) {
        Q_target_MMscfd = Number(Q_target_MMscfd);
        P1_psia = Number(P1_psia);
        gasSG   = Number(gasSG);
        T_R     = Number(T_R);
        if (!(Q_target_MMscfd > 0) || !(P1_psia > 0) || !(gasSG > 0) || !(T_R > 0)) {
            return { d_64ths: 0, d_inch: 0, regime: 'critical' };
        }
        var K = 0.0001875;
        var d_sq = Q_target_MMscfd * Math.sqrt(gasSG * T_R) / (K * P1_psia);
        var d_64 = Math.sqrt(Math.max(0, d_sq));
        return {
            d_64ths: d_64,
            d_inch:  d_64 / 64,
            regime:  'critical'
        };
    }

    /**
     * Inverse of WTS_ro_size — given bore (64ths), what flow does it pass.
     */
    function WTS_ro_flow(d_64ths, P1_psia, gasSG, T_R) {
        d_64ths = Number(d_64ths);
        P1_psia = Number(P1_psia);
        gasSG   = Number(gasSG);
        T_R     = Number(T_R);
        if (!(d_64ths > 0) || !(P1_psia > 0) || !(gasSG > 0) || !(T_R > 0)) return 0;
        return 0.0001875 * d_64ths * d_64ths * P1_psia / Math.sqrt(gasSG * T_R);
    }

    /**
     * Vent line max allowable capacity — simplified screening.
     *
     *   Q [MMscfd] = 1.10 · K · A_pipe · sqrt(2 · ΔP_tank / ρ_gas)
     *
     * with K = 0.6, A in ft², ΔP_tank in psi, ρ_gas at tank conditions.
     *
     * @param {number} line_NPS       nominal pipe size (in)
     * @param {number} line_sch       schedule (40, 80, 160)
     * @param {number} line_length_ft total run length (ft)  — informational
     * @param {number} tank_max_psig  tank max design pressure (psig)
     * @param {number} gasSG          gas specific gravity
     * @param {number} T_F            tank/gas temperature (°F)
     */
    function WTS_vent_capacity(line_NPS, line_sch, line_length_ft, tank_max_psig, gasSG, T_F) {
        line_NPS      = Number(line_NPS);
        line_sch      = Number(line_sch);
        tank_max_psig = Number(tank_max_psig);
        gasSG         = Number(gasSG);
        T_F           = Number(T_F);
        if (!(line_NPS > 0) || !(tank_max_psig > 0) || !(gasSG > 0)) return 0;

        var ID_in   = _pipeID(line_NPS, line_sch || 40);
        var ID_ft   = ID_in / 12;
        var A_ft2   = Math.PI * 0.25 * ID_ft * ID_ft;

        // Gas density at tank conditions (atmospheric + ΔP_tank, T_F)
        // ρ [lb/ft³] = P_psia · MW / (10.732 · T_R)
        var T_R     = (isFinite(T_F) ? T_F : 100) + 459.67;
        var MW      = gasSG * 28.96;
        var P_psia  = 14.7 + tank_max_psig * 0.5; // mean across vent
        var rho_lbpft3 = P_psia * MW / (10.732 * T_R);
        if (!(rho_lbpft3 > 0)) return 0;

        // Convert pressure drop to consistent units
        // ΔP [lbf/ft²] = tank_max_psig · 144
        var dP_lbpft2 = tank_max_psig * 144;
        var K = 0.6;

        // Volumetric flow at tank conditions (ft³/s)
        // q = K · A · sqrt(2·ΔP / ρ)
        var v_fps  = Math.sqrt(2 * dP_lbpft2 * 32.174 / rho_lbpft3); // gc included
        var q_acfs = K * A_ft2 * v_fps;

        // Convert to standard m³/d → MMscfd
        // q_std = q_actual · (P_actual / P_std) · (T_std / T_actual)
        var P_std = 14.7;
        var T_std = 519.67; // 60 °F
        var q_scfs = q_acfs * (P_psia / P_std) * (T_std / T_R);
        var q_scfd = q_scfs * 86400;
        var Q_MMscfd = 1.10 * q_scfd * 1e-6; // 10% margin per simplified TP-410

        // Mild length penalty (long lines reduce throughput).
        // Reduces ~5% per 100 ft beyond first 50 ft, capped at 30%.
        if (isFinite(line_length_ft) && line_length_ft > 50) {
            var penalty = Math.min(0.30, 0.05 * (line_length_ft - 50) / 100);
            Q_MMscfd *= (1 - penalty);
        }
        return Q_MMscfd;
    }

    /**
     * Lean flammability radii — simplified jet-flame footprint for the gas
     * exiting the RO/vent stack.
     *
     * Baseline at Q=25 MMscfd, wind=20 mph:
     *   y₀=20 ft, x₀=36 ft, s₀=45 ft
     * Scaling: length_scale = sqrt(Q/25);  wind_tilt = 1 + 0.01·(W − 20).
     *
     * @param {number} Q_vent_MMscfd  flow at the vent/RO exit
     * @param {number} wind_mph       wind speed
     * @returns {{x_ft:number, y_ft:number, s_ft:number}}
     */
    function WTS_flammability_radii(Q_vent_MMscfd, wind_mph) {
        Q_vent_MMscfd = Number(Q_vent_MMscfd);
        wind_mph      = Number(wind_mph);
        if (!isFinite(Q_vent_MMscfd) || Q_vent_MMscfd < 0) Q_vent_MMscfd = 0;
        if (!isFinite(wind_mph)) wind_mph = 20;

        var Q_ref = 25;
        var scale = Math.sqrt(Math.max(Q_vent_MMscfd, 0.01) / Q_ref);
        var wind_tilt = 1 + 0.01 * (wind_mph - 20);
        if (wind_tilt < 0.6) wind_tilt = 0.6;
        if (wind_tilt > 1.6) wind_tilt = 1.6;

        return {
            y_ft: 20 * scale,
            x_ft: 36 * scale * wind_tilt,
            s_ft: 45 * scale
        };
    }

    /**
     * Full liquid-line / RO compute — the workhorse.
     *
     * @param {Object} inputs see UI doc / file header
     * @returns {Object}      composite result with status & rationale
     */
    function WTS_liquidline_compute(inputs) {
        inputs = inputs || {};
        var sepP_psig   = Number(inputs.sepDesignPressure_psig);
        var oilRate_bpd = Number(inputs.oilRate_bpd);
        var gasSG       = Number(inputs.gasSG);
        var qGas_MMscfd = Number(inputs.gasFlowRate_MMscfd);
        var T_F         = Number(inputs.gasTemp_F);
        var lcv_size    = Number(inputs.lcv_size_in);
        var ro_size_64  = Number(inputs.ro_size_64ths);
        var vent_NPS    = Number(inputs.vent_NPS);
        var vent_sch    = Number(inputs.vent_sch);
        var vent_len    = Number(inputs.vent_length_ft);
        var tankP_psig  = Number(inputs.tank_design_pressure_psig);
        var wind        = Number(inputs.wind_mph);

        if (!isFinite(sepP_psig)) sepP_psig = 1440;
        if (!isFinite(gasSG))     gasSG = 0.78;
        if (!isFinite(qGas_MMscfd)) qGas_MMscfd = 25;
        if (!isFinite(T_F))       T_F = 100;
        if (!isFinite(tankP_psig)) tankP_psig = 50;
        if (!isFinite(wind))      wind = 20;
        if (!isFinite(vent_NPS))  vent_NPS = 6;
        if (!isFinite(vent_sch))  vent_sch = 40;
        if (!isFinite(vent_len))  vent_len = 100;
        if (!isFinite(lcv_size))  lcv_size = 4;

        var T_R = T_F + 459.67;
        var P1_psia = sepP_psig + 14.7;

        // Cv from LCV size table
        var Cv = LCV_CV_TABLE[lcv_size] || LCV_CV_TABLE[4];

        // 1. Max gas blowby through LCV at design separator pressure
        var Q_lcv = WTS_lcv_blowby(Cv, P1_psia, gasSG, T_R);

        // 2. Vent line max capacity
        var Q_vent = WTS_vent_capacity(vent_NPS, vent_sch, vent_len, tankP_psig, gasSG, T_F);

        // 3. RO required if blowby > vent capacity
        var ro_required = (Q_lcv > Q_vent);

        // 4. Required RO bore size to drop Q_lcv → Q_vent at separator pressure
        var ro_target_size = NaN;
        if (ro_required && Q_vent > 0) {
            ro_target_size = WTS_ro_size(Q_vent, P1_psia, gasSG, T_R).d_64ths;
        }

        // 5. Throughput of installed RO at the design pressure
        var Q_ro_installed = isFinite(ro_size_64) && ro_size_64 > 0
            ? WTS_ro_flow(ro_size_64, P1_psia, gasSG, T_R)
            : NaN;

        // 6. Pressure downstream of RO at choked flow ≈ 0.5 · P1 (critical
        //    pressure ratio for natural gas, k≈1.27).  Subtract 14.7 to
        //    return psig.
        var p_down_ro_psig = 0.5 * P1_psia - 14.7;
        if (p_down_ro_psig < 0) p_down_ro_psig = 0;

        // 7. Protection status
        var protection_status = 'green';
        var rationale = '';
        if (Q_lcv <= Q_vent) {
            rationale = 'LCV blowby (' + Q_lcv.toFixed(2) +
                ' MMscfd) is below vent capacity (' + Q_vent.toFixed(2) +
                ' MMscfd). No RO required for tank protection.';
        } else if (isFinite(Q_ro_installed) && Q_ro_installed <= Q_vent) {
            rationale = 'LCV blowby (' + Q_lcv.toFixed(2) +
                ' MMscfd) exceeds vent capacity but the installed ' +
                ro_size_64.toFixed(0) + '/64" RO throttles flow to ' +
                Q_ro_installed.toFixed(2) + ' MMscfd, below the ' +
                Q_vent.toFixed(2) + ' MMscfd vent limit. Adequate.';
        } else if (isFinite(Q_ro_installed) && Q_ro_installed > Q_vent) {
            protection_status = 'red';
            rationale = 'RO is undersized: ' + ro_size_64.toFixed(0) +
                '/64" passes ' + Q_ro_installed.toFixed(2) +
                ' MMscfd > vent ' + Q_vent.toFixed(2) +
                ' MMscfd. Reduce RO bore to ≈ ' +
                (isFinite(ro_target_size) ? ro_target_size.toFixed(1) : '?') +
                '/64".';
        } else {
            protection_status = 'red';
            rationale = 'LCV blowby (' + Q_lcv.toFixed(2) +
                ' MMscfd) exceeds vent capacity (' + Q_vent.toFixed(2) +
                ' MMscfd). Install RO of bore ≈ ' +
                (isFinite(ro_target_size) ? ro_target_size.toFixed(1) : '?') +
                '/64" to protect tank.';
        }

        // 8. Flammability footprint at vent exit (post-RO Q ≈ Q_vent target)
        var Q_at_vent = isFinite(Q_ro_installed) && Q_ro_installed > 0
            ? Math.min(Q_ro_installed, Q_lcv)
            : Q_lcv;
        var flammability = WTS_flammability_radii(Q_at_vent, wind);

        return {
            max_gas_through_lcv_MMscfd: Q_lcv,
            ro_required: ro_required,
            ro_max_throughput_MMscfd: isFinite(Q_ro_installed) ? Q_ro_installed : null,
            vent_max_capacity_MMscfd: Q_vent,
            ro_required_size_64ths: isFinite(ro_target_size) ? ro_target_size : null,
            protection_status: protection_status,
            p_downstream_ro_psig: p_down_ro_psig,
            flammability: flammability,
            rationale: rationale
        };
    }

    // ────────────────────────────────────────────────────────────
    // 3. UI rendering
    // ────────────────────────────────────────────────────────────

    function _$(id) {
        return (typeof document !== 'undefined') ? document.getElementById(id) : null;
    }
    function _val(id, fallback) {
        var el = _$(id);
        if (!el) return fallback;
        var v = parseFloat(el.value);
        return isFinite(v) ? v : fallback;
    }
    function _selVal(id, fallback) {
        var el = _$(id);
        if (!el) return fallback;
        return el.value;
    }
    function _setText(id, txt) {
        var el = _$(id);
        if (el) el.textContent = txt;
    }

    // Inline SVG schematic — separator ▶ LCV ▶ RO ▶ vent ▶ atmospheric tank
    var SCHEMATIC_SVG = ''
        + '<svg viewBox="0 0 760 200" xmlns="http://www.w3.org/2000/svg" '
        + 'style="width:100%;max-width:760px;height:auto;background:#0d1117;'
        + 'border-radius:6px;border:1px solid rgba(88,166,255,0.18)">'
        // separator
        + '<rect x="20" y="60" width="120" height="100" rx="8" '
        +   'fill="#161b22" stroke="#58a6ff" stroke-width="1.5"/>'
        + '<text x="80" y="56" fill="#c9d1d9" font-size="11" '
        +   'text-anchor="middle" font-family="monospace">SEPARATOR</text>'
        + '<line x1="40" y1="105" x2="120" y2="105" stroke="#58a6ff" '
        +   'stroke-width="0.7" stroke-dasharray="3 3"/>'
        + '<text x="80" y="100" fill="#58a6ff" font-size="9" '
        +   'text-anchor="middle">gas</text>'
        + '<text x="80" y="125" fill="#79c0ff" font-size="9" '
        +   'text-anchor="middle">oil + water</text>'
        // liquid line out
        + '<line x1="140" y1="135" x2="220" y2="135" stroke="#79c0ff" '
        +   'stroke-width="2"/>'
        // LCV
        + '<polygon points="220,125 240,135 220,145 240,145 260,135 240,125" '
        +   'fill="#21262d" stroke="#f0883e" stroke-width="1.5"/>'
        + '<text x="240" y="115" fill="#f0883e" font-size="10" '
        +   'text-anchor="middle" font-family="monospace">LCV</text>'
        + '<text x="240" y="161" fill="#8b949e" font-size="9" '
        +   'text-anchor="middle">level ctl</text>'
        // line LCV → RO
        + '<line x1="260" y1="135" x2="370" y2="135" stroke="#79c0ff" '
        +   'stroke-width="2"/>'
        // RO (yellow flag)
        + '<rect x="370" y="120" width="40" height="30" '
        +   'fill="#f8e3a1" stroke="#d4a017" stroke-width="1.5"/>'
        + '<line x1="380" y1="120" x2="400" y2="150" stroke="#d4a017" '
        +   'stroke-width="1"/>'
        + '<line x1="400" y1="120" x2="380" y2="150" stroke="#d4a017" '
        +   'stroke-width="1"/>'
        + '<text x="390" y="115" fill="#d4a017" font-size="10" '
        +   'text-anchor="middle" font-family="monospace">RO</text>'
        // line RO → tank
        + '<line x1="410" y1="135" x2="540" y2="135" stroke="#79c0ff" '
        +   'stroke-width="2"/>'
        // tank
        + '<rect x="540" y="60" width="180" height="120" rx="6" '
        +   'fill="#161b22" stroke="#3fb950" stroke-width="1.5"/>'
        + '<text x="630" y="56" fill="#c9d1d9" font-size="11" '
        +   'text-anchor="middle" font-family="monospace">ATM TANK</text>'
        // vent stack
        + '<rect x="615" y="20" width="30" height="40" '
        +   'fill="#161b22" stroke="#3fb950" stroke-width="1.5"/>'
        + '<text x="630" y="14" fill="#3fb950" font-size="9" '
        +   'text-anchor="middle" font-family="monospace">VENT</text>'
        // labels
        + '<text x="200" y="180" fill="#8b949e" font-size="9">P₁ at sep</text>'
        + '<text x="425" y="180" fill="#8b949e" font-size="9">P₂ ≈ 0.5·P₁</text>'
        + '</svg>';

    function renderLiquidLine(body) {
        if (!body) return;

        // Page header (matches the rest of the suite)
        _setText('pgTitle', 'Liquid Line / RO Sizing');
        _setText('pgSub',   'Gas blowby protection from separator → atmospheric storage tank.');

        body.innerHTML = ''
        + '<div style="margin-bottom:14px">' + SCHEMATIC_SVG + '</div>'

        + '<div class="cols-2">'
        + '  <div>'
        // GAS BLOWBY card
        + '    <div class="card"><div class="card-title">Gas Blowby</div>'
        + '      <div class="fg">'
        + '        <div class="fg-item"><label>Separator Press (psig)</label>'
        + '          <input type="number" id="wts_ll_sep_p" value="1440" step="10"></div>'
        + '        <div class="fg-item"><label>Oil Rate (bbl/d)</label>'
        + '          <input type="number" id="wts_ll_qoil" value="2500" step="50"></div>'
        + '        <div class="fg-item"><label>Oil Temp (°F)</label>'
        + '          <input type="number" id="wts_ll_t_oil" value="100" step="5"></div>'
        + '        <div class="fg-item"><label>Oil SG</label>'
        + '          <input type="number" id="wts_ll_sg_oil" value="0.85" step="0.01"></div>'
        + '        <div class="fg-item"><label>Gas SG</label>'
        + '          <input type="number" id="wts_ll_sg_gas" value="0.78" step="0.01"></div>'
        + '        <div class="fg-item"><label>Gas Flow Rate (MMscf/d)</label>'
        + '          <input type="number" id="wts_ll_q_gas" value="25" step="1"></div>'
        + '        <div class="fg-item"><label>Cond. GOR (scf/bbl)</label>'
        + '          <input type="number" id="wts_ll_gor" value="" readonly '
        +             'style="background:rgba(88,166,255,0.06);cursor:not-allowed;color:var(--text2)"></div>'
        + '        <div class="fg-item"><label>LCV Size (in)</label>'
        + '          <select id="wts_ll_lcv">'
        + '            <option value="1">1"</option>'
        + '            <option value="2">2"</option>'
        + '            <option value="3">3"</option>'
        + '            <option value="4" selected>4"</option>'
        + '            <option value="6">6"</option>'
        + '          </select></div>'
        + '        <div class="fg-item"><label>LCV Type</label>'
        + '          <select id="wts_ll_lcvtype">'
        + '            <option value="full_eq">FULL PORT EQUAL %</option>'
        + '          </select></div>'
        + '      </div>'
        + '    </div>'
        // RO card
        + '    <div class="card"><div class="card-title">Restrictive Orifice</div>'
        + '      <div class="fg">'
        + '        <div class="fg-item"><label>RO Size (64ths in)</label>'
        + '          <input type="number" id="wts_ll_ro_size" value="58" step="1"></div>'
        + '        <div class="fg-item"><label>Tank Max Design (psig)</label>'
        + '          <input type="number" id="wts_ll_tank_p" value="50" step="5"></div>'
        + '        <div class="fg-item"><label>Tank Type</label>'
        + '          <select id="wts_ll_tank_type">'
        + '            <option value="atm" selected>Atmospheric</option>'
        + '            <option value="pressure">Pressure</option>'
        + '          </select></div>'
        + '      </div>'
        + '    </div>'
        + '  </div>'

        + '  <div>'
        // VENT LINE card
        + '    <div class="card"><div class="card-title">Vent Line</div>'
        + '      <div class="fg">'
        + '        <div class="fg-item"><label>NPS (in)</label>'
        + '          <select id="wts_ll_vent_nps">'
        + '            <option value="2">2"</option>'
        + '            <option value="3">3"</option>'
        + '            <option value="4">4"</option>'
        + '            <option value="6" selected>6"</option>'
        + '            <option value="8">8"</option>'
        + '            <option value="10">10"</option>'
        + '            <option value="12">12"</option>'
        + '          </select></div>'
        + '        <div class="fg-item"><label>Schedule</label>'
        + '          <select id="wts_ll_vent_sch">'
        + '            <option value="40" selected>40</option>'
        + '            <option value="80">80</option>'
        + '            <option value="160">160</option>'
        + '          </select></div>'
        + '        <div class="fg-item"><label>Length (ft)</label>'
        + '          <input type="number" id="wts_ll_vent_len" value="100" step="10"></div>'
        + '        <div class="fg-item"><label>Wind Velocity (mph)</label>'
        + '          <input type="number" id="wts_ll_wind" value="20" step="1"></div>'
        + '      </div>'
        + '      <div style="font-size:10px;color:var(--text3,#8b949e);margin-top:6px">'
        +        'Flammability footprint scales with √Q at the vent exit.'
        + '      </div>'
        + '    </div>'
        // Calculate
        + '    <div class="btn-row" style="flex-wrap:wrap">'
        + '      <button class="btn btn-primary" id="wts_ll_calc_btn">▶ Calculate</button>'
        + '    </div>'
        + '    <div id="wts_ll_results" style="margin-top:12px"></div>'
        + '  </div>'
        + '</div>';

        // Wire condition-GOR auto-update
        function _refreshGOR() {
            var q  = _val('wts_ll_q_gas', 25);
            var qo = _val('wts_ll_qoil', 2500);
            var el = _$('wts_ll_gor');
            if (el && qo > 0) {
                el.value = (q * 1e6 / qo).toFixed(0);
            }
        }
        var qg = _$('wts_ll_q_gas'); if (qg) qg.addEventListener('input', _refreshGOR);
        var qo = _$('wts_ll_qoil');  if (qo) qo.addEventListener('input', _refreshGOR);
        _refreshGOR();

        var btn = _$('wts_ll_calc_btn');
        if (btn) btn.onclick = function () { _renderResults(); };

        // First render
        _renderResults();
    }

    function _renderResults() {
        var inputs = {
            sepDesignPressure_psig:    _val('wts_ll_sep_p',  1440),
            oilRate_bpd:               _val('wts_ll_qoil',   2500),
            oilSG:                     _val('wts_ll_sg_oil', 0.85),
            gasSG:                     _val('wts_ll_sg_gas', 0.78),
            gasFlowRate_MMscfd:        _val('wts_ll_q_gas',  25),
            gasTemp_F:                 _val('wts_ll_t_oil',  100),
            lcv_size_in:               _val('wts_ll_lcv',    4),
            ro_size_64ths:             _val('wts_ll_ro_size', 58),
            vent_NPS:                  _val('wts_ll_vent_nps', 6),
            vent_sch:                  _val('wts_ll_vent_sch', 40),
            vent_length_ft:            _val('wts_ll_vent_len', 100),
            tank_design_pressure_psig: _val('wts_ll_tank_p',  50),
            wind_mph:                  _val('wts_ll_wind',    20)
        };
        var r = WTS_liquidline_compute(inputs);

        // Format rows
        var statusBg   = (r.protection_status === 'red')
            ? 'background:#3a1d20;color:#ff7b72;border:1px solid #f85149'
            : 'background:#0e2a17;color:#3fb950;border:1px solid #238636';
        var roLabel = r.ro_required ? 'YES' : 'NO';
        var roPill  = r.ro_required
            ? '<span style="' + statusBg + ';padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">' + roLabel + '</span>'
            : '<span style="background:#0e2a17;color:#3fb950;border:1px solid #238636;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">' + roLabel + '</span>';

        var lcvHi = (r.max_gas_through_lcv_MMscfd > r.vent_max_capacity_MMscfd)
            ? 'color:#ff7b72;font-weight:700' : 'color:#3fb950;font-weight:700';

        var roSize_target = (r.ro_required_size_64ths != null && isFinite(r.ro_required_size_64ths))
            ? r.ro_required_size_64ths.toFixed(1) + '/64"'
            : 'n/a';
        var roSize_inst = isFinite(inputs.ro_size_64ths) && inputs.ro_size_64ths > 0
            ? inputs.ro_size_64ths.toFixed(0) + '/64"'
            : 'n/a';
        var roTPut = (r.ro_max_throughput_MMscfd != null)
            ? r.ro_max_throughput_MMscfd.toFixed(2) + ' MMscfd'
            : 'n/a';
        var roOk = (r.ro_max_throughput_MMscfd != null && r.ro_max_throughput_MMscfd <= r.vent_max_capacity_MMscfd)
            ? '<span style="color:#3fb950;font-weight:700">RO adequate</span>'
            : (r.ro_max_throughput_MMscfd != null
                ? '<span style="color:#ff7b72;font-weight:700">RO undersized</span>'
                : '<span style="color:#8b949e">—</span>');

        var fl = r.flammability;
        var flSvg = ''
            + '<svg viewBox="0 0 280 140" xmlns="http://www.w3.org/2000/svg" '
            +   'style="width:100%;max-width:280px;height:auto;background:#0d1117;'
            +   'border-radius:6px;border:1px solid rgba(88,166,255,0.18)">'
            + '<line x1="40" y1="120" x2="270" y2="120" stroke="#8b949e" stroke-width="0.5"/>'
            + '<line x1="40" y1="120" x2="40"  y2="20"  stroke="#8b949e" stroke-width="0.5"/>'
            // vent stack
            + '<rect x="35" y="100" width="10" height="20" fill="#3fb950"/>'
            // jet shape
            + '<polygon points="45,110 ' + (45 + Math.min(220, fl.x_ft * 4)) + ',' + (120 - Math.min(80, fl.y_ft * 3)) + ' '
            +    (45 + Math.min(220, fl.x_ft * 4)) + ',' + (120 - Math.min(80, fl.y_ft * 3) + 20) + ' 45,118" '
            +    'fill="rgba(248,81,73,0.25)" stroke="#f85149" stroke-width="1"/>'
            + '<text x="60"  y="135" fill="#8b949e" font-size="9">x = '  + fl.x_ft.toFixed(1) + ' ft</text>'
            + '<text x="170" y="40"  fill="#8b949e" font-size="9">y = '  + fl.y_ft.toFixed(1) + ' ft</text>'
            + '<text x="170" y="55"  fill="#8b949e" font-size="9">s = '  + fl.s_ft.toFixed(1) + ' ft</text>'
            + '</svg>';

        var html = ''
        + '<div class="card"><div class="card-title">Results</div>'
        + '<table style="width:100%;font-size:12px;border-collapse:collapse">'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Max Gas Rate Through LCV</td>'
        + '      <td style="padding:4px 6px;text-align:right;' + lcvHi + '">'
        +         r.max_gas_through_lcv_MMscfd.toFixed(2) + ' MMscfd</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Vent Line Max Capacity</td>'
        + '      <td style="padding:4px 6px;text-align:right;color:#3fb950;font-weight:700">'
        +         r.vent_max_capacity_MMscfd.toFixed(2) + ' MMscfd</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">RO Required?</td>'
        + '      <td style="padding:4px 6px;text-align:right">' + roPill + '</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Required RO Bore</td>'
        + '      <td style="padding:4px 6px;text-align:right;font-weight:700">' + roSize_target + '</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Installed RO Bore</td>'
        + '      <td style="padding:4px 6px;text-align:right">' + roSize_inst + '</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Installed RO Throughput</td>'
        + '      <td style="padding:4px 6px;text-align:right">' + roTPut + '</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">RO Adequacy</td>'
        + '      <td style="padding:4px 6px;text-align:right">' + roOk + '</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">P downstream of RO (psig)</td>'
        + '      <td style="padding:4px 6px;text-align:right">' + r.p_downstream_ro_psig.toFixed(0) + '</td></tr>'
        + '</table>'
        + '<div style="margin-top:8px;padding:8px;border-radius:4px;font-size:11px;'
        +   'background:rgba(88,166,255,0.06);border:1px solid rgba(88,166,255,0.18);color:var(--text2,#c9d1d9)">'
        +   r.rationale + '</div>'
        + '</div>'

        + '<div class="card"><div class="card-title">Lean Flammability Footprint</div>'
        + '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">'
        + '  <div style="flex:1;min-width:240px">' + flSvg + '</div>'
        + '  <div style="flex:1;min-width:200px;font-size:12px">'
        + '    <table style="width:100%;border-collapse:collapse">'
        + '      <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Vertical (y)</td>'
        + '          <td style="padding:4px 6px;text-align:right;font-weight:700">' + fl.y_ft.toFixed(1) + ' ft</td></tr>'
        + '      <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Horizontal (x, downwind)</td>'
        + '          <td style="padding:4px 6px;text-align:right;font-weight:700">' + fl.x_ft.toFixed(1) + ' ft</td></tr>'
        + '      <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Axial (s)</td>'
        + '          <td style="padding:4px 6px;text-align:right;font-weight:700">' + fl.s_ft.toFixed(1) + ' ft</td></tr>'
        + '    </table>'
        + '    <div style="margin-top:8px;font-size:10px;color:var(--text3,#8b949e)">'
        + '      Simplified jet-flame envelope scaled by √(Q/25) with wind tilt. '
        + '      Use for screening — confirm with detailed dispersion modelling.'
        + '    </div>'
        + '  </div>'
        + '</div>'
        + '</div>';

        var out = _$('wts_ll_results');
        if (out) out.innerHTML = html;
    }

    // ────────────────────────────────────────────────────────────
    // 4. Public API exposure
    // ────────────────────────────────────────────────────────────

    G.WTS_lcv_blowby           = WTS_lcv_blowby;
    G.WTS_ro_size              = WTS_ro_size;
    G.WTS_ro_flow              = WTS_ro_flow;
    G.WTS_vent_capacity        = WTS_vent_capacity;
    G.WTS_flammability_radii   = WTS_flammability_radii;
    G.WTS_liquidline_compute   = WTS_liquidline_compute;
    G.renderLiquidLine         = renderLiquidLine;

})();

// === SELF-TEST ===
(function () {
    if (typeof window === 'undefined' && typeof global !== 'undefined') {
        // Node smoke-test environment — populate a minimal globalThis.
        // Public API was attached to globalThis above when window is absent.
    }
    var W = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined') ? globalThis : {};

    if (typeof W.WTS_lcv_blowby !== 'function') {
        // Module didn't expose API — silently skip self-test.
        return;
    }

    var checks = [];

    // 4" LCV at 1440 psig with SG=0.78, T=560 °R — significant blowby per the
    // simplified Fisher Cv form Q[SCFD]=1360·Cv·P1·sqrt(1/(SG·T_R)).
    // At Cv=230 the formula yields ≈21.8 MMscfd; range is intentionally wide
    // because production Fisher Cg-form (Cg≈30·Cv) gives larger numbers.
    var Q_lcv = W.WTS_lcv_blowby(230, 1454.7, 0.78, 560);
    checks.push({ n: '4" LCV blowby in expected range', ok: Q_lcv > 5 && Q_lcv < 1000 });

    // RO sized for 25 MMscfd at 1454 psia should be small (< 1.5")
    var ro = W.WTS_ro_size(25, 1454.7, 0.78, 560);
    checks.push({ n: 'RO d_inch < 1.5 and > 0.1', ok: ro.d_inch < 1.5 && ro.d_inch > 0.1 });

    // Vent capacity for 6" SCH40 100ft tank rated 50 psig should be > 0
    var Qv = W.WTS_vent_capacity(6, 40, 100, 50, 0.78, 100);
    checks.push({ n: 'vent capacity > 0',  ok: Qv > 0 });

    // Flammability radii non-zero
    var fl = W.WTS_flammability_radii(25, 20);
    checks.push({ n: 'flammability x_ft > 0', ok: fl.x_ft > 0 });

    // Full compute flow
    var r = W.WTS_liquidline_compute({
        sepDesignPressure_psig: 1440, oilRate_bpd: 2500, oilSG: 0.8,
        gasSG: 0.78, gasFlowRate_MMscfd: 25, gasTemp_F: 100,
        lcv_size_in: 4, ro_size_64ths: 58,
        vent_NPS: 6, vent_sch: 40, vent_length_ft: 100,
        tank_design_pressure_psig: 50, wind_mph: 20
    });
    checks.push({ n: 'compute returns ro_required',          ok: typeof r.ro_required === 'boolean' });
    checks.push({ n: 'compute returns flammability radii',   ok: r.flammability && r.flammability.x_ft > 0 });
    checks.push({ n: 'compute returns rationale string',     ok: typeof r.rationale === 'string' && r.rationale.length > 10 });
    checks.push({ n: 'compute returns protection_status',    ok: r.protection_status === 'green' || r.protection_status === 'red' });

    // RO inverse consistency: WTS_ro_flow at sized bore ≈ target
    var sized = W.WTS_ro_size(10, 1454.7, 0.78, 560);
    var qBack = W.WTS_ro_flow(sized.d_64ths, 1454.7, 0.78, 560);
    checks.push({ n: 'RO size→flow round-trip', ok: Math.abs(qBack - 10) / 10 < 0.01 });

    var fails = checks.filter(function (c) { return !c.ok; });
    if (typeof console !== 'undefined') {
        if (fails.length) {
            console.error('Liquid Line self-test FAILED:', fails);
        } else {
            console.log('✓ Liquid Line self-test passed (' + checks.length + ' checks).');
        }
    }
})();
