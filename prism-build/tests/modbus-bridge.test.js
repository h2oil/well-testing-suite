// tools/modbus-bridge — WebSocket ↔ Modbus TCP bridge, end to end in Node.
//
// A fake Modbus TCP slave (tools/modbus-bridge/fake-slave.js) and the bridge both listen
// on random localhost ports; clients are Node's own WebSocket (undici, an independent
// RFC 6455 implementation) and the app's WTS_modbus webSocket transport + client.
// Expected register contents come from fake-slave.js's documented initial map
// (holding[i] = i, input[i] = 1000 + i, input 100-101 = 0x42F6 0xE979 = 123.456f).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const WP = 'MODBUS';
const TOOLS = path.resolve(__dirname, '..', '..', 'tools', 'modbus-bridge');
const { createBridge, parseAllow, allowed, decodeFrames, encodeFrame } = require(path.join(TOOLS, 'modbus-bridge.js'));
const { createSlave } = require(path.join(TOOLS, 'fake-slave.js'));

function loadCore() {
  const ctx = { console: { log() {}, warn() {} }, Math, Date, JSON, setTimeout, clearTimeout, Promise, Uint8Array, Uint16Array, Float64Array,
    DataView, ArrayBuffer, Buffer, WebSocket: globalThis.WebSocket, encodeURIComponent };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ['50-modbus-core.js', '51-modbus-station.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
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
];
