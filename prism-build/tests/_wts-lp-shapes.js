// Well Test Simulator — release 4.1 (WTS_sim code comments v1.7.0) contract fixture of the LP flare line of the surge-tank gas,
// FT-201 / FQI-201 and GOR1 / GOR2 (lpgas design; INTEGRATION §2.1, §2.4, C1, C3, C8, C9). Frozen at hand-off (E6): LIVE (38) and
// VIEW3D (32) build their fake snapshots against it, not against a running engine. Not a test file.
//   LP_KEYS            snap.lp keys in order (+ sources keys)        EX_LP / EX_LP_OFF   examples (default engine at t = 0 / 'hp')
//   RATES_NEW, CUM_NEW, FLARE_NODE_NEW, LINES_NEW, HIST_KEYS_NEW, NULLABLE_NEW, TAGS_NEW
//   LP_METERS          FT-201 types: low-cut (ft/s; orifice null = a quarter of the design velocity), ΔP, texts
//   ALARMS / ALARM_IDS / Q_LP   VEL_LP, PAH_LP, FT201_LOWCUT (always defined; raised only while lp.on)
//   DEFAULTS_VENT, VENT_LEGACY, LP_TO, LP_NOTES, LP_ID (NPS → SCH → ID)
//   fakeLp(base, o)    a copy of base (a snapshot or null) with every LP path set; o: {on, to, q_mscfd, P_in_psig, vSt, psvIn, gor1, gor2}
'use strict';

function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); } return o; }

var DEFAULTS_VENT = { to: 'lp', nps: 3, ID_in: 3.068, L_ft: 150, P0_psig: 0.2, tipDP_psi: 0.25, designFactor: 3, minDesignMscfd: 50, tauP_s: 1,
  bpAlarm_psig: null, velWarnFrac: 0.8, SG: null, meter: { tag: 'FT-201', type: 'usm', lowCut_fts: null, tau_s: 600 } };
var VENT_LEGACY = { to: 'hp' };
var LP_ID = { 2: { 40: 2.067, 80: 1.939 }, 3: { 40: 3.068, 80: 2.900 }, 4: { 40: 4.026, 80: 3.826 } };
var LP_METERS = {
  usm: { label: 'Insertion ultrasonic (transit time)', unc_txt: '±3 % of reading (±2.5–5 % typical, field-calibrated path)', turndown_txt: '≈1000:1 (0.1–300 ft/s)', lowCut_fts: 0.1, dP_psi: 0 },
  thermal: { label: 'Thermal dispersion', unc_txt: '±1.5 % of reading on a calibrated gas, ±5–10 % with composition change', turndown_txt: '100:1', lowCut_fts: 0.3, dP_psi: 0 },
  vortex: { label: 'Vortex', unc_txt: '±1.5 % of reading', turndown_txt: '10–20:1 (poor at start-up)', lowCut_fts: 8, dP_psi: 0.05 },
  orifice: { label: 'Orifice run + DP cell', unc_txt: '±1–2 % (AGA-3) within a 3–4:1 band per plate', turndown_txt: '3–4:1 per plate', lowCut_fts: null, dP_psi: 1 } };
var LP_TO = ['lp', 'hp', 'vent'];
var LP_NOTES = { meter: 'T-301 vent, not metered', noTank: 'No surge tank: flash vents at T-301 (not metered)', vent: 'LP gas to the atmospheric vent (FS-401 out)', off: '' };
var LP_KEYS = ['on', 'to', 'tag', 'lineTag', 'nps', 'sch', 'ID_in', 'L_ft', 'q_mscfd', 'meter_mscfd', 'meterType', 'unc_txt', 'turndown_txt', 'lowCut_fts',
  'belowCut', 'P_in_psig', 'P0_psig', 'dP_psi', 'vel_fts', 've_fts', 'vPct', 'mach', 'vSt', 'sources', 'psvIn', 'note'];
var LP_SOURCES = ['t201', 't202', 'psv'];   // Mscf/d: PCV-201, PCV-203, PSV-201 + PSV-202
// SAMPLE_FLOW design flash qFlashD = 18.35 Mscf/d (ΔRs 18.35 scf/STB at 1,000 STB/d); LP design flow max(3 × 18.35, 50) = 55 Mscf/d
var SAMPLE = { qFlashD_mscfd: 18.35, lpDesign_mscfd: 55.04, P2d_psig: 0.465, bpAlarm_psig: 12.5 };
var RATES_NEW = ['gor1_scf_stb', 'gor2_scf_stb', 'gorTot_scf_stb', 'lpGas_mscfd'];   // appended after rates.separated
var NULLABLE_NEW = ['rates.gor1_scf_stb', 'rates.gor2_scf_stb', 'rates.gorTot_scf_stb'];
var CUM_NEW = ['lpGas_mscf'];
var FLARE_NODE_NEW = ['qHP_mmscfd', 'qLP_mmscfd', 'Plp_psig'];     // nodes.flare.qMMscfd = qHP + qLP (vent excluded)
var LINES_NEW = { lp_flare: { unit: 'MMSCFD', phase: 'gas', what: 'LP flare line through FT-201' } };
var HIST_KEYS_NEW = ['qgLP', 'gor1', 'gor2'];                     // qgLP Mscf/d (instantaneous LP flow); gor NaN when null
var TAGS_NEW = { ft201: 'FT-201', lpLine: 'LP flare line' };
var ALARMS = {
  VEL_LP: { tag: 'FT-201', sev: 'warn', eq: 'lp', note: 'warn ≥ 80 % / alarm ≥ 100 % of the API RP 14E limit (Mach ≥ 0.5 counts as 100 %); sev switches like the segments' },
  PAH_LP: { tag: 'FT-201', sev: 'alarm', eq: 'lp', note: 'LP back pressure ≥ bpAlarm (null: max(2, 0.5 × T-201 SP))' },
  FT201_LOWCUT: { tag: 'FT-201', sev: 'info', eq: 'lp', note: 'oil flows and the FT-201 reading is cut off (meter EMA < 90 % of the uncut flow EMA)' } };
var ALARM_IDS = Object.keys(ALARMS);
var Q_LP = ['VEL_LP', 'PAH_LP', 'FT201_LOWCUT'];

// examples (shape; values of the default engine on SAMPLE_FLOW at t = 0, rounded)
var EX_LP = { on: true, to: 'lp', tag: 'FT-201', lineTag: 'LP flare line', nps: 3, sch: 40, ID_in: 3.068, L_ft: 150, q_mscfd: 18.35, meter_mscfd: 18.35,
  meterType: 'usm', unc_txt: LP_METERS.usm.unc_txt, turndown_txt: LP_METERS.usm.turndown_txt, lowCut_fts: 0.1, belowCut: false, P_in_psig: 0.229,
  P0_psig: 0.2, dP_psi: 0.029, vel_fts: 4.77, ve_fts: 482, vPct: 0.99, mach: 0.0033, vSt: 'OK', sources: { t201: 18.35, t202: 0, psv: 0 }, psvIn: false,
  note: LP_NOTES.meter };
var EX_LP_OFF = (function () {
  var o = clone(EX_LP);
  o.on = false; o.to = 'hp'; o.q_mscfd = 0; o.meter_mscfd = 0; o.P_in_psig = 0.2; o.dP_psi = 0; o.vel_fts = 0; o.ve_fts = 0; o.vPct = 0; o.mach = 0;
  o.sources = { t201: 0, t202: 0, psv: 0 }; o.note = '';
  return o;
})();

// fakeLp(base, o): base is deep-copied (never modified); every LP path of §2.4 is set
function fakeLp(base, o) {
  o = o || {};
  var s = clone(base) || {}, on = o.on !== false, lp = clone(on ? EX_LP : EX_LP_OFF);
  if (typeof o.to === 'string') lp.to = o.to;
  if (typeof o.q_mscfd === 'number') { lp.q_mscfd = o.q_mscfd; lp.meter_mscfd = o.q_mscfd; lp.sources.t201 = o.q_mscfd; }
  if (typeof o.P_in_psig === 'number') { lp.P_in_psig = o.P_in_psig; lp.dP_psi = Math.max(0, o.P_in_psig - lp.P0_psig); }
  if (typeof o.vSt === 'string') lp.vSt = o.vSt;
  if (o.psvIn === true) { lp.psvIn = true; lp.sources.psv = 20; }
  if (lp.to === 'vent') lp.note = LP_NOTES.vent;
  s.lp = lp;
  s.nodes = s.nodes || {}; s.nodes.flare = s.nodes.flare || { tag: 'FS-401', P: 5, Pline: 0, T: 80, qMMscfd: 0, flame: 0 };
  var f = s.nodes.flare, qL = on && lp.to !== 'vent' ? lp.q_mscfd / 1000 : 0;
  f.qLP_mmscfd = qL; f.qHP_mmscfd = Math.max(0, (f.qMMscfd || 0) - qL); f.qMMscfd = f.qHP_mmscfd + qL; f.Plp_psig = lp.P_in_psig;
  s.lines = s.lines || {};
  s.lines.lp_flare = { q: on ? lp.q_mscfd / 1000 : 0, unit: 'MMSCFD', frac: on ? lp.q_mscfd / 150 : 0, vel: lp.vel_fts, ID_in: lp.ID_in, phase: 'gas', active: on && lp.q_mscfd > 0 };
  s.rates = s.rates || {};
  var g1 = o.gor1 === undefined ? (on ? 10000 : null) : o.gor1, g2 = o.gor2 === undefined ? (on ? 18.35 : null) : o.gor2;
  s.rates.gor1_scf_stb = g1; s.rates.gor2_scf_stb = g2; s.rates.gorTot_scf_stb = g1 === null ? null : g1 + (g2 || 0); s.rates.lpGas_mscfd = on ? lp.meter_mscfd : 0;
  if (on) s.rates.gor_scf_stb = s.rates.gorTot_scf_stb;
  s.cum = s.cum || {}; s.cum.lpGas_mscf = s.cum.lpGas_mscf || 0;
  return s;
}

module.exports = deepFreeze({
  DEFAULTS_VENT: DEFAULTS_VENT, VENT_LEGACY: VENT_LEGACY, LP_ID: LP_ID, LP_METERS: LP_METERS, LP_TO: LP_TO, LP_NOTES: LP_NOTES,
  LP_KEYS: LP_KEYS, LP_SOURCES: LP_SOURCES, RATES_NEW: RATES_NEW, NULLABLE_NEW: NULLABLE_NEW, CUM_NEW: CUM_NEW, FLARE_NODE_NEW: FLARE_NODE_NEW,
  LINES_NEW: LINES_NEW, HIST_KEYS_NEW: HIST_KEYS_NEW, TAGS_NEW: TAGS_NEW, ALARMS: ALARMS, ALARM_IDS: ALARM_IDS, Q_LP: Q_LP,
  EX_LP: EX_LP, EX_LP_OFF: EX_LP_OFF, SAMPLE: SAMPLE, fakeLp: fakeLp });
