#!/usr/bin/env node
// =============================================================================
// fake-slave.js — a tiny Modbus TCP slave for testing the bridge without hardware.
// Zero dependencies. Serves FC 01-06, 15, 16 on unit id 1 (any unit id with --any-unit),
// with 10,000 coils / discrete inputs / holding / input registers.
//
// Initial contents (so a read is easy to recognise):
//   holding[i] = i, input[i] = 1000 + i, coil[i] = i % 2, discrete[i] = (i + 1) % 2,
//   input 100-101 = FLOAT32 ABCD 123.456 (0x42F6 0xE979).
//
// Usage: node fake-slave.js [--port 5020] [--listen 127.0.0.1] [--any-unit]
// =============================================================================
'use strict';
const net = require('net');

function createSlave(opts) {
  opts = Object.assign({ port: 5020, listen: '127.0.0.1', unit: 1, anyUnit: false }, opts || {});
  const N = 10000;
  const mem = { coil: new Uint8Array(N), discrete: new Uint8Array(N), holding: new Uint16Array(N), input: new Uint16Array(N) };
  for (let i = 0; i < N; i++) { mem.holding[i] = i; mem.input[i] = 1000 + i; mem.coil[i] = i % 2; mem.discrete[i] = (i + 1) % 2; }
  mem.input[100] = 0x42F6; mem.input[101] = 0xE979;
  const stats = { requests: 0, writes: 0 };
  function exc(fc, code) { return Buffer.from([fc | 0x80, code]); }
  function pdu(p) {
    const fc = p[0], addr = p.readUInt16BE(1), qty = p.readUInt16BE(3);
    stats.requests++;
    if (fc === 1 || fc === 2) {
      if (qty < 1 || qty > 2000) return exc(fc, 3);
      if (addr + qty > N) return exc(fc, 2);
      const m = fc === 1 ? mem.coil : mem.discrete, nb = Math.ceil(qty / 8), out = Buffer.alloc(2 + nb);
      out[0] = fc; out[1] = nb;
      for (let i = 0; i < qty; i++) if (m[addr + i]) out[2 + (i >> 3)] |= 1 << (i & 7);
      return out;
    }
    if (fc === 3 || fc === 4) {
      if (qty < 1 || qty > 125) return exc(fc, 3);
      if (addr + qty > N) return exc(fc, 2);
      const m = fc === 3 ? mem.holding : mem.input, out = Buffer.alloc(2 + 2 * qty);
      out[0] = fc; out[1] = 2 * qty;
      for (let i = 0; i < qty; i++) out.writeUInt16BE(m[addr + i], 2 + 2 * i);
      return out;
    }
    if (fc === 5) { if (qty !== 0xFF00 && qty !== 0) return exc(fc, 3); if (addr >= N) return exc(fc, 2); mem.coil[addr] = qty ? 1 : 0; stats.writes++; return p.slice(0, 5); }
    if (fc === 6) { if (addr >= N) return exc(fc, 2); mem.holding[addr] = qty; stats.writes++; return p.slice(0, 5); }
    if (fc === 15) { const bc = p[5]; if (qty < 1 || qty > 1968 || bc !== Math.ceil(qty / 8)) return exc(fc, 3); if (addr + qty > N) return exc(fc, 2); for (let i = 0; i < qty; i++) mem.coil[addr + i] = (p[6 + (i >> 3)] >> (i & 7)) & 1; stats.writes++; return p.slice(0, 5); }
    if (fc === 16) { const bc = p[5]; if (qty < 1 || qty > 123 || bc !== 2 * qty) return exc(fc, 3); if (addr + qty > N) return exc(fc, 2); for (let i = 0; i < qty; i++) mem.holding[addr + i] = p.readUInt16BE(6 + 2 * i); stats.writes++; return p.slice(0, 5); }
    return exc(fc, 1);
  }
  const socks = new Set();
  const server = net.createServer((sock) => {
    socks.add(sock); sock.on('close', () => socks.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 7) {
        const len = buf.readUInt16BE(4);
        if (buf.length < 6 + len) break;
        const adu = buf.slice(0, 6 + len); buf = buf.slice(6 + len);
        const unit = adu[6];
        if (!opts.anyUnit && unit !== opts.unit) continue;      // wrong unit: no reply (gateway behaviour varies)
        const res = pdu(adu.slice(7));
        const out = Buffer.alloc(7 + res.length);
        adu.copy(out, 0, 0, 4); out.writeUInt16BE(res.length + 1, 4); out[6] = unit; res.copy(out, 7);
        sock.write(out);
      }
    });
    sock.on('error', () => {});
  });
  return {
    server, mem, stats,
    listen() { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.listen, () => resolve(server.address().port)); }); },
    close() { const p = new Promise((r) => server.close(() => r())); socks.forEach((s) => s.destroy()); return p; },
  };
}

module.exports = { createSlave };
if (require.main === module) {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) { if (a[i] === '--port') o.port = +a[++i]; else if (a[i] === '--listen') o.listen = a[++i]; else if (a[i] === '--any-unit') o.anyUnit = true; }
  const s = createSlave(o);
  s.listen().then((p) => console.log('[fake-slave] Modbus TCP slave on ' + (o.listen || '127.0.0.1') + ':' + p + ' (unit ' + (o.anyUnit ? 'any' : 1) + ')'));
}
