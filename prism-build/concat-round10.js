#!/usr/bin/env node
// Round-10 concatenator — "Live Data": Modbus core, station, Modbus page, Mini WellOS.
//
// Run with:  node prism-build/concat-round10.js
// Writes:    prism-build/combined-round10.js
//
// Like Round-9, FILES is not a hand-kept list: every prism-build/6N-*.js (N = 0-9)
// is picked up automatically, in numeric order (ties by name):
//   60-modbus-core.js     WTS_modbus protocol core (framing, CRC, data types, client, transports, virtual slave)
//   61-modbus-station.js  configuration, polling station, alarms, variables, historian hook, simulator driver
//   62-modbus-page.js     route `modbus` (WTS_calcRegistry, group "Live Data")
//   63-wellos.js          route `wellos` (WTS_calcRegistry, group "Mini WellOS")
//   64-modbus-bridge-pack.js  GENERATED from tools/modbus-bridge/ by pack-modbus-bridge.js
//                         (window.WTS_modbusBridgePack) — main() below regenerates it first
//   65-modbus-bridge-setup.js  bridge setup helpers for the Modbus page guide (WTS_modbusBridgeSetup)
// Self-tests are stripped exactly like Round-8 / Round-9.
//
// require()-able: module.exports = { PATTERN, FILES, OUT, listFiles, build, stripSelfTest, main }.
//   build({ read, log, extraFiles }) — extraFiles: in-memory override names (test harness).

const fs = require('fs');
const path = require('path');
const { stripSelfTest } = require('./concat-round8');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'combined-round10.js');
const PATTERN = /^6[0-9]-[\w.-]+\.js$/;

function _num(f) { return parseInt(f, 10); }
function sortFiles(list) {
  return Array.from(new Set(list)).filter((f) => PATTERN.test(f))
    .sort((a, b) => (_num(a) - _num(b)) || (a < b ? -1 : a > b ? 1 : 0));
}
function listFiles(extra) {
  let names = [];
  try { names = fs.readdirSync(ROOT); } catch (e) { names = []; }
  return sortFiles(names.concat(extra || []));
}
const FILES = listFiles();

const banner = (label) =>
  '\n// ═══════════════════════════════════════════════════════════════════════\n' +
  '// ─── BEGIN ' + label + ' ───────────────────────────────────────────\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';
const footer = (label) =>
  '\n// ─── END ' + label + ' ─────────────────────────────────────────────\n\n';

function defaultRead(f) {
  const p = path.join(ROOT, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function build(opts) {
  opts = opts || {};
  const log = opts.log || console;
  const read = opts.read || defaultRead;
  const files = listFiles(opts.extraFiles);
  let combined =
    '\n// ═══════════════════════════════════════════════════════════════════════\n' +
    '// Round-10 (live data) — auto-injected from prism-build/6N-*.js\n' +
    '//   window.WTS_modbus (Modbus TCP / RTU master, station, virtual slave) and the\n' +
    '//   registry pages `modbus` and `wellos` (Mini WellOS).\n' +
    (files.length ? files.map((f) => '//   • ' + f.replace(/\.js$/, '')).join('\n') + '\n' : '//   (no files)\n') +
    '// ═══════════════════════════════════════════════════════════════════════\n';
  let included = 0;
  for (const f of files) {
    const src = read(f);
    if (src == null) { log.warn(`[WARN] ${f}: not present — skipped`); continue; }
    const stripped = stripSelfTest(src, f, log);
    const label = f.replace(/\.js$/, '');
    combined += banner(label) + stripped + footer(label);
    included++;
  }
  log.log(`[round10] ${included}/${files.length} live-data files included`);
  return combined;
}

function main() {
  // keep the bundled bridge files in step with tools/modbus-bridge/ (no-op when unchanged)
  try { require('./pack-modbus-bridge').main(); } catch (e) { console.warn('[WARN] pack-modbus-bridge: ' + e.message); }
  const combined = build();
  fs.writeFileSync(OUT, combined, 'utf8');
  console.log(`\n[ok] wrote ${OUT} (${combined.split('\n').length} lines)`);
}

module.exports = { PATTERN, FILES, OUT, listFiles, build, stripSelfTest, main };
if (require.main === module) main();
