'use strict';
// server/site/adapters.js — the host bindings of the functions-only site (docs/ACCOUNTS-PLAN.md §2, §3.1, §13.5; WP-OPS):
// the blob-store adapter behind the core/objects.js seam and the e-mail transport behind core/mail.js. Both talk to small,
// common interfaces that the owner binds once (server/RUNBOOK.md, Activation checklist); the one named e-mail service mode
// (Postmark, the test backend's choice) sits beside the generic JSON mode, which stays the default.
//
//   hostObjects(store) → ObjectStore {put, get, del, list, delPrefix} over a host key-value blob store with the common shape
//        { get(key) → Promise<ArrayBuffer|Uint8Array|Buffer|string|null>, set(key, Uint8Array) → Promise,
//          delete(key) → Promise, list({prefix}) → Promise<[key] | {blobs:[{key}]} | {keys:[…]} | {objects:[{key}]}> }
//        Keys are validated by core/objects.js (u/<uid>/b/<sha>/<n>, u/<uid>/lib/<sha>, ledger/<uid>, chain/<date>) — the
//        same rules as the memory and folder stores, so a host store can never be asked for anything else.
//   httpMail({url, credential, from, fetch}) → transport {send({to, template, params}) → Promise}
//        POSTs {from, to, subject, text} as JSON with "Authorization: Bearer <credential>" to the e-mail service's HTTPS
//        endpoint (WTS_MAIL_API_URL). Plain text only; the message never carries client-supplied text (core/mail.js rules).
//   postmarkMail({credential, from, fetch}) → transport (WTS_MAIL_PROVIDER=postmark; server-side only, Postmark is named only
//        inside server/): POST https://api.postmarkapp.com/email, headers Accept / Content-Type application/json and
//        X-Postmark-Server-Token: <WTS_MAIL_CREDENTIAL>, body {From, To, Subject, TextBody, MessageStream:'outbound'}. A refusal
//        (HTTP status and the service's ErrorCode) becomes the transport error of httpMail — Error('mail: the service
//        answered <status> (<kind>)') with err.code = <kind> (MAIL_ERRORS) and err.retry — and never carries the service's
//        Message (it can name the recipient), the address or the body.
//   mailFromEnv(env, {from, fetch}) → transport | null   the one choice of transport for the API function and the jobs:
//        WTS_MAIL_PROVIDER=postmark → postmarkMail (needs WTS_MAIL_CREDENTIAL); unset / 'json' → httpMail (needs
//        WTS_MAIL_API_URL + WTS_MAIL_CREDENTIAL); missing values → null (mail waits in the outbox); an unknown provider throws.
//   renderPlain(msg) → {subject, text}   (core/mail.js render(); a composed message already carries both)

const KEY_RE = /^(u\/[0-9a-f-]{36}\/(b\/[0-9a-f]{64}\/\d{1,6}|lib\/[0-9a-f]{64})|ledger\/[0-9a-f-]{36}|chain\/\d{4}-\d{2}-\d{2}|export\/[0-9A-Za-z._-]{1,120})$/;
const PREFIX_RE = /^(u\/[0-9a-f-]{36}\/((b\/([0-9a-f]{64}\/)?)|lib\/)?|ledger\/|chain\/|export\/)$/;
function seam() {
  try { const o = require('../core/objects'); if (typeof o.checkKey === 'function') return o; } catch (e) { /* foundation branch */ }
  return null;
}
function checkKey(k) {
  const s = seam();
  if (s && !/^export\//.test(String(k))) return s.checkKey(k);
  if (typeof k !== 'string' || !KEY_RE.test(k)) throw new Error('objects: bad key');
  return k;
}
function checkPrefix(p) { if (typeof p !== 'string' || !PREFIX_RE.test(p)) throw new Error('objects: bad prefix'); return p; }
function toBuffer(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  throw new Error('objects: the host store returned an unknown value type');
}
function keysOf(r) {
  if (Array.isArray(r)) return r.map((x) => (typeof x === 'string' ? x : x && x.key)).filter(Boolean);
  const arr = (r && (r.blobs || r.objects || r.keys)) || [];
  return arr.map((x) => (typeof x === 'string' ? x : x && x.key)).filter(Boolean);
}
function hostObjects(store) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.delete !== 'function' || typeof store.list !== 'function') {
    throw new Error('hostObjects: the store needs get / set / delete / list');
  }
  const api = {
    kind: 'host',
    async put(k, buf) { await store.set(checkKey(k), new Uint8Array(toBuffer(buf))); },
    async get(k) { return toBuffer(await store.get(checkKey(k))); },
    async del(k) { await store.delete(checkKey(k)); },
    async list(p) { checkPrefix(p); return keysOf(await store.list({ prefix: p })).filter((k) => k.startsWith(p) && KEY_RE.test(k)).sort(); },
    async delPrefix(p) { const ks = await api.list(p); for (const k of ks) await api.del(k); return ks.length; },
  };
  return api;
}

// the §4.1 / §4.3 / §8.5 wording of core/mail.js (plain text, generic browser / OS words only)
function renderPlain(msg) { return require('../core/mail').render(msg.template, msg.params); }
function httpMail(o) {
  o = o || {};
  if (!/^https:\/\//.test(String(o.url || ''))) throw new Error('httpMail: an https endpoint is required');
  if (!o.credential) throw new Error('httpMail: a credential is required');
  const f = o.fetch || fetch;
  return {
    kind: 'http',
    async send(msg) {
      const bad = require('../core/mail').checkMessage(msg);
      if (bad) throw new Error('mail: ' + bad);
      // every send path hands over a composed message (core/mail.js compose: subject + plain text); render it otherwise
      const r = typeof msg.subject === 'string' && typeof msg.text === 'string' ? { subject: msg.subject, text: msg.text } : renderPlain(msg);
      const res = await f(o.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + o.credential },
        body: JSON.stringify({ from: o.from || 'no-reply@h2oil.co.uk', to: msg.to, subject: r.subject, text: r.text }),
      });
      if (!res || !res.ok) throw mailError(res && res.status, res && res.status === 429 ? 'mail_rate' : (res && res.status >= 500 ? 'mail_unavailable' : 'mail_failed'));
      return true;
    },
  };
}

// ── Postmark (WTS_MAIL_PROVIDER=postmark) ─────────────────────────────────────────────────────────────────────────
const POSTMARK_URL = 'https://api.postmarkapp.com/email';
// the transport error kinds (err.code); retry = whether the daily job's outbox retry can help
const MAIL_ERRORS = Object.freeze({
  mail_auth: { retry: false },          // the token is wrong or not a server token (401, ErrorCode 10)
  mail_sender: { retry: false },        // the From address is not a confirmed sender, or the account is pending / paused
  mail_rejected: { retry: false },      // this recipient cannot get mail (invalid address, inactive / suppressed recipient)
  mail_rate: { retry: true },           // too many requests (429)
  mail_unavailable: { retry: true },    // the service failed (5xx) or could not be reached
  mail_failed: { retry: true },         // any other refusal
});
// Postmark's documented API error codes → kind (anything else: by HTTP status)
const POSTMARK_CODES = { 10: 'mail_auth', 300: 'mail_rejected', 406: 'mail_rejected', 400: 'mail_sender', 401: 'mail_sender',
  405: 'mail_sender', 412: 'mail_sender', 413: 'mail_sender', 429: 'mail_rate' };
function mailError(status, kind) {
  const k = MAIL_ERRORS[kind] ? kind : 'mail_failed';
  const e = new Error('mail: the service answered ' + (status == null ? 'nothing' : status) + ' (' + k + ')');
  e.code = k; e.retry = MAIL_ERRORS[k].retry; e.status = status == null ? null : status;
  return e;
}
function postmarkKind(status, errorCode) {
  if (POSTMARK_CODES[errorCode]) return POSTMARK_CODES[errorCode];
  if (status === 401 || status === 403) return 'mail_auth';
  if (status === 429) return 'mail_rate';
  if (status >= 500) return 'mail_unavailable';
  return 'mail_failed';
}
function postmarkMail(o) {
  o = o || {};
  if (!o.credential) throw new Error('postmarkMail: a server token is required (WTS_MAIL_CREDENTIAL)');
  const f = o.fetch || fetch;
  return {
    kind: 'postmark',
    async send(msg) {
      const bad = require('../core/mail').checkMessage(msg);
      if (bad) throw new Error('mail: ' + bad);
      const r = typeof msg.subject === 'string' && typeof msg.text === 'string' ? { subject: msg.subject, text: msg.text } : renderPlain(msg);
      let res;
      try {
        res = await f(POSTMARK_URL, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': o.credential },
          body: JSON.stringify({ From: o.from || 'no-reply@h2oil.co.uk', To: msg.to, Subject: r.subject, TextBody: r.text, MessageStream: 'outbound' }),
        });
      } catch (e) { throw mailError(null, 'mail_unavailable'); }
      let body = null;
      try { body = typeof res.json === 'function' ? await res.json() : null; } catch (e) { body = null; }
      const code = body && typeof body.ErrorCode === 'number' ? body.ErrorCode : (res && res.ok ? 0 : null);
      if (!res || !res.ok || code !== 0) throw mailError(res && res.status, postmarkKind(res && res.status, code));
      return true;
    },
  };
}

function mailFromEnv(env, o) {
  env = env || {}; o = o || {};
  const provider = String(env.WTS_MAIL_PROVIDER || '').trim().toLowerCase();
  if (provider === 'postmark') {
    if (!env.WTS_MAIL_CREDENTIAL) return null;
    return postmarkMail({ credential: env.WTS_MAIL_CREDENTIAL, from: o.from, fetch: o.fetch });
  }
  if (provider && provider !== 'json') throw new Error('mail: WTS_MAIL_PROVIDER must be postmark or json');
  if (!env.WTS_MAIL_API_URL || !env.WTS_MAIL_CREDENTIAL) return null;
  return httpMail({ url: env.WTS_MAIL_API_URL, credential: env.WTS_MAIL_CREDENTIAL, from: o.from, fetch: o.fetch });
}

module.exports = { hostObjects, httpMail, postmarkMail, mailFromEnv, mailError, renderPlain, checkKey, checkPrefix, KEY_RE, MAIL_ERRORS, POSTMARK_URL };
