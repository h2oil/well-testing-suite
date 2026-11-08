'use strict';
// server/functions/oauth.js — provider sign-in (docs/ACCOUNTS-PLAN.md §3.3, §4.10–4.15, §8.3): GET /auth/providers,
// POST /auth/oauth/:provider/start, GET /auth/oauth/:provider/callback, POST /auth/oauth/finish, GET /auth/methods and
// POST /auth/methods/unlink.
//
//   handlers                       the production handlers (global fetch, pinned configuration)
//   createOauthHandlers(deps)      deps: {fetch, override:{google?, linkedin?} (test / dev endpoints; refused on the production
//                                  host), keyCache, breaker} — the server tests pass the fake provider here
//
// Rules kept here (see the plan for each): the attempt cookie __Host-wts_oa (Lax to the callback, re-issued Strict by finish
// for a code / e-mail / consent step); the callback reads only that cookie, burns the attempt BEFORE the exchange, never
// reads or sets the session cookie and always ends in the constant 303 (core/app.js); provider errors through the allow-list
// (the description is never read); per-prefix ceilings (20 live attempts, 30 exchanges per 10 min); the provider-side breaker;
// the linking rules 1–8 of §4.12; stepup_at is set only by an oauth_verify code (rules 4 and 5, cancel-deletion), never by a
// provider sign-in and never by a link_confirm code; a sign-in finish revokes the session id the request carried; unlink
// revokes every session the identity created. No code, state, token, claim or e-mail is ever logged.
//
// WP-S1 pieces (sessions, codes, account lookups, audit, mail, envelope) come through core/wpo-s1.js (WP-O shim).

const C = require('../core/contract');
const V = require('../core/validate');
const O = require('../core/oidc');
const PINS = require('../core/oidc-providers');
const S1 = require('../core/wpo-s1');
const { ApiError, fail } = require('../core/errors');
const { createOauthStore } = require('../core/oauth-store');

const MIN = 60 * 1000;

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
  const AAD = (id) => 'oauth-attempt|' + id;
  function needDb(ctx) { if (!ctx.db) throw new ApiError('not_implemented'); return store(ctx); }

  // ── finish helpers ───────────────────────────────────────────────────────────────────────────────────────────────
  async function end(ctx, st, a) { await st.attempts.close(a.id); ctx.setCookie(C.COOKIES.attemptLax, null); }
  async function endFail(ctx, st, a, code, extra) { await end(ctx, st, a); fail(code, extra); }
  // next email | code | consent: new cookie value (Strict, 20 min), expiry = live code + 5 min, ≤ 30 min from start
  async function advance(ctx, st, a, oldHash, state, next, body, codeExpiresAt) {
    const v = O.randomToken(32);
    const until = Math.min(S1.toMs(a.created_at) + 30 * MIN, (codeExpiresAt || Date.now() + 15 * MIN) + 5 * MIN);
    const ok = await st.attempts.extend(oldHash, cookieHash(v), until);
    if (!ok) await endFail(ctx, st, a, 'oauth_state');
    state.step = next;
    await st.attempts.result(a.id, S1.sealJson(ctx.config, state, AAD(a.id)), until);
    ctx.setCookie(C.COOKIES.attemptStrict, v);
    return { status: 200, body: Object.assign({ next }, body) };
  }
  function signupRefusal(ctx, allowed) {
    if (ctx.config.signup === 'off') return 'signup_closed';
    if (ctx.config.signup === 'invite' && !allowed) return 'not_invited';
    return null;
  }
  async function identityBrief(ctx, tx, st, userId, identityId) {
    const rows = await st.identities.list(tx, userId);
    const i = rows.find((r) => r.id === identityId);
    return i ? methodItem(ctx, userId, i) : null;
  }
  function methodItem(ctx, userId, i) {
    const e = i.email_link_enc ? S1.open(ctx.config, i.email_link_enc, 'identity-email|' + userId) : null;
    return { id: i.id, provider: i.provider, emailMasked: e ? V.maskEmail(e.toString()) : null, linkedAt: S1.iso(i.linked_at),
      lastUsedAt: i.last_used_at ? S1.iso(i.last_used_at) : null };
  }
  async function linkIn(ctx, tx, st, userId, a, out, via) {
    let id;
    try {
      id = await st.identities.link(tx, { userId, provider: a.provider, issuer: out.iss, subjectBidx: S1.bidx(ctx.config, a.provider + '|' + out.sub),
        subjectEnc: S1.seal(ctx.config, out.sub, 'identity-subject|' + userId), emailEnc: out.email ? S1.seal(ctx.config, out.email, 'identity-email|' + userId) : null,
        emailVerified: !!out.emailVerified, via });
    } catch (e) {
      if (e && (e.code === 'identity_in_use' || e.code === 'provider_linked')) throw new ApiError(e.code);
      throw e;
    }
    await S1.audit(ctx, tx, userId, 'identity_link', { provider: a.provider, via, identity_id: id, subject_bidx: S1.bidx(ctx.config, a.provider + '|' + out.sub).toString('hex') });
    return id;
  }
  // signs `userId` in through identity `identityId` (existing or `link` = {via} to create it first)
  async function signIn(ctx, st, a, state, userId, o) {
    const out = state.out;
    let res = null; let linkedNotice = null; let email = null; let newDevice = false;
    try {
      res = await ctx.db.asUser(userId, async (tx) => {
        let identityId = o.identityId;
        if (o.link) { identityId = await linkIn(ctx, tx, st, userId, a, out, o.link); linkedNotice = a.provider; }
        const acc = await S1.userEmail(tx, ctx.config, userId);
        email = acc.email;
        const label = a.device_label_enc ? (S1.open(ctx.config, a.device_label_enc, 'oauth-label') || '').toString() : '';
        const dev = await S1.ensureDevice(ctx, tx, userId, label, a.public_device);
        newDevice = dev.isNew;
        const s = await S1.issueSession(ctx, tx, userId, { publicDevice: a.public_device, deviceId: dev.id, method: a.provider, identityId, stepup: !!o.stepup });
        await st.identities.touch(tx, identityId);
        // U18: the provider e-mail differs from the one recorded at link time and from the last one acknowledged → say so
        // once (the index is stored as acknowledged when the note is shown)
        let differs = false;
        if (out.email && !o.link) {
          const rows = await st.identities.list(tx, userId);
          const i = rows.find((r) => r.id === identityId);
          const at = i && i.email_link_enc ? (S1.open(ctx.config, i.email_link_enc, 'identity-email|' + userId) || '').toString() : '';
          const eb = S1.bidx(ctx.config, out.email);
          if (i && at !== out.email && !(i.email_ack_bidx && Buffer.compare(i.email_ack_bidx, eb) === 0)) {
            differs = true;
            await st.identities.ack(tx, identityId, eb);
          }
        }
        await S1.audit(ctx, tx, userId, 'signin', { method: a.provider, identity_id: identityId, device_id: dev.id });
        return { next: 'done', user: { id: userId, emailMasked: V.maskEmail(acc.email), created: acc.created }, firstSignIn: !!o.first,
          device: { id: dev.id, label: dev.label || '' }, session: { publicDevice: s.publicDevice, idleExpires: s.idleExpires, absExpires: s.absExpires },
          method: a.provider, providerEmailDiffers: differs };
      });
    } catch (e) {
      if (e instanceof ApiError) await endFail(ctx, st, a, e.code);
      throw e;
    }
    await end(ctx, st, a);
    if (linkedNotice) await S1.sendMail(ctx, email, 'notice_identity_linked', { provider: linkedNotice });
    if (newDevice) await S1.sendMail(ctx, email, 'notice_new_device', {});
    return { status: 200, body: res };
  }
  // the status check of §4.12 on a found account: locked → 403; deleting → a code to the primary (cancel_deletion)
  async function statusGate(ctx, st, a, oldHash, state, userId, status) {
    if (status === 'locked') await endFail(ctx, st, a, 'locked');
    if (status === 'deleting') {
      const acc = await ctx.db.asUser(userId, (tx) => S1.userEmail(tx, ctx.config, userId));
      const c = await S1.issueCode(ctx, { email: acc.email, purpose: 'oauth_verify', bind: { attempt: a.id }, template: 'code_cancel_deletion' });
      state.pending = { email: acc.email, reason: 'cancel_deletion', userId };
      return advance(ctx, st, a, oldHash, state, 'code', { emailMasked: V.maskEmail(acc.email), reason: 'cancel_deletion' }, c.expiresAt);
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
        bound = await S1.requireSession(ctx, { stepup: true });        // the only step-up check of a link (§3.3)
      }
      const cfg = providerConfig(ctx, p);
      const fresh = !!(b.publicDevice || b.sharedBrowser);
      if (fresh && !cfg.freshLogin) fail('oauth_failed', { reason: 'reauth_stale' });
      await S1.softLimit(ctx, 'oauth_start:' + (ctx.ipPrefix || 'unknown'), 3600, 60);
      const old = attemptCookie(ctx);
      if (old) await st.attempts.drop(cookieHash(old));                // one live attempt per browser
      const cookie = O.randomToken(32); const state = O.randomToken(32); const nonce = O.randomToken(32); const pk = O.pkce();
      const stateHash = O.sha256(state);
      const label = b.deviceLabel && V.isLabel(b.deviceLabel) ? b.deviceLabel : '';
      const id = await st.attempts.create({ cookieHash: cookieHash(cookie), provider: p, purpose: b.purpose, stateHash, nonce: Buffer.from(nonce),
        verifierEnc: S1.seal(ctx.config, pk.verifier, 'pkce|' + stateHash.toString('hex')), boundSid: bound ? bound.sidHash : null,
        boundUser: bound ? bound.userId : null, publicDevice: !!b.publicDevice, freshLogin: fresh,
        labelEnc: label ? S1.seal(ctx.config, label, 'oauth-label') : null, expiresAt: Date.now() + 10 * MIN, ipPrefix: ctx.ipPrefix });
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
      if (!v || typeof q.state !== 'string' || q.state.length > 256 || !ctx.db) return { status: 303 };
      const st = store(ctx);
      const a = await st.attempts.take(cookieHash(v), O.sha256(q.state), p);      // burnt before anything else
      if (!a) return { status: 303 };
      const cfg = providerConfig(ctx, p);
      const put = (out) => st.attempts.result(a.id, S1.sealJson(ctx.config, { out, step: null, pending: null }, AAD(a.id)), null);
      if (q.error !== undefined) {
        const m = O.mapCallbackError(p, q.error);
        ctx.log.info('oauth callback: provider error ' + m.logged);              // never error_description
        await put({ fail: m.reason });
        return { status: 303 };
      }
      if (cfg.callbackIss && q.iss !== cfg.issuers[0]) { await put({ fail: 'provider' }); return { status: 303 }; }
      if (typeof q.code !== 'string' || !q.code || q.code.length > 2048) { await put({ fail: 'provider' }); return { status: 303 }; }
      if (!(await st.exchangeHit(ctx.ipPrefix))) {
        ctx.log.warn('oauth callback: exchange ceiling for a prefix');
        await put({ fail: 'provider' });
        return { status: 303 };
      }
      const cl = client(ctx, p);
      const verifier = S1.open(ctx.config, a.pkce_verifier_enc, 'pkce|' + O.sha256(q.state).toString('hex'));
      if (!verifier) { await put({ fail: 'provider' }); return { status: 303 }; }
      const ex = await O.exchangeCode(cfg, { code: q.code, verifier: verifier.toString(), clientId: cl.clientId, clientSecret: cl.clientSecret,
        redirectUri: cl.redirectUri, fetch: deps.fetch });
      let out;
      let bad = !!ex.providerFailure;
      if (!ex.ok) out = { fail: ex.reason };
      else {
        const vr = await O.verifyIdToken(ex.idToken, { cfg, clientId: cl.clientId, nonce: Buffer.from(a.nonce).toString(), freshLogin: a.fresh_login,
          attemptCreatedAt: S1.toMs(a.created_at), now: Date.now(), getKey: (c, kid) => keys(ctx).getKey(c, kid) });
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
      const a = await st.attempts.finish(oldHash, presented ? S1.sidHash(presented) : null);
      if (!a) { ctx.setCookie(C.COOKIES.attemptLax, null); fail('oauth_state'); }
      const state = S1.openJson(ctx.config, a.result_enc, AAD(a.id));
      if (!state || !state.out) await endFail(ctx, st, a, 'oauth_state');
      const out = state.out; const p = a.provider;
      if (out.fail) await endFail(ctx, st, a, 'oauth_failed', { reason: out.fail });
      let linkSession = null;
      if (a.purpose === 'link') {
        linkSession = await S1.resolveSession(ctx);
        if (!linkSession || linkSession.userId !== a.bound_user) await endFail(ctx, st, a, 'oauth_state');
      }
      const b = ctx.body || {};
      const bodyKeys = ['email', 'code', 'consent'].filter((k) => b[k] !== undefined);

      // ── later steps ──
      if (b.email !== undefined) {
        if (state.step !== 'email') fail('oauth_state');
        const e = V.normEmail(b.email);
        if (!e) fail('bad_request', { field: 'email' });
        state.pending = { email: e, reason: 'verify' };
        const c = await S1.issueCode(ctx, { email: e, purpose: 'oauth_verify', bind: { attempt: a.id }, template: 'code_oauth_verify', params: { provider: p } });
        return advance(ctx, st, a, oldHash, state, 'code', { emailMasked: V.maskEmail(e), reason: 'verify' }, c.expiresAt);   // uniform: always next code
      }
      if (b.code !== undefined) {
        if (state.step !== 'code' || !state.pending) fail('oauth_state');
        const pend = state.pending;
        const link = pend.reason === 'link_confirm';
        const ok = await S1.checkCode(ctx, { email: pend.email, purpose: link ? 'link_confirm' : 'oauth_verify', code: b.code,
          bind: link ? { attempt: a.id, user: a.bound_user, sid: a.bound_sid } : { attempt: a.id } });
        if (!ok) fail('invalid_or_expired');
        if (link) {
          // rule 2: linked after the link-confirm code; the code does not set stepup_at
          let linked;
          try {
            linked = await ctx.db.asUser(a.bound_user, async (tx) => {
              const id = await linkIn(ctx, tx, st, a.bound_user, a, out, 'account_page');
              const acc = await S1.userEmail(tx, ctx.config, a.bound_user);
              return { brief: await identityBrief(ctx, tx, st, a.bound_user, id), email: acc.email };
            });
          } catch (e) { if (e instanceof ApiError) await endFail(ctx, st, a, e.code); throw e; }
          await end(ctx, st, a);
          await S1.sendMail(ctx, linked.email, 'notice_identity_linked', { provider: p });
          return { status: 200, body: { next: 'done', linked: linked.brief } };
        }
        if (pend.reason === 'cancel_deletion') {
          // the code to the account's own address: same proof as a code sign-in (stepup_at = now); the page then offers
          // Cancel deletion (POST /account/delete/cancel)
          const known = await st.identities.bySubject(p, S1.bidx(ctx.config, p + '|' + out.sub));
          if (known && known.userId === pend.userId) return signIn(ctx, st, a, state, pend.userId, { identityId: known.identityId, stepup: true });
          return signIn(ctx, st, a, state, pend.userId, { link: 'code_confirm', stepup: true });
        }
        const acc = await S1.userByEmail(ctx, pend.email);
        if (acc) {
          // rules 4 and 5: the code proved the address an account uses → link and sign in (stepup_at = now)
          if (acc.status === 'locked') await endFail(ctx, st, a, 'locked');
          if (acc.status === 'deleting') return statusGate(ctx, st, a, oldHash, state, acc.userId, 'deleting');
          return signIn(ctx, st, a, state, acc.userId, { link: 'code_confirm', stepup: true });
        }
        const why = signupRefusal(ctx, await S1.allowlistHas(ctx, pend.email));
        if (why) await endFail(ctx, st, a, why);
        if ((await providerState(ctx, p)) === 'signin') await endFail(ctx, st, a, 'provider_off', { provider: p });
        state.pending = { email: pend.email, reason: 'signup', proved: true };
        return advance(ctx, st, a, oldHash, state, 'consent', { newAccountEmailMasked: V.maskEmail(pend.email), terms: ctx.config.terms, privacy: ctx.config.privacy });
      }
      if (b.consent !== undefined) {
        if (state.step !== 'consent' || !state.pending) fail('oauth_state');
        if (b.consent.terms !== ctx.config.terms || b.consent.privacy !== ctx.config.privacy) fail('consent_required', { terms: ctx.config.terms, privacy: ctx.config.privacy });
        const email = state.pending.email;
        const why = signupRefusal(ctx, await S1.allowlistHas(ctx, email));
        if (why) await endFail(ctx, st, a, why);
        const uid = await S1.createUser(ctx, { email, method: p });
        if (!uid) await endFail(ctx, st, a, 'oauth_state');               // the address was taken meanwhile
        await ctx.db.asUser(uid, (tx) => S1.audit(ctx, tx, uid, 'signup', { method: p }));
        return signIn(ctx, st, a, state, uid, { link: 'signup', stepup: !!state.pending.proved, first: true });
      }
      if (state.step || bodyKeys.length) fail('oauth_state');

      // ── first call: the linking rules of §4.12 ──
      const subjectBidx = S1.bidx(ctx.config, p + '|' + out.sub);
      const known = await st.identities.bySubject(p, subjectBidx);
      if (a.purpose === 'link') {
        if (known) {
          if (known.userId !== a.bound_user) await endFail(ctx, st, a, 'identity_in_use');
          const brief = await ctx.db.asUser(a.bound_user, (tx) => identityBrief(ctx, tx, st, a.bound_user, known.identityId));
          await end(ctx, st, a);
          return { status: 200, body: { next: 'done', linked: brief } };
        }
        const info = await ctx.db.asUser(a.bound_user, async (tx) => ({ acc: await S1.userEmail(tx, ctx.config, a.bound_user),
          has: (await st.identities.list(tx, a.bound_user)).some((i) => i.provider === p) }));
        if (info.has) await endFail(ctx, st, a, 'provider_linked');
        state.pending = { email: info.acc.email, reason: 'link_confirm' };
        const c = await S1.issueCode(ctx, { email: info.acc.email, purpose: 'link_confirm', bind: { attempt: a.id, user: a.bound_user, sid: a.bound_sid },
          template: 'code_link_confirm', params: { provider: p, providerEmailMasked: out.email ? V.maskEmail(out.email) : '(none)' } });
        return advance(ctx, st, a, oldHash, state, 'code', { emailMasked: V.maskEmail(info.acc.email), reason: 'link_confirm' }, c.expiresAt);
      }
      if (known) {                                                         // rule 1
        const g = await statusGate(ctx, st, a, oldHash, state, known.userId, known.status); if (g) return g;
        return signIn(ctx, st, a, state, known.userId, { identityId: known.identityId, stepup: false });
      }
      const cfg = providerConfig(ctx, p);
      if (O.emailTrusted(cfg, out)) {
        const acc = await S1.userByEmail(ctx, out.email);
        if (acc) {                                                         // rule 4: never linked without the code
          const g = await statusGate(ctx, st, a, oldHash, state, acc.userId, acc.status); if (g) return g;
          state.pending = { email: out.email, reason: 'link_existing' };
          const c = await S1.issueCode(ctx, { email: out.email, purpose: 'oauth_verify', bind: { attempt: a.id }, template: 'code_oauth_verify', params: { provider: p } });
          return advance(ctx, st, a, oldHash, state, 'code', { emailMasked: V.maskEmail(out.email), reason: 'link_existing' }, c.expiresAt);
        }
        // rule 3
        if ((await providerState(ctx, p)) === 'signin') await endFail(ctx, st, a, 'provider_off', { provider: p });
        const why = signupRefusal(ctx, await S1.allowlistHas(ctx, out.email));
        if (why) await endFail(ctx, st, a, why);
        state.pending = { email: out.email, reason: 'signup', proved: false };
        return advance(ctx, st, a, oldHash, state, 'consent', { newAccountEmailMasked: V.maskEmail(out.email), terms: ctx.config.terms, privacy: ctx.config.privacy });
      }
      // rule 5: missing, unverified or unmanaged → ask for an address, then our code
      const reason = !out.email ? 'missing' : (!out.emailVerified ? 'unverified' : 'unmanaged');
      return advance(ctx, st, a, oldHash, state, 'email', { reason, emailPrefill: out.email || null });
    },

    async methods(ctx) {
      const st = needDb(ctx);
      const s = await S1.requireSession(ctx);
      const body = await ctx.db.asUser(s.userId, (tx) => methodsOf(ctx, tx, st, s.userId));
      return { status: 200, body };
    },

    async unlink(ctx) {
      const st = needDb(ctx);
      const s = await S1.requireSession(ctx, { stepup: true });
      const r = await ctx.db.asUser(s.userId, async (tx) => {
        const rows = await st.identities.list(tx, s.userId);
        const i = rows.find((x) => x.id === ctx.body.id);
        if (!i) throw new ApiError('not_found');
        const passkeys = await tx`select count(*)::int as n from wts.passkeys where user_id = ${s.userId}`;
        // the e-mail code is always a method (every account has a verified primary), so this guards a later passkey-only mode
        const remaining = 1 + (rows.length - 1) + passkeys[0].n;
        if (remaining < 1) throw new ApiError('last_method');
        const n = await st.identities.unlink(tx, i.id);
        if (n === null) throw new ApiError('not_found');
        await S1.audit(ctx, tx, s.userId, 'identity_unlink', { provider: i.provider, identity_id: i.id });
        const acc = await S1.userEmail(tx, ctx.config, s.userId);
        return { n, provider: i.provider, email: acc.email, methods: await methodsOf(ctx, tx, st, s.userId) };
      });
      await S1.sendMail(ctx, r.email, 'notice_identity_unlinked', { provider: r.provider });
      return { status: 200, body: { ok: true, methods: r.methods, sessionsRevoked: r.n } };
    },
  };

  async function methodsOf(ctx, tx, st, userId) {
    const acc = await S1.userEmail(tx, ctx.config, userId);
    const ids = await st.identities.list(tx, userId);
    const pk = await tx`select id, name_enc, created_at, last_used_at from wts.passkeys where user_id = ${userId} order by created_at`;
    const m = { email: { masked: V.maskEmail(acc.email) }, identities: ids.map((i) => methodItem(ctx, userId, i)),
      passkeys: pk.map((k) => ({ id: k.id, name: k.name_enc ? (S1.open(ctx.config, k.name_enc, 'passkey-name|' + userId) || '').toString() : '',
        created: S1.iso(k.created_at), lastUsed: k.last_used_at ? S1.iso(k.last_used_at) : null })) };
    if (acc.recovery) m.recovery = { masked: V.maskEmail(acc.recovery) };
    return m;
  }

  return handlers;
}

module.exports = { handlers: createOauthHandlers({}), createOauthHandlers };
