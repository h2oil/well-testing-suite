/* ═══════════════════════════════════════════════════════════════════════════
 * 32-wts-3d.js — Well Test Simulator: live 3D process scene (Round-7)
 * ─────────────────────────────────────────────────────────────────────────
 * window.WTS_3d  — Three.js r170 "industrial digital twin at blue hour":
 *   WH-101 → SDV-101 (ESD) → CK-101 → H-101 → V-101 → gas → FS-401
 *                                             └→ liquids → T-201 → P-201 → T-301A|B
 *   · Fresnel glass vessels with phase-banded, luminous fluids and animated
 *     interfaces (water / emulsion / oil / gas cap), weir cascade, bubbles
 *   · glass pipes with flow tracers walking an edge graph (real-time clock)
 *   · procedural flare, lighting / PMREM environment / tone mapping / bloom
 *   · custom orbit camera (Pointer Events, pinch), picking proxies, views
 *   · HTML label overlay with collision placement + SVG leaders
 *   · quality tiers with an auto step-down governor, disposal, context loss
 *   · canvas.__h2oilSnapshot() so page PDF/PNG exports include the 3D view
 *
 * Data: consumes the WTS_sim snapshot (§3.3 of the Round-7 spec) read-only,
 * field units internally. Display formatting comes from opts.fmt/fmtParts/units.
 * Representative equipment · piping enlarged and distances compressed for clarity.
 *
 * Load-time: defines functions and assigns window.WTS_3d only (no DOM, no timers).
 * three.js r170 is loaded on demand (fetch → SHA-384 → IndexedDB → blob import).
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;

// ═════════════════════════════════════════════════════════════════════════
// §A CONSTANTS
// ═════════════════════════════════════════════════════════════════════════
var VERSION = '1.1.0';

var PALETTE = {
  skyZenith:'#04070c', skyHorizon:'#0f1826', skyBelow:'#07090c', warmGlow:'#2a160c', fog:'#0b111a',
  pad:'#121821', gridMinor:'#161d27', gridMajor:'#22406a', earth:'#0a0d11',
  steelDark:'#2b313a', steelSatin:'#7f8b99', bolt:'#1f242b', rubber:'#111418',
  yellow:'#d9a520', accent:'#f0883e', paintBlue:'#27496d',
  glassTint:'#cfe3ff', glassRim:'#9ccfff', gasTracer:'#d8f0ff', mist:'#9ec9ff',
  waterBody:'#1f7fe0', waterSurface:'#4fb3ff', waterTracer:'#4aa3ff', waterCss:'#1f7fe0',
  emulsionMix:'#c9b28a', heaterBath:'#1b7f79',
  ok:'#3fb950', warn:'#d29922', alarm:'#f85149', hyd:'#58a6ff', frost:'#dceeff', info:'#bc8cff'
};

var STATUS_MAP = { trip:'alarm', alarm:'alarm', warn:'warn', hyd:'hyd', info:'evt' };
var STATUS_RANK = { ok:0, evt:1, hyd:2, warn:3, alarm:4 };

var EQ_IDS = ['wellhead','esd','choke','heater','separator','flare','surge','pump','gauge'];
var STEP = { wellhead:'①', esd:'②', choke:'③', heater:'④', separator:'⑤',
             flare:'⑥', surge:'⑦', pump:'⑧', gauge:'⑨' };
var TAGS = { wellhead:'WH-101', esd:'SDV-101', choke:'CK-101', heater:'H-101', separator:'V-101',
             flare:'FS-401', surge:'T-201', pump:'P-201', gauge:'T-301' };
var TITLES = { wellhead:'WELLHEAD', esd:'ESD VALVE', choke:'CHOKE', heater:'LINE HEATER', separator:'SEPARATOR',
               flare:'FLARE', surge:'SURGE TANK', pump:'TRANSFER PUMP', gauge:'GAUGE TANK' };
var PREF_SIDE = { wellhead:'nw', esd:'n', choke:'ne', heater:'n', separator:'n', flare:'e', surge:'nw', pump:'s', gauge:'ne' };

// Label anchors (top of equipment + 0.3 m)
var ANCHORS = {
  wellhead:[-15.0,2.75,0], esd:[-11.6,3.6,0], choke:[-7.2,2.25,0], heater:[-1.4,2.75,0], separator:[5.6,3.2,0],
  flare:[19.5,8.1,-4.5], surge:[10.2,6.0,4.0], pump:[12.6,1.15,4.0], gauge:[16.4,3.2,4.0]
};

// Overview auto-fit box (process equipment + pipes only, capped at y 7) — §5.2
var FIT_BOX = { min:[-15.8,0,-5.3], max:[20.0,7.0,6.5] };
var PROCESS_BOX = { min:[2.1,0,-0.9], max:[18.9,6.2,6.4] };
// Tighter default-overview fit set: the upstream skid row and the downstream block as two boxes (+ heater stack top),
// so the empty pad in front of the wellhead does not inflate the frame. Same extents as FIT_BOX.
var FIT_PTS = (function () {
  var p = [], add = function (a, b) { for (var i = 0; i < 8; i++) p.push([i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]); };
  add([-15.8, 0, -1.6], [1.2, 3.6, 1.9]); add([2.0, 0, -5.3], [20.0, 7.0, 6.5]); p.push([0.55, 5.5, 0.28]);
  return { min:[-15.8, 0, -5.3], max:[20.0, 7.0, 6.5], pts:p };
})();
var V101_BOX = { min:[5.6-3.425,2.0-0.85,-0.85], max:[5.6+3.425,2.0+0.85,0.85] };

// Hand-authored picking / occlusion proxies (centre, size) — §5.11
var PROXIES = [
  ['wellhead',[-15,1.0,0],[1.2,2.4,1.2]],
  ['esd',[-11.6,1.8,0],[0.9,3.4,0.9]], ['esd',[-12.6,1.1,1.5],[0.6,0.9,0.3]],
  ['choke',[-7.2,0.9,0],[3.8,1.4,2.0]],
  ['heater',[-1.4,1.6,0],[3.4,1.7,1.7]], ['heater',[0.55,3.5,0.28],[0.5,3.6,0.5]],
  ['separator',[5.6,2.0,0],[6.9,1.8,1.8]],
  ['surge',[10.2,3.3,4.0],[2.5,4.9,2.5]],
  ['pump',[12.6,0.5,3.6],[0.9,1.0,1.6]],
  ['gauge',[16.4,1.55,4.0],[5.0,2.6,2.6]],
  ['flare',[19.5,3.9,-4.5],[0.8,7.8,0.8]], ['flare',[19.5,0.2,-4.5],[1.6,0.4,1.6]]
];
var MUSHROOM = { c:[-12.6,0.95,1.66], s:[0.14,0.14,0.12] };
// Operable valves (tap/click toggles): T-201 inlets XV-201A/B, P-201 suctions A/B, T-301 inlets XV-301A/B
var VALVE_PROXIES = [
  ['valve:surge:0',[8.8,4.2,4.15],[0.5,0.5,0.75]], ['valve:surge:1',[9.3,6.1,3.3],[0.5,0.65,0.5]],
  ['suction:surge:0',[10.1,0.5,4.05],[0.42,0.42,0.5]], ['suction:surge:1',[10.65,0.72,4.05],[0.42,0.42,0.5]],
  ['valve:gauge:0',[15.3,3.2,3.6],[0.62,0.5,0.5]], ['valve:gauge:1',[17.7,3.2,3.6],[0.62,0.5,0.5]]
];
var PAD_RECT = { x0:-20, x1:24, z0:-10, z1:8.5 };

// Framing boxes per equipment group (view presets only, never picking)
var EQ_BOX = {
  wellhead:[[-16.6,0,-1.6],[-13.4,2.6,1.9]], esd:[[-12.9,0,-0.6],[-11.0,3.4,1.8]], choke:[[-9.1,0,-1.2],[-5.3,2.0,1.2]],
  heater:[[-3.3,0,-0.9],[1.0,5.4,1.6]], separator:[[2.1,0,-0.9],[9.1,3.1,1.2]], flare:[[18.6,0,-5.3],[20.4,7.8,-3.7]],
  surge:[[8.9,0,2.7],[11.5,6.2,5.3]], pump:[[12.0,0,2.8],[13.0,1.1,4.4]], gauge:[[13.8,0,1.9],[19.4,3.9,5.5]]
};
var VIEWS = {
  overview:{ groups:null, az:-18, el:20, margin:1 },
  wellhead:{ groups:['wellhead','esd','choke'], az:-25, el:18, margin:1.25 },
  separator:{ groups:['heater','separator'], az:-20, el:20, margin:1.20 },
  tanks:{ groups:['surge','pump','gauge'], az:-10, el:28, margin:1.20 },
  flare:{ groups:['flare'], az:-15, el:12, margin:1.30, flame:true },
  process:{ groups:['separator','surge','gauge'], az:-10, el:30, margin:1.15 }
};
var FOCUS = {
  wellhead:[[-15,1.3,0],7], esd:[[-11.6,1.8,0],6], choke:[[-7.2,1.3,0],6], heater:[[-1.4,1.7,0.3],8],
  separator:[[5.6,2.0,0],11], surge:[[10.2,3.2,4.0],11], pump:[[12.6,0.6,4.0],5], gauge:[[16.4,1.6,4.0],11],
  flare:[[19.5,5,-4.5],18]
};

// Pipe routes (orthogonal waypoints; fillets added automatically) — §5.3
// aSeg: 0–5 main segments, 6 LW, 7 LO, 8 LM, 9 BLK, 10 VENT, 11 XA/XB, 12 E2b (isolated), 13 DRA/DRB
var ROUTES = [
  { id:'E1',  aSeg:0, seg:0, line:'wh_esd',       phase:'multi', pts:[[-14.2,1.2,0],[-12.0,1.2,0]] },
  { id:'E2',  aSeg:1, seg:1, line:'esd_choke',    phase:'multi', pts:[[-11.2,1.2,0],[-8.65,1.2,0],[-8.65,1.2,0.6],[-7.4,1.2,0.6]] },
  { id:'E2b', aSeg:12, seg:-1, npsSeg:1, line:null, phase:'none', pts:[[-8.65,1.2,0],[-8.65,1.2,-0.6],[-5.75,1.2,-0.6],[-5.75,1.2,0]] },
  { id:'E3',  aSeg:2, seg:2, line:'choke_heater', phase:'multi', pts:[[-7.4,1.2,0.6],[-5.75,1.2,0.6],[-5.75,1.2,0],[-4.3,1.2,0]] },
  { id:'E3c', aSeg:2, seg:2, line:'choke_heater', phase:'multi', pts:[[-4.3,1.2,0],[-3.9,1.2,0],[-3.9,1.9,0],[-3.9,1.9,0.4],[-3.15,1.9,0.4]] },
  { id:'E3b', aSeg:2, seg:2, line:'choke_heater', phase:'multi', pts:[[-4.3,1.2,0],[-4.3,1.2,1.5],[1.0,1.2,1.5],[1.0,1.2,0]] },
  { id:'E4a', aSeg:3, seg:3, line:'heater_sep',   phase:'multi', pts:[[0.35,1.9,-0.4],[1.0,1.9,-0.4],[1.0,1.2,-0.4],[1.0,1.2,0]] },
  { id:'E4',  aSeg:3, seg:3, line:'heater_sep',   phase:'multi', pts:[[1.0,1.2,0],[1.6,1.2,0],[1.6,2.3,0],[2.05,2.3,0]] },
  { id:'G1',  aSeg:4, seg:4, line:'sep_flare',    phase:'gas',   pts:[[8.1,2.87,0],[8.1,3.6,0],[18.6,3.6,0],[18.6,3.6,-4.5],[18.6,1.0,-4.5],[19.28,1.0,-4.5]] },
  { id:'LW',  aSeg:6, seg:-1, nps:3, line:'sep_water', phase:'water', pts:[[6.3,1.13,0],[6.3,0.55,0],[6.3,0.55,2.4],[8.1,0.55,2.4]] },
  { id:'LO',  aSeg:7, seg:-1, nps:3, line:'sep_oil',   phase:'oil',   pts:[[8.1,1.13,0],[8.1,0.55,0],[8.1,0.55,2.4]] },
  { id:'LM',  aSeg:8, seg:-1, nps:3, line:'LM',        phase:'liquid',pts:[[8.1,0.55,2.4],[8.1,0.55,4.0],[8.1,4.2,4.0],[9.0,4.2,4.0]] },
  { id:'BLK', aSeg:9, seg:-1, nps:2, line:'blanket',   phase:'gas',   pts:[[4.1,2.87,0],[4.1,4.9,0],[4.1,4.9,4.0],[9.0,4.9,4.0]] },
  { id:'VENT',aSeg:10, seg:-1, nps:2, line:'surge_vent', phase:'gas', pts:[[10.2,5.7,4.0],[10.2,6.1,4.0],[13.0,6.1,4.0],[13.0,6.1,0],[13.0,3.6,0]] },
  { id:'X1',  aSeg:5, seg:5, line:'surge_gauge',  phase:'liquid', pts:[[10.65,0.95,4.0],[10.65,0.45,4.0],[12.2,0.45,4.0]] },
  { id:'X2',  aSeg:5, seg:5, line:'surge_gauge',  phase:'liquid', pts:[[12.5,0.75,4.0],[12.5,1.1,4.0],[13.4,1.1,4.0],[13.4,3.4,4.0],[13.4,3.4,3.6],[15.2,3.4,3.6]] },
  { id:'XA',  aSeg:11, seg:5, line:'surge_gauge', phase:'liquid', pts:[[15.2,3.4,3.6],[15.2,2.7,3.6]] },
  { id:'XB',  aSeg:11, seg:5, line:'surge_gauge', phase:'liquid', pts:[[15.2,3.4,3.6],[17.6,3.4,3.6],[17.6,2.7,3.6]] },
  { id:'DRA', aSeg:13, seg:-1, nps:3, line:'gauge_drain', phase:'liquid', pts:[[15.4,0.35,5.4],[15.4,0.35,6.3],[20.0,0.35,6.3]] },
  { id:'DRB', aSeg:13, seg:-1, nps:3, line:'gauge_drain', phase:'liquid', pts:[[17.9,0.35,5.4],[17.9,0.35,6.3]] }
];
var PSV_ROUTE = [[5.2,2.87,0],[5.2,4.1,0],[12.4,4.1,0],[12.4,3.6,0]];
var TEES = [[-4.3,1.2,0,6],[1.0,1.2,0,6],[15.2,3.4,3.6,3],[8.1,0.55,2.4,3],[17.9,0.35,6.3,3],[13.0,3.6,0,6],[12.4,3.6,0,6]];

// Segment chip anchors (pipe midpoints): 6 main + LW + LO
var SEG_CHIPS = [
  { key:'s0', seg:0, at:[-13.1,1.2,0] }, { key:'s1', seg:1, at:[-9.9,1.2,0] }, { key:'s2', seg:2, at:[-5.0,1.2,0] },
  { key:'s3', seg:3, at:[1.6,1.8,0] },  { key:'s4', seg:4, at:[14.5,3.6,0] }, { key:'s5', seg:5, at:[13.4,2.3,4.0] },
  { key:'lw', line:'sep_water', at:[6.3,0.55,1.3] }, { key:'lo', line:'sep_oil', at:[8.1,0.55,1.3] }
];

var TIERS = {
  high:   { tracers:2000, vesselK:1, dprCap:2.0, dprFloor:1.0, shadow:2048, spots:true, beams:true, physical:true, back:true,
            capNormals:2, drops:true, fbm:4, outer:true, embers:120, smoke:true, bloom:true, stars:true, haze:true, bolts:true,
            radV:64, radP:16, fps:60, capGrid:48 },
  medium: { tracers:1100, vesselK:1, dprCap:1.5, dprFloor:1.0, shadow:1024, spots:false, beams:false, physical:false, back:true,
            capNormals:1, drops:false, fbm:3, outer:true, embers:60, smoke:false, bloom:false, stars:true, haze:false, bolts:false,
            radV:48, radP:12, fps:60, capGrid:48 },
  low:    { tracers:450, vesselK:0.5, dprCap:1.0, dprFloor:0.75, shadow:0, spots:false, beams:false, physical:false, back:false,
            capNormals:0, drops:false, fbm:2, outer:false, embers:0, smoke:false, bloom:false, stars:false, haze:false, bolts:false,
            radV:32, radP:10, fps:30, capGrid:6 }
};

// Snapshot paths that may be null (copy of WTS_sim.NULLABLE; §3.3)
var NULLABLE = ['esd.cause','esd.tripT','surge.tFull_s','rates.gor_scf_stb','rates.bsw_pct','rates.tank_stbd',
  'rates.shrink_pct','alarms[*].value','alarms[*].limit','alarmLog[*].sev','gauge.batches[*].gor_scf_stb','gauge.batches[*].bsw_pct'];

// ═════════════════════════════════════════════════════════════════════════
// §B PURE HELPERS (Node-testable; exported as _internals)
// ═════════════════════════════════════════════════════════════════════════
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function num(v, d) { v = +v; return (v === v && isFinite(v)) ? v : d; }
function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }

function hexToRgb(hex) {
  var h = String(hex).replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function rgbToHex(r, g, b) {
  var f = function (x) { var s = Math.round(clamp(x, 0, 1) * 255).toString(16); return s.length < 2 ? '0' + s : s; };
  return '#' + f(r) + f(g) + f(b);
}
function mixHex(a, b, t) { var A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)); }
function scaleHex(a, k) { var A = hexToRgb(a); return rgbToHex(A[0] * k, A[1] * k, A[2] * k); }
function srgbToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function luminance(hex) { var A = hexToRgb(hex); return 0.2126 * srgbToLin(A[0]) + 0.7152 * srgbToLin(A[1]) + 0.0722 * srgbToLin(A[2]); }

function pipeRadius(nps) { nps = num(parseFloat(nps), 4); return 0.07 + 0.024 * nps; }

function oilColor(API) {
  var a = num(API, 35);
  var t = Math.pow(clamp((a - 15) / 35, 0, 1), 0.8);
  var body = mixHex('#2a1305', '#d9a441', t);
  return { body:body, surface:scaleHex(body, 1.35), tracer:mixHex('#ff9f40', '#ffd27a', t), css:body,
           alphaFront:0.92 + (0.62 - 0.92) * t };
}

function velToScene(v) { v = num(v, 0); if (v <= 0.01) return 0; return clamp(0.35 * Math.pow(v, 0.55), 0.05, 6); }
function flameLength(q) { q = num(q, 0); if (q < 0.01) return 0; return clamp(1.5 + 2.4 * Math.log10(1 + 3 * q), 1.5, 9); }

// In-situ volume fractions of a multiphase stream (z ≈ 0.9). Writes into out {g,o,w}.
function phaseFractions(Qg, Qo, Qw, P, T, out) {
  out = out || { g:0, o:0, w:0 };
  var pa = Math.max(num(P, 0) + 14.696, 14.696), tr = num(T, 100) + 459.67;
  var g = Math.max(num(Qg, 0), 0) * 1e6 / 86400 * (14.696 / pa) * (tr / 519.67) * 0.9;
  var o = Math.max(num(Qo, 0), 0) * 5.614583 / 86400, w = Math.max(num(Qw, 0), 0) * 5.614583 / 86400;
  var s = g + o + w;
  if (s <= 1e-12) { out.g = 0; out.o = 0; out.w = 0; return out; }
  out.g = g / s; out.o = o / s; out.w = w / s; return out;
}

var NICE_P_IMP = [60, 100, 160, 300, 600, 1500, 3000, 5000, 10000];
var NICE_P_MET = [400, 700, 1000, 2000, 4000, 10000, 20000, 40000, 70000];
function niceRange(pmax, metric) {
  var L = metric ? NICE_P_MET : NICE_P_IMP; pmax = Math.max(num(pmax, 0), 0) * 1.15;
  for (var i = 0; i < L.length; i++) if (L[i] >= pmax) return L[i];
  return L[L.length - 1];
}

function pickTier(o) { o = o || {}; if (o.software) return 'low'; if (o.mobile) return 'medium'; return 'high'; }

function lodForDistance(dRel, prevVisible) {
  dRel = num(dRel, 99);
  if (prevVisible === true) return dRel < 1.54;
  if (prevVisible === false) return dRel < 1.26;
  return dRel < 1.4;
}

// Status for an equipment id from the active sim alarms (D38).
function statusForEq(alarms, eq, opts) {
  var forHalo = !!(opts && opts.forHalo), best = 'ok';
  if (!alarms || !alarms.length) return best;
  for (var i = 0; i < alarms.length; i++) {
    var a = alarms[i]; if (!a || a.eq !== eq) continue;
    var st = STATUS_MAP[a.sev] || 'ok';
    if (a.sev === 'info') {
      if (forHalo) { if (a.id === 'ESD_MANUAL') st = 'warn'; else continue; }
    }
    if (STATUS_RANK[st] > STATUS_RANK[best]) best = st;
  }
  return best;
}

// ── routes: orthogonal waypoints → straights + 90° fillet arcs ──────────
function v3sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function v3add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function v3scale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function v3len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
function v3norm(a) { var l = v3len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function v3cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

function anyPerp(d) {
  var up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  var n = v3sub(up, v3scale(d, v3dot(up, d))); return v3norm(n);
}
function rotAxis(v, k, a) {                               // Rodrigues
  var c = Math.cos(a), s = Math.sin(a), kv = v3cross(k, v), kd = v3dot(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}

function buildRoute(pts, rVis, opts) {
  var prims = [], n = pts.length, len = 0;
  if (n < 2) return { prims:prims, length:0, rVis:rVis };
  var rbMax = (opts && opts.rb != null) ? opts.rb : 3 * rVis;
  var cur = pts[0].slice(), nrm = null;
  for (var k = 1; k < n; k++) {
    var p = pts[k], dIn = v3norm(v3sub(p, pts[k - 1]));
    var legIn = v3len(v3sub(p, pts[k - 1]));
    var hasCorner = false, rb = 0, dOut = null;
    if (k < n - 1) {
      dOut = v3norm(v3sub(pts[k + 1], p));
      var legOut = v3len(v3sub(pts[k + 1], p));
      if (Math.abs(v3dot(dIn, dOut)) < 0.999 && legIn > 1e-6 && legOut > 1e-6) {
        hasCorner = true; rb = Math.min(rbMax, 0.45 * Math.min(legIn, legOut));
      }
    }
    var s = hasCorner ? v3sub(p, v3scale(dIn, rb)) : p.slice();
    var L = v3len(v3sub(s, cur));
    if (!nrm) nrm = anyPerp(dIn);
    if (L > 1e-6) { prims.push({ type:'L', a:cur.slice(), b:s.slice(), len:L, dir:dIn, n0:nrm.slice(), s0:len }); len += L; }
    if (hasCorner) {
      var c = v3add(s, v3scale(dOut, rb)), u = v3norm(v3sub(s, c)), axis = v3norm(v3cross(dIn, dOut));
      var al = rb * Math.PI / 2;
      prims.push({ type:'A', c:c, u:u, v:dIn, R:rb, ang:Math.PI / 2, len:al, n0:nrm.slice(), axis:axis, dIn:dIn, dOut:dOut, s0:len });
      len += al;
      nrm = rotAxis(nrm, axis, Math.PI / 2);
      cur = v3add(p, v3scale(dOut, rb));
    } else cur = s;
  }
  return { prims:prims, length:len, rVis:rVis };
}
function routeLength(route) { return route ? route.length : 0; }
// Position (and optional tangent) at arc length s. out: {p:[3], t:[3]}
function routeSample(route, s, out) {
  out = out || { p:[0, 0, 0], t:[1, 0, 0] };
  var P = route.prims; if (!P.length) return out;
  s = clamp(s, 0, route.length);
  var pr = P[P.length - 1];
  for (var i = 0; i < P.length; i++) { if (s <= P[i].s0 + P[i].len + 1e-12) { pr = P[i]; break; } }
  var ls = clamp(s - pr.s0, 0, pr.len);
  if (pr.type === 'L') {
    var f = pr.len > 0 ? ls / pr.len : 0;
    out.p[0] = lerp(pr.a[0], pr.b[0], f); out.p[1] = lerp(pr.a[1], pr.b[1], f); out.p[2] = lerp(pr.a[2], pr.b[2], f);
    out.t[0] = pr.dir[0]; out.t[1] = pr.dir[1]; out.t[2] = pr.dir[2];
  } else {
    var a = pr.R > 0 ? ls / pr.R : 0, ca = Math.cos(a), sa = Math.sin(a);
    for (var j = 0; j < 3; j++) {
      out.p[j] = pr.c[j] + pr.R * (pr.u[j] * ca + pr.v[j] * sa);
      out.t[j] = -pr.u[j] * sa + pr.v[j] * ca;
    }
  }
  return out;
}

// ── vessel geometry helpers ─────────────────────────────────────────────
function capHalfWidth(Ri, Ltt, hd, y, x) {
  var yc = y - Ri, s = Math.sqrt(Math.max(0, 1 - (yc * yc) / (Ri * Ri)));
  var w0 = Ri * s, e = hd * s, ax = Math.abs(x);
  if (ax <= Ltt / 2) return w0;
  if (e <= 1e-9) return 0;
  var q = (ax - Ltt / 2) / e;
  return w0 * Math.sqrt(Math.max(0, 1 - q * q));
}
// Vertical 2:1 vessel: radius at height y above the bottom apex
function vertCapRadius(R, Ls, hd, y) {
  if (y <= 0 || y >= Ls + 2 * hd) return 0;
  if (y < hd) { var q = (hd - y) / hd; return R * Math.sqrt(Math.max(0, 1 - q * q)); }
  if (y <= hd + Ls) return R;
  var q2 = (y - hd - Ls) / hd; return R * Math.sqrt(Math.max(0, 1 - q2 * q2));
}
// Lathe profile, bottom apex (y 0) → top apex
function vesselProfile(R, Ls, hd, nHead) {
  nHead = nHead || 16; var pts = [], i, ph;
  for (i = 0; i <= nHead; i++) { ph = (i / nHead) * Math.PI / 2; pts.push([Math.max(R * Math.sin(ph), 1e-4), hd * (1 - Math.cos(ph))]); }
  for (i = 1; i <= nHead; i++) { ph = (i / nHead) * Math.PI / 2; pts.push([Math.max(R * Math.cos(ph), 1e-4), hd + Ls + hd * Math.sin(ph)]); }
  return pts;
}

// ── colour maps (overlay modes, §5.13) ──────────────────────────────────
var CMAPS = {
  pressure:[['#58a6ff', 0], ['#bc8cff', 0.35], ['#f0883e', 0.7], ['#f85149', 1]],
  temperature:[['#58a6ff', 0], ['#e6edf3', 0.5], ['#f0883e', 1]],
  erosion:[['#3fb950', 0], ['#3fb950', 0.55], ['#d29922', 0.75], ['#f85149', 0.9], ['#f85149', 1]]
};
var CMAP_RGB = {};
(function () { for (var k in CMAPS) CMAP_RGB[k] = CMAPS[k].map(function (s) { var c = hexToRgb(s[0]); return [c[0], c[1], c[2], s[1]]; }); })();
// sRGB rgb (0..1) for t in 0..1 → out[3]
function colormapRGB(mode, t, out) {
  out = out || [0, 0, 0]; var S = CMAP_RGB[mode] || CMAP_RGB.pressure; t = clamp(num(t, 0), 0, 1);
  for (var i = 1; i < S.length; i++) {
    if (t <= S[i][3] || i === S.length - 1) {
      var a = S[i - 1], b = S[i], f = b[3] > a[3] ? clamp((t - a[3]) / (b[3] - a[3]), 0, 1) : 1;
      out[0] = lerp(a[0], b[0], f); out[1] = lerp(a[1], b[1], f); out[2] = lerp(a[2], b[2], f); return out;
    }
  }
  return out;
}
function colormap(mode, v, min, max) {
  var t = max > min ? (num(v, min) - min) / (max - min) : 0; var c = colormapRGB(mode, t);
  return rgbToHex(c[0], c[1], c[2]);
}

// ── camera maths (pure; no THREE) ───────────────────────────────────────
function camDir(azDeg, elDeg) {
  var az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
}
// cam: {pos:[3], target:[3], fov:deg, up?:[3]}; out {x,y,z,behind}
function project(p, cam, w, h, out) {
  out = out || { x:0, y:0, z:0, behind:false };
  var up = cam.up || [0, 1, 0];
  var f = v3norm(v3sub(cam.target, cam.pos)), r = v3norm(v3cross(f, up)), u = v3cross(r, f);
  var d = v3sub(p, cam.pos), xc = v3dot(d, r), yc = v3dot(d, u), zc = v3dot(d, f);
  var t = Math.tan(cam.fov * Math.PI / 360), asp = w / h;
  out.z = zc; out.behind = zc <= 1e-6;
  var zz = Math.max(zc, 1e-6);
  out.x = (xc / (zz * t * asp) + 1) / 2 * w; out.y = (1 - yc / (zz * t)) / 2 * h;
  return out;
}
function boxCorners(box) {
  var a = box.min, b = box.max, c = [];
  for (var i = 0; i < 8; i++) c.push([i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]);
  return c;
}
// Asymmetric-inset fit (D23): bisection on radius; target re-centred into the usable band.
function fitView(box, azDeg, elDeg, fovDeg, w, h, insets) {
  insets = insets || {}; w = Math.max(num(w, 2), 2); h = Math.max(num(h, 2), 2);
  var L = num(insets.left, 0), R = num(insets.right, 0), T = num(insets.top, 0), B = num(insets.bottom, 0);
  var xmin = -1 + 2 * L / w + 0.04, xmax = 1 - 2 * R / w - 0.04, ymin = -1 + 2 * B / h + 0.04, ymax = 1 - 2 * T / h - 0.04;
  if (xmax - xmin < 0.2) { xmin = -0.9; xmax = 0.9; }
  if (ymax - ymin < 0.2) { ymin = -0.9; ymax = 0.9; }
  var C = box.pts || boxCorners(box), ctr = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2], NC = C.length;
  var d = camDir(azDeg, elDeg), t = Math.tan(fovDeg * Math.PI / 360), asp = w / h;
  var f = v3scale(d, -1), rr = v3norm(v3cross(f, [0, 1, 0])), uu = v3cross(rr, f);
  var cam = { pos:[0, 0, 0], target:[0, 0, 0], fov:fovDeg }, pr = { x:0, y:0, z:0, behind:false };
  function bounds(r, tgt, o) {
    cam.target = tgt; cam.pos = v3add(tgt, v3scale(d, r));
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, behind = false;
    for (var i = 0; i < NC; i++) {
      project(C[i], cam, w, h, pr); if (pr.behind) behind = true;
      var nx = pr.x / w * 2 - 1, ny = 1 - pr.y / h * 2;
      if (nx < x0) x0 = nx; if (nx > x1) x1 = nx; if (ny < y0) y0 = ny; if (ny > y1) y1 = ny;
    }
    o.x0 = x0; o.x1 = x1; o.y0 = y0; o.y1 = y1; o.behind = behind; return o;
  }
  var bb = {};
  function centred(r) {
    var tgt = ctr.slice();
    for (var it = 0; it < 4; it++) {
      bounds(r, tgt, bb); if (bb.behind) break;
      var sx = ((bb.x0 + bb.x1) - (xmin + xmax)) / 2, sy = ((bb.y0 + bb.y1) - (ymin + ymax)) / 2;
      tgt = v3add(tgt, v3add(v3scale(rr, sx * r * t * asp), v3scale(uu, sy * r * t)));
    }
    bounds(r, tgt, bb);
    var ok = !bb.behind && bb.x0 >= xmin - 1e-6 && bb.x1 <= xmax + 1e-6 && bb.y0 >= ymin - 1e-6 && bb.y1 <= ymax + 1e-6;
    return { ok:ok, target:tgt };
  }
  var lo = 0.5, hi = 40, res = centred(hi), k = 0;
  while (!res.ok && k++ < 12) { lo = hi; hi *= 2; res = centred(hi); }
  var best = res;
  for (var i = 0; i < 20; i++) {
    var mid = (lo + hi) / 2, m = centred(mid);
    if (m.ok) { hi = mid; best = m; } else lo = mid;
  }
  return { radius:hi, target:best.target, az:azDeg, el:elDeg };
}
function fitRadius(box, azDeg, elDeg, fovDeg, w, h, insets) { return fitView(box, azDeg, elDeg, fovDeg, w, h, insets).radius; }

// ── label placement (greedy 8-candidate) ────────────────────────────────
var DIRS = { n:[0, -1], ne:[0.7071, -0.7071], e:[1, 0], se:[0.7071, 0.7071], s:[0, 1], sw:[-0.7071, 0.7071], w:[-1, 0], nw:[-0.7071, -0.7071] };
var DIR_ORDER = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
// rects[i] = {w,h,prio,pref,seg}; anchors[i] = {x,y,hide}; stage {w,h}; insets; out[i] = {x,y,ok,vis,dir}
function layoutLabels(rects, anchors, stage, insets, out, order) {
  var n = rects.length; out = out || []; order = order || [];
  insets = insets || {};
  var T = num(insets.top, 0), B = num(insets.bottom, 0), Lf = num(insets.left, 0), Rt = num(insets.right, 0), card = insets.card;
  var W = stage.w, H = stage.h, i, j;
  order.length = n;
  for (i = 0; i < n; i++) { order[i] = i; if (!out[i]) out[i] = { x:0, y:0, ok:false, vis:false, dir:'n' }; }
  // insertion sort by prio (low = first)
  for (i = 1; i < n; i++) { var k = order[i], pk = rects[k].prio; j = i - 1; while (j >= 0 && rects[order[j]].prio > pk) { order[j + 1] = order[j]; j--; } order[j + 1] = k; }
  var placed = 0, ob = insets.obs, oi, r, a, o;
  // candidate test: stage bounds, info card, (optionally) vessel-core obstacles, already-placed chips
  function fits(x, y, useObs) {
    if (x < Lf + 2 || y < T + 2 || x + r.w > W - Rt - 2 || y + r.h > H - B - 2) return false;
    if (card && x < card.x + card.w && x + r.w > card.x && y < card.y + card.h && y + r.h > card.y) return false;
    if (useObs && ob) for (var oq = 0; oq < ob.length; oq++) { var bo = ob[oq]; if (bo.on && x < bo.x1 && x + r.w > bo.x0 && y < bo.y1 && y + r.h > bo.y0) return false; }
    return !hitsPlaced(x, y);
  }
  function hitsPlaced(x, y) {
    for (var q = 0; q < oi; q++) {
      var pi = order[q], po = out[pi]; if (!po.ok) continue;
      var pr2 = rects[pi];
      if (x < po.x + pr2.w + 3 && x + r.w + 3 > po.x && y < po.y + pr2.h + 3 && y + r.h + 3 > po.y) return true;
    }
    return false;
  }
  function take(x, y, dn) { o.x = x; o.y = y; o.ok = true; o.vis = true; o.dir = dn; placed++; return true; }
  function rings(radii, useObs, start) {
    for (var ring = 0; ring < radii.length; ring++) {
      var rad = radii[ring];
      for (var c = 0; c < 8; c++) {
        var dn = DIR_ORDER[(start + c) % 8], dv = DIRS[dn];
        var x = a.x + dv[0] * rad - (dv[0] < -0.1 ? r.w : (dv[0] > 0.1 ? 0 : r.w / 2));
        var y = a.y + dv[1] * rad - (dv[1] < -0.1 ? r.h : (dv[1] > 0.1 ? 0 : r.h / 2));
        if (fits(x, y, useObs)) return take(x, y, dn);
      }
    }
    return false;
  }
  // dock: scan the free bottom / top band (nearer one first), starting at the anchor's x; a leader line joins it to the anchor
  function dock(useObs) {
    var yb = H - B - 2 - r.h, yt = T + 2, bands = Math.abs(a.y - yb) <= Math.abs(a.y - yt) ? [yb, yt] : [yt, yb], step = 12, maxK = Math.ceil(W / step);
    for (var bi = 0; bi < 2; bi++) {
      var y = bands[bi], x0 = clamp(a.x - r.w / 2, Lf + 2, W - Rt - 2 - r.w);
      for (var k = 0; k <= maxK; k++) {
        var dx = (k & 1 ? 1 : -1) * Math.ceil(k / 2) * step, x = x0 + dx;
        if (x < Lf + 2 || x + r.w > W - Rt - 2) continue;
        if (fits(x, y, useObs)) return take(x, y, y === yb ? 's' : 'n');
      }
    }
    return false;
  }
  for (oi = 0; oi < n; oi++) {
    i = order[oi]; r = rects[i]; a = anchors[i]; o = out[i];
    o.ok = false; o.vis = false;
    if (!a || a.hide) continue;
    var start = DIR_ORDER.indexOf(r.pref); if (start < 0) start = 0;
    if (r.seg) { rings([28, 44], true, start); continue; }
    // equipment chips: near rings → far rings → docked band → rings allowed over vessel silhouettes
    if (rings([28, 44, 64, 92], true, start) || rings([124, 164, 210], true, start) || dock(true) ||
        rings([28, 44, 64, 92, 124], false, start) || dock(false)) continue;
    // last resort: faded at the preferred side, but never drawn over another chip or the info card
    var dp = DIRS[r.pref] || DIRS.n;
    o.x = clamp(a.x + dp[0] * 28 - (dp[0] < -0.1 ? r.w : (dp[0] > 0.1 ? 0 : r.w / 2)), 2, Math.max(2, W - r.w - 2));
    o.y = clamp(a.y + dp[1] * 28 - (dp[1] < -0.1 ? r.h : (dp[1] > 0.1 ? 0 : r.h / 2)), 2, Math.max(2, H - r.h - 2));
    o.vis = !(card && o.x < card.x + card.w && o.x + r.w > card.x && o.y < card.y + card.h && o.y + r.h > card.y) && !hitsPlaced(o.x, o.y);
    o.dir = r.pref;
  }
  return out;
}

// ── sample steady state (calcWTS defaults after H8; spec Appendix A) ────
var SAMPLE_SEGS = [
  { id:'wh_esd', from:'wellhead', to:'esd', label:'WH→ESD', phase:'multi', nps:'4', sch:'40', ID:4.026, L:50, vel:7.985, ve:26.57, vPct:30.06, vSt:'OK', dP:0.245, P0:3000, Pout:2999.75, T0:180, Tout:179.999, hydR:false },
  { id:'esd_choke', from:'esd', to:'choke', label:'ESD→Choke', phase:'multi', nps:'4', sch:'40', ID:4.026, L:100, vel:7.986, ve:26.57, vPct:30.06, vSt:'OK', dP:0.49, P0:2999.75, Pout:2999.26, T0:179.999, Tout:179.998, hydR:false },
  { id:'choke_heater', from:'choke', to:'heater', label:'Choke→Heater', phase:'multi', nps:'6', sch:'40', ID:6.065, L:200, vel:48.744, ve:98.88, vPct:49.29, vSt:'OK', dP:1.655, P0:157.66, Pout:156.01, T0:68.74, Tout:68.735, hydR:false },
  { id:'heater_sep', from:'heater', to:'separator', label:'Heater→Sep', phase:'multi', nps:'6', sch:'40', ID:6.065, L:100, vel:59.257, ve:109.03, vPct:54.35, vSt:'OK', dP:1.006, P0:151.01, Pout:150.0, T0:150.0, Tout:149.997, hydR:false },
  { id:'sep_flare', from:'separator', to:'flare', label:'Sep→Flare', phase:'gas', nps:'6', sch:'40', ID:6.065, L:300, vel:59.235, ve:143.84, vPct:41.18, vSt:'OK', dP:1.674, P0:150, Pout:148.33, T0:149.997, Tout:149.985, hydR:false },
  { id:'surge_gauge', from:'surge', to:'gauge', label:'Surge→Gauge Tank', phase:'liquid', nps:'3', sch:'40', ID:3.068, L:80, vel:1.519, ve:10, vPct:15.19, vSt:'OK', dP:0.115, P0:25, Pout:24.89, T0:149.997, Tout:149.997, hydR:false }
];
var LINE_NAMES = ['wh_esd','esd_choke','choke_heater','heater_sep','sep_flare','sep_water','sep_oil','surge_gauge','surge_vent','blanket','gauge_drain','gauge_vent','psv_sep','psv_surge'];
var NODE_NAMES = ['wellhead','esd','choke','heater','separator','flare','surge','gauge'];

// ── normalisation into a preallocated scratch object (§5.14) ────────────
function makeNorm() {
  var nd = function () { return { P:0, Pin:0, Pline:0, T:0, Tin:0, th:0, hyd:false, regime:'Critical', bean:32, flowLimited:false,
    QmaxMMscfd:0, dTjt:0, bypass:false, dutyMMBtuHr:0, firing:1, qMMscfd:0, flame:1 }; };
  var N = { t:0, running:true, flowSeq:0, alarmVersion:0, f:1, fInst:1, speed:10, clock:'00:00:00',
    inp:{ Pwh:3000, Twh:180, Qg:10, Qo:1000, Qw:200, SGg:0.65, API:35, bean:32, bypass:false, Psep:150 },
    esd:{ travel:1, open:true, moving:false, tripped:false, manual:false, causeMsg:'' },
    nodes:{}, segs:[], lines:{},
    sep:{ P:150, SP:150, SPeff:150, T:150, psh:165, pshh:180, psl:120, mawp:1440, xWeirFrac:0.75, hWeirFrac:0.55, lahhTotal:0.8,
          c1fracW:0.25, c1fracL:0.6, bfrac:0.32, bfracW:0, overWeir_bpd:0, carryOver:false, blowby:false,
          oil:{ x:0, cmd:0, q_bpd:0, lsll:0.08, lsl:0.20, lsh:0.45, lshh:0.52 }, wat:{ x:0, cmd:0, q_bpd:0, lsll:0.08, lsl:0.15, lsh:0.35, lshh:0.50 },
          gasIn_mmscfd:10, gasOut_mmscfd:10, liqIn_bpd:1200, tRes_min:0, pcvU:0.5, psvLifting:false },
    surge:{ P:25, SP:25, SPeff:25, T:150, psh:32, pshh:40, frac:0.55, fracW:0.15, cap_bbl:100, Vo_bbl:0, Vw_bbl:0, tFull_s:-1,
            flash_mscfd:0, pumpOn:false, pumpTripped:false, pumpFailed:false, pump_q:0, pump_design:0, lsll:0.05, lsl:0.25, lsh:0.7, lshh:0.9, psvLifting:false,
            comps:[{ frac:0.55, fracW:0.15, inlet:true, suction:true }, { frac:0.55, fracW:0.15, inlet:true, suction:true }],
            suction:'both', blocked:false, autoOn:false, pumpBlocked:false },
    gauge:{ active:0, tanks:[{ frac:0.3, fracW:0.06, cap_bbl:100, state:'filling', Vo_bbl:0, Vw_bbl:0, Vo_stb:0, drain_bpd:0, fill_bpd:0, inlet:true },
                              { frac:0, fracW:0, cap_bbl:100, state:'ready', Vo_bbl:0, Vw_bbl:0, Vo_stb:0, drain_bpd:0, fill_bpd:0, inlet:false }],
            nb:0, lastOil:-1, lastRate:-1, lastBsw:-1, lastTag:'', autoOn:false, blocked:false },
    rates:{ gas_mmscfd:0, oil_stbd:0, water_bpd:0, gor:-1, bsw:-1 },
    cum:{ flare_mmscf:0, oilIn_stb:0, gasIn_mmscf:0 },
    alarms:[], hasState:false
  };
  for (var i = 0; i < NODE_NAMES.length; i++) N.nodes[NODE_NAMES[i]] = nd();
  for (var s = 0; s < 6; s++) N.segs.push({ nps:'4', vel:0, ve:1, vPct:0, vSt:'OK', P0:0, Pout:0, T0:0, Tout:0, hydR:false, flowing:false, dP:0, label:'' });
  for (var l = 0; l < LINE_NAMES.length; l++) N.lines[LINE_NAMES[l]] = { q:0, vel:0, frac:0, active:false, tank:0 };
  return N;
}
var EMPTY_ARR = [];
function nb(v, d) { return v === true || v === false ? v : d; }
function nstr(v, d) { return typeof v === 'string' ? v : d; }
function normalize(state, out) {
  var N = out || makeNorm(), S = (state && typeof state === 'object') ? state : {};
  N.hasState = !!(state && typeof state === 'object' && state.sep);
  N.t = num(S.t, 0); N.running = S.running !== false; N.flowSeq = num(S.flowSeq, 0); N.alarmVersion = num(S.alarmVersion, 0);
  N.f = num(S.f, 1); N.fInst = num(S.fInst, N.f); N.speed = num(S.speed, 10); N.clock = nstr(S.clock, '00:00:00');
  var I = S.inputs || {}, ip = N.inp;
  ip.Pwh = num(I.Pwh, 3000); ip.Twh = num(I.Twh, 180); ip.Qg = num(I.Qg, 10); ip.Qo = num(I.Qo, 1000); ip.Qw = num(I.Qw, 200);
  ip.SGg = num(I.SGg, 0.65); ip.API = num((S.fluid && S.fluid.API), num(I.API, 35)); ip.bean = num(I.bean, 32); ip.bypass = !!I.bypass; ip.Psep = num(I.Psep, 150);
  var E = S.esd || {}, e = N.esd;
  e.travel = clamp(num(E.travel, 1), 0, 1); e.open = nb(E.open, e.travel > 0.99); e.moving = !!E.moving; e.tripped = !!E.tripped; e.manual = !!E.manual;
  e.causeMsg = nstr(E.causeMsg, '');
  var ND = S.nodes || {}, i, k;
  for (i = 0; i < NODE_NAMES.length; i++) {
    k = NODE_NAMES[i]; var src = ND[k] || {}, d = N.nodes[k];
    var sampleP = [3000, 2999.75, 157.66, 151.01, 150, 5, 25, 0][i], sampleT = [180, 180, 68.74, 150, 150, 150, 150, 150][i];
    d.P = num(src.P, sampleP); d.T = num(src.T, sampleT); d.th = num(src.th, 40); d.hyd = !!src.hyd;
    d.Pin = num(src.Pin, k === 'choke' ? 2999.26 : d.P); d.Tin = num(src.Tin, k === 'heater' ? 68.74 : d.T);
    d.regime = nstr(src.regime, 'Critical'); d.bean = num(src.bean, ip.bean); d.flowLimited = !!src.flowLimited;
    d.QmaxMMscfd = num(src.QmaxMMscfd, 10.7); d.dTjt = num(src.dTjt, 0); d.bypass = nb(src.bypass, ip.bypass);
    d.dutyMMBtuHr = num(src.dutyMMBtuHr, 2.1); d.firing = clamp(num(src.firing, 1), 0, 1.5);
    d.qMMscfd = num(src.qMMscfd, ip.Qg); d.flame = num(src.flame, 1); d.Pline = num(src.Pline, 148.33);
  }
  var SG = S.segs || EMPTY_ARR;
  for (i = 0; i < 6; i++) {
    var ss = SG[i] || {}, ds = N.segs[i], sm = SAMPLE_SEGS[i];
    ds.nps = ss.nps != null ? String(ss.nps) : sm.nps; ds.vel = Math.max(0, num(ss.vel, SG.length ? 0 : sm.vel)); ds.ve = Math.max(num(ss.ve, sm.ve), 1e-6);
    ds.vPct = num(ss.vPct, ds.vel / ds.ve * 100); ds.vSt = nstr(ss.vSt, 'OK'); ds.P0 = num(ss.P0, sm.P0); ds.Pout = num(ss.Pout, sm.Pout);
    ds.T0 = num(ss.T0, sm.T0); ds.Tout = num(ss.Tout, sm.Tout); ds.hydR = !!ss.hydR; ds.flowing = nb(ss.flowing, ds.vel > 0.01);
    ds.dP = num(ss.dP, sm.dP); ds.label = nstr(ss.label, sm.label);
  }
  var LN = S.lines || {};
  for (i = 0; i < LINE_NAMES.length; i++) {
    k = LINE_NAMES[i]; var ls = LN[k] || {}, dl = N.lines[k];
    dl.q = Math.max(0, num(ls.q, 0)); dl.vel = Math.max(0, num(ls.vel, 0)); dl.frac = num(ls.frac, 0); dl.active = !!ls.active; dl.tank = num(ls.tank, 0) ? 1 : 0;
  }
  if (!state || !S.lines) {       // null/partial snapshot: steady defaults (tracers alive in the harness)
    for (i = 0; i < 4; i++) { var L0 = N.lines[LINE_NAMES[i]]; L0.vel = SAMPLE_SEGS[i].vel; L0.active = true; L0.q = ip.Qg; L0.frac = 1; }
    N.lines.sep_flare.vel = SAMPLE_SEGS[4].vel; N.lines.sep_flare.active = true; N.lines.sep_flare.q = ip.Qg;
    if (!SG.length) { N.segs[5].vel = 0; }
  }
  var SP = S.sep || {}, sp = N.sep, C1 = SP.c1 || {}, BK = SP.bucket || {}, OD = SP.oilDump || {}, WD = SP.waterDump || {};
  sp.P = num(SP.P, N.nodes.separator.P); sp.SP = num(SP.SP, ip.Psep); sp.SPeff = num(SP.SPeff, sp.SP); sp.T = num(SP.T, N.nodes.separator.T);
  sp.psh = num(SP.psh, sp.SPeff + Math.max(0.1 * sp.SPeff, 15)); sp.pshh = Math.max(num(SP.pshh, sp.SPeff + Math.max(0.2 * sp.SPeff, 25)), 1);
  sp.psl = num(SP.psl, sp.SPeff - Math.max(0.2 * sp.SPeff, 20)); sp.mawp = num(SP.mawp, 1440);
  sp.xWeirFrac = clamp(num(SP.xWeirFrac, 0.75), 0.3, 0.95); sp.hWeirFrac = clamp(num(SP.hWeirFrac, 0.55), 0.2, 0.9); sp.lahhTotal = num(SP.lahhTotal, 0.8);
  sp.c1fracW = clamp(num(C1.fracW, 0.25), 0, 1); sp.c1fracL = clamp(num(C1.fracL, 0.6), 0, 1);
  sp.bfrac = clamp(num(BK.frac, 0.32), 0, 1); sp.bfracW = clamp(num(BK.fracW, 0), 0, 1);
  sp.overWeir_bpd = Math.max(0, num(SP.overWeir_bpd, state ? 0 : ip.Qo)); sp.carryOver = !!SP.carryOver; sp.blowby = !!SP.blowby;
  sp.oil.x = clamp(num(OD.x, 0), 0, 1); sp.oil.cmd = num(OD.cmd, 0); sp.oil.q_bpd = num(OD.q_bpd, 0);
  sp.oil.lsll = num(OD.lsll, 0.08); sp.oil.lsl = num(OD.lsl, 0.2); sp.oil.lsh = num(OD.lsh, 0.45); sp.oil.lshh = num(OD.lshh, 0.52);
  sp.wat.x = clamp(num(WD.x, 0), 0, 1); sp.wat.cmd = num(WD.cmd, 0); sp.wat.q_bpd = num(WD.q_bpd, 0);
  sp.wat.lsll = num(WD.lsll, 0.08); sp.wat.lsl = num(WD.lsl, 0.15); sp.wat.lsh = num(WD.lsh, 0.35); sp.wat.lshh = num(WD.lshh, 0.5);
  sp.gasIn_mmscfd = num(SP.gasIn_mmscfd, ip.Qg); sp.gasOut_mmscfd = num(SP.gasOut_mmscfd, ip.Qg); sp.liqIn_bpd = num(SP.liqIn_bpd, ip.Qo + ip.Qw);
  sp.tRes_min = num(SP.tRes_min, 0); sp.pcvU = num(SP.pcv && SP.pcv.u, 0.5); sp.psvLifting = !!(SP.psv && SP.psv.lifting);
  var SU = S.surge || {}, su = N.surge, PU = SU.pump || {};
  su.P = num(SU.P, N.nodes.surge.P); su.SP = num(SU.SP, 25); su.SPeff = num(SU.SPeff, su.SP); su.T = num(SU.T, 150);
  su.psh = num(SU.psh, 32); su.pshh = num(SU.pshh, 40); su.frac = clamp(num(SU.frac, 0.55), 0, 1); su.fracW = clamp(num(SU.fracW, 0.15), 0, 1);
  su.cap_bbl = Math.max(num(SU.cap_bbl, 100), 1); su.Vo_bbl = num(SU.Vo_bbl, 0); su.Vw_bbl = num(SU.Vw_bbl, 0);
  su.tFull_s = SU.tFull_s == null ? -1 : num(SU.tFull_s, -1); su.flash_mscfd = num(SU.flash_mscfd, 0);
  su.pumpOn = !!PU.on; su.pumpTripped = !!PU.tripped; su.pumpFailed = !!PU.failed; su.pump_q = num(PU.q_bpd, 0); su.pump_design = Math.max(num(PU.design_bpd, 1), 1);
  su.lsll = num(SU.lsll, 0.05); su.lsl = num(SU.lsl, 0.25); su.lsh = num(SU.lsh, 0.7); su.lshh = num(SU.lshh, 0.9); su.psvLifting = !!(SU.psv && SU.psv.lifting);
  var CP = SU.comps || EMPTY_ARR;                // twin compartments A | B (older snapshots: both = the tank level)
  for (i = 0; i < 2; i++) {
    var cs = CP[i] || {}, dc = su.comps[i];
    dc.frac = clamp(num(cs.frac, su.frac), 0, 1); dc.fracW = clamp(num(cs.fracW, su.fracW), 0, 1); dc.inlet = nb(cs.inlet, true); dc.suction = nb(cs.suction, true);
  }
  su.suction = nstr(SU.suction, 'both'); su.blocked = !!SU.blocked; su.autoOn = !!(SU.auto && SU.auto.on); su.pumpBlocked = !!PU.blocked;
  var GA = S.gauge || {}, ga = N.gauge, TK = GA.tanks || EMPTY_ARR;
  ga.active = num(GA.active, 0) ? 1 : 0;
  for (i = 0; i < 2; i++) {
    var ts = TK[i] || {}, dt = ga.tanks[i];
    dt.frac = clamp(num(ts.frac, i ? 0 : 0.3), 0, 1.05); dt.fracW = clamp(num(ts.fracW, i ? 0 : 0.06), 0, 1.05); dt.cap_bbl = Math.max(num(ts.cap_bbl, 100), 1);
    dt.state = nstr(ts.state, i ? 'ready' : 'filling'); dt.Vo_bbl = num(ts.Vo_bbl, dt.cap_bbl * (dt.frac - dt.fracW)); dt.Vw_bbl = num(ts.Vw_bbl, dt.cap_bbl * dt.fracW);
    dt.Vo_stb = num(ts.Vo_stb, dt.Vo_bbl); dt.drain_bpd = num(ts.drain_bpd, 0); dt.fill_bpd = num(ts.fill_bpd, 0); dt.inlet = nb(ts.inlet, i === ga.active);
  }
  ga.autoOn = !!(GA.auto && GA.auto.on); ga.blocked = !!GA.blocked;
  var BT = GA.batches || EMPTY_ARR, lb = BT.length ? BT[BT.length - 1] : null;
  ga.nb = BT.length; ga.lastOil = lb ? num(lb.oil_stb, -1) : -1; ga.lastRate = lb ? num(lb.oilRate_stbd, -1) : -1;
  ga.lastBsw = lb && lb.bsw_pct != null ? num(lb.bsw_pct, -1) : -1; ga.lastTag = lb ? nstr(lb.tag, '') : '';
  var RT = S.rates || {}, rt = N.rates;
  rt.gas_mmscfd = num(RT.gas_mmscfd, ip.Qg); rt.oil_stbd = num(RT.oil_stbd, ip.Qo); rt.water_bpd = num(RT.water_bpd, ip.Qw);
  rt.gor = RT.gor_scf_stb == null ? -1 : num(RT.gor_scf_stb, -1); rt.bsw = RT.bsw_pct == null ? -1 : num(RT.bsw_pct, -1);
  var CU = S.cum || {}; N.cum.flare_mmscf = num(CU.flare_mmscf, 0); N.cum.oilIn_stb = num(CU.oilIn_stb, 0); N.cum.gasIn_mmscf = num(CU.gasIn_mmscf, 0);
  N.alarms = Array.isArray(S.alarms) ? S.alarms : EMPTY_ARR;
  if (!state) { N.nodes.flare.qMMscfd = ip.Qg || 10; }
  return N;
}

// ── fake, schema-valid snapshot (dev harness + tests) ───────────────────
function fmtClockLocal(t) {
  t = Math.max(0, Math.floor(num(t, 0))); var h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  var p = function (x) { return x < 10 ? '0' + x : '' + x; };
  if (h >= 100) return Math.floor(h / 24) + 'd ' + p(h % 24) + ':' + p(m) + ':' + p(s);
  return p(h) + ':' + p(m) + ':' + p(s);
}
function saw(t, period, upFrac) {    // 0→1 over upFrac·period, back to 0 over the rest; returns {v, up}
  var ph = ((t % period) + period) % period / period;
  return ph < upFrac ? { v:ph / upFrac, up:true } : { v:1 - (ph - upFrac) / (1 - upFrac), up:false };
}
function fakeSnapshot(t, o) {
  t = num(t, 0); o = o || {};
  var esdMode = o.esd || 'open', tE = num(o.tEsd, 0), dtE = Math.max(0, t - tE);
  var travel = esdMode === 'open' ? (o.tReset != null ? clamp((t - o.tReset) / 15, 0, 1) : 1) : clamp(1 - dtE / 5, 0, 1);
  var fE = clamp(travel / 0.25, 0, 1);
  var f = o.flowFrac != null ? num(o.flowFrac, 1) : fE;
  var nz = function (a, b) { return Math.sin(t / a) * 0.6 + Math.sin(t / b + 1.3) * 0.4; };
  var API = num(o.API, 35), bypass = !!o.bypass, bean = num(o.bean, 32);
  var Pwh = esdMode === 'open' ? 3000 * (1 + 0.0015 * nz(37, 91)) : 3600 - (3600 - 3000) / (1 + dtE / 300);
  var Psep = 150 + 3.2 * nz(13, 29) * f;
  var fi = f * (1 + 0.01 * nz(7, 17));
  var Pco = Psep + (157.66 - 150) * fi * fi, Pci = f > 0.01 ? Pwh - (3000 - 2999.26) * fi * fi : Psep;
  var bucket = saw(t, 124, 0.75), iface = saw(t + 300, 1260, 0.75);
  var bfrac = f > 0.01 ? 0.20 + 0.25 * bucket.v : 0.22;
  var c1W = 0.15 + 0.2 * iface.v, c1L = 0.55 + 0.012 * f + 0.004 * Math.sin(t / 9);
  var surgeCyc = saw(t + 650, 1500, 0.66), surgeFrac = 0.25 + 0.45 * surgeCyc.v, pumpOn = !surgeCyc.up && f > 0.01;
  var cyc = 7200, ph = ((t % cyc) + cyc) % cyc, active = Math.floor(t / cyc) % 2;
  var fillFrac = 0.3 + 0.6 * ph / cyc;
  var otherFrac = ph < 900 ? 0.9 : (ph < 2400 ? 0.9 - 0.88 * (ph - 900) / 1500 : 0.02);
  var otherState = ph < 600 ? 'settling' : (ph < 2400 ? 'draining' : 'ready');
  var qPump = pumpOn ? 3753 : 0, A6 = Math.PI / 4 * Math.pow(3.068 / 12, 2);
  var vPump = qPump * 5.614583 / 86400 / A6;
  var qOil = f > 0.01 && !bucket.up ? 3000 : 0, qWat = f > 0.01 && !iface.up ? 900 : 0;
  var vLiq = function (q) { return q * 5.614583 / 86400 / A6; };
  var drainQ = otherState === 'draining' ? 3000 : 0;
  var segs = SAMPLE_SEGS.map(function (s, i) {
    var c = JSON.parse(JSON.stringify(s)); var k = i < 4 ? fi : i === 4 ? f : 1;
    c.vel = i === 5 ? vPump : s.vel * k; c.vPct = c.vel / c.ve * 100; c.vSt = c.vPct > 100 ? 'EXCEED' : c.vPct > 80 ? 'WARNING' : 'OK';
    c.dP = s.dP * k * k; c.flowing = c.vel > 0.01;
    if (i === 0) { c.P0 = Pwh; c.Pout = Pwh - c.dP; } if (i === 1) { c.P0 = Pwh - SAMPLE_SEGS[0].dP; c.Pout = Pci; }
    if (i === 2) { c.P0 = Pco; c.Pout = Pco - c.dP; } if (i === 3) { c.P0 = Psep + 1.01 * fi; c.Pout = Psep; }
    if (i === 4) { c.P0 = Psep; c.Pout = Psep - c.dP; }
    if (i === 2 && bypass) { c.T0 = 58; c.Tout = 58; c.hydR = true; }
    c.nps = o.nps && o.nps[i] ? String(o.nps[i]) : s.nps;
    return c;
  });
  var line = function (q, unit, frac, vel, ID, phase, active, tank) { var L = { q:q, unit:unit, frac:frac, vel:vel, ID_in:ID, phase:phase, active:active }; if (tank != null) L.tank = tank; return L; };
  var Qg = 10 * f, gasFlare = 10 * f * (1 + 0.01 * nz(5, 11));
  var alarms = [], cause = null, causeMsg = '', tripT = null;
  if (esdMode === 'tripped') { cause = 'PSHH_SEP'; causeMsg = 'ESD tripped — PSHH-101 separator 188 psig ≥ 180'; tripT = tE;
    alarms.push({ id:'ESD_TRIPPED', tag:'SDV-101', sev:'trip', eq:'esd', msg:causeMsg, value:188, limit:180, since:tE }); }
  if (esdMode === 'manual') { cause = 'ESD_MANUAL'; causeMsg = 'Closed manually at T+' + fmtClockLocal(tE); tripT = tE;
    alarms.push({ id:'ESD_MANUAL', tag:'SDV-101', sev:'info', eq:'esd', msg:'ESD closed manually at T+' + fmtClockLocal(tE), value:null, limit:null, since:tE }); }
  if (o.alarms) for (var ai = 0; ai < o.alarms.length; ai++) alarms.push(o.alarms[ai]);
  var tank = function (i) {
    var isAct = i === active, fr = isAct ? fillFrac : otherFrac, st = isAct ? 'filling' : otherState;
    return { tag:i ? 'T-301B' : 'T-301A', D:8, H:11.17, cap_bbl:100, h:fr * 11.17, frac:fr, hW:fr * 0.2 * 11.17, fracW:fr * 0.2,
      Vo_bbl:fr * 80, Vo_stb:fr * 78.6, Vw_bbl:fr * 20, T:120, state:st, stateSince:0, inlet:isAct, drain_bpd:st === 'draining' ? 3000 : 0,
      switchFrac:0.9, lahh:0.97, fill_bpd:isAct ? qPump : 0, valveTag:i ? 'XV-301B' : 'XV-301A' };
  };
  var st = {
    v:1, t:t, clock:fmtClockLocal(t), speed:10, running:o.running !== false, mode:'steady',
    flowSeq:num(o.flowSeq, 1), flowTs:0, geomVersion:1, alarmVersion:alarms.length + (esdMode === 'open' ? 0 : 1),
    f:f, fInst:fi,
    inputs:{ Pwh:3000, Twh:bypass ? 120 : 180, Qg:10, Qo:1000, Qw:200, SGg:0.65, API:API, bean:bean, Cd:0.85, bypass:bypass, Psep:150, Thtr:150 },
    fluid:{ API:API, SGo:141.5 / (API + 131.5), SGg:0.65 },
    esd:{ tag:'SDV-101', travel:travel, open:travel > 0.999, moving:travel > 0.001 && travel < 0.999, tripped:esdMode !== 'open', manual:esdMode === 'manual',
          cause:cause, causeMsg:causeMsg, tripT:tripT, canReset:esdMode === 'manual', blocking:[] },
    nodes:{
      wellhead:{ tag:'WH-101', P:Pwh, T:180, th:75.14, hyd:false },
      esd:{ tag:'SDV-101', P:f > 0.01 ? Pwh - 0.25 * fi * fi : Pwh * 0.5 + Psep * 0.5, T:180, th:75.14, hyd:false },
      choke:{ tag:'CK-101', P:Pco, Pin:Pci, T:bypass ? 58 : 68.74, th:36.59, hyd:bypass, regime:f < 0.01 ? 'No Flow' : 'Critical', bean:bean, flowLimited:false, QmaxMMscfd:10.71, dTjt:f < 0.01 ? 0 : 111.3 },
      heater:{ tag:'H-101', P:Psep + 1.01 * fi * fi, T:bypass ? 58 : 150, Tin:bypass ? 58 : 68.74, th:36.06, hyd:bypass, bypass:bypass, dutyMMBtuHr:bypass ? 0 : 2.103 * f, firing:bypass ? 0 : clamp(f, 0, 1) },
      separator:{ tag:'V-101', P:Psep, T:bypass ? 60 : 149.997, th:35.98, hyd:false },
      flare:{ tag:'FS-401', P:5, Pline:Psep - 1.674 * f * f, T:149.99, qMMscfd:gasFlare, flame:clamp(Math.sqrt(gasFlare / 10), 0, 1.5) },
      surge:{ tag:'T-201', P:25 + 0.8 * nz(19, 43), T:149.997 },
      gauge:{ tag:'T-301', P:0, T:120 }
    },
    segs:segs,
    lines:{
      wh_esd:line(Qg, 'MMSCFD', f, segs[0].vel, 4.026, 'multi', f > 0.001),
      esd_choke:line(Qg, 'MMSCFD', f, segs[1].vel, 4.026, 'multi', f > 0.001),
      choke_heater:line(Qg, 'MMSCFD', f, segs[2].vel, 6.065, 'multi', f > 0.001),
      heater_sep:line(Qg, 'MMSCFD', f, segs[3].vel, 6.065, 'multi', f > 0.001),
      sep_flare:line(gasFlare, 'MMSCFD', f, segs[4].vel, 6.065, 'gas', gasFlare > 1e-6),
      sep_water:line(qWat, 'BPD', qWat / 900, vLiq(qWat), 3.068, 'water', qWat > 0),
      sep_oil:line(qOil, 'BPD', qOil / 3000, vLiq(qOil), 3.068, 'oil', qOil > 0),
      surge_gauge:line(qPump, 'BPD', qPump / 3753, vPump, 3.068, 'liquid', qPump > 0, active),
      surge_vent:line(0.018 * f, 'MMSCFD', f, 3.9 * f, 2.067, 'gas', f > 0.01),
      blanket:line(pumpOn ? 0.02 : 0, 'MMSCFD', pumpOn ? 1 : 0, pumpOn ? 3.5 : 0, 1.049, 'gas', pumpOn),
      gauge_drain:line(drainQ, 'BPD', drainQ ? 1 : 0, vLiq(drainQ), 3.068, 'liquid', drainQ > 0, active ? 0 : 1),
      gauge_vent:line(0.004 * (pumpOn ? 1 : 0), 'MMSCFD', 0, 0, 0, 'gas', pumpOn),
      psv_sep:line(0, 'MMSCFD', 0, 0, 2.067, 'gas', false),
      psv_surge:line(0, 'MMSCFD', 0, 0, 1.049, 'gas', false)
    },
    sep:{ tag:'V-101', D:3, R:1.5, Lss:10, xWeir:7.5, hWeir:1.65, xWeirFrac:0.75, hWeirFrac:0.55, headDepth:0.75, vol_bbl:13.85,
      P:Psep, SP:150, SPeff:150, T:149.997, psh:165, pshh:180, psl:120, mawp:1440, lahhTotal:0.8,
      pcv:{ tag:'PCV-101', u:0.5 + 0.05 * nz(3, 7), Cv:135 }, psv:{ tag:'PSV-101', lifting:false },
      c1:{ hW:c1W * 3, hL:c1L * 3, fracW:c1W, fracL:c1L, Vw_bbl:2.1, Vo_bbl:3.6, Vo_stb:3.4 },
      bucket:{ hW:0, h:bfrac * 3, fracW:0, frac:bfrac, Vw_bbl:0, Vo_bbl:1.4, Vo_stb:1.33 },
      overWeir_bpd:f > 0.01 ? 1000 * f * (1 + 0.05 * nz(3, 5)) : 0, weirHead_in:f > 0.01 ? 0.8 : 0, carryOver:false, blowby:false, gasVol_ft3:40,
      oilDump:{ tag:'LCV-102', mode:'snap', cmd:bucket.up ? 0 : 1, x:bucket.up ? 0 : 1, q_bpd:qOil, Cv:10.1, lsll:0.08, lsl:0.2, lsh:0.45, lshh:0.52 },
      waterDump:{ tag:'LCV-101', mode:'snap', cmd:iface.up ? 0 : 1, x:iface.up ? 0 : 1, q_bpd:qWat, Cv:3, lsll:0.08, lsl:0.15, lsh:0.35, lshh:0.5 },
      gasIn_mmscfd:Qg, gasOut_mmscfd:gasFlare, liqIn_bpd:1200 * f, tRes_min:f > 0.01 ? 9.4 : 9999 },
    surge:{ tag:'T-201', D:6, H:19.86, cap_bbl:100, P:25 + 0.8 * nz(19, 43), SP:25, SPeff:25, T:149.997, psh:32, pshh:40, mawp:50,
      h:surgeFrac * 19.86, frac:surgeFrac, hW:surgeFrac * 0.17 * 19.86, fracW:surgeFrac * 0.17, Vo_bbl:surgeFrac * 83, Vo_stb:surgeFrac * 79, Vw_bbl:surgeFrac * 17,
      flash_mscfd:18 * f, tFull_s:surgeCyc.up ? 1500 * 0.66 * (1 - surgeCyc.v) : null,
      bpv:{ tag:'PCV-201', u:0.5 }, blanket:{ tag:'PCV-202', u:pumpOn ? 0.4 : 0 }, psv:{ tag:'PSV-201', lifting:false },
      pump:{ tag:'P-201', on:pumpOn, tripped:false, failed:false, blocked:false, q_bpd:qPump, design_bpd:3753, suction:'both' }, lsll:0.05, lsl:0.25, lsh:0.7, lshh:0.9,
      comps:[0, 1].map(function (i) { return { tag:i ? 'T-201B' : 'T-201A', valveTag:i ? 'XV-201B' : 'XV-201A', cap_bbl:50, h:surgeFrac * 19.86, frac:surgeFrac,
        hW:surgeFrac * 0.17 * 19.86, fracW:surgeFrac * 0.17, Vo_bbl:surgeFrac * 41.5, Vo_stb:surgeFrac * 39.5, Vw_bbl:surgeFrac * 8.5, inlet:true, suction:true,
        fill_bpd:(qOil + qWat) / 2, draw_bpd:qPump / 2 }; }),
      suction:'both', blocked:false, auto:{ on:false, sp:0.8, hyst:0.1 } },
    gauge:{ tag:'T-301', active:active, count:2, tanks:[tank(0), tank(1)], blocked:false, auto:{ on:false, sp:0.9, hyst:0.1 },
      batches:t > cyc ? [{ n:1, tag:'T-301A', tOpen:0, tClose:cyc * 0.9, hours:1.8, openOil_stb:20, closeOil_stb:90, oil_stb:70.8, water_bbl:17.6,
        gov_bbl:88.4, bsw_pct:19.9, oilRate_stbd:944, waterRate_bpd:235, gas_mscf:750, gor_scf_stb:10593, avgT:122 }] : [] },
    cum:{ oilIn_stb:t * 1000 / 86400, waterIn_bbl:t * 200 / 86400, gasIn_mmscf:t * 10 / 86400, flare_mmscf:t * 10 / 86400, flash_mscf:t * 18 / 86400,
      gaugeFlash_mscf:t * 4 / 86400, gaugeVent_mscf:t * 4 / 86400, vacBreak_scf:0, gaugeOil_stb:t * 950 / 86400, gaugeWater_bbl:t * 200 / 86400,
      drainedOil_stb:0, drainedWater_bbl:0, liquidToFlareOil_stb:0, liquidToFlareWater_bbl:0, spillOil_stb:0, spillWater_bbl:0 },
    rates:{ gas_mmscfd:gasFlare, oil_stbd:1000 * f, water_bpd:200 * f, oilMeter_stbd:1000 * f, waterMeter_bpd:200 * f,
      gor_scf_stb:f > 0.01 ? 10000 : null, bsw_pct:f > 0.01 ? 16.7 : null, tank_stbd:t > cyc ? 944 : null, shrink_pct:t > 600 ? 1.8 : null },
    alarms:alarms,
    alarmLog:[{ t:0, id:'RESET', type:'reset', sev:null, tag:'', msg:'Reset to steady' }],
    faults:{ pcvStuckClosed:false, pcvStuckOpen:false, oilDumpStuckOpen:false, oilDumpStuckClosed:false, waterDumpStuckClosed:false, surgePumpFail:false, slugging:false },
    health:{ substeps:1, lagging:false, droppedSimSec:0, massErr:{ oil:0, water:0, gas:0 }, flowInvalid:false }
  };
  return st;
}

// ═════════════════════════════════════════════════════════════════════════
// §C LOADER (§5.17, normative)
// ═════════════════════════════════════════════════════════════════════════
var WTS_3d = {};       // filled in §G; referenced by the loader for THREE_URLS / THREE_SHA384
var _supported = null;
function isSupported() {
  if (_supported !== null) return _supported;
  var ok = false;
  try {
    var doc = G.document;
    if (doc && typeof doc.createElement === 'function') {
      var c = doc.createElement('canvas');
      var gl = c && typeof c.getContext === 'function' ? c.getContext('webgl2') : null;
      ok = !!(gl && typeof gl.getParameter === 'function' && typeof gl.createShader === 'function' && typeof gl.createVertexArray === 'function');
      try { var le = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context'); if (le && le.loseContext) le.loseContext(); } catch (e2) {}
    }
  } catch (e) { ok = false; }
  _supported = ok;
  return ok;
}

var _imp = null, _attempt = 0, _hashNoted = false;
function _dynImport(u) {
  if (!_imp) { try { _imp = new Function('u', 'return imp' + 'ort(u);'); }            // no literal import-call in this file
               catch (e) { var er = new Error('csp'); er.code = 'csp'; throw er; } }
  return _imp(u);
}
function _withTimeout(p, ms) { return new Promise(function (res, rej) {
  var t = setTimeout(function () { var e = new Error('timeout'); e.code = 'timeout'; rej(e); }, ms);
  p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); }); }); }
function _visibleBudget(p, ms, code) {      // rejects after `ms` of visible time (ticks every 250 ms)
  return new Promise(function (res, rej) { var used = 0, done = false, iv = setInterval(function () {
      var vis = !G.document || G.document.visibilityState === 'visible'; if (vis) used += 250;
      if (used >= ms && !done) { done = true; clearInterval(iv); var e = new Error(code); e.code = code; rej(e); } }, 250);
    p.then(function (v) { if (!done) { done = true; clearInterval(iv); res(v); } },
           function (e) { if (!done) { done = true; clearInterval(iv); rej(e); } }); }); }
var IDB = { db:'h2oil-wts3d', store:'mod', key:'three@0.170.0' };
function _idbOpen() { return new Promise(function (res) { try { if (!G.indexedDB) return res(null);
  var rq = G.indexedDB.open(IDB.db, 1);
  rq.onupgradeneeded = function () { rq.result.createObjectStore(IDB.store); };
  rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { res(null); }; } catch (e) { res(null); } }); }
function _idbGet() { return _idbOpen().then(function (db) { return new Promise(function (res) { if (!db) return res(null);
  try { var g = db.transaction(IDB.store, 'readonly').objectStore(IDB.store).get(IDB.key);
        g.onsuccess = function () { db.close(); res(g.result || null); }; g.onerror = function () { db.close(); res(null); }; }
  catch (e) { db.close(); res(null); } }); }); }
function _idbPut(buf) { _idbOpen().then(function (db) { if (!db) return;
  try { var tx = db.transaction(IDB.store, 'readwrite'); tx.objectStore(IDB.store).put(buf, IDB.key);
        tx.oncomplete = tx.onerror = function () { db.close(); }; } catch (e) { db.close(); } }); }   // best effort
function _b64(ab) { var s = '', b = new Uint8Array(ab); for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return G.btoa(s); }
function _verify(buf) { var h = WTS_3d.THREE_SHA384;
  if (!h || !(G.crypto && G.crypto.subtle)) {
    if (!h && !_hashNoted) { _hashNoted = true; try { console.info('[WTS_3d] THREE_SHA384 not pinned: integrity check skipped'); } catch (e) {} }
    return Promise.resolve(true); }
  return G.crypto.subtle.digest('SHA-384', buf).then(function (d) { return _b64(d) === h; }); }
function _importBytes(buf) { var url = URL.createObjectURL(new Blob([buf], { type:'text/javascript' }));
  return _dynImport(url).then(function (m) { URL.revokeObjectURL(url); return m; },
                              function (e) { URL.revokeObjectURL(url); throw e; }); }
function _fetchBytes(u) { var ac = G.AbortController ? new AbortController() : null;
  var t = setTimeout(function () { if (ac) ac.abort(); }, 8000);
  return _withTimeout(fetch(u, { mode:'cors', cache:'force-cache', signal:ac ? ac.signal : undefined }), 8000)
    .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
    .then(function (b) { clearTimeout(t); return b; }, function (e) { clearTimeout(t); throw e; }); }
function _ok(m) { return !!(m && m.WebGLRenderer && m.PMREMGenerator && m.WebGLRenderTarget); }
function loadThree() {
  if (G.__WTS3D_THREE) return G.__WTS3D_THREE;
  var n = ++_attempt;
  var p = _visibleBudget((async function () {
    var last = null, badHash = false;
    var canBlob = typeof fetch === 'function' && G.Blob && G.URL && typeof URL.createObjectURL === 'function';
    var urls = (G.WTS3D_LOCAL_URL ? [G.WTS3D_LOCAL_URL] : []).concat(WTS_3d.THREE_URLS);
    if (canBlob) {
      var cached = await _idbGet();
      if (cached && await _verify(cached)) {
        try { var m0 = await _importBytes(cached); if (_ok(m0)) return m0; } catch (e) { if (e && e.code === 'csp') throw e; last = e; } }
      for (var i = 0; i < urls.length; i++) {
        try { var buf = await _fetchBytes(urls[i]);
              if (!(await _verify(buf))) { badHash = true; continue; }
              var m = await _importBytes(buf);
              if (_ok(m)) { _idbPut(buf); return m; } }
        catch (e) { if (e && e.code === 'csp') throw e; last = e; } } }
    // Plain import: only when integrity cannot be enforced anyway (no hash pinned, or no fetch/blob support).
    if (!WTS_3d.THREE_SHA384 || !canBlob) {
      for (var j = 0; j < urls.length; j++) {
        try { var m2 = await _withTimeout(_dynImport(urls[j] + (urls[j].indexOf('?') < 0 ? '?r=' : '&r=') + n), 8000);
              if (_ok(m2)) return m2; } catch (e) { if (e && e.code === 'csp') throw e; last = e; } } }
    var err = new Error(badHash ? 'three-integrity-failed' : 'three-load-failed');
    err.code = badHash ? 'integrity' : 'offline'; err.cause = last; throw err;
  })(), 20000, 'offline');
  G.__WTS3D_THREE = p; p.catch(function () { if (G.__WTS3D_THREE === p) G.__WTS3D_THREE = null; });
  return p;
}
function hasLocalCopy() { if (G.WTS3D_LOCAL_URL) return Promise.resolve(true);
  return _idbGet().then(function (b) { return !!b; }, function () { return false; }); }

function now() { try { if (G.performance && typeof G.performance.now === 'function') return G.performance.now(); } catch (e) {} return Date.now(); }
function nextFrame() { return new Promise(function (res) {
  var done = false, fin = function () { if (!done) { done = true; res(); } };
  try { if (typeof G.requestAnimationFrame === 'function') G.requestAnimationFrame(fin); } catch (e) {}
  setTimeout(fin, 50); }); }
function mkErr(code, msg, cause) { var e = new Error(msg || code); e.code = code; if (cause) e.cause = cause; return e; }

// ═════════════════════════════════════════════════════════════════════════
// §D FACTORY(THREE) — geometry utils, procedural textures, materials
// ═════════════════════════════════════════════════════════════════════════
var _factoryCache = null;
function factory(THREE) {
  if (_factoryCache && _factoryCache.THREE === THREE) return _factoryCache;
  var V3 = THREE.Vector3;

  function C(hex) { return new THREE.Color(hex); }
  function CL(r, g, b) { return new THREE.Color().setRGB(r, g, b); }   // linear HDR triplet (env softboxes)

  // ── FilletArc: a 90° fillet as a THREE.Curve (defined after THREE loads) ──
  class FilletArc extends THREE.Curve {
    constructor(pr) { super(); this.pr = pr; }
    getPoint(t, target) {
      var pr = this.pr, a = t * pr.ang, ca = Math.cos(a), sa = Math.sin(a); target = target || new V3();
      return target.set(pr.c[0] + pr.R * (pr.u[0] * ca + pr.v[0] * sa), pr.c[1] + pr.R * (pr.u[1] * ca + pr.v[1] * sa), pr.c[2] + pr.R * (pr.u[2] * ca + pr.v[2] * sa));
    }
  }
  class PolyCurve extends THREE.Curve {          // arbitrary sampled polyline (coil serpentine)
    constructor(pts) { super(); this.pts = pts; var L = [0]; for (var i = 1; i < pts.length; i++) L.push(L[i - 1] + pts[i].distanceTo(pts[i - 1])); this.L = L; this.tot = L[L.length - 1]; }
    getPoint(t, target) {
      target = target || new V3(); var s = t * this.tot, L = this.L, i = 1;
      while (i < L.length - 1 && L[i] < s) i++;
      var f = (s - L[i - 1]) / Math.max(L[i] - L[i - 1], 1e-9); return target.copy(this.pts[i - 1]).lerp(this.pts[i], clamp(f, 0, 1));
    }
  }

  // ── merge (position/normal/uv [+color, aSeg, aS]) into one BufferGeometry ──
  function mergeGeos(list, opts) {
    opts = opts || {};
    var geos = [], i;
    for (i = 0; i < list.length; i++) { var g = list[i]; if (!g) continue; var ng = g.index ? g.toNonIndexed() : g; if (ng !== g) g.dispose(); geos.push(ng); }
    var names = ['position', 'normal', 'uv'];
    if (opts.color) names.push('color');
    if (opts.seg) { names.push('aSeg'); names.push('aS'); }
    var total = 0; for (i = 0; i < geos.length; i++) total += geos[i].attributes.position.count;
    var out = new THREE.BufferGeometry();
    names.forEach(function (nm) {
      var isz = nm === 'uv' ? 2 : (nm === 'aSeg' || nm === 'aS') ? 1 : 3, arr = new Float32Array(total * isz), off = 0;
      for (var k = 0; k < geos.length; k++) {
        var a = geos[k].attributes[nm], cnt = geos[k].attributes.position.count;
        if (a) arr.set(a.array.subarray(0, cnt * isz), off); else if (nm === 'color') arr.fill(1, off, off + cnt * isz);
        off += cnt * isz;
      }
      out.setAttribute(nm, new THREE.BufferAttribute(arr, isz));
    });
    for (i = 0; i < geos.length; i++) geos[i].dispose();
    out.computeBoundingSphere(); out.computeBoundingBox();
    return out;
  }
  var _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new V3(1, 1, 1), _p = new V3();
  function place(g, x, y, z, rx, ry, rz, sx, sy, sz) {
    _e.set(rx || 0, ry || 0, rz || 0); _q.setFromEuler(_e); _p.set(x || 0, y || 0, z || 0); _s.set(sx || 1, sy || 1, sz || 1);
    _m4.compose(_p, _q, _s); g.applyMatrix4(_m4); return g;
  }
  function colorize(g, hex) {
    var n = g.attributes.position.count, arr = new Float32Array(n * 3), c = C(hex);
    for (var i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3)); return g;
  }
  // cylinder between two points
  function cylAB(a, b, r, seg, open, r2) {
    var A = new V3(a[0], a[1], a[2]), B = new V3(b[0], b[1], b[2]), d = new V3().subVectors(B, A), L = d.length();
    var g = new THREE.CylinderGeometry(r2 != null ? r2 : r, r, L, seg || 12, 1, !!open);
    _q.setFromUnitVectors(new V3(0, 1, 0), d.normalize()); _p.copy(A).add(B).multiplyScalar(0.5); _s.set(1, 1, 1);
    _m4.compose(_p, _q, _s); g.applyMatrix4(_m4); return g;
  }
  function boxAt(w, h, d, x, y, z, rx, ry, rz) { return place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz); }

  // ── canvas helpers ────────────────────────────────────────────────────
  function canvas(w, h) { var c = G.document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function texFrom(cv, color) {
    var t = new THREE.CanvasTexture(cv); t.colorSpace = color === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.anisotropy = 4; t.needsUpdate = true; return t;
  }
  function glowTexture() {
    var c = canvas(128, 128), x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,0.55)'); g.addColorStop(0.45, 'rgba(255,255,255,0.14)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128); return texFrom(c);
  }
  function blobTexture() {
    var c = canvas(64, 64), x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64); return texFrom(c);
  }
  // tileable ripple normal map: sums of integer-frequency sines, finite-difference normals
  function rippleNormalTexture() {
    var N = 256, c = canvas(N, N), x = c.getContext('2d'), img = x.createImageData(N, N), H = new Float32Array(N * N), i, j;
    var W = [[3, 1, 0.5, 0.3], [1, 4, 0.35, 1.7], [5, 2, 0.25, 2.2], [2, 7, 0.18, 0.9], [7, 5, 0.12, 4.1], [9, 3, 0.08, 5.3]];
    for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
      var u = i / N * Math.PI * 2, v = j / N * Math.PI * 2, h = 0;
      for (var k = 0; k < W.length; k++) h += W[k][2] * Math.sin(W[k][0] * u + W[k][1] * v + W[k][3]);
      H[j * N + i] = h;
    }
    for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
      var dx = H[j * N + ((i + 1) % N)] - H[j * N + ((i - 1 + N) % N)], dy = H[((j + 1) % N) * N + i] - H[((j - 1 + N) % N) * N + i];
      var nx = -dx * 2.2, ny = -dy * 2.2, nz = 1, l = Math.sqrt(nx * nx + ny * ny + nz * nz), o = (j * N + i) * 4;
      img.data[o] = (nx / l * 0.5 + 0.5) * 255; img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[o + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    var t = texFrom(c, false); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  function hatchTexture(cells, lw) {        // grating / mist-pad alpha (white = keep)
    var c = canvas(128, 128), x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 128, 128);
    x.strokeStyle = '#fff'; x.lineWidth = lw; var s = 128 / cells;
    for (var i = 0; i <= cells; i++) { x.beginPath(); x.moveTo(i * s, 0); x.lineTo(i * s, 128); x.stroke(); x.beginPath(); x.moveTo(0, i * s); x.lineTo(128, i * s); x.stroke(); }
    var t = texFrom(c, false); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  function plateTexture() {                 // diamond-plate roughness variation for skids
    var c = canvas(64, 64), x = c.getContext('2d'); x.fillStyle = '#9a9a9a'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#4a4a4a';
    for (var j = 0; j < 8; j++) for (var i = 0; i < 8; i++) { x.save(); x.translate(i * 8 + 4 + (j % 2) * 4, j * 8 + 4); x.rotate(((i + j) % 2 ? 1 : -1) * 0.7); x.fillRect(-3, -0.8, 6, 1.6); x.restore(); }
    var t = texFrom(c, false); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 4); return t;
  }
  function panelTexture() {
    var c = canvas(128, 176), x = c.getContext('2d');
    x.fillStyle = '#b8891a'; x.fillRect(0, 0, 128, 176); x.fillStyle = '#1b1f24'; x.fillRect(8, 8, 112, 160);
    x.fillStyle = '#f2c230'; x.font = '700 30px system-ui, sans-serif'; x.textAlign = 'center'; x.fillText('ESD', 64, 44);
    var L = ['#3fb950', '#d29922', '#f85149']; for (var i = 0; i < 3; i++) { x.fillStyle = L[i]; x.beginPath(); x.arc(32 + i * 32, 70, 9, 0, 7); x.fill(); }
    x.fillStyle = '#8b949e'; x.font = '600 11px system-ui, sans-serif'; x.fillText('SDV-101', 64, 160);
    return texFrom(c);
  }
  function stripeTexture() {
    var c = canvas(64, 64), x = c.getContext('2d'); x.fillStyle = '#8a8a8a'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#b4b4b4';
    for (var i = 0; i < 64; i += 8) x.fillRect(i, 0, 3, 64);
    var t = texFrom(c, false); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 1); return t;
  }
  // Dial atlas: 4 faces (256×256) → [0 wellhead/choke-in, 1 low pressure (choke out, V-101, gas line), 2 surge, 3 temperature]
  function drawDial(x, ox, rangeTxt, max, unit, major, minor, redFrom) {
    var cx = ox + 128, cy = 128;
    var g = x.createRadialGradient(cx, cy - 20, 10, cx, cy, 124); g.addColorStop(0, '#f4f6f8'); g.addColorStop(1, '#cfd6de');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, 122, 0, 7); x.fill();
    x.strokeStyle = '#1b1f24'; x.lineWidth = 6; x.beginPath(); x.arc(cx, cy, 122, 0, 7); x.stroke();
    var a0 = -225 * Math.PI / 180, span = 270 * Math.PI / 180;
    if (redFrom != null && redFrom < max) { x.strokeStyle = '#d6453d'; x.lineWidth = 10; x.beginPath(); x.arc(cx, cy, 98, a0 + span * redFrom / max, a0 + span); x.stroke(); }
    x.strokeStyle = '#1b1f24';
    var nMin = Math.round(max / minor);
    for (var i = 0; i <= nMin; i++) {
      var v = i * minor, a = a0 + span * v / max, isM = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      x.lineWidth = isM ? 4 : 1.5; var r0 = isM ? 88 : 96;
      x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * 106, cy + Math.sin(a) * 106); x.stroke();
      if (isM) { x.fillStyle = '#1b1f24'; x.font = '600 19px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
        var lv = v >= 1000 ? (v / 1000) + 'k' : String(Math.round(v * 100) / 100); x.fillText(lv, cx + Math.cos(a) * 68, cy + Math.sin(a) * 68); }
    }
    x.fillStyle = '#39414b'; x.font = '700 20px system-ui, sans-serif'; x.textAlign = 'center'; x.fillText(unit, cx, cy + 58);
    x.font = '500 13px system-ui, sans-serif'; x.fillText(rangeTxt, cx, cy + 80);
  }
  function niceStep(max) { var m = [1, 2, 2.5, 5, 10], p = Math.pow(10, Math.floor(Math.log10(max / 6))); for (var i = 0; i < m.length; i++) if (max / (m[i] * p) <= 7) return m[i] * p; return 10 * p; }
  function dialAtlas(ranges, units) {
    var c = canvas(1024, 256), x = c.getContext('2d'); x.clearRect(0, 0, 1024, 256);
    for (var f = 0; f < 4; f++) {
      var R = ranges[f], maj = niceStep(R.max);
      drawDial(x, f * 256, R.tag, R.max, R.unit, maj, maj / 5, R.red);
    }
    return texFrom(c);
  }
  function gaugeBoard(capBbl, units, tag) {
    var c = canvas(128, 1024), x = c.getContext('2d');
    x.fillStyle = '#e8ecef'; x.fillRect(0, 0, 128, 1024); x.fillStyle = '#20252b'; x.fillRect(0, 0, 128, 40);
    x.fillStyle = '#f0883e'; x.font = '700 22px system-ui, sans-serif'; x.textAlign = 'center'; x.fillText(tag, 64, 28);
    var metric = units && units.system === 'metric' && typeof units.conv === 'function';
    var top = 48, bot = 1016, H = bot - top, cap = Math.max(capBbl, 1);
    x.strokeStyle = '#20252b'; x.fillStyle = '#20252b'; x.textAlign = 'right'; x.textBaseline = 'middle';
    if (!metric) {
      var tick = cap <= 60 ? 1 : 5, lab = cap <= 60 ? 10 : 25;
      for (var v = 0; v <= cap + 1e-9; v += tick) {
        var y = bot - H * v / cap, isL = Math.abs(v / lab - Math.round(v / lab)) < 1e-6;
        x.lineWidth = isL ? 3 : 1.5; x.beginPath(); x.moveTo(128, y); x.lineTo(isL ? 70 : 98, y); x.stroke();
        if (isL) { x.font = '700 24px system-ui, sans-serif'; x.fillText(String(v), 64, y); }
      }
      x.save(); x.translate(18, 540); x.rotate(-Math.PI / 2); x.textAlign = 'center'; x.font = '600 18px system-ui, sans-serif'; x.fillText('bbl', 0, 0); x.restore();
    } else {
      var one = units.conv(1, 'volume'), unit = one && one.unit || 'm³', capM = one ? cap * one.value : cap * 0.159;
      var step = capM <= 6 ? 0.5 : capM <= 12 ? 1 : 2, labS = step * 2;
      for (var m = 0; m <= capM + 1e-9; m += step) {
        var y2 = bot - H * m / capM, isL2 = Math.abs(m / labS - Math.round(m / labS)) < 1e-6;
        x.lineWidth = isL2 ? 3 : 1.5; x.beginPath(); x.moveTo(128, y2); x.lineTo(isL2 ? 70 : 98, y2); x.stroke();
        if (isL2) { x.font = '700 24px system-ui, sans-serif'; x.fillText(String(Math.round(m * 10) / 10), 64, y2); }
      }
      x.save(); x.translate(18, 540); x.rotate(-Math.PI / 2); x.textAlign = 'center'; x.font = '600 18px system-ui, sans-serif'; x.fillText(unit, 0, 0); x.restore();
    }
    return texFrom(c);
  }

  // ── colour-space-correct linear colours for shader uniforms ─────────
  function lin(hex) { return C(hex); }

  // ── material factories ────────────────────────────────────────────────
  function std(hex, metal, rough, extra) {
    var m = new THREE.MeshStandardMaterial(Object.assign({ color:C(hex), metalness:metal, roughness:rough }, extra || {}));
    return m;
  }
  // §5.6 premultiplied Fresnel glass (premultiply AFTER tone mapping + sRGB encode)
  function makeGlass(o) {
    var P = o.tier === 'high' ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    var m = new P({ color:0xcfe3ff, metalness:0, roughness:0.05, transparent:true, opacity:o.opacity, depthWrite:false,
      side:o.side, fog:false, envMap:o.envTex, envMapIntensity:o.envI != null ? o.envI : 1.6 });
    m.color = C('#cfe3ff');
    if (o.tier === 'high') { m.clearcoat = 1; m.clearcoatRoughness = 0.03; }
    m.blending = THREE.CustomBlending; m.premultipliedAlpha = false;
    m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    var U = { uRim:{ value:C('#c9d8e6') }, uRimMax:{ value:o.rimMax != null ? o.rimMax : 0.55 }, uRimPow:{ value:3.0 },
              uAlertCol:{ value:C('#f85149') }, uAlert:o.alert || { value:0 } };
    var seg = !!o.seg;
    if (seg) { U.uSegCol = o.seg.col; U.uSegAlert = o.seg.alert; U.uSegFrost = o.seg.frost; U.uSegPh = o.seg.ph; U.uPulse = o.seg.pulse; U.uChev = o.seg.chev; U.uWaveS = o.seg.wave; U.uSegColOld = o.seg.colOld; }
    m.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, U);
      if (seg) {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSeg; attribute float aS; varying float wSeg; varying float wS; varying vec3 wWP;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nwSeg = aSeg; wS = aS; wWP = (modelMatrix*vec4(position,1.0)).xyz;');
      }
      var pre = '#include <common>\nuniform vec3 uRim,uAlertCol;uniform float uRimMax,uRimPow,uAlert;';
      if (seg) pre += '\nvarying float wSeg; varying float wS; varying vec3 wWP; uniform vec3 uSegCol[14]; uniform vec3 uSegColOld[14]; uniform float uSegAlert[14]; uniform float uSegFrost[14]; uniform float uSegPh[14]; uniform float uPulse; uniform float uChev; uniform float uWaveS;' +
        '\nfloat wHash(vec3 p){ uvec3 q = uvec3(ivec3(floor(mod(p,256.0)))); uint h = q.x*1597334677u ^ q.y*3812015801u ^ q.z*2798796415u; h = (h ^ (h >> 16u))*2246822519u; return float(h >> 8u)/16777215.0; }';
      var body = '';
      if (seg) body = '\nint wi = int(wSeg+0.5); vec3 wSc = wS < uWaveS ? uSegCol[wi] : uSegColOld[wi];' +
        '\ndiffuseColor.rgb = mix(diffuseColor.rgb, wSc, 0.45);' +
        '\nfloat wFrost = uSegFrost[wi]*smoothstep(0.3,0.7,wHash(wWP*9.0));' +
        '\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72,0.86,1.0), wFrost); diffuseColor.a = max(diffuseColor.a, wFrost*0.75);' +
        '\nfloat wAl = uSegAlert[wi]; float wChev = uChev*smoothstep(0.85,1.0,fract(wS*1.5 - uSegPh[wi]));';
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', pre)
        .replace('#include <color_fragment>', '#include <color_fragment>' + body)
        .replace('#include <opaque_fragment>',
          '\nfloat wFr = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)),0.0,1.0), uRimPow);' +
          // vessel glass: damp the rim on downward-facing faces so the hull bottom does not read as a water layer
          (seg ? '' : '\nwFr *= mix(0.3, 1.0, smoothstep(-0.75, 0.0, normal.y));') +
          '\nfloat wAlert = uAlert' + (seg ? ' + (wAl > 1.5 ? (0.55+0.45*uPulse) : wAl*0.6)' : '') + ';' +
          '\nvec3 wAC = ' + (seg ? '(wAl > 0.5 && wAl < 1.5) ? vec3(0.824,0.6,0.133) : uAlertCol' : 'uAlertCol') + ';' +
          '\nfloat wA  = clamp(diffuseColor.a + wFr*uRimMax + wAlert*0.10, 0.0, 1.0);' +
          '\nvec3  wD  = totalDiffuse;' +
          '\nvec3  wS2 = (outgoingLight - totalDiffuse)*(0.7+0.3*wFr) + mix(uRim, wAC, clamp(wAlert,0.0,1.0))*wFr*0.45' + (seg ? ' + wSc*(0.10 + wFr*0.35) + wSc*wChev*0.8' : '') + ';' +
          '\noutgoingLight = wD + wS2;\ndiffuseColor.a = wA;\n#include <opaque_fragment>')
        .replace('#include <premultiplied_alpha_fragment>',
          '\n#ifdef TONE_MAPPING\n wD = toneMapping(wD); wS2 = toneMapping(wS2);\n#endif\n' +
          'gl_FragColor = vec4(linearToOutputTexel(vec4(wD,1.0)).rgb*wA + linearToOutputTexel(vec4(wS2,1.0)).rgb, wA);');
    };
    m.customProgramCacheKey = function () { return 'wtsGlass' + o.tier + (seg ? 'seg' : '') + (o.side === THREE.BackSide ? 'B' : 'F'); };
    return m;
  }

  // §5.7 phase-banded hull (front: depthWrite false; back: depthWrite true, a 0.96)
  function makeHull(o) {       // o: {tier, side, U (shared), glow, faceW, faceO}
    var m = new THREE.MeshStandardMaterial({ color:0xffffff, roughness:0.25, metalness:0, transparent:true, side:o.side,
      depthWrite:o.side === THREE.BackSide, envMap:o.envTex, envMapIntensity:0.6 });
    var S = { uGlow:{ value:o.glow }, uFaceA_w:{ value:o.faceW }, uFaceA_o:{ value:o.faceO } };
    m.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, o.U, S);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLoc;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLoc = position;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vLoc;' +
        '\nuniform vec2 uSecA, uSecB; uniform float uSplitX, uTilt, uRip, uEmul, uGlow, uFaceA_w, uFaceA_o; uniform vec2 uPh; uniform vec3 uWatCol, uOilCol, uEmCol;')
        .replace('#include <color_fragment>', '#include <color_fragment>' +
        '\nvec2  wSec = vLoc.x < uSplitX ? uSecA : uSecB;' +
        '\nfloat wRip = (sin(vLoc.x*7.0 + uPh.x) + sin(vLoc.z*9.0 - uPh.y)) * 0.004 * uRip;' +
        '\nfloat wLq  = wSec.y + vLoc.x*uTilt + wRip;' +
        '\nif (vLoc.y > wLq || wSec.y <= 0.002) discard;' +
        '\nfloat wWt  = wSec.x < 0.0 ? -1.0 : wSec.x + wRip*0.3 + vLoc.x*uTilt*0.6;' +
        '\nfloat wT   = smoothstep(wWt-uEmul, wWt+uEmul, vLoc.y);' +
        '\nvec3  wC   = mix(uWatCol, uOilCol, wT);' +
        '\nwC  = mix(wC, uEmCol, (1.0-abs(wT*2.0-1.0)) * 0.55);' +
        '\nwC *= mix(1.0, 0.78, clamp((wLq-vLoc.y)/max(wLq,0.05),0.0,1.0));' +
        '\nfloat wTop = smoothstep(wLq-0.025, wLq, vLoc.y);' +
        '\nfloat wIf  = wSec.x < 0.0 ? 0.0 : 1.0 - smoothstep(0.0, max(0.014, fwidth(vLoc.y)*1.8), abs(vLoc.y - wWt));' +
        '\nfloat wIh  = wSec.x < 0.0 ? 0.0 : 1.0 - smoothstep(0.0, 0.07, abs(vLoc.y - wWt));' +
        '\nwC += 0.25 * wTop;' +
        '\ndiffuseColor.rgb = wC;' +
        '\ndiffuseColor.a = mix(uFaceA_w, uFaceA_o, wT);')
        // downward-facing liquid faces (the water band of a horizontal vessel) would otherwise mirror the sky env at grazing
        // angles and wash the water out to a pale rim, even where there is no water — damp that reflection
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>' +
        '\nreflectedLight.indirectSpecular *= mix(0.12, 1.0, smoothstep(-0.55, 0.25, normal.y));')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' +
        '\ntotalEmissiveRadiance += wC*uGlow + wC*0.6*wTop + mix(uWatCol, vec3(1.0), 0.55)*2.4*wIf + mix(uWatCol, uOilCol, 0.5)*0.35*wIh + uWatCol*0.9*(1.0-wT);');
    };
    m.customProgramCacheKey = function () { return 'wtsHull' + o.tier + (o.side === THREE.BackSide ? 'B' : 'F'); };
    return m;
  }
  function hullUniforms() {
    return { uSecA:{ value:new THREE.Vector2(-1, 0.5) }, uSecB:{ value:new THREE.Vector2(-1, 0.5) }, uSplitX:{ value:99 }, uTilt:{ value:0 },
      uPh:{ value:new THREE.Vector2() }, uRip:{ value:1 }, uEmul:{ value:0.03 }, uWatCol:{ value:C(PALETTE.waterBody) },
      uOilCol:{ value:C('#8a5a1c') }, uEmCol:{ value:C('#a8803f') } };
  }
  // liquid surface caps (depthWrite:false; meniscus rim via aEdge)
  function makeCap(o) {        // o: {tier, envTex, normal}
    var high = o.tier === 'high', P = high ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    var m = new P({ color:C('#c08030'), roughness:0.08, metalness:0, transparent:true, opacity:0.9, depthWrite:false,
      side:THREE.DoubleSide, envMap:o.envTex, envMapIntensity:0.7 });
    if (o.normal && o.tier !== 'low') { m.normalMap = o.normal; m.normalScale = new THREE.Vector2(0.3, 0.3); }
    if (high) { m.clearcoat = 1; m.clearcoatRoughness = 0.04; if (o.normal2) { m.clearcoatNormalMap = o.normal2; m.clearcoatNormalScale = new THREE.Vector2(0.25, 0.25); } }
    var U = { uSurf:{ value:C('#e0a040') }, uCapGlow:{ value:0.6 }, uDrops:{ value:[] }, uDropN:{ value:0 } };
    for (var i = 0; i < 8; i++) U.uDrops.value.push(new THREE.Vector4(0, 0, 99, 0));
    m.userData.U = U;
    m.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aEdge; varying float vEdge; varying vec3 vCapL;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge; vCapL = position;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vEdge; varying vec3 vCapL; uniform vec3 uSurf; uniform float uCapGlow; uniform vec4 uDrops[8];')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uSurf*uCapGlow + uSurf*0.5*smoothstep(0.92,1.0,vEdge);' +
          (high ? '\nfloat wDr = 0.0; for(int i=0;i<8;i++){ vec4 d = uDrops[i]; if(d.z > 3.0) continue; float dd = length(vCapL.xz - d.xy); wDr += sin(18.0*dd - 10.0*d.z)*exp(-3.0*d.z)*d.w/(1.0+8.0*dd); }\ntotalEmissiveRadiance += uSurf*max(wDr,0.0)*0.9;' : ''));
    };
    m.customProgramCacheKey = function () { return 'wtsCap' + o.tier; };
    return m;
  }
  // points (tracers, particles, embers)
  function makePoints(uScale, uDpr, additive, maxPx, minPx) {
    var mx = (maxPx || 28).toFixed(1), mn = (minPx == null ? 2.5 : minPx).toFixed(1);
    return new THREE.ShaderMaterial({
      uniforms:{ uScale:uScale, uDpr:uDpr },
      vertexShader:'attribute vec4 aColor; attribute float aSize; uniform float uScale, uDpr; varying vec4 vCol;\n' +
        'void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv;\n' +
        '  gl_PointSize = clamp(aSize*uScale/max(-mv.z,0.001), ' + mn + '*uDpr, ' + mx + '*uDpr); vCol = aColor; if(aColor.a < 0.003) gl_PointSize = 0.0; }',
      fragmentShader:'varying vec4 vCol;\nvoid main(){ float r = length(gl_PointCoord-0.5)*2.0; if(r>1.0) discard; float core = exp(-r*r*4.0);\n' +
        '  gl_FragColor = vec4(vCol.rgb*(0.6+1.4*core), vCol.a*core);\n  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n}',
      transparent:true, depthWrite:false, blending:additive === false ? THREE.NormalBlending : THREE.AdditiveBlending
    });
  }
  var FBM_GLSL =
    'uint wPcg(uint v){ uint s = v*747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }\n' +
    'float wH2(vec2 i){ uvec2 q = uvec2(mod(i,256.0)); return float(wPcg(q.x + wPcg(q.y))) / 4294967295.0; }\n' +
    'float wVn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);\n' +
    '  return mix(mix(wH2(i),wH2(i+vec2(1.0,0.0)),u.x), mix(wH2(i+vec2(0.0,1.0)),wH2(i+vec2(1.0,1.0)),u.x), u.y); }\n' +
    'float fbm(vec2 p){ float s=0.0, a=0.5, n=0.0; for(int k=0;k<OCT;k++){ s+=a*wVn(p); n+=a; p*=2.0; a*=0.5; } return s/n; }\n';
  function makeFlameMat(oct, seed, intensity) {
    return new THREE.ShaderMaterial({
      defines:{ OCT:oct },
      uniforms:{ uBase:{ value:new V3() }, uRight:{ value:new V3(1, 0, 0) }, uWind:{ value:new V3(1, 0, 0) }, uL:{ value:3 }, uW:{ value:1 },
                 uLean:{ value:0.3 }, uPh:{ value:0 }, uInt:{ value:intensity }, uScroll:{ value:0 }, uSeed:{ value:seed } },
      vertexShader:'uniform vec3 uBase, uRight, uWind; uniform float uL, uW, uLean, uPh; varying vec2 vUv;\n' +
        'void main(){ vUv = uv; float x = position.x; float h = position.y + 0.5;\n' +
        '  vec3 p = uBase + uRight*(x*uW*(0.55+0.45*sin(h*3.14159))) + vec3(0.0,1.0,0.0)*(h*uL) + uWind*(h*h*uLean*uL) + uRight*sin(uPh + h*3.0)*0.04*h*uL;\n' +
        '  gl_Position = projectionMatrix * viewMatrix * vec4(p,1.0); }',
      fragmentShader:'uniform float uInt, uScroll, uSeed; varying vec2 vUv;\n' + FBM_GLSL +
        'void main(){ float n = fbm(vec2(vUv.x*3.0+uSeed, vUv.y*2.5 - uScroll));\n' +
        '  float h = vUv.y;  float x = (vUv.x-0.5)*2.0 + (n-0.5)*0.9*h;\n' +
        '  float w = mix(0.35,1.0,smoothstep(0.0,0.25,h)) * (1.0-smoothstep(0.55,1.0,h+(n-0.5)*0.5));\n' +
        '  float m = smoothstep(w, w*0.2, abs(x)) * smoothstep(0.0,0.04,h);\n' +
        '  float heat = m*(1.0-h*0.75)*(0.75+0.5*n);\n' +
        '  vec3 c = mix(vec3(.55,.08,.02), vec3(1.,.45,.08), smoothstep(.1,.45,heat));\n' +
        '  c = mix(c, vec3(1.,.82,.45), smoothstep(.45,.75,heat));\n' +
        '  c = mix(c, vec3(1.,.97,.88), smoothstep(.75,1.,heat));\n' +
        '  c += vec3(.15,.3,1.)*(1.0-smoothstep(0.0,0.12,h))*m*0.8;\n' +
        '  gl_FragColor = vec4(c*uInt*1.7, heat);\n  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n}',
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, fog:false
    });
  }
  function makeSkyMat() {
    return new THREE.ShaderMaterial({
      uniforms:{ uZen:{ value:C(PALETTE.skyZenith) }, uHor:{ value:C(PALETTE.skyHorizon) }, uBelow:{ value:C(PALETTE.skyBelow) },
                 uWarm:{ value:C(PALETTE.warmGlow) }, uFlareI:{ value:1 }, uFlareDir:{ value:new THREE.Vector2(0.7, -0.7) } },
      vertexShader:'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }',
      fragmentShader:'uniform vec3 uZen,uHor,uBelow,uWarm; uniform float uFlareI; uniform vec2 uFlareDir; varying vec3 vDir;\n' +
        'void main(){ vec3 d = normalize(vDir); float y = d.y;\n' +
        '  vec3 c = y > 0.0 ? mix(uHor, uZen, pow(smoothstep(0.0,1.0,y),0.55)) : mix(uHor, uBelow, smoothstep(0.0,0.12,-y));\n' +
        '  c += uHor*0.6*(1.0-smoothstep(0.0,0.08,abs(y)));\n' +
        '  float lobe = pow(max(dot(normalize(d.xz+1e-5), uFlareDir),0.0),6.0)*(1.0-smoothstep(0.0,0.25,y))*step(-0.05,y)*uFlareI;\n' +
        '  c += uWarm*lobe*3.0;\n  gl_FragColor = vec4(c,1.0);\n  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n}',
      side:THREE.BackSide, depthTest:false, depthWrite:false, fog:false
    });
  }
  function patchGround(m, U) {
    m.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix*vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos; uniform vec3 uMinor, uMajor; uniform float uFitR, uPad; uniform vec2 uCenter;\n' +
        'float gridLine(vec2 p, float sp, float w){ vec2 c = abs(fract(p/sp-0.5)-0.5)*sp; vec2 fw = fwidth(p); vec2 l = 1.0 - smoothstep(w-fw, w+fw, c); return max(l.x,l.y); }')
        .replace('#include <color_fragment>', '#include <color_fragment>\nfloat wFade = 1.0 - smoothstep(0.6*uFitR, 1.6*uFitR, length(vWPos.xz - uCenter));\n' +
          'diffuseColor.rgb = mix(diffuseColor.rgb, uMinor, gridLine(vWPos.xz,1.0,0.015)*0.35*wFade*uPad);\nfloat wMj = gridLine(vWPos.xz,5.0,0.03)*wFade*uPad;\ndiffuseColor.rgb = mix(diffuseColor.rgb, uMajor, wMj*0.5);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uMajor*wMj*0.05;');
    };
    m.customProgramCacheKey = function () { return 'wtsGround' + (U.uPad.value > 0.5 ? 'P' : 'E'); };
    return m;
  }

  _factoryCache = { THREE:THREE, C:C, CL:CL, FilletArc:FilletArc, PolyCurve:PolyCurve, mergeGeos:mergeGeos, place:place, colorize:colorize,
    cylAB:cylAB, boxAt:boxAt, canvas:canvas, texFrom:texFrom, glowTexture:glowTexture, blobTexture:blobTexture,
    rippleNormalTexture:rippleNormalTexture, hatchTexture:hatchTexture, plateTexture:plateTexture, panelTexture:panelTexture,
    stripeTexture:stripeTexture, dialAtlas:dialAtlas, gaugeBoard:gaugeBoard, std:std, makeGlass:makeGlass, makeHull:makeHull,
    hullUniforms:hullUniforms, makeCap:makeCap, makePoints:makePoints, makeFlameMat:makeFlameMat, makeSkyMat:makeSkyMat,
    patchGround:patchGround, lin:lin, FBM_GLSL:FBM_GLSL };
  return _factoryCache;
}

// ═════════════════════════════════════════════════════════════════════════
// §E BUILDERS — buildScene(tier) is re-runnable for in-place tier changes (D42)
// ═════════════════════════════════════════════════════════════════════════
var WIND = v3norm([0.86, 0, 0.32]);
var FLAME_BASE = [19.5, 7.8, -4.5];
var CHAIN_DEF = [
  { id:'MULTI', entry:'E1', phase:'multi', edges:['E1','E2','E3','E3c','E4a','E4'] },
  { id:'G1', entry:'G1', phase:'gas', edges:['G1'] },
  { id:'VENT', entry:'VENT', phase:'gas', edges:['VENT'] },
  { id:'BLK', entry:'BLK', phase:'gas', edges:['BLK'] },
  { id:'LW', entry:'LW', phase:'water', edges:['LW','LM'] },
  { id:'LO', entry:'LO', phase:'oil', edges:['LO','LM'] },
  { id:'X', entry:'X1', phase:'liquid', edges:['X1','X2','XA'] },
  { id:'DR', entry:'DRA', phase:'liquid', edges:['DRA'] }
];

function buildScene(F, renderer, tier, env) {
  var THREE = F.THREE, T = TIERS[tier], V3 = THREE.Vector3, C = F.C;
  var scene = new THREE.Scene();
  var S = { tier:tier, T:T, scene:scene, textures:[], vessels:[], dyn:{}, proxies:null, lights:{}, disposeExtra:[] };
  function tex(t) { S.textures.push(t); return t; }
  var envTex = env.texture;
  scene.environment = envTex; scene.environmentIntensity = 0.9;
  scene.fog = new THREE.FogExp2(C(PALETTE.fog), 0.25 / 40);

  // ── materials ──────────────────────────────────────────────────────────
  var M = {
    steelDark:F.std(PALETTE.steelDark, 0.6, 0.55),
    steelSatin:F.std(PALETTE.steelSatin, 0.55, 0.38, { envMap:envTex, envMapIntensity:1.0 }),
    bolt:F.std(PALETTE.bolt, 0.7, 0.4),
    yellow:F.std(PALETTE.yellow, 0.1, 0.6),
    accent:F.std(PALETTE.accent, 0.2, 0.45),
    concrete:F.std('#3b4048', 0, 0.9),
    paintBlue:F.std(PALETTE.paintBlue, 0.3, 0.5),
    bands:new THREE.MeshStandardMaterial({ vertexColors:true, metalness:0.3, roughness:0.5 }),
    emissive:new THREE.MeshBasicMaterial({ vertexColors:true }),
    rubber:F.std(PALETTE.rubber, 0, 0.9),
    plate:F.std('#343b45', 0.7, 1.0, { roughnessMap:tex(F.plateTexture()) }),
    cabin:F.std('#1f2a38', 0.4, 1.0, { roughnessMap:tex(F.stripeTexture()) })
  };
  M.emissive.color = new THREE.Color(1.6, 1.6, 1.6);
  // frostable steel (downstream choke valve body + seg-2 fittings)
  var frostU = { uFrost:{ value:0 } };
  M.frost = F.std(PALETTE.steelSatin, 0.8, 0.35, { envMap:envTex, envMapIntensity:1.0 });
  M.frost.onBeforeCompile = function (sh) {
    Object.assign(sh.uniforms, frostU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFW;').replace('#include <project_vertex>', '#include <project_vertex>\nvFW = (modelMatrix*vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vFW; uniform float uFrost;\n' + F.FBM_GLSL.replace(/OCT/g, '3'))
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat wFm = uFrost*smoothstep(0.35,0.65,fbm(vFW.xz*6.0+vFW.y*3.0));\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72,0.86,1.0), wFm);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.9, wFm);');
  };
  M.frost.customProgramCacheKey = function () { return 'wtsFrost'; };
  S.frostU = frostU;
  // firetube (emissive by uFire, hotter toward the burner)
  var fireU = { uFire:{ value:1 } };
  M.fire = F.std('#3a3430', 0.5, 0.6);
  M.fire.onBeforeCompile = function (sh) {
    Object.assign(sh.uniforms, fireU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vHX;').replace('#include <project_vertex>', '#include <project_vertex>\nvHX = (modelMatrix*vec4(transformed,1.0)).x + 1.4;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vHX; uniform float uFire;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0,0.144,0.010)*2.2*uFire*(0.25+0.75*smoothstep(-1.6,1.7,vHX));');
  };
  M.fire.customProgramCacheKey = function () { return 'wtsFire'; };
  S.fireU = fireU;
  // process coil (flow pulse)
  var coilU = { uCoilPh:{ value:0 }, uRep:{ value:14 }, uCoilOn:{ value:1 } };
  M.coil = F.std('#8c7a66', 0.8, 0.35, { envMap:envTex, envMapIntensity:1.0 });
  M.coil.onBeforeCompile = function (sh) {
    Object.assign(sh.uniforms, coilU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vCu;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvCu = uv.x;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vCu; uniform float uCoilPh, uRep, uCoilOn;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.6,0.85,1.0)*1.2*uCoilOn*smoothstep(0.9,1.0,fract(vCu*uRep - uCoilPh));');
  };
  M.coil.customProgramCacheKey = function () { return 'wtsCoil'; };
  S.coilU = coilU;
  S.M = M;

  var B = {}; Object.keys(M).forEach(function (k) { B[k] = []; });
  function add(k, g) { B[k].push(g); return g; }
  var gl = tex(F.glowTexture());
  S.glowTex = gl;
  // glow / smoke billboards are batched into two Points objects (one draw each), flushed per frame
  S.glowItems = []; S.smokeItems = [];
  function glowItem(list, hex, size, x, y, z, op) { var it = { position:new V3(x, y, z), scale:new V3(size, size, 1), material:{ color:C(hex), opacity:op == null ? 1 : op }, visible:true, renderOrder:970 }; list.push(it); return it; }
  function sprite(hex, size, x, y, z, op) { return glowItem(S.glowItems, hex, size, x, y, z, op); }
  function smokeSprite(hex, size, x, y, z, op) { return glowItem(S.smokeItems, hex, size, x, y, z, op); }

  // ── sky, stars, fog ───────────────────────────────────────────────────
  var sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), F.makeSkyMat());
  sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky); S.sky = sky;
  var uScale = { value:800 }, uDpr = { value:1 }; S.uScale = uScale; S.uDpr = uDpr;
  if (T.stars) {
    var nS = 600, sp = new Float32Array(nS * 3), sc = new Float32Array(nS * 4), ss = new Float32Array(nS), sph = new Float32Array(nS);
    var rnd = mulberry(7);
    for (var i = 0; i < nS; i++) {
      var th = rnd() * Math.PI * 2, y = 0.08 + 0.92 * Math.pow(rnd(), 0.7), r = Math.sqrt(1 - y * y);
      sp[i * 3] = Math.cos(th) * r * 280; sp[i * 3 + 1] = y * 280; sp[i * 3 + 2] = Math.sin(th) * r * 280;
      var cc = C(rnd() < 0.2 ? '#ffe4c0' : '#cfdcff'), br = 0.35 + 0.65 * rnd() * rnd();
      sc[i * 4] = cc.r * br; sc[i * 4 + 1] = cc.g * br; sc[i * 4 + 2] = cc.b * br; sc[i * 4 + 3] = 0.8; ss[i] = 0.55 + rnd() * 0.5; sph[i] = rnd() * 6.283;
    }
    var sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    var sca = new THREE.BufferAttribute(sc, 4); sca.setUsage(THREE.DynamicDrawUsage); sg.setAttribute('aColor', sca); sg.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
    var sm = F.makePoints(uScale, uDpr); sm.depthTest = true; sm.fog = false;
    var stars = new THREE.Points(sg, sm); stars.frustumCulled = false; stars.renderOrder = 0; scene.add(stars);
    S.stars = { obj:stars, ph:sph, base:new Float32Array(sc), attr:sca };
  }

  // ── lights (final per-tier set; never toggled via visible, D42) ─────────
  var hemi = new THREE.HemisphereLight(C('#3a5270'), C('#0b0d10'), tier === 'low' ? 0.9 : 0.55); scene.add(hemi);
  var moon = new THREE.DirectionalLight(C('#9fb8ff'), 1.2); moon.position.set(-20, 30, 18); moon.target.position.set(2, 0, 0);
  scene.add(moon); scene.add(moon.target);
  if (T.shadow) {
    moon.castShadow = true; moon.shadow.mapSize.set(T.shadow, T.shadow); moon.shadow.bias = -0.0005; moon.shadow.normalBias = 0.02;
    fitShadow(THREE, moon);
  }
  var flareLight = new THREE.PointLight(C('#ff9a4a'), 0, 0, 2); flareLight.position.set(FLAME_BASE[0], FLAME_BASE[1] + 1.5, FLAME_BASE[2]); scene.add(flareLight);
  S.lights = { hemi:hemi, moon:moon, flare:flareLight, spots:[] };
  var TOWERS = [[-18.5, 0, 5.0, [-8, 0, 0]], [22.0, 0, 3.0, [12, 0, 3]]];
  if (T.spots) {
    TOWERS.forEach(function (tw) {
      var s = new THREE.SpotLight(C('#ffd9a0'), 900, 0, 0.55, 0.6, 2); s.position.set(tw[0], 8.3, tw[2]); s.target.position.set(tw[3][0], tw[3][1], tw[3][2]);
      scene.add(s); scene.add(s.target); S.lights.spots.push(s);
    });
  }
  renderer.shadowMap.enabled = !!T.shadow;
  renderer.shadowMap.type = tier === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;

  // ── ground ────────────────────────────────────────────────────────────
  var gU = { uMinor:{ value:C(PALETTE.gridMinor) }, uMajor:{ value:C(PALETTE.gridMajor) }, uFitR:{ value:40 }, uPad:{ value:1 }, uCenter:{ value:new THREE.Vector2(2, 0.5) } };
  var eU = { uMinor:gU.uMinor, uMajor:gU.uMajor, uFitR:gU.uFitR, uPad:{ value:0 }, uCenter:gU.uCenter };
  S.groundU = gU;
  var earth = new THREE.Mesh(new THREE.RingGeometry(1.4, 170, 64, 1).rotateX(-Math.PI / 2).translate(-15, -0.01, 0),
    F.patchGround(F.std(PALETTE.earth, 0, 0.95), eU));
  earth.receiveShadow = !!T.shadow; scene.add(earth);
  var padShape = new THREE.Shape(); padShape.moveTo(-20, 10); padShape.lineTo(24, 10); padShape.lineTo(24, -8.5); padShape.lineTo(-20, -8.5); padShape.lineTo(-20, 10);
  var hole = new THREE.Path(); hole.absarc(-15, 0, 1.4, 0, Math.PI * 2, true); padShape.holes.push(hole);
  var padGeo = new THREE.ExtrudeGeometry(padShape, { depth:0.04, bevelEnabled:false, curveSegments:32 }).rotateX(-Math.PI / 2).translate(0, -0.02, 0);
  var pad = new THREE.Mesh(padGeo, F.patchGround(F.std(PALETTE.pad, 0.05, 0.8), gU)); pad.receiveShadow = !!T.shadow; scene.add(pad);
  var cellar = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 1.5, 32, 1, true).translate(-15, -0.75, 0), F.std('#2a2e34', 0, 0.95, { side:THREE.BackSide }));
  scene.add(cellar);
  add('concrete', new THREE.CircleGeometry(1.4, 32).rotateX(-Math.PI / 2).translate(-15, -1.5, 0));

  // ── helpers for equipment ─────────────────────────────────────────────
  function flange(pos, dir, r) {                       // pair of flanges with a 2 mm gap; dir along the pipe
    var d = v3norm(dir), a = v3add(pos, v3scale(d, -0.031)), b = v3add(pos, v3scale(d, -0.001)), c = v3add(pos, v3scale(d, 0.001)), e = v3add(pos, v3scale(d, 0.031));
    add('steelSatin', F.cylAB(a, b, r * 1.55, 20)); add('steelSatin', F.cylAB(c, e, r * 1.55, 20));
    if (T.bolts) {
      var n1 = anyPerp(d), n2 = v3cross(d, n1);
      for (var k = 0; k < 8; k++) { var an = k / 8 * Math.PI * 2, o = v3add(pos, v3add(v3scale(n1, Math.cos(an) * r * 1.3), v3scale(n2, Math.sin(an) * r * 1.3)));
        add('bolt', F.cylAB(v3add(o, v3scale(d, -0.07)), v3add(o, v3scale(d, 0.07)), 0.02, 6)); }
    }
  }
  function wheel(R, r, x, y, z, rx, ry) { return F.place(new THREE.TorusGeometry(R, r, 8, 24), x, y, z, rx || 0, ry || 0, 0); }
  function wheelSpokes(R, x, y, z, horizontal) {
    var g = [];
    for (var k = 0; k < 2; k++) g.push(horizontal ? F.boxAt(R * 2, 0.018, 0.018, x, y, z, 0, k * Math.PI / 2, 0) : F.boxAt(R * 2, 0.018, 0.018, x, y, z, 0, 0, k * Math.PI / 2));
    return g;
  }
  function gateValve(x, y, z, axis, sz, bucketW, withWheel) {   // body + bonnet up + horizontal handwheel
    sz = sz || 0.34;
    add('steelSatin', F.boxAt(axis === 'x' ? sz * 0.9 : sz, sz, axis === 'x' ? sz : sz * 0.9, x, y, z));
    add('steelSatin', F.cylAB([x, y + sz / 2, z], [x, y + sz / 2 + 0.28, z], 0.07, 12));
    if (withWheel !== false) { add(bucketW || 'accent', wheel(0.15, 0.016, x, y + sz / 2 + 0.3, z, Math.PI / 2, 0)); wheelSpokes(0.15, x, y + sz / 2 + 0.3, z, true).forEach(function (g) { add(bucketW || 'accent', g); }); }
  }
  function mkMesh(geo, mat, cast) { var m = new THREE.Mesh(geo, mat); if (cast && T.shadow) m.castShadow = true; scene.add(m); return m; }

  // dials (static faces merged; needles instanced)
  var DIALS = [];
  function dial(x, y, z, face, key) { DIALS.push({ p:[x, y, z], face:face, key:key }); add('steelSatin', F.place(new THREE.TorusGeometry(0.13, 0.014, 6, 24), x, y, z, 0, -0.314, 0)); add('steelDark', F.place(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 20).rotateX(Math.PI / 2), x - 0.025 * Math.sin(-0.314), y, z - 0.025 * Math.cos(0.314), 0, -0.314, 0)); }

  // ═══ WH-101 christmas tree (−15,0,0) ═══════════════════════════════════
  (function () {
    var X = -15, fl = function (y) { add('steelSatin', F.cylAB([X, y - 0.03, 0], [X, y + 0.03, 0], 0.40, 24)); };
    add('steelDark', F.cylAB([X, -1.5, 0], [X, -1.10, 0], 0.30, 20));
    add('steelSatin', F.cylAB([X, -1.10, 0], [X, -0.62, 0], 0.32, 24)); fl(-0.62);
    add('steelSatin', F.cylAB([X, -0.62, 0], [X, -0.18, 0], 0.26, 24)); fl(-0.18);
    [-1, 1].forEach(function (s) { add('steelSatin', F.cylAB([X + s * 0.26, -0.4, 0], [X + s * 0.55, -0.4, 0], 0.06, 12)); add('steelSatin', F.boxAt(0.16, 0.2, 0.16, X + s * 0.6, -0.4, 0)); add('accent', wheel(0.1, 0.012, X + s * 0.6, -0.26, 0, Math.PI / 2, 0)); });
    add('steelSatin', F.cylAB([X, -0.18, 0], [X, -0.10, 0], 0.22, 20)); fl(-0.10);
    [0.15, 0.71].forEach(function (yc) {
      add('steelSatin', F.boxAt(0.38, 0.46, 0.38, X, yc, 0));
      add('steelSatin', F.cylAB([X, yc, 0.19], [X, yc, 0.42], 0.07, 12));
      add('accent', wheel(0.20, 0.022, X, yc, 0.44, 0, 0)); wheelSpokes(0.2, X, yc, 0.44, false).forEach(function (g) { add('accent', g); });
    });
    fl(0.43); fl(0.99);
    add('steelSatin', F.boxAt(0.40, 0.40, 0.40, X, 1.20, 0));                                          // flow cross
    add('steelSatin', F.cylAB([X + 0.2, 1.2, 0], [X + 0.44, 1.2, 0], 0.13, 16));                       // production wing
    add('steelSatin', F.boxAt(0.36, 0.36, 0.36, X + 0.62, 1.2, 0));
    add('steelSatin', F.cylAB([X + 0.62, 1.38, 0], [X + 0.62, 1.62, 0], 0.06, 12));
    add('accent', wheel(0.15, 0.016, X + 0.62, 1.64, 0, Math.PI / 2, 0));
    add('steelSatin', F.cylAB([X + 0.8, 1.2, 0], [X + 0.78, 1.2, 0], 0.26, 20));
    add('steelSatin', F.cylAB([X - 0.2, 1.2, 0], [X - 0.62, 1.2, 0], 0.13, 16));                       // kill wing + blind flange
    add('steelSatin', F.boxAt(0.3, 0.32, 0.3, X - 0.5, 1.2, 0)); add('steelSatin', F.cylAB([X - 0.66, 1.2, 0], [X - 0.72, 1.2, 0], 0.24, 20));
    add('steelSatin', F.boxAt(0.3, 0.42, 0.3, X, 1.62, 0)); add('accent', wheel(0.14, 0.015, X, 1.62, 0.2, 0, 0));   // swab
    add('steelSatin', F.cylAB([X, 1.84, 0], [X, 2.16, 0], 0.16, 20));                                  // tree cap
    add('steelSatin', F.cylAB([X, 2.16, 0], [X, 2.26, 0], 0.03, 8));
    dial(X, 2.4, 0.03, 0, 'wh');
    [[1.9, 1.9], [1.9, -1.9], [-1.9, 1.9], [-1.9, -1.9]].forEach(function (b) { add('yellow', F.cylAB([X + b[0], 0, b[1]], [X + b[0], 1.0, b[1]], 0.1, 12)); });
  })();

  // ═══ SDV-101 ESD valve (−11.6,0,0) ═════════════════════════════════════
  (function () {
    var X = -11.6;
    add('steelSatin', F.cylAB([X - 0.35, 1.2, 0], [X + 0.35, 1.2, 0], 0.26, 20));
    add('steelSatin', F.boxAt(0.42, 0.5, 0.46, X, 1.2, 0));
    add('steelSatin', F.cylAB([X, 1.45, 0], [X, 1.75, 0], 0.18, 16));
    add('steelDark', F.boxAt(0.04, 0.47, 0.04, X, 1.97, 0.13)); add('steelDark', F.boxAt(0.04, 0.47, 0.04, X, 1.97, -0.13));
    add('steelDark', F.cylAB([X, 2.16, 0], [X, 2.22, 0], 0.33, 24));
    add('yellow', F.cylAB([X, 2.22, 0], [X, 3.0, 0], 0.30, 28));
    add('steelDark', F.cylAB([X, 3.0, 0], [X, 3.06, 0], 0.32, 24));
    add('steelDark', F.boxAt(0.05, 0.3, 0.05, X + 0.25, 3.12, 0)); add('steelDark', F.boxAt(0.3, 0.04, 0.05, X + 0.12, 3.06, 0));
    flange([-12.0, 1.2, 0], [1, 0, 0], pipeRadius(4)); flange([-11.2, 1.2, 0], [1, 0, 0], pipeRadius(4));
    var rod = mkMesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 10).translate(0, 0.15, 0), F.std('#3fb950', 0.3, 0.4, { emissive:C('#1c5a27'), emissiveIntensity:0.6 }));
    rod.position.set(X, 3.05, 0);
    var beaconMat = new THREE.MeshBasicMaterial({ color:C('#3fb950') });
    var beacon = mkMesh(new THREE.SphereGeometry(0.07, 16, 12), beaconMat); beacon.position.set(X + 0.25, 3.3, 0);
    var bglow = sprite('#3fb950', 0.9, X + 0.25, 3.3, 0, 0.9);
    // ESD panel with mushroom button
    var PX = -12.6, PZ = 1.5;
    add('steelDark', F.cylAB([PX, 0, PZ - 0.14], [PX, 0.74, PZ - 0.14], 0.04, 8));
    var ptex = tex(F.panelTexture());
    add('yellow', F.boxAt(0.55, 0.75, 0.22, PX, 1.1, PZ));
    var panel = mkMesh(new THREE.PlaneGeometry(0.5, 0.7), new THREE.MeshStandardMaterial({ map:ptex, emissiveMap:ptex, emissive:C('#ffffff'), emissiveIntensity:0.25, roughness:0.6 }));
    panel.position.set(PX, 1.1, PZ + 0.111);
    var mush = mkMesh(new THREE.CylinderGeometry(0.06, 0.05, 0.06, 20).rotateX(Math.PI / 2), F.std('#e0302a', 0.1, 0.4, { emissive:C('#5a0a08'), emissiveIntensity:0.8 }));
    mush.position.set(PX, 0.95, PZ + 0.14);
    S.dyn.esd = { rod:rod, beacon:beacon, beaconMat:beaconMat, glow:bglow, mush:mush };
  })();

  // ═══ CK-101 choke manifold (−7.2,0,0) ══════════════════════════════════
  (function () {
    add('plate', F.boxAt(3.8, 0.2, 2.4, -7.2, 0.1, 0));
    add('steelSatin', F.boxAt(0.36, 0.36, 1.56, -8.65, 1.2, 0)); add('steelSatin', F.boxAt(0.36, 0.36, 1.56, -5.75, 1.2, 0));
    [-8.65, -5.75].forEach(function (x) { add('steelDark', F.boxAt(0.12, 1.0, 0.12, x, 0.6, 0.6)); add('steelDark', F.boxAt(0.12, 1.0, 0.12, x, 0.6, -0.6)); });
    gateValve(-8.2, 1.2, 0.6, 'x', 0.3); gateValve(-6.2, 1.2, 0.6, 'x', 0.3);
    gateValve(-8.2, 1.2, -0.6, 'x', 0.3, 'steelDark'); gateValve(-6.2, 1.2, -0.6, 'x', 0.3, 'steelDark');
    // adjustable choke (active leg A): angle body, bonnet, rotating handwheel; downstream body frosts
    add('frost', F.boxAt(0.36, 0.36, 0.36, -7.4, 1.2, 0.6));
    add('steelSatin', F.cylAB([-7.4, 1.38, 0.6], [-7.4, 1.83, 0.6], 0.09, 14));
    var hw = new THREE.Group(); hw.position.set(-7.4, 1.86, 0.6);
    var hwg = F.mergeGeos([wheel(0.17, 0.018, 0, 0, 0, Math.PI / 2, 0)].concat(wheelSpokes(0.17, 0, 0, 0, true)));
    var hwm = new THREE.Mesh(hwg, M.accent); hw.add(hwm); scene.add(hw);
    // fixed choke (leg B): hex cap
    add('steelSatin', F.boxAt(0.34, 0.34, 0.34, -7.4, 1.2, -0.6)); add('steelSatin', F.place(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 6), -7.4, 1.43, -0.6));
    [-7.15, -6.65].forEach(function (x) { flange([x, 1.2, 0.6], [1, 0, 0], pipeRadius(4)); });
    flange([-7.15, 1.2, -0.6], [1, 0, 0], pipeRadius(4));
    add('steelDark', F.cylAB([-8.65, 1.38, 0], [-8.65, 1.72, 0], 0.02, 6)); add('steelDark', F.cylAB([-5.75, 1.38, 0], [-5.75, 1.72, 0], 0.02, 6));
    dial(-8.65, 1.82, 0.05, 0, 'ckUp'); dial(-5.75, 1.82, 0.05, 1, 'ckDn');
    S.dyn.choke = { wheel:hw, ang:0 };
  })();

  // ═══ H-101 line heater (−1.4,0,0) ══════════════════════════════════════
  var heater = {};
  (function () {
    add('plate', F.boxAt(4.4, 0.2, 2.4, -1.4, 0.1, 0.4));
    [-2.55, -0.25].forEach(function (x) { add('steelDark', saddleGeo(THREE, 0.81, 1.6, 1.3, 0.3).translate(x, 0, 0)); });
    [-3.1, 0.3].forEach(function (x) { add('steelSatin', F.place(new THREE.TorusGeometry(0.805, 0.03, 8, 48), x, 1.6, 0, 0, Math.PI / 2, 0)); });
    add('steelSatin', F.place(new THREE.TorusGeometry(0.805, 0.02, 8, 48), -1.4, 1.6, 0, 0, Math.PI / 2, 0));
    // U firetube
    var ft = [F.cylAB([-2.9, 1.3, 0.3], [0.35, 1.3, 0.3], 0.17, 16), F.cylAB([-2.9, 1.3, -0.3], [0.35, 1.3, -0.3], 0.17, 16),
              F.place(new THREE.TorusGeometry(0.3, 0.17, 12, 16, Math.PI), -2.9, 1.3, 0, -Math.PI / 2, 0, Math.PI / 2)];
    var fire = mkMesh(F.mergeGeos(ft), M.fire);
    // burner box + peephole, stack with rain cap
    add('steelDark', F.boxAt(0.42, 0.55, 0.9, 0.52, 1.3, 0)); add('steelDark', F.boxAt(0.3, 0.3, 0.3, 0.55, 1.62, 0.28));
    add('steelDark', F.cylAB([0.55, 1.7, 0.28], [0.55, 5.3, 0.28], 0.15, 16));
    add('steelDark', F.place(new THREE.ConeGeometry(0.28, 0.2, 16), 0.55, 5.52, 0.28)); add('steelDark', F.cylAB([0.53, 5.3, 0.28], [0.57, 5.42, 0.28], 0.03, 4));
    var peep = sprite('#ff7a2a', 0.5, 0.75, 1.3, 0, 0.9);
    // process coil: 5-pass serpentine (y 1.9, z +0.4…−0.4, x −2.85…+0.05, U-bends R 0.1)
    var pts = [new V3(-3.15, 1.9, 0.4)], z, pass, dir;
    for (pass = 0; pass < 5; pass++) {
      z = 0.4 - pass * 0.2; dir = pass % 2 === 0 ? 1 : -1;
      var xs = dir > 0 ? -2.85 : 0.05, xe = dir > 0 ? 0.05 : -2.85;
      pts.push(new V3(xs, 1.9, z)); pts.push(new V3(xe, 1.9, z));
      if (pass < 4) for (var k = 1; k < 8; k++) { var a = k / 8 * Math.PI; pts.push(new V3(xe + dir * 0.1 * Math.sin(a), 1.9, z - 0.1 + 0.1 * Math.cos(a))); }
    }
    pts.push(new V3(0.35, 1.9, -0.4));
    var coil = mkMesh(new THREE.TubeGeometry(new F.PolyCurve(pts), 360, 0.07, 10, false), M.coil);
    // bypass manifold valves
    gateValve(-3.9, 1.55, 0, 'y', 0.28); gateValve(1.0, 1.55, -0.4, 'y', 0.28); gateValve(-1.4, 1.2, 1.5, 'x', 0.3);
    dial(-1.4, 2.62, 0.12, 3, 'htrT');
    var puffs = [];
    for (var p = 0; p < 3; p++) puffs.push(smokeSprite('#8a929c', 0.6, 0.55, 5.7, 0.28, 0));
    heater = { fire:fire, coil:coil, peep:peep, puffs:puffs };
    S.dyn.heater = heater;
  })();

  // ═══ vessels (glass + phase hull + caps + particles) ═══════════════════
  var normTexA = T.capNormals ? tex(F.rippleNormalTexture()) : null, normTexB = null;
  if (normTexA) { normTexA.repeat.set(3, 3); if (T.capNormals > 1) { normTexB = tex(normTexA.clone()); normTexB.repeat.set(5, 5); normTexB.needsUpdate = true; } }
  S.normTex = [normTexA, normTexB];
  function vessel(id, glassGeo, hullGeo, glassPos, hullPos, opts) {
    var U = F.hullUniforms(), alert = { value:0 };
    var v = { id:id, U:U, alert:alert, caps:[], internalsT:[], centre:new V3().fromArray(opts.centre), slosh:{ th:0, om:0, lastL:-1 } };
    var gF = F.makeGlass({ side:THREE.FrontSide, opacity:opts.glassA || 0.10, tier:tier, alert:alert, envTex:envTex });
    v.glassFront = new THREE.Mesh(glassGeo, gF); v.glassFront.position.copy(glassPos); scene.add(v.glassFront);
    if (T.back) { v.glassBack = new THREE.Mesh(glassGeo, F.makeGlass({ side:THREE.BackSide, opacity:0.05, tier:tier, alert:alert, envTex:envTex })); v.glassBack.position.copy(glassPos); scene.add(v.glassBack); }
    v.hullBack = new THREE.Mesh(hullGeo, F.makeHull({ side:THREE.BackSide, U:U, glow:0.32, faceW:opts.backA || 0.96, faceO:opts.backA || 0.96, tier:tier, envTex:envTex }));
    v.hullFront = new THREE.Mesh(hullGeo, F.makeHull({ side:THREE.FrontSide, U:U, glow:opts.frontGlow != null ? opts.frontGlow : 0.55, faceW:opts.faceW || 0.55, faceO:opts.faceO || 0.8, tier:tier, envTex:envTex }));
    v.hullBack.position.copy(hullPos); v.hullFront.position.copy(hullPos);
    v.frontMat = v.hullFront.material;
    scene.add(v.hullBack); scene.add(v.hullFront);
    S.vessels.push(v); return v;
  }
  function capMat() { return F.makeCap({ tier:tier, envTex:envTex, normal:normTexA, normal2:normTexB }); }

  // ── V-101 separator (hero) ─────────────────────────────────────────────
  var V101 = (function () {
    var R = 0.85, Ri = 0.835, Ltt = 6.0, hd = 0.425, hdi = hd - 0.015, H = Ltt + 2 * hdi, Hg = Ltt + 2 * hd;
    var glassGeo = latheH(THREE, vesselProfile(R, Ltt, hd, 16), T.radV, Hg, R);
    var hullGeo = latheH(THREE, vesselProfile(Ri, Ltt, hdi, 16), T.radV, H, Ri);
    var v = vessel('separator', glassGeo, hullGeo, new V3(5.6, 2.0 - R, 0), new V3(5.6, 2.0 - Ri, 0), { centre:[5.6, 2.0, 0], faceW:0.35, faceO:0.14, frontGlow:0.25 });
    // (horizontal vessel seen from above: the front face's oil band overlies the back face's water band, so the front oil is
    //  kept nearly clear — the back face then reads as a clean water / oil / gas section with its bright interface line)
    v.Ri = Ri; v.Ltt = Ltt; v.hd = hdi; v.H = H; v.kind = 'h';
    [2.6, 8.6, 7.1].forEach(function (x, i) { add('steelSatin', F.place(new THREE.TorusGeometry(0.856, i === 2 ? 0.018 : 0.028, 8, 64), x, 2.0, 0, 0, Math.PI / 2, 0)); });
    [3.6, 7.6].forEach(function (x) { add('steelDark', saddleGeo(THREE, 0.87, 2.0, 1.5, 0.36).translate(x, 0, 0)); add('steelDark', F.boxAt(0.5, 0.04, 1.7, x, 0.02, 0)); });
    // internals (opaque): diverter, weir plate, mist pad
    add('steelSatin', F.boxAt(0.05, 0.8, 0.9, 5.6 - 2.75, 2.15, 0, 0, 0, 20 * Math.PI / 180));
    v.weirGeoParams = { Ri:Ri };
    var weir = mkMesh(weirGeo(THREE, Ri, 0.55 * 2 * Ri), M.steelSatin); weir.position.set(5.6 + 1.5, 2.0 - Ri, 0); v.weir = weir;
    var mist = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 1.3), F.std('#9aa4b0', 0.6, 0.5, { alphaMap:tex(F.hatchTexture(10, 3)), alphaTest:0.5, side:THREE.DoubleSide }));
    mist.material.alphaMap.repeat.set(3, 3); mist.position.set(5.6 + 2.45, 2.55, 0); scene.add(mist);
    // nozzles
    [[8.1, 1], [5.2, 1], [4.1, 1], [6.3, -1], [8.1, -1]].forEach(function (n) {
      var y0 = 2.0 + n[1] * 0.78, y1 = 2.0 + n[1] * 0.88; add('steelSatin', F.cylAB([n[0], y0, 0], [n[0], y1, 0], 0.11, 14));
    });
    add('steelSatin', F.cylAB([2.25, 2.3, 0], [2.05, 2.3, 0], 0.2, 16));
    // magnetic level gauges LG-101A/B/C on the +Z face
    var LGX = [4.35, 4.85, 7.8], zc = 1.07;
    LGX.forEach(function (x) {
      add('steelSatin', F.cylAB([x, 1.1, zc], [x, 2.9, zc], 0.045, 12));
      [1.3, 2.7].forEach(function (y) { add('steelDark', F.cylAB([x, y, zc - 0.05], [x, y, Math.sqrt(Math.max(0, 0.85 * 0.85 - (y - 2) * (y - 2))) - 0.02], 0.02, 6)); });
    });
    var nF = 30, flagGeo = new THREE.BoxGeometry(0.08, 0.035, 0.012);
    var flags = new THREE.InstancedMesh(flagGeo, new THREE.MeshStandardMaterial({ roughness:0.5, metalness:0.1, emissive:C('#ffffff'), emissiveIntensity:0.18 }), 3 * nF);
    flags.frustumCulled = false; scene.add(flags);
    var fd = { mesh:flags, n:nF, x:LGX, z:zc + 0.058, st:new Int8Array(3 * nF).fill(-1), t:new Float32Array(3 * nF).fill(1) };
    S.dyn.flags = fd;
    // setpoint lines (dashed, on the glass front and back)
    var sl = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ vertexColors:true, dashSize:0.12, gapSize:0.07, transparent:true, opacity:0.18, depthWrite:false, fog:false }));
    sl.renderOrder = 990; sl.frustumCulled = false; scene.add(sl); S.dyn.spLines = { obj:sl, key:'' };
    // caps (split at the weir)
    var c1 = horizCap(THREE, Ri, Ltt, hdi, T.capGrid), cB = horizCap(THREE, Ri, Ltt, hdi, T.capGrid);
    var m1 = new THREE.Mesh(c1.geo, capMat()), mB = new THREE.Mesh(cB.geo, capMat());
    m1.position.copy(v.hullFront.position); mB.position.copy(v.hullFront.position); scene.add(m1); scene.add(mB);
    c1.mesh = m1; cB.mesh = mB; v.caps = [m1, mB]; v.capInfo = [c1, cB];
    // weir cascade sheet + foam (submerged transparent internals, band b+3)
    var casc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 8), new THREE.ShaderMaterial({
      uniforms:{ uCol:{ value:C('#d9a441') }, uOff:{ value:0 }, uA:{ value:0.6 }, uTop:{ value:1 }, uBot:{ value:0.4 }, uX:{ value:7.1 }, uZ:{ value:0.6 } },
      vertexShader:'uniform float uTop, uBot, uX, uZ; varying vec2 vUv; void main(){ vUv = uv; float h = uv.y; float y = mix(uBot, uTop, h);\n' +
        ' float bow = (1.0-h)*(1.0-h)*0.16; vec3 p = vec3(uX + 0.02 + bow, y, (uv.x-0.5)*2.0*uZ);\n' +
        ' gl_Position = projectionMatrix*viewMatrix*vec4(p,1.0); }',
      fragmentShader:'uniform vec3 uCol; uniform float uOff, uA; varying vec2 vUv;\n' + F.FBM_GLSL.replace(/OCT/g, '3') +
        'void main(){ float n = fbm(vec2(vUv.x*6.0, vUv.y*3.0 + uOff)); float e = smoothstep(0.0,0.12,vUv.x)*smoothstep(1.0,0.88,vUv.x);\n' +
        ' float a = uA*e*(0.45+0.75*n); gl_FragColor = vec4(uCol*(1.1+0.8*n), a);\n #include <tonemapping_fragment>\n #include <colorspace_fragment>\n}',
      transparent:true, depthWrite:false, side:THREE.DoubleSide, fog:false }));
    casc.frustumCulled = false; scene.add(casc); v.internalsT.push(casc); S.dyn.cascade = casc;
    if (T.haze || tier === 'medium') {                     // gas haze in the vapour space (one additive draw)
      var haze = new THREE.Mesh(hullGeo, new THREE.ShaderMaterial({
        uniforms:{ uLvA:{ value:1 }, uLvB:{ value:0.5 }, uSplit:{ value:1.5 }, uA:{ value:0.08 }, uCol:{ value:C('#c4d8ec') }, uTilt:{ value:0 } },
        vertexShader:'varying vec3 vLoc; varying vec3 vN; varying vec3 vV; void main(){ vLoc = position; vec4 w = modelMatrix*vec4(position,1.0);\n' +
          ' vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }',
        fragmentShader:'uniform float uLvA, uLvB, uSplit, uA, uTilt; uniform vec3 uCol; varying vec3 vLoc; varying vec3 vN; varying vec3 vV;\n' +
          'void main(){ float lv = (vLoc.x < uSplit ? uLvA : uLvB) + vLoc.x*uTilt; if (vLoc.y < lv) discard;\n' +
          ' float h = clamp((vLoc.y - lv)/max(0.05, 1.67 - lv), 0.0, 1.0); float fr = 1.0 - abs(dot(normalize(vN), normalize(vV)));\n' +
          ' float a = uA*(0.6 + 0.6*fr)*(1.0 - 0.4*h) + uA*0.8*(1.0 - smoothstep(0.0, 0.06, vLoc.y - lv));\n' +
          ' gl_FragColor = vec4(uCol*a, a);\n #include <tonemapping_fragment>\n #include <colorspace_fragment>\n}',
        transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.FrontSide, fog:false }));
      haze.position.set(5.6, 2.0 - Ri, 0); haze.frustumCulled = false; scene.add(haze); v.internalsT.push(haze); S.dyn.haze = haze;
    }
    // PSV-101, PCV-101 + FE-101 on the gas rack, dials
    add('accent', F.boxAt(0.18, 0.28, 0.18, 5.2, 3.3, 0)); add('steelSatin', F.cylAB([5.2, 3.44, 0], [5.2, 3.7, 0], 0.07, 12));
    dial(6.6, 3.05, 0.3, 1, 'sep'); add('steelDark', F.cylAB([6.6, 2.85, 0.2], [6.6, 2.95, 0.3], 0.02, 6));
    return v;
  })();

  // gas rack T-posts + PCV-101 + FE-101
  [11.5, 14.5, 17.5].forEach(function (x) {
    add('steelDark', F.boxAt(0.15, 3.4, 0.15, x, 1.7, 0)); add('steelDark', F.boxAt(0.15, 0.12, 1.4, x, 3.44, 0));
    add('steelDark', F.boxAt(0.3, 0.02, 0.3, x, 0.01, 0));
  });
  add('steelDark', F.boxAt(0.12, 0.5, 0.12, 12.0, 3.75, 0));
  var lcvStems = [];
  function globeValve(x, y, z, axisDir, r, withStem) {
    add('steelSatin', F.place(new THREE.SphereGeometry(r * 1.25, 16, 12), x, y, z));
    add('steelSatin', F.cylAB([x, y + r, z], [x, y + r + 0.3, z], 0.04, 8));
    add('paintBlue', F.place(new THREE.SphereGeometry(0.2, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), x, y + r + 0.32, z));
    add('paintBlue', F.cylAB([x, y + r + 0.3, z], [x, y + r + 0.33, z], 0.2, 20));
    if (withStem) { var st = new THREE.Object3D(); st.position.set(x, y + r + 0.6, z); lcvStems.push(st); return st; }
  }
  globeValve(10.6, 3.6, 0, 'x', pipeRadius(6), true);                // PCV-101
  add('steelSatin', F.boxAt(0.12, 0.62, 0.62, 9.3, 3.6, 0)); add('steelDark', F.cylAB([9.3, 3.92, 0], [9.3, 4.12, 0], 0.03, 6));   // FE-101
  add('steelDark', F.boxAt(0.18, 0.14, 0.12, 9.3, 4.18, 0));
  dial(9.9, 4.05, 0.25, 1, 'gas'); add('steelDark', F.cylAB([9.9, 3.8, 0.1], [9.9, 3.95, 0.22], 0.02, 6));
  var lcvW = globeValve(6.3, 0.55, 0.9, 'z', pipeRadius(3), true), lcvO = globeValve(8.1, 0.55, 0.9, 'z', pipeRadius(3), true);
  [[6.3, 1.7], [8.1, 1.7]].forEach(function (p) { add('steelSatin', F.cylAB([p[0], 0.55, p[1] - 0.16], [p[0], 0.55, p[1] + 0.16], pipeRadius(3) * 1.35, 16)); add('steelDark', F.boxAt(0.12, 0.14, 0.12, p[0], 0.8, p[1])); });
  add('steelSatin', F.boxAt(0.16, 0.2, 0.16, 11.6, 6.1, 4.0)); globeValve(11.6, 6.1, 4.0, 'x', pipeRadius(2), false);    // PCV-201
  globeValve(4.1, 4.9, 2.0, 'z', pipeRadius(2), false);                                                                      // PCV-202
  var stemInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8), M.accent, lcvStems.length); stemInst.frustumCulled = false; scene.add(stemInst);
  S.dyn.lcv = { water:lcvW, oil:lcvO, pcv:lcvStems[0], list:lcvStems, inst:stemInst };

  // ── H-101 glass shell + bath hull ──────────────────────────────────────
  var H101 = (function () {
    var R = 0.8, Ri = 0.785, L = 3.4, Li = 3.37;
    var gG = latheH(THREE, [[1e-4, 0], [R, 0], [R, L], [1e-4, L]], T.radV, L, R);
    var hG = latheH(THREE, [[1e-4, 0], [Ri, 0], [Ri, Li], [1e-4, Li]], T.radV, Li, Ri);
    var v = vessel('heater', gG, hG, new V3(-1.4, 1.6 - R, 0), new V3(-1.4, 1.6 - Ri, 0), { centre:[-1.4, 1.6, 0], faceW:0.42, faceO:0.42, backA:0.82 });
    v.U.uWatCol.value = C(PALETTE.heaterBath); v.U.uOilCol.value = C(PALETTE.heaterBath); v.U.uEmCol.value = C('#2aa39b');
    v.U.uSecA.value.set(-1, 0.82 * 2 * Ri); v.U.uSecB.value.copy(v.U.uSecA.value); v.U.uRip.value = 0.6;
    v.Ri = Ri; v.kind = 'bath';
    var cap = horizCapFlat(THREE, Ri, Li, 0.82 * 2 * Ri, 24);
    var cm = new THREE.Mesh(cap, capMat()); cm.position.copy(v.hullFront.position); cm.position.y += 0.82 * 2 * Ri; scene.add(cm);
    cm.material.userData.U.uSurf.value = C('#2fc9bd'); cm.material.opacity = 0.55; cm.material.color = C('#1b7f79');
    v.caps = [cm];
    return v;
  })();

  // ── T-201 surge tank (10.2,0,4) ───────────────────────────────────────
  var T201 = (function () {
    var R = 1.2, Ri = 1.185, Ls = 3.6, hd = 0.6, hdi = 0.585;
    var gG = new THREE.LatheGeometry(vesselProfile(R, Ls, hd, 16).map(function (p) { return new THREE.Vector2(p[0], p[1]); }), T.radV);
    var hG = new THREE.LatheGeometry(vesselProfile(Ri, Ls, hdi, 16).map(function (p) { return new THREE.Vector2(p[0], p[1]); }), T.radV);
    var v = vessel('surge', gG, hG, new V3(10.2, 0.9, 4.0), new V3(10.2, 0.915, 4.0), { centre:[10.2, 3.3, 4.0], faceW:0.55, faceO:0.8 });
    v.Ri = Ri; v.Ls = Ls; v.hd = hdi; v.Hint = Ls + 2 * hdi; v.kind = 'v';
    [1.5, 5.1].forEach(function (y) { add('steelSatin', F.place(new THREE.TorusGeometry(1.206, 0.026, 8, 64), 10.2, y, 4.0, Math.PI / 2, 0, 0)); });
    for (var k = 0; k < 4; k++) {
      var a = Math.PI / 4 + k * Math.PI / 2, lx = 10.2 + Math.cos(a) * 1.0, lz = 4.0 + Math.sin(a) * 1.0;
      add('steelDark', F.boxAt(0.12, 1.8, 0.12, lx, 0.9, lz)); add('steelDark', F.boxAt(0.3, 0.02, 0.3, lx, 0.01, lz));
    }
    add('steelSatin', F.cylAB([9.0, 4.2, 4.0], [9.12, 4.2, 4.0], 0.2, 16)); add('steelSatin', F.cylAB([9.0, 4.9, 4.0], [9.12, 4.9, 4.0], 0.14, 16));
    add('steelSatin', F.cylAB([10.2, 5.62, 4.0], [10.2, 5.78, 4.0], 0.14, 16));
    // PSV-201 on the top head, discharge tees into VENT
    add('accent', F.boxAt(0.16, 0.24, 0.16, 10.65, 5.62, 4.35)); add('steelSatin', F.cylAB([10.65, 5.74, 4.35], [10.65, 6.1, 4.35], 0.05, 10));
    add('steelSatin', F.cylAB([10.65, 6.1, 4.35], [10.65, 6.1, 4.0], 0.05, 10));
    // sight glass LG-201 (camera side, azimuth −30°)
    var sx = 10.2 - 0.7, sz = 4.0 + 1.212;
    add('steelSatin', F.cylAB([sx, 1.5, sz], [sx, 1.6, sz], 0.075, 12)); add('steelSatin', F.cylAB([sx, 5.0, sz], [sx, 5.1, sz], 0.075, 12));
    [1.55, 5.05].forEach(function (y) { add('steelDark', F.cylAB([sx, y, sz], [10.2 - 0.55, y, 4.0 + 0.95], 0.025, 6)); });
    var tubeMat = F.makeGlass({ side:THREE.FrontSide, opacity:0.12, tier:tier, envTex:envTex });
    var tube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.4, 16, 1, true).translate(0, 3.3, 0), tubeMat); tube.position.set(sx, 0, sz); tube.renderOrder = 905; scene.add(tube);
    var colW = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 1, 12).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color:C(PALETTE.waterBody), emissive:C(PALETTE.waterBody), emissiveIntensity:0.55, roughness:0.3 }));
    var colO = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 1, 12).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color:C('#a06a24'), emissive:C('#a06a24'), emissiveIntensity:0.55, roughness:0.3 }));
    colW.position.set(sx, 1.6, sz); colO.position.set(sx, 1.6, sz); scene.add(colW); scene.add(colO);
    S.dyn.sight = { w:colW, o:colO, y0:1.6, y1:5.0 };
    dial(9.25, 3.0, 5.05, 2, 'surge'); add('steelDark', F.cylAB([9.4, 3.0, 4.75], [9.28, 3.0, 5.0], 0.02, 6));
    // centre baffle (x = 10.2, in the YZ plane): compartments A (−X, inlet nozzle side) | B (+X); the gas space is common
    // over its top edge. Outline follows the bottom head, top edge at 95 % of the straight shell.
    var prof = vesselProfile(Ri - 0.01, Ls, hdi, 16), yTopB = hdi + 0.95 * Ls, sh = new THREE.Shape(), bi;
    var half = prof.filter(function (p) { return p[1] <= hdi + 1e-6; });
    sh.moveTo(0, 0); for (bi = 0; bi < half.length; bi++) sh.lineTo(half[bi][0], half[bi][1]);
    sh.lineTo(Ri - 0.01, yTopB); sh.lineTo(-(Ri - 0.01), yTopB);
    for (bi = half.length - 1; bi >= 0; bi--) sh.lineTo(-half[bi][0], half[bi][1]);
    add('steelSatin', new THREE.ExtrudeGeometry(sh, { depth:0.03, bevelEnabled:false }).rotateY(Math.PI / 2).translate(10.2 - 0.015, 0.915, 4.0));
    add('steelDark', F.boxAt(0.05, 0.05, 2.36, 10.2, 0.915 + yTopB, 4.0));
    // compartment caps: two half discs (A: −X, B: +X), scaled to the vessel radius at the level
    var capsU = [];
    [Math.PI / 2, -Math.PI / 2].forEach(function (a0) {
      var cap = new THREE.CircleGeometry(1, 24, a0, Math.PI).rotateX(-Math.PI / 2);
      addEdgeRadial(THREE, cap);
      var cm = new THREE.Mesh(cap, capMat()); cm.position.copy(v.hullFront.position); scene.add(cm); capsU.push(cm);
    });
    v.caps = capsU;
    v.U.uSplitX.value = 0;
    // inlet divert: LM ends in A's side nozzle via XV-201A; a tee at x 8.55 feeds B's top-head nozzle via XV-201B
    var rP = pipeRadius(3), bp = [[8.55, 4.2, 4.0], [8.55, 4.2, 3.3], [8.55, 5.95, 3.3], [10.75, 5.95, 3.3], [10.75, 5.52, 3.3]];
    for (bi = 0; bi < bp.length - 1; bi++) add('steelSatin', F.cylAB(bp[bi], bp[bi + 1], rP, 12));
    for (bi = 1; bi < bp.length - 1; bi++) add('steelSatin', F.place(new THREE.SphereGeometry(rP * 1.05, 12, 8), bp[bi][0], bp[bi][1], bp[bi][2]));
    add('steelSatin', F.cylAB([10.75, 5.6, 3.3], [10.75, 5.48, 3.3], rP * 1.5, 12));
    add('steelSatin', F.boxAt(0.2, 0.22, 0.22, 8.8, 4.2, 4.0)); add('steelSatin', F.cylAB([8.8, 4.2, 4.1], [8.8, 4.2, 4.33], 0.03, 6));       // XV-201A
    add('steelSatin', F.boxAt(0.22, 0.22, 0.2, 9.3, 5.95, 3.3)); add('steelSatin', F.cylAB([9.3, 6.05, 3.3], [9.3, 6.24, 3.3], 0.03, 6));     // XV-201B
    // P-201 suction: A's bottom nozzle (x 9.75) and B's (x 10.65, on X1) with suction valves SV-201A/B
    var sp0 = [[9.75, 0.95, 4.0], [9.75, 0.45, 4.0], [10.65, 0.45, 4.0]];
    add('steelSatin', F.cylAB(sp0[0], sp0[1], rP, 12)); add('steelSatin', F.cylAB(sp0[1], sp0[2], rP, 12));
    add('steelSatin', F.place(new THREE.SphereGeometry(rP * 1.05, 12, 8), 9.75, 0.45, 4.0));
    add('steelSatin', F.boxAt(0.2, 0.2, 0.22, 10.1, 0.45, 4.0)); add('steelSatin', F.boxAt(0.2, 0.2, 0.22, 10.65, 0.72, 4.0));
    return v;
  })();

  // ── P-201 transfer pump (12.6,0,4) ────────────────────────────────────
  (function () {
    add('steelDark', F.boxAt(0.8, 0.1, 1.6, 12.5, 0.05, 3.45));
    add('steelSatin', F.cylAB([12.5, 0.45, 3.9], [12.5, 0.45, 4.12], 0.3, 24)); add('steelSatin', F.cylAB([12.5, 0.45, 3.85], [12.5, 0.45, 3.9], 0.18, 16));
    add('steelSatin', F.cylAB([12.2, 0.45, 4.0], [12.25, 0.45, 4.0], 0.18, 16));
    add('steelSatin', F.cylAB([12.5, 0.72, 4.0], [12.5, 0.76, 4.0], 0.2, 16));
    add('paintBlue', F.cylAB([12.5, 0.45, 3.52], [12.5, 0.45, 2.85], 0.22, 24)); add('paintBlue', F.boxAt(0.3, 0.2, 0.5, 12.5, 0.2, 3.2));
    for (var k = 0; k < 6; k++) add('paintBlue', F.boxAt(0.02, 0.46, 0.6, 12.5 + Math.cos(k) * 0.0, 0.45, 3.18, 0, 0, k * Math.PI / 6));
    add('accent', F.place(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 20, 1, true, 0, Math.PI), 12.5, 0.45, 3.7, Math.PI / 2, 0, 0));
    var coup = mkMesh(F.mergeGeos([new THREE.CylinderGeometry(0.075, 0.075, 0.26, 12).rotateX(Math.PI / 2), F.boxAt(0.17, 0.03, 0.1, 0, 0, 0)]), M.steelSatin);
    coup.position.set(12.5, 0.45, 3.7);
    var lampM = new THREE.MeshBasicMaterial({ color:C('#2b0f0f') }); var lamp = mkMesh(new THREE.SphereGeometry(0.05, 12, 8), lampM); lamp.position.set(12.95, 0.95, 3.2);
    add('steelDark', F.cylAB([12.95, 0.1, 3.2], [12.95, 0.9, 3.2], 0.02, 6));
    S.dyn.pump = { coup:coup, lampM:lampM, ang:0 };
  })();

  // ── T-301 gauge tank (16.4,0,4) ───────────────────────────────────────
  var T301 = (function () {
    var x0 = 13.9, x1 = 18.9, y0 = 0.25, y1 = 2.85, z0 = 2.7, z1 = 5.3;
    var walls = [
      F.place(new THREE.PlaneGeometry(5, 2.6), 16.4, 1.55, z1), F.place(new THREE.PlaneGeometry(5, 2.6), 16.4, 1.55, z0, 0, Math.PI, 0),
      F.place(new THREE.PlaneGeometry(2.6, 2.6), x1, 1.55, 4.0, 0, Math.PI / 2, 0), F.place(new THREE.PlaneGeometry(2.6, 2.6), x0, 1.55, 4.0, 0, -Math.PI / 2, 0)];
    var gG = F.mergeGeos(walls);
    var hG = new THREE.BoxGeometry(4.97, 2.6, 2.57, 2, 1, 1).translate(0, 1.3, 0);
    var v = vessel('gauge', gG, hG, new V3(0, 0, 0), new V3(16.4, 0.25, 4.0), { centre:[16.4, 1.55, 4.0], faceW:0.55, faceO:0.8, glassA:0.08 });
    v.U.uSplitX.value = 0; v.kind = 'g';
    add('steelDark', F.boxAt(5.2, 0.25, 2.8, 16.4, 0.125, 4.0));
    // 12 edge members + stiffeners + rim angle
    [[x0, z0], [x0, z1], [x1, z0], [x1, z1]].forEach(function (c) { add('steelDark', F.boxAt(0.08, 2.6, 0.08, c[0], 1.55, c[1])); });
    [y0, y1].forEach(function (y) {
      add('steelDark', F.boxAt(5.08, 0.08, 0.08, 16.4, y, z0)); add('steelDark', F.boxAt(5.08, 0.08, 0.08, 16.4, y, z1));
      add('steelDark', F.boxAt(0.08, 0.08, 2.68, x0, y, 4.0)); add('steelDark', F.boxAt(0.08, 0.08, 2.68, x1, y, 4.0));
    });
    for (var sx = x0 + 1; sx < x1 - 0.1; sx += 1) { add('steelDark', F.boxAt(0.05, 2.6, 0.04, sx, 1.55, z1 + 0.03)); add('steelDark', F.boxAt(0.05, 2.6, 0.04, sx, 1.55, z0 - 0.03)); }
    add('steelSatin', F.boxAt(0.03, 2.5, 2.58, 16.4, 1.5, 4.0));                        // opaque baffle
    // walkway (grating) + handrails on the −Z side, caged ladder at +X
    var grat = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 0.7).rotateX(-Math.PI / 2), F.std('#59626e', 0.6, 0.6, { alphaMap:tex(F.hatchTexture(8, 5)), alphaTest:0.5, side:THREE.DoubleSide }));
    grat.material.alphaMap.repeat.set(12, 2); grat.position.set(16.4, 2.87, 2.3); scene.add(grat);
    add('steelDark', F.boxAt(5.2, 0.06, 0.06, 16.4, 2.84, 1.95));
    for (var px = x0 - 0.1; px <= x1 + 0.15; px += 1.3) add('yellow', F.boxAt(0.05, 1.0, 0.05, px, 3.35, 1.95));
    add('yellow', F.boxAt(5.3, 0.05, 0.05, 16.4, 3.85, 1.95)); add('yellow', F.boxAt(5.3, 0.04, 0.04, 16.4, 3.35, 1.95));
    [3.6, 4.4].forEach(function (lz) { add('steelDark', F.boxAt(0.05, 3.8, 0.05, 19.05, 1.9, lz)); });
    for (var ry = 0.3; ry < 3.8; ry += 0.3) add('steelSatin', F.boxAt(0.03, 0.03, 0.8, 19.05, ry, 4.0));
    for (var cy = 1.8; cy < 3.9; cy += 0.5) add('steelDark', F.place(new THREE.TorusGeometry(0.4, 0.015, 4, 20, Math.PI), 19.25, cy, 4.0, Math.PI / 2, 0, Math.PI / 2));
    // fill header valves XV-A/XV-B (handwheels follow gauge.active)
    var xvA = new THREE.Mesh(F.mergeGeos([wheel(0.12, 0.015, 0, 0, 0, Math.PI / 2, 0)].concat(wheelSpokes(0.12, 0, 0, 0, true))), M.accent);
    var xvB = new THREE.Mesh(xvA.geometry, M.accent);
    add('steelSatin', F.boxAt(0.22, 0.22, 0.22, 15.2, 3.15, 3.6)); add('steelSatin', F.boxAt(0.22, 0.22, 0.22, 17.6, 3.15, 3.6));
    xvA.position.set(15.45, 3.15, 3.6); xvA.rotation.z = Math.PI / 2; xvB.position.set(17.85, 3.15, 3.6); xvB.rotation.z = Math.PI / 2;
    var dvA = new THREE.Mesh(xvA.geometry, M.accent), dvB = new THREE.Mesh(xvA.geometry, M.accent);
    add('steelSatin', F.boxAt(0.22, 0.22, 0.22, 15.4, 0.35, 5.8)); add('steelSatin', F.boxAt(0.22, 0.22, 0.22, 17.9, 0.35, 5.8));
    dvA.position.set(15.4, 0.62, 5.8); dvB.position.set(17.9, 0.62, 5.8);
    // T-201 inlet valve handwheels (XV-201A faces +Z on the LM run, XV-201B sits on the B branch)
    var sxA = new THREE.Object3D(), sxB = new THREE.Object3D();
    sxA.position.set(8.8, 4.2, 4.35); sxA.rotation.x = Math.PI / 2; sxB.position.set(9.3, 6.26, 3.3);
    var vInst = new THREE.InstancedMesh(xvA.geometry, M.accent, 6); vInst.frustumCulled = false; if (T.shadow) vInst.castShadow = false; scene.add(vInst);
    // valve status lamps: green = open / in service, red = inlet shut, dark = suction out of service  [XV-301A, XV-301B, XV-201A, XV-201B, SV-201A, SV-201B]
    var lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 12, 8), new THREE.MeshBasicMaterial({ color:C('#ffffff') }), 6);
    lamps.frustumCulled = false; scene.add(lamps);
    [[15.2, 3.36, 3.36], [17.6, 3.36, 3.36], [8.8, 4.42, 4.0], [9.3, 5.95, 3.06], [10.1, 0.62, 4.22], [10.65, 0.89, 4.22]].forEach(function (p, i) {
      lamps.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p[0], p[1], p[2])); lamps.setColorAt(i, C('#2b1a1a'));
    });
    lamps.instanceMatrix.needsUpdate = true; if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    add('steelSatin', F.cylAB([15.4, 0.35, 5.8], [15.4, 0.6, 5.8], 0.03, 6)); add('steelSatin', F.cylAB([17.9, 0.35, 5.8], [17.9, 0.6, 5.8], 0.03, 6));
    add('steelSatin', F.cylAB([20.0, 0.35, 6.3], [20.12, 0.35, 6.3], 0.22, 16)); add('rubber', F.cylAB([20.12, 0.35, 6.3], [20.6, 0.2, 6.3], 0.1, 12));
    S.dyn.gaugeValves = { xvA:xvA, xvB:xvB, dvA:dvA, dvB:dvB, sxA:sxA, sxB:sxB, aA:0, aB:0, inst:vInst, lamps:lamps, lampSig:'' };
    // gauge boards
    var boards = [];
    [15.1, 17.7].forEach(function (bx, i) {
      var mb = new THREE.MeshStandardMaterial({ roughness:0.6, emissive:C('#ffffff'), emissiveIntensity:0.07 });
      var b = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 2.6), mb); b.position.set(bx, 1.55, z1 + 0.07); scene.add(b); boards.push(b);
      add('steelDark', F.boxAt(0.4, 2.68, 0.03, bx, 1.55, z1 + 0.05));
    });
    S.dyn.boards = { meshes:boards, cap:-1, sys:'' };
    // floats + tapes
    var fl = new THREE.InstancedMesh(new THREE.SphereGeometry(0.08, 14, 10), F.std('#f0883e', 0.2, 0.4, { emissive:C('#f0883e'), emissiveIntensity:0.35 }), 2);
    fl.frustumCulled = false; scene.add(fl);
    var tapeG = new THREE.BufferGeometry(); tapeG.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    var tape = new THREE.LineSegments(tapeG, new THREE.LineBasicMaterial({ color:C('#c8ced6'), transparent:true, opacity:0.7 })); tape.frustumCulled = false; scene.add(tape);
    [15.45, 17.35].forEach(function (x) { add('steelSatin', F.place(new THREE.TorusGeometry(0.06, 0.015, 6, 12), x, 2.95, 4.95)); });
    S.dyn.floats = { mesh:fl, tape:tape };
    // pour + splash
    var pour = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.035, 1, 8, 6, true).translate(0, -0.5, 0), new THREE.ShaderMaterial({
      uniforms:{ uCol:{ value:C('#c08a3a') }, uOff:{ value:0 }, uA:{ value:0.8 } },
      vertexShader:'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader:'uniform vec3 uCol; uniform float uOff, uA; varying vec2 vUv;\n' + F.FBM_GLSL.replace(/OCT/g, '2') +
        'void main(){ float n = fbm(vec2(vUv.x*8.0, vUv.y*4.0 + uOff)); gl_FragColor = vec4(uCol*(1.0+0.9*n), uA*(0.55+0.45*n));\n #include <tonemapping_fragment>\n #include <colorspace_fragment>\n}',
      transparent:true, depthWrite:false, fog:false }));
    pour.frustumCulled = false; scene.add(pour); v.internalsT.push(pour);
    var pourB = new THREE.Mesh(pour.geometry, pour.material); pourB.frustumCulled = false; scene.add(pourB); v.internalsT.push(pourB);
    var splash = sprite('#9fd0ff', 0.5, 15.2, 1.0, 3.6, 0.0); splash.renderOrder = 960;
    var splashB = sprite('#9fd0ff', 0.5, 17.6, 1.0, 3.6, 0.0); splashB.renderOrder = 960;
    S.dyn.pour = { mesh:pour, splash:splash, meshes:[pour, pourB], splashes:[splash, splashB] };
    // compartment caps
    var caps = [];
    [-1.24, 1.24].forEach(function (cx) {
      var g = new THREE.PlaneGeometry(2.45, 2.55, 6, 6).rotateX(-Math.PI / 2);
      var pa = g.attributes.position, ed = new Float32Array(pa.count);
      for (var i = 0; i < pa.count; i++) ed[i] = Math.max(Math.abs(pa.getX(i)) / 1.225, Math.abs(pa.getZ(i)) / 1.275);
      g.setAttribute('aEdge', new THREE.BufferAttribute(ed, 1)); g.translate(cx, 0, 0);
      var cm = new THREE.Mesh(g, capMat()); cm.position.set(16.4, 0.25, 4.0); scene.add(cm); caps.push(cm);
    });
    v.caps = caps;
    return v;
  })();

  // ═══ FS-401 flare stack (19.5,0,−4.5) ══════════════════════════════════
  (function () {
    var X = 19.5, Z = -4.5;
    add('concrete', F.boxAt(1.6, 0.4, 1.6, X, 0.2, Z));
    add('steelDark', F.cylAB([X, 0.4, Z], [X, 4.5, Z], 0.22, 20)); add('steelDark', F.cylAB([X, 0.4, Z], [X, 0.5, Z], 0.4, 20));
    for (var k = 0; k < 5; k++) add('bands', F.colorize(F.cylAB([X, 4.5 + k * 0.5, Z], [X, 5.0 + k * 0.5, Z], 0.221, 20), k % 2 ? '#e6e6e6' : '#c8322b'));
    add('steelDark', F.cylAB([X, 7.0, Z], [X, 7.8, Z], 0.3, 20, true, 0.26)); add('steelSatin', F.place(new THREE.TorusGeometry(0.34, 0.03, 6, 24), X, 7.75, Z, Math.PI / 2, 0, 0));
    add('steelSatin', F.cylAB([X + 0.34, 0.5, Z], [X + 0.34, 7.9, Z], 0.025, 6));
    add('steelSatin', F.cylAB([19.28, 1.0, Z], [X - 0.2, 1.0, Z], 0.24, 16));
    add('steelDark', F.boxAt(0.5, 0.8, 0.3, 18.2, 0.8, -3.4)); add('steelDark', F.cylAB([18.2, 0, -3.4], [18.2, 0.4, -3.4], 0.04, 6));
    var gp = [], anchors = [60, 180, 300];
    anchors.forEach(function (a) { var r = a * Math.PI / 180, ax = X + 5 * Math.cos(r), az = Z + 5 * Math.sin(r);
      gp.push(X, 6.2, Z, ax, 0.05, az); add('concrete', F.boxAt(0.4, 0.2, 0.4, ax, 0.1, az)); });
    var gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    scene.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color:C('#3a4452'), transparent:true, opacity:0.6 })));
  })();

  // ═══ props: DAQ cabin, light towers, windsock, markings ════════════════
  (function () {
    add('cabin', F.boxAt(6.1, 2.6, 2.44, -8, 1.3 + 0.1, -6.5)); add('steelDark', F.boxAt(6.2, 0.1, 2.54, -8, 2.75, -6.5));
    add('steelDark', F.boxAt(6.0, 0.15, 2.3, -8, 0.08, -6.5));
    [-9.6, -6.6].forEach(function (x) { add('emissive', F.colorize(F.boxAt(1.2, 0.7, 0.02, x, 1.75, -5.27), '#ffb866')); sprite('#ffb060', 1.4, x, 1.75, -5.15, 0.3); });
    add('steelDark', F.boxAt(0.9, 2.0, 0.04, -5.9, 1.1, -5.27)); add('steelSatin', F.boxAt(0.8, 0.6, 0.5, -10.4, 2.1, -5.1));
    add('steelDark', F.cylAB([-5.6, 2.8, -7.2], [-5.6, 4.6, -7.2], 0.02, 6));
    TOWERS.forEach(function (tw) {
      add('steelDark', F.boxAt(1.4, 0.8, 2.2, tw[0], 0.55, tw[2])); add('yellow', F.boxAt(1.42, 0.3, 2.22, tw[0], 0.8, tw[2]));
      add('steelSatin', F.cylAB([tw[0], 0.9, tw[2]], [tw[0], 8.1, tw[2]], 0.07, 10));
      var dx = tw[3][0] - tw[0], dz = tw[3][2] - tw[2], yaw = Math.atan2(dx, dz);
      add('steelDark', F.boxAt(1.4, 0.35, 0.18, tw[0], 8.3, tw[2], 0.5, yaw + Math.PI / 2, 0));
      for (var k = 0; k < 4; k++) {
        var o = (k - 1.5) * 0.33, lx = tw[0] + Math.cos(yaw) * o + Math.sin(yaw) * 0.1, lz = tw[2] - Math.sin(yaw) * o + Math.cos(yaw) * 0.1;
        add('emissive', F.colorize(F.place(new THREE.CircleGeometry(0.12, 16), lx, 8.28, lz, -0.5, yaw, 0), '#fff1d6'));
      }
      sprite('#ffe2b0', 1.8, tw[0] + Math.sin(yaw) * 0.3, 8.3, tw[2] + Math.cos(yaw) * 0.3, 0.8);
      if (T.beams) {
        var cone = new THREE.Mesh(new THREE.ConeGeometry(7, 10, 24, 1, true).translate(0, -5, 0), new THREE.ShaderMaterial({
          uniforms:{ uCol:{ value:C('#ffd9a0') } },
          vertexShader:'varying vec3 vN; varying vec3 vV; varying float vH; void main(){ vH = -position.y/10.0; vec4 w = modelMatrix*vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }',
          fragmentShader:'uniform vec3 uCol; varying vec3 vN; varying vec3 vV; varying float vH; void main(){ float a = 0.05*(1.0-vH)*pow(abs(dot(vV,vN)),1.5); gl_FragColor = vec4(uCol*a, a);\n #include <tonemapping_fragment>\n #include <colorspace_fragment>\n}',
          transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, fog:false }));
        cone.position.set(tw[0], 8.3, tw[2]); cone.lookAt(tw[3][0], tw[3][1], tw[3][2]); cone.rotateX(-Math.PI / 2); cone.renderOrder = 980; scene.add(cone);
        (S.beams = S.beams || []).push(cone);
      }
    });
    // windsock (vertex flutter)
    add('steelSatin', F.cylAB([22.5, 0, -7.5], [22.5, 6.0, -7.5], 0.05, 8));
    var sg = new THREE.ConeGeometry(0.28, 1.5, 14, 6, true).rotateZ(Math.PI / 2).translate(0.75, 0, 0);
    var pa = sg.attributes.position, col = new Float32Array(pa.count * 3), c1 = C('#f0883e'), c2 = C('#e6edf3');
    for (var i = 0; i < pa.count; i++) { var cc = Math.floor(pa.getX(i) / 0.3) % 2 ? c2 : c1; col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b; }
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    var sockU = { uSockPh:{ value:0 } };
    var smat = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.8, side:THREE.DoubleSide, emissive:C('#402010'), emissiveIntensity:0.3 });
    smat.onBeforeCompile = function (sh) { Object.assign(sh.uniforms, sockU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uSockPh;').replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += sin(uSockPh + position.x*4.0)*0.05*position.x; transformed.z += cos(uSockPh*1.3 + position.x*3.0)*0.04*position.x;'); };
    smat.customProgramCacheKey = function () { return 'wtsSock'; };
    var sock = new THREE.Mesh(sg, smat); sock.position.set(22.5, 5.8, -7.5); sock.rotation.y = -Math.atan2(WIND[2], WIND[0]); sock.frustumCulled = false; scene.add(sock);
    S.dyn.sock = sockU;
    // walkway markings (decals)
    var mk = [];
    [[-12, 10.5, 2.9], [-12, 10.5, -2.9]].forEach(function (m) { mk.push(F.place(new THREE.PlaneGeometry(m[1] - m[0], 0.12).rotateX(-Math.PI / 2), (m[0] + m[1]) / 2, 0.026, m[2])); });
    mk.push(F.place(new THREE.PlaneGeometry(0.12, 5.8).rotateX(-Math.PI / 2), 10.5, 0.026, 0));
    var mkm = new THREE.Mesh(F.mergeGeos(mk), new THREE.MeshStandardMaterial({ color:C('#b8891a'), roughness:0.8, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2, depthWrite:false, transparent:true, opacity:0.55 }));
    scene.add(mkm);
    // upstream bund (low kerb, yellow-capped) + front-of-skid props: fills the near-left pad in the overview
    var BX0 = -17.4, BX1 = -4.4, BZ0 = -2.3, BZ1 = 3.3, kh = 0.22, kt = 0.16;
    [[BX0, BZ0, BX1, BZ0], [BX0, BZ1, BX1, BZ1], [BX0, BZ0, BX0, BZ1], [BX1, BZ0, BX1, BZ1]].forEach(function (w) {
      var cx = (w[0] + w[2]) / 2, cz = (w[1] + w[3]) / 2, lx = Math.abs(w[2] - w[0]) + kt, lz = Math.abs(w[3] - w[1]) + kt;
      add('concrete', F.boxAt(lx, kh, lz, cx, kh / 2, cz)); add('yellow', F.boxAt(lx + 0.01, 0.04, lz + 0.01, cx, kh + 0.02, cz));
    });
    // drum pallet (4 × 205 L drums)
    add('rubber', F.boxAt(1.3, 0.13, 1.3, -14.2, 0.065, 4.4));
    [[-14.52, 4.08, 'paintBlue'], [-13.88, 4.08, 'accent'], [-14.52, 4.72, 'paintBlue'], [-13.88, 4.72, 'paintBlue']].forEach(function (d) {
      add(d[2], F.cylAB([d[0], 0.13, d[1]], [d[0], 1.01, d[1]], 0.29, 18));
      add('steelDark', F.cylAB([d[0], 0.4, d[1]], [d[0], 0.43, d[1]], 0.296, 18)); add('steelDark', F.cylAB([d[0], 0.72, d[1]], [d[0], 0.75, d[1]], 0.296, 18));
    });
    // chemical-injection skid (tank + pump on a yellow frame)
    add('steelDark', F.boxAt(1.8, 0.12, 1.1, -10.2, 0.06, 4.7));
    [[-11.05, 4.2], [-9.35, 4.2], [-11.05, 5.2], [-9.35, 5.2]].forEach(function (p) { add('yellow', F.cylAB([p[0], 0.12, p[1]], [p[0], 1.35, p[1]], 0.035, 6)); });
    add('yellow', F.boxAt(1.78, 0.06, 1.06, -10.2, 1.36, 4.7));
    add('steelSatin', F.cylAB([-10.6, 0.12, 4.7], [-10.6, 1.12, 4.7], 0.34, 24)); add('steelSatin', F.place(new THREE.SphereGeometry(0.34, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), -10.6, 1.12, 4.7));
    add('paintBlue', F.boxAt(0.45, 0.3, 0.3, -9.75, 0.28, 4.7)); add('steelDark', F.cylAB([-9.75, 0.43, 4.7], [-9.75, 0.43, 3.4], 0.025, 6));
    // generator set (front, between the chemical skid and the heater) with exhaust stack, status lamp and cable
    add('cabin', F.boxAt(2.4, 1.35, 1.15, -6.4, 0.75, 5.3)); add('steelDark', F.boxAt(2.5, 0.08, 1.25, -6.4, 0.04, 5.3));
    add('steelDark', F.boxAt(2.42, 0.06, 1.17, -6.4, 1.45, 5.3)); add('steelDark', F.cylAB([-5.5, 1.48, 5.1], [-5.5, 2.05, 5.1], 0.06, 10));
    add('emissive', F.colorize(F.boxAt(0.08, 0.08, 0.02, -7.2, 1.1, 5.885), '#3fb950')); sprite('#3fb950', 0.5, -7.2, 1.1, 5.93, 0.35);
    add('rubber', F.cylAB([-7.6, 0.05, 5.0], [-9.3, 0.05, 4.9], 0.035, 6));
  })();

  // ═══ dials: faces merged, needles instanced ════════════════════════════
  (function () {
    var faces = DIALS.map(function (d) {
      var g = new THREE.CircleGeometry(0.13, 32), uv = g.attributes.uv;
      for (var i = 0; i < uv.count; i++) uv.setX(i, (d.face + uv.getX(i)) / 4);
      return F.place(g, d.p[0] + 0.004 * Math.sin(-0.314), d.p[1], d.p[2] + 0.004 * Math.cos(0.314), 0, -0.314, 0);
    });
    var dm = new THREE.MeshStandardMaterial({ roughness:0.35, metalness:0, emissive:C('#ffffff'), emissiveIntensity:0.3 });
    var faceMesh = new THREE.Mesh(F.mergeGeos(faces), dm); scene.add(faceMesh);
    var ng = new THREE.BoxGeometry(0.012, 0.105, 0.004).translate(0, 0.036, 0);
    var needles = new THREE.InstancedMesh(ng, new THREE.MeshBasicMaterial({ color:C('#d6453d') }), DIALS.length);
    needles.frustumCulled = false; scene.add(needles);
    S.dyn.dials = { list:DIALS, mat:dm, needles:needles, ang:new Float32Array(DIALS.length), vel:new Float32Array(DIALS.length), key:'' };
  })();

  // ═══ halos + blob shadows ══════════════════════════════════════════════
  var HALO = { wellhead:[-15, 0, 1.7], esd:[-11.9, 0.5, 1.3], choke:[-7.2, 0, 2.3], heater:[-1.4, 0.3, 2.5], separator:[5.6, 0, 3.9],
               flare:[19.5, -4.5, 1.4], surge:[10.2, 4.0, 1.8], pump:[12.6, 3.6, 1.0], gauge:[16.4, 4.0, 3.2] };
  (function () {
    var hm = new THREE.InstancedMesh(new THREE.RingGeometry(1, 1.07, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2, fog:false, toneMapped:false }), EQ_IDS.length);
    hm.frustumCulled = false; hm.renderOrder = 995; scene.add(hm);
    var cc = new THREE.Color(0, 0, 0), m4 = new THREE.Matrix4();
    for (var i = 0; i < EQ_IDS.length; i++) { m4.makeScale(0.0001, 1, 0.0001); hm.setMatrixAt(i, m4); hm.setColorAt(i, cc); }
    S.dyn.halos = { mesh:hm, pos:HALO };
    var BL = [[-7.2, 0, 4.4, 3.0], [-1.4, 0.4, 4.8, 3.0], [5.6, 0, 7.4, 2.4], [10.2, 4.0, 3.2, 3.2], [12.5, 3.5, 1.2, 2.0], [16.4, 4.0, 5.8, 3.4],
              [19.5, -4.5, 2.2, 2.2], [-8, -6.5, 7.0, 3.4], [-11.6, 0, 1.4, 1.4], [-18.5, 5.0, 2.0, 2.8], [22.0, 3.0, 2.0, 2.8]];
    var bm = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map:tex(F.blobTexture()), transparent:true, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2, color:0xffffff }), BL.length);
    for (var b = 0; b < BL.length; b++) { m4.makeScale(BL[b][2], 1, BL[b][3]); m4.setPosition(BL[b][0], 0.027, BL[b][1]); bm.setMatrixAt(b, m4); }
    bm.renderOrder = 1; scene.add(bm);
  })();

  // ═══ flare flame layers, halo, pilot, smoke, wet streak ═════════════════
  (function () {
    var core = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 16), F.makeFlameMat(T.fbm, 0, 1)); core.frustumCulled = false; core.renderOrder = 961; scene.add(core);
    var outer = null;
    if (T.outer) { outer = new THREE.Mesh(core.geometry, F.makeFlameMat(T.fbm, 37.0, 0.6)); outer.frustumCulled = false; outer.renderOrder = 960; scene.add(outer); }
    var halo = sprite('#ff8a3d', 6, FLAME_BASE[0], FLAME_BASE[1] + 2, FLAME_BASE[2], 0.2); halo.renderOrder = 970;
    var pilot = sprite('#6fa8ff', 0.5, FLAME_BASE[0] + 0.3, FLAME_BASE[1] + 0.15, FLAME_BASE[2], 0.9);
    var smoke = [];
    if (T.smoke) for (var i = 0; i < 6; i++) {
      smoke.push({ s:smokeSprite('#20242a', 1, FLAME_BASE[0], FLAME_BASE[1], FLAME_BASE[2], 0), life:i, max:6 });
    }
    var streak = null;
    if (tier === 'high') {
      streak = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 9).rotateX(-Math.PI / 2).translate(0, 0, 4.5), new THREE.MeshBasicMaterial({ map:gl, color:C('#ff8a3d'), transparent:true,
        opacity:0.3, blending:THREE.AdditiveBlending, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2 }));
      streak.position.set(FLAME_BASE[0], 0.03, FLAME_BASE[2]); streak.frustumCulled = false; streak.renderOrder = 2; scene.add(streak);
    }
    S.dyn.flame = { core:core, outer:outer, halo:halo, pilot:pilot, smoke:smoke, streak:streak, L:0, Lv:0, scroll:0, ph:0, fph:0 };
  })();

  // ═══ vessel particles (one Points per vessel, band b+5) ═════════════════
  function vesselPoints(v, n) {
    var g = new THREE.BufferGeometry(), pos = new Float32Array(n * 3), col = new Float32Array(n * 4), sz = new Float32Array(n);
    var pa = new THREE.BufferAttribute(pos, 3), ca = new THREE.BufferAttribute(col, 4), za = new THREE.BufferAttribute(sz, 1);
    pa.setUsage(THREE.DynamicDrawUsage); ca.setUsage(THREE.DynamicDrawUsage); za.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa); g.setAttribute('aColor', ca); g.setAttribute('aSize', za);
    var p = new THREE.Points(g, F.makePoints(uScale, uDpr)); p.frustumCulled = false; scene.add(p);
    v.points = p;
    v.part = { n:n, pos:pos, col:col, sz:sz, pa:pa, ca:ca, za:za, kind:new Uint8Array(n), a:new Float32Array(n), b:new Float32Array(n), c:new Float32Array(n), life:new Float32Array(n), rnd:mulberry(n * 13 + v.id.length) };
    var r = v.part.rnd;
    for (var i = 0; i < n; i++) { v.part.life[i] = r() * 3; v.part.a[i] = r(); v.part.b[i] = r(); v.part.c[i] = r(); }
  }
  var K = T.vesselK;
  vesselPoints(V101, Math.round((24 + 40 + 30) * K)); V101.partSplit = [Math.round(24 * K), Math.round(64 * K)];
  vesselPoints(T201, Math.round(36 * K)); T201.partSplit = [Math.round(24 * K), Math.round(36 * K)];
  vesselPoints(T301, Math.round(24 * K)); T301.partSplit = [0, Math.round(24 * K)];

  // ═══ batched glow + smoke billboards (one Points each) ═══════════════════
  function batch(list, additive, ro) {
    var n = Math.max(1, list.length), g = new THREE.BufferGeometry();
    var pa = new THREE.BufferAttribute(new Float32Array(n * 3), 3), ca = new THREE.BufferAttribute(new Float32Array(n * 4), 4), za = new THREE.BufferAttribute(new Float32Array(n), 1);
    pa.setUsage(THREE.DynamicDrawUsage); ca.setUsage(THREE.DynamicDrawUsage); za.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa); g.setAttribute('aColor', ca); g.setAttribute('aSize', za);
    var m = F.makePoints(uScale, uDpr, additive, 480, 1); m.fog = false;
    var p = new THREE.Points(g, m); p.frustumCulled = false; p.renderOrder = ro; scene.add(p);
    return { obj:p, list:list, pa:pa, ca:ca, za:za };
  }
  var GB = batch(S.glowItems, true, 970), SB = batch(S.smokeItems, false, 958);
  var GBS = [GB, SB];
  S.flushGlow = function () {
    for (var bi = 0; bi < 2; bi++) { var b = GBS[bi];
      var P = b.pa.array, Cc = b.ca.array, Z = b.za.array;
      for (var i = 0; i < b.list.length; i++) { var it = b.list[i], c = it.material.color, a = it.visible === false ? 0 : it.material.opacity;
        P[i * 3] = it.position.x; P[i * 3 + 1] = it.position.y; P[i * 3 + 2] = it.position.z;
        Cc[i * 4] = c.r; Cc[i * 4 + 1] = c.g; Cc[i * 4 + 2] = c.b; Cc[i * 4 + 3] = a; Z[i] = it.scale.x; }
      b.pa.needsUpdate = b.ca.needsUpdate = b.za.needsUpdate = true;
    }
  };

  // ═══ merge static opaque buckets ═══════════════════════════════════════
  var colorB = { bands:true, emissive:true };
  Object.keys(B).forEach(function (k) {
    if (!B[k].length) return;
    var mesh = new THREE.Mesh(F.mergeGeos(B[k], { color:!!colorB[k] }), M[k]);
    if (T.shadow && k !== 'emissive') { mesh.castShadow = true; mesh.receiveShadow = true; }
    scene.add(mesh);
  });

  S.vesselsById = { separator:V101, heater:H101, surge:T201, gauge:T301 };
  S.flareBaseV = new V3(FLAME_BASE[0], FLAME_BASE[1], FLAME_BASE[2]);
  return S;
}

// shadow bounds (normative §5.10): transform caster box corners into light space
function fitShadow(THREE, light) {
  var cam = light.shadow.camera;
  function once() {
    light.updateMatrixWorld(); light.target.updateMatrixWorld();
    cam.position.copy(light.position); cam.lookAt(light.target.position); cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    var box = { min:[-20, 0, -10], max:[24, 8, 8.5] }, C = boxCorners(box), v = new THREE.Vector3();
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (var i = 0; i < 8; i++) { v.set(C[i][0], C[i][1], C[i][2]).applyMatrix4(cam.matrixWorldInverse);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); }
    return { x0:x0, x1:x1, y0:y0, y1:y1, z0:z0, z1:z1 };
  }
  var b = once(), guard = 0;
  while (-b.z1 < 1 && guard++ < 8) {            // a corner behind the light: back the light off along its direction
    var d = new THREE.Vector3().subVectors(light.position, light.target.position).normalize().multiplyScalar(10);
    light.position.add(d); b = once();
  }
  cam.left = b.x0 - 1; cam.right = b.x1 + 1; cam.bottom = b.y0 - 1; cam.top = b.y1 + 1;
  cam.near = Math.max(0.5, -b.z1 - 1); cam.far = -b.z0 + 1; cam.updateProjectionMatrix();
}

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// horizontal lathe: profile (bottom apex → top apex) rotated to lie along X, local y 0…2R
function latheH(THREE, prof, seg, H, R) {
  var g = new THREE.LatheGeometry(prof.map(function (p) { return new THREE.Vector2(p[0], p[1]); }), seg);
  g.rotateZ(-Math.PI / 2); g.translate(-H / 2, R, 0); return g;
}
function saddleGeo(THREE, rCut, yc, w, depth) {
  var s = new THREE.Shape(), hw = w / 2, i, n = 16;
  s.moveTo(-hw, 0); s.lineTo(hw, 0);
  var zt = Math.min(hw, rCut * 0.98), yTop = function (z) { return yc - Math.sqrt(Math.max(0, rCut * rCut - z * z)); };
  s.lineTo(hw, yTop(zt));
  for (i = 0; i <= n; i++) { var z = zt - 2 * zt * i / n; s.lineTo(z, yTop(z)); }
  s.lineTo(-hw, 0);
  var g = new THREE.ExtrudeGeometry(s, { depth:depth, bevelEnabled:false });
  g.translate(0, 0, -depth / 2); g.rotateY(Math.PI / 2);   // shape x → world z
  return g;
}
function weirGeo(THREE, Ri, crest) {             // circle segment below the crest (fluid-local frame), extruded 0.03
  var n = 24, yc = crest - Ri, pts = [], i;
  var start = Math.asin(clamp(yc / Ri, -1, 1));   // angle of the crest chord end, measured from +z in the (z, y) circle
  for (i = 0; i <= n; i++) { var t = start - (Math.PI + 2 * start) * i / n; pts.push([Math.cos(t) * Ri * 0.99, Ri + Math.sin(t) * Ri * 0.99]); }
  var sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]); sh.lineTo(pts[0][0], pts[0][1]);
  var g = new THREE.ExtrudeGeometry(sh, { depth:0.03, bevelEnabled:false }); g.translate(0, 0, -0.015); g.rotateY(Math.PI / 2);
  return g;
}
// horizontal cap geometry for a 2:1-headed horizontal vessel (fluid-local frame; y rewritten on level change)
function horizCap(THREE, Ri, Ltt, hd, grid) {
  var nx = Math.max(6, grid), xs = [], H = Ltt + 2 * hd, i;
  for (i = 0; i <= nx; i++) { var u = i / nx; xs.push(-H / 2 + H * (0.5 - 0.5 * Math.cos(Math.PI * u))); }
  var n = xs.length, pos = new Float32Array(n * 3 * 3), nrm = new Float32Array(n * 3 * 3), uv = new Float32Array(n * 3 * 2), edge = new Float32Array(n * 3), idx = [];
  for (i = 0; i < n; i++) for (var j = 0; j < 3; j++) { var k = i * 3 + j; nrm[k * 3 + 1] = 1; edge[k] = j === 1 ? 0 : 1; }
  for (i = 0; i < n - 1; i++) for (j = 0; j < 2; j++) { var a = i * 3 + j, b = a + 1, c = a + 3, d = a + 4; idx.push(a, b, c, b, d, c); }   // CCW seen from above (+Y face)
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1)); g.setIndex(idx);
  return { geo:g, xs:xs, Ri:Ri, Ltt:Ltt, hd:hd, y:-1, x0:-1e9, x1:1e9 };
}
function setHorizCap(ci, y, x0, x1) {
  var P = ci.geo.attributes.position.array, U = ci.geo.attributes.uv.array, xs = ci.xs;
  for (var i = 0; i < xs.length; i++) {
    var x = clamp(xs[i], x0, x1), w = capHalfWidth(ci.Ri, ci.Ltt, ci.hd, clamp(y, 0.0005, 2 * ci.Ri - 0.0005), x);
    for (var j = 0; j < 3; j++) { var k = i * 3 + j, z = (j - 1) * w; P[k * 3] = x; P[k * 3 + 1] = 0; P[k * 3 + 2] = z; U[k * 2] = x; U[k * 2 + 1] = z; }
  }
  ci.geo.attributes.position.needsUpdate = true; ci.geo.attributes.uv.needsUpdate = true; ci.geo.computeBoundingSphere();
  ci.y = y; ci.x0 = x0; ci.x1 = x1;
}
function horizCapFlat(THREE, Ri, L, y, n) {
  var w = Ri * Math.sqrt(Math.max(0, 1 - Math.pow((y - Ri) / Ri, 2)));
  var g = new THREE.PlaneGeometry(L, 2 * w, n, 2).rotateX(-Math.PI / 2);
  var pa = g.attributes.position, ed = new Float32Array(pa.count);
  for (var i = 0; i < pa.count; i++) ed[i] = Math.abs(pa.getZ(i)) / Math.max(w, 1e-6);
  g.setAttribute('aEdge', new THREE.BufferAttribute(ed, 1)); return g;
}
function addEdgeRadial(THREE, g) {
  var pa = g.attributes.position, ed = new Float32Array(pa.count);
  for (var i = 0; i < pa.count; i++) ed[i] = Math.sqrt(pa.getX(i) * pa.getX(i) + pa.getZ(i) * pa.getZ(i));
  g.setAttribute('aEdge', new THREE.BufferAttribute(ed, 1));
}

// ═════════════════════════════════════════════════════════════════════════
// §E (cont.) PIPES — rebuilt only when a main-segment NPS changes
// ═════════════════════════════════════════════════════════════════════════
var ROUTE_IDX = {}; (function () { for (var i = 0; i < ROUTES.length; i++) ROUTE_IDX[ROUTES[i].id] = i; })();
function routeRVis(r, nps) {
  if (r.seg >= 0) return pipeRadius(nps[r.seg]);
  if (r.npsSeg != null) return pipeRadius(nps[r.npsSeg]);
  return pipeRadius(r.nps);
}
function buildPipes(F, S, nps) {
  var THREE = F.THREE, T = S.T, scene = S.scene, V3 = THREE.Vector3, i, j;
  if (S.pipes) S.pipes.meshes.forEach(function (m) { scene.remove(m); m.geometry.dispose(); });
  var R = [], glass = [], steel = [], frost = [], dark = [], conc = [];
  for (i = 0; i < ROUTES.length; i++) { var rv = routeRVis(ROUTES[i], nps); R.push({ def:ROUTES[i], rVis:rv, route:buildRoute(ROUTES[i].pts, rv) }); }
  var Lh = function (id) { return R[ROUTE_IDX[id]].route.length; }, base = {};
  base.E1 = 0; base.E2 = Lh('E1') + 0.8; base.E2b = base.E2 + 1.2; base.E3 = base.E2 + Lh('E2') + 0.4;
  base.E3c = base.E3b = base.E3 + Lh('E3'); base.E4a = base.E3c + Lh('E3c') + 14;
  base.E4 = Math.max(base.E4a + Lh('E4a'), base.E3b + Lh('E3b')); var so = base.E4 + Lh('E4') + 6;
  base.G1 = so; base.LW = so; base.LO = so; base.BLK = so; base.LM = so + Lh('LW'); base.VENT = base.LM + Lh('LM') + 5;
  base.X1 = base.LM + Lh('LM') + 5; base.X2 = base.X1 + Lh('X1') + 0.5; base.XA = base.XB = base.X2 + Lh('X2');
  base.DRA = base.DRB = base.XA + Lh('XB') + 3;
  var totalS = 0; for (var k in base) totalS = Math.max(totalS, base[k] + Lh(k));
  function flangeP(pos, d, r, out) {
    var a = v3add(pos, v3scale(d, -0.031)), b = v3add(pos, v3scale(d, -0.001)), c = v3add(pos, v3scale(d, 0.001)), e = v3add(pos, v3scale(d, 0.031));
    out.push(F.cylAB(a, b, r * 1.55, 20)); out.push(F.cylAB(c, e, r * 1.55, 20));
    if (T.bolts) { var n1 = anyPerp(d), n2 = v3cross(d, n1);
      for (var q = 0; q < 8; q++) { var an = q / 8 * Math.PI * 2, o = v3add(pos, v3add(v3scale(n1, Math.cos(an) * r * 1.3), v3scale(n2, Math.sin(an) * r * 1.3)));
        dark.push(F.cylAB(v3add(o, v3scale(d, -0.07)), v3add(o, v3scale(d, 0.07)), 0.02, 6)); } }
  }
  for (i = 0; i < R.length; i++) {
    var rr = R[i], def = rr.def, rvis = rr.rVis, P = rr.route.prims, b0 = base[def.id] || 0;
    for (j = 0; j < P.length; j++) {
      var pr = P[j];
      if (pr.type === 'L') {
        var g = F.cylAB(pr.a, pr.b, rvis, T.radP, true), pa = g.attributes.position, cnt = pa.count;
        var as = new Float32Array(cnt), sg = new Float32Array(cnt).fill(def.aSeg);
        for (var q = 0; q < cnt; q++) as[q] = b0 + pr.s0 + ((pa.getX(q) - pr.a[0]) * pr.dir[0] + (pa.getY(q) - pr.a[1]) * pr.dir[1] + (pa.getZ(q) - pr.a[2]) * pr.dir[2]);
        g.setAttribute('aSeg', new THREE.BufferAttribute(sg, 1)); g.setAttribute('aS', new THREE.BufferAttribute(as, 1));
        glass.push(g);
        if (pr.len > 7) { for (var fs = 6; fs < pr.len - 1; fs += 6) flangeP(v3add(pr.a, v3scale(pr.dir, fs)), pr.dir, rvis, steel); }
        // supports: EL ~1.2 stands, low liquid lines on sleepers
        if (Math.abs(pr.dir[1]) < 0.01 && pr.len > 1.1) {
          var y = pr.a[1];
          if (y > 0.9 && y < 1.4) {
            for (var ss = 0.6; ss < pr.len - 0.4; ss += Math.max(1.2, Math.min(3, pr.len / Math.ceil(pr.len / 3)))) {
              var p = v3add(pr.a, v3scale(pr.dir, ss));
              if (p[0] > -9.2 && p[0] < -5.2) continue;                                   // on the choke skid
              dark.push(F.boxAt(0.3, 0.02, 0.3, p[0], 0.01, p[2])); dark.push(F.boxAt(0.08, y - rvis - 0.02, 0.08, p[0], (y - rvis) / 2, p[2]));
              dark.push(F.place(new THREE.TorusGeometry(rvis + 0.02, 0.018, 4, 10, Math.PI), p[0], y, p[2], 0, Math.abs(pr.dir[0]) > 0.5 ? Math.PI / 2 : 0, Math.PI));
            }
          } else if (y < 0.7) {
            for (var s2 = 0.5; s2 < pr.len - 0.3; s2 += 2.5) { var p2 = v3add(pr.a, v3scale(pr.dir, s2)); conc.push(F.boxAt(Math.abs(pr.dir[0]) > 0.5 ? 0.3 : 0.6, Math.max(0.05, y - rvis), Math.abs(pr.dir[0]) > 0.5 ? 0.6 : 0.3, p2[0], Math.max(0.05, y - rvis) / 2, p2[2])); }
          }
        }
      } else {
        var tg = new THREE.TubeGeometry(new F.FilletArc(pr), 8, rvis * 1.07, T.radP, false);
        (def.aSeg === 2 && def.id !== 'E3b' ? frost : steel).push(tg);
      }
    }
    // flanges at the route ends (nozzle / equipment faces), except at tees
    if (P.length) {
      var f0 = P[0], fl = P[P.length - 1];
      var d0 = f0.type === 'L' ? f0.dir : f0.dIn, d1 = fl.type === 'L' ? fl.dir : fl.dOut;
      var endTee = function (pt) { for (var t = 0; t < TEES.length; t++) if (Math.abs(TEES[t][0] - pt[0]) + Math.abs(TEES[t][1] - pt[1]) + Math.abs(TEES[t][2] - pt[2]) < 0.05) return true; return false; };
      if (!endTee(def.pts[0])) flangeP(v3add(def.pts[0], v3scale(d0, 0.04)), d0, rvis, def.aSeg === 2 ? frost : steel);
      if (!endTee(def.pts[def.pts.length - 1])) flangeP(v3add(def.pts[def.pts.length - 1], v3scale(d1, -0.04)), d1, rvis, steel);
    }
  }
  // PSV-101 discharge header (opaque steel)
  var psv = buildRoute(PSV_ROUTE, pipeRadius(3));
  psv.prims.forEach(function (pr) { if (pr.type === 'L') steel.push(F.cylAB(pr.a, pr.b, pipeRadius(3), T.radP)); else steel.push(new THREE.TubeGeometry(new F.FilletArc(pr), 8, pipeRadius(3) * 1.07, T.radP, false)); });
  TEES.forEach(function (t) { var r = pipeRadius(t[3] === 6 ? nps[2] : 3) * 1.3; steel.push(F.boxAt(r * 2, r * 2, r * 2, t[0], t[1], t[2])); });
  var meshes = [];
  var gm = S.pipeGlassMat;
  if (!gm) {
    var su = S.segU = { col:{ value:[] }, colOld:{ value:[] }, alert:{ value:new Array(14).fill(0) }, frost:{ value:new Array(14).fill(0) }, ph:{ value:new Array(14).fill(0) },
      pulse:{ value:0 }, chev:{ value:T.tracers < 600 ? 1 : 0 }, wave:{ value:1e6 } };
    for (i = 0; i < 14; i++) { su.col.value.push(new THREE.Color(0.6, 0.7, 0.8)); su.colOld.value.push(new THREE.Color(0.6, 0.7, 0.8)); }
    gm = S.pipeGlassMat = F.makeGlass({ side:THREE.FrontSide, opacity:0.16, tier:S.tier, envTex:S.scene.environment, seg:su, rimMax:0.6, envI:1.3 });
  }
  var gmesh = new THREE.Mesh(F.mergeGeos(glass, { seg:true }), gm); gmesh.renderOrder = 900; scene.add(gmesh); meshes.push(gmesh);
  var add = function (list, mat) { if (!list.length) return; var m = new THREE.Mesh(F.mergeGeos(list), mat); if (T.shadow) { m.castShadow = true; m.receiveShadow = true; } scene.add(m); meshes.push(m); };
  add(steel, S.M.steelSatin); add(frost, S.M.frost); add(dark, S.M.steelDark); add(conc, S.M.concrete);
  // tracer sampling tables (position + parallel-transported frame)
  var tables = R.map(function (rr) {
    var L = rr.route.length, step = 0.04, n = Math.max(2, Math.ceil(L / step) + 1), Pp = new Float32Array(n * 3), Nn = new Float32Array(n * 3), Bb = new Float32Array(n * 3);
    var smp = { p:[0, 0, 0], t:[1, 0, 0] }, N = null;
    for (var q = 0; q < n; q++) {
      routeSample(rr.route, Math.min(q * step, L), smp);
      if (!N) N = anyPerp(smp.t); else { var dd = v3dot(N, smp.t); N = v3norm([N[0] - dd * smp.t[0], N[1] - dd * smp.t[1], N[2] - dd * smp.t[2]]); }
      var Bv = v3cross(smp.t, N);
      Pp[q * 3] = smp.p[0]; Pp[q * 3 + 1] = smp.p[1]; Pp[q * 3 + 2] = smp.p[2]; Nn.set(N, q * 3); Bb.set(Bv, q * 3);
    }
    // liquid "downward perpendicular" blend direction per sample (for near-horizontal pipes)
    return { len:L, n:n, step:step, P:Pp, N:Nn, B:Bb, r:rr.rVis, horiz:Math.abs(rr.route.prims.length ? (rr.route.prims[0].dir || [0, 0, 0])[1] : 0) < 0.5 };
  });
  var dra = tables[ROUTE_IDX.DRA], sJ = 0, best = 1e9;
  for (i = 0; i < dra.n; i++) { var dx = dra.P[i * 3] - 17.9, dz = dra.P[i * 3 + 2] - 6.3, dist = dx * dx + dz * dz; if (dist < best) { best = dist; sJ = i * dra.step; } }
  S.pipes = { meshes:meshes, R:R, tables:tables, base:base, totalS:totalS, npsKey:nps.join(','), sDRBjoin:sJ };
  S.renderer && (S.renderer.shadowMap.needsUpdate = true);
  return S.pipes;
}

// ═════════════════════════════════════════════════════════════════════════
// TRACERS — one Points for pipes (+ choke jet, flare embers, frost sparkles)
// ═════════════════════════════════════════════════════════════════════════
function makeTracers(F, S) {
  var THREE = F.THREE, T = S.T, nT = T.tracers, nJ = 6, nE = T.embers, nF = 20, tot = nT + nJ + nE + nF;
  var g = new THREE.BufferGeometry(), pos = new Float32Array(tot * 3), col = new Float32Array(tot * 4), sz = new Float32Array(tot);
  var pa = new THREE.BufferAttribute(pos, 3), ca = new THREE.BufferAttribute(col, 4), za = new THREE.BufferAttribute(sz, 1);
  pa.setUsage(THREE.DynamicDrawUsage); ca.setUsage(THREE.DynamicDrawUsage); za.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', pa); g.setAttribute('aColor', ca); g.setAttribute('aSize', za);
  var pts = new THREE.Points(g, F.makePoints(S.uScale, S.uDpr)); pts.frustumCulled = false; pts.renderOrder = 950; S.scene.add(pts);
  var rnd = mulberry(99);
  var tr = { obj:pts, n:nT, nJ:nJ, nE:nE, nF:nF, pos:pos, col:col, sz:sz, pa:pa, ca:ca, za:za, rnd:rnd,
    edge:new Int16Array(nT), s:new Float32Array(nT), th:new Float32Array(nT), rr:new Float32Array(nT), ph:new Uint8Array(nT), a:new Float32Array(nT), chain:new Uint8Array(nT),
    eLife:new Float32Array(nE), eMax:new Float32Array(nE), ePos:new Float32Array(nE * 3), eVel:new Float32Array(nE * 3),
    edgeV:new Float32Array(ROUTES.length), edgeAct:new Uint8Array(ROUTES.length), nextE:new Int16Array(ROUTES.length), nextS:new Float32Array(ROUTES.length),
    lut:new Float32Array(ROUTES.length * 8 * 3), chainEntry:new Int16Array(CHAIN_DEF.length), inited:false };
  // distribute particles over chains ∝ path length (the multiphase hero chain gets ×1.6 density)
  var tabs = S.pipes.tables, w = [], tw = 0, c, i;
  for (c = 0; c < CHAIN_DEF.length; c++) { var L = 0; CHAIN_DEF[c].edges.forEach(function (id) { L += tabs[ROUTE_IDX[id]].len; }); L *= CHAIN_DEF[c].id === 'MULTI' ? 1.6 : 1; w.push(L); tw += L; }
  var k = 0;
  for (c = 0; c < CHAIN_DEF.length; c++) {
    var cnt = c === CHAIN_DEF.length - 1 ? nT - k : Math.round(nT * w[c] / tw), edges = CHAIN_DEF[c].edges, tl = 0;
    edges.forEach(function (id) { tl += tabs[ROUTE_IDX[id]].len; });
    for (var q = 0; q < cnt && k < nT; q++, k++) {
      var s = rnd() * tl, e = 0;
      while (e < edges.length - 1 && s > tabs[ROUTE_IDX[edges[e]]].len) { s -= tabs[ROUTE_IDX[edges[e]]].len; e++; }
      tr.edge[k] = ROUTE_IDX[edges[e]]; tr.s[k] = s; tr.chain[k] = c; tr.th[k] = rnd() * Math.PI * 2; tr.rr[k] = Math.sqrt(rnd()); tr.a[k] = 0; tr.ph[k] = 0;
    }
  }
  for (i = 0; i < nE; i++) { tr.eLife[i] = rnd() * 3; tr.eMax[i] = 1.5 + rnd() * 1.5; }
  S.tr = tr; return tr;
}
function phasePick(r, fr) { return r < fr.g ? 0 : (r < fr.g + fr.o ? 1 : 2); }
function dispFrac(fr, out) {
  var g = fr.g > 0 ? 0.15 + 0.7 * fr.g : 0, o = fr.o > 0 ? 0.15 + 0.7 * fr.o : 0, w = fr.w > 0 ? 0.15 + 0.7 * fr.w : 0, s = g + o + w;
  if (s <= 0) { out.g = 1; out.o = 0; out.w = 0; return out; }
  out.g = g / s; out.o = o / s; out.w = w / s; return out;
}

// ═════════════════════════════════════════════════════════════════════════
// §F HANDLE — labels, controls, frame loop, bloom, governor, lifecycle
// ═════════════════════════════════════════════════════════════════════════
var CSS_TEXT =
'.wts3d-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:0;outline:none;transition:opacity .15s}\n' +
'.wts3d-leaders{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible}\n' +
'.wts3d-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2}\n' +
'.wts3d-chip{position:absolute;left:0;top:0;min-width:108px;padding:6px 9px 7px;border-radius:7px;pointer-events:auto;cursor:pointer;' +
' background:rgba(13,17,23,.82);border:1px solid rgba(48,54,61,.9);border-left:3px solid rgba(139,148,158,.55);' +
' font-variant-numeric:tabular-nums;color:#e6edf3;will-change:transform;transition:opacity .2s,background-color .4s;white-space:nowrap;box-sizing:border-box}\n' +
'.wts3d-chip .h{font:700 9.5px/1.2 system-ui,sans-serif;letter-spacing:.7px;text-transform:uppercase;color:#8b949e}\n' +
'.wts3d-chip .h .n{color:#c9d1d9;font-weight:700;margin-right:2px}.wts3d-chip .h .g{font-style:normal;margin-left:4px}\n' +
'.wts3d-chip .v{font:600 14px/1.25 ui-monospace,"SF Mono",Menlo,Consolas,monospace;margin-top:1px}\n' +
'.wts3d-chip .p{color:#f0883e}.wts3d-chip .t{color:#58a6ff}.wts3d-chip .l{color:#e6edf3}.wts3d-chip .ar{color:#6e7681;margin:0 3px;font-weight:400}\n' +
'.wts3d-chip u{text-decoration:none;font-size:10px;color:#6e7681;margin:0 4px 0 2px}\n' +
'.wts3d-chip .rg{font:700 9px/1 system-ui,sans-serif;letter-spacing:.5px;padding:2px 5px;border-radius:4px;margin-left:2px;vertical-align:2px}\n' +
'.wts3d-chip .rg:empty{display:none}.wts3d-chip .rg.c{background:rgba(188,140,255,.16);color:#bc8cff}.wts3d-chip .rg.s{background:rgba(139,148,158,.16);color:#8b949e}' +
'.wts3d-chip .rg.l{background:rgba(248,81,73,.18);color:#f85149}.wts3d-chip .rg.a{background:rgba(210,153,34,.18);color:#d29922}.wts3d-chip .rg.h{background:rgba(88,166,255,.16);color:#58a6ff}' +
'.wts3d-chip .rg.g{background:rgba(63,185,80,.16);color:#3fb950}\n' +
'.wts3d-chip .rows{display:none;font-size:11px;color:#8b949e;grid-template-columns:auto auto;gap:2px 10px;margin-top:3px;font-family:system-ui,sans-serif}\n' +
'.wts3d-chip .rows b{font-weight:600;color:#c9d1d9;font-variant-numeric:tabular-nums}\n' +
'.wts3d-chip.t2 .rows{display:grid}.wts3d-chip.t2{min-width:200px}\n' +
'.wts3d-chip[data-st=warn]{border-left-color:#d29922}.wts3d-chip[data-st=alarm]{border-left-color:#f85149;box-shadow:0 0 14px rgba(248,81,73,.35)}\n' +
'.wts3d-chip[data-st=hyd]{border-left-color:#58a6ff}.wts3d-chip[data-st=evt]{border-left-color:#bc8cff}\n' +
'.wts3d-chip[data-st=alarm] .g{color:#f85149}.wts3d-chip[data-st=warn] .g{color:#d29922}.wts3d-chip[data-st=hyd] .g{color:#58a6ff}.wts3d-chip[data-st=evt] .g{color:#bc8cff}\n' +
'.wts3d-chip.sel{outline:1.5px solid #f0883e;outline-offset:1px}.wts3d-chip.flash{background:rgba(248,81,73,.25)}\n' +
'.wts3d-seg{position:absolute;left:0;top:0;height:18px;padding:0 6px;border-radius:9px;font:600 10.5px/18px ui-monospace,Menlo,monospace;' +
' color:#8b949e;background:rgba(13,17,23,.82);pointer-events:none;white-space:nowrap;will-change:transform;transition:opacity .2s;border:1px solid rgba(48,54,61,.7)}\n' +
'.wts3d-seg[data-st=warn]{color:#d29922}.wts3d-seg[data-st=alarm]{color:#f85149}.wts3d-seg[data-st=hyd]{color:#58a6ff}\n' +
'.wts3d-hint{position:absolute;left:50%;bottom:90px;transform:translateX(-50%);padding:6px 12px;border-radius:14px;background:rgba(13,17,23,.88);' +
' color:#c9d1d9;font:500 12px/1.2 system-ui,sans-serif;opacity:0;transition:opacity .3s;pointer-events:none;z-index:3}\n' +
'.wts3d-hint.on{opacity:1}\n' +
'.wts3d-sm .wts3d-chip{min-width:0;padding:4px 7px 5px;border-radius:6px}.wts3d-sm .wts3d-chip .v{font-size:12px}.wts3d-sm .wts3d-chip .h{font-size:8.5px;letter-spacing:.4px}\n' +
'.wts3d-sm .wts3d-chip .h .tt2{display:none}.wts3d-sm .wts3d-chip.t2{min-width:170px}\n' +
'@media (prefers-reduced-motion: reduce){.wts3d-chip,.wts3d-seg{transition:none}}\n';
var _cssUsers = 0;
function injectCss(doc) {
  _cssUsers++;
  if (doc.getElementById('wts3d-css')) return;
  var st = doc.createElement('style'); st.id = 'wts3d-css'; st.textContent = CSS_TEXT; (doc.head || doc.documentElement).appendChild(st);
}
function releaseCss(doc) { _cssUsers = Math.max(0, _cssUsers - 1); if (!_cssUsers) { var st = doc.getElementById('wts3d-css'); if (st && st.parentNode) st.parentNode.removeChild(st); } }

var IMP_UNITS = { pressureG:'psig', pressureTank:'psig', temperature:'°F', gasRate:'MMSCFD', liquidRate:'BPD', volume:'bbl', gasVolume:'MMSCF',
  velocity:'ft/s', length:'ft', lengthSmall:'in', percent:'%', gor:'scf/STB', powerLarge:'MMBtu/hr' };
function fmtNum(v, dp) {
  if (!isFinite(v)) return '—';
  try { return (+v).toLocaleString('en-US', { minimumFractionDigits:dp, maximumFractionDigits:dp }); } catch (e) { return (+v).toFixed(dp); }
}
function defFmtParts(v, cat, dp) {
  if (cat === 'pressureTank' && Math.abs(v) < 0.5) return { v:'ATM', u:'' };
  return { v:fmtNum(v, dp == null ? 1 : dp), u:IMP_UNITS[cat] || '' };
}
function defFmt(v, cat, dp) { var p = defFmtParts(v, cat, dp); return p.u ? p.v + ' ' + p.u : p.v; }
function dpFor(cat, v) {
  var a = Math.abs(num(v, 0));
  switch (cat) {
    case 'pressureG': case 'pressureTank': return a < 100 ? 1 : 0;
    case 'temperature': case 'percent': case 'liquidRate': case 'gor': return 0;
    case 'volume': return a < 100 ? 1 : 0;
    case 'gasRate': return a < 10 ? 2 : 1;
    case 'velocity': return a < 10 ? 1 : 0;
    default: return 1;
  }
}

function createHandle(THREE, container, opts) {
  var F = factory(THREE), doc = G.document, V3 = THREE.Vector3;
  opts = opts || {};
  var fmt = typeof opts.fmt === 'function' ? opts.fmt : defFmt;
  var fmtParts = typeof opts.fmtParts === 'function' ? opts.fmtParts : defFmtParts;
  var units = opts.units || { system:'imperial', conv:function (v, cat) { return { value:v, unit:IMP_UNITS[cat] || '' }; } };
  var cb = { pick:opts.onPick, action:opts.onAction, error:opts.onError, stats:opts.onStats };
  var H = {}, disposed = false, disposing = false, lost = false, paused = false;
  var stats = { fps:0, cpuMs:0, gpuMs:null, drawCalls:0, triangles:0, quality:'high', dpr:1, lowPerf:false, vsyncCapped:false, postCalls:0 };
  var listeners = [];
  function on(t, ev, fn, o) { t.addEventListener(ev, fn, o); listeners.push([t, ev, fn, o]); }

  // ── DOM ─────────────────────────────────────────────────────────────────
  injectCss(doc);
  try { var cs = G.getComputedStyle ? G.getComputedStyle(container) : null; if (cs && cs.position === 'static') container.style.position = 'relative'; } catch (e) {}
  var canvas = doc.createElement('canvas'); canvas.className = 'wts3d-canvas'; canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'Live 3D process view');
  var SVGNS = 'http://www.w3.org/2000/svg';
  var svg = doc.createElementNS(SVGNS, 'svg'); svg.setAttribute('class', 'wts3d-leaders rp-skip');
  var labelsEl = doc.createElement('div'); labelsEl.className = 'wts3d-labels rp-skip';
  var hintEl = doc.createElement('div'); hintEl.className = 'wts3d-hint rp-skip'; hintEl.textContent = 'Click the view to zoom · Ctrl+scroll';
  container.appendChild(canvas); container.appendChild(svg); container.appendChild(labelsEl); container.appendChild(hintEl);

  // ── renderer (created once per mount; antialias decided here, D42) ──────
  var renderer, software = false, mobile = false;
  try {
    var probe = canvas.getContext('webgl2', { antialias:false, alpha:false, powerPreference:'high-performance', preserveDrawingBuffer:false });
    if (!probe) throw mkErr('no-webgl', 'webgl2 context failed');
    try { var dbg = probe.getExtension('WEBGL_debug_renderer_info'); var rs = dbg ? String(probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
          software = /swiftshader|llvmpipe|software/i.test(rs); } catch (e) {}
    // The probe context is re-used by three only if the attributes match; recreate the canvas when antialias is wanted.
    if (!software) {
      var le = probe.getExtension('WEBGL_lose_context'); if (le) le.loseContext();
      var c2 = doc.createElement('canvas'); c2.className = canvas.className; c2.tabIndex = 0; c2.setAttribute('aria-label', canvas.getAttribute('aria-label'));
      container.replaceChild(c2, canvas); canvas = c2;
    }
    renderer = new THREE.WebGLRenderer({ canvas:canvas, antialias:!software, alpha:false, powerPreference:'high-performance', preserveDrawingBuffer:false });
  } catch (e) { cleanupDom(); throw e && e.code ? e : mkErr('no-webgl', 'renderer', e); }
  try { var ua = (G.navigator && G.navigator.userAgent) || ''; mobile = /iP(hone|od|ad)|Android/.test(ua) || (/MacIntel/.test((G.navigator && G.navigator.platform) || '') && G.navigator.maxTouchPoints > 1); } catch (e) {}
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.05; renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  var gl = renderer.getContext();
  var qualityPref = opts.quality || 'auto', autoTier = pickTier({ software:software, mobile:mobile });
  var tier = qualityPref === 'auto' ? autoTier : qualityPref;
  if (!TIERS[tier]) tier = autoTier;
  var dprBase = 1, govScale = 1;
  function devDpr() { return num(G.devicePixelRatio, 1) || 1; }
  function applyDpr() { var d = Math.max(TIERS[tier].dprFloor, Math.min(devDpr(), TIERS[tier].dprCap) * govScale); renderer.setPixelRatio(d); stats.dpr = d; return d; }

  var camera = new THREE.PerspectiveCamera(36, 1, 0.5, 600);
  var S = null, env = null, bloom = null;
  var N = makeNorm();
  var W = 0, Hh = 0, fitR = 40, insets = opts.insets || { top:0, bottom:0, left:0, right:0, card:null };
  var overlay = opts.overlay || 'phase', labelMode = opts.labels || 'all', reducedMotion = !!opts.reducedMotion, autoOrbit = !!opts.orbit, maxMode = false;
  var selected = null, hoverId = null, hoverT = 0;

  // ── camera state ────────────────────────────────────────────────────────
  var cam = { tgt:new V3(2, 2, 0), gTgt:new V3(2, 2, 0), r:40, gR:40, th:-0.314, gTh:-0.314, ph:1.19, gPh:1.19, vTh:0, vPh:0 };
  var tween = null, userMoved = false, needsFit = true, lastInput = -1e9, nudge = 0, introPending = !!opts.intro && !reducedMotion;
  function defaultView() { return (W > 1 && Hh > 1 && W / Hh < 1.2) ? 'process' : 'overview'; }
  function clampCam() {
    cam.gPh = clamp(cam.gPh, 0.14, 1.5); cam.gR = clamp(cam.gR, 3.5, Math.max(95, 1.3 * fitR));
    cam.gTgt.x = clamp(cam.gTgt.x, -20, 24); cam.gTgt.y = clamp(cam.gTgt.y, 0, 10); cam.gTgt.z = clamp(cam.gTgt.z, -10, 8.5);
  }
  function camFinite() { return isFinite(cam.r + cam.gR + cam.th + cam.gTh + cam.ph + cam.gPh + cam.tgt.x + cam.tgt.y + cam.tgt.z + cam.gTgt.x + cam.gTgt.y + cam.gTgt.z); }
  function applyCamera() {
    var sp = Math.sin(cam.ph);
    camera.position.set(cam.tgt.x + cam.r * sp * Math.sin(cam.th), cam.tgt.y + cam.r * Math.cos(cam.ph), cam.tgt.z + cam.r * sp * Math.cos(cam.th));
    if (nudge > 0) { var a = 0.03 * nudge; camera.position.x += Math.sin(nudge * 90) * a; camera.position.y += Math.cos(nudge * 77) * a; }
    camera.lookAt(cam.tgt); camera.updateMatrixWorld();
  }
  function viewTarget(name) {
    var vw = VIEWS[name] || VIEWS.overview, box;
    if (!vw.groups) box = FIT_PTS;
    else {
      box = { min:[1e9, 1e9, 1e9], max:[-1e9, -1e9, -1e9] };
      vw.groups.forEach(function (g) { var b = EQ_BOX[g]; for (var i = 0; i < 3; i++) { box.min[i] = Math.min(box.min[i], b[0][i]); box.max[i] = Math.max(box.max[i], b[1][i]); } });
      if (vw.flame && S && S.dyn.flame) box.max[1] = Math.max(box.max[1], FLAME_BASE[1] + S.dyn.flame.Lv + 0.8);
    }
    var f = fitView(box, vw.az, vw.el, 36, Math.max(W, 2), Math.max(Hh, 2), insets);
    return { tgt:f.target, r:f.radius * (vw.margin || 1), th:vw.az * Math.PI / 180, ph:(90 - vw.el) * Math.PI / 180 };
  }
  function startTween(to, dur) {
    var dTh = to.th - cam.th; dTh = ((dTh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    tween = { t:0, dur:reducedMotion ? 0.15 : dur, f:{ x:cam.tgt.x, y:cam.tgt.y, z:cam.tgt.z, r:cam.r, th:cam.th, ph:cam.ph },
              to:{ x:to.tgt[0], y:to.tgt[1], z:to.tgt[2], r:to.r, th:cam.th + dTh, ph:to.ph } };
  }
  function jumpTo(to) {
    cam.tgt.set(to.tgt[0], to.tgt[1], to.tgt[2]); cam.gTgt.copy(cam.tgt); cam.r = cam.gR = to.r; cam.th = cam.gTh = to.th; cam.ph = cam.gPh = to.ph; tween = null;
  }
  function refit(instant) {
    if (W < 2 || Hh < 2 || paused) { needsFit = true; return; }
    needsFit = false;
    var ov = viewTarget('overview'); fitR = ov.r;
    if (S) { scene().fog.density = 0.25 / fitR; S.groundU.uFitR.value = fitR; }
    if (userMoved) return;
    var to = viewTarget(defaultView());
    if (instant) jumpTo(to); else startTween(to, 0.5);
  }
  function scene() { return S.scene; }

  // ── labels ──────────────────────────────────────────────────────────────
  var chips = [], segChips = [], chipById = {};
  function mkChip(id) {
    var el = doc.createElement('div'); el.className = 'wts3d-chip'; el.setAttribute('data-st', 'ok'); el.setAttribute('data-id', id);
    el.innerHTML = '<div class="h"><b class="n"></b> <span class="tt"></span> <i class="g"></i></div><div class="v"><span class="s0"></span><u class="u0"></u><span class="ar"></span><span class="s1"></span><u class="u1"></u><span class="rg"></span></div><div class="rows"></div>';
    labelsEl.appendChild(el);
    var q = function (s) { return el.querySelector(s); };
    q('.n').textContent = STEP[id]; q('.tt').innerHTML = TAGS[id] + '<span class="tt2"> · ' + TITLES[id] + '</span>';
    var ch = { id:id, el:el, s0:q('.s0'), u0:q('.u0'), ar:q('.ar'), s1:q('.s1'), u1:q('.u1'), rg:q('.rg'), g:q('.g'), rows:q('.rows'),
      txt:{}, st:'ok', w:120, h:44, measure:true, vis:false, lodVis:undefined, t2:false, x:-999, y:-999, op:-1, cls:'', anchor:new V3().fromArray(ANCHORS[id]),
      sx:0, sy:0, behind:false, dRel:1, dist:0, occ:false, flashT:0, path:null, dot:null, prio:0 };
    ch.path = doc.createElementNS(SVGNS, 'path'); ch.path.setAttribute('fill', 'none'); ch.path.setAttribute('stroke', 'rgba(139,148,158,.55)'); ch.path.setAttribute('stroke-width', '1');
    ch.dot = doc.createElementNS(SVGNS, 'circle'); ch.dot.setAttribute('r', '2.5'); ch.dot.setAttribute('fill', 'rgba(201,209,217,.8)');
    svg.appendChild(ch.path); svg.appendChild(ch.dot);
    on(el, 'pointerenter', function () { hoverId = id; hoverT = now(); });
    on(el, 'pointerleave', function () { if (hoverId === id) hoverId = null; });
    on(el, 'click', function (e) { e.stopPropagation(); doPick(id); });
    chips.push(ch); chipById[id] = ch; return ch;
  }
  EQ_IDS.forEach(mkChip);
  SEG_CHIPS.forEach(function (sc) {
    var el = doc.createElement('div'); el.className = 'wts3d-seg'; labelsEl.appendChild(el);
    segChips.push({ def:sc, el:el, txt:'', st:'ok', w:90, h:18, measure:true, vis:false, x:-999, y:-999, anchor:new V3().fromArray(sc.at), sx:0, sy:0, behind:false, dRel:1, show:false, op:-1 });
  });
  var allChips = chips.concat(segChips);
  var LR = allChips.map(function () { return { w:100, h:40, prio:0, pref:'n', seg:false }; });
  var LA = allChips.map(function () { return { x:0, y:0, hide:true }; });
  var LO = [], LORD = [], LINS = { top:0, bottom:0, left:0, right:0, card:null, obs:null };
  var OBST = [{ box:V101_BOX }, { box:{ min:[9.0, 0.9, 2.8], max:[11.4, 5.7, 5.2] } }, { box:{ min:[13.9, 0.25, 2.7], max:[18.9, 2.85, 5.3] } }].map(function (o) { o.x0 = o.y0 = o.x1 = o.y1 = 0; o.on = false; return o; });
  var lastSmall = null, labelDirty = true, layoutDirty = true, lastTextT = -1, lastFlowSeq = -1, lastAlarmV = -1, lastSel = null, _pv = new V3();
  function setTxt(ch, key, el, val) { if (ch.txt[key] !== val) { ch.txt[key] = val; el.textContent = val; ch.measure = true; } }
  function setCls(el, cache, key, val) { if (cache[key] !== val) { cache[key] = val; el.className = val; } }
  function P(v, cat) { return fmtParts(v, cat, dpFor(cat, v)); }
  function FV(v, cat, dp) { return fmt(v, cat, dp == null ? dpFor(cat, v) : dp); }
  function dT(v) { return units.system === 'metric' ? fmtNum(v * 5 / 9, 0) + ' °C' : fmtNum(v, 0) + ' °F'; }
  function rows(ch, list) {
    var h = ''; for (var i = 0; i < list.length; i += 2) h += '<span>' + list[i] + '</span><b>' + esc(list[i + 1]) + '</b>';
    if (ch.txt.rows !== h) { ch.txt.rows = h; ch.rows.innerHTML = h; ch.measure = true; }
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }
  function slot(ch, a, ca, ua, b, cbb, ub, arrow, rg, rgc) {
    var pa = a == null ? null : P(a, ca), pb = b == null ? null : P(b, cbb);
    setTxt(ch, 's0', ch.s0, pa ? pa.v : ''); setTxt(ch, 'u0', ch.u0, pa ? pa.u : '');
    setTxt(ch, 'ar', ch.ar, arrow || ''); setTxt(ch, 's1', ch.s1, pb ? pb.v : ''); setTxt(ch, 'u1', ch.u1, pb ? pb.u : '');
    setTxt(ch, 'rg', ch.rg, rg || '');
    setCls(ch.rg, ch.txt, 'rgc', 'rg ' + (rgc || ''));
    setCls(ch.s0, ch.txt, 's0c', ua === 'T' ? 't' : ua === 'L' ? 'l' : 'p');
    setCls(ch.s1, ch.txt, 's1c', ub === 'T' ? 't' : ub === 'L' ? 'l' : 'p');
  }
  function inletTxt(a, b) { return a && b ? 'A+B' : a ? 'A' : b ? 'B' : '—'; }
  function updateLabelText() {
    var n = N, i;
    for (i = 0; i < chips.length; i++) {
      var ch = chips[i], id = ch.id, st = statusForEq(n.alarms, id);
      if (st !== ch.st) { if (st === 'alarm' && ch.st !== 'alarm' && !reducedMotion) { ch.flashT = now(); ch.el.classList.add('flash'); } ch.st = st; ch.el.setAttribute('data-st', st); layoutDirty = true; }
      setTxt(ch, 'g', ch.g, st === 'alarm' ? '⚠' : st === 'warn' ? '▲' : st === 'hyd' ? '❄' : st === 'evt' ? '●' : '');
      var nd = n.nodes, sp = n.sep, su = n.surge, ga = n.gauge, t2 = ch.t2;
      switch (id) {
        case 'wellhead':
          slot(ch, nd.wellhead.P, 'pressureG', 'P', nd.wellhead.T, 'temperature', 'T');
          if (t2) rows(ch, ['Hydrate T', FV(nd.wellhead.th, 'temperature'), 'Gas', FV(n.inp.Qg * n.f, 'gasRate'), 'Oil', FV(n.inp.Qo * n.f, 'liquidRate'),
            'Water', FV(n.inp.Qw * n.f, 'liquidRate'), 'GOR', n.inp.Qo > 0 ? FV(n.inp.Qg * 1e6 / n.inp.Qo, 'gor') : '—']);
          break;
        case 'esd': {
          var e = n.esd, closed = e.travel < 0.02, moving = e.travel > 0.02 && e.travel < 0.98;
          if (closed) { slot(ch, nd.wellhead.P, 'pressureG', 'P', nd.esd.P, 'pressureG', 'P', ' / ', e.manual ? 'CLOSED · MANUAL' : (e.tripped ? 'TRIPPED' : 'CLOSED'), e.manual ? 'a' : 'l'); }
          else slot(ch, nd.esd.P, 'pressureG', 'P', null, null, null, '', moving ? 'CLOSING ' + Math.round((1 - e.travel) * 100) + '%' : 'OPEN', moving ? 'a' : 'g');
          if (t2) rows(ch, ['Pressure', FV(nd.esd.P, 'pressureG'), 'Travel', Math.round(e.travel * 100) + ' % open', 'Cause', e.causeMsg || '—']);
          break; }
        case 'choke': {
          var c = nd.choke, rg = c.flowLimited ? 'LIMITED' : c.regime === 'Critical' ? 'CRITICAL' : c.regime === 'Subcritical' ? 'SUBCRITICAL' : 'NO FLOW';
          slot(ch, c.Pin, 'pressureG', 'P', c.P, 'pressureG', 'P', '→', rg, c.flowLimited ? 'l' : c.regime === 'Critical' ? 'c' : 's');
          if (t2) rows(ch, ['Bean', Math.round(c.bean) + '/64″', 'ΔP', FV(c.Pin - c.P, 'pressureG'), 'T out', FV(c.T, 'temperature'), 'J-T ΔT', dT(c.dTjt)].concat(c.hyd ? ['❄', 'HYDRATE RISK'] : []));
          break; }
        case 'heater': {
          var h = nd.heater;
          if (h.bypass) slot(ch, h.P, 'pressureG', 'P', h.T, 'temperature', 'T', '', 'BYPASSED', 'a');
          else slot(ch, h.P, 'pressureG', 'P', h.T, 'temperature', 'T', '', '', '');
          if (t2) rows(ch, ['T in → out', FV(h.Tin, 'temperature') + ' → ' + FV(h.T, 'temperature'), 'Firing', Math.round(clamp(h.firing, 0, 1) * 100) + ' %', 'Duty', FV(h.dutyMMBtuHr, 'powerLarge', 2)]);
          break; }
        case 'separator':
          slot(ch, sp.P, 'pressureG', 'P', sp.c1fracL * 100, 'percent', 'L', '', '% LIQ', 's');
          setTxt(ch, 'u1', ch.u1, '');
          if (t2) rows(ch, ['Temperature', FV(sp.T, 'temperature'), 'Setpoint', FV(sp.SP, 'pressureG') + (Math.abs(sp.SPeff - sp.SP) > 0.5 ? ' (ramp ' + FV(sp.SPeff, 'pressureG') + ')' : ''),
            'Interface', Math.round(sp.c1fracW * 100) + ' %', 'Oil bucket', Math.round(sp.bfrac * 100) + ' %', 'Gas out', FV(sp.gasOut_mmscfd, 'gasRate'),
            'Oil dump', FV(sp.oil.q_bpd, 'liquidRate'), 'Water dump', FV(sp.wat.q_bpd, 'liquidRate'), 'Residence', sp.tRes_min < 9000 ? fmtNum(sp.tRes_min, 1) + ' min' : '—']);
          break;
        case 'flare':
          slot(ch, nd.flare.qMMscfd, 'gasRate', 'P', nd.flare.P, 'pressureG', 'P', ' · ', nd.flare.qMMscfd < 0.01 ? 'PILOT' : '', 's');
          setCls(ch.s0, ch.txt, 's0c', 'l');
          if (t2) rows(ch, ['Line P (u/s hdr)', FV(nd.flare.Pline, 'pressureG'), 'Line velocity', Math.round(n.segs[4].vPct) + ' % of limit', 'Flared', FV(n.cum.flare_mmscf, 'gasVolume', 3)]);
          break;
        case 'surge':
          slot(ch, su.frac * 100, 'percent', 'L', su.P, 'pressureTank', 'P', ' · ', su.blocked ? 'IN BLOCKED' : 'IN ' + inletTxt(su.comps[0].inlet, su.comps[1].inlet), su.blocked ? 'l' : 's');
          if (t2) { var fill = n.lines.sep_oil.q + n.lines.sep_water.q - su.pump_q;
            rows(ch, ['A · B', Math.round(su.comps[0].frac * 100) + ' % · ' + Math.round(su.comps[1].frac * 100) + ' %', 'Volume', FV(su.Vo_bbl + su.Vw_bbl, 'volume'),
              'Pump', su.pumpFailed ? 'FAILED' : su.pumpTripped ? 'TRIPPED' : su.pumpBlocked ? 'BLOCKED' : su.pumpOn ? 'ON' : 'OFF',
              'Suction', su.suction === 'both' ? 'A + B' : su.suction, 'Auto-divert', su.autoOn ? 'ON' : 'OFF', 'Net fill', FV(fill, 'liquidRate'),
              'Time to HH', su.tFull_s >= 0 ? fmtNum(su.tFull_s / 60, 0) + ' min' : '—']); }
          break;
        case 'pump': {
          var pst = su.pumpFailed ? 'FAILED' : su.pumpTripped ? 'TRIPPED' : su.pumpOn ? 'ON' : 'OFF';
          slot(ch, null, null, null, su.pump_q, 'liquidRate', 'L', '', pst, su.pumpOn && !su.pumpFailed && !su.pumpTripped ? 'g' : (su.pumpFailed || su.pumpTripped ? 'l' : 's'));
          break; }
        case 'gauge':
          slot(ch, ga.tanks[0].Vo_bbl + ga.tanks[0].Vw_bbl, 'volume', 'L', ga.tanks[1].Vo_bbl + ga.tanks[1].Vw_bbl, 'volume', 'L', ' · ',
            ga.blocked ? 'IN BLOCKED' : inletTxt(ga.tanks[0].inlet, ga.tanks[1].inlet) + ' FILLING', ga.blocked ? 'l' : 's');
          if (t2) rows(ch, ['A', ga.tanks[0].state + (ga.tanks[0].inlet ? ' · inlet open' : ''), 'B', ga.tanks[1].state + (ga.tanks[1].inlet ? ' · inlet open' : ''),
            'Auto-divert', ga.autoOn ? 'ON' : 'OFF', 'Last batch', ga.lastRate >= 0 ? FV(ga.lastRate, 'liquidRate') + ' (STB/d)' : '—',
            'BS&W', ga.lastBsw >= 0 ? fmtNum(ga.lastBsw, 1) + ' %' : '—']);
          break;
      }
    }
    for (i = 0; i < segChips.length; i++) {
      var sc = segChips[i], d = sc.def, vel, pct, stt = 'ok';
      if (d.seg != null) { var sg = n.segs[d.seg]; vel = sg.vel; pct = sg.vPct; stt = sg.hydR ? 'hyd' : sg.vSt === 'EXCEED' ? 'alarm' : sg.vSt === 'WARNING' ? 'warn' : 'ok'; }
      else { var ln = n.lines[d.line]; vel = ln.vel; pct = vel / 10 * 100; }
      var pv = P(vel, 'velocity'), tx = pv.v + ' ' + pv.u + ' · ' + Math.round(pct) + '%';
      if (sc.txt !== tx) { sc.txt = tx; sc.el.textContent = tx; sc.measure = true; }
      if (sc.st !== stt) { sc.st = stt; sc.el.setAttribute('data-st', stt); layoutDirty = true; }
    }
    labelDirty = false; layoutDirty = true;
  }
  var occT = 0, _ray = { o:[0, 0, 0], d:[0, 0, 0] };
  function rayBoxT(o, d, c, s) {
    var t0 = -1e9, t1 = 1e9;
    for (var i = 0; i < 3; i++) {
      var mn = c[i] - s[i] / 2, mx = c[i] + s[i] / 2;
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn || o[i] > mx) return -1; continue; }
      var a = (mn - o[i]) / d[i], b = (mx - o[i]) / d[i]; if (a > b) { var tt = a; a = b; b = tt; }
      if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return -1;
    }
    return t1 < 0 ? -1 : Math.max(t0, 0);
  }
  function placeLabels(force) {
    var i, n = allChips.length, cp = camera.position, rect = labelsEl.getBoundingClientRect ? null : null;
    // 1. measure (batch reads)
    for (i = 0; i < n; i++) { var c = allChips[i]; if (c.measure && c.el.offsetWidth) { c.w = c.el.offsetWidth; c.h = c.el.offsetHeight; c.measure = false; } }
    var labOff = labelMode === 'off', small = W < 600;
    if (small !== lastSmall) { lastSmall = small; labelsEl.classList.toggle('wts3d-sm', small); for (var q = 0; q < n; q++) { var cq = allChips[q]; if (cq.el.offsetWidth) { cq.w = cq.el.offsetWidth; cq.h = cq.el.offsetHeight; cq.measure = false; } else cq.measure = true; } }
    var tNow = now(), nearest = null, nd = 1e9;
    for (i = 0; i < chips.length; i++) {
      var ch = chips[i];
      _pv.copy(ch.anchor); ch.dist = cp.distanceTo(_pv); ch.dRel = ch.dist / Math.max(fitR, 1);
      _pv.project(camera); ch.behind = _pv.z > 1 || _pv.z < -1;
      ch.sx = (_pv.x + 1) / 2 * W; ch.sy = (1 - _pv.y) / 2 * Hh;
      ch.lodVis = lodForDistance(ch.dRel, ch.lodVis);
      if (ch.dist < nd) { nd = ch.dist; nearest = ch; }
    }
    for (i = 0; i < chips.length; i++) {
      var c2 = chips[i], abn = c2.st === 'alarm' || c2.st === 'warn' || c2.st === 'hyd', isSel = selected === c2.id;
      var off = c2.behind || c2.sx < -40 || c2.sx > W + 40 || c2.sy < -40 || c2.sy > Hh + 40;
      c2.want = !labOff && !off && (c2.lodVis || abn || isSel);
      var hov = hoverId === c2.id && tNow - hoverT > 120;
      var t2 = c2.want && (hov || isSel || (tier !== 'low' && c2 === nearest && c2.dist < 0.35 * fitR && !selected && !hoverId));
      if (t2 !== c2.t2) { c2.t2 = t2; c2.el.classList.toggle('t2', t2); c2.measure = true; labelDirty = true; }
      LR[i].prio = c2.st === 'alarm' ? 0 : isSel ? 1 : (c2.st === 'warn' || c2.st === 'hyd') ? 2 : 3 + EQ_IDS.indexOf(c2.id) * 0.01;
      LR[i].pref = PREF_SIDE[c2.id]; LR[i].seg = false; LR[i].w = c2.w; LR[i].h = c2.h;
      LA[i].x = c2.sx; LA[i].y = c2.sy; LA[i].hide = !c2.want;
    }
    for (var j = 0; j < segChips.length; j++) {
      var sc = segChips[j], k = chips.length + j;
      _pv.copy(sc.anchor); var dist = cp.distanceTo(_pv); sc.dRel = dist / Math.max(fitR, 1); _pv.project(camera);
      sc.behind = _pv.z > 1 || _pv.z < -1; sc.sx = (_pv.x + 1) / 2 * W; sc.sy = (1 - _pv.y) / 2 * Hh;
      var abnS = sc.st !== 'ok';
      sc.want = !labOff && !sc.behind && ((labelMode === 'all' && sc.dRel < 0.75 && !small) || overlay === 'erosion' || abnS);
      if (sc.def.line && !N.lines[sc.def.line].active && !abnS) sc.want = sc.want && overlay === 'erosion';
      LR[k].prio = abnS ? 2.5 : 5; LR[k].pref = 'n'; LR[k].seg = true; LR[k].w = sc.w; LR[k].h = sc.h;
      LA[k].x = sc.sx; LA[k].y = sc.sy; LA[k].hide = !sc.want;
    }
    for (var ob = 0; ob < OBST.length; ob++) {
      var O = OBST[ob], bx = O.box, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, beh = false;
      for (var ci = 0; ci < 8; ci++) { _pv.set(ci & 1 ? bx.max[0] : bx.min[0], ci & 2 ? bx.max[1] : bx.min[1], ci & 4 ? bx.max[2] : bx.min[2]).project(camera);
        if (_pv.z > 1) beh = true; var px = (_pv.x + 1) / 2 * W, py = (1 - _pv.y) / 2 * Hh; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
      // shrink to the vessel core (the box corners overstate a cylinder) so chips may overlap its silhouette edges
      var sx = (x1 - x0) * 0.12, sy = (y1 - y0) * 0.12;
      O.x0 = x0 + sx; O.x1 = x1 - sx; O.y0 = y0 + sy; O.y1 = y1 - sy; O.on = !beh && (x1 - x0) < W * 0.8;
    }
    LINS.top = insets.top; LINS.bottom = insets.bottom; LINS.left = insets.left; LINS.right = insets.right; LINS.card = insets.card; LINS.obs = OBST;
    layoutLabels(LR, LA, { w:W, h:Hh }, LINS, LO, LORD);
    // 2. writes
    for (i = 0; i < n; i++) {
      var cc = allChips[i], o = LO[i], isEq = i < chips.length;
      var vis = o && o.vis;
      var op = !vis ? 0 : (isEq ? ((!o.ok ? 0.45 : 1) * (cc.occ ? 0.35 / (o.ok ? 1 : 0.45) : 1) * (selected && selected !== cc.id ? 0.4 : 1)) : 1);
      if (vis && (Math.abs(o.x - cc.x) > 0.5 || Math.abs(o.y - cc.y) > 0.5 || force)) { cc.x = o.x; cc.y = o.y; cc.el.style.transform = 'translate3d(' + Math.round(o.x) + 'px,' + Math.round(o.y) + 'px,0)'; }
      if (op !== cc.op) { cc.op = op; cc.el.style.opacity = op; cc.el.style.visibility = op > 0 ? 'visible' : 'hidden'; }
      if (isEq) {
        var showL = vis && Math.hypot(cc.sx - (o.x + cc.w / 2), cc.sy - (o.y + cc.h / 2)) > 12 + Math.min(cc.w, cc.h) / 2;
        if (showL) {
          var cx = clamp(cc.sx, o.x, o.x + cc.w), cy = clamp(cc.sy, o.y, o.y + cc.h);
          var dx = cx - cc.sx, dy = cy - cc.sy, m = Math.min(Math.abs(dx), Math.abs(dy));
          var ex = cc.sx + Math.sign(dx) * m, ey = cc.sy + Math.sign(dy) * m;
          var d = 'M' + cc.sx.toFixed(1) + ' ' + cc.sy.toFixed(1) + 'L' + ex.toFixed(1) + ' ' + ey.toFixed(1) + 'L' + cx.toFixed(1) + ' ' + cy.toFixed(1);
          if (cc.pd !== d) { cc.pd = d; cc.path.setAttribute('d', d); cc.dot.setAttribute('cx', cc.sx.toFixed(1)); cc.dot.setAttribute('cy', cc.sy.toFixed(1)); }
          var sty = (cc.occ ? '0.35' : '1') + (cc.st === 'alarm' ? 'a' : '');
          if (cc.lsty !== sty) { cc.lsty = sty; cc.path.setAttribute('opacity', op); cc.path.setAttribute('stroke-dasharray', cc.occ ? '3 3' : ''); cc.dot.setAttribute('fill', cc.st === 'alarm' ? '#f85149' : 'rgba(201,209,217,.8)'); }
          cc.path.setAttribute('opacity', op * 0.9); cc.dot.setAttribute('opacity', op);
        } else if (cc.pd !== '') { cc.pd = ''; cc.path.setAttribute('d', ''); cc.dot.setAttribute('opacity', '0'); }
      }
    }
    layoutDirty = false;
  }
  function occlusion() {
    var cp = camera.position;
    for (var i = 0; i < chips.length; i++) {
      var ch = chips[i]; _ray.o[0] = cp.x; _ray.o[1] = cp.y; _ray.o[2] = cp.z;
      var dx = ch.anchor.x - cp.x, dy = ch.anchor.y - cp.y, dz = ch.anchor.z - cp.z, L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      _ray.d[0] = dx / L; _ray.d[1] = dy / L; _ray.d[2] = dz / L;
      var occ = false;
      for (var p = 0; p < PROXIES.length && !occ; p++) { if (PROXIES[p][0] === ch.id) continue; var t = rayBoxT(_ray.o, _ray.d, PROXIES[p][1], PROXIES[p][2]); if (t >= 0 && t < L - 0.4) occ = true; }
      if (occ !== ch.occ) { ch.occ = occ; layoutDirty = true; }
    }
  }

  // ── per-frame smoothing state ───────────────────────────────────────────
  var SM = {};              // critically damped springs {x, v}
  function spring(key, target, dt, tau, snap) {
    var s = SM[key]; if (!s) s = SM[key] = { x:target, v:0 };
    if (snap || !isFinite(s.x)) { s.x = target; s.v = 0; return target; }
    var w = 1 / tau, h = Math.min(dt, 0.05);
    s.v += (w * w * (target - s.x) - 2 * w * s.v) * h; s.x += s.v * h; return s.x;
  }
  function ease(key, target, dt, tau, snap) {
    var s = SM[key]; if (!s) s = SM[key] = { x:target, v:0 };
    if (snap || !isFinite(s.x)) s.x = target; else s.x += (target - s.x) * (1 - Math.exp(-dt / tau)); return s.x;
  }
  var snapNext = true, lastFrameTs = -1, flowGain = 1, wasRunning = true, phases = { rip:0, rip2:0, coil:0, casc:0, pour:0, sock:0, beacon:0, star:0, normA:0, normB:0, dropT:0 };
  var prevTripped = false, lastOverlaySwitch = -1, waveOld = null, _c = new THREE.Color(), _c2 = new THREE.Color(), _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new V3(1, 1, 1), _p = new V3();
  var fr = { g:0, o:0, w:0 }, frUp = { g:0, o:0, w:0 }, frDn = { g:0, o:0, w:0 }, frLiq = { g:0, o:0, w:0 };
  var colGas = new THREE.Color(PALETTE.gasTracer), colWat = new THREE.Color(PALETTE.waterTracer), colOil = new THREE.Color('#ffc060'), oilHexKey = '';
  var PHA = [0.7, 0.9, 0.85], PHS = [0.05, 0.075, 0.07], _rgb = [0, 0, 0];
  var pRange = { min:0, max:3000 }, tRange = { min:0, max:200 };
  var K = { jet:new THREE.Color('#cfe8ff'), watT:new THREE.Color(PALETTE.waterTracer), mist:new THREE.Color(PALETTE.mist), watS:new THREE.Color(PALETTE.waterSurface),
    ok:new THREE.Color(PALETTE.ok), warn:new THREE.Color(PALETTE.warn), alarm:new THREE.Color(PALETTE.alarm), accent:new THREE.Color(PALETTE.accent), hyd:new THREE.Color('#a5d6ff'),
    lampF:new THREE.Color('#ff3b30'), lampOn:new THREE.Color('#3fb950'), lampOff:new THREE.Color('#2b1a1a'), flagO:new THREE.Color('#f0883e'), flagW:new THREE.Color('#dfe6ee'),
    pour:new THREE.Color('#c08a3a'), pourKey:-1, phaseSeg:[] };
  for (var kq = 0; kq < 14; kq++) K.phaseSeg.push(new THREE.Color());
  var HALO_OPT = { forHalo:true }, FLOAT_X = [15.45, 17.35], FLOAT_F = [0, 0], FLAME_L = [null, null], GV = [null, null, null, null];

  function refreshOil(api) {
    var k = String(Math.round(api * 10)); if (k === oilHexKey || !S) return; oilHexKey = k;
    var oc = oilColor(api); colOil.set(oc.tracer);
    S.vessels.forEach(function (v) {
      if (v.kind === 'bath') return;
      v.U.uOilCol.value.set(oc.body).multiplyScalar(1.4); v.U.uEmCol.value.set(mixHex(oc.body, PALETTE.emulsionMix, 0.5));
      v.frontMat.userData.faceO = oc.alphaFront;
    });
    S.oil = oc;
    K.pourKey = -1;
    for (var q = 0; q < 14; q++) K.phaseSeg[q].set(q <= 3 ? '#9fc3dd' : (q === 4 || q === 9 || q === 10) ? '#cfe6ff' : q === 6 ? PALETTE.waterBody : q === 7 ? oc.surface : q === 12 ? '#5a6470' : mixHex(oc.surface, PALETTE.waterBody, 0.3));
    if (S.dyn.cascade) S.dyn.cascade.material.uniforms.uCol.value.set(oc.surface);
    if (S.dyn.sight) S.dyn.sight.o.material.color.set(oc.body), S.dyn.sight.o.material.emissive.set(oc.body);
  }
  // pipe tint / tracer colours per overlay
  function segColour(i, out) {
    var n = N;
    if (overlay === 'phase') return out.copy(K.phaseSeg[i]);
    var sI = i <= 5 ? i : (i === 6 || i === 7) ? -1 : (i === 11 ? 5 : -2), v, mn, mx, mode = overlay;
    if (overlay === 'pressure') { v = sI >= 0 ? (n.segs[sI].P0 + n.segs[sI].Pout) / 2 : sI === -1 ? (n.sep.P + n.surge.P) / 2 : n.surge.P; mn = pRange.min; mx = pRange.max; v = pNorm(v); mn = 0; mx = 1; }
    else if (overlay === 'temperature') { v = sI >= 0 ? (n.segs[sI].T0 + n.segs[sI].Tout) / 2 : n.sep.T; mn = tRange.min; mx = tRange.max; }
    else { v = sI >= 0 ? n.segs[sI].vPct : (i === 6 ? n.lines.sep_water.vel * 10 : i === 7 ? n.lines.sep_oil.vel * 10 : 0); mn = 0; mx = 120; }
    if (i === 12) return out.copy(K.phaseSeg[12]);
    colormapRGB(mode, mx > mn ? (v - mn) / (mx - mn) : 0, _rgb);
    return out.setRGB(_rgb[0], _rgb[1], _rgb[2], THREE.SRGBColorSpace);
  }
  function pNorm(p) { var a = Math.log10(Math.max(pRange.min, 1) + 1), b = Math.log10(pRange.max + 1); return b > a ? (Math.log10(Math.max(p, 0) + 1) - a) / (b - a) : 0; }

  function edgeState() {
    var tr = S.tr, n = N, i, L = n.lines, sg = n.segs;
    var byp = n.nodes.heater.bypass, gAct = L.surge_gauge.tank, gIn = n.gauge.tanks;
    for (i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i], v = 0, act = false;
      if (r.seg >= 0) { v = sg[r.seg].vel; }
      switch (r.id) {
        case 'E1': act = L.wh_esd.active; break; case 'E2': act = L.esd_choke.active; break;
        case 'E3': act = L.choke_heater.active; break; case 'E3c': act = L.choke_heater.active && !byp; break; case 'E3b': act = L.choke_heater.active && byp; break;
        case 'E4a': act = L.heater_sep.active && !byp; break; case 'E4': act = L.heater_sep.active; break;
        case 'G1': act = L.sep_flare.active; break;
        case 'LW': v = L.sep_water.vel; act = L.sep_water.active; break; case 'LO': v = L.sep_oil.vel; act = L.sep_oil.active; break;
        case 'LM': v = L.sep_water.vel + L.sep_oil.vel; act = L.sep_water.active || L.sep_oil.active; break;
        case 'BLK': v = L.blanket.vel; act = L.blanket.active; break; case 'VENT': v = L.surge_vent.vel; act = L.surge_vent.active; break;
        case 'X1': case 'X2': act = L.surge_gauge.active; break; case 'XA': act = L.surge_gauge.active && gIn[0].inlet; break; case 'XB': act = L.surge_gauge.active && gIn[1].inlet; break;
        case 'DRA': v = L.gauge_drain.vel; act = L.gauge_drain.active; break; case 'DRB': v = L.gauge_drain.vel; act = L.gauge_drain.active && L.gauge_drain.tank === 1; break;
        case 'E2b': act = false; break;
      }
      var vs = velToScene(v); if (vs <= 0) act = false;
      tr.edgeV[i] = vs; tr.edgeAct[i] = act ? 1 : 0; tr.nextE[i] = -1; tr.nextS[i] = 0;
    }
    var I = ROUTE_IDX;
    tr.nextE[I.E1] = I.E2; tr.nextE[I.E2] = I.E3; tr.nextE[I.E3] = byp ? I.E3b : I.E3c; tr.nextE[I.E3c] = I.E4a; tr.nextE[I.E4a] = I.E4; tr.nextE[I.E3b] = I.E4;
    tr.nextE[I.LW] = I.LM; tr.nextE[I.LO] = I.LM; tr.nextE[I.X1] = I.X2; tr.nextE[I.X2] = (gIn[1].inlet && (!gIn[0].inlet || gAct === 1)) ? I.XB : I.XA;
    tr.nextE[I.DRB] = I.DRA; tr.nextS[I.DRB] = S.pipes.sDRBjoin;
    for (i = 0; i < CHAIN_DEF.length; i++) tr.chainEntry[i] = I[CHAIN_DEF[i].entry];
    tr.chainEntry[7] = L.gauge_drain.tank === 1 ? I.DRB : I.DRA;
    // multiphase display fractions (upstream vs downstream of the choke)
    dispFrac(phaseFractions(n.inp.Qg, n.inp.Qo, n.inp.Qw, sg[0].P0, sg[0].T0, fr), frUp);
    dispFrac(phaseFractions(n.inp.Qg, n.inp.Qo, n.inp.Qw, sg[2].P0, sg[2].T0, fr), frDn);
    var qo = n.inp.Qo, qw = n.inp.Qw; frLiq.g = 0; frLiq.o = qo + qw > 0 ? (0.15 + 0.7 * qo / (qo + qw)) : 1; frLiq.w = qo + qw > 0 ? (0.15 + 0.7 * qw / (qo + qw)) : 0;
    var sL = frLiq.o + frLiq.w; frLiq.o /= sL; frLiq.w /= sL;
    // per-edge overlay colour LUT (8 samples along each edge)
    if (overlay !== 'phase') for (i = 0; i < ROUTES.length; i++) {
      var r2 = ROUTES[i], P0 = n.sep.P, P1 = n.sep.P, T0 = n.sep.T, T1 = n.sep.T, vp = 0;
      if (r2.seg >= 0) { P0 = sg[r2.seg].P0; P1 = sg[r2.seg].Pout; T0 = sg[r2.seg].T0; T1 = sg[r2.seg].Tout; vp = sg[r2.seg].vPct; }
      if (r2.id === 'G1') { P0 = n.sep.P; P1 = n.nodes.flare.P; }
      if (r2.id === 'LW' || r2.id === 'LO' || r2.id === 'BLK') { P0 = n.sep.P; P1 = n.surge.P; vp = tr.edgeV[i] > 0 ? (r2.id === 'LW' ? L.sep_water.vel : L.sep_oil.vel) * 10 : 0; }
      if (r2.id === 'LM') { P0 = P1 = n.surge.P; T0 = T1 = n.surge.T; vp = (L.sep_water.vel + L.sep_oil.vel) * 10; }
      if (r2.id === 'VENT') { P0 = n.surge.P; P1 = n.nodes.flare.P; T0 = T1 = n.surge.T; }
      if (r2.id === 'DRA' || r2.id === 'DRB') { P0 = P1 = 0; T0 = T1 = n.surge.T; vp = L.gauge_drain.vel * 10; }
      for (var k = 0; k < 8; k++) {
        var f = k / 7, t;
        if (overlay === 'pressure') { var pp = r2.id === 'G1' ? (f < 0.25 ? P0 : P1) : lerp(P0, P1, f); t = pNorm(pp); }
        else if (overlay === 'temperature') t = tRange.max > tRange.min ? (lerp(T0, T1, f) - tRange.min) / (tRange.max - tRange.min) : 0;
        else t = vp / 120;
        colormapRGB(overlay, t, _rgb); _c.setRGB(_rgb[0], _rgb[1], _rgb[2], THREE.SRGBColorSpace);
        var o = (i * 8 + k) * 3; tr.lut[o] = _c.r; tr.lut[o + 1] = _c.g; tr.lut[o + 2] = _c.b;
      }
    }
  }
  function updateTracers(dt) {
    var tr = S.tr, tabs = S.pipes.tables, i, n = tr.n, rnd = tr.rnd, pos = tr.pos, col = tr.col, sz = tr.sz;
    for (i = 0; i < n; i++) {
      var e = tr.edge[i], act = tr.edgeAct[e], ph = tr.ph[i], ch = tr.chain[i];
      var slip = CHAIN_DEF[ch].phase === 'multi' ? (ph === 0 ? 1.1 : 0.8) : 1;
      if (act) tr.s[i] += tr.edgeV[e] * slip * dt * flowGain;
      var guard = 0, tb = tabs[e];
      while (tr.s[i] > tb.len && guard++ < 6) {
        var ov = tr.s[i] - tb.len, nx = tr.nextE[e];
        if (nx < 0) {                                   // terminal: recycle to the chain entry
          e = tr.chainEntry[ch]; tr.s[i] = Math.min(ov, 0.3 * rnd()); tr.a[i] = 0;
          tr.ph[i] = ph = pickPhase(ch, e, rnd());
        } else {
          tr.s[i] = tr.nextS[e] + ov; e = nx;                                   // nextS[from] = entry offset on the next edge (DRB tees into DRA)
          if (e === ROUTE_IDX.E3) tr.ph[i] = ph = pickPhase(ch, e, rnd());       // re-roll across the choke
        }
        tr.edge[i] = e; tb = tabs[e];
      }
      act = tr.edgeAct[e];
      // idle particles on dead branches: once invisible, re-seed on the active chain entry
      if (!act && tr.a[i] < 0.01 && tr.edgeAct[tr.chainEntry[ch]]) { e = tr.edge[i] = tr.chainEntry[ch]; tb = tabs[e]; tr.s[i] = rnd() * tb.len; tr.ph[i] = ph = pickPhase(ch, e, rnd()); act = 1; }
      var baseA = PHA[ph], tgtA = act && flowGain > 0.02 ? baseA : (act ? tr.a[i] : 0);
      if (!act) tr.a[i] = Math.max(0, tr.a[i] - dt / 0.6 * baseA); else if (tr.a[i] < tgtA) tr.a[i] = Math.min(tgtA, tr.a[i] + dt / 0.3 * baseA); else tr.a[i] = tgtA;
      // position from the sampling table
      var fi = clamp(tr.s[i] / tb.step, 0, tb.n - 1.001), k0 = fi | 0, f = fi - k0, o0 = k0 * 3, o1 = o0 + 3;
      var px = tb.P[o0] + (tb.P[o1] - tb.P[o0]) * f, py = tb.P[o0 + 1] + (tb.P[o1 + 1] - tb.P[o0 + 1]) * f, pz = tb.P[o0 + 2] + (tb.P[o1 + 2] - tb.P[o0 + 2]) * f;
      var r = tb.r * 0.75 * tr.rr[i], ct = Math.cos(tr.th[i]), st = Math.sin(tr.th[i]);
      var ox = r * (ct * tb.N[o0] + st * tb.B[o0]), oy = r * (ct * tb.N[o0 + 1] + st * tb.B[o0 + 1]), oz = r * (ct * tb.N[o0 + 2] + st * tb.B[o0 + 2]);
      if (ph !== 0 && Math.abs(tb.P[o1 + 1] - tb.P[o0 + 1]) < 0.01) { oy = oy * 0.4 - 0.6 * r * 0.9; }
      var p3 = i * 3; pos[p3] = px + ox; pos[p3 + 1] = py + oy; pos[p3 + 2] = pz + oz;
      var c4 = i * 4;
      if (overlay === 'phase') { var cc = ph === 0 ? colGas : ph === 1 ? colOil : colWat; col[c4] = cc.r; col[c4 + 1] = cc.g; col[c4 + 2] = cc.b; }
      else { var li = (e * 8 + Math.round(clamp(tr.s[i] / Math.max(tb.len, 1e-6), 0, 1) * 7)) * 3; col[c4] = tr.lut[li]; col[c4 + 1] = tr.lut[li + 1]; col[c4 + 2] = tr.lut[li + 2]; }
      col[c4 + 3] = tr.a[i]; sz[i] = PHS[ph];
    }
    tr.pa.needsUpdate = true; tr.ca.needsUpdate = true; tr.za.needsUpdate = true;
  }
  function pickPhase(ch, e, r) {
    var p = CHAIN_DEF[ch].phase;
    if (p === 'gas') return 0; if (p === 'oil') return 1; if (p === 'water') return 2;
    if (p === 'liquid') return r < frLiq.o ? 1 : 2;
    var f = (e === ROUTE_IDX.E1 || e === ROUTE_IDX.E2) ? frUp : frDn; return phasePick(r, f);
  }
  function updateJetEmbersFrost(dt, tNow) {
    var tr = S.tr, base = tr.n, i, pos = tr.pos, col = tr.col, sz = tr.sz, tabs = S.pipes.tables, tb = tabs[ROUTE_IDX.E3];
    var c = N.nodes.choke, crit = c.regime === 'Critical' && N.lines.choke_heater.active, sub = c.regime === 'Subcritical' && N.lines.choke_heater.active;
    var NPR = clamp((c.Pin + 14.7) / (c.P + 14.7), 1, 30), dj = 0.02 + clamp(c.bean, 4, 128) / 64 * 0.07, sp = dj * (0.8 + 0.25 * Math.sqrt(Math.max(NPR - 1.89, 0)));
    var flick = 0.8 + 0.2 * Math.sin(tNow * 0.001 * 75.4) * (paused || !N.running ? 0.5 : 1);
    for (i = 0; i < tr.nJ; i++) {
      var k = base + i, s = 0.28 + sp * i, fi = clamp(s / tb.step, 0, tb.n - 1), k0 = fi | 0;
      pos[k * 3] = tb.P[k0 * 3]; pos[k * 3 + 1] = tb.P[k0 * 3 + 1]; pos[k * 3 + 2] = tb.P[k0 * 3 + 2];
      var on = crit ? 1 : (sub && i === 0 ? 0.5 : 0), a = on * 0.85 * flick * Math.pow(0.85, i) * (flowGain < 0.5 ? 0.5 : 1);
      _c.copy(K.jet); col[k * 4] = _c.r * 1.6; col[k * 4 + 1] = _c.g * 1.6; col[k * 4 + 2] = _c.b * 1.6; col[k * 4 + 3] = a;
      sz[k] = (sub ? 0.3 : 0.17) * Math.pow(0.85, i);
    }
    base += tr.nJ;
    var fl = S.dyn.flame, L = fl.Lv, rnd = tr.rnd;
    for (i = 0; i < tr.nE; i++) {
      var q = base + i, j3 = i * 3;
      tr.eLife[i] += dt;
      if (tr.eLife[i] > tr.eMax[i]) {
        tr.eLife[i] = 0; tr.eMax[i] = 1.5 + rnd() * 1.5;
        tr.ePos[j3] = FLAME_BASE[0] + (rnd() - 0.5) * 0.5; tr.ePos[j3 + 1] = FLAME_BASE[1] + rnd() * L * 0.5; tr.ePos[j3 + 2] = FLAME_BASE[2] + (rnd() - 0.5) * 0.5;
        tr.eVel[j3] = WIND[0] * 1.2 + (rnd() - 0.5) * 0.6; tr.eVel[j3 + 1] = 1.5 + rnd(); tr.eVel[j3 + 2] = WIND[2] * 1.2 + (rnd() - 0.5) * 0.6;
      }
      tr.ePos[j3] += tr.eVel[j3] * dt; tr.ePos[j3 + 1] += tr.eVel[j3 + 1] * dt; tr.ePos[j3 + 2] += tr.eVel[j3 + 2] * dt;
      pos[q * 3] = tr.ePos[j3]; pos[q * 3 + 1] = tr.ePos[j3 + 1]; pos[q * 3 + 2] = tr.ePos[j3 + 2];
      var lf = tr.eLife[i] / tr.eMax[i], ea = L > 0.5 ? (1 - lf) * 0.9 * clamp(L / 4, 0.2, 1) : 0;
      col[q * 4] = 1.8; col[q * 4 + 1] = 0.55 * (1 - lf) + 0.15; col[q * 4 + 2] = 0.08; col[q * 4 + 3] = ea; sz[q] = 0.07;
    }
    base += tr.nE;
    var fz = S.frostU.uFrost.value;
    for (i = 0; i < tr.nF; i++) {
      var w = base + i, a2 = i * 2.39996;
      pos[w * 3] = -7.2 + (i % 10) * 0.2 + Math.sin(a2) * 0.05; pos[w * 3 + 1] = 1.2 + Math.cos(a2) * 0.2; pos[w * 3 + 2] = 0.6 + Math.sin(a2 * 1.7) * 0.2;
      col[w * 4] = 1.6; col[w * 4 + 1] = 1.8; col[w * 4 + 2] = 2.0; col[w * 4 + 3] = fz * (0.5 + 0.5 * Math.sin(tNow * 0.004 + i * 1.7)); sz[w] = 0.035;
    }
  }
  function updateVesselParticles(dt) {
    var gain = flowGain * clamp(N.f, 0, 1.2), i;
    // V-101: bubbles / droplet rain / mist
    var v = S.vesselsById.separator, P = v.part, r = P.rnd, yb = 2.0 - v.Ri, lvl = yb + SM.c1L.x * 2 * v.Ri, wX = 5.6 - 3.0 + 6.0 * N.sep.xWeirFrac, lvlB = yb + SM.bF.x * 2 * v.Ri;
    var s0 = v.partSplit[0], s1 = v.partSplit[1];
    for (i = 0; i < P.n; i++) {
      var o = i * 3, c = i * 4, kind = i < s0 ? 0 : i < s1 ? 1 : 2;
      P.life[i] += dt * gain;
      if (kind === 0) {                             // bubbles rising in C1
        var y = yb + 0.05 + P.life[i] * 0.15;
        if (y > lvl - 0.02 || P.life[i] > 20) { P.life[i] = 0; P.a[i] = r(); P.b[i] = r(); y = yb + 0.05; }
        P.pos[o] = 3.0 + P.a[i] * (wX - 3.3); P.pos[o + 1] = y; P.pos[o + 2] = (P.b[i] - 0.5) * 1.1 * Math.sqrt(Math.max(0, 1 - Math.pow((y - 2.0) / v.Ri, 2)));
        P.col[c] = 0.85; P.col[c + 1] = 0.93; P.col[c + 2] = 1.0; P.col[c + 3] = 0.45 * 0.5 * (gain > 0.02 ? 1 : 0); P.sz[i] = 0.03;
      } else if (kind === 1) {                      // droplet rain from the inlet diverter (ballistic 0.3·g)
        var t = P.life[i], x = 2.95 + 0.6 * t + P.a[i] * 0.2, y2 = 2.25 - 0.5 * 0.3 * 9.81 * t * t + (P.b[i] - 0.5) * 0.3;
        if (y2 < lvl) { if (S.T.drops && gain > 0.05) addDrop(v, x, P.b[i]); P.life[i] = r() * 0.05; P.a[i] = r(); P.b[i] = r(); P.c[i] = r(); }
        P.pos[o] = x; P.pos[o + 1] = Math.max(y2, lvl); P.pos[o + 2] = (P.c[i] - 0.5) * 0.8;
        _c.copy(P.c[i] < 0.3 ? K.watT : colOil);
        P.col[c] = _c.r; P.col[c + 1] = _c.g; P.col[c + 2] = _c.b; P.col[c + 3] = 0.8 * (gain > 0.02 ? 1 : 0); P.sz[i] = 0.04;
      } else {                                      // mist drifting to the mist pad
        var xm = 3.3 + P.life[i] * 0.3 * 2.5;
        if (xm > 5.6 + 2.35) { P.life[i] = 0; P.a[i] = r(); P.b[i] = r(); xm = 3.3; }
        var top = 2.0 + v.Ri * 0.85, ym = lvl + 0.08 + P.a[i] * Math.max(0.05, top - lvl - 0.1);
        P.pos[o] = xm; P.pos[o + 1] = ym; P.pos[o + 2] = (P.b[i] - 0.5) * 1.1 * Math.sqrt(Math.max(0.05, 1 - Math.pow((ym - 2.0) / v.Ri, 2)));
        _c.copy(K.mist); P.col[c] = _c.r; P.col[c + 1] = _c.g; P.col[c + 2] = _c.b; P.col[c + 3] = 0.35 * (gain > 0.02 ? 1 : 0); P.sz[i] = 0.035;
      }
    }
    P.pa.needsUpdate = P.ca.needsUpdate = P.za.needsUpdate = true;
    // T-201: bubbles + inlet splash
    v = S.vesselsById.surge; P = v.part; r = P.rnd; s0 = v.partSplit[0];
    var lyA = 0.915 + (SM.uA ? SM.uA.x : SM.suF.x) * v.Hint, lyB = 0.915 + (SM.uB ? SM.uB.x : SM.suF.x) * v.Hint, ly = lyA;
    var inAct = (N.lines.sep_oil.active || N.lines.sep_water.active) && N.surge.comps[0].inlet;
    for (i = 0; i < P.n; i++) {
      var o2 = i * 3, c2 = i * 4;
      P.life[i] += dt * flowGain;
      if (i < s0) {
        var yy = 1.0 + P.life[i] * 0.15, lyk = Math.cos(P.b[i] * 6.283) < 0 ? lyA : lyB;
        if (yy > lyk - 0.03 || P.life[i] > 40) { P.life[i] = 0; P.a[i] = r(); P.b[i] = r(); yy = 1.0; lyk = Math.cos(P.b[i] * 6.283) < 0 ? lyA : lyB; }
        var rr = Math.sqrt(P.a[i]) * 0.9, an = P.b[i] * 6.283;
        P.pos[o2] = 10.2 + Math.cos(an) * rr; P.pos[o2 + 1] = yy; P.pos[o2 + 2] = 4.0 + Math.sin(an) * rr;
        P.col[c2] = 0.85; P.col[c2 + 1] = 0.93; P.col[c2 + 2] = 1; P.col[c2 + 3] = lyk > 1.1 ? 0.22 : 0; P.sz[i] = 0.035;
      } else {
        var t2 = P.life[i] * 1.5;
        var yx = 4.2 - 0.5 * 9.81 * t2 * t2 * 0.25, xx = 9.1 + t2 * 0.9;
        if (yx < ly) { P.life[i] = r() * 0.1; P.a[i] = r(); yx = 4.2; xx = 9.1; }
        P.pos[o2] = xx; P.pos[o2 + 1] = Math.max(yx, ly); P.pos[o2 + 2] = 4.0 + (P.a[i] - 0.5) * 0.2;
        _c.copy(colOil); P.col[c2] = _c.r; P.col[c2 + 1] = _c.g; P.col[c2 + 2] = _c.b; P.col[c2 + 3] = inAct && flowGain > 0.05 ? 0.8 : 0; P.sz[i] = 0.05;
      }
    }
    P.pa.needsUpdate = P.ca.needsUpdate = P.za.needsUpdate = true;
    // T-301: splash around the pour point
    v = S.vesselsById.gauge; P = v.part; r = P.rnd;
    var act = N.lines.surge_gauge.active, tk = N.lines.surge_gauge.tank, px = tk ? 17.6 : 15.2, sy = 0.25 + (tk ? SM.gB.x : SM.gA.x) * 2.6;
    for (i = 0; i < P.n; i++) {
      var o3 = i * 3, c3 = i * 4; P.life[i] += dt * flowGain * 2;
      if (P.life[i] > 0.5) { P.life[i] = 0; P.a[i] = r(); P.b[i] = r(); }
      var tt = P.life[i], an2 = P.a[i] * 6.283, sp2 = 0.25 + P.b[i] * 0.35;
      P.pos[o3] = px + Math.cos(an2) * sp2 * tt; P.pos[o3 + 1] = sy + 1.4 * tt - 4.9 * tt * tt; P.pos[o3 + 2] = 3.6 + Math.sin(an2) * sp2 * tt;
      _c.copy(K.watS); P.col[c3] = _c.r; P.col[c3 + 1] = _c.g; P.col[c3 + 2] = _c.b; P.col[c3 + 3] = act && flowGain > 0.05 && P.pos[o3 + 1] > sy ? 0.7 * (1 - tt * 2) : 0; P.sz[i] = 0.04;
    }
    P.pa.needsUpdate = P.ca.needsUpdate = P.za.needsUpdate = true;
  }
  function addDrop(v, x, z) {
    var cm = v.caps[0], U = cm.material.userData.U; if (!U) return;
    var d = U.uDrops.value, k = (phases.dropT = (phases.dropT + 1) % 8);
    d[k].set(x - 5.6, (z - 0.5) * 0.8, 0, 0.35);
  }

  // ── vessels: levels → caps/uniforms, slosh, sorting ────────────────────
  var _vd = new Float32Array(8), _vi = new Int32Array(8);
  function updateVessels(dt, snap, anim) {
    var sp = N.sep, su = N.surge, ga = N.gauge;
    var c1W = spring('c1W', sp.c1fracW, dt, 0.15, snap), c1L = spring('c1L', Math.max(sp.c1fracL, sp.c1fracW), dt, 0.15, snap);
    var bF = spring('bF', sp.bfrac, dt, 0.15, snap), bW = spring('bW', sp.bfracW, dt, 0.15, snap);
    var suF = spring('suF', su.frac, dt, 0.15, snap), suW = spring('suW', Math.min(su.fracW, su.frac), dt, 0.15, snap);
    var uA = spring('uA', su.comps[0].frac, dt, 0.15, snap), uAW = spring('uAW', Math.min(su.comps[0].fracW, su.comps[0].frac), dt, 0.15, snap);
    var uB = spring('uB', su.comps[1].frac, dt, 0.15, snap), uBW = spring('uBW', Math.min(su.comps[1].fracW, su.comps[1].frac), dt, 0.15, snap);
    var gA = spring('gA', ga.tanks[0].frac, dt, 0.15, snap), gAW = spring('gAW', Math.min(ga.tanks[0].fracW, ga.tanks[0].frac), dt, 0.15, snap);
    var gB = spring('gB', ga.tanks[1].frac, dt, 0.15, snap), gBW = spring('gBW', Math.min(ga.tanks[1].fracW, ga.tanks[1].frac), dt, 0.15, snap);
    var V = S.vesselsById, v, U, i;
    // slosh (excited by level rate + ESD trip; zeroed on snap)
    function slosh(v, level) {
      var s = v.slosh; if (snap || s.lastL < 0) { s.th = 0; s.om = 0; s.lastL = level; return 0; }
      var dl = (level - s.lastL) / Math.max(dt, 1e-3); s.lastL = level; var h = Math.min(dt, 0.05);
      s.om += (-16 * s.th - 2 * 0.15 * 4 * s.om + 0.6 * clamp(dl, -0.5, 0.5)) * h; s.th = clamp(s.th + s.om * h, -0.03, 0.03);
      if (reducedMotion) s.th = 0;
      return Math.tan(s.th);
    }
    phases.rip = (phases.rip + dt * 1.7 * anim) % 6.2832; phases.rip2 = (phases.rip2 + dt * 1.3 * anim) % 6.2832;
    // V-101
    v = V.separator; U = v.U; var D = 2 * v.Ri, wX = -3.0 + 6.0 * sp.xWeirFrac;
    U.uSecA.value.set(c1W * D, c1L * D); U.uSecB.value.set(bW < 0.005 ? -1 : bW * D, bF * D); U.uSplitX.value = wX;
    U.uEmul.value = sp.carryOver ? 0.08 : 0.045; U.uTilt.value = slosh(v, c1L * D); U.uPh.value.set(phases.rip, phases.rip2);
    U.uRip.value = 0.6 + 0.8 * clamp(N.lines.heater_sep.frac, 0, 1.5) / 1.5;
    v.alert.value = smoothstep(0.85, 1.0, sp.P / sp.pshh) * (sp.P / sp.pshh > 0.95 ? 0.6 + 0.4 * Math.sin(phases.beacon * 2) : 1);
    var yC = c1L * D, yB = bF * D;
    if (Math.abs(v.capInfo[0].y - yC) > 0.002 || v.capInfo[0].x1 !== wX) setHorizCap(v.capInfo[0], yC, -v.H / 2, wX - 0.016);
    if (Math.abs(v.capInfo[1].y - yB) > 0.002 || v.capInfo[1].x0 !== wX) setHorizCap(v.capInfo[1], yB, wX + 0.016, v.H / 2);
    v.caps[0].position.y = 2.0 - v.Ri + yC; v.caps[1].position.y = 2.0 - v.Ri + yB; v.caps[0].rotation.z = Math.atan(U.uTilt.value); v.caps[1].rotation.z = Math.atan(U.uTilt.value);
    var oilTop = c1L - c1W > 0.01;
    setCapLook(v.caps[0], oilTop ? 'oil' : 'water'); setCapLook(v.caps[1], bF - bW > 0.005 ? 'oil' : 'water');
    v.caps[0].visible = c1L > 0.004; v.caps[1].visible = bF > 0.004;
    if (Math.abs((v.weirH || 0) - sp.hWeirFrac) > 1e-4 || v.weirX !== wX) { v.weirH = sp.hWeirFrac; v.weirX = wX; v.weir.position.x = 5.6 + wX; v.weir.scale.set(1, sp.hWeirFrac / 0.55, 1); }
    if (S.dyn.haze) { var hu = S.dyn.haze.material.uniforms; hu.uLvA.value = c1L * D; hu.uLvB.value = bF * D; hu.uSplit.value = wX; hu.uTilt.value = U.uTilt.value;
      hu.uA.value = S.fxOff ? 0 : 0.13 + 0.05 * clamp(sp.P / 150, 0, 2); }
    // weir cascade
    var cs = S.dyn.cascade, cu = cs.material.uniforms, ow = sp.overWeir_bpd, q = ow > 1 ? Math.pow(ow / Math.max(N.inp.Qo, 50), 2 / 3) : 0;
    cs.visible = ow > 1; phases.casc = (phases.casc + dt * 1.5 * flowGain) % 256;
    cu.uOff.value = phases.casc; cu.uA.value = clamp(0.35 + 0.4 * q, 0, 0.85) * (0.4 + 0.6 * flowGain); cu.uTop.value = 2.0 - v.Ri + sp.hWeirFrac * D + 0.02;
    cu.uBot.value = 2.0 - v.Ri + yB; cu.uX.value = 5.6 + wX; cu.uZ.value = Math.max(0.1, capHalfWidth(v.Ri, 6, v.hd, sp.hWeirFrac * D, wX) * 0.92);
    // H-101 bath: gentle ripple only
    v = V.heater; v.U.uPh.value.set(phases.rip, phases.rip2);
    // T-201
    // T-201 compartments A (−X) | B (+X): each half of the shell and its half-disc cap follows its own level
    v = V.surge; U = v.U; var yS = uA * v.Hint, ySW = uAW * v.Hint, yB2 = uB * v.Hint, yBW = uBW * v.Hint;
    U.uSecA.value.set(uAW < 0.003 ? -1 : ySW, yS); U.uSecB.value.set(uBW < 0.003 ? -1 : yBW, yB2); U.uSplitX.value = 0;
    U.uTilt.value = slosh(v, suF * v.Hint); U.uPh.value.set(phases.rip, phases.rip2);
    v.alert.value = smoothstep(0.85, 1.0, su.P / Math.max(su.pshh, 1));
    surgeCap(v, 0, yS, uA, uAW); surgeCap(v, 1, yB2, uB, uBW);
    var sg = S.dyn.sight, yTop = clamp(0.915 + yS, sg.y0, sg.y1), yW = clamp(0.915 + ySW, sg.y0, sg.y1);     // LG-201 is on A's side
    sg.w.position.y = sg.y0; sg.w.scale.y = Math.max(1e-3, yW - sg.y0); sg.w.visible = yW > sg.y0 + 0.001;
    sg.o.position.y = yW; sg.o.scale.y = Math.max(1e-3, yTop - yW); sg.o.visible = yTop > yW + 0.001;
    // T-301 (compartments A | B)
    v = V.gauge; U = v.U;
    U.uSecA.value.set(gAW < 0.003 ? -1 : gAW * 2.6, gA * 2.6); U.uSecB.value.set(gBW < 0.003 ? -1 : gBW * 2.6, gB * 2.6); U.uPh.value.set(phases.rip, phases.rip2);
    v.caps[0].position.y = 0.25 + gA * 2.6; v.caps[1].position.y = 0.25 + gB * 2.6; v.caps[0].visible = gA > 0.003; v.caps[1].visible = gB > 0.003;
    setCapLook(v.caps[0], gA - gAW > 0.01 ? 'oil' : 'water'); setCapLook(v.caps[1], gB - gBW > 0.01 ? 'oil' : 'water');
    // cap normal-map scroll (CPU-wrapped offsets)
    if (S.normTex[0]) { phases.normA = (phases.normA + 0.02 * dt * anim) % 1; S.normTex[0].offset.set(phases.normA, phases.normA * 0.7); }
    if (S.normTex[1]) { phases.normB = (phases.normB - 0.015 * dt * anim + 1) % 1; S.normTex[1].offset.set(phases.normB * 0.6, phases.normB); }
    // drop ripples age (CPU time since impact)
    var cu2 = V.separator.caps[0].material.userData.U;
    if (cu2) for (i = 0; i < 8; i++) { var d = cu2.uDrops.value[i]; if (d.z < 50) d.z += dt; }
    // per-vessel render-order bands, re-ranked far→near without allocation
    var vs = S.vessels, n = vs.length, cp = camera.position;
    for (i = 0; i < n; i++) { _vd[i] = cp.distanceToSquared(vs[i].centre); _vi[i] = i; }
    for (i = 1; i < n; i++) { var key = _vi[i], j = i - 1; while (j >= 0 && _vd[_vi[j]] < _vd[key]) { _vi[j + 1] = _vi[j]; j--; } _vi[j + 1] = key; }
    for (i = 0; i < n; i++) {
      var ve = vs[_vi[i]], b = 100 + i * 10;
      if (ve.glassBack) ve.glassBack.renderOrder = b + 1; ve.hullBack.renderOrder = b + 2;
      for (var t = 0; t < ve.internalsT.length; t++) ve.internalsT[t].renderOrder = b + 3;
      for (var cI = 0; cI < ve.caps.length; cI++) ve.caps[cI].renderOrder = b + 4;
      if (ve.points) ve.points.renderOrder = b + 5;
      ve.hullFront.renderOrder = b + 6; ve.glassFront.renderOrder = b + 7;
    }
  }
  function surgeCap(v, ci, y, f, fw) {
    var capS = v.caps[ci], rc = vertCapRadius(v.Ri, v.Ls, v.hd, clamp(y, 0.001, v.Hint - 0.001));
    capS.scale.set(rc, 1, rc); capS.position.y = 0.915 + y; capS.visible = f > 0.003; capS.rotation.z = Math.atan(v.U.uTilt.value);
    setCapLook(capS, f - fw > 0.01 ? 'oil' : 'water');
  }
  function setCapLook(cm, top) {
    var m = cm.material; if (m.userData.top === top && m.userData.api === oilHexKey) return;
    m.userData.top = top; m.userData.api = oilHexKey;
    var surf = top === 'oil' ? (S.oil ? mixHex(S.oil.body, S.oil.surface, 0.45) : '#b07a30') : PALETTE.waterSurface;
    m.color.set(top === 'oil' ? (S.oil ? S.oil.body : '#8a5a1c') : PALETTE.waterBody); m.opacity = top === 'oil' ? 0.9 : 0.65;
    if (m.userData.U) m.userData.U.uSurf.value.set(surf);
  }

  // ── setpoint lines on the V-101 glass (rebuilt when limits change) ─────
  function updateSetpointLines() {
    var sp = N.sep, key = [sp.wat.lsl, sp.wat.lsh, sp.wat.lshh, sp.lahhTotal, sp.hWeirFrac, sp.oil.lsl, sp.oil.lsh, sp.oil.lsll, sp.oil.lshh, sp.xWeirFrac].join(',');
    var L = S.dyn.spLines; if (L.key === key) return; L.key = key;
    var pos = [], col = [], Ri = 0.835, yb = 2.0 - Ri, wx = 5.6 - 3.0 + 6.0 * sp.xWeirFrac;
    function seg(x0, x1, f, hex) {
      var y = yb + f * 2 * Ri, z = Math.sqrt(Math.max(0, 0.862 * 0.862 - (y - 2) * (y - 2))); _c.set(hex);
      [z, -z].forEach(function (zz) { pos.push(x0, y, zz, x1, y, zz); col.push(_c.r, _c.g, _c.b, _c.r, _c.g, _c.b); });
    }
    seg(2.65, wx - 0.05, sp.wat.lsl, '#d29922'); seg(2.65, wx - 0.05, sp.wat.lsh, '#d29922'); seg(2.65, wx - 0.05, sp.wat.lshh, '#f85149');
    seg(2.65, wx - 0.05, sp.lahhTotal, '#f85149'); seg(2.65, wx - 0.05, sp.hWeirFrac, '#e6edf3');
    seg(wx + 0.05, 8.55, sp.oil.lsl, '#d29922'); seg(wx + 0.05, 8.55, sp.oil.lsh, '#d29922'); seg(wx + 0.05, 8.55, sp.oil.lsll, '#f85149'); seg(wx + 0.05, 8.55, sp.oil.lshh, '#f85149');
    var g = L.obj.geometry; g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    L.obj.computeLineDistances();
  }

  // ── dynamic equipment parts ─────────────────────────────────────────────
  function setNeedle(i, p, angle) {
    _e.set(0, -0.314, angle); _q.setFromEuler(_e); _p.set(p[0] + 0.012 * Math.sin(-0.314), p[1], p[2] + 0.012 * Math.cos(0.314)); _s.set(1, 1, 1);
    _m4.compose(_p, _q, _s); S.dyn.dials.needles.setMatrixAt(i, _m4);
  }
  var dialRanges = [3000, 300, 60, 300];
  function refreshDials(force) {
    var met = units && units.system === 'metric' && typeof units.conv === 'function';
    var r0 = niceRange(Math.max(N.nodes.wellhead.P, N.nodes.choke.Pin, N.inp.Pwh), false), r1 = niceRange(Math.max(N.sep.P, N.nodes.choke.P, N.sep.pshh * 0.9), false);
    var r2 = niceRange(Math.max(N.surge.P, N.surge.pshh * 0.9), false), key = [r0, r1, r2, met ? 'm' : 'i'].join(',');
    var dd = S.dyn.dials; if (dd.key === key && !force) return; dd.key = key; dialRanges = [r0, r1, r2, 300];
    var faces;
    if (!met) faces = [{ tag:'PI', max:r0, unit:'psig', red:r0 * 0.9 }, { tag:'PI', max:r1, unit:'psig', red:N.sep.psh }, { tag:'PI', max:r2, unit:'psig', red:N.surge.psh }, { tag:'TI', max:300, unit:'°F' }];
    else {
      var cv = function (v) { var o = units.conv(v, 'pressureG'); return o && isFinite(o.value) ? o.value : v * 6.894757; };
      var up = (units.conv(1, 'pressureG') || {}).unit || 'kPa';
      var m0 = niceRange(cv(r0) / 1.15, true), m1 = niceRange(cv(r1) / 1.15, true), m2 = niceRange(cv(r2) / 1.15, true);
      dialRanges = [m0 / cv(1), m1 / cv(1), m2 / cv(1), 300];
      faces = [{ tag:'PI', max:m0, unit:up, red:m0 * 0.9 }, { tag:'PI', max:m1, unit:up, red:cv(N.sep.psh) }, { tag:'PI', max:m2, unit:up, red:cv(N.surge.psh) }, { tag:'TI', max:150, unit:'°C' }];
      dialRanges[3] = 302;
    }
    var old = dd.mat.map; var t = F.dialAtlas(faces, units); dd.mat.map = t; dd.mat.emissiveMap = t; dd.mat.needsUpdate = true;
    if (old) { old.dispose(); var ix = S.textures.indexOf(old); if (ix >= 0) S.textures.splice(ix, 1); } S.textures.push(t);
  }
  function refreshBoards(force) {
    var bd = S.dyn.boards, cap = N.gauge.tanks[0].cap_bbl, sys = units && units.system || 'imperial';
    if (bd.cap === cap && bd.sys === sys && !force) return; bd.cap = cap; bd.sys = sys;
    bd.meshes.forEach(function (m, i) { var old = m.material.map; var t = F.gaugeBoard(cap, units, i ? 'B' : 'A'); m.material.map = t; m.material.emissiveMap = t; m.material.needsUpdate = true;
      if (old) { old.dispose(); var ix = S.textures.indexOf(old); if (ix >= 0) S.textures.splice(ix, 1); } S.textures.push(t); });
  }
  function updateParts(dt, snap, tNow, anim) {
    var n = N, D = S.dyn, i;
    // ESD rod, beacon
    var e = n.esd, ed = D.esd;
    ed.rod.position.y = 3.05; ed.rod.scale.y = Math.max(0.05, e.travel);            // indicator rod: +0.3 m proud when open, flush when shut
    phases.beacon = (phases.beacon + dt * anim) % 1000;
    var bc, bOn = 1;
    if (e.tripped && !e.manual) { bc = K.alarm; bOn = (phases.beacon * 2) % 1 < 0.5 ? 1 : 0.15; }
    else if (e.moving || (e.travel > 0.02 && e.travel < 0.98)) { bc = K.warn; bOn = phases.beacon % 1 < 0.5 ? 1 : 0.2; }
    else if (e.manual) bc = K.warn; else bc = K.ok;
    ed.beaconMat.color.copy(bc).multiplyScalar(0.3 + 1.5 * bOn); ed.glow.material.color.copy(bc); ed.glow.material.opacity = 0.9 * bOn;
    if (e.tripped && !prevTripped && !reducedMotion) { nudge = 0.25; for (var vq = 0; vq < S.vessels.length; vq++) S.vessels[vq].slosh.om += 0.12; }
    prevTripped = e.tripped;
    // choke handwheel (spring toward bean/64 × 6π)
    var ang = spring('ckW', clamp(n.nodes.choke.bean, 0, 128) / 64 * 6 * Math.PI, dt, 0.25, snap); D.choke.wheel.rotation.y = ang;
    // heater fire/coil/smoke
    var firing = ease('fire', n.nodes.heater.bypass ? 0 : clamp(n.nodes.heater.firing, 0, 1), dt, 1.0, snap);
    S.fireU.uFire.value = firing; D.heater.peep.material.opacity = 0.25 + 0.7 * firing * (0.85 + 0.15 * Math.sin(tNow * 0.013));
    var cvel = velToScene(n.segs[2].vel) * flowGain * (n.nodes.heater.bypass ? 0 : 1);
    phases.coil = (phases.coil + cvel * dt * 1.2) % 256; S.coilU.uCoilPh.value = phases.coil; S.coilU.uCoilOn.value = n.nodes.heater.bypass ? 0 : clamp(n.f, 0, 1);
    for (i = 0; i < 3; i++) { var pf = D.heater.puffs[i], lt = ((tNow * 0.00025 * anim + i / 3) % 1); pf.position.set(0.55 + lt * 1.2 * WIND[0], 5.7 + lt * 2.2, 0.28 + lt * 1.2 * WIND[2]);
      var sc = 0.5 + lt * 1.8; pf.scale.set(sc, sc, 1); pf.material.opacity = firing > 0.3 ? 0.22 * (1 - lt) * firing : 0; }
    // LCV / PCV stems
    D.lcv.water.position.y = 0.55 + pipeRadius(3) + 0.6 - 0.08 * ease('lcvW', n.sep.wat.x, dt, 0.3, snap);
    D.lcv.oil.position.y = 0.55 + pipeRadius(3) + 0.6 - 0.08 * ease('lcvO', n.sep.oil.x, dt, 0.3, snap);
    D.lcv.pcv.position.y = 3.6 + pipeRadius(6) + 0.6 - 0.1 * ease('pcvU', n.sep.pcvU, dt, 0.3, snap);
    // pump coupling + lamp
    var qp = n.surge.pump_q, om = 30 * Math.min(1, qp / Math.max(n.surge.pump_design, 1));
    D.pump.ang = (D.pump.ang + ease('pumpW', om, dt, 0.6, snap) * dt * (0.2 + 0.8 * flowGain)) % 6.2832; D.pump.coup.rotation.z = D.pump.ang;
    D.pump.lampM.color.copy(n.surge.pumpFailed || n.surge.pumpTripped ? K.lampF : (n.surge.pumpOn ? K.lampOn : K.lampOff)).multiplyScalar(n.surge.pumpFailed || n.surge.pumpTripped ? 1.6 + 0.6 * Math.sin(tNow * 0.012) : 1.2);
    // gauge valves
    var gv = D.gaugeValves, gt = n.gauge.tanks, uc = n.surge.comps;
    gv.xvA.rotation.x = spring('xvA', gt[0].inlet ? 0 : Math.PI * 3, dt, 0.3, snap); gv.xvB.rotation.x = spring('xvB', gt[1].inlet ? 0 : Math.PI * 3, dt, 0.3, snap);
    gv.sxA.rotation.y = spring('sxA', uc[0].inlet ? 0 : Math.PI * 3, dt, 0.3, snap); gv.sxB.rotation.y = spring('sxB', uc[1].inlet ? 0 : Math.PI * 3, dt, 0.3, snap);
    var lsig = (gt[0].inlet ? 1 : 0) + (gt[1].inlet ? 2 : 0) + (uc[0].inlet ? 4 : 0) + (uc[1].inlet ? 8 : 0) + (uc[0].suction ? 16 : 0) + (uc[1].suction ? 32 : 0);
    if (gv.lampSig !== lsig) {
      gv.lampSig = lsig;
      for (i = 0; i < 6; i++) gv.lamps.setColorAt(i, (lsig >> i) & 1 ? K.lampOn : (i < 4 ? K.lampF : K.lampOff));   // inlet shut = red, suction out of service = dark
      if (gv.lamps.instanceColor) gv.lamps.instanceColor.needsUpdate = true;
    }
    gv.dvA.rotation.y = spring('dvA', n.gauge.tanks[0].state === 'draining' ? Math.PI * 3 : 0, dt, 0.3, snap); gv.dvB.rotation.y = spring('dvB', n.gauge.tanks[1].state === 'draining' ? Math.PI * 3 : 0, dt, 0.3, snap);
    GV[0] = gv.xvA; GV[1] = gv.xvB; GV[2] = gv.dvA; GV[3] = gv.dvB; GV[4] = gv.sxA; GV[5] = gv.sxB;
    for (i = 0; i < 6; i++) { GV[i].updateMatrix(); gv.inst.setMatrixAt(i, GV[i].matrix); } gv.inst.instanceMatrix.needsUpdate = true;
    for (i = 0; i < D.lcv.list.length; i++) { D.lcv.list[i].updateMatrix(); D.lcv.inst.setMatrixAt(i, D.lcv.list[i].matrix); } D.lcv.inst.instanceMatrix.needsUpdate = true;
    // floats + tapes
    var fl = D.floats, tp = fl.tape.geometry.attributes.position.array, xs = FLOAT_X, fr2 = FLOAT_F; FLOAT_F[0] = SM.gA.x; FLOAT_F[1] = SM.gB.x;
    for (i = 0; i < 2; i++) { var fy = 0.25 + clamp(fr2[i], 0.02, 1) * 2.6 + 0.02; _m4.makeTranslation(xs[i], fy, 4.95); fl.mesh.setMatrixAt(i, _m4);
      tp[i * 6] = xs[i]; tp[i * 6 + 1] = fy + 0.08; tp[i * 6 + 2] = 4.95; tp[i * 6 + 3] = xs[i]; tp[i * 6 + 4] = 2.95; tp[i * 6 + 5] = 4.95; }
    fl.mesh.instanceMatrix.needsUpdate = true; fl.tape.geometry.attributes.position.needsUpdate = true;
    // pour into each compartment whose inlet valve is open (shared material; alpha by the stronger stream)
    var pr = D.pour, flowOn = n.lines.surge_gauge.active && n.lines.surge_gauge.q > 0, paMax = 0;
    for (i = 0; i < 2; i++) {
      var surfI = 0.25 + (i ? SM.gB.x : SM.gA.x) * 2.6, paI = ease(i ? 'pourB' : 'pourA', flowOn && gt[i].inlet ? 1 : 0, dt, flowOn && gt[i].inlet ? 0.2 : 0.35, snap);
      var pm = pr.meshes[i]; pm.visible = paI > 0.02; pm.position.set(i ? 17.6 : 15.2, 2.7, 3.6); pm.scale.set(1, Math.max(0.05, 2.7 - surfI), 1);
      pr.splashes[i].position.set(i ? 17.6 : 15.2, surfI + 0.05, 3.6); pr.splashes[i].material.opacity = 0.5 * paI * flowGain;
      if (paI > paMax) paMax = paI;
    }
    var pa = paMax;
    phases.pour = (phases.pour + dt * 3.0 * flowGain) % 256; pr.mesh.material.uniforms.uOff.value = phases.pour; pr.mesh.material.uniforms.uA.value = 0.85 * pa;
    var qo = n.inp.Qo, qw = n.inp.Qw, mixW = qo + qw > 0 ? qw / (qo + qw) : 0, pk = Math.round(mixW * 100);
    if (pk !== K.pourKey) { K.pourKey = pk; K.pour.set(mixHex(S.oil ? S.oil.surface : '#c08a3a', PALETTE.waterSurface, mixW)); }
    pr.mesh.material.uniforms.uCol.value.copy(K.pour);
    // dial needles (spring ω 12, ζ 0.55)
    var dl = D.dials.list, dd = D.dials;
    for (i = 0; i < dl.length; i++) {
      var val = 0, rng = 1, k = dl[i].key;
      if (k === 'wh') { val = n.nodes.wellhead.P; rng = dialRanges[0]; } else if (k === 'ckUp') { val = n.nodes.choke.Pin; rng = dialRanges[0]; }
      else if (k === 'ckDn') { val = n.nodes.choke.P; rng = dialRanges[1]; } else if (k === 'sep') { val = n.sep.P; rng = dialRanges[1]; }
      else if (k === 'gas') { val = n.nodes.flare.Pline; rng = dialRanges[1]; } else if (k === 'surge') { val = n.surge.P; rng = dialRanges[2]; }
      else if (k === 'htrT') { val = n.nodes.heater.T; rng = dialRanges[3]; }
      var tgt = (135 - 270 * clamp(val / Math.max(rng, 1e-6), 0, 1)) * Math.PI / 180;
      if (snap) { dd.ang[i] = tgt; dd.vel[i] = 0; } else { var hh = Math.min(dt, 0.05); dd.vel[i] += (144 * (tgt - dd.ang[i]) - 2 * 0.55 * 12 * dd.vel[i]) * hh; dd.ang[i] += dd.vel[i] * hh; }
      setNeedle(i, dl[i].p, dd.ang[i]);
    }
    dd.needles.instanceMatrix.needsUpdate = true;
    // magnetic level-gauge flags (flip 180° about Y over 0.25 s)
    var fd = D.flags, lv = [SM.c1L.x, SM.c1W.x, SM.bF.x];
    for (var g = 0; g < 3; g++) for (var f = 0; f < fd.n; f++) {
      var idx = g * fd.n + f, yf = 1.19 + (f + 0.5) / fd.n * 1.62, fracF = (f + 0.5) / fd.n, stt = fracF <= lv[g] ? 1 : 0;
      if (fd.st[idx] !== stt) { if (fd.st[idx] >= 0 && !snap && !reducedMotion) fd.t[idx] = 0; else fd.t[idx] = 1; fd.st[idx] = stt; }
      if (fd.t[idx] < 1 || snap || fd.init !== true) {
        fd.t[idx] = Math.min(1, fd.t[idx] + dt / 0.25);
        var showNew = fd.t[idx] >= 0.5;
        fd.mesh.setColorAt(idx, (showNew ? stt : 1 - stt) ? K.flagO : K.flagW);
        _e.set(0, fd.t[idx] * Math.PI - (showNew ? Math.PI : 0), 0); _q.setFromEuler(_e); _p.set(fd.x[g], yf, fd.z); _s.set(1, 1, 1); _m4.compose(_p, _q, _s); fd.mesh.setMatrixAt(idx, _m4);
        fd.mesh.instanceMatrix.needsUpdate = true; if (fd.mesh.instanceColor) fd.mesh.instanceColor.needsUpdate = true;
      }
    }
    fd.init = true;
    // windsock, stars
    phases.sock = (phases.sock + dt * 5 * anim) % 6.2832; D.sock.uSockPh.value = phases.sock;
    if (S.stars && (frameNo % 3 === 0)) {
      var st = S.stars, ca = st.attr.array; phases.star = (phases.star + dt * 3) % 6.2832;
      for (i = 0; i < st.ph.length; i++) ca[i * 4 + 3] = st.fx === false ? 0 : 0.55 + 0.45 * Math.sin(phases.star * (0.5 + (i % 7) * 0.15) + st.ph[i]);
      st.attr.needsUpdate = true; st.obj.position.copy(camera.position);
    }
    // halos
    var hm = D.halos.mesh, hp = D.halos.pos, puls = 0.55 + 0.3 * Math.sin(tNow * 0.00628 * (reducedMotion ? 0 : 1));
    for (i = 0; i < EQ_IDS.length; i++) {
      var id = EQ_IDS[i], stq = statusForEq(n.alarms, id, HALO_OPT), h = hp[id], op = 0, hex = K.accent;
      if (stq === 'alarm') { hex = K.alarm; op = puls; } else if (stq === 'warn') { hex = K.warn; op = 0.5; }
      else if (stq === 'hyd') { hex = K.hyd; op = 0.5 * (0.8 + 0.2 * Math.sin(tNow * 0.01 + i)); }
      if (selected === id || hoverId === id) { if (op === 0) hex = K.accent; op = Math.max(op, 0.7); }
      var sc2 = op > 0 ? h[2] + 0.4 : 0.0001;
      _m4.makeScale(sc2, 1, sc2); _m4.setPosition(h[0], 0.03, h[1]); hm.setMatrixAt(i, _m4); _c.copy(hex).multiplyScalar(op); hm.setColorAt(i, _c);
    }
    hm.instanceMatrix.needsUpdate = true; if (hm.instanceColor) hm.instanceColor.needsUpdate = true;
    // setpoint line opacity
    var spl = D.spLines.obj; spl.material.opacity = (selected === 'separator' || hoverId === 'separator') ? 0.8 : 0.22;
    // frost ramp (0→1 over 4 s)
    var fz = n.nodes.choke.hyd || n.segs[2].hydR ? 1 : 0; S.frostU.uFrost.value = clamp(S.frostU.uFrost.value + (fz ? dt / 4 : -dt / 4), 0, 1);
    if (snap) S.frostU.uFrost.value = fz;
    S.segU.frost.value[2] = S.frostU.uFrost.value; S.segU.frost.value[11] = 0;
  }

  // ── flare ───────────────────────────────────────────────────────────────
  var _right = new V3(), _up = new V3(0, 1, 0), _toCam = new V3();
  function updateFlame(dt, tNow, anim) {
    var fl = S.dyn.flame, q = N.nodes.flare.qMMscfd, Lt = flameLength(q);
    fl.Lv = ease('flameL', Lt, dt, 1.2, snapNextLocal); var L = fl.Lv;
    fl.fph = (fl.fph + dt * 8 * anim) % 256; var flick = 0.85 + 0.15 * (0.5 + 0.5 * Math.sin(fl.fph) * Math.sin(fl.fph * 0.37 + 1.3)) * (reducedMotion ? 0.5 : 1);
    fl.ph = (fl.ph + dt * 1.7 * anim) % 6.2832; fl.scroll = (fl.scroll + dt * 2.4 * anim) % 256;
    _toCam.set(camera.position.x - FLAME_BASE[0], 0, camera.position.z - FLAME_BASE[2]).normalize(); _right.crossVectors(_up, _toCam).normalize();
    var lean = 0.55 / (1 + 0.15 * q), W2 = 0.38 * L;
    FLAME_L[0] = fl.core; FLAME_L[1] = fl.outer;
    for (var k = 0; k < 2; k++) {
      var m = FLAME_L[k]; if (!m) continue; var u = m.material.uniforms, sc = k ? 1.3 : 1;
      u.uBase.value.set(FLAME_BASE[0], FLAME_BASE[1], FLAME_BASE[2]); u.uRight.value.copy(_right); u.uWind.value.set(WIND[0], WIND[1], WIND[2]);
      u.uL.value = Math.max(L * sc, 0.001); u.uW.value = W2 * sc; u.uLean.value = lean; u.uPh.value = fl.ph; u.uScroll.value = k ? (fl.scroll * 0.7) % 256 : fl.scroll;
      u.uInt.value = (k ? 0.6 : 1) * flick; m.visible = L > 0.05;
    }
    fl.halo.position.set(FLAME_BASE[0] + WIND[0] * lean * L * 0.4, FLAME_BASE[1] + L * 0.45, FLAME_BASE[2] + WIND[2] * lean * L * 0.4);
    fl.halo.scale.set(2.2 * Math.max(L, 0.01), 2.2 * Math.max(L, 0.01), 1); fl.halo.material.opacity = 0.2 * flick * (L > 0.05 ? 1 : 0);
    fl.pilot.material.opacity = 0.7 + 0.2 * Math.sin(tNow * 0.02);
    S.lights.flare.intensity = 250 * Math.pow(L / 5, 2) * flick;
    S.lights.flare.position.set(FLAME_BASE[0], FLAME_BASE[1] + 0.4 * L, FLAME_BASE[2]);
    S.sky.material.uniforms.uFlareI.value = clamp(L / 5, 0, 1.6) * flick;
    if (fl.streak) { fl.streak.rotation.y = Math.atan2(_toCam.x, _toCam.z); fl.streak.material.opacity = 0.28 * clamp(L / 5, 0, 1.4) * flick; }
    for (var i = 0; i < fl.smoke.length; i++) {
      var sm = fl.smoke[i]; sm.life += dt * anim; if (sm.life > sm.max) sm.life = 0;
      var lt = sm.life / sm.max, h2 = FLAME_BASE[1] + L * 0.9 + lt * 7;
      sm.s.position.set(FLAME_BASE[0] + WIND[0] * (lt * 6 + L * lean) + Math.sin(i * 2.3) * 0.6, h2, FLAME_BASE[2] + WIND[2] * lt * 6 + Math.cos(i * 1.7) * 0.6);
      var ss = 1 + lt * 4; sm.s.scale.set(ss, ss, 1); sm.s.material.opacity = L > 0.5 && !S.fxOff ? 0.18 * Math.sin(lt * Math.PI) * clamp(L / 4, 0, 1) : 0;
    }
  }
  var snapNextLocal = false, frameNo = 0;

  // ── camera update (tweens, inertia, auto-orbit) ─────────────────────────
  var lastCamSig = new Float64Array(8);
  function easeIO(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function updateCamera(dt) {
    if (tween) {
      tween.t += dt; var k = easeIO(clamp(tween.t / Math.max(tween.dur, 1e-3), 0, 1)), f = tween.f, to = tween.to;
      cam.tgt.set(lerp(f.x, to.x, k), lerp(f.y, to.y, k), lerp(f.z, to.z, k)); cam.r = lerp(f.r, to.r, k); cam.th = lerp(f.th, to.th, k); cam.ph = lerp(f.ph, to.ph, k);
      cam.gTgt.copy(cam.tgt); cam.gR = cam.r; cam.gTh = cam.th; cam.gPh = cam.ph;
      if (tween.t >= tween.dur) tween = null;
    } else {
      if (autoOrbit && now() - lastInput > 10000 && !pointers.size) cam.gTh += 4 * Math.PI / 180 * dt;
      clampCam();
      var k2 = 1 - Math.exp(-dt * 10);
      cam.tgt.lerp(cam.gTgt, k2); cam.r += (cam.gR - cam.r) * k2; cam.th += (cam.gTh - cam.th) * k2; cam.ph += (cam.gPh - cam.ph) * k2;
    }
    if (nudge > 0) nudge = Math.max(0, nudge - dt);
    applyCamera();
    var cp = camera.position, ls = lastCamSig;
    if (Math.abs(cp.x - ls[0]) + Math.abs(cp.y - ls[1]) + Math.abs(cp.z - ls[2]) + Math.abs(cam.tgt.x - ls[3]) + Math.abs(cam.tgt.y - ls[4]) + Math.abs(cam.tgt.z - ls[5]) > 1e-3 || W !== ls[6] || Hh !== ls[7]) {
      ls[0] = cp.x; ls[1] = cp.y; ls[2] = cp.z; ls[3] = cam.tgt.x; ls[4] = cam.tgt.y; ls[5] = cam.tgt.z; ls[6] = W; ls[7] = Hh; layoutDirty = true; }
  }

  // ── pointer / wheel / keyboard controls (Pointer Events, no addons) ─────
  var pointers = new Map(), drag = null, pinch = null, clickHist = { t:0, x:0, y:0 }, lastMove = null, engagedT = -1e9, hintTimer = 0, pointerPos = null, hoverDirty = false;
  function markInput() { lastInput = now(); tween = null; introPending = false; }
  function clearPointers() { pointers.forEach(function (p, id) { try { canvas.releasePointerCapture(id); } catch (e) {} }); pointers.clear(); drag = null; pinch = null; }
  function rel(e) { var r = canvas.getBoundingClientRect(); return { x:e.clientX - r.left, y:e.clientY - r.top, w:r.width || W, h:r.height || Hh }; }
  function camAxes(outR, outU) { var m = camera.matrixWorld.elements; outR.set(m[0], m[1], m[2]); outU.set(m[4], m[5], m[6]); }
  var _ax = new V3(), _ay = new V3();
  function pan(dx, dy) { var sc = 2 * cam.gR * Math.tan(18 * Math.PI / 180) / Math.max(Hh, 1); camAxes(_ax, _ay); cam.gTgt.addScaledVector(_ax, -dx * sc).addScaledVector(_ay, dy * sc); userMoved = true; }
  function orbit(dx, dy) { cam.gTh += -dx * 2 * Math.PI / Math.max(W, 1) * 0.9; cam.gPh += -dy * Math.PI / Math.max(Hh, 1) * 0.9; userMoved = true; }
  function onDown(e) {
    if (disposed || !S) return;
    try { canvas.focus({ preventScroll:true }); } catch (x) {}
    engagedT = now(); markInput();
    var p = rel(e); pointers.set(e.pointerId, { x:p.x, y:p.y, x0:p.x, y0:p.y, t0:now(), type:e.pointerType, btn:e.button });
    try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
    if (pointers.size === 1) drag = { mode:(e.button === 1 || e.button === 2 || e.shiftKey) ? 'pan' : 'orbit', moved:false, vx:0, vy:0, lt:now(), id:e.pointerId };
    else if (pointers.size === 2) { var ps = Array.from(pointers.values()); pinch = { span:Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), mx:(ps[0].x + ps[1].x) / 2, my:(ps[0].y + ps[1].y) / 2 }; if (drag) drag.moved = true; }
    canvas.style.cursor = 'grabbing';
  }
  function onMove(e) {
    if (disposed || !S) return;
    var p = rel(e), pt = pointers.get(e.pointerId);
    if (!pt) { if (e.pointerType === 'mouse') { pointerPos = p; hoverDirty = true; } return; }
    var dx = p.x - pt.x, dy = p.y - pt.y; pt.x = p.x; pt.y = p.y;
    if (pointers.size === 1 && drag) {
      if (!drag.moved && Math.hypot(p.x - pt.x0, p.y - pt.y0) > 6) drag.moved = true;
      if (!drag.moved) return;
      markInput();
      if (drag.mode === 'pan' || e.shiftKey) pan(dx, dy); else orbit(dx, dy);
      var tn = now(), dtm = Math.max(1, tn - drag.lt); drag.vx = dx / dtm * 1000; drag.vy = dy / dtm * 1000; drag.lt = tn;
    } else if (pointers.size === 2 && pinch) {
      var ps = Array.from(pointers.values()), span = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), mx = (ps[0].x + ps[1].x) / 2, my = (ps[0].y + ps[1].y) / 2;
      if (span > 1 && pinch.span > 1) cam.gR *= pinch.span / span;
      pan(mx - pinch.mx, my - pinch.my); pinch.span = span; pinch.mx = mx; pinch.my = my; markInput();
    }
  }
  function endPointer(e, isUp) {
    var pt = pointers.get(e.pointerId); if (!pt) return;
    pointers.delete(e.pointerId); try { canvas.releasePointerCapture(e.pointerId); } catch (x) {}
    if (isUp && drag && drag.id === e.pointerId && pointers.size === 0) {
      if (!drag.moved) click(pt.x, pt.y, e);
      else if (now() - drag.lt < 80 && !reducedMotion) { if (drag.mode === 'orbit') orbit(drag.vx * 0.25 * 0.3, drag.vy * 0.25 * 0.3); }
    }
    if (pointers.size === 0) { drag = null; pinch = null; canvas.style.cursor = hoverId ? 'pointer' : 'grab'; }
    else if (pointers.size === 1) { pinch = null; var rest = Array.from(pointers.entries())[0]; drag = { mode:'orbit', moved:true, vx:0, vy:0, lt:now(), id:rest[0] }; }
  }
  function pickAt(x, y) {
    var ndcX = x / Math.max(W, 1) * 2 - 1, ndcY = 1 - y / Math.max(Hh, 1) * 2;
    var v = new V3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize(), o = [camera.position.x, camera.position.y, camera.position.z], d = [v.x, v.y, v.z];
    var best = 1e9, id;
    var tm = rayBoxT(o, d, MUSHROOM.c, MUSHROOM.s); if (tm >= 0) { best = tm; id = 'mushroom'; }
    for (var i = 0; i < PROXIES.length; i++) { var t = rayBoxT(o, d, PROXIES[i][1], PROXIES[i][2]); if (t >= 0 && t < best) { best = t; id = PROXIES[i][0]; } }
    // operable valves win over the equipment proxies (small targets; the vessels are see-through glass)
    var bv = 1e9, vid = null;
    for (var j = 0; j < VALVE_PROXIES.length; j++) { var tv = rayBoxT(o, d, VALVE_PROXIES[j][1], VALVE_PROXIES[j][2]); if (tv >= 0 && tv < bv) { bv = tv; vid = VALVE_PROXIES[j][0]; } }
    if (vid && id !== 'mushroom') return vid;
    if (id) return id;
    if (d[1] < -1e-6) { var tg = (0.02 - o[1]) / d[1], gx = o[0] + d[0] * tg, gz = o[2] + d[2] * tg;
      if (gx >= PAD_RECT.x0 && gx <= PAD_RECT.x1 && gz >= PAD_RECT.z0 && gz <= PAD_RECT.z1) return null; }
    return undefined;
  }
  function click(x, y) {
    var id = pickAt(x, y), tn = now();
    var dbl = tn - clickHist.t < 300 && Math.hypot(x - clickHist.x, y - clickHist.y) < 10;
    clickHist.t = dbl ? 0 : tn; clickHist.x = x; clickHist.y = y;
    if (id === 'mushroom') { if (cb.action) try { cb.action({ type:'esd-trip' }); } catch (e) {} return; }
    var vp = valveOf(id);
    if (vp) { if (cb.action) try { cb.action(vp); } catch (e) {} return; }
    if (dbl) { if (id) H.focus(id); else if (id === null) { userMoved = false; H.view(defaultView()); } return; }
    if (id !== undefined) doPick(id);
  }
  // 'valve:surge:1' → { type:'valve', eq:'surge', idx:1 }; 'suction:surge:0' → { type:'suction', eq:'surge', idx:0 }
  function valveOf(id) {
    if (typeof id !== 'string') return null;
    var m = /^(valve|suction):(surge|gauge):([01])$/.exec(id);
    return m ? { type:m[1], eq:m[2], idx:+m[3] } : null;
  }
  function doPick(id) { if (cb.pick) { try { cb.pick(id); } catch (e) {} } else H.select(id); }
  function onWheel(e) {
    if (disposed || !S) return;
    var engaged = now() - engagedT < 4000 || maxMode || e.ctrlKey;
    if (!engaged) { hintEl.classList.add('on'); clearTimeout(hintTimer); hintTimer = setTimeout(function () { hintEl.classList.remove('on'); }, 1500); return; }
    e.preventDefault(); markInput();
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Hh : 1) * (e.ctrlKey ? 3 : 1);
    var f = Math.exp(clamp(dy, -400, 400) * 0.0012), old = cam.gR;
    cam.gR = clamp(cam.gR * f, 3.5, Math.max(95, 1.3 * fitR));
    // zoom toward the cursor's ground hit
    var p = rel(e), ndcX = p.x / Math.max(W, 1) * 2 - 1, ndcY = 1 - p.y / Math.max(Hh, 1) * 2;
    var v = new V3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
    if (v.y < -0.02) { var t = -camera.position.y / v.y, gx = camera.position.x + v.x * t, gz = camera.position.z + v.z * t, k = 1 - cam.gR / old;
      cam.gTgt.x += (gx - cam.gTgt.x) * k; cam.gTgt.z += (gz - cam.gTgt.z) * k; }
    userMoved = true;
  }
  function onKey(e) {
    var k = e.key, hit = true;
    if (k === 'ArrowLeft') orbit(-30, 0); else if (k === 'ArrowRight') orbit(30, 0); else if (k === 'ArrowUp') orbit(0, -20); else if (k === 'ArrowDown') orbit(0, 20);
    else if (k === '+' || k === '=') cam.gR = clamp(cam.gR * 0.85, 3.5, Math.max(95, 1.3 * fitR)); else if (k === '-' || k === '_') cam.gR = clamp(cam.gR / 0.85, 3.5, Math.max(95, 1.3 * fitR));
    else hit = false;
    if (hit) { e.preventDefault(); markInput(); userMoved = true; }
  }
  function onHover() {
    if (!pointerPos || pointers.size) return;
    var id = pickAt(pointerPos.x, pointerPos.y); if (id === 'mushroom') id = 'esd'; var vp = valveOf(id); if (vp) id = vp.eq;
    id = id || null;
    if (id !== hoverId) { hoverId = id; hoverT = now(); canvas.style.cursor = id ? 'pointer' : 'grab'; layoutDirty = true; }
  }

  // ── bloom (High only, D40) ──────────────────────────────────────────────
  // Screen-space bloom on the tone-mapped, sRGB-encoded frame: the scene renders straight to the (MSAA) canvas
  // exactly as on Medium, the frame is copied to a texture, bright pixels are thresholded and blurred at ½/¼/⅛,
  // and the glow is composited back additively together with a subtle vignette. Keeping the scene on the screen
  // path keeps the glass's premultiply-after-encode (§5.6) and every fluid colour identical across tiers and needs
  // no second (render-target) program variant per material.
  function makeBloom() {
    if (!TIERS[tier].bloom || typeof THREE.FramebufferTexture !== 'function') return null;
    var o = { minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter, depthBuffer:false };
    var b = { fb:null, rt:[] };
    for (var i = 0; i < 3; i++) b.rt.push([new THREE.WebGLRenderTarget(2, 2, o), new THREE.WebGLRenderTarget(2, 2, o)]);
    var tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)); tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    var VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    function mat(fs, u, extra) { return new THREE.ShaderMaterial(Object.assign({ uniforms:u, vertexShader:VS, fragmentShader:fs, depthTest:false, depthWrite:false, toneMapped:false }, extra || {})); }
    var TAP4 = '(texture2D(tSrc,vUv+uTexel*vec2(-1.,-1.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(1.,-1.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(-1.,1.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(1.,1.)).rgb)*0.25';
    b.thr = mat('uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;\nvoid main(){ vec3 c = ' + TAP4 + ';\n' +
      ' float br = max(c.r,max(c.g,c.b)); float k = smoothstep(0.62, 1.0, br); gl_FragColor = vec4(c*k*k,1.0); }', { tSrc:{ value:null }, uTexel:{ value:new THREE.Vector2() } });
    b.down = mat('uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;\nvoid main(){ gl_FragColor = vec4(' + TAP4 + ',1.0); }', { tSrc:{ value:null }, uTexel:{ value:new THREE.Vector2() } });
    b.blur = mat('uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;\nvoid main(){ vec3 c = texture2D(tSrc,vUv).rgb*0.2270270;\n' +
      ' c += (texture2D(tSrc,vUv+uDir*1.0).rgb+texture2D(tSrc,vUv-uDir*1.0).rgb)*0.1945946; c += (texture2D(tSrc,vUv+uDir*2.0).rgb+texture2D(tSrc,vUv-uDir*2.0).rgb)*0.1216216;\n' +
      ' c += (texture2D(tSrc,vUv+uDir*3.0).rgb+texture2D(tSrc,vUv-uDir*3.0).rgb)*0.0540541; c += (texture2D(tSrc,vUv+uDir*4.0).rgb+texture2D(tSrc,vUv-uDir*4.0).rgb)*0.0162162; gl_FragColor = vec4(c,1.0); }',
      { tSrc:{ value:null }, uDir:{ value:new THREE.Vector2() } });
    // out = bloom + dst·vignette   (CustomBlending One / SrcAlpha)
    b.comp = mat('uniform sampler2D tB1, tB2, tB3; uniform float uOn; varying vec2 vUv;\nvoid main(){ vec3 g = uOn*0.55*(texture2D(tB1,vUv).rgb + 0.9*texture2D(tB2,vUv).rgb + 0.8*texture2D(tB3,vUv).rgb);\n' +
      ' float vg = mix(1.0, 0.82, smoothstep(0.55, 1.1, length(vUv-0.5)*1.4)); gl_FragColor = vec4(g*vg, vg); }',
      { tB1:{ value:null }, tB2:{ value:null }, tB3:{ value:null }, uOn:{ value:1 } },
      { transparent:true, blending:THREE.CustomBlending, blendEquation:THREE.AddEquation, blendSrc:THREE.OneFactor, blendDst:THREE.SrcAlphaFactor,
        blendSrcAlpha:THREE.ZeroFactor, blendDstAlpha:THREE.OneFactor });
    b.quad = new THREE.Mesh(tri, b.thr); b.quad.frustumCulled = false; b.scene = new THREE.Scene(); b.scene.add(b.quad); b.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    b.pos = new THREE.Vector2(0, 0);
    b.resize = function () {
      var s2 = renderer.getDrawingBufferSize(new THREE.Vector2()), w2 = Math.max(2, s2.x), h2 = Math.max(2, s2.y);
      if (!b.fb || b.fb.image.width !== w2 || b.fb.image.height !== h2) { if (b.fb) b.fb.dispose(); b.fb = new THREE.FramebufferTexture(w2, h2); b.fb.minFilter = b.fb.magFilter = THREE.LinearFilter; }
      for (var k = 0; k < 3; k++) { var d = Math.pow(2, k + 1); b.rt[k][0].setSize(Math.max(1, w2 / d | 0), Math.max(1, h2 / d | 0)); b.rt[k][1].setSize(Math.max(1, w2 / d | 0), Math.max(1, h2 / d | 0)); }
    };
    b.resize();
    b.dispose = function () { if (b.fb) b.fb.dispose(); b.rt.forEach(function (p) { p[0].dispose(); p[1].dispose(); }); [b.thr, b.down, b.blur, b.comp].forEach(function (m) { m.dispose(); }); tri.dispose(); };
    return b;
  }
  var sceneCalls = 0, sceneTris = 0;
  function pass(m, target) { bloom.quad.material = m; renderer.setRenderTarget(target); renderer.render(bloom.scene, bloom.cam); }
  function renderNow() {
    renderer.info.reset();
    renderer.setRenderTarget(null); renderer.render(S.scene, camera); sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles;
    if (!bloom || S.bloomOff) return;
    var b = bloom; renderer.copyFramebufferToTexture(b.fb, b.pos);
    var src = b.fb;
    for (var k = 0; k < 3; k++) {
      var A = b.rt[k][0], Bt = b.rt[k][1], m = k === 0 ? b.thr : b.down;
      m.uniforms.tSrc.value = src; m.uniforms.uTexel.value.set(0.5 / (A.width * 2), 0.5 / (A.height * 2)); pass(m, A);
      b.blur.uniforms.tSrc.value = A.texture; b.blur.uniforms.uDir.value.set(1 / A.width, 0); pass(b.blur, Bt);
      b.blur.uniforms.tSrc.value = Bt.texture; b.blur.uniforms.uDir.value.set(0, 1 / A.height); pass(b.blur, A);
      src = A.texture;
    }
    var cu = b.comp.uniforms; cu.tB1.value = b.rt[0][0].texture; cu.tB2.value = b.rt[1][0].texture; cu.tB3.value = b.rt[2][0].texture;
    var ac = renderer.autoClear; renderer.autoClear = false; pass(b.comp, null); renderer.autoClear = ac;
  }

  // ── governor (measures cost, not cadence; §5.15) ────────────────────────
  var gov = { cpu:new Float32Array(90), itv:new Float32Array(90), k:0, full:false, lastChange:0, step:0, upSince:0, tq:null, tqExt:null, tqBusy:false, tqN:0, tqT:0, gpuS:new Float32Array(5), gpuN:0, gpuHold:now() + 2000, lastStatsT:0, fpsN:0, fpsT:0, dprT:0, dprLast:0 };
  // GPU cost = median of the last ≤5 timer-query samples; queries started within 2 s of mount / rebuild / resume are discarded (shader compile + warm-up)
  function gpuHoldOff() { gov.gpuHold = now() + 2000; gov.gpuN = 0; stats.gpuMs = null; }
  try { gov.tqExt = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch (e) {}
  function median(a, n) { var b = Array.prototype.slice.call(a, 0, n).sort(function (x, y) { return x - y; }); return b[(n / 2) | 0]; }
  function iqr(a, n) { var b = Array.prototype.slice.call(a, 0, n).sort(function (x, y) { return x - y; }); return b[(n * 0.75) | 0] - b[(n * 0.25) | 0]; }
  function govStep() {
    var s = ++gov.step, T = TIERS[tier];
    if (s === 1) { container.classList.add('wts3d-lowperf'); stats.lowPerf = true; return true; }
    if (s === 2) { if (govScale * Math.min(devDpr(), T.dprCap) - 0.25 >= T.dprFloor - 1e-6) { govScale -= 0.25 / Math.max(Math.min(devDpr(), T.dprCap), 0.5); applyDpr(); resizeTargets(); gov.step = 1; return true; } return govStep(); }
    if (s === 3) { if (S.tr) S.tr.n = Math.max(100, (S.tr.n * 0.5) | 0); return true; }
    if (s === 4) { S.fxOff = true; if (S.stars) S.stars.obj.visible = false; if (S.beams) S.beams.forEach(function (b) { b.visible = false; }); if (S.tr) S.tr.nE = 0; return true; }
    if (s === 5) { if (bloom) { S.bloomOff = true; return true; } return govStep(); }
    if (s === 6) { if (renderer.shadowMap.enabled) { fadeWork(function () { S.scene.traverse(function (o) { if (o.isMesh) o.castShadow = false; }); renderer.shadowMap.needsUpdate = true; S.lights.moon.castShadow = false; }); return true; } return govStep(); }
    if (s === 7) { if (qualityPref === 'auto' && tier !== 'low') { rebuildTier(tier === 'high' ? 'medium' : 'low'); return true; } }
    return false;
  }
  function governor(interval, cpu) {
    gov.cpu[gov.k] = cpu; gov.itv[gov.k] = interval > 0 && interval < 1000 ? interval : 16.7; gov.k = (gov.k + 1) % 90; if (gov.k === 0) gov.full = true;
    gov.fpsN++;
    var tn = now();
    if (gov.full && gov.k === 0) {
      var mc = median(gov.cpu, 90), mi = median(gov.itv, 90), iq = iqr(gov.itv, 90), gpu = stats.gpuMs;
      stats.cpuMs = mc;
      stats.vsyncCapped = (Math.abs(mi - 16.7) < 1.5 || Math.abs(mi - 33.3) < 1.5) && iq < 2 && mc < 8 && (gpu == null || gpu < 12);
      var bad = mc > 12 || (gpu != null && gpu > 14) || (!stats.vsyncCapped && mi > 24);
      if (bad && tn - gov.lastChange > 5000) { if (govStep()) gov.lastChange = tn; gov.upSince = 0; }
      else if (mc < 7 && (gpu == null || gpu < 9)) {
        if (!gov.upSince) gov.upSince = tn;
        else if (tn - gov.upSince > 8000 && tn - gov.lastChange > 5000 && govScale < 1) { govScale = Math.min(1, govScale + 0.25 / Math.max(Math.min(devDpr(), TIERS[tier].dprCap), 0.5)); applyDpr(); resizeTargets(); gov.lastChange = tn; gov.upSince = tn; }
      } else gov.upSince = 0;
    }
    if (tn - gov.fpsT >= 1000) {
      stats.fps = Math.round(gov.fpsN * 1000 / Math.max(tn - gov.fpsT, 1)); gov.fpsN = 0; gov.fpsT = tn;
      stats.drawCalls = sceneCalls; stats.triangles = sceneTris; stats.postCalls = renderer.info.render.calls - sceneCalls; stats.quality = tier;
      if (Math.abs(devDpr() - gov.dprLast) > 1e-3) { gov.dprLast = devDpr(); applyDpr(); resize(); }
      if (cb.stats) try { cb.stats(Object.assign({}, stats)); } catch (e) {}
    }
  }
  function gpuBegin() {
    var ext = gov.tqExt; if (!ext || gov.tqBusy || now() < gov.gpuHold || (gov.tqN++ % 30)) return false;
    gov.tqT = now();
    try { gov.tq = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, gov.tq); gov.tqBusy = true; return true; } catch (e) { gov.tqExt = null; return false; }
  }
  function gpuEnd(started) { if (started) try { gl.endQuery(gov.tqExt.TIME_ELAPSED_EXT); } catch (e) {} }
  function gpuPoll() {
    if (!gov.tqBusy || !gov.tq) return;
    try {
      var av = gl.getQueryParameter(gov.tq, gl.QUERY_RESULT_AVAILABLE), dj = gl.getParameter(gov.tqExt.GPU_DISJOINT_EXT);
      if (av) { if (!dj && gov.tqT >= gov.gpuHold) { gov.gpuS[gov.gpuN % 5] = gl.getQueryParameter(gov.tq, gl.QUERY_RESULT) / 1e6; gov.gpuN++; if (gov.gpuN >= 3) stats.gpuMs = median(gov.gpuS, Math.min(gov.gpuN, 5)); } gl.deleteQuery(gov.tq); gov.tq = null; gov.tqBusy = false; }
    } catch (e) { gov.tqBusy = false; }
  }

  // ── sizing ──────────────────────────────────────────────────────────────
  function resizeTargets() {
    var sz = renderer.getDrawingBufferSize(new THREE.Vector2());
    S && (S.uScale.value = sz.y / (2 * Math.tan(18 * Math.PI / 180)), S.uDpr.value = renderer.getPixelRatio());
    if (bloom) bloom.resize();
  }
  function resize() {
    if (disposed) return;
    var w = container.clientWidth | 0, h = container.clientHeight | 0;
    if (w < 2 || h < 2) { if (!userMoved) needsFit = true; return; }
    var changed = w !== W || h !== Hh; W = w; Hh = h;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    resizeTargets(); layoutDirty = true;
    if (changed || needsFit) refit(true);
  }
  var ro = null;
  try { if (typeof G.ResizeObserver === 'function') { ro = new G.ResizeObserver(function () { if (!paused) resize(); else needsFit = needsFit || !userMoved; }); ro.observe(container); } } catch (e) { ro = null; }

  // ── scene lifecycle ─────────────────────────────────────────────────────
  function buildEnv() {
    var es = new THREE.Scene(), room = new THREE.BoxGeometry(40, 20, 40), nr = room.attributes.normal, cols = new Float32Array(nr.count * 3), cc = new THREE.Color();
    for (var i = 0; i < nr.count; i++) { cc.set(nr.getY(i) < -0.5 ? '#07090c' : nr.getY(i) > 0.5 ? '#16202e' : '#0d141e'); cols[i * 3] = cc.r; cols[i * 3 + 1] = cc.g; cols[i * 3 + 2] = cc.b; }
    room.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    var mats = [], geos = [room];
    es.add(new THREE.Mesh(room, (mats[mats.length] = new THREE.MeshBasicMaterial({ vertexColors:true, side:THREE.BackSide }))));
    function box(w, h, d, x, y, z, r, g, b) { var gg = new THREE.BoxGeometry(w, h, d); geos.push(gg); var m = new THREE.MeshBasicMaterial({ color:new THREE.Color(r, g, b), side:THREE.DoubleSide }); mats.push(m); var me = new THREE.Mesh(gg, m); me.position.set(x, y, z); es.add(me); }
    box(30, 0.1, 3, 0, 9.9, 0, 1.6 * 2.2, 1.75 * 2.2, 2.0 * 2.2);
    box(0.1, 6, 6, 19.9, 6, 0, 4.0, 1.6, 0.5);
    box(0.1, 4, 10, -19.9, 4, 0, 0.25, 0.45, 0.7);
    box(20, 2, 0.1, 0, 2, 19.9, 0.35, 0.35, 0.4);
    box(0.3, 12, 0.1, 4, 6, -19.9, 2.2, 2.4, 2.8);
    box(0.1, 12, 0.3, 19.9, 6, 2, 2.6, 2.2, 1.8);
    var ring = new THREE.CylinderGeometry(19.5, 19.5, 0.4, 48, 1, true); geos.push(ring); var rm = new THREE.MeshBasicMaterial({ color:new THREE.Color(0.35, 0.28, 0.25), side:THREE.DoubleSide }); mats.push(rm);
    var rme = new THREE.Mesh(ring, rm); rme.position.y = 0.5; es.add(rme);
    var pm = new THREE.PMREMGenerator(renderer), rt = pm.fromScene(es, 0.035); pm.dispose();
    geos.forEach(function (g) { g.dispose(); }); mats.forEach(function (m) { m.dispose(); });
    return rt;
  }
  function disposeScene() {
    if (!S) return;
    var seen = new Set();
    S.scene.traverse(function (o) {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      var ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach(function (m) { if (seen.has(m)) return; seen.add(m);
        ['map', 'alphaMap', 'normalMap', 'roughnessMap', 'emissiveMap', 'clearcoatNormalMap'].forEach(function (k) { if (m[k] && m[k].dispose) m[k].dispose(); }); m.dispose(); });
    });
    S.textures.forEach(function (t) { try { t.dispose(); } catch (e) {} });
    if (env) { env.dispose(); env = null; }
    if (bloom) { bloom.dispose(); bloom = null; }
    S = null;
  }
  function buildAll(t) {
    tier = t; stats.quality = t;
    applyDpr();
    env = buildEnv();
    S = buildScene(F, renderer, t, env);
    S.renderer = renderer;
    lastNps = [N.segs[0].nps, N.segs[1].nps, N.segs[2].nps, N.segs[3].nps, N.segs[4].nps, N.segs[5].nps];
    buildPipes(F, S, lastNps);
    makeTracers(F, S);
    oilHexKey = ''; refreshOil(N.inp.API); refreshDials(true); refreshBoards(true); updateSetpointLines();
    bloom = makeBloom();
    S.scene.fog.density = 0.25 / Math.max(fitR, 1); S.groundU.uFitR.value = fitR;
    resizeTargets(); snapNext = true;
    // instance matrices before the first render
    snapNextLocal = true; edgeState(); updateVessels(0.016, true, 1); updateParts(0.016, true, now(), 1); updateFlame(0.016, now(), 1); updateTracers(0); updateJetEmbersFrost(0, now()); updateVesselParticles(0); S.flushGlow();
    renderer.shadowMap.needsUpdate = true;
    stats.lowPerf = false; container.classList.remove('wts3d-lowperf');
  }
  var lastNps = null;
  async function compileAll() {
    var comp = renderer.compileAsync ? function (sc, c) { return renderer.compileAsync(sc, c); } : function (sc, c) { renderer.compile(sc, c); return Promise.resolve(); };
    await comp(S.scene, camera);
    if (bloom) { [bloom.thr, bloom.down, bloom.blur, bloom.comp].forEach(function (m) { bloom.quad.material = m; renderer.compile(bloom.scene, bloom.cam); }); }
  }
  function fadeWork(fn) { canvas.style.opacity = '0'; setTimeout(function () { if (disposed) return; try { fn(); compileAll().then(function () { canvas.style.opacity = ''; }, function () { canvas.style.opacity = ''; }); } catch (e) { canvas.style.opacity = ''; } }, 150); }
  var rebuilding = false;
  function rebuildTier(t) {
    if (rebuilding || disposed || !TIERS[t]) return; rebuilding = true;
    canvas.style.opacity = '0';
    setTimeout(function () {
      if (disposed) { rebuilding = false; return; }
      try { disposeScene(); buildAll(t); gov.step = 0; govScale = 1; gpuHoldOff(); applyDpr(); resizeTargets(); attachSnapshot(); labelDirty = true;
        compileAll().then(function () { rebuilding = false; canvas.style.opacity = ''; }, function () { rebuilding = false; canvas.style.opacity = ''; });
      } catch (e) { rebuilding = false; canvas.style.opacity = ''; if (cb.error) try { cb.error(e, true); } catch (x) {} }
    }, 150);
  }
  function attachSnapshot() {
    canvas.__h2oilSnapshot = function () {
      if (disposed || lost || !S) return null;
      try { renderNow(); return canvas.toDataURL('image/png'); } catch (e) { return null; }
    };
  }

  // ── frame ───────────────────────────────────────────────────────────────
  var lastRender = -1e9, errCount = 0, textT = 0, occT2 = 0;
  H.frame = function (state, dtReal) {
    if (disposed) return;
    if (!container.isConnected) { H.dispose(); return; }
    try {
      var t0 = now(), gap = lastFrameTs >= 0 ? (t0 - lastFrameTs) / 1000 : 1; lastFrameTs = t0;
      var dt = clamp(num(dtReal, gap), 0, 0.1);
      normalize(state, N);
      if (paused || lost || !S || rebuilding) { errCount = 0; return; }
      frameNo++;
      var snap = snapNext || gap > 0.5; snapNext = false; snapNextLocal = snap; if (snap && frameNo > 1) gpuHoldOff();
      if (needsFit && W >= 2 && Hh >= 2) refit(true);
      if (introPending && W >= 2) { introPending = false; jumpTo({ tgt:[-15, 1.3, 0], r:6, th:-35 * Math.PI / 180, ph:(90 - 12) * Math.PI / 180 }); startTween(viewTarget(defaultView()), 3.2); }
      if (!camFinite()) H.resetView();
      var running = N.running;
      flowGain = snap ? (running ? 1 : 0) : clamp(flowGain + (running ? 1 : -1) * dt / 0.4, 0, 1);
      var anim = running ? 1 : 0.5;
      refreshOil(N.inp.API);
      if (N.flowSeq !== lastFlowSeq) {
        lastFlowSeq = N.flowSeq; labelDirty = true;
        var np = [N.segs[0].nps, N.segs[1].nps, N.segs[2].nps, N.segs[3].nps, N.segs[4].nps, N.segs[5].nps];
        if (np.join(',') !== lastNps.join(',')) { lastNps = np; buildPipes(F, S, np); renderer.shadowMap.needsUpdate = true; }
      }
      if (N.alarmVersion !== lastAlarmV) { lastAlarmV = N.alarmVersion; labelDirty = true; }
      if ((frameNo & 15) === 0) { refreshDials(false); refreshBoards(false); updateSetpointLines(); }
      // overlay ranges + pipe tint (with the colour wave)
      var pmin = 1e9, pmax = -1e9, tmin = 1e9, tmax = -1e9;
      for (var ni = 0; ni < NODE_NAMES.length; ni++) { var nd = N.nodes[NODE_NAMES[ni]]; pmin = Math.min(pmin, nd.P); pmax = Math.max(pmax, nd.P, nd.Pin); tmin = Math.min(tmin, nd.T); tmax = Math.max(tmax, nd.T); }
      pRange.min = Math.max(0, pmin); pRange.max = Math.max(pmax, pRange.min + 1); tRange.min = Math.min(tmin, N.nodes.choke.th); tRange.max = Math.max(tmax, tRange.min + 1);
      var su = S.segU;
      for (var si = 0; si < 14; si++) {
        segColour(si, su.col.value[si]);
        var sI = si <= 5 ? si : (si === 11 ? 5 : -1), al = 0;
        if (sI >= 0 && overlay !== 'temperature') { var vs = N.segs[sI].vSt; al = vs === 'EXCEED' ? 2 : vs === 'WARNING' ? 1 : 0; }
        su.alert.value[si] = al;
      }
      su.pulse.value = 0.5 + 0.5 * Math.sin(t0 * 0.006);
      if (waveOld) { waveOld.t += dt; su.wave.value = reducedMotion ? 1e6 : S.pipes.totalS * clamp(waveOld.t / 1.2, 0, 1); if (waveOld.t > 1.3) { waveOld = null; su.wave.value = 1e6; } }
      for (si = 0; si < 14; si++) { var sv = si <= 5 ? si : -1, velS = sv >= 0 ? velToScene(N.segs[sv].vel) : 0.6; su.ph.value[si] = (su.ph.value[si] + velS * dt * flowGain) % 256; }
      edgeState();
      updateVessels(dt, snap, anim);
      updateTracers(dt); updateJetEmbersFrost(dt, t0); updateVesselParticles(dt);
      updateParts(dt, snap, t0, anim); updateFlame(dt, t0, anim);
      if (hoverDirty && (frameNo % 3 === 0)) { hoverDirty = false; onHover(); }
      updateCamera(dt);
      S.sky.position.copy(camera.position);
      // labels: text ≤ 8 Hz (and on flowSeq / alarmVersion / selection / units changes); transforms per frame
      if (labelDirty || t0 - textT > 125) { textT = t0; updateLabelText(); }
      for (var ci = 0; ci < chips.length; ci++) { var chx = chips[ci]; if (chx.flashT && t0 - chx.flashT > 400) { chx.flashT = 0; chx.el.classList.remove('flash'); } }
      if (t0 - occT2 > 250) { occT2 = t0; occlusion(); }
      if (layoutDirty) placeLabels(false);
      S.flushGlow();
      // FPS cap
      var cap = TIERS[tier].fps;
      if (!H._debug.noCap && t0 - lastRender < 1000 / cap - 2) { errCount = 0; return; }
      var itv = t0 - lastRender; lastRender = t0;
      gpuPoll(); var q = gpuBegin(); renderNow(); gpuEnd(q);
      governor(itv, now() - t0);
      errCount = 0;
    } catch (err) {
      errCount++;
      if (cb.error) try { cb.error(err, errCount >= 3); } catch (e) {} else if (errCount < 4) try { console.error('[WTS_3d] frame', err); } catch (e) {}
    }
  };

  // ── public handle methods ───────────────────────────────────────────────
  function guard(fn) { return function () { if (disposed) return; return fn.apply(null, arguments); }; }
  H.resize = guard(function () { resize(); });
  H.setPaused = guard(function (b) { b = !!b; if (paused === b) return; paused = b; if (!b) { resize(); snapNext = true; labelDirty = true; } else clearPointers(); });
  H.setOverlay = guard(function (m) {
    if (!/^(phase|pressure|temperature|erosion)$/.test(m) || m === overlay) return;
    if (S && S.segU) { for (var i = 0; i < 14; i++) S.segU.colOld.value[i].copy(S.segU.col.value[i]); S.segU.wave.value = 0; }
    overlay = m; waveOld = { t:0 }; labelDirty = true; layoutDirty = true;
  });
  H.setLabels = guard(function (m) { if (/^(all|equip|off)$/.test(m)) { labelMode = m; layoutDirty = true; labelsEl.style.display = m === 'off' ? 'none' : ''; svg.style.display = m === 'off' ? 'none' : ''; } });
  H.setQuality = guard(function (q) {
    if (!/^(auto|high|medium|low)$/.test(q)) return; qualityPref = q; gov.step = 0; govScale = 1;
    var t = q === 'auto' ? autoTier : q; if (t !== tier) rebuildTier(t); else { applyDpr(); resizeTargets(); }
  });
  H.setInsets = guard(function (i) {
    i = i || {}; insets = { top:num(i.top, 0), bottom:num(i.bottom, 0), left:num(i.left, 0), right:num(i.right, 0), card:i.card || null };
    layoutDirty = true; if (!paused) refit(false); else needsFit = true;
  });
  H.setReducedMotion = guard(function (b) { reducedMotion = !!b; });
  H.setAutoOrbit = guard(function (b) { autoOrbit = !!b; lastInput = now() - 10001; });
  H.setInteraction = guard(function (o) { maxMode = !!(o && o.max); canvas.style.touchAction = maxMode ? 'none' : 'pan-y'; clearPointers(); });
  H.view = guard(function (name) { if (!VIEWS[name]) name = 'overview'; markInput(); userMoved = name !== defaultView(); if (W < 2) { needsFit = true; return; } startTween(viewTarget(name), 0.9); });
  H.focus = guard(function (id) {
    var f = FOCUS[id]; if (!f) return; markInput(); userMoved = true;
    var th = cam.th, d = ((th + 18 * Math.PI / 180) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (Math.abs(d) > Math.PI / 3) th = -18 * Math.PI / 180;
    startTween({ tgt:f[0], r:f[1], th:th, ph:clamp(cam.ph, 0.95, 1.3) }, 0.9);
  });
  H.select = guard(function (id) { selected = id && EQ_IDS.indexOf(id) >= 0 ? id : null; labelDirty = true; layoutDirty = true;
    for (var i = 0; i < chips.length; i++) chips[i].el.classList.toggle('sel', chips[i].id === selected); });
  H.resetView = guard(function () {
    userMoved = false; tween = null;
    if (W < 2 || Hh < 2) { needsFit = true; cam.tgt.set(2, 2, 0); cam.gTgt.set(2, 2, 0); cam.r = cam.gR = 40; cam.th = cam.gTh = -0.314; cam.ph = cam.gPh = 1.19; return; }
    jumpTo(viewTarget(defaultView()));
  });
  H.legend = function () {
    var m = overlay;
    if (m === 'phase') { var oc = oilColor(N.inp.API);
      return { mode:'phase', min:0, max:0, unit:'', stops:[{ t:0, color:PALETTE.gasTracer }, { t:0.33, color:oc.css }, { t:0.66, color:PALETTE.waterCss }, { t:1, color:mixHex(oc.body, PALETTE.emulsionMix, 0.5) }] }; }
    var st = CMAPS[m].map(function (s) { return { t:s[1], color:s[0] }; });
    if (m === 'pressure') return { mode:m, min:pRange.min, max:pRange.max, unit:'pressureG', stops:st };
    if (m === 'temperature') return { mode:m, min:tRange.min, max:tRange.max, unit:'temperature', stops:st };
    return { mode:m, min:0, max:120, unit:'percent', stops:st };
  };
  H.refreshUnits = guard(function () { units = opts.units || units; if (S) { refreshDials(true); refreshBoards(true); } labelDirty = true; for (var i = 0; i < allChips.length; i++) allChips[i].measure = true; });
  H.dispose = function () {
    if (disposed) return; disposing = true;
    try { if (loopId && G.cancelAnimationFrame) G.cancelAnimationFrame(loopId); } catch (e) {}
    loopId = 0;
    try { if (ro) ro.disconnect(); } catch (e) {}
    listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {} }); listeners.length = 0;
    clearTimeout(hintTimer);
    try { disposeScene(); } catch (e) {}
    try { renderer.dispose(); renderer.forceContextLoss(); } catch (e) {}
    try { delete canvas.__h2oilSnapshot; } catch (e) {}
    cleanupDom();
    disposed = true; disposing = false;
  };
  function cleanupDom() {
    [canvas, svg, labelsEl, hintEl].forEach(function (el) { try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) {} });
    try { releaseCss(doc); } catch (e) {}
  }
  Object.defineProperty(H, 'disposed', { get:function () { return disposed; } });
  Object.defineProperty(H, 'stats', { get:function () { return stats; } });
  H._debug = { renderer:function () { return renderer; }, scene:function () { return S && S.scene; }, camera:camera, N:N, cam:cam, gov:function () { return gov; } };

  // ── listeners ───────────────────────────────────────────────────────────
  var loopId = 0;
  function attachListeners() {
    on(canvas, 'pointerdown', onDown); on(canvas, 'pointermove', onMove);
    on(canvas, 'pointerup', function (e) { endPointer(e, true); });
    on(canvas, 'pointercancel', function (e) { endPointer(e, false); }); on(canvas, 'lostpointercapture', function (e) { endPointer(e, false); });
    on(canvas, 'pointerleave', function (e) { if (e.pointerType === 'mouse' && !pointers.size) { pointerPos = null; if (hoverId) { hoverId = null; layoutDirty = true; } } });
    on(canvas, 'wheel', onWheel, { passive:false }); on(canvas, 'keydown', onKey);
    on(canvas, 'contextmenu', function (e) { e.preventDefault(); });
    on(canvas, 'webglcontextlost', function (e) {
      if (disposed || disposing) return; e.preventDefault(); lost = true;
      if (cb.error) try { cb.error(Object.assign(new Error('context-lost'), { code:'context-lost' }), true); } catch (x) {}
    });
    on(doc, 'visibilitychange', function () { clearPointers(); if (doc.visibilityState === 'visible') snapNext = true; });
    on(G, 'blur', clearPointers);
    canvas.style.touchAction = 'pan-y'; canvas.style.cursor = 'grab';
  }

  // ── staged build (§5.16): 3 frames, compile before reveal, warm-up ─────
  H.__build = async function () {
    await nextFrame(); if (disposed) throw mkErr('build', 'disposed');
    resize(); applyDpr();
    await nextFrame(); if (disposed) throw mkErr('build', 'disposed');
    buildAll(tier);
    await nextFrame(); if (disposed) throw mkErr('build', 'disposed');
    attachListeners(); attachSnapshot();
    resize(); refit(true); if (introPending) { /* intro starts on the first frame */ }
    await compileAll();
    try { applyCamera(); renderNow(); } catch (e) {}
    if (opts.autoLoop) {
      var last = now();
      var loop = function () { if (disposed) return; var t = now(), d = (t - last) / 1000; last = t; H.frame(typeof opts.getState === 'function' ? opts.getState() : null, d); loopId = G.requestAnimationFrame(loop); };
      loopId = G.requestAnimationFrame(loop);
    }
    delete H.__build;
    return H;
  };
  return H;
}

// ═════════════════════════════════════════════════════════════════════════
// mount(container, opts) → Promise<Handle3D>
// ═════════════════════════════════════════════════════════════════════════
function mount(container, opts) {
  return new Promise(function (resolve, reject) {
    if (!container || !isSupported()) { reject(mkErr('no-webgl', 'WebGL2 unavailable')); return; }
    loadThree().then(function (THREE) {
      var h = null;
      try { h = createHandle(THREE, container, opts || {}); }
      catch (e) { reject(e && e.code ? e : mkErr('build', e && e.message || 'build', e)); return; }
      _visibleBudget(h.__build(), 15000, 'timeout').then(resolve, function (e) {
        try { h.dispose(); } catch (x) {}
        reject(e && (e.code === 'timeout' || e.code === 'no-webgl') ? e : mkErr('build', e && e.message || 'build', e));
      });
    }, function (e) { reject(e && e.code ? e : mkErr('offline', 'three-load-failed', e)); });
  });
}

// ═════════════════════════════════════════════════════════════════════════
// §G PUBLIC
// ═════════════════════════════════════════════════════════════════════════
var _internals = {
  PALETTE:PALETTE, STATUS_MAP:STATUS_MAP, FIT_BOX:FIT_BOX, PROCESS_BOX:PROCESS_BOX, FIT_PTS:FIT_PTS, V101_BOX:V101_BOX, PROXIES:PROXIES, VALVE_PROXIES:VALVE_PROXIES, ROUTES:ROUTES,
  TIERS:TIERS, VIEWS:VIEWS, FOCUS:FOCUS, STEP:STEP, NULLABLE:NULLABLE, ANCHORS:ANCHORS, CHAIN_DEF:CHAIN_DEF,
  pipeRadius:pipeRadius, buildRoute:buildRoute, routeLength:routeLength, routeSample:routeSample,
  capHalfWidth:capHalfWidth, vertCapRadius:vertCapRadius, vesselProfile:vesselProfile, oilColor:oilColor, velToScene:velToScene,
  flameLength:flameLength, phaseFractions:phaseFractions, niceRange:niceRange, pickTier:pickTier, lodForDistance:lodForDistance,
  layoutLabels:layoutLabels, statusForEq:statusForEq, normalize:normalize, makeNorm:makeNorm, fakeSnapshot:fakeSnapshot,
  colormap:colormap, colormapRGB:colormapRGB, fitRadius:fitRadius, fitView:fitView, project:project, camDir:camDir,
  boxCorners:boxCorners, luminance:luminance, mixHex:mixHex, dpFor:dpFor, defFmtParts:defFmtParts
};
WTS_3d.version = VERSION;
WTS_3d.THREE_URLS = ['https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js',
                     'https://unpkg.com/three@0.170.0/build/three.module.min.js'];
// base64 SHA-384 of three@0.170.0/build/three.module.min.js (691,648 bytes; identical on jsDelivr and unpkg)
WTS_3d.THREE_SHA384 = 'IDC7sAMAIMB/TZ6dgKKPPAKZ2bXXXP8+FBMBC8cU319eBhKITx+PaalhfDkDNH28';
WTS_3d.isSupported = isSupported;
WTS_3d.loadThree = loadThree;
WTS_3d.hasLocalCopy = hasLocalCopy;
WTS_3d.mount = mount;
WTS_3d.palette = PALETTE;
WTS_3d.oilColor = oilColor;
WTS_3d.STATUS_MAP = STATUS_MAP;
WTS_3d._internals = _internals;
G.WTS_3d = WTS_3d;
})();
// === SELF-TEST ===
(function () {
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var W = G.WTS_3d; if (!W || !W._internals) return;
  var I = W._internals, pass = 0, total = 14, fails = [];
  function ok(n, c, msg) { if (c) pass++; else fails.push(n + (msg ? ' ' + msg : '')); }
  function near(a, b, e) { return Math.abs(a - b) <= e; }
  function t(n, fn) { try { fn(); } catch (e) { fails.push(n + ' threw ' + (e && e.message)); } }
  // 1 route length + exact endpoints
  t(1, function () {
    var r = I.buildRoute([[0, 0, 0], [3, 0, 0], [3, 2, 0]], 0.4 / 3), L = 5 - 0.8 + Math.PI * 0.4 / 2;
    var a = I.routeSample(r, 0), b = I.routeSample(r, r.length);
    ok(1, near(I.routeLength(r), L, 1e-9) && a.p[0] === 0 && a.p[1] === 0 && near(b.p[0], 3, 1e-12) && near(b.p[1], 2, 1e-12), 'len ' + r.length);
  });
  // 2 cap geometry
  t(2, function () {
    ok(2, I.capHalfWidth(0.6, 4.8, 0.3, 0.6, 0) === 0.6 && I.capHalfWidth(0.6, 4.8, 0.3, 0, 0) === 0 && near(I.capHalfWidth(0.6, 4.8, 0.3, 1.2, 0), 0, 1e-12) &&
      I.vertCapRadius(1.2, 3.6, 0.6, 2.0) === 1.2);
  });
  // 3 flame length
  t(3, function () { ok(3, I.flameLength(0.001) === 0 && near(I.flameLength(10), 5.08, 0.01)); });
  // 4 tracer speed map
  t(4, function () { ok(4, near(I.velToScene(50), 3.0, 0.05) && I.velToScene(0) === 0 && I.velToScene(0.01) === 0 && I.velToScene(0.02) === 0.05 && I.velToScene(1e6) === 6); });
  // 5 oil colour luminance
  t(5, function () { ok(5, I.luminance(I.oilColor(10).body) < I.luminance(I.oilColor(50).body)); });
  // 6 normalize fills every field, no NaN, no allocation with scratch
  t(6, function () {
    function walk(o, p, bad) { for (var k in o) { var v = o[k]; if (typeof v === 'number' && !isFinite(v)) bad.push(p + k); else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p + k + '.', bad); else if (Array.isArray(v)) v.forEach(function (x, i) { if (x && typeof x === 'object') walk(x, p + k + '[' + i + '].', bad); }); } return bad; }
    var a = I.normalize({}), b = I.normalize(null), out = I.makeNorm(), c = I.normalize(I.fakeSnapshot(5), out);
    var bad = walk(a, '', []).concat(walk(b, '', [])).concat(walk(c, '', []));
    ok(6, !bad.length && c === out && a.sep.c1fracW === 0.25 && a.sep.c1fracL === 0.6 && a.sep.bfrac === 0.32 && a.surge.frac === 0.55 && a.surge.fracW === 0.15 &&
      a.gauge.tanks[0].frac === 0.3 && a.gauge.tanks[1].frac === 0 && a.esd.travel === 1 && a.nodes.heater.firing === 1 && b.nodes.flare.qMMscfd === 10 && a.inp.API === 35 &&
      a.segs.length === 6 && a.segs[2].nps === '6', bad.join(','));
  });
  // 7 tier pick
  t(7, function () { ok(7, I.pickTier({ mobile:true }) === 'medium' && I.pickTier({ software:true }) === 'low' && I.pickTier({}) === 'high'); });
  // 8 label placement
  t(8, function () {
    var rects = [], anchors = [], i;
    for (i = 0; i < 8; i++) { rects.push({ w:110, h:40, prio:i === 3 ? 0 : 3 + i * 0.01, pref:'n', seg:false }); anchors.push({ x:260 + (i % 4) * 90, y:260 + Math.floor(i / 4) * 70, hide:false }); }
    var card = { x:600, y:150, w:200, h:300 }, out = I.layoutLabels(rects, anchors, { w:1200, h:700 }, { top:40, bottom:60, left:0, right:0, card:card });
    var overlap = false, inCard = false, placed = 0;
    for (i = 0; i < 8; i++) { var a = out[i]; if (!a.ok) continue; placed++;
      if (a.x < card.x + card.w && a.x + 110 > card.x && a.y < card.y + card.h && a.y + 40 > card.y) inCard = true;
      for (var j = 0; j < 8; j++) { var b = out[j]; if (j === i || !b.ok) continue; if (a.x < b.x + 110 && a.x + 110 > b.x && a.y < b.y + 40 && a.y + 40 > b.y) overlap = true; } }
    ok(8, !overlap && !inCard && placed >= 7 && out[3].ok && out[3].dir === 'n', 'placed ' + placed);
  });
  // 9 status mapping
  t(9, function () {
    var A = function (sev, id) { return { id:id || 'X', sev:sev, eq:'separator' }; };
    ok(9, I.statusForEq([A('trip')], 'separator') === 'alarm' && I.statusForEq([A('info')], 'separator') === 'evt' &&
      I.statusForEq([A('hyd'), A('warn')], 'separator') === 'warn' && I.statusForEq([A('info'), A('hyd')], 'separator') === 'hyd' &&
      I.statusForEq([A('alarm'), A('warn')], 'separator') === 'alarm' && I.statusForEq([], 'separator') === 'ok' &&
      I.statusForEq([A('info')], 'separator', { forHalo:true }) === 'ok' && I.statusForEq([{ id:'ESD_MANUAL', sev:'info', eq:'esd' }], 'esd', { forHalo:true }) === 'warn' &&
      W.STATUS_MAP.trip === 'alarm' && W.STATUS_MAP.info === 'evt');
  });
  // 10 isSupported false + mount rejects 'no-webgl' (under the Node / stub environment)
  var async10 = null;
  t(10, function () {
    var sup = W.isSupported();
    if (sup) { ok(10, true); return; }            // real browser: not applicable
    var pr = W.mount({ appendChild:function () {} }, {});
    ok(10, !!pr && typeof pr.then === 'function', 'mount must return a promise');
    pr.then(function () { console.error('[32-wts-3d] self-test 10 FAILED: mount resolved without WebGL'); }, function (e) { if (!(e && e.code === 'no-webgl')) console.error('[32-wts-3d] self-test 10 FAILED: rejected with ' + (e && e.code)); });
  });
  // 11 fakeSnapshot schema walk (NULLABLE honoured)
  t(11, function () {
    var NL = (G.WTS_sim && G.WTS_sim.NULLABLE) || I.NULLABLE, bad = [];
    var re = NL.map(function (p) { return new RegExp('^' + p.replace(/\[\*\]/g, '.*').replace(/\./g, '\\.').replace(/\*/g, '\\d+') + '$'); });
    function nullable(p) { for (var i = 0; i < re.length; i++) if (re[i].test(p)) return true; return false; }
    function walk(o, p) { for (var k in o) { var v = o[k], q = p ? p + '.' + k : k;
      if (v === null) { if (!nullable(q)) bad.push(q); } else if (typeof v === 'number') { if (!isFinite(v)) bad.push(q); } else if (typeof v === 'object') walk(v, q); } }
    [0, 12.3, 5000, 90000].forEach(function (tt) { walk(I.fakeSnapshot(tt), ''); });
    walk(I.fakeSnapshot(40, { esd:'tripped', tEsd:30 }), ''); walk(I.fakeSnapshot(40, { esd:'manual', tEsd:30 }), '');
    var s = I.fakeSnapshot(12.3);
    ok(11, !bad.length && s.v === 1 && s.segs.length === 6 && s.gauge.tanks.length === 2 && typeof s.lines.psv_surge.vel === 'number', bad.slice(0, 5).join(','));
  });
  // 12 LOD hysteresis
  t(12, function () { ok(12, I.lodForDistance(1.0, true) && I.lodForDistance(1.0, false) && I.lodForDistance(1.0) && I.lodForDistance(1.45, true) && !I.lodForDistance(1.45, false) && !I.lodForDistance(1.6, true) && I.lodForDistance(1.2, false)); });
  // 13 framing gate (§5.2 pixel gates)
  var gate = {};
  t(13, function () {
    function sizeOf(box, fv, w, h) {
      var d = I.camDir(fv.az, fv.el), cam = { target:fv.target, pos:[fv.target[0] + d[0] * fv.radius, fv.target[1] + d[1] * fv.radius, fv.target[2] + d[2] * fv.radius], fov:36 };
      var C = I.boxCorners(box), x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      C.forEach(function (c) { var p = I.project(c, cam, w, h); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
      return { w:x1 - x0, h:y1 - y0 };
    }
    var OV = I.VIEWS.overview, fv = I.fitView(I.FIT_PTS, OV.az, OV.el, 36, 1380, 700, { top:98, bottom:76, left:0, right:0, card:null });
    var r = I.fitRadius(I.FIT_PTS, OV.az, OV.el, 36, 1380, 700, { top:98, bottom:76, left:0, right:0, card:null });
    var rBox = I.fitRadius(I.FIT_BOX, OV.az, OV.el, 36, 1380, 700, { top:98, bottom:76, left:0, right:0, card:null });
    var s = sizeOf(I.V101_BOX, fv, 1380, 700);
    var fp = I.fitView(I.PROCESS_BOX, -10, 30, 36, 375, 471, { top:0, bottom:0, left:0, right:0, card:null });
    var sp = sizeOf(I.V101_BOX, fp, 375, 471);
    gate = { r:r, h:s.h, w:s.w, ph:sp.h };
    ok(13, near(r, fv.radius, 1e-9) && r <= rBox + 1e-6 && s.h >= 55 && s.w >= 170 && sp.h >= 22, JSON.stringify(gate));
  });
  // 14 compact stage: a chip with no free ring slot is docked in a free band (never faded over another chip)
  t(14, function () {
    var rects = [], anchors = [], i, st = { w:390, h:700 }, ins = { top:98, bottom:76, left:0, right:0, card:null };
    for (i = 0; i < 9; i++) { rects.push({ w:150, h:45, prio:3 + i * 0.01, pref:'n', seg:false }); anchors.push({ x:120 + (i % 3) * 70, y:330 + Math.floor(i / 3) * 40, hide:false }); }
    var out = I.layoutLabels(rects, anchors, st, ins), bad = [];
    for (i = 0; i < 9; i++) { var a = out[i]; if (!a.vis) continue;
      for (var j = 0; j < 9; j++) { var b = out[j]; if (j === i || !b.vis) continue; if (a.x < b.x + 150 && a.x + 150 > b.x && a.y < b.y + 45 && a.y + 45 > b.y) bad.push(i + '/' + j); } }
    var shown = out.filter(function (o) { return o.vis; }).length, faded = out.filter(function (o) { return o.vis && !o.ok; }).length;
    ok(14, !bad.length && shown >= 6 && faded === 0, 'overlap ' + bad.join(',') + ' shown ' + shown + ' faded ' + faded);
  });
  function report() {
    var line = '[32-wts-3d] self-test ' + pass + '/' + total + ' passed' + (fails.length ? ' — FAILED: ' + fails.join('; ') : '');
    try { if (fails.length) console.error(line); else console.log(line); } catch (e) {}
    try { if (typeof module !== 'undefined' && require.main === module && typeof process !== 'undefined') { console.log('[32-wts-3d] framing: fitRadius ' + gate.r.toFixed(1) + ' m, V-101 ' + gate.h.toFixed(0) + '×' + gate.w.toFixed(0) + ' px, portrait V-101 ' + gate.ph.toFixed(0) + ' px tall'); if (fails.length) process.exitCode = 1; } } catch (e) {}
    G.__WTS3D_SELFTEST = { pass:pass, total:total, fails:fails };
  }
  report();
})();
