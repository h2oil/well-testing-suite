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
//     (Chrome Private Network Access). A refused request gets 403 {"error":"origin"|"host"}
//     (with Access-Control-Allow-Origin echoed, so the page can tell a refusal from "no
//     bridge"; nothing else is in that body). Host names other than localhost / an IP literal /
//     --listen are refused (DNS rebinding) unless the request carries an accepted Origin.
//   • GET / → a small HTML status page for people (version, allowed devices, read-only state,
//     how to uninstall); same Origin / Host rules as /health, no scripts.
//
// Security defaults: listens on 127.0.0.1 only; any device IP / port is reachable unless you
// restrict it with --allow targets (v1.2.0; before, nothing was reachable until allowed); browser origins limited to http(s)://localhost / 127.0.0.1 / [::1], the app's
// capacitor origin and the app's web origin (pb-handbook.com) unless --origin or --any-origin
// is given. "Origin: null" (sandboxed iframes, data: URLs, saved file:// copies) is refused
// unless allowed explicitly with --origin null, because any web site can send it. Requests
// without an Origin header (curl, scripts; never a browser page) are accepted. ADU ≤ 260 bytes.
//
// Usage:  node modbus-bridge.js                (any device)
//         node modbus-bridge.js --allow 192.168.1.10:502 [--allow 10.0.0.0/24:502] [--allow 'host:*'] [--allow-any]
//                               [--listen 127.0.0.1] [--port 8502] [--origin https://example.com]
//                               [--any-origin] [--allow-writes] [--verbose]
//                               [--config bridge-config.json] [--version] [--help]
//         (quote targets with * or [ ] — zsh refuses an unmatched glob; IPv6: '[fd00::10]:502';
//          --origin null accepts a saved file:// copy of the app)
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

const BRIDGE_VERSION = '1.2.0';
const BRIDGE_NAME = 'wts-modbus-bridge';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';     // RFC 6455 §1.3
const MAX_ADU = 260;
const READ_FCS = new Set([1, 2, 3, 4]);
const WRITE_FCS = new Set([5, 6, 15, 16]);
// "null" and file:// are deliberately NOT here: any web page can send "Origin: null" (a
// sandboxed iframe or a data: URL), so a saved copy of the app needs --origin null.
const DEFAULT_ORIGINS = [/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i, /^https:\/\/(www\.)?pb-handbook\.com$/i,
  /^capacitor:\/\/localhost$/i];

// ─── allow-list ──────────────────────────────────────────────────────────────
// entry: "host:port" | "host:*" | "a.b.c.d/nn:port" (IPv4 CIDR) | "*:port" | "*:*" (any device).
// An empty allow-list means "*:*" — any device IP / port (the default since v1.2.0). List
// specific targets to lock the bridge down to them.
function parseAllow(spec) {
  const s = String(spec).trim();
  const i = s.lastIndexOf(':');
  if (i <= 0) throw new Error('--allow needs host:port, got ' + spec);
  const host = s.slice(0, i).replace(/^\[|\]$/g, ''), port = s.slice(i + 1);
  if (host === '*') {
    if (port !== '*' && !(/^\d{1,5}$/.test(port) && +port >= 1 && +port <= 65535)) throw new Error('bad port in --allow ' + spec);
    const p = port === '*' ? '*' : +port;
    return { host: '*', port: p, cidr: null, spec: '*:' + p };
  }
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
    if (a.host === '*') return true;
    if (a.cidr) {
      const ip = ip4(host); if (ip == null || a.cidr.base == null) return false;
      const mask = a.cidr.bits === 0 ? 0 : (0xFFFFFFFF << (32 - a.cidr.bits)) >>> 0;
      return (ip & mask) === (a.cidr.base & mask);
    }
    return a.host === host;
  });
}
// origin = the Origin request header. undefined (no header) = not a browser page (curl, a
// script, Node's WebSocket): accepted. "null" only with --origin null / --any-origin.
function originOk(opts, origin) {
  if (origin === undefined) return true;
  if (opts.anyOrigin) return true;
  const o = String(origin);
  if ((opts.origins || []).some((x) => String(x).toLowerCase() === o.toLowerCase())) return true;
  return DEFAULT_ORIGINS.some((re) => re.test(o));
}
// /health answers only requests addressed to localhost, an IP literal or the --listen name,
// so a web page cannot read it through a DNS-rebound host name (such a page sends no Origin on
// its same-origin GET, or its own origin, which is refused).
function hostHeaderOk(opts, hostHeader) {
  if (hostHeader == null || hostHeader === '') return true;          // HTTP/1.0 client
  let h = String(hostHeader).trim().toLowerCase();
  if (h[0] === '[') { const j = h.indexOf(']'); return j > 0 && h.slice(1, j).indexOf(':') >= 0; }   // IPv6 literal
  const j = h.lastIndexOf(':'); if (j >= 0) h = h.slice(0, j);
  if (h === 'localhost' || /\.localhost$/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) && ip4(h) != null) return true;
  return !!(opts && opts.listen && h === String(opts.listen).toLowerCase());
}
// Why a /health request is refused: 'origin', 'host' or null (accepted). A request with an
// accepted, non-null Origin may use any Host name (e.g. ws://bridge-pc.local:8502 from the
// app): a DNS-rebinding page cannot send such an Origin.
function healthRefusal(opts, origin, hostHeader) {
  if (!originOk(opts, origin)) return 'origin';
  if (hostHeaderOk(opts, hostHeader)) return null;
  return origin !== undefined && String(origin) !== 'null' ? null : 'host';
}
// "localhost" can resolve to ::1 first (macOS, Windows; Node ≥ 17 keeps the resolver order),
// while the installers and the app use 127.0.0.1 — so listen on 127.0.0.1.
function normListen(listen) { return typeof listen === 'string' && listen.toLowerCase() === 'localhost' ? '127.0.0.1' : listen; }

// ─── status page (GET /) ─────────────────────────────────────────────────────
function htmlEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function uptimeText(s) {
  s = Math.max(0, Math.round(+s || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? d + ' d ' + h + ' h' : h ? h + ' h ' + m + ' min' : m ? m + ' min' : s + ' s';
}
const DEFAULT_UNINSTALL = [
  'Windows (installed with WTS-Modbus-Bridge-Setup.exe): Settings → Apps → Installed apps → "WTS Modbus Bridge" → Uninstall, or Start menu → "Uninstall WTS Modbus Bridge".',
  'Windows (installed with install-windows.ps1): powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\\WTS Modbus Bridge\\install-windows.ps1" -Uninstall',
  'macOS: bash "$HOME/Library/Application Support/WTS Modbus Bridge/install.sh" --uninstall',
  'Linux: bash "${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh" --uninstall'];
// info = the /health object; o = { listen, configFile, uninstall: string | [strings] }
function statusPageHtml(info, o) {
  info = info || {}; o = o || {};
  const allow = Array.isArray(info.allow) ? info.allow.map(String) : [];
  const any = !allow.length || allow.some((a) => /^\*:\*$/.test(a.trim()));
  const host = !o.listen || o.listen === '0.0.0.0' ? '127.0.0.1' : String(o.listen);
  const url = 'ws://' + (host.indexOf(':') >= 0 ? '[' + host + ']' : host) + ':' + info.port;
  const uninstall = o.uninstall ? [].concat(o.uninstall) : DEFAULT_UNINSTALL;
  const row = (k, v) => '<tr><th>' + htmlEsc(k) + '</th><td>' + v + '</td></tr>';
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><title>WTS Modbus Bridge — running</title><style>' +
    'body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1f2328;background:#fff}' +
    '@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}th{color:#9198a1!important}code{background:#161b22!important}}' +
    'h1{font-size:22px;color:#1a7f37;margin:0 0 8px}p{margin:8px 0}table{border-collapse:collapse;margin:12px 0;width:100%}' +
    'th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.25)}th{width:34%;font-weight:600;color:#59636e}' +
    'code{font:13px ui-monospace,Consolas,monospace;background:#f6f8fa;padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}' +
    '.next{border-left:4px solid #1a7f37;padding:8px 12px;margin:14px 0;background:rgba(26,127,55,.08)}ul{padding-left:20px}li{margin:4px 0}small{color:#8b949e}' +
    '</style></head><body>' +
    '<h1>✓ WTS Modbus Bridge v' + htmlEsc(info.version) + ' is running on this PC</h1>' +
    '<div class="next"><b>Next:</b> go back to the Well Testing Suite (Modbus Config page) and press <b>Check bridge</b>. ' +
    'Devices use the transport "Modbus TCP via WebSocket bridge" with the bridge URL <code>' + htmlEsc(url) + '</code>.</div>' +
    '<table>' +
    row('Bridge URL', '<code>' + htmlEsc(url) + '</code>' + (host === '127.0.0.1' || host === '::1' ? ' (this computer only)' : ' (other computers on the network can use it)')) +
    row('Allowed devices', any ? 'Any device IP address / port' + (allow.length > 1 ? ' (' + htmlEsc(allow.join(', ')) + ')' : '') : htmlEsc(allow.join(', '))) +
    row('Modbus writes', info.readOnly === false ? '<b>Allowed</b> (FC 05 / 06 / 15 / 16 are forwarded)' : 'Refused — read-only (the bridge answers write requests with exception 01)') +
    row('Running for', htmlEsc(uptimeText(info.uptimeS))) +
    (o.configFile ? row('Settings', '<code>' + htmlEsc(o.configFile) + '</code> (restart the bridge after editing)') : '') +
    row('Health check', '<code>http://' + htmlEsc(host.indexOf(':') >= 0 ? '[' + host + ']' : host) + ':' + htmlEsc(info.port) + '/health</code>') +
    '</table>' +
    '<p><b>Uninstall</b></p><ul>' + uninstall.map((u) => '<li>' + htmlEsc(u) + '</li>').join('') + '</ul>' +
    '<p><small>' + htmlEsc(info.name) + ' — WebSocket ↔ Modbus TCP bridge for the Well Testing Suite. This page refreshes when you reload it.</small></p>' +
    '</body></html>\n';
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
  opts.listen = normListen(opts.listen) || '127.0.0.1';
  const allowList = (opts.allow && opts.allow.length ? opts.allow : ['*:*']).map((a) => (typeof a === 'string' ? parseAllow(a) : a));
  const log = (...a) => { if (opts.verbose) console.log('[bridge]', ...a); };
  const sessions = new Set(), upgraded = new Set();
  const stats = { sessions: 0, refused: 0, adusIn: 0, adusOut: 0, writesBlocked: 0 };

  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* keep '/' */ }
    if (pathname === '/health' || pathname === '/health/') { health(req, res); return; }
    if (pathname === '/' || pathname === '/status' || pathname === '/index.html') { statusPage(req, res); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('WTS Modbus bridge v' + BRIDGE_VERSION + ' ' + (opts.allowWrites ? '(writes ALLOWED)' : '(read-only)') + '\nConnect with ws://' + opts.listen + ':' + (server.address() || {}).port + '/modbus?host=<ip>&port=502\nHealth check: /health\n');
  });
  function healthInfo() {
    return { name: BRIDGE_NAME, version: BRIDGE_VERSION, readOnly: !opts.allowWrites, port: (server.address() || {}).port || opts.port,
      uptimeS: Math.round((Date.now() - startedAt) / 1000), allow: allowList.map((a) => a.spec || (a.host + ':' + a.port)) };
  }
  // GET /health (+ CORS preflight). Accepted origins get CORS headers; a request without an
  // Origin header (curl, the installers) gets the JSON without them. A refused request gets
  // 403 {"error":"origin"|"host"} — with Access-Control-Allow-Origin echoed so the app can show
  // why (a browser turns a 403 without it into "network error" = "is the bridge running?").
  // The refusal carries no version / allow-list, and a refused preflight is never approved
  // (no Access-Control-Allow-Private-Network).
  function health(req, res) {
    const origin = req.headers.origin;
    const why = healthRefusal(opts, origin, req.headers.host);
    if (why) {
      stats.refused++; log('health refused:', why, why === 'host' ? req.headers.host : origin);
      const body = JSON.stringify({ error: why });
      const h403 = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin', 'Content-Length': Buffer.byteLength(body) };
      if (origin !== undefined) h403['Access-Control-Allow-Origin'] = String(origin);
      res.writeHead(403, h403);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
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
  // GET / → a small HTML status page for people (the Windows installer opens it in the browser).
  // Same Origin / Host rules as /health; no scripts (CSP), everything escaped.
  function statusPage(req, res) {
    const why = healthRefusal(opts, req.headers.origin, req.headers.host);
    const head = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
    if (why) { head['Content-Type'] = 'text/plain; charset=utf-8'; res.writeHead(403, head); res.end('Forbidden (' + why + ')\n'); stats.refused++; return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { head.Allow = 'GET'; res.writeHead(405, head); res.end(); return; }
    const body = statusPageHtml(healthInfo(), { listen: opts.listen, configFile: opts.configFile, uninstall: opts.uninstallHint });
    head['Content-Type'] = 'text/html; charset=utf-8';
    head['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
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
    else if (a === '--allow-any') o.allow.push('*:*');
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
  if (o.listen !== undefined) o.listen = normListen(o.listen);
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
  if (!o.allow.length || o.allow.some((a) => /^\*:/.test(String(a).trim()))) console.log('[bridge] any device IP is allowed' + (o.allow.length ? '' : ' (default; list --allow <ip>:<port> targets to restrict)') + '. The bridge still listens on this PC only' + (o.allowWrites ? '' : ' and refuses writes') + '.');
  if ((o.origins || []).some((x) => String(x).toLowerCase() === 'null') || o.anyOrigin) console.warn('[bridge] WARNING: ' + (o.anyOrigin ? 'any page origin is accepted' : 'pages with "Origin: null" (saved copies, but also sandboxed frames of any web site) are accepted') + ' — only do this on a PC that is not used for general web browsing.');
  if (o.listen && o.listen !== '127.0.0.1' && o.listen !== '::1') console.warn('[bridge] WARNING: listening on ' + o.listen + ' — other machines on the network can use this bridge.');
  const b = createBridge(Object.assign({}, o, { configFile: cli.config ? require('path').resolve(cli.config) : undefined }));
  const listenHost = o.listen || '127.0.0.1';
  b.listen().then((port) => {
    console.log('[bridge] WTS Modbus bridge v' + BRIDGE_VERSION + ' listening on ws://' + listenHost + ':' + port + '/modbus  (' + (o.allowWrites ? 'writes ALLOWED' : 'read-only') + ')');
    console.log('[bridge] allowed targets: ' + (o.allow.join(', ') || '*:* (any device)'));
    console.log('[bridge] health check: http://' + (listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost) + ':' + port + '/health' + (cli.config ? '   (config: ' + cli.config + ')' : ''));
  }, (e) => {
    console.error('[bridge] cannot listen on ' + listenHost + ':' + (o.port || 8502) + ': ' + e.message + (e.code === 'EADDRINUSE' ? ' — another bridge (or program) already uses this port.' : ''));
    process.exit(1);
  });
  const stop = () => { b.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);     // launchd / systemd stop
}

module.exports = { BRIDGE_VERSION, BRIDGE_NAME, createBridge, statusPageHtml, htmlEsc, parseAllow, allowed, originOk, hostHeaderOk, healthRefusal, normListen, encodeFrame, decodeFrames, takeAdus, exceptionAdu,
  parseArgs, parseConfig, loadConfigFile, resolveOptions, main };
if (require.main === module) main();
