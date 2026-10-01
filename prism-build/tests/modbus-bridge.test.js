// tools/modbus-bridge — WebSocket ↔ Modbus TCP bridge, end to end in Node.
//
// A fake Modbus TCP slave (tools/modbus-bridge/fake-slave.js) and the bridge both listen
// on random localhost ports; clients are Node's own WebSocket (undici, an independent
// RFC 6455 implementation) and the app's WTS_modbus webSocket transport + client.
// Expected register contents come from fake-slave.js's documented initial map
// (holding[i] = i, input[i] = 1000 + i, input 100-101 = 0x42F6 0xE979 = 123.456f).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const WP = 'MODBUS';
const TOOLS = path.resolve(__dirname, '..', '..', 'tools', 'modbus-bridge');
const BRIDGE_JS = path.join(TOOLS, 'modbus-bridge.js');
const { createBridge, parseAllow, allowed, decodeFrames, encodeFrame, BRIDGE_VERSION, parseArgs, parseConfig, loadConfigFile, resolveOptions, hostHeaderOk,
  originOk, healthRefusal, normListen } = require(BRIDGE_JS);
const { createSlave } = require(path.join(TOOLS, 'fake-slave.js'));

// Plain HTTP request to the bridge → {status, headers, body}. headers may override Host / Origin.
function httpReq(port, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false, host: '127.0.0.1', port, path: o.path || '/health', method: o.method || 'GET', headers: o.headers || {} }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

// Raw WebSocket upgrade → HTTP status (101 = accepted). origin undefined = no Origin header.
function wsUpgrade(port, sport, origin, host) {
  return new Promise((resolve) => {
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
    if (origin !== undefined) headers.Origin = origin;
    if (host !== undefined) headers.Host = host;
    const req = http.request({ agent: false, host: '127.0.0.1', port, path: '/modbus?host=127.0.0.1&port=' + sport, headers });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); }); req.on('upgrade', (res, sock) => { sock.destroy(); resolve(101); }); req.on('error', () => resolve(-1)); req.end();
  });
}

function loadCore() {
  const ctx = { console: { log() {}, warn() {} }, Math, Date, JSON, setTimeout, clearTimeout, Promise, Uint8Array, Uint16Array, Float64Array,
    DataView, ArrayBuffer, Buffer, WebSocket: globalThis.WebSocket, encodeURIComponent };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ['60-modbus-core.js', '61-modbus-station.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  return ctx.WTS_modbus;
}
const plain = (x) => JSON.parse(JSON.stringify(Array.from(x)));
async function rig(bridgeOpts) {
  const slave = createSlave({ port: 0 });
  const sport = await slave.listen();
  const bridge = createBridge(Object.assign({ port: 0, allow: ['127.0.0.1:' + sport] }, bridgeOpts || {}));
  const bport = await bridge.listen();
  return { slave, sport, bridge, bport, url: 'ws://127.0.0.1:' + bport, async close() { await bridge.close(); await slave.close(); } };
}
function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
    const msgs = [];
    ws.onmessage = (e) => msgs.push(e.data);
    ws.onopen = () => resolve({ ws, msgs });
    ws.onerror = () => reject(new Error('ws error'));
  });
}
const wait = (cond, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function tick() { if (cond()) return resolve(); if (Date.now() - t0 > (ms || 2000)) return reject(new Error('timeout waiting')); setTimeout(tick, 5); })();
});

module.exports = [
  {
    name: 'bridge helpers: allow-list (host, CIDR, wildcard port) and RFC 6455 frame codec',
    wp: WP, opts: false,
    run(app, assert) {
      const L = ['192.168.1.10:502', '10.0.0.0/24:5020', 'plc.local:*'].map(parseAllow);
      assert.ok(allowed(L, '192.168.1.10', 502)); assert.ok(!allowed(L, '192.168.1.10', 503));
      assert.ok(allowed(L, '10.0.0.77', 5020)); assert.ok(!allowed(L, '10.0.1.77', 5020));
      assert.ok(allowed(L, 'PLC.local', 1234)); assert.ok(!allowed(L, 'evil.example', 502));
      assert.throws(() => parseAllow('nohost'));
      // client → server frames must be masked (RFC 6455 §5.3); hand-masked "Hi" with key 01 02 03 04
      const masked = Buffer.from([0x82, 0x82, 1, 2, 3, 4, 'H'.charCodeAt(0) ^ 1, 'i'.charCodeAt(0) ^ 2]);
      const d = decodeFrames(masked, 260);
      assert.strictEqual(d.frames.length, 1); assert.strictEqual(d.frames[0].payload.toString(), 'Hi'); assert.strictEqual(d.frames[0].opcode, 2);
      assert.deepStrictEqual(decodeFrames(Buffer.from([0x82, 0x02, 0x48, 0x69]), 260).error, [1002, 'client frames must be masked']);
      assert.deepStrictEqual(Array.from(encodeFrame(2, Buffer.from([7]))), [0x82, 0x01, 7], 'server frames unmasked');
      assert.strictEqual(decodeFrames(Buffer.from([0x82, 0xFE, 0x01, 0x05]), 260).error[0], 1009, 'payload over the ADU limit → 1009');
    },
  },
  {
    name: 'bridge end to end: WTS_modbus client over WebSocket reads registers, floats and coils from a TCP slave',
    wp: WP, opts: false, timeoutMs: 20000,
    async run(app, assert) {
      const M = loadCore(), R = await rig();
      try {
        const tr = M.transports.webSocket({ url: R.url, host: '127.0.0.1', port: R.sport });
        await tr.open();
        const c = M.createClient(tr, { timeout: 2000, retries: 0 });
        assert.deepStrictEqual(plain(await c.readHoldingRegisters(1, 10, 3)), [10, 11, 12]);
        assert.deepStrictEqual(plain(await c.readInputRegisters(1, 5, 2)), [1005, 1006]);
        const w = await c.readInputRegisters(1, 100, 2);
        assert.ok(Math.abs(M.decodeValue(plain(w), 'float32', 'ABCD') - 123.456) < 1e-4, 'float32 ABCD');
        assert.deepStrictEqual(plain(await c.readCoils(1, 0, 4)).map(Number), [0, 1, 0, 1]);
        // concurrent requests are serialised and matched by transaction id
        const all = await Promise.all([c.readHoldingRegisters(1, 1, 1), c.readHoldingRegisters(1, 2, 1), c.readHoldingRegisters(1, 3, 1)]);
        assert.deepStrictEqual(all.map((x) => x[0]), [1, 2, 3]);
        // exceptions from the device pass through (address beyond 10,000)
        let e = null; try { await c.readHoldingRegisters(1, 9999, 2); } catch (x) { e = x; }
        assert.ok(e && e.kind === 'exception' && e.exception === 2);
        // read-only bridge: a write gets exception 01 from the bridge and never reaches the slave
        e = null; try { await c.writeRegister(1, 0, 42); } catch (x) { e = x; }
        assert.ok(e && e.kind === 'exception' && e.exception === 1, 'write refused by the bridge');
        assert.strictEqual(R.slave.stats.writes, 0); assert.strictEqual(R.slave.mem.holding[0], 0);
        assert.strictEqual(R.bridge.stats.writesBlocked, 1);
        await c.close();
        // a whole station over the bridge: config → poll → value with quality
        const st = M.createStation({ devices: [{ id: 'd', name: 'Bridge PLC', transport: 'ws', url: R.url, host: '127.0.0.1', port: R.sport, timeoutMs: 2000 }],
          tags: [{ id: 't', name: 'F', device: 'd', table: 'input', address: 100, type: 'float32' }, { id: 'u', name: 'H', device: 'd', table: 'holding', address: 7, type: 'uint16' }] });
        await st.pollNow();
        assert.strictEqual(st.value('t').q, 'good'); assert.ok(Math.abs(st.value('t').value - 123.456) < 1e-4); assert.strictEqual(st.value('u').value, 7);
        st.dispose();
      } finally { await R.close(); }
    },
  },
  {
    name: 'bridge security: target allow-list, origin check, writes only with --allow-writes',
    wp: WP, opts: false, timeoutMs: 20000,
    async run(app, assert) {
      const M = loadCore(), R = await rig();
      try {
        // target not allowed → error message + close; the transport open() rejects with it
        const tr = M.transports.webSocket({ url: R.url, host: '127.0.0.1', port: R.sport + 1 });
        let e = null; try { await tr.open(); } catch (x) { e = x; }
        assert.ok(e && /allow-list/.test(e.message), 'refused: ' + (e && e.message));
        // raw client sees {"type":"error"} then a close frame
        const { ws, msgs } = await wsOpen(R.url + '/modbus?host=10.9.9.9&port=502');
        await wait(() => msgs.length >= 1);
        assert.strictEqual(JSON.parse(msgs[0]).type, 'error');
        ws.close();
        // foreign browser origin → HTTP 403 at the upgrade
        const status = await new Promise((resolve) => {
          const req = http.request({ agent: false, host: '127.0.0.1', port: R.bport, path: '/modbus?host=127.0.0.1&port=' + R.sport, headers: {
            Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'https://evil.example' } });
          req.on('response', (res) => resolve(res.statusCode)); req.on('upgrade', () => resolve(101)); req.on('error', () => resolve(-1)); req.end();
        });
        assert.strictEqual(status, 403);
        // RFC 6455 §1.3 handshake example: key dGhlIHNhbXBsZSBub25jZQ== → accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
        const accept = await new Promise((resolve) => {
          const req = http.request({ agent: false, host: '127.0.0.1', port: R.bport, path: '/modbus?host=127.0.0.1&port=' + R.sport, headers: {
            Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'http://localhost:8080' } });
          req.on('upgrade', (res, sock) => { resolve(res.headers['sec-websocket-accept']); sock.destroy(); }); req.on('response', () => resolve(null)); req.end();
        });
        assert.strictEqual(accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
      } finally { await R.close(); }
      // writes allowed only when the bridge is started with allowWrites
      const R2 = await rig({ allowWrites: true });
      try {
        const tr = M.transports.webSocket({ url: R2.url, host: '127.0.0.1', port: R2.sport });
        await tr.open();
        const c = M.createClient(tr, { timeout: 2000 });
        await c.writeRegisters(1, 20, M.encodeValue(-1.5, 'float32', 'CDAB'));
        assert.deepStrictEqual([R2.slave.mem.holding[20], R2.slave.mem.holding[21]], [0x0000, 0xBFC0], '-1.5f word-swapped');
        await c.writeCoil(1, 2, true); assert.strictEqual(R2.slave.mem.coil[2], 1);
        assert.strictEqual(R2.slave.stats.writes, 2);
        await c.close();
      } finally { await R2.close(); }
    },
  },
  {
    name: 'bridge --config / --version: JSON parsing, validation, command-line precedence',
    wp: WP, opts: false, timeoutMs: 20000,
    run(app, assert) {
      assert.match(BRIDGE_VERSION, /^\d+\.\d+\.\d+$/);
      // BOM, "_" comment keys and unknown keys (warning) are tolerated
      const r = parseConfig('﻿{"_comment":"x","allow":[" 192.168.1.10:502 ","10.0.0.0/24:*"],"port":9000,"listen":"127.0.0.1","origins":["https://a.example"],"allowWrites":false,"future":1}', 'cfg.json');
      assert.deepStrictEqual(r.options.allow, ['192.168.1.10:502', '10.0.0.0/24:*']);
      assert.strictEqual(r.options.port, 9000); assert.strictEqual(r.options.allowWrites, false);
      assert.strictEqual(r.warnings.length, 1); assert.match(r.warnings[0], /unknown key "future"/);
      const bad = (text, re) => { let e = null; try { parseConfig(text, 'c.json'); } catch (x) { e = x; } assert.ok(e && re.test(e.message), text + ' → ' + (e && e.message)); };
      bad('{', /not valid JSON/); bad('[1]', /JSON object/); bad('{"port":"8502"}', /"port" must be/); bad('{"port":70000}', /"port" must be/);
      bad('{"allow":"1.2.3.4:502"}', /list of strings/); bad('{"allow":["1.2.3.4"]}', /host:port/); bad('{"allow":["10.0.0.0/40:502"]}', /subnet/);
      bad('{"allowWrites":"yes"}', /must be a boolean/); bad('{"allow":["1.2.3.4:99999"]}', /bad port/);
      bad('{"allow":["$(calc):502"]}', /bad host/); bad('{"allow":["a b:502"]}', /bad host/);
      assert.strictEqual(parseAllow('[::1]:502').spec, '[::1]:502'); assert.strictEqual(parseAllow('PLC_1.local:*').spec, 'plc_1.local:*');
      // precedence: CLI port / listen win, allow / origins merge (deduplicated), flags only switch on
      const file = { options: { allow: ['192.168.1.10:502', '10.0.0.5:502'], port: 9000, listen: '127.0.0.1', origins: ['https://a.example'], allowWrites: false, verbose: true } };
      const m = resolveOptions(parseArgs(['--config', 'x.json', '--allow', '10.0.0.5:502', '--allow', 'plc.local:*', '--port', '9100', '--allow-writes', '--origin', 'https://b.example']), () => ({ options: file.options, warnings: ['w'] }));
      assert.deepStrictEqual(m.options.allow, ['192.168.1.10:502', '10.0.0.5:502', 'plc.local:*']);
      assert.strictEqual(m.options.port, 9100); assert.strictEqual(m.options.listen, '127.0.0.1');
      assert.strictEqual(m.options.allowWrites, true); assert.strictEqual(m.options.verbose, true);
      assert.deepStrictEqual(m.options.origins, ['https://a.example', 'https://b.example']); assert.deepStrictEqual(m.warnings, ['w']);
      const k = resolveOptions(parseArgs(['--config', 'x.json']), () => file);
      assert.strictEqual(k.options.port, 9000, 'config port kept without --port'); assert.ok(!k.options.allowWrites);
      const n = resolveOptions(parseArgs(['--allow', '1.2.3.4:502']));
      assert.deepStrictEqual(n.options, { allow: ['1.2.3.4:502'], origins: [] }, 'no config: nothing undefined leaks into createBridge');
      assert.throws(() => resolveOptions(parseArgs(['--port', 'abc'])), /bad --port/);
      assert.throws(() => resolveOptions(parseArgs(['--allow', 'nohost'])), /host:port/);
      assert.throws(() => parseArgs(['--config']), /needs a value/);
      // a real file in a folder with spaces
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts bridge cfg ')), f = path.join(dir, 'bridge config.json');
      try {
        fs.writeFileSync(f, JSON.stringify({ allow: ['127.0.0.1:5020'], port: 8600 }));
        assert.deepStrictEqual(loadConfigFile(f).options, { allow: ['127.0.0.1:5020'], port: 8600 });
        assert.throws(() => loadConfigFile(path.join(dir, 'missing.json')), /cannot read config file/);
        // CLI: --version, and a bad config → exit 2 with the reason
        const v = spawnSync(process.execPath, [BRIDGE_JS, '--version'], { encoding: 'utf8' });
        assert.strictEqual(v.status, 0); assert.strictEqual(v.stdout.trim(), BRIDGE_VERSION);
        fs.writeFileSync(f, '{"allow":["1.2.3.4;rm -rf ~:502"]}');
        const b = spawnSync(process.execPath, [BRIDGE_JS, '--config', f], { encoding: 'utf8', timeout: 10000 });
        assert.strictEqual(b.status, 2); assert.match(b.stderr, /bad host in allow entry 1\.2\.3\.4;rm -rf ~:502/);
        const h = spawnSync(process.execPath, [BRIDGE_JS, '--help'], { encoding: 'utf8' });
        assert.match(h.stdout, /--config/); assert.match(h.stdout, /GET \/health/);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'bridge GET /health: JSON, CORS only for accepted origins, Private Network preflight, DNS-rebinding guard',
    wp: WP, opts: false, timeoutMs: 20000,
    async run(app, assert) {
      const R = await rig({ origins: ['https://my.site'] });
      try {
        const P = R.bport;
        let r = await httpReq(P);                                        // curl / installers: no Origin
        assert.strictEqual(r.status, 200); assert.match(r.headers['content-type'], /application\/json/);
        const h = JSON.parse(r.body);
        assert.deepStrictEqual(Object.keys(h).sort(), ['allow', 'name', 'port', 'readOnly', 'uptimeS', 'version']);
        assert.strictEqual(h.name, 'wts-modbus-bridge'); assert.strictEqual(h.version, BRIDGE_VERSION);
        assert.strictEqual(h.readOnly, true); assert.strictEqual(h.port, P); assert.ok(h.uptimeS >= 0);
        assert.deepStrictEqual(h.allow, ['127.0.0.1:' + R.sport]);
        assert.strictEqual(r.headers['access-control-allow-origin'], undefined, 'no CORS without an Origin');
        assert.strictEqual(r.headers['cache-control'], 'no-store');
        for (const o of ['http://localhost:8080', 'http://127.0.0.1:8080', 'https://my.site', 'capacitor://localhost', 'http://[::1]:5173']) {
          r = await httpReq(P, { headers: { Origin: o } });
          assert.strictEqual(r.status, 200, o); assert.strictEqual(r.headers['access-control-allow-origin'], o); assert.match(r.headers.vary, /Origin/);
        }
        // a foreign origin learns nothing but "refused (origin)" — readable (ACAO echoed), so the app's
        // "Check bridge" can say why instead of "no bridge answered" (a browser hides a 403 without ACAO)
        r = await httpReq(P, { headers: { Origin: 'https://evil.example' } });
        assert.strictEqual(r.status, 403); assert.deepStrictEqual(JSON.parse(r.body), { error: 'origin' });
        assert.strictEqual(r.headers['access-control-allow-origin'], 'https://evil.example'); assert.match(r.headers.vary, /Origin/);
        assert.strictEqual(r.headers['access-control-allow-private-network'], undefined);
        // "Origin: null" (sandboxed iframe / data: URL of ANY site, or a saved file:// copy) and file:// are refused by default:
        // no allow-list (internal PLC addresses), no version, no Private-Network approval
        for (const o of ['null', 'file://', 'NULL']) {
          r = await httpReq(P, { headers: { Origin: o } });
          assert.strictEqual(r.status, 403, o); assert.deepStrictEqual(JSON.parse(r.body), { error: 'origin' }, o);
          assert.ok(!/allow|version|127\.0\.0\.1/.test(r.body), o + ': nothing leaks');
        }
        r = await httpReq(P, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
        assert.strictEqual(r.status, 403, 'null preflight refused'); assert.strictEqual(r.headers['access-control-allow-private-network'], undefined, 'no PNA approval for null');
        // CORS preflight with Chrome's Private Network Access request header
        r = await httpReq(P, { method: 'OPTIONS', headers: { Origin: 'https://my.site', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
        assert.strictEqual(r.status, 204); assert.strictEqual(r.headers['access-control-allow-origin'], 'https://my.site');
        assert.strictEqual(r.headers['access-control-allow-private-network'], 'true'); assert.match(r.headers['access-control-allow-methods'], /GET/);
        r = await httpReq(P, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Private-Network': 'true' } });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.headers['access-control-allow-private-network'], undefined);
        // DNS rebinding: a page on evil.example rebound to 127.0.0.1 sends Host: evil.example (and no Origin on a same-origin GET)
        r = await httpReq(P, { headers: { Host: 'evil.example:' + P } });
        assert.strictEqual(r.status, 403); assert.deepStrictEqual(JSON.parse(r.body), { error: 'host' });
        r = await httpReq(P, { headers: { Host: 'evil.example:' + P, Origin: 'http://evil.example:' + P } });
        assert.strictEqual(r.status, 403, 'rebound page with its own origin'); assert.deepStrictEqual(JSON.parse(r.body), { error: 'origin' });
        // a host-name bridge URL (ws://bridge-pc.local:8502) from an accepted page works — as the WebSocket does
        r = await httpReq(P, { headers: { Host: 'bridge-pc.local:' + P, Origin: 'http://localhost:8080' } });
        assert.strictEqual(r.status, 200, 'accepted Origin + host name'); assert.strictEqual(r.headers['access-control-allow-origin'], 'http://localhost:8080');
        assert.strictEqual(JSON.parse(r.body).name, 'wts-modbus-bridge');
        assert.strictEqual(healthRefusal({}, undefined, 'bridge-pc:1'), 'host'); assert.strictEqual(healthRefusal({ origins: ['null'] }, 'null', 'bridge-pc:1'), 'host', 'null never bypasses the Host rule');
        assert.strictEqual(healthRefusal({}, 'http://localhost:8080', 'bridge-pc:1'), null); assert.strictEqual(healthRefusal({}, 'https://my.site', '127.0.0.1:1'), 'origin', 'a web host is accepted only with --origin'); assert.strictEqual(healthRefusal({}, 'null', '127.0.0.1:1'), 'origin');
        for (const host of ['localhost:' + P, '127.0.0.1:' + P, '[::1]:' + P, 'app.localhost:' + P]) assert.strictEqual((await httpReq(P, { headers: { Host: host } })).status, 200, host);
        assert.ok(hostHeaderOk({ listen: 'bridge-pc' }, 'BRIDGE-PC:8502') && !hostHeaderOk({}, 'bridge-pc:8502') && !hostHeaderOk({}, '[evil]:1'));
        assert.strictEqual((await httpReq(P, { method: 'POST', headers: { Origin: 'http://localhost:8080' } })).status, 405);
        r = await httpReq(P, { path: '/modbus' });                  // a plain GET (no upgrade): the short text
        assert.strictEqual(r.status, 200); assert.match(r.body, new RegExp('v' + BRIDGE_VERSION.replace(/\./g, '\\.') + ' \\(read-only\\)'));
        r = await httpReq(P, { path: '/' });                        // the status page for people (modbus-bridge-exe.test.js)
        assert.strictEqual(r.status, 200); assert.match(r.body, new RegExp('WTS Modbus Bridge v' + BRIDGE_VERSION.replace(/\./g, '\\.') + ' is running on this PC'));
        assert.match(r.body, /Refused — read-only/);
        assert.strictEqual(R.bridge.health().version, BRIDGE_VERSION);
      } finally { await R.close(); }
      const R2 = await rig({ allowWrites: true, allow: ['10.0.0.0/24:502', 'PLC.local:*'] });
      try {
        const h2 = JSON.parse((await httpReq(R2.bport)).body);
        assert.strictEqual(h2.readOnly, false); assert.deepStrictEqual(h2.allow, ['10.0.0.0/24:502', 'plc.local:*']);
      } finally { await R2.close(); }
    },
  },
  {
    name: 'bridge origins: "null" / file:// refused by default on /health and the WebSocket, opt-in with --origin null; no Origin header = not a browser (accepted)',
    wp: WP, opts: false, timeoutMs: 20000,
    async run(app, assert) {
      assert.strictEqual(originOk({}, undefined), true, 'no Origin header (curl, scripts, Node WebSocket)');
      for (const o of ['null', 'file://', 'file:///C:/wts.html', 'https://evil.example', 'http://localhost.evil.example']) assert.strictEqual(originOk({}, o), false, o);
      assert.ok(originOk({ origins: ['null'] }, 'null') && originOk({ origins: ['file://'] }, 'file://') && originOk({ anyOrigin: true }, 'null'));
      const R = await rig();
      try {
        assert.strictEqual(await wsUpgrade(R.bport, R.sport, 'null'), 403, 'WebSocket with Origin: null refused (any web site can send it)');
        assert.strictEqual(await wsUpgrade(R.bport, R.sport, 'file://'), 403);
        assert.strictEqual(await wsUpgrade(R.bport, R.sport, undefined), 101, 'no Origin header → accepted (non-browser client)');
        assert.strictEqual(await wsUpgrade(R.bport, R.sport, 'http://127.0.0.1:8080'), 101);
      } finally { await R.close(); }
      const R2 = await rig({ origins: ['null'] });                    // a saved copy, explicitly allowed
      try {
        assert.strictEqual(await wsUpgrade(R2.bport, R2.sport, 'null'), 101);
        const r = await httpReq(R2.bport, { headers: { Origin: 'null' } });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['access-control-allow-origin'], 'null');
      } finally { await R2.close(); }
      // CLI: --origin null works and warns
      const c = spawn(process.execPath, [BRIDGE_JS, '--port', '0', '--origin', 'null', '--allow', '127.0.0.1:5020'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      try {
        await wait(() => /listening on/.test(out) && /Origin: null/.test(err), 10000);   // stdout / stderr arrive independently
        assert.match(err, /Origin: null.*accepted/);
      } finally { c.kill('SIGTERM'); }
    },
  },
  {
    name: 'bridge --listen localhost binds 127.0.0.1 (localhost may resolve to ::1 only on macOS / Windows)',
    wp: WP, opts: false, timeoutMs: 20000,
    async run(app, assert) {
      assert.strictEqual(normListen('localhost'), '127.0.0.1'); assert.strictEqual(normListen('LOCALHOST'), '127.0.0.1'); assert.strictEqual(normListen('10.0.0.5'), '10.0.0.5');
      assert.strictEqual(resolveOptions(parseArgs(['--listen', 'localhost'])).options.listen, '127.0.0.1');
      assert.strictEqual(resolveOptions(parseArgs(['--config', 'x.json']), () => ({ options: { listen: 'localhost' } })).options.listen, '127.0.0.1');
      // make dns.lookup('localhost') answer ::1 first, as on macOS: the bridge must not ask it
      const dns = require('dns'), orig = dns.lookup;
      dns.lookup = function (host, o, cb) { if (String(host).toLowerCase() === 'localhost') { const f = typeof o === 'function' ? o : cb; return process.nextTick(() => f(null, '::1', 6)); } return orig.apply(this, arguments); };
      const b = createBridge({ port: 0, listen: 'localhost', allow: [] });
      try {
        await b.listen();
        assert.strictEqual(b.server.address().address, '127.0.0.1');
        assert.strictEqual((await httpReq(b.server.address().port)).status, 200, 'reachable on 127.0.0.1');
      } finally { dns.lookup = orig; await b.close(); }
    },
  },
  {
    name: 'bridge CLI with --config (path with spaces): merges --allow, answers /health, stops on SIGTERM',
    wp: WP, opts: false, timeoutMs: 30000,
    async run(app, assert) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts bridge cli ')), f = path.join(dir, 'bridge-config.json');
      fs.writeFileSync(f, JSON.stringify({ allow: ['192.168.1.10:502'], port: 0, allowWrites: false, _comment: 'test' }, null, 2));
      const child = spawn(process.execPath, [BRIDGE_JS, '--config', f, '--allow', '127.0.0.1:5020'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
      try {
        await wait(() => /health check: http:\/\/127\.0\.0\.1:\d+\/health/.test(out), 10000);   // the last of the three start-up lines (chunks may split)
        const port = +/listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(out)[1];
        assert.match(out, new RegExp('v' + BRIDGE_VERSION.replace(/\./g, '\\.')));
        assert.match(out, /health check: http:\/\/127\.0\.0\.1:\d+\/health/);
        const h = JSON.parse((await httpReq(port)).body);
        assert.deepStrictEqual(h.allow, ['192.168.1.10:502', '127.0.0.1:5020']);
        const code = await new Promise((resolve) => { child.on('exit', (c) => resolve(c)); child.kill('SIGTERM'); });
        assert.strictEqual(code, 0, 'graceful exit on SIGTERM (launchd / systemd stop); stderr: ' + err);
      } finally { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
];
