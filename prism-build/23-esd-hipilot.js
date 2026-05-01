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
//   has a rupture disc / relief valve set at MAWP + 10 % AND a hi-pilot
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
//   Inventory at pressure P:  V_inv(P) = V · (P + 14.7) / 14.7   [scf]
//      (ideal gas at constant T; the section is at uniform T_section,
//       and the standard reference is 14.7 psia — the standard scf
//       definition.  This is the same simplification used in the
//       hand-calc spreadsheets that operators carry in the field.)
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
    //     sectionGasTemp_F        °F  (informational; not used in the
    //                                  ideal-gas screening calc)
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
        var T_F     = +inputs.sectionGasTemp_F;     // informational
        var Q_MMscf = +inputs.gasFlowRate_MMscfd;
        var SG      = +inputs.gasSG;                 // informational
        var tResp   = +inputs.esdResponseTime_s;
        var HP      = +inputs.hiPilotSetting_psig;
        var RD      = +inputs.rdSetting_psig;
        var MAWP    = +inputs.mawp_psig;

        var problems = [];
        if (!_isNum(V)       || V       <= 0) problems.push('Section volume must be > 0 ft³.');
        if (!_isNum(Q_MMscf) || Q_MMscf <= 0) problems.push('Gas backflow rate must be > 0 MMSCFD.');
        if (!_isNum(tResp)   || tResp   <= 0) problems.push('ESD response time must be > 0 s.');
        if (!_isNum(HP)) problems.push('Hi-pilot setting required (psig).');
        if (!_isNum(RD)) problems.push('Rupture disc / RV setting required (psig).');
        if (_isNum(HP) && _isNum(RD) && HP >= RD) {
            problems.push('Hi-pilot must be set BELOW the RV/RD (currently HP ≥ RD).');
        }
        if (problems.length) {
            result.error = problems.join(' ');
            result.rationale = 'Cannot evaluate — inputs incomplete. ' + result.error;
            return result;
        }

        // Inventory model: V_inv(P) = V · (P + 14.7) / 14.7   [scf]
        var inv_HP = V * (HP + P_ATM) / P_ATM;
        var inv_RD = V * (RD + P_ATM) / P_ATM;

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

        // Build rationale narrative.
        var rationale = '';
        if (pass) {
            rationale = 'PASS — at the chosen Hi-Pilot of ' + HP.toFixed(0) + ' psig, '
                + 'the section reaches the RV setting in ' + tFill.toFixed(2)
                + ' s, leaving a margin of ' + margin.toFixed(2) + ' s above the ESD '
                + 'response time of ' + tResp.toFixed(1) + ' s. '
                + 'Up to ' + Math.round(Vrel).toLocaleString() + ' scf will vent to '
                + 'atmosphere through the open RV during ESD response.';
        } else {
            // Suggest by how much HP must drop, OR how much tResp must shrink.
            // Solve for HP* such that t_fill_at_HPstar == tResp:
            //   V·(RD+14.7)/14.7 − V·(HPstar+14.7)/14.7 == qScfS · tResp
            //   HPstar = RD − qScfS·tResp·14.7 / V
            var HPstar = RD - (qScfS * tResp * P_ATM) / V;
            // Also solve for RD* such that t_fill at the existing HP gives tResp:
            var RDstar = HP + (qScfS * tResp * P_ATM) / V;

            var rd_relief = (RD <= MAWP) ? (' Note also that the RV setting (' + RD.toFixed(0)
                + ' psig) is below MAWP+10 % (' + (MAWP * 1.10).toFixed(0)
                + ' psig); raising the RV may be permissible.') : '';

            rationale = 'FAIL — at the chosen Hi-Pilot of ' + HP.toFixed(0) + ' psig, '
                + 'the section reaches the RV in only ' + tFill.toFixed(2)
                + ' s, which is shorter than the ' + tResp.toFixed(1) + ' s ESD response. '
                + 'To pass: drop the Hi-Pilot to ≤ ' + Math.max(0, HPstar).toFixed(0)
                + ' psig, OR raise the RV to ≥ ' + RDstar.toFixed(0) + ' psig (only if MAWP allows), '
                + 'OR reduce the ESD response time below ' + tFill.toFixed(2) + ' s.'
                + rd_relief;
        }
        result.rationale = rationale;

        // Engineering notes.
        if (_isNum(MAWP) && RD > MAWP * 1.10 + 0.5) {
            result.notes.push('Caution — RV setting (' + RD.toFixed(0)
                + ' psig) exceeds MAWP+10 % (' + (MAWP * 1.10).toFixed(0)
                + ' psig). Verify RV sizing per ASME / API 521.');
        }
        if (_isNum(HP) && _isNum(MAWP) && HP > MAWP) {
            result.notes.push('Caution — Hi-Pilot setting is ABOVE MAWP. Lower the Hi-Pilot '
                + 'or re-rate the section.');
        }
        if (Math.abs(RD - HP) < 5) {
            result.notes.push('Hi-Pilot is within 5 psi of the RV setting; small instrument '
                + 'drift could trigger spurious RV lifts. Increase the gap.');
        }
        if (_isNum(T_F) && T_F < -40) {
            result.notes.push('Section temperature below −40 °F — verify metallurgy and PSV trim.');
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
        var pad = 40;
        var n   = stages.length;
        var step = (W - 2 * pad) / (n - 1);

        var lines = [];
        // Pipe line connecting all stages.
        lines.push('<line x1="' + pad + '" y1="100" x2="' + (W - pad) + '" y2="100" '
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
                var hpTxt = hpPsig.toFixed(0) + ' psig';
                if (_isNum(rdPsig)) hpTxt += '  /  RV ' + rdPsig.toFixed(0);
                lines.push('<text x="' + bcx + '" y="42" font-size="11" font-weight="700" '
                    + 'fill="' + badgeColor + '" text-anchor="middle" '
                    + 'font-family="Courier New, monospace">' + _esc(hpTxt) + '</text>');
            }
        }

        // Flow direction arrow at the right.
        lines.push('<polygon points="' + (W - pad + 6) + ',92 ' + (W - pad + 22) + ',100 '
            + (W - pad + 6) + ',108" fill="#6e7681"/>');

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
        if (!body || !body.innerHTML) return;

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
            + _fmt(inputs.sectionVolume_ft3, 2) + ' ft³</td></tr>'
            + '<tr><td>Section Gas Temp</td><td>'
            + _fmt(inputs.sectionGasTemp_F, 0) + ' °F</td></tr>'
            + '<tr><td>Gas Backflow Rate</td><td>'
            + _fmt(inputs.gasFlowRate_MMscfd, 2) + ' MMSCFD</td></tr>'
            + '<tr><td>Gas SG</td><td>' + _fmt(inputs.gasSG, 2) + '</td></tr>'
            + '<tr><td>Hi-Pilot Setting</td><td>'
            + _fmt(inputs.hiPilotSetting_psig, 0) + ' psig</td></tr>'
            + '<tr><td>RV / RD Setting</td><td>'
            + _fmt(inputs.rdSetting_psig, 0) + ' psig</td></tr>'
            + '<tr><td>Section MAWP</td><td>'
            + _fmt(inputs.mawp_psig, 0) + ' psig</td></tr>'
            + '<tr><td>ESD Response Time</td><td>'
            + _fmt(inputs.esdResponseTime_s, 1) + ' s</td></tr>';

        var resultsRows = ''
            + '<tr><td>Inventory @ Hi-Pilot</td><td>'
            + _fmtInt(r.inventoryAtHiPilot_scf) + ' scf</td></tr>'
            + '<tr><td>Inventory @ RD/RV</td><td>'
            + _fmtInt(r.inventoryAtRD_scf) + ' scf</td></tr>'
            + '<tr><td>Time to reach RV</td><td>'
            + _fmt(r.timeToReachRV_s, 2) + ' s</td></tr>'
            + '<tr><td>Gas released to atmos. during ESD</td><td>'
            + _fmtInt(r.gasReleasedToAtmosphere_scf) + ' scf</td></tr>'
            + '<tr><td>Margin (t_fill − t_resp)</td><td>'
            + _fmt(r.marginSeconds, 2) + ' s</td></tr>';

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

// === SELF-TEST ===
(function () {
    var checks = [];
    function _check(name, ok, detail) {
        checks.push({ n: name, ok: !!ok, detail: detail || '' });
    }

    // Test 1 — default Heater Shell case (volume 292, Q=39.28, hp=130, rd=135, ESD=5)
    var r1 = G.WTS_esdHiPilot_compute({
        sectionVolume_ft3:  292,
        sectionGasTemp_F:   23,
        gasFlowRate_MMscfd: 39.28,
        gasSG:              0.78,
        esdResponseTime_s:  5,
        hiPilotSetting_psig: 130,
        rdSetting_psig:      135,
        mawp_psig:           125
    });
    _check('inventory @ HP > 0',                r1.inventoryAtHiPilot_scf > 0,
        'inv_HP=' + r1.inventoryAtHiPilot_scf);
    _check('inventory @ RD > inventory @ HP',   r1.inventoryAtRD_scf > r1.inventoryAtHiPilot_scf,
        'inv_RD=' + r1.inventoryAtRD_scf);
    _check('t_fill is finite',                  isFinite(r1.timeToReachRV_s),
        't_fill=' + r1.timeToReachRV_s);
    _check('gas released = Q · t_response',
        Math.abs(r1.gasReleasedToAtmosphere_scf - 39.28e6 / 86400 * 5) < 1,
        'released=' + r1.gasReleasedToAtmosphere_scf);

    // Test 2 — degenerate small-volume / huge backflow → must FAIL.
    var r2 = G.WTS_esdHiPilot_compute({
        sectionVolume_ft3:  0.23,
        sectionGasTemp_F:   23,
        gasFlowRate_MMscfd: 100,
        gasSG:              0.78,
        esdResponseTime_s:  5,
        hiPilotSetting_psig: 130,
        rdSetting_psig:      135,
        mawp_psig:           125
    });
    _check('small volume + high Q → FAIL',      r2.pass === false,
        't_fill=' + r2.timeToReachRV_s);

    // Test 3 — defensive: missing inputs → returns error, no throw.
    var r3 = G.WTS_esdHiPilot_compute(null);
    _check('null inputs return error, no throw', !!r3.error);

    var r4 = G.WTS_esdHiPilot_compute({
        sectionVolume_ft3: -10,
        gasFlowRate_MMscfd: 10,
        esdResponseTime_s: 5,
        hiPilotSetting_psig: 130,
        rdSetting_psig: 135,
        mawp_psig: 125
    });
    _check('negative volume produces error',     !!r4.error);

    var r5 = G.WTS_esdHiPilot_compute({
        sectionVolume_ft3: 100,
        gasFlowRate_MMscfd: 10,
        esdResponseTime_s: 5,
        hiPilotSetting_psig: 140,    // HP >= RD invalid
        rdSetting_psig: 135,
        mawp_psig: 125
    });
    _check('HP >= RD produces error',            !!r5.error);

    // Test 4 — analytic check: t_fill = V/14.7 · (RD−HP) / (Q·1e6/86400).
    // For V=292, RD=135, HP=130, Q=39.28:
    //   numerator   = 292 · 5 / 14.7 = 99.31972789... scf
    //   denominator = 39.28·1e6/86400 = 454.6296296... scf/s
    //   t_fill      = 0.21849...     s
    var expected = (292 * (135 - 130) / 14.7) / (39.28e6 / 86400);
    _check('analytic t_fill matches default case',
        Math.abs(r1.timeToReachRV_s - expected) < 1e-6,
        'expected=' + expected.toFixed(6) + ', got=' + r1.timeToReachRV_s.toFixed(6));

    // Test 5 — pass case — generous margin.
    var r6 = G.WTS_esdHiPilot_compute({
        sectionVolume_ft3: 292,
        sectionGasTemp_F:  23,
        gasFlowRate_MMscfd: 1.0,    // tiny backflow → easy pass
        gasSG: 0.78,
        esdResponseTime_s:   5,
        hiPilotSetting_psig: 130,
        rdSetting_psig:      135,
        mawp_psig:           125
    });
    _check('low-Q case passes',           r6.pass === true);
    _check('rationale string is non-empty', r6.rationale && r6.rationale.length > 10);

    // Test 6 — high Q case fails AND rationale suggests dropping HP.
    _check('FAIL rationale mentions Hi-Pilot lowering or RV raising',
        /Hi-Pilot|RV/i.test(r2.rationale),
        r2.rationale.slice(0, 100));

    // Test 7 — preset tables present.
    _check('LOCATIONS exposed on window',
        !!(G.WTS_esdHiPilot_LOCATIONS && G.WTS_esdHiPilot_LOCATIONS.heater_shell));
    _check('renderESDHiPilot exposed on window',
        typeof G.renderESDHiPilot === 'function');

    // Summary.
    var fails = checks.filter(function (c) { return !c.ok; });
    if (fails.length) {
        if (typeof console !== 'undefined' && console.error) {
            console.error('ESD Hi-Pilot self-test FAILED:', fails);
        }
    } else {
        _log('✓ ESD Hi-Pilot self-test passed (' + checks.length + ' checks).');
    }
    if (typeof G !== 'undefined') {
        G.__WTS_23_selftest = {
            pass: checks.length - fails.length,
            fail: fails.length,
            checks: checks
        };
    }
})();

})();
