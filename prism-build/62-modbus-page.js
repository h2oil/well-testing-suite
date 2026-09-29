// =============================================================================
// 62-modbus-page.js — "Modbus" configuration page (route `modbus`, group "Live Data")
// -----------------------------------------------------------------------------
// Devices (transport, address, unit id, poll rate, timeout, retries, byte/word order),
// tags (register table, address with a 0/1-based toggle, data type, word order,
// scaling, units, alarm limits, deadband, link to a well-test variable, historian
// logging), "Test read" per tag, live monitor, global pause, JSON / CSV import and
// export, write protection ("Enable writes" + confirmation), the built-in virtual
// slave (WTS_sim / waveform / manual) and connection guides (WebSocket bridge,
// Web Serial RTU, iOS native TCP).
//
// The page state lives in localStorage 'wts_modbus_config' (WTS_modbus.saveConfig);
// the root carries data-no-persist so the host page autosave leaves it alone.
// Registers itself in window.WTS_calcRegistry (host plug-in registry).
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
var M = G.WTS_modbus;
if (!M || !M.getConfig) return;

var OWNER = 'modbus-page';
var ctl = null;           // active page controller

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(label) + '</option>'; }
function fmtTime(t) { if (!t) return '—'; var d = new Date(t), p = function (x) { return x < 10 ? '0' + x : '' + x; }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function fmtVal(v) { return M.fmtNum ? M.fmtNum(v) : String(v); }

var lastUrl = null;
function download(name, text, type) {
    try {
        var blob = new Blob([text], { type: type || 'text/plain' });
        var a = document.createElement('a');
        if (lastUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) { try { URL.revokeObjectURL(lastUrl); } catch (e) {} }
        a.href = lastUrl = URL.createObjectURL(blob); a.download = name;
        (document.body || document.documentElement).appendChild(a); a.click();
        if (a.parentNode) a.parentNode.removeChild(a);
        return true;
    } catch (e) { console.warn('[modbus] download failed', e); return false; }
}
M.download = download;

function injectCss() {
    if (typeof document === 'undefined' || byId('wts-modbus-css')) return;
    var s = document.createElement('style');
    s.id = 'wts-modbus-css';
    s.textContent = [
        '.mb-scroll{overflow-x:auto;max-width:100%}',
        '.mb-table{min-width:900px}',
        '.mb-table td{padding:5px 6px;vertical-align:middle}',
        '.mb-table th{padding:6px;white-space:nowrap}',
        '.mb-table input,.mb-table select{width:100%;min-width:56px}',
        '.mb-table input.mb-w-s{min-width:52px}.mb-table input.mb-w-m{min-width:90px}.mb-table input.mb-w-l{min-width:130px}',
        '.mb-table tr.mb-err td{background:rgba(248,81,73,.06)}',
        '.mb-live{font-family:"Courier New",monospace;white-space:nowrap;font-size:12px}',
        '.mb-q-good{color:var(--green)}.mb-q-stale{color:var(--orange,#d29922)}.mb-q-bad{color:var(--red)}.mb-q-init{color:var(--text3)}',
        '.mb-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:12px;border:1px solid var(--border);font-size:11px;font-weight:600;margin:2px 6px 2px 0;background:var(--bg1)}',
        '.mb-dot{width:8px;height:8px;border-radius:50%;background:var(--text3);display:inline-block}',
        '.mb-dot.online{background:var(--green)}.mb-dot.error{background:var(--red)}.mb-dot.connecting,.mb-dot.paused{background:var(--orange,#d29922)}',
        '.mb-btn-s{padding:5px 10px;font-size:11px}',
        '.mb-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}',
        '.mb-msgs{font-size:12px;margin-top:8px}',
        '.mb-guide h4{margin:10px 0 4px;font-size:13px;color:var(--text)}.mb-guide p,.mb-guide li{font-size:12px;color:var(--text2);line-height:1.5}',
        '.mb-guide code{background:var(--bg1);padding:1px 5px;border-radius:4px;font-size:11px}',
        '.mb-slider{display:grid;grid-template-columns:minmax(160px,1fr) 2fr 90px;gap:8px;align-items:center;font-size:12px;margin:4px 0}',
        '@media (max-width:700px){.mb-slider{grid-template-columns:1fr}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
}

// ─── rendering ───────────────────────────────────────────────────────────────
function transportOpts(sel) { var s = ''; for (var k in M.TRANSPORT_LABELS) s += opt(k, M.TRANSPORT_LABELS[k], sel); return s; }
function orderOpts(sel, withDefault) { var s = withDefault ? opt('', 'Device default', sel) : ''; M.ORDERS.forEach(function (o) { s += opt(o, o + (o === 'ABCD' ? ' (big-endian)' : o === 'CDAB' ? ' (word swap)' : o === 'BADC' ? ' (byte swap)' : ' (little-endian)'), sel); }); return s; }
function linkOpts(sel) {
    var s = opt('', '— not linked —', sel), grp = null;
    M.VARS.forEach(function (V) {
        if (V.group !== grp) { if (grp) s += '</optgroup>'; grp = V.group; s += '<optgroup label="' + esc(grp) + '">'; }
        s += opt(V.key, V.label + (V.unit ? ' [' + V.unit + ']' : ''), sel);
    });
    return s + (grp ? '</optgroup>' : '');
}
function inp(kind, id, f, val, type, cls, extra) {
    return '<input type="' + (type || 'text') + '" data-k="' + kind + '" data-id="' + esc(id) + '" data-f="' + f + '" value="' + esc(val == null ? '' : val) + '"' + (cls ? ' class="' + cls + '"' : '') + (extra || '') + '>';
}
function sel(kind, id, f, optsHtml, extra) { return '<select data-k="' + kind + '" data-id="' + esc(id) + '" data-f="' + f + '"' + (extra || '') + '>' + optsHtml + '</select>'; }
function chk(kind, id, f, on, extra) { return '<input type="checkbox" data-k="' + kind + '" data-id="' + esc(id) + '" data-f="' + f + '"' + (on ? ' checked' : '') + (extra || '') + '>'; }

function devicesHtml(c) {
    var rows = c.devices.map(function (d) {
        var tcp = d.transport === 'ws' || d.transport === 'ios', ser = d.transport === 'serial';
        return '<tr data-row="dev" data-id="' + esc(d.id) + '">' +
            '<td>' + inp('dev', d.id, 'name', d.name, 'text', 'mb-w-l') + '</td>' +
            '<td>' + sel('dev', d.id, 'transport', transportOpts(d.transport)) + '</td>' +
            '<td>' + (tcp ? inp('dev', d.id, 'host', d.host, 'text', 'mb-w-l', ' placeholder="192.168.1.10"') : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + (tcp ? inp('dev', d.id, 'port', d.port, 'number', 'mb-w-s', ' min="1" max="65535"') : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + (d.transport === 'ws' ? inp('dev', d.id, 'url', d.url, 'text', 'mb-w-l') :
                ser ? sel('dev', d.id, 'baud', [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(function (b) { return opt(b, b + ' baud', d.baud); }).join('')) +
                    sel('dev', d.id, 'parity', opt('even', '8E1 (even)', d.parity) + opt('none', '8N1 / 8N2 (none)', d.parity) + opt('odd', '8O1 (odd)', d.parity)) +
                    sel('dev', d.id, 'stopBits', opt(1, '1 stop bit', d.stopBits) + opt(2, '2 stop bits', d.stopBits)) : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + inp('dev', d.id, 'unit', d.unit, 'number', 'mb-w-s', ' min="0" max="255"') + '</td>' +
            '<td>' + inp('dev', d.id, 'pollMs', d.pollMs, 'number', 'mb-w-m', ' min="' + M.POLL_MIN + '" max="' + M.POLL_MAX + '" step="100" title="Polling interval, 100 ms – 60 s"') + '</td>' +
            '<td>' + inp('dev', d.id, 'timeoutMs', d.timeoutMs, 'number', 'mb-w-m', ' min="50" max="30000" step="50"') + '</td>' +
            '<td>' + inp('dev', d.id, 'retries', d.retries, 'number', 'mb-w-s', ' min="0" max="5"') + '</td>' +
            '<td>' + sel('dev', d.id, 'order', orderOpts(d.order, false)) + '</td>' +
            '<td>' + inp('dev', d.id, 'maxGap', d.maxGap, 'number', 'mb-w-s', ' min="0" max="100" title="Largest gap (registers) bridged when grouping tags into one block read"') + '</td>' +
            '<td style="text-align:center">' + chk('dev', d.id, 'enabled', d.enabled) + '</td>' +
            '<td class="mb-live" data-devstat="' + esc(d.id) + '"><span class="mb-dot"></span> idle</td>' +
            '<td style="white-space:nowrap"><button class="btn btn-secondary mb-btn-s" data-act="dev-test" data-id="' + esc(d.id) + '">Test</button> ' +
            '<button class="btn btn-secondary mb-btn-s" data-act="dev-del" data-id="' + esc(d.id) + '" title="Delete device">✕</button></td></tr>';
    }).join('');
    return '<div class="mb-scroll"><table class="dtable mb-table" id="mbc_devtable"><thead><tr><th>Name</th><th>Transport</th><th>Host / IP</th><th>Port</th><th>Bridge URL / serial</th><th>Unit id</th><th>Poll (ms)</th><th>Timeout (ms)</th><th>Retries</th><th>Byte / word order</th><th>Max gap</th><th>On</th><th>Status</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="14" class="mb-q-init">No devices yet — add one, or load the simulator demo below.</td></tr>') + '</tbody></table></div>';
}
function tagsHtml(c, tagErrors) {
    var devs = c.devices;
    var rows = c.tags.map(function (t) {
        var T = M.TABLES[t.table], err = tagErrors && tagErrors[t.id], sm = t.scale.mode, V = M.VAR_BY_KEY[t.link];
        var typeOpts = T.bits ? opt('bool', 'Bool / bit', 'bool') : Object.keys(M.TYPES).map(function (k) { return opt(k, M.TYPES[k].label, t.type); }).join('');
        return '<tr data-row="tag" data-id="' + esc(t.id) + '"' + (err ? ' class="mb-err" title="' + esc(err.join('; ')) + '"' : '') + '>' +
            '<td>' + inp('tag', t.id, 'name', t.name, 'text', 'mb-w-l') + '</td>' +
            '<td>' + sel('tag', t.id, 'device', devs.map(function (d) { return opt(d.id, d.name, t.device); }).join('')) + '</td>' +
            '<td>' + sel('tag', t.id, 'table', Object.keys(M.TABLES).map(function (k) { return opt(k, M.TABLES[k].label, t.table); }).join('')) + '</td>' +
            '<td>' + inp('tag', t.id, 'address', t.address, 'number', 'mb-w-m', ' min="0"') + '</td>' +
            '<td>' + sel('tag', t.id, 'type', typeOpts) + '</td>' +
            '<td>' + (T.bits || t.type === 'bool' ? '<span class="mb-q-init">—</span>' : sel('tag', t.id, 'order', orderOpts(t.order, true))) + '</td>' +
            '<td>' + (t.type === 'bool' ? '<span class="mb-q-init">—</span>' : sel('tag', t.id, 'scale.mode', opt('none', 'None', sm) + opt('linear', 'Raw → Eng', sm) + opt('gain', 'Gain / offset', sm))) + '</td>' +
            '<td>' + (sm === 'linear' ? inp('tag', t.id, 'scale.rawMin', t.scale.rawMin, 'number', 'mb-w-s') + inp('tag', t.id, 'scale.rawMax', t.scale.rawMax, 'number', 'mb-w-s') :
                sm === 'gain' ? inp('tag', t.id, 'scale.gain', t.scale.gain, 'number', 'mb-w-s', ' step="any" title="Gain"') : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + (sm === 'linear' ? inp('tag', t.id, 'scale.engMin', t.scale.engMin, 'number', 'mb-w-s') + inp('tag', t.id, 'scale.engMax', t.scale.engMax, 'number', 'mb-w-s') :
                sm === 'gain' ? inp('tag', t.id, 'scale.offset', t.scale.offset, 'number', 'mb-w-s', ' step="any" title="Offset"') : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + inp('tag', t.id, 'unit', t.unit, 'text', 'mb-w-s', ' list="mbc_units" placeholder="' + esc(V ? V.unit : '') + '"') + '</td>' +
            '<td>' + inp('tag', t.id, 'alarm.lolo', t.alarm.lolo, 'number', 'mb-w-s', ' step="any" placeholder="LOLO"') + '</td>' +
            '<td>' + inp('tag', t.id, 'alarm.lo', t.alarm.lo, 'number', 'mb-w-s', ' step="any" placeholder="LO"') + '</td>' +
            '<td>' + inp('tag', t.id, 'alarm.hi', t.alarm.hi, 'number', 'mb-w-s', ' step="any" placeholder="HI"') + '</td>' +
            '<td>' + inp('tag', t.id, 'alarm.hihi', t.alarm.hihi, 'number', 'mb-w-s', ' step="any" placeholder="HIHI"') + '</td>' +
            '<td>' + inp('tag', t.id, 'deadband', t.deadband, 'number', 'mb-w-s', ' min="0" step="any"') + '</td>' +
            '<td>' + sel('tag', t.id, 'link', linkOpts(t.link)) + '</td>' +
            '<td style="text-align:center">' + chk('tag', t.id, 'log', t.log !== false, ' title="Log this tag to the historian"') + '</td>' +
            '<td>' + inp('tag', t.id, 'logDeadband', t.logDeadband, 'number', 'mb-w-s', ' min="0" step="any" title="Historian log deadband (engineering units)"') + '</td>' +
            '<td>' + inp('tag', t.id, 'logMinMs', t.logMinMs, 'number', 'mb-w-s', ' min="0" step="100" title="Minimum historian log interval (ms)"') + '</td>' +
            '<td>' + inp('tag', t.id, 'desc', t.desc, 'text', 'mb-w-l') + '</td>' +
            '<td class="mb-live" data-live="' + esc(t.id) + '">—</td>' +
            '<td style="white-space:nowrap"><button class="btn btn-secondary mb-btn-s" data-act="tag-read" data-id="' + esc(t.id) + '">Test read</button> ' +
            '<button class="btn btn-secondary mb-btn-s" data-act="tag-del" data-id="' + esc(t.id) + '" title="Delete tag">✕</button></td></tr>';
    }).join('');
    var units = []; Object.keys(M.UNITS).forEach(function (k) { M.UNITS[k].defs.forEach(function (d) { if (d[0][0]) units.push(d[0][0]); }); });
    units = ['psig', 'psia', 'kPa', 'bar', 'barg', 'MPa', '°F', '°C', 'MMSCFD', 'MSCFD', '10³ m³/d', 'm3/d', 'm3/h', 'BPD', 'STB/d', 'bbl/d', 'gpm', 'L/min', '%', '1/64 in', 'in', 'mm'];
    return '<datalist id="mbc_units">' + units.map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist>' +
        '<div class="mb-scroll"><table class="dtable mb-table" id="mbc_tagtable" style="min-width:2300px"><thead><tr><th>Tag</th><th>Device</th><th>Register table</th><th>Address</th><th>Data type</th><th>Word order</th><th>Scaling</th><th>Raw min / max · gain</th><th>Eng min / max · offset</th><th>Units</th><th>LOLO</th><th>LO</th><th>HI</th><th>HIHI</th><th>Deadband</th><th>Link to app variable</th><th>Log</th><th>Log deadband</th><th>Log min (ms)</th><th>Description</th><th>Live value</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="22" class="mb-q-init">No tags yet.</td></tr>') + '</tbody></table></div>';
}
function slaveHtml(c) {
    var s = c.sim || {}, man = s.manual || {}, nom = M.nominalValues ? M.nominalValues() : {};
    var keys = ['whp', 'sep_p', 'gas_rate', 'oil_rate', 'water_rate', 'surge_lvl_a', 'gauge_lvl_a', 'sep_liq_lvl'];
    var sliders = keys.map(function (k) {
        var V = M.VAR_BY_KEY[k], v = isNum(man[k]) ? man[k] : (isNum(nom[k]) ? nom[k] : 0), max = V.max || 100;
        return '<div class="mb-slider"><span>' + esc(V.label) + '</span><input type="range" data-k="sim" data-f="manual.' + k + '" min="' + (V.min || 0) + '" max="' + max + '" step="' + (max > 1000 ? 10 : max > 100 ? 1 : 0.1) + '" value="' + v + '"' + (s.source !== 'manual' ? ' disabled' : '') + '><span class="mb-live">' + esc(fmtVal(v)) + ' ' + esc(V.unit) + '</span></div>';
    }).join('') +
        '<div class="mb-slider"><span>ESD valve SDV-101 open</span><span>' + '<input type="checkbox" data-k="sim" data-f="manual.esd_open"' + ((isNum(man.esd_open) ? man.esd_open : 1) ? ' checked' : '') + (s.source !== 'manual' ? ' disabled' : '') + '></span><span></span></div>';
    var map = M.DEMO_MAP.map(function (m) {
        var V = M.VAR_BY_KEY[m[1]], p = m[2] === 'coil' ? 0 : m[2] === 'discrete' ? 1 : m[2] === 'input' ? 3 : 4;
        return '<tr><td>' + esc(m[0]) + '</td><td>' + esc(M.TABLES[m[2]].label) + '</td><td>' + m[3] + '</td><td>' + (p * 10000 + m[3] + 1) + '</td><td>' + esc(m[4]) + '</td><td>' + esc(m[5] || '—') + '</td><td>' + esc(m[7] || '—') + '</td><td>' + esc(V ? V.label : 'command / set point') + '</td></tr>';
    }).join('');
    return '<div class="fg"><div class="fg-item"><label>Value source</label><select data-k="sim" data-f="source">' +
        opt('sim', 'Well Test Simulator model (WTS_sim)', s.source) + opt('waveform', 'Waveforms (sine / ramps)', s.source) + opt('manual', 'Manual sliders', s.source) + '</select></div>' +
        '<div class="fg-item"><label>Simulation speed</label><select data-k="sim" data-f="speed">' + opt(1, '1× real time', s.speed) + opt(10, '10×', s.speed) + opt(60, '60×', s.speed) + '</select></div></div>' +
        '<div style="margin-top:12px">' + sliders + '</div>' +
        '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--text2)">Virtual slave register map (unit id 1)</summary><div class="mb-scroll"><table class="dtable" style="min-width:760px"><thead><tr><th>Tag</th><th>Table</th><th>Protocol address</th><th>PLC address</th><th>Type</th><th>Order</th><th>Units</th><th>Variable</th></tr></thead><tbody>' + map + '</tbody></table></div></details>';
}
function guideHtml() {
    return '<div class="mb-guide">' +
        '<h4>Web browser → Modbus TCP (WebSocket bridge)</h4><p>Browsers cannot open raw TCP sockets, so a small bridge runs on a PC on the same network as the PLC / RTU. It ships in the repository as <code>tools/modbus-bridge/</code> (Node.js ≥ 18, no dependencies):</p>' +
        '<ul><li>Windows / macOS / Linux: <code>node tools/modbus-bridge/modbus-bridge.js --allow 192.168.1.10:502</code></li>' +
        '<li>It listens on <code>ws://127.0.0.1:8502</code> (localhost only by default), connects only to the allow-listed host:port pairs, and refuses Modbus writes unless started with <code>--allow-writes</code>.</li>' +
        '<li>Set the device transport to "Modbus TCP via WebSocket bridge", the host / IP and port of the PLC, and the bridge URL.</li></ul>' +
        '<h4>Modbus RTU (RS-485) — Web Serial</h4><p>Chrome or Edge on a desktop, page served over https or localhost. Plug in a USB–RS-485 adapter, choose "Modbus RTU via Web Serial", set baud / parity / unit id, then press <b>Test</b> — the browser asks which serial port to use (once).</p>' +
        '<h4>iOS app — native TCP</h4><p>In the iOS app, choose "Modbus TCP (iOS app, native)". The app connects directly to the PLC over Wi-Fi (Network framework); iOS asks once for Local Network permission.</p>' +
        '<h4>No hardware?</h4><p>"Load simulator demo" configures one device on the built-in virtual slave: 36 tags covering pressures, temperatures, rates, levels and valve states, fed by the Well Test Simulator model. Mini WellOS then animates from those tags when its data source is set to "Modbus data".</p></div>';
}
function summaryHtml(c, errors) {
    var linked = {}; c.tags.forEach(function (t) { if (t.link) linked[t.link] = 1; });
    var dn = {}; c.devices.forEach(function (d) { dn[d.id] = d.name; });
    var ok = !errors.length;
    return '<div class="rbox"><div class="rbox-title">Configuration summary</div>' +
        '<div class="rrow"><span class="rl">Devices</span><span class="rv">' + c.devices.length + '</span></div>' +
        '<div class="rrow"><span class="rl">Tags</span><span class="rv">' + c.tags.length + '</span></div>' +
        '<div class="rrow"><span class="rl">App variables linked</span><span class="rv">' + Object.keys(linked).length + ' of ' + M.VARS.length + '</span></div>' +
        '<div class="rrow"><span class="rl">Addressing</span><span class="rv">' + (c.base ? '1-based (PLC)' : '0-based (protocol)') + '</span></div>' +
        '<div class="rrow"><span class="rl">Writes</span><span class="rv">' + (c.writesEnabled ? 'ENABLED' : 'Read-only') + '</span></div>' +
        '<div class="rrow"><span class="rl">Polling</span><span class="rv">' + (c.paused ? 'Paused' : 'Active while a live page is open') + '</span></div></div>' +
        '<div style="color:var(--' + (ok ? 'green' : 'orange,#d29922') + ');margin-top:10px;font-size:13px">' + (ok ? '✓ Configuration is valid.' : '⚠ ' + esc(errors.length + ' configuration issue' + (errors.length > 1 ? 's' : '') + ' — see the highlighted rows.')) + '</div>' +
        (errors.length ? '<ul class="mb-msgs" style="color:var(--text2)">' + errors.slice(0, 20).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' : '') +
        (c.tags.length ? '<table class="dtable" style="margin-top:12px"><thead><tr><th>Tag</th><th>Device</th><th>Table</th><th>Address</th><th>Type</th><th>Units</th><th>Linked variable</th></tr></thead><tbody>' +
            c.tags.slice(0, 200).map(function (t) { var V = M.VAR_BY_KEY[t.link]; return '<tr><td>' + esc(t.name) + '</td><td>' + esc(dn[t.device] || '') + '</td><td>' + esc(t.table) + '</td><td>' + esc(t.address) + '</td><td>' + esc(t.type) + '</td><td>' + esc(t.unit || '—') + '</td><td>' + esc(V ? V.label : '—') + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
        '<div style="margin-top:12px;font-size:12px;color:var(--text2)"><b>Notes</b> Values are read-only unless "Enable writes" is ticked; every write asks for confirmation. A tag linked to an app variable is converted from its units to the app field unit (psig, °F, MMSCFD, bbl/d, %). Gas volumes convert by volume only — the difference between 60 °F / 14.696 psia and 15 °C / 101.325 kPa base conditions (about 0.1-0.2 %) is not applied. Quality: good = fresh reply, stale = no reply for 3 poll intervals, bad = timeout, exception or unit mismatch.</div>';
}

function render(body) {
    injectCss();
    if (ctl) ctl.dispose();
    if (M.syncStation) M.syncStation();
    var c = M.getConfig(), n = M.normalizeConfig(c);
    body.innerHTML = '<div id="mbc_root" data-no-persist>' +
        '<div class="info-bar">Configure Modbus devices and tags, link them to well-test variables, then open <b>Mini WellOS</b> and switch its data source to "Modbus data". Read-only unless writes are enabled below.</div>' +
        '<div class="mb-bar" id="mbc_bar"></div>' +
        '<div class="card"><div class="card-title">Devices</div><div id="mbc_devs"></div><div class="btn-row"><button class="btn btn-secondary" data-act="dev-add">+ Add device</button><button class="btn btn-secondary" data-act="demo">Load simulator demo</button></div></div>' +
        '<div class="card"><div class="card-title">Tags / channels</div>' +
        '<div class="fg" style="margin-bottom:10px"><div class="fg-item"><label>Register addressing</label><select data-k="cfg" data-f="base">' + opt(0, '0-based (protocol address, 0 = first register)', c.base) + opt(1, '1-based (PLC numbering: 1, 40001, 400001)', c.base) + '</select></div></div>' +
        '<div id="mbc_tags"></div><div class="btn-row"><button class="btn btn-secondary" data-act="tag-add">+ Add tag</button></div></div>' +
        '<div class="cols-2"><div class="card"><div class="card-title">Security &amp; writes</div>' +
        '<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" data-k="cfg" data-f="writesEnabled"' + (c.writesEnabled ? ' checked' : '') + '> Enable writes (FC05 / 06 / 15 / 16)</label>' +
        '<div class="fg" style="margin-top:12px"><div class="fg-item"><label>Tag to write</label><select id="mbc_wtag_sel" data-no-persist></select></div><div class="fg-item"><label>Value (engineering units)</label><input type="number" step="any" data-role="wval"></div></div>' +
        '<div class="btn-row"><button class="btn btn-primary" data-act="write">Write…</button></div><div class="mb-msgs" id="mbc_wmsg"></div></div>' +
        '<div class="card"><div class="card-title">Import / export</div><div class="btn-row" style="flex-wrap:wrap">' +
        '<button class="btn btn-secondary" data-act="exp-json">Export JSON</button><button class="btn btn-secondary" data-act="exp-csv">Export tags CSV</button>' +
        '<button class="btn btn-secondary" data-act="imp-json">Import JSON…</button><button class="btn btn-secondary" data-act="imp-csv">Import tags CSV…</button>' +
        '<button class="btn btn-secondary" data-act="clear">Clear all</button></div>' +
        '<input type="file" accept=".json,.csv,.txt,application/json,text/csv" data-role="file" style="display:none">' +
        '<div class="mb-msgs" id="mbc_imsg"></div><div style="font-size:12px;color:var(--text2);margin-top:8px">The configuration is saved as <code>wts_modbus_config</code> and travels in project files.</div></div></div>' +
        '<div class="card"><div class="card-title">Built-in Modbus simulator (virtual slave)</div><div id="mbc_slave"></div></div>' +
        '<div class="card"><div class="card-title">Connecting to real equipment</div>' + guideHtml() + '</div>' +
        '<div id="mbc_res"></div></div>';
    var root = byId('mbc_root');
    ctl = createController(root, n);
    if (typeof G.calcModbusConfig === 'function') G.calcModbusConfig();
}

function createController(root, n0) {
    var cfg = n0.config, tagErrors = n0.tagErrors, errors = n0.errors, disposed = false, monitor = null, pendingImport = null;
    var C = { root: root };
    function q(sel) { return root.querySelector(sel); }
    function refresh(which) {
        if (!which || which.dev) { var d = q('#mbc_devs'); if (d) d.innerHTML = devicesHtml(cfg); }
        if (!which || which.tag) { var t = q('#mbc_tags'); if (t) t.innerHTML = tagsHtml(cfg, tagErrors); }
        if (!which || which.slave) { var s = q('#mbc_slave'); if (s) s.innerHTML = slaveHtml(cfg); }
        var ws = q('#mbc_wtag_sel'), keep = ws ? ws.value : '';
        if (ws) ws.innerHTML = cfg.tags.filter(function (t) { return !M.TABLES[t.table].readOnly; }).map(function (t) { return opt(t.id, t.name + ' (' + M.TABLES[t.table].label + ' ' + t.address + ')', ''); }).join('') || opt('', '— no writable tags (coil / holding) —', '');
        if (ws && keep && cfg.tags.some(function (t) { return t.id === keep && !M.TABLES[t.table].readOnly; })) ws.value = keep;
        var r = q('#mbc_res'); if (r) r.innerHTML = summaryHtml(cfg, errors);
        bar(); live();
    }
    function save(which) {
        var res = M.saveConfig(cfg);
        cfg = res.config || cfg; tagErrors = res.tagErrors || {}; errors = res.errors || [];
        if (monitor) { monitor = null; attachMonitor(); }
        refresh(which || {});
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.modbus = { devices: cfg.devices.length, tags: cfg.tags.length, writesEnabled: cfg.writesEnabled, errors: errors.length };
        return res;
    }
    C.save = save;
    function find(kind, id) { return (kind === 'dev' ? cfg.devices : cfg.tags).filter(function (x) { return x.id === id; })[0]; }
    function setPath(o, path, v) { var p = path.split('.'); for (var i = 0; i < p.length - 1; i++) { o[p[i]] = o[p[i]] || {}; o = o[p[i]]; } o[p[p.length - 1]] = v; }
    var NUMF = /^(port|unit|pollMs|timeoutMs|retries|maxGap|baud|stopBits|address|deadband|logDeadband|logMinMs|scale\.\w+|alarm\.\w+)$/;
    function onChange(ev) {
        var el = ev.target; if (!el || !el.getAttribute) return;
        var k = el.getAttribute('data-k'), f = el.getAttribute('data-f');
        if (!k || !f) return;
        var v = el.type === 'checkbox' ? !!el.checked : el.value;
        var isManual = k === 'sim' && f.indexOf('manual.') === 0;
        if (ev.type !== 'change' && !isManual) return;      // text edits commit on change; sliders preview on input
        if (k === 'cfg') {
            if (f === 'base') {
                var nb = +v === 1 ? 1 : 0;
                // keep every tag's protocol address; a 1-based number that would read as 5-digit PLC
                // notation (e.g. 40002 on a holding register) is written in 6-digit form (440002).
                if (nb !== cfg.base) cfg.tags.forEach(function (t) {
                    var pa = M.protocolAddress(t.address, t.table, cfg.base); if (!isNum(pa)) return;
                    if (!nb) { t.address = pa; return; }
                    t.address = pa + 1;
                    if (M.protocolAddress(t.address, t.table, 1) !== pa) t.address = M.TABLES[t.table].plc * 100000 + pa + 1;
                });
                cfg.base = nb; save({ tag: 1 }); return;
            }
            if (f === 'writesEnabled') {
                if (v && typeof G.confirm === 'function' && !G.confirm('Enable Modbus writes?\n\nThis page will then be able to send write commands (FC05 / 06 / 15 / 16) to the connected equipment. Every write still asks for confirmation.')) { el.checked = false; return; }
                cfg.writesEnabled = !!v; save({}); return;
            }
            return;
        }
        if (k === 'sim') {
            cfg.sim = cfg.sim || { source: 'sim', speed: 1, manual: {} };
            if (f === 'source') { cfg.sim.source = v; if (M.virtualSlave) M.virtualSlave().driver.reset(); save({ slave: 1 }); return; }
            if (f === 'speed') { cfg.sim.speed = +v; save({}); return; }
            if (f.indexOf('manual.') === 0) {
                cfg.sim.manual = cfg.sim.manual || {};
                cfg.sim.manual[f.slice(7)] = el.type === 'checkbox' ? (v ? 1 : 0) : +v;
                var lbl = el.parentNode && el.parentNode.querySelector && el.parentNode.querySelector('.mb-live');
                if (lbl && el.type !== 'checkbox') { var V = M.VAR_BY_KEY[f.slice(7)]; lbl.textContent = fmtVal(+v) + ' ' + (V ? V.unit : ''); }
                if (ev.type === 'change') M.saveConfig(cfg, { keepStation: true });
                return;
            }
            return;
        }
        var id = el.getAttribute('data-id'), o = find(k, id);
        if (!o) return;
        if (NUMF.test(f) && el.type !== 'checkbox') v = v === '' ? (/^alarm\./.test(f) ? null : '') : +v;
        setPath(o, f, v);
        var structural = /^(transport|table|type|scale\.mode|device|link)$/.test(f);
        if (k === 'tag' && f === 'table' && M.TABLES[v].bits) o.type = 'bool';
        if (k === 'tag' && f === 'table' && !M.TABLES[v].bits && o.type === 'bool') o.type = 'uint16';
        if (k === 'tag' && f === 'link' && v && !o.unit) o.unit = M.VAR_BY_KEY[v].unit === 'bbl/d' ? 'BPD' : M.VAR_BY_KEY[v].unit;
        save(structural || k === 'dev' ? (k === 'dev' ? { dev: 1, tag: 1 } : { tag: 1 }) : { none: 1 });
        if (!structural && k === 'tag') {       // keep focus: only refresh the row's error state
            var tr = el.closest && el.closest('tr');
            if (tr) { var e = tagErrors[id]; if (e) { tr.classList.add('mb-err'); tr.setAttribute('title', e.join('; ')); } else { tr.classList.remove('mb-err'); tr.removeAttribute('title'); } }
        }
    }
    function msg(id, html, kind) { var m = q('#' + id); if (m) m.innerHTML = '<span class="mb-q-' + (kind || 'good') + '">' + html + '</span>'; }
    function tempStation(devId) {
        var c2 = JSON.parse(JSON.stringify(cfg));
        if (devId) { c2.devices = c2.devices.filter(function (d) { return d.id === devId; }); c2.tags = c2.tags.filter(function (t) { return t.device === devId; }); }
        return M.createStation(c2);
    }
    function station() { return M.station() || tempStation(); }
    function onClick(ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!b || !root.contains(b)) return;
        var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
        switch (act) {
            case 'dev-add': { var d = M.defaultDevice(); d.name = 'Device ' + (cfg.devices.length + 1); cfg.devices.push(d); save({ dev: 1, tag: 1 }); break; }
            case 'dev-del': {
                var used = cfg.tags.filter(function (t) { return t.device === id; }).length;
                if (used && typeof G.confirm === 'function' && !G.confirm('Delete this device and its ' + used + ' tag(s)?')) return;
                cfg.devices = cfg.devices.filter(function (x) { return x.id !== id; }); cfg.tags = cfg.tags.filter(function (t) { return t.device !== id; }); save({ dev: 1, tag: 1 }); break;
            }
            case 'tag-add': {
                if (!cfg.devices.length) { var d0 = M.defaultDevice(); d0.name = 'Device 1'; cfg.devices.push(d0); }
                var t = M.defaultTag(); t.name = 'TAG_' + (cfg.tags.length + 1); t.device = cfg.devices[0].id;
                var last = cfg.tags[cfg.tags.length - 1];
                if (last && last.device === t.device && last.table === t.table) { var pa = M.protocolAddress(last.address, last.table, cfg.base); if (isNum(pa)) t.address = (cfg.base ? pa + 1 : pa) + M.regCount(last.type); }
                cfg.tags.push(t); save({ dev: 1, tag: 1 }); break;
            }
            case 'tag-del': cfg.tags = cfg.tags.filter(function (x) { return x.id !== id; }); save({ tag: 1 }); break;
            case 'tag-read': {
                var cell = q('[data-live="' + id + '"]'); if (cell) cell.innerHTML = '<span class="mb-q-init">reading…</span>';
                station().testRead(id).then(function (r) {
                    var t = find('tag', id), V = t && M.VAR_BY_KEY[t.link];
                    var txt = 'raw ' + fmtVal(r.raw) + ' → ' + fmtVal(r.value) + (t && t.unit ? ' ' + t.unit : '') + (V && r.canon != null ? (isNum(r.canon) ? ' (' + fmtVal(r.canon) + ' ' + V.unit + ')' : ' (unit mismatch)') : '');
                    if (cell) cell.innerHTML = '<span class="mb-q-good">' + esc(txt) + '</span>';
                    C.lastTestRead = r;
                }, function (e) { if (cell) cell.innerHTML = '<span class="mb-q-bad">' + esc(e.message) + '</span>'; C.lastTestRead = { error: e.message }; });
                break;
            }
            case 'dev-test': {
                var cellD = q('[data-devstat="' + id + '"]'); if (cellD) cellD.innerHTML = '<span class="mb-dot connecting"></span> testing…';
                var ts = tempStation(id);
                ts.pollNow().then(function () {
                    var info = ts.devices()[0] || {}, v = ts.values(), n = 0, bad = 0;
                    Object.keys(v).forEach(function (k2) { n++; if (v[k2].q === 'bad') bad++; });
                    var ok = info.status === 'online' && !bad;
                    if (cellD) cellD.innerHTML = '<span class="mb-dot ' + (ok ? 'online' : 'error') + '"></span> ' + (ok ? 'OK — ' + n + ' tags in ' + info.blocks + ' block read(s)' : esc(info.lastErr || (bad + ' of ' + n + ' tags failed')));
                    C.lastDevTest = { ok: ok, info: info, tags: n, bad: bad };
                    ts.dispose();
                }, function (e) { if (cellD) cellD.innerHTML = '<span class="mb-dot error"></span> ' + esc(e.message); ts.dispose(); });
                break;
            }
            case 'demo':
                if (cfg.tags.length && typeof G.confirm === 'function' && !G.confirm('Replace the current configuration with the simulator demo?')) return;
                cfg = M.demoConfig(); save({ dev: 1, tag: 1, slave: 1 }); msg('mbc_imsg', '✓ Simulator demo loaded: 1 device, ' + cfg.tags.length + ' tags.'); break;
            case 'clear':
                if (typeof G.confirm === 'function' && !G.confirm('Remove all devices and tags?')) return;
                cfg = M.defaultConfig(); save({ dev: 1, tag: 1, slave: 1 }); break;
            case 'exp-json': download('modbus-config.json', JSON.stringify(cfg, null, 2), 'application/json'); break;
            case 'exp-csv': download('modbus-tags.csv', M.tagsToCsv(cfg), 'text/csv'); break;
            case 'imp-json': case 'imp-csv': { pendingImport = act; var f = q('[data-role="file"]'); if (f) { f.value = ''; f.click(); } break; }
            case 'write': doWrite(); break;
            case 'monitor': if (monitor) detachMonitor(); else attachMonitor(); bar(); break;
            case 'pause': M.setPaused(!M.getConfig().paused); cfg.paused = M.getConfig().paused; bar(); refresh({}); break;
            case 'pollnow': { var s = M.station(); if (s) s.pollNow().then(live); break; }
        }
    }
    C.importText = function (text, kind) {
        if (kind === 'imp-csv' || kind === 'csv') {
            var r = M.tagsFromCsv(text, cfg);
            if (!r.tags.length) { msg('mbc_imsg', '✗ ' + esc(r.errors.join('; ') || 'no rows'), 'bad'); return { ok: false, errors: r.errors }; }
            cfg.tags = cfg.tags.concat(r.tags); var res = save({ tag: 1 });
            msg('mbc_imsg', '✓ Imported ' + r.tags.length + ' tag(s)' + (r.errors.length ? ' — ' + esc(r.errors.join('; ')) : '') + '.');
            return { ok: true, count: r.tags.length, errors: r.errors.concat(res.errors || []) };
        }
        var obj; try { obj = JSON.parse(text); } catch (e) { msg('mbc_imsg', '✗ Not valid JSON: ' + esc(e.message), 'bad'); return { ok: false, errors: [e.message] }; }
        var n = M.normalizeConfig(obj);
        cfg = n.config; var res2 = save({ dev: 1, tag: 1, slave: 1 });
        msg('mbc_imsg', '✓ Imported ' + cfg.devices.length + ' device(s), ' + cfg.tags.length + ' tag(s)' + (res2.errors.length ? ' — ' + res2.errors.length + ' issue(s), see the summary' : '') + '.');
        return { ok: true, errors: res2.errors };
    };
    function onFile(ev) {
        var f = ev.target && ev.target.files && ev.target.files[0];
        if (!f || !pendingImport) return;
        var kind = /\.csv$/i.test(f.name) ? 'imp-csv' : pendingImport, rd = new FileReader();
        rd.onload = function () { C.importText(String(rd.result || ''), kind); };
        rd.readAsText(f);
    }
    function doWrite() {
        var tid = (q('#mbc_wtag_sel') || {}).value, val = parseFloat((q('[data-role="wval"]') || {}).value);
        if (!cfg.writesEnabled) { msg('mbc_wmsg', '✗ Writes are disabled. Tick "Enable writes" first.', 'bad'); return Promise.resolve(false); }
        var t = find('tag', tid);
        if (!t || !isFinite(val)) { msg('mbc_wmsg', '✗ Choose a writable tag and a numeric value.', 'bad'); return Promise.resolve(false); }
        var dn = (find('dev', t.device) || {}).name || '';
        if (typeof G.confirm === 'function' && !G.confirm('Write ' + val + (t.unit ? ' ' + t.unit : '') + ' to ' + t.name + '?\n\nDevice: ' + dn + ', ' + M.TABLES[t.table].label + ' ' + t.address + '.')) { msg('mbc_wmsg', 'Write cancelled.', 'init'); return Promise.resolve(false); }
        return station().write(tid, val, { confirmed: true }).then(function () { msg('mbc_wmsg', '✓ Wrote ' + esc(val) + ' to ' + esc(t.name) + '.'); return true; },
            function (e) { msg('mbc_wmsg', '✗ ' + esc(e.message), 'bad'); return false; });
    }
    C.doWrite = doWrite;
    function bar() {
        var b = q('#mbc_bar'); if (!b) return;
        var s = M.station(), paused = M.getConfig().paused, devs = s ? s.devices() : [];
        b.innerHTML = '<button class="btn ' + (monitor ? 'btn-secondary' : 'btn-primary') + ' mb-btn-s" data-act="monitor">' + (monitor ? '■ Stop live monitor' : '▶ Start live monitor') + '</button>' +
            '<button class="btn btn-secondary mb-btn-s" data-act="pause">' + (paused ? '▶ Resume polling' : '❚❚ Pause polling') + '</button>' +
            (monitor ? '<button class="btn btn-secondary mb-btn-s" data-act="pollnow">Poll now</button>' : '') +
            devs.map(function (d) { return '<span class="mb-pill"><span class="mb-dot ' + esc(d.status) + '"></span>' + esc(d.name) + ' · ' + esc(d.status) + (d.lastOk ? ' · ' + fmtTime(d.lastOk) : '') + '</span>'; }).join('') +
            (paused ? '<span class="mb-pill"><span class="mb-dot paused"></span>Polling paused</span>' : '');
    }
    function live() {
        var s = M.station(); if (!s) return;
        var v = s.values();
        Object.keys(v).forEach(function (id) {
            var cell = q('[data-live="' + id + '"]'), r = v[id]; if (!cell) return;
            var t = s.tag(id), V = t && M.VAR_BY_KEY[t.link];
            var txt = r.q === 'init' ? '—' : (isNum(r.value) ? fmtVal(r.value) : '—') + (t && t.unit ? ' ' + t.unit : '') + (r.q !== 'good' ? ' · ' + r.q : '') + (r.unitErr ? ' · unit?' : '');
            if (V && V.kind === 'bool' && r.q !== 'init') txt = (r.value ? 'ON' : 'OFF') + (r.q !== 'good' ? ' · ' + r.q : '');
            cell.innerHTML = '<span class="mb-q-' + esc(r.q) + '" title="' + esc(r.err || '') + '">' + esc(txt) + '</span>';
        });
        s.devices().forEach(function (d) {
            var cell = q('[data-devstat="' + d.id + '"]'); if (!cell) return;
            cell.innerHTML = '<span class="mb-dot ' + esc(d.status) + '"></span> ' + esc(d.status) + (d.lastErr ? ' — ' + esc(d.lastErr) : d.lastOk ? ' · ' + fmtTime(d.lastOk) : '');
        });
    }
    var onPoll = function () { if (!disposed) { live(); bar(); } };
    function attachMonitor() {
        monitor = M.acquire(OWNER);
        monitor.on('poll', onPoll); monitor.on('status', onPoll);
        bar();
    }
    function detachMonitor() {
        if (monitor) { monitor.off('poll', onPoll); monitor.off('status', onPoll); }
        monitor = null; M.release(OWNER); bar();
    }
    C.startMonitor = attachMonitor; C.stopMonitor = detachMonitor;
    C.config = function () { return cfg; };
    function onPage(e) { if (!root.isConnected || (e && e.detail && e.detail.page !== 'modbus')) C.dispose(); }
    function onProject() { if (root.isConnected && typeof G.WTS_rerender !== 'function') { cfg = M.getConfig(); refresh({}); } }
    root.addEventListener('change', onChange);
    root.addEventListener('input', onChange);
    root.addEventListener('click', onClick);
    var fileEl = root.querySelector('[data-role="file"]'); if (fileEl) fileEl.addEventListener('change', onFile);
    document.addEventListener('h2oil:pagechange', onPage);
    document.addEventListener('wts:project-loaded', onProject);
    C.dispose = function () {
        if (disposed) return; disposed = true;
        if (monitor) detachMonitor();
        root.removeEventListener('change', onChange); root.removeEventListener('input', onChange); root.removeEventListener('click', onClick);
        document.removeEventListener('h2oil:pagechange', onPage);
        document.removeEventListener('wts:project-loaded', onProject);
        if (ctl === C) ctl = null;
    };
    refresh({});
    G.WTS_state = G.WTS_state || {};
    G.WTS_state.modbus = { devices: cfg.devices.length, tags: cfg.tags.length, writesEnabled: cfg.writesEnabled, errors: errors.length };
    return C;
}

// calc<X> hook (host units wrapper convention): refresh the summary.
G.calcModbusConfig = function () { if (ctl) { var r = byId('mbc_res'); return !!r; } return false; };
M.page = { controller: function () { return ctl; } };

G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.modbus = {
    key: 'modbus', title: 'Modbus Configuration', navTitle: 'Modbus Config',
    sub: 'Modbus TCP / RTU devices, tags, scaling, alarms and links to well-test variables',
    group: 'Live Data', icon: '&#8646;', badge: 'Live Data', bc: 'dc-b-blue',
    desc: 'Connect PLCs and RTUs over Modbus TCP (bridge / iOS) or RTU (Web Serial), or the built-in simulator.',
    render: render
};
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var ok = !!(G.WTS_calcRegistry && G.WTS_calcRegistry.modbus && typeof G.WTS_calcRegistry.modbus.render === 'function');
    if (typeof console !== 'undefined') console[ok ? 'log' : 'warn']('[62-modbus-page] self-test ' + (ok ? 'passed' : 'FAILED'));
})();
