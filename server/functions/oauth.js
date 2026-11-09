'use strict';
// server/functions/oauth.js — provider sign-in (docs/ACCOUNTS-PLAN.md §3.3, §4.10–4.15, §8.3): GET /auth/providers,
// POST /auth/oauth/:provider/start, GET /auth/oauth/:provider/callback, POST /auth/oauth/finish, GET /auth/methods and
// POST /auth/methods/unlink.
//
//   handlers                       the production handlers (global fetch, pinned configuration)
//   createOauthHandlers(deps)      deps: {fetch, override:{google?, linkedin?} (test / dev endpoints; refused on the production
//                                  host), keyCache, breaker, delay(ms) → Promise (the soft delay; tests pass a recorder)} — the
//                                  server tests pass the fake provider here
//
// Rules kept here (see the plan for each): the attempt cookie __Host-wts_oa (Lax to the callback, re-issued Strict by finish
// for a code / e-mail / consent step); the callback reads only that cookie, burns the attempt BEFORE the exchange, never
// reads or sets the session cookie and always ends in the constant 303 (core/app.js); provider errors through the allow-list
// (the description is never read); per-prefix ceilings (20 live attempts, 30 exchanges per 10 min; in production a request
// whose client address cannot be resolved is refused, elsewhere it shares one 'unknown' bucket); more than 10 failed finishes
// per prefix per 10 min → each further failure answers after a soft delay; one finish per attempt at a time (a claim); the
// provider-side breaker;
// the linking rules 1–8 of §4.12; stepup_at is set only by an oauth_verify code (rules 4 and 5, cancel-deletion), never by a
// provider sign-in and never by a link_confirm code; a sign-in finish revokes the session id the request carried; unlink
// revokes every session the identity created. No code, state, token, claim or e-mail is ever logged.
//
// Sessions, codes, devices, the audit chain and mail are the shared server core (core/session.js, core/service.js,
// core/keys.js): a provider sign-in issues its session through SE.issue({method, identityId, stepup}), queues mail in the
// request transaction (sent after the commit) and writes audit rows that the audit_chain trigger chains. Attempt state, the
// PKCE verifier and the device label are system values (keys.system, AAD = their label); the identity's subject and e-mail
// are fields of the user's data key ('identity.subject', 'identity.email', as the account export reads them).

const C = require('../core/contract');
const V = require('../core/validate');
const O = require('../core/oidc');
const PINS = require('../core/oidc-providers');
const S = require('../core/service');
const { inviteListed } = require('../core/config');
const SE = require('../core/session');
const R = require('../core/rate');
const E = require('../core/envelope');
const { code8 } = require('../core/keys');
const { ApiError, fail } = require('../core/errors');
const { createOauthStore } = require('../core/oauth-store');
const AU = require('./auth')._internal;
const I = require('../core/insight');

const MIN = 60 * 1000;
const SOFT_DELAY_MS = 2000;
const toMs = (v) => (v == null ? null : (v instanceof Date ? v.getTime() : Date.parse(v)));
const iso = (v) => (v == null ? null : new Date(toMs(v)).toISOString());
const tryOpen = (u, field, buf) => { try { return buf == null ? null : u.open(field, buf); } catch (e) { return null; } };

// system values (master key; AAD = the label)
function seal(ctx, label, v) { return ctx.keys.system.seal(label, Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8')); }
function open(ctx, label, buf) { if (!buf) return null; try { return ctx.keys.system.open(label, Buffer.from(buf)); } catch (e) { return null; } }
const sealJson = (ctx, label, o) => seal(ctx, label, JSON.stringify(o));
function openJson(ctx, label, buf) { const b = open(ctx, label, buf); if (!b) return null; try { return JSON.parse(b.toString('utf8')); } catch (e) { return null; } }

// e-mail codes bound to an attempt (and, for link_confirm, to the session's user — issued and checked inside that user's
// transaction: code_issue / code_check require p_bound_user = app.user_id)
// review fix: an oauth_verify code obeys the same send limits as an e-mail-code sign-in (auth.js mayStart: per address AND
// client range, and the pause after 10 failed codes); when they refuse, nothing is sent and the reply stays the uniform next
// 'code' step. o.send === false (sign-up closed to an address with no account) also sends nothing.
async function issueCode(unit, ctx, o) {
  const exp = new Date(Date.now() + 15 * MIN);
  if (o.send === false) return { expiresAt: exp.getTime(), sent: false };
  if (o.purpose === 'oauth_verify' && !(await AU.mayStart(unit, ctx, ctx.keys.emailBidx(o.email)))) return { expiresAt: exp.getTime(), sent: false };
  const code = code8();
  const bind = o.bind || {};
  const { kid, hmac } = ctx.keys.codeHmac(o.purpose, o.email, code, bind);
  await unit.sql`select wts.code_issue(${ctx.keys.emailBidx(o.email)}, ${hmac}, ${kid}, ${o.purpose}, ${bind.user || null},
    ${bind.sid || null}, ${bind.attempt || null}, ${exp}, ${ctx.ipPrefix})`;
  await unit.mail(o.email, o.template, Object.assign({ code }, o.params || {}));
  return { expiresAt: exp.getTime(), sent: true };
}
// a wrong oauth_verify / link_confirm code counts towards the address-and-range pause like a wrong sign-in code (auth.js
// noteFailure); a pair that reached 10 failures today is refused without checking
async function checkCode(unit, ctx, o) {
  const code = V.normCode(o.code);
  if (!/^\d{8}$/.test(code)) return false;
  const bidx = ctx.keys.emailBidx(o.email);
  if (await AU.verifyBlocked(unit, ctx, bidx)) return false;
  const b = o.bind || {};
  const hm = ctx.keys.codeCandidates(o.purpose, o.email, code, b);
  const r = (await unit.sql`select * from wts.code_check(${bidx}, ${o.purpose}, ${unit.sql.array(hm, 17)},
    ${b.user || null}, ${b.sid || null}, ${b.attempt || null})`)[0];
  if (r && r.ok) return true;
  await AU.noteFailure(unit, ctx, bidx, o.email, r ? r.attempts_left : -1);
  return false;
}
async function userByEmail(unit, ctx, email) {
  const r = (await unit.sql`select * from wts.user_by_email(${ctx.keys.emailBidx(email)})`)[0];
  return r ? { userId: r.user_id, status: r.status, role: r.role } : null;
}
// the invite allow-list: WTS_INVITE_BOOTSTRAP (core/config.js) or the database list
async function allowlistHas(unit, ctx, email) {
  return inviteListed(ctx.config, email, async () => (await unit.sql`select wts.allowlist_has(${ctx.keys.emailBidx(email)}) as ok`)[0].ok);
}
// a new account in the caller's transaction (a provider sign-up creates it and links the identity in ONE transaction)
async function createUserIn(unit, ctx, email, method) {
  const ring = ctx.keys.ring.create();
  const enc = E.sealField(ring.keys.get(1), 1, AU.ADDR, email);
  const r = (await unit.sql`select wts.create_user(${ctx.keys.emailBidx(email)}, ${enc}, ${method}, ${ctx.config.terms},
    ${ctx.config.privacy}, now(), ${ring.wrapped}, ${ring.kid}) as id`)[0];
  return (r && r.id) || null;
}
// the account of the unit's user: primary and recovery address (opened), status, created
async function account(unit) {
  const a = await AU.addresses(unit);
  return { email: a.primary, recovery: a.recovery, status: a.u.row.status, created: iso(a.u.row.created_at), u: a.u };
}
const note = (ctx, k, v) => { if (ctx.req && ctx.req.meta) ctx.req.meta[k] = v; };

function createOauthHandlers(deps) {
  deps = deps || {};
  let keyCache = deps.keyCache || null;
  let memBreaker = null;
  const store = (ctx) => (ctx.db ? createOauthStore(ctx.db) : null);
  function providerConfig(ctx, p) {
    if (ctx.config.production) return PINS.resolve(p);
    const ov = deps.override && deps.override[p];
    return PINS.resolve(p, ov ? { override: ov } : {});
  }
  function client(ctx, p) {
    const e = ctx.config.providers[p];
    return { clientId: e.clientId, clientSecret: e.clientSecret, redirectUri: O.redirectUri(ctx.config, p) };
  }
  function breaker(ctx) {
    const st = store(ctx);
    if (deps.breaker) return deps.breaker;
    if (st) return st.breaker;
    return (memBreaker = memBreaker || O.memoryBreaker({}));
  }
  function keys(ctx) {
    if (!keyCache) keyCache = O.createKeyCache({ fetch: deps.fetch, store: ctx.db ? createOauthStore(ctx.db).keys : null, log: ctx.log });
    return keyCache;
  }
  async function providerState(ctx, p) {
    const sw = ctx.config.providerSwitches()[p] || 'off';
    if (sw === 'off') return 'off';
    let open = false;
    try { open = await breaker(ctx).isOpen(p); } catch (e) { open = false; }
    return open ? 'off' : sw;
  }
  const cookieHash = (v) => O.sha256(String(v));
  const attemptCookie = (ctx) => {
    const v = ctx.cookies[C.COOKIES.attemptLax.name];
    return v && /^[A-Za-z0-9_-]{40,64}$/.test(v) ? v : null;
  };
  const AAD = (id) => 'oauth.attempt|' + id;
  const delay = deps.delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // production: no client address → no per-prefix bucket to count in → refuse (and say so in the log, the owner's alert)
  const noPrefix = (ctx) => !!ctx.config.production && !ctx.ipPrefix;
  function needDb(ctx) { S.need(ctx); return store(ctx); }

  // ── finish helpers ───────────────────────────────────────────────────────────────────────────────────────────────
  async function end(ctx, st, a) { await st.attempts.close(a.id); ctx.setCookie(C.COOKIES.attemptLax, null); }
  // a failed finish counts towards the soft limit of §8.3 (10 per prefix per 10 min); beyond it the answer is delayed
  async function noteFail(ctx, st) {
    let over = false;
    try { over = await st.finishFail(ctx.ipPrefix); } catch (e) { over = false; }
    if (over) { ctx.log.warn('oauth finish: failed-finish soft limit for a prefix'); await delay(SOFT_DELAY_MS); }
  }
  async function endFail(ctx, st, a, code, extra) { await end(ctx, st, a); await noteFail(ctx, st); fail(code, extra); }
  // next email | code | consent: new cookie value (Strict, 20 min), expiry = live code + 5 min, ≤ 30 min from start
  async function advance(ctx, st, a, oldHash, state, next, body, codeExpiresAt) {
    const v = O.randomToken(32);
    const until = Math.min(toMs(a.created_at) + 30 * MIN, (codeExpiresAt || Date.now() + 15 * MIN) + 5 * MIN);
    const ok = await st.attempts.extend(oldHash, cookieHash(v), until);
    if (!ok) await endFail(ctx, st, a, 'oauth_state');
    state.step = next;
    await st.attempts.result(a.id, sealJson(ctx, AAD(a.id), state), until);
    ctx.setCookie(C.COOKIES.attemptStrict, v);
    return { status: 200, body: Object.assign({ next }, body) };
  }
  function signupRefusal(ctx, allowed) {
    if (ctx.config.signup === 'off') return 'signup_closed';
    if (ctx.config.signup === 'invite' && !allowed) return 'not_invited';
    return null;
  }
  async function identityBrief(unit, st, userId, identityId) {
    const u = await unit.user();
    const rows = await st.identities.list(unit.sql, userId);
    const i = rows.find((r) => r.id === identityId);
    return i ? methodItem(u, i) : null;
  }
  function methodItem(u, i) {
    const e = tryOpen(u, 'identity.email', i.email_link_enc);
    return { id: i.id, provider: i.provider, emailMasked: e ? V.maskEmail(e) : null, linkedAt: iso(i.linked_at),
      lastUsedAt: i.last_used_at ? iso(i.last_used_at) : null };
  }
  async function linkIn(unit, ctx, st, userId, a, out, via) {
    const u = await unit.user();
    const subjectBidx = ctx.keys.bidx(a.provider + '|' + out.sub);
    let id;
    try {
      id = await st.identities.link(unit.sql, { userId, provider: a.provider, issuer: out.iss, subjectBidx,
        subjectEnc: u.seal('identity.subject', out.sub), emailEnc: out.email ? u.seal('identity.email', out.email) : null,
        emailVerified: !!out.emailVerified, via });
    } catch (e) {
      if (e && (e.code === 'identity_in_use' || e.code === 'provider_linked')) throw new ApiError(e.code);
      throw e;
    }
    await unit.audit('identity_link', { detail: { provider: a.provider, via, identity_id: id, subject_bidx: subjectBidx.toString('hex') } });
    return id;
  }
  // signs `userId` in through identity `identityId` (existing or `link` = {via} to create it first). o.create = {email}
  // creates the account first, IN THE SAME transaction (userId is then ignored): a failed link leaves no account behind.
  // A sign-in revokes the session id the request carried (§4.10 item 5), after the commit, as the e-mail-code sign-in does.
  async function signIn(ctx, st, a, state, userId, o) {
    const out = state.out;
    let res = null;
    try {
      res = await S.unitOf(ctx, o.create ? null : userId, async (unit) => {
        let uid = userId;
        if (o.create) {
          uid = await createUserIn(unit, ctx, o.create.email, a.provider);
          if (!uid) throw new ApiError('oauth_state');                      // the address was taken meanwhile
          await unit.setUser(uid);
        }
        let identityId = o.identityId;
        if (o.link) identityId = await linkIn(unit, ctx, st, uid, a, out, o.link);
        const acc = await account(unit);
        const lb = a.device_label_enc ? (open(ctx, 'oauth.label', a.device_label_enc) || '').toString() : '';
        const dev = await S.deviceFor(unit, ctx, uid, { label: V.isLabel(lb) ? lb : '', publicDevice: a.public_device });
        const s = await SE.issue(unit, ctx, { userId: uid, deviceId: dev.id, publicDevice: a.public_device, method: a.provider, identityId, stepup: !!o.stepup, signup: !!o.create });
        await st.identities.touch(unit.sql, identityId);
        // U18: the provider e-mail differs from the one recorded at link time and from the last one acknowledged → say so
        // once (the index is stored as acknowledged when the note is shown)
        let differs = false;
        if (out.email && !o.link) {
          const rows = await st.identities.list(unit.sql, uid);
          const i = rows.find((r) => r.id === identityId);
          const at = i ? (tryOpen(acc.u, 'identity.email', i.email_link_enc) || '') : '';
          const eb = ctx.keys.bidx(out.email);
          if (i && at !== out.email && !(i.email_ack_bidx && Buffer.compare(i.email_ack_bidx, eb) === 0)) {
            differs = true;
            await st.identities.ack(unit.sql, identityId, eb);
          }
        }
        if (o.create) await unit.audit('signup', { deviceId: dev.id, detail: { method: a.provider } });
        if (o.create && o.create.profile && !I.isEmptyProfile(o.create.profile)) await I.storeProfile(unit, o.create.profile, 'signup', dev.id);
        await unit.audit('signin', { deviceId: dev.id, detail: { method: a.provider, identity_id: identityId, newDevice: dev.isNew } });
        if (o.link) await unit.mail(acc.email, 'notice_identity_linked', Object.assign(AU.mailParams(unit), { provider: a.provider }));
        if (dev.isNew && !o.create) await unit.mail(acc.email, 'notice_new_device', AU.mailParams(unit));
        return { next: 'done', user: { id: uid, emailMasked: V.maskEmail(acc.email), created: acc.created }, firstSignIn: !!o.first,
          device: { id: dev.id, label: dev.label || '' }, session: { publicDevice: !!s.publicDevice, idleExpires: iso(s.idleExpires), absExpires: iso(s.absExpires) },
          method: a.provider, providerEmailDiffers: differs };
      });
    } catch (e) {
      if (e instanceof ApiError) await endFail(ctx, st, a, e.code);
      throw e;
    }
    await end(ctx, st, a);
    try { await SE.revokePresented(ctx); } catch (e) { ctx.log.warn('oauth finish: revoke presented session failed'); }
    note(ctx, 'uid', res.user.id);
    return { status: 200, body: res };
  }
  // the status check of §4.12 on a found account: locked → 403; deleting → a code to the primary (cancel_deletion)
  async function statusGate(ctx, st, a, oldHash, state, userId, status) {
    if (status === 'locked') await endFail(ctx, st, a, 'locked');
    if (status === 'deleting') {
      const r = await S.unitOf(ctx, userId, async (unit) => {
        const acc = await account(unit);
        const c = await issueCode(unit, ctx, { email: acc.email, purpose: 'oauth_verify', bind: { attempt: a.id }, template: 'code_cancel_deletion' });
        return { email: acc.email, expiresAt: c.expiresAt };
      });
      state.pending = { email: r.email, reason: 'cancel_deletion', userId };
      return advance(ctx, st, a, oldHash, state, 'code', { emailMasked: V.maskEmail(r.email), reason: 'cancel_deletion' }, r.expiresAt);
    }
    return null;
  }

  const handlers = {
    async providers(ctx) {
      const o = {};
      for (const p of C.PROVIDERS) o[p] = await providerState(ctx, p);
      return { status: 200, body: o };
    },

    async oauthStart(ctx) {
      const p = ctx.params.provider; const b = ctx.body;
      const sw = await providerState(ctx, p);
      if (sw === 'off') fail('provider_off', { provider: p });
      const st = needDb(ctx);
      let bound = null;
      if (b.purpose === 'link') {
        if (sw === 'signin') fail('provider_off', { provider: p });
        bound = await SE.withSession(ctx, { stepup: true }, async (unit, s) => s);   // the only step-up check of a link (§3.3)
      }
      if (noPrefix(ctx)) { ctx.log.warn('oauth start: no client address (check WTS_CLIENT_IP_HEADER)'); fail('provider_off', { provider: p }); }
      const cfg = providerConfig(ctx, p);
      const fresh = !!(b.publicDevice || b.sharedBrowser);
      if (fresh && !cfg.freshLogin) fail('oauth_failed', { reason: 'reauth_stale' });
      try {
        const sl = await S.unitOf(ctx, null, (unit) => R.hit(unit.sql, 'oauthStartIpHour', ctx.ipPrefix || 'unknown'));
        if (sl.over) ctx.log.warn('soft limit: oauth start for a prefix');
      } catch (e) { /* counting never blocks a start */ }
      const old = attemptCookie(ctx);
      if (old) await st.attempts.drop(cookieHash(old));                // one live attempt per browser
      const cookie = O.randomToken(32); const state = O.randomToken(32); const nonce = O.randomToken(32); const pk = O.pkce();
      const stateHash = O.sha256(state);
      const label = b.deviceLabel && V.isLabel(b.deviceLabel) ? b.deviceLabel : '';
      const id = await st.attempts.create({ cookieHash: cookieHash(cookie), provider: p, purpose: b.purpose, stateHash, nonce: Buffer.from(nonce),
        verifierEnc: seal(ctx, 'oauth.pkce|' + stateHash.toString('hex'), pk.verifier), boundSid: bound ? bound.presentedHash : null,
        boundUser: bound ? bound.userId : null, publicDevice: !!b.publicDevice, freshLogin: fresh,
        labelEnc: label ? seal(ctx, 'oauth.label', label) : null, expiresAt: Date.now() + 10 * MIN, ipPrefix: ctx.ipPrefix });
      if (!id) { ctx.log.warn('oauth start: live-attempt ceiling for a prefix'); fail('provider_off', { provider: p }); }
      const cl = client(ctx, p);
      const url = O.authorizationUrl(cfg, { clientId: cl.clientId, redirectUri: cl.redirectUri, state, nonce, challenge: pk.challenge, fresh });
      ctx.setCookie(C.COOKIES.attemptLax, cookie);
      return { status: 200, body: { url } };
    },

    // Always ends in the constant 303 (core/app.js) — whatever happens here, nothing reaches the URL.
    async oauthCallback(ctx) {
      const p = ctx.params.provider; const q = ctx.query;
      const v = attemptCookie(ctx);
      if (!v || typeof q.state !== 'string' || q.state.length > 256 || !ctx.db || !ctx.keys || !ctx.keys.ready) { note(ctx, 'outcome', 'state'); return { status: 303 }; }
      const st = store(ctx);
      const a = await st.attempts.take(cookieHash(v), O.sha256(q.state), p);      // burnt before anything else
      if (!a) { note(ctx, 'outcome', 'state'); return { status: 303 }; }
      const cfg = providerConfig(ctx, p);
      // the outcome is kept in the attempt; the access line records only whether the exchange went through
      const put = (out) => { note(ctx, 'outcome', out && out.fail ? 'exchange_failed' : 'ok');
        return st.attempts.result(a.id, sealJson(ctx, AAD(a.id), { out, step: null, pending: null }), null); };
      if (q.error !== undefined) {
        const m = O.mapCallbackError(p, q.error);
        ctx.log.info('oauth callback: provider error ' + m.logged);              // never error_description
        await put({ fail: m.reason });
        return { status: 303 };
      }
      if (cfg.callbackIss && q.iss !== cfg.issuers[0]) { await put({ fail: 'provider' }); return { status: 303 }; }
      if (typeof q.code !== 'string' || !q.code || q.code.length > 2048) { await put({ fail: 'provider' }); return { status: 303 }; }
      if (noPrefix(ctx)) {
        ctx.log.warn('oauth callback: no client address (check WTS_CLIENT_IP_HEADER)');
        await put({ fail: 'provider' });
        return { status: 303 };
      }
      if (!(await st.exchangeHit(ctx.ipPrefix))) {
        ctx.log.warn('oauth callback: exchange ceiling for a prefix');
        await put({ fail: 'provider' });
        return { status: 303 };
      }
      const cl = client(ctx, p);
      const verifier = open(ctx, 'oauth.pkce|' + O.sha256(q.state).toString('hex'), a.pkce_verifier_enc);
      if (!verifier) { await put({ fail: 'provider' }); return { status: 303 }; }
      const ex = await O.exchangeCode(cfg, { code: q.code, verifier: verifier.toString(), clientId: cl.clientId, clientSecret: cl.clientSecret,
        redirectUri: cl.redirectUri, fetch: deps.fetch });
      let out;
      let bad = !!ex.providerFailure;
      if (!ex.ok) out = { fail: ex.reason };
      else {
        const vr = await O.verifyIdToken(ex.idToken, { cfg, clientId: cl.clientId, nonce: Buffer.from(a.nonce).toString(), freshLogin: a.fresh_login,
          attemptCreatedAt: toMs(a.created_at), now: Date.now(), getKey: (c, kid) => keys(ctx).getKey(c, kid) });
        if (vr.providerFailure) bad = true;
        out = vr.ok ? vr.claims : { fail: vr.reason };
      }
      try { if (await breaker(ctx).note(p, bad)) ctx.log.warn('oauth: breaker open for ' + p); } catch (e) { /* counting never blocks */ }
      await put(out);
      return { status: 303 };
    },

    async oauthFinish(ctx) {
      const st = needDb(ctx);
      const v = attemptCookie(ctx);
      if (!v) fail('oauth_state');
      const oldHash = cookieHash(v);
      const presented = ctx.cookies[C.COOKIES.session.name];
      const a = await st.attempts.finish(oldHash, presented ? ctx.keys.sidHash(presented) : null);
      if (!a) { ctx.setCookie(C.COOKIES.attemptLax, null); fail('oauth_state'); }
      note(ctx, 'provider', a.provider);
      // one finish per attempt at a time: a second call with the same cookie while one runs is refused (its cookie is left
      // alone — the running call answers for the browser)
      if (!(await st.attempts.claim(a.id))) fail('oauth_state');
      try { return await finishStep(ctx, st, a, oldHash); }
      finally { try { await st.attempts.release(a.id); } catch (e) { /* release is best effort; the claim expires in 30 s */ } }
    },
  };

  // the body of POST /auth/oauth/finish, run while this request holds the attempt's claim
  async function finishStep(ctx, st, a, oldHash) {
    const state = openJson(ctx, AAD(a.id), a.result_enc);
    if (!state || !state.out) await endFail(ctx, st, a, 'oauth_state');
    const out = state.out; const p = a.provider;
    if (out.fail) await endFail(ctx, st, a, 'oauth_failed', { reason: out.fail });
    let linkSession = null;
    if (a.purpose === 'link') {
      linkSession = await SE.resolve(ctx);
      if (!linkSession || linkSession.userId !== a.bound_user) await endFail(ctx, st, a, 'oauth_state');
      note(ctx, 'uid', linkSession.userId);
    }
    const b = ctx.body || {};
    const bodyKeys = ['email', 'code', 'consent'].filter((k) => b[k] !== undefined);

    // ── later steps ──
    if (b.email !== undefined) {
      if (state.step !== 'email') fail('oauth_state');
      const e = V.normEmail(b.email);
      if (!e) fail('bad_request', { field: 'email' });
      state.pending = { email: e, reason: 'verify' };
      const c = await S.unitOf(ctx, null, async (unit) => {
        // review fix: with sign-up off (or invite-only and the address not listed) an address with no account gets nothing —
        // the provider path is no way around the sign-up switch for sending mail; the reply stays the uniform next 'code'
        const send = !!(await userByEmail(unit, ctx, e)) || !signupRefusal(ctx, await allowlistHas(unit, ctx, e));
        return issueCode(unit, ctx, { email: e, purpose: 'oauth_verify', bind: { attempt: a.id }, template: 'code_oauth_verify', params: { provider: p }, send });
      });
      return advance(ctx, st, a, oldHash, state, 'code', { emailMasked: V.maskEmail(e), reason: 'verify' }, c.expiresAt);   // uniform: always next code
    }
    if (b.code !== undefined) {
      if (state.step !== 'code' || !state.pending) fail('oauth_state');
      const pend = state.pending;
      const link = pend.reason === 'link_confirm';
      const ok = await S.unitOf(ctx, link ? a.bound_user : null, (unit) => checkCode(unit, ctx, { email: pend.email, purpose: link ? 'link_confirm' : 'oauth_verify',
        code: b.code, bind: link ? { attempt: a.id, user: a.bound_user, sid: a.bound_sid } : { attempt: a.id } }));
      if (!ok) { await noteFail(ctx, st); fail('invalid_or_expired'); }
      if (link) {
        // rule 2: linked after the link-confirm code; the code does not set stepup_at
        let linked;
        try {
          linked = await S.unitOf(ctx, a.bound_user, async (unit) => {
            const id = await linkIn(unit, ctx, st, a.bound_user, a, out, 'account_page');
            const acc = await account(unit);
            await unit.mail(acc.email, 'notice_identity_linked', Object.assign(AU.mailParams(unit), { provider: p }));
            return { brief: await identityBrief(unit, st, a.bound_user, id) };
          });
        } catch (e) { if (e instanceof ApiError) await endFail(ctx, st, a, e.code); throw e; }
        await end(ctx, st, a);
        return { status: 200, body: { next: 'done', linked: linked.brief } };
      }
      if (pend.reason === 'cancel_deletion') {
        // the code to the account's own address: same proof as a code sign-in (stepup_at = now); the page then offers
        // Cancel deletion (POST /account/delete/cancel)
        const known = await st.identities.bySubject(p, ctx.keys.bidx(p + '|' + out.sub));
        if (known && known.userId === pend.userId) return signIn(ctx, st, a, state, pend.userId, { identityId: known.identityId, stepup: true });
        return signIn(ctx, st, a, state, pend.userId, { link: 'code_confirm', stepup: true });
      }
      const acc = await S.unitOf(ctx, null, (unit) => userByEmail(unit, ctx, pend.email));
      if (acc) {
        // rules 4 and 5: the code proved the address an account uses → link and sign in (stepup_at = now)
        if (acc.status === 'locked') await endFail(ctx, st, a, 'locked');
        if (acc.status === 'deleting') return statusGate(ctx, st, a, oldHash, state, acc.userId, 'deleting');
        return signIn(ctx, st, a, state, acc.userId, { link: 'code_confirm', stepup: true });
      }
      const why = signupRefusal(ctx, await S.unitOf(ctx, null, (unit) => allowlistHas(unit, ctx, pend.email)));
      if (why) await endFail(ctx, st, a, why);
      if ((await providerState(ctx, p)) === 'signin') await endFail(ctx, st, a, 'provider_off', { provider: p });
      state.pending = { email: pend.email, reason: 'signup', proved: true };
      return advance(ctx, st, a, oldHash, state, 'consent', Object.assign({ newAccountEmailMasked: V.maskEmail(pend.email), terms: ctx.config.terms, privacy: ctx.config.privacy }, countryHint(ctx)));
    }
    if (b.consent !== undefined) {
      if (state.step !== 'consent' || !state.pending) fail('oauth_state');
      if (b.consent.terms !== ctx.config.terms || b.consent.privacy !== ctx.config.privacy) fail('consent_required', { terms: ctx.config.terms, privacy: ctx.config.privacy });
      // the optional profile (insight follow-up), stored with the new account in the same transaction
      const profile = b.profile !== undefined ? I.normProfile(b.profile) : null;
      const email = state.pending.email;
      const why = signupRefusal(ctx, await S.unitOf(ctx, null, (unit) => allowlistHas(unit, ctx, email)));
      if (why) await endFail(ctx, st, a, why);
      return signIn(ctx, st, a, state, null, { create: { email, profile }, link: 'signup', stepup: !!state.pending.proved, first: true });
    }
    if (state.step || bodyKeys.length) fail('oauth_state');

    // ── first call: the linking rules of §4.12 ──
    const subjectBidx = ctx.keys.bidx(p + '|' + out.sub);
    const known = await st.identities.bySubject(p, subjectBidx);
    if (a.purpose === 'link') {
      if (known) {
        if (known.userId !== a.bound_user) await endFail(ctx, st, a, 'identity_in_use');
        const brief = await S.unitOf(ctx, a.bound_user, (unit) => identityBrief(unit, st, a.bound_user, known.identityId));
        await end(ctx, st, a);
        return { status: 200, body: { next: 'done', linked: brief } };
      }
      // the link-confirm code goes to the account's own address, issued in that user's transaction (bound user + session)
      const info = await S.unitOf(ctx, a.bound_user, async (unit) => {
        const acc = await account(unit);
        if ((await st.identities.list(unit.sql, a.bound_user)).some((i) => i.provider === p)) return { has: true };
        const c = await issueCode(unit, ctx, { email: acc.email, purpose: 'link_confirm', bind: { attempt: a.id, user: a.bound_user, sid: a.bound_sid },
          template: 'code_link_confirm', params: { provider: p, providerEmailMasked: out.email ? V.maskEmail(out.email) : '(none)' } });
        return { has: false, email: acc.email, expiresAt: c.expiresAt };
      });
      if (info.has) await endFail(ctx, st, a, 'provider_linked');
      state.pending = { email: info.email, reason: 'link_confirm' };
      const c = { expiresAt: info.expiresAt };
      return advance(ctx, st, a, oldHash, state, 'code', { emailMasked: V.maskEmail(info.email), reason: 'link_confirm' }, c.expiresAt);
    }
    if (known) {                                                         // rule 1
      const g = await statusGate(ctx, st, a, oldHash, state, known.userId, known.status); if (g) return g;
      return signIn(ctx, st, a, state, known.userId, { identityId: known.identityId, stepup: false });
    }
    const cfg = providerConfig(ctx, p);
    if (O.emailTrusted(cfg, out)) {
      const acc = await S.unitOf(ctx, null, (unit) => userByEmail(unit, ctx, out.email));
      if (acc) {                                                         // rule 4: never linked without the code
        const g = await statusGate(ctx, st, a, oldHash, state, acc.userId, acc.status); if (g) return g;
        state.pending = { email: out.email, reason: 'link_existing' };
        const c = await S.unitOf(ctx, null, (unit) => issueCode(unit, ctx, { email: out.email, purpose: 'oauth_verify', bind: { attempt: a.id }, template: 'code_oauth_verify', params: { provider: p } }));
        return advance(ctx, st, a, oldHash, state, 'code', { emailMasked: V.maskEmail(out.email), reason: 'link_existing' }, c.expiresAt);
      }
      // rule 3
      if ((await providerState(ctx, p)) === 'signin') await endFail(ctx, st, a, 'provider_off', { provider: p });
      const why = signupRefusal(ctx, await S.unitOf(ctx, null, (unit) => allowlistHas(unit, ctx, out.email)));
      if (why) await endFail(ctx, st, a, why);
      state.pending = { email: out.email, reason: 'signup', proved: false };
      return advance(ctx, st, a, oldHash, state, 'consent', Object.assign({ newAccountEmailMasked: V.maskEmail(out.email), terms: ctx.config.terms, privacy: ctx.config.privacy }, countryHint(ctx)));
    }
    // rule 5: missing, unverified or unmanaged → ask for an address, then our code
    const reason = !out.email ? 'missing' : (!out.emailVerified ? 'unverified' : 'unmanaged');
    return advance(ctx, st, a, oldHash, state, 'email', { reason, emailPrefill: out.email || null });
  }

  Object.assign(handlers, {
    async methods(ctx) {
      const st = needDb(ctx);
      const body = await SE.withSession(ctx, {}, (unit, s) => methodsOf(unit, st, s.userId));
      return { status: 200, body };
    },

    async unlink(ctx) {
      const st = needDb(ctx);
      const r = await SE.withSession(ctx, { stepup: true }, async (unit, s) => {
        const rows = await st.identities.list(unit.sql, s.userId);
        const i = rows.find((x) => x.id === ctx.body.id);
        if (!i) throw new ApiError('not_found');
        const passkeys = await unit.sql`select count(*)::int as n from wts.passkeys where user_id = ${s.userId}`;
        // the e-mail code is always a method (every account has a verified primary), so this guards a later passkey-only mode
        const remaining = 1 + (rows.length - 1) + passkeys[0].n;
        if (remaining < 1) throw new ApiError('last_method');
        const n = await st.identities.unlink(unit.sql, i.id);
        if (n === null) throw new ApiError('not_found');
        await unit.audit('identity_unlink', { deviceId: s.deviceId, detail: { provider: i.provider, identity_id: i.id, subject_bidx: Buffer.from(i.subject_bidx).toString('hex') } });
        const acc = await account(unit);
        await unit.mail(acc.email, 'notice_identity_unlinked', { provider: i.provider, at: S.whenText(Date.now()) });
        return { n, methods: await methodsOf(unit, st, s.userId) };
      });
      return { status: 200, body: { ok: true, methods: r.methods, sessionsRevoked: r.n } };
    },
  });

  async function methodsOf(unit, st, userId) {
    const acc = await account(unit);
    const ids = await st.identities.list(unit.sql, userId);
    const pk = await unit.sql`select id, name_enc, created_at, last_used_at from wts.passkeys where user_id = ${userId} order by created_at`;
    const m = { email: { masked: V.maskEmail(acc.email) }, identities: ids.map((i) => methodItem(acc.u, i)),
      passkeys: pk.map((k) => ({ id: k.id, name: tryOpen(acc.u, 'passkey.name', k.name_enc) || '', created: iso(k.created_at),
        lastUsed: k.last_used_at ? iso(k.last_used_at) : null })) };
    if (acc.recovery) m.recovery = { masked: V.maskEmail(acc.recovery) };
    return m;
  }

  return handlers;
}

// countryHint (user insight): the platform-detected country, the default of the optional sign-up profile (only when known)
function countryHint(ctx) { return ctx.geo && ctx.geo.country ? { countryHint: ctx.geo.country } : {}; }
module.exports = { handlers: createOauthHandlers({}), createOauthHandlers };
