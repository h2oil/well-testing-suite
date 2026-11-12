// =============================================================================
// WTS — 49-calc-wp-espui.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance page part for the electrical submersible pump (B, WP26) — docs/WELL-PERFORMANCE-PLAN.md §7.3, §1.3 US17, §2.7, §2.9,
// §10 and the owner GUI requirement (interactive, deviation first, KPI chips, every result captured by the reports). Registered as
// window.WTS_wellperf_ext.esp (the page's extension hooks, 49-calc-wellperf.js); draws with the page helpers (WTS_wellperf_page.ui())
// and the engines WTS_wp_esp (49-calc-wp-esp.js) and WTS_wp_system (the solve with the pump node) — no numerics of its own.
//
//   Step ④ (lift type ESP):
//     "ESP — setting, pump and motor"  the scalar controls wp_esp_* (setting MD with its TVD, inclination and dogleg read-out, frequency,
//                                      stages, separator efficiency, natural separation, viscosity correction, housing OD, motor
//                                      power / voltage / current, cable gauge and length — they are the model's scalar contract, so they
//                                      autosave and travel in projects and cases); Size the stages for a rate, Frequency for a rate
//                                      (WTS_wp_system.designFor {freq}, a Job), Rate against frequency (WTS_wp_esp.sweep, a Job)
//     "Pump curve"                     the pump table (rate, head per stage, efficiency, BHP per stage at the base frequency; display
//                                      units), name, base frequency, recommended range, OD; Add row, Example pump, Paste CSV, the
//                                      device pump library (wtspref_wp_pumplib, Q11: a device-wide library; not in projects); written
//                                      through WTS_wp_model.write({pump}) → one solve
//     "Rate against frequency"         the sweep: rate per frequency with the operating range verdict per point and a draggable
//                                      frequency line (live re-solve)
//   #wp_res (always captured while the ESP is the lift type): "ESP — pump and system head" with KPI chips (✓ / ! / ✕), the pump plot —
//     total head against the rate through the pump: the frequency fan, the curve at the operating frequency and stages, the
//     recommended operating range shaded, the BEP locus, the head the well needs (the scan of the solve), the head the pump makes on
//     this fluid (gas and viscosity) and the operating point — with FREQUENCY and STAGES rails that re-solve live — and the checks.
//   #wp_studies row, CSV section, Notes (the provisional methods).
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function P() { var pg = G.WTS_wellperf_page; return pg && typeof pg.ui === 'function' ? pg.ui() : null; }
    function E() { return G.WTS_wp_esp || null; }
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(v) { if (typeof v === 'number') return isFinite(v) ? v : null; var s = String(v == null ? '' : v).trim(); if (!s) return null; var dc = G.WTS_a11y && typeof G.WTS_a11y.decimalComma === 'function' && G.WTS_a11y.decimalComma(); if (dc) s = s.replace(/\./g, '').replace(',', '.'); var x = parseFloat(s); return isFinite(x) ? x : null; }
    function _canonVal(id) { var e = _byId(id); if (!e) return null; var U = G.WTS_units, v; if (U && typeof U.runCanonical === 'function') U.runCanonical(function () { v = e.value; }); else v = e.value; return _num(v); }

    var LIB_KEY = 'wtspref_wp_pumplib', LIB_MAX = 20;
    var UNIT_TAGS = { wp_esp_md: 'length', wp_esp_od: 'lengthSmall', wp_esp_hp: 'power', wp_esp_clen: 'length', wpv_esp_tq: 'liquidRate' };
    var FAN = [40, 45, 50, 55, 60, 65, 70];
    // results kept per page instance (cleared on a well switch / project open; never stored)
    var S = { sweep: null, sweepKey: null, size: null, design: null, tagged: false, pumpKey: null, paste: false, lastF: null };

    var CSS = '<style>' +
        '#wp_root .wpe-2c{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:var(--wp-gap);align-items:start}' +
        '#wp_root .wpe-grp{grid-column:1/-1;font-size:10.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--text2);margin:6px 0 -2px;padding-top:6px;border-top:1px solid var(--border)}' +
        '#wp_root .wpe-grp:first-child{border-top:0;padding-top:0;margin-top:0}' +
        '#wp_root .wpe-md{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px;margin:-2px 0 2px}#wp_root .wpe-md:empty{display:none}' +
        '#wp_root .wpe-pill{font-size:11px;font-weight:700;padding:3px 9px;border-radius:12px;background:var(--bg4);color:var(--text2);font-variant-numeric:tabular-nums;transition:background .2s,color .2s}' +
        '#wp_root .wpe-pill.ok{background:rgba(63,185,80,.14);color:var(--wp-ok)}#wp_root .wpe-pill.warn{background:rgba(210,153,34,.16);color:var(--wp-warn)}#wp_root .wpe-pill.fail{background:rgba(248,81,73,.15);color:var(--wp-fail)}' +
        '#wp_root .wpe-go{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg3)}' +
        '#wp_root .wpe-go .fg-item{margin:0;min-width:150px;flex:0 1 190px}#wp_root .wpe-go .btn{padding:7px 12px;font-size:12px}' +
        '#wp_root .wpe-tbl input{width:100%;min-width:64px;padding:4px 6px;font-variant-numeric:tabular-nums;text-align:right}#wp_root .wpe-tbl td{padding:3px 4px}' +
        '#wp_root .wpe-tbl td.x{width:28px;text-align:center}#wp_root .wpe-tbl button.wpe-del{all:unset;cursor:pointer;color:var(--text3);font-weight:700;padding:2px 6px;border-radius:4px}' +
        '#wp_root .wpe-tbl button.wpe-del:hover,#wp_root .wpe-tbl button.wpe-del:focus-visible{color:var(--wp-fail);outline:1px solid var(--wp-fail)}' +
        '#wp_root .wpe-tbl tr.bep td{background:rgba(240,136,62,.08)}' +
        '#wp_root .wpe-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px 12px;margin-bottom:8px}#wp_root .wpe-meta .fg-item{margin:0}' +
        '#wp_root .wpe-lib{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}#wp_root .wpe-lib select{min-width:160px;flex:1 1 160px}#wp_root .wpe-lib .btn{padding:5px 10px;font-size:11.5px}' +
        '#wp_root .wpe-paste{display:none;margin-top:8px}#wp_root .wpe-paste.on{display:block}#wp_root .wpe-paste textarea{width:100%;min-height:92px;font-family:ui-monospace,monospace;font-size:12px}' +
        '#wp_root .wpe-flags{display:grid;gap:4px;margin-top:8px}' +
        '#wp_root .wpe-stage{display:flex;gap:2px;height:16px;margin:8px 0 2px;border-radius:4px;overflow:hidden;background:var(--bg4)}#wp_root .wpe-stage i{flex:1 1 0;transition:background .3s}' +
        '#wp_root .wpe-stagel{display:flex;justify-content:space-between;font-size:10.5px;color:var(--text3);font-variant-numeric:tabular-nums}' +
        '#wp_root #wpe_setcard .fg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 14px;align-items:start}#wp_root #wpe_setcard .fg .fg-item{min-width:0}' +
        '#wp_root #wpe_setcard .fg .wp-check{align-self:center}#wp_root #wpe_setcard .fg-item .wp-hint{font-size:11px}' +
        '#wp_root #wp_step_4>.wp-2c:has(>.card.wp-off){grid-template-columns:minmax(0,1fr)}' +
        '@media (max-width:900px){#wp_root .wpe-2c{grid-template-columns:minmax(0,1fr)}}' +
        '@media (max-width:480px){#wp_root #wpe_setcard .fg{grid-template-columns:minmax(0,1fr)}}' +
        '@media (max-width:640px){#wp_root .wpe-go .fg-item{flex:1 1 100%}#wp_root .wpe-tbl input{min-width:52px;font-size:16px}}' +
        '@media (prefers-reduced-motion:reduce){#wp_root .wpe-pill,#wp_root .wpe-stage i{transition:none}}' +
        '</style>';

    // ── helpers ──────────────────────────────────────────────────────────────
    function _on(p) { var M = p && p.ST && p.ST.M; return !!(M && M.lift && M.lift.type === 'esp'); }
    function _esp(p) { var M = p && p.ST && p.ST.M; return (M && M.lift && M.lift.esp) || {}; }
    function _L(p) { var R = p && p.ST && p.ST.R; return R && R.ok && R.lift && R.lift.type === 'esp' ? R.lift : null; }
    function _key(p) { var M = p.ST.M; return M ? p.mkey(M) : ''; }
    function _stale(p, k) { return !!(k && k !== _key(p)); }
    function _qL(p, v) { return p.u(v, 'liquidRate', 0, 'bbl/d'); }
    function _fgx(id, label, o) { o = o || {}; var p = P(); return p ? p.fg(id, label, Object.assign({ def: o.def != null ? o.def : '' }, o)) : ''; }
    function _msg(t, st) { var b = _byId('wpe_msg'); if (b) b.innerHTML = t ? '<div class="wp-v ' + (st || 'info') + '">' + _esc(t) + '</div>' : ''; }
    function _tagAll() {
        var U = G.WTS_units; if (!U || typeof U.tagInput !== 'function') return;
        Object.keys(UNIT_TAGS).forEach(function (id) { var e = _byId(id); if (e && !(e.dataset && e.dataset.wtsUnitCat)) U.tagInput(id, UNIT_TAGS[id]); });
    }
    function _stOfFlags(fl) { var o = { ok: 0, warn: 0, fail: 0 }; (fl || []).forEach(function (f) { if (o[f.sev] != null) o[f.sev]++; }); return o.fail ? 'fail' : (o.warn ? 'warn' : 'ok'); }
    function _flag(L, code) { return (L && L.flags || []).filter(function (f) { return f.code === code; })[0] || null; }
    function _sevOf(L, codes) { var s = 'ok'; (L && L.flags || []).forEach(function (f) { if (codes.indexOf(f.code) !== -1) { if (f.sev === 'fail') s = 'fail'; else if (f.sev === 'warn' && s !== 'fail') s = 'warn'; } }); return s; }

    // ── markup ────────────────────────────────────────────────────────────────
    function resHtml() {
        var p = P(); if (!p) return '';
        return CSS + p.card('ESP — pump and system head',
            '<div class="wp-cmpk" id="wpe_kpi"></div>' +
            '<div class="chart-wrap"><canvas id="wp_cv_esp" tabindex="0" aria-label="ESP pump plot: total head against the rate through the pump; the frequency fan, the recommended range, the head the well needs and the operating point; drag the frequency and stages rails to re-solve"></canvas></div>' +
            '<div class="wp-legend-hint rp-skip">Drag <b>FREQ</b> or <b>STAGES</b> on the top rails (or focus the plot, [ / ] then the arrows) and the well re-solves with the pump. Shaded: the recommended operating range across frequency; dashed: the frequency fan; blue: the head the well needs at each rate.</div>' +
            '<div class="wpe-stage rp-skip" id="wpe_stage" aria-hidden="true"></div><div class="wpe-stagel rp-skip" id="wpe_stagel"></div>' +
            '<div class="rbox" id="wpe_sum" style="margin-top:10px"></div><div class="wpe-flags" id="wpe_flags"></div>', { id: 'wpe_rescard', cls: 'wp-off' });
    }
    function stepHtml(n) {
        var p = P(); if (!p || n !== 4) return null;
        var awg = [['1/0', '#1/0'], ['1', '#1'], ['2', '#2'], ['4', '#4'], ['6', '#6']];
        var setting = p.card('ESP — setting, pump and motor', '<div class="fg">' +
            '<div class="wpe-grp">Setting</div>' +
            _fgx('wp_esp_md', 'Pump setting depth MD', { unit: 'ft', ph: 'end of tubing', hint: 'Intake depth along the hole; the TVD, inclination and dogleg there are shown below.' }) +
            '<div class="wpe-md" id="wpe_mdinfo" aria-live="polite"></div>' +
            _fgx('wp_esp_freq', 'Frequency', { unit: 'Hz', def: '60', step: '0.5' }) + _fgx('wp_esp_stages', 'Stages', { def: '', step: '1', ph: 'size below' }) +
            '<div class="wpe-grp">Gas and fluid</div>' +
            _fgx('wp_esp_sep', 'Gas separator efficiency', { unit: '%', def: '0', hint: '0 = no rotary separator.' }) +
            _fgx('wp_esp_nat', 'Natural gas separation at the intake', { check: true, def: true }) +
            _fgx('wp_esp_visc', 'Viscosity correction', { check: true, def: true }) +
            _fgx('wp_esp_od', 'Pump and motor OD', { unit: 'in', def: '4', step: '0.01' }) +
            '<div class="wpe-grp">Motor and cable</div>' +
            _fgx('wp_esp_hp', 'Motor power (base frequency)', { unit: 'hp', ph: 'nameplate' }) + _fgx('wp_esp_volt', 'Motor voltage', { unit: 'V', ph: 'nameplate' }) +
            _fgx('wp_esp_amp', 'Motor current', { unit: 'A', ph: 'nameplate' }) +
            _fgx('wp_esp_awg', 'Cable (copper)', { options: awg, def: '2' }) + _fgx('wp_esp_clen', 'Cable length', { unit: 'ft', ph: 'pump MD + 100' }) + '</div>' +
            '<div class="wpe-go rp-skip">' + _fgx('wpv_esp_tq', 'Target liquid rate', { unit: 'bbl/d', ph: 'e.g. 1500' }) +
            '<button type="button" class="btn btn-primary" data-act="espsize">Size the stages</button>' +
            '<button type="button" class="btn btn-secondary" data-act="espfreq">Frequency for this rate</button>' +
            '<button type="button" class="btn btn-secondary" data-act="espsweep">Rate against frequency</button></div>' +
            '<div id="wpe_msg" class="rp-skip" role="status" style="margin-top:8px"></div><div id="wpe_sized"></div>', { id: 'wpe_setcard' });
        var curve = p.card('Pump curve', '<div class="wpe-meta rp-skip" id="wpe_meta"></div><div class="wp-tw rp-skip"><table class="dtable wpe-tbl" id="wpe_tbl"></table></div>' +
            '<div class="wpe-lib rp-skip"><button type="button" class="btn btn-secondary" data-act="espadd">Add row</button><button type="button" class="btn btn-secondary" data-act="espex">Example pump</button>' +
            '<button type="button" class="btn btn-secondary" data-act="esppaste">Paste CSV</button><button type="button" class="btn btn-secondary" data-act="espclear">Clear</button></div>' +
            '<div class="wpe-paste rp-skip" id="wpe_paste"><textarea id="wpe_pastet" aria-label="Pump curve rows: rate, head per stage, efficiency %, BHP per stage" placeholder="rate, head per stage, efficiency %, BHP per stage — one row per line (display units)"></textarea><button type="button" class="btn btn-primary" data-act="esppasteok" style="margin-top:6px">Use these rows</button></div>' +
            '<div class="wpe-lib rp-skip"><label for="wpe_lib" style="font-size:11px;color:var(--text2)">Pump library (this device)</label><select id="wpe_lib" aria-label="Saved pumps"></select>' +
            '<button type="button" class="btn btn-secondary" data-act="esplibload">Load</button><button type="button" class="btn btn-secondary" data-act="esplibsave">Save this pump</button><button type="button" class="btn btn-secondary" data-act="esplibdel">Remove</button></div>' +
            '<div id="wpe_pumpsum" style="margin-top:8px"></div>', { id: 'wpe_curvecard' });
        var fr = p.card('Rate against frequency', '<div class="chart-wrap"><canvas id="wp_cv_espf" tabindex="0" aria-label="Liquid rate against the ESP frequency; drag the frequency line to re-solve"></canvas></div>' +
            '<div class="wpe-go rp-skip">' + _fgx('wpv_esp_flist', 'Frequencies', { text: true, unit: 'Hz', def: FAN.join(' ') }) + '<span class="wp-hint" style="flex:1 1 220px;margin:0">One solve per frequency, each warm-started from the one before (a Job). Points are coloured by the operating range: green inside, amber down- or upthrust.</span></div>' +
            '<div id="wpe_sweep"></div>', { id: 'wpe_frcard' });
        return '<div data-lift="esp" class="wpe-wrap">' + '<div class="wpe-2c">' + setting + '<div>' + curve + fr + '</div></div></div>';
    }

    // ── render (every solve) ─────────────────────────────────────────────────
    function render(live) {
        var p = P(); if (!p) return;
        var on = _on(p), rc = _byId('wpe_rescard');
        if (rc && rc.classList) rc.classList.toggle('wp-off', !on);
        _glCard(on);
        if (!_byId('wpe_setcard')) { if (on) _drawPump(p); return; }
        if (!S.tagged) { _tagAll(); S.tagged = true; _bindTable(); }
        if (!on) return;
        _mdInfo(p);
        _drawPump(p);
        _kpis(p);
        if (live) { _drawSweep(p); return; }
        _summary(p);
        _pumpEditor(p, false);
        _drawSweep(p);
        _libList();
    }
    // with the ESP selected the gas-lift performance card (step ④) is hidden; it comes back with gas lift
    function _glCard(on) {
        var cv = _byId('wp_cv_glpc'), card = cv && cv.closest ? cv.closest('.card') : null;
        if (card && card.classList) card.classList.toggle('wp-off', !!on);
    }
    function _mdInfo(p) {
        var h = _byId('wpe_mdinfo'); if (!h) return;
        var L = _L(p), W = p.ST.W, e = _esp(p), md = L ? L.pumpMd : (_fin(+e.pumpMd) ? +e.pumpMd : (W && W.ok && W.nodes && _fin(W.nodes.tubingShoeMd) ? W.nodes.tubingShoeMd : null));
        if (!_fin(md)) { h.innerHTML = ''; return; }
        var inc = L ? L.inc : null, dls = L ? L.dls : null;
        if (W && W.ok && typeof W.at === 'function' && !L) { var a = W.at(md); inc = a && _fin(a.inc) ? a.inc : null; }
        var pill = function (t, st) { return '<span class="wpe-pill' + (st ? ' ' + st : '') + '">' + _esc(t) + '</span>'; };
        h.innerHTML = pill(p.mdTvdTxt(md, L ? L.pumpTvd : null)) + (_fin(inc) ? pill('inclination ' + p.fmt(inc, 1) + '°', inc > 80 ? 'warn' : '') : '') +
            (_fin(dls) ? pill('dogleg ' + p.fmt(dls, 1) + '°/100 ft', dls > 6 ? 'fail' : (dls > 3 ? 'warn' : 'ok')) : '') + (L && !_fin(+e.pumpMd) ? pill('default: end of tubing', '') : '');
    }
    function _kpis(p) {
        var h = _byId('wpe_kpi'); if (!h) return;
        var L = _L(p), R = p.ST.R, chip = function (k, v, s, st) { return '<div class="wp-cmpc' + (st ? ' st-' + st : '') + '"><span class="kpi-l">' + _esc(k) + '</span><span class="kpi-v">' + _esc(v) + '</span>' + (s ? '<em class="kpi-s">' + _esc(s) + '</em>' : '') + '</div>'; };
        if (!L) {
            var why = R && !R.ok ? ((R.errors || [])[0] || 'no operating point') : 'solve with the pump to see its operating point';
            h.innerHTML = chip('ESP', '—', why, R && !R.ok ? 'fail' : null); return;
        }
        var mo = L.motor || {}, rgSt = L.rangeStatus === 'ok' ? 'ok' : 'warn';
        h.innerHTML = [
            chip('Liquid rate', _qL(p, R.rates.qL), 'through the pump ' + _qL(p, L.Qin), R.op && R.op.stable ? 'ok' : 'fail'),
            chip('Frequency · stages', p.fmt(L.freq, 1) + ' Hz · ' + p.fmt(L.stages, 0), 'TDH ' + p.u(L.tdh, 'length', 0, 'ft') + ' · ' + p.u(L.hPerStage, 'length', 1, 'ft') + '/stage'),
            chip('Operating range', L.rangeStatus === 'ok' ? 'inside' : (L.rangeStatus === 'down' ? 'downthrust' : 'upthrust'), p.fmt(p.dv(L.range.qMin, 'liquidRate'), 0) + '–' + _qL(p, L.range.qMax), rgSt),
            chip('Intake / discharge', p.u(L.pInt - p.PATM, 'pressureG', 0, 'psig'), 'discharge ' + p.u(L.pDis - p.PATM, 'pressureG', 0, 'psig')),
            chip('Gas at the intake', p.fmt(L.gvfIn * 100, 1) + ' %', 'Turpin φ ' + p.fmt(L.phi, 2) + (L.E > 0 ? ' · separated ' + p.fmt(L.E * 100, 0) + ' %' : ''), _sevOf(L, ['ESP_GAS', 'ESP_GVF', 'ESP_GAS_OK'])),
            chip('Pump power', p.u(L.bhp, 'power', 0, 'hp'), 'efficiency ' + p.fmt(L.eff * 100, 0) + ' %'),
            mo.ok ? chip('Motor load', p.fmt(mo.load * 100, 0) + ' %', p.fmt(mo.amps, 0) + ' A · ' + p.fmt(mo.vSurf, 0) + ' V surface', _sevOf(L, ['ESP_OVERLOAD', 'ESP_LOAD_HIGH', 'ESP_LOAD', 'ESP_LOAD_LOW']))
                : chip('Motor load', '—', 'enter the motor', 'info'),
            mo.ok ? chip('Cable drop', p.fmt(mo.cable.pct * 100, 1) + ' %', p.fmt(mo.cable.dV, 0) + ' V on #' + mo.cable.awg, _sevOf(L, ['ESP_CABLE', 'ESP_CABLE_OK']))
                : chip('Cooling', _fin(mo.vCool) ? p.u(mo.vCool, 'velocity', 2, 'ft/s') : '—', 'past the motor', _fin(mo.vCool) ? (mo.vCool < 1 ? 'warn' : 'ok') : null)
        ].join('');
    }
    function _summary(p) {
        var h = _byId('wpe_sum'), fl = _byId('wpe_flags'), L = _L(p), R = p.ST.R; if (!h) return;
        var rows = [], row = function (l, v) { rows.push('<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv">' + _esc(v) + '</span></div>'); };
        if (L) {
            row('Pump', L.pump.name + (L.pump.example && !/generic/i.test(L.pump.name) ? ' (generic example)' : '') + ', base ' + p.fmt(L.pump.f0, 0) + ' Hz, BEP ' + _qL(p, L.pump.bep.q) + ' at ' + p.fmt(L.pump.bep.eff * 100, 0) + ' %');
            row('Setting', p.mdTvdTxt(L.pumpMd, L.pumpTvd) + (_fin(L.inc) ? ', ' + p.fmt(L.inc, 1) + '°' : '') + (_fin(L.dls) ? ', dogleg ' + p.fmt(L.dls, 1) + '°/100 ft' : ''));
            row('Frequency, stages', p.fmt(L.freq, 1) + ' Hz, ' + p.fmt(L.stages, 0) + ' stages');
            row('Rate (surface / through the pump)', _qL(p, R.rates.qL) + ' / ' + _qL(p, L.Qin) + ' at the intake, ' + _qL(p, L.Qout) + ' at the discharge');
            row('Intake / discharge pressure', p.u(L.pInt - p.PATM, 'pressureG', 0, 'psig') + ' / ' + p.u(L.pDis - p.PATM, 'pressureG', 0, 'psig') + ' (rise ' + p.u(L.dp, 'pressure', 0, 'psi') + ')');
            row('Total dynamic head', p.u(L.tdh, 'length', 0, 'ft') + ' (' + p.u(L.hPerStage, 'length', 1, 'ft') + ' per stage, mean density ' + p.u(L.rho, 'density', 1, 'lb/ft³') + ')');
            row('Gas at the intake', p.u(L.freeIn, 'gasRateSmall', 0, 'Mscf/d') + ' free, ' + p.fmt(L.E * 100, 0) + ' % separated (natural ' + p.fmt(L.En * 100, 0) + ' %), ' + p.fmt(L.gvfIn * 100, 1) + ' % by volume into the pump, Turpin φ ' + p.fmt(L.phi, 2));
            if (L.visc && L.visc.Qstar != null && L.visc.CQ < 0.999) row('Viscosity correction', p.fmt(L.nu, 1) + ' cSt: rate × ' + p.fmt(L.visc.CQ, 3) + ', head × ' + p.fmt(L.visc.CH[2], 3) + ', efficiency × ' + p.fmt(L.visc.CE, 3));
            row('Pump power', p.u(L.bhp, 'power', 0, 'hp') + ' (hydraulic ' + p.u(L.hydHp, 'power', 0, 'hp') + ', efficiency ' + p.fmt(L.eff * 100, 0) + ' %)');
            var mo = L.motor || {};
            if (mo.ok) row('Motor and cable', 'load ' + p.fmt(mo.load * 100, 0) + ' % of ' + p.u(mo.hpAvail, 'power', 0, 'hp') + ', ' + p.fmt(mo.amps, 0) + ' A; cable ' + p.fmt(mo.cable.dV, 0) + ' V (' + p.fmt(mo.cable.pct * 100, 1) + ' %) on ' + p.u(mo.cable.len, 'length', 0, 'ft') + ' #' + mo.cable.awg + '; surface ' + p.fmt(mo.vSurf, 0) + ' V, ' + p.fmt(mo.kva, 0) + ' kVA');
            if (S.sweep && S.sweep.ok) row('Rate against frequency' + (_stale(p, S.sweepKey) ? ' (previous inputs)' : ''), S.sweep.rows.filter(function (r) { return r.ok; }).map(function (r) { return p.fmt(r.f, 0) + ' Hz ' + p.fmt(p.dv(r.qL, 'liquidRate'), 0); }).join(' · ') + ' ' + p.lab('liquidRate', 'bbl/d'));
            if (S.size && S.size.ok) row('Stages for ' + _qL(p, S.size.q), p.fmt(S.size.stages, 0) + ' (TDH ' + p.u(S.size.tdh, 'length', 0, 'ft') + ')' + (_stale(p, S.size.key) ? ' (previous inputs)' : ''));
            row('Methods', L.methods.map(function (m) { return m.label + (m.verified ? '' : ' — provisional'); }).join('; '));
        }
        h.innerHTML = rows.length ? '<div class="rbox-title">Electrical submersible pump</div>' + rows.join('') : '';
        if (fl) fl.innerHTML = L ? (L.flags || []).map(function (f) { return p.vHtml({ st: f.sev === 'fail' ? 'fail' : f.sev === 'warn' ? 'warn' : f.sev === 'ok' ? 'ok' : 'info', t: (f.sev === 'fail' ? '✗ ' : f.sev === 'warn' ? '⚠ ' : f.sev === 'ok' ? '✓ ' : 'ℹ ') + f.msg }); }).join('') +
            p.vHtml({ st: 'info', t: 'ℹ ESP methods without a verified published example are labelled provisional — not verified against a published example (viscosity correction, natural separation, gas criterion, motor and cable basics).' }) : '';
        _stageBar(p, L);
    }
    // the pressure through the pump: one cell per group of stages, coloured by the gas volume fraction going in (blue liquid → amber gas)
    function _stageBar(p, L) {
        var h = _byId('wpe_stage'), l = _byId('wpe_stagel'); if (!h) return;
        if (!L) { h.innerHTML = ''; if (l) l.innerHTML = ''; return; }
        var n = Math.min(20, L.stages), V = G.WTS_wp_view, out = [];
        for (var i = 0; i < n; i++) { var f = n > 1 ? i / (n - 1) : 0, gv = L.gvfIn * (1 - f) * (1 - f); out.push('<i style="background:' + (V && V.ramp ? V.ramp(0.15 + Math.min(0.8, gv * 4)) : '#58a6ff') + '"></i>'); }
        h.innerHTML = out.join('');
        if (l) l.innerHTML = '<span>intake ' + _esc(p.u(L.pInt - p.PATM, 'pressureG', 0, 'psig')) + '</span><span>' + _esc(p.fmt(L.stages, 0)) + ' stages · gas dissolving</span><span>discharge ' + _esc(p.u(L.pDis - p.PATM, 'pressureG', 0, 'psig')) + '</span>';
    }

    // ── the pump plot (total head against the rate through the pump) ─────────
    function _drawPump(p) {
        var cv = _byId('wp_cv_esp'), V = G.WTS_wp_view, EP = E(); if (!cv || !V || !EP) return;
        var T = V.theme(), L = _L(p), e = _esp(p), np = EP.normPump(e.pump), N = L ? L.stages : (_fin(+e.stages) ? +e.stages : null), f = L ? L.freq : (_fin(+e.freq) ? +e.freq : 60);
        var X = function (q) { return p.dv(q, 'liquidRate'); }, Y = function (h) { return p.dv(h, 'length'); };
        var ser = [], mk = [], handles = [];
        if (np.ok && N) {
            var nu = L && L.viscOn !== false && L.nu > 1 ? L.nu : 1, pump = np.pump;
            // the recommended range across 30–90 Hz: the qMin and qMax affinity parabolas, closed into one shaded window
            var lo = [], hi = [], bep = [];
            for (var fz = 30; fz <= 90; fz += 2.5) { var c = EP.curve(pump, fz, nu); lo.push([X(c.range.qMin), Y(N * Math.max(0, c.head(c.range.qMin)))]); hi.push([X(c.range.qMax), Y(N * Math.max(0, c.head(c.range.qMax)))]); bep.push([X(c.bep.q), Y(N * c.bep.h)]); }
            ser.push({ key: 'range', label: 'Recommended range (30–90 Hz)', kind: 'poly', color: T.green, alpha: 0.13, pts: lo.concat(hi.slice().reverse()) });
            ser.push({ key: 'bep', label: 'Best efficiency', color: T.green, width: 1.2, dash: [2, 3], pts: bep });
            EP.fan(pump, FAN.filter(function (z) { return Math.abs(z - f) > 0.25; }), N, nu).forEach(function (fc, i) {
                ser.push({ key: 'fan' + fc.f, label: i === 0 ? 'Frequency fan ' + FAN[0] + '–' + FAN[FAN.length - 1] + ' Hz' : '', legend: i === 0, color: T.text2, width: 1, dash: [4, 4], pts: fc.pts.map(function (q) { return [X(q[0]), Y(q[1])]; }) });
            });
            var cur = EP.fan(pump, [f], N, nu)[0];
            if (cur) ser.push({ key: 'pump', label: 'Pump ' + p.fmt(f, 1) + ' Hz · ' + p.fmt(N, 0) + ' stages', color: T.accent, width: 2.8, pts: cur.pts.map(function (q) { return [X(q[0]), Y(q[1])]; }) });
        }
        if (L && L.curve && L.curve.length > 1) {
            var cs = L.curve.slice().sort(function (a, b) { return a.Qin - b.Qin; });
            ser.push({ key: 'need', label: 'Head the well needs', color: T.blue, width: 2.4, pts: cs.map(function (c) { return [X(c.Qin), Y(c.tdhReq)]; }) });
            if (L.gvfIn > 0.01 || (L.visc && L.visc.CQ < 0.999)) ser.push({ key: 'onfl', label: 'Pump on this fluid', color: T.accent, width: 1.4, dash: [6, 3], pts: cs.map(function (c) { return [X(c.Qin), Y(c.tdhPump)]; }) });
        }
        if (L) mk.push({ x: X(L.Qin), y: Y(L.tdh), kind: 'filled', color: L.rangeStatus === 'ok' ? T.accent : T.yellow, r: 7, halo: true, label: _qL(p, L.Qin) + ' · ' + p.u(L.tdh, 'length', 0, 'ft') });
        if (np.ok) {
            handles.push({ key: 'espF', kind: 'railX', value: f, min: 30, max: 90, step: 0.5, label: 'Freq', railLabel: 'FREQ', rail: [0, 0.5], color: T.accent, fmt: function (v) { return p.fmt(v, 1) + ' Hz'; } });
            if (N) handles.push({ key: 'espN', kind: 'railX', value: N, min: 1, max: Math.max(50, Math.min(800, Math.ceil(N * 2 / 50) * 50)), step: 1, label: 'Stages', railLabel: 'STAGES', rail: [0.5, 1], color: T.purple, fmt: function (v) { return p.fmt(v, 0); } });
        }
        var qTop = np.ok ? np.pump.qTab * 1.6 * Math.max(1, (f || 60) / np.pump.f0) : null, hTop = 0;
        // the y range follows the pump at the operating frequency and the operating point (the fan and the range band run off the top)
        ser.forEach(function (s) { if (s.key === 'pump' || s.key === 'onfl') s.pts.forEach(function (q) { if (q[1] > hTop) hTop = q[1]; }); });
        hTop *= 1.25;
        if (L && Y(L.tdh) > hTop) hTop = Y(L.tdh);
        // phone: a taller plot and a shorter legend (the fan and the BEP locus are named in the hint under the plot)
        var ph = p.phone(); if (ph) ser.forEach(function (s) { if (/^fan|^bep|^onfl/.test(s.key)) s.legend = false; });
        V.chart(cv, { key: 'esp:' + (p.metric() ? 'm' : 'i') + (ph ? 'p' : ''), aspect: ph ? 1.15 : 0.62, minH: 250, maxH: ph ? 520 : 430, w: 620, readout: 'x',
            x: { label: 'Rate through the pump (' + p.lab('liquidRate', 'bbl/d') + ', in situ)', min: 0, max: qTop ? X(qTop) : undefined, short: 'Q', fmtR: function (v) { return p.fmt(v, 0) + ' ' + p.lab('liquidRate', 'bbl/d'); } },
            y: { label: 'Total head (' + p.lab('length', 'ft') + ')', min: 0, max: hTop > 0 ? hTop * 1.12 : undefined, short: 'H', fmtR: function (v) { return p.fmt(v, 0) + ' ' + p.lab('length', 'ft'); } },
            series: ser, markers: mk, handles: handles, onHandle: _onHandle, legendNote: np.ok && N && !ph ? 'Fan: ' + FAN.filter(function (z) { return Math.abs(z - f) > 0.25; }).join(', ') + ' Hz' : null,
            empty: !np.ok ? 'Enter the pump curve (or load the example pump) in step ④.' : 'Enter the number of stages, or size them for a target rate in step ④.' });
    }
    function _onHandle(key, v, phase) {
        var p = P(); if (!p) return;
        var id = key === 'espF' ? 'wp_esp_freq' : (key === 'espN' ? 'wp_esp_stages' : null); if (!id) return;
        var val = key === 'espF' ? Math.round(v * 2) / 2 : Math.max(1, Math.round(v));
        p.setCtrl(id, val, false);
        if (phase === 'end') { p.commit(id); return; }
        if (typeof p.solveLive === 'function') p.solveLive();
    }

    // ── rate against frequency (the sweep) ───────────────────────────────────
    function _drawSweep(p) {
        var cv = _byId('wp_cv_espf'), V = G.WTS_wp_view; if (!cv || !V) return;
        var T = V.theme(), s = S.sweep, L = _L(p), stale = _stale(p, S.sweepKey), rows = s && s.ok ? s.rows.filter(function (r) { return r.ok; }) : [];
        var Y = function (q) { return p.dv(q, 'liquidRate'); }, col = function (r) { return r.rangeStatus === 'ok' ? T.green : T.yellow; };
        var ser = rows.length ? [{ key: 'qf', label: 'Liquid rate' + (stale ? ' (previous inputs)' : ''), color: stale ? T.text2 : T.accent, width: 2.4, dash: stale ? [3, 4] : null, pts: rows.map(function (r) { return [r.f, Y(r.qL)]; }) }] : [];
        var mk = rows.map(function (r) { return { x: r.f, y: Y(r.qL), kind: r.stable ? 'filled' : 'hollow', color: col(r), r: 5 }; });
        (s && s.rows || []).filter(function (r) { return !r.ok; }).forEach(function (r) { mk.push({ x: r.f, y: 0, kind: 'hollow', color: T.red, r: 5, label: 'no flow' }); });
        var bands = [], run = null;
        rows.forEach(function (r) { if (r.rangeStatus === 'ok') { if (!run) run = { x0: r.f, x1: r.f }; else run.x1 = r.f; } else if (run) { bands.push(run); run = null; } });
        if (run) bands.push(run);
        bands = bands.filter(function (b) { return b.x1 > b.x0; }).map(function (b) { return { x0: b.x0, x1: b.x1, color: 'rgba(63,185,80,0.10)', label: 'in range' }; });
        if (L && rows.length) mk.push({ x: L.freq, y: Y(p.ST.R.rates.qL), kind: 'filled', color: T.blue, r: 6, halo: true, label: 'now ' + _qL(p, p.ST.R.rates.qL) });
        var fs = (s && s.rows || []).map(function (r) { return r.f; }).concat(L ? [L.freq] : []), fmin = fs.length ? Math.min.apply(null, fs) : 40, fmax = fs.length ? Math.max.apply(null, fs) : 70;
        V.chart(cv, { key: 'espf:' + (p.metric() ? 'm' : 'i'), aspect: 0.5, minH: 200, maxH: 320, w: 560, readout: 'x',
            x: { label: 'Frequency (Hz)', min: Math.max(30, fmin - 2.5), max: Math.min(90, fmax + 2.5), short: 'f', fmtR: function (v) { return p.fmt(v, 1) + ' Hz'; } },
            y: { label: 'Liquid rate (' + p.lab('liquidRate', 'bbl/d') + ')', min: 0, short: 'q_L', fmtR: function (v) { return p.fmt(v, 0) + ' ' + p.lab('liquidRate', 'bbl/d'); } },
            series: ser, markers: mk, bands: bands, handles: L && rows.length ? [{ key: 'espF', kind: 'lineX', value: L.freq, min: 30, max: 90, step: 0.5, label: 'f', color: T.blue, fmt: function (v) { return p.fmt(v, 1) + ' Hz'; } }] : [], onHandle: _onHandle,
            legendNote: stale ? 'Faint curve: previous inputs — re-run' : null, empty: 'Run “Rate against frequency” (one solve per frequency).' });
        var tb = _byId('wpe_sweep');
        if (tb) tb.innerHTML = s && s.ok ? '<div class="wp-tw"><table class="dtable"><thead><tr><th>Hz</th><th>Liquid (' + _esc(p.lab('liquidRate', 'bbl/d')) + ')</th><th>Intake (' + _esc(p.lab('pressureG', 'psig')) + ')</th><th>Gas in</th><th>Pump hp</th><th>Motor load</th><th>Range</th></tr></thead><tbody>' +
            s.rows.map(function (r) { return '<tr><td>' + p.fmt(r.f, 1) + '</td><td class="num">' + (r.ok ? p.fmt(p.dv(r.qL, 'liquidRate'), 0) : 'no flow') + '</td><td class="num">' + (r.ok ? p.fmt(p.dv(r.pInt - p.PATM, 'pressureG'), 0) : '—') + '</td><td class="num">' + (r.ok ? p.fmt(r.gvf * 100, 1) + ' %' : '—') + '</td><td class="num">' + (r.ok ? p.fmt(p.dv(r.bhp, 'power'), 0) : '—') + '</td><td class="num">' + (_fin(r.load) ? p.fmt(r.load * 100, 0) + ' %' : '—') + '</td><td>' + (r.ok ? (r.rangeStatus === 'ok' ? '✓ inside' : (r.rangeStatus === 'down' ? '⚠ downthrust' : '⚠ upthrust')) : '—') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '';
    }

    // ── the pump curve editor ────────────────────────────────────────────────
    var COLS = [['q', 'Rate', 'liquidRate', 'bbl/d', 0], ['h', 'Head / stage', 'length', 'ft', 2], ['e', 'Efficiency', null, '%', 1], ['b', 'BHP / stage', 'power', 'hp', 3]];
    function _cellV(p, v, c) { if (!_fin(v)) return ''; var d = c[2] ? p.dv(v, c[2]) : v; return String(+(+d).toPrecision(6)); }
    function _pumpEditor(p, force) {
        var tb = _byId('wpe_tbl'), meta = _byId('wpe_meta'); if (!tb || !meta) return;
        var rec = _esp(p).pump || null, key = JSON.stringify([rec, p.metric()]);
        var ae = document.activeElement;
        if (!force && (S.pumpKey === key || (ae && ae.closest && ae.closest('#wpe_tbl,#wpe_meta')))) { _pumpSum(p); return; }
        S.pumpKey = key;
        var EP = E(), np = EP && rec ? EP.normPump(rec) : null, bepQ = np && np.ok ? np.pump.bep.q : null;
        var rows = rec && Array.isArray(rec.rows) && rec.rows.length ? rec.rows : [[null, null, null, null], [null, null, null, null], [null, null, null, null]];
        var near = -1; if (_fin(bepQ)) rows.forEach(function (r, i) { if (near < 0 || Math.abs(r[0] - bepQ) < Math.abs(rows[near][0] - bepQ)) near = i; });
        tb.innerHTML = '<thead><tr>' + COLS.map(function (c) { return '<th>' + _esc(c[1]) + ' (' + _esc(c[2] ? p.lab(c[2], c[3]) : c[3]) + ')</th>'; }).join('') + '<th class="x" aria-label="Delete"></th></tr></thead><tbody>' +
            rows.map(function (r, i) {
                return '<tr' + (i === near ? ' class="bep" title="nearest row to the best-efficiency point"' : '') + '>' + COLS.map(function (c, j) { return '<td><input type="text" inputmode="decimal" data-wpe="' + j + '" aria-label="' + _esc(c[1] + ' row ' + (i + 1)) + '" value="' + _esc(_cellV(p, r[j], c)) + '"></td>'; }).join('') +
                    '<td class="x"><button type="button" class="wpe-del" data-act="espdel" data-i="' + i + '" aria-label="Delete row ' + (i + 1) + '">×</button></td></tr>';
            }).join('') + '</tbody>';
        var mv = function (k, cat) { var v = rec ? rec[k] : null; return _fin(v) ? String(+(+(cat ? p.dv(v, cat) : v)).toPrecision(6)) : ''; };
        var fi = function (k, label, unit, cat, ph, text) { return '<div class="fg-item"><label>' + _esc(label) + (unit ? ' (' + _esc(unit) + ')' : '') + '<input type="' + (text ? 'text' : 'text') + '" ' + (text ? '' : 'inputmode="decimal" ') + 'data-wpem="' + k + '" value="' + _esc(k === 'name' ? (rec && rec.name || '') : mv(k, cat)) + '" placeholder="' + _esc(ph || '') + '"></label></div>'; };
        meta.innerHTML = fi('name', 'Pump name', '', null, 'e.g. 400-stage design', true) + fi('f0', 'Base frequency', 'Hz', null, '60') +
            fi('qMin', 'Range from', p.lab('liquidRate', 'bbl/d'), 'liquidRate', '70 % BEP') + fi('qMax', 'Range to', p.lab('liquidRate', 'bbl/d'), 'liquidRate', '130 % BEP') + fi('od_in', 'OD', p.lab('lengthSmall', 'in'), 'lengthSmall', '4.0');
        _pumpSum(p);
    }
    function _pumpSum(p) {
        var h = _byId('wpe_pumpsum'), EP = E(); if (!h || !EP) return;
        var rec = _esp(p).pump, np = rec ? EP.normPump(rec) : null;
        if (!np) { h.innerHTML = p.vHtml({ st: 'info', t: 'ℹ No pump curve yet: type the rows, paste them, or load the example pump.' }); return; }
        if (!np.ok) { h.innerHTML = p.vHtml({ st: 'fail', t: '✗ ' + np.errors[0] }); return; }
        var P0 = np.pump;
        h.innerHTML = '<div class="wpe-md" style="margin:0">' + ['BEP ' + _qL(p, P0.bep.q) + ' · ' + p.u(P0.bep.h, 'length', 1, 'ft') + '/stage · ' + p.fmt(P0.bep.eff * 100, 0) + ' %', 'range ' + p.fmt(p.dv(P0.range.qMin, 'liquidRate'), 0) + '–' + _qL(p, P0.range.qMax) + (P0.range.assumed ? ' (assumed ±30 %)' : ''), 'at ' + p.fmt(P0.f0, 0) + ' Hz', P0.rows.length + ' rows' + (P0.example ? ' · generic example' : '')]
            .map(function (t) { return '<span class="wpe-pill">' + _esc(t) + '</span>'; }).join('') + '</div>' + (np.warnings || []).map(function (w) { return p.vHtml({ st: w.sev === 'info' ? 'info' : 'warn', t: (w.sev === 'info' ? 'ℹ ' : '⚠ ') + w.msg }); }).join('');
    }
    function _collect(p) {
        var tb = _byId('wpe_tbl'), meta = _byId('wpe_meta'); if (!tb) return null;
        var rows = [];
        Array.prototype.forEach.call(tb.querySelectorAll('tbody tr'), function (tr) {
            var r = [null, null, null, null];
            Array.prototype.forEach.call(tr.querySelectorAll('input[data-wpe]'), function (inp) { var j = +inp.getAttribute('data-wpe'), v = _num(inp.value), c = COLS[j]; r[j] = v == null ? null : (c[2] ? p.fromDisp(v, c[2]) : v); });
            rows.push(r);
        });
        var rec = Object.assign({}, _esp(p).pump || {}), mv = function (k, cat) { var e = meta && meta.querySelector('input[data-wpem="' + k + '"]'); if (!e) return rec[k]; var v = _num(e.value); return v == null ? null : (cat ? p.fromDisp(v, cat) : v); };
        var ne = meta && meta.querySelector('input[data-wpem="name"]');
        rec.v = 1; rec.name = ne ? String(ne.value || '').slice(0, 48) : (rec.name || ''); rec.f0 = mv('f0'); rec.qMin = mv('qMin', 'liquidRate'); rec.qMax = mv('qMax', 'liquidRate'); rec.od_in = mv('od_in', 'lengthSmall');
        rec.rows = rows.filter(function (r) { return r.some(function (x) { return x != null; }); });
        rec.example = false;
        return rec;
    }
    function _write(p, rec, note) {
        var Mm = G.WTS_wp_model; if (!Mm) return;
        var r = Mm.write({ pump: rec });
        if (r && !r.ok) _msg('The pump curve was not saved: ' + ((r.errors || []).join(' ') || r.code), 'fail');
        else if (note) _msg(note, 'info');
        S.pumpKey = null;
        var pp = P(); if (pp) { pp.ST.M = pp.read() || pp.ST.M; _pumpEditor(pp, true); }
    }
    function _bindTable() {
        var card = _byId('wpe_curvecard'); if (!card || card.__wpeBound || !card.addEventListener) return;
        card.__wpeBound = true;
        card.addEventListener('change', function (e) {
            var t = e.target; if (!t || !t.getAttribute) return;
            if (t.getAttribute('data-wpe') == null && t.getAttribute('data-wpem') == null) return;
            var p = P(); if (!p) return;
            _write(p, _collect(p));
        });
    }
    // the device pump library (Q11; a device preference, not part of projects)
    function _lib() { try { var s = (typeof localStorage !== 'undefined') ? localStorage.getItem(LIB_KEY) : null, a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a.filter(function (x) { return x && typeof x.name === 'string' && x.rec; }) : []; } catch (e) { return []; } }
    function _libSet(a) { try { if (typeof G.WTS_lsSet === 'function') G.WTS_lsSet(LIB_KEY, JSON.stringify(a.slice(0, LIB_MAX))); } catch (e) { /* device pref only */ } }
    function _libList() {
        var s = _byId('wpe_lib'); if (!s) return;
        var a = _lib(), cur = s.value;
        s.innerHTML = a.length ? a.map(function (x, i) { return '<option value="' + i + '"' + (String(i) === cur ? ' selected' : '') + '>' + _esc(x.name) + '</option>'; }).join('') : '<option value="">— no saved pumps —</option>';
    }

    // ── actions ──────────────────────────────────────────────────────────────
    function _drive(p, job, label, done) { p.drive(p.jobOf(job), done, label, 'wpe_msg'); }
    function act(a, btn) {
        if (String(a).indexOf('esp') !== 0) return false;
        var p = P(); if (!p) return true;
        var M = p.ST.M || p.read(), EP = E();
        if (!EP) { _msg('The ESP engine is not available.', 'warn'); return true; }
        if (a === 'espex') { _write(p, EP.example(), 'Example pump loaded: a generic curve (about 1,550 bbl/d best efficiency at 60 Hz), not a catalogue pump.'); return true; }
        if (a === 'espadd') { var rec = _collect(p) || { rows: [] }; rec.rows.push([null, null, null, null]); S.pumpKey = null; var Mx = p.ST.M; if (Mx) { var t = _byId('wpe_tbl'); if (t) { var tr = document.createElement('tr'); tr.innerHTML = COLS.map(function (c, j) { return '<td><input type="text" inputmode="decimal" data-wpe="' + j + '" aria-label="' + _esc(c[1]) + ' new row"></td>'; }).join('') + '<td class="x"></td>'; var tbd = t.querySelector('tbody'); if (tbd) tbd.appendChild(tr); var f = tr.querySelector('input'); if (f && f.focus) f.focus(); } } return true; }
        if (a === 'espdel') { var r2 = _collect(p); if (!r2) return true; var i = +btn.getAttribute('data-i'); r2.rows = (_esp(p).pump && _esp(p).pump.rows || []).filter(function (x, k) { return k !== i; }); _write(p, r2); return true; }
        if (a === 'espclear') { _write(p, null, 'Pump curve cleared.'); return true; }
        if (a === 'esppaste') { var pb = _byId('wpe_paste'); if (pb && pb.classList) pb.classList.toggle('on'); return true; }
        if (a === 'esppasteok') {
            var ta = _byId('wpe_pastet'), txt = ta ? String(ta.value || '') : '', rows = [];
            txt.split(/\r?\n/).forEach(function (ln) { var cells = ln.split(/[\t;,]|\s{2,}|\s(?=[-+]?\d)/).map(function (c) { return _num(c); }).filter(function (v) { return v != null; }); if (cells.length >= 2) rows.push([cells[0], cells[1], cells[2], cells[3]].map(function (v, j) { return v == null ? null : (COLS[j][2] ? p.fromDisp(v, COLS[j][2]) : v); })); });
            if (rows.length < 3) { _msg('Paste at least three rows of rate and head per stage (efficiency and BHP optional).', 'warn'); return true; }
            var r3 = Object.assign({}, _esp(p).pump || { name: 'Pasted pump', f0: 60 }, { rows: rows, example: false });
            _write(p, r3, rows.length + ' rows pasted.'); var pb2 = _byId('wpe_paste'); if (pb2 && pb2.classList) pb2.classList.remove('on');
            return true;
        }
        if (a === 'esplibsave') { var cur = _esp(p).pump; if (!cur || !EP.normPump(cur).ok) { _msg('Enter a valid pump curve first.', 'warn'); return true; } var lib = _lib().filter(function (x) { return x.name !== (cur.name || 'Pump'); }); lib.unshift({ name: cur.name || 'Pump', rec: cur }); _libSet(lib); _libList(); _msg('Saved to the pump library on this device.', 'ok'); return true; }
        if (a === 'esplibload') { var s = _byId('wpe_lib'), x = _lib()[+(s && s.value)]; if (!x) { _msg('No saved pump selected.', 'warn'); return true; } _write(p, x.rec, 'Loaded "' + x.name + '" from the library.'); return true; }
        if (a === 'esplibdel') { var s2 = _byId('wpe_lib'), k2 = +(s2 && s2.value), l2 = _lib(); if (!l2[k2]) return true; l2.splice(k2, 1); _libSet(l2); _libList(); return true; }
        var q = _canonVal('wpv_esp_tq');
        if (a === 'espsize') {
            if (!(q > 0)) { _msg('Enter the target liquid rate first.', 'warn'); return true; }
            var sz = EP.sizeStages(M, q); sz.key = _key(p); S.size = sz;
            var box = _byId('wpe_sized');
            if (box) box.innerHTML = sz.ok ? '<div class="rbox" style="margin-top:8px"><div class="rbox-title">Stages for ' + _esc(_qL(p, q)) + '</div>' +
                [['Stages needed', p.fmt(sz.stages, 0)], ['Total dynamic head', p.u(sz.tdh, 'length', 0, 'ft')], ['Head per stage there', p.u(sz.hPerStage, 'length', 1, 'ft')], ['Rate through the pump', _qL(p, sz.Qin) + (sz.rangeStatus === 'ok' ? ' (in range)' : ' (' + (sz.rangeStatus === 'down' ? 'downthrust' : 'upthrust') + ')')]]
                    .map(function (r) { return '<div class="rrow"><span class="rl">' + _esc(r[0]) + '</span><span class="rv">' + _esc(r[1]) + '</span></div>'; }).join('') + '</div><div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="espusestages" data-v="' + sz.stages + '">Use ' + sz.stages + ' stages</button></div>'
                : p.vHtml({ st: 'fail', t: '✗ ' + ((sz.errors || [])[0] || 'no answer') });
            _summary(p);
            return true;
        }
        if (a === 'espusestages') { p.setCtrl('wp_esp_stages', +btn.getAttribute('data-v'), false); p.commit('wp_esp_stages'); return true; }
        if (a === 'espfreq') {
            if (!(q > 0)) { _msg('Enter the target liquid rate first.', 'warn'); return true; }
            _drive(p, p.call('WTS_wp_system.designFor', M, { freq: q }), 'Frequency for ' + _qL(p, q), function (r) {
                var box = _byId('wpe_sized');
                if (box) box.innerHTML = r && r.ok ? '<div class="rbox" style="margin-top:8px"><div class="rbox-title">Frequency for ' + _esc(_qL(p, q)) + '</div><div class="rrow"><span class="rl">Frequency</span><span class="rv">' + _esc(p.fmt(r.freq, 2)) + ' Hz (' + r.solves + ' solves)</span></div></div><div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="espusefreq" data-v="' + (Math.round(r.freq * 10) / 10) + '">Use ' + p.fmt(Math.round(r.freq * 10) / 10, 1) + ' Hz</button></div>'
                    : p.vHtml({ st: 'fail', t: '✗ ' + (((r && r.errors) || [])[0] || 'no frequency reaches this rate') });
            });
            return true;
        }
        if (a === 'espusefreq') { p.setCtrl('wp_esp_freq', +btn.getAttribute('data-v'), false); p.commit('wp_esp_freq'); return true; }
        if (a === 'espsweep') {
            var fl = p.parseList((_byId('wpv_esp_flist') || {}).value || '').filter(function (f) { return f >= 30 && f <= 90; });
            _drive(p, EP.sweep(M, { freqs: fl.length ? fl : FAN }), 'Rate against frequency', function (r) { S.sweep = r; S.sweepKey = _key(p); _drawSweep(p); _summary(p); p.renderStudies(); });
            return true;
        }
        return true;
    }
    function change(el) { var id = el && el.id || ''; return /^wpv_esp_/.test(id); }
    function input() { return false; }
    function studies() {
        var p = P(); if (!p || !_on(p)) return null;
        var L = _L(p); if (!L) return null;
        var mo = L.motor || {};
        return { rows: [['ESP', p.fmt(L.stages, 0) + ' stages at ' + p.fmt(L.freq, 1) + ' Hz, ' + p.mdTvdTxt(L.pumpMd, L.pumpTvd) + '; ' + _qL(p, L.Qin) + ' through the pump (' + (L.rangeStatus === 'ok' ? 'in range' : L.rangeStatus === 'down' ? 'downthrust' : 'upthrust') + '), TDH ' + p.u(L.tdh, 'length', 0, 'ft') + ', ' + p.u(L.bhp, 'power', 0, 'hp') +
            (mo.ok ? ' (motor ' + p.fmt(mo.load * 100, 0) + ' %)' : '') + '; gas ' + p.fmt(L.gvfIn * 100, 1) + ' % — provisional']] };
    }
    function csv() {
        var p = P(); if (!p || !_on(p)) return null;
        var L = _L(p), out = [], e = _esp(p);
        if (e.pump && Array.isArray(e.pump.rows)) out.push(['ESP pump curve (field units, ' + (e.pump.f0 || 60) + ' Hz): rate bbl/d, head ft/stage, efficiency %, BHP hp/stage'].concat(e.pump.rows.map(function (r) { return r.map(function (x) { return x == null ? '' : x; }).join(','); })).join('\n'));
        if (L) out.push(['ESP at the operating point (field units)', 'setting MD ft,' + L.pumpMd, 'setting TVD ft,' + L.pumpTvd, 'frequency Hz,' + L.freq, 'stages,' + L.stages, 'intake psia,' + L.pInt, 'discharge psia,' + L.pDis, 'TDH ft,' + L.tdh, 'Q intake bbl/d,' + L.Qin,
            'gas fraction intake,' + L.gvfIn, 'Turpin phi,' + L.phi, 'separation,' + L.E, 'BHP hp,' + L.bhp, 'efficiency,' + L.eff, 'range,' + L.rangeStatus].join('\n'));
        if (S.sweep && S.sweep.ok) out.push(['ESP rate against frequency: Hz, liquid bbl/d, intake psia, gas fraction, BHP hp, motor load, range'].concat(S.sweep.rows.map(function (r) { return [r.f, r.qL, r.pInt, r.gvf, r.bhp, r.load, r.rangeStatus].map(function (x) { return x == null ? '' : (typeof x === 'number' ? +x.toPrecision(8) : x); }).join(','); })).join('\n'));
        return out;
    }
    function notes() {
        var p = P(); if (!p || !_on(p)) return null;
        return ['ESP: affinity laws exact; the viscosity correction (Turzo, Takacs & Zsuga 2000), the natural gas separation (after Alhanati 1993), the gas criterion (Turpin et al. 1986) and the motor / cable basics are provisional — not verified against a published example. The separated gas rejoins at the wellhead; no temperature rise through the pump.'];
    }
    function reset() { S.sweep = null; S.size = null; S.design = null; S.pumpKey = null; S.tagged = false; }
    function resize() { ['wp_cv_esp', 'wp_cv_espf'].forEach(function (id) { var cv = _byId(id); if (cv && G.WTS_wp_view) G.WTS_wp_view.redraw(cv); }); }

    G.WTS_wellperf_ext = G.WTS_wellperf_ext || {};
    G.WTS_wellperf_ext.esp = { resHtml: resHtml, stepHtml: stepHtml, render: render, act: act, change: change, input: input, studies: studies, csv: csv, notes: notes, reset: reset, resize: resize,
        state: function () { return S; }, LIB_KEY: LIB_KEY };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, X = G.WTS_wellperf_ext && G.WTS_wellperf_ext.esp;
    if (!(X && typeof X.stepHtml === 'function' && X.act('other') === false) && typeof console !== 'undefined') console.error('[49-calc-wp-espui.js self-test] extension malformed');
})();
