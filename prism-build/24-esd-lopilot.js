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

// === SELF-TEST ===
(function () {
    if (typeof window === 'undefined' || typeof window.WTS_esdLoPilot_compute !== 'function') {
        // Allow node smoke-test stub to inject globalThis.WTS_esdLoPilot_compute
        if (typeof globalThis !== 'undefined' &&
            typeof globalThis.WTS_esdLoPilot_compute !== 'function') {
            console.warn('ESD Lo-Pilot self-test SKIPPED — compute fn not found on window/globalThis.');
            return;
        }
    }
    var compute = (typeof window !== 'undefined' && window.WTS_esdLoPilot_compute) ||
                  (typeof globalThis !== 'undefined' && globalThis.WTS_esdLoPilot_compute);
    var checks = [];

    // Case 1 — default Upstream of Heater Choke: 662 ft³ at 662 psig, 25 MMscfd, 5 s.
    // ΔP = 1446.76·14.7/662 = 32.13 psi ≥ 5 psi margin → PSL 657 psig trips in 0.78 s.
    var r1 = compute({
        sectionVolume_ft3: 662, sectionFlowingPressure_psig: 662,
        detectableLeakRate_MMscfd: 25, whsip_psig: 2100,
        esdResponseTime_s: 5, safetyMargin_psig: 5
    });
    var expectedGas = 25e6 / 86400 * 5;   // 1446.759… scf
    checks.push({ n: 'gas released = Q · t', ok: Math.abs(r1.gasReleasedDuringResponse_scf - expectedGas) < 1 });
    checks.push({ n: 'ΔP = Vstd·Pb/V', ok: Math.abs(r1.pressureDrop_psi - expectedGas * 14.7 / 662) < 1e-6 });
    checks.push({ n: 'PSL = P_flow − margin', ok: Math.abs(r1.psl_target_psig - 657) < 1e-9 });
    checks.push({ n: 'default case passes (WHSIP no longer a criterion)', ok: r1.pass === true });
    checks.push({ n: 'time to trip = margin / rate', ok: Math.abs(r1.timeToTrip_s - 5 / (r1.pressureDrop_psi / 5)) < 1e-9 });

    // Case 2 — too slow: 0.05 MMscfd into 662 ft³ → ΔP 0.11 psi in 5 s < 5 psi margin.
    var r2 = compute({
        sectionVolume_ft3: 662, sectionFlowingPressure_psig: 662,
        detectableLeakRate_MMscfd: 0.05, whsip_psig: 2100,
        esdResponseTime_s: 5, safetyMargin_psig: 5
    });
    checks.push({ n: 'slow leak fails', ok: r2.pass === false && r2.inTime === false });

    // Case 3 — hotter section drops faster (ΔP ∝ T).
    var r3 = compute({
        sectionVolume_ft3: 4.36, sectionFlowingPressure_psig: 1971,
        detectableLeakRate_MMscfd: 0.05, whsip_psig: 1500,
        esdResponseTime_s: 5, safetyMargin_psig: 5, sectionTemp_F: 160
    });
    var r3b = compute({
        sectionVolume_ft3: 4.36, sectionFlowingPressure_psig: 1971,
        detectableLeakRate_MMscfd: 0.05, whsip_psig: 1500,
        esdResponseTime_s: 5, safetyMargin_psig: 5
    });
    checks.push({ n: 'ΔP ∝ T', ok: Math.abs(r3.pressureDrop_psi / r3b.pressureDrop_psi - 619.67 / 519.67) < 1e-9 });
    checks.push({ n: 'PSL inside the margin fails', ok: compute({ sectionVolume_ft3: 4.36, sectionFlowingPressure_psig: 1971,
        detectableLeakRate_MMscfd: 0.05, esdResponseTime_s: 5, safetyMargin_psig: 5, pslSetpoint_psig: 1968 }).nuisanceOk === false });

    // Case 4 — defensive: all-zero / missing inputs returns finite numbers.
    var r4 = compute({});
    checks.push({
        n: 'defensive empty input returns finite ΔP',
        ok: isFinite(r4.pressureDrop_psi)
    });

    var fails = checks.filter(function (c) { return !c.ok; });
    if (fails.length) {
        console.error('ESD Lo-Pilot self-test FAILED:', fails);
    } else {
        console.log('✓ ESD Lo-Pilot self-test passed (' + checks.length + ' checks).');
    }
})();
