// =============================================================================
// WTS — 49-calc-wp-studies.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance page part for the increment-B studies (WP27) — docs/WELL-PERFORMANCE-PLAN.md §1.3 US18, §6, §7.4, §8, §10, §2.9 and
// the owner GUI requirement (interactive, deviation first, KPI chips, every result captured by the reports).
//
// Registered as window.WTS_wellperf_ext.studies (the page's extension hooks, 49-calc-wellperf.js): the page calls it at call time,
// so the load order does not matter. It draws with the page's helpers (WTS_wellperf_page.ui(): display units, cards, Jobs, the
// normal input path) and the engines of 49-calc-wp-cases.js (WTS_wp_cases, WTS_wp_forecast), 49-calc-wp-envelope.js
// (WTS_wp_envelope, WTS_wp_screen) and 49-calc-wp-sens.js (tornado, three / four variables) — no numerics of its own.
//
//   #wp_res "Studies" card (always visible, so the active tab's plot and its summary reach the page report and the Quick Report):
//     Operating envelope   rate against wellhead pressure: the deliverability curve (stable / unstable branch), the flowline back
//                          pressure, the operating window shaded between them, every constraint as a line, the operating point;
//                          drag the point along the curve (live read-out: THP, choke Δp, pwf, drawdown, each limit ✓ / ✕), release
//                          → "Bean for this rate" (the design Job) and "Use this bean".
//     Depletion forecast   p̄r steps or a tank (gas p/Z, oil Havlena-Odeh — provisional); rate / p̄r / cumulative / material-balance
//                          views; a time cursor (drag the line, or the slider) moves the operating point and the IPR of that time
//                          on the system plot; loading onset with its MD · TVD (marked on the schematic) and the step where lift is
//                          needed.
//     Tornado              the rate at the low and high value of every applicable variable; select a bar → Use low / Use high.
//     Matrix               three or four variables (≤ 1,000 cases, a Job): a heat map of two variables with sliders for the others,
//                          rate lines per value on the plot, select a cell → Use these values; the best cases.
//     Cases                save the inputs as a named case (base / matched / proposed), load or delete it, compare the chosen cases
//                          (a Job): IPR / outflow overlay, rates, change against the first case, the inputs that differ.
//   Step ④ "Lift screening": the screening matrix (live with every solve; deviation, dogleg and depth first), the pump setting window
//     on MD · TVD (bracket on the schematic), and on a button the rate under natural flow, gas lift and ESP with the pump potential.
//   #wp_studies rows for every study (report / Quick Report); CSV sections; the Notes carry the provisional methods used.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function P() { var pg = G.WTS_wellperf_page; return pg && typeof pg.ui === 'function' ? pg.ui() : null; }
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(v) { if (typeof v === 'number') return isFinite(v) ? v : null; var s = String(v == null ? '' : v).trim(); if (!s) return null; var x = parseFloat(s.replace(',', '.')); return isFinite(x) ? x : null; }
    function _canonVal(id) { var e = _byId(id); if (!e) return null; var U = G.WTS_units, v; if (U && typeof U.runCanonical === 'function') U.runCanonical(function () { v = e.value; }); else v = e.value; return _num(v); }
    function _txt(id) { var e = _byId(id); return e ? String(e.value == null ? '' : e.value) : ''; }
    function _chk(id) { var e = _byId(id); return !!(e && e.checked); }
    function _gas(M) { var t = M && M.fluid && M.fluid.type; return t === 'gas' || t === 'condensate' || t === 'gasinj'; }

    var TABS = [['env', 'Operating envelope'], ['fcst', 'Depletion forecast'], ['torn', 'Tornado'], ['mat', 'Matrix (3–4 variables)'], ['cases', 'Cases']];
    var SENS_CAT = { pr: 'pressure', thp: 'pressureG', psep: 'pressureG', tubingId: 'lengthSmall', gor: 'gor', glr: 'gor', J: 'productivityIndex' };
    var VD_WORD = { ok: 'suitable', warn: 'marginal', fail: 'unsuitable', na: 'not applicable' };
    var STUDY_ARIA = { env: 'Operating envelope: wellhead deliverability against rate with every limit; drag the point along the curve, or focus the plot and use [ then the arrows',
        fcst: 'Depletion forecast: rate, average pressure or cumulative against time; drag the time line, or focus the plot and use [ then the arrows', torn: 'Tornado study plot',
        mat: 'Sensitivity matrix: rate against the column variable, one line per row value at the selected slice', cases: 'Case comparison: inflow and outflow curves of the compared cases' };
    var SENS_ID = { pr: 'wp_pr', wc: 'wp_wc', gor: 'wp_gor', thp: 'wp_thp', psep: 'wp_psep', bean: 'wp_bean', J: 'wp_ip_J', skin: 'wp_ip_S', cgr: 'wp_cgr', wgr: 'wp_wgr' };
    var KIND_LAB = { base: 'Base', matched: 'Matched', proposed: 'Proposed', other: 'Other' };
    var UNIT_TAGS = { wpv_env_dd: 'pressure', wpv_env_pwf: 'pressure', wpv_env_qfo: 'liquidRate', wpv_env_qfg: 'gasRateSmall', wpv_fc_pi: 'pressure', wpv_fc_pab: 'pressure',
        wpv_fc_qabo: 'liquidRate', wpv_fc_qabg: 'gasRateSmall', wpv_sc_pwf: 'pressure', wpv_sc_pinj: 'pressureG' };

    // results kept per page instance (cleared on a well switch / project open; never stored)
    var S = { env: null, envKey: null, envSel: null, envDrag: null, envBean: null, fc: null, fcKey: null, fcI: 0, fcView: 'rate', torn: null, tornKey: null, tornSel: null,
        mat: null, matKey: null, matSel: null, matXY: [0, 1], matSlice: {}, cmp: null, cmpKey: null, scr: null, scrKey: null, tagged: false };

    var CSS = '<style>' +
        '#wp_root .wpb-tabs{display:flex;gap:4px;flex-wrap:wrap}#wp_root .wpb-tabs button{font-size:11.5px;padding:5px 11px;border-radius:14px;border:1px solid var(--border);background:transparent;color:var(--text2);cursor:pointer;transition:background .15s,color .15s,border-color .15s}' +
        '#wp_root .wpb-tabs button.on{background:var(--accent);border-color:var(--accent);color:var(--on-accent,#fff)}#wp_root .wpb-tabs button:hover:not(.on){border-color:var(--border-light);color:var(--text)}' +
        '#wp_root .wpb-ctl{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 12px;align-items:end;margin:4px 0 10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg3)}' +
        '#wp_root .wpb-ctl .fg-item{margin:0;min-width:0}#wp_root .wpb-ctl .fg-item label{font-size:10.5px}#wp_root .wpb-ctl input,#wp_root .wpb-ctl select{width:100%;min-width:0}#wp_root .wpb-ctl input[type=checkbox]{width:auto;flex:0 0 auto}' +
        '#wp_root .wpb-ctl .wpb-go{display:flex;gap:6px;flex-wrap:wrap;align-items:center;grid-column:1/-1}#wp_root .wpb-ctl .wpb-go .btn{padding:7px 13px;font-size:12px}' +
        '#wp_root .wpb-ctl .wpb-go .wp-hint{flex:1 1 220px;margin:0}#wp_root .wpb-ctl .wpb-wide{grid-column:span 2}#wp_root .wpb-ctl .wp-check label{margin-top:0}' +
        '#wp_root .wpb-read{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:6px;margin:8px 0 2px}#wp_root .wpb-read:empty{display:none}' +
        '#wp_root .wpb-rc{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 9px;min-width:0;transition:border-color .15s}' +
        '#wp_root .wpb-rc .k{display:block;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.35px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#wp_root .wpb-rc .v{display:block;font-size:14px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#wp_root .wpb-rc .s{display:block;font-size:10.5px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#wp_root .wpb-checks{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 2px}#wp_root .wpb-ck{font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;background:var(--bg4);color:var(--text2)}' +
        '#wp_root .wpb-ck.ok{background:rgba(63,185,80,.14);color:var(--wp-ok)}#wp_root .wpb-ck.fail{background:rgba(248,81,73,.15);color:var(--wp-fail)}#wp_root .wpb-ck.warn{background:rgba(210,153,34,.16);color:var(--wp-warn)}' +
        '#wp_root .wpb-slider{display:flex;align-items:center;gap:10px;margin:6px 0 2px;font-size:12px;color:var(--text2)}#wp_root .wpb-slider input[type=range]{flex:1 1 auto;accent-color:var(--accent);min-width:0}' +
        '#wp_root .wpb-slider b{color:var(--text);font-variant-numeric:tabular-nums;min-width:110px;text-align:right}' +
        '#wp_root .wpb-stale{opacity:.55;transition:opacity .2s}' +
        '#wp_root .wpb-torn td{vertical-align:middle}#wp_root .wpb-torn td.bar{width:46%;min-width:160px;padding:6px 8px}' +
        '#wp_root .wpb-tb{position:relative;height:18px;border-radius:4px;background:var(--bg4)}#wp_root .wpb-tb i{position:absolute;top:2px;bottom:2px;border-radius:3px;transition:left .25s,width .25s}' +
        '#wp_root .wpb-tb i.lo{background:var(--blue)}#wp_root .wpb-tb i.hi{background:var(--accent)}#wp_root .wpb-tb s{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--text);opacity:.7}' +
        '#wp_root .wpb-torn tbody tr{cursor:pointer;transition:background .15s}#wp_root .wpb-torn tbody tr:hover td{background:rgba(139,148,158,.08)}#wp_root .wpb-torn tbody tr.wp-sel td{background:rgba(240,136,62,.09)}' +
        '#wp_root .wpb-torn button.wpb-row{all:unset;cursor:pointer;font-weight:600;color:var(--text)}#wp_root .wpb-torn button.wpb-row:focus-visible{outline:2px solid var(--focus,#58a6ff);outline-offset:2px}' +
        '#wp_root .wpb-heat td.wp-hc{padding:0;transition:background .2s}#wp_root .wpb-heat td.wp-hc button{display:block;width:100%;min-width:52px;padding:6px 8px;border:0;background:transparent;color:#0d1117;font:inherit;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;cursor:pointer;border-radius:4px}' +
        '#wp_root .wpb-heat thead th.num{text-align:right;padding-right:10px}#wp_root .wpb-heat td.wp-hc.dk button{color:#f0f6fc}#wp_root .wpb-heat td.wp-hc.on button{box-shadow:inset 0 0 0 2px var(--text);}#wp_root .wpb-heat td.wp-hc button:hover{box-shadow:inset 0 0 0 1px var(--text)}#wp_root .wpb-heat td.wp-hc.na button{color:var(--text3);font-weight:500}' +
        '#wp_root .wpb-cases{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin:6px 0 10px}' +
        '#wp_root .wpb-case{position:relative;background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--text3);border-radius:8px;padding:8px 10px;min-width:0;transition:border-color .15s,box-shadow .15s}' +
        '#wp_root .wpb-case.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}#wp_root .wpb-case .n{font-weight:700;font-size:12.5px;color:var(--text);display:flex;gap:6px;align-items:center;overflow:hidden}' +
        '#wp_root .wpb-case .n span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#wp_root .wpb-case .m{font-size:11px;color:var(--text2);margin-top:2px}' +
        '#wp_root .wpb-case .q{font-size:15px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;margin-top:3px}#wp_root .wpb-case .a{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}' +
        '#wp_root .wpb-case .a button{font-size:11px;padding:3px 9px}#wp_root .wpb-case label{display:inline-flex;gap:5px;align-items:center;font-size:11px;color:var(--text2);text-transform:none;letter-spacing:0;margin:0}' +
        '#wp_root .wpb-case.k-base{border-left-color:var(--blue)}#wp_root .wpb-case.k-matched{border-left-color:var(--green)}#wp_root .wpb-case.k-proposed{border-left-color:var(--accent)}' +
        '#wp_root .wpb-sc td.c{text-align:center;padding:4px 5px}#wp_root .wpb-vd{display:inline-block;font-size:11px;font-weight:800;padding:2px 9px;border-radius:10px}' +
        '#wp_root .wpb-vd.ok{background:rgba(63,185,80,.15);color:var(--wp-ok)}#wp_root .wpb-vd.warn{background:rgba(210,153,34,.17);color:var(--wp-warn)}#wp_root .wpb-vd.fail{background:rgba(248,81,73,.17);color:var(--wp-fail)}' +
        '#wp_root .wpb-rates{display:grid;gap:6px;margin:10px 0 4px}#wp_root .wpb-rate{display:grid;grid-template-columns:minmax(110px,170px) minmax(0,1fr) auto;gap:10px;align-items:center;font-size:12px}' +
        '#wp_root .wpb-rate .t{height:12px;border-radius:6px;background:var(--bg4);overflow:hidden}#wp_root .wpb-rate .t i{display:block;height:100%;border-radius:6px;transition:width .3s}' +
        '#wp_root .wpb-rate b{font-variant-numeric:tabular-nums;color:var(--text)}' +
        '@media (max-width:640px){#wp_root .wpb-ctl{grid-template-columns:repeat(2,minmax(0,1fr))}#wp_root .wpb-torn td.bar{min-width:110px}#wp_root .wpb-rate{grid-template-columns:minmax(0,1fr) auto}#wp_root .wpb-rate .t{grid-column:1/-1;order:3}}' +
        '</style>';

    // ── markup ────────────────────────────────────────────────────────────────
    function _fgx(id, label, o) { o = o || {}; var p = P(); return p ? p.fg(id, label, Object.assign({ def: o.def != null ? o.def : '' }, o)) : ''; }
    function _ctlEnv() {
        return '<div class="wpb-ctl rp-skip" data-stab="env">' +
            _fgx('wpv_env_dd', 'Maximum drawdown', { unit: 'psi', ph: 'none' }) + _fgx('wpv_env_pwf', 'Minimum pwf', { unit: 'psia', ph: 'none' }) +
            _fgx('wpv_env_qfo', 'Facility rate', { unit: 'STB/d', ph: 'none', data: 'data-for="oil water"' }) + _fgx('wpv_env_qfg', 'Facility rate', { unit: 'Mscf/d', ph: 'none', data: 'data-for="gas condensate"' }) +
            _fgx('wpv_env_ero', 'Erosional ratio limit', { def: '1' }) + _fgx('wpv_env_pb', 'Keep pwf above the bubble point', { check: true, def: false, data: 'data-for="oil"', cls: 'wpb-wide' }) +
            '<div class="wpb-go"><button type="button" class="btn btn-primary" data-act="b27env">Run the operating envelope</button><span class="wp-hint">The wellhead deliverability on the surveyed well (one march per rate), the flowline back pressure and every limit. Drag the point along the curve; release for the bean.</span></div></div>';
    }
    function _ctlFc() {
        return '<div class="wpb-ctl rp-skip" data-stab="fcst">' +
            _fgx('wpv_fc_mode', 'Forecast', { options: [['steps', 'Future p̄r steps'], ['tank', 'Tank material balance (provisional)']], def: 'steps' }) +
            _fgx('wpv_fc_steps', 'p̄r per step', { text: true, unit: 'psia', ph: 'e.g. 3000 2700 2400 2100', cls: 'wpb-steps' }) +
            _fgx('wpv_fc_wc', 'Water cut per step (optional)', { text: true, unit: '%', ph: 'blank = the model', data: 'data-for="oil water"', cls: 'wpb-steps' }) +
            _fgx('wpv_fc_gor', 'GOR per step (optional)', { text: true, unit: 'scf/STB', ph: 'blank = the model', data: 'data-for="oil"', cls: 'wpb-steps' }) +
            _fgx('wpv_fc_G', 'Gas in place G', { unit: 'Bscf', ph: 'required', data: 'data-for="gas condensate"', cls: 'wpb-tank' }) +
            _fgx('wpv_fc_N', 'Oil in place N', { unit: 'MMSTB', ph: 'required', data: 'data-for="oil"', cls: 'wpb-tank' }) +
            _fgx('wpv_fc_pi', 'Initial pressure p_i', { unit: 'psia', ph: 'p̄r', cls: 'wpb-tank' }) +
            _fgx('wpv_fc_cum0', 'Cumulative to date', { unit: 'MMSTB or Bscf', ph: '0', cls: 'wpb-tank' }) +
            _fgx('wpv_fc_m', 'Gas-cap ratio m', { def: '0', data: 'data-for="oil"', cls: 'wpb-tank' }) + _fgx('wpv_fc_swi', 'Connate water S_wi', { def: '0.2', data: 'data-for="oil"', cls: 'wpb-tank' }) +
            _fgx('wpv_fc_sgc', 'Critical gas saturation S_gc', { def: '0.05', data: 'data-for="oil"', cls: 'wpb-tank' }) +
            _fgx('wpv_fc_years', 'Horizon', { unit: 'years', def: '10', cls: 'wpb-tank' }) + _fgx('wpv_fc_n', 'Time steps', { def: '24', cls: 'wpb-tank' }) +
            _fgx('wpv_fc_pab', 'Abandonment p̄r', { unit: 'psia', ph: 'none' }) +
            _fgx('wpv_fc_qabo', 'Abandonment rate', { unit: 'STB/d', ph: 'none', data: 'data-for="oil water"', cls: 'wpb-tank' }) + _fgx('wpv_fc_qabg', 'Abandonment rate', { unit: 'Mscf/d', ph: 'none', data: 'data-for="gas condensate"', cls: 'wpb-tank' }) +
            '<div class="wpb-go"><button type="button" class="btn btn-primary" data-act="b27fc">Run the forecast</button><span class="wp-hint">Each step is a system solve warm-started from the step before; the tank mode steps time explicitly (gas p/Z, oil Havlena-Odeh with Corey gas flow above S_gc).</span></div></div>';
    }
    function _ctlTorn() {
        return '<div class="wpb-ctl rp-skip" data-stab="torn">' + _fgx('wpv_tn_frac', 'Range around the model', { unit: '±%', def: '20' }) +
            '<div class="wpb-go"><button type="button" class="btn btn-primary" data-act="b27torn">Run the tornado</button><span class="wp-hint">p̄r ±half the range, water cut ±10 points, the bean ±8/64 in, skin −2 / +5, the next catalogue tubing size each side; the base is the single solve.</span></div></div>';
    }
    function _varOpts(sel) {
        var SN = G.WTS_wp_sens, p = P(), M = p && p.ST ? p.ST.M : null, list = SN && typeof SN.vars === 'function' ? SN.vars(M) : [];
        return '<option value="">— none —</option>' + list.map(function (v) { return '<option value="' + _esc(v.key) + '"' + (v.key === sel ? ' selected' : '') + (v.applicable ? '' : ' disabled') + '>' + _esc(p ? p.sensVarLabel(v.key) : v.label) + '</option>'; }).join('');
    }
    function _ctlMat() {
        var defs = ['wc', 'pr', 'bean', 'gor'], h = '<div class="wpb-ctl rp-skip" data-stab="mat">';
        defs.forEach(function (k, i) {
            h += '<div class="fg-item"><label for="wpv_mx' + (i + 1) + '">Variable ' + (i + 1) + (i >= 2 ? ' (optional)' : '') + '</label><select id="wpv_mx' + (i + 1) + '" data-mxk="' + i + '">' + _varOpts(i < 3 ? k : '') + '</select></div>' +
                '<div class="fg-item"><label for="wpv_mxv' + (i + 1) + '">Values ' + (i + 1) + '</label><input id="wpv_mxv' + (i + 1) + '" type="text" spellcheck="false" autocomplete="off" placeholder="3–5 values"></div>';
        });
        return h + '<div class="wpb-go"><button type="button" class="btn btn-primary" data-act="b27mat">Run the matrix</button><span class="wp-hint" id="wpb_mxn">Full factorial, up to 1,000 cases, each warm-started from a solved neighbour.</span></div></div>';
    }
    function _ctlCases() {
        return '<div class="wpb-ctl rp-skip" data-stab="cases">' + _fgx('wpv_case_name', 'Case name', { text: true, ph: 'e.g. Proposed 3-1/2 in tubing' }) +
            _fgx('wpv_case_kind', 'Kind', { options: [['base', 'Base'], ['matched', 'Matched'], ['proposed', 'Proposed'], ['other', 'Other']], def: 'proposed' }) +
            '<div class="wpb-go"><button type="button" class="btn btn-primary" data-act="b27save">Save the current inputs as a case</button><button type="button" class="btn btn-secondary" data-act="b27compare">Compare the chosen cases</button>' +
            '<span class="wp-hint">A case keeps every input and table of the model (not the tests), per well; up to 20.</span></div></div><div id="wpb_cases" class="rp-skip" data-stab="cases"></div>';
    }
    function resHtml() {
        var p = P(); if (!p) return '';
        var tabs = '<span class="wpb-tabs" id="wpb_tabs" role="tablist" aria-label="Studies">' + TABS.map(function (t) { return '<button type="button" role="tab" data-act="b27tab" data-k="' + t[0] + '">' + _esc(t[1]) + '</button>'; }).join('') + '</span>';
        return CSS + p.card('Studies — envelope, forecast, tornado, matrix and cases',
            _ctlEnv() + _ctlFc() + _ctlTorn() + _ctlMat() + _ctlCases() +
            '<div id="wpb_msg" class="rp-skip" role="status"></div><div class="wp-cmpk" id="wpb_kpi"></div>' +
            '<div class="chart-wrap" id="wpb_cvw"><canvas id="wp_cv_st" tabindex="0" aria-label="Study plot"></canvas></div>' +
            '<div class="wpb-slider rp-skip wp-off" id="wpb_tslider"><label for="wpv_fc_t">Time</label><input type="range" id="wpv_fc_t" min="0" max="1" step="1" value="0" aria-label="Forecast time" aria-describedby="wpb_tval"><b id="wpb_tval">—</b></div>' +
            '<div class="wpb-read" id="wpb_read" aria-live="polite"></div><div id="wpb_body"></div><div class="wp-legend-hint rp-skip" id="wpb_hint"></div>' +
            '<div id="wpb_all"></div><div id="wpb_scr_r" class="rbox wp-off" style="margin-top:10px"></div>', { tools: tabs, id: 'wpb_card' });
    }
    function stepHtml(n) {
        var p = P(); if (!p || n !== 4) return null;
        return p.card('Lift screening', '<div class="wpb-ctl rp-skip">' + _fgx('wpv_sc_pwf', 'Pump potential at pwf', { unit: 'psia', ph: 'max(200, 10 % p̄r)' }) +
            _fgx('wpv_sc_pinj', 'Screening injection pressure', { unit: 'psig', ph: 'step ④ value, else 1000' }) +
            '<div class="wpb-go"><button type="button" class="btn btn-primary" data-act="b27scr">Compare the lift rates</button><span class="wp-hint">The matrix below follows every solve; the button adds the rate under natural flow, gas lift (performance curve) and ESP at the same conditions.</span></div></div>' +
            '<div id="wpb_scmsg" class="rp-skip"></div><div id="wpb_scres"></div>', { id: 'wpb_sccard' });
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    function _tab() { var p = P(), t = p ? p.plots().stTab : null; return TABS.some(function (x) { return x[0] === t; }) ? t : 'env'; }
    function _rc(p) { return p.rateCat(); }
    function _key(p) { var M = p.ST.M; return M ? p.mkey(M) : ''; }
    function _stale(p, k) { return !!(k && k !== _key(p)); }
    function _chip(k, v, s, st) { return '<div class="wp-cmpc' + (st ? ' st-' + st : '') + '"><span class="kpi-l">' + _esc(k) + '</span><span class="kpi-v">' + _esc(v) + '</span>' + (s ? '<em class="kpi-s">' + _esc(s) + '</em>' : '') + '</div>'; }
    function _rcard(k, v, s) { return '<div class="wpb-rc"><span class="k">' + _esc(k) + '</span><span class="v">' + _esc(v) + '</span>' + (s ? '<span class="s">' + _esc(s) + '</span>' : '') + '</div>'; }
    function _msg(html) { var b = _byId('wpb_msg'); if (b) b.innerHTML = html || ''; }
    function _qmain(M, s) { return !s ? null : (_gas(M) ? (_fin(s.qg) ? s.qg : s.q) : s.q); }
    function _staleChip(p) { return '<span class="wp-stalechip">previous inputs — re-run</span>'; }
    function _tagAll() {
        var U = G.WTS_units; if (!U || typeof U.tagInput !== 'function') return;
        Object.keys(UNIT_TAGS).forEach(function (id) { var e = _byId(id); if (e && !(e.dataset && e.dataset.wtsUnitCat)) U.tagInput(id, UNIT_TAGS[id]); });
    }
    function _list(p, id, cat) { return p.parseList(_txt(id)).map(function (v) { return cat ? p.fromDisp(v, cat) : v; }); }

    // ── render (every solve) ─────────────────────────────────────────────────
    function render(live) {
        var p = P(); if (!p || !_byId('wpb_card')) return;
        if (!S.tagged) { _tagAll(); S.tagged = true; }
        if (live) { if (_tab() === 'fcst' && S.fc) _drawFc(p); return; }
        _syncTabs(p);
        _renderTab(p);
        _renderScreen(p);
    }
    function _syncTabs(p) {
        var tab = _tab();
        Array.prototype.forEach.call(document.querySelectorAll('#wpb_tabs button'), function (b) { var on = b.getAttribute('data-k') === tab; if (b.classList) b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
        Array.prototype.forEach.call(document.querySelectorAll('#wpb_card [data-stab]'), function (e) { if (e.classList) e.classList.toggle('wp-off', e.getAttribute('data-stab') !== tab); });
        var mode = (_byId('wpv_fc_mode') || {}).value === 'tank' ? 'tank' : 'steps';
        Array.prototype.forEach.call(document.querySelectorAll('#wpb_card .wpb-steps, #wpb_card .wpb-tank'), function (e) { var isT = e.classList && e.classList.contains('wpb-tank'); if (e.style) e.style.display = (isT === (mode === 'tank')) ? '' : 'none'; });
        var ts = _byId('wpb_tslider'); if (ts && ts.classList) ts.classList.toggle('wp-off', !(tab === 'fcst' && S.fc && S.fc.ok && S.fc.rows.length > 1));
        var cw = _byId('wpb_cvw'); if (cw && cw.classList) cw.classList.toggle('wp-off', tab === 'torn');
        var cvs = _byId('wp_cv_st'); if (cvs && cvs.setAttribute) cvs.setAttribute('aria-label', STUDY_ARIA[tab] || 'Study plot');
        // the matrix variable lists follow the unit system (review fix v4.5: they kept the field-unit labels after a switch to Metric)
        for (var mi = 1; mi <= 4; mi++) { var ms = _byId('wpv_mx' + mi); if (ms && ms.tagName === 'SELECT') { var mv = ms.value, nh = _varOpts(mv); if (ms._wpbOpts !== nh) { ms.innerHTML = nh; ms.value = mv; ms._wpbOpts = nh; } } }
        // the steps list follows the model's p̄r when it is empty
        var st = _byId('wpv_fc_steps'), M = p.ST.M;
        if (st && !String(st.value || '').trim() && M && _fin(M.res.pr)) { var a = []; for (var i = 0; i < 6; i++) a.push(p.fmtListNum(+p.dv(M.res.pr * (1 - 0.1 * i), 'pressure').toPrecision(4))); st.value = a.join(' '); }
    }
    function _renderTab(p) {
        var tab = _tab(), kp = _byId('wpb_kpi'), rd = _byId('wpb_read'), bd = _byId('wpb_body'), hi = _byId('wpb_hint');
        if (kp) kp.innerHTML = ''; if (rd) rd.innerHTML = ''; if (bd) bd.innerHTML = ''; if (hi) hi.innerHTML = '';
        if (tab === 'env') _drawEnv(p);
        else if (tab === 'fcst') _drawFc(p);
        else if (tab === 'torn') _drawTorn(p);
        else if (tab === 'mat') _drawMat(p);
        else _drawCases(p);
        _renderAll(p);
    }

    // ── operating envelope ───────────────────────────────────────────────────
    function _envOpts(p) {
        var M = p.ST.M, gas = _gas(M);
        return { ddMax: _canonVal('wpv_env_dd'), pwfMin: _canonVal('wpv_env_pwf'), pbLimit: _chk('wpv_env_pb'), qFac: _canonVal(gas ? 'wpv_env_qfg' : 'wpv_env_qfo'), eroLimit: _num(_txt('wpv_env_ero')) || 1,
            R: p.ST.Rfull && p.ST.Rfull.ok && !_stale(p, p.ST.lastKey) ? p.ST.Rfull : null };
    }
    var LIM_COL = { stab: 'red', load: 'yellow', rating: 'text2', max: 'green', ero: 'purple', dd: 'blue', pwfMin: 'blue', pb: 'yellow', fac: 'text' };
    function _drawEnv(p) {
        var cv = _byId('wp_cv_st'), V = G.WTS_wp_view; if (!cv || !V) return;
        var r = S.env, M = p.ST.M, T = V.theme(), rc = _rc(p), X = function (q) { return p.dv(q, rc[0]); }, Y = function (v) { return p.dv(v, 'pressureG'); };
        var series = [], markers = [], vlines = [], hlines = [], handles = [], stale = _stale(p, S.envKey);
        var xMax;
        if (r && r.ok) {
            var qCap = Math.max(r.max ? r.max.q * 1.3 : 0, r.window && r.window.ok ? r.window.qHi * 1.15 : 0, r.op ? r.op.q * 1.3 : 0) || Infinity;
            xMax = _fin(qCap) ? X(qCap) : undefined;
            var okP = r.curve.filter(function (c) { return c.ok; });
            var w = r.window;
            if (w && w.ok) {
                var inW = okP.filter(function (c) { return c.q >= w.qLo && c.q <= w.qHi; }), A = WE().at(r, w.qLo), B = WE().at(r, w.qHi), top = [], bot = [];
                if (A) top.push([X(w.qLo), Y(A.thp)]); inW.forEach(function (c) { top.push([X(c.q), Y(c.thp)]); }); if (B) top.push([X(w.qHi), Y(B.thp)]);
                if (B && _fin(B.thpLine)) bot.push([X(w.qHi), Y(B.thpLine)]); inW.slice().reverse().forEach(function (c) { if (_fin(c.thpLine)) bot.push([X(c.q), Y(c.thpLine)]); }); if (A && _fin(A.thpLine)) bot.push([X(w.qLo), Y(A.thpLine)]);
                series.push({ key: 'win', label: 'Operating window (choke Δp)', kind: 'poly', color: T.green, alpha: stale ? 0.07 : 0.18, pts: top.concat(bot) });
                series.push({ key: 'winl', label: '', legend: false, color: T.green, width: 4.5, pts: top });
            }
            series.push({ key: 'del', label: 'Wellhead deliverability (stable)', color: stale ? T.text2 : T.accent, width: 2.6, pts: okP.filter(function (c) { return c.stable; }).map(function (c) { return [X(c.q), Y(c.thp)]; }) });
            series.push({ key: 'delu', label: 'Unstable branch (fixed THP)', color: T.red, width: 1.6, dash: [6, 4], pts: okP.filter(function (c) { return c.q <= r.peak.q + 1e-9; }).map(function (c) { return [X(c.q), Y(c.thp)]; }).concat([[X(r.peak.q), Y(r.peak.thp)]]) });
            var lineP = r.curve.filter(function (c) { return _fin(c.thpLine) && !(c.q > qCap * 1.02); }), lastIn = r.curve.filter(function (c) { return _fin(c.thpLine) && c.q > qCap * 1.02; })[0];
            if (lastIn && lineP.length) { var a0 = lineP[lineP.length - 1], tt = (qCap - a0.q) / (lastIn.q - a0.q); lineP = lineP.concat([{ q: qCap, thpLine: a0.thpLine + tt * (lastIn.thpLine - a0.thpLine) }]); }
            series.push({ key: 'line', label: 'Flowline back pressure', color: T.blue, width: 1.6, dash: [3, 3], pts: lineP.map(function (c) { return [X(c.q), Y(c.thpLine)]; }) });
            Object.keys(r.limits).forEach(function (k) {
                var L = r.limits[k]; if (!_fin(L.q) || k === 'max' || k === 'stab') return;
                vlines.push({ x: X(L.q), color: T[LIM_COL[k]] || T.text2, label: L.label.replace(/ \(.*\)$/, ''), dash: L.kind === 'lower' ? [2, 4] : [6, 3] });
            });
            var rt = M && M.surface.rating ? M.surface.rating.wellhead_psi : null;
            if (_fin(rt)) hlines.push({ y: Y(rt), color: T.red, label: 'wellhead rating' });
            markers.push({ x: X(r.peak.q), y: Y(r.peak.thp), kind: 'hollow', color: T.red, r: 5, label: 'stability limit' });
            if (r.max) markers.push({ x: X(r.max.q), y: Y(r.max.thp), kind: 'diamond', color: T.green, r: 6, label: 'max rate' });
            if (r.op) markers.push({ x: X(r.op.q), y: Y(r.op.thp), kind: 'filled', color: r.op.inside ? T.accent : T.red, r: 7, halo: true, label: 'operating point' });
            var qs = _fin(S.envSel) ? S.envSel : (r.op ? r.op.q : (w && w.ok ? 0.5 * (w.qLo + w.qHi) : r.peak.q)), at = WE().at(r, qs);
            if (at) handles.push({ key: 'env', kind: 'pointX', value: X(qs), y: Y(at.thp), min: X(okP[0].q), max: X(okP[okP.length - 1].q), step: _gas(M) ? 10 : 1, label: 'q', color: T.purple,
                fmt: function (v) { return p.fmt(v, 0) + ' ' + p.lab(rc[0], rc[1]); } });
            _envRead(p, at);
            _envKpis(p, r, stale);
        } else if (r && !r.ok) _msg(p.vHtml({ st: 'fail', t: '✗ ' + ((r.errors || [])[0] || 'no envelope') }));
        V.chart(cv, { key: 'env:' + rc[0] + (p.metric() ? 'm' : 'i'), aspect: p.phone() ? 0.95 : 0.6, minH: 260, maxH: 460, w: 720, readout: 'x',
            x: { label: (_gas(M) ? 'Gas rate' : 'Liquid rate') + ' (' + p.lab(rc[0], rc[1]) + ')', min: 0, max: xMax, short: 'q', fmtR: function (v) { return p.fmt(v, 0) + ' ' + p.lab(rc[0], rc[1]); } },
            y: { label: 'Wellhead pressure (' + p.lab('pressureG', 'psig') + ')', min: 0, short: 'THP', fmtR: function (v) { return p.fmt(v, 0) + ' ' + p.lab('pressureG', 'psig'); } },
            series: series, markers: markers, vlines: vlines, hlines: hlines, handles: handles, legendNote: stale ? 'Faint: previous inputs — re-run' : null,
            empty: 'Run the operating envelope: the wellhead deliverability with every constraint and the operating window.',
            onHandle: function (key, v, phase) {
                if (key !== 'env' || !S.env) return;
                var q = p.fromDisp(v, rc[0]), a = WE().at(S.env, q); if (!a) return;
                var sp = cv._wp && cv._wp.spec, h = sp && sp.handles && sp.handles[0]; if (h) h.y = Y(a.thp);
                S.envSel = q; _envRead(p, a);
                if (phase === 'end') { S.envBean = null; _envRead(p, a, true); }
            } });
        var hi = _byId('wpb_hint'); if (hi) hi.innerHTML = r && r.ok ? 'Drag the purple point along the deliverability curve (or focus the plot, [ then the arrows): the read-out follows; release for the bean that gives that rate. The green band is the operating window; its height at a rate is the choke pressure drop.' : '';
    }
    function WE() { return G.WTS_wp_envelope; }
    function _envRead(p, a, released) {
        var rd = _byId('wpb_read'); if (!rd || !a) return;
        var M = p.ST.M, rc = _rc(p), pr = M ? M.res.pr : null, gas = _gas(M);
        var h = _rcard('Selected rate', p.u(a.q, rc[0], 0, rc[1]), a.inside ? 'inside every limit' : 'outside a limit') + _rcard('THP', p.u(a.thp, 'pressureG', 0, 'psig'), 'line ' + p.u(a.thpLine, 'pressureG', 0, 'psig')) +
            _rcard('Choke Δp', p.u(a.chokeDp, 'pressure', 0, 'psi'), a.chokeDp < 0 ? 'beyond the maximum rate' : '') + _rcard('pwf · drawdown', p.u(a.pwf, 'pressure', 0, 'psia'), _fin(pr) && _fin(a.pwf) ? 'Δp ' + p.u(pr - a.pwf, 'pressure', 0, 'psi') : '') +
            _rcard('Erosional ratio', _fin(a.ero) ? p.fmt(a.ero, 2) : '—', 'tubing') + (gas ? _rcard('Loading margin', _fin(a.loadMargin) ? (a.loadMargin >= 0 ? '+' : '') + p.fmt(100 * a.loadMargin, 0) + ' %' : '—', 'provisional methods') : '');
        h += '<div class="wpb-checks" style="grid-column:1/-1">' + a.checks.map(function (c) { return '<span class="wpb-ck ' + (c.ok ? 'ok' : 'fail') + '" title="' + _esc(c.kind + ' limit ' + p.u(c.q, rc[0], 0, rc[1])) + '">' + (c.ok ? '✓ ' : '✕ ') + _esc(c.label) + '</span>'; }).join('') + '</div>';
        if (released || S.envBean) {
            var b = S.envBean && Math.abs(S.envBean.q - a.q) < 1e-6 * Math.max(1, a.q) ? S.envBean : null;
            h += '<div class="wp-btns rp-skip" style="grid-column:1/-1;margin-top:2px">' + (M && M.surface.choke.present !== false
                ? (b && b.ok ? '<span class="wpb-ck ok">Bean ' + _esc(p.fmt(b.bean, 1)) + '/64 in gives ' + _esc(p.u(b.q, rc[0], 0, rc[1])) + '</span><button type="button" class="btn btn-primary" data-act="adopt" data-id="wp_bean" data-v="' + Math.round(b.bean) + '" data-prov="the operating envelope">Use this bean</button>'
                    : (b && !b.ok ? '<span class="wpb-ck warn">' + _esc((b.errors || [])[0] || 'no bean reaches this rate') + '</span>' : '<button type="button" class="btn btn-secondary" data-act="b27envbean" data-q="' + a.q + '">Bean for this rate</button>'))
                : '<button type="button" class="btn btn-secondary" data-act="adopt" data-id="wp_thp" data-v="' + Math.round(a.thp) + '" data-prov="the operating envelope">Use this THP</button>') + '<span id="wpb_beanbox"></span></div>';
        }
        rd.innerHTML = h;
    }
    function _envKpis(p, r, stale) {
        var kp = _byId('wpb_kpi'); if (!kp) return;
        var rc = _rc(p), w = r.window, lim = r.limits, nm = function (ks) { return ks.map(function (k) { return lim[k] ? lim[k].label.replace(/ \(.*\)$/, '') : k; }).join(', '); };
        kp.innerHTML = (stale ? _staleChip(p) : '') +
            _chip('Operating window', w.ok ? p.fmt(p.dv(w.qLo, rc[0]), 0) + '–' + p.fmt(p.dv(w.qHi, rc[0]), 0) + ' ' + p.lab(rc[0], rc[1]) : 'none', w.ok ? 'THP ' + p.fmt(p.dv(w.thpLo, 'pressureG'), 0) + '–' + p.fmt(p.dv(w.thpHi, 'pressureG'), 0) + ' ' + p.lab('pressureG', 'psig') : nm(w.lo.concat(w.hi)), w.ok ? 'ok' : 'warn') +
            _chip('Binding (low · high)', nm(w.lo) || '—', nm(w.hi) || '—', '') +
            _chip('Operating point', r.op ? p.u(r.op.q, rc[0], 0, rc[1]) : '—', r.op ? (r.op.inside ? 'inside the window' : 'outside: ' + nm(r.op.violated)) : 'no solve', r.op ? (r.op.inside ? 'ok' : 'warn') : '') +
            _chip('Maximum rate', r.max ? p.u(r.max.q, rc[0], 0, rc[1]) : '—', 'choke fully open', '') +
            _chip('Stability limit', p.u(r.peak.q, rc[0], 0, rc[1]), 'THP ' + p.u(r.peak.thp, 'pressureG', 0, 'psig'), '');
    }

    // ── depletion forecast ───────────────────────────────────────────────────
    function _fcSpec(p) {
        var M = p.ST.M, gas = _gas(M), mode = (_byId('wpv_fc_mode') || {}).value === 'tank' ? 'tank' : 'steps';
        var sp = { mode: mode, pAband: _canonVal('wpv_fc_pab') };
        if (mode === 'steps') {
            var prs = _list(p, 'wpv_fc_steps', 'pressure'), wcs = _list(p, 'wpv_fc_wc'), gors = _list(p, 'wpv_fc_gor', 'gor');
            sp.steps = prs.map(function (v, i) { var o = { pr: v }; if (_fin(wcs[i])) o.wc = wcs[i]; if (_fin(gors[i])) o.gor = gors[i]; return o; });
        } else {
            var cum0 = _num(_txt('wpv_fc_cum0'));
            sp.tank = { G_Bscf: _num(_txt('wpv_fc_G')), N_MMstb: _num(_txt('wpv_fc_N')), pi: _canonVal('wpv_fc_pi'), cum0: _fin(cum0) ? cum0 * 1e6 : 0,
                m: _num(_txt('wpv_fc_m')), swi: _num(_txt('wpv_fc_swi')), sgc: _num(_txt('wpv_fc_sgc')) };
            sp.horizon_d = (_num(_txt('wpv_fc_years')) || 10) * 365.25; sp.n = _num(_txt('wpv_fc_n')) || 24;
            sp.qAband = _canonVal(gas ? 'wpv_fc_qabg' : 'wpv_fc_qabo');
        }
        return sp;
    }
    function _fcRow() { var r = S.fc; if (!r || !r.ok || !r.rows.length) return null; var i = Math.max(0, Math.min(r.rows.length - 1, S.fcI || 0)); return r.rows[i]; }
    function _fcX(p, r, row) { return r.mode === 'tank' ? row.t_d / 365.25 : p.dv(row.pr, 'pressure'); }
    function _drawFc(p) {
        var cv = _byId('wp_cv_st'), V = G.WTS_wp_view; if (!cv || !V) return;
        var r = S.fc, M = p.ST.M, T = V.theme(), rc = _rc(p), stale = _stale(p, S.fcKey), gas = _gas(M);
        var view = S.fcView, series = [], markers = [], vlines = [], handles = [], xa, ya;
        var Q = function (row) { var q = gas ? row.qg : row.q; return _fin(q) ? p.dv(q, rc[0]) : null; };
        if (r && r.ok) {
            var rows = r.rows, tank = r.mode === 'tank';
            if (!tank && view !== 'rate') view = 'rate';
            if (view === 'mb' && tank) {
                if (r.kind === 'gas') {
                    var Gb = r.tank.G_Bscf, piz = r.tank.piz;
                    series.push({ key: 'mbl', label: 'p/Z line (G = ' + p.fmt(Gb, 2) + ' Bscf)', color: T.text2, dash: [6, 4], width: 1.4, pts: [[0, p.dv(piz, 'pressure')], [Gb, 0]] });
                    series.push({ key: 'mb', label: 'Forecast steps', kind: 'points', color: T.accent, r: 4, pts: rows.filter(function (x) { return x.mb && _fin(x.mb.poz); }).map(function (x) { return [x.Gp / 1e6, p.dv(x.mb.poz, 'pressure')]; }) });
                    xa = { label: 'Cumulative gas G_p (Bscf)', min: 0, short: 'Gp' }; ya = { label: 'p/Z (' + p.lab('pressure', 'psia') + ')', min: 0, short: 'p/Z' };
                } else {
                    var Nn = r.tank.N_MMstb;
                    var pts = rows.filter(function (x) { return x.mb && _fin(x.mb.Et) && _fin(x.mb.F); }).map(function (x) { return [x.mb.Et, x.mb.F / 1e6]; });
                    var ex = pts.length ? Math.max.apply(null, pts.map(function (q) { return q[0]; })) : 0;
                    series.push({ key: 'mbl', label: 'F = N·E_t (N = ' + p.fmt(Nn, 2) + ' MMSTB)', color: T.text2, dash: [6, 4], width: 1.4, pts: [[0, 0], [ex, Nn * ex]] });
                    series.push({ key: 'mb', label: 'Forecast steps', kind: 'points', color: T.accent, r: 4, pts: pts });
                    xa = { label: 'E_t = E_o + m·E_g + E_f,w (rb/STB)', min: 0, short: 'Et' }; ya = { label: 'F (MMrb)', min: 0, short: 'F' };
                }
            } else {
                var yv = function (row) { return view === 'pr' ? p.dv(row.pr, 'pressure') : view === 'cum' ? (gas ? (row.Gp || 0) / 1e6 : (row.Np || 0) / 1e6) : Q(row); };
                var ok = rows.filter(function (x) { return _fin(yv(x)); });
                series.push({ key: 'y', label: view === 'pr' ? 'Reservoir pressure p̄r' : view === 'cum' ? (gas ? 'Cumulative gas (Bscf)' : 'Cumulative oil (MMSTB)') : (gas ? 'Gas rate' : 'Liquid rate'),
                    color: stale ? T.text2 : (view === 'pr' ? T.green : view === 'cum' ? T.blue : T.accent), width: 2.6, kind: view === 'cum' ? 'area' : 'line', pts: ok.map(function (x) { return [_fcX(p, r, x), yv(x)]; }) });
                if (view === 'rate' && !gas && rows.some(function (x) { return _fin(x.qo); })) series.push({ key: 'qo', label: 'Oil rate', color: T.green, width: 1.6, dash: [5, 3], pts: rows.filter(function (x) { return _fin(x.qo); }).map(function (x) { return [_fcX(p, r, x), p.dv(x.qo, 'liquidRate')]; }) });
                var ph = function (k) { return rows.filter(function (x) { return x.phase === k; }).map(function (x) { return [_fcX(p, r, x), _fin(yv(x)) ? yv(x) : 0]; }); };
                if (ph('loading').length) series.push({ key: 'pl', label: 'Loading', kind: 'points', color: T.yellow, r: 3.5, pts: ph('loading') });
                if (ph('dead').length) series.push({ key: 'pd', label: 'Lift needed', kind: 'points', color: T.red, r: 4.5, pts: ph('dead') });
                var E = r.events;
                if (E.loading) vlines.push({ x: tank ? E.loading.t_d / 365.25 : p.dv(E.loading.pr, 'pressure'), color: T.yellow, label: 'loading starts', dash: [4, 3] });
                if (E.lift) vlines.push({ x: tank ? E.lift.t_d / 365.25 : p.dv(E.lift.pr, 'pressure'), color: T.red, label: 'lift needed', dash: [4, 3] });
                if (E.abandon && _fin(E.abandon.t_d)) vlines.push({ x: E.abandon.t_d / 365.25, color: T.text2, label: 'abandonment', dash: [2, 4] });
                xa = tank ? { label: 'Time (years)', min: 0, short: 't' } : { label: 'Reservoir pressure p̄r (' + p.lab('pressure', 'psia') + ')', short: 'p̄r' };
                ya = { label: view === 'pr' ? 'p̄r (' + p.lab('pressure', 'psia') + ')' : view === 'cum' ? (gas ? 'G_p (Bscf)' : 'N_p (MMSTB)') : 'Rate (' + p.lab(rc[0], rc[1]) + ')', min: 0, short: view === 'pr' ? 'p̄r' : 'y' };
                var cur = _fcRow();
                if (cur && rows.length > 1) {
                    if (tank) handles.push({ key: 'fct', kind: 'lineX', value: _fcX(p, r, cur), min: 0, max: rows[rows.length - 1].t_d / 365.25, step: 0.01, label: 'Time', color: T.purple, fmt: function (v) { return p.fmt(v, 2) + ' y'; } });
                    else markers.push({ x: _fcX(p, r, cur), y: _fin(yv(cur)) ? yv(cur) : 0, kind: 'diamond', color: T.purple, r: 7, label: 'step ' + (cur.i + 1) });
                }
            }
            _fcRead(p);
            _fcKpis(p, r, stale);
        } else if (r && !r.ok) _msg(p.vHtml({ st: 'fail', t: '✗ ' + ((r.errors || [])[0] || 'no forecast') }));
        var seg = r && r.ok && r.mode === 'tank' ? '<span class="wp-seg rp-skip" style="margin:0 0 6px">' + [['rate', 'Rate'], ['pr', 'p̄r'], ['cum', 'Cumulative'], ['mb', 'Material balance']].map(function (o) { return '<button type="button" data-act="b27fcview" data-k="' + o[0] + '" class="' + (view === o[0] ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</span>' : '';
        var bd = _byId('wpb_body'); if (bd) bd.innerHTML = seg + _fcTable(p);
        V.chart(cv, { key: 'fc:' + view + ':' + (r && r.mode) + (p.metric() ? 'm' : 'i'), aspect: p.phone() ? 0.9 : 0.55, minH: 240, maxH: 420, w: 720, readout: 'x', x: xa || { label: 'Time (years)', min: 0 }, y: ya || { label: 'Rate', min: 0 },
            series: series, markers: markers, vlines: vlines, handles: handles, legendNote: stale ? 'Faint: previous inputs — re-run' : null,
            empty: 'Run the forecast: the operating point at each future p̄r, or rate against time from a tank.',
            onHandle: function (key, v, phase) {
                if (key !== 'fct' || !S.fc) return;
                var rows = S.fc.rows, best = 0; rows.forEach(function (x, i) { if (Math.abs(x.t_d / 365.25 - v) < Math.abs(rows[best].t_d / 365.25 - v)) best = i; });
                _fcSet(p, best, phase === 'end');
            } });
        var sl = _byId('wpv_fc_t'), tv = _byId('wpb_tval');
        if (sl && r && r.ok) { sl.max = String(Math.max(1, r.rows.length - 1)); sl.value = String(S.fcI || 0); }
        if (tv) { var cr = _fcRow(); tv.textContent = cr ? (r.mode === 'tank' ? p.fmt(cr.t_d / 365.25, 2) + ' y' : 'step ' + (cr.i + 1)) + ' · p̄r ' + p.u(cr.pr, 'pressure', 0, 'psia') : '—'; }
        var hi = _byId('wpb_hint'); if (hi) hi.innerHTML = r && r.ok ? (r.mode === 'tank' ? 'Drag the time line (or the slider): the operating point of that time and its IPR appear on the system plot. ' : 'Move the slider through the steps: the operating point and IPR of the step appear on the system plot. ') + (r.provisional ? '<span class="wp-chip prov">provisional</span> tank material balance — ' + _esc(r.provisional) + '.' : '') : '';
    }
    function _fcSet(p, i, full) {
        S.fcI = i;
        var sl = _byId('wpv_fc_t'); if (sl) sl.value = String(i);
        _fcRead(p);
        var r = S.fc, cr = _fcRow(), tv = _byId('wpb_tval');
        if (tv && cr) tv.textContent = (r.mode === 'tank' ? p.fmt(cr.t_d / 365.25, 2) + ' y' : 'step ' + (cr.i + 1)) + ' · p̄r ' + p.u(cr.pr, 'pressure', 0, 'psia');
        if (full) _drawFc(p);
        else if (cr && r.mode === 'tank') { var cv = _byId('wp_cv_st'), sp = cv && cv._wp && cv._wp.spec, h = sp && sp.handles && sp.handles[0]; if (h && h.key === 'fct') { h.value = cr.t_d / 365.25; G.WTS_wp_view.redraw(cv); } }
        else if (cr) _drawFc(p);
        p.renderSystemPlot();
        if (full) { p.renderSchematic(); p.renderStudies(); }
    }
    function _fcRead(p) {
        var rd = _byId('wpb_read'), cr = _fcRow(), r = S.fc; if (!rd || !cr) return;
        var M = p.ST.M, rc = _rc(p), gas = _gas(M), ph = { flowing: ['ok', 'flowing'], loading: ['warn', 'loading'], dead: ['fail', 'lift needed'] }[cr.phase] || ['', cr.phase];
        rd.innerHTML = _rcard(r.mode === 'tank' ? 'Time' : 'Step', r.mode === 'tank' ? p.fmt(cr.t_d / 365.25, 2) + ' years' : String(cr.i + 1) + ' of ' + r.rows.length, r.mode === 'tank' ? p.fmt(cr.t_d, 0) + ' days' : '') +
            _rcard('p̄r', p.u(cr.pr, 'pressure', 0, 'psia'), '') + _rcard(gas ? 'Gas rate' : 'Liquid rate', cr.ok ? p.u(gas ? cr.qg : cr.q, rc[0], 0, rc[1]) : '—', cr.ok && !gas && _fin(cr.qo) ? 'oil ' + p.u(cr.qo, 'liquidRate', 0, 'STB/d') : (cr.error || '')) +
            _rcard('pwf · THP', cr.ok ? p.u(cr.pwf, 'pressure', 0, 'psia') : '—', cr.ok ? 'THP ' + p.u(cr.thp, 'pressureG', 0, 'psig') : '') +
            (r.mode === 'tank' ? _rcard(gas ? 'Cumulative gas' : 'Cumulative oil', gas ? p.fmt((cr.Gp || 0) / 1e6, 2) + ' Bscf' : p.fmt((cr.Np || 0) / 1e6, 3) + ' MMSTB', !gas && _fin(cr.gor) ? 'GOR ' + p.u(cr.gor, 'gor', 0, 'scf/STB') : '') : '') +
            (gas ? _rcard('Loading margin', _fin(cr.loadingMargin) ? (cr.loadingMargin >= 0 ? '+' : '') + p.fmt(100 * cr.loadingMargin, 0) + ' %' : '—', _fin(cr.limitingMd) ? p.mdTvdTxt(cr.limitingMd, cr.limitingTvd) : '') : '') +
            '<div class="wpb-checks" style="grid-column:1/-1"><span class="wpb-ck ' + ph[0] + '">' + _esc(ph[1]) + '</span>' + (cr.stable === false && cr.ok ? '<span class="wpb-ck fail">statically unstable</span>' : '') + '</div>';
    }
    function _fcKpis(p, r, stale) {
        var kp = _byId('wpb_kpi'); if (!kp) return;
        var M = p.ST.M, gas = _gas(M), rc = _rc(p), E = r.events, last = r.rows[r.rows.length - 1] || {};
        var when = function (e) { return e ? (r.mode === 'tank' ? p.fmt(e.t_d / 365.25, 1) + ' y' : 'p̄r ' + p.u(e.pr, 'pressure', 0, 'psia')) : 'not in the forecast'; };
        kp.innerHTML = (stale ? _staleChip(p) : '') +
            _chip('First step', r.rows[0] && r.rows[0].ok ? p.u(gas ? r.rows[0].qg : r.rows[0].q, rc[0], 0, rc[1]) : '—', 'p̄r ' + p.u(r.rows[0] && r.rows[0].pr, 'pressure', 0, 'psia'), r.rows[0] && r.rows[0].ok ? 'ok' : 'warn') +
            (gas ? _chip('Liquid loading', when(E.loading), E.loading && _fin(E.loading.md) ? p.mdTvdTxt(E.loading.md, E.loading.tvd) : '', E.loading ? 'warn' : 'ok') : '') +
            _chip('Lift needed', when(E.lift), E.lift ? 'does not flow — lift needed' : 'flows to the end', E.lift ? 'warn' : 'ok') +
            (r.totals ? _chip(gas ? 'Cumulative gas (provisional)' : 'Cumulative oil (provisional)', gas ? p.fmt(r.totals.produced / 1e6, 2) + ' Bscf' : p.fmt(r.totals.produced / 1e6, 3) + ' MMSTB', 'recovery ' + p.fmt(100 * (r.tank.recovery || 0), 1) + ' % · ' + p.fmt((last.t_d || 0) / 365.25, 1) + ' y', 'warn') : '') +
            (r.decline && r.decline.ok ? _chip('Decline cross-check', r.decline.ok && _fin(r.decline.remaining) ? 'remaining ' + p.fmt(r.decline.remaining, 0) + ' ' + ((r.decline.units && r.decline.units.vol) || '') : 'n/a', r.decline.ok ? (r.decline.model || '') + (_fin(r.decline.ratio) ? ' · forecast / decline ' + p.fmt(r.decline.ratio, 2) : '') : (r.decline.reason || ''), '') : '');
    }
    function _fcTable(p) {
        var r = S.fc; if (!r || !r.ok) return '';
        var M = p.ST.M, gas = _gas(M), rc = _rc(p), rows = r.rows, pick = rows.length <= 12 ? rows : rows.filter(function (x, i) { return i % Math.ceil(rows.length / 12) === 0 || i === rows.length - 1; });
        return '<div class="wp-tw"><table class="dtable wp-dense"><thead><tr><th>' + (r.mode === 'tank' ? 'Time (y)' : 'Step') + '</th><th>p̄r (' + p.lab('pressure', 'psia') + ')</th><th>Rate (' + p.lab(rc[0], rc[1]) + ')</th><th>pwf (' + p.lab('pressure', 'psia') + ')</th><th>THP (' + p.lab('pressureG', 'psig') + ')</th>' +
            (gas ? '<th>Loading margin</th>' : '<th>GOR (' + p.lab('gor', 'scf/STB') + ')</th>') + (r.mode === 'tank' ? '<th>' + (gas ? 'G_p (Bscf)' : 'N_p (MMSTB)') + '</th>' : '') + '<th>Phase</th></tr></thead><tbody>' +
            pick.map(function (x) {
                return '<tr><td>' + (r.mode === 'tank' ? p.fmt(x.t_d / 365.25, 2) : String(x.i + 1)) + '</td><td class="num">' + p.fmt(p.dv(x.pr, 'pressure'), 0) + '</td><td class="num">' + (x.ok ? p.fmt(p.dv(gas ? x.qg : x.q, rc[0]), 0) : '—') + '</td><td class="num">' + (x.ok ? p.fmt(p.dv(x.pwf, 'pressure'), 0) : '—') +
                    '</td><td class="num">' + (x.ok ? p.fmt(p.dv(x.thp, 'pressureG'), 0) : '—') + '</td><td class="num">' + (gas ? (_fin(x.loadingMargin) ? p.fmt(100 * x.loadingMargin, 0) + ' %' : '—') : (_fin(x.gor) ? p.fmt(p.dv(x.gor, 'gor'), 0) : '—')) + '</td>' +
                    (r.mode === 'tank' ? '<td class="num">' + p.fmt((gas ? x.Gp : x.Np) / 1e6, 3) + '</td>' : '') + '<td>' + _esc(x.phase === 'dead' ? 'lift needed' : x.phase) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
    }

    // ── tornado ──────────────────────────────────────────────────────────────
    function _drawTorn(p) {
        var r = S.torn, bd = _byId('wpb_body'), kp = _byId('wpb_kpi'); if (!bd) return;
        var M = p.ST.M, rc = _rc(p), stale = _stale(p, S.tornKey);
        if (!r) { bd.innerHTML = '<div class="wp-v info">Run the tornado: the rate at the low and high value of every applicable variable, largest swing first.</div>'; return; }
        if (!r.ok) { bd.innerHTML = p.vHtml({ st: 'fail', t: '✗ ' + ((r.errors || [])[0] || 'no tornado') }); return; }
        var lo = r.q0, hi = r.q0;
        r.bars.forEach(function (b) { [b.qLo, b.qHi].forEach(function (q) { var v = _fin(q) ? q : 0; if (v < lo) lo = v; if (v > hi) hi = v; }); });
        var span = Math.max(1e-9, hi - lo), pc = function (q) { return 100 * ((_fin(q) ? q : 0) - lo) / span; }, b0 = pc(r.q0);
        var vfmt = function (b, v) { return SENS_CAT[b.key] ? p.fmt(p.dv(v, SENS_CAT[b.key]), 3) : p.fmt(v, 3); };
        var unit = function (b) { return SENS_CAT[b.key] ? p.lab(SENS_CAT[b.key], b.unit) : b.unit; };
        if (kp) kp.innerHTML = (stale ? _staleChip(p) : '') + _chip('Base rate', p.u(r.q0, rc[0], 0, rc[1]), 'the single solve', 'ok') +
            r.bars.slice(0, 3).map(function (b, i) { return _chip('#' + (i + 1) + ' ' + b.label.replace(/ \(.*\)$/, ''), '± ' + p.fmt(p.dv(b.swing / 2, rc[0]), 0) + ' ' + p.lab(rc[0], rc[1]), vfmt(b, b.lo) + ' → ' + vfmt(b, b.hi) + ' ' + unit(b), ''); }).join('');
        var h = '<div class="wp-tw' + (stale ? ' wpb-stale' : '') + '"><table class="dtable wpb-torn" aria-label="Tornado: rate at the low and high value of each variable"><thead><tr><th>Variable</th><th class="num">Low</th><th>Rate (' + _esc(p.lab(rc[0], rc[1])) + '): low <span style="color:var(--blue)">■</span> · high <span style="color:var(--accent)">■</span></th><th class="num">High</th><th class="num">Swing</th></tr></thead><tbody>' +
            r.bars.map(function (b) {
                var l = pc(b.qLo), hh = pc(b.qHi), sel = S.tornSel === b.key;
                return '<tr class="' + (sel ? 'wp-sel' : '') + '"><td><button type="button" class="wpb-row" data-act="b27tsel" data-k="' + _esc(b.key) + '" aria-pressed="' + (sel ? 'true' : 'false') + '">' + _esc(b.label.replace(/ \(.*\)$/, '')) + '</button></td>' +
                    '<td class="num">' + _esc(vfmt(b, b.lo)) + ' <span style="color:var(--text3)">' + _esc(unit(b)) + '</span><br><span style="color:var(--blue)">' + (b.okLo ? p.fmt(p.dv(b.qLo, rc[0]), 0) : '✕ ' + _esc(String(b.noteLo).slice(0, 18))) + '</span></td>' +
                    '<td class="bar"><div class="wpb-tb" title="' + _esc(b.label + ': ' + (b.okLo ? p.fmt(p.dv(b.qLo, rc[0]), 0) : 'no flow') + ' → ' + (b.okHi ? p.fmt(p.dv(b.qHi, rc[0]), 0) : 'no flow')) + '">' +
                    '<i class="lo" style="left:' + Math.min(l, b0).toFixed(2) + '%;width:' + Math.abs(b0 - l).toFixed(2) + '%"></i><i class="hi" style="left:' + Math.min(hh, b0).toFixed(2) + '%;width:' + Math.abs(hh - b0).toFixed(2) + '%"></i><s style="left:' + b0.toFixed(2) + '%"></s></div></td>' +
                    '<td class="num">' + _esc(vfmt(b, b.hi)) + ' <span style="color:var(--text3)">' + _esc(unit(b)) + '</span><br><span style="color:var(--accent)">' + (b.okHi ? p.fmt(p.dv(b.qHi, rc[0]), 0) : '✕ ' + _esc(String(b.noteHi).slice(0, 18))) + '</span></td>' +
                    '<td class="num"><b>' + p.fmt(p.dv(b.swing, rc[0]), 0) + '</b></td></tr>';
            }).join('') + '</tbody></table></div>';
        var sb = S.tornSel ? r.bars.filter(function (b) { return b.key === S.tornSel; })[0] : null;
        if (sb) {
            var id = SENS_ID[sb.key];
            h += '<div class="wp-btns rp-skip">' + (id ? '<button type="button" class="btn btn-secondary" data-act="adopt" data-id="' + id + '" data-v="' + sb.lo + '" data-prov="the tornado (low)">Use low (' + _esc(vfmt(sb, sb.lo)) + ')</button><button type="button" class="btn btn-secondary" data-act="adopt" data-id="' + id + '" data-v="' + sb.hi + '" data-prov="the tornado (high)">Use high (' + _esc(vfmt(sb, sb.hi)) + ')</button>'
                : '<span class="wp-hint">' + _esc(sb.label) + ' is set in a table (step ② / ③), not a single input.</span>') + '</div>';
        }
        bd.innerHTML = h;
        var hi2 = _byId('wpb_hint'); if (hi2) hi2.innerHTML = 'Click a variable to select it and use its low or high value. The vertical line is the base rate; blue = the low value, orange = the high value. A case that does not flow counts as rate 0.';
    }

    // ── matrix (three / four variables) ──────────────────────────────────────
    function _mxVars(p) {
        var out = [];
        for (var i = 1; i <= 4; i++) {
            var k = (_byId('wpv_mx' + i) || {}).value || '';
            if (!k) continue;
            var raw = p.parseList(_txt('wpv_mxv' + i)), cat = SENS_CAT[k];
            var vals = k === 'tubingId' ? _txt('wpv_mxv' + i).split(/[;\s]+/).filter(Boolean).map(function (t) { var x = _num(t); return _fin(x) ? p.fromDisp(x, 'lengthSmall') : t; }) : raw.map(function (v) { return cat ? p.fromDisp(v, cat) : v; });
            out.push({ key: k, values: vals });
        }
        return out;
    }
    function _mxSuggest(p, i) {
        var SN = G.WTS_wp_sens, M = p.ST.M, sel = _byId('wpv_mx' + i), box = _byId('wpv_mxv' + i); if (!SN || !M || !sel || !box) return;
        var k = sel.value; if (!k) { box.value = ''; return; }
        var sg = SN.suggest(M, k, 3); if (!sg || !sg.ok) return;
        var cat = SENS_CAT[k];
        box.value = sg.values.map(function (v) { return p.fmtListNum(+(cat ? p.dv(v, cat) : v).toPrecision(4)); }).join(' ');
        _mxCount(p);
    }
    function _mxCount(p) { var vs = _mxVars(p), n = vs.reduce(function (a, v) { return a * Math.max(1, v.values.length); }, 1), e = _byId('wpb_mxn'); if (e) e.textContent = vs.length + ' variable' + (vs.length === 1 ? '' : 's') + ' · ' + n + ' case' + (n === 1 ? '' : 's') + (n > 1000 ? ' — too many (≤ 1,000)' : '') + ' · each warm-started from a solved neighbour.'; }
    // a short variable name and its display unit for the best-case labels (review fix v4.5: '0 · 3,300 · 48' had no labels)
    var MX_SHORT = { wc: 'WC', pr: 'p̄r', bean: 'bean', gor: 'GOR', glr: 'GLR', thp: 'THP', psep: 'p_sep', tubingId: 'tubing', J: 'J', skin: 'S', kh: 'kh', wgr: 'WGR', cgr: 'CGR' };
    function _mxShort(p, r, d) { return MX_SHORT[r.keys[d]] || r.labels[d].replace(/ \(.*\)$/, ''); }
    function _mxUnit(p, r, d) { var k = r.keys[d], u = r.units && r.units[d]; if (r.axes[d].labels && r.axes[d].labels.some(Boolean)) return ''; if (k === 'bean') return '/64'; if (k === 'wc') return ' %'; return u ? ' ' + (SENS_CAT[k] ? p.lab(SENS_CAT[k], u) : u) : ''; }
    function _mxFlat(r, ix) { var f = 0; for (var d = 0; d < ix.length; d++) f += ix[d] * r.strides[d]; return f; }
    function _drawMat(p) {
        var r = S.mat, bd = _byId('wpb_body'), kp = _byId('wpb_kpi'), cv = _byId('wp_cv_st'), V = G.WTS_wp_view; if (!bd || !cv || !V) return;
        var M = p.ST.M, rc = _rc(p), T = V.theme(), stale = _stale(p, S.matKey);
        // fill empty value boxes from the suggestions (first visit)
        for (var i0 = 1; i0 <= 4; i0++) { var bx = _byId('wpv_mxv' + i0), sl0 = _byId('wpv_mx' + i0); if (bx && sl0 && sl0.value && !String(bx.value || '').trim()) _mxSuggest(p, i0); }
        _mxCount(p);
        if (!r || !r.ok || !r.nd) {
            bd.innerHTML = r && !r.ok ? p.vHtml({ st: 'fail', t: '✗ ' + ((r.errors || [])[0] || 'no matrix') }) : '<div class="wp-v info">Choose three or four variables and their values, then run the matrix: a heat map of any two with sliders for the others.</div>';
            V.chart(cv, { key: 'mx:none', aspect: 0.5, minH: 200, maxH: 360, w: 720, x: { label: '' }, y: { label: 'Rate' }, series: [], empty: 'The rate lines of the matrix appear here.' });
            return;
        }
        var D = r.keys.length, xy = S.matXY.slice(); if (!(xy[0] < D) || !(xy[1] < D) || xy[0] === xy[1]) xy = [0, 1];
        var others = []; for (var d = 0; d < D; d++) if (d !== xy[0] && d !== xy[1]) others.push(d);
        others.forEach(function (d2) { if (!(S.matSlice[d2] >= 0 && S.matSlice[d2] < r.axes[d2].values.length)) S.matSlice[d2] = r.start[d2]; });
        var lab = function (d2, i) { var ax = r.axes[d2], v = ax.values[i]; return ax.labels[i] || p.fmt(SENS_CAT[ax.key] ? p.dv(v, SENS_CAT[ax.key]) : v, 3); };
        var cellIx = function (ix0, ix1) { var ix = []; for (var d3 = 0; d3 < D; d3++) ix[d3] = d3 === xy[0] ? ix0 : d3 === xy[1] ? ix1 : S.matSlice[d3]; return ix; };
        var qs = r.q.filter(_fin), qmin = qs.length ? Math.min.apply(null, qs) : 0, qmax = qs.length ? Math.max.apply(null, qs) : 1;
        var best = r.cases.filter(function (c) { return c.R.ok && c.R.stable; }).sort(function (a, b) { return b.R.q - a.R.q; }).slice(0, 5);
        if (kp) kp.innerHTML = (stale ? _staleChip(p) : '') + _chip('Cases', String(r.cases.length), r.labels.map(function (l) { return l.replace(/ \(.*\)$/, ''); }).join(' × '), '') +
            _chip('Rate range', p.fmt(p.dv(qmin, rc[0]), 0) + '–' + p.fmt(p.dv(qmax, rc[0]), 0) + ' ' + p.lab(rc[0], rc[1]), r.cases.filter(function (c) { return !c.R.ok; }).length + ' do not flow', '') +
            (best[0] ? _chip('Best stable case', p.u(best[0].R.q, rc[0], 0, rc[1]), r.keys.map(function (k, d4) { return _mxShort(p, r, d4) + ' ' + lab(d4, best[0].idx[d4]) + _mxUnit(p, r, d4); }).join(' · '), 'ok') : '');
        var axSel = function (id, cur) { return '<select id="' + id + '" aria-label="' + (id === 'wpv_mxax' ? 'Heat-map columns' : 'Heat-map rows') + '">' + r.keys.map(function (k, d5) { return '<option value="' + d5 + '"' + (d5 === cur ? ' selected' : '') + '>' + _esc(r.labels[d5].replace(/ \(.*\)$/, '')) + '</option>'; }).join('') + '</select>'; };
        var h = '<div class="wpb-ctl rp-skip" style="margin-top:2px"><div class="fg-item"><label for="wpv_mxax">Columns</label>' + axSel('wpv_mxax', xy[0]) + '</div><div class="fg-item"><label for="wpv_mxay">Rows</label>' + axSel('wpv_mxay', xy[1]) + '</div>' +
            others.map(function (d6) { var ax = r.axes[d6]; return '<div class="fg-item"><label for="wpv_mxs' + d6 + '">' + _esc(r.labels[d6].replace(/ \(.*\)$/, '')) + ': <b>' + _esc(lab(d6, S.matSlice[d6])) + '</b></label><input type="range" id="wpv_mxs' + d6 + '" data-mxd="' + d6 + '" min="0" max="' + (ax.values.length - 1) + '" step="1" value="' + S.matSlice[d6] + '"></div>'; }).join('') + '</div>';
        h += '<div class="wp-tw' + (stale ? ' wpb-stale' : '') + '"><table class="dtable wpb-heat" aria-label="Rate for each pair of values at the selected slice"><thead><tr><th>' + _esc(r.labels[xy[1]].replace(/ \(.*\)$/, '')) + ' / ' + _esc(r.labels[xy[0]].replace(/ \(.*\)$/, '')) + '</th>' +
            r.axes[xy[0]].values.map(function (v, i) { return '<th class="num">' + _esc(lab(xy[0], i)) + '</th>'; }).join('') + '</tr></thead><tbody>' +
            r.axes[xy[1]].values.map(function (v, j) {
                return '<tr><th>' + _esc(lab(xy[1], j)) + '</th>' + r.axes[xy[0]].values.map(function (v2, i) {
                    var f = _mxFlat(r, cellIx(i, j)), q = r.q[f], on = S.matSel === f, fr = qmax > qmin ? (q - qmin) / (qmax - qmin) : 0.5, col = _fin(q) ? V.ramp(fr) : 'transparent';
                    return '<td class="wp-hc' + (on ? ' on' : '') + (_fin(q) ? (fr < 0.3 ? ' dk' : '') : ' na') + '" style="background:' + col + '"><button type="button" data-act="b27mxcell" data-f="' + f + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + _esc(lab(xy[0], i) + ', ' + lab(xy[1], j) + ': ' + (_fin(q) ? p.fmt(p.dv(q, rc[0]), 0) : 'no flow')) + '">' + (_fin(q) ? p.fmt(p.dv(q, rc[0]), 0) + (r.stable[f] === false ? ' ✗' : '') : '—') + '</button></td>';
                }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>';
        var sc = _fin(S.matSel) ? r.cases[S.matSel] : null;
        if (sc) {
            var ids = [], vs = [];
            r.keys.forEach(function (k, d7) { if (SENS_ID[k]) { ids.push(SENS_ID[k]); vs.push(sc.values[k]); } });
            h += '<div class="wp-btns rp-skip"><span class="wpb-ck ok">Selected: ' + _esc(r.keys.map(function (k, d8) { return r.labels[d8].replace(/ \(.*\)$/, '') + ' ' + lab(d8, sc.idx[d8]); }).join(' · ')) + ' → ' + (sc.R.ok ? _esc(p.u(sc.R.q, rc[0], 0, rc[1])) : 'no flow') + '</span>' +
                (ids.length ? '<button type="button" class="btn btn-primary" data-act="adopt" data-ids="' + ids.join(',') + '" data-vs="' + vs.join(',') + '" data-prov="the sensitivity matrix">Use these values</button>' : '') + '</div>';
        }
        if (best.length) h += '<div class="wp-hint" style="margin-top:8px">Best stable cases: ' + best.map(function (c) { return _esc(r.keys.map(function (k, d9) { return lab(d9, c.idx[d9]); }).join(' · ')) + ' → <b>' + p.fmt(p.dv(c.R.q, rc[0]), 0) + '</b>'; }).join(' &nbsp;|&nbsp; ') + ' ' + _esc(p.lab(rc[0], rc[1])) + '</div>';
        bd.innerHTML = h;
        // the plot: rate against the column variable, a line per row value at the slice
        var series = [], markers = [];
        r.axes[xy[1]].values.forEach(function (v, j) {
            var pts = r.axes[xy[0]].values.map(function (v2, i) { var f = _mxFlat(r, cellIx(i, j)); return [SENS_CAT[r.axes[xy[0]].key] ? p.dv(v2, SENS_CAT[r.axes[xy[0]].key]) : v2, _fin(r.q[f]) ? p.dv(r.q[f], rc[0]) : null]; }).filter(function (q2) { return _fin(q2[1]); });
            var colr = V.ramp(r.axes[xy[1]].values.length > 1 ? j / (r.axes[xy[1]].values.length - 1) : 0.5);
            series.push({ key: 'r' + j, label: r.labels[xy[1]].replace(/ \(.*\)$/, '') + ' ' + lab(xy[1], j), color: colr, width: 2.2, pts: pts });
            series.push({ key: 'p' + j, label: '', legend: false, kind: 'points', color: colr, r: 3.5, pts: pts });
        });
        if (sc && others.every(function (d10) { return sc.idx[d10] === S.matSlice[d10]; })) { var xv = r.axes[xy[0]].values[sc.idx[xy[0]]]; markers.push({ x: SENS_CAT[r.axes[xy[0]].key] ? p.dv(xv, SENS_CAT[r.axes[xy[0]].key]) : xv, y: sc.R.ok ? p.dv(sc.R.q, rc[0]) : 0, kind: 'filled', color: T.text, r: 7, halo: true, label: 'selected' }); }
        V.chart(cv, { key: 'mx:' + r.keys.join(',') + ':' + xy.join(','), aspect: p.phone() ? 0.9 : 0.5, minH: 220, maxH: 380, w: 720, readout: 'x',
            x: { label: r.labels[xy[0]] + (SENS_CAT[r.axes[xy[0]].key] ? ' (' + p.lab(SENS_CAT[r.axes[xy[0]].key], r.units[xy[0]]) + ')' : (r.units[xy[0]] ? ' (' + r.units[xy[0]] + ')' : '')), short: 'x' },
            y: { label: 'Rate (' + p.lab(rc[0], rc[1]) + ')', min: 0, short: 'q' }, series: series, markers: markers, legendNote: stale ? 'Previous inputs — re-run' : null });
    }

    // ── cases ────────────────────────────────────────────────────────────────
    function _cases(p) { var M = p.ST.M; return (M && Array.isArray(M.cases)) ? M.cases : []; }
    var CASE_SEL = {};
    function _drawCases(p) {
        var box = _byId('wpb_cases'), bd = _byId('wpb_body'), kp = _byId('wpb_kpi'), cv = _byId('wp_cv_st'), V = G.WTS_wp_view; if (!box || !cv || !V) return;
        var list = _cases(p), M = p.ST.M, rc = _rc(p), T = V.theme(), cmp = S.cmp, stale = _stale(p, S.cmpKey);
        box.innerHTML = list.length ? '<div class="wpb-cases">' + list.map(function (c) {
            var s = c.summary || {}, on = !!CASE_SEL[c.id], q = _qmain(M, s);
            return '<div class="wpb-case k-' + _esc(c.kind) + (on ? ' on' : '') + '"><div class="n"><span title="' + _esc(c.name) + '">' + _esc(c.name) + '</span><span class="wp-chip">' + _esc(KIND_LAB[c.kind] || c.kind) + '</span></div>' +
                '<div class="q">' + (s.ok ? _esc(p.u(q, rc[0], 0, rc[1])) : '—') + '</div><div class="m">' + _esc(c.date || '') + (s.ok ? ' · pwf ' + _esc(p.u(s.pwf, 'pressure', 0, 'psia')) : '') + '</div>' +
                '<div class="a"><button type="button" class="btn ' + (on ? 'btn-primary' : 'btn-secondary') + '" data-act="b27csel" data-id="' + _esc(c.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + (on ? '✓ in comparison' : 'Compare') + '</button><button type="button" class="btn btn-secondary" data-act="b27load" data-id="' + _esc(c.id) + '">Load</button><button type="button" class="btn btn-secondary" data-act="b27del" data-id="' + _esc(c.id) + '" aria-label="Delete case ' + _esc(c.name) + '">Delete</button></div></div>';
        }).join('') + '</div>' : '<div class="wp-v info">No case yet: name the current inputs and save them (base, matched to a test, proposed…).</div>';
        var series = [], markers = [];
        if (cmp && cmp.ok) {
            var pal = [T.accent, T.blue, T.green, T.purple, T.yellow, T.red, '#39c5cf', T.text2];
            cmp.rows.forEach(function (r, i) {
                var col = pal[i % pal.length];
                if (r.curves.ipr.length) series.push({ key: 'i' + i, label: r.name + ' — inflow', color: col, width: 2, pts: r.curves.ipr.map(function (c) { return [p.dv(c.q, rc[0]), p.dv(c.p, 'pressure')]; }) });
                if (r.curves.vlp.length) series.push({ key: 'v' + i, label: r.name + ' — outflow', color: col, width: 1.6, dash: [6, 4], pts: r.curves.vlp.map(function (c) { return [p.dv(c.q, rc[0]), p.dv(c.p, 'pressure')]; }) });
                if (r.op) markers.push({ x: p.dv(r.op.q, rc[0]), y: p.dv(r.op.p, 'pressure'), kind: r.R.stable ? 'filled' : 'hollow', color: col, r: 6, label: r.name });
            });
            if (kp) kp.innerHTML = (stale ? _staleChip(p) : '') + cmp.rows.map(function (r, i) { var q = _qmain(M, r.R); return _chip(r.name, r.R.ok ? p.u(q, rc[0], 0, rc[1]) : 'no flow', i === 0 ? 'reference' : (_fin(r.dqPct) ? (r.dqPct >= 0 ? '+' : '') + p.fmt(r.dqPct, 1) + ' % vs ' + cmp.rows[0].name : ''), r.R.ok ? (i === 0 || !_fin(r.dqPct) ? '' : r.dqPct >= 0 ? 'ok' : 'warn') : 'warn'); }).join('');
            if (bd) bd.innerHTML = '<div class="wp-tw' + (stale ? ' wpb-stale' : '') + '"><table class="dtable wp-dense"><thead><tr><th>Case</th><th>Rate (' + _esc(p.lab(rc[0], rc[1])) + ')</th><th>Δ vs first</th><th>pwf (' + _esc(p.lab('pressure', 'psia')) + ')</th><th>THP (' + _esc(p.lab('pressureG', 'psig')) + ')</th><th>Stable</th><th>Inputs that differ from the first</th></tr></thead><tbody>' +
                cmp.rows.map(function (r, i) {
                    var d = r.diff || { scalars: [], tables: [] }, names = d.scalars.map(function (x) { return _ctlLabel(x.id); }).concat(d.tables.map(function (x) { return x.key + ' table'; }));
                    return '<tr><td>' + _esc(r.name) + '</td><td class="num">' + (r.R.ok ? p.fmt(p.dv(_qmain(M, r.R), rc[0]), 0) : '—') + '</td><td class="num">' + (i && _fin(r.dqPct) ? (r.dqPct >= 0 ? '+' : '') + p.fmt(r.dqPct, 1) + ' %' : '—') + '</td><td class="num">' + (r.R.ok ? p.fmt(p.dv(r.R.pwf, 'pressure'), 0) : '—') + '</td><td class="num">' + (r.R.ok ? p.fmt(p.dv(r.R.thp, 'pressureG'), 0) : '—') + '</td><td>' + (r.R.ok ? (r.R.stable ? 'yes' : 'no') : _esc(String(r.R.error || '').slice(0, 40))) + '</td><td style="white-space:normal">' + _esc(i ? (names.slice(0, 8).join(', ') + (names.length > 8 ? ' …' : '') || 'none') : '—') + '</td></tr>';
                }).join('') + '</tbody></table></div>';
        } else if (bd) bd.innerHTML = '<div class="wp-hint">Choose two or more cases and compare them: the IPR and outflow of each on one plot, the rate change against the first and the inputs that differ.</div>';
        V.chart(cv, { key: 'cases:' + rc[0], aspect: p.phone() ? 0.9 : 0.55, minH: 240, maxH: 420, w: 720, readout: 'x', x: { label: 'Rate (' + p.lab(rc[0], rc[1]) + ')', min: 0, short: 'q' }, y: { label: 'Bottom-hole pressure (' + p.lab('pressure', 'psia') + ')', min: 0, short: 'p' },
            series: series, markers: markers, legendNote: stale ? 'Previous inputs — re-run' : null, empty: 'Compare the ticked cases to overlay their inflow and outflow curves.' });
    }
    function _ctlLabel(id) {
        var l = typeof document !== 'undefined' && document.querySelector ? document.querySelector('label[for="' + id + '"]') : null;
        var t = l ? String(l.textContent || '').replace(/\s*\(.*$/, '').trim() : '';
        return t || id;
    }
    function _saveCase(p) {
        var C = G.WTS_wp_cases, Mm = G.WTS_wp_model, M = p.ST.M; if (!C || !Mm || !M) return;
        var name = String(_txt('wpv_case_name') || '').trim() || ('Case ' + (_cases(p).length + 1));
        var rec = Mm.readRaw ? Mm.readRaw() : null, tables = {};
        (C.TABLES || []).forEach(function (k) { if (rec && rec.rec && rec.rec[k] !== undefined) tables[k] = rec.rec[k]; });
        var mk = C.make({ name: name, kind: (_byId('wpv_case_kind') || {}).value || 'proposed', scalars: p.liveScalars(), tables: tables, R: p.ST.R && p.ST.R.ok ? p.ST.R : null });
        if (!mk.ok) { _msg(p.vHtml({ st: 'warn', t: '⚠ ' + mk.errors.join(' · ') })); return; }
        var ad = C.add(_cases(p), mk.case);
        if (!ad.ok) { _msg(p.vHtml({ st: 'warn', t: '⚠ ' + ad.errors.join(' · ') })); return; }
        p.ST.batch = true; var w = Mm.write({ cases: ad.list }); p.ST.batch = false;
        if (!w.ok) { _msg(p.vHtml({ st: 'fail', t: '✗ ' + (w.errors || ['the case could not be saved']).join(' · ') })); return; }
        CASE_SEL[ad.list.filter(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })[0].id] = true;
        p.ST.M = p.read();
        _msg(p.vHtml({ st: 'ok', t: '✓ Case "' + name + '" ' + (ad.replaced ? 'updated' : 'saved') + ' (' + ad.list.length + ' of ' + C.MAX + ').' }));
        _drawCases(p); p.renderStudies();
    }
    function _loadCase(p, id) {
        var C = G.WTS_wp_cases, Mm = G.WTS_wp_model, c = _cases(p).filter(function (x) { return x.id === id; })[0]; if (!C || !Mm || !c) return;
        var last = null;
        Object.keys(c.scalars || {}).forEach(function (cid) {
            var v = c.scalars[cid], e = _byId(cid); if (!e) return;
            if (cid === 'wp_gl_qlist' && Array.isArray(v)) { p.setCtrl(cid, v.map(function (x) { return p.fmtListNum(+p.dv(x, 'gasRateSmall').toPrecision(6)); }).join(' ')); last = cid; return; }
            p.setCtrl(cid, v == null ? '' : v, true); last = cid;
        });
        var tb = {}; Object.keys(c.tables || {}).forEach(function (k) { if (c.tables[k] != null) tb[k] = c.tables[k]; });
        p.ST.batch = true; if (Object.keys(tb).length) Mm.write(tb); p.ST.batch = false;
        p.renderAllTables(); p.syncUi();
        _msg(p.vHtml({ st: 'ok', t: '✓ Case "' + c.name + '" loaded into the inputs.' }));
        if (last) p.commit(last); else G.calcWellPerf();
    }
    function _delCase(p, id) {
        var C = G.WTS_wp_cases, Mm = G.WTS_wp_model; if (!C || !Mm) return;
        var r = C.remove(_cases(p), id); delete CASE_SEL[id];
        p.ST.batch = true; Mm.write({ cases: r.list }); p.ST.batch = false; p.ST.M = p.read();
        if (S.cmp && S.cmp.rows.some(function (x) { return x.id === id; })) S.cmp = null;
        _drawCases(p); p.renderStudies();
    }

    // ── lift screening (step ④) ──────────────────────────────────────────────
    var SC_COLS = [['tvd', 'Depth'], ['rate', 'Rate'], ['inc', 'Inclination'], ['dls', 'Dogleg'], ['temp', 'BHT'], ['api', 'Gravity'], ['glr', 'Free gas'], ['window', 'Setting window'], ['other', 'Other']];
    function _renderScreen(p) {
        var box = _byId('wpb_scres'), SC = G.WTS_wp_screen, M = p.ST.M; if (!box || !SC || !M) return;
        var mx = SC.matrix(M, { R: p.ST.R && p.ST.R.ok ? p.ST.R : null, W: p.ST.W && p.ST.W.ok ? p.ST.W : null }); if (!mx || !mx.ok) { box.innerHTML = ''; return; }
        S.scrMx = mx;
        var sym = { ok: '✓', warn: '!', fail: '✕', na: '–' }, rc = _rc(p), w = mx.well;
        var cell = function (m, key) {
            var cs = m.checks.filter(function (c) { return key === 'other' ? ['tvd', 'rate', 'inc', 'dls', 'temp', 'api', 'glr', 'window'].indexOf(c.key) === -1 : c.key === key; });
            if (!cs.length) return '<td class="c"><span class="wp-qcb">–</span></td>';
            var worst = cs.some(function (c) { return c.st === 'fail'; }) ? 'fail' : cs.some(function (c) { return c.st === 'warn'; }) ? 'warn' : cs.every(function (c) { return c.st === 'na'; }) ? 'na' : 'ok';
            return '<td class="c"><span class="wp-qcb ' + worst + '" title="' + _esc(cs.map(function (c) { return c.label + ': ' + (p.msgU ? p.msgU(c.msg) : c.msg); }).join(' · ')) + '">' + sym[worst] + '</span></td>';
        };
        var ranked = mx.methods.filter(function (m) { return m.key !== 'natural'; }).slice().sort(function (a, b) { return a.rank - b.rank; });
        var h = '<div class="wp-cmpk">' + _chip('Well', p.u(w.tvd, 'length', 0, 'ft') + ' TVD', p.u(w.md, 'length', 0, 'ft') + ' MD · max ' + p.fmt(w.maxInc, 1) + '° · ' + (p.dls ? p.dls(w.maxDls) : p.fmt(w.maxDls, 1) + '°/100 ft'), '') +
            _chip('Natural flow', mx.methods[0].verdict === 'ok' ? 'flows' : mx.methods[0].verdict === 'warn' ? 'marginal' : 'does not flow', _fin(w.qL) ? p.u(w.qL, 'liquidRate', 0, 'STB/d') + ' liquid' : '', mx.methods[0].verdict) +
            _chip('Best screened lift', ranked[0] ? ranked[0].label : '—', ranked[1] ? 'then ' + ranked[1].label : '', ranked[0] ? ranked[0].verdict : '') +
            (mx.windows.esp ? _chip('ESP setting window', 'MD ' + p.fmt(p.dv(mx.windows.esp.md0, 'length'), 0) + '–' + p.fmt(p.dv(mx.windows.esp.md1, 'length'), 0) + ' ' + p.lab('length', 'ft'), 'TVD ' + p.fmt(p.dv(mx.windows.esp.tvd0, 'length'), 0) + '–' + p.fmt(p.dv(mx.windows.esp.tvd1, 'length'), 0) + ' ' + p.lab('length', 'ft') + ' · ≤ ' + (p.dls ? p.dls(3) : '3°/100 ft'), 'ok') : '') + '</div>';
        h += '<div class="wp-tw"><table class="dtable wpb-sc wp-qc" aria-label="Lift screening matrix"><thead><tr><th>Method</th><th>Verdict</th>' + SC_COLS.map(function (c) { return '<th class="c">' + c[1] + '</th>'; }).join('') + '</tr></thead><tbody>' +
            mx.methods.map(function (m) { return '<tr><td>' + _esc(m.label) + (m.rank ? ' <span style="color:var(--text3)">#' + m.rank + '</span>' : '') + '</td><td><span class="wpb-vd ' + m.verdict + '">' + { ok: 'suitable', warn: 'marginal', fail: 'unsuitable' }[m.verdict] + '</span></td>' + SC_COLS.map(function (c) { return cell(m, c[0]); }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
        var j = S.scr, stale = _stale(p, S.scrKey);
        if (j && j.ok) {
            var vals = [['Natural flow', j.natural.ok ? j.natural.q : null, j.natural.ok ? '' : (j.natural.error || '')], ['Gas lift (optimum)', j.gaslift && j.gaslift.ok ? j.gaslift.qL : null, j.gaslift ? (j.gaslift.ok ? 'at ' + p.u(j.gaslift.qinj, 'gasRateSmall', 0, 'Mscf/d') + (j.gaslift.assumedPinj ? ' (screening ' + p.u(j.gaslift.pinj_psig, 'pressureG', 0, 'psig') + ')' : '') : j.gaslift.error) : ''],
                ['ESP', j.esp && j.esp.ok ? j.esp.q : null, j.esp ? (j.esp.ok ? '' : j.esp.error) : ''], ['Pump potential', j.potential ? j.potential.q : null, j.potential ? 'inflow at pwf ' + p.u(j.potential.pwf, 'pressure', 0, 'psia') : '']];
            var top = Math.max.apply(null, vals.map(function (v) { return _fin(v[1]) ? v[1] : 0; }).concat([1]));
            h += '<div class="wpb-rates' + (stale ? ' wpb-stale' : '') + '" role="list" aria-label="Rate under each lift method">' + vals.map(function (v, i) {
                return '<div class="wpb-rate" role="listitem"><span>' + _esc(v[0]) + '</span><span class="t"><i style="width:' + (_fin(v[1]) ? Math.max(1, 100 * v[1] / top).toFixed(1) : 0) + '%;background:' + ['var(--accent)', 'var(--blue)', 'var(--purple)', 'var(--text3)'][i] + '"></i></span><b>' + (_fin(v[1]) ? _esc(p.u(v[1], rc[0], 0, rc[1])) : '—') + '</b>' + (v[2] ? '<span class="wp-hint" style="grid-column:1/-1;margin:-4px 0 0">' + _esc(String(v[2]).slice(0, 160)) + '</span>' : '') + '</div>';
            }).join('') + '</div>' + (stale ? _staleChip(p) : '');
        }
        h += '<div class="wp-hint"><span class="wp-chip prov">provisional</span> Screening aid: ' + _esc(mx.source) + ' — ' + _esc(mx.provisional) + '. Rod pump, progressing-cavity, jet pump and plunger lift are screened only (no rate model in this release).</div>';
        box.innerHTML = h;
        _renderScreenRes(p, mx, ranked);
    }

    // the screening ranking inside #wp_res (review fix v4.5: the step ④ table is not in a report taken from another step): shown with a
    // lift type chosen or after "Compare the lift rates"
    function _scrShown(p) { var M = p.ST.M; return !!(M && ((M.lift && M.lift.type !== 'none') || S.scr)); }
    function _renderScreenRes(p, mx, ranked) {
        var h = _byId('wpb_scr_r'); if (!h) return;
        if (!mx || !mx.ok || !_scrShown(p)) { h.innerHTML = ''; if (h.classList) h.classList.add('wp-off'); return; }
        if (h.classList) h.classList.remove('wp-off');
        var j = S.scr && S.scr.ok && !_stale(p, S.scrKey) ? S.scr : null, rc = _rc(p);
        var rate = function (k) { if (!j) return '—'; var v = k === 'gaslift' ? (j.gaslift && j.gaslift.ok ? j.gaslift.qL : null) : k === 'esp' ? (j.esp && j.esp.ok ? j.esp.q : null) : k === 'natural' ? (j.natural.ok ? j.natural.q : null) : null; return _fin(v) ? p.u(v, rc[0], 0, rc[1]) : '—'; };
        h.innerHTML = '<div class="rbox-title">Lift screening (provisional)</div><div class="wp-tw"><table class="dtable wp-dense" aria-label="Lift screening ranking"><thead><tr><th>Method</th><th class="num">Rank</th><th>Verdict</th><th class="num">Rate</th></tr></thead><tbody>' +
            mx.methods.map(function (m) { return '<tr><td>' + _esc(m.label) + '</td><td class="num">' + (m.rank ? '#' + m.rank : '—') + '</td><td>' + _esc(VD_WORD[m.verdict] || m.verdict) + '</td><td class="num">' + _esc(rate(m.key)) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
            '<div class="rrow"><span class="rl">Best screened lift</span><span class="rv">' + _esc(ranked[0] ? ranked[0].label + ' (' + (VD_WORD[ranked[0].verdict] || '') + ')' : '—') + '</span></div>';
    }
    // every study that has results, as a compact table inside #wp_res, except the one on screen (its own body shows it): the page report
    // and the Quick Report then carry all of them whichever tab is open (review fix v4.5)
    function _renderAll(p) {
        var h = _byId('wpb_all'); if (!h) return;
        var tab = _tab(), rc = _rc(p), M = p.ST.M, out = [], q = function (v) { return _fin(v) ? p.fmt(p.dv(v, rc[0]), 0) : '—'; }, ql = _esc(p.lab(rc[0], rc[1]));
        var box = function (t, body) { out.push('<div class="rbox" style="margin-top:10px"><div class="rbox-title">' + _esc(t) + '</div>' + body + '</div>'); };
        var e = S.env;
        if (tab !== 'env' && e && e.ok) {
            var lr = Object.keys(e.limits).filter(function (k) { return _fin(e.limits[k].q); }).map(function (k) { var L = e.limits[k]; return '<tr><td>' + _esc(L.label) + '</td><td class="num">' + q(L.q) + '</td><td>' + _esc(L.kind || '') + '</td></tr>'; });
            box('Operating envelope' + (_stale(p, S.envKey) ? ' (previous inputs)' : ''), '<div class="wp-tw"><table class="dtable wp-dense"><thead><tr><th>Limit</th><th class="num">Rate (' + ql + ')</th><th>Kind</th></tr></thead><tbody>' + lr.join('') + '</tbody></table></div>' +
                (e.window.ok ? '<div class="rrow"><span class="rl">Operating window</span><span class="rv">' + _esc(q(e.window.qLo) + '–' + q(e.window.qHi) + ' ' + p.lab(rc[0], rc[1])) + '</span></div>' : ''));
        }
        if (tab !== 'fcst' && S.fc && S.fc.ok) box('Depletion forecast' + (_stale(p, S.fcKey) ? ' (previous inputs)' : '') + (S.fc.provisional ? ' — provisional' : ''), _fcTable(p));
        var t = S.torn;
        if (tab !== 'torn' && t && t.ok && t.bars.length) {
            var vf = function (b, v) { return SENS_CAT[b.key] ? p.fmt(p.dv(v, SENS_CAT[b.key]), 3) : p.fmt(v, 3); }, un = function (b) { return SENS_CAT[b.key] ? p.lab(SENS_CAT[b.key], b.unit) : b.unit; };
            box('Tornado (±' + p.fmt(100 * t.frac, 0) + ' %)' + (_stale(p, S.tornKey) ? ' (previous inputs)' : ''), '<div class="wp-tw"><table class="dtable wp-dense"><thead><tr><th>Variable</th><th class="num">Low</th><th class="num">Rate low</th><th class="num">High</th><th class="num">Rate high</th><th class="num">Swing (' + ql + ')</th></tr></thead><tbody>' +
                t.bars.map(function (b) { return '<tr><td>' + _esc(b.label.replace(/ \(.*\)$/, '')) + '</td><td class="num">' + _esc(vf(b, b.lo) + ' ' + un(b)) + '</td><td class="num">' + (b.okLo ? q(b.qLo) : 'no flow') + '</td><td class="num">' + _esc(vf(b, b.hi) + ' ' + un(b)) + '</td><td class="num">' + (b.okHi ? q(b.qHi) : 'no flow') + '</td><td class="num">' + q(b.swing) + '</td></tr>'; }).join('') + '</tbody></table></div>');
        }
        var m = S.mat;
        if (tab !== 'mat' && m && m.ok && m.nd) {
            var bst = m.cases.filter(function (c) { return c.R.ok && c.R.stable; }).sort(function (a, b) { return b.R.q - a.R.q; }).slice(0, 5);
            var labm = function (d, i) { var ax = m.axes[d], v = ax.values[i]; return ax.labels[i] || p.fmt(SENS_CAT[ax.key] ? p.dv(v, SENS_CAT[ax.key]) : v, 3); };
            box('Sensitivity matrix — best stable cases' + (_stale(p, S.matKey) ? ' (previous inputs)' : ''), '<div class="wp-tw"><table class="dtable wp-dense"><thead><tr>' + m.keys.map(function (k, d) { return '<th>' + _esc(m.labels[d]) + '</th>'; }).join('') + '<th class="num">Rate (' + ql + ')</th></tr></thead><tbody>' +
                bst.map(function (c) { return '<tr>' + m.keys.map(function (k, d) { return '<td>' + _esc(labm(d, c.idx[d])) + '</td>'; }).join('') + '<td class="num">' + q(c.R.q) + '</td></tr>'; }).join('') + '</tbody></table></div>');
        }
        var c = S.cmp;
        if (tab !== 'cases' && c && c.ok) box('Cases compared' + (_stale(p, S.cmpKey) ? ' (previous inputs)' : ''), '<div class="wp-tw"><table class="dtable wp-dense"><thead><tr><th>Case</th><th class="num">Rate (' + ql + ')</th><th class="num">Δ vs first</th><th class="num">pwf (' + _esc(p.lab('pressure', 'psia')) + ')</th></tr></thead><tbody>' +
            c.rows.map(function (r, i) { return '<tr><td>' + _esc(r.name) + '</td><td class="num">' + (r.R.ok ? q(_qmain(M, r.R)) : '—') + '</td><td class="num">' + (i && _fin(r.dqPct) ? (r.dqPct >= 0 ? '+' : '') + p.fmt(r.dqPct, 1) + ' %' : '—') + '</td><td class="num">' + (r.R.ok ? p.fmt(p.dv(r.R.pwf, 'pressure'), 0) : '—') + '</td></tr>'; }).join('') + '</tbody></table></div>');
        h.innerHTML = out.join('');
    }

    // ── the page hooks ───────────────────────────────────────────────────────
    function _run(p, job, label, done) { p.drive(p.jobOf(job), done, label, 'wpb_msg'); }
    function act(a, btn) {
        if (String(a).indexOf('b27') !== 0) return false;
        var p = P(); if (!p) return true;
        var M = p.ST.M || p.read();
        if (a === 'b27tab') { p.plotsSet({ stTab: btn.getAttribute('data-k') }); _msg(''); _syncTabs(p); _renderTab(p); return true; }
        if (a === 'b27env') {
            S.envSel = null; S.envBean = null;
            _run(p, WE().job(M, _envOpts(p)), 'Operating envelope', function (r) { S.env = r; S.envKey = _key(p); _drawEnv(p); p.renderStudies(); });
            return true;
        }
        if (a === 'b27envbean') {
            var q = +btn.getAttribute('data-q'); if (!_fin(q)) return true;
            p.drive(p.jobOf(p.call('WTS_wp_system.designFor', M, { bean: q })), function (r) { S.envBean = { q: q, ok: !!(r && r.ok), bean: r && r.bean, errors: r && r.errors }; var a2 = WE().at(S.env, q); _envRead(p, a2, true); }, 'Bean for ' + p.fmt(p.dv(q, _rc(p)[0]), 0) + ' ' + p.lab(_rc(p)[0], _rc(p)[1]), 'wpb_msg');
            return true;
        }
        if (a === 'b27fc') {
            var spec = _fcSpec(p);
            _run(p, G.WTS_wp_forecast.job(M, spec), 'Depletion forecast', function (r) { S.fc = r; S.fcKey = _key(p); S.fcI = 0; if (r && r.mode === 'tank' && S.fcView === 'mb' && !r.tank) S.fcView = 'rate'; _syncTabs(p); _drawFc(p); p.renderSystemPlot(); p.renderSchematic(); p.renderStudies(); p.renderNotes(); });
            return true;
        }
        if (a === 'b27fcview') { S.fcView = btn.getAttribute('data-k') || 'rate'; _drawFc(p); return true; }
        if (a === 'b27torn') {
            var fr = _num(_txt('wpv_tn_frac')); S.tornSel = null;
            _run(p, G.WTS_wp_sens.tornado(M, { frac: _fin(fr) ? fr / 100 : 0.2 }), 'Tornado', function (r) { S.torn = r; S.tornKey = _key(p); _drawTorn(p); p.renderStudies(); });
            return true;
        }
        if (a === 'b27tsel') { var k = btn.getAttribute('data-k'); S.tornSel = S.tornSel === k ? null : k; _drawTorn(p); var nb = document.querySelector && document.querySelector('#wpb_body button[data-k="' + k + '"]'); if (nb && nb.focus) nb.focus(); return true; }
        if (a === 'b27mat') {
            var vars = _mxVars(p);
            if (vars.length < 3) { _msg(p.vHtml({ st: 'warn', t: '⚠ Choose at least three variables (two variables: the Sensitivity of step ⑤).' })); return true; }
            S.matSel = null; S.matXY = [0, 1]; S.matSlice = {};
            _run(p, G.WTS_wp_sens.job(M, vars), 'Sensitivity matrix', function (r) {
                if (!r || r.ok === false) { _msg(p.vHtml({ st: 'fail', t: '✗ Matrix not run: ' + (((r && r.errors) || []).slice(0, 2).join(' · ') || 'no result') })); S.mat = null; _drawMat(p); return; }
                S.mat = r; S.matKey = _key(p); _drawMat(p); p.renderStudies();
            });
            return true;
        }
        if (a === 'b27mxcell') { var f = +btn.getAttribute('data-f'); S.matSel = S.matSel === f ? null : f; _drawMat(p); var nc = document.querySelector && document.querySelector('#wpb_body [data-act="b27mxcell"][data-f="' + f + '"]'); if (nc && nc.focus) nc.focus(); return true; }
        if (a === 'b27csel') { var cid = btn.getAttribute('data-id'); if (CASE_SEL[cid]) delete CASE_SEL[cid]; else CASE_SEL[cid] = true; _drawCases(p); var nb2 = document.querySelector && document.querySelector('#wpb_cases [data-act="b27csel"][data-id="' + cid + '"]'); if (nb2 && nb2.focus) nb2.focus(); return true; }
        if (a === 'b27save') { _saveCase(p); return true; }
        if (a === 'b27load') { _loadCase(p, btn.getAttribute('data-id')); return true; }
        if (a === 'b27del') { _delCase(p, btn.getAttribute('data-id')); return true; }
        if (a === 'b27compare') {
            var sel = _cases(p).filter(function (c) { return CASE_SEL[c.id]; });
            if (sel.length < 1) { _msg(p.vHtml({ st: 'warn', t: '⚠ Choose the cases to compare (Compare on each case; the first one is the reference).' })); return true; }
            _run(p, G.WTS_wp_cases.compare(sel), 'Case comparison', function (r) { S.cmp = r; S.cmpKey = _key(p); _drawCases(p); p.renderStudies(); });
            return true;
        }
        if (a === 'b27scr') {
            var o = { R: p.ST.R && p.ST.R.ok ? p.ST.R : null, pwfMin: _canonVal('wpv_sc_pwf'), pinj: _canonVal('wpv_sc_pinj') };
            p.drive(p.jobOf(G.WTS_wp_screen.job(M, o)), function (r) { S.scr = r; S.scrKey = _key(p); _renderScreen(p); p.renderStudies(); p.renderSchematic(); }, 'Lift screening', 'wpb_scmsg');
            return true;
        }
        return true;
    }
    function change(el) {
        var p = P(); if (!p) return false;
        var id = el.id || '';
        if (id === 'wpv_fc_mode') { _syncTabs(p); return true; }
        if (/^wpv_mx\d$/.test(id)) { _mxSuggest(p, +id.slice(6)); return true; }
        if (/^wpv_mxv\d$/.test(id)) { _mxCount(p); return true; }
        if (id === 'wpv_mxax' || id === 'wpv_mxay') { var v = +el.value; if (id === 'wpv_mxax') { if (v === S.matXY[1]) S.matXY[1] = S.matXY[0]; S.matXY[0] = v; } else { if (v === S.matXY[0]) S.matXY[0] = S.matXY[1]; S.matXY[1] = v; } _drawMat(p); return true; }
        if (/^wpv_(env|fc|tn|sc|case)_/.test(id) || id === 'wpv_fc_t' || /^wpv_mxs\d$/.test(id)) return true;
        return false;
    }
    function input(el) {
        var p = P(); if (!p) return false;
        if (el.id === 'wpv_fc_t' && S.fc && S.fc.ok) { _fcSet(p, Math.round(+el.value) || 0, false); return true; }
        if (/^wpv_mxs\d$/.test(el.id) && S.mat) { S.matSlice[+el.getAttribute('data-mxd')] = Math.round(+el.value) || 0; _drawMat(p); var s = _byId(el.id); if (s && s.focus) s.focus(); return true; }
        return false;
    }
    function studies() {
        var p = P(); if (!p) return null;
        var M = p.ST.M, rc = _rc(p), rows = [], q = function (v) { return p.u(v, rc[0], 0, rc[1]); };
        var st = function (k) { return _stale(p, k) ? ' (previous inputs)' : ''; };
        var e = S.env;
        if (e && e.ok) {
            var lim = e.limits, nm = function (ks) { return ks.map(function (k) { return lim[k] ? lim[k].label.replace(/ \(.*\)$/, '') : k; }).join(', '); };
            rows.push(['Operating envelope' + st(S.envKey), e.window.ok ? 'window ' + p.fmt(p.dv(e.window.qLo, rc[0]), 0) + '–' + q(e.window.qHi) + ' (THP ' + p.fmt(p.dv(e.window.thpLo, 'pressureG'), 0) + '–' + p.u(e.window.thpHi, 'pressureG', 0, 'psig') + '); limits ' + nm(e.window.lo) + ' / ' + nm(e.window.hi) + (e.op ? '; operating point ' + (e.op.inside ? 'inside' : 'outside (' + nm(e.op.violated) + ')') : '')
                : 'no operating window (' + nm(e.window.lo.concat(e.window.hi)) + ')']);
        }
        var f = S.fc;
        if (f && f.ok) {
            var gas = _gas(M), E = f.events, when = function (x) { return f.mode === 'tank' ? 'year ' + p.fmt(x.t_d / 365.25, 1) + ' (p̄r ' + p.u(x.pr, 'pressure', 0, 'psia') + ')' : 'p̄r ' + p.u(x.pr, 'pressure', 0, 'psia'); };
            rows.push(['Depletion forecast' + st(S.fcKey), (f.mode === 'tank' ? (f.kind === 'gas' ? 'gas tank G ' + p.fmt(f.tank.G_Bscf, 2) + ' Bscf' : 'oil tank N ' + p.fmt(f.tank.N_MMstb, 2) + ' MMSTB') + ', ' + p.fmt((f.totals.days || 0) / 365.25, 1) + ' y: ' + (gas ? p.fmt(f.totals.produced / 1e6, 2) + ' Bscf' : p.fmt(f.totals.produced / 1e6, 3) + ' MMSTB') + ' (' + p.fmt(100 * (f.tank.recovery || 0), 1) + ' %); ' : f.rows.length + ' p̄r steps; ') +
                (E.loading ? 'loading from ' + when(E.loading) + (_fin(E.loading.md) ? ' at ' + p.mdTvdTxt(E.loading.md, E.loading.tvd) : '') + '; ' : '') + (E.lift ? 'lift needed at ' + when(E.lift) : 'flows to the end') + (f.provisional ? ' — provisional' : '')]);
        }
        var t = S.torn;
        if (t && t.ok && t.bars.length) rows.push(['Tornado (±' + p.fmt(100 * t.frac, 0) + ' %)' + st(S.tornKey), 'base ' + q(t.q0) + '; swing ' + t.bars.slice(0, 4).map(function (b) { return b.label.replace(/ \(.*\)$/, '') + ' ' + p.fmt(p.dv(b.swing, rc[0]), 0); }).join(' · ') + ' ' + p.lab(rc[0], rc[1])]);
        var m = S.mat;
        if (m && m.ok && m.nd) { var okc = m.cases.filter(function (c) { return c.R.ok; }), bst = okc.filter(function (c) { return c.R.stable; }).sort(function (a, b) { return b.R.q - a.R.q; })[0]; rows.push(['Sensitivity matrix' + st(S.matKey), m.labels.map(function (l) { return l.replace(/ \(.*\)$/, ''); }).join(' × ') + ': ' + m.cases.length + ' cases, ' + okc.length + ' flow' + (bst ? '; best ' + q(bst.R.q) + ' at ' + m.keys.map(function (k, d) { var v = m.axes[d].values[bst.idx[d]]; return (m.axes[d].labels[bst.idx[d]] || p.fmt(SENS_CAT[k] ? p.dv(v, SENS_CAT[k]) : v, 3)); }).join(' · ') : '')]); }
        var c = S.cmp;
        if (c && c.ok) rows.push(['Cases compared' + st(S.cmpKey), c.rows.map(function (r, i) { return r.name + ' ' + (r.R.ok ? q(_qmain(M, r.R)) : 'no flow') + (i && _fin(r.dqPct) ? ' (' + (r.dqPct >= 0 ? '+' : '') + p.fmt(r.dqPct, 1) + ' %)' : ''); }).join(' · ')]);
        else if (_cases(p).length) rows.push(['Saved cases', _cases(p).map(function (x) { return x.name + (x.summary && x.summary.ok ? ' ' + q(_qmain(M, x.summary)) : ''); }).join(' · ')]);
        // the screening matrix of THIS model (review fix v4.5: S.scrMx was refreshed only after these rows were built, so a new example
        // showed the previous model's ranking), with the table's words
        var SCm = G.WTS_wp_screen, sm = (SCm && typeof SCm.matrix === 'function' && M) ? SCm.matrix(M, { R: p.ST.R && p.ST.R.ok ? p.ST.R : null, W: p.ST.W && p.ST.W.ok ? p.ST.W : null }) : null, sj = S.scr;
        if (sm && sm.ok) S.scrMx = sm;
        if (sm && sm.ok && (sj || (M && M.lift && M.lift.type !== 'none'))) {
            var rk = sm.methods.filter(function (x) { return x.key !== 'natural'; }).sort(function (a, b) { return a.rank - b.rank; }).slice(0, 3).map(function (x) { return x.label + ' (' + (VD_WORD[x.verdict] || x.verdict) + ')'; }).join(', ');
            rows.push(['Lift screening' + (sj ? st(S.scrKey) : ''), rk + (sj && sj.ok ? '; natural ' + (sj.natural.ok ? q(sj.natural.q) : 'no flow') + ', gas lift ' + (sj.gaslift && sj.gaslift.ok ? q(sj.gaslift.qL) : 'n/a') + ', pump potential ' + (sj.potential ? q(sj.potential.q) : 'n/a') : '') + ' — provisional screening']);
        }
        return rows.length ? { rows: rows } : null;
    }
    function marks() {
        var p = P(); if (!p) return null;
        var out = [], sm = S.scrMx, f = S.fc;
        if (sm && sm.ok && sm.windows && sm.windows.esp && p.ST.M && ((p.ST.M.lift && p.ST.M.lift.type === 'esp') || (S.scr && !_stale(p, S.scrKey)))) out.push({ md: sm.windows.esp.md0, md2: sm.windows.esp.md1, kind: 'window', color: '#bc8cff', label: 'ESP setting window' });
        if (f && f.ok && f.events.loading && _fin(f.events.loading.md) && !_stale(p, S.fcKey)) out.push({ md: f.events.loading.md, kind: 'tick', color: '#d29922', label: 'loading onset' + (f.mode === 'tank' ? ' · ' + p.fmt(f.events.loading.t_d / 365.25, 1) + ' y' : '') });
        return out;
    }
    function sysPlot(o) {
        var p = P(); if (!p || _tab() !== 'fcst' || !S.fc || !S.fc.ok || _stale(p, S.fcKey)) return null;
        var cr = _fcRow(), M = p.ST.M; if (!cr || !M) return null;
        var F = p.ST.F, I = (F && F.ok && G.WTS_wp_ipr) ? G.WTS_wp_ipr.curve(Object.assign({}, JSON.parse(JSON.stringify(M.res)), { pr: cr.pr }), F) : null;
        if (I && I.ok && Array.isArray(I.curve)) o.series.push({ key: 'fcipr', label: 'Inflow at ' + (S.fc.mode === 'tank' ? 'year ' + p.fmt(cr.t_d / 365.25, 1) : 'step ' + (cr.i + 1)), color: o.T.purple, width: 1.8, dash: [5, 4], pts: I.curve.map(function (c) { return [o.X(c.q), o.Y(c.pwf)]; }).sort(function (a, b) { return a[0] - b[0]; }) });
        if (cr.ok) o.markers.push({ x: o.X(_gas(M) ? cr.qg : cr.q), y: o.Y(cr.pwf), kind: 'diamond', color: o.T.purple, r: 6, label: 'forecast ' + (S.fc.mode === 'tank' ? p.fmt(cr.t_d / 365.25, 1) + ' y' : 'step ' + (cr.i + 1)) });
        return true;
    }
    function csv() {
        var out = [];
        if (S.env && S.env.ok) {
            var L = ['Operating envelope (field units): rate, THP available (psig), flowline back pressure (psig), pwf (psia), erosional ratio, loading margin, stable'];
            S.env.curve.forEach(function (c) { L.push([c.q, c.thp, c.thpLine, c.pwf, c.ero, c.loadMargin, c.stable ? 'yes' : 'no'].map(function (x) { return x == null ? '' : (typeof x === 'number' ? +x.toPrecision(8) : x); }).join(',')); });
            out.push(L.join('\n'));
        }
        if (S.fc && S.fc.ok && G.WTS_wp_forecast) out.push(G.WTS_wp_forecast.csv(S.fc));
        if (S.torn && S.torn.ok && G.WTS_wp_sens.tornadoCsv) out.push(G.WTS_wp_sens.tornadoCsv(S.torn));
        if (S.mat && S.mat.ok && G.WTS_wp_sens) out.push(G.WTS_wp_sens.csv(S.mat));
        if (S.cmp && S.cmp.ok && G.WTS_wp_cases) out.push(G.WTS_wp_cases.csv(S.cmp));
        return out;
    }
    function notes() {
        var out = [];
        if (S.fc && S.fc.ok && S.fc.mode === 'tank') out.push('Depletion forecast: explicit time steps on a tank — ' + (S.fc.kind === 'gas' ? 'volumetric gas p/Z' : 'oil Havlena-Odeh with the producing GOR from Corey gas flow above the critical gas saturation') + '; no aquifer; provisional — not verified against a published example.');
        if (S.scrMx && (S.scr || (G.WTS_wellperf_page && P() && P().ST.M && P().ST.M.lift.type !== 'none'))) out.push('Lift screening: indicative published ranges, a screening aid and not a design; provisional.');
        return out;
    }
    function reset() { S.env = null; S.envSel = null; S.envBean = null; S.fc = null; S.fcI = 0; S.torn = null; S.tornSel = null; S.mat = null; S.matSel = null; S.cmp = null; S.scr = null; CASE_SEL = {}; S.tagged = false; }
    function resize() { var cv = _byId('wp_cv_st'); if (cv && G.WTS_wp_view) G.WTS_wp_view.redraw(cv); }

    G.WTS_wellperf_ext = G.WTS_wellperf_ext || {};
    G.WTS_wellperf_ext.studies = { resHtml: resHtml, stepHtml: stepHtml, render: render, act: act, change: change, input: input, studies: studies, marks: marks, sysPlot: sysPlot, csv: csv, notes: notes, reset: reset, resize: resize,
        state: function () { return S; }, TABS: TABS.map(function (t) { return t[0]; }) };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, E = G.WTS_wellperf_ext && G.WTS_wellperf_ext.studies;
    if (!(E && typeof E.resHtml === 'function' && typeof E.act === 'function' && E.act('other') === false) && typeof console !== 'undefined') console.error('[49-calc-wp-studies.js self-test] extension malformed');
})();
