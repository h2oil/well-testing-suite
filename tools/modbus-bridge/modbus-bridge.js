#!/usr/bin/env node
// =============================================================================
// modbus-bridge.js — WebSocket ↔ Modbus TCP bridge for the Well Testing Suite
// (Mini WellOS / Modbus page). Zero dependencies, Node.js ≥ 18.
//
//   browser ──ws://127.0.0.1:8502/modbus?host=10.0.0.5&port=502──► bridge ──TCP──► PLC / RTU / gateway
//
// Protocol
//   • The page opens one WebSocket per device with ?host=&port= query parameters.
//   • The bridge checks the Origin header and the host:port against its allow-lists,
//     opens the TCP connection, then sends the text frame {"type":"open"}.
//     Failures: {"type":"error","message":"…"} then close (1008 policy / 1011 error).
//   • Binary frames = complete Modbus TCP ADUs (MBAP header + PDU) in both directions.
//     The bridge re-frames the TCP byte stream into whole ADUs using the MBAP length.
//   • Read-only by default: a request with function code 05 / 06 / 15 / 16 (or any code
//     outside 01-06, 15, 16) is answered by the bridge itself with Modbus exception 01
//     (Illegal function) and never reaches the device, unless --allow-writes is given.
//   • GET /health → {"name","version","readOnly","port","uptimeS","allow":[…]} for the app's
//     "Check bridge" button. CORS headers only for accepted page origins (same rules as the
//     WebSocket upgrade); the preflight answers Access-Control-Allow-Private-Network: true
//     (Chrome Private Network Access). Other origins, and Host names other than localhost /
//     an IP literal / --listen (DNS rebinding), get a plain 403.
//
// Security defaults: listens on 127.0.0.1 only; no target is reachable until allowed
// with --allow; browser origins limited to localhost / 127.0.0.1 / file / the app's
// capacitor origin and the app's web origin (pb-handbook.com) unless --origin or --any-origin
// is given; ADU ≤ 260 bytes.
//
// Usage:  node modbus-bridge.js --allow 192.168.1.10:502 [--allow 10.0.0.0/24:502] [--allow host:*]
//                               [--listen 127.0.0.1] [--port 8502] [--origin https://example.com]
//                               [--any-origin] [--allow-writes] [--verbose]
//                               [--config bridge-config.json] [--version] [--help]
// --config file.json: {"allow":["192.168.1.10:502"], "port":8502, "listen":"127.0.0.1",
//   "origins":[], "anyOrigin":false, "allowWrites":false, "verbose":false} (all keys optional;
//   keys starting with "_" are comments). Command-line flags override the file's port / listen
//   and add to its allow / origins lists; --allow-writes, --any-origin, --verbose switch those on.
// RFC 6455 (WebSocket) framing; MODBUS Messaging on TCP/IP Implementation Guide V1.0b (MBAP).
// =============================================================================
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

const BRIDGE_VERSION = '1.1.0';
const BRIDGE_NAME = 'wts-modbus-bridge';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';     // RFC 6455 §1.3
const MAX_ADU = 260;
const READ_FCS = new Set([1, 2, 3, 4]);
const WRITE_FCS = new Set([5, 6, 15, 16]);
const DEFAULT_ORIGINS = [/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i, /^https:\/\/(www\.)?pb-handbook\.com$/i,
  /^capacitor:\/\/localhost$/i, /^null$/, /^file:\/\//i];

// ─── allow-list ──────────────────────────────────────────────────────────────
// entry: "host:port" | "host:*" | "a.b.c.d/nn:port" (IPv4 CIDR)
function parseAllow(spec) {
  const s = String(spec).trim();
  const i = s.lastIndexOf(':');
  if (i <= 0) throw new Error('--allow needs host:port, got ' + spec);
  const host = s.slice(0, i).replace(/^\[|\]$/g, ''), port = s.slice(i + 1);
  if (port !== '*' && !(/^\d{1,5}$/.test(port) && +port >= 1 && +port <= 65535)) throw new Error('bad port in --allow ' + spec);
  if (!/^[A-Za-z0-9._-]+(\/\d{1,2})?$/.test(host) && !/^[0-9A-Fa-f:.]+$/.test(host)) throw new Error('bad host in --allow ' + spec + ' (IPv4, IPv4/nn, IPv6 or a host name)');
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(host);
  if (m && (ip4(m[1]) == null || !(+m[2] >= 0 && +m[2] <= 32))) throw new Error('bad IPv4 subnet in --allow ' + spec);
  const h = host.toLowerCase(), p = port === '*' ? '*' : +port;
  return { host: h, port: p, cidr: m ? { base: ip4(m[1]), bits: +m[2] } : null, spec: (h.indexOf(':') >= 0 ? '[' + h + ']' : h) + ':' + p };
}
function ip4(s) { const p = s.split('.').map(Number); if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return null; return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; }
function allowed(list, host, port) {
  host = String(host || '').toLowerCase(); port = +port;
  return list.some((a) => {
    if (a.port !== '*' && a.port !== port) return false;
    if (a.cidr) {
      const ip = ip4(host); if (ip == null || a.cidr.base == null) return false;
      const mask = a.cidr.bits === 0 ? 0 : (0xFFFFFFFF << (32 - a.cidr.bits)) >>> 0;
      return (ip & mask) === (a.cidr.base & mask);
    }
    return a.host === host;
  });
}
function originOk(opts, origin) {
  if (opts.anyOrigin) return true;
  const o = origin == null ? 'null' : String(origin);
  if ((opts.origins || []).some((x) => x.toLowerCase() === o.toLowerCase())) return true;
  return DEFAULT_ORIGINS.some((re) => re.test(o));
}
// /health answers only requests addressed to localhost, an IP literal or the --listen name,
// so a web page cannot read it through a DNS-rebound host name.
function hostHeaderOk(opts, hostHeader) {
  if (hostHeader == null || hostHeader === '') return true;          // HTTP/1.0 client
  let h = String(hostHeader).trim().toLowerCase();
  if (h[0] === '[') { const j = h.indexOf(']'); return j > 0 && h.slice(1, j).indexOf(':') >= 0; }   // IPv6 literal
  const j = h.lastIndexOf(':'); if (j >= 0) h = h.slice(0, j);
  if (h === 'localhost' || /\.localhost$/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) && ip4(h) != null) return true;
  return !!(opts && opts.listen && h === String(opts.listen).toLowerCase());
}

// ─── WebSocket framing (server side, RFC 6455 §5) ────────────────────────────
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
// Parses as many complete frames as possible. Returns { frames:[{fin, opcode, payload}], rest, error }
function decodeFrames(buf, maxPayload) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, p = off + 2;
    if (b0 & 0x70) return { frames, rest: Buffer.alloc(0), error: [1002, 'reserved bits set'] };
    if (!masked) return { frames, rest: Buffer.alloc(0), error: [1002, 'client frames must be masked'] };
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; const big = buf.readBigUInt64BE(p); if (big > BigInt(maxPayload)) return { frames, rest: Buffer.alloc(0), error: [1009, 'message too big'] }; len = Number(big); p += 8; }
    if (len > maxPayload) return { frames, rest: Buffer.alloc(0), error: [1009, 'message too big'] };
    if (buf.length - p < 4 + len) break;
    const mask = buf.slice(p, p + 4); p += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[p + i] ^ mask[i & 3];
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.slice(off) };
}
function closePayload(code, reason) { const r = Buffer.from(String(reason || '').slice(0, 100)); const b = Buffer.alloc(2 + r.length); b.writeUInt16BE(code, 0); r.copy(b, 2); return b; }

// ─── Modbus TCP stream re-framing ─────────────────────────────────────────────
function takeAdus(buf) {
  const out = [];
  let off = 0;
  while (buf.length - off >= 7) {
    const proto = buf.readUInt16BE(off + 2), len = buf.readUInt16BE(off + 4);
    if (proto !== 0 || len < 2 || len > 254) return { adus: out, rest: Buffer.alloc(0), error: 'bad MBAP header from device' };
    if (buf.length - off < 6 + len) break;
    out.push(buf.slice(off, off + 6 + len)); off += 6 + len;
  }
  return { adus: out, rest: buf.slice(off) };
}
function exceptionAdu(req, code) {
  const out = Buffer.alloc(9);
  req.copy(out, 0, 0, 4);                 // transaction id + protocol id
  out.writeUInt16BE(3, 4); out[6] = req[6]; out[7] = (req[7] | 0x80) & 0xff; out[8] = code;
  return out;
}

// ─── bridge ──────────────────────────────────────────────────────────────────
function createBridge(opts) {
  opts = Object.assign({ listen: '127.0.0.1', port: 8502, allow: [], origins: [], anyOrigin: false, allowWrites: false, verbose: false, connectTimeoutMs: 5000 }, opts || {});
  const allowList = opts.allow.map((a) => (typeof a === 'string' ? parseAllow(a) : a));
  const log = (...a) => { if (opts.verbose) console.log('[bridge]', ...a); };
  const sessions = new Set(), upgraded = new Set();
  const stats = { sessions: 0, refused: 0, adusIn: 0, adusOut: 0, writesBlocked: 0 };

  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* keep '/' */ }
    if (pathname === '/health' || pathname === '/health/') { health(req, res); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('WTS Modbus bridge v' + BRIDGE_VERSION + ' ' + (opts.allowWrites ? '(writes ALLOWED)' : '(read-only)') + '\nConnect with ws://' + opts.listen + ':' + (server.address() || {}).port + '/modbus?host=<ip>&port=502\nHealth check: /health\n');
  });
  function healthInfo() {
    return { name: BRIDGE_NAME, version: BRIDGE_VERSION, readOnly: !opts.allowWrites, port: (server.address() || {}).port || opts.port,
      uptimeS: Math.round((Date.now() - startedAt) / 1000), allow: allowList.map((a) => a.spec || (a.host + ':' + a.port)) };
  }
  // GET /health (+ CORS preflight). Accepted origins get CORS headers; a request without an
  // Origin header (curl, the installers) gets the JSON without them; anything else a bare 403.
  function health(req, res) {
    const origin = req.headers.origin;
    const deny = (why) => {
      stats.refused++; log('health refused:', why);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' });
      res.end('Forbidden\n');
    };
    if (!hostHeaderOk(opts, req.headers.host)) { deny('host ' + req.headers.host); return; }
    if (origin !== undefined && !originOk(opts, origin)) { deny('origin ' + origin); return; }
    const head = { 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin !== undefined) head['Access-Control-Allow-Origin'] = String(origin);
    if (req.method === 'OPTIONS') {
      Object.assign(head, { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600', 'Content-Length': '0' });
      res.writeHead(204, head); res.end(); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { head.Allow = 'GET, OPTIONS'; res.writeHead(405, head); res.end(); return; }
    const body = JSON.stringify(healthInfo());
    head['Content-Type'] = 'application/json; charset=utf-8';
    head['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(200, head);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  server.on('upgrade', (req, socket) => {
    const fail = (code, text) => { try { socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\n\r\n'); } catch (e) {} socket.destroy(); stats.refused++; };
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { fail(400, 'Bad Request'); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') { fail(400, 'Bad Request'); return; }
    if (!originOk(opts, req.headers.origin)) { log('origin refused', req.headers.origin); fail(403, 'Forbidden'); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    upgraded.add(socket); socket.on('close', () => upgraded.delete(socket));
    const host = url.searchParams.get('host') || '', port = +(url.searchParams.get('port') || 502);
    startSession(socket, host, port);
  });

  function startSession(ws, host, port) {
    const S = { ws, tcp: null, open: false, closed: false, wsBuf: Buffer.alloc(0), tcpBuf: Buffer.alloc(0) };
    sessions.add(S); stats.sessions++;
    const sendText = (o) => { if (!S.closed) ws.write(encodeFrame(0x1, Buffer.from(JSON.stringify(o)))); };
    const sendBin = (b) => { if (!S.closed) ws.write(encodeFrame(0x2, b)); };
    function close(code, reason) {
      if (S.closed) return;
      try { ws.write(encodeFrame(0x8, closePayload(code, reason))); } catch (e) {}
      S.closed = true; sessions.delete(S);
      try { ws.end(); } catch (e) {}
      const kill = setTimeout(() => { try { ws.destroy(); } catch (e) {} }, 2000);   // peer did not finish the close handshake
      if (kill.unref) kill.unref();
      if (S.tcp) { try { S.tcp.destroy(); } catch (e) {} }
      log('session closed', code, reason || '');
    }
    S.close = close;
    if (!host || !(port >= 1 && port <= 65535) || !allowed(allowList, host, port)) {
      stats.refused++;
      sendText({ type: 'error', message: 'target ' + host + ':' + port + ' is not in the bridge allow-list (start the bridge with --allow ' + (host || '<ip>') + ':' + (port || 502) + ')' });
      close(1008, 'target not allowed');
      return;
    }
    const tcp = net.createConnection({ host, port });
    S.tcp = tcp;
    tcp.setNoDelay(true);
    tcp.setTimeout(opts.connectTimeoutMs, () => { if (!S.open) { sendText({ type: 'error', message: 'connect to ' + host + ':' + port + ' timed out' }); close(1011, 'connect timeout'); } });
    tcp.on('connect', () => { S.open = true; tcp.setTimeout(0); log('connected', host + ':' + port); sendText({ type: 'open', host, port, writes: !!opts.allowWrites }); });
    tcp.on('data', (d) => {
      S.tcpBuf = Buffer.concat([S.tcpBuf, d]);
      const r = takeAdus(S.tcpBuf);
      S.tcpBuf = r.rest;
      r.adus.forEach((a) => { stats.adusOut++; sendBin(a); });
      if (r.error) { sendText({ type: 'error', message: r.error }); close(1011, r.error); }
    });
    tcp.on('error', (e) => { sendText({ type: 'error', message: 'TCP ' + host + ':' + port + ': ' + e.message }); close(1011, 'tcp error'); });
    tcp.on('close', () => close(1000, 'device closed the connection'));
    ws.on('data', (d) => {
      S.wsBuf = Buffer.concat([S.wsBuf, d]);
      const r = decodeFrames(S.wsBuf, MAX_ADU);
      S.wsBuf = r.rest;
      for (const f of r.frames) {
        if (f.opcode === 0x8) { close(1000, 'client close'); return; }
        if (f.opcode === 0x9) { ws.write(encodeFrame(0xA, f.payload)); continue; }
        if (f.opcode === 0xA) continue;
        if (!f.fin || f.opcode === 0x0) { close(1003, 'fragmented messages are not supported'); return; }
        if (f.opcode !== 0x2) continue;                // text from the client is ignored
        onAdu(f.payload);
      }
      if (r.error) close(r.error[0], r.error[1]);
    });
    ws.on('error', () => close(1011, 'socket error'));
    ws.on('end', () => close(1000, 'client ended'));            // upgraded sockets are half-open capable
    ws.on('close', () => { S.closed = true; sessions.delete(S); if (S.tcp) S.tcp.destroy(); });
    function onAdu(a) {
      if (a.length < 8 || a.length > MAX_ADU || a.readUInt16BE(2) !== 0 || a.readUInt16BE(4) !== a.length - 6) { sendText({ type: 'error', message: 'malformed Modbus TCP ADU' }); return; }
      const fc = a[7];
      if (!READ_FCS.has(fc) && !(WRITE_FCS.has(fc) && opts.allowWrites)) {
        if (WRITE_FCS.has(fc)) stats.writesBlocked++;
        log('blocked FC' + fc);
        sendBin(exceptionAdu(a, 1));
        return;
      }
      if (!S.open) { sendText({ type: 'error', message: 'device connection is not open yet' }); return; }
      stats.adusIn++;
      S.tcp.write(a);
    }
  }

  return {
    server, stats, sessions, health: healthInfo,
    listen() { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.listen, () => { server.off('error', reject); resolve(server.address().port); }); }); },
    close() {
      sessions.forEach((s) => s.close(1001, 'bridge shutting down'));
      const p = new Promise((r) => server.close(() => r()));
      upgraded.forEach((sock) => sock.destroy());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();   // idle keep-alive HTTP sockets
      return p;
    },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { allow: [], origins: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(a + ' needs a value'); return argv[++i]; };
    if (a === '--allow') o.allow.push(v());
    else if (a === '--listen') o.listen = v();
    else if (a === '--port') o.port = +v();
    else if (a === '--origin') o.origins.push(v());
    else if (a === '--any-origin') o.anyOrigin = true;
    else if (a === '--allow-writes') o.allowWrites = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--config' || a === '-c') o.config = v();
    else if (a === '--version' || a === '-V') o.version = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error('unknown option ' + a);
  }
  return o;
}

// ─── config file ─────────────────────────────────────────────────────────────
const CONFIG_KEYS = { allow: 'array', port: 'port', listen: 'string', origins: 'array', anyOrigin: 'boolean', allowWrites: 'boolean', verbose: 'boolean' };
function validPort(p) { return typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 65535; }   // 0 = any free port (tests)
// JSON text of a config file → { options, warnings }. Keys starting with "_" are comments;
// other unknown keys are ignored with a warning (a newer file read by an older bridge).
function parseConfig(text, label) {
  label = label || 'config';
  let obj;
  try { obj = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error(label + ': not valid JSON (' + e.message + ')'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(label + ': expected a JSON object {…}');
  const options = {}, warnings = [];
  Object.keys(obj).forEach((k) => {
    const t = CONFIG_KEYS[k], v = obj[k];
    if (!t) { if (k[0] !== '_') warnings.push(label + ': unknown key "' + k + '" ignored'); return; }
    if (t === 'array') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(label + ': "' + k + '" must be a list of strings');
      options[k] = v.map((x) => x.trim()).filter(Boolean);
    } else if (t === 'port') {
      if (!validPort(v)) throw new Error(label + ': "port" must be a whole number 1-65535');
      options[k] = v;
    } else if (typeof v !== t) throw new Error(label + ': "' + k + '" must be a ' + t);
    else options[k] = v;
  });
  (options.allow || []).forEach((a) => { try { parseAllow(a); } catch (e) { throw new Error(label + ': ' + e.message.replace('--allow', 'allow entry')); } });
  return { options, warnings };
}
function loadConfigFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error('cannot read config file ' + file + ': ' + e.message); }
  return parseConfig(text, file);
}
function uniq(list) { const seen = new Set(); return list.filter((x) => { const k = String(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }
// Config file (with --config) + command line → { options, warnings }. Command-line port / listen
// win; the allow / origins lists are merged; --allow-writes / --any-origin / --verbose only switch on.
function resolveOptions(cli, readConfig) {
  cli = cli || {};
  let base = {}, warnings = [];
  if (cli.config) { const r = (readConfig || loadConfigFile)(cli.config); base = r.options || {}; warnings = r.warnings || []; }
  const o = {};
  ['port', 'listen', 'anyOrigin', 'allowWrites', 'verbose'].forEach((k) => { if (base[k] !== undefined) o[k] = base[k]; });
  o.allow = uniq((base.allow || []).concat(cli.allow || []).map((x) => String(x).trim()).filter(Boolean));
  o.origins = uniq((base.origins || []).concat(cli.origins || []));
  if (cli.port !== undefined) o.port = cli.port;
  if (cli.listen !== undefined) o.listen = cli.listen;
  ['anyOrigin', 'allowWrites', 'verbose'].forEach((k) => { if (cli[k]) o[k] = true; });
  if (o.port !== undefined && !validPort(o.port)) throw new Error('bad --port (1-65535)');
  if (o.listen !== undefined && (typeof o.listen !== 'string' || !o.listen)) throw new Error('bad --listen address');
  o.allow.forEach(parseAllow);
  return { options: o, warnings };
}

function helpText() {
  const src = fs.readFileSync(__filename, 'utf8').split('\n');
  const end = src.findIndex((l) => /^'use strict'/.test(l));
  return src.slice(1, end > 0 ? end : 40).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}
function main(argv) {
  let cli, r;
  try { cli = parseArgs(argv || process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (cli.version) { console.log(BRIDGE_VERSION); return; }
  if (cli.help) { console.log(helpText()); return; }
  try { r = resolveOptions(cli); } catch (e) { console.error('[bridge] ' + e.message); process.exit(2); }
  const o = r.options;
  r.warnings.forEach((w) => console.warn('[bridge] WARNING: ' + w));
  if (!o.allow.length) console.warn('[bridge] WARNING: no --allow targets — every connection will be refused. Example: --allow 192.168.1.10:502');
  if (o.listen && o.listen !== '127.0.0.1' && o.listen !== 'localhost' && o.listen !== '::1') console.warn('[bridge] WARNING: listening on ' + o.listen + ' — other machines on the network can use this bridge.');
  const b = createBridge(o);
  const listenHost = o.listen || '127.0.0.1';
  b.listen().then((port) => {
    console.log('[bridge] WTS Modbus bridge v' + BRIDGE_VERSION + ' listening on ws://' + listenHost + ':' + port + '/modbus  (' + (o.allowWrites ? 'writes ALLOWED' : 'read-only') + ')');
    console.log('[bridge] allowed targets: ' + (o.allow.join(', ') || '(none)'));
    console.log('[bridge] health check: http://' + (listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost) + ':' + port + '/health' + (cli.config ? '   (config: ' + cli.config + ')' : ''));
  }, (e) => {
    console.error('[bridge] cannot listen on ' + listenHost + ':' + (o.port || 8502) + ': ' + e.message + (e.code === 'EADDRINUSE' ? ' — another bridge (or program) already uses this port.' : ''));
    process.exit(1);
  });
  const stop = () => { b.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);     // launchd / systemd stop
}

module.exports = { BRIDGE_VERSION, createBridge, parseAllow, allowed, originOk, hostHeaderOk, encodeFrame, decodeFrames, takeAdus, exceptionAdu,
  parseArgs, parseConfig, loadConfigFile, resolveOptions, main };
if (require.main === module) main();
