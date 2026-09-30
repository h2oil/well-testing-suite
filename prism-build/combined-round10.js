
// ═══════════════════════════════════════════════════════════════════════
// Round-10 (live data) — auto-injected from prism-build/6N-*.js
//   window.WTS_modbus (Modbus TCP / RTU master, station, virtual slave) and the
//   registry pages `modbus` and `wellos` (Mini WellOS).
//   • 60-modbus-core
//   • 61-modbus-station
//   • 62-modbus-page
//   • 63-wellos
//   • 64-modbus-bridge-pack
//   • 65-modbus-bridge-setup
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 60-modbus-core ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 60-modbus-core.js — Modbus protocol core (Round-10, "Live Data")
// -----------------------------------------------------------------------------
// window.WTS_modbus — pure-JS Modbus master for the Mini WellOS / Modbus pages.
//
//   • PDU encode / decode for function codes 01 02 03 04 05 06 15 16 and the
//     exception responses (0x80 | fc, code 1-11)
//       ref: MODBUS Application Protocol Specification V1.1b3 (Modbus
//            Organization, 2012) §6.1-6.12 (request / response layouts, the
//            quantity limits 2000 bits / 125 registers read, 1968 coils /
//            123 registers write) and §7 (exception codes).
//   • Modbus TCP framing: MBAP header (transaction id, protocol id 0, length,
//     unit id) + stream reassembly
//       ref: MODBUS Messaging on TCP/IP Implementation Guide V1.0b (2006) §3.1.
//   • Modbus RTU framing: address + PDU + CRC-16 (poly 0xA001 reflected,
//     init 0xFFFF, low byte first)
//       ref: MODBUS over Serial Line Specification V1.02 (2006) §2.5.1.2 and
//            Appendix B (CRC generation). Check value "123456789" → 0x4B37.
//   • Data types bool / int16 / uint16 / int32 / uint32 / float32 / float64
//     (IEEE 754-2019 binary32 / binary64) with byte / word order
//     ABCD (big-endian, the Modbus default), CDAB (word swap), BADC (byte swap
//     inside each register) and DCBA (little-endian). 64-bit values apply the
//     same two swaps over four registers (CDAB = register order reversed).
//   • Scaling: linear raw [min,max] → engineering [min,max], or gain / offset.
//   • Client: one request in flight per connection, transaction ids 1..65535,
//     per-request timeout (the only timer, cleared on reply), retries on a
//     timeout or CRC error (never on an exception response).
//   • Transports (pluggable, same interface): WebSocket bridge (web → the
//     tools/modbus-bridge Node script → Modbus TCP), Web Serial (RTU over a
//     USB–RS-485 adapter, Chrome / Edge desktop), iOS native TCP (Capacitor
//     plugin "ModbusTcp", Network.framework) and a built-in simulator
//     transport that talks to an in-browser virtual slave (no timers: replies
//     arrive on a microtask).
//
// Load-time rule: defines functions and assigns window.WTS_modbus only. No DOM,
// timers, storage or listeners at load. Field units are handled in 51.
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
var M = G.WTS_modbus = G.WTS_modbus || {};

// ─── constants (Application Protocol V1.1b3) ────────────────────────────────
var FC = { READ_COILS: 1, READ_DISCRETE: 2, READ_HOLDING: 3, READ_INPUT: 4,
    WRITE_COIL: 5, WRITE_REGISTER: 6, WRITE_COILS: 15, WRITE_REGISTERS: 16 };
var LIMITS = { readBits: 2000, readRegs: 125, writeCoils: 1968, writeRegs: 123 };
var EXCEPTIONS = { 1: 'Illegal function', 2: 'Illegal data address', 3: 'Illegal data value',
    4: 'Server device failure', 5: 'Acknowledge', 6: 'Server device busy', 8: 'Memory parity error',
    10: 'Gateway path unavailable', 11: 'Gateway target device failed to respond' };
// Register tables. `plc` = the leading digit of the classic 1-based PLC notation (00001 / 10001 / 30001 / 40001).
var TABLES = {
    coil:     { label: 'Coil (0x)',             read: 1, write1: 5, writeN: 15, bits: true,  plc: 0 },
    discrete: { label: 'Discrete input (1x)',   read: 2, bits: true, readOnly: true, plc: 1 },
    input:    { label: 'Input register (3x)',   read: 4, readOnly: true, plc: 3 },
    holding:  { label: 'Holding register (4x)', read: 3, write1: 6, writeN: 16, plc: 4 }
};
var TYPES = {
    bool:    { label: 'Bool / bit',        regs: 1, bit: true },
    int16:   { label: 'INT16',             regs: 1, min: -32768, max: 32767, int: true },
    uint16:  { label: 'UINT16',            regs: 1, min: 0, max: 65535, int: true },
    int32:   { label: 'INT32',             regs: 2, min: -2147483648, max: 2147483647, int: true },
    uint32:  { label: 'UINT32',            regs: 2, min: 0, max: 4294967295, int: true },
    float32: { label: 'FLOAT32 (IEEE 754)', regs: 2 },
    float64: { label: 'FLOAT64 (IEEE 754)', regs: 4 }
};
var ORDERS = ['ABCD', 'CDAB', 'BADC', 'DCBA'];

function ModbusError(kind, message, extra) {
    var e = new Error(message);
    e.name = 'ModbusError';
    e.kind = kind;                   // 'exception' | 'timeout' | 'protocol' | 'crc' | 'transport' | 'closed' | 'config'
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
}
function exceptionText(code) { return EXCEPTIONS[code] || ('Exception ' + code); }

// ─── byte helpers ────────────────────────────────────────────────────────────
function u8(a) { return a instanceof Uint8Array ? a : new Uint8Array(a || []); }
function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
}
function hex(bytes) {
    var s = [], b = u8(bytes);
    for (var i = 0; i < b.length; i++) s.push((b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase());
    return s.join(' ');
}
function fromHex(str) {
    var clean = String(str || '').replace(/[^0-9a-fA-F]/g, ''), out = new Uint8Array(clean.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}
function isInt(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }
function b64encode(bytes) {
    var b = u8(bytes), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    if (typeof G.btoa === 'function') return G.btoa(s);
    return Buffer.from(s, 'binary').toString('base64');   // Node (tests)
}
function b64decode(str) {
    var s = typeof G.atob === 'function' ? G.atob(String(str || '')) : Buffer.from(String(str || ''), 'base64').toString('binary');
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
}

// ─── CRC-16/MODBUS (Serial Line V1.02 Appendix B) ────────────────────────────
function crc16(bytes, start, end) {
    var b = u8(bytes), crc = 0xFFFF;
    start = start || 0; end = end == null ? b.length : end;
    for (var i = start; i < end; i++) {
        crc ^= b[i];
        for (var k = 0; k < 8; k++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
    }
    return crc & 0xFFFF;
}

// ─── PDU builders ────────────────────────────────────────────────────────────
function checkAddr(addr, qty) {
    if (!isInt(addr) || addr < 0 || addr > 65535) throw ModbusError('config', 'Address must be 0-65535 (protocol address), got ' + addr);
    if (qty != null && addr + qty > 65536) throw ModbusError('config', 'Address + quantity exceeds 65536');
}
function buildReadPdu(fn, addr, qty) {
    if (fn < 1 || fn > 4) throw ModbusError('config', 'Not a read function: ' + fn);
    var lim = fn <= 2 ? LIMITS.readBits : LIMITS.readRegs;
    if (!isInt(qty) || qty < 1 || qty > lim) throw ModbusError('config', 'Quantity must be 1-' + lim + ' for FC' + fn + ', got ' + qty);
    checkAddr(addr, qty);
    return new Uint8Array([fn, addr >> 8, addr & 255, qty >> 8, qty & 255]);
}
function buildWriteCoilPdu(addr, on) {
    checkAddr(addr, 1);
    return new Uint8Array([5, addr >> 8, addr & 255, on ? 0xFF : 0x00, 0x00]);
}
function buildWriteRegisterPdu(addr, word) {
    checkAddr(addr, 1);
    if (!isInt(word) || word < -32768 || word > 65535) throw ModbusError('config', 'Register value must be a 16-bit integer, got ' + word);
    word &= 0xFFFF;
    return new Uint8Array([6, addr >> 8, addr & 255, word >> 8, word & 255]);
}
function buildWriteCoilsPdu(addr, bits) {
    var n = bits ? bits.length : 0;
    if (n < 1 || n > LIMITS.writeCoils) throw ModbusError('config', 'Coil count must be 1-' + LIMITS.writeCoils);
    checkAddr(addr, n);
    var nb = Math.ceil(n / 8), out = new Uint8Array(6 + nb);
    out[0] = 15; out[1] = addr >> 8; out[2] = addr & 255; out[3] = n >> 8; out[4] = n & 255; out[5] = nb;
    for (var i = 0; i < n; i++) if (bits[i]) out[6 + (i >> 3)] |= (1 << (i & 7));   // LSB of the first byte = first coil
    return out;
}
function buildWriteRegistersPdu(addr, words) {
    var n = words ? words.length : 0;
    if (n < 1 || n > LIMITS.writeRegs) throw ModbusError('config', 'Register count must be 1-' + LIMITS.writeRegs);
    checkAddr(addr, n);
    var out = new Uint8Array(6 + 2 * n);
    out[0] = 16; out[1] = addr >> 8; out[2] = addr & 255; out[3] = n >> 8; out[4] = n & 255; out[5] = 2 * n;
    for (var i = 0; i < n; i++) {
        var w = words[i];
        if (!isInt(w) || w < -32768 || w > 65535) throw ModbusError('config', 'Register value must be a 16-bit integer');
        w &= 0xFFFF; out[6 + 2 * i] = w >> 8; out[7 + 2 * i] = w & 255;
    }
    return out;
}

// parseResponse(reqPdu, resPdu) → { fn, bits | words | echo } or throws ModbusError.
function parseResponse(req, res) {
    req = u8(req); res = u8(res);
    if (!res.length) throw ModbusError('protocol', 'Empty response');
    var fn = req[0];
    if (res[0] === (fn | 0x80)) {
        var code = res.length > 1 ? res[1] : 0;
        throw ModbusError('exception', 'Modbus exception ' + code + ' (' + exceptionText(code) + ') for FC' + fn, { exception: code, fn: fn });
    }
    if (res[0] !== fn) throw ModbusError('protocol', 'Function code mismatch: sent ' + fn + ', got ' + res[0]);
    var qty, i;
    if (fn >= 1 && fn <= 4) {
        qty = (req[3] << 8) | req[4];
        var bc = res[1], want = fn <= 2 ? Math.ceil(qty / 8) : 2 * qty;
        if (bc !== want || res.length !== 2 + bc) throw ModbusError('protocol', 'Byte count ' + bc + ' does not match the ' + qty + ' requested (want ' + want + ')');
        if (fn <= 2) {
            var bits = [];
            for (i = 0; i < qty; i++) bits.push(!!(res[2 + (i >> 3)] & (1 << (i & 7))));
            return { fn: fn, bits: bits };
        }
        var words = [];
        for (i = 0; i < qty; i++) words.push((res[2 + 2 * i] << 8) | res[3 + 2 * i]);
        return { fn: fn, words: words };
    }
    if (fn === 5 || fn === 6) {
        if (res.length !== 5) throw ModbusError('protocol', 'Bad FC' + fn + ' echo length');
        for (i = 1; i < 5; i++) if (res[i] !== req[i]) throw ModbusError('protocol', 'FC' + fn + ' echo does not match the request');
        return { fn: fn, echo: true };
    }
    if (fn === 15 || fn === 16) {
        if (res.length !== 5) throw ModbusError('protocol', 'Bad FC' + fn + ' response length');
        for (i = 1; i < 5; i++) if (res[i] !== req[i]) throw ModbusError('protocol', 'FC' + fn + ' address / quantity echo mismatch');
        return { fn: fn, echo: true };
    }
    throw ModbusError('protocol', 'Unsupported function code ' + fn);
}

// ─── Modbus TCP framing (MBAP) ───────────────────────────────────────────────
function encodeTcp(tid, unit, pdu) {
    pdu = u8(pdu);
    var len = pdu.length + 1, out = new Uint8Array(7 + pdu.length);
    out[0] = (tid >> 8) & 255; out[1] = tid & 255; out[2] = 0; out[3] = 0;
    out[4] = len >> 8; out[5] = len & 255; out[6] = unit & 255;
    out.set(pdu, 7);
    return out;
}
// decodeTcpStream(buf) → { frames:[{tid, unit, pdu}], rest:Uint8Array, error? }
// Incomplete trailing bytes stay in `rest`; a non-zero protocol id or an
// impossible length (ADU > 260 bytes) discards the buffer (resync).
function decodeTcpStream(buf) {
    buf = u8(buf);
    var frames = [], off = 0;
    while (buf.length - off >= 7) {
        var proto = (buf[off + 2] << 8) | buf[off + 3], len = (buf[off + 4] << 8) | buf[off + 5];
        if (proto !== 0 || len < 2 || len > 254) return { frames: frames, rest: new Uint8Array(0), error: 'Bad MBAP header (protocol ' + proto + ', length ' + len + ')' };
        if (buf.length - off < 6 + len) break;
        frames.push({ tid: (buf[off] << 8) | buf[off + 1], unit: buf[off + 6], pdu: buf.slice(off + 7, off + 6 + len) });
        off += 6 + len;
    }
    return { frames: frames, rest: buf.slice(off) };
}

// ─── Modbus RTU framing ──────────────────────────────────────────────────────
function encodeRtu(unit, pdu) {
    pdu = u8(pdu);
    var out = new Uint8Array(pdu.length + 3);
    out[0] = unit & 255; out.set(pdu, 1);
    var c = crc16(out, 0, pdu.length + 1);
    out[pdu.length + 1] = c & 255; out[pdu.length + 2] = c >> 8;    // CRC low byte first
    return out;
}
// Expected length of an RTU *response* from its first bytes (0 = need more, -1 = unknown fc).
function rtuResponseLength(buf) {
    if (buf.length < 2) return 0;
    var fn = buf[1];
    if (fn & 0x80) return 5;
    if (fn >= 1 && fn <= 4) return buf.length < 3 ? 0 : 5 + buf[2];
    if (fn === 5 || fn === 6 || fn === 15 || fn === 16) return 8;
    return -1;
}
// Expected length of an RTU *request* (slave side).
function rtuRequestLength(buf) {
    if (buf.length < 2) return 0;
    var fn = buf[1];
    if (fn >= 1 && fn <= 6) return 8;
    if (fn === 15 || fn === 16) return buf.length < 7 ? 0 : 9 + buf[6];
    return -1;
}
function decodeRtu(frame) {
    frame = u8(frame);
    if (frame.length < 4) throw ModbusError('protocol', 'RTU frame too short');
    var c = crc16(frame, 0, frame.length - 2), got = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
    if (c !== got) throw ModbusError('crc', 'CRC mismatch (calc ' + c.toString(16) + ', got ' + got.toString(16) + ')');
    return { unit: frame[0], pdu: frame.slice(1, frame.length - 2) };
}

// ─── data types, byte / word order ───────────────────────────────────────────
function normOrder(o) { o = String(o || 'ABCD').toUpperCase(); return ORDERS.indexOf(o) >= 0 ? o : 'ABCD'; }
function regCount(type) { var t = TYPES[type]; return t ? t.regs : 1; }
// registers (as transmitted) → big-endian byte array of the value
function wordsToBytes(words, order) {
    order = normOrder(order);
    var byteSwap = order === 'BADC' || order === 'DCBA', wordSwap = order === 'CDAB' || order === 'DCBA';
    var w = words.slice();
    if (wordSwap) w.reverse();
    var out = new Uint8Array(2 * w.length);
    for (var i = 0; i < w.length; i++) {
        var hi = (w[i] >> 8) & 255, lo = w[i] & 255;
        out[2 * i] = byteSwap ? lo : hi; out[2 * i + 1] = byteSwap ? hi : lo;
    }
    return out;
}
function bytesToWords(bytes, order) {
    order = normOrder(order);
    var byteSwap = order === 'BADC' || order === 'DCBA', wordSwap = order === 'CDAB' || order === 'DCBA';
    var w = [];
    for (var i = 0; i < bytes.length; i += 2) w.push(byteSwap ? ((bytes[i + 1] << 8) | bytes[i]) : ((bytes[i] << 8) | bytes[i + 1]));
    if (wordSwap) w.reverse();
    return w;
}
// decodeValue(words | bool, type, order) → number (bool → 1 / 0)
function decodeValue(words, type, order) {
    if (type === 'bool') { var b = Array.isArray(words) ? words[0] : words; return (b === true || b === 1 || (typeof b === 'number' && b !== 0)) ? 1 : 0; }
    var t = TYPES[type];
    if (!t) throw ModbusError('config', 'Unknown data type ' + type);
    if (!words || words.length < t.regs) throw ModbusError('protocol', type + ' needs ' + t.regs + ' registers');
    var bytes = wordsToBytes(words.slice(0, t.regs), order), dv = new DataView(bytes.buffer);
    switch (type) {
        case 'int16': return dv.getInt16(0, false);
        case 'uint16': return dv.getUint16(0, false);
        case 'int32': return dv.getInt32(0, false);
        case 'uint32': return dv.getUint32(0, false);
        case 'float32': return dv.getFloat32(0, false);
        case 'float64': return dv.getFloat64(0, false);
    }
    return NaN;
}
// encodeValue(number, type, order) → registers to transmit (bool → [0|1])
function encodeValue(value, type, order) {
    if (type === 'bool') return [value ? 1 : 0];
    var t = TYPES[type];
    if (!t) throw ModbusError('config', 'Unknown data type ' + type);
    var v = +value;
    if (!isFinite(v) && type !== 'float32' && type !== 'float64') throw ModbusError('config', 'Value is not a number');
    if (t.int) {
        v = Math.round(v);
        if (v < t.min || v > t.max) throw ModbusError('config', type + ' value out of range ' + t.min + '…' + t.max + ': ' + v);
    }
    var bytes = new Uint8Array(2 * t.regs), dv = new DataView(bytes.buffer);
    switch (type) {
        case 'int16': dv.setInt16(0, v, false); break;
        case 'uint16': dv.setUint16(0, v, false); break;
        case 'int32': dv.setInt32(0, v, false); break;
        case 'uint32': dv.setUint32(0, v, false); break;
        case 'float32': dv.setFloat32(0, v, false); break;
        case 'float64': dv.setFloat64(0, v, false); break;
    }
    return bytesToWords(bytes, order);
}

// ─── scaling ─────────────────────────────────────────────────────────────────
// s = { mode:'none'|'linear'|'gain', rawMin, rawMax, engMin, engMax, gain, offset }
function scaleToEng(raw, s) {
    if (raw == null || !isFinite(raw)) return raw;
    if (!s || !s.mode || s.mode === 'none') return raw;
    if (s.mode === 'linear') {
        var r0 = +s.rawMin, r1 = +s.rawMax, e0 = +s.engMin, e1 = +s.engMax;
        if (!isFinite(r0) || !isFinite(r1) || !isFinite(e0) || !isFinite(e1) || r1 === r0) return NaN;
        return e0 + (raw - r0) * (e1 - e0) / (r1 - r0);
    }
    if (s.mode === 'gain') {
        var g = s.gain == null || s.gain === '' ? 1 : +s.gain, o = s.offset == null || s.offset === '' ? 0 : +s.offset;
        return raw * g + o;
    }
    return raw;
}
function scaleToRaw(eng, s) {
    if (eng == null || !isFinite(eng)) return eng;
    if (!s || !s.mode || s.mode === 'none') return eng;
    if (s.mode === 'linear') {
        var r0 = +s.rawMin, r1 = +s.rawMax, e0 = +s.engMin, e1 = +s.engMax;
        if (e1 === e0) return NaN;
        return r0 + (eng - e0) * (r1 - r0) / (e1 - e0);
    }
    if (s.mode === 'gain') {
        var g = s.gain == null || s.gain === '' ? 1 : +s.gain, o = s.offset == null || s.offset === '' ? 0 : +s.offset;
        return g === 0 ? NaN : (eng - o) / g;
    }
    return eng;
}

// ─── addressing ──────────────────────────────────────────────────────────────
// protocolAddress(entered, table, base) → 0-based protocol address.
// base 0: the number is the protocol address. base 1: 1-based register number;
// the classic PLC notation is accepted too (40001 / 400001 → holding 0).
function protocolAddress(entered, table, base) {
    var n = typeof entered === 'number' ? entered : parseInt(String(entered == null ? '' : entered).trim(), 10);
    if (!isInt(n) || n < 0) return NaN;
    if (+base !== 1) return n <= 65535 ? n : NaN;
    var T = TABLES[table], p = T ? T.plc : null;
    if (p != null) {
        if (n > p * 100000 && n <= p * 100000 + 65536 && String(entered).trim().length === 6) n -= p * 100000;
        else if (p > 0 && n > p * 10000 && n <= p * 10000 + 9999 && String(entered).trim().length === 5) n -= p * 10000;
    }
    n -= 1;
    return n >= 0 && n <= 65535 ? n : NaN;
}

// ─── emitter ─────────────────────────────────────────────────────────────────
function makeEmitter(target) {
    var h = {};
    target = target || {};
    target.on = function (e, f) { if (typeof f === 'function') (h[e] = h[e] || []).push(f); return target; };
    target.off = function (e, f) { var a = h[e]; if (!a) return target; var i = a.indexOf(f); if (i >= 0) a.splice(i, 1); return target; };
    target.emit = function (e, arg) {
        var a = h[e]; if (!a) return;
        a.slice().forEach(function (f) { try { f(arg); } catch (err) { if (typeof console !== 'undefined') console.warn('[modbus] ' + e + ' handler', err); } });
    };
    target._clearHandlers = function () { h = {}; };
    return target;
}

// ─── transports ──────────────────────────────────────────────────────────────
// Interface: { kind, framing:'tcp'|'rtu', open() → Promise, send(Uint8Array), close(),
//              isOpen(), on('data', fn(Uint8Array)), on('close', fn(reason)) }

// (a) WebSocket bridge — tools/modbus-bridge/modbus-bridge.js. Binary WS messages
// carry complete Modbus TCP ADUs; the bridge sends {"type":"open"} (text) once its
// TCP connection is up, {"type":"error","message"} on failure.
function webSocketTransport(o) {
    o = o || {};
    var T = makeEmitter({ kind: 'ws', framing: 'tcp' }), ws = null, open = false;
    T.url = function () {
        var base = String(o.url || 'ws://127.0.0.1:8502').replace(/\/+$/, '');
        return base + '/modbus?host=' + encodeURIComponent(o.host || '') + '&port=' + encodeURIComponent(o.port || 502);
    };
    T.open = function () {
        return new Promise(function (resolve, reject) {
            var WS = o.WebSocket || G.WebSocket;
            if (typeof WS !== 'function') { reject(ModbusError('transport', 'WebSocket is not available in this browser')); return; }
            var settled = false;
            function fail(msg) { if (!settled) { settled = true; reject(ModbusError('transport', msg)); } }
            try { ws = new WS(T.url()); } catch (e) { fail('Bridge URL rejected: ' + (e && e.message)); return; }
            ws.binaryType = 'arraybuffer';
            ws.onmessage = function (ev) {
                var d = ev.data;
                if (typeof d === 'string') {
                    var m = null; try { m = JSON.parse(d); } catch (e) {}
                    if (m && m.type === 'open') { open = true; if (!settled) { settled = true; resolve(T); } }
                    else if (m && m.type === 'error') { fail('Bridge: ' + (m.message || 'error')); T.emit('error', m.message); }
                    return;
                }
                var bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : (d && d.buffer ? new Uint8Array(d.buffer, d.byteOffset || 0, d.byteLength) : null);
                if (bytes) T.emit('data', bytes);
            };
            ws.onerror = function () { fail('Cannot reach the Modbus bridge at ' + (o.url || 'ws://127.0.0.1:8502') + ' — is it running? (Or it refused this page: "Check bridge" in the setup guide tells which.)'); };
            ws.onclose = function (ev) {
                var was = open; open = false;
                fail('Bridge closed the connection' + (ev && ev.reason ? ': ' + ev.reason : (ev && ev.code ? ' (' + ev.code + ')' : '')));
                if (was) T.emit('close', ev && ev.reason || 'closed');
            };
        });
    };
    T.send = function (bytes) { if (!ws || !open) throw ModbusError('closed', 'Bridge connection is not open'); ws.send(u8(bytes)); };
    T.close = function () { open = false; if (ws) { try { ws.onclose = null; ws.close(1000, 'client close'); } catch (e) {} } ws = null; };
    T.isOpen = function () { return open; };
    return T;
}

// (b) Web Serial (Modbus RTU). open() must run inside a user gesture the first
// time (navigator.serial.requestPort); later sessions reuse a granted port.
function webSerialTransport(o) {
    o = o || {};
    var T = makeEmitter({ kind: 'serial', framing: 'rtu' }), port = null, reader = null, open = false, closing = false;
    T.supported = function () { return !!(G.navigator && G.navigator.serial && typeof G.navigator.serial.requestPort === 'function'); };
    T.open = function () {
        if (!T.supported()) return Promise.reject(ModbusError('transport', 'Web Serial needs Chrome or Edge on a desktop (served over https or localhost)'));
        var S = G.navigator.serial;
        var pick = o.port ? Promise.resolve(o.port) : Promise.resolve(typeof S.getPorts === 'function' ? S.getPorts() : []).then(function (ports) {
            var match = (ports || []).filter(function (p) {
                if (!o.usbVendorId) return true;
                var info = p.getInfo ? p.getInfo() : {};
                return info.usbVendorId === o.usbVendorId && (!o.usbProductId || info.usbProductId === o.usbProductId);
            });
            return match.length ? match[0] : S.requestPort();
        });
        return pick.then(function (p) {
            port = p;
            return port.open({ baudRate: +o.baud || 19200, dataBits: +o.dataBits || 8, stopBits: +o.stopBits || 1,
                parity: /^(none|even|odd)$/.test(o.parity) ? o.parity : 'even', bufferSize: 1024, flowControl: 'none' });
        }).then(function () {
            open = true; closing = false;
            try { var info = port.getInfo ? port.getInfo() : {}; T.portInfo = info; } catch (e) {}
            pump();
            return T;
        }, function (e) { throw ModbusError('transport', 'Serial port: ' + (e && e.message || e)); });
    };
    function pump() {
        if (!port || !port.readable) return;
        reader = port.readable.getReader();
        reader.read().then(function step(r) {
            if (r.done || closing) { try { reader.releaseLock(); } catch (e) {} return; }
            if (r.value && r.value.length) T.emit('data', new Uint8Array(r.value));
            return reader.read().then(step);
        }).catch(function (e) {
            if (!closing) { open = false; T.emit('close', 'Serial read failed: ' + (e && e.message || e)); }
        });
    }
    T.send = function (bytes) {
        if (!open || !port || !port.writable) throw ModbusError('closed', 'Serial port is not open');
        var w = port.writable.getWriter();
        return w.write(u8(bytes)).then(function () { w.releaseLock(); }, function (e) { try { w.releaseLock(); } catch (x) {} throw ModbusError('transport', 'Serial write failed: ' + (e && e.message)); });
    };
    T.close = function () {
        closing = true; open = false;
        var p = port; port = null;
        var done = function () { if (p) { try { return Promise.resolve(p.close()).catch(function () {}); } catch (e) {} } };
        if (reader) { try { return Promise.resolve(reader.cancel()).then(done, done); } catch (e) {} }
        return Promise.resolve(done());
    };
    T.isOpen = function () { return open; };
    return T;
}

// (c) iOS native TCP — Capacitor plugin "ModbusTcp" (ios-app/ios/App/App/ModbusTcpPlugin.swift):
//   connect({host, port, timeoutMs}) → {id};  send({id, data:base64});  disconnect({id});
//   events 'data' {id, data:base64} and 'closed' {id, reason}.
var _nativePlugin = null;
function nativeTcpPlugin() {
    var C = G.Capacitor;
    if (!C) return null;
    if (_nativePlugin) return _nativePlugin;
    try {
        if (C.Plugins && C.Plugins.ModbusTcp) _nativePlugin = C.Plugins.ModbusTcp;
        else if (typeof C.registerPlugin === 'function' && (typeof C.isPluginAvailable !== 'function' || C.isPluginAvailable('ModbusTcp'))) _nativePlugin = C.registerPlugin('ModbusTcp');
    } catch (e) { _nativePlugin = null; }
    return _nativePlugin;
}
function nativeTcpAvailable() {
    var C = G.Capacitor;
    try { return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform() && nativeTcpPlugin()); } catch (e) { return false; }
}
function nativeTcpTransport(o) {
    o = o || {};
    var T = makeEmitter({ kind: 'ios', framing: 'tcp' }), id = null, open = false, subs = [];
    T.open = function () {
        var P = o.plugin || nativeTcpPlugin();
        if (!P) return Promise.reject(ModbusError('transport', 'Native TCP is only available in the iOS app'));
        T._P = P;
        return Promise.resolve(P.connect({ host: String(o.host || ''), port: +o.port || 502, timeoutMs: +o.timeoutMs || 3000 })).then(function (r) {
            id = r && r.id; open = true;
            function sub(evt, fn) { try { Promise.resolve(P.addListener(evt, fn)).then(function (hd) { if (hd) subs.push(hd); }); } catch (e) {} }
            sub('data', function (ev) { if (ev && ev.id === id && ev.data) T.emit('data', b64decode(ev.data)); });
            sub('closed', function (ev) { if (ev && ev.id === id) { open = false; T.emit('close', ev.reason || 'closed'); } });
            return T;
        }, function (e) { throw ModbusError('transport', 'TCP connect to ' + o.host + ':' + (o.port || 502) + ' failed: ' + (e && e.message || e)); });
    };
    T.send = function (bytes) {
        if (!open) throw ModbusError('closed', 'TCP connection is not open');
        return Promise.resolve(T._P.send({ id: id, data: b64encode(bytes) })).catch(function (e) { throw ModbusError('transport', 'TCP send failed: ' + (e && e.message || e)); });
    };
    T.close = function () {
        open = false;
        subs.forEach(function (hd) { try { hd.remove(); } catch (e) {} }); subs = [];
        if (T._P && id) { try { return Promise.resolve(T._P.disconnect({ id: id })).catch(function () {}); } catch (e) {} }
        return Promise.resolve();
    };
    T.isOpen = function () { return open; };
    return T;
}

// (d) Simulator transport → in-browser virtual slave. Replies on a microtask
// (never a timer). opts.drop (0-1 or true) drops replies to exercise timeouts.
function simTransport(o) {
    o = o || {};
    var T = makeEmitter({ kind: 'sim', framing: o.framing === 'rtu' ? 'rtu' : 'tcp' }), open = false;
    T.open = function () {
        var slave = typeof o.slave === 'function' ? o.slave() : o.slave;
        if (!slave || typeof slave.handleFrame !== 'function') return Promise.reject(ModbusError('transport', 'Virtual slave is not available'));
        T.slave = slave; open = true;
        return Promise.resolve(T);
    };
    T.send = function (bytes) {
        if (!open) throw ModbusError('closed', 'Simulator connection is not open');
        var req = u8(bytes).slice();
        Promise.resolve().then(function () {
            if (!open) return;
            if (o.drop === true || (typeof o.drop === 'number' && Math.random() < o.drop)) return;
            var res = T.slave.handleFrame(req, T.framing);
            if (res && res.length) {
                if (o.corrupt && T.framing === 'rtu') { res = res.slice(); res[res.length - 1] ^= 0xFF; }
                T.emit('data', res);
            }
        });
    };
    T.close = function () { open = false; return Promise.resolve(); };
    T.isOpen = function () { return open; };
    return T;
}

// ─── client (master) ─────────────────────────────────────────────────────────
// createClient(transport, {timeout ms, retries, framing}) — one request in flight.
function createClient(transport, opts) {
    opts = opts || {};
    var framing = opts.framing || transport.framing || 'tcp';
    var timeout = Math.max(50, +opts.timeout || 1000), retries = Math.max(0, Math.min(5, opts.retries == null ? 1 : +opts.retries));
    var C = makeEmitter({}), queue = [], cur = null, rx = new Uint8Array(0), tid = 0, closed = false;
    var stats = { tx: 0, rx: 0, timeouts: 0, retries: 0, exceptions: 0, errors: 0, lastRttMs: null };
    var now = opts.now || function () { return Date.now(); };
    var setT = opts.setTimeout || function (f, ms) { return G.setTimeout(f, ms); };
    var clrT = opts.clearTimeout || function (id) { G.clearTimeout(id); };

    function onData(bytes) {
        if (!cur) { rx = new Uint8Array(0); return; }            // unsolicited / late — drop
        rx = concatBytes(rx, u8(bytes));
        if (framing === 'tcp') {
            var d = decodeTcpStream(rx);
            rx = d.rest;
            for (var i = 0; i < d.frames.length; i++) {
                var f = d.frames[i];
                if (cur && f.tid === cur.tid && f.unit === (cur.unit & 255)) { finish(null, f.pdu); return; }
            }
            if (d.error) stats.errors++;
        } else {
            var len = rtuResponseLength(rx);
            if (len < 0) { rx = new Uint8Array(0); return; }
            if (len === 0 || rx.length < len) return;
            var frame = rx.slice(0, len); rx = rx.slice(len);
            var dec;
            try { dec = decodeRtu(frame); } catch (e) { retryOrFail(e); return; }
            if (dec.unit !== (cur.unit & 255)) return;             // another node's reply
            finish(null, dec.pdu);
        }
    }
    function onClose(reason) {
        var err = ModbusError('closed', 'Connection closed' + (reason ? ': ' + reason : ''));
        if (cur) finish(err);
        failAll(err);
        C.emit('close', reason);
    }
    transport.on('data', onData);
    transport.on('close', onClose);

    function failAll(err) { var q = queue; queue = []; q.forEach(function (r) { r.reject(err); }); }
    function send() {
        if (!cur) return;
        tid = tid >= 65535 ? 1 : tid + 1;
        cur.tid = tid; cur.t0 = now(); rx = new Uint8Array(0);
        var frame = framing === 'tcp' ? encodeTcp(tid, cur.unit, cur.pdu) : encodeRtu(cur.unit, cur.pdu);
        cur.timer = setT(onTimeout, timeout);
        stats.tx++;
        try {
            var p = transport.send(frame);
            if (p && typeof p.then === 'function') p.then(null, function (e) { if (cur && cur.tid === tid) finish(e); });
        } catch (e) { finish(e); }
    }
    function onTimeout() {
        if (!cur) return;
        cur.timer = null;
        stats.timeouts++;
        retryOrFail(ModbusError('timeout', 'No response from unit ' + cur.unit + ' within ' + timeout + ' ms'));
    }
    function retryOrFail(err) {
        if (!cur) return;
        if (cur.timer) { clrT(cur.timer); cur.timer = null; }
        if (cur.attempt < retries && (err.kind === 'timeout' || err.kind === 'crc')) { cur.attempt++; stats.retries++; send(); return; }
        finish(err);
    }
    function finish(err, pdu) {
        var r = cur; if (!r) return;
        if (r.timer) { clrT(r.timer); r.timer = null; }
        cur = null;
        if (err) { if (err.kind !== 'timeout') stats.errors++; r.reject(err); }
        else {
            stats.rx++; stats.lastRttMs = now() - r.t0;
            if (pdu[0] & 0x80) stats.exceptions++;
            r.resolve(pdu);
        }
        pump();
    }
    function pump() {
        if (cur || closed || !queue.length) return;
        cur = queue.shift();
        send();
    }
    C.request = function (unit, pdu) {
        return new Promise(function (resolve, reject) {
            if (closed) { reject(ModbusError('closed', 'Client is closed')); return; }
            if (typeof transport.isOpen === 'function' && !transport.isOpen()) { reject(ModbusError('closed', 'Connection is not open')); return; }
            queue.push({ unit: +unit & 255, pdu: u8(pdu), attempt: 0, resolve: resolve, reject: reject });
            pump();
        });
    };
    function call(unit, pdu) { return C.request(unit, pdu).then(function (res) { return parseResponse(pdu, res); }); }
    C.readCoils = function (unit, addr, qty) { return call(unit, buildReadPdu(1, addr, qty)).then(function (r) { return r.bits; }); };
    C.readDiscreteInputs = function (unit, addr, qty) { return call(unit, buildReadPdu(2, addr, qty)).then(function (r) { return r.bits; }); };
    C.readHoldingRegisters = function (unit, addr, qty) { return call(unit, buildReadPdu(3, addr, qty)).then(function (r) { return r.words; }); };
    C.readInputRegisters = function (unit, addr, qty) { return call(unit, buildReadPdu(4, addr, qty)).then(function (r) { return r.words; }); };
    C.read = function (unit, table, addr, qty) {
        var T = TABLES[table]; if (!T) return Promise.reject(ModbusError('config', 'Unknown table ' + table));
        return call(unit, buildReadPdu(T.read, addr, qty)).then(function (r) { return T.bits ? r.bits : r.words; });
    };
    C.writeCoil = function (unit, addr, on) { return call(unit, buildWriteCoilPdu(addr, on)); };
    C.writeRegister = function (unit, addr, word) { return call(unit, buildWriteRegisterPdu(addr, word)); };
    C.writeCoils = function (unit, addr, bits) { return call(unit, buildWriteCoilsPdu(addr, bits)); };
    C.writeRegisters = function (unit, addr, words) { return call(unit, buildWriteRegistersPdu(addr, words)); };
    C.stats = function () { var o = {}; for (var k in stats) o[k] = stats[k]; o.queued = queue.length + (cur ? 1 : 0); return o; };
    C.pending = function () { return queue.length + (cur ? 1 : 0); };
    C.close = function () {
        if (closed) return Promise.resolve();
        closed = true;
        var err = ModbusError('closed', 'Client closed');
        if (cur) { if (cur.timer) clrT(cur.timer); var r = cur; cur = null; r.reject(err); }
        failAll(err);
        transport.off('data', onData); transport.off('close', onClose);
        try { return Promise.resolve(transport.close()).catch(function () {}); } catch (e) { return Promise.resolve(); }
    };
    C.transport = transport;
    C.framing = framing;
    return C;
}

// ─── virtual slave (server) ──────────────────────────────────────────────────
// createSlave({unit, sizes:{coil, discrete, holding, input}, onRequest(fn, addr, qty)})
function createSlave(o) {
    o = o || {};
    var sz = o.sizes || {};
    var S = {
        unit: o.unit == null ? 1 : +o.unit,
        coil: new Uint8Array(+sz.coil || 2000), discrete: new Uint8Array(+sz.discrete || 2000),
        holding: new Uint16Array(+sz.holding || 2000), input: new Uint16Array(+sz.input || 2000),
        requests: 0, onRequest: o.onRequest || null, onWrite: o.onWrite || null
    };
    function exc(fn, code) { return new Uint8Array([fn | 0x80, code]); }
    S.handlePdu = function (pdu) {
        pdu = u8(pdu);
        var fn = pdu[0], addr, qty, i, mem;
        S.requests++;
        if (!(fn === 1 || fn === 2 || fn === 3 || fn === 4 || fn === 5 || fn === 6 || fn === 15 || fn === 16)) return exc(fn, 1);
        if (pdu.length < 5) return exc(fn, 3);
        addr = (pdu[1] << 8) | pdu[2]; qty = (pdu[3] << 8) | pdu[4];
        if (S.onRequest) { try { S.onRequest(fn, addr, qty); } catch (e) {} }
        if (fn === 1 || fn === 2) {
            if (qty < 1 || qty > LIMITS.readBits) return exc(fn, 3);
            mem = fn === 1 ? S.coil : S.discrete;
            if (addr + qty > mem.length) return exc(fn, 2);
            var nb = Math.ceil(qty / 8), out = new Uint8Array(2 + nb);
            out[0] = fn; out[1] = nb;
            for (i = 0; i < qty; i++) if (mem[addr + i]) out[2 + (i >> 3)] |= 1 << (i & 7);
            return out;
        }
        if (fn === 3 || fn === 4) {
            if (qty < 1 || qty > LIMITS.readRegs) return exc(fn, 3);
            mem = fn === 3 ? S.holding : S.input;
            if (addr + qty > mem.length) return exc(fn, 2);
            var r = new Uint8Array(2 + 2 * qty);
            r[0] = fn; r[1] = 2 * qty;
            for (i = 0; i < qty; i++) { r[2 + 2 * i] = mem[addr + i] >> 8; r[3 + 2 * i] = mem[addr + i] & 255; }
            return r;
        }
        if (fn === 5) {
            var v = (pdu[3] << 8) | pdu[4];
            if (v !== 0xFF00 && v !== 0x0000) return exc(fn, 3);
            if (addr >= S.coil.length) return exc(fn, 2);
            S.coil[addr] = v === 0xFF00 ? 1 : 0;
            if (S.onWrite) { try { S.onWrite('coil', addr, 1); } catch (e) {} }
            return pdu.slice(0, 5);
        }
        if (fn === 6) {
            if (addr >= S.holding.length) return exc(fn, 2);
            S.holding[addr] = (pdu[3] << 8) | pdu[4];
            if (S.onWrite) { try { S.onWrite('holding', addr, 1); } catch (e) {} }
            return pdu.slice(0, 5);
        }
        var bc = pdu[5];
        if (fn === 15) {
            if (qty < 1 || qty > LIMITS.writeCoils || bc !== Math.ceil(qty / 8) || pdu.length !== 6 + bc) return exc(fn, 3);
            if (addr + qty > S.coil.length) return exc(fn, 2);
            for (i = 0; i < qty; i++) S.coil[addr + i] = (pdu[6 + (i >> 3)] >> (i & 7)) & 1;
            if (S.onWrite) { try { S.onWrite('coil', addr, qty); } catch (e) {} }
            return pdu.slice(0, 5);
        }
        // fn 16
        if (qty < 1 || qty > LIMITS.writeRegs || bc !== 2 * qty || pdu.length !== 6 + bc) return exc(fn, 3);
        if (addr + qty > S.holding.length) return exc(fn, 2);
        for (i = 0; i < qty; i++) S.holding[addr + i] = (pdu[6 + 2 * i] << 8) | pdu[7 + 2 * i];
        if (S.onWrite) { try { S.onWrite('holding', addr, qty); } catch (e) {} }
        return pdu.slice(0, 5);
    };
    // handleFrame(adu, 'tcp'|'rtu') → response ADU or null (no reply)
    S.handleFrame = function (adu, framing) {
        adu = u8(adu);
        if (framing === 'rtu') {
            var dec; try { dec = decodeRtu(adu); } catch (e) { return null; }       // bad CRC → silent (spec)
            if (dec.unit === 0) { S.handlePdu(dec.pdu); return null; }              // broadcast: act, no reply
            if (dec.unit !== S.unit) return null;
            return encodeRtu(S.unit, S.handlePdu(dec.pdu));
        }
        var d = decodeTcpStream(adu);
        if (!d.frames.length) return null;
        var f = d.frames[0];
        if (f.unit !== S.unit && f.unit !== 255) return null;
        return encodeTcp(f.tid, f.unit, S.handlePdu(f.pdu));
    };
    S.setValue = function (table, addr, type, order, value) {
        if (table === 'coil' || table === 'discrete') { S[table][addr] = value ? 1 : 0; return; }
        var w = encodeValue(value, type, order);
        for (var i = 0; i < w.length; i++) S[table][addr + i] = w[i];
    };
    S.getValue = function (table, addr, type, order) {
        if (table === 'coil' || table === 'discrete') return S[table][addr] ? 1 : 0;
        var n = regCount(type), w = [];
        for (var i = 0; i < n; i++) w.push(S[table][addr + i]);
        return decodeValue(w, type, order);
    };
    return S;
}

// ─── public ──────────────────────────────────────────────────────────────────
M.VERSION = '1.0.0';
M.FC = FC; M.LIMITS = LIMITS; M.EXCEPTIONS = EXCEPTIONS; M.TABLES = TABLES; M.TYPES = TYPES; M.ORDERS = ORDERS;
M.ModbusError = ModbusError; M.exceptionText = exceptionText;
M.crc16 = crc16; M.hex = hex; M.fromHex = fromHex; M.b64encode = b64encode; M.b64decode = b64decode;
M.buildReadPdu = buildReadPdu; M.buildWriteCoilPdu = buildWriteCoilPdu; M.buildWriteRegisterPdu = buildWriteRegisterPdu;
M.buildWriteCoilsPdu = buildWriteCoilsPdu; M.buildWriteRegistersPdu = buildWriteRegistersPdu; M.parseResponse = parseResponse;
M.encodeTcp = encodeTcp; M.decodeTcpStream = decodeTcpStream;
M.encodeRtu = encodeRtu; M.decodeRtu = decodeRtu; M.rtuResponseLength = rtuResponseLength; M.rtuRequestLength = rtuRequestLength;
M.normOrder = normOrder; M.regCount = regCount; M.wordsToBytes = wordsToBytes; M.bytesToWords = bytesToWords;
M.decodeValue = decodeValue; M.encodeValue = encodeValue; M.scaleToEng = scaleToEng; M.scaleToRaw = scaleToRaw;
M.protocolAddress = protocolAddress; M.makeEmitter = makeEmitter;
M.transports = { webSocket: webSocketTransport, webSerial: webSerialTransport, nativeTcp: nativeTcpTransport, sim: simTransport };
M.nativeTcpAvailable = nativeTcpAvailable;
M.webSerialSupported = function () { return !!(G.navigator && G.navigator.serial && typeof G.navigator.serial.requestPort === 'function'); };
M.createClient = createClient;
M.createSlave = createSlave;
})();

// ─── END 60-modbus-core ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 61-modbus-station ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 61-modbus-station.js — Modbus configuration, polling station, alarms,
// app-variable links and the built-in virtual slave (Round-10, "Live Data")
// -----------------------------------------------------------------------------
// Extends window.WTS_modbus (60-modbus-core.js):
//   VARS / varsFromState / applyVarsToState   well-test variables (WTS_sim snapshot paths)
//   UNITS / toCanonical / fromCanonical       tag engineering unit → app field unit
//   defaultConfig / demoConfig / normalizeConfig / getConfig / saveConfig / setPaused
//   tagsToCsv / tagsFromCsv / planBlocks / alarmLevel / createAlarmManager
//   createStation(config, env)   polling scheduler (timers only while started)
//   acquire(owner) / release(owner) / station()   shared station for the pages
//   virtualSlave() / DEMO_MAP    in-browser Modbus slave driven by WTS_sim / waveforms / manual
//   publishSamples(batch)        → window.WTS_historian.record(batch) + 'wts:modbus-samples'
//   getTags()                    tag list for other modules; 'wts:modbus-config-changed' on save
//
// Storage: localStorage 'wts_modbus_config' (travels in project files — 29 snapshots every wts_* key).
// Load-time rule: no DOM, timers, storage writes or listeners at load.
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
var M = G.WTS_modbus = G.WTS_modbus || {};
if (!M.createClient) return;     // core missing — nothing to extend

var STORE_KEY = 'wts_modbus_config';
var TRANSPORTS = { sim: 'Built-in simulator (virtual slave)', ws: 'Modbus TCP via WebSocket bridge', serial: 'Modbus RTU via Web Serial', ios: 'Modbus TCP (iOS app, native)' };
var POLL_MIN = 100, POLL_MAX = 60000;

function isNum(x) { return typeof x === 'number' && isFinite(x); }
function num(x, d) { var v = (x === '' || x == null) ? NaN : +x; return isFinite(v) ? v : d; }
function optNum(x) { var v = (x === '' || x == null) ? NaN : +x; return isFinite(v) ? v : null; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function now() { return Date.now(); }
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function uid(p) { return p + '_' + Math.floor(Math.random() * 0x7fffffff).toString(36) + (now() % 100000).toString(36); }
function str(x, max) { return String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, ' ').slice(0, max || 80); }
function doc() { return (typeof document !== 'undefined' && document) ? document : null; }
function fire(type, detail) {
    var d = doc();
    try { if (d && typeof d.dispatchEvent === 'function' && typeof CustomEvent === 'function') d.dispatchEvent(new CustomEvent(type, { detail: detail })); } catch (e) {}
}
function ls() { try { return G.localStorage || null; } catch (e) { return null; } }

// ─── unit conversion: tag engineering unit → app canonical (field) unit ──────
// Factors: NIST SP 811 (2008) Appendix B — 1 psi = 6.894 757 kPa; 1 bar = 100 kPa;
// 1 ft³ = 0.028 316 846 592 m³ (exact); 1 bbl = 42 US gal = 0.158 987 294 928 m³ (exact);
// 1 kgf/cm² = 98.0665 kPa; standard atmosphere 101.325 kPa = 14.695 95 psi.
// Gas volumes: only the volume factor is applied — the 60 °F / 14.696 psia vs
// 15 °C / 101.325 kPa base-condition difference (≈ 0.1-0.2 %) is NOT applied.
var KPA_PSI = 6.894757293168, ATM_PSI = 101.325 / KPA_PSI, FT3 = 0.028316846592, BBL = 0.158987294928, MMCF_M3 = 1e6 * FT3;
var UNITS = {
    pressureG: { canon: 'psig', defs: [
        [['psig', 'psi', 'lbf/in2', 'lb/in2'], 1, 0],
        [['psia'], 1, -ATM_PSI],
        [['kpa', 'kpag', 'kpa(g)'], 1 / KPA_PSI, 0],
        [['kpaa', 'kpa(a)'], 1 / KPA_PSI, -ATM_PSI],
        [['mpa', 'mpag', 'mpa(g)'], 1000 / KPA_PSI, 0],
        [['bar', 'barg', 'bar(g)'], 100 / KPA_PSI, 0],
        [['bara', 'bar(a)'], 100 / KPA_PSI, -ATM_PSI],
        [['kg/cm2', 'kgf/cm2', 'kg/cm²', 'kgf/cm²'], 98.0665 / KPA_PSI, 0]] },
    temperature: { canon: '°F', defs: [
        [['°f', 'f', 'degf', 'deg f'], 1, 0],
        [['°c', 'c', 'degc', 'deg c'], 9 / 5, 32],
        [['k', 'kelvin'], 9 / 5, 32 - 273.15 * 9 / 5]] },
    gasRate: { canon: 'MMSCFD', defs: [
        [['mmscfd', 'mmscf/d', 'mmcfd'], 1, 0],
        [['mscfd', 'mscf/d', 'kscfd', 'mcfd'], 1e-3, 0],
        [['scfd', 'scf/d'], 1e-6, 0],
        [['scfh', 'scf/h'], 24e-6, 0],
        [['e3m3/d', '10³ m³/d', '10^3 m3/d', 'km3/d', '1000 m3/d'], 1000 / MMCF_M3, 0],
        [['m3/d', 'sm3/d', 'm³/d', 'sm³/d'], 1 / MMCF_M3, 0],
        [['m3/h', 'sm3/h', 'm³/h', 'sm³/h'], 24 / MMCF_M3, 0]] },
    liquidRate: { canon: 'bbl/d', defs: [
        [['bpd', 'bbl/d', 'stb/d', 'stbd', 'bopd', 'bwpd', 'blpd'], 1, 0],
        [['m3/d', 'm³/d', 'sm3/d'], 1 / BBL, 0],
        [['m3/h', 'm³/h'], 24 / BBL, 0],
        [['l/min', 'lpm'], 1440 / (1000 * BBL), 0],
        [['gpm', 'usgpm', 'gal/min'], 1440 / 42, 0],
        [['bph', 'bbl/h'], 24, 0]] },
    percent: { canon: '%', defs: [[['%', 'pct', 'percent'], 1, 0], [['fraction', 'frac', '0-1'], 100, 0]] },
    choke: { canon: '1/64 in', defs: [[['1/64 in', '1/64in', '/64', '64ths', '64th'], 1, 0], [['in', 'inch'], 64, 0], [['mm'], 64 / 25.4, 0]] },
    bool: { canon: '', defs: [[[''], 1, 0]] }
};
function normUnit(u) { return String(u == null ? '' : u).trim().toLowerCase().replace(/\s+/g, ' '); }
function unitDef(unit, cat) {
    var C = UNITS[cat]; if (!C) return null;
    var u = normUnit(unit);
    if (u === '' || u === normUnit(C.canon)) return [null, 1, 0];
    for (var i = 0; i < C.defs.length; i++) if (C.defs[i][0].indexOf(u) >= 0) return C.defs[i];
    return null;
}
// toCanonical(value, unit, cat) → value in the app field unit, or NaN when the unit does not fit the category.
function toCanonical(v, unit, cat) {
    if (v == null || !isNum(v)) return v == null ? null : NaN;
    if (!cat || cat === 'bool') return v;
    var d = unitDef(unit, cat);
    return d ? v * d[1] + d[2] : NaN;
}
function fromCanonical(v, unit, cat) {
    if (v == null || !isNum(v)) return v;
    if (!cat || cat === 'bool') return v;
    var d = unitDef(unit, cat);
    return d ? (v - d[2]) / d[1] : NaN;
}
function unitFits(unit, cat) { return !cat || cat === 'bool' || !!unitDef(unit, cat); }

// ─── well-test variables (paths into the WTS_sim snapshot, 31-wts-sim.js) ────
function g(o, path) { try { var x = o; for (var i = 0; i < path.length; i++) x = x[path[i]]; return x; } catch (e) { return undefined; } }
function nz(x) { return isNum(x) ? x : null; }
function pct(x) { return isNum(x) ? x * 100 : null; }
function bool(x) { return x === true ? 1 : x === false ? 0 : null; }
function segScale(s, first, last, ratio) {
    for (var i = first; i <= last; i++) if (s.segs && s.segs[i]) { s.segs[i].vel = Math.max(0, (s.segs[i].vel || 0) * ratio); s.segs[i].flowing = s.segs[i].vel > 0.01; }
}
function lineSet(s, name, ratio, on) {
    var L = s.lines && s.lines[name]; if (!L) return;
    if (ratio != null) { L.q = Math.max(0, (L.q || 0) * ratio); L.vel = Math.max(0, (L.vel || 0) * ratio); }
    if (on != null) L.active = !!on;
}
function ratioOf(v, base) { return isNum(base) && base > 1e-9 ? Math.max(0, v / base) : (v > 0 ? 1 : 0); }
var VARS = [
    { key: 'whp', label: 'Wellhead pressure (WHP)', group: 'Wellhead', cat: 'pressureG', min: 0, max: 5000,
      get: function (s) { return nz(g(s, ['nodes', 'wellhead', 'P'])); },
      set: function (s, v) { s.nodes.wellhead.P = v; s.nodes.esd.P = v; if (s.inputs) s.inputs.Pwh = v; if (s.segs[0]) s.segs[0].P0 = v; } },
    { key: 'wht', label: 'Wellhead temperature (WHT)', group: 'Wellhead', cat: 'temperature', min: 0, max: 300,
      get: function (s) { return nz(g(s, ['nodes', 'wellhead', 'T'])); },
      set: function (s, v) { s.nodes.wellhead.T = v; s.nodes.esd.T = v; if (s.inputs) s.inputs.Twh = v; } },
    { key: 'bhp', label: 'Bottom-hole gauge pressure (BHP)', group: 'Downhole gauge', cat: 'pressureG', min: 0, max: 10000,
      get: function (s) { return nz(g(s, ['downhole', 'P'])); }, set: function (s, v) { s.downhole = s.downhole || {}; s.downhole.P = v; } },
    { key: 'bht', label: 'Bottom-hole gauge temperature (BHT)', group: 'Downhole gauge', cat: 'temperature', min: 0, max: 400,
      get: function (s) { return nz(g(s, ['downhole', 'T'])); }, set: function (s, v) { s.downhole = s.downhole || {}; s.downhole.T = v; } },
    { key: 'esd_open', label: 'ESD valve SDV-101 open', group: 'Wellhead', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['esd', 'open'])); },
      set: function (s, v) { var o = !!v; s.esd.open = o; s.esd.travel = o ? 1 : 0; s.esd.moving = false; if (!o) { s.f = 0; s.fInst = 0; segScale(s, 0, 4, 0); ['wh_esd', 'esd_choke', 'choke_heater', 'heater_sep', 'sep_flare'].forEach(function (n) { lineSet(s, n, 0, false); }); } } },
    { key: 'esd_tripped', label: 'ESD tripped (shutdown)', group: 'Wellhead', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['esd', 'tripped'])); }, set: function (s, v) { s.esd.tripped = !!v; } },
    { key: 'choke_bean', label: 'Choke size', group: 'Choke', cat: 'choke', min: 0, max: 128,
      get: function (s) { var b = g(s, ['nodes', 'choke', 'bean']); return nz(isNum(b) && b > 0 ? b : g(s, ['inputs', 'bean'])); },
      set: function (s, v) { s.nodes.choke.bean = v; if (s.inputs) s.inputs.bean = v; } },
    { key: 'choke_dn_p', label: 'Choke downstream pressure', group: 'Choke', cat: 'pressureG', min: 0, max: 3000,
      get: function (s) { return nz(g(s, ['nodes', 'choke', 'P'])); }, set: function (s, v) { s.nodes.choke.P = v; if (s.segs[2]) s.segs[2].P0 = v; } },
    { key: 'heater_t', label: 'Heater outlet temperature', group: 'Heater', cat: 'temperature', min: 0, max: 300,
      get: function (s) { return nz(g(s, ['nodes', 'heater', 'T'])); }, set: function (s, v) { s.nodes.heater.T = v; } },
    { key: 'heater_bypass', label: 'Heater bypass open', group: 'Heater', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['nodes', 'heater', 'bypass'])); }, set: function (s, v) { s.nodes.heater.bypass = !!v; if (s.inputs) s.inputs.bypass = !!v; } },
    { key: 'sep_p', label: 'Separator pressure', group: 'Separator', cat: 'pressureG', min: 0, max: 1440,
      get: function (s) { return nz(g(s, ['sep', 'P'])); },
      set: function (s, v) { s.sep.P = v; s.nodes.separator.P = v; if (s.segs[3]) s.segs[3].Pout = v; if (s.segs[4]) s.segs[4].P0 = v; } },
    { key: 'sep_t', label: 'Separator temperature', group: 'Separator', cat: 'temperature', min: 0, max: 300,
      get: function (s) { return nz(g(s, ['sep', 'T'])); }, set: function (s, v) { s.sep.T = v; s.nodes.separator.T = v; } },
    { key: 'sep_liq_lvl', label: 'Separator liquid level (inlet compartment)', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'c1', 'fracL'])); }, set: function (s, v) { s.sep.c1.fracL = clamp(v / 100, 0, 1); } },
    { key: 'sep_int_lvl', label: 'Separator water interface level', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'c1', 'fracW'])); }, set: function (s, v) { s.sep.c1.fracW = clamp(v / 100, 0, 1); } },
    { key: 'sep_oil_lvl', label: 'Separator oil bucket level', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'bucket', 'frac'])); }, set: function (s, v) { s.sep.bucket.frac = clamp(v / 100, 0, 1); } },
    { key: 'lcv_oil', label: 'Oil dump valve LCV-102 position', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'oilDump', 'x'])); }, set: function (s, v) { s.sep.oilDump.x = clamp(v / 100, 0, 1); } },
    { key: 'lcv_water', label: 'Water dump valve LCV-101 position', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'waterDump', 'x'])); }, set: function (s, v) { s.sep.waterDump.x = clamp(v / 100, 0, 1); } },
    { key: 'pcv_sep', label: 'Separator gas PCV-101 opening', group: 'Separator', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['sep', 'pcv', 'u'])); }, set: function (s, v) { s.sep.pcv.u = clamp(v / 100, 0, 1); } },
    { key: 'gas_rate', label: 'Gas rate', group: 'Rates', cat: 'gasRate', min: 0, max: 50,
      get: function (s) { return nz(g(s, ['rates', 'gas_mmscfd'])); },
      set: function (s, v) {
          var r = ratioOf(v, s.rates.gas_mmscfd); s.rates.gas_mmscfd = v; if (s.sep) { s.sep.gasIn_mmscfd = v; s.sep.gasOut_mmscfd = v; }
          segScale(s, 0, 4, r); ['wh_esd', 'esd_choke', 'choke_heater', 'heater_sep', 'sep_flare'].forEach(function (n) { lineSet(s, n, r, v > 0); });
      } },
    { key: 'oil_rate', label: 'Oil rate', group: 'Rates', cat: 'liquidRate', unitLabel: 'STB/d', min: 0, max: 20000,
      get: function (s) { return nz(g(s, ['rates', 'oil_stbd'])); },
      set: function (s, v) { var r = ratioOf(v, s.rates.oil_stbd); s.rates.oil_stbd = v; lineSet(s, 'sep_oil', r, v > 0); } },
    { key: 'water_rate', label: 'Water rate', group: 'Rates', cat: 'liquidRate', min: 0, max: 20000,
      get: function (s) { return nz(g(s, ['rates', 'water_bpd'])); },
      set: function (s, v) { var r = ratioOf(v, s.rates.water_bpd); s.rates.water_bpd = v; lineSet(s, 'sep_water', r, v > 0); } },
    { key: 'flare_rate', label: 'Flare gas rate', group: 'Flare', cat: 'gasRate', min: 0, max: 50,
      get: function (s) { return nz(g(s, ['nodes', 'flare', 'qMMscfd'])); },
      set: function (s, v) { s.nodes.flare.qMMscfd = v; s.nodes.flare.flame = v > 0.01 ? 1 : 0; } },
    { key: 'flare_p', label: 'Flare header pressure', group: 'Flare', cat: 'pressureG', min: 0, max: 100,
      get: function (s) { return nz(g(s, ['nodes', 'flare', 'P'])); }, set: function (s, v) { s.nodes.flare.P = v; } },
    { key: 'surge_p', label: 'Surge tank pressure', group: 'Surge tank', cat: 'pressureG', min: 0, max: 100,
      get: function (s) { return nz(g(s, ['surge', 'P'])); }, set: function (s, v) { s.surge.P = v; s.nodes.surge.P = v; } },
    { key: 'surge_lvl_a', label: 'Surge tank level — compartment A', group: 'Surge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['surge', 'comps', 0, 'frac'])); }, set: function (s, v) { if (s.surge.comps[0]) s.surge.comps[0].frac = clamp(v / 100, 0, 1); } },
    { key: 'surge_lvl_b', label: 'Surge tank level — compartment B', group: 'Surge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['surge', 'comps', 1, 'frac'])); }, set: function (s, v) { if (s.surge.comps[1]) s.surge.comps[1].frac = clamp(v / 100, 0, 1); } },
    { key: 'xv201a', label: 'Surge inlet valve XV-201A open', group: 'Surge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['surge', 'comps', 0, 'inlet'])); }, set: function (s, v) { if (s.surge.comps[0]) s.surge.comps[0].inlet = !!v; } },
    { key: 'xv201b', label: 'Surge inlet valve XV-201B open', group: 'Surge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['surge', 'comps', 1, 'inlet'])); }, set: function (s, v) { if (s.surge.comps[1]) s.surge.comps[1].inlet = !!v; } },
    { key: 'pump_running', label: 'Transfer pump P-201 running', group: 'Surge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['surge', 'pump', 'on'])); },
      set: function (s, v) { s.surge.pump.on = !!v; lineSet(s, 'surge_gauge', null, !!v); if (!v && s.segs[5]) { s.segs[5].vel = 0; s.segs[5].flowing = false; } } },
    { key: 'gauge_lvl_a', label: 'Gauge tank level — T-301A', group: 'Gauge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['gauge', 'tanks', 0, 'frac'])); }, set: function (s, v) { if (s.gauge.tanks[0]) s.gauge.tanks[0].frac = clamp(v / 100, 0, 1.05); } },
    { key: 'gauge_lvl_b', label: 'Gauge tank level — T-301B', group: 'Gauge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['gauge', 'tanks', 1, 'frac'])); }, set: function (s, v) { if (s.gauge.tanks[1]) s.gauge.tanks[1].frac = clamp(v / 100, 0, 1.05); } },
    { key: 'xv301a', label: 'Gauge tank inlet XV-301A open', group: 'Gauge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['gauge', 'tanks', 0, 'inlet'])); }, set: function (s, v) { if (s.gauge.tanks[0]) s.gauge.tanks[0].inlet = !!v; } },
    { key: 'xv301b', label: 'Gauge tank inlet XV-301B open', group: 'Gauge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['gauge', 'tanks', 1, 'inlet'])); }, set: function (s, v) { if (s.gauge.tanks[1]) s.gauge.tanks[1].inlet = !!v; } }
];
var VAR_BY_KEY = {};
VARS.forEach(function (v) { VAR_BY_KEY[v.key] = v; v.unit = v.unitLabel || (UNITS[v.cat] ? UNITS[v.cat].canon : ''); });
function varsFromState(st) {
    var out = {};
    VARS.forEach(function (v) { var x = null; try { x = st ? v.get(st) : null; } catch (e) { x = null; } out[v.key] = x == null ? null : x; });
    return out;
}
// applyVarsToState(base, values{key:canonical}) → a deep copy of the snapshot with the values applied
// (unmapped / null keys keep the base value). Used to animate the 3D / 2D views from live tags.
function applyVarsToState(base, values) {
    var s = clone(base || {});
    if (!s.nodes || !s.sep || !s.surge || !s.gauge || !s.rates || !s.esd || !s.segs || !s.lines) return s;
    // rates first (they scale the line velocities), valves / ESD last (they can zero flows)
    var order = VARS.slice().sort(function (a, b) { var ra = a.kind === 'bool' ? 2 : /rate/.test(a.key) ? 0 : 1, rb = b.kind === 'bool' ? 2 : /rate/.test(b.key) ? 0 : 1; return ra - rb; });
    order.forEach(function (v) {
        var x = values ? values[v.key] : null;
        if (x == null || (typeof x === 'number' && !isFinite(x))) return;
        try { v.set(s, x); } catch (e) {}
    });
    return s;
}

// ─── configuration ───────────────────────────────────────────────────────────
function defaultDevice(o) {
    o = o || {};
    return { id: o.id || uid('dev'), name: 'Device 1', transport: 'sim', host: '192.168.1.10', port: 502, url: 'ws://127.0.0.1:8502',
        unit: 1, pollMs: 1000, timeoutMs: 1000, retries: 1, order: 'ABCD', maxGap: 4, enabled: true,
        baud: 19200, parity: 'even', dataBits: 8, stopBits: 1 };
}
function defaultTag(o) {
    o = o || {};
    return { id: o.id || uid('tag'), name: 'TAG_1', desc: '', device: '', table: 'holding', address: 0, type: 'float32', order: '',
        scale: { mode: 'none', rawMin: 0, rawMax: 65535, engMin: 0, engMax: 100, gain: 1, offset: 0 },
        unit: '', alarm: { lolo: null, lo: null, hi: null, hihi: null }, deadband: 0, link: '', log: true, logDeadband: 0, logMinMs: 0 };
}
function defaultConfig() {
    return { v: 1, base: 0, writesEnabled: false, paused: false, devices: [], tags: [],
        sim: { source: 'sim', speed: 1, manual: {} } };
}
// Virtual-slave register map (unit 1). Most analogues are FLOAT32 ABCD input registers;
// a few show scaling (×10 gain, 0-10000 → 0-100 % linear), a word-swapped float (CDAB)
// and a metric unit (BHP in barg) so the demo exercises every conversion path.
var DEMO_MAP = [
    ['WHP', 'whp', 'input', 0, 'float32', 'ABCD', null, 'psig', { hi: 3300, hihi: 3500 }, 5],
    ['CHOKE_DN_P', 'choke_dn_p', 'input', 2, 'float32', 'ABCD', null, 'psig', null, 1],
    ['HTR_OUT_T', 'heater_t', 'input', 4, 'float32', 'ABCD', null, '°F', { lo: 100 }, 1],
    ['SEP_T', 'sep_t', 'input', 6, 'float32', 'ABCD', null, '°F', null, 1],
    ['GAS_RATE', 'gas_rate', 'input', 8, 'float32', 'ABCD', null, 'MMSCFD', null, 0.05],
    ['OIL_RATE', 'oil_rate', 'input', 10, 'float32', 'ABCD', null, 'STB/d', null, 5],
    ['WATER_RATE', 'water_rate', 'input', 12, 'float32', 'ABCD', null, 'BPD', null, 5],
    ['FLARE_RATE', 'flare_rate', 'input', 14, 'float32', 'ABCD', null, 'MMSCFD', null, 0.05],
    ['FLARE_HDR_P', 'flare_p', 'input', 16, 'float32', 'ABCD', null, 'psig', null, 0.2],
    ['SURGE_P', 'surge_p', 'input', 18, 'float32', 'ABCD', null, 'psig', { hi: 32, hihi: 40 }, 0.2],
    ['BHP_GAUGE', 'bhp', 'input', 20, 'float32', 'ABCD', null, 'barg', null, 0.05],
    ['BHT_GAUGE', 'bht', 'input', 22, 'float32', 'ABCD', null, '°F', null, 0.1],
    ['LCV102_POS', 'lcv_oil', 'input', 24, 'float32', 'ABCD', null, '%', null, 0],
    ['LCV101_POS', 'lcv_water', 'input', 26, 'float32', 'ABCD', null, '%', null, 0],
    ['PCV101_POS', 'pcv_sep', 'input', 28, 'float32', 'ABCD', null, '%', null, 0],
    ['SEP_P', 'sep_p', 'input', 40, 'float32', 'CDAB', null, 'psig', { lo: 120, hi: 165, hihi: 180 }, 0.5],
    ['WHT', 'wht', 'input', 100, 'uint16', 'ABCD', { mode: 'gain', gain: 0.1, offset: 0 }, '°F', null, 0.2],
    ['CHOKE_SIZE', 'choke_bean', 'input', 101, 'uint16', 'ABCD', null, '1/64 in', null, 0],
    ['SEP_LIQ_LVL', 'sep_liq_lvl', 'input', 110, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 75, hihi: 85 }, 0.5],
    ['SEP_INT_LVL', 'sep_int_lvl', 'input', 111, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', null, 0.5],
    ['SEP_OIL_LVL', 'sep_oil_lvl', 'input', 112, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', null, 0.5],
    ['SURGE_LVL_A', 'surge_lvl_a', 'input', 113, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 70, hihi: 90 }, 0.5],
    ['SURGE_LVL_B', 'surge_lvl_b', 'input', 114, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 70, hihi: 90 }, 0.5],
    ['GAUGE_LVL_A', 'gauge_lvl_a', 'input', 115, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 90, hihi: 97 }, 0.5],
    ['GAUGE_LVL_B', 'gauge_lvl_b', 'input', 116, 'int16', 'ABCD', { mode: 'linear', rawMin: 0, rawMax: 10000, engMin: 0, engMax: 100 }, '%', { hi: 90, hihi: 97 }, 0.5],
    ['SDV101_OPEN', 'esd_open', 'discrete', 0, 'bool', '', null, '', null, 0],
    ['ESD_TRIPPED', 'esd_tripped', 'discrete', 1, 'bool', '', null, '', null, 0],
    ['P201_RUN', 'pump_running', 'discrete', 2, 'bool', '', null, '', null, 0],
    ['XV201A_OPEN', 'xv201a', 'discrete', 3, 'bool', '', null, '', null, 0],
    ['XV201B_OPEN', 'xv201b', 'discrete', 4, 'bool', '', null, '', null, 0],
    ['XV301A_OPEN', 'xv301a', 'discrete', 5, 'bool', '', null, '', null, 0],
    ['XV301B_OPEN', 'xv301b', 'discrete', 6, 'bool', '', null, '', null, 0],
    ['HTR_BYPASS', 'heater_bypass', 'discrete', 7, 'bool', '', null, '', null, 0],
    ['ESD_TRIP_CMD', '', 'coil', 0, 'bool', '', null, '', null, 0],
    ['ESD_RESET_CMD', '', 'coil', 1, 'bool', '', null, '', null, 0],
    ['SEP_P_SP', '', 'holding', 0, 'float32', 'ABCD', null, 'psig', null, 0]
];
var DEMO_DESC = { ESD_TRIP_CMD: 'Momentary: 1 trips SDV-101 in the virtual slave', ESD_RESET_CMD: 'Momentary: 1 resets the ESD in the virtual slave',
    SEP_P_SP: 'Writable holding register (stored by the virtual slave only)', BHP_GAUGE: 'Demo BHP = WHP + 2,400 psi (fixed 0.30 psi/ft × 8,000 ft column; not a calculation)' };
function demoConfig() {
    var c = defaultConfig(), d = defaultDevice({ id: 'dev_virtual' });
    d.name = 'Virtual slave'; d.transport = 'sim'; d.pollMs = 1000; d.timeoutMs = 500; d.retries = 1;
    c.devices.push(d);
    DEMO_MAP.forEach(function (m, i) {
        var t = defaultTag({ id: 'tag_demo_' + i });
        t.name = m[0]; t.link = m[1]; t.device = d.id; t.table = m[2]; t.address = m[3]; t.type = m[4]; t.order = m[5] || '';
        if (m[6]) { for (var k in m[6]) t.scale[k] = m[6][k]; }
        t.unit = m[7]; if (m[8]) for (var a in m[8]) t.alarm[a] = m[8][a];
        t.deadband = m[9] || 0;
        var V = VAR_BY_KEY[m[1]]; t.desc = DEMO_DESC[m[0]] || (V ? V.label : '');
        c.tags.push(t);
    });
    return c;
}
var TYPE_KEYS = Object.keys(M.TYPES), TABLE_KEYS = Object.keys(M.TABLES);
// normalizeConfig(raw) → { config, errors:[string], tagErrors:{tagId:[msg]} }
function normalizeConfig(raw) {
    var errors = [], tagErrors = {}, c = defaultConfig();
    if (!raw || typeof raw !== 'object') return { config: c, errors: raw == null ? [] : ['Config is not an object'], tagErrors: tagErrors };
    c.base = +raw.base === 1 ? 1 : 0;
    c.writesEnabled = raw.writesEnabled === true;
    c.paused = raw.paused === true;
    var sim = raw.sim || {};
    c.sim.source = /^(sim|waveform|manual)$/.test(sim.source) ? sim.source : 'sim';
    c.sim.speed = [1, 10, 60].indexOf(+sim.speed) >= 0 ? +sim.speed : 1;
    if (sim.manual && typeof sim.manual === 'object') Object.keys(sim.manual).forEach(function (k) { if (VAR_BY_KEY[k] && isNum(+sim.manual[k])) c.sim.manual[k] = +sim.manual[k]; });
    var ids = {};
    (Array.isArray(raw.devices) ? raw.devices : []).slice(0, 32).forEach(function (d0, i) {
        if (!d0 || typeof d0 !== 'object') return;
        var d = defaultDevice({ id: /^[\w-]{1,40}$/.test(d0.id) && !ids[d0.id] ? d0.id : null });
        ids[d.id] = 1;
        d.name = str(d0.name || ('Device ' + (i + 1)), 40);
        d.transport = TRANSPORTS[d0.transport] ? d0.transport : 'sim';
        d.host = str(d0.host || '', 120).trim();
        d.port = clamp(Math.round(num(d0.port, 502)), 1, 65535);
        d.url = str(d0.url || 'ws://127.0.0.1:8502', 200).trim();
        if (!/^wss?:\/\//i.test(d.url)) { errors.push(d.name + ': bridge URL must start with ws:// or wss://'); d.url = 'ws://127.0.0.1:8502'; }
        d.unit = clamp(Math.round(num(d0.unit, 1)), 0, 255);
        d.pollMs = clamp(Math.round(num(d0.pollMs, 1000)), POLL_MIN, POLL_MAX);
        d.timeoutMs = clamp(Math.round(num(d0.timeoutMs, 1000)), 50, 30000);
        d.retries = clamp(Math.round(num(d0.retries, 1)), 0, 5);
        d.order = M.normOrder(d0.order);
        d.maxGap = clamp(Math.round(num(d0.maxGap, 4)), 0, 100);
        d.enabled = d0.enabled !== false;
        d.baud = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].indexOf(+d0.baud) >= 0 ? +d0.baud : 19200;
        d.parity = /^(none|even|odd)$/.test(d0.parity) ? d0.parity : 'even';
        d.dataBits = +d0.dataBits === 7 ? 7 : 8;
        d.stopBits = +d0.stopBits === 2 ? 2 : 1;
        if ((d.transport === 'ws' || d.transport === 'ios') && !d.host) errors.push(d.name + ': host / IP address is required');
        if (d.transport === 'serial' && (d.unit < 1 || d.unit > 247)) errors.push(d.name + ': RTU unit id must be 1-247');
        c.devices.push(d);
    });
    var devIds = {}; c.devices.forEach(function (d) { devIds[d.id] = d; });
    var names = {}, tids = {};
    (Array.isArray(raw.tags) ? raw.tags : []).slice(0, 2000).forEach(function (t0, i) {
        if (!t0 || typeof t0 !== 'object') return;
        var t = defaultTag({ id: /^[\w-]{1,40}$/.test(t0.id) && !tids[t0.id] ? t0.id : null }), errs = [];
        tids[t.id] = 1;
        t.name = str(t0.name || ('TAG_' + (i + 1)), 40).trim() || ('TAG_' + (i + 1));
        t.desc = str(t0.desc, 120);
        t.device = devIds[t0.device] ? t0.device : (c.devices[0] ? c.devices[0].id : '');
        if (!devIds[t0.device]) errs.push('device not found');
        t.table = M.TABLES[t0.table] ? t0.table : 'holding';
        t.type = M.TYPES[t0.type] ? t0.type : 'float32';
        if (M.TABLES[t.table].bits) t.type = 'bool';
        t.order = t0.order ? M.normOrder(t0.order) : '';
        t.address = Math.round(num(t0.address, 0));
        var pa = M.protocolAddress(t.address, t.table, c.base);
        if (!isNum(pa)) errs.push('address ' + t.address + ' is not valid for ' + (c.base ? '1-based' : '0-based') + ' addressing');
        else if (pa + (M.TABLES[t.table].bits ? 1 : M.regCount(t.type)) > 65536) errs.push('address + size exceeds 65535');
        var sc = t0.scale || {};
        t.scale = { mode: /^(none|linear|gain)$/.test(sc.mode) ? sc.mode : 'none', rawMin: num(sc.rawMin, 0), rawMax: num(sc.rawMax, 65535),
            engMin: num(sc.engMin, 0), engMax: num(sc.engMax, 100), gain: num(sc.gain, 1), offset: num(sc.offset, 0) };
        if (t.scale.mode === 'linear' && t.scale.rawMax === t.scale.rawMin) errs.push('linear scaling needs raw max ≠ raw min');
        if (t.scale.mode === 'gain' && t.scale.gain === 0) errs.push('gain must not be 0');
        if (t.type === 'bool') t.scale.mode = 'none';
        t.unit = str(t0.unit, 20).trim();
        var al = t0.alarm || {};
        t.alarm = { lolo: optNum(al.lolo), lo: optNum(al.lo), hi: optNum(al.hi), hihi: optNum(al.hihi) };
        var A = t.alarm;
        if ((A.hi != null && A.hihi != null && A.hihi < A.hi) || (A.lo != null && A.lolo != null && A.lolo > A.lo) || (A.lo != null && A.hi != null && A.lo >= A.hi)) errs.push('alarm limits must satisfy LOLO ≤ LO < HI ≤ HIHI');
        t.deadband = Math.max(0, num(t0.deadband, 0));
        t.link = VAR_BY_KEY[t0.link] ? t0.link : '';
        if (t.link && !unitFits(t.unit, VAR_BY_KEY[t.link].cat)) errs.push('unit "' + t.unit + '" cannot be converted to ' + VAR_BY_KEY[t.link].unit + ' for ' + VAR_BY_KEY[t.link].label);
        if (t.link && VAR_BY_KEY[t.link].kind === 'bool' && t.type !== 'bool' && M.TABLES[t.table].bits !== true) { /* register used as a status word: non-zero = true */ }
        t.log = t0.log !== false;
        t.logDeadband = Math.max(0, num(t0.logDeadband, 0));
        t.logMinMs = clamp(Math.round(num(t0.logMinMs, 0)), 0, 3600000);
        if (names[t.name.toLowerCase()]) errs.push('duplicate tag name');
        names[t.name.toLowerCase()] = 1;
        if (errs.length) { tagErrors[t.id] = errs; errors.push(t.name + ': ' + errs.join('; ')); }
        c.tags.push(t);
    });
    return { config: c, errors: errors, tagErrors: tagErrors };
}
var _cache = { raw: null, cfg: null };
function getConfig() {
    var s = ls(), raw = null;
    try { raw = s ? s.getItem(STORE_KEY) : null; } catch (e) { raw = null; }
    if (raw === _cache.raw && _cache.cfg) return clone(_cache.cfg);
    var obj = null; try { obj = raw ? JSON.parse(raw) : null; } catch (e) { obj = null; }
    _cache = { raw: raw, cfg: normalizeConfig(obj).config };
    return clone(_cache.cfg);
}
// saveConfig(cfg) → {ok, errors}. Stores the normalised config, rebuilds a running station,
// fires 'wts:modbus-config-changed'.
function saveConfig(cfg, opts) {
    var n = normalizeConfig(cfg), s = ls(), txt = JSON.stringify(n.config);
    try { if (s) s.setItem(STORE_KEY, txt); } catch (e) { return { ok: false, errors: ['Could not save: ' + (e && e.message)] }; }
    _cache = { raw: txt, cfg: n.config };
    if (!(opts && opts.keepStation)) rebuildStation();
    fire('wts:modbus-config-changed', { config: clone(n.config) });
    return { ok: true, errors: n.errors, tagErrors: n.tagErrors, config: clone(n.config) };
}
function setPaused(p) {
    var c = getConfig(); c.paused = !!p;
    saveConfig(c, { keepStation: true });
    if (_station) { if (p) _station.pause(); else _station.resume(); }
    return !!p;
}
function getTags() {
    var c = getConfig(), dn = {};
    c.devices.forEach(function (d) { dn[d.id] = d.name; });
    return c.tags.map(function (t) {
        var V = VAR_BY_KEY[t.link];
        return { name: t.name, device: dn[t.device] || '', unit: t.unit || (V ? V.unit : ''), desc: t.desc || (V ? V.label : ''), linkedVar: t.link || null,
            engMin: t.scale.mode === 'linear' ? t.scale.engMin : (V && isNum(V.min) ? toFromCanon(V.min, t.unit, V.cat) : null),
            engMax: t.scale.mode === 'linear' ? t.scale.engMax : (V && isNum(V.max) ? toFromCanon(V.max, t.unit, V.cat) : null) };
    });
}
function toFromCanon(v, unit, cat) { var x = fromCanonical(v, unit, cat); return isNum(x) ? x : null; }

// ─── CSV (RFC 4180 quoting) ──────────────────────────────────────────────────
var CSV_COLS = ['name', 'device', 'table', 'address', 'type', 'order', 'scale_mode', 'raw_min', 'raw_max', 'eng_min', 'eng_max', 'gain', 'offset',
    'unit', 'lolo', 'lo', 'hi', 'hihi', 'deadband', 'link', 'log', 'log_deadband', 'log_min_ms', 'desc'];
function csvCell(v) { var s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false, s = String(text || '');
    for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
        if (ch === '"') q = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r[0] && r[0].trim()); });
}
function tagsToCsv(cfg) {
    var dn = {}; (cfg.devices || []).forEach(function (d) { dn[d.id] = d.name; });
    var lines = [CSV_COLS.join(',')];
    (cfg.tags || []).forEach(function (t) {
        var A = t.alarm || {}, S = t.scale || {};
        lines.push([t.name, dn[t.device] || '', t.table, t.address, t.type, t.order, S.mode, S.rawMin, S.rawMax, S.engMin, S.engMax, S.gain, S.offset,
            t.unit, A.lolo, A.lo, A.hi, A.hihi, t.deadband, t.link, t.log !== false ? 1 : 0, t.logDeadband, t.logMinMs, t.desc].map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
}
// tagsFromCsv(text, cfg) → { tags, errors } (devices matched by name, else the first device)
function tagsFromCsv(text, cfg) {
    var rows = parseCsv(text), errors = [], tags = [];
    if (!rows.length) return { tags: tags, errors: ['CSV is empty'] };
    var hdr = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
    if (hdr.indexOf('name') < 0 || hdr.indexOf('address') < 0) return { tags: tags, errors: ['CSV header must include at least "name" and "address"'] };
    var byName = {}; (cfg.devices || []).forEach(function (d) { byName[d.name.toLowerCase()] = d.id; });
    for (var r = 1; r < rows.length; r++) {
        var o = {}; hdr.forEach(function (h, i) { o[h] = rows[r][i] == null ? '' : rows[r][i]; });
        var dev = byName[String(o.device || '').toLowerCase()] || (cfg.devices[0] ? cfg.devices[0].id : '');
        if (o.device && !byName[String(o.device).toLowerCase()]) errors.push('Row ' + r + ': device "' + o.device + '" not found — using ' + (cfg.devices[0] ? cfg.devices[0].name : 'none'));
        tags.push({ name: o.name, device: dev, table: o.table || 'holding', address: o.address, type: o.type || 'float32', order: o.order || '',
            scale: { mode: o.scale_mode || 'none', rawMin: o.raw_min, rawMax: o.raw_max, engMin: o.eng_min, engMax: o.eng_max, gain: o.gain, offset: o.offset },
            unit: o.unit, alarm: { lolo: o.lolo, lo: o.lo, hi: o.hi, hihi: o.hihi }, deadband: o.deadband, link: o.link,
            log: !(o.log === '0' || /^false$/i.test(o.log)), logDeadband: o.log_deadband, logMinMs: o.log_min_ms, desc: o.desc });
    }
    return { tags: tags, errors: errors };
}

// ─── block-read planning ─────────────────────────────────────────────────────
// planBlocks(items[{table, addr, count, ref}], {maxGap, maxRegs, maxBits}) →
//   [{table, fn, start, count, items:[{ref, offset, count}]}]
// Contiguous (or ≤ maxGap apart) addresses of the same table are merged into one
// read, up to the protocol limits (125 registers / 2000 bits, V1.1b3 §6.1-6.4).
function planBlocks(items, o) {
    o = o || {};
    var maxGap = Math.max(0, o.maxGap == null ? 4 : +o.maxGap);
    var byT = {};
    (items || []).forEach(function (it) { if (it && M.TABLES[it.table] && isNum(it.addr)) (byT[it.table] = byT[it.table] || []).push(it); });
    var out = [];
    TABLE_KEYS.forEach(function (tb) {
        var list = byT[tb]; if (!list) return;
        var T = M.TABLES[tb], lim = T.bits ? Math.min(o.maxBits || M.LIMITS.readBits, M.LIMITS.readBits) : Math.min(o.maxRegs || M.LIMITS.readRegs, M.LIMITS.readRegs);
        list = list.slice().sort(function (a, b) { return a.addr - b.addr || b.count - a.count; });
        var cur = null;
        list.forEach(function (it) {
            var cnt = Math.max(1, it.count || 1), end = it.addr + cnt;
            if (cur && it.addr <= cur.start + cur.count + maxGap && Math.max(cur.start + cur.count, end) - cur.start <= lim) {
                cur.count = Math.max(cur.start + cur.count, end) - cur.start;
            } else {
                cur = { table: tb, fn: T.read, start: it.addr, count: cnt, items: [] };
                out.push(cur);
            }
            cur.items.push({ ref: it.ref, offset: it.addr - cur.start, count: cnt });
        });
    });
    return out;
}

// ─── alarms (ANSI/ISA-18.2-2016 state model: UNACK → ACK → normal; RTN-unack) ─
// alarmLevel(v, {lolo, lo, hi, hihi}, deadband, prev) → 'HIHI'|'HI'|'LO'|'LOLO'|null
// A level clears only once the value is back inside its limit by the deadband.
function alarmLevel(v, a, db, prev) {
    if (!a || v == null || !isNum(v)) return prev || null;
    db = Math.max(0, +db || 0);
    function high(lim, keep) { return lim != null && (v >= lim || (keep && v > lim - db)); }
    function low(lim, keep) { return lim != null && (v <= lim || (keep && v < lim + db)); }
    if (high(a.hihi, prev === 'HIHI')) return 'HIHI';
    if (high(a.hi, prev === 'HI' || prev === 'HIHI')) return 'HI';
    if (low(a.lolo, prev === 'LOLO')) return 'LOLO';
    if (low(a.lo, prev === 'LO' || prev === 'LOLO')) return 'LO';
    return null;
}
// ALARM / WARN / INFO: generic levels (Form-data mode maps the simulator's own alarms onto them).
var LEVEL_SEV = { HIHI: 'alarm', LOLO: 'alarm', HI: 'warn', LO: 'warn', COMMS: 'alarm', BAD: 'warn', ALARM: 'alarm', WARN: 'warn', INFO: 'info' };
var LEVEL_RANK = { INFO: 0, HI: 1, LO: 1, BAD: 1, WARN: 1, HIHI: 2, LOLO: 2, COMMS: 2, ALARM: 2 };
function createAlarmManager(o) {
    o = o || {};
    var A = makeEmitterLocal(), map = {}, events = [], maxEvents = o.maxEvents || 500;
    function log(t, msg, kind, id) { events.push({ t: t, msg: msg, kind: kind || 'evt', id: id || null }); if (events.length > maxEvents) events.splice(0, events.length - maxEvents); A.emit('event', events[events.length - 1]); }
    // update(id, level|null, {t, tag, device, value, limit, msg})
    A.update = function (id, level, info) {
        info = info || {};
        var t = info.t || now(), a = map[id];
        if (level) {
            if (!a || !a.active || LEVEL_RANK[level] > LEVEL_RANK[a.level]) {
                var re = !!(a && a.active);
                map[id] = a = { id: id, tag: info.tag || '', device: info.device || '', level: level, sev: LEVEL_SEV[level] || 'warn',
                    state: 'UNACK', active: true, tOn: re ? a.tOn : t, tOff: null, value: info.value, limit: info.limit, msg: info.msg || '' };
                log(t, (info.tag || id) + ' ' + level + (info.msg ? ' — ' + info.msg : ''), a.sev, id);
                A.emit('change', a);
            } else {
                if (a.level !== level) { a.level = level; a.sev = LEVEL_SEV[level]; a.limit = info.limit; log(t, (info.tag || id) + ' now ' + level, 'evt', id); }
                a.value = info.value; if (info.msg) a.msg = info.msg;
            }
        } else if (a && a.active) {
            a.active = false; a.tOff = t;
            log(t, (a.tag || id) + ' ' + a.level + ' returned to normal', 'rtn', id);
            if (a.state === 'ACK') delete map[id]; else a.state = 'RTN';
            A.emit('change', a);
        }
    };
    A.ack = function (id, t) {
        var a = map[id]; if (!a) return false;
        if (a.state === 'RTN') delete map[id]; else if (a.state === 'UNACK') a.state = 'ACK'; else return false;
        log(t || now(), 'Acknowledged ' + (a.tag || id) + ' ' + a.level, 'ack', id);
        A.emit('change', a);
        return true;
    };
    A.ackAll = function (t) { var n = 0; Object.keys(map).forEach(function (id) { if (map[id].state !== 'ACK' && A.ack(id, t)) n++; }); return n; };
    A.list = function () { return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return (b.active - a.active) || ((LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0)) || (b.tOn - a.tOn); }); };
    A.get = function (id) { return map[id] || null; };
    A.events = function () { return events.slice(); };
    A.log = log;
    A.counts = function () { var c = { unack: 0, active: 0, total: 0 }; Object.keys(map).forEach(function (k) { c.total++; if (map[k].active) c.active++; if (map[k].state !== 'ACK') c.unack++; }); return c; };
    return A;
}
function makeEmitterLocal() { return M.makeEmitter({}); }

// ─── history rings (trends): fine tier + 10 s coarse tier (12 h) ──────────────
function makeRing(cap) {
    var t = new Float64Array(cap), v = new Float64Array(cap), n = 0, i = 0;
    return {
        push: function (tt, vv) { t[i] = tt; v[i] = vv == null ? NaN : vv; i = (i + 1) % cap; if (n < cap) n++; },
        range: function (t0) {
            var ot = [], ov = [], s = (i - n + cap) % cap;
            for (var k = 0; k < n; k++) { var p = (s + k) % cap; if (t[p] >= t0) { ot.push(t[p]); ov.push(v[p]); } }
            return { t: ot, v: ov };
        },
        size: function () { return n; },
        first: function () { return n ? t[(i - n + cap) % cap] : null; }
    };
}
function makeHistory(o) {
    o = o || {};
    var fine = makeRing(o.fine || 7200), coarse = makeRing(o.coarse || 4320), lastC = -Infinity, step = o.coarseMs || 10000;
    return {
        push: function (t, v) { fine.push(t, v); if (t - lastC >= step) { coarse.push(t, v); lastC = t; } },
        // fine samples where the fine ring reaches back far enough, older coarse samples before that
        range: function (t0) {
            var f = fine.first(), fr = fine.range(t0);
            if (f == null || f <= t0) return fr;
            var cr = coarse.range(t0), ot = [], ov = [];
            for (var i = 0; i < cr.t.length; i++) if (cr.t[i] < f) { ot.push(cr.t[i]); ov.push(cr.v[i]); }
            return { t: ot.concat(fr.t), v: ov.concat(fr.v) };
        }
    };
}

// ─── historian bridge ────────────────────────────────────────────────────────
// publishSamples([{tag, device, t, v, q, raw, unit}]) → WTS_historian.record(batch) if present,
// then document 'wts:modbus-samples' (detail = the batch).
function publishSamples(batch) {
    if (!batch || !batch.length) return 0;
    var H = G.WTS_historian;
    if (H && typeof H.record === 'function') { try { H.record(batch); } catch (e) { if (typeof console !== 'undefined') console.warn('[modbus] historian.record failed', e); } }
    fire('wts:modbus-samples', batch);
    return batch.length;
}

// ─── transports for a device ─────────────────────────────────────────────────
function makeTransport(dev, env) {
    env = env || {};
    if (env.transportFor) { var tr = env.transportFor(dev); if (tr) return tr; }
    switch (dev.transport) {
        case 'ws': return M.transports.webSocket({ url: dev.url, host: dev.host, port: dev.port });
        case 'serial': return M.transports.webSerial({ baud: dev.baud, parity: dev.parity, dataBits: dev.dataBits, stopBits: dev.stopBits, usbVendorId: dev.usbVendorId, usbProductId: dev.usbProductId });
        case 'ios': return M.transports.nativeTcp({ host: dev.host, port: dev.port, timeoutMs: dev.timeoutMs * 3 });
        default: return M.transports.sim({ slave: env.slave || virtualSlave, framing: dev.framing === 'rtu' ? 'rtu' : 'tcp' });
    }
}

// ─── station (polling scheduler) ─────────────────────────────────────────────
// createStation(config, env{now, transportFor, slave, setTimeout, clearTimeout}) →
//   start / stop / pause / resume / pollNow / testRead / write / values / getVar / alarms / history
// Timers exist only while started: one poll (or reconnect) timer per device plus the
// client's per-request timeout. stop() clears everything.
function createStation(cfgIn, env) {
    env = env || {};
    var S = M.makeEmitter({});
    var cfg = normalizeConfig(cfgIn).config;
    var tnow = env.now || now;
    var setT = env.setTimeout || function (f, ms) { return G.setTimeout(f, ms); };
    var clrT = env.clearTimeout || function (id) { G.clearTimeout(id); };
    var running = false, paused = !!cfg.paused, gen = 0;
    var alarms = createAlarmManager();
    var devs = {}, vals = {}, hist = {}, tagsById = {}, lastLog = {};
    cfg.devices.forEach(function (d) {
        devs[d.id] = { dev: d, status: 'idle', client: null, transport: null, timer: null, busy: false, fails: 0, lastOk: null, lastErr: null, lastPollMs: null, blocks: [], tags: [] };
    });
    cfg.tags.forEach(function (t) {
        tagsById[t.id] = t;
        var D = devs[t.device]; if (!D) return;
        var addr = M.protocolAddress(t.address, t.table, cfg.base);
        if (!isNum(addr)) return;
        D.tags.push(t);
        t._addr = addr; t._count = M.TABLES[t.table].bits ? 1 : M.regCount(t.type);
        vals[t.id] = { value: null, raw: null, q: 'init', ts: null, err: null, canon: null, unitErr: false, level: null };
        hist[t.id] = makeHistory();
    });
    Object.keys(devs).forEach(function (id) {
        var D = devs[id];
        D.blocks = planBlocks(D.tags.map(function (t) { return { table: t.table, addr: t._addr, count: t._count, ref: t }; }), { maxGap: D.dev.maxGap });
    });
    function staleMs(D) { return Math.max(3 * D.dev.pollMs, D.dev.pollMs + D.dev.timeoutMs * (D.dev.retries + 1)); }
    function setStatus(D, st, err) {
        if (D.status === st && D.lastErr === (err || null)) return;
        D.status = st; if (err !== undefined) D.lastErr = err || null;
        // COMMS alarm raised on error, cleared only once the device answers again (no flapping while reconnecting)
        if (st === 'error') alarms.update('dev:' + D.dev.id, 'COMMS', { t: tnow(), tag: D.dev.name, device: D.dev.name, msg: err || 'communication failure' });
        else if (st === 'online' || st === 'paused') alarms.update('dev:' + D.dev.id, null, { t: tnow(), tag: D.dev.name });
        S.emit('status', { device: D.dev.id, status: st, error: D.lastErr });
    }
    function schedule(D, ms, fn) {
        if (D.timer) { clrT(D.timer); D.timer = null; }
        if (!running) return;
        var g0 = gen;
        D.timer = setT(function () { D.timer = null; if (running && g0 === gen) fn(D); }, Math.max(0, ms));
    }
    function connect(D) {
        if (!running || D.client || !D.dev.enabled || !D.tags.length) return Promise.resolve(false);
        setStatus(D, 'connecting');
        var tr;
        try { tr = makeTransport(D.dev, env); } catch (e) { setStatus(D, 'error', e.message); return Promise.resolve(false); }
        D.transport = tr;
        var g0 = gen;
        return Promise.resolve().then(function () { return tr.open(); }).then(function () {
            if (!running || g0 !== gen) { try { tr.close(); } catch (e) {} return false; }
            D.client = M.createClient(tr, { timeout: D.dev.timeoutMs, retries: D.dev.retries, framing: tr.framing, now: tnow, setTimeout: setT, clearTimeout: clrT });
            D.client.on('close', function () { if (D.client) { D.client = null; markAll(D, 'bad', 'connection closed'); setStatus(D, 'error', 'Connection closed'); reconnect(D); } });
            D.fails = 0;
            setStatus(D, paused ? 'paused' : 'online', null);
            if (!paused) schedule(D, 0, poll);
            return true;
        }, function (e) {
            if (g0 !== gen) return false;
            D.transport = null;
            setStatus(D, 'error', e && e.message || String(e));
            markAll(D, 'bad', e && e.message);
            reconnect(D);
            return false;
        });
    }
    function reconnect(D) {
        if (!running) return;
        D.fails++;
        var ms = Math.max(D.dev.pollMs, Math.min(30000, 1000 * Math.pow(2, Math.min(D.fails - 1, 5))));
        schedule(D, ms, connect);
    }
    function closeDev(D) {
        if (D.timer) { clrT(D.timer); D.timer = null; }
        var c = D.client; D.client = null;
        if (c) { try { c.close(); } catch (e) {} }
        else if (D.transport) { try { D.transport.close(); } catch (e) {} }
        D.transport = null; D.busy = false;
    }
    function markAll(D, q, err) {
        var t = tnow();
        D.tags.forEach(function (tg) { var r = vals[tg.id]; if (!r) return; r.q = q; r.err = err || null; r.tsBad = t; });
    }
    function setValue(tg, raw, eng, t) {
        var r = vals[tg.id]; if (!r) return;
        r.raw = raw; r.ts = t; r.q = 'good'; r.err = null;
        if (r.value == null || !isNum(r.value) || !(tg.deadband > 0) || Math.abs(eng - r.value) >= tg.deadband || !isNum(eng)) r.value = eng;
        var V = VAR_BY_KEY[tg.link];
        if (V) {
            var c = V.kind === 'bool' ? (r.value ? 1 : 0) : toCanonical(r.value, tg.unit, V.cat);
            r.unitErr = !(c == null || isNum(c)); r.canon = r.unitErr ? null : c;
        }
        var lvl = alarmLevel(r.value, tg.alarm, tg.deadband, r.level);
        if (lvl !== r.level) {
            r.level = lvl;
            var lim = lvl ? tg.alarm[lvl.toLowerCase()] : null;
            alarms.update(tg.id, lvl, { t: t, tag: tg.name, device: (devs[tg.device] || {}).dev ? devs[tg.device].dev.name : '', value: r.value, limit: lim,
                msg: lvl ? (fmtNum(r.value) + ' ' + (tg.unit || '') + (lvl === 'HI' || lvl === 'HIHI' ? ' ≥ ' : ' ≤ ') + fmtNum(lim)) : '' });
        }
        hist[tg.id].push(t, r.value);
    }
    function decodeBlock(D, blk, data, t) {
        blk.items.forEach(function (it) {
            var tg = it.ref, raw, eng;
            try {
                if (M.TABLES[tg.table].bits) raw = data[it.offset] ? 1 : 0;
                else if (tg.type === 'bool') raw = data[it.offset] ? 1 : 0;
                else raw = M.decodeValue(data.slice(it.offset, it.offset + it.count), tg.type, tg.order || D.dev.order);
                eng = tg.type === 'bool' ? raw : M.scaleToEng(raw, tg.scale);
                setValue(tg, raw, eng, t);
            } catch (e) { var r = vals[tg.id]; if (r) { r.q = 'bad'; r.err = e.message; } }
        });
    }
    function refreshStale(t) {
        t = t || tnow();
        Object.keys(devs).forEach(function (id) {
            var D = devs[id], lim = staleMs(D);
            D.tags.forEach(function (tg) { var r = vals[tg.id]; if (r && r.q === 'good' && r.ts != null && t - r.ts > lim) r.q = 'stale'; });
        });
    }
    function logBatch(D, t) {
        var batch = [];
        D.tags.forEach(function (tg) {
            if (tg.log === false) return;
            var r = vals[tg.id]; if (!r || r.q === 'init') return;
            var v = r.q === 'bad' ? null : (isNum(r.value) ? r.value : null), L = lastLog[tg.id];
            if (L && L.q === r.q) {
                if (tg.logMinMs > 0 && t - L.t < tg.logMinMs) return;
                if (tg.logDeadband > 0 && v != null && L.v != null && Math.abs(v - L.v) < tg.logDeadband) return;
            }
            lastLog[tg.id] = { t: t, v: v, q: r.q };
            batch.push({ tag: tg.name, device: D.dev.name, t: t, v: v, q: r.q, raw: r.q === 'bad' ? null : (isNum(r.raw) ? r.raw : null), unit: tg.unit || '' });
        });
        return batch;
    }
    function pollOnce(D) {
        if (!D.client) return Promise.resolve(false);
        D.busy = true;
        var t0 = tnow(), c = D.client, anyOk = false, fatal = null, silent = null;
        var chain = Promise.resolve();
        function markBad(blk, e) {
            var t = tnow();
            blk.items.forEach(function (it) { var r = vals[it.ref.id]; if (r) { r.q = 'bad'; r.err = e.message; r.tsBad = t; } });
        }
        D.blocks.forEach(function (blk) {
            chain = chain.then(function () {
                if (fatal || D.client !== c) return;
                // after a timeout (retries exhausted) the device is treated as not answering for the
                // rest of this cycle, so a dead device costs one timeout per poll, not one per block
                if (silent) { markBad(blk, silent); return; }
                return c.read(D.dev.unit, blk.table, blk.start, blk.count).then(function (data) {
                    anyOk = true; decodeBlock(D, blk, data, tnow());
                }, function (e) {
                    markBad(blk, e);
                    if (e.kind === 'closed' || e.kind === 'transport') fatal = e;
                    if (e.kind === 'timeout') silent = e;
                    D.lastErr = e.message;
                });
            });
        });
        return chain.then(function () {
            D.busy = false;
            var t = tnow();
            D.lastPollMs = t - t0;
            if (anyOk) { D.lastOk = t; D.fails = 0; }
            refreshStale(t);
            var allBad = !anyOk && D.blocks.length;
            if (fatal || allBad) setStatus(D, 'error', (fatal || { message: D.lastErr }).message);
            else setStatus(D, paused ? 'paused' : 'online', null);
            var batch = logBatch(D, t);
            publishSamples(batch);
            S.emit('poll', { device: D.dev.id, t: t, ok: anyOk, batch: batch });
            if (fatal) { closeDev(D); reconnect(D); }
            return anyOk;
        });
    }
    function poll(D) {
        if (!running || paused || D.busy) return;
        var t0 = tnow();
        pollOnce(D).then(function () {
            if (!running || paused || !D.client) return;
            schedule(D, Math.max(10, D.dev.pollMs - (tnow() - t0)), poll);
        });
    }
    S.start = function () {
        if (running) return S;
        running = true; gen++;
        alarms.log(tnow(), 'Modbus polling started', 'evt');
        Object.keys(devs).forEach(function (id) { connect(devs[id]); });
        S.emit('start');
        return S;
    };
    S.stop = function () {
        if (!running) return S;
        running = false; gen++;
        Object.keys(devs).forEach(function (id) { closeDev(devs[id]); devs[id].status = 'idle'; });
        alarms.log(tnow(), 'Modbus polling stopped', 'evt');
        S.emit('stop');
        return S;
    };
    S.pause = function () {
        paused = true;
        Object.keys(devs).forEach(function (id) { var D = devs[id]; if (D.timer && D.client) { clrT(D.timer); D.timer = null; } if (D.client) setStatus(D, 'paused'); });
        alarms.log(tnow(), 'Polling paused', 'evt');
        S.emit('paused', true);
    };
    S.resume = function () {
        if (!paused) return;
        paused = false;
        alarms.log(tnow(), 'Polling resumed', 'evt');
        Object.keys(devs).forEach(function (id) { var D = devs[id]; if (D.client) { setStatus(D, 'online'); schedule(D, 0, poll); } });
        S.emit('paused', false);
    };
    S.isPaused = function () { return paused; };
    S.isRunning = function () { return running; };
    // pollNow() → Promise: connect (if needed) and poll every device once (tests, "Poll now").
    S.pollNow = function () {
        var was = running;
        if (!running) { running = true; gen++; }
        var ps = Object.keys(devs).map(function (id) {
            var D = devs[id];
            if (!D.dev.enabled || !D.tags.length) return Promise.resolve(false);
            var p = D.client ? Promise.resolve(true) : (function () {
                if (D.timer) { clrT(D.timer); D.timer = null; }
                var pp = connect(D);
                return pp.then(function (ok) { if (D.timer) { clrT(D.timer); D.timer = null; } return ok; });
            })();
            return p.then(function (ok) { return ok && !D.busy ? pollOnce(D) : false; });
        });
        return Promise.all(ps).then(function (r) {
            if (!was) { running = false; gen++; Object.keys(devs).forEach(function (id) { closeDev(devs[id]); }); }
            else Object.keys(devs).forEach(function (id) { var D = devs[id]; if (D.client && !paused && !D.timer && !D.busy) schedule(D, D.dev.pollMs, poll); });
            return r;
        });
    };
    function withClient(D, fn) {
        if (D.client) return fn(D.client);
        var tr = makeTransport(D.dev, env);
        return Promise.resolve().then(function () { return tr.open(); }).then(function () {
            var c = M.createClient(tr, { timeout: D.dev.timeoutMs, retries: D.dev.retries, framing: tr.framing, now: tnow, setTimeout: setT, clearTimeout: clrT });
            return Promise.resolve().then(function () { return fn(c); }).then(function (r) { c.close(); return r; }, function (e) { c.close(); throw e; });
        });
    }
    // testRead(tagId) → Promise<{raw, value, canon, words|bits, unit}>
    S.testRead = function (tagId) {
        var tg = tagsById[tagId]; if (!tg) return Promise.reject(M.ModbusError('config', 'Unknown tag'));
        var D = devs[tg.device]; if (!D) return Promise.reject(M.ModbusError('config', 'Tag has no device'));
        var addr = M.protocolAddress(tg.address, tg.table, cfg.base);
        if (!isNum(addr)) return Promise.reject(M.ModbusError('config', 'Invalid address'));
        var cnt = M.TABLES[tg.table].bits ? 1 : M.regCount(tg.type);
        return withClient(D, function (c) { return c.read(D.dev.unit, tg.table, addr, cnt); }).then(function (data) {
            var raw = (M.TABLES[tg.table].bits || tg.type === 'bool') ? (data[0] ? 1 : 0) : M.decodeValue(data, tg.type, tg.order || D.dev.order);
            var eng = tg.type === 'bool' ? raw : M.scaleToEng(raw, tg.scale), V = VAR_BY_KEY[tg.link];
            return { raw: raw, value: eng, canon: V ? (V.kind === 'bool' ? (eng ? 1 : 0) : toCanonical(eng, tg.unit, V.cat)) : null,
                data: data.slice(0, cnt), unit: tg.unit, address: addr, table: tg.table };
        });
    };
    // write(tagId, engValue, {confirmed:true}) — only when writes are enabled in the config.
    S.write = function (tagId, eng, o) {
        var tg = tagsById[tagId];
        if (!tg) return Promise.reject(M.ModbusError('config', 'Unknown tag'));
        if (!cfg.writesEnabled) return Promise.reject(M.ModbusError('config', 'Writes are disabled — tick "Enable writes" on the Modbus page first'));
        if (!o || o.confirmed !== true) return Promise.reject(M.ModbusError('config', 'Write not confirmed'));
        var T = M.TABLES[tg.table];
        if (T.readOnly) return Promise.reject(M.ModbusError('config', T.label + ' is read-only'));
        var D = devs[tg.device]; if (!D) return Promise.reject(M.ModbusError('config', 'Tag has no device'));
        var addr = M.protocolAddress(tg.address, tg.table, cfg.base);
        var p;
        try {
            if (T.bits) p = function (c) { return c.writeCoil(D.dev.unit, addr, !!+eng); };
            else {
                var raw = tg.type === 'bool' ? (+eng ? 1 : 0) : M.scaleToRaw(+eng, tg.scale);
                if (!isNum(raw)) throw M.ModbusError('config', 'Value cannot be scaled to a raw register value');
                var words = M.encodeValue(raw, tg.type === 'bool' ? 'uint16' : tg.type, tg.order || D.dev.order);
                p = words.length === 1 ? function (c) { return c.writeRegister(D.dev.unit, addr, words[0]); } : function (c) { return c.writeRegisters(D.dev.unit, addr, words); };
            }
        } catch (e) { return Promise.reject(e); }
        return withClient(D, p).then(function (r) {
            alarms.log(tnow(), 'Write ' + tg.name + ' = ' + eng + (tg.unit ? ' ' + tg.unit : '') + ' (' + D.dev.name + ')', 'write');
            return r;
        });
    };
    S.values = function () { refreshStale(); var o = {}; Object.keys(vals).forEach(function (id) { o[id] = vals[id]; }); return o; };
    S.value = function (tagId) { return vals[tagId] || null; };
    // getVar(key) → {value (app field unit), q, ts, tag, unitErr} from the first linked tag (a good one preferred).
    S.getVar = function (key) {
        refreshStale();
        var best = null;
        cfg.tags.forEach(function (tg) {
            if (tg.link !== key || !vals[tg.id]) return;
            var r = vals[tg.id], c = { value: r.canon, q: r.unitErr ? 'bad' : r.q, ts: r.ts, tag: tg.name, tagId: tg.id, unitErr: r.unitErr, err: r.unitErr ? 'unit mismatch' : r.err };
            if (!best || (best.q !== 'good' && c.q === 'good')) best = c;
        });
        return best;
    };
    S.linkedValues = function () { var o = {}; VARS.forEach(function (V) { var x = S.getVar(V.key); if (x && x.q !== 'init' && x.q !== 'bad' && x.value != null) o[V.key] = x.value; }); return o; };
    S.devices = function () {
        return Object.keys(devs).map(function (id) {
            var D = devs[id];
            return { id: id, name: D.dev.name, transport: D.dev.transport, status: D.status, lastOk: D.lastOk, lastErr: D.lastErr, lastPollMs: D.lastPollMs,
                pollMs: D.dev.pollMs, blocks: D.blocks.length, tags: D.tags.length, stats: D.client ? D.client.stats() : null };
        });
    };
    S.history = function (tagId, t0) { return hist[tagId] ? hist[tagId].range(t0 == null ? -Infinity : t0) : { t: [], v: [] }; };
    S.alarms = alarms;
    S.config = function () { return clone(cfg); };
    S.tag = function (id) { return tagsById[id] || null; };
    S.blocks = function (devId) { var D = devs[devId]; return D ? D.blocks : []; };
    S.dispose = function () { S.stop(); S._clearHandlers(); };
    return S;
}
function fmtNum(v) { return isNum(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3)) : '—'; }

// ─── shared station (pages acquire / release it) ─────────────────────────────
var _station = null, _owners = {};
function acquire(owner) {
    _owners[owner || 'page'] = 1;
    if (!_station) _station = createStation(getConfig());
    if (!_station.isRunning()) _station.start();
    return _station;
}
function release(owner) {
    delete _owners[owner || 'page'];
    if (!Object.keys(_owners).length && _station) { _station.dispose(); _station = null; }
}
function rebuildStation() {
    if (!_station) return;
    var wasRunning = _station.isRunning();
    _station.dispose(); _station = null;
    if (wasRunning && Object.keys(_owners).length) { _station = createStation(getConfig()); _station.start(); }
    M.emitShared('station', _station);
}
// syncStation(): rebuild a running station whose config no longer matches storage
// (project opened, storage restored) — called by the pages when they render.
function syncStation() {
    if (!_station) return false;
    if (JSON.stringify(_station.config()) === JSON.stringify(getConfig())) return false;
    rebuildStation();
    return true;
}
var _shared = M.makeEmitter({});
M.onShared = _shared.on; M.offShared = _shared.off; M.emitShared = _shared.emit;

// ─── virtual slave + driver ──────────────────────────────────────────────────
// Values come from (a) a private WTS_sim instance (31) fed with the Well Test
// Simulator form flow (WTS_state.flow) or the sample flow, (b) waveforms around
// the sample steady state, or (c) manual values (sliders). The driver runs only
// when the slave is polled (pull), so it never needs a timer.
var _vs = null;
function simFlow() {
    var W = G.WTS_state, L = G.WTS_lastCalc, S = G.WTS_sim;
    if (W && W.flow && W.flow.inputs) return W.flow;
    if (L && L.flow && L.flow.inputs) return L.flow;
    return S && S.SAMPLE_FLOW ? S.SAMPLE_FLOW : null;
}
function makeFormModel(o) {
    o = o || {};
    var S = G.WTS_sim, sim = null, flow = null, t = 0;
    function ensure() {
        var f = o.flow || simFlow();
        if (sim && f === flow) return sim;
        if (!S || typeof S.create !== 'function' || !f) return null;
        try { if (sim) sim.dispose(); } catch (e) {}
        try { sim = S.create(f, { mode: 'steady', seed: o.seed || 11 }); flow = f; } catch (e) { sim = null; }
        return sim;
    }
    return {
        step: function (dtSec) { var s = ensure(); if (s && dtSec > 0) { try { s.advance(Math.min(dtSec, 600)); } catch (e) {} } t += dtSec || 0; },
        state: function () { var s = ensure(); return s ? s.getState() : null; },
        values: function () { return varsFromState(this.state()); },
        sim: function () { return ensure(); },
        dispose: function () { try { if (sim) sim.dispose(); } catch (e) {} sim = null; }
    };
}
// fixed demo values for the downhole gauge (see DEMO_DESC.BHP_GAUGE)
var DEMO_BHP_COLUMN_PSI = 2400, DEMO_BHT_F = 220;
function nominalValues() {
    var st = null;
    try { var m = makeFormModel({ flow: G.WTS_sim && G.WTS_sim.SAMPLE_FLOW }); st = m.state(); } catch (e) {}
    if (!st && G.WTS_3d && G.WTS_3d._internals && typeof G.WTS_3d._internals.fakeSnapshot === 'function') { try { st = G.WTS_3d._internals.fakeSnapshot(0); } catch (e) {} }
    var v = varsFromState(st);
    var fb = { whp: 3000, wht: 180, choke_bean: 32, choke_dn_p: 157.7, heater_t: 150, sep_p: 150, sep_t: 150, sep_liq_lvl: 60, sep_int_lvl: 25, sep_oil_lvl: 32,
        gas_rate: 10, oil_rate: 1000, water_rate: 200, flare_rate: 10, flare_p: 5, surge_p: 25, surge_lvl_a: 55, surge_lvl_b: 55, gauge_lvl_a: 30, gauge_lvl_b: 0,
        lcv_oil: 0, lcv_water: 0, pcv_sep: 50, esd_open: 1, esd_tripped: 0, pump_running: 0, xv201a: 1, xv201b: 1, xv301a: 1, xv301b: 0, heater_bypass: 0 };
    Object.keys(fb).forEach(function (k) { if (v[k] == null) v[k] = fb[k]; });
    v.bhp = (v.whp || 0) + DEMO_BHP_COLUMN_PSI; v.bht = DEMO_BHT_F;
    return v;
}
function createVirtualSlave(o) {
    o = o || {};
    var slave, model = null, last = null, t0 = null, nominal = null, cfgRead = o.config || getConfig;
    var D = { values: {} };
    function values(t) {
        var c = cfgRead().sim || {}, src = c.source || 'sim', v;
        var dt = last == null ? 0 : Math.max(0, Math.min(10, (t - last) / 1000));
        last = t; if (t0 == null) t0 = t;
        if (src === 'sim') {
            if (!model) model = makeFormModel({ seed: 23 });
            model.step(dt * (c.speed || 1));
            v = model.values();
            if (v.whp == null) v = nominalValues();
            v.bhp = v.whp != null ? v.whp + DEMO_BHP_COLUMN_PSI : null; v.bht = DEMO_BHT_F;
        } else {
            if (!nominal) nominal = nominalValues();
            v = {}; for (var k in nominal) v[k] = nominal[k];
            if (src === 'waveform') {
                var s = (t - t0) / 1000, sn = function (per, ph) { return Math.sin(2 * Math.PI * s / per + (ph || 0)); };
                ['whp', 'choke_dn_p', 'sep_p', 'gas_rate', 'oil_rate', 'water_rate', 'flare_rate', 'surge_p'].forEach(function (k, i) { if (v[k] != null) v[k] *= 1 + 0.05 * sn(120, i); });
                if (v.wht != null) v.wht += 3 * sn(300);
                var tri = function (per, lo, hi, ph) { var x = ((s / per + (ph || 0)) % 1 + 1) % 1; return lo + (hi - lo) * (x < 0.5 ? 2 * x : 2 - 2 * x); };
                v.sep_liq_lvl = tri(180, 45, 70); v.sep_int_lvl = tri(240, 15, 35, 0.3); v.sep_oil_lvl = tri(90, 20, 45, 0.6);
                v.surge_lvl_a = tri(600, 25, 75); v.surge_lvl_b = tri(600, 25, 75, 0.5); v.gauge_lvl_a = tri(1200, 5, 92); v.gauge_lvl_b = tri(1200, 5, 92, 0.5);
                v.pump_running = sn(300) > 0 ? 1 : 0;
                v.bhp = v.whp + DEMO_BHP_COLUMN_PSI;
            }
            var man = c.manual || {};
            if (src === 'manual') Object.keys(man).forEach(function (k) { if (isNum(man[k])) v[k] = man[k]; });
        }
        D.values = v;
        return v;
    }
    function drive() {
        var t = now(), v = values(t);
        DEMO_MAP.forEach(function (m) {
            var key = m[1]; if (!key) return;
            var x = v[key]; if (x == null || !isNum(x)) return;
            var V = VAR_BY_KEY[key], table = m[2], addr = m[3], type = m[4];
            if (type === 'bool') { slave[table][addr] = x ? 1 : 0; return; }
            var eng = V ? fromCanonical(x, m[7], V.cat) : x;
            var raw = m[6] ? M.scaleToRaw(eng, m[6]) : eng;
            var T = M.TYPES[type];
            if (T.int) raw = clamp(Math.round(raw), T.min, T.max);
            try { slave.setValue(table, addr, type, m[5] || 'ABCD', raw); } catch (e) {}
        });
    }
    function onWrite(table, addr, qty) {
        if (table !== 'coil') return;
        var sim = model && model.sim();
        if (addr <= 0 && addr + qty > 0 && slave.coil[0]) { slave.coil[0] = 0; if (sim && sim.tripESD) { try { sim.tripESD('Remote trip (Modbus coil 00001)'); } catch (e) {} } D.lastCommand = 'trip'; }
        if (addr <= 1 && addr + qty > 1 && slave.coil[1]) { slave.coil[1] = 0; if (sim && sim.resetESD) { try { sim.resetESD(); } catch (e) {} } D.lastCommand = 'reset'; }
    }
    slave = M.createSlave({ unit: o.unit || 1, onRequest: function () { drive(); }, onWrite: onWrite });
    slave.driver = D;
    D.drive = drive;
    D.model = function () { return model; };
    D.reset = function () { if (model) model.dispose(); model = null; last = null; t0 = null; nominal = null; };
    return slave;
}
function virtualSlave() { if (!_vs) _vs = createVirtualSlave(); return _vs; }

// ─── public ──────────────────────────────────────────────────────────────────
M.STORE_KEY = STORE_KEY; M.TRANSPORT_LABELS = TRANSPORTS; M.POLL_MIN = POLL_MIN; M.POLL_MAX = POLL_MAX;
M.UNITS = UNITS; M.toCanonical = toCanonical; M.fromCanonical = fromCanonical; M.unitFits = unitFits;
M.VARS = VARS; M.VAR_BY_KEY = VAR_BY_KEY; M.varsFromState = varsFromState; M.applyVarsToState = applyVarsToState;
M.defaultConfig = defaultConfig; M.defaultDevice = defaultDevice; M.defaultTag = defaultTag; M.demoConfig = demoConfig; M.DEMO_MAP = DEMO_MAP;
M.normalizeConfig = normalizeConfig; M.getConfig = getConfig; M.saveConfig = saveConfig; M.setPaused = setPaused; M.getTags = getTags;
M.tagsToCsv = tagsToCsv; M.tagsFromCsv = tagsFromCsv; M.parseCsv = parseCsv; M.CSV_COLS = CSV_COLS;
M.planBlocks = planBlocks; M.alarmLevel = alarmLevel; M.createAlarmManager = createAlarmManager; M.makeHistory = makeHistory;
M.publishSamples = publishSamples; M.makeTransport = makeTransport; M.createStation = createStation;
M.acquire = acquire; M.release = release; M.syncStation = syncStation; M.station = function () { return _station; }; M.owners = function () { return Object.keys(_owners); };
M.makeFormModel = makeFormModel; M.createVirtualSlave = createVirtualSlave; M.virtualSlave = virtualSlave; M.nominalValues = nominalValues;
M.DEMO_BHP_COLUMN_PSI = DEMO_BHP_COLUMN_PSI; M.DEMO_BHT_F = DEMO_BHT_F;
M.fmtNum = fmtNum;
M._reset = function () { if (_station) _station.dispose(); _station = null; _owners = {}; if (_vs && _vs.driver) _vs.driver.reset(); _vs = null; _cache = { raw: null, cfg: null }; };
})();

// ─── END 61-modbus-station ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 62-modbus-page ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 62-modbus-page.js — "Modbus" configuration page (route `modbus`, group "Live Data")
// -----------------------------------------------------------------------------
// Devices (transport, address, unit id, poll rate, timeout, retries, byte/word order),
// tags (register table, address with a 0/1-based toggle, data type, word order,
// scaling, units, alarm limits, deadband, link to a well-test variable, historian
// logging), "Test read" per tag, live monitor, global pause, JSON / CSV import and
// export, write protection ("Enable writes" + confirmation), the built-in virtual
// slave (WTS_sim / waveform / manual) and the connection guide: WebSocket-bridge setup
// (install Node → download the bundled bridge package → generate an installer for the
// configured bridge devices → "Check bridge" via GET /health), Web Serial RTU, iOS native
// TCP, troubleshooting. The guide card is .rp-skip (kept out of PDF / Quick Report).
//
// The page state lives in localStorage 'wts_modbus_config' (WTS_modbus.saveConfig);
// the root carries data-no-persist so the host page autosave leaves it alone.
// Bridge helpers: window.WTS_modbusBridgeSetup (65-modbus-bridge-setup.js), bridge files:
// window.WTS_modbusBridgePack (64-modbus-bridge-pack.js, generated from tools/modbus-bridge/).
// Registers itself in window.WTS_calcRegistry (host plug-in registry).
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
var M = G.WTS_modbus;
if (!M || !M.getConfig) return;

var OWNER = 'modbus-page';
var ctl = null;           // active page controller

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(label) + '</option>'; }
function fmtTime(t) { if (!t) return '—'; var d = new Date(t), p = function (x) { return x < 10 ? '0' + x : '' + x; }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function fmtVal(v) { return M.fmtNum ? M.fmtNum(v) : String(v); }

var lastUrl = null;
function bytesB64(b) {
    var S = G.WTS_modbusBridgeSetup;
    if (S && S.base64) return S.base64(b);
    var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return G.btoa(s);
}
// text or bytes (Uint8Array) → a download; in the iOS app the share sheet (ios-bridge.js).
function download(name, text, type) {
    try {
        var bin = typeof text !== 'string';
        if (typeof G.iosSaveFile === 'function') {
            Promise.resolve(G.iosSaveFile(name, bin ? bytesB64(text) : text, bin)).catch(function (e) { console.warn('[modbus] share failed', e); });
            return true;
        }
        var blob = new Blob([text], { type: type || 'text/plain' });
        var a = document.createElement('a');
        if (lastUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) { try { URL.revokeObjectURL(lastUrl); } catch (e) {} }
        a.href = lastUrl = URL.createObjectURL(blob); a.download = name;
        (document.body || document.documentElement).appendChild(a); a.click();
        if (a.parentNode) a.parentNode.removeChild(a);
        return true;
    } catch (e) { console.warn('[modbus] download failed', e); return false; }
}
M.download = download;

function injectCss() {
    if (typeof document === 'undefined' || byId('wts-modbus-css')) return;
    var s = document.createElement('style');
    s.id = 'wts-modbus-css';
    s.textContent = [
        '.mb-scroll{overflow-x:auto;max-width:100%}',
        '.mb-table{min-width:900px}',
        '.mb-table td{padding:5px 6px;vertical-align:middle}',
        '.mb-table th{padding:6px;white-space:nowrap}',
        '.mb-table input,.mb-table select{width:100%;min-width:56px}',
        '.mb-table input.mb-w-s{min-width:52px}.mb-table input.mb-w-m{min-width:90px}.mb-table input.mb-w-l{min-width:130px}',
        '.mb-table tr.mb-err td{background:rgba(248,81,73,.06)}',
        '.mb-live{font-family:"Courier New",monospace;white-space:nowrap;font-size:12px}',
        '.mb-q-good{color:var(--green)}.mb-q-stale{color:var(--orange,#d29922)}.mb-q-bad{color:var(--red)}.mb-q-init{color:var(--text3)}',
        '.mb-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:12px;border:1px solid var(--border);font-size:11px;font-weight:600;margin:2px 6px 2px 0;background:var(--bg1)}',
        '.mb-dot{width:8px;height:8px;border-radius:50%;background:var(--text3);display:inline-block}',
        '.mb-dot.online{background:var(--green)}.mb-dot.error{background:var(--red)}.mb-dot.connecting,.mb-dot.paused{background:var(--orange,#d29922)}',
        '.mb-btn-s{padding:5px 10px;font-size:11px}',
        '.mb-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}',
        '.mb-msgs{font-size:12px;margin-top:8px}',
        '.mb-guide h4{margin:10px 0 4px;font-size:13px;color:var(--text)}.mb-guide p,.mb-guide li{font-size:12px;color:var(--text2);line-height:1.5}',
        '.mb-guide code{background:var(--bg1);padding:1px 5px;border-radius:4px;font-size:11px}',
        '.mb-slider{display:grid;grid-template-columns:minmax(160px,1fr) 2fr 90px;gap:8px;align-items:center;font-size:12px;margin:4px 0}',
        '@media (max-width:700px){.mb-slider{grid-template-columns:1fr}}',
        '.mb-guide details.mb-sec{border:1px solid var(--border);border-radius:8px;padding:6px 12px;margin:8px 0;background:var(--bg1);min-width:0}',
        '.mb-guide details.mb-sec>summary{cursor:pointer;font-weight:600;font-size:13px;color:var(--text);padding:4px 0}',
        '.mb-guide .btn-row{flex-wrap:wrap}',
        '.mb-steps{margin:8px 0 0;padding-left:20px}.mb-steps>li{margin:0 0 14px;font-size:12px;color:var(--text2)}.mb-steps>li>b{color:var(--text);font-size:13px}',
        '.mb-cmd{margin:6px 0;min-width:0}.mb-cmd-l{font-size:11px;color:var(--text3);margin-bottom:2px}.mb-cmd-r{display:flex;gap:6px;align-items:flex-start;min-width:0}',
        '.mb-cmd pre{flex:1 1 auto;min-width:0;margin:0;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg2,var(--bg1));white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;font-size:11px;line-height:1.45}',
        '.mb-guide .mb-cmd pre code{background:none;padding:0;font-size:11px}',
        '.mb-os{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}',
        '.mb-targets,.mb-hints{margin:6px 0;padding-left:18px}.mb-hints li{margin:2px 0}',
        '.mb-inl{display:flex;flex-direction:column;gap:4px;font-size:12px;margin:8px 0}.mb-inl input{width:100%;max-width:420px;box-sizing:border-box}',
        '.mb-chk{display:flex;gap:8px;align-items:center;font-size:12px;margin:4px 0}',
        '.mb-verdict{font-size:13px;font-weight:600;margin:8px 0 4px;overflow-wrap:anywhere}.mb-hint{font-size:11px;color:var(--text3);margin-top:4px;overflow-wrap:anywhere}',
        '.mb-note{border-left:3px solid var(--green);padding:6px 10px;margin:6px 0 10px;font-size:12px;color:var(--text2);background:var(--bg1);border-radius:0 6px 6px 0}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
}

// ─── rendering ───────────────────────────────────────────────────────────────
function transportOpts(sel) { var s = ''; for (var k in M.TRANSPORT_LABELS) s += opt(k, M.TRANSPORT_LABELS[k], sel); return s; }
function orderOpts(sel, withDefault) { var s = withDefault ? opt('', 'Device default', sel) : ''; M.ORDERS.forEach(function (o) { s += opt(o, o + (o === 'ABCD' ? ' (big-endian)' : o === 'CDAB' ? ' (word swap)' : o === 'BADC' ? ' (byte swap)' : ' (little-endian)'), sel); }); return s; }
function linkOpts(sel) {
    var s = opt('', '— not linked —', sel), grp = null;
    M.VARS.forEach(function (V) {
        if (V.group !== grp) { if (grp) s += '</optgroup>'; grp = V.group; s += '<optgroup label="' + esc(grp) + '">'; }
        s += opt(V.key, V.label + (V.unit ? ' [' + V.unit + ']' : ''), sel);
    });
    return s + (grp ? '</optgroup>' : '');
}
function inp(kind, id, f, val, type, cls, extra) {
    return '<input type="' + (type || 'text') + '" data-k="' + kind + '" data-id="' + esc(id) + '" data-f="' + f + '" value="' + esc(val == null ? '' : val) + '"' + (cls ? ' class="' + cls + '"' : '') + (extra || '') + '>';
}
function sel(kind, id, f, optsHtml, extra) { return '<select data-k="' + kind + '" data-id="' + esc(id) + '" data-f="' + f + '"' + (extra || '') + '>' + optsHtml + '</select>'; }
function chk(kind, id, f, on, extra) { return '<input type="checkbox" data-k="' + kind + '" data-id="' + esc(id) + '" data-f="' + f + '"' + (on ? ' checked' : '') + (extra || '') + '>'; }

function devicesHtml(c) {
    var rows = c.devices.map(function (d) {
        var tcp = d.transport === 'ws' || d.transport === 'ios', ser = d.transport === 'serial';
        return '<tr data-row="dev" data-id="' + esc(d.id) + '">' +
            '<td>' + inp('dev', d.id, 'name', d.name, 'text', 'mb-w-l') + '</td>' +
            '<td>' + sel('dev', d.id, 'transport', transportOpts(d.transport)) + '</td>' +
            '<td>' + (tcp ? inp('dev', d.id, 'host', d.host, 'text', 'mb-w-l', ' placeholder="192.168.1.10"') : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + (tcp ? inp('dev', d.id, 'port', d.port, 'number', 'mb-w-s', ' min="1" max="65535"') : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + (d.transport === 'ws' ? inp('dev', d.id, 'url', d.url, 'text', 'mb-w-l') :
                ser ? sel('dev', d.id, 'baud', [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(function (b) { return opt(b, b + ' baud', d.baud); }).join('')) +
                    sel('dev', d.id, 'parity', opt('even', '8E1 (even)', d.parity) + opt('none', '8N1 / 8N2 (none)', d.parity) + opt('odd', '8O1 (odd)', d.parity)) +
                    sel('dev', d.id, 'stopBits', opt(1, '1 stop bit', d.stopBits) + opt(2, '2 stop bits', d.stopBits)) : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + inp('dev', d.id, 'unit', d.unit, 'number', 'mb-w-s', ' min="0" max="255"') + '</td>' +
            '<td>' + inp('dev', d.id, 'pollMs', d.pollMs, 'number', 'mb-w-m', ' min="' + M.POLL_MIN + '" max="' + M.POLL_MAX + '" step="100" title="Polling interval, 100 ms – 60 s"') + '</td>' +
            '<td>' + inp('dev', d.id, 'timeoutMs', d.timeoutMs, 'number', 'mb-w-m', ' min="50" max="30000" step="50"') + '</td>' +
            '<td>' + inp('dev', d.id, 'retries', d.retries, 'number', 'mb-w-s', ' min="0" max="5"') + '</td>' +
            '<td>' + sel('dev', d.id, 'order', orderOpts(d.order, false)) + '</td>' +
            '<td>' + inp('dev', d.id, 'maxGap', d.maxGap, 'number', 'mb-w-s', ' min="0" max="100" title="Largest gap (registers) bridged when grouping tags into one block read"') + '</td>' +
            '<td style="text-align:center">' + chk('dev', d.id, 'enabled', d.enabled) + '</td>' +
            '<td class="mb-live" data-devstat="' + esc(d.id) + '"><span class="mb-dot"></span> idle</td>' +
            '<td style="white-space:nowrap"><button class="btn btn-secondary mb-btn-s" data-act="dev-test" data-id="' + esc(d.id) + '">Test</button> ' +
            '<button class="btn btn-secondary mb-btn-s" data-act="dev-del" data-id="' + esc(d.id) + '" title="Delete device">✕</button></td></tr>';
    }).join('');
    return '<div class="mb-scroll"><table class="dtable mb-table" id="mbc_devtable"><thead><tr><th>Name</th><th>Transport</th><th>Host / IP</th><th>Port</th><th>Bridge URL / serial</th><th>Unit id</th><th>Poll (ms)</th><th>Timeout (ms)</th><th>Retries</th><th>Byte / word order</th><th>Max gap</th><th>On</th><th>Status</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="14" class="mb-q-init">No devices yet — add one, or load the simulator demo below.</td></tr>') + '</tbody></table></div>';
}
function tagsHtml(c, tagErrors) {
    var devs = c.devices;
    var rows = c.tags.map(function (t) {
        var T = M.TABLES[t.table], err = tagErrors && tagErrors[t.id], sm = t.scale.mode, V = M.VAR_BY_KEY[t.link];
        var typeOpts = T.bits ? opt('bool', 'Bool / bit', 'bool') : Object.keys(M.TYPES).map(function (k) { return opt(k, M.TYPES[k].label, t.type); }).join('');
        return '<tr data-row="tag" data-id="' + esc(t.id) + '"' + (err ? ' class="mb-err" title="' + esc(err.join('; ')) + '"' : '') + '>' +
            '<td>' + inp('tag', t.id, 'name', t.name, 'text', 'mb-w-l') + '</td>' +
            '<td>' + sel('tag', t.id, 'device', devs.map(function (d) { return opt(d.id, d.name, t.device); }).join('')) + '</td>' +
            '<td>' + sel('tag', t.id, 'table', Object.keys(M.TABLES).map(function (k) { return opt(k, M.TABLES[k].label, t.table); }).join('')) + '</td>' +
            '<td>' + inp('tag', t.id, 'address', t.address, 'number', 'mb-w-m', ' min="0"') + '</td>' +
            '<td>' + sel('tag', t.id, 'type', typeOpts) + '</td>' +
            '<td>' + (T.bits || t.type === 'bool' ? '<span class="mb-q-init">—</span>' : sel('tag', t.id, 'order', orderOpts(t.order, true))) + '</td>' +
            '<td>' + (t.type === 'bool' ? '<span class="mb-q-init">—</span>' : sel('tag', t.id, 'scale.mode', opt('none', 'None', sm) + opt('linear', 'Raw → Eng', sm) + opt('gain', 'Gain / offset', sm))) + '</td>' +
            '<td>' + (sm === 'linear' ? inp('tag', t.id, 'scale.rawMin', t.scale.rawMin, 'number', 'mb-w-s') + inp('tag', t.id, 'scale.rawMax', t.scale.rawMax, 'number', 'mb-w-s') :
                sm === 'gain' ? inp('tag', t.id, 'scale.gain', t.scale.gain, 'number', 'mb-w-s', ' step="any" title="Gain"') : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + (sm === 'linear' ? inp('tag', t.id, 'scale.engMin', t.scale.engMin, 'number', 'mb-w-s') + inp('tag', t.id, 'scale.engMax', t.scale.engMax, 'number', 'mb-w-s') :
                sm === 'gain' ? inp('tag', t.id, 'scale.offset', t.scale.offset, 'number', 'mb-w-s', ' step="any" title="Offset"') : '<span class="mb-q-init">—</span>') + '</td>' +
            '<td>' + inp('tag', t.id, 'unit', t.unit, 'text', 'mb-w-s', ' list="mbc_units" placeholder="' + esc(V ? V.unit : '') + '"') + '</td>' +
            '<td>' + inp('tag', t.id, 'alarm.lolo', t.alarm.lolo, 'number', 'mb-w-s', ' step="any" placeholder="LOLO"') + '</td>' +
            '<td>' + inp('tag', t.id, 'alarm.lo', t.alarm.lo, 'number', 'mb-w-s', ' step="any" placeholder="LO"') + '</td>' +
            '<td>' + inp('tag', t.id, 'alarm.hi', t.alarm.hi, 'number', 'mb-w-s', ' step="any" placeholder="HI"') + '</td>' +
            '<td>' + inp('tag', t.id, 'alarm.hihi', t.alarm.hihi, 'number', 'mb-w-s', ' step="any" placeholder="HIHI"') + '</td>' +
            '<td>' + inp('tag', t.id, 'deadband', t.deadband, 'number', 'mb-w-s', ' min="0" step="any"') + '</td>' +
            '<td>' + sel('tag', t.id, 'link', linkOpts(t.link)) + '</td>' +
            '<td style="text-align:center">' + chk('tag', t.id, 'log', t.log !== false, ' title="Log this tag to the historian"') + '</td>' +
            '<td>' + inp('tag', t.id, 'logDeadband', t.logDeadband, 'number', 'mb-w-s', ' min="0" step="any" title="Historian log deadband (engineering units)"') + '</td>' +
            '<td>' + inp('tag', t.id, 'logMinMs', t.logMinMs, 'number', 'mb-w-s', ' min="0" step="100" title="Minimum historian log interval (ms)"') + '</td>' +
            '<td>' + inp('tag', t.id, 'desc', t.desc, 'text', 'mb-w-l') + '</td>' +
            '<td class="mb-live" data-live="' + esc(t.id) + '">—</td>' +
            '<td style="white-space:nowrap"><button class="btn btn-secondary mb-btn-s" data-act="tag-read" data-id="' + esc(t.id) + '">Test read</button> ' +
            '<button class="btn btn-secondary mb-btn-s" data-act="tag-del" data-id="' + esc(t.id) + '" title="Delete tag">✕</button></td></tr>';
    }).join('');
    var units = []; Object.keys(M.UNITS).forEach(function (k) { M.UNITS[k].defs.forEach(function (d) { if (d[0][0]) units.push(d[0][0]); }); });
    units = ['psig', 'psia', 'kPa', 'bar', 'barg', 'MPa', '°F', '°C', 'MMSCFD', 'MSCFD', '10³ m³/d', 'm3/d', 'm3/h', 'BPD', 'STB/d', 'bbl/d', 'gpm', 'L/min', '%', '1/64 in', 'in', 'mm'];
    return '<datalist id="mbc_units">' + units.map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist>' +
        '<div class="mb-scroll"><table class="dtable mb-table" id="mbc_tagtable" style="min-width:2300px"><thead><tr><th>Tag</th><th>Device</th><th>Register table</th><th>Address</th><th>Data type</th><th>Word order</th><th>Scaling</th><th>Raw min / max · gain</th><th>Eng min / max · offset</th><th>Units</th><th>LOLO</th><th>LO</th><th>HI</th><th>HIHI</th><th>Deadband</th><th>Link to app variable</th><th>Log</th><th>Log deadband</th><th>Log min (ms)</th><th>Description</th><th>Live value</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="22" class="mb-q-init">No tags yet.</td></tr>') + '</tbody></table></div>';
}
function slaveHtml(c) {
    var s = c.sim || {}, man = s.manual || {}, nom = M.nominalValues ? M.nominalValues() : {};
    var keys = ['whp', 'sep_p', 'gas_rate', 'oil_rate', 'water_rate', 'surge_lvl_a', 'gauge_lvl_a', 'sep_liq_lvl'];
    var sliders = keys.map(function (k) {
        var V = M.VAR_BY_KEY[k], v = isNum(man[k]) ? man[k] : (isNum(nom[k]) ? nom[k] : 0), max = V.max || 100;
        return '<div class="mb-slider"><span>' + esc(V.label) + '</span><input type="range" data-k="sim" data-f="manual.' + k + '" min="' + (V.min || 0) + '" max="' + max + '" step="' + (max > 1000 ? 10 : max > 100 ? 1 : 0.1) + '" value="' + v + '"' + (s.source !== 'manual' ? ' disabled' : '') + '><span class="mb-live">' + esc(fmtVal(v)) + ' ' + esc(V.unit) + '</span></div>';
    }).join('') +
        '<div class="mb-slider"><span>ESD valve SDV-101 open</span><span>' + '<input type="checkbox" data-k="sim" data-f="manual.esd_open"' + ((isNum(man.esd_open) ? man.esd_open : 1) ? ' checked' : '') + (s.source !== 'manual' ? ' disabled' : '') + '></span><span></span></div>';
    var map = M.DEMO_MAP.map(function (m) {
        var V = M.VAR_BY_KEY[m[1]], p = m[2] === 'coil' ? 0 : m[2] === 'discrete' ? 1 : m[2] === 'input' ? 3 : 4;
        return '<tr><td>' + esc(m[0]) + '</td><td>' + esc(M.TABLES[m[2]].label) + '</td><td>' + m[3] + '</td><td>' + (p * 10000 + m[3] + 1) + '</td><td>' + esc(m[4]) + '</td><td>' + esc(m[5] || '—') + '</td><td>' + esc(m[7] || '—') + '</td><td>' + esc(V ? V.label : 'command / set point') + '</td></tr>';
    }).join('');
    return '<div class="fg"><div class="fg-item"><label>Value source</label><select data-k="sim" data-f="source">' +
        opt('sim', 'Well Test Simulator model (WTS_sim)', s.source) + opt('waveform', 'Waveforms (sine / ramps)', s.source) + opt('manual', 'Manual sliders', s.source) + '</select></div>' +
        '<div class="fg-item"><label>Simulation speed</label><select data-k="sim" data-f="speed">' + opt(1, '1× real time', s.speed) + opt(10, '10×', s.speed) + opt(60, '60×', s.speed) + '</select></div></div>' +
        '<div style="margin-top:12px">' + sliders + '</div>' +
        '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--text2)">Virtual slave register map (unit id 1)</summary><div class="mb-scroll"><table class="dtable" style="min-width:760px"><thead><tr><th>Tag</th><th>Table</th><th>Protocol address</th><th>PLC address</th><th>Type</th><th>Order</th><th>Units</th><th>Variable</th></tr></thead><tbody>' + map + '</tbody></table></div></details>';
}
// ─── connection guide (bridge setup) ─────────────────────────────────────────
var OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
function isIosApp() {
    try {
        if (typeof document !== 'undefined' && document.documentElement && document.documentElement.classList.contains('ios-app')) return true;
        var C = G.Capacitor;
        return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
    } catch (e) { return false; }
}
function guessOs() {
    var n = G.navigator || {}, s = String(n.userAgent || '') + ' ' + String(n.platform || '');
    if (/Win/i.test(s)) return 'windows';
    if (/Mac|iPhone|iPad/i.test(s)) return 'macos';
    if (/Linux|X11|CrOS/i.test(s)) return 'linux';
    return 'windows';
}
function cmdBox(text, label) {
    return '<div class="mb-cmd">' + (label ? '<div class="mb-cmd-l">' + esc(label) + '</div>' : '') +
        '<div class="mb-cmd-r"><pre><code>' + esc(text) + '</code></pre>' +
        '<button type="button" class="btn btn-secondary mb-btn-s" data-act="guide-copy" data-copy="' + esc(text) + '" aria-label="Copy: ' + esc(label || text) + '">Copy</button></div></div>';
}
function listHtml(items, cls) { return items.length ? '<ul class="' + (cls || 'mb-hints') + '">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : ''; }
// The guide's outer frame (rendered once per page view); the bridge steps live in #mbc_guide_steps.
function guideHtml(ios) {
    return '<div class="mb-guide">' +
        (ios ? '<div class="mb-note"><b>iOS app: no bridge needed.</b> Choose the transport "Modbus TCP (iOS app, native)" — the app talks to the PLC directly over Wi-Fi. The bridge below is only for the web version in a desktop browser.</div>' : '') +
        '<details class="mb-sec" id="mbc_guide_web"' + (ios ? '' : ' open') + '><summary>Web browser → Modbus TCP: bridge setup (Windows / macOS / Linux)</summary>' +
        '<p>Browsers cannot open raw TCP sockets, so a small bridge program (Node.js, no other software) runs on a PC on the same network as the PLC / RTU. It listens on <code>ws://127.0.0.1:8502</code> (this computer only), connects only to the device addresses you allow, and refuses Modbus writes unless you allow them.</p>' +
        '<div id="mbc_guide_steps"></div></details>' +
        '<details class="mb-sec"><summary>Modbus RTU (RS-485) — Web Serial</summary><p>Chrome or Edge on a desktop, page served over https or localhost (no bridge needed). Plug in a USB–RS-485 adapter, choose "Modbus RTU via Web Serial", set baud / parity / unit id, then press <b>Test</b> — the browser asks which serial port to use (once).</p></details>' +
        '<details class="mb-sec"' + (ios ? ' open' : '') + '><summary>iOS app — native TCP (no bridge)</summary><p>In the iOS app, choose "Modbus TCP (iOS app, native)" and enter the PLC\'s IP address and port. The app connects directly over Wi-Fi (Network framework); iOS asks once for Local Network permission. The WebSocket bridge is not used.</p></details>' +
        '<details class="mb-sec"><summary>No hardware? Built-in simulator</summary><p>"Load simulator demo" configures one device on the built-in virtual slave: 36 tags covering pressures, temperatures, rates, levels and valve states, fed by the Well Test Simulator model. Mini WellOS then animates from those tags when its data source is set to "Modbus data". To try the bridge itself, the package includes <code>fake-slave.js</code>: run <code>node fake-slave.js --port 5020</code>, allow <code>127.0.0.1:5020</code> in the bridge and add a bridge device with host 127.0.0.1, port 5020.</p></details>' +
        '<details class="mb-sec"><summary>Troubleshooting</summary><ul class="mb-hints">' +
        '<li><b>"Cannot reach the Modbus bridge"</b> — the bridge is not running, the bridge URL / port differs, or the bridge refused this page (a browser cannot tell these apart). Press <b>Check bridge</b>: it says which.</li>' +
        '<li><b>"not in the bridge allow-list"</b> — run the installer again (step 3) with that device: it adds the target and keeps the others, the port and the settings. Or add its host:port to <code>allow</code> in bridge-config.json and restart the bridge.</li>' +
        '<li><b>"the bridge refused this page"</b> — the page is served from an origin the bridge does not accept: run the installer again with <code>--origin &lt;that origin&gt;</code> (<code>-Origin</code>), or add it to <code>origins</code> in bridge-config.json. A saved copy (file://) sends <code>null</code>, which the bridge refuses by default because any web site can send it: open the app from pb-handbook.com or http://localhost instead (or add <code>null</code> on a PC not used for general browsing).</li>' +
        '<li><b>"refused the host name"</b> — use the bridge PC\'s IP address in the device bridge URL, not its name.</li>' +
        '<li><b>Timeouts</b> — check the unit id (many gateways need the RS-485 slave address here), the IP / port, and that no firewall blocks TCP 502 between the PC and the device.</li>' +
        '<li><b>Exception 01 on writes</b> — the bridge is read-only: run the installer again with "Allow Modbus writes" (<code>--allow-writes</code> / <code>-AllowWrites</code>); it keeps the targets and the port.</li>' +
        '<li><b>Chrome / Edge asks about local network or apps on this device</b> — choose Allow, so this page may reach the bridge on 127.0.0.1.</li>' +
        '<li><b>Windows: "running scripts is disabled on this system"</b> — use the <code>powershell -NoProfile -ExecutionPolicy Bypass -File …</code> command exactly as shown (it changes no system setting).</li>' +
        '<li><b>macOS / Linux: "permission denied"</b> — start the installer with <code>bash install.sh …</code>.</li>' +
        '<li><b>Port 8502 already in use</b> — install with another port (<code>--port</code> / <code>-Port</code>) and change the device bridge URL to match.</li>' +
        '</ul></details></div>';
}
// The parts of step 3 that change with the Extra targets field and the two check boxes. They are
// updated in place (updateGuide), so the controls the user is working with are never replaced —
// a click that blurs the Extra targets field lands on the same button.
function guideParts(cfg, g, ios) {
    var S = G.WTS_modbusBridgeSetup;
    var os = g.os, t = S.targetsFromConfig(cfg, g.extra), allow = g.anyIp ? ['*:*'] : t.targets.map(function (x) { return x.target; });
    if (g.anyIp) t.errors = [];
    var cmds = S.commandsFor(os, { allow: allow, port: t.port, listen: t.listen, allowWrites: g.writes, autostart: g.autostart, origins: S.autoOrigins ? S.autoOrigins() : [] });
    var ready = !!(allow.length && !t.errors.length);
    var note = S.originNote ? S.originNote() : '';
    var tlist = g.anyIp ? '<li class="mb-q-good">✓ Any device IP / port (*:*) — the bridge still listens on this PC only' + (g.writes ? '' : ' and stays read-only') + '</li>' : t.targets.map(function (x) { return '<li class="mb-q-good">✓ ' + esc(x.name) + ' — ' + esc(x.target) + '</li>'; }).join('') +
        (g.anyIp ? '' : t.errors.map(function (e) { return '<li class="mb-q-bad">✗ ' + esc(e) + '</li>'; }).join(''));
    var targets = (tlist ? '<ul class="mb-targets">' + tlist + '</ul>' : '<p class="mb-q-stale">No bridge devices yet — add a device above with transport "Modbus TCP via WebSocket bridge" (host / IP and port), or enter a target here.</p>') +
        listHtml(t.warnings.concat(note ? [note] : []));
    var run = '';
    if (ready) {
        run = (ios
            ? '<p>The iOS app cannot create the installer: open the web version of the app on the PC and press "Generate installer for my devices" there. For reference, the commands for the unzipped package folder:</p>'
            : (os === 'windows'
                ? '<p>Then run it in PowerShell (Start menu → type PowerShell). Change the path if your browser saved it elsewhere:</p>' + cmdBox(cmds.installer, 'PowerShell — generated installer')
                : '<p>Then run it in a Terminal (change the path if your browser saved it elsewhere):</p>' + cmdBox(cmds.installer, 'Terminal — generated installer')) +
              '<p class="mb-hint">Run again later (for another device, or with writes allowed), an installer keeps the targets, port and settings of the existing bridge-config.json and adds to them — <code>' + (os === 'windows' ? '-Reset' : '--reset') + '</code> starts a new list.</p>') +
            cmdBox(cmds.packaged, 'or, in the unzipped package folder') +
            cmdBox(cmds.direct, 'or run the bridge without installing (stops when the window closes)') +
            (os === 'windows'
                ? '<p>No administrator rights needed; <code>-ExecutionPolicy Bypass</code> applies to this one run. It installs to <code>%LOCALAPPDATA%\\WTS Modbus Bridge</code>, writes <code>bridge-config.json</code>, adds a Start-menu shortcut "WTS Modbus Bridge" (and a logon task with auto-start), starts the bridge and checks it.</p>'
                : '<p>No sudo needed. It installs to <code>' + (os === 'macos' ? '~/Library/Application Support/WTS Modbus Bridge' : '~/.local/share/wts-modbus-bridge') + '</code>, writes <code>bridge-config.json</code> and <code>start-bridge.sh</code>' +
                  (os === 'macos' ? ' (auto-start: a LaunchAgent)' : ' (auto-start: a systemd --user service)') + ', starts the bridge and checks it. Without auto-start the bridge runs in that Terminal window — leave it open.</p>') +
            cmdBox(cmds.uninstall, 'uninstall');
    }
    return { targets: targets, run: run, ready: ready, cmds: cmds };
}
function guideStepsHtml(cfg, g, ios) {
    var S = G.WTS_modbusBridgeSetup, P = G.WTS_modbusBridgePack;
    if (!S || !P) return '<p>Run <code>node modbus-bridge.js --allow 192.168.1.10:502</code> from the <code>tools/modbus-bridge</code> folder of the repository (Node.js 18 or newer), then set the device bridge URL to <code>ws://127.0.0.1:8502</code>.</p>';
    var os = g.os, parts = guideParts(cfg, g, ios), cmds = parts.cmds;
    var osBtns = '<div class="mb-os" role="group" aria-label="Operating system of the PC that runs the bridge">' + ['windows', 'macos', 'linux'].map(function (o) {
        return '<button type="button" class="btn mb-btn-s ' + (o === os ? 'btn-primary' : 'btn-secondary') + '" data-act="guide-os" data-os="' + o + '" aria-pressed="' + (o === os) + '">' + OS_LABEL[o] + '</button>';
    }).join('') + '</div>';
    var node = os === 'windows'
        ? '<p>Install the LTS version from <b>nodejs.org</b> (Windows Installer), or in PowerShell:</p>' + cmdBox(cmds.node, 'PowerShell')
        : os === 'macos'
            ? '<p>With Homebrew (or the macOS installer from <b>nodejs.org</b>):</p>' + cmdBox(cmds.node, 'Terminal')
            : '<p>Your distribution\'s package if it is version 18 or newer, otherwise the packages on <b>nodejs.org</b>:</p>' + cmdBox('sudo apt-get install nodejs', 'Debian / Ubuntu') + cmdBox('sudo dnf install nodejs', 'Fedora / RHEL');
    node += '<p>Check with <code>node --version</code> (v18 or newer). The installer in step 3 offers to install Node.js itself when it is missing (after asking you).</p>';
    var shaShort = String((P.sha256 || {})['modbus-bridge.js'] || '').slice(0, 16);
    var pkg = ios ? '<p>Open the web version of the app on the PC to download the bridge package.</p>'
        : '<p>The bridge ships inside this app, so this works offline: <code>modbus-bridge.js</code>, the installers for Windows / macOS / Linux, a test slave and the README.</p>' +
          '<div class="btn-row"><button type="button" class="btn btn-secondary" data-act="guide-pack">⬇ Download bridge package (.zip)</button></div>' +
          '<div class="mb-hint">Bridge v' + esc(P.version) + ' · SHA-256 of modbus-bridge.js ' + esc(shaShort) + '… · unzip it (Windows: right-click → Extract All).</div>';
    var inst = '<p>Targets the bridge will be allowed to reach (from your "Modbus TCP via WebSocket bridge" devices):</p>' +
        '<div id="mbc_guide_targets">' + parts.targets + '</div>' +
        '<label class="mb-inl">Extra targets (optional, comma separated — ip:port, subnet a.b.c.d/nn:port, host:port or [IPv6]:port)<input type="text" data-k="guide" data-f="extra" value="' + esc(g.extra) + '" placeholder="10.0.0.0/24:502, plc-2.local:502" autocomplete="off" spellcheck="false"></label>' +
        '<label class="mb-chk"><input type="checkbox" data-k="guide" data-f="anyIp"' + (g.anyIp ? ' checked' : '') + '> Allow any device IP / port (default — untick to allow only the targets listed)</label>' +
        '<label class="mb-chk"><input type="checkbox" data-k="guide" data-f="autostart"' + (g.autostart ? ' checked' : '') + '> Start the bridge automatically at login</label>' +
        '<label class="mb-chk"><input type="checkbox" data-k="guide" data-f="writes"' + (g.writes ? ' checked' : '') + '> Allow Modbus writes through the bridge (only if you need to write set points)</label>' +
        (ios ? '' : '<div class="btn-row"><button type="button" class="btn btn-primary" data-act="guide-installer"' + (parts.ready ? '' : ' disabled') + '>⬇ Generate installer for my devices</button></div>') +
        '<div class="mb-msgs" id="mbc_guide_gen" aria-live="polite">' + (g.genHtml || '') + '</div>' +
        '<div id="mbc_guide_run">' + parts.run + '</div>';
    var check = '<p>With the bridge running, check it from here, then press <b>Test</b> on each device row.</p>' +
        '<div class="btn-row"><button type="button" class="btn btn-primary" data-act="guide-check">Check bridge</button></div>' +
        '<div id="mbc_guide_check" aria-live="polite">' + (g.checkHtml || '') + '</div>';
    return osBtns + '<ol class="mb-steps">' +
        '<li><b>Install Node.js 18 or newer</b> (' + OS_LABEL[os] + ')' + node + '</li>' +
        '<li><b>Get the bridge</b>' + pkg + '</li>' +
        '<li><b>Install it for your devices</b>' + inst + '</li>' +
        '<li><b>Check the bridge</b>' + check + '</li></ol>';
}
function checkResultHtml(r, cfg) {
    var h = r.results.map(function (x) {
        if (x.running) {
            var w = (x.warnings || []).slice();
            if (cfg && cfg.writesEnabled && x.readOnly) w.push('Writes are enabled on this page but the bridge is read-only — writes will be refused (exception 01). Re-run the installer with "Allow Modbus writes" if you need them.');
            return '<div class="mb-verdict mb-q-' + (x.ok ? 'good' : 'stale') + '">' + (x.ok ? '✓' : '⚠') + ' Bridge v' + esc(x.version) + ' is running at ' + esc(x.healthUrl.replace(/\/health$/, '')) + ' — ' + (x.readOnly ? 'read-only' : 'writes allowed') + ', port ' + esc(x.port) + '</div>' +
                (x.devices.length ? '<ul class="mb-targets">' + x.devices.map(function (d) {
                    return '<li class="mb-q-' + (d.allowed ? 'good' : 'bad') + '">' + (d.allowed ? '✓ ' : '✗ ') + esc(d.name) + ' — ' + esc(d.target) + (d.allowed ? ' is in the allow-list' : ' is NOT in the allow-list') + '</li>';
                }).join('') + '</ul>' : '') +
                '<div class="mb-hint">Bridge allow-list: ' + esc((x.allow || []).join(', ') || '(empty)') + '</div>' + listHtml(w);
        }
        return '<div class="mb-verdict mb-q-bad">✗ ' + esc(x.error) + '</div>' + listHtml(x.hints || []);
    }).join('');
    return h + (r.configErrors && r.configErrors.length ? listHtml(r.configErrors) : '');
}
function copyText(text, btn) {
    var done = function (ok) { if (btn) btn.textContent = ok ? 'Copied ✓' : 'Select the text to copy'; };
    function fallback() {
        try {
            var ta = document.createElement('textarea');
            ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
            (document.body || document.documentElement).appendChild(ta); ta.select();
            var ok = typeof document.execCommand === 'function' && document.execCommand('copy');
            if (ta.parentNode) ta.parentNode.removeChild(ta);
            return !!ok;
        } catch (e) { return false; }
    }
    try {
        var cb = G.navigator && G.navigator.clipboard;
        if (cb && typeof cb.writeText === 'function') { return Promise.resolve(cb.writeText(text)).then(function () { done(true); return true; }, function () { var ok = fallback(); done(ok); return ok; }); }
    } catch (e) { /* fall back */ }
    var ok2 = fallback(); done(ok2); return Promise.resolve(ok2);
}
function summaryHtml(c, errors) {
    var linked = {}; c.tags.forEach(function (t) { if (t.link) linked[t.link] = 1; });
    var dn = {}; c.devices.forEach(function (d) { dn[d.id] = d.name; });
    var ok = !errors.length;
    return '<div class="rbox"><div class="rbox-title">Configuration summary</div>' +
        '<div class="rrow"><span class="rl">Devices</span><span class="rv">' + c.devices.length + '</span></div>' +
        '<div class="rrow"><span class="rl">Tags</span><span class="rv">' + c.tags.length + '</span></div>' +
        '<div class="rrow"><span class="rl">App variables linked</span><span class="rv">' + Object.keys(linked).length + ' of ' + M.VARS.length + '</span></div>' +
        '<div class="rrow"><span class="rl">Addressing</span><span class="rv">' + (c.base ? '1-based (PLC)' : '0-based (protocol)') + '</span></div>' +
        '<div class="rrow"><span class="rl">Writes</span><span class="rv">' + (c.writesEnabled ? 'ENABLED' : 'Read-only') + '</span></div>' +
        '<div class="rrow"><span class="rl">Polling</span><span class="rv">' + (c.paused ? 'Paused' : 'Active while a live page is open') + '</span></div></div>' +
        '<div style="color:var(--' + (ok ? 'green' : 'orange,#d29922') + ');margin-top:10px;font-size:13px">' + (ok ? '✓ Configuration is valid.' : '⚠ ' + esc(errors.length + ' configuration issue' + (errors.length > 1 ? 's' : '') + ' — see the highlighted rows.')) + '</div>' +
        (errors.length ? '<ul class="mb-msgs" style="color:var(--text2)">' + errors.slice(0, 20).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' : '') +
        (c.tags.length ? '<table class="dtable" style="margin-top:12px"><thead><tr><th>Tag</th><th>Device</th><th>Table</th><th>Address</th><th>Type</th><th>Units</th><th>Linked variable</th></tr></thead><tbody>' +
            c.tags.slice(0, 200).map(function (t) { var V = M.VAR_BY_KEY[t.link]; return '<tr><td>' + esc(t.name) + '</td><td>' + esc(dn[t.device] || '') + '</td><td>' + esc(t.table) + '</td><td>' + esc(t.address) + '</td><td>' + esc(t.type) + '</td><td>' + esc(t.unit || '—') + '</td><td>' + esc(V ? V.label : '—') + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
        '<div style="margin-top:12px;font-size:12px;color:var(--text2)"><b>Notes</b> Values are read-only unless "Enable writes" is ticked; every write asks for confirmation. A tag linked to an app variable is converted from its units to the app field unit (psig, °F, MMSCFD, bbl/d, %). Gas volumes convert by volume only — the difference between 60 °F / 14.696 psia and 15 °C / 101.325 kPa base conditions (about 0.1-0.2 %) is not applied. Quality: good = fresh reply, stale = no reply for 3 poll intervals, bad = timeout, exception or unit mismatch.</div>';
}

function render(body) {
    injectCss();
    if (ctl) ctl.dispose();
    if (M.syncStation) M.syncStation();
    var c = M.getConfig(), n = M.normalizeConfig(c);
    body.innerHTML = '<div id="mbc_root" data-no-persist>' +
        '<div class="info-bar">Configure Modbus devices and tags, link them to well-test variables, then open <b>Mini WellOS</b> and switch its data source to "Modbus data". Read-only unless writes are enabled below.</div>' +
        '<div class="mb-bar" id="mbc_bar"></div>' +
        '<div class="card"><div class="card-title">Devices</div><div id="mbc_devs"></div><div class="btn-row"><button class="btn btn-secondary" data-act="dev-add">+ Add device</button><button class="btn btn-secondary" data-act="demo">Load simulator demo</button></div></div>' +
        '<div class="card"><div class="card-title">Tags / channels</div>' +
        '<div class="fg" style="margin-bottom:10px"><div class="fg-item"><label>Register addressing</label><select data-k="cfg" data-f="base">' + opt(0, '0-based (protocol address, 0 = first register)', c.base) + opt(1, '1-based (PLC numbering: 1, 40001, 400001)', c.base) + '</select></div></div>' +
        '<div id="mbc_tags"></div><div class="btn-row"><button class="btn btn-secondary" data-act="tag-add">+ Add tag</button></div></div>' +
        '<div class="cols-2"><div class="card"><div class="card-title">Security &amp; writes</div>' +
        '<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" data-k="cfg" data-f="writesEnabled"' + (c.writesEnabled ? ' checked' : '') + '> Enable writes (FC05 / 06 / 15 / 16)</label>' +
        '<div class="fg" style="margin-top:12px"><div class="fg-item"><label>Tag to write</label><select id="mbc_wtag_sel" data-no-persist></select></div><div class="fg-item"><label>Value (engineering units)</label><input type="number" step="any" data-role="wval"></div></div>' +
        '<div class="btn-row"><button class="btn btn-primary" data-act="write">Write…</button></div><div class="mb-msgs" id="mbc_wmsg"></div></div>' +
        '<div class="card"><div class="card-title">Import / export</div><div class="btn-row" style="flex-wrap:wrap">' +
        '<button class="btn btn-secondary" data-act="exp-json">Export JSON</button><button class="btn btn-secondary" data-act="exp-csv">Export tags CSV</button>' +
        '<button class="btn btn-secondary" data-act="imp-json">Import JSON…</button><button class="btn btn-secondary" data-act="imp-csv">Import tags CSV…</button>' +
        '<button class="btn btn-secondary" data-act="clear">Clear all</button></div>' +
        '<input type="file" accept=".json,.csv,.txt,application/json,text/csv" data-role="file" style="display:none">' +
        '<div class="mb-msgs" id="mbc_imsg"></div><div style="font-size:12px;color:var(--text2);margin-top:8px">The configuration is saved as <code>wts_modbus_config</code> and travels in project files.</div></div></div>' +
        '<div class="card"><div class="card-title">Built-in Modbus simulator (virtual slave)</div><div id="mbc_slave"></div></div>' +
        '<div class="card rp-skip" id="mbc_guide"><div class="card-title">Connecting to real equipment — setup guide</div>' + guideHtml(isIosApp()) + '</div>' +
        '<div id="mbc_res"></div></div>';
    var root = byId('mbc_root');
    ctl = createController(root, n);
    if (typeof G.calcModbusConfig === 'function') G.calcModbusConfig();
}

function createController(root, n0) {
    var cfg = n0.config, tagErrors = n0.tagErrors, errors = n0.errors, disposed = false, monitor = null, pendingImport = null;
    var C = { root: root };
    var guide = { os: guessOs(), extra: '', anyIp: true, autostart: true, writes: false, genHtml: '', checkHtml: '', ios: isIosApp() };
    C.guide = guide;
    function q(sel) { return root.querySelector(sel); }
    // Full re-render of the steps (device list or OS changed); keyboard focus goes back to the
    // equivalent control, so a keyboard / screen-reader user is not dropped to <body>.
    function focusSel(el) {
        if (!el || !el.getAttribute) return null;
        var act = el.getAttribute('data-act'), os = el.getAttribute('data-os'), k = el.getAttribute('data-k'), f = el.getAttribute('data-f');
        if (act === 'guide-os' && /^(windows|macos|linux)$/.test(os || '')) return '[data-act="guide-os"][data-os="' + os + '"]';
        if (act && /^guide-[a-z]+$/.test(act)) return '[data-act="' + act + '"]';
        if (k === 'guide' && /^(extra|autostart|writes)$/.test(f || '')) return '[data-k="guide"][data-f="' + f + '"]';
        return null;
    }
    function renderGuide() {
        var g = q('#mbc_guide_steps'); if (!g) return;
        var a = typeof document !== 'undefined' ? document.activeElement : null;
        var sel = a && a !== g && g.contains(a) ? focusSel(a) : null;
        g.innerHTML = guideStepsHtml(cfg, guide, guide.ios);
        if (sel) { var n = g.querySelector(sel); if (n && typeof n.focus === 'function') n.focus(); }
    }
    // Partial update: targets, warnings, the installer button's state and the commands only.
    function updateGuide() {
        var S = G.WTS_modbusBridgeSetup;
        if (!S || !G.WTS_modbusBridgePack || !q('#mbc_guide_targets')) { renderGuide(); return; }
        var parts = guideParts(cfg, guide, guide.ios);
        q('#mbc_guide_targets').innerHTML = parts.targets;
        var run = q('#mbc_guide_run'); if (run) run.innerHTML = parts.run;
        var b = q('[data-act="guide-installer"]');
        if (b) { if (parts.ready) b.removeAttribute('disabled'); else b.setAttribute('disabled', ''); }
        var gm = q('#mbc_guide_gen'); if (gm) gm.innerHTML = guide.genHtml || '';
    }
    C.updateGuide = updateGuide;
    function refresh(which) {
        if (!which || which.dev) { var d = q('#mbc_devs'); if (d) d.innerHTML = devicesHtml(cfg); }
        if (!which || which.tag) { var t = q('#mbc_tags'); if (t) t.innerHTML = tagsHtml(cfg, tagErrors); }
        if (!which || which.slave) { var s = q('#mbc_slave'); if (s) s.innerHTML = slaveHtml(cfg); }
        if (!which || which.dev || which.guide) renderGuide();
        var ws = q('#mbc_wtag_sel'), keep = ws ? ws.value : '';
        if (ws) ws.innerHTML = cfg.tags.filter(function (t) { return !M.TABLES[t.table].readOnly; }).map(function (t) { return opt(t.id, t.name + ' (' + M.TABLES[t.table].label + ' ' + t.address + ')', ''); }).join('') || opt('', '— no writable tags (coil / holding) —', '');
        if (ws && keep && cfg.tags.some(function (t) { return t.id === keep && !M.TABLES[t.table].readOnly; })) ws.value = keep;
        var r = q('#mbc_res'); if (r) r.innerHTML = summaryHtml(cfg, errors);
        bar(); live();
    }
    function save(which) {
        var res = M.saveConfig(cfg);
        cfg = res.config || cfg; tagErrors = res.tagErrors || {}; errors = res.errors || [];
        if (monitor) { monitor = null; attachMonitor(); }
        refresh(which || {});
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.modbus = { devices: cfg.devices.length, tags: cfg.tags.length, writesEnabled: cfg.writesEnabled, errors: errors.length };
        return res;
    }
    C.save = save;
    function find(kind, id) { return (kind === 'dev' ? cfg.devices : cfg.tags).filter(function (x) { return x.id === id; })[0]; }
    function setPath(o, path, v) { var p = path.split('.'); for (var i = 0; i < p.length - 1; i++) { o[p[i]] = o[p[i]] || {}; o = o[p[i]]; } o[p[p.length - 1]] = v; }
    var NUMF = /^(port|unit|pollMs|timeoutMs|retries|maxGap|baud|stopBits|address|deadband|logDeadband|logMinMs|scale\.\w+|alarm\.\w+)$/;
    function onChange(ev) {
        var el = ev.target; if (!el || !el.getAttribute) return;
        var k = el.getAttribute('data-k'), f = el.getAttribute('data-f');
        if (!k || !f) return;
        var v = el.type === 'checkbox' ? !!el.checked : el.value;
        var isManual = k === 'sim' && f.indexOf('manual.') === 0;
        if (k === 'guide') {                                // bridge setup options (not part of the Modbus config)
            if (f === 'extra') {                            // applied while typing ('input'); the 'change' on blur
                var nv = String(v).slice(0, 2000);          // then finds nothing new, so a click on Generate /
                if (nv === guide.extra) return;             // Check / Copy that blurred the field is not lost
                guide.extra = nv;
            } else if (ev.type !== 'change') return;
            else if (f === 'autostart' || f === 'writes' || f === 'anyIp') guide[f] = !!v;
            else return;
            guide.genHtml = '';
            updateGuide();
            return;
        }
        if (ev.type !== 'change' && !isManual) return;      // text edits commit on change; sliders preview on input
        if (k === 'cfg') {
            if (f === 'base') {
                var nb = +v === 1 ? 1 : 0;
                // keep every tag's protocol address; a 1-based number that would read as 5-digit PLC
                // notation (e.g. 40002 on a holding register) is written in 6-digit form (440002).
                if (nb !== cfg.base) cfg.tags.forEach(function (t) {
                    var pa = M.protocolAddress(t.address, t.table, cfg.base); if (!isNum(pa)) return;
                    if (!nb) { t.address = pa; return; }
                    t.address = pa + 1;
                    if (M.protocolAddress(t.address, t.table, 1) !== pa) t.address = M.TABLES[t.table].plc * 100000 + pa + 1;
                });
                cfg.base = nb; save({ tag: 1 }); return;
            }
            if (f === 'writesEnabled') {
                if (v && typeof G.confirm === 'function' && !G.confirm('Enable Modbus writes?\n\nThis page will then be able to send write commands (FC05 / 06 / 15 / 16) to the connected equipment. Every write still asks for confirmation.')) { el.checked = false; return; }
                cfg.writesEnabled = !!v; save({}); return;
            }
            return;
        }
        if (k === 'sim') {
            cfg.sim = cfg.sim || { source: 'sim', speed: 1, manual: {} };
            if (f === 'source') { cfg.sim.source = v; if (M.virtualSlave) M.virtualSlave().driver.reset(); save({ slave: 1 }); return; }
            if (f === 'speed') { cfg.sim.speed = +v; save({}); return; }
            if (f.indexOf('manual.') === 0) {
                cfg.sim.manual = cfg.sim.manual || {};
                cfg.sim.manual[f.slice(7)] = el.type === 'checkbox' ? (v ? 1 : 0) : +v;
                var lbl = el.parentNode && el.parentNode.querySelector && el.parentNode.querySelector('.mb-live');
                if (lbl && el.type !== 'checkbox') { var V = M.VAR_BY_KEY[f.slice(7)]; lbl.textContent = fmtVal(+v) + ' ' + (V ? V.unit : ''); }
                if (ev.type === 'change') M.saveConfig(cfg, { keepStation: true });
                return;
            }
            return;
        }
        var id = el.getAttribute('data-id'), o = find(k, id);
        if (!o) return;
        if (NUMF.test(f) && el.type !== 'checkbox') v = v === '' ? (/^alarm\./.test(f) ? null : '') : +v;
        setPath(o, f, v);
        var structural = /^(transport|table|type|scale\.mode|device|link)$/.test(f);
        if (k === 'tag' && f === 'table' && M.TABLES[v].bits) o.type = 'bool';
        if (k === 'tag' && f === 'table' && !M.TABLES[v].bits && o.type === 'bool') o.type = 'uint16';
        if (k === 'tag' && f === 'link' && v && !o.unit) o.unit = M.VAR_BY_KEY[v].unit === 'bbl/d' ? 'BPD' : M.VAR_BY_KEY[v].unit;
        save(structural || k === 'dev' ? (k === 'dev' ? { dev: 1, tag: 1 } : { tag: 1 }) : { none: 1 });
        if (!structural && k === 'tag') {       // keep focus: only refresh the row's error state
            var tr = el.closest && el.closest('tr');
            if (tr) { var e = tagErrors[id]; if (e) { tr.classList.add('mb-err'); tr.setAttribute('title', e.join('; ')); } else { tr.classList.remove('mb-err'); tr.removeAttribute('title'); } }
        }
    }
    function msg(id, html, kind) { var m = q('#' + id); if (m) m.innerHTML = '<span class="mb-q-' + (kind || 'good') + '">' + html + '</span>'; }
    function tempStation(devId) {
        var c2 = JSON.parse(JSON.stringify(cfg));
        if (devId) { c2.devices = c2.devices.filter(function (d) { return d.id === devId; }); c2.tags = c2.tags.filter(function (t) { return t.device === devId; }); }
        return M.createStation(c2);
    }
    function station() { return M.station() || tempStation(); }
    function onClick(ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!b || !root.contains(b)) return;
        var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
        switch (act) {
            case 'dev-add': { var d = M.defaultDevice(); d.name = 'Device ' + (cfg.devices.length + 1); cfg.devices.push(d); save({ dev: 1, tag: 1 }); break; }
            case 'dev-del': {
                var used = cfg.tags.filter(function (t) { return t.device === id; }).length;
                if (used && typeof G.confirm === 'function' && !G.confirm('Delete this device and its ' + used + ' tag(s)?')) return;
                cfg.devices = cfg.devices.filter(function (x) { return x.id !== id; }); cfg.tags = cfg.tags.filter(function (t) { return t.device !== id; }); save({ dev: 1, tag: 1 }); break;
            }
            case 'tag-add': {
                if (!cfg.devices.length) { var d0 = M.defaultDevice(); d0.name = 'Device 1'; cfg.devices.push(d0); }
                var t = M.defaultTag(); t.name = 'TAG_' + (cfg.tags.length + 1); t.device = cfg.devices[0].id;
                var last = cfg.tags[cfg.tags.length - 1];
                if (last && last.device === t.device && last.table === t.table) { var pa = M.protocolAddress(last.address, last.table, cfg.base); if (isNum(pa)) t.address = (cfg.base ? pa + 1 : pa) + M.regCount(last.type); }
                cfg.tags.push(t); save({ dev: 1, tag: 1 }); break;
            }
            case 'tag-del': cfg.tags = cfg.tags.filter(function (x) { return x.id !== id; }); save({ tag: 1 }); break;
            case 'tag-read': {
                var cell = q('[data-live="' + id + '"]'); if (cell) cell.innerHTML = '<span class="mb-q-init">reading…</span>';
                station().testRead(id).then(function (r) {
                    var t = find('tag', id), V = t && M.VAR_BY_KEY[t.link];
                    var txt = 'raw ' + fmtVal(r.raw) + ' → ' + fmtVal(r.value) + (t && t.unit ? ' ' + t.unit : '') + (V && r.canon != null ? (isNum(r.canon) ? ' (' + fmtVal(r.canon) + ' ' + V.unit + ')' : ' (unit mismatch)') : '');
                    if (cell) cell.innerHTML = '<span class="mb-q-good">' + esc(txt) + '</span>';
                    C.lastTestRead = r;
                }, function (e) { if (cell) cell.innerHTML = '<span class="mb-q-bad">' + esc(e.message) + '</span>'; C.lastTestRead = { error: e.message }; });
                break;
            }
            case 'dev-test': {
                var cellD = q('[data-devstat="' + id + '"]'); if (cellD) cellD.innerHTML = '<span class="mb-dot connecting"></span> testing…';
                var ts = tempStation(id);
                ts.pollNow().then(function () {
                    var info = ts.devices()[0] || {}, v = ts.values(), n = 0, bad = 0;
                    Object.keys(v).forEach(function (k2) { n++; if (v[k2].q === 'bad') bad++; });
                    var ok = info.status === 'online' && !bad;
                    if (cellD) cellD.innerHTML = '<span class="mb-dot ' + (ok ? 'online' : 'error') + '"></span> ' + (ok ? 'OK — ' + n + ' tags in ' + info.blocks + ' block read(s)' : esc(info.lastErr || (bad + ' of ' + n + ' tags failed')));
                    C.lastDevTest = { ok: ok, info: info, tags: n, bad: bad };
                    ts.dispose();
                }, function (e) { if (cellD) cellD.innerHTML = '<span class="mb-dot error"></span> ' + esc(e.message); ts.dispose(); });
                break;
            }
            case 'demo':
                if (cfg.tags.length && typeof G.confirm === 'function' && !G.confirm('Replace the current configuration with the simulator demo?')) return;
                cfg = M.demoConfig(); save({ dev: 1, tag: 1, slave: 1 }); msg('mbc_imsg', '✓ Simulator demo loaded: 1 device, ' + cfg.tags.length + ' tags.'); break;
            case 'clear':
                if (typeof G.confirm === 'function' && !G.confirm('Remove all devices and tags?')) return;
                cfg = M.defaultConfig(); save({ dev: 1, tag: 1, slave: 1 }); break;
            case 'exp-json': download('modbus-config.json', JSON.stringify(cfg, null, 2), 'application/json'); break;
            case 'exp-csv': download('modbus-tags.csv', M.tagsToCsv(cfg), 'text/csv'); break;
            case 'imp-json': case 'imp-csv': { pendingImport = act; var f = q('[data-role="file"]'); if (f) { f.value = ''; f.click(); } break; }
            case 'write': doWrite(); break;
            case 'guide-os': guide.os = /^(windows|macos|linux)$/.test(b.getAttribute('data-os')) ? b.getAttribute('data-os') : guide.os; guide.genHtml = ''; renderGuide(); break;
            case 'guide-copy': C.lastCopy = copyText(b.getAttribute('data-copy') || '', b); break;
            case 'guide-pack': C.downloadPackage(); break;
            case 'guide-installer': C.generateInstaller(); break;
            case 'guide-check': C.checkBridge(); break;
            case 'monitor': if (monitor) detachMonitor(); else attachMonitor(); bar(); break;
            case 'pause': M.setPaused(!M.getConfig().paused); cfg.paused = M.getConfig().paused; bar(); refresh({}); break;
            case 'pollnow': { var s = M.station(); if (s) s.pollNow().then(live); break; }
        }
    }
    C.importText = function (text, kind) {
        if (kind === 'imp-csv' || kind === 'csv') {
            var r = M.tagsFromCsv(text, cfg);
            if (!r.tags.length) { msg('mbc_imsg', '✗ ' + esc(r.errors.join('; ') || 'no rows'), 'bad'); return { ok: false, errors: r.errors }; }
            cfg.tags = cfg.tags.concat(r.tags); var res = save({ tag: 1 });
            msg('mbc_imsg', '✓ Imported ' + r.tags.length + ' tag(s)' + (r.errors.length ? ' — ' + esc(r.errors.join('; ')) : '') + '.');
            return { ok: true, count: r.tags.length, errors: r.errors.concat(res.errors || []) };
        }
        var obj; try { obj = JSON.parse(text); } catch (e) { msg('mbc_imsg', '✗ Not valid JSON: ' + esc(e.message), 'bad'); return { ok: false, errors: [e.message] }; }
        var n = M.normalizeConfig(obj);
        cfg = n.config; var res2 = save({ dev: 1, tag: 1, slave: 1 });
        msg('mbc_imsg', '✓ Imported ' + cfg.devices.length + ' device(s), ' + cfg.tags.length + ' tag(s)' + (res2.errors.length ? ' — ' + res2.errors.length + ' issue(s), see the summary' : '') + '.');
        return { ok: true, errors: res2.errors };
    };
    function onFile(ev) {
        var f = ev.target && ev.target.files && ev.target.files[0];
        if (!f || !pendingImport) return;
        var kind = /\.csv$/i.test(f.name) ? 'imp-csv' : pendingImport, rd = new FileReader();
        rd.onload = function () { C.importText(String(rd.result || ''), kind); };
        rd.readAsText(f);
    }
    function doWrite() {
        var tid = (q('#mbc_wtag_sel') || {}).value, val = parseFloat((q('[data-role="wval"]') || {}).value);
        if (!cfg.writesEnabled) { msg('mbc_wmsg', '✗ Writes are disabled. Tick "Enable writes" first.', 'bad'); return Promise.resolve(false); }
        var t = find('tag', tid);
        if (!t || !isFinite(val)) { msg('mbc_wmsg', '✗ Choose a writable tag and a numeric value.', 'bad'); return Promise.resolve(false); }
        var dn = (find('dev', t.device) || {}).name || '';
        if (typeof G.confirm === 'function' && !G.confirm('Write ' + val + (t.unit ? ' ' + t.unit : '') + ' to ' + t.name + '?\n\nDevice: ' + dn + ', ' + M.TABLES[t.table].label + ' ' + t.address + '.')) { msg('mbc_wmsg', 'Write cancelled.', 'init'); return Promise.resolve(false); }
        return station().write(tid, val, { confirmed: true }).then(function () { msg('mbc_wmsg', '✓ Wrote ' + esc(val) + ' to ' + esc(t.name) + '.'); return true; },
            function (e) { msg('mbc_wmsg', '✗ ' + esc(e.message), 'bad'); return false; });
    }
    C.doWrite = doWrite;
    // ── bridge setup guide actions ──
    function guideMsg(id, html) { var m = q('#' + id); if (m) m.innerHTML = html; }
    C.downloadPackage = function () {
        var S = G.WTS_modbusBridgeSetup, z = S && S.packageZip();
        if (!z) { guideMsg('mbc_guide_gen', '<span class="mb-q-bad">✗ The bridge package is not bundled in this build.</span>'); return null; }
        download(z.filename, z.bytes, 'application/zip');
        C.lastPackage = z;
        return z;
    };
    C.generateInstaller = function () {
        var S = G.WTS_modbusBridgeSetup;
        if (!S) return null;
        var r = S.installerFromConfig(cfg, guide.os, { extra: guide.extra, anyIp: guide.anyIp, allowWrites: guide.writes, autostart: guide.autostart });
        C.lastInstaller = r;
        if (!r.ok) {
            guide.genHtml = '<div class="mb-q-bad">✗ No installer generated:</div>' + listHtml(r.errors);
        } else {
            download(r.filename, r.text, r.type);
            guide.genHtml = '<div class="mb-q-good">✓ Downloaded ' + esc(r.filename) + ' — bridge v' + esc(r.version) + ', ' + r.allow.length + ' target' + (r.allow.length === 1 ? '' : 's') +
                ' (' + esc(r.allow.join(', ')) + '), port ' + r.port + (guide.autostart ? ', auto-start' : '') + (guide.writes ? ', writes allowed' : ', read-only') + '. Run it with the command below.</div>';
        }
        guideMsg('mbc_guide_gen', guide.genHtml);
        return r;
    };
    C.checkBridge = function () {
        var S = G.WTS_modbusBridgeSetup;
        if (!S) return Promise.resolve(null);
        guide.checkHtml = '<div class="mb-q-init">Checking…</div>';
        guideMsg('mbc_guide_check', guide.checkHtml);
        return S.checkBridge(cfg, {}).then(function (r) {
            C.lastCheck = r;
            guide.checkHtml = checkResultHtml(r, cfg);
            if (!disposed) guideMsg('mbc_guide_check', guide.checkHtml);
            return r;
        });
    };
    function bar() {
        var b = q('#mbc_bar'); if (!b) return;
        var s = M.station(), paused = M.getConfig().paused, devs = s ? s.devices() : [];
        b.innerHTML = '<button class="btn ' + (monitor ? 'btn-secondary' : 'btn-primary') + ' mb-btn-s" data-act="monitor">' + (monitor ? '■ Stop live monitor' : '▶ Start live monitor') + '</button>' +
            '<button class="btn btn-secondary mb-btn-s" data-act="pause">' + (paused ? '▶ Resume polling' : '❚❚ Pause polling') + '</button>' +
            (monitor ? '<button class="btn btn-secondary mb-btn-s" data-act="pollnow">Poll now</button>' : '') +
            devs.map(function (d) { return '<span class="mb-pill"><span class="mb-dot ' + esc(d.status) + '"></span>' + esc(d.name) + ' · ' + esc(d.status) + (d.lastOk ? ' · ' + fmtTime(d.lastOk) : '') + '</span>'; }).join('') +
            (paused ? '<span class="mb-pill"><span class="mb-dot paused"></span>Polling paused</span>' : '');
    }
    function live() {
        var s = M.station(); if (!s) return;
        var v = s.values();
        Object.keys(v).forEach(function (id) {
            var cell = q('[data-live="' + id + '"]'), r = v[id]; if (!cell) return;
            var t = s.tag(id), V = t && M.VAR_BY_KEY[t.link];
            var txt = r.q === 'init' ? '—' : (isNum(r.value) ? fmtVal(r.value) : '—') + (t && t.unit ? ' ' + t.unit : '') + (r.q !== 'good' ? ' · ' + r.q : '') + (r.unitErr ? ' · unit?' : '');
            if (V && V.kind === 'bool' && r.q !== 'init') txt = (r.value ? 'ON' : 'OFF') + (r.q !== 'good' ? ' · ' + r.q : '');
            cell.innerHTML = '<span class="mb-q-' + esc(r.q) + '" title="' + esc(r.err || '') + '">' + esc(txt) + '</span>';
        });
        s.devices().forEach(function (d) {
            var cell = q('[data-devstat="' + d.id + '"]'); if (!cell) return;
            cell.innerHTML = '<span class="mb-dot ' + esc(d.status) + '"></span> ' + esc(d.status) + (d.lastErr ? ' — ' + esc(d.lastErr) : d.lastOk ? ' · ' + fmtTime(d.lastOk) : '');
        });
    }
    var onPoll = function () { if (!disposed) { live(); bar(); } };
    function attachMonitor() {
        monitor = M.acquire(OWNER);
        monitor.on('poll', onPoll); monitor.on('status', onPoll);
        bar();
    }
    function detachMonitor() {
        if (monitor) { monitor.off('poll', onPoll); monitor.off('status', onPoll); }
        monitor = null; M.release(OWNER); bar();
    }
    C.startMonitor = attachMonitor; C.stopMonitor = detachMonitor;
    C.config = function () { return cfg; };
    function onPage(e) { if (!root.isConnected || (e && e.detail && e.detail.page !== 'modbus')) C.dispose(); }
    function onProject() { if (root.isConnected && typeof G.WTS_rerender !== 'function') { cfg = M.getConfig(); refresh(); } }
    root.addEventListener('change', onChange);
    root.addEventListener('input', onChange);
    root.addEventListener('click', onClick);
    var fileEl = root.querySelector('[data-role="file"]'); if (fileEl) fileEl.addEventListener('change', onFile);
    document.addEventListener('h2oil:pagechange', onPage);
    document.addEventListener('wts:project-loaded', onProject);
    C.dispose = function () {
        if (disposed) return; disposed = true;
        if (monitor) detachMonitor();
        root.removeEventListener('change', onChange); root.removeEventListener('input', onChange); root.removeEventListener('click', onClick);
        document.removeEventListener('h2oil:pagechange', onPage);
        document.removeEventListener('wts:project-loaded', onProject);
        if (ctl === C) ctl = null;
    };
    refresh();          // everything: devices, tags, simulator, guide, summary (refresh({}) left the tables empty)
    G.WTS_state = G.WTS_state || {};
    G.WTS_state.modbus = { devices: cfg.devices.length, tags: cfg.tags.length, writesEnabled: cfg.writesEnabled, errors: errors.length };
    return C;
}

// calc<X> hook (host units wrapper convention): refresh the summary.
G.calcModbusConfig = function () { if (ctl) { var r = byId('mbc_res'); return !!r; } return false; };
M.page = { controller: function () { return ctl; } };

G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.modbus = {
    key: 'modbus', title: 'Modbus Configuration', navTitle: 'Modbus Config',
    sub: 'Modbus TCP / RTU devices, tags, scaling, alarms and links to well-test variables',
    group: 'Live Data', icon: '&#8646;', badge: 'Live Data', bc: 'dc-b-blue',
    desc: 'Connect PLCs and RTUs over Modbus TCP (bridge / iOS) or RTU (Web Serial), or the built-in simulator.',
    render: render
};
})();

// ─── END 62-modbus-page ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 63-wellos ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 63-wellos.js — Mini WellOS (route `wellos`, its own sidebar group "Mini WellOS")
// -----------------------------------------------------------------------------
// SCADA-style live view of a surface well-test spread: KPI tiles, 3D process
// view (the Round-7 WTS_3d handle driven by this page's own data feed), 2D P&ID
// (host wtsDrawDiag) + levels / valves panel, live variable chips with quality,
// trends with time windows, ISA-18.2 alarm list with acknowledge, events, CSV
// logging, "Send to PRiSM" of a pressure trend, historian hook.
//
// Data source toggle:
//   Form data   — a private WTS_sim instance fed with the Well Test Simulator
//                 form flow (WTS_state.flow) or the sample flow.
//   Modbus data — the tags linked to app variables on the Modbus page (shared
//                 WTS_modbus station), with per-tag quality (good / stale / bad),
//                 per-device comms status and last update. The 3D / 2D views are
//                 animated from a frozen base snapshot with the live values applied
//                 (WTS_modbus.applyVarsToState), so unmapped values never move.
//
// Read-only use of Round-7 public APIs: WTS_sim.create, WTS_3d.mount / isSupported,
// WTS_live.liveNodes / liveSegs / fmtU / fmtParts / unitsConv, window.wtsDrawDiag.
// Timers: one requestAnimationFrame loop while the page is open and visible, plus
// the station's poll timers in Modbus mode — all stopped when the page closes.
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
var M = G.WTS_modbus;
if (!M || !M.VARS) return;

var OWNER = 'wellos', UI_KEY = 'wts_wellos_ui';
var WINDOWS = [[300, '5 min'], [1800, '30 min'], [7200, '2 h'], [43200, '12 h']];
var PRESSURE_KEYS = ['bhp', 'whp', 'sep_p', 'choke_dn_p', 'surge_p', 'flare_p'];
var KPI_KEYS = ['whp', 'bhp', 'sep_p', 'gas_rate', 'oil_rate', 'water_rate', 'gor', 'wcut', 'flare_rate'];
var ctl = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function nowMs() { try { if (G.performance && typeof G.performance.now === 'function') return G.performance.now(); } catch (e) {} return Date.now(); }
function pad(x) { return x < 10 ? '0' + x : '' + x; }
function hms(t) { if (!t) return '—'; var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function readUi() {
    var u = { source: 'form', view: '3d', win: 1800, trend: ['whp', 'sep_p', 'gas_rate', 'oil_rate'], speed: 1, prism: 'whp' };
    try { var o = JSON.parse((G.localStorage && G.localStorage.getItem(UI_KEY)) || 'null');
        if (o && typeof o === 'object') {
            if (o.source === 'form' || o.source === 'modbus') u.source = o.source;
            if (o.view === '3d' || o.view === '2d') u.view = o.view;
            if (WINDOWS.some(function (w) { return w[0] === +o.win; })) u.win = +o.win;
            if (Array.isArray(o.trend)) u.trend = o.trend.filter(function (k) { return M.VAR_BY_KEY[k] && M.VAR_BY_KEY[k].kind !== 'bool'; }).slice(0, 6);
            if ([1, 10, 60].indexOf(+o.speed) >= 0) u.speed = +o.speed;
            if (PRESSURE_KEYS.indexOf(o.prism) >= 0) u.prism = o.prism;
        } } catch (e) {}
    return u;
}
function writeUi(u) { try { if (G.localStorage) G.localStorage.setItem(UI_KEY, JSON.stringify(u)); } catch (e) {} }

// ─── display formatting (field units in, WTS_units display out) ─────────────
var BOOL_TXT = { esd_open: ['OPEN', 'CLOSED'], esd_tripped: ['TRIPPED', 'NORMAL'], pump_running: ['RUNNING', 'STOPPED'], heater_bypass: ['OPEN', 'SHUT'] };
function unitLabel(V) {
    if (!V) return '';
    if (V.key === 'oil_rate') return 'STB/d';
    if (V.cat === 'liquidRate') return 'BPD';
    return V.unit || '';
}
function dpFor(x) { var a = Math.abs(x); return a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 1 : 2; }
function fmtNumber(x, dp) { if (!isNum(x)) return '—'; var s = x.toFixed(dp == null ? dpFor(x) : dp); return Math.abs(x) >= 10000 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s; }
function disp(v, V) {
    if (!V) return { v: isNum(v) ? fmtNumber(v) : '—', u: '' };
    if (V.kind === 'bool') { var t = BOOL_TXT[V.key] || ['OPEN', 'SHUT']; return { v: v == null ? '—' : (v ? t[0] : t[1]), u: '' }; }
    var U = G.WTS_units, cat = V.cat;
    if (isNum(v) && U && typeof U.getSystem === 'function' && U.getSystem() === 'metric' && U.CATEGORIES && U.CATEGORIES[cat] && typeof U.format === 'function') {
        try { var f = U.format(v, cat); if (f && isNum(+f.value)) return { v: fmtNumber(+f.value), u: f.label }; } catch (e) {}
    }
    return { v: isNum(v) ? fmtNumber(v) : '—', u: unitLabel(V) };
}
var DERIVED = {
    gor: { key: 'gor', label: 'GOR', unit: 'scf/STB', calc: function (x) { return isNum(x.gas_rate) && isNum(x.oil_rate) && x.oil_rate > 0.5 ? x.gas_rate * 1e6 / x.oil_rate : null; } },
    wcut: { key: 'wcut', label: 'Water cut', unit: '%', calc: function (x) { return isNum(x.water_rate) && isNum(x.oil_rate) && x.water_rate + x.oil_rate > 0 ? 100 * x.water_rate / (x.water_rate + x.oil_rate) : null; } }
};

function injectCss() {
    if (typeof document === 'undefined' || byId('wts-wellos-css')) return;
    var s = document.createElement('style');
    s.id = 'wts-wellos-css';
    s.textContent = [
        '.wos{--wos-panel:#0b111a;--wos-line:#1d2a3a}',
        '.wos-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--wos-panel);border:1px solid var(--wos-line);border-radius:8px;padding:8px 10px;margin-bottom:12px}',
        '.wos-brand{font-weight:800;letter-spacing:1.5px;color:var(--accent);font-size:13px;margin-right:6px}',
        '.wos-clock{font-family:"Courier New",monospace;font-size:12px;color:var(--text2);margin-right:auto}',
        '.wos-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}',
        '.wos-seg button{background:var(--bg1);color:var(--text2);border:0;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer}',
        '.wos-seg button.on{background:var(--accent);color:#fff}',
        '.wos-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:12px;border:1px solid var(--border);font-size:11px;font-weight:600;background:var(--bg1);color:var(--text2);cursor:default}',
        '.wos-pill.alarm{border-color:var(--red);color:var(--red);cursor:pointer}.wos-pill.warn{border-color:var(--orange,#d29922);color:var(--orange,#d29922);cursor:pointer}',
        '.wos-dot{width:8px;height:8px;border-radius:50%;background:var(--text3);display:inline-block}',
        '.wos-dot.online,.wos-dot.good{background:var(--green)}.wos-dot.error,.wos-dot.bad{background:var(--red)}.wos-dot.connecting,.wos-dot.paused,.wos-dot.stale{background:var(--orange,#d29922)}',
        '.wos-btn{padding:5px 10px;font-size:11px}',
        '.wos-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:12px}',
        '.wos .kpi{background:var(--wos-panel);border:1px solid var(--wos-line);border-radius:8px;padding:8px 10px;border-left:3px solid var(--green)}',
        '.wos .kpi.q-stale{border-left-color:var(--orange,#d29922)}.wos .kpi.q-bad{border-left-color:var(--red)}.wos .kpi.q-unmapped{border-left-color:var(--text3);opacity:.7}',
        '.wos .kpi-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3)}',
        '.wos .kpi-v{font-family:"Courier New",monospace;font-size:20px;font-weight:700;color:var(--text)}.wos .kpi-u{font-size:11px;color:var(--text2);margin-left:4px}',
        '.wos-grid{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(260px,1fr);gap:12px}',
        '@media (max-width:1100px){.wos-grid{grid-template-columns:1fr}}',
        '.wos-stage{position:relative;background:var(--wos-panel);border:1px solid var(--wos-line);border-radius:8px;overflow:hidden}',
        '.wos-3d{width:100%;height:420px;position:relative}',
        '@media (max-width:700px){.wos-3d{height:300px}}',
        '.wos-stage canvas.wos-cv{width:100%;display:block}',
        '.wos-note{position:absolute;left:10px;top:8px;font-size:11px;color:var(--text2);background:rgba(11,17,26,.8);padding:3px 8px;border-radius:6px;z-index:2}',
        '.wos-src{position:absolute;right:10px;top:8px;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;z-index:2;background:rgba(11,17,26,.85)}',
        '.wos-chips{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px}',
        '.wos-chip{background:var(--wos-panel);border:1px solid var(--wos-line);border-left:3px solid var(--green);border-radius:6px;padding:5px 8px;font-size:11px;min-width:0}',
        '.wos-chip.q-stale{border-left-color:var(--orange,#d29922)}.wos-chip.q-bad{border-left-color:var(--red)}.wos-chip.q-unmapped{border-left-color:var(--text3);opacity:.6}',
        '.wos-chip .l{color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wos-chip .v{font-family:"Courier New",monospace;font-size:14px;font-weight:700;color:var(--text)}',
        '.wos-chip .s{color:var(--text3);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.wos-grp{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text3);margin:10px 0 4px}',
        '.wos-alarms{max-height:300px;overflow:auto}',
        '.wos-al{display:grid;grid-template-columns:auto 1fr auto;gap:6px;align-items:center;padding:5px 6px;border-bottom:1px solid var(--border);font-size:12px}',
        '.wos-al .sev{font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:var(--bg1)}',
        '.wos-al.alarm .sev{color:#fff;background:var(--red)}.wos-al.warn .sev{color:#111;background:var(--orange,#d29922)}.wos-al.info .sev{color:var(--text2)}',
        '.wos-al.UNACK.active{animation:wosblink 1s steps(2,start) infinite}',
        '@keyframes wosblink{to{background:rgba(248,81,73,.12)}}',
        '@media (prefers-reduced-motion:reduce){.wos-al.UNACK.active{animation:none;background:rgba(248,81,73,.12)}}',
        '.wos-ev{font-size:11px;color:var(--text2);font-family:"Courier New",monospace;max-height:180px;overflow:auto;white-space:pre-wrap}',
        '.wos-tsel{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.wos-tsel label{font-size:11px;display:inline-flex;gap:4px;align-items:center;background:var(--bg1);border:1px solid var(--border);border-radius:12px;padding:2px 8px}',
        '.wos-banner{background:rgba(88,166,255,.06);border:1px solid rgba(88,166,255,.2);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--blue);margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
        '.wos-msg{font-size:12px;margin-top:8px}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
}

// ─── markup ─────────────────────────────────────────────────────────────────
function pageHtml(u) {
    var trendSel = M.VARS.filter(function (V) { return V.kind !== 'bool'; }).map(function (V) {
        return '<label><input type="checkbox" data-trend="' + V.key + '"' + (u.trend.indexOf(V.key) >= 0 ? ' checked' : '') + '>' + esc(V.label.replace(/ \(.*\)$/, '')) + '</label>';
    }).join('');
    return '<div id="wos_root" class="wos" data-no-persist>' +
        '<div class="wos-head" id="wos_head"></div>' +
        '<div id="wos_banner"></div>' +
        '<div class="wos-kpis" id="wos_kpis"></div>' +
        '<div class="wos-grid"><div>' +
        '<div class="wos-stage" id="wos_stage"><div class="wos-note" id="wos_note"></div><div class="wos-src" id="wos_srcflag"></div>' +
        '<div class="wos-3d" id="wos_3d"></div>' +
        '<canvas id="wts_cv" class="wos-cv" width="1200" height="340" hidden></canvas></div>' +
        '<div class="wos-stage" style="margin-top:8px"><canvas id="wos_lv" class="wos-cv" width="1200" height="230"></canvas></div>' +
        '<div class="card" style="margin-top:12px"><div class="card-title">Trends</div>' +
        '<div class="mb-bar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">' + WINDOWS.map(function (w) { return '<button class="btn btn-secondary wos-btn' + (u.win === w[0] ? ' wos-on' : '') + '" data-act="win" data-win="' + w[0] + '"' + (u.win === w[0] ? ' style="border-color:var(--accent);color:var(--accent)"' : '') + '>' + w[1] + '</button>'; }).join('') + '</div>' +
        '<div class="wos-tsel">' + trendSel + '</div>' +
        '<div class="chart-wrap"><canvas id="wos_trend" width="1100" height="300"></canvas></div></div>' +
        '</div><div>' +
        '<div class="card" id="wos_alcard"><div class="card-title">Alarms <span id="wos_alcount" style="float:right;font-weight:600"></span></div>' +
        '<div class="btn-row" style="margin-top:0;margin-bottom:8px"><button class="btn btn-secondary wos-btn" data-act="ackall">Acknowledge all</button></div>' +
        '<div class="wos-alarms" id="wos_alarms"></div><div class="wos-grp">Events</div><div class="wos-ev" id="wos_events"></div></div>' +
        '<div class="card"><div class="card-title">CSV logging</div><div id="wos_log"></div></div>' +
        '<div class="card"><div class="card-title">Send to PRiSM</div><div class="fg"><div class="fg-item"><label>Pressure gauge</label><select data-role="prism-var">' +
        PRESSURE_KEYS.map(function (k) { return '<option value="' + k + '"' + (u.prism === k ? ' selected' : '') + '>' + esc(M.VAR_BY_KEY[k].label) + '</option>'; }).join('') + '</select></div></div>' +
        '<div class="btn-row"><button class="btn btn-primary wos-btn" data-act="prism">Send trend window to PRiSM</button></div><div class="wos-msg" id="wos_prism_msg"></div></div>' +
        '<div class="card" id="wos_hist"><div class="card-title">Historian</div><div id="wos_hist_body"></div></div>' +
        '</div></div>' +
        '<div class="card" style="margin-top:12px"><div class="card-title">Live variables</div><div id="wos_chips"></div></div>' +
        '<div style="font-size:12px;color:var(--text2);margin-top:8px"><div><b>Notes</b> Form data runs the Well Test Simulator model from the simulator page inputs (or the sample well). Modbus data shows the tags linked on the Modbus page, converted to field units; quality: good = fresh, stale = no update for 3 poll intervals, bad = comms error / exception / unit mismatch, — = not linked. In Modbus mode the 3D and 2D views keep the last form snapshot for anything not linked. GOR = gas rate ÷ oil rate; water cut = water ÷ (water + oil) rate, both from the rates shown. Representative equipment; not a safety system.</div></div>' +
        '</div>';
}

// ─── controller ─────────────────────────────────────────────────────────────
function createController(root) {
    var u = readUi(), C = { root: root }, disposed = false;
    var model = M.makeFormModel({ seed: 5 }), formHist = {}, formAlarms = M.createAlarmManager(), formPrev = {};
    var station = null, boundStation = null, modbusState = null, baseSnap = null;
    var h3 = null, h3tok = 0, h3failed = false, raf = 0, last = 0, tUi = 0, tSlow = 0, tSample = 0, dirty = true;
    var logger = { on: false, rows: [], cols: null, max: 200000 }, alSig = '', evSig = '';
    M.VARS.forEach(function (V) { formHist[V.key] = M.makeHistory(); });
    function q(sel) { return root.querySelector(sel); }

    // ── data access ──
    function current() {
        var vals = {}, qual = {}, src = {}, ts = {};
        if (u.source === 'form') {
            var fv = model.values();
            M.VARS.forEach(function (V) {
                var x = fv[V.key];
                vals[V.key] = x; qual[V.key] = x == null ? 'unmapped' : 'good'; src[V.key] = x == null ? 'not in the form model' : 'form';
            });
        } else {
            var s = station;
            M.VARS.forEach(function (V) {
                var x = s ? s.getVar(V.key) : null;
                if (!x) { vals[V.key] = null; qual[V.key] = 'unmapped'; src[V.key] = 'not linked'; return; }
                qual[V.key] = x.q === 'init' ? 'stale' : x.q;
                vals[V.key] = x.q === 'bad' || x.q === 'init' ? null : x.value;
                src[V.key] = x.tag + (x.err ? ' — ' + x.err : '') + (x.q === 'init' ? ' — waiting' : '');
                ts[V.key] = x.ts;
            });
        }
        Object.keys(DERIVED).forEach(function (k) {
            var D = DERIVED[k]; vals[k] = D.calc(vals);
            var qa = qual.gas_rate, qb = qual.oil_rate, qc = qual.water_rate, deps = k === 'gor' ? [qa, qb] : [qc, qb];
            qual[k] = deps.indexOf('unmapped') >= 0 ? 'unmapped' : deps.indexOf('bad') >= 0 ? 'bad' : deps.indexOf('stale') >= 0 ? 'stale' : 'good';
            if (vals[k] == null && qual[k] === 'good') qual[k] = 'unmapped';
            src[k] = 'calculated';
        });
        return { vals: vals, q: qual, src: src, ts: ts };
    }
    C.current = current;
    function displayState() {
        if (u.source === 'form') return model.state();
        return modbusState || baseSnap || model.state();
    }
    C.displayState = displayState;
    function bindStation() {
        var s = u.source === 'modbus' ? M.station() : null;
        if (s === boundStation) return;
        if (boundStation) { boundStation.off('poll', onPoll); boundStation.off('status', onStatus); }
        boundStation = s; station = s;
        if (s) { s.on('poll', onPoll); s.on('status', onStatus); }
    }
    function onPoll(ev) {
        if (disposed) return;
        var lv = station ? station.linkedValues() : {};
        modbusState = M.applyVarsToState(baseSnap || model.state(), lv);
        if (logger.on) logRow();
        dirty = true;
    }
    function onStatus() { dirty = true; }
    function setSource(src) {
        if (src === u.source && (src === 'form' || station)) return;
        u.source = src; writeUi(u);
        if (src === 'modbus') {
            baseSnap = JSON.parse(JSON.stringify(model.state() || {}));
            modbusState = null;
            M.acquire(OWNER); bindStation();
        } else {
            if (boundStation) { boundStation.off('poll', onPoll); boundStation.off('status', onStatus); }
            boundStation = null; station = null; modbusState = null;
            M.release(OWNER);
        }
        if (logger.on) { logger.on = false; logger.note = 'Logging stopped — data source changed.'; }
        alSig = ''; evSig = ''; dirty = true;
        renderHead(); renderBanner(); renderLog(); updateUi(true);
        G.WTS_state = G.WTS_state || {}; G.WTS_state.wellos = { source: u.source };
        try { document.dispatchEvent(new CustomEvent('wts:wellos-source', { detail: { source: u.source } })); } catch (e) {}
    }
    C.setSource = setSource;
    function alarmsMgr() { return u.source === 'modbus' ? (station ? station.alarms : null) : formAlarms; }
    C.alarms = alarmsMgr;

    // ── form mode sampling (1 Hz): history, sim alarms → ISA-18.2 list, historian ──
    var SIM_LVL = { trip: 'ALARM', alarm: 'ALARM', warn: 'WARN', hyd: 'WARN', info: 'INFO' };
    function formSample(t) {
        var fv = model.values(), st = model.state();
        M.VARS.forEach(function (V) { if (fv[V.key] != null) formHist[V.key].push(t, fv[V.key]); });
        var seen = {};
        ((st && st.alarms) || []).forEach(function (a) {
            if (!a || !a.id) return; seen[a.id] = 1;
            formAlarms.update('sim:' + a.id, SIM_LVL[a.sev] || 'WARN', { t: t, tag: a.tag || a.id, device: 'form', value: a.value, limit: a.limit, msg: a.msg || '' });
        });
        Object.keys(formPrev).forEach(function (id) { if (!seen[id]) formAlarms.update('sim:' + id, null, { t: t }); });
        formPrev = seen;
        var batch = [];
        M.VARS.forEach(function (V) { var x = fv[V.key]; if (x == null) return; batch.push({ tag: V.key, device: 'form', t: t, v: x, q: 'good', raw: null, unit: unitLabel(V) }); });
        M.publishSamples(batch);
        if (logger.on) logRow();
    }
    C.formSample = formSample;

    // ── header / banner ──
    function renderHead() {
        var h = q('#wos_head'); if (!h) return;
        var cfg = M.getConfig(), hasHist = !!(typeof document !== 'undefined' && document.querySelector('.nav-btn[data-p="historian"]'));
        h.innerHTML = '<span class="wos-brand">MINI WELLOS</span><span class="wos-clock" id="wos_clock">' + hms(Date.now()) + '</span>' +
            '<span class="wos-seg" role="group" aria-label="Data source"><button data-act="src" data-src="form" class="' + (u.source === 'form' ? 'on' : '') + '">Form data</button><button data-act="src" data-src="modbus" class="' + (u.source === 'modbus' ? 'on' : '') + '">Modbus data</button></span>' +
            '<span id="wos_comms"></span>' +
            (u.source === 'modbus' ? '<button class="btn btn-secondary wos-btn" data-act="pause">' + (cfg.paused ? '▶ Resume polling' : '❚❚ Pause polling') + '</button>' : '<span class="wos-seg"><button data-act="speed" data-speed="1" class="' + (u.speed === 1 ? 'on' : '') + '">1×</button><button data-act="speed" data-speed="10" class="' + (u.speed === 10 ? 'on' : '') + '">10×</button><button data-act="speed" data-speed="60" class="' + (u.speed === 60 ? 'on' : '') + '">60×</button></span>') +
            '<span id="wos_alpill"></span>' +
            '<span class="wos-seg"><button data-act="view" data-view="3d" class="' + (u.view === '3d' ? 'on' : '') + '">3D</button><button data-act="view" data-view="2d" class="' + (u.view === '2d' ? 'on' : '') + '">2D</button></span>' +
            '<button class="btn btn-secondary wos-btn" data-act="goto" data-p="modbus">Modbus config</button>' +
            (hasHist ? '<button class="btn btn-secondary wos-btn" data-act="goto" data-p="historian">Historian</button>' : '');
    }
    function renderBanner() {
        var b = q('#wos_banner'); if (!b) return;
        var cfg = M.getConfig();
        if (u.source === 'modbus' && !cfg.tags.some(function (t) { return !!t.link; })) {
            b.innerHTML = '<div class="wos-banner">No Modbus tags are linked to app variables yet. <button class="btn btn-primary wos-btn" data-act="demo">Use the Modbus simulator demo</button><button class="btn btn-secondary wos-btn" data-act="goto" data-p="modbus">Open Modbus config</button></div>';
        } else b.innerHTML = '';
    }
    function renderComms() {
        var c = q('#wos_comms'); if (!c) return;
        if (u.source !== 'modbus') { c.innerHTML = '<span class="wos-pill"><span class="wos-dot good"></span>Form data · simulator model</span>'; return; }
        var devs = station ? station.devices() : [], cfg = M.getConfig();
        c.innerHTML = (devs.length ? devs.map(function (d) {
            return '<span class="wos-pill" title="' + esc(d.lastErr || '') + '"><span class="wos-dot ' + esc(d.status) + '"></span>' + esc(d.name) + ' · ' + esc(d.status) + ' · ' + (d.lastOk ? 'last ' + hms(d.lastOk) : 'no data') + '</span> ';
        }).join('') : '<span class="wos-pill"><span class="wos-dot"></span>No Modbus devices</span>') + (cfg.paused ? '<span class="wos-pill"><span class="wos-dot paused"></span>Polling paused</span>' : '');
    }

    // ── KPIs / chips ──
    function renderKpis(cur) {
        var k = q('#wos_kpis'); if (!k) return;
        k.innerHTML = KPI_KEYS.map(function (key) {
            var V = M.VAR_BY_KEY[key], D = DERIVED[key], d = D ? { v: isNum(cur.vals[key]) ? fmtNumber(cur.vals[key], key === 'gor' ? 0 : 1) : '—', u: D.unit } : disp(cur.vals[key], V);
            var lbl = D ? D.label : V.label.replace(/ \(.*\)$/, '');
            return '<div class="kpi q-' + esc(cur.q[key]) + '" title="' + esc(cur.src[key] || '') + '"><div class="kpi-l">' + esc(lbl) + '</div><div class="kpi-v">' + esc(d.v) + '<span class="kpi-u">' + esc(d.u) + '</span></div></div>';
        }).join('');
    }
    function renderChips(cur) {
        var c = q('#wos_chips'); if (!c) return;
        var grp = null, html = '';
        M.VARS.forEach(function (V) {
            if (V.group !== grp) { if (grp) html += '</div>'; grp = V.group; html += '<div class="wos-grp">' + esc(grp) + '</div><div class="wos-chips">'; }
            var d = disp(cur.vals[V.key], V), age = cur.ts[V.key] ? Math.max(0, Math.round((Date.now() - cur.ts[V.key]) / 1000)) + ' s ago' : '';
            html += '<div class="wos-chip q-' + esc(cur.q[V.key]) + '" data-var="' + V.key + '"><div class="l" title="' + esc(V.label) + '">' + esc(V.label) + '</div><div class="v">' + esc(d.v) + ' <span class="kpi-u">' + esc(d.u) + '</span></div>' +
                '<div class="s">' + esc(cur.q[V.key] === 'unmapped' ? (u.source === 'form' ? 'not in the form model' : 'not linked') : (cur.src[V.key] || '') + (age ? ' · ' + age : '') + (cur.q[V.key] !== 'good' ? ' · ' + cur.q[V.key] : '')) + '</div></div>';
        });
        c.innerHTML = html + (grp ? '</div>' : '');
    }
    function renderAlarms(force) {
        var A = alarmsMgr(), list = A ? A.list() : [], cnt = A ? A.counts() : { unack: 0, active: 0, total: 0 };
        var sig = list.map(function (a) { return a.id + a.state + a.level + a.active; }).join('|');
        var pill = q('#wos_alpill');
        if (pill) pill.innerHTML = cnt.total ? '<span class="wos-pill ' + (list.some(function (a) { return a.sev === 'alarm' && a.active; }) ? 'alarm' : 'warn') + '" data-act="toalarms">⚠ ' + cnt.active + ' active · ' + cnt.unack + ' unack</span>' : '<span class="wos-pill"><span class="wos-dot good"></span>No alarms</span>';
        var n = q('#wos_alcount'); if (n) n.textContent = cnt.active + ' active / ' + cnt.unack + ' unack';
        if (sig !== alSig || force) {
            alSig = sig;
            var el = q('#wos_alarms');
            if (el) el.innerHTML = list.length ? list.map(function (a) {
                return '<div class="wos-al ' + esc(a.sev) + ' ' + esc(a.state) + (a.active ? ' active' : '') + '"><span class="sev">' + esc(a.level) + '</span><span><b>' + esc(a.tag) + '</b> ' + esc(a.msg || '') + '<br><span style="color:var(--text3);font-size:10px">' + esc(a.state === 'RTN' ? 'returned to normal (unacknowledged)' : a.state === 'ACK' ? 'acknowledged' : 'UNACKNOWLEDGED') + ' · since ' + hms(a.tOn) + '</span></span>' +
                    (a.state !== 'ACK' ? '<button class="btn btn-secondary wos-btn" data-act="ack" data-id="' + esc(a.id) + '">Ack</button>' : '<span></span>') + '</div>';
            }).join('') : '<div style="font-size:12px;color:var(--text3);padding:6px">No active or unacknowledged alarms.</div>';
        }
        var ev = A ? A.events() : [], es = ev.length + ':' + (ev.length ? ev[ev.length - 1].t : 0);
        if (es !== evSig || force) {
            evSig = es;
            var e = q('#wos_events');
            if (e) e.textContent = ev.slice(-60).reverse().map(function (x) { return hms(x.t) + '  ' + x.msg; }).join('\n') || 'No events yet.';
        }
    }
    function renderLog() {
        var l = q('#wos_log'); if (!l) return;
        l.innerHTML = '<div class="btn-row" style="margin-top:0;flex-wrap:wrap">' + (logger.on ? '<button class="btn btn-secondary wos-btn" data-act="logstop">■ Stop logging</button>' : '<button class="btn btn-primary wos-btn" data-act="logstart">● Start logging</button>') +
            '<button class="btn btn-secondary wos-btn" data-act="logcsv"' + (logger.rows.length ? '' : ' disabled') + '>Download CSV</button><button class="btn btn-secondary wos-btn" data-act="logclear">Clear</button></div>' +
            '<div class="wos-msg" style="color:var(--text2)">' + (logger.on ? '● Logging ' + (u.source === 'modbus' ? 'every poll' : 'every second') + ' — ' : '') + logger.rows.length + ' row(s) recorded' + (logger.note ? ' · ' + esc(logger.note) : '') + '</div>';
    }
    function renderHist() {
        var b = q('#wos_hist_body'); if (!b) return;
        var has = typeof document !== 'undefined' && document.querySelector('.nav-btn[data-p="historian"]');
        b.innerHTML = has ? '<div style="font-size:12px;color:var(--text2)">Every polled tag (and the form values in Form data mode) is recorded by the historian.</div><div class="btn-row"><button class="btn btn-secondary wos-btn" data-act="goto" data-p="historian">Open Historian</button></div>' :
            '<div style="font-size:12px;color:var(--text2)" data-historian-placeholder="1">Historian — long-term storage with trend and table views of every logged tag will appear here. Samples are already published on each poll (<code>WTS_historian.record()</code> and the <code>wts:modbus-samples</code> event); per-tag logging, log deadband and minimum interval are set on the Modbus page.</div>';
    }

    // ── logging ──
    function logCols() {
        if (u.source === 'modbus' && station) {
            var cfg = station.config();
            return cfg.tags.map(function (t) { return { id: t.id, name: t.name, unit: t.unit }; });
        }
        return M.VARS.map(function (V) { return { id: V.key, name: V.key, unit: unitLabel(V) }; });
    }
    function logRow() {
        if (!logger.cols) logger.cols = logCols();
        var t = Date.now(), row = [t];
        if (u.source === 'modbus' && station) {
            var v = station.values();
            logger.cols.forEach(function (c) { var r = v[c.id]; row.push(r && r.q !== 'bad' && r.q !== 'init' && isNum(r.value) ? r.value : null, r ? r.q : 'n/a'); });
        } else {
            var fv = model.values();
            logger.cols.forEach(function (c) { var x = fv[c.id]; row.push(isNum(x) ? x : null, x == null ? 'n/a' : 'good'); });
        }
        logger.rows.push(row);
        if (logger.rows.length >= logger.max) { logger.on = false; logger.note = 'Stopped at ' + logger.max + ' rows'; renderLog(); }
    }
    function csvText() {
        var cols = logger.cols || [];
        var head = ['timestamp_utc', 'epoch_ms'];
        cols.forEach(function (c) { head.push(c.name + (c.unit ? ' [' + c.unit + ']' : ''), c.name + ' quality'); });
        var cell = function (v) { var s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        return [head.map(cell).join(',')].concat(logger.rows.map(function (r) {
            return [new Date(r[0]).toISOString(), r[0]].concat(r.slice(1).map(function (x) { return typeof x === 'number' ? +x.toPrecision(10) : x; })).map(cell).join(',');
        })).join('\r\n') + '\r\n';
    }
    C.csvText = csvText; C.logger = logger;

    // ── trends ──
    function series(key, t0) {
        var V = M.VAR_BY_KEY[key];
        if (u.source === 'form') return formHist[key] ? formHist[key].range(t0) : { t: [], v: [] };
        var x = station && station.getVar(key);
        if (!x || !x.tagId) return { t: [], v: [] };
        var h = station.history(x.tagId, t0), tg = station.tag(x.tagId);
        if (V && V.kind !== 'bool' && tg) h = { t: h.t, v: h.v.map(function (y) { return M.toCanonical(y, tg.unit, V.cat); }) };
        return h;
    }
    C.series = series;
    var TCOL = ['#58a6ff', '#f0883e', '#3fb950', '#d2a8ff', '#e3b341', '#ff7b72'];
    function drawTrends() {
        var cv = q('#wos_trend'); if (!cv || !cv.getContext) return;
        var ctx = cv.getContext('2d'); if (!ctx) return;
        var W = cv.width, H = cv.height, keys = u.trend.slice(0, 6), t1 = Date.now(), t0 = t1 - u.win * 1000;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0b111a'; ctx.fillRect(0, 0, W, H);
        if (!keys.length) { ctx.fillStyle = '#8b949e'; ctx.font = '13px sans-serif'; ctx.fillText('Tick variables above to trend them.', 20, 30); return; }
        var n = keys.length, lane = (H - 24) / n, L = 150, R = W - 10;
        keys.forEach(function (k, i) {
            var V = M.VAR_BY_KEY[k], s = series(k, t0), y0 = 4 + i * lane, h = lane - 8, col = TCOL[i % TCOL.length];
            var lo = Infinity, hi = -Infinity;
            s.v.forEach(function (v) { if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } });
            ctx.strokeStyle = '#1d2a3a'; ctx.lineWidth = 1; ctx.strokeRect(L, y0, R - L, h);
            ctx.fillStyle = col; ctx.font = 'bold 11px sans-serif'; ctx.fillText(V.label.replace(/ \(.*\)$/, '').slice(0, 24), 6, y0 + 13);
            var last = s.v.length ? s.v[s.v.length - 1] : null, dl = disp(last, V);
            ctx.fillStyle = '#e6edf3'; ctx.font = '12px "Courier New",monospace'; ctx.fillText(dl.v + ' ' + dl.u, 6, y0 + 29);
            if (!isFinite(lo)) { ctx.fillStyle = '#6e7681'; ctx.font = '11px sans-serif'; ctx.fillText('no data in window', L + 8, y0 + h / 2 + 4); return; }
            if (hi - lo < 1e-9) { hi += 0.5 * Math.max(1e-3, Math.abs(hi) * 0.01); lo -= 0.5 * Math.max(1e-3, Math.abs(lo) * 0.01); }
            var pd = (hi - lo) * 0.08; lo -= pd; hi += pd;
            ctx.fillStyle = '#6e7681'; ctx.font = '10px sans-serif';
            ctx.fillText(disp(hi, V).v, 6, y0 + 44); ctx.fillText(disp(lo, V).v, 6, y0 + h - 2);
            ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
            var started = false;
            for (var j = 0; j < s.t.length; j++) {
                var v = s.v[j]; if (!isNum(v)) { started = false; continue; }
                var x = L + (s.t[j] - t0) / (t1 - t0) * (R - L), y = y0 + h - (v - lo) / (hi - lo) * h;
                if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
        });
        ctx.fillStyle = '#6e7681'; ctx.font = '10px sans-serif';
        ctx.fillText(hms(t0), L, H - 6); var e = hms(t1); ctx.fillText(e, R - 50, H - 6);
        ctx.fillText(WINDOWS.filter(function (w) { return w[0] === u.win; })[0][1] + ' window', (L + R) / 2 - 30, H - 6);
    }

    // ── 2D: host P&ID (wtsDrawDiag on #wts_cv) + levels / valves panel ──
    function draw2d(st) {
        var Lv = G.WTS_live, cv = q('#wts_cv');
        if (cv && u.view === '2d' && Lv && typeof Lv.liveNodes === 'function' && typeof Lv.liveSegs === 'function' && typeof G.wtsDrawDiag === 'function' && st) {
            try { G.wtsDrawDiag(Lv.liveNodes(st), Lv.liveSegs(st)); } catch (e) {}
        }
    }
    function drawLevels(cur) {
        var cv = q('#wos_lv'); if (!cv || !cv.getContext) return;
        var ctx = cv.getContext('2d'); if (!ctx) return;
        var W = cv.width, H = cv.height, v = cur.vals, Q = cur.q;
        ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#0b111a'; ctx.fillRect(0, 0, W, H);
        function tank(x, w, title, total, water, qk, valveKey, valveLbl) {
            var y = 36, h = H - 92;
            ctx.strokeStyle = Q[qk] === 'bad' ? '#f85149' : Q[qk] === 'stale' ? '#d29922' : '#3a4a5e'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
            if (isNum(total)) { var ht = Math.max(0, Math.min(1.05, total / 100)) * h; ctx.fillStyle = '#c98a2b'; ctx.fillRect(x + 2, y + h - ht, w - 4, ht); }
            if (isNum(water)) { var hw = Math.max(0, Math.min(1, water / 100)) * h; ctx.fillStyle = '#1f7fe0'; ctx.fillRect(x + 2, y + h - hw, w - 4, hw); }
            ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(title, x, y - 20);
            ctx.font = '12px "Courier New",monospace'; ctx.fillText(isNum(total) ? total.toFixed(1) + ' %' : (Q[qk] === 'unmapped' ? 'not linked' : '—'), x, y - 6);
            if (valveKey) valve(x + w / 2, y + h + 22, v[valveKey], Q[valveKey], valveLbl);
        }
        function valve(cx, cy, open, qq, lbl) {
            var col = open == null ? '#6e7681' : open ? '#3fb950' : '#f85149';
            ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(cx - 12, cy - 8); ctx.lineTo(cx + 12, cy + 8); ctx.lineTo(cx + 12, cy - 8); ctx.lineTo(cx - 12, cy + 8); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#c9d1d9'; ctx.font = '10px sans-serif'; ctx.fillText(lbl + ' ' + (open == null ? '—' : open ? 'OPEN' : 'SHUT') + (qq === 'stale' ? ' (stale)' : qq === 'bad' ? ' (bad)' : ''), cx - 34, cy + 22);
        }
        // separator: inlet-compartment liquid + interface, oil bucket
        tank(40, 150, 'V-101 Separator', v.sep_liq_lvl, v.sep_int_lvl, 'sep_liq_lvl', 'esd_open', 'SDV-101');
        tank(210, 60, 'Oil bucket', v.sep_oil_lvl, null, 'sep_oil_lvl', null);
        tank(330, 90, 'T-201A Surge', v.surge_lvl_a, null, 'surge_lvl_a', 'xv201a', 'XV-201A');
        tank(440, 90, 'T-201B Surge', v.surge_lvl_b, null, 'surge_lvl_b', 'xv201b', 'XV-201B');
        tank(700, 90, 'T-301A Gauge', v.gauge_lvl_a, null, 'gauge_lvl_a', 'xv301a', 'XV-301A');
        tank(810, 90, 'T-301B Gauge', v.gauge_lvl_b, null, 'gauge_lvl_b', 'xv301b', 'XV-301B');
        // pump
        var pr = v.pump_running, px = 610, py = 120;
        ctx.strokeStyle = pr == null ? '#6e7681' : pr ? '#3fb950' : '#8b949e'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(px, py, 22, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('P-201', px - 16, py + 4);
        ctx.font = '10px sans-serif'; ctx.fillText(pr == null ? '—' : pr ? 'RUNNING' : 'STOPPED', px - 22, py + 40);
        // status column
        var sx = 950, lines = [
            ['ESD', v.esd_tripped ? 'TRIPPED' : v.esd_tripped === 0 ? 'NORMAL' : '—', v.esd_tripped ? '#f85149' : '#3fb950'],
            ['WHP', disp(v.whp, M.VAR_BY_KEY.whp).v + ' ' + disp(v.whp, M.VAR_BY_KEY.whp).u, '#e6edf3'],
            ['Sep P', disp(v.sep_p, M.VAR_BY_KEY.sep_p).v + ' ' + disp(v.sep_p, M.VAR_BY_KEY.sep_p).u, '#e6edf3'],
            ['Surge P', disp(v.surge_p, M.VAR_BY_KEY.surge_p).v + ' ' + disp(v.surge_p, M.VAR_BY_KEY.surge_p).u, '#e6edf3'],
            ['LCV-102', disp(v.lcv_oil, M.VAR_BY_KEY.lcv_oil).v + ' %', '#e6edf3'],
            ['LCV-101', disp(v.lcv_water, M.VAR_BY_KEY.lcv_water).v + ' %', '#e6edf3'],
            ['Source', u.source === 'form' ? 'Form data' : 'Modbus data', u.source === 'form' ? '#58a6ff' : '#f0883e']];
        lines.forEach(function (l, i) { ctx.fillStyle = '#8b949e'; ctx.font = '11px sans-serif'; ctx.fillText(l[0], sx, 40 + i * 24); ctx.fillStyle = l[2]; ctx.font = 'bold 12px "Courier New",monospace'; ctx.fillText(l[1], sx + 70, 40 + i * 24); });
        if (v.esd_tripped) { ctx.fillStyle = 'rgba(248,81,73,.9)'; ctx.fillRect(0, H - 22, W, 22); ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('ESD TRIPPED — SDV-101 closed', 12, H - 7); }
    }

    // ── 3D ──
    function show3dNote(t) { var n = q('#wos_note'); if (n) { n.textContent = t || ''; n.style.display = t ? '' : 'none'; } }
    function applyView() {
        var d3 = q('#wos_3d'), cv = q('#wts_cv'), want3d = u.view === '3d' && !h3failed;
        if (d3) d3.style.display = want3d ? '' : 'none';
        if (cv) cv.hidden = want3d;
        if (want3d) mount3d(); else { if (h3) { try { h3.setPaused(true); } catch (e) {} } }
        if (u.view === '3d' && h3failed) show3dNote('3D view unavailable on this device — showing the 2D schematic');
        else if (!want3d) show3dNote('');
        if (h3 && want3d) { try { h3.setPaused(false); } catch (e) {} }
    }
    function mount3d() {
        if (h3 || h3tok || h3failed) return;
        var W = G.WTS_3d, el = q('#wos_3d');
        var ok = false; try { ok = !!(W && typeof W.mount === 'function' && W.isSupported()); } catch (e) { ok = false; }
        if (!ok || !el) { h3failed = true; applyView(); return; }
        var tok = ++h3tok, L = G.WTS_live || {};
        show3dNote('Loading 3D view…');
        var o = { quality: 'auto', labels: 'all', overlay: 'phase', orbit: false, intro: false,
            onError: function (err, fatal) { if (fatal && !disposed) { try { if (h3) h3.dispose(); } catch (e) {} h3 = null; h3failed = true; applyView(); } } };
        if (typeof L.fmtU === 'function') o.fmt = L.fmtU;
        if (typeof L.fmtParts === 'function') o.fmtParts = L.fmtParts;
        if (typeof L.unitsConv === 'function') o.units = { system: (G.WTS_units && G.WTS_units.getSystem && G.WTS_units.getSystem()) || 'imperial', conv: L.unitsConv };
        var p; try { p = W.mount(el, o); } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(function (h) {
            if (disposed || tok !== h3tok) { try { h.dispose(); } catch (e) {} return; }
            h3 = h; h3tok = 0; show3dNote('');
            try { h3.setPaused(u.view !== '3d'); } catch (e) {}
        }, function () { if (disposed || tok !== h3tok) return; h3tok = 0; h3failed = true; applyView(); });
    }

    // ── loop ──
    function updateUi(force) {
        var cur = current();
        renderKpis(cur); renderChips(cur); renderComms(); renderAlarms(force);
        drawLevels(cur);
        var ck = q('#wos_clock'); if (ck) ck.textContent = hms(Date.now());
        var sf = q('#wos_srcflag'); if (sf) { sf.textContent = u.source === 'form' ? 'FORM DATA' : 'MODBUS DATA'; sf.style.color = u.source === 'form' ? 'var(--blue)' : 'var(--accent)'; }
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.wellos = { source: u.source, values: cur.vals, quality: cur.q, ts: Date.now() };
        return cur;
    }
    C.updateUi = updateUi;
    function frame(ts) {
        raf = 0;
        if (disposed) return;
        if (!root.isConnected) { C.dispose(); return; }
        if (typeof document !== 'undefined' && document.hidden) return;       // resumes on visibilitychange
        raf = reqFrame(frame);
        if (!isNum(ts)) ts = nowMs();
        var dt = last ? Math.min((ts - last) / 1000, 0.25) : 0; if (dt < 0) dt = 0;
        last = ts;
        bindStation();
        if (u.source === 'form') { model.step(dt * u.speed); dirty = true; }
        var st = displayState();
        if (h3 && u.view === '3d') { try { h3.frame(st, dt); } catch (e) {} }
        var wall = Date.now();
        if (u.source === 'form' && wall - tSample >= 1000) { tSample = wall; formSample(wall); }
        if (ts - tUi >= 250 && dirty) { tUi = ts; dirty = u.source === 'form'; updateUi(false); if (u.view === '2d' || h3failed) draw2d(st); }
        if (ts - tSlow >= 1000) { tSlow = ts; drawTrends(); if (logger.on) renderLog(); }
    }
    function reqFrame(fn) { return typeof G.requestAnimationFrame === 'function' ? G.requestAnimationFrame(fn) : G.setTimeout(function () { fn(nowMs()); }, 50); }
    function cancelFrame() { if (!raf) return; if (typeof G.cancelAnimationFrame === 'function') G.cancelAnimationFrame(raf); else G.clearTimeout(raf); raf = 0; }
    function start() { if (!raf && !disposed) { last = 0; raf = reqFrame(frame); } }
    C.start = start; C.frame = frame;

    // ── actions ──
    function gotoPage(p) { var b = typeof document !== 'undefined' && document.querySelector('.nav-btn[data-p="' + p + '"]'); if (b) b.click(); }
    function sendToPrism() {
        var key = (q('[data-role="prism-var"]') || {}).value || u.prism, V = M.VAR_BY_KEY[key], msgEl = q('#wos_prism_msg');
        u.prism = key; writeUi(u);
        var t1 = Date.now(), s = series(key, t1 - u.win * 1000), t = [], p = [];
        for (var i = 0; i < s.t.length; i++) if (isNum(s.v[i])) { t.push(s.t[i]); p.push(s.v[i]); }
        function say(h, bad) { if (msgEl) msgEl.innerHTML = '<span style="color:var(--' + (bad ? 'red' : 'green') + ')">' + h + '</span>'; }
        if (t.length < 3) { say('✗ Need at least 3 samples of ' + esc(V.label) + ' in the trend window (have ' + t.length + ').', true); return null; }
        if (typeof G.PRiSM_commitDataset !== 'function') { say('✗ PRiSM is not available.', true); return null; }
        var tag = u.source === 'modbus' && station && station.getVar(key) ? station.getVar(key).tag : 'form';
        var name = 'Mini WellOS ' + V.label.replace(/ \(.*\)$/, '') + ' — ' + (u.source === 'modbus' ? 'Modbus tag ' + tag : 'form data') + ' ' + new Date(t[0]).toISOString().slice(0, 16).replace('T', ' ');
        var ds = { t: t.map(function (x) { return (x - t[0]) / 3.6e6; }), p: p.slice(), q: null, timeUnit: 'h', name: name, source: 'modbus',
            meta: { variable: key, tag: tag, unit: 'psig', startUtc: new Date(t[0]).toISOString(), from: 'Mini WellOS' } };
        var res = G.PRiSM_commitDataset(ds, { source: 'modbus', name: name });
        try { if (G.PRiSM_gaugeData && typeof G.PRiSM_gaugeData.add === 'function') Promise.resolve(G.PRiSM_gaugeData.add({ name: name, units: 'psig', source: 'Mini WellOS' }, ds.t, ds.p, null)).catch(function () {}); } catch (e) {}
        if (!res) { say('✗ PRiSM rejected the dataset.', true); return null; }
        say('✓ Sent ' + t.length + ' points (' + ((t[t.length - 1] - t[0]) / 3.6e6).toFixed(3) + ' h, gauge pressure psig) to PRiSM as "' + esc(name) + '". <button class="btn btn-secondary wos-btn" data-act="goto" data-p="prism">Open PRiSM</button>');
        return ds;
    }
    C.sendToPrism = sendToPrism;
    function onClick(ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!b || !root.contains(b)) return;
        var act = b.getAttribute('data-act');
        switch (act) {
            case 'src': setSource(b.getAttribute('data-src')); break;
            case 'view': u.view = b.getAttribute('data-view') === '2d' ? '2d' : '3d'; writeUi(u); renderHead(); applyView(); dirty = true; updateUi(); draw2d(displayState()); break;
            case 'speed': u.speed = +b.getAttribute('data-speed') || 1; writeUi(u); renderHead(); break;
            case 'pause': M.setPaused(!M.getConfig().paused); renderHead(); renderComms(); break;
            case 'goto': gotoPage(b.getAttribute('data-p')); break;
            case 'demo': M.saveConfig(M.demoConfig()); if (!M.station()) M.acquire(OWNER); bindStation(); renderBanner(); renderHead(); break;
            case 'ack': { var A = alarmsMgr(); if (A) A.ack(b.getAttribute('data-id')); renderAlarms(true); break; }
            case 'ackall': { var A2 = alarmsMgr(); if (A2) A2.ackAll(); renderAlarms(true); break; }
            case 'toalarms': { var c = q('#wos_alcard'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
            case 'win': u.win = +b.getAttribute('data-win') || 1800; writeUi(u); root.querySelectorAll('[data-act="win"]').forEach(function (x) { var on = +x.getAttribute('data-win') === u.win; x.style.borderColor = on ? 'var(--accent)' : ''; x.style.color = on ? 'var(--accent)' : ''; }); drawTrends(); break;
            case 'logstart': logger.on = true; logger.cols = logCols(); logger.rows = []; logger.note = ''; logRow(); renderLog(); break;
            case 'logstop': logger.on = false; renderLog(); break;
            case 'logclear': logger.rows = []; logger.note = ''; if (!logger.on) logger.cols = null; renderLog(); break;
            case 'logcsv': if (logger.rows.length && M.download) M.download('wellos-log-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv', csvText(), 'text/csv'); break;
            case 'prism': sendToPrism(); break;
        }
    }
    function onChange(ev) {
        var el = ev.target; if (!el || !el.getAttribute) return;
        var k = el.getAttribute('data-trend');
        if (k) {
            var i = u.trend.indexOf(k);
            if (el.checked && i < 0) { if (u.trend.length >= 6) { el.checked = false; return; } u.trend.push(k); }
            if (!el.checked && i >= 0) u.trend.splice(i, 1);
            writeUi(u); drawTrends();
        }
    }
    function onPage(e) { if (!root.isConnected || (e && e.detail && e.detail.page && e.detail.page !== 'wellos')) C.dispose(); }
    function onVis() { if (typeof document !== 'undefined' && !document.hidden) start(); }
    function onUnits() { if (h3) { try { h3.refreshUnits(); } catch (e) {} } dirty = true; updateUi(true); drawTrends(); }
    function onCfg() { if (!disposed) { bindStation(); renderBanner(); renderHead(); dirty = true; } }
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    document.addEventListener('h2oil:pagechange', onPage);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('wts:unit-system-changed', onUnits);
    document.addEventListener('wts:modbus-config-changed', onCfg);
    C.dispose = function () {
        if (disposed) return; disposed = true;
        cancelFrame();
        root.removeEventListener('click', onClick); root.removeEventListener('change', onChange);
        document.removeEventListener('h2oil:pagechange', onPage);
        document.removeEventListener('visibilitychange', onVis);
        document.removeEventListener('wts:unit-system-changed', onUnits);
        document.removeEventListener('wts:modbus-config-changed', onCfg);
        if (boundStation) { boundStation.off('poll', onPoll); boundStation.off('status', onStatus); }
        boundStation = null; station = null;
        M.release(OWNER);
        h3tok++;
        if (h3) { try { h3.dispose(); } catch (e) {} h3 = null; }
        try { model.dispose(); } catch (e) {}
        if (ctl === C) ctl = null;
    };
    C.ui = function () { return u; };
    C.isRunning = function () { return !!raf; };
    C.handle3d = function () { return h3; };

    // init
    renderHead(); renderBanner(); renderLog(); renderHist();
    if (u.source === 'modbus') { u.source = 'form'; setSource('modbus'); }
    applyView();
    updateUi(true); draw2d(displayState()); drawTrends();
    formSample(Date.now()); tSample = Date.now();
    start();
    return C;
}

function render(body) {
    injectCss();
    if (ctl) ctl.dispose();
    if (M.syncStation) M.syncStation();
    body.innerHTML = pageHtml(readUi());
    ctl = createController(byId('wos_root'));
    if (typeof G.calcWellOS === 'function') G.calcWellOS();
}
// calc<X> naming convention (units wrapper): refresh the view on demand.
G.calcWellOS = function () { if (ctl) { ctl.updateUi(true); return true; } return false; };
M.wellos = { controller: function () { return ctl; }, DERIVED: DERIVED, disp: disp, UI_KEY: UI_KEY };

G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.wellos = {
    key: 'wellos', title: 'Mini WellOS', navTitle: 'Mini WellOS',
    sub: 'Live SCADA view of the well-test spread — form data or live Modbus tags',
    group: 'Mini WellOS', icon: '&#9673;', badge: 'Live Data', bc: 'dc-b-blue',
    desc: 'P&ID, 3D view, trends, alarms and logging driven by the simulator model or live Modbus data.',
    render: render
};
})();

// ─── END 63-wellos ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 64-modbus-bridge-pack ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 64-modbus-bridge-pack.js — GENERATED by prism-build/pack-modbus-bridge.js from
// tools/modbus-bridge/ — do not edit; change the files there and run
//   node prism-build/pack-modbus-bridge.js   (concat-round10.js runs it too).
// window.WTS_modbusBridgePack = { version, order, files: { name: text }, sha256: { name: hex } }
// feeds the Modbus page's bridge setup guide (package download, generated installers)
// so it works offline. Text is LF; sha256 is over its UTF-8 bytes.
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_modbusBridgePack = {
    version: "1.2.0",
    order: ["modbus-bridge.js","fake-slave.js","install-windows.ps1","install.sh","README.md"],
    sha256: {
        "modbus-bridge.js": "89a8e04dd116197e2ab615c58f58fbb246420bca2d9dbd46dd779abc86af0d22",
        "fake-slave.js": "b1c49f245411df9695e5e21cb699e2ba10639853aa84bbda0a6ec0c02163a82e",
        "install-windows.ps1": "c9830b859a05d6acf182cc80de4a8b9621dafd0f717135e1cbf3a486789623c6",
        "install.sh": "b022c02b5567543f544d510748cc03c0cebc6337e977eff9ef5d31355c7941c0",
        "README.md": "95ff47ce4813cced111be67251d61c81394fed9807e367aa1341d5ea63ed868c"
    },
    files: {
        "modbus-bridge.js": "#!/usr/bin/env node\n// =============================================================================\n// modbus-bridge.js — WebSocket ↔ Modbus TCP bridge for the Well Testing Suite\n// (Mini WellOS / Modbus page). Zero dependencies, Node.js ≥ 18.\n//\n//   browser ──ws://127.0.0.1:8502/modbus?host=10.0.0.5&port=502──► bridge ──TCP──► PLC / RTU / gateway\n//\n// Protocol\n//   • The page opens one WebSocket per device with ?host=&port= query parameters.\n//   • The bridge checks the Origin header and the host:port against its allow-lists,\n//     opens the TCP connection, then sends the text frame {\"type\":\"open\"}.\n//     Failures: {\"type\":\"error\",\"message\":\"…\"} then close (1008 policy / 1011 error).\n//   • Binary frames = complete Modbus TCP ADUs (MBAP header + PDU) in both directions.\n//     The bridge re-frames the TCP byte stream into whole ADUs using the MBAP length.\n//   • Read-only by default: a request with function code 05 / 06 / 15 / 16 (or any code\n//     outside 01-06, 15, 16) is answered by the bridge itself with Modbus exception 01\n//     (Illegal function) and never reaches the device, unless --allow-writes is given.\n//   • GET /health → {\"name\",\"version\",\"readOnly\",\"port\",\"uptimeS\",\"allow\":[…]} for the app's\n//     \"Check bridge\" button. CORS headers only for accepted page origins (same rules as the\n//     WebSocket upgrade); the preflight answers Access-Control-Allow-Private-Network: true\n//     (Chrome Private Network Access). A refused request gets 403 {\"error\":\"origin\"|\"host\"}\n//     (with Access-Control-Allow-Origin echoed, so the page can tell a refusal from \"no\n//     bridge\"; nothing else is in that body). Host names other than localhost / an IP literal /\n//     --listen are refused (DNS rebinding) unless the request carries an accepted Origin.\n//\n// Security defaults: listens on 127.0.0.1 only; any device IP / port is reachable unless you\n// restrict it with --allow targets (v1.2.0; before, nothing was reachable until allowed); browser origins limited to http(s)://localhost / 127.0.0.1 / [::1], the app's\n// capacitor origin and the app's web origin (pb-handbook.com) unless --origin or --any-origin\n// is given. \"Origin: null\" (sandboxed iframes, data: URLs, saved file:// copies) is refused\n// unless allowed explicitly with --origin null, because any web site can send it. Requests\n// without an Origin header (curl, scripts; never a browser page) are accepted. ADU ≤ 260 bytes.\n//\n// Usage:  node modbus-bridge.js                (any device)\n//         node modbus-bridge.js --allow 192.168.1.10:502 [--allow 10.0.0.0/24:502] [--allow 'host:*'] [--allow-any]\n//                               [--listen 127.0.0.1] [--port 8502] [--origin https://example.com]\n//                               [--any-origin] [--allow-writes] [--verbose]\n//                               [--config bridge-config.json] [--version] [--help]\n//         (quote targets with * or [ ] — zsh refuses an unmatched glob; IPv6: '[fd00::10]:502';\n//          --origin null accepts a saved file:// copy of the app)\n// --config file.json: {\"allow\":[\"192.168.1.10:502\"], \"port\":8502, \"listen\":\"127.0.0.1\",\n//   \"origins\":[], \"anyOrigin\":false, \"allowWrites\":false, \"verbose\":false} (all keys optional;\n//   keys starting with \"_\" are comments). Command-line flags override the file's port / listen\n//   and add to its allow / origins lists; --allow-writes, --any-origin, --verbose switch those on.\n// RFC 6455 (WebSocket) framing; MODBUS Messaging on TCP/IP Implementation Guide V1.0b (MBAP).\n// =============================================================================\n'use strict';\n\nconst http = require('http');\nconst net = require('net');\nconst crypto = require('crypto');\nconst fs = require('fs');\n\nconst BRIDGE_VERSION = '1.2.0';\nconst BRIDGE_NAME = 'wts-modbus-bridge';\nconst WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';     // RFC 6455 §1.3\nconst MAX_ADU = 260;\nconst READ_FCS = new Set([1, 2, 3, 4]);\nconst WRITE_FCS = new Set([5, 6, 15, 16]);\n// \"null\" and file:// are deliberately NOT here: any web page can send \"Origin: null\" (a\n// sandboxed iframe or a data: URL), so a saved copy of the app needs --origin null.\nconst DEFAULT_ORIGINS = [/^https?:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?$/i, /^https:\\/\\/(www\\.)?pb-handbook\\.com$/i,\n  /^capacitor:\\/\\/localhost$/i];\n\n// ─── allow-list ──────────────────────────────────────────────────────────────\n// entry: \"host:port\" | \"host:*\" | \"a.b.c.d/nn:port\" (IPv4 CIDR) | \"*:port\" | \"*:*\" (any device).\n// An empty allow-list means \"*:*\" — any device IP / port (the default since v1.2.0). List\n// specific targets to lock the bridge down to them.\nfunction parseAllow(spec) {\n  const s = String(spec).trim();\n  const i = s.lastIndexOf(':');\n  if (i \u003c= 0) throw new Error('--allow needs host:port, got ' + spec);\n  const host = s.slice(0, i).replace(/^\\[|\\]$/g, ''), port = s.slice(i + 1);\n  if (host === '*') {\n    if (port !== '*' && !(/^\\d{1,5}$/.test(port) && +port \u003e= 1 && +port \u003c= 65535)) throw new Error('bad port in --allow ' + spec);\n    const p = port === '*' ? '*' : +port;\n    return { host: '*', port: p, cidr: null, spec: '*:' + p };\n  }\n  if (port !== '*' && !(/^\\d{1,5}$/.test(port) && +port \u003e= 1 && +port \u003c= 65535)) throw new Error('bad port in --allow ' + spec);\n  if (!/^[A-Za-z0-9._-]+(\\/\\d{1,2})?$/.test(host) && !/^[0-9A-Fa-f:.]+$/.test(host)) throw new Error('bad host in --allow ' + spec + ' (IPv4, IPv4/nn, IPv6 or a host name)');\n  const m = /^(\\d+\\.\\d+\\.\\d+\\.\\d+)\\/(\\d+)$/.exec(host);\n  if (m && (ip4(m[1]) == null || !(+m[2] \u003e= 0 && +m[2] \u003c= 32))) throw new Error('bad IPv4 subnet in --allow ' + spec);\n  const h = host.toLowerCase(), p = port === '*' ? '*' : +port;\n  return { host: h, port: p, cidr: m ? { base: ip4(m[1]), bits: +m[2] } : null, spec: (h.indexOf(':') \u003e= 0 ? '[' + h + ']' : h) + ':' + p };\n}\nfunction ip4(s) { const p = s.split('.').map(Number); if (p.length !== 4 || p.some((x) =\u003e !(x \u003e= 0 && x \u003c= 255))) return null; return ((p[0] \u003c\u003c 24) | (p[1] \u003c\u003c 16) | (p[2] \u003c\u003c 8) | p[3]) \u003e\u003e\u003e 0; }\nfunction allowed(list, host, port) {\n  host = String(host || '').toLowerCase(); port = +port;\n  return list.some((a) =\u003e {\n    if (a.port !== '*' && a.port !== port) return false;\n    if (a.host === '*') return true;\n    if (a.cidr) {\n      const ip = ip4(host); if (ip == null || a.cidr.base == null) return false;\n      const mask = a.cidr.bits === 0 ? 0 : (0xFFFFFFFF \u003c\u003c (32 - a.cidr.bits)) \u003e\u003e\u003e 0;\n      return (ip & mask) === (a.cidr.base & mask);\n    }\n    return a.host === host;\n  });\n}\n// origin = the Origin request header. undefined (no header) = not a browser page (curl, a\n// script, Node's WebSocket): accepted. \"null\" only with --origin null / --any-origin.\nfunction originOk(opts, origin) {\n  if (origin === undefined) return true;\n  if (opts.anyOrigin) return true;\n  const o = String(origin);\n  if ((opts.origins || []).some((x) =\u003e String(x).toLowerCase() === o.toLowerCase())) return true;\n  return DEFAULT_ORIGINS.some((re) =\u003e re.test(o));\n}\n// /health answers only requests addressed to localhost, an IP literal or the --listen name,\n// so a web page cannot read it through a DNS-rebound host name (such a page sends no Origin on\n// its same-origin GET, or its own origin, which is refused).\nfunction hostHeaderOk(opts, hostHeader) {\n  if (hostHeader == null || hostHeader === '') return true;          // HTTP/1.0 client\n  let h = String(hostHeader).trim().toLowerCase();\n  if (h[0] === '[') { const j = h.indexOf(']'); return j \u003e 0 && h.slice(1, j).indexOf(':') \u003e= 0; }   // IPv6 literal\n  const j = h.lastIndexOf(':'); if (j \u003e= 0) h = h.slice(0, j);\n  if (h === 'localhost' || /\\.localhost$/.test(h)) return true;\n  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(h) && ip4(h) != null) return true;\n  return !!(opts && opts.listen && h === String(opts.listen).toLowerCase());\n}\n// Why a /health request is refused: 'origin', 'host' or null (accepted). A request with an\n// accepted, non-null Origin may use any Host name (e.g. ws://bridge-pc.local:8502 from the\n// app): a DNS-rebinding page cannot send such an Origin.\nfunction healthRefusal(opts, origin, hostHeader) {\n  if (!originOk(opts, origin)) return 'origin';\n  if (hostHeaderOk(opts, hostHeader)) return null;\n  return origin !== undefined && String(origin) !== 'null' ? null : 'host';\n}\n// \"localhost\" can resolve to ::1 first (macOS, Windows; Node ≥ 17 keeps the resolver order),\n// while the installers and the app use 127.0.0.1 — so listen on 127.0.0.1.\nfunction normListen(listen) { return typeof listen === 'string' && listen.toLowerCase() === 'localhost' ? '127.0.0.1' : listen; }\n\n// ─── WebSocket framing (server side, RFC 6455 §5) ────────────────────────────\nfunction encodeFrame(opcode, payload) {\n  const len = payload.length;\n  let head;\n  if (len \u003c 126) head = Buffer.from([0x80 | opcode, len]);\n  else if (len \u003c 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }\n  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }\n  return Buffer.concat([head, payload]);\n}\n// Parses as many complete frames as possible. Returns { frames:[{fin, opcode, payload}], rest, error }\nfunction decodeFrames(buf, maxPayload) {\n  const frames = [];\n  let off = 0;\n  while (buf.length - off \u003e= 2) {\n    const b0 = buf[off], b1 = buf[off + 1];\n    const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);\n    let len = b1 & 0x7f, p = off + 2;\n    if (b0 & 0x70) return { frames, rest: Buffer.alloc(0), error: [1002, 'reserved bits set'] };\n    if (!masked) return { frames, rest: Buffer.alloc(0), error: [1002, 'client frames must be masked'] };\n    if (len === 126) { if (buf.length - p \u003c 2) break; len = buf.readUInt16BE(p); p += 2; }\n    else if (len === 127) { if (buf.length - p \u003c 8) break; const big = buf.readBigUInt64BE(p); if (big \u003e BigInt(maxPayload)) return { frames, rest: Buffer.alloc(0), error: [1009, 'message too big'] }; len = Number(big); p += 8; }\n    if (len \u003e maxPayload) return { frames, rest: Buffer.alloc(0), error: [1009, 'message too big'] };\n    if (buf.length - p \u003c 4 + len) break;\n    const mask = buf.slice(p, p + 4); p += 4;\n    const payload = Buffer.alloc(len);\n    for (let i = 0; i \u003c len; i++) payload[i] = buf[p + i] ^ mask[i & 3];\n    frames.push({ fin, opcode, payload });\n    off = p + len;\n  }\n  return { frames, rest: buf.slice(off) };\n}\nfunction closePayload(code, reason) { const r = Buffer.from(String(reason || '').slice(0, 100)); const b = Buffer.alloc(2 + r.length); b.writeUInt16BE(code, 0); r.copy(b, 2); return b; }\n\n// ─── Modbus TCP stream re-framing ─────────────────────────────────────────────\nfunction takeAdus(buf) {\n  const out = [];\n  let off = 0;\n  while (buf.length - off \u003e= 7) {\n    const proto = buf.readUInt16BE(off + 2), len = buf.readUInt16BE(off + 4);\n    if (proto !== 0 || len \u003c 2 || len \u003e 254) return { adus: out, rest: Buffer.alloc(0), error: 'bad MBAP header from device' };\n    if (buf.length - off \u003c 6 + len) break;\n    out.push(buf.slice(off, off + 6 + len)); off += 6 + len;\n  }\n  return { adus: out, rest: buf.slice(off) };\n}\nfunction exceptionAdu(req, code) {\n  const out = Buffer.alloc(9);\n  req.copy(out, 0, 0, 4);                 // transaction id + protocol id\n  out.writeUInt16BE(3, 4); out[6] = req[6]; out[7] = (req[7] | 0x80) & 0xff; out[8] = code;\n  return out;\n}\n\n// ─── bridge ──────────────────────────────────────────────────────────────────\nfunction createBridge(opts) {\n  opts = Object.assign({ listen: '127.0.0.1', port: 8502, allow: [], origins: [], anyOrigin: false, allowWrites: false, verbose: false, connectTimeoutMs: 5000 }, opts || {});\n  opts.listen = normListen(opts.listen) || '127.0.0.1';\n  const allowList = (opts.allow && opts.allow.length ? opts.allow : ['*:*']).map((a) =\u003e (typeof a === 'string' ? parseAllow(a) : a));\n  const log = (...a) =\u003e { if (opts.verbose) console.log('[bridge]', ...a); };\n  const sessions = new Set(), upgraded = new Set();\n  const stats = { sessions: 0, refused: 0, adusIn: 0, adusOut: 0, writesBlocked: 0 };\n\n  const startedAt = Date.now();\n  const server = http.createServer((req, res) =\u003e {\n    let pathname = '/';\n    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* keep '/' */ }\n    if (pathname === '/health' || pathname === '/health/') { health(req, res); return; }\n    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });\n    res.end('WTS Modbus bridge v' + BRIDGE_VERSION + ' ' + (opts.allowWrites ? '(writes ALLOWED)' : '(read-only)') + '\\nConnect with ws://' + opts.listen + ':' + (server.address() || {}).port + '/modbus?host=\u003cip\u003e&port=502\\nHealth check: /health\\n');\n  });\n  function healthInfo() {\n    return { name: BRIDGE_NAME, version: BRIDGE_VERSION, readOnly: !opts.allowWrites, port: (server.address() || {}).port || opts.port,\n      uptimeS: Math.round((Date.now() - startedAt) / 1000), allow: allowList.map((a) =\u003e a.spec || (a.host + ':' + a.port)) };\n  }\n  // GET /health (+ CORS preflight). Accepted origins get CORS headers; a request without an\n  // Origin header (curl, the installers) gets the JSON without them. A refused request gets\n  // 403 {\"error\":\"origin\"|\"host\"} — with Access-Control-Allow-Origin echoed so the app can show\n  // why (a browser turns a 403 without it into \"network error\" = \"is the bridge running?\").\n  // The refusal carries no version / allow-list, and a refused preflight is never approved\n  // (no Access-Control-Allow-Private-Network).\n  function health(req, res) {\n    const origin = req.headers.origin;\n    const why = healthRefusal(opts, origin, req.headers.host);\n    if (why) {\n      stats.refused++; log('health refused:', why, why === 'host' ? req.headers.host : origin);\n      const body = JSON.stringify({ error: why });\n      const h403 = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin', 'Content-Length': Buffer.byteLength(body) };\n      if (origin !== undefined) h403['Access-Control-Allow-Origin'] = String(origin);\n      res.writeHead(403, h403);\n      res.end(req.method === 'HEAD' ? undefined : body);\n      return;\n    }\n    const head = { 'Cache-Control': 'no-store', Vary: 'Origin' };\n    if (origin !== undefined) head['Access-Control-Allow-Origin'] = String(origin);\n    if (req.method === 'OPTIONS') {\n      Object.assign(head, { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',\n        'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600', 'Content-Length': '0' });\n      res.writeHead(204, head); res.end(); return;\n    }\n    if (req.method !== 'GET' && req.method !== 'HEAD') { head.Allow = 'GET, OPTIONS'; res.writeHead(405, head); res.end(); return; }\n    const body = JSON.stringify(healthInfo());\n    head['Content-Type'] = 'application/json; charset=utf-8';\n    head['Content-Length'] = Buffer.byteLength(body);\n    res.writeHead(200, head);\n    res.end(req.method === 'HEAD' ? undefined : body);\n  }\n\n  server.on('upgrade', (req, socket) =\u003e {\n    const fail = (code, text) =\u003e { try { socket.write('HTTP/1.1 ' + code + ' ' + text + '\\r\\nConnection: close\\r\\n\\r\\n'); } catch (e) {} socket.destroy(); stats.refused++; };\n    let url;\n    try { url = new URL(req.url, 'http://x'); } catch (e) { fail(400, 'Bad Request'); return; }\n    const key = req.headers['sec-websocket-key'];\n    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') { fail(400, 'Bad Request'); return; }\n    if (!originOk(opts, req.headers.origin)) { log('origin refused', req.headers.origin); fail(403, 'Forbidden'); return; }\n    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');\n    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');\n    socket.setNoDelay(true);\n    upgraded.add(socket); socket.on('close', () =\u003e upgraded.delete(socket));\n    const host = url.searchParams.get('host') || '', port = +(url.searchParams.get('port') || 502);\n    startSession(socket, host, port);\n  });\n\n  function startSession(ws, host, port) {\n    const S = { ws, tcp: null, open: false, closed: false, wsBuf: Buffer.alloc(0), tcpBuf: Buffer.alloc(0) };\n    sessions.add(S); stats.sessions++;\n    const sendText = (o) =\u003e { if (!S.closed) ws.write(encodeFrame(0x1, Buffer.from(JSON.stringify(o)))); };\n    const sendBin = (b) =\u003e { if (!S.closed) ws.write(encodeFrame(0x2, b)); };\n    function close(code, reason) {\n      if (S.closed) return;\n      try { ws.write(encodeFrame(0x8, closePayload(code, reason))); } catch (e) {}\n      S.closed = true; sessions.delete(S);\n      try { ws.end(); } catch (e) {}\n      const kill = setTimeout(() =\u003e { try { ws.destroy(); } catch (e) {} }, 2000);   // peer did not finish the close handshake\n      if (kill.unref) kill.unref();\n      if (S.tcp) { try { S.tcp.destroy(); } catch (e) {} }\n      log('session closed', code, reason || '');\n    }\n    S.close = close;\n    if (!host || !(port \u003e= 1 && port \u003c= 65535) || !allowed(allowList, host, port)) {\n      stats.refused++;\n      sendText({ type: 'error', message: 'target ' + host + ':' + port + ' is not in the bridge allow-list (start the bridge with --allow ' + (host || '\u003cip\u003e') + ':' + (port || 502) + ')' });\n      close(1008, 'target not allowed');\n      return;\n    }\n    const tcp = net.createConnection({ host, port });\n    S.tcp = tcp;\n    tcp.setNoDelay(true);\n    tcp.setTimeout(opts.connectTimeoutMs, () =\u003e { if (!S.open) { sendText({ type: 'error', message: 'connect to ' + host + ':' + port + ' timed out' }); close(1011, 'connect timeout'); } });\n    tcp.on('connect', () =\u003e { S.open = true; tcp.setTimeout(0); log('connected', host + ':' + port); sendText({ type: 'open', host, port, writes: !!opts.allowWrites }); });\n    tcp.on('data', (d) =\u003e {\n      S.tcpBuf = Buffer.concat([S.tcpBuf, d]);\n      const r = takeAdus(S.tcpBuf);\n      S.tcpBuf = r.rest;\n      r.adus.forEach((a) =\u003e { stats.adusOut++; sendBin(a); });\n      if (r.error) { sendText({ type: 'error', message: r.error }); close(1011, r.error); }\n    });\n    tcp.on('error', (e) =\u003e { sendText({ type: 'error', message: 'TCP ' + host + ':' + port + ': ' + e.message }); close(1011, 'tcp error'); });\n    tcp.on('close', () =\u003e close(1000, 'device closed the connection'));\n    ws.on('data', (d) =\u003e {\n      S.wsBuf = Buffer.concat([S.wsBuf, d]);\n      const r = decodeFrames(S.wsBuf, MAX_ADU);\n      S.wsBuf = r.rest;\n      for (const f of r.frames) {\n        if (f.opcode === 0x8) { close(1000, 'client close'); return; }\n        if (f.opcode === 0x9) { ws.write(encodeFrame(0xA, f.payload)); continue; }\n        if (f.opcode === 0xA) continue;\n        if (!f.fin || f.opcode === 0x0) { close(1003, 'fragmented messages are not supported'); return; }\n        if (f.opcode !== 0x2) continue;                // text from the client is ignored\n        onAdu(f.payload);\n      }\n      if (r.error) close(r.error[0], r.error[1]);\n    });\n    ws.on('error', () =\u003e close(1011, 'socket error'));\n    ws.on('end', () =\u003e close(1000, 'client ended'));            // upgraded sockets are half-open capable\n    ws.on('close', () =\u003e { S.closed = true; sessions.delete(S); if (S.tcp) S.tcp.destroy(); });\n    function onAdu(a) {\n      if (a.length \u003c 8 || a.length \u003e MAX_ADU || a.readUInt16BE(2) !== 0 || a.readUInt16BE(4) !== a.length - 6) { sendText({ type: 'error', message: 'malformed Modbus TCP ADU' }); return; }\n      const fc = a[7];\n      if (!READ_FCS.has(fc) && !(WRITE_FCS.has(fc) && opts.allowWrites)) {\n        if (WRITE_FCS.has(fc)) stats.writesBlocked++;\n        log('blocked FC' + fc);\n        sendBin(exceptionAdu(a, 1));\n        return;\n      }\n      if (!S.open) { sendText({ type: 'error', message: 'device connection is not open yet' }); return; }\n      stats.adusIn++;\n      S.tcp.write(a);\n    }\n  }\n\n  return {\n    server, stats, sessions, health: healthInfo,\n    listen() { return new Promise((resolve, reject) =\u003e { server.once('error', reject); server.listen(opts.port, opts.listen, () =\u003e { server.off('error', reject); resolve(server.address().port); }); }); },\n    close() {\n      sessions.forEach((s) =\u003e s.close(1001, 'bridge shutting down'));\n      const p = new Promise((r) =\u003e server.close(() =\u003e r()));\n      upgraded.forEach((sock) =\u003e sock.destroy());\n      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();   // idle keep-alive HTTP sockets\n      return p;\n    },\n  };\n}\n\n// ─── CLI ─────────────────────────────────────────────────────────────────────\nfunction parseArgs(argv) {\n  const o = { allow: [], origins: [] };\n  for (let i = 0; i \u003c argv.length; i++) {\n    const a = argv[i], v = () =\u003e { if (i + 1 \u003e= argv.length) throw new Error(a + ' needs a value'); return argv[++i]; };\n    if (a === '--allow') o.allow.push(v());\n    else if (a === '--listen') o.listen = v();\n    else if (a === '--port') o.port = +v();\n    else if (a === '--origin') o.origins.push(v());\n    else if (a === '--any-origin') o.anyOrigin = true;\n    else if (a === '--allow-any') o.allow.push('*:*');\n    else if (a === '--allow-writes') o.allowWrites = true;\n    else if (a === '--verbose' || a === '-v') o.verbose = true;\n    else if (a === '--config' || a === '-c') o.config = v();\n    else if (a === '--version' || a === '-V') o.version = true;\n    else if (a === '--help' || a === '-h') o.help = true;\n    else throw new Error('unknown option ' + a);\n  }\n  return o;\n}\n\n// ─── config file ─────────────────────────────────────────────────────────────\nconst CONFIG_KEYS = { allow: 'array', port: 'port', listen: 'string', origins: 'array', anyOrigin: 'boolean', allowWrites: 'boolean', verbose: 'boolean' };\nfunction validPort(p) { return typeof p === 'number' && Number.isInteger(p) && p \u003e= 0 && p \u003c= 65535; }   // 0 = any free port (tests)\n// JSON text of a config file → { options, warnings }. Keys starting with \"_\" are comments;\n// other unknown keys are ignored with a warning (a newer file read by an older bridge).\nfunction parseConfig(text, label) {\n  label = label || 'config';\n  let obj;\n  try { obj = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error(label + ': not valid JSON (' + e.message + ')'); }\n  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(label + ': expected a JSON object {…}');\n  const options = {}, warnings = [];\n  Object.keys(obj).forEach((k) =\u003e {\n    const t = CONFIG_KEYS[k], v = obj[k];\n    if (!t) { if (k[0] !== '_') warnings.push(label + ': unknown key \"' + k + '\" ignored'); return; }\n    if (t === 'array') {\n      if (!Array.isArray(v) || v.some((x) =\u003e typeof x !== 'string')) throw new Error(label + ': \"' + k + '\" must be a list of strings');\n      options[k] = v.map((x) =\u003e x.trim()).filter(Boolean);\n    } else if (t === 'port') {\n      if (!validPort(v)) throw new Error(label + ': \"port\" must be a whole number 1-65535');\n      options[k] = v;\n    } else if (typeof v !== t) throw new Error(label + ': \"' + k + '\" must be a ' + t);\n    else options[k] = v;\n  });\n  (options.allow || []).forEach((a) =\u003e { try { parseAllow(a); } catch (e) { throw new Error(label + ': ' + e.message.replace('--allow', 'allow entry')); } });\n  return { options, warnings };\n}\nfunction loadConfigFile(file) {\n  let text;\n  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error('cannot read config file ' + file + ': ' + e.message); }\n  return parseConfig(text, file);\n}\nfunction uniq(list) { const seen = new Set(); return list.filter((x) =\u003e { const k = String(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }\n// Config file (with --config) + command line → { options, warnings }. Command-line port / listen\n// win; the allow / origins lists are merged; --allow-writes / --any-origin / --verbose only switch on.\nfunction resolveOptions(cli, readConfig) {\n  cli = cli || {};\n  let base = {}, warnings = [];\n  if (cli.config) { const r = (readConfig || loadConfigFile)(cli.config); base = r.options || {}; warnings = r.warnings || []; }\n  const o = {};\n  ['port', 'listen', 'anyOrigin', 'allowWrites', 'verbose'].forEach((k) =\u003e { if (base[k] !== undefined) o[k] = base[k]; });\n  o.allow = uniq((base.allow || []).concat(cli.allow || []).map((x) =\u003e String(x).trim()).filter(Boolean));\n  o.origins = uniq((base.origins || []).concat(cli.origins || []));\n  if (cli.port !== undefined) o.port = cli.port;\n  if (cli.listen !== undefined) o.listen = cli.listen;\n  if (o.listen !== undefined) o.listen = normListen(o.listen);\n  ['anyOrigin', 'allowWrites', 'verbose'].forEach((k) =\u003e { if (cli[k]) o[k] = true; });\n  if (o.port !== undefined && !validPort(o.port)) throw new Error('bad --port (1-65535)');\n  if (o.listen !== undefined && (typeof o.listen !== 'string' || !o.listen)) throw new Error('bad --listen address');\n  o.allow.forEach(parseAllow);\n  return { options: o, warnings };\n}\n\nfunction helpText() {\n  const src = fs.readFileSync(__filename, 'utf8').split('\\n');\n  const end = src.findIndex((l) =\u003e /^'use strict'/.test(l));\n  return src.slice(1, end \u003e 0 ? end : 40).map((l) =\u003e l.replace(/^\\/\\/ ?/, '')).join('\\n');\n}\nfunction main(argv) {\n  let cli, r;\n  try { cli = parseArgs(argv || process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }\n  if (cli.version) { console.log(BRIDGE_VERSION); return; }\n  if (cli.help) { console.log(helpText()); return; }\n  try { r = resolveOptions(cli); } catch (e) { console.error('[bridge] ' + e.message); process.exit(2); }\n  const o = r.options;\n  r.warnings.forEach((w) =\u003e console.warn('[bridge] WARNING: ' + w));\n  if (!o.allow.length || o.allow.some((a) =\u003e /^\\*:/.test(String(a).trim()))) console.log('[bridge] any device IP is allowed' + (o.allow.length ? '' : ' (default; list --allow \u003cip\u003e:\u003cport\u003e targets to restrict)') + '. The bridge still listens on this PC only' + (o.allowWrites ? '' : ' and refuses writes') + '.');\n  if ((o.origins || []).some((x) =\u003e String(x).toLowerCase() === 'null') || o.anyOrigin) console.warn('[bridge] WARNING: ' + (o.anyOrigin ? 'any page origin is accepted' : 'pages with \"Origin: null\" (saved copies, but also sandboxed frames of any web site) are accepted') + ' — only do this on a PC that is not used for general web browsing.');\n  if (o.listen && o.listen !== '127.0.0.1' && o.listen !== '::1') console.warn('[bridge] WARNING: listening on ' + o.listen + ' — other machines on the network can use this bridge.');\n  const b = createBridge(o);\n  const listenHost = o.listen || '127.0.0.1';\n  b.listen().then((port) =\u003e {\n    console.log('[bridge] WTS Modbus bridge v' + BRIDGE_VERSION + ' listening on ws://' + listenHost + ':' + port + '/modbus  (' + (o.allowWrites ? 'writes ALLOWED' : 'read-only') + ')');\n    console.log('[bridge] allowed targets: ' + (o.allow.join(', ') || '*:* (any device)'));\n    console.log('[bridge] health check: http://' + (listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost) + ':' + port + '/health' + (cli.config ? '   (config: ' + cli.config + ')' : ''));\n  }, (e) =\u003e {\n    console.error('[bridge] cannot listen on ' + listenHost + ':' + (o.port || 8502) + ': ' + e.message + (e.code === 'EADDRINUSE' ? ' — another bridge (or program) already uses this port.' : ''));\n    process.exit(1);\n  });\n  const stop = () =\u003e { b.close().then(() =\u003e process.exit(0)); };\n  process.on('SIGINT', stop);\n  process.on('SIGTERM', stop);     // launchd / systemd stop\n}\n\nmodule.exports = { BRIDGE_VERSION, createBridge, parseAllow, allowed, originOk, hostHeaderOk, healthRefusal, normListen, encodeFrame, decodeFrames, takeAdus, exceptionAdu,\n  parseArgs, parseConfig, loadConfigFile, resolveOptions, main };\nif (require.main === module) main();\n",
        "fake-slave.js": "#!/usr/bin/env node\n// =============================================================================\n// fake-slave.js — a tiny Modbus TCP slave for testing the bridge without hardware.\n// Zero dependencies. Serves FC 01-06, 15, 16 on unit id 1 (any unit id with --any-unit),\n// with 10,000 coils / discrete inputs / holding / input registers.\n//\n// Initial contents (so a read is easy to recognise):\n//   holding[i] = i, input[i] = 1000 + i, coil[i] = i % 2, discrete[i] = (i + 1) % 2,\n//   input 100-101 = FLOAT32 ABCD 123.456 (0x42F6 0xE979).\n//\n// Usage: node fake-slave.js [--port 5020] [--listen 127.0.0.1] [--any-unit]\n// =============================================================================\n'use strict';\nconst net = require('net');\n\nfunction createSlave(opts) {\n  opts = Object.assign({ port: 5020, listen: '127.0.0.1', unit: 1, anyUnit: false }, opts || {});\n  const N = 10000;\n  const mem = { coil: new Uint8Array(N), discrete: new Uint8Array(N), holding: new Uint16Array(N), input: new Uint16Array(N) };\n  for (let i = 0; i \u003c N; i++) { mem.holding[i] = i; mem.input[i] = 1000 + i; mem.coil[i] = i % 2; mem.discrete[i] = (i + 1) % 2; }\n  mem.input[100] = 0x42F6; mem.input[101] = 0xE979;\n  const stats = { requests: 0, writes: 0 };\n  function exc(fc, code) { return Buffer.from([fc | 0x80, code]); }\n  function pdu(p) {\n    const fc = p[0], addr = p.readUInt16BE(1), qty = p.readUInt16BE(3);\n    stats.requests++;\n    if (fc === 1 || fc === 2) {\n      if (qty \u003c 1 || qty \u003e 2000) return exc(fc, 3);\n      if (addr + qty \u003e N) return exc(fc, 2);\n      const m = fc === 1 ? mem.coil : mem.discrete, nb = Math.ceil(qty / 8), out = Buffer.alloc(2 + nb);\n      out[0] = fc; out[1] = nb;\n      for (let i = 0; i \u003c qty; i++) if (m[addr + i]) out[2 + (i \u003e\u003e 3)] |= 1 \u003c\u003c (i & 7);\n      return out;\n    }\n    if (fc === 3 || fc === 4) {\n      if (qty \u003c 1 || qty \u003e 125) return exc(fc, 3);\n      if (addr + qty \u003e N) return exc(fc, 2);\n      const m = fc === 3 ? mem.holding : mem.input, out = Buffer.alloc(2 + 2 * qty);\n      out[0] = fc; out[1] = 2 * qty;\n      for (let i = 0; i \u003c qty; i++) out.writeUInt16BE(m[addr + i], 2 + 2 * i);\n      return out;\n    }\n    if (fc === 5) { if (qty !== 0xFF00 && qty !== 0) return exc(fc, 3); if (addr \u003e= N) return exc(fc, 2); mem.coil[addr] = qty ? 1 : 0; stats.writes++; return p.slice(0, 5); }\n    if (fc === 6) { if (addr \u003e= N) return exc(fc, 2); mem.holding[addr] = qty; stats.writes++; return p.slice(0, 5); }\n    if (fc === 15) { const bc = p[5]; if (qty \u003c 1 || qty \u003e 1968 || bc !== Math.ceil(qty / 8)) return exc(fc, 3); if (addr + qty \u003e N) return exc(fc, 2); for (let i = 0; i \u003c qty; i++) mem.coil[addr + i] = (p[6 + (i \u003e\u003e 3)] \u003e\u003e (i & 7)) & 1; stats.writes++; return p.slice(0, 5); }\n    if (fc === 16) { const bc = p[5]; if (qty \u003c 1 || qty \u003e 123 || bc !== 2 * qty) return exc(fc, 3); if (addr + qty \u003e N) return exc(fc, 2); for (let i = 0; i \u003c qty; i++) mem.holding[addr + i] = p.readUInt16BE(6 + 2 * i); stats.writes++; return p.slice(0, 5); }\n    return exc(fc, 1);\n  }\n  const socks = new Set();\n  const server = net.createServer((sock) =\u003e {\n    socks.add(sock); sock.on('close', () =\u003e socks.delete(sock));\n    let buf = Buffer.alloc(0);\n    sock.on('data', (d) =\u003e {\n      buf = Buffer.concat([buf, d]);\n      while (buf.length \u003e= 7) {\n        const len = buf.readUInt16BE(4);\n        if (buf.length \u003c 6 + len) break;\n        const adu = buf.slice(0, 6 + len); buf = buf.slice(6 + len);\n        const unit = adu[6];\n        if (!opts.anyUnit && unit !== opts.unit) continue;      // wrong unit: no reply (gateway behaviour varies)\n        const res = pdu(adu.slice(7));\n        const out = Buffer.alloc(7 + res.length);\n        adu.copy(out, 0, 0, 4); out.writeUInt16BE(res.length + 1, 4); out[6] = unit; res.copy(out, 7);\n        sock.write(out);\n      }\n    });\n    sock.on('error', () =\u003e {});\n  });\n  return {\n    server, mem, stats,\n    listen() { return new Promise((resolve, reject) =\u003e { server.once('error', reject); server.listen(opts.port, opts.listen, () =\u003e resolve(server.address().port)); }); },\n    close() { const p = new Promise((r) =\u003e server.close(() =\u003e r())); socks.forEach((s) =\u003e s.destroy()); return p; },\n  };\n}\n\nmodule.exports = { createSlave };\nif (require.main === module) {\n  const a = process.argv.slice(2), o = {};\n  for (let i = 0; i \u003c a.length; i++) { if (a[i] === '--port') o.port = +a[++i]; else if (a[i] === '--listen') o.listen = a[++i]; else if (a[i] === '--any-unit') o.anyUnit = true; }\n  const s = createSlave(o);\n  s.listen().then((p) =\u003e console.log('[fake-slave] Modbus TCP slave on ' + (o.listen || '127.0.0.1') + ':' + p + ' (unit ' + (o.anyUnit ? 'any' : 1) + ')'));\n}\n",
        "install-windows.ps1": "\u003c#\n.SYNOPSIS\n  Installs the WTS Modbus bridge (WebSocket \u003c-\u003e Modbus TCP) for the current Windows user.\n  No administrator rights are needed for the bridge itself.\n\n.DESCRIPTION\n  1. Checks for Node.js 18 or newer. If it is missing it offers to install the LTS version\n     with \"winget install OpenJS.NodeJS.LTS\" - only after you confirm (or with -Yes).\n     Nothing else is downloaded.\n  2. Copies modbus-bridge.js, fake-slave.js and README.md to\n     \"%LOCALAPPDATA%\\WTS Modbus Bridge\", writes bridge-config.json and start-bridge.cmd,\n     and adds a Start-menu shortcut \"WTS Modbus Bridge\".\n  3. -AutoStart also starts the bridge at every logon (a user-level Scheduled Task, or a\n     Startup-folder shortcut when Task Scheduler refuses).\n  4. Starts the bridge, checks http://127.0.0.1:\u003cport\u003e/health and prints the next steps.\n\n  Running it again keeps the settings of the existing bridge-config.json: new -Allow targets\n  are ADDED to its allow list, and its port / listen address / write setting / origins stay\n  unless you give -Port / -Listen / -AllowWrites / -ReadOnly. -Reset starts from a new, empty\n  configuration (the old file is kept as bridge-config.json.bak).\n\n  Run it from PowerShell (Start menu \u003e type PowerShell) in the folder that holds it:\n    powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Allow \"192.168.1.10:502\"\n  \"-ExecutionPolicy Bypass\" applies to this one run only; it changes no system setting.\n\n.PARAMETER Allow\n  host:port targets the bridge may connect to, comma separated: IPv4 (192.168.1.10:502),\n  IPv4 subnet (10.0.0.0/24:502), host name (plc-1.local:502) or IPv6 in brackets\n  ([fd00::10]:502); port 1-65535 or * (any port). Added to the targets already configured.\n.PARAMETER Port\n  WebSocket port of the bridge (default 8502; the app's bridge URL is ws://127.0.0.1:\u003cport\u003e).\n.PARAMETER Listen\n  Interface to listen on (default 127.0.0.1 = this computer only).\n.PARAMETER AllowAny\n  Allow any device IP / port (same as -Allow \"*:*\"). This is also what you get when no -Allow\n  target is given at all (the default since bridge v1.2.0).\n.PARAMETER AllowWrites\n  Forward Modbus write requests (FC 05/06/15/16). Read-only otherwise.\n.PARAMETER ReadOnly\n  Refuse Modbus write requests again (the default for a new install).\n.PARAMETER Origin\n  Also accept pages from these origins, comma separated: https://my.site, http://host:port, or\n  null for a saved file:// copy of the app (any web site can send \"null\", so only on a PC that\n  is not used for general web browsing).\n.PARAMETER AutoStart\n  Start the bridge automatically at logon.\n.PARAMETER NoStart\n  Install only; do not start the bridge now (with -AutoStart it starts at the next logon).\n.PARAMETER Reset\n  Ignore the existing bridge-config.json and write a new one.\n.PARAMETER Uninstall\n  Stop the bridge and remove the auto-start entry, the shortcuts and the installed files.\n.PARAMETER Yes\n  Answer yes to the Node.js installation question.\n\n.EXAMPLE\n  powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Allow \"192.168.1.10:502,192.168.1.11:502\" -AutoStart\n.EXAMPLE\n  powershell -NoProfile -ExecutionPolicy Bypass -File \"$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1\" -Uninstall\n#\u003e\n[CmdletBinding()]\nparam(\n    [string[]]$Allow = @(),\n    [int]$Port = 0,\n    [string]$Listen = '',\n    [switch]$AllowAny,\n    [switch]$AllowWrites,\n    [switch]$ReadOnly,\n    [string[]]$Origin = @(),\n    [switch]$AutoStart,\n    [switch]$NoStart,\n    [switch]$Reset,\n    [switch]$Uninstall,\n    [switch]$Yes\n)\n$ErrorActionPreference = 'Stop'\n\n# @@WTS-PRESET-BEGIN@@ (the app's \"Generate installer for my devices\" fills in this block)\n$PresetAllow = ''\n$PresetPort = 0\n$PresetListen = ''\n$PresetAllowWrites = $null\n$PresetAutoStart = $false\n$PresetOrigins = ''\n# @@WTS-PRESET-END@@\n\n# @@WTS-PAYLOAD-BEGIN@@ (a generated installer embeds the bridge files here)\n$Embedded = @{}\n$EmbeddedVersion = ''\n# @@WTS-PAYLOAD-END@@\n\n$AppName = 'WTS Modbus Bridge'\n$TaskName = 'WTS Modbus Bridge'\n$NodeMin = 18\n$InstallDir = Join-Path $env:LOCALAPPDATA $AppName\n$StartCmd = Join-Path $InstallDir 'start-bridge.cmd'\n$ConfigPath = Join-Path $InstallDir 'bridge-config.json'\n$InstalledFiles = @('modbus-bridge.js', 'fake-slave.js', 'README.md', 'bridge-config.json', 'bridge-config.json.bak',\n    'start-bridge.cmd', 'install-windows.ps1', 'bridge.log')\n$ConfigComment = 'WTS Modbus bridge settings. allow = the host:port targets the bridge may connect to. Running the installer again keeps these settings and adds new targets (-Reset starts over). Restart the bridge after editing.'\n\nfunction Say([string]$text) { Write-Host $text }\nfunction Warn([string]$text) { Write-Host ('WARNING: ' + $text) -ForegroundColor Yellow }\nfunction Good([string]$text) { Write-Host $text -ForegroundColor Green }\n\n# ---- validation (no PowerShell / cmd metacharacters can get through) ---------\nfunction Test-IPv4([string]$ip) {\n    if (-not ($ip -cmatch '\\A([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\z')) { return $false }\n    for ($i = 1; $i -le 4; $i++) { if ([int]$Matches[$i] -gt 255) { return $false } }\n    return $true\n}\nfunction Test-HostName([string]$h) {\n    if ($h.Length -lt 1 -or $h.Length -gt 253) { return $false }\n    if ($h.StartsWith('[') -and $h.EndsWith(']')) {\n        # IPv6 in brackets: hex digits, colons and dots only (no zone id), 2+ colons\n        $a = $h.Substring(1, $h.Length - 2)\n        if ($a -cnotmatch '\\A[0-9A-Fa-f:.]{2,45}\\z') { return $false }\n        return (($a.Split(':').Length - 1) -ge 2)\n    }\n    if ($h.Contains('/')) {\n        $parts = $h.Split('/')\n        if ($parts.Length -ne 2) { return $false }\n        if (-not (Test-IPv4 ($parts[0]))) { return $false }\n        if ($parts[1] -cnotmatch '\\A[0-9]{1,2}\\z') { return $false }\n        return ([int]$parts[1] -le 32)\n    }\n    if ($h -cmatch '\\A[0-9.]+\\z') { return (Test-IPv4 $h) }\n    if ($h -cnotmatch '\\A[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?\\z') { return $false }\n    return (-not $h.Contains('..'))\n}\nfunction Test-PortText([string]$p) {\n    if ($p -cnotmatch '\\A[0-9]{1,5}\\z') { return $false }\n    $n = [int]$p\n    return ($n -ge 1 -and $n -le 65535)\n}\nfunction Test-Target([string]$t) {\n    $i = $t.LastIndexOf(':')\n    if ($i -le 0) { return $false }\n    if ($t.Substring(0, $i) -ceq '*') { $p = $t.Substring($i + 1); return ($p -eq '*' -or (Test-PortText $p)) }\n    if (-not (Test-HostName ($t.Substring(0, $i)))) { return $false }\n    $p = $t.Substring($i + 1)\n    return ($p -eq '*' -or (Test-PortText $p))\n}\nfunction Test-Listen([string]$a) { return ($a -ceq 'localhost' -or (Test-IPv4 $a)) }\nfunction Get-NormalListen([string]$a) {\n    # \"localhost\" may resolve to ::1 only (Node \u003e= 17 keeps the resolver order) - the app uses 127.0.0.1\n    if ($a -ceq 'localhost') { return '127.0.0.1' }\n    return $a\n}\nfunction Test-Origin([string]$o) {\n    # null | file:// | http(s)://host[:port]\n    if ($o -ceq 'null' -or $o -ceq 'file://') { return $true }\n    if ($o.Length -gt 300) { return $false }\n    if (-not ($o -cmatch '\\Ahttps?://([A-Za-z0-9._-]+|\\[[0-9A-Fa-f:.]+\\])(:([0-9]{1,5}))?\\z')) { return $false }\n    if ($Matches[3]) { return (Test-PortText $Matches[3]) }\n    return $true\n}\nfunction Get-NormalTarget([string]$t) {\n    # a valid target: lower case, port without leading zeros\n    $t = $t.ToLowerInvariant()\n    $i = $t.LastIndexOf(':')\n    $p = $t.Substring($i + 1)\n    if ($p -ne '*') { $p = [string]([int]$p) }\n    return ($t.Substring(0, $i) + ':' + $p)\n}\nfunction Get-SpecForm([string]$t) {\n    # the bridge's own spelling of an allow entry (as /health lists it)\n    $t = $t.Trim()\n    $i = $t.LastIndexOf(':')\n    if ($i -le 0) { return $t.ToLowerInvariant() }\n    $h = $t.Substring(0, $i).Trim('[', ']').ToLowerInvariant()\n    $p = $t.Substring($i + 1)\n    $n = 0\n    if ($p -ne '*' -and [int]::TryParse($p, [ref]$n)) { $p = [string]$n }\n    if ($h.Contains(':')) { $h = '[' + $h + ']' }\n    return ($h + ':' + $p)\n}\n\n$NewAllow = New-Object 'System.Collections.Generic.List[string]'\n$NewOrigins = New-Object 'System.Collections.Generic.List[string]'\n$AllowList = New-Object 'System.Collections.Generic.List[string]'\nfunction Add-Allow([string[]]$items) {\n    foreach ($raw in $items) {\n        if ($null -eq $raw) { continue }\n        foreach ($item in ($raw -split '[,\\s]+')) {\n            if ($item -eq '') { continue }\n            if (-not (Test-Target $item)) {\n                throw (\"Invalid -Allow entry '\" + $item + \"' (use ip:port, ip/bits:port, hostname:port or [ipv6]:port; port 1-65535 or *).\")\n            }\n            $item = Get-NormalTarget $item\n            if (-not $script:NewAllow.Contains($item)) { $script:NewAllow.Add($item) }\n        }\n    }\n}\nfunction Add-Origin([string[]]$items) {\n    foreach ($raw in $items) {\n        if ($null -eq $raw) { continue }\n        foreach ($item in ($raw -split '[,\\s]+')) {\n            if ($item -eq '') { continue }\n            if (-not (Test-Origin $item)) {\n                throw (\"Invalid -Origin '\" + $item + \"' (use https://host[:port], http://host[:port], null or file://).\")\n            }\n            if (-not $script:NewOrigins.Contains($item)) { $script:NewOrigins.Add($item) }\n        }\n    }\n}\nfunction ConvertTo-JsonText([string]$s) {\n    # a JSON string literal (ASCII only)\n    $sb = New-Object System.Text.StringBuilder\n    [void]$sb.Append('\"')\n    foreach ($ch in $s.ToCharArray()) {\n        $code = [int]$ch\n        if ($code -eq 34) { [void]$sb.Append('\\\"') }\n        elseif ($code -eq 92) { [void]$sb.Append('\\\\') }\n        elseif ($code -lt 32 -or $code -gt 126) { [void]$sb.Append(('\\u{0:x4}' -f $code)) }\n        else { [void]$sb.Append($ch) }\n    }\n    [void]$sb.Append('\"')\n    return $sb.ToString()\n}\n\n# ---- helpers -------------------------------------------------------------------\nfunction Confirm-Step([string]$question) {\n    if ($Yes) { return $true }\n    try { $answer = Read-Host ($question + ' [y/N]') } catch { return $false }\n    return ($answer -match '\\A\\s*(y|yes)\\s*\\z')\n}\nfunction Invoke-Quiet([string]$exe, [string[]]$arguments) {\n    # Windows PowerShell 5.1 turns native stderr into errors under 'Stop' - relax it here.\n    $old = $ErrorActionPreference\n    $ErrorActionPreference = 'Continue'\n    try {\n        $out = & $exe @arguments 2\u003e$null\n        return [pscustomobject]@{ Code = $LASTEXITCODE; Out = (@($out) -join \"`n\") }\n    } catch {\n        return [pscustomobject]@{ Code = 1; Out = '' }\n    } finally {\n        $ErrorActionPreference = $old\n    }\n}\nfunction Find-Node {\n    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n    if ($cmd) { return $cmd.Path }\n    $candidates = @((Join-Path $env:ProgramFiles 'nodejs\\node.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs\\node.exe'))\n    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\\node.exe') }\n    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }\n    return $null\n}\nfunction Get-NodeMajor([string]$node) {\n    if (-not $node) { return 0 }\n    $r = Invoke-Quiet $node @('-p', \"process.versions.node.split('.')[0]\")\n    $n = 0\n    if ($r.Code -eq 0 -and [int]::TryParse(($r.Out.Trim()), [ref]$n)) { return $n }\n    return 0\n}\nfunction Show-NodeHelp {\n    Say ('Install Node.js ' + $NodeMin + ' or newer (the LTS version), then run this installer again:')\n    Say '  - winget install OpenJS.NodeJS.LTS'\n    Say '  - or the Windows installer (.msi) from https://nodejs.org'\n}\nfunction Initialize-Node {\n    $node = Find-Node\n    $major = Get-NodeMajor $node\n    if ($major -ge $NodeMin) { return $node }\n    if ($node) { $have = 'version ' + $major + ' at ' + $node } else { $have = 'not found' }\n    Say ('Node.js ' + $NodeMin + ' or newer is needed to run the bridge (Node.js: ' + $have + ').')\n    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n    if (-not $winget) { Show-NodeHelp; throw 'Node.js is missing.' }\n    if (-not (Confirm-Step \"Install Node.js LTS now with 'winget install OpenJS.NodeJS.LTS' (Windows may ask for permission)?\")) {\n        Show-NodeHelp; throw 'Node.js is missing.'\n    }\n    & $winget.Path install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements | Out-Host\n    if ($LASTEXITCODE -ne 0) { Warn ('winget exited with code ' + $LASTEXITCODE) }\n    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')\n    $node = Find-Node\n    $major = Get-NodeMajor $node\n    if ($major -lt $NodeMin) {\n        Say 'Node.js is still not available in this window. Open a new PowerShell window and run the installer again.'\n        throw 'Node.js is missing.'\n    }\n    return $node\n}\nfunction Write-Utf8NoBom([string]$path, [string]$text) {\n    $enc = New-Object System.Text.UTF8Encoding($false)\n    [IO.File]::WriteAllText($path, $text, $enc)\n}\nfunction Get-Health([string]$hostName, [int]$port) {\n    $resp = $null\n    try {\n        $req = [System.Net.WebRequest]::Create('http://' + $hostName + ':' + $port + '/health')\n        $req.Timeout = 2000\n        $req.ReadWriteTimeout = 2000\n        $req.Proxy = $null\n        $resp = $req.GetResponse()\n        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())\n        $text = $reader.ReadToEnd()\n        $reader.Close()\n        return ($text | ConvertFrom-Json)\n    } catch {\n        return $null\n    } finally {\n        if ($resp) { $resp.Close() }\n    }\n}\nfunction Test-PortInUse([string]$hostName, [int]$port) {\n    # anything (a bridge or another program) listening on the port?\n    $client = New-Object System.Net.Sockets.TcpClient\n    try {\n        $ar = $client.BeginConnect($hostName, $port, $null, $null)\n        if (-not $ar.AsyncWaitHandle.WaitOne(1500)) { return $false }\n        $client.EndConnect($ar)\n        return $true\n    } catch {\n        return $false\n    } finally {\n        $client.Close()\n    }\n}\nfunction Test-HealthMatches($h, [int]$port, [bool]$writes) {\n    # is the bridge that answered the one just configured?\n    if ([int]$h.port -ne $port) { return $false }\n    if ([bool]$h.readOnly -eq $writes) { return $false }\n    $got = @(@($h.allow) | Where-Object { $null -ne $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() } | Sort-Object)\n    $want = @($script:AllowList | ForEach-Object { Get-SpecForm $_ } | Sort-Object)\n    return (($got -join ',') -eq ($want -join ','))\n}\nfunction Get-HealthText($h) {\n    if ($h.readOnly) { $m = 'read-only' } else { $m = 'writes ALLOWED' }\n    $allowed = @($h.allow) -join ', '\n    if (-not $allowed) { $allowed = '(none)' }\n    return ('v' + $h.version + ', ' + $m + ', port ' + $h.port + '; allowed targets: ' + $allowed)\n}\nfunction Wait-Health([string]$hostName, [int]$port, [int]$seconds) {\n    for ($i = 0; $i -lt ($seconds * 4); $i++) {\n        $h = Get-Health $hostName $port\n        if ($h) { return $h }\n        Start-Sleep -Milliseconds 250\n    }\n    return $null\n}\nfunction Stop-OurBridges {\n    # node.exe processes started from the install folder (an earlier install or auto-start), and\n    # the console windows running start-bridge.cmd (older auto-start tasks left a \"cmd /K\" prompt\n    # open there, which keeps the install folder in use)\n    $stopped = 0\n    $killed = 0\n    $procs = @()\n    try { $procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'cmd.exe'\" -ErrorAction Stop) } catch { $procs = @() }\n    foreach ($p in $procs) {\n        if ($null -eq $p -or -not $p.CommandLine -or $p.ProcessId -eq $PID) { continue }\n        if ($p.Name -ieq 'node.exe') { $ours = ($p.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) }\n        else { $ours = ($p.CommandLine.IndexOf($StartCmd, [StringComparison]::OrdinalIgnoreCase) -ge 0) }\n        if ($ours) {\n            try {\n                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop\n                $killed++\n                if ($p.Name -ieq 'node.exe') { $stopped++ }\n            } catch { }\n        }\n    }\n    if ($killed -gt 0) { Start-Sleep -Milliseconds 500 }\n    return $stopped\n}\nfunction New-Shortcut([string]$lnk, [string]$target, [string]$workDir, [string]$description, [int]$windowStyle, [string]$icon) {\n    $shell = New-Object -ComObject WScript.Shell\n    $s = $shell.CreateShortcut($lnk)\n    $s.TargetPath = $target\n    $s.WorkingDirectory = $workDir\n    $s.Description = $description\n    $s.WindowStyle = $windowStyle\n    if ($icon) { $s.IconLocation = $icon + ',0' }\n    $s.Save()\n}\nfunction Get-StartMenuLink { return (Join-Path ([Environment]::GetFolderPath('Programs')) ($AppName + '.lnk')) }\nfunction Get-StartupLink { return (Join-Path ([Environment]::GetFolderPath('Startup')) ($AppName + '.lnk')) }\nfunction Remove-AutoStart {\n    try {\n        $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue\n        if ($t) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Say ('Removed the scheduled task \"' + $TaskName + '\"') }\n    } catch { }\n    $startup = Get-StartupLink\n    if (Test-Path -LiteralPath $startup) { Remove-Item -LiteralPath $startup -Force; Say ('Removed ' + $startup) }\n}\nfunction Register-AutoStart([string]$node) {\n    $user = $env:USERNAME\n    if ($env:USERDOMAIN) { $user = $env:USERDOMAIN + '\\' + $env:USERNAME }\n    try {\n        # \"start\" runs a .cmd file with \"cmd /K\": that window would stay open at a prompt after the\n        # bridge ends, keeping the install folder in use. A minimised \"cmd /c call\" closes with it.\n        $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/c start \"' + $AppName + '\" /min \"' + $env:ComSpec + '\" /c call \"' + $StartCmd + '\"') -WorkingDirectory $InstallDir\n        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user\n        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited\n        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)\n        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `\n            -Description 'Starts the WTS Modbus bridge (WebSocket to Modbus TCP) at logon.' -Force -ErrorAction Stop | Out-Null\n        $startup = Get-StartupLink\n        if (Test-Path -LiteralPath $startup) { Remove-Item -LiteralPath $startup -Force }\n        Say ('Auto-start: scheduled task \"' + $TaskName + '\" (at logon, this user, no admin rights)')\n    } catch {\n        New-Shortcut (Get-StartupLink) $StartCmd $InstallDir 'Starts the WTS Modbus bridge at logon' 7 $node\n        Say ('Auto-start: Startup-folder shortcut ' + (Get-StartupLink) + ' (Task Scheduler said: ' + $_.Exception.Message + ')')\n    }\n}\nfunction Test-AutoStartInstalled {\n    try { if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { return $true } } catch { }\n    return (Test-Path -LiteralPath (Get-StartupLink))\n}\nfunction Get-ConfiguredPort {\n    try {\n        $c = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json\n        if ($c.port -ge 1 -and $c.port -le 65535) { return [int]$c.port }\n    } catch { }\n    if ($Port -ge 1 -and $Port -le 65535) { return $Port }\n    return 8502\n}\nfunction Wait-IfStartedFromExplorer {\n    # \"Run with PowerShell\" from Explorer closes the window at once - keep it open to read.\n    try {\n        $me = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $PID) -ErrorAction Stop\n        $parent = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $me.ParentProcessId) -ErrorAction Stop\n        if ($parent -and $parent.Name -ieq 'explorer.exe') { Read-Host 'Press Enter to close this window' | Out-Null }\n    } catch { }\n}\n\n# ---- uninstall -----------------------------------------------------------------\nfunction Invoke-Uninstall {\n    $p = Get-ConfiguredPort\n    Remove-AutoStart\n    $lnk = Get-StartMenuLink\n    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Say ('Removed ' + $lnk) }\n    $n = Stop-OurBridges\n    if ($n -gt 0) { Say ('Stopped ' + $n + ' running bridge process(es)') }\n    if (Test-Path -LiteralPath $InstallDir) {\n        $removed = 0\n        foreach ($f in $InstalledFiles) {\n            $path = Join-Path $InstallDir $f\n            if (Test-Path -LiteralPath $path) {\n                try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop; $removed++ }\n                catch { Warn ('could not remove ' + $path + ' (' + $_.Exception.Message + ')') }\n            }\n        }\n        if (@(Get-ChildItem -LiteralPath $InstallDir -Force).Length -eq 0) {\n            try {\n                Remove-Item -LiteralPath $InstallDir -Force -ErrorAction Stop\n                Say ('Removed ' + $InstallDir + ' (' + $removed + ' files)')\n            } catch {\n                Warn ('removed ' + $removed + ' files, but not the empty folder ' + $InstallDir + ' (' + $_.Exception.Message + '). A window may still use it: close the \"' + $AppName + '\" window, then delete the folder.')\n            }\n        } else {\n            Warn ($InstallDir + ' still contains other files - left in place')\n        }\n    } else {\n        Say ('Nothing installed in ' + $InstallDir)\n    }\n    if (Get-Health '127.0.0.1' $p) { Warn ('a bridge still answers on port ' + $p + ' (started by hand?) - close its window.') }\n    Good 'The WTS Modbus bridge is uninstalled.'\n}\n\n# ---- install -------------------------------------------------------------------\nfunction Install-Files {\n    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null\n    if ($Embedded.Count -gt 0) {\n        foreach ($name in @($Embedded.Keys)) {\n            $entry = $Embedded[$name]\n            $dest = Join-Path $InstallDir $name\n            [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($entry.B64))\n            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLowerInvariant()\n            if ($got -ne $entry.Sha256) { throw ($name + ': SHA-256 mismatch after unpacking (installer damaged?) - download it again from the app.') }\n        }\n        Say ('Unpacked bridge v' + $EmbeddedVersion + ' (SHA-256 verified)')\n    } else {\n        $src = $PSScriptRoot\n        if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src 'modbus-bridge.js'))) {\n            throw ('modbus-bridge.js was not found next to this installer (' + $src + '). Download the bridge package from the app''s Modbus page, unzip it and run install-windows.ps1 from that folder.')\n        }\n        foreach ($f in @('modbus-bridge.js', 'fake-slave.js', 'README.md')) {\n            $from = Join-Path $src $f\n            $to = Join-Path $InstallDir $f\n            if ((Test-Path -LiteralPath $from) -and ($from -ne $to)) { Copy-Item -LiteralPath $from -Destination $to -Force }\n        }\n    }\n    $self = $PSCommandPath\n    $selfCopy = Join-Path $InstallDir 'install-windows.ps1'\n    if ($self -and (Test-Path -LiteralPath $self) -and ($self -ne $selfCopy)) { Copy-Item -LiteralPath $self -Destination $selfCopy -Force }\n    try { Get-ChildItem -LiteralPath $InstallDir -File | Unblock-File -ErrorAction SilentlyContinue } catch { }\n}\nfunction Read-OldConfig {\n    # the bridge-config.json of an earlier install: its settings are the defaults of this run\n    $r = @{ Have = $false; Allow = @(); Port = 0; Listen = ''; Writes = $null; Origins = @(); AnyOrigin = $false; Verbose = $false }\n    if ($Reset -or -not (Test-Path -LiteralPath $ConfigPath)) { return $r }\n    try { $c = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json } catch { $c = $null }\n    if ($null -eq $c -or $c -is [array] -or $c -is [string] -or $c -is [ValueType]) {\n        Warn ($ConfigPath + ' could not be read (not valid JSON?) - writing a new one (the old file is kept as bridge-config.json.bak).')\n        return $r\n    }\n    $r.Have = $true\n    foreach ($a in @($c.allow)) {\n        if (-not ($a -is [string])) { continue }\n        $t = $a.Trim()\n        if (Test-Target $t) { $t = Get-NormalTarget $t }\n        elseif ($t -cnotmatch '\\A[\\[\\]A-Za-z0-9._:/*-]+\\z') { Warn (\"left out '\" + $t + \"' from the existing allow list (not a host:port target)\"); continue }\n        if ($r.Allow -notcontains $t) { $r.Allow += $t }\n    }\n    if ($null -ne $c.port -and ([string]$c.port) -cmatch '\\A[0-9]{1,5}\\z' -and (Test-PortText ([string]$c.port))) { $r.Port = [int]$c.port }\n    if ($c.listen -is [string]) {\n        if (Test-Listen $c.listen.Trim()) { $r.Listen = Get-NormalListen $c.listen.Trim() }\n        else { Warn (\"the existing listen address '\" + $c.listen + \"' is not an IPv4 address or localhost - not kept\") }\n    }\n    if ($c.allowWrites -is [bool]) { $r.Writes = [bool]$c.allowWrites }\n    foreach ($o in @($c.origins)) { if ($o -is [string] -and $o.Trim()) { $r.Origins += $o.Trim() } }\n    $r.AnyOrigin = (($c.anyOrigin -is [bool]) -and $c.anyOrigin)\n    $r.Verbose = (($c.verbose -is [bool]) -and $c.verbose)\n    return $r\n}\nfunction Write-Config([int]$port, [string]$listen, [bool]$writes, [string[]]$origins, [bool]$anyOrigin, [bool]$verbose) {\n    # origins, anyOrigin and verbose come from the old file (plus -Origin); values JSON-escaped\n    $allowJson = (@($AllowList | ForEach-Object { ConvertTo-JsonText $_ })) -join ', '\n    $originsJson = (@($origins | Where-Object { $_ } | ForEach-Object { ConvertTo-JsonText $_ })) -join ', '\n    if ($writes) { $w = 'true' } else { $w = 'false' }\n    if ($anyOrigin) { $any = 'true' } else { $any = 'false' }\n    if ($verbose) { $verb = 'true' } else { $verb = 'false' }\n    $json = \"{`n\" +\n        \"  \"\"_comment\"\": \" + (ConvertTo-JsonText $ConfigComment) + \",`n\" +\n        \"  \"\"allow\"\": [\" + $allowJson + \"],`n\" +\n        \"  \"\"port\"\": \" + $port + \",`n\" +\n        \"  \"\"listen\"\": \" + (ConvertTo-JsonText $listen) + \",`n\" +\n        \"  \"\"origins\"\": [\" + $originsJson + \"],`n\" +\n        \"  \"\"anyOrigin\"\": \" + $any + \",`n\" +\n        \"  \"\"allowWrites\"\": \" + $w + \",`n\" +\n        \"  \"\"verbose\"\": \" + $verb + \"`n\" +\n        \"}`n\"\n    if (Test-Path -LiteralPath $ConfigPath) {\n        $old = [IO.File]::ReadAllText($ConfigPath)\n        if ($old -ne $json) { Copy-Item -LiteralPath $ConfigPath -Destination ($ConfigPath + '.bak') -Force }\n    }\n    Write-Utf8NoBom $ConfigPath $json\n}\nfunction Write-StartCmd([string]$node) {\n    $nodeForCmd = $node.Replace('%', '%%')\n    $text = \"@echo off`r`n\" +\n        \"rem Starts the WTS Modbus bridge with bridge-config.json (written by install-windows.ps1).`r`n\" +\n        \"rem Extra options are passed on, e.g.  start-bridge.cmd --verbose`r`n\" +\n        \"chcp 65001 \u003enul`r`n\" +\n        \"title \" + $AppName + \"`r`n\" +\n        \"\"\"\" + $nodeForCmd + \"\"\" \"\"%~dp0modbus-bridge.js\"\" --config \"\"%~dp0bridge-config.json\"\" %*`r`n\" +\n        \"if errorlevel 1 pause`r`n\"\n    Write-Utf8NoBom $StartCmd $text\n}\nfunction Show-NextSteps([string]$hostName, [int]$port) {\n    Say ''\n    Say 'Next steps in the Well Testing Suite (Modbus Config page):'\n    Say '  1. For each device choose transport \"Modbus TCP via WebSocket bridge\", enter the'\n    Say ('     PLC''s IP address and port, and the bridge URL ws://' + $hostName + ':' + $port)\n    Say '  2. Press \"Check bridge\" in the setup guide, then \"Test\" on the device row.'\n    Say ''\n    Say ('Installed in:  ' + $InstallDir)\n    Say ('Settings:      ' + $ConfigPath + ' (restart the bridge after editing)')\n    Say ('Start:         Start menu \u003e ' + $AppName + '   (or \"' + $StartCmd + '\")')\n    Say ('Add a device:  powershell -NoProfile -ExecutionPolicy Bypass -File \"' + (Join-Path $InstallDir 'install-windows.ps1') + '\" -Allow \u003cip\u003e:\u003cport\u003e   (keeps the other settings)')\n    Say ('Uninstall:     powershell -NoProfile -ExecutionPolicy Bypass -File \"' + (Join-Path $InstallDir 'install-windows.ps1') + '\" -Uninstall')\n}\n\nfunction Invoke-Install {\n    Add-Allow @($PresetAllow)\n    Add-Allow $Allow\n    if ($AllowAny) { Add-Allow @('*:*') }\n    Add-Origin @($PresetOrigins)\n    Add-Origin $Origin\n    if ($AllowWrites -and $ReadOnly) { throw 'Use either -AllowWrites or -ReadOnly, not both.' }\n    if ($Port -ne 0 -and ($Port -lt 1 -or $Port -gt 65535)) { throw ('Invalid -Port ' + $Port + ' (1-65535).') }\n    if ($PresetPort -ne 0 -and ($PresetPort -lt 1 -or $PresetPort -gt 65535)) { throw ('Invalid preset port ' + $PresetPort + ' (1-65535).') }\n    if ($Listen -and -not (Test-Listen $Listen)) { throw (\"Invalid -Listen '\" + $Listen + \"' (an IPv4 address or localhost).\") }\n    if ($PresetListen -and -not (Test-Listen $PresetListen)) { throw (\"Invalid preset listen address '\" + $PresetListen + \"'.\") }\n\n    $node = Initialize-Node\n    # The existing bridge-config.json supplies the defaults, so running the installer again (for one\n    # more device, or -AllowWrites) never drops the other targets or changes the port.\n    $old = Read-OldConfig\n    foreach ($e in (@($old.Allow) + @($NewAllow))) { if ($e -and -not $script:AllowList.Contains($e)) { $script:AllowList.Add($e) } }\n    $origins = @()\n    foreach ($o in (@($old.Origins) + @($NewOrigins))) { if ($o -and ($origins -notcontains $o)) { $origins += $o } }\n    $port = 8502\n    if ($Port -gt 0) { $port = $Port } elseif ($PresetPort -gt 0) { $port = $PresetPort } elseif ($old.Port -gt 0) { $port = $old.Port }\n    $listen = '127.0.0.1'\n    if ($Listen) { $listen = $Listen } elseif ($PresetListen) { $listen = $PresetListen } elseif ($old.Listen) { $listen = $old.Listen }\n    $listen = Get-NormalListen $listen\n    $writes = $false\n    if ($ReadOnly) { $writes = $false }\n    elseif ($AllowWrites) { $writes = $true }\n    elseif ($null -ne $PresetAllowWrites) { $writes = [bool]$PresetAllowWrites }\n    elseif ($null -ne $old.Writes) { $writes = [bool]$old.Writes }\n    $auto = [bool]($AutoStart -or $PresetAutoStart)\n    $healthHost = $listen\n    if ($healthHost -eq '0.0.0.0') { $healthHost = '127.0.0.1' }\n\n    if ($old.Have) { Say ('Keeping the settings of the existing ' + $ConfigPath + ' (' + @($old.Allow).Count + ' target(s); new targets are added - -Reset starts a new list).') }\n    if ($AllowList.Count -eq 0) {\n        $script:AllowList.Add('*:*')\n        Say 'No -Allow targets given: the bridge will allow any device IP / port (default). Give -Allow \u003cip\u003e:\u003cport\u003e (with -Reset) to restrict it.'\n    }\n    # Before anything is written: stop the bridges of an earlier install, then the port must be free\n    # (otherwise the new bridge could not start, and the settings on disk would not match the bridge\n    # that answers).\n    if (-not $NoStart) {\n        $n = Stop-OurBridges\n        if ($n -gt 0) { Say ('Stopped ' + $n + ' bridge process(es) from an earlier install') }\n        $other = Get-Health $healthHost $port\n        if ($other) {\n            throw ('another WTS Modbus bridge already answers on http://' + $healthHost + ':' + $port + ' (' + (Get-HealthText $other) + ') - it was not started by this install (a bridge started by hand?). Close its window, or install with -Port \u003cother\u003e. Nothing was changed.')\n        }\n        if (Test-PortInUse $healthHost $port) {\n            throw ('another program already uses port ' + $port + ' on ' + $healthHost + '. Stop it, or install with -Port \u003cother\u003e (and use that port in the device bridge URL). Nothing was changed.')\n        }\n    }\n    Install-Files\n    Write-Config $port $listen $writes $origins $old.AnyOrigin $old.Verbose\n    Write-StartCmd $node\n    New-Shortcut (Get-StartMenuLink) $StartCmd $InstallDir 'WTS Modbus bridge (WebSocket to Modbus TCP) for the Well Testing Suite' 1 $node\n    if ($writes) { $mode = 'writes ALLOWED' } else { $mode = 'read-only' }\n    $targets = $AllowList -join ', '\n    if (-not $targets) { $targets = '(none)' }\n    Good ('Installed the WTS Modbus bridge in ' + $InstallDir)\n    Say ('  allowed targets: ' + $targets + '   port: ' + $port + '   ' + $mode)\n    Say ('  Start-menu shortcut: ' + (Get-StartMenuLink))\n    if ($auto) { Register-AutoStart $node }\n    elseif (Test-AutoStartInstalled) { Say 'Auto-start from an earlier install is still set up (it uses the new settings from the next logon).' }\n\n    if ($NoStart) { Show-NextSteps $healthHost $port; return }\n    if ($auto) { $style = 'Minimized' } else { $style = 'Normal' }\n    Start-Process -FilePath $StartCmd -WorkingDirectory $InstallDir -WindowStyle $style\n    $h = Wait-Health $healthHost $port 15\n    if ($h) {\n        if (-not (Test-HealthMatches $h $port $writes)) {\n            throw ('the bridge answering on port ' + $port + ' is not the one just installed (' + (Get-HealthText $h) + '). Another bridge may be running: close it and run the installer again.')\n        }\n        Say ''\n        Good ('OK: the WTS Modbus bridge is running - ' + (Get-HealthText $h))\n        Say ('    health check: http://' + $healthHost + ':' + $port + '/health')\n        Say ('    It runs in its own window \"' + $AppName + '\" - leave that window open while you use the app.')\n    } else {\n        Warn ('the bridge did not answer on http://' + $healthHost + ':' + $port + '/health within 15 s - look at the \"' + $AppName + '\" window for the error.')\n    }\n    Show-NextSteps $healthHost $port\n}\n\n$exitCode = 0\ntry {\n    if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }\n} catch {\n    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red\n    $exitCode = 1\n} finally {\n    Wait-IfStartedFromExplorer\n}\nexit $exitCode\n",
        "install.sh": "#!/usr/bin/env bash\n# =============================================================================\n# install.sh - installs the WTS Modbus bridge (WebSocket \u003c-\u003e Modbus TCP) for the\n# current user on macOS or Linux. No sudo / admin rights are needed for the bridge.\n#\n#   bash install.sh --allow 192.168.1.10:502 [--allow '10.0.0.0/24:502,plc.local:*']\n#                   [--port 8502] [--listen 127.0.0.1] [--allow-writes | --read-only]\n#                   [--origin https://my.site] [--autostart] [--reset]\n#                   [--yes] [--no-start] [--uninstall] [--help]\n#\n# What it does\n#   1. Checks for Node.js 18 or newer. If it is missing it offers to install it with the\n#      system package manager (brew, apt-get, dnf, yum, pacman or apk) - only after you\n#      confirm (or with --yes). Nothing else is downloaded.\n#   2. Copies modbus-bridge.js, fake-slave.js and README.md to\n#        macOS:  ~/Library/Application Support/WTS Modbus Bridge\n#        Linux:  ${XDG_DATA_HOME:-~/.local/share}/wts-modbus-bridge\n#      and writes bridge-config.json and start-bridge.sh there.\n#   3. --autostart: a macOS LaunchAgent (~/Library/LaunchAgents/uk.co.h2oil.wts-modbus-bridge.plist)\n#      or a Linux systemd --user service (wts-modbus-bridge.service) starts the bridge now and\n#      at every login. Without --autostart the bridge runs in this terminal window\n#      (Ctrl+C stops it); an existing auto-start bridge is restarted with the new settings.\n#   4. Checks http://127.0.0.1:\u003cport\u003e/health and prints the next steps.\n#\n# Running it again keeps the settings of the existing bridge-config.json: new --allow targets\n# are ADDED to its allow list, and its port / listen address / write setting / origins stay\n# unless you give --port / --listen / --allow-writes / --read-only. --reset starts from a new,\n# empty configuration (the old file is kept as bridge-config.json.bak).\n#\n# --allow   host:port the bridge may connect to (repeat it, or give a comma list):\n#           IPv4 (192.168.1.10:502), IPv4 subnet (10.0.0.0/24:502), host name\n#           (plc-1.local:502) or IPv6 in brackets ([fd00::10]:502); port 1-65535 or * (any\n#           port). Quote values with * or [ ] ('plc.local:*') - zsh refuses an unmatched glob.\n#           With no --allow at all the bridge allows any device IP / port (default).\n# --allow-any  allow any device IP / port (same as --allow '*:*').\n# --port    WebSocket port of the bridge (default 8502; the app's bridge URL is ws://127.0.0.1:\u003cport\u003e).\n# --listen  interface to listen on (default 127.0.0.1 = this computer only).\n# --allow-writes  forward Modbus write requests (FC 05/06/15/16); --read-only refuses them (default).\n# --origin  also accept pages from this origin (https://my.site, or null for a saved file:// copy\n#           of the app - any web site can send \"null\", so only on a PC not used for browsing).\n# --no-start      install only; do not start the bridge (with --autostart: it starts at the next login).\n# --reset         ignore the existing bridge-config.json and write a new one.\n# --uninstall     stop and remove the auto-start entry and the installed files.\n# =============================================================================\nset -euo pipefail\n\n# @@WTS-PRESET-BEGIN@@ (the app's \"Generate installer for my devices\" fills in this block)\nPRESET_ALLOW=\"\"\nPRESET_PORT=\"\"\nPRESET_LISTEN=\"\"\nPRESET_ALLOW_WRITES=\"\"\nPRESET_AUTOSTART=\"\"\nPRESET_ORIGINS=\"\"\n# @@WTS-PRESET-END@@\n\n# @@WTS-PAYLOAD-BEGIN@@ (a generated installer embeds the bridge files here)\nEMBEDDED_FILES=\"\"\nEMBEDDED_VERSION=\"\"\n# @@WTS-PAYLOAD-END@@\n\nAPP_NAME=\"WTS Modbus Bridge\"\nLABEL=\"uk.co.h2oil.wts-modbus-bridge\"\nUNIT_NAME=\"wts-modbus-bridge.service\"\nDEFAULT_PORT=8502\nNODE_MIN=18\nINSTALLED_FILES=(modbus-bridge.js fake-slave.js README.md bridge-config.json bridge-config.json.bak bridge-config.json.tmp start-bridge.sh install.sh bridge.log)\n\nsay()  { printf '%s\\n' \"$*\"; }\nwarn() { printf 'WARNING: %s\\n' \"$*\" \u003e&2; }\ndie()  { printf 'ERROR: %s\\n' \"$*\" \u003e&2; exit 1; }\n\nusage() {\n    sed -n '2,/^# =====/p' \"${BASH_SOURCE[0]}\" 2\u003e/dev/null | sed -e 's/^# \\{0,1\\}//' -e '/^=====/d' || true\n}\n\n# ---- validation (no shell metacharacters can get through) -------------------\nvalid_ipv4() {\n    local ip=\"$1\" i\n    [[ \"$ip\" =~ ^([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})$ ]] || return 1\n    for i in 1 2 3 4; do\n        (( 10#${BASH_REMATCH[$i]} \u003c= 255 )) || return 1\n    done\n    return 0\n}\nvalid_ipv6() {                      # hex digits, colons and dots only (no zone id), 2+ colons\n    local a=\"$1\" colons\n    [[ \"$a\" =~ ^[0-9A-Fa-f:.]{2,45}$ ]] || return 1\n    colons=\"${a//[^:]/}\"\n    [ \"${#colons}\" -ge 2 ]\n}\nvalid_host() {\n    local h=\"$1\" ip bits\n    if [ \"${#h}\" -lt 1 ] || [ \"${#h}\" -gt 253 ]; then return 1; fi\n    if [[ \"$h\" == \\[*\\] ]]; then valid_ipv6 \"${h:1:${#h}-2}\"; return; fi\n    if [[ \"$h\" == */* ]]; then\n        ip=\"${h%/*}\"; bits=\"${h##*/}\"\n        valid_ipv4 \"$ip\" || return 1\n        [[ \"$bits\" =~ ^[0-9]{1,2}$ ]] || return 1\n        (( 10#$bits \u003c= 32 )) || return 1\n        return 0\n    fi\n    if [[ \"$h\" =~ ^[0-9.]+$ ]]; then valid_ipv4 \"$h\"; return; fi\n    [[ \"$h\" =~ ^[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?$ ]] || return 1\n    [[ \"$h\" != *..* ]]\n}\nvalid_port() {\n    [[ \"$1\" =~ ^[0-9]{1,5}$ ]] || return 1\n    (( 10#$1 \u003e= 1 && 10#$1 \u003c= 65535 ))\n}\nvalid_target() {\n    local t=\"$1\"\n    [[ \"$t\" == *:* ]] || return 1\n    if [ \"${t%:*}\" = \"*\" ]; then [ \"${t##*:}\" = \"*\" ] || valid_port \"${t##*:}\"; return; fi\n    valid_host \"${t%:*}\" || return 1\n    [ \"${t##*:}\" = \"*\" ] || valid_port \"${t##*:}\"\n}\nnorm_target() {                     # a valid target -\u003e lower case, port without leading zeros\n    local t h p\n    t=\"$(printf '%s' \"$1\" | tr '[:upper:]' '[:lower:]')\"\n    h=\"${t%:*}\"; p=\"${t##*:}\"\n    if [ \"$p\" != \"*\" ]; then p=$((10#$p)); fi\n    printf '%s:%s' \"$h\" \"$p\"\n}\nvalid_listen() {\n    [ \"$1\" = \"localhost\" ] || valid_ipv4 \"$1\"\n}\nnorm_listen() {                     # \"localhost\" may resolve to ::1 only - the app uses 127.0.0.1\n    if [ \"$1\" = \"localhost\" ]; then printf '127.0.0.1'; else printf '%s' \"$1\"; fi\n}\nvalid_origin() {                    # null | file:// | http(s)://host[:port]\n    local o=\"$1\" re='^https?://([A-Za-z0-9._-]+|\\[[0-9A-Fa-f:.]+\\])(:([0-9]{1,5}))?$'\n    case \"$o\" in null|file://) return 0 ;; esac\n    [ \"${#o}\" -le 300 ] || return 1\n    [[ \"$o\" =~ $re ]] || return 1\n    if [ -n \"${BASH_REMATCH[3]:-}\" ]; then valid_port \"${BASH_REMATCH[3]}\" || return 1; fi\n    return 0\n}\nin_list() {                         # $1 in the remaining arguments?\n    local x=\"$1\" e\n    shift\n    for e in \"$@\"; do\n        if [ \"$e\" = \"$x\" ]; then return 0; fi\n    done\n    return 1\n}\n\nNEW_ALLOW=(); NEW_ORIGINS=()\nadd_allow() {                       # $1 = one entry or a comma-separated list\n    local item parts=()\n    IFS=',' read -r -a parts \u003c\u003c\u003c \"$1\"\n    for item in ${parts[@]+\"${parts[@]}\"}; do\n        item=\"${item//[[:space:]]/}\"\n        [ -n \"$item\" ] || continue\n        valid_target \"$item\" || die \"invalid --allow entry '$item' (use ip:port, ip/bits:port, hostname:port or [ipv6]:port; port 1-65535 or *)\"\n        item=\"$(norm_target \"$item\")\"\n        in_list \"$item\" ${NEW_ALLOW[@]+\"${NEW_ALLOW[@]}\"} || NEW_ALLOW+=(\"$item\")\n    done\n    return 0\n}\nadd_origin() {                      # $1 = one origin or a comma-separated list\n    local item parts=()\n    IFS=',' read -r -a parts \u003c\u003c\u003c \"$1\"\n    for item in ${parts[@]+\"${parts[@]}\"}; do\n        item=\"${item//[[:space:]]/}\"\n        [ -n \"$item\" ] || continue\n        valid_origin \"$item\" || die \"invalid --origin '$item' (use https://host[:port], http://host[:port], null or file://)\"\n        in_list \"$item\" ${NEW_ORIGINS[@]+\"${NEW_ORIGINS[@]}\"} || NEW_ORIGINS+=(\"$item\")\n    done\n    return 0\n}\n\n# ---- arguments ----------------------------------------------------------------\nCLI_PORT=\"\"; CLI_LISTEN=\"\"; CLI_WRITES=\"\"; AUTOSTART=0; UNINSTALL=0; ASSUME_YES=0; NO_START=0; RESET=0\nif [ -n \"$PRESET_ALLOW\" ]; then add_allow \"$PRESET_ALLOW\"; fi\nif [ -n \"$PRESET_ORIGINS\" ]; then add_origin \"$PRESET_ORIGINS\"; fi\nif [ \"$PRESET_AUTOSTART\" = \"1\" ]; then AUTOSTART=1; fi\nwhile [ $# -gt 0 ]; do\n    case \"$1\" in\n        --allow)        [ $# -ge 2 ] || die \"--allow needs host:port\"; add_allow \"$2\"; shift 2 ;;\n        --allow=*)      add_allow \"${1#*=}\"; shift ;;\n        --origin)       [ $# -ge 2 ] || die \"--origin needs an origin\"; add_origin \"$2\"; shift 2 ;;\n        --origin=*)     add_origin \"${1#*=}\"; shift ;;\n        --port)         [ $# -ge 2 ] || die \"--port needs a number\"; CLI_PORT=\"$2\"; shift 2 ;;\n        --port=*)       CLI_PORT=\"${1#*=}\"; shift ;;\n        --listen)       [ $# -ge 2 ] || die \"--listen needs an address\"; CLI_LISTEN=\"$2\"; shift 2 ;;\n        --listen=*)     CLI_LISTEN=\"${1#*=}\"; shift ;;\n        --allow-any)    add_allow '*:*'; shift ;;\n        --allow-writes) CLI_WRITES=1; shift ;;\n        --read-only)    CLI_WRITES=0; shift ;;\n        --autostart)    AUTOSTART=1; shift ;;\n        --no-start)     NO_START=1; shift ;;\n        --reset)        RESET=1; shift ;;\n        --uninstall)    UNINSTALL=1; shift ;;\n        -y|--yes)       ASSUME_YES=1; shift ;;\n        -h|--help)      usage; exit 0 ;;\n        *)              die \"unknown option '$1' (see: bash install.sh --help)\" ;;\n    esac\ndone\nif [ -n \"$CLI_PORT\" ]; then\n    valid_port \"$CLI_PORT\" || die \"invalid --port '$CLI_PORT' (1-65535)\"\n    CLI_PORT=$((10#$CLI_PORT))\nfi\nif [ -n \"$PRESET_PORT\" ]; then\n    valid_port \"$PRESET_PORT\" || die \"invalid preset port '$PRESET_PORT' (1-65535)\"\n    PRESET_PORT=$((10#$PRESET_PORT))\nfi\nif [ -n \"$CLI_LISTEN\" ]; then\n    valid_listen \"$CLI_LISTEN\" || die \"invalid --listen '$CLI_LISTEN' (an IPv4 address or localhost)\"\n    CLI_LISTEN=\"$(norm_listen \"$CLI_LISTEN\")\"\nfi\nif [ -n \"$PRESET_LISTEN\" ]; then\n    valid_listen \"$PRESET_LISTEN\" || die \"invalid preset listen address '$PRESET_LISTEN'\"\n    PRESET_LISTEN=\"$(norm_listen \"$PRESET_LISTEN\")\"\nfi\ncase \"$PRESET_ALLOW_WRITES\" in \"\"|0|1) ;; *) die \"invalid preset PRESET_ALLOW_WRITES '$PRESET_ALLOW_WRITES'\" ;; esac\n# Until the existing configuration is read (install) - used as they are by --uninstall.\nPORT=\"${CLI_PORT:-${PRESET_PORT:-$DEFAULT_PORT}}\"\nLISTEN=\"${CLI_LISTEN:-${PRESET_LISTEN:-127.0.0.1}}\"\n\n# ---- where things go -----------------------------------------------------------\n[ -n \"${HOME:-}\" ] || die \"HOME is not set\"\nPLIST=\"\"; UNIT_FILE=\"\"\ncase \"$(uname -s)\" in\n    Darwin)\n        OS=macos\n        INSTALL_DIR=\"$HOME/Library/Application Support/$APP_NAME\"\n        PLIST=\"$HOME/Library/LaunchAgents/$LABEL.plist\" ;;\n    Linux)\n        OS=linux\n        case \"${XDG_DATA_HOME:-}\" in /*) DATA_HOME=\"$XDG_DATA_HOME\" ;; *) DATA_HOME=\"$HOME/.local/share\" ;; esac\n        case \"${XDG_CONFIG_HOME:-}\" in /*) CONFIG_HOME=\"$XDG_CONFIG_HOME\" ;; *) CONFIG_HOME=\"$HOME/.config\" ;; esac\n        INSTALL_DIR=\"$DATA_HOME/wts-modbus-bridge\"\n        UNIT_FILE=\"$CONFIG_HOME/systemd/user/$UNIT_NAME\" ;;\n    *)\n        die \"unsupported system '$(uname -s)' - on Windows use install-windows.ps1\" ;;\nesac\nSCRIPT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" 2\u003e/dev/null && pwd)\" || SCRIPT_DIR=\".\"\nNODE_BIN=\"\"\nHEALTH_HOST=\"\"\nset_health_host() {\n    HEALTH_HOST=\"$LISTEN\"\n    if [ \"$HEALTH_HOST\" = \"0.0.0.0\" ]; then HEALTH_HOST=127.0.0.1; fi\n}\nset_health_host\n\n# ---- helpers -------------------------------------------------------------------\nconfirm() {                         # $1 = question; yes only with --yes or a typed y\n    local ans=\"\"\n    if [ \"$ASSUME_YES\" = 1 ]; then return 0; fi\n    if [ ! -t 0 ]; then return 1; fi\n    printf '%s [y/N] ' \"$1\"\n    read -r ans || return 1\n    case \"$ans\" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac\n}\nnode_major() {\n    \"$1\" -p 'process.versions.node.split(\".\")[0]' 2\u003e/dev/null || printf '0'\n}\nfind_node() {\n    local c\n    NODE_BIN=\"$(command -v node 2\u003e/dev/null || true)\"\n    if [ -z \"$NODE_BIN\" ]; then\n        for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do\n            if [ -x \"$c\" ]; then NODE_BIN=\"$c\"; break; fi\n        done\n    fi\n    return 0\n}\nnode_ok() {\n    local major\n    [ -n \"$NODE_BIN\" ] || return 1\n    major=\"$(node_major \"$NODE_BIN\")\"\n    [[ \"$major\" =~ ^[0-9]+$ ]] || return 1\n    [ \"$major\" -ge \"$NODE_MIN\" ]\n}\nnode_help() {\n    say \"Install Node.js $NODE_MIN or newer (the LTS version), then run this installer again:\"\n    if [ \"$OS\" = macos ]; then\n        say \"  - Homebrew:   brew install node\"\n        say \"  - or the macOS installer from https://nodejs.org\"\n    else\n        say \"  - your distribution's nodejs package if it is version $NODE_MIN or newer\"\n        say \"    (Debian/Ubuntu: sudo apt-get install nodejs;  Fedora: sudo dnf install nodejs)\"\n        say \"  - or the Linux binaries / package instructions on https://nodejs.org\"\n    fi\n}\nensure_node() {\n    local have\n    find_node\n    if node_ok; then return 0; fi\n    if [ -n \"$NODE_BIN\" ]; then have=\"version $(node_major \"$NODE_BIN\") at $NODE_BIN\"; else have=\"not found\"; fi\n    say \"Node.js $NODE_MIN or newer is needed to run the bridge (Node.js: $have).\"\n    local sudo_cmd=() cmd=()\n    if [ \"$(id -u)\" != \"0\" ]; then sudo_cmd=(sudo); fi\n    if [ \"$OS\" = macos ]; then\n        if command -v brew \u003e/dev/null 2\u003e&1; then cmd=(brew install node); fi\n    elif command -v apt-get \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} apt-get install -y nodejs)\n    elif command -v dnf \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} dnf install -y nodejs)\n    elif command -v yum \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} yum install -y nodejs)\n    elif command -v pacman \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} pacman -S --needed --noconfirm nodejs)\n    elif command -v apk \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} apk add nodejs)\n    fi\n    if [ ${#cmd[@]} -eq 0 ]; then node_help; exit 1; fi\n    if ! confirm \"Install Node.js now with:  ${cmd[*]}  ?\"; then node_help; exit 1; fi\n    \"${cmd[@]}\" || { warn \"the package manager reported an error\"; node_help; exit 1; }\n    hash -r 2\u003e/dev/null || true\n    find_node\n    if ! node_ok; then\n        say \"The installed Node.js is still older than $NODE_MIN (or not on PATH).\"\n        node_help\n        exit 1\n    fi\n    return 0\n}\nsha256_of() {\n    \"$NODE_BIN\" -e 'process.stdout.write(require(\"crypto\").createHash(\"sha256\").update(require(\"fs\").readFileSync(process.argv[1])).digest(\"hex\"))' \"$1\"\n}\ndecode_b64_to() {                   # stdin: base64 text; $1: destination file\n    \"$NODE_BIN\" -e 'const fs=require(\"fs\");let s=\"\";process.stdin.setEncoding(\"utf8\");process.stdin.on(\"data\",(d)=\u003e{s+=d;});process.stdin.on(\"end\",()=\u003e{fs.writeFileSync(process.argv[1],Buffer.from(s.replace(/[^A-Za-z0-9+\\/=]/g,\"\"),\"base64\"));});' \"$1\"\n}\nfetch_health() {                    # prints the /health JSON; fails when nothing answers\n    local url=\"http://$HEALTH_HOST:$PORT/health\"\n    if command -v curl \u003e/dev/null 2\u003e&1; then\n        curl -fsS --max-time 2 --noproxy '*' \"$url\" 2\u003e/dev/null\n    elif [ -n \"$NODE_BIN\" ]; then\n        \"$NODE_BIN\" -e 'const r=require(\"http\").get(process.argv[1],{timeout:2000},(res)=\u003e{let s=\"\";res.on(\"data\",(d)=\u003e{s+=d;});res.on(\"end\",()=\u003e{if(res.statusCode!==200)process.exit(1);process.stdout.write(s);});});r.on(\"timeout\",()=\u003e{r.destroy();process.exit(1);});r.on(\"error\",()=\u003eprocess.exit(1));' \"$url\"\n    else\n        return 1\n    fi\n}\nport_in_use() {                     # anything (a bridge or another program) listening on the port?\n    \"$NODE_BIN\" -e 'const s=require(\"net\").connect({host:process.argv[1],port:+process.argv[2]});s.setTimeout(1500);s.on(\"connect\",()=\u003e{s.destroy();process.exit(0);});s.on(\"timeout\",()=\u003e{s.destroy();process.exit(1);});s.on(\"error\",()=\u003eprocess.exit(1));' \"$HEALTH_HOST\" \"$PORT\"\n}\ndescribe_health() {                 # stdin: /health JSON\n    \"$NODE_BIN\" -e 'let s=\"\";process.stdin.on(\"data\",(d)=\u003e{s+=d;});process.stdin.on(\"end\",()=\u003e{try{const h=JSON.parse(s);process.stdout.write(\"v\"+h.version+\", \"+(h.readOnly?\"read-only\":\"writes ALLOWED\")+\", port \"+h.port+\"; allowed targets: \"+((h.allow||[]).join(\", \")||\"(none)\"));}catch(e){process.stdout.write(\"(unexpected reply)\");}});'\n}\nverify_health() {                   # is the bridge that answered the one just configured?\n    printf '%s' \"$HEALTH_JSON\" | \"$NODE_BIN\" -e '\nconst a=process.argv.slice(1);const {parseAllow}=require(a[0]);const port=+a[1],readOnly=a[2]!==\"1\";\nconst spec=(x)=\u003e{try{return parseAllow(x).spec;}catch(e){return String(x).toLowerCase();}};\nconst want=a.slice(3).map(spec).sort();let s=\"\";\nprocess.stdin.on(\"data\",(d)=\u003e{s+=d;});\nprocess.stdin.on(\"end\",()=\u003e{let h;try{h=JSON.parse(s);}catch(e){process.exit(1);}\nconst got=(Array.isArray(h.allow)?h.allow:[]).map((x)=\u003eString(x).toLowerCase()).sort();\nprocess.exit(h.port===port&&h.readOnly===readOnly&&JSON.stringify(got)===JSON.stringify(want)?0:1);});' \\\n        \"$INSTALL_DIR/modbus-bridge.js\" \"$PORT\" \"$ALLOW_WRITES\" ${ALLOW_LIST[@]+\"${ALLOW_LIST[@]}\"}\n}\nwait_health() {                     # $1 = seconds; $2 = pid to watch (optional)\n    local tries=$(( $1 * 4 )) json\n    while [ \"$tries\" -gt 0 ]; do\n        if json=\"$(fetch_health)\"; then\n            HEALTH_JSON=\"$json\"\n            return 0\n        fi\n        if [ -n \"${2:-}\" ] && ! kill -0 \"$2\" 2\u003e/dev/null; then return 1; fi\n        sleep 0.25\n        tries=$(( tries - 1 ))\n    done\n    return 1\n}\nxml_escape() {\n    printf '%s' \"$1\" | sed -e 's/&/\\&amp;/g' -e 's/\u003c/\\&lt;/g' -e 's/\u003e/\\&gt;/g'\n}\nsystemd_quote() {                   # one ExecStart= argument in double quotes, with \\ \" $ % escaped\n    local s\n    # shellcheck disable=SC2016\n    s=\"$(printf '%s' \"$1\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g' -e 's/\\$/$$/g' -e 's/%/%%/g')\"\n    printf '\"%s\"' \"$s\"\n}\nsystemd_user_ok() {\n    command -v systemctl \u003e/dev/null 2\u003e&1 && systemctl --user show-environment \u003e/dev/null 2\u003e&1\n}\nautostart_installed() {\n    if [ \"$OS\" = macos ]; then [ -f \"$PLIST\" ]; else [ -f \"$UNIT_FILE\" ]; fi\n}\nconfigured_port() {                 # port from an existing bridge-config.json (for --uninstall)\n    local f=\"$INSTALL_DIR/bridge-config.json\" p=\"\"\n    if [ -f \"$f\" ]; then\n        p=\"$(sed -n 's/.*\"port\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' \"$f\" | head -n 1)\"\n    fi\n    if valid_port \"${p:-x}\"; then printf '%s' \"$((10#$p))\"; else printf '%s' \"$PORT\"; fi\n}\nour_bridge_pids() {                 # this user's bridges running from the install folder\n    local js=\"$INSTALL_DIR/modbus-bridge.js\" me uid pid args\n    me=\"$(id -u)\"\n    { ps -A -ww -o uid= -o pid= -o args= 2\u003e/dev/null || true; } | while read -r uid pid args; do\n        if [ \"$uid\" = \"$me\" ] && [ \"$pid\" != \"$$\" ]; then\n            case \"$args\" in *\"$js\"*) printf '%s\\n' \"$pid\" ;; esac\n        fi\n    done\n    return 0\n}\nstop_our_bridges() {                # an earlier foreground install, start-bridge.sh or the auto-start service\n    local pids pid n=0 i\n    if autostart_installed; then\n        if [ \"$OS\" = macos ]; then\n            launchctl bootout \"gui/$(id -u)/$LABEL\" \u003e/dev/null 2\u003e&1 || true\n        elif systemd_user_ok; then\n            systemctl --user stop \"$UNIT_NAME\" \u003e/dev/null 2\u003e&1 || true\n        fi\n    fi\n    pids=\"$(our_bridge_pids)\"\n    for pid in $pids; do\n        if kill \"$pid\" 2\u003e/dev/null; then n=$((n + 1)); fi\n    done\n    if [ \"$n\" -gt 0 ]; then\n        for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do\n            if [ -z \"$(our_bridge_pids)\" ]; then break; fi\n            sleep 0.25\n        done\n        say \"Stopped $n bridge process(es) started from $INSTALL_DIR\"\n    fi\n    return 0\n}\n\n# ---- uninstall -----------------------------------------------------------------\nstop_autostart() {\n    if [ \"$OS\" = macos ]; then\n        if [ -f \"$PLIST\" ]; then\n            launchctl bootout \"gui/$(id -u)/$LABEL\" \u003e/dev/null 2\u003e&1 || launchctl unload \"$PLIST\" \u003e/dev/null 2\u003e&1 || true\n        fi\n    elif [ -f \"$UNIT_FILE\" ] && systemd_user_ok; then\n        systemctl --user disable --now \"$UNIT_NAME\" \u003e/dev/null 2\u003e&1 || true\n    fi\n    return 0\n}\ndo_uninstall() {\n    local f removed=0 pid\n    PORT=\"$(configured_port)\"\n    stop_autostart\n    for pid in $(our_bridge_pids); do kill \"$pid\" 2\u003e/dev/null || true; done\n    if [ \"$OS\" = macos ] && [ -f \"$PLIST\" ]; then rm -f \"$PLIST\"; say \"Removed the LaunchAgent $PLIST\"; fi\n    if [ \"$OS\" = linux ] && [ -f \"$UNIT_FILE\" ]; then\n        rm -f \"$UNIT_FILE\"; say \"Removed the systemd --user service $UNIT_FILE\"\n        if systemd_user_ok; then systemctl --user daemon-reload \u003e/dev/null 2\u003e&1 || true; fi\n    fi\n    if [ -d \"$INSTALL_DIR\" ]; then\n        for f in \"${INSTALLED_FILES[@]}\"; do\n            if [ -e \"$INSTALL_DIR/$f\" ]; then rm -f \"$INSTALL_DIR/$f\"; removed=$((removed + 1)); fi\n        done\n        if rmdir \"$INSTALL_DIR\" 2\u003e/dev/null; then say \"Removed $INSTALL_DIR ($removed files)\"\n        else warn \"$INSTALL_DIR still contains other files - left in place\"; fi\n    else\n        say \"Nothing installed in $INSTALL_DIR\"\n    fi\n    find_node\n    sleep 0.5\n    if fetch_health \u003e/dev/null 2\u003e&1; then\n        warn \"a bridge still answers on port $PORT (started by hand?) - close its terminal window or press Ctrl+C there.\"\n    fi\n    say \"The WTS Modbus bridge is uninstalled.\"\n}\n\nif [ \"$UNINSTALL\" = 1 ]; then do_uninstall; exit 0; fi\n\n# ---- install -------------------------------------------------------------------\nensure_node\n\n# The existing bridge-config.json supplies the defaults, so running the installer again (for\n# one more device, or --allow-writes) never drops the other targets or changes the port.\nOLD_ALLOW=(); OLD_PORT=\"\"; OLD_LISTEN=\"\"; OLD_WRITES=\"\"; HAVE_OLD=0\nread_existing_config() {\n    local f=\"$INSTALL_DIR/bridge-config.json\" out key val re='^[][A-Za-z0-9._:/*-]+$'\n    [ -f \"$f\" ] || return 0\n    if ! out=\"$(\"$NODE_BIN\" -e '\nconst fs=require(\"fs\");let c;\ntry{c=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\").replace(/^\\uFEFF/,\"\"));}catch(e){process.exit(3);}\nif(!c||typeof c!==\"object\"||Array.isArray(c))process.exit(3);\nconst safe=(s)=\u003etypeof s===\"string\"&&/^[\\x21-\\x7e]{1,300}$/.test(s.trim());\n(Array.isArray(c.allow)?c.allow:[]).forEach((x)=\u003econsole.log(safe(x)?\"allow \"+x.trim():\"bad \"+JSON.stringify(x).slice(0,60).replace(/[^\\x20-\\x7e]/g,\"?\")));\nif(Number.isInteger(c.port))console.log(\"port \"+c.port);\nif(safe(c.listen))console.log(\"listen \"+c.listen.trim());\nif(typeof c.allowWrites===\"boolean\")console.log(\"writes \"+(c.allowWrites?1:0));' \"$f\")\"; then\n        warn \"$f could not be read (not valid JSON?) - writing a new one (the old file is kept as bridge-config.json.bak).\"\n        return 0\n    fi\n    HAVE_OLD=1\n    while IFS=' ' read -r key val; do\n        case \"$key\" in\n            allow)\n                if valid_target \"$val\"; then val=\"$(norm_target \"$val\")\"\n                elif ! [[ \"$val\" =~ $re ]]; then warn \"left out '$val' from the existing allow list (not a host:port target)\"; continue; fi\n                in_list \"$val\" ${OLD_ALLOW[@]+\"${OLD_ALLOW[@]}\"} || OLD_ALLOW+=(\"$val\") ;;\n            bad)    warn \"left out $val from the existing allow list (not a host:port target)\" ;;\n            port)   if valid_port \"$val\"; then OLD_PORT=$((10#$val)); fi ;;\n            listen) if valid_listen \"$val\"; then OLD_LISTEN=\"$(norm_listen \"$val\")\"; else warn \"the existing listen address '$val' is not an IPv4 address or localhost - not kept\"; fi ;;\n            writes) OLD_WRITES=\"$val\" ;;\n        esac\n    done \u003c\u003c\u003c \"$out\"\n    return 0\n}\nif [ \"$RESET\" != 1 ]; then read_existing_config; fi\nALLOW_LIST=()\nfor e in ${OLD_ALLOW[@]+\"${OLD_ALLOW[@]}\"} ${NEW_ALLOW[@]+\"${NEW_ALLOW[@]}\"}; do\n    in_list \"$e\" ${ALLOW_LIST[@]+\"${ALLOW_LIST[@]}\"} || ALLOW_LIST+=(\"$e\")\ndone\nPORT=\"${CLI_PORT:-${PRESET_PORT:-${OLD_PORT:-$DEFAULT_PORT}}}\"\nLISTEN=\"${CLI_LISTEN:-${PRESET_LISTEN:-${OLD_LISTEN:-127.0.0.1}}}\"\nALLOW_WRITES=\"${CLI_WRITES:-${PRESET_ALLOW_WRITES:-${OLD_WRITES:-0}}}\"\nset_health_host\nif [ \"$HAVE_OLD\" = 1 ]; then\n    say \"Keeping the settings of the existing $INSTALL_DIR/bridge-config.json (${#OLD_ALLOW[@]} target(s); new targets are added - --reset starts a new list).\"\nfi\nif [ ${#ALLOW_LIST[@]} -eq 0 ]; then\n    ALLOW_LIST=('*:*')\n    say \"No --allow targets given: the bridge will allow any device IP / port (default). Give --allow \u003cip\u003e:\u003cport\u003e (with --reset) to restrict it.\"\nfi\n\ninstall_files() {\n    local f want got names=()\n    mkdir -p \"$INSTALL_DIR\"\n    if [ -n \"$EMBEDDED_FILES\" ]; then\n        read -r -a names \u003c\u003c\u003c \"$EMBEDDED_FILES\"\n        for f in ${names[@]+\"${names[@]}\"}; do\n            embedded_b64 \"$f\" | decode_b64_to \"$INSTALL_DIR/$f\"\n            want=\"$(embedded_sha256 \"$f\")\"\n            got=\"$(sha256_of \"$INSTALL_DIR/$f\")\"\n            [ \"$want\" = \"$got\" ] || die \"$f: SHA-256 mismatch after unpacking (installer damaged?) - download it again from the app\"\n        done\n        say \"Unpacked bridge v$EMBEDDED_VERSION (SHA-256 verified)\"\n    else\n        [ -f \"$SCRIPT_DIR/modbus-bridge.js\" ] || die \"modbus-bridge.js was not found next to this installer ($SCRIPT_DIR). Download the bridge package from the app's Modbus page, unzip it and run install.sh from that folder.\"\n        for f in modbus-bridge.js fake-slave.js README.md; do\n            if [ -f \"$SCRIPT_DIR/$f\" ] && ! [ \"$SCRIPT_DIR/$f\" -ef \"$INSTALL_DIR/$f\" ]; then\n                cp \"$SCRIPT_DIR/$f\" \"$INSTALL_DIR/$f\"\n            fi\n        done\n    fi\n    if [ -f \"${BASH_SOURCE[0]}\" ] && ! [ \"${BASH_SOURCE[0]}\" -ef \"$INSTALL_DIR/install.sh\" ]; then\n        cp \"${BASH_SOURCE[0]}\" \"$INSTALL_DIR/install.sh\"\n    fi\n    chmod 644 \"$INSTALL_DIR/modbus-bridge.js\"\n    if [ -f \"$INSTALL_DIR/install.sh\" ]; then chmod 755 \"$INSTALL_DIR/install.sh\"; fi\n    return 0\n}\nwrite_config() {                    # JSON written by node; origins / anyOrigin / verbose of the old file kept\n    local f=\"$INSTALL_DIR/bridge-config.json\" tmp=\"$INSTALL_DIR/bridge-config.json.tmp\"\n    \"$NODE_BIN\" -e '\nconst fs=require(\"fs\");const a=process.argv.slice(1);\nconst f=a[0],tmp=a[1],reset=a[2]===\"1\",port=+a[3],listen=a[4],writes=a[5]===\"1\",n=+a[6];\nconst allow=a.slice(7,7+n),newOrigins=a.slice(7+n);let old={};\nif(!reset){try{const o=JSON.parse(fs.readFileSync(f,\"utf8\").replace(/^\\uFEFF/,\"\"));if(o&&typeof o===\"object\"&&!Array.isArray(o))old=o;}catch(e){}}\nconst seen=new Set(),origins=[];\n(Array.isArray(old.origins)?old.origins:[]).concat(newOrigins).forEach((o)=\u003e{if(typeof o!==\"string\"||!o.trim())return;const k=o.trim().toLowerCase();if(!seen.has(k)){seen.add(k);origins.push(o.trim());}});\nconst out={_comment:\"WTS Modbus bridge settings. allow = the host:port targets the bridge may connect to. Running the installer again keeps these settings and adds new targets (--reset starts over). Restart the bridge after editing.\",\n  allow:allow,port:port,listen:listen,origins:origins,anyOrigin:old.anyOrigin===true,allowWrites:writes,verbose:old.verbose===true};\nfs.writeFileSync(tmp,JSON.stringify(out,null,2)+\"\\n\");' \\\n        \"$f\" \"$tmp\" \"$RESET\" \"$PORT\" \"$LISTEN\" \"$ALLOW_WRITES\" \"${#ALLOW_LIST[@]}\" \\\n        ${ALLOW_LIST[@]+\"${ALLOW_LIST[@]}\"} ${NEW_ORIGINS[@]+\"${NEW_ORIGINS[@]}\"}\n    if [ -f \"$f\" ] && ! cmp -s \"$f\" \"$tmp\"; then cp \"$f\" \"$f.bak\"; fi\n    mv \"$tmp\" \"$f\"\n    return 0\n}\nwrite_start_script() {\n    local f=\"$INSTALL_DIR/start-bridge.sh\" q_node q_js q_cfg\n    q_node=\"$(printf '%q' \"$NODE_BIN\")\"\n    q_js=\"$(printf '%q' \"$INSTALL_DIR/modbus-bridge.js\")\"\n    q_cfg=\"$(printf '%q' \"$INSTALL_DIR/bridge-config.json\")\"\n    {\n        printf '#!/usr/bin/env bash\\n'\n        printf '# Starts the WTS Modbus bridge with bridge-config.json (written by install.sh).\\n'\n        printf '# Extra options are passed on, e.g.  start-bridge.sh --verbose\\n'\n        # shellcheck disable=SC2016\n        printf 'exec %s %s --config %s \"$@\"\\n' \"$q_node\" \"$q_js\" \"$q_cfg\"\n    } \u003e \"$f\"\n    chmod 755 \"$f\"\n    return 0\n}\nlaunchagent_load() {                # (re)load the LaunchAgent - it starts the bridge now (RunAtLoad)\n    local uid i\n    uid=\"$(id -u)\"\n    launchctl bootout \"gui/$uid/$LABEL\" \u003e/dev/null 2\u003e&1 || true\n    for i in 1 2 3 4 5; do\n        if launchctl bootstrap \"gui/$uid\" \"$PLIST\" \u003e/dev/null 2\u003e&1; then break; fi\n        if [ \"$i\" = 5 ]; then\n            launchctl unload \"$PLIST\" \u003e/dev/null 2\u003e&1 || true\n            launchctl load -w \"$PLIST\" \u003e/dev/null 2\u003e&1 || return 1\n        fi\n        sleep 1\n    done\n    launchctl kickstart -k \"gui/$uid/$LABEL\" \u003e/dev/null 2\u003e&1 || true\n    return 0\n}\nsetup_launchagent() {               # $1 = 1: start it now as well\n    mkdir -p \"$(dirname \"$PLIST\")\"\n    cat \u003e \"$PLIST\" \u003c\u003cEOF\n\u003c?xml version=\"1.0\" encoding=\"UTF-8\"?\u003e\n\u003c!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"\u003e\n\u003cplist version=\"1.0\"\u003e\n\u003cdict\u003e\n  \u003ckey\u003eLabel\u003c/key\u003e\u003cstring\u003e$LABEL\u003c/string\u003e\n  \u003ckey\u003eProgramArguments\u003c/key\u003e\n  \u003carray\u003e\n    \u003cstring\u003e$(xml_escape \"$NODE_BIN\")\u003c/string\u003e\n    \u003cstring\u003e$(xml_escape \"$INSTALL_DIR/modbus-bridge.js\")\u003c/string\u003e\n    \u003cstring\u003e--config\u003c/string\u003e\n    \u003cstring\u003e$(xml_escape \"$INSTALL_DIR/bridge-config.json\")\u003c/string\u003e\n  \u003c/array\u003e\n  \u003ckey\u003eWorkingDirectory\u003c/key\u003e\u003cstring\u003e$(xml_escape \"$INSTALL_DIR\")\u003c/string\u003e\n  \u003ckey\u003eRunAtLoad\u003c/key\u003e\u003ctrue/\u003e\n  \u003ckey\u003eKeepAlive\u003c/key\u003e\u003cdict\u003e\u003ckey\u003eSuccessfulExit\u003c/key\u003e\u003cfalse/\u003e\u003c/dict\u003e\n  \u003ckey\u003eThrottleInterval\u003c/key\u003e\u003cinteger\u003e10\u003c/integer\u003e\n  \u003ckey\u003eProcessType\u003c/key\u003e\u003cstring\u003eBackground\u003c/string\u003e\n  \u003ckey\u003eStandardOutPath\u003c/key\u003e\u003cstring\u003e$(xml_escape \"$INSTALL_DIR/bridge.log\")\u003c/string\u003e\n  \u003ckey\u003eStandardErrorPath\u003c/key\u003e\u003cstring\u003e$(xml_escape \"$INSTALL_DIR/bridge.log\")\u003c/string\u003e\n\u003c/dict\u003e\n\u003c/plist\u003e\nEOF\n    if [ \"${1:-1}\" = 1 ]; then\n        launchagent_load || die \"launchctl could not load $PLIST\"\n        say \"LaunchAgent installed: $PLIST (starts at login; log: $INSTALL_DIR/bridge.log)\"\n    else\n        say \"LaunchAgent installed: $PLIST - the bridge starts at the next login (log: $INSTALL_DIR/bridge.log)\"\n    fi\n    return 0\n}\nsetup_systemd() {                   # $1 = 1: start it now as well\n    mkdir -p \"$(dirname \"$UNIT_FILE\")\"\n    cat \u003e \"$UNIT_FILE\" \u003c\u003cEOF\n[Unit]\nDescription=WTS Modbus Bridge (WebSocket to Modbus TCP)\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=$(systemd_quote \"$NODE_BIN\") $(systemd_quote \"$INSTALL_DIR/modbus-bridge.js\") --config $(systemd_quote \"$INSTALL_DIR/bridge-config.json\")\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\nEOF\n    systemctl --user daemon-reload\n    systemctl --user enable \"$UNIT_NAME\" \u003e/dev/null 2\u003e&1 || die \"systemctl --user enable $UNIT_NAME failed\"\n    if [ \"${1:-1}\" = 1 ]; then\n        systemctl --user restart \"$UNIT_NAME\" || die \"systemctl --user restart $UNIT_NAME failed (see: journalctl --user -u $UNIT_NAME)\"\n        say \"systemd --user service installed: $UNIT_FILE (starts at login)\"\n    else\n        say \"systemd --user service installed and enabled: $UNIT_FILE - the bridge starts at the next login\"\n        say \"  (or now with: systemctl --user start $UNIT_NAME)\"\n    fi\n    say \"  status: systemctl --user status $UNIT_NAME    log: journalctl --user -u $UNIT_NAME\"\n    say \"  to keep it running while you are logged out: loginctl enable-linger \\\"\\$USER\\\"\"\n    return 0\n}\nrestart_existing_autostart() {      # succeeds when the auto-start bridge was restarted\n    if [ \"$OS\" = macos ]; then\n        launchagent_load\n    else\n        systemd_user_ok && systemctl --user restart \"$UNIT_NAME\"\n    fi\n}\nnext_steps() {\n    say \"\"\n    say \"Next steps in the Well Testing Suite (Modbus Config page):\"\n    say \"  1. For each device choose transport \\\"Modbus TCP via WebSocket bridge\\\", enter the\"\n    say \"     PLC's IP address and port, and the bridge URL ws://$HEALTH_HOST:$PORT\"\n    say \"  2. Press \\\"Check bridge\\\" in the setup guide, then \\\"Test\\\" on the device row.\"\n    say \"\"\n    say \"Installed in:  $INSTALL_DIR\"\n    say \"Settings:      $INSTALL_DIR/bridge-config.json (restart the bridge after editing)\"\n    say \"Add a device:  bash \\\"$INSTALL_DIR/install.sh\\\" --allow \u003cip\u003e:\u003cport\u003e   (keeps the other settings)\"\n    say \"Start by hand: \\\"$INSTALL_DIR/start-bridge.sh\\\"\"\n    say \"Uninstall:     bash \\\"$INSTALL_DIR/install.sh\\\" --uninstall\"\n}\nreport_running() {\n    say \"\"\n    say \"OK: the WTS Modbus bridge is running - $(printf '%s' \"$HEALTH_JSON\" | describe_health)\"\n    say \"    health check: http://$HEALTH_HOST:$PORT/health\"\n}\ncheck_running() {                   # after wait_health: the answer must come from the bridge just configured\n    if ! verify_health; then\n        if [ -n \"${BRIDGE_PID:-}\" ]; then kill \"$BRIDGE_PID\" 2\u003e/dev/null || true; fi\n        die \"the bridge answering on port $PORT is not the one just installed ($(printf '%s' \"$HEALTH_JSON\" | describe_health)). Another bridge may be running: stop it and run the installer again.\"\n    fi\n    report_running\n}\n\nHEALTH_JSON=\"\"\n# Before anything is written: stop the bridges of an earlier install, then the port must be free\n# (otherwise the new bridge could not start, and the settings on disk would not match the bridge\n# that answers).\nif [ \"$NO_START\" != 1 ]; then\n    stop_our_bridges\n    if port_in_use; then\n        if HEALTH_JSON=\"$(fetch_health)\"; then\n            die \"another WTS Modbus bridge already answers on http://$HEALTH_HOST:$PORT ($(printf '%s' \"$HEALTH_JSON\" | describe_health)) - it was not started by this install (a bridge started by hand?). Stop it first (Ctrl+C in its window), or install with --port \u003cother\u003e. Nothing was changed.\"\n        fi\n        die \"another program already uses port $PORT on $HEALTH_HOST. Stop it, or install with --port \u003cother\u003e (and use that port in the device bridge URL). Nothing was changed.\"\n    fi\nfi\ninstall_files\nwrite_config\nwrite_start_script\nMODE=\"read-only\"\nif [ \"$ALLOW_WRITES\" = 1 ]; then MODE=\"writes ALLOWED\"; fi\nsay \"Installed the WTS Modbus bridge in $INSTALL_DIR\"\nsay \"  allowed targets: ${ALLOW_LIST[*]:-(none)}   port: $PORT   $MODE\"\n\nif [ \"$AUTOSTART\" = 1 ]; then\n    START_NOW=1\n    if [ \"$NO_START\" = 1 ]; then START_NOW=0; fi\n    if [ \"$OS\" = macos ]; then\n        setup_launchagent \"$START_NOW\"\n    elif systemd_user_ok; then\n        setup_systemd \"$START_NOW\"\n    else\n        warn \"systemd --user is not available here (no user session bus - e.g. WSL, a container or an SSH-only login), so auto-start was not set up.\"\n        say \"  Start the bridge yourself with \\\"$INSTALL_DIR/start-bridge.sh\\\", or add that command to your\"\n        say \"  desktop's Startup Applications (or 'crontab -e' with: @reboot \\\"$INSTALL_DIR/start-bridge.sh\\\").\"\n        if [ \"$NO_START\" != 1 ]; then say \"  Starting it in this window now.\"; fi\n        AUTOSTART=0\n    fi\nelif [ \"$NO_START\" != 1 ] && autostart_installed; then\n    if restart_existing_autostart; then\n        say \"Restarted the auto-start bridge from an earlier install with the new settings.\"\n        AUTOSTART=1\n    else\n        warn \"could not restart the auto-start bridge from an earlier install - starting one in this window.\"\n    fi\nfi\n\nif [ \"$NO_START\" = 1 ]; then next_steps; exit 0; fi\n\nif [ \"$AUTOSTART\" = 1 ]; then\n    if wait_health 15; then check_running\n    else warn \"the bridge did not answer on http://$HEALTH_HOST:$PORT/health within 15 s - check the log (see above).\"; fi\n    next_steps\n    exit 0\nfi\n\n# Foreground: run the bridge from this terminal, check it, then wait until Ctrl+C.\n\"$INSTALL_DIR/start-bridge.sh\" &\nBRIDGE_PID=$!\nstop_bridge() {\n    trap - INT TERM HUP\n    kill \"$BRIDGE_PID\" 2\u003e/dev/null || true\n    wait \"$BRIDGE_PID\" 2\u003e/dev/null || true\n    say \"\"\n    say \"Bridge stopped.\"\n    exit 0\n}\ntrap stop_bridge INT TERM HUP\nif wait_health 15 \"$BRIDGE_PID\"; then\n    check_running\n    next_steps\n    say \"\"\n    say \"The bridge runs in this window - leave it open while you use the app; Ctrl+C stops it.\"\n    say \"(Install with --autostart to start it automatically at login instead.)\"\nelse\n    if kill -0 \"$BRIDGE_PID\" 2\u003e/dev/null; then\n        warn \"the bridge did not answer on http://$HEALTH_HOST:$PORT/health within 15 s.\"\n    else\n        wait \"$BRIDGE_PID\" 2\u003e/dev/null || true\n        die \"the bridge stopped (see the message above).\"\n    fi\nfi\nset +e\nwait \"$BRIDGE_PID\"\ncode=$?\nset -e\ntrap - INT TERM HUP\nsay \"\"\nsay \"The bridge stopped (exit code $code) - it was stopped from outside this window, or a new install replaced it.\"\nexit \"$code\"\n",
        "README.md": "# Modbus bridge (WebSocket ↔ Modbus TCP)\n\nWeb browsers cannot open raw TCP sockets, so the web build of the Well Testing Suite reaches\nModbus TCP equipment (PLCs, RTUs, flow computers, serial-to-Ethernet gateways) through this small\nbridge. It runs on a PC on the same network as the equipment. The iOS app does not need it (it has\na native TCP plugin), and Modbus RTU over RS-485 uses Web Serial directly in Chrome / Edge.\n\n```\nModbus page / Mini WellOS ──ws://127.0.0.1:8502──► modbus-bridge.js ──TCP 502──► PLC / RTU / gateway\n```\n\n- Zero dependencies, one file: `modbus-bridge.js` (Node.js 18 or newer).\n- Listens on **127.0.0.1 only** by default.\n- Connects **only** to the host:port pairs you allow.\n- **Read-only by default:** Modbus write requests (function codes 05, 06, 15, 16) are answered\n  by the bridge with exception 01 (Illegal function) and never reach the device, unless you start\n  it with `--allow-writes`. Writes also have to be enabled on the Modbus page and confirmed there.\n- Accepts browser connections only from `http(s)://localhost`, `http(s)://127.0.0.1`,\n  `https://pb-handbook.com` and the iOS app origin, unless you add `--origin https://your-host`\n  (or `--any-origin`). Browsers allow an https page to open `ws://127.0.0.1`, so the bridge URL\n  stays `ws://127.0.0.1:8502` even when the app is served over https.\n- **Saved copies of the app** (opened from a `file://` path) send `Origin: null`. The bridge\n  refuses that by default, because any web site can send `null` too (from a sandboxed frame).\n  Prefer opening the app from `https://pb-handbook.com` or `http://localhost`; if you must use a\n  saved copy, allow it explicitly with `--origin null` (installer: `--origin null` / `-Origin null`,\n  or `\"origins\": [\"null\"]` in `bridge-config.json`) — only on a PC that is not used for general\n  web browsing.\n\nThe app's **Modbus Config** page has the same steps as a guide (Connecting to real equipment →\nbridge setup): it downloads this folder as a zip (bundled in the app, works offline), generates an\ninstaller pre-filled with your configured bridge devices, and checks the running bridge.\n\n## Quick install (recommended)\n\nThe installers need **no administrator rights** for the bridge. They check for Node.js 18+ and, if\nit is missing, offer to install it with the system package manager — only after you confirm.\nNothing else is downloaded. Every `host:port` is validated (IPv4, IPv4 subnet `a.b.c.d/nn`, a\nhost name of letters, digits, dots, hyphens and underscores, or an IPv6 address in brackets such as\n`[fd00::10]:502`; port 1-65535 or `*`).\n\n### Windows (PowerShell 5.1 or 7)\n\nIn the unzipped folder, open PowerShell (Start menu → type PowerShell, or right-click the folder\nwith Shift → \"Open PowerShell window here\") and run:\n\n```\npowershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Allow \"192.168.1.10:502,192.168.1.11:502\"\n```\n\n`-ExecutionPolicy Bypass` applies to this one run only (it changes no system setting and is what\nlets a downloaded script run). The installer:\n\n- copies the bridge to `%LOCALAPPDATA%\\WTS Modbus Bridge`, writes `bridge-config.json` and\n  `start-bridge.cmd` there, and adds a Start-menu shortcut **WTS Modbus Bridge**;\n- offers `winget install OpenJS.NodeJS.LTS` if Node.js is missing (Windows may ask for permission);\n- starts the bridge in its own window (leave it open), checks `http://127.0.0.1:8502/health` and\n  prints the next steps.\n\nOptions: `-Port 8502`, `-Listen 127.0.0.1`, `-AllowWrites` / `-ReadOnly`, `-Origin https://my.site`,\n`-AutoStart` (start at every logon: a user-level Scheduled Task, or a Startup-folder shortcut when\nTask Scheduler refuses), `-NoStart`, `-Reset`, `-Yes` (answer yes to the Node.js question),\n`-Uninstall`.\n\n### macOS and Linux\n\nIn the unzipped folder, in a Terminal:\n\n```\nbash install.sh --allow 192.168.1.10:502 --allow 192.168.1.11:502\n```\n\n(`--allow` can be repeated or take a comma list. Quote targets that contain `*` or `[ ]`, e.g.\n`--allow 'plc-2.local:*'` — zsh, the macOS default shell, stops with \"no matches found\" otherwise.)\nThe installer:\n\n- copies the bridge to `~/Library/Application Support/WTS Modbus Bridge` (macOS) or\n  `${XDG_DATA_HOME:-~/.local/share}/wts-modbus-bridge` (Linux), and writes `bridge-config.json`\n  and `start-bridge.sh` there;\n- offers `brew install node` (macOS) or the distribution's `nodejs` package (Linux, via sudo) if\n  Node.js is missing — check that it is version 18 or newer, otherwise use \u003chttps://nodejs.org\u003e;\n- starts the bridge **in that Terminal window** (leave it open; Ctrl+C stops it), checks\n  `/health` and prints the next steps.\n\nOptions: `--port 8502`, `--listen 127.0.0.1`, `--allow-writes` / `--read-only`,\n`--origin https://my.site`, `--autostart`, `--no-start`, `--reset`, `--yes`, `--uninstall`.\n\n`--autostart` starts the bridge now and at every login instead of in the Terminal (with\n`--no-start` it is only set up, and starts at the next login):\n\n- **macOS:** a LaunchAgent `~/Library/LaunchAgents/uk.co.h2oil.wts-modbus-bridge.plist`\n  (log: `bridge.log` in the install folder).\n- **Linux:** a systemd user service `wts-modbus-bridge.service`\n  (`systemctl --user status wts-modbus-bridge`, `journalctl --user -u wts-modbus-bridge`; to keep it\n  running while logged out: `loginctl enable-linger \"$USER\"`). Where `systemd --user` is not\n  available (WSL, containers, SSH-only sessions) the installer says so and runs the bridge in the\n  Terminal instead; add `start-bridge.sh` to your desktop's startup applications or to\n  `crontab -e` as `@reboot \"/path/to/start-bridge.sh\"`.\n\n### Running the installer again\n\nRunning an installer again (the package's, the one generated by the app, or the copy in the install\nfolder) updates the files and **keeps the existing `bridge-config.json`**: new `--allow` / `-Allow`\ntargets are **added** to its allow list, and its port, listen address, write setting and origins\nstay unless you give `--port`, `--listen`, `--allow-writes` / `--read-only` (`-Port`, `-Listen`,\n`-AllowWrites` / `-ReadOnly`) or `--origin`. So adding one more device is just:\n\n```\nbash \"$HOME/Library/Application Support/WTS Modbus Bridge/install.sh\" --allow 192.168.1.12:502   # macOS\nbash \"${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh\" --allow 192.168.1.12:502 # Linux\npowershell -NoProfile -ExecutionPolicy Bypass -File \"$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1\" -Allow \"192.168.1.12:502\"\n```\n\n`--reset` / `-Reset` starts from a new, empty configuration instead. The previous file is kept as\n`bridge-config.json.bak`. Before writing anything the installer stops the bridge it started earlier\n(a Terminal / window started by an earlier install, or the auto-start service) and checks that the\nport is free — if another bridge or program answers there, it stops with a message and changes\nnothing.\n\n### Installer generated by the app\n\n**Modbus Config → Connecting to real equipment → Generate installer for my devices** downloads a\nsingle script (`wts-modbus-bridge-install.ps1` or `wts-modbus-bridge-install.sh`) with the bridge\nfiles embedded (SHA-256 checked when unpacked), the `--allow` targets taken from your\n\"Modbus TCP via WebSocket bridge\" devices, the bridge port from their bridge URL and the read-only /\nwrites choice made on the page (when the app is served from a site the bridge does not accept by\ndefault, that origin is added too). Run it with:\n\n```\npowershell -NoProfile -ExecutionPolicy Bypass -File \"$HOME\\Downloads\\wts-modbus-bridge-install.ps1\"\nbash ~/Downloads/wts-modbus-bridge-install.sh\n```\n\nExtra options on the command line are added to the built-in ones, and the targets of an existing\n`bridge-config.json` are kept (see above).\n\n### Uninstall\n\n```\npowershell -NoProfile -ExecutionPolicy Bypass -File \"$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1\" -Uninstall\nbash \"$HOME/Library/Application Support/WTS Modbus Bridge/install.sh\" --uninstall       # macOS\nbash \"${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh\" --uninstall     # Linux\n```\n\nThis stops the bridge, removes the auto-start entry and shortcuts, and deletes the installed files\n(a folder that still contains other files is left in place).\n\n## Configuration file\n\nThe installers write `bridge-config.json`; the bridge reads it with `--config`:\n\n```json\n{\n  \"_comment\": \"keys starting with _ are ignored\",\n  \"allow\": [\"192.168.1.10:502\", \"10.0.0.0/24:502\", \"plc-2.local:*\", \"[fd00::10]:502\"],\n  \"port\": 8502,\n  \"listen\": \"127.0.0.1\",\n  \"origins\": [],\n  \"anyOrigin\": false,\n  \"allowWrites\": false,\n  \"verbose\": false\n}\n```\n\nAll keys are optional. Command-line flags override `port` / `listen` and add to the `allow` /\n`origins` lists; `--allow-writes`, `--any-origin` and `--verbose` switch those on. Restart the\nbridge after editing (Windows: close its window and use the Start-menu shortcut; macOS / Linux:\nCtrl+C and `start-bridge.sh`, or re-run the installer for an auto-start bridge).\n\n## Run it by hand\n\nIn the **unzipped package folder** (`wts-modbus-bridge`, from the app), on any system:\n```\nnode modbus-bridge.js --allow 192.168.1.10:502\n```\n\nFrom the **repository** folder:\n\n**Windows (PowerShell or cmd)**\n```\nnode tools\\modbus-bridge\\modbus-bridge.js --allow 192.168.1.10:502\n```\n\n**macOS / Linux**\n```\nnode tools/modbus-bridge/modbus-bridge.js --allow 192.168.1.10:502\n```\n\nIt prints `listening on ws://127.0.0.1:8502/modbus (read-only)`. Leave the window open while you use\nMini WellOS. Stop it with Ctrl+C.\n\nThen, on the **Modbus** page of the app, add a device with transport\n\"Modbus TCP via WebSocket bridge\", host `192.168.1.10`, port `502`, the unit id, and bridge URL\n`ws://127.0.0.1:8502`. Press **Check bridge** in the setup guide, then **Test** on the device row.\n\n### Options\n\n| Option | Meaning |\n|---|---|\n| `--allow host:port` | Allow a target. Repeat for several. `'host:*'` allows any port; `10.0.0.0/24:502` allows an IPv4 subnet; `'[fd00::10]:502'` an IPv6 address. Quote values with `*` or `[ ]` in sh / zsh. |\n| `--port 8502` | WebSocket port. |\n| `--listen 127.0.0.1` | Interface to listen on. Anything other than localhost lets other machines use the bridge — only do this on a trusted network. |\n| `--origin https://example.com` | Also accept pages served from this origin (repeat as needed). `--origin null` accepts a saved `file://` copy of the app — and any web site's sandboxed frames, so only on a PC not used for general browsing. |\n| `--any-origin` | Accept any page origin (not recommended). |\n| `--allow-writes` | Forward Modbus write requests (FC 05 / 06 / 15 / 16). |\n| `--config file.json` | Read settings from a configuration file (see above). |\n| `--verbose` | Log connections and blocked requests. |\n| `--version` | Print the bridge version. |\n\nExample with two PLCs and writes enabled (in the package folder):\n```\nnode modbus-bridge.js --allow 192.168.1.10:502 --allow 192.168.1.11:502 --allow-writes\n```\n\n## Health check\n\n`GET http://127.0.0.1:8502/health` returns\n\n```json\n{\"name\":\"wts-modbus-bridge\",\"version\":\"1.1.0\",\"readOnly\":true,\"port\":8502,\"uptimeS\":42,\"allow\":[\"192.168.1.10:502\"]}\n```\n\nThe app's **Check bridge** button uses it to show whether the bridge runs, its version, whether it\nis read-only and whether each configured device is in the allow-list. The health data (with CORS\nheaders) goes only to the page origins the bridge accepts (the same rules as the WebSocket\nconnection) and to requests without an `Origin` header (`curl http://127.0.0.1:8502/health` works\nfrom the same PC). A refused request gets `403 {\"error\":\"origin\"}` — or `{\"error\":\"host\"}` when the\n`Host` is not localhost, an IP address or the `--listen` name and the request has no accepted\n`Origin` (protection against DNS rebinding) — with `Access-Control-Allow-Origin` echoed, so\n**Check bridge** can say why instead of \"no bridge answered\". The refusal contains nothing else, and\na refused preflight is never approved for local-network access.\n\n**Chrome / Edge and local-network access:** when the app is served from a public https site,\nChromium browsers treat a request to `127.0.0.1` as a private-network request. The bridge answers\nthe CORS preflight with `Access-Control-Allow-Private-Network: true`, and newer versions may show a\nprompt asking to let the site access apps or devices on your local network — choose **Allow**.\nOther browsers may block an https page from reaching `http://127.0.0.1`; use Chrome / Edge, or open\nthe app from `http://localhost` (a saved `file://` copy needs `--origin null`, see above).\n\n## Test without hardware\n\n`fake-slave.js` is a tiny Modbus TCP slave (unit 1) for trying the bridge. In the unzipped package\nfolder, in two windows:\n```\nnode fake-slave.js --port 5020\nnode modbus-bridge.js --allow 127.0.0.1:5020\n```\n(from the repository: `node tools/modbus-bridge/fake-slave.js --port 5020` and\n`node tools/modbus-bridge/modbus-bridge.js --allow 127.0.0.1:5020`).\nHolding register *n* holds *n*, input register *n* holds 1000 + *n*, and input registers 100-101\nhold the FLOAT32 value 123.456 (ABCD). In the app, add a bridge device with host `127.0.0.1`,\nport `5020`, and a tag on input register 100, type FLOAT32.\n\nThe app also has a built-in virtual slave (\"Built-in simulator\" transport, or **Load simulator\ndemo** on the Modbus page) that needs neither the bridge nor Node.\n\n## Protocol (for developers)\n\n- The page opens one WebSocket per device: `ws://127.0.0.1:8502/modbus?host=\u003cip\u003e&port=\u003cport\u003e`.\n- When the TCP connection to the device is up, the bridge sends the text message\n  `{\"type\":\"open\"}`. Errors arrive as `{\"type\":\"error\",\"message\":\"…\"}` followed by a close\n  (1008 = target not allowed, 1011 = connection error).\n- Binary messages carry complete Modbus TCP ADUs (MBAP header + PDU) in both directions; the\n  bridge re-frames the device's TCP stream using the MBAP length field. ADUs are limited to\n  260 bytes; fragmented WebSocket messages are refused.\n- `GET /health` (and its CORS preflight) as described above; any other plain HTTP request gets a\n  short text banner.\n- References: RFC 6455 (WebSocket), MODBUS Messaging on TCP/IP Implementation Guide V1.0b,\n  MODBUS Application Protocol Specification V1.1b3.\n\n## Troubleshooting\n\n- *\"Cannot reach the Modbus bridge\"* — the bridge is not running, the URL / port differs, or the\n  bridge refused the page (a browser reports all three the same way). Press **Check bridge** on the\n  Modbus page: it says which.\n- *\"not in the bridge allow-list\"* — run the installer again with that device\n  (`--allow \u003chost\u003e:\u003cport\u003e` / `-Allow`): it is added to the targets already allowed. Or add it to\n  `allow` in `bridge-config.json` and restart the bridge.\n- *\"the bridge refused this page\" / origin not accepted* — the page is served from an origin the\n  bridge does not accept: run the installer again with `--origin \u003cthat origin\u003e` (`-Origin`), or add\n  it to `origins` in `bridge-config.json`. A saved `file://` copy sends `null` (see the top of\n  this file).\n- *\"refused the host name\"* — the device bridge URL uses a host name the bridge does not know: use\n  the bridge PC's IP address in the bridge URL.\n- *zsh: no matches found* — quote targets with `*` or `[ ]`: `--allow 'plc-2.local:*'`.\n- *Timeouts* — check the unit id (many gateways need the RS-485 slave address here), the IP /\n  port, and that no firewall blocks TCP 502 between the PC and the device.\n- *Exception 01 on writes* — the bridge is read-only; run the installer again with `--allow-writes` /\n  `-AllowWrites` (the targets and the port are kept).\n- *Chrome / Edge asks about local network access* — choose Allow (see \"Health check\" above).\n- *Windows: \"running scripts is disabled on this system\"* — use the\n  `powershell -NoProfile -ExecutionPolicy Bypass -File …` command exactly as shown.\n- *macOS / Linux: \"permission denied\"* — start the installer with `bash install.sh …`.\n- *Port 8502 already in use* — install with `--port` / `-Port` and change the device bridge URL to\n  match (the port is then kept when you run the installer again).\n- *Listening on `localhost`* — the installers and the bridge treat `localhost` as `127.0.0.1`\n  (on macOS / Windows `localhost` can resolve to `::1` only, which `ws://127.0.0.1` cannot reach).\n"
    }
};
})();

// ─── END 64-modbus-bridge-pack ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 65-modbus-bridge-setup ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 65-modbus-bridge-setup.js — WebSocket-bridge setup helpers for the Modbus page guide
// -----------------------------------------------------------------------------
// window.WTS_modbusBridgeSetup (pure functions + one fetch; no timers except the one-shot
// timeout of checkBridge, cleared when it settles):
//   validateTarget(s)        → {ok, value, error}  host:port, host = IPv4 | IPv4/nn | host name
//                              ([A-Za-z0-9._-]) | [IPv6], port 1-65535 or * — the same rules as
//                              the installers, so nothing reaches a script that a shell could run
//   validateListen(s)        → bool (IPv4 or localhost; installers get localhost as 127.0.0.1)
//   validateOrigin(s)        → bool (null | file:// | http(s)://host[:port])
//   bridgeAcceptsOrigin(o)   → bool: one of the bridge's built-in page origins (mirror of DEFAULT_ORIGINS)
//   pageOrigin()             → this page's origin ('null' for a saved file:// copy)
//   parseBridgeUrl(url)      → {ok, host, port, secure, loopback, healthUrl, error}
//   targetsFromConfig(cfg, extra) → {targets:[{name, host, port, target, url}], errors, urls, port, listen, warnings}
//   buildInstaller(os, {allow, port, listen, allowWrites, autostart, origins}) → {ok, filename, text, errors, warnings, commands}
//   installerFromConfig(cfg, os, {extra, allowWrites, autostart, origins}) → same, targets from the
//                              "Modbus TCP via WebSocket bridge" devices (+ extra host:port list);
//                              origins default to this page's origin when the bridge would refuse it
//                              (a custom http(s) site — never "null")
//   commandsFor(os, o)       → {node, installer, packaged, direct, uninstall} (values with * or [ ]
//                              single-quoted for sh / zsh, double-quoted for PowerShell / cmd)
//   zip(entries, date)       → Uint8Array (stored ZIP, CRC-32; Unix modes for install.sh)
//   packageZip(date)         → {filename, bytes, files}
//   allowedBy(specs, host, port) → bool (the bridge's allow-list rules)
//   checkBridge(cfg, {fetch, timeoutMs, url}) → Promise<{ok, results:[…]}>  (GET <bridge>/health; a
//                              refusal is 403 {"error":"origin"|"host"}; when the CORS request fails a
//                              no-cors probe tells "something answered" from "nothing listens")
// The bridge files come from window.WTS_modbusBridgePack (64-modbus-bridge-pack.js).
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;

var DEFAULT_URL = 'ws://127.0.0.1:8502';
var BRIDGE_NAME = 'wts-modbus-bridge';
var SH_FILES = ['modbus-bridge.js', 'fake-slave.js', 'README.md'];

function pack() { var P = G.WTS_modbusBridgePack; return (P && P.files && P.files['modbus-bridge.js']) ? P : null; }

// ─── validation ──────────────────────────────────────────────────────────────
function isIPv4(s) {
    var m = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(String(s));
    if (!m) return false;
    for (var i = 1; i <= 4; i++) if (+m[i] > 255) return false;
    return true;
}
// IPv6 (no zone id): hex digits, colons and dots, at least two colons — shell-safe characters
function isIPv6(a) { a = String(a == null ? '' : a); return /^[0-9A-Fa-f:.]{2,45}$/.test(a) && a.split(':').length >= 3; }
function validHost(h) {
    h = String(h == null ? '' : h);
    if (h.length < 1 || h.length > 253) return false;
    if (h[0] === '[' && h[h.length - 1] === ']') return isIPv6(h.slice(1, -1));
    if (h.indexOf('/') >= 0) { var p = h.split('/'); return p.length === 2 && isIPv4(p[0]) && /^[0-9]{1,2}$/.test(p[1]) && +p[1] <= 32; }
    if (/^[0-9.]+$/.test(h)) return isIPv4(h);
    return /^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/.test(h) && h.indexOf('..') < 0;
}
function validPort(p) { p = String(p == null ? '' : p); return /^[0-9]{1,5}$/.test(p) && +p >= 1 && +p <= 65535; }
function validateTarget(s) {
    var t = String(s == null ? '' : s).trim(), i = t.lastIndexOf(':');
    if (i <= 0) return { ok: false, value: t, error: '"' + t + '" is not host:port' };
    var h = t.slice(0, i), p = t.slice(i + 1);
    if (h === '*') {   // any device (bridge ≥ 1.2.0)
        if (p !== '*' && !validPort(p)) return { ok: false, value: t, error: 'port "' + p + '" must be 1-65535 or *' };
        return { ok: true, value: '*:' + (p === '*' ? '*' : String(+p)), host: '*', port: p === '*' ? '*' : +p };
    }
    if (!validHost(h)) {
        if (isIPv6(h)) return { ok: false, value: t, error: 'put the IPv6 address "' + h + '" in brackets: [' + h + ']:' + p };
        return { ok: false, value: t, error: '"' + h + '" is not an IPv4 address, IPv4 subnet (a.b.c.d/nn), host name or [IPv6] address' };
    }
    if (p !== '*' && !validPort(p)) return { ok: false, value: t, error: 'port "' + p + '" of ' + h + ' must be 1-65535 or *' };
    return { ok: true, value: h.toLowerCase() + ':' + (p === '*' ? '*' : String(+p)), host: h.toLowerCase(), port: p === '*' ? '*' : +p };
}
function validateListen(s) { return s === 'localhost' || isIPv4(s); }
// "localhost" can resolve to ::1 only (macOS, Windows) while the app uses 127.0.0.1
function normListen(s) { return s === 'localhost' ? '127.0.0.1' : s; }
function validateOrigin(o) {
    o = String(o == null ? '' : o);
    if (o === 'null' || o === 'file://') return true;
    var m = /^https?:\/\/([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?$/.exec(o);
    return !!m && o.length <= 300 && (m[2] == null || validPort(m[2]));
}
// Mirror of modbus-bridge.js DEFAULT_ORIGINS: the page origins a bridge accepts without --origin.
function bridgeAcceptsOrigin(o) {
    o = String(o == null ? '' : o);
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o) || /^https:\/\/(www\.)?pb-handbook\.com$/i.test(o) || /^capacitor:\/\/localhost$/i.test(o);
}
function pageOrigin() {
    try {
        var L = G.location;
        if (!L) return '';
        if (L.protocol === 'file:') return 'null';          // browsers send "Origin: null" for file:// pages
        return String(L.origin || '');
    } catch (e) { return ''; }
}
function splitList(s) { return String(s == null ? '' : s).split(/[\s,]+/).filter(Boolean); }

function parseBridgeUrl(u) {
    var s = String(u == null ? '' : u).trim() || DEFAULT_URL;
    var m = /^(wss?|https?):\/\/(\[[0-9A-Fa-f:.]+\]|[^\/:?#\s@]+)(?::([0-9]{1,5}))?(?:[\/?#][^\s]*)?$/i.exec(s);
    if (!m) return { ok: false, url: s, error: 'bridge URL "' + s + '" is not of the form ws://host:port' };
    var scheme = m[1].toLowerCase(), secure = scheme === 'wss' || scheme === 'https', host = m[2].toLowerCase();
    var port = m[3] ? +m[3] : (secure ? 443 : 80);
    if (!(port >= 1 && port <= 65535)) return { ok: false, url: s, error: 'bridge URL "' + s + '": port must be 1-65535' };
    if (host[0] !== '[' && !validHost(host)) return { ok: false, url: s, error: 'bridge URL "' + s + '": bad host name' };
    var loopback = /^(127\.[0-9]+\.[0-9]+\.[0-9]+|localhost|\[::1\])$/.test(host);
    return { ok: true, url: s, host: host, port: port, secure: secure, loopback: loopback,
        healthUrl: (secure ? 'https' : 'http') + '://' + host + ':' + port + '/health' };
}

// ─── targets from the Modbus configuration ───────────────────────────────────
function targetsFromConfig(cfg, extra) {
    var out = { targets: [], errors: [], urls: [], warnings: [], port: 8502, listen: '' }, seen = {}, seenUrl = {};
    ((cfg && cfg.devices) || []).forEach(function (d) {
        if (!d || d.transport !== 'ws') return;
        var name = String(d.name || d.id || 'device'), host = String(d.host == null ? '' : d.host).trim();
        if (host.indexOf(':') >= 0 && host[0] !== '[') host = '[' + host + ']';       // IPv6 device address
        var v = validateTarget(host + ':' + (d.port == null || d.port === '' ? 502 : d.port));
        var u = parseBridgeUrl(d.url);
        if (!u.ok) out.errors.push('Device "' + name + '": ' + u.error);
        else if (!seenUrl[u.healthUrl]) { seenUrl[u.healthUrl] = 1; out.urls.push(u); }
        if (!v.ok) { out.errors.push('Device "' + name + '": ' + v.error); return; }
        out.targets.push({ name: name, host: v.host, port: v.port, target: v.value, url: u.ok ? u.healthUrl : null });
        seen[v.value] = 1;
    });
    splitList(extra).forEach(function (x) {
        var v = validateTarget(x);
        if (!v.ok) { out.errors.push('Extra target: ' + v.error); return; }
        if (!seen[v.value]) { seen[v.value] = 1; out.targets.push({ name: '(extra)', host: v.host, port: v.port, target: v.value, url: null, extra: true }); }
    });
    if (out.urls.length) {
        var u0 = out.urls[0];
        out.port = u0.port;
        if (out.urls.length > 1) out.warnings.push('Your devices use ' + out.urls.length + ' different bridge URLs; the installer is for ' + u0.url + ' (port ' + u0.port + ').');
        if (!u0.loopback) {
            if (isIPv4(u0.host)) {
                out.listen = u0.host;
                out.warnings.push('The bridge URL points at ' + u0.host + ', not this computer: run the installer on that PC. The bridge will then listen on ' + u0.host + ', so other machines on that network can use it.');
            } else out.warnings.push('The bridge URL points at ' + u0.host + ', not this computer: put that PC\'s IP address in the device bridge URL (ws://<its IP>:' + u0.port + ') and generate the installer again — it then listens on that address. (With the host name, run the installer on that PC with --listen <its IP address>.)');
        }
        if (u0.secure) out.warnings.push('The bridge speaks plain ws:// — use ws:// (not wss://) in the bridge URL.');
    }
    return out;
}

// ─── installers ──────────────────────────────────────────────────────────────
function replaceBlock(text, tag, lines) {
    var b = '# @@WTS-' + tag + '-BEGIN@@', e = '# @@WTS-' + tag + '-END@@';
    var i = text.indexOf(b), j = text.indexOf(e);
    if (i < 0 || j < i) return null;
    var lineEnd = text.indexOf('\n', j); if (lineEnd < 0) lineEnd = text.length;
    return text.slice(0, i) + lines.join('\n') + text.slice(lineEnd);
}
function utf8(s) {
    s = String(s);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s)), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
}
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
    var out = '', i, n = bytes.length;
    for (i = 0; i + 2 < n; i += 3) {
        var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    if (n - i === 1) { var a = bytes[i] << 16; out += B64[(a >> 18) & 63] + B64[(a >> 12) & 63] + '=='; }
    else if (n - i === 2) { var c = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64[(c >> 18) & 63] + B64[(c >> 12) & 63] + B64[(c >> 6) & 63] + '='; }
    return out;
}
function chunks(s, n) { var out = []; for (var i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; }

function shInstaller(P, o) {
    var tpl = P.files['install.sh'];
    var preset = [
        '# @@WTS-PRESET-BEGIN@@ (generated by the Well Testing Suite for your devices; bridge v' + P.version + ')',
        'PRESET_ALLOW="' + o.allow.join(',') + '"',
        'PRESET_PORT="' + o.port + '"',
        'PRESET_LISTEN="' + (o.listen || '127.0.0.1') + '"',
        'PRESET_ALLOW_WRITES="' + (o.allowWrites ? 1 : 0) + '"',
        'PRESET_AUTOSTART="' + (o.autostart ? 1 : 0) + '"',
        'PRESET_ORIGINS="' + (o.origins || []).join(',') + '"',
        '# @@WTS-PRESET-END@@'];
    var sums = [], bodies = [];
    SH_FILES.forEach(function (f) {
        if (typeof P.files[f] !== 'string') return;
        sums.push('        ' + f + ") printf '%s' '" + P.sha256[f] + "' ;;");
        bodies.push('        ' + f + ')', "            cat <<'WTS_PAYLOAD_EOF'");
        Array.prototype.push.apply(bodies, chunks(base64(utf8(P.files[f])), 76));
        bodies.push('WTS_PAYLOAD_EOF', '            ;;');
    });
    var payload = ['# @@WTS-PAYLOAD-BEGIN@@ (bridge v' + P.version + ' embedded by the Well Testing Suite; SHA-256 checked when unpacked)',
        'EMBEDDED_FILES="' + SH_FILES.filter(function (f) { return typeof P.files[f] === 'string'; }).join(' ') + '"',
        'EMBEDDED_VERSION="' + P.version + '"',
        'embedded_sha256() {', '    case "$1" in'].concat(sums, ['        *) return 1 ;;', '    esac', '}',
        'embedded_b64() {', '    case "$1" in'], bodies, ['        *) return 1 ;;', '    esac', '}', '# @@WTS-PAYLOAD-END@@']);
    var t = replaceBlock(tpl, 'PRESET', preset);
    t = t && replaceBlock(t, 'PAYLOAD', payload);
    return t;
}
function psInstaller(P, o) {
    var tpl = P.files['install-windows.ps1'];
    var preset = [
        '# @@WTS-PRESET-BEGIN@@ (generated by the Well Testing Suite for your devices; bridge v' + P.version + ')',
        "$PresetAllow = '" + o.allow.join(',') + "'",
        '$PresetPort = ' + o.port,
        "$PresetListen = '" + (o.listen || '127.0.0.1') + "'",
        '$PresetAllowWrites = ' + (o.allowWrites ? '$true' : '$false'),
        '$PresetAutoStart = ' + (o.autostart ? '$true' : '$false'),
        "$PresetOrigins = '" + (o.origins || []).join(',') + "'",
        '# @@WTS-PRESET-END@@'];
    var payload = ['# @@WTS-PAYLOAD-BEGIN@@ (bridge v' + P.version + ' embedded by the Well Testing Suite; SHA-256 checked when unpacked)',
        "$EmbeddedVersion = '" + P.version + "'", '$Embedded = @{}'];
    SH_FILES.forEach(function (f) {
        if (typeof P.files[f] !== 'string') return;
        var lines = chunks(base64(utf8(P.files[f])), 76).map(function (c) { return "'" + c + "'"; });
        payload.push("$Embedded['" + f + "'] = @{ Sha256 = '" + P.sha256[f] + "'; B64 = (@(");
        payload.push(lines.join(',\n'));
        payload.push(") -join '') }");
    });
    payload.push('# @@WTS-PAYLOAD-END@@');
    var t = replaceBlock(tpl, 'PRESET', preset);
    t = t && replaceBlock(t, 'PAYLOAD', payload);
    return t && t.replace(/\r?\n/g, '\r\n');          // Windows line endings for Notepad users
}

function normOs(os) { os = String(os || '').toLowerCase(); return os === 'mac' || os === 'macos' || os === 'darwin' ? 'macos' : os === 'linux' ? 'linux' : 'windows'; }
// Shell quoting for the copyable commands. Validated values only contain [A-Za-z0-9._:/*,[\]-],
// so quotes never appear inside them; * and [ ] are globs in sh / zsh (zsh aborts on an
// unmatched glob), PowerShell reads a leading [ as a type literal.
function shArg(s) { s = String(s); return /[*?\[\]]/.test(s) ? "'" + s + "'" : s; }
function winArg(s) { s = String(s); return /[*?\[\]]/.test(s) ? '"' + s + '"' : s; }
function commandsFor(os, o) {
    os = normOs(os); o = o || {};
    var allow = (o.allow || []).filter(function (a) { return validateTarget(a).ok; });
    var origins = (o.origins || []).filter(validateOrigin);
    var port = validPort(o.port) ? +o.port : 8502, listen = o.listen && validateListen(o.listen) ? normListen(o.listen) : '';
    if (listen === '127.0.0.1') listen = '';                                    // the default
    var q = os === 'windows' ? winArg : shArg;
    var direct = 'node modbus-bridge.js' + allow.map(function (a) { return ' --allow ' + q(a); }).join('') + (port !== 8502 ? ' --port ' + port : '') +
        (listen ? ' --listen ' + listen : '') + origins.map(function (x) { return ' --origin ' + x; }).join('') + (o.allowWrites ? ' --allow-writes' : '');
    if (os === 'windows') {
        return {
            node: 'winget install OpenJS.NodeJS.LTS',
            installer: 'powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\\Downloads\\wts-modbus-bridge-install.ps1"',
            packaged: 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Allow "' + allow.join(',') + '"' + (port !== 8502 ? ' -Port ' + port : '') +
                (listen ? ' -Listen ' + listen : '') + (origins.length ? ' -Origin "' + origins.join(',') + '"' : '') + (o.allowWrites ? ' -AllowWrites' : '') + (o.autostart ? ' -AutoStart' : ''),
            direct: direct,
            uninstall: 'powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1" -Uninstall'
        };
    }
    return {
        node: os === 'macos' ? 'brew install node' : 'sudo apt-get install nodejs      # or: sudo dnf install nodejs',
        installer: 'bash ~/Downloads/wts-modbus-bridge-install.sh',
        packaged: 'bash install.sh --allow ' + (allow.length ? shArg(allow.join(',')) : '<ip>:502') + (port !== 8502 ? ' --port ' + port : '') + (listen ? ' --listen ' + listen : '') +
            origins.map(function (x) { return ' --origin ' + x; }).join('') + (o.allowWrites ? ' --allow-writes' : '') + (o.autostart ? ' --autostart' : ''),
        direct: direct,
        uninstall: os === 'macos' ? 'bash "$HOME/Library/Application Support/WTS Modbus Bridge/install.sh" --uninstall'
            : 'bash "${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh" --uninstall'
    };
}
function buildInstaller(os, o) {
    os = normOs(os); o = o || {};
    var P = pack(), errors = [], warnings = [], allow = [];
    if (!P) return { ok: false, errors: ['The bridge package is not bundled in this build.'], warnings: warnings };
    (o.allow || []).forEach(function (a) {
        var v = validateTarget(a);
        if (!v.ok) errors.push(v.error); else if (allow.indexOf(v.value) < 0) allow.push(v.value);
    });
    var port = (o.port == null || o.port === '') ? 8502 : o.port;
    if (!validPort(port)) errors.push('bridge port "' + port + '" must be 1-65535'); else port = +port;
    var listen = o.listen ? String(o.listen) : '';
    if (listen && !validateListen(listen)) errors.push('listen address "' + listen + '" must be an IPv4 address or localhost');
    else listen = normListen(listen);
    var origins = [];
    (o.origins || []).forEach(function (x) {
        x = String(x == null ? '' : x).trim();
        if (!x) return;
        if (!validateOrigin(x)) errors.push('page origin "' + x + '" must be https://host[:port], http://host[:port], null or file://');
        else if (origins.indexOf(x) < 0) origins.push(x);
    });
    if (!allow.length && !errors.length) errors.push('No targets yet: add a device with transport "Modbus TCP via WebSocket bridge" (its host / IP and port), or enter a target.');
    if (errors.length) return { ok: false, errors: errors, warnings: warnings };
    var opts = { allow: allow, port: port, listen: listen, allowWrites: !!o.allowWrites, autostart: !!o.autostart, origins: origins };
    var text = os === 'windows' ? psInstaller(P, opts) : shInstaller(P, opts);
    if (!text) return { ok: false, errors: ['The bundled installer template has no preset / payload block.'], warnings: warnings };
    return { ok: true, os: os, filename: os === 'windows' ? 'wts-modbus-bridge-install.ps1' : 'wts-modbus-bridge-install.sh',
        type: os === 'windows' ? 'text/plain' : 'application/x-sh', text: text, allow: allow, port: port, listen: listen, origins: origins,
        version: P.version, errors: [], warnings: warnings, commands: commandsFor(os, opts) };
}
// The page's own origin when the bridge would refuse it (the app served from a custom site), so
// the generated installer accepts it. Never "null": any web site can send that (saved copies
// opt in with --origin null, see originNote()).
function autoOrigins() { var o = pageOrigin(); return /^https?:\/\//i.test(o) && validateOrigin(o) && !bridgeAcceptsOrigin(o) ? [o] : []; }
function originNote() {
    var o = pageOrigin();
    if (o === 'null') return 'This page is a saved copy (file://), so the browser sends "Origin: null" — which the bridge refuses by default, because any web site can send it too. Open the app from https://pb-handbook.com or http://localhost instead, or add --origin null (-Origin null on Windows) to the installer command — only on a PC that is not used for general web browsing.';
    if (autoOrigins().length) return 'This page is served from ' + o + ', which the bridge does not accept by default: the generated installer adds it (--origin ' + o + ').';
    return '';
}
function installerFromConfig(cfg, os, o) {
    o = o || {};
    var t = targetsFromConfig(cfg, o.extra);
    if (o.anyIp) t.errors = [];     // any device IP / port (*:*): the per-device targets are not needed
    if (t.errors.length) return { ok: false, errors: t.errors, warnings: t.warnings, targets: t.targets };
    var r = buildInstaller(os, { allow: o.anyIp ? ['*:*'] : t.targets.map(function (x) { return x.target; }), port: t.port, listen: t.listen, allowWrites: o.allowWrites, autostart: o.autostart,
        origins: o.origins != null ? o.origins : autoOrigins() });
    r.warnings = t.warnings.concat(r.warnings || []);
    r.targets = t.targets;
    return r;
}

// ─── ZIP (stored) ────────────────────────────────────────────────────────────
var CRC = null;
function crc32(bytes) {
    if (!CRC) { CRC = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0; } }
    var x = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) x = CRC[(x ^ bytes[i]) & 0xFF] ^ (x >>> 8);
    return (x ^ 0xFFFFFFFF) >>> 0;
}
// entries: [{name, data: string | byte array, mode: 0o755 | 0o644}] → Uint8Array
function zip(entries, date) {
    var d = date || new Date(), yr = Math.max(1980, d.getFullYear());
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((yr - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var files = entries.map(function (e) {
        var data = typeof e.data === 'string' ? utf8(e.data) : e.data, name = utf8(e.name);
        return { name: name, data: data, crc: crc32(data), mode: e.mode || 420 };
    });
    var size = 22;
    files.forEach(function (f) { size += 30 + f.name.length + f.data.length + 46 + f.name.length; });
    var buf = new Uint8Array(size), dv = new DataView(buf.buffer), p = 0, cd = [];
    function u16(v) { dv.setUint16(p, v, true); p += 2; }
    function u32(v) { dv.setUint32(p, v >>> 0, true); p += 4; }
    function bytes(b) { buf.set(b, p); p += b.length; }
    files.forEach(function (f) {
        f.offset = p;
        u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
        u32(f.crc); u32(f.data.length); u32(f.data.length); u16(f.name.length); u16(0);
        bytes(f.name); bytes(f.data);
    });
    var cdStart = p;
    files.forEach(function (f) {
        u32(0x02014b50); u16((3 << 8) | 20); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
        u32(f.crc); u32(f.data.length); u32(f.data.length); u16(f.name.length); u16(0); u16(0); u16(0); u16(0);
        u32((0x8000 | f.mode) * 65536); u32(f.offset);
        bytes(f.name);
        cd.push(f);
    });
    var cdSize = p - cdStart;
    u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length); u32(cdSize); u32(cdStart); u16(0);
    return buf;
}
function packageZip(date) {
    var P = pack();
    if (!P) return null;
    var dir = 'wts-modbus-bridge/';
    var entries = P.order.filter(function (f) { return typeof P.files[f] === 'string'; }).map(function (f) {
        return { name: dir + f, data: P.files[f], mode: /\.sh$/.test(f) ? 493 : 420 };
    });
    return { filename: 'wts-modbus-bridge-' + P.version + '.zip', bytes: zip(entries, date), files: entries.map(function (e) { return e.name; }), version: P.version };
}

// ─── allow-list rules (mirror of modbus-bridge.js parseAllow / allowed) ─────
function ip4num(s) { if (!isIPv4(s)) return null; var p = s.split('.').map(Number); return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; }
function allowedBy(specs, host, port) {
    host = String(host || '').toLowerCase().replace(/^\[|\]$/g, ''); port = +port;
    return (specs || []).some(function (spec) {
        var s = String(spec).trim(), i = s.lastIndexOf(':');
        if (i <= 0) return false;
        var h = s.slice(0, i).replace(/^\[|\]$/g, '').toLowerCase(), p = s.slice(i + 1);
        if (p !== '*' && +p !== port) return false;
        if (h === '*') return true;
        var m = /^([0-9.]+)\/([0-9]+)$/.exec(h);
        if (m) {
            var ip = ip4num(host), base = ip4num(m[1]), bits = +m[2];
            if (ip == null || base == null || !(bits >= 0 && bits <= 32)) return false;
            var mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
            return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
        }
        return h === host;
    });
}
function versionLess(a, b) {
    var x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (var i = 0; i < 3; i++) { var p = x[i] || 0, q = y[i] || 0; if (p !== q) return p < q; }
    return false;
}

// ─── Check bridge (GET /health) ──────────────────────────────────────────────
function originText() { return pageOrigin(); }
function originHint() {
    var o = originText() || '<origin>';
    if (o === 'null') return 'This page is a saved copy (file://): browsers send "Origin: null", which the bridge refuses by default because any web site can send it. Open the app from https://pb-handbook.com or http://localhost, or — only on a PC not used for general browsing — add "null" to "origins" in bridge-config.json (installer: --origin null / -Origin null) and restart the bridge.';
    return 'Add this page\'s origin (' + o + ') to "origins" in bridge-config.json — or run the installer again with --origin ' + o + ' (Windows: -Origin ' + o + ') — and restart the bridge.';
}
function failHints(u, kind) {
    var h = [], o = originText();
    if (kind === 'origin') { h.push('The bridge refused this page\'s origin (' + (o || 'unknown') + ').'); h.push(originHint()); return h; }
    if (kind === 'host') {
        h.push('The bridge answers under a host name (' + u.host + ') only for pages from an accepted web origin; this page (' + (o || 'unknown') + ') is not one, so the name is refused (protection against DNS rebinding).');
        h.push('Put the bridge PC\'s IP address in the device bridge URL (ws://<IP>:' + u.port + ')' + (o === 'null' ? ', or open the app from https://pb-handbook.com or http://localhost.' : '.'));
        return h;
    }
    if (kind === 'forbidden') {           // an older v1.1.0 bridge: plain 403, reason unknown
        h.push('Either this page\'s origin (' + (o || 'unknown') + ') is not accepted: ' + originHint());
        h.push('Or the bridge URL uses a host name: put the bridge PC\'s IP address in the device bridge URL instead.');
        return h;
    }
    if (kind === 'opaque') {
        h.push('Something is listening at ' + u.healthUrl.replace(/\/health$/, '') + ', but the browser was not allowed to read its reply.');
        if (o && !bridgeAcceptsOrigin(o)) h.push('The bridge probably refused this page\'s origin (' + o + '). ' + originHint());
        h.push('A bridge older than v1.1 has no health check — download the package again and re-run the installer.');
        h.push('Chrome / Edge may ask to allow this site to access apps or devices on your local network — choose Allow.');
        return h;
    }
    h.push('Is the bridge running? Windows: Start menu → "WTS Modbus Bridge". macOS / Linux: run start-bridge.sh from the install folder (or install with --autostart).');
    if (o && !bridgeAcceptsOrigin(o)) h.push('The bridge accepts only pages from localhost, 127.0.0.1 and pb-handbook.com by default, and a browser cannot read its refusal from every site: ' + originHint());
    h.push('Is the port right? The bridge URL of your devices must match the bridge (' + u.url + ').');
    h.push('A bridge older than v1.1 has no health check — download the package again and re-run the installer.');
    if (!u.loopback) h.push('The bridge is on another computer: it must listen on that PC\'s network address (listen in bridge-config.json) and the firewall must allow TCP ' + u.port + '.');
    h.push('Chrome / Edge may ask to allow this site to access apps or devices on your local network — choose Allow. Other browsers may block an https page from reaching http://127.0.0.1: use Chrome / Edge, or open the app from http://localhost or a saved copy.');
    return h;
}
function checkOne(u, devices, f, opts) {
    var base = { url: u.url, healthUrl: u.healthUrl, devices: [], hints: [] };
    if (!u.ok) return Promise.resolve(Object.assign(base, { ok: false, error: u.error }));
    if (typeof f !== 'function') return Promise.resolve(Object.assign(base, { ok: false, error: 'This browser cannot run the check (no fetch).' }));
    var ms = opts.timeoutMs || 4000, timer = null, timedOut = false, ctl = null;
    try { if (typeof AbortController !== 'undefined') ctl = new AbortController(); } catch (e) { ctl = null; }
    var timeout = new Promise(function (resolve, reject) {
        timer = setTimeout(function () { timedOut = true; if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } } reject(new Error('timeout')); }, ms);
    });
    var init = { method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit' };
    if (ctl) init.signal = ctl.signal;
    // A CORS failure (a refusal without CORS headers, an older bridge, a blocked local-network
    // request) and "nothing listens" both reject with a TypeError; a no-cors probe tells them
    // apart: an opaque response means something answered.
    var req = Promise.resolve().then(function () { return f(u.healthUrl, init); }).then(null, function (e) {
        if (timedOut) throw e;
        var init2 = { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit' };
        if (ctl) init2.signal = ctl.signal;
        return Promise.resolve().then(function () { return f(u.healthUrl, init2); }).then(function (r2) {
            if (r2 && (r2.type === 'opaque' || r2.status === 0)) return { opaqueProbe: true };
            throw e;
        }, function () { throw e; });
    });
    function done() { if (timer != null) { clearTimeout(timer); timer = null; } }
    return Promise.race([req, timeout]).then(function (res) {
        done();
        if (res && res.opaqueProbe) return Object.assign(base, { ok: false, reachable: true, error: 'Something answered at ' + u.healthUrl + ', but the browser did not let this page read the reply.', hints: failHints(u, 'opaque') });
        if (res && res.status === 403) {
            return Promise.resolve().then(function () { return res.json(); }).then(null, function () { return null; }).then(function (b) {
                var why = b && (b.error === 'origin' || b.error === 'host') ? b.error : '';
                return Object.assign(base, { ok: false, reachable: true, refused: why || 'unknown',
                    error: why === 'origin' ? 'The bridge at ' + u.healthUrl + ' is running but refused this page (origin not accepted).'
                        : why === 'host' ? 'The bridge at ' + u.healthUrl + ' is running but refused the host name ' + u.host + '.'
                        : 'The bridge at ' + u.healthUrl + ' answered 403 Forbidden.',
                    hints: failHints(u, why || 'forbidden') });
            });
        }
        if (!res || !res.ok) return Object.assign(base, { ok: false, reachable: true, error: 'Something answered at ' + u.healthUrl + ' with HTTP ' + (res ? res.status : '?') + ' — not the WTS Modbus bridge (or an older version).', hints: failHints(u) });
        return Promise.resolve().then(function () { return res.json(); }).then(function (h) {
            if (!h || h.name !== BRIDGE_NAME || typeof h.version !== 'string') {
                return Object.assign(base, { ok: false, reachable: true, error: 'Something answered at ' + u.healthUrl + ' but it is not the WTS Modbus bridge.', hints: failHints(u) });
            }
            var allow = Array.isArray(h.allow) ? h.allow.map(String) : [];
            var devs = devices.map(function (d) { return { name: d.name, target: d.target, allowed: allowedBy(allow, d.host, d.port === '*' ? 502 : d.port) }; });
            var P = pack(), warnings = [];
            if (P && versionLess(h.version, P.version)) warnings.push('Bridge v' + h.version + ' is older than v' + P.version + ' bundled with this app — download the package again and re-run the installer to update.');
            var missing = devs.filter(function (d) { return !d.allowed; });
            if (missing.length) warnings.push('Not in the bridge allow-list: ' + missing.map(function (d) { return d.target; }).join(', ') + ' — re-run the installer (step 3) or add them to "allow" in bridge-config.json, then restart the bridge.');
            if (!devices.length) warnings.push('No "Modbus TCP via WebSocket bridge" devices use this bridge yet.');
            return Object.assign(base, { ok: !missing.length, reachable: true, running: true, version: h.version, readOnly: h.readOnly !== false,
                port: h.port, uptimeS: h.uptimeS, allow: allow, devices: devs, warnings: warnings });
        }, function () {
            return Object.assign(base, { ok: false, reachable: true, error: 'Something answered at ' + u.healthUrl + ' but not with the bridge\'s health data.', hints: failHints(u) });
        });
    }, function () {
        done();
        return Object.assign(base, { ok: false, reachable: false, timedOut: timedOut,
            error: timedOut ? 'No answer from ' + u.healthUrl + ' within ' + Math.round(ms / 1000) + ' s.' : 'No bridge answered at ' + u.healthUrl + '.', hints: failHints(u) });
    });
}
function checkBridge(cfg, opts) {
    opts = opts || {};
    var f = opts.fetch || (typeof G.fetch === 'function' ? function (a, b) { return G.fetch(a, b); } : null);
    var t = targetsFromConfig(cfg, '');
    var urls = t.urls.length ? t.urls : [parseBridgeUrl(opts.url || DEFAULT_URL)];
    return Promise.all(urls.map(function (u) {
        var devs = t.targets.filter(function (d) { return !d.extra && (d.url === u.healthUrl || (!d.url && urls.length === 1)); });
        return checkOne(u, devs, f, opts);
    })).then(function (results) {
        return { ok: results.every(function (r) { return r.ok; }), results: results, configErrors: t.errors };
    });
}

G.WTS_modbusBridgeSetup = {
    DEFAULT_URL: DEFAULT_URL, validateTarget: validateTarget, validateListen: validateListen, validHost: validHost, isIPv4: isIPv4, isIPv6: isIPv6,
    validateOrigin: validateOrigin, bridgeAcceptsOrigin: bridgeAcceptsOrigin, pageOrigin: pageOrigin, originNote: originNote, autoOrigins: autoOrigins, shArg: shArg,
    parseBridgeUrl: parseBridgeUrl, targetsFromConfig: targetsFromConfig, buildInstaller: buildInstaller,
    installerFromConfig: installerFromConfig, commandsFor: commandsFor, zip: zip, crc32: crc32, base64: base64,
    packageZip: packageZip, allowedBy: allowedBy, checkBridge: checkBridge, versionLess: versionLess, pack: pack
};
})();

// ─── END 65-modbus-bridge-setup ─────────────────────────────────────────────

