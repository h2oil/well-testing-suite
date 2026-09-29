
// ═══════════════════════════════════════════════════════════════════════
// Round-7 (3D Well Test Simulator) — auto-injected
//   • 31-wts-sim   (dynamic process simulation: levels, pressures, controllers)
//   • 32-wts-3d    (Three.js r170 scene, loaded on demand, 2D fallback)
//   • 38-wts-live  (controller: loop, toolbar, HUD, alarms, 2D live overlay)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 31-wts-sim ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 31-wts-sim.js — Well Test Simulator: DOM-free dynamic process simulation
// -----------------------------------------------------------------------------
// window.WTS_sim — the live model behind the 3D / 2D Well Test Simulator views.
//
//   WH-101 → SDV-101 (ESD) → CK-101 → H-101 → V-101 ─ gas → FE-101 → PCV-101 → FS-401
//                                               ├─ oil bucket → LCV-102 ─┐
//                                               └─ water (C1) → LCV-101 ─┴→ T-201 ─ gas → PCV-201 → flare hdr
//                                   V-101 gas → PCV-202 (blanket) → T-201    T-201 liquid → P-201 → T-301A|B → drain
//
// Contents
//   • geometry (horizontal 2:1-head vessel compartments, vertical tanks), LUTs
//   • PVT (Standing Rs/Bo, calc-identical Z and hydrate line), ISA gas valve, liquid valve
//   • sim factory: adaptive substeps + event location, exact per-phase mass balance,
//     gain-scheduled PI pressure control, 3-phase separator with weir/bucket and snap
//     dump valves, surge tank with BPV / blanket / PSV / transfer pump, twin-compartment
//     gauge tank batch cycle, upstream node dynamics (noise, drawdown, build-up),
//     alarms (delays, deadbands, grace), latching ESD, faults, events, history
//
// Units: psig, °F, ft, in (IDs), bbl, STB, BPD, MMSCFD, MSCFD, scf, ft/s, s (sim time).
// Load-time rule: defines functions and assigns window.WTS_sim only. No DOM, timers,
// Date, performance, structuredClone or queueMicrotask anywhere in this file.
// =============================================================================

(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;

// ─── constants ───────────────────────────────────────────────────────────────
var PSC = 14.696, TSC = 519.67, RANK = 459.67, BBL = 5.614583, GPM_BPD = 34.2857, WGRAD = 0.4331;
var LN10 = Math.LN10, PI = Math.PI;
// local aliases: hot-path Math calls avoid global lookups (matters inside vm-sandboxed hosts such as smoke-test.js)
var mexp = Math.exp, mpow = Math.pow, msqrt = Math.sqrt, mlog = Math.log, mabs = Math.abs, mmin = Math.min, mmax = Math.max,
  macos = Math.acos, mcos = Math.cos, msin = Math.sin, mfloor = Math.floor, mround = Math.round, mimul = Math.imul, isFin = isFinite;
var SEV_RANK = { trip: 0, alarm: 1, warn: 2, hyd: 3, info: 4 };

// ─── small helpers ───────────────────────────────────────────────────────────
function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function isNum(x) { return typeof x === 'number' && isFin(x); }
function num(x, d) { var v = +x; return isFin(v) ? v : d; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isPlainObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
function deepClone(x) { if (x === undefined) return undefined; return JSON.parse(JSON.stringify(x)); }
function mergeInto(dst, over) {
  for (var k in over) {
    if (!hasOwn(over, k)) continue;
    var v = over[k];
    if (v === null || v === undefined) continue;              // null in an override ⇒ lower layer wins
    if (isPlainObj(v)) { if (!isPlainObj(dst[k])) dst[k] = {}; mergeInto(dst[k], v); }
    else if (Array.isArray(v)) dst[k] = deepClone(v);          // arrays are replaced
    else dst[k] = v;
  }
  return dst;
}
// deepMerge(base, over): JSON-safe recursive merge into a fresh object; never mutates its inputs.
function deepMerge(base, over) {
  var out = isPlainObj(base) ? deepClone(base) : {};
  if (isPlainObj(over)) mergeInto(out, deepClone(over));
  return out;
}
// accumulate setConfig partials: null deletes the stored override (restores the lower layer)
function mergeOverrides(stored, partial) {
  for (var k in partial) {
    if (!hasOwn(partial, k)) continue;
    var v = partial[k];
    if (v === undefined) continue;
    if (v === null) { delete stored[k]; continue; }
    if (isPlainObj(v)) { if (!isPlainObj(stored[k])) stored[k] = {}; mergeOverrides(stored[k], v); }
    else if (Array.isArray(v)) stored[k] = deepClone(v);
    else stored[k] = v;
  }
  return stored;
}
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
  }
  return o;
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtClock(tSec) {
  var s = mfloor(isNum(tSec) && tSec > 0 ? tSec : 0);
  var hh = mfloor(s / 3600), mm = mfloor((s % 3600) / 60), ss = s % 60;
  if (hh < 100) return pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss);
  var d = mfloor(s / 86400);
  return d + 'd ' + pad2(mfloor((s % 86400) / 3600)) + ':' + pad2(mm) + ':' + pad2(ss);
}
function rnd(v) { if (!isNum(v)) return '—'; return mabs(v) < 100 ? v.toFixed(1) : v.toFixed(0); }
function rnd0(v) { return isNum(v) ? v.toFixed(0) : '—'; }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = mimul(a ^ (a >>> 15), 1 | a);
    t = (t + mimul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── registries ──────────────────────────────────────────────────────────────
var TAGS = deepFreeze({ wellhead: 'WH-101', esd: 'SDV-101', choke: 'CK-101', heater: 'H-101', separator: 'V-101',
  pcv: 'PCV-101', psvSep: 'PSV-101', lcvWater: 'LCV-101', lcvOil: 'LCV-102', fe: 'FE-101', ftWater: 'FT-101', ftOil: 'FT-102',
  lgTotal: 'LG-101A', lgIface: 'LG-101B', lgBucket: 'LG-101C',
  surge: 'T-201', bpv: 'PCV-201', blanket: 'PCV-202', psvSurge: 'PSV-201', lgSurge: 'LG-201', pump: 'P-201',
  gauge: 'T-301', gaugeA: 'T-301A', gaugeB: 'T-301B', flare: 'FS-401' });
var NAMES = deepFreeze({ wellhead: 'Wellhead', esd: 'ESD Valve (SSV)', choke: 'Choke Manifold', heater: 'Line Heater',
  separator: 'Test Separator', flare: 'Flare Stack', surge: 'Surge Tank', pump: 'Transfer Pump', gauge: 'Gauge Tank' });
var NULLABLE = deepFreeze(['esd.cause', 'esd.tripT', 'surge.tFull_s', 'rates.gor_scf_stb', 'rates.bsw_pct', 'rates.tank_stbd',
  'rates.shrink_pct', 'alarms[*].value', 'alarms[*].limit', 'alarmLog[*].sev',
  'gauge.batches[*].gor_scf_stb', 'gauge.batches[*].bsw_pct']);
var FAULT_IDS = ['pcvStuckClosed', 'pcvStuckOpen', 'oilDumpStuckOpen', 'oilDumpStuckClosed', 'waterDumpStuckClosed', 'surgePumpFail', 'slugging'];
var FAULT_LABELS = { pcvStuckClosed: 'PCV-101 stuck closed', pcvStuckOpen: 'PCV-101 stuck open', oilDumpStuckOpen: 'LCV-102 stuck open',
  oilDumpStuckClosed: 'LCV-102 stuck closed', waterDumpStuckClosed: 'LCV-101 stuck closed', surgePumpFail: 'P-201 failed', slugging: 'Slug flow' };
var NODE_IDS = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare', 'surge', 'gauge'];
var SEG_META = [['wh_esd', 'wellhead', 'esd', 'WH→ESD'], ['esd_choke', 'esd', 'choke', 'ESD→Choke'], ['choke_heater', 'choke', 'heater', 'Choke→Heater'],
  ['heater_sep', 'heater', 'separator', 'Heater→Sep'], ['sep_flare', 'separator', 'flare', 'Sep→Flare'], ['surge_gauge', 'surge', 'gauge', 'Surge→Gauge Tank']];
var HIST_KEYS = ['Psep', 'PsepSP', 'bucketFrac', 'ifaceFrac', 'c1Frac', 'surgeFrac', 'surgeP', 'gaugeFracA', 'gaugeFracB', 'qgFlare', 'qoMeter', 'Pwh', 'Pchoke', 'Twh'];

// ─── DEFAULTS (§4.12, deep-frozen) ───────────────────────────────────────────
var DEFAULTS = deepFreeze({ seed: 12345, speed: 10, speeds: [1, 10, 60, 600], hMax: 0.25, hMin: 0.005, maxSubsteps: 6000, maxAdvance: 3600,
  realDtCap: 0.1, histDt: 5, histLen: 2880, startupGrace: 180, ambientT: 80, waterRoute: 'surge',
  alarm: { onDelay: 3, offDelay: 10, levelDB: 0.02, pressDBfrac: 0.01 },
  noise: { on: true, gasSigma: 0.01, liqSigma: 0.05, tau: 15, whpSigma: 0.0015, whpTau: 60, fInstTau: 20,
    slug: { on: false, period: 120, width: 12, amp: 1.5 } },
  ramp: { tauFlow: 20, esdCloseS: 5, esdOpenS: 15, buildupTau: 300, drawdownTau: 60, sithpFactor: 1.2, drawdownFrac: 0,
    warmTau: 300, coolTau: 1800, spRate: 2, surgeSpRate: 1 },
  sep: { D_in: 36, Lss_ft: 10, weirFrac: 0.55, weirPosFrac: 0.75, mawp: 1440,
    pcv: { tauCl: 5, Ti: 20, designOpen: 0.5, P2_psig: 5, k: 1.28, xT: 0.72, minDesignMMscfd: 1 },
    oil: { mode: 'snap', lsll: 0.08, lsl: 0.20, lsh: 0.45, lshh: 0.52, dumpFactor: 4, strokeS: 2, minDesignBpd: 100 },
    water: { mode: 'snap', lsll: 0.08, lsl: 0.15, lsh: 0.35, lshh: 0.50, dumpFactor: 4, strokeS: 2, minDesignBpd: 100 },
    lahhTotal: 0.80, psh: null, pshh: null, psl: null },
  surge: { cap_bbl: 100, D_ft: 6, Psp: 25, psh: null, pshh: null, mawp: null, lsll: 0.05, lsl: 0.25, lsh: 0.70, lshh: 0.90,
    pumpBpd: null, pumpMinBpd: 500, pumpVelFrac: 0.7, psvMinMscfd: 50,
    bpv: { tauCl: 10, Ti: 30 }, blanket: { on: true, deadband: 1, band: 2 } },
  gauge: { count: 2, cap_bbl: 100, D_ft: 8, switchFrac: 0.90, lahh: 0.97, heelFrac: 0.02, settleS: 600, drainBpd: null } });

// ─── SAMPLE_FLOW (Appendix A: calcWTS defaults after H8; flow v1) ────────────
var SAMPLE_FLOW = deepFreeze({v:1,seq:1,ts:0,wellheadPressure:3000,wellheadTemp:180,gasRate:10,oilRate:1000,waterRate:200,chokeBean:32,separatorPressure:150,
  inputs:{Pwh:3000,Twh:180,Qg:10,Qo:1000,Qw:200,SGg:0.65,API:35,bean:32,Cd:0.85,Thtr:150,htrEff:0.8,bypass:false,Psep:150,Cfac:100,eps:0.0018},
  fluid:{Mg:18.8305,SGo:0.84984985,rhoOil:53.030631,rhoWat:62.4,rhoGstd:0.049628783,Ppc:670.129,Tpc:365.11},
  choke:{regime:'Critical',flowLimited:false,QmaxMMscfd:10.710428,QcritMMscfd:10.710428,Pin:2999.2647,Pout:157.66086,ratio:0.057186168,rCrit:0.54936823,dP:2841.6038,dTjt:111.25814,wJT:0.55933274},
  heater:{bypass:false,dutyMMBtuHr:2.1030781,processMMBtuHr:1.6824625,Tin:68.734685,Tout:150},
  sep:{arrivalP:150,inletDP:0},flareHdrP:5,
  nodes:[{id:'wellhead',nm:'Wellhead',P:3000,T:180,th:75.141595},
    {id:'esd',nm:'SSV',P:2999.7549,T:179.99926,th:75.1405},
    {id:'choke',nm:'Choke',P:157.66086,T:68.739649,th:36.594669,regime:'Critical',bean:32,Pci:2999.2647,Qmax:10710.428,flowLimited:false},
    {id:'heater',nm:'Heater',P:151.00593,T:150,th:36.064267,duty:2.1030781,bypass:false},
    {id:'separator',nm:'Separator',P:150,T:149.99698,th:35.982245},
    {id:'flare',nm:'Flare',P:5,T:149.98527,th:32},
    {id:'surge',nm:'Surge Tank',P:25,T:149.99698,th:32},
    {id:'gauge',nm:'Atm Tank',P:0,T:149.99698,th:32}],
  segs:[{id:'wh_esd',from:'wellhead',to:'esd',label:'WH→ESD',nps:'4',sch:'40',ID:4.026,L:50,phase:'multi',P0:3000,Pout:2999.7549,T0:180,Tout:179.99926,vel:7.9852941,ve:26.567473,rhom:14.167705,dP:0.24508704,dT:0.00073526112,z:0.90418095,Re:1129699.8,ff:0.016867825,Thyd:75.141595,hydR:false,vSt:'OK',vPct:30.056656},
    {id:'esd_choke',from:'esd',to:'choke',label:'ESD→Choke',nps:'4',sch:'40',ID:4.026,L:100,phase:'multi',P0:2999.7549,Pout:2999.2647,T0:179.99926,Tout:179.99779,vel:7.9857881,ve:26.568295,rhom:14.166829,dP:0.4902044,dT:0.0014706132,z:0.90417137,Re:1129699.8,ff:0.016867825,Thyd:75.1405,hydR:false,vSt:'OK',vPct:30.057586},
    {id:'choke_heater',from:'choke',to:'heater',label:'Choke→Heater',nps:'6',sch:'40',ID:6.065,L:200,phase:'multi',P0:157.66086,Pout:156.00593,T0:68.739649,Tout:68.734685,vel:48.743979,ve:98.883154,rhom:1.0227168,dP:1.6549287,dT:0.004964786,z:0.96679159,Re:749904.61,ff:0.015947737,Thyd:36.594669,hydR:false,vSt:'OK',vPct:49.294522},
    {id:'heater_sep',from:'heater',to:'separator',label:'Heater→Sep',nps:'6',sch:'40',ID:6.065,L:100,phase:'multi',P0:151.00593,Pout:150,T0:150,Tout:149.99698,vel:59.257192,ve:109.02657,rhom:0.84126978,dP:1.0059337,dT:0.0030178012,z:0.98072402,Re:749904.61,ff:0.015947737,Thyd:36.064267,hydR:false,vSt:'OK',vPct:54.351146},
    {id:'sep_flare',from:'separator',to:'flare',label:'Sep→Flare',nps:'6',sch:'40',ID:6.065,L:300,phase:'gas',P0:150,Pout:148.32622,T0:149.99698,Tout:149.98527,vel:59.234524,ve:143.83746,rhom:0.48334361,dP:1.6737775,dT:0.011716442,z:0.98083629,Re:1794524.2,ff:0.015406989,Thyd:35.982245,hydR:false,vSt:'OK',vPct:41.18157},
    {id:'surge_gauge',from:'surge',to:'gauge',label:'Surge→Gauge Tank',nps:'3',sch:'40',ID:3.068,L:80,phase:'liquid',P0:25,Pout:24.885467,T0:149.99698,Tout:149.99698,vel:1.5190748,ve:10,rhom:54.592192,dP:0.11453338,dT:0,z:0.99524952,Re:21035.007,ff:0.02692309,Thyd:32,hydR:false,vSt:'OK',vPct:15.190748}],
  warnings:[],sim:{sepID_in:36,sepLss_ft:10,surgeP_psig:25,surgeCap_bbl:100,gaugeCap_bbl:100}});

// ─── geometry ────────────────────────────────────────────────────────────────
function segArea(h, R) {                      // circle segment below chord at depth h
  var D = 2 * R;
  if (!(h > 0)) return 0;
  if (h >= D) return PI * R * R;
  var c = R - h;
  return R * R * macos(c / R) - c * msqrt(mmax(0, 2 * R * h - h * h));
}
function head21Vol1(h, R) {                   // one 2:1 semi-ellipsoidal head, partially filled to h
  var D = 2 * R;
  if (!(h > 0)) return 0;
  if (h > D) h = D;
  return PI * h * h * (3 * R - h) / 12;
}
// makeLUT(fn, hMax, N, dfn?) → {V(h), h(V), Vmax}: cosine-spaced table; inverse = bracket + linear
// interpolation, then two safeguarded Newton steps when a derivative is supplied.
function makeLUT(fn, hMax, N, dfn) {
  N = N || 257;
  var hs = new Float64Array(N), vs = new Float64Array(N), i;
  for (i = 0; i < N; i++) { hs[i] = hMax * (1 - mcos(PI * i / (N - 1))) / 2; }
  hs[0] = 0; hs[N - 1] = hMax;
  for (i = 0; i < N; i++) vs[i] = fn(hs[i]);
  var Vmax = vs[N - 1];
  function V(h) { return fn(h <= 0 ? 0 : (h >= hMax ? hMax : h)); }
  function hOf(v) {
    if (!(v > vs[0])) return 0;
    if (v >= Vmax) return hMax;
    var lo = 0, hi = N - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (vs[m] <= v) lo = m; else hi = m; }
    var a = hs[lo], b = hs[hi], va = vs[lo], vb = vs[hi];
    var h = vb > va ? a + (v - va) / (vb - va) * (b - a) : a;
    if (dfn) {
      for (var it = 0; it < 2; it++) {
        var d = dfn(h);
        if (!(d > 1e-12)) break;
        var hn = h - (fn(h) - v) / d;
        if (hn <= a || hn >= b) break;
        h = hn;
      }
    }
    return h;
  }
  return { V: V, h: hOf, Vmax: Vmax, hMax: hMax };
}

// ─── PVT (public, argument-explicit) ─────────────────────────────────────────
function pvtRs(Pa, TF, SGg, API) {
  if (!(SGg > 0) || !(Pa > 0)) return 0;
  return SGg * mpow((Pa / 18.2 + 1.4) * mexp((0.0125 * API - 0.00091 * TF) * LN10), 1.2048);
}
function pvtRsEff(Pa, TF, SGg, API) { var r = pvtRs(Pa, TF, SGg, API) - pvtRs(PSC, TF, SGg, API); return r > 0 ? r : 0; }
function pvtBo(Rs, TF, SGg, SGo) {
  var x = (Rs > 0 ? Rs : 0) * msqrt(mmax(SGg, 0) / mmax(SGo, 0.1)) + 1.25 * TF;
  return 0.9759 + 1.2e-4 * mpow(x > 0 ? x : 0, 1.2);
}
function pvtBoRel(Pa, TF, SGg, API) {
  var SGo = 141.5 / (API + 131.5);
  return pvtBo(pvtRsEff(Pa, TF, SGg, API), TF, SGg, SGo) / pvtBo(0, 60, SGg, SGo);
}
function zFactor(Pa, TR, SGg) {               // verbatim calcWTS Papay-style Z, clamped 0.3–1.2
  var Ppc = 756.8 - 131 * SGg - 3.6 * SGg * SGg, Tpc = 169.2 + 349.5 * SGg - 74 * SGg * SGg;
  var pr = Pa / Ppc, tr = TR / Tpc;
  return mmax(0.3, mmin(1.2, 1 - 3.52 * pr / mpow(10, 0.9813 * tr) + 0.274 * pr * pr / mpow(10, 0.8157 * tr)));
}
function hydrateT(Pa, SGg) { return mmax(32, 13.47 * mlog(mmax(Pa, 15)) - 34.27 + (SGg - 0.6) * 30); }

// ─── valves ──────────────────────────────────────────────────────────────────
var FKXT_DEF = 1.28 / 1.4 * 0.72;              // Fk·xT with k = 1.28, xT = 0.72
function gasQ(Cv, P1a, P2a, SG, TR, Z, fkxt) {  // ISA-75.01 (US units), scf/s; 0 when P1 ≤ P2 (check valve)
  if (!(Cv > 0) || !(P1a > P2a) || !(P1a > 0)) return 0;
  var fx = fkxt > 0 ? fkxt : FKXT_DEF;
  var x = (P1a - P2a) / P1a; if (x > fx) x = fx;
  var Y = 1 - x / (3 * fx);
  return 1360 * Cv * P1a * Y * msqrt(x / (mmax(SG, 0.05) * TR * Z)) / 3600;
}
function liqQ(Cv, dP, SG) {                   // bbl/s
  if (!(Cv > 0) || !(dP > 0)) return 0;
  return Cv * msqrt(dP / mmax(SG, 0.1)) * GPM_BPD / 86400;
}

// ─── flow helpers ────────────────────────────────────────────────────────────
function validFlow(f) {
  if (!isPlainObj(f) || !isPlainObj(f.inputs)) return false;
  var I = f.inputs, ks = ['Qg', 'Qo', 'Qw', 'SGg', 'API', 'Psep'];
  for (var i = 0; i < ks.length; i++) { var v = +I[ks[i]]; if (!isFin(v) || v < 0) return false; }
  return +I.Psep > 0;
}
function normFlow(f) {                         // clone + fill gaps from SAMPLE_FLOW + numeric normalisation (on the clone)
  var n = deepMerge(SAMPLE_FLOW, f);
  var I = n.inputs;
  ['Pwh', 'Twh', 'Qg', 'Qo', 'Qw', 'SGg', 'API', 'bean', 'Cd', 'Thtr', 'htrEff', 'Psep', 'Cfac', 'eps'].forEach(function (k) {
    I[k] = num(I[k], SAMPLE_FLOW.inputs[k]);
  });
  I.bypass = (I.bypass === true || I.bypass === 1 || I.bypass === '1' || I.bypass === 'true');
  if (!Array.isArray(n.nodes) || n.nodes.length < 8) n.nodes = deepClone(SAMPLE_FLOW.nodes);
  if (!Array.isArray(n.segs) || n.segs.length < 6) n.segs = deepClone(SAMPLE_FLOW.segs);
  return n;
}
function flowFromInputs(partialInputs, partialSim) {
  var f = deepClone(SAMPLE_FLOW);
  if (isPlainObj(partialInputs)) mergeInto(f.inputs, deepClone(partialInputs));
  if (isPlainObj(partialSim)) mergeInto(f.sim, deepClone(partialSim));
  var I = f.inputs;
  f.wellheadPressure = I.Pwh; f.wellheadTemp = I.Twh; f.gasRate = I.Qg; f.oilRate = I.Qo; f.waterRate = I.Qw;
  f.chokeBean = I.bean; f.separatorPressure = I.Psep;
  return f;
}
function flowDerived(fs) {
  var o = { sep: {}, surge: {}, gauge: {} };
  if (!isPlainObj(fs)) return o;
  if (+fs.sepID_in > 0) o.sep.D_in = +fs.sepID_in;
  if (+fs.sepLss_ft > 0) o.sep.Lss_ft = +fs.sepLss_ft;
  if (isFin(+fs.surgeP_psig) && fs.surgeP_psig !== null && fs.surgeP_psig !== '') o.surge.Psp = +fs.surgeP_psig;
  if (+fs.surgeCap_bbl > 0) o.surge.cap_bbl = +fs.surgeCap_bbl;
  if (+fs.gaugeCap_bbl > 0) o.gauge.cap_bbl = +fs.gaugeCap_bbl;
  return o;
}
function nodeOf(flow, id, idx) {
  var a = flow.nodes || [];
  for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i];
  return a[idx] || {};
}

// =============================================================================
// Sim factory
// =============================================================================
function create(flowIn, opts) {
  opts = isPlainObj(opts) ? opts : {};
  var initFlow = validFlow(flowIn) ? flowIn : SAMPLE_FLOW;
  var flow = normFlow(initFlow);
  var overrides = {};
  if (isPlainObj(opts.config)) mergeOverrides(overrides, deepClone(opts.config));
  var cfg = null;
  function buildCfg() { cfg = deepMerge(deepMerge(deepClone(DEFAULTS), flowDerived(flow.sim)), overrides); }
  buildCfg();

  var seed = isNum(+opts.seed) && opts.seed !== null && opts.seed !== undefined ? (+opts.seed | 0) : cfg.seed;
  var rng = mulberry32(seed), spare = null;
  function randn() {
    if (spare !== null) { var s = spare; spare = null; return s; }
    var u1 = rng(), u2 = rng();
    if (u1 < 1e-300) u1 = 1e-300;
    var r = msqrt(-2 * mlog(u1)), a = 2 * PI * u2;
    spare = r * msin(a);
    return r * mcos(a);
  }

  // ── derived constants (re-derived on setFlow/setConfig) ──
  var SGg, API, SGo, k10, sqRatio, bo060, Ppc, Tpc, Tamb;
  var Qg, Qo, Qw, SP, qgD, qoD, qwD, limFac, qgE, qoE, qwE;
  var Pwh_ss, Pci_ss, Pck_ss, Ph_ss, Psep_ss, Twh_ss, Tesd_ss, Tck_ss, Th_ss, Tsep_ss, Tfl_ss, Tin_ss, duty_ss, bypass, bean;
  var chk = { regime: 'Critical', flowLimited: false, QmaxMMscfd: 0, wJT: 1 };
  var SS = [];                                  // steady segment data (6)
  var D, R, Lss, xW, Lb, hWeir, Lw, lutC1, lutB, Vves, VB_hi, VB_lo, VW_hi, VW_lo;
  var Du, Atu, Hu, capU, Dg, Atg, Hg, capG;
  var Cv_pcv, Cv_psv, Cv_o, Cv_w, Cv_bpv, Cv_mk, Cv_psvU, pumpDesign, drainBpd, qFlashD, A6, PspU;
  var geomKey = '';

  // PVT closures (use the derived fluid constants)
  function Rs(Pa, TF) { return SGg > 0 ? SGg * mpow((Pa / 18.2 + 1.4) * mexp((k10 - 0.00091 * TF) * LN10), 1.2048) : 0; }
  function RsE(Pa, TF) { var r = Rs(Pa, TF) - Rs(PSC, TF); return r > 0 ? r : 0; }
  function BoR(Pa, TF) { var x = RsE(Pa, TF) * sqRatio + 1.25 * TF; return (0.9759 + 1.2e-4 * mpow(x > 0 ? x : 0, 1.2)) / bo060; }
  function Zf(Pa, TR) {
    var pr = Pa / Ppc, tr = TR / Tpc;
    var z = 1 - 3.52 * pr / mexp(0.9813 * tr * LN10) + 0.274 * pr * pr / mexp(0.8157 * tr * LN10);
    return z < 0.3 ? 0.3 : (z > 1.2 ? 1.2 : z);
  }
  function Thyd(Pa) { return hydrateT(Pa, SGg); }
  var fkxt = FKXT_DEF;                          // per-sim valve constants (cfg.sep.pcv.k / xT)
  function gq(Cv, P1a, P2a, TR, Z) { return gasQ(Cv, P1a, P2a, SGg, TR, Z, fkxt); }

  // separator compartment volume functions (bbl) and derivatives (bbl/ft)
  function vC1(h) { return (segArea(h, R) * xW + head21Vol1(h, R)) / BBL; }
  function vB(h) { return (segArea(h, R) * Lb + head21Vol1(h, R)) / BBL; }
  function dA(h) { return 2 * msqrt(mmax(0, 2 * R * h - h * h)); }
  function dH(h) { return PI * h * (2 * R - h) / 4; }
  function dC1(h) { return (dA(h) * xW + dH(h)) / BBL; }
  function dB(h) { return (dA(h) * Lb + dH(h)) / BBL; }

  // ── dynamic state ──
  var t = 0, running = opts.running === false ? false : true, speed = cfg.speed, mode = 'steady', disposed = false;
  var flowSeq = 0, flowTs = 0, geomVersion = 1, alarmVersion = 0, flowInvalid = false;
  var faults = {}; FAULT_IDS.forEach(function (k) { faults[k] = false; });
  // upstream
  var qBg, qBo, qBw, xiG, xiL, xiW, fInst, f, fE, mg, ml, esdTravel, Pwh, PB, theta, tFlow, tShut, P0shut, shut;
  // separator
  var n_s, Vw1, Vo1, Vw2, Vo2, SPe, Ipcv, upcv, psvLift, lcvO, lcvW;
  var PsepA, Psep, Zs, Bs, Vg, hW1, hL1, h2, hW2, Tsep, psh, pshh, psl, mawpE;
  // surge
  var n_u, Vou, Vwu, Tu, SPeu, Ibpv, ubpv, ublk, psvULift, pumpOn, pumpTrip;
  var PuA, Pu, Zu, Bu, VgU, VliqU, hU, pshU, pshhU, mawpU, P2aU;
  // gauge
  var tanks, active, batches, batchN;
  // accumulators (base units) + meters
  var cum, ref, emaOil, emaWater, emaGas, emaFlash, oilCycles, waterCycles, graceUntil;
  // instantaneous fluxes (last substep)
  var F = { inG: 0, inO: 0, inW: 0, pcv: 0, pcvCap: 0, psv: 0, blk: 0, blowO: 0, blowW: 0, weirO: 0, weirW: 0, oO: 0, oW: 0, wW: 0, wO: 0,
    bpv: 0, bpvCap: 0, psvU: 0, flash: 0, pumpBpd: 0, po: 0, pw: 0, gvent: 0, drO: [0, 0], drW: [0, 0], qOver: 0, phiC: 0,
    rB: 0, rW1: 0, rU: 0, rG: [0, 0] };
  // alarms
  var AL = {}, alarmOrder = [], alarmLog = [], alarmsDirty = true;
  // events
  var handlers = {}, evq = [], flushing = false, deferred = [];
  // history
  var H = null;
  // health
  var lastSubsteps = 0, lagging = false, droppedSimSec = 0;

  // ───────────────────────────────────────────────────────────────────────────
  function derive() {
    var I = flow.inputs;
    SGg = mmax(0, I.SGg); API = I.API; SGo = 141.5 / (API + 131.5);
    k10 = 0.0125 * API; sqRatio = msqrt(SGg / mmax(SGo, 0.1));
    bo060 = 0.9759 + 1.2e-4 * mpow(75, 1.2);
    Ppc = 756.8 - 131 * SGg - 3.6 * SGg * SGg; Tpc = 169.2 + 349.5 * SGg - 74 * SGg * SGg;
    Tamb = num(cfg.ambientT, 80);
    Qg = I.Qg; Qo = I.Qo; Qw = I.Qw; SP = I.Psep; bypass = !!I.bypass; bean = I.bean;
    qgD = Qg * 1e6 / 86400; qoD = Qo / 86400; qwD = Qw / 86400;
    var fc = isPlainObj(flow.choke) ? flow.choke : {};
    chk.regime = (fc.regime === 'Critical' || fc.regime === 'Subcritical' || fc.regime === 'No Flow') ? fc.regime : 'Critical';
    chk.flowLimited = !!fc.flowLimited;
    chk.QmaxMMscfd = num(fc.QmaxMMscfd, 0);
    chk.wJT = num(fc.wJT, 1);
    limFac = (chk.flowLimited && Qg > 0 && chk.QmaxMMscfd >= 0) ? mmin(1, chk.QmaxMMscfd / Qg) : 1;
    qgE = qgD * limFac; qoE = qoD * limFac; qwE = qwD * limFac;
    // steady nodes
    var nW = nodeOf(flow, 'wellhead', 0), nE = nodeOf(flow, 'esd', 1), nC = nodeOf(flow, 'choke', 2), nH = nodeOf(flow, 'heater', 3),
      nS = nodeOf(flow, 'separator', 4), nF = nodeOf(flow, 'flare', 5);
    Pwh_ss = num(nW.P, I.Pwh); Twh_ss = num(nW.T, I.Twh);
    Tesd_ss = num(nE.T, Twh_ss);
    Pci_ss = num(nC.Pci, num(fc.Pin, num(nE.P, Pwh_ss)));
    Pck_ss = num(nC.P, num(fc.Pout, SP + 8));
    Tck_ss = num(nC.T, Twh_ss);
    Ph_ss = num(nH.P, SP + 1); Th_ss = num(nH.T, Tck_ss);
    Psep_ss = num(nS.P, SP); Tsep_ss = num(nS.T, Th_ss);
    Tfl_ss = num(nF.T, Tsep_ss);
    var fh = isPlainObj(flow.heater) ? flow.heater : {};
    Tin_ss = num(fh.Tin, Tck_ss); duty_ss = mmax(0, num(fh.dutyMMBtuHr, num(nH.duty, 0)));
    SS = [];
    for (var i = 0; i < 6; i++) {
      var s = flow.segs[i] || {}, sm = SEG_META[i];
      SS.push({ id: typeof s.id === 'string' ? s.id : sm[0], from: typeof s.from === 'string' ? s.from : sm[1], to: typeof s.to === 'string' ? s.to : sm[2],
        label: typeof s.label === 'string' ? s.label : sm[3], phase: (s.phase === 'gas' || s.phase === 'liquid' || s.phase === 'multi') ? s.phase : (i === 4 ? 'gas' : i === 5 ? 'liquid' : 'multi'),
        nps: String(s.nps != null ? s.nps : ''), sch: String(s.sch != null ? s.sch : ''), ID: mmax(0, num(s.ID, 4.026)), L: mmax(0, num(s.L, 0)),
        vel: mmax(0, num(s.vel, 0)), ve: mmax(0, num(s.ve, 0)), dP: mmax(0, num(s.dP, 0)), ff: mmax(0, num(s.ff, 0.027)), rhom: mmax(0, num(s.rhom, 54.6)) });
    }
    // geometry
    var gk = [cfg.sep.D_in, cfg.sep.Lss_ft, cfg.sep.weirFrac, cfg.sep.weirPosFrac, cfg.surge.cap_bbl, cfg.surge.D_ft, cfg.gauge.cap_bbl, cfg.gauge.D_ft].join('|');
    var geomChanged = gk !== geomKey && geomKey !== '';
    var keep = null;
    if (geomChanged) keep = captureFractions();
    if (gk !== geomKey) {
      D = mmax(0.5, num(cfg.sep.D_in, 36) / 12); R = D / 2; Lss = mmax(1, num(cfg.sep.Lss_ft, 10));
      xW = clamp(num(cfg.sep.weirPosFrac, 0.75), 0.3, 0.95) * Lss; Lb = Lss - xW;
      hWeir = clamp(num(cfg.sep.weirFrac, 0.55), 0.2, 0.9) * D; Lw = 2 * msqrt(hWeir * (D - hWeir));
      lutC1 = makeLUT(vC1, D, 257, dC1); lutB = makeLUT(vB, D, 257, dB);
      Vves = lutC1.Vmax + lutB.Vmax;
      capU = mmax(1, num(cfg.surge.cap_bbl, 100)); Du = mmax(0.5, num(cfg.surge.D_ft, 6)); Atu = PI * Du * Du / 4; Hu = capU * BBL / Atu;
      capG = mmax(1, num(cfg.gauge.cap_bbl, 100)); Dg = mmax(0.5, num(cfg.gauge.D_ft, 8)); Atg = PI * Dg * Dg / 4; Hg = capG * BBL / Atg;
      geomKey = gk;
    }
    VB_hi = lutB.V(cfg.sep.oil.lsh * D); VB_lo = lutB.V(cfg.sep.oil.lsl * D);
    VW_hi = lutC1.V(cfg.sep.water.lsh * D); VW_lo = lutC1.V(cfg.sep.water.lsl * D);
    // sizing (§4.6–4.8) with zero-rate floors
    var TRs = Tsep_ss + RANK, SPa = SP + PSC, P2a = PSC + cfg.sep.pcv.P2_psig;
    fkxt = num(cfg.sep.pcv.k, 1.28) / 1.4 * num(cfg.sep.pcv.xT, 0.72);
    var qSize = qgE > 0 ? qgE : cfg.sep.pcv.minDesignMMscfd * 1e6 / 86400;
    var q1 = gq(1, mmax(SPa, P2a + 5), P2a, TRs, Zf(mmax(SPa, P2a + 5), TRs));
    Cv_pcv = q1 > 0 ? qSize / (cfg.sep.pcv.designOpen * q1) : 1;
    Cv_psv = 4 * Cv_pcv;
    PspU = clamp(num(cfg.surge.Psp, 25), 0, mmin(30, mmax(0, SP - 10)));
    var BsD = BoR(SPa, Tsep_ss);
    var dPd = mmax(SP - PspU, 10);
    Cv_o = cfg.sep.oil.dumpFactor * (mmax(qoE, cfg.sep.oil.minDesignBpd / 86400) * BsD) / (msqrt(dPd / mmax(SGo, 0.1)) * GPM_BPD / 86400);
    Cv_w = cfg.sep.water.dumpFactor * mmax(qwE, cfg.sep.water.minDesignBpd / 86400) / (msqrt(dPd) * GPM_BPD / 86400);
    var PspUa = PspU + PSC;
    qFlashD = qoE * mmax(0, RsE(SPa, Tsep_ss) - RsE(PspUa, Tsep_ss));
    var P2aUd = PSC + mmin(cfg.sep.pcv.P2_psig, 0.4 * PspU), P1u = mmax(PspUa, P2aUd + 5);
    var qU1 = gq(1, P1u, P2aUd, TRs, Zf(P1u, TRs));
    Cv_bpv = qU1 > 0 ? mmax(3 * qFlashD, 50e3 / 86400) / (0.5 * qU1) : 1;
    A6 = PI / 4 * mpow(SS[5].ID / 12, 2);
    var velCap = cfg.surge.pumpVelFrac * 10 * A6 * 86400 / BBL;
    pumpDesign = (cfg.surge.pumpBpd != null && +cfg.surge.pumpBpd > 0) ? +cfg.surge.pumpBpd
      : mmin(mmax(3 * (qoE * BsD + qwE) * 86400, cfg.surge.pumpMinBpd), velCap > 0 ? velCap : cfg.surge.pumpMinBpd);
    var Qv = pumpDesign / 86400 * BBL * (PspUa / PSC) * (TSC / TRs) / Zf(PspUa, TRs);
    var qmk1 = gq(1, mmax(SPa, PspUa + 5), PspUa, TRs, Zf(mmax(SPa, PspUa + 5), TRs));
    Cv_mk = qmk1 > 0 ? 2 * Qv / qmk1 : 1;
    var mU = mawpUof(PspU), mUa = mU + PSC;
    var qp1 = gq(1, mUa, P2a, TRs, Zf(mUa, TRs));
    Cv_psvU = qp1 > 0 ? mmax(2 * gq(Cv_o, mmax(SPa, mUa + 1), mUa, TRs, Zf(mmax(SPa, mUa + 1), TRs)), cfg.surge.psvMinMscfd * 1000 / 86400) / qp1 : 1;
    drainBpd = (cfg.gauge.drainBpd != null && +cfg.gauge.drainBpd > 0) ? +cfg.gauge.drainBpd : mmax(3000, 2 * pumpDesign);
    return keep;
  }
  function mawpUof(x) {
    if (cfg.surge.mawp != null && isNum(+cfg.surge.mawp)) return +cfg.surge.mawp;
    return mmax(50, x + mmax(0.5 * x, 15) + 10);
  }

  // ── algebraic state (levels, pressures) from inventories ──
  function algebraic() {
    Tsep = Tamb + (Tsep_ss - Tamb) * theta;
    var TR = Tsep + RANK;
    Bs = BoR(PsepA > 0 ? PsepA : SP + PSC, Tsep);
    var VL1 = Vw1 + Vo1 * Bs, VLB = Vw2 + Vo2 * Bs;
    hW1 = lutC1.h(Vw1); hL1 = lutC1.h(VL1); h2 = lutB.h(VLB); hW2 = lutB.h(Vw2);
    Vg = BBL * (Vves - VL1 - VLB);
    var vfloor = 0.02 * Vves * BBL; if (Vg < vfloor) Vg = vfloor;
    var z = Zs > 0 ? Zs : 0.95, P = 0;
    for (var it = 0; it < 2; it++) { P = n_s * z * TR * PSC / (TSC * Vg); z = Zf(mmax(P, 1), TR); }
    P = n_s * z * TR * PSC / (TSC * Vg);
    if (P < PSC) {                                              // vacuum breaker (air in; tracked)
      var need = PSC * Vg * TSC / (z * TR * PSC);
      cum.vacBreak += need - n_s; n_s = need; P = PSC;
    }
    Zs = z; PsepA = P; Psep = P - PSC;
    // surge
    var TRu = Tu + RANK;
    Bu = BoR(PuA > 0 ? PuA : PspU + PSC, Tu);
    VliqU = Vou * Bu + Vwu;
    hU = VliqU * BBL / Atu;
    VgU = mmax(1, (capU - VliqU) * BBL);
    var zu = Zu > 0 ? Zu : 0.99, Pa = n_u * zu * TRu * PSC / (TSC * VgU);
    zu = Zf(mmax(Pa, 1), TRu); Pa = n_u * zu * TRu * PSC / (TSC * VgU);
    if (Pa < PSC) { var nd = PSC * VgU * TSC / (zu * TRu * PSC); cum.vacBreak += nd - n_u; n_u = nd; Pa = PSC; }
    Zu = zu; PuA = Pa; Pu = Pa - PSC;
  }
  function tankBo(k) { return BoR(PSC, tanks[k].T); }
  function tankVliq(k) { return tanks[k].Vo * tankBo(k) + tanks[k].Vw; }

  function captureFractions() {
    if (!lutC1) return null;
    var k = { fW1: hW1 / D, fL1: hL1 / D, f2: h2 / D, fW2: hW2 / D, P: PsepA, fU: VliqU / capU, wU: VliqU > 1e-12 ? Vwu / VliqU : 0, PuA: PuA, g: [] };
    for (var i = 0; i < 2; i++) { var vl = tankVliq(i); k.g.push({ f: vl / capG, w: vl > 1e-12 ? tanks[i].Vw / vl : 0 }); }
    return k;
  }
  function applyFractions(k) {
    if (!k) return;
    Vw1 = lutC1.V(k.fW1 * D); Vo1 = mmax(0, lutC1.V(k.fL1 * D) - Vw1) / Bs;
    Vw2 = lutB.V(k.fW2 * D); Vo2 = mmax(0, lutB.V(k.f2 * D) - Vw2) / Bs;
    var TR = Tsep + RANK, VL = Vw1 + Vo1 * Bs + Vw2 + Vo2 * Bs;
    var vg = mmax(0.02 * Vves * BBL, BBL * (Vves - VL));
    n_s = k.P * vg * TSC / (Zf(k.P, TR) * TR * PSC);
    var VlU = k.fU * capU; Vwu = VlU * k.wU; Vou = VlU * (1 - k.wU) / Bu;
    var TRu = Tu + RANK, vgu = mmax(1, (capU - VlU) * BBL);
    n_u = k.PuA * vgu * TSC / (Zf(k.PuA, TRu) * TRu * PSC);
    for (var i = 0; i < 2; i++) { var vl = k.g[i].f * capG; tanks[i].Vw = vl * k.g[i].w; tanks[i].Vo = vl * (1 - k.g[i].w) / tankBo(i); }
  }

  // ── inventories & mass-balance reference ──
  function invOil() { return Vo1 + Vo2 + Vou + tanks[0].Vo + tanks[1].Vo; }
  function invWater() { return Vw1 + Vw2 + Vwu + tanks[0].Vw + tanks[1].Vw; }
  function invGas() { return n_s + n_u; }
  function setRef() {
    ref = { oil: invOil(), water: invWater(), gas: invGas(), oilIn: cum.oilIn, waterIn: cum.waterIn, gasIn: cum.gasIn, flash: cum.flash,
      gaugeFlash: cum.gaugeFlash, vacBreak: cum.vacBreak, flare: cum.flare, gaugeVent: cum.gaugeVent,
      drainedOil: cum.drainedOil, drainedWater: cum.drainedWater, ltfOil: cum.ltfOil, ltfWater: cum.ltfWater, spillOil: cum.spillOil, spillWater: cum.spillWater };
  }
  function zeroCum() {
    cum = { oilIn: 0, waterIn: 0, gasIn: 0, flare: 0, flash: 0, gaugeFlash: 0, gaugeVent: 0, vacBreak: 0, gaugeOil: 0, gaugeWater: 0,
      drainedOil: 0, drainedWater: 0, ltfOil: 0, ltfWater: 0, spillOil: 0, spillWater: 0, sepGas: 0 };
  }
  function massErr(out) {
    var dO = cum.oilIn - ref.oilIn, dW = cum.waterIn - ref.waterIn;
    var rO = dO - ((invOil() - ref.oil) + (cum.drainedOil - ref.drainedOil) + (cum.ltfOil - ref.ltfOil) + (cum.spillOil - ref.spillOil));
    var rW = dW - ((invWater() - ref.water) + (cum.drainedWater - ref.drainedWater) + (cum.ltfWater - ref.ltfWater) + (cum.spillWater - ref.spillWater));
    var src = (cum.gasIn - ref.gasIn) + (cum.flash - ref.flash) + (cum.gaugeFlash - ref.gaugeFlash) + (cum.vacBreak - ref.vacBreak);
    var rG = src - ((cum.flare - ref.flare) + (cum.gaugeVent - ref.gaugeVent) + (invGas() - ref.gas));
    out.oil = rO / mmax(mabs(dO), 1); out.water = rW / mmax(mabs(dW), 1); out.gas = rG / mmax(mabs(src), 1);
    return out;
  }

  // ── initialisation ──
  function newTank(k) {
    return { tag: k === 0 ? TAGS.gaugeA : TAGS.gaugeB, Vo: 0, Vw: 0, T: Tamb, state: 'ready', since: 0,
      win: null, drO: 0, drW: 0 };
  }
  function openWindow(k) {
    var tk = tanks[k];
    tk.win = { tOpen: t, openOil: tk.Vo, cumOil0: cum.gaugeOil, cumWater0: cum.gaugeWater, gas0: cum.sepGas, Tint: 0, tInt: 0 };
  }
  function initState(m) {
    mode = m === 'empty' ? 'empty' : 'steady';
    t = 0; zeroCum();
    xiG = 0; xiL = 0; xiW = 0; spare = null;
    lcvO = { cmd: 0, x: 0, I: 0 }; lcvW = { cmd: 0, x: 0, I: 0 };
    psvLift = false; psvULift = false; pumpTrip = false;
    Zs = 0; Zu = 0;
    tanks = [newTank(0), newTank(1)]; active = 0; batches = []; batchN = 0;
    oilCycles = 0; waterCycles = 0;
    SPe = SP; SPeu = PspU;
    graceUntil = cfg.startupGrace;
    var TR, Pa;
    if (mode === 'steady') {
      qBg = qgE; qBo = qoE; qBw = qwE;
      esdTravel = 1; theta = 1; Pwh = Pwh_ss; PB = Pci_ss; tFlow = 0; tShut = 0; P0shut = Pwh_ss; shut = false;
      f = qgD > 0 ? qgE / qgD : ((qoD + qwD) > 0 ? (qoE + qwE) / (qoD + qwD) : 0); fInst = f;
      Tsep = Tsep_ss; TR = Tsep + RANK; Pa = SP + PSC; PsepA = Pa;
      Bs = BoR(Pa, Tsep);
      var crest = qoE * Bs > 0 ? mpow(qoE * Bs * BBL / (3.33 * Lw), 2 / 3) : 0;
      Vw1 = lutC1.V(0.25 * D);
      Vo1 = mmax(0, lutC1.V(mmin(hWeir + crest, 0.95 * D)) - Vw1) / Bs;
      Vw2 = 0; Vo2 = lutB.V(0.325 * D) / Bs;
      var vg = BBL * (Vves - Vw1 - Vo1 * Bs - Vo2 * Bs);
      n_s = Pa * vg * TSC / (Zf(Pa, TR) * TR * PSC);
      Ipcv = 0; upcv = 0.5;
      // surge at 0.55, pump running (mid-drawdown), at its setpoint
      Tu = Tsep; var PuA0 = PspU + PSC; PuA = PuA0; Bu = BoR(PuA0, Tu);
      var ao = qoE * Bu, aw = qwE, ro = (ao + aw) > 1e-15 ? ao / (ao + aw) : 0.8;
      var VlU = 0.55 * capU; Vou = VlU * ro / Bu; Vwu = VlU * (1 - ro);
      n_u = PuA0 * mmax(1, (capU - VlU) * BBL) * TSC / (Zf(PuA0, Tu + RANK) * (Tu + RANK) * PSC);
      pumpOn = true;
      // gauge A filling at 30 % (0.8/0.2 oil/water), B ready and empty
      tanks[0].T = Tsep; tanks[1].T = Tsep;
      var VlA = 0.30 * capG; tanks[0].Vw = 0.2 * VlA; tanks[0].Vo = 0.8 * VlA / tankBo(0);
      emaOil = qoE; emaWater = qwE; emaGas = qgE; emaFlash = qFlashD;
    } else {
      qBg = 0; qBo = 0; qBw = 0; f = 0; fInst = 0;
      esdTravel = 1; theta = 0; Pwh = Pwh_ss; PB = 0; tFlow = 0; tShut = 0; P0shut = Pwh_ss; shut = false;
      Tsep = Tamb; TR = Tsep + RANK; PsepA = PSC;
      Vw1 = 0; Vo1 = 0; Vw2 = 0; Vo2 = 0;
      n_s = PSC * Vves * BBL * TSC / (Zf(PSC, TR) * TR * PSC);
      Ipcv = 0; upcv = 0;
      Tu = Tamb; PuA = PSC; Vou = 0; Vwu = 0;
      n_u = PSC * capU * BBL * TSC / (Zf(PSC, Tu + RANK) * (Tu + RANK) * PSC);
      pumpOn = false;
      emaOil = 0; emaWater = 0; emaGas = 0; emaFlash = 0;
    }
    tanks[0].state = 'filling'; tanks[0].since = 0; tanks[1].state = 'ready'; tanks[1].since = 0;
    openWindow(0);
    esdS.tripped = false; esdS.manual = false; esdS.cause = null; esdS.causeMsg = ''; esdS.tripT = null;
    AL = {}; alarmOrder = []; alarmLog = [];
    for (var k in F) if (typeof F[k] === 'number') F[k] = 0;
    F.drO = [0, 0]; F.drW = [0, 0]; F.rG = [0, 0];
    algebraic();
    limits(0);
    // PI preloads
    Ibpv = 0; ubpv = 0; ublk = 0;
    if (mode === 'steady') {
      var cap = gq(Cv_bpv, PuA, PSC + mmin(cfg.sep.pcv.P2_psig, 0.4 * SPeu), Tu + RANK, Zu);
      ubpv = cap > 0 ? clamp(qFlashD / cap, 0, 1) : 0;
      var kc = bpvKc();
      Ibpv = kc > 0 ? ((ubpv - bpvBias()) / kc) * cfg.surge.bpv.Ti : 0;
    }
    primeFluxes();
    alarmsDirty = true;
    setRef();
    histReset();
    histSample(true);
    lagging = false; droppedSimSec = 0; lastSubsteps = 0;
  }
  var esdS = { tripped: false, manual: false, cause: null, causeMsg: '', tripT: null };
  // flux estimate from the initial state (no integration) so the t = 0 snapshot shows flows, flame and meters
  function primeFluxes() {
    var TR = Tsep + RANK, P2a = PSC + cfg.sep.pcv.P2_psig;
    fE = clamp(esdTravel / 0.25, 0, 1); mg = 1; ml = 1;
    F.inG = qBg * fE; F.inO = qBo * fE; F.inW = qBw * fE;
    F.pcvCap = gq(Cv_pcv, PsepA, P2a, TR, Zs); F.pcv = upcv * F.pcvCap;
    F.bpvCap = gq(Cv_bpv, PuA, P2aU, Tu + RANK, Zu); F.bpv = ubpv * F.bpvCap;
    var Hw = hL1 - mmax(hWeir, h2);
    F.qOver = Hw > 0 ? 3.33 * Lw * mpow(Hw, 1.5) / BBL : 0; F.weirO = F.qOver / Bs; F.weirW = 0;
    F.pumpBpd = (pumpOn && !pumpTrip && !faults.surgePumpFail) ? pumpDesign : 0;
    var Qp = F.pumpBpd / 86400;
    if (Qp > 0 && VliqU > 1e-9) { F.pw = Qp * Vwu / VliqU; F.po = Qp * (Vou * Bu / VliqU) / Bu; } else { F.pw = 0; F.po = 0; }
    F.gvent = F.po * RsE(PuA, Tu);
    F.rB = F.qOver; F.rW1 = F.inW; F.rU = -Qp; F.rG[active] = F.po * Bu + F.pw;
  }

  // ── controllers helpers ──
  function pcvKc() {
    var TR = Tsep + RANK, SPa = SPe + PSC, P2a = PSC + cfg.sep.pcv.P2_psig, P1 = mmax(PsepA, SPa);
    var Kp = Zs * TR * PSC / (TSC * Vg) * gq(Cv_pcv, P1, P2a, TR, Zf(P1, TR));
    var Pspan = mmax(SPe, 50);
    return Kp > 1e-12 ? Pspan / (Kp * tauClSep()) : 0;
  }
  // closed-loop time of PCV-101: cfg tauCl, but never slower than 1.5× the vessel's gas residence time
  // (a small separator at high throughput would otherwise swing tens of psi on gas-rate noise)
  function tauClSep() {
    var tg = n_s / mmax(qBg * clamp(esdTravel / 0.25, 0, 1), F.pcvCap * 0.5, 1e-9);
    return mmax(0.5, mmin(cfg.sep.pcv.tauCl, 1.5 * tg));
  }
  function bpvKc() {
    var TRu = Tu + RANK, SPa = SPeu + PSC, P2 = PSC + mmin(cfg.sep.pcv.P2_psig, 0.4 * SPeu), P1 = mmax(PuA, SPa);
    var Kp = Zu * TRu * PSC / (TSC * VgU) * gq(Cv_bpv, P1, P2, TRu, Zf(P1, TRu));
    var Pspan = mmax(SPeu, 20);
    return Kp > 1e-12 ? Pspan / (Kp * cfg.surge.bpv.tauCl) : 0;
  }
  // Feed-forward bias of the pressure PIs (= designOpen 0.5 at design inflow and SP). The vent that holds P is
  // gas inflow + gas displaced by the net liquid inflow − gas stored to follow the SP_eff ramp:
  //   vent = q_in + (n/Vg)·5.614583·dV_liq/dt − (n/Pa)·dSP_eff/dt        (last-substep fluxes; blanket excluded)
  // so SP ramps and dump pulses track without integral wind-up; the PI trims noise and model error.
  var dSPe = 0, dSPeu = 0;
  function pcvBias() {
    var TR = Tsep + RANK, P1 = mmax(PsepA, SPe + PSC);
    var cap = gq(Cv_pcv, P1, PSC + cfg.sep.pcv.P2_psig, TR, Zf(P1, TR));
    if (!(cap > 0)) return 0;
    var dVl = (F.inO * Bs + F.inW) - (F.oO * Bs + F.oW + F.wW + F.wO * Bs);
    return clamp((qBg * clamp(esdTravel / 0.25, 0, 1) + n_s / mmax(Vg, 1e-6) * BBL * dVl - n_s / mmax(PsepA, 1) * dSPe) / cap, 0, 1);
  }
  function bpvBias() {
    var TRu = Tu + RANK, P1 = mmax(PuA, SPeu + PSC);
    var cap = gq(Cv_bpv, P1, P2aU, TRu, Zf(P1, TRu));
    if (!(cap > 0)) return 0;
    var dVl = (F.oO + F.wO) * Bs + F.oW + F.wW - (F.po * Bu + F.pw);
    return clamp((F.flash + F.blowO + F.blowW + n_u / mmax(VgU, 1e-6) * BBL * dVl - n_u / mmax(PuA, 1) * dSPeu) / cap, 0, 1);
  }
  function limits(h) {
    var r = cfg.ramp, s0 = SPe, s0u = SPeu;
    SPe += clamp(SP - SPe, -r.spRate * h, r.spRate * h);
    dSPe = h > 0 ? (SPe - s0) / h : 0;
    var S = cfg.sep;
    psh = S.psh != null ? +S.psh : SPe + mmax(0.10 * SPe, 15);
    pshh = S.pshh != null ? +S.pshh : SPe + mmax(0.20 * SPe, 25);
    psl = S.psl != null ? +S.psl : SPe - mmax(0.20 * SPe, 20);
    var SPhi = mmax(SP, SPe);
    mawpE = mmax(num(S.mawp, 1440), 1.25 * (SPhi + mmax(0.20 * SPhi, 25)));
    SPeu += clamp(PspU - SPeu, -r.surgeSpRate * h, r.surgeSpRate * h);
    dSPeu = h > 0 ? (SPeu - s0u) / h : 0;
    var U = cfg.surge;
    pshU = U.psh != null ? +U.psh : SPeu + mmax(0.25 * SPeu, 7);
    pshhU = U.pshh != null ? +U.pshh : SPeu + mmax(0.50 * SPeu, 15);
    mawpU = mawpUof(mmax(PspU, SPeu));
    P2aU = PSC + mmin(cfg.sep.pcv.P2_psig, 0.4 * SPeu);
  }
  function bumpless(cvP, cvB) {                // after re-sizing: keep the valve FLOW (u·Cv) continuous, then back-solve I
    if (cvP > 0 && Cv_pcv > 0) upcv = clamp(upcv * cvP / Cv_pcv, 0, 1);
    if (cvB > 0 && Cv_bpv > 0) ubpv = clamp(ubpv * cvB / Cv_bpv, 0, 1);
    var kc = pcvKc(), e = (Psep - SPe) / mmax(SPe, 50);
    if (kc > 0) Ipcv = ((upcv - pcvBias()) / kc - e) * cfg.sep.pcv.Ti;
    var kcu = bpvKc(), eu = (Pu - SPeu) / mmax(SPeu, 20);
    if (kcu > 0) Ibpv = ((ubpv - bpvBias()) / kcu - eu) * cfg.surge.bpv.Ti;
  }

  // ── gauge tank state machine helpers ──
  function doSwitch(forced) {
    var a = active, b = 1 - a;
    closeWindow(a);
    tanks[a].state = 'settling'; tanks[a].since = t;
    tanks[b].state = 'filling'; tanks[b].since = t;
    active = b; openWindow(b);
    var tag = tanks[b].tag;
    emit('switch', { type: 'switch', t: t, from: a, to: b, tag: tag, forced: !!forced });
    logEntry('switch', 'SWITCH', null, tag, 'Gauge tank switched to ' + tag + (forced ? ' (manual)' : ''));
  }
  function closeWindow(k) {
    var tk = tanks[k], w = tk.win; if (!w) return;
    w.tClose = t; w.closeOil = tk.Vo; w.oil = cum.gaugeOil - w.cumOil0; w.water = cum.gaugeWater - w.cumWater0;
    w.gas = cum.sepGas - w.gas0; w.avgT = w.tInt > 0 ? w.Tint / w.tInt : tk.T; w.Tclose = tk.T;
    tk.pend = w; tk.win = null;
  }
  function recordBatch(k) {
    var tk = tanks[k], w = tk.pend; if (!w) return;
    tk.pend = null;
    var hours = mmax(1e-6, (w.tClose - w.tOpen) / 3600);
    var oil = w.oil, water = w.water, gasM = w.gas / 1000;
    var gov = oil * BoR(PSC, w.avgT) + water;
    batchN++;
    var b = { n: batchN, tag: tk.tag, tOpen: w.tOpen, tClose: w.tClose, hours: hours, openOil_stb: w.openOil, closeOil_stb: w.closeOil,
      oil_stb: oil, water_bbl: water, gov_bbl: gov, bsw_pct: oil < 1e-6 ? null : water / (oil + water) * 100,
      oilRate_stbd: oil / (hours / 24), waterRate_bpd: water / (hours / 24), gas_mscf: gasM,
      gor_scf_stb: oil < 1e-6 ? null : gasM * 1000 / oil, avgT: w.avgT };
    batches.push(b); if (batches.length > 20) batches.shift();
    var p = { type: 'batch', t: t }; for (var kk in b) p[kk] = b[kk];
    emit('batch', p);
    logEntry('batch', 'BATCH', null, tk.tag, 'Batch ' + b.n + ' ' + tk.tag + ': ' + b.oil_stb.toFixed(1) + ' STB · ' + b.oilRate_stbd.toFixed(0) + ' STB/d');
  }

  // ── events & log ──
  function emit(name, payload) { evq.push(name, payload); }
  function logEntry(type, id, sev, tag, msg) {
    alarmLog.push({ t: t, id: id, type: type, sev: sev === undefined ? null : sev, tag: tag || '', msg: msg || '' });
    if (alarmLog.length > 50) alarmLog.shift();
  }
  function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (evq.length) {
        var name = evq.shift(), p = evq.shift(), hs = handlers[name];
        if (hs && hs.length) {
          var list = hs.slice();
          for (var i = 0; i < list.length; i++) { try { list[i](p, snap); } catch (e) { /* handler errors never break the sim */ } }
        }
      }
    } finally { flushing = false; }
    while (deferred.length && !disposed) { var fn = deferred.shift(); fn(); }
  }

  // ── alarms ──
  function aDef(id, tag, sev, eq, kind, grace) {
    var A = AL[id];
    if (!A) { A = AL[id] = { id: id, tag: tag, sev: sev, eq: eq, kind: kind, grace: !!grace, active: false, onT: -1, offT: -1,
      msg: '', value: null, limit: null, since: 0, pub: { id: id, tag: tag, sev: sev, eq: eq, msg: '', value: null, limit: null, since: 0 } }; }
    return A;
  }
  function raise(A, value, limit, msg) {
    alarmsDirty = true;
    A.active = true; A.since = t; A.value = isNum(value) ? value : null; A.limit = isNum(limit) ? limit : null; A.msg = msg; A.offT = -1;
    emit('alarm', alarmPayload('alarm', A));
    logEntry('raise', A.id, A.sev, A.tag, msg);
    if (A.sev === 'trip' && A.id !== 'ESD_TRIPPED') autoTrip(A);
  }
  function clearA(A) {
    if (!A.active) return;
    alarmsDirty = true;
    A.active = false; A.onT = -1; A.offT = -1;
    emit('clear', alarmPayload('clear', A));
    logEntry('clear', A.id, A.sev, A.tag, A.msg);
  }
  function alarmPayload(type, A) {
    return { type: type, t: t, id: A.id, tag: A.tag, sev: A.sev, eq: A.eq, msg: A.msg, value: A.value, limit: A.limit, since: A.since };
  }
  // hi/lo analog alarm with delays + deadband; bool alarms use db = 0 and value 1/0
  function evalA(A, cond, clr, value, limit, msgFn, delayed) {
    var sup = A.grace && (t < graceUntil || esdS.tripped || esdTravel < 0.999);
    if (sup) { if (A.active) clearA(A); A.onT = -1; return; }
    var dOn = delayed ? cfg.alarm.onDelay : 0, dOff = delayed ? cfg.alarm.offDelay : 0;
    if (!A.active) {
      if (cond) { if (A.onT < 0) A.onT = t; if (t - A.onT >= dOn - 1e-9) raise(A, value, limit, msgFn(value, limit)); }
      else A.onT = -1;
    } else {
      A.value = isNum(value) ? value : null; A.limit = isNum(limit) ? limit : null;
      if (clr) { if (A.offT < 0) A.offT = t; if (t - A.offT >= dOff - 1e-9) clearA(A); }
      else A.offT = -1;
    }
  }
  function mHi(tagTxt, what, unit) { return function (v, l) { return tagTxt + ' ' + what + ' ' + rnd(v) + unit + ' ≥ ' + rnd(l) + unit; }; }
  function mLo(tagTxt, what, unit) { return function (v, l) { return tagTxt + ' ' + what + ' ' + rnd(v) + unit + ' ≤ ' + rnd(l) + unit; }; }
  var MSG = {
    PSHH_SEP: mHi('PSHH-101', 'separator', ' psig'), PSH_SEP: mHi('PAH-101', 'separator pressure high', ' psig'),
    PSL_SEP: mLo('PAL-101', 'separator pressure low', ' psig'),
    PSV_SEP: function (v, l) { return 'PSV-101 lifting — separator ' + rnd(v) + ' psig (set ' + rnd(l) + ')'; },
    LSHH_SEP: mHi('LSHH-102', 'separator level high-high', '%'), LSH_SEP: mHi('LAH-102', 'oil bucket level high', '%'),
    LSLL_SEP: mLo('LALL-102', 'oil bucket level low-low', '%'),
    GAS_BLOWBY: function (v) { return 'LCV-102 gas blow-by to surge tank ' + (isNum(v) ? v.toFixed(2) : '—') + ' MMSCFD'; },
    ISHH_SEP: mHi('LAHH-101', 'interface level high-high', '%'),
    CARRYOVER: function (v) { return 'V-101 water carry-over at the weir (interface ' + rnd(v) + '%)'; },
    OIL_IN_WATER: function () { return 'LCV-101 passing oil — interface lost'; },
    PSHH_SURGE: mHi('PSHH-201', 'surge tank', ' psig'), PSH_SURGE: mHi('PAH-201', 'surge tank pressure high', ' psig'),
    PSV_SURGE: function (v, l) { return 'PSV-201 lifting — surge tank ' + rnd(v) + ' psig (set ' + rnd(l) + ')'; },
    LSHH_SURGE: mHi('LSHH-201', 'surge tank level', '%'),
    LSLL_SURGE: function (v, l) { return 'LSLL-201 surge tank level ' + rnd(v) + '% ≤ ' + rnd(l) + '% — P-201 tripped'; },
    PUMP_FAIL: function () { return 'P-201 transfer pump failed'; },
    LAH_GT: function (v) { return 'LAH-301 ' + tanks[active].tag + ' ' + rnd(v) + '% full — no standby compartment ready'; },
    LSHH_GT: function (v, l) { return 'LSHH-301 ' + tanks[active].tag + ' level ' + rnd(v) + '% ≥ ' + rnd(l) + '%'; }
  };
  function processAlarms() {
    var S = cfg.sep, dbP = cfg.alarm.pressDBfrac * mmax(SPe, 1), dbL = cfg.alarm.levelDB * D;
    var A;
    A = aDef('PSHH_SEP', 'PSHH-101', 'trip', 'separator', 'p');
    evalA(A, Psep >= pshh, Psep < pshh - dbP, Psep, pshh, MSG.PSHH_SEP, false);
    A = aDef('PSH_SEP', 'PAH-101', 'alarm', 'separator', 'p');
    evalA(A, Psep >= psh, Psep < psh - dbP, Psep, psh, MSG.PSH_SEP, true);
    A = aDef('PSL_SEP', 'PAL-101', 'warn', 'separator', 'p', true);
    evalA(A, Psep <= psl && f > 0.5, Psep > psl + dbP || f <= 0.5, Psep, psl, MSG.PSL_SEP, true);
    A = aDef('PSV_SEP', 'PSV-101', 'alarm', 'separator', 'b');
    evalA(A, psvLift, !psvLift, Psep, mawpE, MSG.PSV_SEP, false);
    var lshhO = S.oil.lshh * D, lahhT = S.lahhTotal * D;
    A = aDef('LSHH_SEP', 'LSHH-102', 'trip', 'separator', 'l');
    var lv = mmax(h2 / mmax(lshhO, 1e-9), hL1 / mmax(lahhT, 1e-9));
    var useB = h2 / lshhO >= hL1 / lahhT;
    evalA(A, h2 >= lshhO || hL1 >= lahhT, h2 < lshhO - dbL && hL1 < lahhT - dbL,
      (useB ? h2 : hL1) / D * 100, (useB ? S.oil.lshh : S.lahhTotal) * 100, MSG.LSHH_SEP, false);
    var lshB = (S.oil.lsh + 0.03) * D;
    A = aDef('LSH_SEP', 'LAH-102', 'alarm', 'separator', 'l');
    evalA(A, h2 >= lshB, h2 < lshB - dbL, h2 / D * 100, lshB / D * 100, MSG.LSH_SEP, true);
    A = aDef('LSLL_SEP', 'LALL-102', 'alarm', 'separator', 'l', true);
    evalA(A, h2 <= S.oil.lsll * D, h2 > S.oil.lsll * D + dbL, h2 / D * 100, S.oil.lsll * 100, MSG.LSLL_SEP, true);
    var blow = F.blowO + F.blowW;
    A = aDef('GAS_BLOWBY', 'LCV-102', 'alarm', 'separator', 'b');
    evalA(A, blow > 0, !(blow > 0), blow * 0.0864, null, MSG.GAS_BLOWBY, true);
    A = aDef('ISHH_SEP', 'LAHH-101', 'alarm', 'separator', 'l');
    evalA(A, hW1 >= S.water.lshh * D, hW1 < S.water.lshh * D - dbL, hW1 / D * 100, S.water.lshh * 100, MSG.ISHH_SEP, true);
    A = aDef('CARRYOVER', 'V-101', 'warn', 'separator', 'b');
    evalA(A, F.phiC > 0, !(F.phiC > 0), hW1 / D * 100, hWeir / D * 100, MSG.CARRYOVER, true);
    A = aDef('OIL_IN_WATER', 'LCV-101', 'warn', 'separator', 'b', true);
    evalA(A, F.wO > 0, !(F.wO > 0), F.wO * 86400, null, MSG.OIL_IN_WATER, true);
    var U = cfg.surge, dbPu = cfg.alarm.pressDBfrac * mmax(SPeu, 1), fracU = hU / Hu, dbLu = cfg.alarm.levelDB;
    A = aDef('PSHH_SURGE', 'PSHH-201', 'trip', 'surge', 'p');
    evalA(A, Pu >= pshhU, Pu < pshhU - dbPu, Pu, pshhU, MSG.PSHH_SURGE, false);
    A = aDef('PSH_SURGE', 'PAH-201', 'alarm', 'surge', 'p');
    evalA(A, Pu >= pshU, Pu < pshU - dbPu, Pu, pshU, MSG.PSH_SURGE, true);
    A = aDef('PSV_SURGE', 'PSV-201', 'alarm', 'surge', 'b');
    evalA(A, psvULift, !psvULift, Pu, mawpU, MSG.PSV_SURGE, false);
    A = aDef('LSHH_SURGE', 'LSHH-201', 'trip', 'surge', 'l');
    evalA(A, fracU >= U.lshh, fracU < U.lshh - dbLu, fracU * 100, U.lshh * 100, MSG.LSHH_SURGE, false);
    A = aDef('LSLL_SURGE', 'LSLL-201', 'warn', 'pump', 'l', true);
    evalA(A, fracU <= U.lsll, fracU > U.lsll + dbLu, fracU * 100, U.lsll * 100, MSG.LSLL_SURGE, true);
    A = aDef('PUMP_FAIL', 'P-201', 'alarm', 'pump', 'b');
    evalA(A, faults.surgePumpFail, !faults.surgePumpFail, null, null, MSG.PUMP_FAIL, false);
    var Gc = cfg.gauge, fa = tankVliq(active) / capG, noStandby = tanks[1 - active].state !== 'ready';
    A = aDef('LAH_GT', 'LAH-301', 'alarm', 'gauge', 'l');
    evalA(A, fa >= Gc.switchFrac && noStandby, fa < Gc.switchFrac - 0.02 || !noStandby, fa * 100, Gc.switchFrac * 100, MSG.LAH_GT, true);
    A = aDef('LSHH_GT', 'LSHH-301', 'trip', 'gauge', 'l');
    evalA(A, fa >= Gc.lahh, fa < Gc.lahh - 0.02, fa * 100, Gc.lahh * 100, MSG.LSHH_GT, false);
  }
  function autoTrip(A) {
    if (esdS.tripped && !esdS.manual) return;
    var wasManual = esdS.tripped && esdS.manual;
    esdS.tripped = true; esdS.manual = false; esdS.cause = A.id; esdS.causeMsg = A.msg; esdS.tripT = t;
    if (wasManual && AL.ESD_MANUAL) clearA(AL.ESD_MANUAL);
    var E = aDef('ESD_TRIPPED', 'SDV-101', 'trip', 'esd', 'x');
    if (!E.active) raise(E, A.value, A.limit, 'ESD tripped — ' + A.msg);
    emit('trip', { type: 'trip', t: t, cause: A.id, tag: A.tag, msg: A.msg, value: A.value, limit: A.limit, manual: false });
    logEntry('trip', A.id, 'trip', A.tag, 'ESD tripped — ' + A.msg);
  }

  // ── history ──
  function histReset() {
    var n = mmax(2, cfg.histLen | 0);
    H = { n: n, i: 0, c: 0, next: 0, t: new Float64Array(n), k: {} };
    HIST_KEYS.forEach(function (k) { H.k[k] = new Float64Array(n); });
  }
  function histSample(force) {
    if (!force && t < H.next - 1e-9) return;
    var i = H.i;
    H.t[i] = t;
    H.k.Psep[i] = Psep; H.k.PsepSP[i] = SPe; H.k.bucketFrac[i] = h2 / D; H.k.ifaceFrac[i] = hW1 / D; H.k.c1Frac[i] = hL1 / D;
    H.k.surgeFrac[i] = hU / Hu; H.k.surgeP[i] = Pu; H.k.gaugeFracA[i] = tankVliq(0) / capG; H.k.gaugeFracB[i] = tankVliq(1) / capG;
    H.k.qgFlare[i] = (F.pcv + F.psv + F.bpv + F.psvU) * 0.0864; H.k.qoMeter[i] = emaOil * 86400; H.k.Pwh[i] = Pwh;
    H.k.Pchoke[i] = Psep + (Pck_ss - Psep_ss) * fInst * fInst; H.k.Twh[i] = Tamb + (Twh_ss - Tamb) * theta;
    H.i = (i + 1) % H.n; if (H.c < H.n) H.c++;
    var dt = mmax(0.1, cfg.histDt);
    H.next = (mfloor(t / dt + 1e-9) + 1) * dt;
  }

  // ── one substep (§4.13 order) ──
  function substep(h) {
    var S = cfg.sep, U = cfg.surge, Gc = cfg.gauge, N = cfg.noise, Rr = cfg.ramp;
    var i;
    // 2 (first, so discrete logic uses the current limits): SP ramps + SP_eff-based limits
    limits(h);
    // 1 discrete logic
    var VB = Vw2 + Vo2 * Bs;
    if (faults.oilDumpStuckOpen) lcvO.cmd = 1;
    else if (faults.oilDumpStuckClosed) lcvO.cmd = 0;
    else if (S.oil.mode === 'pi') lcvO.cmd = levelPI(lcvO, h2, S.oil, h);
    else if (VB >= VB_hi - 1e-12) { if (lcvO.cmd < 0.5) oilCycles++; lcvO.cmd = 1; }
    else if (VB <= VB_lo + 1e-12) lcvO.cmd = 0;
    if (faults.waterDumpStuckClosed) lcvW.cmd = 0;
    else if (S.water.mode === 'pi') lcvW.cmd = levelPI(lcvW, hW1, S.water, h);
    else if (Vw1 >= VW_hi - 1e-12) { if (lcvW.cmd < 0.5) waterCycles++; lcvW.cmd = 1; }
    else if (Vw1 <= VW_lo + 1e-12) lcvW.cmd = 0;
    var fracU = VliqU / capU;
    if (pumpTrip && fracU > U.lsl) pumpTrip = false;
    if (fracU <= U.lsll) pumpTrip = true;
    if (fracU >= U.lsh - 1e-12) pumpOn = true; else if (fracU <= U.lsl + 1e-12) pumpOn = false;
    for (i = 0; i < 2; i++) {
      var tk = tanks[i];
      if (tk.state === 'settling' && t - tk.since >= Gc.settleS - 1e-9) { recordBatch(i); tk.state = 'draining'; tk.since = t; }
      if (tk.state === 'draining' && tankVliq(i) <= Gc.heelFrac * capG + 1e-9) { tk.state = 'ready'; tk.since = t; }
    }
    if (tankVliq(active) >= Gc.switchFrac * capG - 1e-9 && tanks[1 - active].state === 'ready') doSwitch(false);
    if (!psvLift && Psep >= mawpE) psvLift = true; else if (psvLift && Psep <= 0.93 * mawpE) psvLift = false;
    if (!psvULift && Pu >= mawpU) psvULift = true; else if (psvULift && Pu <= 0.93 * mawpU) psvULift = false;

    // 3 fluxes
    // valve travel over this substep: new position + exact time-average of the (clamped) ramp
    slew(lcvO.x, lcvO.cmd, h, S.oil.strokeS, S.oil.strokeS); var xOav = SLEW.avg, xOnew = SLEW.x;
    slew(lcvW.x, lcvW.cmd, h, S.water.strokeS, S.water.strokeS); var xWav = SLEW.avg, xWnew = SLEW.x;
    slew(esdTravel, esdS.tripped ? 0 : 1, h, Rr.esdOpenS, Rr.esdCloseS); var trAv = SLEW.avg, trNew = SLEW.x;
    fE = clamp(trAv / 0.25, 0, 1);
    var slug = 0;
    if (faults.slugging || N.slug.on) {
      var per = mmax(1, N.slug.period), wd = clamp(N.slug.width, 0, per);
      slug = N.slug.amp * (((t % per) < wd) ? 1 : 0) - N.slug.amp * wd / per;
    }
    mg = N.on ? mmax(0, 1 + N.gasSigma * xiG) : 1;
    ml = mmax(0, 1 + (N.on ? N.liqSigma * xiL : 0) + slug);
    var qInG = qBg * fE * mg, qInO = qBo * fE * ml, qInW = qBw * fE * ml;
    var TR = Tsep + RANK, P2a = PSC + S.pcv.P2_psig;
    // PCV-101 gain-scheduled PI
    var Pspan = mmax(SPe, 50), e = (Psep - SPe) / Pspan;
    var qCapPcv = gq(Cv_pcv, PsepA, P2a, TR, Zs);
    var P1k = mmax(PsepA, SPe + PSC);
    var Kp = Zs * TR * PSC / (TSC * Vg) * gq(Cv_pcv, P1k, P2a, TR, Zf(P1k, TR));
    var Kc = Kp > 1e-12 ? Pspan / (Kp * tauClSep()) : 0;
    var uRaw = pcvBias() + Kc * (e + Ipcv / S.pcv.Ti);
    upcv = clamp(uRaw, 0, 1);
    if ((uRaw > 0 && uRaw < 1) || (uRaw >= 1 && e < 0) || (uRaw <= 0 && e > 0)) Ipcv += e * h;
    if (faults.pcvStuckClosed) upcv = 0; else if (faults.pcvStuckOpen) upcv = 1;
    var qPcv = upcv * qCapPcv;
    var qPsv = psvLift ? gq(Cv_psv, PsepA, P2a, TR, Zs) : 0;
    // liquids
    var TRu = Tu + RANK;
    var VLB = Vw2 + Vo2 * Bs;
    var SGB = VLB > 1e-12 ? (Vw2 + Vo2 * Bs * SGo) / VLB : SGo;
    var dPo = (Psep - Pu) + WGRAD * SGB * h2;
    var capO = xOav * liqQ(Cv_o, dPo, SGB);
    var phiL = clamp(VLB / 0.02, 0, 1);
    var qLo = capO * phiL;
    var oW = mmin(qLo, Vw2 / h), oObbl = mmin(qLo - oW, Vo2 * Bs / h);
    var qBlowO = (xOav > 0 && phiL < 1) ? xOav * (1 - phiL) * gq(Cv_o, PsepA, PuA, TR, Zs) : 0;
    var dPw = (Psep - Pu) + WGRAD * (hW1 + SGo * (hL1 - hW1));
    var capW = xWav * liqQ(Cv_w, dPw, 1.0);
    var phiW = clamp(Vw1 / 0.02, 0, 1);
    var wW = mmin(capW * phiW, Vw1 / h);
    var phiO1 = clamp(Vo1 * Bs / 0.02, 0, 1);
    var wObbl = mmin(capW * (1 - phiW) * phiO1, Vo1 * Bs / h);
    var qBlowW = (xWav > 0 && phiW < 1 && phiO1 < 1) ? xWav * (1 - phiW) * (1 - phiO1) * gq(Cv_w, PsepA, PuA, TR, Zs) : 0;
    // weir (Francis)
    var Hw = hL1 - mmax(hWeir, h2);
    var qOver = Hw > 0 ? 3.33 * Lw * mpow(Hw, 1.5) / BBL : 0;
    var phiC = clamp((hW1 - (hWeir - 1 / 12)) / (1 / 12), 0, 1);
    var weirW = mmin(phiC * qOver, Vw1 / h), weirObbl = mmin((1 - phiC) * qOver, Vo1 * Bs / h);
    // blanket PCV-202 (P-only), closed when the separator itself is below 90 % of its setpoint
    ublk = (U.blanket.on && Psep >= 0.9 * SPe) ? clamp((SPeu - U.blanket.deadband - Pu) / mmax(U.blanket.band, 0.1), 0, 1) : 0;
    var qBlk = ublk > 0 ? mmin(ublk * gq(Cv_mk, PsepA, PuA, TR, Zs), 0.5 * n_s / h) : 0;
    // surge: flash, BPV PI, PSV, pump
    var qFlash = 0;                             // flash of the dumped oil at the surge tank (set after the limiters)
    var PspanU = mmax(SPeu, 20), eU = (Pu - SPeu) / PspanU;
    var qCapBpv = gq(Cv_bpv, PuA, P2aU, TRu, Zu);
    var P1u = mmax(PuA, SPeu + PSC);
    var KpU = Zu * TRu * PSC / (TSC * VgU) * gq(Cv_bpv, P1u, P2aU, TRu, Zf(P1u, TRu));
    var KcU = KpU > 1e-12 ? PspanU / (KpU * U.bpv.tauCl) : 0;
    var uRawU = bpvBias() + KcU * (eU + Ibpv / U.bpv.Ti);
    ubpv = clamp(uRawU, 0, 1);
    if ((uRawU > 0 && uRawU < 1) || (uRawU >= 1 && eU < 0) || (uRawU <= 0 && eU > 0)) Ibpv += eU * h;
    var qBpv = ubpv * qCapBpv;
    var qPsvU = psvULift ? gq(Cv_psvU, PuA, P2a, TRu, Zu) : 0;
    var pumpBpd = (faults.surgePumpFail || pumpTrip || !pumpOn) ? 0 : pumpDesign;
    var Qp = pumpBpd / 86400, po = 0, pw = 0;
    if (Qp > 0 && VliqU > 1e-9) { pw = mmin(Qp * (Vwu / VliqU), Vwu / h); po = mmin(Qp * (Vou * Bu / VliqU) / Bu, Vou / h); }
    var gvent = po * RsE(PuA, Tu);
    // gauge drains
    var drO0 = 0, drW0 = 0, drO1 = 0, drW1 = 0;
    for (i = 0; i < 2; i++) {
      if (tanks[i].state !== 'draining') continue;
      var vl = tankVliq(i), bg = tankBo(i), Qd = drainBpd / 86400, dro = 0, drw = 0;
      if (vl > 1e-9) { drw = mmin(Qd * tanks[i].Vw / vl, tanks[i].Vw / h); dro = mmin(Qd * tanks[i].Vo * bg / vl / bg, tanks[i].Vo / h); }
      if (i === 0) { drO0 = dro; drW0 = drw; } else { drO1 = dro; drW1 = drw; }
    }

    // 4 flux limiters (outflow ≤ inventory/h per source)
    var sc, out;
    var weirO = weirObbl / Bs, oO = oObbl / Bs, wO = wObbl / Bs;
    out = weirO + wO; if (out * h > Vo1) { sc = Vo1 / (out * h); weirO *= sc; wO *= sc; }
    out = weirW + wW; if (out * h > Vw1) { sc = Vw1 / (out * h); weirW *= sc; wW *= sc; }
    out = qPcv + qPsv + qBlk + qBlowO + qBlowW;
    if (out * h > n_s) { sc = n_s / (out * h); qPcv *= sc; qPsv *= sc; qBlk *= sc; qBlowO *= sc; qBlowW *= sc; }
    out = qBpv + qPsvU; if (out * h > n_u) { sc = n_u / (out * h); qBpv *= sc; qPsvU *= sc; }
    qFlash = (oO + wO) * mmax(0, RsE(PsepA, Tsep) - RsE(PuA, Tu));

    // 5 explicit update: every flux leaves its source and enters its sink in this block
    var a = active, ta = tanks[a];
    n_s += (qInG - qPcv - qPsv - qBlk - qBlowO - qBlowW) * h;
    Vo1 += (qInO - weirO - wO) * h;
    Vw1 += (qInW - weirW - wW) * h;
    Vo2 += (weirO - oO) * h;
    Vw2 += (weirW - oW) * h;
    n_u += (qFlash + qBlowO + qBlowW + qBlk - qBpv - qPsvU) * h;
    Vou += (oO + wO - po) * h;
    Vwu += (oW + wW - pw) * h;
    ta.Vo += po * h; ta.Vw += pw * h;
    tanks[0].Vo -= drO0 * h; tanks[0].Vw -= drW0 * h; tanks[1].Vo -= drO1 * h; tanks[1].Vw -= drW1 * h;
    if (n_s < 0) n_s = 0; if (Vo1 < 0) Vo1 = 0; if (Vw1 < 0) Vw1 = 0; if (Vo2 < 0) Vo2 = 0; if (Vw2 < 0) Vw2 = 0;
    if (n_u < 0) n_u = 0; if (Vou < 0) Vou = 0; if (Vwu < 0) Vwu = 0;
    for (i = 0; i < 2; i++) { if (tanks[i].Vo < 0) tanks[i].Vo = 0; if (tanks[i].Vw < 0) tanks[i].Vw = 0; }
    // overfill: separator liquid above 0.98·Vvessel → flare, top phase first
    var VLt = Vw1 + Vo1 * Bs + Vw2 + Vo2 * Bs, lim = 0.98 * Vves;
    if (VLt > lim) {
      var ex = VLt - lim, take;
      take = mmin(ex, Vo1 * Bs); Vo1 -= take / Bs; cum.ltfOil += take / Bs; ex -= take;
      take = mmin(ex, Vo2 * Bs); Vo2 -= take / Bs; cum.ltfOil += take / Bs; ex -= take;
      take = mmin(ex, Vw1); Vw1 -= take; cum.ltfWater += take; ex -= take;
      take = mmin(ex, Vw2); Vw2 -= take; cum.ltfWater += take;
    }
    var VlU = Vou * Bu + Vwu, limU = 0.98 * capU;
    if (VlU > limU) {
      var exu = VlU - limU, tk2 = mmin(exu, Vou * Bu);
      Vou -= tk2 / Bu; cum.ltfOil += tk2 / Bu; exu -= tk2;
      tk2 = mmin(exu, Vwu); Vwu -= tk2; cum.ltfWater += tk2;
    }
    for (i = 0; i < 2; i++) {
      var bgi = tankBo(i), vli = tanks[i].Vo * bgi + tanks[i].Vw;
      if (vli > capG) {
        var exg = vli - capG, tg = mmin(exg, tanks[i].Vo * bgi);
        tanks[i].Vo -= tg / bgi; cum.spillOil += tg / bgi; exg -= tg;
        tg = mmin(exg, tanks[i].Vw); tanks[i].Vw -= tg; cum.spillWater += tg;
      }
    }

    // 7 accumulators (base units: scf, STB, bbl)
    cum.oilIn += qInO * h; cum.waterIn += qInW * h; cum.gasIn += qInG * h;
    cum.flare += (qPcv + qPsv + qBpv + qPsvU) * h; cum.sepGas += qPcv * h;
    cum.flash += qFlash * h; cum.gaugeFlash += gvent * h; cum.gaugeVent += gvent * h;
    cum.gaugeOil += po * h; cum.gaugeWater += pw * h;
    cum.drainedOil += (drO0 + drO1) * h; cum.drainedWater += (drW0 + drW1) * h;

    // 6 algebraic P + exact-exponential filters
    var VB0 = VB, VW0 = Vw1, VU0 = VliqU, VG0 = tankVliq(a);
    // ESD travel slew
    esdTravel = trNew; lcvO.x = xOnew; lcvW.x = xWnew;
    if (N.on) {
      var aG = mexp(-h / N.tau), aW = mexp(-h / N.whpTau), sg = msqrt(1 - aG * aG);
      xiG = aG * xiG + sg * randn(); xiL = aG * xiL + sg * randn(); xiW = aW * xiW + msqrt(1 - aW * aW) * randn();
    }
    var aF = 1 - mexp(-h / Rr.tauFlow);
    qBg += (qgE - qBg) * aF; qBo += (qoE - qBo) * aF; qBw += (qwE - qBw) * aF;
    var fEn = clamp(esdTravel / 0.25, 0, 1);
    var mgn = N.on ? mmax(0, 1 + N.gasSigma * xiG) : 1, fTgt;
    if (qgD > 0) { f = fEn * qBg / qgD; fTgt = fEn * mgn * qBg / qgD; }
    else if (qoD + qwD > 0) { f = fEn * (qBo + qBw) / (qoD + qwD); fTgt = fEn * ml * (qBo + qBw) / (qoD + qwD); }
    else { f = 0; fTgt = 0; }
    fInst += (fTgt - fInst) * (1 - mexp(-h / N.fInstTau));
    if (fEn > 0.01) { tFlow += h; shut = false; }
    else { if (!shut) { shut = true; tShut = 0; P0shut = Pwh; } tShut += h; }
    if (!shut) {
      var tgtW = Pwh_ss * (1 + (N.on ? N.whpSigma * xiW : 0)) - Rr.drawdownFrac * Pwh_ss * mlog(1 + tFlow / 600) / LN10;
      Pwh += (tgtW - Pwh) * (1 - mexp(-h / Rr.drawdownTau));
    } else {
      var SIT = Rr.sithpFactor * Pwh_ss;
      Pwh = SIT - (SIT - P0shut) / (1 + tShut / Rr.buildupTau);
    }
    var PBt = fEn > 0.01 ? Pwh - (Pwh_ss - Pci_ss) * fInst * fInst : Psep;
    PB += (PBt - PB) * (1 - mexp(-h / 5));
    var thT = f > 0.05 ? 1 : 0;
    theta += (thT - theta) * (1 - mexp(-h / (thT > theta ? Rr.warmTau : Rr.coolTau)));
    // meters (EMA τ 600 s)
    var aM = 1 - mexp(-h / 600);
    emaOil += (oO + wO - emaOil) * aM; emaWater += (oW + wW - emaWater) * aM; emaGas += (qPcv - emaGas) * aM; emaFlash += (qFlash - emaFlash) * aM;
    // temperatures (exact exponential mixing + ambient loss)
    var qInU = (oO + wO) * Bs + oW + wW;
    Tu = mixT(Tu, qInU / mmax(VliqU, 1), Tsep, h);
    for (i = 0; i < 2; i++) {
      var qi = (i === a) ? po * Bu + pw : 0;
      tanks[i].T = mixT(tanks[i].T, qi / mmax(tankVliq(i), 1), Tu, h);
    }
    if (ta.win) { ta.win.Tint += ta.T * h; ta.win.tInt += h; }
    algebraic();

    // bookkeeping for tau / event location
    F.inG = qInG; F.inO = qInO; F.inW = qInW; F.pcv = qPcv; F.pcvCap = qCapPcv; F.psv = qPsv; F.blk = qBlk; F.blowO = qBlowO; F.blowW = qBlowW;
    F.weirO = weirO; F.weirW = weirW; F.oO = oO; F.oW = oW; F.wW = wW; F.wO = wO; F.bpv = qBpv; F.bpvCap = qCapBpv; F.psvU = qPsvU;
    F.flash = qFlash; F.pumpBpd = pumpBpd; F.po = po; F.pw = pw; F.gvent = gvent; F.drO[0] = drO0; F.drO[1] = drO1; F.drW[0] = drW0; F.drW[1] = drW1;
    F.qOver = qOver; F.phiC = phiC;
    F.rB = ((Vw2 + Vo2 * Bs) - VB0) / h; F.rW1 = (Vw1 - VW0) / h; F.rU = (VliqU - VU0) / h; F.rG[a] = (tankVliq(a) - VG0) / h;
    t += h;
    histSample(false);
    // 8 alarms
    processAlarms();
  }
  // slew(x → cmd) with full-stroke times (up / down); writes SLEW.x (end) and SLEW.avg (time-average over h)
  var SLEW = { x: 0, avg: 0 };
  function slew(x, cmd, h, sUp, sDn) {
    var d = cmd - x;
    if (d === 0) { SLEW.x = x; SLEW.avg = x; return; }
    var rate = 1 / mmax(d > 0 ? sUp : sDn, 0.01), need = mabs(d) / rate;
    if (need <= h) { SLEW.x = cmd; SLEW.avg = ((x + cmd) / 2 * need + cmd * (h - need)) / h; }
    else { var xn = x + (d > 0 ? rate : -rate) * h; SLEW.x = xn; SLEW.avg = (x + xn) / 2; }
  }
  function mixT(T, k1, Tin, h) {
    var k2 = 1 / 14400, kk = k1 + k2, Tinf = (k1 * Tin + k2 * Tamb) / kk;
    return Tinf + (T - Tinf) * mexp(-kk * h);
  }
  function levelPI(v, hNow, L, h) {
    var hSP = (L.lsl + L.lsh) / 2 * D, e = (hNow - hSP) / D, Kc = 4, Ti = 300;
    var uR = 0.25 + Kc * (e + v.I / Ti), u = clamp(uR, 0, 1);
    if ((uR > 0 && uR < 1) || (uR >= 1 && e < 0) || (uR <= 0 && e > 0)) v.I += e * h;
    return u;
  }
  // adaptive step: stability limits + event location on snap/pump/gauge thresholds
  function chooseH(rem) {
    var c = cfg, h = mmin(rem, c.hMax);
    var tg = n_s / mmax(F.inG, F.pcvCap * mmax(upcv, 0.02), F.psv, F.blowO + F.blowW, 1e-9);
    if (0.3 * tg < h) h = 0.3 * tg;
    var tu = n_u / mmax(F.flash + F.blowO + F.blowW + F.blk, F.bpvCap * mmax(ubpv, 0.02), F.psvU, 1e-9);
    if (0.3 * tu < h) h = 0.3 * tu;
    var Hw = hL1 - mmax(hWeir, h2), tw = 8;
    if (F.qOver > 0 && Hw > 0) { var As = xW * 2 * msqrt(mmax(0, hL1 * (D - hL1))); tw = As / (1.5 * F.qOver * BBL / Hw); }
    if (0.5 * tw < h) h = 0.5 * tw;
    // event location
    var te = Infinity, VB = Vw2 + Vo2 * Bs, x;
    if (cfg.sep.oil.mode !== 'pi') {
      if (lcvO.cmd < 0.5 && F.rB > 1e-12) { x = (VB_hi - VB) / F.rB; if (x >= 0 && x < te) te = x; }
      if (lcvO.cmd > 0.5 && F.rB < -1e-12) { x = (VB_lo - VB) / F.rB; if (x >= 0 && x < te) te = x; }
    }
    if (cfg.sep.water.mode !== 'pi') {
      if (lcvW.cmd < 0.5 && F.rW1 > 1e-12) { x = (VW_hi - Vw1) / F.rW1; if (x >= 0 && x < te) te = x; }
      if (lcvW.cmd > 0.5 && F.rW1 < -1e-12) { x = (VW_lo - Vw1) / F.rW1; if (x >= 0 && x < te) te = x; }
    }
    if (!pumpOn && F.rU > 1e-12) { x = (c.surge.lsh * capU - VliqU) / F.rU; if (x >= 0 && x < te) te = x; }
    if (pumpOn && F.rU < -1e-12) { x = (c.surge.lsl * capU - VliqU) / F.rU; if (x >= 0 && x < te) te = x; }
    if (tanks[1 - active].state === 'ready' && F.rG[active] > 1e-12) { x = (c.gauge.switchFrac * capG - tankVliq(active)) / F.rG[active]; if (x >= 0 && x < te) te = x; }
    for (var i = 0; i < 2; i++) {
      if (tanks[i].state === 'draining') { var r = F.drO[i] * tankBo(i) + F.drW[i]; if (r > 1e-12) { x = (tankVliq(i) - c.gauge.heelFrac * capG) / r; if (x >= 0 && x < te) te = x; } }
      if (tanks[i].state === 'settling') { x = c.gauge.settleS - (t - tanks[i].since); if (x >= 0 && x < te) te = x; }
    }
    if (te < h) h = te + 1e-7;
    if (h < c.hMin) h = c.hMin;
    if (h > rem) h = rem;
    return h;
  }

  // ── snapshot (preallocated, refreshed in place) ──
  function line(unit, phase, ID) { return { q: 0, unit: unit, frac: 0, vel: 0, ID_in: ID, phase: phase, active: false }; }
  var snap = {
    v: 1, t: 0, clock: '00:00:00', speed: 10, running: true, mode: 'steady', flowSeq: 0, flowTs: 0, geomVersion: 1, alarmVersion: 0,
    f: 1, fInst: 1,
    inputs: { Pwh: 0, Twh: 0, Qg: 0, Qo: 0, Qw: 0, SGg: 0, API: 0, bean: 0, Cd: 0, bypass: false, Psep: 0, Thtr: 0 },
    fluid: { API: 0, SGo: 0, SGg: 0 },
    esd: { tag: TAGS.esd, travel: 1, open: true, moving: false, tripped: false, manual: false, cause: null, causeMsg: '', tripT: null, canReset: false, blocking: [] },
    nodes: {
      wellhead: { tag: TAGS.wellhead, P: 0, T: 0, th: 0, hyd: false },
      esd: { tag: TAGS.esd, P: 0, T: 0, th: 0, hyd: false },
      choke: { tag: TAGS.choke, P: 0, Pin: 0, T: 0, th: 0, hyd: false, regime: 'Critical', bean: 0, flowLimited: false, QmaxMMscfd: 0, dTjt: 0 },
      heater: { tag: TAGS.heater, P: 0, T: 0, Tin: 0, th: 0, hyd: false, bypass: false, dutyMMBtuHr: 0, firing: 0 },
      separator: { tag: TAGS.separator, P: 0, T: 0, th: 0, hyd: false },
      flare: { tag: TAGS.flare, P: 0, Pline: 0, T: 0, qMMscfd: 0, flame: 0 },
      surge: { tag: TAGS.surge, P: 0, T: 0 },
      gauge: { tag: TAGS.gauge, P: 0, T: 0 }
    },
    segs: [],
    lines: {
      wh_esd: line('MMSCFD', 'multi', 0), esd_choke: line('MMSCFD', 'multi', 0), choke_heater: line('MMSCFD', 'multi', 0), heater_sep: line('MMSCFD', 'multi', 0),
      sep_flare: line('MMSCFD', 'gas', 0), sep_water: line('BPD', 'water', 3.068), sep_oil: line('BPD', 'oil', 3.068),
      surge_gauge: line('BPD', 'liquid', 3.068), surge_vent: line('MMSCFD', 'gas', 2.067), blanket: line('MMSCFD', 'gas', 1.049),
      gauge_drain: line('BPD', 'liquid', 3.068), gauge_vent: line('MMSCFD', 'gas', 0), psv_sep: line('MMSCFD', 'gas', 2.067), psv_surge: line('MMSCFD', 'gas', 1.049)
    },
    sep: { tag: TAGS.separator, D: 0, R: 0, Lss: 0, xWeir: 0, hWeir: 0, xWeirFrac: 0, hWeirFrac: 0, headDepth: 0, vol_bbl: 0,
      P: 0, SP: 0, SPeff: 0, T: 0, psh: 0, pshh: 0, psl: 0, mawp: 0, lahhTotal: 0,
      pcv: { tag: TAGS.pcv, u: 0, Cv: 0 }, psv: { tag: TAGS.psvSep, lifting: false },
      c1: { hW: 0, hL: 0, fracW: 0, fracL: 0, Vw_bbl: 0, Vo_bbl: 0, Vo_stb: 0 },
      bucket: { hW: 0, h: 0, fracW: 0, frac: 0, Vw_bbl: 0, Vo_bbl: 0, Vo_stb: 0 },
      overWeir_bpd: 0, weirHead_in: 0, carryOver: false, blowby: false, gasVol_ft3: 0, gas_scf: 0,
      oilDump: { tag: TAGS.lcvOil, mode: 'snap', cmd: 0, x: 0, q_bpd: 0, Cv: 0, lsll: 0, lsl: 0, lsh: 0, lshh: 0 },
      waterDump: { tag: TAGS.lcvWater, mode: 'snap', cmd: 0, x: 0, q_bpd: 0, Cv: 0, lsll: 0, lsl: 0, lsh: 0, lshh: 0 },
      gasIn_mmscfd: 0, gasOut_mmscfd: 0, liqIn_bpd: 0, tRes_min: 0 },
    surge: { tag: TAGS.surge, D: 0, H: 0, cap_bbl: 0, P: 0, SP: 0, SPeff: 0, T: 0, psh: 0, pshh: 0, mawp: 0,
      h: 0, frac: 0, hW: 0, fracW: 0, Vo_bbl: 0, Vo_stb: 0, Vw_bbl: 0, flash_mscfd: 0, tFull_s: null, gas_scf: 0,
      bpv: { tag: TAGS.bpv, u: 0 }, blanket: { tag: TAGS.blanket, u: 0 }, psv: { tag: TAGS.psvSurge, lifting: false },
      pump: { tag: TAGS.pump, on: false, tripped: false, failed: false, q_bpd: 0, design_bpd: 0 }, lsll: 0, lsl: 0, lsh: 0, lshh: 0 },
    gauge: { tag: TAGS.gauge, active: 0, count: 2, tanks: [], batches: [] },
    cum: { oilIn_stb: 0, waterIn_bbl: 0, gasIn_mmscf: 0, flare_mmscf: 0, flash_mscf: 0, gaugeFlash_mscf: 0, gaugeVent_mscf: 0, vacBreak_scf: 0,
      gaugeOil_stb: 0, gaugeWater_bbl: 0, drainedOil_stb: 0, drainedWater_bbl: 0,
      liquidToFlareOil_stb: 0, liquidToFlareWater_bbl: 0, spillOil_stb: 0, spillWater_bbl: 0 },
    rates: { gas_mmscfd: 0, oil_stbd: 0, water_bpd: 0, oilMeter_stbd: 0, waterMeter_bpd: 0, gor_scf_stb: null, bsw_pct: null, tank_stbd: null, shrink_pct: null },
    alarms: [], alarmLog: [],
    faults: {},
    health: { substeps: 0, lagging: false, droppedSimSec: 0, massErr: { oil: 0, water: 0, gas: 0 }, flowInvalid: false, dumpCycles: { oil: 0, water: 0 } }
  };
  for (var si = 0; si < 6; si++) snap.segs.push({ id: '', from: '', to: '', label: '', phase: 'multi', nps: '', sch: '', ID: 0, L: 0, vel: 0, ve: 0, vPct: 0, vSt: 'OK',
    dP: 0, P0: 0, Pout: 0, T0: 0, Tout: 0, hydR: false, flowing: false });
  for (var ti = 0; ti < 2; ti++) snap.gauge.tanks.push({ tag: ti ? TAGS.gaugeB : TAGS.gaugeA, D: 0, H: 0, cap_bbl: 0, h: 0, frac: 0, hW: 0, fracW: 0,
    Vo_bbl: 0, Vo_stb: 0, Vw_bbl: 0, T: 0, state: 'ready', stateSince: 0, inlet: false, drain_bpd: 0, switchFrac: 0, lahh: 0, fill_bpd: 0 });
  FAULT_IDS.forEach(function (k) { snap.faults[k] = false; });

  function gasVel(qscfs, Pa, TR, Z, IDin) {
    if (!(IDin > 0) || !(qscfs > 0)) return 0;
    var A = PI / 4 * mpow(IDin / 12, 2);
    return qscfs * (PSC / Pa) * (TR / TSC) * Z / A;
  }
  function liqVel(bpd, IDin) { if (!(IDin > 0) || !(bpd > 0)) return 0; return bpd * BBL / 86400 / (PI / 4 * mpow(IDin / 12, 2)); }
  function setLine(L, q, design, vel, ID, act) {
    L.q = q; L.frac = design > 1e-9 ? q / design : 0; L.vel = vel; L.ID_in = ID; L.active = !!act && q > 1e-6;
  }
  function designAlarms() {
    var sg = snap.segs, i, A;
    for (i = 0; i < 6; i++) {
      var s = sg[i], id = 'VEL_' + s.id;
      var sev = s.vPct >= 100 ? 'alarm' : 'warn';
      A = aDef(id, 'FI-' + s.label, sev, 'seg:' + s.id, 'd');
      var on = s.flowing && s.vPct >= 80;
      if (on && A.active && A.sev !== sev) { clearA(A); }
      if (A.sev !== sev) { A.sev = sev; A.pub.sev = sev; alarmsDirty = true; }
      var m = s.label + ': velocity ' + rnd(s.vel) + ' ft/s is ' + rnd0(s.vPct) + '% of limit ' + rnd0(s.ve) + ' ft/s';
      if (on && !A.active) raise(A, s.vPct, sev === 'alarm' ? 100 : 80, m);
      else if (on) { A.value = s.vPct; }
      else if (!on && A.active) clearA(A);
    }
    var hn = ['wellhead', 'esd', 'choke', 'heater', 'separator'];
    for (i = 0; i < hn.length; i++) {
      var nd = snap.nodes[hn[i]];
      A = aDef('HYD_' + hn[i], TAGS[hn[i]], 'hyd', hn[i], 'd');
      if (nd.hyd && !A.active) raise(A, nd.T, nd.th, NAMES[hn[i]] + ': ' + rnd(nd.T) + ' °F below hydrate ' + rnd(nd.th) + ' °F at ' + rnd(nd.P) + ' psig');
      else if (nd.hyd) { A.value = nd.T; A.limit = nd.th; }
      else if (A.active) clearA(A);
    }
    A = aDef('CHOKE_LIMIT', TAGS.choke, 'alarm', 'choke', 'd');
    if (chk.flowLimited && !A.active) raise(A, Qg, chk.QmaxMMscfd, 'CK-101 flow-limited — bean ' + bean + '/64″ passes ' + chk.QmaxMMscfd.toFixed(2) + ' MMSCFD of ' + Qg.toFixed(2) + ' requested');
    else if (!chk.flowLimited && A.active) clearA(A);
  }

  function refresh() {
    var S = cfg.sep, U = cfg.surge, Gc = cfg.gauge, I = flow.inputs;
    var s = snap, i;
    s.t = t; s.clock = fmtClock(t); s.speed = speed; s.running = running; s.mode = mode;
    s.flowSeq = flowSeq; s.flowTs = flowTs; s.geomVersion = geomVersion; s.f = f; s.fInst = fInst;
    var si = s.inputs; si.Pwh = I.Pwh; si.Twh = I.Twh; si.Qg = I.Qg; si.Qo = I.Qo; si.Qw = I.Qw; si.SGg = I.SGg; si.API = I.API;
    si.bean = I.bean; si.Cd = I.Cd; si.bypass = !!I.bypass; si.Psep = I.Psep; si.Thtr = I.Thtr;
    s.fluid.API = API; s.fluid.SGo = SGo; s.fluid.SGg = SGg;
    // nodes
    var th = theta, N = s.nodes, P;
    N.wellhead.P = Pwh; N.wellhead.T = Tamb + (Twh_ss - Tamb) * th; hydOf(N.wellhead);
    N.esd.P = PB; N.esd.T = Tamb + (Tesd_ss - Tamb) * th; hydOf(N.esd);
    var fi2 = fInst * fInst;
    P = Psep + (Pck_ss - Psep_ss) * fi2;
    N.choke.P = P; N.choke.Pin = PB; N.choke.T = Tamb + (Tck_ss - Tamb) * th; hydOf(N.choke);
    N.choke.regime = f < 0.01 ? 'No Flow' : chk.regime; N.choke.bean = bean; N.choke.flowLimited = chk.flowLimited; N.choke.QmaxMMscfd = chk.QmaxMMscfd;
    N.choke.dTjt = f < 0.01 ? 0 : mmin(150, 0.07 * chk.wJT * mmax(PB - P, 0));
    N.heater.P = Psep + (Ph_ss - Psep_ss) * fi2; N.heater.T = Tamb + (Th_ss - Tamb) * th; N.heater.Tin = Tamb + (Tin_ss - Tamb) * th;
    hydOf(N.heater); N.heater.bypass = bypass; N.heater.dutyMMBtuHr = duty_ss * f;
    N.heater.firing = bypass ? 0 : (duty_ss > 0 ? clamp(f, 0, 1) : 0.15);
    N.separator.P = Psep; N.separator.T = Tsep; hydOf(N.separator);
    var fg = qgE > 0 ? clamp(F.pcv / qgE, 0, 2) : 0;
    var qFl = F.pcv + F.psv + F.bpv + F.psvU;
    N.flare.P = S.pcv.P2_psig; N.flare.Pline = Psep - SS[4].dP * fg * fg; N.flare.T = Tamb + (Tfl_ss - Tamb) * th;
    N.flare.qMMscfd = qFl * 0.0864; N.flare.flame = clamp(msqrt(N.flare.qMMscfd / mmax(Qg, 0.01)), 0, 1.5);
    N.surge.P = Pu; N.surge.T = Tu;
    N.gauge.P = 0; N.gauge.T = tanks[active].T;
    // segments
    var pumpVel = liqVel(F.pumpBpd, SS[5].ID);
    var nodeP0 = [Pwh, PB, N.choke.P, N.heater.P, Psep, Pu], nodeT0 = [N.wellhead.T, N.esd.T, N.choke.T, N.heater.T, Tsep, Tu];
    var nodeT1 = [N.esd.T, N.choke.T, N.heater.T, Tsep, N.flare.T, tanks[active].T];
    for (i = 0; i < 6; i++) {
      var ss = SS[i], o = s.segs[i];
      o.id = ss.id; o.from = ss.from; o.to = ss.to; o.label = ss.label; o.phase = ss.phase; o.nps = ss.nps; o.sch = ss.sch; o.ID = ss.ID; o.L = ss.L;
      var vel = i < 4 ? ss.vel * fInst : (i === 4 ? ss.vel * fg : pumpVel);
      o.vel = vel; o.ve = ss.ve;
      o.vPct = ss.ve > 0 ? vel / ss.ve * 100 : 0;
      o.vSt = vel > ss.ve ? 'EXCEED' : (vel > 0.8 * ss.ve ? 'WARNING' : 'OK');
      var dP;
      if (i === 5) { var Dft = ss.ID / 12; dP = (Dft > 0 && ss.L > 0) ? ss.ff * (ss.L / Dft) * ss.rhom * vel * vel / (2 * 32.174 * 144) : 0; }
      else dP = ss.vel > 1e-9 ? ss.dP * (vel / ss.vel) * (vel / ss.vel) : 0;
      o.dP = dP;
      o.P0 = nodeP0[i];
      o.Pout = i === 1 ? PB - dP : (i === 4 ? N.flare.Pline : mmax(o.P0 - dP, 0));
      if (i === 1) o.Pout = mmax(o.Pout, 0);
      o.T0 = nodeT0[i]; o.Tout = nodeT1[i];
      o.hydR = ss.phase !== 'liquid' && o.T0 < Thyd(mmax(o.P0 + PSC, 15));
      o.flowing = vel > 0.01;
    }
    // lines
    var Lx = s.lines, TR = Tsep + RANK, TRu = Tu + RANK;
    var qMM = Qg * fInst, esdOpen = esdTravel > 0;
    setLine(Lx.wh_esd, qMM, Qg * limFac, s.segs[0].vel, SS[0].ID, true);
    setLine(Lx.esd_choke, qMM, Qg * limFac, s.segs[1].vel, SS[1].ID, esdOpen);
    setLine(Lx.choke_heater, qMM, Qg * limFac, s.segs[2].vel, SS[2].ID, esdOpen);
    setLine(Lx.heater_sep, qMM, Qg * limFac, s.segs[3].vel, SS[3].ID, esdOpen);
    setLine(Lx.sep_flare, F.pcv * 0.0864, qgE * 0.0864, gasVel(F.pcv, PsepA, TR, Zs, SS[4].ID), SS[4].ID, upcv > 0);
    var qwl = (F.wW + F.wO * Bs) * 86400, qol = (F.oO * Bs + F.oW) * 86400;
    setLine(Lx.sep_water, qwl, qwE * 86400, liqVel(qwl, 3.068), 3.068, lcvW.x > 0);
    setLine(Lx.sep_oil, qol, qoE * Bs * 86400, liqVel(qol, 3.068), 3.068, lcvO.x > 0);
    setLine(Lx.surge_gauge, F.pumpBpd, pumpDesign, pumpVel, SS[5].ID, F.pumpBpd > 0); Lx.surge_gauge.tank = active;
    setLine(Lx.surge_vent, F.bpv * 0.0864, qFlashD * 0.0864, gasVel(F.bpv, PuA, TRu, Zu, 2.067), 2.067, ubpv > 0);
    setLine(Lx.blanket, F.blk * 0.0864, pumpDesign / 86400 * BBL * 0.0864, gasVel(F.blk, PsepA, TR, Zs, 1.049), 1.049, ublk > 0);
    var dk = tanks[0].state === 'draining' ? 0 : (tanks[1].state === 'draining' ? 1 : (1 - active));
    var qd = (F.drO[dk] * tankBo(dk) + F.drW[dk]) * 86400;
    setLine(Lx.gauge_drain, qd, drainBpd, liqVel(qd, 3.068), 3.068, tanks[dk].state === 'draining'); Lx.gauge_drain.tank = dk;
    setLine(Lx.gauge_vent, F.gvent * 0.0864, qoE * RsE(PspU + PSC, Tsep_ss) * 0.0864, 0, 0, true);
    setLine(Lx.psv_sep, F.psv * 0.0864, gq(Cv_psv, mawpE + PSC, PSC + S.pcv.P2_psig, TR, Zs) * 0.0864, 0, 2.067, psvLift);
    setLine(Lx.psv_surge, F.psvU * 0.0864, gq(Cv_psvU, mawpU + PSC, PSC + S.pcv.P2_psig, TRu, Zu) * 0.0864, 0, 1.049, psvULift);
    // separator
    var sp = s.sep;
    sp.D = D; sp.R = R; sp.Lss = Lss; sp.xWeir = xW; sp.hWeir = hWeir; sp.xWeirFrac = xW / Lss; sp.hWeirFrac = hWeir / D; sp.headDepth = D / 4; sp.vol_bbl = Vves;
    sp.P = Psep; sp.SP = SP; sp.SPeff = SPe; sp.T = Tsep; sp.psh = psh; sp.pshh = pshh; sp.psl = psl; sp.mawp = mawpE; sp.lahhTotal = S.lahhTotal;
    sp.pcv.u = upcv; sp.pcv.Cv = Cv_pcv; sp.psv.lifting = psvLift;
    sp.c1.hW = hW1; sp.c1.hL = hL1; sp.c1.fracW = hW1 / D; sp.c1.fracL = hL1 / D; sp.c1.Vw_bbl = Vw1; sp.c1.Vo_bbl = Vo1 * Bs; sp.c1.Vo_stb = Vo1;
    sp.bucket.hW = hW2; sp.bucket.h = h2; sp.bucket.fracW = hW2 / D; sp.bucket.frac = h2 / D; sp.bucket.Vw_bbl = Vw2; sp.bucket.Vo_bbl = Vo2 * Bs; sp.bucket.Vo_stb = Vo2;
    var Hw = hL1 - mmax(hWeir, h2);
    sp.overWeir_bpd = F.qOver * 86400; sp.weirHead_in = mmax(Hw, 0) * 12; sp.carryOver = F.phiC > 0; sp.blowby = (F.blowO + F.blowW) > 0;
    sp.gasVol_ft3 = Vg; sp.gas_scf = n_s;
    dumpSnap(sp.oilDump, lcvO, S.oil, qol, Cv_o); dumpSnap(sp.waterDump, lcvW, S.water, qwl, Cv_w);
    sp.gasIn_mmscfd = F.inG * 0.0864; sp.gasOut_mmscfd = (F.pcv + F.psv + F.blk + F.blowO + F.blowW) * 0.0864;
    var liqIn = (F.inO * Bs + F.inW) * 86400; sp.liqIn_bpd = liqIn;
    sp.tRes_min = mmin(9999, (Vw1 + Vo1 * Bs + Vw2 + Vo2 * Bs) / mmax(liqIn / 1440, 1e-9));
    // surge
    var su = s.surge;
    su.D = Du; su.H = Hu; su.cap_bbl = capU; su.P = Pu; su.SP = PspU; su.SPeff = SPeu; su.T = Tu; su.psh = pshU; su.pshh = pshhU; su.mawp = mawpU;
    su.h = hU; su.frac = hU / Hu; su.hW = Vwu * BBL / Atu; su.fracW = su.hW / Hu; su.Vo_bbl = Vou * Bu; su.Vo_stb = Vou; su.Vw_bbl = Vwu;
    su.flash_mscfd = F.flash * 86.4; su.gas_scf = n_u;
    var net = (F.oO + F.wO) * Bs + F.oW + F.wW - (F.po * Bu + F.pw);
    su.tFull_s = net > 1e-9 ? mmax(0, (U.lshh * Hu - hU) * Atu / BBL / net) : null;
    su.bpv.u = ubpv; su.blanket.u = ublk; su.psv.lifting = psvULift;
    su.pump.on = pumpOn && !pumpTrip && !faults.surgePumpFail; su.pump.tripped = pumpTrip; su.pump.failed = faults.surgePumpFail; su.pump.q_bpd = F.pumpBpd; su.pump.design_bpd = pumpDesign;
    su.lsll = U.lsll; su.lsl = U.lsl; su.lsh = U.lsh; su.lshh = U.lshh;
    // gauge
    var g = s.gauge; g.active = active; g.count = 2;
    for (i = 0; i < 2; i++) {
      var tk = tanks[i], o2 = g.tanks[i], bg = tankBo(i), vl = tk.Vo * bg + tk.Vw;
      o2.tag = tk.tag; o2.D = Dg; o2.H = Hg; o2.cap_bbl = capG; o2.frac = vl / capG; o2.h = o2.frac * Hg; o2.hW = tk.Vw * BBL / Atg; o2.fracW = o2.hW / Hg;
      o2.Vo_bbl = tk.Vo * bg; o2.Vo_stb = tk.Vo; o2.Vw_bbl = tk.Vw; o2.T = tk.T; o2.state = tk.state; o2.stateSince = tk.since;
      o2.inlet = i === active; o2.drain_bpd = (F.drO[i] * bg + F.drW[i]) * 86400; o2.switchFrac = Gc.switchFrac; o2.lahh = Gc.lahh;
      o2.fill_bpd = i === active ? (F.po * Bu + F.pw) * 86400 : 0;
    }
    if (g.batches.length !== batches.length || (batches.length && g.batches[g.batches.length - 1].n !== batches[batches.length - 1].n)) {
      g.batches = batches.map(function (b) { var c = {}; for (var k in b) c[k] = b[k]; return c; });
    }
    // cum (display units)
    var c = s.cum;
    c.oilIn_stb = cum.oilIn; c.waterIn_bbl = cum.waterIn; c.gasIn_mmscf = cum.gasIn / 1e6; c.flare_mmscf = cum.flare / 1e6;
    c.flash_mscf = cum.flash / 1e3; c.gaugeFlash_mscf = cum.gaugeFlash / 1e3; c.gaugeVent_mscf = cum.gaugeVent / 1e3; c.vacBreak_scf = cum.vacBreak;
    c.gaugeOil_stb = cum.gaugeOil; c.gaugeWater_bbl = cum.gaugeWater; c.drainedOil_stb = cum.drainedOil; c.drainedWater_bbl = cum.drainedWater;
    c.liquidToFlareOil_stb = cum.ltfOil; c.liquidToFlareWater_bbl = cum.ltfWater; c.spillOil_stb = cum.spillOil; c.spillWater_bbl = cum.spillWater;
    // rates
    var r = s.rates, oilM = emaOil * 86400, watM = emaWater * 86400;
    r.gas_mmscfd = emaGas * 0.0864; r.oil_stbd = oilM; r.water_bpd = watM; r.oilMeter_stbd = oilM; r.waterMeter_bpd = watM;
    r.gor_scf_stb = oilM >= 0.1 ? (emaGas + emaFlash) * 86400 / oilM : null;
    r.bsw_pct = (oilM + watM) >= 0.1 ? watM / (oilM + watM) * 100 : null;
    r.tank_stbd = batches.length ? batches[batches.length - 1].oilRate_stbd : null;
    r.shrink_pct = cum.gaugeOil > 1 ? (1 - BoR(PSC, tanks[active].T) / BoR(PuA, Tu)) * 100 : null;
    // faults
    for (i = 0; i < FAULT_IDS.length; i++) s.faults[FAULT_IDS[i]] = !!faults[FAULT_IDS[i]];
    // design-derived alarms (no delay) then the alarm list
    designAlarms();
    var k, A;
    if (alarmsDirty) {                          // rebuild the ordered list only when the active set / severities changed
      alarmsDirty = false; alarmVersion++;
      alarmOrder.length = 0;
      for (k in AL) if (AL[k].active) alarmOrder.push(k);
      alarmOrder.sort(function (a, b) {
        var X = AL[a], Y = AL[b], ra = SEV_RANK[X.sev], rb = SEV_RANK[Y.sev];
        return ra !== rb ? ra - rb : (X.since !== Y.since ? X.since - Y.since : (a < b ? -1 : 1));
      });
      s.alarms.length = 0;
      for (i = 0; i < alarmOrder.length; i++) s.alarms.push(AL[alarmOrder[i]].pub);
      var blocking = [];
      for (i = 0; i < alarmOrder.length; i++) { A = AL[alarmOrder[i]]; if (A.sev === 'trip' && A.id !== 'ESD_TRIPPED') blocking.push(A.id); }
      s.esd.blocking = blocking.sort();
    }
    for (i = 0; i < alarmOrder.length; i++) {
      A = AL[alarmOrder[i]]; var p = A.pub;
      p.sev = A.sev; p.msg = A.msg; p.value = A.value; p.limit = A.limit; p.since = A.since;
    }
    s.alarmVersion = alarmVersion;
    if (s.alarmLog.length !== alarmLog.length || (alarmLog.length && s.alarmLog[s.alarmLog.length - 1] !== alarmLog[alarmLog.length - 1]) ||
        (alarmLog.length && s.alarmLog[0] !== alarmLog[0])) s.alarmLog = alarmLog.slice();
    // ESD block
    var e = s.esd;
    e.travel = esdTravel; e.open = esdTravel >= 0.999; e.moving = esdS.tripped ? esdTravel > 1e-9 : esdTravel < 0.999;
    e.tripped = esdS.tripped; e.manual = esdS.manual; e.cause = esdS.cause; e.causeMsg = esdS.causeMsg; e.tripT = esdS.tripT;
    e.canReset = esdS.tripped ? e.blocking.length === 0 : false;
    // health
    var hl = s.health; hl.substeps = lastSubsteps; hl.lagging = lagging; hl.droppedSimSec = droppedSimSec; massErr(hl.massErr); hl.flowInvalid = flowInvalid;
    hl.dumpCycles.oil = oilCycles; hl.dumpCycles.water = waterCycles;
  }
  function hydOf(n) { n.th = Thyd(mmax(n.P + PSC, 15)); n.hyd = n.T < n.th && n.P > 10; }
  function dumpSnap(o, v, L, q, Cv) {
    o.mode = L.mode === 'pi' ? 'pi' : 'snap'; o.cmd = v.cmd; o.x = v.x; o.q_bpd = q; o.Cv = Cv; o.lsll = L.lsll; o.lsl = L.lsl; o.lsh = L.lsh; o.lshh = L.lshh;
  }

  // ── advance / mutators ──
  function advance(dt) {
    if (disposed || flushing) return;
    dt = +dt;
    if (!(dt > 0)) { refresh(); flush(); return; }
    if (dt > cfg.maxAdvance) dt = cfg.maxAdvance;
    var rem = dt, k = 0, maxK = cfg.maxSubsteps;
    while (rem > 1e-9 && k < maxK) {
      var h = chooseH(rem);
      substep(h);
      rem -= h; k++;
    }
    lastSubsteps = k;
    if (rem > 1e-9) { lagging = true; droppedSimSec += rem; } else lagging = false;
    refresh();
    flush();
  }
  function mut(fn, peek) {
    return function () {
      if (disposed) return peek ? peek.apply(null, arguments) : undefined;
      var args = arguments;
      if (flushing) { deferred.push(function () { fn.apply(null, args); refresh(); flush(); }); return peek ? peek.apply(null, args) : undefined; }
      var r = fn.apply(null, args);
      refresh(); flush();
      return r;
    };
  }
  function applyFlow(nf) {
    var cvP = Cv_pcv, cvB = Cv_bpv;
    flow = normFlow(nf);
    buildCfg();
    var keep = derive();
    if (keep) geometryChanged(keep);
    algebraic(); bumpless(cvP, cvB);
  }
  function geometryChanged(keep) {
    applyFractions(keep);
    algebraic();
    geomVersion++;
    setRef();
    emit('geometry', { type: 'geometry', t: t, geomVersion: geomVersion });
  }

  var api = {
    advance: function (dt) { advance(dt); },
    step: function (dtReal) {
      if (disposed || flushing || !running) return;
      var d = +dtReal; if (!(d > 0)) return;
      advance(mmin(d, cfg.realDtCap) * speed);
    },
    getState: function () { return snap; },
    getHistory: function (key, maxPts) {
      var out = { t: [], y: [] };
      if (!H || !H.k[key] || H.c === 0) return out;
      var n = H.c, start = (H.i - n + H.n) % H.n, buf = H.k[key];
      var m = (maxPts > 0 && maxPts < n) ? mmax(1, mfloor(maxPts)) : n;
      for (var j = 0; j < m; j++) {
        var idx = m === n ? j : mround(j * (n - 1) / mmax(1, m - 1));
        var p = (start + idx) % H.n;
        out.t.push(H.t[p]); out.y.push(buf[p]);
      }
      return out;
    },
    setFlow: mut(function (fl) {
      if (!validFlow(fl)) { flowInvalid = true; return; }
      flowInvalid = false;
      applyFlow(fl);
      flowSeq++; flowTs = num(fl.ts, 0);
    }),
    setConfig: mut(function (partial) {
      if (!isPlainObj(partial)) return;
      mergeOverrides(overrides, deepClone(partial));
      buildCfg();
      var cvP = Cv_pcv, cvB = Cv_bpv;
      var keep = derive();
      if (keep) geometryChanged(keep);
      if (H && mmax(2, cfg.histLen | 0) !== H.n) histReset();
      algebraic(); bumpless(cvP, cvB);
      if (cfg.speeds.indexOf(speed) < 0) speed = cfg.speeds[0];
    }),
    reset: mut(function (m) {
      initState(m === 'empty' ? 'empty' : 'steady');
      emit('reset', { type: 'reset', t: t, mode: mode });
      logEntry('reset', 'SIM', null, '', 'Test reset (' + mode + ')');
    }),
    play: mut(function () { running = true; }),
    pause: mut(function () { running = false; }),
    isRunning: function () { return running && !disposed; },
    setSpeed: mut(function (x) { x = +x; if (cfg.speeds.indexOf(x) >= 0) speed = x; }),
    getSpeed: function () { return speed; },
    tripESD: mut(function (reason) {
      if (esdS.tripped) return;
      esdS.tripped = true; esdS.manual = true; esdS.cause = 'ESD_MANUAL';
      esdS.causeMsg = 'Closed manually at T+' + fmtClock(t) + ((reason && reason !== 'manual') ? ' — ' + String(reason) : '');
      esdS.tripT = t;
      var A = aDef('ESD_MANUAL', TAGS.esd, 'info', 'esd', 'x');
      if (!A.active) raise(A, null, null, esdS.causeMsg);
      emit('trip', { type: 'trip', t: t, cause: 'ESD_MANUAL', tag: TAGS.esd, msg: esdS.causeMsg, value: null, limit: null, manual: true });
      logEntry('trip', 'ESD_MANUAL', 'info', TAGS.esd, esdS.causeMsg);
    }),
    resetESD: mut(function () {
      var b = blockingNow();
      if (!esdS.tripped) return { ok: true, blocking: [] };
      if (b.length) return { ok: false, blocking: b };
      esdS.tripped = false; esdS.manual = false; esdS.cause = null; esdS.causeMsg = ''; esdS.tripT = null;
      if (AL.ESD_TRIPPED) clearA(AL.ESD_TRIPPED);
      if (AL.ESD_MANUAL) clearA(AL.ESD_MANUAL);
      tFlow = 0; graceUntil = t + cfg.startupGrace;
      emit('esdReset', { type: 'esdReset', t: t });
      logEntry('reset', 'ESD', null, TAGS.esd, 'ESD reset — reopening');
      return { ok: true, blocking: [] };
    }, function () { var b = blockingNow(); return { ok: !esdS.tripped || b.length === 0, blocking: b }; }),
    setFault: mut(function (id, on) {
      if (FAULT_IDS.indexOf(id) < 0) return;
      on = !!on;
      if (faults[id] === on) return;
      faults[id] = on;
      emit('fault', { type: 'fault', t: t, id: id, on: on });
      logEntry('fault', id, null, '', FAULT_LABELS[id] + (on ? ' ON' : ' OFF'));
    }),
    switchGaugeTank: mut(function (force) {
      var b = 1 - active;
      if (tanks[b].state !== 'ready') {
        if (force) { logEntry('event', 'SWITCH', null, TAGS.gauge, 'Standby compartment not ready'); emit('event', { type: 'event', t: t, msg: 'Standby compartment not ready', tag: TAGS.gauge }); }
        return false;
      }
      if (!force && tankVliq(active) < cfg.gauge.switchFrac * capG) return false;
      doSwitch(!!force);
      return true;
    }, function () { return tanks[1 - active].state === 'ready'; }),
    logEvent: mut(function (msg, tag) {
      msg = String(msg == null ? '' : msg); tag = tag == null ? '' : String(tag);
      logEntry('event', 'EVENT', null, tag, msg);
      emit('event', { type: 'event', t: t, msg: msg, tag: tag });
    }),
    on: function (evt, fn) { if (typeof fn !== 'function') return; (handlers[evt] = handlers[evt] || []).push(fn); },
    off: function (evt, fn) { var hs = handlers[evt]; if (!hs) return; var i = hs.indexOf(fn); if (i >= 0) hs.splice(i, 1); },
    dispose: function () { if (disposed) return; disposed = true; running = false; snap.running = false; handlers = {}; evq = []; deferred = []; }
  };
  function blockingNow() {
    var b = [];
    for (var k in AL) { var A = AL[k]; if (A.active && A.sev === 'trip' && k !== 'ESD_TRIPPED') b.push(k); }
    return b.sort();
  }
  Object.defineProperty(api, 'disposed', { get: function () { return disposed; } });
  // test/diagnostic hook (not part of the contract; used by self-tests only)
  Object.defineProperty(api, '_internal', { value: function () { return { cfg: deepClone(cfg), Cv: { pcv: Cv_pcv, o: Cv_o, w: Cv_w, bpv: Cv_bpv, mk: Cv_mk, psvU: Cv_psvU }, pumpDesign: pumpDesign, drainBpd: drainBpd }; } });

  // ── construct ──
  derive();
  var sp0 = num(opts.speed, cfg.speed); if (cfg.speeds.indexOf(sp0) >= 0) speed = sp0;
  initState(opts.mode === 'empty' ? 'empty' : 'steady');
  if (!validFlow(flowIn)) flowInvalid = true;
  flowTs = num(flow.ts, 0);
  refresh();
  evq = [];                                     // nothing to deliver before handlers exist
  return api;
}

// =============================================================================
G.WTS_sim = {
  VERSION: '1.1.0',
  TAGS: TAGS,
  NAMES: NAMES,
  NULLABLE: NULLABLE,
  DEFAULTS: DEFAULTS,
  SAMPLE_FLOW: SAMPLE_FLOW,
  FAULTS: deepFreeze(FAULT_IDS.map(function (id) { return { id: id, label: FAULT_LABELS[id] }; })),
  create: create,
  flowFromInputs: flowFromInputs,
  deepClone: deepClone,
  deepMerge: deepMerge,
  geom: { segArea: segArea, head21Vol1: head21Vol1, makeLUT: makeLUT },
  pvt: { rs: pvtRs, rsEff: pvtRsEff, bo: pvtBo, boRel: pvtBoRel, zFactor: zFactor, hydrateT: hydrateT },
  valve: { gasQ: function (Cv, P1a, P2a, SG, TR, Z) { return gasQ(Cv, P1a, P2a, SG, TR, Z, FKXT_DEF); }, liqQ: liqQ },
  fmtClock: fmtClock
};

})();

// ─── END 31-wts-sim ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 32-wts-3d ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
  { id:'X1',  aSeg:5, seg:5, line:'surge_gauge',  phase:'liquid', pts:[[10.2,0.9,4.0],[10.2,0.45,4.0],[12.2,0.45,4.0]] },
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
            flash_mscfd:0, pumpOn:false, pumpTripped:false, pumpFailed:false, pump_q:0, pump_design:0, lsll:0.05, lsl:0.25, lsh:0.7, lshh:0.9, psvLifting:false },
    gauge:{ active:0, tanks:[{ frac:0.3, fracW:0.06, cap_bbl:100, state:'filling', Vo_bbl:0, Vw_bbl:0, Vo_stb:0, drain_bpd:0, fill_bpd:0 },
                              { frac:0, fracW:0, cap_bbl:100, state:'ready', Vo_bbl:0, Vw_bbl:0, Vo_stb:0, drain_bpd:0, fill_bpd:0 }],
            nb:0, lastOil:-1, lastRate:-1, lastBsw:-1, lastTag:'' },
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
  var GA = S.gauge || {}, ga = N.gauge, TK = GA.tanks || EMPTY_ARR;
  ga.active = num(GA.active, 0) ? 1 : 0;
  for (i = 0; i < 2; i++) {
    var ts = TK[i] || {}, dt = ga.tanks[i];
    dt.frac = clamp(num(ts.frac, i ? 0 : 0.3), 0, 1.05); dt.fracW = clamp(num(ts.fracW, i ? 0 : 0.06), 0, 1.05); dt.cap_bbl = Math.max(num(ts.cap_bbl, 100), 1);
    dt.state = nstr(ts.state, i ? 'ready' : 'filling'); dt.Vo_bbl = num(ts.Vo_bbl, dt.cap_bbl * (dt.frac - dt.fracW)); dt.Vw_bbl = num(ts.Vw_bbl, dt.cap_bbl * dt.fracW);
    dt.Vo_stb = num(ts.Vo_stb, dt.Vo_bbl); dt.drain_bpd = num(ts.drain_bpd, 0); dt.fill_bpd = num(ts.fill_bpd, 0);
  }
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
      switchFrac:0.9, lahh:0.97, fill_bpd:isAct ? qPump : 0 };
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
      pump:{ tag:'P-201', on:pumpOn, tripped:false, failed:false, q_bpd:qPump, design_bpd:3753 }, lsll:0.05, lsl:0.25, lsh:0.7, lshh:0.9 },
    gauge:{ tag:'T-301', active:active, count:2, tanks:[tank(0), tank(1)],
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
    var cap = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    addEdgeRadial(THREE, cap);
    var cm = new THREE.Mesh(cap, capMat()); cm.position.copy(v.hullFront.position); scene.add(cm); v.caps = [cm];
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
    var vInst = new THREE.InstancedMesh(xvA.geometry, M.accent, 4); vInst.frustumCulled = false; if (T.shadow) vInst.castShadow = false; scene.add(vInst);
    add('steelSatin', F.cylAB([15.4, 0.35, 5.8], [15.4, 0.6, 5.8], 0.03, 6)); add('steelSatin', F.cylAB([17.9, 0.35, 5.8], [17.9, 0.6, 5.8], 0.03, 6));
    add('steelSatin', F.cylAB([20.0, 0.35, 6.3], [20.12, 0.35, 6.3], 0.22, 16)); add('rubber', F.cylAB([20.12, 0.35, 6.3], [20.6, 0.2, 6.3], 0.1, 12));
    S.dyn.gaugeValves = { xvA:xvA, xvB:xvB, dvA:dvA, dvB:dvB, aA:0, aB:0, inst:vInst };
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
    var splash = sprite('#9fd0ff', 0.5, 15.2, 1.0, 3.6, 0.0); splash.renderOrder = 960;
    S.dyn.pour = { mesh:pour, splash:splash };
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
          slot(ch, su.frac * 100, 'percent', 'L', su.P, 'pressureTank', 'P', ' · ', '', '');
          if (t2) { var fill = n.lines.sep_oil.q + n.lines.sep_water.q - su.pump_q;
            rows(ch, ['Volume', FV(su.Vo_bbl + su.Vw_bbl, 'volume'), 'Pump', su.pumpFailed ? 'FAILED' : su.pumpTripped ? 'TRIPPED' : su.pumpOn ? 'ON' : 'OFF', 'Net fill', FV(fill, 'liquidRate'),
              'Time to HH', su.tFull_s >= 0 ? fmtNum(su.tFull_s / 60, 0) + ' min' : '—']); }
          break;
        case 'pump': {
          var pst = su.pumpFailed ? 'FAILED' : su.pumpTripped ? 'TRIPPED' : su.pumpOn ? 'ON' : 'OFF';
          slot(ch, null, null, null, su.pump_q, 'liquidRate', 'L', '', pst, su.pumpOn && !su.pumpFailed && !su.pumpTripped ? 'g' : (su.pumpFailed || su.pumpTripped ? 'l' : 's'));
          break; }
        case 'gauge':
          slot(ch, ga.tanks[0].Vo_bbl + ga.tanks[0].Vw_bbl, 'volume', 'L', ga.tanks[1].Vo_bbl + ga.tanks[1].Vw_bbl, 'volume', 'L', ' · ', ga.active ? 'B FILLING' : 'A FILLING', 's');
          if (t2) rows(ch, ['A', ga.tanks[0].state, 'B', ga.tanks[1].state, 'Last batch', ga.lastRate >= 0 ? FV(ga.lastRate, 'liquidRate') + ' (STB/d)' : '—',
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
    var byp = n.nodes.heater.bypass, gAct = L.surge_gauge.tank;
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
        case 'X1': case 'X2': act = L.surge_gauge.active; break; case 'XA': act = L.surge_gauge.active && gAct === 0; break; case 'XB': act = L.surge_gauge.active && gAct === 1; break;
        case 'DRA': v = L.gauge_drain.vel; act = L.gauge_drain.active; break; case 'DRB': v = L.gauge_drain.vel; act = L.gauge_drain.active && L.gauge_drain.tank === 1; break;
        case 'E2b': act = false; break;
      }
      var vs = velToScene(v); if (vs <= 0) act = false;
      tr.edgeV[i] = vs; tr.edgeAct[i] = act ? 1 : 0; tr.nextE[i] = -1; tr.nextS[i] = 0;
    }
    var I = ROUTE_IDX;
    tr.nextE[I.E1] = I.E2; tr.nextE[I.E2] = I.E3; tr.nextE[I.E3] = byp ? I.E3b : I.E3c; tr.nextE[I.E3c] = I.E4a; tr.nextE[I.E4a] = I.E4; tr.nextE[I.E3b] = I.E4;
    tr.nextE[I.LW] = I.LM; tr.nextE[I.LO] = I.LM; tr.nextE[I.X1] = I.X2; tr.nextE[I.X2] = gAct === 1 ? I.XB : I.XA;
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
    var ly = 0.915 + SM.suF.x * v.Hint, inAct = N.lines.sep_oil.active || N.lines.sep_water.active;
    for (i = 0; i < P.n; i++) {
      var o2 = i * 3, c2 = i * 4;
      P.life[i] += dt * flowGain;
      if (i < s0) {
        var yy = 1.0 + P.life[i] * 0.15;
        if (yy > ly - 0.03 || P.life[i] > 40) { P.life[i] = 0; P.a[i] = r(); P.b[i] = r(); yy = 1.0; }
        var rr = Math.sqrt(P.a[i]) * 0.9, an = P.b[i] * 6.283;
        P.pos[o2] = 10.2 + Math.cos(an) * rr; P.pos[o2 + 1] = yy; P.pos[o2 + 2] = 4.0 + Math.sin(an) * rr;
        P.col[c2] = 0.85; P.col[c2 + 1] = 0.93; P.col[c2 + 2] = 1; P.col[c2 + 3] = ly > 1.1 ? 0.22 : 0; P.sz[i] = 0.035;
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
    v = V.surge; U = v.U; var yS = suF * v.Hint, ySW = suW * v.Hint;
    U.uSecA.value.set(suW < 0.003 ? -1 : ySW, yS); U.uSecB.value.copy(U.uSecA.value); U.uTilt.value = slosh(v, yS); U.uPh.value.set(phases.rip, phases.rip2);
    v.alert.value = smoothstep(0.85, 1.0, su.P / Math.max(su.pshh, 1));
    var capS = v.caps[0], rc = vertCapRadius(v.Ri, v.Ls, v.hd, clamp(yS, 0.001, v.Hint - 0.001));
    capS.scale.set(rc, 1, rc); capS.position.y = 0.915 + yS; capS.visible = suF > 0.003; capS.rotation.z = Math.atan(U.uTilt.value);
    setCapLook(capS, suF - suW > 0.01 ? 'oil' : 'water');
    var sg = S.dyn.sight, yTop = clamp(0.915 + yS, sg.y0, sg.y1), yW = clamp(0.915 + ySW, sg.y0, sg.y1);
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
    var gv = D.gaugeValves, a = n.gauge.active;
    gv.xvA.rotation.x = spring('xvA', a === 0 ? 0 : Math.PI * 3, dt, 0.3, snap); gv.xvB.rotation.x = spring('xvB', a === 1 ? 0 : Math.PI * 3, dt, 0.3, snap);
    gv.dvA.rotation.y = spring('dvA', n.gauge.tanks[0].state === 'draining' ? Math.PI * 3 : 0, dt, 0.3, snap); gv.dvB.rotation.y = spring('dvB', n.gauge.tanks[1].state === 'draining' ? Math.PI * 3 : 0, dt, 0.3, snap);
    GV[0] = gv.xvA; GV[1] = gv.xvB; GV[2] = gv.dvA; GV[3] = gv.dvB;
    for (i = 0; i < 4; i++) { GV[i].updateMatrix(); gv.inst.setMatrixAt(i, GV[i].matrix); } gv.inst.instanceMatrix.needsUpdate = true;
    for (i = 0; i < D.lcv.list.length; i++) { D.lcv.list[i].updateMatrix(); D.lcv.inst.setMatrixAt(i, D.lcv.list[i].matrix); } D.lcv.inst.instanceMatrix.needsUpdate = true;
    // floats + tapes
    var fl = D.floats, tp = fl.tape.geometry.attributes.position.array, xs = FLOAT_X, fr2 = FLOAT_F; FLOAT_F[0] = SM.gA.x; FLOAT_F[1] = SM.gB.x;
    for (i = 0; i < 2; i++) { var fy = 0.25 + clamp(fr2[i], 0.02, 1) * 2.6 + 0.02; _m4.makeTranslation(xs[i], fy, 4.95); fl.mesh.setMatrixAt(i, _m4);
      tp[i * 6] = xs[i]; tp[i * 6 + 1] = fy + 0.08; tp[i * 6 + 2] = 4.95; tp[i * 6 + 3] = xs[i]; tp[i * 6 + 4] = 2.95; tp[i * 6 + 5] = 4.95; }
    fl.mesh.instanceMatrix.needsUpdate = true; fl.tape.geometry.attributes.position.needsUpdate = true;
    // pour into the active compartment
    var pr = D.pour, act = n.lines.surge_gauge.active && n.lines.surge_gauge.q > 0, tk = n.lines.surge_gauge.tank, surf = 0.25 + (tk ? SM.gB.x : SM.gA.x) * 2.6;
    var pa = ease('pourA', act ? 1 : 0, dt, act ? 0.2 : 0.35, snap);
    pr.mesh.visible = pa > 0.02; pr.mesh.position.set(tk ? 17.6 : 15.2, 2.7, 3.6); pr.mesh.scale.set(1, Math.max(0.05, 2.7 - surf), 1);
    phases.pour = (phases.pour + dt * 3.0 * flowGain) % 256; pr.mesh.material.uniforms.uOff.value = phases.pour; pr.mesh.material.uniforms.uA.value = 0.85 * pa;
    var qo = n.inp.Qo, qw = n.inp.Qw, mixW = qo + qw > 0 ? qw / (qo + qw) : 0, pk = Math.round(mixW * 100);
    if (pk !== K.pourKey) { K.pourKey = pk; K.pour.set(mixHex(S.oil ? S.oil.surface : '#c08a3a', PALETTE.waterSurface, mixW)); }
    pr.mesh.material.uniforms.uCol.value.copy(K.pour);
    pr.splash.position.set(tk ? 17.6 : 15.2, surf + 0.05, 3.6); pr.splash.material.opacity = 0.5 * pa * flowGain;
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
    var id = pickAt(pointerPos.x, pointerPos.y); if (id === 'mushroom') id = 'esd';
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
  PALETTE:PALETTE, STATUS_MAP:STATUS_MAP, FIT_BOX:FIT_BOX, PROCESS_BOX:PROCESS_BOX, FIT_PTS:FIT_PTS, V101_BOX:V101_BOX, PROXIES:PROXIES, ROUTES:ROUTES,
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

// ─── END 32-wts-3d ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 38-wts-live ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
    lengthSmall: 'in', percent: '%', gor: 'scf/STB', powerLarge: 'MMBtu/hr', count: '' };
var CAT_BASE = { pressureTank: 'pressureG', oilRate: 'liquidRate', oilVolume: 'volume' };
var UNITLESS = { percent: 1, gor: 1, count: 1 };
var STATUS_MAP_LOCAL = { trip: 'alarm', alarm: 'alarm', warn: 'warn', hyd: 'hyd', info: 'evt' };
var ST_RANK = { ok: 0, evt: 1, hyd: 2, warn: 3, alarm: 4 };
var SEV_RANK = { info: 1, hyd: 2, warn: 3, alarm: 4, trip: 5 };
var EQ_IDS = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare', 'surge', 'pump', 'gauge'];
var STEP = { wellhead: '①', esd: '②', choke: '③', heater: '④', separator: '⑤',
    flare: '⑥', surge: '⑦', pump: '⑧', gauge: '⑨' };
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
    ['waterDumpStuckClosed', 'LCV-101 stuck closed'], ['surgePumpFail', 'P-201 failed'], ['slugging', 'Slug flow']];
var VIEWS = [['overview', 'Overview', '0'], ['wellhead', 'Wellhead & Choke', '1'], ['separator', 'Separator', '2'],
    ['tanks', 'Tanks', '3'], ['flare', 'Flare', '4'], ['process', 'Process', '5']];
var OVERLAYS = [['phase', 'Phase'], ['pressure', 'Pressure'], ['temperature', 'Temperature'], ['erosion', 'Erosion']];
var QUALS = [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
var LABEL_MODES = [['all', 'All'], ['equip', 'Equipment'], ['off', 'Off']];
var INPUT_FOR = { wellhead: 'wts_Pwh', esd: 'wts_Pwh', choke: 'wts_bean', heater: 'wts_Thtr', separator: 'wts_Psep',
    surge: 'wts_Psurge', pump: 'wts_nps6', gauge: 'wts_gtCap', flare: 'wts_nps5' };
var DEF_COL = { gas: '#b8d4f0', oil: '#c98a2b', water: '#1f7fe0', emulsion: '#a08650' };
var PREF_DEFAULTS = { mode: '3d', labels: 'all', overlay: 'phase', quality: 'auto', speed: 10,
    legend: false, trends: false, orbit: false };
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
    if (+a.Psep !== +b.Psep) out.push(['Separator SP ' + shortNum(a.Psep) + '→' + shortNum(b.Psep) + ' psig', 'PCV-101']);
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
        alarms: ids
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

function hookSession() {
    if (_sessionHooked || typeof document === 'undefined' || !document.addEventListener) return;
    _sessionHooked = true;
    var onProj = function () { _resetPending = true; _alarmMap = {}; };
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
        }
    } catch (e) {}
    return p;
}
function writePrefs(p) { try { if (G.localStorage) G.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {} }
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
            btn('labels', ICON.tag + '<span class="wtsl-txt-md">Labels</span> <small>All</small>', { cls: 'wtsl-hide-sm wtsl-only3d', label: 'Labels', title: 'Labels: All / Equipment / Off (L)' }) +
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
        trends.innerHTML = [['sep', 'Sep P vs SP'], ['lvl', 'Bucket · interface'], ['surge', 'Surge level'], ['gt', 'Gauge A · B']].map(function (t) {
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
        h('esdReset', function (p, s) { toast('ESD reset — reopening', 'ok'); poke(); refreshNow(s); });
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
    }
    function unhookSim() {
        if (_sim) simHooks.forEach(function (x) { try { _sim.off(x[0], x[1]); } catch (e) {} });
        simHooks = [];
    }
    function poke() { dirty2d = true; tHud = 0; }
    // Immediate chrome refresh for safety-relevant events (ESD trip / reset), independent of the 4 Hz cadence.
    function refreshNow(s) { try { s = s || state(); updateToolbar(s); updatePill(s); } catch (e) {} }
    function createSim(flow) {
        var S = G.WTS_sim;
        if (!S || typeof S.create !== 'function') return;
        _sim = S.create(flow, { mode: 'steady', seed: (Date.now() & 0x7fffffff), speed: SPEEDS.indexOf(prefs.speed) >= 0 ? prefs.speed : 10 });
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
            onAction: function (a) { if (!ctl.disposed && a && a.type === 'esd-trip') askTrip(E.esd); },
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
        fails.push(t);
        if (fails.length >= 2) { fallback('3D stopped after repeated graphics errors'); return; }
        if (err && (err.code === 'context-lost' || err.message === 'context-lost')) {
            showNotice('3D paused — restoring graphics…', false);
            pendingRemount = true;
            if (!document.hidden) remountSoon();
        } else if (mode === '3d') setMode('3d', 'recover');
    }
    function remountSoon() {
        if (!pendingRemount) return;
        var go = function () {
            if (ctl.disposed || !pendingRemount || document.hidden) return;
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
        updateToolbar(st); updateHud(st); updatePill(st); updateCard(st, false);
        if (popGroup) updatePop(st);
        show(E.paused, !!(st && !st.running));
    }
    function updateSlow(st) {
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
        hv('rG', R.gas_mmscfd, 'gasRate'); setText(E.h.rGA, trendArrow('gas', R.gas_mmscfd, 1.5 * Qg));
        var oil = num(R.oilMeter_stbd, R.oil_stbd), wat = num(R.waterMeter_bpd, R.water_bpd);
        hv('rO', oil, 'oilRate'); setText(E.h.rOA, trendArrow('oil', oil, 1.5 * Qo));
        hv('rW', wat, 'liquidRate'); setText(E.h.rWA, trendArrow('water', wat, 1.5 * Qw));
        hv('rR', R.gor_scf_stb, 'gor'); setText(E.h.rRA, trendArrow('gor', R.gor_scf_stb, Qo > 0 ? 1.5 * Qg * 1e6 / Qo : 0));
        hv('rB', R.bsw_pct, 'percent', 1); setText(E.h.rBA, trendArrow('bsw', R.bsw_pct, 100));
        // Cumulative
        hv('cO', C.oilIn_stb, 'oilVolume'); hv('cW', C.waterIn_bbl, 'volume'); hv('cG', C.gasIn_mmscf, 'gasVolume'); hv('cF', C.flare_mmscf, 'gasVolume');
        // Tanks and quality
        var pump = su.pump || {};
        var ps = pump.failed ? 'FAILED' : pump.tripped ? 'TRIPPED' : pump.on ? 'ON' : 'OFF';
        setHTML(E.h.tSu, 'Surge <b>' + pctStr(su.frac) + '</b> · P-201 ' + ps);
        var T = ga.tanks || [], act = num(ga.active, 0);
        var gtxt = [0, 1].map(function (i) {
            var t = T[i] || {}, v = num(t.Vo_bbl, 0) + num(t.Vw_bbl, 0);
            var p = fmtParts(T[i] ? v : NaN, 'volume', 1);
            return (i === act ? '<span class="a">▸' : '<span>') + (i ? 'B ' : 'A ') + '</span><b>' + p.v + '</b>';
        }).join(' · ') + ' ' + fmtParts(0, 'volume').u;
        var sh = R.shrink_pct;
        setHTML(E.h.tGt, gtxt + (isNum(sh) ? ' · shr ' + sh.toFixed(1) + '%' : ''));
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
        setText(h.t_tanks, 'Surge ' + pctStr(su.frac));
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
        track('wts_alarm_ack', { count: ids.length });
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
                ['J-T ΔT', function (s) { var v = N(s, 'choke').dTjt; return isNum(v) ? (unitsSys() === 'metric' ? (v * 5 / 9).toFixed(1) + ' °C' : v.toFixed(1) + ' °F') : '—'; }, 't'],
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
                ['Level', function (s) { return pctStr(s && s.surge && s.surge.frac); }, ''],
                ['Pressure', function (s) { return fmtU(s && s.surge && s.surge.P, 'pressureTank'); }, 'p', function (s, f) { return isNum(F(f, ['sim', 'surgeP_psig'])) ? 'SP ' + fmtU(f.sim.surgeP_psig, 'pressureTank') : null; }],
                ['Liquid', function (s) { var u = s && s.surge; return u ? fmtU(num(u.Vo_bbl, 0) + num(u.Vw_bbl, 0), 'volume') : '—'; }, '', function (s) { return s && s.surge && isNum(s.surge.cap_bbl) ? 'of ' + fmtU(s.surge.cap_bbl, 'volume') : null; }],
                ['Water cut', function (s) { var u = s && s.surge; return u && isNum(u.frac) && u.frac > 0.001 ? pctStr(num(u.fracW, 0) / u.frac) : '—'; }, ''],
                ['Pump', function (s) { var p = s && s.surge && s.surge.pump; return !p ? '—' : p.failed ? 'FAILED' : p.tripped ? 'TRIPPED' : p.on ? 'ON' : 'OFF'; }, ''],
                ['Time to HH', function (s) { var v = s && s.surge && s.surge.tFull_s; return isNum(v) ? fmtClockLocal(v) : '—'; }, ''],
                ['Flash gas', function (s) { var v = s && s.surge && s.surge.flash_mscfd; return isNum(v) ? v.toFixed(1) + ' MSCFD' : '—'; }, '']],
                spark: [{ keys: ['surgeFrac'], label: 'Level', cat: 'frac', lim: 'surgeL' }, { keys: ['surgeP'], label: 'Pressure', cat: 'pressureG' }],
                widget: 'strap' };
            case 'pump': return { rows: [
                ['State', function (s) { var p = s && s.surge && s.surge.pump; return !p ? '—' : p.failed ? 'FAILED' : p.tripped ? 'TRIPPED' : p.on ? 'ON' : 'OFF'; }, ''],
                ['Rate', function (s) { var p = s && s.surge && s.surge.pump; return fmtU(p && p.q_bpd, 'liquidRate'); }, '', function (s) { var p = s && s.surge && s.surge.pump; return p && isNum(p.design_bpd) ? 'design ' + fmtU(p.design_bpd, 'liquidRate') : null; }],
                ['Line vel', function (s) { var g = s && s.segs && s.segs[5]; return g ? fmtU(g.vel, 'velocity') + ' · ' + Math.round(num(g.vPct, 0)) + '%' : '—'; }, ''],
                ['Surge level', function (s) { return pctStr(s && s.surge && s.surge.frac); }, '']] };
            case 'gauge': return { rows: [
                ['Active', function (s) { var g = s && s.gauge; return g && g.tanks && g.tanks[g.active] ? g.tanks[g.active].tag : '—'; }, ''],
                ['T-301A', function (s) { return gtRow(s, 0); }, ''],
                ['T-301B', function (s) { return gtRow(s, 1); }, ''],
                ['Last batch', function (s) { var r = s && s.rates; return fmtU(r && r.tank_stbd, 'oilRate'); }, ''],
                ['BS&W', function (s) { var r = s && s.rates; return fmtU(r && r.bsw_pct, 'percent', 1); }, ''],
                ['Shrinkage', function (s) { var r = s && s.rates; return fmtU(r && r.shrink_pct, 'percent', 1); }, '']],
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
    function gtRow(s, i) {
        var t = s && s.gauge && s.gauge.tanks && s.gauge.tanks[i];
        if (!t) return '—';
        return fmtU(num(t.Vo_bbl, 0) + num(t.Vw_bbl, 0), 'volume', 1) + ' · ' + String(t.state || '').toUpperCase();
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
            var ready = other && other.state === 'ready';
            sig = 'swap' + ready;
            h = '<button type="button" data-wts-ui class="wtsl-b" data-act="swap"' + (ready ? '' : ' disabled title="Standby compartment not ready"') + '>Swap tank</button>';
        }
        if (cardRefs.act.__sig !== sig) { cardRefs.act.__sig = sig; cardRefs.act.innerHTML = h; }
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
        setAttr(cardRefs.chip, 'data-s', stt);
        setText(cardRefs.chip, stt === 'ok' ? 'Normal' : stt === 'evt' ? 'Info' : stt === 'hyd' ? 'Hydrate' : stt);
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
            var u = st.surge || {}, H = num(u.H, 19.86);
            bar(40, 6, 46, 118, u.fracW, u.frac, [[u.lsll, R, 'LL'], [u.lsl, A, 'L'], [u.lsh, A, 'H'], [u.lshh, R, 'HH']], pctStr(u.frac), strapText(num(u.frac, 0) * H));
            c.fillStyle = '#6e7681'; c.textAlign = 'left';
            for (var k = 0; k <= 4; k++) { var yy = 6 + 118 * (1 - k / 4); c.fillText(strapText(H * k / 4), 150, yy + 3); c.fillRect(140, yy, 6, 1); }
        } else {
            var g = st.gauge || {}, T = g.tanks || [];
            [0, 1].forEach(function (i) {
                var t = T[i] || {}, Ht = num(t.H, 11.17), x = i ? 176 : 36;
                bar(x, 6, 46, 104, t.fracW, t.frac, [[t.switchFrac, A, i ? '' : 'SW'], [t.lahh, R, i ? '' : 'HH']], (i ? 'B ' : 'A ') + strapText(num(t.frac, 0) * Ht),
                    String(t.state || '').toUpperCase(), i === num(g.active, 0));
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
                var su = histOf('surgeFrac', 180);
                if (su) ser.push({ t: su.t, y: su.y, c: '#e6edf3' });
                range = [0, 1];
                if (st && st.surge) { lims = [[st.surge.lsl, '#d29922'], [st.surge.lsh, '#d29922']]; val = pctStr(st.surge.frac); }
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
        tankFill(bx[0], by, 32, 38, su.fracW, su.frac);
        var at = T[num(ga.active, 0)] || {};
        tankFill(bx[1], by, 36, 36, at.fracW, at.frac);
        ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
        if (at.tag) ctx.fillText(at.tag.slice(-1), bx[1] + 12, by - 7);
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
        bars.forEach(function (b) {
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
    // 2D hit zones (logical units): equipment, strip bars and readouts → pick ids.
    function zones2d(L) {
        var z = [], ids = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare'];
        for (var i = 0; i < 6; i++) z.push({ id: ids[i], x: L.tx[i] - 36, y: L.cy - 44, w: 72, h: 76 });
        z.push({ id: 'surge', x: L.bx[0] - 28, y: L.by - 30, w: 56, h: 58 });
        z.push({ id: 'gauge', x: L.bx[1] - 30, y: L.by - 30, w: 60, h: 58 });
        var S = L.strip || { x: 20, y: 215, w: 600, h: 103 };
        var sb = ['separator', 'separator', 'surge', 'gauge', 'gauge'];
        for (var j = 0; j < 5; j++) z.push({ id: sb[j], x: S.x + 12 + 55 * j, y: S.y + 16, w: 32, h: 86, strip: true });
        var rd = ['wellhead', 'choke', 'separator', 'surge'];
        for (var k = 0; k < 4; k++) z.push({ id: rd[k], x: S.x + 306 + (k % 2) * 140, y: S.y + 12 + Math.floor(k / 2) * 44, w: 136, h: 42, strip: true });
        return z;
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
            rows = [['Surge level', pctStr(su.frac)], ['Pump P-201', su.pump ? (su.pump.failed ? 'FAILED' : su.pump.tripped ? 'TRIPPED' : su.pump.on ? 'ON' : 'OFF') : '—'],
                ['T-301A', gtRow(st, 0)], ['T-301B', gtRow(st, 1)], ['Shrinkage', fmtU(R.shrink_pct, 'percent', 1)]];
            if (!T.length) rows.length = 2;
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
            case 'labels': cycleLabels(); break;
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
            case 'focus': if (v && EQ_IDS.indexOf(v) >= 0) { if (h3) { try { h3.focus(v); } catch (e) {} } openCard(v); } break;
            case 'card-close': closeCard(); break;
            case 'card-edit': editInputs(cardId); break;
            case 'bean': { var b = readHost('wts_bean'); if (isNum(b)) { setHostInput('wts_bean', clamp(b + (+v), 4, 128), null, 'input'); } later(function () { renderCardActions(state()); }, 0); break; }
            case 'bypass': { var bel = hostEl('wts_bypass'); if (bel) setHostInput('wts_bypass', bel.value === '1' ? '0' : '1', null, 'change'); renderCardActions(state()); break; }
            case 'sp': { var p = readHost('wts_Psep'); if (isNum(p)) setHostInput('wts_Psep', Math.max(5, p + (+v)), 'pressureG', 'input'); later(function () { renderCardActions(state()); }, 0); break; }
            case 'swap': if (_sim) { var ok = false; try { ok = _sim.switchGaugeTank(true); } catch (e) {} if (!ok) toast('Standby compartment not ready'); poke(); } break;
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
            var id = hit2d(ev);
            if (id) openCard(id); else closeCard();
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
        on(document, 'app-backgrounded', onBackground);
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
        _reset: function () { if (_ctl) { try { _ctl.dispose(); } catch (e) {} } _ctl = null; if (_sim) { try { _sim.dispose(); } catch (e) {} } _sim = null; _lastFlowObj = null; _resetPending = false; _alarmMap = {}; } }
};

})();

// ─── END 38-wts-live ─────────────────────────────────────────────

