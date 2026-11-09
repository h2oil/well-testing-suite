'use strict';
// server/core/envelope.js — envelope encryption (docs/ACCOUNTS-PLAN.md D11, §3.4, §13.4). Pure functions over Buffers; the
// keys come from core/keys.js (master keys from WTS_MASTER_KEYS, never from the repository).
//
// Three layers, all AES-256-GCM with a 12-byte random IV and a 16-byte tag:
//   • KEY RING (users.data_key_wrapped): every data key version (dkv) of one user, each wrapped by a master key (kid).
//       'WKR1' ‖ count u8 ‖ count × ( dkv u16 ‖ kid u32 ‖ iv 12 ‖ tag 16 ‖ wrapped key 32 ), AAD "wts1|dk|<dkv>|<kid>".
//       More than one entry only while a compromise re-encryption runs (§13.4): the chunk header's dkv picks the key, so old
//       and new chunks both read ("dual read"). Rotation of a master key re-wraps every entry (rewrapRing) before the old kid
//       is retired.
//   • FIELD (email_enc, meta_enc, label_enc, the pending addresses, the outbox key …): the user's current data key.
//       0x01 ‖ dkv u16 ‖ iv ‖ tag ‖ ciphertext, AAD "wts1|f|<field>|<dkv>" — a value moved to another column or another user
//       does not open.
//   • SYSTEM (mail outbox address and parameters, values without a user context): a master key directly.
//       0x02 ‖ kid u32 ‖ iv ‖ tag ‖ ciphertext, AAD "wts1|s|<label>|<kid>".
//   • CHUNK (blob store objects u/<uid>/b/<hash>/<n>): header {v:1, alg:'A256GCM', kid, dkv, iv} as JSON, length-prefixed,
//       ‖ ciphertext ‖ tag, AAD "wts1|" + userId + "|" + hash + "|" + n + "|" + kid (§3.4). A chunk swapped to another user,
//       hash or index fails its tag (AAD tamper test).

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const RING_MAGIC = Buffer.from('WKR1');

function seal(key, plain, aad) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('envelope: a 32-byte key is required');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}
function open(key, iv, tag, ct, aad) {
  const d = crypto.createDecipheriv(ALG, key, iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
const toBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'));

// ── key ring ────────────────────────────────────────────────────────────────────────────────────────────────────
function newDataKey() { return crypto.randomBytes(32); }
// entries: [{dkv, key}] ; master: {kid, key}
function wrapRing(entries, master) {
  if (!entries.length || entries.length > 8) throw new Error('envelope: a ring holds 1–8 data keys');
  const parts = [RING_MAGIC, Buffer.from([entries.length])];
  for (const e of entries) {
    const h = Buffer.alloc(6); h.writeUInt16BE(e.dkv, 0); h.writeUInt32BE(master.kid, 2);
    const s = seal(master.key, e.key, 'wts1|dk|' + e.dkv + '|' + master.kid);
    parts.push(h, s.iv, s.tag, s.ct);
  }
  return Buffer.concat(parts);
}
// masterFor(kid) → 32-byte key | null. Returns {keys: Map<dkv, key>, kids: Set<kid>}; throws if an entry cannot be opened.
function unwrapRing(buf, masterFor) {
  if (!Buffer.isBuffer(buf) || buf.length < 5 || !buf.subarray(0, 4).equals(RING_MAGIC)) throw new Error('envelope: not a key ring');
  const n = buf[4]; const keys = new Map(); const kids = new Set();
  let o = 5;
  for (let i = 0; i < n; i++) {
    const dkv = buf.readUInt16BE(o); const kid = buf.readUInt32BE(o + 2); o += 6;
    const iv = buf.subarray(o, o + 12); const tag = buf.subarray(o + 12, o + 28); const ct = buf.subarray(o + 28, o + 60); o += 60;
    const mk = masterFor(kid);
    if (!mk) throw new Error('envelope: master key ' + kid + ' is not loaded');
    keys.set(dkv, open(mk, iv, tag, ct, 'wts1|dk|' + dkv + '|' + kid));
    kids.add(kid);
  }
  return { keys, kids };
}
function ringKids(buf) {
  const n = buf[4]; const kids = []; let o = 5;
  for (let i = 0; i < n; i++) { kids.push(buf.readUInt32BE(o + 2)); o += 66; }
  return kids;
}
// re-wrap every entry with another master key (rotation, §13.4); keepDkv limits the ring to those versions (rekey cleanup)
function rewrapRing(buf, masterFor, master, keepDkv) {
  const r = unwrapRing(buf, masterFor);
  const entries = [];
  r.keys.forEach((key, dkv) => { if (!keepDkv || keepDkv.indexOf(dkv) !== -1) entries.push({ dkv, key }); });
  return wrapRing(entries, master);
}

// ── fields (user data key) ──────────────────────────────────────────────────────────────────────────────────────
function sealField(dataKey, dkv, field, plain) {
  const s = seal(dataKey, toBuf(plain), 'wts1|f|' + field + '|' + dkv);
  const h = Buffer.alloc(3); h[0] = 1; h.writeUInt16BE(dkv, 1);
  return Buffer.concat([h, s.iv, s.tag, s.ct]);
}
// keys: Map<dkv, key> (from unwrapRing)
function openField(keys, field, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 31 || buf[0] !== 1) throw new Error('envelope: not a field value');
  const dkv = buf.readUInt16BE(1); const key = keys.get(dkv);
  if (!key) throw new Error('envelope: data key version ' + dkv + ' is not in the ring');
  return open(key, buf.subarray(3, 15), buf.subarray(15, 31), buf.subarray(31), 'wts1|f|' + field + '|' + dkv);
}

// ── system values (master key) ──────────────────────────────────────────────────────────────────────────────────
function sealSystem(master, label, plain) {
  const s = seal(master.key, toBuf(plain), 'wts1|s|' + label + '|' + master.kid);
  const h = Buffer.alloc(5); h[0] = 2; h.writeUInt32BE(master.kid, 1);
  return Buffer.concat([h, s.iv, s.tag, s.ct]);
}
function openSystem(masterFor, label, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf[0] !== 2) throw new Error('envelope: not a system value');
  const kid = buf.readUInt32BE(1); const key = masterFor(kid);
  if (!key) throw new Error('envelope: master key ' + kid + ' is not loaded');
  return open(key, buf.subarray(5, 17), buf.subarray(17, 33), buf.subarray(33), 'wts1|s|' + label + '|' + kid);
}

// ── blob chunks ─────────────────────────────────────────────────────────────────────────────────────────────────
function chunkAad(userId, hash, n, kid) { return 'wts1|' + userId + '|' + hash + '|' + n + '|' + kid; }
// o = {dataKey, dkv, kid, userId, hash, n}
function sealChunk(o, plain) {
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({ v: 1, alg: 'A256GCM', kid: o.kid, dkv: o.dkv, iv: iv.toString('base64') }), 'utf8');
  const c = crypto.createCipheriv(ALG, o.dataKey, iv);
  c.setAAD(Buffer.from(chunkAad(o.userId, o.hash, o.n, o.kid), 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const len = Buffer.alloc(2); len.writeUInt16BE(header.length, 0);
  return Buffer.concat([len, header, ct, c.getAuthTag()]);
}
function chunkHeader(buf) {
  const hl = buf.readUInt16BE(0);
  const h = JSON.parse(buf.subarray(2, 2 + hl).toString('utf8'));
  if (h.v !== 1 || h.alg !== 'A256GCM' || !Number.isInteger(h.kid) || !Number.isInteger(h.dkv)) throw new Error('envelope: bad chunk header');
  return { header: h, offset: 2 + hl };
}
// keys: Map<dkv, key>; o = {userId, hash, n}
function openChunk(keys, o, buf) {
  const { header, offset } = chunkHeader(buf);
  const key = keys.get(header.dkv);
  if (!key) throw new Error('envelope: data key version ' + header.dkv + ' is not in the ring');
  const body = buf.subarray(offset);
  return open(key, Buffer.from(header.iv, 'base64'), body.subarray(body.length - 16), body.subarray(0, body.length - 16),
    chunkAad(o.userId, o.hash, o.n, header.kid));
}

module.exports = {
  newDataKey, wrapRing, unwrapRing, ringKids, rewrapRing, sealField, openField, sealSystem, openSystem,
  sealChunk, openChunk, chunkHeader, chunkAad,
};
