// One-click Modbus bridge installers (GitHub release):
//
//   • tools/modbus-bridge/exe/bridge-app.js — the launcher inside WTS-Modbus-Bridge-Setup.exe, with fake
//     Windows APIs (registry / taskkill / PowerShell recorder, fake /health, temp folders): install (copy,
//     config kept / written, Run value, Apps & features entry, Start-menu shortcuts, start, status page),
//     re-install over a running copy, a foreign bridge / program on the port, --no-autostart, settings
//     flags, --run single instance, --status, --uninstall (self-delete after exit, message first);
//     the real launcher --run on this OS (single instance, status page, --status);
//   • the bridge's status page (GET /): escaping, CSP, Host / Origin refusals;
//   • pe.js: PE header reader, subsystem patch (CONSOLE → WINDOWS_GUI), signature strip — synthetic PE;
//   • build-exe.js bundle: one script that runs without ../modbus-bridge.js;
//   • build-release-scripts.js: the self-contained install.sh (bridge files + install.sh embedded,
//     SHA-256 = the pack, empty presets) and the package zip; piped into bash end to end;
//   • .github/workflows/modbus-bridge-release.yml: parses, Windows smoke test + Linux e2e + release job;
//   • Modbus page: exe link on Windows, curl one-liner on macOS / Linux, "any device" default + Check bridge.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const WP = 'MODBUS';
const REPO = path.resolve(__dirname, '..', '..');
const TOOLS = path.join(REPO, 'tools', 'modbus-bridge');
const EXE_DIR = path.join(TOOLS, 'exe');
const APP = require(path.join(EXE_DIR, 'bridge-app.js'));
const PE = require(path.join(EXE_DIR, 'pe.js'));
const BUILD = require(path.join(EXE_DIR, 'build-exe.js'));
const RELEASE = require(path.join(EXE_DIR, 'build-release-scripts.js'));
const PACK = require('../pack-modbus-bridge.js');
const BR = require(path.join(TOOLS, 'modbus-bridge.js'));
const { BRIDGE_VERSION } = BR;
const EXE_URL = 'https://github.com/h2oil/well-testing-suite/releases/latest/download/WTS-Modbus-Bridge-Setup.exe';
const ONE_LINER = 'curl -fsSL https://github.com/h2oil/well-testing-suite/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes';
const hasBash = (() => { try { return spawnSync('bash', ['-c', 'exit 0']).status === 0; } catch (e) { return false; } })();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const text = (el) => String(el ? el.textContent : '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(100); } }
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function request(port, p, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, agent: false, timeout: 2000, headers: headers || {} }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); }); req.on('error', () => resolve(null)); req.end();
  });
}

// ─── fake Windows for the launcher ──────────────────────────────────────────
// Everything the launcher does to the system is recorded; the bridge is a state machine:
// state.bridge = null | 'ours' (our --run child) | 'foreign' (another WTS bridge) | 'program'.
function fakeWin(o) {
  o = o || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts exe test '));
  const env = { LOCALAPPDATA: path.join(root, 'Local'), APPDATA: path.join(root, 'Roaming'), SystemRoot: path.join(root, 'Windows'), ComSpec: path.join(root, 'Windows', 'System32', 'cmd.exe') };
  fs.mkdirSync(path.join(root, 'Downloads'));
  const setup = path.join(root, 'Downloads', APP.SETUP_NAME);
  fs.writeFileSync(setup, 'MZ fake setup exe ' + BRIDGE_VERSION);
  const S = { root, env, setup, t: 0, seq: [], exec: [], spawned: [], opened: [], boxes: [], regFiles: [], ps: [], runs: [], logs: [], out: [],
    bridge: o.bridge || null, bridgePid: o.bridgePid || null, runValue: false, allow: ['*:*'], readOnly: true };
  const deps = {
    platform: 'win32', env, fs, path, execPath: o.execPath || setup, pid: o.pid || 1000,
    now: () => S.t, sleep: (ms) => { S.t += ms; return Promise.resolve(); },
    log: (s) => S.logs.push(s), out: (s) => S.out.push(s),
    exec(cmd, args, opt) {
      const tool = path.basename(cmd).toLowerCase();
      S.exec.push({ tool, args: args.slice(), env: opt && opt.env }); S.seq.push('exec:' + tool + ':' + args[0]);
      if (tool === 'reg.exe') {
        if (args[0] === 'import') {
          const buf = fs.readFileSync(args[1]);
          S.regFiles.push({ bom: buf[0] === 0xFF && buf[1] === 0xFE, text: buf.slice(2).toString('utf16le') });
          if (/\\Run\]/.test(S.regFiles[S.regFiles.length - 1].text)) S.runValue = true;
          return { status: 0, stdout: '', stderr: 'The operation completed successfully.' };
        }
        if (args[0] === 'delete') { if (/\\Run$/.test(args[1])) { const had = S.runValue; S.runValue = false; return { status: had ? 0 : 1 }; } return { status: 0 }; }
        if (args[0] === 'query') return { status: S.runValue ? 0 : 1, stdout: '' };
      }
      if (tool === 'tasklist.exe') {
        const pid = +/PID eq (\d+)/.exec(args[1])[1];
        return { status: 0, stdout: S.bridge === 'ours' && pid === S.bridgePid ? '"' + APP.EXE_NAME + '","' + pid + '","Console","1","12,000 K"\r\n' : 'INFO: No tasks are running which match the specified criteria.\r\n' };
      }
      if (tool === 'taskkill.exe') {
        const self = args.indexOf('PID ne ' + deps.pid) >= 0 || (args[0] === '/PID' && +args[1] !== deps.pid);
        if (S.bridge === 'ours' && self) { S.bridge = null; return { status: 0, stdout: 'SUCCESS: The process with PID ' + S.bridgePid + ' has been terminated.' }; }
        return { status: 128, stdout: 'INFO: No tasks running with the specified criteria.' };
      }
      if (tool === 'powershell.exe') {
        const i = args.indexOf('-EncodedCommand');
        S.ps.push({ script: Buffer.from(args[i + 1], 'base64').toString('utf16le'), env: opt && opt.env });
        return { status: o.psFails ? 1 : 0, stdout: '', stderr: o.psFails ? 'COM error' : '' };
      }
      return { status: 0, stdout: '' };
    },
    spawnDetached(cmd, args, opt) {
      S.spawned.push({ cmd, args: args.slice(), opt }); S.seq.push('spawn:' + path.basename(cmd) + ':' + args[0]);
      if (args[0] === '--run' && !o.neverStarts && S.bridge === null) { S.bridge = 'ours'; S.bridgePid = 5555; }
      return 5555;
    },
    getHealth(port, host) {
      S.lastHealth = { port, host };
      if (S.bridge === 'ours' || S.bridge === 'foreign') return Promise.resolve({ status: 'ours', health: { name: 'wts-modbus-bridge', version: S.bridge === 'ours' ? BRIDGE_VERSION : '1.1.0', readOnly: S.readOnly, port, uptimeS: 1, allow: S.allow } });
      if (S.bridge === 'program') return Promise.resolve({ status: 'other', code: 404 });
      return Promise.resolve({ status: 'none' });
    },
    openUrl(u) { S.opened.push(u); S.seq.push('open'); },
    messageBox(t, title, icon) { S.boxes.push({ t, title, icon }); S.seq.push('box'); },
    runBridge(opts) { S.runs.push(opts); return Promise.resolve({ port: opts.port || 8502 }); },
  };
  const P = APP.paths(deps);
  S.P = P; S.deps = deps; S.app = APP.createApp(deps);
  S.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  S.cfg = () => JSON.parse(fs.readFileSync(P.config, 'utf8'));
  S.tools = (t) => S.exec.filter((e) => e.tool === t);
  return S;
}
function regValues(text) {                      // .reg text → { '[key]': { name: value } }
  const out = {}; let key = null;
  text.split('\r\n').forEach((l) => {
    let m = /^\[(.+)\]$/.exec(l);
    if (m) { key = m[1]; out[key] = {}; return; }
    m = /^"((?:[^"\\]|\\.)*)"=(?:"((?:[^"\\]|\\.)*)"|(dword:[0-9a-f]{8}))$/.exec(l);
    if (m && key) out[key][m[1].replace(/\\(.)/g, '$1')] = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3];
  });
  return out;
}
const RUN_K = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const UNI_K = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WTSModbusBridge';

// A minimal PE32+ / PE32 image: MZ, e_lfanew, PE\0\0, COFF, optional header with 16 data directories.
function synthPe(o) {
  o = o || {};
  const plus = o.plus !== false, peOff = 0x80, optSize = plus ? 240 : 224, hdrEnd = peOff + 24 + optSize;
  const body = Buffer.alloc(Math.max(hdrEnd, 0x400) + 256, 0);
  body.fill(0x90, hdrEnd);
  body.writeUInt16LE(0x5A4D, 0); body.writeUInt32LE(peOff, 0x3C);
  body.writeUInt32LE(0x00004550, peOff); body.writeUInt16LE(plus ? 0x8664 : 0x14c, peOff + 4); body.writeUInt16LE(optSize, peOff + 20);
  const opt = peOff + 24;
  body.writeUInt16LE(plus ? 0x20b : 0x10b, opt); body.writeUInt16LE(3, opt + 68);
  body.writeUInt32LE(16, opt + (plus ? 108 : 92));
  const cert = o.cert ? Buffer.alloc(o.cert, 0xAB) : Buffer.alloc(0);
  if (o.cert) { const e = opt + (plus ? 112 : 96) + 32; body.writeUInt32LE(body.length, e); body.writeUInt32LE(cert.length, e + 4); }
  return Buffer.concat([body, cert]);
}

module.exports = [
  {
    name: 'exe launcher: arguments (commands, settings flags, validation, --help)',
    wp: WP, opts: false,
    run(app, assert) {
      const p = APP.parseArgs;
      assert.strictEqual(p([]).cmd, 'install');
      for (const [a, c] of [['--run', 'run'], ['--open', 'open'], ['--uninstall', 'uninstall'], ['--status', 'status'], ['--version', 'version'], ['-h', 'help'], ['/?', 'help']]) assert.strictEqual(p([a]).cmd, c, a);
      const o = p(['--allow', ' 10.0.0.5:502 ', '--allow-writes', '--port', '8600', '--no-browser', '--no-autostart']);
      assert.deepStrictEqual([o.cmd, o.allow, o.allowWrites, o.port, o.quiet, o.noAutostart, o.changes], ['install', ['10.0.0.5:502'], true, 8600, true, true, true]);
      assert.strictEqual(p(['--read-only']).allowWrites, false); assert.ok(p(['--quiet']).quiet && p(['--allow-any']).allowAny);
      for (const bad of [['--allow', '1.2.3.4;calc:502'], ['--allow', '$(x):502'], ['--port', '0'], ['--port', '70000'], ['--port'], ['--bogus'], ['--run', '--uninstall'], ['--run', '--allow-writes'], ['--uninstall', '--port', '9000']]) {
        assert.throws(() => p(bad), undefined, JSON.stringify(bad));
      }
      assert.match(APP.usage(), /WTS-Modbus-Bridge-Setup\.exe +install for this user/);
      const r = spawnSync(process.execPath, [path.join(EXE_DIR, 'bridge-app.js'), '--version'], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout.trim(), BRIDGE_VERSION);
    },
  },
  {
    name: 'exe launcher: install (fake Windows) — copy, default config (any device, read-only, 8502), Run value, Apps & features entry, shortcuts, start, status page',
    wp: WP, opts: false,
    async run(app, assert) {
      const S = fakeWin();
      try {
        const code = await S.app.main([]);
        assert.strictEqual(code, 0, S.out.join('\n'));
        const P = S.P;
        assert.strictEqual(P.dir, path.join(S.env.LOCALAPPDATA, 'WTS Modbus Bridge'));
        assert.strictEqual(fs.readFileSync(P.exe, 'utf8'), fs.readFileSync(S.setup, 'utf8'), 'the setup exe copied to the install folder');
        const c = S.cfg();
        assert.deepStrictEqual([c.allow, c.port, c.listen, c.allowWrites, c.anyOrigin, c.origins], [[], 8502, '127.0.0.1', false, false, []], 'default config');
        assert.deepStrictEqual(BR.parseConfig(fs.readFileSync(P.config, 'utf8')).warnings, [], 'the bridge reads it without warnings');
        // registry: one reg import (UTF-16LE + BOM) with the Run value and the Uninstall key
        assert.strictEqual(S.regFiles.length, 1); assert.ok(S.regFiles[0].bom, 'BOM');
        const R = regValues(S.regFiles[0].text);
        assert.match(S.regFiles[0].text, /^Windows Registry Editor Version 5\.00\r\n/);
        assert.strictEqual(R[RUN_K]['WTS Modbus Bridge'], '"' + P.exe + '" --run');
        const U = R[UNI_K];
        assert.strictEqual(U.DisplayName, 'WTS Modbus Bridge'); assert.strictEqual(U.DisplayVersion, BRIDGE_VERSION);
        assert.strictEqual(U.UninstallString, '"' + P.exe + '" --uninstall'); assert.strictEqual(U.QuietUninstallString, '"' + P.exe + '" --uninstall --quiet');
        assert.strictEqual(U.InstallLocation, P.dir); assert.strictEqual(U.NoModify, 'dword:00000001'); assert.match(U.EstimatedSize, /^dword:[0-9a-f]{8}$/);
        assert.ok(!fs.existsSync(P.regFile), 'the .reg file is removed again');
        // shortcuts: PowerShell -EncodedCommand, paths only in the environment
        assert.strictEqual(S.ps.length, 1);
        assert.match(S.ps[0].script, /CreateShortcut\(\$env:WTS_LNK_STATUS\)[\s\S]*Arguments = '--open'[\s\S]*CreateShortcut\(\$env:WTS_LNK_UNINSTALL\)[\s\S]*Arguments = '--uninstall'/);
        assert.ok(!/"/.test(S.ps[0].script) && S.ps[0].script.indexOf(P.dir) < 0, 'no paths or double quotes in the script');
        assert.strictEqual(S.ps[0].env.WTS_LNK_STATUS, path.join(S.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WTS Modbus Bridge', 'WTS Modbus Bridge — status.lnk'));
        assert.strictEqual(path.basename(S.ps[0].env.WTS_LNK_UNINSTALL), 'Uninstall WTS Modbus Bridge.lnk'); assert.strictEqual(S.ps[0].env.WTS_EXE, P.exe);
        // an earlier copy is looked for (never this process), the bridge started detached from the install folder
        const tk = S.tools('taskkill.exe')[0];
        assert.deepStrictEqual(tk.args, ['/F', '/IM', 'WTS-Modbus-Bridge.exe', '/FI', 'PID ne 1000']);
        assert.deepStrictEqual(S.spawned.map((x) => [x.cmd, x.args]), [[P.exe, ['--run']]]);
        assert.strictEqual(S.spawned[0].opt.cwd, P.dir);
        assert.deepStrictEqual(S.lastHealth, { port: 8502, host: '127.0.0.1' });
        assert.deepStrictEqual(S.opened, ['http://127.0.0.1:8502/'], 'status page opened'); assert.strictEqual(S.boxes.length, 0, 'no message box on success');
        assert.match(S.out[S.out.length - 1], /^OK: the WTS Modbus bridge is running — status page http:\/\/127\.0\.0\.1:8502\/$/);
        // step order: stop → copy → config → registry → shortcuts → start → open
        const order = S.seq.filter((x) => /taskkill|reg\.exe:import|powershell|spawn|open/.test(x));
        assert.deepStrictEqual(order, ['exec:taskkill.exe:/F', 'exec:reg.exe:import', 'exec:powershell.exe:-NoProfile', 'spawn:WTS-Modbus-Bridge.exe:--run', 'open']);
        // --no-browser / --quiet: no page, no message box (CI)
        const Q = fakeWin();
        try { assert.strictEqual(await Q.app.main(['--no-browser']), 0); assert.deepStrictEqual([Q.opened, Q.boxes], [[], []]); } finally { Q.cleanup(); }
        // --no-autostart: no Run section, the old value deleted
        const N = fakeWin();
        try {
          assert.strictEqual(await N.app.main(['--no-autostart', '--quiet']), 0);
          assert.ok(!regValues(N.regFiles[0].text)[RUN_K], 'no Run value'); assert.ok(regValues(N.regFiles[0].text)[UNI_K]);
          assert.ok(N.tools('reg.exe').some((e) => e.args[0] === 'delete' && /\\Run$/.test(e.args[1]) && e.args[3] === 'WTS Modbus Bridge'));
        } finally { N.cleanup(); }
        // shortcuts failing is not fatal
        const F = fakeWin({ psFails: true });
        try { assert.strictEqual(await F.app.main(['--quiet']), 0); assert.ok(F.logs.some((l) => /shortcuts were not created/.test(l))); } finally { F.cleanup(); }
      } finally { S.cleanup(); }
    },
  },
  {
    name: 'exe launcher: bridge-config.json kept on re-install; --allow / --allow-any / --allow-writes / --read-only / --port update it; a broken file is backed up',
    wp: WP, opts: false,
    async run(app, assert) {
      const S = fakeWin();
      try {
        fs.mkdirSync(S.P.dir, { recursive: true });
        const mine = { _comment: 'mine', allow: ['10.0.0.5:502'], port: 8600, listen: '127.0.0.1', origins: ['https://my.site'], anyOrigin: false, allowWrites: true, verbose: true };
        fs.writeFileSync(S.P.config, JSON.stringify(mine));
        assert.strictEqual(await S.app.main(['--quiet']), 0);
        assert.deepStrictEqual(S.cfg(), mine, 'kept as it is');
        assert.ok(S.out.some((l) => /^Kept .*bridge-config\.json \(allow: 10\.0\.0\.5:502, writes allowed, port 8600\)/.test(l)), S.out.join('\n'));
        assert.deepStrictEqual(S.lastHealth, { port: 8600, host: '127.0.0.1' }, 'health checked on the configured port');
        await S.app.main(['--allow', '10.0.0.6:0502', '--allow', '10.0.0.5:502', '--read-only', '--quiet']);
        let c = S.cfg();
        assert.deepStrictEqual([c.allow, c.allowWrites, c.port, c.origins, c.verbose, c._comment], [['10.0.0.5:502', '10.0.0.6:502'], false, 8600, ['https://my.site'], true, 'mine']);
        await S.app.main(['--allow-any', '--allow-writes', '--port', '8700', '--quiet']);
        c = S.cfg();
        assert.deepStrictEqual([c.allow, c.allowWrites, c.port], [[], true, 8700], '--allow-any empties the list (any device)');
        await S.app.main(['--allow', '*:*', '--quiet']);
        assert.deepStrictEqual(S.cfg().allow, [], '"*:*" is the empty list');
        // a broken file: backed up, defaults written, install goes on
        fs.writeFileSync(S.P.config, '{"allow": [');
        assert.strictEqual(await S.app.main(['--quiet']), 0);
        assert.strictEqual(fs.readFileSync(S.P.config + '.bak', 'utf8'), '{"allow": [');
        assert.deepStrictEqual(S.cfg().allow, []); assert.ok(S.logs.some((l) => /not valid JSON.*bridge-config\.json\.bak/.test(l)));
        fs.writeFileSync(S.P.config, JSON.stringify({ allow: ['1.2.3.4;calc:502'] }));
        await S.app.main(['--quiet']);
        assert.deepStrictEqual(S.cfg().allow, [], 'a config with a bad allow entry is replaced, never passed on');
      } finally { S.cleanup(); }
    },
  },
  {
    name: 'exe launcher: re-install stops the running copy (pid file + image name, never itself); a foreign bridge / program on the port is reported, not fought',
    wp: WP, opts: false,
    async run(app, assert) {
      // our bridge from an earlier install is running (pid file)
      let S = fakeWin({ bridge: 'ours', bridgePid: 4242 });
      try {
        fs.mkdirSync(S.P.dir, { recursive: true }); fs.writeFileSync(S.P.pid, '4242');
        assert.strictEqual(await S.app.main(['--quiet']), 0, S.out.join('\n'));
        const tl = S.tools('tasklist.exe')[0];
        assert.deepStrictEqual(tl.args, ['/FI', 'PID eq 4242', '/FO', 'CSV', '/NH']);
        assert.deepStrictEqual(S.tools('taskkill.exe')[0].args, ['/PID', '4242', '/T', '/F']);
        assert.ok(S.steps === undefined && S.out.some((l) => /Stopped the running copy/.test(l)));
        assert.strictEqual(S.spawned.length, 1, 'restarted'); assert.strictEqual(S.bridge, 'ours');
      } finally { S.cleanup(); }
      // the installed exe run again (double-click / settings change): it does not copy onto itself nor kill itself
      S = fakeWin({ bridge: 'ours', bridgePid: 4242 });
      try {
        fs.mkdirSync(S.P.dir, { recursive: true }); fs.writeFileSync(S.P.exe, 'installed'); S.deps.execPath = S.P.exe;
        S.app = APP.createApp(S.deps);
        assert.strictEqual(await S.app.main(['--allow-writes', '--quiet']), 0);
        assert.strictEqual(fs.readFileSync(S.P.exe, 'utf8'), 'installed');
        assert.ok(S.out.some((l) => /Running from the install folder/.test(l)));
        assert.ok(S.tools('taskkill.exe').every((e) => e.args.indexOf('PID ne 1000') >= 0 || e.args[1] !== '1000'));
        assert.strictEqual(S.cfg().allowWrites, true);
      } finally { S.cleanup(); }
      // another WTS bridge (install-windows.ps1 / by hand) holds the port: installed + registered, not started, explained
      S = fakeWin({ bridge: 'foreign' });
      try {
        assert.strictEqual(await S.app.main([]), 1);
        assert.ok(fs.existsSync(S.P.exe) && S.regFiles.length === 1, 'still installed and registered');
        assert.strictEqual(S.spawned.length, 0, 'no second bridge'); assert.deepStrictEqual(S.opened, []);
        assert.strictEqual(S.boxes.length, 1); assert.match(S.boxes[0].t, /Another WTS Modbus bridge \(started by install-windows\.ps1 or by hand, v1\.1\.0\) already runs on port 8502/);
        assert.strictEqual(S.boxes[0].icon, 'Warning');
      } finally { S.cleanup(); }
      S = fakeWin({ bridge: 'program' });
      try {
        assert.strictEqual(await S.app.main([]), 1);
        assert.match(S.boxes[0].t, /Another program already uses port 8502/); assert.strictEqual(S.spawned.length, 0);
      } finally { S.cleanup(); }
      // the bridge never answers: a warning with the log path, no status page
      S = fakeWin({ neverStarts: true });
      try {
        assert.strictEqual(await S.app.main([]), 1);
        assert.match(S.boxes[0].t, /did not answer on http:\/\/127\.0\.0\.1:8502\/health within 15 s\. See .*bridge\.log/);
        assert.ok(S.t >= 15000, 'waited 15 s (fake clock)'); assert.deepStrictEqual(S.opened, []);
      } finally { S.cleanup(); }
      // an error (not Windows) → message box + exit 1; bad arguments → exit 2
      S = fakeWin();
      try {
        S.deps.platform = 'linux'; S.app = APP.createApp(S.deps);
        assert.strictEqual(await S.app.main([]), 1); assert.match(S.boxes[0].t, /could not be installed:[\s\S]*install\.sh/);
        assert.strictEqual(await S.app.main(['--bogus']), 2); assert.match(S.boxes[1].t, /unknown option --bogus/);
        assert.strictEqual(await S.app.main(['--bogus', '--quiet']), 2); assert.strictEqual(S.boxes.length, 3, 'argument errors always shown (quiet not parsed yet)');
      } finally { S.cleanup(); }
    },
  },
  {
    name: 'exe launcher: --run (single instance, config → bridge options, pid file), --status, --open',
    wp: WP, opts: false,
    async run(app, assert) {
      let S = fakeWin();
      try {
        // no config yet: the default is written and used
        let r = await S.app.run({});
        assert.strictEqual(r.code, null, 'keeps running'); assert.strictEqual(S.runs.length, 1);
        assert.deepStrictEqual(S.cfg().allow, []);
        const o = S.runs[0];
        assert.deepStrictEqual([o.allow, o.port, o.allowWrites, o.listen, o.configFile], [[], 8502, false, '127.0.0.1', S.P.config]);
        assert.match(o.uninstallHint.join(' '), /Settings → Apps → Installed apps → "WTS Modbus Bridge" → Uninstall/);
        assert.strictEqual(fs.readFileSync(S.P.pid, 'utf8'), '1000');
        // settings from the file
        fs.writeFileSync(S.P.config, JSON.stringify({ allow: ['10.0.0.0/24:502'], port: 8600, allowWrites: true, verbose: false }));
        r = await S.app.run({ verbose: true });
        assert.deepStrictEqual([S.runs[1].allow, S.runs[1].port, S.runs[1].allowWrites, S.runs[1].verbose], [['10.0.0.0/24:502'], 8600, true, true]);
        // already running → exit 0 without a second bridge; a foreign program → exit 1
        S.bridge = 'ours';
        assert.strictEqual(await S.app.main(['--run']), 0); assert.strictEqual(S.runs.length, 2);
        assert.ok(S.logs.some((l) => /already answers on port 8600 — not starting a second one/.test(l)));
        S.bridge = 'program';
        assert.strictEqual(await S.app.main(['--run']), 1); assert.strictEqual(S.runs.length, 2);
        // --status
        S.bridge = 'ours'; S.runValue = true; fs.writeFileSync(S.P.exe, 'x');
        assert.strictEqual(await S.app.main(['--status']), 0);
        const st = JSON.parse(S.out[S.out.length - 1]);
        assert.deepStrictEqual([st.installed, st.autostart, st.running, st.url, st.health.name], [true, true, true, 'http://127.0.0.1:8600/', 'wts-modbus-bridge']);
        S.bridge = null;
        assert.strictEqual(await S.app.main(['--status']), 3, 'not running → 3');
        // --open: starts it when needed, then the status page
        assert.strictEqual(await S.app.main(['--open']), 0);
        assert.deepStrictEqual(S.spawned.map((x) => x.args), [['--run']]); assert.deepStrictEqual(S.opened, ['http://127.0.0.1:8600/']);
        S.bridge = 'program';
        assert.strictEqual(await S.app.main(['--open']), 1); assert.match(S.boxes[0].t, /Another program uses port 8600/);
        assert.strictEqual(await S.app.main(['--version']), 0); assert.strictEqual(S.out[S.out.length - 1], BRIDGE_VERSION);
      } finally { S.cleanup(); }
    },
  },
  {
    name: 'exe launcher: --uninstall (Run value, Apps entry, shortcuts, folder; the running exe is deleted by a detached cmd after the confirmation)',
    wp: WP, opts: false,
    async run(app, assert) {
      let S = fakeWin();
      try {
        assert.strictEqual(await S.app.main(['--quiet']), 0);
        fs.mkdirSync(S.P.startMenu, { recursive: true }); fs.writeFileSync(S.P.statusLnk, 'lnk'); fs.writeFileSync(S.P.uninstallLnk, 'lnk');
        fs.writeFileSync(S.P.log, 'log'); fs.writeFileSync(S.P.pid, '5555');
        // as Settings → Apps runs it: the installed exe
        S.deps.execPath = S.P.exe; S.deps.pid = 7000; S.app = APP.createApp(S.deps); S.seq.length = 0; S.exec.length = 0;
        assert.strictEqual(await S.app.main(['--uninstall']), 0);
        assert.strictEqual(S.bridge, null, 'the bridge was stopped');
        assert.deepStrictEqual(S.tools('tasklist.exe')[0].args.slice(0, 2), ['/FI', 'PID eq 5555']);
        const regs = S.tools('reg.exe').map((e) => e.args);
        assert.deepStrictEqual(regs, [['delete', APP.RUN_KEY, '/v', 'WTS Modbus Bridge', '/f'], ['delete', APP.UNINSTALL_KEY, '/f']]);
        assert.ok(!fs.existsSync(S.P.startMenu), 'shortcuts removed');
        assert.deepStrictEqual(fs.readdirSync(S.P.dir), [APP.EXE_NAME], 'everything but the running exe removed now');
        const del = S.spawned[S.spawned.length - 1];
        assert.strictEqual(del.cmd, S.env.ComSpec); assert.strictEqual(del.opt.windowsVerbatimArguments, true);
        assert.deepStrictEqual(del.args.slice(0, 2), ['/d', '/c']);
        assert.strictEqual(del.args[2], 'ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + S.P.dir + '" & if exist "' + S.P.dir + '" (ping -n 6 127.0.0.1 >nul & rmdir /s /q "' + S.P.dir + '")');
        assert.strictEqual(del.opt.cwd, path.dirname(S.P.dir), 'cmd does not sit in the folder it deletes');
        assert.deepStrictEqual(S.seq.filter((x) => x === 'box' || /^spawn/.test(x)), ['box', 'spawn:cmd.exe:/d'], 'confirmation first, then the delayed delete');
        assert.match(S.boxes[0].t, /has been uninstalled/);
      } finally { S.cleanup(); }
      // from a copy outside the folder (e.g. the setup exe with --uninstall): removed at once, quietly
      S = fakeWin();
      try {
        await S.app.main(['--quiet']);
        assert.strictEqual(await S.app.main(['--uninstall', '--quiet']), 0);
        assert.ok(!fs.existsSync(S.P.dir)); assert.strictEqual(S.boxes.length, 0);
        assert.ok(!S.spawned.some((x) => /cmd/.test(x.cmd)), 'no delayed delete needed');
      } finally { S.cleanup(); }
    },
  },
  {
    name: 'exe launcher for real on this OS: --run serves /health + status page, a second --run exits 0 (single instance), --status, log file',
    wp: WP, opts: false, timeoutMs: 30000,
    async run(app, assert) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wts exe run '));
      const env = Object.assign({}, process.env, { HOME: home, XDG_DATA_HOME: path.join(home, 'data'), LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') });
      const P = APP.paths({ platform: process.platform, env, path });
      const port = await freePort();
      fs.mkdirSync(P.dir, { recursive: true });
      fs.writeFileSync(P.config, JSON.stringify({ allow: [], port, listen: '127.0.0.1', allowWrites: false }));
      const script = path.join(EXE_DIR, 'bridge-app.js');
      const child = spawn(process.execPath, [script, '--run'], { env, stdio: 'ignore' });
      try {
        const h = await until(async () => { const r = await request(port, '/health'); return r && r.status === 200 && JSON.parse(r.body); }, 10000, '/health');
        assert.deepStrictEqual([h.name, h.version, h.allow, h.readOnly, h.port], ['wts-modbus-bridge', BRIDGE_VERSION, ['*:*'], true, port]);
        const page = await request(port, '/');
        assert.match(page.headers['content-type'], /text\/html/); assert.match(page.body, /✓ WTS Modbus Bridge v[\d.]+ is running on this PC/);
        assert.includes(page.body, P.config.replace(/&/g, '&amp;'), 'settings file named');
        const again = spawnSync(process.execPath, [script, '--run'], { env, encoding: 'utf8', timeout: 10000 });
        assert.strictEqual(again.status, 0, 'second --run exits at once');
        const st = spawnSync(process.execPath, [script, '--status'], { env, encoding: 'utf8', timeout: 10000 });
        assert.strictEqual(st.status, 0); assert.strictEqual(JSON.parse(st.stdout).running, true);
        const logText = fs.readFileSync(P.log, 'utf8');
        assert.match(logText, /listening on ws:\/\/127\.0\.0\.1:\d+\/modbus \(read-only; allow: any device\)/); assert.match(logText, /already answers on port/);
        assert.strictEqual(fs.readFileSync(P.pid, 'utf8'), String(child.pid));
        child.kill('SIGTERM');
        await until(async () => !(await request(port, '/health')), 5000, 'the bridge to stop');
        await until(() => !fs.existsSync(P.pid), 3000, 'the pid file to be removed');
      } finally { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } fs.rmSync(home, { recursive: true, force: true }); }
      // the log rotates at the size limit
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-log-')), f = path.join(dir, 'bridge.log');
      try {
        const log = APP.createLogger(fs, f, 100);
        for (let i = 0; i < 20; i++) log('line ' + i + ' ' + 'x'.repeat(20));
        assert.ok(fs.existsSync(f + '.1') && fs.statSync(f).size < 200, 'rotated'); assert.match(fs.readFileSync(f, 'utf8'), /line 19/);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'bridge status page (GET /): escaped, no scripts (CSP), any device / read-only wording, Host / Origin refusals like /health',
    wp: WP, opts: false, timeoutMs: 20000,
    async run(app, assert) {
      const html = BR.statusPageHtml({ name: 'wts-modbus-bridge', version: '1.2.0<script>', readOnly: true, port: 8502, uptimeS: 3725, allow: ['<img src=x onerror=alert(1)>:502'] },
        { listen: '127.0.0.1', configFile: 'C:\\Users\\a&b\\bridge-config.json', uninstall: ['Settings → Apps "x" <b>'] });
      assert.ok(!/<script|<img/i.test(html), 'nothing unescaped'); assert.includes(html, '&lt;img src=x onerror=alert(1)&gt;:502'); assert.includes(html, 'a&amp;b');
      assert.includes(html, '1 h 2 min'); assert.includes(html, 'Refused — read-only'); assert.includes(html, '&quot;x&quot; &lt;b&gt;');
      const any = BR.statusPageHtml({ name: 'wts-modbus-bridge', version: '1.2.0', readOnly: false, port: 8600, uptimeS: 5, allow: ['*:*'] }, {});
      assert.includes(any, 'Any device IP address / port'); assert.includes(any, '<b>Allowed</b>'); assert.includes(any, 'ws://127.0.0.1:8600');
      assert.includes(any, 'press <b>Check bridge</b>'); assert.includes(any, 'install.sh&quot; --uninstall'); assert.includes(any, 'Uninstall WTS Modbus Bridge');
      const b = BR.createBridge({ port: 0 }), port = await b.listen();
      try {
        const r = await request(port, '/');
        assert.strictEqual(r.status, 200); assert.match(r.headers['content-type'], /^text\/html/);
        assert.match(r.headers['content-security-policy'], /default-src 'none'/); assert.strictEqual(r.headers['x-frame-options'], 'DENY');
        assert.match(r.body, /Any device IP address \/ port/); assert.match(r.body, /this computer only/);
        assert.strictEqual((await request(port, '/status')).status, 200);
        assert.strictEqual((await request(port, '/', { Host: 'evil.example:' + port })).status, 403, 'DNS-rebound host name refused');
        assert.strictEqual((await request(port, '/', { Origin: 'https://evil.example' })).status, 403, 'foreign origin refused');
        assert.strictEqual((await request(port, '/', { Origin: 'http://localhost:8080' })).status, 200);
        assert.match((await request(port, '/other')).body, /^WTS Modbus bridge v/, 'other paths: the plain text as before');
      } finally { await b.close(); }
    },
  },
  {
    name: 'pe.js: reads PE32+ / PE32 headers, patches the subsystem CONSOLE → WINDOWS_GUI, strips the certificate table; refuses non-PE data',
    wp: WP, opts: false,
    run(app, assert) {
      for (const plus of [true, false]) {
        const buf = synthPe({ plus, cert: 64 });
        const info = PE.readPe(buf);
        assert.deepStrictEqual([info.magic, info.subsystem, info.peOffset, info.securityDir.size], [plus ? 'PE32+' : 'PE32', 3, 0x80, 64]);
        assert.strictEqual(info.subsystemOffset, 0x80 + 24 + 68);
        const stripped = PE.stripSignature(buf);
        assert.strictEqual(stripped.length, buf.length - 64, 'table cut off'); assert.deepStrictEqual(PE.readPe(stripped).securityDir, { entryOffset: info.securityDir.entryOffset, offset: 0, size: 0 });
        PE.setSubsystem(stripped, PE.SUBSYSTEM.WINDOWS_GUI);
        assert.strictEqual(PE.readPe(stripped).subsystem, 2); assert.strictEqual(stripped.readUInt16LE(info.subsystemOffset), 2);
        assert.strictEqual(buf.readUInt16LE(info.subsystemOffset), 3, 'the input of stripSignature is not changed');
        const unsigned = synthPe({ plus });
        assert.strictEqual(PE.stripSignature(unsigned), unsigned, 'nothing to strip');
      }
      assert.throws(() => PE.readPe(Buffer.from('#!/bin/sh\necho not a PE file at all.............................................')), /no MZ header/);
      const bad = synthPe(); bad.writeUInt32LE(0x12345678, 0x80);
      assert.throws(() => PE.readPe(bad), /no PE signature/);
      // the downloaded / built exe, when a local build left it behind (tools/modbus-bridge/exe/dist)
      const built = path.join(EXE_DIR, 'dist', BUILD.OUT_NAME);
      if (fs.existsSync(built)) {
        const b = fs.readFileSync(built), i = PE.readPe(b);
        assert.deepStrictEqual([i.magic, i.subsystem, i.securityDir.size], ['PE32+', 2, 0], 'built exe: GUI subsystem, no stale signature');
        assert.ok(b.indexOf(BUILD.FUSE + ':1') > 0 && b.indexOf('single executable application bundle') > 0, 'SEA blob injected');
      }
    },
  },
  {
    name: 'build-exe.js bundle: one CommonJS script (bridge inlined) that runs without ../modbus-bridge.js; SEA config',
    wp: WP, opts: false, timeoutMs: 20000,
    run(app, assert) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-bundle-'));
      try {
        BUILD.bundle(dir);
        const main = path.join(dir, 'sea-main.js'), src = fs.readFileSync(main, 'utf8');
        assert.ok(!/require\('\.\.\/modbus-bridge\.js'\)[^:]/.test(src.replace(/typeof __WTS_BRIDGE__ !== 'undefined'\) \? __WTS_BRIDGE__ : require\('\.\.\/modbus-bridge\.js'\)/, '')), 'only the dev fallback mentions ../modbus-bridge.js');
        assert.ok(!/^#!/m.test(src), 'no shebang lines inside');
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'sea-config.json'), 'utf8'));
        assert.deepStrictEqual(cfg, { main: 'sea-main.js', output: 'sea-prep.blob', disableExperimentalSEAWarning: true, useCodeCache: false });
        let r = spawnSync(process.execPath, [main, '--version'], { encoding: 'utf8', cwd: dir });
        assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), BRIDGE_VERSION);
        r = spawnSync(process.execPath, [main, '--help'], { encoding: 'utf8', cwd: dir });
        assert.match(r.stdout, /WTS Modbus Bridge v[\d.]+ — WebSocket <-> Modbus TCP bridge/);
        // bundled names match the module
        r = spawnSync(process.execPath, ['-e', 'const m=require(process.argv[1]);console.log(m.bridge.BRIDGE_NAME+" "+typeof m.bridge.createBridge)', main], { encoding: 'utf8' });
        assert.strictEqual(r.stdout.trim(), 'wts-modbus-bridge function');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'release scripts: self-contained install.sh (bridge files + install.sh embedded, SHA-256 = pack, empty presets) + package zip; piped into bash end to end',
    wp: WP, opts: false, timeoutMs: 90000,
    async run(app, assert) {
      const r = RELEASE.build({ date: new Date(2026, 8, 30, 12, 0, 0) });
      assert.strictEqual(r.version, BRIDGE_VERSION);
      assert.deepStrictEqual(Object.keys(r.files).sort(), ['wts-modbus-bridge-' + BRIDGE_VERSION + '.zip', 'wts-modbus-bridge-install.sh']);
      const sh = r.files['wts-modbus-bridge-install.sh'].toString('utf8');
      const packFiles = PACK.readFiles();
      assert.match(sh, /^EMBEDDED_FILES="modbus-bridge\.js fake-slave\.js README\.md install\.sh"$/m);
      for (const k of ['PRESET_ALLOW', 'PRESET_PORT', 'PRESET_LISTEN', 'PRESET_ALLOW_WRITES', 'PRESET_AUTOSTART', 'PRESET_ORIGINS']) assert.match(sh, new RegExp('^' + k + '=""$', 'm'), k + ' empty');
      const re = /^ {8}([\w.-]+)\)\n {12}cat <<'WTS_PAYLOAD_EOF'\n([\s\S]*?)\nWTS_PAYLOAD_EOF$/gm, got = {};
      let m; while ((m = re.exec(sh))) got[m[1]] = Buffer.from(m[2].replace(/\s+/g, ''), 'base64').toString('utf8');
      assert.deepStrictEqual(Object.keys(got).sort(), ['README.md', 'fake-slave.js', 'install.sh', 'modbus-bridge.js']);
      for (const f of Object.keys(got)) {
        assert.strictEqual(got[f], packFiles[f], f + ' = tools/modbus-bridge/' + f);
        assert.match(sh, new RegExp("^ {8}" + f.replace(/\./g, '\\.') + "\\) printf '%s' '" + PACK.sha256(packFiles[f]) + "' ;;$", 'm'), f + ' sha256');
      }
      const strip = (t) => t.replace(/# @@WTS-PAYLOAD-BEGIN@@[\s\S]*?# @@WTS-PAYLOAD-END@@/, '<P>');
      assert.strictEqual(strip(sh), strip(packFiles['install.sh']), 'only the payload block differs from install.sh');
      assert.match(sh, /^set -euo pipefail\n[\s\S]*^\{\nSELF="\$\{BASH_SOURCE\[0\]:-\}"/m, 'pipe-safe: one { … } group, BASH_SOURCE may be empty');
      assert.match(sh, /\nexit "\$code"\n\}\n$/);
      if (hasBash) { const t = spawnSync('bash', ['-n'], { input: sh, encoding: 'utf8' }); assert.strictEqual(t.status, 0, t.stderr); }
      // the zip = the app's package
      const zip = r.files['wts-modbus-bridge-' + BRIDGE_VERSION + '.zip'];
      assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
      for (const f of PACK.FILES) assert.ok(zip.indexOf('wts-modbus-bridge/' + f) > 0, f + ' in the zip');
      // a plain install.sh piped into bash has no files: a clear message, nothing installed
      if (hasBash && process.platform !== 'win32') {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wts pipe plain '));
        try {
          const env = Object.assign({}, process.env, { HOME: home }); delete env.XDG_DATA_HOME;
          const p = spawnSync('bash', ['-s', '--', '--no-start'], { input: packFiles['install.sh'], env, encoding: 'utf8', timeout: 30000 });
          assert.strictEqual(p.status, 1); assert.match(p.stderr, /no bridge files built in - piped into bash, use the release installer: curl -fsSL/);
          const h = spawnSync('bash', ['-s', '--', '--help'], { input: packFiles['install.sh'], env, encoding: 'utf8' });
          assert.strictEqual(h.status, 0); assert.match(h.stdout, /--autostart/);
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
        // end to end, piped (the same script CI runs)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-rel-'));
        try {
          const f = path.join(dir, 'wts-modbus-bridge-install.sh'); fs.writeFileSync(f, sh, { mode: 0o755 });
          const { testReleaseSh } = require(path.join(EXE_DIR, 'test-release-sh.js'));
          const res = await testReleaseSh(f, { log() {}, files: { 'modbus-bridge.js': packFiles['modbus-bridge.js'], 'install.sh': packFiles['install.sh'] } });
          assert.ok(res.ok);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
    },
  },
  {
    name: 'workflow modbus-bridge-release.yml: parses; tag + manual trigger; Windows build + smoke test, Linux e2e, release job with the 4 assets marked latest',
    wp: WP, opts: false,
    run(app, assert) {
      const f = path.join(REPO, '.github', 'workflows', 'modbus-bridge-release.yml'), y = fs.readFileSync(f, 'utf8');
      assert.ok(!/\t/.test(y), 'no tabs'); assert.ok(!/\r/.test(y), 'LF');
      const py = spawnSync('python3', ['-c', 'import sys,json,yaml; d=yaml.safe_load(open(sys.argv[1])); d["on"]=d.get("on", d.get(True)); d.pop(True, None); print(json.dumps(d))', f], { encoding: 'utf8' });
      let W = null;
      if (py.status === 0) W = JSON.parse(py.stdout);
      else console.log('      (PyYAML not available: structural checks only)');
      if (W) {
        assert.deepStrictEqual(W.on.push.tags, ['modbus-bridge-v*']); assert.ok('workflow_dispatch' in W.on);
        const J = W.jobs;
        assert.strictEqual(J['windows-exe']['runs-on'], 'windows-latest'); assert.strictEqual(J['unix-scripts']['runs-on'], 'ubuntu-latest');
        const runs = (j) => J[j].steps.map((s) => s.run || s.uses || '').join('\n');
        for (const j of ['windows-exe', 'unix-scripts']) {
          const node = J[j].steps.find((s) => s.uses === 'actions/setup-node@v4');
          assert.strictEqual(String(node.with['node-version']), '22', j + ' Node 22');
        }
        assert.match(runs('windows-exe'), /node tools\/modbus-bridge\/exe\/build-exe\.js --out dist/);
        assert.match(runs('windows-exe'), /node tools\/modbus-bridge\/exe\/ci-smoke-exe\.js dist\/WTS-Modbus-Bridge-Setup\.exe/);
        assert.match(runs('windows-exe'), /BRIDGE_VERSION[\s\S]*GITHUB_REF_NAME/, 'tag = BRIDGE_VERSION');
        assert.match(runs('unix-scripts'), /build-release-scripts\.js --out dist/); assert.match(runs('unix-scripts'), /bash -n dist\/wts-modbus-bridge-install\.sh/);
        assert.match(runs('unix-scripts'), /test-release-sh\.js dist\/wts-modbus-bridge-install\.sh/);
        const R = J.release;
        assert.deepStrictEqual(R.needs, ['windows-exe', 'unix-scripts']); assert.match(R.if, /startsWith\(github\.ref, 'refs\/tags\/modbus-bridge-v'\)/);
        assert.strictEqual(R.permissions.contents, 'write'); assert.strictEqual(W.permissions.contents, 'read');
        const gh = R.steps.find((s) => /^softprops\/action-gh-release@v2$/.test(s.uses || ''));
        assert.ok(gh); assert.strictEqual(String(gh.with.make_latest), 'true');
        const files = gh.with.files.trim().split('\n').map((x) => x.trim());
        assert.deepStrictEqual(files, ['assets/WTS-Modbus-Bridge-Setup.exe', 'assets/wts-modbus-bridge-install.sh', 'assets/wts-modbus-bridge-*.zip', 'assets/SHA256SUMS.txt']);
        assert.match(R.steps.map((s) => s.run || '').join('\n'), /sha256sum WTS-Modbus-Bridge-Setup\.exe wts-modbus-bridge-install\.sh wts-modbus-bridge-\*\.zip > SHA256SUMS\.txt/);
        assert.includes(gh.with.body, ONE_LINER); assert.includes(gh.with.body, 'More info');
      }
      // structural (also without PyYAML)
      assert.match(y, /^on:\n  push:\n    tags:\n      - 'modbus-bridge-v\*'\n  workflow_dispatch:\n/m);
      for (const s of ['build-exe.js', 'ci-smoke-exe.js', 'build-release-scripts.js', 'test-release-sh.js', 'softprops/action-gh-release@v2', "make_latest: 'true'", 'contents: write']) assert.includes(y, s);
      const smoke = fs.readFileSync(path.join(EXE_DIR, 'ci-smoke-exe.js'), 'utf8');
      for (const s of ["run(setup, ['--version'])", "run(setup, ['--no-browser'])", "assert.deepStrictEqual(h.allow, ['*:*'])", "run(exe, ['--run']", "run(exe, ['--uninstall', '--quiet'])", "'Run value removed'", 'LOCALAPPDATA: path.join(tmp', 'SUBSYSTEM.WINDOWS_GUI']) assert.includes(smoke, s);
      const r = spawnSync(process.execPath, [path.join(EXE_DIR, 'ci-smoke-exe.js')], { encoding: 'utf8' });
      if (process.platform !== 'win32') { assert.strictEqual(r.status, 0, r.stderr); assert.match(r.stdout, /skipped: needs Windows/); }
      // README: how to cut a release, the links
      const readme = fs.readFileSync(path.join(TOOLS, 'README.md'), 'utf8');
      assert.includes(readme, 'git tag modbus-bridge-v' + BRIDGE_VERSION + ' && git push origin modbus-bridge-v' + BRIDGE_VERSION);
      assert.includes(readme, EXE_URL); assert.includes(readme, ONE_LINER);
      assert.match(fs.readFileSync(path.join(EXE_DIR, '.gitignore'), 'utf8'), /^dist\/$/m);
    },
  },
  {
    name: 'Modbus page one-click path: macOS / Linux one-liner (default port), Windows exe link; "any device" default passes Check bridge for every device',
    wp: WP,
    async run(app, assert) {
      const cfg = { devices: [
        { id: 'a', name: 'PLC-A', transport: 'ws', host: '192.168.7.10', port: 502, url: 'ws://127.0.0.1:8502', unit: 1 },
        { id: 'b', name: 'RTU-B', transport: 'ws', host: 'rtu-b.local', port: 5020, url: 'ws://127.0.0.1:8502', unit: 1 }], tags: [] };
      app.storage.setItem('wts_modbus_config', JSON.stringify(cfg));
      app.click(app.find('.nav-btn[data-p="modbus"]'));
      const ctl = app.win.WTS_modbus.page.controller();
      const S = app.win.WTS_modbusBridgeSetup;
      const q = S.quickSetup('macos', { port: 8502 });
      assert.deepStrictEqual([q.exeUrl, q.oneLiner], [EXE_URL, ONE_LINER]);
      assert.strictEqual(S.quickSetup('linux', { port: 9000 }).oneLiner, ONE_LINER + ' --port 9000');
      assert.strictEqual(S.quickSetup('windows', { port: 'x' }).port, 8502);
      // Windows (guessed from the harness platform): the big download link
      assert.strictEqual(app.el('mbc_guide_exe').getAttribute('href'), EXE_URL);
      assert.match(app.el('mbc_guide_exe').className, /btn-primary/);
      for (const os2 of ['macos', 'linux']) {
        app.click(app.find('[data-act="guide-os"][data-os="' + os2 + '"]'));
        assert.ok(!app.el('mbc_guide_exe'));
        const step = app.findAll('#mbc_guide_steps .mb-quick > li')[0];
        assert.includes(text(step), ONE_LINER); assert.includes(text(step), os2 === 'macos' ? 'a LaunchAgent' : 'a systemd --user service');
        const btn = app.findAll('[data-act="guide-copy"]').find((b) => b.getAttribute('data-copy') === ONE_LINER);
        assert.ok(btn, 'copy button for the one-liner'); app.click(btn); await app.flushAsync(10);
        assert.strictEqual(app.clipboard, ONE_LINER);
      }
      // the default bridge (allow *:*) covers every device; a restricted one does not
      app.win.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ name: 'wts-modbus-bridge', version: BRIDGE_VERSION, readOnly: true, port: 8502, uptimeS: 3, allow: ['*:*'] }) });
      app.click(app.find('[data-act="guide-check"]')); await app.flushAsync(20);
      let t = text(app.el('mbc_guide_check'));
      assert.ok(ctl.lastCheck.ok, JSON.stringify(ctl.lastCheck));
      assert.includes(t, '✓ PLC-A — 192.168.7.10:502 is in the allow-list'); assert.includes(t, '✓ RTU-B — rtu-b.local:5020 is in the allow-list'); assert.includes(t, 'Bridge allow-list: *:*');
      assert.ok(S.allowedBy(['*:*'], 'fd00::1', 1) && S.allowedBy(['*:502'], '10.1.1.1', 502) && !S.allowedBy(['*:502'], '10.1.1.1', 503));
      app.win.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ name: 'wts-modbus-bridge', version: BRIDGE_VERSION, readOnly: true, port: 8502, uptimeS: 3, allow: ['192.168.7.10:502'] }) });
      app.click(app.find('[data-act="guide-check"]')); await app.flushAsync(20);
      t = text(app.el('mbc_guide_check'));
      assert.ok(!ctl.lastCheck.ok); assert.includes(t, '✗ RTU-B — rtu-b.local:5020 is NOT in the allow-list');
      // no bridge: the hint names the Windows Start-menu entry of the exe
      app.win.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
      app.click(app.find('[data-act="guide-check"]')); await app.flushAsync(20);
      assert.includes(text(app.el('mbc_guide_check')), 'Start menu → "WTS Modbus Bridge — status"');
      // troubleshooting explains SmartScreen
      assert.match(text(app.el('mbc_guide')), /Windows protected your PC.*More info.*Run anyway/);
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0);
      assert.strictEqual(app.errors.length, 0, app.errors.map((e) => e.message).join('; '));
    },
  },
];
