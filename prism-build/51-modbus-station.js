// =============================================================================
// 51-modbus-station.js — Modbus configuration, polling station, alarms,
// app-variable links and the built-in virtual slave (Round-10, "Live Data")
// -----------------------------------------------------------------------------
// Extends window.WTS_modbus (50-modbus-core.js):
//   VARS / varsFromState / applyVarsToState   well-test variables (WTS_sim snapshot paths)
//   UNITS / toCanonical / fromCanonical       tag engineering unit → app field unit
//   defaultConfig / demoConfig / normalizeConfig / getConfig / saveConfig / setPaused
//   tagsToCsv / tagsFromCsv / planBlocks / alarmLevel / createAlarmManager
//   createStation(config, env)   polling scheduler (timers only while started)
//   acquire(owner) / release(owner) / station()   shared station for the pages
//   virtualSlave() / DEMO_MAP    in-browser Modbus slave driven by WTS_sim / waveforms / manual
//   publishSamples(batch)        → window.WTS_historian.record(batch) + 'wts:modbus-samples'
//   getTags()                    tag list for other modules; 'wts:modbus-config-changed' on save
//
// Storage: localStorage 'wts_modbus_config' (travels in project files — 29 snapshots every wts_* key).
// Load-time rule: no DOM, timers, storage writes or listeners at load.
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
var M = G.WTS_modbus = G.WTS_modbus || {};
if (!M.createClient) return;     // core missing — nothing to extend

var STORE_KEY = 'wts_modbus_config';
var TRANSPORTS = { sim: 'Built-in simulator (virtual slave)', ws: 'Modbus TCP via WebSocket bridge', serial: 'Modbus RTU via Web Serial', ios: 'Modbus TCP (iOS app, native)' };
var POLL_MIN = 100, POLL_MAX = 60000;

function isNum(x) { return typeof x === 'number' && isFinite(x); }
function num(x, d) { var v = (x === '' || x == null) ? NaN : +x; return isFinite(v) ? v : d; }
function optNum(x) { var v = (x === '' || x == null) ? NaN : +x; return isFinite(v) ? v : null; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function now() { return Date.now(); }
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function uid(p) { return p + '_' + Math.floor(Math.random() * 0x7fffffff).toString(36) + (now() % 100000).toString(36); }
function str(x, max) { return String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, ' ').slice(0, max || 80); }
function doc() { return (typeof document !== 'undefined' && document) ? document : null; }
function fire(type, detail) {
    var d = doc();
    try { if (d && typeof d.dispatchEvent === 'function' && typeof CustomEvent === 'function') d.dispatchEvent(new CustomEvent(type, { detail: detail })); } catch (e) {}
}
function ls() { try { return G.localStorage || null; } catch (e) { return null; } }

// ─── unit conversion: tag engineering unit → app canonical (field) unit ──────
// Factors: NIST SP 811 (2008) Appendix B — 1 psi = 6.894 757 kPa; 1 bar = 100 kPa;
// 1 ft³ = 0.028 316 846 592 m³ (exact); 1 bbl = 42 US gal = 0.158 987 294 928 m³ (exact);
// 1 kgf/cm² = 98.0665 kPa; standard atmosphere 101.325 kPa = 14.695 95 psi.
// Gas volumes: only the volume factor is applied — the 60 °F / 14.696 psia vs
// 15 °C / 101.325 kPa base-condition difference (≈ 0.1-0.2 %) is NOT applied.
var KPA_PSI = 6.894757293168, ATM_PSI = 101.325 / KPA_PSI, FT3 = 0.028316846592, BBL = 0.158987294928, MMCF_M3 = 1e6 * FT3;
var UNITS = {
    pressureG: { canon: 'psig', defs: [
        [['psig', 'psi', 'lbf/in2', 'lb/in2'], 1, 0],
        [['psia'], 1, -ATM_PSI],
        [['kpa', 'kpag', 'kpa(g)'], 1 / KPA_PSI, 0],
        [['kpaa', 'kpa(a)'], 1 / KPA_PSI, -ATM_PSI],
        [['mpa', 'mpag', 'mpa(g)'], 1000 / KPA_PSI, 0],
        [['bar', 'barg', 'bar(g)'], 100 / KPA_PSI, 0],
        [['bara', 'bar(a)'], 100 / KPA_PSI, -ATM_PSI],
        [['kg/cm2', 'kgf/cm2', 'kg/cm²', 'kgf/cm²'], 98.0665 / KPA_PSI, 0]] },
    temperature: { canon: '°F', defs: [
        [['°f', 'f', 'degf', 'deg f'], 1, 0],
        [['°c', 'c', 'degc', 'deg c'], 9 / 5, 32],
        [['k', 'kelvin'], 9 / 5, 32 - 273.15 * 9 / 5]] },
    gasRate: { canon: 'MMSCFD', defs: [
        [['mmscfd', 'mmscf/d', 'mmcfd'], 1, 0],
        [['mscfd', 'mscf/d', 'kscfd', 'mcfd'], 1e-3, 0],
        [['scfd', 'scf/d'], 1e-6, 0],
        [['scfh', 'scf/h'], 24e-6, 0],
        [['e3m3/d', '10³ m³/d', '10^3 m3/d', 'km3/d', '1000 m3/d'], 1000 / MMCF_M3, 0],
        [['m3/d', 'sm3/d', 'm³/d', 'sm³/d'], 1 / MMCF_M3, 0],
        [['m3/h', 'sm3/h', 'm³/h', 'sm³/h'], 24 / MMCF_M3, 0]] },
    liquidRate: { canon: 'bbl/d', defs: [
        [['bpd', 'bbl/d', 'stb/d', 'stbd', 'bopd', 'bwpd', 'blpd'], 1, 0],
        [['m3/d', 'm³/d', 'sm3/d'], 1 / BBL, 0],
        [['m3/h', 'm³/h'], 24 / BBL, 0],
        [['l/min', 'lpm'], 1440 / (1000 * BBL), 0],
        [['gpm', 'usgpm', 'gal/min'], 1440 / 42, 0],
        [['bph', 'bbl/h'], 24, 0]] },
    percent: { canon: '%', defs: [[['%', 'pct', 'percent'], 1, 0], [['fraction', 'frac', '0-1'], 100, 0]] },
    choke: { canon: '1/64 in', defs: [[['1/64 in', '1/64in', '/64', '64ths', '64th'], 1, 0], [['in', 'inch'], 64, 0], [['mm'], 64 / 25.4, 0]] },
    bool: { canon: '', defs: [[[''], 1, 0]] }
};
function normUnit(u) { return String(u == null ? '' : u).trim().toLowerCase().replace(/\s+/g, ' '); }
function unitDef(unit, cat) {
    var C = UNITS[cat]; if (!C) return null;
    var u = normUnit(unit);
    if (u === '' || u === normUnit(C.canon)) return [null, 1, 0];
    for (var i = 0; i < C.defs.length; i++) if (C.defs[i][0].indexOf(u) >= 0) return C.defs[i];
    return null;
}
// toCanonical(value, unit, cat) → value in the app field unit, or NaN when the unit does not fit the category.
function toCanonical(v, unit, cat) {
    if (v == null || !isNum(v)) return v == null ? null : NaN;
    if (!cat || cat === 'bool') return v;
    var d = unitDef(unit, cat);
    return d ? v * d[1] + d[2] : NaN;
}
function fromCanonical(v, unit, cat) {
    if (v == null || !isNum(v)) return v;
    if (!cat || cat === 'bool') return v;
    var d = unitDef(unit, cat);
    return d ? (v - d[2]) / d[1] : NaN;
}
function unitFits(unit, cat) { return !cat || cat === 'bool' || !!unitDef(unit, cat); }

// ─── well-test variables (paths into the WTS_sim snapshot, 31-wts-sim.js) ────
function g(o, path) { try { var x = o; for (var i = 0; i < path.length; i++) x = x[path[i]]; return x; } catch (e) { return undefined; } }
function nz(x) { return isNum(x) ? x : null; }
function pct(x) { return isNum(x) ? x * 100 : null; }
function bool(x) { return x === true ? 1 : x === false ? 0 : null; }
function segScale(s, first, last, ratio) {
    for (var i = first; i <= last; i++) if (s.segs && s.segs[i]) { s.segs[i].vel = Math.max(0, (s.segs[i].vel || 0) * ratio); s.segs[i].flowing = s.segs[i].vel > 0.01; }
}
function lineSet(s, name, ratio, on) {
    var L = s.lines && s.lines[name]; if (!L) return;
    if (ratio != null) { L.q = Math.max(0, (L.q || 0) * ratio); L.vel = Math.max(0, (L.vel || 0) * ratio); }
    if (on != null) L.active = !!on;
}
function ratioOf(v, base) { return isNum(base) && base > 1e-9 ? Math.max(0, v / base) : (v > 0 ? 1 : 0); }
var VARS = [
    { key: 'whp', label: 'Wellhead pressure (WHP)', group: 'Wellhead', cat: 'pressureG', min: 0, max: 5000,
      get: function (s) { return nz(g(s, ['nodes', 'wellhead', 'P'])); },
      set: function (s, v) { s.nodes.wellhead.P = v; s.nodes.esd.P = v; if (s.inputs) s.inputs.Pwh = v; if (s.segs[0]) s.segs[0].P0 = v; } },
    { key: 'wht', label: 'Wellhead temperature (WHT)', group: 'Wellhead', cat: 'temperature', min: 0, max: 300,
      get: function (s) { return nz(g(s, ['nodes', 'wellhead', 'T'])); },
      set: function (s, v) { s.nodes.wellhead.T = v; s.nodes.esd.T = v; if (s.inputs) s.inputs.Twh = v; } },
    { key: 'bhp', label: 'Bottom-hole gauge pressure (BHP)', group: 'Downhole gauge', cat: 'pressureG', min: 0, max: 10000,
      get: function (s) { return nz(g(s, ['downhole', 'P'])); }, set: function (s, v) { s.downhole = s.downhole || {}; s.downhole.P = v; } },
    { key: 'bht', label: 'Bottom-hole gauge temperature (BHT)', group: 'Downhole gauge', cat: 'temperature', min: 0, max: 400,
      get: function (s) { return nz(g(s, ['downhole', 'T'])); }, set: function (s, v) { s.downhole = s.downhole || {}; s.downhole.T = v; } },
    { key: 'esd_open', label: 'ESD valve SDV-101 open', group: 'Wellhead', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['esd', 'open'])); },
      set: function (s, v) { var o = !!v; s.esd.open = o; s.esd.travel = o ? 1 : 0; s.esd.moving = false; if (!o) { s.f = 0; s.fInst = 0; segScale(s, 0, 4, 0); ['wh_esd', 'esd_choke', 'choke_heater', 'heater_sep', 'sep_flare'].forEach(function (n) { lineSet(s, n, 0, false); }); } } },
    { key: 'esd_tripped', label: 'ESD tripped (shutdown)', group: 'Wellhead', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['esd', 'tripped'])); }, set: function (s, v) { s.esd.tripped = !!v; } },
    { key: 'choke_bean', label: 'Choke size', group: 'Choke', cat: 'choke', min: 0, max: 128,
      get: function (s) { var b = g(s, ['nodes', 'choke', 'bean']); return nz(isNum(b) && b > 0 ? b : g(s, ['inputs', 'bean'])); },
      set: function (s, v) { s.nodes.choke.bean = v; if (s.inputs) s.inputs.bean = v; } },
    { key: 'choke_dn_p', label: 'Choke downstream pressure', group: 'Choke', cat: 'pressureG', min: 0, max: 3000,
      get: function (s) { return nz(g(s, ['nodes', 'choke', 'P'])); }, set: function (s, v) { s.nodes.choke.P = v; if (s.segs[2]) s.segs[2].P0 = v; } },
    { key: 'heater_t', label: 'Heater outlet temperature', group: 'Heater', cat: 'temperature', min: 0, max: 300,
      get: function (s) { return nz(g(s, ['nodes', 'heater', 'T'])); }, set: function (s, v) { s.nodes.heater.T = v; } },
    { key: 'heater_bypass', label: 'Heater bypass open', group: 'Heater', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['nodes', 'heater', 'bypass'])); }, set: function (s, v) { s.nodes.heater.bypass = !!v; if (s.inputs) s.inputs.bypass = !!v; } },
    { key: 'sep_p', label: 'Separator pressure', group: 'Separator', cat: 'pressureG', min: 0, max: 1440,
      get: function (s) { return nz(g(s, ['sep', 'P'])); },
      set: function (s, v) { s.sep.P = v; s.nodes.separator.P = v; if (s.segs[3]) s.segs[3].Pout = v; if (s.segs[4]) s.segs[4].P0 = v; } },
    { key: 'sep_t', label: 'Separator temperature', group: 'Separator', cat: 'temperature', min: 0, max: 300,
      get: function (s) { return nz(g(s, ['sep', 'T'])); }, set: function (s, v) { s.sep.T = v; s.nodes.separator.T = v; } },
    { key: 'sep_liq_lvl', label: 'Separator liquid level (inlet compartment)', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'c1', 'fracL'])); }, set: function (s, v) { s.sep.c1.fracL = clamp(v / 100, 0, 1); } },
    { key: 'sep_int_lvl', label: 'Separator water interface level', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'c1', 'fracW'])); }, set: function (s, v) { s.sep.c1.fracW = clamp(v / 100, 0, 1); } },
    { key: 'sep_oil_lvl', label: 'Separator oil bucket level', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'bucket', 'frac'])); }, set: function (s, v) { s.sep.bucket.frac = clamp(v / 100, 0, 1); } },
    { key: 'lcv_oil', label: 'Oil dump valve LCV-102 position', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'oilDump', 'x'])); }, set: function (s, v) { s.sep.oilDump.x = clamp(v / 100, 0, 1); } },
    { key: 'lcv_water', label: 'Water dump valve LCV-101 position', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'waterDump', 'x'])); }, set: function (s, v) { s.sep.waterDump.x = clamp(v / 100, 0, 1); } },
    { key: 'pcv_sep', label: 'Separator gas PCV-101 opening', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'pcv', 'u'])); }, set: function (s, v) { s.sep.pcv.u = clamp(v / 100, 0, 1); } },
    { key: 'gas_rate', label: 'Gas rate', group: 'Rates', cat: 'gasRate', min: 0, max: 50,
      get: function (s) { return nz(g(s, ['rates', 'gas_mmscfd'])); },
      set: function (s, v) {
          var r = ratioOf(v, s.rates.gas_mmscfd); s.rates.gas_mmscfd = v; if (s.sep) { s.sep.gasIn_mmscfd = v; s.sep.gasOut_mmscfd = v; }
          segScale(s, 0, 4, r); ['wh_esd', 'esd_choke', 'choke_heater', 'heater_sep', 'sep_flare'].forEach(function (n) { lineSet(s, n, r, v > 0); });
      } },
    { key: 'oil_rate', label: 'Oil rate', group: 'Rates', cat: 'liquidRate', unitLabel: 'STB/d', min: 0, max: 20000,
      get: function (s) { return nz(g(s, ['rates', 'oil_stbd'])); },
      set: function (s, v) { var r = ratioOf(v, s.rates.oil_stbd); s.rates.oil_stbd = v; lineSet(s, 'sep_oil', r, v > 0); } },
    { key: 'water_rate', label: 'Water rate', group: 'Rates', cat: 'liquidRate', min: 0, max: 20000,
      get: function (s) { return nz(g(s, ['rates', 'water_bpd'])); },
      set: function (s, v) { var r = ratioOf(v, s.rates.water_bpd); s.rates.water_bpd = v; lineSet(s, 'sep_water', r, v > 0); } },
    { key: 'flare_rate', label: 'Flare gas rate', group: 'Flare', cat: 'gasRate', min: 0, max: 50,
      get: function (s) { return nz(g(s, ['nodes', 'flare', 'qMMscfd'])); },
      set: function (s, v) { s.nodes.flare.qMMscfd = v; s.nodes.flare.flame = v > 0.01 ? 1 : 0; } },
    { key: 'flare_p', label: 'Flare header pressure', group: 'Flare', cat: 'pressureG', min: 0, max: 100,
      get: function (s) { return nz(g(s, ['nodes', 'flare', 'P'])); }, set: function (s, v) { s.nodes.flare.P = v; } },
    { key: 'surge_p', label: 'Surge tank pressure', group: 'Surge tank', cat: 'pressureG', min: 0, max: 100,
      get: function (s) { return nz(g(s, ['surge', 'P'])); }, set: function (s, v) { s.surge.P = v; s.nodes.surge.P = v; } },
    { key: 'surge_lvl_a', label: 'Surge tank level — compartment A', group: 'Surge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['surge', 'comps', 0, 'frac'])); }, set: function (s, v) { if (s.surge.comps[0]) s.surge.comps[0].frac = clamp(v / 100, 0, 1); } },
    { key: 'surge_lvl_b', label: 'Surge tank level — compartment B', group: 'Surge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['surge', 'comps', 1, 'frac'])); }, set: function (s, v) { if (s.surge.comps[1]) s.surge.comps[1].frac = clamp(v / 100, 0, 1); } },
    { key: 'xv201a', label: 'Surge inlet valve XV-201A open', group: 'Surge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['surge', 'comps', 0, 'inlet'])); }, set: function (s, v) { if (s.surge.comps[0]) s.surge.comps[0].inlet = !!v; } },
    { key: 'xv201b', label: 'Surge inlet valve XV-201B open', group: 'Surge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['surge', 'comps', 1, 'inlet'])); }, set: function (s, v) { if (s.surge.comps[1]) s.surge.comps[1].inlet = !!v; } },
    { key: 'pump_running', label: 'Transfer pump P-201 running', group: 'Surge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['surge', 'pump', 'on'])); },
      set: function (s, v) { s.surge.pump.on = !!v; lineSet(s, 'surge_gauge', null, !!v); if (!v && s.segs[5]) { s.segs[5].vel = 0; s.segs[5].flowing = false; } } },
    { key: 'gauge_lvl_a', label: 'Gauge tank level — T-301A', group: 'Gauge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['gauge', 'tanks', 0, 'frac'])); }, set: function (s, v) { if (s.gauge.tanks[0]) s.gauge.tanks[0].frac = clamp(v / 100, 0, 1.05); } },
    { key: 'gauge_lvl_b', label: 'Gauge tank level — T-301B', group: 'Gauge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['gauge', 'tanks', 1, 'frac'])); }, set: function (s, v) { if (s.gauge.tanks[1]) s.gauge.tanks[1].frac = clamp(v / 100, 0, 1.05); } },
    { key: 'xv301a', label: 'Gauge tank inlet XV-301A open', group: 'Gauge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['gauge', 'tanks', 0, 'inlet'])); }, set: function (s, v) { if (s.gauge.tanks[0]) s.gauge.tanks[0].inlet = !!v; } },
    { key: 'xv301b', label: 'Gauge tank inlet XV-301B open', group: 'Gauge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['gauge', 'tanks', 1, 'inlet'])); }, set: function (s, v) { if (s.gauge.tanks[1]) s.gauge.tanks[1].inlet = !!v; } }
];
var VAR_BY_KEY = {};
VARS.forEach(function (v) { VAR_BY_KEY[v.key] = v; v.unit = v.unitLabel || (UNITS[v.cat] ? UNITS[v.cat].canon : ''); });
function varsFromState(st) {
    var out = {};
    VARS.forEach(function (v) { var x = null; try { x = st ? v.get(st) : null; } catch (e) { x = null; } out[v.key] = x == null ? null : x; });
    return out;
}
// applyVarsToState(base, values{key:canonical}) → a deep copy of the snapshot with the values applied
// (unmapped / null keys keep the base value). Used to animate the 3D / 2D views from live tags.
function applyVarsToState(base, values) {
    var s = clone(base || {});
    if (!s.nodes || !s.sep || !s.surge || !s.gauge || !s.rates || !s.esd || !s.segs || !s.lines) return s;
    // rates first (they scale the line velocities), valves / ESD last (they can zero flows)
    var order = VARS.slice().sort(function (a, b) { var ra = a.kind === 'bool' ? 2 : /rate/.test(a.key) ? 0 : 1, rb = b.kind === 'bool' ? 2 : /rate/.test(b.key) ? 0 : 1; return ra - rb; });
    order.forEach(function (v) {
        var x = values ? values[v.key] : null;
        if (x == null || (typeof x === 'number' && !isFinite(x))) return;
        try { v.set(s, x); } catch (e) {}
    });
    return s;
}

// ─── configuration ───────────────────────────────────────────────────────────
function defaultDevice(o) {
    o = o || {};
    return { id: o.id || uid('dev'), name: 'Device 1', transport: 'sim', host: '192.168.1.10', port: 502, url: 'ws://127.0.0.1:8502',
        unit: 1, pollMs: 1000, timeoutMs: 1000, retries: 1, order: 'ABCD', maxGap: 4, enabled: true,
        baud: 19200, parity: 'even', dataBits: 8, stopBits: 1 };
}
function defaultTag(o) {
    o = o || {};
    return { id: o.id || uid('tag'), name: 'TAG_1', desc: '', device: '', table: 'holding', address: 0, type: 'float32', order: '',
        scale: { mode: 'none', rawMin: 0, rawMax: 65535, engMin: 0, engMax: 100, gain: 1, offset: 0 },
        unit: '', alarm: { lolo: null, lo: null, hi: null, hihi: null }, deadband: 0, link: '', log: true, logDeadband: 0, logMinMs: 0 };
}
function defaultConfig() {
    return { v: 1, base: 0, writesEnabled: false, paused: false, devices: [], tags: [],
        sim: { source: 'sim', speed: 1, manual: {} } };
}
// Virtual-slave register map (unit 1). Most analogues are FLOAT32 ABCD input registers;
// a few show scaling (×10 gain, 0-10000 → 0-100 % linear), a word-swapped float (CDAB)
// and a metric unit (BHP in barg) so the demo exercises every conversion path.
var DEMO_MAP = [
    ['WHP', 'whp', 'input', 0, 'float32', 'ABCD', null, 'psig', { hi: 3300, hihi: 3500 }, 5],
    ['CHOKE_DN_P', 'choke_dn_p', 'input', 2, 'float32', 'ABCD', null, 'psig', null, 1],
    ['HTR_OUT_T', 'heater_t', 'input', 4, 'float32', 'ABCD', null, '°F', { lo: 100 }, 1],
    ['SEP_T', 'sep_t', 'input', 6, 'float32', 'ABCD', null, '°F', null, 1],
    ['GAS_RATE', 'gas_rate', 'input', 8, 'float32', 'ABCD', null, 'MMSCFD', null, 0.05],
    ['OIL_RATE', 'oil_rate', 'input', 10, 'float32', 'ABCD', null, 'STB/d', null, 5],
    ['WATER_RATE', 'water_rate', 'input', 12, 'float32', 'ABCD', null, 'BPD', null, 5],
    ['FLARE_RATE', 'flare_rate', 'input', 14, 'float32', 'ABCD', null, 'MMSCFD', null, 0.05],
    ['FLARE_HDR_P', 'flare_p', 'input', 16, 'float32', 'ABCD', null, 'psig', null, 0.2],
    ['SURGE_P', 'surge_p', 'input', 18, 'float32', 'ABCD', null, 'psig', { hi: 32, hihi: 40 }, 0.2],
    ['BHP_GAUGE', 'bhp', 'input', 20, 'float32', 'ABCD', null, 'barg', null, 0.05],
    ['BHT_GAUGE', 'bht', 'input', 22, 'float32', 'ABCD', null, '°F', null, 0.1],
    ['LCV102_POS', 'lcv_oil', 'input', 24, 'float32', 'ABCD', null, '%', null, 0],
    ['LCV101_POS', 'lcv_water', 'input', 26, 'float32', 'ABCD', null, '%', null, 0],
    ['PCV101_POS', 'pcv_sep', 'input', 28, 'float32', 'ABCD', null, '%', null, 0],
    ['SEP_P', 'sep_p', 'input', 40, 'float32', 'CDAB', null, 'psig', { lo: 120, hi: 165, hihi: 180 }, 0.5],
    ['WHT', 'wht', 'input', 100, 'uint16', 'ABCD', { mode: 'gain', gain: 0.1, offset: 0 }, '°F', null, 0.2],
    ['CHOKE_SIZE', 'choke_bean', 'input', 101, 'uint16', 'ABCD', null, '1/64 in', null, 0],
    ['SEP_LIQ_LVL', 'sep_liq_lvl', 'input', 110, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 75, hihi: 85 }, 0.5],
    ['SEP_INT_LVL', 'sep_int_lvl', 'input', 111, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', null, 0.5],
    ['SEP_OIL_LVL', 'sep_oil_lvl', 'input', 112, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', null, 0.5],
    ['SURGE_LVL_A', 'surge_lvl_a', 'input', 113, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 70, hihi: 90 }, 0.5],
    ['SURGE_LVL_B', 'surge_lvl_b', 'input', 114, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 70, hihi: 90 }, 0.5],
    ['GAUGE_LVL_A', 'gauge_lvl_a', 'input', 115, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 90, hihi: 97 }, 0.5],
    ['GAUGE_LVL_B', 'gauge_lvl_b', 'input', 116, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 90, hihi: 97 }, 0.5],
    ['SDV101_OPEN', 'esd_open', 'discrete', 0, 'bool', '', null, '', null, 0],
    ['ESD_TRIPPED', 'esd_tripped', 'discrete', 1, 'bool', '', null, '', null, 0],
    ['P201_RUN', 'pump_running', 'discrete', 2, 'bool', '', null, '', null, 0],
    ['XV201A_OPEN', 'xv201a', 'discrete', 3, 'bool', '', null, '', null, 0],
    ['XV201B_OPEN', 'xv201b', 'discrete', 4, 'bool', '', null, '', null, 0],
    ['XV301A_OPEN', 'xv301a', 'discrete', 5, 'bool', '', null, '', null, 0],
    ['XV301B_OPEN', 'xv301b', 'discrete', 6, 'bool', '', null, '', null, 0],
    ['HTR_BYPASS', 'heater_bypass', 'discrete', 7, 'bool', '', null, '', null, 0],
    ['ESD_TRIP_CMD', '', 'coil', 0, 'bool', '', null, '', null, 0],
    ['ESD_RESET_CMD', '', 'coil', 1, 'bool', '', null, '', null, 0],
    ['SEP_P_SP', '', 'holding', 0, 'float32', 'ABCD', null, 'psig', null, 0]
];
var DEMO_DESC = { ESD_TRIP_CMD: 'Momentary: 1 trips SDV-101 in the virtual slave', ESD_RESET_CMD: 'Momentary: 1 resets the ESD in the virtual slave',
    SEP_P_SP: 'Writable holding register (stored by the virtual slave only)', BHP_GAUGE: 'Demo BHP = WHP + 2,400 psi (fixed 0.30 psi/ft × 8,000 ft column; not a calculation)' };
function demoConfig() {
    var c = defaultConfig(), d = defaultDevice({ id: 'dev_virtual' });
    d.name = 'Virtual slave'; d.transport = 'sim'; d.pollMs = 1000; d.timeoutMs = 500; d.retries = 1;
    c.devices.push(d);
    DEMO_MAP.forEach(function (m, i) {
        var t = defaultTag({ id: 'tag_demo_' + i });
        t.name = m[0]; t.link = m[1]; t.device = d.id; t.table = m[2]; t.address = m[3]; t.type = m[4]; t.order = m[5] || '';
        if (m[6]) { for (var k in m[6]) t.scale[k] = m[6][k]; }
        t.unit = m[7]; if (m[8]) for (var a in m[8]) t.alarm[a] = m[8][a];
        t.deadband = m[9] || 0;
        var V = VAR_BY_KEY[m[1]]; t.desc = DEMO_DESC[m[0]] || (V ? V.label : '');
        c.tags.push(t);
    });
    return c;
}
var TYPE_KEYS = Object.keys(M.TYPES), TABLE_KEYS = Object.keys(M.TABLES);
// normalizeConfig(raw) → { config, errors:[string], tagErrors:{tagId:[msg]} }
function normalizeConfig(raw) {
    var errors = [], tagErrors = {}, c = defaultConfig();
    if (!raw || typeof raw !== 'object') return { config: c, errors: raw == null ? [] : ['Config is not an object'], tagErrors: tagErrors };
    c.base = +raw.base === 1 ? 1 : 0;
    c.writesEnabled = raw.writesEnabled === true;
    c.paused = raw.paused === true;
    var sim = raw.sim || {};
    c.sim.source = /^(sim|waveform|manual)$/.test(sim.source) ? sim.source : 'sim';
    c.sim.speed = [1, 10, 60].indexOf(+sim.speed) >= 0 ? +sim.speed : 1;
    if (sim.manual && typeof sim.manual === 'object') Object.keys(sim.manual).forEach(function (k) { if (VAR_BY_KEY[k] && isNum(+sim.manual[k])) c.sim.manual[k] = +sim.manual[k]; });
    var ids = {};
    (Array.isArray(raw.devices) ? raw.devices : []).slice(0, 32).forEach(function (d0, i) {
        if (!d0 || typeof d0 !== 'object') return;
        var d = defaultDevice({ id: /^[\w-]{1,40}$/.test(d0.id) && !ids[d0.id] ? d0.id : null });
        ids[d.id] = 1;
        d.name = str(d0.name || ('Device ' + (i + 1)), 40);
        d.transport = TRANSPORTS[d0.transport] ? d0.transport : 'sim';
        d.host = str(d0.host || '', 120).trim();
        d.port = clamp(Math.round(num(d0.port, 502)), 1, 65535);
        d.url = str(d0.url || 'ws://127.0.0.1:8502', 200).trim();
        if (!/^wss?:\/\//i.test(d.url)) { errors.push(d.name + ': bridge URL must start with ws:// or wss://'); d.url = 'ws://127.0.0.1:8502'; }
        d.unit = clamp(Math.round(num(d0.unit, 1)), 0, 255);
        d.pollMs = clamp(Math.round(num(d0.pollMs, 1000)), POLL_MIN, POLL_MAX);
        d.timeoutMs = clamp(Math.round(num(d0.timeoutMs, 1000)), 50, 30000);
        d.retries = clamp(Math.round(num(d0.retries, 1)), 0, 5);
        d.order = M.normOrder(d0.order);
        d.maxGap = clamp(Math.round(num(d0.maxGap, 4)), 0, 100);
        d.enabled = d0.enabled !== false;
        d.baud = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].indexOf(+d0.baud) >= 0 ? +d0.baud : 19200;
        d.parity = /^(none|even|odd)$/.test(d0.parity) ? d0.parity : 'even';
        d.dataBits = +d0.dataBits === 7 ? 7 : 8;
        d.stopBits = +d0.stopBits === 2 ? 2 : 1;
        if ((d.transport === 'ws' || d.transport === 'ios') && !d.host) errors.push(d.name + ': host / IP address is required');
        if (d.transport === 'serial' && (d.unit < 1 || d.unit > 247)) errors.push(d.name + ': RTU unit id must be 1-247');
        c.devices.push(d);
    });
    var devIds = {}; c.devices.forEach(function (d) { devIds[d.id] = d; });
    var names = {}, tids = {};
    (Array.isArray(raw.tags) ? raw.tags : []).slice(0, 2000).forEach(function (t0, i) {
        if (!t0 || typeof t0 !== 'object') return;
        var t = defaultTag({ id: /^[\w-]{1,40}$/.test(t0.id) && !tids[t0.id] ? t0.id : null }), errs = [];
        tids[t.id] = 1;
        t.name = str(t0.name || ('TAG_' + (i + 1)), 40).trim() || ('TAG_' + (i + 1));
        t.desc = str(t0.desc, 120);
        t.device = devIds[t0.device] ? t0.device : (c.devices[0] ? c.devices[0].id : '');
        if (!devIds[t0.device]) errs.push('device not found');
        t.table = M.TABLES[t0.table] ? t0.table : 'holding';
        t.type = M.TYPES[t0.type] ? t0.type : 'float32';
        if (M.TABLES[t.table].bits) t.type = 'bool';
        t.order = t0.order ? M.normOrder(t0.order) : '';
        t.address = Math.round(num(t0.address, 0));
        var pa = M.protocolAddress(t.address, t.table, c.base);
        if (!isNum(pa)) errs.push('address ' + t.address + ' is not valid for ' + (c.base ? '1-based' : '0-based') + ' addressing');
        else if (pa + (M.TABLES[t.table].bits ? 1 : M.regCount(t.type)) > 65536) errs.push('address + size exceeds 65535');
        var sc = t0.scale || {};
        t.scale = { mode: /^(none|linear|gain)$/.test(sc.mode) ? sc.mode : 'none', rawMin: num(sc.rawMin, 0), rawMax: num(sc.rawMax, 65535),
            engMin: num(sc.engMin, 0), engMax: num(sc.engMax, 100), gain: num(sc.gain, 1), offset: num(sc.offset, 0) };
        if (t.scale.mode === 'linear' && t.scale.rawMax === t.scale.rawMin) errs.push('linear scaling needs raw max ≠ raw min');
        if (t.scale.mode === 'gain' && t.scale.gain === 0) errs.push('gain must not be 0');
        if (t.type === 'bool') t.scale.mode = 'none';
        t.unit = str(t0.unit, 20).trim();
        var al = t0.alarm || {};
        t.alarm = { lolo: optNum(al.lolo), lo: optNum(al.lo), hi: optNum(al.hi), hihi: optNum(al.hihi) };
        var A = t.alarm;
        if ((A.hi != null && A.hihi != null && A.hihi < A.hi) || (A.lo != null && A.lolo != null && A.lolo > A.lo) || (A.lo != null && A.hi != null && A.lo >= A.hi)) errs.push('alarm limits must satisfy LOLO ≤ LO < HI ≤ HIHI');
        t.deadband = Math.max(0, num(t0.deadband, 0));
        t.link = VAR_BY_KEY[t0.link] ? t0.link : '';
        if (t.link && !unitFits(t.unit, VAR_BY_KEY[t.link].cat)) errs.push('unit "' + t.unit + '" cannot be converted to ' + VAR_BY_KEY[t.link].unit + ' for ' + VAR_BY_KEY[t.link].label);
        if (t.link && VAR_BY_KEY[t.link].kind === 'bool' && t.type !== 'bool' && M.TABLES[t.table].bits !== true) { /* register used as a status word: non-zero = true */ }
        t.log = t0.log !== false;
        t.logDeadband = Math.max(0, num(t0.logDeadband, 0));
        t.logMinMs = clamp(Math.round(num(t0.logMinMs, 0)), 0, 3600000);
        if (names[t.name.toLowerCase()]) errs.push('duplicate tag name');
        names[t.name.toLowerCase()] = 1;
        if (errs.length) { tagErrors[t.id] = errs; errors.push(t.name + ': ' + errs.join('; ')); }
        c.tags.push(t);
    });
    return { config: c, errors: errors, tagErrors: tagErrors };
}
var _cache = { raw: null, cfg: null };
function getConfig() {
    var s = ls(), raw = null;
    try { raw = s ? s.getItem(STORE_KEY) : null; } catch (e) { raw = null; }
    if (raw === _cache.raw && _cache.cfg) return clone(_cache.cfg);
    var obj = null; try { obj = raw ? JSON.parse(raw) : null; } catch (e) { obj = null; }
    _cache = { raw: raw, cfg: normalizeConfig(obj).config };
    return clone(_cache.cfg);
}
// saveConfig(cfg) → {ok, errors}. Stores the normalised config, rebuilds a running station,
// fires 'wts:modbus-config-changed'.
function saveConfig(cfg, opts) {
    var n = normalizeConfig(cfg), s = ls(), txt = JSON.stringify(n.config);
    try { if (s) s.setItem(STORE_KEY, txt); } catch (e) { return { ok: false, errors: ['Could not save: ' + (e && e.message)] }; }
    _cache = { raw: txt, cfg: n.config };
    if (!(opts && opts.keepStation)) rebuildStation();
    fire('wts:modbus-config-changed', { config: clone(n.config) });
    return { ok: true, errors: n.errors, tagErrors: n.tagErrors, config: clone(n.config) };
}
function setPaused(p) {
    var c = getConfig(); c.paused = !!p;
    saveConfig(c, { keepStation: true });
    if (_station) { if (p) _station.pause(); else _station.resume(); }
    return !!p;
}
function getTags() {
    var c = getConfig(), dn = {};
    c.devices.forEach(function (d) { dn[d.id] = d.name; });
    return c.tags.map(function (t) {
        var V = VAR_BY_KEY[t.link];
        return { name: t.name, device: dn[t.device] || '', unit: t.unit || (V ? V.unit : ''), desc: t.desc || (V ? V.label : ''), linkedVar: t.link || null,
            engMin: t.scale.mode === 'linear' ? t.scale.engMin : (V && isNum(V.min) ? toFromCanon(V.min, t.unit, V.cat) : null),
            engMax: t.scale.mode === 'linear' ? t.scale.engMax : (V && isNum(V.max) ? toFromCanon(V.max, t.unit, V.cat) : null) };
    });
}
function toFromCanon(v, unit, cat) { var x = fromCanonical(v, unit, cat); return isNum(x) ? x : null; }

// ─── CSV (RFC 4180 quoting) ──────────────────────────────────────────────────
var CSV_COLS = ['name', 'device', 'table', 'address', 'type', 'order', 'scale_mode', 'raw_min', 'raw_max', 'eng_min', 'eng_max', 'gain', 'offset',
    'unit', 'lolo', 'lo', 'hi', 'hihi', 'deadband', 'link', 'log', 'log_deadband', 'log_min_ms', 'desc'];
function csvCell(v) { var s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false, s = String(text || '');
    for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
        if (ch === '"') q = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r[0] && r[0].trim()); });
}
function tagsToCsv(cfg) {
    var dn = {}; (cfg.devices || []).forEach(function (d) { dn[d.id] = d.name; });
    var lines = [CSV_COLS.join(',')];
    (cfg.tags || []).forEach(function (t) {
        var A = t.alarm || {}, S = t.scale || {};
        lines.push([t.name, dn[t.device] || '', t.table, t.address, t.type, t.order, S.mode, S.rawMin, S.rawMax, S.engMin, S.engMax, S.gain, S.offset,
            t.unit, A.lolo, A.lo, A.hi, A.hihi, t.deadband, t.link, t.log !== false ? 1 : 0, t.logDeadband, t.logMinMs, t.desc].map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
}
// tagsFromCsv(text, cfg) → { tags, errors } (devices matched by name, else the first device)
function tagsFromCsv(text, cfg) {
    var rows = parseCsv(text), errors = [], tags = [];
    if (!rows.length) return { tags: tags, errors: ['CSV is empty'] };
    var hdr = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
    if (hdr.indexOf('name') < 0 || hdr.indexOf('address') < 0) return { tags: tags, errors: ['CSV header must include at least "name" and "address"'] };
    var byName = {}; (cfg.devices || []).forEach(function (d) { byName[d.name.toLowerCase()] = d.id; });
    for (var r = 1; r < rows.length; r++) {
        var o = {}; hdr.forEach(function (h, i) { o[h] = rows[r][i] == null ? '' : rows[r][i]; });
        var dev = byName[String(o.device || '').toLowerCase()] || (cfg.devices[0] ? cfg.devices[0].id : '');
        if (o.device && !byName[String(o.device).toLowerCase()]) errors.push('Row ' + r + ': device "' + o.device + '" not found — using ' + (cfg.devices[0] ? cfg.devices[0].name : 'none'));
        tags.push({ name: o.name, device: dev, table: o.table || 'holding', address: o.address, type: o.type || 'float32', order: o.order || '',
            scale: { mode: o.scale_mode || 'none', rawMin: o.raw_min, rawMax: o.raw_max, engMin: o.eng_min, engMax: o.eng_max, gain: o.gain, offset: o.offset },
            unit: o.unit, alarm: { lolo: o.lolo, lo: o.lo, hi: o.hi, hihi: o.hihi }, deadband: o.deadband, link: o.link,
            log: !(o.log === '0' || /^false$/i.test(o.log)), logDeadband: o.log_deadband, logMinMs: o.log_min_ms, desc: o.desc });
    }
    return { tags: tags, errors: errors };
}

// ─── block-read planning ─────────────────────────────────────────────────────
// planBlocks(items[{table, addr, count, ref}], {maxGap, maxRegs, maxBits}) →
//   [{table, fn, start, count, items:[{ref, offset, count}]}]
// Contiguous (or ≤ maxGap apart) addresses of the same table are merged into one
// read, up to the protocol limits (125 registers / 2000 bits, V1.1b3 §6.1-6.4).
function planBlocks(items, o) {
    o = o || {};
    var maxGap = Math.max(0, o.maxGap == null ? 4 : +o.maxGap);
    var byT = {};
    (items || []).forEach(function (it) { if (it && M.TABLES[it.table] && isNum(it.addr)) (byT[it.table] = byT[it.table] || []).push(it); });
    var out = [];
    TABLE_KEYS.forEach(function (tb) {
        var list = byT[tb]; if (!list) return;
        var T = M.TABLES[tb], lim = T.bits ? Math.min(o.maxBits || M.LIMITS.readBits, M.LIMITS.readBits) : Math.min(o.maxRegs || M.LIMITS.readRegs, M.LIMITS.readRegs);
        list = list.slice().sort(function (a, b) { return a.addr - b.addr || b.count - a.count; });
        var cur = null;
        list.forEach(function (it) {
            var cnt = Math.max(1, it.count || 1), end = it.addr + cnt;
            if (cur && it.addr <= cur.start + cur.count + maxGap && Math.max(cur.start + cur.count, end) - cur.start <= lim) {
                cur.count = Math.max(cur.start + cur.count, end) - cur.start;
            } else {
                cur = { table: tb, fn: T.read, start: it.addr, count: cnt, items: [] };
                out.push(cur);
            }
            cur.items.push({ ref: it.ref, offset: it.addr - cur.start, count: cnt });
        });
    });
    return out;
}

// ─── alarms (ANSI/ISA-18.2-2016 state model: UNACK → ACK → normal; RTN-unack) ─
// alarmLevel(v, {lolo, lo, hi, hihi}, deadband, prev) → 'HIHI'|'HI'|'LO'|'LOLO'|null
// A level clears only once the value is back inside its limit by the deadband.
function alarmLevel(v, a, db, prev) {
    if (!a || v == null || !isNum(v)) return prev || null;
    db = Math.max(0, +db || 0);
    function high(lim, keep) { return lim != null && (v >= lim || (keep && v > lim - db)); }
    function low(lim, keep) { return lim != null && (v <= lim || (keep && v < lim + db)); }
    if (high(a.hihi, prev === 'HIHI')) return 'HIHI';
    if (high(a.hi, prev === 'HI' || prev === 'HIHI')) return 'HI';
    if (low(a.lolo, prev === 'LOLO')) return 'LOLO';
    if (low(a.lo, prev === 'LO' || prev === 'LOLO')) return 'LO';
    return null;
}
// ALARM / WARN / INFO: generic levels (Form-data mode maps the simulator's own alarms onto them).
var LEVEL_SEV = { HIHI: 'alarm', LOLO: 'alarm', HI: 'warn', LO: 'warn', COMMS: 'alarm', BAD: 'warn', ALARM: 'alarm', WARN: 'warn', INFO: 'info' };
var LEVEL_RANK = { INFO: 0, HI: 1, LO: 1, BAD: 1, WARN: 1, HIHI: 2, LOLO: 2, COMMS: 2, ALARM: 2 };
function createAlarmManager(o) {
    o = o || {};
    var A = makeEmitterLocal(), map = {}, events = [], maxEvents = o.maxEvents || 500;
    function log(t, msg, kind, id) { events.push({ t: t, msg: msg, kind: kind || 'evt', id: id || null }); if (events.length > maxEvents) events.splice(0, events.length - maxEvents); A.emit('event', events[events.length - 1]); }
    // update(id, level|null, {t, tag, device, value, limit, msg})
    A.update = function (id, level, info) {
        info = info || {};
        var t = info.t || now(), a = map[id];
        if (level) {
            if (!a || !a.active || LEVEL_RANK[level] > LEVEL_RANK[a.level]) {
                var re = !!(a && a.active);
                map[id] = a = { id: id, tag: info.tag || '', device: info.device || '', level: level, sev: LEVEL_SEV[level] || 'warn',
                    state: 'UNACK', active: true, tOn: re ? a.tOn : t, tOff: null, value: info.value, limit: info.limit, msg: info.msg || '' };
                log(t, (info.tag || id) + ' ' + level + (info.msg ? ' — ' + info.msg : ''), a.sev, id);
                A.emit('change', a);
            } else {
                if (a.level !== level) { a.level = level; a.sev = LEVEL_SEV[level]; a.limit = info.limit; log(t, (info.tag || id) + ' now ' + level, 'evt', id); }
                a.value = info.value; if (info.msg) a.msg = info.msg;
            }
        } else if (a && a.active) {
            a.active = false; a.tOff = t;
            log(t, (a.tag || id) + ' ' + a.level + ' returned to normal', 'rtn', id);
            if (a.state === 'ACK') delete map[id]; else a.state = 'RTN';
            A.emit('change', a);
        }
    };
    A.ack = function (id, t) {
        var a = map[id]; if (!a) return false;
        if (a.state === 'RTN') delete map[id]; else if (a.state === 'UNACK') a.state = 'ACK'; else return false;
        log(t || now(), 'Acknowledged ' + (a.tag || id) + ' ' + a.level, 'ack', id);
        A.emit('change', a);
        return true;
    };
    A.ackAll = function (t) { var n = 0; Object.keys(map).forEach(function (id) { if (map[id].state !== 'ACK' && A.ack(id, t)) n++; }); return n; };
    A.list = function () { return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return (b.active - a.active) || ((LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0)) || (b.tOn - a.tOn); }); };
    A.get = function (id) { return map[id] || null; };
    A.events = function () { return events.slice(); };
    A.log = log;
    A.counts = function () { var c = { unack: 0, active: 0, total: 0 }; Object.keys(map).forEach(function (k) { c.total++; if (map[k].active) c.active++; if (map[k].state !== 'ACK') c.unack++; }); return c; };
    return A;
}
function makeEmitterLocal() { return M.makeEmitter({}); }

// ─── history rings (trends): fine tier + 10 s coarse tier (12 h) ──────────────
function makeRing(cap) {
    var t = new Float64Array(cap), v = new Float64Array(cap), n = 0, i = 0;
    return {
        push: function (tt, vv) { t[i] = tt; v[i] = vv == null ? NaN : vv; i = (i + 1) % cap; if (n < cap) n++; },
        range: function (t0) {
            var ot = [], ov = [], s = (i - n + cap) % cap;
            for (var k = 0; k < n; k++) { var p = (s + k) % cap; if (t[p] >= t0) { ot.push(t[p]); ov.push(v[p]); } }
            return { t: ot, v: ov };
        },
        size: function () { return n; },
        first: function () { return n ? t[(i - n + cap) % cap] : null; }
    };
}
function makeHistory(o) {
    o = o || {};
    var fine = makeRing(o.fine || 7200), coarse = makeRing(o.coarse || 4320), lastC = -Infinity, step = o.coarseMs || 10000;
    return {
        push: function (t, v) { fine.push(t, v); if (t - lastC >= step) { coarse.push(t, v); lastC = t; } },
        // fine samples where the fine ring reaches back far enough, older coarse samples before that
        range: function (t0) {
            var f = fine.first(), fr = fine.range(t0);
            if (f == null || f <= t0) return fr;
            var cr = coarse.range(t0), ot = [], ov = [];
            for (var i = 0; i < cr.t.length; i++) if (cr.t[i] < f) { ot.push(cr.t[i]); ov.push(cr.v[i]); }
            return { t: ot.concat(fr.t), v: ov.concat(fr.v) };
        }
    };
}

// ─── historian bridge ────────────────────────────────────────────────────────
// publishSamples([{tag, device, t, v, q, raw, unit}]) → WTS_historian.record(batch) if present,
// then document 'wts:modbus-samples' (detail = the batch).
function publishSamples(batch) {
    if (!batch || !batch.length) return 0;
    var H = G.WTS_historian;
    if (H && typeof H.record === 'function') { try { H.record(batch); } catch (e) { if (typeof console !== 'undefined') console.warn('[modbus] historian.record failed', e); } }
    fire('wts:modbus-samples', batch);
    return batch.length;
}

// ─── transports for a device ─────────────────────────────────────────────────
function makeTransport(dev, env) {
    env = env || {};
    if (env.transportFor) { var tr = env.transportFor(dev); if (tr) return tr; }
    switch (dev.transport) {
        case 'ws': return M.transports.webSocket({ url: dev.url, host: dev.host, port: dev.port });
        case 'serial': return M.transports.webSerial({ baud: dev.baud, parity: dev.parity, dataBits: dev.dataBits, stopBits: dev.stopBits, usbVendorId: dev.usbVendorId, usbProductId: dev.usbProductId });
        case 'ios': return M.transports.nativeTcp({ host: dev.host, port: dev.port, timeoutMs: dev.timeoutMs * 3 });
        default: return M.transports.sim({ slave: env.slave || virtualSlave, framing: dev.framing === 'rtu' ? 'rtu' : 'tcp' });
    }
}

// ─── station (polling scheduler) ─────────────────────────────────────────────
// createStation(config, env{now, transportFor, slave, setTimeout, clearTimeout}) →
//   start / stop / pause / resume / pollNow / testRead / write / values / getVar / alarms / history
// Timers exist only while started: one poll (or reconnect) timer per device plus the
// client's per-request timeout. stop() clears everything.
function createStation(cfgIn, env) {
    env = env || {};
    var S = M.makeEmitter({});
    var cfg = normalizeConfig(cfgIn).config;
    var tnow = env.now || now;
    var setT = env.setTimeout || function (f, ms) { return G.setTimeout(f, ms); };
    var clrT = env.clearTimeout || function (id) { G.clearTimeout(id); };
    var running = false, paused = !!cfg.paused, gen = 0;
    var alarms = createAlarmManager();
    var devs = {}, vals = {}, hist = {}, tagsById = {}, lastLog = {};
    cfg.devices.forEach(function (d) {
        devs[d.id] = { dev: d, status: 'idle', client: null, transport: null, timer: null, busy: false, fails: 0, lastOk: null, lastErr: null, lastPollMs: null, blocks: [], tags: [] };
    });
    cfg.tags.forEach(function (t) {
        tagsById[t.id] = t;
        var D = devs[t.device]; if (!D) return;
        var addr = M.protocolAddress(t.address, t.table, cfg.base);
        if (!isNum(addr)) return;
        D.tags.push(t);
        t._addr = addr; t._count = M.TABLES[t.table].bits ? 1 : M.regCount(t.type);
        vals[t.id] = { value: null, raw: null, q: 'init', ts: null, err: null, canon: null, unitErr: false, level: null };
        hist[t.id] = makeHistory();
    });
    Object.keys(devs).forEach(function (id) {
        var D = devs[id];
        D.blocks = planBlocks(D.tags.map(function (t) { return { table: t.table, addr: t._addr, count: t._count, ref: t }; }), { maxGap: D.dev.maxGap });
    });
    function staleMs(D) { return Math.max(3 * D.dev.pollMs, D.dev.pollMs + D.dev.timeoutMs * (D.dev.retries + 1)); }
    function setStatus(D, st, err) {
        if (D.status === st && D.lastErr === (err || null)) return;
        D.status = st; if (err !== undefined) D.lastErr = err || null;
        // COMMS alarm raised on error, cleared only once the device answers again (no flapping while reconnecting)
        if (st === 'error') alarms.update('dev:' + D.dev.id, 'COMMS', { t: tnow(), tag: D.dev.name, device: D.dev.name, msg: err || 'communication failure' });
        else if (st === 'online' || st === 'paused') alarms.update('dev:' + D.dev.id, null, { t: tnow(), tag: D.dev.name });
        S.emit('status', { device: D.dev.id, status: st, error: D.lastErr });
    }
    function schedule(D, ms, fn) {
        if (D.timer) { clrT(D.timer); D.timer = null; }
        if (!running) return;
        var g0 = gen;
        D.timer = setT(function () { D.timer = null; if (running && g0 === gen) fn(D); }, Math.max(0, ms));
    }
    function connect(D) {
        if (!running || D.client || !D.dev.enabled || !D.tags.length) return Promise.resolve(false);
        setStatus(D, 'connecting');
        var tr;
        try { tr = makeTransport(D.dev, env); } catch (e) { setStatus(D, 'error', e.message); return Promise.resolve(false); }
        D.transport = tr;
        var g0 = gen;
        return Promise.resolve().then(function () { return tr.open(); }).then(function () {
            if (!running || g0 !== gen) { try { tr.close(); } catch (e) {} return false; }
            D.client = M.createClient(tr, { timeout: D.dev.timeoutMs, retries: D.dev.retries, framing: tr.framing, now: tnow, setTimeout: setT, clearTimeout: clrT });
            D.client.on('close', function () { if (D.client) { D.client = null; markAll(D, 'bad', 'connection closed'); setStatus(D, 'error', 'Connection closed'); reconnect(D); } });
            D.fails = 0;
            setStatus(D, paused ? 'paused' : 'online', null);
            if (!paused) schedule(D, 0, poll);
            return true;
        }, function (e) {
            if (g0 !== gen) return false;
            D.transport = null;
            setStatus(D, 'error', e && e.message || String(e));
            markAll(D, 'bad', e && e.message);
            reconnect(D);
            return false;
        });
    }
    function reconnect(D) {
        if (!running) return;
        D.fails++;
        var ms = Math.max(D.dev.pollMs, Math.min(30000, 1000 * Math.pow(2, Math.min(D.fails - 1, 5))));
        schedule(D, ms, connect);
    }
    function closeDev(D) {
        if (D.timer) { clrT(D.timer); D.timer = null; }
        var c = D.client; D.client = null;
        if (c) { try { c.close(); } catch (e) {} }
        else if (D.transport) { try { D.transport.close(); } catch (e) {} }
        D.transport = null; D.busy = false;
    }
    function markAll(D, q, err) {
        var t = tnow();
        D.tags.forEach(function (tg) { var r = vals[tg.id]; if (!r) return; r.q = q; r.err = err || null; r.tsBad = t; });
    }
    function setValue(tg, raw, eng, t) {
        var r = vals[tg.id]; if (!r) return;
        r.raw = raw; r.ts = t; r.q = 'good'; r.err = null;
        if (r.value == null || !isNum(r.value) || !(tg.deadband > 0) || Math.abs(eng - r.value) >= tg.deadband || !isNum(eng)) r.value = eng;
        var V = VAR_BY_KEY[tg.link];
        if (V) {
            var c = V.kind === 'bool' ? (r.value ? 1 : 0) : toCanonical(r.value, tg.unit, V.cat);
            r.unitErr = !(c == null || isNum(c)); r.canon = r.unitErr ? null : c;
        }
        var lvl = alarmLevel(r.value, tg.alarm, tg.deadband, r.level);
        if (lvl !== r.level) {
            r.level = lvl;
            var lim = lvl ? tg.alarm[lvl.toLowerCase()] : null;
            alarms.update(tg.id, lvl, { t: t, tag: tg.name, device: (devs[tg.device] || {}).dev ? devs[tg.device].dev.name : '', value: r.value, limit: lim,
                msg: lvl ? (fmtNum(r.value) + ' ' + (tg.unit || '') + (lvl === 'HI' || lvl === 'HIHI' ? ' ≥ ' : ' ≤ ') + fmtNum(lim)) : '' });
        }
        hist[tg.id].push(t, r.value);
    }
    function decodeBlock(D, blk, data, t) {
        blk.items.forEach(function (it) {
            var tg = it.ref, raw, eng;
            try {
                if (M.TABLES[tg.table].bits) raw = data[it.offset] ? 1 : 0;
                else if (tg.type === 'bool') raw = data[it.offset] ? 1 : 0;
                else raw = M.decodeValue(data.slice(it.offset, it.offset + it.count), tg.type, tg.order || D.dev.order);
                eng = tg.type === 'bool' ? raw : M.scaleToEng(raw, tg.scale);
                setValue(tg, raw, eng, t);
            } catch (e) { var r = vals[tg.id]; if (r) { r.q = 'bad'; r.err = e.message; } }
        });
    }
    function refreshStale(t) {
        t = t || tnow();
        Object.keys(devs).forEach(function (id) {
            var D = devs[id], lim = staleMs(D);
            D.tags.forEach(function (tg) { var r = vals[tg.id]; if (r && r.q === 'good' && r.ts != null && t - r.ts > lim) r.q = 'stale'; });
        });
    }
    function logBatch(D, t) {
        var batch = [];
        D.tags.forEach(function (tg) {
            if (tg.log === false) return;
            var r = vals[tg.id]; if (!r || r.q === 'init') return;
            var v = r.q === 'bad' ? null : (isNum(r.value) ? r.value : null), L = lastLog[tg.id];
            if (L && L.q === r.q) {
                if (tg.logMinMs > 0 && t - L.t < tg.logMinMs) return;
                if (tg.logDeadband > 0 && v != null && L.v != null && Math.abs(v - L.v) < tg.logDeadband) return;
            }
            lastLog[tg.id] = { t: t, v: v, q: r.q };
            batch.push({ tag: tg.name, device: D.dev.name, t: t, v: v, q: r.q, raw: r.q === 'bad' ? null : (isNum(r.raw) ? r.raw : null), unit: tg.unit || '' });
        });
        return batch;
    }
    function pollOnce(D) {
        if (!D.client) return Promise.resolve(false);
        D.busy = true;
        var t0 = tnow(), c = D.client, anyOk = false, fatal = null, silent = null;
        var chain = Promise.resolve();
        function markBad(blk, e) {
            var t = tnow();
            blk.items.forEach(function (it) { var r = vals[it.ref.id]; if (r) { r.q = 'bad'; r.err = e.message; r.tsBad = t; } });
        }
        D.blocks.forEach(function (blk) {
            chain = chain.then(function () {
                if (fatal || D.client !== c) return;
                // after a timeout (retries exhausted) the device is treated as not answering for the
                // rest of this cycle, so a dead device costs one timeout per poll, not one per block
                if (silent) { markBad(blk, silent); return; }
                return c.read(D.dev.unit, blk.table, blk.start, blk.count).then(function (data) {
                    anyOk = true; decodeBlock(D, blk, data, tnow());
                }, function (e) {
                    markBad(blk, e);
                    if (e.kind === 'closed' || e.kind === 'transport') fatal = e;
                    if (e.kind === 'timeout') silent = e;
                    D.lastErr = e.message;
                });
            });
        });
        return chain.then(function () {
            D.busy = false;
            var t = tnow();
            D.lastPollMs = t - t0;
            if (anyOk) { D.lastOk = t; D.fails = 0; }
            refreshStale(t);
            var allBad = !anyOk && D.blocks.length;
            if (fatal || allBad) setStatus(D, 'error', (fatal || { message: D.lastErr }).message);
            else setStatus(D, paused ? 'paused' : 'online', null);
            var batch = logBatch(D, t);
            publishSamples(batch);
            S.emit('poll', { device: D.dev.id, t: t, ok: anyOk, batch: batch });
            if (fatal) { closeDev(D); reconnect(D); }
            return anyOk;
        });
    }
    function poll(D) {
        if (!running || paused || D.busy) return;
        var t0 = tnow();
        pollOnce(D).then(function () {
            if (!running || paused || !D.client) return;
            schedule(D, Math.max(10, D.dev.pollMs - (tnow() - t0)), poll);
        });
    }
    S.start = function () {
        if (running) return S;
        running = true; gen++;
        alarms.log(tnow(), 'Modbus polling started', 'evt');
        Object.keys(devs).forEach(function (id) { connect(devs[id]); });
        S.emit('start');
        return S;
    };
    S.stop = function () {
        if (!running) return S;
        running = false; gen++;
        Object.keys(devs).forEach(function (id) { closeDev(devs[id]); devs[id].status = 'idle'; });
        alarms.log(tnow(), 'Modbus polling stopped', 'evt');
        S.emit('stop');
        return S;
    };
    S.pause = function () {
        paused = true;
        Object.keys(devs).forEach(function (id) { var D = devs[id]; if (D.timer && D.client) { clrT(D.timer); D.timer = null; } if (D.client) setStatus(D, 'paused'); });
        alarms.log(tnow(), 'Polling paused', 'evt');
        S.emit('paused', true);
    };
    S.resume = function () {
        if (!paused) return;
        paused = false;
        alarms.log(tnow(), 'Polling resumed', 'evt');
        Object.keys(devs).forEach(function (id) { var D = devs[id]; if (D.client) { setStatus(D, 'online'); schedule(D, 0, poll); } });
        S.emit('paused', false);
    };
    S.isPaused = function () { return paused; };
    S.isRunning = function () { return running; };
    // pollNow() → Promise: connect (if needed) and poll every device once (tests, "Poll now").
    S.pollNow = function () {
        var was = running;
        if (!running) { running = true; gen++; }
        var ps = Object.keys(devs).map(function (id) {
            var D = devs[id];
            if (!D.dev.enabled || !D.tags.length) return Promise.resolve(false);
            var p = D.client ? Promise.resolve(true) : (function () {
                if (D.timer) { clrT(D.timer); D.timer = null; }
                var pp = connect(D);
                return pp.then(function (ok) { if (D.timer) { clrT(D.timer); D.timer = null; } return ok; });
            })();
            return p.then(function (ok) { return ok && !D.busy ? pollOnce(D) : false; });
        });
        return Promise.all(ps).then(function (r) {
            if (!was) { running = false; gen++; Object.keys(devs).forEach(function (id) { closeDev(devs[id]); }); }
            else Object.keys(devs).forEach(function (id) { var D = devs[id]; if (D.client && !paused && !D.timer && !D.busy) schedule(D, D.dev.pollMs, poll); });
            return r;
        });
    };
    function withClient(D, fn) {
        if (D.client) return fn(D.client);
        var tr = makeTransport(D.dev, env);
        return Promise.resolve().then(function () { return tr.open(); }).then(function () {
            var c = M.createClient(tr, { timeout: D.dev.timeoutMs, retries: D.dev.retries, framing: tr.framing, now: tnow, setTimeout: setT, clearTimeout: clrT });
            return Promise.resolve().then(function () { return fn(c); }).then(function (r) { c.close(); return r; }, function (e) { c.close(); throw e; });
        });
    }
    // testRead(tagId) → Promise<{raw, value, canon, words|bits, unit}>
    S.testRead = function (tagId) {
        var tg = tagsById[tagId]; if (!tg) return Promise.reject(M.ModbusError('config', 'Unknown tag'));
        var D = devs[tg.device]; if (!D) return Promise.reject(M.ModbusError('config', 'Tag has no device'));
        var addr = M.protocolAddress(tg.address, tg.table, cfg.base);
        if (!isNum(addr)) return Promise.reject(M.ModbusError('config', 'Invalid address'));
        var cnt = M.TABLES[tg.table].bits ? 1 : M.regCount(tg.type);
        return withClient(D, function (c) { return c.read(D.dev.unit, tg.table, addr, cnt); }).then(function (data) {
            var raw = (M.TABLES[tg.table].bits || tg.type === 'bool') ? (data[0] ? 1 : 0) : M.decodeValue(data, tg.type, tg.order || D.dev.order);
            var eng = tg.type === 'bool' ? raw : M.scaleToEng(raw, tg.scale), V = VAR_BY_KEY[tg.link];
            return { raw: raw, value: eng, canon: V ? (V.kind === 'bool' ? (eng ? 1 : 0) : toCanonical(eng, tg.unit, V.cat)) : null,
                data: data.slice(0, cnt), unit: tg.unit, address: addr, table: tg.table };
        });
    };
    // write(tagId, engValue, {confirmed:true}) — only when writes are enabled in the config.
    S.write = function (tagId, eng, o) {
        var tg = tagsById[tagId];
        if (!tg) return Promise.reject(M.ModbusError('config', 'Unknown tag'));
        if (!cfg.writesEnabled) return Promise.reject(M.ModbusError('config', 'Writes are disabled — tick "Enable writes" on the Modbus page first'));
        if (!o || o.confirmed !== true) return Promise.reject(M.ModbusError('config', 'Write not confirmed'));
        var T = M.TABLES[tg.table];
        if (T.readOnly) return Promise.reject(M.ModbusError('config', T.label + ' is read-only'));
        var D = devs[tg.device]; if (!D) return Promise.reject(M.ModbusError('config', 'Tag has no device'));
        var addr = M.protocolAddress(tg.address, tg.table, cfg.base);
        var p;
        try {
            if (T.bits) p = function (c) { return c.writeCoil(D.dev.unit, addr, !!+eng); };
            else {
                var raw = tg.type === 'bool' ? (+eng ? 1 : 0) : M.scaleToRaw(+eng, tg.scale);
                if (!isNum(raw)) throw M.ModbusError('config', 'Value cannot be scaled to a raw register value');
                var words = M.encodeValue(raw, tg.type === 'bool' ? 'uint16' : tg.type, tg.order || D.dev.order);
                p = words.length === 1 ? function (c) { return c.writeRegister(D.dev.unit, addr, words[0]); } : function (c) { return c.writeRegisters(D.dev.unit, addr, words); };
            }
        } catch (e) { return Promise.reject(e); }
        return withClient(D, p).then(function (r) {
            alarms.log(tnow(), 'Write ' + tg.name + ' = ' + eng + (tg.unit ? ' ' + tg.unit : '') + ' (' + D.dev.name + ')', 'write');
            return r;
        });
    };
    S.values = function () { refreshStale(); var o = {}; Object.keys(vals).forEach(function (id) { o[id] = vals[id]; }); return o; };
    S.value = function (tagId) { return vals[tagId] || null; };
    // getVar(key) → {value (app field unit), q, ts, tag, unitErr} from the first linked tag (a good one preferred).
    S.getVar = function (key) {
        refreshStale();
        var best = null;
        cfg.tags.forEach(function (tg) {
            if (tg.link !== key || !vals[tg.id]) return;
            var r = vals[tg.id], c = { value: r.canon, q: r.unitErr ? 'bad' : r.q, ts: r.ts, tag: tg.name, tagId: tg.id, unitErr: r.unitErr, err: r.unitErr ? 'unit mismatch' : r.err };
            if (!best || (best.q !== 'good' && c.q === 'good')) best = c;
        });
        return best;
    };
    S.linkedValues = function () { var o = {}; VARS.forEach(function (V) { var x = S.getVar(V.key); if (x && x.q !== 'init' && x.q !== 'bad' && x.value != null) o[V.key] = x.value; }); return o; };
    S.devices = function () {
        return Object.keys(devs).map(function (id) {
            var D = devs[id];
            return { id: id, name: D.dev.name, transport: D.dev.transport, status: D.status, lastOk: D.lastOk, lastErr: D.lastErr, lastPollMs: D.lastPollMs,
                pollMs: D.dev.pollMs, blocks: D.blocks.length, tags: D.tags.length, stats: D.client ? D.client.stats() : null };
        });
    };
    S.history = function (tagId, t0) { return hist[tagId] ? hist[tagId].range(t0 == null ? -Infinity : t0) : { t: [], v: [] }; };
    S.alarms = alarms;
    S.config = function () { return clone(cfg); };
    S.tag = function (id) { return tagsById[id] || null; };
    S.blocks = function (devId) { var D = devs[devId]; return D ? D.blocks : []; };
    S.dispose = function () { S.stop(); S._clearHandlers(); };
    return S;
}
function fmtNum(v) { return isNum(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3)) : '—'; }

// ─── shared station (pages acquire / release it) ─────────────────────────────
var _station = null, _owners = {};
function acquire(owner) {
    _owners[owner || 'page'] = 1;
    if (!_station) _station = createStation(getConfig());
    if (!_station.isRunning()) _station.start();
    return _station;
}
function release(owner) {
    delete _owners[owner || 'page'];
    if (!Object.keys(_owners).length && _station) { _station.dispose(); _station = null; }
}
function rebuildStation() {
    if (!_station) return;
    var wasRunning = _station.isRunning();
    _station.dispose(); _station = null;
    if (wasRunning && Object.keys(_owners).length) { _station = createStation(getConfig()); _station.start(); }
    M.emitShared('station', _station);
}
// syncStation(): rebuild a running station whose config no longer matches storage
// (project opened, storage restored) — called by the pages when they render.
function syncStation() {
    if (!_station) return false;
    if (JSON.stringify(_station.config()) === JSON.stringify(getConfig())) return false;
    rebuildStation();
    return true;
}
var _shared = M.makeEmitter({});
M.onShared = _shared.on; M.offShared = _shared.off; M.emitShared = _shared.emit;

// ─── virtual slave + driver ──────────────────────────────────────────────────
// Values come from (a) a private WTS_sim instance (31) fed with the Well Test
// Simulator form flow (WTS_state.flow) or the sample flow, (b) waveforms around
// the sample steady state, or (c) manual values (sliders). The driver runs only
// when the slave is polled (pull), so it never needs a timer.
var _vs = null;
function simFlow() {
    var W = G.WTS_state, L = G.WTS_lastCalc, S = G.WTS_sim;
    if (W && W.flow && W.flow.inputs) return W.flow;
    if (L && L.flow && L.flow.inputs) return L.flow;
    return S && S.SAMPLE_FLOW ? S.SAMPLE_FLOW : null;
}
function makeFormModel(o) {
    o = o || {};
    var S = G.WTS_sim, sim = null, flow = null, t = 0;
    function ensure() {
        var f = o.flow || simFlow();
        if (sim && f === flow) return sim;
        if (!S || typeof S.create !== 'function' || !f) return null;
        try { if (sim) sim.dispose(); } catch (e) {}
        try { sim = S.create(f, { mode: 'steady', seed: o.seed || 11 }); flow = f; } catch (e) { sim = null; }
        return sim;
    }
    return {
        step: function (dtSec) { var s = ensure(); if (s && dtSec > 0) { try { s.advance(Math.min(dtSec, 600)); } catch (e) {} } t += dtSec || 0; },
        state: function () { var s = ensure(); return s ? s.getState() : null; },
        values: function () { return varsFromState(this.state()); },
        sim: function () { return ensure(); },
        dispose: function () { try { if (sim) sim.dispose(); } catch (e) {} sim = null; }
    };
}
// fixed demo values for the downhole gauge (see DEMO_DESC.BHP_GAUGE)
var DEMO_BHP_COLUMN_PSI = 2400, DEMO_BHT_F = 220;
function nominalValues() {
    var st = null;
    try { var m = makeFormModel({ flow: G.WTS_sim && G.WTS_sim.SAMPLE_FLOW }); st = m.state(); } catch (e) {}
    if (!st && G.WTS_3d && G.WTS_3d._internals && typeof G.WTS_3d._internals.fakeSnapshot === 'function') { try { st = G.WTS_3d._internals.fakeSnapshot(0); } catch (e) {} }
    var v = varsFromState(st);
    var fb = { whp: 3000, wht: 180, choke_bean: 32, choke_dn_p: 157.7, heater_t: 150, sep_p: 150, sep_t: 150, sep_liq_lvl: 60, sep_int_lvl: 25, sep_oil_lvl: 32,
        gas_rate: 10, oil_rate: 1000, water_rate: 200, flare_rate: 10, flare_p: 5, surge_p: 25, surge_lvl_a: 55, surge_lvl_b: 55, gauge_lvl_a: 30, gauge_lvl_b: 0,
        lcv_oil: 0, lcv_water: 0, pcv_sep: 50, esd_open: 1, esd_tripped: 0, pump_running: 0, xv201a: 1, xv201b: 1, xv301a: 1, xv301b: 0, heater_bypass: 0 };
    Object.keys(fb).forEach(function (k) { if (v[k] == null) v[k] = fb[k]; });
    v.bhp = (v.whp || 0) + DEMO_BHP_COLUMN_PSI; v.bht = DEMO_BHT_F;
    return v;
}
function createVirtualSlave(o) {
    o = o || {};
    var slave, model = null, last = null, t0 = null, nominal = null, cfgRead = o.config || getConfig;
    var D = { values: {} };
    function values(t) {
        var c = cfgRead().sim || {}, src = c.source || 'sim', v;
        var dt = last == null ? 0 : Math.max(0, Math.min(10, (t - last) / 1000));
        last = t; if (t0 == null) t0 = t;
        if (src === 'sim') {
            if (!model) model = makeFormModel({ seed: 23 });
            model.step(dt * (c.speed || 1));
            v = model.values();
            if (v.whp == null) v = nominalValues();
            v.bhp = v.whp != null ? v.whp + DEMO_BHP_COLUMN_PSI : null; v.bht = DEMO_BHT_F;
        } else {
            if (!nominal) nominal = nominalValues();
            v = {}; for (var k in nominal) v[k] = nominal[k];
            if (src === 'waveform') {
                var s = (t - t0) / 1000, sn = function (per, ph) { return Math.sin(2 * Math.PI * s / per + (ph || 0)); };
                ['whp', 'choke_dn_p', 'sep_p', 'gas_rate', 'oil_rate', 'water_rate', 'flare_rate', 'surge_p'].forEach(function (k, i) { if (v[k] != null) v[k] *= 1 + 0.05 * sn(120, i); });
                if (v.wht != null) v.wht += 3 * sn(300);
                var tri = function (per, lo, hi, ph) { var x = ((s / per + (ph || 0)) % 1 + 1) % 1; return lo + (hi - lo) * (x < 0.5 ? 2 * x : 2 - 2 * x); };
                v.sep_liq_lvl = tri(180, 45, 70); v.sep_int_lvl = tri(240, 15, 35, 0.3); v.sep_oil_lvl = tri(90, 20, 45, 0.6);
                v.surge_lvl_a = tri(600, 25, 75); v.surge_lvl_b = tri(600, 25, 75, 0.5); v.gauge_lvl_a = tri(1200, 5, 92); v.gauge_lvl_b = tri(1200, 5, 92, 0.5);
                v.pump_running = sn(300) > 0 ? 1 : 0;
                v.bhp = v.whp + DEMO_BHP_COLUMN_PSI;
            }
            var man = c.manual || {};
            if (src === 'manual') Object.keys(man).forEach(function (k) { if (isNum(man[k])) v[k] = man[k]; });
        }
        D.values = v;
        return v;
    }
    function drive() {
        var t = now(), v = values(t);
        DEMO_MAP.forEach(function (m) {
            var key = m[1]; if (!key) return;
            var x = v[key]; if (x == null || !isNum(x)) return;
            var V = VAR_BY_KEY[key], table = m[2], addr = m[3], type = m[4];
            if (type === 'bool') { slave[table][addr] = x ? 1 : 0; return; }
            var eng = V ? fromCanonical(x, m[7], V.cat) : x;
            var raw = m[6] ? M.scaleToRaw(eng, m[6]) : eng;
            var T = M.TYPES[type];
            if (T.int) raw = clamp(Math.round(raw), T.min, T.max);
            try { slave.setValue(table, addr, type, m[5] || 'ABCD', raw); } catch (e) {}
        });
    }
    function onWrite(table, addr, qty) {
        if (table !== 'coil') return;
        var sim = model && model.sim();
        if (addr <= 0 && addr + qty > 0 && slave.coil[0]) { slave.coil[0] = 0; if (sim && sim.tripESD) { try { sim.tripESD('Remote trip (Modbus coil 00001)'); } catch (e) {} } D.lastCommand = 'trip'; }
        if (addr <= 1 && addr + qty > 1 && slave.coil[1]) { slave.coil[1] = 0; if (sim && sim.resetESD) { try { sim.resetESD(); } catch (e) {} } D.lastCommand = 'reset'; }
    }
    slave = M.createSlave({ unit: o.unit || 1, onRequest: function () { drive(); }, onWrite: onWrite });
    slave.driver = D;
    D.drive = drive;
    D.model = function () { return model; };
    D.reset = function () { if (model) model.dispose(); model = null; last = null; t0 = null; nominal = null; };
    return slave;
}
function virtualSlave() { if (!_vs) _vs = createVirtualSlave(); return _vs; }

// ─── public ──────────────────────────────────────────────────────────────────
M.STORE_KEY = STORE_KEY; M.TRANSPORT_LABELS = TRANSPORTS; M.POLL_MIN = POLL_MIN; M.POLL_MAX = POLL_MAX;
M.UNITS = UNITS; M.toCanonical = toCanonical; M.fromCanonical = fromCanonical; M.unitFits = unitFits;
M.VARS = VARS; M.VAR_BY_KEY = VAR_BY_KEY; M.varsFromState = varsFromState; M.applyVarsToState = applyVarsToState;
M.defaultConfig = defaultConfig; M.defaultDevice = defaultDevice; M.defaultTag = defaultTag; M.demoConfig = demoConfig; M.DEMO_MAP = DEMO_MAP;
M.normalizeConfig = normalizeConfig; M.getConfig = getConfig; M.saveConfig = saveConfig; M.setPaused = setPaused; M.getTags = getTags;
M.tagsToCsv = tagsToCsv; M.tagsFromCsv = tagsFromCsv; M.parseCsv = parseCsv; M.CSV_COLS = CSV_COLS;
M.planBlocks = planBlocks; M.alarmLevel = alarmLevel; M.createAlarmManager = createAlarmManager; M.makeHistory = makeHistory;
M.publishSamples = publishSamples; M.makeTransport = makeTransport; M.createStation = createStation;
M.acquire = acquire; M.release = release; M.syncStation = syncStation; M.station = function () { return _station; }; M.owners = function () { return Object.keys(_owners); };
M.makeFormModel = makeFormModel; M.createVirtualSlave = createVirtualSlave; M.virtualSlave = virtualSlave; M.nominalValues = nominalValues;
M.DEMO_BHP_COLUMN_PSI = DEMO_BHP_COLUMN_PSI; M.DEMO_BHT_F = DEMO_BHT_F;
M.fmtNum = fmtNum;
M._reset = function () { if (_station) _station.dispose(); _station = null; _owners = {}; if (_vs && _vs.driver) _vs.driver.reset(); _vs = null; _cache = { raw: null, cfg: null }; };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, M = G.WTS_modbus;
    if (!M || !M.planBlocks) return;
    var b = M.planBlocks([{ table: 'holding', addr: 0, count: 2, ref: 1 }, { table: 'holding', addr: 2, count: 2, ref: 2 }, { table: 'holding', addr: 200, count: 1, ref: 3 }], { maxGap: 0 });
    var ok = b.length === 2 && b[0].count === 4 && Math.abs(M.toCanonical(10, 'bar', 'pressureG') - 145.0377) < 1e-3;
    if (typeof console !== 'undefined') console[ok ? 'log' : 'warn']('[51-modbus-station] self-test ' + (ok ? 'passed' : 'FAILED'));
})();
