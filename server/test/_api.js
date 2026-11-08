'use strict';
// server/test/_api.js — the API harness of the WP-S1 server tests: a freshly migrated database (test/_db.js), the request
// handlers connected as wts_api, an in-memory blob store and mail transport, test-time keys (generated here, never
// committed) and browsers with their own cookie jars.
//
//   const T = await harness('name', {env})   → {app, db (admin driver), api (wts_api driver), mail, objects, config, keys,
//        browser(o) → br, signIn(br, email, o) → body, codeFor(email, template), lastMail(email, template), setEnv(extra),
//        age(sql) (run admin SQL to move timestamps into the past), close()}
//   br.call(method, path, body?, {headers, raw, ct}) → {status, json, body (Buffer), headers, cookies}; br.cookie(name)

const crypto = require('crypto');
const D = require('./_db');
const { loadConfig, loadJobsConfig } = require('../core/config');
const { createApp } = require('../core/app');
const { memoryTransport } = require('../core/mail');
const { memoryObjects } = require('../core/objects');
const { createKeys } = require('../core/keys');
const C = require('../core/contract');

const ORIGIN = 'https://welltest.h2oil.co.uk';
const k32 = () => crypto.randomBytes(32).toString('base64');

function testEnv(extra) {
  return Object.assign({
    WTS_ENV: 'test', ACCOUNTS_SIGNUP: 'open', SYNC_MODE: 'on', WTS_VERSION: 'test',
    WTS_MASTER_KEYS: '1:' + k32(), WTS_INDEX_PEPPER: k32(), WTS_CODE_PEPPERS: '1:' + k32(), WTS_OPS_HMAC: k32(),
    WTS_TERMS_VERSION: '1', WTS_PRIVACY_VERSION: '1',
  }, extra || {});
}

async function harness(name, o) {
  o = o || {};
  const H = await D.freshDatabase(name);
  const api = H.as('wts_api');
  const jobsDb = H.as('wts_jobs');
  let env = testEnv(o.env);
  const mail = o.mail || memoryTransport();
  const objects = memoryObjects();
  const T = { db: H.admin, api, jobsDb, mail, objects, H };
  function build() {
    T.config = loadConfig(env);
    T.keys = createKeys(T.config);
    T.jobsConfig = loadJobsConfig(env);
    const jobs = { run: (opts) => require('../core/jobs').runDaily(Object.assign({ db: jobsDb, config: T.jobsConfig, keys: T.keys, objects, mail, log: T.log }, opts || {})) };
    T.jobs = jobs;
    T.app = createApp({ config: T.config, db: api, mail, objects, keys: T.keys, jobs, log: T.log });
  }
  T.logs = [];
  T.log = { info: (m) => T.logs.push(String(m)), warn: (m) => T.logs.push(String(m)) };
  build();
  T.setEnv = (extra) => { env = Object.assign({}, env, extra); build(); };
  T.age = (strings, ...vals) => H.admin.sql(strings, ...vals);
  T.codeFor = (email, template) => mail.codeFor(email, template);
  T.lastMail = (email, template) => { for (let i = mail.sent.length - 1; i >= 0; i--) { const m = mail.sent[i]; if ((!email || m.to === email) && (!template || m.template === template)) return m; } return null; };
  T.mailsTo = (email) => mail.sent.filter((m) => m.to === email);
  T.browser = (bo) => {
    bo = bo || {};
    const jar = new Map();
    const br = {
      jar, device: null,
      cookie: (n) => jar.get(n) || null,
      async call(method, path, body, co) {
        co = co || {};
        const headers = Object.assign({ host: 'welltest.h2oil.co.uk', 'user-agent': bo.ua || 'Test/1.0' }, co.headers || {});
        if (method !== 'GET' && !co.bare) Object.assign(headers, { origin: ORIGIN, 'x-wts-req': '1', 'content-type': co.ct || 'application/json' }, co.headers || {});
        if (br.device && !headers['x-wts-device']) headers['x-wts-device'] = br.device;
        const ck = Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ');
        if (ck) headers.cookie = ck;
        let raw = null;
        if (co.raw !== undefined) raw = co.raw;
        else if (body !== undefined && method !== 'GET') raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const out = await T.app.handle({ method, url: C.BASE + path, headers, body: raw, remoteAddress: bo.ip || '203.0.113.9' });
        await T.app.idle();
        (out.cookies || []).forEach((line) => {
          const [kv] = line.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1);
          if (/Max-Age=0/.test(line) || !v) jar.delete(k); else jar.set(k, v);
        });
        const buf = out.body == null ? null : (Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body));
        let json = null;
        if (buf && /json/.test(out.headers['Content-Type'] || '')) json = JSON.parse(buf.toString('utf8'));
        return { status: out.status, json, body: buf, headers: out.headers, cookies: out.cookies };
      },
    };
    return br;
  };
  T.signIn = async (br, email, so) => {
    so = so || {};
    const s = await br.call('POST', '/auth/code/start', { email, purpose: 'signin' });
    if (s.status !== 202) throw new Error('code/start ' + s.status);
    const code = T.codeFor(email.toLowerCase(), 'code_signin');
    if (!code) throw new Error('no code mailed to ' + email);
    const body = { email, code, publicDevice: !!so.publicDevice };
    if (so.consent !== false) body.consent = { terms: T.config.terms, privacy: T.config.privacy };
    if (so.deviceLabel) body.deviceLabel = so.deviceLabel;
    const r = await br.call('POST', '/auth/code/verify', body);
    if (r.status !== 200) throw new Error('code/verify ' + r.status + ' ' + JSON.stringify(r.json));
    br.device = r.json.device.id;
    return r.json;
  };
  T.stepUp = async (br, so) => {
    so = so || {};
    await br.call('POST', '/auth/code/start', Object.assign({ purpose: 'stepup' }, so.to ? { to: so.to } : {}));
    const m = T.lastMail(null, 'code_stepup');
    const r = await br.call('POST', '/auth/code/verify', { code: m.params.code, publicDevice: false });
    if (r.status !== 200) throw new Error('step-up ' + r.status + ' ' + JSON.stringify(r.json));
    return r;
  };
  T.userId = async (email) => {
    const b = T.keys.emailBidx(email);
    const r = await H.admin.sql`select id from wts.users where email_bidx = ${b}`;
    return r[0] ? r[0].id : null;
  };
  T.close = () => H.close();
  return T;
}

module.exports = { harness, testEnv, ORIGIN, available: D.available };
