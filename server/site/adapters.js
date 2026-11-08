'use strict';
// server/site/adapters.js — the host bindings of the functions-only site (docs/ACCOUNTS-PLAN.md §2, §3.1, §13.5; WP-OPS):
// the blob-store adapter behind the core/objects.js seam and the e-mail transport behind core/mail.js. No vendor is named:
// both talk to small, common interfaces that the owner binds once (server/RUNBOOK.md, Activation checklist).
//
//   hostObjects(store) → ObjectStore {put, get, del, list, delPrefix} over a host key-value blob store with the common shape
//        { get(key) → Promise<ArrayBuffer|Uint8Array|Buffer|string|null>, set(key, Uint8Array) → Promise,
//          delete(key) → Promise, list({prefix}) → Promise<[key] | {blobs:[{key}]} | {keys:[…]} | {objects:[{key}]}> }
//        Keys are validated by core/objects.js (u/<uid>/b/<sha>/<n>, u/<uid>/lib/<sha>, ledger/<uid>, chain/<date>) — the
//        same rules as the memory and folder stores, so a host store can never be asked for anything else.
//   httpMail({url, credential, from, fetch}) → transport {send({to, template, params}) → Promise}
//        POSTs {from, to, subject, text} as JSON with "Authorization: Bearer <credential>" to the e-mail service's HTTPS
//        endpoint (WTS_MAIL_API_URL). Plain text only; the message never carries client-supplied text (core/mail.js rules).
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
      if (!res || !res.ok) throw new Error('mail: the service answered ' + (res && res.status));
      return true;
    },
  };
}

module.exports = { hostObjects, httpMail, renderPlain, checkKey, checkPrefix, KEY_RE };
