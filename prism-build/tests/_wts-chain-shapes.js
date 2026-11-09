// Well Test Simulator — release 3.4.2 (WTS_sim code comments v1.7.0) contract fixture of the rig-up chain ("an item taken out sends
// its flow to the next item downstream"; rigup-next design, INTEGRATION C2, C3, C18, §2.1–2.4). Frozen at hand-off (E6): LIVE (38) and
// VIEW3D (32) build their fake snapshots against it, not against a running engine. Not a test file.
//   ROUTINGS, DESTS, ROUTES (one item out → {key: receiver}), ROUTE_KEYS, NOTES (exact texts of the chain rules)
//   SEPBY_ALARMS, Q_SEPBY, SNAP_NEW (appended snapshot paths), NULLABLE_NEW; OVP_ALARMS + SEPBY_PSV_CAP (3.4.2 review, appended)
//   GAS_CAP (sepBy.gasCap_mmscfd on SAMPLE_FLOW, V-101 out to 'surge': LP line on / vent 'hp'; route 'both' ≈ 2×)
//   LOW_GAS (the perf / test case of destination 'surge' that runs without a trip), BOOST_HEAD_PSI
//   fakeRig(base, o) a copy of base with the rigup / sepBy / gauge.pump / surge(2).wellStream / cum / lines paths of the chain set;
//                    o: {routing, dest, out:[keys], recv, booster, gasCap}
'use strict';

function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); } return o; }

var ROUTINGS = ['chain', 'v341'];
var DESTS = ['flare', 'line', 'surge'];
var ROUTE_KEYS = ['esd', 'choke', 'heater', 'separator', 'surge', 'gauge', 'pump', 'flare', 'desander', 'surge2', 'heaterChoke'];
// receivers with destination 'surge' under 'chain' (optional items out by default: desander → CK-101, surge2 → T-201, heaterChoke → H-101)
var ROUTES = {
  heater: { heater: 'V-101' },
  separator: { separator: 'T-201' },
  surge: { surge: 'T-301' },
  surgeWithT202: { surge: 'T-202' },
  gauge: { gauge: 'P-201 → export' },
  pump: { pump: 'gravity' },
  flare: { flare: 'export + vent' },
  separatorNoTank: { separator: 'burner / flare line' },           // V-101 + T-201 out (no pressurised tank): dest falls back to 'flare'
  separatorLine: { separator: 'production line' },
  separatorFlare: { separator: 'burner / flare line' } };
var ROUTES_DEFAULT_OPTIONAL = { desander: 'CK-101', surge2: 'T-201', heaterChoke: 'H-101' };
var NOTES = {
  heater: 'H-101 out: the stream goes through the heater bypass straight to V-101 (no heat input, so downstream temperatures fall to the choke outlet temperature — watch the hydrate warnings).',
  t202ForT201: 'T-201 out: the separator dumps go to T-202.',
  booster: 'T-301 out: T-201 transfers through P-201 to the export / burner line (no tank batches, meter rates only).',
  nothingToPump: 'T-301 and the surge tanks out: P-201 has nothing to pump, so it is out of the line.',
  noTankFallback: 'No surge tank in the rig-up, so the whole stream goes to the burner / flare line.',
  coldVent: 'FS-401 out: surge-tank gas and relief go to the atmospheric vent (cold vent).',
  surgeDestPrefix: 'V-101 bypassed: the whole well stream goes to the surge tank T-201 (gas through PCV-201 to the LP flare line, liquids on to T-301).' };
var LOG = {
  refusedClose: 'XV-201A close refused — the whole well stream goes to T-201 through it (open another inlet first)',
  standIn: 'Separator dumps routed to T-202 (T-201 out of the rig-up)',
  routeRefused: 'route to T-201 refused — T-201 is out of the rig-up',
  bypassDestSurge: 'V-101 bypass destination: surge tank T-201 (whole well stream)',
  rigTxtSurge: 'V-101 bypassed (well stream to the surge tank T-201)' };
var SEPBY_ALARMS = {
  SEPBY_SURGE_CAP: { tag: 'PCV-201', sev: 'warn', eq: 'separator', note: 'V-101 out to the surge tank and the gas rate above what PCV-201 (+ PCV-203 on route both) passes at PSHH' },
  SEPBY_VENT: { tag: 'FS-401', sev: 'warn', eq: 'flare', note: 'V-101 out to the surge tank with FS-401 out: cold vent' },
  // 3.4.2 review (appended; defined on first need, so an engine that never takes the whole stream to the tanks has no entry):
  // the tag follows the receiving tank (PCV-203 / PSV-202 for T-202 alone)
  SEPBY_PSV_CAP: { tag: 'PSV-201', sev: 'warn', eq: 'separator', note: 'V-101 out to the surge tank and the stream gas above PCV + PSV at 110 % of MAWP' } };
var Q_SEPBY = ['PSHH_SEPBY', 'SEPBY_RATING', 'SEPBY_SURGE_CAP', 'SEPBY_VENT', 'SEPBY_PSV_CAP'];
// 3.4.2 review: surge-tank over-pressure (> 110 % of MAWP; the text marks > 121 %), defined on first need; cleared below 105 %
var OVP_ALARMS = {
  OVP_SURGE: { tag: 'T-201', sev: 'alarm', eq: 'surge' },
  OVP_SURGE2: { tag: 'T-202', sev: 'alarm', eq: 'surge2' } };
var SNAP_NEW = ['rigup.routing', 'rigup.dest', 'rigup.routes', 'sepBy.recv', 'sepBy.gasCap_mmscfd', 'gauge.pump.suction', 'cushion.out.surge',
  'sand.cum.toSurge_lb', 'surge.wellStream', 'surge2.wellStream', 'cum.toSurge_gas_mscf', 'cum.toSurge_oil_stb', 'cum.toSurge_water_bbl', 'lines.sepby_surge'];
var NULLABLE_NEW = ['sepBy.gasCap_mmscfd'];
var ENUMS = { 'rigup.routing': ROUTINGS, 'rigup.dest': DESTS, 'sepBy.dest': DESTS, 'sepBy.recv': ['', 'T-201', 'T-202', 'both'],
  'gauge.pump.mode': ['none', 'pump', 'gravity', 'booster'], 'gauge.pump.suction': ['gauge', 'transfer'] };
var GAS_CAP = { lp_mmscfd: 0.1520, hp_mmscfd: 0.1553, bothFactor: 2, rel: 0.005 };
var LOW_GAS = { inputs: { Qg: 0.05, Qo: 1000, Qw: 200 }, sim: { sepByDest: 'surge' }, rigup: { separator: false } };
var BOOST_HEAD_PSI = 30;

// fakeRig(base, o): base deep-copied; o = {routing:'chain', dest:'flare'|'line'|'surge', out:['separator', …], recv, booster, gasCap}
function fakeRig(base, o) {
  o = o || {};
  var s = clone(base) || {}, out = Array.isArray(o.out) ? o.out : [], dest = o.dest || 'flare', i;
  var ru = s.rigup = s.rigup || {};
  ROUTE_KEYS.forEach(function (k) { if (typeof ru[k] !== 'boolean') ru[k] = !(k === 'desander' || k === 'surge2' || k === 'heaterChoke'); });
  out.forEach(function (k) { ru[k] = false; });
  ru.routing = o.routing || 'chain'; ru.dest = dest; ru.routes = {};
  for (i = 0; i < ROUTE_KEYS.length; i++) ru.routes[ROUTE_KEYS[i]] = '';
  Object.keys(ROUTES_DEFAULT_OPTIONAL).forEach(function (k) { if (!ru[k]) ru.routes[k] = ROUTES_DEFAULT_OPTIONAL[k]; });
  if (!ru.heater) ru.routes.heater = ru.separator ? 'V-101' : (dest === 'surge' ? 'T-201' : dest === 'line' ? 'production line' : 'burner / flare line');
  if (!ru.separator) ru.routes.separator = dest === 'surge' ? (o.recv === 'T-202' ? 'T-202' : 'T-201') : dest === 'line' ? 'production line' : 'burner / flare line';
  if (!ru.surge) ru.routes.surge = ru.surge2 ? 'T-202' : (ru.gauge ? 'T-301' : 'export / burner line');
  if (!ru.gauge) ru.routes.gauge = ru.pump ? 'P-201 → export' : 'export / burner line';
  if (!ru.pump) ru.routes.pump = ru.gauge ? 'gravity' : '';
  if (!ru.flare) ru.routes.flare = 'export + vent';
  var surgeOn = !ru.separator && dest === 'surge';
  s.sepBy = s.sepBy || { dest: 'flare', P_psig: 150, P0_psig: 5, active: false, vent: false, note: '' };
  s.sepBy.dest = dest; s.sepBy.active = !ru.separator; s.sepBy.vent = !ru.flare;
  s.sepBy.recv = surgeOn ? (o.recv || 'T-201') : ''; s.sepBy.gasCap_mmscfd = surgeOn ? (typeof o.gasCap === 'number' ? o.gasCap : GAS_CAP.lp_mmscfd) : null;
  s.gauge = s.gauge || {}; s.gauge.pump = s.gauge.pump || { tag: 'P-201', inRig: true, mode: 'pump', on: false, failed: false, q_bpd: 0, design_bpd: 0, dest: 'export' };
  s.gauge.pump.suction = 'gauge';
  if (o.booster === true || (!ru.gauge && ru.pump)) { s.gauge.pump.mode = 'booster'; s.gauge.pump.suction = 'transfer'; s.gauge.pump.inRig = true; }
  s.surge = s.surge || {}; s.surge.wellStream = surgeOn && (o.recv || 'T-201') !== 'T-202';
  s.surge2 = s.surge2 || {}; s.surge2.wellStream = surgeOn && (o.recv === 'T-202' || o.recv === 'both');
  s.cum = s.cum || {}; ['toSurge_gas_mscf', 'toSurge_oil_stb', 'toSurge_water_bbl'].forEach(function (k) { if (typeof s.cum[k] !== 'number') s.cum[k] = 0; });
  s.cushion = s.cushion || { out: { flare: 0, line: 0, sep: 0 } }; s.cushion.out = s.cushion.out || {}; if (typeof s.cushion.out.surge !== 'number') s.cushion.out.surge = 0;
  s.sand = s.sand || {}; s.sand.cum = s.sand.cum || {}; if (typeof s.sand.cum.toSurge_lb !== 'number') s.sand.cum.toSurge_lb = 0;
  s.lines = s.lines || {};
  s.lines.sepby_surge = { q: surgeOn ? 10 : 0, unit: 'MMSCFD', frac: surgeOn ? 1 : 0, vel: surgeOn ? 59 : 0, ID_in: 6.065, phase: 'multi', active: surgeOn };
  return s;
}

module.exports = deepFreeze({
  ROUTINGS: ROUTINGS, DESTS: DESTS, ROUTE_KEYS: ROUTE_KEYS, ROUTES: ROUTES, ROUTES_DEFAULT_OPTIONAL: ROUTES_DEFAULT_OPTIONAL, NOTES: NOTES, LOG: LOG,
  SEPBY_ALARMS: SEPBY_ALARMS, Q_SEPBY: Q_SEPBY, OVP_ALARMS: OVP_ALARMS, SNAP_NEW: SNAP_NEW, NULLABLE_NEW: NULLABLE_NEW, ENUMS: ENUMS, GAS_CAP: GAS_CAP, LOW_GAS: LOW_GAS,
  BOOST_HEAD_PSI: BOOST_HEAD_PSI, fakeRig: fakeRig });
