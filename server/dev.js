#!/usr/bin/env node
'use strict';
// server/dev.js — the local dev runner: serves the functions on http://127.0.0.1:<port>/api/v1/* for tests and local runs
// (docs/ACCOUNTS-PLAN.md §13.1 "local"). Never a deployment target: it refuses WTS_ENV=production and binds to the loopback
// address only. The host's functions adapter (WP-OPS) calls the same core/app.js pipeline.
//
//   node server/dev.js                         WTS_ENV=local, port WTS_DEV_PORT (8787)
//   require('./dev').start({config, port, db}) → Promise<{port, url, close()}>   (port 0 = any free port)
//
// For a page served on localhost, set WTS_DEV_ORIGIN=http://localhost:8080 so its Origin is accepted (config.js).

const http = require('http');
const { loadConfig } = require('./core/config');
const { createApp } = require('./core/app');
const { bodyLimit } = require('./core/http');

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0; let over = false;
    req.on('data', (c) => { n += c.length; if (n > cap) { over = true; return; } chunks.push(c); });
    req.on('end', () => resolve(over ? { over: true, n } : { body: n ? Buffer.concat(chunks) : null }));
    req.on('error', reject);
  });
}

function start(o) {
  o = o || {};
  const config = o.config || loadConfig(Object.assign({ WTS_ENV: 'local' }, process.env));
  if (config.production) return Promise.reject(new Error('dev.js: refused with WTS_ENV=production'));
  const app = createApp({ config, db: o.db || null, mail: o.mail || null, now: o.now, log: o.log, handlers: o.handlers });
  const server = http.createServer(async (req, res) => {
    try {
      const got = await readBody(req, bodyLimit('blobPut'));
      const body = got.over ? Buffer.alloc(got.n > 0 ? Math.min(got.n, bodyLimit('blobPut') + 1) : 0) : got.body;
      const out = await app.handle({ method: req.method, url: req.url, headers: req.headers, body, remoteAddress: req.socket.remoteAddress });
      const headers = Object.assign({}, out.headers);
      if (out.cookies && out.cookies.length) headers['Set-Cookie'] = out.cookies;
      res.writeHead(out.status, headers);
      res.end(out.body == null ? undefined : out.body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"error":"server","message":"Server error."}');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port != null ? o.port : config.devPort, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, url: 'http://127.0.0.1:' + port, app, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then((s) => {
    const cfg = s.app.config;
    console.log('[dev] accounts API on ' + s.url + '/api/v1 (env ' + cfg.env + ', providers ' + JSON.stringify(cfg.providerSwitches()) + ')');
    cfg.warnings.forEach((w) => console.log('[dev] warning: ' + w));
  }).catch((e) => { console.error('[dev] ' + e.message); process.exit(1); });
}
