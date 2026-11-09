'use strict';
// server/site/netlify.js — the Netlify bindings of the functions-only site (v4.0; docs/ACCOUNTS-PLAN.md §2, §3.5, §13;
// server/README.md "Hosting", server/RUNBOOK.md "Switch it on with Netlify"). The function files in netlify/functions/*.mjs
// are one line each around the factories here, so everything below is testable without the platform (test/netlify.test.js).
//
//   FUNCTIONS                         the six functions, their files and their in-source config (the .mjs files must match)
//   platformEnv(env) → env            the request environment on the platform (see "Defaults")
//   apiFunction(deps?) → (Request, context) → Response            /api/v1/* through site/handler.js (one handler per instance)
//   scheduledFunction(name, deps?)    ops-purge runs the short jobs itself; ops-daily and weekly-export only KICK their
//                                     background function (a scheduled function has 30 s, a background function 15 min)
//   backgroundFunction(name, deps?)   ops-daily-background (core/jobs.js runDaily) and weekly-export-background (COPY
//                                     export sealed to the owner's public key into the 'wts-exports' store)
//   kickRequest(name, base, keyB64, nowMs) / verifyKick(req, name, env, deps)   the signed kick (HMAC of core/http.js)
//   runJobs(o) / runExport(o)         the job bodies (deps injectable: env, getStore, createDb, fetch, log, now)
//
// Defaults (platformEnv; every one can be overridden in the site's environment variables, except the database role):
//   WTS_DB_URL       ← NETLIFY_DB_URL (the platform's ONE database login), and WTS_DB_ROLE = wts_api ALWAYS: every request
//                      transaction switches to wts_api (core/db.js), so forced row-level security applies as for a wts_api
//                      login. The jobs use wts_jobs, the export wts_backup, both as a connection start-up role.
//   WTS_MIN_CLIENT   4.0 (the first release with accounts; X-WTS-App below it gets 426 upgrade on project writes)
//   WTS_VERSION      the server package version (server/package.json, set by the release)
//   WTS_HOST_HEADER  x-wts-host — sent by the main site's proxy rule (RUNBOOK); trusted only with a valid proxy signature
//   WTS_CLIENT_IP_HEADER  x-nf-client-connection-ip — the platform's client-address header (RUNBOOK step "check the address")
// Blobs: every store in eu-central-1 with strong consistency (site/netlify-blobs.js).

const crypto = require('crypto');
const PKG = require('../package.json');

const FUNCTIONS = Object.freeze({
  api: { file: 'api.mjs', config: { path: '/api/v1/*' } },
  'ops-purge': { file: 'ops-purge.mjs', config: { schedule: '23 * * * *' } },
  'ops-daily': { file: 'ops-daily.mjs', config: { schedule: '17 3 * * *' }, kicks: 'ops-daily-background' },
  'ops-daily-background': { file: 'ops-daily-background.mjs', config: null },
  'weekly-export': { file: 'weekly-export.mjs', config: { schedule: '41 4 * * 0' }, kicks: 'weekly-export-background' },
  'weekly-export-background': { file: 'weekly-export-background.mjs', config: null },
});
const PURGE_STEPS = ['purge', 'mail'];
const EXPORT_MAX_AGE_DAYS = 8;
const DEFAULTS = Object.freeze({
  WTS_MIN_CLIENT: '4.0',
  WTS_HOST_HEADER: 'x-wts-host',
  WTS_CLIENT_IP_HEADER: 'x-nf-client-connection-ip',
});

function platformEnv(env) {
  const out = Object.assign({}, env || process.env);
  if (!out.WTS_DB_URL && out.NETLIFY_DB_URL) out.WTS_DB_URL = out.NETLIFY_DB_URL;
  out.WTS_DB_ROLE = 'wts_api';
  Object.keys(DEFAULTS).forEach((k) => { if (out[k] == null || out[k] === '') out[k] = DEFAULTS[k]; });
  if (!out.WTS_VERSION) out.WTS_VERSION = PKG.version;
  return out;
}
function dbUrl(env, specific) { return (specific && env[specific]) || env.NETLIFY_DB_URL || ''; }
function defaultLog() {
  const M = require('./monitor');
  return { info: (m) => console.log(M.redactLine(m)), warn: (m) => console.warn(M.redactLine(m)) };
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ── /api/v1/* ───────────────────────────────────────────────────────────────────────────────────────────────────────
function apiFunction(deps) {
  deps = deps || {};
  let h = null;
  return async function api(request, context) {
    if (!h) {
      const env = platformEnv(deps.env || process.env);
      const store = require('./netlify-blobs').createStore(env, { getStore: deps.getStore });
      h = (deps.createHandler || require('./handler').createHandler)({ env, store, fetch: deps.fetch, log: deps.log, db: deps.db, mail: deps.mail });
    }
    return h.handle(request, context);
  };
}

// ── the signed kick of a background function ───────────────────────────────────────────────────────────────────────
function kickPath(name) {
  if (!FUNCTIONS[name] || !/-background$/.test(name)) throw new Error('netlify: unknown background function ' + name);
  return '/.netlify/functions/' + name;
}
function kickRequest(name, base, keyB64, nowMs) {
  const key = Buffer.from(String(keyB64 || ''), 'base64');
  if (key.length < 32) throw new Error('WTS_OPS_HMAC is not set (32 bytes, base64)');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(String(base || '').replace(/\/+$/, ''))) throw new Error('netlify: the site address must be https');
  const { opsSignature } = require('../core/http');
  const p = kickPath(name);
  const ts = String(Math.floor((nowMs || Date.now()) / 1000));
  const nonce = crypto.randomBytes(18).toString('base64url');
  return {
    url: String(base).replace(/\/+$/, '') + p,
    init: { method: 'POST', headers: { 'X-WTS-Ts': ts, 'X-WTS-Nonce': nonce, 'X-WTS-Sig': opsSignature(key, 'POST', p, ts, nonce), 'Content-Type': 'application/json' }, body: '{}' },
  };
}
function lowerHeaders(h) {
  const out = {};
  if (h && typeof h.forEach === 'function') h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
  else if (h) Object.keys(h).forEach((k) => { out[k.toLowerCase()] = h[k]; });
  return out;
}
// → Promise<boolean>: the HMAC over method, path, timestamp and nonce (±5 min), the nonce once (wts.ops_nonce_claim)
async function verifyKick(req, name, env, deps) {
  deps = deps || {};
  const H = require('../core/http');
  const { loadJobsConfig } = require('../core/config');
  const p = kickPath(name);
  let path = '';
  try { path = new URL(req.url).pathname; } catch (e) { return false; }
  if (req.method !== 'POST' || path !== p) return false;
  const cfg = loadJobsConfig(env);
  if (!cfg.secrets.opsHmac) return false;
  const nonces = deps.nonces || null;
  let db = null;
  try {
    let store = nonces;
    if (!store) {
      const url = dbUrl(env, 'WTS_DB_URL');
      if (!url) return false;
      db = (deps.createDb || require('../core/db').createDb)(url, { role: 'wts_api', max: 1 });
      store = H.dbNonceStore(db);
    }
    return await H.verifyOps({ method: req.method, headers: lowerHeaders(req.headers) }, p, cfg, (deps.now || Date.now)(), store);
  } finally { if (db) await db.close(); }
}

// ── job bodies ─────────────────────────────────────────────────────────────────────────────────────────────────────
function guard(env, log) {
  const { loadJobsConfig } = require('../core/config');
  const { checkIsolation } = require('./isolation');
  const config = loadJobsConfig(env);
  const iso = checkIsolation(config, env);
  iso.problems.forEach((p) => log.warn('alert: isolation — ' + p));
  return { config, ok: iso.ok };
}
function mailFor(env, config, deps) {
  if (!env.WTS_MAIL_API_URL || !env.WTS_MAIL_CREDENTIAL) return null;
  return require('./adapters').httpMail({ url: env.WTS_MAIL_API_URL, credential: env.WTS_MAIL_CREDENTIAL, from: config.mailFrom, fetch: deps.fetch });
}
async function runJobs(o) {
  o = o || {};
  const env = platformEnv(o.env || process.env);
  const log = o.log || defaultLog();
  const { config, ok } = guard(env, log);
  if (!ok) return { ok: false, skipped: 'isolation' };
  const url = dbUrl(env, 'WTS_JOBS_DB_URL');
  if (!url) return { ok: false, skipped: 'no database' };
  const { hostObjects } = require('./adapters');
  const blobs = require('./netlify-blobs');
  const db = (o.createDb || require('../core/db').createDb)(url, { role: 'wts_jobs', sessionRole: true, max: 1 });
  try {
    await db.checkRole();
    const keys = require('../core/keys').createKeys(config);
    const objects = hostObjects(blobs.createStore(env, { getStore: o.getStore }));
    const did = await require('../core/jobs').runDaily({ db, keys, objects, mail: mailFor(env, config, o), log, only: o.only });
    const out = { ok: true, did };
    if (o.checkExport) {
      const exportsStore = hostObjects(blobs.createStore(env, { name: blobs.STORES.exports, getStore: o.getStore }));
      const n = await require('./backup').newestExportInStore(exportsStore);
      const age = n ? ((o.now || Date.now)() - n.at) / 86400000 : null;
      out.exportAgeDays = age == null ? null : Math.round(age * 10) / 10;
      if (age == null || age > EXPORT_MAX_AGE_DAYS) log.warn('alert: exportAge — no weekly export in the last ' + EXPORT_MAX_AGE_DAYS + ' days');
    }
    return out;
  } finally { await db.close(); }
}
async function runExport(o) {
  o = o || {};
  const env = platformEnv(o.env || process.env);
  const log = o.log || defaultLog();
  const { ok } = guard(env, log);
  if (!ok) return { ok: false, skipped: 'isolation' };
  const B = require('./backup');
  const publicKey = B.parsePublicKey(env.WTS_BACKUP_PUBLIC_KEY);
  const url = dbUrl(env, null);
  if (!url) return { ok: false, skipped: 'no database' };
  const { hostObjects } = require('./adapters');
  const blobs = require('./netlify-blobs');
  const db = (o.createDb || require('../core/db').createDb)(url, { role: 'wts_backup', sessionRole: true, max: 1 });
  try {
    const objects = hostObjects(blobs.createStore(env, { getStore: o.getStore }));
    const exportsStore = hostObjects(blobs.createStore(env, { name: blobs.STORES.exports, getStore: o.getStore }));
    const r = await B.exportCopy({ db, objects, now: o.now });
    const w = await B.writeExportStore({ entries: r.entries, publicKey, objects: exportsStore, now: o.now,
      retainDays: env.WTS_EXPORT_RETAIN_DAYS == null ? 28 : Number(env.WTS_EXPORT_RETAIN_DAYS) });
    return { ok: true, name: w.name, bytes: w.bytes, pruned: w.pruned, counts: r.manifest.counts, objects: r.manifest.objects, blobKeys: r.manifest.blobKeys };
  } finally { await db.close(); }
}

// ── function factories ─────────────────────────────────────────────────────────────────────────────────────────────
function scheduledFunction(name, deps) {
  deps = deps || {};
  const f = FUNCTIONS[name];
  if (!f || !f.config || !f.config.schedule) throw new Error('netlify: ' + name + ' is not a scheduled function');
  return async function scheduled(request, context) {
    const env = deps.env || process.env;
    const log = deps.log || defaultLog();
    try {
      if (name === 'ops-purge') {
        const r = await runJobs(Object.assign({}, deps, { env, log, only: PURGE_STEPS }));
        log.info('jobs: ' + name + ' ' + JSON.stringify(r));
        return json(200, r);
      }
      const base = (context && context.site && context.site.url) || env.URL;
      const k = kickRequest(f.kicks, base, env.WTS_OPS_HMAC, (deps.now || Date.now)());
      const res = await (deps.fetch || fetch)(k.url, k.init);
      const r = { ok: !!res && (res.status === 202 || res.ok), kicked: f.kicks, status: res && res.status };
      if (!r.ok) log.warn('alert: jobs — ' + name + ' could not start ' + f.kicks + ' (' + (res && res.status) + ')');
      else log.info('jobs: ' + name + ' started ' + f.kicks);
      return json(200, r);
    } catch (e) {
      log.warn('alert: jobs — ' + name + ' failed: ' + (e && e.message));
      return json(500, { ok: false });
    }
  };
}
function backgroundFunction(name, deps) {
  deps = deps || {};
  if (!FUNCTIONS[name] || FUNCTIONS[name].config !== null) throw new Error('netlify: ' + name + ' is not a background function');
  return async function background(request) {
    const env = platformEnv(deps.env || process.env);
    const log = deps.log || defaultLog();
    // the platform answers 202 to the caller at once; this return value is never seen by anyone
    if (!(await verifyKick(request, name, env, deps))) { log.warn('alert: jobs — ' + name + ' refused an unsigned or replayed call'); return json(404, { ok: false }); }
    try {
      const r = name === 'ops-daily-background'
        ? await runJobs(Object.assign({}, deps, { env, log, checkExport: true }))
        : await runExport(Object.assign({}, deps, { env, log }));
      log.info('jobs: ' + name + ' ' + JSON.stringify(r));
      if (!r.ok) log.warn('alert: jobs — ' + name + ' skipped (' + r.skipped + ')');
      return json(200, r);
    } catch (e) {
      log.warn('alert: jobs — ' + name + ' failed: ' + (e && e.message));
      return json(500, { ok: false });
    }
  };
}

module.exports = { FUNCTIONS, DEFAULTS, PURGE_STEPS, platformEnv, apiFunction, scheduledFunction, backgroundFunction, kickRequest, kickPath, verifyKick, runJobs, runExport };
