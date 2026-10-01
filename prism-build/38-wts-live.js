// ════════════════════════════════════════════════════════════════════
// WTS — Layer 38 — Live Well Test Simulator controller (Round-7)
//
// window.WTS_live — the single owner of the live view's animation loop,
// HMI chrome and mode logic for the Well Test Simulator page:
//
//   host renderWTS ─► WTS_live.mount(#wts_viz)
//   host calcWTS ─► 'wts:calc' (WTS_lastCalc.flow v1) ─► sim.setFlow(flow)
//   rAF loop: sim.step(dt) ─► state ─┬─► Handle3D.frame(state, dt)   (32, 3D mode)
//                                    ├─► draw2dLive(state)            (2D mode, 10 Hz)
//                                    └─► HUD / pill / card (4 Hz), WTS_state.sim (5 s)
//
// Owns: toolbar, alarm pill + drawer (operator lifecycle UNACK/ACK/RTN),
// HUD, Tier-3 info card, trends, legend, loading / fallback / recovery,
// 2D live overlay + "Levels & Pressures" strip, keyboard shortcuts,
// prefs (localStorage 'h2viz3d_prefs'), GA events, all HMI CSS (#wtsl-css).
//
// Depends on: window.WTS_sim (31, required), window.WTS_3d (32, optional —
// without it the view runs in 2D), host bridges window.wtsDrawDiag /
// window.WTS_DIAG_LAYOUT (host edit H5), window.WTS_units (22, optional).
//
// Conventions: single outer IIFE; public symbols on window.WTS_live only;
// no DOM / timers / storage / listeners at load; field units internally,
// display through WTS_units; no dynamic module loading here.
// ════════════════════════════════════════════════════════════════════
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;

// ═══════════════════════════════════════════════════════════════════
// §A CONSTANTS
// ═══════════════════════════════════════════════════════════════════
var VERSION = '1.1.0';
var PREFS_KEY = 'h2viz3d_prefs';
var SPEEDS = [1, 10, 60, 600];
var IMP = { pressureG: 'psig', pressureTank: 'psig', temperature: '°F', gasRate: 'MMSCFD', liquidRate: 'BPD',
    oilRate: 'STB/d', volume: 'bbl', oilVolume: 'STB', gasVolume: 'MMSCF', velocity: 'ft/s', length: 'ft',
    lengthSmall: 'in', percent: '%', gor: 'scf/STB', powerLarge: 'MMBtu/hr', count: '', pressure: 'psi', tempDelta: '°F' };
var CAT_BASE = { pressureTank: 'pressureG', oilRate: 'liquidRate', oilVolume: 'volume' };
var UNITLESS = { percent: 1, count: 1 };          // gor converts (scf/STB → sm³/sm³ in Metric)
var STATUS_MAP_LOCAL = { trip: 'alarm', alarm: 'alarm', warn: 'warn', hyd: 'hyd', info: 'evt' };
var ST_RANK = { ok: 0, evt: 1, hyd: 2, warn: 3, alarm: 4 };
var SEV_RANK = { info: 1, hyd: 2, warn: 3, alarm: 4, trip: 5 };
var EQ_IDS = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare', 'surge', 'pump', 'gauge'];
var STEP = { wellhead: '①', esd: '②', choke: '③', heater: '④', separator: '⑤',
    flare: '⑥', surge: '⑦', gauge: '⑧', pump: '⑨' };          // P-201 is downstream of the gauge tank (T-301 → export)
var TAG = { wellhead: 'WH-101', esd: 'SDV-101', choke: 'CK-101', heater: 'H-101', separator: 'V-101',
    flare: 'FS-401', surge: 'T-201', pump: 'P-201', gauge: 'T-301' };
var NAME = { wellhead: 'Wellhead', esd: 'ESD Valve (SSV)', choke: 'Choke Manifold', heater: 'Line Heater',
    separator: 'Test Separator', flare: 'Flare Stack', surge: 'Surge Tank', pump: 'Transfer Pump', gauge: 'Gauge Tank' };
var EQ_ABBR = { wellhead: 'WH', esd: 'ESD', choke: 'CHK', heater: 'HTR', separator: 'SEP', flare: 'FLR',
    surge: 'SURGE', pump: 'PUMP', gauge: 'GT' };
var HOST_NM = ['Wellhead', 'SSV', 'Choke', 'Heater', 'Separator', 'Flare', 'Surge Tank', 'Atm Tank'];
var NODE_KEYS = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare', 'surge', 'gauge'];
var SEG_DEF = [['4', 'multi', 4.026], ['4', 'multi', 4.026], ['6', 'multi', 6.065], ['6', 'multi', 6.065],
    ['6', 'gas', 6.065], ['3', 'liquid', 3.068]];
var FAULTS = [['pcvStuckClosed', 'PCV-101 stuck closed'], ['pcvStuckOpen', 'PCV-101 stuck open'],
    ['oilDumpStuckOpen', 'LCV-102 stuck open'], ['oilDumpStuckClosed', 'LCV-102 stuck closed'],
    ['waterDumpStuckClosed', 'LCV-101 stuck closed'], ['xferStuckClosed', 'LCV-201 stuck closed (surge transfer)'],
    ['surgePumpFail', 'P-201 failed (gauge tank pump)'], ['slugging', 'Slug flow']];
// Rig-up (which equipment is in the spread) — persisted in localStorage 'wts_sim_rigup' (a wts_* key, so it travels in
// project files); the list and the rules come from WTS_sim.RIGUP / normRigup, this is the fallback.
var RIG_KEY = 'wts_sim_rigup';
var RIG_FALLBACK = [['esd', 'SDV-101', 'ESD valve (SSV)', 1], ['choke', 'CK-101', 'Choke manifold / data header', 1], ['heater', 'H-101', 'Line heater (steam exchanger)'],
    ['separator', 'V-101', 'Test separator'], ['surge', 'T-201', 'Surge tank'], ['gauge', 'T-301', 'Gauge tank'],
    ['pump', 'P-201', 'Transfer pump (gauge tank → export / burner)'], ['flare', 'FS-401', 'Flare / burner']];
var VIEWS = [['overview', 'Overview', '0'], ['wellhead', 'Wellhead & Choke', '1'], ['separator', 'Separator', '2'],
    ['tanks', 'Tanks', '3'], ['flare', 'Flare', '4'], ['process', 'Process', '5']];
var OVERLAYS = [['phase', 'Phase'], ['pressure', 'Pressure'], ['temperature', 'Temperature'], ['erosion', 'Erosion']];
var QUALS = [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
var LABEL_MODES = [['all', 'All'], ['equip', 'Equipment'], ['off', 'Off']];
var INPUT_FOR = { wellhead: 'wts_Pwh', esd: 'wts_Pwh', choke: 'wts_bean', heater: 'wts_Thtr', separator: 'wts_Psep',
    surge: 'wts_Psurge', pump: 'wts_nps6', gauge: 'wts_gtCap', flare: 'wts_nps5' };
var DEF_COL = { gas: '#b8d4f0', oil: '#c98a2b', water: '#1f7fe0', emulsion: '#a08650' };
var PREF_DEFAULTS = { mode: '3d', labels: 'all', overlay: 'phase', quality: 'auto', speed: 10,
    legend: false, trends: false, orbit: false, ctl: null };
// Metric alarm-message templates (§6.9), wording as 31 (tag stripped): [text, operator, category, suffix?].
var ALM_T = {
    PSHH_SEP: ['separator', ' ≥ ', 'pressureG'], PSH_SEP: ['separator pressure high', ' ≥ ', 'pressureG'],
    PSL_SEP: ['separator pressure low', ' ≤ ', 'pressureG'], PSV_SEP: ['lifting — separator', ' (set ', 'pressureG', ')'],
    PSHH_SURGE: ['surge tank', ' ≥ ', 'pressureG'], PSH_SURGE: ['surge tank pressure high', ' ≥ ', 'pressureG'],
    PSV_SURGE: ['lifting — surge tank', ' (set ', 'pressureG', ')']
};

// Inline 16 px icons (stroke 1.6, currentColor). No <title> children (they leak into textContent).
var ICON = (function () {
    function s(p) { return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
    return {
        play: s('<path d="M5 3.2v9.6L12.6 8z" fill="currentColor" stroke="none"/>'),
        pause: s('<path d="M5.2 3.5v9M10.8 3.5v9"/>'),
        reset: s('<path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.6v2.8h2.8"/>'),
        esd: s('<path d="M5.5 1.8h5l3.7 3.7v5l-3.7 3.7h-5l-3.7-3.7v-5z"/><path d="M8 5v3.4"/><circle cx="8" cy="10.9" r=".5" fill="currentColor"/>'),
        scen: s('<path d="M6 2h4M6.8 2v4.2L3 12.6a1 1 0 0 0 .9 1.4h8.2a1 1 0 0 0 .9-1.4L9.2 6.2V2"/><path d="M4.6 10h6.8"/>'),
        bell: s('<path d="M4 11.5V7.2a4 4 0 0 1 8 0v4.3l1 1.2H3z"/><path d="M6.8 14h2.4"/>'),
        cam: s('<rect x="1.8" y="4.5" width="12.4" height="8.5" rx="1.6"/><circle cx="8" cy="8.8" r="2.4"/><path d="M5.5 4.5l1-1.6h3l1 1.6"/>'),
        drop: s('<path d="M8 1.8s4.5 4.8 4.5 8a4.5 4.5 0 0 1-9 0c0-3.2 4.5-8 4.5-8z"/>'),
        tag: s('<path d="M2 2.5h5.5l6.5 6.5-5 5-6.5-6.5V2.5z"/><circle cx="5" cy="5.5" r="1"/>'),
        legend: s('<path d="M2.5 4h2M2.5 8h2M2.5 12h2M6.5 4h7M6.5 8h7M6.5 12h7"/>'),
        trends: s('<path d="M1.8 12.5l3.5-4 3 2.6 5.5-6.6"/><path d="M1.8 14.2h12.4"/>'),
        gem: s('<path d="M4.2 2.5h7.6L14.5 6 8 14 1.5 6z"/><path d="M1.5 6h13M6 2.5 5 6l3 8 3-8-1-3.5"/>'),
        max: s('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
        min: s('<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>'),
        x: s('<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>'),
        more: s('<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>'),
        caret: '<svg class="wtsl-caret" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
        check: s('<path d="M3 8.5l3 3 7-7"/>'),
        orbit: s('<ellipse cx="8" cy="8" rx="6.2" ry="2.8"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/><path d="M12.8 3.6l1.4 1.8-2.2.4"/>')
    };
})();

// ═══════════════════════════════════════════════════════════════════
// §B PURE HELPERS (Node-testable; exported)
// ═══════════════════════════════════════════════════════════════════
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function num(x, d) { return isNum(x) ? x : d; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function deepClone(x) {
    var S = G.WTS_sim;
    if (S && typeof S.deepClone === 'function') { try { return S.deepClone(x); } catch (e) {} }
    return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}
function unitsApi() { var U = G.WTS_units; return (U && typeof U === 'object') ? U : null; }
function unitsSys() {
    var U = unitsApi();
    if (!U) return 'imperial';
    try { return (typeof U.getSystem === 'function' ? U.getSystem() : U.system) === 'metric' ? 'metric' : 'imperial'; }
    catch (e) { return 'imperial'; }
}
// Numeric conversion for display (also handed to 32 as opts.units.conv).
function unitsConv(v, cat) {
    var base = CAT_BASE[cat] || cat;
    var U = unitsApi();
    if (!UNITLESS[base] && U && typeof U.format === 'function' && unitsSys() === 'metric') {
        try {
            var f = U.format(v, base);
            if (f && f.label && isNum(+f.value)) return { value: +f.value, unit: String(f.label) };
        } catch (e) {}
    }
    return { value: v, unit: IMP[cat] != null ? IMP[cat] : (IMP[base] || '') };
}
function dpFor(cat, v) {
    var a = Math.abs(v);
    switch (CAT_BASE[cat] || cat) {
        case 'pressureG': return a < 100 ? 1 : 0;
        case 'temperature': return 0;
        case 'percent': return 0;
        case 'volume': return a < 100 ? 1 : 0;
        case 'gasRate': case 'gasVolume': return a < 10 ? 2 : 1;
        case 'liquidRate': return 0;
        case 'velocity': return a < 10 ? 1 : 0;
        case 'gor': return 0;
        case 'length': case 'lengthSmall': return 1;
        case 'powerLarge': return 2;
        default: return a < 10 ? 2 : a < 100 ? 1 : 0;
    }
}
function numStr(v, dp, sep) {
    var s = v.toFixed(dp);
    if (s === '-0' || /^-0\.0*$/.test(s)) s = s.slice(1);
    if (!sep) return s;
    var p = s.split('.'), neg = p[0].charAt(0) === '-', i = neg ? p[0].slice(1) : p[0];
    i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + i + (p.length > 1 ? '.' + p[1] : '');
}
// fmtParts(v, cat, dp?) → {v:string, u:string}  (§6.9)
function fmtParts(v, cat, dp) {
    if (!isNum(v)) return { v: '—', u: unitsConv(0, cat).unit };
    if (cat === 'pressureTank' && Math.abs(v) < 0.5) return { v: 'ATM', u: '' };
    var c = unitsConv(v, cat), val = c.value;
    if (!isNum(val)) return { v: '—', u: c.unit };
    var d = isNum(dp) ? dp : dpFor(cat, val);
    var base = CAT_BASE[cat] || cat;
    return { v: numStr(val, d, cat === 'gor' || (Math.abs(val) >= 1e4 && base !== 'pressureG' && base !== 'temperature')), u: c.unit };
}
function fmtU(v, cat, dp) { var p = fmtParts(v, cat, dp); return p.u ? p.v + ' ' + p.u : p.v; }
// ftIn(12.375) → "12′ 4-½″" (nearest quarter inch)
function ftIn(ft) {
    if (!isNum(ft)) return '—';
    var neg = ft < 0, q = Math.round(Math.abs(ft) * 48);
    var f = Math.floor(q / 48), r = q - f * 48, inch = Math.floor(r / 4), fr = r % 4;
    var F = ['', '¼', '½', '¾'][fr];
    var inStr = fr ? (inch ? inch + '-' + F : F) : String(inch);
    return (neg ? '-' : '') + f + '′ ' + inStr + '″';
}
// Calc-shaped nodes for host wtsDrawDiag (host nm names; Qmax in MSCF/D).
// flow (optional, default: the last flow handed to the sim) supplies th for
// nodes whose snapshot carries none (flare / surge / gauge — §3.3 defines no
// th there); the host's flow v1 nodes[i].th is pressure-dependent.
function liveNodes(st, flow) {
    var N = (st && st.nodes) || {}, I = (st && st.inputs) || {}, out = [];
    if (flow === undefined) flow = _lastFlowObj;
    var FN = (flow && Array.isArray(flow.nodes)) ? flow.nodes : [];
    for (var i = 0; i < 8; i++) {
        var k = NODE_KEYS[i], n = N[k] || {}, fn = FN[i] || {};
        if (fn.id && fn.id !== k) { fn = {}; for (var j = 0; j < FN.length; j++) if (FN[j] && FN[j].id === k) { fn = FN[j]; break; } }
        var th = (Object.prototype.hasOwnProperty.call(n, 'th') && isNum(n.th)) ? n.th : num(fn.th, 32);
        var o = { nm: HOST_NM[i], P: num(n.P, i === 7 ? 0 : num(I.Psep, 0)), T: num(n.T, 60), th: th };
        if (k === 'choke') {
            o.regime = n.regime || 'No Flow'; o.bean = num(n.bean, num(I.bean, 0)); o.Pci = num(n.Pin, o.P);
            o.Qmax = num(n.QmaxMMscfd, 0) * 1000; o.flowLimited = !!n.flowLimited;
        } else if (k === 'heater') {
            o.duty = num(n.dutyMMBtuHr, 0); o.bypass = !!(n.bypass != null ? n.bypass : I.bypass);
        }
        out.push(o);
    }
    return out;
}
// Calc-shaped segments (live P/T/vel/vPct/vSt/hydR/dP).
function liveSegs(st) {
    var S = (st && st.segs) || [], out = [];
    for (var i = 0; i < 6; i++) {
        var s = S[i] || {}, T0 = num(s.T0, 60), Tout = num(s.Tout, T0), P0 = num(s.P0, 0);
        out.push({ nps: String(s.nps != null ? s.nps : SEG_DEF[i][0]), sch: String(s.sch != null ? s.sch : '40'),
            ID: num(s.ID, SEG_DEF[i][2]), L: num(s.L, 0), phase: s.phase || SEG_DEF[i][1], P0: P0, Pout: num(s.Pout, P0),
            T0: T0, Tout: Tout, vel: num(s.vel, 0), ve: num(s.ve, 100), vPct: num(s.vPct, 0),
            vSt: (s.vSt === 'EXCEED' || s.vSt === 'WARNING') ? s.vSt : 'OK', dP: num(s.dP, 0), dT: T0 - Tout, hydR: !!s.hydR });
    }
    return out;
}
function statusMap() {
    var W = G.WTS_3d;
    return (W && W.STATUS_MAP && typeof W.STATUS_MAP === 'object') ? W.STATUS_MAP : STATUS_MAP_LOCAL;
}
// statusOf(eqId, simAlarms) → 'alarm'|'warn'|'hyd'|'evt'|'ok' (precedence alarm > warn > hyd > evt > ok)
function statusOf(eqId, alarms) {
    var M = statusMap(), best = 'ok';
    if (!alarms || !alarms.length) return best;
    for (var i = 0; i < alarms.length; i++) {
        var a = alarms[i];
        if (!a || a.eq !== eqId) continue;
        var s = M[a.sev] || 'ok';
        if (ST_RANK[s] > ST_RANK[best]) best = s;
    }
    return best;
}
// Count of alarms that matter to the operator (D38): sev ≠ info, plus an active ESD_MANUAL.
function alarmCount(alarms) {
    var n = 0, worst = 0;
    for (var i = 0; alarms && i < alarms.length; i++) {
        var a = alarms[i];
        if (!a) continue;
        if (a.sev === 'info' && a.id !== 'ESD_MANUAL') continue;
        n++;
        var r = a.sev === 'info' ? 2.5 : (SEV_RANK[a.sev] || 0);   // ESD_MANUAL ranks like a warning (amber)
        if (r > worst) worst = r;
    }
    return { n: n, level: worst >= 4 ? 'alarm' : worst >= 2.5 ? 'warn' : worst >= 2 ? 'hyd' : 'ok' };
}
// alarmReduce(prevMap, simAlarms, tSim, ackIds) → map id → entry (pure; never mutates prevMap).
function alarmReduce(prevMap, simAlarms, tSim, ackIds) {
    prevMap = prevMap || {};
    var out = {}, seen = {}, id, e, a, i;
    for (i = 0; simAlarms && i < simAlarms.length; i++) {
        a = simAlarms[i];
        if (!a || !a.id || seen[a.id]) continue;
        seen[a.id] = 1;
        e = prevMap[a.id];
        var base = { id: a.id, sev: a.sev, tag: a.tag, eq: a.eq, msg: a.msg,
            value: isNum(a.value) ? a.value : null, limit: isNum(a.limit) ? a.limit : null, active: true };
        if (e && e.active) {
            base.tOn = e.tOn; base.acked = e.acked; base.state = e.state;
        } else {
            base.tOn = isNum(a.since) ? a.since : num(tSim, 0);
            base.acked = a.sev === 'info'; base.state = base.acked ? 'ACK' : 'UNACK';
        }
        out[a.id] = base;
    }
    for (id in prevMap) {
        if (!Object.prototype.hasOwnProperty.call(prevMap, id) || seen[id]) continue;
        e = prevMap[id];
        if (e.active) {
            if (e.acked) continue;                                   // cleared + acked → removed
            out[id] = copyEntry(e, { active: false, state: 'RTN' });
        } else if (e.state === 'RTN') out[id] = copyEntry(e, {});
    }
    for (i = 0; ackIds && i < ackIds.length; i++) {
        e = out[ackIds[i]];
        if (!e) continue;
        if (e.active) out[e.id] = copyEntry(e, { acked: true, state: 'ACK' });
        else delete out[e.id];
    }
    return out;
}
function copyEntry(e, over) {
    var o = {}, k;
    for (k in e) if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) o[k] = over[k];
    return o;
}
// pillPick(map) → entry | null (D38): UNACK active > RTN > active sev ≥ hyd; info never.
function pillPick(map) {
    var best = null, bestK = -1;
    for (var id in map) {
        if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
        var e = map[id];
        if (!e || e.sev === 'info') continue;
        var tier = (e.active && e.state === 'UNACK') ? 3 : (!e.active && e.state === 'RTN') ? 2
            : (e.active && SEV_RANK[e.sev] >= 2) ? 1 : 0;
        if (!tier) continue;
        var k = tier * 1e12 + (SEV_RANK[e.sev] || 0) * 1e10 + clamp(num(e.tOn, 0), 0, 9e9);
        if (k > bestK) { bestK = k; best = e; }
    }
    return best;
}
function unackCount(map) {
    var n = 0;
    for (var id in map) if (Object.prototype.hasOwnProperty.call(map, id) && map[id].state === 'UNACK' && map[id].sev !== 'info') n++;
    return n;
}
// Operator-facing alarm text; rebuilt from {value, limit} in metric (§6.9).
function alarmText(a) {
    if (!a) return '';
    if (unitsSys() === 'metric' && isNum(a.value) && isNum(a.limit)) {
        var t = ALM_T[a.id];
        if (t) return t[0] + ' ' + fmtU(a.value, t[2]) + t[1] + fmtU(a.limit, t[2]) + (t[3] || '');
        if (/^HYD_/.test(a.id)) return (NAME[a.id.slice(4)] || a.tag || 'Node') + ': ' + fmtU(a.value, 'temperature') + ' below hydrate ' + fmtU(a.limit, 'temperature');
    }
    var m = String(a.msg || a.id || '');
    if (a.tag && m.indexOf(a.tag + ' ') === 0) m = m.slice(a.tag.length + 1);     // the tag is shown separately
    return m;
}
function flowValid(f) {
    if (!f || typeof f !== 'object' || !f.inputs) return false;
    var I = f.inputs, k = ['Qg', 'Qo', 'Qw', 'SGg', 'API', 'Psep'];
    for (var i = 0; i < k.length; i++) if (!isNum(+I[k[i]]) || +I[k[i]] < 0) return false;
    return +I.Psep > 0;
}
function shortNum(x) { return isNum(+x) ? String(+(+x).toFixed(2)) : String(x); }
// Setpoint-change events for sim.logEvent (§6.5).
function inputsDiff(prev, next) {
    var out = [];
    if (!prev || !next || !prev.inputs || !next.inputs) return out;
    var a = prev.inputs, b = next.inputs;
    if (+a.bean !== +b.bean) out.push(['Choke bean ' + shortNum(a.bean) + '→' + shortNum(b.bean) + '/64″', 'CK-101']);
    if (+a.Psep !== +b.Psep) { var pa = fmtParts(+a.Psep, 'pressureG'), pb = fmtParts(+b.Psep, 'pressureG'); out.push(['Separator SP ' + pa.v + '→' + pb.v + ' ' + pb.u, 'PCV-101']); }
    if (!!a.bypass !== !!b.bypass) out.push(['Heater bypass ' + (b.bypass ? 'ON' : 'OFF'), 'H-101']);
    if (+a.Qg !== +b.Qg || +a.Qo !== +b.Qo || +a.Qw !== +b.Qw) out.push(['Well rates updated', 'WH-101']);
    return out;
}
// Plain-JSON summary for WTS_state.sim (§6.12); deep-copied, never a live reference.
function summaryOf(st) {
    if (!st) return null;
    var C = st.cum || {}, R = st.rates || {}, B = (st.gauge && st.gauge.batches) || [], A = st.alarms || [];
    var ids = [];
    for (var i = 0; i < A.length; i++) if (A[i] && A[i].id) ids.push(A[i].id);
    return deepClone({
        elapsed_h: num(st.t, 0) / 3600, clock: st.clock || '', running: !!st.running, speed: num(st.speed, 10),
        cum: { oil_stb: num(C.oilIn_stb, 0), water_bbl: num(C.waterIn_bbl, 0), gas_mmscf: num(C.gasIn_mmscf, 0),
            flared_mmscf: num(C.flare_mmscf, 0) },
        rates: { gas_mmscfd: num(R.gas_mmscfd, 0), oil_stbd: num(R.oilMeter_stbd, num(R.oil_stbd, 0)),
            water_bpd: num(R.waterMeter_bpd, num(R.water_bpd, 0)),
            gor: isNum(R.gor_scf_stb) ? R.gor_scf_stb : null, bsw_pct: isNum(R.bsw_pct) ? R.bsw_pct : null },
        shrink_pct: isNum(R.shrink_pct) ? R.shrink_pct : null,
        batches: B.slice(Math.max(0, B.length - 10)),
        alarms: ids,
        rigup: st.rigup ? { full: !!st.rigup.full, sig: String(st.rigup.sig || ''), notes: (st.rigup.notes || []).slice(),
            out: rigItems().filter(function (it) { return st.rigup[it.key] === false; }).map(function (it) { return it.tag; }) } : null
    });
}
function bpOf(w) { return w >= 1000 ? 'lg' : w >= 768 ? 'md' : 'sm'; }
function fmtClockLocal(t) {
    t = Math.max(0, Math.floor(num(t, 0)));
    var h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    if (h >= 100) return Math.floor(h / 24) + 'd ' + p(h % 24) + ':' + p(m) + ':' + p(s);
    return p(h) + ':' + p(m) + ':' + p(s);
}
function pctStr(f) { return isNum(f) ? Math.round(f * 100) + '%' : '—'; }
function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function oilCss(api) {
    var W = G.WTS_3d;
    if (W && typeof W.oilColor === 'function') { try { var c = W.oilColor(api); if (c && c.css) return c.css; } catch (e) {} }
    var t = clamp((num(api, 35) - 10) / 40, 0, 1);
    var r = Math.round(120 + 110 * t), g = Math.round(62 + 110 * t), b = Math.round(20 + 40 * t);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
}
function palCol(key) {
    var W = G.WTS_3d, P = W && W.palette;
    if (P && typeof P === 'object') {
        var cands = { gas: ['gas', 'gasCap', 'gasBody'], water: ['water', 'waterBody', 'waterSurface'],
            emulsion: ['emulsion', 'emulsionBand'] }[key] || [key];
        for (var i = 0; i < cands.length; i++) if (typeof P[cands[i]] === 'string' && /^#/.test(P[cands[i]])) return P[cands[i]];
    }
    return DEF_COL[key];
}
// Minimal schema-shaped snapshot (tests / no-sim previews only).
function miniSnapshot() {
    return { v: 1, t: 0, clock: '00:00:00', speed: 10, running: true, inputs: { Psep: 150, bean: 32, Qg: 10, Qo: 1000, Qw: 200, API: 35 },
        nodes: { wellhead: { P: 3000, T: 180, th: 75 }, esd: { P: 2999.8, T: 180, th: 75 },
            choke: { P: 157.7, Pin: 2999.3, T: 68.7, th: 36.6, regime: 'Critical', bean: 32, flowLimited: false, QmaxMMscfd: 10.71 },
            heater: { P: 151, T: 150, th: 36, bypass: false, dutyMMBtuHr: 2.1, firing: 1 }, separator: { P: 150, T: 150, th: 36 },
            flare: { P: 5, T: 150, qMMscfd: 10 }, surge: { P: 25, T: 150 }, gauge: { P: 0, T: 150 } },
        segs: [{ vel: 8 }, { vel: 8 }, { vel: 48.7 }, { vel: 59.3 }, { vel: 59.2 }, { vel: 1.5 }], alarms: [] };
}

// ═══════════════════════════════════════════════════════════════════
// §C CSS (#wtsl-css, injected once)
// ═══════════════════════════════════════════════════════════════════
var CSS = [
'.wtsl-card.wtsl-card--live{padding:0!important;overflow:hidden}',
'.wtsl-viz{--hmi-ok:var(--green,#3fb950);--hmi-warn:var(--yellow,#d29922);--hmi-alarm:var(--red,#f85149);--hmi-hyd:var(--blue,#58a6ff);',
' --hmi-evt:var(--purple,#bc8cff);--hmi-sel:var(--accent,#f0883e);--hmi-neutral:rgba(139,148,158,.55);',
' --hmi-glass:rgba(13,17,23,.72);--hmi-glass-strong:rgba(13,17,23,.86);--hmi-solid:rgba(13,17,23,.9);--hmi-line:rgba(48,54,61,.9);',
' --hmi-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;position:relative;display:flex;flex-direction:column;',
' background:#05080d;border-radius:8px;overflow:hidden;color:#e6edf3;font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
' -webkit-tap-highlight-color:transparent;isolation:isolate;box-sizing:border-box}',
'.wtsl-viz *,.wtsl-viz *::before,.wtsl-viz *::after{box-sizing:border-box}',
'.wtsl-viz [hidden]{display:none!important}',
'.wtsl-viz button{min-height:0;margin:0;font:inherit;color:inherit;-webkit-appearance:none;appearance:none}',
'.wtsl-tb button,.wtsl-alarm button,.wtsl-hud button,.wtsl-icard button,.wtsl-drawer button,.wtsl-menu button,.wtsl-pop button,.wtsl-notice button,.wtsl-toasts button,.wtsl-loading button{position:relative}',
'.wtsl-viz[data-bp=lg]{height:clamp(420px,62vh,700px)}',
'.wtsl-viz[data-bp=md]{height:clamp(380px,58vh,560px)}',
'.wtsl-stage{position:relative;min-height:0;overflow:hidden;flex:1 1 0}',
'.wtsl-viz[data-bp=sm] .wtsl-stage{flex:none;height:clamp(320px,58vh,480px)}',
'.wtsl-view3d{position:absolute;inset:0;touch-action:pan-y}',
'.wtsl-viz[data-mode="2d"] .wtsl-view3d{display:none}',
'.wtsl-viz[data-mode="3d"] .wtsl-view2d{display:none}',
'.wtsl-viz.loading3d[data-mode="3d"] .wtsl-view2d{display:flex!important;position:absolute;inset:0;align-items:center;justify-content:center;opacity:.3;pointer-events:none;padding:0 12px}',
'.wtsl-viz[data-mode="2d"] .wtsl-stage{display:flex;flex-direction:column;justify-content:center;gap:6px;padding:4px 8px}',
'.wtsl-view2d{position:relative;flex:none;min-width:0}',
'.wtsl-view2d canvas{display:block;cursor:default}',
'.wtsl-viz[data-bp=sm] .wtsl-view2d{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}',
'.wtsl-viz[data-bp=sm] .wtsl-view2d canvas{width:900px!important;max-width:none}',
'.wtsl-viz[data-bp=sm][data-mode="2d"] .wtsl-stage::after{content:"";position:absolute;right:0;top:0;bottom:0;width:26px;background:linear-gradient(90deg,rgba(5,8,13,0),rgba(5,8,13,.92));pointer-events:none;z-index:3}',
/* toolbar */
'.wtsl-tb{z-index:10;display:flex;align-items:center;gap:6px;height:40px;padding:0 5px;border-radius:10px;background:var(--hmi-glass-strong);border:1px solid var(--hmi-line);box-shadow:0 6px 22px rgba(0,0,0,.35);min-width:0;overflow:hidden;flex:none}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-tb{position:absolute;top:10px;left:10px;right:10px}',
'.wtsl-viz[data-mode="2d"] .wtsl-tb,.wtsl-viz[data-bp=sm] .wtsl-tb{margin:8px 8px 0}',
'.wtsl-sep{width:1px;height:20px;background:var(--hmi-line);flex:none}',
'.wtsl-sp{flex:1 1 auto;min-width:0}',
'.wtsl-b{height:32px;min-width:32px;padding:0 9px;border-radius:6px;background:rgba(22,27,34,.9);border:1px solid #30363d;color:#e6edf3;font-size:12px;',
' display:inline-flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;white-space:nowrap;flex:none;transition:border-color .12s,background .12s}',
'.wtsl-b:hover{border-color:#484f58;background:rgba(33,38,45,.95)}',
'.wtsl-b.on{border-color:var(--hmi-sel);color:var(--hmi-sel);background:rgba(240,136,62,.16)}',
'.wtsl-b:focus-visible,.wtsl-mi:focus-visible,.wtsl-tile:focus-visible{outline:2px solid var(--hmi-sel);outline-offset:2px}',
'.wtsl-b:disabled{opacity:.42;cursor:not-allowed}',
'.wtsl-b svg{width:16px;height:16px;flex:none}',
'.wtsl-b .wtsl-caret{width:9px;height:9px;opacity:.7}',
'.wtsl-b.ic{padding:0;width:32px}',
'.wtsl-b small{font-size:10px;color:#8b949e}',
'.wtsl-b.on small{color:inherit}',
'.wtsl-esd{border-color:rgba(248,81,73,.7);color:#ff7b72;font-weight:700;letter-spacing:.4px}',
'.wtsl-esd:hover{background:rgba(248,81,73,.14);border-color:#f85149}',
'.wtsl-esd.rst{border-color:rgba(210,153,34,.8);color:#e3b341}',
'.wtsl-segc{display:inline-flex;height:32px;width:76px;border:1px solid #30363d;border-radius:6px;overflow:hidden;flex:none}',
'.wtsl-segc button{flex:1 1 0;border:0;background:rgba(22,27,34,.9);color:#8b949e;font-weight:700;font-size:11.5px;cursor:pointer}',
'.wtsl-segc button.on{background:var(--hmi-sel);color:#fff}',
'.wtsl-segc button:disabled{opacity:.4;cursor:not-allowed}',
'.wtsl-segc button:focus-visible{outline:2px solid #fff;outline-offset:-2px}',
'.wtsl-speeds{display:inline-flex;gap:2px;flex:none}',
'.wtsl-speeds .wtsl-b{height:28px;min-width:0;padding:0 7px;font:600 11px/1 var(--hmi-mono)}',
'.wtsl-speedchip{font:600 11px/1 var(--hmi-mono)!important}',
'.wtsl-badge{display:inline-block;min-width:16px;height:16px;padding:0 4px;border-radius:8px;font:700 10px/16px system-ui,sans-serif;text-align:center;color:#fff;background:#f85149}',
'.wtsl-badge[data-l=warn]{background:#9e6a03}.wtsl-badge[data-l=hyd]{background:#1f6feb}',
'.wtsl-brand{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px 0 8px;border-radius:12px;background:rgba(63,185,80,.08);border:1px solid rgba(63,185,80,.32);',
' font:700 10.5px/1 system-ui,sans-serif;letter-spacing:1px;color:#e6edf3;flex:none;white-space:nowrap}',
'.wtsl-dot{width:7px;height:7px;border-radius:50%;background:#3fb950;box-shadow:0 0 6px rgba(63,185,80,.8)}',
'.wtsl-brand[data-s=run] .wtsl-dot{animation:wtsl-pulse 2s ease-in-out infinite}',
'.wtsl-brand[data-s=paused]{background:rgba(139,148,158,.08);border-color:rgba(139,148,158,.3)}.wtsl-brand[data-s=paused] .wtsl-dot{background:#6e7681;box-shadow:none}',
'.wtsl-brand[data-s=trip]{background:rgba(248,81,73,.12);border-color:rgba(248,81,73,.5)}.wtsl-brand[data-s=trip] .wtsl-dot{background:#f85149;box-shadow:0 0 6px #f85149}',
'.wtsl-brand[data-s=manual]{background:rgba(210,153,34,.12);border-color:rgba(210,153,34,.5)}.wtsl-brand[data-s=manual] .wtsl-dot{background:#d29922;box-shadow:0 0 6px #d29922}',
'.wtsl-only-sm{display:none!important}',
'.wtsl-viz[data-bp=sm] .wtsl-only-sm{display:inline-flex!important}',
'.wtsl-viz[data-bp=sm] .wtsl-hide-sm{display:none!important}',
'.wtsl-viz[data-bp=md] .wtsl-hide-md{display:none!important}',
'.wtsl-viz[data-bp=md] .wtsl-txt-md{display:none}',
'.wtsl-viz[data-bp=lg] .wtsl-only-mdsm,.wtsl-viz[data-bp=lg] .wtsl-speedchip{display:none!important}',
'.wtsl-viz:not([data-bp=lg]) .wtsl-speeds{display:none}',
'.wtsl-viz[data-mode="2d"] .wtsl-only3d{display:none!important}',
/* menus, popovers */
'.wtsl-menu,.wtsl-pop{position:absolute;z-index:20;min-width:196px;max-width:calc(100% - 16px);max-height:calc(100% - 16px);overflow:auto;padding:5px;border-radius:9px;',
' background:var(--hmi-solid);border:1px solid var(--hmi-line);box-shadow:0 14px 34px rgba(0,0,0,.55);animation:wtsl-in .14s ease-out}',
'.wtsl-mi{display:flex;width:100%;height:32px;align-items:center;gap:8px;padding:0 10px;border:0;border-radius:6px;background:none;color:#e6edf3;text-align:left;cursor:pointer;font-size:12.5px}',
'.wtsl-mi:hover{background:rgba(240,136,62,.13)}',
'.wtsl-mi .ck{width:14px;height:14px;flex:none;color:var(--hmi-sel)}',
'.wtsl-mi .ck svg{width:14px;height:14px}',
'.wtsl-mi .k{margin-left:auto;padding-left:14px;color:#6e7681;font:600 10.5px/1 var(--hmi-mono)}',
'.wtsl-mi.dng{color:#ff7b72}',
'.wtsl-mh{font:700 9.5px/1 system-ui,sans-serif;letter-spacing:.8px;text-transform:uppercase;color:#6e7681;padding:9px 10px 5px}',
'.wtsl-conf{padding:10px 10px 6px;font-size:12.5px;max-width:280px}',
'.wtsl-conf p{margin:0 0 9px;color:#e6edf3}.wtsl-conf .sub{color:#8b949e;font-size:11.5px;margin-top:-5px}',
'.wtsl-conf .row{display:flex;gap:6px;justify-content:flex-end}',
'.wtsl-b.pri{background:#da3633;border-color:#f85149;color:#fff;font-weight:600}',
'.wtsl-b.pri:hover{background:#f85149}',
'.wtsl-b.acc{background:rgba(240,136,62,.9);border-color:#f0883e;color:#fff;font-weight:600}',
/* alarm pill / banner */
'.wtsl-alarm{z-index:10;display:flex;align-items:center;gap:8px;height:30px;padding:0 5px 0 12px;border-radius:15px;max-width:min(640px,calc(100% - 20px));',
' font-size:12px;cursor:pointer;border:1px solid transparent;white-space:nowrap;background:var(--hmi-solid);align-self:center;flex:none}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-alarm{position:absolute;top:58px;left:50%;transform:translateX(-50%)}',
'.wtsl-viz[data-mode="2d"] .wtsl-alarm,.wtsl-viz[data-bp=sm] .wtsl-alarm{margin:6px 8px 0}',
'.wtsl-alarm .g{font-size:13px}.wtsl-alarm .eq{font-weight:700;letter-spacing:.5px}.wtsl-alarm .tg{font:600 11px/1 var(--hmi-mono);opacity:.9}',
'.wtsl-alarm .msg{overflow:hidden;text-overflow:ellipsis;min-width:0;color:#e6edf3}',
'.wtsl-alarm .more{font:700 10.5px/1 var(--hmi-mono);opacity:.85}',
'.wtsl-alarm .rtn{font:700 9.5px/1 system-ui;letter-spacing:.6px;padding:3px 5px;border-radius:4px;background:rgba(139,148,158,.25);color:#e6edf3}',
'.wtsl-alarm .wtsl-b{height:22px;padding:0 8px;font-size:11px;border-radius:11px}',
'.wtsl-alarm[data-sev=alarm]{background:rgba(58,17,19,.92);border-color:rgba(248,81,73,.6);color:#ff7b72}',
'.wtsl-alarm[data-sev=warn]{background:rgba(52,39,8,.92);border-color:rgba(210,153,34,.6);color:#e3b341}',
'.wtsl-alarm[data-sev=hyd]{background:rgba(12,33,60,.92);border-color:rgba(88,166,255,.55);color:#79c0ff}',
'.wtsl-alarm.unack{animation:wtsl-flash 1s steps(1,end) infinite}',
'.wtsl-alarm.isrtn{opacity:.55}',
'.wtsl-alarm.banner{height:auto;min-height:32px;padding:5px 5px 5px 12px;border-radius:9px;white-space:normal;cursor:default;animation:none;opacity:1}',
'.wtsl-alarm.banner .msg{white-space:nowrap}',
'.wtsl-alarm.banner.trip{background:rgba(70,16,18,.95);border-color:#f85149;color:#ffa198;box-shadow:0 0 22px rgba(248,81,73,.35)}',
'.wtsl-alarm.banner.manual{background:rgba(58,43,6,.95);border-color:#d29922;color:#e3b341}',
'.wtsl-alarm.banner b{letter-spacing:.6px}',
'.wtsl-alarm.banner .wtsl-b{height:24px;border-radius:6px}',
/* drawer */
'.wtsl-drawer{position:absolute;z-index:20;left:50%;transform:translateX(-50%);top:8px;width:min(460px,calc(100% - 20px));max-height:calc(100% - 16px);',
' display:flex;flex-direction:column;border-radius:10px;background:var(--hmi-glass-strong);background:rgba(13,17,23,.95);border:1px solid var(--hmi-line);box-shadow:0 14px 36px rgba(0,0,0,.55)}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-drawer{top:96px;max-height:calc(100% - 182px)}',
'.wtsl-dtabs{display:flex;gap:4px;padding:6px 6px 0;border-bottom:1px solid var(--hmi-line)}',
'.wtsl-dtabs button{height:30px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:none;color:#8b949e;cursor:pointer;font-weight:600}',
'.wtsl-dtabs button.on{color:#e6edf3;border-bottom-color:var(--hmi-sel)}',
'.wtsl-dbody{overflow:auto;padding:4px 6px;min-height:60px;flex:1 1 auto}',
'.wtsl-row{display:grid;grid-template-columns:auto 58px 70px 1fr auto;gap:8px;align-items:center;padding:6px 6px;border-radius:6px;cursor:pointer;font-size:12px}',
'.wtsl-row:hover{background:rgba(240,136,62,.08)}',
'.wtsl-row .t{font:11px/1 var(--hmi-mono);color:#8b949e}.wtsl-row .tg{font:600 11px/1 var(--hmi-mono)}',
'.wtsl-row .m{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wtsl-row .s{font:700 9.5px/1 system-ui;letter-spacing:.5px;color:#8b949e}',
'.wtsl-row .wtsl-b{height:22px;padding:0 8px;font-size:11px}',
'.wtsl-sev{display:inline-block;min-width:44px;padding:3px 5px;border-radius:4px;font:700 9px/1 system-ui;letter-spacing:.6px;text-align:center;text-transform:uppercase}',
'.wtsl-sev[data-s=trip],.wtsl-sev[data-s=alarm]{background:rgba(248,81,73,.2);color:#ff7b72}',
'.wtsl-sev[data-s=warn]{background:rgba(210,153,34,.2);color:#e3b341}.wtsl-sev[data-s=hyd]{background:rgba(88,166,255,.18);color:#79c0ff}',
'.wtsl-sev[data-s=info],.wtsl-sev[data-s=event],.wtsl-sev[data-s=evt]{background:rgba(188,140,255,.16);color:#d2a8ff}',
'.wtsl-row.unack .m{font-weight:700}.wtsl-row.rtn{opacity:.6}',
'.wtsl-ev{display:grid;grid-template-columns:62px 58px 1fr;gap:8px;padding:4px 6px;font-size:11.5px;border-bottom:1px solid rgba(48,54,61,.45)}',
'.wtsl-ev .t{font:11px/1.3 var(--hmi-mono);color:#8b949e}.wtsl-ev .ty{font:700 9px/1.4 system-ui;letter-spacing:.5px;text-transform:uppercase;color:#6e7681}',
'.wtsl-dh{font:700 9.5px/1 system-ui;letter-spacing:.8px;text-transform:uppercase;color:#6e7681;padding:10px 6px 4px}',
'.wtsl-dw{padding:4px 6px;font-size:11.5px;color:#c9d1d9}',
'.wtsl-empty{padding:14px 8px;color:#6e7681;font-size:12px;text-align:center}',
'.wtsl-dfoot{display:flex;gap:6px;justify-content:flex-end;padding:6px;border-top:1px solid var(--hmi-line)}',
/* HUD */
'.wtsl-hud{z-index:10;flex:none;height:56px;border-radius:10px;background:var(--hmi-glass-strong);border:1px solid var(--hmi-line);box-shadow:0 6px 22px rgba(0,0,0,.35);overflow:hidden}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-hud{position:absolute;left:10px;right:10px;bottom:10px}',
'.wtsl-viz[data-mode="2d"] .wtsl-hud,.wtsl-viz[data-bp=sm] .wtsl-hud{margin:0 8px 8px}',
'.wtsl-hgrid{display:grid;grid-template-columns:176px 1.3fr 1.35fr .95fr 172px;height:100%}',
'.wtsl-viz[data-bp=md] .wtsl-hgrid{grid-template-columns:150px 1.35fr 1fr 158px}',
'.wtsl-viz[data-bp=md] .g-cum,.wtsl-viz[data-bp=md] .h-bsw,.wtsl-viz[data-bp=md] .h-gor{display:none}',
'.wtsl-viz[data-bp=md] .wtsl-tb{gap:4px}.wtsl-viz[data-bp=md] .wtsl-sep,.wtsl-viz[data-bp=md] [data-act=labels] small{display:none}',
'.wtsl-hg{padding:5px 10px;border-left:1px solid var(--hmi-line);min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1px;overflow:hidden}',
'.wtsl-hg:first-child{border-left:0}',
'.wtsl-hl{font:600 9px/1.15 system-ui,sans-serif;letter-spacing:.5px;text-transform:uppercase;color:#6e7681;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.wtsl-hl i{font-style:normal;font-size:8.5px;letter-spacing:0;text-transform:none;color:#565d66;margin-left:3px}',
'.wtsl-hv{font:600 15px/1.2 var(--hmi-mono);font-variant-numeric:tabular-nums;color:#e6edf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.wtsl-hv.p{color:#f0883e}',
'.wtsl-hu{font:500 10px/1 system-ui,sans-serif;color:#6e7681;margin-left:2px}',
'.wtsl-ha{font-size:9px;color:#8b949e;margin-left:2px;display:inline-block;width:8px}',
'.wtsl-hrow{display:flex;gap:8px;min-width:0}',
'.wtsl-hi{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}.wtsl-hsep{flex:1.4 1 auto}',
'.wtsl-clock{font:600 18px/1.1 var(--hmi-mono);font-variant-numeric:tabular-nums;letter-spacing:.3px;white-space:nowrap}',
'.wtsl-clock small{font-size:11px;color:#6e7681;margin-right:3px}',
'.wtsl-hst{display:flex;align-items:center;gap:7px;margin-top:2px}',
'.wtsl-hst .wtsl-b{height:20px;padding:0 6px;font:600 10.5px/1 var(--hmi-mono)}',
'.wtsl-state{font:700 9.5px/1 system-ui,sans-serif;letter-spacing:.8px;display:inline-flex;align-items:center;gap:5px;color:#3fb950;white-space:nowrap}',
'.wtsl-state::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
'.wtsl-state[data-s=run]::before{animation:wtsl-pulse 2s ease-in-out infinite}',
'.wtsl-state[data-s=paused]{color:#6e7681}.wtsl-state[data-s=trip]{color:#f85149}.wtsl-state[data-s=manual]{color:#d29922}',
'.wtsl-sepbar{position:relative;width:100%;max-width:120px;height:6px;margin-top:2px;border-radius:3px;background:#21262d;overflow:visible}',
'.wtsl-sepbar .band{position:absolute;top:0;bottom:0;background:rgba(63,185,80,.45);border-radius:2px}',
'.wtsl-sepbar .tk{position:absolute;top:-2px;width:2px;height:10px;border-radius:1px}',
'.wtsl-sepbar .mk{position:absolute;top:-3px;width:3px;height:12px;border-radius:1px;background:#fff;box-shadow:0 0 4px rgba(255,255,255,.6);margin-left:-1px}',
'.wtsl-tl{font:500 11px/1.28 var(--hmi-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#c9d1d9}',
'.wtsl-tl b{color:#e6edf3;font-weight:600}.wtsl-tl .a{color:var(--hmi-sel)}',
'.wtsl-tl.al{color:#6e7681}.wtsl-tl.al[data-l=alarm]{color:#ff7b72}.wtsl-tl.al[data-l=warn]{color:#e3b341}.wtsl-tl.al[data-l=hyd]{color:#79c0ff}',
'.wtsl-tiles{display:none;grid-template-columns:repeat(3,1fr);grid-template-rows:64px 64px;height:128px}',
'.wtsl-viz[data-bp=sm] .wtsl-hud{height:128px}',
'.wtsl-viz[data-bp=sm] .wtsl-hgrid{display:none}.wtsl-viz[data-bp=sm] .wtsl-tiles{display:grid}',
'.wtsl-tile{padding:7px 9px;border-left:1px solid var(--hmi-line);border-top:1px solid var(--hmi-line);min-width:0;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;justify-content:center;gap:1px}',
'.wtsl-tile:nth-child(3n+1){border-left:0}.wtsl-tile:nth-child(-n+3){border-top:0}',
'.wtsl-tile .v{font:600 13px/1.25 var(--hmi-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.wtsl-tile .v2{font:500 10px/1.25 var(--hmi-mono);color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.wtsl-pop{padding:8px 10px;min-width:220px}',
'.wtsl-pop .r{display:flex;justify-content:space-between;gap:14px;padding:3px 0;font-size:12px}.wtsl-pop .r span:first-child{color:#8b949e}',
'.wtsl-pop .r span:last-child{font:600 12px/1.3 var(--hmi-mono)}',
/* stage overlays */
'.wtsl-paused{position:absolute;z-index:10;left:10px;top:8px;padding:5px 9px;border-radius:5px;background:rgba(13,17,23,.88);border:1px solid #30363d;',
' font:700 10px/1 system-ui,sans-serif;letter-spacing:1.6px;color:#8b949e;pointer-events:none}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-paused{top:60px}',
'.wtsl-loading{position:absolute;inset:0;z-index:25;display:flex;align-items:center;justify-content:center;transition:opacity .5s ease}',
'.wtsl-loading.out{opacity:0;pointer-events:none}',
'.wtsl-lcard{width:240px;padding:16px 16px 12px;border-radius:12px;background:var(--hmi-solid);border:1px solid var(--hmi-line);text-align:center;box-shadow:0 14px 40px rgba(0,0,0,.5)}',
'.wtsl-lcard .ttl{font:700 10px/1 system-ui;letter-spacing:1.4px;color:#8b949e;text-transform:uppercase}',
'.wtsl-lcard .st{margin-top:4px;font-size:12.5px;color:#e6edf3;min-height:17px}',
'.wtsl-lcard .slow{margin-top:4px;font-size:11px;color:#8b949e}',
'.wtsl-shim{position:relative;width:160px;height:2px;margin:12px auto;background:#21262d;overflow:hidden;border-radius:1px}',
'.wtsl-shim::after{content:"";position:absolute;top:0;bottom:0;left:-40%;width:40%;background:linear-gradient(90deg,transparent,#f0883e,transparent);animation:wtsl-shim 1.2s linear infinite}',
'.wtsl-link{border:0;background:none;color:#58a6ff;cursor:pointer;font-size:12px;padding:4px 6px;text-decoration:underline;text-underline-offset:2px}',
'.wtsl-notice{position:absolute;z-index:25;top:10px;left:10px;max-width:calc(100% - 20px);padding:7px 7px 7px 12px;border-radius:8px;background:var(--hmi-solid);',
' border:1px solid var(--hmi-line);border-left:3px solid #58a6ff;font-size:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;box-shadow:0 10px 26px rgba(0,0,0,.45)}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-notice{top:60px}',
'.wtsl-notice .wtsl-b{height:26px}',
// 2D: dock the notice in the stage flow above the host diagram so it never covers the diagram title.
'.wtsl-viz[data-mode="2d"] .wtsl-notice{position:static;order:-1;align-self:flex-start;flex:none;flex-wrap:nowrap;max-width:100%;box-shadow:none;margin:0}',
// …and never let the in-flow 2D content be clipped at the top (safe centring) or overflow the HUD on phones (grow the stage).
'.wtsl-viz[data-mode="2d"] .wtsl-stage{justify-content:safe center}',
'.wtsl-viz[data-bp=sm][data-mode="2d"]:not(.is-max) .wtsl-stage{height:auto;min-height:clamp(320px,58vh,480px)}',
'.wtsl-toasts{position:absolute;z-index:30;left:10px;bottom:10px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;pointer-events:none;max-width:calc(100% - 20px)}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-toasts{bottom:76px}',
'.wtsl-toast{pointer-events:auto;max-width:380px;padding:7px 11px;border-radius:8px;background:var(--hmi-solid);border:1px solid var(--hmi-line);',
' font-size:12px;color:#e6edf3;box-shadow:0 8px 22px rgba(0,0,0,.45);animation:wtsl-in .18s ease-out;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
'.wtsl-toast.bad{border-color:rgba(248,81,73,.6)}.wtsl-toast.ok{border-color:rgba(63,185,80,.5)}',
'.wtsl-toast .wtsl-b{height:24px;padding:0 8px}',
'.wtsl-toast.gone{opacity:0;transition:opacity .3s}',
/* info card */
'.wtsl-icard{position:absolute;z-index:12;right:10px;top:10px;bottom:10px;width:320px;border-radius:12px;background:var(--hmi-glass-strong);',
' border:1px solid var(--hmi-line);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,.5);animation:wtsl-cardin .18s ease-out}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-icard{top:60px;bottom:76px}',
'.wtsl-viz[data-bp=md] .wtsl-icard{width:280px}',
'.wtsl-viz[data-bp=sm] .wtsl-icard{left:0;right:0;bottom:0;top:auto;width:auto;height:min(52vh,420px);max-height:100%;border-radius:14px 14px 0 0;background:rgba(13,17,23,.97);animation:wtsl-sheet .2s ease-out}',
'.wtsl-grab{display:none;width:36px;height:4px;border-radius:2px;background:#484f58;margin:7px auto 0;flex:none}',
'.wtsl-viz[data-bp=sm] .wtsl-grab{display:block}',
'.wtsl-ch{display:flex;align-items:center;gap:8px;height:48px;padding:0 6px 0 12px;border-bottom:1px solid var(--hmi-line);flex:none}',
'.wtsl-ch .n{font-size:17px;color:var(--hmi-sel)}',
'.wtsl-ch .tt{min-width:0;flex:1 1 auto}.wtsl-ch .tt b{display:block;font:700 12px/1.2 var(--hmi-mono)}.wtsl-ch .tt span{display:block;font-size:11px;color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.wtsl-chip{font:700 9.5px/1 system-ui;letter-spacing:.7px;padding:4px 7px;border-radius:10px;background:rgba(63,185,80,.14);color:#56d364;text-transform:uppercase}',
'.wtsl-chip[data-s=alarm]{background:rgba(248,81,73,.18);color:#ff7b72}.wtsl-chip[data-s=warn]{background:rgba(210,153,34,.18);color:#e3b341}',
'.wtsl-chip[data-s=hyd]{background:rgba(88,166,255,.16);color:#79c0ff}.wtsl-chip[data-s=evt]{background:rgba(188,140,255,.16);color:#d2a8ff}',
'.wtsl-cb{overflow:auto;padding:8px 12px 10px;flex:1 1 auto;display:flex;flex-direction:column;gap:9px}',
'.wtsl-kv{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}',
'.wtsl-kv div{min-width:0}.wtsl-kv .l{font:600 9.5px/1.2 system-ui;letter-spacing:.6px;text-transform:uppercase;color:#6e7681}',
'.wtsl-kv .v{font:600 13.5px/1.3 var(--hmi-mono);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.wtsl-kv .v.p{color:#f0883e}.wtsl-kv .v.t{color:#58a6ff}.wtsl-kv .d{font:500 10px/1.2 var(--hmi-mono);color:#6e7681;white-space:nowrap}',
'.wtsl-sk{display:block;width:100%;height:56px;border-radius:6px;background:rgba(1,4,9,.55)}',
'.wtsl-skl{display:flex;justify-content:space-between;font:10px/1.2 system-ui;color:#6e7681;margin-top:-4px}',
'.wtsl-sh{font:700 9.5px/1 system-ui;letter-spacing:.8px;text-transform:uppercase;color:#6e7681;margin-bottom:-3px}',
'.wtsl-bar{position:relative;height:10px;border-radius:5px;background:#21262d;overflow:hidden}',
'.wtsl-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:5px;background:linear-gradient(90deg,#3fb950,#56d364)}',
'.wtsl-bar[data-l=warn] i{background:linear-gradient(90deg,#9e6a03,#d29922)}.wtsl-bar[data-l=alarm] i{background:linear-gradient(90deg,#b62324,#f85149)}',
'.wtsl-barl{display:flex;justify-content:space-between;font:500 10.5px/1.3 var(--hmi-mono);color:#8b949e;margin-top:3px}',
'.wtsl-act{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
'.wtsl-act .wtsl-b{height:28px}',
'.wtsl-act .val{font:600 13px/1 var(--hmi-mono);min-width:52px;text-align:center}',
'.wtsl-actr{display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%}',
'.wtsl-actr>.wtsl-hl{min-width:74px}',
'.wtsl-b.vopen{border-color:#3fb950;color:#3fb950;background:rgba(63,185,80,.14)}',
'.wtsl-b.vshut{border-color:#f85149;color:#f85149}',
'.wtsl-b.vmove{border-color:#d29922;color:#d29922;background:rgba(210,153,34,.14)}',
'.wtsl-b.trip{border-color:#f85149;color:#fff;background:rgba(248,81,73,.3)}',
/* zoomed tank valve inset (phones / coarse pointers): every control ≥ 44 × 44 CSS px (WCAG 2.5.5, Apple HIG) */
'.wtsl-vin{position:absolute;z-index:22;left:50%;bottom:10px;transform:translateX(-50%);width:min(380px,calc(100% - 16px));max-height:calc(100% - 20px);overflow:auto;',
' padding:10px 12px;border-radius:12px;background:rgba(13,17,23,.97);border:1px solid var(--hmi-line);box-shadow:0 18px 44px rgba(0,0,0,.6)}',
'.wtsl-vin h4{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 6px;font:700 11px/1.2 system-ui;letter-spacing:.8px;text-transform:uppercase;color:#8b949e}',
'.wtsl-vin .wtsl-actr{margin:6px 0}.wtsl-vin .val{font:600 13px/1.2 var(--hmi-mono)}',
'.wtsl-viz .wtsl-vin .wtsl-b{min-height:44px;height:44px;min-width:44px;padding:0 12px;font-size:13px}',
'.wtsl-bt{width:100%;border-collapse:collapse;font:11px/1.3 var(--hmi-mono)}',
'.wtsl-bt th{font:600 9px/1.2 system-ui;letter-spacing:.5px;text-transform:uppercase;color:#6e7681;text-align:right;padding:2px 3px}',
'.wtsl-bt td{text-align:right;padding:2px 3px;border-top:1px solid rgba(48,54,61,.5)}.wtsl-bt th:first-child,.wtsl-bt td:first-child{text-align:left}',
'.wtsl-cf{flex:none;padding:6px 12px 8px;border-top:1px solid var(--hmi-line)}',
'.wtsl-cvs{display:block}',
/* legend and trends */
'.wtsl-legend{position:absolute;z-index:10;left:10px;bottom:10px;width:236px;padding:9px 11px;border-radius:10px;background:var(--hmi-glass-strong);background:rgba(13,17,23,.9);border:1px solid var(--hmi-line);font-size:11.5px}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-legend{bottom:76px}',
'.wtsl-legend .lh{font:700 9.5px/1 system-ui;letter-spacing:.8px;text-transform:uppercase;color:#6e7681;margin:6px 0 4px}',
'.wtsl-legend .lh:first-child{margin-top:0}',
'.wtsl-viz[data-mode="2d"] .wtsl-legend{position:static;width:auto;display:flex;flex-wrap:wrap;align-items:center;gap:2px 0;padding:4px 10px;flex:none;background:rgba(13,17,23,.6)}',
'.wtsl-viz[data-mode="2d"] .wtsl-legend .lh{margin:0 8px 0 4px}.wtsl-viz[data-mode="2d"] .wtsl-legend .li{margin:0 9px 0 0}',
'.wtsl-legend .li{display:inline-flex;align-items:center;gap:5px;margin:0 9px 3px 0;color:#c9d1d9}',
'.wtsl-legend .sw{width:11px;height:11px;border-radius:3px;display:inline-block;border:1px solid rgba(255,255,255,.15)}',
'.wtsl-legend .cb{height:8px;border-radius:4px;margin:2px 0 2px}',
'.wtsl-legend .cbl{display:flex;justify-content:space-between;font:10px/1.2 var(--hmi-mono);color:#8b949e}',
'.wtsl-legend .note{margin-top:6px;font-size:10px;color:#6e7681;line-height:1.3}',
'.wtsl-trends{position:absolute;z-index:10;right:10px;bottom:10px;padding:8px 10px;border-radius:10px;background:rgba(13,17,23,.9);border:1px solid var(--hmi-line);',
' display:grid;grid-template-columns:160px 160px;gap:6px 10px}',
'.wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-trends{bottom:76px}',
'.wtsl-viz.card-open:not([data-bp=sm]) .wtsl-trends{right:340px}',
'.wtsl-viz[data-bp=sm] .wtsl-trends{left:8px;right:56px;bottom:8px;grid-template-columns:1fr 1fr;gap:4px 8px;padding:6px 8px}',
'.wtsl-viz[data-bp=sm][data-mode="3d"] .wtsl-legend{left:8px;right:8px;top:8px;bottom:auto;width:auto;padding:6px 9px}',
'.wtsl-viz[data-bp=sm] .wtsl-legend .note,.wtsl-viz[data-bp=sm] .wtsl-legend .lh{display:none}',
'.wtsl-viz[data-mode="2d"] .wtsl-trends.inflow{position:static;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:rgba(13,17,23,.6);flex:none}',
'.wtsl-tr .l{font:600 9.5px/1.2 system-ui;letter-spacing:.6px;text-transform:uppercase;color:#6e7681;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.wtsl-tr .l b{font:600 10.5px/1 var(--hmi-mono);color:#c9d1d9;letter-spacing:0;text-transform:none;float:right}',
'.wtsl-tr canvas{display:block;width:100%;height:40px;border-radius:4px;background:rgba(1,4,9,.5)}',
'.wtsl-fsbtn{position:absolute;z-index:10;right:10px;bottom:10px;width:40px;height:40px;border-radius:20px;display:none;align-items:center;justify-content:center;',
' background:rgba(13,17,23,.9);border:1px solid var(--hmi-line);color:#e6edf3;cursor:pointer}',
'.wtsl-viz[data-bp=sm][data-mode="3d"] .wtsl-fsbtn{display:flex}.wtsl-viz.card-open .wtsl-fsbtn{display:none!important}',
'.wtsl-fsbtn svg{width:18px;height:18px}',
'.wtsl-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
'.wtsl-keys{position:absolute;z-index:25;left:50%;top:50%;transform:translate(-50%,-50%);width:min(420px,calc(100% - 20px));max-height:calc(100% - 20px);overflow:auto;',
' padding:12px 14px;border-radius:12px;background:rgba(13,17,23,.96);border:1px solid var(--hmi-line);box-shadow:0 18px 44px rgba(0,0,0,.6)}',
'.wtsl-keys h4{margin:0 0 8px;font:700 10px/1 system-ui;letter-spacing:1.2px;text-transform:uppercase;color:#8b949e}',
'.wtsl-keys .kr{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px;border-bottom:1px solid rgba(48,54,61,.4)}',
'.wtsl-keys kbd{font:600 11px/1 var(--hmi-mono);padding:3px 6px;border-radius:4px;background:#21262d;border:1px solid #30363d;color:#e6edf3}',
/* glass: only toolbar, HUD and card, desktop pointers only, never when low-perf (§6.2, K19/K43) */
'@media (pointer:fine){.wtsl-viz:not(.lowperf)[data-mode="3d"] .wtsl-tb,.wtsl-viz:not(.lowperf)[data-mode="3d"] .wtsl-hud,.wtsl-viz:not(.lowperf) .wtsl-icard{',
' background:var(--hmi-glass);-webkit-backdrop-filter:blur(8px) saturate(1.2);backdrop-filter:blur(8px) saturate(1.2)}}',
'@media (pointer:coarse){.wtsl-b{height:40px;min-width:40px}.wtsl-b.ic{width:40px}.wtsl-tb{height:48px}.wtsl-segc{height:40px}',
' .wtsl-speeds .wtsl-b,.wtsl-hst .wtsl-b,.wtsl-alarm .wtsl-b,.wtsl-row .wtsl-b,.wtsl-act .wtsl-b,.wtsl-notice .wtsl-b,.wtsl-toast .wtsl-b{height:32px}',
' .wtsl-viz[data-mode="3d"]:not([data-bp=sm]) .wtsl-alarm{top:66px}',
' .wtsl-b::before,.wtsl-mi::before,.wtsl-segc button::before,.wtsl-fsbtn::before{content:"";position:absolute;inset:-6px}}',
'body.wtsl-max{overflow:hidden!important}',
'.wtsl-viz.is-max{position:fixed;inset:0;z-index:1000;height:auto!important;border-radius:0;',
' padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}',
'.wtsl-viz.is-max .wtsl-stage{height:auto;flex:1 1 0;min-height:0}',
'@media (orientation:landscape) and (max-height:500px){.wtsl-viz.is-max[data-bp=sm] .wtsl-hud{height:44px}.wtsl-viz.is-max[data-bp=sm] .wtsl-tiles{grid-template-columns:repeat(6,1fr);grid-template-rows:44px;height:44px}',
' .wtsl-viz.is-max[data-bp=sm] .wtsl-tile{border-top:0!important;border-left:1px solid var(--hmi-line)!important;padding:4px 7px}.wtsl-viz.is-max[data-bp=sm] .wtsl-tile .v2{display:none}}',
/* Rig-up card (a page card below the live view, host theme; report-friendly .rrow rows + Note boxes) */
'.wtsl-rig-intro{font-size:12px;color:var(--text2,#8b949e);margin:-2px 0 8px;line-height:1.4}',
'.wtsl-rig-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px}',
'@media (max-width:760px){.wtsl-rig-list{grid-template-columns:minmax(0,1fr)}}',
'.wtsl-rig .rrow.wtsl-rig-row{gap:10px;padding:6px 0}',
'.wtsl-rig .wtsl-rig-row .rl{flex:1 1 auto;min-width:0;font-size:13px}',
'.wtsl-rig .wtsl-rig-row .rv{font-size:12px;font-weight:600;white-space:nowrap;color:var(--green,#3fb950)}',
'.wtsl-rig .wtsl-rig-row.off .rv{color:var(--yellow,#d29922)}.wtsl-rig .wtsl-rig-row.info .rv{color:var(--text2,#8b949e);white-space:normal;text-align:right}',
'.wtsl-rig .wtsl-rig-row.off .rl{color:var(--text2,#8b949e)}',
'.wtsl-sw{position:relative;flex:none;box-sizing:border-box;width:42px;height:24px;margin:0;padding:0;border-radius:12px;border:1px solid var(--border,#30363d);',
' background:var(--bg3,#21262d);cursor:pointer;transition:background .15s,border-color .15s}',
'.wtsl-sw i{position:absolute;top:50%;left:3px;width:16px;height:16px;margin-top:-8px;border-radius:50%;background:var(--text3,#6e7681);transition:left .15s,background .15s}',
'.wtsl-sw[aria-checked=true]{background:rgba(63,185,80,.22);border-color:var(--green,#3fb950)}',
'.wtsl-sw[aria-checked=true] i{left:21px;background:var(--green,#3fb950)}',
'.wtsl-sw:disabled{opacity:.5;cursor:not-allowed}',
'.wtsl-sw:focus-visible,.wtsl-rig-all:focus-visible{outline:2px solid var(--accent,#f0883e);outline-offset:2px}',
'.wtsl-rig-note{margin-top:8px;padding:7px 10px;border-left:3px solid var(--yellow,#d29922);background:rgba(210,153,34,.08);border-radius:4px;font-size:12px;line-height:1.45;color:var(--text,#e6edf3)}',
'.wtsl-rig-note b{margin-right:6px;color:var(--yellow,#d29922)}',
'.wtsl-rig-foot{margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
'.wtsl-rig-all{height:28px;padding:0 12px;border-radius:6px;border:1px solid var(--border,#30363d);background:var(--bg2,#161b22);color:var(--text,#e6edf3);font:inherit;font-size:12px;cursor:pointer}',
'.wtsl-rig-all:disabled{opacity:.5;cursor:default}',
'.wtsl-rigout{font-size:11.5px;color:#e3b341;background:rgba(210,153,34,.12);border-radius:6px;padding:6px 8px}',
'@keyframes wtsl-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
'@keyframes wtsl-flash{0%{opacity:1}50%{opacity:.55}}',
'@keyframes wtsl-shim{0%{left:-40%}100%{left:100%}}',
'@keyframes wtsl-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
'@keyframes wtsl-cardin{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}',
'@keyframes wtsl-sheet{from{transform:translateY(40px);opacity:.4}to{transform:none;opacity:1}}',
'@media (prefers-reduced-motion:reduce){.wtsl-viz *,.wtsl-viz *::before,.wtsl-viz *::after{animation:none!important;transition:none!important}}'
].join('\n');

// ═══════════════════════════════════════════════════════════════════
// §D SESSION STATE (survives navigation within the page session, D10)
// ═══════════════════════════════════════════════════════════════════
var _sim = null;            // the live sim instance
var _lastFlowObj = null;    // identity of the last flow handed to the sim (K57: never compare seq/ts)
var _resetPending = false;  // project Open/New → reset on the next applied flow
var _alarmMap = {};         // operator lifecycle map (UNACK/ACK/RTN)
var _ctl = null;            // current controller
var _sessionHooked = false;
var _rigPending = false;     // project Open/New → re-apply the saved rig-up on the next applied flow

function hookSession() {
    if (_sessionHooked || typeof document === 'undefined' || !document.addEventListener) return;
    _sessionHooked = true;
    var onProj = function () { _resetPending = true; _alarmMap = {}; _rigPending = true; };
    document.addEventListener('wts:project-loaded', onProj);
    document.addEventListener('wts:project-new', onProj);
}

function readPrefs() {
    var p = {}, k;
    for (k in PREF_DEFAULTS) p[k] = PREF_DEFAULTS[k];
    try {
        var raw = G.localStorage && G.localStorage.getItem(PREFS_KEY);
        var o = raw ? JSON.parse(raw) : null;
        if (o && typeof o === 'object') {
            if (o.mode === '3d' || o.mode === '2d') p.mode = o.mode;
            if (/^(all|equip|off)$/.test(o.labels)) p.labels = o.labels;
            if (/^(phase|pressure|temperature|erosion)$/.test(o.overlay)) p.overlay = o.overlay;
            if (/^(auto|high|medium|low)$/.test(o.quality)) p.quality = o.quality;
            if (SPEEDS.indexOf(+o.speed) >= 0) p.speed = +o.speed;
            ['legend', 'trends', 'orbit'].forEach(function (b) { if (typeof o[b] === 'boolean') p[b] = o[b]; });
            // operator lineup (divert valves, pump suction, auto-divert): shape-checked here, value-checked by WTS_sim.setControls
            if (o.ctl && typeof o.ctl === 'object' && o.ctl.surge && typeof o.ctl.surge === 'object' && o.ctl.gauge && typeof o.ctl.gauge === 'object') p.ctl = deepClone(o.ctl);
        }
    } catch (e) {}
    return p;
}
function writePrefs(p) { try { if (G.localStorage) G.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {} }
// Rig-up items [{key, tag, name, locked, why}] from WTS_sim (fallback: local list)
function rigItems() {
    var S = G.WTS_sim;
    if (S && Array.isArray(S.RIGUP) && S.RIGUP.length) return S.RIGUP;
    return RIG_FALLBACK.map(function (r) { return { key: r[0], tag: r[1], name: r[2], locked: !!r[3], why: '' }; });
}
// saved rig-up request {key: bool} (only booleans for known keys; anything else → null = full rig-up)
function readRig() {
    try {
        var raw = G.localStorage && G.localStorage.getItem(RIG_KEY);
        var o = raw ? JSON.parse(raw) : null;
        if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
        var out = {}, n = 0;
        rigItems().forEach(function (it) { if (typeof o[it.key] === 'boolean') { out[it.key] = o[it.key]; n++; } });
        return n ? out : null;
    } catch (e) { return null; }
}
function writeRig(r) {
    try {
        if (!G.localStorage) return;
        var full = true; for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k) && r[k] === false) full = false;
        if (full) G.localStorage.removeItem(RIG_KEY); else G.localStorage.setItem(RIG_KEY, JSON.stringify(r));
    } catch (e) {}
}
// equipment out of the rig-up (snapshot st.rigup; older snapshots: everything in)
function rigOut(st, id) { var r = st && st.rigup; return !!(r && r[id] === false); }
// surge outlet transfer LCV-201 (no pump; snapshot surge.transfer, legacy surge.pump) — short state text
function xferOf(st) { var su = st && st.surge; return su ? (su.transfer || su.pump || null) : null; }
function xferShort(st) {
    var p = xferOf(st);
    if (!p) return '—';
    if (rigOut(st, 'surge')) return 'OUT';
    return p.failed ? 'STUCK SHUT' : p.tripped ? 'TRIP' : p.blocked ? 'BLOCKED' : p.on ? (p.lowDP ? 'OPEN · LOW ΔP' : 'OPEN') : 'SHUT';
}
// P-201 (gauge tank → export / burner) — state text
function pumpShort(st) {
    var p = st && st.gauge && st.gauge.pump;
    if (!p) return '—';
    if (p.mode === 'none') return 'OUT (no gauge tank)';
    if (p.mode === 'gravity') return 'NOT IN RIG-UP · gravity drain';
    return p.failed ? 'FAILED' : p.on ? 'RUNNING' : 'STANDBY';
}
function ssGet(k) { try { return G.sessionStorage ? G.sessionStorage.getItem(k) : null; } catch (e) { return null; } }
function ssSet(k, v) { try { if (G.sessionStorage) G.sessionStorage.setItem(k, v); } catch (e) {} }
function track(name, params) { try { if (typeof G.h2oilTrack === 'function') G.h2oilTrack(name, params || {}); } catch (e) {} }
function nowMs() { try { if (G.performance && typeof G.performance.now === 'function') return G.performance.now(); } catch (e) {} return Date.now(); }
function hostEl(id) { try { return document.getElementById(id); } catch (e) { return null; } }
// readHost(id): canonical (imperial) value of a host input (K65: never the snapshot).
function readHost(id) {
    var U = unitsApi();
    if (U && unitsSys() === 'metric' && typeof U.readInput === 'function') {
        try { var v = U.readInput(id); if (isNum(v)) return v; } catch (e) {}
    }
    var el = hostEl(id);
    return el ? parseFloat(el.value) : NaN;
}
// setHostInput(id, canonical, cat, evt): write a canonical value into a host input and let the host recalc.
function setHostInput(id, canonical, cat, evt) {
    var el = hostEl(id);
    if (!el) return false;
    var U = unitsApi();
    var tagged = !!(el.getAttribute && el.getAttribute('data-wts-unit-cat'));
    var st = parseFloat(el.step), dp = (isNum(st) && st > 0) ? clamp(Math.ceil(-Math.log(st) / Math.LN10 - 1e-9), 0, 6) : 2;
    try {
        if (typeof canonical === 'string') el.value = canonical;
        else if (tagged && U && typeof U.runCanonical === 'function') {
            // Inside a canonical context an assignment is taken as imperial and shown converted (22-units).
            var cv = +canonical.toFixed(Math.max(dp, 2));
            U.runCanonical(function () { el.value = String(cv); });
        } else {
            var v = canonical;
            if (cat && U && unitsSys() === 'metric' && typeof U.format === 'function') {
                try { var f = U.format(canonical, cat); if (f && isNum(+f.value)) v = +f.value; } catch (e2) {}
            }
            el.value = String(+v.toFixed(dp));
        }
        if (typeof Event === 'function') el.dispatchEvent(new Event(evt || 'input', { bubbles: true }));
    } catch (e) { console.warn('[WTS] host input', id, e); return false; }
    return true;
}

// ═══════════════════════════════════════════════════════════════════
// §E CONTROLLER
// ═══════════════════════════════════════════════════════════════════
function createController(vizEl, mopts) {
    var ctl = { disposed: false };
    var prefs = readPrefs();
    var mode = prefs.mode || '3d';
    var h3 = null, mountTok = 0, loading = false, failed = false, fails = [], okSince = 0, pendingRemount = false;
    var raf = 0, rafIsTimer = false, last = 0, t2d = 0, tHud = 0, tPub = 0, tSr = 0, tSlow = 0, tDraw = 0;
    var onScreen = true, dirty2d = true, flowGain = 1, dash = [0, 0, 0, 0, 0, 0, 0, 0];
    var bp = 'lg', isMax = false, reduced = false, lastDpr = 0;
    var listeners = [], timers = [], simHooks = [];
    var E = {};                          // DOM refs
    var cardId = null, cardRefs = null, menu = null, drawerOpen = false, drawerTab = 'alarms', drawerSig = '';
    var popGroup = null, keysOpen = false;
    var pointerInside = false, loadingVisMs = 0, loadStepT = 0, loadStep = 0;
    var trendBuf = { gas: [], oil: [], water: [], gor: [], bsw: [] };
    var stats = null, lowFpsSince = 0, lowFpsShown = false, lastLowPerf = false;
    var lastFlowInvalid = false, lastAlarmVersion = -1;
    var injected = [], orig = null, cssInjected = false;
    var supported3d = null;

    // ── small DOM helpers ────────────────────────────────────────────
    function on(t, type, fn, o) { if (!t || !t.addEventListener) return; t.addEventListener(type, fn, o || false); listeners.push([t, type, fn, o || false]); }
    function later(fn, ms) { var id = setTimeout(function () { var i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); if (!ctl.disposed) fn(); }, ms); timers.push(id); return id; }
    function mk(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
    function q(sel, root) { return (root || vizEl).querySelector(sel); }
    function setText(el, s) { if (el && el.__t !== s) { el.textContent = s; el.__t = s; } }
    function setHTML(el, s) { if (el && el.__h !== s) { el.innerHTML = s; el.__h = s; } }
    function setAttr(el, k, v) { if (el && el.getAttribute(k) !== v) el.setAttribute(k, v); }
    function show(el, v) { if (el && el.hidden === !!v) el.hidden = !v; }
    function state() { return _sim ? _sim.getState() : null; }
    function btn(act, inner, o) {
        o = o || {};
        return '<button type="button" data-wts-ui class="wtsl-b' + (o.cls ? ' ' + o.cls : '') + '" data-act="' + act + '"' +
            (o.v != null ? ' data-v="' + esc(o.v) + '"' : '') + ' aria-label="' + esc(o.label || '') + '" title="' + esc(o.title || o.label || '') + '"' +
            (o.pressed != null ? ' aria-pressed="' + (o.pressed ? 'true' : 'false') + '"' : '') +
            (o.menu ? ' aria-haspopup="true" aria-expanded="false"' : '') + '>' + inner + '</button>';
    }

    // ── build ───────────────────────────────────────────────────────
    function injectCss() {
        if (hostEl('wtsl-css')) return;
        var s = document.createElement('style'); s.id = 'wtsl-css'; s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
        cssInjected = s;
    }
    function buildDom() {
        var hostCard = vizEl.closest ? (vizEl.closest('.wtsl-card') || vizEl.parentElement) : vizEl.parentElement;
        var v2 = vizEl.querySelector('#wts_view2d') || hostEl('wts_view2d');
        orig = { v2: v2, parent: v2 && v2.parentNode, next: v2 && v2.nextSibling, card: hostCard,
            cardPad: hostCard ? hostCard.style.padding : '', vizCls: vizEl.className, vizMode: vizEl.getAttribute('data-mode') };
        if (hostCard) { hostCard.classList.add('wtsl-card--live'); hostCard.style.padding = '0'; }
        vizEl.classList.add('wtsl-viz');
        vizEl.setAttribute('data-rp-nosnap', '');
        vizEl.setAttribute('role', 'region');
        vizEl.setAttribute('aria-label', 'Live well test simulation');

        // Toolbar
        var tb = mk('div', 'wtsl-tb rp-skip');
        tb.id = 'wtsl_tb'; tb.setAttribute('role', 'toolbar'); tb.setAttribute('aria-label', 'Live simulation controls'); tb.setAttribute('data-wts-ui', '');
        tb.innerHTML =
            '<span class="wtsl-brand wtsl-hide-sm wtsl-hide-md" data-s="run"><i class="wtsl-dot"></i><span class="bt">LIVE 3D</span></span>' +
            '<div class="wtsl-segc" role="group" aria-label="View mode">' +
                '<button type="button" data-wts-ui data-act="mode3d" aria-pressed="true" title="3D view (V)">3D</button>' +
                '<button type="button" data-wts-ui data-act="mode2d" aria-pressed="false" title="2D schematic (V)">2D</button></div>' +
            '<span class="wtsl-sep wtsl-hide-sm"></span>' +
            btn('play', ICON.pause, { cls: 'ic', label: 'Pause', title: 'Pause (Space)', pressed: true }) +
            '<div class="wtsl-speeds" role="group" aria-label="Simulation speed">' +
                SPEEDS.map(function (s) { return btn('speed', '×' + s, { v: s, label: 'Speed ' + s + ' times', title: s === 1 ? 'Real time' : s + '× real time' }); }).join('') + '</div>' +
            btn('speedcycle', '×10', { cls: 'wtsl-speedchip', label: 'Simulation speed', title: 'Simulation speed ([ / ])' }) +
            btn('resetmenu', ICON.reset + '<span class="wtsl-txt-md">Reset</span>' + ICON.caret, { cls: 'wtsl-hide-sm', label: 'Reset', title: 'Reset the test (R)', menu: 1 }) +
            '<span class="wtsl-sep wtsl-hide-sm"></span>' +
            btn('esd', 'ESD', { cls: 'wtsl-esd', label: 'ESD', title: 'Trip the ESD valve SDV-101 (E)' }) +
            btn('scen', ICON.scen + '<span class="wtsl-txt-md">Scenarios</span>' + ICON.caret, { cls: 'wtsl-hide-sm', label: 'Scenarios', title: 'Fault scenarios', menu: 1 }) +
            btn('alarms', ICON.bell + '<span class="wtsl-txt-md wtsl-hide-sm">Alarms</span><span class="wtsl-badge" hidden>0</span>', { label: 'Alarms', title: 'Alarms and events' }) +
            '<span class="wtsl-sep wtsl-hide-sm wtsl-only3d"></span>' +
            btn('viewmenu', ICON.cam + '<span class="wtsl-txt-md">View</span>' + ICON.caret, { cls: 'wtsl-hide-sm wtsl-only3d', label: 'View', title: 'Camera views (0–5)', menu: 1 }) +
            btn('colour', ICON.drop + '<span class="wtsl-txt-md">Colour</span>' + ICON.caret, { cls: 'wtsl-hide-sm wtsl-only3d', label: 'Colour', title: 'Colour overlay', menu: 1 }) +
            btn('labels', ICON.tag + '<span class="wtsl-txt-md">Labels</span> <small>All</small>' + ICON.caret, { cls: 'wtsl-hide-sm wtsl-only3d', label: 'Labels', title: 'Labels: All / Equipment / Off (L cycles)', menu: 1 }) +
            btn('legend', ICON.legend + '<span class="wtsl-txt-md">Legend</span>', { cls: 'wtsl-hide-sm', label: 'Legend', title: 'Legend', pressed: false }) +
            btn('trends', ICON.trends + '<span class="wtsl-txt-md">Trends</span>', { cls: 'wtsl-hide-sm', label: 'Trends', title: 'Trends', pressed: false }) +
            btn('quality', ICON.gem + '<span class="wtsl-txt-md">Quality</span>' + ICON.caret, { cls: 'wtsl-hide-sm wtsl-only3d', label: 'Quality', title: 'Rendering quality', menu: 1 }) +
            '<span class="wtsl-sp"></span>' +
            btn('max', ICON.max + '<span class="wtsl-txt-md">Max</span>', { cls: 'wtsl-hide-sm wtsl-maxb', label: 'Max', title: 'Maximise (F)' }) +
            btn('more', ICON.more, { cls: 'ic wtsl-only-sm', label: 'More', title: 'More controls', menu: 1 });
        // Alarm pill / banner
        var al = mk('div', 'wtsl-alarm rp-skip'); al.id = 'wtsl_alarm'; al.setAttribute('data-wts-ui', ''); al.hidden = true;
        // Stage
        var stage = mk('div', 'wtsl-stage'); stage.id = 'wtsl_stage'; stage.setAttribute('aria-describedby', 'wtsl_sr');
        var v3 = mk('div', 'wtsl-view3d'); v3.id = 'wtsl_view3d';
        stage.appendChild(v3);
        if (v2) { v2.classList.add('wtsl-view2d'); stage.appendChild(v2); }
        var paused = mk('div', 'wtsl-paused rp-skip', 'PAUSED'); paused.hidden = true;
        var loadEl = mk('div', 'wtsl-loading rp-skip',
            '<div class="wtsl-lcard" role="status" aria-live="polite"><div class="ttl">Live 3D</div><div class="st">Loading 3D engine…</div>' +
            '<div class="wtsl-shim"></div><div class="slow" hidden>Still loading (slow connection)…</div>' +
            '<button type="button" data-wts-ui class="wtsl-link" data-act="use2d">Use 2D</button></div>');
        loadEl.id = 'wtsl_loading'; loadEl.hidden = true;
        var notice = mk('div', 'wtsl-notice rp-skip'); notice.id = 'wtsl_notice'; notice.hidden = true; notice.setAttribute('role', 'status');
        var toasts = mk('div', 'wtsl-toasts rp-skip'); toasts.id = 'wtsl_toast'; toasts.setAttribute('aria-live', 'polite');
        var card = mk('div', 'wtsl-icard rp-skip'); card.id = 'wtsl_card'; card.hidden = true; card.setAttribute('data-wts-ui', '');
        card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Equipment details');
        var legend = mk('div', 'wtsl-legend rp-skip'); legend.id = 'wtsl_legend'; legend.hidden = true;
        var trends = mk('div', 'wtsl-trends rp-skip'); trends.id = 'wtsl_trends'; trends.hidden = true;
        trends.innerHTML = [['sep', 'Sep P vs SP'], ['lvl', 'Bucket · interface'], ['surge', 'Surge A · B'], ['gt', 'Gauge A · B']].map(function (t) {
            return '<div class="wtsl-tr" data-k="' + t[0] + '"><div class="l">' + t[1] + '<b></b></div><canvas class="wtsl-cvs" width="160" height="40"></canvas></div>';
        }).join('');
        var drawer = mk('div', 'wtsl-drawer rp-skip'); drawer.id = 'wtsl_drawer'; drawer.hidden = true; drawer.setAttribute('data-wts-ui', '');
        drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', 'Alarms and events');
        var fsb = mk('button', 'wtsl-fsbtn rp-skip', ICON.max); fsb.type = 'button'; fsb.setAttribute('data-wts-ui', ''); fsb.setAttribute('data-act', 'max');
        fsb.setAttribute('aria-label', 'Maximise'); fsb.title = 'Maximise';
        var keys = mk('div', 'wtsl-keys rp-skip'); keys.hidden = true; keys.setAttribute('role', 'dialog'); keys.setAttribute('aria-label', 'Keyboard shortcuts');
        [paused, loadEl, notice, toasts, legend, trends, card, drawer, fsb, keys].forEach(function (e) { stage.appendChild(e); });
        // HUD
        var hud = mk('div', 'wtsl-hud rp-skip'); hud.id = 'wtsl_hud'; hud.setAttribute('data-wts-ui', ''); hud.setAttribute('aria-label', 'Live readings');
        hud.innerHTML = hudHtml();
        var sr = mk('div', 'wtsl-sr rp-skip'); sr.id = 'wtsl_sr'; sr.setAttribute('aria-live', 'polite');

        // Order: toolbar, pill, stage, HUD, sr (the host canvas wrapper now lives in the stage)
        [tb, al, stage, hud, sr].forEach(function (e) { vizEl.appendChild(e); injected.push(e); });
        E = { tb: tb, alarm: al, stage: stage, view3d: v3, view2d: v2, cv: v2 ? v2.querySelector('canvas') : hostEl('wts_cv'),
            paused: paused, loading: loadEl, notice: notice, toasts: toasts, card: card, legend: legend, trends: trends,
            drawer: drawer, fsb: fsb, keys: keys, hud: hud, sr: sr,
            brand: q('.wtsl-brand', tb), brandT: q('.wtsl-brand .bt', tb), m3: q('[data-act=mode3d]', tb), m2: q('[data-act=mode2d]', tb),
            play: q('[data-act=play]', tb), speedchip: q('[data-act=speedcycle]', tb), esd: q('[data-act=esd]', tb),
            alarms: q('[data-act=alarms]', tb), badge: q('.wtsl-badge', tb), labels: q('[data-act=labels] small', tb),
            legendB: q('[data-act=legend]', tb), trendsB: q('[data-act=trends]', tb), maxB: q('.wtsl-maxb', tb) };
        E.speedBtns = Array.prototype.slice.call(tb.querySelectorAll('.wtsl-speeds [data-act=speed]'));
        E.h = {};
        Array.prototype.forEach.call(hud.querySelectorAll('[data-h]'), function (e) { E.h[e.getAttribute('data-h')] = e; });
        buildRig(hostCard);
    }
    // ── Rig-up card: a page card right below the live view (outside the HMI) with one switch per item ──
    function buildRig(hostCard) {
        var parent = hostCard && hostCard.parentNode;
        if (!parent || !parent.insertBefore) return;
        var old = hostEl('wtsl_rigup'); if (old && old.parentNode) old.parentNode.removeChild(old);
        var c = mk('div', 'card wtsl-rig'); c.id = 'wtsl_rigup'; c.setAttribute('data-wts-ui', '');
        c.innerHTML = '<div class="card-title">Rig-up</div>' +
            '<div class="wtsl-rig-intro">Switch equipment in or out of the surface well-test spread. The flow path, pressures, temperatures, levels, rates, alarms and trips, ' +
            'the 2D schematic and the 3D view all follow. There is no pump between the surge tank and the gauge tank: LCV-201 transfers on the surge tank pressure.</div>' +
            '<div class="wtsl-rig-list"></div><div class="wtsl-rig-notes"></div>' +
            '<div class="wtsl-rig-foot"><button type="button" class="wtsl-rig-all" data-rig-act="all">Restore full rig-up</button></div>';
        parent.insertBefore(c, hostCard.nextSibling);
        E.rig = c; injected.push(c);
        on(c, 'click', onRigClick);
    }
    function onRigClick(ev) {
        var t = ev.target, b = t && t.closest ? t.closest('[data-rig],[data-rig-act]') : null;
        if (!b || b.disabled) return;
        if (b.getAttribute('data-rig-act') === 'all') { fullRig(); return; }
        setRig(b.getAttribute('data-rig'), b.getAttribute('aria-checked') !== 'true');
    }
    function renderRig(st, force) {
        var c = E.rig; if (!c) return;
        var ru = (st && st.rigup) || null, req = (_sim && typeof _sim.getRigup === 'function') ? _sim.getRigup() : null;
        var xp = xferOf(st), items = rigItems();
        var tr = !xp ? '—' : rigOut(st, 'surge') ? 'not in use (no surge tank)' :
            'LCV-201 ' + xferShort(st) + (isNum(xp.dP_psi) ? ' · ΔP ' + fmtU(xp.dP_psi, 'pressure', 1) : '') + ' (surge tank pressure, no pump)';
        var sig = (ru ? ru.sig + '|' + (ru.notes || []).join('|') : '-') + '|' + JSON.stringify(req) + '|' + tr + '|' + !!_sim;
        if (!force && c.__sig === sig) return;
        c.__sig = sig;
        var nOut = 0;
        var rows = items.map(function (it) {
            var inRig = !ru || ru[it.key] !== false, asked = !req || req[it.key] !== false;
            if (!inRig) nOut++;
            var txt = it.locked ? 'In service (required)' : inRig ? (asked ? 'In service' : 'In service (kept, see note)')
                : asked ? 'Out of line (see note)' : (it.key === 'heater' || it.key === 'separator') ? 'Bypassed' : 'Out of rig-up';
            var tip = it.locked ? (it.why || 'Required') : (asked ? 'Take ' + it.tag + ' out of the rig-up' : 'Put ' + it.tag + ' back in the rig-up');
            return '<div class="rrow wtsl-rig-row' + (inRig ? '' : ' off') + '" data-k="' + esc(it.key) + '"><span class="rl">' + esc(it.tag) + ' · ' + esc(it.name) + '</span>' +
                '<span class="rv">' + esc(txt) + '</span><button type="button" class="wtsl-sw" role="switch" data-rig="' + esc(it.key) + '" aria-checked="' + (it.locked || asked) + '"' +
                ' aria-label="' + esc(it.tag + ' ' + it.name + ' in the rig-up') + '" title="' + esc(tip) + '"' + (it.locked || !_sim ? ' disabled' : '') + '><i></i></button></div>';
        });
        rows.push('<div class="rrow wtsl-rig-row info"><span class="rl">Configuration</span><span class="rv">' + (nOut ? nOut + ' item' + (nOut > 1 ? 's' : '') + ' out of the rig-up' : 'Full rig-up') + '</span></div>');
        rows.push('<div class="rrow wtsl-rig-row info"><span class="rl">T-201 → T-301 transfer</span><span class="rv">' + esc(tr) + '</span></div>');
        setHTML(q('.wtsl-rig-list', c), rows.join(''));
        setHTML(q('.wtsl-rig-notes', c), ((ru && ru.notes) || []).map(function (n) { return '<div class="wtsl-rig-note"><b>Note</b>' + esc(n) + '</div>'; }).join(''));
        var all = q('.wtsl-rig-all', c); if (all) all.disabled = !_sim || !!(ru && ru.full && (!req || items.every(function (it) { return req[it.key] !== false; })));
    }
    function hudHtml() {
        function item(k, label, cls) {
            return '<div class="wtsl-hi ' + (cls || '') + '"><span class="wtsl-hl"><span data-h="' + k + 'L">' + label + '</span><i data-h="' + k + 'U"></i></span>' +
                '<span class="wtsl-hv' + (/^p/.test(k) ? ' p' : '') + '"><span data-h="' + k + '">—</span>' +
                (/^r/.test(k) ? '<span class="wtsl-ha" data-h="' + k + 'A"></span>' : '') + '</span></div>';
        }
        return '<div class="wtsl-hgrid">' +
            '<div class="wtsl-hg"><div class="wtsl-clock"><small>T+</small><span data-h="clock">00:00:00</span></div>' +
                '<div class="wtsl-hst">' + btn('speedcycle', '×10', { label: 'Simulation speed', title: 'Cycle simulation speed ([ / ])' }).replace('class="wtsl-b"', 'class="wtsl-b" data-h="spd"') +
                '<span class="wtsl-state" data-h="state" data-s="run">RUNNING</span></div></div>' +
            '<div class="wtsl-hg"><div class="wtsl-hrow">' + item('pWh', 'WHP') + item('pCk', 'Choke in→out') +
                '<div class="wtsl-hi wtsl-hsep"><span class="wtsl-hl"><span data-h="pSepL">Sep</span><i data-h="pSepU"></i></span><span class="wtsl-hv p"><span data-h="pSep">—</span></span>' +
                '<div class="wtsl-sepbar" data-h="sepbar" title="Separator pressure vs setpoint: green ±5 psi band, amber = PAH, red = PSHH"><div class="band"></div><div class="tk" style="background:#d29922"></div><div class="tk" style="background:#f85149"></div><div class="mk"></div></div></div>' +
                item('pSu', 'Surge') + '</div></div>' +
            '<div class="wtsl-hg"><div class="wtsl-hrow">' + item('rG', 'Gas') + item('rO', 'Oil') + item('rW', 'Water') + item('rR', 'GOR', 'h-gor') + item('rB', 'BS&amp;W', 'h-bsw') + '</div></div>' +
            '<div class="wtsl-hg g-cum" title="Totals since test start (T+0)"><div class="wtsl-hrow">' + item('cO', 'Cum oil') + item('cW', 'Water') + item('cG', 'Gas') + item('cF', 'Flared') + '</div></div>' +
            '<div class="wtsl-hg"><div class="wtsl-tl" data-h="tSu">Surge —</div><div class="wtsl-tl" data-h="tGt">A — · B —</div>' +
                '<div class="wtsl-tl al" data-h="tAl">● No active alarms</div></div>' +
            '</div>' +
            '<div class="wtsl-tiles">' +
                tile('clock') + tile('press') + tile('rates') + tile('water') + tile('tanks') + tile('alarm') +
            '</div>';
    }
    function tile(g) {
        return '<div class="wtsl-tile" role="button" tabindex="0" data-act="tile" data-v="' + g + '"><span class="wtsl-hl" data-h="t_' + g + 'L"></span>' +
            '<span class="v" data-h="t_' + g + '">—</span><span class="v2" data-h="t_' + g + '2"></span></div>';
    }

    function revert() {
        try {
            if (orig && orig.v2 && orig.parent) {
                orig.v2.classList.remove('wtsl-view2d');
                if (orig.next && orig.next.parentNode === orig.parent) orig.parent.insertBefore(orig.v2, orig.next);
                else orig.parent.appendChild(orig.v2);
            }
            injected.forEach(function (e) { if (e.parentNode) e.parentNode.removeChild(e); });
            injected = [];
            if (menu && menu.el && menu.el.parentNode) menu.el.parentNode.removeChild(menu.el);
            if (orig) {
                vizEl.className = orig.vizCls;
                if (orig.vizMode != null) vizEl.setAttribute('data-mode', orig.vizMode);
                if (orig.card) { orig.card.classList.remove('wtsl-card--live'); orig.card.style.padding = orig.cardPad; }
            }
            if (cssInjected && cssInjected.parentNode) cssInjected.parentNode.removeChild(cssInjected);
        } catch (e) {}
    }

    // ── sim wiring ──────────────────────────────────────────────────
    function hookSim() {
        if (!_sim || simHooks.length) return;
        function h(evt, fn) { try { _sim.on(evt, fn); simHooks.push([evt, fn]); } catch (e) {} }
        h('alarm', function (p, s) {
            var list = (s && s.alarms) ? s.alarms.slice() : [];
            var present = false;
            for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === p.id) { present = true; break; }
            if (!present && p && p.id) list.push(p);
            _alarmMap = alarmReduce(_alarmMap, list, s ? s.t : 0, null);
            if (s) lastAlarmVersion = s.alarmVersion;
            poke(); refreshNow(s);
        });
        h('clear', function (p, s) { _alarmMap = alarmReduce(_alarmMap, (s && s.alarms) || [], s ? s.t : 0, null); poke(); refreshNow(s); });
        h('trip', function (p, s) {
            toast(p && p.manual ? 'ESD closed manually' : 'ESD TRIPPED — ' + (p && p.msg ? p.msg : ''), p && p.manual ? '' : 'bad');
            poke(); refreshNow(s);
        });
        h('esdReset', function (p, s) {
            // the separator dump route: T-201 inlets, or (no surge tank in the rig-up) the T-301 inlets
            var noSep = rigOut(s, 'separator'), noSurge = rigOut(s, 'surge'), C = s && s.surge && s.surge.comps, T = s && s.gauge && s.gauge.tanks;
            var shutU = !noSep && !noSurge && !!(C && C[0] && !C[0].inlet && !C[1].inlet), shutG = !noSep && noSurge && !rigOut(s, 'gauge') && !!(T && T[0] && !T[0].inlet && !T[1].inlet);
            toast('ESD reset — reopening' + (shutU ? ' · XV-201A/B still shut: open a T-201 inlet' : shutG ? ' · XV-301A/B still shut: open a T-301 inlet' : ''), shutU || shutG ? 'bad' : 'ok'); poke(); refreshNow(s);
        });
        h('switch', function (p) { toast('Gauge tank switched to ' + (p && p.tag ? p.tag : '') + (p && p.forced ? ' (manual)' : '')); poke(); });
        h('batch', function (p) {
            if (!p) return;
            toast('Batch ' + p.n + ' ' + (p.tag || '') + ': ' + fmtU(p.oil_stb, 'oilVolume') + ' · ' + fmtU(p.oilRate_stbd, 'oilRate'), 'ok');
            poke();
        });
        h('fault', function (p) {
            var lbl = p && p.id;
            for (var i = 0; i < FAULTS.length; i++) if (FAULTS[i][0] === lbl) lbl = FAULTS[i][1];
            toast(lbl + ' ' + (p && p.on ? 'ON' : 'OFF'), p && p.on ? 'bad' : '');
            poke();
        });
        h('reset', function (p) { _alarmMap = {}; toast('Test reset (' + (p && p.mode ? p.mode : 'steady') + ')'); poke(); });
        // lineup changes (manual or automatic) persist in the prefs; automatic diverts are announced
        h('control', function () { saveCtl(); poke(); if (cardRefs && cardRefs.act) cardRefs.act.__sig = ''; });
        h('divert', function (p) { if (p && p.msg) toast(p.msg.replace(/^T-[23]01 /, '')); });
        h('suction', function (p) { if (p && p.msg) toast(p.msg, 'bad'); poke(); });
        h('pumpTrip', function (p) { toast((p && p.action ? p.action.replace(/transfer shut$/, 'transfer SHUT') : 'LCV-201 transfer SHUT') + ' (trip) — ' + (p && p.msg ? p.msg : ''), 'bad'); poke(); resig(); });
        h('pumpReset', function (p) { toast(p && p.msg ? p.msg : 'LCV-201 trip reset', 'ok'); poke(); resig(); });
        h('rigup', function (p) { if (p && p.rig && typeof _sim.getRigup === 'function') { try { writeRig(_sim.getRigup()); } catch (e) {} }
            if (p && p.msg) toast(p.msg.replace(/^Rig-up: /, 'Rig-up — ')); poke(); resig(); renderRig(state(), true); });
    }
    function unhookSim() {
        if (_sim) simHooks.forEach(function (x) { try { _sim.off(x[0], x[1]); } catch (e) {} });
        simHooks = [];
    }
    function poke() { dirty2d = true; tHud = 0; }
    function resig() { if (cardRefs && cardRefs.act) cardRefs.act.__sig = ''; if (E.vin) E.vin.__sig = ''; }
    function saveCtl() {
        if (!_sim || typeof _sim.getControls !== 'function') return;
        try { prefs.ctl = _sim.getControls(); writePrefs(prefs); } catch (e) {}
    }
    // Valve / suction / auto-divert operations (3D tap, 2D click, info-card buttons)
    function valveTag(eq, i) { return (eq === 'surge' ? 'XV-201' : 'XV-301') + (i ? 'B' : 'A'); }
    function toggleValve(eq, i) {
        var st = state(); if (!_sim || !st || typeof _sim.setValve !== 'function') return;
        var open = eq === 'surge' ? !!(st.surge.comps && st.surge.comps[i] && st.surge.comps[i].inlet) : !!(st.gauge.tanks && st.gauge.tanks[i] && st.gauge.tanks[i].inlet);
        var ok = false; try { ok = _sim.setValve(eq, i, !open); } catch (e) {}
        if (!ok) {                                // refused by the open permissive (compartment at high-high / latched trip)
            var lg = state().alarmLog || [], le = lg[lg.length - 1];
            if (le && le.id === 'VALVE' && /refused/.test(le.msg)) toast(le.msg, 'bad');
            return;
        }
        var s2 = state(), both = eq === 'surge' ? !!(s2.surge.comps[0] && !s2.surge.comps[0].inlet && !s2.surge.comps[1].inlet) : !!(s2.gauge.tanks[0] && !s2.gauge.tanks[0].inlet && !s2.gauge.tanks[1].inlet);
        var c2 = eq === 'surge' ? s2.surge.comps[i] : s2.gauge.tanks[i], moving = !!(c2 && c2.moving);
        toast(valveTag(eq, i) + (open ? (moving ? ' closing' : ' closed') : (moving ? ' opening' : ' opened')) +
            (c2 && c2.hold ? ' — held open until ' + valveTag(eq, 1 - i) + ' is fully open' : '') +
            (both ? (eq === 'surge' ? ' — both T-201 inlets shut: separator dumps blocked' : ' — both T-301 inlets shut: ' + (rigOut(s2, 'surge') ? 'separator dumps blocked' : 'LCV-201 transfer blocked')) : ''), both ? 'bad' : '');
        poke(); resig();
    }
    function toggleSuction(i) {
        var st = state(); if (!_sim || !st || typeof _sim.setSuction !== 'function') return;
        var cur = st.surge.suction || 'both', me = i ? 'B' : 'A', other = i ? 'A' : 'B', next;
        if (cur === 'both') next = other; else if (cur === me) { toast('LCV-201 needs one outlet open — open SV-201' + other + ' first'); return; } else next = 'both';
        var ok = false; try { ok = _sim.setSuction(next); } catch (e) {}
        if (ok) { toast('LCV-201 suction ' + (next === 'both' ? 'A + B' : next)); poke(); }
    }
    function setSuction(v) { if (_sim && typeof _sim.setSuction === 'function') { try { _sim.setSuction(v); } catch (e) {} poke(); resig(); } }
    // latched LCV-201 transfer trips (LSHH-301, low-low): operator reset once the permissive is met
    function resetXfer() {
        if (!_sim || typeof _sim.resetTrip !== 'function') return;
        var r = null; try { r = _sim.resetTrip(); } catch (e) {}
        if (r && !r.ok) toast('Cannot reset ' + (rigOut(state(), 'surge') ? 'the LSHH-301 trip' : 'LCV-201') + ' — ' + (r.blocking || []).join('; ').replace(/LSHH_GT: |PUMP_DRYRUN: /g, ''), 'bad');
        poke(); resig();
    }
    // rig-up toggles (Rig-up card): out-of-rig equipment is bypassed in the sim, the 2D schematic and the 3D view
    function setRig(key, on) {
        if (!_sim || typeof _sim.setRigup !== 'function') return;
        var o = {}; o[key] = !!on;
        try { _sim.setRigup(o); } catch (e) {}
        poke(); renderRig(state(), true);
    }
    function fullRig() {
        if (!_sim || typeof _sim.setRigup !== 'function') return;
        var o = {}; rigItems().forEach(function (it) { o[it.key] = true; });
        try { _sim.setRigup(o); } catch (e) {}
        poke(); renderRig(state(), true);
    }
    function valveOpt(eq, o) { if (_sim && typeof _sim.setValveOptions === 'function') { try { _sim.setValveOptions(eq, o); } catch (e) {} poke(); resig(); } }
    function stepStroke(eq, d) { var st = state(), o = st && (eq === 'surge' ? st.surge : st.gauge); if (o) valveOpt(eq, { strokeS: Math.max(0, Math.min(60, num(o.strokeS, 6) + d)) }); }
    function toggleInterrupt() {
        var st = state(), on = !(st && st.gauge && st.gauge.allowInterrupt);
        valveOpt('gauge', { allowInterrupt: on });
        toast(on ? 'Auto-divert MAY interrupt a settling / draining batch' : 'Batches protected — auto-divert waits for a ready compartment', on ? 'bad' : '');
    }
    function toggleAuto(eq) {
        var st = state(); if (!_sim || !st || typeof _sim.setAutoDivert !== 'function') return;
        var a = eq === 'surge' ? st.surge.auto : st.gauge.auto, on = !(a && a.on);
        try { _sim.setAutoDivert(eq, on); } catch (e) {}
        toast((eq === 'surge' ? 'Surge' : 'Gauge') + ' tank auto-divert ' + (on ? 'ON' : 'OFF')); poke();
    }
    function stepAutoSp(eq, d) {
        var st = state(); if (!_sim || !st || typeof _sim.setAutoDivert !== 'function') return;
        var a = eq === 'surge' ? st.surge.auto : st.gauge.auto; if (!a) return;
        try { _sim.setAutoDivert(eq, !!a.on, { sp: Math.round((num(a.sp, 0.8) + d) * 100) / 100 }); } catch (e) {}
        poke();
    }
    // Immediate chrome refresh for safety-relevant events (ESD trip / reset), independent of the 4 Hz cadence.
    function refreshNow(s) { try { s = s || state(); updateToolbar(s); updatePill(s); } catch (e) {} }
    function createSim(flow) {
        var S = G.WTS_sim;
        if (!S || typeof S.create !== 'function') return;
        _sim = S.create(flow, { mode: 'steady', seed: (Date.now() & 0x7fffffff), speed: SPEEDS.indexOf(prefs.speed) >= 0 ? prefs.speed : 10, rigup: readRig(),
            fmt: function (v, cat, dp) { return fmtU(v, cat, dp); } });      // alarm / log texts in the active unit system
        _rigPending = false;
        if (prefs.ctl && typeof _sim.setControls === 'function') { try { _sim.setControls(prefs.ctl, { initial: true }); } catch (e) {} }
        _lastFlowObj = flow;
        _resetPending = false;
        _alarmMap = {};
        hookSim();
        try { _sim.play(); } catch (e) {}
        poke();
    }
    function applyFlow(flow) {
        if (!flowValid(flow)) return;
        if (!_sim) { createSim(flow); return; }
        var prev = _lastFlowObj;
        if (flow !== prev) {
            _lastFlowObj = flow;
            _sim.setFlow(flow);
            var d = inputsDiff(prev, flow);
            for (var i = 0; i < d.length; i++) { try { _sim.logEvent(d[i][0], d[i][1]); } catch (e) {} }
        }
        if (_rigPending && typeof _sim.setRigup === 'function') {      // project Open / New: the saved rig-up (none = full)
            _rigPending = false;
            var rq = readRig() || {}, all = {};
            rigItems().forEach(function (it) { all[it.key] = rq[it.key] !== false; });
            try { _sim.setRigup(all); } catch (e) {}
        }
        if (_resetPending) { _resetPending = false; _alarmMap = {}; _sim.reset('steady'); }
        poke();
    }
    function onCalc(e) {
        var L = e && e.detail;
        if (L && L.flow) { try { applyFlow(L.flow); } catch (err) { console.warn('[WTS] live flow', err); } }
        dirty2d = true;
    }

    // ── mode logic, 3D mount, fallback, recovery (§6.8) ─────────────
    function canDo3d() {
        if (supported3d === null) {
            var W = G.WTS_3d;
            try { supported3d = !!(W && typeof W.isSupported === 'function' && W.isSupported()); } catch (e) { supported3d = false; }
        }
        return supported3d;
    }
    function noThreeMsg() { return G.WTS_3d ? '3D needs WebGL 2, which isn’t available on this device' : '3D view unavailable'; }
    function applyModeDom() {
        vizEl.setAttribute('data-mode', mode);
        E.m3.classList.toggle('on', mode === '3d'); E.m3.setAttribute('aria-pressed', mode === '3d' ? 'true' : 'false');
        E.m2.classList.toggle('on', mode === '2d'); E.m2.setAttribute('aria-pressed', mode === '2d' ? 'true' : 'false');
        E.m3.disabled = !canDo3d() || failed;
        E.m3.title = !canDo3d() ? noThreeMsg() : failed ? '3D unavailable — use Retry' : '3D view (V)';
        setText(E.brandT, mode === '3d' ? 'LIVE 3D' : 'LIVE 2D');
        if (mode === '2d') { show(E.trends, true); E.trends.classList.add('inflow'); }
        else { E.trends.classList.remove('inflow'); show(E.trends, prefs.trends); }
        layout2dTrends();
        pushInsets();
    }
    function setMode(m, why) {
        if (ctl.disposed) return;
        closeMenu();
        if (m === '2d') {
            mode = '2d';
            if (h3) { try { h3.setPaused(true); } catch (e) {} }
            if (why === 'user') { prefs.mode = '2d'; writePrefs(prefs); }
            if (why === 'cancel') { mountTok++; hideLoading(true); prefs.mode = '2d'; writePrefs(prefs); }
            applyModeDom();
            size2d(); dirty2d = true;
            if (why === 'user' || why === 'cancel') track('wts_viz_mode', { mode: '2d' });
            return;
        }
        if (!canDo3d()) {
            if (why === 'user' || why === 'retry' || why === 'init') fallback(noThreeMsg());
            return;
        }
        mode = '3d';
        if (why === 'user') { prefs.mode = '3d'; writePrefs(prefs); }
        applyModeDom();
        if (h3) {
            try { h3.setPaused(false); } catch (e) {}
            pushInsets();
            if (why === 'user') track('wts_viz_mode', { mode: '3d' });
            return;
        }
        if (loading) return;
        var W = G.WTS_3d;
        var nav = G.navigator;
        if (nav && nav.onLine === false && typeof W.hasLocalCopy === 'function') {
            var tokOff = ++mountTok;
            Promise.resolve().then(function () { return W.hasLocalCopy(); }).then(function (ok) {
                if (tokOff !== mountTok || ctl.disposed || mode !== '3d') return;
                if (ok) startMount(); else fallback('3D engine not available offline');
            }, function () { if (tokOff === mountTok && !ctl.disposed) fallback('3D engine not available offline'); });
            return;
        }
        startMount();
    }
    function msgFor(code) {
        return code === 'offline' ? '3D engine could not load (offline?)'
            : code === 'integrity' ? '3D engine failed an integrity check'
            : code === 'csp' ? '3D blocked by security policy'
            : code === 'timeout' ? '3D took too long to build'
            : code === 'no-webgl' ? '3D needs WebGL 2, which isn’t available on this device'
            : '3D view unavailable';
    }
    function startMount() {
        var W = G.WTS_3d;
        var tok = ++mountTok;
        loading = true; loadingVisMs = 0; loadStep = 0;
        showLoading('Loading 3D engine…');
        try {
            if (typeof W.loadThree === 'function') {
                Promise.resolve(W.loadThree()).then(function () {
                    if (tok === mountTok && loading && loadStep < 1) { loadStep = 1; loadStepT = 0; setLoadingText('Building equipment…'); }
                }, function () {});
            }
        } catch (e) {}
        var units = unitsOpt();
        var o = {
            fmt: fmtU, fmtParts: fmtParts, units: units,
            onPick: function (id) { if (!ctl.disposed) onPick(id); },
            onAction: function (a) {
                if (ctl.disposed || !a) return;
                if (a.type === 'esd-trip') askTrip(E.esd);
                else if (a.type === 'valve') toggleValve(a.eq === 'surge' ? 'surge' : 'gauge', a.idx ? 1 : 0);
                else if (a.type === 'suction') toggleSuction(a.idx ? 1 : 0);
            },
            onError: function (err, fatal) { if (!ctl.disposed) on3dError(err, fatal, tok); },
            onStats: function (s) { if (!ctl.disposed) onStats(s); },
            onProgress: function (step) {
                if (tok !== mountTok || !loading) return;
                if (/build|equip/i.test(step)) { loadStep = Math.max(loadStep, 1); setLoadingText('Building equipment…'); }
                else if (/compile|fill|warm/i.test(step)) { loadStep = 2; setLoadingText('Filling vessels…'); }
            },
            quality: prefs.quality, labels: prefs.labels, overlay: prefs.overlay, orbit: prefs.orbit,
            reducedMotion: reduced, intro: ssGet('wts3d_intro') !== '1', insets: computeInsets()
        };
        var p;
        try { p = W.mount(E.view3d, o); } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(function (h) {
            if (tok !== mountTok || ctl.disposed || !h) { try { if (h) h.dispose(); } catch (e) {} return; }
            h3 = h; loading = false; okSince = nowMs();
            ssSet('wts3d_intro', '1');
            try { h3.setInteraction({ max: isMax }); } catch (e) {}
            try { h3.setPaused(mode !== '3d'); } catch (e) {}
            pushInsets();
            hideLoading(false);
            track('wts_viz_mode', { mode: '3d' });
            var r = E.stage.getBoundingClientRect();
            if (r.height > 0 && r.width / r.height < 1.2 && ssGet('wts3d_hint') !== '1') {
                ssSet('wts3d_hint', '1');
                later(function () { toast('Drag to see the wellhead'); }, 900);
            }
        }, function (e) {
            if (tok !== mountTok || ctl.disposed) return;
            loading = false;
            hideLoading(true);
            fallback(msgFor(e && e.code));
        });
    }
    function unitsOpt() {
        if (!E.units) E.units = { system: unitsSys(), conv: unitsConv };
        E.units.system = unitsSys();
        return E.units;
    }
    function fallback(msg) {
        failed = true;
        mode = '2d';
        if (h3) { try { h3.setPaused(true); } catch (e) {} }
        applyModeDom();
        size2d(); dirty2d = true;
        showNotice(msg + ' — showing 2D schematic.', true);
        track('wts_viz_fallback', { reason: msg });
    }
    function retry3d() {
        failed = false; fails = []; hideNotice();
        applyModeDom();
        setMode('3d', 'retry');
    }
    function on3dError(err, fatal, tok) {
        if (!fatal) { console.warn('[WTS] 3D', err); return; }
        if (tok != null && tok !== mountTok && !h3) return;
        var dead = h3; h3 = null;
        if (dead) { try { dead.dispose(); } catch (e) {} }
        loading = false;
        var t = nowMs();
        fails = fails.filter(function (x) { return t - x < 60000; });
        var lifecycle = !!(err && (err.code === 'context-lost' || err.message === 'context-lost') && appLifecycleLoss());
        if (!lifecycle) fails.push(t);
        if (fails.length >= 2) { fallback('3D stopped after repeated graphics errors'); return; }
        if (err && (err.code === 'context-lost' || err.message === 'context-lost')) {
            showNotice('3D paused — restoring graphics…', false);
            pendingRemount = true;
            if (!document.hidden && !appInBg) remountSoon();
        } else if (mode === '3d') setMode('3d', 'recover');
    }
    function remountSoon() {
        if (!pendingRemount) return;
        var go = function () {
            if (ctl.disposed || !pendingRemount || document.hidden || appInBg) return;
            pendingRemount = false;
            hideNotice();
            if (mode === '3d' && !h3) setMode('3d', 'recover');
        };
        // One animation frame (or 120 ms when frames are withheld), whichever comes first.
        if (typeof G.requestAnimationFrame === 'function') G.requestAnimationFrame(go);
        later(go, 120);
    }
    function onStats(s) {
        stats = s;
        var lp = !!(s && s.lowPerf);
        if (lp !== lastLowPerf) { lastLowPerf = lp; vizEl.classList.toggle('lowperf', lp); }
        if (!s || lowFpsShown) return;
        var t = nowMs();
        if (s.fps < 20 && s.quality === 'low' && !s.vsyncCapped) {
            if (!lowFpsSince) lowFpsSince = t;
            else if (t - lowFpsSince > 5000) {
                lowFpsShown = true;
                toast('3D is running slowly on this device.', '', [['Use 2D', 'use2d'], ['Keep 3D', 'toast-close']], 12000);
            }
        } else lowFpsSince = 0;
    }

    // ── loading / notice / toasts ────────────────────────────────────
    function showLoading(text) {
        vizEl.classList.add('loading3d');
        E.loading.classList.remove('out');
        show(E.loading, true);
        setLoadingText(text);
        show(q('.slow', E.loading), false);
        size2d(); dirty2d = true;
    }
    function setLoadingText(t) { setText(q('.st', E.loading), t); }
    function hideLoading(instant) {
        loading = false;
        if (instant) { show(E.loading, false); vizEl.classList.remove('loading3d'); return; }
        E.loading.classList.add('out');
        vizEl.classList.remove('loading3d');
        later(function () { if (!loading) { show(E.loading, false); E.loading.classList.remove('out'); } }, reduced ? 0 : 520);
    }
    function loadingTick(dtMs) {
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        loadingVisMs += dtMs; loadStepT += dtMs;
        if (loadingVisMs > 8000) show(q('.slow', E.loading), true);
        if (loadStep === 1 && loadStepT > 1500) { loadStep = 2; setLoadingText('Filling vessels…'); }
    }
    function showNotice(msg, withRetry) {
        E.notice.innerHTML = '<span>' + esc(msg) + '</span>' +
            (withRetry ? '<button type="button" data-wts-ui class="wtsl-b acc" data-act="retry">Retry</button>' : '') +
            '<button type="button" data-wts-ui class="wtsl-b ic" data-act="notice-close" aria-label="Dismiss" title="Dismiss">' + ICON.x + '</button>';
        show(E.notice, true);
    }
    function hideNotice() { show(E.notice, false); }
    function toast(msg, kind, actions, ms) {
        if (!E.toasts) return;
        var t = mk('div', 'wtsl-toast' + (kind ? ' ' + kind : ''));
        t.innerHTML = '<span>' + esc(msg) + '</span>' + (actions || []).map(function (a) {
            return '<button type="button" data-wts-ui class="wtsl-b" data-act="' + a[1] + '">' + esc(a[0]) + '</button>';
        }).join('');
        E.toasts.appendChild(t);
        while (E.toasts.children.length > 3) E.toasts.removeChild(E.toasts.firstChild);
        later(function () { t.classList.add('gone'); later(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320); }, ms || 4000);
    }

    // ── insets for 32 (D23) ──────────────────────────────────────────
    function computeInsets() {
        var overlay = mode === '3d' && bp !== 'sm';
        var coarse = !!(G.matchMedia && G.matchMedia('(pointer:coarse)').matches);
        var ins = { top: overlay ? (coarse ? 106 : 98) : 8, bottom: overlay ? 76 : 8, left: 0, right: 0, card: null };
        if (cardId && E.card && !E.card.hidden && E.view3d) {
            var r = E.card.getBoundingClientRect(), s = E.view3d.getBoundingClientRect();
            if (r.width > 0 && s.width > 0) ins.card = { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
        }
        return ins;
    }
    function pushInsets() { if (h3) { try { h3.setInsets(computeInsets()); } catch (e) {} } }

    // ── sizing ───────────────────────────────────────────────────────
    function onResize() {
        var w = vizEl.clientWidth;
        if (w > 0) {
            var nb = bpOf(w);
            if (nb !== bp) { bp = nb; vizEl.setAttribute('data-bp', bp); closeMenu(); closePop(); }
        }
        size2d(); layout2dTrends(); pushInsets();
        dirty2d = true;
    }
    function size2d() {
        var cv = E.cv, L = G.WTS_DIAG_LAYOUT;
        if (!cv || !L) return;                     // unpatched host: keep the fixed 1200×340 store
        var cssW = cv.clientWidth;
        if (cssW < 2) return;
        var dpr = clamp(num(G.devicePixelRatio, 1), 1, 3);
        lastDpr = dpr;
        var w = Math.round(cssW * dpr), h = Math.round(cssW * dpr * L.H / L.W);
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; dirty2d = true; if (!_sim) drawStatic2d(); }
    }
    function layout2dTrends() {
        if (mode !== '2d' || !E.trends) return;
        var sh = E.stage.clientHeight, ch = E.view2d ? E.view2d.offsetHeight : 0, lh = E.legend && !E.legend.hidden ? E.legend.offsetHeight + 6 : 0;
        show(E.trends, sh - ch - lh - 12 >= 90);
        if (!E.trends.hidden) drawTrends(state());
    }
    function drawStatic2d() {
        var L = G.WTS_lastCalc;
        if (L && L.nodes && L.segs && typeof G.wtsDrawDiag === 'function') { try { G.wtsDrawDiag(L.nodes, L.segs); } catch (e) {} }
    }

    // ── loop (§6.12) ─────────────────────────────────────────────────
    function frameReq(fn) {
        if (typeof G.requestAnimationFrame === 'function') { rafIsTimer = false; return G.requestAnimationFrame(fn); }
        rafIsTimer = true; return setTimeout(function () { fn(nowMs()); }, 16);
    }
    // Watchdog: when the page is visible but rAF is not being delivered (occluded embedded
    // web views, some hosts), drive the loop from a 2 Hz timer so the sim and HUD stay live.
    // It also (re)starts the loop if the page became visible without a visibilitychange event.
    var lastTick = 0, wd = 0, bgStopped = false;
    function watchdog() {
        if (ctl.disposed || document.hidden || bgStopped) return;
        if (!raf) { startLoop(); return; }
        if (nowMs() - lastTick > 1000) { cancelRaf(); loop(nowMs()); }
    }
    function cancelRaf() {
        if (!raf) return;
        if (rafIsTimer) clearTimeout(raf); else if (typeof G.cancelAnimationFrame === 'function') G.cancelAnimationFrame(raf);
        raf = 0;
    }
    function startLoop() {
        if (ctl.disposed || raf) return;
        last = 0; lastTick = nowMs();
        raf = frameReq(loop);
        startWatchdog();
    }
    function startWatchdog() { if (!wd && !ctl.disposed && typeof setInterval === 'function') wd = setInterval(watchdog, 500); }
    function stopLoop() { cancelRaf(); }
    function loop(ts) {
        raf = 0; lastTick = nowMs();
        if (ctl.disposed) return;
        if (!vizEl.isConnected) { dispose(); return; }
        raf = frameReq(loop);
        if (!isNum(ts)) ts = nowMs();
        var dt = last ? Math.min((ts - last) / 1000, 0.1) : 0;
        if (dt < 0) dt = 0;
        last = ts;
        if (_sim) { try { _sim.step(dt); } catch (e) { if (!ctl.__simErr) { ctl.__simErr = 1; console.warn('[WTS] sim step', e); } } }
        var st = state();
        if (h3 && h3.disposed) h3 = null;
        if (mode === '3d' && !loading) {
            if (h3 && onScreen) { try { h3.frame(st, dt); } catch (e) { console.warn('[WTS] 3D frame', e); } }
        } else if (onScreen) {
            var moving = (st && st.running) || flowGain > 0.001;
            if (moving ? ts - t2d > 100 : dirty2d) {
                var d2 = t2d ? Math.min((ts - t2d) / 1000, 0.25) : 0;
                t2d = ts; dirty2d = false;
                draw2dLive(st, d2);
            }
        }
        if (loading) loadingTick(dt * 1000);
        if (ts - tHud > 250) { tHud = ts; updateAll(st); }
        if (ts - tSlow > 1000) { tSlow = ts; updateSlow(st); }
        if (ts - tPub > 5000) { tPub = ts; publishSummary(st); }
        if (ts - tSr > 10000) { tSr = ts; updateSr(st); }
    }
    function publishSummary(st) {
        if (!st) return;
        try { G.WTS_state = G.WTS_state || {}; G.WTS_state.sim = summaryOf(st); } catch (e) {}
    }
    function updateSr(st) {
        if (!st || !E.sr) return;
        var c = alarmCount(st.alarms);
        var s = 'Separator ' + fmtU(st.sep && st.sep.P, 'pressureG') + ', liquid ' + pctStr(st.sep && st.sep.c1 && st.sep.c1.fracL) +
            '; surge ' + pctStr(st.surge && st.surge.frac) + '; ' + (c.n ? c.n + ' active alarm' + (c.n > 1 ? 's' : '') : 'no active alarms');
        setText(E.sr, s);
    }

    // ── 4 Hz / 1 Hz updates ──────────────────────────────────────────
    function updateAll(st) {
        if (st) {
            if (st.alarmVersion !== lastAlarmVersion) {
                lastAlarmVersion = st.alarmVersion;
                _alarmMap = alarmReduce(_alarmMap, st.alarms || [], st.t, null);
            }
            if (st.health && st.health.flowInvalid && !lastFlowInvalid) toast('Inputs invalid — simulation holding the last valid flow', 'bad');
            lastFlowInvalid = !!(st.health && st.health.flowInvalid);
        }
        var dpr = num(G.devicePixelRatio, 1);
        if (mode === '2d' && lastDpr && Math.abs(dpr - lastDpr) > 0.01) size2d();
        updateToolbar(st); updateHud(st); updatePill(st); updateCard(st, false); if (E.vin) renderVin(st);
        if (popGroup) updatePop(st);
        show(E.paused, !!(st && !st.running));
    }
    function updateSlow(st) {
        renderRig(st, false);
        if (drawerOpen) renderDrawer(st, false);
        if (!E.trends.hidden) drawTrends(st);
        if (cardId) updateCard(st, true);
        if (!E.legend.hidden) renderLegend(st);
        var nowT = nowMs();
        if (h3 && okSince && fails.length && nowT - okSince > 30000) fails = [];
    }
    function esdState(st) {
        var e = st && st.esd;
        if (!e) return 'open';
        return e.tripped ? (e.manual ? 'manual' : 'closed') : 'open';
    }
    function updateToolbar(st) {
        var running = !!(st && st.running), es = esdState(st), sp = st ? num(st.speed, prefs.speed) : prefs.speed;
        setAttr(vizEl, 'data-esd', es);
        setAttr(E.brand, 'data-s', es === 'closed' ? 'trip' : es === 'manual' ? 'manual' : running ? 'run' : 'paused');
        if (es !== 'open') setText(E.brandT, 'ESD');
        else setText(E.brandT, mode === '3d' ? 'LIVE 3D' : 'LIVE 2D');
        setHTML(E.play, running ? ICON.pause : ICON.play);
        setAttr(E.play, 'aria-pressed', running ? 'true' : 'false');
        setAttr(E.play, 'aria-label', running ? 'Pause' : 'Play');
        setAttr(E.play, 'title', (running ? 'Pause' : 'Play') + ' (Space)');
        E.play.disabled = !_sim;
        for (var i = 0; i < E.speedBtns.length; i++) E.speedBtns[i].classList.toggle('on', +E.speedBtns[i].getAttribute('data-v') === sp);
        setText(E.speedchip, '×' + sp);
        if (E.h.spd) setText(E.h.spd, '×' + sp);
        // ESD button
        if (es === 'open') {
            setText(E.esd, 'ESD'); E.esd.classList.remove('rst'); E.esd.disabled = !_sim;
            setAttr(E.esd, 'title', 'Trip the ESD valve SDV-101 (E)'); setAttr(E.esd, 'aria-label', 'ESD');
        } else {
            setText(E.esd, 'Reset ESD'); E.esd.classList.add('rst');
            var e = st.esd, can = !!e.canReset;
            E.esd.disabled = !can;
            setAttr(E.esd, 'title', can ? 'Reset the ESD and reopen SDV-101' : 'Active: ' + (e.blocking || []).map(tagOfAlarmId).join(', '));
            setAttr(E.esd, 'aria-label', 'Reset ESD');
        }
        // Alarms badge (D38)
        var c = alarmCount(st && st.alarms);
        show(E.badge, c.n > 0);
        setText(E.badge, String(c.n));
        setAttr(E.badge, 'data-l', c.level);
        E.alarms.classList.toggle('on', drawerOpen);
        // Display toggles
        var lm = LABEL_MODES.filter(function (x) { return x[0] === prefs.labels; })[0];
        setText(E.labels, lm ? lm[1] : 'All');
        E.legendB.classList.toggle('on', !!prefs.legend); setAttr(E.legendB, 'aria-pressed', prefs.legend ? 'true' : 'false');
        E.trendsB.classList.toggle('on', !!prefs.trends); setAttr(E.trendsB, 'aria-pressed', prefs.trends ? 'true' : 'false');
        setHTML(E.maxB, isMax ? ICON.min + '<span class="wtsl-txt-md">Done</span>' : ICON.max + '<span class="wtsl-txt-md">Max</span>');
        setAttr(E.maxB, 'aria-label', isMax ? 'Done' : 'Max');
    }
    function tagOfAlarmId(id) {
        var S = _sim && _sim.getState();
        var A = S && S.alarms || [];
        for (var i = 0; i < A.length; i++) if (A[i].id === id) return A[i].tag || id;
        return id;
    }
    function hv(k, v, cat, dp) {
        var p = fmtParts(v, cat, dp);
        setText(E.h[k], p.v); setText(E.h[k + 'U'], p.u);
    }
    function trendArrow(key, v, span) {
        var b = trendBuf[key];
        if (!isNum(v)) { b.length = 0; return ''; }
        b.push(v); if (b.length > 8) b.shift();
        if (b.length < 8 || !(span > 0)) return '';
        var d = b[b.length - 1] - b[0];
        return d > 0.005 * span ? '▲' : d < -0.005 * span ? '▼' : '';
    }
    function updateHud(st) {
        if (!E.h.clock) return;
        var N = (st && st.nodes) || {}, R = (st && st.rates) || {}, C = (st && st.cum) || {}, I = (st && st.inputs) || {};
        var sep = (st && st.sep) || {}, su = (st && st.surge) || {}, ga = (st && st.gauge) || {};
        setText(E.h.clock, st ? (st.clock || fmtClockLocal(st.t)) : '--:--:--');
        var es = esdState(st), s = !st ? 'paused' : es === 'closed' ? 'trip' : es === 'manual' ? 'manual' : st.running ? 'run' : 'paused';
        setAttr(E.h.state, 'data-s', s);
        setText(E.h.state, !st ? 'WAITING' : s === 'trip' ? 'ESD TRIPPED' : s === 'manual' ? 'ESD CLOSED' : s === 'run' ? 'RUNNING' : 'PAUSED');
        // Pressures
        hv('pWh', N.wellhead && N.wellhead.P, 'pressureG');
        var ck = N.choke || {};
        var pin = fmtParts(ck.Pin, 'pressureG'), pout = fmtParts(ck.P, 'pressureG');
        setText(E.h.pCk, pin.v + '→' + pout.v); setText(E.h.pCkU, pout.u);
        hv('pSep', sep.P, 'pressureG');
        setText(E.h.pSepL, isNum(sep.SPeff) ? 'Sep · SP ' + fmtParts(sep.SPeff, 'pressureG').v : 'Sep');
        sepBar(E.h.sepbar, sep, 120);
        hv('pSu', su.P, 'pressureTank');
        // Rates
        var Qg = num(I.Qg, 10), Qo = num(I.Qo, 1000), Qw = num(I.Qw, 200);
        if (R.separated === false) R = { gas_mmscfd: NaN, oilMeter_stbd: NaN, waterMeter_bpd: NaN, gor_scf_stb: null, bsw_pct: null };   // V-101 bypassed: no meters
        hv('rG', R.gas_mmscfd, 'gasRate'); setText(E.h.rGA, trendArrow('gas', R.gas_mmscfd, 1.5 * Qg));
        var oil = num(R.oilMeter_stbd, R.oil_stbd), wat = num(R.waterMeter_bpd, R.water_bpd);
        hv('rO', oil, 'oilRate'); setText(E.h.rOA, trendArrow('oil', oil, 1.5 * Qo));
        hv('rW', wat, 'liquidRate'); setText(E.h.rWA, trendArrow('water', wat, 1.5 * Qw));
        hv('rR', R.gor_scf_stb, 'gor'); setText(E.h.rRA, trendArrow('gor', R.gor_scf_stb, Qo > 0 ? 1.5 * Qg * 1e6 / Qo : 0));
        hv('rB', R.bsw_pct, 'percent', 1); setText(E.h.rBA, trendArrow('bsw', R.bsw_pct, 100));
        // Cumulative
        hv('cO', C.oilIn_stb, 'oilVolume'); hv('cW', C.waterIn_bbl, 'volume'); hv('cG', C.gasIn_mmscf, 'gasVolume'); hv('cF', C.flare_mmscf, 'gasVolume');
        // Tanks and quality
        var ps2 = xferShort(st), SC = su.comps || [];
        if (rigOut(st, 'surge')) setHTML(E.h.tSu, 'Surge tank <b>out of rig-up</b>');
        else setHTML(E.h.tSu, SC.length === 2 ? 'Surge ' + [0, 1].map(function (i) {
            return (SC[i].inlet ? '<span class="a">▸' : '<span>') + (i ? 'B ' : 'A ') + '</span><b>' + pctStr(SC[i].frac) + '</b>';
        }).join(' · ') + ' · LCV-201 ' + esc(ps2) : 'Surge <b>' + pctStr(su.frac) + '</b> · LCV-201 ' + esc(ps2));
        var T = ga.tanks || [], act = num(ga.active, 0);
        var gtxt = [0, 1].map(function (i) {
            var t = T[i] || {}, v = num(t.Vo_bbl, 0) + num(t.Vw_bbl, 0);
            var p = fmtParts(T[i] ? v : NaN, 'volume', 1);
            return ((t.inlet != null ? t.inlet : i === act) ? '<span class="a">▸' : '<span>') + (i ? 'B ' : 'A ') + '</span><b>' + p.v + '</b>';
        }).join(' · ') + ' ' + fmtParts(0, 'volume').u;
        var sh = R.shrink_pct;
        if (rigOut(st, 'gauge')) setHTML(E.h.tGt, 'Gauge tank <b>out of rig-up</b>');
        else setHTML(E.h.tGt, gtxt + (isNum(sh) ? ' · shr ' + sh.toFixed(1) + '%' : ''));
        var c = alarmCount(st && st.alarms);
        setAttr(E.h.tAl, 'data-l', c.n ? c.level : 'ok');
        setText(E.h.tAl, c.n ? '⚠ ' + c.n + ' active' : '● No active alarms');
        // Phone tiles
        if (bp === 'sm') updateTiles(st);
    }
    function sepBar(el, sep, pxW) {
        if (!el) return;
        var sp = num(sep.SPeff, num(sep.SP, 150)), P = num(sep.P, sp);
        var psh = num(sep.psh, sp + 15), pshh = num(sep.pshh, sp + 30), psl = num(sep.psl, sp - 30);
        var lo = Math.min(psl, P) - 2, hi = Math.max(pshh, P) + 2, span = Math.max(hi - lo, 1);
        var x = function (v) { return (clamp((v - lo) / span, 0, 1) * 100).toFixed(1) + '%'; };
        var k = [lo.toFixed(0), hi.toFixed(0), P.toFixed(1), sp.toFixed(1)].join(',');
        if (el.__k === k) return;
        el.__k = k;
        var band = el.children[0], tA = el.children[1], tR = el.children[2], mkr = el.children[3];
        band.style.left = x(sp - 5); band.style.width = ((10 / span) * 100).toFixed(1) + '%';
        tA.style.left = x(psh); tR.style.left = x(pshh); mkr.style.left = x(P);
    }
    function updateTiles(st) {
        var N = (st && st.nodes) || {}, R = (st && st.rates) || {}, su = (st && st.surge) || {}, ga = (st && st.gauge) || {};
        var h = E.h;
        setText(h.t_clockL, 'Clock'); setText(h.t_clock, 'T+' + (st ? st.clock || fmtClockLocal(st.t) : '--:--:--'));
        setText(h.t_clock2, '×' + (st ? st.speed : prefs.speed) + ' ' + (h.state ? h.state.textContent : ''));
        setText(h.t_pressL, 'Pressures');
        setText(h.t_press, 'WHP ' + fmtU(N.wellhead && N.wellhead.P, 'pressureG'));
        var sp0 = st && st.sep && st.sep.P;
        setText(h.t_press2, 'Sep ' + fmtParts(sp0, 'pressureG', 0).v + ' · Srg ' + fmtParts(su.P, 'pressureTank', isNum(su.P) && Math.abs(su.P) >= 10 ? 0 : 1).v);
        setText(h.t_ratesL, 'Gas / Oil');
        setText(h.t_rates, fmtU(R.gas_mmscfd, 'gasRate'));
        setText(h.t_rates2, fmtU(num(R.oilMeter_stbd, R.oil_stbd), 'oilRate'));
        setText(h.t_waterL, 'Water');
        setText(h.t_water, fmtU(num(R.waterMeter_bpd, R.water_bpd), 'liquidRate'));
        setText(h.t_water2, 'BS&W ' + fmtU(R.bsw_pct, 'percent', 1));
        setText(h.t_tanksL, 'Tanks');
        setText(h.t_tanks, su.comps && su.comps.length === 2 ? 'Surge ' + pctStr(su.comps[0].frac) + ' · ' + pctStr(su.comps[1].frac) : 'Surge ' + pctStr(su.frac));
        var T = ga.tanks || [];
        setText(h.t_tanks2, 'A ' + fmtParts(T[0] ? num(T[0].Vo_bbl, 0) + num(T[0].Vw_bbl, 0) : NaN, 'volume', 0).v + ' · B ' +
            fmtParts(T[1] ? num(T[1].Vo_bbl, 0) + num(T[1].Vw_bbl, 0) : NaN, 'volume', 0).v + ' ' + fmtParts(0, 'volume').u);
        var c = alarmCount(st && st.alarms);
        setText(h.t_alarmL, 'Alarms');
        setText(h.t_alarm, c.n ? '⚠ ' + c.n + ' active' : '● None');
        setText(h.t_alarm2, 'Tap for details');
    }

    // ── alarm pill / banner (§6.5) ───────────────────────────────────
    function updatePill(st) {
        var el = E.alarm, e = st && st.esd;
        if (e && e.tripped) {
            var manual = !!e.manual;
            var sig = 'b|' + manual + '|' + e.causeMsg + '|' + e.canReset;
            if (el.__sig !== sig) {
                el.__sig = sig;
                el.className = 'wtsl-alarm rp-skip banner ' + (manual ? 'manual' : 'trip');
                el.removeAttribute('data-sev');
                el.setAttribute('role', manual ? 'status' : 'alert');
                el.setAttribute('aria-live', manual ? 'polite' : 'assertive');
                el.innerHTML = '<span class="g">' + (manual ? '■' : '⚠') + '</span><span class="msg"><b>' + (manual ? 'ESD CLOSED (manual)' : 'ESD TRIPPED') +
                    '</b> — ' + esc(e.causeMsg || '') + '</span>' +
                    '<button type="button" data-wts-ui class="wtsl-b" data-act="esd-reset"' + (e.canReset ? '' : ' disabled title="' +
                    esc('Active: ' + (e.blocking || []).map(tagOfAlarmId).join(', ')) + '"') + '>Reset ESD</button>';
            }
            show(el, true);
            return;
        }
        var p = pillPick(_alarmMap);
        if (!p) { if (!el.hidden) { el.hidden = true; el.__sig = ''; } return; }
        var others = unackCount(_alarmMap) - (p.state === 'UNACK' ? 1 : 0);
        var sev = STATUS_MAP_LOCAL[p.sev] === 'alarm' ? 'alarm' : p.sev;
        var txt = alarmText(p);
        var sig2 = p.id + '|' + p.state + '|' + txt + '|' + others + '|' + sev;
        if (el.__sig !== sig2) {
            el.__sig = sig2;
            el.className = 'wtsl-alarm rp-skip' + (p.state === 'UNACK' && !reduced ? ' unack' : '') + (p.state === 'RTN' ? ' isrtn' : '');
            el.setAttribute('data-sev', sev);
            el.setAttribute('role', sev === 'alarm' ? 'alert' : 'status');
            el.setAttribute('aria-live', sev === 'alarm' ? 'assertive' : 'polite');
            el.setAttribute('data-act', 'alarms');
            var gl = sev === 'alarm' ? '⚠' : sev === 'warn' ? '▲' : '❄';
            el.innerHTML = '<span class="g">' + gl + (reduced && p.state === 'UNACK' ? '!' : '') + '</span><span class="eq">' + esc(eqAbbr(p.eq)) + '</span>' +
                '<span class="tg">· ' + esc(p.tag || p.id) + ' ·</span><span class="msg">' + esc(txt) + '</span>' +
                (p.state === 'RTN' ? '<span class="rtn">RTN</span>' : '') + (others > 0 ? '<span class="more">+' + others + '</span>' : '') +
                (p.state !== 'ACK' ? '<button type="button" data-wts-ui class="wtsl-b" data-act="ack" data-v="' + esc(p.id) + '">Ack</button>' : '');
        }
        show(el, true);
    }
    function eqAbbr(eq) {
        if (!eq) return '';
        if (EQ_ABBR[eq]) return EQ_ABBR[eq];
        if (/^seg:/.test(eq)) return 'LINE';
        return String(eq).toUpperCase();
    }
    function ack(ids) {
        var st = state();
        if (!ids || !ids.length) return;
        _alarmMap = alarmReduce(_alarmMap, (st && st.alarms) || [], st ? st.t : 0, ids);
        track('wts_alarm_ack', {});   // no payload: how many alarms were acknowledged is simulation data
        if (E.alarm) E.alarm.__sig = '';
        updatePill(st);
        if (drawerOpen) renderDrawer(st, true);
    }
    function ackAll() {
        var ids = [];
        for (var id in _alarmMap) if (Object.prototype.hasOwnProperty.call(_alarmMap, id) && _alarmMap[id].state !== 'ACK') ids.push(id);
        ack(ids);
    }

    // ── drawer (§6.5) ────────────────────────────────────────────────
    function toggleDrawer(onOff) {
        drawerOpen = onOff == null ? !drawerOpen : !!onOff;
        closeMenu();
        show(E.drawer, drawerOpen);
        drawerSig = '';
        if (drawerOpen) renderDrawer(state(), true);
        updateToolbar(state());
    }
    function renderDrawer(st, force) {
        var ids = Object.keys(_alarmMap).sort(function (a, b) {
            var x = _alarmMap[a], y = _alarmMap[b];
            return (SEV_RANK[y.sev] || 0) - (SEV_RANK[x.sev] || 0) || num(y.tOn, 0) - num(x.tOn, 0);
        });
        var log = (st && st.alarmLog) || [];
        var W = (_lastFlowObj && _lastFlowObj.warnings) || [];
        var sig = drawerTab + '|' + ids.map(function (i) { return i + _alarmMap[i].state + alarmText(_alarmMap[i]); }).join(',') + '|' + log.length + '|' +
            (log.length ? log[log.length - 1].t : 0) + '|' + W.length + unitsSys();
        if (!force && sig === drawerSig) return;
        drawerSig = sig;
        var nAl = ids.length;
        var h = '<div class="wtsl-dtabs" role="tablist"><button type="button" data-wts-ui role="tab" data-act="dtab" data-v="alarms" class="' + (drawerTab === 'alarms' ? 'on' : '') +
            '" aria-selected="' + (drawerTab === 'alarms') + '">Alarms (' + nAl + ')</button><button type="button" data-wts-ui role="tab" data-act="dtab" data-v="events" class="' +
            (drawerTab === 'events' ? 'on' : '') + '" aria-selected="' + (drawerTab === 'events') + '">Events</button></div><div class="wtsl-dbody">';
        if (drawerTab === 'alarms') {
            if (!nAl) h += '<div class="wtsl-empty">No active or unacknowledged alarms</div>';
            ids.forEach(function (id) {
                var a = _alarmMap[id];
                h += '<div class="wtsl-row ' + (a.state === 'UNACK' ? 'unack' : a.state === 'RTN' ? 'rtn' : '') + '" data-act="focus" data-v="' + esc(a.eq) + '">' +
                    '<span class="wtsl-sev" data-s="' + esc(a.sev) + '">' + esc(a.sev) + '</span><span class="t">T+' + esc((_sim && G.WTS_sim && G.WTS_sim.fmtClock ? G.WTS_sim.fmtClock(a.tOn) : fmtClockLocal(a.tOn))) + '</span>' +
                    '<span class="tg">' + esc(a.tag || a.id) + '</span><span class="m" title="' + esc(alarmText(a)) + '">' + esc(alarmText(a)) + '</span>' +
                    (a.state === 'ACK' ? '<span class="s">ACK</span>' : '<button type="button" data-wts-ui class="wtsl-b" data-act="ack" data-v="' + esc(a.id) + '">' + (a.state === 'RTN' ? 'Ack RTN' : 'Ack') + '</button>') + '</div>';
            });
            h += '<div class="wtsl-dh">Design warnings (steady calculation)</div>';
            if (!W.length) h += '<div class="wtsl-dw" style="color:#6e7681">None — the steady calculation is within limits.</div>';
            W.forEach(function (w) {
                var ic = w.t === 'error' || w.t === 'warn' ? '⚠' : w.t === 'info' ? '❄' : 'ℹ';
                h += '<div class="wtsl-dw">' + ic + ' ' + esc(w.m) + '</div>';
            });
        } else {
            if (!log.length) h += '<div class="wtsl-empty">No events yet</div>';
            for (var i = log.length - 1; i >= 0; i--) {
                var ev = log[i];
                h += '<div class="wtsl-ev"><span class="t">T+' + esc(fmtClockLocal(ev.t)) + '</span><span class="ty">' + esc(ev.type) + '</span><span>' +
                    esc((ev.tag ? ev.tag + ' · ' : '') + (ev.msg || '')) + '</span></div>';
            }
        }
        h += '</div><div class="wtsl-dfoot"><button type="button" data-wts-ui class="wtsl-b" data-act="ackall">Ack all</button>' +
            '<button type="button" data-wts-ui class="wtsl-b" data-act="drawer-close">Close</button></div>';
        var sc = q('.wtsl-dbody', E.drawer), top = sc ? sc.scrollTop : 0;
        E.drawer.innerHTML = h;
        var sc2 = q('.wtsl-dbody', E.drawer); if (sc2) sc2.scrollTop = top;
    }

    // ── info card (§6.6) ─────────────────────────────────────────────
    // Row spec: [label, getter(st) → string, cls, design(st, flow) → string|null]
    function cardSpec(id) {
        var P = function (v) { return fmtU(v, 'pressureG'); }, T = function (v) { return fmtU(v, 'temperature', 1); };
        var N = function (st, k) { return (st && st.nodes && st.nodes[k]) || {}; };
        var F = function (fl, path) { var o = fl; for (var i = 0; o && i < path.length; i++) o = o[path[i]]; return o; };
        switch (id) {
            case 'wellhead': return { rows: [
                ['Pressure', function (s) { return P(N(s, 'wellhead').P); }, 'p', function (s, f) { return isNum(F(f, ['inputs', 'Pwh'])) ? 'design ' + P(f.inputs.Pwh) : null; }],
                ['Temperature', function (s) { return T(N(s, 'wellhead').T); }, 't', function (s, f) { return isNum(F(f, ['inputs', 'Twh'])) ? 'design ' + T(f.inputs.Twh) : null; }],
                ['Hydrate T', function (s) { return T(N(s, 'wellhead').th); }, 't'],
                ['Gas', function (s) { return fmtU(num(s && s.inputs && s.inputs.Qg, NaN) * num(s && s.f, 1), 'gasRate'); }, ''],
                ['Oil', function (s) { return fmtU(num(s && s.inputs && s.inputs.Qo, NaN) * num(s && s.f, 1), 'oilRate'); }, ''],
                ['Water', function (s) { return fmtU(num(s && s.inputs && s.inputs.Qw, NaN) * num(s && s.f, 1), 'liquidRate'); }, ''],
                ['GOR', function (s) { return fmtU(s && s.rates && s.rates.gor_scf_stb, 'gor'); }, '']],
                spark: [{ keys: ['Pwh'], label: 'WHP', cat: 'pressureG' }, { keys: ['Twh'], label: 'Wellhead T', cat: 'temperature' }] };
            case 'esd': return { rows: [
                ['State', function (s) { var e = s && s.esd; return !e ? '—' : e.tripped ? (e.manual ? 'CLOSED (manual)' : 'TRIPPED') : e.moving ? 'MOVING' : 'OPEN'; }, ''],
                ['Travel', function (s) { return pctStr(s && s.esd && s.esd.travel); }, ''],
                ['Upstream P', function (s) { return P(N(s, 'wellhead').P); }, 'p'],
                ['Downstream P', function (s) { return P(N(s, 'esd').P); }, 'p'],
                ['Cause', function (s) { var e = s && s.esd; return e && e.tripped ? (e.causeMsg || e.cause || '—') : '—'; }, '']],
                spark: [{ keys: ['Pwh', 'Pchoke'], label: 'WHP · choke out', cat: 'pressureG', indep: true }],
                widget: 'travel', actions: 'esd' };
            case 'choke': return { rows: [
                ['Upstream P', function (s) { return P(N(s, 'choke').Pin); }, 'p'],
                ['Downstream P', function (s) { return P(N(s, 'choke').P); }, 'p', function (s, f) { return isNum(F(f, ['choke', 'Pout'])) ? 'design ' + P(f.choke.Pout) : null; }],
                ['Regime', function (s) { var c = N(s, 'choke'); return (c.flowLimited ? 'LIMITED · ' : '') + String(c.regime || '—').toUpperCase(); }, ''],
                ['Bean', function (s) { var c = N(s, 'choke'); return isNum(c.bean) ? c.bean + '/64″' : '—'; }, ''],
                ['ΔP', function (s) { var c = N(s, 'choke'); return fmtU(num(c.Pin, NaN) - num(c.P, NaN), 'pressureG'); }, 'p'],
                ['Outlet T', function (s) { return T(N(s, 'choke').T); }, 't'],
                ['J-T ΔT', function (s) { var v = N(s, 'choke').dTjt; return isNum(v) ? fmtU(v, 'tempDelta', 1) : '—'; }, 't'],
                ['Capacity', function (s) { return fmtU(N(s, 'choke').QmaxMMscfd, 'gasRate'); }, '']],
                spark: [{ keys: ['Pchoke'], label: 'Choke outlet P', cat: 'pressureG' }], widget: 'capacity', actions: 'bean' };
            case 'heater': return { rows: [
                ['Outlet P', function (s) { return P(N(s, 'heater').P); }, 'p'],
                ['Inlet T', function (s) { return T(N(s, 'heater').Tin); }, 't'],
                ['Outlet T', function (s) { return T(N(s, 'heater').T); }, 't', function (s, f) { return isNum(F(f, ['inputs', 'Thtr'])) ? 'setpoint ' + T(f.inputs.Thtr) : null; }],
                ['Firing', function (s) { var h = N(s, 'heater'); return h.bypass ? 'BYPASSED' : pctStr(h.firing); }, ''],
                ['Duty', function (s) { return fmtU(N(s, 'heater').dutyMMBtuHr, 'powerLarge'); }, '', function (s, f) { return isNum(F(f, ['heater', 'dutyMMBtuHr'])) ? 'design ' + fmtU(f.heater.dutyMMBtuHr, 'powerLarge') : null; }],
                ['Hydrate T', function (s) { return T(N(s, 'heater').th); }, 't']],
                actions: 'bypass' };
            case 'separator': return { rows: [
                ['Pressure', function (s) { return P(s && s.sep && s.sep.P); }, 'p'],
                ['Setpoint', function (s) { var p = s && s.sep; if (!p) return '—'; var a = P(p.SP); return isNum(p.SPeff) && Math.abs(p.SPeff - p.SP) > 0.5 ? a + ' (ramp ' + fmtParts(p.SPeff, 'pressureG').v + ')' : a; }, 'p'],
                ['Temperature', function (s) { return T(s && s.sep && s.sep.T); }, 't'],
                ['Liquid (inlet)', function (s) { return pctStr(s && s.sep && s.sep.c1 && s.sep.c1.fracL); }, ''],
                ['Interface', function (s) { return pctStr(s && s.sep && s.sep.c1 && s.sep.c1.fracW); }, ''],
                ['Oil bucket', function (s) { return pctStr(s && s.sep && s.sep.bucket && s.sep.bucket.frac); }, ''],
                ['Gas out', function (s) { return fmtU(s && s.sep && s.sep.gasOut_mmscfd, 'gasRate'); }, ''],
                ['Residence', function (s) { var v = s && s.sep && s.sep.tRes_min; return isNum(v) && v < 9999 ? v.toFixed(1) + ' min' : '—'; }, ''],
                ['Oil dump', function (s) { var d = s && s.sep && s.sep.oilDump; return d ? fmtU(d.q_bpd, 'liquidRate') + (d.x > 0.02 ? ' · open' : '') : '—'; }, ''],
                ['Water dump', function (s) { var d = s && s.sep && s.sep.waterDump; return d ? fmtU(d.q_bpd, 'liquidRate') + (d.x > 0.02 ? ' · open' : '') : '—'; }, '']],
                spark: [{ keys: ['Psep', 'PsepSP'], label: 'Pressure · SP', cat: 'pressureG', lim: 'sepP' },
                        { keys: ['bucketFrac', 'ifaceFrac'], label: 'Bucket · interface', cat: 'frac', lim: 'sepL' }],
                widget: 'sepgauge', actions: 'sp' };
            case 'surge': return { rows: [
                ['Level (A+B)', function (s) { return pctStr(s && s.surge && s.surge.frac); }, ''],
                ['T-201A', function (s) { return surgeRow(s, 0); }, ''],
                ['T-201B', function (s) { return surgeRow(s, 1); }, ''],
                ['Pressure', function (s) { return fmtU(s && s.surge && s.surge.P, 'pressureTank'); }, 'p', function (s, f) { return isNum(F(f, ['sim', 'surgeP_psig'])) ? 'SP ' + fmtU(f.sim.surgeP_psig, 'pressureTank') : null; }],
                ['Liquid', function (s) { var u = s && s.surge; return u ? fmtU(num(u.Vo_bbl, 0) + num(u.Vw_bbl, 0), 'volume') : '—'; }, '', function (s) { return s && s.surge && isNum(s.surge.cap_bbl) ? 'of ' + fmtU(s.surge.cap_bbl, 'volume') : null; }],
                ['Water cut', function (s) { var u = s && s.surge; return u && isNum(u.frac) && u.frac > 0.001 ? pctStr(num(u.fracW, 0) / u.frac) : '—'; }, ''],
                ['Transfer', function (s) { return xferTxt(s); }, '', function (s) { var p = xferOf(s); return p && isNum(p.q_bpd) && p.q_bpd > 0 ? fmtU(p.q_bpd, 'liquidRate') : null; }],
                ['Transfer ΔP', function (s) { var p = xferOf(s); return p && isNum(p.dP_psi) ? fmtU(p.dP_psi, 'pressure', 1) : '—'; }, 'p',
                    function (s) { var p = xferOf(s); return p ? 'LCV-201 by vessel pressure (no pump)' + (isNum(p.dPdesign_psi) ? ' · design ' + fmtU(p.dPdesign_psi, 'pressure', 1) : '') : null; }],
                ['Time to HH', function (s) { var v = s && s.surge && s.surge.tFull_s; return isNum(v) ? fmtClockLocal(v) : '—'; }, ''],
                ['Flash gas', function (s) { var v = s && s.surge && s.surge.flash_mscfd; return isNum(v) ? v.toFixed(1) + ' MSCFD' : '—'; }, ''],
                ['Auto-divert', function (s) { return autoTxt(s && s.surge && s.surge.auto); }, '']],
                spark: [{ keys: ['surgeFracA', 'surgeFracB'], label: 'A · B level', cat: 'frac', lim: 'surgeL' }, { keys: ['surgeP'], label: 'Pressure', cat: 'pressureG' }],
                widget: 'strap', actions: 'surge' };
            // P-201: downstream of the gauge tank (T-301 → export / burner); T-201 → T-301 runs on the surge tank pressure
            case 'pump': return { rows: [
                ['State', function (s) { return pumpShort(s); }, ''],
                ['Service', function () { return 'T-301 → export / burner'; }, ''],
                ['Rate', function (s) { var p = s && s.gauge && s.gauge.pump; return fmtU(p && p.q_bpd, 'liquidRate'); }, '', function (s) { var p = s && s.gauge && s.gauge.pump; return p && isNum(p.design_bpd) ? 'design ' + fmtU(p.design_bpd, 'liquidRate') : null; }],
                ['Draining', function (s) { var T = s && s.gauge && s.gauge.tanks; if (!T || !T[0]) return '—'; var d = [0, 1].filter(function (i) { return T[i].state === 'draining'; }).map(function (i) { return T[i].tag; }); return d.length ? d.join(' + ') : 'none'; }, ''],
                ['Surge transfer', function (s) { return 'LCV-201 ' + xferShort(s) + ' (no pump)'; }, '']] };
            case 'gauge': return { rows: [
                ['Inlet', function (s) { var g = s && s.gauge, T = g && g.tanks; if (!T || !T[0]) return '—'; if (T[0].inlet == null) return T[num(g.active, 0)].tag;
                    return g.blocked ? 'BLOCKED (both closed)' : [0, 1].filter(function (i) { return T[i].inlet; }).map(function (i) { return T[i].tag; }).join(' + '); }, ''],
                ['T-301A', function (s) { return gtRow(s, 0); }, ''],
                ['T-301B', function (s) { return gtRow(s, 1); }, ''],
                ['Last batch', function (s) { var r = s && s.rates; return fmtU(r && r.tank_stbd, 'oilRate'); }, ''],
                ['BS&W', function (s) { var r = s && s.rates; return fmtU(r && r.bsw_pct, 'percent', 1); }, ''],
                ['Shrinkage', function (s) { var r = s && s.rates; return fmtU(r && r.shrink_pct, 'percent', 1); }, ''],
                ['Auto-divert', function (s) { return autoTxt(s && s.gauge && s.gauge.auto); }, '']],
                spark: [{ keys: ['gaugeFracA', 'gaugeFracB'], label: 'A · B level', cat: 'frac', lim: 'gauge' }],
                widget: 'gstrap', actions: 'swap' };
            case 'flare': return { rows: [
                ['Flared gas', function (s) { return fmtU(N(s, 'flare').qMMscfd, 'gasRate'); }, ''],
                ['Header P', function (s) { return P(N(s, 'flare').P); }, 'p'],
                ['Line P (u/s)', function (s) { return P(N(s, 'flare').Pline); }, 'p'],
                ['Line vel', function (s) { var g = s && s.segs && s.segs[4]; return g ? fmtU(g.vel, 'velocity') : '—'; }, ''],
                ['Flared total', function (s) { return fmtU(s && s.cum && s.cum.flare_mmscf, 'gasVolume'); }, '']],
                spark: [{ keys: ['qgFlare'], label: 'Flared gas', cat: 'gasRate' }], widget: 'linevel' };
        }
        return { rows: [] };
    }
    function surgeRow(s, i) {
        var c = s && s.surge && s.surge.comps && s.surge.comps[i];
        if (!c) return '—';
        return pctStr(c.frac) + (isNum(c.T) ? ' · ' + fmtU(c.T, 'temperature') : '') + ' · inlet ' + vState(c) + (c.suction ? ' · suction' : '');
    }
    // valve state text: commanded position, or travel with the actual opening while the valve strokes
    function vState(c) {
        if (!c) return '—';
        if (c.hold) return 'CLOSE HELD';
        if (c.moving) return (c.inlet ? 'OPENING ' : 'CLOSING ') + Math.round(num(c.pos, 0) * 100) + '%';
        return c.inlet ? 'OPEN' : 'CLOSED';
    }
    // LCV-201 surge → gauge transfer (no pump: the surge tank pressure drives the liquid)
    function xferTxt(s) {
        var p = xferOf(s);
        if (!p) return '—';
        if (rigOut(s, 'surge')) return 'OUT OF RIG-UP';
        return p.failed ? 'STUCK SHUT' : p.tripped ? 'TRIPPED' + tripTag(p.trip) : p.blocked ? 'BLOCKED' :
            p.on ? (p.lowDP ? 'OPEN · ΔP TOO LOW' : p.starved ? 'OPEN · STARVED' : 'OPEN') + (p.dest === 'export' ? ' → export' : '') : 'SHUT';
    }
    function tripTag(id) { return id === 'LSHH_GT' ? ' (LSHH-301)' : id === 'PUMP_DRYRUN' ? ' (LOW-LOW)' : ''; }
    function pumpSig(st) { var p = xferOf(st); return p ? (p.trip || '') + (p.canReset ? 'r' : '') : ''; }
    function pumpResetRow(st) {
        var p = xferOf(st);
        if (!p || !p.trip) return '';
        // no surge tank in the rig-up: LSHH-301 latched the T-301 inlet only (there is no LCV-201 in line)
        var nx = rigOut(st, 'surge');
        return '<div class="wtsl-actr"><span class="wtsl-hl">' + (nx ? 'LSHH-301 trip' : 'LCV-201 trip') + '</span><button type="button" data-wts-ui class="wtsl-b trip" data-act="xfer-reset"' +
            (p.canReset ? ' title="' + (nx ? 'Reset the latched LSHH-301 trip' : 'Reset the latched LCV-201 transfer trip') + '"' : ' disabled title="' + esc(p.resetBlock || 'permissive not met') + '"') + '>' +
            (nx ? 'Reset LSHH-301' : 'Reset LCV-201' + tripTag(p.trip)) + '</button></div>';
    }
    function strokeRow(eq, o) {
        var v = Math.round(num(o && o.strokeS, 6));
        return '<div class="wtsl-actr"><span class="wtsl-hl">Valve stroke</span>' +
            '<button type="button" data-wts-ui class="wtsl-b" data-act="stroke" data-v="' + eq + ':-1" aria-label="Stroke time minus 1 s" title="Stroke − 1 s">−</button>' +
            '<span class="val" title="Divert valve full-stroke time">' + v + ' s</span>' +
            '<button type="button" data-wts-ui class="wtsl-b" data-act="stroke" data-v="' + eq + ':1" aria-label="Stroke time plus 1 s" title="Stroke + 1 s">+</button></div>';
    }
    function autoTxt(a) { return !a ? '—' : a.on ? 'ON · SP ' + Math.round(num(a.sp, 0) * 100) + '%' : 'OFF'; }
    function gtRow(s, i) {
        var t = s && s.gauge && s.gauge.tanks && s.gauge.tanks[i];
        if (!t) return '—';
        return fmtU(num(t.Vo_bbl, 0) + num(t.Vw_bbl, 0), 'volume', 1) + ' · ' + String(t.state || '').toUpperCase() + (t.hh ? ' · LSHH TRIP' : '') +
            (t.moving || t.hold ? ' · inlet ' + vState(t) : '');
    }
    function onPick(id) {
        if (id && EQ_IDS.indexOf(id) >= 0) openCard(id); else closeCard();
    }
    function openCard(id) {
        closeMenu(); closePop();
        cardId = id;
        var spec = cardSpec(id), st = state();
        var h = '<div class="wtsl-grab"></div><div class="wtsl-ch"><span class="n">' + STEP[id] + '</span><div class="tt"><b>' + TAG[id] + '</b><span>' + esc(NAME[id]) + '</span></div>' +
            '<span class="wtsl-chip" data-cref="chip">OK</span><button type="button" data-wts-ui class="wtsl-b ic" data-act="card-close" aria-label="Close" title="Close (Esc)">' + ICON.x + '</button></div>' +
            '<div class="wtsl-cb"><div class="wtsl-kv">';
        spec.rows.forEach(function (r, i) {
            h += '<div><div class="l">' + esc(r[0]) + '</div><div class="v ' + (r[2] || '') + '" data-cref="v' + i + '">—</div>' + (r[3] ? '<div class="d" data-cref="d' + i + '"></div>' : '') + '</div>';
        });
        h += '</div>';
        (spec.spark || []).forEach(function (sp, i) {
            h += '<div class="wtsl-sh">' + esc(sp.label) + '</div><canvas class="wtsl-sk" data-cref="sk' + i + '" width="280" height="56"></canvas>' +
                '<div class="wtsl-skl"><span data-cref="skt' + i + '"></span><span>now</span></div>';
        });
        if (spec.widget) h += '<div data-cref="wg"></div>';
        if (spec.actions) h += '<div class="wtsl-act" data-cref="act"></div>';
        h += '<div class="wtsl-rigout" data-cref="rigout" hidden></div>';
        h += '</div><div class="wtsl-cf"><button type="button" data-wts-ui class="wtsl-link" data-act="card-edit">Edit inputs ↓</button></div>';
        E.card.innerHTML = h;
        cardRefs = { spec: spec };
        Array.prototype.forEach.call(E.card.querySelectorAll('[data-cref]'), function (e) { cardRefs[e.getAttribute('data-cref')] = e; });
        renderCardActions(st);
        show(E.card, true);
        vizEl.classList.add('card-open');
        if (h3) { try { h3.select(id); } catch (e) {} }
        updateCard(st, true);
        pushInsets();
    }
    function closeCard() {
        if (!cardId) return;
        cardId = null; cardRefs = null;
        show(E.card, false);
        vizEl.classList.remove('card-open');
        if (h3) { try { h3.select(null); } catch (e) {} }
        pushInsets();
    }
    function renderCardActions(st) {
        if (!cardRefs || !cardRefs.act) return;
        var a = cardRefs.spec.actions, h = '', sig;
        var es = esdState(st);
        if (a === 'esd') {
            sig = 'esd' + es + (st && st.esd && st.esd.canReset);
            h = es === 'open' ? '<button type="button" data-wts-ui class="wtsl-b wtsl-esd" data-act="card-trip">Trip ESD</button>'
                : '<button type="button" data-wts-ui class="wtsl-b wtsl-esd rst" data-act="esd-reset"' + (st.esd.canReset ? '' : ' disabled') + '>Reset ESD</button>';
        } else if (a === 'bean') {
            var b = readHost('wts_bean');
            sig = 'bean' + b;
            h = '<button type="button" data-wts-ui class="wtsl-b" data-act="bean" data-v="-2" aria-label="Smaller bean" title="Bean − 2/64″">−</button>' +
                '<span class="val">' + (isNum(b) ? b + '/64″' : '—') + '</span>' +
                '<button type="button" data-wts-ui class="wtsl-b" data-act="bean" data-v="2" aria-label="Larger bean" title="Bean + 2/64″">+</button>';
        } else if (a === 'bypass') {
            var el = hostEl('wts_bypass'), on = el && el.value === '1';
            sig = 'byp' + on;
            h = '<button type="button" data-wts-ui class="wtsl-b' + (on ? ' on' : '') + '" data-act="bypass" aria-pressed="' + on + '">Bypass ' + (on ? 'ON' : 'OFF') + '</button>';
        } else if (a === 'sp') {
            var p = readHost('wts_Psep');
            sig = 'sp' + p + unitsSys();
            h = '<span class="wtsl-hl" style="margin-right:4px">PCV-101 SP</span><button type="button" data-wts-ui class="wtsl-b" data-act="sp" data-v="-5" aria-label="Setpoint minus 5 psi" title="− 5 psi">−</button>' +
                '<span class="val">' + fmtU(p, 'pressureG') + '</span>' +
                '<button type="button" data-wts-ui class="wtsl-b" data-act="sp" data-v="5" aria-label="Setpoint plus 5 psi" title="+ 5 psi">+</button>';
        } else if (a === 'swap') {
            var g = st && st.gauge, other = g && g.tanks && g.tanks[1 - num(g.active, 0)];
            var ready = other && other.state === 'ready', gT = (g && g.tanks) || [];
            var intr = !!(g && g.allowInterrupt);
            sig = 'swap' + ready + lineupSig(gT[0], gT[1], g && g.auto) + pumpSig(st) + intr + (g && g.strokeS);
            h = pumpResetRow(st) + '<div class="wtsl-actr"><span class="wtsl-hl">Inlet</span>' + valveBtns('gauge', gT[0], gT[1]) +
                '<button type="button" data-wts-ui class="wtsl-b" data-act="swap"' + (ready ? '' : ' disabled title="Standby compartment not ready"') + '>Swap tank</button></div>' +
                autoRow('gauge', g && g.auto) +
                '<div class="wtsl-actr"><span class="wtsl-hl">Batches</span><button type="button" data-wts-ui class="wtsl-b' + (intr ? ' on' : '') + '" data-act="interrupt" aria-pressed="' + intr +
                '" title="Allow auto-divert to open a compartment that is settling or draining (interrupts its batch)">' + (intr ? 'Interrupt ALLOWED' : 'Protected') + '</button></div>' +
                strokeRow('gauge', g);
        } else if (a === 'surge') {
            var su2 = (st && st.surge) || {}, C2 = su2.comps || [];
            sig = 'surge' + lineupSig(C2[0], C2[1], su2.auto) + su2.suction + pumpSig(st) + su2.strokeS;
            h = '<div class="wtsl-actr"><span class="wtsl-hl">Inlet</span>' + valveBtns('surge', C2[0], C2[1]) + '</div>' +
                suctionRow(su2.suction) + autoRow('surge', su2.auto) + strokeRow('surge', su2) + pumpResetRow(st);
        }
        if (cardRefs.act.__sig !== sig) { cardRefs.act.__sig = sig; cardRefs.act.innerHTML = h; }
    }
    function lineupSig(a, b, au) {
        var mv = function (c) { return c && (c.moving || c.hold) ? 'm' + Math.round(num(c.pos, 0) * 20) + (c.hold ? 'h' : '') : ''; };
        return (a && a.inlet ? 1 : 0) + '' + (b && b.inlet ? 1 : 0) + mv(a) + mv(b) + (au ? (au.on ? 'on' : 'off') + au.sp : '');
    }
    function valveBtns(eq, a, b) {
        return [a, b].map(function (c, i) {
            var open = !!(c && c.inlet), tag = valveTag(eq, i), mvg = !!(c && (c.moving || c.hold));
            return '<button type="button" data-wts-ui class="wtsl-b ' + (mvg ? 'vmove' : open ? 'vopen' : 'vshut') + '" data-act="valve" data-v="' + eq + ':' + i + '" aria-pressed="' + open +
                '" title="' + tag + ' — click to ' + (open ? 'close' : 'open') + '">' + (i ? 'B' : 'A') + ' ' + (mvg ? vState(c) : open ? 'OPEN' : 'SHUT') + '</button>';
        }).join('');
    }
    function suctionRow(x) {
        return '<div class="wtsl-actr"><span class="wtsl-hl">LCV-201 suction</span>' + [['A', 'A'], ['B', 'B'], ['both', 'A+B']].map(function (o) {
            return '<button type="button" data-wts-ui class="wtsl-b' + (x === o[0] ? ' on' : '') + '" data-act="suction" data-v="' + o[0] + '" aria-pressed="' + (x === o[0]) + '">' + o[1] + '</button>';
        }).join('') + '</div>';
    }
    function autoRow(eq, au) {
        var on = !!(au && au.on), sp = Math.round(num(au && au.sp, eq === 'surge' ? 0.8 : 0.9) * 100);
        return '<div class="wtsl-actr"><span class="wtsl-hl">Auto-divert</span><button type="button" data-wts-ui class="wtsl-b' + (on ? ' on' : '') + '" data-act="auto" data-v="' + eq +
            '" aria-pressed="' + on + '" title="Switch the inlet to the other compartment at the high-level set point (open new, then close old)">' + (on ? 'ON' : 'OFF') + '</button>' +
            '<button type="button" data-wts-ui class="wtsl-b" data-act="autosp" data-v="' + eq + ':-0.05" aria-label="Set point minus 5 %" title="Set point − 5 %">−</button>' +
            '<span class="val" title="High-level set point">' + sp + '%</span>' +
            '<button type="button" data-wts-ui class="wtsl-b" data-act="autosp" data-v="' + eq + ':0.05" aria-label="Set point plus 5 %" title="Set point + 5 %">+</button></div>';
    }
    function updateCard(st, slow) {
        if (!cardId || !cardRefs) return;
        var spec = cardRefs.spec, flow = _lastFlowObj;
        for (var i = 0; i < spec.rows.length; i++) {
            var r = spec.rows[i], s;
            try { s = st ? r[1](st) : '—'; } catch (e) { s = '—'; }
            setText(cardRefs['v' + i], s);
            if (r[3] && cardRefs['d' + i]) { var d = null; try { d = r[3](st, flow); } catch (e2) {} setText(cardRefs['d' + i], d || ''); }
        }
        var stt = st ? statusOf(cardId, st.alarms) : 'ok';
        if (cardId === 'esd' && st && st.esd && st.esd.manual && stt === 'evt') stt = 'warn';
        var out = rigOut(st, cardId);
        setAttr(cardRefs.chip, 'data-s', out ? 'evt' : stt);
        setText(cardRefs.chip, out ? 'Out of rig-up' : stt === 'ok' ? 'Normal' : stt === 'evt' ? 'Info' : stt === 'hyd' ? 'Hydrate' : stt);
        if (cardRefs.rigout) {
            show(cardRefs.rigout, out);
            if (out) setText(cardRefs.rigout, (cardId === 'heater' ? 'Bypassed' : cardId === 'separator' ? 'Bypassed — the well stream goes to the flare / burner' :
                'Not in the rig-up') + ' — change it in the Rig-up card below the view.');
        }
        renderCardActions(st);
        if (slow) {
            (spec.spark || []).forEach(function (sp, i) { drawCardSpark(cardRefs['sk' + i], cardRefs['skt' + i], sp, st); });
            renderWidget(st);
        }
    }
    function histOf(key, n) {
        if (!_sim || typeof _sim.getHistory !== 'function') return null;
        try { var h = _sim.getHistory(key, n); return h && h.t && h.t.length ? h : null; } catch (e) { return null; }
    }
    function drawCardSpark(cv, lbl, sp, st) {
        if (!cv) return;
        var series = [], cols = ['#e6edf3', '#6e7681'];
        sp.keys.forEach(function (k, i) { var h = histOf(k, 240); if (h) series.push({ t: h.t, y: h.y, c: cols[i] || '#8b949e', dash: i > 0 && !sp.indep }); });
        var lims = [];
        if (st && sp.lim === 'sepP' && st.sep) lims = [[st.sep.psh, '#d29922'], [st.sep.pshh, '#f85149'], [st.sep.psl, '#d29922']];
        if (st && sp.lim === 'sepL' && st.sep && st.sep.oilDump) lims = [[st.sep.oilDump.lsl, '#d29922'], [st.sep.oilDump.lsh, '#d29922']];
        if (st && sp.lim === 'surgeL' && st.surge) lims = [[st.surge.lsl, '#d29922'], [st.surge.lsh, '#d29922'], [st.surge.lshh, '#f85149']];
        if (st && sp.lim === 'gauge' && st.gauge && st.gauge.tanks && st.gauge.tanks[0]) lims = [[st.gauge.tanks[0].switchFrac, '#d29922'], [st.gauge.tanks[0].lahh, '#f85149']];
        spark(cv, series, lims, sp.cat === 'frac' ? [0, 1] : null, !!sp.indep);
        if (lbl && series.length) { var t = series[0].t; setText(lbl, '−' + fmtClockLocal(t[t.length - 1] - t[0]).replace(/^00:/, '')); }
    }
    // Generic sparkline: series [{t[], y[], c, dash}], limit lines [[y, colour]], fixed range or auto; indep = own y-scale per series.
    function spark(cv, series, lims, range, indep) {
        var dpr = clamp(num(G.devicePixelRatio, 1), 1, 3);
        var cw = cv.clientWidth || cv.width, ch = cv.clientHeight || cv.height;
        var W = Math.round(cw * dpr), H = Math.round(ch * dpr);
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        var ctx = cv.getContext('2d'); if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        if (!series.length) {
            ctx.fillStyle = '#6e7681'; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('collecting history…', cw / 2, ch / 2 + 3); return;
        }
        var t0 = Infinity, t1 = -Infinity;
        series.forEach(function (s) { if (s.t.length) { t0 = Math.min(t0, s.t[0]); t1 = Math.max(t1, s.t[s.t.length - 1]); } });
        if (!(t1 > t0)) t1 = t0 + 1;
        function yr(ys) {
            var lo = Infinity, hi = -Infinity;
            for (var i = 0; i < ys.length; i++) if (isNum(ys[i])) { lo = Math.min(lo, ys[i]); hi = Math.max(hi, ys[i]); }
            if (!isFinite(lo)) { lo = 0; hi = 1; }
            if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
            var pad = (hi - lo) * 0.12; return [lo - pad, hi + pad];
        }
        var shared = range;
        if (!shared && !indep) {
            var all = [];
            series.forEach(function (s) { all = all.concat(s.y); });
            (lims || []).forEach(function (l) { if (isNum(l[0])) all.push(l[0]); });
            shared = yr(all);
        }
        var X = function (t) { return 2 + (t - t0) / (t1 - t0) * (cw - 4); };
        var mkY = function (r) { return function (v) { return ch - 3 - (v - r[0]) / (r[1] - r[0]) * (ch - 6); }; };
        if (shared) {
            var Ys = mkY(shared);
            (lims || []).forEach(function (l) {
                if (!isNum(l[0])) return;
                var y = Ys(l[0]); if (y < 0 || y > ch) return;
                ctx.strokeStyle = l[1]; ctx.globalAlpha = 0.7; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
            });
            ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
        series.forEach(function (s) {
            var Y = mkY(shared || yr(s.y));
            ctx.strokeStyle = s.c; ctx.lineWidth = 1.4; ctx.setLineDash(s.dash ? [4, 3] : []);
            ctx.beginPath();
            var started = false;
            for (var i = 0; i < s.t.length; i++) {
                if (!isNum(s.y[i])) continue;
                var x = X(s.t[i]), y = Y(s.y[i]);
                if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
        });
        ctx.setLineDash([]);
    }
    function renderWidget(st) {
        var el = cardRefs && cardRefs.wg, w = cardRefs && cardRefs.spec.widget;
        if (!el || !st) return;
        var h = '';
        if (w === 'travel') {
            var tr = num(st.esd && st.esd.travel, 1);
            h = '<div class="wtsl-sh">Valve travel</div><div class="wtsl-bar" data-l="' + (tr < 0.99 ? 'warn' : 'ok') + '"><i style="width:' + (tr * 100).toFixed(1) + '%"></i></div>' +
                '<div class="wtsl-barl"><span>closed</span><span>' + pctStr(tr) + '</span><span>open</span></div>';
        } else if (w === 'capacity') {
            var ck = (st.nodes && st.nodes.choke) || {}, Q = num(st.inputs && st.inputs.Qg, 0) * num(st.f, 1), Qm = num(ck.QmaxMMscfd, 0);
            var fr = Qm > 0 ? Q / Qm : 0;
            h = '<div class="wtsl-sh">Choke capacity</div><div class="wtsl-bar" data-l="' + (ck.flowLimited ? 'alarm' : fr > 0.9 ? 'warn' : 'ok') + '"><i style="width:' + (clamp(fr, 0, 1) * 100).toFixed(1) + '%"></i></div>' +
                '<div class="wtsl-barl"><span>' + fmtU(Q, 'gasRate') + '</span><span>' + Math.round(fr * 100) + '% of ' + fmtU(Qm, 'gasRate') + '</span></div>';
        } else if (w === 'linevel') {
            var g = st.segs && st.segs[4], vp = num(g && g.vPct, 0);
            h = '<div class="wtsl-sh">Flare line velocity (API RP 14E)</div><div class="wtsl-bar" data-l="' + (vp >= 100 ? 'alarm' : vp >= 80 ? 'warn' : 'ok') + '"><i style="width:' + clamp(vp, 0, 100).toFixed(1) + '%"></i></div>' +
                '<div class="wtsl-barl"><span>0</span><span>' + Math.round(vp) + '% of limit</span><span>100%</span></div>';
        } else if (w === 'sepgauge' || w === 'strap' || w === 'gstrap') {
            if (!cardRefs.wgc) {
                el.innerHTML = '<div class="wtsl-sh">' + (w === 'sepgauge' ? 'Levels (fraction of ID)' : w === 'strap' ? 'Strapping' : 'Strapping · compartments') + '</div>' +
                    '<canvas class="wtsl-cvs" width="296" height="' + (w === 'gstrap' ? 150 : 160) + '" style="width:100%;height:' + (w === 'gstrap' ? 150 : 160) + 'px"></canvas>' +
                    (w === 'gstrap' ? '<div data-cref2="bt"></div>' : '');
                cardRefs.wgc = el.querySelector('canvas'); cardRefs.bt = el.querySelector('[data-cref2=bt]');
            }
            drawGauge(cardRefs.wgc, w, st);
            if (cardRefs.bt) {
                var B = (st.gauge && st.gauge.batches) || [], rows = B.slice(Math.max(0, B.length - 5)).reverse();
                var sig = rows.map(function (b) { return b.n; }).join(',') + unitsSys();
                if (cardRefs.bt.__sig !== sig) {
                    cardRefs.bt.__sig = sig;
                    cardRefs.bt.innerHTML = rows.length ? '<table class="wtsl-bt"><tr><th>#</th><th>Tank</th><th>Oil</th><th>Rate</th><th>BS&amp;W</th></tr>' + rows.map(function (b) {
                        return '<tr><td>' + b.n + '</td><td>' + esc(b.tag) + '</td><td>' + esc(fmtU(b.oil_stb, 'oilVolume', 1)) + '</td><td>' + esc(fmtU(b.oilRate_stbd, 'oilRate')) +
                            '</td><td>' + (isNum(b.bsw_pct) ? b.bsw_pct.toFixed(1) + '%' : '—') + '</td></tr>';
                    }).join('') + '</table>' : '<div class="wtsl-empty" style="padding:6px">No batches yet — a batch is recorded after each compartment settles.</div>';
                }
            }
            return;
        }
        if (el.__h !== h) { el.__h = h; el.innerHTML = h; }
    }
    // Vertical gauges (separator), strap ruler (surge), compartment straps (gauge).
    function drawGauge(cv, kind, st) {
        var dpr = clamp(num(G.devicePixelRatio, 1), 1, 3), cw = cv.clientWidth || 296, ch = cv.clientHeight || 160;
        if (cv.width !== Math.round(cw * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
        var c = cv.getContext('2d'); if (!c) return;
        c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cw, ch);
        var oil = oilCss(st.fluid && st.fluid.API || st.inputs && st.inputs.API), water = palCol('water');
        c.font = '10px system-ui,sans-serif';
        function bar(x, y, w, h, fW, fL, ticks, label, sub, accent) {
            c.fillStyle = '#161b22'; c.fillRect(x, y, w, h);
            if (isNum(fL) && fL > 0) { c.fillStyle = oil; c.globalAlpha = 0.85; c.fillRect(x, y + h * (1 - clamp(fL, 0, 1)), w, h * clamp(fL - num(fW, 0), 0, 1)); }
            if (isNum(fW) && fW > 0) { c.fillStyle = water; c.globalAlpha = 0.9; c.fillRect(x, y + h * (1 - clamp(fW, 0, 1)), w, h * clamp(fW, 0, 1)); }
            c.globalAlpha = 1;
            c.strokeStyle = accent ? '#f0883e' : '#484f58'; c.lineWidth = accent ? 1.5 : 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            (ticks || []).forEach(function (t) {
                if (!isNum(t[0])) return;
                var yy = y + h * (1 - t[0]);
                c.strokeStyle = t[1]; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x - 5, yy); c.lineTo(x, yy); c.moveTo(x + w, yy); c.lineTo(x + w + 5, yy); c.stroke();
                if (t[2]) { c.fillStyle = t[1]; c.textAlign = 'left'; c.fillText(t[2], x + w + 7, yy + 3); }
            });
            c.fillStyle = '#e6edf3'; c.textAlign = 'center'; c.font = '600 11px ui-monospace,Menlo,monospace';
            c.fillText(label, x + w / 2, y + h + 13); c.font = '10px system-ui,sans-serif';
            if (sub) { c.fillStyle = '#6e7681'; c.fillText(sub, x + w / 2, y + h + 25); }
        }
        var A = '#d29922', R = '#f85149';
        if (kind === 'sepgauge') {
            var s = st.sep || {}, c1 = s.c1 || {}, bk = s.bucket || {}, od = s.oilDump || {}, wd = s.waterDump || {};
            bar(30, 6, 40, 118, c1.fracW, c1.fracL, [[wd.lsll, R, 'LL'], [wd.lsl, A, 'L'], [wd.lsh, A, 'H'], [wd.lshh, R, 'HH'], [s.lahhTotal, R, 'LAHH']], pctStr(c1.fracL), 'inlet · IF ' + pctStr(c1.fracW));
            bar(170, 6, 40, 118, bk.fracW, bk.frac, [[od.lsll, R, 'LL'], [od.lsl, A, 'L'], [od.lsh, A, 'H'], [od.lshh, R, 'HH']], pctStr(bk.frac), 'oil bucket');
        } else if (kind === 'strap') {
            var u = st.surge || {}, H = num(u.H, 19.86), UC = u.comps || [];
            if (UC.length === 2) {                  // twin compartments A | B: level, strap height, inlet / suction state
                [0, 1].forEach(function (i) {
                    var cp = UC[i] || {};
                    bar(i ? 118 : 30, 6, 40, 118, cp.fracW, cp.frac, [[u.lsll, R, i ? '' : 'LL'], [u.lsl, A, i ? '' : 'L'], [u.lsh, A, i ? '' : 'H'], [u.lshh, R, i ? '' : 'HH'],
                        [u.auto && u.auto.on ? u.auto.sp : null, '#58a6ff', i ? '' : 'SP']],
                        (i ? 'B ' : 'A ') + pctStr(cp.frac), (cp.inlet ? 'IN' : 'in shut') + (cp.suction ? ' · SUC' : ''), !!cp.inlet);
                });
            } else bar(40, 6, 46, 118, u.fracW, u.frac, [[u.lsll, R, 'LL'], [u.lsl, A, 'L'], [u.lsh, A, 'H'], [u.lshh, R, 'HH']], pctStr(u.frac), strapText(num(u.frac, 0) * H));
            c.fillStyle = '#6e7681'; c.textAlign = 'left';
            for (var k = 0; k <= 4; k++) { var yy = 6 + 118 * (1 - k / 4); c.fillText(strapText(H * k / 4), 200, yy + 3); c.fillRect(190, yy, 6, 1); }
        } else {
            var g = st.gauge || {}, T = g.tanks || [];
            [0, 1].forEach(function (i) {
                var t = T[i] || {}, Ht = num(t.H, 11.17), x = i ? 176 : 36;
                bar(x, 6, 46, 104, t.fracW, t.frac, [[t.switchFrac, A, i ? '' : 'SW'], [t.lahh, R, i ? '' : 'HH'], [g.auto && g.auto.on ? g.auto.sp : null, '#58a6ff', i ? '' : 'SP']],
                    (i ? 'B ' : 'A ') + strapText(num(t.frac, 0) * Ht), String(t.state || '').toUpperCase() + (t.inlet ? ' · IN' : ''), t.inlet != null ? !!t.inlet : i === num(g.active, 0));
            });
        }
    }
    function strapText(ft) { return unitsSys() === 'metric' ? fmtU(ft, 'length', 2) : ftIn(ft); }

    // ── legend and trends (§6.7) ─────────────────────────────────────
    function renderLegend(st) {
        var api = st && st.fluid && isNum(st.fluid.API) ? st.fluid.API : (st && st.inputs && st.inputs.API) || 35;
        var lg = null;
        if (mode === '3d' && h3 && typeof h3.legend === 'function') { try { lg = h3.legend(); } catch (e) {} }
        var sig = api + '|' + mode + '|' + JSON.stringify(lg) + unitsSys();
        if (E.legend.__sig === sig) return;
        E.legend.__sig = sig;
        var sw = function (c, t) { return '<span class="li"><i class="sw" style="background:' + c + '"></i>' + t + '</span>'; };
        var h = '<div class="lh">Fluids</div>' + sw(palCol('gas'), 'Gas') + sw(oilCss(api), 'Oil (' + Math.round(api) + '° API)') + sw(palCol('water'), 'Water') + sw(palCol('emulsion'), 'Emulsion') +
            '<div class="lh">Status</div>' + sw('#3fb950', 'Normal') + sw('#d29922', 'Warning') + sw('#f85149', 'Alarm') + sw('#58a6ff', 'Hydrate') + sw('#bc8cff', 'Info / event') + sw('#f0883e', 'Selected');
        if (mode === '3d' && lg && lg.mode && lg.mode !== 'phase' && lg.stops && lg.stops.length) {
            var grad = lg.stops.map(function (s) { return s.color + ' ' + (clamp(num(s.t, 0), 0, 1) * 100).toFixed(0) + '%'; }).join(',');
            var cat = lg.unit || 'pressureG';
            h += '<div class="lh">' + esc(OVERLAYS.filter(function (o) { return o[0] === lg.mode; }).map(function (o) { return o[1]; })[0] || lg.mode) + '</div>' +
                '<div class="cb" style="background:linear-gradient(90deg,' + grad + ')"></div><div class="cbl"><span>' + esc(fmtU(lg.min, cat)) + '</span><span>' + esc(fmtU(lg.max, cat)) + '</span></div>';
        }
        if (mode === '3d') h += '<div class="note">Representative equipment · piping enlarged and distances compressed for clarity</div>';
        E.legend.innerHTML = h;
    }
    function drawTrends(st) {
        if (!E.trends || E.trends.hidden) return;
        var cells = E.trends.querySelectorAll('.wtsl-tr');
        for (var i = 0; i < cells.length; i++) {
            var k = cells[i].getAttribute('data-k'), cv = cells[i].querySelector('canvas'), b = cells[i].querySelector('b');
            var ser = [], lims = [], range = null, val = '';
            if (k === 'sep') {
                var a = histOf('Psep', 180), c = histOf('PsepSP', 180);
                if (a) ser.push({ t: a.t, y: a.y, c: '#f0883e' }); if (c) ser.push({ t: c.t, y: c.y, c: '#8b949e', dash: true });
                if (st && st.sep) { lims = [[st.sep.psh, '#d29922'], [st.sep.pshh, '#f85149']]; val = fmtU(st.sep.P, 'pressureG'); }
            } else if (k === 'lvl') {
                var bk = histOf('bucketFrac', 180), ifc = histOf('ifaceFrac', 180);
                if (bk) ser.push({ t: bk.t, y: bk.y, c: oilCss(st && st.inputs && st.inputs.API) }); if (ifc) ser.push({ t: ifc.t, y: ifc.y, c: palCol('water') });
                range = [0, 0.6];
                if (st && st.sep && st.sep.bucket) val = pctStr(st.sep.bucket.frac) + ' · ' + pctStr(st.sep.c1 && st.sep.c1.fracW);
            } else if (k === 'surge') {
                var su = histOf('surgeFracA', 180) || histOf('surgeFrac', 180), sb2 = histOf('surgeFracB', 180);
                if (su) ser.push({ t: su.t, y: su.y, c: '#e6edf3' }); if (sb2) ser.push({ t: sb2.t, y: sb2.y, c: '#8b949e', dash: true });
                range = [0, 1];
                if (st && st.surge) { lims = [[st.surge.lsl, '#d29922'], [st.surge.lsh, '#d29922']];
                    val = st.surge.comps && st.surge.comps.length === 2 ? pctStr(st.surge.comps[0].frac) + ' · ' + pctStr(st.surge.comps[1].frac) : pctStr(st.surge.frac); }
            } else {
                var ga = histOf('gaugeFracA', 180), gb = histOf('gaugeFracB', 180);
                if (ga) ser.push({ t: ga.t, y: ga.y, c: '#e6edf3' }); if (gb) ser.push({ t: gb.t, y: gb.y, c: '#8b949e', dash: true });
                range = [0, 1];
                var T = st && st.gauge && st.gauge.tanks;
                if (T && T[0] && T[1]) val = pctStr(T[0].frac) + ' · ' + pctStr(T[1].frac);
            }
            spark(cv, ser, lims, range, false);
            setText(b, val);
        }
    }

    // ── 2D live overlay (§6.10) ──────────────────────────────────────
    function draw2dLive(st, dt) {
        var draw = G.wtsDrawDiag, cv = E.cv;
        if (typeof draw !== 'function' || !cv) return;
        if (!st) { drawStatic2d(); return; }
        var target = st.running ? 1 : 0;
        flowGain = reduced ? target : clamp(flowGain + (target > flowGain ? 1 : -1) * dt / 0.4, 0, 1);
        try { draw(liveNodes(st), liveSegs(st)); } catch (e) { return; }
        var L = G.WTS_DIAG_LAYOUT;
        if (!L) return;
        var ctx = cv.getContext('2d'); if (!ctx) return;
        ctx.save();
        ctx.setTransform(cv.width / L.W, 0, 0, cv.height / L.H, 0, 0);
        var tx = L.tx, cy = L.cy, bx = L.bx, by = L.by, cl = L.cl;
        var api = st.fluid && isNum(st.fluid.API) ? st.fluid.API : num(st.inputs && st.inputs.API, 35);
        var OIL = oilCss(api), WATER = 'rgba(31,127,224,.85)';
        var sep = st.sep || {}, su = st.surge || {}, ga = st.gauge || {}, T = ga.tanks || [];
        // Separator capsule: C1 water/oil (left 75 %), bucket (right 25 %), weir
        (function () {
            var x = tx[4], y = cy, w = 52, h = 26, r = 13, x0 = x - w / 2, y0 = y - h / 2;
            ctx.save();
            ctx.beginPath(); ctx.moveTo(x0 + r, y0); ctx.lineTo(x0 + w - r, y0); ctx.arc(x0 + w - r, y, r, -Math.PI / 2, Math.PI / 2);
            ctx.lineTo(x0 + r, y0 + h); ctx.arc(x0 + r, y, r, Math.PI / 2, -Math.PI / 2); ctx.closePath();
            ctx.save(); ctx.clip();
            ctx.fillStyle = '#30363d'; ctx.fillRect(x0, y0, w, h);
            var c1 = sep.c1 || {}, bk = sep.bucket || {}, wW = w * num(sep.xWeirFrac, 0.75);
            var fL = clamp(num(c1.fracL, 0), 0, 1), fW = clamp(num(c1.fracW, 0), 0, fL);
            ctx.globalAlpha = 0.92; ctx.fillStyle = OIL; ctx.fillRect(x0, y0 + h * (1 - fL), wW, h * (fL - fW));
            ctx.fillStyle = WATER; ctx.fillRect(x0, y0 + h * (1 - fW), wW, h * fW);
            var bL = clamp(num(bk.frac, 0), 0, 1), bW = clamp(num(bk.fracW, 0), 0, bL);
            ctx.fillStyle = OIL; ctx.fillRect(x0 + wW, y0 + h * (1 - bL), w - wW, h * (bL - bW));
            ctx.fillStyle = WATER; ctx.fillRect(x0 + wW, y0 + h * (1 - bW), w - wW, h * bW);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = '#c9d1d9'; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(x0 + wW, y0 + h); ctx.lineTo(x0 + wW, y0 + h * (1 - num(sep.hWeirFrac, 0.55))); ctx.stroke();
            ctx.restore();
            ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 2; ctx.stroke();
            ctx.restore();
        })();
        // Surge and gauge tank contents
        function tankFill(x, y, w, h, fW, fL) {
            var x0 = x - w / 2, y0 = y - h / 2;
            ctx.fillStyle = '#30363d'; ctx.fillRect(x0 + 1, y0 + 1, w - 2, h - 2);
            fL = clamp(num(fL, 0), 0, 1); fW = clamp(num(fW, 0), 0, fL);
            ctx.globalAlpha = 0.92;
            ctx.fillStyle = OIL; ctx.fillRect(x0 + 1, y0 + 1 + (h - 2) * (1 - fL), w - 2, (h - 2) * (fL - fW));
            ctx.fillStyle = WATER; ctx.fillRect(x0 + 1, y0 + 1 + (h - 2) * (1 - fW), w - 2, (h - 2) * fW);
            ctx.globalAlpha = 1;
        }
        // Twin compartments A | B (surge and gauge) with their inlet divert valves (click a valve to open / close it)
        var SC = su.comps || [];
        if (SC.length === 2) { tankFill(bx[0] - 8, by, 16, 38, SC[0].fracW, SC[0].frac); tankFill(bx[0] + 8, by, 16, 38, SC[1].fracW, SC[1].frac); }
        else tankFill(bx[0], by, 32, 38, su.fracW, su.frac);
        if (T.length === 2 && T[0].inlet != null) { tankFill(bx[1] - 9, by, 18, 36, T[0].fracW, T[0].frac); tankFill(bx[1] + 9, by, 18, 36, T[1].fracW, T[1].frac); }
        else { var at = T[num(ga.active, 0)] || {}; tankFill(bx[1], by, 36, 36, at.fracW, at.frac); }
        ctx.strokeStyle = '#c9d1d9'; ctx.lineWidth = 1.2;
        if (SC.length === 2) { ctx.beginPath(); ctx.moveTo(bx[0], by - 16); ctx.lineTo(bx[0], by + 18); ctx.stroke(); }
        if (T.length === 2 && T[0].inlet != null) { ctx.beginPath(); ctx.moveTo(bx[1], by - 16); ctx.lineTo(bx[1], by + 17); ctx.stroke(); }
        ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
        if (SC.length === 2) { ctx.fillText('A', bx[0] - 8, by + 3); ctx.fillText('B', bx[0] + 8, by + 3); }
        if (T.length === 2 && T[0].inlet != null) { ctx.fillText('A', bx[1] - 9, by + 3); ctx.fillText('B', bx[1] + 9, by + 3); }
        if (T.length === 2 && T[0].inlet != null) {        // fill header riser off the P-201 discharge line
            ctx.strokeStyle = '#8b949e'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(bx[1] - 26, by); ctx.lineTo(bx[1] - 26, by - 40); ctx.stroke();
        }
        valves2d(L).forEach(function (vz) {
            var vc = vz.kind === 'valve' ? (vz.eq === 'surge' ? SC[vz.i] : T[vz.i]) : null;
            var open = vz.kind === 'valve' ? !!(vc && vc.inlet) : !!(SC[vz.i] && SC[vz.i].suction), trav = !!(vc && (vc.moving || vc.hold));
            var cx = vz.x + vz.w / 2, cyv = vz.y + vz.h / 2;
            ctx.strokeStyle = '#8b949e'; ctx.lineWidth = 1.2; ctx.beginPath();
            if (vz.kind === 'valve') { ctx.moveTo(vz.hx, vz.hy); ctx.lineTo(cx, vz.hy); ctx.lineTo(cx, cyv - 5); ctx.moveTo(cx, cyv + 5); ctx.lineTo(cx, vz.ty); }
            else { ctx.moveTo(cx, vz.ty); ctx.lineTo(cx, cyv - 4); }
            ctx.stroke();
            ctx.fillStyle = trav ? '#d29922' : open ? '#3fb950' : 'rgba(13,17,23,.9)'; ctx.strokeStyle = trav ? '#d29922' : open ? '#3fb950' : '#f85149'; ctx.lineWidth = 1.4;
            ctx.beginPath();
            if (vz.kind === 'valve') { ctx.moveTo(cx - 4, cyv - 5); ctx.lineTo(cx + 4, cyv - 5); ctx.lineTo(cx - 4, cyv + 5); ctx.lineTo(cx + 4, cyv + 5); ctx.closePath(); }
            else { ctx.moveTo(cx - 4, cyv - 3); ctx.lineTo(cx + 4, cyv - 3); ctx.lineTo(cx, cyv + 4); ctx.closePath(); }
            ctx.fill(); ctx.stroke();
        });
        if (su.auto && su.auto.on) { ctx.fillStyle = '#58a6ff'; ctx.font = 'bold 7px sans-serif'; ctx.fillText('AUTO', bx[0] + 26, by - 26); }
        var xp = xferOf(st);
        if (xp && xp.tripped && !rigOut(st, 'surge')) {   // latched LCV-201 transfer trip flag on the transfer line
            ctx.fillStyle = '#f85149'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('LCV-201 TRIP' + tripTag(xp.trip), (bx[0] + bx[1]) / 2, by + 14);
        }
        if (ga.auto && ga.auto.on) { ctx.fillStyle = '#58a6ff'; ctx.font = 'bold 7px sans-serif'; ctx.fillText('AUTO', bx[1] + 28, by - 26); }
        // ESD ball: green open, amber moving/manual, red tripped
        (function () {
            var e = st.esd || {}, x = tx[1], y = cy, trv = clamp(num(e.travel, 1), 0, 1);
            var col = e.tripped && !e.manual ? '#f85149' : (e.moving || e.manual || trv < 0.99) ? '#d29922' : '#3fb950';
            ctx.fillStyle = col; ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.save(); ctx.translate(x, y); ctx.rotate((1 - trv) * Math.PI / 2);
            ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(10, 0); ctx.stroke(); ctx.restore();
            ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = col;
            var cap = e.moving ? Math.round(trv * 100) + '% ' + (e.tripped ? 'CLOSING' : 'OPENING') : (trv > 0.5 ? 'OPEN' : 'CLOSED');
            ctx.fillText(cap, x, cy + 84);
        })();
        // Flow dashes (D18/D29): none when not flowing; ease to a stop on Pause
        var lines = st.lines || {}, segs = st.segs || [];
        function dashLine(i, x1, y1, x2, y2, vel, color) {
            if (!(vel > 0.01)) return;
            dash[i] = (dash[i] - (4 + 18 * Math.log(1 + vel) / Math.LN10) * dt * flowGain) % 1600;
            ctx.save(); ctx.setLineDash([6, 10]); ctx.lineDashOffset = dash[i];
            ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
        }
        for (var i = 0; i < 5; i++) {
            var sg = segs[i] || {}, v = num(sg.vel, 0), flowing = sg.flowing != null ? !!sg.flowing : v > 0.01;
            if (flowing) dashLine(i, tx[i] + cl[i] + 3, cy, tx[i + 1] - cl[i + 1] - 3, cy, v, 'rgba(255,255,255,.38)');
        }
        var lo = lines.sep_oil || {}, lw = lines.sep_water || {};
        var liqVel = (lo.active ? num(lo.vel, 0) : 0) + (lw.active ? num(lw.vel, 0) : 0);
        if (liqVel > 0.01) dashLine(5, tx[4], cy + 14, tx[4], by - 22, liqVel, lo.active ? OIL : WATER);
        var sg5 = segs[5] || {}, v5 = num(sg5.vel, 0), f5 = sg5.flowing != null ? !!sg5.flowing : v5 > 0.01;
        if (f5) dashLine(6, bx[0] + 18, by, bx[1] - 20, by, v5, OIL);
        // Flare flame glyph scaled by the relative flame size (D19), pilot at 0
        (function () {
            var fl = (st.nodes && st.nodes.flare) || {}, x = tx[5], y = cy, s = num(fl.flame, 0);
            ctx.clearRect(x - 16, y - 50, 32, 31);
            if (s > 0.001) {
                s = clamp(s, 0.25, 1.6);
                var fk = reduced ? 1 : 1 + 0.06 * Math.sin(nowMs() / 90) * Math.max(flowGain, 0.5);
                ctx.save(); ctx.translate(x, y - 18); ctx.scale(s, s * fk);
                ctx.fillStyle = '#f85149'; ctx.beginPath(); ctx.moveTo(-9, 0); ctx.quadraticCurveTo(-13, -14, 0, -24); ctx.quadraticCurveTo(13, -14, 9, 0); ctx.closePath(); ctx.fill();
                ctx.fillStyle = '#f0883e'; ctx.beginPath(); ctx.moveTo(-5, 0); ctx.quadraticCurveTo(-7, -10, 0, -17); ctx.quadraticCurveTo(7, -10, 5, 0); ctx.closePath(); ctx.fill();
                ctx.restore();
            } else {
                ctx.fillStyle = '#58a6ff'; ctx.beginPath(); ctx.arc(x, y - 21, 2.2, 0, Math.PI * 2); ctx.fill();
            }
            ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - 6, y - 18); ctx.lineTo(x + 6, y - 18); ctx.stroke();
        })();
        // Heater firetube glyph scaled by firing
        (function () {
            var ht = (st.nodes && st.nodes.heater) || {}, x = tx[3], y = cy;
            if (ht.bypass) return;
            var f = clamp(num(ht.firing, 0), 0, 1);
            ctx.fillStyle = '#30363d'; ctx.fillRect(x - 22, y - 16, 44, 32);
            if (f > 0.01) {
                ctx.save(); ctx.translate(x, y + 10); ctx.scale(0.4 + 0.6 * f, 0.35 + 0.65 * f);
                ctx.fillStyle = '#f0883e'; ctx.beginPath(); ctx.moveTo(-5, 0); ctx.quadraticCurveTo(-8, -14, 0, -23); ctx.quadraticCurveTo(8, -14, 5, 0); ctx.closePath(); ctx.fill();
                ctx.fillStyle = '#d29922'; ctx.beginPath(); ctx.moveTo(-2, -2); ctx.quadraticCurveTo(-4, -10, 0, -15); ctx.quadraticCurveTo(4, -10, 2, -2); ctx.closePath(); ctx.fill();
                ctx.restore();
            }
        })();
        // Alarm outlines (info ignored except ESD_MANUAL, D38)
        var pulse = reduced ? 1 : 0.55 + 0.45 * Math.abs(Math.sin(nowMs() / 1000 * Math.PI));
        var zs = zones2d(L);
        for (var z = 0; z < zs.length; z++) {
            var Z = zs[z]; if (Z.strip) continue;
            var s2 = statusOf(Z.id, st.alarms);
            if (Z.id === 'esd' && st.esd && st.esd.manual) s2 = 'warn';
            if (s2 === 'alarm' || s2 === 'warn') {
                ctx.save(); ctx.globalAlpha = pulse; ctx.strokeStyle = s2 === 'alarm' ? '#f85149' : '#d29922'; ctx.lineWidth = 1.5;
                rrect(ctx, Z.x, Z.y, Z.w, Z.h, 8); ctx.stroke(); ctx.restore();
            } else if (s2 === 'hyd') {
                ctx.fillStyle = '#58a6ff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('❄', Z.x + Z.w - 6, Z.y + 12);
            }
        }
        drawRig2d(ctx, L, st, OIL);
        // Sim clock (top right)
        ctx.textAlign = 'right'; ctx.font = 'bold 10px sans-serif'; ctx.fillStyle = '#8b949e';
        ctx.fillText('SIM T+' + (st.clock || fmtClockLocal(st.t)) + ' · ×' + num(st.speed, 10) + (st.running ? '' : ' · PAUSED'), L.W - 14, 22);
        // Legend swatches (oil, water) on the host legend row
        ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
        var ly = L.H - 8;
        ctx.fillStyle = OIL; ctx.fillRect(660, ly - 10, 10, 8); ctx.fillStyle = '#8b949e'; ctx.fillText('Oil (' + Math.round(api) + '° API)', 674, ly - 2);
        ctx.fillStyle = WATER; ctx.fillRect(820, ly - 10, 10, 8); ctx.fillStyle = '#8b949e'; ctx.fillText('Water', 834, ly - 2);
        drawStrip(ctx, L.strip || { x: 20, y: 215, w: 600, h: 103 }, st, OIL, WATER);
        ctx.restore();
    }
    // Rig-up on the 2D schematic (logical units). Always: the surge → gauge transfer valve LCV-201 (no pump — the
    // surge tank pressure drives it) on the transfer line and P-201 downstream of the gauge tank (→ export / burner).
    // Equipment out of the rig-up is greyed with its bypass drawn as an amber dashed line.
    var RIG2D = { lcvX: 758, pumpX: 1082, outX: 1188 };
    function drawRig2d(ctx, L, st, OIL) {
        var tx = L.tx, cy = L.cy, bx = L.bx, by = L.by, ru = st.rigup || {};
        var off = function (k) { return ru[k] === false; };
        var AMB = '#d29922', GREY = '#6e7681';
        function mask(x, y, w, h, label, ly) {
            ctx.save();
            ctx.fillStyle = 'rgba(13,17,23,.9)'; ctx.fillRect(x, y, w, h);
            ctx.setLineDash([3, 3]); ctx.strokeStyle = GREY; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); ctx.setLineDash([]);
            if (label) { ctx.fillStyle = AMB; ctx.font = 'bold 7.5px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(label, x + w / 2, ly != null ? ly : y + h / 2 + 3); }
            ctx.restore();
        }
        function bypass(pts, label, lx, ly, arrow) {
            ctx.save(); ctx.setLineDash([6, 4]); ctx.strokeStyle = AMB; ctx.lineWidth = 2; ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke(); ctx.setLineDash([]);
            if (arrow) { var p = pts[pts.length - 1]; ctx.fillStyle = AMB; ctx.beginPath(); ctx.moveTo(p[0] + 4, p[1]); ctx.lineTo(p[0] - 5, p[1] - 5); ctx.lineTo(p[0] - 5, p[1] + 5); ctx.closePath(); ctx.fill(); }
            if (label) { ctx.fillStyle = AMB; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(label, lx, ly); }
            ctx.restore();
        }
        var xp = xferOf(st) || {}, gp = (st.gauge && st.gauge.pump) || {};
        // LCV-201 on the T-201 → T-301 line: control valve (bow-tie + actuator); green open, grey shut, red tripped / stuck
        if (!off('surge')) {
            var vx = RIG2D.lcvX, col = xp.failed || xp.tripped ? '#f85149' : xp.on ? (xp.lowDP ? AMB : '#3fb950') : GREY;
            ctx.save();
            ctx.fillStyle = 'rgba(13,17,23,.95)'; ctx.fillRect(vx - 9, by - 7, 18, 14);
            ctx.fillStyle = col; ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(vx - 8, by - 6); ctx.lineTo(vx, by); ctx.lineTo(vx - 8, by + 6); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(vx + 8, by - 6); ctx.lineTo(vx, by); ctx.lineTo(vx + 8, by + 6); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(vx, by); ctx.lineTo(vx, by - 11); ctx.stroke();
            ctx.beginPath(); ctx.arc(vx, by - 13, 4, Math.PI, 0); ctx.closePath(); ctx.stroke();
            ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#c9d1d9';
            ctx.fillText('LCV-201', vx, by - 20);
            ctx.font = '7.5px sans-serif'; ctx.fillStyle = GREY;
            ctx.fillText(isNum(xp.dP_psi) ? 'ΔP ' + fmtU(xp.dP_psi, 'pressure', 1) : 'no pump', vx, by + 16);
            ctx.restore();
        }
        // P-201 downstream of T-301 → export / burner
        if (!off('gauge')) {
            var px = RIG2D.pumpX, py = by + 12, gravity = gp.mode === 'gravity';
            ctx.save();
            ctx.strokeStyle = GREY; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx[1] + 19, py); ctx.lineTo(px - 9, py); ctx.moveTo(px + 9, py); ctx.lineTo(RIG2D.outX - 6, py); ctx.stroke();
            ctx.fillStyle = GREY; ctx.beginPath(); ctx.moveTo(RIG2D.outX, py); ctx.lineTo(RIG2D.outX - 7, py - 4); ctx.lineTo(RIG2D.outX - 7, py + 4); ctx.closePath(); ctx.fill();
            if (gravity) {
                ctx.setLineDash([2, 2]); ctx.strokeStyle = GREY; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
                ctx.fillStyle = AMB; ctx.font = 'bold 7.5px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('GRAVITY DRAIN', px, py - 12);
            } else {
                var pc = gp.failed ? '#f85149' : gp.on ? '#3fb950' : '#8b949e';
                ctx.fillStyle = '#30363d'; ctx.strokeStyle = pc; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = pc; ctx.beginPath(); ctx.moveTo(px - 4, py - 5); ctx.lineTo(px + 6, py); ctx.lineTo(px - 4, py + 5); ctx.closePath(); ctx.fill();
                ctx.fillStyle = '#c9d1d9'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('P-201', px, py - 12);
            }
            ctx.fillStyle = GREY; ctx.font = '7.5px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('EXPORT / BURNER', (px + RIG2D.outX) / 2 + 6, py + 12);
            ctx.restore();
        }
        // equipment out of the rig-up
        if (off('heater')) { mask(tx[3] - 26, cy - 20, 52, 40, ''); bypass([[tx[3] - 30, cy], [tx[3] + 30, cy]], 'NOT IN RIG-UP', tx[3], cy + 30); }
        if (off('separator')) {
            mask(tx[4] - 30, cy - 17, 60, 34, '');
            mask(tx[4] - 7, cy + 18, 14, by - 13 - (cy + 18), '');
            bypass([[tx[4] - 34, cy], [tx[4] + 34, cy]], 'BYPASSED → FLARE', tx[4], cy + 27);
        }
        if (off('flare')) {
            mask(tx[5] - 18, cy - 44, 36, 68, '');
            bypass([[tx[5] - 20, cy], [tx[5] + 70, cy]], 'GAS → EXPORT LINE', tx[5] + 64, cy - 8, true);
        }
        if (off('surge')) {
            mask(bx[0] - 30, by - 42, 60, 80, 'NOT IN RIG-UP');
            mask(bx[0] + 31, by - 24, bx[1] - bx[0] - 62, 44, '');            // the T-201 → T-301 line is not in use
            if (!off('separator')) {
                if (!off('gauge')) bypass([[tx[4] + 6, by - 30], [bx[1] - 26, by - 30], [bx[1] - 26, by - 40]], 'DUMPS → T-301 (no surge tank)', (tx[4] + bx[1]) / 2, by - 35);
                else bypass([[tx[4] + 6, by - 30], [RIG2D.outX, by - 30]], 'DUMPS → EXPORT / BURNER', (tx[4] + bx[1]) / 2, by - 35, true);
            }
        }
        if (off('gauge')) {
            mask(bx[1] - 32, by - 44, 64, 82, 'NOT IN RIG-UP', by - 30);
            if (!off('surge')) bypass([[bx[1] - 34, by], [RIG2D.outX, by]], 'T-201 → EXPORT / BURNER', RIG2D.pumpX - 10, by - 8, true);
        }
    }
    function rrect(c, x, y, w, h, r) {
        c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r);
        c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
    }
    // "Levels & Pressures" strip in the empty lower-left region (K9).
    function drawStrip(ctx, S, st, OIL, WATER) {
        ctx.fillStyle = 'rgba(13,17,23,.6)'; rrect(ctx, S.x, S.y, S.w, S.h, 6); ctx.fill();
        ctx.fillStyle = '#6e7681'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText('LEVELS & PRESSURES', S.x + 8, S.y + 12);
        var sep = st.sep || {}, c1 = sep.c1 || {}, bk = sep.bucket || {}, su = st.surge || {}, T = (st.gauge && st.gauge.tanks) || [], act = num(st.gauge && st.gauge.active, 0);
        var od = sep.oilDump || {}, wd = sep.waterDump || {};
        var A = '#d29922', R = '#f85149', top = S.y + 20, bh = 58, bw = 14;
        var gv = function (t) { return t ? fmtParts(num(t.Vo_bbl, 0) + num(t.Vw_bbl, 0), 'volume', 1).v : '—'; };
        var bars = [
            { x: S.x + 20, fW: c1.fracW, fL: c1.fracL, ticks: [[wd.lsll, R], [wd.lsl, A], [wd.lsh, A], [wd.lshh, R], [sep.lahhTotal, R]], val: pctStr(c1.fracL), tag: 'V-101' },
            { x: S.x + 75, fW: bk.fracW, fL: bk.frac, ticks: [[od.lsll, R], [od.lsl, A], [od.lsh, A], [od.lshh, R]], val: pctStr(bk.frac), tag: 'BUCKET' },
            { x: S.x + 130, fW: su.fracW, fL: su.frac, ticks: [[su.lsll, R], [su.lsl, A], [su.lsh, A], [su.lshh, R]], val: pctStr(su.frac), tag: 'T-201' },
            { x: S.x + 185, fW: T[0] && T[0].fracW, fL: T[0] && T[0].frac, ticks: T[0] ? [[T[0].switchFrac, A], [T[0].lahh, R]] : [], val: gv(T[0]), tag: 'T-301A', acc: act === 0 },
            { x: S.x + 240, fW: T[1] && T[1].fracW, fL: T[1] && T[1].frac, ticks: T[1] ? [[T[1].switchFrac, A], [T[1].lahh, R]] : [], val: gv(T[1]), tag: 'T-301B', acc: act === 1 }
        ];
        var ofs = [rigOut(st, 'separator'), rigOut(st, 'separator'), rigOut(st, 'surge'), rigOut(st, 'gauge'), rigOut(st, 'gauge')];
        bars.forEach(function (b, bi) {
            ctx.save(); if (ofs[bi]) { ctx.globalAlpha = 0.3; b.acc = false; }
            ctx.fillStyle = '#161b22'; ctx.fillRect(b.x, top, bw, bh);
            var fL = clamp(num(b.fL, 0), 0, 1), fW = clamp(num(b.fW, 0), 0, fL);
            ctx.fillStyle = OIL; ctx.fillRect(b.x, top + bh * (1 - fL), bw, bh * (fL - fW));
            ctx.fillStyle = WATER; ctx.fillRect(b.x, top + bh * (1 - fW), bw, bh * fW);
            if (fL > 0.005) { ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillRect(b.x, top + bh * (1 - fL), bw, 1); }
            ctx.strokeStyle = b.acc ? '#f0883e' : '#484f58'; ctx.lineWidth = b.acc ? 1.5 : 1; ctx.strokeRect(b.x + 0.5, top + 0.5, bw - 1, bh - 1);
            b.ticks.forEach(function (t) {
                if (!isNum(t[0])) return;
                var y = top + bh * (1 - clamp(t[0], 0, 1));
                ctx.strokeStyle = t[1]; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(b.x - 4, y); ctx.lineTo(b.x, y); ctx.moveTo(b.x + bw, y); ctx.lineTo(b.x + bw + 4, y); ctx.stroke();
            });
            ctx.textAlign = 'center'; ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 10px sans-serif';
            ctx.fillText(b.val, b.x + bw / 2, top + bh + 11);
            ctx.fillStyle = b.acc ? '#f0883e' : '#8b949e'; ctx.font = '8.5px sans-serif';
            ctx.fillText(b.tag, b.x + bw / 2, top + bh + 21);
            ctx.restore();
            if (ofs[bi]) { ctx.fillStyle = '#d29922'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('OUT', b.x + bw / 2, top + bh / 2 + 3); }
        });
        ctx.fillStyle = '#6e7681'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('(' + fmtParts(0, 'volume').u + ')', S.x + 219, S.y + 12);
        // Pressure readouts 2×2
        var N = st.nodes || {}, ck = N.choke || {};
        var cells = [
            { l: 'WHP', p: fmtParts(N.wellhead && N.wellhead.P, 'pressureG') },
            { l: 'CHOKE IN → OUT', p: (function () { var a = fmtParts(ck.Pin, 'pressureG'), b = fmtParts(ck.P, 'pressureG'); return { v: a.v + '→' + b.v, u: b.u }; })() },
            { l: 'SEPARATOR', p: fmtParts(sep.P, 'pressureG'), bar: true },
            { l: 'SURGE TANK', p: fmtParts(su.P, 'pressureTank') }
        ];
        cells.forEach(function (c, i) {
            var x = S.x + 310 + (i % 2) * 140, y = S.y + 14 + Math.floor(i / 2) * 44;
            ctx.textAlign = 'left'; ctx.fillStyle = '#8b949e'; ctx.font = '9px sans-serif'; ctx.fillText(c.l, x, y + 8);
            ctx.fillStyle = '#f0883e'; ctx.font = 'bold 15px sans-serif'; ctx.fillText(c.p.v, x, y + 25);
            var w = ctx.measureText(c.p.v).width;
            ctx.fillStyle = '#6e7681'; ctx.font = '9px sans-serif'; ctx.fillText(c.p.u, x + w + 4, y + 25);
            if (c.bar) {
                var sp = num(sep.SPeff, num(sep.SP, 150)), P = num(sep.P, sp), psh = num(sep.psh, sp + 15), pshh = num(sep.pshh, sp + 30), psl = num(sep.psl, sp - 30);
                var lo2 = Math.min(psl, P) - 2, hi2 = Math.max(pshh, P) + 2, X = function (v) { return x + 100 * clamp((v - lo2) / (hi2 - lo2), 0, 1); };
                var by2 = y + 31;
                ctx.fillStyle = '#21262d'; ctx.fillRect(x, by2, 100, 4);
                ctx.fillStyle = 'rgba(63,185,80,.6)'; ctx.fillRect(X(sp - 5), by2, X(sp + 5) - X(sp - 5), 4);
                ctx.fillStyle = A; ctx.fillRect(X(psh) - 1, by2 - 2, 2, 8);
                ctx.fillStyle = R; ctx.fillRect(X(pshh) - 1, by2 - 2, 2, 8);
                ctx.fillStyle = '#fff'; ctx.fillRect(X(P) - 1, by2 - 3, 3, 10);
            }
        });
    }
    // 2D operable valves (logical units): T-201 / T-301 inlet divert valves above each compartment, P-201 suctions below T-201.
    // hx/hy = header point the valve branch starts from, ty = compartment edge the branch ends at.
    function valves2d(L) {
        var bx = L.bx, by = L.by, v = [];
        [0, 1].forEach(function (i) {
            v.push({ id: 'valve:surge:' + i, kind: 'valve', eq: 'surge', i: i, x: bx[0] - 8 + 16 * i - 6, y: by - 33, w: 12, h: 14, hx: bx[0], hy: by - 40, ty: by - 19 });
            v.push({ id: 'valve:gauge:' + i, kind: 'valve', eq: 'gauge', i: i, x: bx[1] - 9 + 18 * i - 6, y: by - 33, w: 12, h: 14, hx: bx[1] - 26, hy: by - 40, ty: by - 18 });
            v.push({ id: 'suction:surge:' + i, kind: 'suction', eq: 'surge', i: i, x: bx[0] - 8 + 16 * i - 6, y: by + 19, w: 12, h: 9, ty: by + 19 });
        });
        return v;
    }
    // 2D hit zones (logical units): equipment, strip bars and readouts → pick ids.
    function zones2d(L) {
        var z = [], ids = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare'];
        for (var i = 0; i < 6; i++) z.push({ id: ids[i], x: L.tx[i] - 36, y: L.cy - 44, w: 72, h: 76 });
        z.push({ id: 'surge', x: L.bx[0] - 28, y: L.by - 30, w: 56, h: 58 });
        z.push({ id: 'gauge', x: L.bx[1] - 30, y: L.by - 30, w: 60, h: 58 });
        z.push({ id: 'pump', x: RIG2D.pumpX - 14, y: L.by - 4, w: 28, h: 30 });            // P-201 (downstream of T-301)
        z.push({ id: 'surge', x: RIG2D.lcvX - 12, y: L.by - 26, w: 24, h: 34 });            // LCV-201 → the surge card (its controls)
        var S = L.strip || { x: 20, y: 215, w: 600, h: 103 };
        var sb = ['separator', 'separator', 'surge', 'gauge', 'gauge'];
        for (var j = 0; j < 5; j++) z.push({ id: sb[j], x: S.x + 12 + 55 * j, y: S.y + 16, w: 32, h: 86, strip: true });
        var rd = ['wellhead', 'choke', 'separator', 'surge'];
        for (var k = 0; k < 4; k++) z.push({ id: rd[k], x: S.x + 306 + (k % 2) * 140, y: S.y + 12 + Math.floor(k / 2) * 44, w: 136, h: 42, strip: true });
        if (_sim && _sim.getState().surge.comps) valves2d(L).forEach(function (v) { z.push({ id: v.id, x: v.x - 2, y: v.y - 2, w: v.w + 4, h: v.h + 4, strip: true }); });
        return z;
    }
    // Touch targets on phones: the 2D valve glyphs are ~12 logical units (≈ 4 CSS px on a 375 px screen). On a small or
    // coarse-pointer view a tap within 22 CSS px of any valve glyph (a 44 px target, WCAG 2.5.5 / Apple HIG) opens a
    // zoomed inset of that tank with 44 × 44 px valve buttons instead of toggling a glyph directly.
    function coarse2d() { return bp === 'sm' || !!(G.matchMedia && G.matchMedia('(pointer:coarse)').matches); }
    function nearValve(ev) {
        var L = G.WTS_DIAG_LAYOUT, cv = E.cv; if (!L || !cv || !_sim) return null;
        var r = cv.getBoundingClientRect(); if (!r.width || !r.height) return null;
        var sx = r.width / L.W, sy = r.height / L.H, best = null, bd = 1e9;
        valves2d(L).forEach(function (v) {
            var dx = (ev.clientX - r.left) - (v.x + v.w / 2) * sx, dy = (ev.clientY - r.top) - (v.y + v.h / 2) * sy, d = Math.sqrt(dx * dx + dy * dy);
            if (d < bd) { bd = d; best = v.eq; }
        });
        return bd <= 22 ? best : null;
    }
    var vinEq = null;
    function openVin(eq) {
        closeMenu(); closePop(); closeCard();
        if (!E.vin) { E.vin = mk('div', 'wtsl-vin rp-skip'); E.vin.id = 'wtsl_vin'; E.vin.setAttribute('data-wts-ui', ''); E.vin.setAttribute('role', 'dialog'); vizEl.appendChild(E.vin); }
        vinEq = eq; E.vin.__sig = ''; E.vin.setAttribute('aria-label', eq === 'surge' ? 'T-201 valves' : 'T-301 valves');
        renderVin(state());
    }
    function closeVin() { if (E.vin && E.vin.parentNode) E.vin.parentNode.removeChild(E.vin); E.vin = null; vinEq = null; }
    function renderVin(st) {
        if (!E.vin || !vinEq || !st) return;
        var eq = vinEq, su = st.surge || {}, g = st.gauge || {}, C = (eq === 'surge' ? su.comps : g.tanks) || [];
        if (C.length < 2) return;
        var sig = eq + lineupSig(C[0], C[1], eq === 'surge' ? su.auto : g.auto) + (eq === 'surge' ? su.suction : '') + pumpSig(st) + Math.round(num(C[0].frac, 0) * 100) + '/' + Math.round(num(C[1].frac, 0) * 100);
        if (E.vin.__sig === sig) return;
        E.vin.__sig = sig;
        E.vin.innerHTML = '<h4><span>' + (eq === 'surge' ? 'T-201 surge tank · inlet &amp; suction' : 'T-301 gauge tank · inlet valves') + '</span>' +
            '<button type="button" data-wts-ui class="wtsl-b ic" data-act="vin-close" aria-label="Close" title="Close">' + ICON.x + '</button></h4>' +
            '<div class="wtsl-actr"><span class="wtsl-hl">Level</span><span class="val">A ' + pctStr(C[0].frac) + ' · B ' + pctStr(C[1].frac) + '</span></div>' +
            '<div class="wtsl-actr"><span class="wtsl-hl">Inlet</span>' + valveBtns(eq, C[0], C[1]) + '</div>' +
            (eq === 'surge' ? suctionRow(su.suction) : '') + pumpResetRow(st) +
            '<div class="wtsl-actr"><button type="button" data-wts-ui class="wtsl-b" data-act="focus" data-v="' + eq + '">Details ›</button></div>';
    }
    function hit2d(ev) {
        var L = G.WTS_DIAG_LAYOUT, cv = E.cv;
        if (!L || !cv) return null;
        var r = cv.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        var x = (ev.clientX - r.left) / r.width * L.W, y = (ev.clientY - r.top) / r.height * L.H;
        var zs = zones2d(L);
        for (var i = zs.length - 1; i >= 0; i--) { var Z = zs[i]; if (x >= Z.x && x <= Z.x + Z.w && y >= Z.y && y <= Z.y + Z.h) return Z.id; }
        return null;
    }

    // ── menus, confirms, popovers ────────────────────────────────────
    function closeMenu() {
        if (!menu) return;
        if (menu.el && menu.el.parentNode) menu.el.parentNode.removeChild(menu.el);
        if (menu.anchor) menu.anchor.setAttribute('aria-expanded', 'false');
        menu = null;
    }
    function placeAt(el, anchor) {
        var vr = vizEl.getBoundingClientRect(), ar = anchor ? anchor.getBoundingClientRect() : { left: vr.left + 10, bottom: vr.top + 50, right: vr.left + 10 };
        el.style.visibility = 'hidden'; el.style.left = '0px'; el.style.top = '0px';
        vizEl.appendChild(el);
        var w = el.offsetWidth, h = el.offsetHeight;
        var left = clamp(ar.left - vr.left, 8, Math.max(8, vr.width - w - 8));
        var top = ar.bottom - vr.top + 6;
        if (top + h > vr.height - 8) top = Math.max(8, (ar.top != null ? ar.top - vr.top : top) - h - 6);
        el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.visibility = '';
    }
    function openMenu(anchor, items, key) {
        if (menu && menu.key === key) { closeMenu(); return; }
        closeMenu(); closePop();
        var el = mk('div', 'wtsl-menu rp-skip');
        el.setAttribute('role', 'menu'); el.setAttribute('data-wts-ui', '');
        el.innerHTML = items.map(function (it) {
            if (it.h) return '<div class="wtsl-mh">' + esc(it.h) + '</div>';
            return '<button type="button" data-wts-ui role="' + (it.check != null ? 'menuitemcheckbox' : 'menuitem') + '" class="wtsl-mi' + (it.danger ? ' dng' : '') + '" data-act="' + it.act + '"' +
                (it.v != null ? ' data-v="' + esc(it.v) + '"' : '') + (it.check != null ? ' aria-checked="' + (!!it.check) + '"' : '') + (it.disabled ? ' disabled' : '') + '>' +
                '<span class="ck">' + (it.check ? ICON.check : '') + '</span><span>' + esc(it.label) + '</span>' + (it.key ? '<span class="k">' + esc(it.key) + '</span>' : '') + '</button>';
        }).join('');
        menu = { el: el, key: key, anchor: anchor };
        if (anchor) anchor.setAttribute('aria-expanded', 'true');
        placeAt(el, anchor);
        var first = el.querySelector('button:not([disabled])');
        if (first && anchor && document.activeElement === anchor) first.focus();
    }
    function confirmBox(anchor, text, sub, yesLabel, onYes, key) {
        closeMenu(); closePop();
        var el = mk('div', 'wtsl-menu rp-skip');
        el.setAttribute('role', 'alertdialog'); el.setAttribute('data-wts-ui', '');
        el.innerHTML = '<div class="wtsl-conf"><p>' + esc(text) + '</p>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') +
            '<div class="row"><button type="button" data-wts-ui class="wtsl-b" data-act="menu-close">Cancel</button>' +
            '<button type="button" data-wts-ui class="wtsl-b pri" data-act="confirm-yes">' + esc(yesLabel) + '</button></div></div>';
        menu = { el: el, key: key || 'confirm', anchor: anchor, onYes: onYes };
        placeAt(el, anchor);
        var y = el.querySelector('[data-act=confirm-yes]'); if (y) y.focus();
    }
    function menuItems(kind, st) {
        var it = [];
        if (kind === 'reset') {
            it.push({ act: 'reset', v: 'steady', label: 'Reset to steady', key: 'R' }, { act: 'reset', v: 'empty', label: 'Start from empty' });
        } else if (kind === 'scen') {
            var f = (st && st.faults) || {};
            FAULTS.forEach(function (x) { it.push({ act: 'fault', v: x[0], label: x[1], check: !!f[x[0]] }); });
        } else if (kind === 'view') {
            VIEWS.forEach(function (v) { it.push({ act: 'view', v: v[0], label: v[1], key: v[2] }); });
            it.push({ act: 'orbit', label: 'Auto-rotate', check: !!prefs.orbit, key: 'O' });
        } else if (kind === 'labels') {
            LABEL_MODES.forEach(function (o) { it.push({ act: 'labelset', v: o[0], label: o[1], check: prefs.labels === o[0] }); });
        } else if (kind === 'colour') {
            OVERLAYS.forEach(function (o) { it.push({ act: 'overlay', v: o[0], label: o[1], check: prefs.overlay === o[0] }); });
        } else if (kind === 'quality') {
            QUALS.forEach(function (o) { it.push({ act: 'quality', v: o[0], label: o[1], check: prefs.quality === o[0] }); });
        } else if (kind === 'more') {
            it.push({ h: 'Test' }, { act: 'reset', v: 'steady', label: 'Reset to steady' }, { act: 'reset', v: 'empty', label: 'Start from empty' });
            it.push({ h: 'Scenarios' });
            var f2 = (st && st.faults) || {};
            FAULTS.forEach(function (x) { it.push({ act: 'fault', v: x[0], label: x[1], check: !!f2[x[0]] }); });
            if (mode === '3d') {
                it.push({ h: 'View' });
                VIEWS.forEach(function (v) { it.push({ act: 'view', v: v[0], label: v[1] }); });
                it.push({ act: 'orbit', label: 'Auto-rotate', check: !!prefs.orbit });
                it.push({ h: 'Colour' });
                OVERLAYS.forEach(function (o) { it.push({ act: 'overlay', v: o[0], label: o[1], check: prefs.overlay === o[0] }); });
                it.push({ h: 'Labels' });
                LABEL_MODES.forEach(function (o) { it.push({ act: 'labelset', v: o[0], label: o[1], check: prefs.labels === o[0] }); });
            }
            it.push({ h: 'Display' }, { act: 'legend', label: 'Legend', check: !!prefs.legend }, { act: 'trends', label: 'Trends', check: !!prefs.trends });
            if (mode === '3d') { it.push({ h: 'Quality' }); QUALS.forEach(function (o) { it.push({ act: 'quality', v: o[0], label: o[1], check: prefs.quality === o[0] }); }); }
            it.push({ h: 'Help' }, { act: 'keys', label: 'Keyboard shortcuts', key: '?' });
        }
        return it;
    }
    function closePop() { if (E.pop && E.pop.parentNode) E.pop.parentNode.removeChild(E.pop); E.pop = null; popGroup = null; }
    function openPop(group, anchor) {
        if (popGroup === group) { closePop(); return; }
        closeMenu(); closePop();
        if (group === 'alarm') { toggleDrawer(true); return; }
        var el = mk('div', 'wtsl-pop rp-skip'); el.setAttribute('data-wts-ui', '');
        E.pop = el; popGroup = group;
        updatePop(state());
        var vr = vizEl.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
        el.style.visibility = 'hidden'; vizEl.appendChild(el);
        var w = el.offsetWidth, h = el.offsetHeight;
        el.style.left = clamp(ar.left - vr.left, 8, Math.max(8, vr.width - w - 8)) + 'px';
        el.style.top = Math.max(8, ar.top - vr.top - h - 6) + 'px';
        el.style.visibility = '';
    }
    function updatePop(st) {
        if (!E.pop || !popGroup) return;
        var N = (st && st.nodes) || {}, R = (st && st.rates) || {}, C = (st && st.cum) || {}, su = (st && st.surge) || {}, sep = (st && st.sep) || {}, rows = [];
        if (popGroup === 'clock') rows = [['Sim time', 'T+' + (st ? st.clock : '--')], ['Speed', '×' + (st ? st.speed : prefs.speed)], ['State', E.h.state ? E.h.state.textContent : '']];
        else if (popGroup === 'press') rows = [['Wellhead', fmtU(N.wellhead && N.wellhead.P, 'pressureG')], ['Choke in', fmtU(N.choke && N.choke.Pin, 'pressureG')],
            ['Choke out', fmtU(N.choke && N.choke.P, 'pressureG')], ['Separator', fmtU(sep.P, 'pressureG')], ['Sep setpoint', fmtU(sep.SPeff, 'pressureG')],
            ['Surge tank', fmtU(su.P, 'pressureTank')], ['Flare header', fmtU(N.flare && N.flare.P, 'pressureG')]];
        else if (popGroup === 'rates' || popGroup === 'water') rows = [['Gas', fmtU(R.gas_mmscfd, 'gasRate')], ['Oil', fmtU(num(R.oilMeter_stbd, R.oil_stbd), 'oilRate')],
            ['Water', fmtU(num(R.waterMeter_bpd, R.water_bpd), 'liquidRate')], ['GOR', fmtU(R.gor_scf_stb, 'gor')], ['BS&W', fmtU(R.bsw_pct, 'percent', 1)],
            ['Cum oil', fmtU(C.oilIn_stb, 'oilVolume')], ['Cum water', fmtU(C.waterIn_bbl, 'volume')], ['Cum gas', fmtU(C.gasIn_mmscf, 'gasVolume')], ['Flared', fmtU(C.flare_mmscf, 'gasVolume')]];
        else if (popGroup === 'tanks') {
            var T = (st && st.gauge && st.gauge.tanks) || [];
            rows = [['Surge level', pctStr(su.frac)], ['T-201A · B', su.comps ? surgeRow(st, 0) + ' · ' + surgeRow(st, 1) : '—'],
                ['LCV-201 transfer', xferShort(st)], ['P-201 (T-301 → export)', pumpShort(st)],
                ['T-301A', gtRow(st, 0)], ['T-301B', gtRow(st, 1)], ['Shrinkage', fmtU(R.shrink_pct, 'percent', 1)]];
            if (!T.length) rows.length = 4;
        }
        setHTML(E.pop, rows.map(function (r) { return '<div class="r"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>'; }).join(''));
    }
    function showKeys(onOff) {
        keysOpen = onOff == null ? !keysOpen : !!onOff;
        if (keysOpen && !E.keys.__built) {
            E.keys.__built = 1;
            var K = [['Space', 'Play / pause'], ['[  ]', 'Speed down / up'], ['R', 'Reset test'], ['E', 'Trip ESD'], ['1 – 5', 'Camera views'], ['0 / H', 'Overview'],
                ['V', 'Toggle 3D / 2D'], ['L', 'Cycle labels'], ['O', 'Auto-rotate'], ['F', 'Maximise'], ['A', 'Acknowledge all'], ['Esc', 'Close menu → card → Max'], ['?', 'This sheet']];
            E.keys.innerHTML = '<h4>Keyboard shortcuts</h4>' + K.map(function (k) { return '<div class="kr"><span>' + esc(k[1]) + '</span><kbd>' + esc(k[0]) + '</kbd></div>'; }).join('') +
                '<div style="text-align:right;margin-top:8px"><button type="button" data-wts-ui class="wtsl-b" data-act="keys">Done</button></div>';
        }
        show(E.keys, keysOpen);
    }

    // ── actions ──────────────────────────────────────────────────────
    function askTrip(anchor) {
        if (!_sim) return;
        var st = state();
        if (st && st.esd && st.esd.tripped) return;
        confirmBox(anchor || E.esd, 'Trip ESD?', 'Closes SDV-101 and shuts in the well.', 'Trip', function () {
            try { _sim.tripESD('manual'); } catch (e) {}
            track('wts_esd', { action: 'trip' }); poke(); updateAll(state());
        }, 'esd');
    }
    function doResetESD() {
        if (!_sim) return;
        var r = null;
        try { r = _sim.resetESD(); } catch (e) {}
        if (r && !r.ok) toast('Cannot reset — active: ' + (r.blocking || []).map(tagOfAlarmId).join(', '), 'bad');
        else track('wts_esd', { action: 'reset' });
        poke(); updateAll(state());
    }
    function askReset(m, anchor) {
        if (!_sim) return;
        var go = function () { _alarmMap = {}; try { _sim.reset(m); } catch (e) {} poke(); updateAll(state()); };
        var st = state();
        if (st && st.t > 60) confirmBox(anchor || q('[data-act=resetmenu]', E.tb), 'Reset test?', 'Clears clock, totals and tank levels.', 'Reset', go, 'reset-confirm');
        else { closeMenu(); go(); }
    }
    function setSpeed(x) {
        if (!_sim || SPEEDS.indexOf(x) < 0) return;
        try { _sim.setSpeed(x); _sim.logEvent('Speed ×' + x, 'SIM'); } catch (e) {}
        prefs.speed = x; writePrefs(prefs);
        track('wts_sim_speed', { speed: x });
        poke(); updateToolbar(state());
    }
    function cycleSpeed(dir) {
        var st = state(), cur = st ? st.speed : prefs.speed, i = SPEEDS.indexOf(cur);
        if (i < 0) i = 1;
        i = dir < 0 ? Math.max(0, i - 1) : dir > 0 && dir !== 2 ? Math.min(SPEEDS.length - 1, i + 1) : (i + 1) % SPEEDS.length;
        setSpeed(SPEEDS[i]);
    }
    function togglePlay() {
        if (!_sim) return;
        try { if (_sim.isRunning()) _sim.pause(); else _sim.play(); } catch (e) {}
        if (h3 && _sim.isRunning()) { try { h3.setPaused(mode !== '3d'); } catch (e2) {} }
        poke(); updateAll(state());
    }
    function setLabels(m) {
        prefs.labels = m; writePrefs(prefs);
        if (h3) { try { h3.setLabels(m); } catch (e) {} }
        updateToolbar(state());
    }
    function cycleLabels() {
        var i = 0; for (var k = 0; k < LABEL_MODES.length; k++) if (LABEL_MODES[k][0] === prefs.labels) i = k;
        setLabels(LABEL_MODES[(i + 1) % LABEL_MODES.length][0]);
    }
    function view(name) {
        if (mode !== '3d' || !h3) return;
        try { h3.view(name); } catch (e) {}
        track('wts_camera_view', { view: name });
    }
    function toggleOrbit() {
        prefs.orbit = !prefs.orbit; writePrefs(prefs);
        if (h3) { try { h3.setAutoOrbit(prefs.orbit); } catch (e) {} }
    }
    function toggleMax(v) {
        isMax = v == null ? !isMax : !!v;
        vizEl.classList.toggle('is-max', isMax);
        if (document.body) document.body.classList.toggle('wtsl-max', isMax);
        if (h3) { try { h3.setInteraction({ max: isMax }); h3.resize(); } catch (e) {} }
        later(function () { onResize(); if (h3) { try { h3.resize(); } catch (e) {} } }, 30);
        updateToolbar(state());
    }
    function setBool(k) {
        prefs[k] = !prefs[k]; writePrefs(prefs);
        if (k === 'legend') { show(E.legend, prefs.legend); E.legend.__sig = ''; if (prefs.legend) renderLegend(state()); layout2dTrends(); }
        if (k === 'trends' && mode === '3d') { show(E.trends, prefs.trends); if (prefs.trends) drawTrends(state()); }
        updateToolbar(state());
    }
    function doAct(act, el, ev) {
        var v = el && el.getAttribute('data-v');
        var st = state();
        switch (act) {
            case 'mode3d': setMode('3d', 'user'); break;
            case 'mode2d': setMode('2d', 'user'); break;
            case 'use2d': closeToast(el); setMode('2d', loading ? 'cancel' : 'user'); break;
            case 'play': togglePlay(); break;
            case 'speed': setSpeed(+v); break;
            case 'speedcycle': cycleSpeed(2); break;
            case 'resetmenu': openMenu(el, menuItems('reset', st), 'reset'); break;
            case 'reset': askReset(v, menu && menu.anchor); break;
            case 'esd': if (esdState(st) === 'open') askTrip(el); else doResetESD(); break;
            case 'card-trip': askTrip(el); break;
            case 'esd-reset': doResetESD(); break;
            case 'confirm-yes': { var f = menu && menu.onYes; closeMenu(); if (f) f(); break; }
            case 'menu-close': closeMenu(); break;
            case 'scen': openMenu(el, menuItems('scen', st), 'scen'); break;
            case 'fault': if (_sim && st) { var on = !(st.faults && st.faults[v]); try { _sim.setFault(v, on); } catch (e) {} track('wts_fault', { id: v, on: on });
                poke(); if (menu) { var anc = menu.anchor, key = menu.key; closeMenu(); openMenu(anc, menuItems(key, state()), key); } } break;
            case 'alarms': toggleDrawer(); break;
            case 'viewmenu': openMenu(el, menuItems('view', st), 'view'); break;
            case 'view': closeMenu(); view(v); break;
            case 'orbit': closeMenu(); toggleOrbit(); break;
            case 'colour': openMenu(el, menuItems('colour', st), 'colour'); break;
            case 'overlay': closeMenu(); prefs.overlay = v; writePrefs(prefs); if (h3) { try { h3.setOverlay(v); } catch (e) {} } E.legend.__sig = ''; break;
            case 'labels': openMenu(el, menuItems('labels', st), 'labels'); break;     // a menu like View / Colour; the L key cycles
            case 'labelset': closeMenu(); setLabels(v); break;
            case 'legend': closeMenu(); setBool('legend'); break;
            case 'trends': closeMenu(); setBool('trends'); break;
            case 'quality': if (el && el.classList.contains('wtsl-mi')) { closeMenu(); prefs.quality = v; writePrefs(prefs); if (h3) { try { h3.setQuality(v); } catch (e) {} } }
                else openMenu(el, menuItems('quality', st), 'quality'); break;
            case 'max': closeMenu(); toggleMax(); break;
            case 'more': openMenu(el, menuItems('more', st), 'more'); break;
            case 'keys': closeMenu(); showKeys(); break;
            case 'retry': retry3d(); break;
            case 'notice-close': hideNotice(); break;
            case 'toast-close': closeToast(el); break;
            case 'ack': if (ev) ev.stopPropagation(); ack([v]); break;
            case 'ackall': ackAll(); break;
            case 'dtab': drawerTab = v; renderDrawer(st, true); break;
            case 'drawer-close': toggleDrawer(false); break;
            case 'focus': if (v && EQ_IDS.indexOf(v) >= 0) { closeVin(); if (h3) { try { h3.focus(v); } catch (e) {} } openCard(v); } break;
            case 'card-close': closeCard(); break;
            case 'card-edit': editInputs(cardId); break;
            case 'bean': { var b = readHost('wts_bean'); if (isNum(b)) { setHostInput('wts_bean', clamp(b + (+v), 4, 128), null, 'input'); } later(function () { renderCardActions(state()); }, 0); break; }
            case 'bypass': { var bel = hostEl('wts_bypass'); if (bel) setHostInput('wts_bypass', bel.value === '1' ? '0' : '1', null, 'change'); renderCardActions(state()); break; }
            case 'sp': { var p = readHost('wts_Psep'); if (isNum(p)) setHostInput('wts_Psep', Math.max(5, p + (+v)), 'pressureG', 'input'); later(function () { renderCardActions(state()); }, 0); break; }
            case 'swap': if (_sim) { var ok = false; try { ok = _sim.switchGaugeTank(true); } catch (e) {} if (!ok) toast('Standby compartment not ready'); poke(); } break;
            case 'valve': { var vv = String(v || '').split(':'); toggleValve(vv[0] === 'surge' ? 'surge' : 'gauge', vv[1] === '1' ? 1 : 0); break; }
            case 'suction': setSuction(v); break;
            case 'xfer-reset': resetXfer(); break;
            case 'stroke': { var sv = String(v || '').split(':'); stepStroke(sv[0] === 'surge' ? 'surge' : 'gauge', +sv[1] || 0); break; }
            case 'interrupt': toggleInterrupt(); break;
            case 'vin-close': closeVin(); break;
            case 'auto': toggleAuto(v === 'surge' ? 'surge' : 'gauge'); break;
            case 'autosp': { var av = String(v || '').split(':'); stepAutoSp(av[0] === 'surge' ? 'surge' : 'gauge', +av[1] || 0); break; }
            case 'tile': openPop(v, el); break;
        }
    }
    function closeToast(el) { var t = el && el.closest && el.closest('.wtsl-toast'); if (t && t.parentNode) t.parentNode.removeChild(t); }
    function editInputs(id) {
        var el = hostEl(INPUT_FOR[id] || 'wts_Pwh');
        var card = el && el.closest ? el.closest('.card') : null;
        if (!card) return;
        try { card.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' }); } catch (e) { try { card.scrollIntoView(); } catch (e2) {} }
        var prev = card.style.boxShadow, prevB = card.style.borderColor;
        card.style.transition = 'box-shadow .2s, border-color .2s';
        card.style.boxShadow = '0 0 0 2px var(--accent,#f0883e)'; card.style.borderColor = 'var(--accent,#f0883e)';
        setTimeout(function () { card.style.boxShadow = prev; card.style.borderColor = prevB; }, 1200);
        if (isMax) toggleMax(false);
    }

    // ── input: clicks, keys, 2D picking, touch sheet ─────────────────
    function onClick(ev) {
        var t = ev.target;
        var el = t && t.closest ? t.closest('[data-act]') : null;
        if (el && vizEl.contains(el)) {
            if (el.disabled) return;
            doAct(el.getAttribute('data-act'), el, ev);
            return;
        }
        if (mode === '2d' && E.cv && (t === E.cv)) {
            var vq = coarse2d() ? nearValve(ev) : null;
            if (vq) { openVin(vq); return; }             // phone / touch: ≥ 44 px target → zoomed inset with 44 px buttons
            var id = hit2d(ev), vm2 = /^(valve|suction):(surge|gauge):([01])$/.exec(id || '');
            if (vm2) { if (vm2[1] === 'valve') toggleValve(vm2[2], +vm2[3]); else toggleSuction(+vm2[3]); }
            else if (id) openCard(id); else closeCard();
        }
    }
    function onDocPointerDown(ev) {
        var t = ev.target;
        if (menu && menu.el && !menu.el.contains(t) && !(menu.anchor && menu.anchor.contains(t))) closeMenu();
        if (E.pop && !E.pop.contains(t) && !(t.closest && t.closest('.wtsl-tile'))) closePop();
    }
    function onKey(ev) {
        if (ctl.disposed || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        var t = ev.target, tn = t && t.tagName;
        if (tn === 'INPUT' || tn === 'SELECT' || tn === 'TEXTAREA' || (t && t.isContentEditable)) return;
        var inside = vizEl.contains(document.activeElement) || pointerInside || isMax;
        if (!inside) return;
        var k = ev.key;
        if (k === 'Escape') {
            if (keysOpen) showKeys(false);
            else if (menu) closeMenu();
            else if (E.pop) closePop();
            else if (E.vin) closeVin();
            else if (drawerOpen) toggleDrawer(false);
            else if (cardId) closeCard();
            else if (isMax) toggleMax(false);
            else return;
            ev.preventDefault(); return;
        }
        if ((k === 'Enter' || k === ' ') && t && t.classList && t.classList.contains('wtsl-tile')) { ev.preventDefault(); doAct('tile', t); return; }
        if (tn === 'BUTTON' && (k === ' ' || k === 'Enter')) return;
        if ((k === 'ArrowLeft' || k === 'ArrowRight') && t && E.tb.contains(t)) { roveToolbar(t, k === 'ArrowRight' ? 1 : -1); ev.preventDefault(); return; }
        if ((k === 'ArrowDown' || k === 'ArrowUp') && menu && menu.el.contains(t)) { roveMenu(t, k === 'ArrowDown' ? 1 : -1); ev.preventDefault(); return; }
        if (t && t.classList && t.classList.contains('wts3d-canvas') && /^(Arrow|\+|-|=)/.test(k)) return;   // 32 owns canvas keys
        var hit = true;
        switch (k) {
            case ' ': togglePlay(); break;
            case '[': cycleSpeed(-1); break;
            case ']': cycleSpeed(1); break;
            case 'r': case 'R': askReset('steady', q('[data-act=resetmenu]', E.tb)); break;
            case 'e': case 'E': askTrip(E.esd); break;
            case '1': view('wellhead'); break;
            case '2': view('separator'); break;
            case '3': view('tanks'); break;
            case '4': view('flare'); break;
            case '5': view('process'); break;
            case '0': case 'h': case 'H': view('overview'); break;
            case 'v': case 'V': setMode(mode === '3d' ? '2d' : '3d', 'user'); break;
            case 'l': case 'L': if (mode === '3d') cycleLabels(); break;
            case 'o': case 'O': if (mode === '3d') toggleOrbit(); break;
            case 'f': case 'F': toggleMax(); break;
            case 'a': case 'A': ackAll(); break;
            case '?': showKeys(); break;
            default: hit = false;
        }
        if (hit) ev.preventDefault();
    }
    function roveToolbar(from, dir) {
        var bs = Array.prototype.filter.call(E.tb.querySelectorAll('button'), function (b) { return !b.disabled && b.offsetParent !== null; });
        var i = bs.indexOf(from);
        if (i < 0) return;
        var n = bs[(i + dir + bs.length) % bs.length]; if (n) n.focus();
    }
    function roveMenu(from, dir) {
        var bs = Array.prototype.filter.call(menu.el.querySelectorAll('button'), function (b) { return !b.disabled; });
        var i = bs.indexOf(from);
        var n = bs[(i + dir + bs.length) % bs.length]; if (n) n.focus();
    }
    function onCanvasMove(ev) {
        if (mode !== '2d' || !E.cv) return;
        var id = hit2d(ev);
        E.cv.style.cursor = id ? 'pointer' : 'default';
    }
    var sheetY = null;
    function onCardPointerDown(ev) {
        if (bp !== 'sm') return;
        var t = ev.target;
        if (t.closest && (t.closest('.wtsl-grab') || t.closest('.wtsl-ch'))) sheetY = ev.clientY;
    }
    function onCardPointerUp(ev) {
        if (sheetY != null && ev.clientY - sheetY > 60) closeCard();
        sheetY = null;
    }

    // ── visibility / lifecycle ───────────────────────────────────────
    function onVisibility() {
        if (document.hidden) { stopLoop(); return; }
        bgStopped = false;
        startLoop();
        if (pendingRemount) remountSoon();
    }
    function onBackground() { bgStopped = true; stopLoop(); }
    // Native iOS shell only (ios-bridge.js fires these from Capacitor App.appStateChange; a browser
    // never does). WKWebView may not deliver visibilitychange/pageshow on an app resume, so the
    // foreground event is what restarts the loop, and iOS drops WebGL contexts of a backgrounded app:
    // a context loss while backgrounded or just after resuming is expected, not a graphics fault.
    var appFgAt = 0, appInBg = false;
    function onAppBackground() { appInBg = true; onBackground(); }
    function onAppForeground() { appInBg = false; appFgAt = nowMs(); onVisibility(); }
    function appLifecycleLoss() { return appInBg || (appFgAt > 0 && nowMs() - appFgAt < 10000); }
    function onPageShow() { bgStopped = false; if (!document.hidden) startLoop(); }
    function onUnits() {
        unitsOpt();
        if (h3) { try { h3.refreshUnits(); } catch (e) {} }
        if (E.alarm) E.alarm.__sig = '';
        if (E.legend) E.legend.__sig = '';
        drawerSig = '';
        if (cardId) openCard(cardId);
        poke(); updateAll(state());
    }
    function onPageChange() { if (!vizEl.isConnected) dispose(); }

    function dispose() {
        if (ctl.disposed) return;
        ctl.disposed = true;
        stopLoop();
        if (wd) { clearInterval(wd); wd = 0; }
        mountTok++;
        listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {} });
        listeners = [];
        timers.forEach(function (id) { clearTimeout(id); }); timers = [];
        if (E.ro) { try { E.ro.disconnect(); } catch (e) {} }
        if (E.io) { try { E.io.disconnect(); } catch (e) {} }
        if (E.mqR && E.mqRFn) { try { if (E.mqR.removeEventListener) E.mqR.removeEventListener('change', E.mqRFn); else E.mqR.removeListener(E.mqRFn); } catch (e) {} }
        if (h3) { try { h3.dispose(); } catch (e) {} h3 = null; }
        unhookSim();
        closeMenu(); closePop();
        if (isMax) { vizEl.classList.remove('is-max'); if (document.body) document.body.classList.remove('wtsl-max'); isMax = false; }
        publishSummary(state());
        if (_ctl === api) _ctl = null;
    }

    // ── init ─────────────────────────────────────────────────────────
    var api = {
        setMode: function (m) { if (m === '3d' || m === '2d') setMode(m, 'user'); },
        getMode: function () { return mode; },
        dispose: dispose,
        get disposed() { return ctl.disposed; },
        // Dev / QA hooks (not part of the contract; harmless in production).
        _debug: { state: state, handle: function () { return h3; }, alarms: function () { return _alarmMap; }, openCard: openCard,
            closeCard: closeCard, prefs: function () { return prefs; }, loop: function () { return { raf: raf, wd: wd, lastTick: lastTick, now: nowMs(), mode: mode, h3: !!h3, loading: loading, onScreen: onScreen, disposed: ctl.disposed }; }, draw2d: function () { dirty2d = true; }, insets: computeInsets }
    };
    try {
        hookSession();
        injectCss();
        buildDom();
        bp = bpOf(vizEl.clientWidth || 1200);
        vizEl.setAttribute('data-bp', bp);
        try { if (G.matchMedia) { E.mqR = G.matchMedia('(prefers-reduced-motion: reduce)'); reduced = !!E.mqR.matches;
            E.mqRFn = function () { reduced = !!E.mqR.matches; if (h3) { try { h3.setReducedMotion(reduced); } catch (e) {} } };
            if (E.mqR.addEventListener) E.mqR.addEventListener('change', E.mqRFn); else if (E.mqR.addListener) E.mqR.addListener(E.mqRFn); } } catch (e) {}
        // Sim: create or resync (D10)
        var flow = G.WTS_state && G.WTS_state.flow;
        if (!flowValid(flow) && G.WTS_lastCalc && flowValid(G.WTS_lastCalc.flow)) flow = G.WTS_lastCalc.flow;
        if (_sim) {
            hookSim();
            if (flowValid(flow) && flow !== _lastFlowObj) applyFlow(flow);
            else if (_resetPending && flowValid(flow)) applyFlow(flow);
            var s0 = _sim.getState();
            later(function () { toast('Resumed at T+' + (s0.clock || fmtClockLocal(s0.t))); }, 300);
        } else if (flowValid(flow)) createSim(flow);
        // Listeners
        on(vizEl, 'click', onClick);
        on(vizEl, 'pointerenter', function () { pointerInside = true; });
        on(vizEl, 'pointerleave', function () { pointerInside = false; });
        if (E.cv) on(E.cv, 'pointermove', onCanvasMove);
        on(E.card, 'pointerdown', onCardPointerDown);
        on(E.card, 'pointerup', onCardPointerUp);
        on(document, 'pointerdown', onDocPointerDown, true);
        on(document, 'keydown', onKey);
        on(document, 'wts:calc', onCalc);
        on(document, 'wts:unit-system-changed', onUnits);
        on(document, 'h2oil:pagechange', onPageChange);
        on(document, 'visibilitychange', onVisibility);
        on(document, 'app-backgrounded', onAppBackground);
        on(document, 'app-foregrounded', onAppForeground);
        on(G, 'pagehide', onBackground);
        on(G, 'pageshow', onPageShow);
        on(G, 'focus', function () { if (!document.hidden) { bgStopped = false; startLoop(); if (pendingRemount) remountSoon(); } });
        if (typeof G.ResizeObserver === 'function') { E.ro = new G.ResizeObserver(function () { if (!ctl.disposed && !E.roT) E.roT = later(function () { E.roT = 0; onResize(); }, 0); }); E.ro.observe(vizEl); }
        else on(G, 'resize', onResize);
        if (typeof G.IntersectionObserver === 'function') {
            E.io = new G.IntersectionObserver(function (en) { for (var i = 0; i < en.length; i++) onScreen = en[i].isIntersecting; }, { threshold: 0.1 });
            E.io.observe(vizEl);
        }
        show(E.legend, !!prefs.legend);
        if (prefs.legend) renderLegend(state());
        // Mode (prefs.mode || '3d') and loop
        mode = prefs.mode === '2d' ? '2d' : '3d';
        applyModeDom();
        if (mode === '3d') setMode('3d', 'init'); else { size2d(); dirty2d = true; }
        onResize();
        updateAll(state());
        renderRig(state(), true);
        startWatchdog();
        if (!document.hidden) startLoop();
    } catch (err) {
        console.warn('[WTS] live mount failed', err);
        try { ctl.disposed = true; stopLoop(); if (wd) { clearInterval(wd); wd = 0; } listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {} }); unhookSim(); } catch (e) {}
        revert();
        return null;
    }
    return api;
}

// ═══════════════════════════════════════════════════════════════════
// §F PUBLIC API
// ═══════════════════════════════════════════════════════════════════
function mount(vizEl, opts) {
    if (_ctl) { try { _ctl.dispose(); } catch (e) {} _ctl = null; }
    if (!vizEl || typeof document === 'undefined' || !G.WTS_sim || typeof G.WTS_sim.create !== 'function') return null;
    var c = null;
    try { c = createController(vizEl, opts || {}); } catch (e) { console.warn('[WTS] live mount failed', e); c = null; }
    _ctl = c;
    return c;
}

G.WTS_live = {
    version: VERSION,
    mount: mount,
    getSim: function () { return _sim; },
    fmtU: fmtU,
    fmtParts: fmtParts,
    unitsConv: unitsConv,
    ftIn: ftIn,
    liveNodes: liveNodes,
    liveSegs: liveSegs,
    alarmReduce: alarmReduce,
    pillPick: pillPick,
    statusOf: statusOf,
    _internals: { ctl: function () { return _ctl; }, alarmCount: alarmCount, alarmText: alarmText, inputsDiff: inputsDiff, summaryOf: summaryOf, flowValid: flowValid,
        bpOf: bpOf, dpFor: dpFor, readPrefs: readPrefs, PREFS_KEY: PREFS_KEY, CSS: CSS, miniSnapshot: miniSnapshot,
        setHostInput: setHostInput, readHost: readHost, fmtClock: fmtClockLocal,
        RIG_KEY: RIG_KEY, readRig: readRig, writeRig: writeRig, rigItems: rigItems, rigOut: rigOut, xferShort: xferShort, pumpShort: pumpShort,
        _reset: function () { if (_ctl) { try { _ctl.dispose(); } catch (e) {} } _ctl = null; if (_sim) { try { _sim.dispose(); } catch (e) {} } _sim = null; _lastFlowObj = null; _resetPending = false; _alarmMap = {}; } }
};

})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var L = G.WTS_live;
    if (!L) return;
    var pass = 0, total = 0, fails = [];
    function t(name, fn) {
        total++;
        var ok = false;
        try { ok = fn() === true; } catch (e) { ok = false; fails.push(name + ' threw ' + (e && e.message)); }
        if (ok) pass++; else if (fails.indexOf(name) < 0) fails.push(name);
    }
    var savedU = G.WTS_units;
    try { delete G.WTS_units; } catch (e) { G.WTS_units = undefined; }
    // 1 fmtParts imperial fallback and NaN
    t('fmtParts imperial', function () {
        var a = L.fmtParts(150, 'pressureG');
        return a.v === '150' && a.u === 'psig' && L.fmtParts(NaN, 'pressureG').v === '—' && L.fmtParts(null, 'gasRate').v === '—';
    });
    // 2 ftIn
    t('ftIn', function () { return L.ftIn(12.375) === '12′ 4-½″' && L.ftIn(0) === '0′ 0″' && L.ftIn(1.0625) === '1′ ¾″'; });
    // 3 alarmReduce lifecycle
    t('alarmReduce', function () {
        var a = { id: 'PSH_SEP', tag: 'PAH-101', sev: 'alarm', eq: 'separator', msg: 'x', value: 170, limit: 165, since: 10 };
        var m1 = L.alarmReduce({}, [a], 12, null);
        if (!m1.PSH_SEP || m1.PSH_SEP.state !== 'UNACK' || !m1.PSH_SEP.active) return false;
        var m2 = L.alarmReduce(m1, [a], 13, ['PSH_SEP']);
        if (m2.PSH_SEP.state !== 'ACK') return false;
        var m3 = L.alarmReduce(m1, [], 14, null);                  // cleared while unacked → RTN
        if (!m3.PSH_SEP || m3.PSH_SEP.state !== 'RTN' || m3.PSH_SEP.active) return false;
        var m4 = L.alarmReduce(m3, [], 15, ['PSH_SEP']);           // ack RTN → removed
        if (m4.PSH_SEP) return false;
        var m5 = L.alarmReduce(m2, [], 16, null);                  // cleared after ack → removed
        if (m5.PSH_SEP) return false;
        var info = { id: 'ESD_MANUAL', tag: 'SDV-101', sev: 'info', eq: 'esd', msg: 'm', value: null, limit: null, since: 1 };
        var m6 = L.alarmReduce({}, [info], 1, null);
        return m6.ESD_MANUAL.state === 'ACK' && m1 !== m2 && m1.PSH_SEP.state === 'UNACK';   // prev never mutated
    });
    // 4 statusOf mapping and precedence
    t('statusOf', function () {
        var A = [{ id: 'a', eq: 'separator', sev: 'info' }, { id: 'b', eq: 'separator', sev: 'hyd' }, { id: 'c', eq: 'surge', sev: 'trip' },
            { id: 'd', eq: 'choke', sev: 'warn' }, { id: 'e', eq: 'choke', sev: 'hyd' }, { id: 'f', eq: 'flare', sev: 'info' }];
        return L.statusOf('surge', A) === 'alarm' && L.statusOf('flare', A) === 'evt' && L.statusOf('separator', A) === 'hyd' &&
            L.statusOf('choke', A) === 'warn' && L.statusOf('pump', A) === 'ok' && L.statusOf('x', []) === 'ok' &&
            L.statusOf('choke', A.concat([{ id: 'g', eq: 'choke', sev: 'alarm' }])) === 'alarm';
    });
    // 5 liveNodes / liveSegs on a sim state (or a local fixture)
    t('liveNodes/liveSegs', function () {
        var st = null, S = G.WTS_sim;
        if (S && typeof S.create === 'function' && S.SAMPLE_FLOW) { var sim = S.create(S.SAMPLE_FLOW, { seed: 3 }); sim.advance(30); st = sim.getState(); }
        else if (G.WTS_3d && G.WTS_3d._internals && typeof G.WTS_3d._internals.fakeSnapshot === 'function') st = G.WTS_3d._internals.fakeSnapshot(12.3);
        else st = L._internals.miniSnapshot();
        var n = L.liveNodes(st), s = L.liveSegs(st);
        var names = ['Wellhead', 'SSV', 'Choke', 'Heater', 'Separator', 'Flare', 'Surge Tank', 'Atm Tank'];
        if (n.length !== 8 || s.length !== 6) return false;
        for (var i = 0; i < 8; i++) if (n[i].nm !== names[i] || !isFinite(n[i].P) || !isFinite(n[i].T)) return false;
        for (var j = 0; j < 6; j++) if (!isFinite(s[j].vel)) return false;
        var e = L.liveNodes(null);
        return e.length === 8 && isFinite(e[0].P) && typeof n[2].regime === 'string' && isFinite(n[2].Qmax);
    });
    // 6 mount contract
    t('mount(null)', function () { return typeof L.mount === 'function' && L.mount(null) === null; });
    // 7 pressureTank ATM
    t('pressureTank', function () {
        var a = L.fmtParts(0.3, 'pressureTank'), b = L.fmtParts(25, 'pressureTank');
        return a.v === 'ATM' && b.v === '25.0' && b.u === 'psig';
    });
    // 8 pillPick
    t('pillPick', function () {
        var info = { id: 'I', sev: 'info', state: 'ACK', active: true, tOn: 1 };
        if (L.pillPick({ I: info }) !== null) return false;
        var w = { id: 'W', sev: 'warn', state: 'ACK', active: true, tOn: 2 };
        if (L.pillPick({ I: info, W: w }) !== w) return false;
        var al = { id: 'A', sev: 'alarm', state: 'UNACK', active: true, tOn: 3 }, wu = { id: 'W2', sev: 'warn', state: 'UNACK', active: true, tOn: 9 };
        if (L.pillPick({ A: al, W2: wu }) !== al) return false;
        var r = { id: 'R', sev: 'alarm', state: 'RTN', active: false, tOn: 4 };
        return L.pillPick({ R: r }) === r && L.pillPick({}) === null;
    });
    // 9 unitsConv imperial and with a stub metric WTS_units
    t('unitsConv', function () {
        var a = L.unitsConv(150, 'pressureG');
        if (a.value !== 150 || a.unit !== 'psig') return false;
        G.WTS_units = { getSystem: function () { return 'metric'; }, format: function (v, c) { return c === 'pressureG' ? { value: v * 6.89476, unit: 'kPa', label: 'kPa(g)' } : { value: v, unit: '', label: '' }; } };
        var b = L.unitsConv(150, 'pressureG'), c = L.fmtParts(150, 'pressureG'), d = L.unitsConv(25, 'pressureTank'), g = L.fmtParts(12345, 'gor');
        return Math.abs(b.value - 1034.214) < 0.01 && b.unit === 'kPa(g)' && c.v === '1034' && c.u === 'kPa(g)' && d.unit === 'kPa(g)' && g.v === '12,345' && g.u === 'scf/STB';
    });
    if (savedU === undefined) { try { delete G.WTS_units; } catch (e) { G.WTS_units = undefined; } } else G.WTS_units = savedU;
    var msg = '[38-wts-live] self-test ' + pass + '/' + total + ' passed' + (fails.length ? ' — FAILED: ' + fails.join('; ') : '');
    if (typeof console !== 'undefined') console[pass === total ? 'log' : 'warn'](msg);
    if (pass !== total && typeof process !== "undefined" && process && process.versions && process.versions.node) process.exitCode = 1;
})();
