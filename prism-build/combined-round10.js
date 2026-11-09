
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
//   • 66-account
//   • 67-cloud-sync
//   • 68-account-page
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

// Plain-English reading of a socket error the bridge reports while connecting to a device
// (Node error codes), so the device status says what to check instead of only 'ECONNREFUSED'.
M.explainBridgeError = function (msg, host, port) {
    var t = String(msg || ''), at = (host || '?') + ':' + (port || 502), why = null;
    if (/ECONNREFUSED/.test(t)) why = 'Nothing is listening at ' + at + ' — start the Modbus device or simulator there, or check the IP address and port.';
    else if (/ETIMEDOUT|ECONNABORTED/.test(t)) why = 'No answer from ' + at + ' — check the IP address, that the device is powered and on this network, and any firewall.';
    else if (/EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL/.test(t)) why = 'Cannot reach ' + at + ' from the bridge PC — check the IP address and network (cable, VLAN, VPN).';
    else if (/ENOTFOUND|EAI_AGAIN/.test(t)) why = 'The device name ' + (host || '?') + ' could not be resolved — use its IP address.';
    else if (/ECONNRESET|EPIPE/.test(t)) why = 'The device at ' + at + ' dropped the connection — it may allow only one Modbus client, or the unit ID / port is wrong.';
    return why ? why + ' (' + t + ')' : t;
};

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
                    else if (m && m.type === 'error') { fail(open ? 'Bridge: ' + (m.message || 'error') : M.explainBridgeError('Bridge: ' + (m.message || 'error'), o.host, o.port)); T.emit('error', m.message); }
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
    // key 'pump_running' kept for saved mappings / projects: it is the LCV-201 transfer state (snapshot surge.transfer,
    // legacy surge.pump) since the pump moved downstream of the gauge tank in v3.0.2
    { key: 'pump_running', label: 'Transfer valve LCV-201 open (surge → gauge tank)', group: 'Surge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['surge', 'pump', 'on'])); },
      set: function (s, v) { s.surge.pump.on = !!v; lineSet(s, 'surge_gauge', null, !!v); if (!v && s.segs[5]) { s.segs[5].vel = 0; s.segs[5].flowing = false; } } },
    { key: 'gauge_lvl_a', label: 'Gauge tank level — T-301A', group: 'Gauge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['gauge', 'tanks', 0, 'frac'])); }, set: function (s, v) { if (s.gauge.tanks[0]) s.gauge.tanks[0].frac = clamp(v / 100, 0, 1.05); } },
    { key: 'gauge_lvl_b', label: 'Gauge tank level — T-301B', group: 'Gauge tank', cat: 'percent', min: 0, max: 100,
      get: function (s) { return pct(g(s, ['gauge', 'tanks', 1, 'frac'])); }, set: function (s, v) { if (s.gauge.tanks[1]) s.gauge.tanks[1].frac = clamp(v / 100, 0, 1.05); } },
    { key: 'xv301a', label: 'Gauge tank inlet XV-301A open', group: 'Gauge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['gauge', 'tanks', 0, 'inlet'])); }, set: function (s, v) { if (s.gauge.tanks[0]) s.gauge.tanks[0].inlet = !!v; } },
    { key: 'xv301b', label: 'Gauge tank inlet XV-301B open', group: 'Gauge tank', cat: 'bool', kind: 'bool',
      get: function (s) { return bool(g(s, ['gauge', 'tanks', 1, 'inlet'])); }, set: function (s, v) { if (s.gauge.tanks[1]) s.gauge.tanks[1].inlet = !!v; } },
    // P-201 empties the gauge tank to the export / burner line (v3.0.2: downstream of T-301; snapshot gauge.pump)
    { key: 'p201_running', label: 'Gauge tank pump P-201 running (T-301 → export)', group: 'Gauge tank', cat: 'bool', kind: 'bool',
      get: function (s) { var p = g(s, ['gauge', 'pump']); return p && p.mode === 'none' ? null : bool(p ? p.on : undefined); },
      set: function (s, v) { if (s.gauge.pump) s.gauge.pump.on = !!v; lineSet(s, 'gauge_drain', null, !!v); } }
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
    ['LCV201_OPEN', 'pump_running', 'discrete', 2, 'bool', '', null, '', null, 0],
    ['XV201A_OPEN', 'xv201a', 'discrete', 3, 'bool', '', null, '', null, 0],
    ['XV201B_OPEN', 'xv201b', 'discrete', 4, 'bool', '', null, '', null, 0],
    ['XV301A_OPEN', 'xv301a', 'discrete', 5, 'bool', '', null, '', null, 0],
    ['XV301B_OPEN', 'xv301b', 'discrete', 6, 'bool', '', null, '', null, 0],
    ['HTR_BYPASS', 'heater_bypass', 'discrete', 7, 'bool', '', null, '', null, 0],
    ['ESD_TRIP_CMD', '', 'coil', 0, 'bool', '', null, '', null, 0],
    ['ESD_RESET_CMD', '', 'coil', 1, 'bool', '', null, '', null, 0],
    ['SEP_P_SP', '', 'holding', 0, 'float32', 'ABCD', null, 'psig', null, 0],
    // appended (v3.1) so the ids of the earlier demo tags ('tag_demo_<index>') stay as they were
    ['P201_RUNNING', 'p201_running', 'discrete', 8, 'bool', '', null, '', null, 0]
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
    try { if (s) (typeof WTS_lsSet === 'function' ? WTS_lsSet(STORE_KEY, txt, { raw: true }) : s.setItem(STORE_KEY, txt)); } catch (e) { return { ok: false, errors: ['Could not save: ' + (e && e.message)] }; }   /* ls-raw: fallback */
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
        case 'ws': return M.transports.webSocket({ url: dev.url, host: dev.host, port: dev.port, openTimeoutMs: Math.max(5000, 5 * dev.timeoutMs),
            setTimeout: env.setTimeout, clearTimeout: env.clearTimeout });
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
    // A register that decodes to NaN / ±Infinity (IEEE-754 sensor-fault patterns, or a scaling that cannot be
    // applied) is bad quality with a BAD alarm — never a "good" non-number. The next valid value clears it.
    function badValue(tg, raw, t) {
        var r = vals[tg.id]; if (!r) return;
        r.raw = isNum(raw) ? raw : null; r.ts = t; r.q = 'bad'; r.canon = null;
        r.err = 'invalid value (' + (typeof raw === 'number' && isNaN(raw) ? 'NaN' : typeof raw === 'number' && !isFinite(raw) ? (raw > 0 ? '+Inf' : '-Inf') : 'cannot be scaled') + ') from the device';
        if (r.level !== 'BAD') {
            r.level = 'BAD';
            alarms.update(tg.id, 'BAD', { t: t, tag: tg.name, device: (devs[tg.device] || {}).dev ? devs[tg.device].dev.name : '', value: null, limit: null, msg: r.err });
        }
        hist[tg.id].push(t, null);
    }
    function decodeBlock(D, blk, data, t) {
        blk.items.forEach(function (it) {
            var tg = it.ref, raw, eng;
            try {
                if (M.TABLES[tg.table].bits) raw = data[it.offset] ? 1 : 0;
                else if (tg.type === 'bool') raw = data[it.offset] ? 1 : 0;
                else raw = M.decodeValue(data.slice(it.offset, it.offset + it.count), tg.type, tg.order || D.dev.order);
                eng = tg.type === 'bool' ? raw : M.scaleToEng(raw, tg.scale);
                if (typeof eng !== 'number' || !isFinite(eng)) badValue(tg, raw, t);
                else setValue(tg, raw, eng, t);
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
        lcv_oil: 0, lcv_water: 0, pcv_sep: 50, esd_open: 1, esd_tripped: 0, pump_running: 0, xv201a: 1, xv201b: 1, xv301a: 1, xv301b: 0, heater_bypass: 0, p201_running: 0 };
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
                v.pump_running = sn(300) > 0 ? 1 : 0; v.p201_running = sn(900, 1) > 0.3 ? 1 : 0;
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
// (one click: the Windows installer exe / the macOS-Linux curl one-liner from the GitHub release →
// "Check bridge" via GET /health; "Advanced / manual setup": install Node → bundled bridge package →
// an installer generated for the configured bridge devices), Web Serial RTU, iOS native TCP,
// troubleshooting. The guide card is .rp-skip (kept out of PDF / Quick Report).
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
        '.mb-note{border-left:3px solid var(--green);padding:6px 10px;margin:6px 0 10px;font-size:12px;color:var(--text2);background:var(--bg1);border-radius:0 6px 6px 0}',
        '.mb-guide a.mb-dl{display:inline-flex;align-items:center;gap:6px;font-size:14px;padding:10px 16px;text-decoration:none;max-width:100%;box-sizing:border-box;white-space:normal}',
        '.mb-quick-lines{margin:8px 0;padding-left:20px}.mb-quick-lines li{margin:3px 0}',
        '.mb-guide details.mb-adv-sec{background:transparent}'
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
        '<p>Browsers cannot open raw TCP sockets, so a small bridge program runs on a PC on the same network as the PLC / RTU. It listens on <code>ws://127.0.0.1:8502</code> (this computer only), can reach any device IP address by default (you can restrict it to a list), and refuses Modbus writes unless you allow them.</p>' +
        '<div id="mbc_guide_steps"></div></details>' +
        '<details class="mb-sec"><summary>Modbus RTU (RS-485) — Web Serial</summary><p>Chrome or Edge on a desktop, page served over https or localhost (no bridge needed). Plug in a USB–RS-485 adapter, choose "Modbus RTU via Web Serial", set baud / parity / unit id, then press <b>Test</b> — the browser asks which serial port to use (once).</p></details>' +
        '<details class="mb-sec"' + (ios ? ' open' : '') + '><summary>iOS app — native TCP (no bridge)</summary><p>In the iOS app, choose "Modbus TCP (iOS app, native)" and enter the PLC\'s IP address and port. The app connects directly over Wi-Fi (Network framework); iOS asks once for Local Network permission. The WebSocket bridge is not used.</p></details>' +
        '<details class="mb-sec"><summary>No hardware? Built-in simulator</summary><p>"Load simulator demo" configures one device on the built-in virtual slave: ' + M.DEMO_MAP.length + ' tags covering pressures, temperatures, rates, levels and valve states, fed by the Well Test Simulator model. Mini WellOS then animates from those tags when its data source is set to "Modbus data". To try the bridge itself, the package includes <code>fake-slave.js</code>: run <code>node fake-slave.js --port 5020</code>, allow <code>127.0.0.1:5020</code> in the bridge and add a bridge device with host 127.0.0.1, port 5020.</p></details>' +
        '<details class="mb-sec"><summary>Troubleshooting</summary><ul class="mb-hints">' +
        '<li><b>"Cannot reach the Modbus bridge"</b> — the bridge is not running, the bridge URL / port differs, or the bridge refused this page (a browser cannot tell these apart). Press <b>Check bridge</b>: it says which.</li>' +
        '<li><b>Windows: "Windows protected your PC"</b> (SmartScreen) — the installer is code-signed by H2Oil Engineering, but SmartScreen can still warn while the certificate builds reputation: click <b>More info</b>, check the publisher, then <b>Run anyway</b>.</li>' +
        '<li><b>"not in the bridge allow-list"</b> — the bridge was restricted to a list of devices (older installers wrote one). Run the installer again (WTS-Modbus-Bridge-Setup.exe on Windows, or the one-line command): from bridge v1.2.1 it switches to any device. Windows, without reinstalling: Win+R → <code>"%LOCALAPPDATA%\\WTS Modbus Bridge\\WTS-Modbus-Bridge.exe" --allow-any</code>. Or set <code>"allow": []</code> in bridge-config.json (Windows: <code>%LOCALAPPDATA%\\WTS Modbus Bridge</code>; macOS: <code>~/Library/Application Support/WTS Modbus Bridge</code>; Linux: <code>~/.local/share/wts-modbus-bridge</code>) and restart the bridge. To keep a list, add the device with <code>--allow &lt;host&gt;:&lt;port&gt;</code> (<code>-Allow</code>).</li>' +
        '<li><b>"the bridge refused this page"</b> — the page is served from an origin the bridge does not accept: run the installer again with <code>--origin &lt;that origin&gt;</code> (<code>-Origin</code>), or add it to <code>origins</code> in bridge-config.json. A saved copy (file://) sends <code>null</code>, which the bridge refuses by default because any web site can send it: open the app from https://welltest.h2oil.co.uk or http://localhost instead (or add <code>null</code> on a PC not used for general browsing).</li>' +
        '<li><b>"refused the host name"</b> — use the bridge PC\'s IP address in the device bridge URL, not its name.</li>' +
        '<li><b>Timeouts</b> — check the unit id (many gateways need the RS-485 slave address here), the IP / port, and that no firewall blocks TCP 502 between the PC and the device.</li>' +
        '<li><b>Exception 01 on writes</b> — the bridge is read-only. Windows exe: run <code>"%LOCALAPPDATA%\\WTS Modbus Bridge\\WTS-Modbus-Bridge.exe" --allow-writes</code>; macOS / Linux or a script install: run the installer again with <code>--allow-writes</code> (<code>-AllowWrites</code>); it keeps the targets and the port.</li>' +
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
              '<p class="mb-hint">Run again later (for another device, or with writes allowed), an installer keeps the port and settings of the existing bridge-config.json and adds new targets to its list — <code>' + (os === 'windows' ? '-AllowAny' : '--allow-any') + '</code> (the "any device" commands) switches to any device, <code>' + (os === 'windows' ? '-Reset' : '--reset') + '</code> starts a new file. A list written by an older installer is replaced by any device unless you give targets or <code>' + (os === 'windows' ? '-KeepAllow' : '--keep-allow') + '</code>.</p>') +
            cmdBox(cmds.packaged, 'or, in the unzipped package folder') +
            cmdBox(cmds.direct, 'or run the bridge without installing (stops when the window closes)') +
            (os === 'windows'
                ? '<p>No administrator rights needed; <code>-ExecutionPolicy Bypass</code> applies to this one run. It installs to <code>%LOCALAPPDATA%\\WTS Modbus Bridge</code>, writes <code>bridge-config.json</code>, adds a Start-menu shortcut "WTS Modbus Bridge" (and a logon task with auto-start), starts the bridge and checks it.</p>'
                : '<p>No sudo needed. It installs to <code>' + (os === 'macos' ? '~/Library/Application Support/WTS Modbus Bridge' : '~/.local/share/wts-modbus-bridge') + '</code>, writes <code>bridge-config.json</code> and <code>start-bridge.sh</code>' +
                  (os === 'macos' ? ' (auto-start: a LaunchAgent)' : ' (auto-start: a systemd --user service)') + ', starts the bridge and checks it. Without auto-start the bridge runs in that Terminal window — leave it open.</p>') +
            cmdBox(cmds.uninstall, 'uninstall');
    }
    return { targets: targets, run: run, ready: ready, cmds: cmds, port: t.port };
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
        // a list container (items coloured by class), not a one-line ✓ / ✗ verdict div
        '<section id="mbc_guide_targets" aria-label="Bridge targets">' + parts.targets + '</section>' +
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
    return osBtns + '<ol class="mb-steps mb-quick">' +
        '<li><b>Install the bridge</b> (' + OS_LABEL[os] + ')' + quickHtml(os, S.quickSetup(os, { port: parts.port }), ios, P.version) + '</li>' +
        '<li><b>Check the bridge</b>' + check + '</li></ol>' +
        '<details class="mb-sec mb-adv-sec" id="mbc_guide_adv"' + (g.advOpen ? ' open' : '') + '><summary>Advanced / manual setup — bridge package, an installer for your devices only, Node.js</summary>' +
        '<ol class="mb-steps mb-adv">' +
        '<li><b>Install Node.js 18 or newer</b> (' + OS_LABEL[os] + ')' + node + '</li>' +
        '<li><b>Get the bridge</b>' + pkg + '</li>' +
        '<li><b>Install it for your devices</b>' + inst + '</li></ol></details>';
}
// Step 1 of the one-click path: the Windows exe (GitHub release) or the macOS / Linux one-liner.
function quickHtml(os, q, ios, version) {
    if (os === 'windows') {
        var dl = ios
            ? '<p>On the Windows PC, open this link in a browser (or the web version of the app):</p>' + cmdBox(q.exeUrl, 'Windows installer (.exe)')
            : '<div class="btn-row"><a class="btn btn-primary mb-dl" id="mbc_guide_exe" href="' + esc(q.exeUrl) + '" target="_blank" rel="noopener noreferrer">⬇ Download WTS Modbus Bridge for Windows (.exe)</a></div>';
        return dl + '<ol class="mb-quick-lines">' +
            '<li><b>Download</b> ' + esc(q.exeFile) + ' (bridge v' + esc(version) + ' or newer, from the app\'s GitHub releases).</li>' +
            '<li><b>Double-click it.</b> If Windows SmartScreen says "Windows protected your PC", click <b>More info</b> → <b>Run anyway</b> (the exe is signed by H2Oil Engineering; the warning can appear while its certificate builds reputation).</li>' +
            '<li>It installs for your user (no administrator rights, no Node.js needed), starts the bridge now and at every login, and opens its status page. Then press <b>Check bridge</b> below.</li></ol>' +
            '<p class="mb-hint">Remove it with Settings → Apps → "WTS Modbus Bridge" → Uninstall. Default settings: any device IP / port, read-only, port 8502' + (q.port !== 8502 ? ' — your devices use bridge port ' + q.port + ': see Advanced / manual setup, or run the exe with --port ' + q.port : '') + '. Over an older install it keeps the port and write setting and switches a device list to any device (--keep-allow keeps the list).</p>';
    }
    return '<p>Paste this into ' + (os === 'macos' ? 'Terminal' : 'a terminal') + ' — it downloads the installer from the app\'s GitHub releases, installs the bridge for your user (no sudo for the bridge) and starts it now and at every login (' + (os === 'macos' ? 'a LaunchAgent' : 'a systemd --user service') + '):</p>' +
        cmdBox(q.oneLiner, 'Terminal — install the bridge') +
        '<p class="mb-hint">Needs Node.js 18 or newer: with <code>--yes</code> the installer installs it with ' + (os === 'macos' ? 'Homebrew' : 'your package manager (sudo asks for your password)') + ' when it is missing. Default settings: any device IP / port, read-only, port ' + q.port + ' (over an older install: its port and write setting are kept, a device list becomes any device unless you add --keep-allow). Then press <b>Check bridge</b> below.</p>' +
        cmdBox(os === 'macos' ? 'bash "$HOME/Library/Application Support/WTS Modbus Bridge/install.sh" --uninstall' : 'bash "${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh" --uninstall', 'uninstall');
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
    var guide = { os: guessOs(), extra: '', anyIp: true, autostart: true, writes: false, advOpen: false, genHtml: '', checkHtml: '', ios: isIosApp() };
    C.guide = guide;
    function q(sel) { return root.querySelector(sel); }
    // Full re-render of the steps (device list or OS changed); keyboard focus goes back to the
    // equivalent control, so a keyboard / screen-reader user is not dropped to <body>.
    function focusSel(el) {
        if (!el || !el.getAttribute) return null;
        var act = el.getAttribute('data-act'), os = el.getAttribute('data-os'), k = el.getAttribute('data-k'), f = el.getAttribute('data-f');
        if (act === 'guide-os' && /^(windows|macos|linux)$/.test(os || '')) return '[data-act="guide-os"][data-os="' + os + '"]';
        if (act && /^guide-[a-z]+$/.test(act)) return '[data-act="' + act + '"]';
        if (k === 'guide' && /^(extra|anyIp|autostart|writes)$/.test(f || '')) return '[data-k="guide"][data-f="' + f + '"]';
        return null;
    }
    function renderGuide() {
        var g = q('#mbc_guide_steps'); if (!g) return;
        var a = typeof document !== 'undefined' ? document.activeElement : null;
        var sel = a && a !== g && g.contains(a) ? focusSel(a) : null;
        var adv = q('#mbc_guide_adv'); if (adv) guide.advOpen = adv.hasAttribute('open');     // keep "Advanced" open across re-renders
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
                var cellD = q('[data-devstat="' + id + '"]'), dv = find('dev', id);
                // nothing to poll: say why instead of "0 of 0 tags failed"
                var why = !dv ? 'device not found' : !dv.enabled ? 'switched off — tick "On" to test it' : !cfg.tags.some(function (t) { return t.device === id; }) ? 'no tags on this device yet — add a tag, then test' : '';
                if (why) { if (cellD) cellD.innerHTML = '<span class="mb-dot"></span> ' + esc(why); C.lastDevTest = { ok: false, info: {}, tags: 0, bad: 0, why: why }; break; }
                if (cellD) cellD.innerHTML = '<span class="mb-dot connecting"></span> testing…';
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
// v3.4.2: 'gor' is the separator GOR ('GOR (sep)'); the tank gas on the LP flare line (FT-201) and the total GOR are appended
var KPI_KEYS = ['whp', 'bhp', 'sep_p', 'gas_rate', 'oil_rate', 'water_rate', 'gor', 'wcut', 'flare_rate', 'tank_gas', 'gor_total'];
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
function writeUi(u) { try { if (G.localStorage) (typeof WTS_lsSet === 'function' ? WTS_lsSet(UI_KEY, JSON.stringify(u), { raw: true }) : G.localStorage.setItem(UI_KEY, JSON.stringify(u))); } catch (e) {} }   /* ls-raw: fallback */

// ─── display formatting (field units in, WTS_units display out) ─────────────
// pump_running = LCV-201 transfer valve (legacy key); p201_running = the gauge tank pump P-201
var BOOL_TXT = { esd_open: ['OPEN', 'CLOSED'], esd_tripped: ['TRIPPED', 'NORMAL'], pump_running: ['OPEN', 'SHUT'], heater_bypass: ['OPEN', 'SHUT'], p201_running: ['RUNNING', 'STOPPED'] };
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
    gor: { key: 'gor', label: 'GOR (sep)', unit: 'scf/STB', cat: 'gor', dp: 0, deps: ['gas_rate', 'oil_rate'], calc: function (x) { return isNum(x.gas_rate) && isNum(x.oil_rate) && x.oil_rate > 0.5 ? x.gas_rate * 1e6 / x.oil_rate : null; } },
    wcut: { key: 'wcut', label: 'Water cut', unit: '%', deps: ['water_rate', 'oil_rate'], calc: function (x) { return isNum(x.water_rate) && isNum(x.oil_rate) && x.water_rate + x.oil_rate > 0 ? 100 * x.water_rate / (x.water_rate + x.oil_rate) : null; } },
    // v3.4.2 (lpgas design §6): tank gas = the surge-tank gas on the LP flare line through FT-201, Mscf/d — form data: the simulator
    // page's steady LP block (WTS_state.flow.lp, Standing flash at the page rates); Modbus: a linked 'tank_gas' tag (else not linked).
    // Total GOR = (gas × 10^6 + tank gas × 10^3) ÷ oil, its quality the worst of the three
    tank_gas: { key: 'tank_gas', label: 'Tank gas (FT-201)', unit: 'Mscf/d', cat: 'gasRateSmall', dp: 1, ext: tankGas },
    gor_total: { key: 'gor_total', label: 'Total GOR', unit: 'scf/STB', cat: 'gor', dp: 0, deps: ['gas_rate', 'oil_rate', 'tank_gas'], calc: function (x) { return isNum(x.gas_rate) && isNum(x.oil_rate) && isNum(x.tank_gas) && x.oil_rate > 0.5 ? (x.gas_rate * 1e6 + x.tank_gas * 1e3) / x.oil_rate : null; } }
};
function tankGas(source, station) {
    if (source === 'modbus') {
        var x = station && typeof station.getVar === 'function' ? station.getVar('tank_gas') : null;
        if (!x) return { v: null, q: 'unmapped', src: 'not linked' };
        var q = x.q === 'init' ? 'stale' : x.q;
        return { v: x.q === 'bad' || x.q === 'init' || !isNum(x.value) ? null : x.value, q: q, src: (x.tag || 'tank_gas') + (x.err ? ' — ' + x.err : '') };
    }
    var lp = G.WTS_state && G.WTS_state.flow && G.WTS_state.flow.lp;
    if (!lp || typeof lp !== 'object' || !isNum(lp.flash_mscfd)) return { v: null, q: 'unmapped', src: 'not in the form model' };
    return { v: lp.flash_mscfd, q: 'good', src: 'simulator page (LP flare line, PVT est.)' };
}

// derived values (GOR, water cut): GOR scf/STB → sm³/sm³ in Metric (WTS_units 'gor'); water cut stays %
function dispDerived(v, D) {
    if (!isNum(v)) return { v: '—', u: D.unit };
    var U = G.WTS_units;
    if (D.cat && U && typeof U.getSystem === 'function' && U.getSystem() === 'metric' && typeof U.format === 'function') {
        try { var f = U.format(v, D.cat); if (f && isNum(+f.value)) return { v: fmtNumber(+f.value, Math.abs(+f.value) >= 100 ? 0 : 1), u: f.label }; } catch (e) {}
    }
    return { v: fmtNumber(v, D.dp != null ? D.dp : 1), u: D.unit };
}
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
        '.wos .kpi-v{font-family:"Courier New",monospace;font-size:20px;font-weight:700;color:var(--text)}.wos .kpi-u{font-size:11px;color:var(--text2);margin-left:1px}',
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
        '<div style="font-size:12px;color:var(--text2);margin-top:8px"><div><b>Notes</b> Form data runs the Well Test Simulator model from the simulator page inputs (or the sample well). Modbus data shows the tags linked on the Modbus page, converted to field units; quality: good = fresh, stale = no update for 3 poll intervals, bad = comms error / exception / unit mismatch, — = not linked. In Modbus mode the 3D and 2D views keep the last form snapshot for anything not linked. GOR (sep) = gas rate ÷ oil rate; tank gas = the surge-tank gas on the LP flare line (FT-201) from the simulator page (form data) or a linked tank_gas tag; total GOR = (gas + tank gas) ÷ oil rate; water cut = water ÷ (water + oil) rate, both from the rates shown. Representative equipment; not a safety system.</div></div>' +
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
            var D = DERIVED[k];
            if (D.ext) { var e = D.ext(u.source, station); vals[k] = e.v; qual[k] = e.q; src[k] = e.src; if (vals[k] == null && qual[k] === 'good') qual[k] = 'unmapped'; return; }
            vals[k] = D.calc(vals);
            var deps = D.deps.map(function (d) { return qual[d]; });
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
        // tag = the variable key (kept for historian continuity); desc = what it is (e.g. pump_running = LCV-201 open)
        M.VARS.forEach(function (V) { var x = fv[V.key]; if (x == null) return; batch.push({ tag: V.key, device: 'form', t: t, v: x, q: 'good', raw: null, unit: unitLabel(V), desc: V.label + ' — Mini WellOS form data' }); });
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
            var V = M.VAR_BY_KEY[key], D = DERIVED[key], d = D ? dispDerived(cur.vals[key], D) : disp(cur.vals[key], V);
            var lbl = D ? D.label : V.label.replace(/ \(.*\)$/, '');
            // a real space between value and unit (the text reads "10,012 scf/STB", not "10,012scf/STB")
            return '<div class="kpi q-' + esc(cur.q[key]) + '" title="' + esc(cur.src[key] || '') + '"><div class="kpi-l">' + esc(lbl) + '</div><div class="kpi-v">' + esc(d.v) + (d.u ? ' <span class="kpi-u">' + esc(d.u) + '</span>' : '') + '</div></div>';
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
        // surge → gauge transfer: LCV-201, driven by the surge tank pressure (no pump; the pump_running variable is
        // the transfer state, snapshot surge.pump.on). P-201 sits downstream of the gauge tank.
        var pr = v.pump_running, px = 610, py = 120, pc = pr == null ? '#6e7681' : pr ? '#3fb950' : '#8b949e';
        ctx.fillStyle = pc; ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px - 18, py - 12); ctx.lineTo(px, py); ctx.lineTo(px - 18, py + 12); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px + 18, py - 12); ctx.lineTo(px, py); ctx.lineTo(px + 18, py + 12); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 20); ctx.stroke(); ctx.beginPath(); ctx.arc(px, py - 24, 7, Math.PI, 0); ctx.closePath(); ctx.stroke();
        ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('LCV-201', px - 24, py + 30);
        ctx.font = '10px sans-serif'; ctx.fillText(pr == null ? '—' : pr ? 'OPEN' : 'SHUT', px - 12, py + 44);
        // P-201 gauge tank pump (T-301 → export / burner): circle + discharge triangle, green when running
        var gr = v.p201_running, gx = 945, gy = 110, gc = gr == null ? '#6e7681' : gr ? '#3fb950' : '#8b949e';
        ctx.fillStyle = gc; ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(gx, gy, 11, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(gx - 5, gy - 6); ctx.lineTo(gx + 7, gy); ctx.lineTo(gx - 5, gy + 6); ctx.closePath(); ctx.fillStyle = '#0b111a'; ctx.fill();
        ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('P-201', gx - 16, gy + 26);
        ctx.font = '10px sans-serif'; ctx.fillText(gr == null ? (Q.p201_running === 'unmapped' ? 'not linked' : '—') : gr ? 'RUNNING' : 'STOPPED', gx - 20, gy + 38);
        // status column
        var sx = 1000, lines = [
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
            case 'demo': {
                // the banner shows when no tag is linked, but devices / tags may exist: never replace them silently
                var cur0 = M.getConfig();
                if ((cur0.devices.length || cur0.tags.length) && typeof G.confirm === 'function' &&
                    !G.confirm('Replace the current Modbus configuration (' + cur0.devices.length + ' device(s), ' + cur0.tags.length + ' tag(s)) with the simulator demo?')) break;
                M.saveConfig(M.demoConfig()); if (!M.station()) M.acquire(OWNER); bindStation(); renderBanner(); renderHead(); break;
            }
            case 'ack': { var A = alarmsMgr(); if (A) A.ack(b.getAttribute('data-id')); renderAlarms(true); break; }
            case 'ackall': { var A2 = alarmsMgr(); if (A2) A2.ackAll(); renderAlarms(true); break; }
            case 'toalarms': { var c = q('#wos_alcard'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
            case 'win': u.win = +b.getAttribute('data-win') || 1800; writeUi(u); root.querySelectorAll('[data-act="win"]').forEach(function (x) { var on = +x.getAttribute('data-win') === u.win; x.style.borderColor = on ? 'var(--accent)' : ''; x.style.color = on ? 'var(--accent)' : ''; }); drawTrends(); break;
            case 'logstart': logger.on = true; logger.cols = logCols(); logger.rows = []; logger.note = ''; logRow(); renderLog(); break;
            case 'logstop': logger.on = false; renderLog(); break;
            case 'logclear': {
                var had = logger.rows.length;
                logger.rows = []; logger.note = had ? 'Cleared ' + had + ' row(s).' : 'Log already empty — nothing to clear.';
                if (!logger.on) logger.cols = null; renderLog(); break;
            }
            case 'logcsv': if (!logger.rows.length) { logger.note = 'No rows logged yet — start logging first.'; renderLog(); break; }
                if (M.download) M.download('wellos-log-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv', csvText(), 'text/csv'); break;
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
M.wellos = { controller: function () { return ctl; }, DERIVED: DERIVED, disp: disp, dispDerived: dispDerived, UI_KEY: UI_KEY };

G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.wellos = {
    key: 'wellos', title: 'Mini WellOS', navTitle: 'Mini WellOS',
    sub: 'Live SCADA view of the well-test spread — form data or live Modbus tags',
    group: 'Live Data', icon: '&#9673;', badge: 'Live Data', bc: 'dc-b-blue',
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
    version: "1.2.2",
    order: ["modbus-bridge.js","fake-slave.js","install-windows.ps1","install.sh","README.md"],
    sha256: {
        "modbus-bridge.js": "f5aba8bed0777e0d359e98542f06a3bb026df0b95948d513b84f6b659b53bf24",
        "fake-slave.js": "b1c49f245411df9695e5e21cb699e2ba10639853aa84bbda0a6ec0c02163a82e",
        "install-windows.ps1": "43fd61032e176d0593e00902b9d9f7e9a9d690d8e8af0d9254e167bd2f3e64f6",
        "install.sh": "a7617e3da55741e16bc57c6464a4e842159d2da9daabac4fa9326971a5afa2fd",
        "README.md": "5b4cd1ccec6a4995b63f701e5972e04c1d9d97b2dba6dfe6f2ab8995bfd93021"
    },
    files: {
        "modbus-bridge.js": "#!/usr/bin/env node\n// =============================================================================\n// modbus-bridge.js — WebSocket ↔ Modbus TCP bridge for the Well Testing Suite\n// (Mini WellOS / Modbus page). Zero dependencies, Node.js ≥ 18.\n//\n//   browser ──ws://127.0.0.1:8502/modbus?host=10.0.0.5&port=502──► bridge ──TCP──► PLC / RTU / gateway\n//\n// Protocol\n//   • The page opens one WebSocket per device with ?host=&port= query parameters.\n//   • The bridge checks the Origin header and the host:port against its allow-lists,\n//     opens the TCP connection, then sends the text frame {\"type\":\"open\"}.\n//     Failures: {\"type\":\"error\",\"message\":\"…\"} then close (1008 policy / 1011 error).\n//   • Binary frames = complete Modbus TCP ADUs (MBAP header + PDU) in both directions.\n//     The bridge re-frames the TCP byte stream into whole ADUs using the MBAP length.\n//   • Read-only by default: a request with function code 05 / 06 / 15 / 16 (or any code\n//     outside 01-06, 15, 16) is answered by the bridge itself with Modbus exception 01\n//     (Illegal function) and never reaches the device, unless --allow-writes is given.\n//   • GET /health → {\"name\",\"version\",\"readOnly\",\"port\",\"uptimeS\",\"allow\":[…]} for the app's\n//     \"Check bridge\" button. CORS headers only for accepted page origins (same rules as the\n//     WebSocket upgrade); the preflight answers Access-Control-Allow-Private-Network: true\n//     (Chrome Private Network Access). A refused request gets 403 {\"error\":\"origin\"|\"host\"}\n//     (with Access-Control-Allow-Origin echoed, so the page can tell a refusal from \"no\n//     bridge\"; nothing else is in that body). Host names other than localhost / an IP literal /\n//     --listen are refused (DNS rebinding) unless the request carries an accepted Origin.\n//   • GET / → a small HTML status page for people (version, allowed devices, read-only state,\n//     how to uninstall); same Origin / Host rules as /health, no scripts.\n//\n// Security defaults: listens on 127.0.0.1 only; any device IP / port is reachable unless you\n// restrict it with --allow targets (v1.2.0; before, nothing was reachable until allowed); browser origins limited to http(s)://localhost / 127.0.0.1 / [::1], the app's\n// capacitor origin and the app's web origin (welltest.h2oil.co.uk) unless --origin or --any-origin\n// is given. \"Origin: null\" (sandboxed iframes, data: URLs, saved file:// copies) is refused\n// unless allowed explicitly with --origin null, because any web site can send it. Requests\n// without an Origin header (curl, scripts; never a browser page) are accepted. ADU ≤ 260 bytes.\n//\n// Usage:  node modbus-bridge.js                (any device)\n//         node modbus-bridge.js --allow 192.168.1.10:502 [--allow 10.0.0.0/24:502] [--allow 'host:*'] [--allow-any]\n//                               [--listen 127.0.0.1] [--port 8502] [--origin https://example.com]\n//                               [--any-origin] [--allow-writes] [--verbose]\n//                               [--config bridge-config.json] [--version] [--help]\n//         (quote targets with * or [ ] — zsh refuses an unmatched glob; IPv6: '[fd00::10]:502';\n//          --origin null accepts a saved file:// copy of the app)\n// --config file.json: {\"allow\":[\"192.168.1.10:502\"], \"port\":8502, \"listen\":\"127.0.0.1\",\n//   \"origins\":[], \"anyOrigin\":false, \"allowWrites\":false, \"verbose\":false} (all keys optional;\n//   keys starting with \"_\" are comments). \"allowMode\": \"any\" | \"list\" is written next to \"allow\" by\n//   the v1.2.1+ installers (the bridge itself only reads \"allow\": an empty list = any device); a file\n//   without it comes from an older installer, whose allow list a re-install replaces by any device\n//   unless --keep-allow (-KeepAllow) or an explicit --allow is given. Command-line flags override the file's port / listen\n//   and add to its allow / origins lists; --allow-writes, --any-origin, --verbose switch those on.\n// RFC 6455 (WebSocket) framing; MODBUS Messaging on TCP/IP Implementation Guide V1.0b (MBAP).\n// =============================================================================\n'use strict';\n\nconst http = require('http');\nconst net = require('net');\nconst crypto = require('crypto');\nconst fs = require('fs');\n\nconst BRIDGE_VERSION = '1.2.2';\nconst BRIDGE_NAME = 'wts-modbus-bridge';\nconst WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';     // RFC 6455 §1.3\nconst MAX_ADU = 260;\nconst READ_FCS = new Set([1, 2, 3, 4]);\nconst WRITE_FCS = new Set([5, 6, 15, 16]);\n// \"null\" and file:// are deliberately NOT here: any web page can send \"Origin: null\" (a\n// sandboxed iframe or a data: URL), so a saved copy of the app needs --origin null.\nconst DEFAULT_ORIGINS = [/^https?:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?$/i, /^https:\\/\\/welltest\\.h2oil\\.co\\.uk$/i,\n  /^capacitor:\\/\\/localhost$/i];\n\n// ─── allow-list ──────────────────────────────────────────────────────────────\n// entry: \"host:port\" | \"host:*\" | \"a.b.c.d/nn:port\" (IPv4 CIDR) | \"*:port\" | \"*:*\" (any device).\n// An empty allow-list means \"*:*\" — any device IP / port (the default since v1.2.0). List\n// specific targets to lock the bridge down to them.\nfunction parseAllow(spec) {\n  const s = String(spec).trim();\n  const i = s.lastIndexOf(':');\n  if (i \u003c= 0) throw new Error('--allow needs host:port, got ' + spec);\n  const host = s.slice(0, i).replace(/^\\[|\\]$/g, ''), port = s.slice(i + 1);\n  if (host === '*') {\n    if (port !== '*' && !(/^\\d{1,5}$/.test(port) && +port \u003e= 1 && +port \u003c= 65535)) throw new Error('bad port in --allow ' + spec);\n    const p = port === '*' ? '*' : +port;\n    return { host: '*', port: p, cidr: null, spec: '*:' + p };\n  }\n  if (port !== '*' && !(/^\\d{1,5}$/.test(port) && +port \u003e= 1 && +port \u003c= 65535)) throw new Error('bad port in --allow ' + spec);\n  if (!/^[A-Za-z0-9._-]+(\\/\\d{1,2})?$/.test(host) && !/^[0-9A-Fa-f:.]+$/.test(host)) throw new Error('bad host in --allow ' + spec + ' (IPv4, IPv4/nn, IPv6 or a host name)');\n  const m = /^(\\d+\\.\\d+\\.\\d+\\.\\d+)\\/(\\d+)$/.exec(host);\n  if (m && (ip4(m[1]) == null || !(+m[2] \u003e= 0 && +m[2] \u003c= 32))) throw new Error('bad IPv4 subnet in --allow ' + spec);\n  const h = host.toLowerCase(), p = port === '*' ? '*' : +port;\n  return { host: h, port: p, cidr: m ? { base: ip4(m[1]), bits: +m[2] } : null, spec: (h.indexOf(':') \u003e= 0 ? '[' + h + ']' : h) + ':' + p };\n}\nfunction ip4(s) { const p = s.split('.').map(Number); if (p.length !== 4 || p.some((x) =\u003e !(x \u003e= 0 && x \u003c= 255))) return null; return ((p[0] \u003c\u003c 24) | (p[1] \u003c\u003c 16) | (p[2] \u003c\u003c 8) | p[3]) \u003e\u003e\u003e 0; }\nfunction allowed(list, host, port) {\n  host = String(host || '').toLowerCase(); port = +port;\n  return list.some((a) =\u003e {\n    if (a.port !== '*' && a.port !== port) return false;\n    if (a.host === '*') return true;\n    if (a.cidr) {\n      const ip = ip4(host); if (ip == null || a.cidr.base == null) return false;\n      const mask = a.cidr.bits === 0 ? 0 : (0xFFFFFFFF \u003c\u003c (32 - a.cidr.bits)) \u003e\u003e\u003e 0;\n      return (ip & mask) === (a.cidr.base & mask);\n    }\n    return a.host === host;\n  });\n}\n// origin = the Origin request header. undefined (no header) = not a browser page (curl, a\n// script, Node's WebSocket): accepted. \"null\" only with --origin null / --any-origin.\nfunction originOk(opts, origin) {\n  if (origin === undefined) return true;\n  if (opts.anyOrigin) return true;\n  const o = String(origin);\n  if ((opts.origins || []).some((x) =\u003e String(x).toLowerCase() === o.toLowerCase())) return true;\n  return DEFAULT_ORIGINS.some((re) =\u003e re.test(o));\n}\n// /health answers only requests addressed to localhost, an IP literal or the --listen name,\n// so a web page cannot read it through a DNS-rebound host name (such a page sends no Origin on\n// its same-origin GET, or its own origin, which is refused).\nfunction hostHeaderOk(opts, hostHeader) {\n  if (hostHeader == null || hostHeader === '') return true;          // HTTP/1.0 client\n  let h = String(hostHeader).trim().toLowerCase();\n  if (h[0] === '[') { const j = h.indexOf(']'); return j \u003e 0 && h.slice(1, j).indexOf(':') \u003e= 0; }   // IPv6 literal\n  const j = h.lastIndexOf(':'); if (j \u003e= 0) h = h.slice(0, j);\n  if (h === 'localhost' || /\\.localhost$/.test(h)) return true;\n  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(h) && ip4(h) != null) return true;\n  return !!(opts && opts.listen && h === String(opts.listen).toLowerCase());\n}\n// Why a /health request is refused: 'origin', 'host' or null (accepted). A request with an\n// accepted, non-null Origin may use any Host name (e.g. ws://bridge-pc.local:8502 from the\n// app): a DNS-rebinding page cannot send such an Origin.\nfunction healthRefusal(opts, origin, hostHeader) {\n  if (!originOk(opts, origin)) return 'origin';\n  if (hostHeaderOk(opts, hostHeader)) return null;\n  return origin !== undefined && String(origin) !== 'null' ? null : 'host';\n}\n// \"localhost\" can resolve to ::1 first (macOS, Windows; Node ≥ 17 keeps the resolver order),\n// while the installers and the app use 127.0.0.1 — so listen on 127.0.0.1.\nfunction normListen(listen) { return typeof listen === 'string' && listen.toLowerCase() === 'localhost' ? '127.0.0.1' : listen; }\n\n// ─── status page (GET /) ─────────────────────────────────────────────────────\nfunction htmlEsc(s) { return String(s == null ? '' : s).replace(/[&\u003c\u003e\"']/g, (c) =\u003e ({ '&': '&amp;', '\u003c': '&lt;', '\u003e': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c])); }\nfunction uptimeText(s) {\n  s = Math.max(0, Math.round(+s || 0));\n  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);\n  return d ? d + ' d ' + h + ' h' : h ? h + ' h ' + m + ' min' : m ? m + ' min' : s + ' s';\n}\nconst DEFAULT_UNINSTALL = [\n  'Windows (installed with WTS-Modbus-Bridge-Setup.exe): Settings → Apps → Installed apps → \"WTS Modbus Bridge\" → Uninstall, or Start menu → \"Uninstall WTS Modbus Bridge\".',\n  'Windows (installed with install-windows.ps1): powershell -NoProfile -ExecutionPolicy Bypass -File \"%LOCALAPPDATA%\\\\WTS Modbus Bridge\\\\install-windows.ps1\" -Uninstall',\n  'macOS: bash \"$HOME/Library/Application Support/WTS Modbus Bridge/install.sh\" --uninstall',\n  'Linux: bash \"${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh\" --uninstall'];\n// info = the /health object; o = { listen, configFile, uninstall: string | [strings] }\nfunction statusPageHtml(info, o) {\n  info = info || {}; o = o || {};\n  const allow = Array.isArray(info.allow) ? info.allow.map(String) : [];\n  const any = !allow.length || allow.some((a) =\u003e /^\\*:\\*$/.test(a.trim()));\n  const host = !o.listen || o.listen === '0.0.0.0' ? '127.0.0.1' : String(o.listen);\n  const url = 'ws://' + (host.indexOf(':') \u003e= 0 ? '[' + host + ']' : host) + ':' + info.port;\n  const uninstall = o.uninstall ? [].concat(o.uninstall) : DEFAULT_UNINSTALL;\n  const row = (k, v) =\u003e '\u003ctr\u003e\u003cth\u003e' + htmlEsc(k) + '\u003c/th\u003e\u003ctd\u003e' + v + '\u003c/td\u003e\u003c/tr\u003e';\n  return '\u003c!doctype html\u003e\\n\u003chtml lang=\"en\"\u003e\u003chead\u003e\u003cmeta charset=\"utf-8\"\u003e\u003cmeta name=\"viewport\" content=\"width=device-width, initial-scale=1\"\u003e' +\n    '\u003cmeta name=\"color-scheme\" content=\"light dark\"\u003e\u003ctitle\u003eWTS Modbus Bridge — running\u003c/title\u003e\u003cstyle\u003e' +\n    'body{font:15px/1.5 system-ui,-apple-system,\"Segoe UI\",sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1f2328;background:#fff}' +\n    '@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}th{color:#9198a1!important}code{background:#161b22!important}}' +\n    'h1{font-size:22px;color:#1a7f37;margin:0 0 8px}p{margin:8px 0}table{border-collapse:collapse;margin:12px 0;width:100%}' +\n    'th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.25)}th{width:34%;font-weight:600;color:#59636e}' +\n    'code{font:13px ui-monospace,Consolas,monospace;background:#f6f8fa;padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}' +\n    '.next{border-left:4px solid #1a7f37;padding:8px 12px;margin:14px 0;background:rgba(26,127,55,.08)}ul{padding-left:20px}li{margin:4px 0}small{color:#8b949e}' +\n    '\u003c/style\u003e\u003c/head\u003e\u003cbody\u003e' +\n    '\u003ch1\u003e✓ WTS Modbus Bridge v' + htmlEsc(info.version) + ' is running on this PC\u003c/h1\u003e' +\n    '\u003cdiv class=\"next\"\u003e\u003cb\u003eNext:\u003c/b\u003e go back to the Well Testing Suite (Modbus Config page) and press \u003cb\u003eCheck bridge\u003c/b\u003e. ' +\n    'Devices use the transport \"Modbus TCP via WebSocket bridge\" with the bridge URL \u003ccode\u003e' + htmlEsc(url) + '\u003c/code\u003e.\u003c/div\u003e' +\n    '\u003ctable\u003e' +\n    row('Bridge URL', '\u003ccode\u003e' + htmlEsc(url) + '\u003c/code\u003e' + (host === '127.0.0.1' || host === '::1' ? ' (this computer only)' : ' (other computers on the network can use it)')) +\n    row('Allowed devices', any ? 'Any device IP address / port' + (allow.length \u003e 1 ? ' (' + htmlEsc(allow.join(', ')) + ')' : '') : htmlEsc(allow.join(', '))) +\n    row('Modbus writes', info.readOnly === false ? '\u003cb\u003eAllowed\u003c/b\u003e (FC 05 / 06 / 15 / 16 are forwarded)' : 'Refused — read-only (the bridge answers write requests with exception 01)') +\n    row('Running for', htmlEsc(uptimeText(info.uptimeS))) +\n    (o.configFile ? row('Settings', '\u003ccode\u003e' + htmlEsc(o.configFile) + '\u003c/code\u003e (restart the bridge after editing)') : '') +\n    row('Health check', '\u003ccode\u003ehttp://' + htmlEsc(host.indexOf(':') \u003e= 0 ? '[' + host + ']' : host) + ':' + htmlEsc(info.port) + '/health\u003c/code\u003e') +\n    '\u003c/table\u003e' +\n    '\u003cp\u003e\u003cb\u003eUninstall\u003c/b\u003e\u003c/p\u003e\u003cul\u003e' + uninstall.map((u) =\u003e '\u003cli\u003e' + htmlEsc(u) + '\u003c/li\u003e').join('') + '\u003c/ul\u003e' +\n    '\u003cp\u003e\u003csmall\u003e' + htmlEsc(info.name) + ' — WebSocket ↔ Modbus TCP bridge for the Well Testing Suite. This page refreshes when you reload it.\u003c/small\u003e\u003c/p\u003e' +\n    '\u003c/body\u003e\u003c/html\u003e\\n';\n}\n\n// ─── WebSocket framing (server side, RFC 6455 §5) ────────────────────────────\nfunction encodeFrame(opcode, payload) {\n  const len = payload.length;\n  let head;\n  if (len \u003c 126) head = Buffer.from([0x80 | opcode, len]);\n  else if (len \u003c 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }\n  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }\n  return Buffer.concat([head, payload]);\n}\n// Parses as many complete frames as possible. Returns { frames:[{fin, opcode, payload}], rest, error }\nfunction decodeFrames(buf, maxPayload) {\n  const frames = [];\n  let off = 0;\n  while (buf.length - off \u003e= 2) {\n    const b0 = buf[off], b1 = buf[off + 1];\n    const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);\n    let len = b1 & 0x7f, p = off + 2;\n    if (b0 & 0x70) return { frames, rest: Buffer.alloc(0), error: [1002, 'reserved bits set'] };\n    if (!masked) return { frames, rest: Buffer.alloc(0), error: [1002, 'client frames must be masked'] };\n    if (len === 126) { if (buf.length - p \u003c 2) break; len = buf.readUInt16BE(p); p += 2; }\n    else if (len === 127) { if (buf.length - p \u003c 8) break; const big = buf.readBigUInt64BE(p); if (big \u003e BigInt(maxPayload)) return { frames, rest: Buffer.alloc(0), error: [1009, 'message too big'] }; len = Number(big); p += 8; }\n    if (len \u003e maxPayload) return { frames, rest: Buffer.alloc(0), error: [1009, 'message too big'] };\n    if (buf.length - p \u003c 4 + len) break;\n    const mask = buf.slice(p, p + 4); p += 4;\n    const payload = Buffer.alloc(len);\n    for (let i = 0; i \u003c len; i++) payload[i] = buf[p + i] ^ mask[i & 3];\n    frames.push({ fin, opcode, payload });\n    off = p + len;\n  }\n  return { frames, rest: buf.slice(off) };\n}\nfunction closePayload(code, reason) { const r = Buffer.from(String(reason || '').slice(0, 100)); const b = Buffer.alloc(2 + r.length); b.writeUInt16BE(code, 0); r.copy(b, 2); return b; }\n\n// ─── Modbus TCP stream re-framing ─────────────────────────────────────────────\nfunction takeAdus(buf) {\n  const out = [];\n  let off = 0;\n  while (buf.length - off \u003e= 7) {\n    const proto = buf.readUInt16BE(off + 2), len = buf.readUInt16BE(off + 4);\n    if (proto !== 0 || len \u003c 2 || len \u003e 254) return { adus: out, rest: Buffer.alloc(0), error: 'bad MBAP header from device' };\n    if (buf.length - off \u003c 6 + len) break;\n    out.push(buf.slice(off, off + 6 + len)); off += 6 + len;\n  }\n  return { adus: out, rest: buf.slice(off) };\n}\nfunction exceptionAdu(req, code) {\n  const out = Buffer.alloc(9);\n  req.copy(out, 0, 0, 4);                 // transaction id + protocol id\n  out.writeUInt16BE(3, 4); out[6] = req[6]; out[7] = (req[7] | 0x80) & 0xff; out[8] = code;\n  return out;\n}\n\n// ─── bridge ──────────────────────────────────────────────────────────────────\nfunction createBridge(opts) {\n  opts = Object.assign({ listen: '127.0.0.1', port: 8502, allow: [], origins: [], anyOrigin: false, allowWrites: false, verbose: false, connectTimeoutMs: 5000 }, opts || {});\n  opts.listen = normListen(opts.listen) || '127.0.0.1';\n  const allowList = (opts.allow && opts.allow.length ? opts.allow : ['*:*']).map((a) =\u003e (typeof a === 'string' ? parseAllow(a) : a));\n  const log = (...a) =\u003e { if (opts.verbose) console.log('[bridge]', ...a); };\n  const sessions = new Set(), upgraded = new Set();\n  const stats = { sessions: 0, refused: 0, adusIn: 0, adusOut: 0, writesBlocked: 0 };\n\n  const startedAt = Date.now();\n  const server = http.createServer((req, res) =\u003e {\n    let pathname = '/';\n    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* keep '/' */ }\n    if (pathname === '/health' || pathname === '/health/') { health(req, res); return; }\n    if (pathname === '/' || pathname === '/status' || pathname === '/index.html') { statusPage(req, res); return; }\n    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });\n    res.end('WTS Modbus bridge v' + BRIDGE_VERSION + ' ' + (opts.allowWrites ? '(writes ALLOWED)' : '(read-only)') + '\\nConnect with ws://' + opts.listen + ':' + (server.address() || {}).port + '/modbus?host=\u003cip\u003e&port=502\\nHealth check: /health\\n');\n  });\n  function healthInfo() {\n    return { name: BRIDGE_NAME, version: BRIDGE_VERSION, readOnly: !opts.allowWrites, port: (server.address() || {}).port || opts.port,\n      uptimeS: Math.round((Date.now() - startedAt) / 1000), allow: allowList.map((a) =\u003e a.spec || (a.host + ':' + a.port)) };\n  }\n  // GET /health (+ CORS preflight). Accepted origins get CORS headers; a request without an\n  // Origin header (curl, the installers) gets the JSON without them. A refused request gets\n  // 403 {\"error\":\"origin\"|\"host\"} — with Access-Control-Allow-Origin echoed so the app can show\n  // why (a browser turns a 403 without it into \"network error\" = \"is the bridge running?\").\n  // The refusal carries no version / allow-list, and a refused preflight is never approved\n  // (no Access-Control-Allow-Private-Network).\n  function health(req, res) {\n    const origin = req.headers.origin;\n    const why = healthRefusal(opts, origin, req.headers.host);\n    if (why) {\n      stats.refused++; log('health refused:', why, why === 'host' ? req.headers.host : origin);\n      const body = JSON.stringify({ error: why });\n      const h403 = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin', 'Content-Length': Buffer.byteLength(body) };\n      if (origin !== undefined) h403['Access-Control-Allow-Origin'] = String(origin);\n      res.writeHead(403, h403);\n      res.end(req.method === 'HEAD' ? undefined : body);\n      return;\n    }\n    const head = { 'Cache-Control': 'no-store', Vary: 'Origin' };\n    if (origin !== undefined) head['Access-Control-Allow-Origin'] = String(origin);\n    if (req.method === 'OPTIONS') {\n      Object.assign(head, { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',\n        'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600', 'Content-Length': '0' });\n      res.writeHead(204, head); res.end(); return;\n    }\n    if (req.method !== 'GET' && req.method !== 'HEAD') { head.Allow = 'GET, OPTIONS'; res.writeHead(405, head); res.end(); return; }\n    const body = JSON.stringify(healthInfo());\n    head['Content-Type'] = 'application/json; charset=utf-8';\n    head['Content-Length'] = Buffer.byteLength(body);\n    res.writeHead(200, head);\n    res.end(req.method === 'HEAD' ? undefined : body);\n  }\n  // GET / → a small HTML status page for people (the Windows installer opens it in the browser).\n  // Same Origin / Host rules as /health; no scripts (CSP), everything escaped.\n  function statusPage(req, res) {\n    const why = healthRefusal(opts, req.headers.origin, req.headers.host);\n    const head = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };\n    if (why) { head['Content-Type'] = 'text/plain; charset=utf-8'; res.writeHead(403, head); res.end('Forbidden (' + why + ')\\n'); stats.refused++; return; }\n    if (req.method !== 'GET' && req.method !== 'HEAD') { head.Allow = 'GET'; res.writeHead(405, head); res.end(); return; }\n    const body = statusPageHtml(healthInfo(), { listen: opts.listen, configFile: opts.configFile, uninstall: opts.uninstallHint });\n    head['Content-Type'] = 'text/html; charset=utf-8';\n    head['Content-Security-Policy'] = \"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\";\n    head['Content-Length'] = Buffer.byteLength(body);\n    res.writeHead(200, head);\n    res.end(req.method === 'HEAD' ? undefined : body);\n  }\n\n  server.on('upgrade', (req, socket) =\u003e {\n    const fail = (code, text) =\u003e { try { socket.write('HTTP/1.1 ' + code + ' ' + text + '\\r\\nConnection: close\\r\\n\\r\\n'); } catch (e) {} socket.destroy(); stats.refused++; };\n    let url;\n    try { url = new URL(req.url, 'http://x'); } catch (e) { fail(400, 'Bad Request'); return; }\n    const key = req.headers['sec-websocket-key'];\n    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') { fail(400, 'Bad Request'); return; }\n    if (!originOk(opts, req.headers.origin)) { log('origin refused', req.headers.origin); fail(403, 'Forbidden'); return; }\n    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');\n    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');\n    socket.setNoDelay(true);\n    upgraded.add(socket); socket.on('close', () =\u003e upgraded.delete(socket));\n    const host = url.searchParams.get('host') || '', port = +(url.searchParams.get('port') || 502);\n    startSession(socket, host, port);\n  });\n\n  function startSession(ws, host, port) {\n    const S = { ws, tcp: null, open: false, closed: false, wsBuf: Buffer.alloc(0), tcpBuf: Buffer.alloc(0) };\n    sessions.add(S); stats.sessions++;\n    const sendText = (o) =\u003e { if (!S.closed) ws.write(encodeFrame(0x1, Buffer.from(JSON.stringify(o)))); };\n    const sendBin = (b) =\u003e { if (!S.closed) ws.write(encodeFrame(0x2, b)); };\n    function close(code, reason) {\n      if (S.closed) return;\n      try { ws.write(encodeFrame(0x8, closePayload(code, reason))); } catch (e) {}\n      S.closed = true; sessions.delete(S);\n      try { ws.end(); } catch (e) {}\n      const kill = setTimeout(() =\u003e { try { ws.destroy(); } catch (e) {} }, 2000);   // peer did not finish the close handshake\n      if (kill.unref) kill.unref();\n      if (S.tcp) { try { S.tcp.destroy(); } catch (e) {} }\n      log('session closed', code, reason || '');\n    }\n    S.close = close;\n    if (!host || !(port \u003e= 1 && port \u003c= 65535) || !allowed(allowList, host, port)) {\n      stats.refused++;\n      sendText({ type: 'error', message: 'target ' + host + ':' + port + ' is not in the bridge allow-list (this bridge is restricted to a list of devices: run its installer again for any device, or set \"allow\": [] in bridge-config.json — or add --allow ' + (host || '\u003cip\u003e') + ':' + (port || 502) + ' — and restart the bridge)' });\n      close(1008, 'target not allowed');\n      return;\n    }\n    const tcp = net.createConnection({ host, port });\n    S.tcp = tcp;\n    tcp.setNoDelay(true);\n    tcp.setTimeout(opts.connectTimeoutMs, () =\u003e { if (!S.open) { sendText({ type: 'error', message: 'connect to ' + host + ':' + port + ' timed out' }); close(1011, 'connect timeout'); } });\n    tcp.on('connect', () =\u003e { S.open = true; tcp.setTimeout(0); log('connected', host + ':' + port); sendText({ type: 'open', host, port, writes: !!opts.allowWrites }); });\n    tcp.on('data', (d) =\u003e {\n      S.tcpBuf = Buffer.concat([S.tcpBuf, d]);\n      const r = takeAdus(S.tcpBuf);\n      S.tcpBuf = r.rest;\n      r.adus.forEach((a) =\u003e { stats.adusOut++; sendBin(a); });\n      if (r.error) { sendText({ type: 'error', message: r.error }); close(1011, r.error); }\n    });\n    tcp.on('error', (e) =\u003e { sendText({ type: 'error', message: 'TCP ' + host + ':' + port + ': ' + e.message }); close(1011, 'tcp error'); });\n    tcp.on('close', () =\u003e close(1000, 'device closed the connection'));\n    ws.on('data', (d) =\u003e {\n      S.wsBuf = Buffer.concat([S.wsBuf, d]);\n      const r = decodeFrames(S.wsBuf, MAX_ADU);\n      S.wsBuf = r.rest;\n      for (const f of r.frames) {\n        if (f.opcode === 0x8) { close(1000, 'client close'); return; }\n        if (f.opcode === 0x9) { ws.write(encodeFrame(0xA, f.payload)); continue; }\n        if (f.opcode === 0xA) continue;\n        if (!f.fin || f.opcode === 0x0) { close(1003, 'fragmented messages are not supported'); return; }\n        if (f.opcode !== 0x2) continue;                // text from the client is ignored\n        onAdu(f.payload);\n      }\n      if (r.error) close(r.error[0], r.error[1]);\n    });\n    ws.on('error', () =\u003e close(1011, 'socket error'));\n    ws.on('end', () =\u003e close(1000, 'client ended'));            // upgraded sockets are half-open capable\n    ws.on('close', () =\u003e { S.closed = true; sessions.delete(S); if (S.tcp) S.tcp.destroy(); });\n    function onAdu(a) {\n      if (a.length \u003c 8 || a.length \u003e MAX_ADU || a.readUInt16BE(2) !== 0 || a.readUInt16BE(4) !== a.length - 6) { sendText({ type: 'error', message: 'malformed Modbus TCP ADU' }); return; }\n      const fc = a[7];\n      if (!READ_FCS.has(fc) && !(WRITE_FCS.has(fc) && opts.allowWrites)) {\n        if (WRITE_FCS.has(fc)) stats.writesBlocked++;\n        log('blocked FC' + fc);\n        sendBin(exceptionAdu(a, 1));\n        return;\n      }\n      if (!S.open) { sendText({ type: 'error', message: 'device connection is not open yet' }); return; }\n      stats.adusIn++;\n      S.tcp.write(a);\n    }\n  }\n\n  return {\n    server, stats, sessions, health: healthInfo,\n    listen() { return new Promise((resolve, reject) =\u003e { server.once('error', reject); server.listen(opts.port, opts.listen, () =\u003e { server.off('error', reject); resolve(server.address().port); }); }); },\n    close() {\n      sessions.forEach((s) =\u003e s.close(1001, 'bridge shutting down'));\n      const p = new Promise((r) =\u003e server.close(() =\u003e r()));\n      upgraded.forEach((sock) =\u003e sock.destroy());\n      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();   // idle keep-alive HTTP sockets\n      return p;\n    },\n  };\n}\n\n// ─── CLI ─────────────────────────────────────────────────────────────────────\nfunction parseArgs(argv) {\n  const o = { allow: [], origins: [] };\n  for (let i = 0; i \u003c argv.length; i++) {\n    const a = argv[i], v = () =\u003e { if (i + 1 \u003e= argv.length) throw new Error(a + ' needs a value'); return argv[++i]; };\n    if (a === '--allow') o.allow.push(v());\n    else if (a === '--listen') o.listen = v();\n    else if (a === '--port') o.port = +v();\n    else if (a === '--origin') o.origins.push(v());\n    else if (a === '--any-origin') o.anyOrigin = true;\n    else if (a === '--allow-any') o.allow.push('*:*');\n    else if (a === '--allow-writes') o.allowWrites = true;\n    else if (a === '--verbose' || a === '-v') o.verbose = true;\n    else if (a === '--config' || a === '-c') o.config = v();\n    else if (a === '--version' || a === '-V') o.version = true;\n    else if (a === '--help' || a === '-h') o.help = true;\n    else throw new Error('unknown option ' + a);\n  }\n  return o;\n}\n\n// ─── config file ─────────────────────────────────────────────────────────────\nconst CONFIG_KEYS = { allow: 'array', allowMode: 'mode', port: 'port', listen: 'string', origins: 'array', anyOrigin: 'boolean', allowWrites: 'boolean', verbose: 'boolean' };\nfunction validPort(p) { return typeof p === 'number' && Number.isInteger(p) && p \u003e= 0 && p \u003c= 65535; }   // 0 = any free port (tests)\n// JSON text of a config file → { options, warnings }. Keys starting with \"_\" are comments;\n// other unknown keys are ignored with a warning (a newer file read by an older bridge).\nfunction parseConfig(text, label) {\n  label = label || 'config';\n  let obj;\n  try { obj = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error(label + ': not valid JSON (' + e.message + ')'); }\n  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(label + ': expected a JSON object {…}');\n  const options = {}, warnings = [];\n  Object.keys(obj).forEach((k) =\u003e {\n    const t = CONFIG_KEYS[k], v = obj[k];\n    if (!t) { if (k[0] !== '_') warnings.push(label + ': unknown key \"' + k + '\" ignored'); return; }\n    if (t === 'array') {\n      if (!Array.isArray(v) || v.some((x) =\u003e typeof x !== 'string')) throw new Error(label + ': \"' + k + '\" must be a list of strings');\n      options[k] = v.map((x) =\u003e x.trim()).filter(Boolean);\n    } else if (t === 'mode') {                  // installer bookkeeping (see --config above)\n      if (v !== 'any' && v !== 'list') throw new Error(label + ': \"allowMode\" must be \"any\" or \"list\"');\n      options[k] = v;\n    } else if (t === 'port') {\n      if (!validPort(v)) throw new Error(label + ': \"port\" must be a whole number 1-65535');\n      options[k] = v;\n    } else if (typeof v !== t) throw new Error(label + ': \"' + k + '\" must be a ' + t);\n    else options[k] = v;\n  });\n  (options.allow || []).forEach((a) =\u003e { try { parseAllow(a); } catch (e) { throw new Error(label + ': ' + e.message.replace('--allow', 'allow entry')); } });\n  return { options, warnings };\n}\nfunction loadConfigFile(file) {\n  let text;\n  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error('cannot read config file ' + file + ': ' + e.message); }\n  return parseConfig(text, file);\n}\nfunction uniq(list) { const seen = new Set(); return list.filter((x) =\u003e { const k = String(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }\n// Config file (with --config) + command line → { options, warnings }. Command-line port / listen\n// win; the allow / origins lists are merged; --allow-writes / --any-origin / --verbose only switch on.\nfunction resolveOptions(cli, readConfig) {\n  cli = cli || {};\n  let base = {}, warnings = [];\n  if (cli.config) { const r = (readConfig || loadConfigFile)(cli.config); base = r.options || {}; warnings = r.warnings || []; }\n  const o = {};\n  ['port', 'listen', 'anyOrigin', 'allowWrites', 'verbose'].forEach((k) =\u003e { if (base[k] !== undefined) o[k] = base[k]; });\n  o.allow = uniq((base.allow || []).concat(cli.allow || []).map((x) =\u003e String(x).trim()).filter(Boolean));\n  o.origins = uniq((base.origins || []).concat(cli.origins || []));\n  if (cli.port !== undefined) o.port = cli.port;\n  if (cli.listen !== undefined) o.listen = cli.listen;\n  if (o.listen !== undefined) o.listen = normListen(o.listen);\n  ['anyOrigin', 'allowWrites', 'verbose'].forEach((k) =\u003e { if (cli[k]) o[k] = true; });\n  if (o.port !== undefined && !validPort(o.port)) throw new Error('bad --port (1-65535)');\n  if (o.listen !== undefined && (typeof o.listen !== 'string' || !o.listen)) throw new Error('bad --listen address');\n  o.allow.forEach(parseAllow);\n  return { options: o, warnings };\n}\n\nfunction helpText() {\n  const src = fs.readFileSync(__filename, 'utf8').split('\\n');\n  const end = src.findIndex((l) =\u003e /^'use strict'/.test(l));\n  return src.slice(1, end \u003e 0 ? end : 40).map((l) =\u003e l.replace(/^\\/\\/ ?/, '')).join('\\n');\n}\nfunction main(argv) {\n  let cli, r;\n  try { cli = parseArgs(argv || process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }\n  if (cli.version) { console.log(BRIDGE_VERSION); return; }\n  if (cli.help) { console.log(helpText()); return; }\n  try { r = resolveOptions(cli); } catch (e) { console.error('[bridge] ' + e.message); process.exit(2); }\n  const o = r.options;\n  r.warnings.forEach((w) =\u003e console.warn('[bridge] WARNING: ' + w));\n  if (!o.allow.length || o.allow.some((a) =\u003e /^\\*:/.test(String(a).trim()))) console.log('[bridge] any device IP is allowed' + (o.allow.length ? '' : ' (default; list --allow \u003cip\u003e:\u003cport\u003e targets to restrict)') + '. The bridge still listens on this PC only' + (o.allowWrites ? '' : ' and refuses writes') + '.');\n  if ((o.origins || []).some((x) =\u003e String(x).toLowerCase() === 'null') || o.anyOrigin) console.warn('[bridge] WARNING: ' + (o.anyOrigin ? 'any page origin is accepted' : 'pages with \"Origin: null\" (saved copies, but also sandboxed frames of any web site) are accepted') + ' — only do this on a PC that is not used for general web browsing.');\n  if (o.listen && o.listen !== '127.0.0.1' && o.listen !== '::1') console.warn('[bridge] WARNING: listening on ' + o.listen + ' — other machines on the network can use this bridge.');\n  const b = createBridge(Object.assign({}, o, { configFile: cli.config ? require('path').resolve(cli.config) : undefined }));\n  const listenHost = o.listen || '127.0.0.1';\n  b.listen().then((port) =\u003e {\n    console.log('[bridge] WTS Modbus bridge v' + BRIDGE_VERSION + ' listening on ws://' + listenHost + ':' + port + '/modbus  (' + (o.allowWrites ? 'writes ALLOWED' : 'read-only') + ')');\n    console.log('[bridge] allowed targets: ' + (o.allow.join(', ') || '*:* (any device)'));\n    console.log('[bridge] health check: http://' + (listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost) + ':' + port + '/health' + (cli.config ? '   (config: ' + cli.config + ')' : ''));\n  }, (e) =\u003e {\n    console.error('[bridge] cannot listen on ' + listenHost + ':' + (o.port || 8502) + ': ' + e.message + (e.code === 'EADDRINUSE' ? ' — another bridge (or program) already uses this port.' : ''));\n    process.exit(1);\n  });\n  const stop = () =\u003e { b.close().then(() =\u003e process.exit(0)); };\n  process.on('SIGINT', stop);\n  process.on('SIGTERM', stop);     // launchd / systemd stop\n}\n\nmodule.exports = { BRIDGE_VERSION, BRIDGE_NAME, createBridge, statusPageHtml, htmlEsc, parseAllow, allowed, originOk, hostHeaderOk, healthRefusal, normListen, encodeFrame, decodeFrames, takeAdus, exceptionAdu,\n  parseArgs, parseConfig, loadConfigFile, resolveOptions, main };\nif (require.main === module) main();\n",
        "fake-slave.js": "#!/usr/bin/env node\n// =============================================================================\n// fake-slave.js — a tiny Modbus TCP slave for testing the bridge without hardware.\n// Zero dependencies. Serves FC 01-06, 15, 16 on unit id 1 (any unit id with --any-unit),\n// with 10,000 coils / discrete inputs / holding / input registers.\n//\n// Initial contents (so a read is easy to recognise):\n//   holding[i] = i, input[i] = 1000 + i, coil[i] = i % 2, discrete[i] = (i + 1) % 2,\n//   input 100-101 = FLOAT32 ABCD 123.456 (0x42F6 0xE979).\n//\n// Usage: node fake-slave.js [--port 5020] [--listen 127.0.0.1] [--any-unit]\n// =============================================================================\n'use strict';\nconst net = require('net');\n\nfunction createSlave(opts) {\n  opts = Object.assign({ port: 5020, listen: '127.0.0.1', unit: 1, anyUnit: false }, opts || {});\n  const N = 10000;\n  const mem = { coil: new Uint8Array(N), discrete: new Uint8Array(N), holding: new Uint16Array(N), input: new Uint16Array(N) };\n  for (let i = 0; i \u003c N; i++) { mem.holding[i] = i; mem.input[i] = 1000 + i; mem.coil[i] = i % 2; mem.discrete[i] = (i + 1) % 2; }\n  mem.input[100] = 0x42F6; mem.input[101] = 0xE979;\n  const stats = { requests: 0, writes: 0 };\n  function exc(fc, code) { return Buffer.from([fc | 0x80, code]); }\n  function pdu(p) {\n    const fc = p[0], addr = p.readUInt16BE(1), qty = p.readUInt16BE(3);\n    stats.requests++;\n    if (fc === 1 || fc === 2) {\n      if (qty \u003c 1 || qty \u003e 2000) return exc(fc, 3);\n      if (addr + qty \u003e N) return exc(fc, 2);\n      const m = fc === 1 ? mem.coil : mem.discrete, nb = Math.ceil(qty / 8), out = Buffer.alloc(2 + nb);\n      out[0] = fc; out[1] = nb;\n      for (let i = 0; i \u003c qty; i++) if (m[addr + i]) out[2 + (i \u003e\u003e 3)] |= 1 \u003c\u003c (i & 7);\n      return out;\n    }\n    if (fc === 3 || fc === 4) {\n      if (qty \u003c 1 || qty \u003e 125) return exc(fc, 3);\n      if (addr + qty \u003e N) return exc(fc, 2);\n      const m = fc === 3 ? mem.holding : mem.input, out = Buffer.alloc(2 + 2 * qty);\n      out[0] = fc; out[1] = 2 * qty;\n      for (let i = 0; i \u003c qty; i++) out.writeUInt16BE(m[addr + i], 2 + 2 * i);\n      return out;\n    }\n    if (fc === 5) { if (qty !== 0xFF00 && qty !== 0) return exc(fc, 3); if (addr \u003e= N) return exc(fc, 2); mem.coil[addr] = qty ? 1 : 0; stats.writes++; return p.slice(0, 5); }\n    if (fc === 6) { if (addr \u003e= N) return exc(fc, 2); mem.holding[addr] = qty; stats.writes++; return p.slice(0, 5); }\n    if (fc === 15) { const bc = p[5]; if (qty \u003c 1 || qty \u003e 1968 || bc !== Math.ceil(qty / 8)) return exc(fc, 3); if (addr + qty \u003e N) return exc(fc, 2); for (let i = 0; i \u003c qty; i++) mem.coil[addr + i] = (p[6 + (i \u003e\u003e 3)] \u003e\u003e (i & 7)) & 1; stats.writes++; return p.slice(0, 5); }\n    if (fc === 16) { const bc = p[5]; if (qty \u003c 1 || qty \u003e 123 || bc !== 2 * qty) return exc(fc, 3); if (addr + qty \u003e N) return exc(fc, 2); for (let i = 0; i \u003c qty; i++) mem.holding[addr + i] = p.readUInt16BE(6 + 2 * i); stats.writes++; return p.slice(0, 5); }\n    return exc(fc, 1);\n  }\n  const socks = new Set();\n  const server = net.createServer((sock) =\u003e {\n    socks.add(sock); sock.on('close', () =\u003e socks.delete(sock));\n    let buf = Buffer.alloc(0);\n    sock.on('data', (d) =\u003e {\n      buf = Buffer.concat([buf, d]);\n      while (buf.length \u003e= 7) {\n        const len = buf.readUInt16BE(4);\n        if (buf.length \u003c 6 + len) break;\n        const adu = buf.slice(0, 6 + len); buf = buf.slice(6 + len);\n        const unit = adu[6];\n        if (!opts.anyUnit && unit !== opts.unit) continue;      // wrong unit: no reply (gateway behaviour varies)\n        const res = pdu(adu.slice(7));\n        const out = Buffer.alloc(7 + res.length);\n        adu.copy(out, 0, 0, 4); out.writeUInt16BE(res.length + 1, 4); out[6] = unit; res.copy(out, 7);\n        sock.write(out);\n      }\n    });\n    sock.on('error', () =\u003e {});\n  });\n  return {\n    server, mem, stats,\n    listen() { return new Promise((resolve, reject) =\u003e { server.once('error', reject); server.listen(opts.port, opts.listen, () =\u003e resolve(server.address().port)); }); },\n    close() { const p = new Promise((r) =\u003e server.close(() =\u003e r())); socks.forEach((s) =\u003e s.destroy()); return p; },\n  };\n}\n\nmodule.exports = { createSlave };\nif (require.main === module) {\n  const a = process.argv.slice(2), o = {};\n  for (let i = 0; i \u003c a.length; i++) { if (a[i] === '--port') o.port = +a[++i]; else if (a[i] === '--listen') o.listen = a[++i]; else if (a[i] === '--any-unit') o.anyUnit = true; }\n  const s = createSlave(o);\n  s.listen().then((p) =\u003e console.log('[fake-slave] Modbus TCP slave on ' + (o.listen || '127.0.0.1') + ':' + p + ' (unit ' + (o.anyUnit ? 'any' : 1) + ')'));\n}\n",
        "install-windows.ps1": "\u003c#\n.SYNOPSIS\n  Installs the WTS Modbus bridge (WebSocket \u003c-\u003e Modbus TCP) for the current Windows user.\n  No administrator rights are needed for the bridge itself.\n\n.DESCRIPTION\n  1. Checks for Node.js 18 or newer. If it is missing it offers to install the LTS version\n     with \"winget install OpenJS.NodeJS.LTS\" - only after you confirm (or with -Yes).\n     Nothing else is downloaded.\n  2. Copies modbus-bridge.js, fake-slave.js and README.md to\n     \"%LOCALAPPDATA%\\WTS Modbus Bridge\", writes bridge-config.json and start-bridge.cmd,\n     and adds a Start-menu shortcut \"WTS Modbus Bridge\".\n  3. -AutoStart also starts the bridge at every logon (a user-level Scheduled Task, or a\n     Startup-folder shortcut when Task Scheduler refuses).\n  4. Starts the bridge, checks http://127.0.0.1:\u003cport\u003e/health and prints the next steps.\n\n  Running it again keeps the settings of the existing bridge-config.json: new -Allow targets\n  are ADDED to its allow list, and its port / listen address / write setting / origins stay\n  unless you give -Port / -Listen / -AllowWrites / -ReadOnly. -Reset starts from a new, empty\n  configuration (the old file is kept as bridge-config.json.bak).\n\n  Allow list of an older installer: a bridge-config.json written before v1.2.1 has no\n  \"allowMode\". Its allow list is replaced by any device (the default since v1.2) unless you\n  give -Allow targets (added to it) or -KeepAllow (kept as it is); a note says so.\n\n  Run it from PowerShell (Start menu \u003e type PowerShell) in the folder that holds it:\n    powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Allow \"192.168.1.10:502\"\n  \"-ExecutionPolicy Bypass\" applies to this one run only; it changes no system setting.\n\n.PARAMETER Allow\n  host:port targets the bridge may connect to, comma separated: IPv4 (192.168.1.10:502),\n  IPv4 subnet (10.0.0.0/24:502), host name (plc-1.local:502) or IPv6 in brackets\n  ([fd00::10]:502); port 1-65535 or * (any port). Added to the targets already configured.\n.PARAMETER Port\n  WebSocket port of the bridge (default 8502; the app's bridge URL is ws://127.0.0.1:\u003cport\u003e).\n.PARAMETER Listen\n  Interface to listen on (default 127.0.0.1 = this computer only).\n.PARAMETER AllowAny\n  Allow any device IP / port (same as -Allow \"*:*\"). This is also what you get when no -Allow\n  target is given at all (the default since bridge v1.2.0). Replaces an existing list.\n.PARAMETER KeepAllow\n  Keep the allow list of an existing bridge-config.json written by an older installer (without\n  it, that list is replaced by any device).\n.PARAMETER AllowWrites\n  Forward Modbus write requests (FC 05/06/15/16). Read-only otherwise.\n.PARAMETER ReadOnly\n  Refuse Modbus write requests again (the default for a new install).\n.PARAMETER Origin\n  Also accept pages from these origins, comma separated: https://app.company.example, http://host:port, or\n  null for a saved file:// copy of the app (any web site can send \"null\", so only on a PC that\n  is not used for general web browsing).\n.PARAMETER AutoStart\n  Start the bridge automatically at logon.\n.PARAMETER NoStart\n  Install only; do not start the bridge now (with -AutoStart it starts at the next logon).\n.PARAMETER Reset\n  Ignore the existing bridge-config.json and write a new one.\n.PARAMETER Uninstall\n  Stop the bridge and remove the auto-start entry, the shortcuts and the installed files.\n.PARAMETER Yes\n  Answer yes to the Node.js installation question.\n\n.EXAMPLE\n  powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Allow \"192.168.1.10:502,192.168.1.11:502\" -AutoStart\n.EXAMPLE\n  powershell -NoProfile -ExecutionPolicy Bypass -File \"$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1\" -Uninstall\n#\u003e\n[CmdletBinding()]\nparam(\n    [string[]]$Allow = @(),\n    [int]$Port = 0,\n    [string]$Listen = '',\n    [switch]$AllowAny,\n    [switch]$KeepAllow,\n    [switch]$AllowWrites,\n    [switch]$ReadOnly,\n    [string[]]$Origin = @(),\n    [switch]$AutoStart,\n    [switch]$NoStart,\n    [switch]$Reset,\n    [switch]$Uninstall,\n    [switch]$Yes\n)\n$ErrorActionPreference = 'Stop'\n\n# @@WTS-PRESET-BEGIN@@ (the app's \"Generate installer for my devices\" fills in this block)\n$PresetAllow = ''\n$PresetPort = 0\n$PresetListen = ''\n$PresetAllowWrites = $null\n$PresetAutoStart = $false\n$PresetOrigins = ''\n# @@WTS-PRESET-END@@\n\n# @@WTS-PAYLOAD-BEGIN@@ (a generated installer embeds the bridge files here)\n$Embedded = @{}\n$EmbeddedVersion = ''\n# @@WTS-PAYLOAD-END@@\n\n$AppName = 'WTS Modbus Bridge'\n$TaskName = 'WTS Modbus Bridge'\n$NodeMin = 18\n$InstallDir = Join-Path $env:LOCALAPPDATA $AppName\n$StartCmd = Join-Path $InstallDir 'start-bridge.cmd'\n$ConfigPath = Join-Path $InstallDir 'bridge-config.json'\n$InstalledFiles = @('modbus-bridge.js', 'fake-slave.js', 'README.md', 'bridge-config.json', 'bridge-config.json.bak',\n    'start-bridge.cmd', 'install-windows.ps1', 'bridge.log')\n$ConfigComment = 'WTS Modbus bridge settings. allow = the host:port targets the bridge may connect to (*:* = any device; allowMode any or list). Running the installer again keeps these settings and adds new -Allow targets (-AllowAny = any device, -Reset starts over). Restart the bridge after editing.'\n\nfunction Say([string]$text) { Write-Host $text }\nfunction Warn([string]$text) { Write-Host ('WARNING: ' + $text) -ForegroundColor Yellow }\nfunction Good([string]$text) { Write-Host $text -ForegroundColor Green }\n\n# ---- validation (no PowerShell / cmd metacharacters can get through) ---------\nfunction Test-IPv4([string]$ip) {\n    if (-not ($ip -cmatch '\\A([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\z')) { return $false }\n    for ($i = 1; $i -le 4; $i++) { if ([int]$Matches[$i] -gt 255) { return $false } }\n    return $true\n}\nfunction Test-HostName([string]$h) {\n    if ($h.Length -lt 1 -or $h.Length -gt 253) { return $false }\n    if ($h.StartsWith('[') -and $h.EndsWith(']')) {\n        # IPv6 in brackets: hex digits, colons and dots only (no zone id), 2+ colons\n        $a = $h.Substring(1, $h.Length - 2)\n        if ($a -cnotmatch '\\A[0-9A-Fa-f:.]{2,45}\\z') { return $false }\n        return (($a.Split(':').Length - 1) -ge 2)\n    }\n    if ($h.Contains('/')) {\n        $parts = $h.Split('/')\n        if ($parts.Length -ne 2) { return $false }\n        if (-not (Test-IPv4 ($parts[0]))) { return $false }\n        if ($parts[1] -cnotmatch '\\A[0-9]{1,2}\\z') { return $false }\n        return ([int]$parts[1] -le 32)\n    }\n    if ($h -cmatch '\\A[0-9.]+\\z') { return (Test-IPv4 $h) }\n    if ($h -cnotmatch '\\A[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?\\z') { return $false }\n    return (-not $h.Contains('..'))\n}\nfunction Test-PortText([string]$p) {\n    if ($p -cnotmatch '\\A[0-9]{1,5}\\z') { return $false }\n    $n = [int]$p\n    return ($n -ge 1 -and $n -le 65535)\n}\nfunction Test-Target([string]$t) {\n    $i = $t.LastIndexOf(':')\n    if ($i -le 0) { return $false }\n    if ($t.Substring(0, $i) -ceq '*') { $p = $t.Substring($i + 1); return ($p -eq '*' -or (Test-PortText $p)) }\n    if (-not (Test-HostName ($t.Substring(0, $i)))) { return $false }\n    $p = $t.Substring($i + 1)\n    return ($p -eq '*' -or (Test-PortText $p))\n}\nfunction Test-Listen([string]$a) { return ($a -ceq 'localhost' -or (Test-IPv4 $a)) }\nfunction Get-NormalListen([string]$a) {\n    # \"localhost\" may resolve to ::1 only (Node \u003e= 17 keeps the resolver order) - the app uses 127.0.0.1\n    if ($a -ceq 'localhost') { return '127.0.0.1' }\n    return $a\n}\nfunction Test-Origin([string]$o) {\n    # null | file:// | http(s)://host[:port]\n    if ($o -ceq 'null' -or $o -ceq 'file://') { return $true }\n    if ($o.Length -gt 300) { return $false }\n    if (-not ($o -cmatch '\\Ahttps?://([A-Za-z0-9._-]+|\\[[0-9A-Fa-f:.]+\\])(:([0-9]{1,5}))?\\z')) { return $false }\n    if ($Matches[3]) { return (Test-PortText $Matches[3]) }\n    return $true\n}\nfunction Get-NormalTarget([string]$t) {\n    # a valid target: lower case, port without leading zeros\n    $t = $t.ToLowerInvariant()\n    $i = $t.LastIndexOf(':')\n    $p = $t.Substring($i + 1)\n    if ($p -ne '*') { $p = [string]([int]$p) }\n    return ($t.Substring(0, $i) + ':' + $p)\n}\nfunction Get-SpecForm([string]$t) {\n    # the bridge's own spelling of an allow entry (as /health lists it)\n    $t = $t.Trim()\n    $i = $t.LastIndexOf(':')\n    if ($i -le 0) { return $t.ToLowerInvariant() }\n    $h = $t.Substring(0, $i).Trim('[', ']').ToLowerInvariant()\n    $p = $t.Substring($i + 1)\n    $n = 0\n    if ($p -ne '*' -and [int]::TryParse($p, [ref]$n)) { $p = [string]$n }\n    if ($h.Contains(':')) { $h = '[' + $h + ']' }\n    return ($h + ':' + $p)\n}\n\n$NewAllow = New-Object 'System.Collections.Generic.List[string]'\n$NewOrigins = New-Object 'System.Collections.Generic.List[string]'\n$AllowList = New-Object 'System.Collections.Generic.List[string]'\nfunction Add-Allow([string[]]$items) {\n    foreach ($raw in $items) {\n        if ($null -eq $raw) { continue }\n        foreach ($item in ($raw -split '[,\\s]+')) {\n            if ($item -eq '') { continue }\n            if (-not (Test-Target $item)) {\n                throw (\"Invalid -Allow entry '\" + $item + \"' (use ip:port, ip/bits:port, hostname:port or [ipv6]:port; port 1-65535 or *).\")\n            }\n            $item = Get-NormalTarget $item\n            if (-not $script:NewAllow.Contains($item)) { $script:NewAllow.Add($item) }\n        }\n    }\n}\nfunction Add-Origin([string[]]$items) {\n    foreach ($raw in $items) {\n        if ($null -eq $raw) { continue }\n        foreach ($item in ($raw -split '[,\\s]+')) {\n            if ($item -eq '') { continue }\n            if (-not (Test-Origin $item)) {\n                throw (\"Invalid -Origin '\" + $item + \"' (use https://host[:port], http://host[:port], null or file://).\")\n            }\n            if (-not $script:NewOrigins.Contains($item)) { $script:NewOrigins.Add($item) }\n        }\n    }\n}\nfunction ConvertTo-JsonText([string]$s) {\n    # a JSON string literal (ASCII only)\n    $sb = New-Object System.Text.StringBuilder\n    [void]$sb.Append('\"')\n    foreach ($ch in $s.ToCharArray()) {\n        $code = [int]$ch\n        if ($code -eq 34) { [void]$sb.Append('\\\"') }\n        elseif ($code -eq 92) { [void]$sb.Append('\\\\') }\n        elseif ($code -lt 32 -or $code -gt 126) { [void]$sb.Append(('\\u{0:x4}' -f $code)) }\n        else { [void]$sb.Append($ch) }\n    }\n    [void]$sb.Append('\"')\n    return $sb.ToString()\n}\n\n# ---- helpers -------------------------------------------------------------------\nfunction Confirm-Step([string]$question) {\n    if ($Yes) { return $true }\n    try { $answer = Read-Host ($question + ' [y/N]') } catch { return $false }\n    return ($answer -match '\\A\\s*(y|yes)\\s*\\z')\n}\nfunction Invoke-Quiet([string]$exe, [string[]]$arguments) {\n    # Windows PowerShell 5.1 turns native stderr into errors under 'Stop' - relax it here.\n    $old = $ErrorActionPreference\n    $ErrorActionPreference = 'Continue'\n    try {\n        $out = & $exe @arguments 2\u003e$null\n        return [pscustomobject]@{ Code = $LASTEXITCODE; Out = (@($out) -join \"`n\") }\n    } catch {\n        return [pscustomobject]@{ Code = 1; Out = '' }\n    } finally {\n        $ErrorActionPreference = $old\n    }\n}\nfunction Find-Node {\n    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n    if ($cmd) { return $cmd.Path }\n    $candidates = @((Join-Path $env:ProgramFiles 'nodejs\\node.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs\\node.exe'))\n    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\\node.exe') }\n    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }\n    return $null\n}\nfunction Get-NodeMajor([string]$node) {\n    if (-not $node) { return 0 }\n    $r = Invoke-Quiet $node @('-p', \"process.versions.node.split('.')[0]\")\n    $n = 0\n    if ($r.Code -eq 0 -and [int]::TryParse(($r.Out.Trim()), [ref]$n)) { return $n }\n    return 0\n}\nfunction Show-NodeHelp {\n    Say ('Install Node.js ' + $NodeMin + ' or newer (the LTS version), then run this installer again:')\n    Say '  - winget install OpenJS.NodeJS.LTS'\n    Say '  - or the Windows installer (.msi) from https://nodejs.org'\n}\nfunction Initialize-Node {\n    $node = Find-Node\n    $major = Get-NodeMajor $node\n    if ($major -ge $NodeMin) { return $node }\n    if ($node) { $have = 'version ' + $major + ' at ' + $node } else { $have = 'not found' }\n    Say ('Node.js ' + $NodeMin + ' or newer is needed to run the bridge (Node.js: ' + $have + ').')\n    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n    if (-not $winget) { Show-NodeHelp; throw 'Node.js is missing.' }\n    if (-not (Confirm-Step \"Install Node.js LTS now with 'winget install OpenJS.NodeJS.LTS' (Windows may ask for permission)?\")) {\n        Show-NodeHelp; throw 'Node.js is missing.'\n    }\n    & $winget.Path install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements | Out-Host\n    if ($LASTEXITCODE -ne 0) { Warn ('winget exited with code ' + $LASTEXITCODE) }\n    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')\n    $node = Find-Node\n    $major = Get-NodeMajor $node\n    if ($major -lt $NodeMin) {\n        Say 'Node.js is still not available in this window. Open a new PowerShell window and run the installer again.'\n        throw 'Node.js is missing.'\n    }\n    return $node\n}\nfunction Write-Utf8NoBom([string]$path, [string]$text) {\n    $enc = New-Object System.Text.UTF8Encoding($false)\n    [IO.File]::WriteAllText($path, $text, $enc)\n}\nfunction Get-Health([string]$hostName, [int]$port) {\n    $resp = $null\n    try {\n        $req = [System.Net.WebRequest]::Create('http://' + $hostName + ':' + $port + '/health')\n        $req.Timeout = 2000\n        $req.ReadWriteTimeout = 2000\n        $req.Proxy = $null\n        $resp = $req.GetResponse()\n        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())\n        $text = $reader.ReadToEnd()\n        $reader.Close()\n        return ($text | ConvertFrom-Json)\n    } catch {\n        return $null\n    } finally {\n        if ($resp) { $resp.Close() }\n    }\n}\nfunction Test-PortInUse([string]$hostName, [int]$port) {\n    # anything (a bridge or another program) listening on the port?\n    $client = New-Object System.Net.Sockets.TcpClient\n    try {\n        $ar = $client.BeginConnect($hostName, $port, $null, $null)\n        if (-not $ar.AsyncWaitHandle.WaitOne(1500)) { return $false }\n        $client.EndConnect($ar)\n        return $true\n    } catch {\n        return $false\n    } finally {\n        $client.Close()\n    }\n}\nfunction Test-HealthMatches($h, [int]$port, [bool]$writes) {\n    # is the bridge that answered the one just configured?\n    if ([int]$h.port -ne $port) { return $false }\n    if ([bool]$h.readOnly -eq $writes) { return $false }\n    $got = @(@($h.allow) | Where-Object { $null -ne $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() } | Sort-Object)\n    $want = @($script:AllowList | ForEach-Object { Get-SpecForm $_ } | Sort-Object)\n    return (($got -join ',') -eq ($want -join ','))\n}\nfunction Get-HealthText($h) {\n    if ($h.readOnly) { $m = 'read-only' } else { $m = 'writes ALLOWED' }\n    $allowed = @($h.allow) -join ', '\n    if (-not $allowed) { $allowed = '(none)' }\n    return ('v' + $h.version + ', ' + $m + ', port ' + $h.port + '; allowed targets: ' + $allowed)\n}\nfunction Wait-Health([string]$hostName, [int]$port, [int]$seconds) {\n    for ($i = 0; $i -lt ($seconds * 4); $i++) {\n        $h = Get-Health $hostName $port\n        if ($h) { return $h }\n        Start-Sleep -Milliseconds 250\n    }\n    return $null\n}\nfunction Stop-OurBridges {\n    # node.exe processes started from the install folder (an earlier install or auto-start), and\n    # the console windows running start-bridge.cmd (older auto-start tasks left a \"cmd /K\" prompt\n    # open there, which keeps the install folder in use)\n    $stopped = 0\n    $killed = 0\n    $procs = @()\n    try { $procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'cmd.exe'\" -ErrorAction Stop) } catch { $procs = @() }\n    foreach ($p in $procs) {\n        if ($null -eq $p -or -not $p.CommandLine -or $p.ProcessId -eq $PID) { continue }\n        if ($p.Name -ieq 'node.exe') { $ours = ($p.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) }\n        else { $ours = ($p.CommandLine.IndexOf($StartCmd, [StringComparison]::OrdinalIgnoreCase) -ge 0) }\n        if ($ours) {\n            try {\n                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop\n                $killed++\n                if ($p.Name -ieq 'node.exe') { $stopped++ }\n            } catch { }\n        }\n    }\n    if ($killed -gt 0) { Start-Sleep -Milliseconds 500 }\n    return $stopped\n}\nfunction New-Shortcut([string]$lnk, [string]$target, [string]$workDir, [string]$description, [int]$windowStyle, [string]$icon) {\n    $shell = New-Object -ComObject WScript.Shell\n    $s = $shell.CreateShortcut($lnk)\n    $s.TargetPath = $target\n    $s.WorkingDirectory = $workDir\n    $s.Description = $description\n    $s.WindowStyle = $windowStyle\n    if ($icon) { $s.IconLocation = $icon + ',0' }\n    $s.Save()\n}\nfunction Get-StartMenuLink { return (Join-Path ([Environment]::GetFolderPath('Programs')) ($AppName + '.lnk')) }\nfunction Get-StartupLink { return (Join-Path ([Environment]::GetFolderPath('Startup')) ($AppName + '.lnk')) }\nfunction Remove-AutoStart {\n    try {\n        $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue\n        if ($t) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Say ('Removed the scheduled task \"' + $TaskName + '\"') }\n    } catch { }\n    $startup = Get-StartupLink\n    if (Test-Path -LiteralPath $startup) { Remove-Item -LiteralPath $startup -Force; Say ('Removed ' + $startup) }\n}\nfunction Register-AutoStart([string]$node) {\n    $user = $env:USERNAME\n    if ($env:USERDOMAIN) { $user = $env:USERDOMAIN + '\\' + $env:USERNAME }\n    try {\n        # \"start\" runs a .cmd file with \"cmd /K\": that window would stay open at a prompt after the\n        # bridge ends, keeping the install folder in use. A minimised \"cmd /c call\" closes with it.\n        $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/c start \"' + $AppName + '\" /min \"' + $env:ComSpec + '\" /c call \"' + $StartCmd + '\"') -WorkingDirectory $InstallDir\n        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user\n        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited\n        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)\n        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `\n            -Description 'Starts the WTS Modbus bridge (WebSocket to Modbus TCP) at logon.' -Force -ErrorAction Stop | Out-Null\n        $startup = Get-StartupLink\n        if (Test-Path -LiteralPath $startup) { Remove-Item -LiteralPath $startup -Force }\n        Say ('Auto-start: scheduled task \"' + $TaskName + '\" (at logon, this user, no admin rights)')\n    } catch {\n        New-Shortcut (Get-StartupLink) $StartCmd $InstallDir 'Starts the WTS Modbus bridge at logon' 7 $node\n        Say ('Auto-start: Startup-folder shortcut ' + (Get-StartupLink) + ' (Task Scheduler said: ' + $_.Exception.Message + ')')\n    }\n}\nfunction Test-AutoStartInstalled {\n    try { if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { return $true } } catch { }\n    return (Test-Path -LiteralPath (Get-StartupLink))\n}\nfunction Get-ConfiguredPort {\n    try {\n        $c = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json\n        if ($c.port -ge 1 -and $c.port -le 65535) { return [int]$c.port }\n    } catch { }\n    if ($Port -ge 1 -and $Port -le 65535) { return $Port }\n    return 8502\n}\nfunction Wait-IfStartedFromExplorer {\n    # \"Run with PowerShell\" from Explorer closes the window at once - keep it open to read.\n    try {\n        $me = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $PID) -ErrorAction Stop\n        $parent = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $me.ParentProcessId) -ErrorAction Stop\n        if ($parent -and $parent.Name -ieq 'explorer.exe') { Read-Host 'Press Enter to close this window' | Out-Null }\n    } catch { }\n}\n\n# ---- uninstall -----------------------------------------------------------------\nfunction Invoke-Uninstall {\n    $p = Get-ConfiguredPort\n    Remove-AutoStart\n    $lnk = Get-StartMenuLink\n    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Say ('Removed ' + $lnk) }\n    $n = Stop-OurBridges\n    if ($n -gt 0) { Say ('Stopped ' + $n + ' running bridge process(es)') }\n    if (Test-Path -LiteralPath $InstallDir) {\n        $removed = 0\n        foreach ($f in $InstalledFiles) {\n            $path = Join-Path $InstallDir $f\n            if (Test-Path -LiteralPath $path) {\n                try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop; $removed++ }\n                catch { Warn ('could not remove ' + $path + ' (' + $_.Exception.Message + ')') }\n            }\n        }\n        if (@(Get-ChildItem -LiteralPath $InstallDir -Force).Length -eq 0) {\n            try {\n                Remove-Item -LiteralPath $InstallDir -Force -ErrorAction Stop\n                Say ('Removed ' + $InstallDir + ' (' + $removed + ' files)')\n            } catch {\n                Warn ('removed ' + $removed + ' files, but not the empty folder ' + $InstallDir + ' (' + $_.Exception.Message + '). A window may still use it: close the \"' + $AppName + '\" window, then delete the folder.')\n            }\n        } else {\n            Warn ($InstallDir + ' still contains other files - left in place')\n        }\n    } else {\n        Say ('Nothing installed in ' + $InstallDir)\n    }\n    if (Get-Health '127.0.0.1' $p) { Warn ('a bridge still answers on port ' + $p + ' (started by hand?) - close its window.') }\n    Good 'The WTS Modbus bridge is uninstalled.'\n}\n\n# ---- install -------------------------------------------------------------------\nfunction Install-Files {\n    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null\n    if ($Embedded.Count -gt 0) {\n        foreach ($name in @($Embedded.Keys)) {\n            $entry = $Embedded[$name]\n            $dest = Join-Path $InstallDir $name\n            [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($entry.B64))\n            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLowerInvariant()\n            if ($got -ne $entry.Sha256) { throw ($name + ': SHA-256 mismatch after unpacking (installer damaged?) - download it again from the app.') }\n        }\n        Say ('Unpacked bridge v' + $EmbeddedVersion + ' (SHA-256 verified)')\n    } else {\n        $src = $PSScriptRoot\n        if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src 'modbus-bridge.js'))) {\n            throw ('modbus-bridge.js was not found next to this installer (' + $src + '). Download the bridge package from the app''s Modbus page, unzip it and run install-windows.ps1 from that folder.')\n        }\n        foreach ($f in @('modbus-bridge.js', 'fake-slave.js', 'README.md')) {\n            $from = Join-Path $src $f\n            $to = Join-Path $InstallDir $f\n            if ((Test-Path -LiteralPath $from) -and ($from -ne $to)) { Copy-Item -LiteralPath $from -Destination $to -Force }\n        }\n    }\n    $self = $PSCommandPath\n    $selfCopy = Join-Path $InstallDir 'install-windows.ps1'\n    if ($self -and (Test-Path -LiteralPath $self) -and ($self -ne $selfCopy)) { Copy-Item -LiteralPath $self -Destination $selfCopy -Force }\n    try { Get-ChildItem -LiteralPath $InstallDir -File | Unblock-File -ErrorAction SilentlyContinue } catch { }\n}\nfunction Read-OldConfig {\n    # the bridge-config.json of an earlier install: its settings are the defaults of this run\n    $r = @{ Have = $false; Allow = @(); Mode = ''; Port = 0; Listen = ''; Writes = $null; Origins = @(); AnyOrigin = $false; Verbose = $false }\n    if ($Reset -or -not (Test-Path -LiteralPath $ConfigPath)) { return $r }\n    try { $c = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json } catch { $c = $null }\n    if ($null -eq $c -or $c -is [array] -or $c -is [string] -or $c -is [ValueType]) {\n        Warn ($ConfigPath + ' could not be read (not valid JSON?) - writing a new one (the old file is kept as bridge-config.json.bak).')\n        return $r\n    }\n    $r.Have = $true\n    foreach ($a in @($c.allow)) {\n        if (-not ($a -is [string])) { continue }\n        $t = $a.Trim()\n        if (Test-Target $t) { $t = Get-NormalTarget $t }\n        elseif ($t -cnotmatch '\\A[\\[\\]A-Za-z0-9._:/*-]+\\z') { Warn (\"left out '\" + $t + \"' from the existing allow list (not a host:port target)\"); continue }\n        if ($r.Allow -notcontains $t) { $r.Allow += $t }\n    }\n    if ($null -ne $c.port -and ([string]$c.port) -cmatch '\\A[0-9]{1,5}\\z' -and (Test-PortText ([string]$c.port))) { $r.Port = [int]$c.port }\n    if ($c.listen -is [string]) {\n        if (Test-Listen $c.listen.Trim()) { $r.Listen = Get-NormalListen $c.listen.Trim() }\n        else { Warn (\"the existing listen address '\" + $c.listen + \"' is not an IPv4 address or localhost - not kept\") }\n    }\n    if ($c.allowWrites -is [bool]) { $r.Writes = [bool]$c.allowWrites }\n    # \"allowMode\" is written by v1.2.1+ installers; without it the allow list is an older installer's\n    if (($c.allowMode -is [string]) -and ($c.allowMode -ceq 'any' -or $c.allowMode -ceq 'list')) { $r.Mode = $c.allowMode }\n    foreach ($o in @($c.origins)) { if ($o -is [string] -and $o.Trim()) { $r.Origins += $o.Trim() } }\n    $r.AnyOrigin = (($c.anyOrigin -is [bool]) -and $c.anyOrigin)\n    $r.Verbose = (($c.verbose -is [bool]) -and $c.verbose)\n    return $r\n}\nfunction Write-Config([int]$port, [string]$listen, [bool]$writes, [string[]]$origins, [bool]$anyOrigin, [bool]$verbose) {\n    # origins, anyOrigin and verbose come from the old file (plus -Origin); values JSON-escaped\n    $allowJson = (@($AllowList | ForEach-Object { ConvertTo-JsonText $_ })) -join ', '\n    $originsJson = (@($origins | Where-Object { $_ } | ForEach-Object { ConvertTo-JsonText $_ })) -join ', '\n    if ($writes) { $w = 'true' } else { $w = 'false' }\n    if ($anyOrigin) { $any = 'true' } else { $any = 'false' }\n    if ($verbose) { $verb = 'true' } else { $verb = 'false' }\n    if ($AllowList.Contains('*:*')) { $mode = 'any' } else { $mode = 'list' }\n    $json = \"{`n\" +\n        \"  \"\"_comment\"\": \" + (ConvertTo-JsonText $ConfigComment) + \",`n\" +\n        \"  \"\"allow\"\": [\" + $allowJson + \"],`n\" +\n        \"  \"\"allowMode\"\": \" + (ConvertTo-JsonText $mode) + \",`n\" +\n        \"  \"\"port\"\": \" + $port + \",`n\" +\n        \"  \"\"listen\"\": \" + (ConvertTo-JsonText $listen) + \",`n\" +\n        \"  \"\"origins\"\": [\" + $originsJson + \"],`n\" +\n        \"  \"\"anyOrigin\"\": \" + $any + \",`n\" +\n        \"  \"\"allowWrites\"\": \" + $w + \",`n\" +\n        \"  \"\"verbose\"\": \" + $verb + \"`n\" +\n        \"}`n\"\n    if (Test-Path -LiteralPath $ConfigPath) {\n        $old = [IO.File]::ReadAllText($ConfigPath)\n        if ($old -ne $json) { Copy-Item -LiteralPath $ConfigPath -Destination ($ConfigPath + '.bak') -Force }\n    }\n    Write-Utf8NoBom $ConfigPath $json\n}\nfunction Write-StartCmd([string]$node) {\n    $nodeForCmd = $node.Replace('%', '%%')\n    $text = \"@echo off`r`n\" +\n        \"rem Starts the WTS Modbus bridge with bridge-config.json (written by install-windows.ps1).`r`n\" +\n        \"rem Extra options are passed on, e.g.  start-bridge.cmd --verbose`r`n\" +\n        \"chcp 65001 \u003enul`r`n\" +\n        \"title \" + $AppName + \"`r`n\" +\n        \"\"\"\" + $nodeForCmd + \"\"\" \"\"%~dp0modbus-bridge.js\"\" --config \"\"%~dp0bridge-config.json\"\" %*`r`n\" +\n        \"if errorlevel 1 pause`r`n\"\n    Write-Utf8NoBom $StartCmd $text\n}\nfunction Show-NextSteps([string]$hostName, [int]$port) {\n    Say ''\n    Say 'Next steps in the Well Testing Suite (Modbus Config page):'\n    Say '  1. For each device choose transport \"Modbus TCP via WebSocket bridge\", enter the'\n    Say ('     PLC''s IP address and port, and the bridge URL ws://' + $hostName + ':' + $port)\n    Say '  2. Press \"Check bridge\" in the setup guide, then \"Test\" on the device row.'\n    Say ''\n    Say ('Installed in:  ' + $InstallDir)\n    Say ('Settings:      ' + $ConfigPath + ' (restart the bridge after editing)')\n    Say ('Start:         Start menu \u003e ' + $AppName + '   (or \"' + $StartCmd + '\")')\n    Say ('Allow list:    powershell -NoProfile -ExecutionPolicy Bypass -File \"' + (Join-Path $InstallDir 'install-windows.ps1') + '\" -Allow \u003cip\u003e:\u003cport\u003e   (only listed devices; adds to the list)  or  -AllowAny')\n    Say ('Uninstall:     powershell -NoProfile -ExecutionPolicy Bypass -File \"' + (Join-Path $InstallDir 'install-windows.ps1') + '\" -Uninstall')\n}\n\nfunction Invoke-Install {\n    Add-Allow @($PresetAllow)\n    Add-Allow $Allow\n    if ($AllowAny) { Add-Allow @('*:*') }\n    Add-Origin @($PresetOrigins)\n    Add-Origin $Origin\n    if ($AllowWrites -and $ReadOnly) { throw 'Use either -AllowWrites or -ReadOnly, not both.' }\n    if ($Port -ne 0 -and ($Port -lt 1 -or $Port -gt 65535)) { throw ('Invalid -Port ' + $Port + ' (1-65535).') }\n    if ($PresetPort -ne 0 -and ($PresetPort -lt 1 -or $PresetPort -gt 65535)) { throw ('Invalid preset port ' + $PresetPort + ' (1-65535).') }\n    if ($Listen -and -not (Test-Listen $Listen)) { throw (\"Invalid -Listen '\" + $Listen + \"' (an IPv4 address or localhost).\") }\n    if ($PresetListen -and -not (Test-Listen $PresetListen)) { throw (\"Invalid preset listen address '\" + $PresetListen + \"'.\") }\n\n    $node = Initialize-Node\n    # The existing bridge-config.json supplies the defaults, so running the installer again (for one\n    # more device, or -AllowWrites) never drops the other targets or changes the port.\n    $old = Read-OldConfig\n    # The allow list: -AllowAny (or '*:*') = any device; -Allow targets are added to the old list\n    # (an \"any\" list starts empty); -KeepAllow or a file with \"allowMode\" (v1.2.1+) keeps the old\n    # list; the list of an older installer (no \"allowMode\") is replaced by any device.\n    $oldAny = ((@($old.Allow).Count -eq 0) -or (@($old.Allow) -contains '*:*'))\n    $migrated = ''\n    if ($NewAllow.Contains('*:*')) { $script:AllowList.Add('*:*') }\n    elseif ($NewAllow.Count -gt 0) {\n        $base = @()\n        if (-not $oldAny) { $base = @($old.Allow) }\n        foreach ($e in ($base + @($NewAllow))) { if ($e -and -not $script:AllowList.Contains($e)) { $script:AllowList.Add($e) } }\n    }\n    elseif ($oldAny) { }\n    elseif ($KeepAllow -or $old.Mode) {\n        foreach ($e in @($old.Allow)) { if ($e -and -not $script:AllowList.Contains($e)) { $script:AllowList.Add($e) } }\n    }\n    else { $migrated = (@($old.Allow) -join ', ') }\n    $origins = @()\n    foreach ($o in (@($old.Origins) + @($NewOrigins))) { if ($o -and ($origins -notcontains $o)) { $origins += $o } }\n    $port = 8502\n    if ($Port -gt 0) { $port = $Port } elseif ($PresetPort -gt 0) { $port = $PresetPort } elseif ($old.Port -gt 0) { $port = $old.Port }\n    $listen = '127.0.0.1'\n    if ($Listen) { $listen = $Listen } elseif ($PresetListen) { $listen = $PresetListen } elseif ($old.Listen) { $listen = $old.Listen }\n    $listen = Get-NormalListen $listen\n    $writes = $false\n    if ($ReadOnly) { $writes = $false }\n    elseif ($AllowWrites) { $writes = $true }\n    elseif ($null -ne $PresetAllowWrites) { $writes = [bool]$PresetAllowWrites }\n    elseif ($null -ne $old.Writes) { $writes = [bool]$old.Writes }\n    $auto = [bool]($AutoStart -or $PresetAutoStart)\n    $healthHost = $listen\n    if ($healthHost -eq '0.0.0.0') { $healthHost = '127.0.0.1' }\n\n    if ($migrated) {\n        Say ('Keeping the settings of the existing ' + $ConfigPath + ' (port, listen address, writes, origins).')\n        Say ('Allow-list ' + $migrated + ' replaced by any device (default since 1.2). Use -KeepAllow to keep it.')\n    } elseif ($old.Have -and $oldAny) {\n        Say ('Keeping the settings of the existing ' + $ConfigPath + ' (any device; -Allow \u003cip\u003e:\u003cport\u003e restricts it, -Reset starts a new file).')\n    } elseif ($old.Have) {\n        Say ('Keeping the settings of the existing ' + $ConfigPath + ' (' + @($old.Allow).Count + ' target(s); new targets are added - -Reset starts a new list).')\n    }\n    if ($AllowList.Count -eq 0) {\n        $script:AllowList.Add('*:*')\n        Say 'No -Allow targets given: the bridge will allow any device IP / port (default). Give -Allow \u003cip\u003e:\u003cport\u003e to restrict it.'\n    }\n    # Before anything is written: stop the bridges of an earlier install, then the port must be free\n    # (otherwise the new bridge could not start, and the settings on disk would not match the bridge\n    # that answers).\n    if (-not $NoStart) {\n        $n = Stop-OurBridges\n        if ($n -gt 0) { Say ('Stopped ' + $n + ' bridge process(es) from an earlier install') }\n        $other = Get-Health $healthHost $port\n        if ($other) {\n            throw ('another WTS Modbus bridge already answers on http://' + $healthHost + ':' + $port + ' (' + (Get-HealthText $other) + ') - it was not started by this install (a bridge started by hand?). Close its window, or install with -Port \u003cother\u003e. Nothing was changed.')\n        }\n        if (Test-PortInUse $healthHost $port) {\n            throw ('another program already uses port ' + $port + ' on ' + $healthHost + '. Stop it, or install with -Port \u003cother\u003e (and use that port in the device bridge URL). Nothing was changed.')\n        }\n    }\n    Install-Files\n    Write-Config $port $listen $writes $origins $old.AnyOrigin $old.Verbose\n    Write-StartCmd $node\n    New-Shortcut (Get-StartMenuLink) $StartCmd $InstallDir 'WTS Modbus bridge (WebSocket to Modbus TCP) for the Well Testing Suite' 1 $node\n    if ($writes) { $mode = 'writes ALLOWED' } else { $mode = 'read-only' }\n    $targets = $AllowList -join ', '\n    if (-not $targets) { $targets = '(none)' }\n    Good ('Installed the WTS Modbus bridge in ' + $InstallDir)\n    Say ('  allowed targets: ' + $targets + '   port: ' + $port + '   ' + $mode)\n    Say ('  Start-menu shortcut: ' + (Get-StartMenuLink))\n    if ($auto) { Register-AutoStart $node }\n    elseif (Test-AutoStartInstalled) { Say 'Auto-start from an earlier install is still set up (it uses the new settings from the next logon).' }\n\n    if ($NoStart) { Show-NextSteps $healthHost $port; return }\n    if ($auto) { $style = 'Minimized' } else { $style = 'Normal' }\n    Start-Process -FilePath $StartCmd -WorkingDirectory $InstallDir -WindowStyle $style\n    $h = Wait-Health $healthHost $port 15\n    if ($h) {\n        if (-not (Test-HealthMatches $h $port $writes)) {\n            throw ('the bridge answering on port ' + $port + ' is not the one just installed (' + (Get-HealthText $h) + '). Another bridge may be running: close it and run the installer again.')\n        }\n        Say ''\n        Good ('OK: the WTS Modbus bridge is running - ' + (Get-HealthText $h))\n        Say ('    health check: http://' + $healthHost + ':' + $port + '/health')\n        Say ('    It runs in its own window \"' + $AppName + '\" - leave that window open while you use the app.')\n    } else {\n        Warn ('the bridge did not answer on http://' + $healthHost + ':' + $port + '/health within 15 s - look at the \"' + $AppName + '\" window for the error.')\n    }\n    Show-NextSteps $healthHost $port\n}\n\n$exitCode = 0\ntry {\n    if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }\n} catch {\n    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red\n    $exitCode = 1\n} finally {\n    Wait-IfStartedFromExplorer\n}\nexit $exitCode\n",
        "install.sh": "#!/usr/bin/env bash\n# =============================================================================\n# install.sh - installs the WTS Modbus bridge (WebSocket \u003c-\u003e Modbus TCP) for the\n# current user on macOS or Linux. No sudo / admin rights are needed for the bridge.\n#\n#   bash install.sh [--allow 192.168.1.10:502] [--allow '10.0.0.0/24:502,plc.local:*']\n#                   [--port 8502] [--listen 127.0.0.1] [--allow-writes | --read-only]\n#                   [--origin https://app.company.example] [--autostart] [--keep-allow] [--reset]\n#                   [--yes] [--no-start] [--uninstall] [--help]\n#\n# One line, from the GitHub release (the release installer carries the bridge files):\n#   curl -fsSL https://github.com/h2oil/well-testing-suite/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes\n#\n# What it does\n#   1. Checks for Node.js 18 or newer. If it is missing it offers to install it with the\n#      system package manager (brew, apt-get, dnf, yum, pacman or apk) - only after you\n#      confirm (or with --yes). Nothing else is downloaded.\n#   2. Copies modbus-bridge.js, fake-slave.js and README.md to\n#        macOS:  ~/Library/Application Support/WTS Modbus Bridge\n#        Linux:  ${XDG_DATA_HOME:-~/.local/share}/wts-modbus-bridge\n#      and writes bridge-config.json and start-bridge.sh there.\n#   3. --autostart: a macOS LaunchAgent (~/Library/LaunchAgents/uk.co.h2oil.wts-modbus-bridge.plist)\n#      or a Linux systemd --user service (wts-modbus-bridge.service) starts the bridge now and\n#      at every login. Without --autostart the bridge runs in this terminal window\n#      (Ctrl+C stops it); an existing auto-start bridge is restarted with the new settings.\n#   4. Checks http://127.0.0.1:\u003cport\u003e/health and prints the next steps.\n#\n# Running it again keeps the settings of the existing bridge-config.json: new --allow targets\n# are ADDED to its allow list, and its port / listen address / write setting / origins stay\n# unless you give --port / --listen / --allow-writes / --read-only. --reset starts from a new,\n# empty configuration (the old file is kept as bridge-config.json.bak).\n# Allow list of an older installer: a bridge-config.json written before v1.2.1 has no\n# \"allowMode\". Its allow list is replaced by any device (the default since v1.2) unless you\n# give --allow targets (added to it) or --keep-allow (kept as it is); a note says so.\n#\n# --allow   host:port the bridge may connect to (repeat it, or give a comma list):\n#           IPv4 (192.168.1.10:502), IPv4 subnet (10.0.0.0/24:502), host name\n#           (plc-1.local:502) or IPv6 in brackets ([fd00::10]:502); port 1-65535 or * (any\n#           port). Quote values with * or [ ] ('plc.local:*') - zsh refuses an unmatched glob.\n#           With no --allow at all the bridge allows any device IP / port (default).\n# --allow-any  allow any device IP / port (same as --allow '*:*'); replaces an existing list.\n# --keep-allow keep the allow list of an existing bridge-config.json from an older installer.\n# --port    WebSocket port of the bridge (default 8502; the app's bridge URL is ws://127.0.0.1:\u003cport\u003e).\n# --listen  interface to listen on (default 127.0.0.1 = this computer only).\n# --allow-writes  forward Modbus write requests (FC 05/06/15/16); --read-only refuses them (default).\n# --origin  also accept pages from this origin (https://app.company.example, or null for a saved file:// copy\n#           of the app - any web site can send \"null\", so only on a PC not used for browsing).\n# --no-start      install only; do not start the bridge (with --autostart: it starts at the next login).\n# --reset         ignore the existing bridge-config.json and write a new one.\n# --uninstall     stop and remove the auto-start entry and the installed files.\n# =============================================================================\nset -euo pipefail\n# The whole script is one { ... } group, so bash reads all of it before running anything: it can\n# be piped into bash (curl ... | bash -s -- ...) without a command reading the rest of the script.\n{\nSELF=\"${BASH_SOURCE[0]:-}\"          # empty when the script is piped into bash\n\n# @@WTS-PRESET-BEGIN@@ (the app's \"Generate installer for my devices\" fills in this block)\nPRESET_ALLOW=\"\"\nPRESET_PORT=\"\"\nPRESET_LISTEN=\"\"\nPRESET_ALLOW_WRITES=\"\"\nPRESET_AUTOSTART=\"\"\nPRESET_ORIGINS=\"\"\n# @@WTS-PRESET-END@@\n\n# @@WTS-PAYLOAD-BEGIN@@ (a generated installer embeds the bridge files here)\nEMBEDDED_FILES=\"\"\nEMBEDDED_VERSION=\"\"\n# @@WTS-PAYLOAD-END@@\n\nAPP_NAME=\"WTS Modbus Bridge\"\nLABEL=\"uk.co.h2oil.wts-modbus-bridge\"\nUNIT_NAME=\"wts-modbus-bridge.service\"\nDEFAULT_PORT=8502\nNODE_MIN=18\nINSTALLED_FILES=(modbus-bridge.js fake-slave.js README.md bridge-config.json bridge-config.json.bak bridge-config.json.tmp start-bridge.sh install.sh bridge.log)\n\nsay()  { printf '%s\\n' \"$*\"; }\nwarn() { printf 'WARNING: %s\\n' \"$*\" \u003e&2; }\ndie()  { printf 'ERROR: %s\\n' \"$*\" \u003e&2; exit 1; }\n\nusage() {\n    if [ -n \"$SELF\" ] && [ -f \"$SELF\" ]; then\n        sed -n '2,/^# =====/p' \"$SELF\" 2\u003e/dev/null | sed -e 's/^# \\{0,1\\}//' -e '/^=====/d' || true\n    else\n        say \"Options: --allow host:port, --allow-any, --keep-allow, --port N, --listen IP, --allow-writes, --read-only, --origin URL,\"\n        say \"         --autostart, --no-start, --reset, --yes, --uninstall (see the README of the WTS Modbus bridge).\"\n    fi\n}\n\n# ---- validation (no shell metacharacters can get through) -------------------\nvalid_ipv4() {\n    local ip=\"$1\" i\n    [[ \"$ip\" =~ ^([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})$ ]] || return 1\n    for i in 1 2 3 4; do\n        (( 10#${BASH_REMATCH[$i]} \u003c= 255 )) || return 1\n    done\n    return 0\n}\nvalid_ipv6() {                      # hex digits, colons and dots only (no zone id), 2+ colons\n    local a=\"$1\" colons\n    [[ \"$a\" =~ ^[0-9A-Fa-f:.]{2,45}$ ]] || return 1\n    colons=\"${a//[^:]/}\"\n    [ \"${#colons}\" -ge 2 ]\n}\nvalid_host() {\n    local h=\"$1\" ip bits\n    if [ \"${#h}\" -lt 1 ] || [ \"${#h}\" -gt 253 ]; then return 1; fi\n    if [[ \"$h\" == \\[*\\] ]]; then valid_ipv6 \"${h:1:${#h}-2}\"; return; fi\n    if [[ \"$h\" == */* ]]; then\n        ip=\"${h%/*}\"; bits=\"${h##*/}\"\n        valid_ipv4 \"$ip\" || return 1\n        [[ \"$bits\" =~ ^[0-9]{1,2}$ ]] || return 1\n        (( 10#$bits \u003c= 32 )) || return 1\n        return 0\n    fi\n    if [[ \"$h\" =~ ^[0-9.]+$ ]]; then valid_ipv4 \"$h\"; return; fi\n    [[ \"$h\" =~ ^[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?$ ]] || return 1\n    [[ \"$h\" != *..* ]]\n}\nvalid_port() {\n    [[ \"$1\" =~ ^[0-9]{1,5}$ ]] || return 1\n    (( 10#$1 \u003e= 1 && 10#$1 \u003c= 65535 ))\n}\nvalid_target() {\n    local t=\"$1\"\n    [[ \"$t\" == *:* ]] || return 1\n    if [ \"${t%:*}\" = \"*\" ]; then [ \"${t##*:}\" = \"*\" ] || valid_port \"${t##*:}\"; return; fi\n    valid_host \"${t%:*}\" || return 1\n    [ \"${t##*:}\" = \"*\" ] || valid_port \"${t##*:}\"\n}\nnorm_target() {                     # a valid target -\u003e lower case, port without leading zeros\n    local t h p\n    t=\"$(printf '%s' \"$1\" | tr '[:upper:]' '[:lower:]')\"\n    h=\"${t%:*}\"; p=\"${t##*:}\"\n    if [ \"$p\" != \"*\" ]; then p=$((10#$p)); fi\n    printf '%s:%s' \"$h\" \"$p\"\n}\nvalid_listen() {\n    [ \"$1\" = \"localhost\" ] || valid_ipv4 \"$1\"\n}\nnorm_listen() {                     # \"localhost\" may resolve to ::1 only - the app uses 127.0.0.1\n    if [ \"$1\" = \"localhost\" ]; then printf '127.0.0.1'; else printf '%s' \"$1\"; fi\n}\nvalid_origin() {                    # null | file:// | http(s)://host[:port]\n    local o=\"$1\" re='^https?://([A-Za-z0-9._-]+|\\[[0-9A-Fa-f:.]+\\])(:([0-9]{1,5}))?$'\n    case \"$o\" in null|file://) return 0 ;; esac\n    [ \"${#o}\" -le 300 ] || return 1\n    [[ \"$o\" =~ $re ]] || return 1\n    if [ -n \"${BASH_REMATCH[3]:-}\" ]; then valid_port \"${BASH_REMATCH[3]}\" || return 1; fi\n    return 0\n}\nin_list() {                         # $1 in the remaining arguments?\n    local x=\"$1\" e\n    shift\n    for e in \"$@\"; do\n        if [ \"$e\" = \"$x\" ]; then return 0; fi\n    done\n    return 1\n}\n\nNEW_ALLOW=(); NEW_ORIGINS=()\nadd_allow() {                       # $1 = one entry or a comma-separated list\n    local item parts=()\n    IFS=',' read -r -a parts \u003c\u003c\u003c \"$1\"\n    for item in ${parts[@]+\"${parts[@]}\"}; do\n        item=\"${item//[[:space:]]/}\"\n        [ -n \"$item\" ] || continue\n        valid_target \"$item\" || die \"invalid --allow entry '$item' (use ip:port, ip/bits:port, hostname:port or [ipv6]:port; port 1-65535 or *)\"\n        item=\"$(norm_target \"$item\")\"\n        in_list \"$item\" ${NEW_ALLOW[@]+\"${NEW_ALLOW[@]}\"} || NEW_ALLOW+=(\"$item\")\n    done\n    return 0\n}\nadd_origin() {                      # $1 = one origin or a comma-separated list\n    local item parts=()\n    IFS=',' read -r -a parts \u003c\u003c\u003c \"$1\"\n    for item in ${parts[@]+\"${parts[@]}\"}; do\n        item=\"${item//[[:space:]]/}\"\n        [ -n \"$item\" ] || continue\n        valid_origin \"$item\" || die \"invalid --origin '$item' (use https://host[:port], http://host[:port], null or file://)\"\n        in_list \"$item\" ${NEW_ORIGINS[@]+\"${NEW_ORIGINS[@]}\"} || NEW_ORIGINS+=(\"$item\")\n    done\n    return 0\n}\n\n# ---- arguments ----------------------------------------------------------------\nCLI_PORT=\"\"; CLI_LISTEN=\"\"; CLI_WRITES=\"\"; KEEP_ALLOW=0; AUTOSTART=0; UNINSTALL=0; ASSUME_YES=0; NO_START=0; RESET=0\nif [ -n \"$PRESET_ALLOW\" ]; then add_allow \"$PRESET_ALLOW\"; fi\nif [ -n \"$PRESET_ORIGINS\" ]; then add_origin \"$PRESET_ORIGINS\"; fi\nif [ \"$PRESET_AUTOSTART\" = \"1\" ]; then AUTOSTART=1; fi\nwhile [ $# -gt 0 ]; do\n    case \"$1\" in\n        --allow)        [ $# -ge 2 ] || die \"--allow needs host:port\"; add_allow \"$2\"; shift 2 ;;\n        --allow=*)      add_allow \"${1#*=}\"; shift ;;\n        --origin)       [ $# -ge 2 ] || die \"--origin needs an origin\"; add_origin \"$2\"; shift 2 ;;\n        --origin=*)     add_origin \"${1#*=}\"; shift ;;\n        --port)         [ $# -ge 2 ] || die \"--port needs a number\"; CLI_PORT=\"$2\"; shift 2 ;;\n        --port=*)       CLI_PORT=\"${1#*=}\"; shift ;;\n        --listen)       [ $# -ge 2 ] || die \"--listen needs an address\"; CLI_LISTEN=\"$2\"; shift 2 ;;\n        --listen=*)     CLI_LISTEN=\"${1#*=}\"; shift ;;\n        --allow-any)    add_allow '*:*'; shift ;;\n        --keep-allow)   KEEP_ALLOW=1; shift ;;\n        --allow-writes) CLI_WRITES=1; shift ;;\n        --read-only)    CLI_WRITES=0; shift ;;\n        --autostart)    AUTOSTART=1; shift ;;\n        --no-start)     NO_START=1; shift ;;\n        --reset)        RESET=1; shift ;;\n        --uninstall)    UNINSTALL=1; shift ;;\n        -y|--yes)       ASSUME_YES=1; shift ;;\n        -h|--help)      usage; exit 0 ;;\n        *)              die \"unknown option '$1' (see: bash install.sh --help)\" ;;\n    esac\ndone\nif [ -n \"$CLI_PORT\" ]; then\n    valid_port \"$CLI_PORT\" || die \"invalid --port '$CLI_PORT' (1-65535)\"\n    CLI_PORT=$((10#$CLI_PORT))\nfi\nif [ -n \"$PRESET_PORT\" ]; then\n    valid_port \"$PRESET_PORT\" || die \"invalid preset port '$PRESET_PORT' (1-65535)\"\n    PRESET_PORT=$((10#$PRESET_PORT))\nfi\nif [ -n \"$CLI_LISTEN\" ]; then\n    valid_listen \"$CLI_LISTEN\" || die \"invalid --listen '$CLI_LISTEN' (an IPv4 address or localhost)\"\n    CLI_LISTEN=\"$(norm_listen \"$CLI_LISTEN\")\"\nfi\nif [ -n \"$PRESET_LISTEN\" ]; then\n    valid_listen \"$PRESET_LISTEN\" || die \"invalid preset listen address '$PRESET_LISTEN'\"\n    PRESET_LISTEN=\"$(norm_listen \"$PRESET_LISTEN\")\"\nfi\ncase \"$PRESET_ALLOW_WRITES\" in \"\"|0|1) ;; *) die \"invalid preset PRESET_ALLOW_WRITES '$PRESET_ALLOW_WRITES'\" ;; esac\n# Until the existing configuration is read (install) - used as they are by --uninstall.\nPORT=\"${CLI_PORT:-${PRESET_PORT:-$DEFAULT_PORT}}\"\nLISTEN=\"${CLI_LISTEN:-${PRESET_LISTEN:-127.0.0.1}}\"\n\n# ---- where things go -----------------------------------------------------------\n[ -n \"${HOME:-}\" ] || die \"HOME is not set\"\nPLIST=\"\"; UNIT_FILE=\"\"\ncase \"$(uname -s)\" in\n    Darwin)\n        OS=macos\n        INSTALL_DIR=\"$HOME/Library/Application Support/$APP_NAME\"\n        PLIST=\"$HOME/Library/LaunchAgents/$LABEL.plist\" ;;\n    Linux)\n        OS=linux\n        case \"${XDG_DATA_HOME:-}\" in /*) DATA_HOME=\"$XDG_DATA_HOME\" ;; *) DATA_HOME=\"$HOME/.local/share\" ;; esac\n        case \"${XDG_CONFIG_HOME:-}\" in /*) CONFIG_HOME=\"$XDG_CONFIG_HOME\" ;; *) CONFIG_HOME=\"$HOME/.config\" ;; esac\n        INSTALL_DIR=\"$DATA_HOME/wts-modbus-bridge\"\n        UNIT_FILE=\"$CONFIG_HOME/systemd/user/$UNIT_NAME\" ;;\n    *)\n        die \"unsupported system '$(uname -s)' - on Windows use install-windows.ps1\" ;;\nesac\nSCRIPT_DIR=\"\"\nif [ -n \"$SELF\" ]; then SCRIPT_DIR=\"$(cd \"$(dirname \"$SELF\")\" 2\u003e/dev/null && pwd)\" || SCRIPT_DIR=\".\"; fi\nNODE_BIN=\"\"\nHEALTH_HOST=\"\"\nset_health_host() {\n    HEALTH_HOST=\"$LISTEN\"\n    if [ \"$HEALTH_HOST\" = \"0.0.0.0\" ]; then HEALTH_HOST=127.0.0.1; fi\n}\nset_health_host\n\n# ---- helpers -------------------------------------------------------------------\nconfirm() {                         # $1 = question; yes only with --yes or a typed y\n    local ans=\"\"\n    if [ \"$ASSUME_YES\" = 1 ]; then return 0; fi\n    if [ ! -t 0 ]; then return 1; fi\n    printf '%s [y/N] ' \"$1\"\n    read -r ans || return 1\n    case \"$ans\" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac\n}\nnode_major() {\n    \"$1\" -p 'process.versions.node.split(\".\")[0]' 2\u003e/dev/null || printf '0'\n}\nfind_node() {\n    local c\n    NODE_BIN=\"$(command -v node 2\u003e/dev/null || true)\"\n    if [ -z \"$NODE_BIN\" ]; then\n        for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do\n            if [ -x \"$c\" ]; then NODE_BIN=\"$c\"; break; fi\n        done\n    fi\n    return 0\n}\nnode_ok() {\n    local major\n    [ -n \"$NODE_BIN\" ] || return 1\n    major=\"$(node_major \"$NODE_BIN\")\"\n    [[ \"$major\" =~ ^[0-9]+$ ]] || return 1\n    [ \"$major\" -ge \"$NODE_MIN\" ]\n}\nnode_help() {\n    say \"Install Node.js $NODE_MIN or newer (the LTS version), then run this installer again:\"\n    if [ \"$OS\" = macos ]; then\n        say \"  - Homebrew:   brew install node\"\n        say \"  - or the macOS installer from https://nodejs.org\"\n    else\n        say \"  - your distribution's nodejs package if it is version $NODE_MIN or newer\"\n        say \"    (Debian/Ubuntu: sudo apt-get install nodejs;  Fedora: sudo dnf install nodejs)\"\n        say \"  - or the Linux binaries / package instructions on https://nodejs.org\"\n    fi\n}\nensure_node() {\n    local have\n    find_node\n    if node_ok; then return 0; fi\n    if [ -n \"$NODE_BIN\" ]; then have=\"version $(node_major \"$NODE_BIN\") at $NODE_BIN\"; else have=\"not found\"; fi\n    say \"Node.js $NODE_MIN or newer is needed to run the bridge (Node.js: $have).\"\n    local sudo_cmd=() cmd=()\n    if [ \"$(id -u)\" != \"0\" ]; then sudo_cmd=(sudo); fi\n    if [ \"$OS\" = macos ]; then\n        if command -v brew \u003e/dev/null 2\u003e&1; then cmd=(brew install node); fi\n    elif command -v apt-get \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} apt-get install -y nodejs)\n    elif command -v dnf \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} dnf install -y nodejs)\n    elif command -v yum \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} yum install -y nodejs)\n    elif command -v pacman \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} pacman -S --needed --noconfirm nodejs)\n    elif command -v apk \u003e/dev/null 2\u003e&1; then cmd=(${sudo_cmd[@]+\"${sudo_cmd[@]}\"} apk add nodejs)\n    fi\n    if [ ${#cmd[@]} -eq 0 ]; then node_help; exit 1; fi\n    if ! confirm \"Install Node.js now with:  ${cmd[*]}  ?\"; then node_help; exit 1; fi\n    \"${cmd[@]}\" || { warn \"the package manager reported an error\"; node_help; exit 1; }\n    hash -r 2\u003e/dev/null || true\n    find_node\n    if ! node_ok; then\n        say \"The installed Node.js is still older than $NODE_MIN (or not on PATH).\"\n        node_help\n        exit 1\n    fi\n    return 0\n}\nsha256_of() {\n    \"$NODE_BIN\" -e 'process.stdout.write(require(\"crypto\").createHash(\"sha256\").update(require(\"fs\").readFileSync(process.argv[1])).digest(\"hex\"))' \"$1\"\n}\ndecode_b64_to() {                   # stdin: base64 text; $1: destination file\n    \"$NODE_BIN\" -e 'const fs=require(\"fs\");let s=\"\";process.stdin.setEncoding(\"utf8\");process.stdin.on(\"data\",(d)=\u003e{s+=d;});process.stdin.on(\"end\",()=\u003e{fs.writeFileSync(process.argv[1],Buffer.from(s.replace(/[^A-Za-z0-9+\\/=]/g,\"\"),\"base64\"));});' \"$1\"\n}\nfetch_health() {                    # prints the /health JSON; fails when nothing answers\n    local url=\"http://$HEALTH_HOST:$PORT/health\"\n    if command -v curl \u003e/dev/null 2\u003e&1; then\n        curl -fsS --max-time 2 --noproxy '*' \"$url\" 2\u003e/dev/null\n    elif [ -n \"$NODE_BIN\" ]; then\n        \"$NODE_BIN\" -e 'const r=require(\"http\").get(process.argv[1],{timeout:2000},(res)=\u003e{let s=\"\";res.on(\"data\",(d)=\u003e{s+=d;});res.on(\"end\",()=\u003e{if(res.statusCode!==200)process.exit(1);process.stdout.write(s);});});r.on(\"timeout\",()=\u003e{r.destroy();process.exit(1);});r.on(\"error\",()=\u003eprocess.exit(1));' \"$url\"\n    else\n        return 1\n    fi\n}\nport_in_use() {                     # anything (a bridge or another program) listening on the port?\n    \"$NODE_BIN\" -e 'const s=require(\"net\").connect({host:process.argv[1],port:+process.argv[2]});s.setTimeout(1500);s.on(\"connect\",()=\u003e{s.destroy();process.exit(0);});s.on(\"timeout\",()=\u003e{s.destroy();process.exit(1);});s.on(\"error\",()=\u003eprocess.exit(1));' \"$HEALTH_HOST\" \"$PORT\"\n}\ndescribe_health() {                 # stdin: /health JSON\n    \"$NODE_BIN\" -e 'let s=\"\";process.stdin.on(\"data\",(d)=\u003e{s+=d;});process.stdin.on(\"end\",()=\u003e{try{const h=JSON.parse(s);process.stdout.write(\"v\"+h.version+\", \"+(h.readOnly?\"read-only\":\"writes ALLOWED\")+\", port \"+h.port+\"; allowed targets: \"+((h.allow||[]).join(\", \")||\"(none)\"));}catch(e){process.stdout.write(\"(unexpected reply)\");}});'\n}\nverify_health() {                   # is the bridge that answered the one just configured?\n    printf '%s' \"$HEALTH_JSON\" | \"$NODE_BIN\" -e '\nconst a=process.argv.slice(1);const {parseAllow}=require(a[0]);const port=+a[1],readOnly=a[2]!==\"1\";\nconst spec=(x)=\u003e{try{return parseAllow(x).spec;}catch(e){return String(x).toLowerCase();}};\nconst want=a.slice(3).map(spec).sort();let s=\"\";\nprocess.stdin.on(\"data\",(d)=\u003e{s+=d;});\nprocess.stdin.on(\"end\",()=\u003e{let h;try{h=JSON.parse(s);}catch(e){process.exit(1);}\nconst got=(Array.isArray(h.allow)?h.allow:[]).map((x)=\u003eString(x).toLowerCase()).sort();\nprocess.exit(h.port===port&&h.readOnly===readOnly&&JSON.stringify(got)===JSON.stringify(want)?0:1);});' \\\n        \"$INSTALL_DIR/modbus-bridge.js\" \"$PORT\" \"$ALLOW_WRITES\" ${ALLOW_LIST[@]+\"${ALLOW_LIST[@]}\"}\n}\nwait_health() {                     # $1 = seconds; $2 = pid to watch (optional)\n    local tries=$(( $1 * 4 )) json\n    while [ \"$tries\" -gt 0 ]; do\n        if json=\"$(fetch_health)\"; then\n            HEALTH_JSON=\"$json\"\n            return 0\n        fi\n        if [ -n \"${2:-}\" ] && ! kill -0 \"$2\" 2\u003e/dev/null; then return 1; fi\n        sleep 0.25\n        tries=$(( tries - 1 ))\n    done\n    return 1\n}\nxml_escape() {\n    printf '%s' \"$1\" | sed -e 's/&/\\&amp;/g' -e 's/\u003c/\\&lt;/g' -e 's/\u003e/\\&gt;/g'\n}\nsystemd_quote() {                   # one ExecStart= argument in double quotes, with \\ \" $ % escaped\n    local s\n    # shellcheck disable=SC2016\n    s=\"$(printf '%s' \"$1\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g' -e 's/\\$/$$/g' -e 's/%/%%/g')\"\n    printf '\"%s\"' \"$s\"\n}\nsystemd_user_ok() {\n    command -v systemctl \u003e/dev/null 2\u003e&1 && systemctl --user show-environment \u003e/dev/null 2\u003e&1\n}\nautostart_installed() {\n    if [ \"$OS\" = macos ]; then [ -f \"$PLIST\" ]; else [ -f \"$UNIT_FILE\" ]; fi\n}\nconfigured_port() {                 # port from an existing bridge-config.json (for --uninstall)\n    local f=\"$INSTALL_DIR/bridge-config.json\" p=\"\"\n    if [ -f \"$f\" ]; then\n        p=\"$(sed -n 's/.*\"port\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' \"$f\" | head -n 1)\"\n    fi\n    if valid_port \"${p:-x}\"; then printf '%s' \"$((10#$p))\"; else printf '%s' \"$PORT\"; fi\n}\nour_bridge_pids() {                 # this user's bridges running from the install folder\n    local js=\"$INSTALL_DIR/modbus-bridge.js\" me uid pid args\n    me=\"$(id -u)\"\n    { ps -A -ww -o uid= -o pid= -o args= 2\u003e/dev/null || true; } | while read -r uid pid args; do\n        if [ \"$uid\" = \"$me\" ] && [ \"$pid\" != \"$$\" ]; then\n            case \"$args\" in *\"$js\"*) printf '%s\\n' \"$pid\" ;; esac\n        fi\n    done\n    return 0\n}\nstop_our_bridges() {                # an earlier foreground install, start-bridge.sh or the auto-start service\n    local pids pid n=0 i\n    if autostart_installed; then\n        if [ \"$OS\" = macos ]; then\n            launchctl bootout \"gui/$(id -u)/$LABEL\" \u003e/dev/null 2\u003e&1 || true\n        elif systemd_user_ok; then\n            systemctl --user stop \"$UNIT_NAME\" \u003e/dev/null 2\u003e&1 || true\n        fi\n    fi\n    pids=\"$(our_bridge_pids)\"\n    for pid in $pids; do\n        if kill \"$pid\" 2\u003e/dev/null; then n=$((n + 1)); fi\n    done\n    if [ \"$n\" -gt 0 ]; then\n        for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do\n            if [ -z \"$(our_bridge_pids)\" ]; then break; fi\n            sleep 0.25\n        done\n        say \"Stopped $n bridge process(es) started from $INSTALL_DIR\"\n    fi\n    return 0\n}\n\n# ---- uninstall -----------------------------------------------------------------\nstop_autostart() {\n    if [ \"$OS\" = macos ]; then\n        if [ -f \"$PLIST\" ]; then\n            launchctl bootout \"gui/$(id -u)/$LABEL\" \u003e/dev/null 2\u003e&1 || launchctl unload \"$PLIST\" \u003e/dev/null 2\u003e&1 || true\n        fi\n    elif [ -f \"$UNIT_FILE\" ] && systemd_user_ok; then\n        systemctl --user disable --now \"$UNIT_NAME\" \u003e/dev/null 2\u003e&1 || true\n    fi\n    return 0\n}\ndo_uninstall() {\n    local f removed=0 pid\n    PORT=\"$(configured_port)\"\n    stop_autostart\n    for pid in $(our_bridge_pids); do kill \"$pid\" 2\u003e/dev/null || true; done\n    if [ \"$OS\" = macos ] && [ -f \"$PLIST\" ]; then rm -f \"$PLIST\"; say \"Removed the LaunchAgent $PLIST\"; fi\n    if [ \"$OS\" = linux ] && [ -f \"$UNIT_FILE\" ]; then\n        rm -f \"$UNIT_FILE\"; say \"Removed the systemd --user service $UNIT_FILE\"\n        if systemd_user_ok; then systemctl --user daemon-reload \u003e/dev/null 2\u003e&1 || true; fi\n    fi\n    if [ -d \"$INSTALL_DIR\" ]; then\n        for f in \"${INSTALLED_FILES[@]}\"; do\n            if [ -e \"$INSTALL_DIR/$f\" ]; then rm -f \"$INSTALL_DIR/$f\"; removed=$((removed + 1)); fi\n        done\n        if rmdir \"$INSTALL_DIR\" 2\u003e/dev/null; then say \"Removed $INSTALL_DIR ($removed files)\"\n        else warn \"$INSTALL_DIR still contains other files - left in place\"; fi\n    else\n        say \"Nothing installed in $INSTALL_DIR\"\n    fi\n    find_node\n    sleep 0.5\n    if fetch_health \u003e/dev/null 2\u003e&1; then\n        warn \"a bridge still answers on port $PORT (started by hand?) - close its terminal window or press Ctrl+C there.\"\n    fi\n    say \"The WTS Modbus bridge is uninstalled.\"\n}\n\nif [ \"$UNINSTALL\" = 1 ]; then do_uninstall; exit 0; fi\n\n# ---- install -------------------------------------------------------------------\nensure_node\n\n# The existing bridge-config.json supplies the defaults, so running the installer again (for\n# one more device, or --allow-writes) never drops the other targets or changes the port.\nOLD_ALLOW=(); OLD_PORT=\"\"; OLD_LISTEN=\"\"; OLD_WRITES=\"\"; OLD_MODE=\"\"; HAVE_OLD=0\nread_existing_config() {\n    local f=\"$INSTALL_DIR/bridge-config.json\" out key val re='^[][A-Za-z0-9._:/*-]+$'\n    [ -f \"$f\" ] || return 0\n    if ! out=\"$(\"$NODE_BIN\" -e '\nconst fs=require(\"fs\");let c;\ntry{c=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\").replace(/^\\uFEFF/,\"\"));}catch(e){process.exit(3);}\nif(!c||typeof c!==\"object\"||Array.isArray(c))process.exit(3);\nconst safe=(s)=\u003etypeof s===\"string\"&&/^[\\x21-\\x7e]{1,300}$/.test(s.trim());\n(Array.isArray(c.allow)?c.allow:[]).forEach((x)=\u003econsole.log(safe(x)?\"allow \"+x.trim():\"bad \"+JSON.stringify(x).slice(0,60).replace(/[^\\x20-\\x7e]/g,\"?\")));\nif(Number.isInteger(c.port))console.log(\"port \"+c.port);\nif(safe(c.listen))console.log(\"listen \"+c.listen.trim());\nif(typeof c.allowWrites===\"boolean\")console.log(\"writes \"+(c.allowWrites?1:0));\nif(c.allowMode===\"any\"||c.allowMode===\"list\")console.log(\"mode \"+c.allowMode);' \"$f\")\"; then\n        warn \"$f could not be read (not valid JSON?) - writing a new one (the old file is kept as bridge-config.json.bak).\"\n        return 0\n    fi\n    HAVE_OLD=1\n    while IFS=' ' read -r key val; do\n        case \"$key\" in\n            allow)\n                if valid_target \"$val\"; then val=\"$(norm_target \"$val\")\"\n                elif ! [[ \"$val\" =~ $re ]]; then warn \"left out '$val' from the existing allow list (not a host:port target)\"; continue; fi\n                in_list \"$val\" ${OLD_ALLOW[@]+\"${OLD_ALLOW[@]}\"} || OLD_ALLOW+=(\"$val\") ;;\n            bad)    warn \"left out $val from the existing allow list (not a host:port target)\" ;;\n            port)   if valid_port \"$val\"; then OLD_PORT=$((10#$val)); fi ;;\n            listen) if valid_listen \"$val\"; then OLD_LISTEN=\"$(norm_listen \"$val\")\"; else warn \"the existing listen address '$val' is not an IPv4 address or localhost - not kept\"; fi ;;\n            writes) OLD_WRITES=\"$val\" ;;\n            mode)   OLD_MODE=\"$val\" ;;\n        esac\n    done \u003c\u003c\u003c \"$out\"\n    return 0\n}\nif [ \"$RESET\" != 1 ]; then read_existing_config; fi\n# The allow list: --allow-any (or '*:*') = any device; --allow targets are added to the old list\n# (an \"any\" list starts empty); --keep-allow or a file with \"allowMode\" (v1.2.1+) keeps the old\n# list; the list of an older installer (no \"allowMode\") is replaced by any device.\nALLOW_LIST=(); MIGRATED=\"\"\nold_is_any() { [ ${#OLD_ALLOW[@]} -eq 0 ] || in_list '*:*' \"${OLD_ALLOW[@]}\"; }\nadd_to_list() {\n    local e\n    for e in \"$@\"; do in_list \"$e\" ${ALLOW_LIST[@]+\"${ALLOW_LIST[@]}\"} || ALLOW_LIST+=(\"$e\"); done\n    return 0\n}\nif in_list '*:*' ${NEW_ALLOW[@]+\"${NEW_ALLOW[@]}\"}; then\n    ALLOW_LIST=('*:*')\nelif [ ${#NEW_ALLOW[@]} -gt 0 ]; then\n    if ! old_is_any; then add_to_list \"${OLD_ALLOW[@]}\"; fi\n    add_to_list \"${NEW_ALLOW[@]}\"\nelif old_is_any; then\n    :\nelif [ \"$KEEP_ALLOW\" = 1 ] || [ -n \"$OLD_MODE\" ]; then\n    add_to_list \"${OLD_ALLOW[@]}\"\nelse\n    for e in \"${OLD_ALLOW[@]}\"; do MIGRATED=\"${MIGRATED:+$MIGRATED, }$e\"; done\nfi\nPORT=\"${CLI_PORT:-${PRESET_PORT:-${OLD_PORT:-$DEFAULT_PORT}}}\"\nLISTEN=\"${CLI_LISTEN:-${PRESET_LISTEN:-${OLD_LISTEN:-127.0.0.1}}}\"\nALLOW_WRITES=\"${CLI_WRITES:-${PRESET_ALLOW_WRITES:-${OLD_WRITES:-0}}}\"\nset_health_host\nif [ -n \"$MIGRATED\" ]; then\n    say \"Keeping the settings of the existing $INSTALL_DIR/bridge-config.json (port, listen address, writes, origins).\"\n    say \"Allow-list $MIGRATED replaced by any device (default since 1.2). Use --keep-allow to keep it.\"\nelif [ \"$HAVE_OLD\" = 1 ] && old_is_any; then\n    say \"Keeping the settings of the existing $INSTALL_DIR/bridge-config.json (any device; --allow \u003cip\u003e:\u003cport\u003e restricts it, --reset starts a new file).\"\nelif [ \"$HAVE_OLD\" = 1 ]; then\n    say \"Keeping the settings of the existing $INSTALL_DIR/bridge-config.json (${#OLD_ALLOW[@]} target(s); new targets are added - --reset starts a new list).\"\nfi\nif [ ${#ALLOW_LIST[@]} -eq 0 ] || in_list '*:*' \"${ALLOW_LIST[@]}\"; then\n    ALLOW_LIST=('*:*'); ALLOW_MODE=any\n    if [ ${#NEW_ALLOW[@]} -eq 0 ]; then\n        say \"No --allow targets given: the bridge will allow any device IP / port (default). Give --allow \u003cip\u003e:\u003cport\u003e to restrict it.\"\n    fi\nelse\n    ALLOW_MODE=list\nfi\n\ninstall_files() {\n    local f want got names=()\n    mkdir -p \"$INSTALL_DIR\"\n    if [ -n \"$EMBEDDED_FILES\" ]; then\n        read -r -a names \u003c\u003c\u003c \"$EMBEDDED_FILES\"\n        for f in ${names[@]+\"${names[@]}\"}; do\n            embedded_b64 \"$f\" | decode_b64_to \"$INSTALL_DIR/$f\"\n            want=\"$(embedded_sha256 \"$f\")\"\n            got=\"$(sha256_of \"$INSTALL_DIR/$f\")\"\n            [ \"$want\" = \"$got\" ] || die \"$f: SHA-256 mismatch after unpacking (installer damaged?) - download it again from the app\"\n        done\n        say \"Unpacked bridge v$EMBEDDED_VERSION (SHA-256 verified)\"\n    else\n        [ -n \"$SCRIPT_DIR\" ] || die \"this installer has no bridge files built in - piped into bash, use the release installer: curl -fsSL https://github.com/h2oil/well-testing-suite/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes\"\n        [ -f \"$SCRIPT_DIR/modbus-bridge.js\" ] || die \"modbus-bridge.js was not found next to this installer ($SCRIPT_DIR). Download the bridge package from the app's Modbus page, unzip it and run install.sh from that folder.\"\n        for f in modbus-bridge.js fake-slave.js README.md; do\n            if [ -f \"$SCRIPT_DIR/$f\" ] && ! [ \"$SCRIPT_DIR/$f\" -ef \"$INSTALL_DIR/$f\" ]; then\n                cp \"$SCRIPT_DIR/$f\" \"$INSTALL_DIR/$f\"\n            fi\n        done\n    fi\n    if [ -n \"$SELF\" ] && [ -f \"$SELF\" ] && ! [ \"$SELF\" -ef \"$INSTALL_DIR/install.sh\" ]; then\n        cp \"$SELF\" \"$INSTALL_DIR/install.sh\"\n    fi\n    chmod 644 \"$INSTALL_DIR/modbus-bridge.js\"\n    if [ -f \"$INSTALL_DIR/install.sh\" ]; then chmod 755 \"$INSTALL_DIR/install.sh\"; fi\n    return 0\n}\nwrite_config() {                    # JSON written by node; origins / anyOrigin / verbose of the old file kept\n    local f=\"$INSTALL_DIR/bridge-config.json\" tmp=\"$INSTALL_DIR/bridge-config.json.tmp\"\n    \"$NODE_BIN\" -e '\nconst fs=require(\"fs\");const a=process.argv.slice(1);\nconst f=a[0],tmp=a[1],reset=a[2]===\"1\",port=+a[3],listen=a[4],writes=a[5]===\"1\",mode=a[6],n=+a[7];\nconst allow=a.slice(8,8+n),newOrigins=a.slice(8+n);let old={};\nif(!reset){try{const o=JSON.parse(fs.readFileSync(f,\"utf8\").replace(/^\\uFEFF/,\"\"));if(o&&typeof o===\"object\"&&!Array.isArray(o))old=o;}catch(e){}}\nconst seen=new Set(),origins=[];\n(Array.isArray(old.origins)?old.origins:[]).concat(newOrigins).forEach((o)=\u003e{if(typeof o!==\"string\"||!o.trim())return;const k=o.trim().toLowerCase();if(!seen.has(k)){seen.add(k);origins.push(o.trim());}});\nconst out={_comment:\"WTS Modbus bridge settings. allow = the host:port targets the bridge may connect to (*:* = any device; allowMode any or list). Running the installer again keeps these settings and adds new --allow targets (--allow-any = any device, --reset starts over). Restart the bridge after editing.\",\n  allow:allow,allowMode:mode,port:port,listen:listen,origins:origins,anyOrigin:old.anyOrigin===true,allowWrites:writes,verbose:old.verbose===true};\nfs.writeFileSync(tmp,JSON.stringify(out,null,2)+\"\\n\");' \\\n        \"$f\" \"$tmp\" \"$RESET\" \"$PORT\" \"$LISTEN\" \"$ALLOW_WRITES\" \"$ALLOW_MODE\" \"${#ALLOW_LIST[@]}\" \\\n        ${ALLOW_LIST[@]+\"${ALLOW_LIST[@]}\"} ${NEW_ORIGINS[@]+\"${NEW_ORIGINS[@]}\"}\n    if [ -f \"$f\" ] && ! cmp -s \"$f\" \"$tmp\"; then cp \"$f\" \"$f.bak\"; fi\n    mv \"$tmp\" \"$f\"\n    return 0\n}\nwrite_start_script() {\n    local f=\"$INSTALL_DIR/start-bridge.sh\" q_node q_js q_cfg\n    q_node=\"$(printf '%q' \"$NODE_BIN\")\"\n    q_js=\"$(printf '%q' \"$INSTALL_DIR/modbus-bridge.js\")\"\n    q_cfg=\"$(printf '%q' \"$INSTALL_DIR/bridge-config.json\")\"\n    {\n        printf '#!/usr/bin/env bash\\n'\n        printf '# Starts the WTS Modbus bridge with bridge-config.json (written by install.sh).\\n'\n        printf '# Extra options are passed on, e.g.  start-bridge.sh --verbose\\n'\n        # shellcheck disable=SC2016\n        printf 'exec %s %s --config %s \"$@\"\\n' \"$q_node\" \"$q_js\" \"$q_cfg\"\n    } \u003e \"$f\"\n    chmod 755 \"$f\"\n    return 0\n}\nlaunchagent_load() {                # (re)load the LaunchAgent - it starts the bridge now (RunAtLoad)\n    local uid i\n    uid=\"$(id -u)\"\n    launchctl bootout \"gui/$uid/$LABEL\" \u003e/dev/null 2\u003e&1 || true\n    for i in 1 2 3 4 5; do\n        if launchctl bootstrap \"gui/$uid\" \"$PLIST\" \u003e/dev/null 2\u003e&1; then break; fi\n        if [ \"$i\" = 5 ]; then\n            launchctl unload \"$PLIST\" \u003e/dev/null 2\u003e&1 || true\n            launchctl load -w \"$PLIST\" \u003e/dev/null 2\u003e&1 || return 1\n        fi\n        sleep 1\n    done\n    launchctl kickstart -k \"gui/$uid/$LABEL\" \u003e/dev/null 2\u003e&1 || true\n    return 0\n}\nsetup_launchagent() {               # $1 = 1: start it now as well\n    mkdir -p \"$(dirname \"$PLIST\")\"\n    cat \u003e \"$PLIST\" \u003c\u003cEOF\n\u003c?xml version=\"1.0\" encoding=\"UTF-8\"?\u003e\n\u003c!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"\u003e\n\u003cplist version=\"1.0\"\u003e\n\u003cdict\u003e\n  \u003ckey\u003eLabel\u003c/key\u003e\u003cstring\u003e$LABEL\u003c/string\u003e\n  \u003ckey\u003eProgramArguments\u003c/key\u003e\n  \u003carray\u003e\n    \u003cstring\u003e$(xml_escape \"$NODE_BIN\")\u003c/string\u003e\n    \u003cstring\u003e$(xml_escape \"$INSTALL_DIR/modbus-bridge.js\")\u003c/string\u003e\n    \u003cstring\u003e--config\u003c/string\u003e\n    \u003cstring\u003e$(xml_escape \"$INSTALL_DIR/bridge-config.json\")\u003c/string\u003e\n  \u003c/array\u003e\n  \u003ckey\u003eWorkingDirectory\u003c/key\u003e\u003cstring\u003e$(xml_escape \"$INSTALL_DIR\")\u003c/string\u003e\n  \u003ckey\u003eRunAtLoad\u003c/key\u003e\u003ctrue/\u003e\n  \u003ckey\u003eKeepAlive\u003c/key\u003e\u003cdict\u003e\u003ckey\u003eSuccessfulExit\u003c/key\u003e\u003cfalse/\u003e\u003c/dict\u003e\n  \u003ckey\u003eThrottleInterval\u003c/key\u003e\u003cinteger\u003e10\u003c/integer\u003e\n  \u003ckey\u003eProcessType\u003c/key\u003e\u003cstring\u003eBackground\u003c/string\u003e\n  \u003ckey\u003eStandardOutPath\u003c/key\u003e\u003cstring\u003e$(xml_escape \"$INSTALL_DIR/bridge.log\")\u003c/string\u003e\n  \u003ckey\u003eStandardErrorPath\u003c/key\u003e\u003cstring\u003e$(xml_escape \"$INSTALL_DIR/bridge.log\")\u003c/string\u003e\n\u003c/dict\u003e\n\u003c/plist\u003e\nEOF\n    if [ \"${1:-1}\" = 1 ]; then\n        launchagent_load || die \"launchctl could not load $PLIST\"\n        say \"LaunchAgent installed: $PLIST (starts at login; log: $INSTALL_DIR/bridge.log)\"\n    else\n        say \"LaunchAgent installed: $PLIST - the bridge starts at the next login (log: $INSTALL_DIR/bridge.log)\"\n    fi\n    return 0\n}\nsetup_systemd() {                   # $1 = 1: start it now as well\n    mkdir -p \"$(dirname \"$UNIT_FILE\")\"\n    cat \u003e \"$UNIT_FILE\" \u003c\u003cEOF\n[Unit]\nDescription=WTS Modbus Bridge (WebSocket to Modbus TCP)\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=$(systemd_quote \"$NODE_BIN\") $(systemd_quote \"$INSTALL_DIR/modbus-bridge.js\") --config $(systemd_quote \"$INSTALL_DIR/bridge-config.json\")\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\nEOF\n    systemctl --user daemon-reload\n    systemctl --user enable \"$UNIT_NAME\" \u003e/dev/null 2\u003e&1 || die \"systemctl --user enable $UNIT_NAME failed\"\n    if [ \"${1:-1}\" = 1 ]; then\n        systemctl --user restart \"$UNIT_NAME\" || die \"systemctl --user restart $UNIT_NAME failed (see: journalctl --user -u $UNIT_NAME)\"\n        say \"systemd --user service installed: $UNIT_FILE (starts at login)\"\n    else\n        say \"systemd --user service installed and enabled: $UNIT_FILE - the bridge starts at the next login\"\n        say \"  (or now with: systemctl --user start $UNIT_NAME)\"\n    fi\n    say \"  status: systemctl --user status $UNIT_NAME    log: journalctl --user -u $UNIT_NAME\"\n    say \"  to keep it running while you are logged out: loginctl enable-linger \\\"\\$USER\\\"\"\n    return 0\n}\nrestart_existing_autostart() {      # succeeds when the auto-start bridge was restarted\n    if [ \"$OS\" = macos ]; then\n        launchagent_load\n    else\n        systemd_user_ok && systemctl --user restart \"$UNIT_NAME\"\n    fi\n}\nnext_steps() {\n    say \"\"\n    say \"Next steps in the Well Testing Suite (Modbus Config page):\"\n    say \"  1. For each device choose transport \\\"Modbus TCP via WebSocket bridge\\\", enter the\"\n    say \"     PLC's IP address and port, and the bridge URL ws://$HEALTH_HOST:$PORT\"\n    say \"  2. Press \\\"Check bridge\\\" in the setup guide, then \\\"Test\\\" on the device row.\"\n    say \"\"\n    say \"Installed in:  $INSTALL_DIR\"\n    say \"Settings:      $INSTALL_DIR/bridge-config.json (restart the bridge after editing)\"\n    say \"Allow list:    bash \\\"$INSTALL_DIR/install.sh\\\" --allow \u003cip\u003e:\u003cport\u003e   (only listed devices; adds to the list)  or  --allow-any\"\n    say \"Start by hand: \\\"$INSTALL_DIR/start-bridge.sh\\\"\"\n    say \"Uninstall:     bash \\\"$INSTALL_DIR/install.sh\\\" --uninstall\"\n}\nreport_running() {\n    say \"\"\n    say \"OK: the WTS Modbus bridge is running - $(printf '%s' \"$HEALTH_JSON\" | describe_health)\"\n    say \"    health check: http://$HEALTH_HOST:$PORT/health\"\n}\ncheck_running() {                   # after wait_health: the answer must come from the bridge just configured\n    if ! verify_health; then\n        if [ -n \"${BRIDGE_PID:-}\" ]; then kill \"$BRIDGE_PID\" 2\u003e/dev/null || true; fi\n        die \"the bridge answering on port $PORT is not the one just installed ($(printf '%s' \"$HEALTH_JSON\" | describe_health)). Another bridge may be running: stop it and run the installer again.\"\n    fi\n    report_running\n}\n\nHEALTH_JSON=\"\"\n# Before anything is written: stop the bridges of an earlier install, then the port must be free\n# (otherwise the new bridge could not start, and the settings on disk would not match the bridge\n# that answers).\nif [ \"$NO_START\" != 1 ]; then\n    stop_our_bridges\n    if port_in_use; then\n        if HEALTH_JSON=\"$(fetch_health)\"; then\n            die \"another WTS Modbus bridge already answers on http://$HEALTH_HOST:$PORT ($(printf '%s' \"$HEALTH_JSON\" | describe_health)) - it was not started by this install (a bridge started by hand?). Stop it first (Ctrl+C in its window), or install with --port \u003cother\u003e. Nothing was changed.\"\n        fi\n        die \"another program already uses port $PORT on $HEALTH_HOST. Stop it, or install with --port \u003cother\u003e (and use that port in the device bridge URL). Nothing was changed.\"\n    fi\nfi\ninstall_files\nwrite_config\nwrite_start_script\nMODE=\"read-only\"\nif [ \"$ALLOW_WRITES\" = 1 ]; then MODE=\"writes ALLOWED\"; fi\nsay \"Installed the WTS Modbus bridge in $INSTALL_DIR\"\nsay \"  allowed targets: ${ALLOW_LIST[*]:-(none)}   port: $PORT   $MODE\"\n\nif [ \"$AUTOSTART\" = 1 ]; then\n    START_NOW=1\n    if [ \"$NO_START\" = 1 ]; then START_NOW=0; fi\n    if [ \"$OS\" = macos ]; then\n        setup_launchagent \"$START_NOW\"\n    elif systemd_user_ok; then\n        setup_systemd \"$START_NOW\"\n    else\n        warn \"systemd --user is not available here (no user session bus - e.g. WSL, a container or an SSH-only login), so auto-start was not set up.\"\n        say \"  Start the bridge yourself with \\\"$INSTALL_DIR/start-bridge.sh\\\", or add that command to your\"\n        say \"  desktop's Startup Applications (or 'crontab -e' with: @reboot \\\"$INSTALL_DIR/start-bridge.sh\\\").\"\n        if [ \"$NO_START\" != 1 ]; then say \"  Starting it in this window now.\"; fi\n        AUTOSTART=0\n    fi\nelif [ \"$NO_START\" != 1 ] && autostart_installed; then\n    if restart_existing_autostart; then\n        say \"Restarted the auto-start bridge from an earlier install with the new settings.\"\n        AUTOSTART=1\n    else\n        warn \"could not restart the auto-start bridge from an earlier install - starting one in this window.\"\n    fi\nfi\n\nif [ \"$NO_START\" = 1 ]; then next_steps; exit 0; fi\n\nif [ \"$AUTOSTART\" = 1 ]; then\n    if wait_health 15; then check_running\n    else warn \"the bridge did not answer on http://$HEALTH_HOST:$PORT/health within 15 s - check the log (see above).\"; fi\n    next_steps\n    exit 0\nfi\n\n# Foreground: run the bridge from this terminal, check it, then wait until Ctrl+C.\n\"$INSTALL_DIR/start-bridge.sh\" &\nBRIDGE_PID=$!\nstop_bridge() {\n    trap - INT TERM HUP\n    kill \"$BRIDGE_PID\" 2\u003e/dev/null || true\n    wait \"$BRIDGE_PID\" 2\u003e/dev/null || true\n    say \"\"\n    say \"Bridge stopped.\"\n    exit 0\n}\ntrap stop_bridge INT TERM HUP\nif wait_health 15 \"$BRIDGE_PID\"; then\n    check_running\n    next_steps\n    say \"\"\n    say \"The bridge runs in this window - leave it open while you use the app; Ctrl+C stops it.\"\n    say \"(Install with --autostart to start it automatically at login instead.)\"\nelse\n    if kill -0 \"$BRIDGE_PID\" 2\u003e/dev/null; then\n        warn \"the bridge did not answer on http://$HEALTH_HOST:$PORT/health within 15 s.\"\n    else\n        wait \"$BRIDGE_PID\" 2\u003e/dev/null || true\n        die \"the bridge stopped (see the message above).\"\n    fi\nfi\nset +e\nwait \"$BRIDGE_PID\"\ncode=$?\nset -e\ntrap - INT TERM HUP\nsay \"\"\nsay \"The bridge stopped (exit code $code) - it was stopped from outside this window, or a new install replaced it.\"\nexit \"$code\"\n}\n",
        "README.md": "# Modbus bridge (WebSocket ↔ Modbus TCP)\n\nWeb browsers cannot open raw TCP sockets, so the web build of the Well Testing Suite reaches\nModbus TCP equipment (PLCs, RTUs, flow computers, serial-to-Ethernet gateways) through this small\nbridge. It runs on a PC on the same network as the equipment. The iOS app does not need it (it has\na native TCP plugin), and Modbus RTU over RS-485 uses Web Serial directly in Chrome / Edge.\n\n```\nModbus page / Mini WellOS ──ws://127.0.0.1:8502──► modbus-bridge.js ──TCP 502──► PLC / RTU / gateway\n```\n\n- Zero dependencies, one file: `modbus-bridge.js` (Node.js 18 or newer).\n- Listens on **127.0.0.1 only** by default.\n- Reaches **any device IP address / port** by default (since v1.2.0: an empty allow-list means\n  `*:*`); list `--allow host:port` targets to restrict it to those. Since v1.2.1 running an\n  installer again also switches a device list written by an older installer to any device (see\n  [Running the installer again](#running-the-installer-again)).\n- **Read-only by default:** Modbus write requests (function codes 05, 06, 15, 16) are answered\n  by the bridge with exception 01 (Illegal function) and never reach the device, unless you start\n  it with `--allow-writes`. Writes also have to be enabled on the Modbus page and confirmed there.\n- Accepts browser connections only from `http(s)://localhost`, `http(s)://127.0.0.1`,\n  `https://welltest.h2oil.co.uk` and the iOS app origin, unless you add `--origin https://your-host`\n  (or `--any-origin`). Browsers allow an https page to open `ws://127.0.0.1`, so the bridge URL\n  stays `ws://127.0.0.1:8502` even when the app is served over https.\n- **Saved copies of the app** (opened from a `file://` path) send `Origin: null`. The bridge\n  refuses that by default, because any web site can send `null` too (from a sandboxed frame).\n  Prefer opening the app from `https://welltest.h2oil.co.uk` or `http://localhost`; if you must use a\n  saved copy, allow it explicitly with `--origin null` (installer: `--origin null` / `-Origin null`,\n  or `\"origins\": [\"null\"]` in `bridge-config.json`) — only on a PC that is not used for general\n  web browsing.\n\nThe app's **Modbus Config** page has the same steps as a guide (Connecting to real equipment →\nbridge setup): it downloads this folder as a zip (bundled in the app, works offline), generates an\ninstaller pre-filled with your configured bridge devices, and checks the running bridge.\n\n## One-click install (recommended)\n\nThe GitHub releases of this repository carry ready-made installers\n(built and tested by `.github/workflows/modbus-bridge-release.yml`):\n\n**Windows** — download and double-click\n[WTS-Modbus-Bridge-Setup.exe](https://github.com/h2oil/well-testing-suite/releases/latest/download/WTS-Modbus-Bridge-Setup.exe):\n\n```\nhttps://github.com/h2oil/well-testing-suite/releases/latest/download/WTS-Modbus-Bridge-Setup.exe\n```\n\n- No administrator rights and no Node.js needed (the exe carries Node.js; a Node.js single\n  executable application with no console window).\n- It copies itself to `%LOCALAPPDATA%\\WTS Modbus Bridge\\WTS-Modbus-Bridge.exe`, keeps an existing\n  `bridge-config.json` there (or writes the default: any device IP / port, read-only, port 8502;\n  a device list written by an older installer is replaced by any device — `--keep-allow` keeps it),\n  stops an earlier copy, registers auto-start at login for the current user\n  (`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, value \"WTS Modbus Bridge\"), adds the\n  Start-menu shortcuts **WTS Modbus Bridge — status** and **Uninstall WTS Modbus Bridge** and an\n  entry in Settings → Apps, starts the bridge and opens its status page `http://127.0.0.1:8502/`.\n- The exe is **code-signed** by H2Oil Engineering (release workflow; see the signing secrets at the\n  top of `.github/workflows/modbus-bridge-release.yml`). While a new certificate builds reputation,\n  SmartScreen may still say \"Windows protected your PC\": click **More info**, check the publisher,\n  then **Run anyway**.\n- Uninstall: Settings → Apps → Installed apps → **WTS Modbus Bridge** → Uninstall (or the\n  Start-menu shortcut).\n- Command line (`WTS-Modbus-Bridge.exe` in the install folder, or the setup exe): `--run` (what the\n  login entry starts; single instance), `--open` (start if needed, open the status page),\n  `--status` (JSON), `--uninstall`, `--version`, and the settings `--allow host:port`,\n  `--allow-any`, `--keep-allow`, `--allow-writes`, `--read-only`, `--port N`, `--no-autostart` (the bridge is\n  restarted with them), `--no-browser` / `--quiet` (no browser page, no message boxes). The exe\n  is a GUI program, so its console output is only seen when redirected\n  (`WTS-Modbus-Bridge.exe --status \u003e status.txt`). Log: `bridge.log` in the install folder.\n\n**macOS / Linux** — in a Terminal:\n\n```\ncurl -fsSL https://github.com/h2oil/well-testing-suite/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes\n```\n\nThis is `install.sh` with the bridge files built in (SHA-256 checked when unpacked). `--autostart`\nstarts the bridge now and at every login (a LaunchAgent / a systemd `--user` service); `--yes`\nlets it install Node.js 18+ with Homebrew or the package manager when it is missing. Add\n`--port N`, `--allow-writes` or `--allow host:port` as for `install.sh` below.\n\nThen press **Check bridge** on the app's Modbus Config page.\n\n### Cutting a release (maintainers)\n\nThe tag must match `BRIDGE_VERSION` in `modbus-bridge.js`:\n\n```\ngit tag modbus-bridge-v1.2.2 && git push origin modbus-bridge-v1.2.2\n```\n\nThe workflow builds `WTS-Modbus-Bridge-Setup.exe` on `windows-latest` (Node 22,\n`tools/modbus-bridge/exe/build-exe.js`: bundle → SEA blob → `postject` into a copy of `node.exe`\nwith its signature stripped → PE subsystem patched to WINDOWS_GUI) and smoke-tests it\n(`exe/ci-smoke-exe.js`: install with `--no-browser` into a temp `LOCALAPPDATA`, `/health`, the Run\nvalue, single instance, settings, `--uninstall`); on `ubuntu-latest` it builds\n`wts-modbus-bridge-install.sh` and `wts-modbus-bridge-\u003cversion\u003e.zip`\n(`exe/build-release-scripts.js`, the same generator as the app) and runs the installer piped into\nbash end to end (`exe/test-release-sh.js`). The release job attaches the three files and\n`SHA256SUMS.txt` to the GitHub Release for the tag and marks it **latest**, which is what the\n`/releases/latest/download/…` links resolve to. \"Run workflow\" (workflow_dispatch) builds and\ntests without releasing. Locally: `node tools/modbus-bridge/exe/build-exe.js --download` builds the\nexe on any OS (it downloads `node.exe` of the running Node version from nodejs.org, SHA-256\nchecked); it can only be run on Windows.\n\n## Script install\n\nThe installers need **no administrator rights** for the bridge. They check for Node.js 18+ and, if\nit is missing, offer to install it with the system package manager — only after you confirm.\nNothing else is downloaded. Every `host:port` is validated (IPv4, IPv4 subnet `a.b.c.d/nn`, a\nhost name of letters, digits, dots, hyphens and underscores, or an IPv6 address in brackets such as\n`[fd00::10]:502`; port 1-65535 or `*`).\n\n### Windows (PowerShell 5.1 or 7)\n\nIn the unzipped folder, open PowerShell (Start menu → type PowerShell, or right-click the folder\nwith Shift → \"Open PowerShell window here\") and run:\n\n```\npowershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Allow \"192.168.1.10:502,192.168.1.11:502\"\n```\n\n`-ExecutionPolicy Bypass` applies to this one run only (it changes no system setting and is what\nlets a downloaded script run). The installer:\n\n- copies the bridge to `%LOCALAPPDATA%\\WTS Modbus Bridge`, writes `bridge-config.json` and\n  `start-bridge.cmd` there, and adds a Start-menu shortcut **WTS Modbus Bridge**;\n- offers `winget install OpenJS.NodeJS.LTS` if Node.js is missing (Windows may ask for permission);\n- starts the bridge in its own window (leave it open), checks `http://127.0.0.1:8502/health` and\n  prints the next steps.\n\nOptions: `-AllowAny`, `-KeepAllow`, `-Port 8502`, `-Listen 127.0.0.1`, `-AllowWrites` / `-ReadOnly`, `-Origin https://app.company.example`,\n`-AutoStart` (start at every logon: a user-level Scheduled Task, or a Startup-folder shortcut when\nTask Scheduler refuses), `-NoStart`, `-Reset`, `-Yes` (answer yes to the Node.js question),\n`-Uninstall`.\n\n### macOS and Linux\n\nIn the unzipped folder, in a Terminal:\n\n```\nbash install.sh --allow 192.168.1.10:502 --allow 192.168.1.11:502\n```\n\n(`--allow` can be repeated or take a comma list. Quote targets that contain `*` or `[ ]`, e.g.\n`--allow 'plc-2.local:*'` — zsh, the macOS default shell, stops with \"no matches found\" otherwise.)\nThe installer:\n\n- copies the bridge to `~/Library/Application Support/WTS Modbus Bridge` (macOS) or\n  `${XDG_DATA_HOME:-~/.local/share}/wts-modbus-bridge` (Linux), and writes `bridge-config.json`\n  and `start-bridge.sh` there;\n- offers `brew install node` (macOS) or the distribution's `nodejs` package (Linux, via sudo) if\n  Node.js is missing — check that it is version 18 or newer, otherwise use \u003chttps://nodejs.org\u003e;\n- starts the bridge **in that Terminal window** (leave it open; Ctrl+C stops it), checks\n  `/health` and prints the next steps.\n\nOptions: `--allow-any`, `--keep-allow`, `--port 8502`, `--listen 127.0.0.1`, `--allow-writes` / `--read-only`,\n`--origin https://app.company.example`, `--autostart`, `--no-start`, `--reset`, `--yes`, `--uninstall`.\n\n`--autostart` starts the bridge now and at every login instead of in the Terminal (with\n`--no-start` it is only set up, and starts at the next login):\n\n- **macOS:** a LaunchAgent `~/Library/LaunchAgents/uk.co.h2oil.wts-modbus-bridge.plist`\n  (log: `bridge.log` in the install folder).\n- **Linux:** a systemd user service `wts-modbus-bridge.service`\n  (`systemctl --user status wts-modbus-bridge`, `journalctl --user -u wts-modbus-bridge`; to keep it\n  running while logged out: `loginctl enable-linger \"$USER\"`). Where `systemd --user` is not\n  available (WSL, containers, SSH-only sessions) the installer says so and runs the bridge in the\n  Terminal instead; add `start-bridge.sh` to your desktop's startup applications or to\n  `crontab -e` as `@reboot \"/path/to/start-bridge.sh\"`.\n\n### Running the installer again\n\nRunning an installer again (the package's, the one generated by the app, or the copy in the install\nfolder) updates the files and **keeps the existing `bridge-config.json`**: new `--allow` / `-Allow`\ntargets are **added** to its allow list, and its port, listen address, write setting and origins\nstay unless you give `--port`, `--listen`, `--allow-writes` / `--read-only` (`-Port`, `-Listen`,\n`-AllowWrites` / `-ReadOnly`) or `--origin`. So adding one more device is just:\n\n```\nbash \"$HOME/Library/Application Support/WTS Modbus Bridge/install.sh\" --allow 192.168.1.12:502   # macOS\nbash \"${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh\" --allow 192.168.1.12:502 # Linux\npowershell -NoProfile -ExecutionPolicy Bypass -File \"$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1\" -Allow \"192.168.1.12:502\"\n```\n\nThe allow list follows one rule in every installer (the setup exe, `install.sh`, the release\none-liner, `install-windows.ps1` and the installers generated by the app):\n\n| You give | The allow list becomes |\n|---|---|\n| `--allow-any` / `-AllowAny` (or `--allow '*:*'`) | any device IP / port |\n| `--allow host:port` / `-Allow` | the existing list plus these targets (an \"any device\" list starts empty, so this restricts the bridge) |\n| `--keep-allow` / `-KeepAllow` | the existing list, unchanged |\n| none of these | the existing list if it was written by v1.2.1 or newer (`\"allowMode\"` in the file); **a list written by an older installer is replaced by any device** (the default since v1.2) |\n\nSo double-clicking `WTS-Modbus-Bridge-Setup.exe` or running the one-line command again over an older\ninstall that was restricted to, say, `192.168.1.10:502` prints\n`Allow-list 192.168.1.10:502 replaced by any device (default since 1.2). Use --keep-allow to keep it.`\nand the bridge then reaches any device. The port, listen address, write setting and origins are kept.\n\n`--reset` / `-Reset` starts from a new, empty configuration instead. The previous file is kept as\n`bridge-config.json.bak`. Before writing anything the installer stops the bridge it started earlier\n(a Terminal / window started by an earlier install, or the auto-start service) and checks that the\nport is free — if another bridge or program answers there, it stops with a message and changes\nnothing.\n\n### Installer generated by the app\n\n**Modbus Config → Connecting to real equipment → Generate installer for my devices** downloads a\nsingle script (`wts-modbus-bridge-install.ps1` or `wts-modbus-bridge-install.sh`) with the bridge\nfiles embedded (SHA-256 checked when unpacked), the `--allow` targets taken from your\n\"Modbus TCP via WebSocket bridge\" devices, the bridge port from their bridge URL and the read-only /\nwrites choice made on the page (when the app is served from a site the bridge does not accept by\ndefault, that origin is added too). Run it with:\n\n```\npowershell -NoProfile -ExecutionPolicy Bypass -File \"$HOME\\Downloads\\wts-modbus-bridge-install.ps1\"\nbash ~/Downloads/wts-modbus-bridge-install.sh\n```\n\nExtra options on the command line are added to the built-in ones, and the targets of an existing\n`bridge-config.json` are kept (see above).\n\n### Uninstall\n\n```\npowershell -NoProfile -ExecutionPolicy Bypass -File \"$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1\" -Uninstall\nbash \"$HOME/Library/Application Support/WTS Modbus Bridge/install.sh\" --uninstall       # macOS\nbash \"${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh\" --uninstall     # Linux\n```\n\nThis stops the bridge, removes the auto-start entry and shortcuts, and deletes the installed files\n(a folder that still contains other files is left in place).\n\n## Configuration file\n\nThe installers write `bridge-config.json`; the bridge reads it with `--config`:\n\n```json\n{\n  \"_comment\": \"keys starting with _ are ignored\",\n  \"allow\": [\"192.168.1.10:502\", \"10.0.0.0/24:502\", \"plc-2.local:*\", \"[fd00::10]:502\"],\n  \"allowMode\": \"list\",\n  \"port\": 8502,\n  \"listen\": \"127.0.0.1\",\n  \"origins\": [],\n  \"anyOrigin\": false,\n  \"allowWrites\": false,\n  \"verbose\": false\n}\n```\n\nAll keys are optional. `\"allow\": []` (or `[\"*:*\"]`) = any device IP / port. `allowMode`\n(`\"any\"` or `\"list\"`) is written by the v1.2.1+ installers so that a re-install can tell a list you\nchose from one an older installer wrote (see \"Running the installer again\"); the bridge itself only\nreads `allow`. The file is in `%LOCALAPPDATA%\\WTS Modbus Bridge\\` (Windows, setup exe or\n`install-windows.ps1`), `~/Library/Application Support/WTS Modbus Bridge/` (macOS) or\n`${XDG_DATA_HOME:-~/.local/share}/wts-modbus-bridge/` (Linux). Command-line flags override `port` / `listen` and add to the `allow` /\n`origins` lists; `--allow-writes`, `--any-origin` and `--verbose` switch those on. Restart the\nbridge after editing (Windows, setup exe: end `WTS-Modbus-Bridge.exe` in Task Manager, then\nStart menu → **WTS Modbus Bridge — status**; Windows, `install-windows.ps1`: close its window and\nuse the Start-menu shortcut; macOS / Linux: Ctrl+C and `start-bridge.sh`, or\n`systemctl --user restart wts-modbus-bridge` / log out and in for an auto-start bridge).\n\n## Run it by hand\n\nIn the **unzipped package folder** (`wts-modbus-bridge`, from the app), on any system:\n```\nnode modbus-bridge.js --allow 192.168.1.10:502\n```\n\nFrom the **repository** folder:\n\n**Windows (PowerShell or cmd)**\n```\nnode tools\\modbus-bridge\\modbus-bridge.js --allow 192.168.1.10:502\n```\n\n**macOS / Linux**\n```\nnode tools/modbus-bridge/modbus-bridge.js --allow 192.168.1.10:502\n```\n\nIt prints `listening on ws://127.0.0.1:8502/modbus (read-only)`. Leave the window open while you use\nMini WellOS. Stop it with Ctrl+C.\n\nThen, on the **Modbus** page of the app, add a device with transport\n\"Modbus TCP via WebSocket bridge\", host `192.168.1.10`, port `502`, the unit id, and bridge URL\n`ws://127.0.0.1:8502`. Press **Check bridge** in the setup guide, then **Test** on the device row.\n\n### Options\n\n| Option | Meaning |\n|---|---|\n| `--allow host:port` | Allow a target. Repeat for several. `'host:*'` allows any port; `10.0.0.0/24:502` allows an IPv4 subnet; `'[fd00::10]:502'` an IPv6 address. Quote values with `*` or `[ ]` in sh / zsh. |\n| `--port 8502` | WebSocket port. |\n| `--listen 127.0.0.1` | Interface to listen on. Anything other than localhost lets other machines use the bridge — only do this on a trusted network. |\n| `--origin https://example.com` | Also accept pages served from this origin (repeat as needed). `--origin null` accepts a saved `file://` copy of the app — and any web site's sandboxed frames, so only on a PC not used for general browsing. |\n| `--any-origin` | Accept any page origin (not recommended). |\n| `--allow-writes` | Forward Modbus write requests (FC 05 / 06 / 15 / 16). |\n| `--config file.json` | Read settings from a configuration file (see above). |\n| `--verbose` | Log connections and blocked requests. |\n| `--version` | Print the bridge version. |\n\nExample with two PLCs and writes enabled (in the package folder):\n```\nnode modbus-bridge.js --allow 192.168.1.10:502 --allow 192.168.1.11:502 --allow-writes\n```\n\n## Health check\n\n`GET http://127.0.0.1:8502/health` returns\n\n```json\n{\"name\":\"wts-modbus-bridge\",\"version\":\"1.1.0\",\"readOnly\":true,\"port\":8502,\"uptimeS\":42,\"allow\":[\"192.168.1.10:502\"]}\n```\n\nThe app's **Check bridge** button uses it to show whether the bridge runs, its version, whether it\nis read-only and whether each configured device is in the allow-list. The health data (with CORS\nheaders) goes only to the page origins the bridge accepts (the same rules as the WebSocket\nconnection) and to requests without an `Origin` header (`curl http://127.0.0.1:8502/health` works\nfrom the same PC). A refused request gets `403 {\"error\":\"origin\"}` — or `{\"error\":\"host\"}` when the\n`Host` is not localhost, an IP address or the `--listen` name and the request has no accepted\n`Origin` (protection against DNS rebinding) — with `Access-Control-Allow-Origin` echoed, so\n**Check bridge** can say why instead of \"no bridge answered\". The refusal contains nothing else, and\na refused preflight is never approved for local-network access.\n\n**Chrome / Edge and local-network access:** when the app is served from a public https site,\nChromium browsers treat a request to `127.0.0.1` as a private-network request. The bridge answers\nthe CORS preflight with `Access-Control-Allow-Private-Network: true`, and newer versions may show a\nprompt asking to let the site access apps or devices on your local network — choose **Allow**.\nOther browsers may block an https page from reaching `http://127.0.0.1`; use Chrome / Edge, or open\nthe app from `http://localhost` (a saved `file://` copy needs `--origin null`, see above).\n\n## Test without hardware\n\n`fake-slave.js` is a tiny Modbus TCP slave (unit 1) for trying the bridge. In the unzipped package\nfolder, in two windows:\n```\nnode fake-slave.js --port 5020\nnode modbus-bridge.js --allow 127.0.0.1:5020\n```\n(from the repository: `node tools/modbus-bridge/fake-slave.js --port 5020` and\n`node tools/modbus-bridge/modbus-bridge.js --allow 127.0.0.1:5020`).\nHolding register *n* holds *n*, input register *n* holds 1000 + *n*, and input registers 100-101\nhold the FLOAT32 value 123.456 (ABCD). In the app, add a bridge device with host `127.0.0.1`,\nport `5020`, and a tag on input register 100, type FLOAT32.\n\nThe app also has a built-in virtual slave (\"Built-in simulator\" transport, or **Load simulator\ndemo** on the Modbus page) that needs neither the bridge nor Node.\n\n## Protocol (for developers)\n\n- The page opens one WebSocket per device: `ws://127.0.0.1:8502/modbus?host=\u003cip\u003e&port=\u003cport\u003e`.\n- When the TCP connection to the device is up, the bridge sends the text message\n  `{\"type\":\"open\"}`. Errors arrive as `{\"type\":\"error\",\"message\":\"…\"}` followed by a close\n  (1008 = target not allowed, 1011 = connection error).\n- Binary messages carry complete Modbus TCP ADUs (MBAP header + PDU) in both directions; the\n  bridge re-frames the device's TCP stream using the MBAP length field. ADUs are limited to\n  260 bytes; fragmented WebSocket messages are refused.\n- `GET /health` (and its CORS preflight) as described above; any other plain HTTP request gets a\n  short text banner.\n- References: RFC 6455 (WebSocket), MODBUS Messaging on TCP/IP Implementation Guide V1.0b,\n  MODBUS Application Protocol Specification V1.1b3.\n\n## Troubleshooting\n\n- *\"Cannot reach the Modbus bridge\"* — the bridge is not running, the URL / port differs, or the\n  bridge refused the page (a browser reports all three the same way). Press **Check bridge** on the\n  Modbus page: it says which.\n- *Windows: \"Windows protected your PC\"* — SmartScreen, while the signing\n  certificate of `WTS-Modbus-Bridge-Setup.exe` builds reputation: click **More info**, check the\n  publisher is H2Oil Engineering, then **Run anyway**.\n- *\"not in the bridge allow-list\"* — the bridge was restricted to a list of targets (older\n  installers wrote one; an empty list allows any device). Run the installer again\n  (`WTS-Modbus-Bridge-Setup.exe`, or the one-line command): from v1.2.1 it switches the bridge to\n  any device. On Windows without reinstalling: Win+R →\n  `\"%LOCALAPPDATA%\\WTS Modbus Bridge\\WTS-Modbus-Bridge.exe\" --allow-any` (rewrites the settings and\n  restarts the bridge). Or set `\"allow\": []` in `bridge-config.json` (locations above) and restart\n  the bridge. To keep a list instead, run the installer with that device\n  (`--allow \u003chost\u003e:\u003cport\u003e` / `-Allow`): it is added to the targets already allowed.\n- *\"the bridge refused this page\" / origin not accepted* — the page is served from an origin the\n  bridge does not accept: run the installer again with `--origin \u003cthat origin\u003e` (`-Origin`), or add\n  it to `origins` in `bridge-config.json`. A saved `file://` copy sends `null` (see the top of\n  this file).\n- *\"refused the host name\"* — the device bridge URL uses a host name the bridge does not know: use\n  the bridge PC's IP address in the bridge URL.\n- *zsh: no matches found* — quote targets with `*` or `[ ]`: `--allow 'plc-2.local:*'`.\n- *Timeouts* — check the unit id (many gateways need the RS-485 slave address here), the IP /\n  port, and that no firewall blocks TCP 502 between the PC and the device.\n- *Exception 01 on writes* — the bridge is read-only; run the installer again with `--allow-writes` /\n  `-AllowWrites` (the targets and the port are kept).\n- *Chrome / Edge asks about local network access* — choose Allow (see \"Health check\" above).\n- *Windows: \"running scripts is disabled on this system\"* — use the\n  `powershell -NoProfile -ExecutionPolicy Bypass -File …` command exactly as shown.\n- *macOS / Linux: \"permission denied\"* — start the installer with `bash install.sh …`.\n- *Port 8502 already in use* — install with `--port` / `-Port` and change the device bridge URL to\n  match (the port is then kept when you run the installer again).\n- *Listening on `localhost`* — the installers and the bridge treat `localhost` as `127.0.0.1`\n  (on macOS / Windows `localhost` can resolve to `::1` only, which `ws://127.0.0.1` cannot reach).\n"
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
//                              single-quoted for sh / zsh, double-quoted for PowerShell / cmd; *:* in
//                              allow = --allow-any / -AllowAny, which replaces an older installer's list)
//   quickSetup(os, {port})   → {os, exeUrl, shUrl, oneLiner, releasesUrl}: the one-click paths from the GitHub
//                              release (Windows: WTS-Modbus-Bridge-Setup.exe; macOS / Linux: curl … | bash)
//   releaseInstaller()       → {ok, filename, text, version, files}: the self-contained install.sh of the GitHub
//                              release (presets empty = any device, read-only, port 8502; bridge files AND
//                              install.sh embedded, so it works piped into bash and can --uninstall later)
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
// One-click downloads: GitHub release assets built by .github/workflows/modbus-bridge-release.yml
// (tag modbus-bridge-v<version>). The repository is public, so they download without a login.
var RELEASE_REPO = 'https://github.com/h2oil/well-testing-suite';
var RELEASE_LATEST = RELEASE_REPO + '/releases/latest/download/';
var EXE_FILE = 'WTS-Modbus-Bridge-Setup.exe';
var SH_RELEASE_FILE = 'wts-modbus-bridge-install.sh';

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
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o) || /^https:\/\/welltest\.h2oil\.co\.uk$/i.test(o) || /^capacitor:\/\/localhost$/i.test(o);
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
    var tpl = P.files['install.sh'], files = o.files || SH_FILES;
    var preset = o.keepPreset ? null : [
        '# @@WTS-PRESET-BEGIN@@ (generated by the Well Testing Suite for your devices; bridge v' + P.version + ')',
        'PRESET_ALLOW="' + o.allow.join(',') + '"',
        'PRESET_PORT="' + o.port + '"',
        'PRESET_LISTEN="' + (o.listen || '127.0.0.1') + '"',
        'PRESET_ALLOW_WRITES="' + (o.allowWrites ? 1 : 0) + '"',
        'PRESET_AUTOSTART="' + (o.autostart ? 1 : 0) + '"',
        'PRESET_ORIGINS="' + (o.origins || []).join(',') + '"',
        '# @@WTS-PRESET-END@@'];
    var sums = [], bodies = [];
    files.forEach(function (f) {
        if (typeof P.files[f] !== 'string') return;
        sums.push('        ' + f + ") printf '%s' '" + P.sha256[f] + "' ;;");
        bodies.push('        ' + f + ')', "            cat <<'WTS_PAYLOAD_EOF'");
        Array.prototype.push.apply(bodies, chunks(base64(utf8(P.files[f])), 76));
        bodies.push('WTS_PAYLOAD_EOF', '            ;;');
    });
    var payload = ['# @@WTS-PAYLOAD-BEGIN@@ (bridge v' + P.version + ' embedded by the Well Testing Suite; SHA-256 checked when unpacked)',
        'EMBEDDED_FILES="' + files.filter(function (f) { return typeof P.files[f] === 'string'; }).join(' ') + '"',
        'EMBEDDED_VERSION="' + P.version + '"',
        'embedded_sha256() {', '    case "$1" in'].concat(sums, ['        *) return 1 ;;', '    esac', '}',
        'embedded_b64() {', '    case "$1" in'], bodies, ['        *) return 1 ;;', '    esac', '}', '# @@WTS-PAYLOAD-END@@']);
    var t = o.keepPreset ? tpl : replaceBlock(tpl, 'PRESET', preset);
    t = t && replaceBlock(t, 'PAYLOAD', payload);
    return t;
}
// The GitHub release's install.sh: the template's empty presets (any device IP / port, read-only,
// port 8502, flags decide auto-start) + the bridge files and install.sh itself, because piped into
// bash (curl … | bash) the script has no file to keep for --uninstall and later runs.
function releaseInstaller() {
    var P = pack();
    if (!P) return { ok: false, errors: ['The bridge package is not bundled in this build.'] };
    var files = SH_FILES.concat('install.sh');
    var text = shInstaller(P, { keepPreset: true, files: files });
    if (!text) return { ok: false, errors: ['The bundled installer template has no payload block.'] };
    return { ok: true, filename: SH_RELEASE_FILE, text: text, version: P.version, files: files, errors: [] };
}
// The one-click set-up paths (GitHub release). port: the bridge port the devices use (8502 default).
function quickSetup(os, o) {
    os = normOs(os); o = o || {};
    var port = validPort(o.port) ? +o.port : 8502;
    return { os: os, exeUrl: RELEASE_LATEST + EXE_FILE, shUrl: RELEASE_LATEST + SH_RELEASE_FILE, releasesUrl: RELEASE_REPO + '/releases',
        oneLiner: 'curl -fsSL ' + RELEASE_LATEST + SH_RELEASE_FILE + ' | bash -s -- --autostart --yes' + (port !== 8502 ? ' --port ' + port : ''),
        exeFile: EXE_FILE, port: port };
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
    // any device (*:*): --allow-any / -AllowAny, which also replaces the allow list of an existing
    // bridge-config.json (an older installer's list would otherwise be kept and added to)
    var any = allow.some(function (a) { return validateTarget(a).value === '*:*'; });
    if (any) allow = [];
    var direct = 'node modbus-bridge.js' + (any ? ' --allow-any' : '') + allow.map(function (a) { return ' --allow ' + q(a); }).join('') + (port !== 8502 ? ' --port ' + port : '') +
        (listen ? ' --listen ' + listen : '') + origins.map(function (x) { return ' --origin ' + x; }).join('') + (o.allowWrites ? ' --allow-writes' : '');
    if (os === 'windows') {
        return {
            node: 'winget install OpenJS.NodeJS.LTS',
            installer: 'powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\\Downloads\\wts-modbus-bridge-install.ps1"',
            packaged: 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1' + (any ? ' -AllowAny' : ' -Allow "' + allow.join(',') + '"') + (port !== 8502 ? ' -Port ' + port : '') +
                (listen ? ' -Listen ' + listen : '') + (origins.length ? ' -Origin "' + origins.join(',') + '"' : '') + (o.allowWrites ? ' -AllowWrites' : '') + (o.autostart ? ' -AutoStart' : ''),
            direct: direct,
            uninstall: 'powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1" -Uninstall'
        };
    }
    return {
        node: os === 'macos' ? 'brew install node' : 'sudo apt-get install nodejs      # or: sudo dnf install nodejs',
        installer: 'bash ~/Downloads/wts-modbus-bridge-install.sh',
        packaged: 'bash install.sh ' + (any ? '--allow-any' : '--allow ' + (allow.length ? shArg(allow.join(',')) : '<ip>:502')) + (port !== 8502 ? ' --port ' + port : '') + (listen ? ' --listen ' + listen : '') +
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
    if (o === 'null') return 'This page is a saved copy (file://), so the browser sends "Origin: null" — which the bridge refuses by default, because any web site can send it too. Open the app from https://welltest.h2oil.co.uk or http://localhost instead, or add --origin null (-Origin null on Windows) to the installer command — only on a PC that is not used for general web browsing.';
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
// How to switch a restricted bridge to any device (plain text; the config paths are the installers').
var ALLOW_FIX = [
    'Fix: run the installer again — ' + EXE_FILE + ' on Windows, or the one-line command on macOS / Linux (step 1 above). From bridge v1.2.1 on it switches the bridge to any device.',
    'Windows, without reinstalling: press Win+R, run  "%LOCALAPPDATA%\\WTS Modbus Bridge\\WTS-Modbus-Bridge.exe" --allow-any  — it rewrites the settings and restarts the bridge (setup-exe install).',
    'Or by hand: in bridge-config.json set "allow": [] (an empty list = any device), save, then restart the bridge. The file is in %LOCALAPPDATA%\\WTS Modbus Bridge\\ (Windows, setup exe or install-windows.ps1), ~/Library/Application Support/WTS Modbus Bridge/ (macOS) or ~/.local/share/wts-modbus-bridge/ (Linux).',
    'Restart it: Windows (setup exe) — end WTS-Modbus-Bridge.exe in Task Manager, then Start menu → "WTS Modbus Bridge — status"; Windows (install-windows.ps1) — close the "WTS Modbus Bridge" window, then Start menu → "WTS Modbus Bridge"; macOS / Linux — Ctrl+C in its Terminal and run start-bridge.sh from that folder (auto-start: systemctl --user restart wts-modbus-bridge, or log out and in on macOS).'
];
function originText() { return pageOrigin(); }
function originHint() {
    var o = originText() || '<origin>';
    if (o === 'null') return 'This page is a saved copy (file://): browsers send "Origin: null", which the bridge refuses by default because any web site can send it. Open the app from https://welltest.h2oil.co.uk or http://localhost, or — only on a PC not used for general browsing — add "null" to "origins" in bridge-config.json (installer: --origin null / -Origin null) and restart the bridge.';
    return 'Add this page\'s origin (' + o + ') to "origins" in bridge-config.json — or run the installer again with --origin ' + o + ' (Windows: -Origin ' + o + ') — and restart the bridge.';
}
function failHints(u, kind) {
    var h = [], o = originText();
    if (kind === 'origin') { h.push('The bridge refused this page\'s origin (' + (o || 'unknown') + ').'); h.push(originHint()); return h; }
    if (kind === 'host') {
        h.push('The bridge answers under a host name (' + u.host + ') only for pages from an accepted web origin; this page (' + (o || 'unknown') + ') is not one, so the name is refused (protection against DNS rebinding).');
        h.push('Put the bridge PC\'s IP address in the device bridge URL (ws://<IP>:' + u.port + ')' + (o === 'null' ? ', or open the app from https://welltest.h2oil.co.uk or http://localhost.' : '.'));
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
    h.push('Is the bridge running? Windows: Start menu → "WTS Modbus Bridge — status" (starts it and opens its status page; after a script install: "WTS Modbus Bridge"), or run WTS-Modbus-Bridge-Setup.exe again. macOS / Linux: run the one-line installer again, or start-bridge.sh from the install folder.');
    if (o && !bridgeAcceptsOrigin(o)) h.push('The bridge accepts only pages from localhost, 127.0.0.1, welltest.h2oil.co.uk and the iOS app by default, and a browser cannot read its refusal from every site: ' + originHint());
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
            if (missing.length) warnings = warnings.concat(['Not in the bridge allow-list: ' + missing.map(function (d) { return d.target; }).join(', ') + ' — this bridge is restricted to a list of devices (an older installer wrote one).'], ALLOW_FIX);
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
    installerFromConfig: installerFromConfig, commandsFor: commandsFor, quickSetup: quickSetup, releaseInstaller: releaseInstaller,
    RELEASE_LATEST: RELEASE_LATEST, EXE_FILE: EXE_FILE, SH_RELEASE_FILE: SH_RELEASE_FILE, zip: zip, crc32: crc32, base64: base64,
    packageZip: packageZip, allowedBy: allowedBy, checkBridge: checkBridge, versionLess: versionLess, pack: pack
};
})();

// ─── END 65-modbus-bridge-setup ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 66-account ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/66-account.js — WTS_account: web accounts (docs/ACCOUNTS-PLAN.md §3.2, §4, §5, §10, §11). Round-10, auto-discovered.
//
// It loads everywhere and does nothing unless the page is the production web host over https (or DEV on localhost with
// window.WTS_ACCOUNT_DEV === 1), outside the iOS native shell and not framed (§5.1 guard). Even then nothing is mounted,
// registered or requested unless the invite-beta flag is set (?cloud=1 → wtspref_cloud_beta, §5.5), and a signed-out first
// visit makes no request at all: GET /me runs only when the device hint says a session exists. So while no server answers,
// the live site behaves exactly as v3.4.
//
// WP-C1 (this file): the guard, configure() seams, the one API client call() (headers, error envelope → WTS_account.Error,
// the §3.2 outage rule: only code 'signed_out' signs the page out), the session state machine and the device hint, the
// sign-in dialog (e-mail code first, "Didn't get the code?", consent for a new account, public-computer tick), step-up in
// place (code to the primary or the recovery address), sign-out / sign out everywhere, the header chip and its menu, the
// project-toolbar cloud button (H5), Ctrl+S while linked, the bottom status bar #wts_sync_bar, and the one reload after a
// sign-in on a page where the analytics tag ran (H17, D20).
//
// WP-O MOUNT POINTS (provider sign-in, the block near the end of this file): the e-mail step draws an empty
// <div id="acct_provider_buttons" data-owner="WP-O"> and calls WTS_account.hooks.renderProviders(el, providers, ctx)
// (GET /auth/providers runs only then); a public sign-out awaits hooks.onPublicSignOut({authMethod}) (the blocking provider
// sign-out step); the provider finish completes a sign-in through completeSignIn, so the hand-over, consent and analytics
// steps are shared. A load with #acct-oauth and a fresh hint.oauth entry opens the finish dialog (WTS_account.oauthReturn);
// without the hint entry it is ignored. The account page's Sign-in methods card is mounted by 68 the same way
// (WTS_accountPage.hooks.renderMethods → WTS_account.oauthUI.renderMethods).
//
// No polling, no setInterval, no function wrapping; the only timer is the one-shot mount (setTimeout 0).
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var L = G.location || {};
  function nativeShell(g) {
    try {
      var c = g.Capacitor;
      if (c && typeof c.isNativePlatform === 'function') return !!c.isNativePlatform();
      return !!(c && c.isNative);
    } catch (e) { return true; }
  }
  var DEV = G.WTS_ACCOUNT_DEV === 1 && /^https?:$/.test(L.protocol || '')
    && /^(localhost|127\.0\.0\.1)$/.test(L.hostname || '');
  var ELIGIBLE = ((L.protocol === 'https:' && L.hostname === 'welltest.h2oil.co.uk') || DEV)
    && !nativeShell(G)
    && (function () { try { return G.top === G; } catch (e) { return false; } })();
  if (!ELIGIBLE) { if (!G.WTS_account) G.WTS_account = { eligible: false }; return; }

  var VERSION = '1.0.0';
  var PROVIDERS = ['google', 'linkedin'];
  var KEYS = { hint: 'wtsacct_hint', beta: 'wtspref_cloud_beta', cloudOpen: 'wtspref_cloud_open', shared: 'wtspref_shared_browser' };
  var SUPPORT = 'software@h2oil.co.uk';
  var HAS_DOC = typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';

  // ── errors and seams ───────────────────────────────────────────────────────────────────────────────────────────────
  function AccountError(code, status, body) {
    this.name = 'AccountError';
    this.code = code; this.status = status || 0;
    this.retryAfter = body && typeof body.retryAfter === 'number' ? body.retryAfter : null;
    this.body = body || null;
    this.message = (body && typeof body.message === 'string') ? body.message : code;
  }
  AccountError.prototype = Object.create(Error.prototype);
  AccountError.prototype.constructor = AccountError;

  // fetch, now, base, idb, crypto, gzip, gunzip, locks, minDelayMs: §5.2 test seams; appVer, deviceId: request headers;
  // reload / assign: page navigation (the analytics reload, WP-O's redirect); online: () → bool (navigator.onLine).
  var seams = { fetch: null, now: null, base: '/api/v1', idb: null, crypto: null, gzip: null, gunzip: null, locks: null, minDelayMs: 0,
    appVer: '', deviceId: null, reload: null, assign: null, online: null, maxProjectBytes: 64 * 1000 * 1000 };
  function configure(o) {
    o = o || {};
    Object.keys(o).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(seams, k)) seams[k] = o[k]; });
    // a store seam set after the mount: let 67 open it now (the load-time public expiry wipe finishes there)
    if (o.idb && mounted && G.WTS_cloudSync && typeof G.WTS_cloudSync._init === 'function') G.WTS_cloudSync._init();
    return api;
  }
  function seam(k) { return Object.prototype.hasOwnProperty.call(seams, k) ? seams[k] : undefined; }
  function now() { return typeof seams.now === 'function' ? seams.now() : Date.now(); }
  function doFetch() { var f = seams.fetch || G.fetch; return f.apply(G, arguments); }
  function appVer() {
    if (seams.appVer) return String(seams.appVer);
    try { var rn = G.RELEASE_NOTES; if (rn && rn[0] && rn[0].ver) return String(rn[0].ver); } catch (e) { /* none */ }
    var el = HAS_DOC && document.getElementById('appVersionLabel');
    var m = el && /(\d+\.\d+(?:\.\d+)?)/.exec(el.textContent || '');
    return m ? m[1] : '';
  }
  function isOnline() {
    if (typeof seams.online === 'function') return !!seams.online();
    try { return !(G.navigator && G.navigator.onLine === false); } catch (e) { return true; }
  }

  // call(method, path, body, opts) → Promise<{status, json|bytes, headers}>; any non-2xx → WTS_account.Error {code, status,
  // retryAfter}. A network failure is code 'network' (status 0); a reply without an envelope is 'server'. Only the code
  // 'signed_out' may ever sign the page out (§3.2 outage rule) — callers key on code, never on status alone.
  function call(method, path, body, opts) {
    opts = opts || {};
    var headers = { 'X-WTS-Req': '1' };
    var av = appVer(); if (av) headers['X-WTS-App'] = av;
    if (seams.deviceId) headers['X-WTS-Device'] = String(seams.deviceId);
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (opts.keepalive) init.keepalive = true;
    if (body !== undefined && body !== null && method !== 'GET') {
      if (opts.raw) { headers['Content-Type'] = 'application/octet-stream'; init.body = body; }
      else { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    } else if (method !== 'GET') { headers['Content-Type'] = 'application/json'; init.body = '{}'; }
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    var p;
    try { p = Promise.resolve(doFetch(seams.base + path, init)); } catch (e) { p = Promise.reject(e); }
    return p.then(function (r) {
      var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
      if (r.status >= 200 && r.status < 300) {
        if (r.status === 204) return { status: r.status, json: null, headers: r.headers };
        if (opts.bytes || /octet-stream/.test(ct)) return r.arrayBuffer().then(function (b) { return { status: r.status, bytes: b, headers: r.headers }; });
        // a 2xx that is not JSON (e.g. the static host's page fallback while no server is configured) is 'server'
        if (!/^application\/json\b/i.test(String(ct).trim())) throw new AccountError('server', r.status, null);
        return r.json().then(function (j) { return { status: r.status, json: j, headers: r.headers }; },
          function () { throw new AccountError('server', r.status, null); });
      }
      return r.json().then(function (j) {
        if (!j || typeof j.error !== 'string') throw new AccountError('server', r.status, null);
        throw new AccountError(j.error, r.status, j);
      }, function () { throw new AccountError('server', r.status, null); });
    }, function () { throw new AccountError('network', 0, null); });
  }
  // the outage family: no answer from our API (network, a 5xx without an envelope, or a non-API reply)
  function isOutage(e) { return !!e && (e.code === 'network' || e.code === 'server'); }

  // GET /auth/providers when the sign-in dialog or the Sign-in methods card opens (a user action). On a network error both
  // buttons show and start decides (§3.3); a reply that is not the API's ('server': no envelope, not JSON) means no server
  // answers, so both are off.
  function providers() {
    return call('GET', '/auth/providers').then(function (r) {
      var o = {};
      PROVIDERS.forEach(function (p) { var v = r.json && r.json[p]; o[p] = (v === 'on' || v === 'signin') ? v : 'off'; });
      return o;
    }, function (e) {
      if (e && e.code === 'network') return { google: 'on', linkedin: 'on' };
      if (e && e.code === 'server') return { google: 'off', linkedin: 'off' };
      throw e;
    });
  }

  // ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return HAS_DOC ? document.getElementById(id) : null; }
  function lsGet(k) { try { return G.localStorage ? G.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (G.localStorage) { if (v == null) G.localStorage.removeItem(k); else G.localStorage.setItem(k, v); } } catch (e) { /* storage blocked */ } }
  function hhmm(ms) {
    if (!ms) return '';
    var d = new Date(ms); var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function emit(name, detail) {
    try { if (HAS_DOC && typeof G.CustomEvent === 'function') document.dispatchEvent(new G.CustomEvent(name, { detail: detail })); } catch (e) { /* none */ }
  }
  function deviceLabel() {
    var ua = ''; try { ua = String((G.navigator && G.navigator.userAgent) || ''); } catch (e) { /* none */ }
    var os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Computer';
    // a neutral label (no browser product names, §3.3 lets the server derive the family for its mails)
    var phone = /Mobi|Android|iPhone|iPad/.test(ua);
    try { if (!phone && G.matchMedia && G.matchMedia('(pointer: coarse)').matches) phone = true; } catch (e) { /* none */ }
    return (os + (phone ? ' phone browser' : ' desktop browser')).replace(/[^A-Za-z0-9 _.()-]/g, '').slice(0, 40);
  }
  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
  function sync() { return G.WTS_cloudSync || null; }

  // ── device hint (§5.3): non-secret, paints the chip, drives the analytics guard and the public expiry wipe ─────────────
  function readHint() {
    try { var o = JSON.parse(lsGet(KEYS.hint) || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
  }
  function writeHint(h) { lsSet(KEYS.hint, h ? JSON.stringify(h) : null); }
  function betaEnabled() { return lsGet(KEYS.beta) === '1'; }
  (function readBetaFlag() {
    var m = /[?&]cloud=([01])(?:&|$)/.exec(L.search || '');
    if (m) lsSet(KEYS.beta, m[1] === '1' ? '1' : null);
  })();

  // ── state ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  var listeners = { state: [], error: [] };
  function on(evt, fn) { if (listeners[evt] && typeof fn === 'function') listeners[evt].push(fn); return api; }
  function off(evt, fn) { if (listeners[evt]) listeners[evt] = listeners[evt].filter(function (f) { return f !== fn; }); return api; }
  function fire(evt, v) { (listeners[evt] || []).slice().forEach(function (f) { try { f(v); } catch (e) { /* listener */ } }); }
  var current = { status: 'signedOut', user: null, publicDevice: false, device: null, needsConsent: false, opts: null,
    authMethod: null, me: null, reason: null, lastOkAt: null };
  function state() { return JSON.parse(JSON.stringify(current)); }
  function setState(patch) {
    var before = current.status;
    Object.keys(patch).forEach(function (k) { current[k] = patch[k]; });
    if (current.status === 'signedIn') attachSignedIn(); else detachSignedIn();
    fire('state', state());
    if (before !== current.status || patch.reason !== undefined) emit('wts:account-changed', { status: current.status, reason: current.reason });
    renderChip(); renderBar();
    refreshToolbar();
  }
  function applyMe(me) {
    var u = me.user || {};
    current.lastOkAt = now();
    var h = readHint() || {};
    writeHint({ signedIn: true, initial: (String(u.emailMasked || '?')[0] || '?').toUpperCase(), public: !!(me.session && me.session.publicDevice),
      absExpires: me.session ? me.session.absExpires : null, lastSeenAt: now(), oauth: undefined, v: 3, deleting: u.status === 'deleting' || undefined,
      sync: h.sync });
    setState({ status: 'signedIn', user: u, publicDevice: !!(me.session && me.session.publicDevice), opts: me.opts || null,
      authMethod: me.session ? me.session.authMethod : null, me: me, reason: null, needsConsent: false });
  }
  var refreshing = null;
  // refresh(): GET /me. A 401 signed_out re-reads once (the 30 s step-up rotation race, §4.7) before it signs the page out;
  // an outage keeps the hint and shows "Cloud unavailable" (§3.2); 'paused' shows the paused text.
  function refresh() {
    if (refreshing) return refreshing;
    var tries = 0;
    function once() {
      tries++;
      return call('GET', '/me').then(function (r) { applyMe(r.json); return state(); }, function (e) {
        if (e && e.code === 'signed_out') {
          if (tries < 2) return once();
          return signedOutLocal('expired').then(state);
        }
        if (e && e.code === 'locked') { setState({ status: 'unavailable', reason: 'locked' }); fire('error', e); return state(); }
        if (e && (e.code === 'paused' || isOutage(e) || e.status >= 500 || e.code === 'rate' || e.code === 'upgrade')) {
          setState({ status: 'unavailable', reason: e.code === 'paused' ? 'paused' : e.code === 'upgrade' ? 'upgrade' : 'outage' });
          fire('error', e); return state();
        }
        fire('error', e); throw e;
      });
    }
    refreshing = once().then(function (s) { refreshing = null; return s; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }
  // The page is signed out (a 401 signed_out on any call, or a sign-out). The outbox, base and binding are kept (§6.9); a
  // public device runs the expiry wipe (§10.8).
  function signedOutLocal(reason) {
    var h = readHint();
    var wasPublic = !!(h && h.public) || current.publicDevice;
    var S = sync();
    var p = Promise.resolve();
    if (S && typeof S._noteSignedOut === 'function') p = p.then(function () { return S._noteSignedOut(current.user); });
    if (wasPublic && S && typeof S.wipeDevice === 'function') p = p.then(function () { return S.wipeDevice({ reason: 'expiry', historian: true }); });
    return p.then(null, function () { /* the wipe reports its own errors */ }).then(function () {
      writeHint(null);
      setState({ status: 'signedOut', user: null, publicDevice: false, device: null, opts: null, authMethod: null, me: null, reason: reason || null });
    });
  }
  // Every caller of the API funnels errors through here: only 'signed_out' changes the state (outage rule).
  function handleError(e) {
    if (e && e.code === 'signed_out' && current.status === 'signedIn') {
      return refresh().then(function () { throw e; }, function () { throw e; });
    }
    if (e && isOutage(e) && current.status === 'signedIn') { current.reason = 'outage'; renderChip(); renderBar(); }
    return Promise.reject(e);
  }

  // ── sign-in completion (shared with WP-O's finish) ─────────────────────────────────────────────────────────────────
  // body = a SignInResult (code/verify, finish 'done'). Sets the device id, the hint, the shared-browser flag, reads /me,
  // runs the hand-over (§10) and, when the analytics tag ran in this page, flushes and reloads once (§11.2 step 6).
  function completeSignIn(body, o) {
    o = o || {};
    if (body && body.device && body.device.id) seams.deviceId = body.device.id;
    var S = sync();
    if (S && typeof S._setDevice === 'function' && body && body.device) S._setDevice(body.device.id);
    if (body && body.session && body.session.publicDevice) lsSet(KEYS.shared, '1');
    writeHint({ signedIn: true, initial: (String((body && body.user && body.user.emailMasked) || '?')[0] || '?').toUpperCase(),
      public: !!(body && body.session && body.session.publicDevice), absExpires: body && body.session ? body.session.absExpires : null,
      lastSeenAt: now(), v: 3 });
    setStep('busy', { text: 'Signing in…' });
    return refresh().then(function () {
      if (current.status !== 'signedIn') { closeDialog(); return state(); }
      // the reload below needs the page's pending autosave written first: write it BEFORE the hand-over, so the upload
      // includes it and no rewrite after the binding marks a just-saved project dirty (review fix)
      var reloads = G.__wtsGaLoaded === true;
      if (reloads) { try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.flush) G.WTS_pageAutosave.flush(); } catch (e) { /* none */ } }
      var p = (S && typeof S.afterSignIn === 'function') ? S.afterSignIn(current.user, { firstSignIn: !!(body && body.firstSignIn), method: o.method || 'code' }) : Promise.resolve(null);
      return Promise.resolve(p).then(null, function () { return null; }).then(function () {
        if (reloads) {
          setStep('busy', { text: 'Finishing sign-in…' });
          var rl = seams.reload || function () { try { L.reload(); } catch (e) { /* none */ } };
          rl();
          return state();
        }
        closeDialog();
        return state();
      });
    });
  }

  // ── dialog (§11.2) ─────────────────────────────────────────────────────────────────────────────────────────────────
  var dlg = { open: false, mode: null, step: null, email: '', publicDevice: false, consent: null, opener: null, resolve: null,
    choice: null, onKey: null };
  var hooks = { renderProviders: null, onPublicSignOut: null };
  var MSG = {
    network: 'Sign-in needs a connection. Your work keeps saving on this device.',
    server: 'Cloud unavailable — your work is saved on this device. Try again later.',
    paused: 'Cloud sign-in is paused right now. Your work keeps saving on this device.',
    invalid_or_expired: 'That code is wrong or has expired. Check it, or send a new code.',
    locked: 'This account is locked. Contact ' + SUPPORT + '.',
    upgrade: 'Please reload the page to update the app before signing in.',
    bad_request: 'Please check the address and try again.',
    consent_required: 'The Terms of Use or the Privacy notice changed. Please accept the current versions.',
    reauth: 'Please confirm it is you with a code.',
  };
  function errText(e) {
    if (!e) return 'Something went wrong. Try again.';
    if (e.code === 'rate') return 'Too many attempts. Try again in ' + Math.max(1, Math.round(e.retryAfter || 30)) + ' s.';
    if (MSG[e.code]) return MSG[e.code];
    if (e.status >= 500) return MSG.server;
    return 'Something went wrong (' + esc(e.code) + '). Try again.';
  }
  function message(text, kind) {
    var m = $('acct_msg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'acct-msg' + (kind ? ' acct-msg--' + kind : '');
  }
  function ensureCss() {
    if (!HAS_DOC || $('acct_css')) return;
    var st = document.createElement('style'); st.id = 'acct_css';
    st.textContent = [
      '.acct-chip{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 10px;border-radius:16px;border:1px solid var(--border,#555);background:var(--bg3,#222);color:var(--text,#eee);font-size:13px;cursor:pointer}',
      '.acct-chip:focus-visible{outline:2px solid var(--accent,#4da3ff);outline-offset:2px}',
      '.acct-init{display:inline-flex;width:22px;height:22px;border-radius:50%;align-items:center;justify-content:center;background:var(--accent,#2f6fb0);color:#fff;font-weight:700;font-size:12px}',
      '.acct-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#888}',
      '.acct-dot--ok{background:#2fa84f}.acct-dot--warn{background:#e0a020}.acct-dot--bad{background:#d9483b}.acct-dot--off{background:#888}',
      '.acct-dot--hollow{background:transparent;border:2px solid #888;box-sizing:border-box}',
      '.acct-dot--spin{background:#4da3ff;animation:acctPulse 1s ease-in-out infinite}@keyframes acctPulse{50%{opacity:.35}}',
      '.acct-wrap{position:relative;display:inline-block}',
      '.acct-menu,.acct-cloud-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:10050;min-width:240px;background:var(--bg2,#1b1b1b);border:1px solid var(--border,#555);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.45);padding:6px;display:flex;flex-direction:column;gap:2px}',
      '.acct-menu button,.acct-cloud-menu button{text-align:left;background:none;border:0;color:var(--text,#eee);padding:8px 10px;border-radius:6px;font-size:14px;cursor:pointer;min-height:36px}',
      '.acct-menu button:hover,.acct-cloud-menu button:hover,.acct-menu button:focus-visible,.acct-cloud-menu button:focus-visible{background:var(--bg3,#2a2a2a)}',
      '.acct-menu-who{padding:6px 10px;color:var(--text2,#bbb);font-size:12px;border-bottom:1px solid var(--border,#444);margin-bottom:4px}',
      '.acct-ov{position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;overflow:auto}',
      '.acct-dlg{background:var(--bg2,#1b1b1b);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:10px;width:100%;max-width:440px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.5);box-sizing:border-box}',
      '.acct-dlg h3{margin:0 0 10px;font-size:18px;display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.acct-dlg label{display:block;margin:10px 0 4px;font-size:13px;color:var(--text2,#ccc)}',
      '.acct-dlg input[type=email],.acct-dlg input[type=text]{width:100%;box-sizing:border-box;font-size:16px;padding:9px 10px;border-radius:6px;border:1px solid var(--border,#555);background:var(--bg,#111);color:var(--text,#eee)}',
      '.acct-dlg .acct-tick{display:flex;gap:8px;align-items:flex-start;font-size:13px}',
      '.acct-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.acct-btns .btn{min-height:40px}',
      '.acct-or{display:flex;align-items:center;gap:8px;margin:14px 0 8px;color:var(--text3,#999);font-size:12px}.acct-or:before,.acct-or:after{content:"";flex:1;border-top:1px solid var(--border,#444)}',
      '.acct-providers:empty{display:none}.acct-providers{display:flex;flex-direction:column;gap:8px}',
      '.acct-or.acct-or--none{display:none}',
      '.acct-msg{min-height:1.2em;margin-top:10px;font-size:13px}.acct-msg--err{color:#ff8a80}.acct-msg--ok{color:#8bd48b}',
      '.acct-note{font-size:12px;color:var(--text3,#aaa);margin-top:8px}',
      // the host's .fg-item / .acct-btns display rules must not override the hidden attribute on account rows (review fix)
      '#acct_root [hidden],.acct-dlg [hidden],.acct-ov[hidden]{display:none!important}',
      '.acct-faq{margin-top:12px;font-size:13px}.acct-faq ul{padding-left:18px;margin:6px 0}.acct-faq li{margin:4px 0}',
      '.acct-x{background:none;border:0;color:var(--text2,#ccc);font-size:20px;cursor:pointer;min-width:36px;min-height:36px}',
      '.acct-list{list-style:none;padding:0;margin:8px 0;max-height:46vh;overflow:auto}.acct-list li{padding:6px 0;border-bottom:1px solid var(--border,#333)}',
      '.acct-sync-bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10040;background:var(--bg3,#222);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:8px;padding:8px 10px 8px 14px;display:block;font-size:13px;max-width:calc(100vw - 32px);box-shadow:0 6px 24px rgba(0,0,0,.4);box-sizing:border-box}',
      '.acct-sync-bar .acct-bar-in{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      // class selectors only (no id, no inline position): the iOS safe-area rules of ios-styles.css (scoped to the app's root class) must be able to win
      '.acct-toast{position:fixed;right:16px;top:16px;z-index:10055;background:var(--bg3,#222);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:8px;padding:8px 12px;font-size:13px;max-width:calc(100vw - 32px);box-sizing:border-box}',
      // the account page drawn in its own overlay (no host route): under the choice dialogs, wider than a dialog
      '.acct-ov.acct-page-ov{z-index:10058}.acct-dlg.acct-page-dlg{max-width:980px}',
      // §11.3: at phone width the account tables become stacked rows with full-width buttons
      '@media (max-width:600px){#acct_root table.dtable,#acct_root table.dtable tbody,#acct_root table.dtable tr,#acct_root table.dtable td{display:block;width:100%;box-sizing:border-box}',
      '#acct_root table.dtable thead{display:none}#acct_root table.dtable tr{border-bottom:1px solid var(--border,#444);padding:8px 0}',
      '#acct_root table.dtable td{border:0;padding:3px 0}#acct_root table.dtable td[data-label]:before{content:attr(data-label);display:block;font-size:12px;color:var(--text2,#bbb)}',
      '#acct_root .btn{display:block;width:100%;min-height:44px;font-size:16px;margin:4px 0}#acct_root .acct-btns input{width:100%;font-size:16px}}',
      '@media (max-width:600px){.acct-chip .acct-txt{display:none}.acct-chip{min-width:44px;min-height:44px;justify-content:center;padding:4px}',
      '.acct-ov{padding:0;align-items:stretch}.acct-dlg{max-width:none;min-height:100%;border-radius:0;padding:16px}',
      '.acct-btns .btn{flex:1 1 100%;min-height:44px;font-size:16px}.acct-menu button,.acct-cloud-menu button{min-height:44px;font-size:16px}',
      '.acct-menu,.acct-cloud-menu{position:fixed;left:16px;right:16px;top:auto;min-width:0}',
      '.acct-sync-bar{left:16px;right:16px;transform:none;max-width:none}}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  function openDialog(mode, opts) {
    if (!HAS_DOC) return null;
    ensureCss();
    var ov = $('acct_dlg_ov');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'acct_dlg_ov';
      ov.className = 'acct-ov rp-skip';
      ov.setAttribute('data-rp-nosnap', '1');
      ov.innerHTML = '<div class="acct-dlg" id="acct_dlg" role="dialog" aria-modal="true" aria-labelledby="acct_dlg_t">' +
        '<h3><span id="acct_dlg_t">Sign in</span><button type="button" class="acct-x" id="acct_dlg_x" aria-label="Close">&#215;</button></h3>' +
        '<div id="acct_dlg_body"></div><div id="acct_msg" class="acct-msg" role="status" aria-live="polite"></div></div>';
      document.body.appendChild(ov);
      $('acct_dlg_x').addEventListener('click', function () { closeDialog(true); });
      dlg.onKey = function (ev) { if (ev && ev.key === 'Escape' && dlg.open) { ev.preventDefault && ev.preventDefault(); closeDialog(true); } };
      document.addEventListener('keydown', dlg.onKey);
      try { dlg.opener = document.activeElement; } catch (e) { dlg.opener = null; }
    }
    dlg.open = true; dlg.mode = mode || dlg.mode || 'signin';
    if (opts && opts.title) $('acct_dlg_t').textContent = opts.title;
    return ov;
  }
  // closeDialog(cancelled): removes the overlay, returns focus, settles a pending choose() with null.
  function closeDialog(cancelled) {
    var ov = $('acct_dlg_ov');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    if (dlg.onKey && HAS_DOC) document.removeEventListener('keydown', dlg.onKey);
    dlg.onKey = null;
    var wasOpen = dlg.open;
    dlg.open = false; dlg.step = null;
    var ch = dlg.choice; dlg.choice = null;
    if (ch) ch(null);
    var r = dlg.resolve; dlg.resolve = null;
    if (r && wasOpen) r(cancelled ? null : state());
    try { if (dlg.opener && dlg.opener.focus) dlg.opener.focus(); } catch (e) { /* gone */ }
    dlg.opener = null;
  }
  function body() { return $('acct_dlg_body'); }
  function setTitle(t) { var e = $('acct_dlg_t'); if (e) e.textContent = t; }
  function focusFirst(id) { var e = $(id); try { if (e && e.focus) e.focus(); } catch (x) { /* none */ } }

  // setStep(name, data) — the one place a step is drawn. Steps: email, code, consent, stepup, busy, choice (choose()).
  function setStep(name, data) {
    if (!dlg.open && name !== 'busy') openDialog(dlg.mode);
    if (!dlg.open) return;
    data = data || {};
    dlg.step = name;
    var b = body(); if (!b) return;
    message('');
    if (name === 'email') return drawEmail(b, data);
    if (name === 'code') return drawCode(b, data);
    if (name === 'consent') return drawConsent(b, data);
    if (name === 'stepup') return drawStepUp(b, data);
    if (name === 'busy') { b.innerHTML = '<p>' + esc(data.text || 'Working…') + '</p>'; return; }
    if (name === 'revert') return drawRevert(b, data);
  }
  // #account-revert (the link in the "your e-mail address was changed" notice, §4.3): the old address and the 7-day revert key
  // (26 letters and digits; the notice's link #account-revert=<key> fills it in)
  function drawRevert(b, data) {
    setTitle('Undo an e-mail change');
    b.innerHTML = '<p>Your account\'s e-mail address was changed. If that was not you, enter your previous address and the code from the notice. ' +
      'This signs out every session and removes sign-in methods added since the change.</p>' +
      '<label for="acct_rev_email">Previous e-mail address</label><input type="email" id="acct_rev_email" maxlength="254" autocomplete="username">' +
      '<label for="acct_rev_code">Revert key from the notice</label><input type="text" id="acct_rev_code" maxlength="40" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_rev_go">Undo the change</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_rev_cancel">Cancel</button></div>';
    $('acct_rev_cancel').addEventListener('click', function () { closeDialog(true); });
    $('acct_rev_go').addEventListener('click', function () {
      var em = String($('acct_rev_email').value || '').trim(); var code = String($('acct_rev_code').value || '').replace(/[\s-]/g, '').toUpperCase();
      if (!EMAIL_RE.test(em) || !/^[A-Z2-7]{26}$/.test(code)) { message('Enter the previous address and the 26-character revert key from the notice.', 'err'); return; }
      revertEmail(em, code).then(function (r) {
        message('Done: your previous address is back and ' + r.sessions + ' session' + (r.sessions === 1 ? ' was' : 's were') + ' signed out.', 'ok');
      }, function (e) { message(errText(e), 'err'); });
    });
    if (data && data.key) $('acct_rev_code').value = data.key;
    focusFirst('acct_rev_email');
  }
  function revertEmail(email, code) {
    return call('POST', '/auth/email/revert', { email: email, code: code }).then(function (r) {
      lsSet(KEYS.hint, JSON.stringify({ signedIn: true, initial: String(email)[0].toUpperCase(), public: false, lastSeenAt: now(), v: 3 }));
      return refresh().then(function () { return r.json; });
    });
  }
  function drawEmail(b, data) {
    setTitle('Sign in to Well Testing Suite');
    b.innerHTML =
      '<p>Use your e-mail address: we send you an 8-digit code. There is no password. Without signing in, your work stays on this device only.</p>' +
      (data.note ? '<p class="acct-note">' + esc(data.note) + '</p>' : '') +
      '<label for="acct_email">E-mail address</label>' +
      '<input type="email" id="acct_email" inputmode="email" autocomplete="username webauthn" maxlength="254" spellcheck="false" value="' + esc(dlg.email) + '">' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_send">Send code</button></div>' +
      '<div class="acct-or acct-or--none" id="acct_or">or</div>' +
      '<div id="acct_provider_buttons" class="acct-providers" data-owner="WP-O"></div>' +
      '<label class="acct-tick"><input type="checkbox" id="acct_public"' + (dlg.publicDevice ? ' checked' : '') + '> This is a public or shared computer</label>' +
      '<p class="acct-note">On a public computer you are signed out after 12 hours and this browser keeps nothing of your work.</p>';
    $('acct_send').addEventListener('click', sendCode);
    $('acct_email').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') sendCode(); });
    $('acct_public').addEventListener('change', function () { dlg.publicDevice = !!$('acct_public').checked; drawProviders(); });
    drawProviders();
    focusFirst('acct_email');
  }
  // WP-O mount: provider buttons are drawn by hooks.renderProviders after GET /auth/providers (only when WP-O is present).
  function drawProviders() {
    var el = $('acct_provider_buttons');
    if (!el || typeof hooks.renderProviders !== 'function') return;
    var pubNow = dlg.publicDevice;
    providers().then(function (prov) {
      var el2 = $('acct_provider_buttons');
      if (!el2 || dlg.step !== 'email') return;
      el2.innerHTML = '';
      try { hooks.renderProviders(el2, prov, { publicDevice: pubNow, sharedBrowser: lsGet(KEYS.shared) === '1' }); } catch (e) { /* WP-O */ }
      var or = $('acct_or'); if (or) or.className = 'acct-or' + (el2.firstChild ? '' : ' acct-or--none');
    }, function () { /* the code path is unchanged */ });
  }
  function sendCode() {
    var inp = $('acct_email');
    var email = String(inp ? inp.value : dlg.email).trim();
    if (!EMAIL_RE.test(email) || email.length > 254) { message('Please enter one e-mail address.', 'err'); return Promise.resolve(false); }
    dlg.email = email;
    var pub = $('acct_public'); if (pub) dlg.publicDevice = !!pub.checked;
    var btn = $('acct_send'); if (btn) btn.disabled = true;
    message('Sending…');
    return call('POST', '/auth/code/start', { email: email, purpose: 'signin' }).then(function () {
      setStep('code', { email: email });
      return true;
    }, function (e) {
      if (btn) btn.disabled = false;
      message(errText(e), 'err');
      return false;
    });
  }
  function codeFaq(stepup) {
    return '<details class="acct-faq" id="acct_faq"><summary>Didn\'t get the code?</summary><ul>' +
      '<li>Look in your spam or quarantine folder; some company mail filters hold new senders for a few minutes.</li>' +
      '<li>Ask your IT team to allow mail from no-reply@h2oil.co.uk.</li>' +
      '<li>Codes last 15 minutes. After "Send again" the previous code still works, so use whichever arrives first.</li>' +
      (stepup ? '<li><button type="button" class="btn btn-secondary" id="acct_stepup_recovery">Send the code to my recovery address</button></li>'
        : '<li>If you added a recovery address to your account, you can type it instead: the code goes there. <button type="button" class="btn btn-secondary" id="acct_use_recovery">Send the code to my recovery address</button></li>') +
      '<li>Still nothing? Write to ' + SUPPORT + '.</li></ul></details>';
  }
  function drawCode(b, data) {
    setTitle('Enter your code');
    b.innerHTML =
      '<p>We sent an 8-digit code to <b>' + esc(dlg.email) + '</b>. It expires in 15 minutes. Only enter it here, at welltest.h2oil.co.uk.</p>' +
      '<label for="acct_code">Code</label>' +
      '<input type="text" id="acct_code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" spellcheck="false">' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_verify">Sign in</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_resend">Send again</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_back">Use another address</button></div>' + codeFaq(false);
    $('acct_verify').addEventListener('click', function () { verifyCode(); });
    $('acct_code').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') verifyCode(); });
    $('acct_resend').addEventListener('click', function () {
      $('acct_resend').disabled = true;
      call('POST', '/auth/code/start', { email: dlg.email, purpose: 'signin' }).then(function () {
        message('A new code is on its way. The previous one still works.', 'ok');
        var r = $('acct_resend'); if (r) r.disabled = false;   // enabled again from the server's reply (no countdown timer)
      }, function (e) { var r = $('acct_resend'); if (r) r.disabled = false; message(errText(e), 'err'); });
    });
    $('acct_back').addEventListener('click', function () { setStep('email'); });
    $('acct_use_recovery').addEventListener('click', function () { dlg.email = ''; setStep('email', { note: 'Type your recovery address. The code is sent there and signs you in to the same account.' }); });
    focusFirst('acct_code');
  }
  function verifyCode(consent) {
    var inp = $('acct_code');
    var code = inp ? String(inp.value || '').replace(/\s/g, '') : (dlg.code || '');
    if (!/^\d{8}$/.test(code)) { message('The code has 8 digits.', 'err'); return Promise.resolve(false); }
    dlg.code = code;
    var req = { email: dlg.email, code: code, publicDevice: !!dlg.publicDevice, deviceLabel: deviceLabel() };
    if (consent) req.consent = consent;
    var btn = $('acct_verify') || $('acct_create'); if (btn) btn.disabled = true;
    return call('POST', '/auth/code/verify', req).then(function (r) {
      dlg.code = null;
      return completeSignIn(r.json, { method: 'code' }).then(function () { return true; });
    }, function (e) {
      if (btn) btn.disabled = false;
      if (e && e.code === 'consent_required') { setStep('consent', { terms: e.body && e.body.terms, privacy: e.body && e.body.privacy }); return false; }
      message(errText(e), 'err');
      return false;
    });
  }
  function drawConsent(b, data) {
    setTitle('Create your account');
    dlg.consent = { terms: String(data.terms || ''), privacy: String(data.privacy || '') };
    b.innerHTML =
      '<p>You are creating a new account for <b>' + esc(dlg.email) + '</b>. Already have an account with another address? Cancel and sign in with it.</p>' +
      '<label class="acct-tick"><input type="checkbox" id="acct_consent_ok"> I accept the Terms of Use (version ' + esc(dlg.consent.terms) + ') and have read the Privacy notice (version ' + esc(dlg.consent.privacy) + ').</label>' +
      '<p class="acct-note">Your projects are stored encrypted in the UK / EU. You can export everything or delete your account at any time.</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_create">Create account</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_consent_cancel">Cancel</button></div>';
    $('acct_create').addEventListener('click', function () {
      if (!$('acct_consent_ok').checked) { message('Please tick the box to accept the Terms of Use and the Privacy notice.', 'err'); return; }
      verifyCode(dlg.consent);
    });
    $('acct_consent_cancel').addEventListener('click', function () { closeDialog(true); });
  }

  // openSignIn(opts) → Promise<state|null>: resolves with the state once signed in, null when the dialog is closed.
  function openSignIn(opts) {
    opts = opts || {};
    if (!HAS_DOC) return Promise.resolve(null);
    if (current.status === 'signedIn' && !opts.force) return Promise.resolve(state());
    return new Promise(function (resolve) {
      if (dlg.resolve) { var old = dlg.resolve; dlg.resolve = null; old(null); }
      openDialog('signin');
      dlg.resolve = resolve;
      if (opts.email) dlg.email = String(opts.email);
      if (!isOnline()) { setStep('email'); message(MSG.network, 'err'); return; }
      setStep('email');
    });
  }

  // ── step-up (§4.7) ─────────────────────────────────────────────────────────────────────────────────────────────────
  // stepUp() → Promise<boolean>: a code to the primary (or the recovery) address, entered in place; resolves true once
  // code/verify (bound to this session) succeeds — the server sets stepup_at and rotates the session.
  var stepping = null;
  function stepUp(opts) {
    if (stepping) return stepping;
    if (current.status !== 'signedIn') return Promise.reject(new AccountError('signed_out', 401, null));
    stepping = new Promise(function (resolve) {
      openDialog('stepup', { title: 'Confirm it is you' });
      dlg.choice = function (v) { resolve(!!v); };
      setStep('stepup', opts || {});
    }).then(function (v) { stepping = null; return v; }, function () { stepping = null; return false; });
    return stepping;
  }
  function drawStepUp(b, data) {
    setTitle('Confirm it is you');
    b.innerHTML =
      '<p>' + esc(data.reason || 'This action needs a fresh confirmation.') + ' We sent an 8-digit code to your account address' +
      (current.user && current.user.emailMasked ? ' <b>' + esc(current.user.emailMasked) + '</b>' : '') + '.</p>' +
      '<label for="acct_code">Code</label><input type="text" id="acct_code" inputmode="numeric" autocomplete="one-time-code" maxlength="11">' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_verify">Confirm</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_resend">Send again</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_stepup_cancel">Cancel</button></div>' + codeFaq(true);
    var to = data.to === 'recovery' ? 'recovery' : 'primary';
    function send(t) {
      return call('POST', '/auth/code/start', { purpose: 'stepup', to: t }).then(function () {
        message(t === 'recovery' ? 'A code is on its way to your recovery address.' : 'A code is on its way.', 'ok');
      }, function (e) { message(errText(e), 'err'); });
    }
    send(to);
    $('acct_resend').addEventListener('click', function () { send(to); });
    $('acct_stepup_recovery').addEventListener('click', function () { to = 'recovery'; send('recovery'); });
    $('acct_stepup_cancel').addEventListener('click', function () { closeDialog(true); });
    function confirm() {
      var code = String($('acct_code').value || '').replace(/\s/g, '');
      if (!/^\d{8}$/.test(code)) { message('The code has 8 digits.', 'err'); return; }
      $('acct_verify').disabled = true;
      call('POST', '/auth/code/verify', { code: code, publicDevice: !!current.publicDevice }).then(function () {
        var ch = dlg.choice; dlg.choice = null;
        closeDialog(false);
        if (ch) ch(true);
      }, function (e) {
        var v = $('acct_verify'); if (v) v.disabled = false;
        message(errText(e), 'err');
      });
    }
    $('acct_verify').addEventListener('click', confirm);
    $('acct_code').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') confirm(); });
    focusFirst('acct_code');
  }
  // withStepUp(fn): runs fn(); on 403 reauth runs the step-up in place and repeats fn() once.
  function withStepUp(fn, reason) {
    return Promise.resolve().then(fn).then(null, function (e) {
      if (!e || e.code !== 'reauth') return handleError(e);
      return stepUp({ reason: reason }).then(function (ok) {
        if (!ok) throw new AccountError('cancelled', 0, null);
        return fn();
      });
    });
  }

  // ── choose(): a generic choice step in the dialog (hand-over, conflict, wipe guard, open-file) ──────────────────────────
  // choose({title, text, html, list:[text], buttons:[{id, label, primary}]}) → Promise<id|null> (null = closed)
  function choose(o) {
    o = o || {};
    if (!HAS_DOC) return Promise.resolve(null);
    return new Promise(function (resolve) {
      openDialog(dlg.mode || 'choice');
      if (dlg.choice) { var prev = dlg.choice; dlg.choice = null; prev(null); }
      dlg.step = 'choice';
      setTitle(o.title || 'Cloud projects');
      var b = body();
      var html = (o.text ? '<p>' + esc(o.text) + '</p>' : '') + (o.html || '') +
        (o.list && o.list.length ? '<ul class="acct-list" id="acct_choice_list">' + o.list.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="acct-btns">' + (o.buttons || []).map(function (bt) {
          return '<button type="button" class="btn ' + (bt.primary ? 'btn-primary' : 'btn-secondary') + '" id="acct_ch_' + esc(bt.id) + '" data-choice="' + esc(bt.id) + '">' + esc(bt.label) + '</button>';
        }).join('') + '</div>';
      b.innerHTML = html;
      message(o.message || '');
      dlg.choice = resolve;
      (o.buttons || []).forEach(function (bt) {
        var el = $('acct_ch_' + bt.id);
        if (el) el.addEventListener('click', function () {
          var ch = dlg.choice; dlg.choice = null;
          if (!o.keepOpen) closeDialog(false);
          if (ch) ch(bt.id);
        });
      });
      var first = (o.buttons || []).filter(function (x) { return x.primary; })[0] || (o.buttons || [])[0];
      if (first) focusFirst('acct_ch_' + first.id);
    });
  }

  // ── sign-out (§10.8) ───────────────────────────────────────────────────────────────────────────────────────────────
  // signOut({everywhere, clearLocal, keep}) — trusted device: "Keep a copy of the open project in this browser?" (default
  // Keep); public device: the guarded wipe in 67 (blocked while changes wait). everywhere: step-up, POST signout-all.
  function signOut(o) {
    o = o || {};
    if (current.status !== 'signedIn' && !(current.status === 'unavailable' && readHint())) return signedOutLocal('signout').then(state);
    var S = sync();
    var pub = !!current.publicDevice || !!(readHint() || {}).public;
    var user = current.user;
    var method = current.authMethod || (current.me && current.me.session && current.me.session.authMethod) || null;   // captured now: setState below clears it before WP-O's hook runs
    var guard = Promise.resolve('proceed');
    if (pub && S && typeof S.publicSignOutGuard === 'function') guard = S.publicSignOutGuard(user);
    return guard.then(function (g) {
      if (g === 'cancel') return state();
      var server = o.everywhere
        ? withStepUp(function () { return call('POST', '/auth/signout-all', o.alsoRecentMethodsDays ? { alsoRecentMethodsDays: o.alsoRecentMethodsDays } : {}); }, 'Signing out everywhere needs a fresh confirmation.')
        : call('POST', '/auth/signout', {});
      return server.then(null, function (e) {
        if (e && e.code === 'cancelled') throw e;
        return null;   // signed out locally whatever the server answers (an outage must not keep a shared PC signed in)
      }).then(function () {
        if (pub) {
          var p = S && S.wipeDevice ? S.wipeDevice({ reason: 'signout', historian: o.historian !== false }) : Promise.resolve();
          return p.then(function () {
            writeHint(null);
            setState({ status: 'signedOut', user: null, publicDevice: false, me: null, opts: null, authMethod: null, reason: 'signout' });
            if (typeof hooks.onPublicSignOut === 'function') { try { return Promise.resolve(hooks.onPublicSignOut({ authMethod: method })).then(state); } catch (e) { /* WP-O */ } }
            return state();
          });
        }
        var keepQ = (o.keep !== undefined || o.clearLocal !== undefined) ? Promise.resolve(o.clearLocal ? 'remove' : (o.keep === false ? 'remove' : 'keep'))
          : choose({ title: 'Sign out', text: 'Keep a copy of the open project in this browser?', buttons: [{ id: 'keep', label: 'Keep', primary: true }, { id: 'remove', label: 'Remove it from this browser' }] });
        return keepQ.then(function (k) {
          var p = Promise.resolve();
          if (S && typeof S._noteSignedOut === 'function') p = p.then(function () { return S._noteSignedOut(user); });
          if (k === 'remove' && S && S.wipeDevice) p = p.then(function () { return S.wipeDevice({ reason: 'signout', historian: false, keepLocked: true }); });
          return p.then(function () {
            writeHint(null);
            setState({ status: 'signedOut', user: null, publicDevice: false, me: null, opts: null, authMethod: null, reason: 'signout' });
            return state();
          });
        });
      });
    }).then(null, function (e) { if (e && e.code === 'cancelled') return state(); throw e; });
  }

  // changeEmail() with no address (the Sign-in methods card, the provider dialog): never a request with an empty address — the
  // account page's "Change e-mail address" field gets the focus instead (sweep finding: it used to answer 400 silently)
  function focusChangeEmail() {
    var go = function () { var e = $('acct_new_email'); if (!e) return; try { if (e.scrollIntoView) e.scrollIntoView({ block: 'center' }); e.focus(); } catch (x) { /* focus */ } };
    if (!$('acct_new_email') && G.WTS_accountPage && typeof G.WTS_accountPage.open === 'function') { try { G.WTS_accountPage.open(); } catch (x) { /* none */ } }
    go();
  }
  function changeEmail(newEmail) {
    if (newEmail == null || String(newEmail).trim() === '') { focusChangeEmail(); return Promise.resolve(false); }
    return withStepUp(function () { return call('POST', '/auth/email/change', { newEmail: String(newEmail || '') }); }, 'Changing your e-mail address needs a fresh confirmation.')
      .then(function () { return true; });
  }
  function confirmEmail(code) {
    return call('POST', '/auth/email/confirm', { code: String(code || '') }).then(function (r) { return refresh().then(function () { return r.json; }); }, handleError);
  }
  function setRecovery(email) {
    return withStepUp(function () { return call('POST', '/auth/recovery/set', { email: String(email || '') }); }, 'Adding a recovery address needs a fresh confirmation.').then(function () { return true; });
  }
  function confirmRecovery(code) {
    return withStepUp(function () { return call('POST', '/auth/recovery/set', { code: String(code || '') }); }).then(function () { return refresh(); });
  }
  function removeRecovery() {
    return withStepUp(function () { return call('POST', '/auth/recovery/remove', {}); }, 'Removing the recovery address needs a fresh confirmation.').then(function () { return refresh(); });
  }

  // ── header chip (§11.1) ────────────────────────────────────────────────────────────────────────────────────────────
  var mounted = false;
  function chipInfo() {
    var S = sync();
    var st = S && typeof S.status === 'function' ? S.status() : { state: 'off' };
    if (current.status === 'unavailable') {
      if (current.reason === 'paused') return { cls: 'off', text: 'Cloud sync paused', title: 'Cloud sync paused — your work is saved on this device' };
      if (current.reason === 'upgrade') return { cls: 'off', text: 'Reload to update', title: 'Reload the page to keep using the cloud' };
      if (current.reason === 'locked') return { cls: 'bad', text: 'Account locked', title: 'Contact ' + SUPPORT };
      return { cls: 'off', text: 'Cloud unavailable — saved on this device', title: lastSyncTitle(st) };
    }
    if (current.reason === 'outage' || st.state === 'unavailable') return { cls: 'off', text: 'Cloud unavailable — saved on this device', title: lastSyncTitle(st) };
    if (!isOnline() || st.state === 'offline') return { cls: 'off', text: 'Offline — saved on this device', title: lastSyncTitle(st) };
    switch (st.state) {
      case 'syncing': return { cls: 'spin', text: '⟳ Syncing', title: 'Saving to the cloud' };
      case 'idle': return { cls: 'ok', text: '● Synced ' + hhmm(st.lastSyncAt), title: 'Saved to the cloud' + (st.name ? ' as ' + st.name : '') };
      case 'dirty': return { cls: 'warn', text: '○ Not saved to cloud', title: 'Changed since the last cloud save' };
      case 'conflict': return { cls: 'bad', text: '⚠ Newer version in the cloud', title: 'The cloud copy changed on another device' };
      case 'quota': return { cls: 'bad', text: '⚠ Storage full', title: 'Your cloud storage is full; nothing is lost on this device' };
      case 'paused': return { cls: 'off', text: 'Cloud sync paused', title: 'Your work is saved on this device' };
      case 'readonly': return { cls: 'off', text: 'Cloud read-only', title: 'Cloud saves are paused; opening still works' };
      default: return { cls: 'hollow', text: 'Not in cloud', title: 'This device\'s project isn\'t in the cloud' };
    }
  }
  function lastSyncTitle(st) { return 'Your work is saved on this device' + (st && st.lastSyncAt ? '. Last cloud save ' + hhmm(st.lastSyncAt) : ''); }
  function ensureHost() {
    if (!HAS_DOC) return null;
    var host = $('wts_account_host');
    if (host) return host;
    var pa = document.querySelector ? document.querySelector('.page-actions') : null;
    if (!pa) return null;
    host = document.createElement('div'); host.id = 'wts_account_host'; host.setAttribute('data-acct-created', '1');
    pa.insertBefore(host, pa.firstChild);
    return host;
  }
  function renderChip() {
    if (!mounted || !HAS_DOC) return;
    var host = ensureHost(); if (!host) return;
    var closeMenu = $('acct_menu'); if (closeMenu && closeMenu.parentNode) closeMenu.parentNode.removeChild(closeMenu);
    if (current.status === 'signedOut' || current.status === 'signingIn') {
      host.innerHTML = '<span class="acct-wrap"><button type="button" class="acct-chip" id="acct_chip" aria-label="Sign in" title="Sign in to save projects in the cloud">' +
        '<span aria-hidden="true">&#9729;</span><span class="acct-txt">Sign in</span></button></span>';
      $('acct_chip').addEventListener('click', function () { openSignIn(); });
      return;
    }
    var info = chipInfo();
    var h = readHint() || {};
    var initial = esc((current.user && current.user.emailMasked ? current.user.emailMasked[0] : h.initial || '?').toUpperCase());
    host.innerHTML = '<span class="acct-wrap"><button type="button" class="acct-chip" id="acct_chip" aria-haspopup="menu" aria-expanded="false" title="' + esc(info.title) + '">' +
      '<span class="acct-init" aria-hidden="true">' + initial + '</span><span class="acct-dot acct-dot--' + info.cls + '" aria-hidden="true"></span>' +
      '<span class="acct-txt" id="acct_chip_txt" aria-live="polite">' + esc(info.text) + '</span></button></span>';
    var chip = $('acct_chip');
    chip.setAttribute('aria-label', 'Account: ' + info.text);
    chip.addEventListener('click', toggleMenu);
  }
  function toggleMenu() {
    var m = $('acct_menu');
    if (m) { m.parentNode.removeChild(m); $('acct_chip').setAttribute('aria-expanded', 'false'); return; }
    var wrap = $('acct_chip').parentNode;
    var via = current.authMethod === 'google' ? ' via Google' : current.authMethod === 'linkedin' ? ' via LinkedIn' : '';
    var S = sync();
    var items = [
      { id: 'acct_m_save', label: 'Save to cloud', run: function () { cloudAction('save'); }, when: current.status === 'signedIn' },
      { id: 'acct_m_open', label: 'Open from cloud…', run: function () { cloudAction('open'); }, when: current.status === 'signedIn' },
      { id: 'acct_m_page', label: 'Account & projects', run: openAccountPage, when: true },
      { id: 'acct_m_retry', label: 'Try again', run: function () { refresh(); }, when: current.status === 'unavailable' },
      { id: 'acct_m_signout', label: 'Sign out', run: function () { signOut(); }, when: true },
      { id: 'acct_m_everywhere', label: 'Sign out everywhere…', run: function () { signOutEverywhereAsk(); }, when: current.status === 'signedIn' },
    ].filter(function (x) { return x.when; });
    m = document.createElement('div');
    m.id = 'acct_menu'; m.className = 'acct-menu rp-skip'; m.setAttribute('role', 'menu'); m.setAttribute('data-rp-nosnap', '1');
    m.innerHTML = '<div class="acct-menu-who" id="acct_menu_who">' + esc((current.user && current.user.emailMasked) || 'Signed in') + esc(via) +
      (S && S.status && S.status().name ? '<br>Project: ' + esc(S.status().name) : '') + '</div>' +
      items.map(function (it) { return '<button type="button" role="menuitem" id="' + it.id + '">' + esc(it.label) + '</button>'; }).join('');
    wrap.appendChild(m);
    $('acct_chip').setAttribute('aria-expanded', 'true');
    items.forEach(function (it) {
      $(it.id).addEventListener('click', function () {
        var mm = $('acct_menu'); if (mm && mm.parentNode) mm.parentNode.removeChild(mm);
        var c = $('acct_chip'); if (c) c.setAttribute('aria-expanded', 'false');
        it.run();
      });
    });
    var f = $(items[0].id); try { if (f && f.focus) f.focus(); } catch (e) { /* none */ }
  }
  // passkeys are named only when the account has any (Phase 1 has none: they answer 501)
  function recentMethodsText() {
    var me = current.me || {};
    return (me.passkeys && me.passkeys.length ? 'passkeys and ' : '') + 'Google / LinkedIn links';
  }
  function signOutEverywhereAsk() {
    return choose({ title: 'Sign out everywhere', text: 'Sign out of every browser and device that uses your account? This one is signed out too.',
      html: '<label class="acct-tick"><input type="checkbox" id="acct_recent_methods"> Also remove ' + recentMethodsText() + ' added in the last 14 days</label>',
      buttons: [{ id: 'all', label: 'Sign out everywhere', primary: true }, { id: 'cancel', label: 'Cancel' }], keepOpen: true })
      .then(function (c) {
        var tick = $('acct_recent_methods'); var recent = !!(tick && tick.checked);
        closeDialog(false);
        if (c !== 'all') return state();
        return signOut({ everywhere: true, alsoRecentMethodsDays: recent ? 14 : 0, keep: true });
      });
  }
  function openAccountPage() {
    var P = G.WTS_accountPage;
    if (P && typeof P.open === 'function') return P.open();
    if (typeof G.WTS_nav === 'function' && G.WTS_calcRegistry && G.WTS_calcRegistry.account) return G.WTS_nav('account');
    return null;
  }

  // ── cloud actions: the chip menu, the project toolbar button (H5) and Ctrl+S ────────────────────────────────────────
  function toast(text, kind) {
    if (!HAS_DOC) return;
    var t = $('acct_toast');
    if (!t) {
      ensureCss();
      t = document.createElement('div'); t.id = 'acct_toast'; t.className = 'acct-toast rp-skip'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
      t.setAttribute('data-rp-nosnap', '1');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.setAttribute('data-kind', kind || '');
  }
  function cloudAction(what, arg) {
    var S = sync();
    if (!S) return Promise.resolve(null);
    if (current.status !== 'signedIn') return openSignIn();
    var p;
    if (what === 'save') p = S.saveToCloud({});
    else if (what === 'saveas') p = S.saveToCloud({ as: true });
    else if (what === 'open') p = S.openPicker ? S.openPicker() : Promise.resolve(null);
    else if (what === 'import') p = S.pickAndImport ? S.pickAndImport() : Promise.resolve(null);
    else p = Promise.resolve(null);
    return p.then(function (r) {
      if (r && r.rev != null && !r.cancelled) toast(r.unchanged ? 'Already saved to the cloud.' : 'Saved to the cloud (version ' + r.rev + ').', 'ok');
      renderChip();
      return r;
    }, function (e) {
      renderChip();
      if (e && e.code === 'cancelled') return null;
      toast(cloudErrText(e), 'err');
      return null;
    });
  }
  function cloudErrText(e) {
    if (!e) return 'Cloud save failed. Your work is saved on this device.';
    if (isOutage(e)) return 'Cloud unavailable — your work is saved on this device.';
    if (e.code === 'quota') return 'Your cloud storage is full. Nothing is lost on this device.';
    if (e.code === 'too_large') return 'This project is too large for the cloud. Nothing is lost on this device.';
    if (e.code === 'readonly') return 'Cloud saves are paused right now (read-only). Your work is saved on this device.';
    if (e.code === 'paused') return 'Cloud sync is paused. Your work is saved on this device.';
    if (e.code === 'rate') return 'Too many cloud saves. Try again in ' + Math.max(1, Math.round(e.retryAfter || 30)) + ' s.';
    if (e.code === 'offline_dirty') return 'You are offline: save this project to a file first, or wait for the connection.';
    if (e.code === 'signed_out') return 'Signed out — sign in to keep using the cloud. Nothing is lost on this device.';
    if (e.code === 'not_found' || e.code === 'gone') return 'That cloud project is no longer available.';
    if (e.code === 'upgrade') return 'Reload to update the app. Your work is saved on this device.';
    if (e.code === 'bad_request') return 'Please check what you entered and try again. Your work is saved on this device.';
    return 'Cloud action failed (' + String(e.code || 'error') + '). Your work is saved on this device.';
  }
  function openCloudMenu(ev) {
    if (!HAS_DOC) return;
    var old = $('acct_cloud_menu'); if (old) { old.parentNode.removeChild(old); return; }
    ensureCss();
    var anchor = (ev && ev.currentTarget) || (document.querySelector && document.querySelector('[data-item="acct_tb_cloud"]')) || null;
    var m = document.createElement('div');
    m.id = 'acct_cloud_menu'; m.className = 'acct-cloud-menu rp-skip'; m.setAttribute('role', 'menu'); m.setAttribute('data-rp-nosnap', '1');
    var items = [['acct_c_save', 'Save to cloud', 'save'], ['acct_c_saveas', 'Save to cloud as…', 'saveas'], ['acct_c_open', 'Open from cloud…', 'open'], ['acct_c_import', 'Import files to cloud…', 'import']];
    m.innerHTML = items.map(function (it) { return '<button type="button" role="menuitem" id="' + it[0] + '">' + esc(it[1]) + '</button>'; }).join('');
    var parent = anchor && anchor.parentNode ? anchor.parentNode : document.body;
    if (parent.style && !parent.style.position) parent.style.position = 'relative';
    parent.appendChild(m);
    items.forEach(function (it) {
      $(it[0]).addEventListener('click', function () { var mm = $('acct_cloud_menu'); if (mm) mm.parentNode.removeChild(mm); cloudAction(it[2]); });
    });
  }
  var toolbarRegistered = false;
  function registerToolbar() {
    var P = G.WTS_project;
    if (toolbarRegistered || !P || typeof P.registerToolbarItems !== 'function') return false;
    P.registerToolbarItems([{ id: 'acct_tb_cloud', label: '☁ ▾', title: 'Cloud projects: save, open, import', run: openCloudMenu,
      when: function () { return current.status === 'signedIn'; } }]);
    toolbarRegistered = true;
    return true;
  }
  function refreshToolbar() {
    var P = G.WTS_project;
    if (toolbarRegistered && P && typeof P.refreshToolbarItems === 'function') { try { P.refreshToolbarItems(); } catch (e) { /* host */ } }
  }
  // Ctrl+S / Cmd+S saves to the cloud while signed in and linked (§11.1, D14); attached only while signed in.
  function onKeyS(ev) {
    if (!ev || !(ev.ctrlKey || ev.metaKey) || ev.altKey || String(ev.key || '').toLowerCase() !== 's') return;
    var S = sync();
    if (current.status !== 'signedIn' || !S || !S.status().projectId) return;
    if (ev.preventDefault) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
    cloudAction('save');
  }
  var attached = false;
  function attachSignedIn() {
    if (attached || !HAS_DOC) return;
    attached = true;
    document.addEventListener('keydown', onKeyS, true);
    var S = sync(); if (S && typeof S._attach === 'function') S._attach();
  }
  function detachSignedIn() {
    if (!attached || !HAS_DOC) return;
    attached = false;
    document.removeEventListener('keydown', onKeyS, true);
    var S = sync(); if (S && typeof S._detach === 'function') S._detach();
  }

  // ── status bar (§11.4) ─────────────────────────────────────────────────────────────────────────────────────────────
  var barDismissed = {};
  function renderBar() {
    if (!mounted || !HAS_DOC) return;
    var S = sync();
    var st = S && S.status ? S.status() : { pending: 0 };
    var kind = null, text = '', btns = [];
    if (current.status === 'signedOut' && current.reason === 'expired') {
      kind = 'signedout';
      text = 'Signed out — sign in to keep syncing.' + (st.pending ? ' ' + st.pending + ' change' + (st.pending === 1 ? '' : 's') + ' waiting.' : '');
      btns = [['acct_bar_signin', 'Sign in', function () { openSignIn(); }]];
    } else if (current.status === 'unavailable' && current.reason === 'paused') {
      kind = 'paused'; text = 'Cloud sync paused — your work is saved on this device.';
    } else if ((current.status === 'unavailable' || current.status === 'signedIn') && current.reason === 'outage') {
      kind = 'unavailable'; text = 'Cloud unavailable — your work is saved on this device.' + (st.lastSyncAt ? ' Last cloud save ' + hhmm(st.lastSyncAt) + '.' : '');
      btns = [['acct_bar_retry', 'Try again', function () { refresh(); }]];
    } else if (current.status === 'signedIn' && current.user && current.user.status === 'deleting') {
      kind = 'deleting'; text = 'Your account is being deleted' + (current.user.deleteAt ? ' on ' + String(current.user.deleteAt).slice(0, 10) : '') + '.';
      btns = [['acct_bar_cancel_del', 'Cancel deletion', function () { cancelDeletion(); }]];
    } else if (current.status === 'signedIn' && st.state === 'quota') {
      kind = 'quota'; text = 'Your cloud storage is full. Nothing is lost on this device.';
    }
    var bar = $('wts_sync_bar');
    if (!kind || barDismissed[kind]) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
    ensureCss();
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'wts_sync_bar'; bar.setAttribute('role', 'status');
      bar.className = 'acct-sync-bar rp-skip'; bar.setAttribute('data-rp-nosnap', '1');
      document.body.appendChild(bar);
    }
    bar.setAttribute('data-kind', kind);
    bar.innerHTML = '<div class="acct-bar-in"><span id="wts_sync_bar_text">' + esc(text) + '</span>' +
      btns.map(function (b) { return '<button type="button" class="btn btn-primary" id="' + b[0] + '" style="padding:5px 12px">' + esc(b[1]) + '</button>'; }).join('') +
      '<button type="button" class="btn btn-secondary" id="acct_bar_x" aria-label="Dismiss" style="padding:5px 9px">&#215;</button></div>';
    btns.forEach(function (b) { $(b[0]).addEventListener('click', b[2]); });
    $('acct_bar_x').addEventListener('click', function () { barDismissed[kind] = true; renderBar(); });
  }
  function cancelDeletion() {
    return call('POST', '/account/delete/cancel', {}).then(function () { return refresh(); }, handleError);
  }

  // ── mount (§5.5) ───────────────────────────────────────────────────────────────────────────────────────────────────
  function mount() {
    if (mounted || !HAS_DOC) return;
    if (!betaEnabled()) return;
    mounted = true;
    ensureCss();
    ensureHost();
    var h = readHint();
    if (h && h.signedIn) current.status = 'signedIn';   // paint from the hint; /me decides
    renderChip();
    registerToolbar();
    var S = sync(); if (S && typeof S._mount === 'function') S._mount();
    // the browser's own connection events (one-off listeners, no polling): back online → clear a network error and re-read
    // /me once, so the chip and bar never stay at "Cloud unavailable"; offline → re-render (review fix)
    if (typeof G.addEventListener === 'function') {
      G.addEventListener('online', onOnline);
      G.addEventListener('offline', function () { renderChip(); renderBar(); });
    }
    if (h && h.signedIn) refresh().then(null, function () { /* outage handled */ });
    else current.status = 'signedOut';
    // a provider return with a fresh hint entry was finished at load by the provider block (WTS_account.oauthReturn, which
    // strips the fragment); a #acct-oauth still here had no hint entry: it is ignored (no request) and removed
    if (String(L.hash || '') === '#acct-oauth') {
      try { if (G.history && G.history.replaceState) G.history.replaceState(null, '', String(L.pathname || '') + String(L.search || '')); } catch (e) { /* none */ }
    }
  }
  function onOnline() {
    var S = sync(); if (S && typeof S._netBack === 'function') S._netBack();
    var h = readHint();
    if (current.status === 'signedIn' || current.status === 'unavailable' || (h && h.signedIn)) {
      refresh().then(function () { renderChip(); renderBar(); }, function () { renderChip(); renderBar(); });
    } else { renderChip(); renderBar(); }
  }
  function openRevert(key) { openDialog('revert', { title: 'Undo an e-mail change' }); setStep('revert', { key: key || '' }); }
  // '#account-revert' or '#account-revert=<key>' (the notice's link) → {key} | null
  function revertHash(h) {
    var m = /^#account-revert(?:=([A-Za-z2-7]{26}))?$/.exec(String(h || ''));
    return m ? { key: (m[1] || '').toUpperCase() } : null;
  }
  function boot() {
    if (!HAS_DOC) return;
    // #account-revert (the notice's link): a user action, no request until submitted; during the Phase 1 beta only with the
    // beta flag, so the live site shows no account UI while no server is configured
    var rh = revertHash(L.hash);
    if (rh && betaEnabled()) {
      // the key leaves the address bar and the history entry at once (it stays only in the dialog's field)
      if (rh.key) { try { if (G.history && G.history.replaceState) G.history.replaceState(null, '', String(L.pathname || '') + String(L.search || '') + '#account-revert'); } catch (e) { /* none */ } }
      var go = function () { ensureCss(); openRevert(rh.key); };
      if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', go, { once: true });
      else if (typeof G.setTimeout === 'function') G.setTimeout(go, 0);
    }
    if (!betaEnabled()) return;
    if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', mount, { once: true });
    else if (typeof G.setTimeout === 'function') G.setTimeout(mount, 0);
  }

  function notYet(name) {
    return function () { return Promise.reject(new AccountError('not_implemented', 0, { error: 'not_implemented', message: name + ' is built in WP-O / Phase 3' })); };
  }
  var api = {
    eligible: true, VERSION: VERSION, PROVIDERS: PROVIDERS.slice(), Error: AccountError, KEYS: KEYS, hooks: hooks,
    configure: configure, seam: seam, state: state, call: call, providers: providers, on: on, off: off, betaEnabled: betaEnabled,
    refresh: refresh, openSignIn: openSignIn, signOut: signOut, stepUp: stepUp, withStepUp: withStepUp,
    changeEmail: changeEmail, confirmEmail: confirmEmail, setRecovery: setRecovery, confirmRecovery: confirmRecovery, removeRecovery: removeRecovery,
    cancelDeletion: cancelDeletion, revertEmail: revertEmail, openRevert: openRevert, mount: mount,
    addPasskey: notYet('addPasskey'), removePasskey: notYet('removePasskey'), renamePasskey: notYet('renamePasskey'),
    // signInWith, finishProviderSignIn, methods, linkProvider, unlinkMethod, providerSignOutNeeded, oauthReturn, oauthUI:
    // the provider block below (WP-O)
    // shared internals for 67 / 68 and WP-O (not a public contract)
    _i: { completeSignIn: completeSignIn, choose: choose, setStep: setStep, message: message, openDialog: openDialog, closeDialog: closeDialog,
      readHint: readHint, writeHint: writeHint, recentMethodsText: recentMethodsText, handleError: handleError, errText: errText, cloudErrText: cloudErrText, esc: esc, toast: toast,
      signedOutLocal: signedOutLocal, renderChip: renderChip, renderBar: renderBar, cloudAction: cloudAction, isOnline: isOnline, now: now,
      deviceLabel: deviceLabel, isOutage: isOutage, ensureCss: ensureCss, appVer: appVer, dialogOpen: function () { return dlg.open; } },
  };
  G.WTS_account = api;

  // ── WP-O: provider sign-in — Google and LinkedIn (docs/ACCOUNTS-PLAN.md §4.10–4.15, §5.2, §5.5, §11.2, §11.3) ─────────────
  // One contiguous block (WP-C1 owns the rest of this file). It defines signInWith, finishProviderSignIn, methods,
  // linkProvider and unlinkMethod, fills WP-C1's mount points (hooks.renderProviders under the e-mail step,
  // hooks.onPublicSignOut after a public sign-out, the account page's hooks.renderMethods through 68), completes a sign-in
  // through WP-C1's completeSignIn (device id, hint, /me, hand-over and migration, the analytics reload) and adds:
  //   WTS_account.oauthReturn()            on a load with #acct-oauth AND a fresh hint.oauth: strip the fragment, open the
  //                                        finish dialog and drive the steps (no request without the hint entry)
  //   WTS_account.providerSignOutNeeded()  'google' | 'linkedin' | null — a public session that came from a provider
  //   WTS_account.oauthUI = {renderButtons(el, {publicDevice}), renderMethods(el), openFinish(), providerSignOutStep(p),
  //                          label(p), ASSETS, text(code, provider, reason), FRESH_OK}
  // The page loads nothing from a provider: the buttons carry inline marks (ASSETS — one fixed variant each, to be checked
  // against the providers' current official assets in WP-HC; this is the only place to swap them); start → location.assign.
  // Every server string is shown with textContent. No timer, no polling; handlers are element properties.
  installProviders();
  function installProviders() {
    var NAME = { google: 'Google', linkedin: 'LinkedIn' };
    // Fresh-login support per provider (§4.11): LinkedIn has no pinned forced-login parameter yet (WP0), so its button is
    // hidden on a public / shared-browser attempt (start would answer oauth_failed reauth_stale).
    var FRESH_OK = { google: true, linkedin: false };
    var HINT_OAUTH_MAX_MS = 30 * 60 * 1000;
    var ASSETS = {
      google: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false">' +
        '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
        '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
        '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
        '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
      linkedin: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
        '<path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>',
    };
    var BTN_STYLE = 'display:flex;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;min-height:44px;' +
      'padding:8px 12px;margin:0 0 8px 0;border:1px solid #747775;border-radius:4px;background:#ffffff;color:#1f1f1f;font-size:16px;' +
      'font-weight:500;line-height:1.2;cursor:pointer';

    function label(p) { return 'Sign in with ' + NAME[p]; }
    function nowMs() { return seams.now ? seams.now() : Date.now(); }
    function readHint() { try { var h = JSON.parse(lsGet(KEYS.hint) || 'null'); return h && typeof h === 'object' ? h : {}; } catch (e) { return {}; } }
    function writeHint(h) { h.v = 3; lsSet(KEYS.hint, JSON.stringify(h)); }
    function dropOauth() { var h = readHint(); if (h.oauth) { delete h.oauth; writeHint(h); } }
    function freshOauth(h) {
      var o = h && h.oauth;
      return !!(o && PROVIDERS.indexOf(o.provider) !== -1 && typeof o.at === 'number' && nowMs() - o.at >= 0 && nowMs() - o.at < HINT_OAUTH_MAX_MS);
    }
    function sharedBrowser() { return lsGet(KEYS.shared) === '1'; }
    function currentRoute() {
      try { var r = G.WTS_pageAutosave && G.WTS_pageAutosave.page && G.WTS_pageAutosave.page(); return typeof r === 'string' ? r : 'home'; } catch (e) { return 'home'; }
    }
    // a route key the app knows (plug-in registry or a sidebar button); anything else → home (no open redirect)
    function knownRoute(r) {
      if (typeof r !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(r)) return false;
      if (G.WTS_calcRegistry && Object.prototype.hasOwnProperty.call(G.WTS_calcRegistry, r)) return true;
      try { var d = G.document; return !!(d && d.querySelector && d.querySelector('.nav-btn[data-p="' + r + '"]')); } catch (e) { return false; }
    }
    function offline() { return !isOnline(); }
    // a reauth answer runs the public WTS_account.stepUp (the code step-up of WP-C1; tests may replace it), then repeats once
    function stepUpThen(fn, reason) {
      return Promise.resolve().then(fn).then(null, function (e) {
        if (!e || e.code !== 'reauth') throw e;
        return Promise.resolve(api.stepUp({ reason: reason })).then(function (ok) {
          if (ok === false || ok === null) throw new AccountError('cancelled', 0, null);
          return fn();
        });
      });
    }

    // start → location.assign (never a form, never a popup: §4.10 items 1–2)
    function startProvider(p, purpose, o) {
      o = o || {};
      if (PROVIDERS.indexOf(p) === -1) return Promise.reject(new AccountError('bad_request', 0, { error: 'bad_request', message: 'provider' }));
      if (offline()) return Promise.reject(new AccountError('network', 0, null));
      try { if (G.WTS_pageAutosave && typeof G.WTS_pageAutosave.flush === 'function') G.WTS_pageAutosave.flush(); } catch (e) { /* page autosave */ }
      var body = { purpose: purpose, publicDevice: !!o.publicDevice };
      if (sharedBrowser()) body.sharedBrowser = true;
      if (o.deviceLabel) body.deviceLabel = String(o.deviceLabel);
      var h = readHint();
      h.oauth = { provider: p, route: currentRoute(), at: nowMs(), purpose: purpose };
      writeHint(h);
      return call('POST', '/auth/oauth/' + p + '/start', body).then(function (r) {
        var url = r.json && r.json.url;
        if (typeof url !== 'string' || !(/^https:\/\//.test(url) || (DEV && /^http:\/\//.test(url)))) throw new AccountError('server', r.status, null);
        G.location.assign(url);
        return { url: url };
      }, function (e) { dropOauth(); throw e; });
    }
    api.signInWith = function (p, o) { return startProvider(p, 'signin', o); };
    api.linkProvider = function (p) { return stepUpThen(function () { return startProvider(p, 'link', {}); }, 'Adding a sign-in method needs a fresh confirmation.'); };

    var TERMINAL = ['oauth_state', 'oauth_failed', 'locked', 'not_invited', 'signup_closed', 'identity_in_use', 'provider_linked', 'provider_off', 'paused'];
    // POST finish (first call with {}; later {email} | {code} | {consent}) → the server's answer; done signs the page in
    api.finishProviderSignIn = function (body) {
      return call('POST', '/auth/oauth/finish', body || {}).then(function (r) {
        var j = r.json || {};
        if (j.next === 'done' && j.linked) { dropOauth(); return j; }
        if (j.next !== 'done') return j;
        // the session cookie is set: WP-C1's completion (its own dialog may ask the hand-over question, so this one closes
        // first; the providerEmailDiffers note reopens it afterwards)
        closeDialog();
        return completeSignIn(j, { method: j.method }).then(function () { return j; }, function () { return j; });
      }, function (e) {
        if (e && TERMINAL.indexOf(e.code) !== -1) dropOauth();
        throw e;
      });
    };
    api.methods = function () { return call('GET', '/auth/methods').then(function (r) { return r.json; }); };
    api.unlinkMethod = function (id) {
      return stepUpThen(function () { return call('POST', '/auth/methods/unlink', { id: id }); }, 'Removing a sign-in method needs a fresh confirmation.').then(function (r) { return r.json; });
    };
    api.providerSignOutNeeded = function () {
      return current.publicDevice && PROVIDERS.indexOf(current.authMethod) !== -1 ? current.authMethod : null;
    };

    // ── plain-words messages (§11.2) ──
    function text(code, p, reason) {
      var N = NAME[p] || 'The provider';
      if (code === 'oauth_failed') {
        if (reason === 'cancelled') return 'Sign-in with ' + N + ' was cancelled.';
        if (reason === 'expired') return 'That took too long — try again.';
        if (reason === 'reauth_stale') return 'Please sign in to ' + N + ' again on this shared computer.';
        return N + ' sign-in did not complete. Try again, or use the e-mail code.';
      }
      var T = {
        oauth_state: 'Sign-in was interrupted — try again.',
        provider_off: N + ' sign-in is not available right now — use the e-mail code.',
        not_invited: 'The beta is invite-only. Sign in with the address you were invited with, or use the e-mail code.',
        signup_closed: 'New accounts are not open right now. Existing accounts can still sign in.',
        locked: 'This account is locked. Please contact software@h2oil.co.uk.',
        identity_in_use: 'This ' + N + ' account is linked to another Well Testing Suite account.',
        provider_linked: 'This account already has a ' + N + ' sign-in. Remove it under Account → Sign-in methods first.',
        invalid_or_expired: 'That code is wrong or has expired.',
        consent_required: 'The Terms of Use or Privacy notice changed. Please read them and accept again.',
        reauth: 'Please confirm it is you with an e-mail code first.',
        paused: 'Cloud sign-in is paused right now — your work is saved on this device.',
        network: 'Sign-in needs a connection. Your work keeps saving on this device.',
      };
      return T[code] || 'Cloud unavailable — your work is saved on this device.';
    }
    function codeText(reason, masked, p) {
      var N = NAME[p] || 'the provider';
      if (reason === 'link_existing') return 'An account already uses ' + masked + '. Enter the code we sent to it to add ' + N + '.';
      if (reason === 'link_confirm') return 'Enter the code we sent to ' + masked + ' to add ' + N + ' as a way to sign in.';
      if (reason === 'cancel_deletion') return 'This account is being deleted. Enter the code we sent to its address to cancel the deletion.';
      return 'We sent a code to ' + masked + '. Enter it to confirm this address.';
    }

    // ── DOM helpers (textContent for every server string) ──
    function doc() { return G.document || null; }
    function el(tag, attrs, kids) {
      var n = doc().createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        if (k === 'text') n.textContent = attrs[k];
        else if (k === 'onclick') n.onclick = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
      (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
      return n;
    }
    function providerButton(p, purpose, onPress) {
      var b = el('button', { type: 'button', 'class': 'acct-prov-btn', 'data-provider': p, 'data-purpose': purpose, 'aria-label': label(p), style: BTN_STYLE });
      var mark = el('span', { 'class': 'acct-prov-mark', 'aria-hidden': 'true', style: 'display:inline-flex;width:20px;height:20px' });
      mark.innerHTML = ASSETS[p];                          // a constant asset, never data
      b.appendChild(mark);
      b.appendChild(el('span', { 'class': 'acct-prov-label', text: label(p) }));
      b.onclick = onPress;
      return b;
    }
    function statusLine(host, msg) {
      var s = host.querySelector('.acct-prov-status');
      if (!s) { s = el('div', { 'class': 'acct-prov-status', role: 'status', 'aria-live': 'polite', style: 'margin:4px 0 8px 0;font-size:14px' }); host.appendChild(s); }
      s.textContent = msg || '';
      return s;
    }

    // The two provider buttons for the sign-in dialog (WP-C1's e-mail step mounts it through hooks.renderProviders). Asks
    // GET /auth/providers first (a user action); 'off' hides a button, 'signin' labels it "existing accounts only".
    // o.publicDevice: the dialog's tick. → Promise<{google, linkedin}> (the states drawn)
    function renderButtons(host, o) {
      o = o || {};
      if (!host || !doc()) return Promise.resolve(null);
      host.textContent = '';
      var fresh = !!o.publicDevice || sharedBrowser();
      return (o.states ? Promise.resolve(o.states) : api.providers()).then(function (st) {
        host.textContent = '';
        var wrap = el('div', { 'class': 'acct-prov', 'data-fresh': fresh ? '1' : '0' });
        PROVIDERS.forEach(function (p) {
          if (st[p] !== 'on' && st[p] !== 'signin') return;
          if (fresh && !FRESH_OK[p]) return;                 // no forced login for this provider: hidden while the tick is set
          wrap.appendChild(providerButton(p, 'signin', function () {
            statusLine(wrap, 'Taking you to ' + NAME[p] + '…');
            api.signInWith(p, { publicDevice: !!o.publicDevice }).catch(function (e) {
              statusLine(wrap, text(e && e.code, p, e && e.body && e.body.reason));
            });
          }));
          if (st[p] === 'signin') wrap.appendChild(el('div', { 'class': 'acct-prov-note', text: 'existing accounts only', style: 'margin:-4px 0 8px 0;font-size:13px' }));
        });
        var any = !!wrap.querySelector('.acct-prov-btn');
        if (fresh && any) {
          wrap.appendChild(el('div', { 'class': 'acct-prov-note acct-prov-public', style: 'font-size:13px;margin:0 0 8px 0',
            text: 'You will also be signed in to Google / LinkedIn in this browser — sign out of it too when you finish.' }));
        }
        if (any) wrap.appendChild(el('div', { 'class': 'acct-prov-note', style: 'font-size:13px', text: "Can't use Google or LinkedIn? Use the e-mail code." }));
        if (offline()) Array.prototype.forEach.call(wrap.querySelectorAll('.acct-prov-btn'), function (b) { b.disabled = true; b.setAttribute('title', 'needs a connection'); });
        host.appendChild(wrap);
        return st;
      });
    }

    // ── the finish dialog (the return from the provider) ──
    // This div keeps the focus rules of §11.2 itself: focus moves into it, Tab stays inside it, and closing returns focus to
    // the control that was focused before it opened. A done sign-in closes it before WP-C1's completion, whose own dialog asks
    // the hand-over question.
    var dlg = null; var dlgOpener = null; var dlgEscape = true;
    function focusables() {
      return dlg ? Array.prototype.filter.call(dlg.querySelectorAll('button, input'), function (n) { return !n.disabled; }) : [];
    }
    function dlgKey(ev) {
      if (!ev) return;
      if (ev.key === 'Escape' && dlgEscape) { closeDialog(); return; }
      if (ev.key !== 'Tab') return;
      var f = focusables(); if (!f.length) return;
      var i = f.indexOf(doc().activeElement);
      var n = ev.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === -1 || i === f.length - 1 ? 0 : i + 1);
      if (ev.preventDefault) ev.preventDefault();
      try { f[n].focus(); } catch (e) { /* focus */ }
    }
    function dialog() {
      var d = doc();
      if (!d || !d.body) return null;
      if (dlg && dlg.isConnected) return dlg;
      dlgOpener = d.activeElement && d.activeElement !== d.body ? d.activeElement : null;
      dlgEscape = true;
      // the same look as the sign-in dialog (#acct_dlg): its overlay and box classes and theme tokens (review fix)
      try { ensureCss(); } catch (e) { /* none */ }
      dlg = el('div', { id: 'acct_oauth_dlg', 'class': 'acct-ov acct-oauth-dlg rp-skip', 'data-rp-nosnap': '1', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'acct_oauth_title' });
      var box = el('div', { 'class': 'acct-dlg acct-oauth-box' });
      box.appendChild(el('h2', { id: 'acct_oauth_title', text: 'Sign in', style: 'font-size:18px;margin:0 0 12px 0' }));
      box.appendChild(el('div', { id: 'acct_oauth_body' }));
      dlg.appendChild(box);
      dlg.onkeydown = dlgKey;
      d.body.appendChild(dlg);
      return dlg;
    }
    function closeDialog() {
      if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg);
      dlg = null;
      var o = dlgOpener; dlgOpener = null;
      try { if (o && o.isConnected !== false && typeof o.focus === 'function') o.focus(); } catch (e) { /* focus return */ }
    }
    function dbody() { var d = dialog(); return d ? d.querySelector('#acct_oauth_body') : null; }
    // the heading names the step (never "Sign in" on the blocking public sign-out step)
    function title(t) { var d = dialog(); var h = d && d.querySelector('#acct_oauth_title'); if (h) h.textContent = t; }
    function para(cls, txt, extra) { return el('p', Object.assign({ 'class': cls, text: txt, style: 'margin:0 0 12px 0' }, extra || {})); }
    function btn(id, txt, primary, fn) {
      return el('button', { type: 'button', id: id, 'class': primary ? 'btn btn-primary' : 'btn btn-secondary', onclick: fn,
        style: 'min-height:44px;font-size:16px;margin:8px 8px 0 0', text: txt });
    }
    function show(nodes) {
      var b = dbody(); if (!b) return;
      b.textContent = ''; nodes.forEach(function (n) { if (n) b.appendChild(n); });
      var f = b.querySelector('input') || b.querySelector('.btn-primary') || b.querySelector('button');   // focus moves into the step
      try { if (f && typeof f.focus === 'function') f.focus(); } catch (e) { /* focus */ }
    }
    function showError(msg) {
      show([el('p', { 'class': 'acct-oauth-error', role: 'alert', text: msg }),
        el('p', { style: 'font-size:13px', text: "Can't use Google or LinkedIn? Use the e-mail code." }),
        btn('acct_oauth_close', 'Close', true, function () { closeDialog(); })]);
    }
    function restoreRoute(oa) {
      var r = oa && oa.route;
      try { if (typeof G.WTS_nav === 'function') G.WTS_nav(knownRoute(r) ? r : 'home'); } catch (e) { /* navigation */ }
    }
    function drive(p, body0, oa) {
      var keep = body0 && body0.code !== undefined ? dbody() && dbody().querySelector('.acct-oauth-msg') : null;
      show([el('p', { 'class': 'acct-oauth-busy', role: 'status', 'aria-live': 'polite', text: 'Finishing sign-in…' })]);
      return api.finishProviderSignIn(body0).then(function (j) { return step(p, j, oa); }, function (e) {
        if (e && e.code === 'invalid_or_expired' && keep) {
          // a wrong code: stay on the code step (5 tries per code)
          step(p, { next: 'code', reason: keep.getAttribute('data-reason'), emailMasked: keep.getAttribute('data-masked') }, oa);
          var m = dbody().querySelector('.acct-oauth-msg');
          dbody().insertBefore(el('p', { 'class': 'acct-oauth-error', role: 'alert', text: text('invalid_or_expired', p) }), m);
          return { error: e.code };
        }
        showError(text(e && e.code, p, e && e.body && e.body.reason));
        return { error: e && e.code };
      });
    }
    function step(p, j, oa) {
      var N = NAME[p] || '';
      if (j.next === 'done') {
        if (j.linked) {
          restoreRoute(oa);                                  // back to the page the link started from (the account page)
          show([el('p', { 'class': 'acct-oauth-linked', text: N + ' was added as a way to sign in.' }), btn('acct_oauth_close', 'Close', true, function () { closeDialog(); })]);
          return j;
        }
        restoreRoute(oa);
        if (j.providerEmailDiffers) {
          show([el('p', { 'class': 'acct-oauth-differs', text: 'Your ' + N + ' e-mail address is different from your account e-mail (' + ((j.user && j.user.emailMasked) || '') + '). Your account e-mail does not change by itself.' }),
            btn('acct_oauth_change', 'Change account e-mail', false, function () { closeDialog(); if (typeof api.changeEmail === 'function') api.changeEmail().catch(function () {}); }),
            btn('acct_oauth_keep', 'Keep my account e-mail', true, function () { closeDialog(); })]);
          return j;
        }
        closeDialog();
        return j;
      }
      if (j.next === 'email') {
        title('Confirm your e-mail address');
        var inp = el('input', { id: 'acct_oauth_email', type: 'email', inputmode: 'email', autocomplete: 'email', style: 'width:100%;box-sizing:border-box;font-size:16px;min-height:44px' });
        inp.value = j.emailPrefill || '';
        show([para('acct-oauth-msg', (j.reason === 'missing' ? N + ' did not share an e-mail address. ' : '') + 'Confirm the e-mail address for this account — we will send a code to it.'),
          el('label', { 'for': 'acct_oauth_email', text: 'E-mail address' }), inp,
          btn('acct_oauth_send', 'Send code', true, function () { drive(p, { email: String(inp.value || '').trim() }, oa); })]);
        return j;
      }
      if (j.next === 'code') {
        title(j.reason === 'link_confirm' ? 'Confirm adding ' + N : j.reason === 'cancel_deletion' ? 'Cancel the account deletion' : 'Confirm your e-mail address');
        var ci = el('input', { id: 'acct_oauth_code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '9', style: 'width:100%;box-sizing:border-box;font-size:16px;min-height:44px;letter-spacing:2px' });
        show([para('acct-oauth-msg', codeText(j.reason, j.emailMasked, p), { 'data-reason': j.reason || 'verify', 'data-masked': j.emailMasked || '' }),
          el('label', { 'for': 'acct_oauth_code', text: 'Code' }), ci,
          btn('acct_oauth_verify', 'Continue', true, function () {
            var reason = j.reason;
            drive(p, { code: String(ci.value || '').replace(/\s/g, '') }, oa).then(function (r) {
              if (reason === 'cancel_deletion' && r && r.next === 'done') offerCancelDeletion();
            });
          }),
          btn('acct_oauth_close', 'Close', false, function () { dropOauth(); closeDialog(); }),
          // no resend in this step (open item): the way to a new code is a new start with the provider
          el('p', { 'class': 'acct-oauth-help', style: 'font-size:13px', text: "Didn't get the code? It can take a minute — check your spam or junk folder. A code works for 15 minutes and 5 tries. For a new code, close this and choose " + (N || 'the provider') + ' again.' })]);
        return j;
      }
      if (j.next === 'consent') {
        // the versions come from the server; without them nothing is sent (never made-up versions)
        if (typeof j.terms !== 'string' || !j.terms || typeof j.privacy !== 'string' || !j.privacy) { showError(text('server', p)); return j; }
        var c = { terms: j.terms, privacy: j.privacy };
        title('Create your account');
        // the same explicit tick as the e-mail path, naming the versions (review fix): Create is refused until it is ticked
        var tick = el('input', { type: 'checkbox', id: 'acct_oauth_consent_ok' });
        var cerr = el('p', { 'class': 'acct-oauth-error', role: 'alert', style: 'margin:8px 0 0 0' });
        show([para('acct-oauth-consent', 'You are creating a new account for ' + j.newAccountEmailMasked + '. Already have an account with another address? Sign in with it, then add ' + N + ' under Account → Sign-in methods.'),
          el('label', { 'class': 'acct-tick', 'for': 'acct_oauth_consent_ok' }, [tick, el('span', { text: ' I accept the Terms of Use (version ' + j.terms + ') and have read the Privacy notice (version ' + j.privacy + ').' })]),
          cerr,
          btn('acct_oauth_create', 'Create account', true, function () {
            if (!tick.checked) { cerr.textContent = 'Please tick the box to accept the Terms of Use and the Privacy notice.'; return; }
            drive(p, { consent: c }, oa);
          }),
          btn('acct_oauth_cancel', 'Cancel', false, function () { dropOauth(); closeDialog(); })]);
        return j;
      }
      showError(text('server', p));
      return j;
    }
    function offerCancelDeletion() {
      title('Cancel the account deletion');
      show([el('p', { 'class': 'acct-oauth-undelete-msg', text: 'This account is being deleted. You can cancel the deletion now.' }),
        btn('acct_oauth_undelete', 'Cancel deletion', true, function () {
          call('POST', '/account/delete/cancel', {}).then(function () { closeDialog(); }, function (e) { showError(text(e && e.code)); });
        }),
        btn('acct_oauth_close', 'Close', false, function () { closeDialog(); })]);
    }
    function openFinish() { var oa = readHint().oauth || {}; dialog(); return drive(oa.provider, {}, oa); }
    api.oauthReturn = function () {
      if (L.hash !== '#acct-oauth') return null;
      if (!freshOauth(readHint())) return null;            // the fragment alone is ignored: no request
      try { if (G.history && G.history.replaceState) G.history.replaceState(null, '', (L.pathname || '/') + (L.search || '')); } catch (e) { /* history */ }
      return openFinish();
    };

    // The blocking step after a public sign-out of a provider session (§11.2): resolves on [I have signed out]; Escape does
    // not close it.
    function providerSignOutStep(p) {
      return new Promise(function (resolve) {
        if (!doc() || !doc().body) { resolve(false); return; }
        dialog();
        var N = NAME[p] || 'the provider';
        title('Sign out of ' + N);
        show([el('p', { 'class': 'acct-oauth-signout', text: 'Now sign out of ' + N + ' in this browser: open ' + N + ', choose your account picture or name, then Sign out. This computer is shared, so the next person must not find you signed in there.' }),
          btn('acct_oauth_signedout', 'I have signed out', true, function () { closeDialog(); resolve(true); })]);
        dlgEscape = false;                                   // Escape does not close it; Tab still stays inside
      });
    }

    // The Sign-in methods card of the account page (68 delegates here): e-mail (always), recovery, Google, LinkedIn, passkeys.
    function fmtDate(s) { try { return s ? new Date(s).toISOString().slice(0, 10) : '—'; } catch (e) { return '—'; } }
    function renderMethods(host) {
      if (!host || !doc()) return Promise.resolve(null);
      host.textContent = '';
      // filled into the account page's own "Sign-in methods" card (68): no second card, title or note (review fix)
      var card = el('div', { 'class': 'acct-methods', id: 'acct_methods' });
      host.appendChild(card);
      var list = el('div', { 'class': 'acct-methods-list' });
      card.appendChild(list);
      var msg = el('div', { 'class': 'acct-methods-msg', role: 'status', 'aria-live': 'polite', style: 'font-size:14px;margin-top:6px' });
      return Promise.all([api.methods(), api.providers().catch(function () { return { google: 'off', linkedin: 'off' }; })]).then(function (r) {
        var m = r[0] || {}; var st = r[1] || {};
        function row(title, detail, actions, p) {
          var d = el('div', { 'class': 'acct-method-row', 'data-method': p || title, style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border,#3a3a3a)' });
          d.appendChild(el('div', { style: 'flex:1 1 220px' }, [el('div', { 'class': 'acct-method-title', text: title, style: 'font-weight:600' }), el('div', { 'class': 'acct-method-detail', text: detail, style: 'font-size:14px' })]));
          var a = el('div', { 'class': 'acct-method-actions', style: 'flex:1 1 200px' });
          (actions || []).forEach(function (x) { if (x) a.appendChild(x); });
          d.appendChild(a);
          list.appendChild(d);
          return a;
        }
        row('E-mail code', ((m.email && m.email.masked) || '') + ' — always on', [typeof api.changeEmail === 'function' ? btn('acct_m_email', 'Change e-mail', false, function () { msg.textContent = 'Type the new address under "Change e-mail address" in Profile and security, then send the code.'; api.changeEmail().catch(function () {}); }) : null], 'email');
        row('Recovery address', m.recovery ? m.recovery.masked : 'Not set', [], 'recovery');
        PROVIDERS.forEach(function (p) {
          var i = (m.identities || []).filter(function (x) { return x.provider === p; })[0];
          if (i) {
            var a = row(NAME[p], (i.emailMasked || 'no e-mail shared') + ' · linked ' + fmtDate(i.linkedAt) + ' · last used ' + (i.lastUsedAt ? fmtDate(i.lastUsedAt) : 'never'), [
              btn('acct_m_unlink_' + p, 'Unlink', false, function () {
                msg.textContent = '';
                api.unlinkMethod(i.id).then(function (res) {
                  var n = res.sessionsRevoked;
                  return renderMethods(host).then(function () {
                    var c = host.querySelector('.acct-methods-msg');
                    if (c) c.textContent = NAME[p] + ' was removed. ' + n + ' session' + (n === 1 ? '' : 's') + ' it opened ' + (n === 1 ? 'was' : 'were') + ' signed out.';
                  });
                }, function (e) { msg.textContent = text(e && e.code, p); });
              })], p);
            a.appendChild(el('div', { style: 'font-size:13px', text: 'Unlinking signs out every session it opened.' }));
          } else if (st[p] === 'on') {
            row(NAME[p], 'Not linked', [providerButton(p, 'link', function () {
              msg.textContent = 'Taking you to ' + NAME[p] + '…';
              api.linkProvider(p).catch(function (e) { msg.textContent = text(e && e.code, p, e && e.body && e.body.reason); });
            })], p);
          }
        });
        (m.passkeys || []).forEach(function (k) { row('Passkey', k.name + ' · added ' + fmtDate(k.created), [], 'passkey'); });
        card.appendChild(el('p', { 'class': 'acct-methods-note', style: 'font-size:13px', text: 'Your e-mail address always works as a way in, even if you lose your Google or LinkedIn account.' }));
        card.appendChild(msg);
        return m;
      }, function (e) {
        card.appendChild(el('p', { 'class': 'acct-methods-error', text: text(e && e.code) }));
        return null;
      });
    }

    api.oauthUI = { renderButtons: renderButtons, renderMethods: renderMethods, openFinish: openFinish, providerSignOutStep: providerSignOutStep,
      label: label, ASSETS: ASSETS, text: text, FRESH_OK: FRESH_OK };
    // WP-C1 mount points
    hooks.renderProviders = function (host, states, ctx) { return renderButtons(host, { publicDevice: !!(ctx && ctx.publicDevice), states: states }); };
    hooks.onPublicSignOut = function (info) {
      var p = info && info.authMethod;
      return PROVIDERS.indexOf(p) !== -1 ? providerSignOutStep(p) : null;
    };
    // the provider return is handled at load (the fragment is stripped here, so the later mount does not see it again)
    if (L.hash === '#acct-oauth') api.oauthReturn();
  }
  boot();
})();
// ── ACCT:END ──

// ─── END 66-account ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 67-cloud-sync ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/67-cloud-sync.js — WTS_cloudSync: cloud projects (docs/ACCOUNTS-PLAN.md §5.2, §6, §7, §10). Round-10.
//
// Same guard as 66 (production https host or DEV localhost, no native shell, not framed); outside it WTS_cloudSync is not
// defined at all. Phase 1 (WP-C1): the device store 'wts-sync' (IndexedDB, memory fallback), the ownership record, the
// snapshot (§6.1: payload → per-well parts + a small core, canonical JSON, SHA-256 hash and the normalised vhash), assemble
// (the inverse: an ordinary .h2oilproj v1.0 payload that v3.4 opens), manual Save to cloud (inline core ≤ 48 kB gzip, missing
// blobs uploaded in 4 MB chunks, 422 path, the Phase 1 409 choice), Open from cloud (push first when changed, refused when
// offline and changed, safety snapshot, verified download with the size cap, load with source 'cloud'), list / history /
// restore / rename / duplicate / trash / purge / download, Import files to cloud, the account library (union), the §10
// migration and hand-over (empty / own / unowned / foreign / unknown, stash, pre-account snapshot, size cap), the
// public-computer wipe (expiry check at load, no timer) and the locked outbox (AES-GCM with the per-user server key, never
// stored). Automatic sync, the merge and conflict copies are Phase 2 (WP-C2): syncNow / conflicts / resolve / diff reject.
//
// Nothing runs at load except the public expiry check (it reads the hint; no request). No polling, no setInterval, no
// function wrapping; the change listeners are attached only while signed in and linked (66 calls _attach / _detach; bindTo,
// unlink and init re-check).
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var L = G.location || {};
  function nativeShell(g) {
    try {
      var c = g.Capacitor;
      if (c && typeof c.isNativePlatform === 'function') return !!c.isNativePlatform();
      return !!(c && c.isNative);
    } catch (e) { return true; }
  }
  var DEV = G.WTS_ACCOUNT_DEV === 1 && /^https?:$/.test(L.protocol || '')
    && /^(localhost|127\.0\.0\.1)$/.test(L.hostname || '');
  var ELIGIBLE = ((L.protocol === 'https:' && L.hostname === 'welltest.h2oil.co.uk') || DEV)
    && !nativeShell(G)
    && (function () { try { return G.top === G; } catch (e) { return false; } })();
  if (!ELIGIBLE) return;

  var VERSION = '1.0.0';
  var HAS_DOC = typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';
  var FMT = 2;                                     // commit / core format
  var OUTBOX_FMT = 1;
  var CHUNK = 4 * 1024 * 1024;
  var INLINE_MAX = 48 * 1024;
  var LIFT_MAX = 64000;                            // a key or module over 64 kB becomes a sub-part
  var BULK_MODULES = ['prism_gauges', 'buildup_raw', 'buildup_analysis'];
  var WELL_MODULES = ['wts', 'esdhi', 'esdlo', 'hydrate', 'liquidline', 'pipelife', 'clientinfo', 'pvt', 'prism_dataset', 'prism'];
  var JOB_KEYS = { wts_report_templates: 1, wts_base_conditions: 1, wts_base_auto: 1 };
  var DERIVED_KEYS = { wts_report_snapshots: 1, wts_mw_results: 1 };
  var LIBRARY_RE = /^wts_prism_(user_curves|presets|mapping_)/;
  var DEVICE_PREF_RE = /^(wts_unit_system|wts_prism_sample_suppress|wts_prism_migrated)$|^wts_ui_/;
  var JOB_PART = 'job';                            // well/job/<module>: project-level bulk modules (gauges, build-up)

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
  function A() { return G.WTS_account || null; }
  function I() { var a = A(); return a && a._i ? a._i : null; }
  function AErr(code, extra) {
    var E = A() && A().Error;
    var body = extra ? Object.assign({ error: code }, extra) : { error: code };
    if (E) return new E(code, 0, body);
    var e = new Error(code); e.code = code; e.body = body; return e;
  }
  function call(m, p, b, o) { return A().call(m, p, b, o); }
  function now() { var a = A(); var f = a && a.seam && a.seam('now'); return typeof f === 'function' ? f() : Date.now(); }
  function seam(k) { var a = A(); return a && a.seam ? a.seam(k) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function lsGet(k) { try { return G.localStorage ? G.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsRemove(k) {
    try { if (typeof G.WTS_lsRemove === 'function') { G.WTS_lsRemove(k); return; } } catch (e) { /* fall back */ }
    try { if (G.localStorage) G.localStorage.removeItem(k); } catch (e) { /* blocked */ }   /* ls-raw: fallback (no H1 host) */
  }
  function lsSet(k, v) {
    try { if (typeof G.WTS_lsSet === 'function') return G.WTS_lsSet(k, v) !== false; } catch (e) { /* fall back */ }
    try { G.localStorage.setItem(k, v); return true; } catch (e) { return false; }   /* ls-raw: fallback (no H1 host) */
  }
  function lsKeys() {
    var out = []; var ls = G.localStorage; if (!ls) return out;
    try { for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k != null) out.push(k); } } catch (e) { /* blocked */ }
    return out;
  }
  function uuid() {
    try { if (G.crypto && typeof G.crypto.randomUUID === 'function') return G.crypto.randomUUID(); } catch (e) { /* fall back */ }
    var b = randomBytes(16); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = hex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function randomBytes(n) {
    var a = new Uint8Array(n);
    try { G.crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); }
    return a;
  }
  function hex(a) { var s = ''; for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; }
  function u8(x) {
    if (x == null) return new Uint8Array(0);
    if (typeof x === 'string') return utf8(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (typeof x.byteLength === 'number') return new Uint8Array(x);
    return new Uint8Array(0);
  }
  function utf8(s) {
    if (typeof G.TextEncoder === 'function') return new G.TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s)); var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function fromUtf8(b) {
    b = u8(b);
    if (typeof G.TextDecoder === 'function') return new G.TextDecoder('utf-8').decode(b);
    var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return decodeURIComponent(escape(s));
  }
  function b64(b) {
    b = u8(b); var s = '';
    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.prototype.slice.call(b.subarray(i, i + 0x8000)));
    return G.btoa(s);
  }
  function unb64(s) { var bin = G.atob(String(s || '')); var a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function concat(list) {
    var n = 0; list.forEach(function (x) { n += x.length; });
    var out = new Uint8Array(n); var o = 0;
    list.forEach(function (x) { out.set(x, o); o += x.length; });
    return out;
  }

  // Canonical JSON (keys sorted by UTF-16 code units, no whitespace, JSON.stringify numbers and strings, undefined members
  // dropped, undefined array items → null, non-finite numbers refused) — identical to server/core/canon.js.
  function canonical(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'number') { if (!isFinite(v)) throw new Error('canon: non-finite number'); return JSON.stringify(v); }
    if (t === 'boolean' || t === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(function (x) { return x === undefined ? 'null' : canonical(x); }).join(',') + ']';
    if (t === 'object') {
      var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
      return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
    }
    throw new Error('canon: unsupported type ' + t);
  }
  // sha256Hex(text | bytes) → Promise<64 lowercase hex>. Crypto: the seam WTS_account.configure({crypto}) when set (an object
  // with .subtle, or a SubtleCrypto-like object with .digest), else window.crypto.subtle.
  function subtle() {
    var s = seam('crypto');
    if (s && s.subtle && typeof s.subtle.digest === 'function') return s.subtle;
    if (s && typeof s.digest === 'function') return s;
    return G.crypto && G.crypto.subtle;
  }
  function sha256Hex(data) {
    var c = subtle();
    if (!c) return Promise.reject(new Error('sha256: no crypto.subtle'));
    var bytes = typeof data === 'string' ? utf8(data) : u8(data);
    return Promise.resolve(c.digest('SHA-256', bytes)).then(function (buf) { return hex(new Uint8Array(buf)); });
  }
  function gzip(bytes) {
    var f = seam('gzip');
    if (typeof f === 'function') return Promise.resolve(f(u8(bytes))).then(u8);
    if (typeof G.CompressionStream === 'function' && typeof G.Response === 'function') {
      var s = new G.Response(u8(bytes)).body.pipeThrough(new G.CompressionStream('gzip'));
      return new G.Response(s).arrayBuffer().then(u8);
    }
    return Promise.reject(AErr('unsupported', { message: 'This browser cannot compress data for the cloud.' }));
  }
  function gunzip(bytes) {
    var f = seam('gunzip');
    if (typeof f === 'function') return Promise.resolve(f(u8(bytes))).then(u8);
    if (typeof G.DecompressionStream === 'function' && typeof G.Response === 'function') {
      var s = new G.Response(u8(bytes)).body.pipeThrough(new G.DecompressionStream('gzip'));
      return new G.Response(s).arrayBuffer().then(u8);
    }
    return Promise.reject(AErr('unsupported', { message: 'This browser cannot read cloud data.' }));
  }

  // ── device store 'wts-sync' (IndexedDB kv; memory fallback) ───────────────────────────────────────────────────────
  var mem = {}; var dbP = null; var useMem = false;
  function factory() { return seam('idb') || G.indexedDB || null; }
  function db() {
    if (useMem) return Promise.resolve(null);
    if (dbP) return dbP;
    var f = factory();
    if (!f || typeof f.open !== 'function') return Promise.resolve(null);   // no store (yet): memory for this call only
    dbP = new Promise(function (res) {
      var r;
      try { r = f.open('wts-sync', 1); } catch (e) { useMem = true; res(null); return; }
      r.onupgradeneeded = function () { try { var d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); } catch (e) { /* none */ } };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { useMem = true; res(null); };
    });
    return dbP;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      if (!d) return fn(null);
      return new Promise(function (res, rej) {
        var t; try { t = d.transaction('kv', mode); } catch (e) { useMem = true; res(fn(null)); return; }
        var os = t.objectStore('kv'); var out;
        var r = fn(os);
        t.oncomplete = function () { res(r && r.__req ? r.__req.result : out); };
        t.onerror = function () { rej(t.error || new Error('wts-sync write failed')); };
      });
    });
  }
  function kvGet(k) {
    return tx('readonly', function (os) {
      if (!os) return clone(mem[k]);
      var q = os.get(k); return { __req: q };
    }).then(function (v) { return v === undefined ? null : clone(v); });
  }
  function kvPut(k, v) {
    return tx('readwrite', function (os) { if (!os) { mem[k] = clone(v); return null; } os.put(clone(v), k); return null; }).then(function () { return v; });
  }
  function kvDel(k) { return tx('readwrite', function (os) { if (!os) { delete mem[k]; return null; } os['delete'](k); return null; }); }
  function kvClear() { return tx('readwrite', function (os) { if (!os) { mem = {}; return null; } os.clear(); return null; }); }

  // ── state ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  var S = { device: null, binding: null, base: null, busy: false, error: null, lastSyncAt: null, outbox: null, loaded: false,
    applying: false, snapshotting: false, outboxKey: null };
  var readyP = null;
  function init() {
    if (readyP) return readyP;
    if (!factory()) return Promise.resolve(false);    // no store yet (a test seam not configured): nothing is cached; try later
    // the load-time expiry wipe cleared localStorage while the page scripts were still loading; the project modules that keep
    // client data in IndexedDB (PRiSM gauge records, build-up raw data and tests) register only once the page is ready, so
    // New runs again here (init runs from the mount) before the sync store is cleared
    var first = S.pendingWipe ? Promise.resolve().then(function () { wipeLocalSync({ reason: 'expiry' }); })
      .then(function () { return wipeStores({ reason: 'expiry', historian: true }); }).then(function () { S.pendingWipe = false; }) : Promise.resolve();
    readyP = first.then(function () { return Promise.all([kvGet('device'), kvGet('binding'), kvGet('base'), kvGet('outbox')]); }).then(function (r) {
      S.device = r[0]; S.binding = r[1]; S.base = r[2]; S.outbox = r[3];
      if (!S.device) {
        S.device = { deviceId: null, lastUserId: null, workOwner: hasLocalWork() ? 'unowned' : null, workOwnerAt: now() };
        return kvPut('device', S.device);
      }
    }).then(function () {
      if (S.device && S.device.deviceId && A() && !A().seam('deviceId')) A().configure({ deviceId: S.device.deviceId });
      if (S.binding && S.binding.lastSyncAt) S.lastSyncAt = S.binding.lastSyncAt;
      S.loaded = true;
      attach();   // 66 may have asked before the binding was read: listen now if signed in and linked
      return true;
    }, function () { S.loaded = true; return true; });
    return readyP;
  }
  function saveDevice() { return kvPut('device', S.device); }
  function saveBinding() { return S.binding ? kvPut('binding', S.binding) : kvDel('binding'); }
  function signedInUser() { var a = A(); var s = a && a.state(); return s && s.status === 'signedIn' ? s.user : null; }
  function linkedFor(user) { return !!(S.binding && user && S.binding.userId === user.id && S.binding.projectId); }

  function status() {
    var a = A(); var s = a ? a.state() : { status: 'signedOut' };
    var b = S.binding;
    var out = { state: 'off', projectId: b ? b.projectId : null, name: b ? b.name : null, baseRev: b ? b.baseRev : null,
      lastSyncAt: S.lastSyncAt || (b && b.lastSyncAt) || null, pending: S.outbox ? 1 : 0, error: S.error ? S.error.code || String(S.error) : null };
    if (s.status !== 'signedIn') { out.state = b ? 'signedOut' : 'off'; if (s.status === 'unavailable' && b) out.state = s.reason === 'paused' ? 'paused' : 'unavailable'; return out; }
    if (!b || !s.user || b.userId !== s.user.id) { out.projectId = null; out.name = null; out.baseRev = null; out.state = 'off'; return out; }
    if (S.busy) out.state = 'syncing';
    else if (S.error && S.error.code === 'quota') out.state = 'quota';
    else if (S.error && S.error.code === 'paused') out.state = 'paused';
    else if (S.error && S.error.code === 'readonly') out.state = 'readonly';
    else if (S.error && S.error.code === 'network') out.state = 'offline';
    else if (S.error && S.error.code === 'server') out.state = 'unavailable';
    else out.state = b.dirty ? 'dirty' : 'idle';
    return out;
  }
  function changed() {
    var i = I(); if (i) { i.renderChip(); i.renderBar(); }
    var st = status();
    try { if (HAS_DOC && typeof G.CustomEvent === 'function') document.dispatchEvent(new G.CustomEvent('wts:sync-status', { detail: st })); } catch (e) { /* none */ }
  }
  // back online (66's 'online' listener): a network / outage error of the last action no longer stands
  function netBack() { if (S.error && (S.error.code === 'network' || S.error.code === 'server')) { S.error = null; changed(); } }
  function setBusy(v, err) { S.busy = v; if (err !== undefined) S.error = err; changed(); }
  // a change → dirty at once; then ONE snapshot compares with the last saved state, and a rewrite that changed nothing (the
  // same value written again, e.g. an autosave flush) turns the binding clean again (review fix). changeGen guards a real
  // edit that arrives while the check runs.
  var changeGen = 0;
  function markDirty() {
    if (S.applying || S.snapshotting || !S.binding) return;
    changeGen++;
    var u = signedInUser(); if (!u || S.binding.userId !== u.id) return;
    if (S.binding.dirty) return;
    S.binding.dirty = true; saveBinding(); changed();
    if (!S.base || !S.base.vhash) return;
    var gen = changeGen; var b = S.binding; var base = S.base.vhash;
    snapshot({}).then(function (snap) {
      if (gen !== changeGen || S.busy || S.binding !== b || !b.dirty || !S.base || S.base.vhash !== base || snap.vhash !== base) return;
      b.dirty = false; saveBinding(); changed();
    }, function () { /* stays dirty */ });
  }
  var EVENTS = ['wts:autosaved', 'wts:ls-write', 'wts:project-loaded', 'wts:project-new', 'wts:project-changed', 'prism:fit-updated',
    'prism:well-changed', 'prism:model-changed', 'wts:buildup-updated', 'wts:well-changed'];
  var attached = false;
  function onChange(ev) {
    var d = ev && ev.detail;
    if (ev && ev.type === 'wts:project-loaded' && d && (d.source === 'cloud' || d.origin === 'cloud')) return;   // echo guard
    if (ev && ev.type === 'wts:ls-write' && d) {
      var key = String(d.key || '');
      // account / device keys, the account library (synced on its own, not in the snapshot) and derived keys (report
      // snapshots, multi-well results: rebuilt on any click, outside vhash, §6.1 / §7) never dirty the project
      if (/^(wtsacct_|wtspref_)/.test(key) || LIBRARY_RE.test(key) || DEVICE_PREF_RE.test(key) || DERIVED_KEYS[key]) return;
    }
    markDirty();
  }
  // attach() — called by 66 on sign-in and here on bindTo / unlink: the listeners run only while signed in AND linked (§5.5)
  function attach() {
    if (!linkedFor(signedInUser())) { detach(); return; }
    if (attached || !HAS_DOC) return;
    attached = true;
    EVENTS.forEach(function (n) { document.addEventListener(n, onChange); });
  }
  function detach() {
    if (!attached || !HAS_DOC) return;
    attached = false;
    EVENTS.forEach(function (n) { document.removeEventListener(n, onChange); });
  }

  // ── local work ─────────────────────────────────────────────────────────────────────────────────────────────────────
  function P() { return G.WTS_project || null; }
  function isWorkKey(k) {
    if (!/^(wts_|h2oil_)/.test(k) || DEVICE_PREF_RE.test(k) || LIBRARY_RE.test(k) || DERIVED_KEYS[k]) return false;
    if (/consent|analytics|tracking|(^|_)ga(_|$)|subscri|entitle|purchase|^wts_acct_|^wts_sync_/i.test(k)) return false;
    if (k === 'h2oil_client_info') {
      try { var ci = JSON.parse(lsGet(k) || '{}'); return !!(ci && (ci.client || ci.well || ci.field || ci.operator)); } catch (e) { return false; }
    }
    return true;
  }
  // A fresh New / Start empty leaves a few default keys (PRiSM writes its empty state); their values are remembered in the
  // device record (emptyMark) so an emptied browser still counts as empty.
  function hasLocalWork() {
    var mark = (S.device && S.device.emptyMark) || {};
    return lsKeys().some(function (k) { return isWorkKey(k) && !(own(mark, k) && mark[k] === lsGet(k)); });
  }
  function emptyMark() { var m = {}; lsKeys().forEach(function (k) { if (isWorkKey(k)) m[k] = lsGet(k); }); return m; }
  function buildPayload() {
    var p = P(); if (!p || typeof p._buildPayload !== 'function') throw AErr('unavailable', { message: 'project layer missing' });
    var meta;
    try { var ci = JSON.parse(lsGet('h2oil_client_info') || '{}'); meta = {}; ['client', 'well', 'field', 'operator'].forEach(function (k) { if (ci && ci[k]) meta[k] = String(ci[k]); }); } catch (e) { meta = undefined; }
    return p._buildPayload(meta);
  }
  function flushPage() {
    var PA = G.WTS_pageAutosave;
    try { if (PA && typeof PA.flushIfDirty === 'function') PA.flushIfDirty(); else if (PA && typeof PA.flush === 'function') PA.flush(); } catch (e) { /* none */ }
  }
  function metaOf(payload, name) {
    var m = (payload && payload.meta) || {};
    return { name: String(name || m.well || m.client || 'Untitled project').slice(0, 200), client: String(m.client || ''), well: String(m.well || ''),
      field: String(m.field || ''), operator: String(m.operator || '') };
  }

  // ── snapshot (§6.1) ────────────────────────────────────────────────────────────────────────────────────────────────
  function partName(wellId, sub) {
    var s = String(sub).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'x';
    return 'well/' + wellId + '/' + s;
  }
  function isPh(v) { return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.$part === 'string' && typeof v.hash === 'string' && Object.keys(v).length === 2; }
  // splitPayload(payload, opts) — pure: payload → {core, parts:{name: value}, wells, meta, skipped}. Hashes are added by hashSplit.
  function splitPayload(payload, opts) {
    opts = opts || {};
    var mods = clone((payload && payload.modules) || {});
    var skipped = [];
    delete mods.units;                                            // the unit system is a device preference
    if (mods.wts && typeof mods.wts === 'object' && own(mods.wts, 'system')) delete mods.wts.system;
    var storage = (mods.storage && mods.storage.keys) || {};
    if (mods.storage && Array.isArray(mods.storage.skipped)) mods.storage.skipped.forEach(function (x) { skipped.push(x && x.key ? x.key : String(x)); });
    var keys = {};
    Object.keys(storage).forEach(function (k) {
      if (LIBRARY_RE.test(k)) return;                             // library document only (D13)
      if (k === 'wts_modbus_config' && !opts.liveCfg) { skipped.push(k); return; }
      if (DEVICE_PREF_RE.test(k) || /^wts_acct_|^wts_sync_/.test(k)) return;
      keys[k] = storage[k];
    });
    var wm = mods.wells && Array.isArray(mods.wells.wells) && mods.wells.wells.length ? mods.wells : null;
    var meta = (payload && payload.meta) || {};
    var activeId = wm ? String(wm.active || wm.wells[0].id) : 'w1';
    var list = wm ? wm.wells.map(function (w) { return { id: String(w.id), name: String(w.name || w.id), created: w.created || null }; })
      : [{ id: 'w1', name: String(meta.well || 'Well 1'), created: null }];
    var job = {}; var wellKeys = {};
    Object.keys(keys).forEach(function (k) { if (JOB_KEYS[k]) job[k] = keys[k]; else wellKeys[k] = keys[k]; });
    var parts = {};
    function wellPart(id, blob) {
      var w = { v: 1, keys: {}, modules: {} };
      var src = blob || {};
      Object.keys(src.keys || {}).forEach(function (k) {
        var v = src.keys[k];
        if (LIBRARY_RE.test(k) || (k === 'wts_modbus_config' && !opts.liveCfg)) return;
        if (typeof v === 'string' && v.length > LIFT_MAX) { var n = partName(id, k); parts[n] = v; w.keys[k] = { $part: n, hash: '' }; }
        else w.keys[k] = v;
      });
      Object.keys(src.modules || {}).forEach(function (m) {
        var v = src.modules[m];
        if (canonical(v).length > LIFT_MAX) { var n = partName(id, m); parts[n] = v; w.modules[m] = { $part: n, hash: '' }; }
        else w.modules[m] = v;
      });
      if (src.modified) w.modified = src.modified;
      parts['well/' + id] = w;
    }
    var core = { fmt: FMT, format: 'h2oilproj', version: '1.0', generator: payload && payload.generator || 'H2Oil Well Testing Suite',
      savedAt: payload && payload.savedAt || new Date(now()).toISOString(), meta: clone(meta), wells: list, job: job, modules: {}, wellParts: {}, skipped: [] };
    var activeMods = {};
    Object.keys(mods).forEach(function (m) {
      if (m === 'storage' || m === 'wells' || m === 'units') return;
      if (WELL_MODULES.indexOf(m) !== -1) { activeMods[m] = mods[m]; return; }
      if (opts.keepBulk && BULK_MODULES.indexOf(m) !== -1) { core.skipped.push(m); return; }
      if (BULK_MODULES.indexOf(m) !== -1 || canonical(mods[m]).length > LIFT_MAX) { var n = partName(JOB_PART, m); parts[n] = mods[m]; core.modules[m] = { $part: n, hash: '' }; }
      else core.modules[m] = mods[m];
    });
    list.forEach(function (w) {
      if (w.id === activeId) wellPart(w.id, { keys: wellKeys, modules: activeMods });
      else { var e = wm.wells.filter(function (x) { return String(x.id) === w.id; })[0]; wellPart(w.id, e && e.data && typeof e.data === 'object' ? e.data : { keys: {}, modules: {} }); }
      core.wellParts[w.id] = { $part: 'well/' + w.id, hash: '' };
    });
    core.activeAtSave = activeId;
    skipped.forEach(function (k) { if (core.skipped.indexOf(k) === -1) core.skipped.push(k); });
    return { core: core, parts: parts, wells: list, meta: meta, activeId: activeId };
  }
  // the normalised view (§6.1 step 8): no savedAt / generator / modified, no wts_page_*.t, no wts_prism_state.savedAt, no
  // derived keys; placeholders compare by the part's vhash.
  function viewOf(v, vh) {
    if (Array.isArray(v)) return v.map(function (x) { return viewOf(x, vh); });
    if (v && typeof v === 'object') {
      if (isPh(v)) return { $v: vh[v.$part] || v.hash };
      var o = {};
      Object.keys(v).forEach(function (k) {
        if (k === 'savedAt' || k === 'generator' || k === 'modified') return;
        if (k === 'keys' && v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) {
          var ko = {};
          Object.keys(v[k]).forEach(function (kk) {
            if (DERIVED_KEYS[kk]) return;
            var raw = v[k][kk];
            if (typeof raw === 'string' && (/^wts_page_/.test(kk) || kk === 'wts_prism_state')) {
              try { var j = JSON.parse(raw); if (j && typeof j === 'object') { delete j.t; delete j.savedAt; ko[kk] = viewOf(j, vh); return; } } catch (e) { /* raw */ }
            }
            ko[kk] = viewOf(raw, vh);
          });
          o[k] = ko; return;
        }
        if (k === 'job' && v[k] && typeof v[k] === 'object') { o[k] = viewOf(v[k], vh); return; }
        o[k] = viewOf(v[k], vh);
      });
      return o;
    }
    return v;
  }
  // hashSplit(split) → Promise<snap {core, coreText, hash, vhash, parts:[{name, hash, vhash, bytes, text}], byName}>
  function hashSplit(sp) {
    var names = Object.keys(sp.parts);
    var subs = names.filter(function (n) { return n.split('/').length === 3; });
    var tops = names.filter(function (n) { return n.split('/').length === 2; });
    var out = { parts: [], byName: {} }; var vh = {}; var hh = {};
    function fill(v) {
      if (Array.isArray(v)) return v.map(fill);
      if (v && typeof v === 'object') {
        if (typeof v.$part === 'string' && Object.keys(v).length === 2 && own(v, 'hash')) return { $part: v.$part, hash: hh[v.$part] };
        var o = {}; Object.keys(v).forEach(function (k) { o[k] = fill(v[k]); }); return o;
      }
      return v;
    }
    function one(n) {
      var val = fill(sp.parts[n]); sp.parts[n] = val;
      var text = canonical(val);
      return Promise.all([sha256Hex(text), sha256Hex(canonical(viewOf(val, vh)))]).then(function (r) {
        hh[n] = r[0]; vh[n] = r[1];
        var e = { name: n, hash: r[0], vhash: r[1], bytes: utf8(text).length, text: text };
        out.parts.push(e); out.byName[n] = e;
      });
    }
    return subs.reduce(function (p, n) { return p.then(function () { return one(n); }); }, Promise.resolve())
      .then(function () { return tops.reduce(function (p, n) { return p.then(function () { return one(n); }); }, Promise.resolve()); })
      .then(function () {
        var core = fill(sp.core); out.core = core;
        out.coreText = canonical(core);
        return Promise.all([sha256Hex(out.coreText), sha256Hex(canonical(viewOf(core, vh)))]);
      }).then(function (r) {
        out.hash = r[0]; out.vhash = r[1]; out.coreBytes = utf8(out.coreText).length;
        out.parts.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
        out.wells = sp.wells; out.meta = sp.meta; out.activeId = sp.activeId;
        return out;
      });
  }
  // snapshot(opts) → Promise<{core, vhash, parts, …}> of the live working set (§6.1)
  function snapshot(opts) {
    opts = opts || {};
    S.snapshotting = true;
    var pl;
    try { flushPage(); pl = opts.payload || buildPayload(); } catch (e) { S.snapshotting = false; return Promise.reject(e); }
    var a = A(); var st = a && a.state();
    S.snapshotting = false;
    return hashSplit(splitPayload(pl, { liveCfg: !!(st && st.opts && st.opts.liveCfg), keepBulk: !!opts.keepBulk })).then(function (snap) {
      snap.payload = pl;
      return snap;
    });
  }
  // assemble(core, parts) → an ordinary .h2oilproj v1.0 payload (v3.4 opens it). parts: {name: value}. The active well is this
  // device's binding.activeWell when it is in the list, else the well active at save, else the first.
  function assemble(core, parts, opts) {
    opts = opts || {};
    function fillV(v) {
      if (Array.isArray(v)) return v.map(fillV);
      if (v && typeof v === 'object') {
        if (isPh(v)) { if (!own(parts, v.$part)) throw AErr('corrupt', { message: 'missing part ' + v.$part }); return clone(parts[v.$part]); }
        var o = {}; Object.keys(v).forEach(function (k) { o[k] = fillV(v[k]); }); return o;
      }
      return v;
    }
    var list = core.wells || [];
    var ids = list.map(function (w) { return w.id; });
    var act = opts.activeWell && ids.indexOf(opts.activeWell) !== -1 ? opts.activeWell : (ids.indexOf(core.activeAtSave) !== -1 ? core.activeAtSave : ids[0]);
    var modules = {};
    Object.keys(core.modules || {}).forEach(function (m) { modules[m] = fillV(core.modules[m]); });
    var wellOf = function (id) { var ph = core.wellParts[id]; return fillV(ph && isPh(ph) ? ph : { $part: 'well/' + id, hash: '' }); };
    var activePart = wellOf(act) || { keys: {}, modules: {} };
    var keys = {};
    Object.keys(core.job || {}).forEach(function (k) { keys[k] = core.job[k]; });
    Object.keys(activePart.keys || {}).forEach(function (k) { keys[k] = activePart.keys[k]; });
    Object.keys(activePart.modules || {}).forEach(function (m) { modules[m] = activePart.modules[m]; });
    modules.storage = { keys: keys, skipped: [] };
    if (list.length > 1) {
      modules.wells = { v: 1, active: act, wells: list.map(function (w) {
        var d = null;
        if (w.id !== act) { var p = wellOf(w.id); d = { v: 1, savedAt: core.savedAt, keys: p.keys || {}, modules: p.modules || {} }; }
        return { id: w.id, name: w.name, created: w.created || null, modified: null, data: d };
      }) };
    }
    return { format: 'h2oilproj', version: '1.0', generator: core.generator || 'H2Oil Well Testing Suite', savedAt: core.savedAt, meta: clone(core.meta || {}), modules: modules };
  }

  // ── transfer ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function blobFor(snap, hash) {
    if (hash === snap.hash) return snap.coreText;
    for (var i = 0; i < snap.parts.length; i++) if (snap.parts[i].hash === hash) return snap.parts[i].text;
    return null;
  }
  function uploadBlob(text, hash) {
    return gzip(utf8(text)).then(function (gz) {
      return sha256Hex(gz).then(function (zsha) {
        var n = Math.max(1, Math.ceil(gz.length / CHUNK));
        var seq = Promise.resolve();
        for (var i = 0; i < n; i++) (function (i) {
          seq = seq.then(function () {
            var ch = gz.subarray(i * CHUNK, Math.min(gz.length, (i + 1) * CHUNK));
            return sha256Hex(ch).then(function (csha) {
              return call('PUT', '/blobs/' + hash + '/' + i + '?of=' + n, ch, { raw: true, headers: { 'X-WTS-Zsha': zsha, 'X-WTS-Chunk-Sha': csha } });
            });
          });
        })(i);
        return seq.then(function () { return gz.length; });
      });
    });
  }
  function uploadMissing(snap, hashes) {
    var batches = []; for (var i = 0; i < hashes.length; i += 200) batches.push(hashes.slice(i, i + 200));
    var missing = [];
    return batches.reduce(function (p, b) {
      return p.then(function () { return call('POST', '/blobs/has', { hashes: b }).then(function (r) { missing = missing.concat((r.json && r.json.missing) || []); }); });
    }, Promise.resolve()).then(function () { return uploadList(snap, missing); });
  }
  function uploadList(snap, list) {
    return list.reduce(function (p, h) {
      return p.then(function () { var t = blobFor(snap, h); if (t == null) throw AErr('corrupt', { message: 'unknown blob ' + h }); return uploadBlob(t, h); });
    }, Promise.resolve()).then(function () { return list.length; });
  }
  function downloadBlob(hash, bytes) {
    return call('GET', '/blobs/' + hash + '/0', null, { bytes: true }).then(function (r) {
      var of = Number((r.headers && r.headers.get && r.headers.get('x-wts-of')) || 1) || 1;
      var zsha = (r.headers && r.headers.get && r.headers.get('x-wts-zsha')) || null;
      var chunks = [u8(r.bytes)];
      var seq = Promise.resolve();
      for (var i = 1; i < of; i++) (function (i) {
        seq = seq.then(function () { return call('GET', '/blobs/' + hash + '/' + i, null, { bytes: true }).then(function (x) { chunks[i] = u8(x.bytes); }); });
      })(i);
      return seq.then(function () {
        var gz = concat(chunks);
        return (zsha ? sha256Hex(gz) : Promise.resolve(null)).then(function (z) {
          if (zsha && z !== zsha) throw AErr('corrupt', { message: 'compressed copy does not match' });
          return gunzip(gz);
        });
      });
    }).then(function (raw) { return checkText(raw, hash, bytes); });
  }
  function checkText(raw, hash, bytes) {
    if (typeof bytes === 'number' && bytes >= 0 && raw.length > Math.ceil(bytes * 1.01) + 64) throw AErr('corrupt', { message: 'part larger than declared' });
    var text = fromUtf8(raw);
    return sha256Hex(text).then(function (h) {
      if (h !== hash) throw AErr('corrupt', { message: 'part hash does not match' });
      return JSON.parse(text);
    });
  }
  // fetchHead(projectId, rev?) → {head, core, parts:{name: value}}: every SHA-256 verified, the size cap applied, shapes checked
  function fetchRevision(projectId, rev) {
    var path = rev == null ? '/projects/' + projectId + '/head' : '/projects/' + projectId + '/rev/' + rev;
    return call('GET', path).then(function (r) {
      var head = r.json;
      if (!head || !head.coreHash) throw AErr('empty', { message: 'This cloud project has no saved version yet.' });
      var coreP = head.coreInline ? gunzip(unb64(head.coreInline)).then(function (raw) { return checkText(raw, head.coreHash, null); }) : downloadBlob(head.coreHash, null);
      var parts = {};
      return coreP.then(function (core) {
        checkCoreShape(core);
        return (head.parts || []).reduce(function (p, pt) {
          return p.then(function () { return downloadBlob(pt.hash, pt.bytes).then(function (v) { parts[pt.name] = v; }); });
        }, Promise.resolve()).then(function () { return { head: head, core: core, parts: parts }; });
      });
    });
  }
  function checkCoreShape(core) {
    var ok = core && typeof core === 'object' && Array.isArray(core.wells) && core.wellParts && typeof core.wellParts === 'object' &&
      (core.job == null || typeof core.job === 'object') && (core.modules == null || typeof core.modules === 'object');
    if (ok) (core.wells || []).forEach(function (w) { if (!w || typeof w.id !== 'string' || !/^w[0-9]{1,6}$/.test(w.id)) ok = false; });
    if (ok && core.job) Object.keys(core.job).forEach(function (k) { if (typeof core.job[k] !== 'string') ok = false; });
    if (!ok) throw AErr('corrupt', { message: 'unexpected project shape' });
  }

  // ── commits ────────────────────────────────────────────────────────────────────────────────────────────────────────
  function commitBody(snap, baseRev, reason, pushId, name, gz) {
    var core = { hash: snap.hash, vhash: snap.vhash, zsha: gz.zsha, bytes: snap.coreBytes };
    if (gz.bytes.length <= INLINE_MAX) core.inline = b64(gz.bytes);
    return { pushId: pushId, baseRev: baseRev, reason: reason, core: core,
      parts: snap.parts.map(function (p) { return { name: p.name, hash: p.hash, bytes: p.bytes }; }),
      meta: metaOf(snap.payload || { meta: snap.meta }, name), wells: (snap.wells || []).map(function (w) { return { id: w.id, name: w.name }; }),
      fmt: FMT, appVer: (I() && typeof I().appVer === 'function') ? String(I().appVer() || '') : String((A() && A().seam('appVer')) || '') };
  }
  function encryptOutbox(obj) {
    var c = subtle(); var k = S.outboxKey;
    if (!c || !k) return Promise.resolve(null);
    var iv = randomBytes(12);
    return c.importKey('raw', unb64(k), { name: 'AES-GCM' }, false, ['encrypt']).then(function (key) {
      return c.encrypt({ name: 'AES-GCM', iv: iv }, key, utf8(JSON.stringify(obj)));
    }).then(function (ct) { return { enc: 'A256GCM', iv: b64(iv), ct: b64(new Uint8Array(ct)) }; });
  }
  function decryptOutbox(rec, k) {
    var c = subtle();
    return c.importKey('raw', unb64(k), { name: 'AES-GCM' }, false, ['decrypt']).then(function (key) {
      return c.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct));
    }).then(function (pt) { return JSON.parse(fromUtf8(new Uint8Array(pt))); });
  }
  function isPublic() { var a = A(); var s = a && a.state(); return !!(s && s.publicDevice); }
  function putOutbox(entry) {
    var rec = { fmt: OUTBOX_FMT, pushId: entry.pushId, userId: entry.userId, projectId: entry.projectId, at: now() };
    S.outbox = rec;
    if (isPublic()) {
      // on a public device the waiting entry is never stored in plain text: encrypted with the server outbox key, or not at all
      return encryptOutbox(entry).then(function (enc) { if (enc) { rec.entry = enc; return kvPut('outbox', rec); } return null; });
    }
    rec.entry = { plain: entry };
    return kvPut('outbox', rec);
  }
  function clearOutbox() { S.outbox = null; return kvDel('outbox'); }
  // pushSnap(projectId, snap, baseRev, reason, name) → {rev, savedAt} | {stale, head}
  function pushSnap(projectId, snap, baseRev, reason, name, pushId) {
    var u = signedInUser();
    pushId = pushId || uuid();
    return gzip(utf8(snap.coreText)).then(function (gzb) {
      return sha256Hex(gzb).then(function (zsha) { return { bytes: gzb, zsha: zsha }; });
    }).then(function (gz) {
      var bodyC = commitBody(snap, baseRev, reason, pushId, name, gz);
      var lim = seam('maxProjectBytes') || 64e6;
      var total = snap.parts.reduce(function (n, p) { return n + p.bytes; }, snap.coreBytes);
      if (total > lim * 8) throw AErr('too_large', { limit: lim });
      var hashes = snap.parts.map(function (p) { return p.hash; }).filter(function (h, i, a) { return a.indexOf(h) === i; });
      if (!bodyC.core.inline) hashes.unshift(snap.hash);
      return putOutbox({ pushId: pushId, userId: u ? u.id : null, projectId: projectId, baseRev: baseRev, reason: reason }).then(function () {
        return uploadMissing(snap, hashes);
      }).then(function () {
        var tries = 0;
        function commit() {
          tries++;
          return call('POST', '/projects/' + projectId + '/commit', bodyC).then(function (r) { return clearOutbox().then(function () { return r.json; }); }, function (e) {
            if (e && e.code === 'missing_blobs' && tries < 2) return uploadList(snap, (e.body && e.body.missing) || []).then(commit);
            if (e && e.code === 'stale') return clearOutbox().then(function () { return { stale: true, head: e.body && e.body.head, headRev: e.body && e.body.headRev }; });
            throw e;
          });
        }
        return commit();
      });
    });
  }
  function bindTo(user, projectId, name, rev, snap) {
    S.binding = { userId: user.id, projectId: projectId, baseRev: rev, name: name, boundAt: now(), activeWell: snap ? snap.activeId : null,
      dirty: false, lastSyncAt: now() };
    S.base = snap ? { vhash: snap.vhash, coreHash: snap.hash, parts: snap.parts.reduce(function (o, p) { o[p.name] = p.hash; return o; }, {}) } : null;
    S.lastSyncAt = now();
    S.device.workOwner = user.id; S.device.workOwnerAt = now();
    attach();
    return Promise.all([saveBinding(), S.base ? kvPut('base', S.base) : kvDel('base'), saveDevice()]);
  }
  function requireUser() {
    var u = signedInUser();
    if (!u) return Promise.reject(AErr('signed_out'));
    return init().then(function () { return u; });
  }
  function fail(e) {
    var code = e && e.code;
    S.error = (code === 'quota' || code === 'paused' || code === 'readonly' || code === 'network' || code === 'server') ? e : null;
    S.busy = false; changed();
    var i = I(); if (i) return i.handleError(e);
    return Promise.reject(e);
  }

  // saveToCloud({as, name, reason}) → Promise<{rev, projectId, unchanged?, cancelled?}>
  function saveToCloud(o) {
    o = o || {};
    return requireUser().then(function (u) {
      if (S.busy) return Promise.reject(AErr('busy', { message: 'A cloud save is already running.' }));
      setBusy(true, null);
      return snapshot({ keepBulk: !!o.keepBulk }).then(function (snap) {
        var linked = linkedFor(u) && !o.as;
        var reason = o.reason || 'save';
        var name = o.name || (linked ? S.binding.name : metaOf(snap.payload).name);
        if (linked && S.base && S.base.vhash === snap.vhash && reason === 'save') {
          S.binding.dirty = false; saveBinding(); setBusy(false, null);
          return { rev: S.binding.baseRev, projectId: S.binding.projectId, unchanged: true };
        }
        // a first save whose upload failed after the project was created left an empty project (no revision): the next
        // first save reuses it instead of creating another (review fix; S.device.pendingCreate, cleared once bound)
        var pend = !linked && S.device && S.device.pendingCreate && S.device.pendingCreate.userId === u.id ? S.device.pendingCreate : null;
        var create = linked ? Promise.resolve({ id: S.binding.projectId, rev: S.binding.baseRev })
          : pend ? (pend.name === name ? Promise.resolve() : call('POST', '/projects/' + encodeURIComponent(pend.id) + '/rename', { name: name }).then(function () { pend.name = name; }))
            .then(function () { return { id: pend.id, rev: 0, pending: true }; })
          : call('POST', '/projects', { name: name, meta: (function (m) { delete m.name; return m; })(metaOf(snap.payload, name)) }).then(function (r) {
            if (!S.device) S.device = {};
            S.device.pendingCreate = { userId: u.id, id: r.json.id, name: name };
            return Promise.resolve(saveDevice()).then(function () { return { id: r.json.id, rev: r.json.headRev }; });
          });
        var clearPending = function (id) {
          if (!S.device || !S.device.pendingCreate || S.device.pendingCreate.id !== id) return Promise.resolve();
          delete S.device.pendingCreate; return Promise.resolve(saveDevice());
        };
        return create.then(function (pr) {
          return pushSnap(pr.id, snap, pr.rev, reason, name).then(function (res) {
            if (!res.stale) return clearPending(pr.id).then(function () { return bindTo(u, pr.id, name, res.rev, snap); }).then(function () { setBusy(false, null); libraryPush(); return { rev: res.rev, projectId: pr.id }; });
            setBusy(false, null);
            return staleChoice(u, pr.id, snap, res, name);
          });
        });
      }).then(null, function (e) {
        // §3.2: the linked project was trashed or purged on another device — unlink and offer a new cloud project
        var code = e && e.code;
        if ((code === 'not_found' || code === 'gone') && linkedFor(u) && !o.as) return goneChoice(u, e);
        // the remembered empty project is gone (trashed or purged elsewhere): forget it, so the next save creates a new one
        if ((code === 'not_found' || code === 'gone') && S.device && S.device.pendingCreate && !linkedFor(u)) { delete S.device.pendingCreate; saveDevice(); }
        return fail(e);
      });
    });
  }
  function goneChoice(u, e) {
    var oldName = S.binding ? S.binding.name : null;
    S.busy = false; S.error = null;
    return unlink().then(function () {
      var i = I();
      var ch = i ? i.choose({ title: 'Cloud project not available', text: 'That cloud project is no longer available (it was moved to the trash or deleted on another device). This device is no longer linked to it.',
        buttons: [{ id: 'saveas', label: 'Save as a new cloud project', primary: true }, { id: 'cancel', label: 'Cancel' }] }) : Promise.resolve('cancel');
      return ch.then(function (c) {
        if (c === 'saveas') return saveToCloud({ as: true, name: oldName || undefined });
        return { cancelled: true, unlinked: true, error: e && e.code };
      });
    });
  }
  // Phase 1 409 (§6.6): Overwrite (the replaced revision stays in history) / Save as a new project / Cancel
  function staleChoice(u, projectId, snap, res, name) {
    var i = I();
    var h = res.head || {};
    var when = h.savedAt ? new Date(h.savedAt) : null;
    var text = 'The cloud copy changed' + (h.device ? ' on another device' : '') + (when ? ' at ' + when.toISOString().slice(11, 16) + ' UTC' : '') + '.';
    var ch = i ? i.choose({ title: 'Newer version in the cloud', text: text, buttons: [
      { id: 'overwrite', label: 'Overwrite cloud with this version', primary: true }, { id: 'new', label: 'Save as a new project' }, { id: 'cancel', label: 'Cancel' }] })
      : Promise.resolve('cancel');
    return ch.then(function (c) {
      if (c === 'overwrite') {
        setBusy(true, null);
        return pushSnap(projectId, snap, res.headRev != null ? res.headRev : h.rev, 'overwrite', name).then(function (r2) {
          if (r2.stale) { setBusy(false, null); return staleChoice(u, projectId, snap, r2, name); }
          return bindTo(u, projectId, name, r2.rev, snap).then(function () { setBusy(false, null); return { rev: r2.rev, projectId: projectId, overwritten: true }; });
        });
      }
      if (c === 'new') return saveToCloud({ as: true, name: name + ' (copy)' });
      S.binding && (S.binding.dirty = true); saveBinding(); changed();
      return { cancelled: true };
    });
  }

  // openFromCloud(projectId, {rev}) — push first when this device's linked project changed (offline: refused), safety
  // snapshot, verified download, load with source 'cloud' (H3), re-baseline.
  function openFromCloud(projectId, o) {
    o = o || {};
    return requireUser().then(function (u) {
      var pre = Promise.resolve();
      if (linkedFor(u) && S.binding.dirty && S.binding.projectId === projectId) {
        // §6.8 never discard silently: the same project with unsaved changes → ask (default Cancel); a safety copy is kept
        var ci = I();
        var ask = ci ? ci.choose({ title: 'Open from cloud', text: 'This device has changes that are not saved to the cloud. Discard the changes on this device and load the cloud version? (A safety copy is kept on this device.)',
          buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'discard', label: 'Discard and load the cloud version' }] }) : Promise.resolve('cancel');
        pre = ask.then(function (c) { if (c !== 'discard') throw AErr('cancelled'); });
      } else if (linkedFor(u) && S.binding.dirty) {
        var i = I();
        if (i && !i.isOnline()) return Promise.reject(AErr('offline_dirty'));
        pre = saveToCloud({}).then(function (r) { if (r && r.cancelled) throw AErr('cancelled'); }, function (e) {
          if (e && e.code === 'network') throw AErr('offline_dirty');
          throw e;
        });
      }
      return pre.then(function () {
        setBusy(true, null);
        return fetchRevision(projectId, o.rev);
      }).then(function (got) {
        return safety().then(function () { return got; });
      }).then(function (got) {
        var payload = assemble(got.core, got.parts, { activeWell: S.binding && S.binding.projectId === projectId ? S.binding.activeWell : null });
        return apply(payload).then(function () {
          return call('GET', '/projects').then(function (r) {
            var it = (r.json || []).filter(function (x) { return x.id === projectId; })[0];
            return it ? it.name : null;
          }, function () { return null; });
        }).then(function (nm) {
          return snapshot().then(function (snap) {
            return bindTo(u, projectId, nm || metaOf(payload).name, got.head.rev, snap);
          });
        }).then(function () { libraryPull(); setBusy(false, null); return { rev: got.head.rev, projectId: projectId }; });
      }).then(null, fail);
    });
  }
  function apply(payload) {
    var p = P(); if (!p) return Promise.reject(AErr('unavailable'));
    S.applying = true;
    var res;
    try { res = p.loadFromObject(payload, { source: 'cloud' }); } catch (e) { S.applying = false; return Promise.reject(e); }
    if (res && res.error) { S.applying = false; return Promise.reject(AErr('corrupt', { message: res.error })); }
    return Promise.resolve(res && res.ready).then(function () { S.applying = false; return res; }, function (e) { S.applying = false; throw e; });
  }
  function safety() {
    var pl;
    try { flushPage(); pl = buildPayload(); } catch (e) { return Promise.resolve(); }
    return kvGet('safety').then(function (list) {
      list = Array.isArray(list) ? list : [];
      list.unshift({ at: now(), payload: pl, projectId: S.binding ? S.binding.projectId : null, name: (S.binding && S.binding.name) || metaOf(pl).name || null });
      return kvPut('safety', list.slice(0, 2));
    });
  }
  // restoreSafety(n) — load safety copy n (the current work becomes the newest safety copy). A copy taken from the project this
  // device is still linked to keeps the link and is marked "Not saved to cloud"; any other copy unlinks.
  function restoreSafety(n) {
    return init().then(function () { return kvGet('safety'); }).then(function (list) {
      list = Array.isArray(list) ? list : [];
      var item = list[n]; if (!item || !item.payload) return false;
      var cur = null;
      try { flushPage(); cur = buildPayload(); } catch (e) { cur = null; }
      var rest = list.filter(function (x, k) { return k !== n; });
      if (cur) rest.unshift({ at: now(), payload: cur, projectId: S.binding ? S.binding.projectId : null, name: (S.binding && S.binding.name) || metaOf(cur).name || null });
      return kvPut('safety', rest.slice(0, 2)).then(function () { return apply(item.payload); }).then(function () {
        if (S.binding && item.projectId && item.projectId === S.binding.projectId) { S.binding.dirty = true; return saveBinding().then(function () { changed(); return true; }); }
        return unlink().then(function () { return true; });
      });
    });
  }

  // ── project list and actions ───────────────────────────────────────────────────────────────────────────────────────
  function listProjects(o) {
    o = o || {};
    return requireUser().then(function () { return call('GET', '/projects' + (o.trash ? '?trash=1' : '?trash=0')); }).then(function (r) { return r.json || []; }, fail);
  }
  function history(id) { return requireUser().then(function () { return call('GET', '/projects/' + id + '/revs?limit=50'); }).then(function (r) { return r.json || []; }, fail); }
  function restoreRevision(id, rev) {
    return requireUser().then(function () { return call('POST', '/projects/' + id + '/restore-rev', { rev: rev, pushId: uuid() }); }).then(function (r) {
      if (S.binding && S.binding.projectId === id) { S.binding.dirty = true; saveBinding(); changed(); }
      return r.json;
    }, fail);
  }
  function rename(id, name) {
    return requireUser().then(function () { return call('POST', '/projects/' + id + '/rename', { name: String(name) }); }).then(function () {
      if (S.binding && S.binding.projectId === id) { S.binding.name = String(name); saveBinding(); changed(); }
      return true;
    }, fail);
  }
  function duplicate(id, name) { return requireUser().then(function () { return call('POST', '/projects/' + id + '/duplicate', { name: String(name) }); }).then(function (r) { return r.json; }, fail); }
  function trash(id) {
    return requireUser().then(function () { return call('POST', '/projects/' + id + '/trash', {}); }).then(function () {
      if (S.binding && S.binding.projectId === id) return unlink().then(function () { return true; });
      return true;
    }, fail);
  }
  function restore(id) { return requireUser().then(function () { return call('POST', '/projects/' + id + '/restore', {}); }).then(function () { return true; }, fail); }
  function purge(id) {
    var a = A();
    return requireUser().then(function () {
      return a.withStepUp(function () { return call('POST', '/projects/' + id + '/purge', {}); }, 'Deleting a project for ever needs a fresh confirmation.');
    }).then(function () { return true; }, fail);
  }
  function link(id) { return openFromCloud(id); }
  function unlink() {
    S.binding = null; S.base = null;
    detach();
    return Promise.all([kvDel('binding'), kvDel('base')]).then(function () { changed(); return true; });
  }
  function fileName(name) {
    var s = String(name || 'project').replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 80);
    return (s || 'project') + '.h2oilproj';
  }
  function downloadText(name, text) {
    if (!HAS_DOC) return false;
    var blob = new G.Blob([text], { type: 'application/json' });
    var url = null;
    try { url = G.URL && G.URL.createObjectURL ? G.URL.createObjectURL(blob) : null; } catch (e) { url = null; }
    var a = document.createElement('a');
    a.href = url || ('data:application/json;charset=utf-8,' + encodeURIComponent(text));
    a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    try { document.body.removeChild(a); } catch (e) { /* gone */ }
    return true;
  }
  // projectFile(id, rev?) → {name, text}: the assembled .h2oilproj of a cloud project
  function projectFile(id, rev, name) {
    return fetchRevision(id, rev).then(function (got) {
      var pl = assemble(got.core, got.parts, {});
      return { name: fileName(name || (pl.meta && (pl.meta.well || pl.meta.client)) || 'project'), text: JSON.stringify(pl, null, 2), payload: pl };
    });
  }
  function download(id, name) {
    return requireUser().then(function () { return projectFile(id, null, name); }).then(function (f) { downloadText(f.name, f.text); return f.name; }, fail);
  }

  // importFiles(files) — each .h2oilproj → its own cloud project (reason 'import'); nothing local changes (§6.8)
  function readFile(f) {
    if (f && typeof f.text === 'function') return Promise.resolve(f.text());
    if (f && typeof f._text === 'string') return Promise.resolve(f._text);
    return new Promise(function (res, rej) {
      try { var fr = new G.FileReader(); fr.onload = function () { res(String(fr.result || '')); }; fr.onerror = function () { rej(new Error('read failed')); }; fr.readAsText(f); }
      catch (e) { rej(e); }
    });
  }
  function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    return requireUser().then(function () {
      var results = [];
      return files.reduce(function (p, f) {
        return p.then(function () {
          var nm = String((f && f.name) || 'project').replace(/\.h2oilproj$/i, '').slice(0, 200) || 'project';
          return readFile(f).then(function (text) {
            var pl = JSON.parse(text);
            if (!pl || pl.format !== 'h2oilproj' || !pl.modules) throw AErr('bad_file', { message: 'not a project file' });
            return hashSplit(splitPayload(pl, {})).then(function (snap) {
              snap.payload = pl;
              var meta = metaOf(pl, nm); delete meta.name;
              return call('POST', '/projects', { name: nm, meta: meta }).then(function (r) {
                return pushSnap(r.json.id, snap, 0, 'import', nm).then(function () { results.push({ name: nm, ok: true, id: r.json.id }); });
              });
            });
          }).then(null, function (e) { results.push({ name: nm, ok: false, error: (e && e.code) || 'bad_file' }); });
        });
      }, Promise.resolve()).then(function () { return results; });
    });
  }
  function pickAndImport() {
    if (!HAS_DOC) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true; inp.accept = '.h2oilproj,application/json'; inp.style.display = 'none'; inp.id = 'acct_import_input';
      inp.addEventListener('change', function () {
        var fl = inp.files; try { inp.parentNode.removeChild(inp); } catch (e) { /* gone */ }
        if (!fl || !fl.length) { resolve(null); return; }
        importFiles(fl).then(function (res) {
          var i = I();
          if (i) i.choose({ title: 'Import files to cloud', text: res.filter(function (x) { return x.ok; }).length + ' of ' + res.length + ' files imported as cloud projects.',
            list: res.map(function (x) { return x.name + (x.ok ? ' — imported' : ' — not imported (' + x.error + ')'); }), buttons: [{ id: 'ok', label: 'OK', primary: true }] });
          resolve(res);
        }, function (e) { resolve(Promise.reject(e)); });
      });
      document.body.appendChild(inp);
      inp.click();
    });
  }
  // openPicker(): a list of the account's cloud projects in the dialog → openFromCloud
  function openPicker() {
    var i = I();
    return listProjects({}).then(function (list) {
      if (!list.length) return i.choose({ title: 'Open from cloud', text: 'You have no cloud projects yet. Use Save to cloud first.', buttons: [{ id: 'ok', label: 'OK', primary: true }] }).then(function () { return null; });
      var btns = list.slice(0, 20).map(function (p, k) { return { id: 'p' + k, label: p.name + (p.meta && p.meta.client ? ' — ' + p.meta.client : '') + (p.savedAt ? ' (' + String(p.savedAt).slice(0, 10) + ')' : ''), primary: k === 0 }; });
      btns.push({ id: 'cancel', label: 'Cancel' });
      return i.choose({ title: 'Open from cloud', text: 'Choose a project. Your current work is kept in a safety copy on this device.', buttons: btns }).then(function (c) {
        if (!c || c === 'cancel') return null;
        var p = list[Number(c.slice(1))];
        return p ? openFromCloud(p.id) : null;
      });
    });
  }

  // ── account library (D13; Phase 1: union on save / open, local wins) ─────────────────────────────────────────────────
  function localLibrary() { var o = {}; lsKeys().forEach(function (k) { if (LIBRARY_RE.test(k)) { var v = lsGet(k); if (v != null) o[k] = v; } }); return o; }
  function libraryPull() { return librarySync(false); }
  function libraryPush() { return librarySync(true); }
  function librarySync(push) {
    var local = localLibrary();
    return call('GET', '/library').then(function (r) {
      var head = r.json || { rev: 0, hash: null };
      var bodyP = head.rev > 0 ? call('GET', '/library/body', null, { bytes: true }).then(function (x) { return gunzip(u8(x.bytes)).then(function (raw) { return JSON.parse(fromUtf8(raw)); }); }) : Promise.resolve({});
      return bodyP.then(function (remote) {
        remote = remote && typeof remote === 'object' ? remote : {};
        Object.keys(remote).forEach(function (k) { if (LIBRARY_RE.test(k) && !own(local, k) && typeof remote[k] === 'string') lsSet(k, remote[k]); });
        if (!push) return null;
        var union = Object.assign({}, remote, local);
        var text = canonical(union);
        return sha256Hex(text).then(function (h) {
          if (h === head.hash || !Object.keys(union).length) return null;
          return gzip(utf8(text)).then(function (gz) {
            return call('POST', '/library/commit', { pushId: uuid(), baseRev: head.rev, hash: h, body: b64(gz) });
          });
        });
      });
    }).then(null, function () { return null; });   // the library never blocks a project save or open
  }

  // ── §10 migration and hand-over ────────────────────────────────────────────────────────────────────────────────────
  function preview(snap) {
    var pages = 0, prism = false, buildup = 0, wells = (snap.wells || []).length;
    snap.parts.forEach(function (p) {
      try {
        var v = JSON.parse(p.text);
        if (v && v.keys) Object.keys(v.keys).forEach(function (k) { if (/^wts_page_/.test(k)) pages++; if (k === 'wts_prism_state' || k === 'wts_prism') prism = true; });
      } catch (e) { /* sub-part */ }
      if (/\/buildup_analysis$/.test(p.name)) { try { var t = JSON.parse(p.text); buildup = Array.isArray(t) ? t.length : (t && t.tests ? Object.keys(t.tests).length : 1); } catch (e) { buildup = 1; } }
    });
    var bytes = snap.parts.reduce(function (n, p) { return n + p.bytes; }, snap.coreBytes);
    var large = snap.parts.filter(function (p) { return p.bytes > LIFT_MAX; }).map(function (p) { return { name: p.name, bytes: p.bytes }; });
    return { name: metaOf(snap.payload).name, client: (snap.meta && snap.meta.client) || '', wells: wells,
      wellNames: (snap.wells || []).map(function (w) { return w.name; }), pages: pages, prism: prism, buildup: buildup, bytes: bytes, large: large };
  }
  function mb(n) {
    n = Number(n) || 0;
    var t = n >= 1e6 ? String(Math.round(n / 1e5) / 10) + ' MB' : Math.max(1, Math.round(n / 1000)) + ' kB';
    var dc = false; try { dc = !!(G.WTS_a11y && G.WTS_a11y.decimalComma && G.WTS_a11y.decimalComma()); } catch (e) { /* none */ }
    return dc ? t.replace('.', ',') : t;      // 250 MB, 1.5 MB (1,5 MB with the decimal-comma setting)
  }
  function classify(user, migrated) {
    var d = S.device || {};
    if (!hasLocalWork()) return 'empty';
    if (d.workOwner === user.id) return 'own';
    // work this user already put into the account from this device (§10.2 migratedFor) and nobody else claimed since
    if ((!d.workOwner || d.workOwner === 'unowned') && Array.isArray(migrated) && migrated.indexOf(user.id) !== -1 && (!d.lastUserId || d.lastUserId === user.id)) return 'own';
    if (d.workOwner && d.workOwner !== 'unowned') return 'foreign';
    // 'unowned' (or never recorded): a personal device's pre-account work, unless another user signed in here before
    if (d.lastUserId && d.lastUserId !== user.id) return 'unknown';
    return 'unowned';
  }
  function pinPreAccount(payload) {
    return kvGet('preAccount').then(function (p) { if (p) return p; return kvPut('preAccount', { at: now(), payload: payload, pinned: true }); });
  }
  // afterSignIn(user) — called by 66 after every successful sign-in (any method): public outbox key, the locked outbox of this
  // user, then the §10 classification and its questions. Resolves {kind, choice}.
  function afterSignIn(user, info) {
    var i = I();
    return init().then(function () {
      var pub = isPublic();
      var keyP = pub ? call('GET', '/me/outbox-key').then(function (r) { S.outboxKey = r.json && r.json.k; }, function () { S.outboxKey = null; }) : Promise.resolve();
      return keyP.then(function () { return unlockOutbox(user); }).then(function () { return restoreStash(user); }).then(function () {
        if (linkedFor(user)) return { kind: 'linked', choice: null };
        return kvGet('migratedFor').then(function (mf) { return handover(user, classify(user, mf)); });
      }).then(function (res) {
        S.device.lastUserId = user.id;
        return saveDevice().then(function () { changed(); return res; });
      });
    }).then(null, function (e) { if (i) i.message(i.cloudErrText(e), 'err'); return { kind: 'error', error: e && e.code }; });
  }
  function handover(user, kind) {
    var i = I();
    if (!i) return Promise.resolve({ kind: kind, choice: null });
    if (kind === 'empty') {
      return listProjects({}).then(function (list) {
        S.device.workOwner = user.id; S.device.workOwnerAt = now();
        if (!list.length) return { kind: kind, choice: null };
        var latest = list.slice().sort(function (a, b) { return String(b.savedAt || '').localeCompare(String(a.savedAt || '')); })[0];
        return i.choose({ title: 'Open your latest cloud project?', text: 'This browser holds no project. Open "' + latest.name + '", saved ' + String(latest.savedAt || '').slice(0, 10) + '?',
          buttons: [{ id: 'open', label: 'Open it', primary: true }, { id: 'later', label: 'Not now' }] }).then(function (c) {
          if (c === 'open') return openFromCloud(latest.id).then(function () { return { kind: kind, choice: 'open' }; });
          return { kind: kind, choice: 'later' };
        });
      }, function () { return { kind: kind, choice: null }; });
    }
    if (kind === 'own' || kind === 'unowned') return ownFlow(user, kind);
    return foreignFlow(user, kind);
  }
  function ownFlow(user, kind) {
    var i = I();
    return Promise.all([snapshot(), listProjects({})]).then(function (r) {
      var snap = r[0], list = r[1];
      var pv = preview(snap);
      var lim = seam('maxProjectBytes') || 64e6;
      var over = pv.bytes > lim;
      var lines = ['Project: ' + pv.name + (pv.client ? ' (' + pv.client + ')' : ''), 'Wells: ' + pv.wells + ' — ' + pv.wellNames.join(', '),
        'Pages with inputs: ' + pv.pages, 'PRiSM analysis: ' + (pv.prism ? 'yes' : 'no'), 'Build-up tests: ' + pv.buildup, 'Size: ' + mb(pv.bytes)];
      if (over) lines.push('Over the ' + mb(lim) + ' cloud limit. Largest parts: ' + pv.large.slice(0, 4).map(function (x) { return x.name.split('/').pop() + ' ' + mb(x.bytes); }).join(', '));
      var btns = over ? [{ id: 'upload_lite', label: 'Upload without gauges and build-up raw data', primary: true }] : [{ id: 'upload', label: 'Upload as a new cloud project', primary: true }];
      if (list.length) btns.push({ id: 'open', label: 'Open a cloud project instead' });
      btns.push({ id: 'later', label: 'Not now' });
      return i.choose({ title: list.length ? 'Your work on this device' : 'Put the work on this device into your account?',
        text: list.length ? 'Upload the work on this device as a new cloud project, or open one of your cloud projects instead (this work is uploaded first).' : 'Your account is empty. Upload the work on this device as your first cloud project?',
        list: lines, buttons: btns }).then(function (c) {
        if (c === 'upload' || c === 'upload_lite') {
          return pinPreAccount(snap.payload).then(function () { return saveToCloud({ as: true, name: pv.name, reason: 'migrate', keepBulk: c === 'upload_lite' }); })
            .then(function (res) { return markMigrated(user).then(function () { return { kind: kind, choice: c, rev: res && res.rev, preview: pv }; }); });
        }
        if (c === 'open') {
          return pinPreAccount(snap.payload).then(function () {
            return saveToCloud({ as: true, name: pv.name, reason: 'migrate', keepBulk: over }).then(null, function () { return null; });
          }).then(function () { return markMigrated(user); }).then(function () { return openPicker(); }).then(function () { return { kind: kind, choice: 'open', preview: pv }; });
        }
        if (kind === 'unowned') { S.device.workOwner = user.id; S.device.workOwnerAt = now(); }
        return { kind: kind, choice: 'later', preview: pv };
      });
    });
  }
  function markMigrated(user) {
    return kvGet('migratedFor').then(function (l) { l = Array.isArray(l) ? l : []; if (l.indexOf(user.id) === -1) l.push(user.id); return kvPut('migratedFor', l); });
  }
  function foreignFlow(user, kind) {
    var i = I();
    function ask() {
      return i.choose({ title: 'This browser holds work from another account', text: 'This browser holds work from another account. It is never uploaded into your account unless you confirm it below.',
        buttons: [{ id: 'empty', label: 'Start empty (keep it local)', primary: true }, { id: 'signout', label: 'Sign out' }, { id: 'more', label: 'More…' }] });
    }
    return ask().then(function (c) {
      if (c === 'empty' || c === null) return startEmpty(user).then(function () { return { kind: kind, choice: 'empty' }; });
      if (c === 'signout') return A().signOut({ keep: true }).then(function () { return { kind: kind, choice: 'signout' }; });
      return snapshot().then(function (snap) {
        var pv = preview(snap);
        var who = (user && user.emailMasked) || 'your';
        return i.choose({ title: 'Upload another account\'s work?', text: 'Upload \'' + (pv.client ? pv.client + ' — ' : '') + pv.wellNames.join(', ') + '\' into ' + who + '\'s account?',
          buttons: [{ id: 'upload', label: 'Upload into my account', primary: false }, { id: 'cancel', label: 'Cancel', primary: true }] }).then(function (c2) {
          if (c2 !== 'upload') return startEmpty(user).then(function () { return { kind: kind, choice: 'empty' }; });
          return saveToCloud({ as: true, name: pv.name, reason: 'migrate' }).then(function (r) { return { kind: kind, choice: 'upload', rev: r && r.rev }; });
        });
      });
    });
  }
  // Start empty: the working set goes into stash[owner] (restored when that user signs in again), an empty project starts.
  function startEmpty(user) {
    var owner = (S.device && S.device.workOwner && S.device.workOwner !== 'unowned') ? S.device.workOwner : ('unknown:' + (S.device && S.device.lastUserId || 'none'));
    var pl; try { flushPage(); pl = buildPayload(); } catch (e) { pl = null; }
    return kvGet('stash').then(function (st) {
      st = st && typeof st === 'object' ? st : {};
      if (pl) st[owner] = { at: now(), payload: pl };
      return kvPut('stash', st);
    }).then(function () {
      S.applying = true;
      try { var p = P(); if (p && typeof p['new'] === 'function') p['new'](); } catch (e) { /* none */ }
      S.applying = false;
      S.binding = null; S.base = null;
      S.device.workOwner = user.id; S.device.workOwnerAt = now();
      S.device.emptyMark = emptyMark();
      return Promise.all([kvDel('binding'), kvDel('base'), saveDevice()]);
    });
  }
  function restoreStash(user) {
    return kvGet('stash').then(function (st) {
      if (!st || !st[user.id] || hasLocalWork()) return null;
      var pl = st[user.id].payload;
      delete st[user.id];
      return apply(pl).then(function () {
        S.device.workOwner = user.id; S.device.workOwnerAt = now();
        return Promise.all([kvPut('stash', st), saveDevice()]);
      });
    });
  }
  // 66 calls this when the page is signed out (sign-out or a 401): remember the last user (lastUserId), so work found at the
  // next sign-in by another user is classified 'unknown' (§10.1). The edited-after-sign-out mark is not kept in Phase 1:
  // work owned by another user is 'foreign' whether or not it was edited, and the owner's own work is 'own'.
  function noteSignedOut(user) {
    return init().then(function () {
      if (user && user.id) S.device.lastUserId = user.id;
      S.outboxKey = null;
      detach();
      return saveDevice();
    });
  }
  function setDevice(id) {
    return init().then(function () { if (!S.device) S.device = {}; S.device.deviceId = id; return saveDevice(); });
  }

  // ── public computer: the guarded wipe and the locked outbox (§10.8) ─────────────────────────────────────────────────
  function publicSignOutGuard(user) {
    var i = I();
    return init().then(function () {
      var st = status();
      // blocked while a change waits or the local work is not the synced cloud version (unlinked work counts)
      if (!S.outbox && (st.state === 'idle' || !hasLocalWork())) return 'proceed';
      function ask() {
        return i.choose({ title: 'Changes are waiting', text: 'This project has changes that are not in the cloud yet. This shared computer keeps nothing of your work after you sign out.',
          buttons: [{ id: 'upload', label: 'Try to upload now', primary: true }, { id: 'download', label: 'Download .h2oilproj' },
            { id: 'lock', label: 'Keep the waiting changes locked for 7 days' }, { id: 'cancel', label: 'Cancel sign-out' }] });
      }
      function loop(n) {
        return ask().then(function (c) {
          if (c === 'upload') return saveToCloud({}).then(function (r) { return r && !r.cancelled ? 'proceed' : loop(n + 1); }, function () { return n < 2 ? loop(n + 1) : 'cancel'; });
          if (c === 'download') { var p = P(); try { if (p && p.saveDownload) p.saveDownload(); } catch (e) { /* none */ } return 'proceed'; }
          if (c === 'lock') return lockOutbox(user).then(function () { return 'proceed'; }, function () { return loop(n + 1); });
          return 'cancel';
        });
      }
      return loop(0);
    });
  }
  // lockOutbox(user): the waiting work, encrypted with the per-user server outbox key (fetched now if not in memory, never
  // stored), kept for 7 days; only the same user can unlock and push it after signing in again.
  function lockOutbox(user) {
    var keyP = S.outboxKey ? Promise.resolve(S.outboxKey) : call('GET', '/me/outbox-key').then(function (r) { S.outboxKey = r.json && r.json.k; return S.outboxKey; });
    return keyP.then(function (k) {
      if (!k) throw AErr('no_key');
      var pl; flushPage(); pl = buildPayload();
      var b = S.binding;
      return encryptOutbox({ payload: pl, projectId: b ? b.projectId : null, baseRev: b ? b.baseRev : null, name: b ? b.name : metaOf(pl).name }).then(function (enc) {
        return kvPut('lockedOutbox', { fmt: OUTBOX_FMT, userId: user.id, until: now() + 7 * 864e5, iv: enc.iv, ct: enc.ct, enc: enc.enc });
      });
    });
  }
  function unlockOutbox(user) {
    return kvGet('lockedOutbox').then(function (rec) {
      if (!rec) return null;
      if (rec.until < now()) return kvDel('lockedOutbox');
      if (rec.userId !== user.id) return null;
      return call('GET', '/me/outbox-key').then(function (r) { return decryptOutbox(rec, r.json.k); }).then(function (o) {
        return hashSplit(splitPayload(o.payload, {})).then(function (snap) {
          snap.payload = o.payload;
          var push = o.projectId ? pushSnap(o.projectId, snap, o.baseRev || 0, 'save', o.name) : Promise.resolve({ stale: true });
          return push.then(function (res) {
            if (!res.stale) return res;
            var nm = String(o.name || 'Project') + ' (waiting changes)';
            var meta = metaOf(o.payload, nm); delete meta.name;
            return call('POST', '/projects', { name: nm, meta: meta }).then(function (c) { return pushSnap(c.json.id, snap, 0, 'save', nm); });
          });
        });
      }).then(function () { return kvDel('lockedOutbox'); }, function () { return null; });
    });
  }
  // wipeDevice({reason, historian, keepLocked}) — the working set, wts-sync (except a locked outbox), report snapshots, the
  // hint and (ticked) the historian; keeps only non-identifying preferences (wtspref_*, the unit system, wts_ui_*).
  function wipeLocalSync(o) {
    S.applying = true;
    try { var p = P(); if (p && typeof p['new'] === 'function') p['new'](); } catch (e) { /* host */ }
    lsKeys().forEach(function (k) {
      if (k === 'wtsacct_hint') { lsRemove(k); return; }
      if (!/^(wts_|h2oil_)/.test(k)) return;
      if (DEVICE_PREF_RE.test(k)) return;
      if (o.reason === 'signout' && o.keepLocked && LIBRARY_RE.test(k)) return;   // a trusted device keeps its own library
      lsRemove(k);
    });
    S.applying = false;
  }
  function wipeDevice(o) {
    o = o || {};
    wipeLocalSync(o);
    return wipeStores(o);
  }
  function wipeStores(o) {
    var hist = o.historian && G.WTS_historian && typeof G.WTS_historian.purge === 'function' ? Promise.resolve().then(function () { return G.WTS_historian.purge({ all: true }); }).then(null, function () { return null; }) : Promise.resolve();
    var trustedRemove = o.reason === 'signout' && o.keepLocked;
    return Promise.all([kvGet('lockedOutbox'), kvGet('device'), trustedRemove ? kvGet('preAccount') : null, trustedRemove ? kvGet('stash') : null]).then(function (r) {
      var locked = r[0], dev = r[1];
      return kvClear().then(function () {
        var keep = [];
        if (locked) keep.push(kvPut('lockedOutbox', locked));
        if (trustedRemove) { if (dev) keep.push(kvPut('device', dev)); if (r[2]) keep.push(kvPut('preAccount', r[2])); if (r[3]) keep.push(kvPut('stash', r[3])); }
        return Promise.all(keep);
      }).then(function () {
        S.binding = null; S.base = null; S.outbox = null; S.outboxKey = null; S.error = null; S.lastSyncAt = null;
        S.device = trustedRemove && dev ? dev : { deviceId: null, lastUserId: null, workOwner: null, workOwnerAt: now() };
        S.device.emptyMark = emptyMark();
        if (!trustedRemove) { var a = A(); if (a) a.configure({ deviceId: null }); }
        return saveDevice();
      });
    }).then(function () { changed(); return true; });   // the historian purge runs on; it never holds the wipe or init()
  }
  // At load (no timer): a public session past its absolute expiry, or idle for 12 h since the last activity, is wiped before
  // anything is shown (§5.5, §10.8). Reads only the hint.
  function publicExpiryAtLoad() {
    var h; try { h = JSON.parse(lsGet('wtsacct_hint') || 'null'); } catch (e) { h = null; }
    if (!h || !h.public) return false;
    var t = now(); var abs = h.absExpires ? Date.parse(h.absExpires) : NaN;
    var idle = typeof h.lastSeenAt === 'number' ? h.lastSeenAt + 12 * 3600e3 : NaN;
    if ((isFinite(abs) && t > abs) || (isFinite(idle) && t > idle)) { wipeLocalSync({ reason: 'expiry' }); S.pendingWipe = true; return true; }
    return false;
  }

  // ── the project guard (H14) ────────────────────────────────────────────────────────────────────────────────────────
  var guardOff = null;
  function guard(ctx) {
    var u = signedInUser(); var i = I();
    if (!u || !i) return 'proceed';
    var action = ctx && ctx.action;
    if (action === 'new') {
      return i.choose({ title: 'New project', text: 'Start a new cloud project, or a local-only one? The cloud project you are linked to is not changed.',
        buttons: [{ id: 'cloud', label: 'New cloud project', primary: true }, { id: 'local', label: 'Local only' }, { id: 'cancel', label: 'Cancel' }] }).then(function (c) {
        if (c !== 'cloud' && c !== 'local') return 'cancel';
        return { decision: 'proceed', after: followUp(function () { return unlink().then(function () { if (c === 'cloud') return saveToCloud({ as: true, name: 'New project' }); }); }) };
      });
    }
    if (action === 'open' || action === 'open-file') {
      var linked = linkedFor(u);
      var pre = lsGet('wtspref_cloud_open') === '1' ? Promise.resolve('new') : i.choose({ title: 'Open a project file', text: 'How should this file be kept?',
        html: '<label class="acct-tick"><input type="checkbox" id="acct_open_dontask"> Don\'t ask again (always open as a new cloud project)</label>',
        buttons: [{ id: 'new', label: 'Open as a new cloud project', primary: true }, { id: 'local', label: 'Local only' }]
          .concat(linked ? [{ id: 'replace', label: 'Replace the linked project\'s contents' }] : []).concat([{ id: 'cancel', label: 'Cancel' }]), keepOpen: true }).then(function (c) {
        var t = HAS_DOC && document.getElementById('acct_open_dontask');
        if (t && t.checked && c === 'new') lsSetPref('wtspref_cloud_open', '1');
        i.closeDialog(false);
        return c;
      });
      return pre.then(function (c) {
        if (c !== 'new' && c !== 'local' && c !== 'replace') return 'cancel';
        return { decision: 'proceed', after: followUp(function (res) {
          if (c === 'local') return unlink();
          if (c === 'replace') { if (S.binding) { S.binding.dirty = true; } return saveToCloud({}); }
          var f = P() && P().currentFile && P().currentFile();
          var name = (res && res.filename) || (f && f.name) || '';
          return unlink().then(function () { return saveToCloud({ as: true, name: name ? String(name).replace(/\.h2oilproj$/i, '') : undefined }); });
        }) };
      });
    }
    return 'proceed';
  }
  function lsSetPref(k, v) { try { G.localStorage.setItem(k, v); } catch (e) { /* blocked */ } }   /* ls-raw: wtspref_ device preference */
  // the follow-up of a guarded New / Open: 29 calls it with that action's own result, and only when it succeeded (a corrupt
  // or empty file arms nothing that a later, unrelated open could fire)
  function followUp(fn) {
    return function (res) {
      Promise.resolve(res).then(fn).then(null, function (e) { var i = I(); if (i) i.toast(i.cloudErrText(e), 'err'); });
    };
  }
  function mount() {
    init();
    var p = P();
    if (!guardOff && p && typeof p.registerGuard === 'function') guardOff = p.registerGuard(guard);
  }

  // ── export (§8.5): the account JSON plus every project as .h2oilproj ──────────────────────────────────────────────────
  // exportAll({accountOnly}) — accountOnly: the account JSON only (POST /account/export, no project bodies fetched), as used
  // by the account page's activity list.
  function exportAll(o) {
    o = o || {};
    var a = A();
    return requireUser().then(function () {
      return a.withStepUp(function () { return call('POST', '/account/export', {}); }, 'Exporting everything needs a fresh confirmation.');
    }).then(function (r) {
      var acc = r.json;
      var files = [{ name: 'account.json', text: JSON.stringify(acc, null, 2) }];
      if (o.accountOnly) return { account: acc, files: files };
      var used = {};
      return (acc.projects || []).reduce(function (p, pr) {
        return p.then(function () {
          if (!pr.headRev) return null;
          return projectFile(pr.id, null, pr.name).then(function (f) {
            var n = f.name; var k = 2; while (used[n]) n = f.name.replace(/\.h2oilproj$/, '') + ' (' + (k++) + ').h2oilproj';
            used[n] = 1; files.push({ name: 'projects/' + n, text: f.text });
          });
        });
      }, Promise.resolve()).then(function () { return { account: acc, files: files }; });
    });
  }

  function notYet(name) {
    return function () { return Promise.reject(AErr('not_implemented', { message: name + ' is Phase 2 / 3' })); };
  }
  var api = {
    VERSION: VERSION, status: status, canonical: canonical, sha256Hex: sha256Hex,
    link: link, unlink: unlink, saveToCloud: saveToCloud, openFromCloud: openFromCloud, importFiles: importFiles,
    listProjects: listProjects, history: history, restoreRevision: restoreRevision, rename: rename, duplicate: duplicate,
    trash: trash, restore: restore, purge: purge, download: download, projectFile: projectFile, snapshot: snapshot, assemble: assemble,
    migrateLocal: function (choice) { var u = signedInUser(); if (!u) return Promise.reject(AErr('signed_out')); return init().then(function () { return kvGet('migratedFor'); }).then(function (mf) { return handover(u, classify(u, mf)); }); },
    wipeDevice: wipeDevice, exportAll: exportAll, openPicker: openPicker, pickAndImport: pickAndImport,
    afterSignIn: afterSignIn, publicSignOutGuard: publicSignOutGuard, lockOutbox: lockOutbox,
    syncNow: notYet('syncNow'), conflicts: function () { return Promise.resolve([]); }, resolve: notYet('resolve'), diff: notYet('diff'),
    historianBackup: notYet('historianBackup'), historianRestore: notYet('historianRestore'),
    // device-local records for the account page (On this device)
    local: {
      preAccount: function () { return kvGet('preAccount'); }, stash: function () { return kvGet('stash'); }, safety: function () { return kvGet('safety'); },
      restorePreAccount: function () { return kvGet('preAccount').then(function (p) { if (!p) return false; return safety().then(function () { return apply(p.payload); }).then(function () { return unlink(); }).then(function () { return true; }); }); },
      discardPreAccount: function () { return kvDel('preAccount'); },
      restoreStash: function (owner) { return kvGet('stash').then(function (st) { if (!st || !st[owner]) return false; var pl = st[owner].payload; delete st[owner]; return safety().then(function () { return apply(pl); }).then(function () { return kvPut('stash', st); }).then(function () { return unlink(); }).then(function () { return true; }); }); },
      restoreSafety: restoreSafety,
      discardSafety: function (n) { return kvGet('safety').then(function (l) { l = Array.isArray(l) ? l : []; l.splice(n, 1); return kvPut('safety', l); }); },
      discardStash: function (owner) { return kvGet('stash').then(function (st) { if (!st) return true; delete st[owner]; return kvPut('stash', st); }); },
    },
    _split: splitPayload, _hashSplit: hashSplit, _classify: classify, _store: { get: kvGet, put: kvPut, del: kvDel },
    _attach: attach, _detach: detach, _mount: mount, _netBack: netBack, _noteSignedOut: noteSignedOut, _setDevice: setDevice, _init: init,
    _hasLocalWork: hasLocalWork, _state: function () { return { binding: clone(S.binding), base: clone(S.base), device: clone(S.device), outbox: clone(S.outbox) }; },
  };
  G.WTS_cloudSync = api;
  publicExpiryAtLoad();
})();
// ── ACCT:END ──

// ─── END 67-cloud-sync ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 68-account-page ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/68-account-page.js — the `account` page (docs/ACCOUNTS-PLAN.md §11.3): profile and security, cloud projects
// (list, filter, open, rename, duplicate, history and restore, download, trash, delete for ever, import), devices, the
// Sign-in methods card (a WP-O mount point), on this device (pre-account snapshot and stashes), storage, data (export
// everything, delete account), activity and the account help (web only; kept here so it is stripped with the page). Round-10.
//
// Same guard as 66; outside it nothing is defined. The registry entry has navHidden:true (host H7: a route, no sidebar
// button, no home tile). It is registered only with the invite-beta flag and only on a host that carries the account hooks
// (the ACCT-marked #wts_account_host of H8 lands with H7), so on an older host the page can never appear as a sidebar row.
// Every server string is put on the page escaped. Plain .card / .rbox / table.dtable markup, so reports work unchanged; the
// route is in the host skip tables (H10). No timers, polling or function wrapping.
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var L = G.location || {};
  function nativeShell(g) {
    try {
      var c = g.Capacitor;
      if (c && typeof c.isNativePlatform === 'function') return !!c.isNativePlatform();
      return !!(c && c.isNative);
    } catch (e) { return true; }
  }
  var DEV = G.WTS_ACCOUNT_DEV === 1 && /^https?:$/.test(L.protocol || '')
    && /^(localhost|127\.0\.0\.1)$/.test(L.hostname || '');
  var ELIGIBLE = ((L.protocol === 'https:' && L.hostname === 'welltest.h2oil.co.uk') || DEV)
    && !nativeShell(G)
    && (function () { try { return G.top === G; } catch (e) { return false; } })();
  if (!ELIGIBLE) return;

  var VERSION = '1.0.0';
  var HAS_DOC = typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';
  var ZIP_SPLIT = 200 * 1000 * 1000;
  var hooks = { renderMethods: null };
  function A() { return G.WTS_account || null; }
  function C() { return G.WTS_cloudSync || null; }
  function I() { var a = A(); return a && a._i ? a._i : null; }
  function $(id) { return HAS_DOC ? document.getElementById(id) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function day(iso) { return iso ? esc(String(iso).slice(0, 10)) : '—'; }
  function when(iso) { if (!iso) return '—'; var s = String(iso); return esc(s.slice(0, 10) + ' ' + s.slice(11, 16)); }
  function mb(n) {
    n = Number(n) || 0;
    var t = n >= 1e6 ? String(Math.round(n / 1e5) / 10) + ' MB' : Math.round(n / 1000) + ' kB';
    var dc = false; try { dc = !!(G.WTS_a11y && G.WTS_a11y.decimalComma && G.WTS_a11y.decimalComma()); } catch (e) { /* none */ }
    return dc ? t.replace('.', ',') : t;      // 250 MB, 1.5 MB (1,5 MB with the decimal-comma setting)
  }
  function say(id, text, kind) { var e = $(id); if (e) { e.textContent = text || ''; e.setAttribute('data-kind', kind || ''); } }
  // a new action clears the page's earlier status messages (review fix: an old error never lingers under a later action)
  var MSG_IDS = ['acct_profile_msg', 'acct_projects_msg', 'acct_devices_msg', 'acct_data_msg'];
  function clearMsgs() { MSG_IDS.forEach(function (id) { say(id, ''); }); }
  // the profile forms: a bad address is caught before any request; the server's bad_request gets the same plain words
  var BAD_ADDRESS = 'Enter a valid e-mail address.';
  function addressOk(id) {
    var el = $(id); var v = el ? String(el.value || '').trim() : '';
    if (!v) return false;
    if (el && typeof el.checkValidity === 'function' && !el.checkValidity()) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }
  function profileErr(e) { return e && e.code === 'bad_request' ? BAD_ADDRESS : errText(e); }
  function errText(e) { var i = I(); return i ? i.cloudErrText(e) : String((e && e.code) || e); }

  var view = { trash: false, filter: '', projects: [], me: null, root: null };

  // ── render ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  function render(body) {
    if (!body) return false;
    var a = A();
    var st = a ? a.state() : { status: 'signedOut' };
    var ii = I(); if (ii && ii.ensureCss) ii.ensureCss();
    body.innerHTML = '<div id="acct_root">' + (st.status === 'signedIn' ? signedInHtml(st) : signedOutHtml(st)) + helpHtml() + '</div>';
    view.root = $('acct_root');
    wire(st);
    return true;
  }
  function outageNote() {
    var c = C(); var s = c ? c.status() : {};
    return 'Cloud unavailable — your work is saved on this device.' + (s.lastSyncAt ? ' Last cloud save ' + new Date(s.lastSyncAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC.' : '');
  }
  function signedOutHtml(st) {
    var msg = st.status === 'unavailable' ? (st.reason === 'paused' ? 'Cloud sync is paused right now. Your work is saved on this device.' : outageNote())
      : 'Sign in to keep your projects in your own cloud database and open them on any computer. Without signing in, nothing leaves this device.';
    return '<div class="card"><div class="card-title">Account</div><p id="acct_page_status">' + esc(msg) + '</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_page_signin">' + (st.status === 'unavailable' ? 'Try again' : 'Sign in') + '</button></div></div>';
  }
  function signedInHtml(st) {
    var me = st.me || {}; var u = me.user || st.user || {}; var s = me.session || {};
    var how = s.authMethod === 'google' ? 'Google' : s.authMethod === 'linkedin' ? 'LinkedIn' : s.authMethod === 'passkey' ? 'a passkey' : 'an e-mail code';
    var q = me.quota || { limit: 0, used: 0 };
    var pct = q.limit ? Math.min(100, Math.round(100 * q.used / q.limit)) : 0;
    return '' +
      '<div class="card" id="acct_card_profile"><div class="card-title">Profile and security</div>' +
      '<div class="rrow"><span class="rl">E-mail address</span><span class="rv" id="acct_p_email">' + esc(u.emailMasked) + '</span></div>' +
      (u.recoveryMasked ? '<div class="rrow"><span class="rl">Recovery address</span><span class="rv" id="acct_p_recovery">' + esc(u.recoveryMasked) + '</span></div>' : '') +
      '<div class="rrow"><span class="rl">This session</span><span class="rv">signed in with ' + esc(how) + ' on ' + when(s.authAt) + (s.publicDevice ? ' (public computer)' : '') + '</span></div>' +
      '<div class="rrow"><span class="rl">Account created</span><span class="rv">' + day(u.created) + '</span></div>' +
      '<div class="rrow"><span class="rl">Terms / Privacy versions</span><span class="rv">' + esc(u.terms) + ' / ' + esc(u.privacy) + '</span></div>' +
      (u.status === 'deleting' ? '<div id="acct_p_deleting">&#9888; Your account is being deleted on ' + day(u.deleteAt) + '. <button type="button" class="btn btn-primary" id="acct_cancel_delete">Cancel deletion</button></div>' : '') +
      '<div class="fg-item"><label for="acct_new_email">Change e-mail address</label><input type="email" id="acct_new_email" maxlength="254" autocomplete="off" data-acct-skip="1"></div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_change_email">Send a code to the new address</button></div>' +
      '<div class="fg-item" id="acct_email_code_row" hidden><label for="acct_email_code">Code from the new address</label><input type="text" id="acct_email_code" inputmode="numeric" maxlength="11" autocomplete="one-time-code" data-acct-skip="1"></div>' +
      '<div class="acct-btns" id="acct_email_confirm_row" hidden><button type="button" class="btn btn-primary" id="acct_confirm_email">Confirm the new address</button></div>' +
      '<div class="fg-item"><label for="acct_recovery">' + (u.recoveryMasked ? 'Replace the recovery address' : 'Add a recovery address (a personal address helps if you lose your work mailbox)') + '</label><input type="email" id="acct_recovery" maxlength="254" autocomplete="off" data-acct-skip="1"></div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_set_recovery">Send a code to it</button>' +
      (u.recoveryMasked ? '<button type="button" class="btn btn-secondary" id="acct_remove_recovery">Remove the recovery address</button>' : '') + '</div>' +
      '<div class="fg-item" id="acct_recovery_code_row" hidden><label for="acct_recovery_code">Code from the recovery address</label><input type="text" id="acct_recovery_code" inputmode="numeric" maxlength="11" data-acct-skip="1"></div>' +
      '<div class="acct-btns" id="acct_recovery_confirm_row" hidden><button type="button" class="btn btn-primary" id="acct_confirm_recovery">Confirm the recovery address</button></div>' +
      '<div id="acct_profile_msg" role="status" aria-live="polite"></div></div>' +

      '<div class="card" id="acct_card_projects"><div class="card-title">Cloud projects</div>' +
      '<div class="acct-btns"><input type="text" id="acct_filter" placeholder="Filter by name, client or well" aria-label="Filter projects" data-acct-skip="1">' +
      '<button type="button" class="btn btn-secondary" id="acct_toggle_trash">' + (view.trash ? 'Show projects' : 'Show trash') + '</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_import">Import files…</button>' +
      // linked: Save to cloud (a new revision of the open project); unlinked: the first save creates a cloud project
      '<button type="button" class="btn btn-primary" id="acct_save_new">' + (cloudLinked() ? 'Save to cloud' : 'Save this device\'s project to the cloud') + '</button></div>' +
      '<div id="acct_projects" aria-live="polite"><p>Loading…</p></div><div id="acct_projects_msg" role="status" aria-live="polite"></div></div>' +

      '<div class="card" id="acct_card_devices"><div class="card-title">Devices</div><div id="acct_devices">' + devicesHtml(me.devices || []) + '</div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_signout_all">Sign out everywhere…</button></div><div id="acct_devices_msg" role="status"></div></div>' +

      // WP-O mount point: the Sign-in methods card (e-mail, recovery, Google, LinkedIn, passkeys; link / unlink)
      // (the provider block fills the mount with every row and the note; without it, the e-mail row below stands alone)
      '<div class="card" id="acct_methods_card" data-owner="WP-O"><div class="card-title">Sign-in methods</div>' +
      '<div id="acct_methods_mount"><div class="rrow"><span class="rl">E-mail code</span><span class="rv">always on — ' + esc(u.emailMasked) + '</span></div>' +
      '<p class="acct-note">Your e-mail address always works as a way in, even if you lose your Google or LinkedIn account.</p></div></div>' +

      '<div class="card" id="acct_card_local"><div class="card-title">On this device</div><div id="acct_local"><p>Loading…</p></div></div>' +

      '<div class="card" id="acct_card_storage"><div class="card-title">Storage</div>' +
      '<div class="rrow"><span class="rl">Used</span><span class="rv" id="acct_storage_used">' + mb(q.used) + ' of ' + mb(q.limit) + ' (' + pct + ' %)</span></div>' +
      '<div style="height:8px;background:var(--bg3,#333);border-radius:4px;overflow:hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Cloud storage used">' +
      '<div style="height:8px;width:' + pct + '%;background:' + (pct >= 90 ? '#d9483b' : '#2fa84f') + '"></div></div></div>' +

      '<div class="card" id="acct_card_data"><div class="card-title">Your data</div>' +
      '<p>Export everything: a zip file with every cloud project as a .h2oilproj file and your account data (devices, sign-in methods, activity).</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_export">Export everything</button></div>' +
      '<p>Delete account: everything is hidden at once and deleted for good after 7 days. Signing in again during those days lets you cancel.</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_delete">Delete account…</button></div><div id="acct_data_msg" role="status" aria-live="polite"></div></div>' +

      '<div class="card" id="acct_card_activity"><div class="card-title">Activity</div><p>Your own sign-ins and security changes of the last 90 days (Export everything has 12 months). Showing them needs a fresh confirmation; the list comes from an export of your account data, so your e-mail address also gets the "your data was exported" notice.</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_show_activity">Show my activity</button></div><div id="acct_activity"></div></div>';
  }
  function cloudLinked() { var c = C(); return !!(c && c.status && c.status().projectId); }
  function devicesHtml(list) {
    if (!list.length) return '<p>No devices.</p>';
    return '<table class="dtable" id="acct_devices_table"><thead><tr><th>Device</th><th>Last seen</th><th></th></tr></thead><tbody>' +
      list.map(function (d) {
        return '<tr data-id="' + esc(d.id) + '"><td data-label="Device">' + esc(d.label || 'Device') + (d.current ? ' <b>(this device)</b>' : '') + '</td><td data-label="Last seen">' + when(d.lastSeen) + '</td><td>' +
          '<button type="button" class="btn btn-secondary acct-dev-rename" data-id="' + esc(d.id) + '">Rename</button> ' +
          (d.current ? '' : '<button type="button" class="btn btn-secondary acct-dev-revoke" data-id="' + esc(d.id) + '">Sign out device</button>') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function projectsHtml(list) {
    var f = view.filter.toLowerCase();
    var rows = list.filter(function (p) {
      if (!f) return true;
      var m = p.meta || {};
      return [p.name, m.client, m.well, m.field].join(' ').toLowerCase().indexOf(f) !== -1;
    });
    if (!rows.length) return '<p id="acct_projects_empty">' + (view.trash ? 'The trash is empty.' : (list.length ? 'No project matches the filter.' : 'No cloud projects yet. Use Save to cloud, or import project files.')) + '</p>';
    var c = C(); var bound = c ? c.status().projectId : null;
    return '<table class="dtable" id="acct_projects_table"><thead><tr><th>Name</th><th>Client / well</th><th>Wells</th><th>Last saved</th><th>Size</th><th></th></tr></thead><tbody>' +
      rows.map(function (p) {
        var m = p.meta || {};
        var acts = view.trash
          ? '<button type="button" class="btn btn-secondary" data-act="restore" data-id="' + esc(p.id) + '">Restore</button> <button type="button" class="btn btn-secondary" data-act="purge" data-id="' + esc(p.id) + '">Delete for ever</button>'
          : (Number(p.headRev) ? ['open:Open', 'rename:Rename', 'duplicate:Duplicate', 'history:History', 'download:Download', 'trash:Move to trash'] : ['trash:Move to trash']).map(function (x) {
            var k = x.split(':'); return '<button type="button" class="btn btn-secondary" data-act="' + k[0] + '" data-id="' + esc(p.id) + '">' + k[1] + '</button>';
          }).join(' ');
        return '<tr data-id="' + esc(p.id) + '"><td data-label="Name">' + esc(p.name) + (p.conflictOf ? ' <span title="conflict copy">&#9888; conflict copy</span>' : '') + (p.id === bound ? ' <b>(open here)</b>' : '') + (Number(p.headRev) ? '' : ' <span class="acct-incomplete">(incomplete upload — Save to cloud again to finish it)</span>') + '</td>' +
          '<td data-label="Client / well">' + esc([m.client, m.well].filter(Boolean).join(' / ')) + '</td><td data-label="Wells">' + esc(p.wells) + '</td><td data-label="Last saved">' + when(p.savedAt) + '</td><td data-label="Size">' + mb(p.bytes) + '</td><td>' + acts + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function helpHtml() {
    return '<div class="card" id="acct_card_help"><div class="card-title">Help: accounts and cloud projects</div>' +
      '<p><b>How cloud projects work.</b> Your work is always saved on this device first. <i>Save to cloud</i> (the &#9729; button, the account menu or Ctrl+S while a cloud project is open) ' +
      'stores a new version of the project in your own cloud database; <i>Open from cloud</i> loads a version on any computer. Every save is kept in the project\'s history, so you can restore an older version.</p>' +
      '<p><b>Two computers.</b> If the cloud copy changed on another computer since you opened it, Save to cloud asks: overwrite it (the other version stays in the history), save yours as a new project, or cancel. Nothing is overwritten silently.</p>' +
      '<p><b>Public or shared computers.</b> Tick "This is a public or shared computer" when you sign in. You are signed out after 12 hours, and signing out removes your work from the browser. ' +
      'Changes that are not in the cloud yet can be uploaded, downloaded or kept locked for 7 days so that only you can unlock them.</p>' +
      '<p><b>Didn\'t get the code?</b> Look in your spam or quarantine folder, ask your IT team to allow no-reply@h2oil.co.uk, and remember that codes last 15 minutes and the previous code still works after "Send again". A recovery address can receive the code too.</p>' +
      '<p><b>Your data.</b> Export everything at any time; deleting the account hides everything at once and removes it after 7 days. For other requests write to software@h2oil.co.uk.</p></div>';
  }

  // ── wiring ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  function on(id, fn) { var e = $(id); if (e) e.addEventListener('click', function (ev) { clearMsgs(); return fn(ev); }); }
  function wire(st) {
    var a = A();
    if (st.status !== 'signedIn') {
      on('acct_page_signin', function () {
        if (st.status === 'unavailable') a.refresh().then(rerender, rerender);
        else a.openSignIn().then(function (s) { if (s) rerender(); });
      });
      return;
    }
    var root = view.root;
    on('acct_change_email', function () {
      var v = String($('acct_new_email').value || '').trim();
      if (!v) { say('acct_profile_msg', 'Type the new address first.', 'err'); return; }
      if (!addressOk('acct_new_email')) { say('acct_profile_msg', BAD_ADDRESS, 'err'); return; }
      a.changeEmail(v).then(function () {
        $('acct_email_code_row').hidden = false; $('acct_email_confirm_row').hidden = false;
        say('acct_profile_msg', 'If the address can be used, a code is on its way to it.', 'ok');
      }, function (e) { if (e && e.code !== 'cancelled') say('acct_profile_msg', profileErr(e), 'err'); });
    });
    on('acct_confirm_email', function () {
      a.confirmEmail(String($('acct_email_code').value || '').replace(/\s/g, '')).then(function () { rerender(); }, function (e) { say('acct_profile_msg', e && e.code === 'invalid_or_expired' ? 'That code is wrong or has expired.' : errText(e), 'err'); });
    });
    on('acct_set_recovery', function () {
      var v = String($('acct_recovery').value || '').trim();
      if (!v) { say('acct_profile_msg', 'Type the recovery address first.', 'err'); return; }
      if (!addressOk('acct_recovery')) { say('acct_profile_msg', BAD_ADDRESS, 'err'); return; }
      a.setRecovery(v).then(function () {
        $('acct_recovery_code_row').hidden = false; $('acct_recovery_confirm_row').hidden = false;
        say('acct_profile_msg', 'If the address can be used, a code is on its way to it.', 'ok');
      }, function (e) { if (e && e.code !== 'cancelled') say('acct_profile_msg', profileErr(e), 'err'); });
    });
    on('acct_confirm_recovery', function () {
      a.confirmRecovery(String($('acct_recovery_code').value || '').replace(/\s/g, '')).then(function () { rerender(); }, function (e) { say('acct_profile_msg', e && e.code === 'invalid_or_expired' ? 'That code is wrong or has expired.' : errText(e), 'err'); });
    });
    on('acct_remove_recovery', function () { a.removeRecovery().then(rerender, function (e) { if (e && e.code !== 'cancelled') say('acct_profile_msg', errText(e), 'err'); }); });
    on('acct_cancel_delete', function () { a.cancelDeletion().then(rerender, function (e) { say('acct_profile_msg', errText(e), 'err'); }); });
    var filt = $('acct_filter');
    if (filt) filt.addEventListener('input', function () { view.filter = String(filt.value || ''); drawProjects(); });
    on('acct_toggle_trash', function () { view.trash = !view.trash; $('acct_toggle_trash').textContent = view.trash ? 'Show projects' : 'Show trash'; loadProjects(); });
    on('acct_import', function () { C().pickAndImport().then(function () { loadProjects(); }, function (e) { say('acct_projects_msg', errText(e), 'err'); }); });
    on('acct_save_new', function () { C().saveToCloud({ as: !C().status().projectId }).then(function (r) { if (r && !r.cancelled) say('acct_projects_msg', 'Saved to the cloud.', 'ok'); loadProjects(); }, function (e) { say('acct_projects_msg', errText(e), 'err'); }); });
    var pj = $('acct_projects');
    if (pj) pj.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (!t) return;
      projectAction(t.getAttribute('data-act'), t.getAttribute('data-id'));
    });
    var dv = $('acct_devices');
    if (dv) dv.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('button') : null; if (!t) return;
      var id = t.getAttribute('data-id');
      if (/acct-dev-rename/.test(t.className)) {
        var nm = G.prompt ? G.prompt('Device name (letters, digits, spaces and - _ . ( ) only):', '') : null;
        if (nm == null) return;
        nm = String(nm).replace(/[^A-Za-z0-9 _.()-]/g, '').slice(0, 40);
        a.call('POST', '/devices/rename', { id: id, label: nm }).then(function () { return a.refresh(); }).then(rerender, function (e) { say('acct_devices_msg', errText(e), 'err'); });
      } else if (/acct-dev-revoke/.test(t.className)) {
        a.call('POST', '/devices/revoke', { id: id }).then(function () { return a.refresh(); }).then(rerender, function (e) { say('acct_devices_msg', errText(e), 'err'); });
      }
    });
    on('acct_signout_all', function () { signOutAll(); });
    on('acct_export', exportEverything);
    on('acct_delete', deleteAccount);
    on('acct_show_activity', showActivity);
    // WP-O: the Sign-in methods card
    var mm = $('acct_methods_mount');
    if (mm && typeof hooks.renderMethods === 'function') { try { hooks.renderMethods(mm, st); } catch (e) { /* WP-O */ } }
    loadProjects(); drawLocal();
    return root;
  }
  function signOutAll() {
    var i = I();
    return i.choose({ title: 'Sign out everywhere', text: 'Sign out of every browser and device that uses your account? This one is signed out too.',
      html: '<label class="acct-tick"><input type="checkbox" id="acct_recent_methods"> Also remove ' + (i.recentMethodsText ? i.recentMethodsText() : 'Google / LinkedIn links') + ' added in the last 14 days</label>',
      buttons: [{ id: 'all', label: 'Sign out everywhere', primary: true }, { id: 'cancel', label: 'Cancel' }], keepOpen: true }).then(function (c) {
      var t = $('acct_recent_methods'); var recent = !!(t && t.checked);
      i.closeDialog(false);
      if (c !== 'all') return null;
      return A().signOut({ everywhere: true, alsoRecentMethodsDays: recent ? 14 : 0, keep: true }).then(rerender);
    });
  }
  function rerender() {
    var r = $('acct_root');
    if (r && r.parentNode) return render(r.parentNode);
    return registered ? render($('pgBody')) : false;   // never draw into #pgBody outside the account route
  }
  function loadProjects() {
    var c = C(); if (!c) return Promise.resolve([]);
    return c.listProjects({ trash: view.trash }).then(function (list) { view.projects = list; drawProjects(); return list; }, function (e) {
      var pj = $('acct_projects');
      if (pj) pj.innerHTML = '<p id="acct_projects_outage">' + esc(I() && I().isOutage(e) ? outageNote() : errText(e)) + '</p>';
      return [];
    });
  }
  function drawProjects() { var pj = $('acct_projects'); if (pj) pj.innerHTML = projectsHtml(view.projects); }
  function projectAction(act, id) {
    var c = C(); var i = I();
    var p = view.projects.filter(function (x) { return x.id === id; })[0] || { id: id, name: '' };
    var done = function (text) { say('acct_projects_msg', text, 'ok'); return loadProjects(); };
    var bad = function (e) { if (e && e.code === 'cancelled') return; say('acct_projects_msg', errText(e), 'err'); };
    if (act === 'open') return c.openFromCloud(id).then(function () { done('Opened "' + p.name + '".'); }, bad);
    if (act === 'rename') {
      var nm = G.prompt ? G.prompt('New name for the project:', p.name) : null;
      if (nm == null || !String(nm).trim()) return null;
      return c.rename(id, String(nm).trim().slice(0, 200)).then(function () { done('Renamed.'); }, bad);
    }
    if (act === 'duplicate') return c.duplicate(id, ('Copy of ' + p.name).slice(0, 200)).then(function () { done('Duplicated.'); }, bad);
    if (act === 'download') return c.download(id, p.name).then(function () { done('Downloaded.'); }, bad);
    if (act === 'trash') return c.trash(id).then(function () { done('Moved to the trash (kept for 30 days).'); }, bad);
    if (act === 'restore') return c.restore(id).then(function () { done('Restored.'); }, bad);
    if (act === 'purge') {
      return i.choose({ title: 'Delete for ever', text: 'Delete "' + p.name + '" and its whole history for good? This cannot be undone.',
        buttons: [{ id: 'yes', label: 'Delete for ever' }, { id: 'no', label: 'Cancel', primary: true }] }).then(function (ch) {
        if (ch !== 'yes') return null;
        return c.purge(id).then(function () { done('Deleted for good.'); }, bad);
      });
    }
    if (act === 'history') {
      return c.history(id).then(function (revs) {
        var btns = revs.slice(0, 12).map(function (r) { return { id: 'r' + r.rev, label: 'Restore version ' + r.rev + ' (' + String(r.savedAt).slice(0, 16).replace('T', ' ') + ', ' + r.reason + ')' }; });
        btns.push({ id: 'close', label: 'Close', primary: true });
        return i.choose({ title: 'History of "' + p.name + '"', text: 'Restoring a version makes it the newest version; nothing is removed from the history.', buttons: btns }).then(function (ch) {
          if (!ch || ch.charAt(0) !== 'r') return null;
          return c.restoreRevision(id, Number(ch.slice(1))).then(function (r) { done('Version restored as version ' + r.rev + '.'); }, bad);
        });
      }, bad);
    }
    return null;
  }
  function drawLocal() {
    var c = C(); var el = $('acct_local'); if (!c || !el) return Promise.resolve();
    return Promise.all([c.local.preAccount(), c.local.stash(), c.local.safety ? c.local.safety() : null]).then(function (r) {
      var pre = r[0], st = r[1] || {}, saf = Array.isArray(r[2]) ? r[2] : [];
      var rows = [];
      // the 2-slot safety list (§6.8): the work that was open before an Open from cloud or a restore
      saf.forEach(function (x, n) {
        if (!x || !x.payload) return;
        rows.push('<div class="rrow"><span class="rl">Safety copy' + (x.name ? ' of ' + esc(x.name) : '') + ' (' + when(new Date(x.at).toISOString()) + ' UTC)</span><span class="rv">' +
          '<button type="button" class="btn btn-secondary acct-safety" data-act="restore" data-n="' + n + '" id="acct_safety_restore_' + n + '">Restore</button> ' +
          '<button type="button" class="btn btn-secondary acct-safety" data-act="discard" data-n="' + n + '" id="acct_safety_discard_' + n + '">Discard</button></span></div>');
      });
      if (pre) rows.push('<div class="rrow"><span class="rl">Work from before you signed in (' + day(new Date(pre.at).toISOString()) + ')</span><span class="rv">' +
        '<button type="button" class="btn btn-secondary" id="acct_pre_restore">Restore</button> <button type="button" class="btn btn-secondary" id="acct_pre_discard">Discard</button></span></div>');
      Object.keys(st).forEach(function (k, n) {
        rows.push('<div class="rrow"><span class="rl">Work kept local at a hand-over (' + day(new Date(st[k].at).toISOString()) + ')</span><span class="rv">' +
          '<button type="button" class="btn btn-secondary acct-stash" data-act="restore" data-owner="' + esc(k) + '" id="acct_stash_restore_' + n + '">Restore</button> ' +
          '<button type="button" class="btn btn-secondary acct-stash" data-act="discard" data-owner="' + esc(k) + '" id="acct_stash_discard_' + n + '">Discard</button></span></div>');
      });
      el.innerHTML = rows.length ? rows.join('') : '<p id="acct_local_none">Nothing is kept on this device besides the open project.</p>';
      on('acct_pre_restore', function () { c.local.restorePreAccount().then(drawLocal); });
      on('acct_pre_discard', function () { c.local.discardPreAccount().then(drawLocal); });
      if (el.getAttribute('data-acct-wired')) return;   // one delegated listener; drawLocal runs again after every action
      el.setAttribute('data-acct-wired', '1');
      el.addEventListener('click', function (ev) {
        var sf = ev.target && ev.target.closest ? ev.target.closest('button.acct-safety') : null;
        if (sf) {
          var n = Number(sf.getAttribute('data-n'));
          (sf.getAttribute('data-act') === 'restore' ? c.local.restoreSafety(n) : c.local.discardSafety(n)).then(drawLocal);
          return;
        }
        var t = ev.target && ev.target.closest ? ev.target.closest('button.acct-stash') : null; if (!t) return;
        var o = t.getAttribute('data-owner');
        (t.getAttribute('data-act') === 'restore' ? c.local.restoreStash(o) : c.local.discardStash(o)).then(drawLocal);
      });
    });
  }

  // ── export (zip, store only; split above 200 MB) and delete ─────────────────────────────────────────────────────────
  var CRC = null;
  function crc32(b) {
    if (!CRC) { CRC = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    var x = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) x = CRC[(x ^ b[i]) & 0xFF] ^ (x >>> 8);
    return (x ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new G.TextEncoder().encode(s); }
  // zip(files [{name, text}]) → Uint8Array (stored entries, UTF-8 names)
  function zip(files) {
    var parts = [], central = [], off = 0;
    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function (f) {
      var name = utf8(f.name), data = utf8(f.text), crc = crc32(data);
      var head = [].concat([0x50, 0x4b, 3, 4], u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(head), name, data);
      central.push(new Uint8Array([].concat([0x50, 0x4b, 1, 2], u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off))), name);
      off += head.length + name.length + data.length;
    });
    var cdSize = central.reduce(function (n, x) { return n + x.length; }, 0);
    var end = new Uint8Array([].concat([0x50, 0x4b, 5, 6], u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(off), u16(0)));
    var all = parts.concat(central, [end]);
    var n = all.reduce(function (s, x) { return s + x.length; }, 0), out = new Uint8Array(n), o = 0;
    all.forEach(function (x) { out.set(x, o); o += x.length; });
    return out;
  }
  // splitFiles(files, limit) → [[files]] — groups of at most `limit` bytes (account.json in the first)
  function splitFiles(files, limit) {
    var groups = [[]], size = 0;
    files.forEach(function (f) {
      var n = utf8(f.text).length + f.name.length + 100;
      if (groups[groups.length - 1].length && size + n > limit) { groups.push([]); size = 0; }
      groups[groups.length - 1].push(f); size += n;
    });
    return groups;
  }
  function downloadBytes(name, bytes) {
    if (!HAS_DOC) return;
    var blob = new G.Blob([bytes], { type: 'application/zip' });
    var url = null; try { url = G.URL.createObjectURL(blob); } catch (e) { url = null; }
    var a = document.createElement('a'); a.href = url || '#'; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); try { document.body.removeChild(a); } catch (e) { /* gone */ }
  }
  function exportEverything(limit) {
    var c = C();
    say('acct_data_msg', 'Preparing the export…');
    return c.exportAll().then(function (res) {
      var groups = splitFiles(res.files, typeof limit === 'number' ? limit : ZIP_SPLIT);
      var stamp = new Date().toISOString().slice(0, 10);
      groups.forEach(function (g, k) { downloadBytes('well-testing-suite-export-' + stamp + (groups.length > 1 ? '-part' + (k + 1) : '') + '.zip', zip(g)); });
      say('acct_data_msg', 'Export ready: ' + res.files.length + ' files in ' + groups.length + ' zip file' + (groups.length > 1 ? 's' : '') + '.', 'ok');
      return { files: res.files.length, zips: groups.length, account: res.account };
    }, function (e) { if (!e || e.code !== 'cancelled') say('acct_data_msg', errText(e), 'err'); return null; });
  }
  function deleteAccount() {
    var i = I(); var a = A();
    return i.choose({ title: 'Delete account', text: 'Your account and every cloud project are hidden at once and deleted for good after 7 days. Your work on this device stays. Type DELETE to confirm.',
      html: '<label for="acct_delete_confirm">Type DELETE</label><input type="text" id="acct_delete_confirm" autocomplete="off" maxlength="10">',
      buttons: [{ id: 'delete', label: 'Delete my account' }, { id: 'cancel', label: 'Cancel', primary: true }], keepOpen: true }).then(function (ch) {
      var v = $('acct_delete_confirm'); var typed = v ? String(v.value || '').trim() : '';
      i.closeDialog(false);
      if (ch !== 'delete') return null;
      if (typed !== 'DELETE') { say('acct_data_msg', 'Type DELETE in capitals to confirm.', 'err'); return null; }
      return a.withStepUp(function () { return a.call('POST', '/account/delete', { confirm: 'DELETE' }); }, 'Deleting your account needs a fresh confirmation.').then(function (r) {
        say('acct_data_msg', 'Your account will be deleted on ' + String(r.json.deleteAt).slice(0, 10) + '. Sign in before then to cancel.', 'ok');
        return a._i.signedOutLocal('deleted').then(function () { rerender(); return r.json; });
      }, function (e) { if (!e || e.code !== 'cancelled') say('acct_data_msg', errText(e), 'err'); return null; });
    });
  }
  // the audit action codes in plain words (§11.3)
  var ACTIONS = { signup: 'Account created', signin: 'Signed in', stepup: 'Confirmed with a code', signout: 'Signed out', signout_all: 'Signed out everywhere',
    email_change: 'E-mail address changed', email_revert: 'E-mail change undone', recovery_set: 'Recovery address set', recovery_remove: 'Recovery address removed',
    identity_link: 'Sign-in method linked', identity_unlink: 'Sign-in method removed', export: 'Data exported', delete_request: 'Account deletion requested',
    delete_cancel: 'Account deletion cancelled', device_revoke: 'Device signed out', device_rename: 'Device renamed', passkey_add: 'Passkey added',
    passkey_remove: 'Passkey removed', project_purge: 'Project deleted for ever', commit_burst: 'Many cloud saves in a short time',
    read_burst: 'Many cloud reads in a short time' };
  var METHODS = { code: 'e-mail code', google: 'Google', linkedin: 'LinkedIn', passkey: 'passkey' };
  function actionText(r) {
    var a = String((r && r.action) || '');
    var t = ACTIONS[a] || a.replace(/_/g, ' ');
    var m = r && r.detail && r.detail.method;
    return t + (m ? ' (' + (METHODS[m] || String(m)) + ')' : '');
  }
  function showActivity() {
    var c = C();
    // the account JSON only — no project bodies are downloaded (§11.3: the user's own audit rows, 90 days)
    return c.exportAll({ accountOnly: true }).then(function (res) {
      var since = (I() && I().now ? I().now() : Date.now()) - 90 * 24 * 3600 * 1000;
      var rows = (res.account.audit || []).filter(function (r) { var t = Date.parse(r && r.at); return isFinite(t) && t >= since; });
      var el = $('acct_activity');
      if (el) el.innerHTML = rows.length ? '<table class="dtable" id="acct_activity_table"><thead><tr><th>When</th><th>What</th></tr></thead><tbody>' +
        rows.map(function (r) { return '<tr><td data-label="When">' + when(r.at) + '</td><td data-label="What">' + esc(actionText(r)) + '</td></tr>'; }).join('') + '</tbody></table>' : '<p>No activity.</p>';
      return rows.length;
    }, function (e) { if (!e || e.code !== 'cancelled') say('acct_data_msg', errText(e), 'err'); return 0; });
  }

  // ── registry ───────────────────────────────────────────────────────────────────────────────────────────────────────
  var entry = {
    key: 'account', title: 'Account', sub: 'Sign-in, cloud projects and your data', group: 'Overview', icon: '&#9729;',
    navHidden: true, render: render,
  };
  var registered = false;
  // register({force}) → true once the entry is in WTS_calcRegistry: only with the beta flag and a host that has the account
  // hooks (H7 navHidden lands with H8's ACCT-marked #wts_account_host), unless forced (tests).
  function register(o) {
    o = o || {};
    if (registered) return true;
    var a = A();
    var hostReady = HAS_DOC && !!document.getElementById('wts_account_host') && !document.getElementById('wts_account_host').getAttribute('data-acct-created');
    if (!o.force && !(a && a.betaEnabled && a.betaEnabled() && hostReady)) return false;
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.account = entry;
    registered = true;
    return true;
  }
  // open() — the registered route when the host has the account hooks; otherwise the page is drawn in its own overlay OUTSIDE
  // #pgBody, so the host autosave never stores the e-mail / code inputs in wts_page_<route> (project files, cloud snapshots).
  function open() {
    if (registered && typeof G.WTS_nav === 'function') return G.WTS_nav('account');
    if (!HAS_DOC || !document.body) return null;
    var i = I(); if (i && i.ensureCss) i.ensureCss();
    var ov = $('acct_page_ov');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'acct_page_ov'; ov.className = 'acct-ov acct-page-ov rp-skip';
      ov.setAttribute('data-rp-nosnap', '1'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', entry.title);
      ov.innerHTML = '<div class="acct-dlg acct-page-dlg"><h3><span>' + esc(entry.title) + '</span><button type="button" class="acct-x" id="acct_page_close" aria-label="Close">&times;</button></h3>' +
        '<div id="acct_page_body"></div></div>';
      document.body.appendChild(ov);
      var x = $('acct_page_close');
      if (x) x.addEventListener('click', function () { var o = $('acct_page_ov'); if (o && o.parentNode) o.parentNode.removeChild(o); });
    }
    return render($('acct_page_body'));
  }
  // Card 4 "Sign-in methods" (§11.3) — e-mail, recovery, Google, LinkedIn, passkeys; link (step-up, redirect, link-confirm
  // code on return) and unlink (step-up; reports the sessions signed out). The card lives in 66 (WTS_account.oauthUI.
  // renderMethods) beside the provider assets; the page render mounts it through hooks.renderMethods.
  function renderSignInMethods(host) {
    var a = A();
    if (!a || !a.oauthUI || typeof a.oauthUI.renderMethods !== 'function') return Promise.resolve(null);
    return a.oauthUI.renderMethods(host);
  }
  if (typeof hooks.renderMethods !== 'function') hooks.renderMethods = function (host) { return renderSignInMethods(host); };
  G.WTS_accountPage = { VERSION: VERSION, entry: entry, render: render, register: register, open: open, hooks: hooks,
    renderSignInMethods: renderSignInMethods, _zip: zip, _splitFiles: splitFiles, _export: exportEverything, _reload: loadProjects };
  register();
})();
// ── ACCT:END ──

// ─── END 68-account-page ─────────────────────────────────────────────

