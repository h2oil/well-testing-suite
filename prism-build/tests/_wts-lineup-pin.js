// Well Test Simulator — identity pins of the working engine (test helper, not a test file).
// Release 3.4.2 (code comments v1.7.0) has four orthogonal one-line defaults in 31-wts-sim.js. Each pin puts the old behaviour
// back on the WORKING engine side only (the frozen engines tests/_wts-sim-v33.js / _v331.js / _v341.js ignore these cfg keys):
//   lineup   cfg.surge.lineup = LEGACY_LINEUP        the v3.3.1 T-201 line-up (since v3.4.1 / v1.6.0 the default is XV-201A open,
//                                                    XV-201B shut, LCV-201 suction from B, auto-divert on, steady start A 0.35 / B 0.60)
//            engine line  var SURGE_LINEUP_DEF = deepFreeze({…});
//   surge2   cfg.surge2.compartments = 1             the single-compartment T-202 of v3.3.1 / v3.4.1 (3.4.2 default: 2, A | B)
//            engine line  var SURGE2_COMP_DEF = 2;
//   vent     cfg.surge.vent = {to:'hp'}              tank gas into the HP flare header (3.4.2 default: the LP flare line via FT-201)
//            engine line  var SURGE_VENT_DEF = deepFreeze({…});
//   routing  cfg.rig.routing = 'v341'                the v3.4.1 rig-up rules (3.4.2 default 'chain': next item downstream)
//            engine line  var RIG_ROUTING_DEF = 'chain';
// A cfg pin is set only when the key is absent (an explicit value in the test's own config wins). The pins never set
// sep.bypass.dest (tests that use the production line keep it).
//   legacyCfg / legacyOpts / legacyEngineOverrides()  all four pins → compare with the frozen v3.3 / v3.3.1 engines
//   v341Cfg / v341Opts / v341EngineOverrides()        every pin but the line-up → compare with the frozen v3.4.1 engine
//   pinCfg(cfg, which) / pinOpts(opts, which) / pinEngineOverrides(which)   which = {lineup, surge2, vent, routing} (missing = true)
'use strict';

const LEGACY_LINEUP = Object.freeze({ inlet: [true, true], suction: 'both', auto: false, initFrac: [0.55, 0.55] });
const LEGACY_SURGE2 = Object.freeze({ compartments: 1 });
const LEGACY_LINEUP2 = LEGACY_SURGE2;          // t202 design name (same object)
const LEGACY_VENT = Object.freeze({ to: 'hp' });
const LEGACY_ROUTING = 'v341';
const ALL = Object.freeze({ lineup: true, surge2: true, vent: true, routing: true });
const V341 = Object.freeze({ lineup: false, surge2: true, vent: true, routing: true });

function plainCopy(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function on(which, k) { return !which || which[k] !== false; }
function obj(c, k) { if (!(c[k] && typeof c[k] === 'object' && !Array.isArray(c[k]))) c[k] = {}; return c[k]; }

// pinCfg(cfg?, which?) → a fresh config object = cfg with the selected pins set where absent
function pinCfg(cfg, which) {
  const c = plainCopy(cfg) || {};
  if (on(which, 'lineup')) { const s = obj(c, 'surge'); if (!s.lineup) s.lineup = plainCopy(LEGACY_LINEUP); }
  if (on(which, 'surge2')) { const s2 = obj(c, 'surge2'); if (s2.compartments === undefined || s2.compartments === null) s2.compartments = LEGACY_SURGE2.compartments; }
  if (on(which, 'vent')) { const s = obj(c, 'surge'); if (s.vent === undefined || s.vent === null) s.vent = plainCopy(LEGACY_VENT); }
  if (on(which, 'routing')) { const r = obj(c, 'rig'); if (r.routing === undefined || r.routing === null) r.routing = LEGACY_ROUTING; }
  return c;
}
// pinOpts(opts?, which?) → a fresh create() options object whose config carries the selected pins
function pinOpts(opts, which) {
  const o = Object.assign({}, opts || {});
  o.config = pinCfg(o.config, which);
  return o;
}
function legacyCfg(cfg) { return pinCfg(cfg, ALL); }
function legacyOpts(opts) { return pinOpts(opts, ALL); }
function v341Cfg(cfg) { return pinCfg(cfg, V341); }
function v341Opts(opts) { return pinOpts(opts, V341); }

// pinEngineOverrides(which?): harness sourceOverrides whose 31-wts-sim.js has the selected pins as its DEFAULTS, for app-level
// tests that compare the live view (whose engine the app creates itself) with an old frame. Each default line is replaced
// exactly once (throws if 31 no longer has it).
const LINES = [
  ['lineup', /var SURGE_LINEUP_DEF = deepFreeze\(\{[^\n]*\}\);/, 'SURGE_LINEUP_DEF', () => 'var SURGE_LINEUP_DEF = deepFreeze(' + JSON.stringify(LEGACY_LINEUP) + ');'],
  ['surge2', /var SURGE2_COMP_DEF = 2;/, 'SURGE2_COMP_DEF', () => 'var SURGE2_COMP_DEF = ' + LEGACY_SURGE2.compartments + ';'],
  ['vent', /var SURGE_VENT_DEF = deepFreeze\(\{[^\n]*\}\);/, 'SURGE_VENT_DEF', () => 'var SURGE_VENT_DEF = deepFreeze(' + JSON.stringify(LEGACY_VENT) + ');'],
  ['routing', /var RIG_ROUTING_DEF = 'chain';/, 'RIG_ROUTING_DEF', () => "var RIG_ROUTING_DEF = '" + LEGACY_ROUTING + "';"]];
function pinSource(src, which) {
  let s = src;
  for (const [k, re, name, rep] of LINES) {
    if (!on(which, k)) continue;
    const m = s.match(new RegExp(re.source, 'g'));
    if (!m || m.length !== 1) throw new Error('_wts-lineup-pin: ' + name + ' line ' + (m ? 'found ' + m.length + ' times' : 'not found') + ' in 31-wts-sim.js');
    s = s.replace(re, rep());
  }
  return s;
}
function pinEngineOverrides(which) {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '31-wts-sim.js'), 'utf8');
  return { '31-wts-sim.js': pinSource(src, which) };
}
function legacyEngineOverrides() { return pinEngineOverrides(ALL); }
function v341EngineOverrides() { return pinEngineOverrides(V341); }

module.exports = { LEGACY_LINEUP, LEGACY_SURGE2, LEGACY_LINEUP2, LEGACY_VENT, LEGACY_ROUTING, PIN_ALL: ALL, PIN_V341: V341,
  pinCfg, pinOpts, pinSource, pinEngineOverrides, legacyCfg, legacyOpts, v341Cfg, v341Opts, legacyEngineOverrides, v341EngineOverrides };
