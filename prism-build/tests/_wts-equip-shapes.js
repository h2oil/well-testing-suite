// prism-build/tests/_wts-equip-shapes.js — Simulator equipment executable contract (WP0, FROZEN).
//
// Plan: docs/SIM-EQUIPMENT-PLAN.md §6 (interfaces, exact), §6.11 (this fixture), §3 (rig-up model), §4.8 / §5.5 (alarms),
// §4.9 (worked numbers = test anchors), §7 / §9.2 (frozen v3.3 engine). Changes only through the lead, together with the plan.
// Items: DS-101 cyclonic wellhead desander (upstream of the choke) and T-202 second surge tank; both optional rig-up items,
// out by default. Field units throughout.
//
// Exports
//   PLAN, VERSION_V33 '1.3.0', VERSION_NEW '1.4.0', PROBE_VERSION '9.9.9-probe'
//   RIG_KEYS_V33 / RIG_KEYS (10, signature order, append only) / RIG_ORDER (display = process order, by key)
//   RIG_ITEMS_NEW (the two new RIG_ITEMS rows), RIG_DEFAULTS, RIG_OPTIONAL, SIG_V33, SIG_DEFAULT, GETRIGUP_DEFAULT_JSON
//   RIG_TXT_NEW, RIG_NOTES (plain-text notes of §3.2 / §3.3)
//   TAGS_NEW, ALARM_TAGS_NEW, NAMES_NEW
//   ALARMS (id → {tag, sev, eq, act?, esd?}), ALARM_IDS, Q_DES, Q_SAND, Q_SURGE2, ESD_TRIP_IDS, ACT_ALARMS
//   FAULT_IDS_V33, FAULTS_NEW [{id, label}], FAULT_IDS (16, engine order)
//   LINE_NAMES_V33 (14), LINES_NEW (name → {unit, phase}), LINE_NAMES (20), LINE_FIELDS
//   HIST_KEYS_V33, HIST_KEYS_NEW, HIST_KEYS
//   NULLABLE_NEW, NODE_IDS_V33, NODE_IDS (desander = index 8, surge2 = index 9), SEG_COUNT (6)
//   DEFAULTS_NEW (§6.2, the three new DEFAULTS blocks), FLOW_SIM (§6.3 rows), SAMPLE_FLOW_SIM (the 7 default keys)
//   DUMP_PHASES, DUMP_CMDS, SURGE_ROUTES, SURGE2_ROUTE_VALUES, ENUMS
//   API_STATIC_NEW, API_INSTANCE_NEW, SAND_HELPERS, EVENT_DUMP_EXAMPLE
//   CONTROLS_DEFAULT, CONTROLS_DEFAULT_JSON (§6.9, exact key order)
//   STEP_V33, STEP_COMBOS (the four stepFor combinations of §3.5), stepForRef(rig) (reference implementation)
//   ACTIONS (3D → 38 action payloads and their proxy strings)
//   ANCHORS (§4.9 / §9.2 worked numbers with tolerances)
//   EXAMPLES (lazy deep copies): desander, sand, surge2, nodesDesander, nodesSurge2 (DS-101 / T-202 in, SAMPLE_FLOW, 10 pptb,
//            idle / standby) and desanderOut, sandOut, surge2Out, nodesDesanderOut (static values while the item is out)
//   SHAPE_NAMES, checkShape(name, obj, {strict}) → {ok, errors:['<path>: <reason>', …]}
//   fakeEquipSnapshot(base, {desander, surge2, flushing, held, sand}) → a snapshot with every §6.4 path, for view builders
//   identityDiff(v33, now) → ['<path>: a !== b', …] — exact (===) check of every v3.3 path (§7 sig rule for rigup.sig)
//   loadEngine(which) → WTS_sim from 'v33' (tests/_wts-sim-v33.js), 'work' (31-wts-sim.js, self-test stripped as Round 7
//            strips it) or a source string, each in its own vm context
//
// Conventions encoded here
//   • Units: psig (pressures; Pacc too), psi (ΔP), °F, ft/s, ft, lb, lb/d, lb/h, bbl, gal, µm (particle size only), cP,
//     mpy and mil/d (steel-equivalent erosion), mil (metal loss), s (engine time), h (flow-back clock t_h).
//   • Line unit strings follow the existing engine strings ('BPD', 'MMSCFD'); the T-202 gas lines use the same unit string
//     as their T-201 counterparts (surge_vent / blanket / psv_surge are 'MMSCFD'); the sand dump line is 'LB/D'.
//   • Null rule: a snapshot number is finite; null only on the NULLABLE paths (here: desander.dump.lastT, surge2.tFull_s,
//     surge2.transfer.trip). Never NaN, ±Infinity or undefined.
//   • Example values: the ANCHORS entries are the asserted numbers (§4.9); every other number in EXAMPLES is illustrative
//     (consistent, finite, right order of magnitude) and is used for shape, not value, checks.
//   • ES5 style (var / function; no arrow functions, no optional chaining, no nullish coalescing).
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var BUILD_DIR = path.resolve(__dirname, '..');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
  }
  return o;
}
function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// ─── versions ────────────────────────────────────────────────────────────────
var PLAN = 'docs/SIM-EQUIPMENT-PLAN.md';
var VERSION_V33 = '1.3.0';
var VERSION_NEW = '1.4.0';
var PROBE_VERSION = '9.9.9-probe';

// ─── rig-up (§3.1, §3.2, D2, D3) ─────────────────────────────────────────────
var RIG_KEYS_V33 = ['esd', 'choke', 'heater', 'separator', 'surge', 'gauge', 'pump', 'flare'];
var RIG_KEYS = RIG_KEYS_V33.concat(['desander', 'surge2']);
var RIG_ORDER = ['esd', 'desander', 'choke', 'heater', 'separator', 'surge', 'surge2', 'gauge', 'pump', 'flare'];
var RIG_ITEMS_NEW = [
  { key: 'desander', tag: 'DS-101', name: 'Cyclonic desander (upstream of the choke)', optional: true, def: false,
    why: 'Optional: removes sand from the well stream before the choke. Must be rated for the maximum shut-in wellhead pressure (no relief valve).' },
  { key: 'surge2', tag: 'T-202', name: 'Second surge tank', optional: true, def: false, needs: 'surge',
    why: 'Optional: a second pressurised surge tank in parallel with T-201 (needs T-201 in the rig-up).' }];
var RIG_DEFAULTS = { esd: true, choke: true, heater: true, separator: true, surge: true, gauge: true, pump: true, flare: true,
  desander: false, surge2: false };
var RIG_OPTIONAL = ['desander', 'surge2'];
var SIG_V33 = '11111111';
var SIG_DEFAULT = '1111111100';
var GETRIGUP_DEFAULT_JSON = JSON.stringify(RIG_DEFAULTS);
var RIG_TXT_NEW = {
  desander: ['DS-101', 'out of the rig-up (well stream straight to the choke)', 'in line upstream of the choke'],
  surge2: ['T-202', 'out of the rig-up', 'in the rig-up (standby: XV-202 shut)'] };
var RIG_NOTES = {
  surge2NeedsSurge: 'T-202 works alongside T-201, so with T-201 out of the rig-up T-202 is out too.',
  surge2OnlyRouteRefused: 'T-202 is the only open route and T-201 cannot take the dumps (LSHH-201): open a T-201 inlet first.',
  surge2LeftLog: 'XV-201A/B opened: T-202 left the rig-up',
  desanderLeftLog: 'dump aborted: DS-101 out of the rig-up',
  fullSuffix: ' (full rig-up)' };

// ─── tags and names (§2.2) ───────────────────────────────────────────────────
var TAGS_NEW = { desander: 'DS-101', dsDump: 'XV-103', dsBypass: 'HV-104', surge2: 'T-202', xvSurge2: 'XV-202', bpv2: 'PCV-203',
  blanket2: 'PCV-204', psvSurge2: 'PSV-202', lgSurge2: 'LG-202', xfer2: 'LCV-202' };
var ALARM_TAGS_NEW = ['PDAH-103', 'PDAL-103', 'LAH-103', 'LAHH-103', 'PSHH-103', 'DS-101A',
  'LSHH-202', 'LSLL-202', 'PAH-202', 'PSHH-202', 'LAH-202'];
var NAMES_NEW = { desander: 'Cyclonic Desander', surge2: 'Surge Tank 2', xfer2: 'T-202 Transfer Valve' };

// ─── alarms (§4.8, §5.5) ─────────────────────────────────────────────────────
// sev: 'trip' | 'alarm' | 'warn' | 'hyd' (SAND_CHOKE is 'warn' above 5 lb/d and 'alarm' above 50 lb/d: sevs lists both).
// esd: true when the alarm trips the ESD (only PSHH-103 and PSHH-202). act: the latched / acting non-ESD trips.
var ALARMS = {
  DES_DP_HIGH:   { tag: 'PDAH-103', sev: 'alarm', eq: 'desander' },
  DES_DP_LOW:    { tag: 'PDAL-103', sev: 'warn', eq: 'desander' },
  DES_LAH:       { tag: 'LAH-103', sev: 'alarm', eq: 'desander' },
  DES_LAHH:      { tag: 'LAHH-103', sev: 'alarm', eq: 'desander' },
  DES_DUMP_FAIL: { tag: 'XV-103', sev: 'alarm', eq: 'desander' },
  DES_RATING:    { tag: 'DS-101', sev: 'alarm', eq: 'desander' },
  DES_PSHH:      { tag: 'PSHH-103', sev: 'trip', eq: 'desander', esd: true },
  DES_RATE:      { tag: 'DS-101', sev: 'warn', eq: 'desander' },
  HYD_desander:  { tag: 'DS-101', sev: 'hyd', eq: 'desander' },
  HYD_dsAcc:     { tag: 'DS-101A', sev: 'hyd', eq: 'desander' },
  HYD_dsBleed:   { tag: 'XV-103', sev: 'hyd', eq: 'desander' },
  SAND_CHOKE:    { tag: 'CK-101', sev: 'warn', sevs: ['warn', 'alarm'], eq: 'choke' },
  SAND_SEP:      { tag: 'V-101', sev: 'warn', eq: 'separator' },
  PSHH_SURGE2:   { tag: 'PSHH-202', sev: 'trip', eq: 'surge2', esd: true },
  PSH_SURGE2:    { tag: 'PAH-202', sev: 'alarm', eq: 'surge2' },
  PSV_SURGE2:    { tag: 'PSV-202', sev: 'alarm', eq: 'surge2' },
  LSHH_SURGE2:   { tag: 'LSHH-202', sev: 'trip', eq: 'surge2', act: 'xv202' },
  LSLL_SURGE2:   { tag: 'LSLL-202', sev: 'warn', eq: 'surge2' },
  XFER2_DRYRUN:  { tag: 'LCV-202', sev: 'trip', eq: 'surge2', act: 'xfer2' },
  XFER2_FAIL:    { tag: 'LCV-202', sev: 'alarm', eq: 'surge2' },
  XFER2_LOW_DP:  { tag: 'LCV-202', sev: 'warn', eq: 'surge2' },
  LAH_SURGE_ALL: { tag: 'LAH-202', sev: 'alarm', eq: 'surge2' } };
var ALARM_IDS = Object.keys(ALARMS);
var Q_DES = ['DES_DP_HIGH', 'DES_DP_LOW', 'DES_LAH', 'DES_LAHH', 'DES_DUMP_FAIL', 'DES_RATING', 'DES_PSHH', 'DES_RATE',
  'HYD_desander', 'HYD_dsAcc', 'HYD_dsBleed'];
var Q_SAND = ['SAND_CHOKE', 'SAND_SEP'];
var Q_SURGE2 = ['PSHH_SURGE2', 'PSH_SURGE2', 'PSV_SURGE2', 'LSHH_SURGE2', 'LSLL_SURGE2', 'XFER2_DRYRUN', 'XFER2_FAIL',
  'XFER2_LOW_DP', 'LAH_SURGE_ALL'];
var ESD_TRIP_IDS = ['DES_PSHH', 'PSHH_SURGE2'];
var ACT_ALARMS = { LSHH_SURGE2: 'xv202', XFER2_DRYRUN: 'xfer2' };
var LOG_TYPES = ['raise', 'clear', 'trip', 'reset', 'switch', 'batch', 'fault', 'event'];   // unchanged (§6.8)
var LOG_EVENT_IDS_NEW = ['DS_DUMP', 'DS_BYPASS', 'ROUTE'];

// ─── faults (§4.5, §5.6) ─────────────────────────────────────────────────────
var FAULT_IDS_V33 = ['pcvStuckClosed', 'pcvStuckOpen', 'oilDumpStuckOpen', 'oilDumpStuckClosed', 'waterDumpStuckClosed',
  'surgePumpFail', 'slugging', 'xferStuckClosed'];
var FAULTS_NEW = [
  { id: 'desanderPlugged', label: 'DS-101 liner plugged' },
  { id: 'desanderWashout', label: 'DS-101 liner washed out' },
  { id: 'desanderDumpStuck', label: 'XV-103 stuck closed' },
  { id: 'desanderIsoPassing', label: 'DS-101 isolation passing' },
  { id: 'desanderBypassPassing', label: 'HV-104 passing' },
  { id: 'sandFlowback', label: 'Sand flow-back' },
  { id: 'xfer2StuckClosed', label: 'LCV-202 stuck closed' },
  { id: 'bpv2StuckClosed', label: 'PCV-203 stuck closed' }];
var FAULT_IDS = FAULT_IDS_V33.concat(FAULTS_NEW.map(function (f) { return f.id; }));

// ─── lines, history, nodes, NULLABLE (§6.5, §6.6, §6.10, D16) ───────────────
var LINE_NAMES_V33 = ['wh_esd', 'esd_choke', 'choke_heater', 'heater_sep', 'sep_flare', 'sep_water', 'sep_oil', 'surge_gauge',
  'surge_vent', 'blanket', 'gauge_drain', 'gauge_vent', 'psv_sep', 'psv_surge'];
var LINES_NEW = {
  sep_surge2:   { unit: 'BPD', phase: 'liquid', what: 'dump branch into T-202' },
  surge2_gauge: { unit: 'BPD', phase: 'liquid', what: 'LCV-202 transfer' },
  surge2_vent:  { unit: 'MMSCFD', phase: 'gas', what: 'PCV-203 back-pressure valve' },
  blanket2:     { unit: 'MMSCFD', phase: 'gas', what: 'PCV-204 blanket' },
  psv_surge2:   { unit: 'MMSCFD', phase: 'gas', what: 'PSV-202 relief' },
  ds_dump:      { unit: 'LB/D', phase: 'sand', what: 'XV-103 sand dump (active during flush)' } };
var LINE_NAMES = LINE_NAMES_V33.concat(Object.keys(LINES_NEW));
var LINE_FIELDS = ['q', 'unit', 'frac', 'vel', 'ID_in', 'phase', 'active'];
var HIST_KEYS_V33 = ['Psep', 'PsepSP', 'bucketFrac', 'ifaceFrac', 'c1Frac', 'surgeFrac', 'surgeP', 'gaugeFracA', 'gaugeFracB',
  'qgFlare', 'qoMeter', 'Pwh', 'Pchoke', 'Twh', 'surgeFracA', 'surgeFracB'];
var HIST_KEYS_NEW = ['surge2Frac', 'surge2P', 'dsAccFrac', 'dsDP', 'sandChoke'];
var HIST_KEYS = HIST_KEYS_V33.concat(HIST_KEYS_NEW);
var NULLABLE_NEW = ['desander.dump.lastT', 'surge2.tFull_s', 'surge2.transfer.trip'];
var NODE_IDS_V33 = ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare', 'surge', 'gauge'];
var NODE_IDS = NODE_IDS_V33.concat(['desander', 'surge2']);   // positional readers: desander = 8, surge2 = 9
var SEG_COUNT = 6;                                            // snap.segs stays 6

// ─── DEFAULTS additions (§6.2, verbatim) ─────────────────────────────────────
var DEFAULTS_NEW = {
  desander: { rating_psi: 10000, sithp_psig: null, tempMin_F: -50, tempMax_F: { 5000: 250, 10000: 350, 15000: 350 },
    Ain_ft2: 0.0341, K_dp: 6, dpAlarmHi: 75, dpHighRatio: 2, dpHighAdd: 5, dpLowFrac: 0.5, dpLowMin: 2,
    d50ref_um: 25, vref_fts: 30, muRef_cp: 1.0, drhoRef: 103, vMin_fts: 10, vMax_fts: 60, m: 2.0, gvfKnee: 0.90, gvfGain: 0.5,
    rhoSand: 165.4, porosity: 0.40, acc_gal: 50, buf_gal: 20, lah: 0.80, lahh: 0.95, effFillKnee: 0.90, packDpGain: 10,
    plugFactor: 3, washFactor: 0.3, washCut: 3, slugCut: 1.5, bypassLeak: 0.10, warmFactor: 3,
    dump: { isoS: 8, bleedS: 300, flushS: 600, equalS: 120, reopenS: 8, bleedTo_psig: 50, bleedTimeoutS: 600, equalTol_psi: 75,
      isoPassTauS: 30 },
    autoSp: 0.80, chokeCoupling: true, pshhFrac: 0.95, gvfGasLo: 0.95, gvfGasHi: 0.995 },
  sand: { pptb: 0, lbPerMMscf: 0, d50_um: 150, sigmaG: 2.0, rateExp: 1.5,
    flowback: { W0_lbph: 200, tau_h: 6, d50_um: 400, sigmaG: 1.5 },
    chokeWarn_lbd: 5, chokeAlarm_lbd: 50, sepWarnFrac: 0.10,
    erosion: { K: 2.0e-9, n: 2.6, rhoT: 7800, alphaDeg: 60, cL_fts: 4000, allowance_mil: 125, testH: 72, warnFrac: 0.05,
      highFrac: 0.50 } },
  surge2: { cap_bbl: 100, D_ft: 6, Psp: null, psh: null, pshh: null, mawp: null, lsll: 0.05, lsl: 0.25, lsh: 0.70, lshh: 0.90,
    pumpBpd: null, pumpMinBpd: 500, pumpVelFrac: 0.7, psvMinMscfd: 50, xferMinDP: 1, inletDP_psi: 3,
    bpv: { tauCl: 10, Ti: 30 }, blanket: { on: true, deadband: 1, band: 2 }, autoSp: 0.80, autoHyst: 0.10, xvStrokeS: 6 } };

// ─── flow.sim keys and host inputs (§6.3) ────────────────────────────────────
// lo/hi: clamp range (host wtsClamp and engine flowDerived); choices: allowed values (else def); blankOk: blank = null (estimate)
var FLOW_SIM = [
  { key: 'sand_pptb', cfg: 'sand.pptb', host: 'wts_sandPptb', label: 'Sand rate, liquid (lb/1000 bbl)', lo: 0, hi: 500, def: 0 },
  { key: 'sand_lbmmscf', cfg: 'sand.lbPerMMscf', host: 'wts_sandGas', label: 'Sand rate, gas (lb/MMscf)', lo: 0, hi: 100, def: 0 },
  { key: 'sand_d50_um', cfg: 'sand.d50_um', host: 'wts_sandD50', label: 'Sand median size (µm)', lo: 20, hi: 1000, def: 150 },
  { key: 'desRating_psi', cfg: 'desander.rating_psi', host: 'wts_dsRating', label: 'Desander rating (psi)',
    choices: [5000, 10000, 15000], def: 10000, select: true },
  { key: 'desAcc_gal', cfg: 'desander.acc_gal', host: 'wts_dsAcc', label: 'Desander accumulator (gal)', lo: 10, hi: 200, def: 50 },
  { key: 'sithp_psig', cfg: 'desander.sithp_psig', host: 'wts_SITHP', label: 'Max shut-in wellhead pressure (psig)',
    lo: 100, hi: 20000, def: null, blankOk: true },
  { key: 'surge2Cap_bbl', cfg: 'surge2.cap_bbl', host: 'wts_surge2Cap', label: 'Surge tank 2 capacity (bbl)', lo: 20, hi: 500, def: 100 }];
var SAMPLE_FLOW_SIM = {};
FLOW_SIM.forEach(function (r) { SAMPLE_FLOW_SIM[r.key] = r.def; });

// ─── enums, API, events (§4.4, §5.2, §6.7, §6.8) ─────────────────────────────
var DUMP_PHASES = ['idle', 'isolate', 'bleed', 'flush', 'equalise', 'reopen', 'held'];
var DUMP_CMDS = ['start', 'resume', 'abort'];
var SURGE_ROUTES = ['surge', 'surge2', 'both'];                 // setSurgeRoute(mode)
var SURGE2_ROUTE_VALUES = ['surge', 'surge2', 'both', 'none'];  // derived surge2.route
var ENUMS = {
  'desander.rate': ['none', 'ok', 'low', 'high'],
  'desander.carrier': ['liquid', 'gas'],
  'desander.dump.phase': DUMP_PHASES,
  'desander.dump.heldFrom': [''].concat(DUMP_PHASES.filter(function (p) { return p !== 'idle' && p !== 'held'; })),
  'sand.choke.band': ['none', 'ok', 'warn', 'high'],
  'surge2.route': SURGE2_ROUTE_VALUES,
  'surge2.transfer.dest': ['gauge', 'export'],
  'rigup.extras[*]': RIG_OPTIONAL };
var API_STATIC_NEW = ['RIG_DEFAULTS', 'RIG_OPTIONAL', 'stepFor', 'sand'];
var SAND_HELPERS = ['etot', 'cut', 'dp', 'erosionReducer', 'muDeadOil', 'muGas', 'c2', 'mixSound'];
var API_INSTANCE_NEW = ['dumpDesander', 'setDesander', 'setSurgeRoute'];
var EVENT_DUMP_EXAMPLE = { type: 'dump', t: 0, phase: 'isolate', msg: 'DS-101 dump started: isolating the accumulator', auto: false };

// ─── controls (§6.9) ─────────────────────────────────────────────────────────
var CONTROLS_DEFAULT = {
  surge: { inlet: [true, true], suction: 'both', auto: false, sp: 0.8, hyst: 0.1, strokeS: 6 },
  gauge: { inlet: [true, false], auto: false, sp: 0.9, hyst: 0.1, strokeS: 6, allowInterrupt: false },
  surge2: { inlet: false, auto: false, sp: 0.8, hyst: 0.1, strokeS: 6 },
  desander: { bypass: false, auto: false, sp: 0.8 },
  v: 1 };
var CONTROLS_DEFAULT_JSON = JSON.stringify(CONTROLS_DEFAULT);

// ─── step numbers (§3.5, D17) ────────────────────────────────────────────────
var STEP_ORDER = ['wellhead', 'esd', 'desander', 'choke', 'heater', 'separator', 'flare', 'surge', 'surge2', 'gauge', 'pump'];
var STEP_V33 = { wellhead: '①', esd: '②', choke: '③', heater: '④', separator: '⑤', flare: '⑥', surge: '⑦', gauge: '⑧', pump: '⑨' };
function circled(n) { return String.fromCharCode(0x2460 + n - 1); }
// Reference implementation: core items always counted, optional items only when rig[k] === true.
function stepForRef(rig) {
  var r = rig || {}, out = {}, n = 0;
  STEP_ORDER.forEach(function (k) {
    if (RIG_OPTIONAL.indexOf(k) >= 0 && r[k] !== true) return;
    n++; out[k] = circled(n);
  });
  return out;
}
var STEP_COMBOS = [
  { name: 'default (both out)', rig: {},
    step: STEP_V33 },
  { name: 'DS-101 in', rig: { desander: true },
    step: { wellhead: '①', esd: '②', desander: '③', choke: '④', heater: '⑤', separator: '⑥', flare: '⑦', surge: '⑧', gauge: '⑨', pump: '⑩' } },
  { name: 'T-202 in', rig: { surge2: true },
    step: { wellhead: '①', esd: '②', choke: '③', heater: '④', separator: '⑤', flare: '⑥', surge: '⑦', surge2: '⑧', gauge: '⑨', pump: '⑩' } },
  { name: 'both in', rig: { desander: true, surge2: true },
    step: { wellhead: '①', esd: '②', desander: '③', choke: '④', heater: '⑤', separator: '⑥', flare: '⑦', surge: '⑧', surge2: '⑨', gauge: '⑩', pump: '⑪' } }];

// ─── 3D → 38 action payloads (§6.11) ─────────────────────────────────────────
var ACTIONS = {
  dump:        { proxy: 'dump:desander', action: { type: 'dump', eq: 'desander' } },
  bypass:      { proxy: 'bypass:desander', action: { type: 'bypass', eq: 'desander' } },
  valveSurge2: { proxy: 'valve:surge2:0', action: { type: 'valve', eq: 'surge2', idx: 0 } } };

// ─── worked numbers (§4.9; tolerances of §9.2) ───────────────────────────────
// rel: relative tolerance; abs: absolute tolerance. path: the snapshot path in EXAMPLES the number sits on (if any).
var ANCHORS = [
  { id: 'vIn', path: 'desander.vIn_fts', value: 20.7, rel: 0.02, text: 'v_in,ss (ft/s)' },
  { id: 'gvf', path: 'desander.gvf', value: 0.890, abs: 0.005, text: 'GVF at DS-101' },
  { id: 'rhoMix', path: 'desander.rhoMix', value: 14.17, rel: 0.02, text: 'no-slip mixture density (lb/ft³)' },
  { id: 'dPclean', path: 'desander.dPclean_psi', value: 3.93, rel: 0.02, text: 'clean ΔP on SAMPLE_FLOW (psi)' },
  { id: 'dpHelper', value: 3.93, rel: 0.005, args: [14.17, 20.7], text: 'WTS_sim.sand.dp(14.17, 20.7) (psi)' },
  { id: 'dpLiquid', value: 32.1, rel: 0.005, args: [55, 30], text: 'WTS_sim.sand.dp(55, 30) (psi)' },
  { id: 'pdahThreshold', value: 8.93, rel: 0.02, text: 'PDAH threshold max(2·3.93, 3.93 + 5) (psi)' },
  { id: 'dPplugged', value: 11.8, rel: 0.02, text: 'plugged ΔP (× 3) (psi)' },
  { id: 'dPwashout', value: 1.18, rel: 0.02, text: 'washed-out ΔP (× 0.3) (psi); PDAL below 1.97' },
  { id: 'muL', path: 'desander.mu_cp', value: 1.88, rel: 0.02, text: 'blended liquid viscosity (cP)' },
  { id: 'd50c', path: 'desander.d50c_um', value: 39.8, abs: 1, text: 'cut size d50c (µm)' },
  { id: 'eff', path: 'desander.eff', value: 0.946, abs: 0.005, text: 'capture, formation PSD 150 µm σg 2.0' },
  { id: 'effFlowback', value: 0.99998, abs: 0.0005, text: 'capture, flow-back PSD 400 µm σg 1.5' },
  { id: 'c2Inlet', value: 0.400, rel: 0.03, text: 'C2 inlet mass-weighted (formation)' },
  { id: 'c2Passed', path: 'sand.choke.C2', value: 0.110, rel: 0.03, text: 'C2 of the passed sand (formation)' },
  { id: 'sandIn', path: 'desander.sand.in_lbd', value: 12.0, rel: 0.01, text: 'sand in at 10 pptb (lb/d)' },
  { id: 'sandCapt', path: 'desander.sand.capt_lbd', value: 11.35, rel: 0.01, text: 'sand caught at 10 pptb (lb/d)' },
  { id: 'sandOut', path: 'desander.sand.out_lbd', value: 0.646, rel: 0.03, text: 'sand to the choke at 10 pptb (lb/d)' },
  { id: 'capLb', path: 'desander.sand.cap_lb', value: 663, rel: 0.005, text: 'accumulator capacity 50 gal (lb)' },
  { id: 'bufCapLb', path: 'desander.sand.bufCap_lb', value: 265, rel: 0.005, text: 'buffer capacity 20 gal (lb)' },
  { id: 'lahFlowback', value: 3.50, rel: 0.05, text: 'time to LAH in flow-back (h)' },
  { id: 'Up', path: 'sand.choke.Up_fts', value: 888, rel: 0.03, text: 'bean impact velocity proxy (ft/s)' },
  { id: 'erosionOut', value: 1594, rel: 0.05, text: 'steel-equivalent erosion at 10 pptb, DS-101 out (mpy); band warn (4.36 mil/d)' },
  { id: 'erosionIn', path: 'sand.choke.erosion_mpy', value: 23.6, rel: 0.05, text: 'steel-equivalent erosion at 10 pptb, DS-101 in (mpy); band ok' },
  { id: 'warnMild', path: 'sand.choke.warn_mild', value: 2.08, abs: 0.005, text: 'warn band 0.05·125/3 (mil/d)' },
  { id: 'highMild', path: 'sand.choke.high_mild', value: 20.8, abs: 0.05, text: 'high band 0.50·125/3 (mil/d)' },
  { id: 'dnvReducer', value: 8.72, rel: 0.01, text: 'DNV-RP-O501 reducer check 3-in → 0.5-in, 60 m/s, 150 µm, 300 kg/m³, 100 lb/d (mm/yr)' },
  { id: 'dumpFlushStart', value: 8 + 307, abs: 2, text: 'flush starts at isolate 8 s + bleed 307 s on the sample (s)' },
  { id: 'dumpTotal', value: 1043, abs: 3, text: 'dump total on the sample (s)' },
  { id: 'equalise10k', value: 147, abs: 3, text: 'equalise at PB 10,000 psig (s)' },
  { id: 'sithpEst', path: 'desander.sithp_psi', value: 3600, rel: 0.01, text: 'SITHP estimate 1.2 × 3,000 psig' }];

// ─── snapshot examples (§6.4) ────────────────────────────────────────────────
// DS-101 in, SAMPLE_FLOW, 10 pptb formation sand, steady, idle (no dump yet).
var EX_DESANDER = {
  tag: 'DS-101', inRig: true, bypass: false, bypassTag: 'HV-104',
  Pin: 2998.9, Pout: 2995.0, dP_psi: 3.93, dPclean_psi: 3.93, dPexp_psi: 3.93, dPdesign_psi: 3.93,
  T: 180, Tout: 179.9, vIn_fts: 20.7, rate: 'ok', gvf: 0.890, rhoMix: 14.17, carrier: 'liquid', mu_cp: 1.88, d50c_um: 39.8,
  eff: 0.946, effClean: 0.946,
  sand: { in_lbd: 12.0, capt_lbd: 11.35, out_lbd: 0.646, acc_lb: 0, acc_frac: 0, cap_lb: 663, buf_lb: 0, buf_frac: 0,
    bufCap_lb: 265, lah: 0.80, lahh: 0.95 },
  dump: { tag: 'XV-103', phase: 'idle', heldFrom: '', phaseT_s: 0, left_s: 0, open: false, Pacc: 2995.0, count: 0, lastT: null,
    failed: false, failMsg: '' },
  auto: { on: false, sp: 0.80, blocked: false },
  rating_psi: 10000, sithp_psi: 3600, sithpEst: true, ratingOK: true, tempMax_F: 350, tempOK: true };
var EX_SAND = {
  on: true, pptb: 10, lbPerMMscf: 0, d50_um: 150, sigmaG: 2.0, in_lbd: 12.0, toChoke_lbd: 0.646,
  flowback: { on: false, W0_lbph: 200, tau_h: 6, t_h: 0, d50_um: 400, sigmaG: 1.5 },
  choke: { Up_fts: 888, C2: 0.110, erosion_mpy: 23.6, erosion_mild: 0.065, band: 'ok', warn_mild: 2.08, high_mild: 20.8, loss_mil: 0 },
  sep: { lb: 0, ft3: 0, frac: 0 },
  cum: { in_lb: 0, capt_lb: 0, toChoke_lb: 0, toSep_lb: 0, toFlare_lb: 0, dumped_lb: 0 } };
// T-202 in the rig-up, standby (XV-202 shut), empty, gas at T-201's set pressure (Psp null → follows T-201's 25 psig).
var EX_SURGE2 = {
  tag: 'T-202', inRig: true, P: 25, SP: 25, SPeff: 25, T: 80, psh: 32, pshh: 40, mawp: 50, cap_bbl: 100, D: 6, H: 19.8575,
  h: 0, frac: 0, hW: 0, fracW: 0, Vo_bbl: 0, Vo_stb: 0, Vw_bbl: 0, flash_mscfd: 0, tFull_s: null,
  valveTag: 'XV-202', inlet: false, pos: 0, moving: false, fill_bpd: 0, route: 'surge', share: 0, Ph: 25,
  auto: { on: false, sp: 0.80, hyst: 0.10 }, strokeS: 6,
  bpv: { tag: 'PCV-203', u: 0 }, blanket: { tag: 'PCV-204', u: 0, held: false }, psv: { tag: 'PSV-202', lifting: false, Cv: 0.5 },
  transfer: { tag: 'LCV-202', on: false, tripped: false, failed: false, blocked: false, q_bpd: 0, design_bpd: 3752, x: 0,
    dP_psi: 0, dPdesign_psi: 24.5, Cv: 20.65, sg: 0.873, lowDP: false, dest: 'gauge', trip: null, canReset: false, resetBlock: '' },
  lsll: 0.05, lsl: 0.25, lsh: 0.70, lshh: 0.90 };
var EX_NODES_DESANDER = { tag: 'DS-101', P: 2995.0, Pin: 2998.9, dP: 3.93, T: 180, Tout: 179.9, Tacc: 80, th: 75, hyd: false };
var EX_NODES_SURGE2 = { P: 25, T: 80 };
// Static values while the item is out (Pin / Pout / P of the desander follow X.PB = the choke inlet; fakeEquipSnapshot copies it).
var EX_DESANDER_OUT = (function () {
  var d = clone(EX_DESANDER);
  d.inRig = false; d.dP_psi = 0; d.dPclean_psi = 0; d.dPexp_psi = 0; d.dPdesign_psi = 0; d.Pin = d.Pout = 2995.0;
  d.Tout = d.T; d.vIn_fts = 0; d.rate = 'none'; d.gvf = 0; d.rhoMix = 0; d.mu_cp = 0; d.d50c_um = 0; d.eff = 0; d.effClean = 0;
  d.sand = { in_lbd: 0, capt_lbd: 0, out_lbd: 0, acc_lb: 0, acc_frac: 0, cap_lb: 663, buf_lb: 0, buf_frac: 0, bufCap_lb: 265,
    lah: 0.80, lahh: 0.95 };
  d.dump.Pacc = 0;
  return d;
})();
var EX_SAND_OUT = (function () {
  var s = clone(EX_SAND);
  s.on = false; s.pptb = 0; s.in_lbd = 0; s.toChoke_lbd = 0;
  s.choke = { Up_fts: 888, C2: 0, erosion_mpy: 0, erosion_mild: 0, band: 'none', warn_mild: 2.08, high_mild: 20.8, loss_mil: 0 };
  return s;
})();
var EX_SURGE2_OUT = (function () { var s = clone(EX_SURGE2); s.inRig = false; s.route = 'surge'; return s; })();
var EX_NODES_DESANDER_OUT = { tag: 'DS-101', P: 2995.0, Pin: 2995.0, dP: 0, T: 180, Tout: 180, Tacc: 80, th: 75, hyd: false };

var EXAMPLES = {};
[['desander', EX_DESANDER], ['sand', EX_SAND], ['surge2', EX_SURGE2], ['nodesDesander', EX_NODES_DESANDER],
  ['nodesSurge2', EX_NODES_SURGE2], ['desanderOut', EX_DESANDER_OUT], ['sandOut', EX_SAND_OUT], ['surge2Out', EX_SURGE2_OUT],
  ['nodesDesanderOut', EX_NODES_DESANDER_OUT]].forEach(function (p) {
  deepFreeze(p[1]);
  Object.defineProperty(EXAMPLES, p[0], { enumerable: true, get: function () { return clone(p[1]); } });
});

var EX_LINE = { q: 0, unit: 'BPD', frac: 0, vel: 0, ID_in: 3.068, phase: 'liquid', active: false };
var EX_RIGUP = { esd: true, choke: true, heater: true, separator: true, surge: true, gauge: true, pump: true, flare: true,
  desander: false, surge2: false, full: true, sig: SIG_DEFAULT, notes: [], extras: [], refused: '', v: 1 };
// rigup.refused (§3.3, added after WP-E0 review): '' or the note of the last refused setRigup while the same change would still
// be refused (RIG_NOTES.surge2OnlyRouteRefused for T-202); 38 shows it and disables T-202's switch with that reason

// ─── checkShape (§6.4) ───────────────────────────────────────────────────────
// Templates: a number accepts a finite number (or null when the template value is null — the NULLABLE paths); a string is
// checked against ENUMS when the path has one; objects recurse; arrays are checked as arrays (elements via ENUMS '[*]').
var SHAPES = {
  desander: { tpl: EX_DESANDER, root: 'desander' },
  sand: { tpl: EX_SAND, root: 'sand' },
  surge2: { tpl: EX_SURGE2, root: 'surge2' },
  'nodes.desander': { tpl: EX_NODES_DESANDER, root: 'nodes.desander' },
  'nodes.surge2': { tpl: EX_NODES_SURGE2, root: 'nodes.surge2' },
  rigup: { tpl: EX_RIGUP, root: 'rigup' },
  controls: { tpl: CONTROLS_DEFAULT, root: 'controls' },
  line: { tpl: EX_LINE, root: 'line' },
  dumpEvent: { tpl: EVENT_DUMP_EXAMPLE, root: 'dumpEvent' } };
var SHAPE_NAMES = Object.keys(SHAPES);
var FIXED = {   // exact string values
  'desander.tag': 'DS-101', 'desander.bypassTag': 'HV-104', 'desander.dump.tag': 'XV-103', 'nodes.desander.tag': 'DS-101',
  'surge2.tag': 'T-202', 'surge2.valveTag': 'XV-202', 'surge2.bpv.tag': 'PCV-203', 'surge2.blanket.tag': 'PCV-204',
  'surge2.psv.tag': 'PSV-202', 'surge2.transfer.tag': 'LCV-202', 'dumpEvent.type': 'dump' };

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function walkShape(tpl, act, p, errs, strict) {
  var tt = typeName(tpl), at = typeName(act);
  if (act === undefined) { errs.push(p + ': missing'); return; }
  if (tpl === null) {
    if (!(act === null || (typeof act === 'number' && isFinite(act)))) errs.push(p + ': expected a finite number or null, got ' + at);
    return;
  }
  if (tt === 'number') {
    if (typeof act !== 'number' || !isFinite(act)) errs.push(p + ': expected a finite number, got ' + (typeof act === 'number' ? String(act) : at));
    return;
  }
  if (tt === 'string') {
    if (typeof act !== 'string') { errs.push(p + ': expected a string, got ' + at); return; }
    if (hasOwn(ENUMS, p) && ENUMS[p].indexOf(act) < 0) errs.push(p + ': "' + act + '" not in [' + ENUMS[p].join(', ') + ']');
    if (hasOwn(FIXED, p) && FIXED[p] !== act) errs.push(p + ': expected "' + FIXED[p] + '", got "' + act + '"');
    return;
  }
  if (tt === 'boolean') { if (typeof act !== 'boolean') errs.push(p + ': expected a boolean, got ' + at); return; }
  if (tt === 'array') {
    if (!Array.isArray(act)) { errs.push(p + ': expected an array, got ' + at); return; }
    var ek = p + '[*]';
    if (hasOwn(ENUMS, ek)) act.forEach(function (v, i) { if (ENUMS[ek].indexOf(v) < 0) errs.push(p + '[' + i + ']: "' + v + '" not allowed'); });
    else if (tpl.length) act.forEach(function (v, i) { walkShape(tpl[0], v, p + '[' + i + ']', errs, strict); });
    return;
  }
  if (tt === 'object') {
    if (at !== 'object') { errs.push(p + ': expected an object, got ' + at); return; }
    Object.keys(tpl).forEach(function (k) { walkShape(tpl[k], act[k], p + '.' + k, errs, strict); });
    if (strict) Object.keys(act).forEach(function (k) { if (!hasOwn(tpl, k)) errs.push(p + '.' + k + ': unexpected key'); });
  }
}
function checkShape(name, obj, opts) {
  if (!hasOwn(SHAPES, name)) throw new Error('_wts-equip-shapes: unknown shape ' + name + ' (known: ' + SHAPE_NAMES.join(', ') + ')');
  var errs = [], S = SHAPES[name];
  walkShape(S.tpl, obj, S.root, errs, !!(opts && opts.strict));
  if (name === 'rigup' && obj && typeof obj.sig === 'string') {
    if (!/^[01]{10}$/.test(obj.sig)) errs.push('rigup.sig: expected 10 characters of 0/1, got "' + obj.sig + '"');
    else RIG_KEYS.forEach(function (k, i) { if (typeof obj[k] === 'boolean' && (obj.sig.charAt(i) === '1') !== obj[k]) errs.push('rigup.sig: character ' + i + ' disagrees with ' + k); });
  }
  if (name === 'line' && obj && typeof obj.q === 'number' && obj.q < 0) errs.push('line.q: negative');
  return { ok: errs.length === 0, errors: errs };
}

// ─── fakeEquipSnapshot (§6.11) ───────────────────────────────────────────────
// base: any snapshot-like object (a real v3.3 getState(), 32's fakeSnapshot(), or null for a bare skeleton); it is deep-copied
// and never modified. o: { desander:bool, surge2:bool, sand:bool (default = desander), flushing:bool, held:bool, heldFrom,
// refused:bool (T-202 in: rigup.refused = RIG_NOTES.surge2OnlyRouteRefused) }.
// Result: every §6.4 path present and consistent (nodes.esd.P = desander.Pin when DS-101 is in; choke inlet unchanged),
// six new lines, eight new fault keys, health.massErr.sand, rigup.desander / surge2 / extras / 10-character sig.
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
function fakeEquipSnapshot(base, o) {
  o = o || {};
  var s = base ? clone(base) : {};
  var dIn = o.desander === true, uIn = o.surge2 === true, sandOn = o.sand === undefined ? dIn : o.sand === true;
  var flushing = dIn && o.flushing === true, held = dIn && o.held === true;
  s.nodes = s.nodes || {};
  s.lines = s.lines || {};
  s.faults = s.faults || {};
  s.health = s.health || {};
  s.health.massErr = s.health.massErr || { oil: 0, water: 0, gas: 0 };
  var choke = s.nodes.choke || {}, PB = num(choke.Pin, 2995.0);
  var Tes = s.nodes.esd ? num(s.nodes.esd.T, 180) : 180;
  // rig-up
  var ru = s.rigup || {};
  RIG_KEYS_V33.forEach(function (k) { if (typeof ru[k] !== 'boolean') ru[k] = true; });
  ru.desander = dIn; ru.surge2 = uIn;
  ru.extras = RIG_OPTIONAL.filter(function (k) { return ru[k]; });
  ru.sig = RIG_KEYS.map(function (k) { return ru[k] ? '1' : '0'; }).join('');
  ru.full = RIG_KEYS_V33.every(function (k) { return ru[k]; });
  if (!Array.isArray(ru.notes)) ru.notes = [];
  ru.refused = (uIn && o.refused === true) ? RIG_NOTES.surge2OnlyRouteRefused : (typeof ru.refused === 'string' && uIn ? ru.refused : '');
  if (typeof ru.v !== 'number') ru.v = 1;
  s.rigup = ru;
  // desander
  var d = dIn ? clone(EX_DESANDER) : clone(EX_DESANDER_OUT);
  d.T = Tes;
  if (dIn) {
    d.Pout = PB; d.Pin = PB + d.dP_psi; d.dump.Pacc = PB; d.Tout = Tes - 0.1;
    if (!sandOn) { d.sand.in_lbd = 0; d.sand.capt_lbd = 0; d.sand.out_lbd = 0; }
    if (flushing || held) {
      d.dump.phase = held ? 'held' : 'flush';
      d.dump.heldFrom = held ? (o.heldFrom || (flushing ? 'flush' : 'bleed')) : '';
      d.dump.open = flushing && !held;
      d.dump.phaseT_s = 120; d.dump.left_s = held ? 0 : (600 - 120) + 120 + 8;
      d.dump.Pacc = (d.dump.heldFrom === 'bleed') ? 400 : 30;
      d.sand.acc_lb = 420; d.sand.acc_frac = 420 / 663; d.sand.buf_lb = 6; d.sand.buf_frac = 6 / 265;
    }
  } else { d.Pin = d.Pout = PB; d.Tout = Tes; }
  s.desander = d;
  // sand
  var sd = sandOn ? clone(EX_SAND) : clone(EX_SAND_OUT);
  if (sandOn && !dIn) {   // no desander: everything reaches the choke (inlet C2, DS-101-out erosion)
    sd.toChoke_lbd = sd.in_lbd; sd.choke.C2 = 0.400; sd.choke.erosion_mpy = 1594; sd.choke.erosion_mild = 1594 / 365.25; sd.choke.band = 'warn';
  }
  s.sand = sd;
  // T-202
  var u = uIn ? clone(EX_SURGE2) : clone(EX_SURGE2_OUT);
  if (s.surge && typeof s.surge.SP === 'number') { u.SP = u.SPeff = u.Ph = u.P = s.surge.SP; }
  if (s.surge && typeof s.surge.T === 'number') u.T = s.surge.T;
  s.surge2 = u;
  // nodes (append: desander = 8, surge2 = 9)
  var nd = dIn ? clone(EX_NODES_DESANDER) : clone(EX_NODES_DESANDER_OUT);
  nd.P = PB; nd.Pin = dIn ? d.Pin : PB; nd.dP = dIn ? d.dP_psi : 0; nd.T = Tes; nd.Tout = d.Tout;
  s.nodes.desander = nd;
  s.nodes.surge2 = { P: u.P, T: u.T };
  if (dIn && s.nodes.esd) s.nodes.esd.P = d.Pin;   // out: nodes.esd.P untouched (= X.PB in the engine, as v3.3)
  if (dIn && Array.isArray(s.segs) && s.segs[1] && typeof s.segs[1].P0 === 'number') s.segs[1].P0 = d.Pin;
  // lines
  Object.keys(LINES_NEW).forEach(function (k) {
    var L = LINES_NEW[k];
    s.lines[k] = { q: 0, unit: L.unit, frac: 0, vel: 0, ID_in: L.phase === 'gas' ? 1.049 : (L.phase === 'sand' ? 2.067 : 3.068), phase: L.phase, active: false };
  });
  if (flushing && !held) { s.lines.ds_dump.q = 420 * 86400 / 600; s.lines.ds_dump.frac = 1; s.lines.ds_dump.active = true; }
  // faults, health
  FAULTS_NEW.forEach(function (f) { if (typeof s.faults[f.id] !== 'boolean') s.faults[f.id] = false; });
  s.health.massErr.sand = 0;
  return s;
}

// ─── frozen-engine identity (§7) ─────────────────────────────────────────────
// identityDiff(a, b) walks every path of a (a v3.3 snapshot / value, from tests/_wts-sim-v33.js) and checks b at the same path
// with === (numbers, strings, booleans, null); keys only in b (the additive v3.3.1 paths) are ignored. rigup.sig follows the
// sig rule of §7: b.slice(0, 8) === a and b.slice(8) is '' (before WP-E0) or '00'. Returns ['<path>: <a> !== <b>', …] (≤ max).
function identityDiff(a, b, max) {
  var out = [], lim = max || 20;
  (function walk(x, y, p) {
    if (out.length >= lim) return;
    if (p === 'rigup.sig' && typeof x === 'string' && typeof y === 'string') {
      if (y.slice(0, x.length) !== x || (y.slice(x.length) !== '' && y.slice(x.length) !== '00')) out.push(p + ': ' + x + ' vs ' + y);
      return;
    }
    if (x === null || typeof x !== 'object') {
      if (x !== y && !(typeof x === 'number' && typeof y === 'number' && x !== x && y !== y)) out.push(p + ': ' + JSON.stringify(x) + ' !== ' + JSON.stringify(y));
      return;
    }
    if (y === null || typeof y !== 'object') { out.push(p + ': object vs ' + JSON.stringify(y)); return; }
    if (Array.isArray(x)) {
      if (!Array.isArray(y)) { out.push(p + ': array vs non-array'); return; }
      if (x.length !== y.length) { out.push(p + '.length: ' + x.length + ' !== ' + y.length); return; }
      for (var i = 0; i < x.length; i++) walk(x[i], y[i], p + '[' + i + ']');
      return;
    }
    Object.keys(x).forEach(function (k) { walk(x[k], y[k], p ? p + '.' + k : k); });
  })(a, b, '');
  return out;
}

// ─── engines in their own vm contexts ────────────────────────────────────────
// which: 'v33' (frozen copy), 'work' (prism-build/31-wts-sim.js, self-test stripped as Round 7 strips it) or a source string.
// Returns the context's WTS_sim (values live in that realm: compare numbers / strings, or JSON-copy objects).
function loadEngine(which, ctxExtra) {
  var src;
  if (which === 'v33') src = fs.readFileSync(path.join(__dirname, '_wts-sim-v33.js'), 'utf8');
  else if (which === 'work' || which === undefined) {
    src = require(path.join(BUILD_DIR, 'concat-round7.js')).stripSelfTest(
      fs.readFileSync(path.join(BUILD_DIR, '31-wts-sim.js'), 'utf8'), '31-wts-sim.js', { log: function () {}, warn: function () {} });
  } else src = String(which);
  var ctx = vm.createContext(Object.assign({ console: console }, ctxExtra || {}));
  vm.runInContext(src, ctx, { filename: which === 'v33' ? '_wts-sim-v33.js' : '31-wts-sim.js' });
  if (!ctx.WTS_sim) throw new Error('_wts-equip-shapes.loadEngine: WTS_sim not defined by ' + (typeof which === 'string' && which.length < 8 ? which : 'source'));
  return ctx.WTS_sim;
}

module.exports = deepFreeze({
  PLAN: PLAN, VERSION_V33: VERSION_V33, VERSION_NEW: VERSION_NEW, PROBE_VERSION: PROBE_VERSION,
  RIG_KEYS_V33: RIG_KEYS_V33, RIG_KEYS: RIG_KEYS, RIG_ORDER: RIG_ORDER, RIG_ITEMS_NEW: RIG_ITEMS_NEW, RIG_DEFAULTS: RIG_DEFAULTS,
  RIG_OPTIONAL: RIG_OPTIONAL, SIG_V33: SIG_V33, SIG_DEFAULT: SIG_DEFAULT, GETRIGUP_DEFAULT_JSON: GETRIGUP_DEFAULT_JSON,
  RIG_TXT_NEW: RIG_TXT_NEW, RIG_NOTES: RIG_NOTES,
  TAGS_NEW: TAGS_NEW, ALARM_TAGS_NEW: ALARM_TAGS_NEW, NAMES_NEW: NAMES_NEW,
  ALARMS: ALARMS, ALARM_IDS: ALARM_IDS, Q_DES: Q_DES, Q_SAND: Q_SAND, Q_SURGE2: Q_SURGE2, ESD_TRIP_IDS: ESD_TRIP_IDS,
  ACT_ALARMS: ACT_ALARMS, LOG_TYPES: LOG_TYPES, LOG_EVENT_IDS_NEW: LOG_EVENT_IDS_NEW,
  FAULT_IDS_V33: FAULT_IDS_V33, FAULTS_NEW: FAULTS_NEW, FAULT_IDS: FAULT_IDS,
  LINE_NAMES_V33: LINE_NAMES_V33, LINES_NEW: LINES_NEW, LINE_NAMES: LINE_NAMES, LINE_FIELDS: LINE_FIELDS,
  HIST_KEYS_V33: HIST_KEYS_V33, HIST_KEYS_NEW: HIST_KEYS_NEW, HIST_KEYS: HIST_KEYS,
  NULLABLE_NEW: NULLABLE_NEW, NODE_IDS_V33: NODE_IDS_V33, NODE_IDS: NODE_IDS, SEG_COUNT: SEG_COUNT,
  DEFAULTS_NEW: DEFAULTS_NEW, FLOW_SIM: FLOW_SIM, SAMPLE_FLOW_SIM: SAMPLE_FLOW_SIM,
  DUMP_PHASES: DUMP_PHASES, DUMP_CMDS: DUMP_CMDS, SURGE_ROUTES: SURGE_ROUTES, SURGE2_ROUTE_VALUES: SURGE2_ROUTE_VALUES, ENUMS: ENUMS,
  API_STATIC_NEW: API_STATIC_NEW, SAND_HELPERS: SAND_HELPERS, API_INSTANCE_NEW: API_INSTANCE_NEW, EVENT_DUMP_EXAMPLE: EVENT_DUMP_EXAMPLE,
  CONTROLS_DEFAULT: CONTROLS_DEFAULT, CONTROLS_DEFAULT_JSON: CONTROLS_DEFAULT_JSON,
  STEP_ORDER: STEP_ORDER, STEP_V33: STEP_V33, STEP_COMBOS: STEP_COMBOS, stepForRef: stepForRef,
  ACTIONS: ACTIONS, ANCHORS: ANCHORS, EXAMPLES: EXAMPLES,
  SHAPE_NAMES: SHAPE_NAMES, checkShape: checkShape, fakeEquipSnapshot: fakeEquipSnapshot, identityDiff: identityDiff,
  loadEngine: loadEngine });
