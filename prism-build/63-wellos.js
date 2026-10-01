// =============================================================================
// 63-wellos.js — Mini WellOS (route `wellos`, its own sidebar group "Mini WellOS")
// -----------------------------------------------------------------------------
// SCADA-style live view of a surface well-test spread: KPI tiles, 3D process
// view (the Round-7 WTS_3d handle driven by this page's own data feed), 2D P&ID
// (host wtsDrawDiag) + levels / valves panel, live variable chips with quality,
// trends with time windows, ISA-18.2 alarm list with acknowledge, events, CSV
// logging, "Send to PRiSM" of a pressure trend, historian hook.
//
// Data source toggle:
//   Form data   — a private WTS_sim instance fed with the Well Test Simulator
//                 form flow (WTS_state.flow) or the sample flow.
//   Modbus data — the tags linked to app variables on the Modbus page (shared
//                 WTS_modbus station), with per-tag quality (good / stale / bad),
//                 per-device comms status and last update. The 3D / 2D views are
//                 animated from a frozen base snapshot with the live values applied
//                 (WTS_modbus.applyVarsToState), so unmapped values never move.
//
// Read-only use of Round-7 public APIs: WTS_sim.create, WTS_3d.mount / isSupported,
// WTS_live.liveNodes / liveSegs / fmtU / fmtParts / unitsConv, window.wtsDrawDiag.
// Timers: one requestAnimationFrame loop while the page is open and visible, plus
// the station's poll timers in Modbus mode — all stopped when the page closes.
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
var M = G.WTS_modbus;
if (!M || !M.VARS) return;

var OWNER = 'wellos', UI_KEY = 'wts_wellos_ui';
var WINDOWS = [[300, '5 min'], [1800, '30 min'], [7200, '2 h'], [43200, '12 h']];
var PRESSURE_KEYS = ['bhp', 'whp', 'sep_p', 'choke_dn_p', 'surge_p', 'flare_p'];
var KPI_KEYS = ['whp', 'bhp', 'sep_p', 'gas_rate', 'oil_rate', 'water_rate', 'gor', 'wcut', 'flare_rate'];
var ctl = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function nowMs() { try { if (G.performance && typeof G.performance.now === 'function') return G.performance.now(); } catch (e) {} return Date.now(); }
function pad(x) { return x < 10 ? '0' + x : '' + x; }
function hms(t) { if (!t) return '—'; var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function readUi() {
    var u = { source: 'form', view: '3d', win: 1800, trend: ['whp', 'sep_p', 'gas_rate', 'oil_rate'], speed: 1, prism: 'whp' };
    try { var o = JSON.parse((G.localStorage && G.localStorage.getItem(UI_KEY)) || 'null');
        if (o && typeof o === 'object') {
            if (o.source === 'form' || o.source === 'modbus') u.source = o.source;
            if (o.view === '3d' || o.view === '2d') u.view = o.view;
            if (WINDOWS.some(function (w) { return w[0] === +o.win; })) u.win = +o.win;
            if (Array.isArray(o.trend)) u.trend = o.trend.filter(function (k) { return M.VAR_BY_KEY[k] && M.VAR_BY_KEY[k].kind !== 'bool'; }).slice(0, 6);
            if ([1, 10, 60].indexOf(+o.speed) >= 0) u.speed = +o.speed;
            if (PRESSURE_KEYS.indexOf(o.prism) >= 0) u.prism = o.prism;
        } } catch (e) {}
    return u;
}
function writeUi(u) { try { if (G.localStorage) G.localStorage.setItem(UI_KEY, JSON.stringify(u)); } catch (e) {} }

// ─── display formatting (field units in, WTS_units display out) ─────────────
// pump_running = LCV-201 transfer valve (legacy key); p201_running = the gauge tank pump P-201
var BOOL_TXT = { esd_open: ['OPEN', 'CLOSED'], esd_tripped: ['TRIPPED', 'NORMAL'], pump_running: ['OPEN', 'SHUT'], heater_bypass: ['OPEN', 'SHUT'], p201_running: ['RUNNING', 'STOPPED'] };
function unitLabel(V) {
    if (!V) return '';
    if (V.key === 'oil_rate') return 'STB/d';
    if (V.cat === 'liquidRate') return 'BPD';
    return V.unit || '';
}
function dpFor(x) { var a = Math.abs(x); return a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 1 : 2; }
function fmtNumber(x, dp) { if (!isNum(x)) return '—'; var s = x.toFixed(dp == null ? dpFor(x) : dp); return Math.abs(x) >= 10000 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s; }
function disp(v, V) {
    if (!V) return { v: isNum(v) ? fmtNumber(v) : '—', u: '' };
    if (V.kind === 'bool') { var t = BOOL_TXT[V.key] || ['OPEN', 'SHUT']; return { v: v == null ? '—' : (v ? t[0] : t[1]), u: '' }; }
    var U = G.WTS_units, cat = V.cat;
    if (isNum(v) && U && typeof U.getSystem === 'function' && U.getSystem() === 'metric' && U.CATEGORIES && U.CATEGORIES[cat] && typeof U.format === 'function') {
        try { var f = U.format(v, cat); if (f && isNum(+f.value)) return { v: fmtNumber(+f.value), u: f.label }; } catch (e) {}
    }
    return { v: isNum(v) ? fmtNumber(v) : '—', u: unitLabel(V) };
}
var DERIVED = {
    gor: { key: 'gor', label: 'GOR', unit: 'scf/STB', cat: 'gor', calc: function (x) { return isNum(x.gas_rate) && isNum(x.oil_rate) && x.oil_rate > 0.5 ? x.gas_rate * 1e6 / x.oil_rate : null; } },
    wcut: { key: 'wcut', label: 'Water cut', unit: '%', calc: function (x) { return isNum(x.water_rate) && isNum(x.oil_rate) && x.water_rate + x.oil_rate > 0 ? 100 * x.water_rate / (x.water_rate + x.oil_rate) : null; } }
};

// derived values (GOR, water cut): GOR scf/STB → sm³/sm³ in Metric (WTS_units 'gor'); water cut stays %
function dispDerived(v, D) {
    if (!isNum(v)) return { v: '—', u: D.unit };
    var U = G.WTS_units;
    if (D.cat && U && typeof U.getSystem === 'function' && U.getSystem() === 'metric' && typeof U.format === 'function') {
        try { var f = U.format(v, D.cat); if (f && isNum(+f.value)) return { v: fmtNumber(+f.value, Math.abs(+f.value) >= 100 ? 0 : 1), u: f.label }; } catch (e) {}
    }
    return { v: fmtNumber(v, D.key === 'gor' ? 0 : 1), u: D.unit };
}
function injectCss() {
    if (typeof document === 'undefined' || byId('wts-wellos-css')) return;
    var s = document.createElement('style');
    s.id = 'wts-wellos-css';
    s.textContent = [
        '.wos{--wos-panel:#0b111a;--wos-line:#1d2a3a}',
        '.wos-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--wos-panel);border:1px solid var(--wos-line);border-radius:8px;padding:8px 10px;margin-bottom:12px}',
        '.wos-brand{font-weight:800;letter-spacing:1.5px;color:var(--accent);font-size:13px;margin-right:6px}',
        '.wos-clock{font-family:"Courier New",monospace;font-size:12px;color:var(--text2);margin-right:auto}',
        '.wos-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}',
        '.wos-seg button{background:var(--bg1);color:var(--text2);border:0;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer}',
        '.wos-seg button.on{background:var(--accent);color:#fff}',
        '.wos-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:12px;border:1px solid var(--border);font-size:11px;font-weight:600;background:var(--bg1);color:var(--text2);cursor:default}',
        '.wos-pill.alarm{border-color:var(--red);color:var(--red);cursor:pointer}.wos-pill.warn{border-color:var(--orange,#d29922);color:var(--orange,#d29922);cursor:pointer}',
        '.wos-dot{width:8px;height:8px;border-radius:50%;background:var(--text3);display:inline-block}',
        '.wos-dot.online,.wos-dot.good{background:var(--green)}.wos-dot.error,.wos-dot.bad{background:var(--red)}.wos-dot.connecting,.wos-dot.paused,.wos-dot.stale{background:var(--orange,#d29922)}',
        '.wos-btn{padding:5px 10px;font-size:11px}',
        '.wos-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:12px}',
        '.wos .kpi{background:var(--wos-panel);border:1px solid var(--wos-line);border-radius:8px;padding:8px 10px;border-left:3px solid var(--green)}',
        '.wos .kpi.q-stale{border-left-color:var(--orange,#d29922)}.wos .kpi.q-bad{border-left-color:var(--red)}.wos .kpi.q-unmapped{border-left-color:var(--text3);opacity:.7}',
        '.wos .kpi-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3)}',
        '.wos .kpi-v{font-family:"Courier New",monospace;font-size:20px;font-weight:700;color:var(--text)}.wos .kpi-u{font-size:11px;color:var(--text2);margin-left:1px}',
        '.wos-grid{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(260px,1fr);gap:12px}',
        '@media (max-width:1100px){.wos-grid{grid-template-columns:1fr}}',
        '.wos-stage{position:relative;background:var(--wos-panel);border:1px solid var(--wos-line);border-radius:8px;overflow:hidden}',
        '.wos-3d{width:100%;height:420px;position:relative}',
        '@media (max-width:700px){.wos-3d{height:300px}}',
        '.wos-stage canvas.wos-cv{width:100%;display:block}',
        '.wos-note{position:absolute;left:10px;top:8px;font-size:11px;color:var(--text2);background:rgba(11,17,26,.8);padding:3px 8px;border-radius:6px;z-index:2}',
        '.wos-src{position:absolute;right:10px;top:8px;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;z-index:2;background:rgba(11,17,26,.85)}',
        '.wos-chips{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px}',
        '.wos-chip{background:var(--wos-panel);border:1px solid var(--wos-line);border-left:3px solid var(--green);border-radius:6px;padding:5px 8px;font-size:11px;min-width:0}',
        '.wos-chip.q-stale{border-left-color:var(--orange,#d29922)}.wos-chip.q-bad{border-left-color:var(--red)}.wos-chip.q-unmapped{border-left-color:var(--text3);opacity:.6}',
        '.wos-chip .l{color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wos-chip .v{font-family:"Courier New",monospace;font-size:14px;font-weight:700;color:var(--text)}',
        '.wos-chip .s{color:var(--text3);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.wos-grp{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text3);margin:10px 0 4px}',
        '.wos-alarms{max-height:300px;overflow:auto}',
        '.wos-al{display:grid;grid-template-columns:auto 1fr auto;gap:6px;align-items:center;padding:5px 6px;border-bottom:1px solid var(--border);font-size:12px}',
        '.wos-al .sev{font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:var(--bg1)}',
        '.wos-al.alarm .sev{color:#fff;background:var(--red)}.wos-al.warn .sev{color:#111;background:var(--orange,#d29922)}.wos-al.info .sev{color:var(--text2)}',
        '.wos-al.UNACK.active{animation:wosblink 1s steps(2,start) infinite}',
        '@keyframes wosblink{to{background:rgba(248,81,73,.12)}}',
        '@media (prefers-reduced-motion:reduce){.wos-al.UNACK.active{animation:none;background:rgba(248,81,73,.12)}}',
        '.wos-ev{font-size:11px;color:var(--text2);font-family:"Courier New",monospace;max-height:180px;overflow:auto;white-space:pre-wrap}',
        '.wos-tsel{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.wos-tsel label{font-size:11px;display:inline-flex;gap:4px;align-items:center;background:var(--bg1);border:1px solid var(--border);border-radius:12px;padding:2px 8px}',
        '.wos-banner{background:rgba(88,166,255,.06);border:1px solid rgba(88,166,255,.2);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--blue);margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
        '.wos-msg{font-size:12px;margin-top:8px}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
}

// ─── markup ─────────────────────────────────────────────────────────────────
function pageHtml(u) {
    var trendSel = M.VARS.filter(function (V) { return V.kind !== 'bool'; }).map(function (V) {
        return '<label><input type="checkbox" data-trend="' + V.key + '"' + (u.trend.indexOf(V.key) >= 0 ? ' checked' : '') + '>' + esc(V.label.replace(/ \(.*\)$/, '')) + '</label>';
    }).join('');
    return '<div id="wos_root" class="wos" data-no-persist>' +
        '<div class="wos-head" id="wos_head"></div>' +
        '<div id="wos_banner"></div>' +
        '<div class="wos-kpis" id="wos_kpis"></div>' +
        '<div class="wos-grid"><div>' +
        '<div class="wos-stage" id="wos_stage"><div class="wos-note" id="wos_note"></div><div class="wos-src" id="wos_srcflag"></div>' +
        '<div class="wos-3d" id="wos_3d"></div>' +
        '<canvas id="wts_cv" class="wos-cv" width="1200" height="340" hidden></canvas></div>' +
        '<div class="wos-stage" style="margin-top:8px"><canvas id="wos_lv" class="wos-cv" width="1200" height="230"></canvas></div>' +
        '<div class="card" style="margin-top:12px"><div class="card-title">Trends</div>' +
        '<div class="mb-bar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">' + WINDOWS.map(function (w) { return '<button class="btn btn-secondary wos-btn' + (u.win === w[0] ? ' wos-on' : '') + '" data-act="win" data-win="' + w[0] + '"' + (u.win === w[0] ? ' style="border-color:var(--accent);color:var(--accent)"' : '') + '>' + w[1] + '</button>'; }).join('') + '</div>' +
        '<div class="wos-tsel">' + trendSel + '</div>' +
        '<div class="chart-wrap"><canvas id="wos_trend" width="1100" height="300"></canvas></div></div>' +
        '</div><div>' +
        '<div class="card" id="wos_alcard"><div class="card-title">Alarms <span id="wos_alcount" style="float:right;font-weight:600"></span></div>' +
        '<div class="btn-row" style="margin-top:0;margin-bottom:8px"><button class="btn btn-secondary wos-btn" data-act="ackall">Acknowledge all</button></div>' +
        '<div class="wos-alarms" id="wos_alarms"></div><div class="wos-grp">Events</div><div class="wos-ev" id="wos_events"></div></div>' +
        '<div class="card"><div class="card-title">CSV logging</div><div id="wos_log"></div></div>' +
        '<div class="card"><div class="card-title">Send to PRiSM</div><div class="fg"><div class="fg-item"><label>Pressure gauge</label><select data-role="prism-var">' +
        PRESSURE_KEYS.map(function (k) { return '<option value="' + k + '"' + (u.prism === k ? ' selected' : '') + '>' + esc(M.VAR_BY_KEY[k].label) + '</option>'; }).join('') + '</select></div></div>' +
        '<div class="btn-row"><button class="btn btn-primary wos-btn" data-act="prism">Send trend window to PRiSM</button></div><div class="wos-msg" id="wos_prism_msg"></div></div>' +
        '<div class="card" id="wos_hist"><div class="card-title">Historian</div><div id="wos_hist_body"></div></div>' +
        '</div></div>' +
        '<div class="card" style="margin-top:12px"><div class="card-title">Live variables</div><div id="wos_chips"></div></div>' +
        '<div style="font-size:12px;color:var(--text2);margin-top:8px"><div><b>Notes</b> Form data runs the Well Test Simulator model from the simulator page inputs (or the sample well). Modbus data shows the tags linked on the Modbus page, converted to field units; quality: good = fresh, stale = no update for 3 poll intervals, bad = comms error / exception / unit mismatch, — = not linked. In Modbus mode the 3D and 2D views keep the last form snapshot for anything not linked. GOR = gas rate ÷ oil rate; water cut = water ÷ (water + oil) rate, both from the rates shown. Representative equipment; not a safety system.</div></div>' +
        '</div>';
}

// ─── controller ─────────────────────────────────────────────────────────────
function createController(root) {
    var u = readUi(), C = { root: root }, disposed = false;
    var model = M.makeFormModel({ seed: 5 }), formHist = {}, formAlarms = M.createAlarmManager(), formPrev = {};
    var station = null, boundStation = null, modbusState = null, baseSnap = null;
    var h3 = null, h3tok = 0, h3failed = false, raf = 0, last = 0, tUi = 0, tSlow = 0, tSample = 0, dirty = true;
    var logger = { on: false, rows: [], cols: null, max: 200000 }, alSig = '', evSig = '';
    M.VARS.forEach(function (V) { formHist[V.key] = M.makeHistory(); });
    function q(sel) { return root.querySelector(sel); }

    // ── data access ──
    function current() {
        var vals = {}, qual = {}, src = {}, ts = {};
        if (u.source === 'form') {
            var fv = model.values();
            M.VARS.forEach(function (V) {
                var x = fv[V.key];
                vals[V.key] = x; qual[V.key] = x == null ? 'unmapped' : 'good'; src[V.key] = x == null ? 'not in the form model' : 'form';
            });
        } else {
            var s = station;
            M.VARS.forEach(function (V) {
                var x = s ? s.getVar(V.key) : null;
                if (!x) { vals[V.key] = null; qual[V.key] = 'unmapped'; src[V.key] = 'not linked'; return; }
                qual[V.key] = x.q === 'init' ? 'stale' : x.q;
                vals[V.key] = x.q === 'bad' || x.q === 'init' ? null : x.value;
                src[V.key] = x.tag + (x.err ? ' — ' + x.err : '') + (x.q === 'init' ? ' — waiting' : '');
                ts[V.key] = x.ts;
            });
        }
        Object.keys(DERIVED).forEach(function (k) {
            var D = DERIVED[k]; vals[k] = D.calc(vals);
            var qa = qual.gas_rate, qb = qual.oil_rate, qc = qual.water_rate, deps = k === 'gor' ? [qa, qb] : [qc, qb];
            qual[k] = deps.indexOf('unmapped') >= 0 ? 'unmapped' : deps.indexOf('bad') >= 0 ? 'bad' : deps.indexOf('stale') >= 0 ? 'stale' : 'good';
            if (vals[k] == null && qual[k] === 'good') qual[k] = 'unmapped';
            src[k] = 'calculated';
        });
        return { vals: vals, q: qual, src: src, ts: ts };
    }
    C.current = current;
    function displayState() {
        if (u.source === 'form') return model.state();
        return modbusState || baseSnap || model.state();
    }
    C.displayState = displayState;
    function bindStation() {
        var s = u.source === 'modbus' ? M.station() : null;
        if (s === boundStation) return;
        if (boundStation) { boundStation.off('poll', onPoll); boundStation.off('status', onStatus); }
        boundStation = s; station = s;
        if (s) { s.on('poll', onPoll); s.on('status', onStatus); }
    }
    function onPoll(ev) {
        if (disposed) return;
        var lv = station ? station.linkedValues() : {};
        modbusState = M.applyVarsToState(baseSnap || model.state(), lv);
        if (logger.on) logRow();
        dirty = true;
    }
    function onStatus() { dirty = true; }
    function setSource(src) {
        if (src === u.source && (src === 'form' || station)) return;
        u.source = src; writeUi(u);
        if (src === 'modbus') {
            baseSnap = JSON.parse(JSON.stringify(model.state() || {}));
            modbusState = null;
            M.acquire(OWNER); bindStation();
        } else {
            if (boundStation) { boundStation.off('poll', onPoll); boundStation.off('status', onStatus); }
            boundStation = null; station = null; modbusState = null;
            M.release(OWNER);
        }
        if (logger.on) { logger.on = false; logger.note = 'Logging stopped — data source changed.'; }
        alSig = ''; evSig = ''; dirty = true;
        renderHead(); renderBanner(); renderLog(); updateUi(true);
        G.WTS_state = G.WTS_state || {}; G.WTS_state.wellos = { source: u.source };
        try { document.dispatchEvent(new CustomEvent('wts:wellos-source', { detail: { source: u.source } })); } catch (e) {}
    }
    C.setSource = setSource;
    function alarmsMgr() { return u.source === 'modbus' ? (station ? station.alarms : null) : formAlarms; }
    C.alarms = alarmsMgr;

    // ── form mode sampling (1 Hz): history, sim alarms → ISA-18.2 list, historian ──
    var SIM_LVL = { trip: 'ALARM', alarm: 'ALARM', warn: 'WARN', hyd: 'WARN', info: 'INFO' };
    function formSample(t) {
        var fv = model.values(), st = model.state();
        M.VARS.forEach(function (V) { if (fv[V.key] != null) formHist[V.key].push(t, fv[V.key]); });
        var seen = {};
        ((st && st.alarms) || []).forEach(function (a) {
            if (!a || !a.id) return; seen[a.id] = 1;
            formAlarms.update('sim:' + a.id, SIM_LVL[a.sev] || 'WARN', { t: t, tag: a.tag || a.id, device: 'form', value: a.value, limit: a.limit, msg: a.msg || '' });
        });
        Object.keys(formPrev).forEach(function (id) { if (!seen[id]) formAlarms.update('sim:' + id, null, { t: t }); });
        formPrev = seen;
        var batch = [];
        // tag = the variable key (kept for historian continuity); desc = what it is (e.g. pump_running = LCV-201 open)
        M.VARS.forEach(function (V) { var x = fv[V.key]; if (x == null) return; batch.push({ tag: V.key, device: 'form', t: t, v: x, q: 'good', raw: null, unit: unitLabel(V), desc: V.label + ' — Mini WellOS form data' }); });
        M.publishSamples(batch);
        if (logger.on) logRow();
    }
    C.formSample = formSample;

    // ── header / banner ──
    function renderHead() {
        var h = q('#wos_head'); if (!h) return;
        var cfg = M.getConfig(), hasHist = !!(typeof document !== 'undefined' && document.querySelector('.nav-btn[data-p="historian"]'));
        h.innerHTML = '<span class="wos-brand">MINI WELLOS</span><span class="wos-clock" id="wos_clock">' + hms(Date.now()) + '</span>' +
            '<span class="wos-seg" role="group" aria-label="Data source"><button data-act="src" data-src="form" class="' + (u.source === 'form' ? 'on' : '') + '">Form data</button><button data-act="src" data-src="modbus" class="' + (u.source === 'modbus' ? 'on' : '') + '">Modbus data</button></span>' +
            '<span id="wos_comms"></span>' +
            (u.source === 'modbus' ? '<button class="btn btn-secondary wos-btn" data-act="pause">' + (cfg.paused ? '▶ Resume polling' : '❚❚ Pause polling') + '</button>' : '<span class="wos-seg"><button data-act="speed" data-speed="1" class="' + (u.speed === 1 ? 'on' : '') + '">1×</button><button data-act="speed" data-speed="10" class="' + (u.speed === 10 ? 'on' : '') + '">10×</button><button data-act="speed" data-speed="60" class="' + (u.speed === 60 ? 'on' : '') + '">60×</button></span>') +
            '<span id="wos_alpill"></span>' +
            '<span class="wos-seg"><button data-act="view" data-view="3d" class="' + (u.view === '3d' ? 'on' : '') + '">3D</button><button data-act="view" data-view="2d" class="' + (u.view === '2d' ? 'on' : '') + '">2D</button></span>' +
            '<button class="btn btn-secondary wos-btn" data-act="goto" data-p="modbus">Modbus config</button>' +
            (hasHist ? '<button class="btn btn-secondary wos-btn" data-act="goto" data-p="historian">Historian</button>' : '');
    }
    function renderBanner() {
        var b = q('#wos_banner'); if (!b) return;
        var cfg = M.getConfig();
        if (u.source === 'modbus' && !cfg.tags.some(function (t) { return !!t.link; })) {
            b.innerHTML = '<div class="wos-banner">No Modbus tags are linked to app variables yet. <button class="btn btn-primary wos-btn" data-act="demo">Use the Modbus simulator demo</button><button class="btn btn-secondary wos-btn" data-act="goto" data-p="modbus">Open Modbus config</button></div>';
        } else b.innerHTML = '';
    }
    function renderComms() {
        var c = q('#wos_comms'); if (!c) return;
        if (u.source !== 'modbus') { c.innerHTML = '<span class="wos-pill"><span class="wos-dot good"></span>Form data · simulator model</span>'; return; }
        var devs = station ? station.devices() : [], cfg = M.getConfig();
        c.innerHTML = (devs.length ? devs.map(function (d) {
            return '<span class="wos-pill" title="' + esc(d.lastErr || '') + '"><span class="wos-dot ' + esc(d.status) + '"></span>' + esc(d.name) + ' · ' + esc(d.status) + ' · ' + (d.lastOk ? 'last ' + hms(d.lastOk) : 'no data') + '</span> ';
        }).join('') : '<span class="wos-pill"><span class="wos-dot"></span>No Modbus devices</span>') + (cfg.paused ? '<span class="wos-pill"><span class="wos-dot paused"></span>Polling paused</span>' : '');
    }

    // ── KPIs / chips ──
    function renderKpis(cur) {
        var k = q('#wos_kpis'); if (!k) return;
        k.innerHTML = KPI_KEYS.map(function (key) {
            var V = M.VAR_BY_KEY[key], D = DERIVED[key], d = D ? dispDerived(cur.vals[key], D) : disp(cur.vals[key], V);
            var lbl = D ? D.label : V.label.replace(/ \(.*\)$/, '');
            // a real space between value and unit (the text reads "10,012 scf/STB", not "10,012scf/STB")
            return '<div class="kpi q-' + esc(cur.q[key]) + '" title="' + esc(cur.src[key] || '') + '"><div class="kpi-l">' + esc(lbl) + '</div><div class="kpi-v">' + esc(d.v) + (d.u ? ' <span class="kpi-u">' + esc(d.u) + '</span>' : '') + '</div></div>';
        }).join('');
    }
    function renderChips(cur) {
        var c = q('#wos_chips'); if (!c) return;
        var grp = null, html = '';
        M.VARS.forEach(function (V) {
            if (V.group !== grp) { if (grp) html += '</div>'; grp = V.group; html += '<div class="wos-grp">' + esc(grp) + '</div><div class="wos-chips">'; }
            var d = disp(cur.vals[V.key], V), age = cur.ts[V.key] ? Math.max(0, Math.round((Date.now() - cur.ts[V.key]) / 1000)) + ' s ago' : '';
            html += '<div class="wos-chip q-' + esc(cur.q[V.key]) + '" data-var="' + V.key + '"><div class="l" title="' + esc(V.label) + '">' + esc(V.label) + '</div><div class="v">' + esc(d.v) + ' <span class="kpi-u">' + esc(d.u) + '</span></div>' +
                '<div class="s">' + esc(cur.q[V.key] === 'unmapped' ? (u.source === 'form' ? 'not in the form model' : 'not linked') : (cur.src[V.key] || '') + (age ? ' · ' + age : '') + (cur.q[V.key] !== 'good' ? ' · ' + cur.q[V.key] : '')) + '</div></div>';
        });
        c.innerHTML = html + (grp ? '</div>' : '');
    }
    function renderAlarms(force) {
        var A = alarmsMgr(), list = A ? A.list() : [], cnt = A ? A.counts() : { unack: 0, active: 0, total: 0 };
        var sig = list.map(function (a) { return a.id + a.state + a.level + a.active; }).join('|');
        var pill = q('#wos_alpill');
        if (pill) pill.innerHTML = cnt.total ? '<span class="wos-pill ' + (list.some(function (a) { return a.sev === 'alarm' && a.active; }) ? 'alarm' : 'warn') + '" data-act="toalarms">⚠ ' + cnt.active + ' active · ' + cnt.unack + ' unack</span>' : '<span class="wos-pill"><span class="wos-dot good"></span>No alarms</span>';
        var n = q('#wos_alcount'); if (n) n.textContent = cnt.active + ' active / ' + cnt.unack + ' unack';
        if (sig !== alSig || force) {
            alSig = sig;
            var el = q('#wos_alarms');
            if (el) el.innerHTML = list.length ? list.map(function (a) {
                return '<div class="wos-al ' + esc(a.sev) + ' ' + esc(a.state) + (a.active ? ' active' : '') + '"><span class="sev">' + esc(a.level) + '</span><span><b>' + esc(a.tag) + '</b> ' + esc(a.msg || '') + '<br><span style="color:var(--text3);font-size:10px">' + esc(a.state === 'RTN' ? 'returned to normal (unacknowledged)' : a.state === 'ACK' ? 'acknowledged' : 'UNACKNOWLEDGED') + ' · since ' + hms(a.tOn) + '</span></span>' +
                    (a.state !== 'ACK' ? '<button class="btn btn-secondary wos-btn" data-act="ack" data-id="' + esc(a.id) + '">Ack</button>' : '<span></span>') + '</div>';
            }).join('') : '<div style="font-size:12px;color:var(--text3);padding:6px">No active or unacknowledged alarms.</div>';
        }
        var ev = A ? A.events() : [], es = ev.length + ':' + (ev.length ? ev[ev.length - 1].t : 0);
        if (es !== evSig || force) {
            evSig = es;
            var e = q('#wos_events');
            if (e) e.textContent = ev.slice(-60).reverse().map(function (x) { return hms(x.t) + '  ' + x.msg; }).join('\n') || 'No events yet.';
        }
    }
    function renderLog() {
        var l = q('#wos_log'); if (!l) return;
        l.innerHTML = '<div class="btn-row" style="margin-top:0;flex-wrap:wrap">' + (logger.on ? '<button class="btn btn-secondary wos-btn" data-act="logstop">■ Stop logging</button>' : '<button class="btn btn-primary wos-btn" data-act="logstart">● Start logging</button>') +
            '<button class="btn btn-secondary wos-btn" data-act="logcsv"' + (logger.rows.length ? '' : ' disabled') + '>Download CSV</button><button class="btn btn-secondary wos-btn" data-act="logclear">Clear</button></div>' +
            '<div class="wos-msg" style="color:var(--text2)">' + (logger.on ? '● Logging ' + (u.source === 'modbus' ? 'every poll' : 'every second') + ' — ' : '') + logger.rows.length + ' row(s) recorded' + (logger.note ? ' · ' + esc(logger.note) : '') + '</div>';
    }
    function renderHist() {
        var b = q('#wos_hist_body'); if (!b) return;
        var has = typeof document !== 'undefined' && document.querySelector('.nav-btn[data-p="historian"]');
        b.innerHTML = has ? '<div style="font-size:12px;color:var(--text2)">Every polled tag (and the form values in Form data mode) is recorded by the historian.</div><div class="btn-row"><button class="btn btn-secondary wos-btn" data-act="goto" data-p="historian">Open Historian</button></div>' :
            '<div style="font-size:12px;color:var(--text2)" data-historian-placeholder="1">Historian — long-term storage with trend and table views of every logged tag will appear here. Samples are already published on each poll (<code>WTS_historian.record()</code> and the <code>wts:modbus-samples</code> event); per-tag logging, log deadband and minimum interval are set on the Modbus page.</div>';
    }

    // ── logging ──
    function logCols() {
        if (u.source === 'modbus' && station) {
            var cfg = station.config();
            return cfg.tags.map(function (t) { return { id: t.id, name: t.name, unit: t.unit }; });
        }
        return M.VARS.map(function (V) { return { id: V.key, name: V.key, unit: unitLabel(V) }; });
    }
    function logRow() {
        if (!logger.cols) logger.cols = logCols();
        var t = Date.now(), row = [t];
        if (u.source === 'modbus' && station) {
            var v = station.values();
            logger.cols.forEach(function (c) { var r = v[c.id]; row.push(r && r.q !== 'bad' && r.q !== 'init' && isNum(r.value) ? r.value : null, r ? r.q : 'n/a'); });
        } else {
            var fv = model.values();
            logger.cols.forEach(function (c) { var x = fv[c.id]; row.push(isNum(x) ? x : null, x == null ? 'n/a' : 'good'); });
        }
        logger.rows.push(row);
        if (logger.rows.length >= logger.max) { logger.on = false; logger.note = 'Stopped at ' + logger.max + ' rows'; renderLog(); }
    }
    function csvText() {
        var cols = logger.cols || [];
        var head = ['timestamp_utc', 'epoch_ms'];
        cols.forEach(function (c) { head.push(c.name + (c.unit ? ' [' + c.unit + ']' : ''), c.name + ' quality'); });
        var cell = function (v) { var s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        return [head.map(cell).join(',')].concat(logger.rows.map(function (r) {
            return [new Date(r[0]).toISOString(), r[0]].concat(r.slice(1).map(function (x) { return typeof x === 'number' ? +x.toPrecision(10) : x; })).map(cell).join(',');
        })).join('\r\n') + '\r\n';
    }
    C.csvText = csvText; C.logger = logger;

    // ── trends ──
    function series(key, t0) {
        var V = M.VAR_BY_KEY[key];
        if (u.source === 'form') return formHist[key] ? formHist[key].range(t0) : { t: [], v: [] };
        var x = station && station.getVar(key);
        if (!x || !x.tagId) return { t: [], v: [] };
        var h = station.history(x.tagId, t0), tg = station.tag(x.tagId);
        if (V && V.kind !== 'bool' && tg) h = { t: h.t, v: h.v.map(function (y) { return M.toCanonical(y, tg.unit, V.cat); }) };
        return h;
    }
    C.series = series;
    var TCOL = ['#58a6ff', '#f0883e', '#3fb950', '#d2a8ff', '#e3b341', '#ff7b72'];
    function drawTrends() {
        var cv = q('#wos_trend'); if (!cv || !cv.getContext) return;
        var ctx = cv.getContext('2d'); if (!ctx) return;
        var W = cv.width, H = cv.height, keys = u.trend.slice(0, 6), t1 = Date.now(), t0 = t1 - u.win * 1000;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0b111a'; ctx.fillRect(0, 0, W, H);
        if (!keys.length) { ctx.fillStyle = '#8b949e'; ctx.font = '13px sans-serif'; ctx.fillText('Tick variables above to trend them.', 20, 30); return; }
        var n = keys.length, lane = (H - 24) / n, L = 150, R = W - 10;
        keys.forEach(function (k, i) {
            var V = M.VAR_BY_KEY[k], s = series(k, t0), y0 = 4 + i * lane, h = lane - 8, col = TCOL[i % TCOL.length];
            var lo = Infinity, hi = -Infinity;
            s.v.forEach(function (v) { if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } });
            ctx.strokeStyle = '#1d2a3a'; ctx.lineWidth = 1; ctx.strokeRect(L, y0, R - L, h);
            ctx.fillStyle = col; ctx.font = 'bold 11px sans-serif'; ctx.fillText(V.label.replace(/ \(.*\)$/, '').slice(0, 24), 6, y0 + 13);
            var last = s.v.length ? s.v[s.v.length - 1] : null, dl = disp(last, V);
            ctx.fillStyle = '#e6edf3'; ctx.font = '12px "Courier New",monospace'; ctx.fillText(dl.v + ' ' + dl.u, 6, y0 + 29);
            if (!isFinite(lo)) { ctx.fillStyle = '#6e7681'; ctx.font = '11px sans-serif'; ctx.fillText('no data in window', L + 8, y0 + h / 2 + 4); return; }
            if (hi - lo < 1e-9) { hi += 0.5 * Math.max(1e-3, Math.abs(hi) * 0.01); lo -= 0.5 * Math.max(1e-3, Math.abs(lo) * 0.01); }
            var pd = (hi - lo) * 0.08; lo -= pd; hi += pd;
            ctx.fillStyle = '#6e7681'; ctx.font = '10px sans-serif';
            ctx.fillText(disp(hi, V).v, 6, y0 + 44); ctx.fillText(disp(lo, V).v, 6, y0 + h - 2);
            ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
            var started = false;
            for (var j = 0; j < s.t.length; j++) {
                var v = s.v[j]; if (!isNum(v)) { started = false; continue; }
                var x = L + (s.t[j] - t0) / (t1 - t0) * (R - L), y = y0 + h - (v - lo) / (hi - lo) * h;
                if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
        });
        ctx.fillStyle = '#6e7681'; ctx.font = '10px sans-serif';
        ctx.fillText(hms(t0), L, H - 6); var e = hms(t1); ctx.fillText(e, R - 50, H - 6);
        ctx.fillText(WINDOWS.filter(function (w) { return w[0] === u.win; })[0][1] + ' window', (L + R) / 2 - 30, H - 6);
    }

    // ── 2D: host P&ID (wtsDrawDiag on #wts_cv) + levels / valves panel ──
    function draw2d(st) {
        var Lv = G.WTS_live, cv = q('#wts_cv');
        if (cv && u.view === '2d' && Lv && typeof Lv.liveNodes === 'function' && typeof Lv.liveSegs === 'function' && typeof G.wtsDrawDiag === 'function' && st) {
            try { G.wtsDrawDiag(Lv.liveNodes(st), Lv.liveSegs(st)); } catch (e) {}
        }
    }
    function drawLevels(cur) {
        var cv = q('#wos_lv'); if (!cv || !cv.getContext) return;
        var ctx = cv.getContext('2d'); if (!ctx) return;
        var W = cv.width, H = cv.height, v = cur.vals, Q = cur.q;
        ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#0b111a'; ctx.fillRect(0, 0, W, H);
        function tank(x, w, title, total, water, qk, valveKey, valveLbl) {
            var y = 36, h = H - 92;
            ctx.strokeStyle = Q[qk] === 'bad' ? '#f85149' : Q[qk] === 'stale' ? '#d29922' : '#3a4a5e'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
            if (isNum(total)) { var ht = Math.max(0, Math.min(1.05, total / 100)) * h; ctx.fillStyle = '#c98a2b'; ctx.fillRect(x + 2, y + h - ht, w - 4, ht); }
            if (isNum(water)) { var hw = Math.max(0, Math.min(1, water / 100)) * h; ctx.fillStyle = '#1f7fe0'; ctx.fillRect(x + 2, y + h - hw, w - 4, hw); }
            ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(title, x, y - 20);
            ctx.font = '12px "Courier New",monospace'; ctx.fillText(isNum(total) ? total.toFixed(1) + ' %' : (Q[qk] === 'unmapped' ? 'not linked' : '—'), x, y - 6);
            if (valveKey) valve(x + w / 2, y + h + 22, v[valveKey], Q[valveKey], valveLbl);
        }
        function valve(cx, cy, open, qq, lbl) {
            var col = open == null ? '#6e7681' : open ? '#3fb950' : '#f85149';
            ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(cx - 12, cy - 8); ctx.lineTo(cx + 12, cy + 8); ctx.lineTo(cx + 12, cy - 8); ctx.lineTo(cx - 12, cy + 8); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#c9d1d9'; ctx.font = '10px sans-serif'; ctx.fillText(lbl + ' ' + (open == null ? '—' : open ? 'OPEN' : 'SHUT') + (qq === 'stale' ? ' (stale)' : qq === 'bad' ? ' (bad)' : ''), cx - 34, cy + 22);
        }
        // separator: inlet-compartment liquid + interface, oil bucket
        tank(40, 150, 'V-101 Separator', v.sep_liq_lvl, v.sep_int_lvl, 'sep_liq_lvl', 'esd_open', 'SDV-101');
        tank(210, 60, 'Oil bucket', v.sep_oil_lvl, null, 'sep_oil_lvl', null);
        tank(330, 90, 'T-201A Surge', v.surge_lvl_a, null, 'surge_lvl_a', 'xv201a', 'XV-201A');
        tank(440, 90, 'T-201B Surge', v.surge_lvl_b, null, 'surge_lvl_b', 'xv201b', 'XV-201B');
        tank(700, 90, 'T-301A Gauge', v.gauge_lvl_a, null, 'gauge_lvl_a', 'xv301a', 'XV-301A');
        tank(810, 90, 'T-301B Gauge', v.gauge_lvl_b, null, 'gauge_lvl_b', 'xv301b', 'XV-301B');
        // surge → gauge transfer: LCV-201, driven by the surge tank pressure (no pump; the pump_running variable is
        // the transfer state, snapshot surge.pump.on). P-201 sits downstream of the gauge tank.
        var pr = v.pump_running, px = 610, py = 120, pc = pr == null ? '#6e7681' : pr ? '#3fb950' : '#8b949e';
        ctx.fillStyle = pc; ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px - 18, py - 12); ctx.lineTo(px, py); ctx.lineTo(px - 18, py + 12); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px + 18, py - 12); ctx.lineTo(px, py); ctx.lineTo(px + 18, py + 12); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 20); ctx.stroke(); ctx.beginPath(); ctx.arc(px, py - 24, 7, Math.PI, 0); ctx.closePath(); ctx.stroke();
        ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('LCV-201', px - 24, py + 30);
        ctx.font = '10px sans-serif'; ctx.fillText(pr == null ? '—' : pr ? 'OPEN' : 'SHUT', px - 12, py + 44);
        // P-201 gauge tank pump (T-301 → export / burner): circle + discharge triangle, green when running
        var gr = v.p201_running, gx = 945, gy = 110, gc = gr == null ? '#6e7681' : gr ? '#3fb950' : '#8b949e';
        ctx.fillStyle = gc; ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(gx, gy, 11, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(gx - 5, gy - 6); ctx.lineTo(gx + 7, gy); ctx.lineTo(gx - 5, gy + 6); ctx.closePath(); ctx.fillStyle = '#0b111a'; ctx.fill();
        ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('P-201', gx - 16, gy + 26);
        ctx.font = '10px sans-serif'; ctx.fillText(gr == null ? (Q.p201_running === 'unmapped' ? 'not linked' : '—') : gr ? 'RUNNING' : 'STOPPED', gx - 20, gy + 38);
        // status column
        var sx = 1000, lines = [
            ['ESD', v.esd_tripped ? 'TRIPPED' : v.esd_tripped === 0 ? 'NORMAL' : '—', v.esd_tripped ? '#f85149' : '#3fb950'],
            ['WHP', disp(v.whp, M.VAR_BY_KEY.whp).v + ' ' + disp(v.whp, M.VAR_BY_KEY.whp).u, '#e6edf3'],
            ['Sep P', disp(v.sep_p, M.VAR_BY_KEY.sep_p).v + ' ' + disp(v.sep_p, M.VAR_BY_KEY.sep_p).u, '#e6edf3'],
            ['Surge P', disp(v.surge_p, M.VAR_BY_KEY.surge_p).v + ' ' + disp(v.surge_p, M.VAR_BY_KEY.surge_p).u, '#e6edf3'],
            ['LCV-102', disp(v.lcv_oil, M.VAR_BY_KEY.lcv_oil).v + ' %', '#e6edf3'],
            ['LCV-101', disp(v.lcv_water, M.VAR_BY_KEY.lcv_water).v + ' %', '#e6edf3'],
            ['Source', u.source === 'form' ? 'Form data' : 'Modbus data', u.source === 'form' ? '#58a6ff' : '#f0883e']];
        lines.forEach(function (l, i) { ctx.fillStyle = '#8b949e'; ctx.font = '11px sans-serif'; ctx.fillText(l[0], sx, 40 + i * 24); ctx.fillStyle = l[2]; ctx.font = 'bold 12px "Courier New",monospace'; ctx.fillText(l[1], sx + 70, 40 + i * 24); });
        if (v.esd_tripped) { ctx.fillStyle = 'rgba(248,81,73,.9)'; ctx.fillRect(0, H - 22, W, 22); ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('ESD TRIPPED — SDV-101 closed', 12, H - 7); }
    }

    // ── 3D ──
    function show3dNote(t) { var n = q('#wos_note'); if (n) { n.textContent = t || ''; n.style.display = t ? '' : 'none'; } }
    function applyView() {
        var d3 = q('#wos_3d'), cv = q('#wts_cv'), want3d = u.view === '3d' && !h3failed;
        if (d3) d3.style.display = want3d ? '' : 'none';
        if (cv) cv.hidden = want3d;
        if (want3d) mount3d(); else { if (h3) { try { h3.setPaused(true); } catch (e) {} } }
        if (u.view === '3d' && h3failed) show3dNote('3D view unavailable on this device — showing the 2D schematic');
        else if (!want3d) show3dNote('');
        if (h3 && want3d) { try { h3.setPaused(false); } catch (e) {} }
    }
    function mount3d() {
        if (h3 || h3tok || h3failed) return;
        var W = G.WTS_3d, el = q('#wos_3d');
        var ok = false; try { ok = !!(W && typeof W.mount === 'function' && W.isSupported()); } catch (e) { ok = false; }
        if (!ok || !el) { h3failed = true; applyView(); return; }
        var tok = ++h3tok, L = G.WTS_live || {};
        show3dNote('Loading 3D view…');
        var o = { quality: 'auto', labels: 'all', overlay: 'phase', orbit: false, intro: false,
            onError: function (err, fatal) { if (fatal && !disposed) { try { if (h3) h3.dispose(); } catch (e) {} h3 = null; h3failed = true; applyView(); } } };
        if (typeof L.fmtU === 'function') o.fmt = L.fmtU;
        if (typeof L.fmtParts === 'function') o.fmtParts = L.fmtParts;
        if (typeof L.unitsConv === 'function') o.units = { system: (G.WTS_units && G.WTS_units.getSystem && G.WTS_units.getSystem()) || 'imperial', conv: L.unitsConv };
        var p; try { p = W.mount(el, o); } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(function (h) {
            if (disposed || tok !== h3tok) { try { h.dispose(); } catch (e) {} return; }
            h3 = h; h3tok = 0; show3dNote('');
            try { h3.setPaused(u.view !== '3d'); } catch (e) {}
        }, function () { if (disposed || tok !== h3tok) return; h3tok = 0; h3failed = true; applyView(); });
    }

    // ── loop ──
    function updateUi(force) {
        var cur = current();
        renderKpis(cur); renderChips(cur); renderComms(); renderAlarms(force);
        drawLevels(cur);
        var ck = q('#wos_clock'); if (ck) ck.textContent = hms(Date.now());
        var sf = q('#wos_srcflag'); if (sf) { sf.textContent = u.source === 'form' ? 'FORM DATA' : 'MODBUS DATA'; sf.style.color = u.source === 'form' ? 'var(--blue)' : 'var(--accent)'; }
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.wellos = { source: u.source, values: cur.vals, quality: cur.q, ts: Date.now() };
        return cur;
    }
    C.updateUi = updateUi;
    function frame(ts) {
        raf = 0;
        if (disposed) return;
        if (!root.isConnected) { C.dispose(); return; }
        if (typeof document !== 'undefined' && document.hidden) return;       // resumes on visibilitychange
        raf = reqFrame(frame);
        if (!isNum(ts)) ts = nowMs();
        var dt = last ? Math.min((ts - last) / 1000, 0.25) : 0; if (dt < 0) dt = 0;
        last = ts;
        bindStation();
        if (u.source === 'form') { model.step(dt * u.speed); dirty = true; }
        var st = displayState();
        if (h3 && u.view === '3d') { try { h3.frame(st, dt); } catch (e) {} }
        var wall = Date.now();
        if (u.source === 'form' && wall - tSample >= 1000) { tSample = wall; formSample(wall); }
        if (ts - tUi >= 250 && dirty) { tUi = ts; dirty = u.source === 'form'; updateUi(false); if (u.view === '2d' || h3failed) draw2d(st); }
        if (ts - tSlow >= 1000) { tSlow = ts; drawTrends(); if (logger.on) renderLog(); }
    }
    function reqFrame(fn) { return typeof G.requestAnimationFrame === 'function' ? G.requestAnimationFrame(fn) : G.setTimeout(function () { fn(nowMs()); }, 50); }
    function cancelFrame() { if (!raf) return; if (typeof G.cancelAnimationFrame === 'function') G.cancelAnimationFrame(raf); else G.clearTimeout(raf); raf = 0; }
    function start() { if (!raf && !disposed) { last = 0; raf = reqFrame(frame); } }
    C.start = start; C.frame = frame;

    // ── actions ──
    function gotoPage(p) { var b = typeof document !== 'undefined' && document.querySelector('.nav-btn[data-p="' + p + '"]'); if (b) b.click(); }
    function sendToPrism() {
        var key = (q('[data-role="prism-var"]') || {}).value || u.prism, V = M.VAR_BY_KEY[key], msgEl = q('#wos_prism_msg');
        u.prism = key; writeUi(u);
        var t1 = Date.now(), s = series(key, t1 - u.win * 1000), t = [], p = [];
        for (var i = 0; i < s.t.length; i++) if (isNum(s.v[i])) { t.push(s.t[i]); p.push(s.v[i]); }
        function say(h, bad) { if (msgEl) msgEl.innerHTML = '<span style="color:var(--' + (bad ? 'red' : 'green') + ')">' + h + '</span>'; }
        if (t.length < 3) { say('✗ Need at least 3 samples of ' + esc(V.label) + ' in the trend window (have ' + t.length + ').', true); return null; }
        if (typeof G.PRiSM_commitDataset !== 'function') { say('✗ PRiSM is not available.', true); return null; }
        var tag = u.source === 'modbus' && station && station.getVar(key) ? station.getVar(key).tag : 'form';
        var name = 'Mini WellOS ' + V.label.replace(/ \(.*\)$/, '') + ' — ' + (u.source === 'modbus' ? 'Modbus tag ' + tag : 'form data') + ' ' + new Date(t[0]).toISOString().slice(0, 16).replace('T', ' ');
        var ds = { t: t.map(function (x) { return (x - t[0]) / 3.6e6; }), p: p.slice(), q: null, timeUnit: 'h', name: name, source: 'modbus',
            meta: { variable: key, tag: tag, unit: 'psig', startUtc: new Date(t[0]).toISOString(), from: 'Mini WellOS' } };
        var res = G.PRiSM_commitDataset(ds, { source: 'modbus', name: name });
        try { if (G.PRiSM_gaugeData && typeof G.PRiSM_gaugeData.add === 'function') Promise.resolve(G.PRiSM_gaugeData.add({ name: name, units: 'psig', source: 'Mini WellOS' }, ds.t, ds.p, null)).catch(function () {}); } catch (e) {}
        if (!res) { say('✗ PRiSM rejected the dataset.', true); return null; }
        say('✓ Sent ' + t.length + ' points (' + ((t[t.length - 1] - t[0]) / 3.6e6).toFixed(3) + ' h, gauge pressure psig) to PRiSM as "' + esc(name) + '". <button class="btn btn-secondary wos-btn" data-act="goto" data-p="prism">Open PRiSM</button>');
        return ds;
    }
    C.sendToPrism = sendToPrism;
    function onClick(ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!b || !root.contains(b)) return;
        var act = b.getAttribute('data-act');
        switch (act) {
            case 'src': setSource(b.getAttribute('data-src')); break;
            case 'view': u.view = b.getAttribute('data-view') === '2d' ? '2d' : '3d'; writeUi(u); renderHead(); applyView(); dirty = true; updateUi(); draw2d(displayState()); break;
            case 'speed': u.speed = +b.getAttribute('data-speed') || 1; writeUi(u); renderHead(); break;
            case 'pause': M.setPaused(!M.getConfig().paused); renderHead(); renderComms(); break;
            case 'goto': gotoPage(b.getAttribute('data-p')); break;
            case 'demo': {
                // the banner shows when no tag is linked, but devices / tags may exist: never replace them silently
                var cur0 = M.getConfig();
                if ((cur0.devices.length || cur0.tags.length) && typeof G.confirm === 'function' &&
                    !G.confirm('Replace the current Modbus configuration (' + cur0.devices.length + ' device(s), ' + cur0.tags.length + ' tag(s)) with the simulator demo?')) break;
                M.saveConfig(M.demoConfig()); if (!M.station()) M.acquire(OWNER); bindStation(); renderBanner(); renderHead(); break;
            }
            case 'ack': { var A = alarmsMgr(); if (A) A.ack(b.getAttribute('data-id')); renderAlarms(true); break; }
            case 'ackall': { var A2 = alarmsMgr(); if (A2) A2.ackAll(); renderAlarms(true); break; }
            case 'toalarms': { var c = q('#wos_alcard'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
            case 'win': u.win = +b.getAttribute('data-win') || 1800; writeUi(u); root.querySelectorAll('[data-act="win"]').forEach(function (x) { var on = +x.getAttribute('data-win') === u.win; x.style.borderColor = on ? 'var(--accent)' : ''; x.style.color = on ? 'var(--accent)' : ''; }); drawTrends(); break;
            case 'logstart': logger.on = true; logger.cols = logCols(); logger.rows = []; logger.note = ''; logRow(); renderLog(); break;
            case 'logstop': logger.on = false; renderLog(); break;
            case 'logclear': {
                var had = logger.rows.length;
                logger.rows = []; logger.note = had ? 'Cleared ' + had + ' row(s).' : 'Log already empty — nothing to clear.';
                if (!logger.on) logger.cols = null; renderLog(); break;
            }
            case 'logcsv': if (!logger.rows.length) { logger.note = 'No rows logged yet — start logging first.'; renderLog(); break; }
                if (M.download) M.download('wellos-log-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv', csvText(), 'text/csv'); break;
            case 'prism': sendToPrism(); break;
        }
    }
    function onChange(ev) {
        var el = ev.target; if (!el || !el.getAttribute) return;
        var k = el.getAttribute('data-trend');
        if (k) {
            var i = u.trend.indexOf(k);
            if (el.checked && i < 0) { if (u.trend.length >= 6) { el.checked = false; return; } u.trend.push(k); }
            if (!el.checked && i >= 0) u.trend.splice(i, 1);
            writeUi(u); drawTrends();
        }
    }
    function onPage(e) { if (!root.isConnected || (e && e.detail && e.detail.page && e.detail.page !== 'wellos')) C.dispose(); }
    function onVis() { if (typeof document !== 'undefined' && !document.hidden) start(); }
    function onUnits() { if (h3) { try { h3.refreshUnits(); } catch (e) {} } dirty = true; updateUi(true); drawTrends(); }
    function onCfg() { if (!disposed) { bindStation(); renderBanner(); renderHead(); dirty = true; } }
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    document.addEventListener('h2oil:pagechange', onPage);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('wts:unit-system-changed', onUnits);
    document.addEventListener('wts:modbus-config-changed', onCfg);
    C.dispose = function () {
        if (disposed) return; disposed = true;
        cancelFrame();
        root.removeEventListener('click', onClick); root.removeEventListener('change', onChange);
        document.removeEventListener('h2oil:pagechange', onPage);
        document.removeEventListener('visibilitychange', onVis);
        document.removeEventListener('wts:unit-system-changed', onUnits);
        document.removeEventListener('wts:modbus-config-changed', onCfg);
        if (boundStation) { boundStation.off('poll', onPoll); boundStation.off('status', onStatus); }
        boundStation = null; station = null;
        M.release(OWNER);
        h3tok++;
        if (h3) { try { h3.dispose(); } catch (e) {} h3 = null; }
        try { model.dispose(); } catch (e) {}
        if (ctl === C) ctl = null;
    };
    C.ui = function () { return u; };
    C.isRunning = function () { return !!raf; };
    C.handle3d = function () { return h3; };

    // init
    renderHead(); renderBanner(); renderLog(); renderHist();
    if (u.source === 'modbus') { u.source = 'form'; setSource('modbus'); }
    applyView();
    updateUi(true); draw2d(displayState()); drawTrends();
    formSample(Date.now()); tSample = Date.now();
    start();
    return C;
}

function render(body) {
    injectCss();
    if (ctl) ctl.dispose();
    if (M.syncStation) M.syncStation();
    body.innerHTML = pageHtml(readUi());
    ctl = createController(byId('wos_root'));
    if (typeof G.calcWellOS === 'function') G.calcWellOS();
}
// calc<X> naming convention (units wrapper): refresh the view on demand.
G.calcWellOS = function () { if (ctl) { ctl.updateUi(true); return true; } return false; };
M.wellos = { controller: function () { return ctl; }, DERIVED: DERIVED, disp: disp, dispDerived: dispDerived, UI_KEY: UI_KEY };

G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.wellos = {
    key: 'wellos', title: 'Mini WellOS', navTitle: 'Mini WellOS',
    sub: 'Live SCADA view of the well-test spread — form data or live Modbus tags',
    group: 'Mini WellOS', icon: '&#9673;', badge: 'Live Data', bc: 'dc-b-blue',
    desc: 'P&ID, 3D view, trends, alarms and logging driven by the simulator model or live Modbus data.',
    render: render
};
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var ok = !!(G.WTS_calcRegistry && G.WTS_calcRegistry.wellos && G.WTS_modbus && G.WTS_modbus.wellos);
    if (typeof console !== 'undefined') console[ok ? 'log' : 'warn']('[63-wellos] self-test ' + (ok ? 'passed' : 'FAILED'));
})();
