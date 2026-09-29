// ════════════════════════════════════════════════════════════════════
// WTS — Layer 30 — Cross-Suite Quick Report PDF
//
// PURPOSE
//   Aggregates the most recently calculated outputs from every
//   calculator in the suite into a single, printable HTML report
//   (1-3 pages typical). The user can then "Save as PDF" from the
//   browser print dialog without having to PDF each calculator
//   individually and stitch them together.
//
//   Sections covered (each shown only if the corresponding module
//   has state under window.WTS_state.*):
//     • Header  — client / well / field, date, suite version
//     • WTS Flow Profile Summary
//     • ESD Hi-Pilot Analysis        (PASS / FAIL)
//     • ESD Lo-Pilot Analysis        (REACHABLE / UNREACHABLE)
//     • Hydrate Management Summary   (per-node risk + MeOH duty)
//     • Liquid Line / RO Sizing      (PROTECTED / UNDERSIZED)
//     • Pipe Service Life            (limiting segment, remaining days)
//     • PRiSM Well Test Analysis     (model, R², RMSE, AIC, k, kh, S, C,
//                                     ΔpS, FE, parameters, interpretation)
//
// PUBLIC API
//   window.WTS_quickReport = {
//       generate(opts?) → triggers window.print() with the report,
//       preview(opts?)  → returns the report HTML for inline preview,
//       setModules(keys) → which sections to include (default: all),
//       getModules()    → array of currently-selected module keys,
//       availableModules() → array of module keys that have state
//   };
//   window.WTS_renderQuickReportButton(container)
//       → mounts a "Quick Report" button into a host container
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'
//   • Vanilla JS only (Math.* + window.print)
//   • Print-friendly: @media print rules size at A4 portrait,
//     12px serif/sans body, hides on-screen controls
//   • Defensive: missing modules show a "Not run yet" placeholder
//     rather than throwing
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _log()  { if (typeof console !== 'undefined' && console.log)  try { console.log.apply(console, arguments); }  catch (e) {} }
    function _warn() { if (typeof console !== 'undefined' && console.warn) try { console.warn.apply(console, arguments); } catch (e) {} }
    function _err()  { if (typeof console !== 'undefined' && console.error) try { console.error.apply(console, arguments); } catch (e) {} }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function _isNum(v) { return (typeof v === 'number') && isFinite(v); }
    function _fmt(v, dp) {
        if (!_isNum(v)) return '—';
        var d = (dp == null) ? 2 : dp;
        if (Math.abs(v) >= 1e6) return v.toExponential(3);
        if (Math.abs(v) >= 1000) return v.toFixed(Math.min(d, 0));
        if (Math.abs(v) >= 1)    return v.toFixed(d);
        return v.toFixed(Math.max(d, 3));
    }
    function _fmtInt(v) {
        if (!_isNum(v)) return '—';
        return Math.round(v).toLocaleString('en-US');
    }
    function _statusBadge(text, color) {
        return '<span style="display:inline-block;padding:2px 8px;border-radius:3px;' +
               'background:' + color + ';color:#fff;font-weight:600;font-size:11px;' +
               'letter-spacing:.04em;text-transform:uppercase">' + _esc(text) + '</span>';
    }
    function _greenBadge(text)  { return _statusBadge(text || 'PASS', '#2e8540'); }
    function _redBadge(text)    { return _statusBadge(text || 'FAIL', '#b22222'); }
    function _yellowBadge(text) { return _statusBadge(text || 'WARN', '#b59000'); }

    // ───────────────────────────────────────────────────────────────
    // Module catalogue — which keys to render, in what order, with
    // what label and what state-reader. Forward-compatible: adding a
    // new module is one line here.
    // ───────────────────────────────────────────────────────────────
    var MODULE_CATALOG = [
        { key: 'header',     label: 'Header' },
        { key: 'wts',        label: 'WTS Flow Profile Summary' },
        { key: 'esdhi',      label: 'ESD Hi-Pilot Analysis' },
        { key: 'esdlo',      label: 'ESD Lo-Pilot Analysis' },
        { key: 'hydrate',    label: 'Hydrate Management' },
        { key: 'liquidline', label: 'Liquid Line / RO Sizing' },
        { key: 'pipelife',   label: 'Pipe Service Life' },
        { key: 'prism',      label: 'PRiSM Well Test Analysis' }
    ];

    var SELECTED = null;   // null = all; otherwise array of keys

    function setModules(keys) {
        if (!keys) { SELECTED = null; return getModules(); }
        if (!Array.isArray(keys)) { SELECTED = null; return getModules(); }
        SELECTED = keys.slice();
        return SELECTED.slice();
    }
    function getModules() {
        if (SELECTED) return SELECTED.slice();
        var out = [];
        for (var i = 0; i < MODULE_CATALOG.length; i++) out.push(MODULE_CATALOG[i].key);
        return out;
    }
    function availableModules() {
        var out = [];
        for (var i = 0; i < MODULE_CATALOG.length; i++) {
            var k = MODULE_CATALOG[i].key;
            if (k === 'header') continue;
            if (_hasState(k)) out.push(k);
        }
        return out;
    }

    function _hasState(key) {
        switch (key) {
            case 'wts':        return !!(G.WTS_state && (G.WTS_state.nodes || G.WTS_state.flow));
            case 'esdhi':      return !!(G.WTS_state && G.WTS_state.esdHiPilot);
            case 'esdlo':      return !!(G.WTS_state && G.WTS_state.esdLoPilot);
            case 'hydrate':    return !!(G.WTS_state && G.WTS_state.hydrate);
            case 'liquidline': return !!(G.WTS_state && G.WTS_state.liquidline);
            case 'pipelife':   return !!(G.WTS_state && G.WTS_state.pipelife);
            case 'prism': {
                // A fit exists, or a model is chosen and data is loaded.
                if (_prismFit()) return true;
                var st = G.PRiSM_state, ds = G.PRiSM_dataset;
                return !!(st && st.model && ds && ds.t && ds.t.length);
            }
            default:           return false;
        }
    }

    // ─── PRiSM helpers ────────────────────────────────────────────
    // Last fit through the C4 getter (normalised keys), else the raw state
    // with both key spellings accepted (R2/r2, RMSE/rmse, AIC/aic, model/modelKey).
    function _num() {
        for (var i = 0; i < arguments.length; i++) if (_isNum(arguments[i])) return arguments[i];
        return NaN;
    }
    function _prismFit() {
        var f = null;
        if (typeof G.PRiSM_getLastFit === 'function') {
            try { f = G.PRiSM_getLastFit(); } catch (e) { f = null; }
        }
        if (!f && G.PRiSM_state && G.PRiSM_state.lastFit && typeof G.PRiSM_state.lastFit === 'object') f = G.PRiSM_state.lastFit;
        if (!f) return null;
        return {
            modelKey: f.modelKey || f.model || (G.PRiSM_state && G.PRiSM_state.model) || null,
            source: f.source || '', kind: f.kind || 'pressure',
            r2: _num(f.r2, f.R2), rmse: _num(f.rmse, f.RMSE), aic: _num(f.aic, f.AIC),
            ci95: f.ci95 || f.CI95 || {}, params: f.params || {}, phys: f.phys || {},
            converged: f.converged, iterations: f.iterations, stale: !!f.stale
        };
    }
    function _prismModelLabel(key) {
        var e = key && G.PRiSM_MODELS ? G.PRiSM_MODELS[key] : null;
        var lbl = (e && (e.label || e.name)) || '';
        if (!lbl && key) lbl = String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); });
        return lbl;
    }
    // Key results: the report layer's summary when present, else computed
    // here from lastFit.phys and the well inputs (field units).
    function _prismResults(fit) {
        if (typeof G.PRiSM_reportResults === 'function') {
            try { var r = G.PRiSM_reportResults(); if (r) return r; } catch (e) { _warn('reportResults failed', e); }
        }
        var ph = (fit && fit.phys) || {};
        var w = null;
        if (typeof G.PRiSM_getWell === 'function') { try { w = G.PRiSM_getWell(); } catch (e) { w = null; } }
        if (!w) {
            var s = G.PRiSM_pvt || {}, c = s._computed || {};
            w = { q: s.q, B: _num(s.Bo, c.B), mu: _num(s.mu_o, c.mu), h: s.h, rw: s.rw,
                  pi: (s.provenance && s.provenance.p_res && s.provenance.p_res !== 'default') ? s.p_res : null, fluid: s.fluidType };
        }
        var k = _num(ph.k), kh = _num(ph.kh, k * w.h), S = _num(ph.S, fit && fit.params ? fit.params.S : NaN);
        var out = { k: k, kh: kh, S: S, C: _num(ph.C), Cd: _num(ph.Cd, fit && fit.params ? fit.params.Cd : NaN), dpS: NaN, FE: NaN };
        if (w.fluid !== 'gas') out.dpS = 141.2 * w.q * w.B * w.mu * S / kh;
        var ds = G.PRiSM_dataset, pi = _num(ph.pi, w.pi);
        if (_isNum(out.dpS) && _isNum(pi) && ds && ds.p && ds.p.length) {
            var pwf = ds.p[ds.p.length - 1], dd = pi - pwf;
            if (_isNum(pwf) && dd > 0) out.FE = (dd - out.dpS) / dd;
        }
        return out;
    }

    // ───────────────────────────────────────────────────────────────
    // Section renderers — each returns a full HTML fragment for the
    // report (or a "Not run yet" placeholder).
    // ───────────────────────────────────────────────────────────────
    function _placeholder(label) {
        return '<div class="qr-placeholder">' + _esc(label) + ' — not run yet.</div>';
    }

    function _row(label, value, units) {
        var v = (value === undefined || value === null || value === '') ? '—' : _esc(value);
        if (units) v += ' <span class="qr-units">' + _esc(units) + '</span>';
        return '<tr><th>' + _esc(label) + '</th><td>' + v + '</td></tr>';
    }

    function _section(title, bodyHTML, extra) {
        var ex = extra ? (' ' + extra) : '';
        return '<section class="qr-section"' + ex + '>' +
               '<h2 class="qr-section-title">' + _esc(title) + '</h2>' +
               bodyHTML + '</section>';
    }

    // ─── Header ───────────────────────────────────────────────────
    function _renderHeader() {
        // Client & Well Info page persists to localStorage 'h2oil_client_info'
        // ({client, well, field, ref, engineer, …}); WTS_state.clientInfo is
        // only populated by project files.
        var ci = {};
        try { ci = JSON.parse(G.localStorage.getItem('h2oil_client_info') || '{}') || {}; } catch (e) { ci = {}; }
        if (G.WTS_state && G.WTS_state.clientInfo) {
            var pci = G.WTS_state.clientInfo;
            for (var pk in pci) if (Object.prototype.hasOwnProperty.call(pci, pk) && ci[pk] == null) ci[pk] = pci[pk];
        }
        ci.clientName = ci.clientName || ci.client;
        ci.wellName   = ci.wellName   || ci.well;
        ci.jobId      = ci.jobId      || ci.ref;
        var now = new Date();
        var dateStr = now.toISOString().substring(0, 10) + ' ' +
                      now.toTimeString().substring(0, 5);
        var version = (G.WTS_VERSION || G.PRiSM_VERSION || '1.0');
        var meta =
            '<table class="qr-meta">' +
            '<tr><th>Client</th><td>' + _esc(ci.clientName || ci.operator || '—') + '</td>' +
            '<th>Well</th><td>' + _esc(ci.wellName || '—') + '</td></tr>' +
            '<tr><th>Field</th><td>' + _esc(ci.fieldName || ci.field || '—') + '</td>' +
            '<th>Date</th><td>' + _esc(dateStr) + '</td></tr>' +
            '<tr><th>Job ID</th><td>' + _esc(ci.jobId || ci.afe || '—') + '</td>' +
            '<th>Engineer</th><td>' + _esc(ci.engineer || ci.user || '—') + '</td></tr>' +
            '</table>';
        return '<header class="qr-header">' +
               '<div class="qr-logo">H2Oil</div>' +
               '<div class="qr-titleblock">' +
               '<h1>Well Testing Suite — Quick Report</h1>' +
               '<div class="qr-subtitle">Aggregated calculator outputs · suite v' +
               _esc(version) + '</div>' +
               '</div>' +
               '</header>' + meta;
    }

    // ─── WTS Flow Profile ─────────────────────────────────────────
    function _renderWTSSummary() {
        if (!_hasState('wts')) return _placeholder('WTS Flow Profile');
        var s = G.WTS_state;
        var rows = '';
        var fp = s.flow || {};
        rows += _row('Wellhead Pressure', _fmt(fp.wellheadPressure, 0), 'psig');
        rows += _row('Wellhead Temperature', _fmt(fp.wellheadTemp, 1), '°F');
        rows += _row('Gas Rate',  _fmt(fp.gasRate, 2),  'MMscf/d');
        rows += _row('Oil Rate',  _fmtInt(fp.oilRate),  'STB/d');
        rows += _row('Water Rate', _fmtInt(fp.waterRate), 'bbl/d');
        rows += _row('Choke Bean', _fmt(fp.chokeBean, 0), '/64"');
        rows += _row('Separator Pressure', _fmt(fp.separatorPressure, 0), 'psig');

        var nodeRows = '';
        if (Array.isArray(s.nodes) && s.nodes.length) {
            nodeRows =
                '<h3 class="qr-h3">Node-by-Node Profile</h3>' +
                '<table class="qr-table">' +
                '<thead><tr><th>Node</th><th>P (psig)</th><th>T (°F)</th><th>v (ft/s)</th></tr></thead><tbody>';
            for (var i = 0; i < s.nodes.length; i++) {
                var n = s.nodes[i] || {};
                nodeRows += '<tr><td>' + _esc(n.label || n.name || ('#' + (i + 1))) + '</td>' +
                            '<td>' + _fmt(n.pressure, 0) + '</td>' +
                            '<td>' + _fmt(n.temperature, 1) + '</td>' +
                            '<td>' + _fmt(n.velocity, 1) + '</td></tr>';
            }
            nodeRows += '</tbody></table>';
        }
        return _section('WTS Flow Profile Summary',
            '<table class="qr-kv">' + rows + '</table>' + nodeRows);
    }

    // ─── ESD Hi-Pilot ─────────────────────────────────────────────
    function _renderESDHi() {
        if (!_hasState('esdhi')) return _placeholder('ESD Hi-Pilot');
        var e = G.WTS_state.esdHiPilot;
        var badge = (e.pass === true)  ? _greenBadge('PASS') :
                    (e.pass === false) ? _redBadge('FAIL') :
                                         _yellowBadge('INDETERMINATE');
        var rows = '';
        rows += _row('Hi-Pilot Setting',     _fmt(e.hiPilotSetting_psig, 0), 'psig');
        rows += _row('Rupture Disc Setting', _fmt(e.rdSetting_psig, 0),       'psig');
        rows += _row('Section MAWP',         _fmt(e.mawp_psig, 0),            'psig');
        rows += _row('Time to Reach RV',     _fmt(e.timeToReachRV_s, 2),      's');
        rows += _row('ESD Response Window',  _fmt(e.esdResponseTime_s, 2),    's');
        rows += _row('Margin',                _fmt(e.marginSeconds, 2),        's');
        rows += _row('Gas Released to Atm.', _fmtInt(e.gasReleasedToAtmosphere_scf), 'scf');
        var rationale = e.rationale ? ('<p class="qr-rationale">' + _esc(e.rationale) + '</p>') : '';
        return _section('ESD Hi-Pilot Analysis',
            '<p class="qr-status">Status: ' + badge + '</p>' +
            '<table class="qr-kv">' + rows + '</table>' + rationale);
    }

    // ─── ESD Lo-Pilot ─────────────────────────────────────────────
    function _renderESDLo() {
        if (!_hasState('esdlo')) return _placeholder('ESD Lo-Pilot');
        var e = G.WTS_state.esdLoPilot;
        var reachable = (e.reachable === true);
        var badge = reachable ? _greenBadge('REACHABLE') : _redBadge('UNREACHABLE');
        var rows = '';
        rows += _row('Lo-Pilot (PSL) Target', _fmt(e.psl_target_psig, 0), 'psig');
        rows += _row('Operating Pressure',    _fmt(e.operating_psig, 0),  'psig');
        rows += _row('Drawdown Required',     _fmt(e.drawdown_psi, 0),    'psi');
        rows += _row('Detection Time',        _fmt(e.detectionTime_s, 1), 's');
        var note = e.recommendation ? ('<p class="qr-rationale">' + _esc(e.recommendation) + '</p>') : '';
        return _section('ESD Lo-Pilot Analysis',
            '<p class="qr-status">Status: ' + badge + '</p>' +
            '<table class="qr-kv">' + rows + '</table>' + note);
    }

    // ─── Hydrate Management ───────────────────────────────────────
    function _renderHydrate() {
        if (!_hasState('hydrate')) return _placeholder('Hydrate Management');
        var h = G.WTS_state.hydrate;
        var nodes = Array.isArray(h.nodes) ? h.nodes : [];
        var red = 0, yellow = 0, green = 0;
        var totalMeOH = 0;
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var r = String(n.risk || '').toLowerCase();
            if (r === 'red')    red++;
            else if (r === 'yellow') yellow++;
            else green++;
            if (_isNum(n.meoh_ccmin)) totalMeOH += n.meoh_ccmin;
        }
        var summary =
            '<p class="qr-status">Risk: ' +
            _redBadge(red + ' RED') + ' &nbsp; ' +
            _yellowBadge(yellow + ' YELLOW') + ' &nbsp; ' +
            _greenBadge(green + ' GREEN') + '</p>';
        var rows = '';
        rows += _row('Inhibitor', h.inhibitor || 'MeOH');
        rows += _row('Total Inhibitor Required', _fmt(totalMeOH || h.total_inhibitor_ccmin, 1), 'cc/min');
        rows += _row('Subcooling Margin', _fmt(h.subcooling_F, 1), '°F');
        var nodeTbl = '';
        if (nodes.length) {
            nodeTbl =
                '<h3 class="qr-h3">Per-Node Risk</h3>' +
                '<table class="qr-table"><thead>' +
                '<tr><th>Node</th><th>T (°F)</th><th>P (psig)</th><th>Hydrate T (°F)</th>' +
                '<th>Δsub (°F)</th><th>Risk</th></tr></thead><tbody>';
            for (var j = 0; j < nodes.length; j++) {
                var nn = nodes[j];
                var rk = String(nn.risk || '').toLowerCase();
                var rkBadge = (rk === 'red')    ? _redBadge('RED') :
                              (rk === 'yellow') ? _yellowBadge('YELLOW') :
                                                  _greenBadge('GREEN');
                nodeTbl += '<tr><td>' + _esc(nn.label || nn.name || ('Node ' + (j + 1))) + '</td>' +
                           '<td>' + _fmt(nn.temp_F, 1) + '</td>' +
                           '<td>' + _fmt(nn.p_psig, 0) + '</td>' +
                           '<td>' + _fmt(nn.thyd_F, 1) + '</td>' +
                           '<td>' + _fmt(nn.subcool_F, 1) + '</td>' +
                           '<td>' + rkBadge + '</td></tr>';
            }
            nodeTbl += '</tbody></table>';
        }
        return _section('Hydrate Management', summary + '<table class="qr-kv">' + rows + '</table>' + nodeTbl);
    }

    // ─── Liquid Line / RO ──────────────────────────────────────────
    function _renderLiquidLine() {
        if (!_hasState('liquidline')) return _placeholder('Liquid Line / RO Sizing');
        var l = G.WTS_state.liquidline;
        var protected_ = (l.protected === true || l.status === 'PROTECTED');
        var badge = protected_ ? _greenBadge('PROTECTED') : _redBadge('UNDERSIZED');
        var rows = '';
        rows += _row('Recommended RO',  _fmt(l.ro_recommended_64ths, 0), '/64"');
        rows += _row('Selected RO',     _fmt(l.ro_selected_64ths, 0),    '/64"');
        rows += _row('Velocity at RO',  _fmt(l.velocity_ftps, 1),        'ft/s');
        rows += _row('LCV Size',        _fmt(l.lcv_in, 2),               'in');
        rows += _row('Gas Blowby Margin', _fmt(l.blowby_margin, 2), '');
        var note = l.note ? ('<p class="qr-rationale">' + _esc(l.note) + '</p>') : '';
        return _section('Liquid Line / RO Sizing',
            '<p class="qr-status">Status: ' + badge + '</p>' +
            '<table class="qr-kv">' + rows + '</table>' + note);
    }

    // ─── Pipe Service Life ────────────────────────────────────────
    function _renderPipeLife() {
        if (!_hasState('pipelife')) return _placeholder('Pipe Service Life');
        var p = G.WTS_state.pipelife;
        var lim = p.limiting_segment || {};
        var days = _isNum(p.overall_min_life_days) ? p.overall_min_life_days : null;
        var badge;
        if (days == null)        badge = _yellowBadge('N/A');
        else if (days < 30)      badge = _redBadge('CRITICAL');
        else if (days < 180)     badge = _yellowBadge('MONITOR');
        else                     badge = _greenBadge('OK');
        var rows = '';
        rows += _row('Limiting Segment', lim.label || lim.name || '—');
        rows += _row('Remaining Service Life', _fmt(days, 1), 'days');
        rows += _row('Time-to-Failure (current WT)', _fmt(lim.time_to_failure_at_current_days, 1), 'days');
        rows += _row('Erosion Rate', _fmt(lim.erosion_rate_mils_yr, 1), 'mils/year');
        rows += _row('Sand Rate', _fmt(p.sand_rate_lbMMscf, 1), 'lb/MMscf');
        rows += _row('Salama c-factor', _fmt(p.c_constant, 0), '');

        var segs = Array.isArray(p.segments) ? p.segments : [];
        var segTbl = '';
        if (segs.length) {
            segTbl =
                '<h3 class="qr-h3">All Segments</h3>' +
                '<table class="qr-table"><thead>' +
                '<tr><th>Segment</th><th>Erosion (mpy)</th><th>RSL (days)</th><th>TTF (days)</th><th>MAWP (psig)</th></tr></thead><tbody>';
            for (var i = 0; i < segs.length; i++) {
                var sg = segs[i] || {};
                segTbl += '<tr><td>' + _esc(sg.label || sg.name || ('#' + (i + 1))) + '</td>' +
                          '<td>' + _fmt(sg.erosion_rate_mils_yr, 1) + '</td>' +
                          '<td>' + _fmt(sg.remaining_service_life_days, 1) + '</td>' +
                          '<td>' + _fmt(sg.time_to_failure_at_current_days, 1) + '</td>' +
                          '<td>' + _fmt(sg.max_allowable_pressure_psig, 0) + '</td></tr>';
            }
            segTbl += '</tbody></table>';
        }
        return _section('Pipe Service Life',
            '<p class="qr-status">Status: ' + badge + '</p>' +
            '<table class="qr-kv">' + rows + '</table>' + segTbl);
    }

    // ─── PRiSM Well Test Analysis ──────────────────────────────────
    var PRISM_SOURCES = { regression: 'Regression', automatch: 'Auto-match', match: 'Type-curve match', semilog: 'Straight line' };
    function _sig(v, n) {
        if (!_isNum(v)) return '—';
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 1e5 || a < 1e-3) return v.toExponential(n - 1).replace('e+', 'e');
        return v.toFixed(Math.max(0, n - 1 - Math.floor(Math.log(a) / Math.LN10 + 1e-12)));
    }
    function _pm(ci, key, dp) {
        var c = ci && ci[key];
        if (!c || c.length !== 2 || !_isNum(c[0]) || !_isNum(c[1])) return '';
        return ' ± ' + (Math.abs(c[1] - c[0]) / 2).toFixed(dp);
    }
    function _renderPRiSM() {
        if (!_hasState('prism')) return _placeholder('PRiSM Well Test Analysis');
        var ps = G.PRiSM_state || {};
        var fit = _prismFit();
        var key = (fit && fit.modelKey) || ps.model || '';
        var res = fit ? (_prismResults(fit) || {}) : {};
        var rows = '';
        rows += _row('Model', key ? (res.modelLabel || _prismModelLabel(key)) + ' (' + key + ')' : '—');
        if (!fit) {
            rows += _row('Result', 'No fit yet — model chosen and data loaded');
            return _section('PRiSM Well Test Analysis', '<table class="qr-kv">' + rows + '</table>');
        }
        var ci = res.ci || fit.ci95 || {};
        rows += _row('Result from', PRISM_SOURCES[fit.source] || fit.source || '—');
        rows += _row('R²', _isNum(fit.r2) ? fit.r2.toFixed(5) : '—');
        rows += _row('RMSE', _sig(fit.rmse, 3), fit.kind === 'rate' ? 'rate units' : 'psi');
        rows += _row('AIC', _isNum(fit.aic) ? fit.aic.toFixed(1) : '—');
        if (fit.kind !== 'rate') {
            rows += _row('Permeability k', _isNum(res.k) ? _sig(res.k, 3) + _pm(ci, 'k', res.k >= 10 ? 1 : 2) : '—', 'md');
            rows += _row('Permeability-thickness kh', _sig(res.kh, 4), 'md·ft');
            rows += _row('Skin S', _isNum(res.S) ? res.S.toFixed(2) + _pm(ci, 'S', 2) : '—');
            rows += _row('Wellbore storage C', _sig(res.C, 3), 'bbl/psi');
            rows += _row('Pressure drop due to skin ΔpS', _sig(res.dpS, 3), 'psi');
            rows += _row('Flow efficiency FE', _sig(res.FE, 3));
        }
        if (fit.stale) rows += _row('Note', 'The fit was made on different data or a different model — re-run it.');
        var params = fit.params || {};
        var paramRows = '';
        var paramKeys = [];
        for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k) && k.indexOf('__') !== 0) paramKeys.push(k);
        if (paramKeys.length) {
            paramRows = '<h3 class="qr-h3">Model Parameters</h3>' +
                '<table class="qr-table"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>';
            for (var pi = 0; pi < paramKeys.length; pi++) {
                var pk = paramKeys[pi];
                var pv = params[pk];
                paramRows += '<tr><td>' + _esc(pk) + '</td><td>' +
                             (_isNum(pv) ? _fmt(pv, 4) : _esc(Array.isArray(pv) ? '(' + pv.length + ' items)' : pv)) + '</td></tr>';
            }
            paramRows += '</tbody></table>';
        }
        var narrative = (ps.interp && ps.interp.narrative) || '';
        var interp = narrative ? ('<p class="qr-rationale">' + _esc(narrative) + '</p>') : '';
        return _section('PRiSM Well Test Analysis',
            '<table class="qr-kv">' + rows + '</table>' + paramRows + interp);
    }

    // ───────────────────────────────────────────────────────────────
    // CSS (print-friendly)
    // ───────────────────────────────────────────────────────────────
    function _styles() {
        return [
            '@page { size: A4 portrait; margin: 14mm 12mm; }',
            'body.qr-print { background:#fff;color:#000;font-family:Segoe UI,Calibri,Arial,sans-serif;' +
                'font-size:11pt;line-height:1.4;margin:0;padding:0; }',
            '.qr-page { max-width:190mm;margin:0 auto;padding:8mm 6mm; }',
            '.qr-controls { display:flex;gap:8px;justify-content:flex-end;padding:8px 12px;' +
                'background:#f3f4f6;border-bottom:1px solid #d0d7de; }',
            '.qr-controls button { padding:6px 14px;background:#1f6feb;color:#fff;border:0;' +
                'border-radius:4px;cursor:pointer;font-size:12px;font-weight:600 }',
            '.qr-controls button.secondary { background:#fff;color:#1f6feb;border:1px solid #1f6feb }',
            '@media print { .qr-controls { display:none !important } }',
            'header.qr-header { display:flex;align-items:center;gap:16px;padding-bottom:10px;' +
                'border-bottom:3px solid #1f6feb;margin-bottom:10px }',
            '.qr-logo { font-size:28pt;font-weight:800;letter-spacing:-1px;color:#1f6feb }',
            '.qr-titleblock h1 { font-size:18pt;margin:0;color:#1f3a5f;font-weight:700 }',
            '.qr-subtitle { font-size:10pt;color:#6e7681;margin-top:2px }',
            '.qr-meta { width:100%;border-collapse:collapse;margin-bottom:12px;font-size:10pt }',
            '.qr-meta th { background:#f3f4f6;color:#1f3a5f;font-weight:600;text-align:left;' +
                'padding:4px 8px;border:1px solid #d0d7de;width:15% }',
            '.qr-meta td { padding:4px 8px;border:1px solid #d0d7de;width:35% }',
            '.qr-section { page-break-inside:avoid;margin-bottom:14px;padding-bottom:6px;' +
                'border-bottom:1px dotted #d0d7de }',
            '.qr-section:last-child { border-bottom:0 }',
            '.qr-section-title { font-size:13pt;color:#1f3a5f;margin:0 0 6px 0;font-weight:700;' +
                'border-bottom:1px solid #1f6feb;padding-bottom:2px }',
            '.qr-h3 { font-size:11pt;margin:8px 0 4px;color:#1f3a5f;font-weight:600 }',
            '.qr-status { margin:4px 0 8px 0;font-size:11pt;font-weight:600 }',
            '.qr-rationale { margin:6px 0 0;font-size:10pt;color:#444;font-style:italic;' +
                'background:#f9fafb;padding:6px 10px;border-left:3px solid #1f6feb }',
            '.qr-kv { width:100%;border-collapse:collapse;font-size:10pt;margin-bottom:6px }',
            '.qr-kv th { background:#f8f9fb;color:#222;font-weight:600;text-align:left;' +
                'padding:3px 8px;width:38%;border:1px solid #e5e7eb }',
            '.qr-kv td { padding:3px 8px;border:1px solid #e5e7eb }',
            '.qr-units { color:#6e7681;font-size:9pt }',
            '.qr-table { width:100%;border-collapse:collapse;font-size:9pt;margin:4px 0 8px }',
            '.qr-table th { background:#1f3a5f;color:#fff;font-weight:600;text-align:left;' +
                'padding:4px 8px;border:1px solid #1f3a5f }',
            '.qr-table td { padding:3px 8px;border:1px solid #e5e7eb }',
            '.qr-table tr:nth-child(even) td { background:#fafbfc }',
            '.qr-placeholder { padding:8px 12px;background:#f9fafb;color:#6e7681;border:1px dashed #d0d7de;' +
                'border-radius:4px;font-style:italic;font-size:10pt;margin-bottom:10px }',
            '.qr-footer { font-size:8pt;color:#6e7681;text-align:center;margin-top:14px;' +
                'border-top:1px solid #e5e7eb;padding-top:6px }'
        ].join('\n');
    }

    // ───────────────────────────────────────────────────────────────
    // Assemble the full HTML doc
    // ───────────────────────────────────────────────────────────────
    function _renderSection(key) {
        switch (key) {
            case 'header':     return _renderHeader();
            case 'wts':        return _renderWTSSummary();
            case 'esdhi':      return _renderESDHi();
            case 'esdlo':      return _renderESDLo();
            case 'hydrate':    return _renderHydrate();
            case 'liquidline': return _renderLiquidLine();
            case 'pipelife':   return _renderPipeLife();
            case 'prism':      return _renderPRiSM();
            default:           return '';
        }
    }

    function _buildHTML(opts) {
        opts = opts || {};
        var keys = opts.modules ? opts.modules.slice() : getModules();
        var sections = [];
        // Always emit header first if it's in the catalog (even if not selected)
        var hasHeader = false;
        for (var i = 0; i < keys.length; i++) if (keys[i] === 'header') hasHeader = true;
        if (!hasHeader) sections.push(_renderSection('header'));
        for (var j = 0; j < keys.length; j++) sections.push(_renderSection(keys[j]));
        var generated = new Date().toISOString();
        var version = (G.WTS_VERSION || G.PRiSM_VERSION || '1.0');
        var footer = '<div class="qr-footer">Generated by H2Oil Well Testing Suite v' +
                     _esc(version) + ' · ' + _esc(generated) + '</div>';
        return '<!DOCTYPE html>' +
               '<html lang="en"><head><meta charset="utf-8">' +
               '<title>H2Oil Well Testing — Quick Report</title>' +
               '<style>' + _styles() + '</style>' +
               '</head><body class="qr-print">' +
               '<div class="qr-controls">' +
               '<button class="secondary" onclick="window.close()">Close</button>' +
               '<button onclick="window.print()">Print / Save PDF</button>' +
               '</div>' +
               '<div class="qr-page">' + sections.join('') + footer + '</div>' +
               '</body></html>';
    }

    // ───────────────────────────────────────────────────────────────
    // preview(opts) → returns HTML string (without auto-print)
    // ───────────────────────────────────────────────────────────────
    function preview(opts) {
        try { return _buildHTML(opts); }
        catch (e) { _err('preview failed', e); return '<!-- preview error: ' + _esc(e.message) + ' -->'; }
    }

    // ───────────────────────────────────────────────────────────────
    // generate(opts) → opens a new window with the report and triggers print
    // ───────────────────────────────────────────────────────────────
    function generate(opts) {
        // The host's job report covers every calculator the user has run
        // (captured automatically), with the shared report styling, the
        // Client & Well Info cover and the iOS PDF path. The legacy
        // per-module summary below remains as a fallback.
        if (typeof G.WTS_exportJobReport === 'function') {
            try { G.WTS_exportJobReport(opts); return { opened: true, delegated: true }; }
            catch (e) { _warn('job report failed — falling back to legacy quick report', e); }
        }
        var html = _buildHTML(opts);
        if (!_hasWin || typeof G.open !== 'function') {
            return { html: html, opened: false };
        }
        var w = null;
        try { w = G.open('', 'WTS_quickReport', 'width=820,height=1080'); }
        catch (e) { w = null; }
        if (!w) {
            _warn('Quick Report popup blocked — returning HTML for caller');
            return { html: html, opened: false };
        }
        try {
            w.document.open();
            w.document.write(html);
            w.document.close();
            // Trigger print after a tick so the document is parsed
            try {
                w.setTimeout(function () {
                    try { w.focus(); w.print(); } catch (e) {}
                }, 250);
            } catch (e) {}
        } catch (e) {
            _err('Quick Report write failed', e);
        }
        return { html: html, opened: true, win: w };
    }

    // ───────────────────────────────────────────────────────────────
    // Mount the "Quick Report" button
    // ───────────────────────────────────────────────────────────────
    function renderQuickReportButton(container) {
        if (!_hasDoc || !container || !('innerHTML' in container)) return;
        var existing = (container.querySelector)
            ? container.querySelector('[data-wts-qr-btn="1"]') : null;
        if (existing) return;
        var btn = document.createElement('button');
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-wts-qr-btn', '1');
        btn.className = 'btn btn-primary';
        btn.style.cssText =
            'padding:6px 14px;background:#1f6feb;border:1px solid #1f6feb;border-radius:4px;' +
            'color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:Segoe UI,sans-serif';
        btn.innerHTML = 'Quick Report';
        btn.title = 'Generate a single-PDF aggregated summary of every calculator that has been run.';
        btn.addEventListener('click', function () {
            try { generate(); }
            catch (e) { _err('Quick Report button click failed', e); }
        });
        try { container.appendChild(btn); } catch (e) {}
    }

    // ───────────────────────────────────────────────────────────────
    // Publish public API
    // ───────────────────────────────────────────────────────────────
    G.WTS_quickReport = {
        generate:           generate,
        preview:            preview,
        setModules:         setModules,
        getModules:         getModules,
        availableModules:   availableModules
    };
    G.WTS_renderQuickReportButton = renderQuickReportButton;

    // ── Auto-mount into the page-header host (#wts_quick_report_host) ──
    (function _autoMountQuickReport() {
        if (!_hasDoc) return;
        function mount() {
            try {
                var host = G.document.getElementById('wts_quick_report_host');
                if (host && !host.getAttribute('data-mounted')) {
                    renderQuickReportButton(host);
                    host.setAttribute('data-mounted', '1');
                }
            } catch (e) { /* non-fatal */ }
        }
        if (G.document.readyState === 'loading' && G.document.addEventListener) {
            G.document.addEventListener('DOMContentLoaded', mount);
        } else {
            (G.setTimeout || setTimeout)(mount, 0);
        }
    })();

    // === SELF-TEST ===
    (function () {
        try {
            var checks = [];

            checks.push({ n: 'public API present',
                          ok: typeof G.WTS_quickReport === 'object' &&
                              typeof G.WTS_quickReport.generate === 'function' &&
                              typeof G.WTS_quickReport.preview === 'function' &&
                              typeof G.WTS_quickReport.setModules === 'function' });

            // Seed minimal state to exercise every section
            G.WTS_state = G.WTS_state || {};
            G.WTS_state.clientInfo = { clientName: 'Acme Energy', wellName: 'X-1', fieldName: 'North Sea Block X' };
            G.WTS_state.flow = { wellheadPressure: 4500, wellheadTemp: 180, gasRate: 25,
                                 oilRate: 2500, waterRate: 200, chokeBean: 32, separatorPressure: 350 };
            G.WTS_state.nodes = [
                { label: 'Wellhead', pressure: 4500, temperature: 180, velocity: 25 },
                { label: 'Choke US', pressure: 4400, temperature: 175, velocity: 28 },
                { label: 'Separator', pressure: 350, temperature: 110, velocity: 35 }
            ];
            G.WTS_state.esdHiPilot = {
                pass: true, marginSeconds: 8.4, hiPilotSetting_psig: 4500,
                rdSetting_psig: 5000, mawp_psig: 4500, timeToReachRV_s: 13.4,
                esdResponseTime_s: 5, gasReleasedToAtmosphere_scf: 1250,
                rationale: 'Hi-pilot fires well before RV reached.'
            };
            G.WTS_state.esdLoPilot = {
                reachable: true, psl_target_psig: 350, operating_psig: 500,
                drawdown_psi: 150, detectionTime_s: 12,
                recommendation: 'PSL at 350 psig is achievable; line break detection ~12 s.'
            };
            G.WTS_state.hydrate = {
                inhibitor: 'MeOH',
                nodes: [
                    { label: 'WH', temp_F: 180, p_psig: 4500, thyd_F: 78, subcool_F: 102, risk: 'green', meoh_ccmin: 0 },
                    { label: 'Choke', temp_F: 90, p_psig: 4400, thyd_F: 78, subcool_F: 12, risk: 'green', meoh_ccmin: 0 },
                    { label: 'Heater out', temp_F: 50, p_psig: 350, thyd_F: 62, subcool_F: -12, risk: 'red', meoh_ccmin: 14.5 }
                ]
            };
            G.WTS_state.liquidline = {
                protected: true, ro_recommended_64ths: 12, ro_selected_64ths: 14,
                velocity_ftps: 42, lcv_in: 2, blowby_margin: 1.3,
                note: 'RO 14/64" provides 1.3× margin over blowby velocity threshold.'
            };
            G.WTS_state.pipelife = {
                overall_min_life_days: 320, sand_rate_lbMMscf: 50, c_constant: 300,
                limiting_segment: { label: 'SSV→Choke', erosion_rate_mils_yr: 145,
                                    time_to_failure_at_current_days: 870, max_allowable_pressure_psig: 6500 },
                segments: [
                    { label: 'SSV→Choke', erosion_rate_mils_yr: 145, remaining_service_life_days: 320,
                      time_to_failure_at_current_days: 870, max_allowable_pressure_psig: 6500 },
                    { label: 'Choke→Heater', erosion_rate_mils_yr: 12, remaining_service_life_days: 9800,
                      time_to_failure_at_current_days: 14200, max_allowable_pressure_psig: 4200 }
                ]
            };
            // PRiSM fixture in the real lastFit schema (C4): dimensionless
            // registry params + field-unit phys, lower-case stats keys.
            var keepPRiSM = { st: G.PRiSM_state, ds: G.PRiSM_dataset, pvt: G.PRiSM_pvt };
            G.PRiSM_state = { model: 'homogeneous', params: { Cd: 80, S: 2.5 } };
            G.PRiSM_state.lastFit = {
                modelKey: 'homogeneous', kind: 'pressure', source: 'regression',
                r2: 0.99999, rmse: 0.31, aic: -120.4, iterations: 7, converged: true,
                params: { Cd: 80, S: 2.5 }, ci95: { k: [44.8, 45.2], S: [2.47, 2.53] },
                phys: { k: 45.0, kh: 1575, C: 8.48e-4, Cd: 80, S: 2.5, pi: 4200 }
            };
            G.PRiSM_state.interp = { narrative: 'Radial flow with mild damage; flow efficiency about 76 %.' };
            G.PRiSM_dataset = { t: [1, 120], p: [3340.9, 3089.8], q: [850, 850] };
            G.PRiSM_pvt = { fluidType: 'oil', q: 850, Bo: 1.25, mu_o: 1.1, h: 35, rw: 0.354, p_res: 4200,
                            provenance: { p_res: 'sample' } };

            // availableModules now should have everything
            var avail = G.WTS_quickReport.availableModules();
            checks.push({ n: 'availableModules detects state',
                          ok: avail.indexOf('esdhi') !== -1 &&
                              avail.indexOf('hydrate') !== -1 &&
                              avail.indexOf('pipelife') !== -1 &&
                              avail.indexOf('prism') !== -1 });

            // preview returns a complete document with sections
            var html = G.WTS_quickReport.preview();
            checks.push({ n: 'preview() returns HTML doctype',
                          ok: typeof html === 'string' && html.indexOf('<!DOCTYPE html>') === 0 });
            checks.push({ n: 'preview includes Quick Report title',
                          ok: html.indexOf('Quick Report') !== -1 });
            checks.push({ n: 'preview includes WTS section',
                          ok: html.indexOf('WTS Flow Profile Summary') !== -1 });
            checks.push({ n: 'preview includes ESD Hi-Pilot',
                          ok: html.indexOf('ESD Hi-Pilot Analysis') !== -1 });
            checks.push({ n: 'preview includes Hydrate Management',
                          ok: html.indexOf('Hydrate Management') !== -1 });
            checks.push({ n: 'preview includes Pipe Service Life',
                          ok: html.indexOf('Pipe Service Life') !== -1 });
            checks.push({ n: 'preview includes PRiSM section',
                          ok: html.indexOf('PRiSM Well Test Analysis') !== -1 });
            checks.push({ n: 'PRiSM section shows model key, RMSE and AIC',
                          ok: html.indexOf('homogeneous') !== -1 && html.indexOf('0.310') !== -1 && html.indexOf('-120.4') !== -1 });
            checks.push({ n: 'PRiSM section shows k, S, ΔpS and FE',
                          ok: html.indexOf('45.0 ± 0.2') !== -1 && html.indexOf('2.50 ± 0.03') !== -1 &&
                              html.indexOf('>262 ') !== -1 && html.indexOf('0.764') !== -1 });
            var st0 = G.PRiSM_state, lf0 = st0.lastFit;
            st0.lastFit = null;
            checks.push({ n: 'PRiSM counts as run when a model and data exist (no fit)',
                          ok: G.WTS_quickReport.availableModules().indexOf('prism') !== -1 });
            st0.lastFit = { model: 'homogeneous', R2: 0.9, RMSE: 1.5, AIC: 12 };
            var legacyHtml = G.WTS_quickReport.preview();
            checks.push({ n: 'legacy key case (R2 / RMSE / AIC) accepted',
                          ok: legacyHtml.indexOf('0.90000') !== -1 && legacyHtml.indexOf('1.50') !== -1 });
            st0.lastFit = lf0;
            checks.push({ n: 'preview includes client name',
                          ok: html.indexOf('Acme Energy') !== -1 });
            checks.push({ n: 'preview includes print CSS',
                          ok: html.indexOf('@page') !== -1 });

            // setModules narrows the output
            G.WTS_quickReport.setModules(['esdhi']);
            var narrow = G.WTS_quickReport.preview();
            checks.push({ n: 'setModules narrows scope',
                          ok: narrow.indexOf('ESD Hi-Pilot') !== -1 &&
                              narrow.indexOf('Hydrate Management') === -1 });
            G.WTS_quickReport.setModules(null);  // restore

            // Module without state → placeholder
            G.WTS_state.esdLoPilot = null;
            var withPlaceholder = G.WTS_quickReport.preview();
            checks.push({ n: 'missing module shows placeholder',
                          ok: withPlaceholder.indexOf('not run yet') !== -1 });

            // generate returns HTML even when window.open isn't available
            // (smoke-test sandbox lacks window.open)
            var didThrow = false;
            var res = null;
            try { res = G.WTS_quickReport.generate(); } catch (e) { didThrow = true; }
            checks.push({ n: 'generate() does not throw under stub', ok: !didThrow });
            checks.push({ n: 'generate() returns HTML',
                          ok: !!(res && typeof res.html === 'string' && res.html.length > 100) });

            // renderQuickReportButton handles null container
            var btnErr = false;
            try { G.WTS_renderQuickReportButton(null); } catch (e) { btnErr = true; }
            checks.push({ n: 'renderQuickReportButton handles null', ok: !btnErr });

            // getModules returns array
            var mods = G.WTS_quickReport.getModules();
            checks.push({ n: 'getModules returns array',
                          ok: Array.isArray(mods) && mods.length > 0 });

            G.PRiSM_state = keepPRiSM.st; G.PRiSM_dataset = keepPRiSM.ds; G.PRiSM_pvt = keepPRiSM.pvt;
            G.WTS_quickReport_selfTestResults = { checks: checks };

            var fails = checks.filter(function (c) { return !c.ok; });
            if (fails.length) _err('Quick Report self-test FAILED:', fails);
            else _log('✓ Quick Report self-test passed (' + checks.length + ' checks).');
        } catch (e) {
            _err('Quick Report self-test threw:', e && e.message ? e.message : e);
        }
    })();

})();
