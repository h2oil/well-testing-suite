// Modbus core (60-modbus-core.js) + station (61-modbus-station.js) — protocol and logic tests.
//
// Expected values are independent of the code under test:
//   • PDUs: MODBUS Application Protocol Specification V1.1b3 worked examples (§6.1-6.12, §7).
//   • RTU frames / CRC: CRC-16/MODBUS check value ("123456789" → 0x4B37, CRC catalogue);
//     01 03 00 00 00 0A C5 CD and 11 03 00 6B 00 03 76 87 / 11 0F 00 13 00 0A 02 CD 01 BF 0B
//     (widely published frames; re-checked with a separate Python CRC implementation).
//   • IEEE 754 bit patterns from Python struct.pack('>f' / '>d').
//   • Unit factors: NIST SP 811 (1 psi = 6.894 757 kPa, 1 bbl = 0.158 987 294 928 m³, 1 ft³ = 0.028 316 846 592 m³).
//   • Scaling / alarm / block-plan cases: hand calculations in the comments.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WP = 'MODBUS';
const D = path.resolve(__dirname, '..');

// Load 31 (sim, optional for the driver) + 50 + 51 in a fresh sandbox with real timers.
function load(extra) {
  const ctx = Object.assign({ console: { log() {}, warn() {}, error() {} }, Math, Date, JSON, setTimeout, clearTimeout, Promise,
    Uint8Array, Uint16Array, Float64Array, DataView, ArrayBuffer, Buffer }, extra || {});
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ['60-modbus-core.js', '61-modbus-station.js']) vm.runInContext(fs.readFileSync(path.join(D, f), 'utf8'), ctx, { filename: f });
  return ctx.WTS_modbus;
}
const hx = (M, b) => M.hex(b);
const arr = (x) => Array.from(x);
// values created in the sandbox realm: compare structurally through JSON
const plain = (x) => JSON.parse(JSON.stringify(x));
const deq = (assert, a, b, msg) => assert.deepStrictEqual(plain(a), plain(b), msg);

module.exports = [
  {
    name: 'CRC-16/MODBUS check value and published RTU frames',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      assert.strictEqual(M.crc16(Buffer.from('123456789')), 0x4B37, 'CRC catalogue check value');
      assert.strictEqual(hx(M, M.encodeRtu(1, M.buildReadPdu(3, 0, 10))), '01 03 00 00 00 0A C5 CD');
      assert.strictEqual(hx(M, M.encodeRtu(0x11, M.buildReadPdu(3, 0x6B, 3))), '11 03 00 6B 00 03 76 87');
      assert.strictEqual(hx(M, M.encodeRtu(0x11, M.buildWriteCoilsPdu(0x13, [1, 0, 1, 1, 0, 0, 1, 1, 1, 0]))), '11 0F 00 13 00 0A 02 CD 01 BF 0B');
      const d = M.decodeRtu(M.fromHex('11 03 00 6B 00 03 76 87'));
      assert.strictEqual(d.unit, 0x11); assert.strictEqual(hx(M, d.pdu), '03 00 6B 00 03');
      assert.throws(() => M.decodeRtu(M.fromHex('11 03 00 6B 00 03 76 88')), /CRC/);
      // response / request length detection
      assert.strictEqual(M.rtuResponseLength(M.fromHex('11 03 06')), 11);
      assert.strictEqual(M.rtuResponseLength(M.fromHex('11 83')), 5);
      assert.strictEqual(M.rtuResponseLength(M.fromHex('11 10')), 8);
      assert.strictEqual(M.rtuRequestLength(M.fromHex('11 0F 00 13 00 0A 02')), 11);
    },
  },
  {
    name: 'PDUs match the Application Protocol V1.1b3 examples (FC 01 02 03 04 05 06 15 16) and responses decode',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      // §6.1 read coils 20-38 (addr 0x13, qty 0x13) → response 03 CD 6B 05
      assert.strictEqual(hx(M, M.buildReadPdu(1, 0x13, 0x13)), '01 00 13 00 13');
      const c = M.parseResponse(M.buildReadPdu(1, 0x13, 0x13), M.fromHex('01 03 CD 6B 05'));
      deq(assert, c.bits.map(Number), [1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1], 'coils 20-38 (spec: 27-20 = CD, 35-28 = 6B, 38-36 = 5)');
      // §6.2 discrete inputs 197-218 → 03 AC DB 35
      assert.strictEqual(hx(M, M.buildReadPdu(2, 0xC4, 0x16)), '02 00 C4 00 16');
      const di = M.parseResponse(M.buildReadPdu(2, 0xC4, 0x16), M.fromHex('02 03 AC DB 35'));
      assert.strictEqual(di.bits.length, 22); deq(assert, di.bits.slice(0, 8).map(Number), [0, 0, 1, 1, 0, 1, 0, 1], '0xAC LSB first');
      // §6.3 holding 108-110 → 02 2B, 00 00, 00 64 (555, 0, 100)
      assert.strictEqual(hx(M, M.buildReadPdu(3, 0x6B, 3)), '03 00 6B 00 03');
      deq(assert, M.parseResponse(M.buildReadPdu(3, 0x6B, 3), M.fromHex('03 06 02 2B 00 00 00 64')).words, [555, 0, 100]);
      // §6.4 input register 9 → 00 0A
      assert.strictEqual(hx(M, M.buildReadPdu(4, 8, 1)), '04 00 08 00 01');
      deq(assert, M.parseResponse(M.buildReadPdu(4, 8, 1), M.fromHex('04 02 00 0A')).words, [10]);
      // §6.5 write coil 173 ON, §6.6 write register 2 = 3 (echo)
      assert.strictEqual(hx(M, M.buildWriteCoilPdu(0xAC, true)), '05 00 AC FF 00');
      assert.strictEqual(hx(M, M.buildWriteRegisterPdu(1, 3)), '06 00 01 00 03');
      assert.ok(M.parseResponse(M.buildWriteRegisterPdu(1, 3), M.fromHex('06 00 01 00 03')).echo);
      // §6.11 write coils 20-29 = CD 01, §6.12 write registers 2-3 = 000A 0102
      assert.strictEqual(hx(M, M.buildWriteCoilsPdu(0x13, [1, 0, 1, 1, 0, 0, 1, 1, 1, 0])), '0F 00 13 00 0A 02 CD 01');
      assert.strictEqual(hx(M, M.buildWriteRegistersPdu(1, [0x000A, 0x0102])), '10 00 01 00 02 04 00 0A 01 02');
      assert.ok(M.parseResponse(M.buildWriteRegistersPdu(1, [0x000A, 0x0102]), M.fromHex('10 00 01 00 02')).echo);
      // limits
      assert.throws(() => M.buildReadPdu(3, 0, 126), /1-125/);
      assert.throws(() => M.buildReadPdu(1, 0, 2001), /1-2000/);
      assert.throws(() => M.buildWriteRegistersPdu(0, new Array(124).fill(0)), /1-123/);
      assert.throws(() => M.buildReadPdu(3, 65535, 2), /65536/);
      // malformed responses
      assert.throws(() => M.parseResponse(M.buildReadPdu(3, 0x6B, 3), M.fromHex('03 04 02 2B 00 00')), /Byte count/);
      assert.throws(() => M.parseResponse(M.buildReadPdu(3, 0, 1), M.fromHex('04 02 00 00')), /mismatch/);
    },
  },
  {
    name: 'exception responses: parse (§7) and the virtual slave raises codes 01 / 02 / 03',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      // §7 example: read coils → 81 02 (illegal data address)
      let err = null;
      try { M.parseResponse(M.buildReadPdu(1, 0x13, 0x13), M.fromHex('81 02')); } catch (e) { err = e; }
      assert.ok(err && err.kind === 'exception' && err.exception === 2 && /Illegal data address/.test(err.message));
      const S = M.createSlave({ unit: 1, sizes: { holding: 100 } });
      assert.strictEqual(hx(M, S.handlePdu(M.fromHex('07'))), '87 01', 'unsupported FC 07 → 01');
      assert.strictEqual(hx(M, S.handlePdu(M.buildReadPdu(3, 99, 2))), '83 02', 'beyond the map → 02');
      assert.strictEqual(hx(M, S.handlePdu(M.fromHex('03 00 00 00 00'))), '83 03', 'quantity 0 → 03');
      assert.strictEqual(hx(M, S.handlePdu(M.fromHex('05 00 01 12 34'))), '85 03', 'coil value not FF00/0000 → 03');
      // slave answers the spec examples consistently
      S.holding[0x6B] = 555; S.holding[0x6C] = 0; S.holding[0x6D] = 100;
      const S2 = M.createSlave({ unit: 1, sizes: { holding: 200 } }); S2.holding.set([555, 0, 100], 0x6B);
      assert.strictEqual(hx(M, S2.handlePdu(M.buildReadPdu(3, 0x6B, 3))), '03 06 02 2B 00 00 00 64');
      // TCP / RTU framing through handleFrame; wrong unit → no reply; bad CRC → no reply
      assert.strictEqual(hx(M, S2.handleFrame(M.encodeTcp(7, 1, M.buildReadPdu(3, 0x6B, 1)), 'tcp')), '00 07 00 00 00 05 01 03 02 02 2B');
      assert.strictEqual(S2.handleFrame(M.encodeRtu(2, M.buildReadPdu(3, 0x6B, 1)), 'rtu'), null);
      const bad = M.encodeRtu(1, M.buildReadPdu(3, 0x6B, 1)); bad[bad.length - 1] ^= 1;
      assert.strictEqual(S2.handleFrame(bad, 'rtu'), null);
    },
  },
  {
    name: 'MBAP header encode + stream reassembly (split and coalesced frames)',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      const a = M.encodeTcp(1, 0x11, M.buildReadPdu(3, 0x6B, 3));
      assert.strictEqual(hx(M, a), '00 01 00 00 00 06 11 03 00 6B 00 03', 'tid 1, protocol 0, length 6 = unit + 5-byte PDU');
      const b = M.encodeTcp(0xFFFF, 1, M.fromHex('03 02 00 0A'));
      const both = new Uint8Array(a.length + b.length); both.set(a, 0); both.set(b, a.length);
      let r = M.decodeTcpStream(both.slice(0, 15));
      assert.strictEqual(r.frames.length, 1); assert.strictEqual(r.rest.length, 3);
      const rest = new Uint8Array(r.rest.length + both.length - 15); rest.set(r.rest, 0); rest.set(both.slice(15), r.rest.length);
      r = M.decodeTcpStream(rest);
      assert.strictEqual(r.frames.length, 1); assert.strictEqual(r.frames[0].tid, 0xFFFF); assert.strictEqual(hx(M, r.frames[0].pdu), '03 02 00 0A');
      assert.ok(M.decodeTcpStream(M.fromHex('00 01 00 05 00 06 11 03 00 6B 00 03')).error, 'non-zero protocol id rejected');
    },
  },
  {
    name: 'data types and byte / word orders (IEEE 754 bit patterns)',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      // 123.456f = 0x42F6E979 (struct.pack('>f'))
      deq(assert, M.encodeValue(123.456, 'float32', 'ABCD'), [0x42F6, 0xE979]);
      deq(assert, M.encodeValue(123.456, 'float32', 'CDAB'), [0xE979, 0x42F6]);
      deq(assert, M.encodeValue(123.456, 'float32', 'BADC'), [0xF642, 0x79E9]);
      deq(assert, M.encodeValue(123.456, 'float32', 'DCBA'), [0x79E9, 0xF642]);
      ['ABCD', 'CDAB', 'BADC', 'DCBA'].forEach((o) => assert.near(M.decodeValue(M.encodeValue(123.456, 'float32', o), 'float32', o), 123.456, 1e-4, o));
      assert.near(M.decodeValue([0x42F6, 0xE979], 'float32', 'ABCD'), 123.456, 1e-4);
      assert.near(M.decodeValue([0xBFC0, 0x0000], 'float32'), -1.5, 0, '-1.5f = BFC00000');
      // -2.5e-3 as double = BF647AE147AE147B
      deq(assert, M.encodeValue(-2.5e-3, 'float64', 'ABCD'), [0xBF64, 0x7AE1, 0x47AE, 0x147B]);
      deq(assert, M.encodeValue(-2.5e-3, 'float64', 'CDAB'), [0x147B, 0x47AE, 0x7AE1, 0xBF64]);
      assert.strictEqual(M.decodeValue([0x3FF0, 0, 0, 0], 'float64'), 1);
      assert.strictEqual(M.decodeValue([0x7B14, 0xAE47, 0xE17A, 0x64BF], 'float64', 'DCBA'), -2.5e-3);
      // integers
      assert.strictEqual(M.decodeValue([0xFFFF, 0xFFFE], 'int32'), -2, '-2 = FFFFFFFE');
      assert.strictEqual(M.decodeValue([0xBEEF, 0xDEAD], 'uint32', 'CDAB'), 0xDEADBEEF);
      assert.strictEqual(M.decodeValue([0xFFFF], 'int16'), -1);
      assert.strictEqual(M.decodeValue([0xFFFF], 'uint16'), 65535);
      assert.strictEqual(M.decodeValue([0x3412], 'uint16', 'BADC'), 0x1234, 'byte swap inside a 16-bit register');
      deq(assert, M.encodeValue(-2, 'int16'), [0xFFFE]);
      assert.throws(() => M.encodeValue(70000, 'uint16'), /out of range/);
      assert.strictEqual(M.decodeValue(true, 'bool'), 1);
    },
  },
  {
    name: 'scaling (raw ↔ engineering), addressing (0/1-based, PLC notation) and unit conversion',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      // 4-20 mA card 4000-20000 counts → 0-300 psig: 12000 counts = 150 psig; inverse
      const lin = { mode: 'linear', rawMin: 4000, rawMax: 20000, engMin: 0, engMax: 300 };
      assert.near(M.scaleToEng(12000, lin), 150, 1e-12); assert.near(M.scaleToRaw(75, lin), 8000, 1e-9);
      assert.near(M.scaleToEng(2500, { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }), 25, 1e-12);
      assert.near(M.scaleToEng(650, { mode: 'gain', gain: 0.1, offset: -40 }), 25, 1e-12);
      assert.near(M.scaleToRaw(25, { mode: 'gain', gain: 0.1, offset: -40 }), 650, 1e-9);
      assert.strictEqual(M.scaleToEng(7, { mode: 'none' }), 7);
      // addressing
      assert.strictEqual(M.protocolAddress(40001, 'holding', 1), 0);
      assert.strictEqual(M.protocolAddress('400001', 'holding', 1), 0);
      assert.strictEqual(M.protocolAddress(40108, 'holding', 1), 107, 'spec register 108 = protocol 0x6B');
      assert.strictEqual(M.protocolAddress(30010, 'input', 1), 9);
      assert.strictEqual(M.protocolAddress(1, 'coil', 1), 0);
      assert.strictEqual(M.protocolAddress(107, 'holding', 0), 107);
      assert.ok(isNaN(M.protocolAddress(0, 'holding', 1)), '1-based address 0 is invalid');
      // units → field units (NIST SP 811 factors, hand-calculated)
      assert.near(M.toCanonical(10, 'bar', 'pressureG'), 145.0377377, 1e-6, '10 bar(g) = 1000/6.894757 psig');
      assert.near(M.toCanonical(14.696, 'psia', 'pressureG'), 0.00005, 1e-4);
      assert.near(M.toCanonical(100, '°C', 'temperature'), 212, 1e-9);
      assert.near(M.toCanonical(1000, 'm3/d', 'liquidRate'), 6289.810770, 1e-5);
      assert.near(M.toCanonical(1, 'e3m3/d', 'gasRate'), 0.0353146667, 1e-9);
      assert.near(M.toCanonical(1, 'kg/cm2', 'pressureG'), 14.2233433, 1e-6);
      assert.near(M.fromCanonical(145.0377377, 'barg', 'pressureG'), 10, 1e-6);
      assert.ok(isNaN(M.toCanonical(5, 'psig', 'temperature')), 'unit / category mismatch → NaN');
      assert.strictEqual(M.toCanonical(5, '', 'temperature'), 5, 'blank unit = field unit');
    },
  },
  {
    name: 'block-read planning groups contiguous registers and respects the 125 / 2000 limits',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      const it = (table, addr, count, ref) => ({ table, addr, count, ref });
      // float32 tags at 0, 2, 4 and one at 10 (gap 4 after 6) → one block 0..11 with maxGap 4
      let b = M.planBlocks([it('holding', 4, 2, 'c'), it('holding', 0, 2, 'a'), it('holding', 2, 2, 'b'), it('holding', 10, 2, 'd')], { maxGap: 4 });
      assert.strictEqual(b.length, 1); assert.strictEqual(b[0].start, 0); assert.strictEqual(b[0].count, 12); assert.strictEqual(b[0].fn, 3);
      deq(assert, b[0].items.map((x) => [x.ref, x.offset]), [['a', 0], ['b', 2], ['c', 4], ['d', 10]]);
      b = M.planBlocks([it('holding', 0, 2, 'a'), it('holding', 2, 2, 'b'), it('holding', 10, 2, 'd')], { maxGap: 0 });
      deq(assert, b.map((x) => [x.start, x.count]), [[0, 4], [10, 2]]);
      // 130 single registers → 125 + 5
      b = M.planBlocks(Array.from({ length: 130 }, (_, i) => it('input', i, 1, i)), { maxGap: 0 });
      deq(assert, b.map((x) => [x.fn, x.start, x.count]), [[4, 0, 125], [4, 125, 5]]);
      // 2001 coils → 2000 + 1; tables never mixed
      b = M.planBlocks(Array.from({ length: 2001 }, (_, i) => it('coil', i, 1, i)).concat([it('discrete', 0, 1, 'x')]), { maxGap: 0 });
      deq(assert, b.map((x) => [x.fn, x.start, x.count]), [[1, 0, 2000], [1, 2000, 1], [2, 0, 1]]);
      // a float straddling the limit starts a new block
      b = M.planBlocks([it('holding', 0, 124, 'a'), it('holding', 124, 2, 'b')], { maxGap: 0 });
      deq(assert, b.map((x) => [x.start, x.count]), [[0, 124], [124, 2]]);
    },
  },
  {
    name: 'alarm levels with deadband hysteresis and the ISA-18.2 UNACK / ACK / RTN lifecycle',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      const A = { lolo: 10, lo: 20, hi: 80, hihi: 90 };
      assert.strictEqual(M.alarmLevel(85, A, 2, null), 'HI');
      assert.strictEqual(M.alarmLevel(95, A, 2, 'HI'), 'HIHI');
      assert.strictEqual(M.alarmLevel(89, A, 2, 'HIHI'), 'HIHI', '89 > 90 - 2 keeps HIHI');
      assert.strictEqual(M.alarmLevel(87.9, A, 2, 'HIHI'), 'HI', 'below 88 drops to HI');
      assert.strictEqual(M.alarmLevel(79, A, 2, 'HI'), 'HI', '79 > 78 keeps HI');
      assert.strictEqual(M.alarmLevel(77, A, 2, 'HI'), null);
      assert.strictEqual(M.alarmLevel(79, A, 2, null), null, 'no hysteresis on the way up');
      assert.strictEqual(M.alarmLevel(5, A, 0, null), 'LOLO');
      assert.strictEqual(M.alarmLevel(21, A, 2, 'LO'), 'LO');
      const AM = M.createAlarmManager();
      AM.update('t1', 'HI', { t: 1, tag: 'P1' });
      assert.strictEqual(AM.get('t1').state, 'UNACK');
      AM.ack('t1', 2); assert.strictEqual(AM.get('t1').state, 'ACK');
      AM.update('t1', 'HIHI', { t: 3, tag: 'P1' }); assert.strictEqual(AM.get('t1').state, 'UNACK', 'escalation re-annunciates');
      AM.update('t1', null, { t: 4 }); assert.strictEqual(AM.get('t1').state, 'RTN', 'cleared while unacknowledged → RTN');
      AM.ack('t1', 5); assert.strictEqual(AM.get('t1'), null, 'ack of RTN removes it');
      AM.update('t2', 'LO', { t: 6, tag: 'P2' }); AM.ack('t2'); AM.update('t2', null, { t: 7 });
      assert.strictEqual(AM.get('t2'), null, 'acknowledged alarm that clears is removed');
      assert.ok(AM.events().length >= 6);
    },
  },
  {
    name: 'client: transaction ids, timeouts with retries, CRC retry, exceptions not retried (simulator transport)',
    wp: WP, opts: false,
    async run(app, assert) {
      const M = load();
      const S = M.createSlave({ unit: 1, sizes: { holding: 100 } }); S.holding.set([11, 22, 33], 0);
      // TCP framing, normal read
      let tr = M.transports.sim({ slave: S }); await tr.open();
      let c = M.createClient(tr, { timeout: 60, retries: 1 });
      deq(assert, arr(await c.readHoldingRegisters(1, 0, 3)), [11, 22, 33]);
      deq(assert, arr(await c.readHoldingRegisters(1, 1, 1)), [22]);
      assert.strictEqual(c.stats().tx, 2);
      // exception is returned, not retried
      let e = null; try { await c.readHoldingRegisters(1, 99, 2); } catch (x) { e = x; }
      assert.ok(e && e.kind === 'exception' && e.exception === 2); assert.strictEqual(c.stats().retries, 0);
      await c.close();
      // dropped replies → timeout after 1 + retries attempts
      tr = M.transports.sim({ slave: S, drop: true }); await tr.open();
      c = M.createClient(tr, { timeout: 40, retries: 2 });
      e = null; try { await c.readHoldingRegisters(1, 0, 1); } catch (x) { e = x; }
      assert.ok(e && e.kind === 'timeout', 'timeout error');
      assert.strictEqual(c.stats().timeouts, 3); assert.strictEqual(c.stats().retries, 2); assert.strictEqual(c.stats().tx, 3);
      await c.close();
      // RTU framing with corrupted CRC → retried, then 'crc' error
      tr = M.transports.sim({ slave: S, framing: 'rtu', corrupt: true }); await tr.open();
      c = M.createClient(tr, { timeout: 40, retries: 1 });
      e = null; try { await c.readHoldingRegisters(1, 0, 1); } catch (x) { e = x; }
      assert.ok(e && e.kind === 'crc'); assert.strictEqual(c.stats().tx, 2);
      await c.close();
      // RTU ok + writes
      tr = M.transports.sim({ slave: S, framing: 'rtu' }); await tr.open();
      c = M.createClient(tr, { timeout: 60 });
      await c.writeRegisters(1, 10, M.encodeValue(123.456, 'float32', 'CDAB'));
      assert.near(S.getValue('holding', 10, 'float32', 'CDAB'), 123.456, 1e-4);
      await c.writeCoil(1, 3, true); assert.strictEqual(S.coil[3], 1);
      deq(assert, arr(await c.readCoils(1, 0, 4)).map(Number), [0, 0, 0, 1]);
      // queued requests are serialised (one in flight)
      const ps = [c.readHoldingRegisters(1, 0, 1), c.readHoldingRegisters(1, 1, 1), c.readHoldingRegisters(1, 2, 1)];
      assert.strictEqual(c.pending(), 3);
      deq(assert, (await Promise.all(ps)).map((w) => w[0]), [11, 22, 33]);
      await c.close();
      e = null; try { await c.readHoldingRegisters(1, 0, 1); } catch (x) { e = x; }
      assert.ok(e && e.kind === 'closed');
    },
  },
  {
    name: 'station: quality good → stale → bad, deadband, historian batch with log filters',
    wp: WP, opts: false,
    async run(app, assert) {
      let t = 1e6;
      const recs = [];
      const M = load({ WTS_historian: { record: (b) => recs.push(b) } });
      const S = M.createSlave({ unit: 1, sizes: { holding: 100 } });
      S.setValue('holding', 0, 'float32', 'ABCD', 100);
      let drop = false;
      const cfg = { devices: [{ id: 'd1', name: 'PLC', transport: 'sim', pollMs: 1000, timeoutMs: 50, retries: 0 }],
        tags: [{ id: 'a', name: 'P1', device: 'd1', table: 'holding', address: 0, type: 'float32', unit: 'psig', deadband: 0.5, link: 'whp' },
               { id: 'b', name: 'P2', device: 'd1', table: 'holding', address: 2, type: 'int16', unit: 'barg', link: 'sep_p', logMinMs: 5000 },
               { id: 'c', name: 'NOLOG', device: 'd1', table: 'holding', address: 3, type: 'uint16', log: false }] };
      // a transport wrapper that swallows requests while `drop` is set (→ timeouts)
      const st2 = M.createStation(cfg, { now: () => t, transportFor: () => { const tr = M.transports.sim({ slave: S }); const send = tr.send; tr.send = (b) => { if (!drop) send(b); }; return tr; } });
      S.holding[2] = 10;                         // P2 = 10 barg → 145.0377 psig
      await st2.pollNow();
      assert.strictEqual(st2.value('a').q, 'good'); assert.strictEqual(st2.value('a').value, 100);
      assert.near(st2.getVar('sep_p').value, 145.0377377, 1e-6);
      assert.strictEqual(st2.getVar('whp').tag, 'P1');
      assert.strictEqual(recs.length, 1); deq(assert, recs[0].map((s) => s.tag), ['P1', 'P2'], 'log:false tag not recorded');
      deq(assert, Object.keys(recs[0][0]).sort(), ['device', 'q', 'raw', 't', 'tag', 'unit', 'v']);
      assert.strictEqual(recs[0][0].device, 'PLC'); assert.strictEqual(recs[0][0].unit, 'psig'); assert.strictEqual(recs[0][0].v, 100);
      // deadband 0.5: 100.3 is not published, 100.6 is
      S.setValue('holding', 0, 'float32', 'ABCD', 100.3); t += 1000; await st2.pollNow();
      assert.strictEqual(st2.value('a').value, 100); assert.near(st2.value('a').raw, 100.3, 1e-4);
      assert.strictEqual(recs[1].map((s) => s.tag).join(), 'P1', 'P2 held back by its 5 s minimum log interval');
      S.setValue('holding', 0, 'float32', 'ABCD', 100.6); t += 1000; await st2.pollNow();
      assert.near(st2.value('a').value, 100.6, 1e-4);
      // stale: no successful poll for > 3 poll intervals
      t += 3500; st2.values();
      assert.strictEqual(st2.value('a').q, 'stale');
      // bad: dropped replies → timeout
      drop = true; await st2.pollNow();
      assert.strictEqual(st2.value('a').q, 'bad'); assert.match(st2.value('a').err, /No response/);
      assert.strictEqual(st2.getVar('whp').q, 'bad');
      assert.strictEqual(recs[recs.length - 1][0].v, null, 'bad sample → v null'); assert.strictEqual(recs[recs.length - 1][0].q, 'bad');
      assert.ok(st2.alarms.list().some((a) => a.level === 'COMMS'), 'COMMS alarm raised');
      drop = false; t += 1000; await st2.pollNow();
      assert.strictEqual(st2.value('a').q, 'good');
      assert.ok(!st2.alarms.list().some((a) => a.level === 'COMMS' && a.active), 'COMMS alarm cleared');
      st2.dispose();
    },
  },
  {
    name: 'write protection: disabled by default, needs confirmation, read-only tables refused; enabled writes reach the slave',
    wp: WP, opts: false,
    async run(app, assert) {
      const M = load();
      const S = M.createSlave({ unit: 1 });
      const base = { devices: [{ id: 'd1', name: 'PLC', transport: 'sim' }],
        tags: [{ id: 'h', name: 'SP', device: 'd1', table: 'holding', address: 0, type: 'float32' },
               { id: 's', name: 'SCALED', device: 'd1', table: 'holding', address: 10, type: 'int16', scale: { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 } },
               { id: 'c', name: 'CMD', device: 'd1', table: 'coil', address: 5 },
               { id: 'i', name: 'IN', device: 'd1', table: 'input', address: 0, type: 'uint16' }] };
      const env = { transportFor: () => M.transports.sim({ slave: S }) };
      let st = M.createStation(base, env), e = null;
      try { await st.write('h', 150, { confirmed: true }); } catch (x) { e = x; }
      assert.ok(e && /Writes are disabled/.test(e.message), 'read-only by default');
      assert.strictEqual(S.getValue('holding', 0, 'float32', 'ABCD'), 0);
      st = M.createStation(Object.assign({}, base, { writesEnabled: true }), env);
      e = null; try { await st.write('h', 150); } catch (x) { e = x; }
      assert.ok(e && /not confirmed/.test(e.message));
      e = null; try { await st.write('i', 1, { confirmed: true }); } catch (x) { e = x; }
      assert.ok(e && /read-only/.test(e.message));
      await st.write('h', 150.5, { confirmed: true });
      assert.near(S.getValue('holding', 0, 'float32', 'ABCD'), 150.5, 1e-4);
      await st.write('s', 42.5, { confirmed: true });
      assert.strictEqual(S.holding[10], 4250, '42.5 % → raw 4250 (linear 0-10000)');
      await st.write('c', 1, { confirmed: true });
      assert.strictEqual(S.coil[5], 1);
      assert.ok(st.alarms.events().some((ev) => ev.kind === 'write' && /SP = 150.5/.test(ev.msg)), 'write logged as an event');
      const r = await st.testRead('s');
      assert.strictEqual(r.raw, 4250); assert.near(r.value, 42.5, 1e-12);
    },
  },
  {
    name: 'config: normalisation / validation, CSV round trip, demo config consistent with the virtual slave map',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      const n = M.normalizeConfig({ devices: [{ id: 'd', name: 'X', transport: 'ws', host: '', pollMs: 5, port: 70000 }],
        tags: [{ id: 't', name: 'A', device: 'd', table: 'coil', type: 'float32', address: 0 },
               { id: 'u', name: 'A', device: 'nope', table: 'holding', type: 'float32', address: 0, link: 'whp', unit: '°C' },
               { id: 'v', name: 'B', device: 'd', table: 'holding', type: 'int16', address: -1, alarm: { hi: 10, hihi: 5 } }] });
      const c = n.config;
      assert.strictEqual(c.devices[0].pollMs, 100, 'poll clamped to 100 ms'); assert.strictEqual(c.devices[0].port, 65535);
      assert.ok(n.errors.some((e) => /host/.test(e)));
      assert.strictEqual(c.tags[0].type, 'bool', 'bit tables force bool');
      assert.ok(n.tagErrors.u.some((e) => /cannot be converted/.test(e)) && n.tagErrors.u.some((e) => /duplicate/.test(e)) && n.tagErrors.u.some((e) => /device/.test(e)));
      assert.ok(n.tagErrors.v.some((e) => /address/.test(e)) && n.tagErrors.v.some((e) => /LOLO/.test(e)));
      assert.strictEqual(c.writesEnabled, false, 'writes default off');
      // CSV round trip
      const demo = M.demoConfig();
      const csv = M.tagsToCsv(demo), back = M.tagsFromCsv(csv, demo);
      assert.strictEqual(back.tags.length, demo.tags.length); deq(assert, back.errors, []);
      const n2 = M.normalizeConfig(Object.assign({}, demo, { tags: back.tags })).config;
      ['name', 'table', 'address', 'type', 'order', 'unit', 'link', 'deadband', 'log'].forEach((k) => deq(assert, n2.tags.map((t) => t[k]), demo.tags.map((t) => t[k]), k));
      deq(assert, n2.tags.map((t) => t.scale.mode), demo.tags.map((t) => t.scale.mode));
      deq(assert, M.parseCsv('a,"b,""c"""\r\n1,2\n'), [['a', 'b,"c"'], ['1', '2']]);
      // demo config validates cleanly, every linked variable is linked at most once, BHP in barg
      const nd = M.normalizeConfig(demo);
      deq(assert, nd.errors, []);
      assert.strictEqual(demo.tags.length, 36);
      const linked = demo.tags.filter((t) => t.link).map((t) => t.link);
      assert.strictEqual(new Set(linked).size, linked.length);
      assert.strictEqual(linked.length, M.VARS.length, 'every app variable has a demo tag');
    },
  },
  {
    name: 'applyVarsToState maps live values onto a simulator snapshot (levels, pressures, valves, ESD)',
    wp: WP, opts: false,
    run(app, assert) {
      const ctx = { console: { log() {}, warn() {} }, Math, Date, JSON, setTimeout, clearTimeout, Promise, Uint8Array, Uint16Array, Float64Array, DataView, ArrayBuffer, Buffer };
      ctx.globalThis = ctx; vm.createContext(ctx);
      for (const f of ['31-wts-sim.js', '60-modbus-core.js', '61-modbus-station.js']) vm.runInContext(fs.readFileSync(path.join(D, f), 'utf8').split('// === SELF-TEST ===')[0], ctx, { filename: f });
      const M = ctx.WTS_modbus, sim = ctx.WTS_sim.create(ctx.WTS_sim.SAMPLE_FLOW, { seed: 3 });
      sim.advance(30);
      const base = sim.getState();
      const s = M.applyVarsToState(base, { whp: 2500, sep_p: 140, surge_lvl_b: 80, gauge_lvl_a: 45, xv301b: 1, pump_running: 1, gas_rate: base.rates.gas_mmscfd / 2 });
      assert.strictEqual(s.nodes.wellhead.P, 2500); assert.strictEqual(s.sep.P, 140); assert.strictEqual(s.nodes.separator.P, 140);
      assert.near(s.surge.comps[1].frac, 0.8, 1e-12); assert.near(s.gauge.tanks[0].frac, 0.45, 1e-12);
      assert.strictEqual(s.gauge.tanks[1].inlet, true); assert.strictEqual(s.surge.pump.on, true);
      assert.near(s.segs[0].vel, base.segs[0].vel / 2, 1e-9, 'gas rate halves the upstream velocities');
      assert.notStrictEqual(s, base); assert.notStrictEqual(base.nodes.wellhead.P, 2500, 'base snapshot untouched');
      const shut = M.applyVarsToState(base, { esd_open: 0 });
      assert.strictEqual(shut.esd.open, false); assert.strictEqual(shut.esd.travel, 0); assert.strictEqual(shut.segs[0].vel, 0);
      // round trip through varsFromState for the mapped keys
      const v = M.varsFromState(s);
      assert.strictEqual(v.whp, 2500); assert.near(v.surge_lvl_b, 80, 1e-9); assert.strictEqual(v.xv301b, 1);
      sim.dispose();
    },
  },
];
