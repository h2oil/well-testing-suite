#!/usr/bin/env node
// =============================================================================
// test-release-sh.js — end-to-end test of the release installer wts-modbus-bridge-install.sh, run the
// way the app tells people to (piped into bash), in a throw-away HOME (with a space in its path):
//
//   1. curl … | bash -s -- --yes --no-start --port <free>   → files unpacked (SHA-256 checked), install.sh
//      kept for --uninstall, bridge-config.json = any device ("*:*"), read-only
//   2. start-bridge.sh → GET /health answers wts-modbus-bridge, allow ["*:*"], read-only; GET / is the
//      status page
//   3. Linux: piped again with --autostart (a stub systemctl on PATH records the calls) → the systemd
//      --user unit is written and enabled, the settings are kept
//   4. bash <install folder>/install.sh --uninstall → everything removed
//
//   node tools/modbus-bridge/exe/test-release-sh.js <path/to/wts-modbus-bridge-install.sh>
// Used by .github/workflows/modbus-bridge-release.yml and prism-build/tests/modbus-bridge-exe.test.js.
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false, timeout: 1000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); }); req.on('error', () => resolve(null));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(100); } }

// expect: { files: { name: text } } — the bridge files the installer must unpack (optional)
async function testReleaseSh(script, o) {
  o = o || {};
  const log = o.log || ((s) => console.log('[release-sh] ' + s));
  const text = fs.readFileSync(script, 'utf8');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wts release sh '));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$HOME/systemctl.log"\nexit 0\n', { mode: 0o755 });
  const env = Object.assign({}, process.env, { HOME: home, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH });
  delete env.XDG_DATA_HOME; delete env.XDG_CONFIG_HOME;
  const mac = process.platform === 'darwin';
  const dir = mac ? path.join(home, 'Library', 'Application Support', 'WTS Modbus Bridge') : path.join(home, '.local', 'share', 'wts-modbus-bridge');
  const piped = (args, extraEnv) => spawnSync('bash', ['-s', '--'].concat(args), { input: text, env: Object.assign({}, env, extraEnv || {}), encoding: 'utf8', timeout: 60000, cwd: home });
  let bridge = null;
  try {
    const port = await freePort();
    // 1. piped install, no start
    let r = piped(['--yes', '--no-start', '--port', String(port)]);
    assert.strictEqual(r.status, 0, 'piped install: ' + r.stderr + r.stdout);
    assert.match(r.stdout, /Unpacked bridge v[\d.]+ \(SHA-256 verified\)/);
    assert.match(r.stdout, /No --allow targets given: the bridge will allow any device IP \/ port/);
    for (const f of ['modbus-bridge.js', 'fake-slave.js', 'README.md', 'install.sh', 'start-bridge.sh', 'bridge-config.json']) assert.ok(fs.existsSync(path.join(dir, f)), f + ' installed');
    if (o.files) for (const f of Object.keys(o.files)) assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf8'), o.files[f], f + ' = the packed file');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'bridge-config.json'), 'utf8'));
    assert.deepStrictEqual([cfg.allow, cfg.port, cfg.allowWrites, cfg.listen], [['*:*'], port, false, '127.0.0.1']);
    assert.ok(fs.statSync(path.join(dir, 'install.sh')).mode & 0o100, 'install.sh executable');
    log('piped install OK → ' + dir);
    // 2. the installed bridge runs
    bridge = spawn(path.join(dir, 'start-bridge.sh'), [], { env, stdio: 'ignore', detached: true });
    const h = await until(async () => { const x = await get(port, '/health'); return x && x.status === 200 && JSON.parse(x.body); }, 15000, 'the bridge /health');
    assert.strictEqual(h.name, 'wts-modbus-bridge'); assert.deepStrictEqual(h.allow, ['*:*']); assert.strictEqual(h.readOnly, true);
    const page = await get(port, '/');
    assert.strictEqual(page.status, 200); assert.match(page.type, /text\/html/); assert.match(page.body, /is running on this PC/); assert.match(page.body, /Any device IP address \/ port/);
    log('bridge v' + h.version + ' answers /health (allow *:*, read-only) and serves the status page');
    process.kill(-bridge.pid, 'SIGTERM'); bridge = null;
    await until(async () => !(await get(port, '/health')), 5000, 'the bridge to stop');
    // 3. auto-start (Linux: stub systemctl)
    if (process.platform === 'linux') {
      r = piped(['--autostart', '--yes', '--no-start'], { PATH: bin + path.delimiter + env.PATH });
      assert.strictEqual(r.status, 0, 'piped --autostart: ' + r.stderr);
      assert.match(r.stdout, /Keeping the settings of the existing/);
      const unit = path.join(home, '.config', 'systemd', 'user', 'wts-modbus-bridge.service');
      assert.ok(fs.existsSync(unit), 'systemd unit written'); assert.match(fs.readFileSync(unit, 'utf8'), /ExecStart=.*modbus-bridge\.js" --config /);
      assert.match(fs.readFileSync(path.join(home, 'systemctl.log'), 'utf8'), /--user enable wts-modbus-bridge\.service/);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bridge-config.json'), 'utf8')).port, port, 'port kept');
      log('--autostart wrote and enabled the systemd --user unit');
    }
    // 4. uninstall with the kept copy
    r = spawnSync('bash', [path.join(dir, 'install.sh'), '--uninstall'], { env: Object.assign({}, env, { PATH: bin + path.delimiter + env.PATH }), encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, 'uninstall: ' + r.stderr); assert.match(r.stdout, /uninstalled/);
    assert.ok(!fs.existsSync(dir), 'install folder removed');
    assert.ok(!fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'wts-modbus-bridge.service')), 'unit removed');
    log('uninstall OK');
    return { ok: true, port };
  } finally {
    if (bridge) { try { process.kill(-bridge.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = { testReleaseSh };
if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('usage: node test-release-sh.js <wts-modbus-bridge-install.sh>'); process.exit(2); }
  testReleaseSh(path.resolve(f)).then(() => console.log('[release-sh] all checks passed'), (e) => { console.error('[release-sh] FAILED: ' + (e && e.stack || e)); process.exit(1); });
}
