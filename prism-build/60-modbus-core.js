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
    var T = makeEmitter({ kind: 'ws', framing: 'tcp' }), ws = null, open = false, otimer = null;
    var setT = o.setTimeout || function (f, ms) { return G.setTimeout(f, ms); }, clrT = o.clearTimeout || function (id) { G.clearTimeout(id); };
    function done() { if (otimer !== null) { clrT(otimer); otimer = null; } }
    T.url = function () {
        var base = String(o.url || 'ws://127.0.0.1:8502').replace(/\/+$/, '');
        return base + '/modbus?host=' + encodeURIComponent(o.host || '') + '&port=' + encodeURIComponent(o.port || 502);
    };
    T.open = function () {
        return new Promise(function (resolve, reject) {
            var WS = o.WebSocket || G.WebSocket;
            if (typeof WS !== 'function') { reject(ModbusError('transport', 'WebSocket is not available in this browser')); return; }
            var settled = false;
            done();
            function fail(msg) { done(); if (!settled) { settled = true; reject(ModbusError('transport', msg)); } }
            try { ws = new WS(T.url()); } catch (e) { fail('Bridge URL rejected: ' + (e && e.message)); return; }
            // The bridge confirms with {"type":"open"} once its TCP connection to the device is up. A socket that never
            // confirms (a program that is not the bridge on that port, or a device that neither answers nor refuses)
            // must not leave the device "connecting" for ever: give up after openTimeoutMs (the station then retries).
            var oms = Math.max(1000, +o.openTimeoutMs || 10000);
            otimer = setT(function () {
                otimer = null;
                if (settled) return;
                fail('No answer through the bridge from ' + (o.host || '?') + ':' + (o.port || 502) + ' within ' + Math.round(oms / 1000) + ' s — check the device IP / port, and that ' +
                    (o.url || 'ws://127.0.0.1:8502') + ' is the WTS Modbus bridge');
                try { ws.onclose = null; ws.close(1000, 'open timeout'); } catch (e) {}
                ws = null;
            }, oms);
            ws.binaryType = 'arraybuffer';
            ws.onmessage = function (ev) {
                var d = ev.data;
                if (typeof d === 'string') {
                    var m = null; try { m = JSON.parse(d); } catch (e) {}
                    if (m && m.type === 'open') { open = true; done(); if (!settled) { settled = true; resolve(T); } }
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
    T.close = function () { done(); open = false; if (ws) { try { ws.onclose = null; ws.close(1000, 'client close'); } catch (e) {} } ws = null; };
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

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, M = G.WTS_modbus;
    if (!M || !M.crc16) return;
    var ok = M.crc16([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]) === 0x4B37 &&
        M.hex(M.encodeRtu(1, M.buildReadPdu(3, 0, 10))) === '01 03 00 00 00 0A C5 CD' &&
        Math.abs(M.decodeValue(M.encodeValue(123.456, 'float32', 'CDAB'), 'float32', 'CDAB') - 123.456) < 1e-4;
    if (typeof console !== 'undefined') console[ok ? 'log' : 'warn']('[60-modbus-core] self-test ' + (ok ? 'passed' : 'FAILED'));
})();
