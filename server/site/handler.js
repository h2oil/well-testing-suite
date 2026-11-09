'use strict';
// server/site/handler.js — the functions-only site's entry adapter (docs/ACCOUNTS-PLAN.md §2, §3.2, §13.1, §13.6; WP-OPS).
// Wraps the shared pipeline (core/app.js) for the host's function runtime in the two common calling conventions:
//
//   createHandler({env, store?, mail?, db?, fetch?, log?, now?}) → {
//     handle(request: web Request, context?) → Promise<web Response>          (fetch-style runtimes; context.waitUntil, when the
//        runtime has it, keeps the after-response work — the queued mail — alive after the response is sent)
//     classic(event) → Promise<{statusCode, headers, multiValueHeaders, body, isBase64Encoded}>   (event-style runtimes)
//     invoke(req: {method, url, headers, body, remoteAddress}) → Promise<pipeline response + site headers>
//     state() → {ready, isolation, warnings, alerts}
//   }
//
// POST /api/v1/ops/selftest (site level, server/ops/remote-smoke.js; body {mailTo?}): after the proxy signature, the host and
// the ops HMAC (X-WTS-Ts, X-WTS-Nonce, X-WTS-Sig as for ops-daily; nonce once in 10 min through the database) it answers
// {ok, checks:{isolation, problems, keys, objects, db, requestRole, jobsRole, mailTransport, mail}}: requestRole = the
// current_user of a request transaction (wts_api), jobsRole = which role switch the jobs can use on this endpoint
// (session | local | refused — db/migrate.js probeRoleModes), mail = 'sent' | 'not requested' | 'no transport' | 'refused
// (isolation)' | the transport error kind. One test e-mail (core/mail.js notice_ops_test) per signed call; the address is
// never logged or echoed. Every other failure answers 404.
//
// Per instance, once: the configuration from the environment ONLY (core/config.js; secrets never in the bundle), the
// isolation check (site/isolation.js — on failure nothing but /health is served, every other route answers 503 paused,
// and "alert:" lines are logged), the database (WTS_DB_URL, created lazily on the first request that needs it), the blob
// store (the host store passed as `store`, else site/objects-loader.js: the binding module, else WTS_OBJECTS_DIR, else none
// → data routes answer 503 paused), the mail transport (site/adapters.js mailFromEnv: WTS_MAIL_PROVIDER, WTS_MAIL_API_URL,
// WTS_MAIL_CREDENTIAL; else none: mail waits in the outbox).
// Per request, in this order: the base path, then the proxy signature and the original host (else 404 — exactly as
// core/app.js, so a request sent straight to the functions site learns nothing, plan §2; in same-site mode, WTS_SITE_MODE=same,
// there is no proxy and the Host header itself must be the production host, so the platform address answers 404), then the isolation gate (503
// paused), the preview sign-in gate (503 paused) and the body cap measured BEFORE reading (Content-Length, 413), then the
// pipeline. A request id is generated here, passed to the pipeline as req.rid and returned as X-WTS-Request-Id; one
// access log line (site/monitor.js — request id, endpoint id, status, latency, IP prefix, and from res.meta the user id,
// provider, callback outcome and error code; nothing else); HSTS and Referrer-Policy on every API response. No timers.

const { loadConfig } = require('../core/config');
const { createApp } = require('../core/app');
const C = require('../core/contract');
const H = require('../core/http');
const { envelope } = require('../core/errors');
const { checkIsolation } = require('./isolation');
const M = require('./monitor');
const A = require('./adapters');
const { loadObjects } = require('./objects-loader');
const crypto = require('crypto');

const SITE_HEADERS = Object.freeze({
  'Strict-Transport-Security': 'max-age=31536000',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});
// the operator's signed self-test (not a contract endpoint; server/ops/remote-smoke.js): behind the proxy signature and the
// original host like every route, then the ops HMAC of core/http.js over method, path, timestamp and nonce (nonce once,
// shared store), else 404 — a caller without the key learns nothing
const SELFTEST_PATH = C.BASE + '/ops/selftest';
const EMAIL_RE = /^[^\s@<>",;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
// sign-in routes closed on a preview without the flag (§13.1)
const SIGNIN_IDS = new Set(['codeStart', 'codeVerify', 'passkeyOptions', 'passkeyVerify', 'oauthStart', 'oauthCallback', 'oauthFinish', 'emailRevert']);

function createHandler(o) {
  o = o || {};
  const env = Object.assign({}, o.env || process.env);
  const log = o.log || { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  const now = o.now || (() => Date.now());
  const config = loadConfig(env);
  const iso = checkIsolation(config, env);
  // standard "alert: <id> — text" lines for the host's log alerting (site/monitor.js LOG_ALERTS, RUNBOOK §5)
  config.alerts.forEach((a) => log.warn('alert: ' + (/pins|WTS_OIDC_MODE/i.test(a) ? 'pins' : 'config') + ' — ' + a));
  iso.problems.forEach((p) => log.warn('alert: isolation — ' + p));
  config.warnings.concat(iso.warnings).forEach((w) => log.info('config: ' + w));

  let db = o.db || null;
  function lazyDb() {
    if (db || !config.secrets.dbUrl || config.dbRole === 'invalid') return db;
    db = require('../core/db').createDb(config.secrets.dbUrl, { max: 2, idleTimeout: 10, role: config.dbRole || undefined });
    return db;
  }
  let objects = null;
  if (o.store) objects = A.hostObjects(o.store);
  else {
    try { objects = loadObjects(env).objects; } catch (e) { log.warn('alert: objects — ' + M.redactLine(e && e.message)); }
  }
  let mail = o.mail || null;
  if (!mail && iso.signinAllowed) {
    try { mail = A.mailFromEnv(env, { from: config.mailFrom, fetch: o.fetch }); } catch (e) { log.warn('config: mail transport — ' + e.message); }
  }
  let app = null;
  // the runtime's waitUntil of the request in progress (function instances serve one request at a time)
  let waitUntil = null;
  const background = (p) => { if (typeof waitUntil === 'function') { try { waitUntil(p); } catch (e) { /* the promise still runs */ } } };
  function getApp() {
    if (!app) app = createApp({ config, db: lazyDb(), mail, objects, now, background, log: { info: (m) => log.info(M.redactLine(m)), warn: (m) => log.warn(M.redactLine(m)) } });
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

  let keysReady = null;
  async function selftest(req) {
    const nonces = config.production ? (lazyDb() ? H.dbNonceStore(lazyDb()) : null) : (o.opsNonces || (lazyDb() ? H.dbNonceStore(lazyDb()) : H.memoryNonceStore()));
    if (!(await H.verifyOps(req, SELFTEST_PATH, config, now(), nonces))) return plain(404, 'not_found');
    let body = {};
    try { body = req.body && req.body.length ? JSON.parse(req.body.toString('utf8')) : {}; } catch (e) { return plain(400, 'bad_request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return plain(400, 'bad_request');
    const mailTo = body.mailTo == null ? null : String(body.mailTo);
    if (mailTo !== null && (mailTo.length > 254 || !EMAIL_RE.test(mailTo))) return plain(400, 'bad_request');
    const checks = { isolation: iso.ok, problems: iso.problems.slice(), keys: false, objects: !!objects, db: false,
      requestRole: null, jobsRole: 'skipped', mailTransport: mail ? (mail.kind || 'custom') : null, mail: 'not requested' };
    if (keysReady === null) { try { keysReady = !!require('../core/keys').createKeys(config).ready; } catch (e) { keysReady = false; } }
    checks.keys = keysReady;
    const d = lazyDb();
    if (d) {
      try { checks.db = (await d.ping()) === true; } catch (e) { checks.db = false; }
      try { checks.requestRole = (await d.anon((tx) => tx`select current_user as u`))[0].u; } catch (e) { checks.requestRole = false; }
    }
    const jobsUrl = env.WTS_JOBS_DB_URL || env.NETLIFY_DB_URL || '';
    if (jobsUrl && o.probeRoleModes !== false) {
      try {
        const p = await (o.probeRoleModes || require('../db/migrate').probeRoleModes)(jobsUrl, 'wts_jobs');
        checks.jobsRole = p.session === true ? 'session' : (p.local === true ? 'local' : 'refused');
      } catch (e) { checks.jobsRole = 'refused'; }
    }
    if (mailTo !== null) {
      if (!iso.ok || !iso.signinAllowed) checks.mail = 'refused (isolation)';
      else if (!mail) checks.mail = 'no transport';
      else {
        const at = new Date(now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        try { await mail.send(require('../core/mail').compose({ to: mailTo, template: 'notice_ops_test', params: { at } })); checks.mail = 'sent'; }
        catch (e) { checks.mail = (e && /^mail_[a-z]+$/.test(String(e.code))) ? e.code : 'mail_failed'; }
      }
    }
    const ok = checks.isolation && checks.keys && checks.db && checks.requestRole === 'wts_api' && checks.jobsRole !== 'refused'
      && (mailTo === null || checks.mail === 'sent');
    return withSite({ status: 200, headers: Object.assign({}, H.COMMON_HEADERS, { 'Content-Type': 'application/json' }), cookies: [], body: JSON.stringify({ ok, checks }) });
  }

  async function invoke(req) {
    const t0 = now();
    const rid = crypto.randomBytes(9).toString('base64url');
    let route = 'unmatched'; let res;
    try {
      const { path: full } = H.splitUrl(req.url || '/');
      const sub = full === C.BASE || full.indexOf(C.BASE + '/') === 0 ? full.slice(C.BASE.length) || '/' : null;
      const m = sub !== null ? C.matchRoute(req.method, sub) : null;
      if (m) route = m.endpoint.id;
      // plan §2: without the proxy signature and the production host nothing but 404 — before any other gate
      if (sub === null || !H.proxyOk(req, config) || !H.hostAllowed(req, config)) res = plain(404, 'not_found');
      else if (full === SELFTEST_PATH) { route = 'opsSelftest'; res = req.method === 'POST' && !req.tooLarge ? await selftest(req) : plain(404, 'not_found'); }
      else if (!iso.ok && route !== 'health') res = plain(503, 'paused');
      else if (!iso.signinAllowed && SIGNIN_IDS.has(route)) res = plain(503, 'paused');
      else if (req.tooLarge) res = plain(413, 'too_large', { limit: H.bodyLimit(route) });
      else res = withSite(await getApp().handle(Object.assign({}, req, { rid, meta: {} })));
    } catch (e) {
      log.warn('alert: adapter — ' + M.redactLine(e && e.message));
      res = plain(500, 'server');
    }
    const meta = res.meta || {};
    res = Object.assign({}, res, { headers: Object.assign({}, res.headers, { 'X-WTS-Request-Id': rid }) });
    delete res.meta;
    log.info(M.accessLine({ rid, route, status: res.status, ms: now() - t0, ip: H.clientIp(req, config),
      uid: meta.uid, provider: meta.provider, outcome: meta.outcome, err: meta.error }));
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
    // same-site mode: the platform gives the function the public URL; when its Host header is not passed on, the URL's host
    // (the address the platform routed, never a client forwarding header) stands in for it — hostAllowed still demands the
    // exact production host
    if (config.sameSite && !headers.host) headers.host = u.host;
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
    waitUntil = context && typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : null;
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

module.exports = { createHandler, SITE_HEADERS, SIGNIN_IDS, SELFTEST_PATH };
