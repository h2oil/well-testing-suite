'use strict';
// server/core/oauth-store.js — the SQL side of provider sign-in (docs/ACCOUNTS-PLAN.md §3.4, §4.10–4.12, §8.3): thin calls
// of the definer functions of db/migrations/001-schema.sql (signatures) and 040-oauth.sql (bodies). wts_api has no direct
// access to oauth_attempts or oidc_keys; identities are read under RLS in the user's own transaction.
//
//   createOauthStore(db) → {
//     attempts: {create(o) → id|null, drop(cookieHash), take(cookieHash, stateHash, provider) → row|null,
//                result(id, enc, until|null), extend(cookieHash, newHash, until) → bool, finish(cookieHash, sidHash|null) → row|null,
//                close(id), claim(id) → bool (one finish at a time), release(id)},
//     identities: {bySubject(provider, subjectBidx) → {userId, identityId, status}|null, link(tx, o) → id (throws code
//                identity_in_use | provider_linked), touch(tx, id), unlink(tx, id) → sessions|null, list(tx, userId)},
//     keys: {get(provider, kid), put(provider, kid, jwk, expiresAtMs), claimFetch(provider) → bool},   (the key cache store of
//            core/oidc.js; claimFetch = the cross-instance limit of one signing-key fetch per provider per 5-minute window)
//     breaker: {isOpen(provider), note(provider, bad)}, exchangeHit(prefix) → bool, finishFail(prefix) → over the soft limit }

function createOauthStore(db) {
  const anon = (fn) => db.anon(fn);
  const one = (rows) => (rows && rows.length ? rows[0] : null);
  return {
    attempts: {
      async create(o) {
        const r = await anon((tx) => tx`select wts.oauth_attempt_create(${o.cookieHash}, ${o.provider}, ${o.purpose}, ${o.stateHash}, ${o.nonce},
          ${o.verifierEnc}, ${o.boundSid || null}, ${o.boundUser || null}, ${!!o.publicDevice}, ${!!o.freshLogin}, ${o.labelEnc || null},
          ${new Date(o.expiresAt)}, ${o.ipPrefix || null}::inet) as id`);
        return r[0] ? r[0].id : null;
      },
      drop(cookieHash) { return anon((tx) => tx`select wts.oauth_attempt_drop(${cookieHash})`); },
      async take(cookieHash, stateHash, provider) {
        return one(await anon((tx) => tx`select * from wts.oauth_attempt_take(${cookieHash}, ${stateHash}, ${provider})`));
      },
      result(id, enc, until) { return anon((tx) => tx`select wts.oauth_attempt_result(${id}, ${enc}, ${until ? new Date(until) : null})`); },
      async extend(cookieHash, newHash, until) {
        const r = await anon((tx) => tx`select wts.oauth_attempt_extend(${cookieHash}, ${newHash}, ${new Date(until)}) as ok`);
        return !!(r[0] && r[0].ok);
      },
      async finish(cookieHash, sidHash) {
        return one(await anon((tx) => tx`select * from wts.oauth_attempt_finish(${cookieHash}, ${sidHash || null})`));
      },
      close(id) { return anon((tx) => tx`select wts.oauth_attempt_close(${id})`); },
      async claim(id) { const r = await anon((tx) => tx`select wts.oauth_attempt_claim(${id}) as ok`); return !!(r[0] && r[0].ok); },
      release(id) { return anon((tx) => tx`select wts.oauth_attempt_release(${id})`); },
    },
    identities: {
      async bySubject(provider, subjectBidx) {
        const r = one(await anon((tx) => tx`select * from wts.user_by_identity(${provider}, ${subjectBidx})`));
        return r ? { userId: r.user_id, identityId: r.identity_id, status: r.status } : null;
      },
      async link(tx, o) {
        try {
          const r = await tx`select wts.identity_link(${o.userId}, ${o.provider}, ${o.issuer}, ${o.subjectBidx}, ${o.subjectEnc},
            ${o.emailEnc || null}, ${!!o.emailVerified}, ${o.via}) as id`;
          return r[0].id;
        } catch (e) {
          if (e && e.code === 'WO001') { const x = new Error('identity_in_use'); x.code = 'identity_in_use'; throw x; }
          if (e && e.code === 'WO002') { const x = new Error('provider_linked'); x.code = 'provider_linked'; throw x; }
          throw e;
        }
      },
      touch(tx, id) { return tx`select wts.identity_touch(${id})`; },
      async unlink(tx, id) { const r = await tx`select wts.identity_unlink(${id}) as n`; return r[0] ? r[0].n : null; },
      list(tx, userId) {
        return tx`select id, provider, subject_bidx, email_link_enc, email_ack_bidx, linked_at, last_used_at from wts.identities where user_id = ${userId} order by linked_at`;
      },
      ack(tx, id, ackBidx) { return tx`update wts.identities set email_ack_bidx = ${ackBidx} where id = ${id}`; },
    },
    keys: {
      async get(provider, kid) { const r = await anon((tx) => tx`select wts.oidc_key_get(${provider}, ${kid}) as jwk`); return r[0] ? r[0].jwk : null; },
      put(provider, kid, jwk, expiresAt) { return anon((tx) => tx`select wts.oidc_key_put(${provider}, ${kid}, ${tx.json(jwk)}, ${new Date(expiresAt)})`); },
      async claimFetch(provider) { const r = await anon((tx) => tx`select wts.oidc_fetch_claim(${provider}) as ok`); return !!(r[0] && r[0].ok); },
    },
    breaker: {
      async isOpen(provider) { const r = await anon((tx) => tx`select wts.oauth_breaker_open(${provider}) as open`); return !!(r[0] && r[0].open); },
      async note(provider, bad) { const r = await anon((tx) => tx`select wts.oauth_breaker_note(${provider}, ${!!bad}) as open`); return !!(r[0] && r[0].open); },
    },
    async finishFail(prefix) {
      const r = await anon((tx) => tx`select wts.oauth_finish_fail(${prefix || null}::inet) as over`);
      return !!(r[0] && r[0].over);
    },
    async exchangeHit(prefix) {
      const r = await anon((tx) => tx`select wts.oauth_exchange_hit(${prefix || null}::inet) as ok`);
      return !!(r[0] && r[0].ok);
    },
  };
}

module.exports = { createOauthStore };
