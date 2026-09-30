
// ═══════════════════════════════════════════════════════════════════════
// Test System Safety (Round-5 expansion) — auto-injected
//   • 23-esd-hipilot   (gas release during ESD response window)
//   • 24-esd-lopilot   (leak-detection drawdown sizing)
//   • 25-hydrate       (per-segment hydrate temp + inhibitor injection)
//   • 26-liquidline    (gas blowby + RO sizing + flammability radii)
//   • 27-pipelife      (Salama sand-erosion service life per segment)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 23-esd-hipilot ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Layer 23 — ESD Hi-Pilot Analysis
//
// PURPOSE
//   Sizes the high-pressure pilot (PSH) setpoint that protects a section
//   between the wellhead and the flare from over-pressuring during the
//   ESD (Emergency Shutdown) response window.
//
//   A test system is split into sections separated by valves
//   (wellhead → SSV → choke → heater → separator → flare). Each section
//   has a rupture disc / relief valve set at or below MAWP (ASME VIII-1
//   UG-134; 110 % of MAWP is the allowable accumulation) AND a hi-pilot
//   set BELOW the RV that fires the ESD when section pressure rises
//   toward the RV setting. When a downstream block fails or the choke
//   plugs (catastrophic backflow), gas accumulates inside the section.
//   The hi-pilot must trigger ESD soon enough that the section never
//   reaches the RV during the ESD response time (typically 5 sec to
//   close all SSVs).
//
// PUBLIC API (all on window.*)
//
//   window.renderESDHiPilot(body)
//       → paints the ESD Hi-Pilot calculator into a host body element
//
//   window.WTS_esdHiPilot_compute(inputs) → result
//       inputs:  {
//           sectionVolume_ft3,  sectionGasTemp_F,
//           gasFlowRate_MMscfd, gasSG, esdResponseTime_s,
//           hiPilotSetting_psig, rdSetting_psig, mawp_psig
//       }
//       result:  {
//           inventoryAtHiPilot_scf, inventoryAtRD_scf,
//           timeToReachRV_s, gasReleasedToAtmosphere_scf,
//           pass:bool, marginSeconds, rationale,
//           notes, error
//       }
//
//   window.WTS_state.esdHiPilot                 — last result, set on Calc
//   window.WTS_esdHiPilot_LOCATIONS             — preset table reference
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.WTS_* / window.renderESDHiPilot.
//   • No external dependencies — pure vanilla JS, Math.*.
//   • Defensive against missing inputs — returns a result object with
//     `error` populated rather than throwing.
//   • Field units throughout: psi(g), °F, ft, ft³, sec, MMscfd, scf.
//   • Idempotent — render-> change inputs -> Calculate is a no-op the
//     second time you press Calculate with the same inputs (just rewrites
//     the same result panel).
//
// MODEL (screening-grade)
//
//   Section volume V          (ft³, user input or sum of pipe segments)
//   Inventory at pressure P:
//      V_inv(P) = V · (P + 14.7)/14.7 · 519.67/(T_section + 459.67)   [scf]
//      (ideal gas, Z = 1, at the uniform section temperature, referred to
//       the scf standard of 14.7 psia / 60 °F.)
//
//   Time to fill from HiPilot setting up to RD setting at backflow Q:
//      t_fill = [V_inv(RD) − V_inv(HP)] / (Q · 1e6 / 86400)        [s]
//
//   Gas vented to atmosphere through the open RV during ESD response:
//      V_released = Q · 1e6 / 86400 · t_response                   [scf]
//
//   Pass/fail rule:
//      PASS  if  t_fill > t_response
//      FAIL  if  t_fill ≤ t_response
//
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // ───────────────────────────────────────────────────────────────
    // Tiny env / formatting helpers
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
        var d = (dp == null) ? 2 : dp;
        if (Math.abs(v) >= 1e6) return v.toExponential(3);
        return v.toFixed(d);
    }
    function _fmtInt(v) {
        if (!_isNum(v)) return '—';
        return Math.round(v).toLocaleString('en-US');
    }
    // Display in the active unit system (22-units.js). Calcs stay imperial;
    // _u(v, cat, dp, impLabel) formats a canonical value for the screen.
    function _metric() {
        var U = G.WTS_units;
        return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format);
    }
    function _u(v, cat, dp, impLabel, dpMet) {
        if (!_isNum(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, dpMet == null ? dp : dpMet) + ' ' + f.label; }
        return _fmt(v, dp) + ' ' + impLabel;
    }
    function _uInt(v, cat, impLabel) {
        if (!_isNum(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmtInt(f.value) + ' ' + f.label; }
        return _fmtInt(v) + ' ' + impLabel;
    }
    function _ulab(cat, impLabel) { return _metric() ? G.WTS_units.format(0, cat).label : impLabel; }
    // Standard (base) conditions of the scf inventory: the app setting, or
    // this page's own 60 °F / 14.7 psia when the setting is "calculator default".
    function _basis() {
        var B = G.WTS_baseConditions;
        if (B && B.resolve) return B.resolve(60, 14.7);
        return { Tb_F: 60, Tb_R: 519.67, Pb_psia: 14.7, label: '60 °F / 14.7 psia', fromSetting: false };
    }
    function _log() {
        if (typeof console !== 'undefined' && console.log) {
            try { console.log.apply(console, arguments); } catch (e) { /* noop */ }
        }
    }
    function _warn() {
        if (typeof console !== 'undefined' && console.warn) {
            try { console.warn.apply(console, arguments); } catch (e) { /* noop */ }
        }
    }

    // Standard atmospheric reference for scf definition.
    var P_ATM = 14.7; // psia
    var T_STD_R = 519.67; // 60 °F in °R — standard temperature of the scf

    // ───────────────────────────────────────────────────────────────
    // Preset locations (typical CATS workbook values)
    //
    // Each preset only OVERRIDES defaults; user can edit any field
    // afterward in the UI.
    // ───────────────────────────────────────────────────────────────
    var LOCATIONS = {
        choke_us: {
            label: 'Choke US (between SSV and choke)',
            volume_ft3: 0.23,
            temp_F: 23,
            hp_psig: 130,
            rd_psig: 135,
            mawp_psig: 125
        },
        choke_ds: {
            label: 'Choke DS (between choke and heater)',
            volume_ft3: 0.23,
            temp_F: 23,
            hp_psig: 130,
            rd_psig: 135,
            mawp_psig: 125
        },
        heater_tubes: {
            label: 'Heater Tube Bundle',
            volume_ft3: 9.63,
            temp_F: 23,
            hp_psig: 130,
            rd_psig: 135,
            mawp_psig: 125
        },
        heater_shell: {
            label: 'Direct Steam Heater Shell',
            volume_ft3: 292,
            temp_F: 23,
            hp_psig: 130,
            rd_psig: 135,
            mawp_psig: 125
        },
        separator_inlet: {
            label: 'Separator Inlet (gas-phase volume)',
            volume_ft3: 77,
            temp_F: 100,
            hp_psig: 1440,
            rd_psig: 1485,
            mawp_psig: 1440
        },
        custom: {
            label: 'Custom...',
            volume_ft3: 100,
            temp_F: 60,
            hp_psig: 130,
            rd_psig: 135,
            mawp_psig: 125
        }
    };

    // ───────────────────────────────────────────────────────────────
    // Pure compute function — separable for testing + reuse.
    //
    //   Inputs unit-of-measure:
    //     sectionVolume_ft3       ft³
    //     sectionGasTemp_F        °F  (converts section ft³ to scf;
    //                                  60 °F assumed when blank)
    //     gasFlowRate_MMscfd      MMSCFD  (backflow rate)
    //     gasSG                   air = 1 (informational)
    //     esdResponseTime_s       s
    //     hiPilotSetting_psig     psig
    //     rdSetting_psig          psig
    //     mawp_psig               psig
    // ───────────────────────────────────────────────────────────────
    function compute(inputs) {
        var result = {
            inventoryAtHiPilot_scf: NaN,
            inventoryAtRD_scf: NaN,
            timeToReachRV_s: NaN,
            gasReleasedToAtmosphere_scf: NaN,
            pass: false,
            marginSeconds: NaN,
            rationale: '',
            notes: [],
            error: null
        };

        if (!inputs || typeof inputs !== 'object') {
            result.error = 'No inputs supplied.';
            result.rationale = 'Provide section volume, pressures, and ESD response time.';
            return result;
        }

        var V       = +inputs.sectionVolume_ft3;
        var T_F     = +inputs.sectionGasTemp_F;     // °F → scf conversion
        var Q_MMscf = +inputs.gasFlowRate_MMscfd;
        var SG      = +inputs.gasSG;                 // informational
        var tResp   = +inputs.esdResponseTime_s;
        var HP      = +inputs.hiPilotSetting_psig;
        var RD      = +inputs.rdSetting_psig;
        var MAWP    = +inputs.mawp_psig;

        var problems = [];
        if (!_isNum(V)       || V       <= 0) problems.push('Section volume must be > 0 ' + _ulab('volumeFt3', 'ft³') + '.');
        if (!_isNum(Q_MMscf) || Q_MMscf <= 0) problems.push('Gas backflow rate must be > 0 ' + _ulab('gasRate', 'MMSCFD') + '.');
        if (!_isNum(tResp)   || tResp   <= 0) problems.push('ESD response time must be > 0 s.');
        if (!_isNum(HP)) problems.push('Hi-pilot setting required (' + _ulab('pressureG', 'psig') + ').');
        if (!_isNum(RD)) problems.push('Rupture disc / RV setting required (' + _ulab('pressureG', 'psig') + ').');
        if (_isNum(HP) && _isNum(RD) && HP >= RD) {
            problems.push('Hi-pilot must be set BELOW the RV/RD (currently HP ≥ RD).');
        }
        if (problems.length) {
            result.error = problems.join(' ');
            result.rationale = 'Cannot evaluate — inputs incomplete. ' + result.error;
            return result;
        }

        // Inventory model (ideal gas, Z = 1): standard volume of gas held in
        // V ft³ at P psig and T °F, referred to 14.7 psia / 60 °F (the scf
        // definition):  V_inv(P) = V · (P + 14.7)/14.7 · 519.67/(T + 459.67).
        // The temperature ratio was previously omitted, overstating fill time
        // by ~7 % at 100 °F (non-conservative) and understating it when cold.
        // Base conditions: the standard-conditions setting when chosen (the
        // backflow rate is entered on that basis), else 14.7 psia / 60 °F.
        var bc = _basis(), P_STD = bc.Pb_psia;
        var T_use = (_isNum(T_F) && T_F > -459.67) ? T_F : 60;
        var V_std = V * bc.Tb_R / (T_use + 459.67);   // ft³ at section T → scf basis
        var inv_HP = V_std * (HP + P_ATM) / P_STD;
        var inv_RD = V_std * (RD + P_ATM) / P_STD;

        // Backflow in scf/s (1 MMSCFD = 1e6 scf / 86400 s).
        var qScfS = Q_MMscf * 1e6 / 86400;

        // Time to fill from hi-pilot to RV during catastrophic backflow.
        var tFill = (inv_RD - inv_HP) / qScfS;

        // Volume vented to atmosphere through the open RV during the
        // ESD response.
        var Vrel = qScfS * tResp;

        var margin = tFill - tResp;
        var pass = (tFill > tResp);

        result.inventoryAtHiPilot_scf       = inv_HP;
        result.inventoryAtRD_scf            = inv_RD;
        result.timeToReachRV_s              = tFill;
        result.gasReleasedToAtmosphere_scf  = Vrel;
        result.pass                         = pass;
        result.marginSeconds                = margin;
        result.basis                        = bc;

        // Build rationale narrative.
        var rationale = '';
        if (pass) {
            rationale = 'PASS — at the chosen Hi-Pilot of ' + _u(HP, 'pressureG', 0, 'psig') + ', '
                + 'the section reaches the RV setting in ' + tFill.toFixed(2)
                + ' s, leaving a margin of ' + margin.toFixed(2) + ' s above the ESD '
                + 'response time of ' + tResp.toFixed(1) + ' s. '
                + 'Up to ' + _uInt(Vrel, 'gasVolumeStd', 'scf') + ' will vent to '
                + 'atmosphere through the open RV during ESD response.';
        } else {
            // Suggest by how much HP must drop, OR how much tResp must shrink.
            // Solve for HP* such that t_fill_at_HPstar == tResp:
            //   V·(RD+14.7)/14.7 − V·(HPstar+14.7)/14.7 == qScfS · tResp
            //   HPstar = RD − qScfS·tResp·14.7 / V
            var HPstar = RD - (qScfS * tResp * P_STD) / V_std;
            // Also solve for RD* such that t_fill at the existing HP gives tResp:
            var RDstar = HP + (qScfS * tResp * P_STD) / V_std;

            // v3.1: relief set pressure per ASME VIII-1 UG-134(a) / API 520 Part I §5 — a single
            // relief device is set at or below MAWP; 110 % of MAWP is the allowable
            // ACCUMULATION while relieving, not a set pressure (only a supplemental device of a
            // multiple-device installation may be set up to 105 % of MAWP). The old text
            // suggested raising the RV up to MAWP + 10 %, which is non-conservative.
            var hasMawp = _isNum(MAWP) && MAWP > 0;
            var rd_relief = (hasMawp && RD < MAWP - 0.5) ? (' Note also that the RV setting (' + _u(RD, 'pressureG', 0, 'psig')
                + ') is below the section MAWP (' + _u(MAWP, 'pressureG', 0, 'psig')
                + '); raising a single RV up to MAWP is permissible (ASME VIII-1 UG-134).') : '';
            var rdRaise = (!hasMawp || RDstar <= MAWP + 0.5)
                ? ', OR raise the RV to ≥ ' + _u(RDstar, 'pressureG', 0, 'psig') + (hasMawp ? ' (at or below MAWP)' : ' (only if MAWP allows)')
                : ' (raising the RV to ' + _u(RDstar, 'pressureG', 0, 'psig') + ' would put its set pressure above MAWP — not permitted for a single relief device)';

            rationale = 'FAIL — at the chosen Hi-Pilot of ' + _u(HP, 'pressureG', 0, 'psig') + ', '
                + 'the section reaches the RV in only ' + tFill.toFixed(2)
                + ' s, which is shorter than the ' + tResp.toFixed(1) + ' s ESD response. '
                + 'To pass: drop the Hi-Pilot to ≤ ' + _u(Math.max(0, HPstar), 'pressureG', 0, 'psig')
                + rdRaise + ', '
                + 'OR reduce the ESD response time below ' + tFill.toFixed(2) + ' s.'
                + rd_relief;
        }
        result.rationale = rationale;

        // Engineering notes.
        if (_isNum(MAWP) && MAWP > 0 && RD > MAWP * 1.05 + 0.5) {
            result.notes.push('Caution — RV set pressure (' + _u(RD, 'pressureG', 0, 'psig')
                + ') is above 105 % of MAWP (' + _u(MAWP * 1.05, 'pressureG', 0, 'psig')
                + '), the highest set pressure ASME VIII-1 UG-134 allows even for a supplemental device. '
                + 'Set a single RV at or below MAWP (110 % of MAWP is the allowable accumulation while relieving, not a set pressure).');
        } else if (_isNum(MAWP) && MAWP > 0 && RD > MAWP + 0.5) {
            result.notes.push('Caution — RV set pressure (' + _u(RD, 'pressureG', 0, 'psig')
                + ') is above MAWP (' + _u(MAWP, 'pressureG', 0, 'psig')
                + '). ASME VIII-1 UG-134 allows this only for a supplemental device of a multiple-device installation '
                + '(up to 105 % of MAWP); a single relief device must be set at or below MAWP.');
        }
        if (_isNum(HP) && _isNum(MAWP) && HP > MAWP) {
            result.notes.push('Caution — Hi-Pilot setting is ABOVE MAWP. Lower the Hi-Pilot '
                + 'or re-rate the section.');
        }
        if (Math.abs(RD - HP) < 5) {
            result.notes.push('Hi-Pilot is within ' + _u(5, 'pressure', 0, 'psi') + ' of the RV setting; small instrument '
                + 'drift could trigger spurious RV lifts. Increase the gap.');
        }
        if (_isNum(T_F) && T_F < -40) {
            result.notes.push('Section temperature below ' + (_metric() ? '−40 °C' : '−40 °F') + ' — verify metallurgy and PSV trim.');
        }
        if (_isNum(SG) && (SG < 0.55 || SG > 1.20)) {
            result.notes.push('Gas specific gravity ' + SG.toFixed(2)
                + ' is outside 0.55–1.20; the screening assumption '
                + 'ignores SG, but verify with full Z-factor model for atypical gases.');
        }

        return result;
    }
    G.WTS_esdHiPilot_compute = compute;
    G.WTS_esdHiPilot_LOCATIONS = LOCATIONS;

    // ───────────────────────────────────────────────────────────────
    // Helper — read shared WTS_state to pre-fill SG / Q / temp
    // ───────────────────────────────────────────────────────────────
    function _sharedDefaults() {
        var s = (G.WTS_state && typeof G.WTS_state === 'object') ? G.WTS_state : null;
        var out = {};
        if (s) {
            if (_isNum(+s.gasSG))     out.gasSG     = +s.gasSG;
            if (_isNum(+s.gasRate))   out.gasRate   = +s.gasRate;
            if (_isNum(+s.gasTemp_F)) out.gasTemp_F = +s.gasTemp_F;
        }
        return out;
    }

    // ───────────────────────────────────────────────────────────────
    // SVG schematic — wellhead → ESD valve → sand filter → choke
    //   → heater → separator → flare. The selected location is
    //   highlighted in accent colour, with a Hi-Pilot badge.
    //
    //   Returns a complete <svg> string suitable for innerHTML.
    // ───────────────────────────────────────────────────────────────
    function _schematicSVG(activeKey, hpPsig, rdPsig, pass) {
        // 7 stages, evenly spaced.
        var stages = [
            { key: 'wellhead',        label: 'Wellhead' },
            { key: 'choke_us',        label: 'ESD/SSV' },
            { key: 'sand_filter',     label: 'Sand Filter' },
            { key: 'choke_ds',        label: 'Choke' },
            { key: 'heater_shell',    label: 'Heater' },
            { key: 'separator_inlet', label: 'Separator' },
            { key: 'flare',           label: 'Flare' }
        ];
        // Map "heater_tubes" to the heater stage too:
        var activeStage = activeKey;
        if (activeKey === 'heater_tubes') activeStage = 'heater_shell';
        if (activeKey === 'custom')        activeStage = '';

        var W  = 920, H  = 200;
        // pad leaves room for the outer boxes (76 wide) plus the flow arrow
        // beyond the last one — at 40 the arrow was drawn over "Flare".
        var pad = 64;
        var n   = stages.length;
        var step = (W - 2 * pad) / (n - 1);

        var lines = [];
        // Pipe line connecting all stages (runs on to the flow arrow).
        lines.push('<line x1="' + pad + '" y1="100" x2="' + (W - pad + 44) + '" y2="100" '
            + 'stroke="#3d444d" stroke-width="6" stroke-linecap="round"/>');

        // Each stage as a labelled box.
        for (var i = 0; i < n; i++) {
            var cx = pad + i * step;
            var st = stages[i];
            var isActive = (activeStage && st.key === activeStage);
            var fill = isActive ? '#f0883e' : '#21262d';
            var stroke = isActive ? '#d17a2f' : '#3d444d';
            var txtFill = isActive ? '#fff' : '#e6edf3';
            var bw = 76, bh = 36;
            var bx = cx - bw / 2, by = 100 - bh / 2;
            lines.push('<rect x="' + bx + '" y="' + by + '" width="' + bw
                + '" height="' + bh + '" rx="6" fill="' + fill
                + '" stroke="' + stroke + '" stroke-width="2"/>');
            lines.push('<text x="' + cx + '" y="' + (100 + 5)
                + '" font-size="11" font-weight="700" font-family="Segoe UI, sans-serif" '
                + 'text-anchor="middle" fill="' + txtFill + '">' + _esc(st.label) + '</text>');
            // Label below
            lines.push('<text x="' + cx + '" y="' + (100 + bh / 2 + 16)
                + '" font-size="9" fill="#6e7681" text-anchor="middle" '
                + 'font-family="Segoe UI, sans-serif">'
                + _esc(_stageSubLabel(st.key)) + '</text>');
        }

        // Hi-pilot badge floating above the active stage.
        if (activeStage && _isNum(hpPsig)) {
            var idxA = -1;
            for (var k = 0; k < n; k++) if (stages[k].key === activeStage) { idxA = k; break; }
            if (idxA >= 0) {
                var bcx = pad + idxA * step;
                var badgeColor = (pass === true) ? '#3fb950' :
                    (pass === false) ? '#f85149' : '#58a6ff';
                lines.push('<line x1="' + bcx + '" y1="78" x2="' + bcx
                    + '" y2="48" stroke="' + badgeColor + '" stroke-width="2" '
                    + 'stroke-dasharray="3,3"/>');
                var bw2 = 110, bh2 = 36;
                var bx2 = bcx - bw2 / 2, by2 = 12;
                lines.push('<rect x="' + bx2 + '" y="' + by2 + '" width="' + bw2
                    + '" height="' + bh2 + '" rx="6" fill="#0d1117" stroke="' + badgeColor
                    + '" stroke-width="2"/>');
                lines.push('<text x="' + bcx + '" y="28" font-size="9" font-weight="700" '
                    + 'fill="#8b949e" text-anchor="middle" '
                    + 'font-family="Segoe UI, sans-serif" '
                    + 'text-transform="uppercase">Hi-Pilot</text>');
                var hpTxt = _u(hpPsig, 'pressureG', 0, 'psig');
                if (_isNum(rdPsig)) hpTxt += '  /  RV ' + (_metric() ? _fmt(G.WTS_units.format(rdPsig, 'pressureG').value, 0) : rdPsig.toFixed(0));
                lines.push('<text x="' + bcx + '" y="42" font-size="11" font-weight="700" '
                    + 'fill="' + badgeColor + '" text-anchor="middle" '
                    + 'font-family="Courier New, monospace">' + _esc(hpTxt) + '</text>');
            }
        }

        // Flow direction arrow at the right.
        lines.push('<polygon points="' + (W - pad + 42) + ',92 ' + (W - pad + 56) + ',100 '
            + (W - pad + 42) + ',108" fill="#6e7681"/>');

        // Title strip.
        lines.push('<text x="' + (W / 2) + '" y="180" font-size="11" fill="#6e7681" '
            + 'text-anchor="middle" font-family="Segoe UI, sans-serif">'
            + 'Test System Layout — selected section highlighted in orange, '
            + 'Hi-Pilot setpoint shown above</text>');

        return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" '
            + 'style="width:100%;height:auto;display:block">'
            + lines.join('')
            + '</svg>';
    }
    function _stageSubLabel(key) {
        switch (key) {
            case 'wellhead':        return 'WHCV';
            case 'choke_us':        return 'SSV';
            case 'sand_filter':     return 'Filter';
            case 'choke_ds':        return 'Bean';
            case 'heater_shell':    return 'Shell + tubes';
            case 'separator_inlet': return '3-phase sep.';
            case 'flare':           return 'Flare tip';
            default:                return '';
        }
    }

    // ───────────────────────────────────────────────────────────────
    // RENDERER — paints the calculator into the host body element.
    // The SPA's router calls this with body = #pgBody div.
    // ───────────────────────────────────────────────────────────────
    function renderESDHiPilot(body) {
        if (!_hasDoc) return;
        // Guard on the element, not its content — the router clears
        // body.innerHTML to '' before calling us, so a falsy-innerHTML check
        // made this page render blank every time it was opened.
        if (!body || typeof body.innerHTML !== 'string') return;

        // Set page title / sub if the host header exists.
        var pgT = document.getElementById('pgTitle');
        var pgS = document.getElementById('pgSub');
        if (pgT) pgT.textContent = 'ESD Hi-Pilot Analysis';
        if (pgS) pgS.textContent = 'Sizes the hi-pilot setpoint to limit atmospheric gas '
            + 'release during ESD response.';

        var shared = _sharedDefaults();
        var defaultPreset = LOCATIONS.heater_shell;
        var sgDefault    = _isNum(shared.gasSG)     ? shared.gasSG     : 0.78;
        var qDefault     = _isNum(shared.gasRate)   ? shared.gasRate   : 39.28;
        var tempDefault  = _isNum(shared.gasTemp_F) ? shared.gasTemp_F : defaultPreset.temp_F;

        // Build location <option> tags.
        var locKeys = ['choke_us', 'choke_ds', 'heater_tubes', 'heater_shell',
                       'separator_inlet', 'custom'];
        var locOpts = '';
        for (var i = 0; i < locKeys.length; i++) {
            var k = locKeys[i];
            var lbl = LOCATIONS[k].label;
            var sel = (k === 'heater_shell') ? ' selected' : '';
            locOpts += '<option value="' + _esc(k) + '"' + sel + '>' + _esc(lbl) + '</option>';
        }

        body.innerHTML =
            '<div style="display:flex;flex-direction:column;gap:14px">'
          + '  <div class="info-bar">'
          + '    Hi-Pilot (PSH) sizing for ESD protection. Computes the time the section '
          + '    takes to reach the RV setting under catastrophic backflow, and compares '
          + '    that against the ESD response window. Screening calc — assumes ideal gas '
          + '    at constant section temperature.'
          + '  </div>'
          + '  <div class="cols-2">'
          + '    <div>'
          + '      <div class="card">'
          + '        <div class="card-title">Inputs</div>'
          + '        <div class="fg">'
          + '          <div class="fg-item" style="grid-column:1/-1">'
          + '            <label>Pre-set Location</label>'
          + '            <select id="wts_esdhi_loc">' + locOpts + '</select>'
          + '            <span style="font-size:10px;color:var(--text3);margin-top:4px">'
          + '              Picks typical CATS workbook defaults — every field is editable below.'
          + '            </span>'
          + '          </div>'
          + '          <div class="fg-item">'
          + '            <label>Section Volume (ft³)</label>'
          + '            <input type="number" id="wts_esdhi_volume" value="'
          +              defaultPreset.volume_ft3 + '" step="0.01" min="0">'
          + '          </div>'
          + '          <div class="fg-item">'
          + '            <label>Section Gas Temp (°F)</label>'
          + '            <input type="number" id="wts_esdhi_temp" value="'
          +              tempDefault + '" step="1">'
          + '          </div>'
          + '          <div class="fg-item">'
          + '            <label>Gas Backflow Rate (MMscfd)</label>'
          + '            <input type="number" id="wts_esdhi_q" value="'
          +              qDefault + '" step="0.1" min="0">'
          + '          </div>'
          + '          <div class="fg-item">'
          + '            <label>Gas Specific Gravity</label>'
          + '            <input type="number" id="wts_esdhi_sg" value="'
          +              sgDefault + '" step="0.01" min="0.5" max="1.5">'
          + '          </div>'
          + '          <div class="fg-item">'
          + '            <label>Hi-Pilot Setting (psig)</label>'
          + '            <input type="number" id="wts_esdhi_hp" value="'
          +              defaultPreset.hp_psig + '" step="1" min="0">'
          + '          </div>'
          + '          <div class="fg-item">'
          + '            <label>Rupture Disc / RV Setting (psig)</label>'
          + '            <input type="number" id="wts_esdhi_rd" value="'
          +              defaultPreset.rd_psig + '" step="1" min="0">'
          + '          </div>'
          + '          <div class="fg-item">'
          + '            <label>Section MAWP (psig)</label>'
          + '            <input type="number" id="wts_esdhi_mawp" value="'
          +              defaultPreset.mawp_psig + '" step="1" min="0">'
          + '          </div>'
          + '          <div class="fg-item">'
          + '            <label>ESD Response Time (s)</label>'
          + '            <input type="number" id="wts_esdhi_tresp" value="5" '
          +              'step="0.1" min="0.1">'
          + '          </div>'
          + '        </div>'
          + '        <div class="btn-row">'
          + '          <button class="btn btn-primary" id="wts_esdhi_calc">'
          + '            ▶ Calculate'
          + '          </button>'
          + '          <button class="btn btn-secondary" id="wts_esdhi_reset">'
          + '            ↺ Reset to Preset'
          + '          </button>'
          + '        </div>'
          + '      </div>'
          + '    </div>'
          + '    <div>'
          + '      <div class="card">'
          + '        <div class="card-title">Results</div>'
          + '        <div id="wts_esdhi_results">'
          + '          <p style="color:var(--text3);font-size:12px">'
          + '            Press <strong>Calculate</strong> to evaluate the Hi-Pilot setpoint.'
          + '          </p>'
          + '        </div>'
          + '      </div>'
          + '    </div>'
          + '  </div>'
          + '  <div class="card">'
          + '    <div class="card-title">System Layout</div>'
          + '    <div id="wts_esdhi_svg">' + _schematicSVG('heater_shell',
                       defaultPreset.hp_psig, defaultPreset.rd_psig, null) + '</div>'
          + '  </div>'
          + '</div>';

        // ── Wire up location dropdown ──
        var elLoc = document.getElementById('wts_esdhi_loc');
        if (elLoc) {
            elLoc.addEventListener('change', function () {
                _applyPresetToInputs(elLoc.value);
                _redrawSVG();
            });
        }

        // Reset button — re-applies the currently-selected preset.
        var elReset = document.getElementById('wts_esdhi_reset');
        if (elReset) {
            elReset.addEventListener('click', function () {
                var k = elLoc ? elLoc.value : 'heater_shell';
                _applyPresetToInputs(k);
                _redrawSVG();
                var resBox = document.getElementById('wts_esdhi_results');
                if (resBox) {
                    resBox.innerHTML = '<p style="color:var(--text3);font-size:12px">'
                        + 'Press <strong>Calculate</strong> to evaluate the Hi-Pilot setpoint.</p>';
                }
            });
        }

        // Re-draw schematic on relevant input changes.
        var redrawIds = ['wts_esdhi_hp', 'wts_esdhi_rd', 'wts_esdhi_loc'];
        for (var ri = 0; ri < redrawIds.length; ri++) {
            var elR = document.getElementById(redrawIds[ri]);
            if (elR) {
                elR.addEventListener('input', _redrawSVG);
                elR.addEventListener('change', _redrawSVG);
            }
        }

        // Calculate button.
        var elCalc = document.getElementById('wts_esdhi_calc');
        if (elCalc) {
            elCalc.addEventListener('click', _onCalculate);
        }
    }
    G.renderESDHiPilot = renderESDHiPilot;

    // Unit flip / standard-conditions change: repaint in the active system
    // (canonical context → tagged inputs read imperial).
    function _rerun() {
        if (!_hasDoc) return;
        var box = document.getElementById('wts_esdhi_results');
        if (!box) return;
        var U = G.WTS_units;
        var fn = (box.querySelector && box.querySelector('table, .val-error')) ? _onCalculate : _redrawSVG;
        if (U && U.runCanonical) U.runCanonical(fn); else fn();
    }
    if (_hasDoc && typeof document.addEventListener === 'function') {
        document.addEventListener('wts:unit-system-changed', _rerun);
        document.addEventListener('wts:base-conditions-changed', _rerun);
    }


    // ───────────────────────────────────────────────────────────────
    // Helpers — DOM read/write
    // ───────────────────────────────────────────────────────────────
    function _readNum(id) {
        if (!_hasDoc) return NaN;
        var el = document.getElementById(id);
        if (!el) return NaN;
        var v = parseFloat(el.value);
        return isFinite(v) ? v : NaN;
    }
    function _writeNum(id, v) {
        if (!_hasDoc) return;
        var el = document.getElementById(id);
        if (el) el.value = String(v);
    }

    function _applyPresetToInputs(key) {
        var P = LOCATIONS[key];
        if (!P) return;
        _writeNum('wts_esdhi_volume', P.volume_ft3);
        _writeNum('wts_esdhi_temp',   P.temp_F);
        _writeNum('wts_esdhi_hp',     P.hp_psig);
        _writeNum('wts_esdhi_rd',     P.rd_psig);
        _writeNum('wts_esdhi_mawp',   P.mawp_psig);
    }

    function _redrawSVG() {
        if (!_hasDoc) return;
        var elLoc = document.getElementById('wts_esdhi_loc');
        var key   = elLoc ? elLoc.value : 'heater_shell';
        var hp    = _readNum('wts_esdhi_hp');
        var rd    = _readNum('wts_esdhi_rd');
        // Pass status — pull from last calc if any.
        var passNow = (G.WTS_state && G.WTS_state.esdHiPilot)
            ? G.WTS_state.esdHiPilot.pass : null;
        var box = document.getElementById('wts_esdhi_svg');
        if (box) box.innerHTML = _schematicSVG(key, hp, rd, passNow);
    }

    // ───────────────────────────────────────────────────────────────
    // CALCULATE — wire up the compute function to the UI.
    // ───────────────────────────────────────────────────────────────
    function _onCalculate() {
        if (!_hasDoc) return;
        var inputs = {
            sectionVolume_ft3:   _readNum('wts_esdhi_volume'),
            sectionGasTemp_F:    _readNum('wts_esdhi_temp'),
            gasFlowRate_MMscfd:  _readNum('wts_esdhi_q'),
            gasSG:               _readNum('wts_esdhi_sg'),
            esdResponseTime_s:   _readNum('wts_esdhi_tresp'),
            hiPilotSetting_psig: _readNum('wts_esdhi_hp'),
            rdSetting_psig:      _readNum('wts_esdhi_rd'),
            mawp_psig:           _readNum('wts_esdhi_mawp')
        };

        var result = compute(inputs);

        // Persist to shared state.
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.esdHiPilot = result;

        // Render result block.
        var resBox = document.getElementById('wts_esdhi_results');
        if (!resBox) return;
        resBox.innerHTML = _renderResultHTML(inputs, result);
        _redrawSVG();
    }

    function _renderResultHTML(inputs, r) {
        if (r.error) {
            return '<div class="val-error">'
                + '<strong>Cannot compute:</strong> ' + _esc(r.error)
                + '</div>'
                + '<p style="font-size:12px;color:var(--text3);margin-top:8px">'
                + _esc(r.rationale) + '</p>';
        }

        var passColor = r.pass ? '#3fb950' : '#f85149';
        var passBg    = r.pass ? 'rgba(63,185,80,.10)' : 'rgba(248,81,73,.10)';
        var passBdr   = r.pass ? 'rgba(63,185,80,.30)' : 'rgba(248,81,73,.30)';
        var passLabel = r.pass
            ? '✓ PASS — t_fill > t_response by ' + r.marginSeconds.toFixed(2) + ' s'
            : '✗ FAIL — Hi-pilot would NOT prevent overpressure (t_fill = '
                + r.timeToReachRV_s.toFixed(2) + ' s, ESD = '
                + inputs.esdResponseTime_s.toFixed(1) + ' s)';

        var notesHTML = '';
        if (r.notes && r.notes.length) {
            var liItems = '';
            for (var i = 0; i < r.notes.length; i++) {
                liItems += '<li>' + _esc(r.notes[i]) + '</li>';
            }
            notesHTML = '<div style="margin-top:10px;padding:10px 12px;'
                + 'background:rgba(210,153,34,.06);border:1px solid rgba(210,153,34,.20);'
                + 'border-radius:6px;font-size:11px;color:var(--yellow)">'
                + '<strong style="display:block;margin-bottom:4px">Notes</strong>'
                + '<ul style="margin-left:18px;color:var(--text2)">' + liItems + '</ul></div>';
        }

        // Inputs + results table — picked up by host PDF/PNG export.
        var inputsRows = ''
            + '<tr><td>Section Volume</td><td>'
            + _u(inputs.sectionVolume_ft3, 'volumeFt3', 2, 'ft³', 3) + '</td></tr>'
            + '<tr><td>Section Gas Temp</td><td>'
            + _u(inputs.sectionGasTemp_F, 'temperature', 0, '°F', 1) + '</td></tr>'
            + '<tr><td>Gas Backflow Rate</td><td>'
            + _u(inputs.gasFlowRate_MMscfd, 'gasRate', 2, 'MMSCFD', 1) + '</td></tr>'
            + '<tr><td>Gas SG</td><td>' + _fmt(inputs.gasSG, 2) + '</td></tr>'
            + '<tr><td>Hi-Pilot Setting</td><td>'
            + _u(inputs.hiPilotSetting_psig, 'pressureG', 0, 'psig') + '</td></tr>'
            + '<tr><td>RV / RD Setting</td><td>'
            + _u(inputs.rdSetting_psig, 'pressureG', 0, 'psig') + '</td></tr>'
            + '<tr><td>Section MAWP</td><td>'
            + _u(inputs.mawp_psig, 'pressureG', 0, 'psig') + '</td></tr>'
            + '<tr><td>ESD Response Time</td><td>'
            + _fmt(inputs.esdResponseTime_s, 1) + ' s</td></tr>';

        var resultsRows = ''
            + '<tr><td>Inventory @ Hi-Pilot</td><td>'
            + _uInt(r.inventoryAtHiPilot_scf, 'gasVolumeStd', 'scf') + '</td></tr>'
            + '<tr><td>Inventory @ RD/RV</td><td>'
            + _uInt(r.inventoryAtRD_scf, 'gasVolumeStd', 'scf') + '</td></tr>'
            + '<tr><td>Time to reach RV</td><td>'
            + _fmt(r.timeToReachRV_s, 2) + ' s</td></tr>'
            + '<tr><td>Gas released to atmos. during ESD</td><td>'
            + _uInt(r.gasReleasedToAtmosphere_scf, 'gasVolumeStd', 'scf') + '</td></tr>'
            + '<tr><td>Margin (t_fill − t_resp)</td><td>'
            + _fmt(r.marginSeconds, 2) + ' s</td></tr>'
            + '<tr><td>Standard-volume basis</td><td>'
            + _esc(r.basis ? r.basis.label + (r.basis.fromSetting ? ' (app setting)' : ' (calculator default)') : '—') + '</td></tr>';


        return ''
            + '<div style="padding:10px 14px;border-radius:6px;font-weight:700;'
            + 'background:' + passBg + ';border:1px solid ' + passBdr
            + ';color:' + passColor + ';font-size:13px;margin-bottom:12px">'
            + _esc(passLabel)
            + '</div>'
            + '<table class="dtable" style="margin-bottom:10px">'
            + '<thead><tr><th colspan="2">Inputs</th></tr></thead>'
            + '<tbody>' + inputsRows + '</tbody></table>'
            + '<table class="dtable">'
            + '<thead><tr><th colspan="2">Computed Results</th></tr></thead>'
            + '<tbody>' + resultsRows + '</tbody></table>'
            + '<div style="margin-top:12px;padding:10px 12px;'
            + 'background:rgba(88,166,255,.06);border:1px solid rgba(88,166,255,.18);'
            + 'border-radius:6px;font-size:12px;color:var(--text)">'
            + '<strong style="display:block;margin-bottom:4px;color:var(--blue)">Rationale</strong>'
            + _esc(r.rationale)
            + '</div>'
            + notesHTML;
    }

})();

// ─── END 23-esd-hipilot ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 24-esd-lopilot ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Layer 24 — ESD Lo-Pilot (Leak Detection) Analysis
//
// PURPOSE
//   Checks the LOW-pressure pilot (PSL) that fires the Emergency Shut-Down
//   (ESD) valve when a gas leak depressures the section the pilot senses.
//   The PSL set point must sit a false-trip margin below the flowing
//   pressure P_flow (so normal swings do not trip it) and must be crossed by
//   the target leak within the required detection time.
//
// ENGINEERING MODEL  (isothermal ideal gas, single section, v3.0)
//   dP/dt    = (Q_leak·1e6/86400)·Pb/V · T/Tb             [psi/s]
//   ΔP       = dP/dt · t_req                               [psi in t_req]
//   P_after  = P_flow − ΔP                                  [psig]
//   PSL_rec  = P_flow − margin                              [psig]
//   t_trip   = (P_flow − PSL)/(dP/dt)                       [s]
//   PASS  ⇔  PSL ≤ P_flow − margin  ∧  PSL > 0 psig  ∧  t_trip ≤ t_req
//   T = section gas temperature (input, default 60 °F); Pb/Tb = the scf
//   basis of Q_leak. WHSIP is shown for reference only (v1.0-v1.8 failed the
//   case when P_after < WHSIP — true for every flowing well).
//
//   APPROXIMATIONS:
//     • Ideal gas (no Z): the leak's moles are a fixed standard volume.
//     • Constant leak rate; well inflow and downstream outflow held at their
//       pre-leak rates (both change to slow a real drawdown).
//     • Isothermal — small ΔP over a short window.
//
// PUBLIC API (window.*)
//   window.renderESDLoPilot(body)            paints the calculator into body
//   window.WTS_esdLoPilot_compute(inputs)    pure compute → result object
//
// CONVENTIONS (per CLAUDE.md)
//   • Single outer IIFE, 'use strict'.
//   • Public symbols on window.WTS_* / window.renderESDLoPilot.
//   • No external runtime dependencies.
//   • Field units throughout: psig/psia, ft³, sec, MMscfd, scf.
//   • Defensive against missing inputs / DOM elements.
//   • <table class="dtable"> for results so PDF export picks them up.
//
// REFERENCES
//   • API RP 14C (Recommended Practice for Analysis, Design,
//     Installation, and Testing of Basic Surface Safety Systems for
//     Offshore Production Platforms) — PSL sizing guidance.
//   • API RP 521 — Pressure-relieving and depressuring systems.
//
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims so the module can load in node smoke-tests too.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window
                          : (typeof globalThis !== 'undefined' ? globalThis : {});

    // ───────────────────────────────────────────────────────────────
    // Formatting helpers (mirror the look used elsewhere in WTS).
    // ───────────────────────────────────────────────────────────────
    function _isNum(v) { return (typeof v === 'number') && isFinite(v); }
    function _num(id, fallback) {
        if (!_hasDoc) return fallback;
        var el = document.getElementById(id);
        if (!el) return fallback;
        var v = parseFloat(el.value);
        return _isNum(v) ? v : fallback;
    }
    function _val(id, fallback) {
        if (!_hasDoc) return fallback;
        var el = document.getElementById(id);
        return el ? el.value : fallback;
    }
    function _fmt(v, dp) {
        if (!_isNum(v)) return '—';
        var d = (dp == null) ? 2 : dp;
        return Number(v).toFixed(d);
    }
    function _fmtSig(v, sig) {
        if (!_isNum(v)) return '—';
        if (v === 0) return '0';
        sig = sig || 4;
        var a = Math.abs(v);
        if (a >= 1e6 || a < 1e-3) return Number(v).toExponential(sig - 1);
        return Number(v).toPrecision(sig)
                       .replace(/(\.\d*?)0+$/, '$1')
                       .replace(/\.$/, '');
    }
    // Display in the active unit system (22-units.js); calcs stay imperial.
    function _metric() {
        var U = G.WTS_units;
        return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format);
    }
    function _u(v, cat, dp, impLabel, dpMet) {
        if (!_isNum(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, dpMet == null ? dp : dpMet) + ' ' + f.label; }
        return _fmt(v, dp) + ' ' + impLabel;
    }
    function _ulab(cat, impLabel) { return _metric() ? G.WTS_units.format(0, cat).label : impLabel; }
    // Standard pressure of the scf: the standard-conditions setting when one
    // is chosen (the leak rate is entered on that basis), else 14.7 psia.
    function _basis() {
        var B = G.WTS_baseConditions;
        if (B && B.resolve) return B.resolve(60, 14.7);
        return { Tb_F: 60, Tb_R: 519.67, Pb_psia: 14.7, label: '60 °F / 14.7 psia', fromSetting: false };
    }
    function _esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ───────────────────────────────────────────────────────────────
    // Default cases per location.
    // ───────────────────────────────────────────────────────────────
    var DEFAULTS = {
        upstreamHeaterChoke: {
            label: 'Upstream of Heater Choke',
            volume: 662, pflow: 662, whsip: 2100
        },
        downstreamSSV: {
            label: 'Downstream of SSV',
            volume: 4.36, pflow: 1971, whsip: 2100
        },
        upstreamChoke: {
            label: 'Upstream of Choke',
            volume: 2.71, pflow: 1971, whsip: 2100
        },
        custom: {
            label: 'Custom...',
            volume: 100, pflow: 1500, whsip: 2100
        }
    };

    // ───────────────────────────────────────────────────────────────
    // PURE COMPUTE — independent of DOM, used by self-test.
    // ───────────────────────────────────────────────────────────────
    G.WTS_esdLoPilot_compute = function (inputs) {
        inputs = inputs || {};
        var V          = +inputs.sectionVolume_ft3;
        var Pflow      = +inputs.sectionFlowingPressure_psig;
        var Qleak_mmscfd = +inputs.detectableLeakRate_MMscfd;
        var WHSIP      = (inputs.whsip_psig == null || inputs.whsip_psig === '') ? NaN : +inputs.whsip_psig;
        var tresp      = +inputs.esdResponseTime_s;
        var margin     = (inputs.safetyMargin_psig != null && inputs.safetyMargin_psig !== '')
                       ? +inputs.safetyMargin_psig : 5;
        var T_F        = (inputs.sectionTemp_F != null && inputs.sectionTemp_F !== '')
                       ? +inputs.sectionTemp_F : 60;
        var pslIn      = (inputs.pslSetpoint_psig != null && inputs.pslSetpoint_psig !== '' && isFinite(+inputs.pslSetpoint_psig))
                       ? +inputs.pslSetpoint_psig : null;

        // Input validation — report problems instead of silently computing
        // with substitutes (a blank volume used to be replaced by 1 ft³).
        var problems = [];
        if (!_isNum(V) || V <= 0) problems.push('Section volume must be > 0 ' + _ulab('volumeFt3', 'ft³') + '.');
        if (!_isNum(Pflow) || Pflow <= 0) problems.push('Section flowing pressure must be > 0 ' + _ulab('pressureG', 'psig') + '.');
        if (!_isNum(Qleak_mmscfd) || Qleak_mmscfd <= 0) problems.push('Detectable leak rate must be > 0 ' + _ulab('gasRate', 'MMscfd') + '.');
        if (!_isNum(tresp) || tresp <= 0) problems.push('Required detection time must be > 0 s.');
        if (!(T_F > -459.67 && T_F <= 1000)) problems.push('Section temperature must be above absolute zero and no more than ' + _u(1000, 'temperature', 0, '°F') + '.');
        if (!_isNum(margin) || margin < 0) problems.push('False-trip margin must be ≥ 0.');

        // Defensive defaults (keep the numeric outputs finite)
        if (!_isNum(V) || V <= 0)               V = 1;
        if (!_isNum(Pflow))                      Pflow = 0;
        if (!_isNum(Qleak_mmscfd) || Qleak_mmscfd < 0) Qleak_mmscfd = 0;
        if (!_isNum(tresp) || tresp < 0)         tresp = 0;
        if (!_isNum(margin) || margin < 0)       margin = 0;
        if (!(T_F > -459.67 && T_F <= 1000))     T_F = 60;

        // Gas released during the required detection window  (scf)
        var gasReleased_scf = (Qleak_mmscfd * 1e6 / 86400) * tresp;

        // Isothermal ideal-gas mole balance on the section (pV = nRT):
        //   n_leak = Pb·V_std/(R·Tb)   →   ΔP = n_leak·R·T/V = V_std·Pb/V · T/Tb,
        // with T the section gas temperature (input, default 60 °F) and Pb/Tb the
        // standard conditions of the leak rate (14.7 psia / 60 °F, or the
        // standard-conditions setting). On the default basis at 60 °F, T/Tb = 1.
        // The well inflow and the downstream outflow are taken to stay at their
        // pre-leak values, so the section loses gas at the leak rate
        // (dP/dt constant — valid while ΔP is small relative to P_flow).
        var bc = _basis();
        var T_R = T_F + 459.67;
        var rate_psi_s = (Qleak_mmscfd * 1e6 / 86400) * bc.Pb_psia / V * (T_R / bc.Tb_R);
        var dP_psi = rate_psi_s * tresp;

        // Section pressure at the end of the required detection time  (psig)
        var Pafter_psig = Pflow - dP_psi;

        // Trip criterion (v3.0). A PSL detects the leak when the section pressure
        // falls THROUGH its set point, so the set point must lie in the window
        //   P_after ≤ PSL ≤ P_flow − false-trip margin:
        //   • a margin below P_flow, so normal pressure swings do not trip it
        //     (API RP 14C sets PSLs a margin below the lowest operating pressure);
        //   • at or above P_after, so the leak takes the pressure through it
        //     within the required time: t_trip = (P_flow − PSL)/(dP/dt) ≤ t_req;
        //   • above 0 psig — a leak to atmosphere cannot take the section lower.
        // Recommended PSL = P_flow − margin (the highest non-nuisance setting,
        // fastest trip). v1.0-v1.8 recommended P_after − margin — a setting the
        // leak does NOT reach within the window — and failed the case when
        // P_after < WHSIP, which holds for every flowing well (P_flow < WHSIP),
        // so the check essentially never passed. WHSIP is now reference only.
        var psl_rec = Pflow - margin;
        var psl = (pslIn != null) ? pslIn : psl_rec;
        var t_trip_s = rate_psi_s > 0 ? Math.max(Pflow - psl, 0) / rate_psi_s : Infinity;
        var nuisanceOk = psl <= psl_rec + 1e-9;
        var aboveAtm = psl > 0;
        var inTime = t_trip_s <= tresp + 1e-9;
        var pass = nuisanceOk && aboveAtm && inTime && problems.length === 0;
        var lowSensitivity = dP_psi < 2.0;

        var rationale;
        if (!nuisanceOk) {
            rationale = 'The PSL set point (' + _u(psl, 'pressureG', 1, 'psig') + ') is inside the ' + _u(margin, 'pressure', 1, 'psi') +
                ' false-trip margin below the flowing pressure (' + _u(Pflow, 'pressureG', 0, 'psig') + '): normal pressure swings would trip the ESD. ' +
                'Set it at or below ' + _u(psl_rec, 'pressureG', 1, 'psig') + '.';
        } else if (!aboveAtm) {
            rationale = 'A PSL at or below 0 ' + _ulab('pressureG', 'psig') + ' can never trip: a leak to atmosphere cannot take the section below atmospheric pressure.';
        } else if (!inTime) {
            rationale = 'A ' + _u(Qleak_mmscfd, 'gasRate', 2, 'MMscfd', 1) + ' leak depressures the ' + _u(V, 'volumeFt3', 2, 'ft³', 3) +
                ' section by only ' + _u(dP_psi, 'pressure', 2, 'psi') + ' in ' + _fmt(tresp, 1) +
                ' s; it takes ' + _fmt(t_trip_s, 1) + ' s to fall to the PSL. Detect this leak with a smaller trapped volume (a PSL closer to the leak), ' +
                'a smaller false-trip margin (if the operating pressure is steady), a larger detectable leak rate, or rate-of-change detection.';
        } else {
            rationale = 'A ' + _u(Qleak_mmscfd, 'gasRate', 2, 'MMscfd', 1) + ' leak releases ' + _u(gasReleased_scf, 'gasVolumeStd', 0, 'scf', 1) +
                ' in ' + _fmt(tresp, 1) + ' s and depressures the ' + _u(V, 'volumeFt3', 2, 'ft³', 3) + ' section by ' + _u(dP_psi, 'pressure', 1, 'psi') +
                ' (to ' + _u(Pafter_psig, 'pressureG', 1, 'psig') + '). A PSL at ' + _u(psl, 'pressureG', 1, 'psig') + ' trips after ' + _fmt(t_trip_s, 2) +
                ' s, within the required ' + _fmt(tresp, 1) + ' s, and sits ' + _u(Pflow - psl, 'pressure', 1, 'psi') + ' below the flowing pressure.';
        }

        var result = {
            gasReleasedDuringResponse_scf: gasReleased_scf,
            pressureDrop_psi: dP_psi,
            depressurisationRate_psi_s: rate_psi_s,
            psl_target_psig: psl_rec,
            psl_used_psig: psl,
            psl_from_input: pslIn != null,
            timeToTrip_s: t_trip_s,
            leakDrawdownPressure_psig: Pafter_psig,
            sectionTemp_F: T_F,
            whsip_psig: _isNum(WHSIP) ? WHSIP : null,
            nuisanceOk: nuisanceOk, inTime: inTime, aboveAtm: aboveAtm,
            reachable: pass,
            pass: pass,
            lowSensitivity: lowSensitivity,
            rationale: rationale,
            basis: bc,
            error: problems.length ? problems.join(' ') : null
        };

        // Persist into shared state for downstream tools / PDF export.
        if (_hasWin) {
            G.WTS_state = G.WTS_state || {};
            G.WTS_state.esdLoPilot = result;
        }
        return result;
    };

    // ───────────────────────────────────────────────────────────────
    // Schematic SVG. Highlights the selected lo-pilot location.
    //   locationKey ∈ { 'upstreamHeaterChoke', 'downstreamSSV',
    //                   'upstreamChoke', 'custom' }
    // ───────────────────────────────────────────────────────────────
    function _schematicSVG(locationKey) {
        var hL = (locationKey === 'downstreamSSV')      ? 'A'
               : (locationKey === 'upstreamChoke')      ? 'B'
               : (locationKey === 'upstreamHeaterChoke')? 'C'
               : 'X';

        function box(x, y, w, h, label, hi) {
            var fill   = hi ? '#f0883e' : '#21262d';
            var stroke = hi ? '#ffffff' : '#30363d';
            var color  = hi ? '#0d1117' : '#c9d1d9';
            var weight = hi ? 700 : 500;
            return '' +
                '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
                '" rx="4" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.4"/>' +
                '<text x="' + (x + w / 2) + '" y="' + (y + h / 2 + 4) +
                '" fill="' + color + '" font-size="11" font-weight="' + weight +
                '" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif">' +
                _esc(label) + '</text>';
        }
        function pip(x, y, label, hi) {
            // PSL pilot marker, dropped from the line.
            var ringFill   = hi ? '#f0883e' : 'none';
            var ringStroke = hi ? '#ffffff' : '#6e7681';
            var pulse = hi
                ? '<circle cx="' + x + '" cy="' + y + '" r="11" fill="none" ' +
                  'stroke="#f0883e" stroke-width="1" opacity=".45"/>'
                : '';
            var lblColor = hi ? '#f0883e' : '#8b949e';
            return '' +
                '<line x1="' + x + '" y1="' + (y - 18) + '" x2="' + x + '" y2="' + (y - 4) +
                '" stroke="' + (hi ? '#f0883e' : '#6e7681') + '" stroke-width="1.5"/>' +
                pulse +
                '<circle cx="' + x + '" cy="' + y + '" r="6" fill="' + ringFill +
                '" stroke="' + ringStroke + '" stroke-width="1.6"/>' +
                '<text x="' + x + '" y="' + (y + 22) + '" fill="' + lblColor +
                '" font-size="9" font-weight="700" text-anchor="middle" ' +
                'font-family="-apple-system,Segoe UI,sans-serif">' + _esc(label) + '</text>';
        }
        function arrow(x1, y1, x2, y2) {
            return '' +
                '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
                '" stroke="#6e7681" stroke-width="1.4" marker-end="url(#wts_esd_arr)"/>';
        }

        var s = [];
        s.push('<svg viewBox="0 0 700 240" xmlns="http://www.w3.org/2000/svg" ' +
               'style="width:100%;height:auto;display:block;background:#0d1117;' +
               'border-radius:8px;border:1px solid #30363d">');
        s.push('<defs>' +
               '<marker id="wts_esd_arr" viewBox="0 0 10 10" refX="9" refY="5" ' +
               'markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
               '<path d="M0,0 L10,5 L0,10 z" fill="#6e7681"/></marker>' +
               '</defs>');

        // Title
        s.push('<text x="20" y="22" fill="#8b949e" font-size="11" font-weight="700" ' +
               'font-family="-apple-system,Segoe UI,sans-serif" letter-spacing=".5">' +
               'WELLHEAD &#8594; ESD &#8594; SAND FILTER &#8594; CHOKE &#8594; HEATER &#8594; SEPARATOR &#8594; FLARE</text>');

        // Pipeline equipment row
        var y = 110, h = 40;
        var items = [
            { x:  18, w: 70, lbl: 'Wellhead' },
            { x: 100, w: 70, lbl: 'ESD/SSV'  },
            { x: 182, w: 70, lbl: 'Sand Filter' },
            { x: 264, w: 70, lbl: 'Choke'    },
            { x: 346, w: 70, lbl: 'Heater'   },
            { x: 428, w: 70, lbl: 'Separator' },
            { x: 510, w: 70, lbl: 'Flare KO' },
            { x: 592, w: 60, lbl: 'Flare'    }
        ];
        // Connecting line (drawn first)
        s.push('<line x1="88" y1="' + (y + h / 2) + '" x2="592" y2="' + (y + h / 2) +
               '" stroke="#30363d" stroke-width="1.6"/>');

        items.forEach(function (it) { s.push(box(it.x, y, it.w, h, it.lbl, false)); });

        // Lo-pilot pip locations (taps off the pipeline)
        // A — Downstream of SSV  (between SSV and Sand Filter, x ≈ 178)
        s.push(pip(178, y - 4,  'PSL — A', hL === 'A'));
        // B — Upstream of Choke (between Sand Filter and Choke, x ≈ 260)
        s.push(pip(260, y - 4,  'PSL — B', hL === 'B'));
        // C — Upstream of Heater Choke (between Choke and Heater, x ≈ 342)
        s.push(pip(342, y - 4,  'PSL — C', hL === 'C'));

        // Caption
        var capColor = (hL === 'X') ? '#8b949e' : '#f0883e';
        var capText  = (hL === 'A') ? 'Selected: Downstream of SSV (small trapped volume → highest sensitivity)'
                     : (hL === 'B') ? 'Selected: Upstream of Choke (small trapped volume → high sensitivity)'
                     : (hL === 'C') ? 'Selected: Upstream of Heater Choke (large trapped volume → lower sensitivity)'
                     : 'Custom location — enter section parameters manually';
        s.push('<text x="20" y="200" fill="' + capColor +
               '" font-size="11" font-weight="600" ' +
               'font-family="-apple-system,Segoe UI,sans-serif">' +
               _esc(capText) + '</text>');
        s.push('<text x="20" y="220" fill="#6e7681" font-size="10" ' +
               'font-family="-apple-system,Segoe UI,sans-serif">' +
               'Lo-pilot detects depressuring of the trapped section that follows a downstream gas leak.</text>');

        s.push('</svg>');
        return s.join('');
    }

    // ───────────────────────────────────────────────────────────────
    // RENDERER — paints the full calculator into a host body element.
    // ───────────────────────────────────────────────────────────────
    G.renderESDLoPilot = function (body) {
        if (!body) return;
        // Page header text (host app sets these from a slot if present).
        if (_hasDoc) {
            var t  = document.getElementById('pgTitle');
            var sb = document.getElementById('pgSub');
            if (t)  t.textContent  = 'ESD Lo-Pilot (Leak Detection) Analysis';
            if (sb) sb.textContent =
                'Sizes the PSL setpoint that fires ESD on a target detectable leak rate.';
        }

        var d = DEFAULTS.upstreamHeaterChoke;

        body.innerHTML = '' +
            '<div class="cols-2">' +

              // ── LEFT — input form ──
              '<div>' +
                '<div class="card">' +
                  '<div class="card-title">Inputs — Trapped Section &amp; Leak Target</div>' +
                  '<div class="info-bar">A leak depressures the section the lo-pilot senses. The PSL set point must sit a false-trip margin ' +
                    'below the flowing pressure and be reached by the leak within the required detection time.</div>' +

                  '<div class="fg-grid" style="grid-template-columns:1fr;">' +
                    '<div class="fg-item">' +
                      '<label>Lo-Pilot Location</label>' +
                      '<select id="wts_esdlo_location">' +
                        '<option value="upstreamHeaterChoke" selected>Upstream of Heater Choke</option>' +
                        '<option value="downstreamSSV">Downstream of SSV</option>' +
                        '<option value="upstreamChoke">Upstream of Choke</option>' +
                        '<option value="custom">Custom…</option>' +
                      '</select>' +
                    '</div>' +
                  '</div>' +

                  '<div class="fg" style="margin-top:14px;">' +
                    '<div class="fg-item">' +
                      '<label>Section Volume (ft³)</label>' +
                      '<input type="number" id="wts_esdlo_volume" step="0.01" value="' + d.volume + '">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>Section Flowing Pressure (psig)</label>' +
                      '<input type="number" id="wts_esdlo_pflow" step="1" value="' + d.pflow + '">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>Detectable Leak Rate (MMscfd)</label>' +
                      '<input type="number" id="wts_esdlo_qleak" step="0.5" value="25">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>Section Gas Temperature (°F)</label>' +
                      '<input type="number" id="wts_esdlo_temp" step="1" value="60">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>WHSIP (psig, reference)</label>' +
                      '<input type="number" id="wts_esdlo_whsip" step="1" value="' + d.whsip + '">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>Required Detection Time (sec)</label>' +
                      '<input type="number" id="wts_esdlo_tresp" step="0.1" value="5">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>False-Trip Margin below P_flow (psi)</label>' +
                      '<input type="number" id="wts_esdlo_margin" step="1" value="5">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>PSL Set Point to Check (psig, blank = recommended)</label>' +
                      '<input type="number" id="wts_esdlo_psl" step="1" value="" placeholder="blank = P_flow − margin">' +
                    '</div>' +
                  '</div>' +

                  '<div class="btn-row">' +
                    '<button class="btn btn-primary" id="wts_esdlo_calc_btn" type="button">Calculate</button>' +
                    '<button class="btn btn-secondary" id="wts_esdlo_reset_btn" type="button">Reset Defaults</button>' +
                  '</div>' +
                '</div>' +

                // Results card lives under the inputs on narrow viewports
                '<div class="card" id="wts_esdlo_resultcard" style="display:none">' +
                  '<div class="card-title">Results</div>' +
                  '<div id="wts_esdlo_results"></div>' +
                '</div>' +
              '</div>' +

              // ── RIGHT — schematic + status ──
              '<div>' +
                '<div class="card">' +
                  '<div class="card-title">Schematic — Lo-Pilot Location</div>' +
                  '<div id="wts_esdlo_schematic">' + _schematicSVG('upstreamHeaterChoke') + '</div>' +
                '</div>' +
                '<div class="card">' +
                  '<div class="card-title">Status</div>' +
                  '<div id="wts_esdlo_status">' +
                    '<div style="color:#8b949e;font-size:12px;">Press <b>Calculate</b> to size the PSL setpoint for the selected location.</div>' +
                  '</div>' +
                '</div>' +
              '</div>' +

            '</div>';

        // Wire interactivity
        if (!_hasDoc) return;

        function _applyLocationDefaults() {
            var sel = document.getElementById('wts_esdlo_location');
            if (!sel) return;
            var key = sel.value;
            var d2 = DEFAULTS[key] || DEFAULTS.custom;
            // Don't overwrite custom — let user type freely.
            if (key !== 'custom') {
                var v = document.getElementById('wts_esdlo_volume');
                var p = document.getElementById('wts_esdlo_pflow');
                var w = document.getElementById('wts_esdlo_whsip');
                if (v) v.value = d2.volume;
                if (p) p.value = d2.pflow;
                if (w) w.value = d2.whsip;
            }
            var sch = document.getElementById('wts_esdlo_schematic');
            if (sch) sch.innerHTML = _schematicSVG(key);
        }

        var locSel = document.getElementById('wts_esdlo_location');
        if (locSel) locSel.addEventListener('change', _applyLocationDefaults);

        var resetBtn = document.getElementById('wts_esdlo_reset_btn');
        if (resetBtn) resetBtn.addEventListener('click', function () {
            if (locSel) locSel.value = 'upstreamHeaterChoke';
            var ql = document.getElementById('wts_esdlo_qleak');
            var tr = document.getElementById('wts_esdlo_tresp');
            var mg = document.getElementById('wts_esdlo_margin');
            if (ql) ql.value = 25;
            if (tr) tr.value = 5;
            if (mg) mg.value = 5;
            var tt = document.getElementById('wts_esdlo_temp');
            var ps = document.getElementById('wts_esdlo_psl');
            if (tt) tt.value = 60;
            if (ps) ps.value = '';
            _applyLocationDefaults();
            // Hide result card on reset
            var rc = document.getElementById('wts_esdlo_resultcard');
            if (rc) rc.style.display = 'none';
            var st = document.getElementById('wts_esdlo_status');
            if (st) st.innerHTML =
                '<div style="color:#8b949e;font-size:12px;">' +
                'Press <b>Calculate</b> to size the PSL setpoint for the selected location.</div>';
        });

        var calcBtn = document.getElementById('wts_esdlo_calc_btn');
        if (calcBtn) calcBtn.addEventListener('click', _runCalc);
    };

    // ───────────────────────────────────────────────────────────────
    // CALCULATE handler — reads DOM, runs compute, paints results.
    // ───────────────────────────────────────────────────────────────
    function _runCalc() {
        if (!_hasDoc) return;
        var inputs = {
            // Blank required fields → NaN so compute() reports them (no silent defaults).
            sectionVolume_ft3:           _num('wts_esdlo_volume', NaN),
            sectionFlowingPressure_psig: _num('wts_esdlo_pflow',  NaN),
            detectableLeakRate_MMscfd:   _num('wts_esdlo_qleak',  NaN),
            whsip_psig:                  _num('wts_esdlo_whsip',  NaN),
            esdResponseTime_s:           _num('wts_esdlo_tresp',  NaN),
            safetyMargin_psig:           _num('wts_esdlo_margin', 5),
            sectionTemp_F:               _num('wts_esdlo_temp',   60),
            pslSetpoint_psig:            _num('wts_esdlo_psl',    '')
        };

        var r = G.WTS_esdLoPilot_compute(inputs);

        if (r.error) {
            var rcE = document.getElementById('wts_esdlo_resultcard');
            var rdE = document.getElementById('wts_esdlo_results');
            if (rdE) rdE.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong> ' + _esc(r.error) + '</div>';
            if (rcE) rcE.style.display = '';
            var stE = document.getElementById('wts_esdlo_status');
            if (stE) stE.innerHTML = '<div style="color:#8b949e;font-size:12px;">Cannot evaluate — inputs incomplete.</div>';
            return;
        }

        // ── Results table ──
        var td = function (v, dim) {
            return '<td style="text-align:right;font-family:Courier New,monospace;' + (dim ? 'color:#8b949e;' : '') + '">' + v + '</td>';
        };
        var tbl = '' +
            '<table class="dtable">' +
              '<tbody>' +
                '<tr><td>Gas released during detection time</td>' + td(_u(r.gasReleasedDuringResponse_scf, 'gasVolumeStd', 1, 'scf', 2)) + '</tr>' +
                '<tr><td>Pressure drop during detection time</td>' + td(_u(r.pressureDrop_psi, 'pressure', 2, 'psi')) + '</tr>' +
                '<tr><td>Depressurisation rate</td>' + td(_u(r.depressurisationRate_psi_s, 'pressure', 3, 'psi', 3) + '/s') + '</tr>' +
                '<tr><td>Section pressure at end of detection time</td>' + td(_u(r.leakDrawdownPressure_psig, 'pressureG', 1, 'psig')) + '</tr>' +
                '<tr><td>Time to reach PSL</td>' + td(isFinite(r.timeToTrip_s) ? _fmt(r.timeToTrip_s, 2) + ' s' : '—') + '</tr>' +
                '<tr><td>Section gas temperature</td>' + td(_u(r.sectionTemp_F, 'temperature', 0, '°F'), true) + '</tr>' +
                '<tr><td>False-trip margin</td>' + td(_u(inputs.safetyMargin_psig, 'pressure', 0, 'psi'), true) + '</tr>' +
                '<tr><td>WHSIP (reference)</td>' + td(r.whsip_psig == null ? '—' : _u(r.whsip_psig, 'pressureG', 0, 'psig'), true) + '</tr>' +
                '<tr><td>Standard-volume basis</td>' +
                    '<td style="text-align:right;color:#8b949e;">' +
                    _esc(r.basis.label + (r.basis.fromSetting ? ' (app setting)' : ' (calculator default)')) + '</td></tr>' +
              '</tbody>' +
            '</table>' +
            // Headline: PSL target
            '<div class="rbox" style="margin-top:14px;">' +
              '<div class="rbox-title">PSL Setting</div>' +
              '<div class="rrow">' +
                '<span class="rl">Recommended PSL setpoint</span>' +
                '<span class="rv" style="font-size:20px;">' + _u(r.psl_target_psig, 'pressureG', 0, 'psig') + '</span>' +
              '</div>' +
              (r.psl_from_input ?
              '<div class="rrow"><span class="rl">PSL set point checked</span><span class="rv">' + _u(r.psl_used_psig, 'pressureG', 1, 'psig') + '</span></div>' : '') +
              '<div class="rrow">' +
                '<span class="rl">Trip window (reached in time … clear of false trips)</span>' +
                '<span class="rv">' + _u(r.leakDrawdownPressure_psig, 'pressureG', 1, 'psig') + ' … ' + _u(r.psl_target_psig, 'pressureG', 1, 'psig') + '</span>' +
              '</div>' +
              '<div class="rrow">' +
                '<span class="rl">Drawdown from P_flow</span>' +
                '<span class="rv">' + _u(inputs.sectionFlowingPressure_psig - r.psl_used_psig, 'pressure', 1, 'psi') + '</span>' +
              '</div>' +
            '</div>' +
            '<div style="font-size:11px;color:#8b949e;margin-top:8px;line-height:1.5"><b>Notes</b> ' +
              'Ideal-gas mole balance: dP/dt = q<sub>leak</sub>·P<sub>b</sub>·T/(T<sub>b</sub>·V). Pass when the set point is at least the false-trip margin ' +
              'below P_flow, above 0 psig, and reached within the required detection time: (P_flow − PSL)/(dP/dt) ≤ t. ' +
              'Well inflow and choke outflow are held at their pre-leak rates; both rise/fall to slow a real drawdown, so allow margin on the time. ' +
              'v3.0: the check was "drawdown pressure ≥ WHSIP", which a flowing well (P_flow &lt; WHSIP) can never meet, and the old PSL ' +
              '(end-of-window pressure less the margin) was not reached within the window.</div>';

        var rc = document.getElementById('wts_esdlo_resultcard');
        var rd = document.getElementById('wts_esdlo_results');
        if (rd) rd.innerHTML = tbl;
        if (rc) rc.style.display = '';

        // ── Status badge + rationale ──
        var badgeBg, badgeBorder, badgeColor, badgeIcon, badgeText;
        if (!r.pass) {
            badgeBg     = 'rgba(248,81,73,.10)';
            badgeBorder = 'rgba(248,81,73,.45)';
            badgeColor  = '#f85149';
            badgeIcon   = '✗';
            badgeText   = !r.nuisanceOk ? 'FAIL — PSL set point is inside the false-trip margin.'
                        : !r.aboveAtm  ? 'FAIL — PSL at or below atmospheric pressure never trips.'
                        : 'FAIL — the leak takes ' + _fmt(r.timeToTrip_s, 1) + ' s to reach the PSL (required ' + _fmt(inputs.esdResponseTime_s, 1) + ' s).';
        } else if (r.lowSensitivity) {
            badgeBg     = 'rgba(210,153,34,.10)';
            badgeBorder = 'rgba(210,153,34,.45)';
            badgeColor  = '#d29922';
            badgeIcon   = '⚠';
            badgeText   = 'PASS, but the drawdown in the detection time is under ' + _u(2, 'pressure', 0, 'psi') +
                          ' — comparable to gauge noise; confirm the pilot can resolve it.';
        } else {
            badgeBg     = 'rgba(63,185,80,.10)';
            badgeBorder = 'rgba(63,185,80,.45)';
            badgeColor  = '#3fb950';
            badgeIcon   = '✓';
            badgeText   = 'PASS — PSL trips ' + _fmt(r.timeToTrip_s, 2) + ' s after the leak starts (required ' +
                          _fmt(inputs.esdResponseTime_s, 1) + ' s).';
        }

        var statusHTML = '' +
            '<div style="background:' + badgeBg + ';border:1px solid ' + badgeBorder +
            ';border-radius:8px;padding:14px 16px;margin-bottom:14px;">' +
              '<div style="font-size:14px;font-weight:700;color:' + badgeColor +
              ';display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
                '<span style="font-size:16px;">' + badgeIcon + '</span>' +
                '<span>' + _esc(badgeText) + '</span>' +
              '</div>' +
            '</div>' +
            '<div style="font-size:12px;color:#c9d1d9;line-height:1.55;">' +
              _esc(r.rationale) +
            '</div>';

        var st = document.getElementById('wts_esdlo_status');
        if (st) st.innerHTML = statusHTML;
    }

    // ───────────────────────────────────────────────────────────────
    // Module-level export marker so smoke-test can detect this layer.
    // ───────────────────────────────────────────────────────────────
    G.WTS_esdLoPilot_DEFAULTS = DEFAULTS;

    // Unit flip / standard-conditions change: repaint shown results in the
    // active system (canonical context → tagged inputs read imperial).
    function _rerun() {
        if (!_hasDoc) return;
        var rc = document.getElementById('wts_esdlo_resultcard');
        if (!rc || rc.style.display === 'none') return;
        var U = G.WTS_units;
        if (U && U.runCanonical) U.runCanonical(_runCalc); else _runCalc();
    }
    if (_hasDoc && typeof document.addEventListener === 'function') {
        document.addEventListener('wts:unit-system-changed', _rerun);
        document.addEventListener('wts:base-conditions-changed', _rerun);
    }


})();

// ─── END 24-esd-lopilot ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 25-hydrate ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Layer 25 — Hydrate Management
//
// PURPOSE
//   Predicts the first-hydrate-formation temperature at each test-system
//   node and computes the methanol / MEG / DEG / TEG injection rate
//   required to suppress hydrate formation below the operating
//   temperature.
//
//   Two engineering questions answered:
//
//     1. What temperature does hydrate form at this pressure for sweet
//        natural gas of given specific gravity?
//        (T_hyd — first dissociation temperature, no inhibitor)
//
//     2. How much inhibitor is required (mass + volumetric injection
//        rate) to depress T_hyd below the coldest local operating
//        temperature?
//
// PUBLIC API (all on window.*)
//
//   renderHydrateManagement(body)            paints UI into host body
//
//   WTS_hydrate_temp(P_psia, gasSG)          → T_hyd_F
//   WTS_hammerschmidt_depression(W_wt, key)  → ΔT_F
//   WTS_hammerschmidt_invert(dT_F, key)      → W_wt%
//   WTS_hydrate_injection_rate(dT, qw, key)  → { wt_pct_needed,
//                                                inhibitor_lb_hr,
//                                                inhibitor_cc_min,
//                                                allowance_factor,
//                                                total_cc_min }
//   WTS_hydrate_compute(inputs)              → multi-node analysis
//
// ENGINEERING APPROXIMATIONS (documented up-front)
//
//   • T_hyd correlation:    Towler & Mokhatab (2005) fit to the Katz
//                           gas-gravity hydrate chart:
//                             T_hyd_F = 13.47·ln P + 34.27·ln SG
//                                       − 1.675·ln P·ln SG − 20.35
//                           (P psia, SG 0.555-1.0). Sweet gas
//                           screening only. Real-design work should use
//                           a full thermodynamic flash. Acid-gas
//                           components (H2S, CO2) and high N2 are
//                           NOT corrected for.
//
//   • Inhibitor model:      Hammerschmidt formula
//                             ΔT_F = K·W / (M·(100−W))
//                           with empirical (K, M) per inhibitor.
//                           Industry-standard screening; over-
//                           predicts depression beyond ~30 wt%
//                           for MeOH (Nielsen-Bucklin recommended
//                           there).
//
//   • Vapour-phase loss:    +30 % allowance for MeOH (volatile),
//                           +5 % for MEG/DEG/TEG. Engineering rule
//                           of thumb only — a real PVT flash should
//                           be used for tight design.
//
//   • Field units throughout. Gas in MMSCF/d; water in bbl/d; mass
//     in lb/hr; volume in cc/min.
//
// CONVENTIONS
//   - Single outer IIFE, 'use strict'.
//   - All public symbols under window.WTS_* / renderHydrateManagement.
//   - Pure vanilla JS, no external deps.
//   - Defensive against missing inputs (every branch guards).
//   - Self-test stripped at concat time via the SELF-TEST sentinel.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

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

    // ───────────────────────────────────────────────────────────────
    // Inhibitor reference table.
    //
    //   M  — molecular weight (g/mol)
    //   K  — Hammerschmidt constant (°F · wt%)
    //   ρ  — liquid density (lb/gal at ambient)
    //   vapAllow — vapour-phase loss multiplier (1 = no allowance)
    //   label — pretty UI label
    // ───────────────────────────────────────────────────────────────
    var INHIB = {
        methanol: { M:  32, K: 2335, rho: 6.6,  vapAllow: 1.30, label: 'Methanol (MeOH)'  },
        meg:      { M:  62, K: 2700, rho: 9.34, vapAllow: 1.05, label: 'MEG (mono-EG)'    },
        deg:      { M: 106, K: 4000, rho: 9.36, vapAllow: 1.05, label: 'DEG (di-EG)'      },
        teg:      { M: 150, K: 5400, rho: 9.39, vapAllow: 1.05, label: 'TEG (tri-EG)'     }
    };

    function _inhib(key) {
        if (!key) return INHIB.methanol;
        var k = ('' + key).toLowerCase();
        return INHIB[k] || INHIB.methanol;
    }

    // ───────────────────────────────────────────────────────────────
    // Core engineering kernels
    // ───────────────────────────────────────────────────────────────

    // Hydrate dissociation temperature for sweet natural gas.
    //
    //   P in psia, SG in 0.55-0.9 typical
    //   Returns T_hyd in °F (the first temperature at which hydrate
    //   forms at this pressure with no inhibitor in the water phase).
    //
    // Correlation: Towler & Mokhatab (2005) — see body.
    function WTS_hydrate_temp(P_psia, gasSG) {
        var P = (typeof P_psia === 'number' && isFinite(P_psia)) ? P_psia : 0;
        if (P <= 0) P = 1; // guard log domain
        var SG = (typeof gasSG === 'number' && isFinite(gasSG)) ? gasSG : 0.65;
        if (SG < 0.55) SG = 0.55;
        if (SG > 1.00) SG = 1.00;

        // Towler & Mokhatab (Hydrocarbon Processing, 2005), T °F, P psia:
        //   T = 13.47·ln P + 34.27·ln SG − 1.675·ln P·ln SG − 20.35
        // Reproduces the Katz gas-gravity chart (e.g. SG 0.6 @ 1000 psia ≈ 61 °F,
        // SG 0.7 @ 1000 psia ≈ 65 °F). The previous screening fit
        // (5·ln P + 35 − 30·(SG − 0.6)) had the SG trend reversed (heavier gas
        // forms hydrate at HIGHER T) and was ~15-20 °F high below ~300 psia.
        var lnP = Math.log(P), lnG = Math.log(SG);
        var T = 13.47 * lnP + 34.27 * lnG - 1.675 * lnP * lnG - 20.35;
        return T;
    }

    // Hammerschmidt depression: given inhibitor wt% in the LIQUID
    // WATER PHASE, return how many °F the hydrate-formation
    // temperature is depressed.
    //
    //   ΔT_F = K · W_wt% / (M · (100 − W_wt%))
    //
    // K, M from INHIB table. W_wt% MUST be in (0, 100).
    function WTS_hammerschmidt_depression(W_wtPct, inhibitor) {
        var inh = _inhib(inhibitor);
        var W = (typeof W_wtPct === 'number' && isFinite(W_wtPct)) ? W_wtPct : 0;
        if (W <= 0) return 0;
        if (W >= 99.999) W = 99.999;
        var dT = (inh.K * W) / (inh.M * (100 - W));
        return dT;
    }

    // Hammerschmidt INVERSE: given a desired depression in °F, return
    // the wt% inhibitor required in the liquid water phase.
    //
    //   ΔT = K·W / (M·(100−W))
    //   ⇒ W = ΔT · M · 100 / (K + ΔT · M)
    //
    // Returned value is clamped to [0, 80] wt% (above which the
    // formula is unreliable anyway).
    function WTS_hammerschmidt_invert(deltaT_F, inhibitor) {
        var inh = _inhib(inhibitor);
        var dT = (typeof deltaT_F === 'number' && isFinite(deltaT_F)) ? deltaT_F : 0;
        if (dT <= 0) return 0;
        var W = (dT * inh.M * 100) / (inh.K + dT * inh.M);
        if (W < 0)  W = 0;
        if (W > 80) W = 80;
        return W;
    }

    // Required injection rate for a single segment.
    //
    //   deltaT_F     desired depression (T_hyd_no_inhib − T_op + safety)
    //   water_bpd    free-water rate at this segment (bbl/d)
    //   inhibitor    'methanol' | 'meg' | 'deg' | 'teg'
    //
    // Returns:
    //   { wt_pct_needed, inhibitor_lb_hr, inhibitor_cc_min,
    //     allowance_factor, total_cc_min }
    //
    // Mass balance:
    //   m_water       = water_bpd · 350 / 24                   [lb/hr]
    //                  (350 lb/bbl ≈ fresh water)
    //   m_inhib       = m_water · W / (100 − W)                [lb/hr]
    //   V_pure_cc_min = m_inhib · (1 / ρ_lb_gal) · 3785 / 60   [cc/min]
    //   V_total       = V_pure · vapAllow                      [cc/min]
    function WTS_hydrate_injection_rate(deltaT_F, water_rate_bpd, inhibitor) {
        var inh = _inhib(inhibitor);
        var dT = (typeof deltaT_F === 'number' && isFinite(deltaT_F)) ? deltaT_F : 0;
        var qw = (typeof water_rate_bpd === 'number' && isFinite(water_rate_bpd)) ? water_rate_bpd : 0;
        if (dT <= 0 || qw <= 0) {
            return {
                wt_pct_needed:    0,
                inhibitor_lb_hr:  0,
                inhibitor_cc_min: 0,
                allowance_factor: inh.vapAllow,
                total_cc_min:     0
            };
        }
        var W = WTS_hammerschmidt_invert(dT, inhibitor);

        // Free-water mass rate, lb/hr (350 lb/bbl).
        var mWater = qw * 350 / 24;

        // Pure-inhibitor mass rate to give W wt% in water phase, lb/hr.
        var mInhib = (W < 99.999) ? (mWater * W / (100 - W)) : 0;

        // Convert to cc/min:
        //   gal/hr = lb/hr / (lb/gal)
        //   cc/min = gal/hr · 3785.41 / 60
        var ccMin = 0;
        if (inh.rho > 0) {
            ccMin = mInhib * (1 / inh.rho) * 3785.41 / 60;
        }
        var totalCc = ccMin * inh.vapAllow;

        return {
            wt_pct_needed:    W,
            inhibitor_lb_hr:  mInhib,
            inhibitor_cc_min: ccMin,
            allowance_factor: inh.vapAllow,
            total_cc_min:     totalCc
        };
    }

    // ───────────────────────────────────────────────────────────────
    // Multi-node aggregator.
    //
    //   inputs: {
    //     gasFlowRate_MMscfd, waterRate_bpd, gasSG,
    //     inhibitor: 'methanol' | 'meg' | 'deg' | 'teg',
    //     nodes: [
    //       { label, P_upstream_psig, T_upstream_F,
    //         P_downstream_psig, T_downstream_F, T_target_F? }
    //     ]
    //   }
    //
    // For each node we evaluate hydrate risk at the DOWNSTREAM
    // condition (the colder side of any choke / Joule-Thomson drop
    // is always more vulnerable). Risk classification:
    //
    //   green   T_op > T_hyd + 5  (no inhibitor needed)
    //   yellow  T_op within 5 °F of T_hyd (close — inject as a guard)
    //   red     T_op < T_hyd      (hydrate WILL form without inhibitor)
    //
    // Required depression sized to put T_hyd below T_target with a
    // 5 °F safety margin.
    // ───────────────────────────────────────────────────────────────
    function WTS_hydrate_compute(inputs) {
        var inp = inputs || {};
        var gasSG = (typeof inp.gasSG === 'number' && isFinite(inp.gasSG)) ? inp.gasSG : 0.65;
        var qw    = (typeof inp.waterRate_bpd === 'number' && isFinite(inp.waterRate_bpd)) ? inp.waterRate_bpd : 0;
        var inhibKey = inp.inhibitor || 'methanol';
        var nodes = Array.isArray(inp.nodes) ? inp.nodes : [];

        var safety = 5; // °F safety margin

        var out = [];
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i] || {};
            var P_dn_psig = (typeof n.P_downstream_psig === 'number' && isFinite(n.P_downstream_psig))
                ? n.P_downstream_psig
                : (typeof n.P_upstream_psig === 'number' ? n.P_upstream_psig : 0);
            var T_dn = (typeof n.T_downstream_F === 'number' && isFinite(n.T_downstream_F))
                ? n.T_downstream_F
                : (typeof n.T_upstream_F === 'number' ? n.T_upstream_F : 60);

            var P_dn_psia = Math.max(P_dn_psig + 14.696, 14.696);
            var T_target = (typeof n.T_target_F === 'number' && isFinite(n.T_target_F))
                ? n.T_target_F
                : T_dn;

            var T_hyd = WTS_hydrate_temp(P_dn_psia, gasSG);

            // Risk vs operating temperature.
            var risk;
            if (T_dn > T_hyd + safety) risk = 'green';
            else if (T_dn > T_hyd - 0.001) risk = 'yellow';
            else risk = 'red';

            // Required depression: get T_hyd below T_target by safety °F.
            // i.e. the design depressed-T_hyd ≤ T_target − safety
            //      ⇒ ΔT_required = T_hyd − (T_target − safety)
            var depressionRequired = T_hyd - (T_target - safety);
            if (depressionRequired < 0) depressionRequired = 0;

            var inj = WTS_hydrate_injection_rate(depressionRequired, qw, inhibKey);

            var msg;
            if (risk === 'green' && depressionRequired <= 0.001) {
                msg = 'NO INHIBITOR REQUIRED';
            } else if (risk === 'red') {
                msg = 'MORE INHIBITOR HAS TO BE ADDED TO PREVENT HYDRATE FORMATION';
            } else {
                msg = 'Inject ' + inj.total_cc_min.toFixed(1) + ' cc/min at this node';
            }

            out.push({
                label:                  n.label || ('Node ' + (i + 1)),
                P_downstream_psia:      P_dn_psia,
                T_downstream_F:         T_dn,
                T_target_F:             T_target,
                T_hyd_no_inhibitor_F:   T_hyd,
                hydrate_risk:           risk,
                depression_required_F:  depressionRequired,
                wt_pct_needed:          inj.wt_pct_needed,
                injection_rate_cc_min:  inj.total_cc_min,
                inhibitor_lb_hr:        inj.inhibitor_lb_hr,
                allowance_factor:       inj.allowance_factor,
                message:                msg
            });
        }

        // Total injection summary keyed by typical 4-node names if
        // they appear, otherwise by index.
        var summary = {};
        for (var j = 0; j < out.length; j++) {
            var lbl = out[j].label;
            summary[lbl] = { cc_min: out[j].injection_rate_cc_min };
        }

        return {
            nodes:                    out,
            total_injection_summary:  summary,
            inhibitor:                inhibKey,
            gasSG:                    gasSG,
            waterRate_bpd:            qw,
            gasFlowRate_MMscfd:       inp.gasFlowRate_MMscfd
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // UI LAYER — renderHydrateManagement(body)
    // ═══════════════════════════════════════════════════════════════

    // Default 4-segment line-up (matches typical surface test layout).
    var DEFAULT_NODES = [
        { id: 'wh',  label: 'Wellhead → WH Choke',
          P_up: 2000, T_up: 105, P_dn: 2000, T_dn: 105 },
        { id: 'ck',  label: 'WH Choke → Heater Inlet',
          P_up: 2000, T_up: 105, P_dn: 885,  T_dn: 41  },
        { id: 'ho',  label: 'Heater Outlet → Separator',
          P_up: 885,  T_up: 180, P_dn: 426,  T_dn: 100 },
        { id: 'bpv', label: 'Separator BPV',
          P_up: 426,  T_up: 100, P_dn: 197,  T_dn: -13 }
    ];

    // Helper — get a DOM node by id (or null).
    function _byId(id) {
        if (!_hasDoc) return null;
        try { return document.getElementById(id); } catch (e) { return null; }
    }

    // Helper — read a numeric input by id with default.
    function _readNum(id, dflt) {
        var el = _byId(id);
        if (!el) return dflt;
        var v = parseFloat(el.value);
        return (isFinite(v) ? v : dflt);
    }

    // Helper — read a select value or default.
    function _readSel(id, dflt) {
        var el = _byId(id);
        if (!el) return dflt;
        return el.value || dflt;
    }

    // Risk-colour mapping for badge / cell shading.
    function _riskColor(risk) {
        if (risk === 'green')  return 'var(--green)';
        if (risk === 'yellow') return 'var(--yellow)';
        if (risk === 'red')    return 'var(--red)';
        return 'var(--text3)';
    }

    function _riskBg(risk) {
        if (risk === 'green')  return 'rgba(46,160,67,0.12)';
        if (risk === 'yellow') return 'rgba(210,153,34,0.16)';
        if (risk === 'red')    return 'rgba(248,81,73,0.18)';
        return 'rgba(140,150,160,0.10)';
    }

    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        var fixed = Number(v).toFixed(typeof d === 'number' ? d : 1);
        return fixed;
    }

    // Display in the active unit system (22-units.js); calcs stay °F / psig.
    function _metric() {
        var U = G.WTS_units;
        return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format);
    }
    function _uval(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _tl() { return _metric() ? '°C' : '°F'; }
    function _uT(v, d)  { return _fmt(_uval(v, 'temperature'), d) + ' ' + _tl(); }   // temperature
    function _uDT(v, d) { return _fmt(_uval(v, 'tempDelta'), d) + ' ' + _tl(); }     // temperature difference

    // Build one segment card HTML.
    function _segCardHTML(seg, idx) {
        return ''
            + '<div class="card" style="padding:10px 12px;min-width:0">'
            +   '<div class="card-title" style="font-size:12px;letter-spacing:.05em;text-transform:uppercase">'
            +     seg.label
            +   '</div>'
            +   '<div class="fg" style="grid-template-columns:1fr 1fr;gap:6px">'
            +     '<div class="fg-item"><label>Upstream P (psig)</label>'
            +       '<input type="number" id="hy_up_P_'  + idx + '" value="' + seg.P_up + '"></div>'
            +     '<div class="fg-item"><label>Upstream T (&deg;F)</label>'
            +       '<input type="number" id="hy_up_T_'  + idx + '" value="' + seg.T_up + '"></div>'
            +     '<div class="fg-item"><label>Downstream P (psig)</label>'
            +       '<input type="number" id="hy_dn_P_'  + idx + '" value="' + seg.P_dn + '"></div>'
            +     '<div class="fg-item"><label>Downstream T (&deg;F)</label>'
            +       '<input type="number" id="hy_dn_T_'  + idx + '" value="' + seg.T_dn + '"></div>'
            +     '<div class="fg-item" style="grid-column:1 / span 2"><label>Operating-T target (&deg;F)</label>'
            +       '<input type="number" id="hy_tgt_'   + idx + '" value="' + seg.T_dn + '"></div>'
            +   '</div>'
            +   '<div style="margin-top:8px;padding:8px;border-radius:6px;background:rgba(140,150,160,0.06)">'
            +     '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px">'
            +       '<span>T<sub>hyd</sub> (no inhibitor)</span>'
            +       '<span id="hy_thyd_' + idx + '" style="font-weight:700">— ' + _tl() + '</span>'
            +     '</div>'
            +     '<div id="hy_riskBadge_' + idx + '" '
            +          'style="margin-top:6px;padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;text-align:center;'
            +          'background:rgba(140,150,160,0.10);color:var(--text3)">'
            +       'Recompute to see status'
            +     '</div>'
            +   '</div>'
            +   '<div class="fg-item" style="margin-top:8px">'
            +     '<label>Local injection rate (cc/min)</label>'
            +     '<input type="number" id="wts_hydrate_inj_' + idx + '" value="0" step="1" min="0">'
            +   '</div>'
            +   '<div style="margin-top:6px;padding:8px;border-radius:6px;background:rgba(140,150,160,0.06)">'
            +     '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px">'
            +       '<span>T<sub>hyd</sub> WITH inhibitor</span>'
            +       '<span id="hy_thydInj_' + idx + '" style="font-weight:700">— ' + _tl() + '</span>'
            +     '</div>'
            +     '<div id="hy_status_' + idx + '" '
            +          'style="margin-top:6px;padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;text-align:center;'
            +          'background:rgba(140,150,160,0.10);color:var(--text3)">'
            +       '—'
            +     '</div>'
            +   '</div>'
            + '</div>';
    }

    // Paint the page.
    function renderHydrateManagement(body) {
        if (!body) return;
        // Header.
        var t = _byId('pgTitle');  if (t) t.textContent = 'Hydrate Management';
        var s = _byId('pgSub');    if (s) s.textContent = 'Per-segment hydrate-formation check + inhibitor injection rate';

        var instr = ''
            + '<div class="info-bar" style="margin-bottom:10px">'
            +   'For each segment, increase the local injection-rate slider until the depressed hydrate temperature box turns green '
            +   '(hydrate-free). Add safety margin to your required operating depression. '
            +   'Hydrate temperature uses a sweet-gas screening correlation; inhibitor depression uses Hammerschmidt.'
            + '</div>';

        // auto-fit: 4 columns on desktop, 1 column at 375 px (fixed repeat(4)
        // squeezed each segment card to ~78 px on phones).
        var segGrid = '<div class="cols-4" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px">';
        for (var i = 0; i < DEFAULT_NODES.length; i++) {
            segGrid += _segCardHTML(DEFAULT_NODES[i], i);
        }
        segGrid += '</div>';

        var systemCard = ''
            + '<div class="card" style="margin-top:14px">'
            +   '<div class="card-title">System Inputs</div>'
            +   '<div class="fg">'
            +     '<div class="fg-item"><label>Inhibitor</label>'
            +       '<select id="wts_hydrate_inhib">'
            +         '<option value="methanol" selected>Methanol (MeOH)</option>'
            +         '<option value="meg">MEG (mono-ethylene glycol)</option>'
            +         '<option value="deg">DEG (di-ethylene glycol)</option>'
            +         '<option value="teg">TEG (tri-ethylene glycol)</option>'
            +       '</select></div>'
            +     '<div class="fg-item"><label>Gas flow rate (MMSCF/d)</label>'
            +       '<input type="number" id="wts_hydrate_q" value="25" step="0.1"></div>'
            +     '<div class="fg-item"><label>Free-water rate (bbl/d)</label>'
            +       '<input type="number" id="wts_hydrate_qw" value="400" step="1"></div>'
            +     '<div class="fg-item"><label>Gas SG</label>'
            +       '<input type="number" id="wts_hydrate_sg" value="0.78" step="0.01"></div>'
            +     '<div class="fg-item"><label>Safety margin (&deg;F)</label>'
            +       '<input type="number" id="wts_hydrate_safety" value="5" step="1"></div>'
            +   '</div>'
            +   '<div class="btn-row"><button class="btn btn-primary" id="wts_hydrate_run">Recompute all nodes</button></div>'
            + '</div>';

        var summaryCard = ''
            + '<div class="card" style="margin-top:14px">'
            +   '<div class="card-title">Inhibitor Injection Summary</div>'
            +   '<div id="wts_hydrate_summary"><div style="opacity:.7;font-size:12px">Click <b>Recompute all nodes</b> to compute required injection at each segment.</div></div>'
            + '</div>';

        body.innerHTML = instr + segGrid + systemCard + summaryCard;

        // Wire compute button.
        var btn = _byId('wts_hydrate_run');
        if (btn) {
            btn.onclick = function () { _runHydrateUI(); };
        }

        // Wire local injection sliders to refresh JUST their card on
        // change (without re-running the full compute).
        for (var k = 0; k < DEFAULT_NODES.length; k++) {
            (function (idx) {
                var injEl = _byId('wts_hydrate_inj_' + idx);
                if (injEl) {
                    injEl.addEventListener('input',  function () { _refreshSegmentLocal(idx); });
                    injEl.addEventListener('change', function () { _refreshSegmentLocal(idx); });
                }
            })(k);
        }

        // Auto-run once so the cards aren't blank.
        try { _runHydrateUI(); } catch (e) {}
    }

    // Pull DOM state for one segment.
    function _readSegment(idx) {
        var seg = DEFAULT_NODES[idx];
        return {
            label:              seg.label,
            P_upstream_psig:    _readNum('hy_up_P_'  + idx, seg.P_up),
            T_upstream_F:       _readNum('hy_up_T_'  + idx, seg.T_up),
            P_downstream_psig:  _readNum('hy_dn_P_'  + idx, seg.P_dn),
            T_downstream_F:     _readNum('hy_dn_T_'  + idx, seg.T_dn),
            T_target_F:         _readNum('hy_tgt_'   + idx, seg.T_dn),
            local_inj_cc_min:   _readNum('wts_hydrate_inj_' + idx, 0)
        };
    }

    // Update the WITH-inhibitor box for ONE segment using the local
    // slider value (without re-running every segment).
    function _refreshSegmentLocal(idx) {
        if (!_hasDoc) return;
        var seg = _readSegment(idx);
        var inhibKey = _readSel('wts_hydrate_inhib', 'methanol');
        var qw       = _readNum('wts_hydrate_qw',  0);
        var gasSG    = _readNum('wts_hydrate_sg',  0.65);

        var P_dn_psia = Math.max(seg.P_downstream_psig + 14.696, 14.696);
        var T_hyd     = WTS_hydrate_temp(P_dn_psia, gasSG);

        // Convert local cc/min back to wt% achieved in the water phase.
        var W_eff = _ccmin_to_wtPct(seg.local_inj_cc_min, qw, inhibKey);
        var dT    = WTS_hammerschmidt_depression(W_eff, inhibKey);
        var T_hyd_inj = T_hyd - dT;

        // Risk relative to operating downstream T.
        var depressed_risk;
        if (seg.T_downstream_F > T_hyd_inj + 5)         depressed_risk = 'green';
        else if (seg.T_downstream_F > T_hyd_inj - 0.001) depressed_risk = 'yellow';
        else                                              depressed_risk = 'red';

        var injBox    = _byId('hy_thydInj_' + idx);
        var statusBox = _byId('hy_status_'  + idx);
        if (injBox)    injBox.textContent = _uT(T_hyd_inj, 1);
        if (statusBox) {
            statusBox.style.background = _riskBg(depressed_risk);
            statusBox.style.color      = _riskColor(depressed_risk);
            if (depressed_risk === 'green') {
                statusBox.textContent = 'NO INHIBITOR SHORTFALL';
            } else if (depressed_risk === 'yellow') {
                statusBox.textContent = 'MARGINAL — within ' + _uDT(5, _metric() ? 1 : 0);
            } else {
                statusBox.textContent = 'MORE INHIBITOR HAS TO BE ADDED';
            }
        }
    }

    // Inverse of WTS_hydrate_injection_rate: given a cc/min injection
    // rate and the water rate, what wt% is achieved in the water phase
    // (after dividing out the vapour-phase allowance)?
    function _ccmin_to_wtPct(ccMin, water_bpd, inhibitor) {
        var inh = _inhib(inhibitor);
        if (!(ccMin > 0) || !(water_bpd > 0) || !(inh.rho > 0)) return 0;

        // Total cc/min injected is split: (1/vapAllow) goes to water
        // phase, the rest is lost to vapour. We convert to lb/hr of
        // pure inhibitor reaching water:
        //   gal/hr  = ccMin · 60 / 3785.41
        //   lb/hr   = gal/hr · ρ
        //   m_water = water_bpd · 350 / 24
        //   W       = 100 · m_inhib / (m_inhib + m_water)
        var ccMinToWater = ccMin / inh.vapAllow;
        var galHr = ccMinToWater * 60 / 3785.41;
        var lbHr  = galHr * inh.rho;
        var mW    = water_bpd * 350 / 24;
        if (mW <= 0) return 0;
        var W = 100 * lbHr / (lbHr + mW);
        if (W < 0)  W = 0;
        if (W > 99.9) W = 99.9;
        return W;
    }

    // Full recompute: read all inputs, run WTS_hydrate_compute, paint.
    function _runHydrateUI() {
        if (!_hasDoc) return;

        var inhibKey = _readSel('wts_hydrate_inhib', 'methanol');
        var qg       = _readNum('wts_hydrate_q',   0);
        var qw       = _readNum('wts_hydrate_qw',  0);
        var gasSG    = _readNum('wts_hydrate_sg',  0.65);
        var safety   = _readNum('wts_hydrate_safety', 5);

        // Build node list.
        var nodes = [];
        for (var i = 0; i < DEFAULT_NODES.length; i++) {
            nodes.push(_readSegment(i));
        }

        // Compute (using the canonical kernel, then re-evaluate locally
        // for safety-margin override).
        var results = WTS_hydrate_compute({
            gasFlowRate_MMscfd: qg,
            waterRate_bpd:      qw,
            gasSG:              gasSG,
            inhibitor:          inhibKey,
            nodes: nodes.map(function (n) {
                return {
                    label:             n.label,
                    P_upstream_psig:   n.P_upstream_psig,
                    T_upstream_F:      n.T_upstream_F,
                    P_downstream_psig: n.P_downstream_psig,
                    T_downstream_F:    n.T_downstream_F,
                    T_target_F:        n.T_target_F
                };
            })
        });

        // Re-apply user safety margin (override default-5).
        if (safety !== 5) {
            for (var ri = 0; ri < results.nodes.length; ri++) {
                var rn = results.nodes[ri];
                rn.depression_required_F = rn.T_hyd_no_inhibitor_F - (rn.T_target_F - safety);
                if (rn.depression_required_F < 0) rn.depression_required_F = 0;
                var inj2 = WTS_hydrate_injection_rate(rn.depression_required_F, qw, inhibKey);
                rn.wt_pct_needed         = inj2.wt_pct_needed;
                rn.injection_rate_cc_min = inj2.total_cc_min;
                rn.inhibitor_lb_hr       = inj2.inhibitor_lb_hr;
                rn.allowance_factor      = inj2.allowance_factor;
            }
        }

        // Paint each card top-half (T_hyd, risk badge) and recommended
        // injection rate. Snap the slider to the recommended value if
        // user has not yet typed a non-zero value.
        for (var c = 0; c < results.nodes.length; c++) {
            var nd = results.nodes[c];
            var thydEl  = _byId('hy_thyd_'  + c);
            var badgeEl = _byId('hy_riskBadge_' + c);
            var injEl   = _byId('wts_hydrate_inj_' + c);

            if (thydEl)  thydEl.textContent = _uT(nd.T_hyd_no_inhibitor_F, 1);
            if (badgeEl) {
                badgeEl.style.background = _riskBg(nd.hydrate_risk);
                badgeEl.style.color      = _riskColor(nd.hydrate_risk);
                if (nd.hydrate_risk === 'green') {
                    badgeEl.textContent = 'NO HYDRATE RISK (T_op > T_hyd + ' + _uDT(5, _metric() ? 1 : 0).replace(' ', '') + ')';
                } else if (nd.hydrate_risk === 'yellow') {
                    badgeEl.textContent = 'MARGINAL — within ' + _uDT(5, _metric() ? 1 : 0) + ' of hydrate locus';
                } else {
                    badgeEl.textContent = 'HYDRATE RISK — T_op below T_hyd';
                }
            }
            // Snap the injection slider to the recommended cc/min if
            // user has it at zero (don't clobber user-entered values).
            if (injEl) {
                var current = parseFloat(injEl.value);
                if (!isFinite(current) || current <= 0) {
                    injEl.value = nd.injection_rate_cc_min.toFixed(1);
                }
            }
            // Re-evaluate the WITH-inhibitor box from current slider
            // value (which may now equal the recommendation).
            _refreshSegmentLocal(c);
        }

        // Paint the summary card.
        var sumEl = _byId('wts_hydrate_summary');
        if (sumEl) {
            var totalCcMin = 0;
            var rows = '';
            for (var k = 0; k < results.nodes.length; k++) {
                var rn2 = results.nodes[k];
                var local = _readNum('wts_hydrate_inj_' + k, 0);
                totalCcMin += local;
                rows += ''
                    + '<tr>'
                    +   '<td style="font-weight:600">' + rn2.label + '</td>'
                    +   '<td>' + _fmt(_uval(rn2.T_hyd_no_inhibitor_F, 'temperature'), 1) + '</td>'
                    +   '<td>' + _fmt(_uval(rn2.T_downstream_F, 'temperature'), 1)       + '</td>'
                    +   '<td>' + _fmt(_uval(rn2.depression_required_F, 'tempDelta'), 1) + '</td>'
                    +   '<td>' + _fmt(rn2.wt_pct_needed, 1)         + '</td>'
                    +   '<td>' + _fmt(rn2.injection_rate_cc_min, 1) + '</td>'
                    +   '<td>' + _fmt(local, 1)                     + '</td>'
                    +   '<td style="color:' + _riskColor(rn2.hydrate_risk) + ';font-weight:600">' + rn2.hydrate_risk.toUpperCase() + '</td>'
                    + '</tr>';
            }
            var tableHTML = ''
                + '<table class="dtable" style="font-size:11px">'
                +   '<tr><th>Segment</th><th>T<sub>hyd</sub> (' + _tl() + ')</th><th>T<sub>op</sub> (' + _tl() + ')</th>'
                +       '<th>&Delta;T req (' + _tl() + ')</th><th>wt% needed</th>'
                +       '<th>Recommended (cc/min)</th><th>Currently set (cc/min)</th><th>Risk</th></tr>'
                +   rows
                + '</table>'
                + '<div style="margin-top:10px;padding:8px;border-radius:6px;background:rgba(56,139,253,0.08);font-size:12px">'
                +   '<b>Total currently set:</b> ' + _fmt(totalCcMin, 1) + ' cc/min '
                +   '(' + INHIB[inhibKey].label + ', incl. ' + _fmt((INHIB[inhibKey].vapAllow - 1) * 100, 0) + '% vapour-phase allowance)'
                + '</div>'
                + '<div style="margin-top:6px;font-size:11px;opacity:0.75">'
                +   'Recommended rates target a ' + _uDT(5, _metric() ? 1 : 0) + ' (or user-set) safety margin below the hydrate locus. '
                +   'Inject upstream of the coldest point in each pipework segment. '
                +   'For multi-stage cooling (choke + JT separator), the largest single recommendation generally '
                +   'protects the entire downstream system.'
                + '</div>';
            sumEl.innerHTML = tableHTML;
        }
    }

    // ───────────────────────────────────────────────────────────────
    // Publish API on window
    // ───────────────────────────────────────────────────────────────
    G.WTS_hydrate_temp              = WTS_hydrate_temp;
    G.WTS_hammerschmidt_depression  = WTS_hammerschmidt_depression;
    G.WTS_hammerschmidt_invert      = WTS_hammerschmidt_invert;
    G.WTS_hydrate_injection_rate    = WTS_hydrate_injection_rate;
    G.WTS_hydrate_compute           = WTS_hydrate_compute;
    G.renderHydrateManagement       = renderHydrateManagement;

    // Unit flip / standard-conditions change: repaint the node cards and the
    // summary in the active system (canonical context → inputs read °F / psig).
    if (_hasDoc && typeof document.addEventListener === 'function') {
        document.addEventListener('wts:unit-system-changed', function () {
            if (!_byId('wts_hydrate_summary') || !_byId('wts_hydrate_run')) return;
            var U = G.WTS_units;
            if (U && U.runCanonical) U.runCanonical(_runHydrateUI); else _runHydrateUI();
        });
    }

})();

// ─── END 25-hydrate ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 26-liquidline ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
//       Q [SCFH] = 816·Cv·P1 / sqrt(SG·T_R)   (critical-flow Cv form)
//     adequate for screening at critical pressure ratio (~0.5).
//   • RO sizing assumes critical flow:
//       Q [MMscfd] = 1.12e-4·d²·P1 / sqrt(SG·T_R)   d in 64ths (Cd = 1)
//   • Vent capacity is a simplified incompressible-equivalent
//       Crane TP-410 w = 0.525·Y·d²·sqrt(ΔP·ρ1/K), K = f_T·L/D + 1.5,
//     Y and the sonic ΔP/P1 limit from Crane Fig. A-22 (k = 1.3).
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

    // Choked (critical) flow of an ideal gas through a round bore of d/64 in,
    // discharge coefficient 1 (ideal nozzle — an upper bound on RO throughput,
    // hence conservative for tank protection). API 520 Eq. 2 with Kd = 1:
    //   W [lb/h] = C·A·P1·sqrt(M/T),  C = 520·sqrt(k·(2/(k+1))^((k+1)/(k−1)))
    //   Q [scf/d] = 24·379.49·W/M,    M = 28.9647·SG,  k = 1.27 (natural gas)
    // → Q [MMscfd] = RO_K · d² · P1 / sqrt(SG·T_R),  RO_K ≈ 1.12e-4.
    // (The old constant 1.875e-4 implied a discharge coefficient of ~1.7.)
    var RO_K = (function () {
        var k = 1.27;
        var C = 520 * Math.sqrt(k * Math.pow(2 / (k + 1), (k + 1) / (k - 1)));
        var A_per_d2 = Math.PI / 4 / (64 * 64);          // in² per (64ths)²
        return 24 * 379.49 * C * A_per_d2 / Math.sqrt(28.9647) * 1e-6;
    })();

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
     *   Q [SCFH] = 816·Cv·P1 / sqrt(SG·T_R)
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
        // Critical-flow Cv gas equation (P2 ≤ ~0.5·P1):
        //   Q [SCFH] = 816·Cv·P1 / sqrt(SG·T_R)
        // (equivalently ISA 1360·Cv·P1·Y·sqrt(x/(G·T)) with Y = 0.667,
        // x = xT ≈ 0.72). The old code used 1360·Cv·P1/sqrt(SG·T) as SCF/DAY,
        // understating blowby ~14×.
        var Q_scfh = 816 * Cv * P1_psia / Math.sqrt(gasSG * T_R);
        return Q_scfh * 24 * 1e-6; // MMscfd
    }

    /**
     * Restrictive Orifice sizing — find bore diameter that passes Q_target
     * at choked flow.
     *
     *   Q [MMscfd] = RO_K · d² · P1 / sqrt(SG·T_R)    (d in 64ths, RO_K ≈ 1.12e-4)
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
        var d_sq = Q_target_MMscfd * Math.sqrt(gasSG * T_R) / (RO_K * P1_psia);
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
        return RO_K * d_64ths * d_64ths * P1_psia / Math.sqrt(gasSG * T_R);
    }

    /**
     * Vent line max allowable capacity — simplified screening.
     *
     *   Crane TP-410: w = 0.525·Y·d²·sqrt(ΔP·ρ1/K)  (see body)
     *
     * with ΔP = tank rating (psig) to atmosphere, ρ1 at tank conditions.
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

        // Crane TP-410 compressible discharge through a line to atmosphere
        // (Eq. 3-20 with Fig. A-22 net expansion factor, k ≈ 1.3):
        //   w [lb/s] = 0.525 · Y · d² · sqrt(ΔP · ρ1 / K)
        //   K = f_T·L/D + 0.5 (entrance) + 1.0 (exit),  f_T fully-turbulent
        //   Darcy factor for commercial steel (ε = 0.0018 in).
        //   ΔP/P1 is capped at the sonic limit for that K (choked line).
        // Replaces the earlier ad-hoc form (K = 0.6 × 1.10 "margin", density at
        // mean pressure, 5 %/100 ft length penalty), which over-predicted
        // capacity ~1.7× for the default 6" × 100 ft line — non-conservative.
        var ID_in = _pipeID(line_NPS, line_sch || 40);
        var L_ft  = (isFinite(line_length_ft) && line_length_ft > 0) ? Number(line_length_ft) : 0;
        var T_R   = (isFinite(T_F) ? T_F : 100) + 459.67;
        var MW    = gasSG * 28.9647;
        var P1    = tank_max_psig + 14.7;                 // tank at its rating, psia
        var rho1  = P1 * MW / (10.732 * T_R);             // lb/ft³ at tank
        if (!(rho1 > 0)) return 0;

        var relRough = 0.0018 / (3.7 * ID_in);
        var fT = 0.25 / Math.pow(Math.log10(relRough), 2);
        var K  = fT * L_ft / (ID_in / 12) + 1.5;

        // Crane A-22 limiting ΔP/P1 and Y at sonic velocity, k = 1.3.
        var KT = [1.2, 1.5, 2, 3, 4, 6, 8, 10, 15, 20, 40, 100];
        var XT = [0.525, 0.550, 0.593, 0.642, 0.678, 0.722, 0.750, 0.773, 0.807, 0.831, 0.877, 0.920];
        var YT = [0.612, 0.631, 0.635, 0.658, 0.670, 0.685, 0.698, 0.705, 0.718, 0.718, 0.718, 0.718];
        var xLim, yLim;
        if (K <= KT[0]) { xLim = XT[0]; yLim = YT[0]; }
        else if (K >= KT[KT.length - 1]) { xLim = XT[XT.length - 1]; yLim = YT[YT.length - 1]; }
        else {
            for (var i = 0; i < KT.length - 1; i++) {
                if (K >= KT[i] && K <= KT[i + 1]) {
                    var fr = (Math.log(K) - Math.log(KT[i])) / (Math.log(KT[i + 1]) - Math.log(KT[i]));
                    xLim = XT[i] + fr * (XT[i + 1] - XT[i]);
                    yLim = YT[i] + fr * (YT[i + 1] - YT[i]);
                    break;
                }
            }
        }
        var x = tank_max_psig / P1;
        var Y;
        if (x >= xLim) { x = xLim; Y = yLim; }
        else Y = 1 - (1 - yLim) * x / xLim;                // Fig. A-22 lines ≈ straight
        var dP = x * P1;

        var w_lbs = 0.525 * Y * ID_in * ID_in * Math.sqrt(dP * rho1 / K);
        return w_lbs * 86400 / MW * 379.49 * 1e-6;         // MMscfd (60 °F, 14.696 psia)
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
        var q_ = function (v) { return _u(v, 'gasRate', 2, 'MMscfd', 1); };
        if (Q_lcv <= Q_vent) {
            rationale = 'LCV blowby (' + q_(Q_lcv) +
                ') is below vent capacity (' + q_(Q_vent) +
                '). No RO required for tank protection.';
        } else if (isFinite(Q_ro_installed) && Q_ro_installed <= Q_vent) {
            rationale = 'LCV blowby (' + q_(Q_lcv) +
                ') exceeds vent capacity but the installed ' +
                ro_size_64.toFixed(0) + '/64" RO throttles flow to ' +
                q_(Q_ro_installed) + ', below the ' +
                q_(Q_vent) + ' vent limit. Adequate.';
        } else if (isFinite(Q_ro_installed) && Q_ro_installed > Q_vent) {
            protection_status = 'red';
            rationale = 'RO is undersized: ' + ro_size_64.toFixed(0) +
                '/64" passes ' + q_(Q_ro_installed) +
                ' > vent ' + q_(Q_vent) +
                '. Reduce RO bore to ≈ ' +
                (isFinite(ro_target_size) ? ro_target_size.toFixed(1) : '?') +
                '/64".';
        } else {
            protection_status = 'red';
            rationale = 'LCV blowby (' + q_(Q_lcv) +
                ') exceeds vent capacity (' + q_(Q_vent) +
                '). Install RO of bore ≈ ' +
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
    // Display in the active unit system (22-units.js); calcs stay imperial.
    function _metric() {
        var U = G.WTS_units;
        return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format);
    }
    function _u(v, cat, dp, impLabel, dpMet) {
        if (v == null || !isFinite(v)) return 'n/a';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return Number(f.value).toFixed(dpMet == null ? dp : dpMet) + ' ' + f.label; }
        return Number(v).toFixed(dp) + ' ' + impLabel;
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
            ? _u(r.ro_max_throughput_MMscfd, 'gasRate', 2, 'MMscfd', 1)
            : 'n/a';
        var lenU = function (ft) { return _u(ft, 'length', 1, 'ft'); };
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
            + '<text x="60"  y="135" fill="#8b949e" font-size="9">x = '  + lenU(fl.x_ft) + '</text>'
            + '<text x="170" y="40"  fill="#8b949e" font-size="9">y = '  + lenU(fl.y_ft) + '</text>'
            + '<text x="170" y="55"  fill="#8b949e" font-size="9">s = '  + lenU(fl.s_ft) + '</text>'
            + '</svg>';

        var html = ''
        + '<div class="card"><div class="card-title">Results</div>'
        + '<table style="width:100%;font-size:12px;border-collapse:collapse">'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Max Gas Rate Through LCV</td>'
        + '      <td style="padding:4px 6px;text-align:right;' + lcvHi + '">'
        +         _u(r.max_gas_through_lcv_MMscfd, 'gasRate', 2, 'MMscfd', 1) + '</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Vent Line Max Capacity</td>'
        + '      <td style="padding:4px 6px;text-align:right;color:#3fb950;font-weight:700">'
        +         _u(r.vent_max_capacity_MMscfd, 'gasRate', 2, 'MMscfd', 1) + '</td></tr>'
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
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">P downstream of RO</td>'
        + '      <td style="padding:4px 6px;text-align:right">' + _u(r.p_downstream_ro_psig, 'pressureG', 0, 'psig') + '</td></tr>'
        + '  <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Standard-volume basis</td>'
        + '      <td style="padding:4px 6px;text-align:right">' + (_metric() ? '15.6 °C / 101.35 kPa' : '60 °F / 14.7 psia') + ' (Cv and orifice equations)</td></tr>'
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
        + '          <td style="padding:4px 6px;text-align:right;font-weight:700">' + lenU(fl.y_ft) + '</td></tr>'
        + '      <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Horizontal (x, downwind)</td>'
        + '          <td style="padding:4px 6px;text-align:right;font-weight:700">' + lenU(fl.x_ft) + '</td></tr>'
        + '      <tr><td style="padding:4px 6px;color:var(--text2,#8b949e)">Axial (s)</td>'
        + '          <td style="padding:4px 6px;text-align:right;font-weight:700">' + lenU(fl.s_ft) + '</td></tr>'
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

    // Unit flip: repaint results in the active system (canonical context →
    // tagged inputs read imperial).
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            if (!_$('wts_ll_results') || !_$('wts_ll_calc_btn')) return;
            var U = G.WTS_units;
            if (U && U.runCanonical) U.runCanonical(_renderResults); else _renderResults();
        });
    }


})();

// ─── END 26-liquidline ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 27-pipelife ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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

})();

// ─── END 27-pipelife ─────────────────────────────────────────────

