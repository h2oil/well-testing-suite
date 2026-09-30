#!/usr/bin/env node
// =============================================================================
// bridge-app.js — WTS Modbus Bridge for Windows: one-click installer + background runner.
//
// Built into WTS-Modbus-Bridge-Setup.exe by build-exe.js (Node.js single executable application,
// Windows GUI subsystem = no console window). The exe carries Node.js, so nothing else is needed,
// and it never needs administrator rights (everything is per user, HKCU).
//
//   (no arguments)   install (double-click): copy this exe to
//                    %LOCALAPPDATA%\WTS Modbus Bridge\WTS-Modbus-Bridge.exe, keep / write
//                    bridge-config.json there (default: any device IP / port, read-only, port 8502),
//                    stop an earlier copy of the bridge, register auto-start at login
//                    (HKCU\...\Run "WTS Modbus Bridge" = "<exe>" --run), add Start-menu shortcuts
//                    ("WTS Modbus Bridge — status", "Uninstall WTS Modbus Bridge") and an entry in
//                    Settings → Apps (HKCU Uninstall key), start the bridge, wait for /health and open
//                    its status page http://127.0.0.1:<port>/ in the default browser.
//   --run            run the bridge with the install folder's bridge-config.json (what the Run entry
//                    starts); single instance: exits 0 when the port already answers as this bridge.
//                    Log: bridge.log in the install folder (1 MB, one old copy bridge.log.1).
//   --open           start the bridge when it is not running, then open its status page (Start menu).
//   --uninstall      stop the bridge, remove the Run value, shortcuts, Apps entry and the install
//                    folder (its own exe is deleted by a detached cmd a moment after it exits).
//   --status         print {installed, autostart, running, health} as JSON (exit 0 running, 3 not).
//   --version        print the bridge version.
//   Options (install, or on their own to change an installed bridge — it is restarted):
//   --allow host:port   add a target (an empty list = any device; listing targets restricts it)
//   --allow-any         empty the list again (any device IP / port)
//   --keep-allow        keep the allow list of an older installer (see below)
//   Allow list on a re-install: bridge-config.json carries "allowMode": "any" | "list" (v1.2.1+). A file
//   without it comes from an older installer: with no --allow / --allow-any / --keep-allow its list is
//   replaced by any device (the default since v1.2) and a note says so. A marked file is kept as it is.
//   --allow-writes / --read-only    forward / refuse Modbus writes (FC 05/06/15/16)
//   --port N            bridge port (default 8502)
//   --no-autostart      do not start the bridge at login (removes the Run value)
//   --no-browser, --quiet   no browser page and no message boxes (scripts, CI)
//
// Everything that touches the system goes through the deps object (platform, env, fs, path, exec,
// spawnDetached, getHealth, openUrl, messageBox, sleep), so the steps are unit-tested on any OS
// (prism-build/tests/modbus-bridge-exe.test.js) and the exe itself is smoke-tested on Windows in CI
// (.github/workflows/modbus-bridge-release.yml).
// =============================================================================
'use strict';

const nodePath = require('path');
const nodeFs = require('fs');
const http = require('http');
const cp = require('child_process');
// In the exe the bridge module is bundled in front of this file as __WTS_BRIDGE__ (build-exe.js).
/* global __WTS_BRIDGE__ */
const B = (typeof __WTS_BRIDGE__ !== 'undefined') ? __WTS_BRIDGE__ : require('../modbus-bridge.js');

const APP_NAME = 'WTS Modbus Bridge';
const EXE_NAME = 'WTS-Modbus-Bridge.exe';
const SETUP_NAME = 'WTS-Modbus-Bridge-Setup.exe';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = APP_NAME;
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WTSModbusBridge';
const PUBLISHER = 'H2Oil';
const HOMEPAGE = 'https://github.com/h2oil/well-testing-suite';
const STATUS_LNK = APP_NAME + ' — status.lnk';
const UNINSTALL_LNK = 'Uninstall ' + APP_NAME + '.lnk';
const LOG_MAX = 1024 * 1024;
const DEFAULT_PORT = 8502;
const CONFIG_COMMENT = 'WTS Modbus bridge settings (written by WTS-Modbus-Bridge-Setup.exe). allow = the host:port targets the bridge may connect to; an empty list = any device IP / port (allowMode "any"; "list" = only the targets in allow, kept when the installer runs again). Restart the bridge after editing (Start menu: WTS Modbus Bridge — status, or run the setup exe again).';
const WIN_UNINSTALL_HINT = ['Settings → Apps → Installed apps → "WTS Modbus Bridge" → Uninstall, or Start menu → "Uninstall WTS Modbus Bridge".'];

function usage() {
  return [
    'WTS Modbus Bridge v' + B.BRIDGE_VERSION + ' — WebSocket <-> Modbus TCP bridge for the Well Testing Suite',
    '',
    '  ' + SETUP_NAME + '               install for this user (no admin), start now and at every login, open the status page',
    '  ' + EXE_NAME + ' --run          run the bridge (what the login entry starts)',
    '  ' + EXE_NAME + ' --open         start it if needed and open the status page',
    '  ' + EXE_NAME + ' --status       print the status as JSON',
    '  ' + EXE_NAME + ' --uninstall    remove it',
    '  --version, --allow host:port, --allow-any, --keep-allow, --allow-writes, --read-only, --port N, --no-autostart, --no-browser (--quiet)',
  ].join('\n');
}

// ─── arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { cmd: 'install', allow: [], allowAny: false, keepAllow: false, allowWrites: undefined, port: undefined, quiet: false, noAutostart: false, verbose: false, changes: false };
  const cmds = { '--run': 'run', '--open': 'open', '--uninstall': 'uninstall', '--status': 'status', '--version': 'version', '-V': 'version', '--help': 'help', '-h': 'help', '/?': 'help' };
  let cmdSeen = null;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const v = () => { if (i + 1 >= argv.length) throw new Error(a + ' needs a value'); return String(argv[++i]); };
    if (cmds[a]) {
      if (cmdSeen && cmdSeen !== cmds[a]) throw new Error('use only one of --run, --open, --uninstall, --status, --version');
      cmdSeen = o.cmd = cmds[a];
    } else if (a === '--allow') { const t = v(); B.parseAllow(t); o.allow.push(t.trim()); o.changes = true; }
    else if (a === '--allow-any') { o.allowAny = true; o.changes = true; }
    else if (a === '--keep-allow') { o.keepAllow = true; o.changes = true; }
    else if (a === '--allow-writes') { o.allowWrites = true; o.changes = true; }
    else if (a === '--read-only') { o.allowWrites = false; o.changes = true; }
    else if (a === '--port') {
      const p = v();
      if (!/^\d{1,5}$/.test(p) || +p < 1 || +p > 65535) throw new Error('bad --port ' + p + ' (1-65535)');
      o.port = +p; o.changes = true;
    }
    else if (a === '--no-autostart') o.noAutostart = true;
    else if (a === '--no-browser' || a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else throw new Error('unknown option ' + a + ' (see --help)');
  }
  if (o.changes && (o.cmd === 'run' || o.cmd === 'uninstall' || o.cmd === 'version')) throw new Error('settings options go with an install (no --' + o.cmd + ')');
  return o;
}

// ─── paths ────────────────────────────────────────────────────────────────────
function paths(deps) {
  const P = deps.path, env = deps.env || {};
  let dir;
  if (deps.platform === 'win32') dir = P.join(env.LOCALAPPDATA || P.join(env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local'), APP_NAME);
  else if (deps.platform === 'darwin') dir = P.join(env.HOME || '/tmp', 'Library', 'Application Support', APP_NAME);
  else dir = P.join(/^\//.test(env.XDG_DATA_HOME || '') ? env.XDG_DATA_HOME : P.join(env.HOME || '/tmp', '.local', 'share'), 'wts-modbus-bridge');
  const sys = env.SystemRoot || env.windir || 'C:\\Windows';
  const startMenu = P.join(env.APPDATA || P.join(env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME);
  return {
    dir, exe: P.join(dir, EXE_NAME), config: P.join(dir, 'bridge-config.json'), log: P.join(dir, 'bridge.log'), pid: P.join(dir, 'bridge.pid'),
    startMenu, statusLnk: P.join(startMenu, STATUS_LNK), uninstallLnk: P.join(startMenu, UNINSTALL_LNK), regFile: P.join(dir, 'install.reg'),
    reg: P.join(sys, 'System32', 'reg.exe'), taskkill: P.join(sys, 'System32', 'taskkill.exe'), tasklist: P.join(sys, 'System32', 'tasklist.exe'),
    powershell: P.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), cmd: env.ComSpec || P.join(sys, 'System32', 'cmd.exe'),
    rundll32: P.join(sys, 'System32', 'rundll32.exe'),
  };
}
function samePath(deps, a, b) {
  const n = (x) => deps.path.resolve(String(x));
  return deps.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}
function insideDir(deps, file, dir) {
  const f = deps.path.resolve(String(file)), d = deps.path.resolve(String(dir)) + deps.path.sep;
  return deps.platform === 'win32' ? f.toLowerCase().startsWith(d.toLowerCase()) : f.startsWith(d);
}

// ─── config ───────────────────────────────────────────────────────────────────
function defaultConfig() {
  return { _comment: CONFIG_COMMENT, allow: [], allowMode: 'any', port: DEFAULT_PORT, listen: '127.0.0.1', origins: [], anyOrigin: false, allowWrites: false, verbose: false };
}
// → { config, state: 'new' | 'kept' | 'replaced', warning }
function loadConfig(deps, file) {
  let text;
  try { text = deps.fs.readFileSync(file, 'utf8'); } catch (e) { return { config: defaultConfig(), state: 'new' }; }
  try {
    B.parseConfig(text, file);                                   // validates types and allow entries
    const obj = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    return { config: obj, state: 'kept' };
  } catch (e) {
    return { config: defaultConfig(), state: 'replaced', warning: e.message };
  }
}
function anyDevice(list) { return !list.length || list.some((x) => String(x).trim() === '*:*'); }
// The allow list of this install (see "Allow list on a re-install" at the top):
//   --allow-any (or --allow '*:*')  → any device;
//   --allow host:port               → added to the existing list (restricts it; an "any" list starts empty);
//   --keep-allow, or a file with "allowMode" (v1.2.1+) → the list as it is;
//   otherwise (a file of an older installer) → any device; info.migrated = the replaced list.
// allowMode is then set from the result ("any" for an empty list, else "list"), next to "allow".
function applyOptions(cfg, o, info) {
  const src = JSON.parse(JSON.stringify(cfg)), c = {};
  if (!Object.prototype.hasOwnProperty.call(src, 'allow')) c.allow = [];
  Object.keys(src).forEach((k) => { if (k !== 'allowMode') c[k] = src[k]; if (k === 'allow') c.allowMode = null; });
  if (!Array.isArray(c.allow)) c.allow = [];
  const marked = src.allowMode === 'any' || src.allowMode === 'list';
  const explicit = (o.allow || []).map((a) => B.parseAllow(a).spec);
  if (o.allowAny || explicit.indexOf('*:*') >= 0) c.allow = [];
  else if (explicit.length) {
    if (anyDevice(c.allow)) c.allow = [];
    const seen = new Set(c.allow.map((x) => B.parseAllow(x).spec.toLowerCase()));
    explicit.forEach((spec) => { if (!seen.has(spec.toLowerCase())) { seen.add(spec.toLowerCase()); c.allow.push(spec); } });
  } else if (!o.keepAllow && !marked && !anyDevice(c.allow)) {
    if (info) info.migrated = c.allow.slice();
    c.allow = [];
  }
  if (anyDevice(c.allow)) c.allow = [];
  c.allowMode = c.allow.length ? 'list' : 'any';
  if (o.allowWrites !== undefined) c.allowWrites = !!o.allowWrites;
  if (o.port !== undefined) c.port = o.port;
  if (c.port === undefined) c.port = DEFAULT_PORT;
  return c;
}
function configText(c) { return JSON.stringify(c, null, 2) + '\n'; }
function healthHost(c) { const l = c && c.listen; return !l || l === '0.0.0.0' || l === 'localhost' ? '127.0.0.1' : l === '::' ? '::1' : l; }

// ─── Windows pieces ──────────────────────────────────────────────────────────
function regQuote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function dword(n) { return 'dword:' + ('00000000' + (Math.max(0, Math.round(n)) >>> 0).toString(16)).slice(-8); }
// The .reg file for `reg import` (UTF-16LE with BOM): Apps & features entry and the Run value.
function regFileText(o) {
  const run = '"' + o.exe + '" --run', lines = ['Windows Registry Editor Version 5.00', ''];
  if (o.autostart) lines.push('[' + RUN_KEY.replace(/^HKCU/, 'HKEY_CURRENT_USER') + ']', regQuote(RUN_VALUE) + '=' + regQuote(run), '');
  lines.push('[' + UNINSTALL_KEY.replace(/^HKCU/, 'HKEY_CURRENT_USER') + ']',
    '"DisplayName"=' + regQuote(APP_NAME),
    '"DisplayVersion"=' + regQuote(o.version),
    '"Publisher"=' + regQuote(PUBLISHER),
    '"DisplayIcon"=' + regQuote(o.exe + ',0'),
    '"InstallLocation"=' + regQuote(o.dir),
    '"UninstallString"=' + regQuote('"' + o.exe + '" --uninstall'),
    '"QuietUninstallString"=' + regQuote('"' + o.exe + '" --uninstall --quiet'),
    '"URLInfoAbout"=' + regQuote(HOMEPAGE),
    '"Comments"=' + regQuote('WebSocket to Modbus TCP bridge for the Well Testing Suite (http://127.0.0.1:' + o.port + '/)'),
    '"NoModify"=dword:00000001',
    '"NoRepair"=dword:00000001',
    '"EstimatedSize"=' + dword((o.sizeBytes || 0) / 1024), '');
  return lines.join('\r\n');
}
function regFileBytes(text) { return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]); }
// PowerShell (5.1) that writes both Start-menu shortcuts. Paths come in environment variables and the
// script goes in as -EncodedCommand (UTF-16LE base64), so nothing is quoted on a command line.
const SHORTCUT_PS = [
  "$ErrorActionPreference = 'Stop'",
  '$s = New-Object -ComObject WScript.Shell',
  "$l = $s.CreateShortcut($env:WTS_LNK_STATUS); $l.TargetPath = $env:WTS_EXE; $l.Arguments = '--open'; $l.WorkingDirectory = $env:WTS_DIR; $l.IconLocation = $env:WTS_EXE + ',0'; $l.Description = 'Start the WTS Modbus Bridge if needed and show its status page'; $l.Save()",
  "$l = $s.CreateShortcut($env:WTS_LNK_UNINSTALL); $l.TargetPath = $env:WTS_EXE; $l.Arguments = '--uninstall'; $l.WorkingDirectory = $env:WTS_DIR; $l.IconLocation = $env:WTS_EXE + ',0'; $l.Description = 'Remove the WTS Modbus Bridge'; $l.Save()",
].join('\r\n');
const MSGBOX_PS = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; " +
  "[void][System.Windows.Forms.MessageBox]::Show($f, $env:WTS_MSG, $env:WTS_TITLE, 'OK', $env:WTS_ICON)";
function psArgs(script) { return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]; }

// ─── the app ────────────────────────────────────────────────────────────────
function createApp(deps) {
  const P = paths(deps), win = deps.platform === 'win32', path = deps.path, fs = deps.fs;
  const steps = [];
  const note = (s) => { steps.push(s); log(s); };
  function log(s) { try { if (deps.log) deps.log(s); } catch (e) { /* ignore */ } }
  function exec(cmd, args, opts) { const r = deps.exec(cmd, args, opts || {}) || {}; log('exec ' + path.basename(cmd) + ' ' + args.join(' ').slice(0, 160) + ' → ' + r.status); return r; }
  function ui(o, fn) { if (!o.quiet) { try { fn(); } catch (e) { log('ui: ' + e.message); } } }

  async function health(c) { return deps.getHealth(c.port || DEFAULT_PORT, healthHost(c)); }
  async function waitHealth(c, ms, want) {
    const t0 = deps.now();
    for (;;) {
      const h = await health(c);
      if (want(h)) return h;
      if (deps.now() - t0 >= ms) return h;
      await deps.sleep(250);
    }
  }

  // Stops bridges started from this install (the pid file, then any process with our exe name),
  // never the current process. Returns true when something was asked to stop.
  function stopBridge() {
    if (!win) return false;
    let asked = false;
    let pid = null;
    try { pid = parseInt(String(fs.readFileSync(P.pid, 'utf8')).trim(), 10); } catch (e) { pid = null; }
    if (pid && pid !== deps.pid) {
      const t = exec(P.tasklist, ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
      if (t.status === 0 && String(t.stdout || '').toLowerCase().indexOf(EXE_NAME.toLowerCase()) >= 0) {
        exec(P.taskkill, ['/PID', String(pid), '/T', '/F']); asked = true;
      }
    }
    const k = exec(P.taskkill, ['/F', '/IM', EXE_NAME, '/FI', 'PID ne ' + deps.pid]);
    if (k.status === 0 && /SUCCESS/i.test(String(k.stdout || ''))) asked = true;
    try { fs.rmSync(P.pid, { force: true }); } catch (e) { /* ignore */ }
    return asked;
  }
  async function copySelf() {
    if (samePath(deps, deps.execPath, P.exe)) { note('Running from the install folder: ' + P.exe); return false; }
    let last = null;
    for (let i = 0; i < 40; i++) {                  // the old exe may still be closing (killed a moment ago)
      try {
        fs.copyFileSync(deps.execPath, P.exe);
        try { fs.rmSync(P.exe + ':Zone.Identifier', { force: true }); } catch (e) { /* not NTFS / no mark */ }
        note('Copied ' + deps.execPath + ' → ' + P.exe);
        return true;
      } catch (e) {
        last = e;
        if (!/EBUSY|EPERM|EACCES/.test(e.code || '')) break;
        await deps.sleep(250);
      }
    }
    throw new Error('cannot write ' + P.exe + ': ' + (last && last.message) + ' — close the running bridge (Task Manager: ' + EXE_NAME + ') and try again.');
  }
  function writeConfigFile(c) {
    const tmp = P.config + '.tmp', text = configText(c);
    let old = null;
    try { old = JSON.stringify(JSON.parse(String(fs.readFileSync(P.config, 'utf8')).replace(/^\uFEFF/, ''))); } catch (e) { old = null; }
    if (old === JSON.stringify(c)) return false;          // same settings: the file (and its layout) stays as it is
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, P.config);
    return true;
  }
  function register(c, autostart) {
    let size = 0;
    try { size = fs.statSync(P.exe).size; } catch (e) { size = 0; }
    const text = regFileText({ exe: P.exe, dir: P.dir, version: B.BRIDGE_VERSION, port: c.port || DEFAULT_PORT, sizeBytes: size, autostart });
    fs.writeFileSync(P.regFile, regFileBytes(text));
    const r = exec(P.reg, ['import', P.regFile]);
    try { fs.rmSync(P.regFile, { force: true }); } catch (e) { /* ignore */ }
    if (r.status !== 0) throw new Error('reg import failed: ' + String(r.stderr || r.stdout || r.status).trim());
    if (!autostart) exec(P.reg, ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    note(autostart ? 'Auto-start at login: ' + RUN_KEY + ' "' + RUN_VALUE + '"' : 'Auto-start at login: off');
    note('Apps & features entry: ' + UNINSTALL_KEY);
  }
  function shortcuts() {
    try { fs.mkdirSync(P.startMenu, { recursive: true }); } catch (e) { /* reported by PowerShell */ }
    const env = Object.assign({}, deps.env, { WTS_LNK_STATUS: P.statusLnk, WTS_LNK_UNINSTALL: P.uninstallLnk, WTS_EXE: P.exe, WTS_DIR: P.dir });
    const r = exec(P.powershell, psArgs(SHORTCUT_PS), { env });
    if (r.status === 0) note('Start-menu shortcuts: ' + P.startMenu);
    else note('WARNING: the Start-menu shortcuts were not created (' + String(r.stderr || r.status).trim().slice(0, 200) + ')');
    return r.status === 0;
  }
  function startBridge() {
    const pid = deps.spawnDetached(P.exe, ['--run'], { cwd: P.dir });
    note('Started ' + P.exe + ' --run' + (pid ? ' (pid ' + pid + ')' : ''));
    return pid;
  }
  function statusUrl(c) { const h = healthHost(c); return 'http://' + (h.indexOf(':') >= 0 ? '[' + h + ']' : h) + ':' + (c.port || DEFAULT_PORT) + '/'; }

  async function install(o) {
    if (!win) throw new Error('This installer is for Windows. On macOS / Linux use install.sh (see the Modbus page of the Well Testing Suite).');
    fs.mkdirSync(P.dir, { recursive: true });
    const loaded = loadConfig(deps, P.config);
    if (loaded.state === 'replaced') {
      try { fs.copyFileSync(P.config, P.config + '.bak'); } catch (e) { /* ignore */ }
      note('WARNING: ' + loaded.warning + ' — kept as bridge-config.json.bak, writing a new one');
    }
    const info = {}, cfg = applyOptions(loaded.config, o, info);
    if (info.migrated) note('Allow-list ' + info.migrated.join(', ') + ' replaced by any device (default since 1.2). Use --keep-allow to keep it.');
    const stopped = stopBridge();
    if (stopped) note('Stopped the running copy of the bridge');
    // anything that still answers on the port is not ours (install-windows.ps1 / started by hand)
    let before = await health(cfg);
    if (stopped && before.status === 'ours') before = await waitHealth(cfg, 5000, (h) => h.status !== 'ours');
    await copySelf();
    const changed = writeConfigFile(cfg);
    note((loaded.state === 'kept' ? (changed ? 'Updated ' : 'Kept ') : 'Wrote ') + P.config + ' (allow: ' + (cfg.allow.length ? cfg.allow.join(', ') : 'any device') + ', ' + (cfg.allowWrites ? 'writes allowed' : 'read-only') + ', port ' + cfg.port + ')');
    register(cfg, !o.noAutostart);
    shortcuts();
    const result = { ok: true, steps, config: cfg, url: statusUrl(cfg), dir: P.dir, exe: P.exe };
    if (before.status === 'ours' || before.status === 'other') {
      result.ok = false;
      result.error = before.status === 'ours'
        ? 'Another WTS Modbus bridge (started by install-windows.ps1 or by hand, v' + ((before.health || {}).version || '?') + ') already runs on port ' + cfg.port + '. The new bridge is installed and starts at the next login; stop the other one (or uninstall it) and run this installer again to start it now.'
        : 'Another program already uses port ' + cfg.port + ' on this PC, so the bridge cannot start. Close it, or install with --port <other> (and use that port in the device bridge URL).';
      note('WARNING: ' + result.error);
      ui(o, () => deps.messageBox(result.error + '\n\nLog: ' + P.log, APP_NAME, 'Warning'));
      return result;
    }
    startBridge();
    const h = await waitHealth(cfg, 15000, (x) => x.status === 'ours');
    result.health = h.health || null;
    if (h.status !== 'ours') {
      result.ok = false;
      result.error = 'The bridge was installed but did not answer on ' + statusUrl(cfg) + 'health within 15 s. See ' + P.log + '.';
      note('WARNING: ' + result.error);
      ui(o, () => deps.messageBox(result.error, APP_NAME, 'Warning'));
      return result;
    }
    note('Running: v' + h.health.version + ', ' + (h.health.readOnly ? 'read-only' : 'writes allowed') + ', allow ' + (h.health.allow || []).join(', '));
    ui(o, () => deps.openUrl(result.url));
    return result;
  }

  async function run(o) {
    const loaded = loadConfig(deps, P.config);
    if (loaded.state === 'new') { try { fs.mkdirSync(P.dir, { recursive: true }); writeConfigFile(defaultConfig()); } catch (e) { log('cannot write ' + P.config + ': ' + e.message); } }
    const cfg = loaded.state === 'kept' ? loaded.config : defaultConfig();
    if (loaded.state === 'replaced') log('WARNING: ' + loaded.warning + ' — running with the defaults');
    const h = await health(cfg);
    if (h.status === 'ours') { log('A WTS Modbus bridge already answers on port ' + cfg.port + ' — not starting a second one.'); return { ok: true, already: true, code: 0 }; }
    if (h.status === 'other') { log('ERROR: another program uses port ' + cfg.port + '.'); return { ok: false, code: 1 }; }
    const r = B.resolveOptions({ config: P.config }, () => ({ options: B.parseConfig(configText(cfg), P.config).options, warnings: [] }));
    const opts = Object.assign({}, r.options, { verbose: r.options.verbose || !!o.verbose, configFile: P.config, uninstallHint: win ? WIN_UNINSTALL_HINT : undefined });
    const srv = await deps.runBridge(opts);
    try { fs.writeFileSync(P.pid, String(deps.pid)); } catch (e) { /* ignore */ }
    log('WTS Modbus bridge v' + B.BRIDGE_VERSION + ' listening on ws://' + healthHost(cfg) + ':' + srv.port + '/modbus (' + (opts.allowWrites ? 'writes ALLOWED' : 'read-only') + '; allow: ' + ((opts.allow || []).join(', ') || 'any device') + ')');
    return { ok: true, code: null, server: srv };
  }

  async function uninstall(o) {
    if (!win) throw new Error('--uninstall is for the Windows installation; on macOS / Linux use install.sh --uninstall.');
    if (stopBridge()) note('Stopped the bridge');
    exec(P.reg, ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    exec(P.reg, ['delete', UNINSTALL_KEY, '/f']);
    note('Removed the auto-start entry and the Apps & features entry');
    try { fs.rmSync(P.startMenu, { recursive: true, force: true }); note('Removed the Start-menu shortcuts'); } catch (e) { note('WARNING: ' + e.message); }
    let later = false;
    if (fs.existsSync(P.dir)) {
      if (insideDir(deps, deps.execPath, P.dir)) {
        // a running exe cannot delete itself: remove the rest now, the folder after this process exits
        for (const f of fs.readdirSync(P.dir)) {
          const full = path.join(P.dir, f);
          if (samePath(deps, full, deps.execPath)) continue;
          try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { log('WARNING: ' + e.message); }
        }
        later = true;
        note('Removing ' + P.dir + ' (after this program exits)');
      } else {
        fs.rmSync(P.dir, { recursive: true, force: true });
        note('Removed ' + P.dir);
      }
    }
    // the confirmation first: the delayed delete must not run while this exe waits for "OK"
    ui(o, () => deps.messageBox('The WTS Modbus Bridge has been uninstalled.', APP_NAME, 'Information'));
    if (later) {
      const q = '"' + P.dir + '"';
      deps.spawnDetached(P.cmd, ['/d', '/c', 'ping -n 3 127.0.0.1 >nul & rmdir /s /q ' + q + ' & if exist ' + q + ' (ping -n 6 127.0.0.1 >nul & rmdir /s /q ' + q + ')'],
        { windowsVerbatimArguments: true, cwd: path.dirname(P.dir) });
    }
    return { ok: true, steps, later };
  }

  async function status() {
    const loaded = loadConfig(deps, P.config);
    const cfg = loaded.state === 'kept' ? loaded.config : defaultConfig();
    const h = await health(cfg);
    let autostart = null;
    if (win) { const r = exec(P.reg, ['query', RUN_KEY, '/v', RUN_VALUE]); autostart = r.status === 0; }
    return { installed: fs.existsSync(P.exe), dir: P.dir, config: loaded.state === 'new' ? null : P.config, autostart, running: h.status === 'ours',
      portInUseByOther: h.status === 'other', url: statusUrl(cfg), health: h.health || null, version: B.BRIDGE_VERSION };
  }

  async function open(o) {
    const loaded = loadConfig(deps, P.config), cfg = loaded.state === 'kept' ? loaded.config : defaultConfig();
    let h = await health(cfg);
    if (h.status === 'none' && fs.existsSync(P.exe)) { startBridge(); h = await waitHealth(cfg, 15000, (x) => x.status === 'ours'); }
    if (h.status === 'ours') { ui(o, () => deps.openUrl(statusUrl(cfg))); return { ok: true, url: statusUrl(cfg) }; }
    const msg = h.status === 'other' ? 'Another program uses port ' + cfg.port + ', so the WTS Modbus Bridge cannot run.' : 'The WTS Modbus Bridge is not running' + (fs.existsSync(P.exe) ? ' (see ' + P.log + ')' : ' and not installed — run ' + SETUP_NAME + '.');
    ui(o, () => deps.messageBox(msg, APP_NAME, 'Warning'));
    return { ok: false, error: msg };
  }

  // → exit code, or null to keep running (--run)
  async function main(argv) {
    let o;
    try { o = parseArgs(argv); } catch (e) { deps.out('ERROR: ' + e.message); ui({}, () => deps.messageBox(e.message + '\n\n' + usage(), APP_NAME, 'Error')); return 2; }
    try {
      if (o.cmd === 'version') { deps.out(B.BRIDGE_VERSION); return 0; }
      if (o.cmd === 'help') { deps.out(usage()); return 0; }
      if (o.cmd === 'status') { const s = await status(); deps.out(JSON.stringify(s, null, 2)); return s.running ? 0 : 3; }
      if (o.cmd === 'run') { const r = await run(o); return r.code; }
      if (o.cmd === 'open') { const r = await open(o); return r.ok ? 0 : 1; }
      if (o.cmd === 'uninstall') { const r = await uninstall(o); r.steps.forEach((s) => deps.out(s)); return 0; }
      const r = await install(o);
      r.steps.forEach((s) => deps.out(s));
      deps.out(r.ok ? 'OK: the WTS Modbus bridge is running — status page ' + r.url : 'WARNING: ' + r.error);
      return r.ok ? 0 : 1;
    } catch (e) {
      log('ERROR: ' + (e && e.stack || e));
      deps.out('ERROR: ' + (e && e.message || e));
      ui(o, () => deps.messageBox('The WTS Modbus Bridge could not be ' + (o.cmd === 'uninstall' ? 'uninstalled' : o.cmd === 'install' ? 'installed' : 'started') + ':\n\n' + (e && e.message || e) + '\n\nLog: ' + P.log, APP_NAME, 'Error'));
      return 1;
    }
  }
  return { main, install, run, uninstall, status, open, stopBridge, paths: P, parseArgs };
}

// ─── real system access ──────────────────────────────────────────────────────
function createLogger(fs, file, max) {
  return function (line) {
    try {
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { size = 0; }
      if (size > (max || LOG_MAX)) { try { fs.renameSync(file, file + '.1'); } catch (e) { /* ignore */ } }
      fs.appendFileSync(file, new Date().toISOString() + ' ' + String(line).replace(/\r?\n$/, '') + '\r\n');
    } catch (e) { /* no log folder yet */ }
  };
}
function getHealthHttp(port, host) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host, port, path: '/health', agent: false, timeout: 1500, headers: { Accept: 'application/json' } }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (d) => { if (b.length < 65536) b += d; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch (e) { j = null; }
        fin(res.statusCode === 200 && j && j.name === B.BRIDGE_NAME ? { status: 'ours', health: j } : { status: 'other', code: res.statusCode });
      });
      res.on('error', () => fin({ status: 'other' }));
    });
    req.on('timeout', () => { req.destroy(); fin({ status: 'other', timeout: true }); });
    req.on('error', (e) => fin(e && e.code === 'ECONNREFUSED' ? { status: 'none' } : { status: e && e.code === 'ECONNRESET' ? 'other' : 'none', error: e && e.code }));
  });
}
function realDeps() {
  const platform = process.platform, env = process.env;
  const deps = {
    platform, env, fs: nodeFs, path: platform === 'win32' ? nodePath.win32 : nodePath, execPath: process.execPath, pid: process.pid,
    now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (s) => { try { process.stdout.write(String(s) + '\n'); } catch (e) { /* no console (GUI exe) */ } },
    exec(cmd, args, o) {
      const r = cp.spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env: (o && o.env) || env });
      return { status: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: r.error ? r.error.message : (r.stderr || '') };
    },
    spawnDetached(cmd, args, o) {
      const c = cp.spawn(cmd, args, Object.assign({ detached: true, stdio: 'ignore', windowsHide: true, env }, o || {}));
      c.on('error', (e) => deps.log('spawn ' + cmd + ': ' + e.message));
      c.unref();
      return c.pid;
    },
    getHealth: getHealthHttp,
    openUrl(url) {
      if (platform === 'win32') deps.spawnDetached(paths(deps).rundll32, ['url.dll,FileProtocolHandler', url], {});
      else deps.spawnDetached(platform === 'darwin' ? 'open' : 'xdg-open', [url], {});
    },
    messageBox(text, title, icon) {
      if (platform !== 'win32') { deps.out(title + ': ' + text); return; }
      cp.spawnSync(paths(deps).powershell, psArgs(MSGBOX_PS),
        { windowsHide: true, env: Object.assign({}, env, { WTS_MSG: String(text), WTS_TITLE: String(title || APP_NAME), WTS_ICON: icon || 'Information' }) });
    },
    runBridge(opts) {
      const b = B.createBridge(opts);
      return b.listen().then((port) => {
        const stop = () => { b.close().then(() => { try { nodeFs.rmSync(paths(deps).pid, { force: true }); } catch (e) { /* ignore */ } process.exit(0); }); };
        process.on('SIGINT', stop); process.on('SIGTERM', stop);
        return { port, bridge: b };
      });
    },
  };
  deps.log = createLogger(nodeFs, paths(deps).log);           // silently nothing until the folder exists
  return deps;
}
function main(argv) {
  const deps = realDeps();
  const o = (() => { try { return parseArgs(argv); } catch (e) { return {}; } })();
  if (o.cmd === 'run') {                      // no console in the exe: the bridge's own messages go to the log
    ['log', 'info', 'warn', 'error'].forEach((k) => { console[k] = (...a) => deps.log(a.map(String).join(' ')); });
    process.on('uncaughtException', (e) => { deps.log('uncaught: ' + (e && e.stack || e)); process.exit(1); });
  }
  createApp(deps).main(argv).then((code) => {
    // exit on its own (stdout flushed); the unref'd timer only ends a process something else keeps alive
    if (code !== null && code !== undefined) { process.exitCode = code; const t = setTimeout(() => process.exit(code), 3000); if (t.unref) t.unref(); }
  }, (e) => { deps.log('fatal: ' + (e && e.stack || e)); process.exit(1); });
}

module.exports = { APP_NAME, EXE_NAME, SETUP_NAME, RUN_KEY, RUN_VALUE, UNINSTALL_KEY, STATUS_LNK, UNINSTALL_LNK, DEFAULT_PORT, WIN_UNINSTALL_HINT,
  parseArgs, paths, defaultConfig, loadConfig, applyOptions, anyDevice, configText, regFileText, regFileBytes, createApp, createLogger, getHealthHttp, usage, main, bridge: B };
if (require.main === module) main(process.argv.slice(2));
