
// ═══════════════════════════════════════════════════════════════════════
// Round-10 (live data) — auto-injected from prism-build/5N-*.js
//   window.WTS_modbus (Modbus TCP / RTU master, station, virtual slave) and the
//   registry pages `modbus` and `wellos` (Mini WellOS).
//   • 50-modbus-core
//   • 51-modbus-station
//   • 52-modbus-page
//   • 53-wellos
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 50-modbus-core ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 50-modbus-core.js — Modbus protocol core (Round-10, "Live Data")
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
            ws.onerror = function () { fail('Cannot reach the Modbus bridge at ' + (o.url || 'ws://127.0.0.1:8502') + ' — is it running?'); };
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

// ─── END 50-modbus-core ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 51-modbus-station ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 51-modbus-station.js — Modbus configuration, polling station, alarms,
// app-variable links and the built-in virtual slave (Round-10, "Live Data")
// -----------------------------------------------------------------------------
// Extends window.WTS_modbus (50-modbus-core.js):
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

// ─── END 51-modbus-station ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 52-modbus-page ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 52-modbus-page.js — "Modbus" configuration page (route `modbus`, group "Live Data")
// -----------------------------------------------------------------------------
// Devices (transport, address, unit id, poll rate, timeout, retries, byte/word order),
// tags (register table, address with a 0/1-based toggle, data type, word order,
// scaling, units, alarm limits, deadband, link to a well-test variable, historian
// logging), "Test read" per tag, live monitor, global pause, JSON / CSV import and
// export, write protection ("Enable writes" + confirmation), the built-in virtual
// slave (WTS_sim / waveform / manual) and connection guides (WebSocket bridge,
// Web Serial RTU, iOS native TCP).
//
// The page state lives in localStorage 'wts_modbus_config' (WTS_modbus.saveConfig);
// the root carries data-no-persist so the host page autosave leaves it alone.
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
function download(name, text, type) {
    try {
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
        '@media (max-width:700px){.mb-slider{grid-template-columns:1fr}}'
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
function guideHtml() {
    return '<div class="mb-guide">' +
        '<h4>Web browser → Modbus TCP (WebSocket bridge)</h4><p>Browsers cannot open raw TCP sockets, so a small bridge runs on a PC on the same network as the PLC / RTU. It ships in the repository as <code>tools/modbus-bridge/</code> (Node.js ≥ 18, no dependencies):</p>' +
        '<ul><li>Windows / macOS / Linux: <code>node tools/modbus-bridge/modbus-bridge.js --allow 192.168.1.10:502</code></li>' +
        '<li>It listens on <code>ws://127.0.0.1:8502</code> (localhost only by default), connects only to the allow-listed host:port pairs, and refuses Modbus writes unless started with <code>--allow-writes</code>.</li>' +
        '<li>Set the device transport to "Modbus TCP via WebSocket bridge", the host / IP and port of the PLC, and the bridge URL.</li></ul>' +
        '<h4>Modbus RTU (RS-485) — Web Serial</h4><p>Chrome or Edge on a desktop, page served over https or localhost. Plug in a USB–RS-485 adapter, choose "Modbus RTU via Web Serial", set baud / parity / unit id, then press <b>Test</b> — the browser asks which serial port to use (once).</p>' +
        '<h4>iOS app — native TCP</h4><p>In the iOS app, choose "Modbus TCP (iOS app, native)". The app connects directly to the PLC over Wi-Fi (Network framework); iOS asks once for Local Network permission.</p>' +
        '<h4>No hardware?</h4><p>"Load simulator demo" configures one device on the built-in virtual slave: 36 tags covering pressures, temperatures, rates, levels and valve states, fed by the Well Test Simulator model. Mini WellOS then animates from those tags when its data source is set to "Modbus data".</p></div>';
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
        '<div class="card"><div class="card-title">Connecting to real equipment</div>' + guideHtml() + '</div>' +
        '<div id="mbc_res"></div></div>';
    var root = byId('mbc_root');
    ctl = createController(root, n);
    if (typeof G.calcModbusConfig === 'function') G.calcModbusConfig();
}

function createController(root, n0) {
    var cfg = n0.config, tagErrors = n0.tagErrors, errors = n0.errors, disposed = false, monitor = null, pendingImport = null;
    var C = { root: root };
    function q(sel) { return root.querySelector(sel); }
    function refresh(which) {
        if (!which || which.dev) { var d = q('#mbc_devs'); if (d) d.innerHTML = devicesHtml(cfg); }
        if (!which || which.tag) { var t = q('#mbc_tags'); if (t) t.innerHTML = tagsHtml(cfg, tagErrors); }
        if (!which || which.slave) { var s = q('#mbc_slave'); if (s) s.innerHTML = slaveHtml(cfg); }
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
    function onProject() { if (root.isConnected && typeof G.WTS_rerender !== 'function') { cfg = M.getConfig(); refresh({}); } }
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
    refresh({});
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

// ─── END 52-modbus-page ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 53-wellos ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// 53-wellos.js — Mini WellOS (route `wellos`, its own sidebar group "Mini WellOS")
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

// ─── END 53-wellos ─────────────────────────────────────────────

