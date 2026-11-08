'use strict';
// server/site/handler.js — the functions-only site's entry adapter (docs/ACCOUNTS-PLAN.md §2, §3.2, §13.1, §13.6; WP-OPS).
// Wraps the shared pipeline (core/app.js) for the host's function runtime in the two common calling conventions:
//
//   createHandler({env, store?, mail?, db?, fetch?, log?, now?}) → {
//     handle(request: web Request) → Promise<web Response>          (fetch-style runtimes)
//     classic(event) → Promise<{statusCode, headers, multiValueHeaders, body, isBase64Encoded}>   (event-style runtimes)
//     invoke(req: {method, url, headers, body, remoteAddress}) → Promise<pipeline response + site headers>
//     state() → {ready, isolation, warnings, alerts}
//   }
//
// Per instance, once: the configuration from the environment ONLY (core/config.js; secrets never in the bundle), the
// isolation check (site/isolation.js — on failure nothing but /health is served, every other route answers 503 paused,
// and "alert:" lines are logged), the database (WTS_DB_URL, created lazily on the first request that needs it), the blob
// store (the host store passed as `store`, else WTS_OBJECTS_DIR, else none → data routes answer 503 paused), the mail
// transport (WTS_MAIL_API_URL + WTS_MAIL_CREDENTIAL, else none: mail waits in the outbox).
// Per request: the body cap BEFORE reading (Content-Length) and after; one access log line (site/monitor.js — endpoint id,
// status, latency, IP prefix; nothing else); HSTS and Referrer-Policy added to every API response; on a preview without
// WTS_PREVIEW_SIGNIN=1 every sign-in route answers 503 paused. No timers.

const { loadConfig } = require('../core/config');
const { createApp } = require('../core/app');
const C = require('../core/contract');
const H = require('../core/http');
const { envelope } = require('../core/errors');
const { checkIsolation } = require('./isolation');
const M = require('./monitor');
const A = require('./adapters');

const SITE_HEADERS = Object.freeze({
  'Strict-Transport-Security': 'max-age=31536000',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});
// sign-in routes closed on a preview without the flag (§13.1)
const SIGNIN_IDS = new Set(['codeStart', 'codeVerify', 'passkeyOptions', 'passkeyVerify', 'oauthStart', 'oauthCallback', 'oauthFinish']);

function createHandler(o) {
  o = o || {};
  const env = Object.assign({}, o.env || process.env);
  const log = o.log || { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  const now = o.now || (() => Date.now());
  const config = loadConfig(env);
  const iso = checkIsolation(config, env);
  config.alerts.forEach((a) => log.warn('alert: config — ' + a));
  iso.problems.forEach((p) => log.warn('alert: isolation — ' + p));
  config.warnings.concat(iso.warnings).forEach((w) => log.info('config: ' + w));

  let db = o.db || null;
  function lazyDb() {
    if (db || !config.secrets.dbUrl) return db;
    db = require('../core/db').createDb(config.secrets.dbUrl, { max: 2 });
    return db;
  }
  let objects = null;
  if (o.store) objects = A.hostObjects(o.store);
  else if (env.WTS_OBJECTS_DIR) {
    try { objects = require('../core/objects').fsObjects(env.WTS_OBJECTS_DIR); } catch (e) { log.warn('config: WTS_OBJECTS_DIR set but no folder store in this build'); }
  }
  let mail = o.mail || null;
  if (!mail && env.WTS_MAIL_API_URL && env.WTS_MAIL_CREDENTIAL && iso.signinAllowed) {
    try { mail = A.httpMail({ url: env.WTS_MAIL_API_URL, credential: env.WTS_MAIL_CREDENTIAL, from: config.mailFrom, fetch: o.fetch }); } catch (e) { log.warn('config: mail transport — ' + e.message); }
  }
  let app = null;
  function getApp() {
    if (!app) app = createApp({ config, db: lazyDb(), mail, objects, now, log: { info: (m) => log.info(M.redactLine(m)), warn: (m) => log.warn(M.redactLine(m)) } });
    return app;
  }

  function withSite(res) {
    const headers = Object.assign({}, res.headers);
    Object.keys(SITE_HEADERS).forEach((k) => { if (headers[k] === undefined) headers[k] = SITE_HEADERS[k]; });
    return Object.assign({}, res, { headers });
  }
  function plain(status, code, extra) {
    const e = code === 'server' ? { status: 500, body: { error: 'server', message: 'Server error.' } } : envelope(code, extra);
    return withSite({ status: status || e.status, headers: Object.assign({}, H.COMMON_HEADERS, { 'Content-Type': 'application/json' }), cookies: [], body: JSON.stringify(e.body) });
  }

  async function invoke(req) {
    const t0 = now();
    let route = 'unmatched'; let res;
    try {
      const { path: full } = H.splitUrl(req.url || '/');
      const sub = full.indexOf(C.BASE) === 0 ? full.slice(C.BASE.length) || '/' : null;
      const m = sub !== null ? C.matchRoute(req.method, sub) : null;
      if (m) route = m.endpoint.id;
      if (!iso.ok && route !== 'health') res = plain(503, 'paused');
      else if (!iso.signinAllowed && SIGNIN_IDS.has(route)) res = plain(503, 'paused');
      else if (req.tooLarge) res = plain(413, 'too_large', { limit: H.bodyLimit(route) });
      else res = withSite(await getApp().handle(req));
    } catch (e) {
      log.warn('alert: adapter error — ' + M.redactLine(e && e.message));
      res = plain(500, 'server');
    }
    log.info(M.accessLine({ route, status: res.status, ms: now() - t0, ip: H.clientIp(req, config) }));
    return res;
  }

  function lowerHeaders(h) {
    const out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
    else Object.keys(h).forEach((k) => { out[k.toLowerCase()] = h[k]; });
    return out;
  }
  function capFor(method, url) {
    const { path: full } = H.splitUrl(url || '/');
    const m = full.indexOf(C.BASE) === 0 ? C.matchRoute(method, full.slice(C.BASE.length) || '/') : null;
    return H.bodyLimit(m ? m.endpoint.id : 'default');
  }

  async function handle(request, context) {
    const u = new URL(request.url);
    const headers = lowerHeaders(request.headers);
    const url = u.pathname + u.search;
    const cap = capFor(request.method, url);
    const declared = Number(headers['content-length'] || 0);
    let body = null; let tooLarge = false;
    if (declared > cap) tooLarge = true;
    else if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      const buf = Buffer.from(await request.arrayBuffer());
      if (buf.length > cap) tooLarge = true; else body = buf.length ? buf : null;
    }
    const ip = (context && (context.ip || (context.clientAddress))) || null;
    const res = await invoke({ method: request.method, url, headers, body, remoteAddress: ip, tooLarge });
    const out = new Headers();
    Object.keys(res.headers).forEach((k) => out.set(k, String(res.headers[k])));
    (res.cookies || []).forEach((c) => out.append('Set-Cookie', c));
    return new Response(res.body == null ? null : res.body, { status: res.status, headers: out });
  }

  async function classic(event) {
    event = event || {};
    const method = String(event.httpMethod || event.method || 'GET').toUpperCase();
    const qs = event.rawQuery ? '?' + event.rawQuery : (event.queryStringParameters && Object.keys(event.queryStringParameters).length
      ? '?' + new URLSearchParams(event.queryStringParameters).toString() : '');
    const url = String(event.path || event.rawPath || '/') + qs;
    const headers = lowerHeaders(event.headers);
    const cap = capFor(method, url);
    let body = null; let tooLarge = false;
    if (event.body != null && event.body !== '') {
      const buf = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
      if (buf.length > cap) tooLarge = true; else body = buf;
    }
    const res = await invoke({ method, url, headers, body, remoteAddress: (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || null, tooLarge });
    const isBin = Buffer.isBuffer(res.body);
    const hdrs = Object.assign({}, res.headers);
    return {
      statusCode: res.status,
      headers: hdrs,
      multiValueHeaders: res.cookies && res.cookies.length ? { 'Set-Cookie': res.cookies } : {},
      body: res.body == null ? '' : (isBin ? res.body.toString('base64') : String(res.body)),
      isBase64Encoded: isBin,
    };
  }

  return {
    handle, classic, invoke,
    state: () => ({ ready: iso.ok, isolation: iso, warnings: config.warnings.slice(), alerts: config.alerts.slice(), objects: !!objects, mail: !!mail }),
    config,
  };
}

module.exports = { createHandler, SITE_HEADERS, SIGNIN_IDS };
