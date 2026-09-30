#!/usr/bin/env node
// =============================================================================
// build-release-scripts.js — the macOS / Linux assets of a bridge release, made with the same code
// the app uses (prism-build/pack-modbus-bridge.js + prism-build/65-modbus-bridge-setup.js), so the
// release installer and the app's generated installers cannot drift apart:
//
//   <out>/wts-modbus-bridge-install.sh     self-contained install.sh (bridge files + install.sh embedded,
//                                          SHA-256 checked when unpacked; empty presets = any device,
//                                          read-only, port 8502) — works piped:
//                                          curl -fsSL …/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes
//   <out>/wts-modbus-bridge-<version>.zip  the bridge package (the app's "Download bridge package")
//
//   node tools/modbus-bridge/exe/build-release-scripts.js [--out dist]
// require()-able: { build, loadSetup, write }.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PACK = require(path.join(REPO, 'prism-build', 'pack-modbus-bridge.js'));

// WTS_modbusBridgeSetup over a pack built from tools/modbus-bridge as it is on disk now.
function loadSetup() {
  const ctx = { console: { log() {}, warn() {} }, TextEncoder, Uint8Array, DataView, Promise, setTimeout, clearTimeout };
  ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(PACK.build(), ctx, { filename: '64-modbus-bridge-pack.js' });
  vm.runInContext(fs.readFileSync(path.join(REPO, 'prism-build', '65-modbus-bridge-setup.js'), 'utf8'), ctx, { filename: '65-modbus-bridge-setup.js' });
  return ctx.WTS_modbusBridgeSetup;
}
// date: ZIP timestamps (SOURCE_DATE_EPOCH for reproducible builds)
function build(o) {
  o = o || {};
  const S = loadSetup(), P = S.pack();
  const sh = S.releaseInstaller();
  if (!sh.ok) throw new Error(sh.errors.join('; '));
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const date = o.date || (epoch && /^\d+$/.test(epoch) ? new Date(+epoch * 1000) : new Date());
  const z = S.packageZip(date);
  return {
    version: P.version,
    files: {
      [sh.filename]: Buffer.from(sh.text, 'utf8'),
      [z.filename]: Buffer.from(z.bytes),
    },
    embedded: Array.from(sh.files),
    pack: { files: Object.assign({}, P.files), sha256: Object.assign({}, P.sha256), order: Array.from(P.order) },
  };
}
function write(outDir, o) {
  const r = build(o);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, buf] of Object.entries(r.files)) {
    const f = path.join(outDir, name);
    fs.writeFileSync(f, buf);
    if (/\.sh$/.test(name)) fs.chmodSync(f, 0o755);
    console.log('[release] wrote ' + f + ' (' + Math.round(buf.length / 1024) + ' KB)');
  }
  return r;
}

module.exports = { build, loadSetup, write };
if (require.main === module) {
  const a = process.argv.slice(2), i = a.indexOf('--out');
  try { write(path.resolve(i >= 0 ? a[i + 1] : path.join(__dirname, 'dist'))); } catch (e) { console.error('[release] ERROR: ' + e.message); process.exit(1); }
}
