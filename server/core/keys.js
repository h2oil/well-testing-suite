'use strict';
// server/core/keys.js — the server's key material, built ONLY from config.secrets (environment variables; docs/ACCOUNTS-PLAN.md
// §13.3). Nothing here is ever logged or returned.
//
//   createKeys(config) → {
//     ready, missing[], ephemeral,
//     emailBidx(normEmail) → Buffer           HMAC-SHA256(index pepper, address) — the only stored form of an address index
//     bidx(text) → Buffer                     the same keyed index for other identifiers (provider ‖ sub, WP-O)
//     codeHmac(purpose, email, code, bind?) → {kid, hmac}       with the CURRENT code pepper (issue)
//     codeCandidates(purpose, emails[], code, bind?) → Buffer[] under every live pepper × every candidate address (check)
//     sidHash(sid) → Buffer                   SHA-256 of the session id (§3.4 sessions.sid_hash; the same for WP-O)
//     master: {current:{kid,key}, forKid(kid) → key|null, kids[]}
//     ring: {create() → {wrapped, kid, dkv:1, keys}, open(wrapped) → Map<dkv, key>}   per-user data keys (envelope.js)
//     system: {seal(label, buf), open(label, buf)}
//     outboxKey() → 32 random bytes            (§10.8; stored encrypted with the user's data key)
//   }
//
// Outside production, missing secrets are replaced by EPHEMERAL random keys (one process; warned) so a local run works; on
// the production host a missing secret makes `ready` false and every handler that needs keys answers 503 paused.

const crypto = require('crypto');
const E = require('./envelope');

function hmac(key, text) { return crypto.createHmac('sha256', key).update(text, 'utf8').digest(); }

function createKeys(config) {
  const s = config.secrets || {};
  const missing = [];
  let ephemeral = false;
  const eph = (name) => { ephemeral = true; return crypto.randomBytes(32); };
  let masterKeys = (s.masterKeys || []).slice();
  if (!masterKeys.length) { missing.push('WTS_MASTER_KEYS'); if (!config.production) masterKeys = [{ kid: 1, key: eph() }]; }
  let indexPepper = s.indexPepper || null;
  if (!indexPepper) { missing.push('WTS_INDEX_PEPPER'); if (!config.production) indexPepper = eph(); }
  let codePeppers = (s.codePeppers || []).slice();
  if (!codePeppers.length) { missing.push('WTS_CODE_PEPPERS'); if (!config.production) codePeppers = [{ kid: 1, key: eph() }]; }
  const ready = !!(masterKeys.length && indexPepper && codePeppers.length);

  const byKid = new Map(masterKeys.map((m) => [m.kid, m.key]));
  let currentKid = s.masterKid != null && byKid.has(s.masterKid) ? s.masterKid : null;
  if (currentKid == null && masterKeys.length) currentKid = Math.max.apply(null, masterKeys.map((m) => m.kid));
  const master = {
    current: currentKid == null ? null : { kid: currentKid, key: byKid.get(currentKid) },
    forKid: (kid) => byKid.get(kid) || null,
    kids: masterKeys.map((m) => m.kid),
  };
  const pepperCur = codePeppers.length ? codePeppers.reduce((a, b) => (b.kid > a.kid ? b : a)) : null;
  function codeText(purpose, email, code, bind) {
    bind = bind || {};
    return ['wts-code-1', purpose, email || '', code, bind.user || '', bind.sid ? Buffer.from(bind.sid).toString('hex') : '', bind.attempt || ''].join('\n');
  }
  function need() { if (!ready) throw new Error('keys: not configured'); }

  return {
    ready, missing, ephemeral,
    emailBidx(email) { need(); return hmac(indexPepper, String(email)); },
    bidx(text) { need(); return hmac(indexPepper, String(text)); },
    codeHmac(purpose, email, code, bind) { need(); return { kid: pepperCur.kid, hmac: hmac(pepperCur.key, codeText(purpose, email, code, bind)) }; },
    codeCandidates(purpose, emails, code, bind) {
      need();
      const out = [];
      (Array.isArray(emails) ? emails : [emails]).forEach((e) => codePeppers.forEach((p) => out.push(hmac(p.key, codeText(purpose, e, code, bind)))));
      return out;
    },
    sidHash(sid) { return crypto.createHash('sha256').update(String(sid), 'utf8').digest(); },
    master,
    ring: {
      create() { need(); const k = E.newDataKey(); return { wrapped: E.wrapRing([{ dkv: 1, key: k }], master.current), kid: master.current.kid, dkv: 1, keys: new Map([[1, k]]) }; },
      open(wrapped) { need(); return E.unwrapRing(wrapped, master.forKid).keys; },
    },
    system: {
      seal(label, buf) { need(); return E.sealSystem(master.current, label, buf); },
      open(label, buf) { need(); return E.openSystem(master.forKid, label, buf); },
    },
    outboxKey() { return crypto.randomBytes(32); },
  };
}

// new random identifiers
function randomToken(bytes) { return crypto.randomBytes(bytes || 32).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function code8() { return String(crypto.randomInt(0, 100000000)).padStart(8, '0'); }

module.exports = { createKeys, randomToken, code8 };
