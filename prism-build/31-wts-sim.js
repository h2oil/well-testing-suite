// =============================================================================
// 31-wts-sim.js — Well Test Simulator: DOM-free dynamic process simulation
// -----------------------------------------------------------------------------
// window.WTS_sim — the live model behind the 3D / 2D Well Test Simulator views.
//
//   WH-101 → SDV-101 (ESD) → CK-101 → H-101 → V-101 ─ gas → FE-101 → PCV-101 → FS-401
//                                               ├─ oil bucket → LCV-102 ─┐
//                                               └─ water (C1) → LCV-101 ─┴→ T-201 ─ gas → PCV-201 → flare hdr
//                                   V-101 gas → PCV-202 (blanket) → T-201
//   T-201 liquid → LCV-201 (no pump: driven by the surge tank pressure) → T-301A|B → P-201 → export / burner
//
// Rig-up (setRigup / opts.rigup): heater, separator, surge tank, gauge tank, P-201 and the flare can be taken
// out of the spread; the flow path, process calculations, alarms and the snapshot follow (see normRigup).
// SDV-101 (safety-critical) and CK-101 (required) are always in the rig-up.
// Optional items (v1.4.0, docs/SIM-EQUIPMENT-PLAN.md): DS-101 cyclonic desander between SDV-101 and CK-101 and
// T-202 second surge tank in parallel with T-201 — out by default (RIG_DEFAULTS); a missing key takes the item's
// default (core = in, optional = in only when strictly true). With both out and no sand the engine is v1.3.0.
// v1.5.0 (docs/SIM-FOLLOWUP-PLAN.md): optional CK-102 heater inlet choke (out by default; in line only through the heater),
// the V-101-out bypass destination (burner / flare line or a production line) and the cushion-unload scenario. With CK-102
// out, the destination 'flare', V-101 in and no cushion the engine is v1.4.0 (frozen copy tests/_wts-sim-v331.js).
//
// Contents
//   • geometry (horizontal 2:1-head vessel compartments, vertical tanks), LUTs
//   • PVT (Standing Rs/Bo, calc-identical Z and hydrate line), ISA gas valve, liquid valve
//   • sim factory: adaptive substeps + event location, exact per-phase mass balance,
//     gain-scheduled PI pressure control, 3-phase separator with weir/bucket and snap
//     dump valves, surge tank with BPV / blanket / PSV / pressure-driven transfer valve,
//     twin-compartment gauge tank batch cycle with its discharge pump, rig-up routing,
//     upstream node dynamics (noise, drawdown, build-up),
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
  gauge: 'T-301', gaugeA: 'T-301A', gaugeB: 'T-301B', flare: 'FS-401',
  surgeA: 'T-201A', surgeB: 'T-201B', xvSurgeA: 'XV-201A', xvSurgeB: 'XV-201B', xvGaugeA: 'XV-301A', xvGaugeB: 'XV-301B', xfer: 'LCV-201',
  // v1.4.0 optional items: DS-101 desander (accumulator dump XV-103, bypass HV-104) and T-202 second surge tank
  desander: 'DS-101', dsDump: 'XV-103', dsBypass: 'HV-104', surge2: 'T-202', xvSurge2: 'XV-202', bpv2: 'PCV-203',
  blanket2: 'PCV-204', psvSurge2: 'PSV-202', lgSurge2: 'LG-202', xfer2: 'LCV-202',
  // v1.5.0: CK-102 heater inlet choke (PAH-102 between the chokes), PSHH-104 on the V-101 bypass path, production-line tie-in
  heaterChoke: 'CK-102', pahCk2: 'PAH-102', pshhSepBy: 'PSHH-104', nrvLine: 'NRV-501', xvLine: 'XV-501' });
var NAMES = deepFreeze({ wellhead: 'Wellhead', esd: 'ESD Valve (SSV)', choke: 'Choke Manifold', heater: 'Line Heater',
  separator: 'Test Separator', flare: 'Flare Stack', surge: 'Surge Tank', pump: 'Transfer Pump', gauge: 'Gauge Tank', xfer: 'Surge Transfer Valve',
  desander: 'Cyclonic Desander', surge2: 'Surge Tank 2', xfer2: 'T-202 Transfer Valve', heaterChoke: 'Heater inlet choke' });
// surge.transfer is the same object as surge.pump (legacy key: the surge outlet transfer, now LCV-201 — no pump)
var NULLABLE = deepFreeze(['esd.cause', 'esd.tripT', 'surge.tFull_s', 'surge.pump.trip', 'surge.transfer.trip', 'rates.gor_scf_stb', 'rates.bsw_pct', 'rates.tank_stbd',
  'rates.shrink_pct', 'alarms[*].value', 'alarms[*].limit', 'alarmLog[*].sev',
  'gauge.batches[*].gor_scf_stb', 'gauge.batches[*].bsw_pct',
  'desander.dump.lastT', 'surge2.tFull_s', 'surge2.transfer.trip',
  // v1.5.0: CK-102 bean / position from the flow block (no block → null); cushion breakthrough time (none yet → null)
  'inputs.bean2', 'inputs.ck2Pos', 'cushion.tBreak']);
// surgePumpFail keeps its id: it is the transfer pump P-201, now downstream of the gauge tank (gauge tank → export / burner)
// (append only: the v1.4.0 ids follow the v1.3.0 ones; faults on equipment out of the rig-up are accepted and act once it is in)
var FAULT_IDS = ['pcvStuckClosed', 'pcvStuckOpen', 'oilDumpStuckOpen', 'oilDumpStuckClosed', 'waterDumpStuckClosed', 'surgePumpFail', 'slugging', 'xferStuckClosed',
  'desanderPlugged', 'desanderWashout', 'desanderDumpStuck', 'desanderIsoPassing', 'desanderBypassPassing', 'sandFlowback', 'xfer2StuckClosed', 'bpv2StuckClosed'];
var FAULT_LABELS = { pcvStuckClosed: 'PCV-101 stuck closed', pcvStuckOpen: 'PCV-101 stuck open', oilDumpStuckOpen: 'LCV-102 stuck open',
  oilDumpStuckClosed: 'LCV-102 stuck closed', waterDumpStuckClosed: 'LCV-101 stuck closed', surgePumpFail: 'P-201 failed', slugging: 'Slug flow',
  xferStuckClosed: 'LCV-201 stuck closed',
  desanderPlugged: 'DS-101 liner plugged', desanderWashout: 'DS-101 liner washed out', desanderDumpStuck: 'XV-103 stuck closed',
  desanderIsoPassing: 'DS-101 isolation passing', desanderBypassPassing: 'HV-104 passing', sandFlowback: 'Sand flow-back',
  xfer2StuckClosed: 'LCV-202 stuck closed', bpv2StuckClosed: 'PCV-203 stuck closed' };
// ─── rig-up (which equipment is in the surface spread) ───────────────────────
// RIG_KEYS: signature order, APPEND ONLY (the first 8 characters of sig keep their v1.3.0 meaning).
var RIG_KEYS = ['esd', 'choke', 'heater', 'separator', 'surge', 'gauge', 'pump', 'flare', 'desander', 'surge2', 'heaterChoke'];
// RIG_ITEMS: display order = process order (consumers look items up by key, never by index). Core items carry no
// optional / def field (missing def = in, missing optional = core); optional items are out by default.
var RIG_ITEMS = deepFreeze([
  { key: 'esd', tag: 'SDV-101', name: 'ESD valve (SSV)', locked: true, why: 'Safety-critical: SDV-101 shuts in the well on every trip, so it is always in the rig-up.' },
  { key: 'desander', tag: 'DS-101', name: 'Cyclonic desander (upstream of the choke)', optional: true, def: false,
    why: 'Optional: removes sand from the well stream before the choke. Must be rated for the maximum shut-in wellhead pressure (no relief valve).' },
  { key: 'choke', tag: 'CK-101', name: 'Choke manifold / data header', locked: true, why: 'Required: the choke sets the rate and takes the wellhead pressure down to the separator.' },
  { key: 'heaterChoke', tag: 'CK-102', name: 'Heater inlet choke', optional: true, def: false, needs: 'heater',
    why: 'Optional: a second adjustable choke on the H-101 inlet. It takes part of the pressure drop and is in line only while the stream goes through the heater.' },
  { key: 'heater', tag: 'H-101', name: 'Line heater (steam exchanger)' },
  { key: 'separator', tag: 'V-101', name: 'Test separator' },
  { key: 'surge', tag: 'T-201', name: 'Surge tank' },
  { key: 'surge2', tag: 'T-202', name: 'Second surge tank', optional: true, def: false, needs: 'surge',
    why: 'Optional: a second pressurised surge tank in parallel with T-201 (needs T-201 in the rig-up).' },
  { key: 'gauge', tag: 'T-301', name: 'Gauge tank' },
  { key: 'pump', tag: 'P-201', name: 'Transfer pump (gauge tank → export / burner)' },
  { key: 'flare', tag: 'FS-401', name: 'Flare / burner' }]);
var RIG_OPTIONAL = deepFreeze(['desander', 'surge2', 'heaterChoke']);
var RIG_DEFAULTS = deepFreeze({ esd: true, choke: true, heater: true, separator: true, surge: true, gauge: true, pump: true, flare: true,
  desander: false, surge2: false, heaterChoke: false });
var RIG_OPT = { desander: true, surge2: true, heaterChoke: true };   // private lookup: the optional items
// rigVal(q, k): the requested state of item k in request q (D2). Core: missing / null → in, otherwise in unless false
// (the v1.3.0 rule); optional: in only when strictly true (missing, null, strings, numbers → out).
function rigVal(q, k) {
  if (RIG_OPT[k] === true) return !!(q && q[k] === true);
  return !(q && hasOwn(q, k) && q[k] === false);
}
function fmtLineP(P) { var v = num(P, 150); return (v < 0 ? 0 : v).toFixed(0); }   // production-line pressure in the rig-up notes
// normRigup(requested, o?) → { rig: effective flags, notes: [plain-text explanations], sig, full, extras }.
// Impossible combinations are resolved here (never by breaking the simulation) and explained in the notes.
// full = every core (non-optional) item in; extras = the optional items in, in RIG_KEYS order.
// o (v1.5.0, optional): {sepByDest: 'flare' | 'line', P: production line psig} = the V-101-out destination (cfg.sep.bypass);
// a call without o behaves as dest 'flare' (the v1.4.0 rules and notes exactly). With dest 'line' V-101 and FS-401 may both be
// out (whole stream to the production line); dest 'flare' re-forces FS-401 in (D4). Pure.
function normRigup(req, o) {
  var q = isPlainObj(req) ? req : {}, r = {}, notes = [], i, k;
  var line = isPlainObj(o) && o.sepByDest === 'line', lineP = line ? fmtLineP(o.P) : '';
  for (i = 0; i < RIG_KEYS.length; i++) { k = RIG_KEYS[i]; r[k] = rigVal(q, k); }
  if (!r.esd) { r.esd = true; notes.push('SDV-101 stays in the rig-up: the ESD valve is safety-critical.'); }
  if (!r.choke) { r.choke = true; notes.push('CK-101 stays in the rig-up: the choke is required to control the well.'); }
  var lineOnly = !r.separator && !r.flare && line;            // V-101 and FS-401 out, whole stream to the production line
  if (!r.separator && !r.flare && !line) { r.flare = true; notes.push('No separator and no flare would leave the well stream nowhere to go, so FS-401 stays in the rig-up.'); }
  if (!r.gauge && r.pump) { r.pump = false; notes.push('P-201 only empties the gauge tank, so with no gauge tank it is out of the line.'); }
  if (!r.heater) notes.push('H-101 bypassed: no heat input, so downstream temperatures fall to the choke outlet temperature (watch the hydrate warnings).');
  if (!r.separator) notes.push((line ? 'V-101 bypassed: the whole well stream goes to the production line at ' + lineP + ' psig through NRV-501 / XV-501. '
      : 'V-101 bypassed: the whole well stream goes straight to the flare / burner (clean-up). ') +
    'There is no separation, so gas, oil and water meter rates, GOR, BS&W and tank batches are not available' +
    (r.surge || r.gauge ? ' and the tanks receive no liquid.' : '.'));
  else if (!r.surge && r.gauge) notes.push('No surge tank: V-101 dumps straight into the atmospheric gauge tank, so solution gas flashes and vents at T-301.');
  else if (!r.surge && !r.gauge) notes.push('No surge or gauge tank: V-101 dumps straight to the export / burner line (no tank batches, meter rates only).');
  else if (!r.gauge) notes.push('No gauge tank: T-201 transfers on its own vessel pressure straight to the export / burner line (no tank batches, meter rates only).');
  if (r.gauge && !r.pump) notes.push('No transfer pump: the gauge tank compartments empty by gravity drain (head-driven, slower).');
  if (!r.flare && !lineOnly) notes.push('No flare: separator gas goes to the export / sales gas line (no flame); relief valves and tank vents go to the atmospheric vent.');
  // optional-item rules, after the core ones: T-202 works only alongside T-201 (DS-101 has no rule; with the separator out,
  // T-202 is covered by the "the tanks receive no liquid" note above)
  if (r.surge2 && !r.surge) { r.surge2 = false; notes.push('T-202 works alongside T-201, so with T-201 out of the rig-up T-202 is out too.'); }
  // v1.5.0 (docs/SIM-FOLLOWUP-PLAN.md §3.2): CK-102 sits on the H-101 inlet; V-101 + FS-401 out is allowed only to a production line
  if (r.heaterChoke && !r.heater) { r.heaterChoke = false; notes.push('CK-102 sits on the H-101 inlet, so with H-101 out of the rig-up CK-102 is out too.'); }
  if (lineOnly) notes.push('V-101 and FS-401 out: whole stream to the production line at ' + lineP + ' psig (non-return valve NRV-501 and isolation valve XV-501 at the tie-in). Relief and vent gas of the tanks still in the rig-up goes to vent.');
  var sig = '', full = true, extras = [];
  for (i = 0; i < RIG_KEYS.length; i++) {
    k = RIG_KEYS[i]; sig += r[k] ? '1' : '0';
    if (RIG_OPT[k] === true) { if (r[k]) extras.push(k); }
    else if (!r[k]) full = false;
  }
  return { rig: r, notes: notes, sig: sig, full: full, extras: extras };
}
// stepFor(rig) → { eqId: '①' … }: equipment step numbers in process order. Core items are always counted, optional items
// only when rig[k] === true; the default rig-up gives the v1.3.0 numbering ①–⑨ exactly. Pure (32 / 38 keep a fallback).
var STEP_ORDER = ['wellhead', 'esd', 'desander', 'choke', 'heaterChoke', 'heater', 'separator', 'flare', 'surge', 'surge2', 'gauge', 'pump'];
function stepFor(rig) {
  var r = isPlainObj(rig) ? rig : {}, out = {}, n = 0;
  for (var i = 0; i < STEP_ORDER.length; i++) {
    var k = STEP_ORDER[i];
    if (RIG_OPT[k] === true && r[k] !== true) continue;
    n++; out[k] = String.fromCharCode(0x2460 + n - 1);
  }
  return out;
}
// node order is positional for several readers: append only (desander = index 8, surge2 = index 9, heaterChoke = index 10);
// snap.segs stays 6
var NODE_IDS = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare', 'surge', 'gauge', 'desander', 'surge2', 'heaterChoke'];
var SEG_META = [['wh_esd', 'wellhead', 'esd', 'WH→ESD'], ['esd_choke', 'esd', 'choke', 'ESD→Choke'], ['choke_heater', 'choke', 'heater', 'Choke→Heater'],
  ['heater_sep', 'heater', 'separator', 'Heater→Sep'], ['sep_flare', 'separator', 'flare', 'Sep→Flare'], ['surge_gauge', 'surge', 'gauge', 'Surge→Gauge Tank']];
var HIST_KEYS = ['Psep', 'PsepSP', 'bucketFrac', 'ifaceFrac', 'c1Frac', 'surgeFrac', 'surgeP', 'gaugeFracA', 'gaugeFracB', 'qgFlare', 'qoMeter', 'Pwh', 'Pchoke', 'Twh',
  'surgeFracA', 'surgeFracB', 'surge2Frac', 'surge2P', 'dsAccFrac', 'dsDP', 'sandChoke',
  'Pck2', 'cushionLeft'];                      // v1.5.0: CK-102 inlet (psig; the CK-101 outlet while CK-102 is not in line), cushion left (bbl)
var SUCTIONS = ['A', 'B', 'both'];

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
    lahhTotal: 0.80, psh: null, pshh: null, psl: null,
    // v1.5.0 V-101-out destination (docs/SIM-FOLLOWUP-PLAN.md §6.1): 'flare' = burner / flare line (inlet P_flare_psig, equal
    // to the pcv.P2_psig default so the legacy path is unchanged) | 'line' = production line at P_psig; bypass-path design
    // pressure (ASSUMPTION, B16.5 Class 600) with PSHH-104 at pshhFrac of it
    bypass: { dest: 'flare', P_psig: 150, P_flare_psig: 5, designP_psig: 1440, pshhFrac: 0.90 } },
  surge: { cap_bbl: 100, D_ft: 6, Psp: 25, psh: null, pshh: null, mawp: null, lsll: 0.05, lsl: 0.25, lsh: 0.70, lshh: 0.90,
    // pumpBpd / pumpMinBpd / pumpVelFrac: design rate of the surge outlet transfer (LCV-201 is sized to pass it at the
    // design ΔP — there is no pump between T-201 and T-301); xferMinDP: below this ΔP an open LCV-201 raises XFER_LOW_DP
    pumpBpd: null, pumpMinBpd: 500, pumpVelFrac: 0.7, psvMinMscfd: 50, xferMinDP: 1,
    bpv: { tauCl: 10, Ti: 30 }, blanket: { on: true, deadband: 1, band: 2 },
    // twin compartments A | B (half of cap_bbl each, common gas space); auto-divert defaults (overfill protection)
    // xvStrokeS: full-stroke time of the inlet divert valves XV-201A/B (on/off actuated ball valves, 5-10 s typical)
    autoSp: 0.80, autoHyst: 0.10, xvStrokeS: 6 },
  // lshhReset: LSHH-301 trip reset point — the tripped compartment must fall below it before P-201 can be reset
  // allowInterrupt: auto-divert may open a compartment that is settling / draining (batch in progress) — off by default
  gauge: { count: 2, cap_bbl: 100, D_ft: 8, switchFrac: 0.90, lahh: 0.97, heelFrac: 0.02, settleS: 600, drainBpd: null,
    autoSp: 0.90, autoHyst: 0.10, xvStrokeS: 6, lshhReset: 0.90, allowInterrupt: false,
    // P-201 (gauge tank → export / burner) empties a compartment at drainBpd; without P-201 in the rig-up the
    // compartment drains by gravity at gravityFrac·drainBpd·√(level fraction) (head-driven)
    gravityFrac: 0.35 },
  // ── v1.4.0 optional items (docs/SIM-EQUIPMENT-PLAN.md §6.2; read only while the item is in / sand is on) ──
  // DS-101 cyclonic wellhead desander: rating / SITHP design check, inlet velocity head ΔP (K), cut size, accumulator
  // and buffer (gal), alarm points, fault factors, dump sequence durations (s) and interlock limits (psig / psi)
  desander: { rating_psi: 10000, sithp_psig: null, tempMin_F: -50, tempMax_F: { 5000: 250, 10000: 350, 15000: 350 },
    Ain_ft2: 0.0341, K_dp: 6, dpAlarmHi: 75, dpHighRatio: 2, dpHighAdd: 5, dpLowFrac: 0.5, dpLowMin: 2,
    d50ref_um: 25, vref_fts: 30, muRef_cp: 1.0, drhoRef: 103, vMin_fts: 10, vMax_fts: 60, m: 2.0, gvfKnee: 0.90, gvfGain: 0.5,
    rhoSand: 165.4, porosity: 0.40, acc_gal: 50, buf_gal: 20, lah: 0.80, lahh: 0.95, effFillKnee: 0.90, packDpGain: 10,
    plugFactor: 3, washFactor: 0.3, washCut: 3, slugCut: 1.5, bypassLeak: 0.10, warmFactor: 3,
    dump: { isoS: 8, bleedS: 300, flushS: 600, equalS: 120, reopenS: 8, bleedTo_psig: 50, bleedTimeoutS: 600, equalTol_psi: 75,
      isoPassTauS: 30 },
    autoSp: 0.80, chokeCoupling: true, pshhFrac: 0.95, gvfGasLo: 0.95, gvfGasHi: 0.995 },
  // sand in the well stream (default none): lb per 1,000 bbl liquid, lb/MMscf gas, size distribution (µm, σg),
  // flow-back clean-up scenario, choke / separator thresholds, steel-equivalent erosion screening constants
  sand: { pptb: 0, lbPerMMscf: 0, d50_um: 150, sigmaG: 2.0, rateExp: 1.5,
    flowback: { W0_lbph: 200, tau_h: 6, d50_um: 400, sigmaG: 1.5 },
    chokeWarn_lbd: 5, chokeAlarm_lbd: 50, sepWarnFrac: 0.10,
    erosion: { K: 2.0e-9, n: 2.6, rhoT: 7800, alphaDeg: 60, cL_fts: 4000, allowance_mil: 125, testH: 72, warnFrac: 0.05,
      highFrac: 0.50 } },
  // T-202 second surge tank (one compartment, own gas space); null set points follow T-201 / its formulas
  surge2: { cap_bbl: 100, D_ft: 6, Psp: null, psh: null, pshh: null, mawp: null, lsll: 0.05, lsl: 0.25, lsh: 0.70, lshh: 0.90,
    pumpBpd: null, pumpMinBpd: 500, pumpVelFrac: 0.7, psvMinMscfd: 50, xferMinDP: 1, inletDP_psi: 3,
    bpv: { tauCl: 10, Ti: 30 }, blanket: { on: true, deadband: 1, band: 2 }, autoSp: 0.80, autoHyst: 0.10, xvStrokeS: 6 },
  // ── v1.5.0 (docs/SIM-FOLLOWUP-PLAN.md §5.1, §6.1; read only while CK-102 is in line / a cushion runs) ──
  // CK-102: 5 s first-order lag of its ΔP; design pressure between the chokes (ASSUMPTION, B16.5 Class 600) and PAH-102 at
  // pahFrac of it
  heaterChoke: { lagS: 5, designP_psig: 1440, pahFrac: 0.90 },
  // cushion unload (D6, D7): volume (bbl), SG, unload rate (bbl/d), tubing capacity (bbl/ft), depth (ft), reservoir-fluid
  // gradient (psi/ft), gas fraction while unloading, tail fraction / time constant (s), breakthrough blend (s), liquid Cd,
  // burner SG (text only), stall margin / un-stall hysteresis (psi), H-101 rating factor (ASSUMPTION); lim = form limits
  cushion: { V_bbl: 50, SG: 1.03, q_bpd: 1500, tbgCap_bblft: 0.00870, depth_ft: 10000, Gr_psift: 0.08, gasFrac: 0.05,
    tailFrac: 0.15, tailTau_s: 1800, breakTau_s: 600, Cd_liq: 0.85, burnerSG: 0.95, stallMargin_psi: 50,
    unstallHyst_psi: 25, htrRatedFactor: 1.25,
    lim: { V: [1, 500], SG: [0.80, 1.50], q: [100, 6000], cap: [0.003, 0.03], depth: [500, 25000] } } });
// v1.5.0 feature flags (D14): set by the same build and always equal (the Help content switches its texts on them)
var FEATURES = deepFreeze({ heaterChoke: true, bypassDest: true, cushion: true });

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
  warnings:[],sim:{sepID_in:36,sepLss_ft:10,surgeP_psig:25,surgeCap_bbl:100,gaugeCap_bbl:100,
    sand_pptb:0,sand_lbmmscf:0,sand_d50_um:150,desRating_psi:10000,desAcc_gal:50,sithp_psig:null,surge2Cap_bbl:100,
    sepByDest:'flare',sepByP_psig:150}});   // v1.5.0 (+2); SAMPLE_FLOW has no flow.ck2 / flow.sepBy block (the legacy path, D3)

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
  // v1.4.0 inputs (§6.3): finite values only, clamped to the host ranges (an Infinity typed as 1e400 never gets through);
  // sithp_psig blank / null = estimated (1.2 × WHP), so it is only taken when it is a finite number
  var sd = {}, ds = {}, s2 = {}, v;
  v = simNum(fs.sand_pptb); if (v !== null) sd.pptb = clamp(v, 0, 500);
  v = simNum(fs.sand_lbmmscf); if (v !== null) sd.lbPerMMscf = clamp(v, 0, 100);
  v = simNum(fs.sand_d50_um); if (v !== null) sd.d50_um = clamp(v, 20, 1000);
  v = simNum(fs.desRating_psi); if (v !== null) ds.rating_psi = (v === 5000 || v === 10000 || v === 15000) ? v : 10000;
  // capacities: a value ≤ 0 counts as missing (default kept), as for surgeCap_bbl and the host's wtsClamp(gv(..) || def, …)
  v = simNum(fs.desAcc_gal); if (v !== null && v > 0) ds.acc_gal = clamp(v, 10, 200);
  v = simNum(fs.sithp_psig); if (v !== null) ds.sithp_psig = clamp(v, 100, 20000);
  v = simNum(fs.surge2Cap_bbl); if (v !== null && v > 0) s2.cap_bbl = clamp(v, 20, 500);
  o.sand = sd; o.desander = ds; o.surge2 = s2;
  // v1.5.0 (§6.1): the V-101-out destination ('flare' | 'line', anything else 'flare') and the production-line pressure
  // (finite, clamped 0–1440; an entered 0 is kept); absent in an old flow → the DEFAULTS
  var by = {};
  if (hasOwn(fs, 'sepByDest') && fs.sepByDest !== null && fs.sepByDest !== undefined) by.dest = fs.sepByDest === 'line' ? 'line' : 'flare';
  v = simNum(fs.sepByP_psig); if (v !== null) by.P_psig = clamp(v, 0, 1440);
  o.sep.bypass = by;
  return o;
}
// a finite number from a flow.sim field, else null (null, '', undefined, booleans, non-finite → null)
function simNum(x) {
  if (x === null || x === undefined || x === '' || typeof x === 'boolean') return null;
  var v = +x; return isFin(v) ? v : null;
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
  // hot mutable doubles live on one object: V8 updates its fields in place (a closure variable holding a double
  // allocates a new heap number on every store — tens of thousands per simulated hour)
  var X = { t: 0, qBg: 0, qBo: 0, qBw: 0, xiG: 0, xiL: 0, xiW: 0, fInst: 0, f: 0, fE: 0, mg: 0, ml: 0, esdTravel: 0, Pwh: 0, PB: 0, theta: 0, tFlow: 0, tShut: 0, P0shut: 0, n_s: 0, Vw1: 0, Vo1: 0, Vw2: 0, Vo2: 0, SPe: 0, Ipcv: 0, upcv: 0, PsepA: 0, Psep: 0, Zs: 0, Bs: 0, Vg: 0, hW1: 0, hL1: 0, h2: 0, hW2: 0, Tsep: 0, psh: 0, pshh: 0, psl: 0, mawpE: 0, n_u: 0, Vou: 0, Vwu: 0, Tu: 0, SPeu: 0, Ibpv: 0, ubpv: 0, ublk: 0, PuA: 0, Pu: 0, Zu: 0, Bu: 0, VgU: 0, VliqU: 0, hU: 0, pshU: 0, pshhU: 0, mawpU: 0, P2aU: 0, emaOil: 0, emaWater: 0, emaGas: 0, emaFlash: 0, graceUntil: 0, dSPe: 0, dSPeu: 0, lastDraw: 0, lastQp: 0, Tpump: 80,
    ck2dP: 0 };                                 // v1.5.0: CK-102 ΔP lag (psi; a double on X, kept across derive(), §3.3 / D11)
  opts = isPlainObj(opts) ? opts : {};
  var initFlow = validFlow(flowIn) ? flowIn : SAMPLE_FLOW;
  var flow = normFlow(initFlow);
  var overrides = {};
  if (isPlainObj(opts.config)) mergeOverrides(overrides, deepClone(opts.config));
  var cfg = null;
  function buildCfg() { cfg = deepMerge(deepMerge(deepClone(DEFAULTS), flowDerived(flow.sim)), overrides); }
  buildCfg();
  // rig-up: rigReq = the requested items, RG = normRigup(rigReq); the hot path reads the effective flags below
  var rigReq = {}, RG = null, rigVersion = 0;
  var rSep = true, rSurge = true, rGauge = true, rPump = true, rFlare = true, rHeater = true;
  // optional items (both out by default) and sand in the well stream: every v1.4.0 per-substep block sits behind one of
  // these three flags, so the default spread runs the v1.3.0 code path (sandOn is set by desDerive, WP-E1)
  var rDes = false, rSurge2 = false, sandOn = false;
  // v1.5.0 effective state (docs/SIM-FOLLOWUP-PLAN.md §3.3; hoisted, never read from cfg per substep): rCk2 = CK-102 in the
  // rig-up, ck2Act = in line (rCk2 and the stream through H-101; set in derive), bypLine = V-101 out to a production line,
  // ventOn = V-101 and FS-401 out (only with bypLine). cushOn / cushHas (cushion running / a cushion exists since the last
  // start) are scenario state, not rig: set by startCushion / stopCushion / reset only, never by derive()
  var rCk2 = false, ck2Act = false, bypLine = false, ventOn = false, cushOn = false, cushHas = false;
  function setRigReq(o) { var q = isPlainObj(o) ? o : null; for (var i = 0; i < RIG_KEYS.length; i++) rigReq[RIG_KEYS[i]] = rigVal(q, RIG_KEYS[i]); }
  // the destination options of normRigup (cfg.sep.bypass; cfg is built before the first applyRig)
  function rigOpt() { var b = cfg && isPlainObj(cfg.sep) && isPlainObj(cfg.sep.bypass) ? cfg.sep.bypass : {}; return { sepByDest: b.dest === 'line' ? 'line' : 'flare', P: b.P_psig }; }
  function applyRig() {
    RG = normRigup(rigReq, rigOpt()); var r = RG.rig;
    rSep = r.separator; rSurge = r.surge; rGauge = r.gauge; rPump = r.pump; rFlare = r.flare; rHeater = r.heater;
    rDes = r.desander; rSurge2 = r.surge2;
    rCk2 = r.heaterChoke === true; rigFlags();
    rigVersion++;
  }
  // flags that follow the rig-up and the destination (applyRig, derive)
  function rigFlags() {
    bypLine = !rSep && rigOpt().sepByDest === 'line';
    ventOn = !rSep && !rFlare;
  }
  setRigReq(opts.rigup); applyRig();

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
  var chk = { regime: 'Critical', flowLimited: false, QmaxMMscfd: 0, wJT: 1, regimeBase: 'Critical' };
  var SS = [];                                  // steady segment data (6)
  // v1.5.0 steady-case selection (pickSteadyBlock, §5.2; reassigned on every derive): kind, the blocks in use, the destination
  // inlet P0, the V-101-out surge set point, the skipped-block note. Phi_ss = steady CK-102 outlet = H-101 inlet pressure.
  var SEL = { kind: 'base', ck2blk: null, sepByBlk: null, P0: 0, surgeP: null, ck2Note: '' };
  var Phi_ss = 0;
  // V-101 out (hoisted in derive; pDown reads only these): legacy burner / flare line inlet, and with a flow.sepBy block its
  // P0 and seg-5 whole-stream loss (WP-E2 bypDerive)
  var bypF0 = 5, bypP0 = 5, bypDP = 0;
  var D, R, Lss, xW, Lb, hWeir, Lw, lutC1, lutB, Vves, VB_hi, VB_lo, VW_hi, VW_lo;
  var Du, Atu, Hu, capU, capK, Dg, Atg, Hg, capG;
  var Cv_pcv, Cv_psv, Cv_o, Cv_w, Cv_bpv, Cv_mk, Cv_psvU, pumpDesign, drainBpd, qFlashD, A6, PspU, Cv_x, dPxD;
  var geomKey = '';

  // PVT closures (use the derived fluid constants)
  function Rs(Pa, TF) { return SGg > 0 ? SGg * mpow((Pa / 18.2 + 1.4) * mexp((k10 - 0.00091 * TF) * LN10), 1.2048) : 0; }
  // Hot-path memos (performance only — every value is bit-identical to the direct evaluation): the substep asks for
  // RsE / BoR at the same (P, T) several times (flash + vent at the surge tank, Bo of both vessels), and Rs at
  // atmospheric pressure per temperature. Small ring caches, cleared whenever the fluid changes (derive → boEpoch).
  // Four temperatures (T-201, T-202, separator, gauge tank): with T-202 in, a two-entry ring thrashed (WP-I perf gate).
  var rsA_T = [NaN, NaN, NaN, NaN], rsA_v = [0, 0, 0, 0], rsA_i = 0, rsA_e = -1;
  function RsAtm(TF) {
    if (rsA_e !== boEpoch) { rsA_e = boEpoch; rsA_T[0] = rsA_T[1] = rsA_T[2] = rsA_T[3] = NaN; }
    if (rsA_T[0] === TF) return rsA_v[0];
    if (rsA_T[1] === TF) return rsA_v[1];
    if (rsA_T[2] === TF) return rsA_v[2];
    if (rsA_T[3] === TF) return rsA_v[3];
    var v = Rs(PSC, TF); rsA_i = (rsA_i + 1) & 3; rsA_T[rsA_i] = TF; rsA_v[rsA_i] = v; return v;
  }
  var rsE_P = [NaN, NaN, NaN, NaN], rsE_T = [NaN, NaN, NaN, NaN], rsE_v = [0, 0, 0, 0], rsE_i = 0, rsE_e = -1;
  function RsE(Pa, TF) {
    if (Pa === PSC) return 0;                                   // Rs(PSC) − Rs(PSC) is exactly 0 (stock-tank Bo)
    if (rsE_e !== boEpoch) { rsE_e = boEpoch; rsE_P[0] = rsE_P[1] = rsE_P[2] = rsE_P[3] = NaN; }
    for (var j = 0; j < 4; j++) if (rsE_P[j] === Pa && rsE_T[j] === TF) return rsE_v[j];
    var r = Rs(Pa, TF) - RsAtm(TF);
    if (!(r > 0)) r = 0;
    rsE_i = (rsE_i + 1) & 3; rsE_P[rsE_i] = Pa; rsE_T[rsE_i] = TF; rsE_v[rsE_i] = r;
    return r;
  }
  function BoR(Pa, TF) { var x = RsE(Pa, TF) * sqRatio + 1.25 * TF; return (0.9759 + 1.2e-4 * mpow(x > 0 ? x : 0, 1.2)) / bo060; }
  function Zf(Pa, TR) {
    var pr = Pa / Ppc, tr = TR / Tpc;
    var z = 1 - 3.52 * pr / mexp(0.9813 * tr * LN10) + 0.274 * pr * pr / mexp(0.8157 * tr * LN10);
    return z < 0.3 ? 0.3 : (z > 1.2 ? 1.2 : z);
  }
  function Thyd(Pa) { return hydrateT(Pa, SGg); }
  var fkxt = FKXT_DEF;                          // per-sim valve constants (cfg.sep.pcv.k / xT)
  // memo (performance only, bit-identical): the PI gain and its feed-forward bias evaluate the same valve capacity
  var gqC = [NaN, NaN, NaN, NaN], gq1 = [0, 0, 0, 0], gq2 = [0, 0, 0, 0], gqT = [0, 0, 0, 0], gqZ = [0, 0, 0, 0], gqV = [0, 0, 0, 0], gqI = 0, gqE = -1;
  function gq(Cv, P1a, P2a, TR, Z) {
    if (gqE !== boEpoch) { gqE = boEpoch; gqC[0] = gqC[1] = gqC[2] = gqC[3] = NaN; }
    for (var j = 0; j < 4; j++) if (gqC[j] === Cv && gq1[j] === P1a && gq2[j] === P2a && gqT[j] === TR && gqZ[j] === Z) return gqV[j];
    var v = gasQ(Cv, P1a, P2a, SGg, TR, Z, fkxt);
    gqI = (gqI + 1) & 3; gqC[gqI] = Cv; gq1[gqI] = P1a; gq2[gqI] = P2a; gqT[gqI] = TR; gqZ[gqI] = Z; gqV[gqI] = v;
    return v;
  }

  // separator compartment volume functions (bbl) and derivatives (bbl/ft)
  function vC1(h) { return (segArea(h, R) * xW + head21Vol1(h, R)) / BBL; }
  function vB(h) { return (segArea(h, R) * Lb + head21Vol1(h, R)) / BBL; }
  function dA(h) { return 2 * msqrt(mmax(0, 2 * R * h - h * h)); }
  function dH(h) { return PI * h * (2 * R - h) / 4; }
  function dC1(h) { return (dA(h) * xW + dH(h)) / BBL; }
  function dB(h) { return (dA(h) * Lb + dH(h)) / BBL; }

  // ── dynamic state ──
  var running = opts.running === false ? false : true, speed = cfg.speed, mode = 'steady', disposed = false;
  var flowSeq = 0, flowTs = 0, geomVersion = 1, alarmVersion = 0, flowInvalid = false;
  var faults = {}; FAULT_IDS.forEach(function (k) { faults[k] = false; });
  // upstream
  var shut;
  // separator
  var psvLift, lcvO, lcvW;
  
  // surge
  var psvULift, pumpOn, pumpTrip, pumpBlocked = false;
  var uo = [0, 0], uw = [0, 0];                 // surge compartments A | B: oil (STB) and water (bbl); Vou / Vwu are their sums
  
  // gauge
  var tanks, active, batches, batchN;
  // operator lineup (persists across reset): inlet divert valves, pump suction, auto-divert
  var ctl = { surge: { inlet: [true, true], suction: 'both', auto: false, sp: num(cfg.surge.autoSp, 0.8), hyst: num(cfg.surge.autoHyst, 0.1),
      strokeS: clamp(num(cfg.surge.xvStrokeS, 6), 0, 60) },
    gauge: { inlet: [true, false], auto: false, sp: num(cfg.gauge.autoSp, 0.9), hyst: num(cfg.gauge.autoHyst, 0.1),
      strokeS: clamp(num(cfg.gauge.xvStrokeS, 6), 0, 60), allowInterrupt: !!cfg.gauge.allowInterrupt },
    // v1.4.0: T-202 inlet XV-202 (shut by default) + auto route; DS-101 bypass line-up (HV-104) + auto-dump
    surge2: { inlet: false, auto: false, sp: num(cfg.surge2.autoSp, 0.8), hyst: num(cfg.surge2.autoHyst, 0.1),
      strokeS: clamp(num(cfg.surge2.xvStrokeS, 6), 0, 60) },
    desander: { bypass: false, auto: false, sp: num(cfg.desander.autoSp, 0.8) } };
  var uv = ctl.surge.inlet, gv = ctl.gauge.inlet;   // live aliases (arrays mutated in place): COMMANDED valve states
  // Divert valve travel: uv / gv are the commands, upos / gpos the actual positions (0 shut … 1 open) moving at
  // 1/strokeS per second. Flow splits follow the positions; a compartment's fill window closes when its valve is
  // fully shut (limit switch), and open-new-before-close-old sequences wait for the new valve's open limit.
  var upos = [1, 1], gpos = [1, 0];
  var Tuk = [80, 80];                           // per-compartment surge liquid temperature (°F); Tu = volume-weighted mean
  var ptrip = { LSHH_GT: false, PUMP_DRYRUN: false }, hhK = [false, false], dryMsg = '';
  // accumulators (base units) + meters
  var cum, ref, oilCycles, waterCycles;
  // instantaneous fluxes (last substep)
  var F = { inG: 0, inO: 0, inW: 0, pcv: 0, pcvCap: 0, psv: 0, blk: 0, blowO: 0, blowW: 0, weirO: 0, weirW: 0, oO: 0, oW: 0, wW: 0, wO: 0,
    bpv: 0, bpvCap: 0, psvU: 0, flash: 0, pumpBpd: 0, po: 0, pw: 0, gvent: 0, drO: [0, 0], drW: [0, 0], qOver: 0, phiC: 0,
    rB: 0, rW1: 0, rU: 0, rG: [0, 0], rUk: [0, 0], poK: [0, 0], pwK: [0, 0], inU: [0, 0], fillG: [0, 0],
    // rig-up routing: separator bypass stream (to the flare), gauge tank inflow (bbl/s at the source), export / burner
    // line (oil STB/s, water bbl/s), LCV-201 ΔP (psi) and command, P-201 / gravity drain total (bbl/s)
    byG: 0, byO: 0, byW: 0, gFill: 0, exO: 0, exW: 0, xdP: 0, xCmd: 0, xsg: 0.85, drTot: 0 };
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
    boEpoch++;
    SGg = mmax(0, I.SGg); API = I.API; SGo = 141.5 / (API + 131.5);
    k10 = 0.0125 * API; sqRatio = msqrt(SGg / mmax(SGo, 0.1));
    bo060 = 0.9759 + 1.2e-4 * mpow(75, 1.2);
    Ppc = 756.8 - 131 * SGg - 3.6 * SGg * SGg; Tpc = 169.2 + 349.5 * SGg - 74 * SGg * SGg;
    Tamb = num(cfg.ambientT, 80);
    Qg = I.Qg; Qo = I.Qo; Qw = I.Qw; SP = I.Psep; bypass = !!I.bypass || !rHeater; bean = I.bean;
    ck2Act = rCk2 && !bypass; rigFlags();          // v1.5.0 (§3.3): CK-102 in line only through the heater
    qgD = Qg * 1e6 / 86400; qoD = Qo / 86400; qwD = Qw / 86400;
    var fc = isPlainObj(flow.choke) ? flow.choke : {};
    chk.regime = (fc.regime === 'Critical' || fc.regime === 'Subcritical' || fc.regime === 'No Flow') ? fc.regime : 'Critical';
    chk.flowLimited = !!fc.flowLimited;
    chk.QmaxMMscfd = num(fc.QmaxMMscfd, 0);
    chk.wJT = num(fc.wJT, 1);
    chk.regimeBase = chk.regime;
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
    for (var i = 0; i < 6; i++) SS.push(segOf(flow.segs[i] || {}, i));
    // v1.5.0 (§5.2): the one place that chooses the steady case (base / ck2 / sepBy / sepBy+ck2); base = the lines above
    var sel = pickSteadyBlock();
    if (sel.kind !== 'base') {
      limFac = (chk.flowLimited && Qg > 0 && chk.QmaxMMscfd >= 0) ? mmin(1, chk.QmaxMMscfd / Qg) : 1;
      qgE = qgD * limFac; qoE = qoD * limFac; qwE = qwD * limFac;
    }
    if (!rHeater && !I.bypass) {                  // heater out of the rig-up (the steady calc had it firing): no temperature rise
      var dTh = Th_ss - Tin_ss;
      Th_ss = Tin_ss; Tsep_ss -= dTh; Tfl_ss -= dTh; duty_ss = 0;
    }
    ck2Derive(sel); bypDerive(sel);                // WP-E1 / WP-E2 derive-time constants (always; cheap, per derive)
    if (cushOn) cushDerive();                      // WP-E2: cushion constants of the new flow (cushS itself is kept)
    // geometry
    var gk = [cfg.sep.D_in, cfg.sep.Lss_ft, cfg.sep.weirFrac, cfg.sep.weirPosFrac, cfg.surge.cap_bbl, cfg.surge.D_ft, cfg.gauge.cap_bbl, cfg.gauge.D_ft, cfg.surge2.cap_bbl, cfg.surge2.D_ft].join('|');
    var geomChanged = gk !== geomKey && geomKey !== '';
    var keep = null;
    if (geomChanged) keep = captureFractions();
    if (gk !== geomKey) {
      D = mmax(0.5, num(cfg.sep.D_in, 36) / 12); R = D / 2; Lss = mmax(1, num(cfg.sep.Lss_ft, 10));
      xW = clamp(num(cfg.sep.weirPosFrac, 0.75), 0.3, 0.95) * Lss; Lb = Lss - xW;
      hWeir = clamp(num(cfg.sep.weirFrac, 0.55), 0.2, 0.9) * D; Lw = 2 * msqrt(hWeir * (D - hWeir));
      lutC1 = makeLUT(vC1, D, 257, dC1); lutB = makeLUT(vB, D, 257, dB);
      Vves = lutC1.Vmax + lutB.Vmax;
      capU = mmax(1, num(cfg.surge.cap_bbl, 100)); capK = capU / 2; Du = mmax(0.5, num(cfg.surge.D_ft, 6)); Atu = PI * Du * Du / 4; Hu = capU * BBL / Atu;
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
    // V-101 out with a flow.sepBy block: its surge set point (0–30, no Psep − 10 bound: V-101 is out; §4.4, §6.2)
    PspU = sel.sepByBlk !== null && isNum(sel.surgeP) ? clamp(sel.surgeP, 0, 30) : clamp(num(cfg.surge.Psp, 25), 0, mmin(30, mmax(0, SP - 10)));
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
    // LCV-201: surge → gauge transfer without a pump. Sized to pass the design rate at the design ΔP = surge set
    // pressure (≥ 10 psig) + liquid head at half level − lift to the gauge tank's top inlet (T-301 is atmospheric):
    //   q = Cv·√(ΔP/SG)  (liqQ), so the flow follows the vessel pressure and stops when it cannot lift the liquid.
    var aoD = qoE * BsD, SGlD = (aoD + qwE) > 1e-15 ? (aoD * SGo + qwE) / (aoD + qwE) : SGo;
    dPxD = mmax(2, mmax(PspU, 10) + WGRAD * SGlD * (0.5 * Hu - Hg));
    Cv_x = pumpDesign / (msqrt(dPxD / mmax(SGlD, 0.1)) * GPM_BPD);
    var Qv = pumpDesign / 86400 * BBL * (PspUa / PSC) * (TSC / TRs) / Zf(PspUa, TRs);
    var qmk1 = gq(1, mmax(SPa, PspUa + 5), PspUa, TRs, Zf(mmax(SPa, PspUa + 5), TRs));
    Cv_mk = qmk1 > 0 ? 2 * Qv / qmk1 : 1;
    var mU = mawpUof(PspU), mUa = mU + PSC;
    var qp1 = gq(1, mUa, P2a, TRs, Zf(mUa, TRs));
    Cv_psvU = qp1 > 0 ? mmax(2 * gq(Cv_o, mmax(SPa, mUa + 1), mUa, TRs, Zf(mmax(SPa, mUa + 1), TRs)), cfg.surge.psvMinMscfd * 1000 / 86400) / qp1 : 1;
    drainBpd = (cfg.gauge.drainBpd != null && +cfg.gauge.drainBpd > 0) ? +cfg.gauge.drainBpd : mmax(3000, 2 * pumpDesign);
    // v1.4.0 steady quantities of the optional items (always derived, whether the item is in or out)
    desDerive(); surge2Derive();
    return keep;
  }
  // one steady segment record from a flow segment (flow.segs[i], or a flow.ck2 / flow.sepBy block segment standing at index i)
  function segOf(s, i) {
    var sm = SEG_META[i];
    return { id: typeof s.id === 'string' ? s.id : sm[0], from: typeof s.from === 'string' ? s.from : sm[1], to: typeof s.to === 'string' ? s.to : sm[2],
      label: typeof s.label === 'string' ? s.label : sm[3], phase: (s.phase === 'gas' || s.phase === 'liquid' || s.phase === 'multi') ? s.phase : (i === 4 ? 'gas' : i === 5 ? 'liquid' : 'multi'),
      nps: String(s.nps != null ? s.nps : ''), sch: String(s.sch != null ? s.sch : ''), ID: mmax(0, num(s.ID, 4.026)), L: mmax(0, num(s.L, 0)),
      vel: mmax(0, num(s.vel, 0)), ve: mmax(0, num(s.ve, 0)), dP: mmax(0, num(s.dP, 0)), ff: mmax(0, num(s.ff, 0.027)), rhom: mmax(0, num(s.rhom, 54.6)) };
  }
  function regimeOf(x) { return (x === 'Critical' || x === 'Subcritical' || x === 'No Flow') ? x : null; }
  function plain(o) { return isPlainObj(o) ? o : {}; }
  // ── v1.5.0 steady-case selection (docs/SIM-FOLLOWUP-PLAN.md §5.2; WP-E0 / lead: the ONLY place that chooses) ──
  //   base       the flow's own fields (the derive lines above, unchanged)
  //   sepBy      V-101 out and a flow.sepBy block: the walk from the destination (P0 published) overrides Pck / Tck / Ph / Th /
  //              Psep (= the seg-5 inlet) / Tin / duty / chk and SS[2..4]; with H-101 out the block's 5 psi heater drop is left
  //              out of the choke outlet (segments not re-solved, §4.2)
  //   ck2        CK-102 in line (ck2Act) and a flow.ck2 block (V-101 in) or flow.sepBy.ck2 (V-101 out): CK-101 outlet, heater,
  //              Tin (= CK-102 outlet), duty, chk (regimeBase keeps the CK-101-only regime) and SS[2..3] from the block
  //   A skipped block (no gas rate) counts as none and leaves its note in SEL.ck2Note. WP-E1 / WP-E2 read SEL (ck2Derive,
  //   bypDerive) and never edit these lines. Phi_ss = the steady CK-102 outlet (base: the CK-101 outlet less the seg-3 loss).
  function pickSteadyBlock() {
    var S = SEL, sb = (!rSep && isPlainObj(flow.sepBy)) ? flow.sepBy : null, cb = null, b, i;
    if (ck2Act) cb = rSep ? flow.ck2 : (sb ? sb.ck2 : null);
    if (!isPlainObj(cb)) cb = null;
    S.ck2Note = '';
    if (cb && cb.skipped === true) { S.ck2Note = typeof cb.note === 'string' && cb.note ? cb.note : 'no gas rate: the two-stage gas walk does not apply'; cb = null; }
    S.sepByBlk = sb; S.ck2blk = cb; S.surgeP = null;
    S.kind = sb ? (cb ? 'sepBy+ck2' : 'sepBy') : (cb ? 'ck2' : 'base');
    var B = plain(cfg.sep.bypass);
    bypF0 = num(B.P_flare_psig, cfg.sep.pcv.P2_psig);
    S.P0 = rSep ? SP : bypF0;
    if (sb) {
      var bc = plain(sb.choke), bn = plain(sb.nodes), bh = plain(sb.heater), nc = plain(bn.choke), nh = plain(bn.heater), ns = plain(bn.sep);
      chk.regime = regimeOf(bc.regime) || chk.regime; chk.flowLimited = !!bc.flowLimited;
      chk.QmaxMMscfd = num(bc.QmaxMMscfd, chk.QmaxMMscfd); chk.wJT = num(bc.wJT, chk.wJT); chk.regimeBase = chk.regime;
      Pck_ss = num(nc.P, num(bc.Pout, Pck_ss)); Tck_ss = num(nc.T, Tck_ss);
      Ph_ss = num(nh.P, Ph_ss); Th_ss = num(nh.T, Th_ss); Psep_ss = num(ns.P, Psep_ss);
      Tin_ss = num(bh.Tin, Tin_ss); duty_ss = mmax(0, num(bh.dutyMMBtuHr, duty_ss));
      if (!rHeater) Pck_ss -= mmax(0, num(bh.dP, 0));
      b = Array.isArray(sb.segs) ? sb.segs : [];
      for (i = 0; i < 3; i++) if (isPlainObj(b[i])) SS[2 + i] = segOf(b[i], 2 + i);
      S.P0 = num(sb.P0_psig, B.dest === 'line' ? num(B.P_psig, 150) : bypF0);
      S.surgeP = simNum(sb.surgeP_psig);
    }
    if (cb) {
      var k1 = plain(cb.ck1), cn = plain(cb.nodes), cnh = plain(cn.heater), cnk = plain(cn.heaterChoke), chh = plain(cb.heater);
      Pck_ss = num(k1.Pout, Pck_ss); Tck_ss = num(k1.Tout, Tck_ss);
      Ph_ss = num(cnh.P, Ph_ss); Th_ss = num(cnh.T, Th_ss);
      Tin_ss = num(cb.Tout, Tin_ss); duty_ss = mmax(0, num(chh.dutyMMBtuHr, duty_ss));
      chk.regime = regimeOf(k1.regime) || chk.regime; chk.QmaxMMscfd = num(cb.QmaxMMscfd, chk.QmaxMMscfd);
      chk.flowLimited = !!cb.flowLimited; chk.wJT = num(k1.wJT, chk.wJT);
      b = Array.isArray(cb.segs) ? cb.segs : [];
      for (i = 0; i < 2; i++) if (isPlainObj(b[i])) SS[2 + i] = segOf(b[i], 2 + i);
      Phi_ss = num(cb.Pout, num(cnk.P, Ph_ss));
    } else Phi_ss = Pck_ss - SS[2].dP;
    return S;
  }
  function mawpUof(x) {
    if (cfg.surge.mawp != null && isNum(+cfg.surge.mawp)) return +cfg.surge.mawp;
    return mmax(50, x + mmax(0.5 * x, 15) + 10);
  }

  // ── algebraic state (levels, pressures) from inventories ──
  function algebraic() {
    X.Tsep = Tamb + (Tsep_ss - Tamb) * X.theta;
    var TR = X.Tsep + RANK;
    X.Bs = BoR(X.PsepA > 0 ? X.PsepA : SP + PSC, X.Tsep);
    var VL1 = X.Vw1 + X.Vo1 * X.Bs, VLB = X.Vw2 + X.Vo2 * X.Bs;
    X.hW1 = lutC1.h(X.Vw1); X.hL1 = lutC1.h(VL1); X.h2 = lutB.h(VLB); X.hW2 = lutB.h(X.Vw2);
    X.Vg = BBL * (Vves - VL1 - VLB);
    var vfloor = 0.02 * Vves * BBL; if (X.Vg < vfloor) X.Vg = vfloor;
    var z = X.Zs > 0 ? X.Zs : 0.95, P = 0;
    for (var it = 0; it < 2; it++) { P = X.n_s * z * TR * PSC / (TSC * X.Vg); z = Zf(mmax(P, 1), TR); }
    P = X.n_s * z * TR * PSC / (TSC * X.Vg);
    if (P < PSC) {                                              // vacuum breaker (air in; tracked)
      var need = PSC * X.Vg * TSC / (z * TR * PSC);
      cum.vacBreak += need - X.n_s; X.n_s = need; P = PSC;
    }
    X.Zs = z; X.PsepA = P; X.Psep = P - PSC;
    // surge
    var TRu = X.Tu + RANK;
    X.Bu = BoR(X.PuA > 0 ? X.PuA : PspU + PSC, X.Tu);
    X.Vou = uo[0] + uo[1]; X.Vwu = uw[0] + uw[1];
    X.VliqU = X.Vou * X.Bu + X.Vwu;
    X.hU = X.VliqU * BBL / Atu;
    X.VgU = mmax(1, (capU - X.VliqU) * BBL);
    var zu = X.Zu > 0 ? X.Zu : 0.99, Pa = X.n_u * zu * TRu * PSC / (TSC * X.VgU);
    zu = Zf(mmax(Pa, 1), TRu); Pa = X.n_u * zu * TRu * PSC / (TSC * X.VgU);
    if (Pa < PSC) { var nd = PSC * X.VgU * TSC / (zu * TRu * PSC); cum.vacBreak += nd - X.n_u; X.n_u = nd; Pa = PSC; }
    X.Zu = zu; X.PuA = Pa; X.Pu = Pa - PSC;
  }
  var boEpoch = 0;                              // memo of the stock-tank Bo per compartment (T and fluid unchanged → reuse)
  function tankBo(k) { var tk = tanks[k]; if (tk.boT !== tk.T || tk.boE !== boEpoch) { tk.bo = BoR(PSC, tk.T); tk.boT = tk.T; tk.boE = boEpoch; } return tk.bo; }
  // surge compartments (each half of the vertical tank's cross-section, capK = capU / 2)
  function compVliq(k) { return uo[k] * X.Bu + uw[k]; }
  function sucSel(k) { var x = ctl.surge.suction; return x === 'both' || (x === 'A' ? k === 0 : k === 1); }
  function suctionV() { return (sucSel(0) ? compVliq(0) : 0) + (sucSel(1) ? compVliq(1) : 0); }
  function suctionCap() { return (ctl.surge.suction === 'both' ? 2 : 1) * capK; }
  function tankVliq(k) { return tanks[k].Vo * tankBo(k) + tanks[k].Vw; }
  // LCV-201 driving pressure (psi): surge tank pressure + liquid head over the outlet − lift to the gauge tank's top
  // inlet (atmospheric; none when T-201 transfers to the export / burner line). XF.sg = SG of the suction liquid.
  var XF = { sg: 0.85 };
  function xferDP() {
    var VW = 0, VO = 0;
    for (var k = 0; k < 2; k++) if (sucSel(k)) { VW += uw[k]; VO += uo[k] * X.Bu; }
    var VS = VW + VO, sg = VS > 1e-9 ? (VW + VO * SGo) / VS : SGo;
    XF.sg = sg;
    return X.Pu + WGRAD * sg * (VS / suctionCap() * Hu - (rGauge ? Hg : 0));
  }

  function captureFractions() {
    if (!lutC1) return null;
    var k = { fW1: X.hW1 / D, fL1: X.hL1 / D, f2: X.h2 / D, fW2: X.hW2 / D, P: X.PsepA, PuA: X.PuA, u: [], g: [] };
    for (var j = 0; j < 2; j++) { var vu = compVliq(j); k.u.push({ f: vu / capK, w: vu > 1e-12 ? uw[j] / vu : 0 }); }
    for (var i = 0; i < 2; i++) { var vl = tankVliq(i); k.g.push({ f: vl / capG, w: vl > 1e-12 ? tanks[i].Vw / vl : 0 }); }
    var v2 = uo2 * X2.Bu + uw2;                      // T-202 (WP-E2): its fraction, water cut and pressure at the old geometry
    k.u2 = { f: v2 / cap2, w: v2 > 1e-12 ? uw2 / v2 : 0, PuA: X2.PuA, cap: cap2, D: D2 };
    return k;
  }
  function applyFractions(k) {
    if (!k) return;
    X.Vw1 = lutC1.V(k.fW1 * D); X.Vo1 = mmax(0, lutC1.V(k.fL1 * D) - X.Vw1) / X.Bs;
    X.Vw2 = lutB.V(k.fW2 * D); X.Vo2 = mmax(0, lutB.V(k.f2 * D) - X.Vw2) / X.Bs;
    var TR = X.Tsep + RANK, VL = X.Vw1 + X.Vo1 * X.Bs + X.Vw2 + X.Vo2 * X.Bs;
    var vg = mmax(0.02 * Vves * BBL, BBL * (Vves - VL));
    X.n_s = k.P * vg * TSC / (Zf(k.P, TR) * TR * PSC);
    var VlU = 0;
    for (var j = 0; j < 2; j++) { var vk = k.u[j].f * capK; uw[j] = vk * k.u[j].w; uo[j] = vk * (1 - k.u[j].w) / X.Bu; VlU += vk; }
    var TRu = X.Tu + RANK, vgu = mmax(1, (capU - VlU) * BBL);
    X.n_u = k.PuA * vgu * TSC / (Zf(k.PuA, TRu) * TRu * PSC);
    for (var i = 0; i < 2; i++) { var vl = k.g[i].f * capG; tanks[i].Vw = vl * k.g[i].w; tanks[i].Vo = vl * (1 - k.g[i].w) / tankBo(i); }
    if (k.u2 && (k.u2.cap !== cap2 || k.u2.D !== D2)) {   // T-202 (WP-E2) resized: same fraction, water cut and pressure
      var v2 = k.u2.f * cap2, TR2 = X2.Tu + RANK, vg2 = mmax(1, (cap2 - v2) * BBL);
      uw2 = v2 * k.u2.w; uo2 = v2 * (1 - k.u2.w) / X2.Bu;
      X2.n_u = k.u2.PuA * vg2 * TSC / (Zf(k.u2.PuA, TR2) * TR2 * PSC);
      algebraic2(false);
    }
  }

  // ── inventories & mass-balance reference ──
  // T-202's inventory is always included (surge2Inv; exactly 0 while T-202 has never held anything, so the sums are the
  // v1.3.0 ones bit for bit): the balances hold for every rig-up and every switch
  function invOil() { return X.Vo1 + X.Vo2 + X.Vou + tanks[0].Vo + tanks[1].Vo + surge2Inv('oil'); }
  function invWater() { return X.Vw1 + X.Vw2 + X.Vwu + tanks[0].Vw + tanks[1].Vw + surge2Inv('water'); }
  function invGas() { return X.n_s + X.n_u + surge2Inv('gas'); }
  function setRef() {
    ref = { oil: invOil(), water: invWater(), gas: invGas(), oilIn: cum.oilIn, waterIn: cum.waterIn, gasIn: cum.gasIn, flash: cum.flash,
      gaugeFlash: cum.gaugeFlash, vacBreak: cum.vacBreak, flare: cum.flare, gaugeVent: cum.gaugeVent,
      drainedOil: cum.drainedOil, drainedWater: cum.drainedWater, ltfOil: cum.ltfOil, ltfWater: cum.ltfWater, spillOil: cum.spillOil, spillWater: cum.spillWater,
      lineGas: cum.lineGas, lineOil: cum.lineOil, lineWater: cum.lineWater, vent: cum.vent };
    desBalance('ref', ref); surge2Inv('ref', ref); cushBalance('ref', ref);
  }
  function zeroCum() {
    cum = { oilIn: 0, waterIn: 0, gasIn: 0, flare: 0, flash: 0, gaugeFlash: 0, gaugeVent: 0, vacBreak: 0, gaugeOil: 0, gaugeWater: 0,
      drainedOil: 0, drainedWater: 0, ltfOil: 0, ltfWater: 0, spillOil: 0, spillWater: 0, sepGas: 0,
      gaugeOilT: [0, 0], gaugeWaterT: [0, 0], sepGasT: [0, 0],           // per-compartment fill + gas share (batch windows)
      // v1.5.0 sinks (§6.2): the production line (V-101 out, dest 'line') and the vent (V-101 + FS-401 out); exactly 0 otherwise
      lineGas: 0, lineOil: 0, lineWater: 0, vent: 0 };
    desBalance('zero', cum); surge2Inv('zero', cum); cushBalance('zero', cum);
  }
  // v1.5.0: the line / vent sinks join the balances (each term is exactly 0 while unused, so the v1.4.0 sums are unchanged)
  function massErr(out) {
    var dO = cum.oilIn - ref.oilIn, dW = cum.waterIn - ref.waterIn;
    var rO = dO - ((invOil() - ref.oil) + (cum.drainedOil - ref.drainedOil) + (cum.ltfOil - ref.ltfOil) + (cum.spillOil - ref.spillOil) + (cum.lineOil - ref.lineOil));
    var rW = dW - ((invWater() - ref.water) + (cum.drainedWater - ref.drainedWater) + (cum.ltfWater - ref.ltfWater) + (cum.spillWater - ref.spillWater) + (cum.lineWater - ref.lineWater));
    var src = (cum.gasIn - ref.gasIn) + (cum.flash - ref.flash) + (cum.gaugeFlash - ref.gaugeFlash) + (cum.vacBreak - ref.vacBreak);
    var rG = src - ((cum.flare - ref.flare) + (cum.gaugeVent - ref.gaugeVent) + (invGas() - ref.gas) + (cum.lineGas - ref.lineGas) + (cum.vent - ref.vent));
    out.oil = rO / mmax(mabs(dO), 1); out.water = rW / mmax(mabs(dW), 1); out.gas = rG / mmax(mabs(src), 1);
    out.sand = desBalance('err', null);
    return out;
  }

  // ── initialisation ──
  function newTank(k) {
    return { tag: k === 0 ? TAGS.gaugeA : TAGS.gaugeB, Vo: 0, Vw: 0, T: Tamb, state: 'ready', since: 0,
      win: null, drO: 0, drW: 0 };
  }
  function openWindow(k) {
    var tk = tanks[k];
    tk.win = { tOpen: X.t, openOil: tk.Vo, cumOil0: cum.gaugeOilT[k], cumWater0: cum.gaugeWaterT[k], gas0: cum.sepGasT[k], Tint: 0, tInt: 0 };
  }
  function initState(m) {
    mode = m === 'empty' ? 'empty' : 'steady';
    X.t = 0; zeroCum();
    X.xiG = 0; X.xiL = 0; X.xiW = 0; spare = null;
    lcvO = { cmd: 0, x: 0, I: 0 }; lcvW = { cmd: 0, x: 0, I: 0 };
    psvLift = false; psvULift = false; pumpTrip = false;
    ptrip.LSHH_GT = false; ptrip.PUMP_DRYRUN = false; hhK[0] = hhK[1] = false; dryMsg = ''; X.lastDraw = 0; X.lastQp = 0;
    X.Zs = 0; X.Zu = 0;
    tanks = [newTank(0), newTank(1)]; active = 0; batches = []; batchN = 0;
    oilCycles = 0; waterCycles = 0;
    X.SPe = SP; X.SPeu = PspU;
    X.graceUntil = cfg.startupGrace;
    var TR, Pa;
    if (mode === 'steady') {
      X.qBg = qgE; X.qBo = qoE; X.qBw = qwE;
      X.esdTravel = 1; X.theta = 1; X.Pwh = Pwh_ss; X.PB = Pci_ss; X.tFlow = 0; X.tShut = 0; X.P0shut = Pwh_ss; shut = false;
      X.f = qgD > 0 ? qgE / qgD : ((qoD + qwD) > 0 ? (qoE + qwE) / (qoD + qwD) : 0); X.fInst = X.f;
      X.Tsep = Tsep_ss; TR = X.Tsep + RANK; Pa = SP + PSC; X.PsepA = Pa;
      X.Bs = BoR(Pa, X.Tsep);
      var crest = qoE * X.Bs > 0 ? mpow(qoE * X.Bs * BBL / (3.33 * Lw), 2 / 3) : 0;
      X.Vw1 = lutC1.V(0.25 * D);
      X.Vo1 = mmax(0, lutC1.V(mmin(hWeir + crest, 0.95 * D)) - X.Vw1) / X.Bs;
      X.Vw2 = 0; X.Vo2 = lutB.V(0.325 * D) / X.Bs;
      var vg = BBL * (Vves - X.Vw1 - X.Vo1 * X.Bs - X.Vo2 * X.Bs);
      X.n_s = Pa * vg * TSC / (Zf(Pa, TR) * TR * PSC);
      X.Ipcv = 0; X.upcv = 0.5;
      // surge at 0.55, pump running (mid-drawdown), at its setpoint
      X.Tu = X.Tsep; var PuA0 = PspU + PSC; X.PuA = PuA0; X.Bu = BoR(PuA0, X.Tu);
      var ao = qoE * X.Bu, aw = qwE, ro = (ao + aw) > 1e-15 ? ao / (ao + aw) : 0.8;
      var VlU = 0.55 * capU;
      for (var j = 0; j < 2; j++) { uo[j] = 0.55 * capK * ro / X.Bu; uw[j] = 0.55 * capK * (1 - ro); }
      X.n_u = PuA0 * mmax(1, (capU - VlU) * BBL) * TSC / (Zf(PuA0, X.Tu + RANK) * (X.Tu + RANK) * PSC);
      pumpOn = true;
      // gauge A filling at 30 % (0.8/0.2 oil/water), B ready and empty
      tanks[0].T = X.Tsep; tanks[1].T = X.Tsep;
      var VlA = 0.30 * capG; tanks[0].Vw = 0.2 * VlA; tanks[0].Vo = 0.8 * VlA / tankBo(0);
      X.emaOil = qoE; X.emaWater = qwE; X.emaGas = qgE; X.emaFlash = qFlashD;
    } else {
      X.qBg = 0; X.qBo = 0; X.qBw = 0; X.f = 0; X.fInst = 0;
      X.esdTravel = 1; X.theta = 0; X.Pwh = Pwh_ss; X.PB = 0; X.tFlow = 0; X.tShut = 0; X.P0shut = Pwh_ss; shut = false;
      X.Tsep = Tamb; TR = X.Tsep + RANK; X.PsepA = PSC;
      X.Vw1 = 0; X.Vo1 = 0; X.Vw2 = 0; X.Vo2 = 0;
      X.n_s = PSC * Vves * BBL * TSC / (Zf(PSC, TR) * TR * PSC);
      X.Ipcv = 0; X.upcv = 0;
      X.Tu = Tamb; X.PuA = PSC; uo[0] = uo[1] = 0; uw[0] = uw[1] = 0;
      X.n_u = PSC * capU * BBL * TSC / (Zf(PSC, X.Tu + RANK) * (X.Tu + RANK) * PSC);
      pumpOn = false;
      X.emaOil = 0; X.emaWater = 0; X.emaGas = 0; X.emaFlash = 0;
    }
    Tuk[0] = Tuk[1] = X.Tu; X.Tpump = X.Tu;
    tanks[0].state = 'filling'; tanks[0].since = 0; tanks[1].state = 'ready'; tanks[1].since = 0;
    openWindow(0);
    initGaugeLineup();
    for (var v = 0; v < 2; v++) { upos[v] = uv[v] ? 1 : 0; gpos[v] = gv[v] ? 1 : 0; }   // t = 0: valves at their commanded positions
    pumpBlocked = rGauge && !gv[0] && !gv[1];
    esdS.tripped = false; esdS.manual = false; esdS.cause = null; esdS.causeMsg = ''; esdS.tripT = null;
    AL = {}; alarmOrder = []; alarmLog = [];
    for (var k in F) if (typeof F[k] === 'number') F[k] = 0;
    F.drO = [0, 0]; F.drW = [0, 0]; F.rG = [0, 0];
    desInit(); surge2Init();                     // v1.4.0 optional items: t = 0 state (kept whether in or out)
    fuInit();                                    // v1.5.0: CK-102 ΔP lag at its t = 0 value; reset stops a cushion (§3.3, §6.3)
    algebraic();
    limits(0);
    // PI preloads
    X.Ibpv = 0; X.ubpv = 0; X.ublk = 0;
    if (mode === 'steady') {
      var cap = gq(Cv_bpv, X.PuA, PSC + mmin(cfg.sep.pcv.P2_psig, 0.4 * X.SPeu), X.Tu + RANK, X.Zu);
      X.ubpv = cap > 0 ? clamp(qFlashD / cap, 0, 1) : 0;
      var kc = bpvKc();
      X.Ibpv = kc > 0 ? ((X.ubpv - bpvBias()) / kc) * cfg.surge.bpv.Ti : 0;
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
    var TR = X.Tsep + RANK, P2a = PSC + cfg.sep.pcv.P2_psig;
    X.fE = clamp(X.esdTravel / 0.25, 0, 1); X.mg = 1; X.ml = 1;
    var sIn = rSep ? 1 : 0;
    F.inG = X.qBg * X.fE * sIn; F.inO = X.qBo * X.fE * sIn; F.inW = X.qBw * X.fE * sIn;
    F.byG = X.qBg * X.fE * (1 - sIn); F.byO = X.qBo * X.fE * (1 - sIn); F.byW = X.qBw * X.fE * (1 - sIn);
    F.pcvCap = gq(Cv_pcv, X.PsepA, P2a, TR, X.Zs); F.pcv = rSep ? X.upcv * F.pcvCap : 0;
    F.bpvCap = gq(Cv_bpv, X.PuA, X.P2aU, X.Tu + RANK, X.Zu); F.bpv = rSurge ? X.ubpv * F.bpvCap : 0;
    var Hw = X.hL1 - mmax(hWeir, X.h2);
    F.qOver = Hw > 0 ? 3.33 * Lw * mpow(Hw, 1.5) / BBL : 0; F.weirO = F.qOver / X.Bs; F.weirW = 0;
    var xOn = rSurge && pumpOn && !pumpLatched() && !pumpBlocked && !faults.xferStuckClosed;
    F.xCmd = xOn ? 1 : 0; F.xdP = xferDP(); F.xsg = XF.sg;
    F.pumpBpd = xOn ? liqQ(Cv_x, F.xdP, XF.sg) * 86400 : 0;
    var Qp = F.pumpBpd / 86400, VS = suctionV(), k;
    F.pw = 0; F.po = 0;
    for (k = 0; k < 2; k++) {
      F.pwK[k] = 0; F.poK[k] = 0;
      if (Qp > 0 && VS > 1e-9 && sucSel(k)) { F.pwK[k] = Qp * uw[k] / VS; F.poK[k] = Qp * (uo[k] * X.Bu / VS) / X.Bu; }
      F.pw += F.pwK[k]; F.po += F.poK[k];
      F.rUk[k] = -(F.poK[k] * X.Bu + F.pwK[k]);
    }
    F.gvent = F.po * RsE(X.PuA, X.Tu);
    var nG = gpos[0] + gpos[1];
    F.rB = F.qOver; F.rW1 = F.inW; F.rU = -Qp;
    F.gFill = rGauge ? F.po * X.Bu + F.pw : 0; F.exO = rGauge ? 0 : F.po; F.exW = rGauge ? 0 : F.pw; F.drTot = 0;
    for (k = 0; k < 2; k++) { F.fillG[k] = nG > 0 ? gpos[k] / nG : 0; F.rG[k] = F.gFill * F.fillG[k]; F.inU[k] = 0; }
  }

  // ── controllers helpers ──
  function pcvKc() {
    var TR = X.Tsep + RANK, SPa = X.SPe + PSC, P2a = PSC + cfg.sep.pcv.P2_psig, P1 = mmax(X.PsepA, SPa);
    var Kp = X.Zs * TR * PSC / (TSC * X.Vg) * gq(Cv_pcv, P1, P2a, TR, Zf(P1, TR));
    var Pspan = mmax(X.SPe, 50);
    return Kp > 1e-12 ? Pspan / (Kp * tauClSep()) : 0;
  }
  // closed-loop time of PCV-101: cfg tauCl, but never slower than 1.5× the vessel's gas residence time
  // (a small separator at high throughput would otherwise swing tens of psi on gas-rate noise)
  function tauClSep() {
    var tg = X.n_s / mmax(X.qBg * clamp(X.esdTravel / 0.25, 0, 1), F.pcvCap * 0.5, 1e-9);
    return mmax(0.5, mmin(cfg.sep.pcv.tauCl, 1.5 * tg));
  }
  function bpvKc() {
    var TRu = X.Tu + RANK, SPa = X.SPeu + PSC, P2 = PSC + mmin(cfg.sep.pcv.P2_psig, 0.4 * X.SPeu), P1 = mmax(X.PuA, SPa);
    var Kp = X.Zu * TRu * PSC / (TSC * X.VgU) * gq(Cv_bpv, P1, P2, TRu, Zf(P1, TRu));
    var Pspan = mmax(X.SPeu, 20);
    return Kp > 1e-12 ? Pspan / (Kp * cfg.surge.bpv.tauCl) : 0;
  }
  // Feed-forward bias of the pressure PIs (= designOpen 0.5 at design inflow and SP). The vent that holds P is
  // gas inflow + gas displaced by the net liquid inflow − gas stored to follow the SP_eff ramp:
  //   vent = q_in + (n/Vg)·5.614583·dV_liq/dt − (n/Pa)·dSP_eff/dt        (last-substep fluxes; blanket excluded)
  // so SP ramps and dump pulses track without integral wind-up; the PI trims noise and model error.
  
  function pcvBias() {
    var TR = X.Tsep + RANK, P1 = mmax(X.PsepA, X.SPe + PSC);
    var cap = gq(Cv_pcv, P1, PSC + cfg.sep.pcv.P2_psig, TR, Zf(P1, TR));
    if (!(cap > 0)) return 0;
    var dVl = (F.inO * X.Bs + F.inW) - (F.oO * X.Bs + F.oW + F.wW + F.wO * X.Bs);
    return clamp((X.qBg * clamp(X.esdTravel / 0.25, 0, 1) + X.n_s / mmax(X.Vg, 1e-6) * BBL * dVl - X.n_s / mmax(X.PsepA, 1) * X.dSPe) / cap, 0, 1);
  }
  function bpvBias() {
    var TRu = X.Tu + RANK, P1 = mmax(X.PuA, X.SPeu + PSC);
    var cap = gq(Cv_bpv, P1, X.P2aU, TRu, Zf(P1, TRu));
    if (!(cap > 0)) return 0;
    var dVl = (F.oO + F.wO) * X.Bs + F.oW + F.wW - (F.po * X.Bu + F.pw);
    return clamp((F.flash + F.blowO + F.blowW + X.n_u / mmax(X.VgU, 1e-6) * BBL * dVl - X.n_u / mmax(X.PuA, 1) * X.dSPeu) / cap, 0, 1);
  }
  function limits(h) {
    var r = cfg.ramp, s0 = X.SPe, s0u = X.SPeu;
    X.SPe += clamp(SP - X.SPe, -r.spRate * h, r.spRate * h);
    X.dSPe = h > 0 ? (X.SPe - s0) / h : 0;
    var S = cfg.sep;
    X.psh = S.psh != null ? +S.psh : X.SPe + mmax(0.10 * X.SPe, 15);
    X.pshh = S.pshh != null ? +S.pshh : X.SPe + mmax(0.20 * X.SPe, 25);
    X.psl = S.psl != null ? +S.psl : X.SPe - mmax(0.20 * X.SPe, 20);
    var SPhi = mmax(SP, X.SPe);
    X.mawpE = mmax(num(S.mawp, 1440), 1.25 * (SPhi + mmax(0.20 * SPhi, 25)));
    X.SPeu += clamp(PspU - X.SPeu, -r.surgeSpRate * h, r.surgeSpRate * h);
    X.dSPeu = h > 0 ? (X.SPeu - s0u) / h : 0;
    var U = cfg.surge;
    X.pshU = U.psh != null ? +U.psh : X.SPeu + mmax(0.25 * X.SPeu, 7);
    X.pshhU = U.pshh != null ? +U.pshh : X.SPeu + mmax(0.50 * X.SPeu, 15);
    X.mawpU = mawpUof(mmax(PspU, X.SPeu));
    X.P2aU = PSC + mmin(cfg.sep.pcv.P2_psig, 0.4 * X.SPeu);
    if (rSurge2) surge2Limits(h);                // T-202 SP ramp + limits (WP-E2)
  }
  // pressure downstream of the heater: the separator, or (V-101 bypassed) the destination. v1.5.0 (D3, §6.2): with a flow.sepBy
  // block the destination P0 and the whole-stream seg-5 loss of the block (WP-E2 bypPDown); without it (old flow, SAMPLE_FLOW)
  // the legacy law on the burner / flare line inlet bypF0 (= the PCV outlet setting by default, so v1.4.0 exactly)
  function pDown() {
    if (rSep) return X.Psep;
    var fg = qgE > 0 ? clamp(F.byG / qgE, 0, 2) : 0;
    if (SEL.sepByBlk !== null) return bypPDown(fg);
    return bypF0 + SS[4].dP * fg * fg;
  }
  // CK-101 outlet pressure, live (refresh N.choke.P and history Pchoke share it). D11 / §5.3: while CK-102 is in line or its ΔP
  // lag X.ck2dP is still decaying, the CK-102 law of WP-E1 (ck2Pck: CK-102 inlet Pm + the seg-3 loss); otherwise today's law
  // bit for bit. fi2 = fInst² (refresh) — the history passes its own product so its v1.4.0 arithmetic is kept (histSample).
  function pckLive(Pdn, fi2) {
    if (CK2.act || X.ck2dP !== 0) return ck2Pck(Pdn, fi2);
    return Pdn + (Pck_ss - Psep_ss) * fi2;
  }
  function bumpless(cvP, cvB) {                // after re-sizing: keep the valve FLOW (u·Cv) continuous, then back-solve I
    if (cvP > 0 && Cv_pcv > 0) X.upcv = clamp(X.upcv * cvP / Cv_pcv, 0, 1);
    if (cvB > 0 && Cv_bpv > 0) X.ubpv = clamp(X.ubpv * cvB / Cv_bpv, 0, 1);
    var kc = pcvKc(), e = (X.Psep - X.SPe) / mmax(X.SPe, 50);
    if (kc > 0) X.Ipcv = ((X.upcv - pcvBias()) / kc - e) * cfg.sep.pcv.Ti;
    var kcu = bpvKc(), eu = (X.Pu - X.SPeu) / mmax(X.SPeu, 20);
    if (kcu > 0) X.Ibpv = ((X.ubpv - bpvBias()) / kcu - eu) * cfg.surge.bpv.Ti;
  }

  // ── gauge tank state machine helpers ──
  // Inlet divert valves XV-301A/B drive the batch cycle: commanding a compartment's inlet open starts a fill window
  // (a settling compartment first records its batch as unsettled; a draining one stops draining); a filling
  // compartment whose inlet is commanded shut keeps filling while its valve travels and closes its window (and
  // starts settling) when the valve reaches its closed limit — see valveEnds(). 'active' is the primary filling side.
  function gaugeOpen(k) {
    if (gv[k]) return false;
    gv[k] = true; hold.gauge[k] = false;
    var tk = tanks[k];
    if (tk.state === 'settling') recordBatch(k, true);
    if (tk.state !== 'filling') { tk.state = 'filling'; tk.since = X.t; openWindow(k); }
    if (!gv[active]) active = k;
    return true;
  }
  function gaugeClose(k) {
    if (!gv[k]) return false;
    gv[k] = false;
    armClose('gauge', k);
    if (active === k && gv[1 - k]) active = 1 - k;
    return true;
  }
  // ── divert valve travel + open-new-before-close-old interlock ──
  // A valve commanded shut while the other compartment's valve is commanded open but not yet fully open is held
  // open (no dead-heading of P-201 / no blocked separator dumps during a changeover); the hold releases at the
  // other valve's open limit. Positions move at 1/strokeS per second; strokeS = 0 → instantaneous.
  var hold = { surge: [false, false], gauge: [false, false] };
  function cmdArr(eq) { return eq === 'surge' ? uv : gv; }
  function posArr(eq) { return eq === 'surge' ? upos : gpos; }
  function vTarget(eq, k) { return (cmdArr(eq)[k] || hold[eq][k]) ? 1 : 0; }
  function armClose(eq, k) {
    var c = cmdArr(eq), p = posArr(eq);
    hold[eq][k] = !!c[1 - k] && p[1 - k] < 1 && p[k] > 0;
    if (rSurge2 && eq === 'surge' && !hold[eq][k]) hold[eq][k] = surge2HoldU(k);   // last T-201 inlet while XV-202 opens (WP-E2)
    snapValves();
  }
  function moving(eq, k) { return posArr(eq)[k] !== vTarget(eq, k) || hold[eq][k]; }
  // hot-path guard: any divert valve travelling / held, or a shut gauge compartment still marked filling
  function valveAct() {
    var hs = hold.surge, hg = hold.gauge;
    return upos[0] !== ((uv[0] || hs[0]) ? 1 : 0) || upos[1] !== ((uv[1] || hs[1]) ? 1 : 0) ||
      gpos[0] !== ((gv[0] || hg[0]) ? 1 : 0) || gpos[1] !== ((gv[1] || hg[1]) ? 1 : 0) || hs[0] || hs[1] || hg[0] || hg[1] ||
      (!gv[0] && tanks[0].state === 'filling') || (!gv[1] && tanks[1].state === 'filling');
  }
  // stroke 0: valves jump to their targets at once (hold releases cascade in the same instant)
  function snapValves() {
    for (var pass = 0; pass < 3; pass++) {
      if (ctl.surge.strokeS <= 0) { upos[0] = vTarget('surge', 0); upos[1] = vTarget('surge', 1); }
      if (ctl.gauge.strokeS <= 0) { gpos[0] = vTarget('gauge', 0); gpos[1] = vTarget('gauge', 1); }
      valveEnds();
    }
  }
  // limit-switch logic: release holds at the other valve's open limit; a gauge compartment commanded shut stops
  // filling (window closes, settling starts) at its closed limit
  function valveEnds() {
    if (!valveAct()) { pumpBlocked = rGauge && !gv[0] && !gv[1] && gpos[0] <= 0 && gpos[1] <= 0; return; }
    var k, eq, c, p, hd, tg;
    for (var e = 0; e < 2; e++) {
      eq = e ? 'gauge' : 'surge'; c = cmdArr(eq); p = posArr(eq); hd = hold[eq];
      for (k = 0; k < 2; k++) { tg = vTarget(eq, k); if (p[k] !== tg && mabs(p[k] - tg) < 1e-9) p[k] = tg; }   // round-off at the limit switch
      for (k = 0; k < 2; k++) if (hd[k] && (!c[1 - k] || p[1 - k] >= 1 || c[k]) && !(rSurge2 && e === 0 && surge2HoldU(k))) hd[k] = false;
    }
    for (k = 0; k < 2; k++) {
      var tk = tanks[k];
      if (!gv[k] && !hold.gauge[k] && gpos[k] <= 0 && tk.state === 'filling') { closeWindow(k); tk.state = 'settling'; tk.since = X.t; }
    }
    pumpBlocked = rGauge && gpos[0] <= 0 && gpos[1] <= 0 && !gv[0] && !gv[1];
  }
  // t = 0 (create / reset): put the initial fill in the lineup's open compartment(s) with no batch side effects
  function initGaugeLineup() {
    var a = !!gv[0], b = !!gv[1];
    active = 0;
    if (a && b) { tanks[1].state = 'filling'; openWindow(1); }
    else if (!a && b) {
      tanks[1].Vo = tanks[0].Vo; tanks[1].Vw = tanks[0].Vw; tanks[1].T = tanks[0].T; tanks[0].Vo = 0; tanks[0].Vw = 0;
      tanks[0].state = 'ready'; tanks[0].win = null; tanks[1].state = 'filling'; openWindow(1); active = 1;
    } else if (!a && !b) { tanks[0].win = null; tanks[0].pend = null; tanks[0].state = 'settling'; }   // no fill window at t = 0 → no (empty, zero-length) batch record
    hold.surge[0] = hold.surge[1] = hold.gauge[0] = hold.gauge[1] = false;
  }
  function doSwitch(forced) {
    var a = active, b = 1 - a;
    gaugeOpen(b);                                // open the new side; the old one is held open until the new one is fully open
    gaugeClose(a);
    active = b;
    var tag = tanks[b].tag;
    emit('switch', { type: 'switch', t: X.t, from: a, to: b, tag: tag, forced: !!forced });
    logEntry('switch', 'SWITCH', null, tag, 'Gauge tank switched to ' + tag + (forced ? ' (manual)' : ''));
    noteControl('gauge', 'inlet', !forced, 'Gauge tank switched to ' + tag);
  }
  // ── auto-divert (overfill protection, per tank, off by default) ──
  // A filling compartment at or above its set point diverts to the other compartment when that one has room
  // (below set point − hysteresis): open the new inlet, then close the old one. With no room anywhere nothing
  // switches (LAH-201 / LAH-301 alarm instead) — the hysteresis band stops back-and-forth switching.
  // Gauge tank: a compartment that is settling or draining holds a batch in progress and is not available unless
  // the operator allows interrupting batches (a tank batch must stand undisturbed until it has settled and been
  // gauged — API MPMS Ch. 18.1 / Ch. 3.1A); with nothing available the filling side rises to LAH-301 and P-201
  // trips at LSHH-301.
  function sideTag(eq, k) { return eq === 'surge' ? (k ? TAGS.surgeB : TAGS.surgeA) : (k ? TAGS.gaugeB : TAGS.gaugeA); }
  function valveTag(eq, k) { return eq === 'surge' ? (k ? TAGS.xvSurgeB : TAGS.xvSurgeA) : (k ? TAGS.xvGaugeB : TAGS.xvGaugeA); }
  function letter(k) { return k ? 'B' : 'A'; }
  function noteControl(eq, what, isAuto, msg) {
    emit('control', { type: 'control', t: X.t, eq: eq, what: what, auto: !!isAuto, msg: msg });
  }
  // can gauge compartment o take the P-201 discharge now? (inlet already open, or ready, or batches may be interrupted)
  function gaugeAvail(o) {
    if (hhK[o] || tankVliq(o) >= cfg.gauge.lahh * capG) return false;
    var s = tanks[o].state;
    return !!gv[o] || s === 'ready' || s === 'filling' || !!ctl.gauge.allowInterrupt;
  }
  function autoDivert() {
    var C = ctl.surge, k, o, msg;
    if (C.auto && rSurge && !hold.surge[0] && !hold.surge[1]) {
      for (k = 0; k < 2; k++) {
        o = 1 - k;
        if (!uv[k] || compVliq(k) < C.sp * capK - 1e-9) continue;
        if (!(compVliq(o) < (C.sp - C.hyst) * capK)) continue;
        uv[o] = true; hold.surge[o] = false; uv[k] = false; armClose('surge', k);
        var sucMoved = C.suction === letter(o);
        if (sucMoved) C.suction = letter(k);             // pump the full compartment down while the other fills
        msg = TAGS.surge + ' auto-divert: ' + sideTag('surge', k) + ' at ' + rnd0(compVliq(k) / capK * 100) + '% → inlet to ' + sideTag('surge', o) +
          ' (' + valveTag('surge', o) + ' open, ' + valveTag('surge', k) + ' closed)' + (sucMoved ? ' · ' + TAGS.xfer + ' suction → ' + sideTag('surge', k) : '');
        logEntry('switch', 'AUTO_DIVERT', null, TAGS.surge, msg);
        emit('divert', { type: 'divert', t: X.t, eq: 'surge', from: k, to: o, auto: true, tag: sideTag('surge', o), msg: msg });
        noteControl('surge', 'inlet', true, msg);
        break;
      }
    }
    var Cg = ctl.gauge;
    if (Cg.auto && rGauge && !hold.gauge[0] && !hold.gauge[1]) {
      for (k = 0; k < 2; k++) {
        o = 1 - k;
        if (!gv[k] || tankVliq(k) < Cg.sp * capG - 1e-9) continue;
        if (!(tankVliq(o) < (Cg.sp - Cg.hyst) * capG) || !gaugeAvail(o)) continue;
        var was = tanks[o].state;
        gaugeOpen(o); gaugeClose(k); active = o;
        msg = TAGS.gauge + ' auto-divert: ' + sideTag('gauge', k) + ' at ' + rnd0(tankVliq(k) / capG * 100) + '% → inlet to ' + sideTag('gauge', o) +
          ' (' + valveTag('gauge', o) + ' open, ' + valveTag('gauge', k) + ' closed)' + (was === 'settling' || was === 'draining' ? ' — ' + was + ' batch interrupted (allowed)' : '');
        logEntry('switch', 'AUTO_DIVERT', null, TAGS.gauge, msg);
        emit('divert', { type: 'divert', t: X.t, eq: 'gauge', from: k, to: o, auto: true, tag: sideTag('gauge', o), msg: msg });
        noteControl('gauge', 'inlet', true, msg);
        break;
      }
    }
  }
  function closeWindow(k) {
    var tk = tanks[k], w = tk.win; if (!w) return;
    w.tClose = X.t; w.closeOil = tk.Vo; w.oil = cum.gaugeOilT[k] - w.cumOil0; w.water = cum.gaugeWaterT[k] - w.cumWater0;
    w.gas = cum.sepGasT[k] - w.gas0; w.avgT = w.tInt > 0 ? w.Tint / w.tInt : tk.T; w.Tclose = tk.T;
    tk.pend = w; tk.win = null;
  }
  function recordBatch(k, unsettled) {
    var tk = tanks[k], w = tk.pend; if (!w) return;
    tk.pend = null;
    var hours = mmax(1e-6, (w.tClose - w.tOpen) / 3600);
    var oil = w.oil, water = w.water, gasM = w.gas / 1000;
    var gov = oil * BoR(PSC, w.avgT) + water;
    batchN++;
    var b = { n: batchN, tag: tk.tag, tOpen: w.tOpen, tClose: w.tClose, hours: hours, openOil_stb: w.openOil, closeOil_stb: w.closeOil,
      oil_stb: oil, water_bbl: water, gov_bbl: gov, bsw_pct: oil < 1e-6 ? null : water / (oil + water) * 100,
      oilRate_stbd: oil / (hours / 24), waterRate_bpd: water / (hours / 24), gas_mscf: gasM,
      gor_scf_stb: oil < 1e-6 ? null : gasM * 1000 / oil, avgT: w.avgT, settled: !unsettled };
    batches.push(b); if (batches.length > 20) batches.shift();
    var p = { type: 'batch', t: X.t }; for (var kk in b) p[kk] = b[kk];
    emit('batch', p);
    logEntry('batch', 'BATCH', null, tk.tag, 'Batch ' + b.n + ' ' + tk.tag + ': ' + b.oil_stb.toFixed(1) + ' STB · ' + b.oilRate_stbd.toFixed(0) + ' STB/d' +
      (unsettled ? ' (unsettled — inlet reopened)' : ''));
  }

  // ── events & log ──
  function emit(name, payload) { evq.push(name, payload); }
  function logEntry(type, id, sev, tag, msg) {
    alarmLog.push({ t: X.t, id: id, type: type, sev: sev === undefined ? null : sev, tag: tag || '', msg: msg || '' });
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
    A.active = true; A.since = X.t; A.value = isNum(value) ? value : null; A.limit = isNum(limit) ? limit : null; A.msg = msg; A.offT = -1;
    emit('alarm', alarmPayload('alarm', A));
    logEntry('raise', A.id, A.sev, A.tag, msg);
    // trip actions — a high-high on a vessel stops what fills it:
    //   LSHH-301 (gauge tank)  → LCV-201 transfer shut (latched) + fail-safe close of the high-high compartment's XV-301 (no ESD)
    //   PUMP_DRYRUN (LSLL-201 on the open transfer's suction) → LCV-201 shut (latched): gas blow-by protection of the
    //                            atmospheric gauge tank (the surge tank is pressurised)
    //   (ids PUMP_* / event 'pumpTrip' kept from the pumped transfer of v3.0; P-201 now sits downstream of T-301)
    //   LSHH-201 (surge tank)  → fail-safe close of the high-high compartment's XV-201 + ESD (SDV-101 shuts in the well)
    //   every other trip       → ESD
    //   T-202 (WP-E2): XFER2_DRYRUN → LCV-202 latched shut (no ESD); LSHH-202 → XV-202 shut (no ESD); PSHH-202 → XV-202 + PCV-204
    //                  shut, then the ESD
    if (A.act === 'pump') pumpTripNow(A);
    else if (A.act === 'xfer2') xfer2TripNow(A);
    else if (A.act === 'xv202') surge2HHClose(A, false);
    else if (A.sev === 'trip' && A.id !== 'ESD_TRIPPED') {
      if (A.id === 'LSHH_SURGE') surgeHHClose();
      else if (A.id === 'PSHH_SURGE2') surge2HHClose(A, true);
      autoTrip(A);
    }
  }
  function clearA(A) {
    if (!A.active) return;
    alarmsDirty = true;
    A.active = false; A.onT = -1; A.offT = -1;
    emit('clear', alarmPayload('clear', A));
    logEntry('clear', A.id, A.sev, A.tag, A.msg);
  }
  function alarmPayload(type, A) {
    return { type: type, t: X.t, id: A.id, tag: A.tag, sev: A.sev, eq: A.eq, msg: A.msg, value: A.value, limit: A.limit, since: A.since };
  }
  // hi/lo analog alarm with delays + deadband; bool alarms use db = 0 and value 1/0
  function evalA(A, cond, clr, value, limit, msgFn, delayed) {
    var sup = A.grace && (X.t < X.graceUntil || esdS.tripped || X.esdTravel < 0.999);
    if (sup) { if (A.active) clearA(A); A.onT = -1; return; }
    var dOn = delayed ? cfg.alarm.onDelay : 0, dOff = delayed ? cfg.alarm.offDelay : 0;
    if (!A.active) {
      if (cond) { if (A.onT < 0) A.onT = X.t; if (X.t - A.onT >= dOn - 1e-9) raise(A, value, limit, msgFn(value, limit)); }
      else A.onT = -1;
    } else {
      A.value = isNum(value) ? value : null; A.limit = isNum(limit) ? limit : null;
      if (clr) { if (A.offT < 0) A.offT = X.t; if (X.t - A.offT >= dOff - 1e-9) clearA(A); }
      else A.offT = -1;
    }
  }
  // Alarm / log texts: values with their unit through uq(). Imperial by default (field units); a host may pass
  // opts.fmt(v, cat, dp) → string (or call setFormatter) so the texts follow its unit system (38 passes WTS_live.fmtU).
  var IMPU = { pressureG: ' psig', pressure: ' psi', temperature: ' °F', tempDelta: ' °F', gasRate: ' MMSCFD', velocity: ' ft/s', percent: '%',
    mass: ' lb' };
  var fmtHook = typeof opts.fmt === 'function' ? opts.fmt : null;
  function uq(v, cat, dp) {
    if (fmtHook && cat !== 'percent' && isNum(v)) { try { var s = fmtHook(v, cat, dp); if (typeof s === 'string' && s) return s; } catch (e) { /* fall back */ } }
    return (dp != null && isNum(v) ? v.toFixed(dp) : rnd(v)) + (IMPU[cat] || '');
  }
  function mHi(tagTxt, what, cat) { return function (v, l) { return tagTxt + ' ' + what + ' ' + uq(v, cat) + ' ≥ ' + uq(l, cat); }; }
  function mLo(tagTxt, what, cat) { return function (v, l) { return tagTxt + ' ' + what + ' ' + uq(v, cat) + ' ≤ ' + uq(l, cat); }; }
  var MSG = {
    PSHH_SEP: mHi('PSHH-101', 'separator', 'pressureG'), PSH_SEP: mHi('PAH-101', 'separator pressure high', 'pressureG'),
    PSL_SEP: mLo('PAL-101', 'separator pressure low', 'pressureG'),
    PSV_SEP: function (v, l) { return 'PSV-101 lifting — separator ' + uq(v, 'pressureG') + ' (set ' + uq(l, 'pressureG') + ')'; },
    LSHH_SEP: mHi('LSHH-102', 'separator level high-high', 'percent'), LSH_SEP: mHi('LAH-102', 'oil bucket level high', 'percent'),
    LSLL_SEP: mLo('LALL-102', 'oil bucket level low-low', 'percent'),
    GAS_BLOWBY: function (v) { return 'LCV-102 gas blow-by to surge tank ' + (isNum(v) ? uq(v, 'gasRate', 2) : '—'); },
    ISHH_SEP: mHi('LAHH-101', 'interface level high-high', 'percent'),
    CARRYOVER: function (v) { return 'V-101 water carry-over at the weir (interface ' + rnd(v) + '%)'; },
    OIL_IN_WATER: function () { return 'LCV-101 passing oil — interface lost'; },
    PSHH_SURGE: mHi('PSHH-201', 'surge tank', 'pressureG'), PSH_SURGE: mHi('PAH-201', 'surge tank pressure high', 'pressureG'),
    PSV_SURGE: function (v, l) { return 'PSV-201 lifting — surge tank ' + uq(v, 'pressureG') + ' (set ' + uq(l, 'pressureG') + ')'; },
    LSHH_SURGE: function (v, l) { return 'LSHH-201 surge tank ' + sideTag('surge', surgeHiK) + ' level ' + rnd(v) + '% ≥ ' + rnd(l) + '%'; },
    LSLL_SURGE: function (v, l) { return 'LSLL-201 transfer suction level ' + rnd(v) + '% ≤ ' + rnd(l) + '%'; },
    PUMP_DRYRUN: function (v, l) { return 'LCV-201 low-low trip — suction ' + dryMsg + ' level ' + rnd(v) + '% ≤ LSLL ' + rnd(l) + '% (gas blow-by protection, reset required)'; },
    PUMP_STARVED: function (v) { return 'LCV-201 suction starved — passing ' + rnd0(v) + '% of the valve flow'; },
    PUMP_FAIL: function () { return 'P-201 transfer pump failed — the gauge tank cannot be emptied'; },
    XFER_FAIL: function () { return 'LCV-201 surge transfer valve stuck closed'; },
    XFER_LOW_DP: function (v) { return 'LCV-201 open but ΔP only ' + uq(v, 'pressure') + ' — T-201 pressure + head too low to ' + (rGauge ? 'lift to ' + TAGS.gauge : 'reach the export line'); },
    SURGE_BLOCKED: function () { return rSurge ? TAGS.xvSurgeA + ' and ' + TAGS.xvSurgeB + ' closed — separator dumps blocked (no route to ' + TAGS.surge + ')'
      : TAGS.xvGaugeA + ' and ' + TAGS.xvGaugeB + ' closed — separator dumps blocked (no route to ' + TAGS.gauge + ')'; },
    PUMP_BLOCKED: function () { return 'Surge transfer blocked — ' + TAGS.xvGaugeA + ' and ' + TAGS.xvGaugeB + ' closed (LCV-201 shut)'; },
    LAH_SURGE_BOTH: function (v, l) { return 'LAH-201 both surge compartments high (' + rnd(v) + '% ≥ ' + rnd(l) + '%) — auto-divert has no room'; },
    LAH_GT_BOTH: function (v, l) { return 'LAH-301 ' + tanks[gaugeLahK].tag + ' at ' + rnd(v) + '% ≥ SP ' + rnd(l) + '% — auto-divert has no compartment to take the flow' + gtWhy(1 - gaugeLahK); },
    LAH_GT: function (v) { return 'LAH-301 ' + tanks[active].tag + ' ' + rnd(v) + '% full — no standby compartment ready'; },
    LSHH_GT: function (v, l) { return 'LSHH-301 ' + tanks[gaugeHiK].tag + ' level ' + rnd(v) + '% ≥ ' + rnd(l) + '% — ' + (rSurge ? 'LCV-201 transfer shut, ' : '') + valveTag('gauge', gaugeHiK) + ' closed'; }
  };
  function gtWhy(o) { var s = tanks[o].state; return ' (' + tanks[o].tag + ' ' + (s === 'settling' || s === 'draining' ? s + ' — batch in progress' : rnd0(tankVliq(o) / capG * 100) + '% full') + ')'; }
  function pumpLatched() { return ptrip.LSHH_GT || ptrip.PUMP_DRYRUN; }
  // LCV-201 protective trip (latched until resetTrip): LSHH-301 also closes the high-high compartment's inlet (fail-safe)
  // With no surge tank in the rig-up (V-101 dumps straight into T-301) LSHH-301 has no transfer to shut: it closes the
  // compartment inlet only, and the texts say so (the 'pumpTrip' payload carries the action taken).
  function pumpTripNow(A) {
    var was = pumpLatched(), extra = '', closed = [];
    ptrip[A.id] = true;
    if (A.id === 'LSHH_GT') {
      for (var k = 0; k < 2; k++) if (hhK[k] && gv[k]) { gaugeClose(k); closed.push(valveTag('gauge', k)); extra += ' · ' + valveTag('gauge', k) + ' closing (fail-safe)'; }
    }
    var head = xferInLine() ? TAGS.xfer + ' transfer shut' : 'LSHH-301 trip' + (closed.length ? ' — ' + closed.join(' + ') + ' closing' : ''), tag = xferInLine() ? TAGS.xfer : 'LSHH-301';
    emit('pumpTrip', { type: 'pumpTrip', t: X.t, cause: A.id, tag: tag, msg: A.msg, value: A.value, limit: A.limit, action: head });
    logEntry('trip', A.id, 'trip', tag, (xferInLine() ? head + ' — ' + A.msg + extra : 'LSHH-301 trip — ' + A.msg + extra) + (was ? '' : ' · reset required'));
    noteControl(xferInLine() ? 'surge' : 'gauge', 'trip', true, head + ' — ' + A.msg);
  }
  // LCV-201 is in line when the surge tank is in the rig-up (the latched trips then shut the transfer)
  function xferInLine() { return rSurge; }
  // LSHH-201: close the inlet of every surge compartment at or above LSHH (stop what fills it); the ESD follows
  function surgeHHClose() {
    for (var k = 0; k < 2; k++) {
      if (uv[k] && compVliq(k) >= cfg.surge.lshh * capK - 1e-9) {
        uv[k] = false; armClose('surge', k); hold.surge[k] = false;
        logEntry('event', 'VALVE', null, valveTag('surge', k), valveTag('surge', k) + ' closed (LSHH-201 trip, fail-safe) — ' + lineupText('surge'));
        noteControl('surge', 'inlet', true, valveTag('surge', k) + ' closed by LSHH-201');
      }
    }
  }
  // reset permissives of the latched LCV-201 trips (null = may be reset now)
  function tripBlock(id) {
    if (id === 'LSHH_GT') {
      var lim = num(cfg.gauge.lshhReset, 0.9);
      for (var k = 0; k < 2; k++) {
        var f = tankVliq(k) / capG;
        if (hhK[k] && f >= lim) return tanks[k].tag + ' ' + rnd0(f * 100) + '% ≥ reset ' + rnd0(lim * 100) + '%';
        if ((gv[k] || gpos[k] > 0) && f >= cfg.gauge.lahh) return tanks[k].tag + ' still at LSHH';
      }
      return null;
    }
    if (id === 'PUMP_DRYRUN') {
      var fs = suctionV() / suctionCap();
      return fs > cfg.surge.lsl ? null : 'suction ' + rnd0(fs * 100) + '% ≤ LSL ' + rnd0(cfg.surge.lsl * 100) + '%';
    }
    if (id === 'XFER2_DRYRUN') {                    // LCV-202 low-low latch (WP-E2): reset once T-202 is back above LSL
      var f2 = X2.VliqU / cap2;
      return f2 > cfg.surge2.lsl ? null : TAGS.surge2 + ' ' + rnd0(f2 * 100) + '% ≤ LSL ' + rnd0(cfg.surge2.lsl * 100) + '%';
    }
    return null;
  }
  var surgeHiK = 0, gaugeHiK = 0, gaugeLahK = 0, FG2 = [0, 0];
  // both-high (auto-divert on): a filling side at/above SP while the other side has no room (≥ SP − hysteresis)
  function bothHigh(C, open, fA, fB, db) {
    if (!C.auto) return false;
    return (open[0] && fA >= C.sp - db && fB >= C.sp - C.hyst - db) || (open[1] && fB >= C.sp - db && fA >= C.sp - C.hyst - db);
  }
  // equipment out of the rig-up raises nothing: its (non-latched) alarms clear at once
  function quiet(ids) {
    for (var i = 0; i < ids.length; i++) { var A = AL[ids[i]]; if (!A) continue; A.onT = -1; A.offT = -1; if (A.active && !A.act) clearA(A); }
  }
  var Q_SEP = ['PSH_SEP', 'PSL_SEP', 'LSHH_SEP', 'LSH_SEP', 'LSLL_SEP', 'GAS_BLOWBY', 'ISHH_SEP', 'CARRYOVER', 'OIL_IN_WATER'];
  var Q_SURGE = ['LSHH_SURGE', 'LSLL_SURGE', 'PUMP_STARVED', 'PUMP_BLOCKED', 'LAH_SURGE_BOTH', 'XFER_FAIL', 'XFER_LOW_DP'];
  var Q_GAUGE = ['LAH_GT', 'LAH_GT_BOTH', 'PUMP_FAIL'];
  // v1.4.0 quiet lists (§4.8, §5.5; = tests/_wts-equip-shapes.js Q_DES / Q_SAND / Q_SURGE2). Declared by WP-E0; WP-E1 / WP-E2
  // use them in their own sections (desRig / desDerive, surge2Rig) and add their MSG entries there (MSG.<id> = function …)
  var Q_DES = ['DES_DP_HIGH', 'DES_DP_LOW', 'DES_LAH', 'DES_LAHH', 'DES_DUMP_FAIL', 'DES_RATING', 'DES_PSHH', 'DES_RATE',
    'HYD_desander', 'HYD_dsAcc', 'HYD_dsBleed'];
  var Q_SAND = ['SAND_CHOKE', 'SAND_SEP'];
  var Q_SURGE2 = ['PSHH_SURGE2', 'PSH_SURGE2', 'PSV_SURGE2', 'LSHH_SURGE2', 'LSLL_SURGE2', 'XFER2_DRYRUN', 'XFER2_FAIL',
    'XFER2_LOW_DP', 'LAH_SURGE_ALL'];
  // v1.5.0 quiet lists (docs/SIM-FOLLOWUP-PLAN.md D12, §5.1; = tests/_wts-fu-shapes.js Q_CK2 / Q_SEPBY / Q_CUSH). Declared by WP-E0;
  // WP-E1 / WP-E2 raise these ids in their sections and add their MSG entries there
  var Q_CK2 = ['CHOKE2_LIMIT', 'CK1_SUBCRIT', 'PAH_CK2', 'HYD_heaterChoke'];
  var Q_SEPBY = ['PSHH_SEPBY', 'SEPBY_RATING'];
  var Q_CUSH = ['CUSH_LIMIT', 'CUSH_NOLIFT', 'CUSH_BURNER', 'CUSH_DUMP', 'HTR_FULL'];
  // separator dumps blocked: both XV-201 shut (surge tank in line) or both XV-301 shut (V-101 → T-301 direct)
  function surgeBlocked() {
    var blk = rSep && (rSurge ? (!uv[0] && !uv[1] && !(rSurge2 && ctl.surge2.inlet)) : (rGauge && pumpBlocked));
    var A = aDef('SURGE_BLOCKED', 'XV-201', 'alarm', 'surge', 'b');
    if (!A.active) { A.tag = A.pub.tag = rSurge ? 'XV-201' : 'XV-301'; A.eq = A.pub.eq = rSurge ? 'surge' : 'gauge'; }
    evalA(A, blk, !blk, null, null, MSG.SURGE_BLOCKED, true);
  }
  function processAlarms() {
    var S = cfg.sep, dbP = cfg.alarm.pressDBfrac * mmax(X.SPe, 1), dbL = cfg.alarm.levelDB * D;
    var A;
    // pressure protection stays live on a blocked-in vessel; process alarms only while the vessel is in the rig-up
    A = aDef('PSHH_SEP', 'PSHH-101', 'trip', 'separator', 'p');
    evalA(A, X.Psep >= X.pshh, X.Psep < X.pshh - dbP, X.Psep, X.pshh, MSG.PSHH_SEP, false);
    if (rSep) {
      A = aDef('PSH_SEP', 'PAH-101', 'alarm', 'separator', 'p');
      evalA(A, X.Psep >= X.psh, X.Psep < X.psh - dbP, X.Psep, X.psh, MSG.PSH_SEP, true);
      A = aDef('PSL_SEP', 'PAL-101', 'warn', 'separator', 'p', true);
      evalA(A, X.Psep <= X.psl && X.f > 0.5, X.Psep > X.psl + dbP || X.f <= 0.5, X.Psep, X.psl, MSG.PSL_SEP, true);
    }
    A = aDef('PSV_SEP', 'PSV-101', 'alarm', 'separator', 'b');
    evalA(A, psvLift, !psvLift, X.Psep, X.mawpE, MSG.PSV_SEP, false);
    if (rSep) {
      var lshhO = S.oil.lshh * D, lahhT = S.lahhTotal * D;
      A = aDef('LSHH_SEP', 'LSHH-102', 'trip', 'separator', 'l');
      var useB = X.h2 / lshhO >= X.hL1 / lahhT;
      evalA(A, X.h2 >= lshhO || X.hL1 >= lahhT, X.h2 < lshhO - dbL && X.hL1 < lahhT - dbL,
        (useB ? X.h2 : X.hL1) / D * 100, (useB ? S.oil.lshh : S.lahhTotal) * 100, MSG.LSHH_SEP, false);
      var lshB = (S.oil.lsh + 0.03) * D;
      A = aDef('LSH_SEP', 'LAH-102', 'alarm', 'separator', 'l');
      evalA(A, X.h2 >= lshB, X.h2 < lshB - dbL, X.h2 / D * 100, lshB / D * 100, MSG.LSH_SEP, true);
      A = aDef('LSLL_SEP', 'LALL-102', 'alarm', 'separator', 'l', true);
      evalA(A, X.h2 <= S.oil.lsll * D, X.h2 > S.oil.lsll * D + dbL, X.h2 / D * 100, S.oil.lsll * 100, MSG.LSLL_SEP, true);
      var blow = F.blowO + F.blowW;
      A = aDef('GAS_BLOWBY', 'LCV-102', 'alarm', 'separator', 'b');
      evalA(A, blow > 0, !(blow > 0), blow * 0.0864, null, MSG.GAS_BLOWBY, true);
      A = aDef('ISHH_SEP', 'LAHH-101', 'alarm', 'separator', 'l');
      evalA(A, X.hW1 >= S.water.lshh * D, X.hW1 < S.water.lshh * D - dbL, X.hW1 / D * 100, S.water.lshh * 100, MSG.ISHH_SEP, true);
      A = aDef('CARRYOVER', 'V-101', 'warn', 'separator', 'b');
      evalA(A, F.phiC > 0, !(F.phiC > 0), X.hW1 / D * 100, hWeir / D * 100, MSG.CARRYOVER, true);
      A = aDef('OIL_IN_WATER', 'LCV-101', 'warn', 'separator', 'b', true);
      evalA(A, F.wO > 0, !(F.wO > 0), F.wO * 86400, null, MSG.OIL_IN_WATER, true);
    } else quiet(Q_SEP);
    var U = cfg.surge, dbPu = cfg.alarm.pressDBfrac * mmax(X.SPeu, 1), dbLu = cfg.alarm.levelDB;
    var fUA = compVliq(0) / capK, fUB = compVliq(1) / capK, fracHiU = mmax(fUA, fUB), fracS = suctionV() / suctionCap();
    surgeHiK = fUB > fUA ? 1 : 0;
    A = aDef('PSHH_SURGE', 'PSHH-201', 'trip', 'surge', 'p');
    evalA(A, X.Pu >= X.pshhU, X.Pu < X.pshhU - dbPu, X.Pu, X.pshhU, MSG.PSHH_SURGE, false);
    A = aDef('PSH_SURGE', 'PAH-201', 'alarm', 'surge', 'p');
    evalA(A, rSurge && X.Pu >= X.pshU, !rSurge || X.Pu < X.pshU - dbPu, X.Pu, X.pshU, MSG.PSH_SURGE, true);
    A = aDef('PSV_SURGE', 'PSV-201', 'alarm', 'surge', 'b');
    evalA(A, psvULift, !psvULift, X.Pu, X.mawpU, MSG.PSV_SURGE, false);
    if (rSurge) {
      A = aDef('LSHH_SURGE', 'LSHH-201', 'trip', 'surge', 'l');
      evalA(A, fracHiU >= U.lshh, fracHiU < U.lshh - dbLu, fracHiU * 100, U.lshh * 100, MSG.LSHH_SURGE, false);
      A = aDef('LSLL_SURGE', 'LSLL-201', 'warn', 'surge', 'l', true);
      evalA(A, fracS <= U.lsll, fracS > U.lsll + dbLu, fracS * 100, U.lsll * 100, MSG.LSLL_SURGE, true);
    }
    // LCV-201 low-low (gas blow-by) protection: latched trip set by the discrete logic (open transfer, suction at LSLL)
    A = aDef('PUMP_DRYRUN', TAGS.xfer, 'trip', 'surge', 'l'); A.act = 'pump';
    if (ptrip.PUMP_DRYRUN && !A.active) raise(A, fracS * 100, U.lsll * 100, MSG.PUMP_DRYRUN(fracS * 100, U.lsll * 100));
    else if (A.active) A.value = fracS * 100;
    if (rSurge) {
      var runP = X.lastQp > 0, starved = runP && X.lastDraw < 0.98 * X.lastQp;
      A = aDef('PUMP_STARVED', TAGS.xfer, 'warn', 'surge', 'b');
      evalA(A, starved, !starved, X.lastQp > 0 ? X.lastDraw / X.lastQp * 100 : 0, 98, MSG.PUMP_STARVED, true);
      A = aDef('XFER_FAIL', TAGS.xfer, 'alarm', 'surge', 'b');
      evalA(A, faults.xferStuckClosed, !faults.xferStuckClosed, null, null, MSG.XFER_FAIL, false);
      // no pump: an open transfer valve passes nothing when the vessel pressure + head cannot lift the liquid
      var lowDP = F.xCmd > 0 && F.xdP < num(U.xferMinDP, 1);
      A = aDef('XFER_LOW_DP', TAGS.xfer, 'warn', 'surge', 'p');
      evalA(A, lowDP, !lowDP, F.xdP, num(U.xferMinDP, 1), MSG.XFER_LOW_DP, true);
      surgeBlocked();
      A = aDef('PUMP_BLOCKED', TAGS.xfer, 'alarm', 'surge', 'b');
      evalA(A, pumpBlocked, !pumpBlocked, null, null, MSG.PUMP_BLOCKED, true);
      var bU = bothHigh(ctl.surge, uv, fUA, fUB, 0), bUc = !bothHigh(ctl.surge, uv, fUA, fUB, dbLu);
      if (rSurge2 && ctl.surge2.auto && X2.VliqU / cap2 < ctl.surge2.sp - ctl.surge2.hyst) { bU = false; bUc = true; }   // the auto route has room (WP-E2)
      A = aDef('LAH_SURGE_BOTH', 'LAH-201', 'alarm', 'surge', 'l');
      evalA(A, bU, bUc, fracHiU * 100, ctl.surge.sp * 100, MSG.LAH_SURGE_BOTH, true);
    } else { quiet(Q_SURGE); surgeBlocked(); }
    // v1.4.0 optional items: evaluated only while the item is in (sand alarms while sand is on); released on removal
    if (rDes || sandOn) desAlarms();
    if (rSurge2) surge2Alarms();
    // v1.5.0 (WP-E2): bypass-path protection while V-101 is out (§6.2, D16); cushion alarms while one flows (§6.3)
    if (!rSep) bypAlarms();
    if (cushOn) cushAlarms();
    if (!rGauge) { quiet(Q_GAUGE); return; }
    A = aDef('PUMP_FAIL', 'P-201', 'alarm', 'pump', 'b');
    evalA(A, rPump && faults.surgePumpFail, !(rPump && faults.surgePumpFail), null, null, MSG.PUMP_FAIL, false);
    var Gc = cfg.gauge, fa = tankVliq(active) / capG, noStandby = tanks[1 - active].state !== 'ready';
    var fGA = tankVliq(0) / capG, fGB = tankVliq(1) / capG, fG = FG2; FG2[0] = fGA; FG2[1] = fGB;
    A = aDef('LAH_GT', 'LAH-301', 'alarm', 'gauge', 'l');
    evalA(A, fa >= Gc.switchFrac && noStandby, fa < Gc.switchFrac - 0.02 || !noStandby, fa * 100, Gc.switchFrac * 100, MSG.LAH_GT, true);
    // LSHH-301: a compartment that is lined up (inlet commanded open or valve still passing) at high-high shuts
    // LCV-201 and closes that compartment's inlet; latched until the operator resets it below the reset point
    A = aDef('LSHH_GT', 'LSHH-301', 'trip', 'gauge', 'l'); A.act = 'pump';
    var hi0 = (gv[0] || gpos[0] > 0) && fGA >= Gc.lahh - 1e-9, hi1 = (gv[1] || gpos[1] > 0) && fGB >= Gc.lahh - 1e-9;
    if (!A.active) {
      if (hi0 || hi1) {
        hhK[0] = hi0; hhK[1] = hi1; gaugeHiK = hi1 && (!hi0 || fGB > fGA) ? 1 : 0;
        raise(A, fG[gaugeHiK] * 100, Gc.lahh * 100, MSG.LSHH_GT(fG[gaugeHiK] * 100, Gc.lahh * 100));
      }
    } else { A.value = fG[gaugeHiK] * 100; if (hi0) hhK[0] = true; if (hi1) hhK[1] = true; }
    // LAH-301 (auto-divert on): the filling compartment is at its set point and the other one cannot take the flow —
    // no room (≥ SP − hysteresis), or a batch in progress that may not be interrupted, or latched at LSHH
    var gC = ctl.gauge, bG = false, bGc = true;
    for (var gk = 0; gk < 2; gk++) {
      if (!gC.auto || !gv[gk]) continue;
      var og = 1 - gk, avO = gaugeAvail(og), noRoom = !(fG[og] < gC.sp - gC.hyst) || !avO, noRoomC = !(fG[og] < gC.sp - gC.hyst - 0.02) || !avO;
      if (fG[gk] >= gC.sp && noRoom) { bG = true; gaugeLahK = gk; }
      if (fG[gk] >= gC.sp - 0.02 && noRoomC) bGc = false;
    }
    A = aDef('LAH_GT_BOTH', 'LAH-301', 'alarm', 'gauge', 'l');
    evalA(A, bG, bGc, fG[gaugeLahK] * 100, gC.sp * 100, MSG.LAH_GT_BOTH, true);
  }
  function autoTrip(A) {
    if (esdS.tripped && !esdS.manual) return;
    var wasManual = esdS.tripped && esdS.manual;
    esdS.tripped = true; esdS.manual = false; esdS.cause = A.id; esdS.causeMsg = A.msg; esdS.tripT = X.t;
    if (wasManual && AL.ESD_MANUAL) clearA(AL.ESD_MANUAL);
    var E = aDef('ESD_TRIPPED', 'SDV-101', 'trip', 'esd', 'x');
    if (!E.active) raise(E, A.value, A.limit, 'ESD tripped — ' + A.msg);
    emit('trip', { type: 'trip', t: X.t, cause: A.id, tag: A.tag, msg: A.msg, value: A.value, limit: A.limit, manual: false });
    logEntry('trip', A.id, 'trip', A.tag, 'ESD tripped — ' + A.msg);
  }

  // ── history ──
  function histReset() {
    var n = mmax(2, cfg.histLen | 0);
    H = { n: n, i: 0, c: 0, next: 0, t: new Float64Array(n), k: {} };
    HIST_KEYS.forEach(function (k) { H.k[k] = new Float64Array(n); });
  }
  function histSample(force) {
    if (!force && X.t < H.next - 1e-9) return;
    var i = H.i;
    H.t[i] = X.t;
    H.k.Psep[i] = X.Psep; H.k.PsepSP[i] = X.SPe; H.k.bucketFrac[i] = X.h2 / D; H.k.ifaceFrac[i] = X.hW1 / D; H.k.c1Frac[i] = X.hL1 / D;
    H.k.surgeFrac[i] = X.hU / Hu; H.k.surgeP[i] = X.Pu; H.k.gaugeFracA[i] = tankVliq(0) / capG; H.k.gaugeFracB[i] = tankVliq(1) / capG;
    H.k.surgeFracA[i] = compVliq(0) / capK; H.k.surgeFracB[i] = compVliq(1) / capK;
    H.k.qgFlare[i] = (F.pcv + F.psv + F.bpv + F.psvU) * 0.0864; H.k.qoMeter[i] = X.emaOil * 86400; H.k.Pwh[i] = X.Pwh;
    var PdnH = pDown(), ck2L = CK2.act || X.ck2dP !== 0;   // pckLive with the v1.4.0 product order (X.fInst · X.fInst)
    var pckH = ck2L ? ck2Pck(PdnH, X.fInst * X.fInst) : PdnH + (Pck_ss - Psep_ss) * X.fInst * X.fInst;
    H.k.Pchoke[i] = pckH; H.k.Twh[i] = Tamb + (Twh_ss - Tamb) * X.theta;
    desHist(i); surge2Hist(i);                   // v1.4.0 keys (written every sample, in or out: no stale ring entries)
    // v1.5.0 keys: plain number writes (§6.3 History): CK-102 inlet while in line, else the CK-101 outlet; cushion left (bbl)
    H.k.Pck2[i] = CK2.act ? ck2Pm(PdnH, X.fInst * X.fInst) : pckH;
    H.k.cushionLeft[i] = cushHas ? cushS.V - cushS.Vprod : 0;
    H.i = (i + 1) % H.n; if (H.c < H.n) H.c++;
    var dt = mmax(0.1, cfg.histDt);
    H.next = (mfloor(X.t / dt + 1e-9) + 1) * dt;
  }

  // ── one substep (§4.13 order) ──
  function substep(h) {
    var S = cfg.sep, U = cfg.surge, Gc = cfg.gauge, N = cfg.noise, Rr = cfg.ramp;
    var i;
    // 2 (first, so discrete logic uses the current limits): SP ramps + SP_eff-based limits
    limits(h);
    // 1 discrete logic
    var VB = X.Vw2 + X.Vo2 * X.Bs;
    if (faults.oilDumpStuckOpen) lcvO.cmd = 1;
    else if (faults.oilDumpStuckClosed) lcvO.cmd = 0;
    else if (S.oil.mode === 'pi') lcvO.cmd = levelPI(lcvO, X.h2, S.oil, h);
    else if (VB >= VB_hi - 1e-12) { if (lcvO.cmd < 0.5) oilCycles++; lcvO.cmd = 1; }
    else if (VB <= VB_lo + 1e-12) lcvO.cmd = 0;
    if (faults.waterDumpStuckClosed) lcvW.cmd = 0;
    else if (S.water.mode === 'pi') lcvW.cmd = levelPI(lcvW, X.hW1, S.water, h);
    else if (X.Vw1 >= VW_hi - 1e-12) { if (lcvW.cmd < 0.5) waterCycles++; lcvW.cmd = 1; }
    else if (X.Vw1 <= VW_lo + 1e-12) lcvW.cmd = 0;
    var fracU = suctionV() / suctionCap();          // LCV-201 level control on the selected suction compartment(s)
    // Low-low protection: an OPEN transfer whose suction is at LSLL either moves its suction to the other compartment
    // (auto-divert on and that compartment above LSL) or shuts (latched, reset required) — the surge tank is
    // pressurised, so an empty suction would blow gas through to the atmospheric gauge tank. Below LSLL a shut
    // transfer is simply not opened (LSL/LSH level control): a permissive, not a trip.
    if (rSurge && pumpOn && !pumpLatched() && !pumpBlocked && !faults.xferStuckClosed && fracU <= U.lsll + 1e-12) {
      var sx = ctl.surge.suction, so = sx === 'A' ? 1 : sx === 'B' ? 0 : -1;
      if (ctl.surge.auto && so >= 0 && compVliq(so) / capK > U.lsl) {
        ctl.surge.suction = letter(so);
        var smsg = TAGS.xfer + ' suction auto-switched ' + sideTag('surge', 1 - so) + ' (' + rnd0(fracU * 100) + '% ≤ LSLL) → ' + sideTag('surge', so) +
          ' (' + rnd0(compVliq(so) / capK * 100) + '%) — gas blow-by / dry-run protection';
        logEntry('switch', 'AUTO_SUCTION', null, TAGS.xfer, smsg);
        emit('suction', { type: 'suction', t: X.t, from: 1 - so, to: so, auto: true, tag: TAGS.xfer, msg: smsg });
        noteControl('surge', 'suction', true, smsg);
        fracU = suctionV() / suctionCap();
      } else {
        ptrip.PUMP_DRYRUN = true;
        dryMsg = sx === 'both' ? TAGS.surgeA + ' + ' + TAGS.surgeB : sideTag('surge', sx === 'B' ? 1 : 0);
      }
    }
    if (rSurge) { if (fracU >= U.lsh - 1e-12) pumpOn = true; else if (fracU <= U.lsl + 1e-12) pumpOn = false; }
    if (rGauge) {                                   // gauge tank out of the rig-up: its batch cycle is frozen
      for (i = 0; i < 2; i++) {
        var tk = tanks[i];
        if (tk.state === 'settling' && X.t - tk.since >= Gc.settleS - 1e-9) { recordBatch(i); tk.state = 'draining'; tk.since = X.t; }
        if (tk.state === 'draining' && tankVliq(i) <= Gc.heelFrac * capG + 1e-9) { tk.state = 'ready'; tk.since = X.t; }
      }
      if (gv[active] && tankVliq(active) >= Gc.switchFrac * capG - 1e-9 && tanks[1 - active].state === 'ready') doSwitch(false);
    }
    autoDivert();
    if (rSurge2) surge2Discrete(h);               // T-202 auto route, LCV-202 level control / low-low latch, PSV-202 (WP-E2)
    if (!psvLift && X.Psep >= X.mawpE) psvLift = true; else if (psvLift && X.Psep <= 0.93 * X.mawpE) psvLift = false;
    if (!psvULift && X.Pu >= X.mawpU) psvULift = true; else if (psvULift && X.Pu <= 0.93 * X.mawpU) psvULift = false;

    // 3 fluxes
    // valve travel over this substep: new position + exact time-average of the (clamped) ramp
    slew(lcvO.x, lcvO.cmd, h, S.oil.strokeS, S.oil.strokeS); var xOav = SLEW.avg, xOnew = SLEW.x;
    slew(lcvW.x, lcvW.cmd, h, S.water.strokeS, S.water.strokeS); var xWav = SLEW.avg, xWnew = SLEW.x;
    slew(X.esdTravel, esdS.tripped ? 0 : 1, h, Rr.esdOpenS, Rr.esdCloseS); var trAv = SLEW.avg, trNew = SLEW.x;
    // inlet divert valves XV-201A/B, XV-301A/B: linear travel at 1/strokeS; flow splits follow the time-averaged positions
    var sU = ctl.surge.strokeS, sG = ctl.gauge.strokeS;
    slew(upos[0], vTarget('surge', 0), h, sU, sU); var uA_av = SLEW.avg, uA_n = SLEW.x;
    slew(upos[1], vTarget('surge', 1), h, sU, sU); var uB_av = SLEW.avg, uB_n = SLEW.x;
    slew(gpos[0], vTarget('gauge', 0), h, sG, sG); var gA_av = SLEW.avg, gA_n = SLEW.x;
    slew(gpos[1], vTarget('gauge', 1), h, sG, sG); var gB_av = SLEW.avg, gB_n = SLEW.x;
    var uSum = uA_av + uB_av, gSum = gA_av + gB_av;
    X.fE = clamp(trAv / 0.25, 0, 1);
    var slug = 0;
    if (faults.slugging || N.slug.on) {
      var per = mmax(1, N.slug.period), wd = clamp(N.slug.width, 0, per);
      slug = N.slug.amp * (((X.t % per) < wd) ? 1 : 0) - N.slug.amp * wd / per;
    }
    X.mg = N.on ? mmax(0, 1 + N.gasSigma * X.xiG) : 1;
    X.ml = mmax(0, 1 + (N.on ? N.liqSigma * X.xiL : 0) + slug);
    var qInG = X.qBg * X.fE * X.mg, qInO = X.qBo * X.fE * X.ml, qInW = X.qBw * X.fE * X.ml;
    if (cushOn) qInW += cushInW();                 // v1.5.0 (WP-E2): delivered cushion water (bbl/s) joins the well stream
    // separator out of the rig-up: the whole well stream bypasses V-101 to the flare / burner (clean-up)
    var sIn = rSep ? 1 : 0, byG = qInG * (1 - sIn), byO = qInO * (1 - sIn), byW = qInW * (1 - sIn);
    var sInG = qInG * sIn, sInO = qInO * sIn, sInW = qInW * sIn;
    var TR = X.Tsep + RANK, P2a = PSC + S.pcv.P2_psig;
    // PCV-101 gain-scheduled PI (held shut, integrator frozen, while V-101 is bypassed)
    var Pspan = mmax(X.SPe, 50), e = (X.Psep - X.SPe) / Pspan;
    var qCapPcv = gq(Cv_pcv, X.PsepA, P2a, TR, X.Zs);
    if (rSep) {
      var P1k = mmax(X.PsepA, X.SPe + PSC);
      var Kp = X.Zs * TR * PSC / (TSC * X.Vg) * gq(Cv_pcv, P1k, P2a, TR, Zf(P1k, TR));
      var Kc = Kp > 1e-12 ? Pspan / (Kp * tauClSep()) : 0;
      var uRaw = pcvBias() + Kc * (e + X.Ipcv / S.pcv.Ti);
      X.upcv = clamp(uRaw, 0, 1);
      if ((uRaw > 0 && uRaw < 1) || (uRaw >= 1 && e < 0) || (uRaw <= 0 && e > 0)) X.Ipcv += e * h;
      if (faults.pcvStuckClosed) X.upcv = 0; else if (faults.pcvStuckOpen) X.upcv = 1;
    } else X.upcv = 0;
    var qPcv = X.upcv * qCapPcv;
    var qPsv = psvLift ? gq(Cv_psv, X.PsepA, P2a, TR, X.Zs) : 0;
    // liquids: the dumps discharge into T-201, or (no surge tank) into the atmospheric gauge tank / export line
    // T-202 in (WP-E2): XV-202 travel; the dumps discharge against T-201, T-202 or the inlet header when both are open
    var TRu = X.Tu + RANK, PdA = rSurge2 ? surge2Pre(h, uA_av, uB_av) : (rSurge ? X.PuA : PSC), Pd = PdA - PSC;
    var VLB = X.Vw2 + X.Vo2 * X.Bs;
    var SGB = VLB > 1e-12 ? (X.Vw2 + X.Vo2 * X.Bs * SGo) / VLB : SGo;
    var dPo = (X.Psep - Pd) + WGRAD * SGB * X.h2;
    // dumps blocked: V-101 bypassed, or both inlet valves of the receiving tank shut (dumps against a closed line)
    var blkU = !rSep || (rSurge ? !(uSum > 0 || (rSurge2 && F2.x2av > 0)) : (rGauge && !(gSum > 0)));
    var capO = (blkU ? 0 : xOav) * liqQ(Cv_o, dPo, SGB);
    var phiL = clamp(VLB / 0.02, 0, 1);
    var qLo = capO * phiL;
    var oW = mmin(qLo, X.Vw2 / h), oObbl = mmin(qLo - oW, X.Vo2 * X.Bs / h);
    var qBlowO = (!blkU && xOav > 0 && phiL < 1) ? xOav * (1 - phiL) * gq(Cv_o, X.PsepA, PdA, TR, X.Zs) : 0;
    // v1.5.0 (D8): while a cushion flows the water dump and its head use the cushion SG (mixing ignored; Cv_w stays as sized)
    var dPw = cushOn ? (X.Psep - Pd) + WGRAD * (cushS.SG * X.hW1 + SGo * (X.hL1 - X.hW1)) : (X.Psep - Pd) + WGRAD * (X.hW1 + SGo * (X.hL1 - X.hW1));
    var capW = (blkU ? 0 : xWav) * liqQ(Cv_w, dPw, cushOn ? cushS.SG : 1.0);
    var phiW = clamp(X.Vw1 / 0.02, 0, 1);
    var wW = mmin(capW * phiW, X.Vw1 / h);
    var phiO1 = clamp(X.Vo1 * X.Bs / 0.02, 0, 1);
    var wObbl = mmin(capW * (1 - phiW) * phiO1, X.Vo1 * X.Bs / h);
    var qBlowW = (!blkU && xWav > 0 && phiW < 1 && phiO1 < 1) ? xWav * (1 - phiW) * (1 - phiO1) * gq(Cv_w, X.PsepA, PdA, TR, X.Zs) : 0;
    // weir (Francis)
    var Hw = X.hL1 - mmax(hWeir, X.h2);
    var qOver = Hw > 0 ? 3.33 * Lw * mpow(Hw, 1.5) / BBL : 0;
    var phiC = clamp((X.hW1 - (hWeir - 1 / 12)) / (1 / 12), 0, 1);
    var weirW = mmin(phiC * qOver, X.Vw1 / h), weirObbl = mmin((1 - phiC) * qOver, X.Vo1 * X.Bs / h);
    // blanket PCV-202 (P-only), closed when the separator itself is below 90 % of its setpoint (or either vessel is out)
    X.ublk = (rSep && rSurge && U.blanket.on && X.Psep >= 0.9 * X.SPe) ? clamp((X.SPeu - U.blanket.deadband - X.Pu) / mmax(U.blanket.band, 0.1), 0, 1) : 0;
    var qBlk = X.ublk > 0 ? mmin(X.ublk * gq(Cv_mk, X.PsepA, X.PuA, TR, X.Zs), 0.5 * X.n_s / h) : 0;
    // surge: flash, BPV PI (held shut, integrator frozen, while T-201 is out), PSV, LCV-201 transfer
    var qFlash = 0;                             // flash of the dumped oil at the surge tank (set after the limiters)
    var PspanU = mmax(X.SPeu, 20), eU = (X.Pu - X.SPeu) / PspanU;
    var qCapBpv = gq(Cv_bpv, X.PuA, X.P2aU, TRu, X.Zu);
    if (rSurge) {
      var P1u = mmax(X.PuA, X.SPeu + PSC);
      var KpU = X.Zu * TRu * PSC / (TSC * X.VgU) * gq(Cv_bpv, P1u, X.P2aU, TRu, Zf(P1u, TRu));
      var KcU = KpU > 1e-12 ? PspanU / (KpU * U.bpv.tauCl) : 0;
      var uRawU = bpvBias() + KcU * (eU + X.Ibpv / U.bpv.Ti);
      X.ubpv = clamp(uRawU, 0, 1);
      if ((uRawU > 0 && uRawU < 1) || (uRawU >= 1 && eU < 0) || (uRawU <= 0 && eU > 0)) X.Ibpv += eU * h;
    } else X.ubpv = 0;
    var qBpv = X.ubpv * qCapBpv;
    var qPsvU = psvULift ? gq(Cv_psvU, X.PuA, P2a, TRu, X.Zu) : 0;
    // T-202 (WP-E2): PCV-204 blanket (qBlk2, in the separator limiter), PCV-203, PSV-202, LCV-202; qFl2 / qF2 its flare / flash
    var qBlk2 = 0, qFl2 = 0, qF2 = 0;
    if (rSurge2) { surge2Gas(h, TR, P2a, gSum); qBlk2 = F2.blk; }
    // LCV-201 (on/off level control, no pump): open while level control asks, no latched trip, not stuck, and a
    // route (a T-301 inlet passing, or the export line when there is no gauge tank). Flow = Cv·√(ΔP/SG) with
    // ΔP = surge pressure + head − lift to T-301's top inlet: it falls with the vessel pressure and stops at ΔP ≤ 0.
    var xCmd = rSurge && pumpOn && !pumpLatched() && !faults.xferStuckClosed && (!rGauge || gSum > 0);
    var xdP = xCmd ? xferDP() : 0;                  // (computed for the display in refresh() while shut)
    var Qp = xCmd ? liqQ(Cv_x, xdP, XF.sg) : 0, pumpBpd = Qp * 86400, po = 0, pw = 0, poA = 0, poB = 0, pwA = 0, pwB = 0;
    var VuA0 = compVliq(0), VuB0 = compVliq(1), VS0 = (sucSel(0) ? VuA0 : 0) + (sucSel(1) ? VuB0 : 0);
    if (Qp > 0 && VS0 > 1e-9) {                     // draw each phase in proportion to its share of the suction inventory
      if (sucSel(0)) { pwA = mmin(Qp * (uw[0] / VS0), uw[0] / h); poA = mmin(Qp * (uo[0] * X.Bu / VS0) / X.Bu, uo[0] / h); }
      if (sucSel(1)) { pwB = mmin(Qp * (uw[1] / VS0), uw[1] / h); poB = mmin(Qp * (uo[1] * X.Bu / VS0) / X.Bu, uo[1] / h); }
      pw = pwA + pwB; po = poA + poB;
    }
    // split by valve position (isolation ball valves in parallel branches of equal line resistance: flow ∝ opening)
    var suA = uSum > 0 ? uA_av / uSum : 0, suB = uSum > 0 ? uB_av / uSum : 0;
    var sgA = gSum > 0 ? gA_av / gSum : 0, sgB = gSum > 0 ? gB_av / gSum : 0;
    X.lastQp = Qp; X.lastDraw = po * X.Bu + pw;
    var qDA = poA * X.Bu + pwA, qDB = poB * X.Bu + pwB;
    X.Tpump = (qDA + qDB) > 1e-12 ? (qDA * Tuk[0] + qDB * Tuk[1]) / (qDA + qDB) : X.Tu;   // LCV-201 discharge: draw-weighted mix of the suction compartments
    var VG0a = tankVliq(0), VG0b = tankVliq(1);
    // gauge drains: P-201 empties a draining compartment to the export / burner line (none while P-201 has failed);
    // without P-201 in the rig-up the compartment drains by gravity (head-driven, ∝ √level)
    var drO0 = 0, drW0 = 0, drO1 = 0, drW1 = 0;
    for (i = 0; i < 2; i++) {
      if (!rGauge || tanks[i].state !== 'draining') continue;
      var vl = tankVliq(i), bg = tankBo(i), dro = 0, drw = 0;
      var Qd = rPump ? (faults.surgePumpFail ? 0 : drainBpd / 86400) : num(Gc.gravityFrac, 0.35) * drainBpd / 86400 * msqrt(mmax(0, vl / capG));
      if (vl > 1e-9 && Qd > 0) { drw = mmin(Qd * tanks[i].Vw / vl, tanks[i].Vw / h); dro = mmin(Qd * tanks[i].Vo * bg / vl / bg, tanks[i].Vo / h); }
      if (i === 0) { drO0 = dro; drW0 = drw; } else { drO1 = dro; drW1 = drw; }
    }

    // 4 flux limiters (outflow ≤ inventory/h per source)
    var sc, out;
    var weirO = weirObbl / X.Bs, oO = oObbl / X.Bs, wO = wObbl / X.Bs;
    out = weirO + wO; if (out * h > X.Vo1) { sc = X.Vo1 / (out * h); weirO *= sc; wO *= sc; }
    out = weirW + wW; if (out * h > X.Vw1) { sc = X.Vw1 / (out * h); weirW *= sc; wW *= sc; }
    out = qPcv + qPsv + qBlk + qBlk2 + qBlowO + qBlowW;
    if (out * h > X.n_s) { sc = X.n_s / (out * h); qPcv *= sc; qPsv *= sc; qBlk *= sc; qBlk2 *= sc; qBlowO *= sc; qBlowW *= sc; }
    if (rSurge2) F2.blk = qBlk2;
    out = qBpv + qPsvU; if (out * h > X.n_u) { sc = X.n_u / (out * h); qBpv *= sc; qPsvU *= sc; }
    // routing of the separator liquids and of the LCV-201 discharge (rig-up):
    //   gauge inflow giO (STB/s) / giW (bbl/s) at temperature giT, volume factor giB; export / burner line exO / exW;
    //   flash + blow-by gas at the receiving atmospheric tank / line vents there (gaugeFlash / gaugeVent)
    var dmpO = oO + wO, dmpW = oW + wW;
    var giO = 0, giW = 0, giT = X.Tpump, giB = X.Bu, exO = 0, exW = 0, gvent = 0, gblow = 0;
    if (rSurge) {
      if (rSurge2) surge2Split(dmpO, dmpW, qBlowO + qBlowW);   // pressure-driven split between T-201 and T-202 (WP-E2)
      qFlash = (rSurge2 ? F2.s1 * dmpO : dmpO) * mmax(0, RsE(X.PsepA, X.Tsep) - RsE(X.PuA, X.Tu));
      gvent = po * RsE(X.PuA, X.Tu);
      if (rGauge) { giO = po; giW = pw; } else { exO = po; exW = pw; }
    } else {
      gvent = dmpO * RsE(X.PsepA, X.Tsep); gblow = qBlowO + qBlowW;
      if (rGauge) { giO = dmpO; giW = dmpW; giT = X.Tsep; giB = X.Bs; } else { exO = dmpO; exW = dmpW; }
    }
    if (rSurge2) {                                  // LCV-202 joins the transfer line to T-301 (or the export line); its oil flashes there
      var po2 = F2.po, pw2 = F2.pw;
      qF2 = F2.flash; qFl2 = F2.bpv + F2.psv;
      if (po2 + pw2 > 0) {
        var qd1 = po * X.Bu + pw, qd2 = po2 * X2.Bu + pw2;
        giT = (qd1 * giT + qd2 * X2.Tu) / (qd1 + qd2);
        if (rGauge) { giB = (po * X.Bu + po2 * X2.Bu) / mmax(po + po2, 1e-300); giO += po2; giW += pw2; } else { exO += po2; exW += pw2; }
        F2.gP = X2.PuA; F2.gT = X2.Tu; F2.gRs = RsE(X2.PuA, X2.Tu);   // T-202 flash basis (diagnostic: surge2Internal)
        gvent += po2 * F2.gRs;
      }
      cum.xo1 += po * h; cum.xo2 += po2 * h;
    }

    // 5 explicit update: every flux leaves its source and enters its sink in this block
    var VW0 = X.Vw1;                                  // pre-update water inventory: F.rW1 must be the true rate over this step (event location)
    X.n_s +=(sInG - qPcv - qPsv - qBlk - qBlk2 - qBlowO - qBlowW) * h;
    X.Vo1 += (sInO - weirO - wO) * h;
    X.Vw1 += (sInW - weirW - wW) * h;
    X.Vo2 += (weirO - oO) * h;
    X.Vw2 += (weirW - oW) * h;
    if (rSurge2 && F2.act) {                        // XV-202 open: T-201 takes its share s1 of the dumps and blow-by (WP-E2)
      var s1 = F2.s1;
      X.n_u += (qFlash + (qBlowO + qBlowW) * s1 + qBlk - qBpv - qPsvU) * h;
      uo[0] += (s1 * suA * dmpO - poA) * h; uo[1] += (s1 * suB * dmpO - poB) * h;
      uw[0] += (s1 * suA * dmpW - pwA) * h; uw[1] += (s1 * suB * dmpW - pwB) * h;
    } else if (rSurge) {
      X.n_u += (qFlash + qBlowO + qBlowW + qBlk - qBpv - qPsvU) * h;
      uo[0] += (suA * dmpO - poA) * h; uo[1] += (suB * dmpO - poB) * h;
      uw[0] += (suA * dmpW - pwA) * h; uw[1] += (suB * dmpW - pwB) * h;
    } else X.n_u += (qBlk - qBpv - qPsvU) * h;
    tanks[0].Vo += giO * sgA * h; tanks[0].Vw += giW * sgA * h; tanks[1].Vo += giO * sgB * h; tanks[1].Vw += giW * sgB * h;
    tanks[0].Vo -= drO0 * h; tanks[0].Vw -= drW0 * h; tanks[1].Vo -= drO1 * h; tanks[1].Vw -= drW1 * h;
    if (X.n_s < 0) X.n_s = 0; if (X.Vo1 < 0) X.Vo1 = 0; if (X.Vw1 < 0) X.Vw1 = 0; if (X.Vo2 < 0) X.Vo2 = 0; if (X.Vw2 < 0) X.Vw2 = 0;
    if (X.n_u < 0) X.n_u = 0;
    for (i = 0; i < 2; i++) { if (uo[i] < 0) uo[i] = 0; if (uw[i] < 0) uw[i] = 0; }
    for (i = 0; i < 2; i++) { if (tanks[i].Vo < 0) tanks[i].Vo = 0; if (tanks[i].Vw < 0) tanks[i].Vw = 0; }
    // overfill: separator liquid above 0.98·Vvessel → flare, top phase first
    var VLt = X.Vw1 + X.Vo1 * X.Bs + X.Vw2 + X.Vo2 * X.Bs, lim = 0.98 * Vves;
    if (VLt > lim) {
      var ex = VLt - lim, take;
      take = mmin(ex, X.Vo1 * X.Bs); X.Vo1 -= take / X.Bs; cum.ltfOil += take / X.Bs; ex -= take;
      take = mmin(ex, X.Vo2 * X.Bs); X.Vo2 -= take / X.Bs; cum.ltfOil += take / X.Bs; ex -= take;
      take = mmin(ex, X.Vw1); X.Vw1 -= take; cum.ltfWater += take; ex -= take;
      take = mmin(ex, X.Vw2); X.Vw2 -= take; cum.ltfWater += take;
    }
    // surge compartment overfill: over the centre baffle into the other compartment (top phase first), then to flare
    var limK = 0.98 * capK;
    for (i = 0; i < 2; i++) {
      var VlK = uo[i] * X.Bu + uw[i];
      if (!(VlK > limK)) continue;
      var exu = VlK - limK, j2 = 1 - i, room = mmax(0, limK - (uo[j2] * X.Bu + uw[j2])), mv = mmin(exu, room), tk2;
      exu -= mv;
      tk2 = mmin(mv, uo[i] * X.Bu); uo[i] -= tk2 / X.Bu; uo[j2] += tk2 / X.Bu; mv -= tk2;
      tk2 = mmin(mv, uw[i]); uw[i] -= tk2; uw[j2] += tk2; exu += mv - tk2;
      tk2 = mmin(exu, uo[i] * X.Bu); uo[i] -= tk2 / X.Bu; cum.ltfOil += tk2 / X.Bu; exu -= tk2;
      tk2 = mmin(exu, uw[i]); uw[i] -= tk2; cum.ltfWater += tk2;
    }
    for (i = 0; i < 2; i++) {
      var bgi = tankBo(i), vli = tanks[i].Vo * bgi + tanks[i].Vw;
      if (vli > capG) {
        var exg = vli - capG, tg = mmin(exg, tanks[i].Vo * bgi);
        tanks[i].Vo -= tg / bgi; cum.spillOil += tg / bgi; exg -= tg;
        tg = mmin(exg, tanks[i].Vw); tanks[i].Vw -= tg; cum.spillWater += tg;
      }
    }
    if (rSurge2) surge2Step(h);                  // T-202 vessel, gas side and LCV-202 (WP-E2)

    // 7 accumulators (base units: scf, STB, bbl)
    cum.oilIn += qInO * h; cum.waterIn += qInW * h; cum.gasIn += qInG * h;
    // v1.5.0 (WP-E2, §6.2): V-101 out to a production line → the line totals; V-101 + FS-401 out → relief / vent gas to vent
    if (bypLine || ventOn) bypAccount(h, byG, byO, byW, qPcv + qPsv + qBpv + qPsvU + qFl2);
    else {
      cum.flare += (qPcv + qPsv + qBpv + qPsvU + byG + qFl2) * h;
      cum.ltfOil += byO * h; cum.ltfWater += byW * h;                  // bypassed well liquids burnt at the flare / burner
    }
    cum.sepGas += qPcv * h;
    cum.flash += (qFlash + qF2) * h; cum.gaugeFlash += gvent * h; cum.gaugeVent += (gvent + gblow) * h;
    cum.gaugeOil += giO * h; cum.gaugeWater += giW * h;
    cum.gaugeOilT[0] += giO * sgA * h; cum.gaugeOilT[1] += giO * sgB * h; cum.gaugeWaterT[0] += giW * sgA * h; cum.gaugeWaterT[1] += giW * sgB * h;
    if (rGauge) { cum.sepGasT[0] += qPcv * sgA * h; cum.sepGasT[1] += qPcv * sgB * h; }
    cum.drainedOil += (drO0 + drO1 + exO) * h; cum.drainedWater += (drW0 + drW1 + exW) * h;

    // 6 algebraic P + exact-exponential filters
    var VB0 = VB;
    // ESD travel slew
    X.esdTravel = trNew; lcvO.x = xOnew; lcvW.x = xWnew;
    upos[0] = uA_n; upos[1] = uB_n; gpos[0] = gA_n; gpos[1] = gB_n;
    if (N.on) {
      var aG = mexp(-h / N.tau), aW = mexp(-h / N.whpTau), sg = msqrt(1 - aG * aG);
      X.xiG = aG * X.xiG + sg * randn(); X.xiL = aG * X.xiL + sg * randn(); X.xiW = aW * X.xiW + msqrt(1 - aW * aW) * randn();
    }
    var aF = 1 - mexp(-h / Rr.tauFlow);
    if (cushOn) cushStep(h, aF);                    // v1.5.0 (WP-E2, §6.3): the cushion's rate targets and its delivered-water lag
    else if (rDes) {                                // DS-101 in: inflow scaled by the choke capacity coupling (§4.6; local copies, qgE/qoE/qwE untouched)
      var sCk = DX.s;
      X.qBg += (qgE * sCk - X.qBg) * aF; X.qBo += (qoE * sCk - X.qBo) * aF; X.qBw += (qwE * sCk - X.qBw) * aF;
    } else { X.qBg += (qgE - X.qBg) * aF; X.qBo += (qoE - X.qBo) * aF; X.qBw += (qwE - X.qBw) * aF; }
    var fEn = clamp(X.esdTravel / 0.25, 0, 1);
    var mgn = N.on ? mmax(0, 1 + N.gasSigma * X.xiG) : 1, fTgt;
    if (qgD > 0) { X.f = fEn * X.qBg / qgD; fTgt = fEn * mgn * X.qBg / qgD; }
    else if (qoD + qwD > 0) { X.f = fEn * (X.qBo + X.qBw) / (qoD + qwD); fTgt = fEn * X.ml * (X.qBo + X.qBw) / (qoD + qwD); }
    else { X.f = 0; fTgt = 0; }
    X.fInst += (fTgt - X.fInst) * (1 - mexp(-h / N.fInstTau));
    if (fEn > 0.01) { X.tFlow += h; shut = false; }
    else { if (!shut) { shut = true; X.tShut = 0; X.P0shut = X.Pwh; } X.tShut += h; }
    if (!shut) {
      var tgtW = Pwh_ss * (1 + (N.on ? N.whpSigma * X.xiW : 0)) - Rr.drawdownFrac * Pwh_ss * mlog(1 + X.tFlow / 600) / LN10;
      if (cushOn) tgtW = cushWhp(tgtW);              // v1.5.0 (WP-E2, §6.3): the column law while a cushion flows (blends to tgtW)
      X.Pwh += (tgtW - X.Pwh) * (1 - mexp(-h / Rr.drawdownTau));
    } else {
      // the entered SITHP (desander.sithp_psig) is the well's shut-in pressure; blank = the legacy sithpFactor × WHP estimate
      var SIT = DD.sitEst === false ? DD.sit : Rr.sithpFactor * Pwh_ss;
      X.Pwh = SIT - (SIT - X.P0shut) / (1 + X.tShut / Rr.buildupTau);
    }
    var PBt = fEn > 0.01 ? X.Pwh - (Pwh_ss - Pci_ss) * X.fInst * X.fInst : pDown();
    if (rDes) DX.PBu += (PBt - DX.PBu) * (1 - mexp(-h / 5));   // DS-101 in: the same law upstream of it (= ESD node); desStep sets X.PB = PBu − PD
    else X.PB += (PBt - X.PB) * (1 - mexp(-h / 5));
    if (rDes || sandOn) desStep(h, fEn);           // DS-101 ΔP, sand capture, accumulator / dump sequence (WP-E1)
    if (CK2.act || X.ck2dP !== 0) ck2Step(h);      // v1.5.0 CK-102 ΔP lag (WP-E1, §5.3; decays to exactly 0 after it leaves)
    var thT = (X.f > 0.05 || (cushOn && cushS.qNow > 0)) ? 1 : 0;   // v1.5.0 (D8): an unloading cushion keeps H-101 warming
    X.theta += (thT - X.theta) * (1 - mexp(-h / (thT > X.theta ? Rr.warmTau : Rr.coolTau)));
    // meters (EMA τ 600 s)
    var aM = 1 - mexp(-h / 600);
    X.emaOil += (oO + wO - X.emaOil) * aM; X.emaWater += (oW + wW - X.emaWater) * aM; X.emaGas += (qPcv - X.emaGas) * aM; X.emaFlash += (qFlash + qF2 - X.emaFlash) * aM;
    // temperatures (exact exponential mixing + ambient loss)
    // per-compartment surge temperatures: each mixes its share of the separator liquids (Tsep) with ambient loss;
    // Tu (flash, Bo, gas space) is their volume-weighted mean. Baffle overflow carries no enthalpy (small, rare).
    var qInU = rSurge ? dmpO * X.Bs + dmpW : 0, vKs = 0, vTs = 0;
    if (rSurge2) qInU *= F2.s1;                    // T-201's share (WP-E2)
    for (i = 0; i < 2; i++) {
      var vK = uo[i] * X.Bu + uw[i];
      Tuk[i] = mixT(Tuk[i], qInU * (i ? suB : suA) / mmax(vK, 0.5), X.Tsep, h);
      vKs += vK; vTs += vK * Tuk[i];
    }
    X.Tu = vKs > 1e-9 ? vTs / vKs : mixT(X.Tu, 0, X.Tsep, h);
    var gFill = giO * giB + giW;
    for (i = 0; i < 2; i++) {
      var qi = gFill * (i ? sgB : sgA);
      tanks[i].T = mixT(tanks[i].T, qi / mmax(tankVliq(i), 1), giT, h);
      if (tanks[i].win) { tanks[i].win.Tint += tanks[i].T * h; tanks[i].win.tInt += h; }
    }
    algebraic();

    // bookkeeping for tau / event location
    F.inG = sInG; F.inO = sInO; F.inW = sInW; F.pcv = qPcv; F.pcvCap = qCapPcv; F.psv = qPsv; F.blk = qBlk; F.blowO = qBlowO; F.blowW = qBlowW;
    F.weirO = weirO; F.weirW = weirW; F.oO = oO; F.oW = oW; F.wW = wW; F.wO = wO; F.bpv = qBpv; F.bpvCap = qCapBpv; F.psvU = qPsvU;
    F.flash = qFlash; F.pumpBpd = pumpBpd; F.po = po; F.pw = pw; F.gvent = gvent + gblow; F.drO[0] = drO0; F.drO[1] = drO1; F.drW[0] = drW0; F.drW[1] = drW1;
    F.qOver = qOver; F.phiC = phiC;
    F.byG = byG; F.byO = byO; F.byW = byW; F.gFill = gFill; F.exO = exO; F.exW = exW; F.xdP = xdP; F.xCmd = xCmd ? 1 : 0; F.xsg = XF.sg;
    F.drTot = (drO0 + drW0 + drO1 + drW1) > 0 ? drO0 * tankBo(0) + drW0 + drO1 * tankBo(1) + drW1 : 0;
    F.rB = ((X.Vw2 + X.Vo2 * X.Bs) - VB0) / h; F.rW1 = (X.Vw1 - VW0) / h; F.rU = (suctionV() - VS0) / h;
    F.rUk[0] = (compVliq(0) - VuA0) / h; F.rUk[1] = (compVliq(1) - VuB0) / h;
    F.rG[0] = (tankVliq(0) - VG0a) / h; F.rG[1] = (tankVliq(1) - VG0b) / h;
    F.poK[0] = poA; F.poK[1] = poB; F.pwK[0] = pwA; F.pwK[1] = pwB;
    F.inU[0] = suA * qInU; F.inU[1] = suB * qInU; F.fillG[0] = sgA; F.fillG[1] = sgB;
    X.t += h;
    valveEnds();                                   // limit switches at the end-of-step positions (fill windows, holds)
    if (rSurge2) surge2Ends();                    // XV-202 limit switch, make-before-break closes (WP-E2)
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
  var CHS = { h: 0, te: 0 };
  function chooseH(rem) {
    var c = cfg, h = mmin(rem, c.hMax);
    var tg = X.n_s / mmax(F.inG, F.pcvCap * mmax(X.upcv, 0.02), F.psv, F.blowO + F.blowW, 1e-9);
    if (0.3 * tg < h) h = 0.3 * tg;
    var tu = X.n_u / mmax(F.flash + F.blowO + F.blowW + F.blk, F.bpvCap * mmax(X.ubpv, 0.02), F.psvU, 1e-9);
    if (0.3 * tu < h) h = 0.3 * tu;
    var Hw = X.hL1 - mmax(hWeir, X.h2), tw = 8;
    if (F.qOver > 0 && Hw > 0) { var As = xW * 2 * msqrt(mmax(0, X.hL1 * (D - X.hL1))); tw = As / (1.5 * F.qOver * BBL / Hw); }
    if (0.5 * tw < h) h = 0.5 * tw;
    // event location
    var te = Infinity, VB = X.Vw2 + X.Vo2 * X.Bs, x;
    if (cfg.sep.oil.mode !== 'pi') {
      if (lcvO.cmd < 0.5 && F.rB > 1e-12) { x = (VB_hi - VB) / F.rB; if (x >= 0 && x < te) te = x; }
      if (lcvO.cmd > 0.5 && F.rB < -1e-12) { x = (VB_lo - VB) / F.rB; if (x >= 0 && x < te) te = x; }
    }
    if (cfg.sep.water.mode !== 'pi') {
      if (lcvW.cmd < 0.5 && F.rW1 > 1e-12) { x = (VW_hi - X.Vw1) / F.rW1; if (x >= 0 && x < te) te = x; }
      if (lcvW.cmd > 0.5 && F.rW1 < -1e-12) { x = (VW_lo - X.Vw1) / F.rW1; if (x >= 0 && x < te) te = x; }
    }
    var VS = suctionV(), capS = suctionCap();
    if (!pumpOn && F.rU > 1e-12) { x = (c.surge.lsh * capS - VS) / F.rU; if (x >= 0 && x < te) te = x; }
    if (pumpOn && F.rU < -1e-12) { x = (c.surge.lsl * capS - VS) / F.rU; if (x >= 0 && x < te) te = x; }
    if (gv[active] && tanks[1 - active].state === 'ready' && F.rG[active] > 1e-12) { x = (c.gauge.switchFrac * capG - tankVliq(active)) / F.rG[active]; if (x >= 0 && x < te) te = x; }
    for (var k = 0; k < 2; k++) {                   // auto-divert set points on the filling compartments
      if (ctl.surge.auto && uv[k] && F.rUk[k] > 1e-12) { x = (ctl.surge.sp * capK - compVliq(k)) / F.rUk[k]; if (x >= 0 && x < te) te = x; }
      if (ctl.gauge.auto && gv[k] && F.rG[k] > 1e-12) { x = (ctl.gauge.sp * capG - tankVliq(k)) / F.rG[k]; if (x >= 0 && x < te) te = x; }
    }
    for (var i = 0; i < 2; i++) {
      if (tanks[i].state === 'draining') { var r = F.drO[i] * tankBo(i) + F.drW[i]; if (r > 1e-12) { x = (tankVliq(i) - c.gauge.heelFrac * capG) / r; if (x >= 0 && x < te) te = x; } }
      if (tanks[i].state === 'settling') { x = c.gauge.settleS - (X.t - tanks[i].since); if (x >= 0 && x < te) te = x; }
    }
    if (valveAct()) for (i = 0; i < 2; i++) {        // divert valve limit switches (end of travel: fill windows close, holds release)
      var dU = mabs(vTarget('surge', i) - upos[i]), dG = mabs(vTarget('gauge', i) - gpos[i]);
      if (dU > 0 && ctl.surge.strokeS > 0) { x = dU * ctl.surge.strokeS; if (x < te) te = x; }
      if (dG > 0 && ctl.gauge.strokeS > 0) { x = dG * ctl.gauge.strokeS; if (x < te) te = x; }
    }
    if (rDes || sandOn || rSurge2 || cushOn) {   // v1.4.0 / v1.5.0: step caps and event location of the optional items (CHS = {h, te})
      CHS.h = h; CHS.te = te;
      if (rDes || sandOn) desChooseH(CHS);
      if (rSurge2) surge2ChooseH(CHS);
      if (cushOn) cushChooseH(CHS);              // cushion breakthrough located on the delivered volume (WP-E2)
      h = CHS.h; te = CHS.te;
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
    inputs: { Pwh: 0, Twh: 0, Qg: 0, Qo: 0, Qw: 0, SGg: 0, API: 0, bean: 0, Cd: 0, bypass: false, Psep: 0, Thtr: 0,
      bean2: null, ck2Pos: null },                // v1.5.0: CK-102 bean / position from the flow block (none → null, NULLABLE)
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
      gauge: { tag: TAGS.gauge, P: 0, T: 0 },
      // v1.4.0 (appended: desander = index 8, surge2 = index 9). DS-101 out: P = Pin = choke inlet, dP 0
      desander: { tag: TAGS.desander, P: 0, Pin: 0, dP: 0, T: 0, Tout: 0, Tacc: 0, th: 0, hyd: false },
      surge2: { P: 0, T: 0 },
      // v1.5.0 (appended: heaterChoke = index 10; §5.4). Not in line: P = Pin = the CK-101 outlet, dTjt 0, regime / limiter ''
      heaterChoke: { tag: TAGS.heaterChoke, inRig: false, active: false, bypassed: false, P: 0, Pin: 0, T: 0, Tin: 0, th: 0, hyd: false, dTjt: 0,
        regime: '', bean: 0, pos: 'inlet', flowLimited: false, limiter: '', QmaxMMscfd: 0, designP_psig: 1440, note: '' }
    },
    segs: [],
    lines: {
      wh_esd: line('MMSCFD', 'multi', 0), esd_choke: line('MMSCFD', 'multi', 0), choke_heater: line('MMSCFD', 'multi', 0), heater_sep: line('MMSCFD', 'multi', 0),
      sep_flare: line('MMSCFD', 'gas', 0), sep_water: line('BPD', 'water', 3.068), sep_oil: line('BPD', 'oil', 3.068),
      surge_gauge: line('BPD', 'liquid', 3.068), surge_vent: line('MMSCFD', 'gas', 2.067), blanket: line('MMSCFD', 'gas', 1.049),
      gauge_drain: line('BPD', 'liquid', 3.068), gauge_vent: line('MMSCFD', 'gas', 0), psv_sep: line('MMSCFD', 'gas', 2.067), psv_surge: line('MMSCFD', 'gas', 1.049),
      // v1.4.0 (appended): T-202 dump branch, LCV-202 transfer, PCV-203 vent, PCV-204 blanket, PSV-202 relief; XV-103 sand dump
      sep_surge2: line('BPD', 'liquid', 3.068), surge2_gauge: line('BPD', 'liquid', 3.068), surge2_vent: line('MMSCFD', 'gas', 2.067),
      blanket2: line('MMSCFD', 'gas', 1.049), psv_surge2: line('MMSCFD', 'gas', 1.049), ds_dump: line('LB/D', 'sand', 2.067)
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
      // surge outlet transfer LCV-201 (no pump: driven by the vessel pressure). Also published as surge.transfer;
      // 'pump' is the legacy key of v3.0 (on / tripped / blocked / q_bpd keep their meaning for the transfer)
      pump: { tag: TAGS.xfer, on: false, tripped: false, failed: false, blocked: false, q_bpd: 0, design_bpd: 0, suction: 'both',
        trip: null, tripMsg: '', canReset: false, resetBlock: '', starved: false, T: 0,
        mode: 'pressure', x: 0, dP_psi: 0, dPdesign_psi: 0, Cv: 0, sg: 0, lowDP: false, dest: 'gauge', inRig: true }, lsll: 0, lsl: 0, lsh: 0, lshh: 0,
      comps: [], suction: 'both', blocked: false, auto: { on: false, sp: 0, hyst: 0 }, strokeS: 0 },
    gauge: { tag: TAGS.gauge, active: 0, count: 2, tanks: [], batches: [], blocked: false, auto: { on: false, sp: 0, hyst: 0 }, strokeS: 0,
      allowInterrupt: false, lshhReset: 0,
      // P-201 transfer pump downstream of the gauge tank (gauge tank → export / burner); mode 'gravity' without P-201
      pump: { tag: TAGS.pump, inRig: true, mode: 'pump', on: false, failed: false, q_bpd: 0, design_bpd: 0, dest: 'export' } },
    // rig-up: effective items (esd / choke always true), explanatory notes, signature ('1' per RIG_KEYS item in line)
    // full = every core item in; extras = optional items in (sig: 11 characters, RIG_KEYS order)
    rigup: { esd: true, choke: true, heater: true, separator: true, surge: true, gauge: true, pump: true, flare: true, desander: false, surge2: false,
      heaterChoke: false, full: true, sig: '11111111000', notes: [], extras: [], refused: '', v: 0 },
    cum: { oilIn_stb: 0, waterIn_bbl: 0, gasIn_mmscf: 0, flare_mmscf: 0, flash_mscf: 0, gaugeFlash_mscf: 0, gaugeVent_mscf: 0, vacBreak_scf: 0,
      gaugeOil_stb: 0, gaugeWater_bbl: 0, drainedOil_stb: 0, drainedWater_bbl: 0,
      liquidToFlareOil_stb: 0, liquidToFlareWater_bbl: 0, spillOil_stb: 0, spillWater_bbl: 0,
      // v1.5.0 (§6.2): whole stream to the production line (V-101 out, dest 'line'), relief / vent gas to vent (FS-401 out too)
      toLine_gas_mscf: 0, toLine_oil_stb: 0, toLine_water_bbl: 0, toVent_gas_mscf: 0 },
    rates: { gas_mmscfd: 0, oil_stbd: 0, water_bpd: 0, oilMeter_stbd: 0, waterMeter_bpd: 0, gor_scf_stb: null, bsw_pct: null, tank_stbd: null, shrink_pct: null,
      separated: true },
    alarms: [], alarmLog: [],
    faults: {},
    health: { substeps: 0, lagging: false, droppedSimSec: 0, massErr: { oil: 0, water: 0, gas: 0, sand: 0 }, flowInvalid: false, dumpCycles: { oil: 0, water: 0 } },
    // ── v1.4.0 optional items (always present; static values while the item is out / sand is off; §6.4) ──
    desander: { tag: TAGS.desander, inRig: false, bypass: false, bypassTag: TAGS.dsBypass, Pin: 0, Pout: 0, dP_psi: 0, dPclean_psi: 0, dPexp_psi: 0,
      dPdesign_psi: 0, T: 0, Tout: 0, vIn_fts: 0, rate: 'none', gvf: 0, rhoMix: 0, carrier: 'liquid', mu_cp: 0, d50c_um: 0, eff: 0, effClean: 0,
      sand: { in_lbd: 0, capt_lbd: 0, out_lbd: 0, acc_lb: 0, acc_frac: 0, cap_lb: 0, buf_lb: 0, buf_frac: 0, bufCap_lb: 0, lah: 0, lahh: 0 },
      dump: { tag: TAGS.dsDump, phase: 'idle', heldFrom: '', phaseT_s: 0, left_s: 0, open: false, Pacc: 0, count: 0, lastT: null, failed: false, failMsg: '' },
      auto: { on: false, sp: 0, blocked: false }, rating_psi: 0, sithp_psi: 0, sithpEst: true, ratingOK: true, tempMax_F: 0, tempOK: true },
    sand: { on: false, pptb: 0, lbPerMMscf: 0, d50_um: 0, sigmaG: 0, in_lbd: 0, toChoke_lbd: 0,
      flowback: { on: false, W0_lbph: 0, tau_h: 0, t_h: 0, d50_um: 0, sigmaG: 0 },
      choke: { Up_fts: 0, C2: 0, erosion_mpy: 0, erosion_mild: 0, band: 'none', warn_mild: 0, high_mild: 0, loss_mil: 0 },
      sep: { lb: 0, ft3: 0, frac: 0 },
      cum: { in_lb: 0, capt_lb: 0, toChoke_lb: 0, toSep_lb: 0, toFlare_lb: 0, dumped_lb: 0 } },
    surge2: { tag: TAGS.surge2, inRig: false, P: 0, SP: 0, SPeff: 0, T: 0, psh: 0, pshh: 0, mawp: 0, cap_bbl: 0, D: 0, H: 0, h: 0, frac: 0, hW: 0, fracW: 0,
      Vo_bbl: 0, Vo_stb: 0, Vw_bbl: 0, flash_mscfd: 0, tFull_s: null, valveTag: TAGS.xvSurge2, inlet: false, pos: 0, moving: false, fill_bpd: 0,
      route: 'surge', share: 0, Ph: 0, auto: { on: false, sp: 0, hyst: 0 }, strokeS: 0,
      bpv: { tag: TAGS.bpv2, u: 0 }, blanket: { tag: TAGS.blanket2, u: 0, held: false }, psv: { tag: TAGS.psvSurge2, lifting: false, Cv: 0 },
      transfer: { tag: TAGS.xfer2, on: false, tripped: false, failed: false, blocked: false, q_bpd: 0, design_bpd: 0, x: 0, dP_psi: 0, dPdesign_psi: 0,
        Cv: 0, sg: 0, lowDP: false, dest: 'gauge', trip: null, canReset: false, resetBlock: '' },
      lsll: 0, lsl: 0, lsh: 0, lshh: 0 },
    // ── v1.5.0 (always present; static values while not in use; §6.2, §6.3) ──
    // V-101-out destination: dest, the production-line pressure, the destination inlet P0, V-101 out (active), FS-401 out too (vent)
    sepBy: { dest: 'flare', P_psig: 150, P0_psig: 5, active: false, vent: false, note: '' },
    // cushion unload (off: zeros, phase 'off', tBreak null)
    cushion: { on: false, phase: 'off', V_bbl: 0, SG: 0, q_set_bpd: 0, q_bpd: 0, qcap_bpd: 0, WHPtgt_psig: 0, column_ft: 0, Vleft_bbl: 0,
      recovered_bbl: 0, fUnload: 0, wJT: 0, dutyCapped: false, tBreak: null, out: { flare: 0, line: 0, sep: 0 } }
  };
  for (var si = 0; si < 6; si++) snap.segs.push({ id: '', from: '', to: '', label: '', phase: 'multi', nps: '', sch: '', ID: 0, L: 0, vel: 0, ve: 0, vPct: 0, vSt: 'OK',
    dP: 0, P0: 0, Pout: 0, T0: 0, Tout: 0, hydR: false, flowing: false });
  for (var ti = 0; ti < 2; ti++) snap.gauge.tanks.push({ tag: ti ? TAGS.gaugeB : TAGS.gaugeA, D: 0, H: 0, cap_bbl: 0, h: 0, frac: 0, hW: 0, fracW: 0,
    Vo_bbl: 0, Vo_stb: 0, Vw_bbl: 0, T: 0, state: 'ready', stateSince: 0, inlet: false, drain_bpd: 0, switchFrac: 0, lahh: 0, fill_bpd: 0,
    valveTag: ti ? TAGS.xvGaugeB : TAGS.xvGaugeA, pos: 0, moving: false, hold: false, hh: false, avail: false });
  for (var ci = 0; ci < 2; ci++) snap.surge.comps.push({ tag: ci ? TAGS.surgeB : TAGS.surgeA, valveTag: ci ? TAGS.xvSurgeB : TAGS.xvSurgeA, cap_bbl: 0,
    h: 0, frac: 0, hW: 0, fracW: 0, Vo_bbl: 0, Vo_stb: 0, Vw_bbl: 0, inlet: false, suction: false, fill_bpd: 0, draw_bpd: 0, T: 0, pos: 0, moving: false, hold: false });
  FAULT_IDS.forEach(function (k) { snap.faults[k] = false; });
  snap.surge.transfer = snap.surge.pump;

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
      var m = s.label + ': velocity ' + uq(s.vel, 'velocity') + ' is ' + rnd0(s.vPct) + '% of limit ' + uq(s.ve, 'velocity', 0);
      if (on && !A.active) raise(A, s.vPct, sev === 'alarm' ? 100 : 80, m);
      else if (on) { A.value = s.vPct; }
      else if (!on && A.active) clearA(A);
    }
    var hn = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'desander'];   // desander: static hyd false while DS-101 is out
    for (i = 0; i < hn.length; i++) {
      var nd = snap.nodes[hn[i]];
      A = aDef('HYD_' + hn[i], TAGS[hn[i]], 'hyd', hn[i], 'd');
      var Tv = hn[i] === 'desander' ? nd.Tout : nd.T;             // desander: judged on its outlet temperature (after its own J-T drop)
      if (nd.hyd && !A.active) raise(A, Tv, nd.th, NAMES[hn[i]] + ': ' + uq(Tv, 'temperature') + ' below hydrate ' + uq(nd.th, 'temperature') + ' at ' + uq(nd.P, 'pressureG'));
      else if (nd.hyd) { A.value = Tv; A.limit = nd.th; }
      else if (A.active) clearA(A);
    }
    if (CK2.act) ck2Alarms();                      // v1.5.0 (WP-E1, §5.5): CHOKE2_LIMIT, CK1_SUBCRIT, PAH_CK2, HYD_heaterChoke
    A = aDef('CHOKE_LIMIT', TAGS.choke, 'alarm', 'choke', 'd');
    var flLim = rDes ? (chk.flowLimited || DS.flowLim) : chk.flowLimited;   // DS-101 in: the dynamic flag of the capacity coupling (§4.6)
    if (CK2.act && AL.CHOKE2_LIMIT && AL.CHOKE2_LIMIT.active) flLim = false;  // v1.5.0: CHOKE_LIMIT is suppressed while CHOKE2_LIMIT is raised
    if (flLim && !A.active) raise(A, Qg, chk.QmaxMMscfd, chk.flowLimited ? 'CK-101 flow-limited — bean ' + bean + '/64″ passes ' + uq(chk.QmaxMMscfd, 'gasRate', 2) + ' of ' + uq(Qg, 'gasRate', 2) + ' requested'
      : 'CK-101 flow-limited — ' + TAGS.desander + ' ΔP ' + uq(DX.PD, 'pressure') + ' lowers the choke inlet below what the rate needs');
    else if (!flLim && A.active) clearA(A);
  }

  function refresh() {
    var S = cfg.sep, U = cfg.surge, Gc = cfg.gauge, I = flow.inputs;
    var s = snap, i;
    s.t = X.t; s.clock = fmtClock(X.t); s.speed = speed; s.running = running; s.mode = mode;
    s.flowSeq = flowSeq; s.flowTs = flowTs; s.geomVersion = geomVersion; s.f = X.f; s.fInst = X.fInst;
    var si = s.inputs; si.Pwh = I.Pwh; si.Twh = I.Twh; si.Qg = I.Qg; si.Qo = I.Qo; si.Qw = I.Qw; si.SGg = I.SGg; si.API = I.API;
    si.bean = I.bean; si.Cd = I.Cd; si.bypass = !!I.bypass; si.Psep = I.Psep; si.Thtr = I.Thtr;
    s.fluid.API = API; s.fluid.SGo = SGo; s.fluid.SGg = SGg;
    // nodes
    var th = X.theta, N = s.nodes, P;
    N.wellhead.P = X.Pwh; N.wellhead.T = Tamb + (Twh_ss - Tamb) * th; hydOf(N.wellhead);
    N.esd.P = rDes ? DX.PBu : X.PB; N.esd.T = Tamb + (Tesd_ss - Tamb) * th; hydOf(N.esd);
    var fi2 = X.fInst * X.fInst, Pdn = pDown();
    P = pckLive(Pdn, fi2);                          // CK-101 outlet (v1.5.0: the CK-102 law while it is in line / its lag runs)
    N.choke.P = P; N.choke.Pin = X.PB; N.choke.T = Tamb + (Tck_ss - Tamb) * th; hydOf(N.choke);
    N.choke.regime = X.f < 0.01 ? 'No Flow' : chk.regime; N.choke.bean = bean; N.choke.flowLimited = rDes ? (chk.flowLimited || DS.flowLim) : chk.flowLimited; N.choke.QmaxMMscfd = chk.QmaxMMscfd;
    N.choke.dTjt = X.f < 0.01 ? 0 : mmin(150, 0.07 * (cushOn ? cushS.wJTe : chk.wJT) * mmax(X.PB - P, 0));   // cushion: blended J-T weight (D8)
    N.heater.P = Pdn + (Ph_ss - Psep_ss) * fi2; N.heater.T = Tamb + (Th_ss - Tamb) * th; N.heater.Tin = Tamb + (Tin_ss - Tamb) * th;
    hydOf(N.heater); N.heater.bypass = bypass; N.heater.dutyMMBtuHr = duty_ss * X.f;
    N.heater.firing = bypass ? 0 : (duty_ss > 0 ? clamp(X.f, 0, 1) : 0.15);
    // v1.5.0 CK-102 (§5.4): static values while not in line (P = Pin = the CK-101 outlet); WP-E1 fills the live ones
    var nk = N.heaterChoke, kb = SEL.ck2blk !== null ? SEL.ck2blk : ck2BlockOf();
    nk.inRig = rCk2; nk.active = false; nk.bypassed = rCk2 && bypass;
    nk.P = P; nk.Pin = P; nk.T = N.choke.T; nk.Tin = N.choke.T; nk.th = N.choke.th; nk.hyd = false; nk.dTjt = 0;
    nk.regime = ''; nk.bean = kb ? num(kb.bean, 0) : 0; nk.pos = kb && kb.pos === 'midcoil' ? 'midcoil' : 'inlet';
    nk.flowLimited = false; nk.limiter = ''; nk.QmaxMMscfd = 0; nk.designP_psig = num(cfg.heaterChoke.designP_psig, 1440);
    nk.note = ck2Act && SEL.ck2Note ? SEL.ck2Note : '';
    si.bean2 = kb ? num(kb.bean, null) : null; si.ck2Pos = kb ? (kb.pos === 'midcoil' ? 'midcoil' : 'inlet') : null;
    if (CK2.act || X.ck2dP !== 0) ck2Refresh(s);    // WP-E1: live CK-102 node (Pm, J-T per stage, hydrate) and the choke dTjt
    N.separator.P = X.Psep; N.separator.T = X.Tsep; hydOf(N.separator);
    // seg 4 carries the separator gas, or (V-101 bypassed) the whole well stream, to the flare / burner
    var fg = qgE > 0 ? clamp((F.pcv + F.byG) / qgE, 0, 2) : 0;
    var qFl = F.pcv + F.psv + F.bpv + F.psvU + F.byG;
    if (rSurge2) qFl += F2.bpv + F2.psv;           // PCV-203 + PSV-202 to the flare header (WP-E2)
    N.flare.P = S.pcv.P2_psig; N.flare.Pline = rSep ? X.Psep - SS[4].dP * fg * fg : S.pcv.P2_psig; N.flare.T = Tamb + (Tfl_ss - Tamb) * th;
    N.flare.qMMscfd = qFl * 0.0864; N.flare.flame = rFlare ? clamp(msqrt(N.flare.qMMscfd / mmax(Qg, 0.01)), 0, 1.5) : 0;   // no flare: gas to the export line
    if (SEL.sepByBlk !== null) bypRefresh(s, fg);   // v1.5.0 (WP-E2, §6.2): V-101 out with a flow.sepBy block — line P, flame, label
    N.surge.P = X.Pu; N.surge.T = X.Tu;
    N.gauge.P = 0; N.gauge.T = tanks[active].T;
    // segments
    var pumpVel = liqVel(F.pumpBpd + (rSurge2 ? F2.xBpd : 0), SS[5].ID);   // segs[5]: LCV-201 + LCV-202 (WP-E2)
    var nodeP0 = [X.Pwh, N.esd.P, N.choke.P, N.heater.P, rSep ? X.Psep : Pdn, X.Pu], nodeT0 = [N.wellhead.T, N.esd.T, N.choke.T, N.heater.T, X.Tsep, X.Tu];
    var nodeT1 = [N.esd.T, N.choke.T, N.heater.T, X.Tsep, N.flare.T, tanks[active].T];
    for (i = 0; i < 6; i++) {
      var ss = SS[i], o = s.segs[i];
      o.id = ss.id; o.from = ss.from; o.to = ss.to; o.label = ss.label; o.phase = ss.phase; o.nps = ss.nps; o.sch = ss.sch; o.ID = ss.ID; o.L = ss.L;
      var vel = i < 4 ? ss.vel * X.fInst : (i === 4 ? ss.vel * fg : pumpVel);
      if (cushOn && i < 5) vel += cushVel(i, ss);    // v1.5.0 (WP-E2, D8): the cushion liquid's own velocity term
      o.vel = vel; o.ve = ss.ve;
      o.vPct = ss.ve > 0 ? vel / ss.ve * 100 : 0;
      o.vSt = vel > ss.ve ? 'EXCEED' : (vel > 0.8 * ss.ve ? 'WARNING' : 'OK');
      var dP;
      if (i === 5) { var Dft = ss.ID / 12; dP = (Dft > 0 && ss.L > 0) ? ss.ff * (ss.L / Dft) * ss.rhom * vel * vel / (2 * 32.174 * 144) : 0; }
      else dP = ss.vel > 1e-9 ? ss.dP * (vel / ss.vel) * (vel / ss.vel) : 0;
      o.dP = dP;
      o.P0 = nodeP0[i];
      o.Pout = i === 1 ? X.PB - dP : (i === 4 ? N.flare.Pline : mmax(o.P0 - dP, 0));
      if (i === 1) o.Pout = mmax(o.Pout, 0);
      o.T0 = nodeT0[i]; o.Tout = nodeT1[i];
      o.hydR = ss.phase !== 'liquid' && o.T0 < Thyd(mmax(o.P0 + PSC, 15));
      o.flowing = vel > 0.01;
    }
    // lines
    var Lx = s.lines, TR = X.Tsep + RANK, TRu = X.Tu + RANK;
    var qMM = Qg * X.fInst, esdOpen = X.esdTravel > 0;
    setLine(Lx.wh_esd, qMM, Qg * limFac, s.segs[0].vel, SS[0].ID, true);
    setLine(Lx.esd_choke, qMM, Qg * limFac, s.segs[1].vel, SS[1].ID, esdOpen);
    setLine(Lx.choke_heater, qMM, Qg * limFac, s.segs[2].vel, SS[2].ID, esdOpen);
    setLine(Lx.heater_sep, qMM, Qg * limFac, s.segs[3].vel, SS[3].ID, esdOpen);
    setLine(Lx.sep_flare, (F.pcv + F.byG) * 0.0864, qgE * 0.0864, rSep ? gasVel(F.pcv, X.PsepA, TR, X.Zs, SS[4].ID) : s.segs[4].vel, SS[4].ID, X.upcv > 0 || F.byG > 0);
    var qwl = (F.wW + F.wO * X.Bs) * 86400, qol = (F.oO * X.Bs + F.oW) * 86400;
    setLine(Lx.sep_water, qwl, qwE * 86400, liqVel(qwl, 3.068), 3.068, lcvW.x > 0);
    setLine(Lx.sep_oil, qol, qoE * X.Bs * 86400, liqVel(qol, 3.068), 3.068, lcvO.x > 0);
    setLine(Lx.surge_gauge, F.pumpBpd, pumpDesign, pumpVel, SS[5].ID, F.pumpBpd > 0); Lx.surge_gauge.tank = active;
    setLine(Lx.surge_vent, F.bpv * 0.0864, qFlashD * 0.0864, gasVel(F.bpv, X.PuA, TRu, X.Zu, 2.067), 2.067, X.ubpv > 0);
    setLine(Lx.blanket, F.blk * 0.0864, pumpDesign / 86400 * BBL * 0.0864, gasVel(F.blk, X.PsepA, TR, X.Zs, 1.049), 1.049, X.ublk > 0);
    var dk = tanks[0].state === 'draining' ? 0 : (tanks[1].state === 'draining' ? 1 : (1 - active));
    var qd = (F.drO[dk] * tankBo(dk) + F.drW[dk]) * 86400;
    setLine(Lx.gauge_drain, qd, drainBpd, liqVel(qd, 3.068), 3.068, tanks[dk].state === 'draining'); Lx.gauge_drain.tank = dk;
    setLine(Lx.gauge_vent, F.gvent * 0.0864, qoE * RsE(PspU + PSC, Tsep_ss) * 0.0864, 0, 0, true);
    setLine(Lx.psv_sep, F.psv * 0.0864, gq(Cv_psv, X.mawpE + PSC, PSC + S.pcv.P2_psig, TR, X.Zs) * 0.0864, 0, 2.067, psvLift);
    setLine(Lx.psv_surge, F.psvU * 0.0864, gq(Cv_psvU, X.mawpU + PSC, PSC + S.pcv.P2_psig, TRu, X.Zu) * 0.0864, 0, 1.049, psvULift);
    // separator
    var sp = s.sep;
    sp.D = D; sp.R = R; sp.Lss = Lss; sp.xWeir = xW; sp.hWeir = hWeir; sp.xWeirFrac = xW / Lss; sp.hWeirFrac = hWeir / D; sp.headDepth = D / 4; sp.vol_bbl = Vves;
    sp.P = X.Psep; sp.SP = SP; sp.SPeff = X.SPe; sp.T = X.Tsep; sp.psh = X.psh; sp.pshh = X.pshh; sp.psl = X.psl; sp.mawp = X.mawpE; sp.lahhTotal = S.lahhTotal;
    sp.pcv.u = X.upcv; sp.pcv.Cv = Cv_pcv; sp.psv.lifting = psvLift;
    sp.c1.hW = X.hW1; sp.c1.hL = X.hL1; sp.c1.fracW = X.hW1 / D; sp.c1.fracL = X.hL1 / D; sp.c1.Vw_bbl = X.Vw1; sp.c1.Vo_bbl = X.Vo1 * X.Bs; sp.c1.Vo_stb = X.Vo1;
    sp.bucket.hW = X.hW2; sp.bucket.h = X.h2; sp.bucket.fracW = X.hW2 / D; sp.bucket.frac = X.h2 / D; sp.bucket.Vw_bbl = X.Vw2; sp.bucket.Vo_bbl = X.Vo2 * X.Bs; sp.bucket.Vo_stb = X.Vo2;
    var Hw = X.hL1 - mmax(hWeir, X.h2);
    sp.overWeir_bpd = F.qOver * 86400; sp.weirHead_in = mmax(Hw, 0) * 12; sp.carryOver = F.phiC > 0; sp.blowby = (F.blowO + F.blowW) > 0;
    sp.gasVol_ft3 = X.Vg; sp.gas_scf = X.n_s;
    dumpSnap(sp.oilDump, lcvO, S.oil, qol, Cv_o); dumpSnap(sp.waterDump, lcvW, S.water, qwl, Cv_w);
    sp.gasIn_mmscfd = F.inG * 0.0864; sp.gasOut_mmscfd = (F.pcv + F.psv + F.blk + F.blowO + F.blowW) * 0.0864;
    var liqIn = (F.inO * X.Bs + F.inW) * 86400; sp.liqIn_bpd = liqIn;
    sp.tRes_min = mmin(9999, (X.Vw1 + X.Vo1 * X.Bs + X.Vw2 + X.Vo2 * X.Bs) / mmax(liqIn / 1440, 1e-9));
    // surge
    var su = s.surge;
    su.D = Du; su.H = Hu; su.cap_bbl = capU; su.P = X.Pu; su.SP = PspU; su.SPeff = X.SPeu; su.T = X.Tu; su.psh = X.pshU; su.pshh = X.pshhU; su.mawp = X.mawpU;
    su.h = X.hU; su.frac = X.hU / Hu; su.hW = X.Vwu * BBL / Atu; su.fracW = su.hW / Hu; su.Vo_bbl = X.Vou * X.Bu; su.Vo_stb = X.Vou; su.Vw_bbl = X.Vwu;
    su.flash_mscfd = F.flash * 86.4; su.gas_scf = X.n_u;
    var tF = null;
    for (i = 0; i < 2; i++) {
      var cp = su.comps[i], vk = compVliq(i), drw = F.poK[i] * X.Bu + F.pwK[i], netK = F.inU[i] - drw;
      cp.cap_bbl = capK; cp.frac = vk / capK; cp.h = cp.frac * Hu; cp.fracW = uw[i] / capK; cp.hW = cp.fracW * Hu;
      cp.Vo_bbl = uo[i] * X.Bu; cp.Vo_stb = uo[i]; cp.Vw_bbl = uw[i]; cp.inlet = !!uv[i]; cp.suction = sucSel(i);
      cp.fill_bpd = F.inU[i] * 86400; cp.draw_bpd = drw * 86400;
      cp.T = Tuk[i]; cp.pos = upos[i]; cp.moving = moving('surge', i); cp.hold = hold.surge[i];
      if (netK > 1e-9) { var tk0 = mmax(0, (U.lshh * capK - vk) / netK); if (tF === null || tk0 < tF) tF = tk0; }
    }
    su.tFull_s = tF;
    su.suction = ctl.surge.suction; su.blocked = !uv[0] && !uv[1]; su.auto.on = ctl.surge.auto; su.auto.sp = ctl.surge.sp; su.auto.hyst = ctl.surge.hyst;
    su.bpv.u = X.ubpv; su.blanket.u = X.ublk; su.psv.lifting = psvULift;
    pumpTrip = pumpLatched();
    // LCV-201 (legacy key surge.pump = surge.transfer): on = open on level control and passing
    var xp = su.pump;
    xp.on = rSurge && pumpOn && !pumpTrip && !pumpBlocked && !faults.xferStuckClosed; xp.tripped = pumpTrip; xp.failed = !!faults.xferStuckClosed;
    xp.q_bpd = F.pumpBpd; xp.design_bpd = pumpDesign; xp.blocked = rSurge && pumpBlocked; xp.suction = ctl.surge.suction;
    if (!F.xCmd) { F.xdP = xferDP(); F.xsg = XF.sg; }   // shut: the ΔP LCV-201 would see now
    xp.x = F.xCmd; xp.dP_psi = F.xdP; xp.dPdesign_psi = dPxD; xp.Cv = Cv_x; xp.sg = F.xsg; xp.lowDP = !!(AL.XFER_LOW_DP && AL.XFER_LOW_DP.active);
    xp.dest = rGauge ? 'gauge' : 'export'; xp.inRig = rSurge;
    var ptId = ptrip.LSHH_GT ? 'LSHH_GT' : ptrip.PUMP_DRYRUN ? 'PUMP_DRYRUN' : null, ptA = ptId ? AL[ptId] : null, rb = ptId ? tripBlock(ptId) : null;
    su.pump.trip = ptId; su.pump.tripMsg = ptA ? ptA.msg : ''; su.pump.canReset = !!ptId && !rb; su.pump.resetBlock = rb || '';
    su.pump.starved = !!(AL.PUMP_STARVED && AL.PUMP_STARVED.active); su.pump.T = X.Tpump; su.strokeS = ctl.surge.strokeS;
    su.lsll = U.lsll; su.lsl = U.lsl; su.lsh = U.lsh; su.lshh = U.lshh;
    // gauge
    var g = s.gauge; g.active = active; g.count = 2;
    g.blocked = pumpBlocked; g.auto.on = ctl.gauge.auto; g.auto.sp = ctl.gauge.sp; g.auto.hyst = ctl.gauge.hyst;
    g.strokeS = ctl.gauge.strokeS; g.allowInterrupt = !!ctl.gauge.allowInterrupt; g.lshhReset = num(Gc.lshhReset, 0.9);
    for (i = 0; i < 2; i++) {
      var tk = tanks[i], o2 = g.tanks[i], bg = tankBo(i), vl = tk.Vo * bg + tk.Vw;
      o2.tag = tk.tag; o2.D = Dg; o2.H = Hg; o2.cap_bbl = capG; o2.frac = vl / capG; o2.h = o2.frac * Hg; o2.hW = tk.Vw * BBL / Atg; o2.fracW = o2.hW / Hg;
      o2.Vo_bbl = tk.Vo * bg; o2.Vo_stb = tk.Vo; o2.Vw_bbl = tk.Vw; o2.T = tk.T; o2.state = tk.state; o2.stateSince = tk.since;
      o2.inlet = !!gv[i]; o2.drain_bpd = (F.drO[i] * bg + F.drW[i]) * 86400; o2.switchFrac = Gc.switchFrac; o2.lahh = Gc.lahh;
      o2.fill_bpd = F.gFill * F.fillG[i] * 86400;
      o2.pos = gpos[i]; o2.moving = moving('gauge', i); o2.hold = hold.gauge[i]; o2.hh = hhK[i] && !!ptrip.LSHH_GT; o2.avail = gaugeAvail(i);
    }
    var gp = g.pump;
    gp.inRig = rPump && rGauge; gp.mode = !rGauge ? 'none' : rPump ? 'pump' : 'gravity'; gp.failed = rPump && !!faults.surgePumpFail;
    gp.q_bpd = F.drTot * 86400; gp.on = rPump && rGauge && F.drTot > 1e-9; gp.design_bpd = drainBpd;
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
    var r = s.rates, oilM = X.emaOil * 86400, watM = X.emaWater * 86400;
    r.gas_mmscfd = X.emaGas * 0.0864; r.oil_stbd = oilM; r.water_bpd = watM; r.oilMeter_stbd = oilM; r.waterMeter_bpd = watM;
    r.gor_scf_stb = oilM >= 0.1 ? (X.emaGas + X.emaFlash) * 86400 / oilM : null;
    r.bsw_pct = (oilM + watM) >= 0.1 ? watM / (oilM + watM) * 100 : null;
    r.tank_stbd = batches.length ? batches[batches.length - 1].oilRate_stbd : null;
    r.shrink_pct = cum.gaugeOil > 1 ? (1 - BoR(PSC, tanks[active].T) / (rSurge ? (cum.xo2 > 0 ? boXfer() : BoR(X.PuA, X.Tu)) : BoR(X.PsepA, X.Tsep))) * 100 : null;
    r.separated = rSep;                           // V-101 bypassed: no meter rates, GOR or BS&W (the zeros are not measurements)
    // rig-up
    var ru = s.rigup;
    if (ru.v !== rigVersion) {
      for (i = 0; i < RIG_KEYS.length; i++) ru[RIG_KEYS[i]] = RG.rig[RIG_KEYS[i]];
      ru.full = RG.full; ru.sig = RG.sig; ru.notes = RG.notes.slice(); ru.extras = RG.extras.slice(); ru.v = rigVersion;
    }
    ru.refused = rigRefused ? rigRefusedNow() : '';
    // v1.4.0 optional items: snapshot blocks (static values while out; WP-E1 / WP-E2 fill the live ones)
    desRefresh(s); surge2Refresh(s);
    fuRefresh(s);                                 // v1.5.0 blocks: sepBy, cushion, the line / vent totals (static while not in use)
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
      for (i = 0; i < alarmOrder.length; i++) { A = AL[alarmOrder[i]]; if (A.sev === 'trip' && A.id !== 'ESD_TRIPPED' && !A.act) blocking.push(A.id); }   // acting (non-ESD) trips do not hold the ESD
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
    e.travel = X.esdTravel; e.open = X.esdTravel >= 0.999; e.moving = esdS.tripped ? X.esdTravel > 1e-9 : X.esdTravel < 0.999;
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
    var rc = rigRenorm('flow');                    // v1.5.0 (§3.3): a destination change on the page path re-normalises first
    var keep = derive();
    if (keep) geometryChanged(keep);
    algebraic(); bumpless(cvP, cvB);
    if (rc) valveEnds();
  }
  function geometryChanged(keep) {
    applyFractions(keep);
    algebraic();
    geomVersion++;
    setRef();
    emit('geometry', { type: 'geometry', t: X.t, geomVersion: geomVersion });
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
      var rc = rigRenorm('configuration');         // v1.5.0 (§3.3): cfg.sep.bypass changed → re-normalise before derive()
      var keep = derive();
      if (keep) geometryChanged(keep);
      if (H && mmax(2, cfg.histLen | 0) !== H.n) histReset();
      algebraic(); bumpless(cvP, cvB);
      if (rc) valveEnds();
      if (cfg.speeds.indexOf(speed) < 0) speed = cfg.speeds[0];
    }),
    reset: mut(function (m) {
      initState(m === 'empty' ? 'empty' : 'steady');
      emit('reset', { type: 'reset', t: X.t, mode: mode });
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
      esdS.causeMsg = 'Closed manually at T+' + fmtClock(X.t) + ((reason && reason !== 'manual') ? ' — ' + String(reason) : '');
      esdS.tripT = X.t;
      var A = aDef('ESD_MANUAL', TAGS.esd, 'info', 'esd', 'x');
      if (!A.active) raise(A, null, null, esdS.causeMsg);
      emit('trip', { type: 'trip', t: X.t, cause: 'ESD_MANUAL', tag: TAGS.esd, msg: esdS.causeMsg, value: null, limit: null, manual: true });
      logEntry('trip', 'ESD_MANUAL', 'info', TAGS.esd, esdS.causeMsg);
    }),
    resetESD: mut(function () {
      var b = blockingNow();
      if (!esdS.tripped) return { ok: true, blocking: [] };
      if (b.length) return { ok: false, blocking: b };
      esdS.tripped = false; esdS.manual = false; esdS.cause = null; esdS.causeMsg = ''; esdS.tripT = null;
      if (AL.ESD_TRIPPED) clearA(AL.ESD_TRIPPED);
      if (AL.ESD_MANUAL) clearA(AL.ESD_MANUAL);
      X.tFlow = 0; X.graceUntil = X.t + cfg.startupGrace;
      emit('esdReset', { type: 'esdReset', t: X.t });
      logEntry('reset', 'ESD', null, TAGS.esd, 'ESD reset — reopening' + (rSep && rSurge && !uv[0] && !uv[1] ? ' · ' + TAGS.xvSurgeA + '/B still shut: open a T-201 inlet to restore the separator dump route'
        : rSep && !rSurge && rGauge && !gv[0] && !gv[1] ? ' · ' + TAGS.xvGaugeA + '/B still shut: open a T-301 inlet to restore the separator dump route' : ''));
      return { ok: true, blocking: [] };
    }, function () { var b = blockingNow(); return { ok: !esdS.tripped || b.length === 0, blocking: b }; }),
    setFault: mut(function (id, on) {
      if (FAULT_IDS.indexOf(id) < 0) return;
      on = !!on;
      if (faults[id] === on) return;
      faults[id] = on;
      emit('fault', { type: 'fault', t: X.t, id: id, on: on });
      logEntry('fault', id, null, '', FAULT_LABELS[id] + (on ? ' ON' : ' OFF'));
      desFault(id, on);                           // sand flow-back clock / sand-off release (WP-E1)
    }),
    switchGaugeTank: mut(function (force) {
      var b = 1 - active;
      if (tanks[b].state !== 'ready') {
        if (force) { logEntry('event', 'SWITCH', null, TAGS.gauge, 'Standby compartment not ready'); emit('event', { type: 'event', t: X.t, msg: 'Standby compartment not ready', tag: TAGS.gauge }); }
        return false;
      }
      if (!force && tankVliq(active) < cfg.gauge.switchFrac * capG) return false;
      doSwitch(!!force);
      return true;
    }, function () { return tanks[1 - active].state === 'ready'; }),
    // ── divert valves, pump suction, auto-divert (operator lineup; kept across reset) ──
    setValve: mut(function (eq, idx, open) { return setValveNow(eq, idx, open, false); }),
    setSuction: mut(function (which) {
      if (SUCTIONS.indexOf(which) < 0 || ctl.surge.suction === which) return false;
      ctl.surge.suction = which;
      var msg = TAGS.xfer + ' suction → ' + (which === 'both' ? TAGS.surgeA + ' + ' + TAGS.surgeB : sideTag('surge', which === 'B' ? 1 : 0));
      logEntry('event', 'SUCTION', null, TAGS.xfer, msg); noteControl('surge', 'suction', false, msg);
      return true;
    }),
    setAutoDivert: mut(function (eq, on, o) { return setAutoNow(eq, on, o); }),
    // divert valve stroke time (s, 0-60) per tank; gauge: allow auto-divert to interrupt a settling / draining batch
    setValveOptions: mut(function (eq, o) { return setOptsNow(eq, o); }),
    // reset a latched LCV-201 transfer trip ('LSHH_GT' | 'PUMP_DRYRUN'; none = every latched one) once its permissive is met
    resetTrip: mut(function (id) { return resetTripNow(id); }, function (id) { return tripPeek(id); }),
    getControls: function () { var c = deepClone(ctl); c.v = 1; return c; },
    // rig-up: which equipment is in the spread (RIG_KEYS; false = out). Partial updates; null restores an item.
    // Kept across reset(). Returns true when the requested rig-up changed.
    setRigup: mut(function (partial) { return setRigNow(partial); }),
    // all 11 RIG_KEYS as booleans (the request; D2: a missing key took the item's default)
    getRigup: function () { var o = {}; for (var i = 0; i < RIG_KEYS.length; i++) o[RIG_KEYS[i]] = rigReq[RIG_KEYS[i]] === true; return o; },
    // ── v1.4.0 optional items (WP-E1 / WP-E2 fill the bodies in their sections) ──
    // dumpDesander(cmd): 'start' (default) | 'resume' | 'abort' → {ok, msg}; setDesander({bypass, auto:{on, sp}}) → bool;
    // setSurgeRoute('surge' | 'surge2' | 'both') → {ok, msg}
    dumpDesander: mut(function (cmd) { return desDump(cmd); }),
    setDesander: mut(function (o) { return desSet(o); }),
    setSurgeRoute: mut(function (mode) { return surge2Route(mode); }),
    // ── v1.5.0 cushion-unload scenario (WP-E2 fills the bodies; docs/SIM-FOLLOWUP-PLAN.md §6.3) ──
    // startCushion(o) → {ok, msg, warn}; stopCushion() → bool; getCushion() → a copy of snap.cushion
    startCushion: mut(function (o) { return cushStart(o); }),
    stopCushion: mut(function () { return cushStop(); }),
    getCushion: function () { return deepClone(snap.cushion); },
    setControls: mut(function (c, o) {
      if (!isPlainObj(c)) return false;
      var initial = !!(o && o.initial) && X.t < 1e-9;
      var su = isPlainObj(c.surge) ? c.surge : {}, ga = isPlainObj(c.gauge) ? c.gauge : {};
      if (initial) {                             // just created / reset: rebuild t = 0 around the saved lineup, no events
        if (Array.isArray(su.inlet) && su.inlet.length === 2) { uv[0] = !!su.inlet[0]; uv[1] = !!su.inlet[1]; }
        if (Array.isArray(ga.inlet) && ga.inlet.length === 2) { gv[0] = !!ga.inlet[0]; gv[1] = !!ga.inlet[1]; }
        if (SUCTIONS.indexOf(su.suction) >= 0) ctl.surge.suction = su.suction;
        autoFields(ctl.surge, su, 'surge'); autoFields(ctl.gauge, ga, 'gauge'); optFields(ctl.surge, su); optFields(ctl.gauge, ga);
        // v1.4.0 keys are optional (old prefs without them keep the defaults)
        if (isPlainObj(c.surge2)) surge2Ctl(c.surge2, true);
        if (isPlainObj(c.desander)) desCtl(c.desander, true);
        initState(mode);
        return true;
      }
      var k;
      if (Array.isArray(su.inlet) && su.inlet.length === 2) { for (k = 0; k < 2; k++) if (su.inlet[k]) setValveNow('surge', k, true, false); for (k = 0; k < 2; k++) if (!su.inlet[k]) setValveNow('surge', k, false, false); }
      if (Array.isArray(ga.inlet) && ga.inlet.length === 2) { for (k = 0; k < 2; k++) if (ga.inlet[k]) setValveNow('gauge', k, true, false); for (k = 0; k < 2; k++) if (!ga.inlet[k]) setValveNow('gauge', k, false, false); }
      if (SUCTIONS.indexOf(su.suction) >= 0) ctl.surge.suction = su.suction;
      if (typeof su.auto === 'boolean' || isNum(su.sp) || isNum(su.hyst)) setAutoNow('surge', typeof su.auto === 'boolean' ? su.auto : ctl.surge.auto, su);
      if (typeof ga.auto === 'boolean' || isNum(ga.sp) || isNum(ga.hyst)) setAutoNow('gauge', typeof ga.auto === 'boolean' ? ga.auto : ctl.gauge.auto, ga);
      setOptsNow('surge', su); setOptsNow('gauge', ga);
      if (isPlainObj(c.surge2)) surge2Ctl(c.surge2, false);
      if (isPlainObj(c.desander)) desCtl(c.desander, false);
      return true;
    }),
    // formatter for alarm / log texts (fn(v, cat, dp) → string; null = imperial field units); new texts only
    setFormatter: function (fn) { fmtHook = typeof fn === 'function' ? fn : null; },
    logEvent: mut(function (msg, tag) {
      msg = String(msg == null ? '' : msg); tag = tag == null ? '' : String(tag);
      logEntry('event', 'EVENT', null, tag, msg);
      emit('event', { type: 'event', t: X.t, msg: msg, tag: tag });
    }),
    on: function (evt, fn) { if (typeof fn !== 'function') return; (handlers[evt] = handlers[evt] || []).push(fn); },
    off: function (evt, fn) { var hs = handlers[evt]; if (!hs) return; var i = hs.indexOf(fn); if (i >= 0) hs.splice(i, 1); },
    dispose: function () { if (disposed) return; disposed = true; running = false; snap.running = false; handlers = {}; evq = []; deferred = []; }
  };
  function lineupText(eq) {
    var o = eq === 'surge' ? uv : gv;
    return valveTag(eq, 0) + ' ' + (o[0] ? 'OPEN' : 'CLOSED') + ' · ' + valveTag(eq, 1) + ' ' + (o[1] ? 'OPEN' : 'CLOSED');
  }
  function setValveNow(eq, idx, open, isAuto) {
    if (eq === 'surge2') return surge2Valve(open, isAuto);      // XV-202 (WP-E2)
    idx = (idx === 1 || idx === 'B' || idx === 'b') ? 1 : 0; open = !!open;
    if (eq !== 'surge' && eq !== 'gauge') return false;
    if (open && !cmdArr(eq)[idx]) {             // open permissive: never line up into a compartment at high-high
      var why = eq === 'surge' ? (compVliq(idx) >= cfg.surge.lshh * capK - 1e-9 ? sideTag('surge', idx) + ' at LSHH-201' : '')
        : (hhK[idx] && ptrip.LSHH_GT) ? sideTag('gauge', idx) + ' tripped at LSHH-301 — reset the LSHH-301 trip first'
        : tankVliq(idx) >= cfg.gauge.lahh * capG - 1e-9 ? sideTag('gauge', idx) + ' at LSHH-301' : '';
      if (why) { logEntry('event', 'VALVE', null, valveTag(eq, idx), valveTag(eq, idx) + ' open refused — ' + why); return false; }
    }
    if (eq === 'surge') { if (!!uv[idx] === open) return false; uv[idx] = open; if (open) { hold.surge[idx] = false; snapValves(); } else armClose('surge', idx); }
    else { if (!(open ? gaugeOpen(idx) : gaugeClose(idx))) return false; snapValves(); }
    var tag = valveTag(eq, idx), msg = tag + (open ? ' opened' : ' closed') + (isAuto ? ' (auto)' : ' (manual)') + ' — ' + lineupText(eq);
    logEntry('event', 'VALVE', null, tag, msg);
    noteControl(eq, 'inlet', isAuto, msg);
    return true;
  }
  function optFields(C, src) {
    if (!isPlainObj(src)) return;
    if (isNum(src.strokeS)) C.strokeS = clamp(src.strokeS, 0, 60);
    if (C === ctl.gauge && typeof src.allowInterrupt === 'boolean') C.allowInterrupt = src.allowInterrupt;
  }
  function setOptsNow(eq, o) {
    if (eq === 'surge2') return surge2Opts(o);                 // XV-202 stroke (WP-E2)
    var C = eq === 'surge' ? ctl.surge : eq === 'gauge' ? ctl.gauge : null;
    if (!C || !isPlainObj(o)) return false;
    var s0 = C.strokeS, i0 = C.allowInterrupt;
    optFields(C, o);
    if (C.strokeS === s0 && C.allowInterrupt === i0) return false;
    snapValves();
    var msg = (eq === 'surge' ? TAGS.xvSurgeA + '/B' : TAGS.xvGaugeA + '/B') + ' stroke ' + rnd0(C.strokeS) + ' s' +
      (eq === 'gauge' ? ' · auto-divert ' + (C.allowInterrupt ? 'MAY' : 'may NOT') + ' interrupt settling/draining batches' : '');
    logEntry('event', 'VALVE_OPT', null, eq === 'surge' ? TAGS.surge : TAGS.gauge, msg);
    noteControl(eq, 'options', false, msg);
    return true;
  }
  function tripPeek(id) {
    var ids = id ? [id] : ['LSHH_GT', 'PUMP_DRYRUN', 'XFER2_DRYRUN'], b = [];
    ids.forEach(function (k) { if (ptrip[k]) { var w = tripBlock(k); if (w) b.push(k + ': ' + w); } });
    return { ok: b.length === 0, reset: [], blocking: b };
  }
  function resetTripNow(id) {
    if (id != null && !hasOwn(ptrip, id)) return { ok: false, reset: [], blocking: ['unknown trip ' + String(id)] };
    var ids = id ? [id] : ['LSHH_GT', 'PUMP_DRYRUN', 'XFER2_DRYRUN'], done = [], b = [];
    ids.forEach(function (k) {
      if (!ptrip[k]) return;
      var w = tripBlock(k);
      if (w) { b.push(k + ': ' + w); return; }
      ptrip[k] = false; if (k === 'LSHH_GT') { hhK[0] = false; hhK[1] = false; }
      if (AL[k] && AL[k].active) clearA(AL[k]);
      if (k === 'XFER2_DRYRUN') {                   // LCV-202 (WP-E2)
        var m2 = TAGS.xfer2 + ' trip reset (low-low) — ' + TAGS.xfer2 + ' back on level control';
        logEntry('reset', k, null, TAGS.xfer2, m2); noteControl('surge2', 'reset', false, m2); done.push(k); return;
      }
      var msg = xferInLine() ? TAGS.xfer + ' trip reset (' + (k === 'LSHH_GT' ? 'LSHH-301' : 'low-low') + ')' + (pumpLatched() ? '' : ' — ' + TAGS.xfer + ' back on level control')
        : 'LSHH-301 trip reset — ' + TAGS.xvGaugeA + '/B may be reopened';
      logEntry('reset', k, null, xferInLine() ? TAGS.xfer : 'LSHH-301', msg);
      emit('pumpReset', { type: 'pumpReset', t: X.t, cause: k, tag: xferInLine() ? TAGS.xfer : 'LSHH-301', msg: msg });
      noteControl(xferInLine() ? 'surge' : 'gauge', 'reset', false, msg);
      done.push(k);
    });
    if (b.length) logEntry('event', 'PUMP', null, xferInLine() ? TAGS.xfer : 'LSHH-301', (xferInLine() ? TAGS.xfer : 'LSHH-301 trip') + ' reset refused — ' + b.join('; '));
    return { ok: b.length === 0, reset: done, blocking: b };
  }
  function autoFields(C, src, eq) {
    if (!isPlainObj(src)) return;
    if (typeof src.auto === 'boolean') C.auto = src.auto;
    var hiLim = eq === 'surge' ? num(cfg.surge.lshh, 0.9) - 0.02 : num(cfg.gauge.lahh, 0.97) - 0.02;
    if (isNum(src.sp)) C.sp = clamp(src.sp, 0.3, hiLim);
    if (isNum(src.hyst)) C.hyst = clamp(src.hyst, 0.02, 0.5);
    if (C.sp > hiLim) C.sp = hiLim;
  }
  function setAutoNow(eq, on, o) {
    if (eq === 'surge2') return surge2Auto(on, o);             // T-202 auto route (WP-E2)
    var C = eq === 'surge' ? ctl.surge : eq === 'gauge' ? ctl.gauge : null;
    if (!C) return false;
    var before = JSON.stringify(C);
    var src = isPlainObj(o) ? { sp: o.sp, hyst: o.hyst } : {};
    src.auto = !!on;
    autoFields(C, src, eq);
    if (JSON.stringify(C) === before) return false;
    var msg = (eq === 'surge' ? TAGS.surge : TAGS.gauge) + ' auto-divert ' + (C.auto ? 'ON' : 'OFF') + ' (SP ' + rnd0(C.sp * 100) + '%, hysteresis ' + rnd0(C.hyst * 100) + '%)';
    logEntry('event', 'AUTO', null, eq === 'surge' ? TAGS.surge : TAGS.gauge, msg);
    noteControl(eq, 'auto', false, msg);
    return true;
  }
  var RIG_TXT = { heater: [TAGS.heater, 'bypassed', 'back in line'], separator: [TAGS.separator, 'bypassed (well stream to the burner / flare line)', 'back in line'],
    surge: [TAGS.surge, 'out of the rig-up', 'back in the rig-up'], gauge: [TAGS.gauge, 'out of the rig-up', 'back in the rig-up'],
    pump: [TAGS.pump, 'out of the rig-up', 'back in the rig-up'], flare: [TAGS.flare, 'out of the rig-up (gas to export)', 'back in the rig-up'],
    esd: [TAGS.esd, 'out', 'in'], choke: [TAGS.choke, 'out', 'in'],
    // v1.4.0 optional items (every RIG_KEYS item needs an entry: a missing one throws)
    desander: [TAGS.desander, 'out of the rig-up (well stream straight to the choke)', 'in line upstream of the choke'],
    surge2: [TAGS.surge2, 'out of the rig-up', 'in the rig-up (standby: XV-202 shut)'],
    // v1.5.0 (§3.1); the separator's destination variant for dest 'line' is built in rigParts
    heaterChoke: [TAGS.heaterChoke, 'out of the rig-up', 'in line on the H-101 inlet'] };
  // last refused rig-up change (plain text, '' when none) and the effective rig-up it asked for; the snapshot shows the note
  // (rigup.refused) only while the same change would still be refused (§3.3: 38 shows it and disables T-202's switch)
  var rigRefused = '', rigRefusedRig = null;
  function rigRefusedNow() {
    if (!rigRefused || !rigRefusedRig) return '';
    var why = desRig('check', RG.rig, rigRefusedRig, null) || surge2Rig('check', RG.rig, rigRefusedRig, null) || ck2Rig('check', RG.rig, rigRefusedRig, null);
    return why ? String(why) : '';
  }
  function setRigNow(partial) {
    if (!isPlainObj(partial)) return false;
    var req = {}, i, k, changed = false;
    for (i = 0; i < RIG_KEYS.length; i++) {
      k = RIG_KEYS[i];
      // a present key: null / undefined → the item's default (core in, optional out); otherwise the D2 rule; absent: as now
      req[k] = hasOwn(partial, k) ? (partial[k] === null || partial[k] === undefined ? RIG_DEFAULTS[k] : rigVal(partial, k)) : rigReq[k];
      if (req[k] !== rigReq[k]) changed = true;
    }
    if (!changed) return false;
    var old = RG.rig, oldSig = RG.sig;
    // an optional item may refuse the change (e.g. T-202 the only open route and T-201 unable to take the dumps): the
    // request is left as it was, the refusal is logged and setRigup returns false
    var nr = normRigup(req, rigOpt()).rig, why = desRig('check', old, nr, null) || surge2Rig('check', old, nr, null) || ck2Rig('check', old, nr, null);
    if (why) {
      rigRefused = String(why); rigRefusedRig = nr;
      logEntry('event', 'RIGUP', null, '', 'Rig-up change refused — ' + rigRefused);
      emit('event', { type: 'event', t: X.t, msg: 'Rig-up change refused — ' + rigRefused, tag: '' });
      return false;
    }
    rigRefused = ''; rigRefusedRig = null;
    setRigReq(req); applyRig();
    var r = RG.rig, parts = rigParts(old, r);
    rigSideEffects(old, r, parts);
    if (RG.sig !== oldSig) {
      var cvP = Cv_pcv, cvB = Cv_bpv;
      derive(); algebraic(); bumpless(cvP, cvB);      // heater in / out changes the steady temperatures
      valveEnds();
    }
    var msg = 'Rig-up: ' + (parts.length ? parts.join(' · ') : 'no change in line') + (RG.full ? ' (full rig-up)' : '');
    logEntry('event', 'RIGUP', null, '', msg);
    rigEmit(msg);
    return true;
  }
  // the RIG_TXT texts of the items that changed (RIG_KEYS order; the separator text follows the destination, §6.2)
  function rigParts(old, r) {
    var parts = [], i, k;
    for (i = 0; i < RIG_KEYS.length; i++) {
      k = RIG_KEYS[i];
      if (old[k] === r[k]) continue;
      if (k === 'separator' && !r[k] && bypLine) parts.push(TAGS.separator + ' bypassed (well stream to the production line at ' + fmtLineP(cfg.sep.bypass.P_psig) + ' psig through NRV-501 / XV-501)');
      else parts.push(RIG_TXT[k][0] + ' ' + RIG_TXT[k][r[k] ? 2 : 1]);
    }
    return parts;
  }
  // side effects of an effective rig-up change (setRigNow and rigRenorm share them): optional items entering / leaving (dump
  // abort, route snap, CK-102 lag / quiet list — WP-E1 / WP-E2 hooks), latch release, quiet lists of equipment that left
  function rigSideEffects(old, r, parts) {
    if (old.desander !== r.desander) desRig('apply', old, r, parts);
    if (old.surge2 !== r.surge2) surge2Rig('apply', old, r, parts);
    if (old.heaterChoke !== r.heaterChoke) ck2Rig('apply', old, r, parts);
    if (old.gauge && !r.gauge && ptrip.LSHH_GT) {      // a latched LSHH-301 on a tank that left the rig-up no longer holds the transfer
      ptrip.LSHH_GT = false; hhK[0] = hhK[1] = false;
      if (AL.LSHH_GT && AL.LSHH_GT.active) clearA(AL.LSHH_GT);
      parts.push('LSHH-301 latch released');
    }
    if (old.surge && !r.surge && ptrip.PUMP_DRYRUN) {    // likewise the LCV-201 low-low latch when T-201 (and LCV-201) leave the rig-up
      ptrip.PUMP_DRYRUN = false;
      if (AL.PUMP_DRYRUN && AL.PUMP_DRYRUN.active) clearA(AL.PUMP_DRYRUN);
      parts.push('LCV-201 low-low latch released');
    }
    if (!r.separator) quiet(Q_SEP);                  // alarms of equipment that left the rig-up clear at once
    if (!r.surge) quiet(Q_SURGE);
    if (!r.gauge) quiet(Q_GAUGE);
    if (r.separator && !old.separator) quiet(Q_SEPBY);   // v1.5.0: V-101 back in → the bypass-path alarms clear
  }
  function rigEmit(msg) {
    alarmsDirty = true;
    emit('rigup', { type: 'rigup', t: X.t, rig: deepClone(RG.rig), sig: RG.sig, full: RG.full, notes: RG.notes.slice(), extras: RG.extras.slice(), msg: msg });
  }
  // ── v1.5.0 re-normalisation on a destination change (docs/SIM-FOLLOWUP-PLAN.md §3.3, D4; WP-E0) ──
  // One routine for the three paths that change cfg.sep.bypass: setConfig, setFlow (applyFlow, before derive) and — through the
  // shared rigSideEffects / rigEmit — setRigNow. It logs the destination (event BYPASS_DEST) and re-runs normRigup with it; when
  // the effective rig-up changes (dest line → flare with V-101 and FS-401 out forces FS-401 back in) the side effects apply once
  // and a 'rigup' event fires. A notes-only change (the line pressure) refreshes the snapshot notes. Returns true when the
  // signature changed (the caller re-derives anyway; it then runs valveEnds).
  var destKey = '';
  function destKeyNow() { var b = plain(cfg.sep.bypass); return (b.dest === 'line' ? 'line' : 'flare') + '|' + num(b.P_psig, 150); }
  function rigRenorm(reason) {
    var key = destKeyNow();
    if (key === destKey) return false;
    destKey = key;
    var o = rigOpt(), dmsg = 'V-101 bypass destination: ' + (o.sepByDest === 'line' ? 'production line at ' + fmtLineP(o.P) + ' psig (NRV-501 / XV-501)' : 'burner / flare line') +
      (reason ? ' (' + reason + ')' : '');
    logEntry('event', 'BYPASS_DEST', null, TAGS.separator, dmsg);
    var nr = normRigup(rigReq, o);
    if (nr.sig === RG.sig) { if (nr.notes.join('\n') !== RG.notes.join('\n')) applyRig(); return false; }
    var old = RG.rig;
    applyRig();
    var r = RG.rig, parts = rigParts(old, r);
    rigSideEffects(old, r, parts);
    var msg = 'Rig-up: ' + (parts.length ? parts.join(' · ') : 'no change in line') + (RG.full ? ' (full rig-up)' : '') + ' — ' + dmsg;
    logEntry('event', 'RIGUP', null, '', msg);
    rigEmit(msg);
    return true;
  }
  function blockingNow() {
    var b = [];
    // trips with an act (LCV-201 / LCV-202 latches, LSHH-202 inlet close) act without an ESD and never block its reset
    for (var k in AL) { var A = AL[k]; if (A.active && A.sev === 'trip' && k !== 'ESD_TRIPPED' && !A.act) b.push(k); }
    return b.sort();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── DS-101 desander + sand (WP-E1) ───
  // docs/SIM-EQUIPMENT-PLAN.md §4. WP-E0 (foundation) left these hooks with their call sites; WP-E1 fills the bodies in this
  // section only (plus the upstream PB / node lines it owns). Guards at the call sites keep the default spread on the
  // v1.3.0 path: per-substep hooks run only when rDes || sandOn.
  //   desDerive()                 derive(), always             steady quantities, sandOn, design check (§4.2); setConfig
  //                                                            also lands here (sandOn true → false: quiet(Q_SAND))
  //   desInit()                   initState(), always          t = 0 state (accumulator, dump phase, sand clock)
  //   desStep(h, fEn)             substep, rDes || sandOn      ΔP, capture, accumulator, dump sequence (§4.3, §4.4)
  //   desAlarms()                 processAlarms, rDes || sandOn (§4.8)
  //   desRefresh(s)               refresh(), always            snap.desander / snap.sand / nodes.desander (§6.4)
  //   desChooseH(c)               chooseH, rDes || sandOn      c.h: step cap, c.te: time to the next event (§4.3)
  //   desHist(i)                  histSample, always           dsAccFrac, dsDP, sandChoke at ring index i
  //   desBalance(op, o)           'zero' (o = cum), 'ref' (o = ref), 'err' → health.massErr.sand (§4.4)
  //   desRig(phase, old, r, parts) setRigNow: 'check' → refusal text ('' = allowed); 'apply' when DS-101 enters / leaves (§3.3)
  //                               'check' must be pure: refresh re-runs it while a refusal is stored (snapshot rigup.refused)
  //   desFault(id, on)            setFault (sandFlowback clock, sand-off release)
  //   desCtl(src, initial)        setControls → ctl.desander {bypass, auto, sp}
  //   desDump(cmd) / desSet(o)    api.dumpDesander → {ok, msg} / api.setDesander → bool
  //   desInternal(o)              _internal() extension point
  // hot state (one object: V8 updates its double fields in place). PBu = pressure upstream of DS-101 (= ESD node), PD = its ΔP
  // (5 s lag, as PB), X.PB = PBu − PD = choke inlet while DS-101 is in; s = choke-capacity coupling factor (§4.6)
  var DX = { PBu: 0, PD: 0, PDraw: 0, Pacc: 0, th: 0, acc: 0, buf: 0, phaseT: 0, tSand: 0, s: 1, W: 0, capR: 0, passR: 0, dumpR: 0,
    d50c: 0, Er: 0, Ef: 0, C2pr: 0, C2pf: 0, effCleanR: 0, effCleanF: 0, eff: 0, effClean: 0, C2ch: 0, ero: 0, loss: 0, vIn: 0,
    dPexp: 0, accF0: 0, Tbleed: 0, tEv: -1 };   // tEv: end time of the substep while the dump sequence steps (event / lastT stamps)
  // discrete state: dump phase (§4.4), latches and flags
  var DS = { phase: 'idle', heldFrom: '', count: 0, lastT: null, failed: false, failMsg: '', autoBlocked: false, flowLim: false,
    bleedHyd: false, dumpAuto: false, aborted: false, flowing: false, open: false };
  // steady quantities (desDerive, §4.2) and the capture / C2 tables of the two size distributions (formation, flow-back)
  var DD = { ok: false, pptb: 0, lbm: 0, d50: 150, sg: 2, d50fb: 400, sgfb: 1.5, m: 2, Wss: 0, vss: 0, gvf: 0, rho: 0, rhoSI: 0,
    carrier: 'liquid', mu: 0, rhoC: 0, drho: 103, d50ss: 0, dPss: 0, cap: 663, bufCap: 265, bulk: 99, rating: 10000, sit: 0,
    sitEst: true, ratingOK: true, tMax: 350, tempOK: true, vtss: 0, cmix: 0, eroCoef: 0, eroN: 2.6, vMin: 10, vMax: 60, tkey: '' };
  var TB = { key: '', res: null, fb: null };
  var DUMP_TXT = { isolate: 'isolating the accumulator', bleed: 'bleeding the accumulator', flush: 'XV-103 open, flushing sand to the skip',
    equalise: 'equalising the accumulator with DS-101', reopen: 'reopening the accumulator isolation' };
  // alarm / log texts of this section (MSG and the unit table, incl. 'mass', are created above; these statements run at create time)
  MSG.DES_DP_HIGH = function (v, l) {
    var e = DX.dPexp;
    return 'PDAH-103 ' + TAGS.desander + ' ΔP ' + uq(v, 'pressure') + (e > 0 ? ' = ' + (v / e).toFixed(1) + ' × clean' : '') + ' (limit ' + uq(l, 'pressure') +
      '): plugged liner, packed accumulator or over-rate';
  };
  MSG.DES_DP_LOW = function (v, l) { return 'PDAL-103 ' + TAGS.desander + ' ΔP ' + uq(v, 'pressure') + ' ≤ ' + uq(l, 'pressure') + ': liner washed out — desander ineffective'; };
  MSG.DES_LAH = function (v, l) { return 'LAH-103 ' + TAGS.desander + ' accumulator ' + rnd(v) + '% ≥ ' + rnd(l) + '% — dump the accumulator'; };
  MSG.DES_LAHH = function (v, l) { return 'LAHH-103 ' + TAGS.desander + ' accumulator ' + rnd(v) + '% ≥ ' + rnd(l) + '% — capture falling, sand carried to the choke'; };
  MSG.DES_DUMP_FAIL = function () { return 'XV-103 ' + TAGS.desander + ' dump failed — ' + (DS.failMsg || 'see the log') + ' (auto-dump blocked)'; };
  MSG.DES_RATING = function () {
    var t = [];
    if (!DD.ratingOK) t.push(TAGS.desander + ' rating ' + uq(DD.rating, 'pressure', 0) + ' < max shut-in wellhead pressure ' + uq(DD.sit, 'pressureG', 0) +
      (DD.sitEst ? ' (SITHP estimated as ' + num(cfg.ramp.sithpFactor, 1.2) + ' × WHP)' : '') + ': rating below the maximum shut-in wellhead pressure; not fit for this well (no relief valve)');
    if (!DD.tempOK) t.push(TAGS.desander + ' wellhead temperature ' + uq(Twh_ss, 'temperature') + ' (class ' + uq(num(cfg.desander.tempMin_F, -50), 'temperature', 0) +
      ' … ' + uq(DD.tMax, 'temperature', 0) + '): well temperature outside the desander temperature class');
    return t.join(' · ');
  };
  MSG.DES_PSHH = function (v, l) { return 'PSHH-103 ' + TAGS.desander + ' inlet ' + uq(v, 'pressureG') + ' ≥ set point ' + uq(l, 'pressureG', 0) + ' (' + rnd0(num(cfg.desander.pshhFrac, 0.95) * 100) + ' % of the ' + uq(DD.rating, 'pressure', 0) + ' rating) — ' + TAGS.esd + ' (upstream of ' + TAGS.desander + ') shuts in the well'; };
  MSG.DES_RATE = function (v, l) {
    return TAGS.desander + ' inlet velocity ' + uq(v, 'velocity') + (v < l ? ' < ' + uq(l, 'velocity', 0) + ': below turndown — weak swirl' : ' > ' + uq(l, 'velocity', 0) + ': over-rate — carry-over');
  };
  MSG.HYD_dsAcc = function (v, l) { return 'DS-101A accumulator (no-flow dead leg at ambient) ' + uq(v, 'temperature') + ' below hydrate ' + uq(l, 'temperature') + ' at ' + uq(DX.Pacc, 'pressureG') + ': hydrate / plugging risk'; };
  MSG.HYD_dsBleed = function (v, l) { return 'XV-103 bleed gas ≈ ' + uq(v, 'temperature') + ' below hydrate ' + uq(l, 'temperature') + ': bleed-line hydrate / ice risk: inject methanol'; };
  MSG.SAND_CHOKE = function (v, l) { return TAGS.choke + ' sand reaching the choke ' + uq(v, 'mass') + '/d > ' + uq(l, 'mass', 0) + '/d — bean / downstream erosion'; };
  MSG.SAND_SEP = function (v, l) { return TAGS.separator + ' sand building up: ' + rnd(v) + '% of the water section below LSL (> ' + rnd(l) + '%) — jet / clean before the dumps plug'; };

  function ensureTables() {
    if (TB.key === DD.tkey && TB.res) return;
    TB.res = sandTables(DD.d50, DD.sg, DD.m, DD.rhoSI); TB.fb = sandTables(DD.d50fb, DD.sgfb, DD.m, DD.rhoSI); TB.key = DD.tkey;
  }
  function sandOff() { quiet(Q_SAND); DX.W = 0; DX.capR = 0; DX.passR = 0; DX.ero = 0; DX.C2ch = 0; }
  function desDerive() {
    var C = cfg.desander, Cs = cfg.sand, E = isPlainObj(Cs.erosion) ? Cs.erosion : {}, FB = isPlainObj(Cs.flowback) ? Cs.flowback : {};
    var fl = isPlainObj(flow.fluid) ? flow.fluid : {}, fc = isPlainObj(flow.choke) ? flow.choke : {};
    // values read here are clamped to the §6.3 ranges (setConfig, project files and Mini WellOS as well as the host form)
    DD.pptb = clamp(num(Cs.pptb, 0), 0, 500); DD.lbm = clamp(num(Cs.lbPerMMscf, 0), 0, 100); DD.d50 = clamp(num(Cs.d50_um, 150), 20, 1000);
    DD.sg = clamp(num(Cs.sigmaG, 2), 1, 5); DD.d50fb = clamp(num(FB.d50_um, 400), 20, 2000); DD.sgfb = clamp(num(FB.sigmaG, 1.5), 1, 5);
    DD.m = clamp(num(C.m, 2), 0.5, 6);
    var rt = num(C.rating_psi, 10000); DD.rating = (rt === 5000 || rt === 10000 || rt === 15000) ? rt : 10000;
    var ag = num(C.acc_gal, 50); ag = ag > 0 ? clamp(ag, 10, 200) : 50;
    var rhoS = clamp(num(C.rhoSand, 165.4), 100, 300);
    DD.bulk = rhoS * (1 - clamp(num(C.porosity, 0.4), 0, 0.9));
    DD.cap = ag * 0.133681 * DD.bulk; DD.bufCap = clamp(num(C.buf_gal, 20), 1, 200) * 0.133681 * DD.bulk;
    var sit = isNum(C.sithp_psig) ? clamp(C.sithp_psig, 100, 20000) : null;
    DD.sitEst = sit === null; DD.sit = sit === null ? num(cfg.ramp.sithpFactor, 1.2) * Pwh_ss : sit;
    DD.ratingOK = DD.rating >= DD.sit;
    DD.tMax = num(isPlainObj(C.tempMax_F) ? C.tempMax_F[DD.rating] : null, 350);
    DD.tempOK = Twh_ss >= num(C.tempMin_F, -50) && Twh_ss <= DD.tMax;
    DD.vMin = num(C.vMin_fts, 10); DD.vMax = num(C.vMax_fts, 60);
    DD.Wss = DD.pptb * (Qo + Qw) / 1000 + DD.lbm * Qg;
    var was = sandOn;
    sandOn = DD.pptb > 0 || DD.lbm > 0 || !!faults.sandFlowback;
    if (was && !sandOn) sandOff();
    // segment 1 (esd_choke) and the fluid block: inlet velocity, ΔP, carrier, cut size
    var s1 = SS[1], Ap = PI / 4 * mpow(s1.ID / 12, 2), qT = s1.vel * Ap, qLiq = Qo + Qw;
    var TF = Tesd_ss, TR = TF + RANK, Pa = mmax(Pci_ss + PSC, PSC);
    var rhoO = num(fl.rhoOil, 62.4 * SGo), rhoW = num(fl.rhoWat, 62.4), Mg = num(fl.Mg, 28.9647 * SGg);
    DD.rho = s1.rhom; DD.rhoSI = s1.rhom * 16.018463;
    // carrier blended by GVF (§4.2): liquid below gvfGasLo (0.95), gas above gvfGasHi (0.995), linear in between, so a trace
    // of liquid in a dry-gas well does not switch the cut size; with no flow area (qT 0) GVF is unknown: liquid if any liquid
    var gvf0 = qT > 0 ? clamp(1 - qLiq * BBL / 86400 / qT, 0, 1) : (qLiq >= 1e-6 ? 0 : 1);
    var gLo = clamp(num(C.gvfGasLo, 0.95), 0, 0.999), gHi = mmax(clamp(num(C.gvfGasHi, 0.995), 0, 1), gLo + 1e-6);
    var wG = qLiq > 0 ? clamp((gvf0 - gLo) / (gHi - gLo), 0, 1) : 1, mu = 0, rc = 0, fg = 1;
    if (wG < 1) { var wc = Qw / qLiq; mu = (1 - wG) * ((1 - wc) * sandMuDeadOil(API, TF) + wc * sandMuWater(TF)); rc = (1 - wG) * ((1 - wc) * rhoO + wc * rhoW); }
    if (wG > 0) { var Zd = Zf(Pa, TR); mu += wG * sandMuGas(SGg, TF, Zd, Pa); rc += wG * Pa * Mg / (Zd * 10.7316 * TR); }
    DD.carrier = wG < 0.5 ? 'liquid' : 'gas'; DD.wGas = wG; DD.mu = mu; DD.rhoC = rc; DD.drho = mmax(rhoS - rc, 1);
    var liquid = wG < 1;
    DD.eroN = num(E.n, 2.6);
    DD.eroCoef = sandErosionReducer(1, 0.3048, s1.ID * 0.0254, bean / 64 * 0.0254, null, 0, E) / 0.0254;   // mpy per lb/d at 1 ft/s, C2 = 1
    if (!isFin(DD.eroCoef)) DD.eroCoef = 0;
    if (!(qT > 0)) { DD.ok = false; DD.gvf = 0; DD.vss = 0; DD.dPss = 0; DD.d50ss = DD.d50; DD.vtss = 0; DD.cmix = 0; }
    else {
      DD.ok = true;
      DD.vss = qT / mmax(num(C.Ain_ft2, 0.0341), 1e-4);
      DD.dPss = sandDp(DD.rho, DD.vss, num(C.K_dp, 6));
      var gvf = clamp(1 - qLiq * BBL / 86400 / qT, 0, 1); DD.gvf = gvf;
      if (liquid) { var kn = clamp(num(C.gvfKnee, 0.9), 0, 0.99); fg = 1 + (1 - wG) * num(C.gvfGain, 0.5) * mpow(mmax(0, (gvf - kn) / (1 - kn)), 2); }   // ASSUMPTION; → 1 with the gas carrier
      DD.d50ss = sandCut(mu, DD.drho, DD.vss, C) * fg;
      // bean impact velocity proxy: upstream-density continuity at the bean, gas expanded to the throat pressure (isothermal),
      // capped by the homogeneous-mixture speed of sound at the throat
      var b64 = bean / 64, Ured = b64 > 0 ? s1.vel * mpow(s1.ID / b64, 2) : 0;
      var Pt = chk.regime === 'Critical' ? Pa * clamp(num(fc.rCrit, 0.55), 0.2, 0.99) : Pck_ss + PSC;
      Pt = mmin(mmax(Pt, PSC), Pa);
      var Z1 = Zf(Pa, TR), Zt = Zf(Pt, TR), phi = (Pa / Pt) * (Zt / Z1), den = (1 - gvf) + gvf * phi;
      DD.vtss = Ured * den;
      var gvft = den > 0 ? gvf * phi / den : 0, rgt = Pt * Mg / (Zt * 10.7316 * TR);
      var cg = msqrt(mmax(num(cfg.sep.pcv.k, 1.28), 1) * Zt * 1545.35 * TR / mmax(Mg, 1) * 32.174);
      DD.cmix = sandMixSound(gvft, rgt, cg, qLiq > 0 ? (Qw / qLiq) * rhoW + (1 - Qw / qLiq) * rhoO : rhoO, num(E.cL_fts, 4000));   // liquid density
      if (!isFin(DD.vtss)) DD.vtss = 0;
      if (!isFin(DD.cmix)) DD.cmix = 0;
    }
    DD.tkey = [DD.d50, DD.sg, DD.d50fb, DD.sgfb, DD.m, DD.rhoSI].join('|');
    if (rDes || sandOn) ensureTables();
  }
  // ΔP multiplier: liner faults, packed accumulator above the efficiency knee, passing bypass (10 % of the stream around it)
  function desFactor(fill) {
    var C = cfg.desander;
    return (faults.desanderPlugged ? num(C.plugFactor, 3) : 1) * (faults.desanderWashout ? num(C.washFactor, 0.3) : 1) *
      (1 + num(C.packDpGain, 10) * mmax(0, fill - num(C.effFillKnee, 0.9))) * (faults.desanderBypassPassing ? 0.81 : 1);
  }
  // cut size and capture now (fI = max(fInst, 1e-3)); a non-finite value keeps the last finite ones
  function desPerf(fI) {
    var C = cfg.desander, v = DX.vIn;
    var dc = DD.d50ss / msqrt(fI) * (v < DD.vMin ? DD.vMin / v : 1) * (1 + 2 * mmax(0, v / DD.vMax - 1));
    var d = dc * (faults.desanderWashout ? num(C.washCut, 3) : 1) * (faults.slugging ? num(C.slugCut, 1.5) : 1);
    if (!isFin(d) || !(d > 0) || !isFin(dc) || !(dc > 0)) return;
    var xr = clamp(mlog(d / DD.d50) / LN10, -3, 2), xf = clamp(mlog(d / DD.d50fb) / LN10, -3, 2);
    DX.d50c = d; DX.Er = sandInterp(TB.res.E, xr); DX.Ef = sandInterp(TB.fb.E, xf);
    DX.C2pr = sandInterp(TB.res.C2p, xr); DX.C2pf = sandInterp(TB.fb.C2p, xf);
    DX.effCleanR = sandInterp(TB.res.E, clamp(mlog(dc / DD.d50) / LN10, -3, 2));
    DX.effCleanF = sandInterp(TB.fb.E, clamp(mlog(dc / DD.d50fb) / LN10, -3, 2));
  }
  // choke capacity coupling (S, §4.6): local scale factor of the inflow law; critical gas by capacity ∝ P1 abs, otherwise √ΔP
  function desCoupling() {
    if (cfg.desander.chokeCoupling === false) { DX.s = 1; DS.flowLim = false; return; }
    var r = 1;
    if (chk.regime === 'Critical' && Qg > 0) {
      var qe = Qg * limFac;                       // the rate the inflow law carries (= Qmax when the steady calc is already flow-limited)
      r = (qe > 0 && chk.QmaxMMscfd > 0) ? chk.QmaxMMscfd * (Pci_ss - DX.PD + PSC) / (Pci_ss + PSC) / qe : 1;
    } else { var dPc = Pci_ss - Pck_ss; r = dPc > 0 ? msqrt(mmax(0, 1 - DX.PD / dPc)) : 1; }
    if (!isFin(r)) r = 1;
    DX.s = r >= 1.02 ? 1 : (r <= 0.98 ? mmax(r, 0) : (1 + r) / 2 - ((r - 1) * (r - 1) + 0.0004) / 0.08);   // C1-smooth minimum
    if (!DS.flowLim && r < 0.99) DS.flowLim = true; else if (DS.flowLim && r > 1.0) DS.flowLim = false;   // 1 % hysteresis
  }
  function desInit() {
    DS.phase = 'idle'; DS.heldFrom = ''; DS.count = 0; DS.lastT = null; DS.failed = false; DS.failMsg = ''; DS.autoBlocked = false;
    DS.flowLim = false; DS.bleedHyd = false; DS.dumpAuto = false; DS.aborted = false; DS.flowing = false; DS.open = false;
    DX.acc = 0; DX.buf = 0; DX.phaseT = 0; DX.tSand = 0; DX.s = 1; DX.W = 0; DX.capR = 0; DX.passR = 0; DX.dumpR = 0; DX.C2ch = 0;
    DX.ero = 0; DX.loss = 0; DX.accF0 = 0; DX.th = X.theta; DX.d50c = DD.d50ss; DX.eff = 0; DX.effClean = 0; DX.vIn = 0; DX.dPexp = 0;
    DX.PBu = X.PB; DX.PD = 0; DX.PDraw = 0; DX.Tbleed = 0;
    if (rDes) {
      ensureTables();
      if (mode === 'steady' && DD.ok) {           // t = 0 at steady flow: the desander ΔP is already established (no start-up transient)
        DS.flowing = true;
        DX.vIn = mmax(DD.vss * X.fInst, 0.1); DX.dPexp = DD.dPss * X.fInst * X.fInst;
        if (!ctl.desander.bypass) { DX.PDraw = DX.dPexp * desFactor(0); DX.PD = DX.PDraw; }
        X.PB = DX.PBu - DX.PD;
        desPerf(X.fInst > 1e-3 ? X.fInst : 1e-3);
        DX.effClean = DX.effCleanR; DX.eff = ctl.desander.bypass ? 0 : DX.Er;
        desCoupling();
      }
    }
    DX.Pacc = X.PB;
  }
  // per substep (§4.3, §4.4; only while DS-101 is in or sand is on)
  function desStep(h, fEn) {
    var C = cfg.desander;
    if (TB.key !== DD.tkey || !TB.res) ensureTables();
    var fI = X.fInst > 1e-3 ? X.fInst : 1e-3, flowing = fEn > 0.01 && DD.ok, byp = !!ctl.desander.bypass;
    var Wres = 0, Wfb = 0, W = 0, a = 0, capt = 0, sh = 0, iso = false, cyc = false;
    DS.flowing = flowing;
    if (rDes) {
      if (DS.phase !== 'idle' && DS.phase !== 'held' && esdS.tripped) desHold();
      var fill = DS.phase !== 'idle' ? DX.buf / DD.bufCap : DX.acc / DD.cap;
      DX.vIn = flowing ? mmax(DD.vss * X.fInst, 0.1) : 0;
      DX.dPexp = flowing ? DD.dPss * X.fInst * X.fInst : 0;
      DX.PDraw = (flowing && !byp) ? DX.dPexp * desFactor(fill) : 0;
      DX.PD += (DX.PDraw - DX.PD) * (1 - mexp(-h / 5));
      X.PB = DX.PBu - DX.PD;                      // choke inlet: a ΔP step moves only the choke inlet, smoothly
      var thT = X.f > 0.05 ? 1 : 0, wf = num(C.warmFactor, 3);
      DX.th += (thT - DX.th) * (1 - mexp(-h / (wf * (thT > DX.th ? cfg.ramp.warmTau : cfg.ramp.coolTau))));   // vessel mass: 3 × the pipe lag
      desCoupling();
      if (flowing && !byp) {
        cyc = true;
        desPerf(fI);
        a = clamp((1 - fill) / mmax(1 - num(C.effFillKnee, 0.9), 1e-6), 0, 1) * (1 - (faults.desanderBypassPassing ? num(C.bypassLeak, 0.1) : 0));
      }
      DX.tEv = X.t + h; desDumpStep(h); DX.tEv = -1;   // phase ends fall at the end of this substep
      iso = DS.phase !== 'idle';
    }
    if (sandOn && flowing) {
      var Cs = cfg.sand, FB = Cs.flowback, rx = num(Cs.rateExp, 1.5);
      Wres = DD.Wss > 0 ? DD.Wss * mpow(fI, rx) : 0;
      if (faults.sandFlowback) {
        Wfb = 24 * num(FB.W0_lbph, 200) * mexp(-DX.tSand / mmax(num(FB.tau_h, 6) * 3600, 1)) * mpow(fI < 1.5 ? fI : 1.5, rx);
        DX.tSand += h;
      }
      W = Wres + Wfb;
      var Wd = W * h / 86400;
      if (a > 0) {
        var room = iso ? mmax(0, DD.bufCap - DX.buf) : mmax(0, DD.cap - DX.acc);
        var ideal = (DX.Er * Wres + DX.Ef * Wfb) * a * h / 86400;
        capt = mmin(mmax(ideal, 0), mmin(room, Wd));
        sh = ideal - capt; if (!(sh > 0)) sh = 0;
      }
      if (!isFin(Wd) || !isFin(capt) || !isFin(sh)) { capt = 0; sh = 0; if (!isFin(Wd)) { Wd = 0; W = 0; Wres = 0; Wfb = 0; } }
      var pass = Wd - capt;
      if (iso) DX.buf += capt; else DX.acc += capt;
      cum.sandIn += Wd; cum.sandCapt += capt; cum.sandToChoke += pass;
      if (rSep) cum.sandToSep += pass; else cum.sandToFlare += pass;
      // particle-size factor of what reaches the choke: what bypasses the cyclone at the inlet C2, the fine tail it passes,
      // and any room-limited shortfall at the inlet C2 (DS-101 out or bypassed: the inlet mix)
      var c2r = TB.res.C2in, c2f = TB.fb.C2in, c2m = W > 0 ? (Wres * c2r + Wfb * c2f) / W : c2r, C2ch = c2m;
      if (cyc) {
        var nm = Wres * ((1 - a) * c2r + a * (1 - DX.Er) * DX.C2pr) + Wfb * ((1 - a) * c2f + a * (1 - DX.Ef) * DX.C2pf);
        var dn = Wres * ((1 - a) + a * (1 - DX.Er)) + Wfb * ((1 - a) + a * (1 - DX.Ef)), sr = sh * 86400 / h;
        nm += sr * c2m; dn += sr;
        C2ch = dn > 1e-12 ? nm / dn : c2m;
      }
      DX.W = W; DX.capR = capt * 86400 / h; DX.passR = pass * 86400 / h; DX.C2ch = isFin(C2ch) ? C2ch : 0;
      var Up = mmin(DD.vtss * X.fInst, DD.cmix);
      var ero = (DX.passR > 0 && Up > 0) ? DD.eroCoef * DX.passR * mpow(Up, DD.eroN) * DX.C2ch : 0;
      DX.ero = isFin(ero) ? ero : 0;
      DX.loss += DX.ero / 365.25 * h / 86400;
    } else { DX.W = 0; DX.capR = 0; DX.passR = 0; DX.ero = 0; DX.C2ch = 0; }
    if (cyc) {
      var wr = W > 0 ? Wres / W : 1, wb = W > 0 ? Wfb / W : 0;
      DX.eff = a * (DX.Er * wr + DX.Ef * wb); DX.effClean = DX.effCleanR * wr + DX.effCleanF * wb;
    } else DX.eff = 0;
  }
  // ── dump sequence (§4.4): isolate → bleed → flush → equalise → reopen, scalar accumulator pressure, two interlocks ──
  function desEmit(phase, msg, isAuto) {
    logEntry('event', 'DS_DUMP', null, TAGS.dsDump, msg);
    emit('dump', { type: 'dump', t: DX.tEv >= 0 ? DX.tEv : X.t, phase: phase, msg: msg, auto: !!isAuto });
  }
  function desStart(isAuto) {
    DS.phase = 'isolate'; DS.heldFrom = ''; DX.phaseT = 0; DS.dumpAuto = !!isAuto; DS.aborted = false; DS.bleedHyd = false; DS.open = false;
    desEmit('isolate', TAGS.desander + ' dump started: ' + DUMP_TXT.isolate + (isAuto ? ' (auto-dump at ' + rnd0(ctl.desander.sp * 100) + '%)' : ''), isAuto);
    noteControl('desander', 'dump', isAuto, TAGS.desander + ' dump started');
  }
  function desPhase(next, why) {
    var Dc = cfg.desander.dump, to = num(Dc.bleedTo_psig, 50);
    DS.phase = next; DX.phaseT = 0; DS.open = false;
    var msg = TAGS.desander + ' dump: ' + (why ? why + ' — ' : '') + DUMP_TXT[next];
    if (next === 'flush') DX.accF0 = DX.acc;
    if (next === 'bleed') {
      msg += ' to below ' + uq(to, 'pressureG', 0);
      // bleed-line hydrate check at bleed start (J-T estimate of the gas let down to the skip); held to the end of the dump
      var Td = Tamb + (Tesd_ss - Tamb) * DX.th;
      DX.Tbleed = Td - 0.07 * chk.wJT * mmax(0, X.PB - to);
      DS.bleedHyd = DX.Tbleed < Thyd(to + PSC);
    }
    desEmit(next, msg, DS.dumpAuto);
  }
  function desFail(msg) {
    DS.failed = true; DS.failMsg = msg; DS.autoBlocked = true;
    desEmit(DS.phase, TAGS.desander + ' dump failed: ' + msg, DS.dumpAuto);
  }
  function desHold() {
    DS.heldFrom = DS.phase; DS.phase = 'held'; DS.open = false;
    desEmit('held', TAGS.desander + ' dump held at ' + DS.heldFrom + ': ESD tripped — XV-103 and the bleed shut, accumulator isolated; resume or abort after the ESD reset', DS.dumpAuto);
  }
  function desFinish() {
    var mv = mmax(0, mmin(DX.buf, DD.cap - DX.acc)), ok = !DS.failed && !DS.aborted;
    DX.acc += mv; DX.buf -= mv;
    if (ok) { DS.count++; DS.lastT = DX.tEv >= 0 ? DX.tEv : X.t; }
    var how = DS.aborted ? 'aborted' : DS.failed ? 'ended without dumping (' + DS.failMsg + ')' : 'complete';
    DS.phase = 'idle'; DS.heldFrom = ''; DX.phaseT = 0; DS.bleedHyd = false; DS.open = false; DS.aborted = false; DX.Pacc = X.PB;
    desEmit('idle', TAGS.desander + ' dump ' + how + ': isolation open, ' + rnd0(mv) + ' lb moved from the buffer to the accumulator', DS.dumpAuto);
  }
  function desDumpStep(h) {
    var Dc = cfg.desander.dump, ph = DS.phase, PB = X.PB, P = DX.Pacc, to = num(Dc.bleedTo_psig, 50);
    var kI = (ph !== 'idle' && faults.desanderIsoPassing) ? 1 / mmax(num(Dc.isoPassTauS, 30), 0.1) : 0;   // upper isolation passing
    DS.open = false; DX.dumpR = 0;
    if (ph === 'idle') {
      if (!ctl.desander.bypass) DX.Pacc = PB;      // isolation open: the accumulator sits at the desander pressure
      if (ctl.desander.auto && !esdS.tripped && !DS.autoBlocked && DX.acc >= ctl.desander.sp * DD.cap - 1e-9) desStart(true);
      return;
    }
    if (ph === 'held') { if (kI > 0) DX.Pacc = PB + (P - PB) * mexp(-kI * h); return; }
    DX.phaseT += h;
    var pT = DX.phaseT;
    var kB = (ph === 'bleed' || ph === 'flush') ? 4 / mmax(num(Dc.bleedS, 300), 1) : 0;    // bleed open to the skip (τ = bleedS/4)
    var kE = ph === 'equalise' ? 4 / mmax(num(Dc.equalS, 120), 1) : 0;                     // equalising line open (τ = equalS/4)
    if (ph === 'reopen') DX.Pacc = PB;
    else { var k = kB + kE + kI; if (k > 0) { var Peq = (kE + kI) * PB / k; DX.Pacc = Peq + (P - Peq) * mexp(-k * h); } }
    if (ph === 'isolate') { if (pT >= num(Dc.isoS, 8) - 1e-9) desPhase('bleed'); }
    else if (ph === 'bleed') {
      if (pT >= num(Dc.bleedS, 300) - 1e-9 && DX.Pacc < to) desPhase('flush');          // interlock 1: flush only once bled
      else if (pT >= num(Dc.bleedTimeoutS, 600) - 1e-9) { desFail('accumulator not bled — upper isolation passing?'); desPhase('equalise', 'no flush'); }
    } else if (ph === 'flush') {
      var stuck = !!faults.desanderDumpStuck, fS = mmax(num(Dc.flushS, 600), 1);
      DS.open = !stuck && DX.Pacc < to;            // XV-103 opens only with the isolation shut and the accumulator bled
      if (DS.open) {
        var rm = pT >= fS - 1e-9 ? DX.acc : mmin(DX.acc, DX.accF0 * h / fS);
        DX.acc -= rm; cum.sandDumped += rm; DX.dumpR = rm * 86400 / h;
      }
      if (pT >= fS - 1e-9) { if (stuck) desFail('dump valve did not open'); desPhase('equalise'); }
    } else if (ph === 'equalise') {
      if (pT >= num(Dc.equalS, 120) - 1e-9 && mabs(PB - DX.Pacc) < num(Dc.equalTol_psi, 75)) desPhase('reopen');   // interlock 2
    } else if (ph === 'reopen') {
      if (pT >= num(Dc.reopenS, 8) - 1e-9) desFinish();
    }
  }
  // time to the end of the current phase (event location) and to the end of the whole sequence (snapshot left_s)
  function desPhaseLeft() {
    var Dc = cfg.desander.dump, ph = DS.phase, pT = DX.phaseT, to = num(Dc.bleedTo_psig, 50), tol = num(Dc.equalTol_psi, 75);
    if (ph === 'isolate') return num(Dc.isoS, 8) - pT;
    if (ph === 'bleed') {
      var tp = faults.desanderIsoPassing ? Infinity : (DX.Pacc > to ? num(Dc.bleedS, 300) / 4 * mlog(DX.Pacc / to) : 0);
      return mmin(mmax(num(Dc.bleedS, 300) - pT, tp), num(Dc.bleedTimeoutS, 600) - pT);
    }
    if (ph === 'flush') return num(Dc.flushS, 600) - pT;
    if (ph === 'equalise') { var d = mabs(X.PB - DX.Pacc); return mmax(num(Dc.equalS, 120) - pT, d > tol ? num(Dc.equalS, 120) / 4 * mlog(d / tol) : 0); }
    if (ph === 'reopen') return num(Dc.reopenS, 8) - pT;
    return Infinity;
  }
  function desLeft() {
    var Dc = cfg.desander.dump, ph = DS.phase, PB = mmax(X.PB, 0), to = num(Dc.bleedTo_psig, 50), tol = num(Dc.equalTol_psi, 75);
    if (ph === 'idle' || ph === 'held') return 0;
    var bS = num(Dc.bleedS, 300), eS = num(Dc.equalS, 120), fS = num(Dc.flushS, 600), rS = num(Dc.reopenS, 8);
    var bN = mmax(bS, PB > to ? bS / 4 * mlog(PB / to) : 0), eN = mmax(eS, PB > tol ? eS / 4 * mlog(PB / tol) : 0);
    var cur = mmax(0, desPhaseLeft()); if (!isFin(cur)) cur = mmax(0, num(Dc.bleedTimeoutS, 600) - DX.phaseT);
    var rest = ph === 'isolate' ? bN + fS + eN + rS : ph === 'bleed' ? fS + eN + rS : ph === 'flush' ? eN + rS : ph === 'equalise' ? rS : 0;
    return cur + rest;
  }
  function desChooseH(c) {
    if (!rDes) return;
    var x = desPhaseLeft();
    if (DS.phase === 'idle' && ctl.desander.auto && !DS.autoBlocked && DX.capR > 0) x = (ctl.desander.sp * DD.cap - DX.acc) / (DX.capR / 86400);
    if (x >= 0 && x < c.te) c.te = x;
  }
  function desAlarms() {
    var A, C = cfg.desander;
    if (rDes) {
      var fl = DS.flowing, byp = !!ctl.desander.bypass, ex = DX.dPexp, PD = DX.PD, hi = num(C.dpAlarmHi, 75), lowMin = num(C.dpLowMin, 2);
      var thr = ex >= lowMin ? mmax(num(C.dpHighRatio, 2) * ex, ex + num(C.dpHighAdd, 5)) : Infinity, lim = mmin(thr, hi);
      A = aDef('DES_DP_HIGH', 'PDAH-103', 'alarm', 'desander', 'p');
      evalA(A, fl && !byp && PD >= lim, !fl || byp || PD < 0.9 * lim, PD, lim, MSG.DES_DP_HIGH, true);
      var lo = num(C.dpLowFrac, 0.5) * ex, lowOn = fl && !byp && ex >= lowMin;
      A = aDef('DES_DP_LOW', 'PDAL-103', 'warn', 'desander', 'p');
      evalA(A, lowOn && PD < lo && DX.PDraw < lo, !lowOn || PD >= 1.1 * lo, PD, lo, MSG.DES_DP_LOW, true);
      var af = DX.acc / DD.cap, db = cfg.alarm.levelDB, lah = num(C.lah, 0.8), lahh = num(C.lahh, 0.95);
      var full = DX.acc >= DD.cap - 1e-9 && DX.buf >= DD.bufCap - 1e-9;
      A = aDef('DES_LAH', 'LAH-103', 'alarm', 'desander', 'l');
      evalA(A, af >= lah, af < lah - db, af * 100, lah * 100, MSG.DES_LAH, true);
      A = aDef('DES_LAHH', 'LAHH-103', 'alarm', 'desander', 'l');
      evalA(A, af >= lahh || full, af < lahh - db && !full, af * 100, lahh * 100, MSG.DES_LAHH, true);
      A = aDef('DES_DUMP_FAIL', TAGS.dsDump, 'alarm', 'desander', 'b');
      evalA(A, DS.failed, !DS.failed, null, null, MSG.DES_DUMP_FAIL, false);
      var bad = !DD.ratingOK || !DD.tempOK;
      A = aDef('DES_RATING', TAGS.desander, 'alarm', 'desander', 'd');
      evalA(A, bad, !bad, DD.ratingOK ? Twh_ss : DD.sit, DD.ratingOK ? DD.tMax : DD.rating, MSG.DES_RATING, false);
      // PSHH-103: the one desander trip (ESD; SDV-101 is upstream of DS-101, so the shut-in protects it)
      A = aDef('DES_PSHH', 'PSHH-103', 'trip', 'desander', 'p');
      // set at pshhFrac (0.95) × rating so the 5 s SDV-101 stroke ends below the rating; evaluated whenever SDV-101 is open
      // (not only while the design flow is valid); clears 1 % of the rating below the set point
      var pshF = clamp(num(C.pshhFrac, 0.95), 0.5, 1), pshL = pshF * DD.rating, esdOpen = X.esdTravel > 0.01;
      evalA(A, esdOpen && DX.PBu >= pshL, !esdOpen || DX.PBu < (pshF - 0.01) * DD.rating, DX.PBu, pshL, MSG.DES_PSHH, false);
      var v = DX.vIn, out = fl && !byp && (v < DD.vMin || v > DD.vMax), back = !fl || byp || (v >= 1.05 * DD.vMin && v <= 0.95 * DD.vMax);
      A = aDef('DES_RATE', TAGS.desander, 'warn', 'desander', 'b', true);   // grace: not during start-up
      evalA(A, out, back, v, v < DD.vMin ? DD.vMin : DD.vMax, MSG.DES_RATE, true);
      var thA = Thyd(mmax(DX.Pacc + PSC, 15)), hA = Tamb < thA && DX.Pacc > 10;
      A = aDef('HYD_dsAcc', 'DS-101A', 'hyd', 'desander', 'd');
      evalA(A, hA, !hA, Tamb, thA, MSG.HYD_dsAcc, true);
      A = aDef('HYD_dsBleed', TAGS.dsDump, 'hyd', 'desander', 'd');
      evalA(A, DS.bleedHyd, !DS.bleedHyd, DX.Tbleed, Thyd(num(C.dump.bleedTo_psig, 50) + PSC), MSG.HYD_dsBleed, false);
    }
    if (!sandOn) return;
    // sand reaching the choke (any rig-up): warn above 5 lb/d, alarm above 50 lb/d (10 % hysteresis on both)
    var Cs = cfg.sand, w = DX.passR, wL = num(Cs.chokeWarn_lbd, 5), aL = num(Cs.chokeAlarm_lbd, 50);
    A = aDef('SAND_CHOKE', TAGS.choke, 'warn', 'choke', 'b');
    var on = A.active ? w >= 0.9 * wL : w > wL, hiS = (A.active && A.sev === 'alarm') ? w >= 0.9 * aL : w > aL, sev = hiS ? 'alarm' : 'warn';
    if (on && A.active && A.sev !== sev) clearA(A);
    if (A.sev !== sev) { A.sev = sev; A.pub.sev = sev; alarmsDirty = true; }
    if (on && !A.active) raise(A, w, hiS ? aL : wL, MSG.SAND_CHOKE(w, hiS ? aL : wL));
    else if (on) { A.value = w; A.limit = hiS ? aL : wL; A.msg = MSG.SAND_CHOKE(w, A.limit); }
    else if (A.active) clearA(A);
    var sf = desSepFrac(), sl = num(Cs.sepWarnFrac, 0.1);
    A = aDef('SAND_SEP', TAGS.separator, 'warn', 'separator', 'l');
    evalA(A, rSep && sf >= sl, !rSep || sf < 0.95 * sl, sf * 100, sl * 100, MSG.SAND_SEP, true);
  }
  // bulk sand volume in V-101 as a fraction of the water-section volume below the water LSL
  function desSepFrac() { var v = VW_lo * BBL; return v > 1e-9 ? cum.sandToSep / mmax(DD.bulk, 1) / v : 0; }
  function desFault(id, on) {
    if (id !== 'sandFlowback') return;
    if (on) DX.tSand = 0;                          // the flow-back clock starts when the scenario is switched on
    var was = sandOn;
    sandOn = DD.pptb > 0 || DD.lbm > 0 || !!faults.sandFlowback;
    if (was && !sandOn) sandOff();
    if (sandOn) ensureTables();
  }
  // sand balance (exact identities): in = caught + to the choke; caught = accumulator + buffer + dumped; to the choke = to V-101 + to
  // the flare. Residuals below 1e−12 of the throughput are double-precision rounding and read as 0.
  function desBalance(op, o) {
    if (op === 'zero') { o.sandIn = 0; o.sandCapt = 0; o.sandToChoke = 0; o.sandToSep = 0; o.sandToFlare = 0; o.sandDumped = 0; return undefined; }
    if (op !== 'err') return undefined;
    var c = cum, r1 = c.sandIn - (c.sandCapt + c.sandToChoke), r2 = c.sandCapt - (DX.acc + DX.buf + c.sandDumped),
      r3 = c.sandToChoke - (c.sandToSep + c.sandToFlare);
    var e = mmax(mabs(r1), mabs(r2), mabs(r3)) / mmax(c.sandIn, 1);
    return isFin(e) ? (e < 1e-12 ? 0 : e) : 1;
  }
  function desRig(phase, old, r, parts) {
    if (phase !== 'apply') return '';             // 'check': DS-101 never refuses a rig-up change
    if (r.desander && !old.desander) {            // entering: the upstream law starts from the choke inlet, ΔP builds with its lag
      DX.PBu = X.PB; DX.PD = 0; DX.PDraw = 0; DX.Pacc = X.PB; DX.phaseT = 0; DX.th = X.theta; DX.s = 1;
      DS.phase = 'idle'; DS.heldFrom = ''; DS.flowLim = false; DS.open = false;
      ensureTables();
    } else if (!r.desander && old.desander) {     // leaving: abort a running or held dump (buffer → accumulator, capped), release its alarms
      if (DS.phase !== 'idle') {
        var mv = mmax(0, mmin(DX.buf, DD.cap - DX.acc));
        DX.acc += mv; DX.buf -= mv;
        DS.phase = 'idle'; DS.heldFrom = ''; DX.phaseT = 0; DS.bleedHyd = false; DS.open = false; DS.aborted = false;
        logEntry('event', 'DS_DUMP', null, TAGS.dsDump, 'dump aborted: DS-101 out of the rig-up');
        emit('dump', { type: 'dump', t: X.t, phase: 'idle', msg: 'dump aborted: DS-101 out of the rig-up', auto: false });
        parts.push(TAGS.desander + ' dump aborted');
      }
      quiet(Q_DES);
      // the ESD node is continuous (§6.4): the legacy PB law takes over from the pressure upstream of DS-101 (X.PB = PBu, not the
      // choke inlet PBu − PD) and carries it with its 5 s lag; the choke inlet loses the desander ΔP with the bypass spool (WP-I)
      X.PB = DX.PBu;
      DX.PD = 0; DX.PDraw = 0; DX.s = 1; DS.flowLim = false; DS.flowing = false;
    }
    return '';
  }
  function desDump(cmd) {
    var c = (cmd === undefined || cmd === null) ? 'start' : String(cmd), ph = DS.phase, why = '';
    if (c !== 'start' && c !== 'resume' && c !== 'abort') return { ok: false, msg: 'unknown command ' + c };
    if (!rDes) why = TAGS.desander + ' is out of the rig-up';
    else if (esdS.tripped) why = 'ESD tripped — reset the ESD first';
    else if (c === 'start' && ph !== 'idle') why = ph === 'held' ? 'a dump is held — resume or abort it' : 'a dump is already running';
    else if (c === 'resume' && ph !== 'held') why = 'no held dump to resume';
    else if (c === 'abort' && ph === 'idle') why = 'no dump to abort';
    else if (c === 'abort' && (ph === 'equalise' || ph === 'reopen')) why = 'the dump is already ' + (ph === 'equalise' ? 'equalising' : 'reopening');
    if (why) { logEntry('event', 'DS_DUMP', null, TAGS.dsDump, TAGS.desander + ' dump ' + c + ' refused — ' + why); return { ok: false, msg: why }; }
    if (c === 'start') {
      DS.failed = false; DS.failMsg = ''; DS.autoBlocked = false;   // DES_DUMP_FAIL clears and auto-dump is re-armed by a manual start
      desStart(false);
      return { ok: true, msg: TAGS.desander + ' dump started' };
    }
    if (c === 'resume') {
      var to = DS.heldFrom || 'equalise';
      // a dump held while reopening goes back to equalising with its time served, so interlock 2 (|PB − Pacc| < equalTol_psi)
      // is checked again before the upper isolation reopens: the accumulator was isolated while DS-101 moved through the ESD
      if (to === 'reopen') { to = 'equalise'; DX.phaseT = num(cfg.desander.dump.equalS, 120); }
      DS.phase = to; DS.heldFrom = '';            // the elapsed time of the interrupted phase is kept; its gates still apply
      desEmit(to, TAGS.desander + ' dump resumed: ' + DUMP_TXT[to], false);
      return { ok: true, msg: TAGS.desander + ' dump resumed (' + to + ')' };
    }
    DS.aborted = true; DS.heldFrom = '';
    desPhase('equalise', 'aborted, nothing more released');
    return { ok: true, msg: TAGS.desander + ' dump aborted: equalising, then reopening' };
  }
  function desSetNow(o, isAuto) {
    var C = ctl.desander, ch = false, msg;
    if (typeof o.bypass === 'boolean' && o.bypass !== C.bypass) {
      C.bypass = o.bypass; ch = true;
      msg = C.bypass ? TAGS.dsBypass + ' open, ' + TAGS.desander + ' blocked in (bypass line-up; it stays pressurised until bled — Dump sand bleeds it)'
        : TAGS.dsBypass + ' closed, ' + TAGS.desander + ' back in line';
      logEntry('event', 'DS_BYPASS', null, TAGS.dsBypass, msg);
      noteControl('desander', 'bypass', isAuto, msg);
    }
    var au = isPlainObj(o.auto) ? o.auto : null;
    if (au) {
      var on0 = C.auto, sp0 = C.sp;
      if (typeof au.on === 'boolean') C.auto = au.on;
      if (isNum(au.sp)) C.sp = clamp(au.sp, 0.5, 0.95);
      if (C.auto !== on0 || C.sp !== sp0) {
        ch = true;
        msg = TAGS.desander + ' auto-dump ' + (C.auto ? 'ON' : 'OFF') + ' (SP ' + rnd0(C.sp * 100) + '%; assumes an attended, interlocked dump system)';
        logEntry('event', 'AUTO', null, TAGS.desander, msg);
        noteControl('desander', 'auto', isAuto, msg);
      }
    }
    return ch;
  }
  function desSet(o) {
    if (!isPlainObj(o) || !rDes) return false;    // the bypass line-up and auto-dump are set while DS-101 is in the rig-up
    return desSetNow(o, false);
  }
  function desInternal(o) {
    o.des = { PD: DX.PD, PDraw: DX.PDraw, PBu: DX.PBu, s: DX.s, flowLim: DS.flowLim, Pacc: DX.Pacc, acc: DX.acc, buf: DX.buf,
      phase: DS.phase, phaseT: DX.phaseT, tSand: DX.tSand, dPss: DD.dPss, d50ss: DD.d50ss, vss: DD.vss, vtss: DD.vtss, cmix: DD.cmix,
      eroCoef: DD.eroCoef, Wss: DD.Wss, cap: DD.cap, bufCap: DD.bufCap, sandOn: sandOn, qE: [qgE, qoE, qwE], Pci: Pci_ss, Pck: Pck_ss,
      cum: { in: cum.sandIn, capt: cum.sandCapt, toChoke: cum.sandToChoke, toSep: cum.sandToSep, toFlare: cum.sandToFlare, dumped: cum.sandDumped } };
  }
  function desCtl(src, initial) {
    var C = ctl.desander;
    if (!initial && rDes) { desSetNow({ bypass: src.bypass, auto: { on: src.auto, sp: src.sp } }, false); return; }
    if (typeof src.bypass === 'boolean') C.bypass = src.bypass;
    if (typeof src.auto === 'boolean') C.auto = src.auto;
    if (isNum(src.sp)) C.sp = clamp(src.sp, 0.5, 0.95);
  }
  function desHist(i) {
    H.k.dsAccFrac[i] = rDes ? DX.acc / DD.cap : 0; H.k.dsDP[i] = rDes ? DX.PD : 0; H.k.sandChoke[i] = sandOn ? DX.passR : 0;
  }
  // snapshot blocks (§6.4): live while DS-101 is in / sand is on; static values otherwise (the desander follows the choke inlet X.PB)
  function desRefresh(s) {
    var d = s.desander, sd = s.sand, nd = s.nodes.desander, N = s.nodes, C = cfg.desander, Cs = cfg.sand, E = Cs.erosion, FB = Cs.flowback;
    var byp = !!ctl.desander.bypass, fl = rDes && DS.flowing, ph = DS.phase, dm = d.dump, ds = d.sand;
    d.inRig = rDes; d.bypass = byp;
    ds.acc_lb = DX.acc; ds.acc_frac = DX.acc / DD.cap; ds.cap_lb = DD.cap; ds.buf_lb = DX.buf; ds.buf_frac = DX.buf / DD.bufCap; ds.bufCap_lb = DD.bufCap;
    ds.lah = num(C.lah, 0.8); ds.lahh = num(C.lahh, 0.95);
    dm.phase = ph; dm.heldFrom = DS.heldFrom; dm.phaseT_s = ph === 'idle' ? 0 : DX.phaseT; dm.left_s = desLeft(); dm.open = DS.open && ph === 'flush';
    dm.count = DS.count; dm.lastT = DS.lastT; dm.failed = DS.failed; dm.failMsg = DS.failMsg;
    d.auto.on = !!ctl.desander.auto; d.auto.sp = ctl.desander.sp; d.auto.blocked = DS.autoBlocked;
    d.rating_psi = DD.rating; d.sithp_psi = DD.sit; d.sithpEst = DD.sitEst; d.ratingOK = DD.ratingOK; d.tempMax_F = DD.tMax; d.tempOK = DD.tempOK;
    d.carrier = DD.carrier;
    if (rDes) {
      var Tn = Tamb + (Tesd_ss - Tamb) * DX.th, To = Tn - 0.07 * chk.wJT * DX.PD;
      d.Pin = DX.PBu; d.Pout = X.PB; d.dP_psi = DX.PD; d.dPclean_psi = DD.dPss; d.dPexp_psi = DX.dPexp; d.dPdesign_psi = DD.dPss;
      d.T = Tn; d.Tout = To; d.vIn_fts = DX.vIn;
      d.rate = (!fl || byp) ? 'none' : (DX.vIn < DD.vMin ? 'low' : (DX.vIn > DD.vMax ? 'high' : 'ok'));
      d.gvf = DD.gvf; d.rhoMix = DD.rho; d.mu_cp = DD.mu; d.d50c_um = DX.d50c; d.eff = (fl && !byp) ? DX.eff : 0; d.effClean = DX.effClean;
      ds.in_lbd = DX.W; ds.capt_lbd = DX.capR; ds.out_lbd = DX.passR;
      dm.Pacc = DX.Pacc;
      nd.P = X.PB; nd.Pin = DX.PBu; nd.dP = DX.PD; nd.T = Tn; nd.Tout = To; nd.Tacc = Tamb;
      nd.th = Thyd(mmax(DX.PBu + PSC, 15)); nd.hyd = To < nd.th && DX.PBu > 10;
    } else {
      d.Pin = X.PB; d.Pout = X.PB; d.dP_psi = 0; d.dPclean_psi = 0; d.dPexp_psi = 0; d.dPdesign_psi = 0; d.T = N.esd.T; d.Tout = N.esd.T;
      d.vIn_fts = 0; d.rate = 'none'; d.gvf = 0; d.rhoMix = 0; d.mu_cp = 0; d.d50c_um = 0; d.eff = 0; d.effClean = 0;
      ds.in_lbd = 0; ds.capt_lbd = 0; ds.out_lbd = 0; dm.Pacc = 0;
      nd.P = X.PB; nd.Pin = X.PB; nd.dP = 0; nd.T = N.esd.T; nd.Tout = N.esd.T; nd.Tacc = Tamb; nd.th = N.esd.th; nd.hyd = false;
    }
    sd.on = sandOn; sd.pptb = DD.pptb; sd.lbPerMMscf = DD.lbm; sd.d50_um = DD.d50; sd.sigmaG = DD.sg;
    sd.in_lbd = DX.W; sd.toChoke_lbd = DX.passR;
    sd.flowback.on = !!faults.sandFlowback; sd.flowback.W0_lbph = num(FB.W0_lbph, 200); sd.flowback.tau_h = num(FB.tau_h, 6);
    sd.flowback.t_h = DX.tSand / 3600; sd.flowback.d50_um = DD.d50fb; sd.flowback.sigmaG = DD.sgfb;
    var perDay = num(E.allowance_mil, 125) / mmax(num(E.testH, 72) / 24, 1e-6), ch = sd.choke, mild = DX.ero / 365.25;
    ch.warn_mild = num(E.warnFrac, 0.05) * perDay; ch.high_mild = num(E.highFrac, 0.5) * perDay;
    var Up = mmin(DD.vtss * X.fInst, DD.cmix);
    ch.Up_fts = Up > 0 && isFin(Up) ? Up : 0; ch.C2 = DX.passR > 0 ? DX.C2ch : 0; ch.erosion_mpy = DX.ero; ch.erosion_mild = mild;
    ch.band = DX.passR > 0 ? (mild < ch.warn_mild ? 'ok' : (mild < ch.high_mild ? 'warn' : 'high')) : 'none'; ch.loss_mil = DX.loss;
    sd.sep.lb = cum.sandToSep; sd.sep.ft3 = cum.sandToSep / mmax(DD.bulk, 1); sd.sep.frac = desSepFrac();
    var sc = sd.cum;
    sc.in_lb = cum.sandIn; sc.capt_lb = cum.sandCapt; sc.toChoke_lb = cum.sandToChoke; sc.toSep_lb = cum.sandToSep; sc.toFlare_lb = cum.sandToFlare; sc.dumped_lb = cum.sandDumped;
    setLine(s.lines.ds_dump, DX.dumpR, DD.cap / mmax(num(C.dump.flushS, 600), 1) * 86400, 0, 2.067, dm.open);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── T-202 second surge tank (WP-E2) ───
  // docs/SIM-EQUIPMENT-PLAN.md §5. WP-E0 (foundation) left these hooks with their call sites; WP-E2 fills the bodies in this
  // section only (plus the shared-code lines of §5.8). Per-substep hooks run only when rSurge2.
  //   surge2Derive()              derive(), always             geometry, set points, valve sizing (Cv_psvU2 …) (§5.1, §5.3)
  //   surge2Init()                initState(), always          t = 0: empty, gas at the set pressure, XV-202 per ctl.surge2.inlet
  //   surge2Limits(h)             limits(h), rSurge2           SP ramp and psh / pshh / mawp
  //   surge2Step(h)               substep, rSurge2             vessel, PCV-203 / PCV-204 / PSV-202, LCV-202 (§5.2–5.4)
  //   surge2Alarms()              processAlarms, rSurge2 (§5.5)
  //   surge2Refresh(s)            refresh(), always            snap.surge2 / nodes.surge2 (§6.4)
  //   surge2ChooseH(c)            chooseH, rSurge2             c.h: gas-residence cap, c.te: LCV-202 lsh / lsl, XV-202 stroke end
  //   surge2Hist(i)               histSample, always           surge2Frac, surge2P at ring index i
  //   surge2Inv(op, o)            'oil' / 'water' / 'gas' → T-202 inventory (STB / bbl / scf; in every balance, §5.7);
  //                               'zero' (o = cum), 'ref' (o = ref)
  //   surge2Rig(phase, old, r, parts) setRigNow: 'check' → refusal text ('' = allowed); 'apply' when T-202 enters / leaves (§3.3)
  //                               'check' must be pure: refresh re-runs it while a refusal is stored (snapshot rigup.refused)
  //   surge2Ctl(src, initial)     setControls → ctl.surge2 {inlet, auto, sp, hyst, strokeS} (prefs precedence §3.3)
  //   surge2Valve(open, isAuto)   setValve('surge2', 0, open) → bool;  surge2Route(mode) → {ok, msg};
  //   surge2Auto(on, o) / surge2Opts(o)  setAutoDivert / setValveOptions ('surge2') → bool
  //   surge2Internal(o)           _internal() extension point
  // Internal helpers of this section (called from the §5.8 shared lines, every call guarded by rSurge2):
  //   surge2Discrete(h)           substep discrete logic: auto route, LCV-202 level control / low-low latch, PSV-202 lift
  //   surge2Pre(h, uA, uB)        flux section: XV-202 travel, route activity, dump back-pressure (psia)
  //   surge2Gas(h, TR, P2a, gSum) flux section: PCV-204 blanket, PCV-203 PI, PSV-202 relief, LCV-202 transfer
  //   surge2Split(dmpO, dmpW, blow) routing: pressure-driven split of the dumps / flash / blow-by (check valve per branch)
  //   surge2Ends()                after valveEnds: XV-202 limit switch, make-before-break pending closes
  // ── state (T-202 hot object X2: field names as on X; closure state below) ──
  var X2 = { n_u: 0, nBase: 0, PuA: PSC, Pu: 0, Zu: 0, Bu: 1, VgU: 1, VliqU: 0, hU: 0, Tu: 80, SPeu: 0, dSPeu: 0, Ibpv: 0, ubpv: 0,
    ublk: 0, pshU: 0, pshhU: 0, mawpU: 50, P2aU: PSC, Ph: 0 };
  var uo2 = 0, uw2 = 0, u2pos = 0, psvULift2 = false, xferOn2 = false, s2Both = false;
  var pend2 = { closeU: false, close2: false };   // close XV-201A/B at XV-202's open limit | XV-202 at a T-201 inlet's open limit
  // make-before-break of single valve commands: XV-202 commanded shut while the T-201 inlet(s) commanded open are still
  // travelling is held open (hold2) until one of them reaches its open limit; the last XV-201 commanded shut while XV-202 is
  // still opening is held open likewise (hold.surge[k] through surge2HoldU in armClose / valveEnds)
  var hold2 = false;
  var cap2 = 100, D2 = 6, At2 = 1, H2 = 1, Psp2 = 25, qDd2 = 0, qFlashD2 = 0;
  var Cv_bpv2 = 1, Cv_mk2 = 1, Cv_psvU2 = 1, Cv_x2 = 1, pumpDesign2 = 500, dPxD2 = 10, psvCase2 = null;
  // last-substep fluxes of T-202 (scf/s, STB/s, bbl/s): x1 / x2av opening of the T-201 / T-202 branch, s1 / s2 liquid shares,
  // in2 dump inflow (bbl/s at separator conditions), dO / dW dumps (STB/s, bbl/s), rV level rate (bbl/s)
  var F2 = { act: false, x1: 0, x2av: 0, x2new: 0, s1: 1, s2: 0, b2: 0, dO: 0, dW: 0, in2: 0, flash: 0, blow: 0, blk: 0, held: false,
    bpv: 0, bpvCap: 0, psv: 0, po: 0, pw: 0, xBpd: 0, xCmd: 0, xdP: 0, sg: 0.85, rV: 0, gP: 0, gT: 0, gRs: 0 };
  var RIG2_REFUSED = 'T-202 is the only open route and T-201 cannot take the dumps (LSHH-201): open a T-201 inlet first.';
  // ── alarm texts (§5.5) and the two shared texts that name T-202 while it is in ──
  MSG.PSHH_SURGE2 = mHi('PSHH-202', 'surge tank 2', 'pressureG');
  MSG.PSH_SURGE2 = mHi('PAH-202', 'surge tank 2 pressure high', 'pressureG');
  MSG.PSV_SURGE2 = function (v, l) { return 'PSV-202 lifting — surge tank 2 ' + uq(v, 'pressureG') + ' (set ' + uq(l, 'pressureG') + ')'; };
  MSG.LSHH_SURGE2 = function (v, l) { return 'LSHH-202 ' + TAGS.surge2 + ' level ' + rnd(v) + '% ≥ ' + rnd(l) + '% — ' + TAGS.xvSurge2 + ' closed (no ESD)'; };
  MSG.LSLL_SURGE2 = function (v, l) { return 'LSLL-202 ' + TAGS.surge2 + ' level ' + rnd(v) + '% ≤ ' + rnd(l) + '% with ' + TAGS.xfer2 + ' open'; };
  MSG.XFER2_DRYRUN = function (v, l) { return TAGS.xfer2 + ' low-low trip — ' + TAGS.surge2 + ' level ' + rnd(v) + '% ≤ LSLL ' + rnd(l) + '% (gas blow-by protection, reset required)'; };
  MSG.XFER2_FAIL = function () { return TAGS.xfer2 + ' ' + TAGS.surge2 + ' transfer valve stuck closed'; };
  MSG.XFER2_LOW_DP = function (v) { return TAGS.xfer2 + ' open but ΔP only ' + uq(v, 'pressure') + ' — ' + TAGS.surge2 + ' pressure + head too low to ' + (rGauge ? 'lift to ' + TAGS.gauge : 'reach the export line'); };
  MSG.LAH_SURGE_ALL = function (v, l) { return 'LAH-202 all surge tanks high (' + rnd(v) + '% ≥ ' + rnd(l) + '%) — ' + TAGS.surgeA + ', ' + TAGS.surgeB + ' and ' + TAGS.surge2; };
  MSG.SURGE_BLOCKED = function () {
    if (!rSurge) return TAGS.xvGaugeA + ' and ' + TAGS.xvGaugeB + ' closed — separator dumps blocked (no route to ' + TAGS.gauge + ')';
    return rSurge2 ? TAGS.xvSurgeA + ', ' + TAGS.xvSurgeB + ' and ' + TAGS.xvSurge2 + ' closed — separator dumps blocked (no route to ' + TAGS.surge + ' or ' + TAGS.surge2 + ')'
      : TAGS.xvSurgeA + ' and ' + TAGS.xvSurgeB + ' closed — separator dumps blocked (no route to ' + TAGS.surge + ')';
  };
  MSG.LAH_SURGE_BOTH = function (v, l) {
    return 'LAH-201 both surge compartments high (' + rnd(v) + '% ≥ ' + rnd(l) + '%) — auto-divert has no room' +
      (rSurge2 && !ctl.surge2.auto ? ' — route the dumps to ' + TAGS.surge2 : '');
  };

  function mawp2Of(x) {
    var C = cfg.surge2;
    if (C.mawp != null && isNum(+C.mawp)) return +C.mawp;
    return mmax(50, x + mmax(0.5 * x, 15) + 10);
  }
  function frac2() { return X2.VliqU / cap2; }
  // §5.1 / §5.3 / §5.4: geometry, set point (follows T-201 unless configured), valve sizing on T-202's own design
  function surge2Derive() {
    var C = cfg.surge2, S = cfg.sep;
    cap2 = mmax(1, num(C.cap_bbl, 100)); D2 = mmax(0.5, num(C.D_ft, 6)); At2 = PI * D2 * D2 / 4; H2 = cap2 * BBL / At2;
    Psp2 = isNum(C.Psp) ? clamp(C.Psp, 0, mmin(30, mmax(0, SP - 10))) : PspU;
    var TRs = Tsep_ss + RANK, SPa = SP + PSC, P2a = PSC + S.pcv.P2_psig, Psp2a = Psp2 + PSC, BsD = BoR(SPa, Tsep_ss);
    qDd2 = mmax(qoE * BsD + qwE, (num(S.oil.minDesignBpd, 100) + num(S.water.minDesignBpd, 100)) / 86400);
    qFlashD2 = qoE * mmax(0, RsE(SPa, Tsep_ss) - RsE(Psp2a, Tsep_ss));
    var P2aUd = PSC + mmin(S.pcv.P2_psig, 0.4 * Psp2), P1u = mmax(Psp2a, P2aUd + 5);
    var qU1 = gq(1, P1u, P2aUd, TRs, Zf(P1u, TRs));
    Cv_bpv2 = qU1 > 0 ? mmax(3 * qFlashD2, 50e3 / 86400) / (0.5 * qU1) : 1;
    var velCap = num(C.pumpVelFrac, 0.7) * 10 * A6 * 86400 / BBL, pMin = num(C.pumpMinBpd, 500);
    pumpDesign2 = (C.pumpBpd != null && +C.pumpBpd > 0) ? +C.pumpBpd : mmin(mmax(3 * (qoE * BsD + qwE) * 86400, pMin), velCap > 0 ? velCap : pMin);
    var aoD = qoE * BsD, SGlD = (aoD + qwE) > 1e-15 ? (aoD * SGo + qwE) / (aoD + qwE) : SGo;
    dPxD2 = mmax(2, mmax(Psp2, 10) + WGRAD * SGlD * (0.5 * H2 - Hg));
    Cv_x2 = pumpDesign2 / (msqrt(dPxD2 / mmax(SGlD, 0.1)) * GPM_BPD);
    var Qv = pumpDesign2 / 86400 * BBL * (Psp2a / PSC) * (TSC / TRs) / Zf(Psp2a, TRs);
    var Pk = mmax(SPa, Psp2a + 5), qmk1 = gq(1, Pk, Psp2a, TRs, Zf(Pk, TRs));
    Cv_mk2 = qmk1 > 0 ? 2 * Qv / qmk1 : 1;
    // PSV-202 (own sizing, never halved for a split): the largest of gas blow-by through the larger dump valve wide open,
    // PCV-204 wide open, the design flash with PCV-203 blocked and the minimum, relieved at 10 % accumulation
    var mU2 = mawp2Of(Psp2), mU2a = mU2 + PSC, P1 = mmax(SPa, mU2a + 1);
    var cB = gq(mmax(Cv_o, Cv_w), P1, mU2a, TRs, Zf(P1, TRs)), cK = gq(Cv_mk2, SPa, mU2a, TRs, Zf(SPa, TRs));
    var cF = 3 * mmax(qFlashD, qFlashD2), cM = num(C.psvMinMscfd, 50) * 1000 / 86400;
    var Qreq = mmax(cB, cK, cF, cM), Prel = 1.10 * mU2 + PSC, qr1 = gq(1, Prel, P2a, TRs, Zf(Prel, TRs));
    Cv_psvU2 = qr1 > 0 ? Qreq / qr1 : 1;
    psvCase2 = { blowby: cB, blanket: cK, flash: cF, min: cM, Qreq: Qreq, mawp: mU2, Prel_psia: Prel, P2a: P2a, TR: TRs,
      capAtRelief: gq(Cv_psvU2, Prel, P2a, TRs, Zf(Prel, TRs)) };
  }
  // levels and pressure of T-202 from its inventories (vac: vacuum breaker admits air, tracked in cum.vacBreak)
  function algebraic2(vac) {
    var TRu = X2.Tu + RANK;
    X2.Bu = BoR(X2.PuA > 0 ? X2.PuA : Psp2 + PSC, X2.Tu);
    X2.VliqU = uo2 * X2.Bu + uw2; X2.hU = X2.VliqU * BBL / At2; X2.VgU = mmax(1, (cap2 - X2.VliqU) * BBL);
    var zu = X2.Zu > 0 ? X2.Zu : 0.99, Pa = X2.n_u * zu * TRu * PSC / (TSC * X2.VgU);
    zu = Zf(mmax(Pa, 1), TRu); Pa = X2.n_u * zu * TRu * PSC / (TSC * X2.VgU);
    if (vac && Pa < PSC) { var nd = PSC * X2.VgU * TSC / (zu * TRu * PSC); cum.vacBreak += nd - X2.n_u; X2.n_u = nd; Pa = PSC; }
    X2.Zu = zu; X2.PuA = Pa; X2.Pu = Pa - PSC;
  }
  function zeroF2() {
    for (var k in F2) if (typeof F2[k] === 'number') F2[k] = 0;
    F2.act = false; F2.held = false; F2.s1 = 1; F2.sg = SGo;
  }
  // t = 0 (create / reset): empty, gas at the set pressure (atmospheric for an empty start), XV-202 per ctl.surge2.inlet.
  // nBase = the initial gas content: the balances count T-202's gas from it, so an unused T-202 adds exactly 0.
  function surge2Init() {
    uo2 = 0; uw2 = 0; X2.Tu = Tamb; X2.Zu = 0; X2.SPeu = Psp2;
    var Pa0 = mode === 'steady' ? Psp2 + PSC : PSC, TR0 = X2.Tu + RANK;
    X2.PuA = Pa0; X2.Bu = BoR(Pa0, X2.Tu); X2.VgU = cap2 * BBL;
    X2.n_u = Pa0 * X2.VgU * TSC / (Zf(Pa0, TR0) * TR0 * PSC); X2.nBase = X2.n_u;
    X2.Ibpv = 0; X2.ubpv = 0; X2.ublk = 0;
    psvULift2 = false; xferOn2 = false; s2Both = false; pend2.closeU = false; pend2.close2 = false; hold2 = false;
    ptrip.XFER2_DRYRUN = false;
    u2pos = ctl.surge2.inlet ? 1 : 0;
    zeroF2();
    algebraic2(false);
    surge2Limits(0);
    X2.Ph = X2.Pu;
  }
  function surge2Limits(h) {
    var C = cfg.surge2, r = cfg.ramp, s0 = X2.SPeu;
    X2.SPeu += clamp(Psp2 - X2.SPeu, -r.surgeSpRate * h, r.surgeSpRate * h);
    X2.dSPeu = h > 0 ? (X2.SPeu - s0) / h : 0;
    X2.pshU = C.psh != null && isNum(+C.psh) ? +C.psh : X2.SPeu + mmax(0.25 * X2.SPeu, 7);
    X2.pshhU = C.pshh != null && isNum(+C.pshh) ? +C.pshh : X2.SPeu + mmax(0.50 * X2.SPeu, 15);
    X2.mawpU = mawp2Of(mmax(Psp2, X2.SPeu));
    X2.P2aU = PSC + mmin(cfg.sep.pcv.P2_psig, 0.4 * X2.SPeu);
  }
  // ── substep pieces ──
  function surge2Discrete(h) {
    var C = cfg.surge2, f2 = frac2();
    if (ctl.surge2.auto) surge2AutoRoute(f2);
    // LCV-202 low-low protection: an OPEN transfer at LSLL latches shut (the vessel is pressurised: an empty outlet would blow
    // gas through to the atmospheric gauge tank); below LSLL a shut LCV-202 is simply not opened (LSL / LSH level control)
    if (xferOn2 && !ptrip.XFER2_DRYRUN && !ptrip.LSHH_GT && !faults.xfer2StuckClosed && !pumpBlocked && f2 <= C.lsll + 1e-12) ptrip.XFER2_DRYRUN = true;
    if (f2 >= C.lsh - 1e-12) xferOn2 = true; else if (f2 <= C.lsl + 1e-12) xferOn2 = false;
    if (!psvULift2 && X2.Pu >= X2.mawpU) psvULift2 = true; else if (psvULift2 && X2.Pu <= 0.93 * X2.mawpU) psvULift2 = false;
  }
  // XV-202 travel over the substep and the dump back-pressure: legacy (T-201), T-202 only, or the inlet header (both open;
  // X2.Ph from the previous substep: one-substep lag, h ≤ 0.25 s, no iteration)
  function surge2Pre(h, uA, uB) {
    var sS = ctl.surge2.strokeS;
    slew(u2pos, surge2Tgt(), h, sS, sS);
    F2.x2av = SLEW.avg; F2.x2new = SLEW.x;
    var x1 = mmin(1, uA + uB);
    F2.x1 = x1; F2.act = F2.x2av > 0;
    if (!F2.act) { s2Both = false; return X.PuA; }
    if (!(x1 > 0)) { s2Both = false; return X2.PuA; }
    if (!s2Both) { s2Both = true; X2.Ph = mmin(X.Pu, X2.Pu); }
    return X2.Ph + PSC;
  }
  // PCV-203 PI output (as PCV-201): gain from the valve capacity at max(P, SP) and feed-forward = flash + blow-by + gas displaced
  // by the net liquid inflow − SP-ramp storage (last-substep fluxes), both on one capacity evaluation; anti-wind-up
  function bpv2PI(h, e) {
    var TRu = X2.Tu + RANK, P1 = mmax(X2.PuA, X2.SPeu + PSC);
    var cap = gq(Cv_bpv2, P1, X2.P2aU, TRu, Zf(P1, TRu));
    var Kp = X2.Zu * TRu * PSC / (TSC * X2.VgU) * cap, Kc = Kp > 1e-12 ? mmax(X2.SPeu, 20) / (Kp * cfg.surge2.bpv.tauCl) : 0;
    var dVl = F2.in2 - (F2.po * X2.Bu + F2.pw);
    var bias = cap > 0 ? clamp((F2.flash + F2.blow + X2.n_u / mmax(X2.VgU, 1e-6) * BBL * dVl - X2.n_u / mmax(X2.PuA, 1) * X2.dSPeu) / cap, 0, 1) : 0;
    var uR = bias + Kc * (e + X2.Ibpv / cfg.surge2.bpv.Ti);
    if ((uR > 0 && uR < 1) || (uR >= 1 && e < 0) || (uR <= 0 && e > 0)) X2.Ibpv += e * h;
    return clamp(uR, 0, 1);
  }
  // LCV-202 driving pressure: T-202 pressure + liquid head − lift to T-301's top inlet (none to the export line)
  function xferDP2() {
    var VO = uo2 * X2.Bu, VS = VO + uw2, sg = VS > 1e-9 ? (uw2 + VO * SGo) / VS : SGo;
    F2.sg = sg;
    return X2.Pu + WGRAD * sg * (VS / cap2 * H2 - (rGauge ? Hg : 0));
  }
  function surge2Gas(h, TR, P2a, gSum) {
    var C = cfg.surge2, TRu = X2.Tu + RANK;
    // PCV-204 blanket from separator gas (P-only); held shut while PSHH-202 is active
    var held = !!(AL.PSHH_SURGE2 && AL.PSHH_SURGE2.active);
    F2.held = held;
    X2.ublk = (rSep && C.blanket.on && X.Psep >= 0.9 * X.SPe && !held) ? clamp((X2.SPeu - C.blanket.deadband - X2.Pu) / mmax(C.blanket.band, 0.1), 0, 1) : 0;
    F2.blk = X2.ublk > 0 ? mmin(X2.ublk * gq(Cv_mk2, X.PsepA, X2.PuA, TR, X.Zs), 0.5 * X.n_s / h) : 0;
    // PCV-203 back-pressure PI with feed-forward and anti-wind-up (stuck closed: held shut, integrator frozen)
    // Exact shortcut (standby): at or below the set point with no inflow, no SP rise and no positive integral the feed-forward is
    // 0 and the PI output ≤ 0, so the valve stays shut and the integrator does not move — skip the valve evaluations
    var e = (X2.Pu - X2.SPeu) / mmax(X2.SPeu, 20);
    if (faults.bpv2StuckClosed) X2.ubpv = 0;
    else if (e <= 0 && X2.Ibpv <= 0 && X2.dSPeu >= 0 && !(F2.in2 > 0) && !(F2.flash > 0) && !(F2.blow > 0)) X2.ubpv = 0;
    else X2.ubpv = bpv2PI(h, e);
    if (X2.ubpv > 0 || F2.bpv > 0 || !(F2.bpvCap > 0)) F2.bpvCap = gq(Cv_bpv2, X2.PuA, X2.P2aU, TRu, X2.Zu);
    F2.bpv = X2.ubpv * F2.bpvCap;
    F2.psv = psvULift2 ? gq(Cv_psvU2, X2.PuA, P2a, TRu, X2.Zu) : 0;
    var out = F2.bpv + F2.psv, sc;
    if (out * h > X2.n_u) { sc = X2.n_u / (out * h); F2.bpv *= sc; F2.psv *= sc; }
    // LCV-202 (on/off level control on T-202's own level, no pump): open while level control asks, not latched (its own
    // low-low or LSHH-301), not stuck, and a route (a T-301 inlet passing, or the export line without T-301)
    var xCmd = xferOn2 && !ptrip.XFER2_DRYRUN && !ptrip.LSHH_GT && !faults.xfer2StuckClosed && (!rGauge || gSum > 0);
    F2.xCmd = xCmd ? 1 : 0;
    F2.xdP = xCmd ? xferDP2() : 0;
    var Q = xCmd ? liqQ(Cv_x2, F2.xdP, F2.sg) : 0, V0 = uo2 * X2.Bu + uw2;
    F2.po = 0; F2.pw = 0;
    if (Q > 0 && V0 > 1e-9) { F2.pw = mmin(Q * (uw2 / V0), uw2 / h); F2.po = mmin(Q * (uo2 * X2.Bu / V0) / X2.Bu, uo2 / h); }
    F2.xBpd = Q * 86400;
  }
  // §5.2 pressure-driven split: branch k has a check valve and conductance C = qDd/√inletDP; q_k = C·x_k·√max(0, Ph − b_k)
  // with b_k the vessel pressure (top inlets into the gas space). Ph from Σq_k = q_dump; shares s_k = q_k / Σq.
  function surge2Split(dmpO, dmpW, blow) {
    var q = dmpO * X.Bs + dmpW;
    F2.dO = dmpO; F2.dW = dmpW;
    if (!F2.act) { F2.s1 = 1; F2.s2 = 0; }
    else if (!(F2.x1 > 0)) { F2.s1 = 0; F2.s2 = 1; X2.Ph = X2.Pu; }
    else {
      var Cc = qDd2 / msqrt(mmax(num(cfg.surge2.inletDP_psi, 3), 0.01));
      var b1 = X.Pu, b2 = X2.Pu, c1 = Cc * F2.x1, c2 = Cc * F2.x2av, lo1 = b1 <= b2;
      var blo = lo1 ? b1 : b2, bhi = lo1 ? b2 : b1, clo = lo1 ? c1 : c2, chi = lo1 ? c2 : c1, Ph, qlo = 0, qhi = 0, s2;
      if (!(q > 0) || !(clo > 0)) Ph = blo;
      else if (q <= clo * msqrt(bhi - blo)) { Ph = blo + (q / clo) * (q / clo); qlo = q; }
      else {
        var a = bhi, b = blo + (q / clo) * (q / clo);
        for (var it = 0; it < 12; it++) { var m = 0.5 * (a + b); if (clo * msqrt(m - blo) + chi * msqrt(m - bhi) > q) b = m; else a = m; }
        Ph = 0.5 * (a + b); qlo = clo * msqrt(Ph - blo); qhi = chi * msqrt(mmax(0, Ph - bhi));
      }
      // the split pressure Ph only sets the shares: the dump back-pressure (and the reported header pressure) is the lower vessel
      // pressure, as on the single routes (Pd = vessel pressure, no inlet loss), so opening a second parallel path never raises it
      X2.Ph = blo;
      if (qlo + qhi > 0) s2 = (lo1 ? qhi : qlo) / (qlo + qhi);
      else s2 = mabs(b1 - b2) <= 0.5 ? (c1 + c2 > 0 ? c2 / (c1 + c2) : 0) : (lo1 ? 0 : 1);   // no liquid: blow-by to the lower-pressure branch
      F2.s2 = s2; F2.s1 = 1 - s2;
    }
    F2.b2 = F2.s2;                                    // blow-by follows the liquid shares
    F2.blow = blow * F2.b2;
    F2.in2 = F2.s2 * q;
    F2.flash = F2.s2 > 0 ? F2.s2 * dmpO * mmax(0, RsE(X.PsepA, X.Tsep) - RsE(X2.PuA, X2.Tu)) : 0;
  }
  // explicit update of T-202 (its fluxes were set in surge2Gas / surge2Split this substep)
  function surge2Step(h) {
    u2pos = F2.x2new;
    // standby (XV-202 shut, nothing in or out, temperature at ambient): every update below would leave the state unchanged
    if (!(F2.s2 > 0) && !(F2.po > 0) && !(F2.pw > 0) && !(F2.blk > 0) && !(F2.bpv > 0) && !(F2.psv > 0) && X2.Tu === Tamb) { F2.rV = 0; return; }
    var V0 = uo2 * X2.Bu + uw2, s2 = F2.s2;
    uo2 += (s2 * F2.dO - F2.po) * h; uw2 += (s2 * F2.dW - F2.pw) * h;
    X2.n_u += (F2.flash + F2.blow + F2.blk - F2.bpv - F2.psv) * h;
    if (uo2 < 0) uo2 = 0; if (uw2 < 0) uw2 = 0; if (X2.n_u < 0) X2.n_u = 0;
    // overfill above 0.98·capacity → flare header, top phase first (the last resort, as T-201)
    var lim = 0.98 * cap2, Vl = uo2 * X2.Bu + uw2;
    if (Vl > lim) {
      var ex = Vl - lim, take = mmin(ex, uo2 * X2.Bu);
      uo2 -= take / X2.Bu; cum.ltfOil += take / X2.Bu; ex -= take;
      take = mmin(ex, uw2); uw2 -= take; cum.ltfWater += take;
    }
    X2.Tu = mixT(X2.Tu, F2.in2 / mmax(uo2 * X2.Bu + uw2, 0.5), X.Tsep, h);
    algebraic2(true);
    F2.rV = (X2.VliqU - V0) / h;
  }
  // XV-202 limit switch and the make-before-break pending closes (after valveEnds, end-of-step positions)
  function surge2Ends() {
    var k, tg;
    if (hold2 && (ctl.surge2.inlet || !(uv[0] || uv[1]) || t1OpenLimit())) hold2 = false;
    tg = surge2Tgt();
    if (ctl.surge2.strokeS <= 0) u2pos = tg;
    if (u2pos !== tg && mabs(u2pos - tg) < 1e-9) u2pos = tg;
    if ((hold.surge[0] || hold.surge[1]) && u2pos >= 1) valveEnds();   // XV-202 at its open limit: release a held XV-201
    if (pend2.closeU && u2pos >= 1) {
      pend2.closeU = false;
      for (k = 0; k < 2; k++) if (uv[k]) setValveNow('surge', k, false, true);
    }
    if (pend2.close2 && t1OpenLimit()) {
      pend2.close2 = false;
      surge2Cmd(false, true, '');
    }
  }
  // position target of XV-202 (commanded open, or held open for make-before-break) and the T-201 open-limit test
  function surge2Tgt() { return (ctl.surge2.inlet || hold2) ? 1 : 0; }
  function t1OpenLimit() { return (uv[0] && upos[0] >= 1) || (uv[1] && upos[1] >= 1); }
  // XV-201 k commanded shut as the last T-201 inlet while XV-202 (commanded open) has not reached its open limit
  function surge2HoldU(k) { return rSurge2 && !uv[1 - k] && !!ctl.surge2.inlet && u2pos < 1 && upos[k] > 0; }
  // command XV-202 (no permissive here); a stroke of 0 s snaps the position. failSafe: a trip closure (never held open)
  function surge2Cmd(open, isAuto, why, failSafe) {
    if (!!ctl.surge2.inlet === open) return false;
    ctl.surge2.inlet = open;
    if (!open) { pend2.closeU = false; hold2 = !failSafe && u2pos > 0 && (uv[0] || uv[1]) && !t1OpenLimit(); }
    else { pend2.close2 = false; hold2 = false; }
    if (ctl.surge2.strokeS <= 0) u2pos = surge2Tgt();
    var msg = TAGS.xvSurge2 + (open ? ' opened' : ' closed') + (why ? ' (' + why + ')' : (isAuto ? ' (auto)' : ' (manual)')) + ' — ' + routeText();
    logEntry('event', 'VALVE', null, TAGS.xvSurge2, msg);
    noteControl('surge2', 'inlet', isAuto, msg);
    return true;
  }
  function routeOf() {
    var o1 = !!(uv[0] || uv[1]), o2 = rSurge2 && !!ctl.surge2.inlet;
    return o1 && o2 ? 'both' : (o2 ? 'surge2' : (o1 ? 'surge' : 'none'));
  }
  function routeText() {
    return TAGS.xvSurgeA + ' ' + (uv[0] ? 'OPEN' : 'CLOSED') + ' · ' + TAGS.xvSurgeB + ' ' + (uv[1] ? 'OPEN' : 'CLOSED') + ' · ' + TAGS.xvSurge2 + ' ' + (ctl.surge2.inlet ? 'OPEN' : 'CLOSED');
  }
  // §5.2 routes, make-before-break: open the new inlet(s) first; the old one(s) close at the new valve's open limit
  function surge2RouteNow(mode, isAuto, onlyK) {
    if (!rSurge2) return { ok: false, msg: TAGS.surge2 + ' is not in the rig-up' };
    if (mode !== 'surge' && mode !== 'surge2' && mode !== 'both') return { ok: false, msg: 'unknown route ' + String(mode) };
    var C = cfg.surge2, k, limU = cfg.surge.lshh * capK - 1e-9;
    if (mode !== 'surge' && frac2() >= C.lshh - 1e-9) {
      var rm = 'route to ' + TAGS.surge2 + ' refused — ' + TAGS.surge2 + ' at LSHH-202';
      logEntry('event', 'ROUTE', null, TAGS.surge2, rm);
      return { ok: false, msg: rm };
    }
    var from = routeOf();
    if (mode === 'surge2') {
      surge2Cmd(true, isAuto, isAuto ? 'auto route' : '');
      pend2.close2 = false;
      if (uv[0] || uv[1]) pend2.closeU = true;
    } else if (mode === 'both') {
      surge2Cmd(true, isAuto, '');
      pend2.closeU = false; pend2.close2 = false;
      if (!uv[0] && !uv[1]) for (k = 0; k < 2; k++) if (compVliq(k) < limU) setValveNow('surge', k, true, isAuto);
    } else {
      pend2.closeU = false;
      if (!uv[0] && !uv[1]) for (k = 0; k < 2; k++) if ((onlyK === undefined || onlyK[k]) && compVliq(k) < limU) setValveNow('surge', k, true, isAuto);
      if (!uv[0] && !uv[1]) {
        var rs = 'route to ' + TAGS.surge + ' refused — ' + TAGS.surge + ' cannot take the dumps (LSHH-201)';
        logEntry('event', 'ROUTE', null, TAGS.surge2, rs);
        return { ok: false, msg: rs };
      }
      if (ctl.surge2.inlet) pend2.close2 = true;
    }
    surge2Ends();
    var msg = 'Separator dumps routed to ' + (mode === 'both' ? TAGS.surge + ' + ' + TAGS.surge2 : (mode === 'surge2' ? TAGS.surge2 : TAGS.surge)) +
      (isAuto ? ' (auto route)' : '') + ' — ' + routeText();
    logEntry('event', 'ROUTE', null, TAGS.surge2, msg);
    if (isAuto) emit('divert', { type: 'divert', t: X.t, eq: 'surge2', from: from, to: mode, auto: true, tag: mode === 'surge' ? TAGS.surge : TAGS.surge2, msg: msg });
    noteControl('surge2', 'route', isAuto, msg);
    return { ok: true, msg: msg };
  }
  // auto route (off by default): T-201 full (every open compartment ≥ sp) → T-202 when it has room; T-202 full → back to the
  // T-201 compartments with room. Nothing switches while a route change is still travelling.
  function surge2AutoRoute(f2) {
    var C2 = ctl.surge2, sp = C2.sp, hy = C2.hyst, k;
    if (pend2.closeU || pend2.close2) return;
    var o1 = uv[0] || uv[1], o2 = !!C2.inlet;
    if (o1 && !o2) {
      var full = true;
      for (k = 0; k < 2; k++) if (uv[k] && compVliq(k) < sp * capK - 1e-9) full = false;
      if (full && f2 < sp - hy && f2 < cfg.surge2.lshh - 1e-9) surge2RouteNow('surge2', true);
    } else if (o2 && !o1 && f2 >= sp - 1e-9) {
      var room = [compVliq(0) <= (sp - hy) * capK, compVliq(1) <= (sp - hy) * capK];
      if (room[0] || room[1]) surge2RouteNow('surge', true, room);
    }
  }
  // ── alarms (§5.5) ──
  var s2AL = null, s2A = null;
  function surge2AlarmDefs() {
    s2AL = AL;
    s2A = [aDef('PSHH_SURGE2', 'PSHH-202', 'trip', 'surge2', 'p'), aDef('PSH_SURGE2', 'PAH-202', 'alarm', 'surge2', 'p'),
      aDef('PSV_SURGE2', 'PSV-202', 'alarm', 'surge2', 'b'), aDef('LSHH_SURGE2', 'LSHH-202', 'trip', 'surge2', 'l'),
      aDef('LSLL_SURGE2', 'LSLL-202', 'warn', 'surge2', 'l', true), aDef('XFER2_DRYRUN', TAGS.xfer2, 'trip', 'surge2', 'l'),
      aDef('XFER2_FAIL', TAGS.xfer2, 'alarm', 'surge2', 'b'), aDef('XFER2_LOW_DP', TAGS.xfer2, 'warn', 'surge2', 'p'),
      aDef('LAH_SURGE_ALL', 'LAH-202', 'alarm', 'surge2', 'l')];
    s2A[3].act = 'xv202'; s2A[5].act = 'xfer2';
  }
  function surge2Alarms() {
    var C = cfg.surge2, dbP = cfg.alarm.pressDBfrac * mmax(X2.SPeu, 1), dbL = cfg.alarm.levelDB, f2 = frac2(), A;
    if (s2AL !== AL) surge2AlarmDefs();
    A = s2A[0];
    evalA(A, X2.Pu >= X2.pshhU, X2.Pu < X2.pshhU - dbP, X2.Pu, X2.pshhU, MSG.PSHH_SURGE2, false);
    A = s2A[1];
    evalA(A, X2.Pu >= X2.pshU, X2.Pu < X2.pshU - dbP, X2.Pu, X2.pshU, MSG.PSH_SURGE2, true);
    A = s2A[2];
    evalA(A, psvULift2, !psvULift2, X2.Pu, X2.mawpU, MSG.PSV_SURGE2, false);
    A = s2A[3];
    evalA(A, f2 >= C.lshh, f2 < C.lshh - dbL, f2 * 100, C.lshh * 100, MSG.LSHH_SURGE2, false);
    if (A.active && f2 >= C.lshh && ctl.surge2.inlet) surge2HHClose(A, false);   // reopened inside the deadband and back at LSHH
    A = s2A[4];
    var low = f2 <= C.lsll && F2.xCmd > 0;
    evalA(A, low, f2 > C.lsll + dbL || !(F2.xCmd > 0), f2 * 100, C.lsll * 100, MSG.LSLL_SURGE2, true);
    A = s2A[5];
    if (ptrip.XFER2_DRYRUN && !A.active) raise(A, f2 * 100, C.lsll * 100, MSG.XFER2_DRYRUN(f2 * 100, C.lsll * 100));
    else if (A.active) A.value = f2 * 100;
    var fl = !!faults.xfer2StuckClosed && xferOn2;
    A = s2A[6];
    evalA(A, fl, !fl, null, null, MSG.XFER2_FAIL, false);
    var lowDP = F2.xCmd > 0 && F2.xdP < num(C.xferMinDP, 1);
    A = s2A[7];
    evalA(A, lowDP, !lowDP, F2.xdP, num(C.xferMinDP, 1), MSG.XFER2_LOW_DP, true);
    // LAH-202: both T-201 compartments and T-202 at or above the auto-route set point (the level that moves the dumps
    // between the vessels), so no surge tank has room
    var sp2 = ctl.surge2.sp, fA = compVliq(0) / capK, fB = compVliq(1) / capK;
    var all = fA >= sp2 && fB >= sp2 && f2 >= sp2, allC = fA < sp2 - dbL || fB < sp2 - dbL || f2 < sp2 - dbL;
    A = s2A[8];
    evalA(A, all, allC, mmin(fA, fB, f2) * 100, sp2 * 100, MSG.LAH_SURGE_ALL, true);
  }
  // LSHH-202 (esd false): close XV-202, no ESD. PSHH-202 (esd true): close XV-202, PCV-204 held shut (surge2Gas), then the ESD
  // (raise → autoTrip)
  function surge2HHClose(A, esd) {
    pend2.closeU = false;
    if (!ctl.surge2.inlet && !(u2pos > 0)) return;
    var why = (esd ? 'PSHH-202' : 'LSHH-202') + ' trip, fail-safe';
    if (ctl.surge2.inlet) surge2Cmd(false, true, why + (esd ? ' · ' + TAGS.blanket2 + ' held shut' : ''), true);
    else if (hold2) { hold2 = false; if (ctl.surge2.strokeS <= 0) u2pos = 0; }
  }
  function xfer2TripNow(A) {
    var head = TAGS.xfer2 + ' transfer shut';
    logEntry('trip', A.id, 'trip', TAGS.xfer2, head + ' — ' + A.msg + ' · reset required');
    noteControl('surge2', 'trip', true, head + ' — ' + A.msg);
  }
  function surge2ChooseH(c) {
    var C = cfg.surge2, x, V = X2.VliqU;
    var tg2 = X2.n_u / mmax(F2.flash + F2.blow + F2.blk, F2.bpvCap * mmax(X2.ubpv, 0.02), F2.psv, 1e-9);
    if (0.3 * tg2 < c.h) c.h = 0.3 * tg2;
    if (!xferOn2 && F2.rV > 1e-12) { x = (C.lsh * cap2 - V) / F2.rV; if (x >= 0 && x < c.te) c.te = x; }
    if (xferOn2 && F2.rV < -1e-12) { x = (C.lsl * cap2 - V) / F2.rV; if (x >= 0 && x < c.te) c.te = x; }
    if (ctl.surge2.inlet && F2.rV > 1e-12) { x = (C.lshh * cap2 - V) / F2.rV; if (x >= 0 && x < c.te) c.te = x; }
    var d = mabs(surge2Tgt() - u2pos);
    if (d > 0 && ctl.surge2.strokeS > 0) { x = d * ctl.surge2.strokeS; if (x < c.te) c.te = x; }
    if (ctl.surge2.auto) {                            // auto route set points
      var sp = ctl.surge2.sp;
      if (F2.rV > 1e-12) { x = (sp * cap2 - V) / F2.rV; if (x >= 0 && x < c.te) c.te = x; }
      for (var k = 0; k < 2; k++) if (uv[k] && F.rUk[k] > 1e-12) { x = (sp * capK - compVliq(k)) / F.rUk[k]; if (x >= 0 && x < c.te) c.te = x; }
    }
  }
  // §5.7 balances: T-202's inventories are in every balance (gas counted from its initial content, so an unused T-202 adds 0);
  // cum.xo1 / cum.xo2 = STB transferred by LCV-201 / LCV-202 while T-202 is in (transfer-weighted shrink)
  function surge2Inv(op, o) {
    if (op === 'oil') return uo2;
    if (op === 'water') return uw2;
    if (op === 'gas') return X2.n_u - X2.nBase;
    if (op === 'zero') { o.xo1 = 0; o.xo2 = 0; }
    return 0;
  }
  // §3.3: 'check' is pure (refresh re-runs it while a refusal is stored)
  // T-202 is the only route: no XV-201 inlet commanded open and XV-202 commanded open (or still open)
  function surge2OnlyRoute() { return !uv[0] && !uv[1] && (!!ctl.surge2.inlet || u2pos > 0); }
  function surge2RigCheck(old, r) {
    if (!old.surge2 || r.surge2 || !r.surge || !surge2OnlyRoute()) return '';
    var lim = cfg.surge.lshh * capK - 1e-9;
    return compVliq(0) >= lim && compVliq(1) >= lim ? RIG2_REFUSED : '';
  }
  function surge2Rig(phase, old, r, parts) {
    if (phase === 'check') return surge2RigCheck(old, r);
    if (phase !== 'apply') return '';
    var k;
    pend2.closeU = false; pend2.close2 = false; s2Both = false; hold2 = false;
    if (r.surge2) {                                   // entering from the card: XV-202 commanded shut, inventory as it was
      ctl.surge2.inlet = false; u2pos = 0;
      X2.Ibpv = 0; X2.ubpv = 0; X2.ublk = 0;
      zeroF2(); algebraic2(false); surge2Limits(0); X2.Ph = X2.Pu;
      return '';
    }
    // leaving: make-before-break line-up when T-202 was the only route (snap XV-201A/B open, except at LSHH-201)
    // (also when T-201 leaves with it — D11 — so T-201 comes back with its inlets open; the refusal check stays in surge2RigCheck)
    if (surge2OnlyRoute()) {
      var lim = cfg.surge.lshh * capK - 1e-9, opened = [];
      for (k = 0; k < 2; k++) if (compVliq(k) < lim) { uv[k] = true; hold.surge[k] = false; upos[k] = 1; opened.push(valveTag('surge', k)); }
      if (opened.length) {
        var msg = (opened.length === 2 ? TAGS.xvSurgeA + '/B' : opened[0]) + ' opened: ' + TAGS.surge2 + ' left the rig-up';
        logEntry('event', 'ROUTE', null, TAGS.surge, msg);
        noteControl('surge', 'inlet', true, msg);
        parts.push(msg);
      }
    }
    // latched act alarms are released explicitly (quiet() skips them), then every T-202 alarm clears
    if (ptrip.XFER2_DRYRUN) { ptrip.XFER2_DRYRUN = false; parts.push(TAGS.xfer2 + ' low-low latch released'); }
    if (AL.XFER2_DRYRUN && AL.XFER2_DRYRUN.active) clearA(AL.XFER2_DRYRUN);
    if (AL.LSHH_SURGE2 && AL.LSHH_SURGE2.active) clearA(AL.LSHH_SURGE2);
    quiet(Q_SURGE2);
    ctl.surge2.inlet = false; u2pos = 0;              // XV-202 out with T-202: the snapshot, getControls and prefs read shut
    zeroF2();
    return '';
  }
  function surge2Valve(open, isAuto) {
    if (!rSurge2) return false;
    open = !!open;
    if (open && !ctl.surge2.inlet && frac2() >= cfg.surge2.lshh - 1e-9) {
      logEntry('event', 'VALVE', null, TAGS.xvSurge2, TAGS.xvSurge2 + ' open refused — ' + TAGS.surge2 + ' at LSHH-202');
      return false;
    }
    if (!surge2Cmd(open, isAuto, '')) return false;
    surge2Ends();
    return true;
  }
  function surge2Route(mode) { return surge2RouteNow(mode, false); }
  function surge2Auto(on, o) {
    if (!rSurge2) return false;
    var C = ctl.surge2, before = JSON.stringify(C), src = isPlainObj(o) ? { sp: o.sp, hyst: o.hyst } : {};
    src.auto = !!on;
    surge2Ctl(src, true);
    if (JSON.stringify(C) === before) return false;
    var msg = TAGS.surge2 + ' auto route ' + (C.auto ? 'ON' : 'OFF') + ' (SP ' + rnd0(C.sp * 100) + '%, hysteresis ' + rnd0(C.hyst * 100) + '%)';
    logEntry('event', 'AUTO', null, TAGS.surge2, msg);
    noteControl('surge2', 'auto', false, msg);
    return true;
  }
  function surge2Opts(o) {
    if (!rSurge2 || !isPlainObj(o) || !isNum(o.strokeS)) return false;
    var C = ctl.surge2, s0 = C.strokeS;
    C.strokeS = clamp(o.strokeS, 0, 60);
    if (C.strokeS === s0) return false;
    if (C.strokeS <= 0) { u2pos = C.inlet ? 1 : 0; surge2Ends(); }
    var msg = TAGS.xvSurge2 + ' stroke ' + rnd0(C.strokeS) + ' s';
    logEntry('event', 'VALVE_OPT', null, TAGS.surge2, msg);
    noteControl('surge2', 'options', false, msg);
    return true;
  }
  function surge2Internal(o) {
    o.Cv.bpv2 = Cv_bpv2; o.Cv.mk2 = Cv_mk2; o.Cv.psvU2 = Cv_psvU2; o.Cv.xfer2 = Cv_x2;
    o.surge2 = { Psp: Psp2, cap: cap2, D: D2, H: H2, qDd_bpd: qDd2 * 86400, pumpDesign: pumpDesign2, xferDesignDP: dPxD2, Ph: X2.Ph,
      mawp: X2.mawpU, psv: psvCase2 ? deepClone(psvCase2) : null, inv: { oil: uo2, water: uw2, gas: X2.n_u },
      pend: { closeU: pend2.closeU, close2: pend2.close2 }, xferOn: xferOn2,
      cum: { xo1: cum.xo1 || 0, xo2: cum.xo2 || 0 },
      // gas accounting basis: last step's LCV-202 oil and flash basis; volume factors for the transfer-weighted shrink
      gas: { po1: F.po, po2: F2.po, P2A: F2.gP, T2: F2.gT, Rs2: F2.gRs, gvent: F.gvent, PuA: X.PuA, Pu2A: X2.PuA,
        bo1: BoR(X.PuA, X.Tu), bo2: BoR(X2.PuA, X2.Tu), boTank: BoR(PSC, tanks[active].T), boSep: BoR(X.PsepA, X.Tsep),
        gaugeOil: cum.gaugeOil },
      RsE: RsE };
  }
  // setControls → ctl.surge2 (initial: the saved line-up rebuilds t = 0, prefs precedence §3.3; later: XV-202 via its valve)
  function surge2Ctl(src, initial) {
    var C = ctl.surge2;
    if (typeof src.inlet === 'boolean') { if (initial) C.inlet = src.inlet; else surge2Valve(src.inlet, false); }
    if (typeof src.auto === 'boolean') C.auto = src.auto;
    var hiLim = num(cfg.surge2.lshh, 0.9) - 0.02;
    if (isNum(src.sp)) C.sp = clamp(src.sp, 0.3, hiLim);
    if (isNum(src.hyst)) C.hyst = clamp(src.hyst, 0.02, 0.5);
    if (isNum(src.strokeS)) C.strokeS = clamp(src.strokeS, 0, 60);
  }
  function surge2Hist(i) {
    H.k.surge2Frac[i] = rSurge2 ? X2.hU / H2 : 0; H.k.surge2P[i] = rSurge2 ? X2.Pu : 0;
    if (rSurge2) H.k.qgFlare[i] += (F2.bpv + F2.psv) * 0.0864;   // PCV-203 + PSV-202 in the flare trend
  }
  // shrink: transfer-weighted volume factor of the two surge tanks (only once LCV-202 has moved oil)
  function boXfer() {
    var a = cum.xo1, b = cum.xo2;
    return (a * BoR(X.PuA, X.Tu) + b * BoR(X2.PuA, X2.Tu)) / (a + b);
  }
  // snap.surge2 / nodes.surge2 / the five T-202 lines (static values while T-202 is out)
  function surge2Refresh(s) {
    var u = s.surge2, C = cfg.surge2, L = s.lines, tr = u.transfer, TR = X.Tsep + RANK, TRu2 = X2.Tu + RANK;
    u.cap_bbl = cap2; u.D = D2; u.H = H2;
    u.strokeS = ctl.surge2.strokeS; u.auto.on = !!ctl.surge2.auto; u.auto.sp = ctl.surge2.sp; u.auto.hyst = ctl.surge2.hyst;
    u.lsll = num(C.lsll, 0.05); u.lsl = num(C.lsl, 0.25); u.lsh = num(C.lsh, 0.70); u.lshh = num(C.lshh, 0.90);
    u.psv.Cv = Cv_psvU2; tr.design_bpd = pumpDesign2; tr.dPdesign_psi = dPxD2; tr.Cv = Cv_x2; tr.dest = rGauge ? 'gauge' : 'export';
    u.inlet = !!ctl.surge2.inlet;
    if (!rSurge2) {
      var sp = Psp2, spe = isNum(C.Psp) ? sp : X.SPeu;
      u.inRig = false; u.P = spe; u.SP = sp; u.SPeff = spe; u.T = Tamb;
      u.psh = C.psh != null && isNum(+C.psh) ? +C.psh : spe + mmax(0.25 * spe, 7);
      u.pshh = C.pshh != null && isNum(+C.pshh) ? +C.pshh : spe + mmax(0.50 * spe, 15);
      u.mawp = mawp2Of(sp);
      u.h = 0; u.frac = 0; u.hW = 0; u.fracW = 0; u.Vo_bbl = 0; u.Vo_stb = 0; u.Vw_bbl = 0; u.flash_mscfd = 0; u.tFull_s = null;
      u.pos = 0; u.moving = false; u.fill_bpd = 0; u.route = (uv[0] || uv[1]) ? 'surge' : 'none'; u.share = 0; u.Ph = spe;
      u.bpv.u = 0; u.blanket.u = 0; u.blanket.held = false; u.psv.lifting = false;
      tr.on = false; tr.tripped = false; tr.failed = !!faults.xfer2StuckClosed; tr.blocked = false; tr.q_bpd = 0; tr.x = 0; tr.dP_psi = 0;
      tr.sg = SGo; tr.lowDP = false; tr.trip = null; tr.canReset = false; tr.resetBlock = '';
      setLine(L.sep_surge2, 0, qDd2 * 86400, 0, 3.068, false); setLine(L.surge2_gauge, 0, pumpDesign2, 0, SS[5].ID, false);
      setLine(L.surge2_vent, 0, qFlashD2 * 0.0864, 0, 2.067, false); setLine(L.blanket2, 0, pumpDesign2 / 86400 * BBL * 0.0864, 0, 1.049, false);
      setLine(L.psv_surge2, 0, 0, 0, 1.049, false);
      s.nodes.surge2.P = u.P; s.nodes.surge2.T = u.T;
      return;
    }
    u.inRig = true; u.P = X2.Pu; u.SP = Psp2; u.SPeff = X2.SPeu; u.T = X2.Tu; u.psh = X2.pshU; u.pshh = X2.pshhU; u.mawp = X2.mawpU;
    u.h = X2.hU; u.frac = X2.hU / H2; u.hW = uw2 * BBL / At2; u.fracW = u.hW / H2; u.Vo_bbl = uo2 * X2.Bu; u.Vo_stb = uo2; u.Vw_bbl = uw2;
    u.flash_mscfd = F2.flash * 86.4;
    var net = F2.in2 - (F2.po * X2.Bu + F2.pw);
    u.tFull_s = net > 1e-9 ? mmax(0, (C.lshh * cap2 - X2.VliqU) / net) : null;
    u.pos = u2pos; u.moving = u2pos !== surge2Tgt() || hold2; u.fill_bpd = F2.in2 * 86400;
    u.route = routeOf(); u.share = F2.act ? F2.s2 : 0;
    u.Ph = F2.act ? (F2.x1 > 0 ? mmin(X.Pu, X2.Pu) : X2.Pu) : X.Pu;   // both open: the lower vessel pressure (= the dump back-pressure, §5.2)
    u.bpv.u = X2.ubpv; u.blanket.u = X2.ublk; u.blanket.held = F2.held; u.psv.lifting = psvULift2;
    var tId = ptrip.XFER2_DRYRUN ? 'XFER2_DRYRUN' : (ptrip.LSHH_GT ? 'LSHH_GT' : null), rb = tId ? tripBlock(tId) : null;
    tr.on = F2.xCmd > 0; tr.tripped = !!tId; tr.failed = !!faults.xfer2StuckClosed; tr.blocked = pumpBlocked; tr.q_bpd = F2.xBpd; tr.x = F2.xCmd;
    if (!F2.xCmd) F2.xdP = xferDP2();                // shut: the ΔP LCV-202 would see now
    tr.dP_psi = F2.xdP; tr.sg = F2.sg; tr.lowDP = !!(AL.XFER2_LOW_DP && AL.XFER2_LOW_DP.active);
    tr.trip = tId; tr.canReset = !!tId && !rb; tr.resetBlock = rb || '';
    setLine(L.sep_surge2, F2.in2 * 86400, qDd2 * 86400, liqVel(F2.in2 * 86400, 3.068), 3.068, F2.act);
    setLine(L.surge2_gauge, F2.xBpd, pumpDesign2, liqVel(F2.xBpd, SS[5].ID), SS[5].ID, F2.xBpd > 0);
    setLine(L.surge2_vent, F2.bpv * 0.0864, mmax(qFlashD2, 1e-9) * 0.0864, gasVel(F2.bpv, X2.PuA, TRu2, X2.Zu, 2.067), 2.067, X2.ubpv > 0);
    setLine(L.blanket2, F2.blk * 0.0864, pumpDesign2 / 86400 * BBL * 0.0864, gasVel(F2.blk, X.PsepA, TR, X.Zs, 1.049), 1.049, X2.ublk > 0);
    setLine(L.psv_surge2, F2.psv * 0.0864, gq(Cv_psvU2, X2.mawpU + PSC, PSC + cfg.sep.pcv.P2_psig, TRu2, X2.Zu) * 0.0864, 0, 1.049, psvULift2);
    s.nodes.surge2.P = X2.Pu; s.nodes.surge2.T = X2.Tu;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── v1.5.0 foundation (WP-E0; docs/SIM-FOLLOWUP-PLAN.md §3, §5.1-5.2, §6.1, §7) ───
  // Lead-owned: the rig-up rules (normRigup, rigRenorm, rigSideEffects), the steady-case selection (pickSteadyBlock), the live
  // CK-101 outlet (pckLive), the hook sites and the snapshot blocks. The two sections below are WP-E1's and WP-E2's.
  // the CK-102 block of the flow whatever the rig-up (inputs.bean2 / ck2Pos and the static node bean / position read it)
  function ck2BlockOf() { var b = rSep ? flow.ck2 : (isPlainObj(flow.sepBy) ? flow.sepBy.ck2 : null); return isPlainObj(b) ? b : null; }
  // ck2Info(): all WP-E2 reads of CK-102 (the cushion liquid cap, §6.3) — in line, CK-101 / CK-102 beans (64ths), lagged ΔP (psi)
  var CK2I = { act: false, b1: 0, b2: 0, dP: 0 };
  function ck2Info() { CK2I.act = CK2.act; CK2I.b1 = bean; CK2I.b2 = CK2.bean; CK2I.dP = X.ck2dP; return CK2I; }
  // t = 0 (initState): the CK-102 ΔP lag starts at its steady value in 'steady' mode, 0 otherwise; Reset stops a cushion (D5)
  function fuInit() {
    X.ck2dP = mode === 'steady' && CK2.act ? CK2.dPss : 0;
    cushOn = false; cushHas = false; cushFm = 0;
    cushReset();
  }
  // snapshot blocks of v1.5.0 (refresh, always): snap.sepBy, the line / vent totals, snap.cushion (static while no cushion)
  var SEPBY_NOBLOCK = 'no bypass-destination data in this flow: the burner / flare line law (V-101-out back pressure on the separator gas line loss)';
  function fuRefresh(s) {
    var b = plain(cfg.sep.bypass), sb = s.sepBy, c = s.cum;
    sb.dest = b.dest === 'line' ? 'line' : 'flare'; sb.P_psig = num(b.P_psig, 150);
    // P0: the block's while it is used; V-101 in: the inlet the destination would have; V-101 out without a block: the legacy law's
    sb.P0_psig = SEL.sepByBlk !== null ? bypP0 : (rSep && sb.dest === 'line' ? sb.P_psig : bypF0);
    sb.active = !rSep; sb.vent = ventOn;
    if (SEL.sepByBlk === null) sb.note = rSep ? '' : SEPBY_NOBLOCK;   // with a block bypRefresh (WP-E2) owns the note
    c.toLine_gas_mscf = cum.lineGas / 1e3; c.toLine_oil_stb = cum.lineOil; c.toLine_water_bbl = cum.lineWater; c.toVent_gas_mscf = cum.vent / 1e3;
    if (cushHas) cushRefresh(s); else cushSnapOff(s.cushion);
  }
  function cushSnapOff(c) {
    c.on = false; c.phase = 'off'; c.V_bbl = 0; c.SG = 0; c.q_set_bpd = 0; c.q_bpd = 0; c.qcap_bpd = 0; c.WHPtgt_psig = 0; c.column_ft = 0;
    c.Vleft_bbl = 0; c.recovered_bbl = 0; c.fUnload = 0; c.wJT = 0; c.dutyCapped = false; c.tBreak = null;
    c.out.flare = 0; c.out.line = 0; c.out.sep = 0;
  }
  function fuInternal(o) {
    o.fu = { sel: SEL.kind, ck2Note: SEL.ck2Note, P0: SEL.P0, Phi_ss: Phi_ss, Pck_ss: Pck_ss, Ph_ss: Ph_ss, Psep_ss: Psep_ss, ck2dP: X.ck2dP,
      bypF0: bypF0, bypP0: bypP0, bypDP: bypDP, rCk2: rCk2, ck2Act: ck2Act, bypLine: bypLine, ventOn: ventOn, cushOn: cushOn, cushHas: cushHas,
      cushFm: cushFm, CK2: deepClone(CK2), cushS: deepClone(cushS), destKey: destKey };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── CK-102 heater inlet choke (WP-E1) ───
  // docs/SIM-FOLLOWUP-PLAN.md §5. WP-E0 left these hooks with their call sites; WP-E1 fills the bodies in this section only. The
  // guards at the call sites keep the default spread (CK-102 out) on the v1.4.0 path: the per-substep / refresh / history hooks
  // run only while CK2.act || X.ck2dP !== 0, the alarms only while CK2.act.
  //   ck2Derive(sel)               derive(), always   CK2 from sel.ck2blk (reassigned on every derive; the lag lives in X.ck2dP)
  //   ck2Step(h)                   substep            X.ck2dP 5 s lag (cfg.heaterChoke.lagS); snaps to exactly 0 below 1e-9 psi
  //   ck2Pck(Pdn, fi2)             pckLive, history   CK-101 outlet while the lag runs (D11: CK-102 inlet + the seg-3 loss)
  //   ck2Pm(Pdn, fi2)              history, CK2.act   CK-102 inlet Pm (history key Pck2)
  //   ck2Refresh(s)                refresh            nodes.heaterChoke live; N.choke.dTjt / heaterChoke.dTjt (cumulative cap)
  //   ck2Alarms()                  designAlarms       CHOKE2_LIMIT, CK1_SUBCRIT, PAH_CK2, HYD_heaterChoke (MSG entries here)
  //   ck2Rig(phase, old, r, parts) setRigNow / rigSideEffects: 'check' → refusal text ('' = allowed; pure: refresh re-runs it
  //                                while a refusal is stored); 'apply' when CK-102 enters / leaves the rig-up
  //   Phi_ss (E0) = the steady CK-102 outlet (H-101 inlet). The E0 forms below are placeholders: CK2.act stays false (the
  //   steady block values still reach the nodes through pickSteadyBlock), the lag only decays, the alarms are not raised.
  //   Note for WP-E1: in §5.3 "Ph" is read as the CK-102 outlet Phi (Pdn + (Phi_ss − Psep_ss)·fi²), so X.ck2dP is the CK-102
  //   ΔP alone and its decay to 0 after CK-102 leaves is continuous with today's law (the H-101 5 psi drop is not in the lag).
  var CK2 = { act: false, Pm_ss: 0, Ph_ss: 0, dPss: 0, regime: '', bean: 0, b1: 0, pos: 'inlet', flowLimited: false, limiter: '',
    Tin: 0, Tout: 0, noFlow: false, designP: 1440, note: '' };
  function ck2Derive(sel) {
    CK2.act = false; CK2.b1 = bean; CK2.designP = num(cfg.heaterChoke.designP_psig, 1440);
    CK2.note = ck2Act ? (sel.ck2Note || 'no heater-choke data in this flow (in line, ΔP 0)') : '';
  }
  function ck2Step(h) {
    var tau = mmax(0.1, num(cfg.heaterChoke.lagS, 5));
    X.ck2dP += (0 - X.ck2dP) * (1 - mexp(-h / tau));
    if (mabs(X.ck2dP) < 1e-9) X.ck2dP = 0;
  }
  function ck2Pck(Pdn, fi2) { return Pdn + (Phi_ss - Psep_ss) * fi2 + X.ck2dP + SS[2].dP * fi2; }
  function ck2Pm(Pdn, fi2) { return Pdn + (Phi_ss - Psep_ss) * fi2 + X.ck2dP; }
  function ck2Refresh(s) { /* WP-E1: nodes.heaterChoke live values */ }
  function ck2Alarms() { /* WP-E1 (§5.5) */ }
  function ck2Rig(phase, old, r, parts) {
    if (phase === 'check') return '';
    if (old.heaterChoke && !r.heaterChoke) quiet(Q_CK2);       // leaving: its alarms clear; X.ck2dP decays to 0 (no step, U3)
    else if (!old.heaterChoke && r.heaterChoke) X.ck2dP = 0;   // entering: the lag starts from 0 (§3.3)
    return '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── Bypass destination + cushion (WP-E2) ───
  // docs/SIM-FOLLOWUP-PLAN.md §6. WP-E0 left these hooks with their call sites; WP-E2 fills the bodies in this section only and
  // reads CK-102 only through ck2Info(). Guards: bypLine / ventOn (accounting), SEL.sepByBlk (pDown, refresh), !rSep (alarms),
  // cushOn (every cushion hook; a closure boolean set only by startCushion / stopCushion / reset — never by derive()).
  //   bypDerive(sel)               derive(), always     bypP0 / bypDP from sel (E2: Bg5, the P0-mismatch note)
  //   bypPDown(fg)                 pDown, sepByBlk      P0 + seg-5 loss · f² (E2: the cushion mixture-rate fraction cushFm)
  //   bypAccount(h, byG, byO, byW, qRel)  substep, bypLine || ventOn   line totals; relief / vent gas (qRel) to vent with ventOn
  //   bypRefresh(s, fg)            refresh, sepByBlk    flare node Pline / flame / label, snap.sepBy.note
  //   bypAlarms()                  processAlarms, !rSep PSHH_SEPBY (trips SDV-101), SEPBY_RATING
  //   cushStart(o) / cushStop()    api                  {ok, msg, warn} / bool (E0: refused, 'not available yet')
  //   cushDerive()                 derive, cushOn       cushion constants of a new flow (SIT, Bgwh, qRes_ss)
  //   cushInW()                    substep, cushOn      delivered cushion water entering V-101 / the line (bbl/s)
  //   cushStep(h, aF)              substep, cushOn      rate targets + the delivered-water lag (replaces the v1.4.0 target lines)
  //   cushWhp(tgtW)                substep, cushOn      WHP target (column law, blend to tgtW after breakthrough)
  //   cushChooseH(c)               chooseH, cushOn      breakthrough located on the delivered volume
  //   cushVel(i, ss)               refresh, cushOn      liquid velocity term of segment i (ft/s)
  //   cushAlarms()                 processAlarms, cushOn CUSH_LIMIT, CUSH_NOLIFT, CUSH_BURNER, CUSH_DUMP, HTR_FULL
  //   cushBalance(op, o)           zeroCum ('zero', o = cum) / setRef ('ref', o = ref)
  //   cushRefresh(s)               fuRefresh, cushHas   snap.cushion live
  //   cushReset()                  fuInit (initState)   cushS back to 'off'
  // cushS: the cushion state (a closure object, not on X, never touched by derive()); cushS.SG (water dump, D8), cushS.qNow
  // (warm-up, D8) and cushS.wJTe (J-T weight, D8) are read by E0 hook sites while cushOn. cushFm: the mixture-rate fraction.
  var cushS = { phase: 'off', V: 0, SG: 1, qSet: 0, cap: 0, depth: 0, Gr: 0, gasFrac: 0, tailFrac: 0, tailTau: 0, breakTau: 0, Vmain: 0, Vtail: 0,
    Vprod: 0, qNow: 0, qDel: 0, fUnload: 0, WHPcol: 0, wJTc: 0, wJTe: 1, tStart: 0, tBreak: null, tPhase: 0, out: { flare: 0, line: 0, sep: 0 } };
  var cushFm = 0;
  function bypDerive(sel) { bypP0 = sel.P0; bypDP = sel.sepByBlk !== null ? SS[4].dP : 0; }
  function bypPDown(fg) { return bypP0 + bypDP * fg * fg; }
  function bypAccount(h, byG, byO, byW, qRel) {
    if (bypLine) { cum.lineGas += byG * h; cum.lineOil += byO * h; cum.lineWater += byW * h; }
    else { cum.flare += byG * h; cum.ltfOil += byO * h; cum.ltfWater += byW * h; }
    if (ventOn) cum.vent += qRel * h; else cum.flare += qRel * h;
  }
  function bypRefresh(s, fg) { s.sepBy.note = ''; }
  function bypAlarms() { /* WP-E2 (§6.2, D16) */ }
  function cushStart(o) { return { ok: false, msg: 'not available yet', warn: '' }; }
  function cushStop() { return false; }
  function cushDerive() { /* WP-E2 */ }
  function cushInW() { return 0; }
  function cushStep(h, aF) {                        // placeholder = the v1.4.0 target lines (never reached while E0 refuses a start)
    if (rDes) { var sCk = DX.s; X.qBg += (qgE * sCk - X.qBg) * aF; X.qBo += (qoE * sCk - X.qBo) * aF; X.qBw += (qwE * sCk - X.qBw) * aF; }
    else { X.qBg += (qgE - X.qBg) * aF; X.qBo += (qoE - X.qBo) * aF; X.qBw += (qwE - X.qBw) * aF; }
  }
  function cushWhp(tgtW) { return tgtW; }
  function cushChooseH(c) { /* WP-E2 */ }
  function cushVel(i, ss) { return 0; }
  function cushAlarms() { /* WP-E2 (§6.3) */ }
  function cushBalance(op, o) { /* WP-E2 */ }
  function cushRefresh(s) { cushSnapOff(s.cushion); }
  function cushReset() {
    var c = cushS;
    c.phase = 'off'; c.V = 0; c.SG = 1; c.qSet = 0; c.cap = 0; c.depth = 0; c.Gr = 0; c.gasFrac = 0; c.tailFrac = 0; c.tailTau = 0; c.breakTau = 0;
    c.Vmain = 0; c.Vtail = 0; c.Vprod = 0; c.qNow = 0; c.qDel = 0; c.fUnload = 0; c.WHPcol = 0; c.wJTc = 0; c.wJTe = 1; c.tStart = 0; c.tBreak = null;
    c.tPhase = 0; c.out.flare = 0; c.out.line = 0; c.out.sep = 0;
  }

  Object.defineProperty(api, 'disposed', { get: function () { return disposed; } });
  // test/diagnostic hook (not part of the contract; used by self-tests only); desInternal / surge2Internal extend it
  Object.defineProperty(api, '_internal', { value: function () { var o = { cfg: deepClone(cfg), Cv: { pcv: Cv_pcv, o: Cv_o, w: Cv_w, bpv: Cv_bpv, mk: Cv_mk, psvU: Cv_psvU, xfer: Cv_x },
    pumpDesign: pumpDesign, drainBpd: drainBpd, xferDesignDP: dPxD, geom: { Hu: Hu, Hg: Hg }, rigRefused: rigRefused };
    desInternal(o); surge2Internal(o); fuInternal(o); return o; } });

  // ── construct ──
  destKey = destKeyNow();                       // v1.5.0: the destination the first applyRig used (rigRenorm compares with it)
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
// ─── DS-101 desander / sand: pure helpers (WP-E1; docs/SIM-EQUIPMENT-PLAN.md §4.2; exported as WTS_sim.sand) ───
// Field units unless stated. No state: the sim factory builds its tables and coefficients from these.
//   etot(d50c, d50, sigmaG, m)           overall capture of a log-normal size distribution (median d50 µm, geometric spread
//                                        sigmaG) over the grade-efficiency curve E(d) = 1 − exp(−ln2·(d/d50c)^m) (closed
//                                        accumulator: no bypass fraction); 64-point quadrature z = −4…+4
//   cut(mu_cp, drho, v_fts, o?)          cut size d50c (µm) from the velocity law d50c = d50ref·√((μ/μref)·(Δρref/Δρ)·(vref/v))
//                                        (25 µm at 30 ft/s, 1 cP, Δρ 103 lb/ft³; o overrides d50ref_um / vref_fts / muRef_cp / drhoRef)
//   dp(rho, v_fts, K?)                   ΔP (psi) = K·ρ·v²/9266.1 (inlet velocity head, K 6)
//   erosionReducer(W_lbd, Up_ms, D1_m, D2_m, dp_um, rhoM_kgm3, o?)  steel-equivalent erosion rate (mm/yr) of the
//                                        DNV-RP-O501 reducer model (o: K 2.0e-9, n 2.6, rhoT 7,800 kg/m³, alphaDeg 60); dp_um null → C2 = 1
//   muDeadOil(API, T_F)                  dead-oil viscosity (cP; T clamped to 40–400 °F so the correlation stays finite)
//   muGas(SGg, T_F, Z, P_psia)           gas viscosity (cP), Lee-Gonzalez-Eakin (same formula as 16-pvt.js; local copy — the
//                                        engine loads stand-alone)
//   c2(d_um, rhoM_kgm3)                  DNV particle-size factor min(1, d / (30·√ρm))
//   mixSound(gvf, rhoG, cG, rhoL, cL)    homogeneous-mixture speed of sound 1/(ρm·c²) = Σ αi/(ρi·ci²) (the liquid term only
//                                        when gvf < 1); any consistent units
var SAND_LN2 = 0.693147, SAND_NQ = 64, SAND_NX = 101, SAND_X0 = -3, SAND_DX = 0.05;
var SAND_Z = [], SAND_W = [];
for (var sq = 0; sq < SAND_NQ; sq++) { var sz = -4 + 8 * (sq + 0.5) / SAND_NQ; SAND_Z.push(sz); SAND_W.push(Math.exp(-sz * sz / 2)); }
function sandE(d, d50c, m) { return 1 - Math.exp(-SAND_LN2 * Math.pow(d / d50c, m)); }
function sandEtot(d50c, d50, sigmaG, m) {
  d50c = +d50c; d50 = +d50; sigmaG = +sigmaG; m = isNum(+m) && m > 0 ? +m : 2;
  if (!(d50 > 0)) return 0;
  if (!(d50c > 0)) return 1;
  var ls = Math.log(sigmaG > 1 ? sigmaG : 1), s = 0, w = 0;
  for (var k = 0; k < SAND_NQ; k++) { s += SAND_W[k] * sandE(d50 * Math.exp(SAND_Z[k] * ls), d50c, m); w += SAND_W[k]; }
  return s / w;
}
function sandCut(mu_cp, drho, v_fts, o) {
  o = isPlainObj(o) ? o : {};
  var dr = num(o.d50ref_um, 25), vr = num(o.vref_fts, 30), mr = num(o.muRef_cp, 1), rr = num(o.drhoRef, 103);
  var mu = mmax(num(mu_cp, 1), 1e-6), d = mmax(num(drho, rr), 1), v = mmax(num(v_fts, vr), 0.1);
  return dr * msqrt((mu / mr) * (rr / d) * (vr / v));
}
function sandDp(rho, v_fts, K) { var k = isNum(+K) && K !== null ? +K : 6; return k * num(rho, 0) * num(v_fts, 0) * num(v_fts, 0) / 9266.1; }
function sandC2(d_um, rhoM_kgm3) { var r = mmax(num(rhoM_kgm3, 0), 1e-9); return mmin(1, mmax(0, num(d_um, 0)) / (30 * msqrt(r))); }
var DNV_A = [9.37, 42.295, 110.864, 175.804, 170.137, 98.398, 31.211, 4.17];
function dnvF(alphaDeg) {
  var a = num(alphaDeg, 60) * PI / 180, F = 0, p = a;
  for (var i = 0; i < 8; i++) { F += (i % 2 ? -1 : 1) * DNV_A[i] * p; p *= a; }
  return F;
}
function sandErosionReducer(W_lbd, Up_ms, D1_m, D2_m, dp_um, rhoM_kgm3, o) {
  o = isPlainObj(o) ? o : {};
  var K = num(o.K, 2.0e-9), n = num(o.n, 2.6), rhoT = num(o.rhoT, 7800), al = num(o.alphaDeg, 60);
  var D1 = num(D1_m, 0), D2 = num(D2_m, 0), W = mmax(num(W_lbd, 0), 0), U = mmax(num(Up_ms, 0), 0);
  if (!(D1 > D2) || !(D2 > 0) || !(W > 0) || !(U > 0)) return 0;
  var a = al * PI / 180, At = PI / (4 * msin(a)) * (D1 * D1 - D2 * D2), Ar = 1 - D2 * D2 / (D1 * D1);
  var C2 = (dp_um === null || dp_um === undefined) ? 1 : sandC2(dp_um, rhoM_kgm3);
  return W * 0.45359237 / 86400 * K * dnvF(al) * mpow(U, n) / (rhoT * At) * Ar * C2 * 3.15e10;
}
function sandMuDeadOil(API, T_F) {
  var T = clamp(num(T_F, 150), 40, 400), x = mpow(10, 3.0324 - 0.02023 * num(API, 35)) * mpow(T, -1.163);
  return mpow(10, x) - 1;
}
function sandMuWater(T_F) { var T = clamp(num(T_F, 150), 32, 400); return mexp(1.003 - 1.479e-2 * T + 1.982e-5 * T * T); }
function sandMuGas(SGg, T_F, Z, P_psia) {
  var sg = num(SGg, 0.65), TR = num(T_F, 60) + RANK, z = num(Z, 1), P = mmax(num(P_psia, PSC), 0);
  if (!(TR > 0) || !(z > 0) || !(sg > 0)) return 0.012;
  var M = 28.9647 * sg, K = (9.4 + 0.02 * M) * mpow(TR, 1.5) / (209 + 19 * M + TR), Xv = 3.5 + 986 / TR + 0.01 * M, Y = 2.4 - 0.2 * Xv;
  var rho = 1.4935e-3 * (P * M) / (z * TR);
  return 1e-4 * K * mexp(Xv * mpow(rho, Y));
}
function sandMixSound(gvf, rhoG, cG, rhoL, cL) {
  var a = clamp(num(gvf, 1), 0, 1), comp = 0, rm = 0;
  if (a > 0) { var rg = mmax(num(rhoG, 0), 1e-9), cg = mmax(num(cG, 0), 1e-9); comp += a / (rg * cg * cg); rm += a * rg; }
  if (a < 1) { var rl = mmax(num(rhoL, 0), 1e-9), cl = mmax(num(cL, 0), 1e-9); comp += (1 - a) / (rl * cl * cl); rm += (1 - a) * rl; }
  return comp > 0 && rm > 0 ? msqrt(1 / (comp * rm)) : 0;
}
// tables over x = log10(d50c/d50) from −3 to +2 (step 0.05, 101 points) for one size distribution: overall capture E,
// particle-size factor C2 of the sand the cyclone passes (C2p) and of the inlet sand (C2in, mass-weighted)
function sandTables(d50, sigmaG, m, rhoM_kgm3) {
  var E = new Float64Array(SAND_NX), C2p = new Float64Array(SAND_NX), ls = Math.log(sigmaG > 1 ? sigmaG : 1), dk = [], ck = [], k, i;
  var w = 0, wc = 0;
  for (k = 0; k < SAND_NQ; k++) { dk.push(d50 * Math.exp(SAND_Z[k] * ls)); ck.push(sandC2(dk[k], rhoM_kgm3)); w += SAND_W[k]; wc += SAND_W[k] * ck[k]; }
  var C2in = wc / w;
  for (i = 0; i < SAND_NX; i++) {
    var d50c = d50 * mpow(10, SAND_X0 + SAND_DX * i), se = 0, wp = 0, wpc = 0;
    for (k = 0; k < SAND_NQ; k++) { var e = sandE(dk[k], d50c, m), wk = SAND_W[k]; se += wk * e; wp += wk * (1 - e); wpc += wk * (1 - e) * ck[k]; }
    E[i] = se / w; C2p[i] = wp > 1e-300 ? wpc / wp : ck[SAND_NQ - 1];
  }
  return { E: E, C2p: C2p, C2in: C2in };
}
function sandInterp(tab, x) {
  var u = (x - SAND_X0) / SAND_DX;
  if (!(u > 0)) return tab[0];
  if (u >= SAND_NX - 1) return tab[SAND_NX - 1];
  var i = mfloor(u), f = u - i;
  return tab[i] + (tab[i + 1] - tab[i]) * f;
}
var SAND_API = deepFreeze({ etot: sandEtot, cut: sandCut, dp: sandDp, erosionReducer: sandErosionReducer, muDeadOil: sandMuDeadOil,
  muGas: sandMuGas, c2: sandC2, mixSound: sandMixSound });

G.WTS_sim = {
  VERSION: '1.5.0',
  features: FEATURES,
  TAGS: TAGS,
  NAMES: NAMES,
  NULLABLE: NULLABLE,
  DEFAULTS: DEFAULTS,
  SAMPLE_FLOW: SAMPLE_FLOW,
  FAULTS: deepFreeze(FAULT_IDS.map(function (id) { return { id: id, label: FAULT_LABELS[id] }; })),
  RIG_KEYS: deepFreeze(RIG_KEYS.slice()),
  RIGUP: RIG_ITEMS,
  RIG_DEFAULTS: RIG_DEFAULTS,
  RIG_OPTIONAL: RIG_OPTIONAL,
  normRigup: normRigup,
  NODE_IDS: deepFreeze(NODE_IDS.slice()),
  HIST_KEYS: deepFreeze(HIST_KEYS.slice()),
  stepFor: stepFor,
  sand: SAND_API,
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
  var LN = ['wh_esd', 'esd_choke', 'choke_heater', 'heater_sep', 'sep_flare', 'sep_water', 'sep_oil', 'surge_gauge', 'surge_vent', 'blanket', 'gauge_drain', 'gauge_vent', 'psv_sep', 'psv_surge',
    'sep_surge2', 'surge2_gauge', 'surge2_vent', 'blanket2', 'psv_surge2', 'ds_dump'];
  if (Object.keys(st.lines).join() !== LN.join()) bad.push('line names ' + Object.keys(st.lines).length);
  if (Object.keys(st.nodes).join() !== 'wellhead,esd,choke,heater,separator,flare,surge,gauge,desander,surge2,heaterChoke') bad.push('node order');
  if (!st.desander || !st.sand || !st.surge2 || typeof st.health.massErr.sand !== 'number') bad.push('v1.4.0 blocks');
  if (!st.sepBy || !st.cushion || !st.nodes.heaterChoke || ['off', 'unloading', 'stalled', 'breakthrough', 'tail', 'done'].indexOf(st.cushion.phase) < 0 ||
    ['flare', 'line'].indexOf(st.sepBy.dest) < 0) bad.push('v1.5.0 blocks');
  ['toLine_gas_mscf', 'toLine_oil_stb', 'toLine_water_bbl', 'toVent_gas_mscf'].forEach(function (k) { if (typeof st.cum[k] !== 'number') bad.push('cum.' + k); });
  if (st.rigup.sig.length !== 11 || !Array.isArray(st.rigup.extras)) bad.push('rigup sig / extras');
  LN.forEach(function (k) {
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
// best of 2 runs (the default spread): one slow run on a busy machine or a cold vm is not a regression
test('14 performance', function () {
  var best = Infinity;
  for (var r = 0; r < 2 && best >= 500; r++) {
    var sim = S.create(F0, { seed: 14 }), a = Date.now();
    run(sim, 4 * 3600, 10);
    best = Math.min(best, Date.now() - a);
  }
  assert(best < 500, '4 h at dt 10 took ' + best + ' ms (best of 2)'); return { msg: best + ' ms' };
});
// 15 Batch accuracy
test('15 batch accuracy', function () {
  // handlers run at the end of advance(); reconstruct cum at the switch instant: the newly active
  // compartment was 'ready' (static) before the switch, so everything it gained since is post-switch oil.
  // instantaneous divert valves (stroke 0): the fill windows open and close at the switch instant; with travel
  // they overlap by the stroke (see 25)
  var sim = S.create(F0, { seed: 15, config: { gauge: { xvStrokeS: 0 } } }), atSwitch = { 0: 0 }, bs = [], before = [0, 0];
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
// 25 Divert valve travel: open-new-before-close-old, the old window closes one stroke after the new valve is open
test('25 divert valve travel', function () {
  var sim = S.create(F0, { seed: 25, config: { noise: { on: false } } }), sw = [], bs = [];
  var stroke = S.DEFAULTS.gauge.xvStrokeS;
  sim.on('switch', function (p) { sw.push(p.t); }); sim.on('batch', function (p) { bs.push(p); });
  var minSum = 2;
  run(sim, 4 * 3600, 1, function (st) { var T = st.gauge.tanks; if (st.surge.pump.q_bpd > 0) minSum = Math.min(minSum, T[0].pos + T[1].pos); });
  assert(sw.length >= 1 && bs.length >= 1, 'switches ' + sw.length + ' batches ' + bs.length);
  assert(minSum >= 1 - 1e-9, 'a flow path is always fully open while P-201 runs (min Σpos ' + minSum + ')');
  var b = bs[0];
  near(b.tClose - sw[0], 2 * stroke, 1e-6, 'window closes 2 strokes after the switch command (new opens, then old closes)');
  near(b.closeOil_stb - b.openOil_stb, b.oil_stb, 1e-6, 'tank Δ = batch oil');
});

// 26 Rig-up: normRigup rules; every single-item removal (and both tanks out) keeps the exact mass balance, a finite
// snapshot and no trip
test('26 rig-up', function () {
  var n = S.normRigup({ esd: false, choke: false, separator: false, flare: false, gauge: false });
  assert(n.rig.esd && n.rig.choke && n.rig.flare && !n.rig.separator && !n.rig.gauge && !n.rig.pump, 'rules ' + JSON.stringify(n.rig));
  assert(n.notes.length >= 4 && !n.full && S.normRigup({}).full && S.normRigup({}).notes.length === 0, 'notes / full');
  var cfg = { noise: { on: false } };
  var n2 = S.normRigup({ surge2: true, surge: false });
  assert(!n2.rig.surge2 && n2.notes.some(function (x) { return /T-202 works alongside T-201/.test(x); }), 'T-202 needs T-201');
  [{ heater: false }, { separator: false }, { surge: false }, { gauge: false }, { surge: false, gauge: false }, { pump: false }, { flare: false },
    { desander: true }, { surge2: true }, { surge2: true, surge: false }, { desander: true, sand: 10 }, { sand: 10 }].forEach(function (r) {
    var sim = S.create(F0, { seed: 26, config: r.sand ? { noise: { on: false }, sand: { pptb: r.sand } } : cfg, rigup: r });
    run(sim, 3600, 20);
    var st = sim.getState(), m = st.health.massErr, key = JSON.stringify(r);
    if (r.desander || r.surge2) assert(st.rigup.desander === !!r.desander && st.rigup.surge2 === !!(r.surge2 && r.surge !== false), key + ' optional items ' + st.rigup.sig);
    assert(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9 && m.sand < 1e-9, key + ' mass ' + JSON.stringify(m));
    var bad = schemaOK(st); assert(bad.length === 0, key + ' schema ' + bad.join(';'));
    assert(!st.esd.tripped, key + ' trip ' + st.esd.cause);
    if (r.sand) assert(st.sand.on && st.sand.cum.in_lb > 0 && (r.desander ? st.desander.sand.acc_lb > 0 && st.sand.choke.band === 'ok' : st.sand.choke.band === 'warn'), key + ' sand ' + st.sand.choke.band);
  });
});
// 27 LCV-201: the surge → gauge transfer is pressure-driven (no pump): q = Cv·√(ΔP/SG)
test('27 pressure transfer', function () {
  var sim = S.create(F0, { seed: 27, config: { noise: { on: false } } }), p = null;
  for (var i = 0; i < 720 && !p; i++) { sim.advance(5); var x = sim.getState().surge.transfer; if (x.q_bpd > 0) p = x; }
  assert(p && p.mode === 'pressure' && p.tag === 'LCV-201', 'transfer');
  near(p.q_bpd, p.Cv * Math.sqrt(p.dP_psi / p.sg) * 34.2857, 1e-6 * p.q_bpd, 'q = Cv·√(ΔP/SG)');
  var st = sim.getState();
  assert(st.surge.pump === st.surge.transfer && st.gauge.pump.tag === 'P-201' && st.gauge.pump.dest === 'export', 'aliases');
});

// 28 Optional rig-up items (v1.4.0): DS-101 / T-202 out by default; a missing key takes the item's default, an optional item is in
// only when strictly true; sig appends desander, surge2; full counts core items only; stepFor; 10-key request; API stubs
test('28 optional rig-up items', function () {
  var d = S.normRigup({});
  assert(d.sig === '11111111000' && d.full && d.extras.length === 0 && d.notes.length === 0 && !d.rig.desander && !d.rig.surge2 && !d.rig.heaterChoke, 'default ' + d.sig);
  var v33 = S.normRigup({ esd: true, choke: true, heater: true, separator: true, surge: true, gauge: true, pump: true, flare: true });
  assert(v33.sig === '11111111000', 'an 8-key (v1.3.0) request leaves the optional items out');
  ['yes', 1, null, 'true', {}].forEach(function (x) { assert(!S.normRigup({ desander: x, surge2: x }).rig.desander, 'non-true ' + JSON.stringify(x)); });
  var b = S.normRigup({ desander: true, surge2: true, heater: false });
  assert(b.sig === '11011111110' && !b.full && b.extras.join() === 'desander,surge2', 'both in ' + b.sig + ' ' + b.extras);
  assert(S.normRigup({ desander: true }).full === true, 'full ignores optional items');
  assert(JSON.stringify(S.RIG_DEFAULTS) === '{"esd":true,"choke":true,"heater":true,"separator":true,"surge":true,"gauge":true,"pump":true,"flare":true,"desander":false,"surge2":false,"heaterChoke":false}', 'RIG_DEFAULTS');
  assert(S.RIG_OPTIONAL.join() === 'desander,surge2,heaterChoke' && S.RIGUP.length === 11 && S.RIG_KEYS.length === 11 && S.VERSION === '1.5.0', 'exports');
  assert(S.RIGUP.map(function (it) { return it.key; }).join() === 'esd,desander,choke,heaterChoke,heater,separator,surge,surge2,gauge,pump,flare', 'display order');
  var st0 = S.stepFor({}), st1 = S.stepFor({ desander: true }), st2 = S.stepFor({ surge2: true }), st3 = S.stepFor({ desander: true, surge2: true });
  assert(st0.choke === '③' && st0.pump === '⑨' && !st0.desander && !st0.surge2, 'stepFor default');
  assert(st1.desander === '③' && st1.choke === '④' && st1.pump === '⑩', 'stepFor DS-101');
  assert(st2.surge2 === '⑧' && st2.gauge === '⑨' && st2.pump === '⑩', 'stepFor T-202');
  assert(st3.pump === '⑪' && S.stepFor({ desander: 'yes' }).choke === '③', 'stepFor both / strict true');
  var sim = S.create(F0, { seed: 28, rigup: { heater: false } }), st = sim.getState();
  assert(JSON.stringify(sim.getRigup()) === '{"esd":true,"choke":true,"heater":false,"separator":true,"surge":true,"gauge":true,"pump":true,"flare":true,"desander":false,"surge2":false,"heaterChoke":false}', 'getRigup ' + JSON.stringify(sim.getRigup()));
  var ev = []; sim.on('rigup', function (p) { ev.push(p); });
  assert(sim.setRigup({ desander: true, surge2: true }) === true, 'set');
  st = sim.getState();
  assert(st.rigup.desander && st.rigup.surge2 && st.rigup.sig === '11011111110' && st.rigup.extras.join() === 'desander,surge2' && st.desander.inRig && st.surge2.inRig, 'snapshot ' + st.rigup.sig);
  assert(ev.length === 1 && ev[0].extras.join() === 'desander,surge2' && /DS-101 in line upstream of the choke/.test(ev[0].msg) && /T-202 in the rig-up/.test(ev[0].msg), 'event ' + (ev[0] && ev[0].msg));
  assert(sim.setRigup({ desander: null }) === true && sim.getState().rigup.desander === false, 'null → the item default (out)');
  assert(sim.setRigup({ surge: false }) === true && sim.getState().rigup.surge2 === false && sim.getRigup().surge2 === true, 'D11: request kept, effective out');
  var dd = sim.dumpDesander(), sr = sim.setSurgeRoute('surge2');
  assert(dd && dd.ok === false && sr && sr.ok === false && sim.setDesander({ bypass: true }) === false && sim.setValve('surge2', 0, true) === false, 'API stubs');
  var c = sim.getControls();
  assert(JSON.stringify(Object.keys(c)) === '["surge","gauge","surge2","desander","v"]' && c.surge2.inlet === false && c.desander.bypass === false, 'controls ' + JSON.stringify(c));
  var s2 = S.create(F0, { seed: 28 }); s2.setControls({ surge: c.surge, gauge: c.gauge, surge2: { inlet: true, sp: 0.7 }, desander: { auto: true, sp: 2 } }, { initial: true });
  var c2 = s2.getControls(); assert(c2.surge2.inlet === true && c2.surge2.sp === 0.7 && c2.desander.auto === true && c2.desander.sp === 0.95, 'setControls new keys ' + JSON.stringify(c2));
  var bad = schemaOK(st); assert(bad.length === 0, 'schema ' + bad.join(';'));
});
// 29 T-202 (WP-E2): routes, pressure-driven split, LCV-202, LSHH-202 without an ESD, balances
test('29 T-202 second surge tank', function () {
  var F2s = JSON.parse(JSON.stringify(F0)); F2s.sim.surge2Cap_bbl = 20;
  var sim = S.create(F2s, { seed: 29, config: { noise: { on: false } }, rigup: { surge2: true } }), st = sim.getState();
  assert(st.surge2.inRig && !st.surge2.inlet && st.surge2.frac === 0 && st.surge2.route === 'surge', 'standby ' + st.surge2.route);
  var r = sim.setSurgeRoute('both');
  assert(r.ok && sim.getState().surge2.route === 'both', 'route both ' + r.msg);
  run(sim, 1800, 10);
  st = sim.getState();
  assert(st.surge2.share > 0.2 && st.surge2.share < 0.8 && st.surge2.frac > 0, 'split ' + st.surge2.share);
  sim.setFault('xfer2StuckClosed', true);
  run(sim, 3 * 3600, 10);
  st = sim.getState();
  var lshh = st.alarms.filter(function (a) { return a.id === 'LSHH_SURGE2'; }).length + st.alarmLog.filter(function (a) { return a.id === 'LSHH_SURGE2'; }).length;
  assert(lshh > 0 && !st.surge2.inlet && st.surge2.route === 'surge' && !st.esd.tripped, 'LSHH-202 closes XV-202 without an ESD ' + st.surge2.route);
  var m = st.health.massErr;
  assert(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'mass ' + JSON.stringify(m));
  assert(sim.setRigup({ surge2: false }) === true && sim.getState().surge2.inRig === false, 'out');
  run(sim, 600, 10);
  m = sim.getState().health.massErr;
  assert(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'mass out ' + JSON.stringify(m));
});
// 30 v1.5.0 foundation (docs/SIM-FOLLOWUP-PLAN.md WP-E0): CK-102 rig-up item and its rules, the destination rule (V-101 + FS-401
// out only to a production line, re-forced through setConfig and setFlow), the new snapshot blocks, history keys, features,
// the cushion API stubs, and the default spread unchanged with the new SAMPLE_FLOW.sim keys
test('30 v1.5.0 foundation', function () {
  assert(S.features.heaterChoke === true && S.features.bypassDest === true && S.features.cushion === true, 'features');
  assert(S.DEFAULTS.sep.bypass.P_flare_psig === S.DEFAULTS.sep.pcv.P2_psig && S.DEFAULTS.heaterChoke.lagS === 5 && S.DEFAULTS.cushion.V_bbl === 50, 'DEFAULTS');
  var k = S.normRigup({ heaterChoke: true });
  assert(k.sig === '11111111001' && k.extras.join() === 'heaterChoke' && k.full && S.stepFor({ heaterChoke: true }).heater === '⑤', 'CK-102 in ' + k.sig);
  var kh = S.normRigup({ heaterChoke: true, heater: false });
  assert(!kh.rig.heaterChoke && kh.notes.some(function (x) { return /CK-102 sits on the H-101 inlet/.test(x); }), 'CK-102 needs H-101');
  var nf = S.normRigup({ separator: false, flare: false }), nl = S.normRigup({ separator: false, flare: false }, { sepByDest: 'line', P: 300 });
  assert(nf.rig.flare === true && nl.rig.flare === false && nl.notes.some(function (x) { return /production line at 300 psig/.test(x); }), 'destination rule');
  var sim = S.create(F0, { seed: 30, rigup: { separator: false, flare: false } }), ev = [];
  sim.on('rigup', function (p) { ev.push(p); });
  assert(sim.getState().rigup.flare === true, 'dest flare forces FS-401 in');
  sim.setConfig({ sep: { bypass: { dest: 'line', P_psig: 300 } } });
  assert(sim.getState().rigup.flare === false && sim.getState().sepBy.dest === 'line' && sim.getState().sepBy.vent === true && ev.length === 1, 'line: FS-401 may be out');
  run(sim, 600, 10);
  var c = sim.getState().cum, m = sim.getState().health.massErr;
  assert(c.toLine_gas_mscf > 0 && c.toLine_oil_stb > 0 && Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'line totals / balance ' + JSON.stringify(m));
  sim.setConfig({ sep: { bypass: { dest: null } } });                     // back to the flow's destination ('flare')
  assert(sim.getState().rigup.flare === true && ev.length === 2, 'setConfig line → flare re-forces FS-401');
  var s3 = S.create(F0, { seed: 31, rigup: { separator: false, flare: false } }), f3 = JSON.parse(JSON.stringify(F0));
  f3.sim.sepByDest = 'line'; s3.setFlow(f3);
  assert(s3.getState().rigup.flare === false, 'setFlow → line');
  f3 = JSON.parse(JSON.stringify(f3)); f3.sim.sepByDest = 'flare'; s3.setFlow(f3);
  assert(s3.getState().rigup.flare === true, 'setFlow line → flare re-forces FS-401');
  var s4 = S.create(F0, { seed: 32, rigup: { heaterChoke: true } }), st = s4.getState();
  assert(st.nodes.heaterChoke.inRig && !st.nodes.heaterChoke.active && st.nodes.heaterChoke.P === st.nodes.choke.P && st.inputs.bean2 === null, 'static CK-102 node');
  assert(s4.startCushion({}).ok === false && s4.stopCushion() === false && s4.getCushion().phase === 'off', 'cushion stubs');
  run(s4, 600, 10);
  assert(s4.getHistory('Pck2').y.length > 0 && s4.getHistory('cushionLeft').y.every(function (y) { return y === 0; }), 'history keys');
  var bad = schemaOK(s4.getState()); assert(bad.length === 0, 'schema ' + bad.join(';'));
  assert(s4.setRigup({ heater: false }) === true && s4.getState().rigup.heaterChoke === false && s4.getRigup().heaterChoke === true, 'H-101 out takes CK-102 out');
});

var pass = results.filter(function (r) { return r.ok; }).length;
results.forEach(function (r) { if (!r.ok || (typeof process !== 'undefined' && process.env && process.env.WTS_VERBOSE)) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.msg ? ' — ' + r.msg : '')); });
console.log('[31-wts-sim] self-test ' + pass + '/' + results.length + ' passed (' + (Date.now() - t0all) + ' ms)');
if (pass !== results.length && typeof process !== 'undefined') process.exitCode = 1;
})();
