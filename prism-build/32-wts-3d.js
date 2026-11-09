/* ═══════════════════════════════════════════════════════════════════════════
 * 32-wts-3d.js — Well Test Simulator: live 3D process scene (Round-7)
 * ─────────────────────────────────────────────────────────────────────────
 * window.WTS_3d  — Three.js r170 "industrial digital twin at blue hour":
 *   WH-101 → SDV-101 (ESD) → CK-101 → H-101 → V-101 → gas → FS-401
 *                                             └→ liquids → T-201 → LCV-201 → T-301A|B → P-201 → export
 *   (no pump between T-201 and T-301: LCV-201 transfers on the surge tank pressure)
 *   · rig-up: equipment out of the spread (snapshot rigup) is shown as a ghost with its bypass
 *     spool (amber); the scene is rebuilt when the rig-up changes
 *   · optional rig-up items (v1.2.0, docs/SIM-EQUIPMENT-PLAN.md §8.0–8.1): DS-101 cyclonic desander between
 *     SDV-101 and CK-101 (bypass HV-104, sand dump XV-103 to a skip) and T-202 second surge tank (XV-202,
 *     LCV-202, PCV-203/204, PSV-202) — out by default and then absent everywhere (geometry, picking, occlusion,
 *     framing, chips, step numbers, tracers, lamps); step numbers come from WTS_sim.stepFor(rig)
 *   · v1.3.0 (docs/SIM-FOLLOWUP-PLAN.md §8.1): CK-102 heater inlet choke — optional rig-up item on the H-101 inlet stub
 *     (out by default and then absent; greyed "bypassed" per frame while the heater is bypassed), PAH-102 tag between the
 *     chokes; with V-101 out the bypass spool follows the destination (burner / flare line, or the production line through
 *     PSHH-104, NRV-501 and XV-501); the scene is rebuilt on rigSig + the destination (V-101 out only)
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
var VERSION = '1.4.0';

var PALETTE = {
  skyZenith:'#04070c', skyHorizon:'#0f1826', skyBelow:'#07090c', warmGlow:'#2a160c', fog:'#0b111a',
  pad:'#121821', gridMinor:'#161d27', gridMajor:'#22406a', earth:'#0a0d11',
  steelDark:'#2b313a', steelSatin:'#7f8b99', bolt:'#1f242b', rubber:'#111418',
  yellow:'#d9a520', accent:'#f0883e', paintBlue:'#27496d',
  glassTint:'#cfe3ff', glassRim:'#9ccfff', gasTracer:'#d8f0ff', mist:'#9ec9ff',
  waterBody:'#1f7fe0', waterSurface:'#4fb3ff', waterTracer:'#4aa3ff', waterCss:'#1f7fe0',
  emulsionMix:'#c9b28a', heaterBath:'#1b7f79',
  sandBody:'#c8a165', sandTracer:'#e0bf7a',
  ok:'#3fb950', warn:'#d29922', alarm:'#f85149', hyd:'#58a6ff', frost:'#dceeff', info:'#bc8cff'
};

var STATUS_MAP = { trip:'alarm', alarm:'alarm', warn:'warn', hyd:'hyd', info:'evt' };
var STATUS_RANK = { ok:0, evt:1, hyd:2, warn:3, alarm:4 };

// v1.2.0 (docs/SIM-EQUIPMENT-PLAN.md §8.0–8.1): DS-101 cyclonic desander (upstream of the choke) and T-202 second surge tank
// are OPTIONAL rig-up items — out by default, and while out they are absent and hidden (D18: no ghost, no chip, no picking /
// occlusion / framing / label / tracer volume). Every table below that lists them is filtered by the effective rig-up (rigIn).
// v1.3.0 (docs/SIM-FOLLOWUP-PLAN.md §8.1): CK-102 heater inlet choke (heaterChoke) is the third optional item, appended.
var EQ_IDS = ['wellhead','esd','choke','heater','separator','flare','surge','pump','gauge','desander','surge2','heaterChoke'];
var OPT = { desander:true, surge2:true, heaterChoke:true };
var OPT_IDS = ['desander', 'surge2', 'heaterChoke'];
var STEP = { wellhead:'①', esd:'②', choke:'③', heater:'④', separator:'⑤',
             flare:'⑥', surge:'⑦', gauge:'⑧', pump:'⑨' };   // P-201 sits downstream of the gauge tank (fallback; chips use stepFor)
var STEP_ORDER = ['wellhead', 'esd', 'desander', 'choke', 'heaterChoke', 'heater', 'separator', 'flare', 'surge', 'surge2', 'gauge', 'pump'];
var TAGS = { wellhead:'WH-101', esd:'SDV-101', choke:'CK-101', heater:'H-101', separator:'V-101',
             flare:'FS-401', surge:'T-201', pump:'P-201', gauge:'T-301', desander:'DS-101', surge2:'T-202', heaterChoke:'CK-102' };
var TITLES = { wellhead:'WELLHEAD', esd:'ESD VALVE', choke:'CHOKE', heater:'LINE HEATER', separator:'SEPARATOR',
               flare:'FLARE', surge:'SURGE TANK', pump:'TRANSFER PUMP', gauge:'GAUGE TANK', desander:'DESANDER', surge2:'SURGE TANK 2',
               heaterChoke:'HEATER INLET CHOKE' };
var PREF_SIDE = { wellhead:'nw', esd:'n', choke:'ne', heater:'n', separator:'n', flare:'e', surge:'nw', pump:'se', gauge:'ne',
                  desander:'se', surge2:'ne', heaterChoke:'nw' };

// Label anchors (top of equipment + 0.3 m)
var ANCHORS = {
  wellhead:[-15.0,2.75,0], esd:[-11.6,3.6,0], choke:[-7.2,2.25,0], heater:[-1.4,2.75,0], separator:[5.6,3.2,0],
  flare:[19.5,8.1,-4.5], surge:[10.2,6.0,4.0], pump:[20.4,1.35,6.3], gauge:[16.4,3.2,4.0],
  desander:[-10.2,3.5,-1.6], surge2:[12.5,5.8,2.3], heaterChoke:[-3.45,2.8,0.4]
};
// in the effective rig-up? core items: unless strictly false; optional items: only when strictly true (D2)
function rigIn(rig, id) { return OPT[id] ? !!(rig && rig[id] === true) : !(rig && rig[id] === false); }
// does the item take part in picking / occlusion / framing / focus? Core items always (their v3.3 ghost stays pickable and
// still hides labels); optional items only while they are in the rig-up (§8.0, D18)
function optIn(rig, id) { return !OPT[id] || rigIn(rig, id); }

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
// fit set for the effective rig-up: FIT_PTS (v3.3) plus the box of each optional item that is in (§8.1)
// (CK-102 sits inside the upstream fit box, so its box adds points but never moves the extents)
var FIT_OPT = { desander:[[-10.85, 0, -3.9], [-9.15, 3.4, -1.1]], surge2:[[11.5, 0, 1.3], [13.5, 6.0, 3.3]],
                heaterChoke:[[-4.15, 1.6, 0.1], [-3.2, 2.62, 0.7]] };
function fitPts(rig) {
  var add = [];
  OPT_IDS.forEach(function (g) { if (rigIn(rig, g)) add.push(FIT_OPT[g]); });
  if (!add.length) return FIT_PTS;
  var p = FIT_PTS.pts.slice(), mn = FIT_PTS.min.slice(), mx = FIT_PTS.max.slice();
  add.forEach(function (b) {
    for (var i = 0; i < 8; i++) p.push([i & 1 ? b[1][0] : b[0][0], i & 2 ? b[1][1] : b[0][1], i & 4 ? b[1][2] : b[0][2]]);
    for (var k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b[0][k]); mx[k] = Math.max(mx[k], b[1][k]); }
  });
  return { min:mn, max:mx, pts:p };
}
var V101_BOX = { min:[5.6-3.425,2.0-0.85,-0.85], max:[5.6+3.425,2.0+0.85,0.85] };

// Hand-authored picking / occlusion proxies (centre, size) — §5.11
var PROXIES = [
  ['wellhead',[-15,1.0,0],[1.2,2.4,1.2]],
  ['esd',[-11.6,1.8,0],[0.9,3.4,0.9]], ['esd',[-12.6,1.1,1.5],[0.6,0.9,0.3]],
  ['choke',[-7.2,0.9,0],[3.8,1.4,2.0]],
  ['heater',[-1.4,1.6,0],[3.4,1.7,1.7]], ['heater',[0.55,3.5,0.28],[0.5,3.6,0.5]],
  ['separator',[5.6,2.0,0],[6.9,1.8,1.8]],
  ['surge',[10.2,3.3,4.0],[2.5,4.9,2.5]],
  ['pump',[20.35,0.55,5.95],[0.9,1.1,1.7]],
  ['gauge',[16.4,1.55,4.0],[5.0,2.6,2.6]],
  ['flare',[19.5,3.9,-4.5],[0.8,7.8,0.8]], ['flare',[19.5,0.2,-4.5],[1.6,0.4,1.6]],
  // optional items (appended; filtered out by rigProxies while the item is out of the rig-up)
  ['desander',[-10.2,1.55,-1.6],[0.9,3.1,0.9]], ['desander',[-10.2,0.45,-3.5],[1.2,0.9,0.7]],
  ['surge2',[12.5,3.2,2.3],[1.9,4.6,1.9]],                      // inscribed (x 11.55…13.45; T-201's proxy ends at x 11.45)
  ['heaterChoke',[-3.45,2.1,0.4],[0.5,0.9,0.5]]                 // x −3.7…−3.2: clear of the H-101 proxy (x −3.1…0.3)
];
var MUSHROOM = { c:[-12.6,0.95,1.66], s:[0.14,0.14,0.12] };
// CK-101 choke manifold (v1.5.0): plan of the 3-1/16" 10K two-choke manifold GA drawing, square loop on a skid (no mirror:
// drawing left = −x, right = +x, top = −z (back), bottom = +z (front)). Inlet studded tee front-left (xW, zF) with the inlet
// hammer union at 45° out to (−x, +z); outlet studded tee back-right (xE, zB) with the outlet union at 45° out to (+x, −z);
// angle-body chokes in the two other corners — ADJUSTABLE front-right (drawing path 2: bottom gate → choke → right gate),
// POSITIVE back-left (path 1: left gate → choke → top gate); one gate valve per side, at the side's midpoint
var CK_M = { xW:-7.8, xE:-6.3, zF:0.75, zB:-0.75, xc:-7.05, y:1.2, blk:0.42, uOff:0.56,
  dg:[Math.SQRT1_2, 0, -Math.SQRT1_2],                   // union axis = flow direction through both unions
  legs:{
    adj:  { c:[-6.3, 0.75],  dIn:[1, 0, 0],  dOut:[0, 0, -1], gates:[[-7.05, 0.75, 'x'], [-6.3, 0, 'z']] },   // path 2: bottom gate → choke → right gate
    fixed:{ c:[-7.8, -0.75], dIn:[0, 0, -1], dOut:[1, 0, 0],  gates:[[-7.8, 0, 'z'], [-7.05, -0.75, 'x']] }   // path 1: left gate → choke → top gate
  } };
// points where a route ends inside a manifold block or choke body (no end flanges drawn there; the blocks carry their own):
// inlet tee, outlet tee, adjustable choke, positive choke
var CK_JOINTS = [[CK_M.xW, CK_M.y, CK_M.zF], [CK_M.xE, CK_M.y, CK_M.zB], [CK_M.xE, CK_M.y, CK_M.zF], [CK_M.xW, CK_M.y, CK_M.zB]];
// Operable valves (tap/click toggles): T-201 inlets XV-201A/B, P-201 suctions A/B, T-301 inlets XV-301A/B;
// optional items: T-202 inlet XV-202, DS-101 dump XV-103 ("Dump sand"), DS-101 bypass HV-104
var VALVE_PROXIES = [
  ['valve:surge:0',[8.8,4.2,4.15],[0.5,0.5,0.75]], ['valve:surge:1',[11.62,4.2,4.15],[0.5,0.5,0.75]],
  ['suction:surge:0',[10.1,0.5,4.05],[0.42,0.42,0.5]], ['suction:surge:1',[10.65,0.72,4.05],[0.42,0.42,0.5]],
  ['valve:gauge:0',[15.3,3.2,3.6],[0.62,0.5,0.5]], ['valve:gauge:1',[17.7,3.2,3.6],[0.62,0.5,0.5]],
  ['valve:surge2:0',[9.6,3.05,2.0],[0.5,0.6,0.5]], ['dump:desander',[-10.2,0.62,-2.6],[0.45,0.6,0.45]],
  ['bypass:desander',[-10.0,1.4,0],[0.45,0.7,0.45]],
  // v1.5.0: CK-101 manifold legs — two boxes per leg, one per side of its L (gate → corner choke → gate; tap = put that leg in
  // service); the four boxes are pairwise disjoint and leave both studded tees to the 'choke' proxy. The positive leg's left-side
  // box starts at y 1.1 (not 0.945): a tap on the inlet tee seen from the front-left cameras continues down behind the tee, and
  // must not reach that box (it would put the positive leg in service instead of opening the card)
  ['ckleg:adj',  [-6.75, 1.42, 0.75],  [1.5, 0.95, 0.56]],  ['ckleg:adj',  [-6.3, 1.42, 0.01],  [0.56, 0.95, 0.92]],
  ['ckleg:fixed',[-7.8, 1.4975, -0.3], [0.56, 0.795, 1.5]], ['ckleg:fixed',[-7.06, 1.42, -0.75], [0.92, 0.95, 0.56]]
];
var PAD_RECT = { x0:-20, x1:24, z0:-10, z1:8.5 };
// T-201 B-inlet branch (v1.4.0): tee on LM at x 8.55 → behind the shell (z 3.5) → over the top head (y 5.95) → down on the +X
// side (x 12.0) → B's side nozzle at (11.4, 4.2, 4.0), the same height as A's nozzle (9.0, 4.2, 4.0)
var TB_BRANCH = [[8.55, 4.2, 4.0], [8.55, 4.2, 3.5], [8.55, 5.95, 3.5], [12.0, 5.95, 3.5], [12.0, 4.2, 3.5], [12.0, 4.2, 4.0], [11.4, 4.2, 4.0]];
// equipment id an (optional) picking / valve proxy belongs to
function proxyEq(id) { if (/^ckleg:/.test(id)) return 'choke'; var m = /^(?:valve|suction|dump|bypass):([a-z0-9]+)/.exec(id); return m ? m[1] : id; }

// Framing boxes per equipment group (view presets only, never picking)
var EQ_BOX = {
  wellhead:[[-16.6,0,-1.6],[-13.4,2.6,1.9]], esd:[[-12.9,0,-0.6],[-11.0,3.4,1.8]], choke:[[-9.15,0,-1.6],[-4.9,2.05,1.6]],
  heater:[[-3.3,0,-0.9],[1.0,5.4,1.6]], separator:[[2.1,0,-0.9],[9.1,3.1,1.2]], flare:[[18.6,0,-5.3],[20.4,7.8,-3.7]],
  surge:[[8.9,0,2.7],[11.5,6.2,5.3]], pump:[[19.8,0,5.0],[22.3,1.4,6.8]], gauge:[[13.8,0,1.9],[19.4,3.9,5.5]],
  desander:FIT_OPT.desander, surge2:FIT_OPT.surge2, heaterChoke:FIT_OPT.heaterChoke
};
var VIEWS = {
  overview:{ groups:null, az:-18, el:20, margin:1 },
  wellhead:{ groups:['wellhead','esd','choke','desander'], az:-25, el:24, margin:1.15 },
  separator:{ groups:['heater','separator','heaterChoke'], az:-20, el:20, margin:1.20 },
  tanks:{ groups:['surge','pump','gauge','surge2'], az:-10, el:28, margin:1.20 },
  flare:{ groups:['flare'], az:-15, el:12, margin:1.30, flame:true },
  process:{ groups:['separator','surge','gauge','surge2'], az:-10, el:30, margin:1.15 }
};
var FOCUS = {
  wellhead:[[-15,1.3,0],7], esd:[[-11.6,1.8,0],6], choke:[[-7.05,1.35,0],5.0], heater:[[-1.4,1.7,0.3],8],
  separator:[[5.6,2.0,0],11], surge:[[10.2,3.2,4.0],11], pump:[[20.7,0.6,6.0],6], gauge:[[16.4,1.6,4.0],11],
  flare:[[19.5,5,-4.5],18], desander:[[-10.2,1.6,-2.2],7], surge2:[[12.5,3.2,2.3],10], heaterChoke:[[-3.6,2.05,0.35],5]
};
// fixed focus azimuth (deg) for items that another vessel hides from the usual -18° side: T-202 sits behind T-201 there,
// so it is framed from +3° (between T-201 and T-301; wts3d framing check)
var FOCUS_TH = { surge2:3 };
// Equipment halos [x, z, radius] and blob shadows [x, z, sx, sz] (optional rows only while the item is in)
var HALO = { wellhead:[-15, 0, 1.7], esd:[-11.9, 0.5, 1.3], choke:[-7.05, 0, 2.6], heater:[-1.4, 0.3, 2.5], separator:[5.6, 0, 3.9],
             flare:[19.5, -4.5, 1.4], surge:[10.2, 4.0, 1.8], pump:[20.4, 5.9, 1.1], gauge:[16.4, 4.0, 3.2],
             desander:[-10.2, -1.6, 0.9], surge2:[12.5, 2.3, 1.5], heaterChoke:[-3.45, 0.4, 0.6] };
var BLOBS = [[-7.05, 0, 4.4, 3.2], [-1.4, 0.4, 4.8, 3.0], [5.6, 0, 7.4, 2.4], [10.2, 4.0, 3.2, 3.2], [20.3, 5.8, 1.2, 2.0], [16.4, 4.0, 5.8, 3.4],
             [19.5, -4.5, 2.2, 2.2], [-8, -6.5, 7.0, 3.4], [-11.6, 0, 1.4, 1.4], [-18.5, 5.0, 2.0, 2.8], [22.0, 3.0, 2.0, 2.8]];
var BLOBS_OPT = { desander:[[-10.2, -1.6, 1.4, 1.4], [-10.2, -3.5, 1.6, 1.1]], surge2:[[12.5, 2.3, 2.6, 2.6]] };
// Label obstacles (vessel cores the chips avoid): V-101, T-201, T-301 (+ T-202 while it is in)
var OBST_BOXES = [{ box:V101_BOX }, { box:{ min:[9.0, 0.9, 2.8], max:[11.4, 5.7, 5.2] } }, { box:{ min:[13.9, 0.25, 2.7], max:[18.9, 2.85, 5.3] } },
                  { box:{ min:[11.5, 0.9, 1.3], max:[13.5, 5.5, 3.3] }, rig:'surge2' }];

// ── tables filtered by the effective rig-up (§8.0, D18): a hidden item has no volume anywhere ──
function rigProxies(rig) { return PROXIES.filter(function (p) { return optIn(rig, p[0]); }); }
function rigValveProxies(rig) { return VALVE_PROXIES.filter(function (p) { return optIn(rig, proxyEq(p[0])); }); }
function rigObst(rig) { return OBST_BOXES.filter(function (o) { return !o.rig || rigIn(rig, o.rig); }); }
function rigEqIds(rig) { return EQ_IDS.filter(function (id) { return optIn(rig, id); }); }
function rigBlobs(rig) { var b = BLOBS.slice(); OPT_IDS.forEach(function (g) { if (rigIn(rig, g) && BLOBS_OPT[g]) b = b.concat(BLOBS_OPT[g]); }); return b; }
// framing box of a view preset for the rig-up (optional groups that are out do not count; core ghosts frame as in v3.3);
// flameTop raises the flare view; an empty box falls back to the overview fit set
function viewBox(name, rig, flameTop) {
  var vw = VIEWS[name] || VIEWS.overview;
  if (!vw.groups) return fitPts(rig);
  var box = { min:[1e9, 1e9, 1e9], max:[-1e9, -1e9, -1e9] };
  vw.groups.forEach(function (g) { if (!optIn(rig, g)) return; var b = EQ_BOX[g]; for (var i = 0; i < 3; i++) { box.min[i] = Math.min(box.min[i], b[0][i]); box.max[i] = Math.max(box.max[i], b[1][i]); } });
  if (box.min[0] > box.max[0]) return fitPts(rig);
  if (vw.flame && flameTop != null) box.max[1] = Math.max(box.max[1], flameTop);
  return box;
}
// step numbers for the effective rig-up (D17): WTS_sim.stepFor when present, else the same rule locally (STEP for the default)
function stepFor(rig) {
  var S = G.WTS_sim;
  if (S && typeof S.stepFor === 'function') { try { var m = S.stepFor(rig || {}); if (m && typeof m === 'object') return m; } catch (e) {} }
  var out = {}, n = 0;
  for (var i = 0; i < STEP_ORDER.length; i++) { var k = STEP_ORDER[i]; if (OPT[k] && !rigIn(rig, k)) continue; n++; out[k] = String.fromCharCode(0x2460 + n - 1); }
  return out;
}
// 3D → 38 action payloads (§6.11): 'valve:surge:1' → {type:'valve', eq:'surge', idx:1}; 'dump:desander' → {type:'dump', eq:'desander'}
function valveOf(id) {
  if (typeof id !== 'string') return null;
  var m = /^(valve|suction):(surge|surge2|gauge):([01])$/.exec(id);
  if (m) return { type:m[1], eq:m[2], idx:+m[3] };
  m = /^(dump|bypass):desander$/.exec(id);
  if (m) return { type:m[1], eq:'desander' };
  m = /^ckleg:(adj|fixed)$/.exec(id);                                  // v1.4.0: CK-101 leg (choke body or one of its gate valves)
  return m ? { type:'ckleg', eq:'choke', leg:m[1] } : null;
}

// Pipe routes (orthogonal waypoints; fillets added automatically) — §5.3
// aSeg: 0–5 main segments, 6 LW, 7 LO, 8 LM, 9 BLK, 10 VENT, 11 XA/XB, 12 DD (sand dump; E2b until v1.3.0), 13 DRA/DRB,
// 14–17 the CK-101 legs (CK_LEG_SLOTS: 14 E2a / 15 E2b upstream, 16 E3 / 17 E3f downstream; fed per frame from segment 1 / 2
// while that leg is in service, else the isolated look of slot 12 with no alert, frost or chevron motion)
// v1.2.0: E2 keeps its index but starts at the DS-101 bypass tee (D0a + D0b + E2 = the v3.3 E2); LM keeps its index as LMa
// (LMa + LMb = the v3.3 LM). Routes tagged rig:'desander' / rig:'surge2' are built only while that item is in (ROUTE_IDX stays).
var ROUTES = [
  { id:'E1',  aSeg:0, seg:0, line:'wh_esd',       phase:'multi', pts:[[-14.2,1.2,0],[-12.0,1.2,0]] },
  // v1.5.0 CK-101 manifold (GA drawing plan): E2 = inlet line to the inlet tee (front-left), arriving along the 45° union axis;
  // the four legs are straight 2-point runs (each 90° turn is inside a choke body, a CK_JOINT): E2a (appended) = adjustable
  // upstream (front side, + x), E2b = positive upstream (left side, − z), E3 = adjustable downstream (right side, − z, to the
  // outlet tee), E3f (appended) = positive downstream (back side, + x); E3o (appended) = outlet tee (45° union) → heater tee
  { id:'E2',  aSeg:1, seg:1, line:'esd_choke',    phase:'multi', rb:0.2, pts:[[-9.3,1.2,0],[-8.95,1.2,0],[-8.95,1.2,1.35],[-8.4,1.2,1.35],[-7.8,1.2,0.75]] },
  { id:'E2b', aSeg:15, seg:1, line:'esd_choke',    phase:'multi', pts:[[-7.8,1.2,0.75],[-7.8,1.2,-0.75]] },
  { id:'E3',  aSeg:16, seg:2, rSeg:1, line:'choke_heater', phase:'multi', pts:[[-6.3,1.2,0.75],[-6.3,1.2,-0.75]] },
  { id:'E3c', aSeg:2, seg:2, line:'choke_heater', phase:'multi', unless:'heaterChoke', pts:[[-4.3,1.2,0],[-3.9,1.2,0],[-3.9,1.9,0],[-3.9,1.9,0.4],[-3.15,1.9,0.4]] },
  { id:'E3b', aSeg:2, seg:2, line:'choke_heater', phase:'multi', pts:[[-4.3,1.2,0],[-4.3,1.2,1.5],[1.0,1.2,1.5],[1.0,1.2,0]] },
  { id:'E4a', aSeg:3, seg:3, line:'heater_sep',   phase:'multi', pts:[[0.35,1.9,-0.4],[1.0,1.9,-0.4],[1.0,1.2,-0.4],[1.0,1.2,0]] },
  { id:'E4',  aSeg:3, seg:3, line:'heater_sep',   phase:'multi', pts:[[1.0,1.2,0],[1.6,1.2,0],[1.6,2.3,0],[2.05,2.3,0]] },
  { id:'G1',  aSeg:4, seg:4, line:'sep_flare',    phase:'gas',   pts:[[8.1,2.87,0],[8.1,3.6,0],[18.6,3.6,0],[18.6,3.6,-4.5],[18.6,1.0,-4.5],[19.28,1.0,-4.5]] },
  { id:'LW',  aSeg:6, seg:-1, nps:3, line:'sep_water', phase:'water', pts:[[6.3,1.13,0],[6.3,0.55,0],[6.3,0.55,2.4],[8.1,0.55,2.4]] },
  { id:'LO',  aSeg:7, seg:-1, nps:3, line:'sep_oil',   phase:'oil',   pts:[[8.1,1.13,0],[8.1,0.55,0],[8.1,0.55,2.4]] },
  { id:'LMa', aSeg:8, seg:-1, nps:3, line:'LM',        phase:'liquid',pts:[[8.1,0.55,2.4],[8.1,0.55,4.0],[8.1,2.9,4.0]] },
  { id:'BLK', aSeg:9, seg:-1, nps:2, line:'blanket',   phase:'gas',   pts:[[4.1,2.87,0],[4.1,4.9,0],[4.1,4.9,4.0],[9.0,4.9,4.0]] },
  { id:'VENT',aSeg:10, seg:-1, nps:2, line:'surge_vent', phase:'gas', pts:[[10.2,5.7,4.0],[10.2,6.1,4.0],[13.0,6.1,4.0],[13.0,6.1,0],[13.0,3.6,0]] },
  // X1 → LCV-201 (control valve at x 12.5, no pump: the surge tank pressure drives the transfer) → X2
  { id:'X1',  aSeg:5, seg:5, line:'surge_gauge',  phase:'liquid', pts:[[10.65,0.95,4.0],[10.65,0.45,4.0],[12.2,0.45,4.0]] },
  { id:'X2',  aSeg:5, seg:5, line:'surge_gauge',  phase:'liquid', pts:[[12.8,0.45,4.0],[13.4,0.45,4.0],[13.4,3.4,4.0],[13.4,3.4,3.6],[15.2,3.4,3.6]] },
  { id:'XA',  aSeg:11, seg:5, line:'surge_gauge', phase:'liquid', pts:[[15.2,3.4,3.6],[15.2,2.7,3.6]] },
  { id:'XB',  aSeg:11, seg:5, line:'surge_gauge', phase:'liquid', pts:[[15.2,3.4,3.6],[17.6,3.4,3.6],[17.6,2.7,3.6]] },
  // gauge tank drains → P-201 (downstream of the gauge tank) → export / burner
  { id:'DRA', aSeg:13, seg:-1, nps:3, line:'gauge_drain', phase:'liquid', pts:[[15.4,0.45,5.4],[15.4,0.45,6.3],[20.0,0.45,6.3]] },
  { id:'DRB', aSeg:13, seg:-1, nps:3, line:'gauge_drain', phase:'liquid', pts:[[17.9,0.45,5.4],[17.9,0.45,6.3]] },
  // ── v1.2.0 (appended) — DS-101: SDV-101 → D0a → (D1 → DS-101 → D2 | D0b bypass with HV-104) → E2 → CK-101; XV-103 dump DD ──
  { id:'D0a', aSeg:1, seg:1, line:'esd_choke', phase:'multi', pts:[[-11.2,1.2,0],[-10.75,1.2,0]] },
  { id:'D0b', aSeg:1, seg:1, line:'esd_choke', phase:'multi', pts:[[-10.75,1.2,0],[-9.3,1.2,0]] },     // plain line while DS-101 is out
  { id:'D1',  aSeg:1, seg:1, line:'esd_choke', phase:'multi', rig:'desander', pts:[[-10.75,1.2,0],[-10.75,2.5,0],[-10.75,2.5,-1.6],[-10.45,2.5,-1.6]] },
  { id:'D2',  aSeg:1, seg:1, line:'esd_choke', phase:'multi', rig:'desander', pts:[[-10.2,2.9,-1.6],[-10.2,3.2,-1.6],[-9.3,3.2,-1.6],[-9.3,1.2,-1.6],[-9.3,1.2,0]] },
  { id:'DD',  aSeg:12, seg:-1, nps:1.5, line:'ds_dump', phase:'sand', rig:'desander', pts:[[-10.2,0.5,-1.93],[-10.2,0.5,-2.9],[-10.2,1.1,-2.9],[-10.2,1.1,-3.5]] },
  // ── T-202: dump header tee on LM (LMa | LMb → T-201; LM2 → XV-202 → T-202), LCV-202 X0 → X2 riser, PCV-203 VENT2 → VENT,
  //    PCV-204 BLK2 (from BLK), PSV-202 PSV2 → PSV header ──
  { id:'LMb', aSeg:8, seg:-1, nps:3, line:'LM', phase:'liquid', pts:[[8.1,2.9,4.0],[8.1,4.2,4.0],[9.0,4.2,4.0]] },
  { id:'LM2', aSeg:8, seg:-1, nps:3, line:'sep_surge2', phase:'liquid', rig:'surge2', pts:[[8.1,2.9,4.0],[8.1,2.9,2.0],[11.55,2.9,2.0]] },
  { id:'X0',  aSeg:5, seg:-1, nps:3, line:'surge2_gauge', phase:'liquid', rig:'surge2', pts:[[12.5,0.9,2.3],[12.5,0.45,2.3],[12.5,0.45,3.5],[13.4,0.45,3.5],[13.4,0.45,4.0]] },
  { id:'VENT2', aSeg:10, seg:-1, nps:2, line:'surge2_vent', phase:'gas', rig:'surge2', pts:[[12.5,5.5,2.3],[12.5,6.1,2.3],[13.0,6.1,2.3]] },
  { id:'BLK2', aSeg:9, seg:-1, nps:2, line:'blanket2', phase:'gas', rig:'surge2', pts:[[7.6,4.9,4.0],[7.6,4.9,2.0],[11.55,4.9,2.0]] },
  { id:'PSV2', aSeg:10, seg:-1, nps:1, line:'psv_surge2', phase:'gas', rig:'surge2', pts:[[11.9,5.85,2.3],[11.35,5.85,2.3],[11.35,4.1,2.3],[11.35,4.1,0]] },
  // ── v1.3.0 (appended) — CK-102 on the H-101 inlet leg: E3c (built only while CK-102 is out, as in v3.3.1) splits into
  //    E3c1 (tee → riser → CK-102 inlet, the line between the chokes with PAH-102) and E3c2 (CK-102 outlet → coil inlet).
  //    E3c1 + CK-102 body + E3c2 = the E3c polyline; the body (centre CK2_AT) sits on its last horizontal stub and the two
  //    routes end on its faces (flanged), as the CK-101 legs end on the CK-101 body ──
  { id:'E3c1', aSeg:2, seg:2, line:'choke_heater', phase:'multi', rig:'heaterChoke', pts:[[-4.3,1.2,0],[-3.9,1.2,0],[-3.9,1.9,0],[-3.9,1.9,0.4],[-3.65,1.9,0.4]] },
  { id:'E3c2', aSeg:2, seg:2, line:'choke_heater', phase:'multi', rig:'heaterChoke', pts:[[-3.25,1.9,0.4],[-3.15,1.9,0.4]] },
  // ── v1.4.0 (appended) — CK-101 manifold legs (see E2 / E2b / E3 above; v1.5.0 points) ──
  { id:'E2a', aSeg:14, seg:1, line:'esd_choke', phase:'multi', pts:[[-7.8,1.2,0.75],[-6.3,1.2,0.75]] },
  { id:'E3f', aSeg:17, seg:2, rSeg:1, line:'choke_heater', phase:'multi', pts:[[-7.8,1.2,-0.75],[-6.3,1.2,-0.75]] },
  { id:'E3o', aSeg:2, seg:2, line:'choke_heater', phase:'multi', rb:0.2, pts:[[-6.3,1.2,-0.75],[-5.7,1.2,-1.35],[-5.15,1.2,-1.35],[-5.15,1.2,0],[-4.3,1.2,0]] }
];
// CK-101 leg shader slots (v1.4.0): slot → { src segment, leg }. The in-service leg's slots copy their segment's colour, alert,
// frost and chevron phase each frame; the standby leg's slots show the isolated look (slot 12), alert 0, frost 0, phase frozen
var CK_LEG_SLOTS = { 14:{ src:1, leg:'adj' }, 15:{ src:1, leg:'fixed' }, 16:{ src:2, leg:'adj' }, 17:{ src:2, leg:'fixed' } };
var SEG_SLOTS = 18;                                                     // shader uniform array length (aSeg 0–17)
// one slot's look this frame: its source segment while its leg is in service, else isolated (slot 12) (pure; Node-testable)
function ckLegSlot(slot, leg) { var d = CK_LEG_SLOTS[slot]; if (!d) return null; var live = d.leg === (leg === 'fixed' ? 'fixed' : 'adj');
  return { src:d.src, live:live, look:live ? d.src : 12 }; }
var NEW_ROUTES = ['D0a', 'D0b', 'D1', 'D2', 'DD', 'LM2', 'X0', 'VENT2', 'BLK2', 'PSV2', 'E3c1', 'E3c2'];
// CK-102 body: the CK-101 block (angle body, bonnet, handwheel) at 0.8 scale, except that the body is sized for the 6-inch
// line (0.40 m along the flow × 0.46 m, wider than the pipe it sits on). It sits on the last horizontal stub of the inlet leg
// (x −3.65…−3.25), clear of the riser (x −3.69) and of the shell end ring (x −3.13)
var CK2_AT = [-3.45, 1.9, 0.4], CK2_BODY = [0.40, 0.46, 0.46];
var PSV_ROUTE = [[5.2,2.87,0],[5.2,4.1,0],[12.4,4.1,0],[12.4,3.6,0]];
// tees [x, y, z, size(NPS; 6 = main seg 2, 4 = main seg 1), rig?] — a rig-tagged tee is drawn only while its item is in,
// but always suppresses the end flanges at its point (the v3.3 lines stay plain)
var TEES = [[-4.3,1.2,0,6],[1.0,1.2,0,6],[15.2,3.4,3.6,3],[8.1,0.55,2.4,3],[17.9,0.45,6.3,3],[13.0,3.6,0,6],[12.4,3.6,0,6],
  [-10.75,1.2,0,4,'desander'],[-9.3,1.2,0,4,'desander'],
  [8.1,2.9,4.0,3,'surge2'],[13.4,0.45,4.0,3,'surge2'],[13.0,6.1,2.3,2,'surge2'],[7.6,4.9,4.0,2,'surge2'],[11.35,4.1,0,3,'surge2']];
// equipment connection points of the optional items (route ends that are not on a route or tee) — §9.2 endpoint check
var NOZZLES = { desander:[[-10.45,2.5,-1.6],[-10.2,2.9,-1.6],[-10.2,0.5,-1.93],[-10.2,1.1,-3.5]],
                surge2:[[11.55,2.9,2.0],[11.55,4.9,2.0],[12.5,0.9,2.3],[12.5,5.5,2.3],[11.9,5.85,2.3]],
                heaterChoke:[[-3.65, 1.9, 0.4], [-3.25, 1.9, 0.4]] };
// Rig-up bypass spools (amber), drawn only while the item is out of the rig-up
var BYPASS_SPOOLS = {
  separator:[[1.6,2.3,0],[1.6,2.3,-1.25],[1.6,3.6,-1.25],[8.1,3.6,-1.25],[8.1,3.6,0]],    // heater outlet → flare line (clean-up)
  surge:[[8.1,0.55,4.0],[8.1,0.55,6.0],[12.95,0.55,6.0],[12.95,0.55,4.0]],                 // separator dumps → T-301 fill line
  gauge:[[13.4,0.45,4.0],[13.4,0.45,6.6],[16.6,0.45,6.6],[16.6,0.45,6.3]],                 // LCV-201 → drain / export line
  flare:[[18.6,1.0,-4.5],[18.6,1.0,-6.6],[22.4,1.0,-6.6]]                                  // gas → export / sales line
};
// v1.3.0 (§8.1): with V-101 out and the destination 'line', the separator bypass spool is routed to the export spool instead
// of the flare line: heater outlet → (PSHH-104) → along z −1.25 (clear of the gas rack arms, |z| ≤ 0.7) → down at x 17 (clear
// of the knock-out drum at x 17.95) → z −6.6 → joins the export spool run to the tie-in (NRV-501, XV-501) at x 22.4
var LINE_SPOOL = [[1.6,2.3,0],[1.6,2.3,-1.25],[1.6,3.6,-1.25],[17.0,3.6,-1.25],[17.0,1.0,-1.25],[17.0,1.0,-6.6],[22.4,1.0,-6.6]];
// tag points of the new pressure breaks (instrument + plate): PAH-102 between the chokes (on E3c1), PSHH-104 on the bypass
// spool (both destinations, V-101 out), NRV-501 / XV-501 at the production-line tie-in ('line' only)
var TAG_PTS = { pah102:[-3.9, 1.9, 0.2], pshh104:[3.2, 3.6, -1.25], nrv501:[20.3, 1.0, -6.6], xv501:[21.4, 1.0, -6.6] };
// the scene key: rebuild on the rig-up signature, and with V-101 out also on the destination (the bypass spool changes);
// with V-101 in the key is the v3.3.1 rigSig
function rigKeyOf(rig, dest) { return rigSigOf(rig) + (rig && rig.separator === false ? '|' + (dest === 'line' ? 'line' : 'flare') : ''); }
// rig-up groups the scene follows: the core groups are ghosted while out, the optional groups (appended) are not built while out
var RIG_GROUPS = ['heater', 'separator', 'surge', 'gauge', 'pump', 'flare', 'desander', 'surge2', 'heaterChoke'];   // 9 (rigSig 9 characters)

// Segment chip anchors (pipe midpoints): 6 main + LW + LO
var SEG_CHIPS = [
  { key:'s0', seg:0, at:[-13.1,1.2,0] }, { key:'s1', seg:1, at:[-9.9,1.2,0], atDs:[-8.95,1.2,0.7] }, { key:'s2', seg:2, at:[-4.65,1.2,0] },
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
var NULLABLE = ['esd.cause','esd.tripT','surge.tFull_s','surge.pump.trip','surge.transfer.trip','rates.gor_scf_stb','rates.bsw_pct','rates.tank_stbd',
  'rates.shrink_pct','alarms[*].value','alarms[*].limit','alarmLog[*].sev','gauge.batches[*].gor_scf_stb','gauge.batches[*].bsw_pct',
  'desander.dump.lastT','surge2.tFull_s','surge2.transfer.trip',
  'inputs.bean2','inputs.ck2Pos','cushion.tBreak',   // v1.5.0 (WTS_sim 1.5.0; SIM-FOLLOWUP §5.4, §6.3)
  'nodes.choke.beanFix'];   // CK-101 positive leg bean (null without flow.ck1)

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
    var hasCorner = false, rb = 0, dOut = null, th = Math.PI / 2, tq = 0, nIn = null;
    if (k < n - 1) {
      dOut = v3norm(v3sub(pts[k + 1], p));
      var legOut = v3len(v3sub(pts[k + 1], p)), cosT = v3dot(dIn, dOut);
      if (Math.abs(cosT) < 0.999 && legIn > 1e-6 && legOut > 1e-6) {
        hasCorner = true;
        if (Math.abs(cosT) < 1e-12) { rb = Math.min(rbMax, 0.45 * Math.min(legIn, legOut)); tq = rb; nIn = dOut; }     // 90° (every orthogonal route, as v1.4.0)
        else {                                                                              // v1.5.0: general-angle fillet (CK-101 45° unions)
          th = Math.acos(clamp(cosT, -1, 1)); var tanH = Math.tan(th / 2);
          rb = Math.min(rbMax, 0.45 * Math.min(legIn, legOut) / tanH); tq = rb * tanH; nIn = v3norm(v3sub(dOut, v3scale(dIn, cosT)));
        }
      }
    }
    var s = hasCorner ? v3sub(p, v3scale(dIn, tq)) : p.slice();
    var L = v3len(v3sub(s, cur));
    if (!nrm) nrm = anyPerp(dIn);
    if (L > 1e-6) { prims.push({ type:'L', a:cur.slice(), b:s.slice(), len:L, dir:dIn, n0:nrm.slice(), s0:len }); len += L; }
    if (hasCorner) {
      var c = v3add(s, v3scale(nIn, rb)), u = v3norm(v3sub(s, c)), axis = v3norm(v3cross(dIn, dOut));
      var al = th === Math.PI / 2 ? rb * Math.PI / 2 : rb * th;
      prims.push({ type:'A', c:c, u:u, v:dIn, R:rb, ang:th, len:al, n0:nrm.slice(), axis:axis, dIn:dIn, dOut:dOut, s0:len });
      len += al;
      nrm = rotAxis(nrm, axis, th);
      cur = v3add(p, v3scale(dOut, tq));
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
// camera target for a view preset and rig-up (orbit form {tgt, r, th, ph}); pure — the handle's viewTarget wraps it
function viewFor(name, rig, w, h, insets, flameTop) {
  var vw = VIEWS[name] || VIEWS.overview, f = fitView(viewBox(name, rig, flameTop), vw.az, vw.el, 36, w, h, insets);
  return { tgt:f.target, r:f.radius * (vw.margin || 1), th:vw.az * Math.PI / 180, ph:(90 - vw.el) * Math.PI / 180 };
}
// after a rig-up change the camera is refitted only when the user has not moved it (§8.1): null = stay where it is
function rigRefitView(userMoved, rig, w, h, insets, name) { return userMoved ? null : viewFor(name || 'overview', rig, w, h, insets); }

// ── ray picking / occlusion against proxy boxes (pure; the handle passes the rig-filtered tables) ──
function rayBox(o, d, c, s) {
  var t0 = -1e9, t1 = 1e9;
  for (var i = 0; i < 3; i++) {
    var mn = c[i] - s[i] / 2, mx = c[i] + s[i] / 2;
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn || o[i] > mx) return -1; continue; }
    var a = (mn - o[i]) / d[i], b = (mx - o[i]) / d[i]; if (a > b) { var tt = a; a = b; b = tt; }
    if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return -1;
  }
  return t1 < 0 ? -1 : Math.max(t0, 0);
}
// → 'mushroom' | valve proxy id | equipment id | null (empty pad) | undefined (sky)
function pickRay(o, d, proxies, valveProxies) {
  var best = 1e9, id, i;
  var tm = rayBox(o, d, MUSHROOM.c, MUSHROOM.s); if (tm >= 0) { best = tm; id = 'mushroom'; }
  for (i = 0; i < proxies.length; i++) { var t = rayBox(o, d, proxies[i][1], proxies[i][2]); if (t >= 0 && t < best) { best = t; id = proxies[i][0]; } }
  // operable valves win over the equipment proxies (small targets; the vessels are see-through glass)
  var bv = 1e9, vid = null;
  for (var j = 0; j < valveProxies.length; j++) { var tv = rayBox(o, d, valveProxies[j][1], valveProxies[j][2]); if (tv >= 0 && tv < bv) { bv = tv; vid = valveProxies[j][0]; } }
  if (vid && id !== 'mushroom') return vid;
  if (id) return id;
  if (d[1] < -1e-6) { var tg = (0.02 - o[1]) / d[1], gx = o[0] + d[0] * tg, gz = o[2] + d[2] * tg;
    if (gx >= PAD_RECT.x0 && gx <= PAD_RECT.x1 && gz >= PAD_RECT.z0 && gz <= PAD_RECT.z1) return null; }
  return undefined;
}
// is the label anchor of `selfId` hidden behind another proxy as seen from camPos?
function occludedFrom(camPos, anchor, selfId, proxies) {
  var dx = anchor[0] - camPos[0], dy = anchor[1] - camPos[1], dz = anchor[2] - camPos[2], L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1, d = [dx / L, dy / L, dz / L];
  for (var p = 0; p < proxies.length; p++) { if (proxies[p][0] === selfId) continue; var t = rayBox(camPos, d, proxies[p][1], proxies[p][2]); if (t >= 0 && t < L - 0.4) return true; }
  return false;
}

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
var LINE_NAMES = ['wh_esd','esd_choke','choke_heater','heater_sep','sep_flare','sep_water','sep_oil','surge_gauge','surge_vent','blanket','gauge_drain','gauge_vent','psv_sep','psv_surge',
  'sep_surge2','surge2_gauge','surge2_vent','blanket2','psv_surge2','ds_dump'];
var NODE_NAMES = ['wellhead','esd','choke','heater','separator','flare','surge','gauge','desander','surge2','heaterChoke'];
// per-node fallbacks when a snapshot lacks the node (positional with NODE_NAMES; desander = choke inlet, T-202 at ambient,
// CK-102 out = the choke outlet)
var SAMPLE_NODE_P = [3000, 2999.75, 157.66, 151.01, 150, 5, 25, 0, 2999.26, 25, 157.66];
var SAMPLE_NODE_T = [180, 180, 68.74, 150, 150, 150, 150, 150, 180, 80, 68.74];

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
            comps:[{ frac:0.55, fracW:0.15, inlet:true, suction:true, pos:1, moving:false }, { frac:0.55, fracW:0.15, inlet:true, suction:true, pos:1, moving:false }],
            suction:'both', blocked:false, autoOn:false, pumpBlocked:false, pumpTrip:'', xferLowDP:false },
    gauge:{ active:0, tanks:[{ frac:0.3, fracW:0.06, cap_bbl:100, state:'filling', Vo_bbl:0, Vw_bbl:0, Vo_stb:0, drain_bpd:0, fill_bpd:0, inlet:true, pos:1, moving:false },
                              { frac:0, fracW:0, cap_bbl:100, state:'ready', Vo_bbl:0, Vw_bbl:0, Vo_stb:0, drain_bpd:0, fill_bpd:0, inlet:false, pos:0, moving:false }],
            nb:0, lastOil:-1, lastRate:-1, lastBsw:-1, lastTag:'', autoOn:false, blocked:false,
            pumpOn:false, pumpFailed:false, pump_q:0, pump_design:1, pumpMode:'pump' },
    rig:{ heater:true, separator:true, surge:true, gauge:true, pump:true, flare:true, desander:false, surge2:false, heaterChoke:false }, rigSig:'111111000',
    rigKey:'111111000',
    // v1.3.0: CK-102 line-up (nodes.heaterChoke keeps the numbers), bypass destination (snapshot sepBy), cushion (snapshot cushion)
    ck2:{ inRig:false, active:false, bypassed:false, pos:'inlet', limiter:'', designP:1440, note:'' },
    sepBy:{ dest:'flare', P:150, P0:5, active:false, vent:false },
    cush:{ on:false, phase:'off', q:0, V:0, rec:0, tBreak:-1 },
    // DS-101 desander + sand (snapshot desander / sand, §6.4); static while DS-101 is out
    ds:{ inRig:false, bypass:false, Pin:2999.26, Pout:2999.26, dP:0, rate:'none', eff:0, d50c:0, accFrac:0, bufFrac:0, accLb:0, capLb:663,
         captLbd:0, inLbd:0, outLbd:0, phase:'idle', heldFrom:'', open:false, lastT:-1, count:0, leftS:0, Pacc:0, failed:false,
         autoOn:false, autoSp:0.8, autoBlocked:false, lah:0.8, lahh:0.95, ratingOK:true },
    sand:{ on:false, toChoke:0, band:'none', flowback:false, dumped:0, erosionMild:0 },
    // T-202 second surge tank (snapshot surge2); standby / empty while out
    surge2:{ inRig:false, P:25, SP:25, T:80, psh:32, pshh:40, frac:0, fracW:0, cap_bbl:100, Vo_bbl:0, Vw_bbl:0, tFull_s:-1, inlet:false, pos:0,
             moving:false, route:'surge', share:0, fill_bpd:0, xOn:false, xTripped:false, xFailed:false, xBlocked:false, xQ:0, xLowDP:false,
             psvLifting:false, bpvU:0, blkU:0, lsh:0.7, lshh:0.9 },
    rates:{ gas_mmscfd:0, oil_stbd:0, water_bpd:0, gor:-1, bsw:-1 },
    cum:{ flare_mmscf:0, oilIn_stb:0, gasIn_mmscf:0 },
    alarms:[], hasState:false
  };
  for (var i = 0; i < NODE_NAMES.length; i++) N.nodes[NODE_NAMES[i]] = nd();
  N.nodes.choke.leg = 'adj'; N.nodes.choke.beanAdj = 32; N.nodes.choke.beanFix = null;     // CK-101 manifold legs (v1.4.0)
  for (var s = 0; s < 6; s++) N.segs.push({ nps:'4', vel:0, ve:1, vPct:0, vSt:'OK', P0:0, Pout:0, T0:0, Tout:0, hydR:false, flowing:false, dP:0, label:'' });
  for (var l = 0; l < LINE_NAMES.length; l++) N.lines[LINE_NAMES[l]] = { q:0, vel:0, frac:0, active:false, tank:0 };
  return N;
}
var EMPTY_ARR = [];
function nb(v, d) { return v === true || v === false ? v : d; }
function nstr(v, d) { return typeof v === 'string' ? v : d; }
// rig-up signature over the groups the scene follows ('1' = in the rig-up; optional groups only when strictly true, D2)
function rigSigOf(rig) { return RIG_GROUPS.map(function (g) { return rigIn(rig, g) ? '1' : '0'; }).join(''); }
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
    var sampleP = SAMPLE_NODE_P[i], sampleT = SAMPLE_NODE_T[i];
    d.P = num(src.P, sampleP); d.T = num(src.T, sampleT); d.th = num(src.th, 40); d.hyd = !!src.hyd;
    d.Pin = num(src.Pin, k === 'choke' ? 2999.26 : d.P); d.Tin = num(src.Tin, k === 'heater' ? 68.74 : d.T);
    d.regime = nstr(src.regime, 'Critical'); d.bean = num(src.bean, ip.bean); d.flowLimited = !!src.flowLimited;
    d.QmaxMMscfd = num(src.QmaxMMscfd, 10.7); d.dTjt = num(src.dTjt, 0); d.bypass = nb(src.bypass, ip.bypass);
    d.dutyMMBtuHr = num(src.dutyMMBtuHr, 2.1); d.firing = clamp(num(src.firing, 1), 0, 1.5);
    d.qMMscfd = num(src.qMMscfd, ip.Qg); d.flame = num(src.flame, 1); d.Pline = num(src.Pline, 148.33);
  }
  // CK-101 manifold (v1.4.0): leg in service ('adj' adjustable | 'fixed' positive) and each leg's bean; an older snapshot without
  // the keys = the adjustable leg at the effective bean (no positive bean)
  var CKs = ND.choke || {}, ckN = N.nodes.choke;
  ckN.leg = CKs.leg === 'fixed' ? 'fixed' : 'adj';
  ckN.beanAdj = num(CKs.beanAdj, ckN.leg === 'adj' ? ckN.bean : ip.bean);
  ckN.beanFix = CKs.beanFix == null || !isFinite(+CKs.beanFix) ? (ckN.leg === 'fixed' ? ckN.bean : null) : +CKs.beanFix;
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
  // surge outlet transfer LCV-201 (surge.transfer; older snapshots: surge.pump — the pumped transfer of v3.0)
  if (SU.transfer) PU = SU.transfer;
  su.pumpOn = !!PU.on; su.pumpTripped = !!PU.tripped; su.pumpFailed = !!PU.failed; su.pump_q = num(PU.q_bpd, 0); su.pump_design = Math.max(num(PU.design_bpd, 1), 1);
  su.xferLowDP = !!PU.lowDP;
  su.lsll = num(SU.lsll, 0.05); su.lsl = num(SU.lsl, 0.25); su.lsh = num(SU.lsh, 0.7); su.lshh = num(SU.lshh, 0.9); su.psvLifting = !!(SU.psv && SU.psv.lifting);
  var CP = SU.comps || EMPTY_ARR;                // twin compartments A | B (older snapshots: both = the tank level)
  for (i = 0; i < 2; i++) {
    var cs = CP[i] || {}, dc = su.comps[i];
    dc.frac = clamp(num(cs.frac, su.frac), 0, 1); dc.fracW = clamp(num(cs.fracW, su.fracW), 0, 1); dc.inlet = nb(cs.inlet, true); dc.suction = nb(cs.suction, true);
    dc.pos = clamp(num(cs.pos, dc.inlet ? 1 : 0), 0, 1); dc.moving = !!cs.moving;           // divert valve travel (v3.0 snapshots)
  }
  su.suction = nstr(SU.suction, 'both'); su.blocked = !!SU.blocked; su.autoOn = !!(SU.auto && SU.auto.on); su.pumpBlocked = !!PU.blocked; su.pumpTrip = nstr(PU.trip, '');
  var GA = S.gauge || {}, ga = N.gauge, TK = GA.tanks || EMPTY_ARR;
  ga.active = num(GA.active, 0) ? 1 : 0;
  for (i = 0; i < 2; i++) {
    var ts = TK[i] || {}, dt = ga.tanks[i];
    dt.frac = clamp(num(ts.frac, i ? 0 : 0.3), 0, 1.05); dt.fracW = clamp(num(ts.fracW, i ? 0 : 0.06), 0, 1.05); dt.cap_bbl = Math.max(num(ts.cap_bbl, 100), 1);
    dt.state = nstr(ts.state, i ? 'ready' : 'filling'); dt.Vo_bbl = num(ts.Vo_bbl, dt.cap_bbl * (dt.frac - dt.fracW)); dt.Vw_bbl = num(ts.Vw_bbl, dt.cap_bbl * dt.fracW);
    dt.Vo_stb = num(ts.Vo_stb, dt.Vo_bbl); dt.drain_bpd = num(ts.drain_bpd, 0); dt.fill_bpd = num(ts.fill_bpd, 0); dt.inlet = nb(ts.inlet, i === ga.active);
    dt.pos = clamp(num(ts.pos, dt.inlet ? 1 : 0), 0, 1); dt.moving = !!ts.moving;
  }
  ga.autoOn = !!(GA.auto && GA.auto.on); ga.blocked = !!GA.blocked;
  var GP = GA.pump || {};                          // P-201 downstream of the gauge tank (v3.0.2 snapshots)
  ga.pumpOn = !!GP.on; ga.pumpFailed = !!GP.failed; ga.pump_q = num(GP.q_bpd, 0); ga.pump_design = Math.max(num(GP.design_bpd, 1), 1); ga.pumpMode = nstr(GP.mode, 'pump');
  var RU = S.rigup || {};
  for (i = 0; i < RIG_GROUPS.length; i++) N.rig[RIG_GROUPS[i]] = rigIn(RU, RIG_GROUPS[i]);   // older snapshots: optional items out
  N.rigSig = rigSigOf(N.rig);
  // bypass destination (§8.1): only the destination of a V-101-out line-up changes the scene key
  var SB = S.sepBy || {}, sb = N.sepBy;
  sb.dest = SB.dest === 'line' ? 'line' : 'flare'; sb.P = num(SB.P_psig, 150); sb.P0 = num(SB.P0_psig, sb.dest === 'line' ? sb.P : 5);
  sb.active = N.rig.separator === false; sb.vent = sb.active && sb.dest === 'line' && N.rig.flare === false;
  N.rigKey = rigKeyOf(N.rig, sb.dest);
  // CK-102: in the rig-up, in line (active), or greyed while bypassed with H-101 (heater bypass; with H-101 out the engine
  // takes CK-102 out of the rig-up, RIG_NOTES.heaterChokeNeedsHeater, so it is hidden — !N.rig.heater only guards odd snapshots)
  var HC = ND.heaterChoke || {}, c2 = N.ck2;
  c2.inRig = N.rig.heaterChoke; c2.bypassed = c2.inRig && (HC.bypassed === true || ip.bypass || !N.rig.heater);
  c2.active = c2.inRig && !c2.bypassed && HC.active !== false; c2.pos = HC.pos === 'midcoil' ? 'midcoil' : 'inlet';
  c2.limiter = nstr(HC.limiter, ''); c2.designP = num(HC.designP_psig, 1440); c2.note = nstr(HC.note, '');
  if (!c2.inRig || c2.bypassed) { var hn = N.nodes.heaterChoke; hn.hyd = false; hn.dTjt = 0; }
  // cushion unload (no geometry: the multiphase stream colour follows the unload, §8.1)
  var CU0 = S.cushion || {}, cs = N.cush;
  cs.on = CU0.on === true; cs.phase = nstr(CU0.phase, 'off'); cs.q = Math.max(0, num(CU0.q_bpd, 0)); cs.V = Math.max(0, num(CU0.V_bbl, 0));
  cs.rec = Math.max(0, num(CU0.recovered_bbl, 0)); cs.tBreak = CU0.tBreak == null ? -1 : num(CU0.tBreak, -1);
  // DS-101 + sand (§6.4)
  var DS = S.desander || {}, DSS = DS.sand || {}, DSD = DS.dump || {}, DSA = DS.auto || {}, ds = N.ds;
  ds.inRig = N.rig.desander; ds.bypass = !!DS.bypass;
  ds.Pin = num(DS.Pin, N.nodes.desander.Pin); ds.Pout = num(DS.Pout, N.nodes.desander.P); ds.dP = Math.max(0, num(DS.dP_psi, 0));
  ds.rate = nstr(DS.rate, 'none'); ds.eff = clamp(num(DS.eff, 0), 0, 1); ds.d50c = num(DS.d50c_um, 0); ds.ratingOK = DS.ratingOK !== false;
  ds.accFrac = clamp(num(DSS.acc_frac, 0), 0, 1); ds.bufFrac = clamp(num(DSS.buf_frac, 0), 0, 1); ds.accLb = Math.max(0, num(DSS.acc_lb, 0));
  ds.capLb = Math.max(num(DSS.cap_lb, 663), 1); ds.captLbd = Math.max(0, num(DSS.capt_lbd, 0)); ds.inLbd = Math.max(0, num(DSS.in_lbd, 0));
  ds.outLbd = Math.max(0, num(DSS.out_lbd, 0)); ds.lah = num(DSS.lah, 0.8); ds.lahh = num(DSS.lahh, 0.95);
  ds.phase = nstr(DSD.phase, 'idle'); ds.heldFrom = nstr(DSD.heldFrom, ''); ds.open = !!DSD.open; ds.lastT = DSD.lastT == null ? -1 : num(DSD.lastT, -1);
  ds.count = Math.max(0, num(DSD.count, 0)); ds.leftS = Math.max(0, num(DSD.left_s, 0)); ds.Pacc = num(DSD.Pacc, 0); ds.failed = !!DSD.failed;
  ds.autoOn = !!DSA.on; ds.autoSp = num(DSA.sp, 0.8); ds.autoBlocked = !!DSA.blocked;
  var SD = S.sand || {}, SDC = SD.choke || {}, SDU = SD.cum || {}, sd = N.sand;
  sd.on = !!SD.on; sd.toChoke = Math.max(0, num(SD.toChoke_lbd, 0)); sd.band = nstr(SDC.band, 'none'); sd.flowback = !!(SD.flowback && SD.flowback.on);
  sd.dumped = Math.max(0, num(SDU.dumped_lb, 0)); sd.erosionMild = Math.max(0, num(SDC.erosion_mild, 0));
  // T-202 (§6.4)
  var U2 = S.surge2 || {}, UX = U2.transfer || {}, u2 = N.surge2;
  u2.inRig = N.rig.surge2; u2.P = num(U2.P, N.nodes.surge2.P); u2.SP = num(U2.SP, su.SP); u2.T = num(U2.T, N.nodes.surge2.T);
  u2.psh = num(U2.psh, su.psh); u2.pshh = Math.max(num(U2.pshh, su.pshh), 1); u2.frac = clamp(num(U2.frac, 0), 0, 1); u2.fracW = clamp(num(U2.fracW, 0), 0, 1);
  u2.cap_bbl = Math.max(num(U2.cap_bbl, 100), 1); u2.Vo_bbl = Math.max(0, num(U2.Vo_bbl, 0)); u2.Vw_bbl = Math.max(0, num(U2.Vw_bbl, 0));
  u2.tFull_s = U2.tFull_s == null ? -1 : num(U2.tFull_s, -1); u2.inlet = !!U2.inlet; u2.pos = clamp(num(U2.pos, u2.inlet ? 1 : 0), 0, 1); u2.moving = !!U2.moving;
  u2.route = nstr(U2.route, 'surge'); u2.share = clamp(num(U2.share, 0), 0, 1); u2.fill_bpd = Math.max(0, num(U2.fill_bpd, 0));
  u2.xOn = !!UX.on; u2.xTripped = !!UX.tripped; u2.xFailed = !!UX.failed; u2.xBlocked = !!UX.blocked; u2.xQ = Math.max(0, num(UX.q_bpd, 0)); u2.xLowDP = !!UX.lowDP;
  u2.psvLifting = !!(U2.psv && U2.psv.lifting); u2.bpvU = clamp(num(U2.bpv && U2.bpv.u, 0), 0, 1); u2.blkU = clamp(num(U2.blanket && U2.blanket.u, 0), 0, 1);
  u2.lsh = num(U2.lsh, 0.7); u2.lshh = num(U2.lshh, 0.9);
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
// ── v1.3.0 pure view rules (Node-testable; the frame loop reads them) ──
// CK-102 look per frame: grey 1 while bypassed with H-101 (heater bypass; the engine takes CK-102 out with H-101), frost 1 while in line with its outlet in
// the hydrate region, handwheel target bean2/64 × 6π (as CK-101); null while CK-102 is out of the rig-up (nothing is built)
function ck2Look(n) {
  if (!n || !n.ck2 || !n.ck2.inRig) return null;
  var hn = n.nodes.heaterChoke;
  return { grey:n.ck2.bypassed ? 1 : 0, frost:n.ck2.active && hn.hyd ? 1 : 0, wheel:clamp(num(hn.bean, 0), 0, 128) / 64 * 6 * Math.PI };
}
// well-stream rates for the multiphase display colour: the inputs, or while a cushion unloads the cushion water plus the gas
// (formation oil / water join at breakthrough) — the cushion has no geometry, only the stream colour follows it (§8.1).
// While unloading every term is an actual rate (inputs × flow fraction f, cushion water as reported): the gas is the well-stream
// gas, never the flare meter (that is 0 with V-101 out to the production line)
function streamRates(n, out) {
  out = out || { g:0, o:0, w:0 };
  var c = n.cush, cq = c && c.on && c.q > 0, br = cq && c.tBreak >= 0, f = Math.max(0, num(n.f, 1));
  out.g = cq ? n.inp.Qg * f : n.inp.Qg;
  out.o = cq ? (br ? n.inp.Qo * f : 0) : n.inp.Qo;
  out.w = cq ? (br ? n.inp.Qw * f : 0) + c.q : n.inp.Qw;
  return out;
}
// flare gas the 3D shows (flame length, FS-401 chip): 0 while V-101 is out to the production line — the whole well stream goes
// to the line and nothing reaches the flare (§8.1 'the flame stays off'), the engine's flare node otherwise
function flareQ(n) {
  return n.sepBy && n.sepBy.active && n.sepBy.dest === 'line' ? 0 : Math.max(0, num(n.nodes.flare.qMMscfd, 0));
}
// snap.cushion for fakeSnapshot: off (all zeros, phase 'off'), or a phase with illustrative numbers (D7 defaults)
var CUSH_PHASES = ['off', 'unloading', 'stalled', 'breakthrough', 'tail', 'done'];
function fakeCushion(ph, to) {
  var c = { on:false, phase:'off', V_bbl:0, SG:0, q_set_bpd:0, q_bpd:0, qcap_bpd:0, WHPtgt_psig:0, column_ft:0, Vleft_bbl:0, recovered_bbl:0,
            fUnload:0, wJT:0, dutyCapped:false, tBreak:null, out:{ flare:0, line:0, sep:0 } };
  if (typeof ph !== 'string' || CUSH_PHASES.indexOf(ph) <= 0) return c;
  var frac = { unloading:0.3, stalled:0.1, breakthrough:0.86, tail:0.95, done:1 }[ph];
  c.on = ph !== 'done'; c.phase = ph; c.V_bbl = 50; c.SG = 1.03; c.q_set_bpd = 1500; c.q_bpd = ph === 'stalled' ? 0 : ph === 'unloading' ? 1500 : 300;
  c.qcap_bpd = 8433; c.WHPtgt_psig = ph === 'stalled' ? 200 : 1702.6; c.column_ft = frac > 0.85 ? 0 : 4885.1 * (1 - frac); c.recovered_bbl = 50 * frac;
  c.Vleft_bbl = 50 - c.recovered_bbl; c.fUnload = 0.1825; c.wJT = 0.025; c.tBreak = frac > 0.85 ? 2468 : null; c.out[to] = c.recovered_bbl;
  return c;
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
  // v1.3.0 options: o.heaterChoke (CK-102 in the rig-up; bypassed while o.bypass), o.pos ('inlet' | 'midcoil'), o.sepOut (V-101 out),
  // o.dest ('flare' | 'line'), o.P (line pressure, psig), o.flareOut (FS-401 out, 'line' only), o.cushion (a cushion phase)
  var ck2In = o.heaterChoke === true, ck2Act = ck2In && !bypass, ck2Pos = o.pos === 'midcoil' ? 'midcoil' : 'inlet';
  var sepOut = o.sepOut === true, dest = o.dest === 'line' ? 'line' : 'flare', lineP = num(o.P, 150), flareOut = sepOut && dest === 'line' && o.flareOut === true;
  var Pco = Psep + (157.66 - 150) * fi * fi, Pci = f > 0.01 ? Pwh - (3000 - 2999.26) * fi * fi : Psep;
  var Pck2o = Psep + (156.01 - 150) * fi * fi, Pm = Psep + (1135.12 - 150) * fi * fi;                // CK-102 at 48/64 (ANCHORS_CK2): CK-101 discharges at Pm + seg-3 loss
  if (ck2Act) Pco = Pm + 0.25 * fi * fi;
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
  // optional items (o.desander / o.surge2 / o.flushing): DS-101 upstream of the choke (ESD node = choke inlet + ΔP), T-202 on route 'both'
  // o.held: the dump sequence held by an ESD (XV-103 shut, phase 'held', heldFrom 'flush'); o.flushing: XV-103 open in 'flush'
  var dsIn = o.desander === true, u2In = o.surge2 === true, dsHeld = dsIn && o.held === true, dsFlush = dsIn && o.flushing === true && !dsHeld;
  var dsDump = dsFlush || dsHeld;
  var dsDP = dsIn && f > 0.01 ? 3.93 * fi * fi : 0, dsPin = Pci + dsDP, dsAcc = dsIn ? (dsDump ? 0.3 : clamp(((t % 14400) + 14400) % 14400 / 14400 * 0.85, 0, 1)) : 0;
  var u2Cyc = saw(t + 200, 1800, 0.66), u2Frac = u2In ? 0.2 + 0.5 * u2Cyc.v : 0, u2Fill = u2In && f > 0.01 ? (qOil + qWat) / 2 : 0, u2X = u2In && !u2Cyc.up && f > 0.01 ? 3752 : 0;
  var segs = SAMPLE_SEGS.map(function (s, i) {
    var c = JSON.parse(JSON.stringify(s)); var k = i < 4 ? fi : i === 4 ? f : 1;
    c.vel = i === 5 ? vPump : s.vel * k; c.vPct = c.vel / c.ve * 100; c.vSt = c.vPct > 100 ? 'EXCEED' : c.vPct > 80 ? 'WARNING' : 'OK';
    c.dP = s.dP * k * k; c.flowing = c.vel > 0.01;
    if (i === 0) { c.P0 = Pwh; c.Pout = Pwh - c.dP; } if (i === 1) { c.P0 = dsIn ? dsPin : Pwh - SAMPLE_SEGS[0].dP; c.Pout = Pci; }
    if (i === 2) { c.P0 = Pco; c.Pout = Pco - c.dP; } if (i === 3) { c.P0 = Psep + 1.01 * fi; c.Pout = Psep; }
    if (i === 2 && ck2Act) { c.dP = 0.25 * fi * fi; c.Pout = Pm; c.T0 = c.Tout = 107.02; }
    if (i === 4) { c.P0 = Psep; c.Pout = Psep - c.dP; }
    if (i === 2 && bypass) { c.T0 = 58; c.Tout = 58; c.hydR = true; }
    c.nps = o.nps && o.nps[i] ? String(o.nps[i]) : s.nps;
    return c;
  });
  var line = function (q, unit, frac, vel, ID, phase, active, tank) { var L = { q:q, unit:unit, frac:frac, vel:vel, ID_in:ID, phase:phase, active:active }; if (tank != null) L.tank = tank; return L; };
  var Qg = 10 * f, gasFlare = sepOut && dest === 'line' ? 0 : 10 * f * (1 + 0.01 * nz(5, 11));
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
    inputs:{ Pwh:3000, Twh:bypass ? 120 : 180, Qg:10, Qo:1000, Qw:200, SGg:0.65, API:API, bean:bean, Cd:0.85, bypass:bypass, Psep:150, Thtr:150,
      bean2:ck2In ? 48 : null, ck2Pos:ck2In ? ck2Pos : null },
    fluid:{ API:API, SGo:141.5 / (API + 131.5), SGg:0.65 },
    esd:{ tag:'SDV-101', travel:travel, open:travel > 0.999, moving:travel > 0.001 && travel < 0.999, tripped:esdMode !== 'open', manual:esdMode === 'manual',
          cause:cause, causeMsg:causeMsg, tripT:tripT, canReset:esdMode === 'manual', blocking:[] },
    nodes:{
      wellhead:{ tag:'WH-101', P:Pwh, T:180, th:75.14, hyd:false },
      esd:{ tag:'SDV-101', P:dsIn ? dsPin : (f > 0.01 ? Pwh - 0.25 * fi * fi : Pwh * 0.5 + Psep * 0.5), T:180, th:75.14, hyd:false },
      choke:{ tag:'CK-101', P:Pco, Pin:Pci, T:bypass ? 58 : (ck2Act ? 107.02 : 68.74), th:36.59, hyd:bypass, regime:f < 0.01 ? 'No Flow' : 'Critical', bean:bean, flowLimited:false, QmaxMMscfd:10.71, dTjt:f < 0.01 ? 0 : (ck2Act ? 72.98 : 111.3) },
      heater:{ tag:'H-101', P:Psep + 1.01 * fi * fi, T:bypass ? 58 : 150, Tin:bypass ? 58 : (ck2Act ? (ck2Pos === 'midcoil' ? 107.02 : 68.68) : 68.74), th:36.06, hyd:bypass, bypass:bypass, dutyMMBtuHr:bypass ? 0 : 2.103 * f, firing:bypass ? 0 : clamp(f, 0, 1) },
      separator:{ tag:'V-101', P:Psep, T:bypass ? 60 : 149.997, th:35.98, hyd:false },
      flare:{ tag:'FS-401', P:5, Pline:Psep - 1.674 * f * f, T:149.99, qMMscfd:gasFlare, flame:clamp(Math.sqrt(gasFlare / 10), 0, 1.5) },
      surge:{ tag:'T-201', P:25 + 0.8 * nz(19, 43), T:149.997 },
      gauge:{ tag:'T-301', P:0, T:120 },
      desander:{ tag:'DS-101', P:Pci, Pin:dsPin, dP:dsDP, T:180, Tout:dsIn ? 179.9 : 180, Tacc:80, th:75.14, hyd:false },
      surge2:{ P:u2In ? 25 + 0.6 * nz(23, 47) : 25, T:u2In ? 140 : 80 },
      // CK-102 (WTS_sim 1.5.0 nodes.heaterChoke; always present, static choke-outlet values while out or bypassed)
      heaterChoke:ck2Act ? { tag:'CK-102', inRig:true, active:true, bypassed:false, P:Pck2o, Pin:Pm, T:ck2Pos === 'midcoil' ? 86.66 : 68.68, Tin:ck2Pos === 'midcoil' ? 125.0 : 107.02,
          th:36.5, hyd:false, dTjt:38.34, regime:f < 0.01 ? 'No Flow' : 'Critical', bean:48, pos:ck2Pos, flowLimited:false, limiter:'CK-101', QmaxMMscfd:10.71,
          designP_psig:1440, note:'' }
        : { tag:'CK-102', inRig:ck2In, active:false, bypassed:ck2In, P:Pco, Pin:Pco, T:bypass ? 58 : 68.74, Tin:bypass ? 58 : 68.74, th:36.6, hyd:false, dTjt:0, regime:'',
          bean:ck2In ? 48 : 0, pos:ck2Pos, flowLimited:false, limiter:'', QmaxMMscfd:0, designP_psig:1440, note:'' }
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
      psv_surge:line(0, 'MMSCFD', 0, 0, 1.049, 'gas', false),
      sep_surge2:line(u2Fill, 'BPD', u2Fill ? 1 : 0, vLiq(u2Fill), 3.068, 'liquid', u2Fill > 0),
      surge2_gauge:line(u2X, 'BPD', u2X ? 1 : 0, vLiq(u2X), 3.068, 'liquid', u2X > 0),
      surge2_vent:line(u2In ? 0.006 * f : 0, 'MMSCFD', u2In ? f : 0, u2In ? 1.3 * f : 0, 2.067, 'gas', u2In && f > 0.01),
      blanket2:line(0, 'MMSCFD', 0, 0, 1.049, 'gas', false),
      psv_surge2:line(0, 'MMSCFD', 0, 0, 1.049, 'gas', false),
      ds_dump:line(dsFlush ? 420 * 86400 / 600 : 0, 'LB/D', dsFlush ? 1 : 0, dsFlush ? 1.2 : 0, 2.067, 'sand', dsFlush)
    },
    desander:{ tag:'DS-101', inRig:dsIn, bypass:false, bypassTag:'HV-104', Pin:dsPin, Pout:Pci, dP_psi:dsDP, dPclean_psi:dsDP, dPexp_psi:dsDP, dPdesign_psi:dsDP,
      T:180, Tout:dsIn ? 179.9 : 180, vIn_fts:dsIn ? 20.7 * fi : 0, rate:dsIn ? (f > 0.01 ? 'ok' : 'none') : 'none', gvf:dsIn ? 0.89 : 0, rhoMix:dsIn ? 14.17 : 0,
      carrier:'liquid', mu_cp:dsIn ? 1.88 : 0, d50c_um:dsIn ? 39.8 : 0, eff:dsIn ? 0.946 : 0, effClean:dsIn ? 0.946 : 0,
      sand:{ in_lbd:dsIn ? 12 * f : 0, capt_lbd:dsIn ? 11.35 * f : 0, out_lbd:dsIn ? 0.646 * f : 0, acc_lb:dsAcc * 663, acc_frac:dsAcc, cap_lb:663,
        buf_lb:0, buf_frac:0, bufCap_lb:265, lah:0.8, lahh:0.95 },
      dump:{ tag:'XV-103', phase:dsHeld ? 'held' : dsFlush ? 'flush' : 'idle', heldFrom:dsHeld ? 'flush' : '', phaseT_s:dsDump ? 120 : 0, left_s:dsFlush ? 608 : 0, open:dsFlush,
        Pacc:dsIn ? (dsDump ? 30 : Pci) : 0,
        count:dsIn ? Math.floor(t / 14400) : 0, lastT:dsIn && t > 14400 ? 14400 * Math.floor(t / 14400) : null, failed:false, failMsg:'' },
      auto:{ on:false, sp:0.8, blocked:false }, rating_psi:10000, sithp_psi:3600, sithpEst:true, ratingOK:true, tempMax_F:350, tempOK:true },
    sand:{ on:dsIn, pptb:dsIn ? 10 : 0, lbPerMMscf:0, d50_um:150, sigmaG:2, in_lbd:dsIn ? 12 * f : 0, toChoke_lbd:dsIn ? 0.646 * f : 0,
      flowback:{ on:false, W0_lbph:200, tau_h:6, t_h:0, d50_um:400, sigmaG:1.5 },
      choke:{ Up_fts:888, C2:dsIn ? 0.11 : 0, erosion_mpy:dsIn ? 23.6 : 0, erosion_mild:dsIn ? 0.065 : 0, band:dsIn ? 'ok' : 'none', warn_mild:2.08, high_mild:20.8, loss_mil:0 },
      sep:{ lb:0, ft3:0, frac:0 },
      cum:{ in_lb:dsIn ? t * 12 / 86400 : 0, capt_lb:dsIn ? t * 11.35 / 86400 : 0, toChoke_lb:dsIn ? t * 0.646 / 86400 : 0, toSep_lb:dsIn ? t * 0.646 / 86400 : 0,
        toFlare_lb:0, dumped_lb:dsIn ? 663 * 0.8 * Math.floor(t / 14400) : 0 } },
    surge2:{ tag:'T-202', inRig:u2In, P:u2In ? 25 + 0.6 * nz(23, 47) : 25, SP:25, SPeff:25, T:u2In ? 140 : 80, psh:32, pshh:40, mawp:50, cap_bbl:100, D:6, H:19.8575,
      h:u2Frac * 19.8575, frac:u2Frac, hW:u2Frac * 0.17 * 19.8575, fracW:u2Frac * 0.17, Vo_bbl:u2Frac * 83, Vo_stb:u2Frac * 79, Vw_bbl:u2Frac * 17,
      flash_mscfd:u2In ? 6 * f : 0, tFull_s:u2Fill > 0 ? 1800 * (1 - u2Frac) : null, valveTag:'XV-202', inlet:u2In, pos:u2In ? 1 : 0, moving:false,
      fill_bpd:u2Fill, route:u2In ? 'both' : 'surge', share:u2In ? 0.5 : 0, Ph:25, auto:{ on:false, sp:0.8, hyst:0.1 }, strokeS:6,
      bpv:{ tag:'PCV-203', u:u2In ? 0.4 : 0 }, blanket:{ tag:'PCV-204', u:0, held:false }, psv:{ tag:'PSV-202', lifting:false, Cv:0.5 },
      transfer:{ tag:'LCV-202', on:u2X > 0, tripped:false, failed:false, blocked:false, q_bpd:u2X, design_bpd:3752, x:u2X > 0 ? 1 : 0, dP_psi:u2X > 0 ? 24.5 : 0,
        dPdesign_psi:24.5, Cv:20.65, sg:0.873, lowDP:false, dest:'gauge', trip:null, canReset:false, resetBlock:'' },
      lsll:0.05, lsl:0.25, lsh:0.7, lshh:0.9 },
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
      pump:{ tag:'LCV-201', on:pumpOn, tripped:false, failed:false, blocked:false, q_bpd:qPump, design_bpd:3753, suction:'both', lowDP:false }, lsll:0.05, lsl:0.25, lsh:0.7, lshh:0.9,
      comps:[0, 1].map(function (i) { return { tag:i ? 'T-201B' : 'T-201A', valveTag:i ? 'XV-201B' : 'XV-201A', cap_bbl:50, h:surgeFrac * 19.86, frac:surgeFrac,
        hW:surgeFrac * 0.17 * 19.86, fracW:surgeFrac * 0.17, Vo_bbl:surgeFrac * 41.5, Vo_stb:surgeFrac * 39.5, Vw_bbl:surgeFrac * 8.5, inlet:true, suction:true,
        fill_bpd:(qOil + qWat) / 2, draw_bpd:qPump / 2 }; }),
      suction:'both', blocked:false, auto:{ on:false, sp:0.8, hyst:0.1 } },
    rigup:{ esd:true, choke:true, heater:true, separator:!sepOut, surge:true, gauge:true, pump:true, flare:!flareOut, desander:dsIn, surge2:u2In, heaterChoke:ck2In,
      full:!sepOut && !flareOut, sig:'111' + (sepOut ? '0' : '1') + '111' + (flareOut ? '0' : '1') + (dsIn ? '1' : '0') + (u2In ? '1' : '0') + (ck2In ? '1' : '0'), notes:[],
      extras:[].concat(dsIn ? ['desander'] : [], u2In ? ['surge2'] : [], ck2In ? ['heaterChoke'] : []), refused:'', v:1 },
    // bypass destination (WTS_sim 1.5.0 snap.sepBy) and the cushion-unload scenario (snap.cushion; off unless o.cushion)
    sepBy:{ dest:dest, P_psig:lineP, P0_psig:dest === 'line' ? lineP : 5, active:sepOut, vent:flareOut, note:'' },
    cushion:fakeCushion(o.cushion, sepOut ? (dest === 'line' ? 'line' : 'flare') : 'sep'),
    gauge:{ tag:'T-301', active:active, count:2, tanks:[tank(0), tank(1)], blocked:false, auto:{ on:false, sp:0.9, hyst:0.1 },
      pump:{ tag:'P-201', inRig:true, mode:'pump', on:drainQ > 0, failed:false, q_bpd:drainQ, design_bpd:3000, dest:'export' },
      batches:t > cyc ? [{ n:1, tag:'T-301A', tOpen:0, tClose:cyc * 0.9, hours:1.8, openOil_stb:20, closeOil_stb:90, oil_stb:70.8, water_bbl:17.6,
        gov_bbl:88.4, bsw_pct:19.9, oilRate_stbd:944, waterRate_bpd:235, gas_mscf:750, gor_scf_stb:10593, avgT:122 }] : [] },
    cum:{ oilIn_stb:t * 1000 / 86400, waterIn_bbl:t * 200 / 86400, gasIn_mmscf:t * 10 / 86400, flare_mmscf:t * 10 / 86400, flash_mscf:t * 18 / 86400,
      gaugeFlash_mscf:t * 4 / 86400, gaugeVent_mscf:t * 4 / 86400, vacBreak_scf:0, gaugeOil_stb:t * 950 / 86400, gaugeWater_bbl:t * 200 / 86400,
      drainedOil_stb:0, drainedWater_bbl:0, liquidToFlareOil_stb:0, liquidToFlareWater_bbl:0, spillOil_stb:0, spillWater_bbl:0,
      toLine_gas_mscf:sepOut && dest === 'line' ? t * 10000 / 86400 : 0, toLine_oil_stb:sepOut && dest === 'line' ? t * 1000 / 86400 : 0,
      toLine_water_bbl:sepOut && dest === 'line' ? t * 200 / 86400 : 0, toVent_gas_mscf:0 },
    rates:{ gas_mmscfd:gasFlare, oil_stbd:1000 * f, water_bpd:200 * f, oilMeter_stbd:1000 * f, waterMeter_bpd:200 * f,
      gor_scf_stb:f > 0.01 ? 10000 : null, bsw_pct:f > 0.01 ? 16.7 : null, tank_stbd:t > cyc ? 944 : null, shrink_pct:t > 600 ? 1.8 : null },
    alarms:alarms,
    alarmLog:[{ t:0, id:'RESET', type:'reset', sev:null, tag:'', msg:'Reset to steady' }],
    faults:{ pcvStuckClosed:false, pcvStuckOpen:false, oilDumpStuckOpen:false, oilDumpStuckClosed:false, waterDumpStuckClosed:false, surgePumpFail:false, slugging:false, xferStuckClosed:false,
      desanderPlugged:false, desanderWashout:false, desanderDumpStuck:false, desanderIsoPassing:false, desanderBypassPassing:false, sandFlowback:false,
      xfer2StuckClosed:false, bpv2StuckClosed:false },
    health:{ substeps:1, lagging:false, droppedSimSec:0, massErr:{ oil:0, water:0, gas:0, sand:0 }, flowInvalid:false }
  };
  st.surge.transfer = st.surge.pump;          // v3.0.2: the surge outlet transfer LCV-201 (surge.pump = legacy key, same object)
  // v1.4.0: CK-101 legs only when asked (o.leg 'adj' | 'fixed'; o.beanFix): without them the snapshot is the v1.3.0 shape
  if (o.leg) { var ckF = o.leg === 'fixed', bF = num(o.beanFix, 24); st.nodes.choke.leg = ckF ? 'fixed' : 'adj'; st.nodes.choke.beanAdj = ckF ? 32 : bean;
    st.nodes.choke.beanFix = ckF ? bean : bF; }
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
// ── Native iOS shell (Capacitor, capacitor://localhost) ──────────────────
// WKWebView serves the bundled www/ through a custom-scheme handler. Module imports of a
// capacitor:// URL are the path Capacitor apps use for every ES-module bundle, whereas importing
// a blob: URL minted on a custom-scheme origin is not something WebKit documents or Capacitor
// tests, so inside the shell the bundled three.js is imported directly by its absolute URL.
// The pinned SHA-384 is still checked first when WebCrypto exists (it catches a three.js bump
// that was not re-bundled); without WebCrypto only the LOCAL file (part of the code-signed app
// bundle) is accepted unverified — CDN bytes are never imported unverified. The web version never
// takes this branch (it keeps fetch → SHA-384 → IndexedDB → blob import).
function _isNativeShell() {
  try {
    if (G.location && G.location.protocol === 'capacitor:') return true;
    var C = G.Capacitor;
    return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
  } catch (e) { return false; }
}
function _absUrl(u) { try { return new URL(u, G.location && G.location.href).href; } catch (e) { return u; } }
// Pure decision table (exported for tests / Web Inspector diagnostics).
function loaderPolicy(env) {
  env = env || {};
  var subtle = !!env.subtle, canBlob = !!env.canBlob, pinned = !!env.pinned;
  if (env.native && env.localUrl) {
    return { route:'native-direct', idbCache:false,
             local:{ url:env.localUrl, importBy:'url', hash:(pinned && subtle && env.canFetch) ? 'verify' : 'skip' },
             cdn:(pinned && subtle && canBlob) ? 'blob-verified' : 'none' };
  }
  // Web: describes the unchanged fetch → SHA-384 → IndexedDB → blob-import path below.
  return { route:'web', idbCache:canBlob,
           local:env.localUrl ? { url:env.localUrl, importBy:canBlob ? 'blob' : 'url', hash:(pinned && canBlob) ? (subtle ? 'verify' : 'skip') : 'none' } : null,
           cdn:canBlob ? (pinned && subtle ? 'blob-verified' : 'blob') : 'url' };
}
function _policyEnv() {
  return { native:_isNativeShell(), localUrl:G.WTS3D_LOCAL_URL ? _absUrl(G.WTS3D_LOCAL_URL) : null,
           subtle:!!(G.crypto && G.crypto.subtle), pinned:!!WTS_3d.THREE_SHA384, canFetch:typeof fetch === 'function',
           canBlob:typeof fetch === 'function' && !!G.Blob && !!G.URL && typeof URL.createObjectURL === 'function',
           secure:G.isSecureContext !== false };
}
var _loadInfo = null;      // last loader outcome (route, url, hash) — WTS_3d.loadInfo() in Web Inspector
async function _loadNative(pol, n) {
  var last = null, badHash = false, L = pol.local, hash = L.hash;
  if (hash === 'verify') {
    try { var lb = await _fetchBytes(L.url); if (!(await _verify(lb))) { badHash = true; hash = 'mismatch'; } else hash = 'verified'; }
    catch (e) { hash = 'unreadable'; }          // fetch refused by the scheme handler: the signed bundle is imported anyway
  }
  if (!badHash) {
    try { var m = await _withTimeout(_dynImport(n > 1 ? L.url + (L.url.indexOf('?') < 0 ? '?r=' : '&r=') + n : L.url), 8000);
          if (_ok(m)) { _loadInfo = { route:'native-direct', url:L.url, hash:hash }; return m; } }
    catch (e) { if (e && e.code === 'csp') throw e; last = e; }
  }
  if (pol.cdn === 'blob-verified') {
    for (var i = 0; i < WTS_3d.THREE_URLS.length; i++) {
      try { var buf = await _fetchBytes(WTS_3d.THREE_URLS[i]);
            if (!(await _verify(buf))) { badHash = true; continue; }
            var mc = await _importBytes(buf);
            if (_ok(mc)) { _loadInfo = { route:'native-cdn-blob', url:WTS_3d.THREE_URLS[i], hash:'verified' }; return mc; } }
      catch (e) { if (e && e.code === 'csp') throw e; last = e; } }
  }
  _loadInfo = { route:'native-failed', url:L.url, hash:hash, error:String(last && last.message || last || '') };
  var err = new Error(badHash ? 'three-integrity-failed' : 'three-load-failed');
  err.code = badHash ? 'integrity' : 'offline'; err.cause = last; throw err;
}
function loadThree() {
  if (G.__WTS3D_THREE) return G.__WTS3D_THREE;
  var n = ++_attempt;
  var pol = loaderPolicy(_policyEnv());
  if (pol.route === 'native-direct') {
    var pn = _visibleBudget(_loadNative(pol, n), 20000, 'offline');
    G.__WTS3D_THREE = pn; pn.catch(function () { if (G.__WTS3D_THREE === pn) G.__WTS3D_THREE = null; });
    return pn;
  }
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
      if (seg) pre += '\nvarying float wSeg; varying float wS; varying vec3 wWP; uniform vec3 uSegCol[' + SEG_SLOTS + ']; uniform vec3 uSegColOld[' + SEG_SLOTS + ']; uniform float uSegAlert[' + SEG_SLOTS + ']; uniform float uSegFrost[' + SEG_SLOTS + ']; uniform float uSegPh[' + SEG_SLOTS + ']; uniform float uPulse; uniform float uChev; uniform float uWaveS;' +
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
// tracer chains; weights use built edges only (an optional item's edges count only while it is in). DR keeps the
// remainder of the allocation (tr.chainEntry[7] is DR); the v1.2.0 chains are appended after it.
var CHAIN_DEF = [
  { id:'MULTI', entry:'E1', phase:'multi', edges:['E1','D0a','D1','D2','D0b','E2','E2a','E3','E3o','E3c','E3c1','E3c2','E4a','E4'] },
  { id:'G1', entry:'G1', phase:'gas', edges:['G1'] },
  { id:'VENT', entry:'VENT', phase:'gas', edges:['VENT'] },
  { id:'BLK', entry:'BLK', phase:'gas', edges:['BLK'] },
  { id:'LW', entry:'LW', phase:'water', edges:['LW','LMa','LMb'] },
  { id:'LO', entry:'LO', phase:'oil', edges:['LO','LMa','LMb'] },
  { id:'X', entry:'X1', phase:'liquid', edges:['X1','X2','XA'] },
  { id:'DR', entry:'DRA', phase:'liquid', edges:['DRA'] },
  { id:'SAND', entry:'DD', phase:'sand', edges:['DD'] },
  { id:'X0', entry:'X0', phase:'liquid', edges:['X0'] },
  { id:'VENT2', entry:'VENT2', phase:'gas', edges:['VENT2'] },
  { id:'BLK2', entry:'BLK2', phase:'gas', edges:['BLK2'] },
  { id:'PSV2', entry:'PSV2', phase:'gas', edges:['PSV2'] }
];

function buildScene(F, renderer, tier, env, rig, dest) {
  var THREE = F.THREE, T = TIERS[tier], V3 = THREE.Vector3, C = F.C;
  var scene = new THREE.Scene();
  var S = { tier:tier, T:T, scene:scene, textures:[], vessels:[], dyn:{}, proxies:null, lights:{}, disposeExtra:[] };
  // rig-up: core equipment groups out of the spread are built as ghosts (merged translucent geometry, glass shell kept);
  // optional groups (DS-101, T-202) are simply not built while out (D18)
  var OFF = {}, IN = {}; RIG_GROUPS.forEach(function (g) { OFF[g] = !OPT[g] && !rigIn(rig, g); IN[g] = rigIn(rig, g); });
  S.off = OFF; S.rigIn = IN; S.rig = rig || {}; S.rigSig = rigSigOf(rig); S.grpObjs = {}; S.detached = [];
  S.sepDest = dest === 'line' ? 'line' : 'flare'; S.rigKey = rigKeyOf(rig, S.sepDest);       // v1.3.0 scene key (§8.1)
  // tables filtered by the rig-up (§8.0): picking, valve taps, occlusion, label obstacles
  S.proxies = rigProxies(rig); S.valveProxies = rigValveProxies(rig);
  S.obst = rigObst(rig).map(function (o) { return { box:o.box, x0:0, y0:0, x1:0, y1:0, on:false }; });
  var GRP = null, grpStart = 0, GH = [];
  function beginGrp(g) { GRP = g; grpStart = scene.children.length; }
  function endGrp() {
    if (GRP) { var arr = S.grpObjs[GRP] || (S.grpObjs[GRP] = []); for (var i = grpStart; i < scene.children.length; i++) arr.push(scene.children[i]); }
    GRP = null;
  }
  function ghosting() { return !!(GRP && OFF[GRP]); }
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
  // (one program for both frost materials; the uniform object is per material: CK-101 frostU, CK-102 frostU2)
  function frostMat(U) {
    var m = F.std(PALETTE.steelSatin, 0.8, 0.35, { envMap:envTex, envMapIntensity:1.0 });
    m.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFW;').replace('#include <project_vertex>', '#include <project_vertex>\nvFW = (modelMatrix*vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vFW; uniform float uFrost;\n' + F.FBM_GLSL.replace(/OCT/g, '3'))
        .replace('#include <color_fragment>', '#include <color_fragment>\nfloat wFm = uFrost*smoothstep(0.35,0.65,fbm(vFW.xz*6.0+vFW.y*3.0));\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72,0.86,1.0), wFm);')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.9, wFm);');
    };
    m.customProgramCacheKey = function () { return 'wtsFrost'; };
    return m;
  }
  M.frost = frostMat(frostU);
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
  function add(k, g) { if (ghosting()) GH.push(g); else B[k].push(g); return g; }
  var gl = tex(F.glowTexture());
  S.glowTex = gl;
  // glow / smoke billboards are batched into two Points objects (one draw each), flushed per frame
  S.glowItems = []; S.smokeItems = [];
  function glowItem(list, hex, size, x, y, z, op) { var it = { position:new V3(x, y, z), scale:new V3(size, size, 1), material:{ color:C(hex), opacity:op == null ? 1 : op }, visible:!ghosting(), renderOrder:970 }; list.push(it); return it; }
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
  function dial(x, y, z, face, key) { if (!ghosting()) DIALS.push({ p:[x, y, z], face:face, key:key }); add('steelSatin', F.place(new THREE.TorusGeometry(0.13, 0.014, 6, 24), x, y, z, 0, -0.314, 0)); add('steelDark', F.place(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 20).rotateX(Math.PI / 2), x - 0.025 * Math.sin(-0.314), y, z - 0.025 * Math.cos(0.314), 0, -0.314, 0)); }

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

  // ═══ CK-101 choke manifold (−7.05,0,0) ═════════════════════════════════
  // v1.5.0: the plan of a 3-1/16" 10K two-choke manifold GA drawing, on a skid, no mirror (drawing up = −z = back, down = +z =
  // front; seen from the default camera at +z). Inlet studded tee front-left with the inlet hammer union at 45°; outlet studded
  // tee back-right with the outlet hammer union at 45°; one gate valve at the midpoint of each side; angle-body chokes in the two
  // other corners: ADJUSTABLE front-right (bottom gate → choke → right gate), POSITIVE back-left (left gate → choke → top gate).
  // Bonnets and handwheels on top. In-service leg: gate handwheels green with the rising stems up; standby leg: red handwheels,
  // stems down, no flow (tracers follow the leg, see edgeState). Leg / beans from nodes.choke (leg, beanAdj).
  (function () {
    var Mx = CK_M, Y = Mx.y, rP = pipeRadius(4), B = Mx.blk, h = B / 2, dg = Mx.dg;
    // skid: chequer plate deck, perimeter frame, cross members, lifting eyes
    var SX0 = -8.6, SX1 = -5.5, SZ = 1.25, sxc = (SX0 + SX1) / 2, sw = SX1 - SX0;
    add('plate', F.boxAt(sw, 0.06, 2 * SZ, sxc, 0.17, 0));
    [-SZ + 0.06, SZ - 0.06].forEach(function (z) { add('steelDark', F.boxAt(sw, 0.16, 0.12, sxc, 0.07, z)); });
    [SX0 + 0.06, SX1 - 0.06, Mx.xW, Mx.xc, Mx.xE].forEach(function (x) { add('steelDark', F.boxAt(0.12, 0.16, 2 * SZ - 0.24, x, 0.07, 0)); });
    [[SX0 + 0.2, SZ], [SX1 - 0.2, SZ], [SX0 + 0.2, -SZ], [SX1 - 0.2, -SZ]].forEach(function (q) {
      add('yellow', F.place(new THREE.TorusGeometry(0.07, 0.018, 6, 14), q[0], 0.28, q[1] + (q[1] > 0 ? 0.03 : -0.03), 0, 0, 0)); });
    // pipe supports (pedestal + saddle) under the four corners (two tees, two chokes)
    [[Mx.xW, Mx.zF], [Mx.xE, Mx.zB], [Mx.xE, Mx.zF], [Mx.xW, Mx.zB]].forEach(function (q) {
      add('steelDark', F.boxAt(0.12, Y - h - 0.2, 0.12, q[0], 0.2 + (Y - h - 0.2) / 2, q[1])); add('steelDark', F.boxAt(0.3, 0.03, 0.3, q[0], 0.215, q[1]));
      add('steelDark', F.boxAt(0.3, 0.04, 0.26, q[0], Y - h - 0.02, q[1]));
    });
    // studded connection: companion flange + 8 studs with nuts, its face at c + d·off; a blind face gets a blind flange
    function studFaceAt(c, d, off, blind, rr) {
      var rq = rr || rP, f0 = v3add(c, v3scale(d, off)), t = blind ? 0.05 : 0.035, rF = rq * (blind ? 1.7 : 1.6), n1 = anyPerp(d), n2 = v3cross(d, n1);
      add(blind ? 'steelDark' : 'steelSatin', F.cylAB(f0, v3add(f0, v3scale(d, t)), rF, 20));
      for (var k = 0; k < 8; k++) {
        var an = (k + 0.5) / 8 * Math.PI * 2, o = v3add(f0, v3add(v3scale(n1, Math.cos(an) * rF * 0.8), v3scale(n2, Math.sin(an) * rF * 0.8)));
        add('bolt', F.cylAB(v3add(o, v3scale(d, -0.02)), v3add(o, v3scale(d, t + 0.05)), 0.016, 6));
        add('bolt', F.cylAB(v3add(o, v3scale(d, t)), v3add(o, v3scale(d, t + 0.025)), 0.03, 6));
      }
    }
    // studded tees: [x, z, studded faces (the two sides of the square), 45° port direction, port radius]
    var PX = [1, 0, 0], NX = [-1, 0, 0], PZ = [0, 0, 1], NZ = [0, 0, -1], ndg = [-dg[0], 0, -dg[2]], rOut = pipeRadius(DEF_NPS[2]);
    [[Mx.xW, Mx.zF, [PX, NZ], ndg, rP], [Mx.xE, Mx.zB, [NX, PZ], dg, rOut]].forEach(function (q) {
      var c = [q[0], Y, q[1]];
      add('steelSatin', F.boxAt(B, B, B, q[0], Y, q[1]));
      add('steelDark', F.boxAt(B * 0.5, 0.02, B * 0.5, q[0], Y + h + 0.01, q[1]));                     // forged-block top pad
      q[2].forEach(function (d) { studFaceAt(c, d, h, false); });
      add('steelSatin', F.cylAB(v3add(c, v3scale(q[3], 0.18)), v3add(c, v3scale(q[3], 0.33)), q[4] * 1.35, 20));     // 45° chamfer-port boss
      studFaceAt(c, q[3], 0.33, false, q[4]);
    });
    // hammer union (wing-nut union) along d about o: male sub, wing nut with three radial lugs, female sub
    function hammerUnionAB(o, d, rr) {
      var at = function (k) { return v3add(o, v3scale(d, k)); }, n1 = [0, 1, 0], n2 = v3norm(v3cross(d, n1));
      add('steelSatin', F.cylAB(at(-0.1), at(-0.03), rr * 1.18, 18));
      add('accent', F.cylAB(at(-0.04), at(0.06), rr * 1.5, 18));
      add('accent', F.cylAB(at(0.06), at(0.08), rr * 1.32, 18));
      for (var k = 0; k < 3; k++) { var an = k / 3 * Math.PI * 2 + Math.PI / 2, e = v3add(v3scale(n1, Math.cos(an)), v3scale(n2, Math.sin(an)));
        add('accent', F.cylAB(v3add(at(0.01), v3scale(e, rr * 1.5)), v3add(at(0.01), v3scale(e, rr * 1.5 + 0.09)), 0.03, 6)); }
      add('steelSatin', F.cylAB(at(0.08), at(0.13), rr * 1.22, 18));
    }
    hammerUnionAB([Mx.xW - dg[0] * Mx.uOff, Y, Mx.zF - dg[2] * Mx.uOff], dg, rP);
    hammerUnionAB([Mx.xE + dg[0] * Mx.uOff, Y, Mx.zB + dg[2] * Mx.uOff], dg, rOut);
    // gate valves, one per side (adjustable leg: green / positive leg: red at the default; colours and stems follow the leg in
    // service per frame); A = the pipe axis through the valve, bonnet / handwheel vertical on top
    var mOpen = F.std(PALETTE.ok, 0.2, 0.45), mShut = F.std(PALETTE.alarm, 0.2, 0.45), wMat = [mOpen, mShut];
    var wg = F.mergeGeos([wheel(0.16, 0.018, 0, 0, 0, Math.PI / 2, 0)].concat(wheelSpokes(0.16, 0, 0, 0, true)));
    var stems = [[], []];
    function gate(x, z, ax, li) {
      var A = ax === 'x' ? [1, 0, 0] : [0, 0, 1], c = [x, Y, z], at = function (k) { return v3add(c, v3scale(A, k)); };
      add('steelSatin', ax === 'x' ? F.boxAt(0.34, 0.4, 0.38, x, Y, z) : F.boxAt(0.38, 0.4, 0.34, x, Y, z));
      add('steelSatin', F.cylAB(at(-0.17), at(-0.2), rP * 1.55, 20)); add('steelSatin', F.cylAB(at(0.17), at(0.2), rP * 1.55, 20));
      flange(at(-0.215), A, rP); flange(at(0.215), A, rP);
      add('steelSatin', F.cylAB([x, Y + 0.2, z], [x, Y + 0.24, z], 0.14, 16)); add('steelSatin', F.cylAB([x, Y + 0.24, z], [x, Y + 0.46, z], 0.085, 14));
      add('steelSatin', F.cylAB([x, Y + 0.46, z], [x, Y + 0.52, z], 0.03, 8));
      var wm = new THREE.Mesh(wg, wMat[li]); wm.position.set(x, Y + 0.52, z); scene.add(wm);
      var st = mkMesh(new THREE.CylinderGeometry(0.022, 0.022, 0.26, 8).translate(0, 0.13, 0), M.steelSatin); st.position.set(x, Y + 0.52, z);
      stems[li].push(st);
    }
    Mx.legs.adj.gates.forEach(function (g) { gate(g[0], g[1], g[2], 0); });
    Mx.legs.fixed.gates.forEach(function (g) { gate(g[0], g[1], g[2], 1); });
    // angle-body chokes in the corners: inlet port against the incoming side, outlet nose along the outgoing side (frosts while
    // its leg is in service and the outlet is in the hydrate region); the flow turns 90° inside the body
    var fuA = { uFrost:{ value:0 } }, fuB = { uFrost:{ value:0 } }, mfA = frostMat(fuA), mfB = frostMat(fuB);
    function chokeAngle(L, mf) {
      var c = [L.c[0], Y, L.c[1]], pi = [-L.dIn[0], 0, -L.dIn[2]], po = L.dOut, at = function (d, k) { return v3add(c, v3scale(d, k)); };
      mkMesh(F.mergeGeos([F.boxAt(0.44, 0.44, 0.44, c[0], Y, c[2]), F.cylAB(at(po, 0.22), at(po, 0.34), rP * 1.3, 18),
        F.cylAB(at(pi, 0.22), at(pi, 0.25), rP * 1.55, 20), F.cylAB(at(po, 0.34), at(po, 0.37), rP * 1.55, 20)]), mf, true);
      flange(at(pi, 0.265), pi, rP); flange(at(po, 0.385), po, rP);
      add('steelSatin', F.cylAB([c[0], Y + 0.22, c[2]], [c[0], Y + 0.27, c[2]], 0.17, 20));                          // bonnet flange
    }
    chokeAngle(Mx.legs.adj, mfA); chokeAngle(Mx.legs.fixed, mfB);
    // adjustable choke (front-right): bonnet, hex bonnet nut, position sleeve, rotating handwheel
    var XA = Mx.legs.adj.c[0], ZA = Mx.legs.adj.c[1];
    add('steelSatin', F.cylAB([XA, Y + 0.27, ZA], [XA, Y + 0.6, ZA], 0.1, 16));
    add('steelSatin', F.place(new THREE.CylinderGeometry(0.15, 0.15, 0.09, 6), XA, Y + 0.33, ZA));
    add('yellow', F.cylAB([XA, Y + 0.45, ZA], [XA, Y + 0.56, ZA], 0.104, 16));
    add('steelSatin', F.cylAB([XA, Y + 0.6, ZA], [XA, Y + 0.68, ZA], 0.03, 8));
    var hw = new THREE.Group(); hw.position.set(XA, Y + 0.7, ZA);
    var hwg = F.mergeGeos([wheel(0.2, 0.02, 0, 0, 0, Math.PI / 2, 0)].concat(wheelSpokes(0.2, 0, 0, 0, true)));
    var hwm = new THREE.Mesh(hwg, M.accent); hw.add(hwm); scene.add(hw);
    // positive choke (back-left): hex bean-retainer cap nut with hammer lugs (bean inside the body)
    var XB = Mx.legs.fixed.c[0], ZB = Mx.legs.fixed.c[1];
    add('steelSatin', F.place(new THREE.CylinderGeometry(0.16, 0.16, 0.14, 6), XB, Y + 0.34, ZB));
    add('steelDark', F.cylAB([XB, Y + 0.41, ZB], [XB, Y + 0.46, ZB], 0.09, 14));
    [0, Math.PI].forEach(function (an) { add('steelSatin', F.boxAt(0.12, 0.06, 0.05, XB + Math.cos(an) * 0.2, Y + 0.36, ZB + Math.sin(an) * 0.2, 0, an, 0)); });
    // pressure gauges on the inlet / outlet tees
    add('steelDark', F.cylAB([Mx.xW, Y + h + 0.02, Mx.zF], [Mx.xW, 1.72, Mx.zF], 0.02, 6)); add('steelDark', F.cylAB([Mx.xE, Y + h + 0.02, Mx.zB], [Mx.xE, 1.72, Mx.zB], 0.02, 6));
    dial(Mx.xW, 1.82, Mx.zF + 0.05, 0, 'ckUp'); dial(Mx.xE, 1.82, Mx.zB + 0.05, 1, 'ckDn');
    S.dyn.choke = { wheel:hw, ang:0, wMat:wMat, stems:stems, fu:[fuA, fuB], open:C(PALETTE.ok), shut:C(PALETTE.alarm), lb:-1 };
  })();

  // ═══ DS-101 cyclonic wellhead desander (−10.2,0,−1.6) — optional, built only while in the rig-up (D18) ══════
  // Behind the main line: SDV-101 → D0a → tee → D1 (tangential inlet) → cyclone → overflow D2 → tee → E2 → CK-101;
  // bypass D0b with HV-104; glass accumulator DS-101A under the cone; XV-103 dump line DD to the sand skip.
  var DSV = null;
  if (IN.desander) {
    beginGrp('desander');
    DSV = (function () {
      var X = -10.2, Z = -1.6, R = 0.34, Ri = 0.33, Ls = 0.9, hd = 0.17, hdi = 0.165, Y0 = 0.35;
      add('plate', F.boxAt(1.0, 0.12, 1.0, X, 0.06, Z));                                                  // skid
      add('steelDark', F.cylAB([X, 0.12, Z], [X, 0.40, Z], 0.2, 16, true));                               // accumulator skirt
      var v2 = function (p) { return new THREE.Vector2(p[0], p[1]); };
      var gG = new THREE.LatheGeometry(vesselProfile(R, Ls, hd, 12).map(v2), T.radV);
      var hG = new THREE.LatheGeometry(vesselProfile(Ri, Ls, hdi, 12).map(v2), T.radV);
      var v = vessel('desander', gG, hG, new V3(X, Y0, Z), new V3(X, Y0 + 0.005, Z), { centre:[X, Y0 + 0.62, Z], faceW:0.9, faceO:0.5, frontGlow:0.4 });
      v.Ri = Ri; v.Ls = Ls; v.hd = hdi; v.Hint = Ls + 2 * hdi; v.kind = 'v'; v.y0 = Y0 + 0.005;
      v.U.uWatCol.value = C(PALETTE.sandBody); v.U.uEmul.value = 0.012; v.U.uRip.value = 0.2;
      v.caps = [];
      // LAH / LAHH ticks on the accumulator glass
      [[0.80, '#d29922'], [0.95, '#f85149']].forEach(function (lv) {
        add('bands', F.colorize(F.place(new THREE.TorusGeometry(R + 0.012, 0.008, 6, 32), X, v.y0 + lv[0] * v.Hint, Z, Math.PI / 2, 0, 0), lv[1]));
      });
      // cyclone housing (opaque steel): cone into the accumulator, body, top plate, overflow nozzle, tangential inlet nozzle
      add('steelSatin', F.place(new THREE.ConeGeometry(0.2, 0.45, 20, 1, true).rotateX(Math.PI), X, 1.6 - 0.225, Z));
      add('steelSatin', F.cylAB([X, 1.58, Z], [X, 1.64, Z], 0.26, 20));
      add('steelSatin', F.cylAB([X, 1.64, Z], [X, 2.8, Z], 0.2, 20));
      add('steelSatin', F.cylAB([X, 2.8, Z], [X, 2.84, Z], 0.22, 20));
      add('steelSatin', F.cylAB([X, 2.84, Z], [X, 2.9, Z], 0.12, 14));
      add('steelSatin', F.cylAB([X - 0.25, 2.5, Z], [X - 0.14, 2.5, Z], 0.12, 14));
      [1.95, 2.45].forEach(function (y) { add('steelDark', F.place(new THREE.TorusGeometry(0.205, 0.014, 6, 28), X, y, Z, Math.PI / 2, 0, 0)); });
      add('steelDark', F.cylAB([X, 2.2, Z + 0.2], [X, 2.2, Z + 0.27], 0.02, 6));
      dial(X, 2.2, Z + 0.3, 0, 'dsIn');                                                                  // PI-103 (inlet, wellhead range)
      // status lamp on the top plate
      var stM = new THREE.MeshBasicMaterial({ color:C('#2b1a1a') }), st = mkMesh(new THREE.SphereGeometry(0.05, 12, 8), stM); st.position.set(X + 0.15, 2.97, Z + 0.06);
      add('steelDark', F.cylAB([X + 0.15, 2.84, Z + 0.06], [X + 0.15, 2.93, Z + 0.06], 0.015, 6));
      var stG = sprite('#3fb950', 0.45, X + 0.15, 2.97, Z + 0.06, 0);
      // sand skip (open box) with a sand heap that grows with the sand dumped
      var KX = X, KY = 0.45, KZ = -3.5, KW = 1.2, KH = 0.9, KD = 0.7, kt = 0.04;
      add('yellow', F.boxAt(KW, kt, KD, KX, kt / 2, KZ));
      add('yellow', F.boxAt(KW, KH, kt, KX, KH / 2, KZ - KD / 2 + kt / 2)); add('yellow', F.boxAt(KW, KH, kt, KX, KH / 2, KZ + KD / 2 - kt / 2));
      add('yellow', F.boxAt(kt, KH, KD, KX - KW / 2 + kt / 2, KH / 2, KZ)); add('yellow', F.boxAt(kt, KH, KD, KX + KW / 2 - kt / 2, KH / 2, KZ));
      add('steelDark', F.boxAt(KW + 0.02, 0.05, kt + 0.02, KX, KH - 0.025, KZ - KD / 2 + kt / 2)); add('steelDark', F.boxAt(KW + 0.02, 0.05, kt + 0.02, KX, KH - 0.025, KZ + KD / 2 - kt / 2));
      var heap = mkMesh(new THREE.BoxGeometry(KW - 2.5 * kt, 1, KD - 2.5 * kt).translate(0, 0.5, 0), F.std(PALETTE.sandBody, 0, 0.95, { emissive:C('#3a2a12'), emissiveIntensity:0.4 }));
      heap.position.set(KX, kt, KZ); heap.scale.y = 0.02;
      var dust = [];
      for (var p = 0; p < 3; p++) dust.push(smokeSprite(PALETTE.sandBody, 0.6, KX, KH, KZ, 0));
      // XV-103 dump valve (actuated) on DD, lamp: green open, dark shut, amber held
      var XZ = -2.6, XY = 0.5;
      add('steelSatin', F.boxAt(0.22, 0.24, 0.24, X, XY, XZ));
      add('steelSatin', F.cylAB([X, XY + 0.12, XZ], [X, XY + 0.3, XZ], 0.03, 8));
      add('paintBlue', F.cylAB([X, XY + 0.3, XZ], [X, XY + 0.46, XZ], 0.09, 16));
      var xvM = new THREE.MeshBasicMaterial({ color:C('#2b1a1a') }), xvL = mkMesh(new THREE.SphereGeometry(0.045, 12, 8), xvM); xvL.position.set(X + 0.15, XY + 0.38, XZ);
      // HV-104 bypass valve on D0b (handwheel), block valves on D1 / D2 (handwheels; shut in the bypass line-up)
      gateValve(-10.0, 1.2, 0, 'x', 0.3, 'accent', false);
      gateValve(-10.75, 2.5, -0.95, 'z', 0.28, 'accent', false);
      gateValve(-9.3, 1.2, -0.75, 'z', 0.28, 'accent', false);
      var hvM = new THREE.MeshBasicMaterial({ color:C('#2b1a1a') }), hvL = mkMesh(new THREE.SphereGeometry(0.04, 12, 8), hvM); hvL.position.set(-10.0, 1.42, 0.2);
      var wg = F.mergeGeos([wheel(0.13, 0.015, 0, 0, 0, Math.PI / 2, 0)].concat(wheelSpokes(0.13, 0, 0, 0, true)));
      var wI = new THREE.InstancedMesh(wg, M.accent, 3); wI.frustumCulled = false; scene.add(wI);
      var wO = [new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D()];
      wO[0].position.set(-10.0, 1.2 + 0.15 + 0.3, 0); wO[1].position.set(-10.75, 2.5 + 0.14 + 0.3, -0.95); wO[2].position.set(-9.3, 1.2 + 0.14 + 0.3, -0.75);
      S.dyn.ds = { stM:stM, stG:stG, heap:heap, dust:dust, xvM:xvM, hvM:hvM, wI:wI, wO:wO, skip:[KX, KH, KZ] };
      return v;
    })();
    endGrp();
  }

  // ═══ H-101 line heater (−1.4,0,0) ══════════════════════════════════════
  var heater = {};
  beginGrp('heater');
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
  endGrp();

  // ── tag plates (v1.3.0): small dark plates with an instrument / valve tag; they face +z, the side of the default cameras ──
  function tagPlate(txt, x, y, z) {
    var cv = G.document ? F.canvas(256, 64) : null, cx = cv && cv.getContext ? cv.getContext('2d') : null;
    if (!cx) return null;
    cx.fillStyle = '#161b22'; cx.fillRect(0, 0, 256, 64); cx.strokeStyle = PALETTE.yellow; cx.lineWidth = 4; cx.strokeRect(2, 2, 252, 60);
    cx.fillStyle = '#f0f3f6'; cx.font = '700 34px system-ui, sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(txt, 128, 34);
    var m = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.11), new THREE.MeshBasicMaterial({ map:tex(F.texFrom(cv)), side:THREE.DoubleSide, toneMapped:false }));
    m.position.set(x, y, z); scene.add(m); return m;
  }
  // pressure switch on top of a pipe of visual radius rPipe: stem, housing, tag plate above (PAH-102, PSHH-104)
  function pswitch(tag, p, rPipe) {
    var y0 = p[1] + rPipe;
    add('steelSatin', F.cylAB([p[0], y0, p[2]], [p[0], y0 + 0.18, p[2]], 0.025, 8));
    add('paintBlue', F.boxAt(0.14, 0.12, 0.12, p[0], y0 + 0.24, p[2]));
    tagPlate(tag, p[0], y0 + 0.42, p[2]);
  }

  // ═══ CK-102 heater inlet choke (v1.3.0, §8.1) — optional, built only while in the rig-up (D18) ═══════════
  // On the last horizontal stub of the H-101 inlet leg (E3c1 → CK-102 → E3c2 → coil). Its own materials so the "bypassed"
  // grey (heater bypassed or H-101 out) and the frost on the body are per-frame material states, never a rebuild.
  if (IN.heaterChoke) {
    beginGrp('heaterChoke');
    (function () {
      var X = CK2_AT[0], Y = CK2_AT[1], Z = CK2_AT[2], b = CK2_BODY, k = 0.8, rp = pipeRadius(6);
      var frostU2 = { uFrost:{ value:0 } };
      var mBody = frostMat(frostU2), mSteel = F.std(PALETTE.steelSatin, 0.55, 0.38, { envMap:envTex, envMapIntensity:1.0 }), mWheel = F.std(PALETTE.accent, 0.2, 0.45);
      var body = mkMesh(new THREE.BoxGeometry(b[0], b[1], b[2]), mBody, true); body.position.set(X, Y, Z);
      var yT = Y + b[1] / 2;
      mkMesh(F.mergeGeos([F.cylAB([X, yT, Z], [X, yT + 0.45 * k, Z], 0.09 * k, 14), F.cylAB([X, yT, Z], [X, yT + 0.03, Z], 0.14, 16)]), mSteel, true);   // bonnet
      var hw = new THREE.Group(); hw.position.set(X, yT + 0.45 * k + 0.03, Z);
      hw.add(new THREE.Mesh(F.mergeGeos([wheel(0.17 * k, 0.018 * k, 0, 0, 0, Math.PI / 2, 0)].concat(wheelSpokes(0.17 * k, 0, 0, 0, true))), mWheel)); scene.add(hw);
      pswitch('PAH-102', TAG_PTS.pah102, rp);                                        // between the chokes (D16)
      S.dyn.heaterChoke = { wheel:hw, frostU:frostU2, mats:[mBody, mSteel, mWheel], base:[C(PALETTE.steelSatin), C(PALETTE.steelSatin), C(PALETTE.accent)],
        greyC:C('#5d646e'), grey:-1 };
    })();
    endGrp();
  }

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
  beginGrp('separator');
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

  endGrp();
  // ── H-101 glass shell + bath hull ──────────────────────────────────────
  beginGrp('heater');
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

  endGrp();
  // ── T-201 surge tank (10.2,0,4) ───────────────────────────────────────
  beginGrp('surge');
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
    // inlet divert: LM ends in A's side nozzle (−X, x 9.0) via XV-201A; a tee at x 8.55 feeds B's side nozzle on the +X side
    // (x 11.4, same height y 4.2) via XV-201B: the branch climbs behind the shell (z 3.5, clear of VENT at z 4.0 and of PSV-201),
    // crosses over the top head at y 5.95 and drops on the +X side (x 12.0, clear of T-202 r 1.0 at (12.5, 2.3)) to the nozzle
    var rP = pipeRadius(3), bp = TB_BRANCH;
    for (bi = 0; bi < bp.length - 1; bi++) add('steelSatin', F.cylAB(bp[bi], bp[bi + 1], rP, 12));
    for (bi = 1; bi < bp.length - 1; bi++) add('steelSatin', F.place(new THREE.SphereGeometry(rP * 1.05, 12, 8), bp[bi][0], bp[bi][1], bp[bi][2]));
    add('steelSatin', F.cylAB([11.28, 4.2, 4.0], [11.4, 4.2, 4.0], 0.2, 16));                                                              // B nozzle pad
    add('steelSatin', F.cylAB([11.4, 4.2, 4.0], [11.43, 4.2, 4.0], rP * 1.55, 16)); add('steelSatin', F.cylAB([11.44, 4.2, 4.0], [11.47, 4.2, 4.0], rP * 1.55, 16));
    add('steelSatin', F.boxAt(0.2, 0.22, 0.22, 8.8, 4.2, 4.0)); add('steelSatin', F.cylAB([8.8, 4.2, 4.1], [8.8, 4.2, 4.33], 0.03, 6));       // XV-201A
    add('steelSatin', F.boxAt(0.2, 0.22, 0.22, 11.62, 4.2, 4.0)); add('steelSatin', F.cylAB([11.62, 4.2, 4.1], [11.62, 4.2, 4.33], 0.03, 6)); // XV-201B
    // compartment tags on the shell (A | B either side of the baffle, on the camera side)
    tagPlate('T-201A', 9.86, 2.25, 5.2); tagPlate('T-201B', 10.54, 2.25, 5.2);
    // P-201 suction: A's bottom nozzle (x 9.75) and B's (x 10.65, on X1) with suction valves SV-201A/B
    var sp0 = [[9.75, 0.95, 4.0], [9.75, 0.45, 4.0], [10.65, 0.45, 4.0]];
    add('steelSatin', F.cylAB(sp0[0], sp0[1], rP, 12)); add('steelSatin', F.cylAB(sp0[1], sp0[2], rP, 12));
    add('steelSatin', F.place(new THREE.SphereGeometry(rP * 1.05, 12, 8), 9.75, 0.45, 4.0));
    add('steelSatin', F.boxAt(0.2, 0.2, 0.22, 10.1, 0.45, 4.0)); add('steelSatin', F.boxAt(0.2, 0.2, 0.22, 10.65, 0.72, 4.0));
    return v;
  })();

  // ── LCV-201 surge → gauge transfer valve (12.5,0.45,4): no pump — the surge tank pressure drives the liquid ──
  (function () {
    var X = 12.5, Y = 0.45, Z = 4.0, rP = pipeRadius(3);
    add('steelSatin', F.cylAB([12.2, Y, Z], [12.26, Y, Z], rP * 1.55, 20)); add('steelSatin', F.cylAB([12.74, Y, Z], [12.8, Y, Z], rP * 1.55, 20));   // flanges
    add('steelSatin', F.cylAB([12.26, Y, Z], [12.74, Y, Z], rP * 1.05, 16));
    add('steelSatin', F.place(new THREE.SphereGeometry(rP * 1.6, 16, 12), X, Y, Z));                                                              // globe body
    add('steelSatin', F.cylAB([X, Y + rP * 1.4, Z], [X, Y + 0.55, Z], 0.04, 8));                                                                  // yoke / stem
    add('paintBlue', F.place(new THREE.SphereGeometry(0.21, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), X, Y + 0.57, Z));                          // diaphragm actuator
    add('paintBlue', F.cylAB([X, Y + 0.55, Z], [X, Y + 0.58, Z], 0.21, 20));
    add('steelDark', F.boxAt(0.12, 0.1, 0.1, X + 0.2, Y + 0.35, Z + 0.12));                                                                       // positioner
    var lampM = new THREE.MeshBasicMaterial({ color:C('#2b1a1a') }); var lamp = mkMesh(new THREE.SphereGeometry(0.045, 12, 8), lampM); lamp.position.set(X, Y + 0.83, Z);
    S.dyn.xfer = { lampM:lampM, sig:'' };
  })();
  endGrp();

  // ── T-202 second surge tank (12.5,0,2.3) — optional, built only while in the rig-up (needs T-201, D11) ──────
  // Single compartment, own gas space; drawn at R 1.0 (vessels are not to scale). Inlet LM2 via XV-202, blanket BLK2 via PCV-204,
  // back-pressure VENT2 via PCV-203, PSV-202 → PSV2, transfer X0 via LCV-202 into the X2 riser (downstream of LCV-201).
  var T202 = null;
  if (IN.surge2) {
    beginGrp('surge2');
    T202 = (function () {
      var X = 12.5, Z = 2.3, R = 1.0, Ri = 0.985, Ls = 3.6, hd = 0.5, hdi = 0.485, rP = pipeRadius(3);
      var v2 = function (p) { return new THREE.Vector2(p[0], p[1]); };
      var gG = new THREE.LatheGeometry(vesselProfile(R, Ls, hd, 16).map(v2), T.radV);
      var hG = new THREE.LatheGeometry(vesselProfile(Ri, Ls, hdi, 16).map(v2), T.radV);
      var v = vessel('surge2', gG, hG, new V3(X, 0.9, Z), new V3(X, 0.915, Z), { centre:[X, 3.2, Z], faceW:0.55, faceO:0.8 });
      v.Ri = Ri; v.Ls = Ls; v.hd = hdi; v.Hint = Ls + 2 * hdi; v.kind = 'v'; v.y0 = 0.915;
      [1.5, 4.9].forEach(function (y) { add('steelSatin', F.place(new THREE.TorusGeometry(R + 0.006, 0.024, 8, 56), X, y, Z, Math.PI / 2, 0, 0)); });
      for (var k = 0; k < 4; k++) {
        var a = Math.PI / 4 + k * Math.PI / 2, lx = X + Math.cos(a) * 0.85, lz = Z + Math.sin(a) * 0.85;
        add('steelDark', F.boxAt(0.12, 1.7, 0.12, lx, 0.85, lz)); add('steelDark', F.boxAt(0.3, 0.02, 0.3, lx, 0.01, lz));
      }
      // nozzles: inlet + blanket (−X side, z 2.0), top (VENT2), bottom (X0)
      add('steelSatin', F.cylAB([11.55, 2.9, 2.0], [11.67, 2.9, 2.0], 0.2, 16)); add('steelSatin', F.cylAB([11.55, 4.9, 2.0], [11.67, 4.9, 2.0], 0.14, 16));
      add('steelSatin', F.cylAB([X, 5.44, Z], [X, 5.56, Z], 0.14, 16)); add('steelSatin', F.cylAB([X, 0.84, Z], [X, 0.96, Z], 0.14, 16));
      // PSV-202 on the −X side of the top head (discharge PSV2 → PSV header)
      add('accent', F.boxAt(0.16, 0.24, 0.16, 11.9, 5.52, Z)); add('steelSatin', F.cylAB([11.9, 5.64, Z], [11.9, 5.85, Z], 0.05, 10));
      // sight glass LG-202 on the camera side
      var sx = 12.75, sz = 3.40;
      add('steelSatin', F.cylAB([sx, 1.45, sz], [sx, 1.55, sz], 0.075, 12)); add('steelSatin', F.cylAB([sx, 4.55, sz], [sx, 4.65, sz], 0.075, 12));
      [1.5, 4.6].forEach(function (y) { add('steelDark', F.cylAB([sx, y, sz], [12.68, y, 3.24], 0.025, 6)); });
      var tube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.1, 16, 1, true).translate(0, 3.05, 0), F.makeGlass({ side:THREE.FrontSide, opacity:0.12, tier:tier, envTex:envTex }));
      tube.position.set(sx, 0, sz); tube.renderOrder = 905; scene.add(tube);
      var colW = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 1, 12).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color:C(PALETTE.waterBody), emissive:C(PALETTE.waterBody), emissiveIntensity:0.55, roughness:0.3 }));
      var colO = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 1, 12).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color:C('#a06a24'), emissive:C('#a06a24'), emissiveIntensity:0.55, roughness:0.3 }));
      colW.position.set(sx, 1.55, sz); colO.position.set(sx, 1.55, sz); scene.add(colW); scene.add(colO);
      dial(11.8, 3.0, 3.25, 2, 'surge2'); add('steelDark', F.cylAB([11.78, 3.0, 3.05], [11.8, 3.0, 3.2], 0.02, 6));
      // level cap (one compartment)
      var cap = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2); addEdgeRadial(THREE, cap);
      var cm = new THREE.Mesh(cap, capMat()); cm.position.copy(v.hullFront.position); scene.add(cm); v.caps = [cm];
      // XV-202 inlet valve on LM2 (handwheel follows the valve travel; lamp: green open, red shut, amber travelling)
      add('steelSatin', F.boxAt(0.2, 0.22, 0.22, 9.6, 2.9, 2.0)); add('steelSatin', F.cylAB([9.6, 3.01, 2.0], [9.6, 3.2, 2.0], 0.03, 6));
      var xw = new THREE.Mesh(F.mergeGeos([wheel(0.12, 0.015, 0, 0, 0, Math.PI / 2, 0)].concat(wheelSpokes(0.12, 0, 0, 0, true))), M.accent);
      xw.position.set(9.6, 3.22, 2.0); scene.add(xw);
      var xvM = new THREE.MeshBasicMaterial({ color:C('#2b1a1a') }), xvL = mkMesh(new THREE.SphereGeometry(0.055, 12, 8), xvM); xvL.position.set(9.6, 3.12, 1.8);
      // LCV-202 transfer valve on X0 (lamp: green open, amber low ΔP, red tripped / stuck)
      var LX = 13.05, LY = 0.45, LZ = 3.5;
      add('steelSatin', F.cylAB([LX - 0.25, LY, LZ], [LX - 0.2, LY, LZ], rP * 1.45, 20)); add('steelSatin', F.cylAB([LX + 0.2, LY, LZ], [LX + 0.25, LY, LZ], rP * 1.45, 20));
      add('steelSatin', F.place(new THREE.SphereGeometry(rP * 1.3, 16, 12), LX, LY, LZ));
      add('steelSatin', F.cylAB([LX, LY + rP * 1.2, LZ], [LX, LY + 0.5, LZ], 0.035, 8));
      add('paintBlue', F.place(new THREE.SphereGeometry(0.17, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), LX, LY + 0.52, LZ)); add('paintBlue', F.cylAB([LX, LY + 0.5, LZ], [LX, LY + 0.53, LZ], 0.17, 18));
      var lcM = new THREE.MeshBasicMaterial({ color:C('#2b1a1a') }), lcL = mkMesh(new THREE.SphereGeometry(0.045, 12, 8), lcM); lcL.position.set(LX, LY + 0.76, LZ);
      // PCV-203 back-pressure valve on VENT2, PCV-204 blanket valve on BLK2 (globe + diaphragm actuator)
      [[12.68, 6.1, Z, 0.12], [9.6, 4.9, 2.0, 0.14]].forEach(function (g) {
        add('steelSatin', F.place(new THREE.SphereGeometry(g[3], 16, 12), g[0], g[1], g[2]));
        add('steelSatin', F.cylAB([g[0], g[1] + g[3] * 0.8, g[2]], [g[0], g[1] + 0.32, g[2]], 0.035, 8));
        add('paintBlue', F.place(new THREE.SphereGeometry(0.15, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), g[0], g[1] + 0.34, g[2])); add('paintBlue', F.cylAB([g[0], g[1] + 0.32, g[2]], [g[0], g[1] + 0.35, g[2]], 0.15, 18));
      });
      S.dyn.surge2 = { sight:{ w:colW, o:colO, y0:1.55, y1:4.55 }, xw:xw, xvM:xvM, lcM:lcM };
      return v;
    })();
    endGrp();
  }

  // ── P-201 transfer pump (20.3,0,6.3): downstream of the gauge tank (T-301 drains → P-201 → export / burner) ──
  beginGrp('pump');
  (function () {
    var dx = 7.8, dz = 2.3, Y = 0.45;
    var P = function (x, y, z) { return [x + dx, y, z + dz]; };
    add('steelDark', F.boxAt(0.8, 0.1, 1.6, 12.5 + dx, 0.05, 3.45 + dz));
    add('steelSatin', F.cylAB(P(12.5, Y, 3.9), P(12.5, Y, 4.12), 0.3, 24)); add('steelSatin', F.cylAB(P(12.5, Y, 3.85), P(12.5, Y, 3.9), 0.18, 16));
    add('steelSatin', F.cylAB(P(12.2, Y, 4.0), P(12.25, Y, 4.0), 0.18, 16));
    add('steelSatin', F.cylAB(P(12.5, 0.72, 4.0), P(12.5, 0.76, 4.0), 0.2, 16));
    add('paintBlue', F.cylAB(P(12.5, Y, 3.52), P(12.5, Y, 2.85), 0.22, 24)); add('paintBlue', F.boxAt(0.3, 0.2, 0.5, 12.5 + dx, 0.2, 3.2 + dz));
    for (var k = 0; k < 6; k++) add('paintBlue', F.boxAt(0.02, 0.46, 0.6, 12.5 + dx, Y, 3.18 + dz, 0, 0, k * Math.PI / 6));
    add('accent', F.place(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 20, 1, true, 0, Math.PI), 12.5 + dx, Y, 3.7 + dz, Math.PI / 2, 0, 0));
    var coup = mkMesh(F.mergeGeos([new THREE.CylinderGeometry(0.075, 0.075, 0.26, 12).rotateX(Math.PI / 2), F.boxAt(0.17, 0.03, 0.1, 0, 0, 0)]), M.steelSatin);
    coup.position.set(12.5 + dx, Y, 3.7 + dz);
    var lampM = new THREE.MeshBasicMaterial({ color:C('#2b0f0f') }); var lamp = mkMesh(new THREE.SphereGeometry(0.05, 12, 8), lampM); lamp.position.set(12.95 + dx, 0.95, 3.2 + dz);
    add('steelDark', F.cylAB([12.95 + dx, 0.1, 3.2 + dz], [12.95 + dx, 0.9, 3.2 + dz], 0.02, 6));
    // discharge → export / burner line (riser, run east, drop to a hose connection)
    var rP = pipeRadius(3), dp = [P(12.5, 0.76, 4.0), P(12.5, 1.25, 4.0), [21.7, 1.25, 6.3], [21.7, 0.35, 6.3]];
    for (var i = 0; i < dp.length - 1; i++) add('steelSatin', F.cylAB(dp[i], dp[i + 1], rP, 12));
    for (i = 1; i < dp.length - 1; i++) add('steelSatin', F.place(new THREE.SphereGeometry(rP * 1.05, 12, 8), dp[i][0], dp[i][1], dp[i][2]));
    add('steelSatin', F.cylAB([21.7, 0.35, 6.3], [21.82, 0.35, 6.3], 0.22, 16)); add('rubber', F.cylAB([21.82, 0.35, 6.3], [22.4, 0.2, 6.3], 0.1, 12));
    S.dyn.pump = { coup:coup, lampM:lampM, ang:0 };
  })();
  endGrp();

  // ── T-301 gauge tank (16.4,0,4) ───────────────────────────────────────
  beginGrp('gauge');
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
    add('steelSatin', F.boxAt(0.22, 0.22, 0.22, 15.4, 0.45, 5.8)); add('steelSatin', F.boxAt(0.22, 0.22, 0.22, 17.9, 0.45, 5.8));
    dvA.position.set(15.4, 0.72, 5.8); dvB.position.set(17.9, 0.72, 5.8);
    // T-201 inlet valve handwheels (XV-201A / XV-201B face +Z on the two side-nozzle stubs)
    var sxA = new THREE.Object3D(), sxB = new THREE.Object3D();
    sxA.position.set(8.8, 4.2, 4.35); sxA.rotation.x = Math.PI / 2; sxB.position.set(11.62, 4.2, 4.35); sxB.rotation.x = Math.PI / 2;
    var vInst = new THREE.InstancedMesh(xvA.geometry, M.accent, 6); vInst.frustumCulled = false; if (T.shadow) vInst.castShadow = false; scene.add(vInst);
    vInst.userData.keepOnGhost = true;            // also carries the T-201 inlet valve handwheels (kept when only T-301 is out)
    // valve status lamps: green = open / in service, red = inlet shut, dark = suction out of service  [XV-301A, XV-301B, XV-201A, XV-201B, SV-201A, SV-201B]
    var lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 12, 8), new THREE.MeshBasicMaterial({ color:C('#ffffff') }), 6);
    lamps.frustumCulled = false; scene.add(lamps); lamps.userData.keepOnGhost = true;
    [[15.2, 3.36, 3.36], [17.6, 3.36, 3.36], [8.8, 4.42, 4.0], [11.62, 4.42, 4.0], [10.1, 0.62, 4.22], [10.65, 0.89, 4.22]].forEach(function (p, i) {
      lamps.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p[0], p[1], p[2])); lamps.setColorAt(i, C('#2b1a1a'));
    });
    lamps.instanceMatrix.needsUpdate = true; if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    add('steelSatin', F.cylAB([15.4, 0.45, 5.8], [15.4, 0.7, 5.8], 0.03, 6)); add('steelSatin', F.cylAB([17.9, 0.45, 5.8], [17.9, 0.7, 5.8], 0.03, 6));
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
  endGrp();

  // ═══ FS-401 flare stack (19.5,0,−4.5) ══════════════════════════════════
  beginGrp('flare');
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
  endGrp();

  // ═══ rig-up bypass spools (amber, static) for the items out of the spread ═══
  // v1.3.0: with V-101 out the separator spool follows the destination ('line': LINE_SPOOL to the export spool and the tie-in);
  // PSHH-104 sits on it for both destinations, NRV-501 / XV-501 at the tie-in for 'line'
  (function () {
    var rS = 0.12;
    Object.keys(BYPASS_SPOOLS).forEach(function (g) {
      if (!OFF[g]) return;
      if (g === 'surge' && OFF.separator) return;                    // nothing reaches the tanks without the separator
      if (g === 'gauge' && OFF.surge) return;                        // (no surge tank: the separator spool feeds the fill line)
      if (g === 'flare' && OFF.separator && S.sepDest === 'line') return;   // LINE_SPOOL already runs the export spool to the tie-in
      var pts = g === 'separator' && S.sepDest === 'line' ? LINE_SPOOL : BYPASS_SPOOLS[g];
      for (var i = 0; i < pts.length - 1; i++) add('yellow', F.cylAB(pts[i], pts[i + 1], rS, 12));
      for (i = 0; i < pts.length; i++) add('yellow', F.place(new THREE.SphereGeometry(rS * 1.25, 12, 8), pts[i][0], pts[i][1], pts[i][2]));
    });
    if (OFF.separator) {
      pswitch('PSHH-104', TAG_PTS.pshh104, rS);                       // bypass path high-high pressure: trips SDV-101 (D16)
      if (S.sepDest === 'line') {
        var nv = TAG_PTS.nrv501, xv = TAG_PTS.xv501;
        // NRV-501 non-return valve (body + swing-check cover), XV-501 isolation valve (gate valve with handwheel)
        add('steelSatin', F.boxAt(0.34, 0.3, 0.3, nv[0], nv[1], nv[2])); add('steelSatin', F.cylAB([nv[0], nv[1] + 0.15, nv[2]], [nv[0], nv[1] + 0.24, nv[2]], 0.13, 16));
        add('steelDark', F.boxAt(0.12, 0.02, 0.05, nv[0], nv[1] + 0.25, nv[2] + 0.1));
        gateValve(xv[0], xv[1], xv[2], 'x', 0.3);
        tagPlate('NRV-501', nv[0], nv[1] + 0.48, nv[2]); tagPlate('XV-501', xv[0], xv[1] + 0.82, xv[2]);
      }
    }
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
  (function () {
    var hm = new THREE.InstancedMesh(new THREE.RingGeometry(1, 1.07, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2, fog:false, toneMapped:false }), EQ_IDS.length);
    hm.frustumCulled = false; hm.renderOrder = 995; scene.add(hm);
    var cc = new THREE.Color(0, 0, 0), m4 = new THREE.Matrix4();
    for (var i = 0; i < EQ_IDS.length; i++) { m4.makeScale(0.0001, 1, 0.0001); hm.setMatrixAt(i, m4); hm.setColorAt(i, cc); }
    S.dyn.halos = { mesh:hm, pos:HALO };
    var BL = rigBlobs(rig);
    var bm = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map:tex(F.blobTexture()), transparent:true, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2, color:0xffffff }), BL.length);
    for (var b = 0; b < BL.length; b++) { m4.makeScale(BL[b][2], 1, BL[b][3]); m4.setPosition(BL[b][0], 0.027, BL[b][1]); bm.setMatrixAt(b, m4); }
    bm.renderOrder = 1; scene.add(bm);
  })();

  // ═══ flare flame layers, halo, pilot, smoke, wet streak ═════════════════
  beginGrp('flare');
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
  endGrp();

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
  if (T202) { vesselPoints(T202, Math.round(24 * K)); T202.partSplit = [Math.round(16 * K), Math.round(24 * K)]; }   // bubbles | inlet splash
  if (DSV) { vesselPoints(DSV, Math.round(16 * K)); DSV.partSplit = [Math.round(16 * K), Math.round(16 * K)]; }   // sand grains settling

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

  // ═══ rig-up ghosts: detach the out-of-rig equipment, keep a translucent silhouette (glass shell + merged parts) ═══
  var ghostShell = null, VES = [V101, H101, T201, T301];          // core vessels only: optional items are never ghosted
  RIG_GROUPS.forEach(function (g) {
    if (!OFF[g]) return;
    VES.forEach(function (v) { if (v.id === g && v.points) { scene.remove(v.points); S.detached.push(v.points); } });
    (S.grpObjs[g] || []).forEach(function (o) {
      var shell = null;
      VES.forEach(function (v) { if (v.id === g && v.glassFront === o) shell = v; });
      if (shell) {
        if (!ghostShell) ghostShell = new THREE.MeshBasicMaterial({ color:C('#8b949e'), transparent:true, opacity:0.07, depthWrite:false, side:THREE.DoubleSide });
        S.detached.push({ material:o.material }); o.material = ghostShell; o.renderOrder = 881; return;
      }
      if (o.userData && o.userData.keepOnGhost) return;
      scene.remove(o); S.detached.push(o);
    });
  });
  if (GH.length) {
    var gm = new THREE.Mesh(F.mergeGeos(GH), new THREE.MeshBasicMaterial({ color:C('#8b949e'), transparent:true, opacity:0.14, depthWrite:false }));
    gm.renderOrder = 880; scene.add(gm); S.ghost = gm;
  }

  // ═══ merge static opaque buckets ═══════════════════════════════════════
  var colorB = { bands:true, emissive:true };
  Object.keys(B).forEach(function (k) {
    if (!B[k].length) return;
    var mesh = new THREE.Mesh(F.mergeGeos(B[k], { color:!!colorB[k] }), M[k]);
    if (T.shadow && k !== 'emissive') { mesh.castShadow = true; mesh.receiveShadow = true; }
    scene.add(mesh);
  });

  S.vesselsById = { separator:V101, heater:H101, surge:T201, gauge:T301 };
  if (DSV) S.vesselsById.desander = DSV;
  if (T202) S.vesselsById.surge2 = T202;
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
  if (r.rSeg != null) return pipeRadius(nps[r.rSeg]);                // CK-101 legs downstream of the chokes: manifold bore
  if (r.seg >= 0) return pipeRadius(nps[r.seg]);
  if (r.npsSeg != null) return pipeRadius(nps[r.npsSeg]);
  return pipeRadius(r.nps);
}
// is a route built for this rig-up? (routes tagged with an optional item exist only while it is in)
// (r.unless: built only while that item is OUT — E3c, replaced by E3c1 + E3c2 while CK-102 is in)
function routeGeom(r, rv) { return buildRoute(r.pts, rv, r.rb != null ? { rb:r.rb } : null); }
function routeBuilt(r, rig) { return (!r.rig || rigIn(rig, r.rig)) && (!r.unless || !rigIn(rig, r.unless)); }
// arc length on route `id` nearest to point p (tracers continue from a tee instead of jumping back), sampled at `step`
function joinS(id, p, nps, step) {
  var r = ROUTES[ROUTE_IDX[id]], rt = routeGeom(r, routeRVis(r, nps || DEF_NPS)), st = step || 0.04, n = Math.max(2, Math.ceil(rt.length / st) + 1);
  var smp = { p:[0, 0, 0], t:[1, 0, 0] }, best = 1e9, sb = 0;
  for (var q = 0; q < n; q++) { var s = Math.min(q * st, rt.length); routeSample(rt, s, smp); var d = v3len(v3sub(smp.p, p)); if (d < best) { best = d; sb = s; } }
  return sb;
}
var DEF_NPS = ['4', '4', '6', '6', '6', '3'];
// chain lengths over the built edges (MULTI weighted ×1.6) and the per-chain tracer counts: every chain except DR is rounded
// first, DR keeps the remainder (§8.1). Pure; the default rig-up reproduces the v3.3 allocation exactly.
function chainEdges(c, rig) { return CHAIN_DEF[c].edges.filter(function (id) { return routeBuilt(ROUTES[ROUTE_IDX[id]], rig); }); }
function chainWeights(rig, lenOf) {
  var w = [];
  for (var c = 0; c < CHAIN_DEF.length; c++) { var L = 0; chainEdges(c, rig).forEach(function (id) { L += lenOf(id); }); w.push(L * (CHAIN_DEF[c].id === 'MULTI' ? 1.6 : 1)); }
  return w;
}
function tracerCounts(nT, w) {
  var tw = 0, c, k = 0, dr = -1, cnt = [];
  for (c = 0; c < w.length; c++) { tw += w[c]; if (CHAIN_DEF[c].id === 'DR') dr = c; }
  for (c = 0; c < w.length; c++) { if (c === dr) { cnt.push(0); continue; } var n = tw > 0 ? Math.round(nT * w[c] / tw) : 0; n = Math.min(n, nT - k); cnt.push(n); k += n; }
  if (dr >= 0) cnt[dr] = Math.max(0, nT - k);
  return cnt;
}
function routeLenFn(nps) { var cache = {}; return function (id) { if (cache[id] == null) { var r = ROUTES[ROUTE_IDX[id]]; cache[id] = routeGeom(r, routeRVis(r, nps || DEF_NPS)).length; } return cache[id]; }; }

// ── 3D clearance model (§8.1, §9.2): rendered primitives as vertical cylinders (vessels: shell + heads' bounding cylinder),
// capsules (pipes, NPS radius, waypoint to waypoint) and boxes (valves, dials, props). EQ_BOX and PROXIES are not part of it.
// PROPS: hand-listed static boxes of the existing scene near the optional items (walkway grating and handrails, gas-rack posts
// and crossarms, bund kerb, DAQ cabin, existing vessels / valve bodies as boxes).
var PROPS = [
  ['walkway grating', [13.8, 2.85, 1.95], [19.0, 2.89, 2.65]], ['walkway handrail', [13.75, 2.81, 1.92], [19.05, 3.875, 1.98]],
  ['gas-rack post 11.5', [11.425, 0, -0.075], [11.575, 3.4, 0.075]], ['gas-rack arm 11.5', [11.425, 3.38, -0.7], [11.575, 3.5, 0.7]],
  ['gas-rack post 14.5', [14.425, 0, -0.075], [14.575, 3.4, 0.075]], ['gas-rack arm 14.5', [14.425, 3.38, -0.7], [14.575, 3.5, 0.7]],
  ['gas-rack post 17.5', [17.425, 0, -0.075], [17.575, 3.4, 0.075]], ['gas-rack arm 17.5', [17.425, 3.38, -0.7], [17.575, 3.5, 0.7]],
  ['bund kerb S', [-17.48, 0, -2.38], [-4.32, 0.26, -2.22]], ['bund kerb N', [-17.48, 0, 3.22], [-4.32, 0.26, 3.38]],
  ['bund kerb W', [-17.48, 0, -2.38], [-17.32, 0.26, 3.38]], ['bund kerb E', [-4.48, 0, -2.38], [-4.32, 0.26, 3.38]],
  ['DAQ cabin', [-11.05, 0, -7.72], [-4.95, 2.8, -5.28]], ['DAQ cabin box', [-10.8, 1.8, -5.35], [-10.0, 2.4, -4.85]],
  ['T-301', [13.8, 0, 2.6], [19.0, 2.89, 5.4]], ['V-101', [2.05, 1.15, -0.9], [9.15, 2.9, 0.9]], ['H-101', [-3.6, 0, -0.9], [1.0, 2.5, 1.7]],
  ['choke skid', [-8.6, 0, -1.25], [-5.5, 0.2, 1.25]],
  ['CK-101 inlet tee', [-8.01, 0.99, 0.54], [-7.59, 1.41, 0.96]], ['CK-101 outlet tee', [-6.51, 0.99, -0.96], [-6.09, 1.41, -0.54]],
  ['CK-101 choke ADJ', [-6.52, 0.98, 0.53], [-6.08, 1.92, 0.97]], ['CK-101 choke POS', [-8.06, 0.98, -0.97], [-7.54, 1.68, -0.53]],
  ['SDV-101', [-11.95, 0.94, -0.33], [-11.25, 3.12, 0.33]],
  ['LCV-201', [12.2, 0.22, 3.77], [12.8, 1.03, 4.23]], ['PCV-201', [11.45, 5.95, 3.85], [11.75, 6.75, 4.15]],
  ['XV-201A', [8.69, 4.09, 3.89], [8.91, 4.31, 4.33]], ['XV-201B', [11.51, 4.09, 3.89], [11.73, 4.31, 4.33]],
  ['SV-201A', [10.0, 0.35, 3.89], [10.2, 0.55, 4.11]], ['SV-201B', [10.55, 0.62, 3.89], [10.75, 0.82, 4.11]],
  ['PCV-101', [10.33, 3.33, -0.27], [10.87, 4.35, 0.27]], ['PCV-202', [3.85, 4.65, 1.75], [4.35, 5.55, 2.25]], ['FE-101', [9.24, 3.29, -0.31], [9.36, 4.25, 0.31]],
  // v1.3.0: the real neighbours of CK-102 (H-101 west shell end ring; the 'H-101' box above is coarse and contains the inlet
  // stub) and of the production-line spool (flare knock-out drum, flare base and stack, windsock pole)
  ['H-101 end ring W', [-3.135, 0.765, -0.835], [-3.065, 2.435, 0.835]], ['flare KO drum', [17.95, 0.4, -3.55], [18.45, 1.2, -3.25]],
  ['flare base', [18.7, 0, -5.3], [20.3, 0.5, -3.7]], ['flare stack', [19.28, 0.5, -4.72], [19.72, 7.8, -4.28]], ['windsock pole', [22.45, 0, -7.55], [22.55, 6.0, -7.45]]
];
// existing pipework outside ROUTES (T-201 B-inlet branch, T-201 suction, PSV-201 discharge) and vessels as cylinders
var EXTRA_PIPES = [['T-201 B branch', TB_BRANCH, 3],
  ['T-201 suction', [[9.75, 0.95, 4.0], [9.75, 0.45, 4.0], [10.65, 0.45, 4.0]], 3], ['PSV-201 discharge', [[10.65, 5.74, 4.35], [10.65, 6.1, 4.35], [10.65, 6.1, 4.0]], 1]];
var VESSEL_CYLS = [['T-201', [10.2, 4.0], 1.2, 0.9, 5.7]];
// optional items' equipment primitives (j = joined to; on = valve body sitting on those routes)
var OPT_PRIMS = {
  desander:[
    { id:'DS-101 skid', k:'box', min:[-10.7, 0, -2.1], max:[-9.7, 0.12, -1.1], j:['DS-101 skirt'] },
    { id:'DS-101 skirt', k:'cyl', c:[-10.2, -1.6], r:0.2, y0:0.12, y1:0.40, j:['DS-101A'] },
    { id:'DS-101A', k:'cyl', c:[-10.2, -1.6], r:0.34, y0:0.35, y1:1.59, j:['DS-101 housing'] },
    { id:'DS-101 housing', k:'cyl', c:[-10.2, -1.6], r:0.26, y0:1.15, y1:2.9, j:['DS-101 dial'] },
    { id:'DS-101 dial', k:'box', min:[-10.35, 2.05, -1.33], max:[-10.05, 2.35, -1.27] },
    { id:'sand skip', k:'box', min:[-10.8, 0, -3.85], max:[-9.6, 0.9, -3.15] },
    { id:'XV-103', k:'box', min:[-10.31, 0.38, -2.72], max:[-10.09, 0.96, -2.48], on:['DD'] },
    { id:'HV-104', k:'box', min:[-10.15, 1.05, -0.15], max:[-9.85, 1.85, 0.15], on:['D0b'] },
    { id:'DS-101 block valve D1', k:'box', min:[-10.89, 2.36, -1.08], max:[-10.61, 2.94, -0.82], on:['D1'] },
    { id:'DS-101 block valve D2', k:'box', min:[-9.44, 1.06, -0.88], max:[-9.16, 1.64, -0.62], on:['D2'] }],
  surge2:[
    { id:'T-202', k:'cyl', c:[12.5, 2.3], r:1.0, y0:0.9, y1:5.5, j:['T-202 leg 1', 'T-202 leg 2', 'T-202 leg 3', 'T-202 leg 4', 'LG-202', 'PSV-202', 'T-202 dial'] },
    { id:'T-202 leg 1', k:'box', min:[13.041, 0, 2.841], max:[13.161, 1.7, 2.961] }, { id:'T-202 leg 2', k:'box', min:[11.839, 0, 2.841], max:[11.959, 1.7, 2.961] },
    { id:'T-202 leg 3', k:'box', min:[11.839, 0, 1.639], max:[11.959, 1.7, 1.759] }, { id:'T-202 leg 4', k:'box', min:[13.041, 0, 1.639], max:[13.161, 1.7, 1.759] },
    { id:'LG-202', k:'cyl', c:[12.75, 3.40], r:0.075, y0:1.45, y1:4.65 },
    { id:'PSV-202', k:'box', min:[11.82, 5.40, 2.22], max:[11.98, 5.64, 2.38], on:['PSV2'] },
    { id:'T-202 dial', k:'box', min:[11.65, 2.85, 3.21], max:[11.95, 3.15, 3.29] },
    { id:'XV-202', k:'box', min:[9.48, 2.79, 1.86], max:[9.72, 3.37, 2.14], on:['LM2'] },
    { id:'LCV-202', k:'box', min:[12.865, 0.265, 3.315], max:[13.235, 1.14, 3.685], on:['X0'] },
    { id:'PCV-203', k:'box', min:[12.53, 5.98, 2.15], max:[12.83, 6.6, 2.45], on:['VENT2'] },
    { id:'PCV-204', k:'box', min:[9.45, 4.76, 1.85], max:[9.75, 5.39, 2.15], on:['BLK2'] }],
  // CK-102 (v1.3.0): body on E3c1 / E3c2, bonnet, handwheel, PAH-102 switch and plate on E3c1 ('H-101' = the coarse H-101 box
  // that contains the whole inlet stub; the end ring is checked instead)
  heaterChoke:[
    { id:'CK-102 body', k:'box', min:[-3.65, 1.67, 0.17], max:[-3.25, 2.13, 0.63], on:['E3c1', 'E3c2'], j:['CK-102 bonnet', 'H-101'] },
    { id:'CK-102 bonnet', k:'cyl', c:[-3.45, 0.4], r:0.14, y0:2.13, y1:2.52, j:['CK-102 handwheel', 'H-101'] },
    { id:'CK-102 handwheel', k:'cyl', c:[-3.45, 0.4], r:0.154, y0:2.49, y1:2.56, j:['H-101'] },
    { id:'PAH-102 switch', k:'box', min:[-3.97, 2.11, 0.13], max:[-3.83, 2.42, 0.27], on:['E3c1'], j:['PAH-102 plate'] },
    { id:'PAH-102 plate', k:'box', min:[-4.12, 2.475, 0.19], max:[-3.68, 2.59, 0.21] }]
};
// V-101 out (v1.3.0): the bypass spool of the destination, PSHH-104 on it and, for 'line', NRV-501 / XV-501 at the tie-in
var SPOOL_PRIMS = {
  pshh104:{ id:'PSHH-104', k:'box', min:[2.98, 3.72, -1.31], max:[3.42, 4.2, -1.19], on:['V-101 bypass spool'] },
  line:[{ id:'NRV-501', k:'box', min:[20.08, 0.85, -6.75], max:[20.52, 1.54, -6.45], on:['V-101 bypass spool', 'export spool'] },     // (the line spool
        { id:'XV-501', k:'box', min:[21.18, 0.85, -6.75], max:[21.62, 1.88, -6.45], on:['V-101 bypass spool', 'export spool'] }]       //  shares the export run)
};
// primitives of the scene for a rig-up; `isNew` marks the optional items' primitives and the v1.2.0 routes (the ones checked)
function clearancePrims(rig, dest) {
  var out = [], nps = DEF_NPS;
  function caps(id, pts, r, isNew, route) {
    for (var i = 0; i < pts.length - 1; i++) out.push({ id:id + '#' + i, k:'cap', a:pts[i], b:pts[i + 1], r:r, route:route || id, isNew:isNew,
      endA:i === 0 ? pts[0] : null, endB:i === pts.length - 2 ? pts[pts.length - 1] : null });
  }
  ROUTES.forEach(function (r) { if (!routeBuilt(r, rig)) return; caps(r.id, r.pts, routeRVis(r, nps), NEW_ROUTES.indexOf(r.id) >= 0); });
  caps('PSV header', PSV_ROUTE, pipeRadius(3), false);
  EXTRA_PIPES.forEach(function (e) { caps(e[0], e[1], pipeRadius(e[2]), false); });
  VESSEL_CYLS.forEach(function (v) { out.push({ id:v[0], k:'cyl', c:v[1], r:v[2], y0:v[3], y1:v[4], isNew:false }); });
  PROPS.forEach(function (p) { out.push({ id:p[0], k:'box', min:p[1], max:p[2], isNew:false }); });
  function cp(p) { var q = {}; for (var k in p) q[k] = p[k]; q.isNew = true; out.push(q); }
  OPT_IDS.forEach(function (g) { if (!rigIn(rig, g)) return; OPT_PRIMS[g].forEach(cp); });
  if (!rigIn(rig, 'separator')) {
    var line = dest === 'line';
    caps('V-101 bypass spool', line ? LINE_SPOOL : BYPASS_SPOOLS.separator, 0.12, true);
    cp(SPOOL_PRIMS.pshh104); if (line) SPOOL_PRIMS.line.forEach(cp);
    if (!rigIn(rig, 'flare') && !line) caps('export spool', BYPASS_SPOOLS.flare, 0.12, false);   // ('line': LINE_SPOOL covers that run)
  }
  return out;
}
function ptSegDist(p, a, b) {
  var d = v3sub(b, a), L2 = v3dot(d, d), t = L2 > 0 ? clamp(v3dot(v3sub(p, a), d) / L2, 0, 1) : 0;
  return v3len(v3sub(p, v3add(a, v3scale(d, t))));
}
// distance from a point to a primitive's surface (0 inside)
function ptPrimDist(p, q) {
  if (q.k === 'cap') return Math.max(0, ptSegDist(p, q.a, q.b) - q.r);
  if (q.k === 'cyl') { var dh = Math.max(0, Math.hypot(p[0] - q.c[0], p[2] - q.c[1]) - q.r), dy = Math.max(0, q.y0 - p[1], p[1] - q.y1); return Math.hypot(dh, dy); }
  var dx = Math.max(0, q.min[0] - p[0], p[0] - q.max[0]), dyb = Math.max(0, q.min[1] - p[1], p[1] - q.max[1]), dz = Math.max(0, q.min[2] - p[2], p[2] - q.max[2]);
  return Math.sqrt(dx * dx + dyb * dyb + dz * dz);
}
// gap between two primitives (≤ 0 when they touch / overlap); capsules are sampled every 2 cm
function primGap(p, q) {
  if (p.k !== 'cap' && q.k === 'cap') { var t = p; p = q; q = t; }
  if (p.k === 'cap') {
    var L = v3len(v3sub(p.b, p.a)), n = Math.max(1, Math.ceil(L / 0.02)), best = 1e9;
    for (var i = 0; i <= n; i++) { var s = v3add(p.a, v3scale(v3sub(p.b, p.a), i / n)), d = q.k === 'cap' ? ptSegDist(s, q.a, q.b) - q.r : ptPrimDist(s, q); if (d < best) best = d; }
    return best - p.r;
  }
  var dy = Math.max(0, (q.k === 'cyl' ? q.y0 : q.min[1]) - (p.k === 'cyl' ? p.y1 : p.max[1]), (p.k === 'cyl' ? p.y0 : p.min[1]) - (q.k === 'cyl' ? q.y1 : q.max[1]));
  var dh;
  if (p.k === 'cyl' && q.k === 'cyl') dh = Math.hypot(p.c[0] - q.c[0], p.c[1] - q.c[1]) - p.r - q.r;
  else if (p.k === 'box' && q.k === 'box') dh = Math.hypot(Math.max(0, q.min[0] - p.max[0], p.min[0] - q.max[0]), Math.max(0, q.min[2] - p.max[2], p.min[2] - q.max[2])) ||
    -Math.min(Math.min(p.max[0], q.max[0]) - Math.max(p.min[0], q.min[0]), Math.min(p.max[2], q.max[2]) - Math.max(p.min[2], q.min[2]));
  else { var cy = p.k === 'cyl' ? p : q, bx = p.k === 'cyl' ? q : p;
    dh = Math.hypot(Math.max(0, bx.min[0] - cy.c[0], cy.c[0] - bx.max[0]), Math.max(0, bx.min[2] - cy.c[1], cy.c[1] - bx.max[2])) - cy.r; }
  return dy > 0 && dh > 0 ? Math.hypot(dy, dh) : (dy > 0 ? dy : dh);
}
function primJoined(p, q) {
  if (p.route && q.route && p.route === q.route) return true;
  if ((p.j && p.j.indexOf(q.id) >= 0) || (q.j && q.j.indexOf(p.id) >= 0)) return true;
  if ((p.on && q.route && p.on.indexOf(q.route) >= 0) || (q.on && p.route && q.on.indexOf(p.route) >= 0)) return true;
  function endOn(c, o) { return c.k === 'cap' && ((c.endA && ptPrimDist(c.endA, o) <= c.r + 0.1) || (c.endB && ptPrimDist(c.endB, o) <= c.r + 0.1)); }
  // a route end joins what it lands on (nozzle, tee, flange); for routes the whole route counts as the joined partner
  return endOn(p, q) || endOn(q, p);
}
// → [{a, b, gap}] for every new primitive closer than `minGap` (default 0.05 m) to a primitive it is not joined to
function clearanceCheck(rig, minGap, dest) {
  var mg = minGap == null ? 0.05 : minGap, P = clearancePrims(rig, dest), bad = [], i, j;
  var joinedRoutes = {};                                                   // route-level joins (any segment's end on the other)
  for (i = 0; i < P.length; i++) for (j = 0; j < P.length; j++) {
    if (i === j || !P[i].route || !P[i].isNew) continue;
    if (primJoined(P[i], P[j])) joinedRoutes[P[i].route + '|' + (P[j].route || P[j].id)] = joinedRoutes[(P[j].route || P[j].id) + '|' + P[i].route] = true;
  }
  for (i = 0; i < P.length; i++) {
    if (!P[i].isNew) continue;
    for (j = 0; j < P.length; j++) {
      if (i === j || (P[j].isNew && j < i)) continue;
      var a = P[i], b = P[j];
      if (primJoined(a, b) || joinedRoutes[(a.route || a.id) + '|' + (b.route || b.id)]) continue;
      var g = primGap(a, b); if (g < mg) bad.push({ a:a.id, b:b.id, gap:Math.round(g * 1000) / 1000 });
    }
  }
  return bad;
}
function buildPipes(F, S, nps) {
  var THREE = F.THREE, T = S.T, scene = S.scene, V3 = THREE.Vector3, i, j, rig = S.rig || {};
  if (S.pipes) S.pipes.meshes.forEach(function (m) { scene.remove(m); m.geometry.dispose(); });
  var R = [], glass = [], steel = [], frost = [], dark = [], conc = [];
  for (i = 0; i < ROUTES.length; i++) { var rv = routeRVis(ROUTES[i], nps); R.push({ def:ROUTES[i], rVis:rv, route:routeGeom(ROUTES[i], rv), built:routeBuilt(ROUTES[i], rig) }); }
  var Lh = function (id) { return R[ROUTE_IDX[id]].route.length; }, base = {};
  // shader arc-length bases: D0a + D0b + E2 continue exactly where the v3.3 E2 ran (same aS on every v3.3 vertex)
  base.E1 = 0; base.D0a = Lh('E1') + 0.8; base.D0b = base.D0a + Lh('D0a'); base.E2 = base.D0b + Lh('D0b'); base.E2a = base.E2b = base.E2 + Lh('E2'); base.E3 = base.E3f = base.E2a + Lh('E2a') + 0.4; base.E3o = base.E3 + Lh('E3');
  base.D1 = base.D0b; base.D2 = base.D1 + Lh('D1'); base.DD = base.D2 + 3;
  base.E3c = base.E3b = base.E3o + Lh('E3o'); base.E4a = base.E3c + Lh('E3c') + 14;
  base.E3c1 = base.E3c; base.E3c2 = base.E3c1 + Lh('E3c1') + CK2_BODY[0];             // CK-102 in: E3c1 + body + E3c2 ≈ the E3c run
  base.E4 = Math.max(base.E4a + Lh('E4a'), base.E3b + Lh('E3b')); var so = base.E4 + Lh('E4') + 6;
  base.G1 = so; base.LW = so; base.LO = so; base.BLK = so; base.LMa = so + Lh('LW'); base.LMb = base.LMa + Lh('LMa'); base.LM2 = base.LMb;
  var lmEnd = base.LMb + Lh('LMb');
  base.VENT = lmEnd + 5; base.VENT2 = base.VENT; base.BLK2 = base.BLK + 4; base.PSV2 = so;
  base.X1 = lmEnd + 5; base.X2 = base.X1 + Lh('X1') + 0.5; base.X0 = base.X2 - 1; base.XA = base.XB = base.X2 + Lh('X2');
  base.DRA = base.DRB = base.XA + Lh('XB') + 3;
  var totalS = 0; for (var k in base) if (R[ROUTE_IDX[k]].built) totalS = Math.max(totalS, base[k] + Lh(k));
  function flangeP(pos, d, r, out) {
    var a = v3add(pos, v3scale(d, -0.031)), b = v3add(pos, v3scale(d, -0.001)), c = v3add(pos, v3scale(d, 0.001)), e = v3add(pos, v3scale(d, 0.031));
    out.push(F.cylAB(a, b, r * 1.55, 20)); out.push(F.cylAB(c, e, r * 1.55, 20));
    if (T.bolts) { var n1 = anyPerp(d), n2 = v3cross(d, n1);
      for (var q = 0; q < 8; q++) { var an = q / 8 * Math.PI * 2, o = v3add(pos, v3add(v3scale(n1, Math.cos(an) * r * 1.3), v3scale(n2, Math.sin(an) * r * 1.3)));
        dark.push(F.cylAB(v3add(o, v3scale(d, -0.07)), v3add(o, v3scale(d, 0.07)), 0.02, 6)); } }
  }
  var dsInB = rigIn(rig, 'desander');
  for (i = 0; i < R.length; i++) {
    var rr = R[i], def = rr.def, rvis = rr.rVis, P = rr.route.prims, b0 = base[def.id] || 0;
    if (!rr.built) continue;                                                           // optional item out: no geometry at all
    if (def.id === 'D0b') {                                                            // one support stand: v3.3 position (x −10.6) unless HV-104 / the tee sit there
      var sx0 = dsInB ? -9.65 : -10.6;
      dark.push(F.boxAt(0.3, 0.02, 0.3, sx0, 0.01, 0)); dark.push(F.boxAt(0.08, 1.2 - rvis - 0.02, 0.08, sx0, (1.2 - rvis) / 2, 0));
      dark.push(F.place(new THREE.TorusGeometry(rvis + 0.02, 0.018, 4, 10, Math.PI), sx0, 1.2, 0, 0, Math.PI / 2, Math.PI));
    }
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
        if (Math.abs(pr.dir[1]) < 0.01 && pr.len > 1.1 && def.id !== 'D0b') {
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
        (def.seg === 2 && def.id !== 'E3b' ? frost : steel).push(tg);
      }
    }
    // flanges at the route ends (nozzle / equipment faces), except at tees
    if (P.length) {
      var f0 = P[0], fl = P[P.length - 1];
      var d0 = f0.type === 'L' ? f0.dir : f0.dIn, d1 = fl.type === 'L' ? fl.dir : fl.dOut;
      var endTee = function (pt) { for (var t = 0; t < TEES.length; t++) if (Math.abs(TEES[t][0] - pt[0]) + Math.abs(TEES[t][1] - pt[1]) + Math.abs(TEES[t][2] - pt[2]) < 0.05) return true;
        for (t = 0; t < CK_JOINTS.length; t++) if (Math.abs(CK_JOINTS[t][0] - pt[0]) + Math.abs(CK_JOINTS[t][1] - pt[1]) + Math.abs(CK_JOINTS[t][2] - pt[2]) < 0.05) return true; return false; };
      if (!endTee(def.pts[0])) flangeP(v3add(def.pts[0], v3scale(d0, 0.04)), d0, rvis, def.seg === 2 ? frost : steel);
      if (!endTee(def.pts[def.pts.length - 1])) flangeP(v3add(def.pts[def.pts.length - 1], v3scale(d1, -0.04)), d1, rvis, steel);
    }
  }
  // PSV-101 discharge header (opaque steel)
  var psv = buildRoute(PSV_ROUTE, pipeRadius(3));
  psv.prims.forEach(function (pr) { if (pr.type === 'L') steel.push(F.cylAB(pr.a, pr.b, pipeRadius(3), T.radP)); else steel.push(new THREE.TubeGeometry(new F.FilletArc(pr), 8, pipeRadius(3) * 1.07, T.radP, false)); });
  TEES.forEach(function (t) {
    if (t[4] && !rigIn(rig, t[4])) return;                                              // optional item out: the line stays plain
    var r = pipeRadius(t[3] === 6 ? nps[2] : t[3] === 4 ? nps[1] : t[3]) * 1.3; steel.push(F.boxAt(r * 2, r * 2, r * 2, t[0], t[1], t[2]));
  });
  var meshes = [];
  var gm = S.pipeGlassMat;
  if (!gm) {
    var su = S.segU = { col:{ value:[] }, colOld:{ value:[] }, alert:{ value:new Array(SEG_SLOTS).fill(0) }, frost:{ value:new Array(SEG_SLOTS).fill(0) }, ph:{ value:new Array(SEG_SLOTS).fill(0) },
      pulse:{ value:0 }, chev:{ value:T.tracers < 600 ? 1 : 0 }, wave:{ value:1e6 } };
    for (i = 0; i < SEG_SLOTS; i++) { su.col.value.push(new THREE.Color(0.6, 0.7, 0.8)); su.colOld.value.push(new THREE.Color(0.6, 0.7, 0.8)); }
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
  // X0 tees into the X2 riser at its elbow (13.4, 0.45, 4.0) and VENT2 into the VENT z-run (13.0, 6.1, 2.3): entry arc lengths
  S.pipes = { meshes:meshes, R:R, tables:tables, base:base, totalS:totalS, npsKey:nps.join(','), sDRBjoin:sJ,
    sX0join:joinS('X2', [13.4, 0.45, 4.0], nps), sVENT2join:joinS('VENT', [13.0, 6.1, 2.3], nps) };
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
    altE:new Int16Array(ROUTES.length), altP:new Float32Array(ROUTES.length),           // probabilistic branch (T-202 dump split)
    lut:new Float32Array(ROUTES.length * 8 * 3), chainEntry:new Int16Array(CHAIN_DEF.length), inited:false };
  // distribute particles over chains ∝ built path length (the multiphase hero chain gets ×1.6 density; DR keeps the remainder)
  var tabs = S.pipes.tables, c, i, rig = S.rig || {};
  var cnts = tracerCounts(nT, chainWeights(rig, function (id) { return tabs[ROUTE_IDX[id]].len; }));
  var k = 0;
  for (c = 0; c < CHAIN_DEF.length; c++) {
    var cnt = cnts[c], edges = chainEdges(c, rig), tl = 0;
    edges.forEach(function (id) { tl += tabs[ROUTE_IDX[id]].len; });
    for (var q = 0; q < cnt && k < nT && edges.length; q++, k++) {
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
  velocity:'ft/s', length:'ft', lengthSmall:'in', percent:'%', gor:'scf/STB', powerLarge:'MMBtu/hr',
  mass:'lb', volumeSmall:'gal', erosionRate:'mpy', erosionDay:'mil/d' };
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
    case 'mass': case 'volumeSmall': return a < 100 ? 1 : 0;
    case 'erosionRate': return 0;
    case 'erosionDay': return a < 10 ? 2 : 1;
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
    return viewFor(name, N.rig, Math.max(W, 2), Math.max(Hh, 2), insets, S && S.dyn.flame ? FLAME_BASE[1] + S.dyn.flame.Lv + 0.8 : null);
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
    el.style.visibility = 'hidden';                 // until the first layout pass places it (no stray label at 0,0 while building)
    el.innerHTML = '<div class="h"><b class="n"></b> <span class="tt"></span> <i class="g"></i></div><div class="v"><span class="s0"></span><u class="u0"></u><span class="ar"></span><span class="s1"></span><u class="u1"></u><span class="rg"></span></div><div class="rows"></div>';
    labelsEl.appendChild(el);
    var q = function (s) { return el.querySelector(s); };
    q('.n').textContent = STEP[id] || ''; q('.tt').innerHTML = TAGS[id] + '<span class="tt2"> · ' + TITLES[id] + '</span>';
    var ch = { id:id, el:el, n:q('.n'), tt2:q('.tt2'), s0:q('.s0'), u0:q('.u0'), ar:q('.ar'), s1:q('.s1'), u1:q('.u1'), rg:q('.rg'), g:q('.g'), rows:q('.rows'),
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
    var el = doc.createElement('div'); el.className = 'wts3d-seg'; el.style.visibility = 'hidden'; labelsEl.appendChild(el);
    segChips.push({ def:sc, el:el, txt:'', st:'ok', w:90, h:18, measure:true, vis:false, x:-999, y:-999, anchor:new V3().fromArray(sc.at), sx:0, sy:0, behind:false, dRel:1, show:false, op:-1 });
  });
  var allChips = chips.concat(segChips);
  var LR = allChips.map(function () { return { w:100, h:40, prio:0, pref:'n', seg:false }; });
  var LA = allChips.map(function () { return { x:0, y:0, hide:true }; });
  var LO = [], LORD = [], LINS = { top:0, bottom:0, left:0, right:0, card:null, obs:null };
  var OBST_NONE = [];
  // rig-up dependent chip state (D17 / D18): step numbers from stepFor(rig) (fallback STEP), the segment-1 chip clears HV-104;
  // optional chips are hidden while their item is out (placeLabels), so they never pick, frame or take a layout slot
  var chipRigSig = null;
  function applyRigChips() {
    var sig = N.rigKey; if (sig === chipRigSig) return; chipRigSig = sig;
    var map = stepFor(N.rig);
    for (var i = 0; i < chips.length; i++) {
      var ch = chips[i], txt = map[ch.id] || STEP[ch.id] || '';
      if (ch.n && ch.n.textContent !== txt) { ch.n.textContent = txt; ch.measure = true; }
      if (OPT[ch.id] && !rigIn(N.rig, ch.id)) { ch.lodVis = false; if (selected === ch.id) { selected = null; ch.el.classList.remove('sel'); } }
    }
    for (var j = 0; j < segChips.length; j++) { var sc = segChips[j]; if (sc.def.atDs) sc.anchor.fromArray(rigIn(N.rig, 'desander') ? sc.def.atDs : sc.def.at); }
    labelDirty = true; layoutDirty = true;
  }
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
  function tripTxt(id) { return id === 'LSHH_GT' ? ' (LSHH-301)' : id === 'PUMP_DRYRUN' ? ' (LOW-LOW)' : ''; }
  function vTxt(t) { return t.moving ? (t.inlet ? ' · inlet OPENING ' : ' · inlet CLOSING ') + Math.round(t.pos * 100) + '%' : t.inlet ? ' · inlet open' : ''; }
  function updateLabelText() {
    var n = N, i;
    for (i = 0; i < chips.length; i++) {
      var ch = chips[i], id = ch.id;
      if (OPT[id] && !rigIn(n.rig, id)) continue;                                        // optional item out: chip hidden (D18)
      var st = statusForEq(n.alarms, id);
      if (st !== ch.st) { if (st === 'alarm' && ch.st !== 'alarm' && !reducedMotion) { ch.flashT = now(); ch.el.classList.add('flash'); } ch.st = st; ch.el.setAttribute('data-st', st); layoutDirty = true; }
      setTxt(ch, 'g', ch.g, st === 'alarm' ? '⚠' : st === 'warn' ? '▲' : st === 'hyd' ? '❄' : st === 'evt' ? '●' : '');
      var nd = n.nodes, sp = n.sep, su = n.surge, ga = n.gauge, t2 = ch.t2;
      if (S && S.off && S.off[id]) {                  // out of the rig-up (ghosted in the scene)
        slot(ch, null, null, null, null, null, null, '', id === 'heater' || id === 'separator' ? 'BYPASSED' : 'NOT IN RIG-UP', 'a');
        var toLine = n.sepBy.active && n.sepBy.dest === 'line';                         // v1.3.0: destination of the V-101 bypass
        if (t2) rows(ch, ['Rig-up', id === 'separator' ? (toLine ? 'well stream → production line' : 'well stream → flare / burner') :
          id === 'flare' ? (n.sepBy.vent ? 'tank relief / vent gas → vent' : 'gas → export line') : id === 'pump' ? 'gravity drain' :
          id === 'surge' ? 'dumps → gauge tank / export' : id === 'gauge' ? 'transfer → export / burner' : 'bypass line in use']
          .concat(id !== 'separator' ? [] : toLine ? ['Line P', FV(n.sepBy.P, 'pressureG'), 'Tie-in', 'NRV-501 · XV-501', 'PSHH-104', 'trips SDV-101'] : ['PSHH-104', 'trips SDV-101']));
        continue;
      }
      switch (id) {
        case 'wellhead':
          slot(ch, nd.wellhead.P, 'pressureG', 'P', nd.wellhead.T, 'temperature', 'T');
          if (t2) rows(ch, ['Hydrate T', FV(nd.wellhead.th, 'temperature'), 'Gas', FV(n.inp.Qg * n.f, 'gasRate'), 'Oil', FV(n.inp.Qo * n.f, 'liquidRate'),
            'Water', FV(n.inp.Qw * n.f, 'liquidRate'), 'GOR', n.inp.Qo > 0 ? FV(n.inp.Qg * 1e6 / n.inp.Qo, 'gor') : '—']
            .concat(n.cush.on ? ['Cushion', n.cush.phase + ' · ' + FV(n.cush.rec, 'volume') + ' of ' + FV(n.cush.V, 'volume')] : []));
          break;
        case 'esd': {
          var e = n.esd, closed = e.travel < 0.02, moving = e.travel > 0.02 && e.travel < 0.98;
          if (closed) { slot(ch, nd.wellhead.P, 'pressureG', 'P', nd.esd.P, 'pressureG', 'P', ' / ', e.manual ? 'CLOSED · MANUAL' : (e.tripped ? 'TRIPPED' : 'CLOSED'), e.manual ? 'a' : 'l'); }
          else slot(ch, nd.esd.P, 'pressureG', 'P', null, null, null, '', moving ? 'CLOSING ' + Math.round((1 - e.travel) * 100) + '%' : 'OPEN', moving ? 'a' : 'g');
          if (t2) rows(ch, ['Pressure', FV(nd.esd.P, 'pressureG'), 'Travel', Math.round(e.travel * 100) + ' % open', 'Cause', e.causeMsg || '—']);
          break; }
        case 'choke': {
          var c = nd.choke, rg = c.flowLimited ? 'LIMITED' : c.regime === 'Critical' ? 'CRITICAL' : c.regime === 'Subcritical' ? 'SUBCRITICAL' : 'NO FLOW';
          var cFix = c.leg === 'fixed', legT = (cFix ? 'POS ' : 'ADJ ') + Math.round(c.bean) + '/64';     // v1.4.0: in-service leg + its bean
          slot(ch, c.Pin, 'pressureG', 'P', c.P, 'pressureG', 'P', '→', legT + ' · ' + rg, c.flowLimited ? 'l' : c.regime === 'Critical' ? 'c' : 's');
          if (t2) rows(ch, ['In service', (cFix ? 'positive ' : 'adjustable ') + Math.round(c.bean) + '/64″',
            'Standby', cFix ? 'adjustable ' + Math.round(c.beanAdj) + '/64″' : (c.beanFix != null ? 'positive ' + Math.round(c.beanFix) + '/64″' : 'positive'), 'ΔP', FV(c.Pin - c.P, 'pressureG'), 'T out', FV(c.T, 'temperature'), 'J-T ΔT', dT(c.dTjt)].concat(c.hyd ? ['❄', 'HYDRATE RISK'] : []));
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
          slot(ch, flareQ(n), 'gasRate', 'P', nd.flare.P, 'pressureG', 'P', ' · ', flareQ(n) < 0.01 ? 'PILOT' : '', 's');
          setCls(ch.s0, ch.txt, 's0c', 'l');
          if (t2) rows(ch, ['Line P (u/s hdr)', FV(nd.flare.Pline, 'pressureG'), 'Line velocity', Math.round(n.segs[4].vPct) + ' % of limit', 'Flared', FV(n.cum.flare_mmscf, 'gasVolume', 3)]
            .concat(n.sepBy.active && n.sepBy.dest === 'line' ? ['Well stream', 'to the production line (V-101 out)'] : []));
          break;
        case 'heaterChoke': {                           // CK-102 (v1.3.0): inlet (between the chokes) → outlet (H-101 inlet)
          var k2 = nd.heaterChoke, c2 = n.ck2;
          // midcoil (D10, C): the body stays on the inlet stub and the label says where it is in the process ("between passes")
          var tt2 = c2.pos === 'midcoil' ? ' · HEATER CHOKE (BETWEEN PASSES)' : ' · ' + TITLES.heaterChoke;
          if (ch.tt2 && ch.txt.tt2 !== tt2) { ch.txt.tt2 = tt2; ch.tt2.textContent = tt2; ch.measure = true; }
          if (c2.bypassed) slot(ch, null, null, null, null, null, null, '', 'BYPASSED', 'a');
          else {
            var rg2 = c2.active && k2.flowLimited && c2.limiter !== 'CK-101' ? 'LIMITING' : k2.regime === 'Critical' ? 'CRITICAL' : k2.regime === 'Subcritical' ? 'SUBCRITICAL' :
              k2.regime === 'No Flow' ? 'NO FLOW' : 'IN LINE';
            slot(ch, k2.Pin, 'pressureG', 'P', k2.P, 'pressureG', 'P', '→', rg2, rg2 === 'LIMITING' ? 'l' : rg2 === 'CRITICAL' ? 'c' : 's');
          }
          if (t2) rows(ch, c2.bypassed ? ['Line-up', 'bypassed with H-101', 'Bean', k2.bean > 0 ? Math.round(k2.bean) + '/64″' : '—'] :
            ['Bean', k2.bean > 0 ? Math.round(k2.bean) + '/64″' : '—', 'Position', c2.pos === 'midcoil' ? 'between passes' : 'H-101 inlet',
              'ΔP', FV(k2.Pin - k2.P, 'pressureG'), 'T out', FV(k2.T, 'temperature'), 'J-T ΔT', dT(k2.dTjt), 'Limiter', c2.limiter || '—',
              'PAH-102', FV(0.9 * c2.designP, 'pressureG') + ' (90 % of design)'].concat(k2.hyd ? ['❄', 'HYDRATE RISK'] : []).concat(c2.note ? ['Note', c2.note] : []));
          break; }
        case 'surge':
          slot(ch, su.frac * 100, 'percent', 'L', su.P, 'pressureTank', 'P', ' · ', su.blocked ? 'IN BLOCKED' : 'IN ' + inletTxt(su.comps[0].inlet, su.comps[1].inlet), su.blocked ? 'l' : 's');
          if (t2) { var fill = n.lines.sep_oil.q + n.lines.sep_water.q - su.pump_q;
            rows(ch, ['A · B', Math.round(su.comps[0].frac * 100) + ' % · ' + Math.round(su.comps[1].frac * 100) + ' %', 'Volume', FV(su.Vo_bbl + su.Vw_bbl, 'volume'),
              'LCV-201', su.pumpFailed ? 'STUCK SHUT' : su.pumpTripped ? 'TRIPPED' + tripTxt(su.pumpTrip) : su.pumpBlocked ? 'BLOCKED' : su.pumpOn ? (su.xferLowDP ? 'OPEN · LOW ΔP' : 'OPEN') : 'SHUT',
              'Suction', su.suction === 'both' ? 'A + B' : su.suction, 'Auto-divert', su.autoOn ? 'ON' : 'OFF', 'Net fill', FV(fill, 'liquidRate'),
              'Time to HH', su.tFull_s >= 0 ? fmtNum(su.tFull_s / 60, 0) + ' min' : '—']); }
          break;
        case 'pump': {                                  // P-201: gauge tank → export / burner
          var pst = ga.pumpMode === 'none' ? 'OUT' : ga.pumpFailed ? 'FAILED' : ga.pumpOn ? 'RUNNING' : 'STANDBY';
          slot(ch, null, null, null, ga.pump_q, 'liquidRate', 'L', '', pst, ga.pumpOn && !ga.pumpFailed ? 'g' : (ga.pumpFailed ? 'l' : 's'));
          if (t2) rows(ch, ['Service', 'T-301 → export / burner', 'Surge transfer', 'LCV-201 (no pump)']);
          break; }
        case 'gauge':
          slot(ch, ga.tanks[0].Vo_bbl + ga.tanks[0].Vw_bbl, 'volume', 'L', ga.tanks[1].Vo_bbl + ga.tanks[1].Vw_bbl, 'volume', 'L', ' · ',
            ga.blocked ? 'IN BLOCKED' : inletTxt(ga.tanks[0].inlet, ga.tanks[1].inlet) + ' FILLING', ga.blocked ? 'l' : 's');
          if (t2) rows(ch, ['A', ga.tanks[0].state + vTxt(ga.tanks[0]), 'B', ga.tanks[1].state + vTxt(ga.tanks[1]),
            'Auto-divert', ga.autoOn ? 'ON' : 'OFF', 'Last batch', ga.lastRate >= 0 ? FV(ga.lastRate, 'liquidRate') + ' (STB/d)' : '—',
            'BS&W', ga.lastBsw >= 0 ? fmtNum(ga.lastBsw, 1) + ' %' : '—']);
          break;
        case 'desander': {                              // DS-101: inlet → outlet (= choke inlet), ΔP / dump state / accumulator
          var ds = n.ds, dsg;
          if (ds.phase === 'held') dsg = ['HELD', 'a'];
          else if (ds.phase !== 'idle') dsg = ['DUMPING', 'h'];
          else if (ds.accFrac >= ds.lahh) dsg = ['SAND HIGH', 'l'];
          else if (ds.bypass) dsg = ['BYPASSED', 'a'];
          else if (n.sand.on) dsg = ['SAND ' + Math.round(ds.accFrac * 100) + ' %', ds.accFrac >= ds.lah ? 'a' : 's'];
          else dsg = ['ΔP ' + FV(ds.dP, 'pressureG'), 's'];
          slot(ch, ds.Pin, 'pressureG', 'P', ds.Pout, 'pressureG', 'P', '→', dsg[0], dsg[1]);
          if (t2) {
            var mp = P(ds.inLbd, 'mass');
            rows(ch, ['ΔP', FV(ds.dP, 'pressureG'), 'Accumulator', Math.round(ds.accFrac * 100) + ' %', 'Sand caught', FV(ds.accLb, 'mass'),
              'Sand rate', n.sand.on ? mp.v + ' ' + mp.u + '/d' : '—', 'Capture', n.sand.on || ds.eff > 0 ? Math.round(ds.eff * 100) + ' %' : '—',
              'Last dump', ds.lastT >= 0 ? 'T+' + fmtClockLocal(ds.lastT) : '—', 'Bypass', ds.bypass ? 'ON (HV-104)' : 'OFF',
              'Auto-dump', ds.autoOn ? (ds.autoBlocked ? 'BLOCKED' : 'ON · ' + Math.round(ds.autoSp * 100) + ' %') : 'OFF']
              .concat(ds.phase !== 'idle' ? ['Dump', ds.phase === 'held' ? 'held (' + (ds.heldFrom || '—') + ')' : ds.phase + ' · ' + fmtNum(ds.leftS / 60, 0) + ' min left'] : []));
          }
          break; }
        case 'surge2': {                                // T-202: level · pressure, inlet XV-202
          var u2 = n.surge2, inl = u2.moving ? (u2.inlet ? 'IN OPENING ' : 'IN CLOSING ') + Math.round(u2.pos * 100) + '%' : u2.inlet ? 'IN OPEN' : 'IN SHUT';
          slot(ch, u2.frac * 100, 'percent', 'L', u2.P, 'pressureTank', 'P', ' · ', inl, u2.moving ? 'a' : u2.inlet ? 'g' : 's');
          if (t2) rows(ch, ['Volume', FV(u2.Vo_bbl + u2.Vw_bbl, 'volume'), 'XV-202', u2.moving ? 'TRAVELLING' : u2.inlet ? 'OPEN' : 'SHUT',
            'LCV-202', u2.xFailed ? 'STUCK SHUT' : u2.xTripped ? 'TRIPPED' : u2.xBlocked ? 'BLOCKED' : u2.xOn ? (u2.xLowDP ? 'OPEN · LOW ΔP' : 'OPEN') : 'SHUT',
            'Share of dumps', Math.round(u2.share * 100) + ' %', 'Time to HH', u2.tFull_s >= 0 ? fmtNum(u2.tFull_s / 60, 0) + ' min' : '—']);
          break; }
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
      if (OPT[c2.id] && !rigIn(N.rig, c2.id)) { off = true; c2.lodVis = false; abn = false; isSel = false; }   // hidden while out (D18)
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
    var OBST = S ? S.obst : OBST_NONE;                         // filtered by the rig-up (T-202 box only while it is in)
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
    if (!S) return;
    var cp = camera.position, cpa = [cp.x, cp.y, cp.z], PX = S.proxies;
    for (var i = 0; i < chips.length; i++) {
      var ch = chips[i], occ = occludedFrom(cpa, [ch.anchor.x, ch.anchor.y, ch.anchor.z], ch.id, PX);
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
  var colSand = new THREE.Color(PALETTE.sandTracer);
  var PHA = [0.7, 0.9, 0.85, 0.9], PHS = [0.05, 0.075, 0.07, 0.06], _rgb = [0, 0, 0];             // phase 3 = sand (XV-103 dump)
  var pRange = { min:0, max:3000 }, tRange = { min:0, max:200 };
  var K = { jet:new THREE.Color('#cfe8ff'), watT:new THREE.Color(PALETTE.waterTracer), mist:new THREE.Color(PALETTE.mist), watS:new THREE.Color(PALETTE.waterSurface),
    ok:new THREE.Color(PALETTE.ok), warn:new THREE.Color(PALETTE.warn), alarm:new THREE.Color(PALETTE.alarm), accent:new THREE.Color(PALETTE.accent), hyd:new THREE.Color('#a5d6ff'),
    lampF:new THREE.Color('#ff3b30'), lampOn:new THREE.Color('#3fb950'), lampT:new THREE.Color('#d29922'), lampOff:new THREE.Color('#2b1a1a'), flagO:new THREE.Color('#f0883e'), flagW:new THREE.Color('#dfe6ee'),
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
  // CK-101 leg slots 14–17 (v1.4.0): 'look' = colour + alert + chevron phase (after the main slots each frame), 'frost' = frost
  // (after the CK-101 frost ramp). The standby leg keeps its last phase (no chevron motion) and shows the isolated colour
  function updateCkLegSlots(su, leg, what) {
    for (var sl = 14; sl < SEG_SLOTS; sl++) {
      var c = ckLegSlot(sl, leg);
      if (what === 'frost') { su.frost.value[sl] = c.live ? su.frost.value[c.src] : 0; continue; }
      if (c.live) { su.col.value[sl].copy(su.col.value[c.src]); su.alert.value[sl] = su.alert.value[c.src]; su.ph.value[sl] = su.ph.value[c.src]; }
      else { su.col.value[sl].copy(K.phaseSeg[12]); su.alert.value[sl] = 0; }
    }
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

  var _sr = { g:0, o:0, w:0 };
  function edgeState() {
    var tr = S.tr, n = N, i, L = n.lines, sg = n.segs;
    var byp = n.nodes.heater.bypass, gAct = L.surge_gauge.tank, gIn = n.gauge.tanks;
    var ckB = n.nodes.choke.leg === 'fixed', dsIn = !!S.rigIn.desander, dsLine = dsIn && !n.ds.bypass, u2In = !!S.rigIn.surge2, built = S.pipes.R;
    for (i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i], v = 0, act = false;
      if (r.seg >= 0) { v = sg[r.seg].vel; }
      switch (r.id) {
        case 'E1': act = L.wh_esd.active; break; case 'E2': act = L.esd_choke.active; break;
        case 'E2a': act = L.esd_choke.active && !ckB; break; case 'E2b': act = L.esd_choke.active && ckB; break;     // CK-101 legs (v1.4.0)
        case 'D0a': act = L.esd_choke.active; break; case 'D0b': act = L.esd_choke.active && !dsLine; break;
        case 'D1': case 'D2': act = L.esd_choke.active && dsLine; break;
        case 'DD': v = Math.max(L.ds_dump.vel, L.ds_dump.active ? 0.8 : 0); act = L.ds_dump.active; break;
        case 'LMa': v = L.sep_water.vel + L.sep_oil.vel; act = L.sep_water.active || L.sep_oil.active; break;
        case 'LMb': v = L.sep_water.vel + L.sep_oil.vel; act = (L.sep_water.active || L.sep_oil.active) && !(u2In && n.surge2.route === 'surge2'); break;
        case 'LM2': v = L.sep_surge2.vel; act = L.sep_surge2.active; break;
        case 'X0': v = L.surge2_gauge.vel; act = L.surge2_gauge.active; break;
        case 'VENT2': v = L.surge2_vent.vel; act = L.surge2_vent.active; break;
        case 'BLK2': v = L.blanket2.vel; act = L.blanket2.active; break;
        case 'PSV2': v = Math.max(L.psv_surge2.vel, L.psv_surge2.active ? 3 : 0); act = L.psv_surge2.active; break;
        case 'E3': act = L.choke_heater.active && !ckB; break; case 'E3f': act = L.choke_heater.active && ckB; break;
        case 'E3o': act = L.choke_heater.active; break; case 'E3c': case 'E3c1': case 'E3c2': act = L.choke_heater.active && !byp; break;
        case 'E3b': act = L.choke_heater.active && byp; break;
        case 'E4a': act = L.heater_sep.active && !byp; break; case 'E4': act = L.heater_sep.active; break;
        case 'G1': act = L.sep_flare.active; break;
        case 'LW': v = L.sep_water.vel; act = L.sep_water.active; break; case 'LO': v = L.sep_oil.vel; act = L.sep_oil.active; break;
        case 'BLK': v = L.blanket.vel; act = L.blanket.active; break; case 'VENT': v = L.surge_vent.vel; act = L.surge_vent.active; break;
        case 'X1': case 'X2': act = L.surge_gauge.active; break; case 'XA': act = L.surge_gauge.active && gIn[0].inlet; break; case 'XB': act = L.surge_gauge.active && gIn[1].inlet; break;
        case 'DRA': v = L.gauge_drain.vel; act = L.gauge_drain.active; break; case 'DRB': v = L.gauge_drain.vel; act = L.gauge_drain.active && L.gauge_drain.tank === 1; break;
      }
      if (!built[i].built) act = false;                                                 // optional item out: no tracer on its lines
      var vs = velToScene(v); if (vs <= 0) act = false;
      tr.edgeV[i] = vs; tr.edgeAct[i] = act ? 1 : 0; tr.nextE[i] = -1; tr.nextS[i] = 0; tr.altE[i] = -1; tr.altP[i] = 0;
    }
    var I = ROUTE_IDX;
    tr.nextE[I.E1] = I.D0a; tr.nextE[I.D0a] = dsLine ? I.D1 : I.D0b; tr.nextE[I.D1] = I.D2; tr.nextE[I.D2] = I.E2; tr.nextE[I.D0b] = I.E2;
    var ck2B = !!S.rigIn.heaterChoke;                                                   // CK-102 in: E3 → E3c1 → (body) → E3c2 → E4a
    tr.nextE[I.E2] = ckB ? I.E2b : I.E2a; tr.nextE[I.E2a] = I.E3; tr.nextE[I.E2b] = I.E3f; tr.nextE[I.E3] = I.E3o; tr.nextE[I.E3f] = I.E3o;   // in-service leg only
    tr.nextE[I.E3o] = byp ? I.E3b : (ck2B ? I.E3c1 : I.E3c); tr.nextE[I.E3c] = I.E4a; tr.nextE[I.E4a] = I.E4; tr.nextE[I.E3b] = I.E4;
    tr.nextE[I.E3c1] = I.E3c2; tr.nextE[I.E3c2] = I.E4a;
    tr.nextE[I.LW] = I.LMa; tr.nextE[I.LO] = I.LMa; tr.nextE[I.LMa] = I.LMb; tr.nextE[I.X1] = I.X2; tr.nextE[I.X2] = (gIn[1].inlet && (!gIn[0].inlet || gAct === 1)) ? I.XB : I.XA;
    if (u2In && L.sep_surge2.active) {                                                  // dump header split by the engine shares (route 'both')
      if (!tr.edgeAct[I.LMb]) tr.nextE[I.LMa] = I.LM2; else { tr.altE[I.LMa] = I.LM2; tr.altP[I.LMa] = n.surge2.share; }
    }
    tr.nextE[I.X0] = S.rigIn.gauge ? I.X2 : -1; tr.nextS[I.X0] = S.pipes.sX0join;   // gauge out: X0 ends at the tee (export spool) tr.nextE[I.VENT2] = I.VENT; tr.nextS[I.VENT2] = S.pipes.sVENT2join;
    tr.nextE[I.DRB] = I.DRA; tr.nextS[I.DRB] = S.pipes.sDRBjoin;
    for (i = 0; i < CHAIN_DEF.length; i++) tr.chainEntry[i] = I[CHAIN_DEF[i].entry];
    tr.chainEntry[7] = L.gauge_drain.tank === 1 ? I.DRB : I.DRA;
    // multiphase display fractions (upstream vs downstream of the choke)
    // (v1.3.0) while a cushion unloads the well stream is the cushion water plus a little gas, the formation liquids join at
    // breakthrough: the multiphase colour follows (no geometry for the cushion, §8.1)
    var sr = streamRates(n, _sr);
    dispFrac(phaseFractions(sr.g, sr.o, sr.w, sg[0].P0, sg[0].T0, fr), frUp);
    dispFrac(phaseFractions(sr.g, sr.o, sr.w, sg[2].P0, sg[2].T0, fr), frDn);
    var qo = n.inp.Qo, qw = n.inp.Qw; frLiq.g = 0; frLiq.o = qo + qw > 0 ? (0.15 + 0.7 * qo / (qo + qw)) : 1; frLiq.w = qo + qw > 0 ? (0.15 + 0.7 * qw / (qo + qw)) : 0;
    var sL = frLiq.o + frLiq.w; frLiq.o /= sL; frLiq.w /= sL;
    // per-edge overlay colour LUT (8 samples along each edge)
    if (overlay !== 'phase') for (i = 0; i < ROUTES.length; i++) {
      var r2 = ROUTES[i], P0 = n.sep.P, P1 = n.sep.P, T0 = n.sep.T, T1 = n.sep.T, vp = 0;
      if (r2.seg >= 0) { P0 = sg[r2.seg].P0; P1 = sg[r2.seg].Pout; T0 = sg[r2.seg].T0; T1 = sg[r2.seg].Tout; vp = sg[r2.seg].vPct; }
      if (r2.id === 'G1') { P0 = n.sep.P; P1 = n.nodes.flare.P; }
      if (r2.id === 'LW' || r2.id === 'LO' || r2.id === 'BLK') { P0 = n.sep.P; P1 = n.surge.P; vp = tr.edgeV[i] > 0 ? (r2.id === 'LW' ? L.sep_water.vel : L.sep_oil.vel) * 10 : 0; }
      if (r2.id === 'LMa' || r2.id === 'LMb') { P0 = P1 = n.surge.P; T0 = T1 = n.surge.T; vp = (L.sep_water.vel + L.sep_oil.vel) * 10; }
      if (r2.id === 'VENT') { P0 = n.surge.P; P1 = n.nodes.flare.P; T0 = T1 = n.surge.T; }
      if (r2.id === 'DRA' || r2.id === 'DRB') { P0 = P1 = 0; T0 = T1 = n.surge.T; vp = L.gauge_drain.vel * 10; }
      if (r2.id === 'LM2') { P0 = n.sep.P; P1 = n.surge2.P; T0 = T1 = n.surge2.T; vp = L.sep_surge2.vel * 10; }
      if (r2.id === 'X0') { P0 = n.surge2.P; P1 = 0; T0 = T1 = n.surge2.T; vp = L.surge2_gauge.vel * 10; }
      if (r2.id === 'VENT2' || r2.id === 'PSV2') { P0 = n.surge2.P; P1 = n.nodes.flare.P; T0 = T1 = n.surge2.T; }
      if (r2.id === 'BLK2') { P0 = n.sep.P; P1 = n.surge2.P; }
      if (r2.id === 'DD') { P0 = n.ds.Pacc; P1 = 0; T0 = T1 = n.nodes.esd.T; vp = L.ds_dump.active ? 20 : 0; }
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
          if (tr.altP[e] > 0 && rnd() < tr.altP[e]) nx = tr.altE[e];            // T-202 dump split (only drawn while the split exists)
          tr.s[i] = tr.nextS[e] + ov; e = nx;                                   // nextS[from] = entry offset on the next edge (DRB tees into DRA)
          if (e === ROUTE_IDX.E3 || e === ROUTE_IDX.E3f) tr.ph[i] = ph = pickPhase(ch, e, rnd());       // re-roll across the choke
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
      if (overlay === 'phase') { var cc = ph === 0 ? colGas : ph === 1 ? colOil : ph === 3 ? colSand : colWat; col[c4] = cc.r; col[c4 + 1] = cc.g; col[c4 + 2] = cc.b; }
      else { var li = (e * 8 + Math.round(clamp(tr.s[i] / Math.max(tb.len, 1e-6), 0, 1) * 7)) * 3; col[c4] = tr.lut[li]; col[c4 + 1] = tr.lut[li + 1]; col[c4 + 2] = tr.lut[li + 2]; }
      col[c4 + 3] = tr.a[i]; sz[i] = PHS[ph];
    }
    tr.pa.needsUpdate = true; tr.ca.needsUpdate = true; tr.za.needsUpdate = true;
  }
  function pickPhase(ch, e, r) {
    var p = CHAIN_DEF[ch].phase;
    if (p === 'gas') return 0; if (p === 'oil') return 1; if (p === 'water') return 2; if (p === 'sand') return 3;
    if (p === 'liquid') return r < frLiq.o ? 1 : 2;
    var I = ROUTE_IDX, up = e === I.E1 || e === I.E2 || e === I.E2a || e === I.E2b || e === I.D0a || e === I.D0b || e === I.D1 || e === I.D2;   // upstream of the choke
    return phasePick(r, up ? frUp : frDn);
  }
  function updateJetEmbersFrost(dt, tNow) {
    var tr = S.tr, base = tr.n, i, pos = tr.pos, col = tr.col, sz = tr.sz, tabs = S.pipes.tables, tb = tabs[N.nodes.choke.leg === 'fixed' ? ROUTE_IDX.E3f : ROUTE_IDX.E3];
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
      var ckL = CK_M.legs[N.nodes.choke.leg === 'fixed' ? 'fixed' : 'adj'], ckAl = 0.25 + (i % 10) * 0.1 + Math.sin(a2) * 0.05, ckAc = Math.sin(a2 * 1.7) * 0.2;
      pos[w * 3] = ckL.c[0] + ckL.dOut[0] * ckAl - ckL.dOut[2] * ckAc; pos[w * 3 + 1] = 1.2 + Math.cos(a2) * 0.2;      // in-service leg, downstream of its choke
      pos[w * 3 + 2] = ckL.c[1] + ckL.dOut[2] * ckAl + ckL.dOut[0] * ckAc;
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
    var lyA = 0.915 + (SM.uA ? SM.uA.x : SM.suF.x) * v.Hint, lyB = 0.915 + (SM.uB ? SM.uB.x : SM.suF.x) * v.Hint;
    var dmp = N.lines.sep_oil.active || N.lines.sep_water.active, inAct = dmp && N.surge.comps[0].inlet, inActB = dmp && N.surge.comps[1].inlet;
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
        // inlet jets: even particles from A's side nozzle (x 9.0, into −X), odd ones from B's (x 11.4, into +X), each on its own level
        var t2 = P.life[i] * 1.5, sB = (i - s0) & 1, lyj = sB ? lyB : lyA, x0j = sB ? 11.3 : 9.1;
        var yx = 4.2 - 0.5 * 9.81 * t2 * t2 * 0.25, xx = x0j + (sB ? -t2 : t2) * 0.9;
        if (yx < lyj) { P.life[i] = r() * 0.1; P.a[i] = r(); yx = 4.2; xx = x0j; }
        P.pos[o2] = xx; P.pos[o2 + 1] = Math.max(yx, lyj); P.pos[o2 + 2] = 4.0 + (P.a[i] - 0.5) * 0.2;
        _c.copy(colOil); P.col[c2] = _c.r; P.col[c2 + 1] = _c.g; P.col[c2 + 2] = _c.b; P.col[c2 + 3] = (sB ? inActB : inAct) && flowGain > 0.05 ? 0.8 : 0; P.sz[i] = 0.05;
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
    // T-202: bubbles + inlet splash (−X side nozzle at y 2.9) while the dumps reach it
    v = S.vesselsById.surge2;
    if (v && v.part) {
      P = v.part; r = P.rnd; s0 = v.partSplit[0];
      var ly2 = v.y0 + SM.t2F.x * v.Hint, in2 = N.lines.sep_surge2.active && flowGain > 0.05;
      for (i = 0; i < P.n; i++) {
        var o4 = i * 3, c4 = i * 4; P.life[i] += dt * flowGain;
        if (i < s0) {
          var y4 = 1.0 + P.life[i] * 0.15;
          if (y4 > ly2 - 0.03 || P.life[i] > 40) { P.life[i] = 0; P.a[i] = r(); P.b[i] = r(); y4 = 1.0; }
          var rr4 = Math.sqrt(P.a[i]) * 0.75, an4 = P.b[i] * 6.283;
          P.pos[o4] = 12.5 + Math.cos(an4) * rr4; P.pos[o4 + 1] = y4; P.pos[o4 + 2] = 2.3 + Math.sin(an4) * rr4;
          P.col[c4] = 0.85; P.col[c4 + 1] = 0.93; P.col[c4 + 2] = 1; P.col[c4 + 3] = ly2 > 1.1 ? 0.22 : 0; P.sz[i] = 0.035;
        } else {
          var t4 = P.life[i] * 1.5, yx4 = 2.9 - 0.5 * 9.81 * t4 * t4 * 0.25, xx4 = 11.65 + t4 * 0.8;
          if (yx4 < ly2) { P.life[i] = r() * 0.1; P.a[i] = r(); yx4 = 2.9; xx4 = 11.65; }
          P.pos[o4] = xx4; P.pos[o4 + 1] = Math.max(yx4, ly2); P.pos[o4 + 2] = 2.0 + (P.a[i] - 0.5) * 0.2;
          _c.copy(colOil); P.col[c4] = _c.r; P.col[c4 + 1] = _c.g; P.col[c4 + 2] = _c.b; P.col[c4 + 3] = in2 ? 0.8 : 0; P.sz[i] = 0.05;
        }
      }
      P.pa.needsUpdate = P.ca.needsUpdate = P.za.needsUpdate = true;
    }
    // DS-101A: sand grains spiralling down from the cone apex onto the sand bed while DS-101 is in line with sand
    v = S.vesselsById.desander;
    if (v && v.part) {
      P = v.part; r = P.rnd;
      var bed = v.y0 + SM.dsA.x * v.Hint, gOn = N.sand.on && N.lines.esd_choke.active && !N.ds.bypass && flowGain > 0.05;
      for (i = 0; i < P.n; i++) {
        var o5 = i * 3, c5 = i * 4; P.life[i] += dt * flowGain * 0.6;
        var y5 = 1.15 - P.life[i] * 0.5;
        if (y5 < bed + 0.02) { P.life[i] = r() * 0.2; P.a[i] = r(); P.b[i] = r(); y5 = 1.15; }
        var an5 = P.b[i] * 6.283 + P.life[i] * 5, rr5 = 0.05 + P.a[i] * 0.22;
        P.pos[o5] = -10.2 + Math.cos(an5) * rr5; P.pos[o5 + 1] = y5; P.pos[o5 + 2] = -1.6 + Math.sin(an5) * rr5;
        P.col[c5] = colSand.r; P.col[c5 + 1] = colSand.g; P.col[c5 + 2] = colSand.b; P.col[c5 + 3] = gOn ? 0.75 : 0; P.sz[i] = 0.03;
      }
      P.pa.needsUpdate = P.ca.needsUpdate = P.za.needsUpdate = true;
    }
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
    // T-202 (one compartment, own gas space) — only while it is in the rig-up
    if (V.surge2) {
      var u2 = N.surge2, t2F = spring('t2F', u2.frac, dt, 0.15, snap), t2W = spring('t2W', Math.min(u2.fracW, u2.frac), dt, 0.15, snap);
      v = V.surge2; U = v.U; var y2 = t2F * v.Hint, y2W = t2W * v.Hint;
      U.uSecA.value.set(t2W < 0.003 ? -1 : y2W, y2); U.uSecB.value.copy(U.uSecA.value);
      U.uTilt.value = slosh(v, y2); U.uPh.value.set(phases.rip, phases.rip2);
      v.alert.value = smoothstep(0.85, 1.0, u2.P / Math.max(u2.pshh, 1));
      surgeCap(v, 0, y2, t2F, t2W);
      var sg2 = S.dyn.surge2 && S.dyn.surge2.sight;
      if (sg2) { var yT2 = clamp(0.915 + y2, sg2.y0, sg2.y1), yW2 = clamp(0.915 + y2W, sg2.y0, sg2.y1);
        sg2.w.position.y = sg2.y0; sg2.w.scale.y = Math.max(1e-3, yW2 - sg2.y0); sg2.w.visible = yW2 > sg2.y0 + 0.001;
        sg2.o.position.y = yW2; sg2.o.scale.y = Math.max(1e-3, yT2 - yW2); sg2.o.visible = yT2 > yW2 + 0.001; }
    }
    // DS-101A accumulator: sand settled at the bottom (sand colour), well fluid above (liquid-full while in service)
    if (V.desander) {
      v = V.desander; U = v.U; var aF = spring('dsA', N.ds.accFrac, dt, 0.3, snap), yA = aF * v.Hint;
      U.uSecA.value.set(aF < 0.003 ? -1 : yA, v.Hint * 0.995); U.uSecB.value.copy(U.uSecA.value); U.uPh.value.set(phases.rip, phases.rip2);
      v.alert.value = N.ds.accFrac >= N.ds.lahh ? 0.6 + 0.4 * Math.sin(phases.beacon * 2) : 0;
    }
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
    capS.scale.set(rc, 1, rc); capS.position.y = (v.y0 != null ? v.y0 : 0.915) + y; capS.visible = f > 0.003; capS.rotation.z = Math.atan(v.U.uTilt.value);
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
    // choke handwheel (spring toward the adjustable bean/64 × 6π) and the CK-101 legs (v1.4.0): the in-service leg's gate
    // handwheels green with the rising stems up, the standby leg's red with the stems down (eased over ~0.4 s)
    var ckd = D.choke, ckn = n.nodes.choke;
    var ang = spring('ckW', clamp(ckn.beanAdj, 0, 128) / 64 * 6 * Math.PI, dt, 0.25, snap); ckd.wheel.rotation.y = ang;
    var lb = ease('ckLeg', ckn.leg === 'fixed' ? 1 : 0, dt, 0.35, snap);
    if (Math.abs(lb - ckd.lb) > 1e-3 || snap) {
      ckd.lb = lb; ckd.wMat[0].color.copy(ckd.open).lerp(ckd.shut, lb); ckd.wMat[1].color.copy(ckd.shut).lerp(ckd.open, lb);
      for (var gi = 0; gi < 2; gi++) { ckd.stems[0][gi].scale.y = Math.max(0.05, 1 - lb); ckd.stems[1][gi].scale.y = Math.max(0.05, lb); }
    }
    // CK-102 (v1.3.0): handwheel turns with bean2; frost on the body while its outlet is in the hydrate region; greyed while
    // bypassed with H-101 (a line-up, not an absence: per-frame material state, never a rebuild)
    var hc = D.heaterChoke, lk = hc ? ck2Look(n) : null;
    if (lk) {
      hc.wheel.rotation.y = spring('ck2W', lk.wheel, dt, 0.25, snap);
      var gz = ease('ck2Grey', lk.grey, dt, 0.4, snap);
      if (Math.abs(gz - hc.grey) > 1e-3 || snap) { hc.grey = gz; for (var mi = 0; mi < hc.mats.length; mi++) hc.mats[mi].color.copy(hc.base[mi]).lerp(hc.greyC, gz); }
      hc.frostU.uFrost.value = snap ? lk.frost : clamp(hc.frostU.uFrost.value + (lk.frost ? dt / 4 : -dt / 4), 0, 1);     // 0 → 1 over 4 s, as CK-101
    }
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
    // P-201 (T-301 → export) coupling + lamp; LCV-201 transfer lamp (green open, amber low ΔP, red tripped / stuck)
    var ga0 = n.gauge, qp = ga0.pump_q, om = 30 * Math.min(1, qp / Math.max(ga0.pump_design, 1));
    D.pump.ang = (D.pump.ang + ease('pumpW', om, dt, 0.6, snap) * dt * (0.2 + 0.8 * flowGain)) % 6.2832; D.pump.coup.rotation.z = D.pump.ang;
    D.pump.lampM.color.copy(ga0.pumpFailed ? K.lampF : (ga0.pumpOn ? K.lampOn : K.lampOff)).multiplyScalar(ga0.pumpFailed ? 1.6 + 0.6 * Math.sin(tNow * 0.012) : 1.2);
    if (D.xfer) {
      var xbad = n.surge.pumpFailed || n.surge.pumpTripped;
      D.xfer.lampM.color.copy(xbad ? K.lampF : (n.surge.pumpOn ? (n.surge.xferLowDP ? K.lampT : K.lampOn) : K.lampOff)).multiplyScalar(xbad ? 1.6 + 0.6 * Math.sin(tNow * 0.012) : 1.2);
    }
    // gauge valves
    var gv = D.gaugeValves, gt = n.gauge.tanks, uc = n.surge.comps;
    // handwheels follow the actual valve position (the sim strokes XV-201/301 over their travel time)
    gv.xvA.rotation.x = spring('xvA', (1 - gt[0].pos) * Math.PI * 3, dt, 0.15, snap); gv.xvB.rotation.x = spring('xvB', (1 - gt[1].pos) * Math.PI * 3, dt, 0.15, snap);
    gv.sxA.rotation.y = spring('sxA', (1 - uc[0].pos) * Math.PI * 3, dt, 0.15, snap); gv.sxB.rotation.y = spring('sxB', (1 - uc[1].pos) * Math.PI * 3, dt, 0.15, snap);
    // lamp status bit-field: bits 0–9 the v3.3 lamps; bits 10–14 the optional items' valve lamps (XV-202 open / travelling,
    // XV-103 open, dump held, HV-104 bypass open) — only set while the item is built, so the default spread keeps the v3.3 value
    var D2 = D.surge2, DS = D.ds, u2s = n.surge2, dss = n.ds;
    var lsig = (gt[0].inlet ? 1 : 0) + (gt[1].inlet ? 2 : 0) + (uc[0].inlet ? 4 : 0) + (uc[1].inlet ? 8 : 0) + (uc[0].suction ? 16 : 0) + (uc[1].suction ? 32 : 0) +
      (gt[0].moving ? 64 : 0) + (gt[1].moving ? 128 : 0) + (uc[0].moving ? 256 : 0) + (uc[1].moving ? 512 : 0) +
      (D2 ? (u2s.inlet ? 1024 : 0) + (u2s.moving ? 2048 : 0) : 0) + (DS ? (dss.open ? 4096 : 0) + (dss.phase === 'held' ? 8192 : 0) + (dss.bypass ? 16384 : 0) : 0);
    if (gv.lampSig !== lsig) {
      gv.lampSig = lsig;
      for (i = 0; i < 6; i++) gv.lamps.setColorAt(i, i < 4 && (lsig >> (i + 6)) & 1 ? K.lampT : (lsig >> i) & 1 ? K.lampOn : (i < 4 ? K.lampF : K.lampOff));   // travelling = amber, inlet shut = red, suction out of service = dark
      if (gv.lamps.instanceColor) gv.lamps.instanceColor.needsUpdate = true;
      if (D2) D2.xvM.color.copy(u2s.moving ? K.lampT : u2s.inlet ? K.lampOn : K.lampF).multiplyScalar(1.2);                      // XV-202
      if (DS) { DS.xvM.color.copy(dss.phase === 'held' ? K.lampT : dss.open ? K.lampOn : K.lampOff).multiplyScalar(1.2);       // XV-103
                DS.hvM.color.copy(dss.bypass ? K.lampT : K.lampOff).multiplyScalar(1.2); }                                         // HV-104 (bypass open = amber)
    }
    // T-202: XV-202 handwheel follows the travel; LCV-202 lamp (green open, amber low ΔP, red tripped / stuck)
    if (D2) {
      D2.xw.rotation.y = spring('xv202', (1 - u2s.pos) * Math.PI * 3, dt, 0.15, snap);
      var x2bad = u2s.xFailed || u2s.xTripped;
      D2.lcM.color.copy(x2bad ? K.lampF : (u2s.xOn ? (u2s.xLowDP ? K.lampT : K.lampOn) : K.lampOff)).multiplyScalar(x2bad ? 1.6 + 0.6 * Math.sin(tNow * 0.012) : 1.2);
    }
    // DS-101: status lamp (green / amber LAH / red LAHH / blue blinking while dumping / amber steady while held), handwheels
    // (HV-104 open and the block valves shut in the bypass line-up), dust at the skip during bleed / flush, sand heap
    if (DS) {
      var stc, stOn = 1;
      if (dss.phase === 'held') stc = K.warn;
      else if (dss.phase !== 'idle') { stc = K.hyd; stOn = phases.beacon % 1 < 0.5 ? 1 : 0.2; }
      else if (dss.accFrac >= dss.lahh) stc = K.alarm; else if (dss.accFrac >= dss.lah) stc = K.warn; else stc = K.ok;
      DS.stM.color.copy(stc).multiplyScalar(0.3 + 1.2 * stOn); DS.stG.material.color.copy(stc); DS.stG.material.opacity = 0.7 * stOn;
      var bypA = spring('dsHV', dss.bypass ? 0 : Math.PI * 3, dt, 0.25, snap), blkA = spring('dsBV', dss.bypass ? Math.PI * 3 : 0, dt, 0.25, snap);
      DS.wO[0].rotation.y = bypA; DS.wO[1].rotation.y = blkA; DS.wO[2].rotation.y = blkA;
      for (i = 0; i < 3; i++) { DS.wO[i].updateMatrix(); DS.wI.setMatrixAt(i, DS.wO[i].matrix); } DS.wI.instanceMatrix.needsUpdate = true;
      var dusty = (dss.phase === 'bleed' || dss.phase === 'flush') && !reducedMotion, sk = DS.skip;
      for (i = 0; i < DS.dust.length; i++) {
        var dp = DS.dust[i], dl = ((tNow * 0.0004 * anim + i / DS.dust.length) % 1);
        dp.position.set(sk[0] + Math.sin(i * 2.1) * 0.2, sk[1] + 0.1 + dl * 1.0, sk[2] + Math.cos(i * 1.7) * 0.15);
        var dsz = 0.4 + dl * 1.0; dp.scale.set(dsz, dsz, 1); dp.material.opacity = dusty ? 0.28 * (1 - dl) : 0;
      }
      DS.heap.scale.y = ease('dsHeap', clamp(n.sand.dumped / 1500, 0.02, 1) * 0.55, dt, 1.5, snap);
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
      else if (k === 'dsIn') { val = n.ds.Pin; rng = dialRanges[0]; } else if (k === 'surge2') { val = n.surge2.P; rng = dialRanges[2]; }
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
      var id = EQ_IDS[i], stq = OPT[id] && !rigIn(n.rig, id) ? 'ok' : statusForEq(n.alarms, id, HALO_OPT), h = hp[id], op = 0, hex = K.accent;
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
    updateCkLegSlots(S.segU, n.nodes.choke.leg, 'frost');     // CK-101 legs: frost only on the in-service downstream leg
    if (D.choke.fu) { var lbF = D.choke.lb < 0 ? 0 : D.choke.lb; D.choke.fu[0].uFrost.value = S.frostU.uFrost.value * (1 - lbF); D.choke.fu[1].uFrost.value = S.frostU.uFrost.value * lbF; }
  }

  // ── flare ───────────────────────────────────────────────────────────────
  var _right = new V3(), _up = new V3(0, 1, 0), _toCam = new V3();
  function updateFlame(dt, tNow, anim) {
    var fl = S.dyn.flame, q = flareQ(N), Lt = flameLength(q);
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
    if (!S) return undefined;
    var ndcX = x / Math.max(W, 1) * 2 - 1, ndcY = 1 - y / Math.max(Hh, 1) * 2;
    var v = new V3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize(), o = [camera.position.x, camera.position.y, camera.position.z], d = [v.x, v.y, v.z];
    return pickRay(o, d, S.proxies, S.valveProxies);              // tables filtered by the rig-up: a hidden item never picks
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
    (S.detached || []).forEach(function (o) {                 // rig-up ghosts: objects taken out of the scene
      var dm = function (m) { if (m && !seen.has(m)) { seen.add(m); try { m.dispose(); } catch (e) {} } };
      if (o && typeof o.traverse === 'function') o.traverse(function (c) { if (c.geometry && !seen.has(c.geometry)) { seen.add(c.geometry); c.geometry.dispose(); } (Array.isArray(c.material) ? c.material : [c.material]).forEach(dm); });
      else if (o) dm(o.material);
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
    S = buildScene(F, renderer, t, env, N.rig, N.sepBy.dest);
    S.renderer = renderer;
    applyRigChips();
    // a rig-up change refits the default view only when the user has not moved the camera (§8.1); a tier change never refits
    if (builtRigSig !== null && builtRigSig !== S.rigKey && W >= 2 && Hh >= 2) {
      fitR = viewFor('overview', N.rig, W, Hh, insets).r;
      var to = rigRefitView(userMoved, N.rig, W, Hh, insets, defaultView()); if (to) startTween(to, 0.5);
    }
    builtRigSig = S.rigKey;
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
  var lastNps = null, builtRigSig = null;
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
      // rig-up changed (or, with V-101 out, the destination): rebuild with ghosts / bypasses; the CK-102 "bypassed" grey is per frame
      if (S && !rebuilding && !paused && !lost && N.rigKey !== S.rigKey) rebuildTier(tier);
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
      for (var ni = 0; ni < NODE_NAMES.length; ni++) { if (OPT[NODE_NAMES[ni]] && !rigIn(N.rig, NODE_NAMES[ni])) continue;
        var nd = N.nodes[NODE_NAMES[ni]]; pmin = Math.min(pmin, nd.P); pmax = Math.max(pmax, nd.P, nd.Pin); tmin = Math.min(tmin, nd.T); tmax = Math.max(tmax, nd.T); }
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
      updateCkLegSlots(su, N.nodes.choke.leg, 'look');
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
    if (S && S.segU) { for (var i = 0; i < SEG_SLOTS; i++) S.segU.colOld.value[i].copy(S.segU.col.value[i]); S.segU.wave.value = 0; }
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
    var f = FOCUS[id]; if (!f || !optIn(N.rig, id)) return; markInput(); userMoved = true;
    var th = cam.th, d = ((th + 18 * Math.PI / 180) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (Math.abs(d) > Math.PI / 3) th = -18 * Math.PI / 180;
    if (FOCUS_TH[id] != null) th = FOCUS_TH[id] * Math.PI / 180;
    startTween({ tgt:f[0], r:f[1], th:th, ph:clamp(cam.ph, 0.95, 1.3) }, 0.9);
  });
  H.select = guard(function (id) { selected = id && EQ_IDS.indexOf(id) >= 0 && optIn(N.rig, id) ? id : null; labelDirty = true; layoutDirty = true;
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
  PALETTE:PALETTE, STATUS_MAP:STATUS_MAP, FIT_BOX:FIT_BOX, PROCESS_BOX:PROCESS_BOX, FIT_PTS:FIT_PTS, V101_BOX:V101_BOX, PROXIES:PROXIES, VALVE_PROXIES:VALVE_PROXIES, ROUTES:ROUTES, CK_LEG_SLOTS:CK_LEG_SLOTS, CK_M:CK_M, CK_JOINTS:CK_JOINTS, SEG_SLOTS:SEG_SLOTS, ckLegSlot:ckLegSlot,
  TIERS:TIERS, VIEWS:VIEWS, FOCUS:FOCUS, FOCUS_TH:FOCUS_TH, STEP:STEP, NULLABLE:NULLABLE, ANCHORS:ANCHORS, CHAIN_DEF:CHAIN_DEF,
  pipeRadius:pipeRadius, buildRoute:buildRoute, routeLength:routeLength, routeSample:routeSample,
  capHalfWidth:capHalfWidth, vertCapRadius:vertCapRadius, vesselProfile:vesselProfile, oilColor:oilColor, velToScene:velToScene,
  flameLength:flameLength, phaseFractions:phaseFractions, niceRange:niceRange, pickTier:pickTier, lodForDistance:lodForDistance,
  layoutLabels:layoutLabels, statusForEq:statusForEq, normalize:normalize, makeNorm:makeNorm, fakeSnapshot:fakeSnapshot,
  colormap:colormap, colormapRGB:colormapRGB, fitRadius:fitRadius, fitView:fitView, project:project, camDir:camDir,
  boxCorners:boxCorners, luminance:luminance, mixHex:mixHex, dpFor:dpFor, defFmtParts:defFmtParts,
  RIG_GROUPS:RIG_GROUPS, BYPASS_SPOOLS:BYPASS_SPOOLS, rigSigOf:rigSigOf, EQ_BOX:EQ_BOX, TEES:TEES,
  // v1.2.0 — optional rig-up items DS-101 / T-202 (docs/SIM-EQUIPMENT-PLAN.md §8.0–8.1)
  EQ_IDS:EQ_IDS, OPT:OPT, TAGS:TAGS, TITLES:TITLES, PREF_SIDE:PREF_SIDE, HALO:HALO, BLOBS:BLOBS, BLOBS_OPT:BLOBS_OPT, OBST_BOXES:OBST_BOXES,
  NOZZLES:NOZZLES, NEW_ROUTES:NEW_ROUTES, PSV_ROUTE:PSV_ROUTE, FIT_OPT:FIT_OPT, MUSHROOM:MUSHROOM, PAD_RECT:PAD_RECT, SEG_CHIPS:SEG_CHIPS,
  LINE_NAMES:LINE_NAMES, NODE_NAMES:NODE_NAMES, IMP_UNITS:IMP_UNITS, STEP_ORDER:STEP_ORDER, DEF_NPS:DEF_NPS,
  rigIn:rigIn, optIn:optIn, fitPts:fitPts, rigProxies:rigProxies, rigValveProxies:rigValveProxies, rigObst:rigObst, rigEqIds:rigEqIds, rigBlobs:rigBlobs,
  viewBox:viewBox, viewFor:viewFor, rigRefitView:rigRefitView, pickRay:pickRay, occludedFrom:occludedFrom, rayBox:rayBox,
  valveOf:valveOf, proxyEq:proxyEq, stepFor:stepFor, routeBuilt:routeBuilt, routeRVis:routeRVis, joinS:joinS, routeLenFn:routeLenFn,
  chainEdges:chainEdges, chainWeights:chainWeights, tracerCounts:tracerCounts,
  PROPS:PROPS, EXTRA_PIPES:EXTRA_PIPES, OPT_PRIMS:OPT_PRIMS, clearancePrims:clearancePrims, clearanceCheck:clearanceCheck, primGap:primGap,
  // v1.3.0 — CK-102 heater inlet choke, bypass destination, cushion (docs/SIM-FOLLOWUP-PLAN.md §8.1)
  OPT_IDS:OPT_IDS, CK2_AT:CK2_AT, CK2_BODY:CK2_BODY, LINE_SPOOL:LINE_SPOOL, TAG_PTS:TAG_PTS, SPOOL_PRIMS:SPOOL_PRIMS, rigKeyOf:rigKeyOf,
  fakeCushion:fakeCushion, CUSH_PHASES:CUSH_PHASES, ck2Look:ck2Look, streamRates:streamRates, flareQ:flareQ, flameLength:flameLength
};
WTS_3d.version = VERSION;
WTS_3d.THREE_URLS = ['https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js',
                     'https://unpkg.com/three@0.170.0/build/three.module.min.js'];
// base64 SHA-384 of three@0.170.0/build/three.module.min.js (691,648 bytes; identical on jsDelivr and unpkg)
WTS_3d.THREE_SHA384 = 'IDC7sAMAIMB/TZ6dgKKPPAKZ2bXXXP8+FBMBC8cU319eBhKITx+PaalhfDkDNH28';
WTS_3d.isSupported = isSupported;
WTS_3d.loadThree = loadThree;
WTS_3d.hasLocalCopy = hasLocalCopy;
WTS_3d.loaderPolicy = function (env) { return loaderPolicy(env || _policyEnv()); };
WTS_3d.loadInfo = function () { return _loadInfo ? Object.assign({}, _loadInfo) : null; };
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
  var I = W._internals, pass = 0, total = 19, fails = [];
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
    // v1.2.0 / v1.3.0: eleven nodes (CK-102 appended), optional items out on an empty / older snapshot, in when the snapshot says so;
    // the 3D rigSig has 9 characters (RIG_GROUPS + heaterChoke)
    var e = I.normalize(I.fakeSnapshot(5, { desander:true, surge2:true, flushing:true }), I.makeNorm()), bad2 = walk(e, '', []);
    ok(6, !bad2.length && I.NODE_NAMES.length === 11 && a.rig.desander === false && a.rig.surge2 === false && a.rigSig === '111111000' && isFinite(a.nodes.desander.P) &&
      isFinite(a.nodes.surge2.P) && c.rigSig === '111111000' && e.rig.desander === true && e.rig.surge2 === true && e.rigSig === '111111110' && e.ds.inRig && e.ds.dP > 0 &&
      e.ds.phase === 'flush' && e.ds.open === true && e.surge2.inRig && e.surge2.frac > 0 && e.nodes.esd.P > e.nodes.choke.Pin, bad2.join(','));
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
    [0, 5000, 20000].forEach(function (tt) { walk(I.fakeSnapshot(tt, { desander:true, surge2:true, flushing:true }), ''); walk(I.fakeSnapshot(tt, { desander:true, held:true }), ''); });
    [0, 5000].forEach(function (tt) { walk(I.fakeSnapshot(tt, { heaterChoke:true }), ''); walk(I.fakeSnapshot(tt, { heaterChoke:true, bypass:true }), '');
      walk(I.fakeSnapshot(tt, { sepOut:true, dest:'line', P:300, flareOut:true, cushion:'unloading' }), ''); walk(I.fakeSnapshot(tt, { cushion:'tail' }), ''); });
    var se = I.fakeSnapshot(20000, { desander:true, surge2:true });
    ok(11, se.rigup.sig === '11111111110' && se.desander.dump.lastT !== null && se.surge2.tFull_s !== undefined && typeof se.lines.ds_dump.vel === 'number' &&
      I.LINE_NAMES.every(function (k) { return se.lines[k] && typeof se.lines[k].q === 'number'; }) && I.fakeSnapshot(5).rigup.sig === '11111111000' &&
      I.fakeSnapshot(5, { heaterChoke:true, sepOut:true, dest:'line', flareOut:true }).rigup.sig === '11101110001', 'equipment paths');
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
    // v1.2.0: the same gates with each of the four optional combinations; both out = the v3.3 fit set exactly
    var gbad = [];
    [{}, { desander:true }, { surge2:true }, { desander:true, surge2:true }].forEach(function (rig) {
      var fvr = I.fitView(I.fitPts(rig), OV.az, OV.el, 36, 1380, 700, { top:98, bottom:76, left:0, right:0, card:null }), sr = sizeOf(I.V101_BOX, fvr, 1380, 700);
      var vp = I.viewFor('process', rig, 375, 471, { top:0, bottom:0, left:0, right:0, card:null }), dpv = I.camDir(-10, 30);
      var spr = sizeOf(I.V101_BOX, { az:-10, el:30, radius:vp.r, target:vp.tgt }, 375, 471);
      if (!(sr.h >= 55 && sr.w >= 170 && spr.h >= 22 && dpv)) gbad.push(JSON.stringify(rig) + ' ' + Math.round(sr.h) + 'x' + Math.round(sr.w) + '/' + Math.round(spr.h));
    });
    ok(13, !gbad.length && I.fitPts({}) === I.FIT_PTS, gbad.join(';'));
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
  // 15 (v1.3.0) CK-102 tables: E3c1 + E3c2 replace E3c only while CK-102 is in; the body sits between their ends; the scene key
  // carries the destination only with V-101 out; a bypassed CK-102 stays in the scene (greyed), not hidden
  t(15, function () {
    var R = {}; I.ROUTES.forEach(function (r) { R[r.id] = r; });
    var e3 = R.E3c.pts, a = R.E3c1.pts, b = R.E3c2.pts, B = I.CK2_AT, H = I.CK2_BODY[0] / 2;
    var line = near(a[a.length - 1][0], B[0] - H, 1e-12) && near(b[0][0], B[0] + H, 1e-12) && JSON.stringify(a.slice(0, 4)) === JSON.stringify(e3.slice(0, 4)) &&
      JSON.stringify(b[b.length - 1]) === JSON.stringify(e3[e3.length - 1]) && a[a.length - 1][1] === B[1] && b[0][2] === B[2];
    var built = I.routeBuilt(R.E3c, {}) && !I.routeBuilt(R.E3c1, {}) && !I.routeBuilt(R.E3c, { heaterChoke:true }) && I.routeBuilt(R.E3c1, { heaterChoke:true }) &&
      I.routeBuilt(R.E3c2, { heaterChoke:true }) && !I.routeBuilt(R.E3c2, { heaterChoke:'yes' });
    var keys = I.rigKeyOf({}, 'line') === '111111000' && I.rigKeyOf({ separator:false }, 'line') === '101111000|line' && I.rigKeyOf({ separator:false }, 'x') === '101111000|flare';
    var nb = I.normalize(I.fakeSnapshot(50, { heaterChoke:true, bypass:true }), I.makeNorm()), na = I.normalize(I.fakeSnapshot(50, { heaterChoke:true }), I.makeNorm());
    var st = nb.ck2.inRig && nb.ck2.bypassed && !nb.ck2.active && nb.rigSig === '111111001' && na.ck2.active && !na.ck2.bypassed && na.nodes.heaterChoke.Pin > na.nodes.heaterChoke.P &&
      na.nodes.choke.P > na.nodes.heaterChoke.Pin && I.rigProxies({ heaterChoke:true }).some(function (p) { return p[0] === 'heaterChoke'; }) && !I.rigProxies({}).some(function (p) { return p[0] === 'heaterChoke'; });
    ok(15, line && built && keys && st, JSON.stringify([line, built, keys, st]));
  });
  // 16 (v1.3.0) clearance with CK-102 in, and with V-101 out to each destination (spool, PSHH-104, NRV-501 / XV-501)
  t(16, function () {
    var bad = [];
    [[{ heaterChoke:true }, 'flare'], [{ heaterChoke:true, desander:true, surge2:true }, 'flare'], [{ separator:false }, 'flare'], [{ separator:false }, 'line'],
      [{ separator:false, flare:false, heaterChoke:true }, 'line']].forEach(function (c) { var r = I.clearanceCheck(c[0], 0.05, c[1]); if (r.length) bad.push(JSON.stringify(c) + ' ' + r[0].a + '~' + r[0].b); });
    ok(16, !bad.length, bad.join('; '));
  });
  function report() {
    var line = '[32-wts-3d] self-test ' + pass + '/' + total + ' passed' + (fails.length ? ' — FAILED: ' + fails.join('; ') : '');
    try { if (fails.length) console.error(line); else console.log(line); } catch (e) {}
    try { if (typeof module !== 'undefined' && require.main === module && typeof process !== 'undefined') { console.log('[32-wts-3d] framing: fitRadius ' + gate.r.toFixed(1) + ' m, V-101 ' + gate.h.toFixed(0) + '×' + gate.w.toFixed(0) + ' px, portrait V-101 ' + gate.ph.toFixed(0) + ' px tall'); if (fails.length) process.exitCode = 1; } } catch (e) {}
    G.__WTS3D_SELFTEST = { pass:pass, total:total, fails:fails };
  }
  report();
})();
