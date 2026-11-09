// Well Test Simulator — the v3.3.1 T-201 operator line-up as a cfg.surge.lineup pin (test helper, not a test file).
// Since v3.4.1 (WTS_sim 1.6.0) the engine starts with XV-201A open, XV-201B shut, LCV-201 suction from B and auto-divert
// on (steady start A 0.35 / B 0.60). Tests written for the old line-up, and every identity test against the frozen
// engines, pin the old one on the WORKING engine side only (the frozen engines ignore cfg.surge.lineup).
'use strict';

const LEGACY_LINEUP = Object.freeze({ inlet: [true, true], suction: 'both', auto: false, initFrac: [0.55, 0.55] });

function plainCopy(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

// legacyCfg(cfg?) → a fresh config object = cfg with surge.lineup set to the v3.3.1 line-up (an explicit lineup in cfg wins)
function legacyCfg(cfg) {
  const c = plainCopy(cfg) || {};
  c.surge = c.surge && typeof c.surge === 'object' ? c.surge : {};
  if (!c.surge.lineup) c.surge.lineup = plainCopy(LEGACY_LINEUP);
  return c;
}
// legacyOpts(opts?) → a fresh create() options object whose config carries the v3.3.1 line-up
function legacyOpts(opts) {
  const o = Object.assign({}, opts || {});
  o.config = legacyCfg(o.config);
  return o;
}

// legacyEngineOverrides(): harness sourceOverrides whose 31-wts-sim.js has the v3.3.1 line-up as its DEFAULT, for app-level
// tests that compare the live view (whose engine the app creates itself) with a v3.3 / v3.3.1 frame. The default line
// is replaced exactly once (throws if 31 no longer has it).
function legacyEngineOverrides() {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '31-wts-sim.js'), 'utf8');
  const re = /var SURGE_LINEUP_DEF = deepFreeze\(\{[^\n]*\}\);/;
  if (!re.test(src)) throw new Error('_wts-lineup-pin: SURGE_LINEUP_DEF line not found in 31-wts-sim.js');
  return { '31-wts-sim.js': src.replace(re, 'var SURGE_LINEUP_DEF = deepFreeze(' + JSON.stringify(LEGACY_LINEUP) + ');') };
}

module.exports = { LEGACY_LINEUP, legacyCfg, legacyOpts, legacyEngineOverrides };
