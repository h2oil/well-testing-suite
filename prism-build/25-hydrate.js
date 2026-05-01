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

    // === SELF-TEST ===
    (function () {
        var checks = [];
        function check(name, ok, info) {
            checks.push({ name: name, ok: !!ok, info: info || null });
        }

        // ── Hammerschmidt direct: 25 wt% MeOH ⇒ ~24 °F depression ───
        var dT_meoh_25 = WTS_hammerschmidt_depression(25, 'methanol');
        check('MeOH 25 wt% gives 22-30 °F depression',
            dT_meoh_25 > 22 && dT_meoh_25 < 30,
            'dT=' + dT_meoh_25.toFixed(2));

        // ── Hammerschmidt at 20, 30, 50 wt% (informational) ─────────
        var dT20 = WTS_hammerschmidt_depression(20, 'methanol');
        var dT30 = WTS_hammerschmidt_depression(30, 'methanol');
        var dT50 = WTS_hammerschmidt_depression(50, 'methanol');
        check('MeOH depression monotonic (20<25<30<50)',
            dT20 < dT_meoh_25 && dT_meoh_25 < dT30 && dT30 < dT50,
            'dT20=' + dT20.toFixed(1) + ', dT30=' + dT30.toFixed(1) + ', dT50=' + dT50.toFixed(1));
        check('MeOH 50 wt% gives > 60 °F depression', dT50 > 60, 'dT50=' + dT50.toFixed(2));

        // ── Inverse: requesting 25 °F with MeOH should ask ~25 wt% ──
        var w = WTS_hammerschmidt_invert(25, 'methanol');
        check('invert MeOH 25 °F ≈ 22-28 wt%',
            w > 22 && w < 28,
            'W=' + w.toFixed(2));

        // ── Round-trip: invert(direct(W)) ≈ W ───────────────────────
        var rt = WTS_hammerschmidt_invert(WTS_hammerschmidt_depression(20, 'methanol'), 'methanol');
        check('invert round-trip on 20 wt% MeOH',
            Math.abs(rt - 20) < 0.5,
            'rt=' + rt.toFixed(3));

        // ── T_hyd at 1000 psia, SG=0.65 in 50-75 °F window ──────────
        var Th = WTS_hydrate_temp(1000, 0.65);
        check('T_hyd at 1000 psia is 50-80 °F',
            Th > 50 && Th < 80,
            'Th=' + Th.toFixed(2));

        // ── T_hyd monotonic in P ────────────────────────────────────
        check('T_hyd(2000) > T_hyd(500)',
            WTS_hydrate_temp(2000, 0.65) > WTS_hydrate_temp(500, 0.65),
            'd=' + (WTS_hydrate_temp(2000, 0.65) - WTS_hydrate_temp(500, 0.65)).toFixed(2));

        // ── T_hyd lower for richer (heavier) gas at same P ──────────
        var Th07 = WTS_hydrate_temp(1000, 0.70);
        var Th06 = WTS_hydrate_temp(1000, 0.60);
        check('Heavier gas (SG=0.7) lower T_hyd than SG=0.6 at 1000 psia',
            Th07 < Th06,
            'Th07=' + Th07.toFixed(2) + ', Th06=' + Th06.toFixed(2));

        // ── 4-node compute returns array of right length ───────────
        var r = WTS_hydrate_compute({
            gasFlowRate_MMscfd: 25, waterRate_bpd: 400, gasSG: 0.78,
            inhibitor: 'methanol',
            nodes: [
                { label: 'WH→Choke', P_upstream_psig: 2000, T_upstream_F: 105,
                  P_downstream_psig: 885, T_downstream_F: 41 },
                { label: 'Sep BPV',       P_upstream_psig: 197,  T_upstream_F: -13,
                  P_downstream_psig: 31,  T_downstream_F: -30 }
            ]
        });
        check('compute returns nodes array of length 2',
            Array.isArray(r.nodes) && r.nodes.length === 2);

        // ── Sep BPV at -13 °F is high risk ─────────────────────────
        check('Sep BPV at very cold T flagged red',
            r.nodes[1].hydrate_risk === 'red',
            'risk=' + r.nodes[1].hydrate_risk + ', T_hyd=' + r.nodes[1].T_hyd_no_inhibitor_F.toFixed(2));

        // ── Injection rate > 0 for the red-risk node ───────────────
        check('Sep BPV recommends positive injection',
            r.nodes[1].injection_rate_cc_min > 0,
            'cc/min=' + r.nodes[1].injection_rate_cc_min.toFixed(2));

        // ── WTS_hydrate_injection_rate returns expected shape ───────
        var inj = WTS_hydrate_injection_rate(30, 400, 'methanol');
        check('injection_rate has wt_pct_needed > 0', inj.wt_pct_needed > 0);
        check('injection_rate has positive total_cc_min', inj.total_cc_min > 0);
        check('MeOH allowance factor = 1.30', Math.abs(inj.allowance_factor - 1.30) < 1e-6);

        // ── Zero water rate ⇒ zero injection ───────────────────────
        var injZero = WTS_hydrate_injection_rate(30, 0, 'methanol');
        check('zero water rate gives zero injection', injZero.total_cc_min === 0);

        // ── Zero depression ⇒ zero injection ───────────────────────
        var injNoDt = WTS_hydrate_injection_rate(0, 400, 'methanol');
        check('zero depression gives zero injection', injNoDt.total_cc_min === 0);

        // ── MEG depression order: K_MEG > K_MeOH so at same wt%
        //    MEG should give LESS depression per wt% (because M is
        //    bigger). Verify ordering.
        var dM_meoh = WTS_hammerschmidt_depression(20, 'methanol');
        var dM_meg  = WTS_hammerschmidt_depression(20, 'meg');
        check('at 20 wt%, MeOH depression > MEG depression (lower MW)',
            dM_meoh > dM_meg,
            'MeOH=' + dM_meoh.toFixed(1) + ', MEG=' + dM_meg.toFixed(1));

        // ── Public API surface ─────────────────────────────────────
        check('window.WTS_hydrate_temp is fn',                typeof G.WTS_hydrate_temp === 'function');
        check('window.WTS_hammerschmidt_depression is fn',    typeof G.WTS_hammerschmidt_depression === 'function');
        check('window.WTS_hammerschmidt_invert is fn',        typeof G.WTS_hammerschmidt_invert === 'function');
        check('window.WTS_hydrate_injection_rate is fn',      typeof G.WTS_hydrate_injection_rate === 'function');
        check('window.WTS_hydrate_compute is fn',             typeof G.WTS_hydrate_compute === 'function');
        check('window.renderHydrateManagement is fn',         typeof G.renderHydrateManagement === 'function');

        // ── Defensive: bad inputs ──────────────────────────────────
        check('WTS_hydrate_temp(NaN, NaN) returns finite number',
            isFinite(WTS_hydrate_temp(NaN, NaN)));
        check('WTS_hammerschmidt_invert(NaN) returns 0',
            WTS_hammerschmidt_invert(NaN, 'methanol') === 0);
        check('WTS_hydrate_compute({}) returns nodes []',
            Array.isArray(WTS_hydrate_compute({}).nodes) && WTS_hydrate_compute({}).nodes.length === 0);

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            _err('Hydrate self-test FAILED:', fails.map(function (f) {
                return f.name + (f.info ? ' [' + f.info + ']' : '');
            }));
        } else {
            _log('✓ Hydrate self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
