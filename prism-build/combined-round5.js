
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

})();

// ─── END 23-esd-hipilot ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 24-esd-lopilot ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Layer 24 — ESD Lo-Pilot (Leak Detection) Analysis
//
// PURPOSE
//   Sizes the LOW-pressure pilot setpoint that fires the Emergency Shut-
//   Down (ESD) valve when a gas leak develops downstream of the lo-pilot
//   sensing tap. After well shut-in, the section trapped between two
//   isolations is at the section flowing pressure P_flow. If a leak of
//   size Q_leak (MMscfd) appears for the duration of one ESD response
//   cycle (t_resp seconds), the section pressure must drop low enough
//   for the lo-pilot setting (PSL) to actuate. The PSL must:
//     • be ABOVE the WHSIP (otherwise the well itself repressures the
//       section and PSL would never trigger), and
//     • be BELOW P_flow by enough margin that the target leak rate
//       reaches it within the response window.
//
// ENGINEERING MODEL  (isothermal, ideal-gas, single trapped section)
//   ΔV_leak  = Q_leak·1e6 / 86400 · t_resp                 [scf released]
//   ΔP       = ΔV_leak · 14.7 / V_section                  [psi drop]
//   P_after  = P_flow − ΔP                                  [psia]
//   PSL      = P_after − safety_margin                      [psig target]
//
//   Reachability check:
//     if  P_after < WHSIP  → unreachable  (well repressures section)
//
//   APPROXIMATIONS:
//     • Ideal-gas at 14.7 psia surface conditions; no Z, no T.
//       Adequate for sizing PSL margins (engineering tolerance ~5%).
//     • Constant leak rate over response window (no choking, no decay).
//     • Adiabatic effects neglected — small ΔP, short t_resp.
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
        var WHSIP      = +inputs.whsip_psig;
        var tresp      = +inputs.esdResponseTime_s;
        var margin     = (inputs.safetyMargin_psig != null)
                       ? +inputs.safetyMargin_psig : 5;

        // Defensive defaults
        if (!_isNum(V) || V <= 0)               V = 1;
        if (!_isNum(Pflow))                      Pflow = 0;
        if (!_isNum(Qleak_mmscfd) || Qleak_mmscfd < 0) Qleak_mmscfd = 0;
        if (!_isNum(WHSIP))                      WHSIP = 0;
        if (!_isNum(tresp) || tresp < 0)         tresp = 0;
        if (!_isNum(margin) || margin < 0)       margin = 0;

        // Gas released during ESD response window  (scf)
        var gasReleased_scf = (Qleak_mmscfd * 1e6 / 86400) * tresp;

        // Pressure drop  (psi) — isothermal ideal-gas, surface ref 14.7 psia
        var dP_psi = (gasReleased_scf * 14.7) / V;

        // After-drop section pressure  (psig)
        var Pafter_psig = Pflow - dP_psi;

        // PSL target  (psig)
        var psl_target_psig = Pafter_psig - margin;

        // Reachability — well repressures section once it falls below WHSIP.
        var reachable = Pafter_psig >= WHSIP;

        // Severity flag for UI: yellow if drawdown is so small relative to
        // operating noise (<2 psi) that PSL would risk false trips, even
        // though formally reachable.
        var lowSensitivity = reachable && (dP_psi < 2.0);

        // Rationale
        var rationale;
        if (!reachable) {
            rationale =
                'Calculated drawdown pressure (' + _fmt(Pafter_psig, 1) + ' psig) is BELOW WHSIP (' +
                _fmt(WHSIP, 0) + ' psig). The well will repressurise the section before the lo-pilot ' +
                'can detect the leak — PSL will never reach setpoint at this leak rate. Either choose a ' +
                'lo-pilot location with a smaller trapped volume, accept a larger detectable leak rate, ' +
                'or shorten the ESD response time.';
        } else if (lowSensitivity) {
            rationale =
                'PSL is reachable but the predicted drawdown is only ' + _fmt(dP_psi, 2) +
                ' psi over ' + _fmt(tresp, 1) + ' s — comparable to normal operating pressure ' +
                'fluctuation. PSL set this close to P_flow risks frequent false trips. Consider ' +
                'increasing the detectable leak rate, lengthening the response window, or using ' +
                'rate-of-change detection in addition to absolute PSL.';
        } else {
            rationale =
                'A ' + _fmt(Qleak_mmscfd, 0) + ' MMscfd leak releases ' +
                _fmt(gasReleased_scf, 0) + ' scf over the ' + _fmt(tresp, 1) +
                ' s response window, producing a ' + _fmt(dP_psi, 1) +
                ' psi drop in the ' + _fmt(V, 2) + ' ft³ section. Setting PSL at ' +
                _fmt(psl_target_psig, 0) + ' psig (drawdown pressure ' +
                _fmt(Pafter_psig, 0) + ' psig less ' + _fmt(margin, 0) +
                ' psig safety margin) gives a deterministic ESD trip on this leak signature.';
        }

        var result = {
            gasReleasedDuringResponse_scf: gasReleased_scf,
            pressureDrop_psi: dP_psi,
            psl_target_psig: psl_target_psig,
            leakDrawdownPressure_psig: Pafter_psig,
            reachable: reachable,
            lowSensitivity: lowSensitivity,
            rationale: rationale
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
                  '<div class="info-bar">After ESD, the section between two isolations sits at P_flow. A downstream leak depressures it. ' +
                    'PSL must be reachable within the response window without dropping below WHSIP.</div>' +

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
                      '<label>WHSIP (psig)</label>' +
                      '<input type="number" id="wts_esdlo_whsip" step="1" value="' + d.whsip + '">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>ESD Response Time (sec)</label>' +
                      '<input type="number" id="wts_esdlo_tresp" step="0.1" value="5">' +
                    '</div>' +
                    '<div class="fg-item">' +
                      '<label>Safety Margin (psig)</label>' +
                      '<input type="number" id="wts_esdlo_margin" step="1" value="5">' +
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
            sectionVolume_ft3:           _num('wts_esdlo_volume', 0),
            sectionFlowingPressure_psig: _num('wts_esdlo_pflow',  0),
            detectableLeakRate_MMscfd:   _num('wts_esdlo_qleak', 25),
            whsip_psig:                  _num('wts_esdlo_whsip', 2100),
            esdResponseTime_s:           _num('wts_esdlo_tresp',  5),
            safetyMargin_psig:           _num('wts_esdlo_margin', 5)
        };

        var r = G.WTS_esdLoPilot_compute(inputs);

        // ── Results table ──
        var tbl = '' +
            '<table class="dtable">' +
              '<tbody>' +
                '<tr><td>Gas released during response window</td>' +
                    '<td style="text-align:right;font-family:Courier New,monospace;">' +
                    _fmt(r.gasReleasedDuringResponse_scf, 1) + ' scf</td></tr>' +
                '<tr><td>Pressure drop during response window</td>' +
                    '<td style="text-align:right;font-family:Courier New,monospace;">' +
                    _fmt(r.pressureDrop_psi, 2) + ' psi</td></tr>' +
                '<tr><td>Leak drawdown pressure</td>' +
                    '<td style="text-align:right;font-family:Courier New,monospace;">' +
                    _fmt(r.leakDrawdownPressure_psig, 1) + ' psig</td></tr>' +
                '<tr><td>WHSIP (reference)</td>' +
                    '<td style="text-align:right;font-family:Courier New,monospace;color:#8b949e;">' +
                    _fmt(inputs.whsip_psig, 0) + ' psig</td></tr>' +
                '<tr><td>Safety margin</td>' +
                    '<td style="text-align:right;font-family:Courier New,monospace;color:#8b949e;">' +
                    _fmt(inputs.safetyMargin_psig, 0) + ' psig</td></tr>' +
              '</tbody>' +
            '</table>' +
            // Headline: PSL target
            '<div class="rbox" style="margin-top:14px;">' +
              '<div class="rbox-title">PSL Setting Target</div>' +
              '<div class="rrow">' +
                '<span class="rl">Recommended PSL setpoint</span>' +
                '<span class="rv" style="font-size:20px;">' +
                  _fmt(r.psl_target_psig, 0) + ' psig' +
                '</span>' +
              '</div>' +
              '<div class="rrow">' +
                '<span class="rl">Drawdown from P_flow</span>' +
                '<span class="rv">' +
                  _fmt(inputs.sectionFlowingPressure_psig - r.psl_target_psig, 1) + ' psi' +
                '</span>' +
              '</div>' +
            '</div>';

        var rc = document.getElementById('wts_esdlo_resultcard');
        var rd = document.getElementById('wts_esdlo_results');
        if (rd) rd.innerHTML = tbl;
        if (rc) rc.style.display = '';

        // ── Status badge + rationale ──
        var badgeBg, badgeBorder, badgeColor, badgeIcon, badgeText;
        if (!r.reachable) {
            badgeBg     = 'rgba(248,81,73,.10)';
            badgeBorder = 'rgba(248,81,73,.45)';
            badgeColor  = '#f85149';
            badgeIcon   = '✖';   // ✗
            badgeText   = 'Calculated drawdown pressure greater than flowing pressure — ' +
                          'PSL CANNOT detect this leak rate at this location.';
        } else if (r.lowSensitivity) {
            badgeBg     = 'rgba(210,153,34,.10)';
            badgeBorder = 'rgba(210,153,34,.45)';
            badgeColor  = '#d29922';
            badgeIcon   = '⚠';   // ⚠
            badgeText   = 'Detectable leak too small — PSL unlikely to trigger before ' +
                          'well shut-in propagates.';
        } else {
            badgeBg     = 'rgba(63,185,80,.10)';
            badgeBorder = 'rgba(63,185,80,.45)';
            badgeColor  = '#3fb950';
            badgeIcon   = '✓';   // ✓
            badgeText   = 'PSL reachable — leak would drop section by ' +
                          _fmt(r.pressureDrop_psi, 1) + ' psi in ' +
                          _fmt(inputs.esdResponseTime_s, 1) + ' s.';
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
//   • T_hyd correlation:    screening curve fit to standard sweet-gas
//                           hydrate chart. Form:
//                             T_hyd_F = 5·ln(P_psia) + 35
//                                       − 30·(SG − 0.6)
//                           Calibrated against textbook charts for
//                           SG = 0.6 to 0.8, P = 100 to 4000 psia.
//                           Sensible to within ±3 °F for typical
//                           sweet gas. Real-design work should use
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
    // Screening correlation:
    //   T_hyd_F = 5·ln(P) + 35 − 30·(SG − 0.6)
    //
    // Calibrated against textbook hydrate-locus charts for sweet gas;
    // ±3 °F over 100-4000 psia, SG 0.60-0.80.
    function WTS_hydrate_temp(P_psia, gasSG) {
        var P = (typeof P_psia === 'number' && isFinite(P_psia)) ? P_psia : 0;
        if (P <= 0) P = 1; // guard log domain
        var SG = (typeof gasSG === 'number' && isFinite(gasSG)) ? gasSG : 0.65;
        if (SG < 0.55) SG = 0.55;
        if (SG > 1.00) SG = 1.00;

        var T = 5 * Math.log(P) + 35 - 30 * (SG - 0.6);
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
            +       '<span id="hy_thyd_' + idx + '" style="font-weight:700">— &deg;F</span>'
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
            +       '<span id="hy_thydInj_' + idx + '" style="font-weight:700">— &deg;F</span>'
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

        var segGrid = '<div class="cols-4" style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:10px">';
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
        if (injBox)    injBox.textContent = _fmt(T_hyd_inj, 1) + ' °F';
        if (statusBox) {
            statusBox.style.background = _riskBg(depressed_risk);
            statusBox.style.color      = _riskColor(depressed_risk);
            if (depressed_risk === 'green') {
                statusBox.textContent = 'NO INHIBITOR SHORTFALL';
            } else if (depressed_risk === 'yellow') {
                statusBox.textContent = 'MARGINAL — within 5 °F';
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

            if (thydEl)  thydEl.textContent = _fmt(nd.T_hyd_no_inhibitor_F, 1) + ' °F';
            if (badgeEl) {
                badgeEl.style.background = _riskBg(nd.hydrate_risk);
                badgeEl.style.color      = _riskColor(nd.hydrate_risk);
                if (nd.hydrate_risk === 'green') {
                    badgeEl.textContent = 'NO HYDRATE RISK (T_op > T_hyd + 5°F)';
                } else if (nd.hydrate_risk === 'yellow') {
                    badgeEl.textContent = 'MARGINAL — within 5 °F of hydrate locus';
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
                    +   '<td>' + _fmt(rn2.T_hyd_no_inhibitor_F, 1) + '</td>'
                    +   '<td>' + _fmt(rn2.T_downstream_F, 1)       + '</td>'
                    +   '<td>' + _fmt(rn2.depression_required_F, 1) + '</td>'
                    +   '<td>' + _fmt(rn2.wt_pct_needed, 1)         + '</td>'
                    +   '<td>' + _fmt(rn2.injection_rate_cc_min, 1) + '</td>'
                    +   '<td>' + _fmt(local, 1)                     + '</td>'
                    +   '<td style="color:' + _riskColor(rn2.hydrate_risk) + ';font-weight:600">' + rn2.hydrate_risk.toUpperCase() + '</td>'
                    + '</tr>';
            }
            var tableHTML = ''
                + '<table class="dtable" style="font-size:11px">'
                +   '<tr><th>Segment</th><th>T<sub>hyd</sub> (°F)</th><th>T<sub>op</sub> (°F)</th>'
                +       '<th>&Delta;T req (°F)</th><th>wt% needed</th>'
                +       '<th>Recommended (cc/min)</th><th>Currently set (cc/min)</th><th>Risk</th></tr>'
                +   rows
                + '</table>'
                + '<div style="margin-top:10px;padding:8px;border-radius:6px;background:rgba(56,139,253,0.08);font-size:12px">'
                +   '<b>Total currently set:</b> ' + _fmt(totalCcMin, 1) + ' cc/min '
                +   '(' + INHIB[inhibKey].label + ', incl. ' + _fmt((INHIB[inhibKey].vapAllow - 1) * 100, 0) + '% vapour-phase allowance)'
                + '</div>'
                + '<div style="margin-top:6px;font-size:11px;opacity:0.75">'
                +   'Recommended rates target a 5°F (or user-set) safety margin below the hydrate locus. '
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

// ─── END 26-liquidline ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 27-pipelife ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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

})();

// ─── END 27-pipelife ─────────────────────────────────────────────

