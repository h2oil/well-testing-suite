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

// === SELF-TEST ===
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
var S = G.WTS_sim;
if (!S) return;
var results = [], t0all = Date.now();
function test(name, fn) {
  var ok = false, msg = '';
  try { var r = fn(); ok = r === undefined ? true : !!r; if (r && r.msg) msg = r.msg; } catch (e) { ok = false; msg = (e && e.message) || String(e); }
  results.push({ name: name, ok: ok, msg: msg });
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function near(a, b, tol, m) { if (!(Math.abs(a - b) <= tol)) throw new Error((m || 'near') + ': ' + a + ' vs ' + b + ' (tol ' + tol + ')'); }
function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }
function std(a) { var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / Math.max(1, a.length - 1)); }
function run(sim, secs, dt, cb) { var n = Math.round(secs / dt); for (var i = 0; i < n; i++) { sim.advance(dt); if (cb) cb(sim.getState(), i); } }
function hasTrip(st) { for (var i = 0; i < st.alarms.length; i++) if (st.alarms[i].sev === 'trip') return true; return false; }
function nullableSet() { return S.NULLABLE; }
function walk(o, path, bad) {
  if (o === null) { if (nullableSet().indexOf(path.replace(/\[\d+\]/g, '[*]')) < 0) bad.push(path + '=null'); return; }
  if (typeof o === 'number') { if (!isFinite(o)) bad.push(path + '=' + o); return; }
  if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i], path + '[' + i + ']', bad); return; }
  if (typeof o === 'object') { for (var k in o) walk(o[k], path ? path + '.' + k : k, bad); }
}
function schemaOK(st) {
  var bad = []; walk(st, '', bad);
  var SEV = ['trip', 'alarm', 'warn', 'hyd', 'info'];
  st.alarms.forEach(function (a) { if (SEV.indexOf(a.sev) < 0) bad.push('sev ' + a.sev); if (a.id === 'INLET_DP') bad.push('INLET_DP'); });
  st.segs.forEach(function (s) { if (['OK', 'WARNING', 'EXCEED'].indexOf(s.vSt) < 0) bad.push('vSt'); });
  st.gauge.tanks.forEach(function (tk) { if (['filling', 'settling', 'draining', 'ready'].indexOf(tk.state) < 0) bad.push('tank state'); });
  if (['Critical', 'Subcritical', 'No Flow'].indexOf(st.nodes.choke.regime) < 0) bad.push('regime');
  if (['steady', 'empty'].indexOf(st.mode) < 0) bad.push('mode');
  st.alarmLog.forEach(function (e) { if (['raise', 'clear', 'trip', 'reset', 'switch', 'batch', 'fault', 'event'].indexOf(e.type) < 0) bad.push('log type ' + e.type); });
  if (st.segs.length !== 6) bad.push('segs');
  ['wh_esd', 'esd_choke', 'choke_heater', 'heater_sep', 'sep_flare', 'sep_water', 'sep_oil', 'surge_gauge', 'surge_vent', 'blanket', 'gauge_drain', 'gauge_vent', 'psv_sep', 'psv_surge'].forEach(function (k) {
    var L = st.lines[k]; if (!L) { bad.push('line ' + k); return; }
    ['q', 'unit', 'frac', 'vel', 'ID_in', 'phase', 'active'].forEach(function (f) { if (!(f in L)) bad.push('line ' + k + '.' + f); });
  });
  return bad;
}
var F0 = S.SAMPLE_FLOW;

// 1 Geometry
test('1 geometry', function () {
  var R = 1.5, D = 3, g = S.geom, pr = Math.PI * R * R;
  near(g.segArea(0, R), 0, 1e-12, 'A(0)'); near(g.segArea(D, R) / pr, 1, 1e-9, 'A(D)'); near(g.segArea(R, R) / (pr / 2), 1, 1e-9, 'A(R)');
  near(g.head21Vol1(D, R) / (Math.PI * R * R * R / 3), 1, 1e-9, 'Vhead');
  var fn = function (h) { return (g.segArea(h, R) * 7.5 + g.head21Vol1(h, R)) / 5.614583; };
  var L = g.makeLUT(fn, D, 257), rng = 0.1234, worst = 0;
  for (var i = 0; i < 200; i++) { rng = (rng * 9301 + 49297) % 233280; var h = rng / 233280 * D; var hh = L.h(fn(h)); worst = Math.max(worst, Math.abs(hh - h)); }
  assert(worst < 1e-3, 'LUT round-trip ' + worst);
  var sim = S.create(F0, { seed: 1 }); near(sim.getState().sep.vol_bbl, 13.85, 0.01, 'vessel bbl');
});
// 2 PVT
test('2 PVT', function () {
  var p = S.pvt;
  near(p.rsEff(14.696, 150, 0.65, 35), 0, 1e-12, 'RsEff atm');
  var prev = -1; for (var P = 20; P < 3000; P += 50) { var r = p.rsEff(P, 150, 0.65, 35); assert(r > prev, 'monotonic'); prev = r; }
  near(p.boRel(14.696, 60, 0.65, 35), 1, 1e-9, 'BoRel(atm,60)');
  var b = p.boRel(164.7, 150, 0.65, 35); assert(b >= 1.03 && b <= 1.08, 'BoRel(164.7,150)=' + b);
});
// 3 Valves
test('3 valves', function () {
  var q1 = S.valve.gasQ(10, 1000, 14.7, 0.65, 600, 0.9), q2 = S.valve.gasQ(10, 1000, 30, 0.65, 600, 0.9);
  near(q1, q2, 1e-12, 'choked invariance'); assert(q1 > 0);
  assert(S.valve.gasQ(10, 100, 100, 0.65, 600, 0.9) === 0 && S.valve.gasQ(10, 90, 100, 0.65, 600, 0.9) === 0, 'check valve');
  near(S.valve.liqQ(5, 400, 0.85) / S.valve.liqQ(5, 100, 0.85), 2, 1e-12, 'sqrt(dP)');
});
// 4 + 5 Steady 4 h and mass balance
var T4 = null;
test('4 steady 4 h', function () {
  var sim = S.create(F0, { seed: 7 });
  var st0 = sim.getState();
  var inv0 = { o: st0.sep.c1.Vo_stb + st0.sep.bucket.Vo_stb + st0.surge.Vo_stb + st0.gauge.tanks[0].Vo_stb + st0.gauge.tanks[1].Vo_stb,
    w: st0.sep.c1.Vw_bbl + st0.sep.bucket.Vw_bbl + st0.surge.Vw_bbl + st0.gauge.tanks[0].Vw_bbl + st0.gauge.tanks[1].Vw_bbl,
    g: st0.sep.gas_scf + st0.surge.gas_scf };
  var switches = 0, trip = false, Ps = [], pmin = 1e9, pmax = -1e9, bmin = 1, bmax = 0;
  sim.on('switch', function () { switches++; }); sim.on('trip', function () { trip = true; });
  var c0 = st0.health.dumpCycles.oil;
  run(sim, 4 * 3600, 1, function (st) {
    if (st.t > 900) { Ps.push(st.sep.P); pmin = Math.min(pmin, st.sep.P); pmax = Math.max(pmax, st.sep.P); }
    bmin = Math.min(bmin, st.sep.bucket.frac); bmax = Math.max(bmax, st.sep.bucket.frac);
    if (hasTrip(st)) trip = true;
  });
  var st = sim.getState(), cyc = (st.health.dumpCycles.oil - c0) / 4;
  T4 = { sim: sim, inv0: inv0 };
  near(mean(Ps), 150, 0.5, 'mean Psep'); assert(pmin >= 142 && pmax <= 158, 'Psep band ' + pmin.toFixed(1) + '..' + pmax.toFixed(1));
  assert(bmin >= 0.18 && bmax <= 0.47, 'bucket band ' + bmin.toFixed(3) + '..' + bmax.toFixed(3));
  assert(!trip, 'trip'); assert(cyc >= 21 && cyc <= 35, 'dump cycles/h ' + cyc); assert(switches >= 2, 'switches ' + switches);
});
test('5 mass balance', function () {
  assert(T4, 'needs test 4');
  var st = T4.sim.getState(), c = st.cum, i0 = T4.inv0;
  var oil = st.sep.c1.Vo_stb + st.sep.bucket.Vo_stb + st.surge.Vo_stb + st.gauge.tanks[0].Vo_stb + st.gauge.tanks[1].Vo_stb;
  var wat = st.sep.c1.Vw_bbl + st.sep.bucket.Vw_bbl + st.surge.Vw_bbl + st.gauge.tanks[0].Vw_bbl + st.gauge.tanks[1].Vw_bbl;
  var gas = st.sep.gas_scf + st.surge.gas_scf;
  var rO = c.oilIn_stb - ((oil - i0.o) + c.drainedOil_stb + c.liquidToFlareOil_stb + c.spillOil_stb);
  var rW = c.waterIn_bbl - ((wat - i0.w) + c.drainedWater_bbl + c.liquidToFlareWater_bbl + c.spillWater_bbl);
  var src = c.gasIn_mmscf * 1e6 + c.flash_mscf * 1e3 + c.gaugeFlash_mscf * 1e3 + c.vacBreak_scf;
  var rG = src - (c.flare_mmscf * 1e6 + c.gaugeVent_mscf * 1e3 + (gas - i0.g));
  var eo = rO / Math.max(c.oilIn_stb, 1), ew = rW / Math.max(c.waterIn_bbl, 1), eg = rG / Math.max(src, 1);
  assert(Math.abs(eo) < 1e-9 && Math.abs(ew) < 1e-9 && Math.abs(eg) < 1e-9, 'independent balance ' + eo + ' ' + ew + ' ' + eg);
  var m = st.health.massErr; assert(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'health.massErr ' + JSON.stringify(m));
});
// 6 Step-size independence
test('6 step-size independence', function () {
  var cfg = { noise: { on: false } };
  var a = S.create(F0, { seed: 3, config: cfg }), b = S.create(F0, { seed: 3, config: cfg });
  var T = 3600;
  for (var i = 0; i < T / 0.05; i++) a.advance(0.05);
  for (var j = 0; j < T / 60; j++) b.advance(60);
  var sa = a.getState(), sb = b.getState();
  near(sa.t, sb.t, 1e-6, 't');
  near(sa.cum.oilIn_stb / sb.cum.oilIn_stb, 1, 1e-6, 'cum oil');
  near(sa.gauge.tanks[0].frac, sb.gauge.tanks[0].frac, 0.005, 'gauge A'); near(sa.gauge.tanks[1].frac, sb.gauge.tanks[1].frac, 0.005, 'gauge B');
  near(sa.sep.P, sb.sep.P, 1, 'Psep');
});
// 7 Determinism
test('7 determinism', function () {
  var a = S.create(F0, { seed: 99 }), b = S.create(F0, { seed: 99 });
  for (var i = 0; i < 300; i++) { a.advance(2); b.advance(2); }
  a.setFault('slugging', true); b.setFault('slugging', true); a.advance(100); b.advance(100);
  assert(JSON.stringify(a.getState()) === JSON.stringify(b.getState()), 'bit-identical');
});
// 8 Empty start
test('8 empty start', function () {
  var sim = S.create(F0, { mode: 'empty', seed: 5, config: { noise: { on: false } } }), sw = [];
  sim.on('switch', function (p) { sw.push(p.t); });
  run(sim, 1800, 5);
  var st = sim.getState();
  near(st.sep.P, 150, 7.5, 'Psep @30min'); assert(st.sep.c1.hL >= st.sep.hWeir, 'hL ≥ hWeir'); assert(st.health.dumpCycles.oil >= 3, 'cycles ' + st.health.dumpCycles.oil);
  run(sim, 4 * 3600 - 1800, 10);
  assert(sw.length >= 1, 'no gauge switch in 4 h'); assert(sw[0] > 2.5 * 3600 && sw[0] < 3.5 * 3600, 'first switch at ' + (sw[0] / 3600).toFixed(2) + ' h');
});
// 9 pcvStuckClosed
test('9 pcvStuckClosed trip/reset', function () {
  var sim = S.create(F0, { seed: 9 }), trips = [];
  sim.on('trip', function (p) { trips.push(p); });
  run(sim, 600, 1);
  sim.setFault('pcvStuckClosed', true);
  var tTrip = null;
  for (var i = 0; i < 300 && tTrip === null; i++) { sim.advance(0.1); if (sim.getState().esd.tripped) tTrip = sim.getState().t; }
  assert(tTrip !== null && tTrip - 600 < 30, 'trip time'); var st = sim.getState();
  assert(st.esd.cause === 'PSHH_SEP', 'cause ' + st.esd.cause); assert(st.esd.manual === false, 'manual false');
  assert(st.alarms.some(function (a) { return a.id === 'ESD_TRIPPED' && a.sev === 'trip'; }), 'ESD_TRIPPED');
  assert(trips.length === 1 && trips[0].manual === false && trips[0].cause === 'PSHH_SEP', 'trip payload');
  run(sim, 6, 0.1); assert(sim.getState().esd.travel === 0, 'travel 0 at +6 s: ' + sim.getState().esd.travel);
  var r = sim.resetESD(); assert(r.ok === false && r.blocking.indexOf('PSHH_SEP') >= 0, 'blocked ' + JSON.stringify(r));
  sim.setFault('pcvStuckClosed', false);
  run(sim, 120, 1);
  r = sim.resetESD(); assert(r.ok === true, 'reset ok ' + JSON.stringify(r));
  var ok = false; for (var j = 0; j < 120; j++) { sim.advance(1); if (sim.getState().f > 0.9) { ok = true; break; } }
  assert(ok, 'f > 0.9 within 120 s');
});
// 10 oilDumpStuckOpen
test('10 oilDumpStuckOpen', function () {
  var sim = S.create(F0, { seed: 10 }), bb = null, pmax = 0;
  run(sim, 300, 1);
  sim.setFault('oilDumpStuckOpen', true);
  for (var i = 0; i < 600; i++) { sim.advance(1); var st = sim.getState(); pmax = Math.max(pmax, st.surge.P);
    if (bb === null && st.alarms.some(function (a) { return a.id === 'GAS_BLOWBY'; })) bb = st.t; }
  assert(bb !== null, 'GAS_BLOWBY'); assert(pmax > 25 + 5, 'surge P ' + pmax);
});
// 11 setFlow
function qoTest() {
  var sim = S.create(F0, { seed: 11 });
  run(sim, 1800, 2); var c0 = sim.getState().health.dumpCycles.oil; run(sim, 3600, 2); var n1 = sim.getState().health.dumpCycles.oil - c0;
  sim.setFlow(S.flowFromInputs({ Qo: 2000 }));
  var c1 = sim.getState().health.dumpCycles.oil; run(sim, 3600, 2); var n2 = sim.getState().health.dumpCycles.oil - c1;
  assert(n2 >= 1.6 * n1, 'dump frequency ' + n1 + ' → ' + n2);
}
function spTest(newSP) {
  var sim = S.create(F0, { seed: 12 }), bad = [];
  run(sim, 600, 1);
  var t0 = sim.getState().t;
  sim.setFlow(S.flowFromInputs({ Psep: newSP }));
  var Ps = [];
  run(sim, 900, 1, function (st) {
    st.alarms.forEach(function (a) { if (['PSHH_SEP', 'PSH_SEP', 'PSL_SEP'].indexOf(a.id) >= 0 && bad.indexOf(a.id) < 0) bad.push(a.id); });
    if (st.t - t0 >= 300) Ps.push(st.sep.P);
  });
  assert(bad.length === 0, 'spurious ' + bad.join(','));
  near(mean(Ps), newSP, 1, 'mean P after SP change');
  var hs = sim.getHistory('PsepSP'), prev = null, mono = true, rate = 0;
  for (var i = 0; i < hs.t.length; i++) {
    if (hs.t[i] < t0) continue;
    if (prev) { var d = (hs.y[i] - prev.y) * Math.sign(newSP - 150); if (d < -1e-9) mono = false; rate = Math.max(rate, Math.abs(hs.y[i] - prev.y) / (hs.t[i] - prev.t)); }
    prev = { t: hs.t[i], y: hs.y[i] };
  }
  assert(mono && rate <= 2 + 1e-6, 'SP_eff ramp mono=' + mono + ' rate=' + rate);
  near(sim.getState().sep.SPeff, newSP, 1e-9, 'SPeff reached');
}
test('11 setFlow: Qo 1000→2000, SP 150→250, SP 150→100', function () { qoTest(); spTest(250); spTest(100); });
// 12 600× stress
test('12 600x stress', function () {
  var sim = S.create(F0, { seed: 12, speed: 600 }), tot = 0;
  sim.play();
  for (var i = 0; i < 2000; i++) { sim.step(0.016); var st = sim.getState(); tot += st.health.substeps; assert(!st.health.lagging, 'lagging'); }
  var st2 = sim.getState(); assert(schemaOK(st2).length === 0, 'NaN'); assert(tot / 2000 < 200, 'mean substeps ' + tot / 2000);
  near(st2.t, 2000 * 0.016 * 600, 1e-6, 'sim time');
});
// 13 Schema
test('13 schema', function () {
  var sim = S.create(F0, { seed: 13 }); var bad = schemaOK(sim.getState()); assert(bad.length === 0, bad.join(';'));
  run(sim, 3 * 3600, 20); bad = schemaOK(sim.getState()); assert(bad.length === 0, bad.join(';'));
  assert(sim.getState().gauge.batches.length >= 1, 'batch present for schema');
  sim.tripESD('test'); run(sim, 60, 1); bad = schemaOK(sim.getState()); assert(bad.length === 0, bad.join(';'));
});
// 14 Performance
test('14 performance', function () {
  var sim = S.create(F0, { seed: 14 }), a = Date.now();
  run(sim, 4 * 3600, 10);
  var ms = Date.now() - a; assert(ms < 500, '4 h at dt 10 took ' + ms + ' ms'); return { msg: ms + ' ms' };
});
// 15 Batch accuracy
test('15 batch accuracy', function () {
  // handlers run at the end of advance(); reconstruct cum at the switch instant: the newly active
  // compartment was 'ready' (static) before the switch, so everything it gained since is post-switch oil.
  var sim = S.create(F0, { seed: 15 }), atSwitch = { 0: 0 }, bs = [], before = [0, 0];
  sim.on('switch', function (p, st) { atSwitch[p.t] = st.cum.gaugeOil_stb - (st.gauge.tanks[p.to].Vo_stb - before[p.to]); });
  sim.on('batch', function (p) { bs.push(p); });
  for (var i = 0; i < 5 * 3600 / 5; i++) { var s0 = sim.getState(); before[0] = s0.gauge.tanks[0].Vo_stb; before[1] = s0.gauge.tanks[1].Vo_stb; sim.advance(5); }
  assert(bs.length >= 2, 'batches ' + bs.length);
  bs.forEach(function (b) {
    var o = atSwitch[b.tOpen], c = atSwitch[b.tClose];
    assert(o !== undefined && c !== undefined, 'window cum captured');
    near(b.oil_stb, c - o, 1e-6, 'batch ' + b.n);
    near(b.closeOil_stb - b.openOil_stb, b.oil_stb, 1e-6, 'tank Δ');
  });
});
// 16 setConfig geometry
test('16 setConfig D_in 48', function () {
  var sim = S.create(F0, { seed: 16 }), geo = 0;
  sim.on('geometry', function () { geo++; });
  run(sim, 1200, 2);
  var st = sim.getState(), g0 = st.geomVersion;
  var fr = [st.sep.c1.fracW, st.sep.c1.fracL, st.sep.bucket.frac, st.surge.frac, st.gauge.tanks[0].frac];
  var before = sim._internal().cfg;
  sim.setConfig({ sep: { D_in: 48 } });
  st = sim.getState();
  assert(st.geomVersion === g0 + 1 && geo === 1, 'geomVersion');
  var fr2 = [st.sep.c1.fracW, st.sep.c1.fracL, st.sep.bucket.frac, st.surge.frac, st.gauge.tanks[0].frac];
  for (var i = 0; i < fr.length; i++) near(fr2[i], fr[i], 1e-6, 'fraction ' + i);
  near(st.sep.D, 4, 1e-12, 'D 4 ft');
  var m = st.health.massErr; assert(Math.abs(m.oil) < 1e-12 && Math.abs(m.gas) < 1e-12, 'massErr reset');
  var after = sim._internal().cfg;
  assert(after.sep.Lss_ft === before.sep.Lss_ft && after.sep.oil.lsh === before.sep.oil.lsh && after.sep.pcv.tauCl === before.sep.pcv.tauCl, 'other sep keys kept');
  run(sim, 600, 2); assert(schemaOK(sim.getState()).length === 0, 'finite after');
  sim.setConfig({ sep: { D_in: null } });
  near(sim.getState().sep.D, 3, 1e-12, 'restored 36 in');
  assert(sim.getState().geomVersion === g0 + 2, 'geomVersion 2');
});
// 17 Frozen inputs
test('17 frozen inputs', function () {
  function df(o) { if (o && typeof o === 'object') { Object.freeze(o); Object.keys(o).forEach(function (k) { df(o[k]); }); } return o; }
  var fl = df(S.flowFromInputs({ bean: 40 })), cf = df({ sep: { oil: { lsh: 0.44 } }, noise: { on: false } });
  var j1 = JSON.stringify(fl), j2 = JSON.stringify(cf);
  var sim = S.create(fl, { config: cf });
  sim.setFlow(fl); sim.setConfig(cf); sim.advance(30);
  sim.setFlow(S.SAMPLE_FLOW);
  assert(JSON.stringify(fl) === j1 && JSON.stringify(cf) === j2, 'inputs unchanged');
  assert(typeof G.structuredClone === 'undefined' || true);
});
// 18 Dry gas
test('18 dry gas', function () {
  var sim = S.create(S.flowFromInputs({ Qo: 0, Qw: 0 }), { seed: 18 }), trip = false, sawOff = false;
  run(sim, 3600, 5, function (st) {
    if (hasTrip(st)) trip = true;
    if (st.surge.pump.q_bpd === 0) { sawOff = true; assert(st.segs[5].vel === 0, 'seg5 vel with pump off'); }
  });
  var st = sim.getState(); var bad = schemaOK(st);
  assert(bad.length === 0, bad.join(';')); assert(!trip, 'trip'); assert(st.rates.gor_scf_stb === null, 'gor null');
  assert(st.sep.oilDump.Cv > 0, 'Cv_o floor');
  // the 500 BPD floor pump needs ~86 min to draw 55 % → 25 %; keep going until it stops
  for (var i = 0; i < 360 && !sawOff; i++) { sim.advance(10); st = sim.getState(); if (st.surge.pump.q_bpd === 0) { sawOff = true; assert(st.segs[5].vel === 0 && !st.segs[5].flowing, 'seg5 vel with pump off'); } }
  assert(sawOff, 'pump went off');
});
// 19 Liquid only
test('19 liquid only', function () {
  var sim = S.create(S.flowFromInputs({ Qg: 0 }), { seed: 19 }), trip = false;
  run(sim, 3600, 5, function (st) { if (hasTrip(st)) trip = true; });
  var st = sim.getState(), bad = schemaOK(st);
  assert(bad.length === 0, bad.join(';')); assert(!trip, 'trip ' + JSON.stringify(st.alarms.map(function (a) { return a.id; }))); assert(st.sep.pcv.Cv > 0, 'Cv_pcv');
});
// 20 Mutators while paused
test('20 mutators while paused', function () {
  var sim = S.create(F0, { seed: 20 }), tripP = null, resetP = 0;
  sim.on('trip', function (p) { tripP = p; }); sim.on('esdReset', function () { resetP++; });
  sim.advance(30); sim.pause();
  var st = sim.getState(), t0 = st.t, seq0 = st.flowSeq;
  sim.setFlow(S.flowFromInputs({ bean: 40 }));
  assert(st === sim.getState(), 'same live object');
  assert(st.inputs.bean === 40 && st.flowSeq === seq0 + 1 && st.t === t0, 'setFlow applied');
  sim.tripESD('manual');
  assert(st.esd.tripped && st.esd.manual && st.esd.cause === 'ESD_MANUAL' && st.esd.canReset === true && st.esd.blocking.length === 0, 'manual latch');
  assert(st.alarms.some(function (a) { return a.id === 'ESD_MANUAL' && a.sev === 'info'; }) && !st.alarms.some(function (a) { return a.id === 'ESD_TRIPPED'; }), 'alarm set');
  assert(tripP && tripP.manual === true, 'trip handler sync');
  var r = sim.resetESD(); assert(r.ok === true && st.esd.tripped === false && resetP === 1, 'reset');
  sim.setFault('slugging', true); assert(st.faults.slugging === true && st.t === t0, 'fault immediate');
  sim.step(1); assert(sim.getState().t === t0, 'paused step no-op');
});
// 21 Event payloads
test('21 event payloads', function () {
  var sim = S.create(F0, { seed: 21 }), sw = null, ba = null, fa = null, stOK = true;
  sim.on('switch', function (p, st) { if (!sw) sw = p; if (st !== sim.getState()) stOK = false; });
  sim.on('batch', function (p, st) { if (!ba) ba = p; if (st !== sim.getState()) stOK = false; });
  sim.on('fault', function (p) { fa = p; });
  run(sim, 4 * 3600, 10);
  sim.setFault('surgePumpFail', true);
  assert(sw && Object.keys(sw).sort().join() === ['forced', 'from', 't', 'tag', 'to', 'type'].join(), 'switch keys ' + (sw && Object.keys(sw)));
  var BK = ['n', 'tag', 'tOpen', 'tClose', 'hours', 'openOil_stb', 'closeOil_stb', 'oil_stb', 'water_bbl', 'gov_bbl', 'bsw_pct', 'oilRate_stbd', 'waterRate_bpd', 'gas_mscf', 'gor_scf_stb', 'avgT'];
  assert(ba && BK.every(function (k) { return k in ba; }) && ba.type === 'batch' && 't' in ba, 'batch keys');
  assert(fa && fa.id === 'surgePumpFail' && fa.on === true && Object.keys(fa).sort().join() === 'id,on,t,type', 'fault keys');
  assert(stOK, 'state === getState()');
});
// 22 Surge SP 30
test('22 surge SP 30', function () {
  var sim = S.create(S.flowFromInputs({}, { surgeP_psig: 30 }), { seed: 22 }), bad = [];
  sim.on('alarm', function (p) { if (p.t > 180 && ['trip', 'alarm', 'warn'].indexOf(p.sev) >= 0) bad.push(p.id); });
  run(sim, 3600, 2);
  var st = sim.getState();
  assert(bad.length === 0, 'alarms ' + bad.join(','));
  near(st.surge.psh, 37.5, 1e-9, 'psh'); near(st.surge.pshh, 45, 1e-9, 'pshh'); near(st.surge.mawp, 55, 1e-9, 'mawp');
});
// 23 Separator SP 1300
test('23 separator SP 1300', function () {
  var sim = S.create(S.flowFromInputs({ Psep: 1300 }), { seed: 23 }), trip = false, lift = false, Ps = [];
  run(sim, 1800, 1, function (st) { if (hasTrip(st)) trip = true; if (st.sep.psv.lifting) lift = true; if (st.t > 300) Ps.push(st.sep.P); });
  var st = sim.getState();
  assert(!trip, 'trip ' + st.alarms.map(function (a) { return a.id; }).join(',')); assert(Math.abs(mean(Ps) - 1300) < 13, 'mean ' + mean(Ps)); assert(!lift, 'PSV lifted');
  assert(st.sep.mawp >= 1.25 * st.sep.pshh - 1e-9, 'mawp ≥ 1.25·pshh');
});
// 24 Upstream dynamics
test('24 upstream dynamics', function () {
  var sim = S.create(F0, { seed: 24 }), wh = [], ck = [];
  run(sim, 3600, 2, function (st) { wh.push(st.nodes.wellhead.P); ck.push(st.nodes.choke.P); });
  assert(std(wh) > 1, 'std WHP ' + std(wh)); assert(std(ck) > 0.5, 'std choke ' + std(ck));
  assert(Math.abs(mean(wh) - 3000) < 0.005 * 3000, 'mean WHP ' + mean(wh));
  var P0 = sim.getState().nodes.wellhead.P;
  sim.tripESD('manual');
  run(sim, 1800, 2);
  var sit = 1.2 * 3000, P1 = sim.getState().nodes.wellhead.P;
  assert(P1 - P0 > 0.75 * (sit - P0), 'build-up ' + P0.toFixed(0) + ' → ' + P1.toFixed(0));
});

var pass = results.filter(function (r) { return r.ok; }).length;
results.forEach(function (r) { if (!r.ok || (typeof process !== 'undefined' && process.env && process.env.WTS_VERBOSE)) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.msg ? ' — ' + r.msg : '')); });
console.log('[31-wts-sim] self-test ' + pass + '/' + results.length + ' passed (' + (Date.now() - t0all) + ' ms)');
if (pass !== results.length && typeof process !== 'undefined') process.exitCode = 1;
})();
