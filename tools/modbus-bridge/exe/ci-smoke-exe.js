#!/usr/bin/env node
// =============================================================================
// ci-smoke-exe.js — smoke test of the built WTS-Modbus-Bridge-Setup.exe on Windows (GitHub Actions
// windows-latest). LOCALAPPDATA / APPDATA point at a temp folder; the registry entries are the real
// HKCU ones of the runner and are removed again by --uninstall.
//
//   node tools/modbus-bridge/exe/ci-smoke-exe.js dist/WTS-Modbus-Bridge-Setup.exe
//
//   --version → the bridge version; PE subsystem = WINDOWS_GUI; install (--no-browser) → files, config
//   (any device, read-only), Run value "<exe>" --run, Apps & features entry, Start-menu shortcuts,
//   GET /health = wts-modbus-bridge / allow ["*:*"] / read-only, GET / = the status page; --run again =
//   single instance (exit 0, no second bridge); --status; --allow-writes / --read-only update the running
//   bridge; the setup exe again keeps bridge-config.json; --uninstall removes the Run value, the Apps
//   entry, the shortcuts and (a moment later) the install folder, and stops the bridge.
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawnSync } = require('child_process');
const pe = require('./pe.js');
const { BRIDGE_VERSION } = require('../modbus-bridge.js');
const APP = require('./bridge-app.js');

const setup = path.resolve(process.argv[2] || path.join(__dirname, 'dist', APP.SETUP_NAME));
const PORT = 8502;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(250); } }
function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, agent: false, timeout: 2000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); }); req.on('error', () => resolve(null));
  });
}
async function health() { const r = await get('/health'); try { return r && r.status === 200 ? JSON.parse(r.body) : null; } catch (e) { return null; } }
const step = (s) => console.log('[smoke] ' + s);

async function main() {
  if (process.platform !== 'win32') { console.log('[smoke] skipped: needs Windows'); return; }
  assert.ok(fs.existsSync(setup), setup);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wts exe smoke '));
  const env = Object.assign({}, process.env, { LOCALAPPDATA: path.join(tmp, 'Local'), APPDATA: path.join(tmp, 'Roaming') });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true }); fs.mkdirSync(env.APPDATA, { recursive: true });
  const dir = path.join(env.LOCALAPPDATA, APP.APP_NAME), exe = path.join(dir, APP.EXE_NAME);
  const startMenu = path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP.APP_NAME);
  // Output goes to a file, not a pipe: the bridge the exe starts (detached) may inherit the handle,
  // and spawnSync would then wait for a pipe that the running bridge keeps open.
  let nOut = 0;
  const run = (file, args, t) => {
    const outFile = path.join(tmp, 'out-' + (++nOut) + '.txt'), fd = fs.openSync(outFile, 'w');
    let r;
    try { r = spawnSync(file, args, { env, timeout: t || 90000, windowsHide: true, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
    r.stdout = fs.readFileSync(outFile, 'utf8'); r.stderr = r.error ? r.error.message : '';
    step(path.basename(file) + ' ' + args.join(' ') + ' → ' + r.status + (r.error ? ' ' + r.error.message : ''));
    return r;
  };
  const reg = (args) => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
  try {
    assert.strictEqual(await health(), null, 'port ' + PORT + ' must be free before the test');
    // PE + version
    const info = pe.readPe(fs.readFileSync(setup));
    assert.strictEqual(info.subsystem, pe.SUBSYSTEM.WINDOWS_GUI, 'GUI subsystem (no console window)');
    let r = run(setup, ['--version']);
    assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), BRIDGE_VERSION, '--version output: ' + JSON.stringify(r.stdout));
    // install
    r = run(setup, ['--no-browser']);
    console.log(r.stdout);
    assert.strictEqual(r.status, 0, 'install: ' + r.stdout + r.stderr);
    assert.ok(fs.existsSync(exe), 'installed exe');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'bridge-config.json'), 'utf8'));
    assert.deepStrictEqual([cfg.allow, cfg.port, cfg.allowWrites, cfg.listen], [[], PORT, false, '127.0.0.1'], 'default config: any device, read-only');
    let h = await until(health, 20000, '/health');
    assert.strictEqual(h.name, 'wts-modbus-bridge'); assert.strictEqual(h.version, BRIDGE_VERSION);
    assert.deepStrictEqual(h.allow, ['*:*']); assert.strictEqual(h.readOnly, true);
    step('bridge answers /health: ' + JSON.stringify(h));
    const page = await get('/');
    assert.strictEqual(page.status, 200); assert.match(page.type, /text\/html/); assert.match(page.body, /is running on this PC/); assert.match(page.body, /Uninstall WTS Modbus Bridge/);
    // registry + shortcuts
    let q = reg(['query', APP.RUN_KEY, '/v', APP.RUN_VALUE]);
    assert.strictEqual(q.status, 0, 'Run value exists: ' + q.stderr);
    assert.ok(q.stdout.indexOf('"' + exe + '" --run') >= 0, 'Run value = "<exe>" --run: ' + q.stdout);
    q = reg(['query', APP.UNINSTALL_KEY, '/v', 'UninstallString']);
    assert.strictEqual(q.status, 0); assert.ok(q.stdout.indexOf('"' + exe + '" --uninstall') >= 0, q.stdout);
    q = reg(['query', APP.UNINSTALL_KEY, '/v', 'DisplayVersion']); assert.ok(q.stdout.indexOf(BRIDGE_VERSION) >= 0, q.stdout);
    for (const l of [APP.STATUS_LNK, APP.UNINSTALL_LNK]) assert.ok(fs.existsSync(path.join(startMenu, l)), 'shortcut ' + l);
    assert.ok(fs.existsSync(path.join(dir, 'bridge.pid')), 'pid file');
    step('Run value, Apps & features entry and Start-menu shortcuts OK');
    // single instance
    const up0 = h.uptimeS;
    r = run(exe, ['--run'], 20000);
    assert.strictEqual(r.status, 0, 'second --run exits 0');
    h = await health(); assert.ok(h && h.uptimeS >= up0, 'the first bridge still answers');
    r = run(exe, ['--status']);
    assert.strictEqual(r.status, 0); const st = JSON.parse(r.stdout);
    assert.ok(st.installed && st.running && st.autostart, JSON.stringify(st));
    // settings through the exe: the bridge is restarted with them
    r = run(exe, ['--allow-writes', '--no-browser']);
    assert.strictEqual(r.status, 0, r.stdout);
    h = await until(async () => { const x = await health(); return x && x.readOnly === false && x; }, 20000, 'writes allowed');
    assert.deepStrictEqual(h.allow, ['*:*']);
    r = run(setup, ['--read-only', '--no-browser']);
    assert.strictEqual(r.status, 0, r.stdout);
    h = await until(async () => { const x = await health(); return x && x.readOnly === true && x; }, 20000, 'read-only again');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bridge-config.json'), 'utf8')).allowWrites, false, 'config kept and updated');
    step('--allow-writes / --read-only restart the bridge with the new setting');
    // uninstall (the installed exe, as Apps & features runs it)
    r = run(exe, ['--uninstall', '--quiet']);
    assert.strictEqual(r.status, 0, r.stdout);
    await until(async () => !(await health()), 15000, 'the bridge to stop');
    assert.notStrictEqual(reg(['query', APP.RUN_KEY, '/v', APP.RUN_VALUE]).status, 0, 'Run value removed');
    assert.notStrictEqual(reg(['query', APP.UNINSTALL_KEY]).status, 0, 'Apps & features entry removed');
    assert.ok(!fs.existsSync(startMenu), 'shortcuts removed');
    await until(async () => !fs.existsSync(dir), 20000, 'the install folder to be removed');
    step('uninstall removed everything');
    console.log('[smoke] all checks passed');
  } finally {
    reg(['delete', APP.RUN_KEY, '/v', APP.RUN_VALUE, '/f']); reg(['delete', APP.UNINSTALL_KEY, '/f']);
    spawnSync('taskkill', ['/F', '/IM', APP.EXE_NAME], { windowsHide: true });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* busy */ }
  }
}
main().catch((e) => { console.error('[smoke] FAILED: ' + (e && e.stack || e)); process.exit(1); });
